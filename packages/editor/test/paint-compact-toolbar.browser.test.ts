import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Compact paint toolbar (Scratch parity layout): the Fill/Outline swatches stay
// inline in one short bar while HSV/alpha/gradient/transparent/eyedropper/swap
// live in anchored popovers. Real-Chromium coverage for the visual goal:
// - closed toolbar height < 110px at 1104px wide, no canvas overlap, no
//   horizontal overflow (also at a narrow 700px width);
// - dark theme toolbar; canvas geometry unchanged by opening/closing popovers;
// - popovers open anchored with full controls, close on Escape/outside,
//   focus returns to the trigger, keyboard operable;
// - paint + Undo/Redo still round-trip through the popover color path.
const root = join(import.meta.dir, '..')
const PORT = 4291
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  const tab = page.getByTestId('main-tab-costumes')
  await tab.waitFor({ state: 'visible' })
  await tab.click()
  await page.getByRole('application', { name: 'Costume paint canvas' }).waitFor({ state: 'visible' })
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').first().waitFor({ state: 'visible' })
}

async function ensureBitmapMode() {
  if (!(await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

async function toolbarHeight(): Promise<number> {
  const box = await page.getByTestId('paint-toolbar').boundingBox()
  if (!box) throw new Error('Missing paint toolbar bounds')
  return box.height
}

async function toolbarAndCanvasBoxes() {
  return await page.evaluate(() => {
    const toolbar = document.querySelector('[data-testid="paint-toolbar"]')?.getBoundingClientRect()
    const canvas = document.querySelector('[data-testid="costume-paint-surface"]')?.getBoundingClientRect()
    if (!toolbar || !canvas) throw new Error('Missing toolbar/canvas')
    return {
      toolbar: { bottom: toolbar.bottom, height: toolbar.height },
      canvas: { top: canvas.top, x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height },
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }
  })
}

async function vectorObjectCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-vector-selection-outline]').length)
}

describe('paint compact toolbar (popover layout)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
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
    page = await browser.newPage({ viewport: { width: 1104, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('keeps the closed toolbar under 110px with no canvas overlap or page overflow', async () => {
    await gotoCostumes()
    for (const mode of ['vector', 'bitmap'] as const) {
      if (mode === 'vector') await ensureVectorMode()
      else await ensureBitmapMode()
      // Popovers start closed: full controls hidden, swatches inline.
      expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
      const height = await toolbarHeight()
      expect(height).toBeLessThan(110)
      const boxes = await toolbarAndCanvasBoxes()
      // No Canvas overlapping: the toolbar ends above the paint surface.
      expect(boxes.toolbar.bottom).toBeLessThanOrEqual(boxes.canvas.top + 1)
      // No horizontal overflow at the 1104px goal width.
      expect(boxes.docScrollWidth).toBeLessThanOrEqual(boxes.innerWidth + 1)
      await page.screenshot({ path: `/tmp/paint-compact-toolbar-${mode}-1104.png` })
    }
  }, 120_000)

  it('stays overflow-free at a narrow 700px width', async () => {
    // Navigate at the standard width first (the app tab bar is only
    // clickable there), then shrink: shrinking must not create page-level
    // horizontal overflow or push the toolbar over the canvas.
    await gotoCostumes()
    await ensureVectorMode()
    await page.setViewportSize({ width: 700, height: 800 })
    try {
      await page.getByTestId('paint-toolbar').waitFor({ state: 'visible' })
      expect(await toolbarHeight()).toBeLessThan(110)
      const boxes = await toolbarAndCanvasBoxes()
      expect(boxes.docScrollWidth).toBeLessThanOrEqual(boxes.innerWidth + 1)
      expect(boxes.toolbar.bottom).toBeLessThanOrEqual(boxes.canvas.top + 1)
      await page.screenshot({ path: '/tmp/paint-compact-toolbar-vector-700.png' })
    } finally {
      await page.setViewportSize({ width: 1104, height: 800 })
    }
  }, 120_000)

  it('uses a dark toolbar and keeps canvas geometry stable across popovers', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    const luminance = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-testid="paint-toolbar"]')
      if (!toolbar) throw new Error('Missing toolbar')
      const bg = getComputedStyle(toolbar).backgroundColor
      // Chrome reports Tailwind v4 colors as oklch(): lightness 0..1 is the
      // first component. Fall back to sRGB luminance for rgb() strings.
      const oklch = /oklch\(\s*([\d.]+)/.exec(bg)?.[1]
      if (oklch !== undefined) return Number(oklch)
      const rgb = bg.match(/\d+/g)?.map(Number) ?? [255, 255, 255]
      return (0.2126 * (rgb[0] ?? 255) + 0.7152 * (rgb[1] ?? 255) + 0.0722 * (rgb[2] ?? 255)) / 255
    })
    expect(luminance).toBeLessThan(0.35)
    const before = await toolbarAndCanvasBoxes()
    await page.getByTestId('fill-style').click()
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'visible' })
    const during = await toolbarAndCanvasBoxes()
    // The anchored dialog floats: canvas geometry must not shift while open.
    expect(Math.abs(during.canvas.x - before.canvas.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(during.canvas.y - before.canvas.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(during.canvas.width - before.canvas.width)).toBeLessThanOrEqual(1)
    await page.keyboard.press('Escape')
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached' })
    const after = await toolbarAndCanvasBoxes()
    expect(Math.abs(after.canvas.width - before.canvas.width)).toBeLessThanOrEqual(1)
  }, 120_000)

  it('opens the Fill popover with all controls, closes on Escape/outside with focus return', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    await page.getByRole('button', { name: 'Brush', exact: true }).click()
    // Keyboard: focus the swatch and open with Enter.
    await page.getByTestId('fill-style').focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('fill-style-dialog')
    await dialog.waitFor({ state: 'visible' })
    expect(await dialog.getAttribute('role')).toBe('dialog')
    // Every retained capability is reachable in the popover.
    for (const name of ['Paint color', 'Fill hue', 'Fill saturation', 'Fill brightness', 'Transparent fill', 'Pick fill color', 'Vector paint style', 'Swap fill colors'] as const) {
      expect(await page.getByLabel(name, { exact: true }).count()).toBeGreaterThan(0)
    }
    await page.screenshot({ path: '/tmp/paint-compact-toolbar-fill-open.png' })
    // Escape closes and returns focus to the trigger.
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('fill-style')
    // Outside click closes: reopen, then switch to the Outline swatch (only
    // one dialog at a time). BRUSH disables the stroke side (reference
    // parity), so switch to Select first where both sides are enabled.
    await page.getByRole('button', { name: 'Select', exact: true }).first().click()
    await page.getByTestId('outline-style').click()
    await page.getByTestId('outline-style-dialog').waitFor({ state: 'visible' })
    expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
    expect(await page.getByTestId('outline-style-dialog').getAttribute('role')).toBe('dialog')
    await page.keyboard.press('Escape')
  }, 120_000)

  it('paints through the popover color and round-trips Undo/Redo', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    await page.getByRole('button', { name: 'Brush', exact: true }).click()
    await page.getByTestId('fill-style').click()
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'visible' })
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    const transparent = page.getByRole('button', { name: 'Transparent fill' })
    if ((await transparent.getAttribute('aria-pressed')) === 'true') await transparent.click()
    await page.keyboard.press('Escape')
    // Blank the canvas first (marquee + Delete, like the high-priority
    // suite) so the new stroke is the only object: deterministic baseline 0.
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
    await page.getByRole('button', { name: 'Brush', exact: true }).click()
    const baseline = await vectorObjectCount()
    const surface = page.getByRole('application', { name: 'Costume paint canvas' })
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x - 30, y)
    await page.mouse.down()
    await page.mouse.move(x + 30, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length > count, baseline, { timeout: 15_000 })
    const committed = await vectorObjectCount()
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length === count, baseline, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await page.waitForFunction((count) => document.querySelectorAll('[data-vector-selection-outline]').length === count, committed, { timeout: 15_000 })
  }, 120_000)
})
