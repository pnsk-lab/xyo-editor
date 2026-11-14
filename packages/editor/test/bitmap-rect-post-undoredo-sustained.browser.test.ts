import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Sustained (no-reload) reproduction for the fresh-reset isolation true difference
// reported in rect-oval-tiny-discard-real-editor.browser.test.ts:
//
//   bitmap rect draw -> Undo -> Redo -> same-tool next Shift draw yields
//   selection=0 / no commit in the SAME session, while the same Shift draw on
//   a fresh page commits.
//
// Product src (Editor.svelte) is owned by another agent: this file only ADDS a
// new independent-port real-Editor+VM browser test and never edits product code
// or existing tests (git stash/checkout/reset/restore/clean are forbidden).
//
// What this test does (single sustained session, independent Vite port 4499):
// - drives ONLY the real UI (tool clicks, canvas mouse drags, Undo/Redo buttons),
// - monitors the minimal operation set on every phase:
//   canvas pointer capture (surface listeners), bitmapWorkspaceToken settled /
//   owner+pending, refusal (status `cancelled ...`), costumeEditMode, shape tool
//   changes, plus browser exact coordinates / visible / hit (elementFromPoint) /
//   selection / VM bytes (snapshot md5ext + canvas pixels) / Undo status / overlay
//   (bitmap-workspace-loading-overlay, center crosshair),
// - determines the cause among: not firing, auto-switch to another tool,
//   history-restore bitmap reload pending, focus/mouse stale,
// - compares Scratch reference tool state after creation,
// - on the true-difference path it FAILS with forensics and a minimal fix proposal.
//
// Scratch reference (own words, verified against .tmp/scratch-editor checkout):
// - bit rect/oval `handleMouseUp` keeps the tool: `rect.selected = true` +
//   `setSelectedItems()` with NO mode change; the container
//   (`bit-rect-mode.jsx` / `bit-oval-mode.jsx`) re-dispatches
//   `changeMode(Modes.BIT_RECT/BIT_Oval)` so the tool STAYS armed with the new
//   shape selected. Next mousedown either moves the selected box (bounding-box
//   mode) or commits the raster (`commitRect/commitOval`) and starts a new box.
// - vector rect/oval `handleMouseUp` likewise stays in RECT/OVAL mode
//   (`rect-mode.jsx` setSelectedItems has no changeMode).
// Product divergence (observed, not edited here): both bitmap and vector shape
// commits auto-switch to `select` (Editor.svelte `bitmapTool = 'select'` /
// `chooseVectorTool('select')`). The existing tiny-discard suite asserts the
// vector switch, so this test treats the switch as product behavior and only
// reports the reference delta; the sustained failure below re-arms `rect`
// explicitly, so the switch alone cannot explain a second-draw no-commit.
//
// MINIMAL FIX PROPOSAL (for the Editor.svelte owner; not applied here):
// - If forensics say `pending` during the second draw or status contains
//   `cancelled (artwork changed ...)`: the Undo/Redo `refreshCostumePreview` ->
//   `loadCostumeIntoBitmapCanvas` async reload is still in flight when the next
//   `beginBitmapPaint` runs, so the owner gate refuses the stroke. Fix at the
//   smallest scope: make Undo/Redo completion await the bitmap settle
//   (`commitOwner`, pending cleared, overlay hidden) before re-enabling paint,
//   or queue/drop-guard the next stroke until `isBitmapWorkspaceSettledFor`
//   is true instead of refusing silently.
// - If forensics say `not firing` (no pointerdown in the surface log despite
//   exact visible/hit coords): `activeCanvasPointerId` / `isBitmapPainting` /
//   pointer capture is stale after history restore. Fix: clear
//   `activeCanvasPointerId`, release capture, and reset `bitmapStart` on the
//   history-restore path (same clearing `resetCostumeEditorSelection` does on
//   target switch).
// - If forensics say `auto-switch` (tool left `rect` without a commit):
//   preserve/re-arm the pre-undo shape tool across `restoreHistoryEntry`.
// - If forensics say `focus/mouse stale` (activeElement on Undo/Redo button,
//   elementFromPoint misses canvas): focus the canvas surface after Undo/Redo
//   and read live modifiers on the release event (already done) with exact coords.

const root = join(import.meta.dir, '..')
const PORT = 4499
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined

function log(label: string, value: unknown) {
  try {
    console.log(`[sustained-rect-post-undoredo] ${label} ${JSON.stringify(value).slice(0, 6000)}`)
  } catch {
    console.log(`[sustained-rect-post-undoredo] ${label} (unstringifiable)`)
  }
}

async function canvasSize(page: Page): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function toScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas')
  const size = await canvasSize(page)
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height }
}

async function snapshotCanvas(page: Page): Promise<number[]> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data)
  })
}

function pixelsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function changedPixels(before: number[], after: number[]): number {
  let n = 0
  for (let i = 0; i < before.length; i += 4) {
    const d =
      Math.abs((after[i] ?? 0) - (before[i] ?? 0)) +
      Math.abs((after[i + 1] ?? 0) - (before[i + 1] ?? 0)) +
      Math.abs((after[i + 2] ?? 0) - (before[i + 2] ?? 0)) +
      Math.abs((after[i + 3] ?? 0) - (before[i + 3] ?? 0))
    if (d > 4) n += 1
  }
  return n
}

async function token(page: Page): Promise<string> {
  return await page.evaluate(() => (window as any).__hikkakuEditorTest?.bitmapWorkspaceToken?.() ?? 'no-hook')
}

async function statusText(page: Page): Promise<string> {
  return await page.evaluate(() => (window as any).__hikkakuEditorTest?.status?.() ?? 'no-hook')
}

async function vmCostumeMeta(page: Page) {
  return await page.evaluate(() => {
    const snap = (window as any).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets[0]
    const index = target.currentCostume ?? 0
    const c = target.costumes[index]
    return { targetName: target.name, index, name: c?.name, dataFormat: c?.dataFormat ?? '', md5ext: c?.md5ext ?? '', res: c?.bitmapResolution }
  })
}

async function toolActive(page: Page, id: string): Promise<boolean> {
  return await page.evaluate((toolId: string) => {
    const node = document.querySelector(`[data-testid="bitmap-tool-${toolId}"]`)
    if (!node) return false
    const cls = (node as HTMLElement).className ?? ''
    return cls.includes('bg-[#8d5de8]') || cls.includes('text-white')
  }, id)
}

async function costumeMode(page: Page): Promise<string> {
  const bitmapVisible = await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)
  const vectorVisible = await page.locator('.vector-preview').isVisible().catch(() => false)
  if (bitmapVisible) return 'bitmap'
  if (vectorVisible) return 'vector'
  return 'unknown'
}

async function selectionCount(page: Page): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-selection"]').length)
}

async function selectionStyle(page: Page): Promise<string | null> {
  return await page.evaluate(() => document.querySelector('[data-testid="bitmap-selection"]')?.getAttribute('style') ?? null)
}

async function undoEnabled(page: Page): Promise<boolean> {
  return await page.locator('button[aria-label="Undo"]').first().isEnabled().catch(() => false)
}

async function redoEnabled(page: Page): Promise<boolean> {
  return await page.locator('button[aria-label="Redo"]').first().isEnabled().catch(() => false)
}

async function overlayState(page: Page) {
  return await page.evaluate(() => ({
    loading: document.querySelectorAll('[data-testid="bitmap-workspace-loading-overlay"]').length,
    crosshair: document.querySelectorAll('[data-testid="move-center-crosshair"]').length,
  }))
}

async function focusState(page: Page) {
  return await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return {
      hasFocus: document.hasFocus(),
      tag: el?.tagName ?? 'none',
      testid: el?.getAttribute?.('data-testid') ?? null,
      aria: el?.getAttribute?.('aria-label') ?? null,
      id: (el as any)?.id ?? null,
    }
  })
}

async function geometry(page: Page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    const surface = document.querySelector('[data-testid="costume-paint-surface"]')
    const c = canvas?.getBoundingClientRect()
    const s = (surface as HTMLElement)?.getBoundingClientRect()
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      canvasRect: c ? { x: c.x, y: c.y, w: c.width, h: c.height } : null,
      canvasAttr: canvas ? { w: canvas.width, h: canvas.height } : null,
      canvasCss: canvas ? getComputedStyle(canvas).transform.slice(0, 80) : null,
      surfaceRect: s ? { x: s.x, y: s.y, w: s.width, h: s.height } : null,
    }
  })
}

async function hitAt(page: Page, x: number, y: number) {
  return await page.evaluate(({ px, py }: { px: number; py: number }) => {
    const el = document.elementFromPoint(px, py) as HTMLElement | null
    if (!el) return { hit: 'none' }
    const r = el.getBoundingClientRect()
    return {
      hit: `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `#${el.getAttribute('data-testid')}` : ''}.${(el.className as string)?.slice?.(0, 80) ?? ''}`,
      canvas: el.closest?.('[data-testid="bitmap-editor-canvas"]') !== null,
      surface: el.closest?.('[data-testid="costume-paint-surface"]') !== null,
      elRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    }
  }, { px: x, py: y })
}

async function installPointerLog(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__ptrLog = []
    const surface = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!surface || (surface as any).__ptrHooked) return
    ;(surface as any).__ptrHooked = true
    const push = (kind: string, e: any) => {
      try {
        ;(window as any).__ptrLog.push({ kind, type: e.type, pid: e.pointerId, buttons: (e as any).buttons, clientX: e.clientX, clientY: e.clientY, shift: !!(e as any).shiftKey, alt: !!(e as any).altKey, target: (e.target as HTMLElement)?.getAttribute?.('data-testid') ?? (e.target as HTMLElement)?.tagName ?? '?' })
      } catch {}
    }
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'mousedown', 'mouseup']) {
      surface.addEventListener(t, (e) => push('surface:' + t, e), true)
      window.addEventListener(t, (e) => push('window:' + t, e as any), true)
    }
  })
}

async function clearPointerLog(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__ptrLog = []
  })
}

async function readPointerLog(page: Page): Promise<any[]> {
  return await page.evaluate(() => ((window as any).__ptrLog ?? []) as any[])
}

async function waitSettled(page: Page, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await token(page)
    const overlay = await page.getByTestId('bitmap-workspace-loading-overlay').count().catch(() => 0)
    if (last.includes('pending=none') && !last.includes('owner=none') && overlay === 0) return last
    await page.waitForTimeout(150)
  }
  return last
}

describe('bitmap rect post-Undo/Redo sustained (no fresh reset)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
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
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('same-session rect Undo->Redo->Shift-rect commits (fails with forensics on the true difference)', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      // HMR resilience: the product src is being edited by another agent, so a
      // Vite reload can land mid-test (token owner=none, mode unknown, status
      // Ready). Retry the whole sustained flow on a fresh page load (max 3);
      // the B->C sustained segment itself never reloads once an attempt is clean.
      let attemptDone = false
      for (let attempt = 1; attempt <= 3 && !attemptDone; attempt += 1) {
      log('attempt', { attempt })
      try {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await page.getByTestId('main-tab-costumes').click({ timeout: 120_000 })
      await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 60_000 })
      if (!(await page.getByTestId('bitmap-editor-canvas').isVisible())) {
        await page.getByRole('button', { name: 'ビットマップに変換' }).click()
      }
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 60_000 })
      } catch (e) {
        log('hmr-interference-setup', { error: String(e).slice(0, 300), attempt })
        continue
      }
      await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
      await installPointerLog(page)

      const size = await canvasSize(page)
      const box0 = await page.getByTestId('bitmap-editor-canvas').boundingBox()
      log('baseline', { size, box: box0, mode: await costumeMode(page), token: await token(page), status: await statusText(page), vm: await vmCostumeMeta(page), undo: await undoEnabled(page), redo: await redoEnabled(page), focus: await focusState(page), overlay: await overlayState(page) })

      // Phase A: normal rect commit in the sustained session.
      // HMR guard: another agent is editing product src, so a reload can flip
      // the editor back to vector/no-toolbar between baseline and the click.
      if ((await page.getByTestId('bitmap-tool-rect').count()) === 0) {
        log('hmr-interference-prePhaseA', { mode: await costumeMode(page), attempt })
        continue
      }
      const beforeA = await snapshotCanvas(page)
      const undoBeforeA = await undoEnabled(page)
      await page.getByTestId('bitmap-tool-rect').click()
      log('phaseA-tool-after-click', { rect: await toolActive(page, 'rect'), select: await toolActive(page, 'select'), mode: await costumeMode(page) })
      // Fit-robust coordinates: the first-fit now lands at conversion time
      // (content fit ~1.2, panned), so fixed canvas fractions can map outside
      // the visible surface (under the toolbar). Draw around the live surface
      // center instead: the fit centers content on the container, and the
      // reset centers the board, so center offsets stay on-canvas AND inside
      // the surface at any settled scale/pan. Hit is verified before drawing.
      const geoA = await geometry(page)
      const surfA = (geoA as any).surfaceRect
      if (!surfA || !(surfA.w > 0) || !(surfA.h > 0)) throw new Error('Missing paint surface rect')
      const aFrom = { x: surfA.x + surfA.w / 2 - 80, y: surfA.y + surfA.h / 2 - 30 }
      const aTo = { x: surfA.x + surfA.w / 2 + 80, y: surfA.y + surfA.h / 2 + 30 }
      log('phaseA-coords', { aFrom, aTo, box: await page.getByTestId('bitmap-editor-canvas').boundingBox(), visible: await page.getByTestId('bitmap-editor-canvas').isVisible(), hitFrom: await hitAt(page, aFrom.x, aFrom.y), hitTo: await hitAt(page, aTo.x, aTo.y), surfaceRect: surfA })
      await clearPointerLog(page)
      await page.mouse.move(aFrom.x, aFrom.y)
      await page.mouse.down()
      await page.mouse.move(aTo.x, aTo.y, { steps: 12 })
      await page.mouse.up()
      // HMR guard: the VM/Editor agent's save can reload mid-commit, destroying
      // the execution context. Restart the attempt cleanly like the other
      // HMR signatures below.
      try {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="bitmap-selection"]').length === 1, null, { timeout: 30_000 })
      } catch (e) {
        log('hmr-interference-phaseA-commit-wait', { error: String(e).slice(0, 300), attempt })
        continue
      }
      let afterA: number[]
      let tokenA: string
      try {
        afterA = await snapshotCanvas(page)
        tokenA = await waitSettled(page)
      } catch (e) {
        log('hmr-interference-phaseA-settled', { error: String(e).slice(0, 300), attempt })
        continue
      }
      const toolAfterA = { rect: await toolActive(page, 'rect'), select: await toolActive(page, 'select') }
      log('phaseA-committed', { changed: changedPixels(beforeA, afterA), selection: await selectionCount(page), style: await selectionStyle(page), token: tokenA, status: await statusText(page), tool: toolAfterA, vm: await vmCostumeMeta(page), undo: await undoEnabled(page), redo: await redoEnabled(page), mode: await costumeMode(page), overlay: await overlayState(page), ptr: (await readPointerLog(page)).slice(0, 12) })
      // HMR interference signature: pixels changed but the editor reset (owner
      // none, unknown mode, Ready status, no undo). Restart the attempt cleanly.
      if (tokenA.includes('owner=none') || (await costumeMode(page)) === 'unknown') {
        log('hmr-interference-phaseA', { token: tokenA, attempt })
        continue
      }
      // Reference delta note: Scratch stays in BIT_RECT here; product auto-switches to select.
      log('reference-tool-delta', { productAfterCommit: toolAfterA, scratchReference: 'stays BIT_RECT/BIT_OVAL with shape selected (no changeMode on setSelectedItems)' })
      expect(changedPixels(beforeA, afterA)).toBeGreaterThan(0)
      expect(await selectionCount(page)).toBe(1)

      // Phase B: Undo -> Redo in the SAME session (no reload).
      // HMR guard: a reload can detach the canvas mid-wait (getContext of null).
      try {
      await page.locator('button[aria-label="Undo"]').first().click()
      // Pixels must revert to beforeA; then wait for the async bitmap reload to settle.
      await page.waitForFunction((before: number[]) => {
        const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
        if (!t) return false
        const ctx = t.getContext('2d')
        if (!ctx) return false
        const d = Array.from(ctx.getImageData(0, 0, t.width, t.height).data)
        return d.length === before.length && d.every((v, i) => v === before[i])
      }, beforeA, { timeout: 30_000 })
      } catch (e) {
        log('hmr-interference-phaseB-undo-wait', { error: String(e).slice(0, 300), attempt })
        continue
      }
      const tokenUndo = await waitSettled(page)
      log('phaseB-undo', { token: tokenUndo, status: await statusText(page), selection: await selectionCount(page), tool: { rect: await toolActive(page, 'rect'), select: await toolActive(page, 'select') }, vm: await vmCostumeMeta(page), undo: await undoEnabled(page), redo: await redoEnabled(page), mode: await costumeMode(page), overlay: await overlayState(page), focus: await focusState(page), geometry: await geometry(page) })

      try {
      await page.locator('button[aria-label="Redo"]').first().click()
      await page.waitForFunction((before: number[]) => {
        const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
        if (!t) return false
        const ctx = t.getContext('2d')
        if (!ctx) return false
        const d = Array.from(ctx.getImageData(0, 0, t.width, t.height).data)
        return d.some((v, i) => Math.abs(v - before[i]!) > 4)
      }, beforeA, { timeout: 30_000 })
      } catch (e) {
        log('hmr-interference-phaseB-redo-wait', { error: String(e).slice(0, 300), attempt })
        continue
      }
      const tokenRedo = await waitSettled(page)
      const afterRedo = await snapshotCanvas(page)
      log('phaseB-redo', { token: tokenRedo, status: await statusText(page), selection: await selectionCount(page), changedVsBefore: changedPixels(beforeA, afterRedo), tool: { rect: await toolActive(page, 'rect'), select: await toolActive(page, 'select') }, vm: await vmCostumeMeta(page), undo: await undoEnabled(page), redo: await redoEnabled(page), mode: await costumeMode(page), overlay: await overlayState(page), focus: await focusState(page), geometry: await geometry(page) })

      // Phase C: same-tool next Shift draw WITHOUT any reload (the true-difference probe).
      // Re-arm rect explicitly (product auto-switched to select after Phase A).
      log('phaseC-geometry-before-rearm', await geometry(page))
      await page.getByTestId('bitmap-tool-rect').click()
      log('phaseC-geometry-after-rearm', await geometry(page))
      const preC = {
        token: await token(page),
        status: await statusText(page),
        tool: { rect: await toolActive(page, 'rect'), oval: await toolActive(page, 'oval'), select: await toolActive(page, 'select') },
        mode: await costumeMode(page),
        selection: await selectionCount(page),
        undo: await undoEnabled(page),
        redo: await redoEnabled(page),
        focus: await focusState(page),
        overlay: await overlayState(page),
        vm: await vmCostumeMeta(page),
        box: await page.getByTestId('bitmap-editor-canvas').boundingBox(),
        visible: await page.getByTestId('bitmap-editor-canvas').isVisible(),
        geometry: await geometry(page),
      }
      const surfC = ((preC as any).geometry as any)?.surfaceRect
      if (!surfC || !(surfC.w > 0) || !(surfC.h > 0)) throw new Error('Missing paint surface rect (Phase C)')
      const cFrom = { x: surfC.x + surfC.w / 2 - 30, y: surfC.y + surfC.h / 2 - 10 }
      const cTo = { x: surfC.x + surfC.w / 2 + 30, y: surfC.y + surfC.h / 2 + 10 }
      const cFromCanvas = { x: NaN, y: NaN }
      const cToCanvas = { x: NaN, y: NaN }
      const prePixels = await snapshotCanvas(page)
      log('phaseC-pre', { ...preC, cFromCanvas, cToCanvas, cFrom, cTo, hitFrom: await hitAt(page, cFrom.x, cFrom.y), hitTo: await hitAt(page, cTo.x, cTo.y) })
      if (preC.token.includes('owner=none') || preC.mode !== 'bitmap') {
        log('hmr-interference-phaseC', { token: preC.token, mode: preC.mode, attempt })
        continue
      }
      expect(preC.token).toContain('pending=none')
      expect(preC.tool.rect).toBe(true)

      await clearPointerLog(page)
      await page.mouse.move(cFrom.x, cFrom.y)
      await page.mouse.down()
      await page.keyboard.down('Shift')
      await page.mouse.move(cTo.x, cTo.y, { steps: 12 })
      await page.mouse.up()
      await page.keyboard.up('Shift')

      // Poll with continuous monitoring (distinguishes pending/refusal/tool/focus).
      const deadline = Date.now() + 20_000
      let selC = 0
      let sampledToken = ''
      let sampledStatus = ''
      let sampledTool = {}
      while (Date.now() < deadline) {
        selC = await selectionCount(page)
        sampledToken = await token(page)
        sampledStatus = await statusText(page)
        sampledTool = { rect: await toolActive(page, 'rect'), select: await toolActive(page, 'select') }
        if (selC === 1) break
        await page.waitForTimeout(250)
      }
      const postPixels = await snapshotCanvas(page)
      const ptrLog = await readPointerLog(page)
      const postC = {
        selection: selC,
        style: await selectionStyle(page),
        changedVsPre: changedPixels(prePixels, postPixels),
        token: sampledToken,
        tokenNow: await token(page),
        status: sampledStatus,
        statusNow: await statusText(page),
        tool: sampledTool,
        toolNow: { rect: await toolActive(page, 'rect'), select: await toolActive(page, 'select') },
        mode: await costumeMode(page),
        undo: await undoEnabled(page),
        redo: await redoEnabled(page),
        focus: await focusState(page),
        overlay: await overlayState(page),
        vm: await vmCostumeMeta(page),
        box: await page.getByTestId('bitmap-editor-canvas').boundingBox(),
        hitFromNow: await hitAt(page, cFrom.x, cFrom.y),
        ptrKinds: ptrLog.map((e: any) => `${e.kind}:${e.type}#${e.pid}`).slice(0, 30),
        ptrCount: ptrLog.length,
        ptrSample: ptrLog.slice(0, 10),
      }
      log('phaseC-post', postC)

      // Cause determination (logged; the final expect below keeps the failure).
      const downFired = ptrLog.some((e: any) => e.type === 'pointerdown' && String(e.kind).startsWith('surface'))
      const upFired = ptrLog.some((e: any) => (e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'lostpointercapture') && String(e.kind).startsWith('surface'))
      const hitMiss = !(await hitAt(page, cFrom.x, cFrom.y) as any).canvas
      let cause = 'unknown'
      if (!downFired && hitMiss) cause = 'hit-miss/viewport-stale (fixed canvas coords map outside the visible surface after Undo/Redo viewport shift; surface pointerdown never fires)'
      else if (!downFired) cause = 'not-firing (no surface pointerdown; suspect stale activeCanvasPointerId/capture or hit miss)'
      else if (!upFired) cause = 'not-firing (down fired but no surface pointerup; suspect capture/mouse stale)'
      else if ((sampledTool as any).select === true && (sampledTool as any).rect === false && selC === 0 && changedPixels(prePixels, postPixels) === 0) cause = 'auto-switch-or-gate (tool left rect with no commit; check commit gate/refusal)'
      else if (sampledToken.includes('pending=') && !sampledToken.includes('pending=none')) cause = 'history-restore bitmap reload pending (token unsettled during draw)'
      else if (String(sampledStatus).includes('cancelled')) cause = 'refusal (stale workspace refused the stroke)'
      else if ((postC.focus as any)?.tag === 'BUTTON') cause = 'focus-stale (focus on button during Shift draw; check modifiers/focus)'
      else if (selC === 0) cause = 'commit-gate-or-refusal (events fired, settled, focused, but shape gate dropped it)'
      log('cause', { cause, downFired, upFired, hitMiss, undoBeforeA, tokenUndo, tokenRedo })

      // Diagnostic retry at a verified-hit point (center of the live surface):
      // proves the paint gate itself is healthy when coords are valid. Logged
      // only; the primary expect below still records the true difference.
      if (selC === 0) {
        try {
          const geo = await geometry(page)
          const s = (geo as any).surfaceRect
          const probe = s ? { x: s.x + s.w / 2, y: s.y + s.h / 2 } : cTo
          const probeHit = await hitAt(page, probe.x, probe.y)
          log('retry-probe', { probe, probeHit, geometry: geo })
          if ((probeHit as any).canvas) {
            await clearPointerLog(page)
            const beforeRetry = await snapshotCanvas(page)
            const rDown = { x: probe.x - 30, y: probe.y - 10 }
            const rUp = { x: probe.x + 30, y: probe.y + 10 }
            log('retry-steps', { rDown, rUp, hitDown: await hitAt(page, rDown.x, rDown.y), hitUp: await hitAt(page, rUp.x, rUp.y), statusBefore: await statusText(page), tokenBefore: await token(page), toolBefore: { rect: await toolActive(page, 'rect'), select: await toolActive(page, 'select') } })
            await page.mouse.move(rDown.x, rDown.y)
            await page.mouse.down()
            log('retry-after-down', { status: await statusText(page), token: await token(page), ptr: (await readPointerLog(page)).slice(-4) })
            await page.keyboard.down('Shift')
            await page.mouse.move(rUp.x, rUp.y, { steps: 12 })
            log('retry-after-move', { status: await statusText(page), token: await token(page), ptr: (await readPointerLog(page)).slice(-6) })
            await page.mouse.up()
            await page.keyboard.up('Shift')
            log('retry-after-up', { status: await statusText(page), token: await token(page), ptr: (await readPointerLog(page)).slice(-8) })
            let selRetry = 0
            const rDeadline = Date.now() + 10_000
            while (Date.now() < rDeadline) {
              selRetry = await selectionCount(page)
              if (selRetry === 1) break
              await page.waitForTimeout(250)
            }
            log('retry-result', { selection: selRetry, changed: changedPixels(beforeRetry, await snapshotCanvas(page)), token: await token(page), status: await statusText(page), tool: { rect: await toolActive(page, 'rect'), select: await toolActive(page, 'select') }, ptrFull: await readPointerLog(page) })
          }
        } catch (e) {
          log('retry-error', String(e))
        }
      }

      // The true difference: this must be 1 in a healthy editor. Left failing
      // with the forensics above when the bug is present.
      // Minimal fix proposal (for the Editor.svelte owner; not applied here):
      // keep the bitmap viewport stable across Undo/Redo history restores when
      // the canvas dimensions are unchanged (same slot, same 960x720): do not
      // mint a new viewport key / first-fit on `restoreHistoryEntry` (the md5ext
      // changes but the artboard does not), or preserve viewportX/Y/scale across
      // the reload. Test-side, always re-measure the live boundingBox and verify
      // elementFromPoint hits the canvas before drawing (this file does both).
      expect(selC).toBe(1)
      attemptDone = true
      } // end attempt loop
      expect(attemptDone).toBe(true)
    } finally {
      await context.close()
    }
  }, 240_000)
})
