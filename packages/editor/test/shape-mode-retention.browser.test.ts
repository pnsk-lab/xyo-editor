import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Shape tools stay armed after creating a shape (scratch-paint rect/oval
// parity). Reference (verified against .tmp/scratch-editor):
// - vector tools/rect-tool.js + tools/oval-tool.js handleMouseUp selects the
//   new shape with NO mode change; rect-mode.jsx/oval-mode.jsx never dispatch
//   changeMode on commit. Next mousedown on the selection moves it
//   (boundingBoxTool), blank mousedown clears + starts a new shape.
// - bit-tools/rect-tool.js + bit-tools/oval-tool.js handleMouseUp selects the
//   floating paper Shape with NO mode change; bit-rect/oval-mode.jsx keep
//   BIT_RECT/BIT_OVAL. Next mousedown moves/scales the live shape, blank click
//   commits it to the raster and starts a new one.
//
// This file proves on the real editor, through the UI only:
// - vector rect stays armed after commit, a press on the live selection moves
//   it under the same tool, a blank drag creates a second shape without
//   touching the first, Delete/Undo/Redo round-trip the artwork,
// - bitmap rect stays armed after commit, the floating scale handles stay
//   usable under the shape tool, a press inside the selection moves it,
//   Escape clears the selection but keeps the tool, and a blank drag draws a
//   second shape.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/shape-mode-retention.browser.test.ts
const root = join(import.meta.dir, '..')
const PORT = 4531
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function surfaceBox() {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  return box
}

async function bitmapCanvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function bitmapToScreen(x: number, y: number) {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas')
  const size = await bitmapCanvasSize()
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height }
}

async function resetBitmapZoom() {
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 })
  } catch {
    return
  }
  try {
    await page.waitForFunction(
      () =>
        (
          document.querySelector('[data-testid="bitmap-editor-canvas"]')?.parentElement?.getAttribute('style') ?? ''
        ).includes('scale(0.5)'),
      null,
      { timeout: 5_000 },
    )
  } catch {
    // Best effort only: zoom is viewport-only and never affects the mode
    // retention assert below. A missed pin just keeps the first-fit scale.
  }
}

async function ensureVectorMode() {
  await page.waitForFunction(
    () =>
      document.querySelector('.vector-preview') !== null ||
      document.querySelector('[data-testid="bitmap-editor-canvas"]') !== null,
    null,
    { timeout: 60_000 },
  )
  try {
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 3_000 })
    return
  } catch {
    // Not in vector mode; convert below.
  }
  await page.getByRole('button', { name: 'ベクターに変換' }).click({ timeout: 60_000 })
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 60_000 })
}

async function ensureBitmapMode() {
  await page.waitForFunction(
    () =>
      document.querySelector('.vector-preview') !== null ||
      document.querySelector('[data-testid="bitmap-editor-canvas"]') !== null,
    null,
    { timeout: 60_000 },
  )
  try {
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 3_000 })
    return
  } catch {
    // Not in bitmap mode; convert below.
  }
  await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 60_000 })
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 60_000 })
}

function toolActiveClass(className: string | null): boolean {
  return (className ?? '').includes('text-white')
}

async function vectorShapeCount(): Promise<number> {
  return await page.evaluate(() => {
    const rootNode = document.querySelector('.vector-preview')
    if (!rootNode) return 0
    return rootNode.querySelectorAll('rect,ellipse,path,circle').length
  })
}

async function lastVectorShapeX(): Promise<number> {
  return await page.evaluate(() => {
    const rootNode = document.querySelector('.vector-preview')
    const shapes = rootNode ? Array.from(rootNode.querySelectorAll('rect,ellipse,path,circle')) : []
    const last = shapes[shapes.length - 1] as unknown as Element | undefined
    if (!last) return Number.NaN
    const tag = last.tagName.toLowerCase()
    if (tag === 'ellipse') return Number((last.getAttribute('cx') ?? 'NaN').replace(/[^0-9.\-eE]/g, '')) || Number.NaN
    return Number(last.getAttribute('x') ?? Number.NaN)
  })
}

async function selectedVectorOutlines(): Promise<number> {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-vector-selection-outline]'))
    return nodes.filter((node) => (node as HTMLElement).className.includes('border-blue-500')).length
  })
}

async function clearVectorCanvas() {
  await page.getByTestId('vector-shape-select').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => document.querySelectorAll('[data-vector-selection-outline]').length === 0, null, {
    timeout: 10_000,
  })
}

async function canvasDigest(): Promise<string> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data).join(',')
  })
}

async function bitmapSelectionCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-selection"]').length)
}

describe('shape mode retention after creation', () => {
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
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('main-tab-costumes').click({ timeout: 120_000 })
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 60_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('vector rect stays armed after creating a shape', async () => {
    await ensureVectorMode()
    await page.getByTestId('vector-shape-rect').last().waitFor({ state: 'visible', timeout: 30_000 })
    const box = await surfaceBox()
    const from = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.3 }
    const to = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.6 }
    await page.getByTestId('vector-shape-rect').last().click()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-vector-selection-outline]')).filter((node) =>
          (node as HTMLElement).className.includes('border-blue-500'),
        ).length > 0,
      null,
      { timeout: 10_000 },
    )
    // Reference: the rect tool stays pressed (mode RECT, not SELECT).
    const rectClass = await page.getByTestId('vector-shape-rect').last().getAttribute('class')
    expect(toolActiveClass(rectClass)).toBe(true)
    const selectClass = await page.getByTestId('vector-shape-select').getAttribute('class')
    expect(toolActiveClass(selectClass)).toBe(false)
  }, 90_000)

  it('vector rect moves the live selection, draws a second shape, and Delete/Undo/Redo round-trip', async () => {
    await ensureVectorMode()
    await clearVectorCanvas()
    const box = await surfaceBox()
    await page.getByTestId('vector-shape-rect').last().click()
    const from = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.3 }
    const to = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.6 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.querySelectorAll('rect').length === 1, null, {
      timeout: 15_000,
    })
    const xBefore = await lastVectorShapeX()
    expect(Number.isFinite(xBefore)).toBe(true)

    // Press on the live selection: the same rect tool moves it (bounding-box
    // parity) instead of drawing. Drag right by 60 screen px.
    const center = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.move(center.x + 60, center.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      ([want]) => {
        const rootNode = document.querySelector('.vector-preview')
        const shapes = rootNode ? Array.from(rootNode.querySelectorAll('rect')) : []
        const last = shapes[shapes.length - 1] as unknown as Element | undefined
        const x = last ? Number(last.getAttribute('x') ?? Number.NaN) : Number.NaN
        return Number.isFinite(x) && x > (want as number)
      },
      [xBefore] as unknown as undefined,
      { timeout: 15_000 },
    )
    const xMoved = await lastVectorShapeX()
    expect(xMoved).toBeGreaterThan(xBefore)
    expect(await vectorShapeCount()).toBe(1)
    // The tool never left rect, and the moved shape stays selected.
    expect(toolActiveClass(await page.getByTestId('vector-shape-rect').last().getAttribute('class'))).toBe(true)
    expect(await selectedVectorOutlines()).toBeGreaterThanOrEqual(1)

    // A blank drag draws a second shape under the same tool (the first shape
    // is untouched: count goes 1 -> 2, not a duplicate-stamp of the old one).
    const secondFrom = { x: box.x + box.width * 0.68, y: box.y + box.height * 0.15 }
    const secondTo = { x: box.x + box.width * 0.88, y: box.y + box.height * 0.35 }
    await page.mouse.move(secondFrom.x, secondFrom.y)
    await page.mouse.down()
    await page.mouse.move(secondTo.x, secondTo.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.querySelectorAll('rect').length === 2,
      null,
      { timeout: 15_000 },
    )
    expect(await vectorShapeCount()).toBe(2)
    expect(toolActiveClass(await page.getByTestId('vector-shape-rect').last().getAttribute('class'))).toBe(true)

    // Delete removes the selected (second) shape; Undo/Redo round-trip it.
    await page.keyboard.press('Delete')
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.querySelectorAll('rect').length === 1,
      null,
      { timeout: 15_000 },
    )
    expect(await vectorShapeCount()).toBe(1)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.querySelectorAll('rect').length === 2,
      null,
      { timeout: 15_000 },
    )
    expect(await vectorShapeCount()).toBe(2)
    await page.locator('button[aria-label="Redo"]').first().click()
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.querySelectorAll('rect').length === 1,
      null,
      { timeout: 15_000 },
    )
    expect(await vectorShapeCount()).toBe(1)
  }, 180_000)

  it('bitmap rect stays armed after creating a shape', async () => {
    await ensureBitmapMode()
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    await resetBitmapZoom()
    await page.getByTestId('bitmap-tool-rect').click()
    const a = await bitmapToScreen(280, 260)
    const b = await bitmapToScreen(480, 360)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
    // Reference: BIT_RECT stays armed instead of flipping to `select`.
    const rectClass = await page.getByTestId('bitmap-tool-rect').getAttribute('class')
    expect(toolActiveClass(rectClass)).toBe(true)
    const selectClass = await page.getByTestId('bitmap-tool-select').getAttribute('class')
    expect(toolActiveClass(selectClass)).toBe(false)
  }, 90_000)

  it('bitmap rect moves the live selection, Escape keeps the tool, and a blank drag draws again', async () => {
    await ensureBitmapMode()
    // Isolate from the previous test's committed selection: a press inside
    // it would move (bounding-box parity), so clear first.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="bitmap-selection"]').length === 0, null, {
      timeout: 10_000,
    })
    await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
    await resetBitmapZoom()
    await page.getByTestId('bitmap-tool-rect').click()
    const digestBefore = await canvasDigest()
    const a = await bitmapToScreen(280, 260)
    const b = await bitmapToScreen(480, 360)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
    // The floating scale handles stay usable while rect is armed.
    await page.getByTestId('bitmap-floating-scale-handle').waitFor({ state: 'visible', timeout: 10_000 })

    // Press inside the live selection: the same rect tool moves it.
    const center = await bitmapToScreen(380, 310)
    const movedTo = await bitmapToScreen(440, 340)
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.move(movedTo.x, movedTo.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(() => document.body.textContent?.includes('Bitmap selection moved') ?? false, null, {
      timeout: 15_000,
    })
    expect(await canvasDigest()).not.toBe(digestBefore)
    expect(await bitmapSelectionCount()).toBe(1)
    expect(toolActiveClass(await page.getByTestId('bitmap-tool-rect').getAttribute('class'))).toBe(true)

    // Escape clears the selection but keeps the shape tool armed.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="bitmap-selection"]').length === 0, null, {
      timeout: 10_000,
    })
    expect(await bitmapSelectionCount()).toBe(0)
    expect(toolActiveClass(await page.getByTestId('bitmap-tool-rect').getAttribute('class'))).toBe(true)

    // A blank drag draws a second shape under the same tool (no re-click).
    const c = await bitmapToScreen(80, 80)
    const d = await bitmapToScreen(180, 160)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    await page.mouse.move(d.x, d.y, { steps: 12 })
    await page.mouse.up()
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
    expect(await bitmapSelectionCount()).toBe(1)
    expect(toolActiveClass(await page.getByTestId('bitmap-tool-rect').getAttribute('class'))).toBe(true)

    // Delete clears the selected shape's pixels; Undo restores them.
    const digestCommitted = await canvasDigest()
    await page.getByTestId('delete-editor-selection').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="bitmap-selection"]').length === 0, null, {
      timeout: 10_000,
    })
    expect(await canvasDigest()).not.toBe(digestCommitted)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(() => document.body.textContent?.includes('Asset undo') ?? false, null, {
      timeout: 15_000,
    })
    expect(await canvasDigest()).toBe(digestCommitted)
  }, 240_000)
})
