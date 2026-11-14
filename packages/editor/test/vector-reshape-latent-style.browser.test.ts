// V-7 latent segment any-bit: Curved/Pointed gating + action on the real page.
//
// Fixture: 4-anchor / 3-cubic open wave (true mixed pointed+curved):
//   A0(120,150) A1(180,190) A2(240,230) A3(300,270)
// A0/A1/A3 spans are smooth collinear (30,0); A2 is kinked
// (in (-30,0) vs out (30,30), cross -900 >> tolerance) so A2 classifies
// pointed (both buttons) while the far endpoint A3 (single in-handle)
// classifies curved (Pointed only). Combined {A2,A3} enables both.
// Real UI flow (no manufactured internal state): marquee curve C1 (A1-A2),
// Shift+marquee curve C2 (A2-A3), then Shift+marquee C1 off. Paper truth for
// the shared-anchor cascade leaves {A2: mask4, A3: mask3}: the middle anchor
// is handle-only latent, the far anchor keeps its point bit. Both still
// report `segment.selected == true` (any-bit getter parity, confirmed by the
// native Paper oracle below), while the point-bit projection is [far] only.
// Multi vs pure latent, stated exactly: the adjacent-deselect flow above can
// only reach the multi state {4,3} (far keeps its point bit). The pure
// handle-only state {4} (zero point bits) is reached afterwards by
// Shift+clicking the far anchor off — still real UI, no internal state is
// manufactured. Both legs are asserted; nothing is weakened.
//
// What this proves (strict, no weakening):
// - Gating: in {4,3} both Curved and Pointed are enabled. The far endpoint
//   alone is curved-style (Curved disabled, Pointed enabled); the latent
//   middle alone is pointed-style with both bits (Curved+Pointed). Only an
//   any-bit derivation enables both — a point-bit-only derivation would leave
//   Curved disabled. In pure {4} both stay enabled with zero anchors pressed.
// - Action: Pointed from {4,3} clears BOTH anchors' handles (2 of 2 change);
//   Curved from both-pointed restores BOTH (2 of 2 change). Anchors never
//   move; untouched anchors (A0/A1) keep exact handles; SVG bytes change,
//   Undo/Redo restore bytes exactly, selection is not lost, target/slot stay
//   stable (MaskV7, costume 0, same vector object).
// - Delete affordance + mutation: the overlay delete button labels 2 selected
//   points for {4,3}; clicking it removes exactly A2+A3 (4 anchors -> 2,
//   nondegenerate single cubic remains) and Undo restores bytes + latent
//   selection exactly. Target/slot stay stable throughout.
//
// Read-only discipline: every mutating leg ends with Undo (bytes restored)
// except the final delete leg, which undoes as its own assertion. Port 4605
// (surveyed 2026-11-13: 4603 adversarial, 4604 latent-nudge, 4607 audit taken).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4605
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// 4 anchors, 3 cubics: A0/A1 spans smooth, A2 kinked (true mixed style).
const W_D = 'M120,150 C150,150 150,190 180,190 C210,190 210,230 240,230 C270,260 270,270 300,270'
const wSvg = (inner: string) => `${HEAD}${inner}</svg>`
const W_OPEN = wSvg(`<path d="${W_D}" fill="none" stroke="#111111" stroke-width="2"/>`)

function buildSb3(): Buffer {
  const bytes = new TextEncoder().encode(W_OPEN)
  const hash = md5(bytes)
  const project = {
    targets: [
      {
        isStage: false, name: 'MaskV7', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'w-open', assetId: hash, md5ext: `${hash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'latent-style-v7', agent: 'latent-style-v7' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), [`${hash}.svg`]: bytes }))
}

async function importSb3(bytes: Buffer) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'w.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'MaskV7') ?? false,
    undefined, { timeout: 30_000 },
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

async function vmSvg(): Promise<string> {
  return await page.evaluate(async () => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget('MaskV7')
    const cost = tgt.costumes[0]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  })
}

async function vmTargetStable(): Promise<{ name: string; costumes: number; current: number }> {
  return await page.evaluate(() => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget('MaskV7')
    return { name: tgt.name as string, costumes: (tgt.costumes as unknown[]).length, current: tgt.currentCostume as number }
  })
}

async function reshapeStyleState() {
  return await page.evaluate(() => {
    const curve = document.querySelector('[data-testid="reshape-curve-point"]') as HTMLButtonElement | null
    const point = document.querySelector('[data-testid="reshape-point-point"]') as HTMLButtonElement | null
    return {
      present: curve !== null && point !== null,
      curveDisabled: curve ? curve.disabled : undefined,
      pointDisabled: point ? point.disabled : undefined,
      curvePressed: curve?.getAttribute('aria-pressed'),
      pointPressed: point?.getAttribute('aria-pressed'),
    }
  })
}

async function waitReshapeStyle(expected: { curveDisabled?: boolean; pointDisabled?: boolean }) {
  await page.waitForFunction(
    (exp) => {
      const curve = document.querySelector('[data-testid="reshape-curve-point"]') as HTMLButtonElement | null
      const point = document.querySelector('[data-testid="reshape-point-point"]') as HTMLButtonElement | null
      if (!curve || !point) return false
      if (exp.curveDisabled !== undefined && curve.disabled !== exp.curveDisabled) return false
      if (exp.pointDisabled !== undefined && point.disabled !== exp.pointDisabled) return false
      return true
    },
    expected, { timeout: 15_000 },
  )
  return await reshapeStyleState()
}

async function selectObjectAtStroke() {
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(400)
  const pt = await page.evaluate(() => {
    const path = document.querySelector('.vector-preview svg path') as unknown as SVGPathElement | null
    if (!path) return null
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
    () => [...document.querySelectorAll('[data-vector-path-point]')].filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length >= 4,
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
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(ex, ey, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(500)
}

async function curveBandBetweenAnchors(sortedA: number, sortedB: number) {
  const anchors = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)
  if (Math.min(sortedA, sortedB) < 0 || Math.max(sortedA, sortedB) >= anchors.length) throw new Error('INVALID: anchor sort index out of range')
  const top = anchors[Math.min(sortedA, sortedB)]!
  const mid = anchors[Math.max(sortedA, sortedB)]!
  const x0 = Math.min(...anchors.map((h) => h.x)) - 60
  const x1 = Math.max(...anchors.map((h) => h.x)) + 60
  const y0 = top.y + 18
  const y1 = mid.y - 18
  if (!(y1 > y0 + 10)) throw new Error('INVALID: anchors too close for curve band')
  for (const h of anchors) {
    if (!(h.x < x0 || h.x > x1 || h.y < y0 || h.y > y1)) throw new Error('INVALID: band contains an anchor')
  }
  return { x0, x1, y0, y1 }
}

type AnchorGeom = { x: number; y: number }
type PointGeom = { index: number; kind: string; x: number; y: number; related?: number; role?: string }

async function objectGeometry(): Promise<{ anchors: AnchorGeom[]; controls: PointGeom[]; flats: number[] }> {
  return await page.evaluate(async () => {
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const list = await mod.paperVectorObjectList(html)
    const points = ((list[0] as any)?.points ?? []) as Array<any>
    return {
      anchors: points.filter((p) => p.kind !== 'control').map((p) => ({ x: p.x as number, y: p.y as number })),
      controls: points.filter((p) => p.kind === 'control').map((p) => ({ index: p.index as number, kind: p.kind as string, x: p.x as number, y: p.y as number, related: p.relatedAnchorIndex as number | undefined, role: p.controlRole as string | undefined })),
      flats: (points as Array<any>).map((p) => p.index as number).sort((a, b) => a - b),
    }
  })
}

function anchorsMatch(a: AnchorGeom[], b: AnchorGeom[], tolerance = 1.5) {
  if (a.length !== b.length) return false
  return a.every((p) => b.some((q) => Math.abs(p.x - q.x) < tolerance && Math.abs(p.y - q.y) < tolerance))
}

describe('vector reshape latent style V-7 (focused)', () => {
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

  it('unit: any-bit flats include latent 4/6, point-bit projection does not', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    const r = await page.evaluate(async () => {
      const masks = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-handle-masks.ts')
      // The V-7 multi state plus the pure latent singleton.
      const multi = masks.reshapeSelectedSegmentFlats({ 5: 4, 8: 3 } as any)
      const multiPoint = masks.reshapeHandleMasksToIndices({ 5: 4, 8: 3 } as any)
      const pure = masks.reshapeSelectedSegmentFlats({ 5: 4 } as any)
      const purePoint = masks.reshapeHandleMasksToIndices({ 5: 4 } as any)
      const points = [
        { index: 0, x: 0, y: 0, kind: 'anchor' },
        { index: 5, x: 1, y: 0, kind: 'anchor' },
        { index: 8, x: 2, y: 0, kind: 'anchor' },
      ] as any
      const liveMulti = masks.liveReshapeActionIndices(points, { 5: 4, 8: 3 } as any)
      const livePure = masks.liveReshapeActionIndices(points, { 5: 4 } as any)
      const liveControlKey = masks.liveReshapeActionIndices(points, { 6: 7 } as any)
      return { multi, multiPoint, pure, purePoint, liveMulti, livePure, liveControlKey }
    })
    // Multi {4,3}: both count for actions, only far for display.
    expect(r.multi).toEqual([5, 8])
    expect(r.multiPoint).toEqual([8])
    // Pure {4}: the action target with zero display anchors.
    expect(r.pure).toEqual([5])
    expect(r.purePoint).toEqual([])
    expect(r.liveMulti).toEqual([5, 8])
    expect(r.livePure).toEqual([5])
    // Control-slot keys never act.
    expect(r.liveControlKey).toEqual([])
  }, 60_000)

  it('Paper oracle: neighboring curves deselect-first leaves middle 4 / far 3, both segment.selected', async () => {
    let paperSrc = ''
    for (const p of [join(root, 'node_modules', 'paper', 'dist', 'paper-full.js'), join(root, '..', 'node_modules', 'paper', 'dist', 'paper-full.js')]) {
      try { paperSrc = await readFile(p, 'utf8'); break } catch { /* next */ }
    }
    if (!paperSrc) throw new Error('INVALID: paper-full.js not found')
    const ctx = await (browser as any).newContext()
    const oracle = await ctx.newPage()
    await oracle.setContent('<!doctype html><html><body><canvas id="c" width="400" height="360"></canvas></body></html>')
    await oracle.addScriptTag({ content: paperSrc })
    const result = await oracle.evaluate(() => {
      const paper = (window as any).paper
      paper.setup('c')
      const S = (pt: number[], hi: number[] | null, ho: number[] | null) =>
        new paper.Segment(new paper.Point(pt[0], pt[1]), hi ? new paper.Point(hi[0], hi[1]) : null, ho ? new paper.Point(ho[0], ho[1]) : null)
      // 4-anchor / 3-cubic wave, all smooth.
      const path = new paper.Path()
      path.add(S([120, 150], null, [30, 0])); path.add(S([180, 190], [-30, 0], [30, 40])); path.add(S([240, 230], [-30, -40], [30, 40])); path.add(S([300, 270], [-30, -40], null))
      // Two neighboring curves C1+C2, then Shift deselect the first.
      path.curves[1].selected = true; path.curves[2].selected = true
      path.curves[1].selected = false
      const segs = path.segments as any[]
      return {
        n: (path.segments as unknown[]).length,
        s0: segs[0]._selection ?? segs[0].selection, s1: segs[1]._selection ?? segs[1].selection,
        s2: segs[2]._selection ?? segs[2].selection, s3: segs[3]._selection ?? segs[3].selection,
        sel0: segs[0].selected, sel1: segs[1].selected, sel2: segs[2].selected, sel3: segs[3].selected,
        c1: path.curves[1].selected, c2: path.curves[2].selected,
      }
    })
    await ctx.close()
    expect(result.n).toBe(4)
    // Paper truth for the shared-anchor cascade: A1 cleared, A2 keeps
    // handle-only out (4), A3 keeps point+in (3).
    expect(result.s0).toBe(0)
    expect(result.s1).toBe(0)
    expect(result.s2).toBe(4)
    expect(result.s3).toBe(3)
    // Any-bit getter parity: latent handle-only counts as selected.
    expect(result.sel0).toBe(false)
    expect(result.sel1).toBe(false)
    expect(result.sel2).toBe(true)
    expect(result.sel3).toBe(true)
    // Neither shared curve reports selected after the cascade.
    expect(result.c1).toBe(false)
    expect(result.c2).toBe(false)
  }, 60_000)

  it('UI: latent {4,3} enables both buttons, Pointed/Curved hit BOTH, delete 4->2, undo exact, slot stable', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    const before = await vmSvg()
    const previewBefore = await previewInner()
    expect(await vmTargetStable()).toEqual({ name: 'MaskV7', costumes: 1, current: 0 })

    // Two neighboring curves via bands (no explicit anchors), then Shift the
    // first off -> latent {middle:4, far:3}. The first anchor never selects.
    const bandC1 = await curveBandBetweenAnchors(1, 2)
    await marqueeSelect(bandC1.x0, bandC1.y0, bandC1.x1, bandC1.y1)
    await waitPressedCount(4)
    const bandC2 = await curveBandBetweenAnchors(2, 3)
    await page.keyboard.down('Shift')
    await marqueeSelect(bandC2.x0, bandC2.y0, bandC2.x1, bandC2.y1)
    await page.keyboard.up('Shift')
    // C1 {A1:5,A2:3} + Shift C2 {A2:5|A3:3 union} -> {A1:5,A2:7,A3:3} = 7 pressed.
    await waitPressedCount(7)
    await page.keyboard.down('Shift')
    await marqueeSelect(bandC1.x0, bandC1.y0, bandC1.x1, bandC1.y1)
    await page.keyboard.up('Shift')
    await waitPressedCount(3)
    const order = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)
    if (order.length !== 4) throw new Error(`INVALID: expected 4 wave anchors, got ${order.length}`)
    const [w0, w1, w2, w3] = order as [Handle, Handle, Handle, Handle, ...Handle[]]
    expect(await pressedAnchors()).toEqual([w3.index])
    expect((await allHandles()).filter((h) => h.control && h.pressed)).toHaveLength(2)
    // Delete affordance proves BOTH flats are action targets without mutating.
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    expect(await vmSvg()).toBe(before)

    // V-7 gating: BOTH buttons enabled. Far-endpoint-only would be curved
    // (Curved disabled); the latent middle alone is pointed with both bits,
    // so only an any-bit derivation enables Curved here.
    let style = await waitReshapeStyle({ curveDisabled: false, pointDisabled: false })
    expect(style.present).toBe(true)
    expect(style.curveDisabled).toBe(false)
    expect(style.pointDisabled).toBe(false)

    // Exact geometry oracle: 4 anchors at the fixture coords, 6 controls, the
    // middle keeps both handles in the document, the far keeps its in-handle.
    const geom = await objectGeometry()
    expect(geom.anchors).toHaveLength(4)
    expect(anchorsMatch(geom.anchors, [{ x: 120, y: 150 }, { x: 180, y: 190 }, { x: 240, y: 230 }, { x: 300, y: 270 }])).toBe(true)
    expect(geom.controls).toHaveLength(6)

    // Pointed hits BOTH selected segments only: middle + far lose handles,
    // A0/A1 keep exact handles, anchors never move.
    const geomBeforePoint = geom
    await page.getByTestId('reshape-point-point').click()
    await page.waitForTimeout(900)
    const pointedBytes = await vmSvg()
    expect(pointedBytes).not.toBe(before)
    const geomPointed = await objectGeometry()
    expect(geomPointed.anchors).toHaveLength(4)
    expect(anchorsMatch(geomPointed.anchors, geomBeforePoint.anchors)).toBe(true)
    // Both latent anchors are now handle-free; the untouched pair keeps 3.
    const relatedPointed = new Map<number, number>()
    for (const c of geomPointed.controls) relatedPointed.set(c.related!, (relatedPointed.get(c.related!) ?? 0) + 1)
    expect(relatedPointed.get(w2.index) ?? 0).toBe(0)
    expect(relatedPointed.get(w3.index) ?? 0).toBe(0)
    expect(geomPointed.controls).toHaveLength(3)
    // The middle segment retains its handle-only selection bits even though
    // its handles are now zero; only the far anchor's point bit is pressed.
    await waitPressedCount(1)
    expect(await pressedAnchors()).toHaveLength(1)
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    expect(await vmTargetStable()).toEqual({ name: 'MaskV7', costumes: 1, current: 0 })
    // Both pointed: Curved enabled, Pointed disabled, no selection loss.
    style = await waitReshapeStyle({ curveDisabled: false, pointDisabled: true })
    expect(style.curveDisabled).toBe(false)
    expect(style.pointDisabled).toBe(true)

    // Undo restores exact bytes + latent gating; Redo re-applies.
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, previewBefore, { timeout: 15_000 })
    expect(await vmSvg()).toBe(before)
    await waitPressedCount(3)
    expect(await pressedAnchors()).toEqual([w3.index])
    style = await waitReshapeStyle({ curveDisabled: false, pointDisabled: false })
    expect(style.curveDisabled).toBe(false)
    expect(style.pointDisabled).toBe(false)
    await page.locator('button[aria-label="Redo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML !== want, previewBefore, { timeout: 15_000 })
    expect(await vmSvg()).toBe(pointedBytes)
    await waitPressedCount(1)
    expect(await vmTargetStable()).toEqual({ name: 'MaskV7', costumes: 1, current: 0 })

    // Curved hits BOTH from both-pointed: anchors fixed, both regain smooth
    // handles, untouched pair still exact.
    const geomBeforeCurve = await objectGeometry()
    await page.getByTestId('reshape-curve-point').click()
    await page.waitForTimeout(900)
    const curvedBytes = await vmSvg()
    expect(curvedBytes).not.toBe(pointedBytes)
    const geomCurved = await objectGeometry()
    expect(geomCurved.anchors).toHaveLength(4)
    expect(anchorsMatch(geomCurved.anchors, geomBeforeCurve.anchors)).toBe(true)
    const relatedCurved = new Map<number, number>()
    for (const c of geomCurved.controls) relatedCurved.set(c.related!, (relatedCurved.get(c.related!) ?? 0) + 1)
    expect((relatedCurved.get(w2.index) ?? 0)).toBeGreaterThanOrEqual(2)
    expect((relatedCurved.get(w3.index) ?? 0)).toBeGreaterThanOrEqual(1)
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    expect(await vmTargetStable()).toEqual({ name: 'MaskV7', costumes: 1, current: 0 })
    // Both curved: Curved disabled, Pointed enabled.
    style = await waitReshapeStyle({ curveDisabled: true, pointDisabled: false })
    expect(style.curveDisabled).toBe(true)
    expect(style.pointDisabled).toBe(false)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML !== want, await previewInner(), { timeout: 15_000 }).catch(() => undefined)
    // Undo the curve: bytes return to the pointed state exactly.
    await page.waitForTimeout(600)
    expect(await vmSvg()).toBe(pointedBytes)
    await page.locator('button[aria-label="Redo"]:visible').click()
    await page.waitForTimeout(900)
    expect(await vmSvg()).toBe(curvedBytes)
    expect(await vmTargetStable()).toEqual({ name: 'MaskV7', costumes: 1, current: 0 })

    // Back to the latent multi state for the pure/delete legs: undo the
    // curve AND the point (two Undos) to the exact pre-style bytes.
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForTimeout(600)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, previewBefore, { timeout: 15_000 })
    expect(await vmSvg()).toBe(before)
    await waitPressedCount(3)
    expect(await pressedAnchors()).toEqual([w3.index])

    // Pure latent via real Shift+click: toggle the far anchor off. Zero
    // anchors pressed, one handle pressed, yet BOTH buttons stay enabled —
    // a point-bit-only derivation would disable both here.
    const farHandle = (await allHandles()).find((h) => !h.control && h.index === w3.index)
    if (!farHandle) throw new Error('INVALID: far anchor handle missing')
    await page.keyboard.down('Shift')
    await page.mouse.click(farHandle.x, farHandle.y)
    await page.keyboard.up('Shift')
    await page.waitForTimeout(700)
    expect(await pressedAnchors()).toEqual([])
    await waitPressedCount(1)
    expect(await vmSvg()).toBe(before)
    style = await waitReshapeStyle({ curveDisabled: false, pointDisabled: false })
    expect(style.curveDisabled).toBe(false)
    expect(style.pointDisabled).toBe(false)
    // Shift+click the far anchor back on: multi latent returns exactly.
    await page.keyboard.down('Shift')
    await page.mouse.click(farHandle.x, farHandle.y)
    await page.keyboard.up('Shift')
    await page.waitForTimeout(700)
    await waitPressedCount(3)
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    expect(await vmSvg()).toBe(before)

    // Delete button targets BOTH with nondegenerate 4+ anchors: 4 -> 2
    // (one cubic remains), bytes change, slot stable, Undo restores exact
    // bytes + latent selection with no object loss.
    await page.getByTestId('delete-reshape-point').click()
    await page.waitForTimeout(900)
    const deletedBytes = await vmSvg()
    expect(deletedBytes).not.toBe(before)
    const geomDeleted = await objectGeometry()
    expect(geomDeleted.anchors).toHaveLength(2)
    expect(anchorsMatch(geomDeleted.anchors, [{ x: 120, y: 150 }, { x: 180, y: 190 }])).toBe(true)
    expect(await vmTargetStable()).toEqual({ name: 'MaskV7', costumes: 1, current: 0 })
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, previewBefore, { timeout: 15_000 })
    expect(await vmSvg()).toBe(before)
    const geomRestored = await objectGeometry()
    expect(geomRestored.anchors).toHaveLength(4)
    expect(anchorsMatch(geomRestored.anchors, [{ x: 120, y: 150 }, { x: 180, y: 190 }, { x: 240, y: 230 }, { x: 300, y: 270 }])).toBe(true)
    await waitPressedCount(3)
    expect(await pressedAnchors()).toEqual([w3.index])
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    expect(await vmTargetStable()).toEqual({ name: 'MaskV7', costumes: 1, current: 0 })
  }, 240_000)
})
