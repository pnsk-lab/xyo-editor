// Adversarial review of vector-reshape-handle-masks.ts + VectorReshapeOverlay.
// Independent proofs only: live Paper.js (MIT) oracle, production pure
// helpers, and the real Editor/VM. No Editor/BitmapEditor sources are edited
// here; UI legs restore artwork with Undo so the VM ends where it started.
//
// What this proves, in own words:
// - Paper native (blank-tab oracle, programmatic paths): curve selection marks
//   start point+out (5) and end point+in (3); segment selection marks both
//   handles (7); adjacent curves union the shared anchor to 7; clearing one
//   shared curve cascades (shared anchor loses its point bit, neighbour curve
//   getter goes false) and leaves a handle-only residual (4/2) that still
//   counts as `segment.selected`; a straight (zero-handle) curve still reports
//   5/3; a closed path's last curve wraps last->first (5 on last, 3 on first).
// - Production masks mirror all of the above exactly (V-7 fixed): point-bit
//   projection always equals Paper's point state, and latent handle-only
//   residuals (4/2) are kept so a shift-off/shift-on round-trip of one shared
//   curve resurrects the neighbour's stale out-bit (7 pressed, Paper-exact).
//   Anchors are pressed by the point bit only, handles by in/out bits, and
//   `segment.selected` parity is any-bit.
// - Product UI (real Editor/VM): single-curve marquee shows only attached
//   handles (opposite handles are absent from the DOM, never disabled);
//   two adjacent curves, Shift toggle first vs second, explicit anchor click
//   while a curve is selected, Shift click unselect, zero-handle curve display,
//   close-loop wrap, point-delete remap, style/nudge/delete/undo/redo,
//   skewed parent, duplicate coordinates, selection drift across artwork
//   switch, rapid async toggles, and reload fail-closed — with SVG bytes.
//
// Read-only discipline: UI legs end with Undo (or re-import) so the VM ends
// where it started. Port 4603 (surveyed free 2026-11-13).
//
// Harness notes (own setup, not product behavior): Playwright
// `mouse.click(x, y, { modifiers: ['Shift'] })` arrives with shiftKey=false in
// this environment (event trace proves it), so every Shift click uses the
// keyboard-held pattern; every drag marquee starts outside the reshape curve
// hit-layer (else the press routes to point-add, not marquee).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4603
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const S_D = 'M180,150 C210,150 210,190 240,190 C270,190 270,230 300,230'
const sSvg = (inner: string) => `${HEAD}${inner}</svg>`
const S_OPEN = sSvg(`<path d="${S_D}" fill="none" stroke="#111111" stroke-width="2"/>`)
// Straight arm then cubic: a0(40,150) a1(140,150) straight, a1->a2 cubic.
const STRAIGHT = sSvg(`<path d="M40,150 L140,150 C170,150 170,210 210,210" fill="none" stroke="#111111" stroke-width="2"/>`)
// Closed smooth loop (last curve wraps last anchor -> first anchor).
const CLOSED = sSvg(`<path d="M100,150 C130,120 170,120 190,150 C210,180 170,220 140,200 C120,188 100,180 100,150 Z" fill="none" stroke="#111111" stroke-width="2"/>`)
const SKEWED = sSvg(`<g transform="translate(30 20) rotate(8) scale(1.15)"><path d="${S_D}" fill="none" stroke="#111111" stroke-width="2"/></g>`)
// Duplicate consecutive anchor coordinates (60,150 twice).
const DUP = sSvg(`<path d="M60,150 L60,150 C90,150 90,200 120,200" fill="none" stroke="#111111" stroke-width="2"/>`)

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const entries: Array<[string, string]> = [
    ['m-open', S_OPEN],
    ['m-straight', STRAIGHT],
    ['m-closed', CLOSED],
    ['m-skew', SKEWED],
    ['m-dup', DUP],
  ]
  const refs = entries.map(([name, svg]) => ({ name, ref: add(svg) }))
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const project = {
    targets: [
      {
        isStage: false, name: 'MaskA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: refs.map(({ name, ref }) => costume(ref, name)),
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'mask-adversarial', agent: 'mask-adversarial' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function importSb3(bytes: Buffer) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'm.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'MaskA') ?? false,
    undefined, { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(900)
}

async function hasMaskA(): Promise<boolean> {
  return await page.evaluate(
    () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'MaskA') ?? false,
  ).catch(() => false)
}

async function ensureVectorMode() {
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
}

async function selectCostume(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).first().click()
  await page.waitForTimeout(900)
}

type Handle = { index: number; x: number; y: number; pressed: boolean; control: boolean }

async function allHandles(): Promise<Handle[]> {
  return await page.evaluate(() => {
    const out: Array<{ index: number; x: number; y: number; pressed: boolean; control: boolean }> = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const label = el.getAttribute('aria-label') ?? ''
      const r = (el as HTMLElement).getBoundingClientRect()
      out.push({
        index: Number((el as HTMLElement).dataset.pointIndex),
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        pressed: el.getAttribute('aria-pressed') === 'true',
        control: label.startsWith('Move control point'),
      })
    }
    return out.sort((a, b) => a.index - b.index)
  })
}

async function pressedAnchors(): Promise<number[]> {
  return (await allHandles()).filter((h) => !h.control && h.pressed).map((h) => h.index).sort((a, b) => a - b)
}

async function pressedCount(): Promise<number> {
  return await page.evaluate(
    () => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length,
  )
}

async function waitPressedCount(n: number) {
  await page.waitForFunction(
    (want) => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length === want,
    n, { timeout: 15_000 },
  )
}

async function previewInner(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function vmSvg(costumeName: string): Promise<string> {
  return await page.evaluate(async (c: string) => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget('MaskA')
    const idx = tgt.costumes.findIndex((x: any) => x.name === c)
    const cost = tgt.costumes[idx]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, costumeName)
}

async function selectObjectAtStroke() {
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(400)
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('.vector-preview svg') as unknown as SVGSVGElement | null
    const path = document.querySelector('.vector-preview svg path') as unknown as SVGPathElement | null
    if (!svg || !path) return null
    try {
      const len = path.getTotalLength()
      const p = path.getPointAtLength(len * 0.3)
      const ctm = path.getScreenCTM()
      if (!ctm) return null
      const dom = new DOMPoint(p.x, p.y).matrixTransform(ctm as unknown as DOMMatrix)
      return { x: dom.x, y: dom.y }
    } catch { return null }
  })
  if (!pt) throw new Error('INVALID: missing stroke point')
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(700)
}

async function enterReshape() {
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.waitForSelector('[data-vector-path-point]')
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-vector-path-point]')].filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length >= 2,
    undefined, { timeout: 15_000 },
  )
}

type Rect = { left: number; top: number; right: number; bottom: number }

async function hitLayerRect(): Promise<Rect | null> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-reshape-curve-layer]') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  })
}

async function surfaceRect(): Promise<{ x: number; y: number; right: number; bottom: number }> {
  return await page.evaluate(() => {
    const s = document.querySelector('[data-testid="costume-paint-surface"]') as HTMLElement | null
    if (!s) throw new Error('INVALID: no paint surface')
    const r = s.getBoundingClientRect()
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }
  })
}

// Drag marquee guaranteed to start on empty canvas: a press inside the
// reshape curve hit-layer would route to point-add/leaf logic instead of the
// canvas point marquee, so a start inside the hit-layer slides left of it.
async function marqueeSelect(x0: number, y0: number, x1: number, y1: number) {
  const [hit, surf] = await Promise.all([hitLayerRect(), surfaceRect()])
  let sx = x0
  let sy = y0
  if (hit && sx >= hit.left - 2 && sx <= hit.right + 2 && sy >= hit.top - 2 && sy <= hit.bottom + 2) {
    sx = hit.left - 12
  }
  sx = Math.max(surf.x + 3, Math.min(sx, surf.right - 3))
  sy = Math.max(surf.y + 3, Math.min(sy, surf.bottom - 3))
  const ex = Math.max(surf.x + 3, Math.min(x1, surf.right - 3))
  const ey = Math.max(surf.y + 3, Math.min(y1, surf.bottom - 3))
  if (hit && sx >= hit.left - 2 && sx <= hit.right + 2 && sy >= hit.top - 2 && sy <= hit.bottom + 2) {
    throw new Error('INVALID: no empty-canvas marquee origin (hit layer covers surface)')
  }
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(ex, ey, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(500)
}

async function fullSelect() {
  const surf = await surfaceRect()
  await marqueeSelect(surf.x + 4, surf.y + 4, surf.right - 4, surf.bottom - 4)
}

// Shift click with the keyboard-held pattern (mouse.click modifiers arrive
// shiftless in this harness — event trace proves shiftKey=false).
async function shiftClick(x: number, y: number) {
  await page.keyboard.down('Shift')
  await page.mouse.click(x, y)
  await page.keyboard.up('Shift')
  await page.waitForTimeout(500)
}

async function curveBandBetweenFirstTwoAnchors() {
  const anchors = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)
  if (anchors.length < 2) throw new Error('INVALID: need 2 anchors for band')
  const [top, mid] = anchors as [Handle, Handle]
  const x0 = Math.min(...anchors.map((h) => h.x)) - 60
  const x1 = Math.max(...anchors.map((h) => h.x)) + 60
  const y0 = top.y + 18
  const y1 = mid.y - 18
  if (!(y1 > y0 + 10)) throw new Error('INVALID: anchors too close for curve band')
  for (const h of anchors) {
    if (!(h.x < x0 || h.x > x1 || h.y < y0 || h.y > y1)) throw new Error('INVALID: band contains an anchor')
  }
  return { x0, x1, y0, y1, top: top!, mid: mid! }
}

describe('vector reshape handle masks (adversarial)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('Paper native oracle: 5/3 vs 7, shared-anchor cascade, wrap, zero-handle curve', async () => {
    let paperSrc = ''
    const tried: string[] = []
    for (const p of [join(root, 'node_modules', 'paper', 'dist', 'paper-full.js'), join(root, '..', 'node_modules', 'paper', 'dist', 'paper-full.js')]) {
      tried.push(p)
      try { paperSrc = await readFile(p, 'utf8'); break } catch { /* next */ }
    }
    if (!paperSrc) throw new Error(`INVALID: paper-full.js not found (${tried.join(', ')})`)
    const ctx = await (browser as any).newContext()
    const oracle = await ctx.newPage()
    await oracle.setContent('<!doctype html><html><body><canvas id="c" width="400" height="300"></canvas></body></html>')
    await oracle.addScriptTag({ content: paperSrc })
    const result = await oracle.evaluate(() => {
      const paper = (window as any).paper
      paper.setup('c')
      const S = (pt: number[], hi: number[] | null, ho: number[] | null) =>
        new paper.Segment(new paper.Point(pt[0], pt[1]), hi ? new paper.Point(hi[0], hi[1]) : null, ho ? new paper.Point(ho[0], ho[1]) : null)
      const num = (s: any) => s._selection ?? s.selection
      const snap = (path: any) => path.segments.map((s: any) => ({ i: s.index, n: num(s), sel: s.selected }))
      // Open S: two cubics, three anchors (explicit adds; Item.add does
      // not spread arrays, so array forms would strand curves[2]).
      const path = new paper.Path()
      path.add(S([20, 20], null, [40, 0])); path.add(S([100, 80], [-40, 0], [40, 60])); path.add(S([180, 140], [-40, 0], null))
      const clear = () => {
        for (const c of path.curves) { try { c.selected = false } catch {} }
        for (const s of path.segments) { try { s.selected = false } catch {} }
      }
      clear(); path.curves[0].selected = true
      const curve0 = snap(path)
      const getters0 = [path.curves[0].selected, path.curves[1].selected]
      clear(); path.curves[0].selected = true; path.curves[1].selected = true
      const both = snap(path)
      const gettersBoth = [path.curves[0].selected, path.curves[1].selected]
      path.curves[0].selected = false
      const afterFirst = snap(path)
      const gettersAfterFirst = [path.curves[0].selected, path.curves[1].selected]
      clear(); path.curves[0].selected = true; path.curves[1].selected = true
      path.curves[1].selected = false
      const afterSecond = snap(path)
      const gettersAfterSecond = [path.curves[0].selected, path.curves[1].selected]
      // Explicit upgrade of a curve-selected endpoint.
      clear(); path.curves[0].selected = true
      path.segments[0].selected = true
      const upgraded = snap(path)
      // Anchor toggle clears its own segment, neighbour keeps curve bits.
      clear(); path.curves[0].selected = true
      path.segments[0].selected = false
      const anchorToggle = snap(path)
      // Clearing one handle from 7 leaves 3; a handle-only state still counts
      // as selected (product uses the point bit instead — documented).
      clear(); path.segments[1].selected = true
      const seg7 = num(path.segments[1])
      path.segments[1].handleOut.selected = false
      const handleCleared = { n: num(path.segments[1]), sel: path.segments[1].selected }
      // Closed wrap: last curve is last segment -> first segment.
      const cpath = new paper.Path({ closed: true })
      cpath.add(S([50, 50], [-20, -20], [20, -20])); cpath.add(S([150, 50], [20, -20], [20, 20])); cpath.add(S([100, 150], [20, 20], [-20, -20]))
      for (const s of cpath.segments) { try { s.selected = false } catch {} }
      cpath.curves[2].selected = true
      const closedLast = snap(cpath)
      // Zero-handle straight curve still reports 5/3.
      const spath = new paper.Path()
      spath.add(S([10, 10], null, null)); spath.add(S([100, 10], null, null))
      for (const s of spath.segments) { try { s.selected = false } catch {} }
      spath.curves[0].selected = true
      const straight = { segs: snap(spath), getter: spath.curves[0].selected }
      return { curve0, getters0, both, gettersBoth, afterFirst, gettersAfterFirst, afterSecond, gettersAfterSecond, upgraded, anchorToggle, seg7, handleCleared, closedLast, straight }
    })
    await ctx.close()
    // Single curve: start 5 (point+out), end 3 (point+in), third untouched.
    expect(result.curve0).toEqual([{ i: 0, n: 5, sel: true }, { i: 1, n: 3, sel: true }, { i: 2, n: 0, sel: false }])
    expect(result.getters0).toEqual([true, false])
    // Adjacent curves union the shared anchor to 7.
    expect(result.both).toEqual([{ i: 0, n: 5, sel: true }, { i: 1, n: 7, sel: true }, { i: 2, n: 3, sel: true }])
    expect(result.gettersBoth).toEqual([true, true])
    // Clearing one shared curve cascades (shared anchor loses its point bit,
    // neighbour curve getter goes false) and leaves a handle-only residual
    // (4/2) that still counts as selected. Product fail-closes the residual;
    // indices must still agree.
    expect(result.afterFirst).toEqual([{ i: 0, n: 0, sel: false }, { i: 1, n: 4, sel: true }, { i: 2, n: 3, sel: true }])
    expect(result.gettersAfterFirst).toEqual([false, false])
    expect(result.afterSecond).toEqual([{ i: 0, n: 5, sel: true }, { i: 1, n: 2, sel: true }, { i: 2, n: 0, sel: false }])
    expect(result.gettersAfterSecond).toEqual([false, false])
    // Explicit segment selection upgrades 5 -> 7.
    expect(result.upgraded[0]).toEqual({ i: 0, n: 7, sel: true })
    // Anchor toggle clears its own segment; the neighbour keeps curve bits.
    expect(result.anchorToggle).toEqual([{ i: 0, n: 0, sel: false }, { i: 1, n: 3, sel: true }, { i: 2, n: 0, sel: false }])
    // 7 -> clear one handle = 3; a handle-only residual counts as selected.
    expect(result.seg7).toBe(7)
    expect(result.handleCleared).toEqual({ n: 3, sel: true })
    // Closed wrap: last segment 5, first segment 3.
    expect(result.closedLast).toEqual([{ i: 0, n: 3, sel: true }, { i: 1, n: 0, sel: false }, { i: 2, n: 5, sel: true }])
    // Zero-handle straight curve still selects 5/3 (display hides the
    // non-existent controls; masks keep 5/3).
    expect(result.straight.segs).toEqual([{ i: 0, n: 5, sel: true }, { i: 1, n: 3, sel: true }])
    expect(result.straight.getter).toBe(true)
  }, 60_000)

  it('production helpers mirror Paper with zero index deviation', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    const result = await page.evaluate(async () => {
      const masks = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-handle-masks.ts')
      const merge = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const idx = (m: Record<number, number>) => masks.reshapeHandleMasksToIndices(m)
      // Plain / explicit provenance.
      const plain = masks.mergeReshapeMarqueeSelectionWithMasks({}, [], [[0, 2]], false)
      const explicit = masks.mergeReshapeMarqueeSelectionWithMasks({}, [0, 2], [], false)
      // Duplicates cancel on Shift, collapse on plain.
      const shiftDup = masks.mergeReshapeMarqueeSelectionWithMasks({}, [], [[0, 1], [0, 1]], true)
      const plainDup = masks.mergeReshapeMarqueeSelectionWithMasks({}, [], [[0, 1], [0, 1]], false)
      // Shared anchor union then cascade on remove (Paper point projection
      // plus latent handle-only residuals: exact Paper flags).
      const both = masks.mergeReshapeMarqueeSelectionWithMasks(plain, [], [[2, 5]], true)
      const removed = masks.mergeReshapeMarqueeSelectionWithMasks(both, [], [[0, 2]], true)
      const removedSecond = masks.mergeReshapeMarqueeSelectionWithMasks(both, [], [[2, 5]], true)
      // Re-toggle after cascade: Paper resurrects the stale out-bit to 7;
      // the product keeps exact Paper flags (latent 4 restored to 7).
      const retoggle = masks.mergeReshapeMarqueeSelectionWithMasks(removed, [], [[0, 2]], true)
      // Explicit anchor + curve union keeps 7 (bitwise OR, never downgrades).
      const explicitPlusCurve = masks.mergeReshapeMarqueeSelectionWithMasks({ 0: 7 } as Record<number, number>, [], [[0, 2]], true)
      // Shift anchor toggle on a curve-selected endpoint removes it (Paper
      // `seg.selected=false` parity: the reference getter is any-bit based).
      const anchorOff = masks.mergeReshapeMarqueeSelectionWithMasks({ 0: 5, 2: 3 } as Record<number, number>, [0], [], true)
      // Click / shift-click.
      const click = masks.toggleReshapeHandleSelection({}, 2, false)
      const unclick = masks.toggleReshapeHandleSelection({ 2: 7 }, 2, true)
      const shiftOffCurveEnd = masks.toggleReshapeHandleSelection({ 0: 5, 2: 3 }, 0, true)
      // Index-level parity for the same flows.
      const iPlain = merge.mergeReshapeMarqueeSelectionWithCurves([], [], [[0, 2]], false)
      const iBoth = merge.mergeReshapeMarqueeSelectionWithCurves(iPlain, [], [[2, 5]], true)
      const iRemoved = merge.mergeReshapeMarqueeSelectionWithCurves(iBoth, [], [[0, 2]], true)
      // Remap through a deleted first anchor (disjoint {anchor,out,nextIn}).
      const remapped = masks.remapReshapeHandleMasksAfterBulkRanges({ 0: 5, 2: 7, 5: 3 }, [{ index: 3, slots: 1 }, { index: 0, slots: 2 }])
      // Coordinate rebase carries masks to the surviving anchor ...
      const rebasedCarry = masks.rebaseReshapeHandleMasksByAnchorCoordinates(
        [{ index: 0, x: 0, y: 0 }, { index: 2, x: 10, y: 0 }],
        [{ index: 0, x: 0, y: 0 }, { index: 4, x: 10, y: 0 }],
        { 2: 3 },
      )
      // ... and drops duplicates fail-closed (two candidates, claimed-once).
      const rebasedDup = masks.rebaseReshapeHandleMasksByAnchorCoordinates(
        [{ index: 0, x: 0, y: 0 }],
        [{ index: 0, x: 0, y: 0 }, { index: 1, x: 0, y: 0 }],
        { 0: 5 },
      )
      // Normalizer keeps exact Paper flags including handle-only residuals.
      const cleaned = masks.normalizeReshapeHandleMasks({ 0: 5, 2: 6, 5: 3 })
      return { plain, explicit, shiftDup, plainDup, both, removed, removedSecond, retoggle, explicitPlusCurve, anchorOff, click, unclick, shiftOffCurveEnd, iPlain, iBoth, iRemoved, remapped, rebasedCarry, rebasedDup, cleaned, idxRemoved: idx(removed), idxRetoggle: idx(retoggle) }
    })
    expect(result.plain).toEqual({ 0: 5, 2: 3 })
    expect(result.explicit).toEqual({ 0: 7, 2: 7 })
    expect(result.shiftDup).toEqual({})
    expect(result.plainDup).toEqual({ 0: 5, 1: 3 })
    // Union then cascade: indices always equal Paper's point projection, masks
    // carry exact Paper flags including latent handle-only residuals.
    expect(result.both).toEqual({ 0: 5, 2: 7, 5: 3 })
    expect(result.iBoth).toEqual([0, 2, 5])
    expect(result.removed).toEqual({ 2: 4, 5: 3 })
    expect(result.idxRemoved).toEqual([5])
    expect(result.iRemoved).toEqual([5])
    expect(result.removedSecond).toEqual({ 0: 5, 2: 2 })
    // Re-toggle resurrects the stale bit to 7 (Paper-exact, V-7 fixed).
    expect(result.retoggle).toEqual({ 0: 5, 2: 7, 5: 3 })
    expect(result.idxRetoggle).toEqual([0, 2, 5])
    // Explicit 7 is never downgraded by a later curve union.
    expect(result.explicitPlusCurve).toEqual({ 0: 7, 2: 3 })
    expect(result.anchorOff).toEqual({ 2: 3 })
    expect(result.click).toEqual({ 2: 7 })
    expect(result.unclick).toEqual({})
    expect(result.shiftOffCurveEnd).toEqual({ 2: 3 })
    // Deleted first anchor: survivor keeps 7, far end keeps 3.
    expect(result.remapped).toEqual({ 0: 7, 2: 3 })
    // Coordinate rebase carries; duplicates drop.
    expect(result.rebasedCarry).toEqual({ 4: 3 })
    expect(result.rebasedDup).toEqual({})
    expect(result.cleaned).toEqual({ 0: 5, 2: 6, 5: 3 })
  }, 60_000)

  it('UI: single curve hides opposite handles, shared toggle cascades, bytes stable', async () => {
    if (!(await hasMaskA())) await importSb3(buildSb3())
    await ensureVectorMode()
    await selectCostume('m-open')
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    const before = await vmSvg('m-open')
    const previewBefore = await previewInner()

    // Curve-only band: Paper truth is 4 pressed (2 anchors + top-out + mid-in).
    const band = await curveBandBetweenFirstTwoAnchors()
    await marqueeSelect(band.x0, band.y0, band.x1, band.y1)
    await waitPressedCount(4)
    expect(await pressedAnchors()).toHaveLength(2)
    // Attached handles only: flattened S layout is a0(0) out(1) a1(2) in(3)
    // out(4) a2(5) in(6); curve0 shows exactly [1,3].
    const visible = (await allHandles()).filter((h) => h.control)
    expect(visible.map((h) => h.index).sort((a, b) => a - b)).toEqual([1, 3])
    expect(visible.every((h) => h.pressed)).toBe(true)
    // Opposite handles are hidden, not disabled: no DOM node, no disabled state.
    expect(await page.evaluate(() => document.querySelector('[data-point-index="4"]'))).toBeNull()
    expect(await page.evaluate(() => document.querySelectorAll('[data-vector-path-point][aria-disabled]').length)).toBe(0)
    // Selection alone writes no bytes and no history.
    expect(await vmSvg('m-open')).toBe(before)
    expect(await previewInner()).toBe(previewBefore)

    // Full marquee: both curves union to three explicit 7s (7 pressed).
    await fullSelect()
    await waitPressedCount(7)
    const fullControls = (await allHandles()).filter((h) => h.control)
    expect(fullControls.map((h) => h.index).sort((a, b) => a - b)).toEqual([1, 3, 4, 6])
    expect(fullControls.every((h) => h.pressed)).toBe(true)
    expect(await vmSvg('m-open')).toBe(before)

    // Shift-toggle the first curve off (Shift held for the whole drag):
    // shared anchor cascades to a latent handle-only residual (Paper-exact
    // 4 on the shared anchor, 3 on the far end); far anchor stays pressed,
    // shared anchor is not pressed, its out-handle stays pressed. 3 pressed
    // total (1 anchor + 2 controls), bytes stable.
    await page.keyboard.down('Shift')
    await marqueeSelect(band.x0, band.y0, band.x1, band.y1)
    await page.keyboard.up('Shift')
    await waitPressedCount(3)
    const bottomIndex = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)[2]!.index
    expect(await pressedAnchors()).toEqual([bottomIndex])
    expect((await allHandles()).filter((h) => h.control && h.pressed)).toHaveLength(2)
    expect(await vmSvg('m-open')).toBe(before)

    // Shift-toggle the same curve back on: Paper-exact resurrection restores
    // the stale out-bit to 7 (4 controls / 7 pressed).
    await page.keyboard.down('Shift')
    await marqueeSelect(band.x0, band.y0, band.x1, band.y1)
    await page.keyboard.up('Shift')
    await waitPressedCount(7)
    expect(await pressedAnchors()).toHaveLength(3)
    expect((await allHandles()).filter((h) => h.control && h.pressed)).toHaveLength(4)
    expect(await vmSvg('m-open')).toBe(before)
    expect(await previewInner()).toBe(previewBefore)
  }, 180_000)

  it('UI: explicit anchor upgrades a curve selection; zero-handle curve shows anchors only; closed loop wraps', async () => {
    if (!(await hasMaskA())) await importSb3(buildSb3())
    await ensureVectorMode()

    // Explicit click while a curve is selected upgrades to a single 7.
    await selectCostume('m-open')
    await selectObjectAtStroke()
    await enterReshape()
    const before = await vmSvg('m-open')
    const band = await curveBandBetweenFirstTwoAnchors()
    await marqueeSelect(band.x0, band.y0, band.x1, band.y1)
    await waitPressedCount(4)
    const mid = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)[1]!
    await page.mouse.click(mid.x, mid.y)
    // Single explicit anchor: 1 anchor + both handles = 3 pressed.
    await waitPressedCount(3)
    expect(await pressedAnchors()).toEqual([mid.index])
    expect((await allHandles()).filter((h) => h.control && h.pressed)).toHaveLength(2)
    expect(await vmSvg('m-open')).toBe(before)
    // Shift-click removes it again (anchor-level unselect).
    await shiftClick(mid.x, mid.y)
    await waitPressedCount(0)
    expect(await vmSvg('m-open')).toBe(before)

    // Zero-handle straight arm: crossing selects the pair with 5/3 masks but
    // no controls exist, so only the 2 anchors show pressed.
    await selectCostume('m-straight')
    await selectObjectAtStroke()
    await enterReshape()
    const straightBefore = await vmSvg('m-straight')
    const sAnchors = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (sAnchors.length !== 3) throw new Error(`INVALID: expected 3 straight anchors, got ${sAnchors.length}`)
    const [sa0, sa1] = sAnchors as [Handle, Handle, Handle]
    // Vertical entry: the arm's y equals both anchors' y, so a horizontal
    // band can only exclude them by x — but sliding the start left of the
    // hit-layer would re-include a0. Enter from above the hit-layer instead:
    // x stays strictly between the anchors, y crosses the arm.
    if (Math.abs(sa0.y - sa1.y) > 4) throw new Error(`INVALID: straight arm not horizontal (${sa0.y} vs ${sa1.y})`)
    if (sa1.x - sa0.x < 60) throw new Error('INVALID: straight arm too short for an interior band')
    {
      const hit = await hitLayerRect()
      const surf = await surfaceRect()
      if (!hit) throw new Error('INVALID: no hit layer for straight band')
      const yTop = hit.top - 12
      if (yTop < surf.y + 3) throw new Error('INVALID: no empty canvas above the straight arm')
      await marqueeSelect(sa0.x + 12, yTop, sa1.x - 12, sa0.y + 8)
    }
    await waitPressedCount(2)
    expect(await pressedAnchors()).toHaveLength(2)
    expect((await allHandles()).filter((h) => h.control)).toHaveLength(0)
    expect(await vmSvg('m-straight')).toBe(straightBefore)

    // Close-loop wrap on the real element: a band crossing the closing edge
    // with no anchor inside reports one pair spanning first<->last flats.
    const wrap = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="M100,150 C130,120 170,120 190,150 C210,180 170,220 140,200 C120,188 100,180 100,150 Z" fill="none" stroke="black"/></svg>`,
        'image/svg+xml',
      )
      return await (mod as any).paperReshapeMarqueeFlatsInRect(doc.querySelector('path'), { x: 92, y: 158, width: 16, height: 16 })
    })
    if (!wrap || wrap.anchorFlats.length !== 0 || wrap.curvePairs.length !== 1) {
      throw new Error(`INVALID: closed wrap band missed the closing edge (${JSON.stringify(wrap)})`)
    }
    const [wa, wb] = wrap.curvePairs[0] as [number, number]
    // First and last anchor flats of the flattened loop (span, not adjacent).
    expect(Math.min(wa, wb)).toBe(0)
    expect(Math.max(wa, wb)).toBeGreaterThan(2)

    // UI smoke on the closed costume: full marquee selects every anchor with
    // all controls, bytes unchanged.
    await selectCostume('m-closed')
    await selectObjectAtStroke()
    await enterReshape()
    const closedBefore = await vmSvg('m-closed')
    const cAnchors = (await allHandles()).filter((h) => !h.control)
    if (cAnchors.length !== 3) throw new Error(`INVALID: expected 3 closed anchors, got ${cAnchors.length}`)
    await fullSelect()
    await waitPressedCount(9)
    expect(await pressedAnchors()).toHaveLength(3)
    expect((await allHandles()).filter((h) => h.control)).toHaveLength(6)
    expect(await vmSvg('m-closed')).toBe(closedBefore)
  }, 180_000)

  it('UI: skewed parent stays un-baked; duplicate coordinates fail closed', async () => {
    if (!(await hasMaskA())) await importSb3(buildSb3())
    await ensureVectorMode()
    // Skewed/rotated/scaled parent: full marquee still selects every anchor
    // with all controls, without baking the wrapper transform.
    await selectCostume('m-skew')
    await selectObjectAtStroke()
    await enterReshape()
    const skewBefore = await vmSvg('m-skew')
    expect(skewBefore).toContain('rotate(')
    await fullSelect()
    await waitPressedCount(7)
    expect((await pressedAnchors()).length).toBe(3)
    expect((await allHandles()).filter((h) => h.control)).toHaveLength(4)
    expect(await vmSvg('m-skew')).toBe(skewBefore)
    expect(await vmSvg('m-skew')).toContain('rotate(')

    // Duplicate coordinates: both coincident anchors select (5 pressed:
    // 3 anchors + 2 controls), style round-trips with Undo, bytes prove no
    // wrong-anchor edit.
    await selectCostume('m-dup')
    await selectObjectAtStroke()
    await enterReshape()
    const dupBefore = await vmSvg('m-dup')
    await fullSelect()
    await waitPressedCount(5)
    expect((await pressedAnchors()).length).toBe(3)
    await page.getByTestId('reshape-point-point').click()
    await page.waitForTimeout(900)
    const dupPointed = await vmSvg('m-dup')
    expect(dupPointed).not.toBe(dupBefore)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForTimeout(900)
    expect(await vmSvg('m-dup')).toBe(dupBefore)
  }, 180_000)

  it('UI: delete remaps handles, style/nudge keep selection, drift clears, undo/redo exact', async () => {
    if (!(await hasMaskA())) await importSb3(buildSb3())
    await ensureVectorMode()
    await selectCostume('m-open')
    await selectObjectAtStroke()
    await enterReshape()
    const before = await vmSvg('m-open')
    const previewBefore = await previewInner()

    // Delete remap: curve pair selected, delete the middle anchor.
    const band = await curveBandBetweenFirstTwoAnchors()
    await marqueeSelect(band.x0, band.y0, band.x1, band.y1)
    await waitPressedCount(4)
    const mid = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)[1]!
    await page.mouse.click(mid.x, mid.y)
    await waitPressedCount(3)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(900)
    expect((await allHandles()).filter((h) => !h.control)).toHaveLength(2)
    expect(await vmSvg('m-open')).not.toBe(before)
    // Undo restores the bytes; the selection was a deleted single anchor, so
    // nothing comes back (empty stays empty — no phantom selection).
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('m-open')).toBe(before)
    await waitPressedCount(0)
    // Redo re-applies the delete; undo again to restore (read-only discipline).
    await page.locator('button[aria-label="Redo"]:visible').click()
    await page.waitForTimeout(900)
    expect(await vmSvg('m-open')).not.toBe(before)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('m-open')).toBe(before)

    // Style retarget: curve pair survives pointed/curved by coordinates.
    await marqueeSelect(band.x0, band.y0, band.x1, band.y1)
    await waitPressedCount(4)
    await page.getByTestId('reshape-point-point').click()
    await page.waitForTimeout(900)
    expect(await pressedAnchors()).toHaveLength(2)
    expect((await allHandles()).filter((h) => h.control)).toHaveLength(0)
    const pointedBytes = await vmSvg('m-open')
    expect(pointedBytes).not.toBe(before)
    await page.getByTestId('reshape-curve-point').click()
    await page.waitForTimeout(900)
    await waitPressedCount(4)
    expect(await pressedAnchors()).toHaveLength(2)
    expect((await allHandles()).filter((h) => h.control)).toHaveLength(2)
    // Undo curved -> pointed state keeps the 2 anchors (no controls).
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForTimeout(900)
    expect(await vmSvg('m-open')).toBe(pointedBytes)
    expect(await pressedAnchors()).toHaveLength(2)
    expect((await allHandles()).filter((h) => h.control)).toHaveLength(0)
    // Undo pointed -> original bytes with the 5/3 pair restored.
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('m-open')).toBe(before)
    await waitPressedCount(4)

    // Nudge with a reshape selection: product moves the object, keeps the
    // selection pressed, one Undo restores exact bytes.
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(900)
    expect(await vmSvg('m-open')).not.toBe(before)
    await waitPressedCount(4)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('m-open')).toBe(before)
    await waitPressedCount(4)

    // Drift across artwork: switching to a different-topology costume drops
    // the selection fail-closed (no coordinate match, no index leak).
    await selectCostume('m-straight')
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    expect(await vmSvg('m-straight')).not.toBe(before)
    // Back on the S-curve the selection does not resurrect.
    await selectCostume('m-open')
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)

    // Rapid async toggles converge (epoch-guarded leaf sync, no residue).
    const b2 = await curveBandBetweenFirstTwoAnchors()
    await marqueeSelect(b2.x0, b2.y0, b2.x1, b2.y1)
    await waitPressedCount(4)
    const t = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)[0]!
    await shiftClick(t.x, t.y)
    await shiftClick(t.x, t.y)
    await waitPressedCount(4)
    expect(await vmSvg('m-open')).toBe(before)
  }, 240_000)

  it('UI: reload fail-closes reshape state without crashing', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectCostume('m-open')
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    // Reload drops transient selection; re-imported artwork reshapes cleanly.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectCostume('m-open')
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    const band = await curveBandBetweenFirstTwoAnchors()
    await marqueeSelect(band.x0, band.y0, band.x1, band.y1)
    await waitPressedCount(4)
  }, 180_000)
})
