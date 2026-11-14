import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real Editor/VM parity for the bitmap select marquee with the Paper zoom term.
//
// Reference (read-only, no third-party copy): `guides.js rectSelect` offsets
// both Paper corners by half a screen pixel (`0.5 / paperZoom`) and
// `selection-box-tool.js onMouseUpBitmap` rounds each normalized edge before
// clamping to ART_BOARD (960x720 at CENTER 480,360; raster 1:1, DOM inversion
// exact with no hidden 0.5). Production `bitmapMarqueeRect` applies the same
// half-screen offset in canvas px (`(0.5 / paperZoom) / k`, k = 2 for res1).
// At the res2 reset (UI "100%" = CSS 0.5, paperZoom 0.5) the offset is +1.0,
// so a drag of 99.6->109.4 quantizes to [101,101,9,9], not plain-round
// [100,100,9,9]. This suite drives the real costume surface (read/write real
// Chrome canvas + DOM boundingBox) and verifies pixel-exact selection,
// Undo/Redo single entries, clipboard copy/paste, and pointercancel.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4583'
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

async function realCssScale(): Promise<number> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  const size = await canvasSize()
  return box && size.width > 0 ? box.width / size.width : 0.5
}

async function zoomUiLabel(): Promise<string> {
  const label = await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')
  return (label as string).trim()
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

async function waitForPixel(x: number, y: number, expected: number[]) {
  await page.waitForFunction(
    ([px, py, want]) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
      return got.every((value, index) => value === (want as number[])[index]!)
    },
    [x, y, expected] as unknown as undefined,
    { timeout: 10_000 },
  )
}

async function waitForStatus(text: string) {
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout: 15_000 },
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

async function undoEnabled(): Promise<boolean> {
  return await page.locator('button[aria-label="Undo"]').first().isEnabled()
}

async function dispatchOnCanvas(type: string, init: Record<string, unknown>) {
  await page.evaluate(([eventType, pointer]: [string, Record<string, unknown>]) => {
    const target = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
    const rect = target.getBoundingClientRect()
    const x = rect.left + rect.width / 2 + (pointer.dx as number)
    const y = rect.top + rect.height / 2 + (pointer.dy as number)
    target.dispatchEvent(
      new PointerEvent(eventType, {
        pointerType: (pointer.pointerType as string) ?? 'pen',
        pointerId: pointer.pointerId as number,
        button: (pointer.button as number) ?? 0,
        buttons: (pointer.buttons as number) ?? 1,
        clientX: x,
        clientY: y,
        bubbles: true,
        composed: true,
        isPrimary: true,
      }),
    )
  }, [type, init] as unknown as undefined)
}

describe('bitmap marquee zoom parity on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4583', '--strictPort'], {
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
    if (await page.getByTestId('bitmap-editor-canvas').isHidden()) {
      await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    }
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('Paper +1.0 offset at reset selects pixel-exact, then Undo/Redo, clipboard, and pointercancel stay exact', async () => {
    // Reset to the res2 Paper reset: UI "100%" = CSS 0.5, paperZoom 0.5, offset +1.0.
    for (let i = 0; i < 15; i += 1) {
      const cur = await zoomUiLabel()
      if (cur.includes('100%')) break
      if (cur.includes('67%') || Number.parseFloat(cur) < 100) await page.getByRole('button', { name: 'Zoom in' }).click()
      else await page.getByRole('button', { name: 'Zoom out' }).click()
      await page.waitForTimeout(150)
    }
    expect(await zoomUiLabel()).toContain('100%')
    expect(Math.abs((await realCssScale()) - 0.5)).toBeLessThan(0.05)
    expect(await canvasSize()).toEqual({ width: 960, height: 720 })

    // Deterministic artwork via a real Chrome canvas write: single opaque red
    // pixel at (100,100); everything else transparent.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.clearRect(0, 0, target.width, target.height)
      const img = context.createImageData(1, 1)
      img.data[0] = 255
      img.data[1] = 0
      img.data[2] = 0
      img.data[3] = 255
      context.putImageData(img, 100, 100)
    })
    // Commit the setup through a real brush dot far away so the VM asset and
    // history include the artwork (evaluate painting alone never touches the store).
    await page.getByTestId('bitmap-tool-brush').click()
    const dot = await toScreen(700, 500)
    await page.mouse.move(dot.x, dot.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')
    expect(await pixel(100, 100)).toEqual([255, 0, 0, 255])

    await page.getByTestId('bitmap-tool-select').click()
    const undoBeforeMarquee = await undoEnabled()

    // Boundary: drag 99.6->109.4. Plain round would give [100,100,9,9] and
    // select (100,100); Paper +1.0 gives [101,101,9,9], so the trim is empty.
    await dragCanvas({ x: 99.6, y: 99.6 }, { x: 109.4, y: 109.4 })
    await page.waitForTimeout(500)
    expect(await page.locator('[data-testid="bitmap-selection"]').count()).toBe(0)
    expect(await undoEnabled()).toBe(undoBeforeMarquee)
    // Pixel exact: the sparse pixel is untouched.
    expect(await pixel(100, 100)).toEqual([255, 0, 0, 255])

    // Drag 98.6->100.7: +1.0 gives [100,100,2,2], trim isolates (100,100) 1x1.
    await dragCanvas({ x: 98.6, y: 98.6 }, { x: 100.7, y: 100.7 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await waitForSelectionSize(1, 1)
    expect(await undoEnabled()).toBe(undoBeforeMarquee)

    // Clipboard: copy then paste at the shared +10px stagger.
    await page.keyboard.press('Control+c')
    await waitForStatus('Bitmap selection copied')
    await page.keyboard.press('Control+v')
    await waitForStatus('Bitmap selection pasted')
    await waitForPixel(110, 110, [255, 0, 0, 255])
    expect(await pixel(110, 110)).toEqual([255, 0, 0, 255])
    expect(await pixel(100, 100)).toEqual([255, 0, 0, 255])
    // Single history entry: one Undo removes the paste.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(110, 110, [0, 0, 0, 0])
    expect(await pixel(110, 110)).toEqual([0, 0, 0, 0])
    expect(await pixel(100, 100)).toEqual([255, 0, 0, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(110, 110, [255, 0, 0, 255])
    expect(await pixel(110, 110)).toEqual([255, 0, 0, 255])

    // Cut: re-select (undo/redo reloads drop the outline), then Ctrl+X clears
    // exactly the selected pixel.
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    await dragCanvas({ x: 98.6, y: 98.6 }, { x: 100.7, y: 100.7 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await waitForSelectionSize(1, 1)
    await page.keyboard.press('Control+x')
    await waitForStatus('Bitmap selection cut')
    await waitForPixel(100, 100, [0, 0, 0, 0])
    expect(await pixel(100, 100)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(100, 100, [255, 0, 0, 255])
    expect(await pixel(100, 100)).toEqual([255, 0, 0, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(100, 100, [0, 0, 0, 0])
    expect(await pixel(100, 100)).toEqual([0, 0, 0, 0])
    // Restore for the cancel step.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(100, 100, [255, 0, 0, 255])

    // Pointercancel: a select-marquee drag cancelled the same way selects nothing.
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    const undoBeforeCancel = await undoEnabled()
    await page.getByTestId('bitmap-tool-select').click()
    await dispatchOnCanvas('pointerdown', { pointerId: 601, dx: -50, dy: -40 })
    await dispatchOnCanvas('pointermove', { pointerId: 601, dx: 50, dy: 40 })
    await page.waitForTimeout(300)
    await dispatchOnCanvas('pointercancel', { pointerId: 601, buttons: 0, dx: 50, dy: 40 })
    await page.waitForTimeout(400)
    expect(await page.locator('[data-testid="bitmap-selection"]').count()).toBe(0)
    expect(await undoEnabled()).toBe(undoBeforeCancel)
    expect(await pixel(100, 100)).toEqual([255, 0, 0, 255])
  }, 180_000)
})
