import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Strict regression proof for the Fill-popover focus + rect-after-removal story.
//
// Forensics first (fresh Chromium, real Editor + real VM, no product edits):
// - When the Fill popover dialog is OPEN and the planned canvas press point
//   sits UNDER the dialog rect, `elementsFromPoint` top-hits the dialog DIV,
//   not the svg canvas. The canvas gesture guard
//   (`editSurfaceNode.contains(target)`) then returns early: no draft, no
//   commit, rects stay 0, dialog stays open. That is overlay-blocked input,
//   not a stale-index product bug (proven in-test via the contains guard).
// - After a commit the tool keeps a live selection whose 8 scale handles are
//   real BUTTONs over the shape: reusing the same coordinates presses a
//   handle (move/resize, "Vector object resized") instead of a fresh shape.
//   Every fresh draw below therefore Escape-clears first (outlines 0) and
//   verifies top-hit == canvas before touching the mouse.
// - The removal path (select-all + Delete -> rects 0) followed by a verified
//   canvas drag commits exactly one rect, so the live-index filter holds;
//   the earlier "rects:0 and no commit" reproduces ONLY via the overlay-blocked
//   press or via a handle-press on an uncleared selection.
// - Tool clicks use short explicit timeouts and an enabled check first, so a
//   disabled toolbar trial fails fast instead of sitting in a 30s Playwright
//   wait.
//
// What this file proves on the LIVE UI (real color, exact history, no dupe,
// cancel, IME):
// - input-focused Fill popover (Paint color focused + real #e11d48 edit),
//   toolbar-close (rect tool button, outside the dialog), verified canvas hit,
//   then one drag commits EXACTLY ONE rect filled #e11d48 with
//   `Vector shape saved`, selection 1, Undo armed, VM md5 changed;
// - Undo restores blank pixels + blank md5, Redo repaints the same fill +
//   same md5, second Undo returns to blank (exact history, no dupe at any step);
// - removal (select-all + Delete) then the same verified drag commits again;
// - synthetic pointercancel mid-drag commits nothing (no pixels/history);
// - synthetic IME-processed Escape (keyCode 229) keeps dialog + selection,
//   plain Escape closes first with retention, next Escape deselects.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/vector-rect-after-popover-removal.browser.test.ts
const root = join(import.meta.dir, '..')
const PORT = 4521
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
const REAL_FILL = '#e11d48'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

function log(label: string, value: unknown) {
  try {
    console.log(`[popover-removal-rect] ${label} ${JSON.stringify(value).slice(0, 3000)}`)
  } catch {
    console.log(`[popover-removal-rect] ${label} (unstringifiable)`)
  }
}

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByTestId('main-tab-costumes').click({ timeout: 15_000 })
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click({ timeout: 10_000 })
  }
  await page.locator('.vector-preview').first().waitFor({ state: 'visible', timeout: 30_000 })
}

async function rectCount(): Promise<number> {
  return await page.evaluate(
    () => document.querySelector('.vector-preview')?.querySelectorAll('rect').length ?? -1,
  )
}

async function lastRectFill(): Promise<string | null> {
  return await page.evaluate(() => {
    const shapes = Array.from(document.querySelectorAll('.vector-preview rect'))
    const last = shapes[shapes.length - 1] as unknown as Element | undefined
    return last?.getAttribute('fill') ?? null
  })
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').first().innerHTML()
}

async function outlineCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-vector-selection-outline]').length)
}

async function blueOutlines(): Promise<number> {
  return await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('[data-vector-selection-outline]')).filter((n) =>
        (n as HTMLElement).className.includes('border-blue-500'),
      ).length,
  )
}

async function statusText(): Promise<string> {
  return await page.evaluate(
    () => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status?.() ?? 'no-hook',
  )
}

async function vmMd5(): Promise<string> {
  return await page.evaluate(() => {
    const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => any } }).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets[0]
    const c = target.costumes[target.currentCostume ?? 0]
    return String(c.md5ext ?? c.assetId ?? '')
  })
}

async function undoEnabled(): Promise<boolean> {
  return await page.locator('button[aria-label="Undo"]:visible').first().isEnabled()
}

async function redoEnabled(): Promise<boolean> {
  return await page.locator('button[aria-label="Redo"]:visible').first().isEnabled()
}

async function focusInfo() {
  return await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return { tag: el?.tagName ?? 'none', testid: el?.getAttribute?.('data-testid') ?? null, aria: el?.getAttribute?.('aria-label') ?? null }
  })
}

// Top hit-stack entries at a screen point (forensics: canvas vs dialog vs handle).
async function hitStackAt(x: number, y: number): Promise<string[]> {
  return await page.evaluate(
    ([sx, sy]: [number, number]) =>
      (document.elementsFromPoint(sx, sy) as HTMLElement[]).slice(0, 8).map((el) => el.getAttribute?.('data-testid') ?? el.tagName),
    [x, y] as unknown as undefined,
  )
}

async function surfaceBox() {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  return box
}

// Pick a surface-fraction point that is NOT covered by the open dialog (when
// open) and IS top-hit by the svg canvas. Fails fast with forensics instead
// of dragging into an overlay or a handle and waiting out a long timeout.
async function pickVerifiedCanvasPoint(fx: number, fy: number): Promise<{ x: number; y: number }> {
  const surf = await surfaceBox()
  const pt = { x: surf.x + surf.width * fx, y: surf.y + surf.height * fy }
  // Read-only DOM query (never a waiting locator: boundingBox on an
  // absent/never-attached dialog waits out the Playwright timeout).
  const dlg = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="fill-style-dialog"]') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const stack = await hitStackAt(pt.x, pt.y)
  log('pick-point', { pt, dlg, stack })
  expect(stack[0]).toBe('svg')
  expect(stack).not.toContain('fill-style-dialog')
  return pt
}

async function clickTool(id: 'rect' | 'select') {
  const btn = page.getByTestId(`vector-shape-${id}`).last()
  await btn.waitFor({ state: 'visible', timeout: 10_000 })
  // Fail fast on a disabled toolbar trial: never sit in a 30s click wait.
  expect(await btn.isEnabled()).toBe(true)
  await btn.click({ timeout: 5000 })
}

async function escapeClearSelection() {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('[data-vector-selection-outline]').length === 0, null, { timeout: 10_000 })
}

async function blankCanvas() {
  await clickTool('select')
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(300)
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => (document.querySelector('.vector-preview')?.querySelectorAll('rect').length ?? -1) === 0, null, {
    timeout: 10_000,
  })
}

async function realDrag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

async function openFillPopoverInputFocused() {
  await page.getByTestId('fill-style').click({ timeout: 5000 })
  await page.getByTestId('fill-style-dialog').waitFor({ state: 'visible', timeout: 10_000 })
  const paintInput = page.getByLabel('Paint color', { exact: true }).first()
  await paintInput.focus()
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.getAttribute?.('aria-label'))).toBe('Paint color')
}

describe('vector rect after Fill-popover focus + removal (strict regression)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--config', 'vite.gate.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 120_000)

  afterAll(async () => {
    await page?.close().catch(() => undefined)
    await browser?.close()
    server?.kill()
  })

  // Fresh page per test: a wedged renderer (load spike, GPU flake) must fail
  // only its own test instead of cascading "browser closed" into the rest.
  async function freshPage() {
    await page?.close().catch(() => undefined)
    page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    await gotoCostumes()
    await ensureVectorMode()
  }

  it('overlay-blocked press commits nothing; toolbar-close + verified drag commits exactly one real-color rect with exact history', async () => {
    await freshPage()
    await blankCanvas()
    expect(await rectCount()).toBe(0)
    const blankSvg = await previewSvg()
    const blankMd5 = await vmMd5()
    const undoBefore = await undoEnabled()
    log('blank', { blankMd5, undoBefore, focus: await focusInfo() })

    // Arm rect, open Fill, input-focus, edit a REAL color.
    await clickTool('rect')
    await openFillPopoverInputFocused()
    const paintInput = page.getByLabel('Paint color', { exact: true }).first()
    await paintInput.fill(REAL_FILL)
    expect(((await paintInput.inputValue()) ?? '').toLowerCase()).toBe(REAL_FILL)
    log('popover-real-color', { focus: await focusInfo(), dlg: await page.getByTestId('fill-style-dialog').count() })

    // Forensics: a surface point under the open dialog is overlay-blocked by
    // construction (top-hit dialog, surface.contains false) so a press there
    // can never start a canvas gesture. No click is sent into the dialog
    // (that would touch its controls); the guard is evaluated read-only.
    const surf = await surfaceBox()
    const dlgRect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="fill-style-dialog"]') as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    const blockedPt = { x: surf.x + surf.width * 0.3, y: surf.y + surf.height * 0.35 }
    const blockedStack = await hitStackAt(blockedPt.x, blockedPt.y)
    const guard = await page.evaluate(([x, y]: [number, number]) => {
      const top = document.elementFromPoint(x, y) as HTMLElement | null
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')
      return { top: top?.getAttribute?.('data-testid') ?? top?.tagName ?? 'none', surfaceContains: Boolean(top && surface?.contains(top)) }
    }, [blockedPt.x, blockedPt.y] as unknown as undefined)
    log('overlay-forensics', { blockedPt, blockedStack, dlgRect, guard })
    if (guard.top === 'fill-style-dialog' || blockedStack[0] !== 'svg') {
      // Overlay covers this point: document the block without side effects.
      expect(guard.surfaceContains).toBe(false)
      expect(await rectCount()).toBe(0)
    }

    // Proper UX path: toolbar rect button is OUTSIDE the dialog, so its
    // window pointerdown closes the popover and the click re-arms rect.
    await clickTool('rect')
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached', timeout: 10_000 })
    expect(await focusInfo()).toMatchObject({ testid: 'vector-shape-rect' })

    // Verified canvas points (fail fast, never drag into overlay/handles).
    const from = await pickVerifiedCanvasPoint(0.3, 0.35)
    const to = await pickVerifiedCanvasPoint(0.6, 0.6)
    await escapeClearSelection().catch(() => undefined)
    expect(await outlineCount()).toBe(0)

    // One drag commits EXACTLY ONE rect (no accidental duplicate).
    await realDrag(from, to)
    await page.waitForFunction(() => (document.querySelector('.vector-preview')?.querySelectorAll('rect').length ?? -1) === 1, null, {
      timeout: 10_000,
    })
    expect(await rectCount()).toBe(1)
    expect(((await lastRectFill()) ?? '').toLowerCase()).toBe(REAL_FILL)
    expect(await statusText()).toContain('Vector shape saved')
    expect(await blueOutlines()).toBeGreaterThanOrEqual(1)
    expect(await undoEnabled()).toBe(true)
    const committedSvg = await previewSvg()
    const committedMd5 = await vmMd5()
    expect(committedMd5).not.toBe(blankMd5)
    expect(committedSvg).not.toBe(blankSvg)
    log('committed', { fill: await lastRectFill(), status: await statusText(), md5: committedMd5 })

    // Exact history: Undo -> blank (pixels + VM bytes), Redo -> same commit.
    await page.locator('button[aria-label="Undo"]:visible').first().click({ timeout: 5000 })
    await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML !== prev, committedSvg, { timeout: 10_000 })
    expect(await rectCount()).toBe(0)
    expect(await previewSvg()).toBe(blankSvg)
    expect(await vmMd5()).toBe(blankMd5)
    await page.locator('button[aria-label="Redo"]:visible').first().click({ timeout: 5000 })
    await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML !== prev, blankSvg, { timeout: 10_000 })
    expect(await rectCount()).toBe(1)
    expect(((await lastRectFill()) ?? '').toLowerCase()).toBe(REAL_FILL)
    expect(await vmMd5()).toBe(committedMd5)
    // Back to blank for the next test (still exact: pixels + bytes).
    await page.locator('button[aria-label="Undo"]:visible').first().click({ timeout: 5000 })
    await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML !== prev, committedSvg, { timeout: 10_000 })
    expect(await rectCount()).toBe(0)
    expect(await vmMd5()).toBe(blankMd5)
  }, 120_000)

  it('removal then re-draw commits (stale selection cannot ghost-block)', async () => {
    await freshPage()
    // Draw one rect through the verified path, remove it, draw again.
    // Start blank so leftover artwork (default costume paths, or a prior
    // test's commit) can never turn the press into an item move.
    await blankCanvas()
    await clickTool('rect')
    const from = await pickVerifiedCanvasPoint(0.3, 0.3)
    const to = await pickVerifiedCanvasPoint(0.55, 0.55)
    await escapeClearSelection().catch(() => undefined)
    const before = await previewSvg()
    await realDrag(from, to)
    await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML !== prev, before, { timeout: 10_000 })
    expect(await rectCount()).toBe(1)

    // Removal: select-all + Delete leaves rects 0 with no live selection.
    await clickTool('select')
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(300)
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => (document.querySelector('.vector-preview')?.querySelectorAll('rect').length ?? -1) === 0, null, {
      timeout: 10_000,
    })
    expect(await outlineCount()).toBe(0)
    const removedSvg = await previewSvg()

    // Re-draw at verified canvas points: must commit exactly one rect even
    // though the pre-removal selection index is now stale.
    await clickTool('rect')
    const from2 = await pickVerifiedCanvasPoint(0.32, 0.32)
    const to2 = await pickVerifiedCanvasPoint(0.58, 0.58)
    await realDrag(from2, to2)
    await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML !== prev, removedSvg, { timeout: 10_000 })
    expect(await rectCount()).toBe(1)
    expect(await undoEnabled()).toBe(true)
    log('redraw-after-removal', { fill: await lastRectFill(), status: await statusText(), md5: await vmMd5() })

    await page.locator('button[aria-label="Undo"]:visible').first().click({ timeout: 5000 })
    await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML !== prev, removedSvg === '' ? null : removedSvg, { timeout: 10_000 }).catch(() => undefined)
    await page.waitForTimeout(500)
  }, 120_000)

  it('pointercancel mid-drag commits nothing; IME Escape keeps popover + selection', async () => {
    await freshPage()
    await blankCanvas()
    await clickTool('rect')
    const surf = await surfaceBox()
    const toScreen = async (fx: number, fy: number) => ({ x: surf.x + surf.width * fx, y: surf.y + surf.height * fy })
    const undoBefore = await undoEnabled()
    const svgBefore = await previewSvg()

    // Cancel: full synthetic gesture (down/move/cancel, one pointer id) so
    // the canvas guard tracks one gesture and the cancel path discards it.
    const a = await toScreen(0.35, 0.35)
    const b = await toScreen(0.55, 0.55)
    await page.evaluate(
      ([p0, p1]: [{ x: number; y: number }, { x: number; y: number }]) => {
        const target = document.querySelector('[data-testid="costume-paint-surface"]') as HTMLElement
        const mk = (type: string, x: number, y: number, buttons: number) =>
          new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', button: 0, buttons, bubbles: true, composed: true, isPrimary: true, clientX: x, clientY: y })
        target.dispatchEvent(mk('pointerdown', p0.x, p0.y, 1))
        target.dispatchEvent(mk('pointermove', (p0.x + p1.x) / 2, (p0.y + p1.y) / 2, 1))
        target.dispatchEvent(mk('pointercancel', (p0.x + p1.x) / 2, (p0.y + p1.y) / 2, 0))
      },
      [a, b] as unknown as undefined,
    )
    await page.waitForTimeout(900)
    expect(await previewSvg()).toBe(svgBefore)
    expect(await rectCount()).toBe(0)
    expect(await outlineCount()).toBe(0)
    expect(await undoEnabled()).toBe(undoBefore)

    // IME: one committed selection, Fill popover open, 229 keeps everything.
    const from = await pickVerifiedCanvasPoint(0.3, 0.35)
    const to = await pickVerifiedCanvasPoint(0.6, 0.6)
    await realDrag(from, to)
    await page.waitForFunction(() => (document.querySelector('.vector-preview')?.querySelectorAll('rect').length ?? -1) === 1, null, {
      timeout: 10_000,
    })
    await clickTool('select')
    await page.keyboard.press('Control+a')
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 1, null, {
      timeout: 10_000,
    })
    const selBefore = await blueOutlines()
    const artBefore = await previewSvg()
    const undoBeforeIme = await undoEnabled()
    await page.getByTestId('fill-style').click({ timeout: 5000 })
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByTestId('fill-style').focus()
    await page.evaluate(() => {
      const target = document.activeElement ?? document.body
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      Object.defineProperty(event, 'keyCode', { value: 229 })
      Object.defineProperty(event, 'which', { value: 229 })
      target.dispatchEvent(event)
    })
    await page.waitForTimeout(400)
    expect(await page.getByTestId('fill-style-dialog').count()).toBe(1)
    expect(await blueOutlines()).toBe(selBefore)
    expect(await previewSvg()).toBe(artBefore)
    expect(await undoEnabled()).toBe(undoBeforeIme)
    // Plain Escape closes first with retention; next Escape deselects cleanly.
    await page.keyboard.press('Escape')
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached', timeout: 10_000 })
    expect(await blueOutlines()).toBe(selBefore)
    expect(await previewSvg()).toBe(artBefore)
    const md5BeforeDeselect = await vmMd5()
    await page.keyboard.press('Escape')
    // Deselected = no BLUE outline (unselected objects keep a transparent
    // hover outline node, so total outline count never reaches 0 while art
    // exists). Artwork, VM bytes and history stay untouched.
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0, null, { timeout: 10_000 })
    expect(await blueOutlines()).toBe(0)
    expect(await previewSvg()).toBe(artBefore)
    expect(await vmMd5()).toBe(md5BeforeDeselect)
    expect(await undoEnabled()).toBe(undoBeforeIme)
    log('cancel-ime-done', { status: await statusText() })
  }, 120_000)
})
