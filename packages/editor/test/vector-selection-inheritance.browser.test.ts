import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Audit regression for vector-selection-style effective resolution:
// - inline `style` beats presentation attributes, ancestors provide inherited
//   paint, `fill-opacity`/chained `opacity` fold into the paint, `class` and
//   unparsable/`url()`-fallback-less paints fail closed to MIXED;
// - width-only edits never rewrite fills; same-side gradient edits preserve
//   the element's own colors/kind; unknown sides are skipped (not overwritten)
//   and the status message explains the skip to the user.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4323'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const TRICKY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs><linearGradient id="kept" x1="0" y1="0" x2="480" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff0000" stop-opacity="1"/><stop offset="1" stop-color="#00ff00" stop-opacity="1"/></linearGradient></defs><g fill="#0000ff"><rect x="20" y="20" width="100" height="80" stroke="#000000" stroke-width="2"/></g><rect x="150" y="20" width="100" height="80" style="fill: #ff0000; stroke: #000000; stroke-width: 3" fill="#00ff00" fill-opacity="0.5"/><rect x="280" y="20" width="100" height="80" fill="url(#missing) #ffff00" stroke="none"/><rect x="20" y="130" width="100" height="80" fill="url(#kept)" stroke="none"/><rect x="150" y="130" width="100" height="80" class="themed" fill="#ff0000" stroke="none"/><rect x="280" y="130" width="100" height="80" fill="red" stroke="none"/></svg>`

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

type UnitPaint = {
  fill: string | null
  style: string | null
  fillOpacity: string | null
  strokeWidth: string | null
}

async function unitPaints(svgText: string): Promise<UnitPaint[]> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return editableVectorUnits(doc.documentElement).map((element: Element) => ({
      fill: element.getAttribute('fill'),
      style: element.getAttribute('style'),
      fillOpacity: element.getAttribute('fill-opacity'),
      strokeWidth: element.getAttribute('stroke-width'),
    }))
  }, svgText)
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status())
}

describe('vector selection effective style audit (real browser)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4323', '--strictPort'], {
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

  it('resolves style/inheritance/opacity/fallback per side in the real DOM', async () => {
    const report = await page.evaluate(async (svgText: string) => {
      const mod = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-selection-style.ts'
      )
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const rootChildren = Array.from(doc.documentElement.children)
        .map((element) => element.tagName.toLowerCase())
        .filter((tag) => tag !== 'defs')
      const units = rootChildren.length
      const styled = doc.documentElement.querySelector('rect[style]')!
      const styledPaint = mod.readVectorElementPaintDetailed(styled, () => undefined)
      const grouped = doc.documentElement.querySelector('g > rect')!
      const groupedPaint = mod.readVectorElementPaintDetailed(grouped, () => undefined)
      const fallback = Array.from(doc.documentElement.querySelectorAll('rect')).find(
        (element) => (element.getAttribute('fill') ?? '').includes('#missing'),
      )!
      const fallbackPaint = mod.readVectorElementPaintDetailed(fallback, () => undefined)
      const kept = Array.from(doc.documentElement.querySelectorAll('rect')).find(
        (element) => (element.getAttribute('fill') ?? '').includes('#kept'),
      )!
      const keptPaint = mod.readVectorElementPaintDetailed(kept, (id: string) => {
        if (id !== 'kept') return undefined
        return {
          tag: 'linearGradient',
          x1: '0',
          y1: '0',
          x2: '480',
          y2: '0',
          stops: [
            { color: '#ff0000', opacity: '1' },
            { color: '#00ff00', opacity: '1' },
          ],
        }
      })
      const classed = doc.documentElement.querySelector('rect.themed')!
      const classedPaint = mod.readVectorElementPaintDetailed(classed, () => undefined)
      const named = Array.from(doc.documentElement.querySelectorAll('rect')).find(
        (element) => element.getAttribute('fill') === 'red',
      )!
      const namedPaint = mod.readVectorElementPaintDetailed(named, () => undefined)
      const summary = mod.summarizeDetailedVectorElementPaints([styledPaint, keptPaint])
      return {
        units,
        rootChildren,
        styledFill: styledPaint.fill,
        styledFillGradient: styledPaint.fillGradient,
        groupedFill: groupedPaint.fill,
        fallbackFill: fallbackPaint.fill,
        keptPrimary: keptPaint.fill,
        keptGradient: keptPaint.fillGradient,
        classedFill: classedPaint.fill,
        namedFill: namedPaint.fill,
        summaryFill: summary.fill,
        summaryStrokeWidth: summary.strokeWidth,
      }
    }, TRICKY_SVG)
    // Sanity: 1 group + 5 rects, style rect first-class.
    expect(report.units).toBe(6)
    expect(report.rootChildren).toEqual(['g', 'rect', 'rect', 'rect', 'rect', 'rect'])
    // Inline style wins over the #00ff00 attribute; fill-opacity folds in.
    expect(report.styledFill).toEqual({ r: 255, g: 0, b: 0, a: 128 })
    expect(report.styledFillGradient).toBe('solid')
    // Parent <g fill> provides the grouped rect's paint (not SVG-default black).
    expect(report.groupedFill).toEqual({ r: 0, g: 0, b: 255, a: 255 })
    // Missing gradient with a solid fallback reads the fallback, not MIXED.
    expect(report.fallbackFill).toEqual({ r: 255, g: 255, b: 0, a: 255 })
    // Resolvable gradient keeps both ends and its kind.
    expect(report.keptPrimary).toEqual({ r: 255, g: 0, b: 0, a: 255 })
    expect(report.keptGradient).toBe('horizontal')
    // Class-controlled and named-color paints fail closed to MIXED.
    expect(report.classedFill).toBe('MIXED')
    expect(report.namedFill).toBe('MIXED')
    // The summary keeps the disagreement visible instead of inventing a color.
    expect(report.summaryFill).toBe('MIXED')
  }, 60_000)

  it('uploads the audit SVG, shows MIXED, and preserves paint on width-only edits', async () => {
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'audit-style.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(TRICKY_SVG, 'utf8'),
    })
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
      beforeCards,
      { timeout: 30_000 },
    )
    const cards = page.getByTestId(/costume-card-\d+/)
    await cards.last().getByRole('button', { name: /Select / }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    }

    // Select every unit: MIXED appears, and selection alone never rewrites art.
    await page.getByTestId('vector-shape-select').last().click()
    const beforeSelect = await previewSvg()
    expect(beforeSelect).toContain('<svg')
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    expect(await page.getByTestId('mixed-fill').count()).toBe(1)
    expect(await previewSvg()).toBe(beforeSelect)
    const fillsBefore = await unitPaints(beforeSelect)
    expect(fillsBefore.length).toBeGreaterThanOrEqual(5)

    // Width-only change: every stroke-width becomes 10, fills byte-identical.
    const widthInput = page.getByLabel('Stroke width', { exact: true })
    await widthInput.evaluate((el, v) => {
      const input = el as HTMLInputElement
      input.value = v as string
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, '10')
    await page.waitForFunction(
      (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
      beforeSelect,
      { timeout: 10_000 },
    )
    const afterWidth = await previewSvg()
    const widths = await unitPaints(afterWidth)
    for (const unit of widths) expect(unit.strokeWidth).toBe('10')
    // Fills survive the width-only edit. The width itself moves from inline
    // `style` to the `stroke-width` attribute (required: leaving
    // `stroke-width: 3` in `style` would keep winning over the attribute and
    // the edit would not take effect), so compare styles with that property
    // normalized out.
    expect(widths.map((unit) => unit.fill)).toEqual(fillsBefore.map((unit) => unit.fill))
    expect(widths.map((unit) => unit.fillOpacity)).toEqual(fillsBefore.map((unit) => unit.fillOpacity))
    const withoutWidthProp = (style: string | null) =>
      (style ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !/^\s*stroke-width\s*:/i.test(part))
        .join('; ')
    expect(widths.map((unit) => withoutWidthProp(unit.style))).toEqual(
      fillsBefore.map((unit) => withoutWidthProp(unit.style)),
    )
    // The style-priority rect keeps its winning fill/stroke declarations.
    const styledAfter = widths.find((unit) => (unit.style ?? '').includes('fill:'))
    expect(styledAfter?.style).toContain('fill: #ff0000')
    expect(styledAfter?.style).toContain('stroke: #000000')
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSelect,
      { timeout: 10_000 },
    )
  }, 180_000)

  it('applies explicit fill edits to known sides while skipping unknown sides with an explanation', async () => {
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    const beforeSvg = await previewSvg()
    const before = await unitPaints(beforeSvg)
    // Explicit fill change overwrites known sides only.
    await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
    await applyButton().click()
    await waitForPreviewChange(beforeSvg)
    const afterSvg = await previewSvg()
    const after = await unitPaints(afterSvg)
    expect(after.length).toBe(before.length)
    // Known style-priority rect adopts the new fill (style cleared, attr set).
    const styledIndex = before.findIndex((unit) => (unit.style ?? '').includes('fill'))
    expect(styledIndex).toBeGreaterThanOrEqual(0)
    expect(after[styledIndex]?.fill?.toLowerCase()).toBe('#00ff00')
    expect(after[styledIndex]?.style ?? '').not.toContain('fill')
    // Fallback rect is known (fallback solid) and adopts the new fill too.
    const fallbackIndex = before.findIndex((unit) => (unit.fill ?? '').includes('#missing'))
    expect(fallbackIndex).toBeGreaterThanOrEqual(0)
    expect(after[fallbackIndex]?.fill?.toLowerCase()).toBe('#00ff00')
    // Unknown sides (class + named color) are skipped, never guessed.
    const namedIndex = before.findIndex((unit) => unit.fill === 'red')
    expect(namedIndex).toBeGreaterThanOrEqual(0)
    expect(after[namedIndex]?.fill).toBe('red')
    const classedIndex = before.findIndex(
      (unit, index) => unit.fill === '#ff0000' && index !== styledIndex,
    )
    expect(classedIndex).toBeGreaterThanOrEqual(0)
    expect(after[classedIndex]?.fill).toBe('#ff0000')
    // The user is told unknown sides were left untouched.
    expect(await editorStatus()).toMatch(/skipped|MIXED/i)
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSvg,
      { timeout: 10_000 },
    )
    expect(await unitPaints(await previewSvg())).toEqual(before)
  }, 180_000)
})
