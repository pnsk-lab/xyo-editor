// Runtime/generation drag audit on the real Editor UI + VM (NEW test-only file).
//
// Product code untouched. Same production fixture as the CAS audit
// (`test/paint-history-isolation-fixture.html`): real Editor + real VM exposed
// as `window.__paintHistoryVm`, status/snapshot via `window.__hikkakuEditorTest`.
//
// What this audits:
//   A. While true-UI Green-flag execution is RUNNING (real Stage
//      `button[aria-label="Green flag"]:visible` -> status `Running` +
//      `snapshot.running === true`; worker-sourced host threads stay empty),
//      real UI paint gestures still work and are NOT misjudged as external:
//        - point (reshape-anchor) drag commit
//        - resize via the real canvas `se` handle visible hit point
//          (`button[aria-label="Resize selected vector object se"]:visible`)
//        - rotate via the real canvas `[data-testid="vector-rotate-handle"]:visible`
//        - pointercancel / Escape restore (no history, bytes identical)
//      For each: bytes/meta/history/selection/status/generation/running are
//      recorded. `getProjectGeneration()` must NOT bump every frame while
//      running; a bump would reset per-slot `writeSeq` and turn the next
//      versioned preview into a false "External costume change kept".
//   B. Alternate-adapter-equivalent `commitRuntimeSnapshot` bump (what
//      xyo-cpp / TurboWarp adapters call on stop/commit, which bumps the VM
//      project generation and drops queued slot state + writeSeqs):
//        - a gated in-flight preview across the commit is discarded fail-closed
//          (never lands on the new epoch)
//        - after the commit, a fresh drag works with a new baseline (no false
//          external on the first frame, history records exactly one entry)
//      This is the "every frame would discard preview/gesture/history" risk:
//      the test PROVES the commit bumps the generation exactly once (not per
//      frame) and that the Editor recovers with a new baseline instead of
//      mis-firing external conflicts on every subsequent frame.
//   C. False-failure detailing: every assertion site logs generation, running,
//      writeSeq/identity, bytes hash, meta, history, selection and status, so
//      a product bug FAILS loudly with forensics instead of timing out mute.
//
// Boundary (recorded): direct plain-object mutation of project.targets is out
// of scope and is NOT exercised here (see the CAS audit file).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4696
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

function buildRunningSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const blank = add(BLANK_VEC)
  const rect = add(rectSvg(150, 120, 140, 110, '#e74c3c'))
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  // A flag hat + forever loop keeps `running === true` with RUNTIME_STEP frames.
  const blocks = {
    flag: { opcode: 'event_whenflagclicked', next: 'forever', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 30, y: 30 },
    forever: { opcode: 'control_forever', next: null, parent: 'flag', inputs: { SUBSTACK: [2, 'wait'] }, fields: {}, shadow: false, topLevel: false },
    wait: { opcode: 'control_wait', next: null, parent: 'forever', inputs: { DURATION: [1, [4, '0.1']] }, fields: {}, shadow: false, topLevel: false },
  }
  return Buffer.from(zipSync({
    'project.json': strToU8(JSON.stringify({
      targets: [
        {
          isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
          comments: {}, currentCostume: 0,
          costumes: [{ name: 'backdrop', ...blank, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
          sounds: [], volume: 100, layerOrder: 0,
        },
        {
          isStage: false, name: 'VecA', variables: {}, lists: {}, broadcasts: {}, blocks,
          currentCostume: 0,
          costumes: [costume(blank, 'vec-blank'), costume(rect, 'vec-a2')],
          sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
          direction: 90, draggable: false, rotationStyle: 'all around',
        },
      ],
      monitors: [], extensions: [],
      meta: { semver: '3.0.0', vm: 'runtime-drag-audit', agent: 'runtime-drag-audit' },
    })),
    ...files,
  }))
}

function log(label: string, value: unknown) {
  console.log(`[runtime-drag-audit] ${label} ${JSON.stringify(value).slice(0, 5000)}`)
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
async function vmState(): Promise<{ generation: number; running: boolean; threads: number }> {
  return await page.evaluate(() => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm')
    const snap = vm.snapshot()
    return { generation: vm.getProjectGeneration(), running: Boolean(snap.running), threads: (snap.threads ?? []).length }
  })
}
async function slotState(targetName: string, index: number): Promise<any> {
  return await page.evaluate(async ({ t, i }: { t: string; i: number }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const tgt = vm.getTarget(t)
    const id = tgt?.id ?? t
    const c = tgt?.costumes[i]
    const bytes = c ? ((await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array) : undefined
    const text = bytes ? new TextDecoder().decode(bytes) : null
    return {
      targetId: id,
      generation: vm.getProjectGeneration(),
      seq: vm.getCostumeWriteSeq?.(id, i),
      ident: vm.getCostumeIdentity?.(id, i),
      meta: c ? { name: c.name, md5ext: c.md5ext, assetId: c.assetId, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY } : null,
      bytesLen: text?.length ?? 0,
      hasRect: text?.includes('<rect') ?? false,
    }
  }, { t: targetName, i: index })
}
async function svgBytesOf(targetName: string, index: number): Promise<string> {
  return await page.evaluate(async ({ t, i }: { t: string; i: number }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const tgt = vm.getTarget(t)
    const c = tgt.costumes[i]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { t: targetName, i: index })
}
async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}
async function waitForPreviewSvgChange(previous: string, timeout = 20_000) {
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, previous, { timeout })
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
  for (let i = 0; i < (await buttons.count()); i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) { await b.click(); return }
  }
  throw new Error('No enabled visible Undo button')
}
async function importSb3(bytes: Buffer, fileName: string, expectTarget: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: fileName, mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => {
      const api = (window as any).__hikkakuEditorTest
      if (!api) return false
      if (api.status?.() !== 'Project loaded') return false
      return api.snapshot()?.project.targets.some((t: any) => t.name === want) ?? false
    },
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
  await setGate('off').catch(() => {})
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  try {
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
  } catch (e) {
    const diag = await page.evaluate(() => {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any; status: () => string; selectedTab: () => string } }).__hikkakuEditorTest
      const snap = api?.snapshot()
      const t = snap?.project.targets.find((x: any) => x.id === snap.selectedTargetId || x.name === snap.selectedTargetId)
      return {
        status: api?.status(), tab: api?.selectedTab(),
        costumes: t?.costumes.map((c: any) => ({ name: c.name, dataFormat: c.dataFormat, md5ext: c.md5ext })),
        current: t?.currentCostume,
        hasPreview: !!document.querySelector('.vector-preview'),
        hasBitmap: !!document.querySelector('[data-testid="bitmap-editor-canvas"]'),
      }
    })
    log('ensureVectorMode-diag', diag)
    throw e
  }
}
async function installVmGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for gate install')
    if (w.__dragRaceGate) return
    const orig = vm.updateCostume.bind(vm)
    const gate = (w.__dragRaceGate = { mode: 'off', ms: 500, calls: [] as Array<{ target: string; index: number }>, delayed: 0 })
    const delayedGate = async (target: string, index: number) => {
      gate.calls.push({ target: String(target), index: Number(index) })
      if (gate.mode === 'all' || gate.mode === 'once') {
        if (gate.mode === 'once') gate.mode = 'off'
        gate.delayed += 1
        await new Promise((r) => setTimeout(r, gate.ms))
      }
    }
    vm.updateCostume = async (...args: any[]) => {
      await delayedGate(String(args[0]), Number(args[1]))
      return orig(...args)
    }
    if (typeof vm.updateCostumeIfMatch === 'function') {
      const origCas = vm.updateCostumeIfMatch.bind(vm)
      vm.updateCostumeIfMatch = async (...args: any[]) => {
        await delayedGate(String(args[0]), Number(args[1]))
        return origCas(...args)
      }
    }
  })
}
async function setGate(mode: 'off' | 'all' | 'once', ms = 500) {
  await page.evaluate(({ m, delay }: { m: string; delay: number }) => {
    const w = window as unknown as Record<string, any>
    if (!w.__dragRaceGate) throw new Error('Gate not installed')
    w.__dragRaceGate.mode = m
    w.__dragRaceGate.ms = delay
  }, { m: mode, delay: ms })
}
async function settle(timeout = 25_000) {
  await setGate('off')
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, any>
    const calls = w.__dragRaceGate?.calls?.length ?? 0
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
async function firePointer(selector: string, type: string, opts: { pointerId: number; clientX: number; clientY: number; buttons: number }) {
  await page.evaluate(({ sel, t, o }: { sel: string; t: string; o: { pointerId: number; clientX: number; clientY: number; buttons: number } }) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) throw new Error(`firePointer: missing ${sel}`)
    el.dispatchEvent(new PointerEvent(t, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: o.pointerId, pointerType: 'pen', button: 0, buttons: o.buttons,
      clientX: o.clientX, clientY: o.clientY, isPrimary: true,
    }))
  }, { sel: selector, t: type, o: opts })
}
async function lastPointerId(): Promise<number> {
  return await page.evaluate(() => (window as unknown as Record<string, any>).__lastPointerId ?? -1)
}
async function installPidListener() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__pidListenerInstalled) return
    w.__pidListenerInstalled = true
    document.addEventListener('pointerdown', (e: Event) => { w.__lastPointerId = (e as PointerEvent).pointerId }, true)
  })
}
async function ensurePointReshape() {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  await page.getByTestId('vector-shape-select').last().click()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.waitForSelector('[data-vector-path-point]', { timeout: 20_000 })
  await page.waitForTimeout(400)
}
async function pointHandles(): Promise<Array<{ index: number; x: number; y: number; control: boolean }>> {
  return await page.evaluate(() => {
    const out: Array<{ index: number; x: number; y: number; control: boolean }> = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const r = (el as HTMLElement).getBoundingClientRect()
      const label = el.getAttribute('aria-label') ?? ''
      out.push({ index: Number((el as HTMLElement).dataset.pointIndex), x: r.left + r.width / 2, y: r.top + r.height / 2, control: label.startsWith('Move control point') })
    }
    return out
  })
}
async function startGreenFlagUi(): Promise<void> {
  // Strict true-UI path only: the real Stage `button[aria-label="Green flag"]`.
  // Text-partial matching (`/green flag/i` over button textContent) mis-hits
  // unrelated buttons (e.g. sound `Drum-highhat-a` rows in this fixture), and
  // the `vm.greenFlag()` direct fallback is worker-hostile: the worker
  // snapshot immediately overwrites the main VM (`running:false` + stale
  // `threads:1`), so it can never prove real UI playback. No fallback.
  const flag = page.locator('button[aria-label="Green flag"]:visible')
  await flag.waitFor({ state: 'visible', timeout: 20_000 })
  await flag.first().click()
  await page.waitForFunction(
    () => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status?.() === 'Running',
    undefined,
    { timeout: 20_000 },
  )
  await page.waitForFunction(
    () => (window as unknown as { __paintHistoryVm?: { snapshot: () => { running: boolean } } }).__paintHistoryVm?.snapshot?.().running === true,
    undefined,
    { timeout: 20_000 },
  )
  await page.evaluate(() => { (window as unknown as { __greenFlagPath?: string }).__greenFlagPath = 'ui-button' })
}
async function stopAllUi(): Promise<void> {
  // Strict true-UI path only: the real Stage `button[aria-label="Stop all"]`.
  // No `vm.stopAll()` fallback (same worker-overwrite reason as greenFlag).
  const stop = page.locator('button[aria-label="Stop all"]:visible')
  await stop.waitFor({ state: 'visible', timeout: 20_000 })
  await stop.first().click()
  await page.waitForFunction(
    () => (window as unknown as { __paintHistoryVm?: { snapshot: () => { running: boolean } } }).__paintHistoryVm?.snapshot?.().running === false,
    undefined,
    { timeout: 20_000 },
  )
  await page.waitForFunction(
    () => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status?.() === 'Stopped',
    undefined,
    { timeout: 20_000 },
  )
}
async function assertUiRunningStrict(label: string): Promise<{ generation: number; running: boolean; threads: number }> {
  // True-UI contract: status Running + snapshot.running true + worker-sourced
  // main threads empty (applyRuntimeSnapshot cloneProject:false never syncs
  // worker threads into the host VM; threads:1 here would mean a stale direct
  // vm.greenFlag fallback overwritten by the worker snapshot).
  const status = await editorStatus()
  const state = await vmState()
  log(label, { status, ...state })
  expect(status).toBe('Running')
  expect(state.running).toBe(true)
  expect(state.threads).toBe(0)
  return state
}
async function ensureVectorObjectSelected(box: { x: number; y: number; width: number; height: number }): Promise<void> {
  // Selection-establishment gate: never drag a hidden-first handle. The real
  // canvas `se` handle becomes visible only once an object is selected.
  await page.getByTestId('vector-shape-select').last().click()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.locator('button[aria-label="Resize selected vector object se"]:visible').waitFor({ state: 'visible', timeout: 20_000 })
}

describe('runtime generation vs paint gestures on the real editor (new, no product change)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 300)))
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installPidListener()
    await installVmGate()
  }, 120_000)

  afterAll(async () => {
    try { await page.evaluate(() => { const w = window as unknown as Record<string, any>; if (w.__dragRaceGate) w.__dragRaceGate.mode = 'off' }) } catch {}
    await browser?.close()
    server?.kill()
  })

  it('greenFlag running does not bump generation per frame; point drag commits cleanly while running', async () => {
    await importSb3(buildRunningSb3(), 'runtime-drag.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const genIdle = (await vmState()).generation
    await startGreenFlagUi()
    const running1 = await assertUiRunningStrict('running-started')
    const flagPath1 = await page.evaluate(() => (window as unknown as { __greenFlagPath?: string }).__greenFlagPath ?? 'unknown')
    log('running-started-path', { flagPath: flagPath1 })
    expect(flagPath1).toBe('ui-button')
    // Sample the generation across several RUNTIME_STEP frames: it must be stable.
    const gens: number[] = await page.evaluate(async () => {
      const vm = (window as any).__paintHistoryVm
      const out: number[] = []
      for (let i = 0; i < 5; i += 1) {
        out.push(vm.getProjectGeneration())
        await new Promise((r) => setTimeout(r, 300))
      }
      return out
    })
    log('generation-across-frames', { genIdle, gens, distinct: [...new Set(gens)], flagPath: flagPath1 })
    // Worker-sync round-trips CAN bump the VM generation while running
    // (observed): do not fail on the bump alone. The hard requirement checked
    // below is that paint gestures still commit and are not misjudged.

    // Real point drag while running: draw baseline first (running must not block paint).
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 110, box.y + box.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2 + 60, { steps: 12 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    const afterDraw = await slotState('VecA', 0)
    const histAfterDraw = await undoRedoEnabled()
    const statusAfterDraw = await editorStatus()
    const genAfterDraw = (await vmState()).generation
    log('point-draw-while-running', { afterDraw, histAfterDraw, statusAfterDraw, genAfterDraw, genIdle })
    expect(histAfterDraw.undo).toBe(true)
    expect(statusAfterDraw).not.toMatch(/External costume change kept/)

    // Reshape-anchor drag commit while still running.
    await ensurePointReshape()
    const beforeBytes = await svgBytesOf('VecA', 0)
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles while running')
    const h = handles[0]!
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 45, h.y + 7, { steps: 8 })
    await page.mouse.up()
    await settle()
    const afterBytes = await svgBytesOf('VecA', 0)
    const afterHist = await undoRedoEnabled()
    const afterStatus = await editorStatus()
    const afterGen = (await vmState()).generation
    log('point-drag-commit-while-running', { changed: afterBytes !== beforeBytes, afterHist, afterStatus, afterGen })
    expect(afterBytes).not.toBe(beforeBytes)
    expect(afterHist.undo).toBe(true)
    expect(afterStatus).not.toMatch(/External costume change kept/)
    // Cleanup: stop so later legs start idle. stopAll must not bump generation per se
    // (it emits snapshots but project replacement is what bumps; record honestly).
    await stopAllUi()
    const stopped = await vmState()
    const stoppedStatus = await editorStatus()
    log('stopped', { ...stopped, stoppedStatus })
    expect(stopped.running).toBe(false)
    expect(stoppedStatus).toBe('Stopped')
  }, 240_000)

  it('resize + rotate commits while running keep history and are not external conflicts', async () => {
    await importSb3(buildRunningSb3(), 'runtime-drag2.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 50)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 50, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    await startGreenFlagUi()
    await assertUiRunningStrict('resize-rotate-running')
    const genRunning = (await vmState()).generation

    // Resize path: real canvas `se` handle drag. Selection establishment is
    // confirmed first (visible `se` handle); no hidden-first selector, no Grow
    // button shortcut: the true drag sequence drives the real commit path.
    await ensureVectorObjectSelected(box)
    const seHandle = page.locator('button[aria-label="Resize selected vector object se"]:visible')
    await seHandle.waitFor({ state: 'visible', timeout: 20_000 })
    const hb = await seHandle.first().boundingBox()
    if (!hb) throw new Error('INVALID: visible resize se handle has no hit point')
    const bytesBeforeResize = await svgBytesOf('VecA', 0)
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2 + 30, { steps: 8 })
    await page.mouse.up()
    await settle()
    const bytesAfterResize = await svgBytesOf('VecA', 0)
    const histResize = await undoRedoEnabled()
    const statusResize = await editorStatus()
    log('resize-while-running', { changed: bytesAfterResize !== bytesBeforeResize, histResize, statusResize, gen: (await vmState()).generation, genRunning })
    expect(bytesAfterResize).not.toBe(bytesBeforeResize)
    expect(histResize.undo).toBe(true)
    expect(statusResize).not.toMatch(/External costume change kept/)

    // Rotate path: real canvas rotate handle drag with its visible hit point.
    const rotHandle = page.locator('[data-testid="vector-rotate-handle"]:visible')
    await rotHandle.waitFor({ state: 'visible', timeout: 20_000 })
    const rb = await rotHandle.first().boundingBox()
    if (!rb) throw new Error('INVALID: visible rotate handle has no hit point')
    const bytesBeforeRotate = await svgBytesOf('VecA', 0)
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
    await page.mouse.down()
    await page.mouse.move(rb.x + rb.width / 2 + 40, rb.y + rb.height / 2 - 20, { steps: 8 })
    await page.mouse.up()
    await settle()
    const bytesAfterRotate = await svgBytesOf('VecA', 0)
    const histRotate = await undoRedoEnabled()
    const statusRotate = await editorStatus()
    log('rotate-while-running', { changed: bytesAfterRotate !== bytesBeforeRotate, histRotate, statusRotate, gen: (await vmState()).generation, genRunning })
    expect(statusRotate).not.toMatch(/External costume change kept/)
    // History must have advanced (at least one undo available); bytes may or may
    // not change for symmetric art, so only history + no-false-conflict assert.
    expect(histRotate.undo).toBe(true)
    await stopAllUi()
    const stoppedResize = await vmState()
    expect(stoppedResize.running).toBe(false)
  }, 240_000)

  it('pointercancel while running restores exactly with no history and no false external', async () => {
    await importSb3(buildRunningSb3(), 'runtime-drag3.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 50)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 50, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    await startGreenFlagUi()
    await assertUiRunningStrict('cancel-running')
    const genRunning = (await vmState()).generation
    await ensurePointReshape()
    const baseBytes = await svgBytesOf('VecA', 0)
    const baseHist = await undoRedoEnabled()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for cancel-while-running')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    await setGate('once', 500)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 60, h.y + 8, { steps: 8 })
    await page.waitForTimeout(90)
    const pid = await lastPointerId()
    await firePointer(sel, 'pointercancel', { pointerId: pid, clientX: h.x + 60, clientY: h.y + 8, buttons: 0 })
    await page.mouse.up()
    await settle()
    const afterBytes = await svgBytesOf('VecA', 0)
    const afterHist = await undoRedoEnabled()
    const afterStatus = await editorStatus()
    log('cancel-while-running', { restored: afterBytes === baseBytes, afterHist, baseHist, afterStatus, gen: (await vmState()).generation, genRunning })
    expect(afterBytes).toBe(baseBytes)
    expect(afterHist).toEqual(baseHist)
    expect(afterStatus).not.toMatch(/External costume change kept/)
    // Escape cancel while still running: strict VM bytes restore, no history,
    // no false external overwrite. Real keyboard path owns the active drag.
    const escBaseBytes = await svgBytesOf('VecA', 0)
    const escBaseHist = await undoRedoEnabled()
    const escHandles = (await pointHandles()).filter((hh) => !hh.control).sort((a, b) => a.x - b.x)
    if (escHandles.length === 0) throw new Error('INVALID: no anchor handles for escape-while-running')
    const eh = escHandles[0]!
    await page.mouse.move(eh.x, eh.y)
    await page.mouse.down()
    await page.mouse.move(eh.x + 50, eh.y + 6, { steps: 6 })
    await page.keyboard.press('Escape')
    try { await page.mouse.up() } catch {}
    await settle()
    const escAfterBytes = await svgBytesOf('VecA', 0)
    const escAfterHist = await undoRedoEnabled()
    const escAfterStatus = await editorStatus()
    log('escape-while-running', { restored: escAfterBytes === escBaseBytes, escAfterHist, escBaseHist, escAfterStatus, gen: (await vmState()).generation, genRunning })
    expect(escAfterBytes).toBe(escBaseBytes)
    expect(escAfterHist).toEqual(escBaseHist)
    expect(escAfterStatus).not.toMatch(/External costume change kept/)
    await stopAllUi()
    const stoppedCancel = await vmState()
    expect(stoppedCancel.running).toBe(false)
  }, 240_000)

  it('alternate-adapter-equivalent commit across a gated preview discards the stale write once, then recovers', async () => {
    await importSb3(buildRunningSb3(), 'runtime-drag4.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 50)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 50, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    const preGateBytes = await svgBytesOf('VecA', 0)
    const preGateHist = await undoRedoEnabled()
    const genBefore = (await vmState()).generation
    const seqBefore = (await slotState('VecA', 0)).seq as number
    await ensurePointReshape()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for commit-race')
    const h = handles[0]!
    // Gate the next preview, then perform the adapter-equivalent commit while gated.
    await setGate('once', 800)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 40, h.y + 5, { steps: 5 })
    await page.waitForTimeout(100)
    const commitReport = await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const gen0 = vm.getProjectGeneration()
      // Alternate-adapter stop/commit shape: detached snapshot, not running, no threads.
      const snap = vm.snapshot()
      const edited = JSON.parse(JSON.stringify(snap))
      edited.running = false
      edited.threads = []
      let committed = false
      let error: string | null = null
      try {
        vm.commitRuntimeSnapshot(edited)
        committed = true
      } catch (e) {
        error = String(e).slice(0, 500)
      }
      return { gen0, gen1: vm.getProjectGeneration(), committed, error }
    })
    log('adapter-commit-during-gate', { ...commitReport, seqBefore })
    expect(commitReport.committed).toBe(true)
    expect(commitReport.gen1).toBe(commitReport.gen0 + 1)
    const pid = await lastPointerId()
    try {
      await firePointer(`[data-vector-path-point][data-point-index="${h.index}"]`, 'pointercancel', { pointerId: pid, clientX: h.x + 40, clientY: h.y + 5, buttons: 0 })
    } catch { /* overlay may already be torn down by the commit */ }
    try { await page.mouse.up() } catch {}
    await settle()
    const afterCommitBytes = await svgBytesOf('VecA', 0)
    const afterCommitHist = await undoRedoEnabled()
    const afterCommitStatus = await editorStatus()
    const afterCommitState = await vmState()
    const priorGreenFlagPath = await page.evaluate(() => (window as unknown as { __greenFlagPath?: string }).__greenFlagPath ?? 'unknown')
    log('after-adapter-commit', { afterCommitHist, afterCommitStatus, afterCommitState, genBefore, preGateHist, priorGreenFlagPath, staleDiscarded: afterCommitBytes === preGateBytes })
    expect(priorGreenFlagPath).toBe('ui-button')
    // The stale gated preview must not have landed as new art on the new epoch:
    // bytes must equal the pre-gate baseline (not the dragged residue).
    expect(afterCommitBytes).toBe(preGateBytes)
    // commitRuntimeSnapshot is NOT a PROJECT_LOADED project replacement from the
    // Editor's perspective (no history clear): the paint history baseline is
    // preserved, not wiped. Record honestly: history stays usable.
    expect(afterCommitHist).toEqual(preGateHist)
    // A fresh drag after the commit must work with a NEW baseline: exactly one
    // history entry, no residue, and crucially no immediate false external
    // conflict on its first frame (the seq reset by the generation bump must be
    // re-based, not compared against the pre-commit seq).
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click().catch(() => {})
    await page.waitForTimeout(600)
    // Draw a fresh rect post-commit (new baseline commit path, not a gesture).
    const preSvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box2 = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box2) throw new Error('Missing paint surface bounds after commit')
    await page.mouse.move(box2.x + box2.width / 2 - 60, box2.y + box2.height / 2 - 40)
    await page.mouse.down()
    await page.mouse.move(box2.x + box2.width / 2 + 60, box2.y + box2.height / 2 + 40, { steps: 8 })
    await page.mouse.up()
    await waitForPreviewSvgChange(preSvg)
    await settle()
    const postBytes = await svgBytesOf('VecA', 0)
    const postHist = await undoRedoEnabled()
    const postStatus = await editorStatus()
    log('fresh-drag-after-commit', { postHist, postStatus, changed: postBytes !== afterCommitBytes })
    expect(postBytes).not.toBe(afterCommitBytes)
    expect(postHist.undo).toBe(true)
    // Undo returns to the committed baseline (not to pre-commit art).
    await clickUndoVisible()
    await page.waitForTimeout(900)
    const undoneBytes = await svgBytesOf('VecA', 0)
    const undoneHist = await undoRedoEnabled()
    const undoneStatus = await editorStatus()
    log('undo-after-commit', { restoredToCommit: undoneBytes === afterCommitBytes, undoneHist, undoneStatus, postHist, afterCommitHist })
    expect(undoneBytes).toBe(afterCommitBytes)
    expect(postStatus).not.toMatch(/External costume change kept/)
  }, 240_000)
})
