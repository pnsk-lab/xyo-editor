// Vector drag race gate (NEW test-only file, product code untouched).
//
// Residual suspicion after the leaf-drag fix:
//   (a) vectorPathPointDrag / vectorRotateDrag: an automatic
//       `lostpointercapture` firing while the async pointerup commit is still
//       in flight may route to cancel and rewind a just-released drag.
//   (b) preview `updateVectorCostumeFromEditor` awaits a VM write; a
//       cancel / Escape / target / costume switch that runs while the write
//       is pending may lose the race when the stale write lands AFTER the
//       restore (last-writer-wins), corrupting the old asset (and possibly
//       the new one) and leaving Undo inconsistent.
//
// Method (test-only):
//   - Real Editor via the existing paint-history fixture
//     (`test/paint-history-isolation-fixture.html`, unmodified) which mounts
//     the production Editor and exposes its VM as `window.__paintHistoryVm`.
//   - A deferred gate wraps THAT VM instance's `updateCostume` in page
//     context (test-only monkey patch, removed at the end): `all` delays
//     every write so trailing `lostpointercapture`/cancel/switch land
//     inside the async commit window; `once` delays only the first write so
//     a cancel/Escape restore resolves first and a stale late write would
//     visibly win (bug repro). No product file is edited.
//   - point / rotate / leaf each: normal pointerup -> lost must commit
//     exactly once; pointercancel / Escape / target-switch / costume-switch
//     must restore the old asset, leave the new asset bytes untouched and
//     leave Undo/Redo consistent.
//   - VM spec: whether two targets with different ids but the same name can
//     coexist (crafted sb3, ids preserved by normalizeTarget) and what
//     name-based `getTarget`/`updateCostume` then resolve to. If coexistence
//     is impossible the corresponding leg reports INVALID instead of failing.
//
// Verdict policy: assertions describe CORRECT behaviour. A reproduced product
// bug FAILS loudly (left failing + reported, never silenced). Impossible
// setups report INVALID with the reason.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4533
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// Self-made fixtures (original coordinates, distinct fills per asset so a
// cross-asset write is attributable).
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
    const hash = md5(bytes)
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
  const project = {
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
        currentCostume: 0,
        costumes: [costume(b, 'vec-b')],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 80, y: 40, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'drag-race-gate', agent: 'drag-race-gate' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function buildDupSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const red = add(rectSvg(120, 100, 120, 90, '#e74c3c'))
  const blue = add(rectSvg(220, 150, 100, 70, '#2980b9'))
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const project = {
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
    meta: { semver: '3.0.0', vm: 'drag-race-gate-dup', agent: 'drag-race-gate-dup' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function log(label: string, value: unknown) {
  console.log(`[race-gate] ${label} ${JSON.stringify(value).slice(0, 2500)}`)
}

// --- page helpers -----------------------------------------------------------

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
  const index = target?.currentCostume ?? 0
  return (target?.costumes[index]?.md5ext as string | undefined) ?? null
}

async function costumeMd5Of(targetName: string, index: number): Promise<string | null> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.name === targetName)
  return (target?.costumes[index]?.md5ext as string | undefined) ?? null
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
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML !== svg, previous, { timeout })
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

// Deferred gate on the REAL VM instance (test-only page patch, no product
// edit). `all` delays every updateCostume write by ms (trailing
// lostpointercapture / cancel / switch land inside the async commit);
// `once` delays only the next write (a cancel restore resolves first, so a
// stale late write would visibly win). Call log is kept for forensics.
async function installVmGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for gate install')
    if (w.__dragRaceGate) return
    const orig = vm.updateCostume.bind(vm)
    const gate = (w.__dragRaceGate = { mode: 'off', ms: 400, calls: [] as Array<{ target: string; index: number }>, delayed: 0 })
    vm.updateCostume = async (...args: any[]) => {
      gate.calls.push({ target: String(args[0]), index: Number(args[1]) })
      if (gate.mode === 'all') {
        gate.delayed += 1
        await new Promise((r) => setTimeout(r, gate.ms))
      } else if (gate.mode === 'once') {
        gate.mode = 'off'
        gate.delayed += 1
        await new Promise((r) => setTimeout(r, gate.ms))
      }
      return orig(...args)
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
  })
}

async function uninstallVmGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    // Cannot recover the original bound fn from here, but turning the gate
    // off restores immediate behaviour for the rest of the session.
    if (w.__dragRaceGate) w.__dragRaceGate.mode = 'off'
    void vm
  })
}

// Settle: gate off, then wait until no new VM writes land and the preview is
// stable across two polls.
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
    (want: string) => {
      const snap = (window as any).__hikkakuEditorTest?.snapshot()
      return snap?.project.targets.some((t: any) => t.name === want) ?? false
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

async function firePointer(selector: string, type: string, opts: { pointerId: number; clientX: number; clientY: number; buttons: number; shiftKey?: boolean; altKey?: boolean }) {
  await page.evaluate(({ sel, t, o }: { sel: string; t: string; o: { pointerId: number; clientX: number; clientY: number; buttons: number; shiftKey?: boolean; altKey?: boolean } }) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) throw new Error(`firePointer: missing ${sel}`)
    el.dispatchEvent(new PointerEvent(t, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: o.pointerId, pointerType: 'pen', button: 0, buttons: o.buttons,
      clientX: o.clientX, clientY: o.clientY,
      shiftKey: o.shiftKey === true, altKey: o.altKey === true, isPrimary: true,
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

async function drawRectBaseline(): Promise<{ emptySvg: string; baseSvg: string; baseMd5: string | null }> {
  // Assumes VecA / vec-blank selected, vector mode, blank canvas.
  const emptySvg = await previewSvg()
  await page.getByTestId('vector-shape-rect').last().click()
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx - 110, cy - 60)
  await page.mouse.down()
  await page.mouse.move(cx + 110, cy + 60, { steps: 12 })
  await page.mouse.up()
  await waitForPreviewSvgChange(emptySvg)
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.waitForSelector('[data-vector-path-point]', { timeout: 20_000 })
  await page.waitForTimeout(600)
  const baseSvg = await previewSvg()
  const baseMd5 = await selectedCostumeMd5()
  log('rect baseline', { baseMd5, handles: await page.locator('[data-vector-path-point]').count() })
  return { emptySvg, baseSvg, baseMd5 }
}

async function clampToSurface(rect: { x: number; y: number; width: number; height: number }): Promise<{ x: number; y: number } | null> {
  const box = await surfaceBox()
  const ix0 = Math.max(rect.x, box.x)
  const iy0 = Math.max(rect.y, box.y)
  const ix1 = Math.min(rect.x + rect.width, box.x + box.width)
  const iy1 = Math.min(rect.y + rect.height, box.y + box.height)
  // Require a usable patch (not a sliver) so the press lands on real ink.
  if (ix1 - ix0 < 12 || iy1 - iy0 < 12) return null
  return { x: (ix0 + ix1) / 2, y: (iy0 + iy1) / 2 }
}

async function leafGroupRectCenter(): Promise<{ x: number; y: number } | null> {
  const rect = await page.evaluate(() => {
    const svg = document.querySelector('.vector-preview svg')
    if (!svg) return null
    const unit = Array.from(svg.children).find((kid) => (kid as Element).tagName.toLowerCase() === 'g') as Element | undefined
    if (!unit) return null
    const gRect = Array.from(unit.children).find((kid) => (kid as Element).tagName.toLowerCase() === 'rect') as Element | undefined
    if (!gRect) return null
    const r = (gRect as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })
  if (!rect) return null
  return await clampToSurface(rect)
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest
    return api?.status() ?? ''
  })
}

async function selectionOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}

// Self-sufficient per-leg setup: every leg below calls one of these first so
// legs stay independent regardless of what the previous leg cleared.
async function ensurePointReshape() {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  await page.getByTestId('vector-shape-select').last().click()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.waitForSelector('[data-vector-path-point]', { timeout: 20_000 })
  await page.waitForTimeout(400)
}

async function ensureRotateHandle(): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  await page.getByTestId('vector-shape-select').last().click()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const handle = page.getByTestId('vector-rotate-handle')
  await handle.waitFor({ state: 'visible', timeout: 20_000 })
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('INVALID: missing rotate handle box')
  return { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }
}

// Select the mixed group (select tool, real press with hold for the async
// begin) then enter reshape. Falls back to the group-rect center when the
// text press misses; reports forensics instead of failing silently.
async function ensureLeafReshape() {
  await page.getByTestId('vector-shape-select').last().click()
  const candidates: Array<{ x: number; y: number; label: string }> = []
  const textAt = await leafTextCenter().catch(() => null)
  if (textAt) candidates.push({ ...textAt, label: 'text' })
  const grect = await leafGroupRectCenter()
  if (grect) candidates.push({ ...grect, label: 'group-rect' })
  if (candidates.length === 0) throw new Error('INVALID: no leaf press candidate in preview')
  let lastStatus = ''
  let lastForensics: unknown = null
  await waitSurfaceStable()
  for (const at of candidates) {
    const forensics = await page.evaluate(({ x, y }: { x: number; y: number }) => {
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')
      const sr = (surface as HTMLElement | null)?.getBoundingClientRect()
      const chain: string[] = []
      const top = document.elementFromPoint(x, y) as HTMLElement | null
      let node: HTMLElement | null = top
      for (let i = 0; i < 4 && node; i += 1) {
        chain.push(`${node.tagName}${node.getAttribute('data-testid') ? `#${node.getAttribute('data-testid')}` : ''}.${(node.className?.baseVal ?? node.className ?? '').toString().slice(0, 60)}`)
        node = node.parentElement
      }
      const outlines = Array.from(document.querySelectorAll('[data-vector-selection-outline]')).map((el) => (el as HTMLElement).className?.toString().slice(0, 120))
      return {
        insideSurface: sr ? x >= sr.left && x <= sr.right && y >= sr.top && y <= sr.bottom : null,
        surfaceBox: sr ? { x: sr.left, y: sr.top, w: sr.width, h: sr.height } : null,
        point: { x, y },
        chain,
        outlines,
      }
    }, { x: at.x, y: at.y })
    lastForensics = forensics
    log('leaf press forensics', { at: at.label, forensics })
    try {
      await guardCanvasPoint({ x: at.x, y: at.y }, `leaf ${at.label} press point`)
    } catch (e) {
      log('leaf press off-canvas, recompute once', { at: at.label, error: String(e).slice(0, 200) })
      continue
    }
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.waitForTimeout(1000)
    await page.mouse.up()
    await page.waitForTimeout(500)
    lastStatus = await editorStatus()
    const outlines = await selectionOutlineCount()
    log('leaf select attempt', { at: at.label, status: lastStatus, outlines })
    await page.getByTestId('vector-shape-reshape').last().click()
    const layer = page.locator('[data-reshape-curve-layer]')
    try {
      await layer.waitFor({ state: 'attached', timeout: 8_000 })
      return
    } catch {
      log('leaf select retry', { at: at.label, status: lastStatus, outlines })
    }
  }
  throw new Error(`INVALID: mixed group not selectable (last status: ${lastStatus}) ${JSON.stringify(lastForensics).slice(0, 800)}`)
}

async function leafDragStart(): Promise<{ x: number; y: number }> {
  await waitSurfaceStable()
  const diag = await page.evaluate(() => {
    const previews = Array.from(document.querySelectorAll('.vector-preview')).map((pv, i) => {
      const r = (pv as HTMLElement).getBoundingClientRect()
      const svgs = Array.from(pv.querySelectorAll('svg')).map((s) => {
        const sr = (s as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
        return { rect: { x: sr.left, y: sr.top, w: sr.width, h: sr.height }, kids: (s as Element).children.length }
      })
      return { i, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, svgs }
    })
    return { previews }
  })
  log('leaf preview diagnostics', diag)
  const from = await leafTextCenter()
  await guardCanvasPoint(from, 'leaf drag start')
  return from
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
  if (!rect) throw new Error('INVALID: no text leaf rect in preview (mixed group not rendered?)')
  const clamped = await clampToSurface(rect)
  if (!clamped) throw new Error('INVALID: text leaf not visible in the paint surface (fully cropped by pan/zoom)')
  return clamped
}

async function leafFacts(): Promise<{ textTransform: string | null; textContent: string; rectCount: number }> {
  return await page.evaluate(async () => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const tgt = vm.getTarget('VecA')
    const idx = tgt.costumes.findIndex((c: any) => c.name === 'vec-mixed')
    const c = tgt.costumes[idx]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
    const text = doc.querySelector('g text')
    return {
      textTransform: (text as unknown as Element | null)?.getAttribute('transform'),
      textContent: text?.textContent ?? '',
      rectCount: doc.querySelectorAll('rect').length,
    }
  })
}

async function selectCostumeByName(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).first().click()
  await page.waitForTimeout(900)
}

async function openFreshPage(): Promise<Page> {
  const ctx = await browser!.newContext({ viewport: { width: 1400, height: 900 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => log('pageerror', String(e).slice(0, 300)))
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await p.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  return p
}

// Fresh page with test-only installs (pid listener + VM deferred gate live
// per page). Used for the leaf section so accumulated layout/viewport state
// from earlier sections cannot skew sub-element hit coordinates.
async function openFreshTestPage(): Promise<Page> {
  const p = await openFreshPage()
  const prev = page
  page = p
  try {
    await installPidListener()
    await installVmGate()
  } catch (e) {
    page = prev
    await p.context().close().catch(() => undefined)
    throw e
  }
  return p
}

async function surfaceBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

async function waitSurfaceStable(timeout = 20_000) {
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, any>
    const el = document.querySelector('[data-testid="costume-paint-surface"]')
    const r = (el as HTMLElement | null)?.getBoundingClientRect()
    const cur = r ? `${r.left},${r.top},${r.width},${r.height}` : 'none'
    const now = Date.now()
    if (w.__surfacePrev !== cur) {
      w.__surfacePrev = cur
      w.__surfaceStableSince = now
      return false
    }
    return now - (w.__surfaceStableSince ?? now) > 800
  }, undefined, { timeout })
  await page.waitForTimeout(300)
}

async function guardCanvasPoint(p: { x: number; y: number }, label: string) {
  const hit = await page.evaluate(({ px, py }: { px: number; py: number }) => {
    const element = document.elementFromPoint(px, py)
    if (!element) return 'none'
    if ((element as HTMLElement).closest?.('[data-vector-stage-surface]')) return `canvas:${element.tagName}`
    const button = (element as HTMLElement).closest?.('button')
    if (button) return `button:${button.getAttribute('data-testid') ?? button.getAttribute('aria-label') ?? (button.textContent ?? '').slice(0, 30)}`
    return element.tagName
  }, { px: p.x, py: p.y })
  if (!hit.startsWith('canvas:')) {
    throw new Error(`INVALID: ${label} is off-canvas (hits ${hit} at ${p.x},${p.y}); refusing a misdirected press`)
  }
}

describe('vector drag race gate (new test, no product change)', () => {
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
    await installPidListener()
    await installVmGate()
  }, 120_000)

  afterAll(async () => {
    try {
      await uninstallVmGate()
    } catch {}
    await browser?.close()
    server?.kill()
  })

  it('vm-spec: different targetId with the same target name can coexist (name lookup hits the first)', async () => {
    // Node-side VM spec confirmation (test-only import, no product change).
    let nodeVerdict: string
    try {
      const mod = await import('@hikkaku/vm') as unknown as Record<string, any>
      const VM = mod.ScratchVM ?? mod.VirtualMachine ?? mod.default
      if (!VM) throw new Error('ScratchVM export not found')
      const vm = new VM()
      await vm.loadProject({
        targets: [
          { id: 'dupA', isStage: false, name: 'DupSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100, soundEffects: {}, layerOrder: 1 },
          { id: 'dupB', isStage: false, name: 'DupSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100, soundEffects: {}, layerOrder: 2 },
        ],
        monitors: [], extensions: [], meta: { semver: '3.0.0' },
      })
      const dups = vm.project.targets.filter((t: any) => t.name === 'DupSprite')
      const first = vm.getTarget('DupSprite')
      nodeVerdict = `coexist=${dups.length === 2} ids=${dups.map((t: any) => t.id).join(',')} firstHit=${first?.id}`
      log('vm-spec node', { nodeVerdict })
      expect(dups.length).toBe(2)
      expect(first?.id).toBe('dupA')
    } catch (e) {
      nodeVerdict = `INVALID (node import failed): ${String(e).slice(0, 300)}`
      log('vm-spec node', { nodeVerdict })
      // Node import is best-effort (browser-oriented module); the page half
      // below is authoritative. Do not fail here on harness grounds.
    }

    // Page half: crafted sb3 with distinct ids + identical names must survive
    // import with both targets present; otherwise the dup leg is INVALID.
    const dupPage = await openFreshPage()
    const prev = page
    page = dupPage
    try {
      await installPidListener()
      await installVmGate()
      await importSb3(buildDupSb3(), 'dup.sb3', 'DupSprite')
      const snap = await snapshot()
      const dups = snap.project.targets.filter((t: any) => t.name === 'DupSprite')
      log('vm-spec page', { count: dups.length, ids: dups.map((t: any) => t.id) })
      if (dups.length !== 2) {
        log('vm-spec page', { verdict: 'INVALID: duplicate names do not coexist; name-confusion legs skipped' })
        expect(dups.length).toBe(2)
        return
      }
      const firstHit = await page.evaluate(() => {
        const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
        return vm.getTarget('DupSprite')?.id ?? null
      })
      log('vm-spec page', { firstHit, verdict: 'coexistence possible; name lookup hits the first target (ambiguity is real)' })
      expect(firstHit).toBe('dupA')
    } finally {
      await dupPage.context().close().catch(() => undefined)
      page = prev
    }
  }, 120_000)

  it('point-drag: normal pointerup -> lostpointercapture commits exactly once', async () => {
    await importSb3(buildSb3(), 'race.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const { emptySvg, baseSvg, baseMd5 } = await drawRectBaseline()
    const pairBefore = await undoRedoEnabled()

    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for point drag')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    // Real drag; arm the deferred gate just before release so the trailing
    // auto-loss (real + synthetic) lands inside the async commit window.
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 70, h.y + 8, { steps: 10 })
    await waitForPreviewSvgChange(baseSvg)
    await setGate('all', 400)
    const pid = await lastPointerId()
    await page.mouse.up()
    // Explicit synthetic auto-loss during the gated commit (suspect a).
    await firePointer(sel, 'lostpointercapture', { pointerId: pid, clientX: h.x + 70, clientY: h.y + 8, buttons: 0 })
    const callsBefore = await gateCalls()
    await settle()
    const movedSvg = await previewSvg()
    const movedMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    log('point commit', { baseMd5, movedMd5, pairBefore, pairAfter, vmCalls: callsBefore.length })
    expect(movedSvg).not.toBe(baseSvg)
    expect(movedMd5).not.toBe(baseMd5)
    expect(pairAfter.undo).toBe(true)
    // Exactly one entry: Undo -> baseline, Undo -> rect gone, Redo x2 -> moved.
    await clearGateCalls()
    await clickUndoVisible()
    await waitForPreviewSvg(baseSvg)
    expect(await selectedCostumeMd5()).toBe(baseMd5)
    await clickUndoVisible()
    await waitForPreviewSvg(emptySvg)
    await clickRedoVisible()
    await waitForPreviewSvg(baseSvg)
    await clickRedoVisible()
    await waitForPreviewSvg(movedSvg)
    expect(await selectedCostumeMd5()).toBe(movedMd5)
    // Leave at baseline with redo=[moved] for the cancel legs (pair-compared).
    await clickUndoVisible()
    await waitForPreviewSvg(baseSvg)
  }, 180_000)

  it('point-drag: pointercancel restores the snapshot with no history', async () => {
    await ensurePointReshape()
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    const pairBefore = await undoRedoEnabled()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for point cancel')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    await setGate('all', 400)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 65, h.y + 10, { steps: 8 })
    const pid = await lastPointerId()
    // Synthetic cancel while the gated preview write is in flight.
    await firePointer(sel, 'pointercancel', { pointerId: pid, clientX: h.x + 65, clientY: h.y + 10, buttons: 0 })
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    log('point pointercancel', { baseMd5, afterMd5, pairBefore, pairAfter })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('point-drag: Escape restores the snapshot with no history', async () => {
    await ensurePointReshape()
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    const pairBefore = await undoRedoEnabled()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for point Escape')
    const h = handles[0]!
    await setGate('all', 400)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 55, h.y - 12, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    log('point Escape', { baseMd5, afterMd5, pairBefore, pairAfter })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('point-drag: mid-drag target switch restores the old asset, keeps the new one, clears history', async () => {
    await ensurePointReshape()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const baseSvg = await previewSvg()
    const oldMd5Pre = await costumeMd5Of('VecA', 0)
    const newMd5Pre = await costumeMd5Of('VecB', 0)
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for point target-switch')
    const h = handles[0]!
    await setGate('all', 400)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 60, h.y + 6, { steps: 8 })
    // Real app switch through the keyboard route (capture may hold the
    // button): focus + Enter on the same card a click would hit.
    const card = page.getByTestId('target-card-VecB')
    await card.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    const pairAtSwitch = await undoRedoEnabled()
    const newMd5AtSwitch = await costumeMd5Of('VecB', 0)
    // Release the stale drag over the new target: must be a no-op.
    await page.mouse.up()
    await settle()
    const newMd5After = await costumeMd5Of('VecB', 0)
    const newBytesAfter = await svgBytesOf('VecB', 0)
    const pairAfter = await undoRedoEnabled()
    log('point target-switch', { oldMd5Pre, newMd5Pre, newMd5AtSwitch, newMd5After, pairAtSwitch, pairAfter, newBytes: newBytesAfter.length })
    expect(newMd5AtSwitch).toBe(newMd5Pre)
    expect(newMd5After).toBe(newMd5Pre)
    expect(pairAtSwitch).toEqual({ undo: false, redo: false })
    expect(pairAfter).toEqual({ undo: false, redo: false })
    // Back to the old asset: the pre-drag snapshot must be restored.
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(900)
    await ensurePointReshape()
    await waitForPreviewSvg(baseSvg)
    expect(await costumeMd5Of('VecA', 0)).toBe(oldMd5Pre)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
  }, 180_000)

  it('point-drag: mid-drag costume switch restores the old asset, keeps the new one, clears history', async () => {
    await ensurePointReshape()
    const baseSvg = await previewSvg()
    const oldMd5Pre = await costumeMd5Of('VecA', 0)
    const newMd5Pre = await costumeMd5Of('VecA', 1)
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for point costume-switch')
    const h = handles[0]!
    await setGate('all', 400)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 60, h.y + 6, { steps: 8 })
    const selectBtn = page.locator('[data-testid="costume-card-1"] button[aria-label^="Select "]')
    await selectBtn.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    const pairAtSwitch = await undoRedoEnabled()
    const newMd5AtSwitch = await costumeMd5Of('VecA', 1)
    await page.mouse.up()
    await settle()
    const newMd5After = await costumeMd5Of('VecA', 1)
    const pairAfter = await undoRedoEnabled()
    log('point costume-switch', { oldMd5Pre, newMd5Pre, newMd5AtSwitch, newMd5After, pairAtSwitch, pairAfter })
    expect(newMd5AtSwitch).toBe(newMd5Pre)
    expect(newMd5After).toBe(newMd5Pre)
    expect(pairAtSwitch).toEqual({ undo: false, redo: false })
    expect(pairAfter).toEqual({ undo: false, redo: false })
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(900)
    await ensurePointReshape()
    await waitForPreviewSvg(baseSvg)
    expect(await costumeMd5Of('VecA', 0)).toBe(oldMd5Pre)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
  }, 180_000)

  it('point-drag: STALE gated write vs cancel (suspect b) must still restore', async () => {
    // One-shot gate: the preview write is held 600ms while the cancel
    // restore resolves immediately. A last-writer-wins product leaves the
    // stale moved bytes behind -> this leg FAILS (bug reproduced, reported).
    await ensurePointReshape()
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    const pairBefore = await undoRedoEnabled()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for point stale leg')
    const h = handles[0]!
    const sel = `[data-vector-path-point][data-point-index="${h.index}"]`
    await clearGateCalls()
    await setGate('once', 600)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 70, h.y + 10, { steps: 8 })
    // Let the preview reach the gated write, then cancel inside the window.
    await page.waitForTimeout(90)
    const pid = await lastPointerId()
    await firePointer(sel, 'pointercancel', { pointerId: pid, clientX: h.x + 70, clientY: h.y + 10, buttons: 0 })
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    const calls = await gateCalls()
    log('point STALE', { baseMd5, afterMd5, pairBefore, pairAfter, vmWriteCalls: calls })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('rotate-drag: normal pointerup -> lostpointercapture commits exactly once', async () => {
    await importSb3(buildSb3(), 'race-rotate.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    const { emptySvg, baseSvg, baseMd5 } = await drawRectBaseline()
    await page.getByTestId('vector-shape-select').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const handle = page.getByTestId('vector-rotate-handle')
    await handle.waitFor({ state: 'visible', timeout: 20_000 })
    const pairBefore = await undoRedoEnabled()
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('INVALID: missing rotate handle box')
    const cx = hb.x + hb.width / 2
    const cy = hb.y + hb.height / 2
    await setGate('all', 400)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 110, cy + 30, { steps: 14 })
    await waitForPreviewSvgChange(baseSvg)
    const pid = await lastPointerId()
    await page.mouse.up()
    // Synthetic auto-loss during the gated commit (suspect a for rotate).
    await page.evaluate(({ id, x, y }: { id: number; x: number; y: number }) => {
      const el = document.querySelector('[data-testid="vector-rotate-handle"]') as HTMLElement | null
      if (!el) throw new Error('missing rotate handle for lost dispatch')
      el.dispatchEvent(new PointerEvent('lostpointercapture', {
        bubbles: true, cancelable: true, composed: true, pointerId: id,
        pointerType: 'pen', button: 0, buttons: 0, clientX: x, clientY: y, isPrimary: true,
      }))
    }, { id: pid, x: cx + 110, y: cy + 30 })
    await settle()
    const movedSvg = await previewSvg()
    const movedMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    log('rotate commit', { baseMd5, movedMd5, pairBefore, pairAfter })
    expect(movedSvg).not.toBe(baseSvg)
    expect(movedMd5).not.toBe(baseMd5)
    expect(pairAfter.undo).toBe(true)
    await clearGateCalls()
    await clickUndoVisible()
    await waitForPreviewSvg(baseSvg)
    expect(await selectedCostumeMd5()).toBe(baseMd5)
    await clickUndoVisible()
    await waitForPreviewSvg(emptySvg)
    await clickRedoVisible()
    await waitForPreviewSvg(baseSvg)
    await clickRedoVisible()
    await waitForPreviewSvg(movedSvg)
    expect(await selectedCostumeMd5()).toBe(movedMd5)
    await clickUndoVisible()
    await waitForPreviewSvg(baseSvg)
  }, 180_000)

  it('rotate-drag: pointercancel restores the exact snapshot with history/redo preserved', async () => {
    // Scratch / touch / bitmap / point / leaf parity: pointercancel is a
    // cancel, not a commit. A mid-drag cancel must restore the exact
    // pre-drag bytes + metadata with no history, preserving a pre-existing
    // redo entry. The trailing pointerup after the cancel is a no-op.
    await ensureRotateHandle()
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    const pairBefore = await undoRedoEnabled()
    const baseMeta = await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const tgt = vm.getTarget('VecA')
      const c = tgt.costumes[tgt.currentCostume ?? 0]
      return { name: c.name, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, dataFormat: c.dataFormat, bitmapResolution: c.bitmapResolution }
    })
    const handle = page.getByTestId('vector-rotate-handle')
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('INVALID: missing rotate handle box')
    const cx = hb.x + hb.width / 2
    const cy = hb.y + hb.height / 2
    await setGate('all', 400)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 100, cy + 25, { steps: 10 })
    const pid = await lastPointerId()
    await page.evaluate(({ id, x, y }: { id: number; x: number; y: number }) => {
      const el = document.querySelector('[data-testid="vector-rotate-handle"]') as HTMLElement | null
      if (!el) throw new Error('missing rotate handle for cancel dispatch')
      el.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true, cancelable: true, composed: true, pointerId: id,
        pointerType: 'pen', button: 0, buttons: 0, clientX: x, clientY: y, isPrimary: true,
      }))
    }, { id: pid, x: cx + 100, y: cy + 25 })
    // Stale release after the cancel must be a no-op (gesture retired).
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    const afterMeta = await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
      const tgt = vm.getTarget('VecA')
      const c = tgt.costumes[tgt.currentCostume ?? 0]
      return { name: c.name, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, dataFormat: c.dataFormat, bitmapResolution: c.bitmapResolution }
    })
    log('rotate pointercancel', { baseMd5, afterMd5, pairBefore, pairAfter, baseMeta, afterMeta })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(afterMeta).toEqual(baseMeta)
    expect(pairAfter).toEqual(pairBefore)
    // Redo preservation: a pre-existing redo entry (left by the normal
    // commit leg) must survive the cancel.
    if (pairBefore.redo) expect(pairAfter.redo).toBe(true)
  }, 180_000)

  it('rotate-drag: lostpointercapture alone restores the snapshot with no history', async () => {
    // Genuine capture loss without a preceding pointercancel (e.g. alert,
    // palette takeover) cancels too; only the implicit auto-loss trailing a
    // normal pointerup is exempt (committing guard, covered by the commit leg).
    const { x: cx, y: cy } = await ensureRotateHandle()
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    const pairBefore = await undoRedoEnabled()
    await setGate('all', 400)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 95, cy + 22, { steps: 10 })
    const pid = await lastPointerId()
    await page.evaluate(({ id, x, y }: { id: number; x: number; y: number }) => {
      const el = document.querySelector('[data-testid="vector-rotate-handle"]') as HTMLElement | null
      if (!el) throw new Error('missing rotate handle for lost dispatch')
      el.dispatchEvent(new PointerEvent('lostpointercapture', {
        bubbles: true, cancelable: true, composed: true, pointerId: id,
        pointerType: 'pen', button: 0, buttons: 0, clientX: x, clientY: y, isPrimary: true,
      }))
    }, { id: pid, x: cx + 95, y: cy + 22 })
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    log('rotate lostpointercapture', { baseMd5, afterMd5, pairBefore, pairAfter })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('rotate-drag: Escape restores the snapshot with no history', async () => {
    const { x: cx, y: cy } = await ensureRotateHandle()
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    const pairBefore = await undoRedoEnabled()
    await setGate('all', 400)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 105, cy + 28, { steps: 10 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    log('rotate Escape', { baseMd5, afterMd5, pairBefore, pairAfter })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('rotate-drag: mid-drag target switch restores the old asset, keeps the new one, clears history', async () => {
    const { x: cx, y: cy } = await ensureRotateHandle()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const baseSvg = await previewSvg()
    const oldMd5Pre = await costumeMd5Of('VecA', 0)
    const newMd5Pre = await costumeMd5Of('VecB', 0)
    await setGate('all', 400)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 100, cy + 25, { steps: 10 })
    const card = page.getByTestId('target-card-VecB')
    await card.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    const pairAtSwitch = await undoRedoEnabled()
    const newMd5AtSwitch = await costumeMd5Of('VecB', 0)
    await page.mouse.up()
    await settle()
    const newMd5After = await costumeMd5Of('VecB', 0)
    const pairAfter = await undoRedoEnabled()
    log('rotate target-switch', { oldMd5Pre, newMd5Pre, newMd5AtSwitch, newMd5After, pairAtSwitch, pairAfter })
    expect(newMd5AtSwitch).toBe(newMd5Pre)
    expect(newMd5After).toBe(newMd5Pre)
    expect(pairAtSwitch).toEqual({ undo: false, redo: false })
    expect(pairAfter).toEqual({ undo: false, redo: false })
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(900)
    await ensureRotateHandle()
    await waitForPreviewSvg(baseSvg)
    expect(await costumeMd5Of('VecA', 0)).toBe(oldMd5Pre)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
  }, 180_000)

  it('rotate-drag: mid-drag costume switch restores the old asset, keeps the new one, clears history', async () => {
    const { x: cx, y: cy } = await ensureRotateHandle()
    const baseSvg = await previewSvg()
    const oldMd5Pre = await costumeMd5Of('VecA', 0)
    const newMd5Pre = await costumeMd5Of('VecA', 1)
    await setGate('all', 400)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 100, cy + 25, { steps: 10 })
    const selectBtn = page.locator('[data-testid="costume-card-1"] button[aria-label^="Select "]')
    await selectBtn.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    const pairAtSwitch = await undoRedoEnabled()
    const newMd5AtSwitch = await costumeMd5Of('VecA', 1)
    await page.mouse.up()
    await settle()
    const newMd5After = await costumeMd5Of('VecA', 1)
    const pairAfter = await undoRedoEnabled()
    log('rotate costume-switch', { oldMd5Pre, newMd5Pre, newMd5AtSwitch, newMd5After, pairAtSwitch, pairAfter })
    expect(newMd5AtSwitch).toBe(newMd5Pre)
    expect(newMd5After).toBe(newMd5Pre)
    expect(pairAtSwitch).toEqual({ undo: false, redo: false })
    expect(pairAfter).toEqual({ undo: false, redo: false })
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(900)
    await ensureRotateHandle()
    await waitForPreviewSvg(baseSvg)
    expect(await costumeMd5Of('VecA', 0)).toBe(oldMd5Pre)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
  }, 180_000)

  it('rotate-drag: STALE gated write vs Escape (suspect b) must still restore', async () => {
    const { x: cx, y: cy } = await ensureRotateHandle()
    const baseSvg = await previewSvg()
    const baseMd5 = await selectedCostumeMd5()
    const pairBefore = await undoRedoEnabled()
    await clearGateCalls()
    await setGate('once', 600)
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 110, cy + 30, { steps: 12 })
    await page.waitForTimeout(90)
    // Synthetic Escape inside the gated-write window (same-tick, no drain).
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await page.mouse.up()
    await settle()
    const afterSvg = await previewSvg()
    const afterMd5 = await selectedCostumeMd5()
    const pairAfter = await undoRedoEnabled()
    const calls = await gateCalls()
    log('rotate STALE', { baseMd5, afterMd5, pairBefore, pairAfter, vmWriteCalls: calls })
    expect(afterSvg).toBe(baseSvg)
    expect(afterMd5).toBe(baseMd5)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('leaf-drag: normal pointerup -> lostpointercapture commits exactly once', async () => {
    // Fresh page: accumulated layout/viewport state from earlier sections
    // skewed SVG sub-element hit coordinates; leaf needs exact canvas hits.
    await openFreshTestPage()
    await importSb3(buildSb3(), 'race-leaf.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeByName('vec-mixed')
    await ensureLeafReshape()
    const before = await leafFacts()
    const pairBefore = await undoRedoEnabled()
    if (before.textContent.trim() === '') throw new Error('INVALID: mixed group text leaf missing')
    log('leaf baseline', { before, pairBefore })
    const from = await leafDragStart()
    await setGate('all', 400)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 })
    await page.mouse.move(from.x + 55, from.y + 16, { steps: 8 })
    await page.mouse.up()
    // Extra synthetic auto-loss during the gated commit (committing flag must ignore it).
    const pid = await lastPointerId()
    await page.evaluate(({ id, x, y }: { id: number; x: number; y: number }) => {
      const layer = document.querySelector('[data-reshape-curve-layer]') as HTMLElement | null
      if (!layer) throw new Error('missing curve layer for lost dispatch')
      layer.dispatchEvent(new PointerEvent('lostpointercapture', {
        bubbles: true, cancelable: true, composed: true, pointerId: id,
        pointerType: 'pen', button: 0, buttons: 0, clientX: x, clientY: y, isPrimary: true,
      }))
    }, { id: pid, x: from.x + 55, y: from.y + 16 })
    await settle()
    const moved = await leafFacts()
    const pairAfter = await undoRedoEnabled()
    log('leaf commit', { before, moved, pairBefore, pairAfter })
    expect(moved.textTransform).not.toBe(null)
    expect(pairAfter.undo).toBe(true)
    // Exactly one entry: Undo restores facts + disables Undo; Redo re-applies.
    await clearGateCalls()
    await clickUndoVisible()
    await page.waitForTimeout(900)
    const undone = await leafFacts()
    expect(undone.textTransform).toBe(null)
    expect((await undoRedoEnabled()).undo).toBe(false)
    await clickRedoVisible()
    await page.waitForTimeout(900)
    const redone = await leafFacts()
    expect(redone.textTransform).toBe(moved.textTransform)
    await clickUndoVisible()
    await page.waitForTimeout(900)
    expect((await leafFacts()).textTransform).toBe(null)
  }, 240_000)

  it('leaf-drag: pointercancel restores the snapshot with no history', async () => {
    await ensureLeafReshape()
    const before = await leafFacts()
    const pairBefore = await undoRedoEnabled()
    const from = await leafDragStart()
    await setGate('all', 400)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 50, from.y + 14, { steps: 8 })
    const pid = await lastPointerId()
    await page.evaluate(({ id, x, y }: { id: number; x: number; y: number }) => {
      const layer = document.querySelector('[data-reshape-curve-layer]') as HTMLElement | null
      if (!layer) throw new Error('missing curve layer for cancel dispatch')
      const init = {
        bubbles: true, cancelable: true, composed: true, pointerId: id,
        pointerType: 'pen', button: 0, buttons: 0, clientX: x, clientY: y, isPrimary: true,
      }
      layer.dispatchEvent(new PointerEvent('pointercancel', init))
      layer.dispatchEvent(new PointerEvent('lostpointercapture', init))
    }, { id: pid, x: from.x + 50, y: from.y + 14 })
    await page.mouse.up()
    await settle()
    const after = await leafFacts()
    const pairAfter = await undoRedoEnabled()
    log('leaf pointercancel', { before, after, pairBefore, pairAfter })
    expect(after).toEqual(before)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('leaf-drag: Escape restores the snapshot with no history', async () => {
    await ensureLeafReshape()
    const before = await leafFacts()
    const pairBefore = await undoRedoEnabled()
    const from = await leafDragStart()
    await setGate('all', 400)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 48, from.y + 12, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await settle()
    const after = await leafFacts()
    const pairAfter = await undoRedoEnabled()
    log('leaf Escape', { before, after, pairBefore, pairAfter })
    expect(after).toEqual(before)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('leaf-drag: mid-drag target switch restores the old asset, keeps the new one, clears history', async () => {
    await ensureLeafReshape()
    const oldPre = await leafFacts()
    const oldMd5Pre = await costumeMd5Of('VecA', 2)
    const newMd5Pre = await costumeMd5Of('VecB', 0)
    const from = await leafDragStart()
    await setGate('all', 400)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 52, from.y + 14, { steps: 8 })
    const card = page.getByTestId('target-card-VecB')
    await card.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    const pairAtSwitch = await undoRedoEnabled()
    const newMd5AtSwitch = await costumeMd5Of('VecB', 0)
    await page.mouse.up()
    await settle()
    const newMd5After = await costumeMd5Of('VecB', 0)
    const pairAfter = await undoRedoEnabled()
    log('leaf target-switch', { oldMd5Pre, newMd5Pre, newMd5AtSwitch, newMd5After, pairAtSwitch, pairAfter })
    expect(newMd5AtSwitch).toBe(newMd5Pre)
    expect(newMd5After).toBe(newMd5Pre)
    expect(pairAtSwitch).toEqual({ undo: false, redo: false })
    expect(pairAfter).toEqual({ undo: false, redo: false })
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(900)
    await selectCostumeByName('vec-mixed')
    await ensureLeafReshape()
    expect(await leafFacts()).toEqual(oldPre)
    expect(await costumeMd5Of('VecA', 2)).toBe(oldMd5Pre)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
  }, 240_000)

  it('leaf-drag: mid-drag costume switch restores the old asset, keeps the new one, clears history', async () => {
    await ensureLeafReshape()
    const oldPre = await leafFacts()
    const oldMd5Pre = await costumeMd5Of('VecA', 2)
    const newMd5Pre = await costumeMd5Of('VecA', 1)
    const from = await leafDragStart()
    await setGate('all', 400)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 52, from.y + 14, { steps: 8 })
    const selectBtn = page.locator('[data-testid="costume-card-1"] button[aria-label^="Select "]')
    await selectBtn.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    const pairAtSwitch = await undoRedoEnabled()
    const newMd5AtSwitch = await costumeMd5Of('VecA', 1)
    await page.mouse.up()
    await settle()
    const newMd5After = await costumeMd5Of('VecA', 1)
    const pairAfter = await undoRedoEnabled()
    log('leaf costume-switch', { oldMd5Pre, newMd5Pre, newMd5AtSwitch, newMd5After, pairAtSwitch, pairAfter })
    expect(newMd5AtSwitch).toBe(newMd5Pre)
    expect(newMd5After).toBe(newMd5Pre)
    expect(pairAtSwitch).toEqual({ undo: false, redo: false })
    expect(pairAfter).toEqual({ undo: false, redo: false })
    await page.locator('[data-testid="costume-card-2"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(900)
    await ensureLeafReshape()
    expect(await leafFacts()).toEqual(oldPre)
    expect(await costumeMd5Of('VecA', 2)).toBe(oldMd5Pre)
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
  }, 240_000)

  it('leaf-drag: STALE gated write vs cancel (suspect b) must still restore', async () => {
    await ensureLeafReshape()
    const before = await leafFacts()
    const beforeMd5 = await costumeMd5Of('VecA', 2)
    const pairBefore = await undoRedoEnabled()
    const from = await leafDragStart()
    await clearGateCalls()
    await setGate('once', 600)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 55, from.y + 16, { steps: 8 })
    await page.waitForTimeout(90)
    const pid = await lastPointerId()
    await page.evaluate(({ id, x, y }: { id: number; x: number; y: number }) => {
      const layer = document.querySelector('[data-reshape-curve-layer]') as HTMLElement | null
      if (!layer) throw new Error('missing curve layer for stale cancel dispatch')
      const init = {
        bubbles: true, cancelable: true, composed: true, pointerId: id,
        pointerType: 'pen', button: 0, buttons: 0, clientX: x, clientY: y, isPrimary: true,
      }
      layer.dispatchEvent(new PointerEvent('pointercancel', init))
      layer.dispatchEvent(new PointerEvent('lostpointercapture', init))
    }, { id: pid, x: from.x + 55, y: from.y + 16 })
    await page.mouse.up()
    await settle()
    const after = await leafFacts()
    const afterMd5 = await costumeMd5Of('VecA', 2)
    const pairAfter = await undoRedoEnabled()
    const calls = await gateCalls()
    log('leaf STALE', { before, after, beforeMd5, afterMd5, pairBefore, pairAfter, vmWriteCalls: calls })
    expect(after).toEqual(before)
    expect(afterMd5).toBe(beforeMd5)
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)
})
