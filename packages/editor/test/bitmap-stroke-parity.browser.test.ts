import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// UI-1 fail-first: bitmap stroke/outline fields vs reference.
//
// Reference (read from `.tmp/scratch-editor/...`, no code copied):
// - `paint-editor.jsx` bitmap branch shows the fill indicator only (no
//   stroke color/width); vector shows fill + stroke + stroke width.
// - `mode-tools.jsx` per-tool branches: brush/line share the brush slider,
//   rect/oval show Filled/Outlined plus thickness ONLY while outlined,
//   text shows the font dropdown only, fill shows nothing, eraser shows its
//   own size, select shows copy/paste/delete/flip.
//
// This drives the real editor and asserts exact visible/hidden per bitmap
// tool, the outlined-only Size semantics, width-state survival across modes,
// bitmap line/rect commits with Undo/Redo, a non-solid gradient commit
// (arbitrary alpha path), and the vector stroke regression (still visible).
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4380'
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByRole('application', { name: 'Costume paint canvas' }).waitFor({ state: 'visible' })
}

async function ensureBitmapMode() {
  if (!(await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible' })
}

async function pickBitmapTool(id: string) {
  await page.getByTestId(`bitmap-tool-${id}`).click()
}

async function strokeHidden(): Promise<void> {
  expect(await page.getByLabel('Stroke color', { exact: true }).count()).toBe(0)
  expect(await page.getByLabel('Stroke width', { exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Pick stroke color' }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Transparent stroke' }).count()).toBe(0)
  expect(await page.getByTestId('swap-stroke-colors').count()).toBe(0)
  // Compact toolbar: bitmap mode never renders the Outline swatch.
  expect(await page.getByTestId('outline-style').count()).toBe(0)
  expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
}

// Compact toolbar: Fill controls live in the anchored popover. Opening is
// idempotent; the dialog preserves the same fill behavior and history.
async function openFillPopover() {
  const dialog = page.getByTestId('fill-style-dialog')
  if (await dialog.isVisible().catch(() => false)) return
  await page.getByTestId('fill-style').click()
  await dialog.waitFor({ state: 'visible' })
}

async function openOutlinePopover() {
  const dialog = page.getByTestId('outline-style-dialog')
  if (await dialog.isVisible().catch(() => false)) return
  await page.getByTestId('outline-style').click()
  await dialog.waitFor({ state: 'visible' })
}

async function closePopovers() {
  for (let i = 0; i < 2; i += 1) {
    if ((await page.getByTestId('fill-style-dialog').count()) === 0 && (await page.getByTestId('outline-style-dialog').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
}

async function brushSliderVisible(): Promise<boolean> {
  return await page.getByRole('slider', { name: 'Brush size', exact: true }).isVisible().catch(() => false)
}

async function bitmapInkPixels(): Promise<number> {
  return await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!canvas) throw new Error('Missing bitmap canvas')
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! > 16) count += 1
    }
    return count
  })
}

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
  const rect = await canvasRectLive()
  const size = await canvasSize()
  const sx = rect.left + (x / size.width) * rect.width
  const sy = rect.top + (y / size.height) * rect.height
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px as number, py as number) as HTMLElement | null
    return el?.getAttribute?.('data-testid') ?? el?.tagName ?? 'NONE'
  }, [sx, sy] as unknown as undefined)
  if (hit !== 'bitmap-editor-canvas') {
    throw new Error(`elementFromPoint miss at canvas (${x},${y}): ${hit}`)
  }
  return { x: sx, y: sy }
}

async function dragBacking(from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = await toScreen(from.x, from.y)
  const b = await toScreen(to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

async function resetZoomAndSettle() {
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  await page.waitForFunction(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
  await page.waitForTimeout(400)
}

describe('bitmap stroke parity (UI-1, fail-first)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4380', '--strictPort'], {
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
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('hides every stroke control for all bitmap tools, keeps fill', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    for (const tool of ['select', 'brush', 'fill', 'text', 'line', 'rect', 'oval'] as const) {
      await pickBitmapTool(tool)
      await closePopovers()
      await strokeHidden()
      // Fill side stays (reference bitmap row shows fill only): trigger inline,
      // full controls in the Fill popover.
      expect(await page.getByTestId('fill-style').count()).toBe(1)
      await openFillPopover()
      expect(await page.getByLabel('Paint color', { exact: true }).count()).toBeGreaterThan(0)
      await closePopovers()
    }
    // Eraser replaces the whole row with its own size (reference parity).
    await pickBitmapTool('eraser')
    await strokeHidden()
    expect(await page.getByLabel('Eraser size', { exact: true }).first().isVisible()).toBe(true)
  }, 60_000)

  it('shows the Size slider only for brush/line and rect/oval while outlined', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    await pickBitmapTool('select')
    expect(await brushSliderVisible()).toBe(false)
    await pickBitmapTool('brush')
    expect(await brushSliderVisible()).toBe(true)
    await pickBitmapTool('fill')
    expect(await brushSliderVisible()).toBe(false)
    await pickBitmapTool('text')
    expect(await brushSliderVisible()).toBe(false)
    await pickBitmapTool('line')
    expect(await brushSliderVisible()).toBe(true)
    await pickBitmapTool('rect')
    await page.getByTestId('bitmap-shape-mode-filled').click()
    expect(await brushSliderVisible()).toBe(false)
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    expect(await brushSliderVisible()).toBe(true)
    await pickBitmapTool('oval')
    await page.getByTestId('bitmap-shape-mode-filled').click()
    expect(await brushSliderVisible()).toBe(false)
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    expect(await brushSliderVisible()).toBe(true)
    await pickBitmapTool('eraser')
    expect(await brushSliderVisible()).toBe(false)
  }, 60_000)

  it('keeps outlined width state across shape-mode and tool switches', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    await pickBitmapTool('brush')
    const slider = page.getByRole('slider', { name: 'Brush size', exact: true })
    await slider.fill('25')
    expect(await slider.inputValue()).toBe('25')
    await pickBitmapTool('rect')
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    expect(await page.getByRole('slider', { name: 'Brush size', exact: true }).inputValue()).toBe('25')
    // Filled hides the slider but must not reset the stored width.
    await page.getByTestId('bitmap-shape-mode-filled').click()
    expect(await brushSliderVisible()).toBe(false)
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    expect(await page.getByRole('slider', { name: 'Brush size', exact: true }).inputValue()).toBe('25')
    // A hidden stretch (select) also preserves the width.
    await pickBitmapTool('select')
    expect(await brushSliderVisible()).toBe(false)
    await pickBitmapTool('line')
    expect(await page.getByRole('slider', { name: 'Brush size', exact: true }).inputValue()).toBe('25')
  }, 60_000)

  it('bitmap line still commits ink with Undo/Redo', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    await resetZoomAndSettle()
    await pickBitmapTool('line')
    expect(await brushSliderVisible()).toBe(true)
    const before = await bitmapInkPixels()
    await dragBacking({ x: 300, y: 360 }, { x: 660, y: 360 })
    await page.waitForFunction((prev) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) count += 1
      return count > (prev as number)
    }, before, { timeout: 15_000 })
    const committed = await bitmapInkPixels()
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await page.waitForFunction((prev) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) count += 1
      return count < (prev as number)
    }, committed, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await page.waitForFunction((prev) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) count += 1
      return count >= (prev as number)
    }, committed, { timeout: 15_000 })
  }, 120_000)

  it('bitmap outlined rect still commits with Undo/Redo', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    await resetZoomAndSettle()
    await pickBitmapTool('rect')
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    expect(await brushSliderVisible()).toBe(true)
    const before = await bitmapInkPixels()
    await dragBacking({ x: 380, y: 260 }, { x: 580, y: 460 })
    await page.waitForFunction((prev) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) count += 1
      return count > (prev as number)
    }, before, { timeout: 15_000 })
    const committed = await bitmapInkPixels()
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await page.waitForFunction((prev) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) count += 1
      return count < (prev as number)
    }, committed, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await page.waitForFunction((prev) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) count += 1
      return count >= (prev as number)
    }, committed, { timeout: 15_000 })
  }, 120_000)

  it('bitmap gradient (arbitrary secondary alpha path) still commits', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    await resetZoomAndSettle()
    await pickBitmapTool('brush')
    await openFillPopover()
    await page.getByLabel('Bitmap paint style').selectOption('horizontal')
    await closePopovers()
    const before = await bitmapInkPixels()
    await dragBacking({ x: 300, y: 360 }, { x: 660, y: 360 })
    await page.waitForFunction((prev) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) count += 1
      return count > (prev as number)
    }, before, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await openFillPopover()
    await page.getByLabel('Bitmap paint style').selectOption('solid')
    await closePopovers()
  }, 120_000)

  it('vector still shows stroke controls (no regression)', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    expect(await page.getByTestId('outline-style').count()).toBeGreaterThan(0)
    await openOutlinePopover()
    expect(await page.getByLabel('Stroke color', { exact: true }).count()).toBeGreaterThan(0)
    expect(await page.getByLabel('Stroke width', { exact: true }).count()).toBeGreaterThan(0)
    expect(await page.getByTestId('swap-stroke-colors').count()).toBeGreaterThan(0)
    await closePopovers()
    // Fill trigger stays inline in the compact toolbar.
    expect(await page.getByTestId('fill-style').count()).toBeGreaterThan(0)
  }, 60_000)
})
