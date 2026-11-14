import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Independent audit of the vector-selection-style partial apply
// (vector-selection-style.ts + Editor.svelte `style` action), real browser only.
//
// Covers the gaps left by vector-selection-mixed / inheritance tests:
// - parent `opacity` x `fill-opacity` double application (no double-dimming)
// - `style="... !important"` resolution + cleanup
// - CSS `class` + presentation attribute fail-closed (MIXED, never guessed)
// - gradient `href` (stop-less) / external `url()` / `url(#missing) fallback`
// - unrelated `style` props (e.g. stroke-dasharray) surviving an apply
// - unselected neighbours + parent `transform` untouched by any apply
// - unknown (MIXED) values: original SVG attrs AND rendered pixels unchanged
//
// Product code is never touched here. This file is additive only: it uploads
// one audit costume, edits only that costume, and undoes every edit, so no
// existing project data is destroyed. Independent port 4331 (4321-4323 are
// taken by other agents' tests).
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4331'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

// All units live under ONE outer <g> so every rect is directly selectable
// (single-child <g> chains are transparent to editableVectorUnits) while
// still inheriting parent opacity/transform for the double-apply audit.
const AUDIT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs><linearGradient id="href-parent" x1="0" y1="0" x2="480" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff0000" stop-opacity="1"/><stop offset="1" stop-color="#00ff00" stop-opacity="1"/></linearGradient><linearGradient id="href-child" href="#href-parent" x1="0" y1="0" x2="480" y2="0" gradientUnits="userSpaceOnUse"></linearGradient></defs><g id="outer" opacity="0.5" transform="translate(10,20)"><rect id="double" x="20" y="20" width="100" height="80" fill="#ff0000" fill-opacity="0.5" stroke="#000000" stroke-width="2"/><rect id="important" x="150" y="20" width="100" height="80" style="fill: #00ff00 !important; stroke: #111111 !important; stroke-dasharray: 5,3; opacity: 0.8" fill="#000000" stroke-width="2"/><rect id="classed" x="280" y="20" width="100" height="80" class="themed" fill="#ff0000" stroke="none"/><rect id="hreftest" x="20" y="130" width="100" height="80" fill="url(#href-child)" stroke="none"/><rect id="fallback" x="150" y="130" width="100" height="80" fill="url(#missing) #ffff00" stroke="none"/><rect id="external" x="280" y="130" width="100" height="80" fill="url(http://example.com/g)" stroke="none"/><rect id="neighbor" x="20" y="240" width="100" height="80" fill="#abcdef" stroke="#123456" stroke-width="4"/></g></svg>`

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
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

async function editorStatus(): Promise<string> {
  return await page.evaluate(
    () => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status(),
  )
}

// Another agent may be mid-edit on the shared tree: vite then overlays a
// compile error over the app. Wait for a healthy app instead of clicking
// through (or failing on) someone else's transient broken state.
async function waitForHealthyApp() {
  await page.waitForFunction(() => !document.querySelector('vite-error-overlay'), null, {
    timeout: 120_000,
  })
}

type UnitAttrs = {
  id: string | null
  fill: string | null
  style: string | null
  fillOpacity: string | null
  stroke: string | null
  strokeWidth: string | null
  transform: string | null
  opacity: string | null
}

async function unitAttrs(svgText: string): Promise<UnitAttrs[]> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return editableVectorUnits(doc.documentElement).map((element: Element) => ({
      id: element.getAttribute('id'),
      fill: element.getAttribute('fill'),
      style: element.getAttribute('style'),
      fillOpacity: element.getAttribute('fill-opacity'),
      stroke: element.getAttribute('stroke'),
      strokeWidth: element.getAttribute('stroke-width'),
      transform: element.getAttribute('transform'),
      opacity: element.getAttribute('opacity'),
    }))
  }, svgText)
}

async function outerGroupAttrs(svgText: string): Promise<{ opacity: string | null; transform: string | null }> {
  return await page.evaluate(async (svg: string) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const g = doc.documentElement.querySelector('#outer')
    return { opacity: g?.getAttribute('opacity') ?? null, transform: g?.getAttribute('transform') ?? null }
  }, svgText)
}

// Select one unit through the production units-list handler. The canvas
// marquee/click geometry cannot reach off-viewport units in this harness
// (2400x1800 transform-panned surface, no native scroll), and scrolling is a
// no-op (overflow hidden); the list `onclick` runs the same production
// `selectVectorObject` path as visible UI clicks (verified: exactly one
// outline appears, artwork untouched). A real dispatched MouseEvent is used,
// not a direct function call.
async function selectSingleUnitByIndex(index: number) {
  await page.evaluate((i: number) => {
    const buttons = Array.from(document.querySelectorAll('div.max-h-32 > button'))
    const btn = buttons[i] as HTMLElement | undefined
    if (!btn) throw new Error(`unit button ${i} missing`)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  }, index)
}

// Rendered (post-`translate(10,20)`) inset pixel regions per audit rect.
const RENDERED_REGIONS: Record<string, { x: number; y: number; w: number; h: number }> = {
  double: { x: 34, y: 44, w: 92, h: 72 },
  important: { x: 164, y: 44, w: 92, h: 72 },
  classed: { x: 294, y: 44, w: 92, h: 72 },
  hreftest: { x: 34, y: 154, w: 92, h: 72 },
  fallback: { x: 164, y: 154, w: 92, h: 72 },
  external: { x: 294, y: 154, w: 92, h: 72 },
  neighbor: { x: 34, y: 264, w: 92, h: 72 },
}

// Live unknown-fill units: whatever the production summary deems MIXED on
// the sanitized preview DOM (adapts to import sanitization: e.g. an external
// url() stripped at import reads as default-black/known from here on).
async function unknownFillIds(svgText: string): Promise<(string | null)[]> {
  return await page.evaluate(async (svg: string) => {
    const styleMod = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-selection-style.ts'
    )
    const { editableVectorUnits } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const resolveGradient = (id: string) => {
      const def = (doc as Document).getElementById?.(id) as Element | null
      if (!def) return undefined
      const tag = def.tagName.toLowerCase() === 'radialgradient' ? 'radialGradient' : 'linearGradient'
      return styleMod.readGradientDefFromElement(
        def as unknown as Parameters<typeof styleMod.readGradientDefFromElement>[0],
        tag,
      )
    }
    return editableVectorUnits(doc.documentElement)
      .map((element: Element) => ({
        id: element.getAttribute('id'),
        paint: styleMod.readVectorElementPaintDetailed(
          element as unknown as Parameters<typeof styleMod.readVectorElementPaintDetailed>[0],
          resolveGradient,
        ),
      }))
      .filter((unit) => styleMod.isMixedSelectionValue(unit.paint.fill))
      .map((unit) => unit.id)
  }, svgText)
}

// Costume tab + vector mode can be lost to an HMR reload while another agent
// edits the tree mid-run. Re-assert them (idempotent), and re-upload the
// audit costume if the reload dropped it (additive only, never destructive).
async function ensureAuditCostume() {  await waitForHealthyApp()
  await page.getByTestId('main-tab-costumes').click({ timeout: 60_000 })
  const surface = page.getByTestId('costume-paint-surface')
  await surface.waitFor({ state: 'visible', timeout: 60_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 60_000 })
  const current = await previewSvg()
  if (!current.includes('outer')) {
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'partial-audit.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(AUDIT_SVG, 'utf8'),
    })
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
      beforeCards,
      { timeout: 30_000 },
    )
    const cards = page.getByTestId(/costume-card-\d+/)
    await cards.last().getByRole('button', { name: /Select / }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    }
  }
}

// Re-assert select-all on the audit costume (a mid-test HMR reload from
// another agent's edit resets component selection state; the stored art
// survives, so re-selecting is safe and non-destructive).
async function ensureSelectAllOnAudit() {
  await ensureAuditCostume()
  const count = await page.locator('[data-vector-selection-outline].border-blue-500').count()
  if (count < 2) {
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 15_000 },
    )
  }
}

// Re-assert single selection of #double (same reload hazard as above).
async function ensureSingleDoubleSelection() {
  const count = await page.locator('[data-vector-selection-outline].border-blue-500').count()
  if (count !== 1) {
    await ensureSelectAllOnAudit()
    await selectSingleUnitByIndex(0)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 1,
      null,
      { timeout: 15_000 },
    )
  }
}

// `translate(10,20)` vs `translate(10 20)`: the edit round-trip normalizes
// separators, so compare parent transforms semantically, not byte-wise.
function normTransform(value: string | null): string {
  return (value ?? '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
}

async function parentTransformTranslate(svgText: string): Promise<[number, number]> {
  return await page.evaluate(async (svg: string) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const raw = doc.documentElement.querySelector('#outer')?.getAttribute('transform') ?? ''
    const match = /translate\(\s*([-+\d.eE]+)(?:[\s,]+([-+\d.eE]+))?\s*\)/.exec(raw)
    if (!match) throw new Error(`unparsable parent transform: ${raw}`)
    return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])]
  }, svgText)
}

// Render two SVG strings off-screen and count pixels differing inside a
// region (in SVG user units, mapped 1:1 onto a 480x360 canvas). Inset regions
// avoid antialiased edges shared with neighbouring rects.
async function regionPixelDiff(
  before: string,
  after: string,
  region: { x: number; y: number; w: number; h: number },
): Promise<number> {
  return await page.evaluate(
    async ({ a, b, r }: { a: string; b: string; r: { x: number; y: number; w: number; h: number } }) => {
      async function render(svgText: string): Promise<Uint8ClampedArray> {
        const img = new Image()
        const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('svg render failed'))
          img.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = 480
        canvas.height = 360
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.clearRect(0, 0, 480, 360)
        ctx.drawImage(img, 0, 0, 480, 360)
        return ctx.getImageData(r.x, r.y, r.w, r.h).data
      }
      const da = await render(a)
      const db = await render(b)
      let diff = 0
      for (let i = 0; i < da.length; i += 4) {
        if (
          Math.abs(da[i]! - db[i]!) > 2 ||
          Math.abs(da[i + 1]! - db[i + 1]!) > 2 ||
          Math.abs(da[i + 2]! - db[i + 2]!) > 2 ||
          Math.abs(da[i + 3]! - db[i + 3]!) > 8
        ) {
          diff += 1
        }
      }
      return diff
    },
    { a: before, b: after, r: region },
  )
}

describe('vector selection partial-apply independent audit (real browser)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4331', '--strictPort'], {
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
    await waitForHealthyApp()
    await page.getByTestId('main-tab-costumes').click({ timeout: 120_000 })
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 120_000 })

    // Upload the audit costume (additive only; existing costumes untouched).
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'partial-audit.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(AUDIT_SVG, 'utf8'),
    })
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
      beforeCards,
      { timeout: 30_000 },
    )
    const cards = page.getByTestId(/costume-card-\d+/)
    await cards.last().getByRole('button', { name: /Select / }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    }
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('module audit: double opacity folds once, !important/class/href/external fail closed', async () => {
    const report = await page.evaluate(async (svgText: string) => {
      const mod = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-selection-style.ts'
      )
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const byId = (id: string) => doc.documentElement.querySelector(`#${id}`)!
      const noGradient = () => undefined
      const hrefResolver = (id: string) => {
        // #href-child carries NO stops of its own (inherits via href): the
        // reader must fail closed to MIXED, never sample an empty ramp.
        if (id === 'href-child') {
          return { tag: 'linearGradient', x1: '0', y1: '0', x2: '480', y2: '0', stops: [] }
        }
        return undefined
      }
      const double = mod.readVectorElementPaintDetailed(byId('double'), noGradient)
      const important = mod.readVectorElementPaintDetailed(byId('important'), noGradient)
      const classed = mod.readVectorElementPaintDetailed(byId('classed'), noGradient)
      const hreftest = mod.readVectorElementPaintDetailed(byId('hreftest'), hrefResolver)
      const external = mod.readVectorElementPaintDetailed(byId('external'), noGradient)
      const fallback = mod.readVectorElementPaintDetailed(byId('fallback'), noGradient)
      const summary = mod.summarizeDetailedVectorElementPaints([fallback, classed])
      // Fail-closed merge: an explicit fill patch over an unknown side skips.
      const skipped = mod.mergeDetailedPaintWithPatch(classed, {
        fill: { r: 0, g: 255, b: 0, a: 255 },
      })
      const widthOnly = mod.mergeDetailedPaintWithPatch(double, { strokeWidth: 10 })
      return {
        doubleFill: double.fill,
        doubleOpacity: double.opacity,
        doubleWidth: double.strokeWidth,
        importantFill: important.fill,
        importantStroke: important.stroke,
        classedFill: classed.fill,
        hrefFill: hreftest.fill,
        hrefGradient: hreftest.fillGradient,
        externalFill: external.fill,
        fallbackFill: fallback.fill,
        summaryFill: summary.fill,
        summaryWidth: summary.strokeWidth,
        skippedFill: skipped.skipped.fill,
        skippedPatchFill: skipped.fill,
        widthOnlyFill: widthOnly.fill,
        widthOnlySkippedFill: widthOnly.skipped.fill,
        widthOnlyWidth: widthOnly.strokeWidth,
      }
    }, AUDIT_SVG)
    // fill-opacity 0.5 folds into alpha ONCE (128), parent 0.5 stays in opacity (50).
    expect(report.doubleFill).toEqual({ r: 255, g: 0, b: 0, a: 128 })
    expect(report.doubleOpacity).toBe(50)
    expect(report.doubleWidth).toBe(2)
    // `!important` is stripped for reading: inline still wins over attributes.
    expect(report.importantFill).toEqual({ r: 0, g: 255, b: 0, a: 255 })
    expect(report.importantStroke).toEqual({ r: 17, g: 17, b: 17, a: 255 })
    // class + presentation attribute: CSS is invisible -> MIXED, never #ff0000.
    expect(report.classedFill).toBe('MIXED')
    // Stop-less href gradient: MIXED on the whole side (fail-closed).
    expect(report.hrefFill).toBe('MIXED')
    expect(report.hrefGradient).toBe('MIXED')
    // External url(): not a local fragment -> MIXED.
    expect(report.externalFill).toBe('MIXED')
    // url(#missing) with solid fallback reads the fallback concretely.
    expect(report.fallbackFill).toEqual({ r: 255, g: 255, b: 0, a: 255 })
    // Unknown paint poisons the paint fields, and a class may also set
    // stroke-width: fail-closed poisons every unresolvable field.
    expect(report.summaryFill).toBe('MIXED')
    expect(report.summaryWidth).toBe('MIXED')
    // Explicit fill over unknown side is skipped, never invented.
    expect(report.skippedFill).toBe(true)
    expect(report.skippedPatchFill).toBe(null)
    // Width-only merge keeps the folded fill: no fill write at all
    // (`fill: null`, `skipped.fill: false`), width applied.
    expect(report.widthOnlyFill).toBe(null)
    expect(report.widthOnlySkippedFill).toBe(false)
    expect(report.widthOnlyWidth).toBe(10)
  }, 60_000)

  it('width-only edit never double-applies opacity and leaves neighbours/parent alone', async () => {
    await ensureAuditCostume()
    await page.getByTestId('vector-shape-select').last().click()
    // Select-all first (the single-select narrowing below starts from here).
    // Selection alone must never rewrite the artwork.
    const beforeSelect = await previewSvg()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    expect(await previewSvg()).toBe(beforeSelect)
    const before = beforeSelect
    const beforeUnits = await unitAttrs(before)
    const beforeParent = await outerGroupAttrs(before)
    expect(beforeUnits.length).toBe(7)
    expect(beforeParent).toEqual({ opacity: '0.5', transform: 'translate(10,20)' })

    // Narrow to ONLY #double (units-list order == document order, so index
    // 0 is #double). Narrowing the selection itself must not rewrite art.
    await selectSingleUnitByIndex(0)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 1,
      null,
      { timeout: 10_000 },
    )
    expect(await previewSvg()).toBe(before)

    // Reload guard: re-assert the single selection right before the edit.
    await ensureSingleDoubleSelection()
    expect(await previewSvg()).toBe(before)

    const widthInput = page.getByLabel('Stroke width', { exact: true })
    // Reload-resilient width edit: without a selection the immediate apply
    // writes nothing (dirty stays, preview unchanged), so re-select and retry.
    for (let attempt = 1; ; attempt++) {
      await ensureSingleDoubleSelection()
      expect(await previewSvg()).toBe(before)
      await widthInput.evaluate((el, v) => {
        const input = el as HTMLInputElement
        input.value = v as string
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }, '10')
      try {
        await waitForPreviewChange(before)
        break
      } catch (error) {
        if (attempt >= 4) throw error
      }
    }
    const after = await previewSvg()
    const afterUnits = await unitAttrs(after)
    const byId = (units: UnitAttrs[], id: string) => units.find((u) => u.id === id)!

    // Target: only the width changed; fill + fill-opacity byte-identical
    // (no double-dimming rewrite into the color).
    expect(byId(afterUnits, 'double').strokeWidth).toBe('10')
    expect(byId(afterUnits, 'double').fill).toBe(byId(beforeUnits, 'double').fill)
    expect(byId(afterUnits, 'double').fillOpacity).toBe(byId(beforeUnits, 'double').fillOpacity)
    // Neighbour + every other unit completely untouched (attrs + style).
    for (const id of ['important', 'classed', 'hreftest', 'fallback', 'external', 'neighbor']) {
      expect(byId(afterUnits, id)).toEqual(byId(beforeUnits, id))
    }
    // Parent opacity/transform semantically identical (no flattening into
    // children; the round-trip may normalize `translate(10,20)` separators).
    const afterParent = await outerGroupAttrs(after)
    expect(afterParent.opacity).toBe(beforeParent.opacity)
    expect(normTransform(afterParent.transform)).toBe(normTransform(beforeParent.transform))
    expect(await parentTransformTranslate(after)).toEqual(await parentTransformTranslate(before))
    // Pixels: neighbour region identical, target region changed (sanity).
    expect(await regionPixelDiff(before, after, RENDERED_REGIONS.neighbor!)).toBe(0)

    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      before,
      { timeout: 10_000 },
    )
    await page.keyboard.press('Escape')
  }, 180_000)

  it('explicit fill apply: known sides change once, unknown sides keep SVG+pixel invariance', async () => {
    await ensureAuditCostume()
    await page.getByTestId('vector-shape-select').last().click()
    const beforeSelect = await previewSvg()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    // Mixed selection shows the MIXED badge; selecting never rewrites art.
    expect(await page.getByTestId('mixed-fill').count()).toBe(1)
    expect(await previewSvg()).toBe(beforeSelect)
    const before = beforeSelect
    const beforeUnits = await unitAttrs(before)
    const beforeParent = await outerGroupAttrs(before)
    const byId = (units: UnitAttrs[], id: string) => units.find((u) => u.id === id)!
    // Live unknown-fill set on the sanitized preview DOM. `classed` must be
    // in it (class + attribute => MIXED); whatever else the importer already
    // normalized (e.g. an external url() stripped to default-black) is
    // legitimately known from here on and excluded from the skip assertions.
    const unknownIds = (await unknownFillIds(before)).filter((id): id is string => id !== null)
    expect(unknownIds).toContain('classed')
    expect(unknownIds.length).toBeGreaterThan(0)

    await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
    // Reload-resilient Apply: another agent's HMR save wipes component
    // selection (Apply disables) and may reset toolbar state, so re-select,
    // re-fill, and retry the click. A disabled button never dispatches, so a
    // timed-out click wrote nothing and retrying is safe.
    for (let attempt = 1; ; attempt++) {
      await ensureSelectAllOnAudit()
      expect(await previewSvg()).toBe(before)
      await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
      try {
        await applyButton().click({ timeout: 8_000 })
        break
      } catch (error) {
        if (attempt >= 4) throw error
      }
    }
    await waitForPreviewChange(before)
    const after = await previewSvg()
    const afterUnits = await unitAttrs(after)

    // Known sides adopt the new fill exactly once: stale fill-opacity removed
    // (otherwise the new paint would double-dim), parent opacity NOT flattened.
    const doubleAfter = byId(afterUnits, 'double')
    expect(doubleAfter.fill?.toLowerCase()).toBe('#00ff00')
    expect(doubleAfter.fillOpacity).toBe(null)
    expect(doubleAfter.style ?? '').not.toMatch(/fill-opacity/i)
    const afterParent = await outerGroupAttrs(after)
    expect(afterParent.opacity).toBe(beforeParent.opacity)
    expect(normTransform(afterParent.transform)).toBe(normTransform(beforeParent.transform))
    expect(await parentTransformTranslate(after)).toEqual(await parentTransformTranslate(before))
    // Fallback-solid rect is known: adopts the new fill.
    expect(byId(afterUnits, 'fallback').fill?.toLowerCase()).toBe('#00ff00')
    // Fail-closed: every live-unknown unit keeps byte-identical paint
    // (fill + style), never guessed.
    for (const id of unknownIds) {
      expect(byId(afterUnits, id).fill).toBe(byId(beforeUnits, id).fill)
      expect(byId(afterUnits, id).style).toBe(byId(beforeUnits, id).style)
    }
    // Dropped-style hygiene: unrelated `style` props survive the fill rewrite
    // (stroke-dasharray kept), rewritten props leave `style` for attributes.
    const importantAfter = byId(afterUnits, 'important')
    expect(importantAfter.fill?.toLowerCase()).toBe('#00ff00')
    expect(importantAfter.style ?? '').toContain('stroke-dasharray')
    expect(importantAfter.style ?? '').not.toMatch(/(^|;)\s*fill\s*:/i)
    // A fill-only patch never moves widths.
    expect(afterUnits.map((u) => u.strokeWidth)).toEqual(beforeUnits.map((u) => u.strokeWidth))
    // Parent transform of every unit untouched.
    for (const unit of afterUnits) expect(unit.transform).toBe(null)
    // The user is told unknown sides were skipped, not silently flattened.
    expect(await editorStatus()).toMatch(/skipped|MIXED/i)
    // Pixels: unknown rects render identically (fail-closed, no visual change).
    for (const id of unknownIds) {
      const region = RENDERED_REGIONS[id]
      if (!region) continue
      expect(await regionPixelDiff(before, after, region)).toBe(0)
    }

    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      before,
      { timeout: 10_000 },
    )
    expect(await unitAttrs(await previewSvg())).toEqual(beforeUnits)
    await page.keyboard.press('Escape')
  }, 180_000)
})
