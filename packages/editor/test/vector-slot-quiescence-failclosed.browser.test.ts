// Vector slot-quiescence fail-closed regression (new test-only file).
//
// Covers the fixed barrier in `saveVectorCostume` / `saveVectorShapeInRect`:
// the old `waitForVectorSlotQuiescence` polled `200 * 10ms` and returned
// `void` even when still busy (with the cancel barrier `catch {}`-silenced),
// so a move delayed past ~2s let a stamp build on the pre-move base and
// overwrite it. The fix waits the exact per-slot in-flight
// gesture/completion (tokens, not replaceable globals) and returns `false`
// on an explicit 2s timeout or barrier failure; callers abort with an
// actionable status and no bytes/history/selection/success writes.
//
// Method (test-only): real Editor via
// `test/paint-history-isolation-fixture.html` with a deferred gate patched
// onto THAT VM instance's `storeAsset` (the exact slow point named in the
// report: `updateCostumeIfMatch` awaits `storeAsset` before the atomic CAS).
// Gating `storeAsset` — not the Editor save entry — keeps the production
// race window exact: the move's final frame is genuinely in flight while the
// stamp's barrier runs.
//
// Legs (fresh page/context each; server/browser shared):
//   1. `storeAsset` gate 2.5s: concurrent move pointerup + stamp is
//      gate-rejected (`Vector save: costume busy — try again`, no success
//      status); before/after gate bytes + metadata prove the move is kept
//      and the stamp never wrote (rect count 1, meta identical); a different
//      target stays responsive during the gate; after the gate a retry
//      succeeds with an exact Undo/Redo round-trip.
//   2. `storeAsset` gate 5s: move + Escape + stamp is rejected the same way,
//      then a project switch (re-import) aborts silently: status is
//      `Project loaded` (never a stamp success), the fresh project bytes
//      equal the fixture, and no deferred write leaks into the new project.
//   3. External same-slot metadata/name write (`vm.renameCostume`, same
//      bytes, bumped `writeSeq`) landing inside a `once`-gated stamp commit
//      fails closed via CAS conflict: the external name/bytes win, the
//      status names the conflict, history is untouched, the preview shows
//      the external bytes (no stale residue), and the next stamp succeeds
//      with an exact Undo round-trip back to the external bytes.
//
// Timeouts are explicit (`waitForFunction` with a timeout); nothing sleeps
// for completion — the only long waits are the 2.5s/5s gates themselves,
// which ARE the >2s condition under test. Verdicts describe CORRECT
// behaviour and FAIL loudly; impossible setups report INVALID.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4583
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let context: BrowserContext | undefined
let page!: Page

const fnv1a32 = (bytes: Uint8Array) => {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const BLANK_VEC = `${HEAD}</svg>`
const rectSvg = (x: number, y: number, w: number, h: number, fill: string) =>
  `${HEAD}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#111111" stroke-width="2"/></svg>`
const RECT_B = rectSvg(200, 140, 100, 80, '#2980b9')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = fnv1a32(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const blank = add(BLANK_VEC)
  const b = add(RECT_B)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  return Buffer.from(zipSync({
    'project.json': strToU8(JSON.stringify({
      targets: [
        {
          isStage: false, name: 'VecA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
          currentCostume: 0,
          costumes: [costume(blank, 'vec-blank')],
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
      meta: { semver: '3.0.0', vm: 'slot-quiescence-failclosed', agent: 'slot-quiescence-failclosed' },
    })),
    ...files,
  }))
}

function log(label: string, value: unknown) {
  console.log(`[slot-quiescence-failclosed] ${label} ${JSON.stringify(value).slice(0, 2500)}`)
}

async function snapshot(): Promise<any> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest')
    return api.snapshot()
  })
}

async function statusText(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status?.() ?? '')
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

async function costumeMetaOf(targetName: string, index: number): Promise<any> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.name === targetName)
  const c = target?.costumes[index]
  if (!c) return null
  return { name: c.name, dataFormat: c.dataFormat, bitmapResolution: c.bitmapResolution, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, md5ext: c.md5ext, assetId: c.assetId }
}

function rectCount(svg: string): number {
  return svg.split('<rect').length - 1
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewSvgChange(previous: string, timeout = 25_000) {
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, previous, { timeout })
}

async function waitForStatusIncludes(fragment: string, timeout = 20_000) {
  await page.waitForFunction(
    (want: string) => ((window as unknown as any).__hikkakuEditorTest?.status?.() ?? '').includes(want),
    fragment,
    { timeout },
  )
}

async function undoRedoEnabled(): Promise<{ undo: boolean; redo: boolean }> {
  return await page.evaluate(() => {
    const vis = (el: Element | null) => {
      if (!(el instanceof HTMLElement)) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    let undo = false
    let redo = false
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

// Deferred gate on the exact slow point: `storeAsset` inside the VM commit.
// `all` delays every store; `once` delays only the next one. Sync renames
// bypass it, which is what makes the external-race window deterministic.
async function installStoreAssetGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for storeAsset gate')
    if (w.__storeAssetGate) return
    const orig = vm.storeAsset.bind(vm)
    const gate = (w.__storeAssetGate = { mode: 'off', ms: 0, calls: 0 })
    vm.storeAsset = async (...args: any[]) => {
      gate.calls += 1
      if (gate.mode === 'all') {
        await new Promise((r) => setTimeout(r, gate.ms))
      } else if (gate.mode === 'once') {
        gate.mode = 'off'
        await new Promise((r) => setTimeout(r, gate.ms))
      }
      return orig(...args)
    }
  })
}

async function setStoreAssetGate(mode: 'off' | 'all' | 'once', ms = 0) {
  await page.evaluate(({ m, delay }: { m: string; delay: number }) => {
    const w = window as unknown as Record<string, any>
    if (!w.__storeAssetGate) throw new Error('storeAsset gate not installed')
    w.__storeAssetGate.mode = m
    w.__storeAssetGate.ms = delay
  }, { m: mode, delay: ms })
}

async function vmTargetId(name: string): Promise<string> {
  return await page.evaluate((n: string) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const t = vm.getTarget(n)
    return String(t?.id ?? n)
  }, name)
}

async function gateDebug(): Promise<any> {
  return await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (!w.__vectorGateDebug) throw new Error('Missing __vectorGateDebug')
    return {
      slotBusyVecA0: w.__vectorGateDebug.slotBusy(String(w.__paintHistoryVm.getTarget('VecA')?.id ?? 'VecA'), 0),
      slotPendingVecA0: w.__vectorGateDebug.slotPending(String(w.__paintHistoryVm.getTarget('VecA')?.id ?? 'VecA'), 0),
      lastQuiescence: w.__vectorGateDebug.lastQuiescence(),
    }
  })
}

async function lastQuiescenceFor(targetId: string, index: number): Promise<any> {
  const debug = await gateDebug()
  const entries = (debug.lastQuiescence as any[]).filter((e) => e.targetId === targetId && e.index === index)
  return entries.at(-1) ?? null
}

async function waitForQuiescenceEntry(targetId: string, index: number, previousCount: number, timeout = 20_000): Promise<any> {
  await page.waitForFunction(
    ({ tid, idx, prev }: { tid: string; idx: number; prev: number }) => {
      const w = window as unknown as Record<string, any>
      return (w.__vectorGateDebug?.lastQuiescence?.() ?? []).filter((e: any) => e.targetId === tid && e.index === idx).length > prev
    },
    { tid: targetId, idx: index, prev: previousCount },
    { timeout },
  )
  return await lastQuiescenceFor(targetId, index)
}

async function quiescenceCountFor(targetId: string, index: number): Promise<number> {
  const debug = await gateDebug()
  return (debug.lastQuiescence as any[]).filter((e) => e.targetId === targetId && e.index === index).length
}

async function settle(timeout = 30_000) {
  await setStoreAssetGate('off')
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, any>
    const calls = w.__storeAssetGate?.calls ?? 0
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
    (want: string) => {
      const api = (window as any).__hikkakuEditorTest
      if (!api) return false
      if (api.status?.() !== 'Project loaded') return false
      return api.snapshot()?.project.targets.some((t: any) => t.name === want) ?? false
    },
    expectTarget,
    { timeout: 40_000 },
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
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
}

async function outlineCenter(): Promise<{ x: number; y: number }> {
  const target = page.locator('[data-vector-selection-outline]').last()
  await target.waitFor({ state: 'visible', timeout: 20_000 })
  const box = await target.boundingBox()
  if (!box) throw new Error('INVALID: missing vector object outline bounds')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function drawRectDrag(cx: number, cy: number, dx: number, dy: number) {
  await page.getByTestId('vector-shape-rect').last().click()
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  await page.mouse.move(box.x + box.width / 2 + cx - dx, box.y + box.height / 2 + cy - dy)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + cx + dx, box.y + box.height / 2 + cy + dy, { steps: 8 })
  await page.mouse.up()
}

// Corner stamp: presses guaranteed-blank canvas (top-left inset), so the
// press can neither hit artwork (surface early-return) nor the live
// selection (shape-move). Center-based presses are geometry-fragile: after
// a move they may land on the moved rect and silently do the wrong thing.
async function drawRectCornerDrag() {
  await page.getByTestId('vector-shape-rect').last().click()
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  const sx = box.x + 50
  const sy = box.y + 45
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 90, sy + 70, { steps: 8 })
  await page.mouse.up()
}

describe('vector slot-quiescence fail-closed (storeAsset gate)', () => {
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
  }, 120_000)

  beforeEach(async () => {
    if (!browser) throw new Error('Browser not started')
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await context.newPage()
    page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 300)))
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installStoreAssetGate()
  })

  afterEach(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.evaluate(() => {
          const w = window as unknown as Record<string, any>
          if (w.__storeAssetGate) w.__storeAssetGate.mode = 'off'
        })
      }
    } catch {}
    try {
      await page?.close()
    } catch {}
    try {
      await context?.close()
    } catch {}
    context = undefined
  })

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('2.5s gate: concurrent move pointerup + stamp is rejected, VecB stays responsive, retry Undo/Redo exact', async () => {
    await importSb3(buildSb3(), 'quiescence-25.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    // Baseline: one rect on VecA slot 0 (gate off).
    const emptySvg = await previewSvg()
    await drawRectDrag(0, 0, 110, 60)
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    const beforeSvg = await previewSvg()
    const beforeBytes = await svgBytesOf('VecA', 0)
    const beforeMeta = await costumeMetaOf('VecA', 0)
    const pairBefore = await undoRedoEnabled()
    expect(rectCount(beforeBytes)).toBe(1)
    expect(pairBefore.undo).toBe(true)

    // Slow every store past the 2s barrier: the move's final frame is
    // genuinely in flight while the stamp's barrier runs.
    await setStoreAssetGate('all', 2500)
    await page.getByTestId('vector-shape-select').last().click()
    const from = await outlineCenter()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 60, from.y + 10, { steps: 10 })
    await page.mouse.up()
    // Concurrent stamp on the same slot before the move lands. Escape first:
    // with the select tool this clears the object selection while the
    // pointerup-claimed move commit (`committing`) is explicitly preserved,
    // so the stamp press below cannot hit the moved rect (which would start
    // a shape-move instead of drawing) and deterministically draws fresh.
    const vecAId25 = await vmTargetId('VecA')
    const prevQ25 = await quiescenceCountFor(vecAId25, 0)
    await page.evaluate(() => {
      const w = window as unknown as Record<string, any>
      w.__stampProbe = { downs: [] as any[], ups: [] as any[] }
      w.__stampProbeDown = (e: Event) => {
        const pe = e as PointerEvent
        const t = pe.target as HTMLElement | null
        const el = t?.closest?.('[data-testid]') as HTMLElement | null
        w.__stampProbe.downs.push({
          at: Date.now(),
          x: pe.clientX,
          y: pe.clientY,
          tag: t?.tagName ?? '?',
          cls: typeof t?.className === 'string' ? t.className.slice(0, 120) : String(t?.className ?? ''),
          testid: (t as any)?.dataset?.testid ?? el?.getAttribute?.('data-testid') ?? null,
          vectorObj: Boolean((t as any)?.closest?.('[data-vector-object]')),
        })
      }
      w.__stampProbeUp = (e: Event) => {
        const pe = e as PointerEvent
        const t = pe.target as HTMLElement | null
        w.__stampProbe.ups.push({ at: Date.now(), x: pe.clientX, y: pe.clientY, tag: t?.tagName ?? '?' })
      }
      document.addEventListener('pointerdown', w.__stampProbeDown, true)
      document.addEventListener('pointerup', w.__stampProbeUp, true)
    })
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Escape')
    log('2.5s after escape', { status: await statusText(), gate: await gateDebug() })
    // Blank-canvas stamp inside the edit surface but far from the moved
    // outline/handles: top-left area (-120,-100) stays outside the moved
    // rect (moved +60,+10 from center) yet well inside the surface, so the
    // press draws fresh (draft path) and the save + 2s barrier are genuinely
    // exercised while the gate is pending. (A raw surface-inset corner lands
    // on the container padding outside the edit surface and is ignored.)
    await drawRectDrag(-120, -100, 25, 18)
    // Fail-closed verdict via the persistent quiescence log (not the
    // transient status: the move's `Project changed` / `Vector object moved`
    // land at ~2.5s and overwrite the 2s busy status before a late wait).
    let entry25: any = null
    let busySeen25 = false
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(500)
      const diag = await page.evaluate(() => {
        const w = window as unknown as Record<string, any>
        const q = (w.__vectorGateDebug?.lastQuiescence?.() ?? []) as any[]
        return {
          status: w.__hikkakuEditorTest?.status?.() ?? null,
          gateCalls: w.__storeAssetGate?.calls ?? null,
          outlines: document.querySelectorAll('[data-vector-selection-outline]').length,
          slotBusy: (() => { try { return w.__vectorGateDebug.slotBusy(String(w.__paintHistoryVm.getTarget('VecA')?.id ?? 'VecA'), 0) } catch { return null } })(),
          slotPending: (() => { try { return w.__vectorGateDebug.slotPending(String(w.__paintHistoryVm.getTarget('VecA')?.id ?? 'VecA'), 0) } catch { return null } })(),
          qLen: q.length,
          qTail: q.slice(-2),
          probe: w.__stampProbe ?? null,
        }
      })
      if (typeof diag.status === 'string' && diag.status.includes('Vector save: costume busy')) busySeen25 = true
      log('2.5s diag sample', { i, ...diag })
      const count = await quiescenceCountFor(vecAId25, 0)
      if (count > prevQ25) {
        entry25 = await lastQuiescenceFor(vecAId25, 0)
        break
      }
    }
    await page.evaluate(() => {
      const w = window as unknown as Record<string, any>
      try {
        if (w.__stampProbeDown) document.removeEventListener('pointerdown', w.__stampProbeDown, true)
        if (w.__stampProbeUp) document.removeEventListener('pointerup', w.__stampProbeUp, true)
      } catch {}
    })
    log('2.5s rects', { rects: rectCount(await svgBytesOf('VecA', 0)) })
    if (!entry25) entry25 = await waitForQuiescenceEntry(vecAId25, 0, prevQ25, 20_000)
    log('2.5s rejection', { entry: entry25, busySeen: busySeen25, statusNow: await statusText() })
    // Real busy decision: the barrier timed out fail-closed (blocks >2s).
    expect(entry25).not.toBeNull()
    expect(entry25.ok).toBe(false)
    expect(entry25.reason).toBe('timeout')
    // The transient busy status may already be overwritten by the move's
    // landing (`Project changed` -> `Vector object moved`); never assert it
    // as the verdict — only that no success status was produced by the stamp.
    expect(await statusText()).not.toBe('Vector shape saved')
    expect(await statusText()).not.toBe('Vector costume saved')

    // The move lands last and overwrites the transient busy status (the
    // persistent quiescence log above is the verdict). The gate stays on:
    // everything below still runs under the 2.5s store pressure.
    await waitForStatusIncludes('Vector object moved', 20_000)
    // After the gate: the move is kept, the stamp never wrote.
    const afterBytes = await svgBytesOf('VecA', 0)
    const afterMeta = await costumeMetaOf('VecA', 0)
    const afterSvg = await previewSvg()
    log('2.5s after gate', { rects: rectCount(afterBytes), moved: afterBytes !== beforeBytes })
    expect(afterBytes).not.toBe(beforeBytes)
    expect(rectCount(afterBytes)).toBe(1)
    // Stable identity fields prove the stamp never wrote/converted/renamed:
    // asset identity (assetId/md5ext) and the recomputed rotationCenter
    // legitimately change with the move's new bytes, so they cannot be
    // identical — the move-kept assertion above already covers them.
    expect(afterMeta.name).toBe(beforeMeta.name)
    expect(afterMeta.dataFormat).toBe(beforeMeta.dataFormat)
    expect(afterMeta.bitmapResolution).toBe(beforeMeta.bitmapResolution)
    expect(afterSvg).not.toBe(beforeSvg)
    // Undo removes only the move (the stamp never existed). Verified BEFORE
    // the VecB target switch: switching targets clears paint history by
    // scope (product semantic), so the move entry must be checked on VecA.
    await clickUndoVisible()
    await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.innerHTML === want, beforeSvg, { timeout: 30_000 })
    expect(await svgBytesOf('VecA', 0)).toBe(beforeBytes)
    await clickRedoVisible()
    await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.innerHTML === want, afterSvg, { timeout: 30_000 })
    expect(await svgBytesOf('VecA', 0)).toBe(afterBytes)

    // Different target stays responsive while the gate is on.
    await page.getByTestId('target-card-VecB').click()
    await page.waitForTimeout(600)
    await page.getByTestId('main-tab-costumes').click()
    await ensureVectorMode()
    const vecBBefore = await previewSvg()
    await drawRectDrag(0, 0, 50, 30)
    await waitForPreviewSvgChange(vecBBefore, 25_000)
    log('VecB responsive during gate', { changed: true })
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await page.getByTestId('main-tab-costumes').click()
    await ensureVectorMode()

    await settle()

    // Retry after the gate: clear the selection first so the press draws
    // fresh instead of shape-moving the moved rect.
    const retryBefore = await previewSvg()
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Escape')
    await drawRectDrag(0, 40, 40, 30)
    await waitForPreviewSvgChange(retryBefore)
    await waitForStatusIncludes('Vector shape saved', 20_000)
    await settle()
    const retriedBytes = await svgBytesOf('VecA', 0)
    expect(rectCount(retriedBytes)).toBe(2)
    const retriedSvg = await previewSvg()
    await clickUndoVisible()
    await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.innerHTML === want, afterSvg, { timeout: 20_000 })
    expect(await svgBytesOf('VecA', 0)).toBe(afterBytes)
    await clickRedoVisible()
    await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.innerHTML === want, retriedSvg, { timeout: 20_000 })
    expect(await svgBytesOf('VecA', 0)).toBe(retriedBytes)
  }, 240_000)

  it('5s gate: move + Escape + stamp rejected, project switch silent and lossless', async () => {
    await importSb3(buildSb3(), 'quiescence-50.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const emptySvg = await previewSvg()
    await drawRectDrag(0, 0, 110, 60)
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    const beforeBytes = await svgBytesOf('VecA', 0)
    expect(rectCount(beforeBytes)).toBe(1)

    await setStoreAssetGate('all', 5000)
    await page.getByTestId('vector-shape-select').last().click()
    const from = await outlineCenter()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 50, from.y + 8, { steps: 8 })
    // Escape mid-move (applied moves are kept) then release.
    await page.keyboard.press('Escape')
    await page.mouse.up()
    // Concurrent stamp on the same slot.
    await drawRectDrag(0, -40, 40, 30)
    await waitForStatusIncludes('Vector save: costume busy', 20_000)
    expect(await statusText()).toContain('Vector save: costume busy')

    // Project switch during the deferred window: silent abort, no leak.
    await importSb3(buildSb3(), 'quiescence-50-reimport.sb3', 'VecA')
    expect(await statusText()).toBe('Project loaded')
    const freshBytes = await svgBytesOf('VecA', 0)
    log('5s reimport', { freshIsBlank: freshBytes === BLANK_VEC, freshRects: rectCount(freshBytes) })
    expect(freshBytes).toBe(BLANK_VEC)
    expect(rectCount(await svgBytesOf('VecB', 0))).toBe(1)
    const pair = await undoRedoEnabled()
    expect(pair.undo).toBe(false)
    expect(pair.redo).toBe(false)
  }, 240_000)

  it('external same-slot rename during a once-gated stamp conflicts fail-closed, retry adopts', async () => {
    await importSb3(buildSb3(), 'quiescence-cas.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const emptySvg = await previewSvg()
    await drawRectDrag(0, 0, 110, 60)
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    const beforeBytes = await svgBytesOf('VecA', 0)
    const beforeMeta = await costumeMetaOf('VecA', 0)
    const pairBefore = await undoRedoEnabled()
    expect(rectCount(beforeBytes)).toBe(1)

    // Delay the stamp's own commit; the sync external rename below lands
    // strictly inside that window (deterministic, no sleep). `all` (not
    // `once`) so no earlier unrelated store can consume the delay. Clear the
    // selection first so the press draws fresh instead of shape-moving.
    await setStoreAssetGate('all', 800)
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Escape')
    const stampBefore = await previewSvg()
    await drawRectDrag(0, -40, 40, 30)
    await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      if (!vm.renameCostume('VecA', 0, 'vec-renamed-external')) throw new Error('INVALID: external rename failed')
    })
    // Fail-closed conflict: the external name/bytes win and are surfaced.
    await page.waitForFunction(
      () => /external|conflict|kept/i.test((window as unknown as any).__hikkakuEditorTest?.status?.() ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    const conflictStatus = await statusText()
    log('external rename conflict', { conflictStatus })
    expect(conflictStatus).toMatch(/external|conflict|kept/i)
    await settle()
    // Same bytes (rename is metadata-only) but the external identity wins:
    // name adopted, no second rect, history untouched, preview exact.
    const keptBytes = await svgBytesOf('VecA', 0)
    const keptMeta = await costumeMetaOf('VecA', 0)
    expect(keptBytes).toBe(beforeBytes)
    expect(keptMeta.name).toBe('vec-renamed-external')
    expect(keptMeta.dataFormat).toBe(beforeMeta.dataFormat)
    expect(rectCount(keptBytes)).toBe(1)
    expect(await undoRedoEnabled()).toEqual(pairBefore)
    // No stale preview residue: the rejected stamp painted nothing.
    expect(await previewSvg()).toBe(stampBefore)

    // Recovery: the next stamp adopts the external baseline and lands with
    // exactly one Undo step back to the external bytes.
    await ensureVectorMode()
    const retryBefore = await previewSvg()
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Escape')
    await drawRectDrag(0, 40, 40, 30)
    await waitForPreviewSvgChange(retryBefore)
    await waitForStatusIncludes('Vector shape saved', 20_000)
    await settle()
    const retriedBytes = await svgBytesOf('VecA', 0)
    expect(rectCount(retriedBytes)).toBe(2)
    expect((await costumeMetaOf('VecA', 0)).name).toBe('vec-renamed-external')
    const retriedSvg = await previewSvg()
    await clickUndoVisible()
    await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.innerHTML === want, retryBefore, { timeout: 20_000 })
    expect(await svgBytesOf('VecA', 0)).toBe(keptBytes)
    await clickRedoVisible()
    await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.innerHTML === want, retriedSvg, { timeout: 20_000 })
    expect(await svgBytesOf('VecA', 0)).toBe(retriedBytes)
  }, 240_000)
})
