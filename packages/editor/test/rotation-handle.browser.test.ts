import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor E2E for the selection rotation handles (both modes).
// Bitmap: arbitrary-angle drag of the floating rotation handle around the
// selection center (Shift snaps to 45 degrees), live preview from the start
// snapshot, Esc cancel without history, and single-entry Undo/Redo.
// Vector: rotation handle above the single-selection bounds with the same
// Shift snapping and single-entry Undo/Redo.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4281'
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
  const a = await toScreen(from.x, from.y)
  const b = await toScreen(to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

async function dragHandleByScreen(testId: string, dxScreen: number, dyScreen: number, options: { shift?: boolean; steps?: number } = {}) {
  const locator = page.getByTestId(testId)
  await locator.waitFor({ state: 'visible' })
  // Hover first: ensures the handle is actionable (scrolled into view,
  // receiving hit-tests) instead of clicking through an overlay.
  await locator.hover({ trial: false })
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

async function dragHandleOutAndBack(testId: string, dxScreen: number, dyScreen: number, steps = 10) {
  const locator = page.getByTestId(testId)
  await locator.waitFor({ state: 'visible' })
  await locator.hover({ trial: false })
  const box = await locator.boundingBox()
  if (!box) throw new Error(`Missing handle ${testId}`)
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  await page.mouse.move(centerX, centerY)
  await page.mouse.down()
  // Rotate out to a non-zero delta (preview applies), then back to the start
  // point in the same gesture so the final delta is ~0. A correct
  // implementation commits nothing for this gesture.
  await page.mouse.move(centerX + dxScreen, centerY + dyScreen, { steps })
  await page.mouse.move(centerX, centerY, { steps })
  await page.mouse.up()
}

async function waitForStatus(text: string) {
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout: 10_000 },
  )
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

describe('rotation handles on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4281', '--strictPort'], {
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

  it('rotates the bitmap selection free + Shift-snapped with Esc and single-entry undo/redo', async () => {
    const zoomOut = page.getByRole('button', { name: 'Zoom out' })
    for (let i = 0; i < 10; i += 1) await zoomOut.click()

    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.clearRect(0, 0, target.width, target.height)
      context.fillStyle = '#ff0000'
      context.fillRect(1150, 880, 60, 30)
      context.fillStyle = '#00ff00'
      context.fillRect(1274, 932, 6, 6)
    })
    await page.getByTestId('bitmap-tool-brush').click()
    const anchor = await toScreen(400, 400)
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')

    await page.getByTestId('bitmap-tool-select').click()
    await dragCanvas({ x: 1145, y: 875 }, { x: 1215, y: 915 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await page.getByTestId('bitmap-floating-rotate-handle').waitFor({ state: 'visible' })

    // Eyedropper owns the canvas while active: the handle hides and no drag
    // can start from it; Escape restores the handle without touching pixels.
    await page.getByTestId('eyedropper-fill').click()
    await page.getByTestId('bitmap-floating-rotate-handle').waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-floating-rotate-handle').waitFor({ state: 'visible' })
    expect(await pixel(1160, 885)).toEqual([255, 0, 0, 255])

    // Esc cancel: press the handle, move, then Escape restores without history.
    const rotateBox = await page.getByTestId('bitmap-floating-rotate-handle').boundingBox()
    if (!rotateBox) throw new Error('Missing rotate handle box')
    await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(rotateBox.x + rotateBox.width / 2 + 70, rotateBox.y + rotateBox.height / 2 + 10, { steps: 10 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await waitForStatus('Selection cleared')
    // Selection is gone after Esc; reselect the untouched red block.
    await dragCanvas({ x: 1145, y: 875 }, { x: 1215, y: 915 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    expect(await pixel(1160, 885)).toEqual([255, 0, 0, 255])

    // Free arbitrary-angle drag commits one history entry.
    await dragHandleByScreen('bitmap-floating-rotate-handle', 70, 10)
    await waitForStatus('Bitmap selection rotated')
    // Center of the rotated patch still covers red (opaque, not erased).
    const centerPixel = await pixel(1180, 895)
    expect(centerPixel[3]).toBe(255)
    expect(centerPixel[0]).toBeGreaterThan(150)
    // Green marker far outside stays protected.
    expect(await pixel(1276, 934)).toEqual([0, 255, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(1160, 885, [255, 0, 0, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')

    // Shift-snapped drag also commits exactly one entry.
    await page.keyboard.press('Escape').catch(() => {})
    await dragCanvas({ x: 1145, y: 875 }, { x: 1215, y: 915 })
    await page.getByTestId('bitmap-floating-rotate-handle').waitFor({ state: 'visible' })
    await dragHandleByScreen('bitmap-floating-rotate-handle', 70, 10, { shift: true })
    await waitForStatus('Bitmap selection rotated')
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(1160, 885, [255, 0, 0, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
  }, 120_000)

  it('rotates the vector selection with the handle and single-entry undo/redo', async () => {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.getByRole('button', { name: 'Rectangle', exact: true }).first().click()
    // Draw a vector rect by dragging across the paint surface.
    const surface = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!surface) throw new Error('Missing paint surface')
    await page.mouse.move(surface.x + surface.width * 0.35, surface.y + surface.height * 0.4)
    await page.mouse.down()
    await page.mouse.move(surface.x + surface.width * 0.55, surface.y + surface.height * 0.6, { steps: 12 })
    await page.mouse.up()
    await page.getByTestId('vector-rotate-handle').waitFor({ state: 'visible', timeout: 15_000 })

    await dragHandleByScreen('vector-rotate-handle', 60, 20)
    await waitForStatus('Vector object rotated')
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
  }, 120_000)

  it('leaves no empty undo when a vector rotation returns to the start angle', async () => {
    // Self-contained: ensure vector mode, then draw a fresh rect so the test
    // does not depend on earlier tests. An out-and-back gesture in a single
    // drag must commit nothing: the status stays "no change" instead of
    // "rotated", so no empty Undo entry is left behind.
    await page.getByRole('button', { name: 'ベクターに変換' }).click().catch(() => {})
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await page.getByTestId('vector-shape-select').click().catch(() => {})
    await page.getByRole('button', { name: 'Rectangle', exact: true }).first().click()
    {
      const surface = await page.getByTestId('costume-paint-surface').boundingBox()
      if (!surface) throw new Error('Missing paint surface')
      await page.mouse.move(surface.x + surface.width * 0.3, surface.y + surface.height * 0.35)
      await page.mouse.down()
      await page.mouse.move(surface.x + surface.width * 0.5, surface.y + surface.height * 0.55, { steps: 12 })
      await page.mouse.up()
    }
    await page.getByTestId('vector-rotate-handle').waitFor({ state: 'visible', timeout: 15_000 })
    await dragHandleOutAndBack('vector-rotate-handle', 70, 25)
    await waitForStatus('Vector rotate: no change')

    // A following real rotation still commits exactly one entry: Undo reverts
    // it and Redo reapplies it, proving the no-op above added nothing.
    await dragHandleByScreen('vector-rotate-handle', 60, 20)
    await waitForStatus('Vector object rotated')
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    // Revert the single rotation so the first rect is axis-aligned again:
    // otherwise its rotated bounds blow up the shared multi bounds below
    // and push the multi handle off-screen.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')

    // Multi-selection shares the same deferred history: draw a second rect
    // overlapping the first (keeps the shared bounds tight and the handle
    // on-screen), select both, and return to the start angle without history.
    await page.getByRole('button', { name: 'Rectangle', exact: true }).first().click()
    {
      const surface = await page.getByTestId('costume-paint-surface').boundingBox()
      if (!surface) throw new Error('Missing paint surface')
      await page.mouse.move(surface.x + surface.width * 0.42, surface.y + surface.height * 0.45)
      await page.mouse.down()
      await page.mouse.move(surface.x + surface.width * 0.6, surface.y + surface.height * 0.62, { steps: 12 })
      await page.mouse.up()
    }
    await page.getByTestId('vector-shape-select').click()
    {
      // Select only the two fresh rects (Shift-click appends): Ctrl+A would
      // also grab the converted bitmap <image> underneath and blow up the
      // shared bounds so the handle leaves the viewport.
      const surface = await page.getByTestId('costume-paint-surface').boundingBox()
      if (!surface) throw new Error('Missing paint surface')
      await page.mouse.click(surface.x + surface.width * 0.35, surface.y + surface.height * 0.4)
      await page.keyboard.down('Shift')
      await page.mouse.click(surface.x + surface.width * 0.57, surface.y + surface.height * 0.6)
      await page.keyboard.up('Shift')
    }
    await page.getByTestId('vector-rotate-handle-multi').waitFor({ state: 'visible', timeout: 15_000 })
    await dragHandleOutAndBack('vector-rotate-handle-multi', 70, 25)
    await waitForStatus('Vector rotate: no change')
    // A real multi rotation commits one entry for the shared bounds.
    await dragHandleByScreen('vector-rotate-handle-multi', 60, 20)
    await waitForStatus('Vector objects rotated')
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
  }, 120_000)

  it('keeps undo/redo intact when an immediate edit follows a vector Esc cancel', async () => {
    // Self-contained single-rect flow (avoids the large rotated multi bounds
    // above): draw a fresh rect so the handle starts on-screen.
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await page.getByTestId('vector-shape-select').click().catch(() => {})
    await page.getByRole('button', { name: 'Rectangle', exact: true }).first().click()
    {
      const surface = await page.getByTestId('costume-paint-surface').boundingBox()
      if (!surface) throw new Error('Missing paint surface')
      await page.mouse.move(surface.x + surface.width * 0.3, surface.y + surface.height * 0.35)
      await page.mouse.down()
      await page.mouse.move(surface.x + surface.width * 0.5, surface.y + surface.height * 0.55, { steps: 12 })
      await page.mouse.up()
    }
    const handleId = 'vector-rotate-handle'
    await page.getByTestId(handleId).waitFor({ state: 'visible', timeout: 15_000 })

    // Commit one rotation so Undo leaves a redo entry behind.
    await dragHandleByScreen(handleId, 55, 18)
    await waitForStatus(handleId === 'vector-rotate-handle-multi' ? 'Vector objects rotated' : 'Vector object rotated')
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')

    // Start a new rotation and cancel it with Esc mid-gesture, then fire Redo
    // immediately without waiting for the cancel restore to settle. The
    // restore must not delete the redo entry and must not race the Redo.
    const box = await page.getByTestId(handleId).boundingBox()
    if (!box) throw new Error('Missing vector rotate handle for Esc test')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 18, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    // Immediate Redo: no `waitForStatus('Selection cleared')` gap on purpose.
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    // The cancelled gesture added nothing: one Undo reverts the Redo above.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
  }, 120_000)

  it('leaves no empty undo when a bitmap rotation returns to the start angle', async () => {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    const zoomOut = page.getByRole('button', { name: 'Zoom out' })
    for (let i = 0; i < 10; i += 1) await zoomOut.click().catch(() => {})
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.clearRect(0, 0, target.width, target.height)
      context.fillStyle = '#0000ff'
      context.fillRect(1150, 880, 60, 30)
    })
    await page.getByTestId('bitmap-tool-brush').click()
    const anchor = await toScreen(400, 400)
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')
    await page.getByTestId('bitmap-tool-select').click()
    await dragCanvas({ x: 1145, y: 875 }, { x: 1215, y: 915 })
    await page.getByTestId('bitmap-floating-rotate-handle').waitFor({ state: 'visible' })

    // Out-and-back in one gesture: no history, selection kept, pixels intact.
    await dragHandleOutAndBack('bitmap-floating-rotate-handle', 70, 10)
    await waitForStatus('Bitmap selection kept')
    expect(await pixel(1160, 885)).toEqual([0, 0, 255, 255])

    // A following real rotation still commits exactly one entry.
    await dragHandleByScreen('bitmap-floating-rotate-handle', 70, 10)
    await waitForStatus('Bitmap selection rotated')
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(1160, 885, [0, 0, 255, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
  }, 120_000)
})
