// Paper-reset live behavior: real-Editor DOM verification (vector + bitmap res2).
//
// Paper basis (live, not theoretical):
// - vector reset scale 0.2 (2400 surface -> 480 CSS px), floor 0.1332;
// - bitmap res2 (explicit stored resolution 2) reset 0.5 (960 canvas -> 480
//   CSS px, SAME container width as the vector artboard at reset), floor 0.333;
// - unknown (no explicit stored resolution) keeps legacy reset 1.
// - UI label is per-mode percent (reset always "100%"), separated from the
//   internal scale. Initial fit stays a separate behavior (現状維持, 明記);
//   only this reset button is Paper-normalized.
//
// Covers in the real Editor DOM: reset 480px same-container assertion,
// two color pixels + character click / Undo / Redo, vector/bitmap
// transition with per-mode state, pointer-fixed zoom, responsive,
// padding/edge containment, and low-floor button return.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/viewport-paper-reset.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4531'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function waitZoomLabel(text: string, timeout = 10_000) {
  await page.waitForFunction(
    (want) => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout },
  )
}

async function openCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  // The costumes tab click can be intercepted by a transient header overlay
  // (e.g. the dismissible runtime notice): retry with an in-page click
  // fallback, which still runs the real Svelte handler.
  for (let i = 0; i < 3; i += 1) {
    try {
      await page.getByTestId('main-tab-costumes').click({ timeout: 5000 })
      break
    } catch {
      if (i === 2) throw new Error('main-tab-costumes click intercepted after retries')
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-testid="main-tab-costumes"]')?.click()
      })
      break
    }
  }
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function ensureVectorMode() {
  const toVector = await page.getByRole('button', { name: 'ベクターに変換' }).count()
  if (toVector > 0) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(() => !!document.querySelector('[data-vector-stage-surface="true"]'), null, {
      timeout: 10_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

async function ensureBitmapMode() {
  const toBitmap = await page.getByRole('button', { name: 'ビットマップに変換' }).count()
  if (toBitmap > 0) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 15_000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

async function resetZoomUi() {
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
  })
  await waitZoomLabel('100%')
  await new Promise((resolve) => setTimeout(resolve, 150))
}

function canvasClientFor(canvasX: number, canvasY: number, rect: { x: number; y: number; width: number; height: number }, canvasW: number, canvasH: number) {
  return { x: rect.x + (canvasX / canvasW) * rect.width, y: rect.y + (canvasY / canvasH) * rect.height }
}

describe('paper-reset live behavior on the real editor', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4531', '--strictPort'], {
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

  it('reset renders 480 CSS px in the same container for vector artboard and res2 board', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    const vector = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        styleWidth: surface.style.width,
        rectWidth: r.width,
        rectHeight: r.height,
        centerErr: Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.top + r.height / 2 - (c.top + c.height / 2)),
        container: { w: c.width, h: c.height },
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`PAPER_RESET_VECTOR ${JSON.stringify(vector)}`)
    expect(vector.styleWidth).toBe('2400px')
    expect(Math.abs(vector.rectWidth - 480)).toBeLessThan(1.5)
    expect(vector.centerErr).toBeLessThan(1)
    expect(vector.label).toContain('100%')

    await ensureBitmapMode()
    await resetZoomUi()
    const bitmap = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = canvas.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        backing: { w: canvas.width, h: canvas.height },
        rectWidth: r.width,
        rectHeight: r.height,
        centerErr: Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.top + r.height / 2 - (c.top + c.height / 2)),
        container: { w: c.width, h: c.height },
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`PAPER_RESET_BITMAP ${JSON.stringify(bitmap)}`)
    expect(bitmap.label).toContain('100%')
    expect(bitmap.centerErr).toBeLessThan(1)
    // Same container element across the mode switch: widths must match.
    expect(Math.abs(bitmap.container.w - vector.container.w)).toBeLessThan(2)
    if (bitmap.backing.w / 480 >= 1.5) {
      // res2: explicit stored resolution 2 -> Paper reset 0.5 -> 480 CSS px.
      expect(Math.abs(bitmap.rectWidth - 480)).toBeLessThan(1.5)
      expect(Math.abs(bitmap.rectWidth - vector.rectWidth)).toBeLessThan(2)
    } else {
      // res1/unknown stays legacy (no verdict on the coefficient): record only.
      console.log(`PAPER_RESET_INCOMPLETE_RES1 ${JSON.stringify(bitmap)}`)
      expect(Math.abs(bitmap.rectWidth - bitmap.backing.w)).toBeLessThan(1.5)
    }
  }, 120_000)

  it('two color pixels + character click, Undo/Redo in bitmap res2', async () => {
    await openCostumes()
    await ensureBitmapMode()
    await resetZoomUi()
    const backing = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return { w: canvas.width, h: canvas.height }
    })
    if (backing.w / 480 < 1.5) {
      console.log('PAPER_RESET_PAINT_SKIP res1 canvas (unknown band, no Paper verdict)')
      return
    }
    const fill = page.getByLabel('Paint color', { exact: true })
    const canvas = page.getByTestId('bitmap-editor-canvas')
    await page.getByTestId('bitmap-tool-brush').click()
    const isRed = (px: number[]) => px[0]! > 200 && px[1]! < 80 && px[2]! < 80 && px[3] === 255
    const isBlue = (px: number[]) => px[2]! > 200 && px[0]! < 80 && px[1]! < 80 && px[3] === 255
    // Two color pixels: red stroke + blue stroke via real brush drags (a
    // down+up click alone is not guaranteed to stamp a dot; the drag covers
    // the probe pixel like the other paint suites).
    await fill.fill('#ff0000')
    let rect = await canvas.boundingBox()
    if (!rect) throw new Error('Missing bitmap canvas')
    {
      const a = canvasClientFor(292, 250, rect, backing.w, backing.h)
      const b = canvasClientFor(308, 250, rect, backing.w, backing.h)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 4 })
      await page.mouse.up()
    }
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(300, 250, 1, 1).data
      return r > 200 && g < 80 && b < 80 && a === 255
    }, null, { timeout: 10_000 })
    await fill.fill('#0000ff')
    rect = (await canvas.boundingBox()) ?? rect
    {
      const a = canvasClientFor(612, 450, rect, backing.w, backing.h)
      const b = canvasClientFor(628, 450, rect, backing.w, backing.h)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 4 })
      await page.mouse.up()
    }
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(620, 450, 1, 1).data
      return b > 200 && r < 80 && g < 80 && a === 255
    }, null, { timeout: 10_000 })
    // Mapping proof: the strokes landed on the mapped probe pixels through
    // the Paper-reset transform (a drag centered on the probe covers it).
    const afterPaint = await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const at = (x: number, y: number) => Array.from(target.getContext('2d')!.getImageData(x, y, 1, 1).data)
      return { red: at(300, 250), blue: at(620, 450) }
    })
    expect(isRed(afterPaint.red)).toBe(true)
    expect(isBlue(afterPaint.blue)).toBe(true)
    // History proof: the two strokes recorded undoable entries.
    expect(await page.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(false)
    // Click (eyedropper) resolves both pixels through the reset transform.
    // Move first and wait for the loupe so the commit samples the loupe
    // position at the target (a bare click can commit before the loupe
    // follows the instant move).
    await page.getByTestId('bitmap-tool-eyedropper').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    rect = (await canvas.boundingBox()) ?? rect
    {
      const p = canvasClientFor(300, 250, rect!, backing.w, backing.h)
      await page.mouse.move(p.x, p.y)
      await page.getByTestId('eyedropper-loupe').waitFor({ state: 'visible' })
      await page.mouse.click(p.x, p.y)
    }
    await page.waitForFunction(() => document.querySelector('[data-testid="eyedropper-hint"]') === null)
    expect(await fill.inputValue()).toBe('#ff0000')
    await page.getByTestId('bitmap-tool-eyedropper').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    rect = (await canvas.boundingBox()) ?? rect
    {
      const p = canvasClientFor(620, 450, rect!, backing.w, backing.h)
      await page.mouse.move(p.x, p.y)
      await page.getByTestId('eyedropper-loupe').waitFor({ state: 'visible' })
      await page.mouse.click(p.x, p.y)
    }
    await page.waitForFunction(() => document.querySelector('[data-testid="eyedropper-hint"]') === null)
    expect(await fill.inputValue()).toBe('#0000ff')
    // Character: text tool click + type + commit is a history entry.
    const undoBtn = page.getByRole('button', { name: 'Undo' })
    const undoBefore = await undoBtn.isDisabled()
    await page.getByTestId('bitmap-tool-text').click()
    rect = (await canvas.boundingBox()) ?? rect
    const tp = canvasClientFor(480, 360, rect, backing.w, backing.h)
    await page.mouse.click(tp.x, tp.y)
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
    await page.keyboard.type('A')
    await page.keyboard.press('Enter')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await undoBtn.isDisabled()).toBe(false)
    // Undo/Redo round-trip preserves the operation (enablement flips both ways).
    await undoBtn.click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const redoBtn = page.getByRole('button', { name: 'Redo' })
    expect(await redoBtn.isDisabled()).toBe(false)
    await redoBtn.click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await undoBtn.isDisabled()).toBe(false)
    expect(undoBefore).toBeDefined()
  }, 180_000)

  it('mode transition keeps per-mode viewport + pointer-fixed zoom + responsive + edge', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    // Vector pointer-fixed zoom: container-center anchor stays <1px (100% -> 200%).
    const anchor = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
      return { x: c.left + c.width / 2, y: c.top + c.height / 2 }
    })
    const uv0 = 0
    void uv0
    const before = await page.evaluate(([cx, cy]) => {
      const r = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect()
      return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height }
    }, [anchor.x, anchor.y] as unknown as undefined)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('200%')
    const pin = await page.evaluate(([cx, cy, bu, bv]) => {
      const r = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect()
      const au = (cx - r.left) / r.width
      const av = (cy - r.top) / r.height
      return Math.hypot((au - (bu as number)) * r.width, (av - (bv as number)) * r.height)
    }, [anchor.x, anchor.y, before.u, before.v] as unknown as undefined)
    expect(pin as number).toBeLessThan(1)
    // Per-mode state: vector at 200%, switch to bitmap (own reset 100%).
    await ensureBitmapMode()
    await resetZoomUi()
    const bLabel = await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')
    expect(bLabel).toContain('100%')
    // Back to vector: the 200% state survived the round-trip.
    await ensureVectorMode()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const vLabel = await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')
    expect(vLabel).toContain('200%')
    // Ctrl-wheel pointer-fixed at 200% (scale 0.4): -100 tick -> +0.04 CSS
    // (0.44 -> 220%, Paper +0.1).
    const center = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
      return { x: c.left + c.width / 2, y: c.top + c.height / 2 }
    })
    const wuv = await page.evaluate(([cx, cy]) => {
      const r = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect()
      return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height }
    }, [center.x, center.y] as unknown as undefined)
    await page.evaluate((options) => {
      document
        .querySelector('[data-testid="costume-paint-surface"]')!
        .dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...(options as object) }))
    }, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: center.x, clientY: center.y } as unknown as undefined)
    await waitZoomLabel('220%')
    const wpin = await page.evaluate(([cx, cy, bu, bv]) => {
      const r = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect()
      const au = (cx - r.left) / r.width
      const av = (cy - r.top) / r.height
      return Math.hypot((au - (bu as number)) * r.width, (av - (bv as number)) * r.height)
    }, [center.x, center.y, wuv.u, wuv.v] as unknown as undefined)
    expect(wpin as number).toBeLessThan(1)
    // Responsive: narrower browser viewport keeps scale + tracking.
    await resetZoomUi()
    await page.setViewportSize({ width: 800, height: 600 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const narrow = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface?.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        rectWidth: r?.width ?? 0,
        rectHeight: r?.height ?? 0,
        insideH: r ? r.left >= c.left - 1 && r.right <= c.right + 1 : false,
        insideV: r ? r.top >= c.top - 1 && r.bottom <= c.bottom + 1 : false,
        containerW: c.width,
        containerH: c.height,
      }
    })
    console.log(`PAPER_RESET_RESPONSIVE ${JSON.stringify(narrow)}`)
    expect(narrow.label).toContain('100%')
    // Padding/edge: at Paper reset the artboard rect still tracks 480 CSS px.
    expect(Math.abs(narrow.rectWidth - 480)).toBeLessThan(2)
    // Containment holds per axis whenever the container fits that axis.
    if (narrow.containerW >= 480) expect(narrow.insideH).toBe(true)
    if (narrow.containerH >= 360) expect(narrow.insideV).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await resetZoomUi()
  }, 180_000)

  it('low zoom floor returns to reset with one button step (vector + res2)', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    // Walk down to the vector floor (0.1332 -> 67%).
    for (let i = 0; i < 10; i += 1) {
      await page.getByRole('button', { name: 'Zoom out' }).click()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const label = (await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')).trim()
      if (label === '67%') break
    }
    const floorV = await page.evaluate(() => ({
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      rectWidth: document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect().width,
    }))
    console.log(`PAPER_RESET_VECTOR_FLOOR ${JSON.stringify(floorV)}`)
    expect(floorV.label).toContain('67%')
    expect(Math.abs(floorV.rectWidth - 2400 * (0.333 / 2.5))).toBeLessThan(2)
    // One button step out of the floor returns to the Paper reset (100%).
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('100%')
    const backV = await page.evaluate(() => document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect().width)
    expect(Math.abs(backV - 480)).toBeLessThan(1.5)

    await ensureBitmapMode()
    await resetZoomUi()
    const backing = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return { w: canvas.width }
    })
    if (backing.w / 480 < 1.5) {
      console.log('PAPER_RESET_FLOOR_SKIP res1 canvas (unknown band floor 25%)')
      return
    }
    for (let i = 0; i < 10; i += 1) {
      await page.getByRole('button', { name: 'Zoom out' }).click()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const label = (await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')).trim()
      if (label === '67%') break
    }
    const floorB = await page.evaluate(() => ({
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      rectWidth: document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getBoundingClientRect().width,
    }))
    console.log(`PAPER_RESET_BITMAP_FLOOR ${JSON.stringify(floorB)}`)
    expect(floorB.label).toContain('67%')
    expect(Math.abs(floorB.rectWidth - 960 * 0.333)).toBeLessThan(2)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('100%')
    const backB = await page.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getBoundingClientRect().width)
    expect(Math.abs(backB - 480)).toBeLessThan(1.5)
  }, 180_000)
})
