import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'
import { resolvePaperFitZoom } from '../src/features/costumes/paper-viewport-parity'
import {
  BITMAP_RES2_PAPER_TO_CSS_DENSITY,
  VECTOR_PAPER_TO_CSS_DENSITY,
} from '../src/features/costumes/costume-viewport'

// First-visit fit on the real Editor (reference `shouldZoomToFit`/`zoomToFit`
// basis). Covers, with 2 uploaded assets across 2 container sizes:
// - fit center/scale per mode (vector off-center pan + bitmap centered),
// - per-costume+mode state preservation across reselection (no refit),
// - history invariance (fit/pan/reset are viewport-only),
// - reset-after-ops (Paper reset 0.2/0.5, label 100%, centered),
// - pan maintain across target switching,
// - image load order (quick A->B switch never cross-applies a pending fit).
// A compact real-Paper.js oracle (expand(50) + helper agreement) runs first,
// mirroring the existing FIT oracle style without copying reference sources.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/initial-fit-real-editor.browser.test.ts
const root = join(import.meta.dir, '..')
const PORT = 4567
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

// --- minimal opaque PNG builder (solid red 100x100, res2 upload) -------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)))
  return out
}

function buildSolidPng(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0
    for (let x = 0; x < width; x += 1) {
      const o = y * (1 + width * 4) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = 255
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const idat = zlibSync(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const FIT_VECTOR_OFFCENTER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="0" y="0" width="100" height="100" fill="#ff0000"/>` +
  `</svg>`

// --- page helpers ------------------------------------------------------------

async function openCostumes(): Promise<void> {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function costumeCount(): Promise<number> {
  return await page.getByTestId(/costume-card-\d+/).count()
}

async function uploadFile(name: string, mimeType: string, buffer: Buffer): Promise<void> {
  const before = await costumeCount()
  await page.getByTestId('costume-file-input').setInputFiles({ name, mimeType, buffer })
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
    before as unknown as undefined,
    { timeout: 30_000 },
  )
}

async function selectCostumeCard(index: number): Promise<void> {
  // JS click: at narrow browser viewports the card button can be covered by
  // the stage pane for hit-testing; the DOM click still selects the costume.
  await page.evaluate((i: number) => {
    const cards = document.querySelectorAll('[data-testid^="costume-card-"]')
    const card = cards[i] as HTMLElement | undefined
    const button = card?.querySelector('button[aria-label^="Select"]') as HTMLButtonElement | undefined
    button?.click()
  }, index as unknown as undefined)
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
  await new Promise((resolve) => setTimeout(resolve, 300))
}

async function waitForViewportSettled(timeout = 12_000): Promise<void> {
  // The first-fit write lands after async preview/decode + tick; poll the live
  // surface width until it stops moving (settled) instead of a fixed sleep.
  await page.waitForFunction(
    () => {
      const surface =
        (document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null) ??
        (document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement | null)
      if (!surface) return false
      const w = surface.getBoundingClientRect().width
      const key = '__fitSettleProbe'
      const store = window as unknown as Record<string, { last: number; stable: number }>
      const prev = store[key]
      if (!prev || Math.abs(prev.last - w) > 1) {
        store[key] = { last: w, stable: 0 }
        return false
      }
      prev.stable += 1
      return prev.stable >= 3
    },
    null,
    { timeout },
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
}

type FitMeasurement = {
  container: { w: number; h: number; cx: number; cy: number }
  surface: { left: number; top: number; width: number; height: number; cx: number; cy: number }
  label: string
  undoDisabled: boolean | null
  mode: 'vector' | 'bitmap'
}

async function measureFit(): Promise<FitMeasurement> {
  return await page.evaluate(() => {
    const container = document.querySelector('[data-testid="costume-paint-surface"]')!
    const c = container.getBoundingClientRect()
    const vectorSurface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')
    const bitmapCanvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    // Visible surface: vector stage box when in vector mode, else the canvas.
    const surfaceEl = (vectorSurface ?? bitmapCanvas)! as HTMLElement
    const r = surfaceEl.getBoundingClientRect()
    return {
      container: { w: c.width, h: c.height, cx: c.left + c.width / 2, cy: c.top + c.height / 2 },
      surface: { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 },
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      undoDisabled: document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled ?? null,
      mode: vectorSurface ? ('vector' as const) : ('bitmap' as const),
    }
  })
}

function expectedVectorOffcenter(containerW: number, containerH: number): { paperZoom: number; cssScale: number; label: string } {
  // SVG 100x100 at (0,0) -> Paper 200x200 (2x import), no bitmap buffer.
  const paperZoom = resolvePaperFitZoom({ width: 200, height: 200 }, { width: containerW, height: containerH }, false)
  const cssScale = paperZoom / VECTOR_PAPER_TO_CSS_DENSITY
  const label = `${Math.round((cssScale / 0.2) * 100)}%`
  return { paperZoom, cssScale, label }
}

function expectedBitmap100(containerW: number, containerH: number): { paperZoom: number; cssScale: number; label: string } {
  // 100x100 opaque PNG, res2 1:1 -> Paper 100x100 + 50 buffer, padded x1.5.
  const paperZoom = resolvePaperFitZoom({ width: 100, height: 100 }, { width: containerW, height: containerH }, true)
  const cssScale = paperZoom / BITMAP_RES2_PAPER_TO_CSS_DENSITY
  const label = `${Math.round((cssScale / 0.5) * 100)}%`
  return { paperZoom, cssScale, label }
}

describe('initial fit on the real editor + Paper oracle', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('proves Paper expand(50) and helper-vs-oracle agreement in Chromium', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.addScriptTag({ path: join(root, 'node_modules/paper/dist/paper-full.js') })
    const result = await page.evaluate(async () => {
      const fit = await import(/* @vite-ignore */ '/src/features/costumes/costume-viewport.ts')
      const paper = (window as unknown as { paper: any }).paper
      const rect = new paper.Rectangle(10, 20, 100, 80)
      const expanded = rect.expand(50)
      const oracle = (bw: number, bh: number, cw: number, ch: number, isBitmap: boolean): number => {
        if (!(bw > 0) || !(bh > 0) || !(cw > 0) || !(ch > 0)) return 0.5
        if (![bw, bh, cw, ch].every(Number.isFinite)) return 0.5
        const paddedW = (bw + (isBitmap ? 50 : 0)) * 1.5
        const paddedH = (bh + (isBitmap ? 50 : 0)) * 1.5
        const raw = 0.5 * Math.max(paddedW / cw, paddedH / ch)
        if (!Number.isFinite(raw) || raw <= 0) return 0.5
        const ratio = Math.max(0.125, Math.min(1, raw))
        return ratio >= 1 ? 0.5 : 0.5 / ratio
      }
      const cases = [
        { b: { x: 0, y: 0, width: 500, height: 500 }, s: { width: 2400, height: 1800 }, c: { width: 800, height: 600 }, d: 2.5, m: false },
        { b: { x: 430, y: 310, width: 100, height: 100 }, s: { width: 960, height: 720 }, c: { width: 800, height: 600 }, d: 1.0, m: true },
        { b: null, s: { width: 2400, height: 1800 }, c: { width: 800, height: 600 }, d: 2.5, m: false },
      ]
      const rows = cases.map(({ b, s, c, d, m }) => {
        const helper = fit.resolveInitialFitViewport({
          contentBoundsSurface: b,
          surfaceSize: s,
          containerSize: c,
          paperToCssDensity: d,
          isBitmap: m,
        })
        const paperW = b ? b.width / d : 0
        const paperH = b ? b.height / d : 0
        return { helperPaper: helper.paperZoom, expectedPaper: oracle(paperW, paperH, c.width, c.height, m) }
      })
      return { expandW: expanded.width, expandH: expanded.height, rows }
    })
    expect(result.expandW).toBeCloseTo(150, 10)
    expect(result.expandH).toBeCloseTo(130, 10)
    for (const row of result.rows as Array<{ helperPaper: number | null; expectedPaper: number }>) {
      expect(Math.abs((row.helperPaper ?? 0.5) - row.expectedPaper)).toBeLessThan(1e-12)
    }
  }, 120_000)

  it('fits 2 assets across 2 container sizes, preserving state/history/pan/load order', async () => {
    await openCostumes()
    const beforeCount = await costumeCount()

    // Asset A: off-center vector (100x100 at SVG top-left). Fresh key -> fit.
    await uploadFile('fit-vector-off.svg', 'image/svg+xml', Buffer.from(FIT_VECTOR_OFFCENTER_SVG, 'utf8'))
    await selectCostumeCard(beforeCount)
    await waitForViewportSettled()
    const fitA = await measureFit()
    console.log(`INITIAL_FIT_A ${JSON.stringify(fitA)}`)
    expect(fitA.mode).toBe('vector')
    // History invariant: fit writes no history.
    expect(fitA.undoDisabled).toBe(true)
    const expectedA = expectedVectorOffcenter(fitA.container.w, fitA.container.h)
    console.log(`INITIAL_FIT_A_EXPECTED ${JSON.stringify(expectedA)}`)
    expect(expectedA.paperZoom).toBeGreaterThan(0.5)
    // Fit scale: 2400 surface renders 2400*s CSS px.
    expect(Math.abs(fitA.surface.width - 2400 * expectedA.cssScale)).toBeLessThan(2)
    expect(fitA.label).toContain(expectedA.label)
    // Fit center: SVG (0,0,100,100) -> surface (0,0,500,500), center (250,250)
    // must land on the container center (reference centers on bounds.center).
    const trimCenterAx = fitA.surface.left + (250 / 2400) * fitA.surface.width
    const trimCenterAy = fitA.surface.top + (250 / 1800) * fitA.surface.height
    expect(Math.hypot(trimCenterAx - fitA.container.cx, trimCenterAy - fitA.container.cy)).toBeLessThan(2)

    // Pan maintain + per-costume state: pan, switch away, reselect -> pan kept.
    await page.evaluate(() => {
      document.querySelector('[data-testid="costume-paint-surface"]')!.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 60, deltaY: 40, deltaMode: 0 }),
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const pannedA = await measureFit()
    expect(Math.hypot(pannedA.surface.cx - fitA.surface.cx, pannedA.surface.cy - fitA.surface.cy)).toBeGreaterThan(5)
    expect(pannedA.undoDisabled).toBe(true)
    await selectCostumeCard(0)
    await waitForViewportSettled()
    await selectCostumeCard(beforeCount)
    await waitForViewportSettled()
    const reselectedA = await measureFit()
    console.log(`INITIAL_FIT_A_RESELECT ${JSON.stringify(reselectedA)}`)
    expect(Math.hypot(reselectedA.surface.cx - pannedA.surface.cx, reselectedA.surface.cy - pannedA.surface.cy)).toBeLessThan(2)
    expect(Math.hypot(reselectedA.surface.width - pannedA.surface.width, 0)).toBeLessThan(1)

    // Reset-after-ops: zoom in, reset -> Paper reset 0.2 centered at 100%.
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('100%') ?? false,
      null,
      { timeout: 10_000 },
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const resetA = await measureFit()
    expect(resetA.label).toContain('100%')
    expect(Math.abs(resetA.surface.width - 480)).toBeLessThan(1.5)
    expect(Math.hypot(resetA.surface.cx - resetA.container.cx, resetA.surface.cy - resetA.container.cy)).toBeLessThan(1)
    expect(resetA.undoDisabled).toBe(true)

    // Second container size + second asset (bitmap 100x100 centered, res2).
    // NOTE: 800x600 collapses the costume list over the paint surface in the
    // current responsive layout (pre-existing, unrelated to fit), so the
    // second size stays desktop-like (1024x700) to keep cards clickable while
    // still giving clearly different container dims.
    await page.setViewportSize({ width: 1024, height: 700 })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const pngBytes = buildSolidPng(100, 100, 255, 0, 0)
    await uploadFile('fit-bitmap-100.png', 'image/png', Buffer.from(pngBytes))
    const afterVectorCount = await costumeCount()
    await selectCostumeCard(afterVectorCount - 1)
    await waitForViewportSettled()
    const fitB = await measureFit()
    console.log(`INITIAL_FIT_B ${JSON.stringify(fitB)}`)
    expect(fitB.mode).toBe('bitmap')
    expect(fitB.undoDisabled).toBe(true)
    const expectedB = expectedBitmap100(fitB.container.w, fitB.container.h)
    console.log(`INITIAL_FIT_B_EXPECTED ${JSON.stringify(expectedB)}`)
    expect(expectedB.paperZoom).toBeGreaterThan(0.5)
    // 960 canvas renders 960*s CSS px; trim is centered so surface stays centered.
    expect(Math.abs(fitB.surface.width - 960 * expectedB.cssScale)).toBeLessThan(2)
    expect(fitB.label).toContain(expectedB.label)
    expect(Math.hypot(fitB.surface.cx - fitB.container.cx, fitB.surface.cy - fitB.container.cy)).toBeLessThan(2)

    // Image load order: quick A->default switch never cross-applies a pending
    // fit. A holds a user reset state (saved); B holds its fit. A quick
    // round-trip must keep each side's own viewport. NOTE: resetA was measured
    // at the large container; orderA lives at the small one, so the check is
    // container-relative (reset = 0.2 centered at 100%), not absolute.
    await selectCostumeCard(beforeCount)
    await new Promise((resolve) => setTimeout(resolve, 120))
    await selectCostumeCard(0)
    await waitForViewportSettled()
    await selectCostumeCard(beforeCount)
    await waitForViewportSettled()
    const orderA = await measureFit()
    expect(orderA.mode).toBe('vector')
    expect(orderA.label).toContain('100%')
    expect(Math.abs(orderA.surface.width - 480)).toBeLessThan(1.5)
    expect(Math.hypot(orderA.surface.cx - orderA.container.cx, orderA.surface.cy - orderA.container.cy)).toBeLessThan(1)
    expect(orderA.undoDisabled).toBe(true)
    await selectCostumeCard(afterVectorCount - 1)
    await waitForViewportSettled()
    const orderB = await measureFit()
    const expectedOrderB = expectedBitmap100(orderB.container.w, orderB.container.h)
    expect(orderB.mode).toBe('bitmap')
    expect(orderB.label).toContain(expectedOrderB.label)
    expect(Math.abs(orderB.surface.width - 960 * expectedOrderB.cssScale)).toBeLessThan(2)
    expect(Math.hypot(orderB.surface.cx - orderB.container.cx, orderB.surface.cy - orderB.container.cy)).toBeLessThan(2)
    // Same small container as fitB, so the fit must reproduce exactly.
    expect(Math.hypot(orderB.surface.cx - fitB.surface.cx, orderB.surface.cy - fitB.surface.cy)).toBeLessThan(2)
    expect(Math.abs(orderB.surface.width - fitB.surface.width)).toBeLessThan(1)
    expect(orderB.undoDisabled).toBe(true)

    await page.setViewportSize({ width: 1280, height: 800 })
  }, 240_000)
})
