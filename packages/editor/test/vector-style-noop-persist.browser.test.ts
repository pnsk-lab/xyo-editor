import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Style no-op persistence on the real editor UI (independent port 4361).
// Covers the deferred-history fix: an unchanged / same-value / fully-skipped
// (MIXED) Apply must not capture history (no empty Undo step) and must not
// clear the redo stack. Product code is untouched; this file is additive only.
//
// - stroke width change -> unchanged Apply -> single Undo restores the width
// - same-value fill / same-value width Apply stays a clean no-op
// - redo survives every no-op Apply (undo then no-op then redo still works)
// - unknown (class-controlled, fail-closed MIXED) fill is skipped without
//   history while known sides still apply
// - selection owner switch drops stale fill dirty (A edit never leaks to B)
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4361'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const NOOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect id="known" x="20" y="20" width="140" height="100" fill="#ff0000" stroke="#000000" stroke-width="2"/><rect id="mystery" x="300" y="20" width="140" height="100" class="themed" fill="#ff0000" stroke="none"/></svg>`

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

async function editorStatus(): Promise<string> {
  return await page.evaluate(
    () => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status(),
  )
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

async function outlineBoxes(): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-vector-selection-outline]')).map((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
  })
}

async function selectedOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline].border-blue-500').count()
}

async function clearCanvas() {
  await page.getByTestId('vector-shape-select').last().click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-vector-selection-outline]').length === 0,
    null,
    { timeout: 10_000 },
  )
}

async function drawRect(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.getByTestId('vector-shape-rect').last().click()
  const before = await previewSvg()
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await waitForPreviewChange(before)
}

async function setWidthImmediate(value: string) {
  await page
    .getByLabel('Stroke width', { exact: true })
    .first()
    .evaluate((el, v) => {
      const input = el as HTMLInputElement
      input.focus()
      input.value = v as string
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
}

async function rectFills(svgText: string): Promise<(string | null)[]> {
  return await page.evaluate(async (svg: string) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return Array.from(doc.documentElement.querySelectorAll('rect')).map((el) => el.getAttribute('fill'))
  }, svgText)
}

async function clickOutlineCenter(box: { x: number; y: number; width: number; height: number }) {
  await page.getByTestId('vector-shape-select').last().click()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.up()
}

async function selectSingleUnitByIndex(index: number) {
  // Production units-list path (same selectVectorObject handler as visible
  // clicks). Used for the uploaded costume where canvas hit-testing is
  // geometry-sensitive; the click is a real dispatched MouseEvent.
  await page.evaluate((i: number) => {
    const buttons = Array.from(document.querySelectorAll('div.max-h-32 > button'))
    const btn = buttons[i] as HTMLElement | undefined
    if (!btn) throw new Error(`unit button ${i} missing`)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  }, index)
}

describe('vector style no-op persistence (real editor)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4361', '--strictPort'], {
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

  it('width change then unchanged Apply stays undo-clean: one Undo restores the width', async () => {
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2

    await clearCanvas()
    await page.getByLabel('Vector paint style').selectOption('solid')
    await page.getByLabel('Vector stroke style').selectOption('solid')
    await drawRect({ x: centerX - 60, y: centerY - 40 }, { x: centerX + 60, y: centerY + 40 })
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 1,
      null,
      { timeout: 10_000 },
    )

    const baseSvg = await previewSvg()
    const baseWidths = (await unitPaints(baseSvg)).map((u) => u.strokeWidth)
    expect(baseWidths.length).toBeGreaterThanOrEqual(1)

    // Immediate width write: one real history entry.
    await setWidthImmediate('9')
    await waitForPreviewChange(baseSvg)
    const afterWidth = await previewSvg()
    for (const unit of await unitPaints(afterWidth)) expect(unit.strokeWidth).toBe('9')

    // Unchanged Apply: enabled (selection exists) but must be a no-op.
    expect(await applyButton().isDisabled()).toBe(false)
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(afterWidth)
    expect(await editorStatus()).toMatch(/No paint change/)

    // No empty history was pushed: a single Undo restores the base width.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      baseSvg,
      { timeout: 10_000 },
    )
    expect((await unitPaints(await previewSvg())).map((u) => u.strokeWidth)).toEqual(baseWidths)

    // And redo reapplies the width change.
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterWidth,
      { timeout: 10_000 },
    )
    for (const unit of await unitPaints(await previewSvg())) expect(unit.strokeWidth).toBe('9')

    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0,
      null,
      { timeout: 10_000 },
    )
  }, 120_000)

  it('same-value fill/width Apply is a no-op and keeps the redo stack', async () => {
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 1,
      null,
      { timeout: 10_000 },
    )
    const baseSvg = await previewSvg()

    // Real fill change so there is something on the redo stack after undo.
    // The first Apply writes explicit fills onto every selected unit
    // (including wrapper groups), so a repeat with the same value is a true
    // same-value no-op rather than a wrapper-default mismatch.
    await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
    await applyButton().click()
    await waitForPreviewChange(baseSvg)
    const afterFill = await previewSvg()
    expect(((await rectFills(afterFill))[0] ?? '').toLowerCase()).toBe('#00ff00')

    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      baseSvg,
      { timeout: 10_000 },
    )
    expect(await redoButton().isDisabled()).toBe(false)

    // Unchanged Apply with no new edits (empty patch): no history, redo kept.
    expect(await applyButton().isDisabled()).toBe(false)
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(baseSvg)
    expect(await editorStatus()).toMatch(/No paint change/)
    expect(await redoButton().isDisabled()).toBe(false)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterFill,
      { timeout: 10_000 },
    )

    // Same-value fill with an explicit dirty field but no effective change:
    // every unit already carries #00ff00, so re-applying it must not push
    // history. A single Undo afterwards must restore the base.
    await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(afterFill)
    expect(await editorStatus()).toMatch(/No paint change/)
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      baseSvg,
      { timeout: 10_000 },
    )
    // Redo still reapplies the one real fill change.
    expect(await redoButton().isDisabled()).toBe(false)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterFill,
      { timeout: 10_000 },
    )

    // Same-value width via the immediate path: no preview change, no history.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      baseSvg,
      { timeout: 10_000 },
    )
    expect(await redoButton().isDisabled()).toBe(false)
    const currentWidth = (await unitPaints(baseSvg))[0]?.strokeWidth ?? '9'
    await setWidthImmediate(currentWidth)
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(baseSvg)
    expect(await editorStatus()).toMatch(/No paint change/)
    expect(await redoButton().isDisabled()).toBe(false)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterFill,
      { timeout: 10_000 },
    )

    await page.keyboard.press('Escape')
  }, 120_000)

  it('unknown MIXED fill is skipped without history while known sides still apply', async () => {
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'style-noop-mixed.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(NOOP_SVG, 'utf8'),
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

    await page.getByTestId('vector-shape-select').last().click()
    const beforeSelect = await previewSvg()
    expect(beforeSelect).toContain('known')
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    // Selection alone never rewrites; class-controlled fill shows MIXED.
    expect(await previewSvg()).toBe(beforeSelect)
    expect(await page.getByTestId('mixed-fill').count()).toBe(1)

    // Explicit fill: known adopts it, mystery (class -> MIXED) is skipped.
    await page.getByLabel('Paint color', { exact: true }).first().fill('#00ff00')
    await page.waitForTimeout(300)
    expect(await previewSvg()).toBe(beforeSelect)
    await applyButton().click()
    await waitForPreviewChange(beforeSelect)
    const afterSkip = await previewSvg()
    const paints = await unitPaints(afterSkip)
    expect(paints.length).toBeGreaterThanOrEqual(2)
    const byOrder = paints.map((p) => p.fill?.toLowerCase() ?? '')
    // Document order: known first, mystery second.
    expect(byOrder[0]).toBe('#00ff00')
    expect(byOrder[1]).not.toBe('#00ff00')
    expect(await editorStatus()).toMatch(/skipped|MIXED/i)

    // One Undo restores both, one Redo reapplies the partial result.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSelect,
      { timeout: 10_000 },
    )
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterSkip,
      { timeout: 10_000 },
    )

    // Fully-skipped Apply on the unknown unit alone: no history, redo kept.
    // Document order is known (0) then mystery (1): select mystery through
    // the production units-list handler (real dispatched click event).
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSelect,
      { timeout: 10_000 },
    )
    expect(await redoButton().isDisabled()).toBe(false)
    await selectSingleUnitByIndex(1)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 1,
      null,
      { timeout: 10_000 },
    )
    await page.getByLabel('Paint color', { exact: true }).first().fill('#0000ff')
    await page.waitForTimeout(300)
    const mysteryBefore = await previewSvg()
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(mysteryBefore)
    expect(await editorStatus()).toMatch(/skipped|MIXED|No paint change/i)
    // The skipped Apply did not consume the redo from the earlier partial edit.
    expect(await redoButton().isDisabled()).toBe(false)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterSkip,
      { timeout: 10_000 },
    )

    await page.keyboard.press('Escape')
  }, 180_000)

  it('selection owner switch drops stale fill dirty instead of leaking it', async () => {
    await clearCanvas()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    await page.getByLabel('Vector paint style').selectOption('solid')
    await page.getByLabel('Vector stroke style').selectOption('solid')
    await drawRect({ x: centerX - 150, y: centerY - 40 }, { x: centerX - 50, y: centerY + 40 })
    await drawRect({ x: centerX + 50, y: centerY - 40 }, { x: centerX + 150, y: centerY + 40 })

    async function leftmostBox() {
      const boxes = await outlineBoxes()
      const wide = boxes
        .map((b, i) => ({ ...b, i }))
        .filter((b) => b.width >= 20 && b.height >= 20)
        .sort((a, b) => a.x - b.x)
      if (wide.length < 2) throw new Error(`expected 2 rects, got ${JSON.stringify(boxes)}`)
      return { left: wide[0]!, right: wide[wide.length - 1]! }
    }

    // Select A (left), stage a fill without Apply.
    let ends = await leftmostBox()
    await clickOutlineCenter(ends.left)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 1,
      null,
      { timeout: 10_000 },
    )
    const stagedBase = await previewSvg()
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    await page.waitForTimeout(400)
    expect(await previewSvg()).toBe(stagedBase)
    expect(await applyButton().isDisabled()).toBe(false)

    // Switch to B: stale A dirty is dropped, so Apply is a no-op.
    ends = await leftmostBox()
    await clickOutlineCenter(ends.right)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 1,
      null,
      { timeout: 10_000 },
    )
    expect(await previewSvg()).toBe(stagedBase)
    const bNoOpBefore = await previewSvg()
    const bFillBefore = ((await unitPaints(bNoOpBefore))[1]?.fill ?? '').toLowerCase()
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(bNoOpBefore)
    expect(await editorStatus()).toMatch(/No paint change/)

    // On B, edit only the stroke and Apply: B stroke changes, B fill keeps its
    // own value (never A's staged #ff0000), A is untouched.
    await page.getByLabel('Stroke color', { exact: true }).first().fill('#0000ff')
    await page.waitForTimeout(300)
    expect(await previewSvg()).toBe(stagedBase)
    await applyButton().click()
    await waitForPreviewChange(stagedBase)
    const afterOwner = await previewSvg()
    const ownerPaints = await unitPaints(afterOwner)
    // Rightmost unit in DOM order corresponds to B geometrically here.
    const bPaint = ownerPaints[ownerPaints.length - 1]!
    const aPaint = ownerPaints[0]!
    expect(bPaint.stroke?.toLowerCase()).toBe('#0000ff')
    expect(bPaint.fill?.toLowerCase()).toBe(bFillBefore)
    expect(bPaint.fill?.toLowerCase()).not.toBe('#ff0000')
    expect(aPaint.fill?.toLowerCase()).not.toBe('#ff0000')

    // History stays clean: undo restores, redo reapplies, follow-up Apply no-ops.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      stagedBase,
      { timeout: 10_000 },
    )
    expect(await selectedOutlineCount()).toBe(1)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterOwner,
      { timeout: 10_000 },
    )
    const redoNoOpBefore = await previewSvg()
    await applyButton().click()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(redoNoOpBefore)

    await page.keyboard.press('Escape')
  }, 180_000)
})
