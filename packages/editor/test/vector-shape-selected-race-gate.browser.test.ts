import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Vector shape-tool selected-drag race gate (NEW test-only file, product code untouched).
//
// Recent change under test (read directly from the working tree, no product
// edit here): `BitmapEditor.svelte` routes a rect/oval press over the live
// selection through an async `beginVectorSelectedDragAtPoint` hit test
// (`vectorHitPromise`). A hit starts a move drag under the SAME shape tool
// (tool retention); a miss clears and starts a fresh `vectorShapeDraft` from
// the LATEST pointer (pre-resolve moves are tracked via
// `vectorShapeLastPoint/Modifiers`). The async `handleCanvasMouseUp` awaits
// the pending promise before branching; `discardCancelledVectorGesture`
// refuses to discard while `vectorHitPromise || vectorShapeDelegated` so the
// normal end path settles the gesture.
//
// High-risk window: the delayed hit-test resolve races pointerup /
// pointercancel / lostpointercapture / Escape, target / costume / project
// switches, the next pointerdown, mid-flight modifier changes, unrelated
// external `vm.updateCostume` writes, and double-click/touch repeats. A stale
// resolve must never move the wrong asset, resurrect a cleared selection,
// double-commit history, or flip the armed shape tool.
//
// Method (test-only, deterministic — no hidden timeouts):
// - Real Editor + real VM via the existing paint-history fixture
//   (`test/paint-history-isolation-fixture.html`, unmodified) which mounts the
//   production Editor and exposes its VM as `window.__paintHistoryVm`.
// - A deferred `loadAsset` gate wraps THAT VM instance in page context
//   (test-only monkey patch, removed at the end): `next` delays only the next
//   SVG load (the hit test's `currentSvgDocument`), `all` delays every load,
//   so the racing interrupt deterministically lands INSIDE the async hit
//   window. Every leg then settles (gate off + preview/call-count stability
//   across polls) and asserts strict equality — production-shape waits only,
//   nothing is asserted on a transient first frame and no timeout is caught
//   and hidden.
// - Real bytes (`vm.loadAsset`), meta (name/res/center/format/md5), UI
//   preview (`.vector-preview` innerHTML), history (visible Undo/Redo +
//   undo/redo round-trip equality), selection (blue outlines), and owner
//   (selected target / costume index / md5) are compared for the OLD and NEW
//   assets on every switching leg: a cross-asset write FAILS loudly.
// - HMR/false-pass guards: the suite serves through `vite.gate.config.ts`
//   (watcher + HMR disabled, so a concurrent edit can never remount the
//   canvas mid-gesture) and carries a boot-id tripwire (`__gateBootId`):
//   any foreign reload changes the id and fails the leg LOUDLY instead of
//   producing a torn verdict.
//
// Verdict policy: assertions describe CORRECT behaviour. A reproduced product
// bug FAILS loudly (left failing + reported, never silenced).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/vector-shape-selected-race-gate.browser.test.ts

const root = join(import.meta.dir, '..')
// Independent fixed port: 4613 is claimed by no sibling browser suite
// (surveyed 2026-11-12: 41xx-43xx block, 44xx block, 4527/4531/4533/4535/
// 4539/4540/4542/4549/4551/4561/4567/4569/4570/4571/4573/4581/4593/4597/
// 4599/4607/4621/4691/4695/4696 all taken) and no listener at survey time.
const PORT = 4613
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// Self-made fixtures (original coordinates, distinct fills per asset so a
// cross-asset write is attributable; `variant` shifts the red rect so every
// import carries a unique md5 — the import gate waits for THAT md5 and can
// never pass instantly on the previous project's same-named target).
const BLANK_VEC = `${HEAD}</svg>`
const rectSvg = (x: number, y: number, w: number, h: number, fill: string) =>
  `${HEAD}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#111111" stroke-width="2"/></svg>`
const RED_FILL = '#e74c3c'
const redRectSvg = (variant: number) => rectSvg(150 + variant * 11, 120, 140, 110, RED_FILL)
const RECT_BLUE = rectSvg(200, 140, 100, 80, '#2980b9')
const RECT_GREEN = rectSvg(170, 130, 120, 90, '#2ecc71')

function redMd5(variant: number): string {
  return `${md5(new TextEncoder().encode(redRectSvg(variant)))}.svg`
}

function buildSb3(variant = 0): Buffer {
  const RECT_RED = redRectSvg(variant)
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const red = add(RECT_RED)
  const blank = add(BLANK_VEC)
  const blue = add(RECT_BLUE)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const project = {
    targets: [
      {
        isStage: false, name: 'VecA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(red, 'rect-red'), costume(blank, 'blank')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
      {
        isStage: false, name: 'VecB', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(blue, 'rect-blue')],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 80, y: 40, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'shape-selected-race-gate', agent: 'shape-selected-race-gate' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function buildGreenSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const green = add(RECT_GREEN)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const project = {
    targets: [
      {
        isStage: false, name: 'VecC', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0, costumes: [costume(green, 'rect-green')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'shape-selected-race-green', agent: 'shape-selected-race-green' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function log(label: string, value: unknown) {
  console.log(`[shape-race] ${label} ${JSON.stringify(value).slice(0, 2500)}`)
}

// --- page helpers -----------------------------------------------------------

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

async function waitForPreviewSvgChange(previous: string, timeout = 20_000) {
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, previous, { timeout })
}

async function waitForPreviewSvg(expected: string, timeout = 20_000) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML === svg, expected, { timeout })
}

async function bootId(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __gateBootId?: string }).__gateBootId ?? 'none')
}

async function assertNoReload(anchor: string, phase: string): Promise<void> {
  const id = await bootId()
  const prev = (globalThis as unknown as { __gateBootSeen?: string }).__gateBootSeen
  if (prev === undefined) {
    ;(globalThis as unknown as { __gateBootSeen?: string }).__gateBootSeen = id
    console.log(`BOOT ${anchor} id=${id} phase=${phase}`)
    return
  }
  console.log(`BOOT ${anchor} id=${id} phase=${phase}`)
  expect(id).toBe(prev) // a change here = foreign HMR/full-reload interference, reported loudly
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

async function selectionOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline].border-blue-500').count()
}

async function vectorShapeCount(): Promise<number> {
  return await page.evaluate(() => {
    const rootNode = document.querySelector('.vector-preview')
    if (!rootNode) return 0
    return rootNode.querySelectorAll('rect,ellipse,path,circle').length
  })
}

async function lastVectorShapeX(): Promise<number> {
  return await page.evaluate(() => {
    const rootNode = document.querySelector('.vector-preview')
    const shapes = rootNode ? Array.from(rootNode.querySelectorAll('rect,ellipse,path,circle')) : []
    const last = shapes[shapes.length - 1] as unknown as Element | undefined
    if (!last) return Number.NaN
    const tag = last.tagName.toLowerCase()
    if (tag === 'ellipse') return Number(last.getAttribute('cx') ?? Number.NaN)
    return Number(last.getAttribute('x') ?? Number.NaN)
  })
}

async function lastVectorShapeSize(): Promise<{ w: number; h: number; tag: string }> {
  return await page.evaluate(() => {
    const rootNode = document.querySelector('.vector-preview')
    const shapes = rootNode ? Array.from(rootNode.querySelectorAll('rect,ellipse,path,circle')) : []
    const last = shapes[shapes.length - 1] as unknown as Element | undefined
    if (!last) return { w: Number.NaN, h: Number.NaN, tag: 'none' }
    const tag = last.tagName.toLowerCase()
    if (tag === 'ellipse') {
      return { w: Number(last.getAttribute('rx') ?? Number.NaN) * 2, h: Number(last.getAttribute('ry') ?? Number.NaN) * 2, tag }
    }
    return { w: Number(last.getAttribute('width') ?? Number.NaN), h: Number(last.getAttribute('height') ?? Number.NaN), tag }
  })
}

function toolActiveClass(className: string | null): boolean {
  return (className ?? '').includes('text-white')
}

async function vectorToolActive(id: 'select' | 'rect' | 'oval'): Promise<boolean> {
  return toolActiveClass(await page.getByTestId(`vector-shape-${id}`).last().getAttribute('class'))
}

async function costumeMd5Of(targetName: string, index: number): Promise<string | null> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.name === targetName)
  return (target?.costumes[index]?.md5ext as string | undefined) ?? null
}

async function selectedCostumeMd5(): Promise<string | null> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.id === snap.selectedTargetId || t.name === snap.selectedTargetId)
  const index = target?.currentCostume ?? 0
  return (target?.costumes[index]?.md5ext as string | undefined) ?? null
}

async function metaOf(targetName: string, index: number) {
  return await page.evaluate(({ t, i }: { t: string; i: number }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const tgt = vm.getTarget(t)
    const c = tgt.costumes[i]
    return { name: c.name, res: c.bitmapResolution, rcx: c.rotationCenterX, rcy: c.rotationCenterY, fmt: c.dataFormat }
  }, { t: targetName, i: index })
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

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest
    return api?.status() ?? ''
  })
}

// Deferred `loadAsset` gate on the REAL VM instance (test-only page patch, no
// product edit). The shape-tool hit test awaits `currentSvgDocument` (a VM
// SVG load), so `next`/`all` deterministically hold the `vectorHitPromise`
// window open while the racing interrupt lands inside it.
async function installLoadGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for load-gate install')
    if (w.__shapeHitGate) return
    const orig = vm.loadAsset.bind(vm)
    const gate = (w.__shapeHitGate = { mode: 'off', ms: 500, calls: [] as Array<{ key: string }>, delayed: 0 })
    vm.loadAsset = async (...args: any[]) => {
      gate.calls.push({ key: String(args[0]) })
      if (gate.mode === 'all') {
        gate.delayed += 1
        await new Promise((r) => setTimeout(r, gate.ms))
      } else if (gate.mode === 'next') {
        gate.mode = 'off'
        gate.delayed += 1
        await new Promise((r) => setTimeout(r, gate.ms))
      }
      return orig(...args)
    }
  })
}

async function setLoadGate(mode: 'off' | 'all' | 'next', ms = 500) {
  await page.evaluate(({ m, delay }: { m: string; delay: number }) => {
    const w = window as unknown as Record<string, any>
    if (!w.__shapeHitGate) throw new Error('Load gate not installed')
    w.__shapeHitGate.mode = m
    w.__shapeHitGate.ms = delay
  }, { m: mode, delay: ms })
}

async function clearLoadGateCalls() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__shapeHitGate) w.__shapeHitGate.calls = []
  })
}

// Settle: gate off, then wait until no new VM loads land and the preview is
// stable across two polls (production-shape wait, never a blind sleep).
async function settle(timeout = 25_000) {
  await setLoadGate('off')
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, any>
    const calls = w.__shapeHitGate?.calls?.length ?? 0
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

// Stability re-check with per-poll asserts (NOT a hidden timeout): proves no
// delayed resolve lands after the verdict.
async function expectStable({
  svg, md5ext, pair, outlines, ms = 1000,
}: {
  svg: string; md5ext: string | null; pair: { undo: boolean; redo: boolean }; outlines: number; ms?: number
}) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    expect(await previewSvg()).toBe(svg)
    expect(await selectedCostumeMd5()).toBe(md5ext)
    expect(await undoRedoEnabled()).toEqual(pair)
    expect(await selectionOutlineCount()).toBe(outlines)
    await page.waitForTimeout(100)
  }
}

async function importSb3(bytes: Buffer, fileName: string, expectTarget: string, expectMd5?: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: fileName, mimeType: 'application/x.scratch.sb3', buffer: bytes })
  if (expectMd5 !== undefined) {
    // Deterministic new-project gate: the exact new bytes must be live (same
    // target names as the previous project can never satisfy this early).
    await page.waitForFunction(
      ({ want, md5ext }: { want: string; md5ext: string }) => {
        const snap = (window as any).__hikkakuEditorTest?.snapshot()
        const t = snap?.project.targets.find((x: any) => x.name === want)
        return t?.costumes[0]?.md5ext === md5ext
      },
      { want: expectTarget, md5ext: expectMd5 },
      { timeout: 30_000 },
    )
  } else {
    await page.waitForFunction(
      (want: string) => {
        const snap = (window as any).__hikkakuEditorTest?.snapshot()
        return snap?.project.targets.some((t: any) => t.name === want) ?? false
      },
      expectTarget,
      { timeout: 30_000 },
    )
  }
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
  // Forensics-first (log-only, never a pass): if the preview never settles,
  // the log below shows exactly which surface the editor is stuck on.
  try {
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 5_000 })
    return
  } catch {
    const diag = await page.evaluate(() => {
      const boxOf = (sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = (el as HTMLElement).getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      }
      let snapDiag: unknown = 'unavailable'
      try {
        const s = (window as any).__hikkakuEditorTest?.snapshot()
        snapDiag = {
          targets: s?.project.targets.map((t: any) => ({ name: t.name, costumes: t.costumes?.length, cur: t.currentCostume })),
          sel: s?.selectedTargetId,
        }
      } catch (e) {
        snapDiag = `snapshot-threw:${String(e).slice(0, 120)}`
      }
      return {
        surfaceBox: boxOf('[data-testid="costume-paint-surface"]'),
        bitmapCanvas: boxOf('[data-testid="bitmap-editor-canvas"]'),
        vectorPreview: boxOf('.vector-preview'),
        vectorPreviewHtml: document.querySelector('.vector-preview')?.innerHTML?.slice(0, 200) ?? null,
        status: (window as any).__hikkakuEditorTest?.status?.() ?? null,
        snap: snapDiag,
      }
    })
    log('ensureVectorMode diag (preview missing after 5s; still waiting loudly)', diag)
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 60_000 })
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

async function firePointer(selector: string, type: string, opts: { pointerId: number; clientX: number; clientY: number; buttons?: number }) {
  await page.evaluate(({ sel, t, o }: { sel: string; t: string; o: { pointerId: number; clientX: number; clientY: number; buttons?: number } }) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) throw new Error(`firePointer: missing ${sel}`)
    el.dispatchEvent(new PointerEvent(t, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: o.pointerId, pointerType: 'pen', button: 0, buttons: o.buttons ?? 0,
      clientX: o.clientX, clientY: o.clientY, isPrimary: true,
    }))
  }, { sel: selector, t: type, o: opts })
}

async function surfaceBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

async function guardCanvasPoint(p: { x: number; y: number }, label: string) {
  const hit = await page.evaluate(({ px, py }: { px: number; py: number }) => {
    const element = document.elementFromPoint(px, py)
    if (!element) return 'none'
    if ((element as HTMLElement).closest?.('[data-testid="costume-paint-surface"]')) return `canvas:${element.tagName}`
    const button = (element as HTMLElement).closest?.('button')
    if (button) return `button:${button.getAttribute('data-testid') ?? button.getAttribute('aria-label') ?? (button.textContent ?? '').slice(0, 30)}`
    return element.tagName
  }, { px: p.x, py: p.y })
  if (!hit.startsWith('canvas:')) {
    throw new Error(`INVALID: ${label} is off-canvas (hits ${hit} at ${p.x},${p.y}); refusing a misdirected press`)
  }
}

async function largestBlueOutline(): Promise<{ x: number; y: number; width: number; height: number }> {
  const handles = await page.locator('[data-vector-selection-outline].border-blue-500').elementHandles()
  if (handles.length === 0) throw new Error('selection outline missing')
  let best: { x: number; y: number; width: number; height: number } | undefined
  for (const handle of handles) {
    const box = await handle.boundingBox()
    if (!box) continue
    if (!best || box.width * box.height > best.width * best.height) best = box
  }
  if (!best) throw new Error('outline box missing')
  return best
}

// Select the red rect with the select tool and return its screen center.
async function selectRedRect(): Promise<{ x: number; y: number }> {
  await page.getByTestId('vector-shape-select').last().click()
  const box = await surfaceBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(
    () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 1,
    null,
    { timeout: 10_000 },
  )
  const outline = await largestBlueOutline()
  return { x: outline.x + outline.width / 2, y: outline.y + outline.height / 2 }
}

// A blank-surface point inside the VISIBLE artwork rect
// (preview ∩ surface), never the raw artwork box. Evidence 2026-11-12:
// the outer surface clips the edit surface under viewport scale/scroll,
// so a preview-relative 25%/30% press can sit outside the actually
// hittable canvas and elementFromPoint lands on chrome. The visible rect
// is the intersection of the live `.vector-preview` box and the
// `costume-paint-surface` box (both real bounding rects); every candidate
// press AND its planned drag end (+90/+50, the max over miss +90/+50,
// stress-B +80/+46, stress-C +70/+30) must sit strictly inside that
// visible rect AND hit the canvas via elementFromPoint. The press must
// additionally sit outside EVERY live vector-object rect (selected or
// not — real getBoundingClientRect, not just blue outlines) so the hit
// test deterministically misses. No silent fallback: if no candidate
// passes, throw INVALID instead of returning a noop-hiding point.
async function blankPoint(): Promise<{ x: number; y: number }> {
  const preview = page.locator('[data-testid="costume-paint-surface"] .vector-preview')
  await preview.first().waitFor({ state: 'visible', timeout: 10_000 })
  let surface = await surfaceBox()
  let r = await preview.first().boundingBox()
  let visible = { x: 0, y: 0, width: 0, height: 0 }
  const intersect = (
    s: { x: number; y: number; width: number; height: number },
    p: { x: number; y: number; width: number; height: number },
  ) => {
    const x0 = Math.max(s.x, p.x)
    const y0 = Math.max(s.y, p.y)
    const x1 = Math.min(s.x + s.width, p.x + p.width)
    const y1 = Math.min(s.y + s.height, p.y + p.height)
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
  }
  for (let i = 0; i < 8; i += 1) {
    surface = await surfaceBox()
    r = await preview.first().boundingBox()
    if (r) {
      visible = intersect(surface, r)
      // Need the full max drag (+90/+50) plus a 4px inset inside visible.
      if (visible.width >= 120 && visible.height >= 80) break
      log('blankPoint waiting for visible rect', { surface, preview: r, visible })
    }
    await page.waitForTimeout(400)
  }
  if (!r) throw new Error('INVALID: vector-preview bounds missing for blank press point')
  visible = intersect(surface, r)
  log('blankPoint boxes', { surface, preview: r, visible })
  if (visible.width < 120 || visible.height < 80) {
    throw new Error(`INVALID: preview∩surface visible rect too small for +90/+50 drag (${visible.width}x${visible.height}); refusing a clamped noop`)
  }
  // Preferred order keeps the legacy 25%/30% first (top-left blank for the
  // centered red rect), then nearby blank-corner fallbacks. Every candidate
  // is expressed in VISIBLE-rect fractions so press+end stay on the
  // actually hittable canvas even when the artwork is clipped/scaled.
  const fracs: Array<{ fx: number; fy: number }> = [
    { fx: 0.25, fy: 0.30 },
    { fx: 0.28, fy: 0.15 }, { fx: 0.22, fy: 0.12 }, { fx: 0.32, fy: 0.12 },
    { fx: 0.18, fy: 0.22 }, { fx: 0.32, fy: 0.22 }, { fx: 0.15, fy: 0.35 },
    { fx: 0.32, fy: 0.38 }, { fx: 0.18, fy: 0.45 },
    { fx: 0.68, fy: 0.20 }, { fx: 0.75, fy: 0.30 }, { fx: 0.68, fy: 0.62 },
    { fx: 0.22, fy: 0.62 }, { fx: 0.35, fy: 0.65 },
  ]
  const rects = await page.evaluate(() => {
    const q = (sel: string) => Array.from(document.querySelectorAll(sel)).map((el) => {
      const b = (el as HTMLElement).getBoundingClientRect()
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }
    })
    const surf = (document.querySelector('[data-testid="costume-paint-surface"]') as HTMLElement)?.getBoundingClientRect()
    const prev = (document.querySelector('[data-testid="costume-paint-surface"] .vector-preview') as HTMLElement)?.getBoundingClientRect()
    return {
      objects: q('[data-vector-object]'),
      selections: q('[data-vector-selection-outline].border-blue-500'),
      allOutlines: q('[data-vector-selection-outline]'),
      surface: surf ? { l: surf.left, t: surf.top, r: surf.right, b: surf.bottom } : null,
      preview: prev ? { l: prev.left, t: prev.top, r: prev.right, b: prev.bottom } : null,
    }
  })
  log('blankPoint live rects', rects)
  const insideAny = (px: number, py: number, list: Array<{ l: number; t: number; r: number; b: number }>, pad = 0.5) =>
    list.some((b) => px >= b.l - pad && px <= b.r + pad && py >= b.t - pad && py <= b.b + pad)
  const allBlockers = [...rects.objects, ...rects.allOutlines]
  for (const { fx, fy } of fracs) {
    const p = { x: visible.x + visible.width * fx, y: visible.y + visible.height * fy }
    const end = { x: p.x + 90, y: p.y + 50 }
    // Both press and planned end must sit strictly inside the visible
    // intersection (2px inset) — otherwise the drag clamps at the SVG edge
    // and commits a sliver (90x3.68 precedent), hiding a noop as a pass.
    const inVisible =
      p.x > visible.x + 2 && p.y > visible.y + 2 &&
      end.x < visible.x + visible.width - 2 && end.y < visible.y + visible.height - 2
    if (!inVisible) continue
    // Press needs real clearance (14px) from every object/handle/outline
    // rect: a 0.5px edge miss still hit-tests as a selection grab (stress-B
    // precedent: 3px above the outline resolved as a move, count stayed 1).
    // The drag end may land anywhere — only its visible-canvas hit matters.
    if (insideAny(p.x, p.y, allBlockers, 14)) continue
    try {
      await guardCanvasPoint(p, `blank press candidate ${fx}/${fy}`)
      await guardCanvasPoint(end, `blank drag end candidate ${fx}/${fy}`)
    } catch {
      continue
    }
    // Real-bounding-rect re-verify against live DOM rects (surface∩preview).
    const liveOk = await page.evaluate(({ px, py, ex, ey }: { px: number; py: number; ex: number; ey: number }) => {
      const s = (document.querySelector('[data-testid="costume-paint-surface"]') as HTMLElement)?.getBoundingClientRect()
      const pv = (document.querySelector('[data-testid="costume-paint-surface"] .vector-preview') as HTMLElement)?.getBoundingClientRect()
      if (!s || !pv) return false
      const vx0 = Math.max(s.left, pv.left)
      const vy0 = Math.max(s.top, pv.top)
      const vx1 = Math.min(s.right, pv.right)
      const vy1 = Math.min(s.bottom, pv.bottom)
      const inV = (x: number, y: number) => x > vx0 + 2 && y > vy0 + 2 && x < vx1 - 2 && y < vy1 - 2
      if (!inV(px, py) || !inV(ex, ey)) return false
      const hit = (x: number, y: number) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        return !!el?.closest?.('[data-testid="costume-paint-surface"]')
      }
      return hit(px, py) && hit(ex, ey)
    }, { px: p.x, py: p.y, ex: end.x, ey: end.y })
    if (!liveOk) continue
    log('blankPoint', { surface: await surfaceBox(), preview: r, visible, p, end, fx, fy, blockerCount: allBlockers.length })
    return p
  }
  throw new Error(`INVALID: no blank candidate inside preview∩surface visible rect (${JSON.stringify(visible)}) sits outside ${allBlockers.length} object/selection rects with +90/+50 fully visible; refusing an ambiguous/clamped press`)
}

describe('vector shape-tool selected-drag race gate (new test, no product change)', () => {
  beforeAll(async () => {
    try {
      const files = [
        'src/Editor.svelte',
        'src/features/CostumeEditor/BitmapEditor.svelte',
        'src/features/costumes/shape-drag.ts',
      ]
      console.log(
        `PROVENANCE ${JSON.stringify(files.map((f) => { try { const st = statSync(join(root, f)); return { f, size: st.size, mtime: st.mtime.toISOString() } } catch { return { f, missing: true } } }))}`,
      )
    } catch { /* provenance is log-only */ }
    server = spawn('bun', ['x', 'vite', '--config', 'vite.gate.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 120; i += 1) {
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
    // HMR tripwire: with the watcher disabled no reload may occur mid-run.
    await page.addInitScript(() => {
      ;(window as unknown as { __gateBootId?: string }).__gateBootId = Math.random().toString(36).slice(2)
    })
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installPidListener()
    await installLoadGate()
  }, 120_000)

  afterAll(async () => {
    try {
      await setLoadGate('off')
    } catch {}
    await browser?.close()
    server?.kill()
  })

  it('hit on the live selection moves under the same rect tool with exactly one undo entry', async () => {
    await assertNoReload('shape-race', 'hit-move start')
    await importSb3(buildSb3(0), 'shape-race.sb3', 'VecA', redMd5(0))
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const center = await selectRedRect()
    const beforeSvg = await previewSvg()
    const beforeMd5 = await selectedCostumeMd5()
    const beforeMeta = await metaOf('VecA', 0)
    const beforeBytes = await svgBytesOf('VecA', 0)
    const pairBefore = await undoRedoEnabled()
    const otherMd5Before = await costumeMd5Of('VecB', 0)
    const otherBytesBefore = await svgBytesOf('VecB', 0)
    const xBefore = await lastVectorShapeX()
    expect(Number.isFinite(xBefore)).toBe(true)
    log('hit-move setup', { beforeMd5, pairBefore, xBefore })

    // Retained shape tool: press on the live selection moves it (no re-click
    // on the tool button needed after selection).
    await page.getByTestId('vector-shape-rect').last().click()
    expect(await vectorToolActive('rect')).toBe(true)
    expect(await selectionOutlineCount()).toBeGreaterThanOrEqual(1)
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.move(center.x + 70, center.y + 12, { steps: 12 })
    await page.mouse.up()
    await waitForPreviewSvgChange(beforeSvg)
    await settle()
    await assertNoReload('shape-race', 'hit-move settled')

    const movedSvg = await previewSvg()
    const movedMd5 = await selectedCostumeMd5()
    const movedMeta = await metaOf('VecA', 0)
    const movedBytes = await svgBytesOf('VecA', 0)
    const xMoved = await lastVectorShapeX()
    const pairAfter = await undoRedoEnabled()
    log('hit-move outcome', { beforeMd5, movedMd5, xBefore, xMoved, pairBefore, pairAfter, status: await editorStatus(), beforeMeta, movedMeta })
    // Move, not a new shape: count stays 1 and the artwork shifts right.
    expect(await vectorShapeCount()).toBe(1)
    expect(xMoved).toBeGreaterThan(xBefore)
    expect(movedSvg).not.toBe(beforeSvg)
    expect(movedMd5).not.toBe(beforeMd5)
    // Cross-asset guard: VecB bytes/meta untouched.
    expect(await costumeMd5Of('VecB', 0)).toBe(otherMd5Before)
    expect(await svgBytesOf('VecB', 0)).toBe(otherBytesBefore)
    // Tight-crop rotationCenter (product `vectorRuntimeCostume` for sprites):
    // a move re-trims viewBox to floor(min-2)/ceil(max+2) and stores
    // rcx=240-left, rcy=180-top, so 240/180 -> 67/58 is EXPECTED here, not a
    // regression. Evidence 2026-11-12: before rect 150,120,140,110 in
    // 480x360/0,0,480,360; after rect 175.56524,124.38263,140,110 in
    // 145x115/173,122,145,115 with rcx 67 = 240-173, rcy 58 = 180-122.
    // Verify stage placement, geometry, and dimensions instead of blind meta
    // equality: name/res/format stable, rect w/h preserved, rect shifted
    // right/down, viewBox/rotationCenter follow the tight-crop formula.
    expect(movedMeta.name).toBe(beforeMeta.name)
    expect(movedMeta.res).toBe(beforeMeta.res)
    expect(movedMeta.fmt).toBe(beforeMeta.fmt)
    const geom = await page.evaluate((svgText: string) => {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const svg = doc.documentElement
      const rect = svg.querySelector('rect')
      return {
        svgW: svg.getAttribute('width'), svgH: svg.getAttribute('height'), vb: svg.getAttribute('viewBox'),
        x: rect ? Number(rect.getAttribute('x')) : Number.NaN,
        y: rect ? Number(rect.getAttribute('y')) : Number.NaN,
        w: rect ? Number(rect.getAttribute('width')) : Number.NaN,
        h: rect ? Number(rect.getAttribute('height')) : Number.NaN,
      }
    }, movedBytes)
    log('hit-move geometry', geom)
    expect(geom.w).toBe(140)
    expect(geom.h).toBe(110)
    expect(geom.x).toBeGreaterThan(150)
    expect(geom.y).toBeGreaterThan(120)
    expect(Math.abs(geom.x - xMoved)).toBeLessThan(1e-6)
    const vb = String(geom.vb ?? '').trim().split(/\s+/).map(Number)
    expect(vb.length).toBe(4)
    expect(Number(geom.svgW)).toBe(vb[2])
    expect(Number(geom.svgH)).toBe(vb[3])
    expect(movedMeta.rcx).toBe(240 - vb[0])
    expect(movedMeta.rcy).toBe(180 - vb[1])
    expect(movedBytes).toContain('#e74c3c')
    expect(beforeBytes).toContain('#e74c3c')
    // Tool retention: rect stays armed, select never takes over, and the
    // moved shape stays selected.
    expect(await vectorToolActive('rect')).toBe(true)
    expect(await vectorToolActive('select')).toBe(false)
    expect(await selectionOutlineCount()).toBeGreaterThanOrEqual(1)
    expect(pairAfter.undo).toBe(true)
    // Exactly one history entry: a single Undo restores the baseline bytes,
    // and Redo re-applies the moved bytes (an intermediate entry would fail
    // the first equality). Evidence 2026-11-12: the VM reissues short asset
    // ids on edit/undo (moved 639df590.svg, undone 19bd0c3d.svg vs original
    // 749a…), while bytes round-trip byte-exact (md5calc 749a… both ways).
    // So the strict verdict is bytes + preview + geometry + history, never
    // blind md5ext string equality.
    await clearLoadGateCalls()
    await clickUndoVisible()
    await waitForPreviewSvg(beforeSvg)
    const undoneBytes = await svgBytesOf('VecA', 0)
    const undoneMd5 = await selectedCostumeMd5()
    log('hit-move undone', { undoneMd5, beforeMd5, bytesEqual: undoneBytes === beforeBytes })
    expect(undoneBytes).toBe(beforeBytes)
    // Undo restores the pre-move baseline metadata byte-exact (240/180).
    expect(await metaOf('VecA', 0)).toEqual(beforeMeta)
    expect(await vectorToolActive('rect')).toBe(true)
    await clickRedoVisible()
    await waitForPreviewSvg(movedSvg)
    const redoneBytes = await svgBytesOf('VecA', 0)
    const redoneMd5 = await selectedCostumeMd5()
    log('hit-move redone', { redoneMd5, movedMd5, bytesEqual: redoneBytes === movedBytes })
    expect(redoneBytes).toBe(movedBytes)
    // Redo re-applies the tight-cropped move metadata byte-exact.
    expect(await metaOf('VecA', 0)).toEqual(movedMeta)
    expect(await vectorToolActive('rect')).toBe(true)
    // Stability: no delayed second write lands after the verdict (redo may
    // reissue the short asset id, so stability tracks the redone id).
    await expectStable({ svg: movedSvg, md5ext: redoneMd5, pair: await undoRedoEnabled(), outlines: await selectionOutlineCount() })
    log('hit-move done', { movedMd5, redoneMd5 })
  }, 180_000)

  it('miss on blank canvas starts the fresh shape from the latest pointer (not the press)', async () => {
    await assertNoReload('shape-race', 'miss-last-point start')
    await importSb3(buildSb3(1), 'shape-race-miss.sb3', 'VecA', redMd5(1))
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    // Blank costume: no selection, so the press must miss.
    await page.getByRole('button', { name: 'Select blank' }).first().click()
    await page.waitForTimeout(900)
    expect(await vectorShapeCount()).toBe(0)
    const beforeSvg = await previewSvg()
    const beforeMd5 = await costumeMd5Of('VecA', 1)
    const beforeBytes = await svgBytesOf('VecA', 1)
    const pairBefore = await undoRedoEnabled()
    const redMd5Before = await costumeMd5Of('VecA', 0)
    const otherMd5Before = await costumeMd5Of('VecB', 0)

    await page.getByTestId('vector-shape-oval').last().click()
    expect(await vectorToolActive('oval')).toBe(true)
    const p0 = await blankPoint()
    // Hold the hit test open so both moves land BEFORE the resolve: the miss
    // fallback must draw from the latest pointer (p2), not the press (p0).
    // A press-point fallback would see a zero-size draft and discard (count
    // stays 0) — this leg fails loudly in that case.
    await setLoadGate('next', 600)
    await page.mouse.move(p0.x, p0.y)
    await page.mouse.down()
    await page.mouse.move(p0.x + 40, p0.y + 22, { steps: 4 })
    await page.mouse.move(p0.x + 90, p0.y + 50, { steps: 6 })
    await page.mouse.up()
    await waitForPreviewSvgChange(beforeSvg)
    await settle()
    await assertNoReload('shape-race', 'miss-last-point settled')

    const afterSvg = await previewSvg()
    const afterMd5 = await costumeMd5Of('VecA', 1)
    const size = await lastVectorShapeSize()
    const pairAfter = await undoRedoEnabled()
    const afterBytes = await svgBytesOf('VecA', 1)
    // Selected-target / tool / scaling trace: blank VecA costume under the
    // oval tool with the pending `next` hit held open; both moves land before
    // the resolve so the miss fallback must use the latest pointer (p2), with
    // release-time modifiers owning the rect (no Shift here).
    const trace = await page.evaluate(() => {
      const snap = (window as any).__hikkakuEditorTest?.snapshot()
      const t = snap?.project.targets.find((x: any) => x.name === 'VecA')
      return {
        selected: snap?.selectedTargetId, currentCostume: t?.currentCostume,
        tool: document.querySelector('[data-testid="vector-shape-oval"]')?.className?.slice(0, 120) ?? null,
        previewBox: (document.querySelector('.vector-preview') as HTMLElement)?.getBoundingClientRect?.(),
        gate: (window as any).__shapeHitGate ? { mode: (window as any).__shapeHitGate.mode, delayed: (window as any).__shapeHitGate.delayed, calls: (window as any).__shapeHitGate.calls?.length } : null,
      }
    })
    log('miss-last-point outcome', { size, pairBefore, pairAfter, status: await editorStatus(), p0, trace, afterBytesHead: afterBytes.slice(0, 400) })
    expect(afterSvg).not.toBe(beforeSvg)
    expect(afterMd5).not.toBe(beforeMd5)
    // The committed ellipse spans the full press->latest-pointer drag: a
    // press-point fallback would have discarded (zero area, count 0), and a
    // clamped/out-of-artwork drag would collapse one axis (evidence: outer
    // 15%/82% press gave 90x3.68 via y=360 clamp). Strict box: ~90x50.
    expect(await vectorShapeCount()).toBe(1)
    expect(size.tag).toBe('ellipse')
    expect(size.w).toBeGreaterThan(60)
    expect(size.w).toBeLessThan(120)
    expect(size.h).toBeGreaterThan(30)
    expect(size.h).toBeLessThan(70)
    expect(Math.abs(size.w / Math.max(1e-9, size.h) - 90 / 50)).toBeLessThan(0.6)
    // Miss clears the (empty) selection then selects only the new shape
    // under the same oval tool.
    expect(await vectorToolActive('oval')).toBe(true)
    expect(await selectionOutlineCount()).toBeGreaterThanOrEqual(1)
    expect(pairAfter.undo).toBe(true)
    // Old/new asset guard: the red costume and VecB are byte-identical.
    expect(await costumeMd5Of('VecA', 0)).toBe(redMd5Before)
    expect(await costumeMd5Of('VecB', 0)).toBe(otherMd5Before)
    // Single undo entry round-trips the fresh shape (bytes-strict: the VM
    // reissues short ids on undo/redo, so md5ext strings are logged, not
    // asserted blindly).
    await clickUndoVisible()
    await waitForPreviewSvg(beforeSvg)
    const undoneBytes = await svgBytesOf('VecA', 1)
    log('miss-last-point undone', { undoneMd5: await costumeMd5Of('VecA', 1), beforeMd5, bytesEqual: undoneBytes === beforeBytes })
    expect(undoneBytes).toBe(beforeBytes)
    await clickRedoVisible()
    await waitForPreviewSvg(afterSvg)
    const redoneBytes = await svgBytesOf('VecA', 1)
    const redoneMd5 = await costumeMd5Of('VecA', 1)
    log('miss-last-point redone', { redoneMd5, afterMd5, bytesEqual: redoneBytes === afterBytes })
    expect(redoneBytes).toBe(afterBytes)
    await expectStable({ svg: afterSvg, md5ext: redoneMd5, pair: await undoRedoEnabled(), outlines: await selectionOutlineCount() })
    // Leave the blank costume clean (redo state kept) for later legs that
    // re-import anyway.
    log('miss-last-point done', { afterMd5 })
  }, 180_000)

  it('pointerup / pointercancel / lostpointercapture racing the pending hit never commit', async () => {
    await assertNoReload('shape-race', 'cancel-race start')
    await importSb3(buildSb3(2), 'shape-race-cancel.sb3', 'VecA', redMd5(2))
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)

    // Sub-case A: pointerup lands before the hit resolves (fast click, slow
    // hit). A click on the selection with no drag is a no-op move: no
    // history, selection preserved, tool retained.
    {
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      const beforeSvg = await previewSvg()
      const beforeMd5 = await selectedCostumeMd5()
      const pairBefore = await undoRedoEnabled()
      const outlinesBefore = await selectionOutlineCount()
      await setLoadGate('next', 600)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.up()
      await settle()
      await assertNoReload('shape-race', 'cancel-race pointerup settled')
      const afterSvg = await previewSvg()
      const afterMd5 = await selectedCostumeMd5()
      const pairAfter = await undoRedoEnabled()
      log('cancel-race pointerup', { beforeMd5, afterMd5, pairBefore, pairAfter })
      expect(afterSvg).toBe(beforeSvg)
      expect(afterMd5).toBe(beforeMd5)
      expect(pairAfter).toEqual(pairBefore)
      expect(await vectorToolActive('rect')).toBe(true)
      expect(await selectionOutlineCount()).toBe(outlinesBefore)
      await expectStable({ svg: afterSvg, md5ext: afterMd5, pair: pairAfter, outlines: outlinesBefore })
    }

    // Sub-case B: pointercancel mid-press (with a real move) restores the
    // pre-press snapshot with no history; the stale release is a no-op.
    {
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      const beforeSvg = await previewSvg()
      const beforeMd5 = await selectedCostumeMd5()
      const beforeBytes = await svgBytesOf('VecA', 0)
      const pairBefore = await undoRedoEnabled()
      const outlinesBefore = await selectionOutlineCount()
      await setLoadGate('next', 600)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.move(center.x + 55, center.y + 10, { steps: 6 })
      const pid = await lastPointerId()
      await firePointer('[data-testid="costume-paint-surface"]', 'pointercancel', { pointerId: pid, clientX: center.x + 55, clientY: center.y + 10 })
      await page.mouse.up()
      await settle()
      await assertNoReload('shape-race', 'cancel-race pointercancel settled')
      const afterSvg = await previewSvg()
      const afterMd5 = await selectedCostumeMd5()
      const pairAfter = await undoRedoEnabled()
      log('cancel-race pointercancel', { beforeMd5, afterMd5, pairBefore, pairAfter, status: await editorStatus() })
      expect(afterSvg).toBe(beforeSvg)
      expect(afterMd5).toBe(beforeMd5)
      expect(await svgBytesOf('VecA', 0)).toBe(beforeBytes)
      expect(pairAfter).toEqual(pairBefore)
      expect(await vectorToolActive('rect')).toBe(true)
      expect(await selectionOutlineCount()).toBe(outlinesBefore)
      await expectStable({ svg: afterSvg, md5ext: afterMd5, pair: pairAfter, outlines: outlinesBefore })
    }

    // Sub-case C: genuine capture loss without a preceding pointercancel
    // cancels too (only the implicit auto-loss trailing a normal pointerup is
    // exempt — that path is covered by the hit-move leg).
    {
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      const beforeSvg = await previewSvg()
      const beforeMd5 = await selectedCostumeMd5()
      const pairBefore = await undoRedoEnabled()
      const outlinesBefore = await selectionOutlineCount()
      await setLoadGate('next', 600)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.move(center.x + 50, center.y + 8, { steps: 6 })
      const pid = await lastPointerId()
      await firePointer('[data-testid="costume-paint-surface"]', 'lostpointercapture', { pointerId: pid, clientX: center.x + 50, clientY: center.y + 8 })
      await page.mouse.up()
      await settle()
      await assertNoReload('shape-race', 'cancel-race lostpointercapture settled')
      const afterSvg = await previewSvg()
      const afterMd5 = await selectedCostumeMd5()
      const pairAfter = await undoRedoEnabled()
      log('cancel-race lostpointercapture', { beforeMd5, afterMd5, pairBefore, pairAfter, status: await editorStatus() })
      expect(afterSvg).toBe(beforeSvg)
      expect(afterMd5).toBe(beforeMd5)
      expect(pairAfter).toEqual(pairBefore)
      expect(await vectorToolActive('rect')).toBe(true)
      expect(await selectionOutlineCount()).toBe(outlinesBefore)
      await expectStable({ svg: afterSvg, md5ext: afterMd5, pair: pairAfter, outlines: outlinesBefore })
    }
  }, 240_000)

  it('Escape racing the pending hit clears the selection but writes nothing', async () => {
    await assertNoReload('shape-race', 'escape-race start')
    await importSb3(buildSb3(3), 'shape-race-escape.sb3', 'VecA', redMd5(3))
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const center = await selectRedRect()
    await page.getByTestId('vector-shape-rect').last().click()
    const beforeSvg = await previewSvg()
    const beforeMd5 = await selectedCostumeMd5()
    const beforeBytes = await svgBytesOf('VecA', 0)
    const pairBefore = await undoRedoEnabled()
    const otherMd5Before = await costumeMd5Of('VecB', 0)
    expect(await selectionOutlineCount()).toBeGreaterThanOrEqual(1)

    // Escape owns deselect by design: the selection clears, but the stale
    // hit resolve must NOT start a move drag or resurrect the selection.
    await setLoadGate('next', 600)
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.move(center.x + 45, center.y + 8, { steps: 5 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await settle()
    await assertNoReload('shape-race', 'escape-race settled')

    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    log('escape-race', { beforeMd5, afterMd5, pairBefore, pairAfter, status: await editorStatus() })
    expect(afterSvg).toBe(beforeSvg)
    expect(afterMd5).toBe(beforeMd5)
    expect(await svgBytesOf('VecA', 0)).toBe(beforeBytes)
    expect(pairAfter).toEqual(pairBefore)
    // VecB untouched; rect stays armed; selection stays cleared (Escape owns
    // it — the stale resolve must not bring it back).
    expect(await costumeMd5Of('VecB', 0)).toBe(otherMd5Before)
    expect(await vectorToolActive('rect')).toBe(true)
    expect(await selectionOutlineCount()).toBe(0)
    expect(await vectorShapeCount()).toBe(1)
    await expectStable({ svg: afterSvg, md5ext: afterMd5, pair: pairAfter, outlines: 0 })
  }, 180_000)

  it('target and costume switches racing the pending hit keep both assets byte-identical', async () => {
    await assertNoReload('shape-race', 'switch-race start')
    await importSb3(buildSb3(4), 'shape-race-switch.sb3', 'VecA', redMd5(4))
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)

    // Sub-case A: mid-press target switch. The stale release over the new
    // target must be a no-op; both assets stay byte-identical; history is
    // cleared by the switch and stays cleared.
    {
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      const oldMd5Pre = await costumeMd5Of('VecA', 0)
      const oldBytesPre = await svgBytesOf('VecA', 0)
      const oldMetaPre = await metaOf('VecA', 0)
      const newMd5Pre = await costumeMd5Of('VecB', 0)
      const newBytesPre = await svgBytesOf('VecB', 0)
      const newMetaPre = await metaOf('VecB', 0)
      await setLoadGate('next', 600)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.move(center.x + 55, center.y + 8, { steps: 5 })
      // Real app switch through the keyboard route (pointer is captured).
      const card = page.getByTestId('target-card-VecB')
      await card.focus()
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        () => {
          const snap = (window as any).__hikkakuEditorTest?.snapshot()
          const t = snap?.project.targets.find((x: any) => x.id === snap?.selectedTargetId || x.name === snap?.selectedTargetId)
          return t?.name === 'VecB'
        },
        null,
        { timeout: 10_000 },
      )
      const pairAtSwitch = await undoRedoEnabled()
      // Stale release over the new target: must be a no-op.
      await page.mouse.up()
      await settle()
      await assertNoReload('shape-race', 'switch-race target settled')
      const pairAfter = await undoRedoEnabled()
      const newMd5After = await costumeMd5Of('VecB', 0)
      const newBytesAfter = await svgBytesOf('VecB', 0)
      log('switch-race target', { oldMd5Pre, newMd5Pre, newMd5After, pairAtSwitch, pairAfter })
      expect(newMd5After).toBe(newMd5Pre)
      expect(newBytesAfter).toBe(newBytesPre)
      expect(await metaOf('VecB', 0)).toEqual(newMetaPre)
      expect(pairAtSwitch).toEqual({ undo: false, redo: false })
      expect(pairAfter).toEqual({ undo: false, redo: false })
      // Back on the old asset: the pre-press snapshot is intact.
      await page.getByTestId('target-card-VecA').click()
      await page.waitForTimeout(900)
      expect(await costumeMd5Of('VecA', 0)).toBe(oldMd5Pre)
      expect(await svgBytesOf('VecA', 0)).toBe(oldBytesPre)
      expect(await metaOf('VecA', 0)).toEqual(oldMetaPre)
      expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
    }

    // Sub-case B: mid-press costume switch (VecA rect-red -> blank).
    {
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      const oldMd5Pre = await costumeMd5Of('VecA', 0)
      const oldBytesPre = await svgBytesOf('VecA', 0)
      const newMd5Pre = await costumeMd5Of('VecA', 1)
      const newBytesPre = await svgBytesOf('VecA', 1)
      await setLoadGate('next', 600)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.move(center.x + 55, center.y + 8, { steps: 5 })
      await page.getByRole('button', { name: 'Select blank' }).first().focus()
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        () => {
          const snap = (window as any).__hikkakuEditorTest?.snapshot()
          const t = snap?.project.targets.find((x: any) => x.name === 'VecA')
          return (t?.currentCostume ?? -1) === 1
        },
        null,
        { timeout: 10_000 },
      )
      const pairAtSwitch = await undoRedoEnabled()
      await page.mouse.up()
      await settle()
      await assertNoReload('shape-race', 'switch-race costume settled')
      const pairAfter = await undoRedoEnabled()
      log('switch-race costume', { oldMd5Pre, newMd5Pre, pairAtSwitch, pairAfter })
      expect(await costumeMd5Of('VecA', 1)).toBe(newMd5Pre)
      expect(await svgBytesOf('VecA', 1)).toBe(newBytesPre)
      expect(pairAtSwitch).toEqual({ undo: false, redo: false })
      expect(pairAfter).toEqual({ undo: false, redo: false })
      await page.getByRole('button', { name: 'Select rect-red' }).first().click()
      await page.waitForTimeout(900)
      expect(await costumeMd5Of('VecA', 0)).toBe(oldMd5Pre)
      expect(await svgBytesOf('VecA', 0)).toBe(oldBytesPre)
      expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
    }
  }, 240_000)

  it('project replacement, next pointerdown, modifier flip, external write and double-click stay gated', async () => {
    await assertNoReload('shape-race', 'stress-race start')
    await importSb3(buildSb3(5), 'shape-race-stress.sb3', 'VecA', redMd5(5))
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)

    // Sub-case A: project replacement while the hit is pending. The stale
    // resolve belongs to the replaced project and must never write into the
    // new one (no extra shape, no history, new bytes intact).
    {
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      const greenBytes = new TextEncoder().encode(RECT_GREEN)
      const greenMd5 = `${md5(greenBytes)}.svg`
      await setLoadGate('next', 800)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.move(center.x + 50, center.y + 8, { steps: 4 })
      await page.getByTestId('project-file-input').setInputFiles({ name: 'green.sb3', mimeType: 'application/x.scratch.sb3', buffer: buildGreenSb3() })
      await page.waitForFunction(
        (want: string) => {
          const snap = (window as any).__hikkakuEditorTest?.snapshot()
          return snap?.project.targets.some((t: any) => t.name === want) ?? false
        },
        'VecC',
        { timeout: 30_000 },
      )
      await page.mouse.up()
      await settle()
      await assertNoReload('shape-race', 'stress-race project settled')
      const snap = await snapshot()
      log('stress-race project', { targets: snap.project.targets.map((t: any) => t.name), selected: snap.selectedTargetId })
      // Exact project (not weak): Scratch always keeps Stage alongside the
      // imported sprite. Evidence 2026-11-12: after green.sb3 the VM owns
      // [Stage(stage/backdrop1/cd21514d…/240,180), VecC(sprite0/rect-green/
      // 31b53c76…/240,180)] with VecC selected and empty history.
      expect(snap.project.targets.map((t: any) => t.name).sort()).toEqual(['Stage', 'VecC'])
      expect(snap.project.targets.length).toBe(2)
      const stageT = snap.project.targets.find((t: any) => t.name === 'Stage')
      const vecCT = snap.project.targets.find((t: any) => t.name === 'VecC')
      expect(stageT?.isStage).toBe(true)
      expect(vecCT?.isStage).toBe(false)
      expect(vecCT?.costumes?.length).toBe(1)
      expect(vecCT?.costumes[0]?.name).toBe('rect-green')
      const selectedT = snap.project.targets.find((t: any) => t.id === snap.selectedTargetId || t.name === snap.selectedTargetId)
      expect(selectedT?.name).toBe('VecC')
      expect(await costumeMd5Of('VecC', 0)).toBe(greenMd5)
      expect(await svgBytesOf('VecC', 0)).toBe(RECT_GREEN)
      // Stage (required, not an extra write): default backdrop intact.
      // Evidence 2026-11-12: Stage costumes carry no bitmapResolution
      // (undefined), unlike sprite costumes (res 1) — assert exactly that.
      expect(stageT?.costumes?.length).toBe(1)
      expect(stageT?.costumes[0]?.name).toBe('backdrop1')
      expect(await costumeMd5Of('Stage', 0)).toBe('cd21514d0531fdffb22204e0ec5ed84a.svg')
      expect(await svgBytesOf('Stage', 0)).toBe(`${HEAD}</svg>`)
      expect(await metaOf('Stage', 0)).toEqual({ name: 'backdrop1', res: undefined, rcx: 240, rcy: 180, fmt: 'svg' })
      expect(await metaOf('VecC', 0)).toEqual({ name: 'rect-green', res: 1, rcx: 240, rcy: 180, fmt: 'svg' })
      expect(await vectorShapeCount()).toBe(1)
      expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
      // Restore the race project for the remaining sub-cases.
      await importSb3(buildSb3(6), 'shape-race.sb3', 'VecA', redMd5(6))
      await ensureVectorMode()
      await page.getByTestId('target-card-VecA').click()
      await page.waitForTimeout(600)
    }

    // Sub-case B: the next pointerdown before the first resolve. First press
    // is a click (no drag => no history); the second press miss-drags a new
    // shape. Exactly one history entry total proves the first gesture wrote
    // nothing and the second wrote once (no torn double commit).
    // Sub-case B: the next pointerdown before the first resolve. Press #1 is
    // a click on the live selection (its hit is held 800ms by the gate, so
    // its release handler is still awaiting when press #2 starts); press #2
    // is a blank-corner miss-drag. The first gesture resolves to a zero-move
    // delegated drag (no history) and the second commits exactly one fresh
    // shape: one Undo must restore the red-only baseline (a torn double
    // commit would leave an intermediate entry and fail the first equality).
    {
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      expect(await vectorShapeCount()).toBe(1)
      const beforeSvg = await previewSvg()
      const beforeMd5 = await costumeMd5Of('VecA', 0)
      const beforeBytes = await svgBytesOf('VecA', 0)
      const r = await blankPoint()
      await setLoadGate('next', 800)
      // Press #1: click on the selection (down+up, no move). The release
      // awaits the held hit, so the test's next dispatches overlap it.
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.up()
      // Press #2 before the first resolve: a real miss-drag elsewhere.
      await page.mouse.move(r.x, r.y)
      await page.mouse.down()
      await page.mouse.move(r.x + 80, r.y + 46, { steps: 8 })
      await page.mouse.up()
      await waitForPreviewSvgChange(beforeSvg)
      await settle()
      await assertNoReload('shape-race', 'stress-race next-down settled')
      // One fresh shape beside the red rect (move, not a duplicate stamp).
      expect(await vectorShapeCount()).toBe(2)
      const afterSvg = await previewSvg()
      const afterMd5 = await costumeMd5Of('VecA', 0)
      const afterBytes = await svgBytesOf('VecA', 0)
      expect(afterSvg).not.toBe(beforeSvg)
      expect(afterMd5).not.toBe(beforeMd5)
      expect(await vectorToolActive('rect')).toBe(true)
      // Exactly one entry: one Undo restores the red-only baseline bytes with
      // nothing left to undo (a torn first-gesture commit would fail here).
      // NOTE: bytes-strict, never blind md5ext string equality — the VM
      // reissues short asset ids on edit/undo (hit-move precedent: moved
      // 639df590.svg, undone 19bd0c3d.svg vs original 749a… with byte-exact
      // round-trip), so md5ext is logged, not asserted.
      await clickUndoVisible()
      await waitForPreviewSvg(beforeSvg)
      const undoneBytes = await svgBytesOf('VecA', 0)
      const undoneMd5 = await costumeMd5Of('VecA', 0)
      log('stress-race next-down undone', { undoneMd5, beforeMd5, bytesEqual: undoneBytes === beforeBytes })
      expect(undoneBytes).toBe(beforeBytes)
      expect(await vectorShapeCount()).toBe(1)
      expect(await undoRedoEnabled()).toEqual({ undo: false, redo: true })
      await clickRedoVisible()
      await waitForPreviewSvg(afterSvg)
      const redoneBytes = await svgBytesOf('VecA', 0)
      const redoneMd5 = await costumeMd5Of('VecA', 0)
      log('stress-race next-down redone', { redoneMd5, afterMd5, bytesEqual: redoneBytes === afterBytes })
      expect(redoneBytes).toBe(afterBytes)
      await expectStable({ svg: afterSvg, md5ext: redoneMd5, pair: await undoRedoEnabled(), outlines: await selectionOutlineCount() })
      // Undo again so later sub-cases start from the red-only baseline.
      await clickUndoVisible()
      await waitForPreviewSvg(beforeSvg)
      expect(await svgBytesOf('VecA', 0)).toBe(beforeBytes)
    }

    // Sub-case C: modifier flip mid-flight. Press with no modifiers, hold
    // Shift before release: the miss draft commits squared (release-time
    // modifiers own the rect, matching the drag-live modifier tracking).
    {
      await page.getByTestId('vector-shape-rect').last().click()
      const beforeSvg = await previewSvg()
      const p = await blankPoint()
      await setLoadGate('next', 600)
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.keyboard.down('Shift')
      await page.mouse.move(p.x + 70, p.y + 30, { steps: 8 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await waitForPreviewSvgChange(beforeSvg)
      await settle()
      await assertNoReload('shape-race', 'stress-race modifiers settled')
      const size = await lastVectorShapeSize()
      log('stress-race modifiers', { size })
      expect(size.tag).toBe('rect')
      expect(Number.isFinite(size.w) && Number.isFinite(size.h)).toBe(true)
      expect(Math.abs(size.w - size.h)).toBeLessThan(1e-6)
      expect(await vectorToolActive('rect')).toBe(true)
      await clickUndoVisible()
      await waitForPreviewSvg(beforeSvg)
    }

    // Sub-case D: unrelated external `vm.updateCostume` while the hit is
    // pending. The external fill change must survive: the gesture may move
    // the external bytes, but a stale pre-external snapshot must never win
    // (last-writer-wins corruption), and preview must match the VM bytes.
    {
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      const preBytes = await svgBytesOf('VecA', 0)
      expect(preBytes).toContain('#e74c3c')
      const preMd5Ext = await costumeMd5Of('VecA', 0)
      const externalBytes = preBytes.replaceAll('#e74c3c', '#2ecc71')
      expect(externalBytes).not.toBe(preBytes)
      const wantMd5Ext = `${md5(new TextEncoder().encode(externalBytes))}.svg`
      await setLoadGate('next', 600)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.move(center.x + 60, center.y + 10, { steps: 5 })
      // External write lands BEFORE the held hit resolves. Bytes-strict:
      // wait for ANY snapshot md5 change (VM may re-canonicalize bytes and
      // reissue ids), then verify the real paint bytes below — never blind
      // md5ext string equality.
      const extResult = await page.evaluate((svg: string) => {
        const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
        if (!vm) return 'missing-vm'
        try {
          const r = vm.updateCostume('VecA', 0, { dataFormat: 'svg' }, new TextEncoder().encode(svg))
          return (r as Promise<unknown>).then(() => 'ok', (e: unknown) => `rejected:${String(e).slice(0, 200)}`)
        } catch (e) {
          return `threw:${String(e).slice(0, 200)}`
        }
      }, externalBytes)
      log('stress-race external write call', { extResult, wantMd5Ext, preMd5Ext })
      await page.waitForFunction(
        (pre: string | null) => {
          const snap = (window as any).__hikkakuEditorTest?.snapshot()
          const t = snap?.project.targets.find((x: any) => x.name === 'VecA')
          const cur = t?.costumes[0]?.md5ext ?? null
          return cur !== null && cur !== pre
        },
        preMd5Ext,
        { timeout: 10_000 },
      )
      const postExtMd5 = await costumeMd5Of('VecA', 0)
      const postExtBytes = await svgBytesOf('VecA', 0)
      log('stress-race external landed', { postExtMd5, wantMd5Ext, keptGreen: postExtBytes.includes('#2ecc71'), head: postExtBytes.slice(0, 200) })
      await page.mouse.up()
      await settle()
      await assertNoReload('shape-race', 'stress-race external settled')
      const finalBytes = await svgBytesOf('VecA', 0)
      const finalSvg = await previewSvg()
      log('stress-race external', { keptExternalFill: finalBytes.includes('#2ecc71'), lostExternalFill: finalBytes.includes('#e74c3c') })
      // The external fill is never lost to a stale snapshot...
      expect(finalBytes).toContain('#2ecc71')
      expect(finalBytes).not.toContain('#e74c3c')
      // ...and the UI preview matches the VM bytes (no torn UI).
      expect(finalSvg).toContain('#2ecc71')
      expect(await vectorShapeCount()).toBe(1)
      expect(await vectorToolActive('rect')).toBe(true)
      // History stays consistent: at most one gesture entry on top of the
      // external write, and undo/redo round-trips byte-exactly.
      const pairAfter = await undoRedoEnabled()
      if (pairAfter.undo) {
        const svgBeforeUndo = await previewSvg()
        await clickUndoVisible()
        await waitForPreviewSvgChange(svgBeforeUndo, 15_000)
        const undoneBytes = await svgBytesOf('VecA', 0)
        expect([externalBytes, preBytes]).toContain(undoneBytes)
        if (undoneBytes === externalBytes) {
          await clickRedoVisible()
          await waitForPreviewSvg(finalSvg, 15_000)
          expect(await svgBytesOf('VecA', 0)).toBe(finalBytes)
        }
      }
    }

    // Sub-case E: double-click on the selection with the rect tool. The tail
    // click must not stamp a second shape or a second history entry.
    {
      await importSb3(buildSb3(7), 'shape-race-dbl.sb3', 'VecA', redMd5(7))
      await ensureVectorMode()
      await page.getByTestId('target-card-VecA').click()
      await page.waitForTimeout(600)
      const center = await selectRedRect()
      await page.getByTestId('vector-shape-rect').last().click()
      const beforeSvg = await previewSvg()
      const beforeMd5 = await selectedCostumeMd5()
      const pairBefore = await undoRedoEnabled()
      const countBefore = await vectorShapeCount()
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.up()
      await page.mouse.down()
      await page.mouse.up()
      await page.evaluate(() => {
        document.querySelector('[data-testid="costume-paint-surface"]')?.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true }),
        )
      })
      await settle()
      await assertNoReload('shape-race', 'stress-race dblclick settled')
      const afterSvg = await previewSvg()
      log('stress-race dblclick', { pairBefore, pairAfter: await undoRedoEnabled() })
      expect(afterSvg).toBe(beforeSvg)
      expect(await selectedCostumeMd5()).toBe(beforeMd5)
      expect(await vectorShapeCount()).toBe(countBefore)
      expect(await undoRedoEnabled()).toEqual(pairBefore)
      expect(await vectorToolActive('rect')).toBe(true)
      await expectStable({ svg: afterSvg, md5ext: beforeMd5, pair: pairBefore, outlines: await selectionOutlineCount() })
    }
  }, 300_000)
})
