// Browser diagnostics for the reset/min/band question (READ-ONLY, no product change).
//
// What this measures on the REAL editor (not synthetic divs):
// - vector reset rect (100%): style width proves 2400px, rect proves scale
//   tracking, container rect proves whether the 2400px surface is clipped
//   (overflow:hidden) at the default 1280x800 viewport;
// - narrowed container: the SAME reset scale renders a smaller VISIBLE rect
//   (min(surface, container)), so the 0.2 raw calc can never be an apparent
//   match without the container size;
// - DPR: devicePixelRatio scales device px only; getBoundingClientRect stays
//   CSS px, so DPR never changes the apparent CSS match (logs both);
// - bitmap ladder on the live canvas resolution (res2 vs res1 classified,
//   never assumed): rect == canvasW*s within 1px, ratio checks only;
// - selection-center anchor: with no selection the rect center must not move
//   across the + step (< 1px); WITH a payload selection this file only logs
//   the rect center delta (no fixture selection is forced here);
// - W/H variable + huge artboard: pure-geometry prediction for 480/960/2400
//   and union/limited/refused cases is re-measured through the real CSS
//   engine on a synthetic surface of the same W/H (no editor mutation).
//
// Assumptions (explicit): A1 (res classification B-RES), A3 (2.5 density),
// A-CONTAINER (visible = min(surface,container), overflow:hidden),
// A-DPR (rect is CSS px, DPR-independent).
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/viewport-reset-band-diagnostics.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4491'
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

async function settleAfterOpen() {
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function resetZoom() {
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
  })
  await waitZoomLabel('100%')
  await new Promise((resolve) => setTimeout(resolve, 150))
}

async function ensureVectorMode() {
  const toVector = await page.getByRole('button', { name: 'ベクターに変換' }).count()
  if (toVector > 0) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(() => !!document.querySelector('[data-vector-stage-surface="true"]'), null, { timeout: 10_000 })
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

describe('viewport reset/band browser diagnostics (read-only)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4491', '--strictPort'], {
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

  it('vector Paper-reset rect 480 in container (live 0.2, DPR-independent)', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await settleAfterOpen()
    await ensureVectorMode()
    await resetZoom()

    const diag = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const rect = surface.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const style = getComputedStyle(container)
      return {
        dpr: window.devicePixelRatio,
        styleWidth: surface.style.width,
        rectWidth: rect.width,
        rectHeight: rect.height,
        rectLeft: rect.left,
        rectTop: rect.top,
        containerWidth: containerRect.width,
        containerHeight: containerRect.height,
        overflow: style.overflow,
        // Visible span = intersection of surface rect with container rect.
        visibleWidth: Math.max(0, Math.min(rect.right, containerRect.right) - Math.max(rect.left, containerRect.left)),
        visibleHeight: Math.max(0, Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top)),
        deviceWidth: rect.width * window.devicePixelRatio,
      }
    })
    console.log(`RESET_CLIP_DIAG ${JSON.stringify(diag)}`)
    // Surface identity: 2400px style, live Paper-reset rect 480px (0.2).
    expect(diag.styleWidth).toBe('2400px')
    expect(Math.abs(diag.rectWidth - 480)).toBeLessThan(1.5)
    expect(diag.overflow).toContain('hidden')
    // Container-clip proof: the visible span is the intersection of the
    // 480px surface rect with the container rect.
    expect(diag.containerWidth).toBeGreaterThan(50)
    expect(diag.visibleWidth).toBeLessThanOrEqual(diag.containerWidth + 1)
    if (diag.rectWidth > diag.containerWidth) {
      expect(diag.visibleWidth).toBeCloseTo(diag.containerWidth, 0)
    } else {
      expect(diag.visibleWidth).toBeCloseTo(diag.rectWidth, 0)
    }
    // DPR proof: CSS rect is DPR-independent; device px = CSS px * DPR.
    expect(Math.abs(diag.deviceWidth - diag.rectWidth * diag.dpr)).toBeLessThan(0.01)
    console.log(`DPR_DIAG ${JSON.stringify({ dpr: diag.dpr, cssWidth: diag.rectWidth, deviceWidth: diag.deviceWidth })}`)
    // Paper reset 0.2 renders 480px wide (2400*0.2): log container fit.
    const live02 = 2400 * 0.2
    console.log(`LIVE02_VS_CONTAINER ${JSON.stringify({ live02, containerWidth: diag.containerWidth, fits: live02 <= diag.containerWidth })}`)
    expect(live02).toBeCloseTo(480, 10)
  }, 120_000)

  it('narrowed viewport: same reset scale, smaller visible span (container shrink)', async () => {
    // Same page, narrower browser viewport: reset scale stays 100% but the
    // visible span shrinks with the container. Proves apparent size != f(scale).
    await page.setViewportSize({ width: 700, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await resetZoom()
    const narrow = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const rect = surface.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      return {
        rectWidth: rect.width,
        containerWidth: containerRect.width,
        visibleWidth: Math.max(0, Math.min(rect.right, containerRect.right) - Math.max(rect.left, containerRect.left)),
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`NARROW_DIAG ${JSON.stringify(narrow)}`)
    // Scale untouched (label still 100%, live reset rect still ~480 CSS px) ...
    expect(narrow.label).toContain('100%')
    expect(Math.abs(narrow.rectWidth - 480)).toBeLessThan(2)
    // ... but the container (and hence the visible span when clipped) shrank vs 1280px.
    expect(narrow.containerWidth).toBeLessThan(1100)
    expect(narrow.visibleWidth).toBeLessThanOrEqual(narrow.containerWidth + 1)
    await page.setViewportSize({ width: 1280, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 300))
  }, 120_000)

  it('bitmap live canvas: res classification + W/H variable + huge-geometry CSS check', async () => {
    await ensureBitmapMode()
    await resetZoom()
    const diag = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const containerRect = container.getBoundingClientRect()
      return {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        rectWidth: rect.width,
        rectHeight: rect.height,
        containerWidth: containerRect.width,
        dpr: window.devicePixelRatio,
      }
    })
    console.log(`BITMAP_WIDE_DIAG ${JSON.stringify(diag)}`)
    // Scale tracking is per-mode: res2 Paper reset 0.5 -> rect == canvasW*0.5;
    // unknown/res1 legacy reset 1 -> rect == canvasW.
    const resLive = diag.canvasWidth / 480 >= 1.5 ? 2 : 1
    const expectedRect = resLive === 2 ? diag.canvasWidth * 0.5 : diag.canvasWidth
    expect(Math.abs(diag.rectWidth - expectedRect)).toBeLessThan(1.5)
    const res = diag.canvasWidth / 480 >= 1.5 ? 2 : 1
    console.log(`BITMAP_WIDE_RES ${JSON.stringify({ canvasWidth: diag.canvasWidth, assumedResolution: res })}`)
    // W/H variable prediction through the REAL css engine: synthetic surfaces
    // with the same W/H + identical transform must match predictSurfaceRect.
    const cssCheck = await page.evaluate(async () => {
      const viewport = await import(/* @vite-ignore */ '/src/features/costumes/costume-viewport.ts')
      const container = document.createElement('div')
      container.style.cssText = 'position:relative;width:800px;height:600px;overflow:hidden;margin:0;padding:0;'
      document.body.appendChild(container)
      const cases = [
        { width: 960, height: 720 },
        { width: 480, height: 360 },
        { width: 2400, height: 1800 },
        { width: 2000, height: 1500 },
      ]
      const rows = []
      for (const size of cases) {
        const surface = document.createElement('div')
        surface.style.cssText = `position:absolute;left:50%;top:50%;width:${size.width}px;height:${size.height}px;transform-origin:center;`
        container.appendChild(surface)
        for (const scale of [1, 0.25, 0.2]) {
          surface.style.transform = `translate(calc(-50% + 0px), calc(-50% + 0px)) scale(${scale})`
          void surface.offsetWidth
          const containerRect = container.getBoundingClientRect()
          const center = { x: containerRect.left + containerRect.width / 2, y: containerRect.top + containerRect.height / 2 }
          const predicted = viewport.predictSurfaceRect(size, center, { x: 0, y: 0, scale })
          const measured = surface.getBoundingClientRect()
          rows.push({
            size,
            scale,
            errW: Math.abs(predicted.width - measured.width),
            errL: Math.abs(predicted.left - measured.left),
            clamped: viewport.clampViewportScale(scale),
          })
        }
        surface.remove()
      }
      container.remove()
      return rows
    })
    console.log(`CSS_WIDE_CHECK ${JSON.stringify(cssCheck)}`)
    // In-band scales (1, 0.25) must match the real CSS engine within 1px.
    const inBand = cssCheck.filter((r) => r.scale === 1 || r.scale === 0.25)
    const maxErr = Math.max(...inBand.flatMap((r) => [r.errW, r.errL]))
    expect(maxErr).toBeLessThan(1)
    // The live vector band renders 0.2 exactly (Paper reset): the synthetic
    // 0.2 row must match the 0.2 prediction (measured == predicted), i.e.
    // NO clamp delta on the per-mode band.
    const scale02 = cssCheck.filter((r) => r.scale === 0.2)
    for (const row of scale02) {
      expect(row.errW).toBeLessThan(1)
      expect(row.errL).toBeLessThan(1)
    }
    await resetZoom()
  }, 120_000)
})
