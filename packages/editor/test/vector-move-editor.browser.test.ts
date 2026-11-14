import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor UI coverage for Shift snap / Alt duplicate vector moves.
// Unlike vector-move-drag.browser.test.ts (helper-level), this drives the
// actual paint surface: rect tool drag creates a shape, the select tool
// drags it with Shift / Alt via real mouse + keyboard modifiers, and the
// assertions read the rendered `.vector-preview` SVG (paper bounds) plus
// the visible Undo/Redo wiring. Covers: Shift axis snap, Alt clone keeps
// the source in place at the right offset, each drag is a single history
// entry, and a click without movement is a no-op.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4242'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

type SvgBounds = { x: number; y: number; width: number; height: number }

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function objectCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}

async function boundsList(svgText: string): Promise<SvgBounds[]> {
  return await page.evaluate(async (svg: string) => {
    const { paperVectorObjectList } = await import(
      /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
    )
    const list = await paperVectorObjectList(svg)
    return list.map((item: any) => ({
      x: item.boundsX,
      y: item.boundsY,
      width: item.boundsWidth,
      height: item.boundsHeight,
    }))
  }, svgText)
}

async function waitForPreviewChange(before: string) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before,
    { timeout: 10_000 },
  )
}

async function waitForCount(expected: number) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-vector-selection-outline]').length === count,
    expected,
    { timeout: 10_000 },
  )
}

async function outlineCenter(index: 'first' | 'last' = 'last') {
  const target =
    index === 'last'
      ? page.locator('[data-vector-selection-outline]').last()
      : page.locator('[data-vector-selection-outline]').first()
  await target.waitFor({ state: 'visible' })
  const box = await target.boundingBox()
  if (!box) throw new Error('Missing vector object outline bounds')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function dragWithModifiers(
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: { shift?: boolean; alt?: boolean } = {},
) {
  if (modifiers.shift) await page.keyboard.down('Shift')
  if (modifiers.alt) await page.keyboard.down('Alt')
  try {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
  } finally {
    if (modifiers.alt) await page.keyboard.up('Alt')
    if (modifiers.shift) await page.keyboard.up('Shift')
  }
}

function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

describe('vector move Shift/Alt on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4242', '--strictPort'], {
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
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('creates a rect, Shift-drags on-axis, Alt-duplicates, and treats clicks as no-ops', async () => {
    const surface = page.getByTestId('costume-paint-surface')

    // 1. Create a rectangle through the real rect tool drag. Saving re-normalizes
    // the artwork (editable units collapse from the imported cat parts), so the
    // post-draw preview is the baseline instead of asserting +1 from startup.
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    await page.mouse.move(centerX - 110, centerY - 60)
    await page.mouse.down()
    await page.mouse.move(centerX + 110, centerY + 60, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.innerHTML.includes('<rect'),
      null,
      { timeout: 10_000 },
    )
    // Shape creation auto-switches back to the select tool.
    await page.getByTestId('vector-shape-select').click()

    const drawnSvg = await previewSvg()
    expect(drawnSvg).toContain('<rect')
    const drawnBounds = await boundsList(drawnSvg)
    expect(drawnBounds.length).toBeGreaterThanOrEqual(2)
    const drawnRect = drawnBounds.at(-1)
    if (!drawnRect) throw new Error('Missing drawn rect bounds')

    // 2. Shift-drag mostly horizontally: the 45-degree snap must kill the y drift.
    const shiftStart = await outlineCenter('last')
    const shiftBefore = await previewSvg()
    // Mostly-horizontal screen drag with a small vertical component; snapping
    // to the x-axis keeps SVG y while x travels.
    await dragWithModifiers(shiftStart, { x: shiftStart.x + 120, y: shiftStart.y + 28 }, { shift: true })
    await waitForPreviewChange(shiftBefore)
    const shiftedSvg = await previewSvg()
    const shiftedBounds = await boundsList(shiftedSvg)
    expect(shiftedBounds.length).toBe(drawnBounds.length)
    const shiftedRect = shiftedBounds.at(-1)
    if (!shiftedRect) throw new Error('Missing shifted rect bounds')
    const shiftDx = shiftedRect.x - drawnRect.x
    const shiftDy = shiftedRect.y - drawnRect.y
    expect(shiftDx).toBeGreaterThan(8)
    expect(Math.abs(shiftDy)).toBeLessThan(3)
    // Width/height survive a pure move.
    expect(shiftedRect.width).toBeCloseTo(drawnRect.width, 0)
    expect(shiftedRect.height).toBeCloseTo(drawnRect.height, 0)

    // Shift-drag is a single history entry: one Undo restores, one Redo reapplies.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      shiftBefore,
      { timeout: 10_000 },
    )
    const undoneBounds = await boundsList(await previewSvg())
    expect(undoneBounds.at(-1)?.x ?? NaN).toBeCloseTo(drawnRect.x, 0)
    expect(undoneBounds.at(-1)?.y ?? NaN).toBeCloseTo(drawnRect.y, 0)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      shiftedSvg,
      { timeout: 10_000 },
    )
    const redoneBounds = await boundsList(await previewSvg())
    expect(redoneBounds.at(-1)?.x ?? NaN).toBeCloseTo(shiftedRect.x, 0)

    // 3. Alt-drag duplicates: the source stays, the clone carries the full delta.
    const altStart = await outlineCenter('last')
    const altBefore = await previewSvg()
    const altBeforeBounds = await boundsList(altBefore)
    const sourceBefore = altBeforeBounds.at(-1)
    if (!sourceBefore) throw new Error('Missing Alt-drag source bounds')
    await dragWithModifiers(altStart, { x: altStart.x + 90, y: altStart.y + 6 }, { alt: true })
    await waitForCount(altBeforeBounds.length + 1)
    const duplicatedSvg = await previewSvg()
    const duplicatedBounds = await boundsList(duplicatedSvg)
    expect(duplicatedBounds.length).toBe(altBeforeBounds.length + 1)
    // The pre-drag last object is the source: it must not move.
    const sourceAfter = duplicatedBounds[duplicatedBounds.length - 2]
    const cloneAfter = duplicatedBounds[duplicatedBounds.length - 1]
    if (!sourceAfter || !cloneAfter || !sourceBefore) throw new Error('Missing duplicate bounds')
    expect(sourceAfter.x).toBeCloseTo(sourceBefore.x, 0)
    expect(sourceAfter.y).toBeCloseTo(sourceBefore.y, 0)
    const cloneDx = cloneAfter.x - sourceBefore.x
    const cloneDy = cloneAfter.y - sourceBefore.y
    expect(cloneDx).toBeGreaterThan(8)
    expect(Math.abs(cloneDy)).toBeLessThan(4)
    expect(cloneAfter.width).toBeCloseTo(sourceBefore.width, 0)
    expect(cloneAfter.height).toBeCloseTo(sourceBefore.height, 0)

    // Alt-duplicate is also a single history entry.
    await undoButton().click()
    await waitForCount(altBeforeBounds.length)
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      altBefore,
      { timeout: 10_000 },
    )
    await redoButton().click()
    await waitForCount(duplicatedBounds.length)
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      duplicatedSvg,
      { timeout: 10_000 },
    )

    // 4. Click without movement is a no-op: no geometry change, no history entry.
    const clickCenter = await outlineCenter('last')
    const clickBefore = await previewSvg()
    const clickCount = await objectCount()
    await page.mouse.move(clickCenter.x, clickCenter.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(600)
    expect(await previewSvg()).toBe(clickBefore)
    expect(await objectCount()).toBe(clickCount)
    // The click must not have pushed history: a single Undo still removes the
    // Alt-duplicate (back to the pre-duplicate artwork), not a no-op entry.
    await undoButton().click()
    await waitForCount(clickCount - 1)
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      altBefore,
      { timeout: 10_000 },
    )
    await redoButton().click()
    await waitForCount(clickCount)
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      clickBefore,
      { timeout: 10_000 },
    )
    expect(await previewSvg()).toBe(clickBefore)
  }, 120_000)
})
