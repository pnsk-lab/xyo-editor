import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Selection-linked MIXED + selective apply on the real editor UI:
// - different fills show a MIXED badge and selection alone never rewrites art
// - an explicit stroke-width change preserves the mixed fills (no flattening)
// - an explicit fill Apply overwrites both, with Undo/Redo restoring each step.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4322'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function outlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline].border-blue-500').count()
}

async function waitForPreviewChange(before: string) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before,
    { timeout: 10_000 },
  )
}

function applyButton() {
  return page.getByTestId('apply-vector-style')
}

function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

async function fillsOf(svgText: string): Promise<(string | null)[]> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return editableVectorUnits(doc.documentElement).map((element: Element) => element.getAttribute('fill'))
  }, svgText)
}

async function widthsOf(svgText: string): Promise<(string | null)[]> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return editableVectorUnits(doc.documentElement).map((element: Element) => element.getAttribute('stroke-width'))
  }, svgText)
}

describe('vector selection MIXED and selective apply', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4322', '--strictPort'], {
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
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 120_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('shows MIXED for mixed fills, preserves them on width-only edits, and undoes/redoes', async () => {
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2

    async function drawRect(from: { x: number; y: number }, to: { x: number; y: number }) {
      await page.getByTestId('vector-shape-rect').last().click()
      const before = await previewSvg()
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await page.mouse.up()
      await waitForPreviewChange(before)
    }

    // Start blank.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline]').length === 0,
      null,
      { timeout: 10_000 },
    )

    // Two rects with distinct fills (solid, opaque strokes).
    await page.getByLabel('Vector paint style').selectOption('solid')
    await page.getByLabel('Vector stroke style').selectOption('solid')
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    await drawRect({ x: centerX - 150, y: centerY - 40 }, { x: centerX - 50, y: centerY + 40 })
    await page.getByLabel('Paint color', { exact: true }).first().fill('#0000ff')
    await drawRect({ x: centerX + 50, y: centerY - 40 }, { x: centerX + 150, y: centerY + 40 })

    // Select both: MIXED fill badge appears, artwork untouched by selection.
    await page.getByTestId('vector-shape-select').last().click()
    const beforeSelect = await previewSvg()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    expect(await outlineCount()).toBeGreaterThanOrEqual(2)
    expect(await page.getByTestId('mixed-fill').count()).toBe(1)
    expect(await previewSvg()).toBe(beforeSelect)
    const mixedFills = await fillsOf(beforeSelect)
    expect(mixedFills.length).toBeGreaterThanOrEqual(2)

    // Width-only change preserves the mixed fills. The toolbar width input
    // applies immediately to the selection (one history entry of its own).
    // Set the value + dispatch change explicitly: synthetic input events are
    // the same mechanism the opacity helper below relies on.
    const widthInput = page.getByLabel('Stroke width', { exact: true })
    await widthInput.evaluate((el, v) => {
      const input = el as HTMLInputElement
      input.value = v as string
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, '10')
    // Immediate width apply writes its own history entry.
    await page.waitForFunction(
      (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
      beforeSelect,
      { timeout: 10_000 },
    )
    const afterWidth = await previewSvg()
    const widths = await widthsOf(afterWidth)
    for (const width of widths) expect(width).toBe('10')
    const fillsAfterWidth = await fillsOf(afterWidth)
    expect(fillsAfterWidth).toEqual(mixedFills)

    // Undo restores widths, keeps the distinct fills; redo reapplies.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSelect,
      { timeout: 10_000 },
    )
    expect(await fillsOf(await previewSvg())).toEqual(mixedFills)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterWidth,
      { timeout: 10_000 },
    )

    // Explicit fill Apply overwrites both (user's choice), then undoes cleanly.
    await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
    await applyButton().click()
    await waitForPreviewChange(afterWidth)
    const afterFill = await previewSvg()
    for (const fill of await fillsOf(afterFill)) expect(fill?.toLowerCase()).toBe('#00ff00')
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterWidth,
      { timeout: 10_000 },
    )
    expect(await fillsOf(await previewSvg())).toEqual(mixedFills)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterFill,
      { timeout: 10_000 },
    )

    // Deselecting never rewrites the artwork.
    const deselected = await previewSvg()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0,
      null,
      { timeout: 10_000 },
    )
    expect(await previewSvg()).toBe(deselected)
  }, 180_000)
})
