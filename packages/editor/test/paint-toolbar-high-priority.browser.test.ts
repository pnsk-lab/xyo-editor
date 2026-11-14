import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Fail-first coverage for the high-priority paint-toolbar gaps recorded in
// `docs/scratch-paint-toolbar-matrix.md` (T-1 brush size, T-3 stroke width, T-4
// fill/stroke disabled conditions).
//
// Reference behavior (read from `.tmp/scratch-editor/...`, no code copied):
// - vector brush has its OWN size 1..100 default 10 (`reducers/brush-mode.js`);
//   bitmap brush/line/outlined-contour share `bitBrushSize` default 10 with a
//   1..100 slider (`mode-tools.jsx` L111-L143, `reducers/bit-brush-size.js`).
// - vector stroke width is 0..100 (`reducers/stroke-width.js`
//   `MAX_STROKE_WIDTH = 100`, `stroke-width-indicator.jsx`).
// - stroke controls are disabled while BRUSH/TEXT/FILL is active and fill is
//   disabled while LINE is active (`containers/stroke-width-indicator.jsx`
//   L67-L70, `containers/stroke-color-indicator.jsx` L27-L29,
//   `containers/fill-color-indicator.jsx` L27).
//
// Every assertion below goes through screen-visible controls only (tool
// buttons and labeled inputs by accessible name, the paint surface by its
// `application` role, Undo/Redo by name). Size settings 10/24/25/100 are
// verified through true committed artwork (ink pixels / SVG geometry) plus an
// Undo/Redo round-trip, not just the input value. These tests FAIL against the
// current implementation (independent vector brush size missing, bitmap
// `max=24`, stroke `max=48`, no disabled conditions) and must pass once the
// reference-compatible toolbar lands. Product sources are untouched.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4284'
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByRole('application', { name: 'Costume paint canvas' }).waitFor({ state: 'visible' })
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible' })
}

async function ensureBitmapMode() {
  if (!(await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

async function ensureTransparentFill(off: boolean) {
  // The transparent toggle lives in the Fill popover (compact toolbar): open
  // it first; the popover preserves the same toggle behavior and history.
  await openFillPopover()
  const button = page.getByRole('button', { name: 'Transparent fill' })
  const pressed = (await button.getAttribute('aria-pressed')) === 'true'
  if (off && pressed) await button.click()
  if (!off && !pressed) await button.click()
}

// Compact toolbar: Fill/Outline controls live in anchored popovers. Opening
// is idempotent; a disabled trigger (fill disabled on LINE, stroke disabled
// on BRUSH/TEXT/FILL) stays closed, which is the reference `pointer-events:
// none` parity.
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

async function vectorObjectCount(): Promise<number> {
  return await page.evaluate(
    () => document.querySelectorAll('[data-vector-selection-outline]').length,
  )
}

async function blankVectorCanvas() {
  await page.getByRole('button', { name: 'Select', exact: true }).first().click()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const surface = page.getByRole('application', { name: 'Costume paint canvas' })
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + 20, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const del = page.getByRole('button', { name: 'Delete selection' }).first()
    if (await del.isEnabled().catch(() => false)) {
      await del.click()
      await page.waitForTimeout(600)
    }
    if ((await vectorObjectCount()) === 0) break
  }
  expect(await vectorObjectCount()).toBe(0)
}

async function setStrokeWidth(value: string) {
  const input = page.getByLabel('Stroke width', { exact: true }).first()
  await input.fill(value)
  await input.press('Tab')
}

async function drawVectorDrag(lengthPx = 60) {
  const surface = page.getByRole('application', { name: 'Costume paint canvas' })
  const box = await surface.boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x - lengthPx / 2, y)
  await page.mouse.down()
  await page.mouse.move(x + lengthPx / 2, y, { steps: 8 })
  await page.mouse.up()
}

async function lastVectorStrokeDiameter(): Promise<number> {
  return await page.evaluate(() => {
    const svg = document.querySelector('.vector-preview svg')
    if (!svg) throw new Error('Missing vector preview svg')
    const shapes = Array.from(svg.querySelectorAll('circle, path'))
    const last = shapes[shapes.length - 1]
    if (!last) throw new Error('No committed vector shape')
    if (last.tagName.toLowerCase() === 'circle') {
      return parseFloat(last.getAttribute('r') ?? '0') * 2
    }
    const bbox = (last as unknown as SVGGraphicsElement).getBBox()
    return bbox.height
  })
}

async function lastVectorStrokeWidthAttr(): Promise<number> {
  return await page.evaluate(() => {
    const svg = document.querySelector('.vector-preview svg')
    if (!svg) throw new Error('Missing vector preview svg')
    const stroked = Array.from(svg.querySelectorAll('[stroke-width]'))
    const last = stroked[stroked.length - 1]
    if (!last) throw new Error('No stroked vector shape')
    return parseFloat(last.getAttribute('stroke-width') ?? 'NaN')
  })
}

async function bitmapCenterColumnThickness(): Promise<number> {
  return await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!canvas) throw new Error('Missing bitmap canvas')
    const cx = Math.floor(canvas.width / 2)
    const column = canvas.getContext('2d')!.getImageData(cx, 0, 1, canvas.height).data
    let min = -1
    let max = -1
    for (let y = 0; y < canvas.height; y += 1) {
      if (column[y * 4 + 3]! > 127) {
        if (min < 0) min = y
        max = y
      }
    }
    return max >= 0 ? max - min + 1 : 0
  })
}

async function bitmapCenterAlpha(): Promise<number> {
  return await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!canvas) throw new Error('Missing bitmap canvas')
    return canvas
      .getContext('2d')!
      .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3]!
  })
}

async function drawBitmapStroke() {
  const canvas = page.getByTestId('bitmap-editor-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Missing bitmap canvas bounds')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x - 120, y)
  await page.mouse.down()
  await page.mouse.move(x + 120, y, { steps: 12 })
  await page.mouse.up()
}

describe('paint toolbar high-priority gaps (reference-compatible, fail-first)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4284', '--strictPort'], {
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

  it('G1 vector brush has an independent 1..100 size (default 10), not the stroke width', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    await page.getByRole('button', { name: 'Brush', exact: true }).click()
    // Reference: BRUSH shows its own size slider 1..100 defaulting to 10.
    const brushSize = page.getByRole('slider', { name: 'Brush size', exact: true })
    expect(await brushSize.isVisible()).toBe(true)
    expect(await brushSize.getAttribute('min')).toBe('1')
    expect(await brushSize.getAttribute('max')).toBe('100')
    expect(await brushSize.inputValue()).toBe('10')
    // Independence: with Stroke width at 4, a fresh brush stroke must still
    // be ~10px wide (today it follows the stroke width: ~4px). The width is
    // staged while Select is active: reference parity disables the stroke
    // side while Brush is active, so typing it under Brush is impossible.
    await blankVectorCanvas()
    await setStrokeWidth('4')
    await page.getByRole('button', { name: 'Brush', exact: true }).click()
    await openFillPopover()
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    await ensureTransparentFill(true)
    await page.keyboard.press('Escape')
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached' }).catch(() => undefined)
    const baseline = await vectorObjectCount()
    await drawVectorDrag(60)
    await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length > count, baseline, { timeout: 15_000 })
    const diameter = await lastVectorStrokeDiameter()
    expect(Math.abs(diameter - 10)).toBeLessThanOrEqual(3)
    // One stroke == one history entry.
    const committed = await vectorObjectCount()
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length === count, baseline, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length === count, committed, { timeout: 15_000 })
  }, 120_000)

  it('G2 bitmap brush/line size spans 1..100 with true ink for 10/24/25/100', async () => {
    for (const size of [10, 24, 25, 100]) {
      await gotoCostumes()
      await ensureVectorMode()
      await blankVectorCanvas()
      await ensureBitmapMode()
      await page.getByRole('button', { name: 'Brush', exact: true }).click()
      // Reference: shared bit-brush slider is 1..100 (default 10).
      const brushSize = page.getByRole('slider', { name: 'Brush size', exact: true })
      expect(await brushSize.isVisible()).toBe(true)
      expect(await brushSize.getAttribute('min')).toBe('1')
      expect(await brushSize.getAttribute('max')).toBe('100')
      await brushSize.fill(String(size))
      expect(await brushSize.inputValue()).toBe(String(size))
      await openFillPopover()
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
      await ensureTransparentFill(true)
      await page.keyboard.press('Escape')
      await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached' }).catch(() => undefined)
      await drawBitmapStroke()
      await page.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const data = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
        return data[3] === 255
      }, undefined, { timeout: 15_000 })
      // True ink: the vertical opaque run at the canvas center must equal the
      // requested brush diameter (today 25/100 clamp to 24).
      const thickness = await bitmapCenterColumnThickness()
      expect(Math.abs(thickness - size)).toBeLessThanOrEqual(Math.max(4, size * 0.15))
      // Undo removes the ink, redo restores it.
      await page.getByRole('button', { name: 'Undo' }).first().click()
      await page.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3] === 0
      }, undefined, { timeout: 15_000 })
      expect(await bitmapCenterAlpha()).toBe(0)
      await page.getByRole('button', { name: 'Redo' }).first().click()
      await page.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3] === 255
      }, undefined, { timeout: 15_000 })
      expect(await bitmapCenterAlpha()).toBe(255)
    }
  }, 240_000)

  it('G3 vector stroke width spans 0..100 with true width for 10/24/25/100', async () => {
    for (const size of [10, 24, 25, 100]) {
      await gotoCostumes()
      await ensureVectorMode()
      await blankVectorCanvas()
      const widthInput = page.getByLabel('Stroke width', { exact: true }).first()
      // Reference: stroke width slider range is 0..100.
      expect(await widthInput.getAttribute('min')).toBe('0')
      expect(await widthInput.getAttribute('max')).toBe('100')
      // Fill is staged while Select is active: reference parity disables the
      // fill side while Line is active (a line has no interior), so typing
      // it under Line is impossible.
      await openFillPopover()
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
      await ensureTransparentFill(true)
      // Compact popover floats over the left rail: close it (Escape preserves
      // paint/history) before targeting the toolbar rail button.
      await page.keyboard.press('Escape')
      await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached' })
      // The library ships a costume literally named "Line" (sr-only quick-add
      // button), so the role name is ambiguous: target the toolbar directly.
      await page.getByTestId('vector-shape-line').click()
      await setStrokeWidth(String(size))
      const baseline = await vectorObjectCount()
      await drawVectorDrag(120)
      await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length > count, baseline, { timeout: 15_000 })
      // Scratch parity: the committed line carries UI/2 (stored SVG is half
      // the toolbar Paper width; UI 1 would store 0.5 via the line floor).
      const committedWidth = await lastVectorStrokeWidthAttr()
      expect(Math.abs(committedWidth - size / 2)).toBeLessThanOrEqual(Math.max(1, (size / 2) * 0.05 + 0.5))
      const committed = await vectorObjectCount()
      await page.getByRole('button', { name: 'Undo' }).first().click()
      await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length === count, baseline, { timeout: 15_000 })
      await page.getByRole('button', { name: 'Redo' }).first().click()
      await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length === count, committed, { timeout: 15_000 })
      expect(await lastVectorStrokeWidthAttr()).toBeCloseTo(size / 2, 0)
    }
  }, 240_000)

  it('G4 stroke is disabled in brush/fill mode and fill is disabled in line mode', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    const strokeWidth = page.getByLabel('Stroke width', { exact: true }).first()
    // Compact toolbar: the stroke/fill inputs live in the Outline/Fill
    // popovers. A disabled side keeps its swatch trigger disabled and the
    // dialog unreachable (reference `pointer-events: none` parity), so assert
    // the trigger state plus dialog absence instead of the hidden inputs.
    // Reference: BRUSH disables the stroke side (brush uses its own size).
    await page.getByRole('button', { name: 'Brush', exact: true }).click()
    expect(await strokeWidth.isDisabled()).toBe(true)
    expect(await page.getByTestId('outline-style').isDisabled()).toBe(true)
    expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
    // Reference: FILL disables the stroke side as well.
    await page.getByRole('button', { name: 'Fill', exact: true }).click()
    expect(await strokeWidth.isDisabled()).toBe(true)
    expect(await page.getByTestId('outline-style').isDisabled()).toBe(true)
    expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
    // Reference: LINE disables the fill side (a line has no interior). The
    // library "Line" costume makes the role name ambiguous: use the testid.
    await page.getByTestId('vector-shape-line').click()
    expect(await page.getByTestId('fill-style').isDisabled()).toBe(true)
    expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
  }, 120_000)
})
