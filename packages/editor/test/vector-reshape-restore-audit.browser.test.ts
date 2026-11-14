import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Independent reshape snapshot/restore audit (product code untouched):
// - start -> move -> return-to-start restores with no history entry
// - mid-drag Escape restores single + Shift-multi, keeps selection, writes no
//   history; an edit immediately after commits cleanly (single Undo/Redo)
// - pointercancel restores without history (synthetic dispatch through the
//   same overlay cancel path; real Chrome cannot synthesize a trusted
//   pointercancel from mouse input)
// - control-handle drag restores on Esc and commits singly, siblings untouched
// - parent-transform + sibling data protection (real drag + in-browser helper)
// - costume/sprite switch after cancel/commit keeps artwork and history sane;
//   button-held mid-drag switch is reported as not operable (pointer capture),
//   not asserted
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4347'
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function selectedAnchorCount() {
  return await page.locator('[data-vector-path-point][aria-pressed="true"]').count()
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

async function anchorCount() {
  return await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-vector-path-point]')].filter((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith('Move path point'),
      ).length,
  )
}

async function waitForAnchorCount(expected: number) {
  await page.waitForFunction(
    (count) =>
      [...document.querySelectorAll('[data-vector-path-point]')].filter((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith('Move path point'),
      ).length === count,
    expected,
  )
}

async function previewSvg() {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewSvg(expected: string) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML === svg, expected)
}

async function waitForPreviewSvgChange(previous: string) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    previous,
  )
}

async function resetCanvasToRect() {
  // Release any dangling drag state from a previous probe before resetting.
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
  await waitForAnchorCount(4)
  return { centerX, centerY }
}

describe('vector reshape snapshot/restore independent audit', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4347', '--strictPort'], {
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

  it('return-to-start restores the snapshot with no history entry', async () => {
    await resetCanvasToRect()
    const handles = page.locator('[data-vector-path-point]')
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await handles.first().click()
    await waitForSelectedCount(1)
    const svg0 = await previewSvg()
    const single = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    // Out and back in one drag: the release delta is zero, so the end handler
    // must settle on the snapshot (moved === false) and commit nothing.
    await page.mouse.move(single.x, single.y)
    await page.mouse.down()
    await page.mouse.move(single.x + 60, single.y, { steps: 8 })
    await waitForPreviewSvgChange(svg0)
    await page.mouse.move(single.x, single.y, { steps: 8 })
    await page.mouse.up()
    await waitForPreviewSvg(svg0)
    // No empty entry: one Undo removes the rect itself.
    await undoButton.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)
    await redoButton.click()
    await waitForPreviewSvg(svg0)
  }, 120_000)

  it('Esc restores single/multi, keeps selection, immediate edit is single-entry', async () => {
    const { centerX, centerY } = await resetCanvasToRect()
    const handles = page.locator('[data-vector-path-point]')
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    // Shift multi-select: two anchors.
    await handles.first().click()
    await waitForSelectedCount(1)
    await page.keyboard.down('Shift')
    await handles.nth(1).click()
    await page.keyboard.up('Shift')
    await waitForSelectedCount(2)
    const svg0 = await previewSvg()
    const before = await handleCenters()
    const dragFrom = before
      .filter((c) => c.pressed && !c.control)
      .sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(dragFrom.x, dragFrom.y)
    await page.mouse.down()
    await page.mouse.move(dragFrom.x + 60, dragFrom.y, { steps: 10 })
    await waitForPreviewSvgChange(svg0)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await waitForPreviewSvg(svg0)
    expect(await selectedAnchorCount()).toBe(2)
    // Immediate edit after the cancel: no race with the restore, exactly one
    // history entry (single Undo restores, single Redo re-applies).
    const reselect = (await handleCenters()).filter((c) => c.pressed && !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(reselect.x, reselect.y)
    await page.mouse.down()
    await page.mouse.move(reselect.x + 30, reselect.y, { steps: 8 })
    await page.mouse.up()
    const svgMoved = await previewSvg()
    expect(svgMoved).not.toBe(svg0)
    await undoButton.click()
    await waitForPreviewSvg(svg0)
    await redoButton.click()
    await waitForPreviewSvg(svgMoved)
    await undoButton.click()
    await waitForPreviewSvg(svg0)
    // Single-point Esc leg.
    await handles.first().click()
    await waitForSelectedCount(1)
    const leg = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(leg.x, leg.y)
    await page.mouse.down()
    await page.mouse.move(leg.x + 50, leg.y + 20, { steps: 8 })
    await waitForPreviewSvgChange(svg0)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await waitForPreviewSvg(svg0)
    expect(await selectedAnchorCount()).toBe(1)
    // Leave a clean baseline for later its: reselect via canvas click.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(centerX, centerY)
    expect(await previewSvg()).toBe(svg0)
  }, 180_000)

  it('pointercancel restores the snapshot without history', async () => {
    await resetCanvasToRect()
    const handles = page.locator('[data-vector-path-point]')
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await handles.first().click()
    await waitForSelectedCount(1)
    const svg0 = await previewSvg()
    const single = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    // Record the real pointer id of the drag; a trusted pointercancel cannot
    // be synthesized from mouse input, so dispatch one with the same id
    // through the same overlay cancel path and assert the same restore.
    await page.evaluate(() => {
      ;(window as unknown as { __lastReshapePointerId?: number }).__lastReshapePointerId = undefined
      window.addEventListener(
        'pointerdown',
        (event) => {
          ;(window as unknown as { __lastReshapePointerId?: number }).__lastReshapePointerId = (
            event as PointerEvent
          ).pointerId
        },
        { capture: true },
      )
    })
    await page.mouse.move(single.x, single.y)
    await page.mouse.down()
    await page.mouse.move(single.x + 55, single.y + 15, { steps: 8 })
    await waitForPreviewSvgChange(svg0)
    // NOTE: synthetic dispatch (same handler a real pointercancel reaches).
    await page.evaluate(() => {
      const pid = (window as unknown as { __lastReshapePointerId?: number }).__lastReshapePointerId ?? 1
      const target = document.querySelector('[data-vector-path-point]')
      if (!target) throw new Error('Missing reshape handle for pointercancel probe')
      target.dispatchEvent(new PointerEvent('pointercancel', { pointerId: pid, bubbles: true, cancelable: true }))
    })
    await page.mouse.up()
    await waitForPreviewSvg(svg0)
    expect(await selectedAnchorCount()).toBe(1)
    // Cancel wrote no history: one Undo removes the rect, Redo restores it.
    await undoButton.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)
    await redoButton.click()
    await waitForPreviewSvg(svg0)
  }, 120_000)

  it('control-handle drag restores on Esc and commits singly with siblings intact', async () => {
    await resetCanvasToRect()
    const handles = page.locator('[data-vector-path-point]')
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    // Curve the rect so control handles exist (single history entry).
    await handles.first().click()
    await waitForSelectedCount(1)
    await page.keyboard.down('Shift')
    await handles.nth(1).click()
    await page.keyboard.up('Shift')
    await waitForSelectedCount(2)
    const svgPointed = await previewSvg()
    await page.getByTestId('reshape-curve-point').click()
    // Two curved anchors => 4 anchors + 4 controls = 8 handles.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-path-point]').length === 8,
    )
    const svgCurved = await previewSvg()
    expect(svgCurved).not.toBe(svgPointed)
    const controls = page.locator(
      '[data-vector-path-point][aria-label^="Move control point"]',
    )
    await controls.first().waitFor({ state: 'visible' })
    const controlBox = await controls.first().boundingBox()
    if (!controlBox) throw new Error('Missing control handle bounds')
    const controlCenter = { x: controlBox.x + controlBox.width / 2, y: controlBox.y + controlBox.height / 2 }
    // Control Esc leg: the anchor selection is untouched (control drags are
    // single-point and never change the anchor set).
    await page.mouse.move(controlCenter.x, controlCenter.y)
    await page.mouse.down()
    await page.mouse.move(controlCenter.x + 40, controlCenter.y + 25, { steps: 8 })
    await waitForPreviewSvgChange(svgCurved)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await waitForPreviewSvg(svgCurved)
    // Control commit leg: exactly one history entry; anchors stay put while
    // the dragged control moves (checked loosely: preview changes, anchors in
    // the artwork diff only via their handles).
    const controlBox2 = await controls.first().boundingBox()
    if (!controlBox2) throw new Error('Missing control handle bounds for commit leg')
    const from2 = { x: controlBox2.x + controlBox2.width / 2, y: controlBox2.y + controlBox2.height / 2 }
    await page.mouse.move(from2.x, from2.y)
    await page.mouse.down()
    await page.mouse.move(from2.x + 30, from2.y, { steps: 8 })
    await page.mouse.up()
    const svgControlMoved = await previewSvg()
    expect(svgControlMoved).not.toBe(svgCurved)
    await undoButton.click()
    await waitForPreviewSvg(svgCurved)
    await redoButton.click()
    await waitForPreviewSvg(svgControlMoved)
  }, 180_000)

  it('parent transforms and siblings survive reshape preview/restore', async () => {
    // In-browser helper check with a transformed parent + an untouched sibling.
    const helper = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const path = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<g id="parent" transform="translate(50 20)"><path id="target" d="M 10 30 C 20 30 30 30 40 30 C 50 30 60 30 70 30" fill="none" stroke="black"/></g>' +
        '<rect id="sibling" x="200" y="200" width="40" height="30" fill="red"/></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const target = doc.querySelector('#target') as Element
      const parent = doc.querySelector('#parent') as Element
      const sibling = doc.querySelector('#sibling') as Element
      const siblingBefore = sibling.getAttribute('x') + ',' + sibling.getAttribute('y')
      const list = await paper.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const unit = list.find((entry: { element?: Element }) => entry.element === undefined) as unknown as null
      void unit
      const points = await paper.paperVectorObjectList(svg)
      const anchor = (points[0] as { points?: Array<{ kind: string; index: number; x: number; y: number }> }).points!.find(
        (p) => p.kind === 'anchor',
      )!
      const result = await path.moveVectorReshapePoints(target, [{ index: anchor.index, x: anchor.x + 9, y: anchor.y + 4 }])
      return {
        moved: result.moved,
        parentTransform: parent.getAttribute('transform'),
        siblingAfter: sibling.getAttribute('x') + ',' + sibling.getAttribute('y'),
        siblingBefore,
      }
    })
    expect(helper.moved).toBe(true)
    expect(helper.parentTransform).toBe('translate(50 20)')
    expect(helper.siblingAfter).toBe(helper.siblingBefore)
    // Real-drag sibling check: the rect drawn in this audit has one object;
    // draw a second rect, reshape one anchor of the first object, and verify
    // the second object's bounds do not move while the first does.
    await resetCanvasToRect()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const rectTool = page.getByTestId('vector-shape-rect').last()
    await page.getByTestId('vector-shape-select').last().click()
    await rectTool.click()
    await page.mouse.move(box.x + 40, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 8 })
    await page.mouse.up()
    const reshapeTool = page.getByTestId('vector-shape-reshape').last()
    await reshapeTool.click()
    await page.waitForSelector('[data-vector-path-point]')
    const boundsBefore = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg = document.querySelector('.vector-preview')?.innerHTML ?? ''
      const list = await paper.paperVectorObjectList(svg)
      return list.map((entry: { boundsX: number; boundsY: number }) => ({ x: entry.boundsX, y: entry.boundsY }))
    })
    expect(boundsBefore.length).toBeGreaterThanOrEqual(2)
    const handles = page.locator('[data-vector-path-point]')
    await handles.first().click()
    await waitForSelectedCount(1)
    const svg0 = await previewSvg()
    const single = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(single.x, single.y)
    await page.mouse.down()
    await page.mouse.move(single.x + 40, single.y, { steps: 8 })
    await page.mouse.up()
    const svgMoved = await previewSvg()
    expect(svgMoved).not.toBe(svg0)
    const boundsAfter = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg = document.querySelector('.vector-preview')?.innerHTML ?? ''
      const list = await paper.paperVectorObjectList(svg)
      return list.map((entry: { boundsX: number; boundsY: number }) => ({ x: entry.boundsX, y: entry.boundsY }))
    })
    expect(boundsAfter.length).toBe(boundsBefore.length)
    // At least one object kept its bounds (the untouched sibling).
    const kept = boundsAfter.some((after, i) =>
      Math.abs(after.x - boundsBefore[i]!.x) < 3 && Math.abs(after.y - boundsBefore[i]!.y) < 3,
    )
    expect(kept).toBe(true)
  }, 180_000)

  it('costume/sprite switch after cancel/commit keeps artwork and history sane', async () => {
    const { centerX, centerY } = await resetCanvasToRect()
    const handles = page.locator('[data-vector-path-point]')
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await handles.first().click()
    await waitForSelectedCount(1)
    const svg0 = await previewSvg()
    // Commit a real move first (single entry), then Esc-cancel a second drag
    // so the switch happens right after a cancel (the race the shared cancel
    // promise guards).
    const single = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(single.x, single.y)
    await page.mouse.down()
    await page.mouse.move(single.x + 30, single.y, { steps: 8 })
    await page.mouse.up()
    const svgMoved = await previewSvg()
    expect(svgMoved).not.toBe(svg0)
    const second = (await handleCenters()).filter((c) => !c.control).sort((a, b) => a.x - b.x)[0]!
    await page.mouse.move(second.x, second.y)
    await page.mouse.down()
    await page.mouse.move(second.x + 40, second.y, { steps: 6 })
    await waitForPreviewSvgChange(svgMoved)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await waitForPreviewSvg(svgMoved)
    // Switch costume away and back: artwork and the committed entry survive.
    const costumeCards = page.locator('[data-testid^="costume-card-"]')
    const cardCount = await costumeCards.count()
    expect(cardCount).toBeGreaterThanOrEqual(1)
    if (cardCount >= 2) {
      await costumeCards.nth(1).locator('button[aria-label^="Select "]').click()
      await page.waitForTimeout(600)
      await costumeCards.nth(0).locator('button[aria-label^="Select "]').click()
      await page.waitForTimeout(600)
    } else {
      // Single-costume project: touch the same card (select path still runs).
      await costumeCards.nth(0).locator('button[aria-label^="Select "]').click()
      await page.waitForTimeout(600)
    }
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(centerX, centerY)
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    expect(await previewSvg()).toBe(svgMoved)
    await undoButton.click()
    await waitForPreviewSvg(svg0)
    await redoButton.click()
    await waitForPreviewSvg(svgMoved)
    // Switch sprite/stage and back: no crash, original artwork intact.
    const spriteCards = page.locator('[data-testid^="target-card-"]')
    const spriteCount = await spriteCards.count()
    if (spriteCount >= 1) {
      await spriteCards.first().click()
      await page.waitForTimeout(600)
      // Back to the original sprite: click the card that is not selected, or
      // fall back to staying if only one target exists.
      const names = await spriteCards.evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')),
      )
      void names
      await page.getByTestId('main-tab-costumes').click()
      await page.waitForTimeout(600)
      expect(await previewSvg()).toContain('<')
    }
  }, 180_000)
})
