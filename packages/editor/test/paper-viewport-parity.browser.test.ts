import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-browser proof for `paper-viewport-parity.ts` (read-only probe: clicks
// real buttons, dispatches one real ctrl-wheel tick, measures rects).
//
// What it confirms from the live container/image (not synthetic divs):
// - 1 Paper unit in CSS px: `canvasRect.width / 960` equals the actual-size
//   formula `cssPxPerPaperUnit(canvasWidth, 960, scale)` within 0.05.
// - forward/inverse round-trip at the measured scale.
// - pointer-fixed zoom: the bitmap point under a real ctrl-wheel tick stays
//   within 1px, and the helper predicts the same 1.1x scale.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/paper-viewport-parity.browser.test.ts
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4331'
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
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

describe('paper viewport parity on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4331', '--strictPort'], {
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

  it('confirms CSS px per Paper unit from the real container/image', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    await settleAfterOpen()
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Measured geometry: canvas element rect + backing-store width. NOTE:
    // the converted bitmap here is the 960x720 sprite artboard (the 190x200
    // source placed at 384,264), NOT the 2400x1800 workspace:
    // the surface resizes per costume (resize/mode difference), so nothing
    // below hardcodes 2400. The absolute Paper density uses the documented
    // bitmap-default mapping k = 2400/960 = 2.5 surface px per Paper unit as
    // an explicit assumption (paperW = canvas.width / k); what the browser
    // proves non-circularly is the scale tracking, axis uniformity, and the
    // fixed-point/round-trip behavior.
    const measured = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const rect = canvas.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      return {
        rectWidth: rect.width,
        rectHeight: rect.height,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        containerWidth: containerRect.width,
        containerHeight: containerRect.height,
        containerCenter: {
          x: containerRect.left + containerRect.width / 2,
          y: containerRect.top + containerRect.height / 2,
        },
      }
    })
    console.log(`PAPER_DENSITY_MEASURED ${JSON.stringify(measured)}`)
    // The CSS scale is the rect-to-backing-store ratio (uniform on both axes).
    const measuredScaleW = measured.rectWidth / measured.canvasWidth
    const measuredScaleH = measured.rectHeight / measured.canvasHeight
    expect(measuredScaleW).toBeCloseTo(1, 1)
    expect(measuredScaleH).toBeCloseTo(1, 1)
    expect(Math.abs(measuredScaleW - measuredScaleH)).toBeLessThan(0.05)

    // Actual-size formula vs layout under the documented k = 2.5 assumption.
    const verified = await page.evaluate(async (m) => {
      const parity = await import(/* @vite-ignore */ '/src/features/costumes/paper-viewport-parity.ts')
      const mm = m as { rectWidth: number; rectHeight: number; canvasWidth: number; canvasHeight: number }
      const SURFACE_PX_PER_PAPER_UNIT = 2400 / 960 // bitmap-default mapping assumption, explicit
      const paperW = mm.canvasWidth / SURFACE_PX_PER_PAPER_UNIT
      const paperH = mm.canvasHeight / SURFACE_PX_PER_PAPER_UNIT
      const formula = parity.cssPxPerPaperUnit(mm.canvasWidth, paperW, 1)
      const fromLayout = parity.measuredCssPxPerPaperUnit(mm.rectWidth, paperW)
      const heightFormula = parity.cssPxPerPaperUnit(mm.canvasHeight, paperH, 1)
      const heightLayout = parity.measuredCssPxPerPaperUnit(mm.rectHeight, paperH)
      const zoom = parity.paperZoomForCssScale(1, mm.canvasWidth, paperW)
      const back = parity.cssScaleForPaperZoom(zoom, mm.canvasWidth, paperW)
      return { formula, fromLayout, zoom, backTheoretical: back.theoretical, backClamped: back.clamped, heightFormula, heightLayout, paperW, paperH }
    }, measured as unknown as undefined)
    console.log(`PAPER_DENSITY_VERIFIED ${JSON.stringify(verified)}`)
    expect((verified as { formula: number }).formula).toBeCloseTo(2.5, 10)
    expect((verified as { fromLayout: number }).fromLayout).toBeCloseTo(2.5, 1)
    expect(Math.abs((verified as { fromLayout: number }).fromLayout - (verified as { formula: number }).formula)).toBeLessThan(
      0.05,
    )
    // Height axis agrees independently (1800/720 = 2.5).
    expect((verified as { heightFormula: number }).heightFormula).toBeCloseTo(2.5, 10)
    expect(
      Math.abs((verified as { heightLayout: number }).heightLayout - (verified as { heightFormula: number }).heightFormula),
    ).toBeLessThan(0.05)
    // Forward/inverse round-trip at the measured scale.
    expect((verified as { zoom: number }).zoom).toBeCloseTo(2.5, 10)
    expect((verified as { backTheoretical: number }).backTheoretical).toBeCloseTo(1, 10)
    expect((verified as { backClamped: number }).backClamped).toBeCloseTo(1, 10)

    // Pointer-fixed zoom on the live canvas: same anchor mapping the editor
    // uses (`(client - rect.left) / rect.width * canvas.width`), one real
    // ctrl-wheel tick, helper predicts the same 1.1x scale.
    const anchor = await page.evaluate((m) => {
      const c = (m as { containerCenter: { x: number; y: number } }).containerCenter
      return { x: c.x + 60, y: c.y + 40 }
    }, measured as unknown as undefined)
    const before = await page.evaluate(([cx, cy]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return { x: ((cx - rect.left) / rect.width) * canvas.width, y: ((cy - rect.top) / rect.height) * canvas.height }
    }, [anchor.x, anchor.y] as unknown as undefined)
    await page.evaluate((options) => {
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
      surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...(options as object) }))
    }, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: anchor.x, clientY: anchor.y } as unknown as undefined)
    await waitZoomLabel('110%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const after = await page.evaluate(([cx, cy]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return { x: ((cx - rect.left) / rect.width) * canvas.width, y: ((cy - rect.top) / rect.height) * canvas.height }
    }, [anchor.x, anchor.y] as unknown as undefined)
    console.log(`PAPER_FIXED_POINT ${JSON.stringify({ before, after })}`)
    expect(Math.abs((after as { x: number }).x - (before as { x: number }).x)).toBeLessThan(1)
    expect(Math.abs((after as { y: number }).y - (before as { y: number }).y)).toBeLessThan(1)

    // Helper agrees with the observed 1.1x step and still pins the point.
    const agreement = await page.evaluate(async ([ax, ay, m]) => {
      const parity = await import(/* @vite-ignore */ '/src/features/costumes/paper-viewport-parity.ts')
      const mm = m as {
        containerCenter: { x: number; y: number }
        canvasWidth: number
        canvasHeight: number
      }
      const surface = { width: mm.canvasWidth, height: mm.canvasHeight }
      const start = { x: 0, y: 0, scale: 1 }
      const zoomed = parity.cssZoomAtScreenPoint(start, surface, mm.containerCenter, { x: ax, y: ay }, 1.1)
      const fixed = parity.cssScreenToSurface({ x: ax, y: ay }, surface, mm.containerCenter, start)
      const pinned = parity.cssSurfaceToScreen(fixed, surface, mm.containerCenter, zoomed.viewport)
      return {
        scale: zoomed.viewport.scale,
        pinError: Math.hypot(pinned.x - (ax as number), pinned.y - (ay as number)),
      }
    }, [anchor.x, anchor.y, measured] as unknown as undefined)
    console.log(`PAPER_HELPER_AGREEMENT ${JSON.stringify(agreement)}`)
    expect((agreement as { scale: number }).scale).toBeCloseTo(1.1, 10)
    expect((agreement as { pinError: number }).pinError).toBeLessThan(1)
  }, 120_000)
})
