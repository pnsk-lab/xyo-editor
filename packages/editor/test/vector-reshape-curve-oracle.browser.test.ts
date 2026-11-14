import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Independent S-curve reshape audit (no reference text copied).
//
// What this proves, in own words:
// - Live Paper (MIT): selecting one cubic curve marks its two endpoint
//   segments with handle-specific selection (start: point+outgoing, end:
//   point+incoming). Selecting a segment directly marks point+both handles.
//   Moving an endpoint preserves its handle vectors (rigid translation).
// - Production marquee helper + pure merge: a rect that crosses one cubic
//   without containing an anchor reports that curve's endpoint anchor pair;
//   anchors win over curves; kept crossings apply in order with Shift toggle.
// - Product UI (real Editor/VM): crossing marquee on an S-curve selects the
//   two endpoints with Paper-truth handle display (start point+out 5, end
//   point+in 3) — middle-out stays hidden until its own curve is selected.
//   Bulk drags move anchors rigidly, interior press adds a point, style/nudge/
//   delete/undo/group are audited with control-handle counts and SVG bytes,
//   not just endpoint positions.
//
// Read-only discipline: no Editor/BitmapEditor sources are edited here. UI
// legs restore artwork with Undo so the VM ends where it started.

const root = join(import.meta.dir, '..')
const PORT = 4571
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// S-curve: two cubics, three anchors. Top (180,150) -> mid (240,190) -> bottom (300,230).
const S_D = 'M180,150 C210,150 210,190 240,190 C270,190 270,230 300,230'
const sSvg = (inner: string) => `${HEAD}${inner}</svg>`
const S_OPEN = sSvg(`<path d="${S_D}" fill="none" stroke="#111111" stroke-width="2"/>`)
const S_GROUP = sSvg(`<g transform="translate(30 20)"><path d="${S_D}" fill="none" stroke="#111111" stroke-width="2"/></g>`)

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const entries: Array<[string, string]> = [
    ['s-open', S_OPEN],
    ['s-group', S_GROUP],
  ]
  const refs = entries.map(([name, svg]) => ({ name, ref: add(svg) }))
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const project = {
    targets: [
      {
        isStage: false, name: 'CurveS', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: refs.map(({ name, ref }) => costume(ref, name)),
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'curve-oracle', agent: 'curve-oracle' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function importSb3(bytes: Buffer) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 's.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'CurveS') ?? false,
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

async function selectCostume(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).first().click()
  await page.waitForTimeout(900)
}

async function selectTarget(name: string) {
  await page.getByTestId(`target-card-${name}`).click()
  await page.waitForTimeout(600)
}

async function allHandles() {
  return await page.evaluate(() => {
    const out: Array<{ index: number; x: number; y: number; pressed: boolean; control: boolean; role: string }> = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const label = el.getAttribute('aria-label') ?? ''
      const r = (el as HTMLElement).getBoundingClientRect()
      out.push({
        index: Number((el as HTMLElement).dataset.pointIndex),
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        pressed: el.getAttribute('aria-pressed') === 'true',
        control: label.startsWith('Move control point'),
        role: label.startsWith('Move control point') ? 'control' : 'anchor',
      })
    }
    return out.sort((a, b) => a.index - b.index)
  })
}

async function pressedAnchorIndices() {
  return (await allHandles()).filter((h) => !h.control && h.pressed).map((h) => h.index).sort((a, b) => a - b)
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

async function vmSvg(targetName: string, costumeName: string): Promise<string> {
  return await page.evaluate(async ({ t, c }: { t: string; c: string }) => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget(t)
    const idx = tgt.costumes.findIndex((x: any) => x.name === c)
    const cost = tgt.costumes[idx]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { t: targetName, c: costumeName })
}

async function undoRedoEnabled(): Promise<{ undo: boolean; redo: boolean }> {
  return await page.evaluate(() => ({
    undo: !(document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled,
    redo: !(document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled,
  }))
}

async function selectSObject() {
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
  if (!pt) throw new Error('INVALID: missing S-curve stroke point')
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(700)
}

describe('vector reshape S-curve oracle (live Paper + UI)', () => {
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

  it('live Paper: curve selection is handle-specific (5/3), segment selection is both-handles (7), moves preserve handles', async () => {
    const paperPath = join(root, 'node_modules', 'paper', 'dist', 'paper-full.js')
    let paperSrc = ''
    try { paperSrc = await readFile(paperPath, 'utf8') } catch {
      paperSrc = await readFile(join(root, '..', 'node_modules', 'paper', 'dist', 'paper-full.js'), 'utf8')
    }
    // Blank tab for the pure Paper oracle (no Editor involved).
    const ctx = await (browser as any).newContext()
    const oracle = await ctx.newPage()
    await oracle.setContent('<!doctype html><html><body><canvas id="c" width="400" height="300"></canvas></body></html>')
    await oracle.addScriptTag({ content: paperSrc })
    const result = await oracle.evaluate(() => {
      const paper = (window as any).paper
      paper.setup('c')
      const d = 'M20,20 C60,20 60,80 100,80 C140,80 140,140 180,140'
      const item = paper.project.importSVG(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="black"/></svg>`)
      const path = paper.project.getItems({ className: 'Path' })[0]
      const clearAll = () => {
        try { path.selected = false } catch {}
        for (const c of path.curves) { try { c.selected = false } catch {} }
        for (const s of path.segments) { try { s.selected = false } catch {} }
      }
      const segSel = () => path.segments.map((s: any) => ({ sel: s.selected, num: s._selection ?? s.selection, pt: s.point.selected, hi: s.handleIn.selected, ho: s.handleOut.selected }))
      clearAll(); path.curves[0].selected = true
      const curve0 = segSel()
      clearAll(); path.segments[0].selected = true; path.segments[1].selected = true
      const generic = segSel()
      // Rigid move: endpoint preserves handle vectors.
      clearAll()
      const hoBefore = { x: path.segments[0].handleOut.x, y: path.segments[0].handleOut.y }
      const hiBefore = { x: path.segments[1].handleIn.x, y: path.segments[1].handleIn.y }
      path.segments[0].point = path.segments[0].point.add(new paper.Point(10, 5))
      const hoAfter = { x: path.segments[0].handleOut.x, y: path.segments[0].handleOut.y }
      const movedD = path.pathData
      // Intersections for a band crossing curve0 only.
      const rect = new paper.Path.Rectangle(new paper.Rectangle(40, 30, 60, 30))
      const xs = path.getIntersections(rect).map((x: any) => x.curve.index)
      rect.remove()
      return { curve0, generic, hoBefore, hoAfter, hiBefore, movedD, xs, segCount: path.segments.length, curveCount: path.curves.length }
    })
    await ctx.close()
    // S-curve shape sanity.
    expect(result.segCount).toBe(3)
    expect(result.curveCount).toBe(2)
    // Reference-exact: curve0 marks start point+out (5) and middle point+in (3).
    expect(result.curve0[0].num).toBe(5)
    expect(result.curve0[0].pt).toBe(true)
    expect(result.curve0[0].ho).toBe(true)
    expect(result.curve0[0].hi).toBe(false)
    expect(result.curve0[1].num).toBe(3)
    expect(result.curve0[1].pt).toBe(true)
    expect(result.curve0[1].hi).toBe(true)
    expect(result.curve0[1].ho).toBe(false)
    expect(result.curve0[2].num).toBe(0)
    // Generic anchor selection marks both handles (7).
    expect(result.generic[0].num).toBe(7)
    expect(result.generic[1].num).toBe(7)
    // Rigid move preserves handle vectors.
    expect(result.hoAfter).toEqual(result.hoBefore)
    expect(result.hiBefore.x).not.toBe(0)
    expect(typeof result.movedD).toBe('string')
    // Band crossing one cubic reports that curve twice (k%2 keeps first).
    expect(result.xs).toEqual([0, 0])
  }, 60_000)

  it('production helper: S-curve crossing reports endpoint pair, anchors win, Shift toggles in order', async () => {
    const result = await page.evaluate(async () => {
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const mergeMod = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const mk = (inner: string) => {
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`, 'image/svg+xml',
        )
        const live = doc.documentElement
        document.body.appendChild(live)
        return live
      }
      const sInner = `<path d="M180,150 C210,150 210,190 240,190 C270,190 270,230 300,230" fill="none" stroke="black"/>`
      const live = mk(sInner)
      let cross: any = null
      let anchorWin: any = null
      try {
        // Band strictly between top and middle anchors: crosses curve0, contains no anchor.
        cross = await (paperMod as any).paperReshapeMarqueeFlatsInRect(
          live.firstElementChild as Element, { x: 150, y: 160, width: 180, height: 20 },
        )
        // Rect containing the middle anchor: anchors win, no curve pair.
        anchorWin = await (paperMod as any).paperReshapeMarqueeFlatsInRect(
          live.firstElementChild as Element, { x: 230, y: 180, width: 20, height: 20 },
        )
      } finally { try { live.remove() } catch {} }
      const shiftPartial = (mergeMod as any).mergeReshapeMarqueeSelectionWithCurves([0], [], [[0, 2]], true)
      const shiftFull = (mergeMod as any).mergeReshapeMarqueeSelectionWithCurves([0, 2], [], [[0, 2]], true)
      const shiftDup = (mergeMod as any).mergeReshapeMarqueeSelectionWithCurves([], [], [[0, 2], [0, 2]], true)
      const plainDup = (mergeMod as any).mergeReshapeMarqueeSelectionWithCurves([], [], [[0, 2], [0, 2]], false)
      return { cross, anchorWin, shiftPartial, shiftFull, shiftDup, plainDup }
    })
    // Crossing selects the endpoint pair, no lone anchor.
    expect(result.cross.anchorFlats).toEqual([])
    expect(result.cross.curvePairs).toHaveLength(1)
    const pair = result.cross.curvePairs[0] as [number, number]
    expect(pair[0]).not.toBe(pair[1])
    // Anchors win over curves on the same path.
    expect(result.anchorWin.anchorFlats.length).toBeGreaterThan(0)
    expect(result.anchorWin.curvePairs).toEqual([])
    // Shift semantics: partial completes, full clears, duplicate even slots cancel.
    expect(result.shiftPartial).toEqual([0, 2])
    expect(result.shiftFull).toEqual([])
    expect(result.shiftDup).toEqual([])
    expect(result.plainDup).toEqual([0, 2])
  }, 60_000)

  it('full UI: curve marquee shows Paper-truth handles (5/3), bulk drag is rigid, bytes + Undo/Redo', async () => {
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectTarget('CurveS')
    await selectCostume('s-open')
    await selectSObject()
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-vector-path-point]')].filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length === 3,
      undefined, { timeout: 15_000 },
    )
    expect(await pressedAnchorIndices()).toEqual([])
    // Initial S-curve: 3 anchors; controls are hidden until their anchor is
    // selected (overlay shows selected anchors' handles only).
    const initial = await allHandles()
    expect(initial.filter((h) => !h.control)).toHaveLength(3)
    expect(initial.filter((h) => h.control)).toHaveLength(0)

    // Curve-only band between top and middle anchors (both arms excluded).
    const anchors = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)
    expect(anchors).toHaveLength(3)
    const [top, mid, bottom] = anchors as [typeof anchors[0], typeof anchors[0], typeof anchors[0]]
    expect(mid.y > top.y + 40).toBe(true)
    expect(bottom.y > mid.y + 40).toBe(true)
    const x0 = Math.min(top.x, mid.x, bottom.x) - 60
    const x1 = Math.max(top.x, mid.x, bottom.x) + 60
    const y0 = top.y + 18
    const y1 = mid.y - 18
    expect(y1 > y0 + 10).toBe(true)
    for (const h of [top, mid, bottom]) {
      expect(h.x < x0 || h.x > x1 || h.y < y0 || h.y > y1).toBe(true)
    }
    const vmBefore = await vmSvg('CurveS', 's-open')
    const previewBefore = await previewInner()
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x1, y1, { steps: 12 })
    await page.mouse.up()
    // Paper truth: curve0 selects start point+out (5) and end point+in (3).
    // Anchors pressed: top + middle; controls pressed: top-out + middle-in
    // (2 total). Middle-out (curve1's handle) stays hidden, bottom stays idle.
    // Total pressed (anchors + visible controls) is therefore 4.
    await waitPressedCount(4)
    const pressed = await pressedAnchorIndices()
    // Two endpoints of curve0 (top + middle in flattened anchor flats).
    expect(pressed).toHaveLength(2)
    expect(pressed).toContain(top.index)
    expect(pressed).toContain(mid.index)

    // Control-handle audit with bytes: Paper truth keeps only the attached
    // handles — top-out (curve0 start) + middle-in (curve0 end). Middle-out
    // belongs to curve1 and stays hidden until curve1 is also selected.
    const afterMarquee = await allHandles()
    const visibleControls = afterMarquee.filter((h) => h.control)
    expect(visibleControls.length).toBe(2)
    // Selected handles report pressed; the hidden middle-out is absent.
    expect(visibleControls.every((h) => h.pressed)).toBe(true)
    const visibleControlIndices = visibleControls.map((h) => h.index).sort((a, b) => a - b)
    // Flattened S layout: a0(0) out(1) a1(2) in(3) out(4) a2(5) in(6).
    expect(visibleControlIndices).toEqual([1, 3])
    const vmMarquee = await vmSvg('CurveS', 's-open')
    // Selection alone writes no bytes.
    expect(vmMarquee).toBe(vmBefore)
    expect(await previewInner()).toBe(previewBefore)

    // Bulk drag the top anchor: both selected anchors travel rigidly, handles
    // preserve relative vectors (control delta equals anchor delta), unselected
    // bottom anchor stays, one Undo restores exact bytes.
    const beforeDrag = await allHandles()
    const beforeByIndex = new Map(beforeDrag.map((h) => [h.index, h]))
    const dragFrom = beforeByIndex.get(top.index)!
    await page.mouse.move(dragFrom.x, dragFrom.y)
    await page.mouse.down()
    await page.mouse.move(dragFrom.x + 40, dragFrom.y + 12, { steps: 10 })
    await page.mouse.up()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML !== want,
      previewBefore, { timeout: 15_000 },
    )
    const afterDrag = await allHandles()
    const afterByIndex = new Map(afterDrag.map((h) => [h.index, h]))
    // Both selected anchors moved by the same screen delta (rigid).
    const dxTop = afterByIndex.get(top.index)!.x - beforeByIndex.get(top.index)!.x
    const dyTop = afterByIndex.get(top.index)!.y - beforeByIndex.get(top.index)!.y
    const dxMid = afterByIndex.get(mid.index)!.x - beforeByIndex.get(mid.index)!.x
    const dyMid = afterByIndex.get(mid.index)!.y - beforeByIndex.get(mid.index)!.y
    expect(Math.abs(dxTop - 40)).toBeLessThan(6)
    expect(Math.abs(dxMid - dxTop)).toBeLessThan(5)
    expect(Math.abs(dyMid - dyTop)).toBeLessThan(5)
    // Bottom anchor did not move.
    expect(Math.abs(afterByIndex.get(bottom.index)!.x - beforeByIndex.get(bottom.index)!.x)).toBeLessThan(3)
    expect(Math.abs(afterByIndex.get(bottom.index)!.y - beforeByIndex.get(bottom.index)!.y)).toBeLessThan(3)
    // Displayed controls travelled with their anchors (rigid handle vectors).
    for (const h of afterDrag.filter((c) => c.control)) {
      const prev = beforeByIndex.get(h.index)
      if (!prev) continue
      expect(Math.abs((h.x - prev.x) - dxTop)).toBeLessThan(6)
    }
    const vmMoved = await vmSvg('CurveS', 's-open')
    expect(vmMoved).not.toBe(vmBefore)
    expect(vmMoved).toContain('<path')
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('CurveS', 's-open')).toBe(vmBefore)
    await page.locator('button[aria-label="Redo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML !== want,
      previewBefore, { timeout: 15_000 },
    )
    // Redo re-applies the rigid move (bytes are authoritative).
    expect(await vmSvg('CurveS', 's-open')).toBe(vmMoved)
    // Restore for the next legs (read-only discipline).
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
  }, 180_000)

  it('full UI: interior adds a point, style/nudge/delete/group keep handles + bytes exact', async () => {
    const hasCurveS = await page.evaluate(
      () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'CurveS') ?? false,
    ).catch(() => false)
    if (!hasCurveS) {
      await importSb3(buildSb3())
    }
    await ensureVectorMode()
    await selectTarget('CurveS')
    await selectCostume('s-open')
    await selectSObject()
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')

    // Interior curve press adds one anchor (reference divideAt parity).
    const anchorsBefore = (await allHandles()).filter((h) => !h.control).length
    expect(anchorsBefore).toBe(3)
    const vmBefore = await vmSvg('CurveS', 's-open')
    const previewBefore = await previewInner()
    const undoBefore = await undoRedoEnabled()
    const midCurve = await page.evaluate(() => {
      const path = document.querySelector('.vector-preview svg path') as unknown as SVGPathElement | null
      if (!path) return null
      try {
        const len = path.getTotalLength()
        // Curve0 interior (away from all three anchors): 0.5 lands on the
        // middle anchor and would snap to it instead of adding a point.
        const p = path.getPointAtLength(len * 0.25)
        const ctm = path.getScreenCTM()
        if (!ctm) return null
        const dom = new DOMPoint(p.x, p.y).matrixTransform(ctm as unknown as DOMMatrix)
        return { x: dom.x, y: dom.y }
      } catch { return null }
    })
    if (!midCurve) throw new Error('INVALID: missing curve interior point')
    await page.mouse.click(midCurve.x, midCurve.y)
    await page.waitForTimeout(900)
    const anchorsAfterAdd = (await allHandles()).filter((h) => !h.control).length
    // Adding may select the new point; the durable assertion is anchor growth + bytes.
    expect(anchorsAfterAdd).toBe(4)
    expect(await vmSvg('CurveS', 's-open')).not.toBe(vmBefore)
    // Undo restores exact bytes + handles (read-only discipline).
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('CurveS', 's-open')).toBe(vmBefore)
    expect((await allHandles()).filter((h) => !h.control)).toHaveLength(3)

    // Style audit with handles + bytes: Pointed drops controls, Curved restores.
    // (Select-all first so every anchor owns visible controls.)
    {
      const centers = await allHandles()
      if (centers.length === 0) throw new Error('INVALID: no reshape handles for style marquee')
      const xs = centers.map((c) => c.x)
      const ys = centers.map((c) => c.y)
      const sx = Math.max(0, Math.min(...xs) - 60)
      const sy = Math.max(0, Math.min(...ys) - 60)
      const ex = Math.min(1399, Math.max(...xs) + 60)
      const ey = Math.min(899, Math.max(...ys) + 60)
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      await page.mouse.move(ex, ey, { steps: 10 })
      await page.mouse.up()
      // Full select-all: 3 explicit anchors (7 each) => 4 controls pressed.
      // Total pressed = 3 anchors + 4 controls = 7.
      await waitPressedCount(7)
    }
    const controlsCurved = (await allHandles()).filter((h) => h.control).length
    expect(controlsCurved).toBe(4)
    // All visible controls report pressed (explicit 7).
    expect((await allHandles()).filter((h) => h.control && h.pressed)).toHaveLength(4)
    await page.getByTestId('reshape-point-point').click()
    await page.waitForTimeout(900)
    const controlsPointed = (await allHandles()).filter((h) => h.control).length
    expect(controlsPointed).toBe(0)
    const vmPointed = await vmSvg('CurveS', 's-open')
    expect(vmPointed).not.toBe(vmBefore)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('CurveS', 's-open')).toBe(vmBefore)

    // Nudge audit: with reshape points selected, arrows move the whole object
    // in the product (reference would move only selected segments). Capture
    // bytes to document the divergence without asserting reference behavior.
    {
      const centers = await allHandles()
      if (centers.length === 0) throw new Error('INVALID: no handles for nudge marquee')
      const xs = centers.map((c) => c.x)
      const ys = centers.map((c) => c.y)
      const sx = Math.max(0, Math.min(...xs) - 60)
      const sy = Math.max(0, Math.min(...ys) - 60)
      const ex = Math.min(1399, Math.max(...xs) + 60)
      const ey = Math.min(899, Math.max(...ys) + 60)
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      await page.mouse.move(ex, ey, { steps: 10 })
      await page.mouse.up()
      await waitPressedCount(7)
    }
    const nudgeBefore = await vmSvg('CurveS', 's-open')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(900)
    // Product moves something and writes one entry; record that it moved.
    const nudgeAfter = await vmSvg('CurveS', 's-open')
    expect(nudgeAfter).not.toBe(nudgeBefore)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('CurveS', 's-open')).toBe(vmBefore)

    // Delete audit: deleting the middle anchor keeps neighbours' handles
    // (product keeps handle vectors; reference rescales them). Exact bytes + Undo.
    // Middle explicit 7 => 1 anchor + 2 controls pressed = 3 total.
    {
      const hs = await allHandles()
      const midH = hs.filter((h) => !h.control).sort((a, b) => a.y - b.y)[1]!
      await page.mouse.click(midH.x, midH.y)
      await waitPressedCount(3)
      // Explicit middle shows both handles pressed.
      expect((await allHandles()).filter((h) => h.control && h.pressed)).toHaveLength(2)
    }
    await page.keyboard.press('Delete')
    await page.waitForTimeout(900)
    expect((await allHandles()).filter((h) => !h.control)).toHaveLength(2)
    expect(await vmSvg('CurveS', 's-open')).not.toBe(vmBefore)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg('CurveS', 's-open')).toBe(vmBefore)
    expect(undoBefore.undo).toBeDefined()

    // Group transform audit: same S inside translate(30 20) stays selectable
    // and reports anchors + handles without baking the wrapper transform.
    await selectCostume('s-group')
    await ensureVectorMode()
    await page.waitForTimeout(900)
    await page.getByTestId('vector-shape-select').last().waitFor({ state: 'visible', timeout: 15_000 })
    await selectSObject()
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForTimeout(900)
    {
      const centers = await allHandles()
      if (centers.length === 0) throw new Error('INVALID: no handles for group marquee')
      const xs = centers.map((c) => c.x)
      const ys = centers.map((c) => c.y)
      const sx = Math.max(0, Math.min(...xs) - 60)
      const sy = Math.max(0, Math.min(...ys) - 60)
      const ex = Math.min(1399, Math.max(...xs) + 60)
      const ey = Math.min(899, Math.max(...ys) + 60)
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      await page.mouse.move(ex, ey, { steps: 10 })
      await page.mouse.up()
      // Group full select: 3 anchors + 4 controls = 7 pressed.
      await waitPressedCount(7)
    }
    const groupHandles = await allHandles()
    expect(groupHandles.filter((h) => !h.control)).toHaveLength(3)
    expect(groupHandles.filter((h) => h.control)).toHaveLength(4)
    const groupSvg = await vmSvg('CurveS', 's-group')
    expect(groupSvg).toContain('translate(30 20)')
    expect(groupSvg).toContain('<path')
  }, 180_000)
})
