import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Mid-drag costume/sprite switch cancel audit (product code fixed):
// - pointerdown -> move (live preview) -> switch target while the button is
//   still held -> mouse up. The switch must cancel the drag: the OLD asset
//   is restored to its pre-drag snapshot, the NEW artwork is never
//   overwritten, the switch CLEARs the drawing history (Scratch parity: the
//   newly selected artwork starts with an independent session, so Undo/Redo
//   are disabled right after the switch), and a subsequent edit commits
//   singly (single Undo/Redo, no empty cancel entry).
// - A real pointer click on another card while the button is held is NOT
//   operable (the reshape handle holds pointer capture), so the switch is
//   driven through the real keyboard route (focus + Enter on the actual app
//   button), which reaches the same `selectCostume` / `selectTarget` handler
//   as a mouse click, plus the programmatic `selectCostume` path.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4348'
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function previewSvg() {
  return await page.locator('.vector-preview').innerHTML()
}

async function selectedCostumeMd5(index: number): Promise<string | null> {
  return await page.evaluate((costumeIndex: number) => {
    const api = (
      window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
    ).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest API')
    const snap = api.snapshot()
    const target = snap.project.targets.find(
      (candidate: any) => candidate.id === snap.selectedTargetId || candidate.name === snap.selectedTargetId,
    )
    return (target?.costumes[costumeIndex]?.md5ext as string | undefined) ?? null
  }, index)
}

async function waitForPreviewSvgChange(previous: string) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    previous,
  )
}

async function waitForPreviewSvg(expected: string) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML === svg, expected)
}

async function undoDisabled() {
  return await page.evaluate(
    () => (document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? 'missing',
  )
}

async function redoDisabled() {
  return await page.evaluate(
    () => (document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled ?? 'missing',
  )
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
    (count) => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length === count,
    expected,
  )
}

async function resetCanvasToRect() {
  await page.mouse.up().catch(() => {})
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByTestId('vector-shape-select').last().click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.waitForTimeout(700)
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)
  const rectTool = page.getByTestId('vector-shape-rect').last()
  await rectTool.click()
  const surface = page.getByTestId('costume-paint-surface')
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
  return { centerX, centerY }
}

async function ensureTwoCostumes() {
  const cards = page.locator('[data-testid^="costume-card-"]')
  if ((await cards.count()) >= 2) return
  await page.getByLabel('Add costume').click()
  await page.waitForTimeout(800)
  // Newer sidebar opens a menu from the fab: pick Paint there.
  if ((await cards.count()) < 2) {
    const paint = page.getByRole('menuitem', { name: 'Paint' })
    if ((await paint.count()) > 0) {
      await paint.first().click()
      await page.waitForTimeout(800)
    }
  }
  const count = await cards.count()
  expect(count).toBeGreaterThanOrEqual(2)
}

describe('vector reshape mid-drag switch cancel', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4348', '--strictPort'], {
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
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('mid-drag costume switch (keyboard route) restores the old asset, keeps the new one, CLEARs history', async () => {
    const { centerX, centerY } = await resetCanvasToRect()
    await ensureTwoCostumes()
    // Back to costume 0: the rect was drawn there. The switch clears the
    // object selection, so reselect the rect via canvas click before reshape.
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(600)
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(centerX, centerY)
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    const handles = page.locator('[data-vector-path-point]')
    await handles.first().click()
    await waitForSelectedCount(1)
    const svgOld = await previewSvg()
    const md5OldPreDrag = await selectedCostumeMd5(0)

    // Start a real drag: pointerdown -> move shows a live preview.
    const single = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(single.x, single.y)
    await page.mouse.down()
    await page.mouse.move(single.x + 60, single.y, { steps: 8 })
    await waitForPreviewSvgChange(svgOld)

    // Button still held: a real pointer click on the other card cannot reach
    // it (pointer capture), so drive the REAL app switch through the keyboard
    // route — focus + Enter on the same Select button a click would hit.
    const selectButton = page.locator('[data-testid="costume-card-1"] button[aria-label^="Select "]')
    await selectButton.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    const selectedName = await page
      .locator('[data-testid="costume-card-1"]')
      .getAttribute('class')
      .catch(() => '')
    expect(selectedName).toContain('border-[#7c3fdd]')
    // The newly selected costume is a blank bitmap asset: record its asset id
    // before releasing the stale drag.
    const md5NewAtSwitch = await selectedCostumeMd5(1)
    expect(md5NewAtSwitch).not.toBe(md5OldPreDrag)
    // Scratch parity: the costume switch CLEARs the drawing history, so right
    // after the switch (stale button still held) Undo/Redo are disabled.
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(true)
    // Release the stale drag over the new costume: must be a no-op that
    // neither touches the new asset nor commits history.
    await page.mouse.up()
    await page.waitForTimeout(600)
    expect(await selectedCostumeMd5(1)).toBe(md5NewAtSwitch)
    // The stale release commits nothing: history stays CLEARed.
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(true)

    // Back to the old costume: the pre-drag snapshot must be restored in the
    // preview (editor-space SVG string equality, the same level the existing
    // Esc-cancel audits assert; the stored raw bytes go through the same
    // snapshot re-encode as the Esc path rather than a raw-byte copy).
    // Reselect the rect first (the switch cleared the object selection).
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(600)
    const md5OldAfterRestore = await selectedCostumeMd5(0)
    console.log(`[diag] costume-switch: pre-drag=${md5OldPreDrag} after-restore=${md5OldAfterRestore}`)
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(centerX, centerY)
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    await waitForPreviewSvg(svgOld)

    // Scratch parity: every costume switch CLEARs the drawing history, so
    // returning to the old costume also starts with an independent session.
    // The cancelled drag leaves no entry behind: Undo/Redo stay disabled.
    // (Old spec asserted one Undo removes the rect here; CLEAR drops that
    // entry by design, so assert disabled instead — without relaxing the
    // SVG-equality verification above.)
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(true)

    // Post-switch edit serializes cleanly behind the cancel restore: exactly
    // one Undo entry for a fresh move. Reselect first: the switch cleared
    // the object selection.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(centerX, centerY)
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    const leg = page.locator('[data-vector-path-point]')
    await leg.first().click()
    await waitForSelectedCount(1)
    const from = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 30, from.y, { steps: 8 })
    await page.mouse.up()
    const svgMoved = await previewSvg()
    expect(svgMoved).not.toBe(svgOld)
    await undoButton.click()
    await waitForPreviewSvg(svgOld)
    // Exactly one entry for the fresh edit: after the single Undo the stack
    // is empty again (no empty cancel entry hides behind it).
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(false)
    await redoButton.click()
    await waitForPreviewSvg(svgMoved)
    // And after the single Redo there is nothing left to redo.
    expect(await undoDisabled()).toBe(false)
    expect(await redoDisabled()).toBe(true)
  }, 180_000)

  it('mid-drag sprite switch (keyboard route) restores the old sprite asset, keeps the new target, CLEARs history', async () => {
    // Explicit navigation: isolate from whatever the previous test left
    // selected (costume index / target).
    const spriteCardNav = page.locator('[data-testid^="target-card-Sprite"]').first()
    if ((await spriteCardNav.count()) > 0) {
      await spriteCardNav.click()
      await page.waitForTimeout(500)
    }
    await page.getByTestId('main-tab-costumes').click()
    await page.waitForTimeout(300)
    const costume0Nav = page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]')
    if ((await costume0Nav.count()) > 0) {
      await costume0Nav.click()
      await page.waitForTimeout(500)
    }
    const { centerX, centerY } = await resetCanvasToRect()
    const handles = page.locator('[data-vector-path-point]')
    await handles.first().click()
    await waitForSelectedCount(1)
    const svgOld = await previewSvg()
    const md5OldPreDrag = await selectedCostumeMd5(0)
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')

    const single = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(single.x, single.y)
    await page.mouse.down()
    await page.mouse.move(single.x + 55, single.y + 10, { steps: 8 })
    await waitForPreviewSvgChange(svgOld)

    // Keyboard route on the real app control: focus the stage card and Enter.
    // This reaches the same `selectTarget` handler as a sprite click.
    const stageCard = page.getByTestId('target-card-stage')
    await stageCard.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    // Target switch CLEARs the drawing history (Scratch parity): Undo/Redo
    // are disabled on the newly selected target even with the stale button
    // still held. Record the stage asset before releasing the stale drag.
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(true)
    const md5StageAtSwitch = await selectedCostumeMd5(0)
    await page.mouse.up()
    await page.waitForTimeout(600)
    // The stale release is a no-op: the stage asset is untouched and no
    // history is committed behind the cancel.
    expect(await selectedCostumeMd5(0)).toBe(md5StageAtSwitch)
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(true)

    // Back to the sprite: artwork restored, no drag residue, history CLEARed.
    const spriteCard = page.locator('[data-testid^="target-card-Sprite"]').first()
    if ((await spriteCard.count()) > 0) {
      await spriteCard.focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(800)
    }
    await page.getByTestId('main-tab-costumes').click()
    await page.waitForTimeout(400)
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(centerX, centerY)
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    // Old-asset SVG unchanged by the cancel (preview-level equality, same as
    // the Esc-cancel audits).
    await waitForPreviewSvg(svgOld)
    const undoDisabledAfter = await undoDisabled()
    const redoDisabledAfter = await redoDisabled()
    const handlesAfterSwitch = await page.evaluate(
      () => document.querySelectorAll('[data-vector-path-point]').length,
    )
    console.log(
      `[diag] sprite-switch: handles=${handlesAfterSwitch} undoDisabled=${String(undoDisabledAfter)} redoDisabled=${String(redoDisabledAfter)} pre-drag=${md5OldPreDrag}`,
    )
    // Returning to the sprite is itself a target switch, so the session
    // starts CLEARed: the cancelled drag left no entry behind.
    // (Old spec asserted one Undo removes the rect here; CLEAR drops that
    // entry by design, so assert disabled instead — without relaxing the
    // SVG-equality verification above.)
    expect(undoDisabledAfter).toBe(true)
    expect(redoDisabledAfter).toBe(true)

    // Fresh edit after the cancel commits singly: exactly one Undo entry, no
    // empty cancel entry hides behind it. Reselect first: the switch cleared
    // the object selection.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(centerX, centerY)
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    const leg = page.locator('[data-vector-path-point]')
    await leg.first().click()
    await waitForSelectedCount(1)
    const from = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 30, from.y, { steps: 8 })
    await page.mouse.up()
    const svgMoved = await previewSvg()
    expect(svgMoved).not.toBe(svgOld)
    await undoButton.click()
    await waitForPreviewSvg(svgOld)
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(false)
    await redoButton.click()
    await waitForPreviewSvg(svgMoved)
    expect(await undoDisabled()).toBe(false)
    expect(await redoDisabled()).toBe(true)
  }, 180_000)
})
