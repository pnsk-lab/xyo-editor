// Independent review verification for vector-costume-write-gate + Editor write integration.
// NEW test-only file: product code untouched.
//
// Covers, against the real Editor VM with a deferred write gate:
//   1. point/rotate/leaf STALE (once-gated preview vs cancel): restore is final;
//      after deferred resolve, old/new bytes + metadata/history/selection measured.
//   2. resize/move Escape semantics: applied moves are KEPT (no restore), with
//      new-operation + Undo/Redo during the deferred window.
//   3. New operation during point cancellation + Undo/Redo during cancellation.
//   4. Same-slot external vm.updateCostume during a gated drag.
//   5. Target rename keeps the id-slot alive (normal draw + one history entry).
//   6. targetId/name collision: two ids share one name; writes stay per-asset.
//   7. Slot-index reorder during a gated drag never writes old bytes onto shifted art.
//   8. Delete/duplicate during a gated drag never restores onto shifted slots.
//   9. Stack stall / exception recovery: a rejected VM write never stalls the slot.
//
// Verdict policy: assertions describe CORRECT behaviour and FAIL loudly.
// Failures are left failing and reported, never silenced. Setups that cannot
// be built report INVALID instead of failing.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4561
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
const RECT_A2 = rectSvg(150, 120, 140, 110, '#e74c3c')
const RECT_B = rectSvg(200, 140, 100, 80, '#2980b9')
const MIXED_VEC =
  `${HEAD}<g transform="translate(10 5)">` +
  '<rect x="100" y="232" width="120" height="58" fill="#2ecc71" stroke="none"/>' +
  '<text x="168" y="188" font-family="Arial, sans-serif" font-size="56" fill="#d6336c">Hello</text>' +
  '</g><rect x="400" y="300" width="40" height="30" fill="#95a5a6" stroke="none"/></svg>'

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
  const mixed = add(MIXED_VEC)
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
          costumes: [costume(blank, 'vec-blank'), costume(a2, 'vec-a2'), costume(mixed, 'vec-mixed')],
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
      meta: { semver: '3.0.0', vm: 'write-gate-independent', agent: 'write-gate-independent' },
    })),
    ...files,
  }))
}

function buildDupSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = fnv1a32(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const red = add(rectSvg(120, 100, 120, 90, '#e74c3c'))
  const blue = add(rectSvg(220, 150, 100, 70, '#2980b9'))
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  return Buffer.from(zipSync({
    'project.json': strToU8(JSON.stringify({
      targets: [
        {
          id: 'dupA', isStage: false, name: 'DupSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {},
          currentCostume: 0, costumes: [costume(red, 'dup-red')],
          sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
          direction: 90, draggable: false, rotationStyle: 'all around',
        },
        {
          id: 'dupB', isStage: false, name: 'DupSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {},
          currentCostume: 0, costumes: [costume(blue, 'dup-blue')],
          sounds: [], volume: 100, layerOrder: 2, visible: true, x: 60, y: 30, size: 100,
          direction: 90, draggable: false, rotationStyle: 'all around',
        },
      ],
      monitors: [], extensions: [],
      meta: { semver: '3.0.0', vm: 'write-gate-independent-dup', agent: 'write-gate-independent-dup' },
    })),
    ...files,
  }))
}

function log(label: string, value: unknown) {
  console.log(`[write-gate-independent] ${label} ${JSON.stringify(value).slice(0, 3000)}`)
}

async function snapshot(): Promise<any> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest')
    return api.snapshot()
  })
}

async function selectedCostumeMd5(): Promise<string | null> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.id === snap.selectedTargetId || t.name === snap.selectedTargetId)
  return (target?.costumes[target?.currentCostume ?? 0]?.md5ext as string | undefined) ?? null
}

async function costumeMd5Of(targetName: string, index: number): Promise<string | null> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.name === targetName)
  return (target?.costumes[index]?.md5ext as string | undefined) ?? null
}

async function costumeMetaOf(targetName: string, index: number): Promise<any> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.name === targetName)
  const c = target?.costumes[index]
  if (!c) return null
  return { name: c.name, dataFormat: c.dataFormat, bitmapResolution: c.bitmapResolution, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, md5ext: c.md5ext, assetId: c.assetId }
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
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for gate install')
    if (w.__dragRaceGate) return
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
      } else if (gate.mode === 'fail-once') {
        gate.mode = 'off'
        gate.delayed += 1
        throw new Error('injected write failure (independent gate)')
      }
    }
    vm.updateCostume = async (...args: any[]) => {
      await delayedGate(String(args[0]), Number(args[1]))
      return orig(...args)
    }
    // CAS path (editor preview/restore compare-and-write) shares the same
    // deferred instrumentation so the gated race stays exercised: without
    // this, CAS previews would bypass the delay and the barrier timing would
    // collapse (reorder would observe a committed move instead of an
    // in-flight preview).
    if (typeof vm.updateCostumeIfMatch === 'function') {
      const origCas = vm.updateCostumeIfMatch.bind(vm)
      vm.updateCostumeIfMatch = async (...args: any[]) => {
        await delayedGate(String(args[0]), Number(args[1]))
        return origCas(...args)
      }
    }
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
      const origDup = vm.duplicateCostume.bind(vm)
      vm.duplicateCostume = (...args: any[]) => {
        w.__structureCalls.push({ op: `duplicate:${String(args[0])}:${String(args[1])}`, at: Date.now() })
        return origDup(...args)
      }
    }
  })
}

async function setGate(mode: 'off' | 'all' | 'once' | 'fail-once', ms = 400) {
  await page.evaluate(({ m, delay }: { m: string; delay: number }) => {
    const w = window as unknown as Record<string, any>
    if (!w.__dragRaceGate) throw new Error('Gate not installed')
    w.__dragRaceGate.mode = m
    w.__dragRaceGate.ms = delay
  }, { m: mode, delay: ms })
}

async function gateCalls(): Promise<Array<{ target: string; index: number }>> {
  return await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    return [...(w.__dragRaceGate?.calls ?? [])]
  })
}

async function clearGateCalls() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__dragRaceGate) w.__dragRaceGate.calls = []
    if (w.__structureCalls) w.__structureCalls = []
  })
}

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

async function waitForVmCostumesLength(name: string, want: number, timeout = 20_000) {
  await page.waitForFunction(
    ({ n, length }: { n: string; length: number }) => {
      const vm = (window as unknown as any).__paintHistoryVm
      return vm.getTarget(n)?.costumes.length === length
    },
    { n: name, length: want },
    { timeout },
  )
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
  // Awaitable correct wait for the *new* import (not just target presence,
  // which is already true when re-importing the same target name): the editor
  // sets status to 'Project loaded' on PROJECT_LOADED, then the costume
  // preview settles. Immediate assert would test the sync premise.
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
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
}

async function lastPointerId(): Promise<number> {
  return await page.evaluate(() => (window as unknown as Record<string, any>).__lastPointerId ?? -1)
}

async function installPidListener() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__pidListenerInstalled) return
    w.__pidListenerInstalled = true
    document.addEventListener('pointerdown', (e: Event) => {
      w.__lastPointerId = (e as PointerEvent).pointerId
    }, true)
  })
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

async function pointHandles(): Promise<Array<{ index: number; x: number; y: number; control: boolean }>> {
  return await page.evaluate(() => {
    const out: Array<{ index: number; x: number; y: number; control: boolean }> = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const r = (el as HTMLElement).getBoundingClientRect()
      const label = el.getAttribute('aria-label') ?? ''
      out.push({
        index: Number((el as HTMLElement).dataset.pointIndex),
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        control: label.startsWith('Move control point'),
      })
    }
    return out
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

async function outlineCenter(): Promise<{ x: number; y: number }> {
  const target = page.locator('[data-vector-selection-outline]').last()
  await target.waitFor({ state: 'visible', timeout: 20_000 })
  const box = await target.boundingBox()
  if (!box) throw new Error('Missing vector object outline bounds')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function selectionOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}

async function drawRectBaseline(): Promise<{ emptySvg: string; baseSvg: string; baseMd5: string | null }> {
  const emptySvg = await previewSvg()
  await page.getByTestId('vector-shape-rect').last().click()
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  await page.mouse.move(box.x + box.width / 2 - 110, box.y + box.height / 2 - 60)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2 + 60, { steps: 12 })
  await page.mouse.up()
  await waitForPreviewSvgChange(emptySvg)
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.waitForSelector('[data-vector-path-point]', { timeout: 20_000 })
  await page.waitForTimeout(600)
  return { emptySvg, baseSvg: await previewSvg(), baseMd5: await selectedCostumeMd5() }
}

async function leafTextCenter(): Promise<{ x: number; y: number }> {
  const rect = await page.evaluate(() => {
    const svg = document.querySelector('.vector-preview svg')
    if (!svg) return null
    const unit = Array.from(svg.children).find((kid) => (kid as Element).tagName.toLowerCase() === 'g') as Element | undefined
    const text = unit?.querySelector('text') ?? null
    if (!text) return null
    const r = (text as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })
  if (!rect) throw new Error('INVALID: no text leaf rect in preview')
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface')
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  if (cx < box.x || cx > box.x + box.width || cy < box.y || cy > box.y + box.height) {
    throw new Error('INVALID: text leaf off-canvas')
  }
  return { x: cx, y: cy }
}

async function leafFacts(): Promise<{ textTransform: string | null; textContent: string }> {
  return await page.evaluate(async () => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const tgt = vm.getTarget('VecA')
    const idx = tgt.costumes.findIndex((c: any) => c.name === 'vec-mixed')
    const c = tgt.costumes[idx]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
    const text = doc.querySelector('g text')
    return { textTransform: (text as unknown as Element | null)?.getAttribute('transform'), textContent: text?.textContent ?? '' }
  })
}

async function ensureLeafReshape() {
  await page.getByTestId('vector-shape-select').last().click()
  const at = await leafTextCenter()
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.waitForTimeout(1000)
  await page.mouse.up()
  await page.waitForTimeout(500)
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.locator('[data-reshape-curve-layer]').waitFor({ state: 'attached', timeout: 8_000 })
}

describe('vector write gate independent review (new test, no product change)', () => {
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

  // Per-it fresh Page/Context: consecutive same-name fresh imports otherwise
  // leak page UI state (costume tab / vector-preview visibility) into the
  // reorder + delete legs. Server/browser stay shared; only the page is fresh.
  // No selector/timeout/assert meaning is changed; helpers keep using `page`.
  beforeEach(async () => {
    if (!browser) throw new Error('Browser not started')
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await context.newPage()
    page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 300)))
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installPidListener()
    await installVmGate()
  })

  afterEach(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.evaluate(() => {
          const w = window as unknown as Record<string, any>
          if (w.__dragRaceGate) w.__dragRaceGate.mode = 'off'
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

  it('point STALE: deferred resolve keeps old bytes/metadata/history/selection', async () => {
    await importSb3(buildSb3(), 'indep.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const { baseSvg, baseMd5 } = await drawRectBaseline()
    const baseMeta = await costumeMetaOf('VecA', 0)
    const baseBytes = await svgBytesOf('VecA', 0)
    const otherPre = await costumeMd5Of('VecB', 0)
    const otherBytesPre = await svgBytesOf('VecB', 0)
    const pairBefore = await undoRedoEnabled()
    const outlinesBefore = await selectionOutlineCount()
    const handlesBefore = await page.locator('[data-vector-path-point]').count()

    await ensurePointReshape()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    await clearGateCalls()
    await setGate('once', 600)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 70, h.y + 10, { steps: 8 })
    await page.waitForTimeout(90)
    const pid = await lastPointerId()
    await firePointer(sel, 'pointercancel', { pointerId: pid, clientX: h.x + 70, clientY: h.y + 10, buttons: 0 })
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const afterMeta = await costumeMetaOf('VecA', 0)
    const afterBytes = await svgBytesOf('VecA', 0)
    const pairAfter = await undoRedoEnabled()
    const calls = await gateCalls()
    log('point STALE full', { baseMd5, afterMd5, pairBefore, pairAfter, calls, metaSame: JSON.stringify(baseMeta) === JSON.stringify(afterMeta) })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(afterBytes).toBe(baseBytes)
    expect(afterMeta).toEqual(baseMeta)
    expect(pairAfter).toEqual(pairBefore)
    // Outside-slot asset untouched.
    expect(await costumeMd5Of('VecB', 0)).toBe(otherPre)
    expect(await svgBytesOf('VecB', 0)).toBe(otherBytesPre)
    // Selection survived the cancel (reshape still offers handles).
    expect(await page.locator('[data-vector-path-point]').count()).toBe(handlesBefore)
    expect(await selectionOutlineCount()).toBe(outlinesBefore)
  }, 180_000)

  it('rotate STALE: deferred resolve keeps old bytes/metadata/history', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'indep-rotate.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await drawRectBaseline()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const handle = page.getByTestId('vector-rotate-handle')
    await handle.waitFor({ state: 'visible', timeout: 20_000 })
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    const baseMeta = await costumeMetaOf('VecA', 0)
    const baseBytes = await svgBytesOf('VecA', 0)
    const pairBefore = await undoRedoEnabled()
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('INVALID: missing rotate handle box')
    const cx = hb.x + hb.width / 2
    const cy = hb.y + hb.height / 2
    await clearGateCalls()
    await setGate('once', 600)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 110, cy + 30, { steps: 12 })
    await page.waitForTimeout(90)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    const calls = await gateCalls()
    log('rotate STALE full', { baseMd5, afterMd5, pairBefore, pairAfter, calls })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(await svgBytesOf('VecA', 0)).toBe(baseBytes)
    expect(await costumeMetaOf('VecA', 0)).toEqual(baseMeta)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('leaf STALE: deferred resolve keeps old bytes/history', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'indep-leaf.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await page.locator('[data-testid="costume-card-2"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(900)
    await ensureLeafReshape()
    const before = await leafFacts()
    const beforeMd5 = await costumeMd5Of('VecA', 2)
    const beforeBytes = await svgBytesOf('VecA', 2)
    const pairBefore = await undoRedoEnabled()
    const from = await leafTextCenter()
    await clearGateCalls()
    await setGate('once', 600)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 55, from.y + 16, { steps: 8 })
    await page.waitForTimeout(90)
    const pid = await lastPointerId()
    await page.evaluate(({ id, x, y }: { id: number; x: number; y: number }) => {
      const layer = document.querySelector('[data-reshape-curve-layer]') as HTMLElement | null
      if (!layer) throw new Error('missing curve layer for stale cancel')
      const init = { bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: 'pen', button: 0, buttons: 0, clientX: x, clientY: y, isPrimary: true }
      layer.dispatchEvent(new PointerEvent('pointercancel', init))
      layer.dispatchEvent(new PointerEvent('lostpointercapture', init))
    }, { id: pid, x: from.x + 55, y: from.y + 16 })
    await page.mouse.up()
    await settle()
    const after = await leafFacts()
    const pairAfter = await undoRedoEnabled()
    const calls = await gateCalls()
    log('leaf STALE full', { before, after, beforeMd5, afterMd5: await costumeMd5Of('VecA', 2), pairBefore, pairAfter, calls })
    expect(after).toEqual(before)
    expect(await costumeMd5Of('VecA', 2)).toBe(beforeMd5)
    expect(await svgBytesOf('VecA', 2)).toBe(beforeBytes)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('move/resize Escape keeps applied moves; new op + Undo/Redo during deferred window stay consistent', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'indep-moveresize.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await drawRectBaseline()
    // Back to the rect costume for object move/resize.
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(900)
    await page.getByTestId('vector-shape-select').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(600)
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    // Move: drag the selected object with the deferred gate on.
    const from = await outlineCenter()
    await setGate('all', 350)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 60, from.y + 10, { steps: 10 })
    // Escape during a move keeps already-applied moves (no snapshot restore).
    await page.keyboard.press('Escape')
    await page.mouse.up()
    // Awaitable correct wait for the gated move to land BEFORE capturing the
    // pre-stamp fixture: the move preview is deferred ~350ms by the gate, so
    // an immediate read would capture the mid-flight (pre-move) preview and
    // the later Undo (which correctly returns to the move-final base) would
    // never equal it. The gate stays 'all', so the stamp's own write below is
    // still deferred (deferred-window ordering still exercised).
    await waitForPreviewSvgChange(baseSvg)
    // New operation with the stamp write still deferred by the gate.
    await page.getByTestId('vector-shape-rect').last().click()
    const stampBox = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!stampBox) throw new Error('Missing paint surface bounds')
    const stampBefore = await previewSvg()
    await page.mouse.move(stampBox.x + stampBox.width / 2 - 40, stampBox.y + stampBox.height / 2 - 30)
    await page.mouse.down()
    await page.mouse.move(stampBox.x + stampBox.width / 2 + 40, stampBox.y + stampBox.height / 2 + 30, { steps: 8 })
    await page.mouse.up()
    await settle()
    const movedSvg = await previewSvg()
    const movedMd5 = await selectedCostumeMd5()
    const pair = await undoRedoEnabled()
    log('move Escape+new-op', { baseChanged: movedSvg !== baseSvg, md5Changed: movedMd5 !== baseMd5, pair })
    // Applied move + stamp both survived; history exists.
    expect(movedSvg).not.toBe(baseSvg)
    expect(movedSvg).not.toBe(stampBefore)
    expect(movedMd5).not.toBe(baseMd5)
    expect(pair.undo).toBe(true)
    // Undo/Redo round-trip during/after the deferred window stays consistent.
    await clickUndoVisible()
    await waitForPreviewSvg(stampBefore)
    await clickRedoVisible()
    await waitForPreviewSvg(movedSvg)
    expect(await selectedCostumeMd5()).toBe(movedMd5)
    // Resize handle leg: se handle drag commits geometry with one history entry.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(stampBox.x + stampBox.width / 2, stampBox.y + stampBox.height / 2)
    const se = page.getByRole('button', { name: 'Resize selected vector object se' })
    await se.waitFor({ state: 'visible', timeout: 20_000 })
    const seBox = await se.boundingBox()
    if (!seBox) throw new Error('INVALID: missing se resize handle')
    const resizeBefore = await previewSvg()
    await setGate('all', 300)
    await page.mouse.move(seBox.x + seBox.width / 2, seBox.y + seBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(seBox.x + seBox.width / 2 + 40, seBox.y + seBox.height / 2 + 24, { steps: 10 })
    await page.mouse.up()
    await settle()
    const resizedSvg = await previewSvg()
    log('resize commit', { changed: resizedSvg !== resizeBefore })
    expect(resizedSvg).not.toBe(resizeBefore)
    expect((await undoRedoEnabled()).undo).toBe(true)
    await clickUndoVisible()
    await waitForPreviewSvg(resizeBefore)
    await clickRedoVisible()
    await waitForPreviewSvg(resizedSvg)
  }, 240_000)

  it('new edit + Undo during a gated point cancel stay ordered after the barrier', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'indep-cancel-newedit.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await drawRectBaseline()
    await ensurePointReshape()
    const otherPre = await costumeMd5Of('VecB', 0)
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    await setGate('all', 350)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 60, h.y + 8, { steps: 8 })
    const pid = await lastPointerId()
    await firePointer(sel, 'pointercancel', { pointerId: pid, clientX: h.x + 60, clientY: h.y + 8, buttons: 0 })
    await page.mouse.up()
    // New legitimate edit + Undo while the cancel barrier is still deferred.
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const beforeStamp = await previewSvg()
    await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 - 30)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 8 })
    await page.mouse.up()
    await settle()
    const finalSvg = await previewSvg()
    log('cancel+new-edit+undo-window', { stamped: finalSvg !== beforeStamp, otherSame: (await costumeMd5Of('VecB', 0)) === otherPre })
    expect(finalSvg).not.toBe(beforeStamp)
    expect((await undoRedoEnabled()).undo).toBe(true)
    expect(await costumeMd5Of('VecB', 0)).toBe(otherPre)
    await clickUndoVisible()
    await waitForPreviewSvg(beforeStamp)
    await clickRedoVisible()
    await waitForPreviewSvg(finalSvg)
  }, 240_000)

  it('same-slot external VM write during a gated drag is preserved (cancel never silently deletes it)', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'indep-external.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await drawRectBaseline()
    await ensurePointReshape()
    const baseBytes = await svgBytesOf('VecA', 0)
    const baseMeta = await costumeMetaOf('VecA', 0)
    const baseMd5 = await costumeMd5Of('VecA', 0)
    const pairBefore = await undoRedoEnabled()
    const otherPre = await costumeMd5Of('VecB', 0)
    const otherBytesPre = await svgBytesOf('VecB', 0)
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    await setGate('all', 400)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 50, h.y + 8, { steps: 8 })
    // External same-slot VM write while the preview is deferred (real Editor
    // VM delayed-promise instrumentation: the gate wraps vm.updateCostume, so
    // both the editor preview and this direct external write are deferred).
    const external = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const tgt = vm.getTarget('VecA')
      const idx = 0
      const c = tgt.costumes[idx]
      const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
      const text = new TextDecoder().decode(bytes)
      const injected = text.replace('</svg>', '<circle cx="20" cy="20" r="8" fill="#123456"/></svg>')
      const enc = new TextEncoder().encode(injected)
      await vm.updateCostume('VecA', idx, { ...c }, enc)
      return injected
    })
    if (!external.includes('#123456')) throw new Error('INVALID: external injection failed')
    if (external.length === baseBytes.length) throw new Error('INVALID: external must change bytes')
    const pid = await lastPointerId()
    await firePointer(sel, 'pointercancel', { pointerId: pid, clientX: h.x + 50, clientY: h.y + 8, buttons: 0 })
    await page.mouse.up()
    await settle()
    // Strict double verification: bytes + meta + history + status, twice.
    const finalBytes1 = await svgBytesOf('VecA', 0)
    const finalMeta1 = await costumeMetaOf('VecA', 0)
    const finalMd51 = await costumeMd5Of('VecA', 0)
    const pairAfter1 = await undoRedoEnabled()
    const statusAfter1 = await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status?.() ?? '')
    const preview1 = await previewSvg()
    await page.waitForTimeout(600)
    const finalBytes2 = await svgBytesOf('VecA', 0)
    const finalMeta2 = await costumeMetaOf('VecA', 0)
    const finalMd52 = await costumeMd5Of('VecA', 0)
    const pairAfter2 = await undoRedoEnabled()
    const statusAfter2 = await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status?.() ?? '')
    const preview2 = await previewSvg()
    const calls = await gateCalls()
    log('same-slot external', { baseLen: baseBytes.length, extLen: external.length, finalLen1: finalBytes1.length, finalLen2: finalBytes2.length, finalMd51, finalMd52, statusAfter1, statusAfter2, previewHasMarker1: preview1.includes('#123456'), previewHasMarker2: preview2.includes('#123456'), calls })
    // Outside-slot asset untouched in every case (verified twice).
    expect(await costumeMd5Of('VecB', 0)).toBe(otherPre)
    expect(await svgBytesOf('VecB', 0)).toBe(otherBytesPre)
    // CORRECT behaviour (Scratch parity + safety): the gated cancel must NOT
    // silently delete the real external vm.updateCostume same-slot update.
    // The external bytes win, the editor preview shows them (no stale preview
    // residue), history is untouched (cancel discards its peek, external has
    // no history), and the conflict is surfaced via status (safe rejection).
    expect(finalBytes1).toBe(external)
    expect(finalBytes2).toBe(external)
    expect(finalBytes1).not.toBe(baseBytes)
    expect(finalMd51).not.toBe(baseMd5)
    expect(finalMd52).toBe(finalMd51)
    expect(finalMeta1).toEqual(finalMeta2)
    // Meta keeps display identity (rename-safe slot) but points at external bytes.
    expect(finalMeta1.name).toBe(baseMeta.name)
    expect(finalMeta1.dataFormat).toBe('svg')
    // Editor preview reflects the preserved external write (no residue), twice.
    expect(preview1.includes('#123456')).toBe(true)
    expect(preview2.includes('#123456')).toBe(true)
    // Conflict is surfaced, not silent: status must name the external keep.
    expect(`${statusAfter1} ${statusAfter2}`.toLowerCase()).toMatch(/external|conflict|kept/)
    // History整合: cancel + external push nothing; the pre-drag entry stays.
    expect(pairAfter1).toEqual(pairBefore)
    expect(pairAfter2).toEqual(pairBefore)
    // Recovery: the slot still accepts the next legitimate edit after the
    // conflict (no stall), with exactly one new history step.
    await ensureVectorMode()
    const beforeRetry = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const rbox = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!rbox) throw new Error('Missing paint surface bounds')
    await page.mouse.move(rbox.x + rbox.width / 2 - 40, rbox.y + rbox.height / 2 - 30)
    await page.mouse.down()
    await page.mouse.move(rbox.x + rbox.width / 2 + 40, rbox.y + rbox.height / 2 + 30, { steps: 8 })
    await page.mouse.up()
    await waitForPreviewSvgChange(beforeRetry)
    await settle()
    const retriedPreview = await previewSvg()
    const retriedBytes = await svgBytesOf('VecA', 0)
    expect(retriedBytes).not.toBe(external)
    expect(retriedPreview).not.toBe(beforeRetry)
    expect((await undoRedoEnabled()).undo).toBe(true)
    await clickUndoVisible()
    await waitForPreviewSvg(beforeRetry)
    expect(await svgBytesOf('VecA', 0)).toBe(external)
    await clickRedoVisible()
    await waitForPreviewSvg(retriedPreview)
    expect(await svgBytesOf('VecA', 0)).toBe(retriedBytes)
  }, 180_000)

  it('target rename keeps the id slot alive; name collision stays per-asset', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'indep-rename.sb3', 'VecA')
    await ensureVectorMode()
    // Rename VecA -> VecARenamed via the inspector input (real UI path).
    await page.getByTestId('target-card-VecA').click().catch(async () => {
      await page.getByTestId('target-card-VecARenamed').click()
    })
    await page.waitForTimeout(600)
    const nameInput = page.getByLabel('Sprite name')
    await nameInput.waitFor({ state: 'visible', timeout: 20_000 })
    await nameInput.fill('VecARenamed')
    await nameInput.press('Enter')
    await page.waitForTimeout(900)
    const snap = await snapshot()
    const renamed = snap.project.targets.some((t: any) => t.name === 'VecARenamed')
    log('rename', { renamed, targets: snap.project.targets.map((t: any) => ({ id: t.id, name: t.name })) })
    expect(renamed).toBe(true)
    // Normal draw after rename works with exactly one history entry.
    await page.getByTestId('main-tab-costumes').click()
    await ensureVectorMode()
    const beforeDraw = await previewSvg()
    const pairBeforeDraw = await undoRedoEnabled()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 })
    await page.mouse.up()
    await waitForPreviewSvgChange(beforeDraw)
    await settle()
    const drawn = await previewSvg()
    expect(drawn).not.toBe(beforeDraw)
    expect((await undoRedoEnabled()).undo).toBe(true)
    await clickUndoVisible()
    await waitForPreviewSvg(beforeDraw)
    expect((await undoRedoEnabled()).undo).toBe(pairBeforeDraw.undo)
    await clickRedoVisible()
    await waitForPreviewSvg(drawn)

    // Collision: two ids share one name; writes stay per-asset.
    await importSb3(buildDupSb3(), 'indep-dup.sb3', 'DupSprite')
    await ensureVectorMode()
    const dupSnap = await snapshot()
    const dups = dupSnap.project.targets.filter((t: any) => t.name === 'DupSprite')
    log('collision coexistence', { count: dups.length, ids: dups.map((t: any) => t.id) })
    if (dups.length !== 2) {
      log('collision', { verdict: 'INVALID: duplicate names do not coexist' })
      expect(dups.length).toBe(2)
      return
    }
    const firstHit = await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      return vm.getTarget('DupSprite')?.id ?? null
    })
    expect(firstHit).toBe('dupA')
    // Select the first DupSprite card and draw; only its asset may change.
    const cards = page.getByTestId('target-card-DupSprite')
    await cards.first().click()
    await page.waitForTimeout(900)
    await page.getByTestId('main-tab-costumes').click()
    await ensureVectorMode()
    const dupOtherPre = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const targets = vm.project.targets.filter((t: any) => t.name === 'DupSprite')
      const second = targets[1]
      const c = second.costumes[0]
      const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
      return new TextDecoder().decode(bytes)
    })
    const dupBefore = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const dbox = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!dbox) throw new Error('Missing paint surface bounds')
    await page.mouse.move(dbox.x + dbox.width / 2 - 50, dbox.y + dbox.height / 2 - 30)
    await page.mouse.down()
    await page.mouse.move(dbox.x + dbox.width / 2 + 50, dbox.y + dbox.height / 2 + 30, { steps: 8 })
    await page.mouse.up()
    await waitForPreviewSvgChange(dupBefore)
    await settle()
    const dupAfterOther = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const targets = vm.project.targets.filter((t: any) => t.name === 'DupSprite')
      const second = targets[1]
      const c = second.costumes[0]
      const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
      return new TextDecoder().decode(bytes)
    })
    log('collision per-asset', { otherUntouched: dupAfterOther === dupOtherPre })
    expect(dupAfterOther).toBe(dupOtherPre)
    // Restore the main project for the remaining legs.
    await importSb3(buildSb3(), 'indep-restore.sb3', 'VecA')
    await ensureVectorMode()
  }, 240_000)

  it('slot-index reorder during a gated drag never writes old bytes onto shifted art', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'indep-reorder.sb3', 'VecA')
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await ensureVectorMode()
    await drawRectBaseline()
    await ensurePointReshape()
    const slot0Pre = await svgBytesOf('VecA', 0)
    const slot1Pre = await svgBytesOf('VecA', 1)
    const slot1MetaPre = await costumeMetaOf('VecA', 1)
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for reorder leg')
    const h = handles[0]!
    await setGate('all', 400)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 55, h.y + 8, { steps: 8 })
    // Release BEFORE the true pointer-DnD drop (realistic: deferred preview
    // stays in-flight through the 400ms gate, so the barrier is exercised
    // without holding pointer capture across the drop).
    await page.mouse.up()
    // Structural reorder through the real drag-drop UI path (true pointer DnD
    // `dropCostumeOn`: abandons gestures, reverts landed previews, drains,
    // bumps epoch, then swaps slot0/slot1 exact).
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
    // pointer-DnD path committed, epoch proves the barrier ran.
    await page.waitForFunction(() => (window as unknown as any).__hikkakuEditorTest?.status?.() === 'Costume reordered', undefined, { timeout: 20_000 })
    await settle()
    const slot0After = await svgBytesOf('VecA', 0)
    const slot1After = await svgBytesOf('VecA', 1)
    const pairAfter = await undoRedoEnabled()
    log('reorder slots', {
      slot0IsOldSlot1: slot0After === slot1Pre,
      slot1IsOldSlot0: slot1After === slot0Pre,
      slot1MetaSame: (await costumeMetaOf('VecA', 1))?.name === slot1MetaPre?.name ? 'name-shifted-as-expected' : 'name-check',
      pairAfter,
    })
    // The reorder itself shifted artwork (slot 0 now holds old slot 1, or the
    // drop was a no-op in this layout); in NEITHER case may stale preview
    // bytes from the abandoned drag appear in either slot.
    expect(slot0After === slot0Pre || slot0After === slot1Pre).toBe(true)
    expect(slot1After === slot1Pre || slot1After === slot0Pre).toBe(true)
    // History was cleared unconditionally by the structural change.
    expect(pairAfter).toEqual({ undo: false, redo: false })
    // Normal drawing works again after the reorder.
    await ensureVectorMode()
    const beforeDraw = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 8 })
    await page.mouse.up()
    await waitForPreviewSvgChange(beforeDraw)
    await settle()
    expect(await previewSvg()).not.toBe(beforeDraw)
    expect((await undoRedoEnabled()).undo).toBe(true)
  }, 240_000)

  it('delete/duplicate during a gated drag never restores onto shifted slots; exception never stalls the slot', async () => {
    await setGate('off')
    await clearGateCalls()
    await importSb3(buildSb3(), 'indep-del.sb3', 'VecA')
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await ensureVectorMode()
    await drawRectBaseline()
    await ensurePointReshape()
    const slot1Pre = await svgBytesOf('VecA', 1)
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for delete leg')
    const h = handles[0]!
    await setGate('all', 400)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 50, h.y + 8, { steps: 8 })
    // Release BEFORE Delete (realistic pointer flow: pointer capture would
    // swallow a click while held, so the old hold-down premise never reaches
    // `deleteCostume`). The gated preview stays in-flight, so the barrier
    // (drain + revert + epoch bump) is still exercised.
    await page.mouse.up()
    // Delete costume 0 through the real sidebar button (true UI path).
    const delBtn = page.locator('[data-testid="costume-card-0"] button[aria-label^="Delete "]')
    await delBtn.click()
    // Awaitable correct waits (assert unchanged): VM length proves the
    // structural commit, status proves the UI notification.
    await waitForVmCostumesLength('VecA', 2)
    await page.waitForFunction(() => (window as unknown as any).__hikkakuEditorTest?.status?.() === 'Costume deleted', undefined, { timeout: 20_000 })
    await settle()
    // Slot 0 now holds the old slot 1 artwork (deletion shifts); stale preview
    // bytes from the abandoned drag must not appear.
    const slot0AfterDelete = await svgBytesOf('VecA', 0)
    log('delete shift', { slot0IsOldSlot1: slot0AfterDelete === slot1Pre })
    expect(slot0AfterDelete).toBe(slot1Pre)
    // Duplicate the current costume through the real toolbar button.
    await page.getByRole('button', { name: 'Duplicate costume' }).click()
    await waitForVmCostumesLength('VecA', 3)
    await page.waitForFunction(() => (window as unknown as any).__hikkakuEditorTest?.status?.() === 'Costume duplicated', undefined, { timeout: 20_000 })
    await settle()
    const snapAfterDup = await snapshot()
    const vecA = snapAfterDup.project.targets.find((t: any) => t.name === 'VecA')
    expect(vecA.costumes.length).toBe(3)
    // Injected failure: the next VM write rejects, but the slot chain survives.
    await setGate('fail-once')
    const failBefore = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 })
    await page.mouse.up()
    // The failing write may reject inside the Editor commit; the slot must
    // still accept the next legitimate edit (no stall).
    await page.waitForTimeout(1200)
    await setGate('off')
    await settle()
    const afterFail = await previewSvg()
    // Either the failed stamp vanished (rejected) or the gate passed it
    // through; what matters is the slot is usable for the next edit.
    const retryBefore = afterFail
    await page.getByTestId('vector-shape-rect').last().click()
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 - 20)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 8 })
    await page.mouse.up()
    await waitForPreviewSvgChange(retryBefore)
    await settle()
    const retried = await previewSvg()
    log('exception recovery', { failBeforeChanged: afterFail !== failBefore, retriedChanged: retried !== retryBefore })
    expect(retried).not.toBe(retryBefore)
    expect((await undoRedoEnabled()).undo).toBe(true)
  }, 300_000)
})
