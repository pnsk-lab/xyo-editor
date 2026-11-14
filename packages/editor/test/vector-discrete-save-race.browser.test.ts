// Vector discrete-save scope audit (VM selection-precondition guard).
//
// Covers the saveVectorCostume / saveVectorShapeInRect race: the Editor
// `isAlive` check runs inside the per-slot gate, so a target/costume switch
// landing after `isAlive` passed but during the VM `storeAsset` await still
// steered bytes into the newly selected asset. The fix adds a
// backward-compatible optional VM selection precondition
// (`{ targetId, index }` + project generation + monotonic selection epoch,
// explicit discrete commits only) validated at enqueue, at queue start, and
// after `storeAsset` immediately before the atomic mutation (IDs exact, no
// name fallback; away-and-back detected via the epoch, reloads via the
// generation). On failure the VM returns `applied:false, reason: superseded`
// with no bytes/meta/history/status/selection changes, consumed silently.
// Previews, cancel restores, history, and external plugin calls omit the
// precondition and keep legacy behavior. T1/T2 are isolated on fresh
// page/context; remaining legs also use fresh page/context to avoid cascade
// with strict bytes/meta/history assertions.
//
// Method (test-only): real Editor via `test/paint-history-isolation-fixture.html`
// with a deferred gate patched onto THAT VM instance's `updateCostumeIfMatch`
// (+ `updateCostume` for legacy routes). The gate wraps the VM commit point
// (post-`storeAsset` CAS compare-and-swap), NOT `storeAsset` itself and NOT
// Editor-level save entry points: the production race is a target/costume
// switch landing after `isAlive` passed but before the commit mutation, so
// only a commit-point delay opens the exact window. A naive injector that
// delays `storeAsset`, the Editor save function, or every write (`all`
// without a queue-entry counter) either serializes the racing switch behind
// the delay or lets the switch land outside the capture→commit window, which
// would pass vacuously. `all` delays every write; `once` delays only the next
// write. Switch legs complete the rect with no delay first (background
// completions then predate the switch), then defer only the stamp's own CAS
// write so the switch lands strictly inside that save's window (queue entry
// observed via the gate counter, never via wall-clock sleeps).
// Status discipline: a target switch (`vm.selectTarget`) issues NO status, so
// the T1 leg must NOT expect `Costume selected` — the pre-switch rect's
// `Vector shape saved` legitimately remains. T1 therefore snapshots the
// correct baseline status right before arming the failing save and asserts
// strict equality afterwards (plus `not.toBe('Vector costume saved')`): the
// aborted stamp must emit no new success status and no selection write.
// A costume switch (`selectCostume`) DOES set `Costume selected` explicitly,
// so only the T2 leg expects it. Destination bytes + history stay strictly
// unchanged on every abort leg.
// Assertions describe CORRECT behaviour and FAIL loudly (never skipped);
// impossible setups report INVALID instead of failing. VM bytes are the only
// byte-identity oracle (`loadAsset`); `.vector-preview` renders a display
// normalization (full-canvas re-export), so preview legs assert shape markers,
// never string equality with stored bytes.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4551
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/200/svg" width="480" height="360" viewBox="0 0 480 360">'
const BLANK_VEC = `${HEAD}</svg>`
const rectSvg = (x: number, y: number, w: number, h: number, fill: string) =>
  `${HEAD}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#111111" stroke-width="2"/></svg>`
const RECT_A2 = rectSvg(150, 120, 140, 110, '#e74c3c')
const RECT_B = rectSvg(200, 140, 100, 80, '#2980b9')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const blank = add(BLANK_VEC)
  const a2 = add(RECT_A2)
  const b = add(RECT_B)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const project = {
    targets: [
      {
        isStage: false, name: 'VecA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(blank, 'vec-blank'), costume(a2, 'vec-a2')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
      {
        isStage: false, name: 'VecB', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0, costumes: [costume(b, 'vec-b')],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 80, y: 40, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'discrete-save-audit', agent: 'discrete-save-audit' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function log(label: string, value: unknown) {
  console.log(`[discrete-save] ${label} ${JSON.stringify(value).slice(0, 2500)}`)
}

async function snapshot(): Promise<any> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest')
    return api.snapshot()
  })
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status() ?? '')
}

async function costumeMd5Of(targetName: string, index: number): Promise<string | null> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.name === targetName)
  return (target?.costumes[index]?.md5ext as string | undefined) ?? null
}

async function costumeMetaOf(targetName: string, index: number): Promise<any> {
  const snap = await snapshot()
  const c = snap.project.targets.find((t: any) => t.name === targetName)?.costumes[index]
  if (!c) return null
  return { name: c.name, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, md5ext: c.md5ext, assetId: c.assetId }
}

async function svgBytesOf(targetName: string, index: number): Promise<string> {
  return await page.evaluate(async ({ t, i }: { t: string; i: number }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm')
    const tgt = vm.getTarget(t)
    if (!tgt) throw new Error(`Missing target ${t}`)
    const c = tgt.costumes[i]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { t: targetName, i: index })
}

async function slotIdentity(targetName: string, index: number): Promise<any> {
  return await page.evaluate(async ({ t, i }: { t: string; i: number }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const tgt = vm.getTarget(t)
    const id = tgt?.id ?? t
    return { ident: vm.getCostumeIdentity?.(id, i), gen: vm.getProjectGeneration?.() }
  }, { t: targetName, i: index })
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewSvgChange(previous: string, timeout = 20_000) {
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, previous, { timeout })
}

// Preview-vs-bytes discipline: `.vector-preview` renders a display
// normalization (full-canvas re-export, e.g. `viewBox="0 0 480 360"` with
// `<rect></rect>`), NOT the stored Paper-exported bytes (tight-crop viewBox,
// self-closing tags). Byte-identity therefore lives ONLY in VM `loadAsset`
// assertions; preview assertions check shape markers (the artwork is viewable
// and structurally consistent with the bytes).
async function waitForPreviewShapeCounts(want: { rect: number; ellipse: number }, timeout = 20_000) {
  await page.waitForFunction((w: { rect: number; ellipse: number }) => {
    const html = document.querySelector('.vector-preview')?.innerHTML
    if (html == null) return false
    const count = (tag: string) => (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length
    return count('rect') === w.rect && count('ellipse') === w.ellipse
  }, want, { timeout })
}

async function undoRedoEnabled(): Promise<{ undo: boolean; redo: boolean }> {
  return await page.evaluate(() => {
    const vis = (el: Element | null) => {
      if (!(el instanceof HTMLElement)) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    let undo = false, redo = false
    for (const b of Array.from(document.querySelectorAll('button[aria-label="Undo"]'))) {
      if (vis(b) && !(b as HTMLButtonElement).disabled) undo = true
    }
    for (const b of Array.from(document.querySelectorAll('button[aria-label="Redo"]'))) {
      if (vis(b) && !(b as HTMLButtonElement).disabled) redo = true
    }
    return { undo, redo }
  })
}

async function clickUndoVisible() {
  const buttons = page.getByRole('button', { name: 'Undo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if (await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) {
      await b.click()
      return
    }
  }
  throw new Error('No enabled visible Undo button')
}

async function clickRedoVisible() {
  const buttons = page.getByRole('button', { name: 'Redo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if (await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) {
      await b.click()
      return
    }
  }
  throw new Error('No enabled visible Redo button')
}

// Deferred gate on the REAL VM instance (test-only page patch). Patches both
// the versioned CAS route and the legacy route: discrete saves commit via
// `updateCostumeIfMatch`, so delaying only `updateCostume` would leave no
// drain window. `all` delays every write; `once` delays only the next write.
async function installVmGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for gate install')
    if (w.__discreteSaveGate) return
    const gate = (w.__discreteSaveGate = { mode: 'off', ms: 500, calls: [] as Array<{ fn: string; target: string; index: number }>, delayed: 0 })
    for (const fn of ['updateCostumeIfMatch', 'updateCostume'] as const) {
      const orig = (vm[fn] as (...a: any[]) => Promise<any>).bind(vm)
      vm[fn] = async (...args: any[]) => {
        gate.calls.push({ fn, target: String(args[0]), index: Number(args[1]) })
        if (gate.mode === 'all' || gate.mode === 'once') {
          if (gate.mode === 'once') gate.mode = 'off'
          gate.delayed += 1
          await new Promise((r) => setTimeout(r, gate.ms))
        }
        return orig(...args)
      }
    }
  })
}

// Fresh page per test (T1/T2 isolated, remaining legs never share a context):
// avoids toolbar/history/selection cascade across legs and gives each leg a
// clean VM gate + strict bytes/meta/history baseline. The Vite server + browser
// stay shared; only the context/page is replaced.
async function openFreshTestPage(): Promise<void> {
  try {
    await page.context().close().catch(() => undefined)
  } catch {}
  if (!browser) throw new Error('Browser not started')
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 300)))
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await installVmGate()
}

async function setGate(mode: 'off' | 'all' | 'once', ms = 500) {
  await page.evaluate(({ m, delay }: { m: string; delay: number }) => {
    const w = window as unknown as Record<string, any>
    if (!w.__discreteSaveGate) throw new Error('Gate not installed')
    w.__discreteSaveGate.mode = m
    w.__discreteSaveGate.ms = delay
  }, { m: mode, delay: ms })
}

async function gateCalls(): Promise<Array<{ fn: string; target: string; index: number }>> {
  return await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    return [...(w.__discreteSaveGate?.calls ?? [])]
  })
}

async function clearGateCalls() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__discreteSaveGate) w.__discreteSaveGate.calls = []
  })
}

async function settle(timeout = 25_000) {
  await setGate('off')
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, any>
    const calls = w.__discreteSaveGate?.calls?.length ?? 0
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const prev = w.__settlePrev as { calls?: number; html?: string; stableSince?: number } | undefined
    const now = Date.now()
    if (!prev || prev.calls !== calls || prev.html !== html) {
      w.__settlePrev = { calls, html, stableSince: now }
      return false
    }
    return now - (prev.stableSince ?? now) > 900
  }, undefined, { timeout })
  await page.waitForTimeout(400)
}

async function importSb3(bytes: Buffer, fileName: string, expectTarget: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: fileName, mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === want) ?? false,
    expectTarget,
    { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(900)
}

async function ensureVectorMode() {
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  try {
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 60_000 })
  } catch (e) {
    const forensics = await page.evaluate(() => {
      const q = (s: string) => document.querySelector(s)
      const canvas = q('[data-testid="bitmap-editor-canvas"]') as HTMLElement | null
      const pv = q('.vector-preview') as HTMLElement | null
      const api = (window as unknown as { __hikkakuEditorTest?: any }).__hikkakuEditorTest
      const r = pv?.getBoundingClientRect()
      return {
        tab: api?.selectedTab?.(), status: api?.status?.(),
        canvasVisible: canvas ? canvas.getBoundingClientRect().width > 0 : 'NO-CANVAS',
        previewPresent: !!pv, previewBox: r ? { w: r.width, h: r.height } : null,
      }
    })
    log('ensureVectorMode forensics', forensics)
    throw e
  }
}

// User-facing click-stamp entry: the bottom toolbar button (always visible in
// vector mode). The `legacy-save-vector-costume` side-panel button is hidden
// in this layout, so tests must not depend on it.
async function clickStampButton() {
  await page.getByTestId('save-vector-costume').click()
}

async function drawRectDrag(): Promise<void> {
  await page.getByTestId('vector-shape-rect').last().click()
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const before = await previewSvg()
  await page.mouse.move(cx - 110, cy - 60)
  await page.mouse.down()
  await page.mouse.move(cx + 110, cy + 60, { steps: 12 })
  await page.mouse.up()
  await waitForPreviewSvgChange(before)
}

const countTag = (svg: string, tag: string) => (svg.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length

type SvgBounds = { x: number; y: number; width: number; height: number }

// Document-space bounds via the production Paper import (robust when Paper
// exports a moved rect with a transform instead of a rewritten x).
async function boundsList(svgText: string): Promise<SvgBounds[]> {
  return await page.evaluate(async (svg: string) => {
    const { paperVectorObjectList } = await import(
      /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
    )
    const list = await paperVectorObjectList(svg)
    return list.map((item: any) => ({
      x: item.boundsX,
      y: item.boundsY,
      width: item.boundsWidth,
      height: item.boundsHeight,
    }))
  }, svgText)
}

// Stamp shape is toolbar state shared across legs: always pin it to oval
// before a click stamp so a leaked write is attributable (ellipse) and a
// correct abort leaves zero ellipses.
async function selectOvalStampTool() {
  await page.getByTestId('vector-shape-oval').first().click()
}

// Wait until the deferred CAS gate has taken at least `count` VM writes, so a
// follow-up external write deterministically lands inside the save window
// (after capture, before commit) instead of racing the test harness.
async function waitForGateCalls(count: number, timeout = 10_000) {
  await page.waitForFunction(
    (want: number) => ((window as unknown as Record<string, any>).__discreteSaveGate?.calls?.length ?? 0) >= want,
    count,
    { timeout },
  )
}

// Selection awaits (never bare sleeps): the switch owns the UI state change,
// so each leg waits until the live snapshot actually reflects the new
// selection before draining. This keeps the failing save strictly inside its
// window and avoids cascade flakiness across fresh pages.
async function selectedTargetName(): Promise<string | undefined> {
  const snap = await snapshot()
  const sel = snap?.selectedTargetId as string | undefined
  if (!sel) return undefined
  if (snap.project.targets.some((t: any) => t.name === sel)) return sel
  return snap.project.targets.find((t: any) => t.id === sel)?.name
}

async function waitForSelectedTargetName(name: string, timeout = 20_000) {
  await page.waitForFunction((want: string) => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    const snap = api?.snapshot()
    if (!snap) return false
    const sel = snap.selectedTargetId as string | undefined
    if (!sel) return false
    if (sel === want) return true
    return snap.project.targets.find((t: any) => t.id === sel)?.name === want
  }, name, { timeout })
}

async function waitForSelectedCostume(targetName: string, index: number, timeout = 20_000) {
  await page.waitForFunction(({ t, i }: { t: string; i: number }) => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    const snap = api?.snapshot()
    if (!snap) return false
    const tgt = snap.project.targets.find((x: any) => x.name === t)
    if (!tgt || tgt.currentCostume !== i) return false
    const sel = snap.selectedTargetId as string | undefined
    if (!sel) return false
    if (sel === t) return true
    return snap.project.targets.find((x: any) => x.id === sel)?.name === t
  }, { t: targetName, i: index }, { timeout })
}

describe('vector discrete-save scope audit (new test, no product change)', () => {
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
    page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 300)))
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installVmGate()
  }, 120_000)

  afterAll(async () => {
    try {
      await setGate('off')
    } catch {}
    await browser?.close()
    server?.kill()
  })

  it('target switch during a delayed CAS window: new asset bytes + history untouched, no success status', async () => {
    // T1 isolated: fresh page/context so no prior leg leaks toolbar/history.
    await openFreshTestPage()
    await importSb3(buildSb3(), 'discrete.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await waitForSelectedTargetName('VecA')
    const newBytesPre = await svgBytesOf('VecB', 0)
    const newMd5Pre = await costumeMd5Of('VecB', 0)
    // Fast rect first (no gate): it completes before the switch, so the
    // baseline below is the rect's own success status. The stamp shape is
    // pinned to oval first (toolbar state leaks across legs): a leaked stamp
    // would be an attributable ellipse.
    await setGate('off')
    await clearGateCalls()
    await drawRectDrag()
    await settle()
    await selectOvalStampTool()
    // Correct baseline captured AFTER all pre-switch UI work: the rect's
    // `Vector shape saved`. A target switch issues no status and the aborted
    // stamp must stay silent, so this exact value has to survive the leg.
    const statusBaseline = await editorStatus()
    expect(statusBaseline).toBe('Vector shape saved')
    // Delay only the stamp's own CAS write (queue entry observed via the gate
    // counter, not via wall-clock sleeps): the switch below lands strictly
    // inside the save window (after capture, before commit) and the in-queue
    // scope guard aborts the write itself, not just the post-commit UI.
    await clearGateCalls()
    await setGate('once', 800)
    await page.getByTestId('save-vector-costume').click()
    await waitForGateCalls(1)
    // Switch mid-save via the real app route (keyboard, capture-safe), then
    // await the live selection flip itself (not a fixed sleep).
    const card = page.getByTestId('target-card-VecB')
    await card.focus()
    await page.keyboard.press('Enter')
    await waitForSelectedTargetName('VecB')
    expect(await selectedTargetName()).toBe('VecB')
    await settle()
    const newBytesAfter = await svgBytesOf('VecB', 0)
    const newMd5After = await costumeMd5Of('VecB', 0)
    const oldBytesAfter = await svgBytesOf('VecA', 0)
    const pairAfter = await undoRedoEnabled()
    const status = await editorStatus()
    log('target-switch', { statusBaseline, newMd5Pre, newMd5After, rects: countTag(oldBytesAfter, 'rect'), ellipses: countTag(oldBytesAfter, 'ellipse'), pairAfter, status })
    // New selection: bytes + identity untouched, no stamp leaked into it.
    expect(newMd5After).toBe(newMd5Pre)
    expect(newBytesAfter).toBe(newBytesPre)
    expect(countTag(newBytesAfter, 'ellipse')).toBe(0)
    // Old slot: the rect drag applied exactly once; the racing click stamp
    // (oval => ellipse) was aborted, not steered into either asset.
    expect(countTag(oldBytesAfter, 'rect')).toBe(1)
    expect(countTag(oldBytesAfter, 'ellipse')).toBe(0)
    // History: the pre-switch rect entry is dropped by the switch (the
    // selection switch clears paint history by design) and the aborted stamp
    // created none. Status: the failed save emitted no success status and the
    // target switch owns none, so the correct pre-switch baseline survives
    // verbatim (in particular NOT the stamp's `Vector costume saved`).
    expect(pairAfter).toEqual({ undo: false, redo: false })
    expect(status).toBe(statusBaseline)
    expect(status).not.toBe('Vector costume saved')
    // Back on the old asset the landed rect is intact and viewable.
    await page.getByTestId('target-card-VecA').click()
    await waitForSelectedTargetName('VecA')
    await waitForPreviewShapeCounts({ rect: 1, ellipse: 0 })
    expect(await svgBytesOf('VecA', 0)).toBe(oldBytesAfter)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
  }, 180_000)

  it('costume switch during a delayed CAS window: sibling slot + history untouched', async () => {
    // T2 isolated: fresh page/context, real UI costume switch (IDs exact).
    await openFreshTestPage()
    await importSb3(buildSb3(), 'discrete-costume.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await waitForSelectedTargetName('VecA')
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await waitForSelectedCostume('VecA', 0)
    const sibBytesPre = await svgBytesOf('VecA', 1)
    const sibMd5Pre = await costumeMd5Of('VecA', 1)
    // Same CAS-window discipline as the target-switch leg: fast rect first
    // (completes pre-switch), then only the stamp's own write is deferred so
    // the switch lands strictly inside its save window.
    await setGate('off')
    await clearGateCalls()
    await drawRectDrag()
    await settle()
    await selectOvalStampTool()
    const statusBaseline = await editorStatus()
    expect(statusBaseline).toBe('Vector shape saved')
    await clearGateCalls()
    await setGate('once', 800)
    await page.getByTestId('save-vector-costume').click()
    await waitForGateCalls(1)
    await page.locator('[data-testid="costume-card-1"] button[aria-label^="Select "]').focus()
    await page.keyboard.press('Enter')
    await waitForSelectedCostume('VecA', 1)
    await settle()
    const sibBytesAfter = await svgBytesOf('VecA', 1)
    const sibMd5After = await costumeMd5Of('VecA', 1)
    const oldBytesAfter = await svgBytesOf('VecA', 0)
    const pairAfter = await undoRedoEnabled()
    const status = await editorStatus()
    log('costume-switch', { statusBaseline, sibMd5Pre, sibMd5After, rects: countTag(oldBytesAfter, 'rect'), ellipses: countTag(oldBytesAfter, 'ellipse'), pairAfter, status })
    expect(sibMd5After).toBe(sibMd5Pre)
    expect(sibBytesAfter).toBe(sibBytesPre)
    expect(countTag(sibBytesAfter, 'ellipse')).toBe(0)
    expect(countTag(oldBytesAfter, 'rect')).toBe(1)
    expect(countTag(oldBytesAfter, 'ellipse')).toBe(0)
    expect(pairAfter).toEqual({ undo: false, redo: false })
    // Unlike a target switch, a costume switch explicitly owns the status.
    expect(status).toBe('Costume selected')
    expect(status).not.toBe(statusBaseline)
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await waitForSelectedCostume('VecA', 0)
    await waitForPreviewShapeCounts({ rect: 1, ellipse: 0 })
    expect(await svgBytesOf('VecA', 0)).toBe(oldBytesAfter)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
  }, 180_000)

  it('same-slot external meta-only write: CAS refusal keeps external bytes/meta + conflict status', async () => {
    // Fresh page/context to avoid cascade; strict bytes/meta/history checks.
    await openFreshTestPage()
    await importSb3(buildSb3(), 'discrete-extmeta.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await waitForSelectedTargetName('VecA')
    await setGate('off')
    await clearGateCalls()
    const bytesPre = await svgBytesOf('VecA', 0)
    expect(bytesPre).toBe(BLANK_VEC)
    await selectOvalStampTool()
    const pairBefore = await undoRedoEnabled()
    // Delay only the save's own CAS write; the external below lands strictly
    // inside the save window (after capture, before commit).
    await setGate('once', 800)
    await page.getByTestId('save-vector-costume').click()
    await waitForGateCalls(1)
    // External metadata-only write (same bytes, new meta): bumps writeSeq, so
    // the in-flight save's versioned expected no longer matches.
    await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      await vm.updateCostume('VecA', 0, { name: 'vec-ext', rotationCenterX: 111, rotationCenterY: 99 })
    })
    const metaExt = await costumeMetaOf('VecA', 0)
    expect(metaExt.name).toBe('vec-ext')
    await settle()
    const bytesAfter = await svgBytesOf('VecA', 0)
    const metaAfter = await costumeMetaOf('VecA', 0)
    const pairAfter = await undoRedoEnabled()
    const status = await editorStatus()
    log('ext-meta', { bytesKept: bytesAfter === bytesPre, metaAfter, pairBefore, pairAfter, status })
    // External wins: bytes + meta untouched, conflict surfaced, no new
    // selection/history writes (no ellipse stamped, no undo entry).
    expect(bytesAfter).toBe(bytesPre)
    expect(metaAfter).toEqual(metaExt)
    expect(countTag(bytesAfter, 'ellipse')).toBe(0)
    expect(pairAfter).toEqual(pairBefore)
    expect(status).toContain('External costume change kept')
  }, 180_000)

  it('same-slot external new-bytes write: CAS refusal keeps external bytes + status', async () => {
    // Fresh page/context to avoid cascade; strict bytes/meta/history checks.
    await openFreshTestPage()
    await importSb3(buildSb3(), 'discrete-extbytes.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await waitForSelectedTargetName('VecA')
    await setGate('off')
    await clearGateCalls()
    const bytesPre = await svgBytesOf('VecA', 0)
    expect(bytesPre).toBe(BLANK_VEC)
    await selectOvalStampTool()
    const pairBefore = await undoRedoEnabled()
    // Same deterministic window as the meta-only leg.
    await setGate('once', 800)
    await page.getByTestId('save-vector-costume').click()
    await waitForGateCalls(1)
    // External new-bytes write via the unconditional legacy route.
    const extSvg = rectSvg(40, 40, 60, 50, '#16a085')
    await page.evaluate(async (svg: string) => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      await vm.updateCostume('VecA', 0, { dataFormat: 'svg' }, new TextEncoder().encode(svg))
    }, extSvg)
    const bytesExt = await svgBytesOf('VecA', 0)
    expect(bytesExt).not.toBe(bytesPre)
    await settle()
    const bytesAfter = await svgBytesOf('VecA', 0)
    const pairAfter = await undoRedoEnabled()
    const status = await editorStatus()
    log('ext-bytes', { kept: bytesAfter === bytesExt, pairBefore, pairAfter, status })
    expect(bytesAfter).toBe(bytesExt)
    expect(countTag(bytesAfter, 'ellipse')).toBe(0)
    expect(pairAfter).toEqual(pairBefore)
    expect(status).toContain('External costume change kept')
  }, 180_000)

  it('normal rect drag + click stamp: strict Undo/Redo byte round-trip', async () => {
    // Fresh page/context to avoid cascade; strict bytes/meta/history checks.
    await openFreshTestPage()
    await importSb3(buildSb3(), 'discrete-roundtrip.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await waitForSelectedTargetName('VecA')
    await setGate('off')
    expect(await svgBytesOf('VecA', 0)).toBe(BLANK_VEC)
    await drawRectDrag()
    await settle()
    const rectBytes = await svgBytesOf('VecA', 0)
    expect(countTag(rectBytes, 'rect')).toBe(1)
    // Pin the stamp shape explicitly: the toolbar leaks across legs, so an
    // unpinned stamp would inherit whatever the previous leg selected and
    // the strict rect/ellipse asserts below would be order-dependent.
    await selectOvalStampTool()
    await page.getByTestId('save-vector-costume').click()
    await settle()
    const bothBytes = await svgBytesOf('VecA', 0)
    expect(countTag(bothBytes, 'rect')).toBe(1)
    expect(countTag(bothBytes, 'ellipse')).toBe(1)
    expect(await editorStatus()).toBe('Vector costume saved')
    // Undo removes the stamp only; second Undo removes the rect. Each step is
    // awaited on the preview shape markers, byte-exactness on VM bytes.
    await clickUndoVisible()
    await waitForPreviewShapeCounts({ rect: 1, ellipse: 0 })
    expect(await svgBytesOf('VecA', 0)).toBe(rectBytes)
    await clickUndoVisible()
    await waitForPreviewShapeCounts({ rect: 0, ellipse: 0 })
    expect(await svgBytesOf('VecA', 0)).toBe(BLANK_VEC)
    // Redo restores rect, then rect + stamp, byte-exact.
    await clickRedoVisible()
    await waitForPreviewShapeCounts({ rect: 1, ellipse: 0 })
    expect(await svgBytesOf('VecA', 0)).toBe(rectBytes)
    await clickRedoVisible()
    await waitForPreviewShapeCounts({ rect: 1, ellipse: 1 })
    expect(await svgBytesOf('VecA', 0)).toBe(bothBytes)
    expect(await undoRedoEnabled()).toEqual({ undo: true, redo: false })
  }, 180_000)

  it('queued move + stamp: stamp builds on the move-final base, strict Undo/Redo', async () => {
    // Fresh page/context to avoid cascade; strict bytes/meta/history checks.
    await openFreshTestPage()
    await importSb3(buildSb3(), 'discrete-queued.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await waitForSelectedTargetName('VecA')
    await setGate('off')
    await drawRectDrag()
    await settle()
    const rectBytes = await svgBytesOf('VecA', 0)
    const rectX = Number((rectBytes.match(/<rect[^>]*\sx="([\d.\-]+)"/) ?? [])[1])
    expect(Number.isFinite(rectX)).toBe(true)
    // Select the rect, then move it while the CAS write is delayed; the
    // follow-up stamp must drain (wait for the move) and build on the
    // move-final base instead of the pre-move base.
    await page.getByTestId('vector-shape-select').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(500)
    await setGate('all', 600)
    await clearGateCalls()
    const outline = page.locator('[data-vector-selection-outline]').first()
    await outline.waitFor({ state: 'visible', timeout: 20_000 })
    const ob = await outline.boundingBox()
    if (!ob) throw new Error('Missing selection outline bounds')
    const sx = ob.x + ob.width / 2
    const sy = ob.y + ob.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx + 70, sy + 6, { steps: 10 })
    await page.mouse.up()
    // Shape-mode ambiguity guard: the stamp press below (surface center -
    // 110, -60) coincides with the still-unmoved selection's NW corner while
    // the move write is gated, so without a deselect the rect tool would
    // delegate to a move/resize (hit) and never call saveVectorShapeInRect —
    // a 1-rect final would then mean "no stamp attempted", not "stamp lost".
    // Escape keeps applied moves and clears the selection, guaranteeing the
    // next drag is a true blank-press stamp that still drains behind the
    // delayed move write (queued, move-final base).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    // Immediately stamp a second rect (drains behind the delayed move write).
    await drawRectDrag()
    await settle()
    const finalBytes = await svgBytesOf('VecA', 0)
    const movedX = Number((finalBytes.match(/<rect[^>]*\sx="([\d.\-]+)"/) ?? [])[1])
    log('queued', { rectX, movedX, rects: countTag(finalBytes, 'rect'), calls: await gateCalls(), slot: await slotIdentity('VecA', 0), status: await editorStatus(), pair: await undoRedoEnabled() })
    // Both shapes present and the move was not lost (first rect shifted).
    expect(countTag(finalBytes, 'rect')).toBe(2)
    expect(Math.abs(movedX - rectX)).toBeGreaterThan(5)
    // Strict history: Undo drops the stamp (moved rect kept), Undo drops the
    // move (original rect1 byte-exact), Undo drops rect1 (blank), Redo x3
    // restores byte-exact.
    await clickUndoVisible()
    await settle()
    const afterOneUndo = await svgBytesOf('VecA', 0)
    expect(countTag(afterOneUndo, 'rect')).toBe(1)
    expect(afterOneUndo).not.toBe(rectBytes)
    await clickUndoVisible()
    await settle()
    expect(await svgBytesOf('VecA', 0)).toBe(rectBytes)
    await clickUndoVisible()
    await settle()
    expect(await svgBytesOf('VecA', 0)).toBe(BLANK_VEC)
    await clickRedoVisible()
    await settle()
    expect(await svgBytesOf('VecA', 0)).toBe(rectBytes)
    await clickRedoVisible()
    await settle()
    expect(await svgBytesOf('VecA', 0)).toBe(afterOneUndo)
    await clickRedoVisible()
    await settle()
    expect(await svgBytesOf('VecA', 0)).toBe(finalBytes)
  }, 180_000)
})
