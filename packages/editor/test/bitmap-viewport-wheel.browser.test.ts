import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor E2E for the costume viewport wheel wiring
// (`costume-viewport.ts` + `BitmapEditor.svelte#handleViewportWheel`).
// Uses its own dev-server port (4299) so it never collides with the other
// browser tests. Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-viewport-wheel.browser.test.ts
// Drives the actual paint surface in both bitmap and vector modes (Paper basis):
// - vector reset 0.2 / res2 reset 0.5 / unknown reset 1 (per-mode percent,
//   reset always "100%"); ctrl/meta wheel pins the surface point under the
//   cursor (Paper gain -deltaY/1000 per density, per-mode band clamp),
// - shift+vertical wheel becomes horizontal pan, plain wheel pans 2D,
// - line-mode (deltaMode 1) expands x15,
// - drag coordinates keep working after zoom (brush strokes land where the
//   rect mapping says), selections/eyedropper stay wired, and drawing +
//   single-entry history survive the wheel ops.
//
// Timing notes (undo/redo repaint asynchronously: the canvas clears first
// and redraws after the PNG decodes, so a transparent pixel alone proves
// nothing):
// - `clickHistory` settles each step: a genuine status transition implies the
//   awaited restore landed (status is set after it); a same-text repeat
//   carries no signal (Svelte skips identical writes), so it settles by sleep.
// - every step then waits for a pixel that only the settled target state has.
// - the converted-artwork baseline is measured first, so "back to artwork"
//   has a positive proof even when the artwork is non-blank.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4299'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

// Live-canvas center (integers for getImageData): the artboard is no longer
// the legacy 2400x1800 workspace (sprite default is 960x720), so every probe
// derives from the real canvas size instead of hardcoding (1200,900).
async function canvasCenter(): Promise<{ x: number; y: number }> {
  const size = await canvasSize()
  return { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) }
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas')
  const size = await canvasSize()
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height }
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
  }, [x, y])
}

async function waitForPixel(x: number, y: number, expected: number[], tolerance = 8) {
  await page.waitForFunction(
    ([px, py, want, tol]) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const got = Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
      return got.every((value, index) => Math.abs(value - (want as number[])[index]!) <= (tol as number))
    },
    [x, y, expected, tolerance] as unknown as undefined,
    { timeout: 15_000 },
  )
}

async function statusNow(): Promise<string> {
  return await page.evaluate(() => document.querySelector('header span[aria-live]')?.textContent ?? '')
}

async function waitForStatus(text: string, timeout = 15_000) {
  await page.waitForFunction(
    (want) => document.querySelector('header span[aria-live]')?.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout },
  )
}

async function waitZoomLabel(text: string, timeout = 10_000) {
  await page.waitForFunction(
    (want) => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout },
  )
}

// Click Undo/Redo and settle the async canvas reload. A genuine status
// transition implies the awaited restore landed; a same-text repeat carries
// no signal, so it settles by sleep instead.
async function clickHistory(kind: 'Undo' | 'Redo', want: 'Asset undo' | 'Asset redo') {
  const before = await statusNow()
  await page.getByRole('button', { name: kind }).click()
  if (before.includes(want)) {
    await new Promise((resolve) => setTimeout(resolve, 2500))
  } else {
    await waitForStatus(want)
  }
}

async function settleAfterOpen() {
  await page.waitForFunction(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function settleAfterVectorOpen() {
  await page.waitForFunction(() => {
    const stage = document.querySelector('[data-vector-stage-surface]')
    if (!stage) return false
    const rect = stage.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function openBitmap() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  await settleAfterOpen()
}

async function resetZoomTo100() {
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
  })
  await waitZoomLabel('100%')
  // Let Svelte flush the transform before measuring rects (no layout
  // assumption: works with the bitmap canvas hidden in vector mode too).
  await new Promise((resolve) => setTimeout(resolve, 150))
}

async function dispatchWheel(init: {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  clientX?: number
  clientY?: number
}) {
  await page.evaluate((options) => {
    const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
    surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options }))
  }, init as unknown as undefined)
}

async function paintSurfaceCenter(): Promise<{ x: number; y: number }> {
  return await page.evaluate(() => {
    const rect = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
}

async function bitmapPointAt(clientX: number, clientY: number): Promise<{ x: number; y: number }> {
  return await page.evaluate(([cx, cy]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((cx - rect.left) / rect.width) * canvas.width,
      y: ((cy - rect.top) / rect.height) * canvas.height,
    }
  }, [clientX, clientY] as unknown as undefined)
}

describe('costume viewport wheel on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4299', '--strictPort'], {
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

  it('pins the bitmap point under the cursor on ctrl-wheel and keeps drawing/history working', async () => {
    await openBitmap()
    await resetZoomTo100()

    // Baseline of the converted artwork (the undo target below): measured,
    // never assumed blank. Probes derive from the live canvas center
    // (sprite default 960x720 -> 480,360), never the legacy 2400 center.
    const art = await canvasCenter()
    const dot1 = { x: art.x, y: art.y }
    const dot2 = { x: art.x + 100, y: art.y + 30 }
    const dot2End = { x: dot2.x + 8, y: dot2.y }
    const selFromC = { x: art.x - 20, y: art.y - 20 }
    const selToC = { x: art.x + 20, y: art.y + 20 }
    const baselineCenter = await pixel(dot1.x, dot1.y)
    const baselineDot2 = await pixel(dot2.x, dot2.y)

    // Deterministic brush dot: proves drag coordinates and history keep
    // working across the wheel wiring below.
    await page.getByTestId('bitmap-tool-brush').click()
    const paintHex = await page.getByLabel('Paint color', { exact: true }).inputValue()
    const paintRgb = [0, 1, 2].map((i) => parseInt(paintHex.slice(1 + i * 2, 3 + i * 2), 16))
    const dot = await toScreen(dot1.x, dot1.y)
    await page.mouse.move(dot.x, dot.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')
    await waitForPixel(dot1.x, dot1.y, [...paintRgb, 255])

    // The dot's history entry round-trips on its own first: Undo restores the
    // artwork baseline, Redo restores the dot.
    await clickHistory('Undo', 'Asset undo')
    await waitForPixel(dot1.x, dot1.y, baselineCenter, 2)
    await clickHistory('Redo', 'Asset redo')
    await waitForPixel(dot1.x, dot1.y, [...paintRgb, 255])

    // Pointer-fixed zoom: the anchor sits inside the paint surface (center +
    // a bounded offset, so it stays on-screen at any zoom), the canvas point
    // under it is measured through the live rect (same mapping as
    // bitmapPointFromEvent), a real ctrl-wheel tick is dispatched on the
    // paint surface, and the same canvas point must still sit under the same
    // screen point (< 1px). Paper basis: res2 reset 0.5, -100 tick -> 0.6
    // (120%); unknown/res1 legacy reset 1, -100 -> 1.1 (110%).
    await resetZoomTo100()
    const wheelRes = await canvasSize().then((s) => (s.width / 480 >= 1.5 ? 2 : 1))
    const wheelFirstLabel = wheelRes === 2 ? '120%' : '110%'
    const center = await paintSurfaceCenter()
    const anchor = { x: center.x + 60, y: center.y + 40 }
    const before = await bitmapPointAt(anchor.x, anchor.y)
    await dispatchWheel({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: anchor.x, clientY: anchor.y })
    await waitZoomLabel(wheelFirstLabel)
    const after = await bitmapPointAt(anchor.x, anchor.y)
    expect(Math.abs(after.x - before.x)).toBeLessThan(1)
    expect(Math.abs(after.y - before.y)).toBeLessThan(1)

    // Small-magnitude tick: -10 gives +0.01 CSS (Paper basis: 120% -> 122%
    // res2; 110% -> 111% legacy), proving the delta magnitude is honored
    // instead of a sign-only jump.
    const wheelSecondLabel = wheelRes === 2 ? '122%' : '111%'
    const anchorSmall = { x: center.x + 60, y: center.y + 40 }
    const beforeSmall = await bitmapPointAt(anchorSmall.x, anchorSmall.y)
    await dispatchWheel({ deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true, clientX: anchorSmall.x, clientY: anchorSmall.y })
    await waitZoomLabel(wheelSecondLabel)
    const afterSmall = await bitmapPointAt(anchorSmall.x, anchorSmall.y)
    expect(Math.abs(afterSmall.x - beforeSmall.x)).toBeLessThan(1)
    expect(Math.abs(afterSmall.y - beforeSmall.y)).toBeLessThan(1)

    // Zoom back out with a positive ctrl tick: same pin, -0.1 CSS step back
    // (res2 122% -> 102%; legacy 111% -> 101%).
    const wheelBackLabel = wheelRes === 2 ? '102%' : '101%'
    const centerOut = await paintSurfaceCenter()
    const anchorOut = { x: centerOut.x - 50, y: centerOut.y + 30 }
    const beforeOut = await bitmapPointAt(anchorOut.x, anchorOut.y)
    await dispatchWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: true, clientX: anchorOut.x, clientY: anchorOut.y })
    await waitZoomLabel(wheelBackLabel)
    const afterOut = await bitmapPointAt(anchorOut.x, anchorOut.y)
    expect(Math.abs(afterOut.x - beforeOut.x)).toBeLessThan(1)

    // Meta-wheel follows the same pinned branch.
    await resetZoomTo100()
    const centerMeta = await paintSurfaceCenter()
    const beforeMeta = await bitmapPointAt(centerMeta.x, centerMeta.y)
    await dispatchWheel({ deltaX: 0, deltaY: -100, deltaMode: 0, metaKey: true, clientX: centerMeta.x, clientY: centerMeta.y })
    await waitZoomLabel(wheelFirstLabel)
    const afterMeta = await bitmapPointAt(centerMeta.x, centerMeta.y)
    expect(Math.abs(afterMeta.x - beforeMeta.x)).toBeLessThan(1)

    // Shift+vertical wheel becomes horizontal pan (scale unchanged): poll the
    // live rect until the -30px shift lands instead of sleeping a fixed beat.
    await resetZoomTo100()
    const leftBefore = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return canvas.getBoundingClientRect().left
    })
    await dispatchWheel({ deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true })
    await page.waitForFunction(
      ([want]) => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return Math.abs(canvas.getBoundingClientRect().left - (want as number)) < 2
      },
      [leftBefore - 30] as unknown as undefined,
      { timeout: 10_000 },
    )
    await waitZoomLabel('100%')

    // Line-mode deltas expand x15 (deltaMode 1, dy 2 lines -> 30px pan).
    const topBefore = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return canvas.getBoundingClientRect().top
    })
    await dispatchWheel({ deltaX: 0, deltaY: 2, deltaMode: 1 })
    await page.waitForFunction(
      ([want]) => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return Math.abs(canvas.getBoundingClientRect().top - (want as number)) < 2
      },
      [topBefore - 30] as unknown as undefined,
      { timeout: 10_000 },
    )
    await resetZoomTo100()

    // The wheel ops must not have touched the artwork: dot1 still painted.
    expect(await pixel(dot1.x, dot1.y)).toEqual([...paintRgb, 255])

    // Drag coordinates still map after zoom: a brush stroke near the artwork
    // center lands there even while zoomed in via the toolbar. NOTE: the
    // paint viewport is narrow (~455px) while the canvas is 960px, so probe
    // near the center to stay on-screen (res2 200%, unknown 150%).
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel(wheelRes === 2 ? '200%' : '150%')
    await page.getByTestId('bitmap-tool-brush').click()
    // Paint with a small drag (down, +8px, up) so the Paper.js stroke covers
    // the probe pixel even antialiased; then wait on a 5x5 neighborhood.
    const zoomed = await toScreen(dot2.x, dot2.y)
    const zoomedEnd = await toScreen(dot2End.x, dot2End.y)
    await page.mouse.move(zoomed.x, zoomed.y)
    await page.mouse.down()
    await page.mouse.move(zoomedEnd.x, zoomedEnd.y, { steps: 4 })
    await page.mouse.up()
    await page.waitForFunction(
      ([cx, cy, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const context = target.getContext('2d')!
        const wantRgb = want as number[]
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const [r, g, b, a] = context.getImageData((cx as number) + dx, (cy as number) + dy, 1, 1).data
            if (Math.abs(r - wantRgb[0]!) <= 30 && Math.abs(g - wantRgb[1]!) <= 30 && Math.abs(b - wantRgb[2]!) <= 30 && a === 255) return true
          }
        }
        return false
      },
      [dot2.x, dot2.y, paintRgb] as unknown as undefined,
      { timeout: 15_000 },
    )
    // The second save reuses the same 'Bitmap edit saved' status as the first
    // dot, so the status line cannot serialize it: settle explicitly before
    // undoing.
    await new Promise((resolve) => setTimeout(resolve, 3000))

    // History peels exactly: two undos (dot1-only, then artwork), two redos.
    await clickHistory('Undo', 'Asset undo')
    // dot1-only: the repainted dot1 proves the reload landed; then dot2 back
    // to its artwork baseline.
    await waitForPixel(dot1.x, dot1.y, [...paintRgb, 255])
    expect(await pixel(dot2.x, dot2.y)).toEqual(baselineDot2)
    await clickHistory('Undo', 'Asset undo')
    // Artwork: the measured baseline is the positive proof (never assumed
    // blank); settle past any pending redraw, then re-assert.
    await waitForPixel(dot1.x, dot1.y, baselineCenter, 2)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(await pixel(dot1.x, dot1.y)).toEqual(baselineCenter)
    expect(await pixel(dot2.x, dot2.y)).toEqual(baselineDot2)
    await clickHistory('Redo', 'Asset redo')
    // dot1-only again.
    await waitForPixel(dot1.x, dot1.y, [...paintRgb, 255])
    expect(await pixel(dot2.x, dot2.y)).toEqual(baselineDot2)
    await clickHistory('Redo', 'Asset redo')
    // Both back: the repainted dot2 neighborhood proves the reload landed.
    await page.waitForFunction(
      ([cx, cy, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const context = target.getContext('2d')!
        const wantRgb = want as number[]
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const [r, g, b, a] = context.getImageData((cx as number) + dx, (cy as number) + dy, 1, 1).data
            if (Math.abs(r - wantRgb[0]!) <= 30 && Math.abs(g - wantRgb[1]!) <= 30 && Math.abs(b - wantRgb[2]!) <= 30 && a === 255) return true
          }
        }
        return false
      },
      [dot2.x, dot2.y, paintRgb] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await pixel(dot1.x, dot1.y)).toEqual([...paintRgb, 255])

    // Selection + eyedropper stay wired after the wheel change.
    await page.getByTestId('bitmap-tool-select').click()
    const selFrom = await toScreen(selFromC.x, selFromC.y)
    const selTo = await toScreen(selToC.x, selToC.y)
    await page.mouse.move(selFrom.x, selFrom.y)
    await page.mouse.down()
    await page.mouse.move(selTo.x, selTo.y, { steps: 8 })
    await page.mouse.up()
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    await page.getByTestId('bitmap-tool-eyedropper').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'hidden' })

    // Clamp range preserved: repeated additive ctrl zoom-in stops at the
    // per-mode ceiling 5 (res2 0.5 + 45 x 0.1 -> 1000%; unknown 1.0 + 45 x
    // 0.1 -> 500%).
    await resetZoomTo100()
    const clampCenter = await paintSurfaceCenter()
    for (let i = 0; i < 45; i += 1) {
      await dispatchWheel({
        deltaX: 0,
        deltaY: -100,
        deltaMode: 0,
        ctrlKey: true,
        clientX: clampCenter.x,
        clientY: clampCenter.y,
      })
    }
    await waitZoomLabel(wheelRes === 2 ? '1000%' : '500%')
  }, 180_000)

  it('pins the vector surface under the cursor on ctrl-wheel', async () => {
    await openBitmap()
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview') !== null, null, { timeout: 10_000 })
    await settleAfterVectorOpen()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await resetZoomTo100()

    const surface = await page.evaluate(() => {
      const rect = document.querySelector('[data-vector-stage-surface]')!.getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    })
    const clientX = surface.left + surface.width * 0.4
    const clientY = surface.top + surface.height * 0.45
    const before = await page.evaluate(([cx, cy]) => {
      const rect = document.querySelector('[data-vector-stage-surface]')!.getBoundingClientRect()
      return { u: (cx - rect.left) / rect.width, v: (cy - rect.top) / rect.height }
    }, [clientX, clientY] as unknown as undefined)
    // Vector Paper-parity gain: -100 tick -> +0.1 Paper -> +0.04 CSS.
    // At the live vector reset 0.2 this is 0.24 (120%).
    await dispatchWheel({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX, clientY })
    await waitZoomLabel('120%')
    const error = await page.evaluate(([cx, cy, bu, bv]) => {
      const rect = document.querySelector('[data-vector-stage-surface]')!.getBoundingClientRect()
      const au = (cx - rect.left) / rect.width
      const av = (cy - rect.top) / rect.height
      return Math.hypot((au - (bu as number)) * rect.width, (av - (bv as number)) * rect.height)
    }, [clientX, clientY, before.u, before.v] as unknown as undefined)
    expect(error).toBeLessThan(1)
  }, 90_000)
})
