import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor E2E for the bitmap rect/oval exclusive Filled/Outlined UI
// (`bitmap-shape-mode.ts` + `Editor.svelte` / `BitmapEditor.svelte`).
// Uses its own dev-server port (4291) so it never collides with the other
// browser tests. Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-shape-mode-editor.browser.test.ts
// Drives the actual paint surface: Filled/Outlined toggle visibility and
// default, rect + oval in both modes, fill-only vs contour-only pixels,
// outline-width effect, transparent-interior no-op (no history), live
// preview before mouse-up vs committed selection after mouse-up, Undo/Redo
// single entries, and the toggle staying hidden in vector mode.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4291'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

// Artboard canvas coords (960x720 sprite artboard, center 480,360).
const BOX = { x1: 280, y1: 260, x2: 480, y2: 360 }
const CENTER = { x: 380, y: 310 }
const TOP_MIDDLE = { x: 380, y: 260 }

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function canvasRectLive(): Promise<{ left: number; top: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const rect = target.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  // Live transform: fresh rect + backing size per call (no cached mapping).
  const rect = await canvasRectLive()
  const size = await canvasSize()
  const scaleX = rect.width / size.width
  const scaleY = rect.height / size.height
  if (Math.abs(scaleX - scaleY) / Math.max(scaleX, 1e-9) > 0.02) {
    throw new Error(`Non-uniform canvas mapping scaleX=${scaleX} scaleY=${scaleY}`)
  }
  const sx = rect.left + (x / size.width) * rect.width
  const sy = rect.top + (y / size.height) * rect.height
  // Strict hit: the mapped client point must sit inside the live canvas rect
  // and elementFromPoint must resolve to the bitmap canvas itself (proves the
  // drag point is truly canvas内, not covered by a toolbar/overlay).
  if (sx < rect.left || sx > rect.left + rect.width || sy < rect.top || sy > rect.top + rect.height) {
    throw new Error(`Canvas point (${x},${y}) maps outside live canvas rect`)
  }
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px as number, py as number) as HTMLElement | null
    return { testid: el?.getAttribute?.('data-testid') ?? null, tag: el?.tagName ?? 'NONE' }
  }, [sx, sy] as unknown as undefined)
  if (hit.testid !== 'bitmap-editor-canvas') {
    throw new Error(`elementFromPoint miss at canvas (${x},${y}): ${hit.tag}#${hit.testid}`)
  }
  return { x: sx, y: sy }
}

function toolArmed(className: string | null): boolean {
  return (className ?? '').includes('text-white')
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
  }, [x, y])
}

async function dragCanvas(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  const a = await toScreen(from.x, from.y)
  const b = await toScreen(to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

async function waitForPixel(x: number, y: number, expected: number[], tolerance = 8) {
  await page.waitForFunction(
    ([px, py, want, tol]) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const got = Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
      return got.every((value, index) => Math.abs(value - (want as number[])[index]!) <= (tol as number))
    },
    [x, y, expected, tolerance] as unknown as undefined,
    { timeout: 10_000 },
  )
}

async function waitForStatus(text: string, timeout = 10_000) {
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout },
  )
}

async function settleAfterOpen() {
  // Let the reloaded editor finish layout (canvas box + toolbar state) before
  // measuring screen coords: polling avoids a fixed sleep yet kills the
  // reload-then-drag race that flakes coordinate mapping.
  await page.waitForFunction(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function openBitmap() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  // Current reference: bitmap res2 Paper reset is scale 0.5 = UI "100%"
  // (the old `Zoom out` -> "25%" expectation was the legacy CSS magnification;
  // the current floor is Paper 0.333 = UI "67%"). Settle on the independent
  // reset instead of zooming out.
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  await page.waitForFunction(() => {
    const label = document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? ''
    return label.includes('100%')
  }, null, { timeout: 15_000 })
  // Prove the res2 precondition live: 960x720 backing at reset scale 0.5
  // (rect ~= backing * 0.5), so every fixed drag point below maps inside the
  // real canvas.
  const size = await canvasSize()
  const rect = await canvasRectLive()
  const scale = rect.width / size.width
  if (size.width !== 960 || size.height !== 720) {
    throw new Error(`Expected bitmap res2 960x720 backing, got ${size.width}x${size.height}`)
  }
  if (Math.abs(scale - 0.5) > 0.06) {
    throw new Error(`Expected bitmap res2 reset scale ~0.5 at 100%, got ${scale}`)
  }
  await settleAfterOpen()
}

async function useSolidColors(fill: string, stroke: string) {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  await page.getByLabel('Stroke color', { exact: true }).fill(stroke)
  // Make sure both exclusive toggles start opaque.
  for (const name of ['Transparent fill', 'Transparent stroke'] as const) {
    const toggle = page.getByRole('button', { name })
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
  }
}

async function setBrushSize(value: string) {
  const size = page.getByLabel('Brush size')
  await size.fill(value)
  await size.press('Tab')
}

describe('bitmap rect/oval Filled/Outlined mode on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4291', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
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

  it('shows the exclusive toggle for rect/oval with Filled default and hides it elsewhere', async () => {
    await openBitmap()
    await page.getByTestId('bitmap-tool-rect').click()
    const group = page.getByRole('group', { name: 'Bitmap shape mode' })
    await group.waitFor({ state: 'visible' })
    const filled = page.getByTestId('bitmap-shape-mode-filled')
    const outlined = page.getByTestId('bitmap-shape-mode-outlined')
    expect(await filled.getAttribute('aria-pressed')).toBe('true')
    expect(await outlined.getAttribute('aria-pressed')).toBe('false')
    // Bitmap rect/oval never use the outline width (reference `bitBrushSize`
    // parity): the Stroke width field stays disabled in both modes, and the
    // shared Brush size slider stays visible to drive the Outlined contour.
    expect(await page.getByLabel('Stroke width').isDisabled()).toBe(true)
    expect(await page.getByLabel('Brush size').isVisible()).toBe(true)

    await outlined.click()
    expect(await filled.getAttribute('aria-pressed')).toBe('false')
    expect(await outlined.getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByLabel('Stroke width').isDisabled()).toBe(true)
    expect(await page.getByLabel('Brush size').isVisible()).toBe(true)
    await filled.click()
    expect(await filled.getAttribute('aria-pressed')).toBe('true')

    // Oval keeps the same exclusive toggle.
    await page.getByTestId('bitmap-tool-oval').click()
    expect(await page.getByRole('group', { name: 'Bitmap shape mode' }).isVisible()).toBe(true)

    // Brush (and other non-shape tools) hide the toggle.
    await page.getByTestId('bitmap-tool-brush').click()
    expect(await page.getByRole('group', { name: 'Bitmap shape mode' }).count()).toBe(0)

    // Vector mode never shows the bitmap-exclusive toggle, even on shapes.
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview') !== null, null, { timeout: 10_000 })
    await page.getByTestId('vector-shape-rect').last().click()
    expect(await page.getByRole('group', { name: 'Bitmap shape mode' }).count()).toBe(0)
    expect(await page.getByTestId('bitmap-shape-mode-filled').count()).toBe(0)
    expect(await page.getByTestId('bitmap-shape-mode-outlined').count()).toBe(0)
  }, 60_000)

  it('paints a filled rect interior only and round-trips undo/redo', async () => {
    await openBitmap()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidColors('#ff0000', '#0000ff')
    const beforeCenter = await pixel(CENTER.x, CENTER.y)
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit saved')
    // Interior is the opaque fill; the blue outline is ignored in Filled mode.
    await waitForPixel(CENTER.x, CENTER.y, [255, 0, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const topEdge = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)
    expect(topEdge).toEqual([255, 0, 0, 255])
    // The gesture commits exactly once: rect stays armed with a selection
    // (reference BIT_RECT retention; no flip to select).
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    expect(toolArmed(await page.getByTestId('bitmap-tool-rect').getAttribute('class'))).toBe(true)
    expect(toolArmed(await page.getByTestId('bitmap-tool-select').getAttribute('class'))).toBe(false)
    expect(beforeCenter).not.toEqual([255, 0, 0, 255])

    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, beforeCenter] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(CENTER.x, CENTER.y, [255, 0, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
  }, 90_000)

  it('paints a filled oval interior only', async () => {
    await openBitmap()
    await page.getByTestId('bitmap-tool-oval').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidColors('#00ff00', '#0000ff')
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit saved')
    await waitForPixel(CENTER.x, CENTER.y, [0, 255, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([0, 255, 0, 255])
    // A corner of the box stays outside the ellipse: the fill must not leak
    // into the box corners the way a rect would.
    const corner = await pixel(BOX.x1 + 2, BOX.y1 + 2)
    expect(corner).not.toEqual([0, 255, 0, 255])
    // Reference BIT_OVAL retention: the oval tool stays armed (no flip to select).
    expect(toolArmed(await page.getByTestId('bitmap-tool-oval').getAttribute('class'))).toBe(true)
    expect(toolArmed(await page.getByTestId('bitmap-tool-select').getAttribute('class'))).toBe(false)
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    expect(await pixel(CENTER.x, CENTER.y)).not.toEqual([0, 255, 0, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(CENTER.x, CENTER.y, [0, 255, 0, 255])
  }, 90_000)

  it('paints an outlined rect contour only and honors the brush size', async () => {
    await openBitmap()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    await useSolidColors('#ff0000', '#0000ff')
    await setBrushSize('14')
    const beforeCenter = await pixel(CENTER.x, CENTER.y)
    const beforeFar = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y - 20)
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit saved')
    // Contour is the FILL color (red); the blue stroke is ignored in both modes.
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(380, 260, 1, 1).data
      return r > 200 && g < 80 && b < 80 && a === 255
    }, null, { timeout: 10_000 })
    const edge = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)
    expect(edge[0]).toBeGreaterThan(200)
    expect(edge[1]).toBeLessThan(80)
    expect(edge[2]).toBeLessThan(80)
    // Interior keeps whatever was there before (the fill never paints it).
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    // Half the 14px brush-size outline extends past the box: 5px above the top
    // edge is still red, while 20px above is untouched.
    const nearOutside = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y - 5)
    expect(nearOutside[0]).toBeGreaterThan(150)
    expect(await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y - 20)).toEqual(beforeFar)
    // Reference BIT_RECT retention: the rect tool stays armed (no flip to select).
    expect(toolArmed(await page.getByTestId('bitmap-tool-rect').getAttribute('class'))).toBe(true)
    expect(toolArmed(await page.getByTestId('bitmap-tool-select').getAttribute('class'))).toBe(false)

    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
        return got[0]! < 80 || got.join(',') !== '255,0,0,255'
      },
      [TOP_MIDDLE.x, TOP_MIDDLE.y, [255, 0, 0, 255]] as unknown as undefined,
      { timeout: 10_000 },
    )
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b] = target.getContext('2d')!.getImageData(380, 260, 1, 1).data
      return r > 200 && g < 80 && b < 80
    }, null, { timeout: 10_000 })
  }, 90_000)

  it('paints an outlined oval contour only', async () => {
    await openBitmap()
    await page.getByTestId('bitmap-tool-oval').click()
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    await useSolidColors('#ff0000', '#00ff00')
    await setBrushSize('12')
    const beforeCenter = await pixel(CENTER.x, CENTER.y)
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit saved')
    // Top of the ellipse is the FILL color (red), not the green stroke
    // (tolerant: stroked ellipse is antialiased, so assert a red-dominant
    // pixel, not an exact value).
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(380, 260, 1, 1).data
      return r > 150 && g < 120 && b < 120 && a > 100
    }, null, { timeout: 10_000 })
    const edge = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)
    expect(edge[0]).toBeGreaterThan(150)
    // Interior is untouched: the outlined pass never fills it.
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    // Reference BIT_OVAL retention: the oval tool stays armed (no flip to select).
    expect(toolArmed(await page.getByTestId('bitmap-tool-oval').getAttribute('class'))).toBe(true)
    expect(toolArmed(await page.getByTestId('bitmap-tool-select').getAttribute('class'))).toBe(false)
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(380, 260, 1, 1).data
      return r > 150 && g < 120 && b < 120 && a > 100
    }, null, { timeout: 10_000 })
  }, 90_000)

  it('treats a transparent interior as a no-op without history', async () => {
    await openBitmap()
    // Filled + transparent fill: the opaque blue stroke is ignored (both modes
    // use the fill color), so the gesture changes no pixels and records no
    // history.
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidColors('#ff0000', '#0000ff')
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')).toBe('true')
    const beforeCenter = await pixel(CENTER.x, CENTER.y)
    const beforeEdge = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit: no change', 20_000)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    expect(await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)).toEqual(beforeEdge)
    expect(await page.getByTestId('bitmap-selection').count()).toBe(0)

    // Outlined + transparent fill is the same no-op (the stroke toggle is
    // ignored: the contour uses the fill color and the shared brush size).
    await openBitmap()
    await page.getByTestId('bitmap-tool-oval').click()
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    await useSolidColors('#ff0000', '#0000ff')
    await setBrushSize('12')
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')).toBe('true')
    const ovalBefore = await pixel(CENTER.x, CENTER.y)
    const ovalEdgeBefore = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit: no change', 20_000)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(ovalBefore)
    expect(await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)).toEqual(ovalEdgeBefore)
    expect(await page.getByTestId('bitmap-selection').count()).toBe(0)

    // Outlined + transparent stroke still paints: the stroke toggle is ignored
    // and the opaque fill drives the contour.
    await openBitmap()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    await useSolidColors('#ff0000', '#0000ff')
    await setBrushSize('12')
    await page.getByRole('button', { name: 'Transparent stroke' }).click()
    expect(await page.getByRole('button', { name: 'Transparent stroke' }).getAttribute('aria-pressed')).toBe('true')
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit saved')
    const strokeIgnored = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)
    expect(strokeIgnored[0]).toBeGreaterThan(150)
  }, 120_000)

  it('shows a live preview while dragging and commits the selection on release', async () => {
    await openBitmap()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidColors('#ff0000', '#0000ff')
    const from = await toScreen(BOX.x1, BOX.y1)
    const mid = await toScreen(CENTER.x, CENTER.y)
    const to = await toScreen(BOX.x2, BOX.y2)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(mid.x, mid.y, { steps: 6 })
    // Preview paints before release, without a selection or history entry.
    // The mid-stage box is (280,260)-(380,310), so sample its interior
    // (330,285): the final CENTER (380,310) sits exactly on the
    // exclusive fillRect edge and is only covered after the full drag.
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
      if (!target) return false
      const context = target.getContext('2d')
      if (!context) return false
      const [r, g, b, a] = context.getImageData(330, 285, 1, 1).data
      return r === 255 && g === 0 && b === 0 && a === 255
    }, null, { timeout: 10_000 })
    expect(await page.getByTestId('bitmap-selection').count()).toBe(0)
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Reference BIT_RECT retention: the rect tool stays armed after commit.
    expect(toolArmed(await page.getByTestId('bitmap-tool-rect').getAttribute('class'))).toBe(true)
    expect(toolArmed(await page.getByTestId('bitmap-tool-select').getAttribute('class'))).toBe(false)
  }, 90_000)
})
