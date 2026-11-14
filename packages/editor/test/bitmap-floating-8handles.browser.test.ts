import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor E2E for the bitmap 8-handle floating scale.
// Covers: NW/NE/SW/SE + N/S/E/W handles, corner default-uniform vs
// Shift-free, edge single-axis (Shift-independent), Alt-center, diagonal
// crossing mirror, Esc cancel (no history), single-entry Undo/Redo, and
// semi-transparent / other-pixel protection. Pixels are read from the live
// `bitmap-editor-canvas`. Uses its own Vite port (4277) so it never collides
// with other browser tests; launch via CHROME_BIN system Chrome.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4277'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

function handleTestId(handle: HandleId): string {
  return handle === 'se' ? 'bitmap-floating-scale-handle' : `bitmap-floating-scale-handle-${handle}`
}

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

async function dragHandle(
  handle: HandleId,
  dxCanvas: number,
  dyCanvas: number,
  options: { shift?: boolean; alt?: boolean; steps?: number } = {},
) {
  const locator = page.getByTestId(handleTestId(handle))
  await locator.waitFor({ state: 'visible' })
  const handleBox = await locator.boundingBox()
  if (!handleBox) throw new Error(`Missing handle ${handle}`)
  const canvasBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!canvasBox) throw new Error('Missing bitmap canvas')
  const size = await canvasSize()
  const dxScreen = (dxCanvas / size.width) * canvasBox.width
  const dyScreen = (dyCanvas / size.height) * canvasBox.height
  if (options.shift) await page.keyboard.down('Shift')
  if (options.alt) await page.keyboard.down('Alt')
  try {
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      handleBox.x + handleBox.width / 2 + dxScreen,
      handleBox.y + handleBox.height / 2 + dyScreen,
      { steps: options.steps ?? 12 },
    )
    await page.mouse.up()
  } finally {
    if (options.alt) await page.keyboard.up('Alt')
    if (options.shift) await page.keyboard.up('Shift')
  }
}

async function waitForPixel(x: number, y: number, expected: number[], tolerance = 2) {
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

async function waitForStatus(text: string) {
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout: 10_000 },
  )
}

async function waitForSelectionSize(width: number, height: number) {
  await page.waitForFunction(
    ([wantW, wantH]) => {
      const outline = document.querySelector('[data-testid="bitmap-selection"]')
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      if (!outline) return false
      const outlineBox = outline.getBoundingClientRect()
      const canvasBox = target.getBoundingClientRect()
      return (
        Math.abs(outlineBox.width - (canvasBox.width * (wantW as number)) / target.width) < 5 &&
        Math.abs(outlineBox.height - (canvasBox.height * (wantH as number)) / target.height) < 5
      )
    },
    [width, height] as unknown as undefined,
    { timeout: 10_000 },
  )
}

async function reselectBaseline() {
  await page.keyboard.press('Escape')
  await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' }).catch(() => {})
  await dragCanvas({ x: 425, y: 335 }, { x: 495, y: 375 })
  await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
  await waitForSelectionSize(60, 30)
}

describe('bitmap 8-handle scale on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4277', '--strictPort'], {
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

  it('scales from all 8 handles with modifiers, mirror, Esc, undo/redo, and pixel protection', async () => {
    const zoomOut = page.getByRole('button', { name: 'Zoom out' })
    for (let i = 0; i < 10; i += 1) await zoomOut.click()
    await page.waitForFunction(() => {
      const label = document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? ''
      return label.includes('25%')
    }, null, { timeout: 10_000 })

    // Deterministic artwork (artboard coords, 960x720 center 480,360): red 60x30
    // block with a transparent 10x10 hole holding one semi-transparent pixel,
    // plus a green marker that stays
    // outside most scaled rects to prove other pixels are protected.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.clearRect(0, 0, target.width, target.height)
      context.fillStyle = '#ff0000'
      context.fillRect(430, 340, 60, 30)
      context.clearRect(450, 348, 10, 10)
      context.fillStyle = 'rgba(255,0,0,0.5)'
      context.fillRect(451, 349, 1, 1)
      context.fillStyle = '#00ff00'
      context.fillRect(554, 392, 6, 6)
    })

    // Commit through a real brush dot so history exists; the dot at (400,400)
    // stays untouched by every scale below.
    await page.getByTestId('bitmap-tool-brush').click()
    const anchorHex = await page.getByLabel('Paint color', { exact: true }).inputValue()
    const anchorRgb = [0, 1, 2].map((i) => parseInt(anchorHex.slice(1 + i * 2, 3 + i * 2), 16))
    const anchor = await toScreen(400, 400)
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')
    await waitForPixel(400, 400, [...anchorRgb, 255], 8)

    await page.getByTestId('bitmap-tool-select').click()
    await dragCanvas({ x: 425, y: 335 }, { x: 495, y: 375 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await waitForSelectionSize(60, 30)

    // All 8 handles exist (SE keeps the legacy id).
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      await page.getByTestId(handleTestId(handle)).waitFor({ state: 'visible' })
    }
    expect(await page.locator('[data-bitmap-floating-handle]').count()).toBe(8)

    // 1. SE corner default-uniform 2x: (+30,+30) canvas -> 120x60 pinned at NW.
    await dragHandle('se', 30, 30)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(120, 60)
    // Scaled interior stays opaque red; hole center (now 20x20 at 470,896)
    // stays transparent; far pixels untouched.
    expect(await pixel(540, 390)).toEqual([255, 0, 0, 255])
    expect(await pixel(480, 365)).toEqual([0, 0, 0, 0])
    expect(await pixel(0, 0)).toEqual([0, 0, 0, 0])
    expect(await pixel(400, 400)).toEqual([...anchorRgb, 255])
    // Green marker at x=554 is just outside the 430..550 rect: protected.
    expect(await pixel(556, 394)).toEqual([0, 255, 0, 255])
    // Single-entry history: Undo peels the scale, Redo reapplies it.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    expect(await pixel(540, 390)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(540, 390, [255, 0, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 2. E edge single axis: (+30,0) -> 90x30 (height unchanged).
    await dragHandle('e', 30, 0)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(90, 30)
    expect(await pixel(510, 355)).toEqual([255, 0, 0, 255])
    expect(await pixel(556, 394)).toEqual([0, 255, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 3. W edge outward: (-30,0) -> 90x30 pinned at E (490,355).
    await dragHandle('w', -30, 0)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(90, 30)
    expect(await pixel(410, 355)).toEqual([255, 0, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 4. S edge: (0,+30) -> 60x60; N edge: (0,-15) -> 60x45.
    await dragHandle('s', 0, 30)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(60, 60)
    expect(await pixel(460, 390)).toEqual([255, 0, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()
    await dragHandle('n', 0, -15)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(60, 45)
    expect(await pixel(460, 335)).toEqual([255, 0, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 5. Remaining corners outward to 2x (120x60) with diagonal pinning.
    await dragHandle('nw', -30, -30)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(120, 60)
    expect(await pixel(380, 320)).toEqual([255, 0, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()
    await dragHandle('ne', 30, -30)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(120, 60)
    expect(await pixel(510, 320)).toEqual([255, 0, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()
    await dragHandle('sw', -30, 30)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(120, 60)
    expect(await pixel(380, 390)).toEqual([255, 0, 0, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 6. Corner Shift-free vs default-uniform on the same (+30,0) SE drag:
    // free stays 90x30, default grows to 90x45.
    await dragHandle('se', 30, 0, { shift: true })
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(90, 30)
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()
    await dragHandle('se', 30, 0)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(90, 45)
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 7. Edge ignores Shift: E (+30,0) with Shift is still 90x30.
    await dragHandle('e', 30, 0, { shift: true })
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(90, 30)
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 8. Alt-center: SE (+30,+15) with Alt -> 120x60 centered at (460,355),
    // so both sides grow: new NW (400,325) and SE fringe are red.
    await dragHandle('se', 30, 15, { alt: true })
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(120, 60)
    expect(await pixel(410, 335)).toEqual([255, 0, 0, 255])
    expect(await pixel(500, 375)).toEqual([255, 0, 0, 255])
    expect(await pixel(0, 0)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 9. Diagonal crossing mirror: SE past the NW pivot to (380,310)
    // (-50,-30) canvas -> same 60x30 size mirrored to (370,310).
    await dragHandle('se', -110, -60)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(60, 30)
    expect(await pixel(380, 320)).toEqual([255, 0, 0, 255])
    expect(await pixel(0, 0)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await reselectBaseline()

    // 10. Esc cancels a scale drag: preview appears, Escape discards it,
    // adds no history (next Undo still peels the earlier SE 2x entry).
    // First commit a scale to have a peelable entry.
    await dragHandle('se', 30, 30)
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(120, 60)
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    await dragCanvas({ x: 425, y: 335 }, { x: 555, y: 405 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await waitForSelectionSize(120, 60)
    const cancelHandle = page.getByTestId(handleTestId('se'))
    await cancelHandle.waitFor({ state: 'visible' })
    const cancelBox = await cancelHandle.boundingBox()
    if (!cancelBox) throw new Error('Missing SE handle for Esc')
    const canvasBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!canvasBox) throw new Error('Missing bitmap canvas')
    const size = await canvasSize()
    const escDx = (20 / size.width) * canvasBox.width
    const escDy = (20 / size.height) * canvasBox.height
    await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(cancelBox.x + cancelBox.width / 2 + escDx, cancelBox.y + cancelBox.height / 2 + escDy, { steps: 6 })
    await waitForPixel(570, 410, [255, 0, 0, 255])
    await page.keyboard.press('Escape')
    await waitForStatus('Selection cleared')
    await page.mouse.up()
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    // Preview discarded: the preview-only fringe is transparent again.
    expect(await pixel(570, 410)).toEqual([0, 0, 0, 0])
    expect(await pixel(540, 390)).toEqual([255, 0, 0, 255])
    // No phantom history entry: Undo still peels the committed 2x scale.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(440, 345, [255, 0, 0, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(540, 390, [255, 0, 0, 255])
  }, 240_000)
})
