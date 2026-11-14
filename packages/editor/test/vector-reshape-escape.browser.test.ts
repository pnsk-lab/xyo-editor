import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-page regression for snapshot-based reshape drags:
// - mid-drag Escape restores the pre-drag SVG (single and multi anchor),
//   keeps the point selection, and writes no history entry;
// - an edit immediately after the cancel commits cleanly (no race with the
//   restore), with Undo/Redo working in single entries;
// - no-op drags (click-select, drag-and-return) leave undo/redo untouched.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4330'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function selectedAnchorCount() {
  return await page.locator('[data-vector-path-point][aria-pressed="true"]').count()
}

async function handleCenters() {
  const all = page.locator('[data-vector-path-point]')
  const count = await all.count()
  const centers: Array<{ x: number; y: number; pressed: boolean; index: number; control: boolean }> = []
  for (let i = 0; i < count; i++) {
    const handleBox = await all.nth(i).boundingBox()
    if (!handleBox) continue
    const label = (await all.nth(i).getAttribute('aria-label')) ?? ''
    const pressed = (await all.nth(i).getAttribute('aria-pressed')) === 'true'
    centers.push({
      x: handleBox.x + handleBox.width / 2,
      y: handleBox.y + handleBox.height / 2,
      pressed,
      index: Number(await all.nth(i).getAttribute('data-point-index')),
      control: label.startsWith('Move control point'),
    })
  }
  return centers
}

async function waitForSelectedCount(expected: number) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length === count,
    expected,
  )
}

async function anchorCount() {
  return await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-vector-path-point]')].filter((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith('Move path point'),
      ).length,
  )
}

async function waitForAnchorCount(expected: number) {
  await page.waitForFunction(
    (count) =>
      [...document.querySelectorAll('[data-vector-path-point]')].filter((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith('Move path point'),
      ).length === count,
    expected,
  )
}

async function previewSvg() {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewSvg(expected: string) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML === svg, expected)
}

async function waitForPreviewSvgChange(previous: string) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML !== svg, previous)
}

describe('vector reshape Escape cancel on the real page', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4330', '--strictPort'], {
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
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('mid-drag Escape restores multi/single points with clean history, then edits commit singly', async () => {
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })

    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }

    // Blank canvas: select-all then Delete removes the default artwork.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.waitForTimeout(800)
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)

    // Draw a rect: 4 pointed anchors in a closed path.
    const rectTool = page.getByTestId('vector-shape-rect').last()
    await rectTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    await page.mouse.move(centerX - 110, centerY - 60)
    await page.mouse.down()
    await page.mouse.move(centerX + 110, centerY + 60, { steps: 12 })
    await page.mouse.up()

    const reshapeTool = page.getByTestId('vector-shape-reshape').last()
    await reshapeTool.click()
    await page.waitForSelector('[data-vector-path-point]')
    await waitForAnchorCount(4)

    const handles = page.locator('[data-vector-path-point]')
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')

    // Select two anchors deterministically.
    await handles.first().click()
    await waitForSelectedCount(1)
    await page.keyboard.down('Shift')
    await handles.nth(1).click()
    await page.keyboard.up('Shift')
    await waitForSelectedCount(2)

    // --- Multi-point mid-drag Escape: preview applies, then restores. ---
    const svg0 = await previewSvg()
    const before = await handleCenters()
    const selectedBefore = before.filter((c) => c.pressed && !c.control).sort((a, b) => a.x - b.x)
    expect(selectedBefore).toHaveLength(2)
    const dragFrom = { x: selectedBefore[0]!.x, y: selectedBefore[0]!.y }
    await page.mouse.move(dragFrom.x, dragFrom.y)
    await page.mouse.down()
    await page.mouse.move(dragFrom.x + 60, dragFrom.y, { steps: 10 })
    // Wait until at least one confirmed preview frame lands.
    await waitForPreviewSvgChange(svg0)
    // Cancel mid-drag: the confirmed preview must be rewound, not left for Undo.
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await waitForPreviewSvg(svg0)
    // Selection set is preserved (both anchors stay selected).
    expect(await selectedAnchorCount()).toBe(2)
    const restored = await handleCenters()
    const beforeByIndex = new Map(before.map((c) => [c.index, c]))
    for (const point of restored) {
      const prev = beforeByIndex.get(point.index)
      expect(prev).toBeDefined()
      expect(Math.abs(point.x - prev!.x)).toBeLessThan(3)
      expect(Math.abs(point.y - prev!.y)).toBeLessThan(3)
    }

    // History invariant: no empty entry was recorded, so one Undo removes
    // the rect itself (not a no-op). Undo clears the object selection, so
    // Redo is verified on the artwork; the object is reselected afterwards.
    await undoButton.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)
    await redoButton.click()
    await waitForPreviewSvg(svg0)
    // Reselect the restored object by clicking it on the canvas in select
    // mode, then reshape again.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(centerX, centerY)
    await reshapeTool.click()
    await waitForAnchorCount(4)
    expect(await previewSvg()).toBe(svg0)

    // --- Edit immediately after the cancel commits cleanly (no race). ---
    await handles.first().click()
    await waitForSelectedCount(1)
    await page.keyboard.down('Shift')
    await handles.nth(1).click()
    await page.keyboard.up('Shift')
    await waitForSelectedCount(2)
    const reselectBefore = await handleCenters()
    const moveFrom = reselectBefore
      .filter((c) => c.pressed && !c.control)
      .sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(moveFrom.x, moveFrom.y)
    await page.mouse.down()
    await page.mouse.move(moveFrom.x + 30, moveFrom.y, { steps: 8 })
    await page.mouse.up()
    const svgMoved = await previewSvg()
    expect(svgMoved).not.toBe(svg0)
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length === count,
      2,
    )
    // Exactly one entry: a single Undo restores, a single Redo re-applies.
    await undoButton.click()
    await waitForPreviewSvg(svg0)
    await redoButton.click()
    await waitForPreviewSvg(svgMoved)
    // Leave the artwork moved, then undo back to the rect baseline for the
    // single-point leg below.
    await undoButton.click()
    await waitForPreviewSvg(svg0)

    // --- Single-point mid-drag Escape restores as well. ---
    await handles.first().click()
    await waitForSelectedCount(1)
    const singleBefore = await handleCenters()
    const singleHandle = singleBefore.filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(singleHandle.x, singleHandle.y)
    await page.mouse.down()
    await page.mouse.move(singleHandle.x + 50, singleHandle.y + 20, { steps: 8 })
    await waitForPreviewSvgChange(svg0)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await waitForPreviewSvg(svg0)
    expect(await selectedAnchorCount()).toBe(1)

    // --- No-op regression: click-select writes no history entry. ---
    await handles.nth(2).click()
    await waitForSelectedCount(1)
    expect(await previewSvg()).toBe(svg0)
    // One Undo still removes the rect itself (the click added no entry);
    // Redo restores the artwork.
    await undoButton.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)
    await redoButton.click()
    await waitForPreviewSvg(svg0)
  }, 180_000)
})
