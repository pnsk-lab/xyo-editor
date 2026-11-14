import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Strict geometry E2E for the rotation handles (bitmap + vector).
//
// The older `rotation-handle.browser.test.ts` is status-centered: it asserts
// status text, one opaque center pixel and a far marker. This suite drives the
// same real handles but strictly asserts:
// - free-angle coordinates/orientation (expected drag delta vs artwork),
// - Shift 45-degree snapping (live degree readout + snapped geometry),
// - bitmap transparent / semi-transparent / far pixels,
// - Undo/Redo geometric round-trips (pixel + overlay + SVG equality).
//
// Product code is untouched; every expectation is derived from the drag
// geometry (atan2 deltas) and the artwork itself.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4289'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
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

async function dragCanvas(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  // Single boundingBox read for both endpoints: two separate reads can skew
  // the marquee when the canvas box moves between calls.
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas')
  const size = await canvasSize()
  const map = (p: { x: number; y: number }) => ({
    x: box.x + (p.x / size.width) * box.width,
    y: box.y + (p.y / size.height) * box.height,
  })
  const a = map(from)
  const b = map(to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

async function dragHandleByScreen(testId: string, dxScreen: number, dyScreen: number, options: { shift?: boolean; steps?: number } = {}) {
  const locator = page.getByTestId(testId)
  await locator.waitFor({ state: 'visible' })
  const box = await locator.boundingBox()
  if (!box) throw new Error(`Missing handle ${testId}`)
  if (options.shift) await page.keyboard.down('Shift')
  try {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dxScreen, box.y + box.height / 2 + dyScreen, { steps: options.steps ?? 16 })
    await page.mouse.up()
  } finally {
    if (options.shift) await page.keyboard.up('Shift')
  }
}

async function waitForStatus(text: string) {
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout: 10_000 },
  )
}

async function ensureBitmapMode() {
  const convertToBitmap = page.getByRole('button', { name: 'ビットマップに変換' })
  if (await convertToBitmap.count().then((count) => count > 0).catch(() => false)) {
    try {
      if (await convertToBitmap.first().isVisible()) await convertToBitmap.first().click()
    } catch {}
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 15_000 })
}

function normalizeDeg(deg: number): number {
  const w = ((((deg + 180) % 360) + 360) % 360) - 180
  return w <= -180 ? 180 : w
}

function dragDeltaDegrees(center: { x: number; y: number }, start: { x: number; y: number }, end: { x: number; y: number }): number {
  const a0 = (Math.atan2(start.y - center.y, start.x - center.x) * 180) / Math.PI
  const a1 = (Math.atan2(end.y - center.y, end.x - center.x) * 180) / Math.PI
  return normalizeDeg(a1 - a0)
}

/** Read the bitmap selection overlay (`%` style) back into canvas pixels. */
async function selectionOverlayCanvas(): Promise<{ x: number; y: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const overlay = document.querySelector<HTMLElement>('[data-testid="bitmap-selection"]')
    if (!overlay) throw new Error('Missing bitmap-selection overlay')
    const parse = (value: string) => {
      const m = value.match(/([\d.]+)%/)
      return m ? Number(m[1]) / 100 : NaN
    }
    const left = parse(overlay.style.left)
    const top = parse(overlay.style.top)
    const width = parse(overlay.style.width)
    const height = parse(overlay.style.height)
    return { x: left * canvas.width, y: top * canvas.height, width: width * canvas.width, height: height * canvas.height }
  })
}

/** Count opaque red pixels in a canvas rect (orientation probe). */
async function countOpaqueRed(rect: { x: number; y: number; width: number; height: number }): Promise<number> {
  return await page.evaluate((r) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const data = target.getContext('2d')!.getImageData(r.x, r.y, r.width, r.height).data
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 150 && data[i + 1]! < 120 && data[i + 2]! < 120 && data[i + 3]! === 255) count += 1
    }
    return count
  }, rect)
}

/** Count semi-transparent green pixels in a canvas rect. */
async function countSemiGreen(rect: { x: number; y: number; width: number; height: number }): Promise<number> {
  return await page.evaluate((r) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const data = target.getContext('2d')!.getImageData(r.x, r.y, r.width, r.height).data
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]!
      if (alpha >= 80 && alpha <= 180 && data[i + 1]! > 150 && data[i]! < 150) count += 1
    }
    return count
  }, rect)
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

type SvgBounds = { x: number; y: number; width: number; height: number }

async function boundsList(svgText: string): Promise<SvgBounds[]> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits, vectorObjectBounds } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const units = editableVectorUnits(doc.documentElement)
    return units.map((element: Element) => vectorObjectBounds(element))
  }, svgText)
}

/** Extract the world-rotation angle from a `matrix(a b c d e f)` transform. */
function matrixAngleDegrees(transform: string | null): number | undefined {
  if (!transform) return undefined
  const m = transform.match(/matrix\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/)
  if (!m) return undefined
  const a = Number(m[1])
  const b = Number(m[2])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
  return (Math.atan2(b, a) * 180) / Math.PI
}

async function vectorTransforms(svgText: string): Promise<(string | null)[]> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return editableVectorUnits(doc.documentElement).map((element: Element) => element.getAttribute('transform'))
  }, svgText)
}

describe('rotation-handle geometry (strict angles, pixels, undo/redo)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4289', '--strictPort'], {
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
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('bitmap: free ~90-degree handle drag moves orientation, keeps semi/far pixels, undo/redo round-trips', async () => {
    await ensureBitmapMode()
    const zoomOut = page.getByRole('button', { name: 'Zoom out' })
    for (let i = 0; i < 10; i += 1) await zoomOut.click()

    // Asymmetric artwork: horizontal red bar + blue east tip (orientation
    // marker) + semi-transparent green block on transparent + far marker.
    // The marquee trims to the opaque union (1100,855,120,35); rotation
    // preserves that trimmed center (1160,872.5).
    // Only the selection rect (plus a far transparent probe) is cleared so
    // the semi block stays truly semi-transparent and the brush commit path
    // matches the proven existing test (stamp at 400,400).
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.clearRect(1095, 845, 130, 70)
      context.clearRect(290, 290, 20, 20)
      context.fillStyle = '#ff0000'
      context.fillRect(1100, 870, 120, 20)
      context.fillStyle = '#0000ff'
      context.fillRect(1195, 870, 25, 20)
      context.fillStyle = 'rgba(0,255,0,0.5)'
      context.fillRect(1150, 858, 12, 12)
      context.fillStyle = '#00ff00'
      context.fillRect(1274, 932, 6, 6)
    })
    // Commit the scripted pixels through a real brush stamp far away (same
    // anchor as the proven existing test).
    await page.getByTestId('bitmap-tool-brush').click()
    const stampAt = await toScreen(400, 400)
    await page.mouse.move(stampAt.x, stampAt.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')

    await page.getByTestId('bitmap-tool-select').click()
    await dragCanvas({ x: 1095, y: 845 }, { x: 1225, y: 915 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await page.getByTestId('bitmap-floating-rotate-handle').waitFor({ state: 'visible' })

    // Pre-rotation pixel baseline (strict, not just status). The bar is red
    // except for the blue east tip (1195..1220), so probe both.
    expect(await pixel(1180, 880)).toEqual([255, 0, 0, 255])
    expect(await pixel(1205, 880)).toEqual([0, 0, 255, 255])
    expect(await pixel(1105, 860)).toEqual([0, 0, 0, 0])
    expect(await pixel(1276, 934)).toEqual([0, 255, 0, 255])
    expect(await pixel(300, 300)).toEqual([0, 0, 0, 0])
    const semiBefore = await countSemiGreen({ x: 1145, y: 853, width: 22, height: 22 })
    expect(semiBefore).toBeGreaterThan(60)
    const overlayBefore = await selectionOverlayCanvas()
    // The marquee trims transparent margins to the opaque union
    // (red bar + blue tip + semi block): (1100,858,120,32). This trim is
    // itself asserted strictly; rotation preserves the trimmed center.
    expect(overlayBefore.x).toBeGreaterThanOrEqual(1097)
    expect(overlayBefore.x).toBeLessThanOrEqual(1103)
    expect(overlayBefore.y).toBeGreaterThanOrEqual(855)
    expect(overlayBefore.y).toBeLessThanOrEqual(861)
    expect(overlayBefore.width).toBeGreaterThanOrEqual(117)
    expect(overlayBefore.width).toBeLessThanOrEqual(123)
    expect(overlayBefore.height).toBeGreaterThanOrEqual(29)
    expect(overlayBefore.height).toBeLessThanOrEqual(35)
    const srcCx = overlayBefore.x + overlayBefore.width / 2
    const srcCy = overlayBefore.y + overlayBefore.height / 2
    expect(srcCx).toBeCloseTo(1160, 0)
    expect(srcCy).toBeCloseTo(874, 0)
    // The strip above the selection holds starter-white, not red, yet.
    expect(await countOpaqueRed({ x: 1140, y: 815, width: 40, height: 30 })).toBeLessThanOrEqual(2)

    // Free drag to the east of the center: north handle -> east target is a
    // clockwise ~+90-degree gesture in screen (y-down) coordinates.
    const handleBox = await page.getByTestId('bitmap-floating-rotate-handle').boundingBox()
    if (!handleBox) throw new Error('Missing rotate handle box')
    const handleStart = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
    const centerScreen = await toScreen(srcCx, srcCy)
    const radius = Math.hypot(handleStart.x - centerScreen.x, handleStart.y - centerScreen.y)
    expect(radius).toBeGreaterThan(5)
    const targetScreen = { x: centerScreen.x + radius, y: centerScreen.y }
    const expectedDelta = dragDeltaDegrees(centerScreen, handleStart, targetScreen)
    // Strict free-angle coordinate: must be a large clockwise turn, and must
    // NOT be confused with a no-op or a flip.
    expect(expectedDelta).toBeGreaterThan(75)
    expect(expectedDelta).toBeLessThan(105)

    await dragHandleByScreen(
      'bitmap-floating-rotate-handle',
      targetScreen.x - handleStart.x,
      targetScreen.y - handleStart.y,
    )
    await waitForStatus('Bitmap selection rotated')

    // Overlay geometry: trimmed 120x35 swapped to ~35x120 around src center.
    // Centered dest rounds to int canvas px, so allow 1px (not 0.5).
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    const overlayAfter = await selectionOverlayCanvas()
    expect(Math.abs(overlayAfter.x + overlayAfter.width / 2 - srcCx)).toBeLessThanOrEqual(1)
    expect(Math.abs(overlayAfter.y + overlayAfter.height / 2 - srcCy)).toBeLessThanOrEqual(1)
    expect(overlayAfter.width).toBeGreaterThan(28)
    expect(overlayAfter.width).toBeLessThan(42)
    expect(overlayAfter.height).toBeGreaterThan(112)
    expect(overlayAfter.height).toBeLessThan(128)

    // Orientation: the horizontal bar is now vertical. The wide strip above
    // the old selection (white before) now carries the vertical bar.
    const axisRed = await countOpaqueRed({ x: 1140, y: 815, width: 40, height: 30 })
    expect(axisRed).toBeGreaterThan(200)
    const eastPixel = await pixel(1205, 880)
    expect(eastPixel[3]).toBeLessThanOrEqual(10)
    // Semi-transparent block survived with alpha preserved near its rotated
    // home (rel (-4,-10) rotated 90CW -> +(10,-4) ~= (1170,870), inside the
    // punched hole so it stamps over transparency, not starter-white).
    const semiAfter = await countSemiGreen({ x: 1160, y: 858, width: 18, height: 20 })
    expect(semiAfter).toBeGreaterThan(40)
    // Old semi home is now transparent (source punched, dest moved away).
    expect(await pixel(1105, 860)).toEqual([0, 0, 0, 0])
    // Transparent + far pixels are undisturbed.
    expect(await pixel(300, 300)).toEqual([0, 0, 0, 0])
    expect(await pixel(1276, 934)).toEqual([0, 255, 0, 255])

    // Undo restores the exact pre-rotation pixels. History navigation reloads
    // the canvas and clears the floating selection (product behavior), so the
    // overlay must be hidden while the pixels revert.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    expect(await pixel(1180, 880)).toEqual([255, 0, 0, 255])
    expect(await pixel(1205, 880)).toEqual([0, 0, 255, 255])
    expect(await countOpaqueRed({ x: 1140, y: 815, width: 40, height: 30 })).toBeLessThanOrEqual(2)
    expect(await countSemiGreen({ x: 1145, y: 853, width: 22, height: 22 })).toBeGreaterThan(60)
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden', timeout: 10_000 })
    expect(await pixel(1276, 934)).toEqual([0, 255, 0, 255])
    // Redo must reapply byte-identical geometry: the vertical-bar strip and
    // the semi block match the post-rotate measurements exactly while the
    // overlay stays hidden (same product behavior as Undo).
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    expect(await countOpaqueRed({ x: 1140, y: 815, width: 40, height: 30 })).toBe(axisRed)
    expect(await countSemiGreen({ x: 1160, y: 858, width: 18, height: 20 })).toBe(semiAfter)
    expect((await pixel(1205, 880))[3]).toBeLessThanOrEqual(10)
    expect(await pixel(1276, 934)).toEqual([0, 255, 0, 255])
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden', timeout: 10_000 })
  }, 120_000)

  it('bitmap: Shift snaps a ~30-degree drag to 45 degrees with matching geometry', async () => {
    await ensureBitmapMode()
    // Back to the unrotated artwork, then reselect the same rect.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.keyboard.press('Escape').catch(() => {})
    await dragCanvas({ x: 1095, y: 845 }, { x: 1225, y: 915 })
    await page.getByTestId('bitmap-floating-rotate-handle').waitFor({ state: 'visible' })
    const resel = await selectionOverlayCanvas()
    const src2x = resel.x + resel.width / 2
    const src2y = resel.y + resel.height / 2
    expect(src2x).toBeCloseTo(1160, 0)
    expect(src2y).toBeCloseTo(874, 0)
    expect(await countSemiGreen({ x: 1145, y: 853, width: 22, height: 22 })).toBeGreaterThan(60)

    const handleBox = await page.getByTestId('bitmap-floating-rotate-handle').boundingBox()
    if (!handleBox) throw new Error('Missing rotate handle box')
    const handleStart = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
    const centerScreen = await toScreen(src2x, src2y)
    const radius = Math.hypot(handleStart.x - centerScreen.x, handleStart.y - centerScreen.y)
    // Free ~+30 degrees: start angle is ~-90 (north), so aim at -60 degrees.
    const freeAngle = (-60 * Math.PI) / 180
    const targetScreen = {
      x: centerScreen.x + radius * Math.cos(freeAngle),
      y: centerScreen.y + radius * Math.sin(freeAngle),
    }
    const freeDelta = dragDeltaDegrees(centerScreen, handleStart, targetScreen)
    expect(freeDelta).toBeGreaterThan(20)
    expect(freeDelta).toBeLessThan(40)
    // The band above the old bar holds no opaque red before the drag.
    expect(await countOpaqueRed({ x: 1100, y: 810, width: 130, height: 55 })).toBeLessThanOrEqual(2)

    // Manual drag so the live snapped readout can be asserted mid-gesture.
    const locator = page.getByTestId('bitmap-floating-rotate-handle')
    const box = await locator.boundingBox()
    if (!box) throw new Error('Missing handle for shift drag')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.keyboard.down('Shift')
    await page.mouse.move(targetScreen.x, targetScreen.y, { steps: 16 })
    await page.waitForFunction(
      () => document.body.textContent?.includes('Rotating bitmap selection (45°') ?? false,
      null,
      { timeout: 10_000 },
    )
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await waitForStatus('Bitmap selection rotated')

    // Snapped geometry for 45 degrees of the trimmed 120x32 patch:
    // ceil(120*cos45 + 32*sin45) = 108 square. A free 30-degree box would be
    // ~120x86, so the ~108 square distinguishes the snap.
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    const overlay = await selectionOverlayCanvas()
    expect(Math.abs(overlay.x + overlay.width / 2 - src2x)).toBeLessThanOrEqual(1)
    expect(Math.abs(overlay.y + overlay.height / 2 - src2y)).toBeLessThanOrEqual(1)
    expect(overlay.width).toBeGreaterThan(102)
    expect(overlay.width).toBeLessThan(118)
    expect(overlay.height).toBeGreaterThan(102)
    expect(overlay.height).toBeLessThan(118)
    expect(Math.abs(overlay.width - overlay.height)).toBeLessThanOrEqual(6)
    // Diagonal orientation: a 45-degree turn lays the horizontal bar on a
    // diagonal, so opaque red must appear in the band above the old bar.
    const diagonalRed = await countOpaqueRed({ x: 1100, y: 810, width: 130, height: 55 })
    expect(diagonalRed).toBeGreaterThan(60)
    // The semi block lands back inside the punched hole, keeping alpha.
    expect(await countSemiGreen({ x: 1155, y: 856, width: 18, height: 18 })).toBeGreaterThan(40)
    // Far artwork is still protected under the snapped stamp.
    expect(await pixel(1276, 934)).toEqual([0, 255, 0, 255])
    expect(await pixel(300, 300)).toEqual([0, 0, 0, 0])

    // Undo reverts the pixels and hides the selection; Redo must reapply
    // byte-identical snapped geometry.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    expect(await pixel(1180, 880)).toEqual([255, 0, 0, 255])
    expect(await pixel(1205, 880)).toEqual([0, 0, 255, 255])
    expect(await countOpaqueRed({ x: 1100, y: 810, width: 130, height: 55 })).toBeLessThanOrEqual(2)
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden', timeout: 10_000 })
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    expect(await countOpaqueRed({ x: 1100, y: 810, width: 130, height: 55 })).toBe(diagonalRed)
    expect(await pixel(1276, 934)).toEqual([0, 255, 0, 255])
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden', timeout: 10_000 })
  }, 120_000)

  it('vector: free ~90-degree handle drag swaps bounds, Shift snaps to 45 degrees, undo/redo restores SVG', async () => {
    await page.keyboard.press('Escape').catch(() => {})
    const toVector = page.getByRole('button', { name: 'ベクターに変換' })
    if ((await toVector.count()) > 0) await toVector.first().click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByTestId('vector-shape-rect').last().click()

    const surface = page.getByTestId('costume-paint-surface')
    const surfaceBox = await surface.boundingBox()
    if (!surfaceBox) throw new Error('Missing paint surface')
    // Asymmetric wide rect (non-square, so 90 degrees swaps w/h).
    const rectFrom = { x: surfaceBox.x + surfaceBox.width * 0.28, y: surfaceBox.y + surfaceBox.height * 0.42 }
    const rectTo = { x: surfaceBox.x + surfaceBox.width * 0.62, y: surfaceBox.y + surfaceBox.height * 0.54 }
    const svgBeforeDraw = await previewSvg()
    await page.mouse.move(rectFrom.x, rectFrom.y)
    await page.mouse.down()
    await page.mouse.move(rectTo.x, rectTo.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, svgBeforeDraw, {
      timeout: 15_000,
    })
    await page.getByTestId('vector-rotate-handle').waitFor({ state: 'visible', timeout: 15_000 })

    const svgBefore = await previewSvg()
    const boundsBefore = await boundsList(svgBefore)
    expect(boundsBefore.length).toBeGreaterThan(0)
    const targetBefore = boundsBefore[boundsBefore.length - 1]!
    expect(targetBefore.width).toBeGreaterThan(targetBefore.height + 10)
    const centerBefore = { x: targetBefore.x + targetBefore.width / 2, y: targetBefore.y + targetBefore.height / 2 }
    const transformsBefore = await vectorTransforms(svgBefore)
    const targetTransformBefore = transformsBefore[transformsBefore.length - 1]

    // Free drag to the east of the outline center (~+90 clockwise).
    const selectedOutline = page.locator('[data-vector-selection-outline].border-blue-500')
    await selectedOutline.first().waitFor({ state: 'attached', timeout: 10_000 })
    const outlineBox = await selectedOutline.first().boundingBox()
    if (!outlineBox) throw new Error('Missing selected vector outline')
    const outlineCenter = { x: outlineBox.x + outlineBox.width / 2, y: outlineBox.y + outlineBox.height / 2 }
    const handleBox = await page.getByTestId('vector-rotate-handle').boundingBox()
    if (!handleBox) throw new Error('Missing vector rotate handle')
    const handleStart = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
    const radius = Math.hypot(handleStart.x - outlineCenter.x, handleStart.y - outlineCenter.y)
    expect(radius).toBeGreaterThan(5)
    const targetScreen = { x: outlineCenter.x + radius, y: outlineCenter.y }
    const expectedDelta = dragDeltaDegrees(outlineCenter, handleStart, targetScreen)
    expect(expectedDelta).toBeGreaterThan(70)
    expect(expectedDelta).toBeLessThan(110)

    await dragHandleByScreen('vector-rotate-handle', targetScreen.x - handleStart.x, targetScreen.y - handleStart.y)
    await waitForStatus('Vector object rotated')

    const svgRotated = await previewSvg()
    expect(svgRotated).not.toBe(svgBefore)
    const boundsAfter = await boundsList(svgRotated)
    expect(boundsAfter.length).toBe(boundsBefore.length)
    // Only the rotated unit moves; every other unit keeps its bounds.
    let changedIndex = -1
    for (let i = 0; i < boundsAfter.length; i += 1) {
      const moved =
        Math.abs(boundsAfter[i]!.x - boundsBefore[i]!.x) > 2 ||
        Math.abs(boundsAfter[i]!.y - boundsBefore[i]!.y) > 2 ||
        Math.abs(boundsAfter[i]!.width - boundsBefore[i]!.width) > 2 ||
        Math.abs(boundsAfter[i]!.height - boundsBefore[i]!.height) > 2
      if (moved) {
        expect(changedIndex).toBe(-1)
        changedIndex = i
      }
    }
    expect(changedIndex).toBe(boundsAfter.length - 1)
    const targetAfter = boundsAfter[changedIndex]!
    const centerAfter = { x: targetAfter.x + targetAfter.width / 2, y: targetAfter.y + targetAfter.height / 2 }
    // Same shared center, swapped orientation: wide rect becomes tall.
    expect(centerAfter.x).toBeCloseTo(centerBefore.x, 0)
    expect(centerAfter.y).toBeCloseTo(centerBefore.y, 0)
    expect(targetAfter.height).toBeGreaterThan(targetAfter.width)
    expect(targetAfter.height).toBeCloseTo(targetBefore.width, 0)
    expect(targetAfter.width).toBeCloseTo(targetBefore.height, 0)
    // The world matrix on the unit encodes the same clockwise ~90 degrees.
    const transformsAfter = await vectorTransforms(svgRotated)
    const angle = matrixAngleDegrees(transformsAfter[changedIndex] ?? null)
    expect(angle).toBeDefined()
    expect(angle!).toBeGreaterThan(70)
    expect(angle!).toBeLessThan(110)

    // Single-entry history: Undo restores the exact SVG, Redo reapplies it.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, svgBefore, {
      timeout: 10_000,
    })
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, svgRotated, {
      timeout: 10_000,
    })
    void targetTransformBefore

    // Shift: a free ~30-degree drag must snap to exactly 45 degrees.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, svgBefore, {
      timeout: 10_000,
    })
    await page.getByTestId('vector-rotate-handle').waitFor({ state: 'visible' })
    const outlineBox2 = await page.locator('[data-vector-selection-outline].border-blue-500').first().boundingBox()
    if (!outlineBox2) throw new Error('Missing vector outline for shift drag')
    const outlineCenter2 = { x: outlineBox2.x + outlineBox2.width / 2, y: outlineBox2.y + outlineBox2.height / 2 }
    const handleBox2 = await page.getByTestId('vector-rotate-handle').boundingBox()
    if (!handleBox2) throw new Error('Missing vector handle for shift drag')
    const handleStart2 = { x: handleBox2.x + handleBox2.width / 2, y: handleBox2.y + handleBox2.height / 2 }
    const radius2 = Math.hypot(handleStart2.x - outlineCenter2.x, handleStart2.y - outlineCenter2.y)
    const freeAngle = (-60 * Math.PI) / 180
    const shiftTarget = {
      x: outlineCenter2.x + radius2 * Math.cos(freeAngle),
      y: outlineCenter2.y + radius2 * Math.sin(freeAngle),
    }
    const freeDelta = dragDeltaDegrees(outlineCenter2, handleStart2, shiftTarget)
    expect(freeDelta).toBeGreaterThan(20)
    expect(freeDelta).toBeLessThan(40)

    const vHandle = page.getByTestId('vector-rotate-handle')
    const vBox = await vHandle.boundingBox()
    if (!vBox) throw new Error('Missing vector handle box')
    await page.mouse.move(vBox.x + vBox.width / 2, vBox.y + vBox.height / 2)
    await page.mouse.down()
    await page.keyboard.down('Shift')
    await page.mouse.move(shiftTarget.x, shiftTarget.y, { steps: 16 })
    await page.waitForFunction(
      () => document.body.textContent?.includes('Rotating vector selection (45°') ?? false,
      null,
      { timeout: 10_000 },
    )
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await waitForStatus('Vector object rotated')

    const svgSnapped = await previewSvg()
    expect(svgSnapped).not.toBe(svgBefore)
    const boundsSnapped = await boundsList(svgSnapped)
    const targetSnapped = boundsSnapped[boundsSnapped.length - 1]!
    const centerSnapped = { x: targetSnapped.x + targetSnapped.width / 2, y: targetSnapped.y + targetSnapped.height / 2 }
    expect(centerSnapped.x).toBeCloseTo(centerBefore.x, 0)
    expect(centerSnapped.y).toBeCloseTo(centerBefore.y, 0)
    // 45 degrees of a wide rect: height grows a lot, width shrinks toward
    // the (w+h)*cos45 square instead of swapping axes like the 90-degree
    // turn above.
    expect(targetSnapped.height).toBeGreaterThan(targetBefore.height + 10)
    expect(targetSnapped.width).toBeLessThan(targetBefore.width)
    expect(Math.abs(targetSnapped.width - targetSnapped.height)).toBeLessThan(Math.max(8, targetSnapped.width * 0.15))
    const transformsSnapped = await vectorTransforms(svgSnapped)
    const snappedAngle = matrixAngleDegrees(transformsSnapped[transformsSnapped.length - 1] ?? null)
    expect(snappedAngle).toBeDefined()
    expect(Math.abs(snappedAngle! - 45)).toBeLessThanOrEqual(2)

    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, svgBefore, {
      timeout: 10_000,
    })
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, svgSnapped, {
      timeout: 10_000,
    })
  }, 120_000)
})
