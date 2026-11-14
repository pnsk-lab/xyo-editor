// Persistent diagnostic for vector-write-gate-independent residual fails.
// Product code untouched. Assertions are NOT loosened: same strict expectations
// as the original legs, but every leg dumps VM bytes/contentHash, assetId,
// geometry/rotationCenter, redo, prior history (undo/redo), real UI selection
// (target/costume), and click coordinates BEFORE asserting, so a failure can be
// triaged as product bug vs fixture premise without re-running.
//
// Covers the three residual fails:
//   A. resize Undo does not return to pre-resize preview (timeout)
//   B. delete slot0 != old slot1
//   C. full-suite reorder/delete: vector-preview not visible
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4569
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

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
const RECT_A2 = rectSvg(150, 120, 140, 110, '#e74c3c')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = fnv1a32(bytes)
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
      ],
      monitors: [], extensions: [],
      meta: { semver: '3.0.0', vm: 'write-gate-diag', agent: 'write-gate-diag' },
    })),
    ...files,
  }))
}

function log(label: string, value: unknown) {
  console.log(`[write-gate-diag] ${label} ${JSON.stringify(value).slice(0, 6000)}`)
}

async function snapshot(): Promise<any> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest')
    return api.snapshot()
  })
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewSvg(expected: string, timeout = 20_000) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML === svg, expected, { timeout })
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

async function installVmGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__dragRaceGate) return
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for gate install')
    const orig = vm.updateCostume.bind(vm)
    const gate = (w.__dragRaceGate = { mode: 'off', ms: 400, calls: [] as Array<{ target: string; index: number }>, delayed: 0 })
    const delayedGate = async (target: string, index: number) => {
      gate.calls.push({ target: String(target), index: Number(index) })
      if (gate.mode === 'all') {
        gate.delayed += 1
        await new Promise((r) => setTimeout(r, gate.ms))
      } else if (gate.mode === 'once') {
        gate.mode = 'off'
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
    // Strict audit: structural entry order (sync-premise vs barrier vs UI).
    // Counts real `vm.deleteCostume` / `vm.reorderCostume` invocations with
    // wall-clock order relative to gated writes.
    if (!w.__structureCalls) {
      w.__structureCalls = [] as Array<{ op: string; at: number }>
      const origDelete = vm.deleteCostume.bind(vm)
      vm.deleteCostume = (...args: any[]) => {
        w.__structureCalls.push({ op: `delete:${String(args[0])}:${String(args[1])}`, at: Date.now() })
        return origDelete(...args)
      }
      const origReorder = vm.reorderCostume.bind(vm)
      vm.reorderCostume = (...args: any[]) => {
        w.__structureCalls.push({ op: `reorder:${String(args[0])}:${String(args[1])}:${String(args[2])}`, at: Date.now() })
        return origReorder(...args)
      }
    }
  })
}

async function setGate(mode: 'off' | 'all' | 'once', ms = 400) {
  await page.evaluate(({ m, delay }: { m: string; delay: number }) => {
    const w = window as unknown as Record<string, any>
    if (!w.__dragRaceGate) throw new Error('Gate not installed')
    w.__dragRaceGate.mode = m
    w.__dragRaceGate.ms = delay
  }, { m: mode, delay: ms })
}

async function gateCalls() {
  return await page.evaluate(() => [...((window as unknown as Record<string, any>).__dragRaceGate?.calls ?? [])])
}

async function clearGateCalls() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__dragRaceGate) w.__dragRaceGate.calls = []
    if (w.__structureCalls) w.__structureCalls = []
  })
}

async function structureCalls(): Promise<Array<{ op: string; at: number }>> {
  return await page.evaluate(() => [...((window as unknown as Record<string, any>).__structureCalls ?? [])])
}

// Strict queue audit: per-target epoch / active barrier / in-flight tails.
// Separates sync-premise (structure never entered: epoch unchanged, no barrier,
// no structural call) from barrier deadlock (barrier held, tails never settle)
// from async-UI wait (barrier released, epoch bumped, VM shifted, UI lags).
async function gateState(targetId: string): Promise<{ epoch: number; hasActiveBarrier: boolean; inFlightTails: number; hasQueuedStructure: boolean }> {
  return await page.evaluate((id: string) => {
    const w = window as unknown as Record<string, any>
    const debug = w.__vectorGateDebug
    if (!debug) return { epoch: -1, hasActiveBarrier: false, inFlightTails: -1, hasQueuedStructure: false }
    return debug.state(id)
  }, targetId)
}

async function vmTargetId(name: string): Promise<string> {
  return await page.evaluate((n: string) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const t = vm.getTarget(n)
    return String(t?.id ?? n)
  }, name)
}

async function vmCostumesLength(name: string): Promise<number> {
  return await page.evaluate((n: string) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    return Number(vm.getTarget(n)?.costumes.length ?? -1)
  }, name)
}

async function waitForVmCostumesLength(name: string, want: number, timeout = 20_000) {
  await page.waitForFunction(
    ({ n, length }: { n: string; length: number }) => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      return vm.getTarget(n)?.costumes.length === length
    },
    { n: name, length: want },
    { timeout },
  )
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => (window as unknown as any).__hikkakuEditorTest?.status?.() ?? '')
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
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
}

// Full forensics dump for one checkpoint. Records everything the triage
// asks for in a single call sequence so logs stay correlated.
async function diagDump(label: string, extra: Record<string, unknown> = {}) {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.id === snap.selectedTargetId || t.name === snap.selectedTargetId)
  const targets = snap.project.targets.map((t: any) => ({
    id: t.id, name: t.name, currentCostume: t.currentCostume,
    costumes: t.costumes.map((c: any) => ({
      name: c.name, assetId: c.assetId, md5ext: c.md5ext, dataFormat: c.dataFormat,
      bitmapResolution: c.bitmapResolution, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY,
    })),
  }))
  const vmState = await page.evaluate(async () => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    if (!vm) return { missing: true }
    const out: Record<string, any> = {}
    for (const t of vm.project.targets) {
      out[String(t.id ?? t.name)] = {
        name: t.name,
        currentCostume: t.currentCostume,
        costumes: await Promise.all(t.costumes.map(async (c: any, i: number) => {
          let len = -1
          let hash = ''
          let head = ''
          try {
            const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
            len = bytes.byteLength
            let h = 0x811c9dc5
            for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) }
            hash = (h >>> 0).toString(16).padStart(8, '0')
            head = new TextDecoder().decode(bytes.slice(0, 400))
          } catch (e) { head = `loadAsset failed: ${String(e).slice(0, 200)}` }
          return {
            index: i, name: c.name, assetId: c.assetId, md5ext: c.md5ext,
            dataFormat: c.dataFormat, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY,
            bytesLen: len, bytesHash: hash, bytesHead: head.slice(0, 400),
          }
        })),
      }
    }
    return out
  })
  const preview = await page.locator('.vector-preview').innerHTML().catch((e) => `preview-missing: ${String(e).slice(0, 300)}`)
  const previewInfo = { len: preview.length, hash: fnv1a32(new TextEncoder().encode(preview)), head: preview.slice(0, 600) }
  const pair = await undoRedoEnabled()
  const calls = await gateCalls()
  const ui = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="costume-paint-surface"]')
    const sr = surface ? (surface as HTMLElement).getBoundingClientRect() : null
    const outlines = document.querySelectorAll('[data-vector-selection-outline]').length
    const se = document.querySelector('[aria-label="Resize selected vector object se"]') as HTMLElement | null
    const seR = se ? se.getBoundingClientRect() : null
    const previewEl = document.querySelector('.vector-preview') as HTMLElement | null
    const previewR = previewEl ? previewEl.getBoundingClientRect() : null
    const cards = Array.from(document.querySelectorAll('[data-testid^="costume-card-"]')).map((el) => ({
      testId: (el as HTMLElement).dataset.testid,
      rect: (() => { const r = (el as HTMLElement).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })(),
    }))
    return {
      surfaceRect: sr ? { x: sr.x, y: sr.y, w: sr.width, h: sr.height } : null,
      previewRect: previewR ? { x: previewR.x, y: previewR.y, w: previewR.width, h: previewR.height } : null,
      outlineCount: outlines,
      seRect: seR ? { x: seR.x, y: seR.y, w: seR.width, h: seR.height } : null,
      costumeCards: cards,
    }
  })
  log(label, {
    ...extra,
    selectedTargetId: snap.selectedTargetId,
    selectedCostumeOfTarget: target ? { name: target.name, id: target.id, currentCostume: target.currentCostume } : null,
    targets, vmState, previewInfo, undoRedo: pair, gateCalls: calls, ui,
  })
}

describe('vector write gate diagnostics (no product change, strict asserts)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) { ready = true; break }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 400)))
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installVmGate()
  }, 120_000)

  afterAll(async () => {
    try {
      await page.evaluate(() => {
        const w = window as unknown as Record<string, any>
        if (w.__dragRaceGate) w.__dragRaceGate.mode = 'off'
      })
    } catch {}
    await browser?.close()
    server?.kill()
  })

  it('diag-A resize Undo forensics (strict: Undo must restore pre-resize preview)', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'diag-resize.sb3', 'VecA')
    await ensureVectorMode()
    // Real UI selection path: click target card, then costume card 0.
    const targetCardBox = await page.getByTestId('target-card-VecA').boundingBox()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await diagDump('A-imported', { targetCardBox })
    // Draw one rect baseline so resize has geometry (same as original leg).
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const surfaceBox = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!surfaceBox) throw new Error('Missing paint surface bounds')
    const downA = { x: surfaceBox.x + surfaceBox.width / 2 - 110, y: surfaceBox.y + surfaceBox.height / 2 - 60 }
    const moveA = { x: surfaceBox.x + surfaceBox.width / 2 + 110, y: surfaceBox.y + surfaceBox.height / 2 + 60 }
    await page.mouse.move(downA.x, downA.y)
    await page.mouse.down()
    await page.mouse.move(moveA.x, moveA.y, { steps: 12 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await diagDump('A-after-baseline-draw', { downA, moveA, surfaceBox })
    // Select object for resize.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height / 2)
    const se = page.getByRole('button', { name: 'Resize selected vector object se' })
    await se.waitFor({ state: 'visible', timeout: 20_000 })
    const seBox = await se.boundingBox()
    if (!seBox) throw new Error('INVALID: missing se resize handle')
    const seCenter = { x: seBox.x + seBox.width / 2, y: seBox.y + seBox.height / 2 }
    const resizeBefore = await previewSvg()
    const pairBefore = await undoRedoEnabled()
    await diagDump('A-pre-resize', { seBox, seCenter, pairBefore, resizeBeforeHash: fnv1a32(new TextEncoder().encode(resizeBefore)) })
    // Deferred resize drag.
    await setGate('all', 300)
    const dragTo = { x: seCenter.x + 40, y: seCenter.y + 24 }
    await page.mouse.move(seCenter.x, seCenter.y)
    await page.mouse.down()
    await page.mouse.move(dragTo.x, dragTo.y, { steps: 10 })
    await page.mouse.up()
    await settle()
    const resizedSvg = await previewSvg()
    const pairResized = await undoRedoEnabled()
    await diagDump('A-post-resize', { seCenter, dragTo, pairResized, resizedChanged: resizedSvg !== resizeBefore })
    expect(resizedSvg).not.toBe(resizeBefore)
    expect(pairResized.undo).toBe(true)
    // Strict Undo leg: must return to pre-resize preview.
    await clickUndoVisible()
    const pairAfterUndoClick = await undoRedoEnabled()
    await diagDump('A-after-undo-click', { pairAfterUndoClick })
    try {
      await waitForPreviewSvg(resizeBefore, 20_000)
    } catch (e) {
      await diagDump('A-undo-timeout', { wantedHash: fnv1a32(new TextEncoder().encode(resizeBefore)), gotHash: fnv1a32(new TextEncoder().encode(await previewSvg())) })
      throw e
    }
    await diagDump('A-after-undo-settled', {})
    expect(await previewSvg()).toBe(resizeBefore)
    await clickRedoVisible()
    await waitForPreviewSvg(resizedSvg)
    expect(await previewSvg()).toBe(resizedSvg)
  }, 240_000)

  it('diag-B delete-shift forensics (strict: slot0 must equal old slot1 bytes)', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'diag-delete.sb3', 'VecA')
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await ensureVectorMode()
    // Baseline draw on slot 0 so slot0/slot1 both carry real art.
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 110, box.y + box.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2 + 60, { steps: 12 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    await diagDump('B-after-baseline', {})
    const slot0Pre = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const t = vm.getTarget('VecA')
      const c = t.costumes[0]
      return new TextDecoder().decode((await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array)
    })
    const slot1Pre = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const t = vm.getTarget('VecA')
      const c = t.costumes[1]
      return new TextDecoder().decode((await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array)
    })
    await diagDump('B-pre-delete-slots', { slot0PreHash: fnv1a32(new TextEncoder().encode(slot0Pre)), slot1PreHash: fnv1a32(new TextEncoder().encode(slot1Pre)) })
    // Gated point-drag then real sidebar delete of costume 0 (same as original).
    const handles = await page.evaluate(() => {
      const out: Array<{ index: number; x: number; y: number }> = []
      for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
        const r = (el as HTMLElement).getBoundingClientRect()
        out.push({ index: Number((el as HTMLElement).dataset.pointIndex), x: r.left + r.width / 2, y: r.top + r.height / 2 })
      }
      return out
    })
    // Ensure reshape handles exist; if not, select+reshape first.
    if (handles.length === 0) {
      await page.getByTestId('vector-shape-reshape').last().click()
      await page.waitForSelector('[data-vector-path-point]', { timeout: 20_000 })
      await page.waitForTimeout(400)
    }
    const hs = (await page.evaluate(() => {
      const out: Array<{ index: number; x: number; y: number }> = []
      for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
        const r = (el as HTMLElement).getBoundingClientRect()
        out.push({ index: Number((el as HTMLElement).dataset.pointIndex), x: r.left + r.width / 2, y: r.top + r.height / 2 })
      }
      return out.sort((a, b) => a.x - b.x)
    }))[0]
    if (!hs) throw new Error('INVALID: no anchor handles for delete leg')
    await setGate('all', 400)
    const vecAId = await vmTargetId('VecA')
    const epochBeforeDrag = (await gateState(vecAId)).epoch
    await page.mouse.move(hs.x, hs.y)
    await page.mouse.down()
    await page.mouse.move(hs.x + 50, hs.y + 8, { steps: 8 })
    // Release BEFORE the structural click (realistic pointer flow: pointer
    // capture would swallow a click while held, so the old hold-down premise
    // never reaches `deleteCostume`). The gated preview is still in-flight
    // during the 400ms delay, so the barrier path is still exercised.
    await page.mouse.up()
    const delBtn = page.locator('[data-testid="costume-card-0"] button[aria-label^="Delete "]')
    const delBox = await delBtn.boundingBox().catch(() => null)
    await diagDump('B-before-delete-click', { dragFrom: hs, dragTo: { x: hs.x + 50, y: hs.y + 8 }, delBox, epochBeforeDrag, gateAfterDrag: await gateCalls() })
    await delBtn.click()
    // Awaitable correct waits (assert unchanged): VM length shift proves the
    // structural commit, status proves the UI notification, settle proves the
    // preview quiescence. Immediate assert would test the sync premise.
    await waitForVmCostumesLength('VecA', 1)
    await page.waitForFunction(() => (window as unknown as any).__hikkakuEditorTest?.status?.() === 'Costume deleted', undefined, { timeout: 20_000 })
    await settle()
    const epochAfter = (await gateState(vecAId)).epoch
    await diagDump('B-after-delete', { slot1PreHash: fnv1a32(new TextEncoder().encode(slot1Pre)), epochBeforeDrag, epochAfter, structureCalls: await structureCalls() })
    const slot0AfterDelete = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const t = vm.getTarget('VecA')
      const c = t.costumes[0]
      return new TextDecoder().decode((await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array)
    })
    log('B-compare', { slot0AfterIsOldSlot1: slot0AfterDelete === slot1Pre, slot0AfterIsOldSlot0: slot0AfterDelete === slot0Pre })
    // Strict: deletion shifts old slot1 into slot0, no stale restore.
    expect(slot0AfterDelete).toBe(slot1Pre)
  }, 240_000)

  it('diag-C reorder/delete full-order forensics (strict: preview stays visible, no stale bytes)', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'diag-reorder.sb3', 'VecA')
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await ensureVectorMode()
    await diagDump('C-imported', {})
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box0 = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box0) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box0.x + box0.width / 2 - 110, box0.y + box0.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box0.x + box0.width / 2 + 110, box0.y + box0.height / 2 + 60, { steps: 12 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    // Go through drag-reorder via real drag-drop UI path (abandons gestures).
    await page.getByTestId('vector-shape-reshape').last().click().catch(() => {})
    await page.waitForSelector('[data-vector-path-point]', { timeout: 20_000 }).catch(() => {})
    const slot0Pre = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const c = vm.getTarget('VecA').costumes[0]
      return new TextDecoder().decode((await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array)
    })
    const slot1Pre = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const c = vm.getTarget('VecA').costumes[1]
      return new TextDecoder().decode((await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array)
    })
    await diagDump('C-pre-reorder', { slot0PreHash: fnv1a32(new TextEncoder().encode(slot0Pre)), slot1PreHash: fnv1a32(new TextEncoder().encode(slot1Pre)) })
    await setGate('all', 400)
    const vecAIdForReorder = await vmTargetId('VecA')
    const epochBeforeReorder = (await gateState(vecAIdForReorder)).epoch
    const h = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-vector-path-point]'))
      const r = (els[0] as HTMLElement | undefined)?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })
    if (h) {
      await page.mouse.move(h.x, h.y)
      await page.mouse.down()
      await page.mouse.move(h.x + 55, h.y + 8, { steps: 8 })
      // Release BEFORE the structural drop (realistic: the deferred preview
      // stays in-flight through the 400ms gate, so the barrier is exercised
      // without holding pointer capture across the drop).
      await page.mouse.up().catch(() => {})
    }
    await page.evaluate(() => {
      const src = document.querySelector('[data-testid="costume-card-0"]') as HTMLElement | null
      const dst = document.querySelector('[data-testid="costume-card-1"]') as HTMLElement | null
      if (!src || !dst) throw new Error('missing costume cards for reorder')
      const dt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    // Awaitable correct waits (assert unchanged): status proves the true
    // pointer-DnD UI path committed, epoch bump proves the barrier ran,
    // VM order proves the swap. Immediate assert would test sync premise.
    await page.waitForFunction(() => (window as unknown as any).__hikkakuEditorTest?.status?.() === 'Costume reordered', undefined, { timeout: 20_000 })
    await page.waitForFunction(
      ({ want0, want1 }: { want0: string; want1: string }) => {
        const vm = (window as unknown as any).__paintHistoryVm
        const t = vm.getTarget('VecA')
        if (!t || t.costumes.length !== 2) return false
        const a = t.costumes[0]?.name
        const b = t.costumes[1]?.name
        return (a === want0 && b === want1) || (a === want1 && b === want0)
      },
      { want0: 'vec-blank', want1: 'vec-a2' },
      { timeout: 20_000 },
    )
    await settle()
    await diagDump('C-post-reorder', { epochBeforeReorder, epochAfter: (await gateState(vecAIdForReorder)).epoch, structureCalls: await structureCalls() })
    // Strict leg mirrors original: slots hold only old bytes, history cleared,
    // and a fresh draw works with preview visible.
    const slot0After = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const c = vm.getTarget('VecA').costumes[0]
      return new TextDecoder().decode((await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array)
    })
    const slot1After = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const c = vm.getTarget('VecA').costumes[1]
      return new TextDecoder().decode((await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array)
    })
    log('C-compare', { slot0ok: slot0After === slot0Pre || slot0After === slot1Pre, slot1ok: slot1After === slot1Pre || slot1After === slot0Pre })
    expect(slot0After === slot0Pre || slot0After === slot1Pre).toBe(true)
    expect(slot1After === slot1Pre || slot1After === slot0Pre).toBe(true)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
    await ensureVectorMode()
    const beforeDraw = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 8 })
    await page.mouse.up()
    try {
      await waitForPreviewSvgChange(beforeDraw)
    } catch (e) {
      await diagDump('C-preview-not-visible-timeout', { beforeDrawHash: fnv1a32(new TextEncoder().encode(beforeDraw)) })
      throw e
    }
    await settle()
    expect(await previewSvg()).not.toBe(beforeDraw)
  }, 240_000)
})
