import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-page reshape add/delete wiring:
// - rect tool drag creates a 4-anchor shape
// - reshape curve click adds a point (4 -> 5, rect becomes path)
// - double-click deletes the new point (5 -> 4)
// - Delete-button removes an added point (5 -> 4)
// - each mutation is a single history entry (Undo/Redo round-trips geometry)
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4241'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function pointCount() {
  return await page.locator('[data-vector-path-point]').count()
}

async function waitForPointCount(expected: number) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-vector-path-point]').length === count,
    expected,
  )
}

async function previewSvg() {
  return await page.locator('.vector-preview').innerHTML()
}

describe('vector reshape add/delete on the real page', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4241', '--strictPort'], {
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

  it('curve click adds, double-click deletes, delete-button deletes, with Undo/Redo', async () => {
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })

    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }

    // Draw a rect via real drag so the test starts from 4 anchors.
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
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)

    // Click the middle of the top edge of the selected object to add a point.
    // Handle positions are the source of truth for the curve location.
    async function topEdgeMidpoint() {
      const all = page.locator('[data-vector-path-point]')
      const count = await all.count()
      if (count === 0) throw new Error('No reshape handles')
      const centers: Array<{ x: number; y: number }> = []
      for (let i = 0; i < count; i++) {
        const handleBox = await all.nth(i).boundingBox()
        if (!handleBox) continue
        centers.push({ x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 })
      }
      centers.sort((a, b) => a.y - b.y)
      const top = centers.slice(0, 2)
      if (top.length < 2) throw new Error('Not enough top handles')
      return { x: (top[0]!.x + top[1]!.x) / 2, y: (top[0]!.y + top[1]!.y) / 2 }
    }
    const layer = page.locator('[data-reshape-curve-layer]')
    await layer.waitFor({ state: 'visible' })
    const edge = await topEdgeMidpoint()
    const edgeX = edge.x
    const edgeY = edge.y
    await page.mouse.click(edgeX, edgeY)
    await waitForPointCount(5)
    expect(await pointCount()).toBe(5)
    // The rect is converted to a path carrying the new anchor; no text
    // editor may open for a path mutation.
    expect(await page.locator('[data-inline-text-editor]').count()).toBe(0)
    expect(await previewSvg()).toContain('<path')

    // Undo removes the added point in one step; Redo restores it.
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await undoButton.click()
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)
    await redoButton.click()
    await waitForPointCount(5)
    expect(await pointCount()).toBe(5)

    // Double-click the added (top-edge middle) handle to delete it.
    const handles = page.locator('[data-vector-path-point]')
    const handleCount = await handles.count()
    let targetIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < handleCount; i++) {
      const handleBox = await handles.nth(i).boundingBox()
      if (!handleBox) continue
      const distance = Math.hypot(
        handleBox.x + handleBox.width / 2 - edgeX,
        handleBox.y + handleBox.height / 2 - edgeY,
      )
      if (distance < bestDistance) {
        bestDistance = distance
        targetIndex = i
      }
    }
    if (targetIndex < 0) throw new Error('No reshape handle found near the added point')
    // Geometry: the new anchor lands on the clicked curve (screen-near).
    expect(bestDistance).toBeLessThan(40)
    await handles.nth(targetIndex).dblclick()
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)
    await undoButton.click()
    await waitForPointCount(5)
    expect(await pointCount()).toBe(5)
    await redoButton.click()
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)

    // Add once more, then use the explicit Delete-button operation.
    const edge2 = await topEdgeMidpoint()
    await page.mouse.click(edge2.x, edge2.y)
    await waitForPointCount(5)
    const deleteButton = page.getByTestId('delete-reshape-point')
    await deleteButton.waitFor({ state: 'visible' })
    await deleteButton.click()
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)
    await undoButton.click()
    await waitForPointCount(5)
    expect(await pointCount()).toBe(5)
    await redoButton.click()
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)

    // Add a third time and delete via the keyboard (global Delete removes the
    // selected reshape anchor instead of the whole object).
    const edge3 = await topEdgeMidpoint()
    await page.mouse.click(edge3.x, edge3.y)
    await waitForPointCount(5)
    expect(await pointCount()).toBe(5)
    await page.keyboard.press('Delete')
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)
    // The object itself survives a point Delete; only the anchor is removed.
    expect(await previewSvg()).toContain('<path')
    await undoButton.click()
    await waitForPointCount(5)
    expect(await pointCount()).toBe(5)
    await redoButton.click()
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)
  }, 120_000)
})
