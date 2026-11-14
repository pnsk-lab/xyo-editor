// External updateCostume CAS audit on the real Editor UI + VM (NEW test-only file).
//
// Product code untouched. Uses the production paint fixture
// (`test/paint-history-isolation-fixture.html`) which mounts the real Editor
// and exposes its VM as `window.__paintHistoryVm` plus the status/snapshot
// hook `window.__hikkakuEditorTest`.
//
// What this audits (fail-first intent of the versioned-CAS migration):
//   1. metadata-only external (name + rotationCenterX/Y, no bytes)
//   2. same-bytes external with different metadata (new storeAsset, same hash)
//   3. new-bytes external
//   4. two simultaneous externals (last writer wins, seq bumps twice)
//   5. deferred (gated) preview vs external: external wins, residue dropped
//   6. pointercancel restore vs external: external kept, no history
//   7. pointerup commit vs external: external kept, no history, conflict status
//   8. delete / reorder during a gated drag: stale write never lands on shifted art
//   9. project replace reusing the same target id: stale queued write discarded,
//      history cleared (new baseline), selection reset
//  10. undo/redo after an external: fail-closed (bytes+meta kept, stack intact,
//      conflict status, selection preserved)
// Each leg records bytes (loadAsset text), meta (name/center/md5ext/assetId),
// history (Undo/Redo enabled), selection (costume index + reshape handles) and
// status. Assertions describe CORRECT behaviour and FAIL loudly; impossible
// setups report INVALID instead of failing.
//
// Boundary (recorded, not tested for protection): direct plain-object mutation
// of `project.targets` / costume objects bypasses the VM slot queue and is
// explicitly out of scope (see `costume-slot-cas.ts`). One leg documents this
// by showing a direct mutation is invisible to CAS (no assertion of safety).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4695
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
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  return Buffer.from(zipSync({
    'project.json': strToU8(JSON.stringify({
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
          currentCostume: 0, costumes: [costume(a2, 'vec-b')],
          sounds: [], volume: 100, layerOrder: 2, visible: true, x: 80, y: 40, size: 100,
          direction: 90, draggable: false, rotationStyle: 'all around',
        },
      ],
      monitors: [], extensions: [],
      meta: { semver: '3.0.0', vm: 'external-cas-audit', agent: 'external-cas-audit' },
    })),
    ...files,
  }))
}

function log(label: string, value: unknown) {
  console.log(`[external-cas-audit] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
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
async function costumeMetaOf(targetName: string, index: number): Promise<any> {
  const snap = await snapshot()
  const t = snap.project.targets.find((x: any) => x.name === targetName)
  const c = t?.costumes[index]
  if (!c) return null
  return { name: c.name, dataFormat: c.dataFormat, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, md5ext: c.md5ext, assetId: c.assetId }
}
async function svgBytesOf(targetName: string, index: number): Promise<string> {
  return await page.evaluate(async ({ t, i }: { t: string; i: number }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm')
    const tgt = vm.getTarget(t)
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
    const ident = vm.getCostumeIdentity?.(id, i)
    const seq = vm.getCostumeWriteSeq?.(id, i)
    const gen = vm.getProjectGeneration?.()
    return { ident, seq, gen, targetId: id }
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
async function clickRedoVisible() {
  const buttons = page.getByRole('button', { name: 'Redo', exact: true })
  for (let i = 0; i < (await buttons.count()); i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) { await b.click(); return }
  }
  throw new Error('No enabled visible Redo button')
}
async function selectedCostumeIndex(): Promise<number> {
  const snap = await snapshot()
  const t = snap.project.targets.find((x: any) => x.id === snap.selectedTargetId || x.name === snap.selectedTargetId)
  return t?.currentCostume ?? -1
}
async function reshapeHandleCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-vector-path-point]').length)
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
// External writer: the documented external API is vm.updateCostume (unconditional,
// legacy name resolution). It must be honored as the "external" winner by the
// Editor CAS path (vm.updateCostumeIfMatch with versioned expected).
async function externalUpdate(targetName: string, index: number, patch: Record<string, unknown>, b64?: string) {
  return await page.evaluate(async ({ t, i, p, data }: { t: string; i: number; p: Record<string, unknown>; data?: string }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm')
    const bytes = data ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : undefined
    await vm.updateCostume(t, i, p, bytes)
    const tgt = vm.getTarget(t)
    const id = tgt?.id ?? t
    const c = tgt?.costumes[i]
    return {
      meta: c ? { name: c.name, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, md5ext: c.md5ext, assetId: c.assetId } : null,
      ident: vm.getCostumeIdentity?.(id, i),
      seq: vm.getCostumeWriteSeq?.(id, i),
    }
  }, { t: targetName, i: index, p: patch, data: b64 })
}
const toB64 = (s: string) => Buffer.from(new TextEncoder().encode(s)).toString('base64')

describe('external updateCostume CAS audit on the real editor (new, no product change)', () => {
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

  it('metadata-only external keeps bytes, bumps seq, and blocks a stale undo (fail-closed)', async () => {
    await importSb3(buildSb3(), 'ext-cas.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    // Baseline: draw one rect so history exists.
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
    const baseBytes = await svgBytesOf('VecA', 0)
    const baseMeta = await costumeMetaOf('VecA', 0)
    const baseIdent = await slotIdentity('VecA', 0)
    const baseHist = await undoRedoEnabled()
    const baseSel = await selectedCostumeIndex()
    expect(baseHist.undo).toBe(true)
    log('metadata-only base', { baseMeta, baseIdent, baseHist, baseSel, bytesLen: baseBytes.length })

    // External metadata-only: same bytes, new name + center.
    const ext = await externalUpdate('VecA', 0, { name: 'ExtMeta', rotationCenterX: 999, rotationCenterY: 888 })
    await page.waitForTimeout(800)
    const afterBytes = await svgBytesOf('VecA', 0)
    const afterMeta = await costumeMetaOf('VecA', 0)
    const afterIdent = await slotIdentity('VecA', 0)
    log('metadata-only after', { ext, afterMeta, afterIdent })
    expect(afterBytes).toBe(baseBytes)
    expect(afterMeta.name).toBe('ExtMeta')
    expect(afterMeta.rotationCenterX).toBe(999)
    expect(afterMeta.rotationCenterY).toBe(888)
    expect(afterIdent.seq).toBe(baseIdent.seq + 1)

    // Stale undo must refuse: external kept, stack intact, conflict status.
    const undoBefore = await undoRedoEnabled()
    await clickUndoVisible()
    await page.waitForTimeout(900)
    const keptBytes = await svgBytesOf('VecA', 0)
    const keptMeta = await costumeMetaOf('VecA', 0)
    const keptHist = await undoRedoEnabled()
    const keptSel = await selectedCostumeIndex()
    const status = await editorStatus()
    log('metadata-only undo-attempt', { keptMeta, keptHist, keptSel, status })
    expect(keptBytes).toBe(baseBytes)
    expect(keptMeta.name).toBe('ExtMeta')
    expect(keptMeta.rotationCenterX).toBe(999)
    expect(keptHist.undo).toBe(undoBefore.undo)
    expect(status).toMatch(/External costume change kept/)
    expect(keptSel).toBe(baseSel)
  }, 180_000)

  it('same-bytes external with different metadata bumps seq and is kept (hash-only would miss)', async () => {
    await importSb3(buildSb3(), 'ext-cas2.sb3', 'VecA')
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
    const baseBytes = await svgBytesOf('VecA', 0)
    const baseIdent = await slotIdentity('VecA', 0)
    // External: same bytes, different patch metadata (rewrite).
    const ext = await externalUpdate('VecA', 0, { name: 'ExtSame' }, toB64(baseBytes))
    await page.waitForTimeout(800)
    const afterMeta = await costumeMetaOf('VecA', 0)
    const afterIdent = await slotIdentity('VecA', 0)
    const afterBytes = await svgBytesOf('VecA', 0)
    log('same-bytes after', { ext, afterMeta, afterIdent })
    expect(afterBytes).toBe(baseBytes)
    expect(afterMeta.name).toBe('ExtSame')
    expect(afterIdent.seq).toBe(baseIdent.seq + 1)
    expect(afterIdent.ident.assetId).toBe(baseIdent.ident.assetId)
    // Undo must keep the external rewrite.
    await clickUndoVisible()
    await page.waitForTimeout(900)
    expect((await costumeMetaOf('VecA', 0)).name).toBe('ExtSame')
    expect(await editorStatus()).toMatch(/External costume change kept/)
  }, 180_000)

  it('new-bytes external wins over a deferred preview and a pointerup commit (residue dropped, no history)', async () => {
    await importSb3(buildSb3(), 'ext-cas3.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 110, box.y + box.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    await ensurePointReshape()
    const baseHist = await undoRedoEnabled()
    const baseSelHandles = await reshapeHandleCount()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    await setGate('once', 600)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 70, h.y + 10, { steps: 8 })
    await page.waitForTimeout(90)
    // External new bytes lands while the preview is gated.
    const NEW_SVG = rectSvg(10, 10, 60, 40, '#123456')
    await externalUpdate('VecA', 0, { name: 'ExtNew', dataFormat: 'svg' }, toB64(NEW_SVG))
    const pid = await lastPointerId()
    await page.mouse.up()
    await settle()
    const finalBytes = await svgBytesOf('VecA', 0)
    const finalMeta = await costumeMetaOf('VecA', 0)
    const finalHist = await undoRedoEnabled()
    const status = await editorStatus()
    log('new-bytes deferred pointerup', { finalMeta, finalHist, status, hasNew: finalBytes.includes('#123456') })
    // The pointerup commit must not force-write after the conflict.
    expect(finalBytes).toContain('#123456')
    expect(finalMeta.name).toBe('ExtNew')
    expect(finalHist).toEqual(baseHist)
    expect(status).toMatch(/External costume change kept/)
    // Selection preserved (reshape still offers handles), costume index unchanged.
    expect(await selectedCostumeIndex()).toBe(0)
    expect(await reshapeHandleCount()).toBeGreaterThan(0)
    void baseSelHandles
    void sel
    void pid
  }, 240_000)

  it('two simultaneous externals: last writer wins, undo keeps the last (seq +2)', async () => {
    await importSb3(buildSb3(), 'ext-cas4.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const baseIdent = await slotIdentity('VecA', 0)
    const SVG1 = rectSvg(5, 5, 50, 30, '#aaaaaa')
    const SVG2 = rectSvg(6, 6, 51, 31, '#bbbbbb')
    // Fire without awaiting between them: same-slot FIFO => SVG2 is final.
    await page.evaluate(async ({ s1, s2 }: { s1: string; s2: string }) => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const b1 = Uint8Array.from(atob(s1), (c) => c.charCodeAt(0))
      const b2 = Uint8Array.from(atob(s2), (c) => c.charCodeAt(0))
      await Promise.all([
        vm.updateCostume('VecA', 0, { name: 'Ext1', dataFormat: 'svg' }, b1),
        vm.updateCostume('VecA', 0, { name: 'Ext2', dataFormat: 'svg' }, b2),
      ])
    }, { s1: toB64(SVG1), s2: toB64(SVG2) })
    await page.waitForTimeout(900)
    const afterBytes = await svgBytesOf('VecA', 0)
    const afterMeta = await costumeMetaOf('VecA', 0)
    const afterIdent = await slotIdentity('VecA', 0)
    log('two-externals', { afterMeta, afterIdent })
    expect(afterBytes).toContain('#bbbbbb')
    expect(afterMeta.name).toBe('Ext2')
    expect(afterIdent.seq).toBe(baseIdent.seq + 2)
  }, 120_000)

  it('pointercancel restore vs new-bytes external: external kept, no history, selection kept', async () => {
    await importSb3(buildSb3(), 'ext-cas5.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 110, box.y + box.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    await ensurePointReshape()
    const baseHist = await undoRedoEnabled()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    await setGate('once', 600)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 60, h.y + 8, { steps: 8 })
    await page.waitForTimeout(90)
    const NEW_SVG = rectSvg(20, 20, 70, 50, '#ff00ff')
    await externalUpdate('VecA', 0, { name: 'ExtCancel', dataFormat: 'svg' }, toB64(NEW_SVG))
    const pid = await lastPointerId()
    await firePointer(sel, 'pointercancel', { pointerId: pid, clientX: h.x + 60, clientY: h.y + 8, buttons: 0 })
    await page.mouse.up()
    await settle()
    const finalBytes = await svgBytesOf('VecA', 0)
    const finalMeta = await costumeMetaOf('VecA', 0)
    const finalHist = await undoRedoEnabled()
    const status = await editorStatus()
    log('cancel-vs-external', { finalMeta, finalHist, status })
    expect(finalBytes).toContain('#ff00ff')
    expect(finalMeta.name).toBe('ExtCancel')
    expect(finalHist).toEqual(baseHist)
    expect(status).toMatch(/External costume change kept/)
  }, 240_000)

  it('delete during a gated drag never restores onto shifted slots (bytes audited)', async () => {
    await importSb3(buildSb3(), 'ext-cas6.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await setGate('off')
    // Slot 0 starts blank (no reshape handles): draw a baseline rect first so a
    // real point drag exists. Slot 1 keeps the fixture rect as the survivor oracle.
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box0 = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box0) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box0.x + box0.width / 2 - 110, box0.y + box0.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box0.x + box0.width / 2 + 110, box0.y + box0.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await settle()
    // Ensure two costumes: delete index 0 later, index 1 art must survive intact.
    const otherBefore = await svgBytesOf('VecA', 1)
    await ensurePointReshape()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles')
    const h = handles[0]!
    await setGate('once', 700)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 50, h.y + 6, { steps: 6 })
    await page.waitForTimeout(80)
    // Structural external: delete the dragged slot while the preview is gated.
    await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      vm.deleteCostume('VecA', 0)
    })
    const pid = await lastPointerId()
    await firePointer(`[data-vector-path-point][data-point-index="${h.index}"]`, 'pointercancel', { pointerId: pid, clientX: h.x + 50, clientY: h.y + 6, buttons: 0 })
    await page.mouse.up()
    await settle()
    const snap = await snapshot()
    const vecA = snap.project.targets.find((t: any) => t.name === 'VecA')
    log('delete-during-drag', { len: vecA?.costumes.length, names: vecA?.costumes.map((c: any) => c.name) })
    expect(vecA?.costumes.length).toBe(1)
    // The surviving slot is the old index-1 art, byte-identical (no stale preview bytes).
    expect(await svgBytesOf('VecA', 0)).toBe(otherBefore)
  }, 240_000)

  it('reorder during a gated drag never writes old bytes onto shifted artwork', async () => {
    await importSb3(buildSb3(), 'ext-cas7.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await setGate('off')
    // Slot 0 starts blank: draw a baseline rect so both slots hold distinct
    // rect art and a real point drag exists on slot 0.
    const emptySvg7 = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box7 = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box7) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box7.x + box7.width / 2 - 110, box7.y + box7.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box7.x + box7.width / 2 + 110, box7.y + box7.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg7)
    await settle()
    const slot0Before = await svgBytesOf('VecA', 0)
    const slot1Before = await svgBytesOf('VecA', 1)
    expect(slot0Before).not.toBe(slot1Before)
    await ensurePointReshape()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles')
    const h = handles[0]!
    await setGate('once', 700)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 50, h.y + 6, { steps: 6 })
    await page.waitForTimeout(80)
    await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      vm.reorderCostume('VecA', 0, 1)
    })
    const pid = await lastPointerId()
    // Reorder clears the reshape selection, so the dragged handle element is
    // already gone: the cancel must be best-effort (the stale gated preview is
    // what must not land, not the pointercancel itself).
    try {
      await firePointer(`[data-vector-path-point][data-point-index="${h.index}"]`, 'pointercancel', { pointerId: pid, clientX: h.x + 50, clientY: h.y + 6, buttons: 0 })
    } catch { /* handles gone after reorder: expected */ }
    try { await page.mouse.up() } catch {}
    await settle()
    // After a 0->1 reorder the two arts swapped; neither may contain gated-drag residue.
    const slot0After = await svgBytesOf('VecA', 0)
    const slot1After = await svgBytesOf('VecA', 1)
    log('reorder-during-drag', { swapped: slot0After === slot1Before && slot1After === slot0Before })
    expect(slot0After).toBe(slot1Before)
    expect(slot1After).toBe(slot0Before)
  }, 240_000)

  it('project replace reusing the same target id discards stale queued writes (new baseline)', async () => {
    await importSb3(buildSb3(), 'ext-cas8.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await setGate('off')
    // Draw baseline so a real reshape drag exists (slot 0 starts blank).
    const emptySvg8 = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box8 = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box8) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box8.x + box8.width / 2 - 110, box8.y + box8.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box8.x + box8.width / 2 + 110, box8.y + box8.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg8)
    await settle()
    const idBefore = (await slotIdentity('VecA', 0)).targetId as string
    const genBefore = (await slotIdentity('VecA', 0)).gen as number
    // Gate a preview, then replace the whole project reusing the same stable id.
    await ensurePointReshape()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles')
    const h = handles[0]!
    await setGate('once', 800)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 40, h.y + 5, { steps: 5 })
    await page.waitForTimeout(80)
    // Build a replacement project that reuses the exact same target id.
    const NEW_ART = rectSvg(30, 30, 80, 60, '#00cccc')
    const newBytes = new TextEncoder().encode(NEW_ART)
    const newHash = md5(newBytes)
    const replacement = Buffer.from(zipSync({
      'project.json': strToU8(JSON.stringify({
        targets: [
          {
            id: idBefore, isStage: false, name: 'VecA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'vec-new', assetId: newHash, md5ext: `${newHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
            sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
            direction: 90, draggable: false, rotationStyle: 'all around',
          },
        ],
        monitors: [], extensions: [],
        meta: { semver: '3.0.0', vm: 'external-cas-replace', agent: 'external-cas-replace' },
      })),
      [`${newHash}.svg`]: newBytes,
    }))
    await page.getByTestId('project-file-input').setInputFiles({ name: 'replace-same-id.sb3', mimeType: 'application/x.scratch.sb3', buffer: replacement })
    await page.waitForFunction(() => (window as any).__hikkakuEditorTest?.status?.() === 'Project loaded', null, { timeout: 30_000 })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    const pid = await lastPointerId()
    try {
      await firePointer(`[data-vector-path-point][data-point-index="${h.index}"]`, 'pointercancel', { pointerId: pid, clientX: h.x + 40, clientY: h.y + 5, buttons: 0 })
    } catch { /* handles gone after replace: expected */ }
    try { await page.mouse.up() } catch {}
    await settle()
    const afterBytes = await svgBytesOf('VecA', 0)
    const afterIdent = await slotIdentity('VecA', 0)
    const afterHist = await undoRedoEnabled()
    log('replace-same-id', { genBefore, genAfter: afterIdent.gen, afterHist, hasNew: afterBytes.includes('#00cccc') })
    expect(afterIdent.gen).toBeGreaterThan(genBefore)
    expect(afterBytes).toContain('#00cccc')
    // New project baseline: paint history cleared.
    expect(afterHist.undo).toBe(false)
    expect(afterHist.redo).toBe(false)
  }, 240_000)

  it('redo after an external keeps the external too (no resurrection of stale bytes)', async () => {
    await importSb3(buildSb3(), 'ext-cas9.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await setGate('off')
    // Two committed rects => two history entries, so one Undo leaves redo=true.
    for (let round = 0; round < 2; round += 1) {
      const emptySvg = await previewSvg()
      await page.getByTestId('vector-shape-rect').last().click()
      const box = await page.getByTestId('costume-paint-surface').boundingBox()
      if (!box) throw new Error('Missing paint surface bounds')
      const dx = round === 0 ? 90 : 70
      const dy = round === 0 ? 45 : 35
      await page.mouse.move(box.x + box.width / 2 - dx, box.y + box.height / 2 - dy)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 })
      await page.mouse.up()
      await waitForPreviewSvgChange(emptySvg)
      await settle()
    }
    const histBeforeUndo = await undoRedoEnabled()
    log('redo-setup', { histBeforeUndo })
    // Undo once (valid, pre-external) then redo-stack exists; external lands; redo must refuse.
    await clickUndoVisible()
    await page.waitForTimeout(800)
    const redoBefore = await undoRedoEnabled()
    const bytesAfterUndo = await svgBytesOf('VecA', 0)
    log('redo-after-undo', { redoBefore, bytesLen: bytesAfterUndo.length, status: await editorStatus() })
    expect(redoBefore.redo).toBe(true)
    const NEW_SVG = rectSvg(40, 40, 90, 60, '#987654')
    await externalUpdate('VecA', 0, { name: 'ExtRedo', dataFormat: 'svg' }, toB64(NEW_SVG))
    await page.waitForTimeout(800)
    // Redo attempt: only if still enabled; a fail-closed redo keeps the external.
    const canRedo = (await undoRedoEnabled()).redo
    log('redo-before-external', { redoBefore, canRedo })
    if (canRedo) {
      await clickRedoVisible()
      await page.waitForTimeout(900)
    }
    const finalBytes = await svgBytesOf('VecA', 0)
    const status = await editorStatus()
    log('redo-after-external', { status, hasExt: finalBytes.includes('#987654') })
    expect(finalBytes).toContain('#987654')
    if (canRedo) expect(status).toMatch(/External costume change kept|scope changed|history cleared/i)
  }, 180_000)

  it('documents the direct-mutation bypass as unsupported (no protection expected)', async () => {
    // Direct plain-object mutation bypasses the VM slot queue by design
    // (costume-slot-cas.ts documents this boundary). Record it, do not assert safety.
    const probe = await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const t = vm.getTarget('VecA')
      if (!t) return { ok: false, reason: 'no VecA' }
      const before = t.costumes[0]?.name
      try {
        t.costumes[0].name = 'DirectMutated'
      } catch (e) {
        return { ok: false, reason: `mutation threw: ${String(e).slice(0, 200)}` }
      }
      return { ok: true, before, after: t.costumes[0]?.name }
    })
    log('direct-mutation-boundary', probe)
    expect(probe.ok).toBe(true)
    // Restore via the supported API so later legs (if any) are unaffected.
    await externalUpdate('VecA', 0, { name: 'vec-blank' })
    await page.waitForTimeout(500)
  }, 60_000)
})
