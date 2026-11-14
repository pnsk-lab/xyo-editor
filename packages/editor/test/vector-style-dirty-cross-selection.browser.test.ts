import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// vectorStyleDirty cross-selection (real editor).
// Spec: each dirty field carries the selection key observed when marked.
// `none` (prepared while deselected) is a preset and survives selection
// changes; any selection-owned dirty is discarded on selection-set change
// (A->B, multi add/remove, marquee, select-all), so stale A intent never
// leaks into B. Escape / clearVectorObjectSelection resets everything,
// Apply touches only dirty fields, immediate width/opacity write through,
// and undo/redo drops selection-owned dirty while keeping presets.
//   (A) fixed flow: select A, set fill (unapplied) -> select B, set only
//       stroke -> Apply. B gets only the stroke.
//   (B) preset flow: deselected, preset fill+stroke -> select B -> Apply.
//       B gets both by design.
//   (C) multi: select A, set fill -> select-all drops it; stroke-only Apply
//       touches every unit but never the stale fill.
//   (D) immediate width + history: width writes through with no Apply,
//       undo/redo restores artwork while selection survives and Apply stays
//       disabled (no stale dirty).
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4345'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

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

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

type UnitPaint = {
  fill: string | null
  stroke: string | null
  strokeWidth: string | null
  opacity: string | null
}

async function unitPaints(svgText: string): Promise<UnitPaint[]> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return editableVectorUnits(doc.documentElement).map((element: Element) => ({
      fill: element.getAttribute('fill'),
      stroke: element.getAttribute('stroke'),
      strokeWidth: element.getAttribute('stroke-width'),
      opacity: element.getAttribute('opacity'),
    }))
  }, svgText)
}

async function ensureToggle(name: string, wantOn: boolean) {
  const toggle = page.getByRole('button', { name })
  await toggle.waitFor({ state: 'visible', timeout: 10_000 })
  const pressed = await toggle.getAttribute('aria-pressed')
  if ((pressed === 'true') !== wantOn) await toggle.click()
}

async function outlineBoxes(): Promise<Array<{ x: number; y: number; width: number; height: number; blue: boolean }>> {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-vector-selection-outline]')).map((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, blue: el.classList.contains('border-blue-500') }
    })
  })
}

async function realOutlineIndices(): Promise<number[]> {
  // After clear+draw there can be a tiny residual outline (8x8, off-canvas)
  // that is not one of the two drawn rects (100x80). Filter to the drawn
  // rects so leftmost/rightmost reliably mean A/B.
  const boxes = await outlineBoxes()
  return boxes
    .map((box, i) => ({ box, i }))
    .filter(({ box }) => box.width >= 20 && box.height >= 20)
    .sort((a, b) => a.box.x - b.box.x)
    .map(({ i }) => i)
}

async function clickToSelectLeftmost(): Promise<number> {
  // Visible-only selection: the Objects list lives in the hidden legacy panel
  // (div.hidden), so select by clicking the canvas through the
  // pointer-events-none outline (paper hit-test selects the object).
  // Returns the DOM index of the outline now selected.
  await page.getByTestId('vector-shape-select').last().click()
  const boxes = await outlineBoxes()
  const real = await realOutlineIndices()
  if (real.length < 2) throw new Error(`Expected >=2 real outlines, got ${real.length} of ${boxes.length}: ${JSON.stringify(boxes)}`)
  const leftDom = real[0]!
  const target = boxes[leftDom]!
  const cx = target.x + target.width / 2
  const cy = target.y + target.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 1,
    null,
    { timeout: 10_000 },
  )
  return await selectedOutlineIndex()
}

async function clickToSelectRightmost(): Promise<number> {
  await page.getByTestId('vector-shape-select').last().click()
  const boxes = await outlineBoxes()
  const real = await realOutlineIndices()
  if (real.length < 2) throw new Error(`Expected >=2 real outlines, got ${real.length} of ${boxes.length}: ${JSON.stringify(boxes)}`)
  const rightDom = real[real.length - 1]!
  const target = boxes[rightDom]!
  const cx = target.x + target.width / 2
  const cy = target.y + target.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 1,
    null,
    { timeout: 10_000 },
  )
  return await selectedOutlineIndex()
}

async function selectedOutlineIndex(): Promise<number> {
  return await page.evaluate(() => {
    const outlines = Array.from(document.querySelectorAll('[data-vector-selection-outline]'))
    return outlines.findIndex((el) => el.classList.contains('border-blue-500'))
  })
}

async function selectedOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline].border-blue-500').count()
}

describe('vectorStyleDirty drops selection-owned edits on selection change (real browser)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4345', '--strictPort'], {
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
    await surface.waitFor({ state: 'visible', timeout: 60_000 })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 60_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('selection-derived dirty is dropped on selection change while deselected presets survive; multi/history stay safe', async () => {
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

    // Blank canvas: two rects A (left) and B (right).
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline]').length === 0,
      null,
      { timeout: 10_000 },
    )
    await drawRect({ x: centerX - 150, y: centerY - 40 }, { x: centerX - 50, y: centerY + 40 })
    await drawRect({ x: centerX + 50, y: centerY - 40 }, { x: centerX + 150, y: centerY + 40 })
    expect(await page.locator('[data-vector-selection-outline]').count()).toBeGreaterThanOrEqual(2)

    // Deterministic paint baseline: solid, opaque.
    await page.getByLabel('Vector paint style').selectOption('solid')
    await page.getByLabel('Vector stroke style').selectOption('solid')
    await ensureToggle('Transparent fill', false)
    await ensureToggle('Transparent stroke', false)

    // ---- Flow A (fixed: no leak) ----
    // Select A, set fill to #ff0000 without Apply: preview must not change
    // (deferred fill path only marks dirty).
    const countAfterDraw = await page.locator('[data-vector-selection-outline]').count()
    console.log(`[dirty-cross] outlines after draw=${countAfterDraw} boxes=${JSON.stringify(await outlineBoxes())}`)
    const realBefore = await realOutlineIndices()
    const indexA = await clickToSelectLeftmost()
    console.log(`[dirty-cross] selected A domIndex=${indexA} expectLeft=${realBefore[0]} boxes=${JSON.stringify(await outlineBoxes())}`)
    expect(indexA).toBe(realBefore[0])
    const beforeFillEdit = await previewSvg()
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    // Selection display alone must never rewrite the artwork.
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(beforeFillEdit)
    expect(await applyButton().isDisabled()).toBe(false)

    // Switch to B. Selection-derived dirty is dropped: Apply stays enabled
    // (it enables on selection) but is a no-op, and the preview is untouched.
    const realMid = await realOutlineIndices()
    const indexB = await clickToSelectRightmost()
    console.log(`[dirty-cross] selected B domIndex=${indexB} expectRight=${realMid[realMid.length - 1]} boxes=${JSON.stringify(await outlineBoxes())}`)
    expect(indexB).toBe(realMid[realMid.length - 1])
    expect(indexB).not.toBe(indexA)
    expect(await previewSvg()).toBe(beforeFillEdit)
    expect(await applyButton().isDisabled()).toBe(false)
    const noOpBefore = await previewSvg()
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(noOpBefore)
    const paintsBeforeApplyA = await unitPaints(beforeFillEdit)
    const bFillBefore = paintsBeforeApplyA[indexB]?.fill?.toLowerCase() ?? ''

    // On B, edit ONLY the stroke to #0000ff, then Apply.
    await page.getByLabel('Stroke color', { exact: true }).first().fill('#0000ff')
    await page.waitForTimeout(300)
    expect(await previewSvg()).toBe(beforeFillEdit)
    expect(await applyButton().isDisabled()).toBe(false)
    const beforeApplyA = await previewSvg()
    await applyButton().click()
    await waitForPreviewChange(beforeApplyA)
    const afterA = await previewSvg()
    const paintsA = await unitPaints(afterA)
    expect(paintsA.length).toBeGreaterThanOrEqual(2)
    // Map DOM order to geometry among the real (drawn-rect) outlines:
    // leftmost real DOM index is A, rightmost is B. The tiny residual
    // outline (if any) is excluded from the mapping.
    const realAfterA = await realOutlineIndices()
    const domA = realAfterA[0]!
    const domB = realAfterA[realAfterA.length - 1]!
    expect(domA).not.toBe(domB)
    const aFill = paintsA[domA]?.fill?.toLowerCase() ?? ''
    const bFill = paintsA[domB]?.fill?.toLowerCase() ?? ''
    const bStroke = paintsA[domB]?.stroke?.toLowerCase() ?? ''
    console.log(`[dirty-cross] flowA domA=${domA} domB=${domB} A.fill=${paintsA[domA]?.fill} B.fill=${paintsA[domB]?.fill} B.stroke=${paintsA[domB]?.stroke}`)
    // B got the stroke edited while B was selected...
    expect(bStroke).toBe('#0000ff')
    // ...but B must NOT get A's unapplied fill. A itself keeps its own paint.
    expect(bFill).not.toBe('#ff0000')
    expect(bFill).toBe(bFillBefore)
    expect(aFill).not.toBe('#ff0000')

    // History stays safe: undo restores, redo reapplies, and the selection
    // survives with no stale dirty resurrected.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeApplyA,
      { timeout: 10_000 },
    )
    expect(await selectedOutlineCount()).toBe(1)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterA,
      { timeout: 10_000 },
    )
    expect(await selectedOutlineCount()).toBe(1)
    // Follow-up Apply is a no-op (dirty was consumed by the first Apply).
    const redoNoOpBefore = await previewSvg()
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(redoNoOpBefore)

    // ---- Flow B (supported preset-then-select) ----
    // Escape clears dirty (clearVectorObjectSelection) without touching art.
    const beforeEscape = await previewSvg()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0,
      null,
      { timeout: 10_000 },
    )
    expect(await applyButton().isDisabled()).toBe(true)
    expect(await previewSvg()).toBe(beforeEscape)

    // Preset while deselected: no preview change, both fields dirty.
    await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
    await page.getByLabel('Stroke color', { exact: true }).first().fill('#ff00ff')
    await page.waitForTimeout(300)
    expect(await previewSvg()).toBe(beforeEscape)

    // Select B and Apply: both land on B by design (preset survives).
    await clickToSelectRightmost()
    expect(await previewSvg()).toBe(beforeEscape)
    expect(await applyButton().isDisabled()).toBe(false)
    const beforeApplyB = await previewSvg()
    await applyButton().click()
    await waitForPreviewChange(beforeApplyB)
    const afterB = await previewSvg()
    const paintsB = await unitPaints(afterB)
    const realAfterB = await realOutlineIndices()
    const domB2 = realAfterB[realAfterB.length - 1]!
    const domA2 = realAfterB[0]!
    console.log(`[dirty-cross] flowB domB=${domB2} B.fill=${paintsB[domB2]?.fill} B.stroke=${paintsB[domB2]?.stroke} paints=${JSON.stringify(paintsB)}`)
    expect(paintsB[domB2]?.fill?.toLowerCase()).toBe('#00ff00')
    expect(paintsB[domB2]?.stroke?.toLowerCase()).toBe('#ff00ff')
    // The preset applied only to the current selection B, never to A.
    expect(paintsB[domA2]?.fill?.toLowerCase()).not.toBe('#00ff00')

    // ---- Flow C (multi add/remove drops selection-derived dirty) ----
    const beforeMulti = await previewSvg()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0,
      null,
      { timeout: 10_000 },
    )
    await clickToSelectLeftmost()
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff1111')
    await page.waitForTimeout(300)
    expect(await previewSvg()).toBe(beforeMulti)
    expect(await applyButton().isDisabled()).toBe(false)
    // Select-all changes the set (A -> A+B...): stale A fill is dropped.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    expect(await previewSvg()).toBe(beforeMulti)
    // Stale A fill was dropped: Apply is a no-op until a new edit lands.
    const multiNoOpBefore = await previewSvg()
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(multiNoOpBefore)
    // Stroke-only Apply touches every selected unit but never the stale fill.
    await page.getByLabel('Stroke color', { exact: true }).first().fill('#00ffff')
    expect(await applyButton().isDisabled()).toBe(false)
    const beforeApplyC = await previewSvg()
    await applyButton().click()
    await waitForPreviewChange(beforeApplyC)
    const paintsC = await unitPaints(await previewSvg())
    for (const unit of paintsC) {
      expect(unit.fill?.toLowerCase()).not.toBe('#ff1111')
      expect(unit.stroke?.toLowerCase()).toBe('#00ffff')
    }

    // ---- Flow D (immediate width writes through; undo/redo safe) ----
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0,
      null,
      { timeout: 10_000 },
    )
    await clickToSelectRightmost()
    const beforeWidth = await previewSvg()
    await page.getByLabel('Stroke width', { exact: true }).first().evaluate((el, v) => {
      const input = el as HTMLInputElement
      input.focus()
      input.value = v as string
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, '9')
    // Immediate path: preview changes with no Apply; the write-through
    // consumes its dirty, so a follow-up Apply is a no-op.
    await waitForPreviewChange(beforeWidth)
    const afterWidth = await previewSvg()
    const paintsW = await unitPaints(afterWidth)
    const realW = await realOutlineIndices()
    const domWB = realW[realW.length - 1]!
    expect(paintsW[domWB]?.strokeWidth).toBe('9')
    await undoButton().click()
    await page.waitForFunction(
      (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
      afterWidth,
      { timeout: 10_000 },
    )
    const undoneWidth = await previewSvg()
    const paintsUndone = await unitPaints(undoneWidth)
    expect(paintsUndone[domWB]?.strokeWidth).not.toBe('9')
    await redoButton().click()
    await page.waitForFunction(
      (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
      undoneWidth,
      { timeout: 10_000 },
    )
    const redoneWidth = await previewSvg()
    const paintsRedone = await unitPaints(redoneWidth)
    expect(paintsRedone[domWB]?.strokeWidth).toBe('9')
    expect(await selectedOutlineCount()).toBe(1)
    // Immediate write consumed its dirty: follow-up Apply is a no-op.
    const finalNoOpBefore = await previewSvg()
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(finalNoOpBefore)
  }, 240_000)
})
