import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor wiring for the closed-fill vector brush (Scratch fill color +
// brush size) with non-destructive same-color union.
// Flow on the actual paint surface: blank the canvas, draw a red stroke
// (closed fill, stroke="none"), draw an overlapping red stroke (unites, no new
// node, bounds grow), draw an overlapping blue stroke (preserved), Undo/Redo
// the blue stroke as exactly one entry, stamp a single blue dot (<circle>),
// Undo it, then prove a transparent-fill stroke is a history-free no-op and
// point data survives. Counts are baseline-relative: clearing can leave an
// empty wrapper group that only becomes a counted unit once a sibling exists
// (pre-existing editableVectorUnits behavior, unchanged here), so the first
// stroke sets the baseline instead of asserting an absolute 1.
// Gradient / ancestor-transform / sanitize / Z-blocker / far-shape refusals
// are proven fail-closed with zero node loss in
// vector-brush-fill-merge-independent.browser.test.ts (real Paper.js + DOM);
// this test does not duplicate those matrices and never copies reference code.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4288'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function objectCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}

async function waitForPreviewContains(text: string, timeout = 15_000) {
  await page.waitForFunction((t) => document.querySelector('.vector-preview')?.innerHTML.includes(t), text, {
    timeout,
  })
}

async function waitForCount(expected: number, timeout = 15_000) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-vector-selection-outline]').length === count,
    expected,
    { timeout },
  )
}

async function surfaceCenter() {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  return { box, x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function setPaint(hex: string) {
  await page.getByLabel('Paint color', { exact: true }).first().fill(hex)
}

async function setStrokeWidth(value: string) {
  await page.getByLabel('Stroke width', { exact: true }).first().fill(value)
}

async function ensureTransparentFill(off: boolean) {
  const button = page.getByRole('button', { name: 'Transparent fill' })
  const pressed = await button.getAttribute('aria-pressed')
  const isOn = pressed === 'true'
  if (off && isOn) await button.click()
  if (!off && !isOn) await button.click()
}

async function redPathCount(svg: string): Promise<number> {
  return await page.evaluate((text: string) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    return Array.from(doc.querySelectorAll('path')).filter((p) => p.getAttribute('fill')?.toLowerCase() === '#ff0000')
      .length
  }, svg)
}

async function redBoundsWidth(svg: string): Promise<number> {
  return await page.evaluate(async (text: string) => {
    const { paperVectorObjectList } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const units = editableVectorUnits(doc.documentElement)
    const red = units.filter((u) => (u.getAttribute('fill') ?? '').toLowerCase() === '#ff0000')
    if (red.length === 0) return 0
    const list = (await paperVectorObjectList(text)) as Array<{
      boundsWidth: number
      fill?: string
    }>
    const match = list.find((item) => (item.fill ?? '').toLowerCase() === '#ff0000')
    return match?.boundsWidth ?? 0
  }, svg)
}

describe('closed-fill vector brush on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4288', '--strictPort'], {
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
    if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('draws closed fills, merges same-color, keeps other colors, and round-trips one Undo entry per stroke', async () => {
    // Blank the canvas via the real marquee + Delete so later deltas are clean.
    await page.getByTestId('vector-shape-select').click()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { box } = await surfaceCenter()
      await page.mouse.move(box.x + 20, box.y + 20)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      const del = page.getByTestId('delete-editor-selection')
      if (await del.isEnabled().catch(() => false)) {
        await del.click()
        await page.waitForTimeout(600)
      }
      if ((await objectCount()) === 0) break
    }
    expect(await objectCount()).toBe(0)

    await setPaint('#ff0000')
    await ensureTransparentFill(true)
    await setStrokeWidth('20')
    await page.getByTestId('vector-shape-brush').click()

    // Stroke 1: red drag. Capture the live preview mid-gesture, then commit.
    {
      const { x, y } = await surfaceCenter()
      await page.mouse.move(x - 60, y)
      await page.mouse.down()
      await page.mouse.move(x + 60, y, { steps: 12 })
      const live = await page.locator('[data-testid="vector-brush-preview"]').innerHTML().catch(() => '')
      expect(live).toContain('<path')
      expect(live).toContain('fill="#ff0000"')
      expect(live).toContain('stroke="none"')
      expect(live).not.toContain('<polyline')
      await page.mouse.up()
    }
    await waitForPreviewContains('fill="#ff0000"')
    const baseCount = await objectCount()
    expect(baseCount).toBeGreaterThan(0)
    const svg1 = await previewSvg()
    expect(svg1).toContain('fill="#ff0000"')
    expect(svg1).toContain('stroke="none"')
    expect(svg1).not.toContain('fill="none" stroke="#ff0000"')
    const d1 = await page.evaluate((svg: string) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const el = Array.from(doc.querySelectorAll('path')).find((p) => p.getAttribute('fill')?.toLowerCase() === '#ff0000')
      return el?.getAttribute('d') ?? ''
    }, svg1)
    expect(d1.endsWith('Z')).toBe(true)
    expect(await redPathCount(svg1)).toBe(1)
    const width1 = await redBoundsWidth(svg1)
    expect(width1).toBeGreaterThan(0)

    // Stroke 2: overlapping red drag merges instead of adding a node.
    {
      const { x, y } = await surfaceCenter()
      await page.mouse.move(x - 40, y)
      await page.mouse.down()
      await page.mouse.move(x + 80, y, { steps: 12 })
      await page.mouse.up()
    }
    await page.waitForTimeout(2500)
    expect(await objectCount()).toBe(baseCount)
    const svg2 = await previewSvg()
    expect(await redPathCount(svg2)).toBe(1)
    // The union spans further right than the first stroke alone.
    expect(await redBoundsWidth(svg2)).toBeGreaterThan(width1)

    // Stroke 3: overlapping blue drag is preserved (different fill never merges).
    await setPaint('#0000ff')
    {
      const { x, y } = await surfaceCenter()
      await page.mouse.move(x - 40, y)
      await page.mouse.down()
      await page.mouse.move(x + 80, y, { steps: 12 })
      await page.mouse.up()
    }
    await waitForCount(baseCount + 1)
    const svg3 = await previewSvg()
    expect(svg3).toContain('fill="#ff0000"')
    expect(svg3).toContain('fill="#0000ff"')

    // One stroke == one Undo entry: Undo drops only the blue stroke.
    await page.locator('button[aria-label="Undo"]').first().click()
    await waitForCount(baseCount)
    expect(await previewSvg()).not.toContain('fill="#0000ff"')
    expect(await previewSvg()).toContain('fill="#ff0000"')
    await page.locator('button[aria-label="Redo"]').first().click()
    await waitForCount(baseCount + 1)
    expect(await previewSvg()).toContain('fill="#0000ff"')

    // Single dot stamps a filled circle (not an empty path).
    {
      const { x, y } = await surfaceCenter()
      await page.mouse.move(x + 150, y + 100)
      await page.mouse.down()
      await page.mouse.up()
    }
    await waitForCount(baseCount + 2)
    const svgDot = await previewSvg()
    const dotFill = await page.evaluate((svg: string) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const circles = Array.from(doc.querySelectorAll('circle'))
      return circles.map((c) => c.getAttribute('fill'))
    }, svgDot)
    expect(dotFill.map((f) => (f ?? '').toLowerCase())).toContain('#0000ff')
    await page.locator('button[aria-label="Undo"]').first().click()
    await waitForCount(baseCount + 1)

    // Transparent fill is a history-free no-op: counts freeze and the next
    // Undo still targets the blue stroke (no empty entry was pushed).
    await ensureTransparentFill(false)
    {
      const { x, y } = await surfaceCenter()
      await page.mouse.move(x - 40, y)
      await page.mouse.down()
      await page.mouse.move(x + 80, y, { steps: 8 })
      await page.mouse.up()
    }
    await page.waitForTimeout(1200)
    expect(await objectCount()).toBe(baseCount + 1)
    await page.locator('button[aria-label="Undo"]').first().click()
    await waitForCount(baseCount)
    expect(await previewSvg()).not.toContain('fill="#0000ff"')
    await page.locator('button[aria-label="Redo"]').first().click()
    await waitForCount(baseCount + 1)
    await ensureTransparentFill(true)

    // Point data survives the merge: painted fills stay point-editable
    // (empty wrapper groups, if any, carry no points and are ignored here).
    const points = await page.evaluate(async (svg: string) => {
      const { paperVectorObjectList } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const list = (await paperVectorObjectList(svg)) as Array<{ points?: unknown[]; fill?: string }>
      return list
        .filter((item) => (item.fill ?? '').toLowerCase() === '#ff0000' || (item.fill ?? '').toLowerCase() === '#0000ff')
        .map((item) => ({ fill: item.fill, n: item.points?.length ?? 0 }))
    }, await previewSvg())
    expect(points).toHaveLength(2)
    expect(points.every((p) => p.n > 0)).toBe(true)

    // Committed art is sanitized display SVG (no script/event payloads).
    const committed = await previewSvg()
    expect(committed).not.toContain('<script')
    expect(committed.toLowerCase()).not.toContain('onload=')
  }, 180_000)
})
