// Live-camera proof for the zoom unit-scale question (Paper basis).
//
// What this measures (clicks real buttons, dispatches real ctrl-wheel ticks,
// reads rects):
// - vector mode (default costume): live Paper reset 0.2 ("100%", 2400 surface
//   -> 480 CSS px). Button +0.2 CSS (+0.5 Paper): 100% -> 200% (rect 2x),
//   200% -> 300%; ctrl-wheel -100 (+0.1 Paper -> +0.04 CSS): 100% -> 120%
//   (rect 1.2x); -25 tick (+0.025 Paper -> +0.01 CSS): 100% -> 105%.
//   Floor ladder (per-mode band 0.1332..5): 300% -> 200% -> 100% -> 67%
//   (floor 0.333/2.5), then the 67% -> 100% floor-exit (Paper reset).
//   Screen-px-per-480-scratch-units (measured) vs the formula 2400*s
//   (expected): self-consistency within 1px; pointer-fixed pin within 1px.
// - bitmap mode (after converting to bitmap): the same ladder on the live
//   canvas rect (formula canvasW*s) with the EXPLICIT stored resolution:
//   res2 Paper reset 0.5 ("100%", 960 canvas -> 480 CSS px), button +0.5 CSS
//   (100% -> 200%), wheel -100 (+0.1 CSS, 100% -> 120%), floor 0.333 (67%)
//   with floor-exit to reset; res1/unknown keeps the legacy ladder
//   (reset 1, +0.5 -> 150%, wheel +0.1 -> 110%, floor 0.25).
// - artwork-center anchor: with no selection both modes anchor the surface
//   center, so the rect center must not move across the + step (< 1px).
//
// What this does NOT assert: Scratch-equivalence of the rendered sizes.
// The Scratch side has no live instance here; its expected values come from
// the vendored source (see zoom-unit-scale-parity.test.ts), and the failing
// KNOWN GAP verdicts live there. This file logs PARITY_GAP rows
// (measured vs Scratch-source equivalents) for the record and stays green
// iff the live camera matches the current formulas.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/zoom-unit-scale-parity.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4419'
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

async function zoomInOnce() {
  await page.getByRole('button', { name: 'Zoom in' }).click()
}

async function zoomOutOnce() {
  await page.getByRole('button', { name: 'Zoom out' }).click()
}

type Rect = { x: number; y: number; width: number; height: number }

async function containerRect(): Promise<Rect> {
  return (await page.evaluate(() => {
    const el = document.querySelector('[data-testid="costume-paint-surface"]')!
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })) as Rect
}

async function ensureVectorMode() {
  const toVector = await page.getByRole('button', { name: 'ベクターに変換' }).count()
  if (toVector > 0) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(
      () => !!document.querySelector('[data-vector-stage-surface="true"]'),
      null,
      { timeout: 10_000 },
    )
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

describe('zoom unit-scale parity on the real editor camera', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4419', '--strictPort'], {
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

  it('measures the vector camera ladder and the artwork-center anchor', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await settleAfterOpen()
    await ensureVectorMode()
    await resetZoom()

    // Live surface geometry: style width proves the 2400px surface (not
    // assumed), live Paper-reset rect proves the 0.2 scale (480 CSS px).
    const at100 = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const rect = surface.getBoundingClientRect()
      const art = document.querySelector('.vector-preview') as HTMLElement | null
      const artRect = art?.getBoundingClientRect()
      return {
        styleWidth: surface.style.width,
        rectWidth: rect.width,
        rectHeight: rect.height,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        artWidth: artRect?.width ?? null,
      }
    })
    console.log(`VECTOR_CAM_100 ${JSON.stringify(at100)}`)
    expect(at100.styleWidth).toBe('2400px')
    // Expected (live Paper reset 2400*0.2 = 480) vs measured: within 1px.
    expect(Math.abs(at100.rectWidth - 480)).toBeLessThan(1.5)
    // The default 480-unit art box fills the 2400 surface; when rendered,
    // the art rect agrees with the surface rect within the 2px rounding/border.
    if (at100.artWidth !== null) expect(Math.abs(at100.artWidth - at100.rectWidth)).toBeLessThan(2)

    // Vector Paper-parity step (density 2400/960 = 2.5): reset 0.2 -> 0.4
    // (+0.5 Paper units, "200%"), rect 2x, and the artwork-center anchor
    // holds (< 1px) with no selection.
    await zoomInOnce()
    await waitZoomLabel('200%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const at200 = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const rect = surface.getBoundingClientRect()
      return { rectWidth: rect.width, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 }
    })
    console.log(`VECTOR_CAM_200 ${JSON.stringify(at200)}`)
    expect(at200.rectWidth / at100.rectWidth).toBeCloseTo(2, 2)
    expect(Math.abs(at200.rectWidth - 960)).toBeLessThan(1.5)
    expect(Math.abs(at200.centerX - at100.centerX)).toBeLessThan(1)
    expect(Math.abs(at200.centerY - at100.centerY)).toBeLessThan(1)

    // ctrl-wheel -100 tick at the container center: +0.1 Paper units ->
    // +0.04 CSS (0.2 -> 0.24, "120%"), 1.2x rect, pointer-fixed pin holds.
    await resetZoom()
    const before = await containerRect()
    const anchor = { x: before.x + before.width / 2, y: before.y + before.height / 2 }
    const anchorUvBefore = await page.evaluate(([cx, cy]) => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const rect = surface.getBoundingClientRect()
      return { u: (cx - rect.left) / rect.width, v: (cy - rect.top) / rect.height }
    }, [anchor.x, anchor.y] as unknown as undefined)
    await page.evaluate((options) => {
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
      surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...(options as object) }))
    }, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: anchor.x, clientY: anchor.y } as unknown as undefined)
    await waitZoomLabel('120%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const at120 = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const rect = surface.getBoundingClientRect()
      return { rectWidth: rect.width }
    })
    console.log(`VECTOR_CAM_120 ${JSON.stringify(at120)}`)
    expect(at120.rectWidth / at100.rectWidth).toBeCloseTo(1.2, 2)
    expect(Math.abs(at120.rectWidth - 576)).toBeLessThan(1.5)
    const wheelPinError = await page.evaluate(([cx, cy, bu, bv]) => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const rect = surface.getBoundingClientRect()
      const au = (cx - rect.left) / rect.width
      const av = (cy - rect.top) / rect.height
      return Math.hypot((au - (bu as number)) * rect.width, (av - (bv as number)) * rect.height)
    }, [anchor.x, anchor.y, anchorUvBefore.u, anchorUvBefore.v] as unknown as undefined)
    expect(wheelPinError as number).toBeLessThan(1)

    // Small wheel delta: -25 tick -> +0.025 Paper -> +0.01 CSS
    // (0.2 -> 0.21, "105%"), proving the delta magnitude is honored (not a
    // sign-only jump) and the pointer stays pinned.
    await resetZoom()
    const smallAnchor = { x: before.x + before.width / 2 + 40, y: before.y + before.height / 2 + 30 }
    const smallBefore = await page.evaluate(([cx, cy]) => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const rect = surface.getBoundingClientRect()
      return { u: (cx - rect.left) / rect.width, v: (cy - rect.top) / rect.height }
    }, [smallAnchor.x, smallAnchor.y] as unknown as undefined)
    await page.evaluate((options) => {
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
      surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...(options as object) }))
    }, { deltaX: 0, deltaY: -25, deltaMode: 0, ctrlKey: true, clientX: smallAnchor.x, clientY: smallAnchor.y } as unknown as undefined)
    await waitZoomLabel('105%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const at105 = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      return { rectWidth: surface.getBoundingClientRect().width }
    })
    console.log(`VECTOR_CAM_105 ${JSON.stringify(at105)}`)
    expect(at105.rectWidth / at100.rectWidth).toBeCloseTo(1.05, 2)
    const smallPinError = await page.evaluate(([cx, cy, bu, bv]) => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const rect = surface.getBoundingClientRect()
      const au = (cx - rect.left) / rect.width
      const av = (cy - rect.top) / rect.height
      return Math.hypot((au - (bu as number)) * rect.width, (av - (bv as number)) * rect.height)
    }, [smallAnchor.x, smallAnchor.y, smallBefore.u, smallBefore.v] as unknown as undefined)
    expect(smallPinError as number).toBeLessThan(1)

    // Floor ladder (per-mode band 0.1332..5): from 300% step down
    // 300% -> 200% -> 100% -> 67% (floor 0.333/2.5), then the 67% -> 100%
    // floor-exit (Paper reset). No stick, no oscillation.
    await resetZoom()
    await zoomInOnce()
    await waitZoomLabel('200%')
    await zoomInOnce()
    await waitZoomLabel('300%')
    await zoomOutOnce()
    await waitZoomLabel('200%')
    await zoomOutOnce()
    await waitZoomLabel('100%')
    await zoomOutOnce()
    await waitZoomLabel('67%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const at67 = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      return { rectWidth: surface.getBoundingClientRect().width }
    })
    console.log(`VECTOR_CAM_67 ${JSON.stringify(at67)}`)
    expect(at67.rectWidth / at100.rectWidth).toBeCloseTo(0.333 / 2.5 / 0.2, 2)
    expect(Math.abs(at67.rectWidth - 2400 * (0.333 / 2.5))).toBeLessThan(1.5)
    await zoomInOnce()
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const back100 = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      return { rectWidth: surface.getBoundingClientRect().width }
    })
    expect(Math.abs(back100.rectWidth - 480)).toBeLessThan(1.5)

    // PARITY record (measured vs Scratch-source equivalents for the same
    // 480-unit span; verdicts asserted in zoom-unit-scale-parity.test.ts):
    // Scratch reset 0.5 -> 480 CSS px; Scratch + (0.5->1.0) -> 960;
    // Scratch wheel -100 (0.5->0.6) -> 576. Vector now renders the same
    // Paper gains live through the 2.5 density: 480 -> 960 (+0.5 Paper) /
    // 576 (+0.1 Paper). The 67% floor is the true Paper floor 0.333
    // (0.333/2.5 CSS), exact parity, with the floor-exit back to reset.
    console.log(
      `PARITY_GAP vector ${JSON.stringify({ measured100: at100.rectWidth, measured200: at200.rectWidth, measured120: at120.rectWidth, measured67: at67.rectWidth, scratch: [480, 960, 576, 319.68] })}`,
    )
    await resetZoom()
  }, 180_000)

  it('measures the bitmap camera ladder on the live canvas resolution', async () => {
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
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        containerCenter: {
          x: containerRect.left + containerRect.width / 2,
          y: containerRect.top + containerRect.height / 2,
        },
      }
    })
    console.log(`BITMAP_CAM_100 ${JSON.stringify(diag)}`)
    // Fixture classification + live band via the explicit stored resolution
    // (canvas width is only the fallback probe here; the live behavior keys
    // off the stored bitmapResolution prop): res2 Paper reset 0.5 ->
    // rect == canvasW * 0.5; res1/unknown legacy reset 1 -> rect == canvasW.
    // Union-expanded canvases would need the artboard union math instead.
    const res = diag.canvasWidth / 480 >= 1.5 ? 2 : 1
    console.log(`BITMAP_CAM_RES ${JSON.stringify({ canvasWidth: diag.canvasWidth, canvasHeight: diag.canvasHeight, assumedResolution: res })}`)
    if (res === 2) {
      expect(Math.abs(diag.rectWidth - diag.canvasWidth * 0.5)).toBeLessThan(1.5)
      expect(Math.abs(diag.rectHeight - diag.canvasHeight * 0.5)).toBeLessThan(1.5)
    } else {
      expect(Math.abs(diag.rectWidth - diag.canvasWidth)).toBeLessThan(1)
      expect(Math.abs(diag.rectHeight - diag.canvasHeight)).toBeLessThan(1)
    }
    // Screen px for the same 480-unit span (measured): full-canvas span.
    const screenPer480At100 = (diag.rectWidth * res * 480) / diag.canvasWidth
    console.log(`BITMAP_DENSITY_100 ${JSON.stringify({ screenPer480At100 })}`)

    // + step: res2 0.5 -> 1.0 (200%, rect 2x, artwork-center anchor holds);
    // res1/unknown legacy 1 -> 1.5 (150%). No selection in either case.
    if (res === 2) {
      await zoomInOnce()
      await waitZoomLabel('200%')
      await new Promise((resolve) => setTimeout(resolve, 150))
      const at200 = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const rect = canvas.getBoundingClientRect()
        return { rectWidth: rect.width, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 }
      })
      console.log(`BITMAP_CAM_200 ${JSON.stringify(at200)}`)
      expect(at200.rectWidth / diag.rectWidth).toBeCloseTo(2, 2)
      expect(Math.abs(at200.rectWidth - diag.canvasWidth)).toBeLessThan(1.5)
      expect(Math.abs(at200.centerX - diag.centerX)).toBeLessThan(1)
      expect(Math.abs(at200.centerY - diag.centerY)).toBeLessThan(1)
    } else {
      await zoomInOnce()
      await waitZoomLabel('150%')
      await new Promise((resolve) => setTimeout(resolve, 150))
      const at150 = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const rect = canvas.getBoundingClientRect()
        return { rectWidth: rect.width, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 }
      })
      console.log(`BITMAP_CAM_150 ${JSON.stringify(at150)}`)
      expect(at150.rectWidth / diag.rectWidth).toBeCloseTo(1.5, 2)
      expect(Math.abs(at150.rectWidth - diag.canvasWidth * 1.5)).toBeLessThan(1)
      expect(Math.abs(at150.centerX - diag.centerX)).toBeLessThan(1)
      expect(Math.abs(at150.centerY - diag.centerY)).toBeLessThan(1)
    }

    // ctrl-wheel -100 tick (Paper basis): res2 +0.1 CSS (0.5 -> 0.6, "120%",
    // rect 1.2x); res1/unknown legacy +0.1 (1 -> 1.1, "110%").
    await resetZoom()
    const anchor = diag.containerCenter
    await page.evaluate((options) => {
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
      surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...(options as object) }))
    }, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: anchor.x, clientY: anchor.y } as unknown as undefined)
    await waitZoomLabel(res === 2 ? '120%' : '110%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const atWheel = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return { rectWidth: canvas.getBoundingClientRect().width }
    })
    console.log(`BITMAP_CAM_WHEEL ${JSON.stringify(atWheel)}`)
    expect(atWheel.rectWidth / diag.rectWidth).toBeCloseTo(1.2, 2)

    // Floor ladder: res2 0.5 -> 0.333 (67%) with floor-exit back to reset;
    // res1/unknown legacy 1 -> 0.5 -> 0.25 with exit to 0.5.
    await resetZoom()
    await zoomOutOnce()
    await waitZoomLabel(res === 2 ? '67%' : '50%')
    if (res !== 2) {
      await zoomOutOnce()
      await waitZoomLabel('25%')
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    const atFloor = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return { rectWidth: canvas.getBoundingClientRect().width }
    })
    console.log(`BITMAP_CAM_FLOOR ${JSON.stringify(atFloor)}`)
    if (res === 2) {
      expect(atFloor.rectWidth / diag.rectWidth).toBeCloseTo(0.333 / 0.5, 2)
      expect(Math.abs(atFloor.rectWidth - diag.canvasWidth * 0.333)).toBeLessThan(2)
    } else {
      expect(atFloor.rectWidth / diag.rectWidth).toBeCloseTo(0.25, 2)
    }
    await zoomInOnce()
    await waitZoomLabel('100%')

    // PARITY_GAP record: Scratch-source equivalents for the same span at the
    // classified resolution (verdicts in zoom-unit-scale-parity.test.ts).
    // Live Paper basis: vector reset renders the Paper 0.5 span exactly
    // (480 CSS px), res2 reset likewise; res1/unknown keeps the legacy span.
    const scratchAt = res === 2 ? [480, 960, 576, 319.68] : [240, 480, 288, 159.84]
    console.log(
      `PARITY_GAP bitmap ${JSON.stringify({ assumedResolution: res, measured: [screenPer480At100], scratch: scratchAt })}`,
    )
    await resetZoom()
  }, 180_000)
})
