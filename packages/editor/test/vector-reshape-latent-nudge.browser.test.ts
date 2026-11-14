// Focused durable test: latent handle-only reshape selection still acts.
//
// Reuses the S-curve fixture and the real-UI helper flow from
// vector-reshape-mask-adversarial.browser.test.ts:
// full-select two curves, then Shift the first curve off, leaving the latent
// state middle mask4 (handle-only) + far mask3. One leg proves ArrowRight
// nudges BOTH middle and far by the same dx while the first anchor stays
// put; the native Paper oracle proves segment.selected is any-bit; Undo
// restores exact bytes with the aria anchor unpressed / handles pressed.
// Pointed/Curved/delete legs are split out (reported below): the delete
// affordance label proves both anchors are action targets without mutating
// the 3-anchor S (deleting 2 of 3 would be an invalid shape), and the pure
// helpers prove style/delete target lists include the latent anchor.
//
// Split report: pointed/curved UI mutation on the latent pair is deferred —
// the S-curve has only 3 anchors so deleting/styling the latent pair is
// either a no-op guard or a shape change that needs its own 4-anchor
// fixture; the action-index unit leg below already proves both flats are
// targeted. At least the nudge leg is fully implemented here.
//
// Read-only discipline: the UI leg ends with Undo so the VM ends where it
// started. Port 4604 (surveyed free 2026-11-13; adversarial file owns 4603).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4604
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const S_D = 'M180,150 C210,150 210,190 240,190 C270,190 270,230 300,230'
const sSvg = (inner: string) => `${HEAD}${inner}</svg>`
const S_OPEN = sSvg(`<path d="${S_D}" fill="none" stroke="#111111" stroke-width="2"/>`)

function buildSb3(): Buffer {
  const bytes = new TextEncoder().encode(S_OPEN)
  const hash = md5(bytes)
  const project = {
    targets: [
      {
        isStage: false, name: 'MaskA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'm-open', assetId: hash, md5ext: `${hash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'latent-nudge', agent: 'latent-nudge' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), [`${hash}.svg`]: bytes }))
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
    const tgt = vm.getTarget('MaskA')
    const cost = tgt.costumes[0]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  })
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

async function fullSelect() {
  const surf = await surfaceRect()
  await marqueeSelect(surf.x + 4, surf.y + 4, surf.right - 4, surf.bottom - 4)
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

async function curveBandBetweenFirstTwoAnchors() {
  return curveBandBetweenAnchors(0, 1)
}

describe('vector reshape latent nudge (focused)', () => {
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

  it('unit: any-bit action flats map 1/2/4/6/7 and filter controls', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    const r = await page.evaluate(async () => {
      const masks = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-handle-masks.ts')
      // Every non-zero flag 1..7 counts as segment-selected; point-bit only for display.
      const flats = masks.reshapeSelectedSegmentFlats({ 0: 1, 2: 2, 4: 4, 6: 6, 8: 7, 10: 3, 12: 5 })
      const pointProj = masks.reshapeHandleMasksToIndices({ 0: 1, 2: 2, 4: 4, 6: 6, 8: 7, 10: 3, 12: 5 })
      // Live points: anchors 0/2/4 + control slot 3 (owned by anchor 2).
      const points = [
        { index: 0, x: 0, y: 0, kind: 'anchor' },
        { index: 1, x: 1, y: 0, kind: 'control', relatedAnchorIndex: 0 },
        { index: 2, x: 2, y: 0, kind: 'anchor' },
        { index: 3, x: 3, y: 0, kind: 'control', relatedAnchorIndex: 2 },
        { index: 4, x: 4, y: 0, kind: 'anchor' },
      ] as any
      const liveAll = masks.liveReshapeActionIndices(points, { 0: 2, 2: 4, 4: 6 })
      // Control-slot keys never act even when a mask key names them.
      const liveControlKey = masks.liveReshapeActionIndices(points, { 3: 7 } as any)
      // Junk/zero keys drop.
      const junk = masks.reshapeSelectedSegmentFlats({ 2: 4 } as any)
      const junkLive = masks.liveReshapeActionIndices(points, { 99: 7 } as any)
      return { flats, pointProj, liveAll, liveControlKey, junk, junkLive }
    })
    expect(r.flats).toEqual([0, 2, 4, 6, 8, 10, 12])
    expect(r.pointProj).toEqual([0, 8, 10, 12])
    expect(r.liveAll).toEqual([0, 2, 4])
    expect(r.liveControlKey).toEqual([])
    expect(r.junk).toEqual([2])
    expect(r.junkLive).toEqual([])
  }, 60_000)

  it('Paper oracle: handle-only residual still counts as segment.selected', async () => {
    let paperSrc = ''
    for (const p of [join(root, 'node_modules', 'paper', 'dist', 'paper-full.js'), join(root, '..', 'node_modules', 'paper', 'dist', 'paper-full.js')]) {
      try { paperSrc = await readFile(p, 'utf8'); break } catch { /* next */ }
    }
    if (!paperSrc) throw new Error('INVALID: paper-full.js not found')
    const ctx = await (browser as any).newContext()
    const oracle = await ctx.newPage()
    await oracle.setContent('<!doctype html><html><body><canvas id="c" width="400" height="300"></canvas></body></html>')
    await oracle.addScriptTag({ content: paperSrc })
    const result = await oracle.evaluate(() => {
      const paper = (window as any).paper
      paper.setup('c')
      const S = (pt: number[], hi: number[] | null, ho: number[] | null) =>
        new paper.Segment(new paper.Point(pt[0], pt[1]), hi ? new paper.Point(hi[0], hi[1]) : null, ho ? new paper.Point(ho[0], ho[1]) : null)
      const path = new paper.Path()
      path.add(S([20, 20], null, [40, 0])); path.add(S([100, 80], [-40, 0], [40, 60])); path.add(S([180, 140], [-40, 0], null))
      path.curves[0].selected = true; path.curves[1].selected = true
      path.curves[0].selected = false
      // Latent state under test: middle handle-only 4, far 3 — both must
      // still report segment.selected true (any bit), first false.
      const mid: any = path.segments[1]
      const far: any = path.segments[2]
      const first: any = path.segments[0]
      return {
        midN: mid._selection ?? mid.selection, farN: far._selection ?? far.selection, firstN: first._selection ?? first.selection,
        midSel: mid.selected, farSel: far.selected, firstSel: first.selected,
      }
    })
    await ctx.close()
    // Paper truth for the shared-anchor cascade (matches the adversarial file).
    expect(result.midN).toBe(4)
    expect(result.farN).toBe(3)
    expect(result.firstN).toBe(0)
    // Any-bit getter parity: latent handle-only counts as selected.
    expect(result.midSel).toBe(true)
    expect(result.farSel).toBe(true)
    expect(result.firstSel).toBe(false)
  }, 60_000)

  it('UI: latent middle(4)+far(3) nudge moves both by same dx, first stays; undo exact', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    const before = await vmSvg()
    const previewBefore = await previewInner()

    // Two curves via curve bands (no explicit anchors), then Shift the
    // first off -> latent {middle:4, far:3}, first never selected.
    const band1 = await curveBandBetweenAnchors(0, 1)
    await marqueeSelect(band1.x0, band1.y0, band1.x1, band1.y1)
    await waitPressedCount(4)
    const band2 = await curveBandBetweenAnchors(1, 2)
    await page.keyboard.down('Shift')
    await marqueeSelect(band2.x0, band2.y0, band2.x1, band2.y1)
    await page.keyboard.up('Shift')
    await waitPressedCount(7)
    await page.keyboard.down('Shift')
    await marqueeSelect(band1.x0, band1.y0, band1.x1, band1.y1)
    await page.keyboard.up('Shift')
    await waitPressedCount(3)
    const order = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)
    if (order.length !== 3) throw new Error(`INVALID: expected 3 S anchors, got ${order.length}`)
    const [first, middle, far] = order as [Handle, Handle, Handle]
    expect(await pressedAnchors()).toEqual([far.index])
    expect((await allHandles()).filter((h) => h.control && h.pressed)).toHaveLength(2)
    // Delete affordance proves both flats are action targets without mutating.
    const delLabel = await page.getByTestId('delete-reshape-point').getAttribute('aria-label')
    expect(delLabel).toMatch(/2 selected points/)
    expect(await vmSvg()).toBe(before)

    const bx = { first: first.x, middle: middle.x, far: far.x }
    const by = { first: first.y, middle: middle.y, far: far.y }

    // Nudge right: both latent-selected anchors travel by the same dx.
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(900)
    const nudged = await vmSvg()
    expect(nudged).not.toBe(before)
    await waitPressedCount(3)
    const after = (await allHandles()).filter((h) => !h.control).sort((a, b) => a.y - b.y)
    const [aFirst, aMid, aFar] = after as [Handle, Handle, Handle]
    const dFirst = aFirst.x - bx.first
    const dMid = aMid.x - bx.middle
    const dFar = aFar.x - bx.far
    expect(Math.abs(dFirst)).toBeLessThan(1.0)
    expect(dMid).toBeGreaterThan(0.5)
    expect(dFar).toBeGreaterThan(0.5)
    expect(Math.abs(dMid - dFar)).toBeLessThan(1.5)
    expect(Math.abs(aMid.y - by.middle)).toBeLessThan(1.5)
    expect(Math.abs(aFar.y - by.far)).toBeLessThan(1.5)
    expect(await pressedAnchors()).toEqual([far.index])

    // Undo restores exact bytes; aria keeps latent shape (middle anchor
    // unpressed, its out-handle + far in-handle pressed).
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await vmSvg()).toBe(before)
    await waitPressedCount(3)
    expect(await pressedAnchors()).toEqual([far.index])
    const aria = await page.evaluate(() => {
      const get = (i: number) => document.querySelector(`[data-point-index="${i}"]`)?.getAttribute('aria-pressed') ?? null
      return { mAnchor: get(2), fAnchor: get(5), mOut: get(4), fIn: get(6) }
    })
    expect(aria.mAnchor).toBe('false')
    expect(aria.fAnchor).toBe('true')
    expect(aria.mOut).toBe('true')
    expect(aria.fIn).toBe('true')
  }, 180_000)
})
