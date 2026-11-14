import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-page wiring for the multi-point reshape selection:
// - Shift+click toggles anchors in/out (plain click replaces)
// - blank drag marquees anchors (plain replaces, Shift toggles)
// - dragging a selected anchor moves the whole selection rigidly (one history)
// - Curved/Pointed apply to the whole selection (one history)
// - Delete removes the whole selection (one history, minimum-segments safe)
// - click-select without a move writes no history entry
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4329'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function selectedAnchorCount() {
  // Paper truth: selected handles also report pressed, so anchor selection
  // filters to Move path point (point bit); handles are asserted separately.
  return await page.locator('[data-vector-path-point][aria-label^="Move path point"][aria-pressed="true"]').count()
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
    (count) => [...document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]')].filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length === count,
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

describe('vector reshape multi-point selection on the real page', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4329', '--strictPort'], {
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

  it('shift-toggle, point marquee, bulk move/style/delete with single undo entries', async () => {
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })

    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }

    // Start from a blank canvas: select-all then Delete removes the default
    // artwork, so marquees never hit unrelated shapes mid-test.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.waitForTimeout(800)
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)

    // Draw a rect via real drag: 4 pointed anchors in a closed path.
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
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-path-point]').length === 4,
    )
    expect(await selectedAnchorCount()).toBe(0)

    const handles = page.locator('[data-vector-path-point]')

    // Plain click selects one anchor; Shift+click adds a second.
    await handles.first().click()
    await waitForSelectedCount(1)
    await page.keyboard.down('Shift')
    await handles.nth(1).click()
    await page.keyboard.up('Shift')
    await waitForSelectedCount(2)
    // Shift+click on a selected anchor toggles it back out.
    await page.keyboard.down('Shift')
    await handles.first().click()
    await page.keyboard.up('Shift')
    await waitForSelectedCount(1)

    // Re-add one anchor so the marquee toggle test starts from two selected.
    await page.keyboard.down('Shift')
    await handles.first().click()
    await page.keyboard.up('Shift')
    await waitForSelectedCount(2)

    // Shift+marquee over all four toggles each matched anchor: the two
    // selected ones drop out, the other two come in (count stays 2, set flips).
    async function pressedPointIndices() {
      return await page.evaluate(() =>
        [...document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]')].map(
          (el) => Number((el as HTMLElement).dataset.pointIndex),
        ).sort((a, b) => a - b),
      )
    }
    {
      const beforeToggle = await pressedPointIndices()
      expect(beforeToggle).toHaveLength(2)
      const centers = await handleCenters()
      const xs = centers.map((c) => c.x)
      const ys = centers.map((c) => c.y)
      await page.keyboard.down('Shift')
      await page.mouse.move(Math.min(...xs) - 60, Math.min(...ys) - 60)
      await page.mouse.down()
      await page.mouse.move(Math.max(...xs) + 60, Math.max(...ys) + 60, { steps: 12 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await waitForSelectedCount(2)
      const afterToggle = await pressedPointIndices()
      expect(afterToggle).toHaveLength(2)
      expect(afterToggle).not.toEqual(beforeToggle)
      expect(afterToggle.every((index) => !beforeToggle.includes(index))).toBe(true)
    }

    // Plain all-marquee replaces back to all four.
    {
      const centers = await handleCenters()
      const xs = centers.map((c) => c.x)
      const ys = centers.map((c) => c.y)
      await page.mouse.move(Math.min(...xs) - 60, Math.min(...ys) - 60)
      await page.mouse.down()
      await page.mouse.move(Math.max(...xs) + 60, Math.max(...ys) + 60, { steps: 12 })
      await page.mouse.up()
    }
    await waitForSelectedCount(4)
    expect(await page.getByTestId('delete-reshape-point').textContent()).toBe('Delete 4 points')

    // Shift+drag over an empty area matches nothing: selection is unchanged.
    {
      const centers = await handleCenters()
      const minX = Math.min(...centers.map((c) => c.x))
      const minY = Math.min(...centers.map((c) => c.y))
      await page.keyboard.down('Shift')
      await page.mouse.move(minX - 200, minY - 200)
      await page.mouse.down()
      await page.mouse.move(minX - 120, minY - 120, { steps: 6 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
    }
    expect(await selectedAnchorCount()).toBe(4)

    // Curved batch: one click styles all four, exactly one history entry.
    const svgPointed = await previewSvg()
    await page.getByTestId('reshape-curve-point').click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-path-point]').length === 12,
    )
    expect(await selectedAnchorCount()).toBe(4)
    const svgCurved = await previewSvg()
    expect(svgCurved).not.toBe(svgPointed)

    // Click-select without a move writes no history: a single Undo jumps
    // straight back to the pre-curve artwork instead of a no-op entry.
    await handles.first().click()
    await waitForSelectedCount(1)
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await undoButton.click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-path-point]').length === 4,
    )
    expect(await previewSvg()).toBe(svgPointed)
    await redoButton.click()
    // Redo restores the curve; only the single selected anchor shows handles.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-path-point]').length === 6,
    )
    expect(await previewSvg()).toBe(svgCurved)

    // Pointed batch restores the pointed rect as one history entry.
    await page.getByTestId('reshape-point-point').click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-path-point]').length === 4,
    )
    expect(await previewSvg()).not.toBe(svgCurved)

    // Bulk move: select two anchors via clicks (deterministic), then drag one
    // of them. Both travel rigidly, the rest stay put, and one Undo restores
    // both (proving a single history entry for the batch).
    await handles.first().click()
    await waitForSelectedCount(1)
    await page.keyboard.down('Shift')
    await handles.nth(1).click()
    await page.keyboard.up('Shift')
    await waitForSelectedCount(2)
    const before = await handleCenters()
    const selectedBefore = before.filter((c) => c.pressed && !c.control).sort((a, b) => a.x - b.x)
    const unselectedBefore = before.filter((c) => !c.pressed).sort((a, b) => a.x - b.x)
    expect(selectedBefore).toHaveLength(2)
    const dragFrom = { x: selectedBefore[0]!.x, y: selectedBefore[0]!.y }
    await page.mouse.move(dragFrom.x, dragFrom.y)
    await page.mouse.down()
    await page.mouse.move(dragFrom.x + 60, dragFrom.y, { steps: 10 })
    await page.mouse.up()
    // Both selected anchors moved +60px in x; unselected anchors did not
    // move; displayed controls (all owned by selected anchors) travelled
    // rigidly with them. Matched by flattened index (moves never shift slots).
    const after = await handleCenters()
    const beforeByIndex = new Map(before.map((c) => [c.index, c]))
    for (const point of after) {
      const prev = beforeByIndex.get(point.index)
      expect(prev).toBeDefined()
      if (!point.control && point.pressed) {
        expect(Math.abs(point.x - prev!.x - 60)).toBeLessThan(4)
        expect(Math.abs(point.y - prev!.y)).toBeLessThan(4)
      } else if (!point.control) {
        expect(Math.abs(point.x - prev!.x)).toBeLessThan(3)
        expect(Math.abs(point.y - prev!.y)).toBeLessThan(3)
      } else {
        // Displayed controls belong to selected anchors: rigid +60.
        expect(Math.abs(point.x - prev!.x - 60)).toBeLessThan(4)
        expect(Math.abs(point.y - prev!.y)).toBeLessThan(4)
      }
    }
    expect(after.filter((c) => c.pressed && !c.control)).toHaveLength(2)
    await undoButton.click()
    const restored = await handleCenters()
    const selectedRestored = restored.filter((c) => c.pressed && !c.control).sort((a, b) => a.x - b.x)
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(selectedRestored[i]!.x - selectedBefore[i]!.x)).toBeLessThan(4)
      expect(Math.abs(selectedRestored[i]!.y - selectedBefore[i]!.y)).toBeLessThan(4)
    }
    await redoButton.click()
    const redone = await handleCenters()
    const selectedRedone = redone.filter((c) => c.pressed && !c.control).sort((a, b) => a.x - b.x)
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(selectedRedone[i]!.x - selectedBefore[i]!.x - 60)).toBeLessThan(4)
    }

    // Bulk delete: all four anchors selected, but the closed rect keeps 3+
    // anchors — one deletion lands, the rest are refused as minimum-segments.
    // Exactly one history entry covers the batch.
    {
      const centers = await handleCenters()
      const xs = centers.map((c) => c.x)
      const ys = centers.map((c) => c.y)
      await page.mouse.move(Math.min(...xs) - 60, Math.min(...ys) - 60)
      await page.mouse.down()
      await page.mouse.move(Math.max(...xs) + 60, Math.max(...ys) + 60, { steps: 12 })
      await page.mouse.up()
    }
    await waitForSelectedCount(4)
    await page.getByTestId('delete-reshape-point').click()
    // Anchors drop 4 -> 3 (minimum-segments refuses the rest); selected
    // curved survivors keep showing their own controls, so count anchors.
    await waitForAnchorCount(3)
    expect(await previewSvg()).toContain('<path')
    await undoButton.click()
    await waitForAnchorCount(4)
    await redoButton.click()
    await waitForAnchorCount(3)

    // Switching objects drops the point selection: leave reshape, clear the
    // object selection with an empty click, and return with nothing selected.
    await undoButton.click()
    await waitForAnchorCount(4)
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(box.x + 24, box.y + 24)
    await reshapeTool.click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-path-point]').length === 0,
    )
    expect(await page.getByTestId('delete-reshape-point').count()).toBe(0)
  }, 180_000)
})
