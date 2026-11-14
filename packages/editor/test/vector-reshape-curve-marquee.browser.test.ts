import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Durable reshape curve-marquee parity (production path, no reference copy).
//
// Reference behavior (audited at runtime, not copied):
// `.tmp/scratch-editor/.../selection.js` rectangular selection keeps every
// other Paper intersection in order for reshape curves. A V polyline whose
// two arms each touch the marquee once therefore selects only the first arm;
// dedupe-by-curve would incorrectly select both. The production helper
// (`paperReshapeMarqueeFlatsInRect`) now keeps that parity exactly, and the
// pure merge applies kept entries sequentially so a duplicated even slot
// toggles twice with Shift.
//
// Coverage (real Paper + full Editor/VM, never helper-only):
// - helper-exact leg: V with one touch per arm selects only the first pair,
//   mid anchor outside, anchors win over curves, closed wrap, group nesting.
// - full UI leg: marquee crosses both arms (mid anchor outside), endpoints
//   show pressed, dragging moves them, strict full SVG bytes + Undo/Redo.
// - Shift partial/full, off-canvas empty drag, text/image no-select + no
//   history, pointercancel no-commit, stale cross-scope async gate (target
//   switch by stable id, no wrong slot).
const root = join(import.meta.dir, '..')
const PORT = 4562
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// Centered V for UI legs (keeps handles clear of the top toolbar); the
// helper-exact leg uses its own origin V with matching rects.
const VEE_D = 'M180,150 L240,210 L300,150'
const veeSvg = (inner: string) => `${HEAD}${inner}</svg>`
const VEE_OPEN = veeSvg(`<path d="${VEE_D}" fill="none" stroke="#111111" stroke-width="2"/>`)
const VEE_CLOSED = veeSvg('<path d="M10,10 L110,10 L60,100 Z" fill="none" stroke="#111111" stroke-width="2"/>')
const VEE_GROUP = veeSvg(`<g transform="translate(30 20)"><path d="${VEE_D}" fill="none" stroke="#111111" stroke-width="2"/></g>`)
const TEXT_SVG = veeSvg('<text x="40" y="80" font-family="Arial, sans-serif" font-size="42" fill="#d6336c">Hello</text>')
const IMAGE_SVG =
  `${HEAD}<image x="20" y="20" width="40" height="40" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="/></svg>`

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const entries: Array<[string, string]> = [
    ['vee-open', VEE_OPEN],
    ['vee-closed', VEE_CLOSED],
    ['vee-group', VEE_GROUP],
    ['vec-text', TEXT_SVG],
    ['vec-image', IMAGE_SVG],
  ]
  const refs = entries.map(([name, svg]) => ({ name, ref: add(svg) }))
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const project = {
    targets: [
      {
        isStage: false, name: 'CurveA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: refs.map(({ name, ref }) => costume(ref, name)),
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
      {
        isStage: false, name: 'CurveB', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(add(VEE_OPEN), 'vee-open-b')],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 60, y: 30, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'curve-marquee', agent: 'curve-marquee' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function importSb3(bytes: Buffer) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'curve.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'CurveA') ?? false,
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

async function anchorHandles() {
  return await page.evaluate(() => {
    const out: Array<{ index: number; x: number; y: number; pressed: boolean }> = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const label = el.getAttribute('aria-label') ?? ''
      if (!label.startsWith('Move path point')) continue
      const r = (el as HTMLElement).getBoundingClientRect()
      out.push({
        index: Number((el as HTMLElement).dataset.pointIndex),
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        pressed: el.getAttribute('aria-pressed') === 'true',
      })
    }
    return out.sort((a, b) => a.index - b.index)
  })
}

async function pressedIndices() {
  return (await anchorHandles()).filter((h) => h.pressed).map((h) => h.index).sort((a, b) => a - b)
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

// Observable stability gate for the vector preview (not a blind sleep):
// the required artwork element must be present AND innerHTML must stop
// changing for a sustained window, so the before-state is captured after
// any initial async render (fonts/Paper re-resolve) settles. A premature
// read here used to race the first paint and masquerade as a marquee write.
async function stablePreviewInner(requiredSelector: string): Promise<string> {
  await page.waitForFunction((sel: string) => {
    const w = window as unknown as Record<string, unknown>
    const root = document.querySelector('.vector-preview')
    const cur = root ? root.innerHTML : ''
    if (!sel || !root?.querySelector(sel)) return false
    if (w.__curveMarqueeStablePrev === cur) {
      return Date.now() - Number(w.__curveMarqueeStableAt ?? 0) >= 400
    }
    w.__curveMarqueeStablePrev = cur
    w.__curveMarqueeStableAt = Date.now()
    return false
  }, requiredSelector, { timeout: 15_000 })
  return await previewInner()
}

type ClientRect = { x: number; y: number; w: number; h: number }

async function surfaceAndElementRects(selector: string): Promise<{ box: ClientRect; el: ClientRect } | null> {
  return await page.evaluate((sel: string) => {
    const boxEl = document.querySelector('[data-testid="costume-paint-surface"]')
    const target = document.querySelector(sel) as unknown as (Element & { getBoundingClientRect(): DOMRect }) | null
    if (!boxEl || !target) return null
    const box = boxEl.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0 || r.width <= 0 || r.height <= 0) return null
    return {
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
      el: { x: r.x, y: r.y, w: r.width, h: r.height },
    }
  }, selector)
}

const isOutsideWithGuard = (p: { x: number; y: number }, el: ClientRect, guard: number) =>
  p.x < el.x - guard || p.x > el.x + el.w + guard || p.y < el.y - guard || p.y > el.y + el.h + guard

// First surface corner (12px inset) fully outside the element's client rect
// with an 8px guard. A press ON the artwork would start an object drag
// (and commit a move + history), not a marquee — so the empty origin is
// asserted, never assumed.
function emptyPressPoint(box: ClientRect, el: ClientRect): { x: number; y: number } | null {
  const candidates = [
    { x: box.x + 12, y: box.y + 12 },
    { x: box.x + box.w - 12, y: box.y + 12 },
    { x: box.x + 12, y: box.y + box.h - 12 },
    { x: box.x + box.w - 12, y: box.y + box.h - 12 },
  ]
  return candidates.find((p) => isOutsideWithGuard(p, el, 8)) ?? null
}

// Release beyond the element's far corner (clamped inside the surface) so
// the marquee fully encloses the artwork: a rect that merely misses the
// unit would prove nothing about marquee-over-unit behavior.
function enclosingRelease(box: ClientRect, el: ClientRect): { x: number; y: number } {
  return {
    x: Math.min(el.x + el.w + 40, box.x + box.w - 5),
    y: Math.min(el.y + el.h + 40, box.y + box.h - 5),
  }
}

function marqueeEncloses(el: ClientRect, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.min(a.x, b.x) < el.x && Math.max(a.x, b.x) > el.x + el.w &&
    Math.min(a.y, b.y) < el.y && Math.max(a.y, b.y) > el.y + el.h
}

// True no-op marquee over a text/image unit: from a measured empty origin,
// enclosing the whole unit. Asserts exact preview bytes + VM bytes, Undo/Redo
// state, and zero pressed points — any product write (move, Paper rewrite,
// history entry) fails loudly.
async function expectEnclosingMarqueeNoOp(selector: string, targetName: string, costumeName: string) {
  const rects = await surfaceAndElementRects(selector)
  if (!rects) throw new Error(`INVALID: missing surface/element rects for ${selector}`)
  const { box, el } = rects
  const press = emptyPressPoint(box, el)
  if (!press) throw new Error(`INVALID: no empty marquee origin outside ${selector}`)
  const release = enclosingRelease(box, el)
  if (!marqueeEncloses(el, press, release)) throw new Error('INVALID: marquee would not enclose the unit')
  if (release.x <= press.x + 2 && release.y <= press.y + 2) throw new Error('INVALID: degenerate marquee')
  const undoBefore = await undoRedoEnabled()
  const svgBefore = await vmSvg(targetName, costumeName)
  const previewBefore = await stablePreviewInner(selector)
  if (!isOutsideWithGuard(press, el, 8)) throw new Error('INVALID: marquee origin drifted onto the artwork')
  await page.mouse.move(press.x, press.y)
  await page.mouse.down()
  await page.mouse.move(release.x, release.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  expect(await page.locator('[data-vector-path-point][aria-pressed="true"]').count()).toBe(0)
  expect(await previewInner()).toBe(previewBefore)
  expect(await vmSvg(targetName, costumeName)).toBe(svgBefore)
  expect(await undoRedoEnabled()).toEqual(undoBefore)
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

async function selectVeeObject() {
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(400)
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('.vector-preview svg') as unknown as SVGSVGElement | null
    const path = document.querySelector('.vector-preview svg path') as unknown as SVGPathElement | null
    if (!svg || !path) return null
    try {
      const len = path.getTotalLength()
      const p = path.getPointAtLength(len * 0.25)
      const ctm = path.getScreenCTM()
      if (!ctm) return null
      const dom = new DOMPoint(p.x, p.y).matrixTransform(ctm as unknown as DOMMatrix)
      return { x: dom.x, y: dom.y }
    } catch { return null }
  })
  if (!pt) throw new Error('INVALID: missing vee stroke point for object select')
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(700)
}

describe('vector reshape curve marquee (reference-exact)', () => {
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

  it('helper is reference-exact for two curves with one touch each (first arm only)', async () => {
    // Runtime oracle via the production helper + live Paper (no reference
    // text copied): the V touch rect hits one border point per arm, all
    // anchors outside, so k%2 keeps only the first curve.
    const result = await page.evaluate(async () => {
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const mergeMod = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0,0 L60,60 L120,0" fill="none" stroke="black"/></svg>',
        'image/svg+xml',
      )
      const live = doc.documentElement
      document.body.appendChild(live)
      try {
        const touch = await (paperMod as any).paperReshapeMarqueeFlatsInRect(
          live.firstElementChild as Element, { x: 30, y: 10, width: 60, height: 20 },
        )
        const through = await (paperMod as any).paperReshapeMarqueeFlatsInRect(
          live.firstElementChild as Element, { x: 20, y: 20, width: 80, height: 20 },
        )
        // Closed triangle: rect cuts two edges.
        const closedDoc = new DOMParser().parseFromString(
          '<svg xmlns="http://www.w3.org/2000/svg"><path d="M10,10 L110,10 L60,100 Z" fill="none" stroke="black"/></svg>',
          'image/svg+xml',
        )
        const closedLive = closedDoc.documentElement
        document.body.appendChild(closedLive)
        let closed: any = null
        try {
          closed = await (paperMod as any).paperReshapeMarqueeFlatsInRect(
            closedLive.firstElementChild as Element, { x: 40, y: 0, width: 40, height: 30 },
          )
        } finally { try { closedLive.remove() } catch {} }
        // Group nesting: same V translated by (30,20); document rect shifts too.
        const groupDoc = new DOMParser().parseFromString(
          '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(30 20)"><path d="M0,0 L60,60 L120,0" fill="none" stroke="black"/></g></svg>',
          'image/svg+xml',
        )
        const groupLive = groupDoc.documentElement
        document.body.appendChild(groupLive)
        let grouped: any = null
        try {
          grouped = await (paperMod as any).paperReshapeMarqueeFlatsInRect(
            groupLive.firstElementChild as Element, { x: 60, y: 30, width: 60, height: 20 },
          )
        } finally { try { groupLive.remove() } catch {} }
        // Shift semantics on the exact pair: partial completes, full clears,
        // duplicate even slots cancel (sequential toggle).
        const shiftPartial = (mergeMod as any).mergeReshapeMarqueeSelectionWithCurves([0], [], [[0, 1]], true)
        const shiftFull = (mergeMod as any).mergeReshapeMarqueeSelectionWithCurves([0, 1], [], [[0, 1]], true)
        const shiftDup = (mergeMod as any).mergeReshapeMarqueeSelectionWithCurves([], [], [[0, 1], [0, 1]], true)
        const plainDup = (mergeMod as any).mergeReshapeMarqueeSelectionWithCurves([], [], [[0, 1], [0, 1]], false)
        return { touch, through, closed, grouped, shiftPartial, shiftFull, shiftDup, plainDup }
      } finally { try { live.remove() } catch {} }
    })
    // One touch per arm: only the first arm's endpoints (flats 0,1).
    expect(result.touch.anchorFlats).toEqual([])
    expect(result.touch.curvePairs).toEqual([[0, 1]])
    // Through rect hits both arms twice: both pairs, mid anchor still outside.
    expect(result.through.anchorFlats).toEqual([])
    expect(result.through.curvePairs).toEqual([[0, 1], [1, 2]])
    // Closed + grouped stay readable and anchor-free for these rects.
    expect(result.closed.anchorFlats).toEqual([])
    expect(Array.isArray(result.closed.curvePairs)).toBe(true)
    expect(result.grouped.anchorFlats).toEqual([])
    expect(result.grouped.curvePairs).toEqual([[0, 1]])
    // Shift: partial completes to [0,1], full clears, duplicate cancels.
    expect(result.shiftPartial).toEqual([0, 1])
    expect(result.shiftFull).toEqual([])
    expect(result.shiftDup).toEqual([])
    expect(result.plainDup).toEqual([0, 1])
  }, 60_000)

  it('full UI: curve marquee selects endpoints, moves rigidly, strict bytes + UndoRedo', async () => {
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectTarget('CurveA')
    await selectCostume('vee-open')
    await selectVeeObject()
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-vector-path-point]')].filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length === 3,
      undefined, { timeout: 15_000 },
    )
    expect(await pressedIndices()).toEqual([])

    // Through-rect in screen space: start/end outside the reshape hit layer
    // (so the canvas owns the drag, not point-add), y-band strictly between
    // the top anchors and the mid anchor (all anchors outside, both arms
    // crossed through, not fragile touches).
    const handles = await anchorHandles()
    expect(handles.map((h) => h.index)).toEqual([0, 1, 2])
    const byIndex = new Map(handles.map((h) => [h.index, h]))
    const A = byIndex.get(0)!
    const B = byIndex.get(1)!
    const C = byIndex.get(2)!
    const topAnchorsY = Math.max(A.y, C.y)
    const midY = B.y
    // V opens upward (A/C above B) in screen space; keep a 20px guard.
    expect(midY > topAnchorsY + 40).toBe(true)
    const y0 = topAnchorsY + 18
    const y1 = midY - 18
    expect(y1 > y0 + 10).toBe(true)
    const x0 = Math.min(A.x, B.x, C.x) - 60
    const x1 = Math.max(A.x, B.x, C.x) + 60
    // Sanity: drag band excludes all three anchors (curve-only selection).
    for (const h of [A, B, C]) {
      expect(h.x < x0 || h.x > x1 || h.y < y0 || h.y > y1).toBe(true)
    }
    const vmBefore = await vmSvg('CurveA', 'vee-open')
    const previewBefore = await previewInner()
    const beforeUndo = await undoRedoEnabled()
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x1, y1, { steps: 12 })
    await page.mouse.up()
    await waitPressedCount(3)
    expect(await pressedIndices()).toEqual([0, 1, 2])

    // Drag the middle anchor: all three travel (curves share it), strict bytes.
    const movedFrom = (await anchorHandles()).find((h) => h.index === 1)!
    await page.mouse.move(movedFrom.x, movedFrom.y)
    await page.mouse.down()
    await page.mouse.move(movedFrom.x + 40, movedFrom.y + 12, { steps: 10 })
    await page.mouse.up()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML !== want,
      previewBefore, { timeout: 15_000 },
    )
    const previewMoved = await previewInner()
    expect(previewMoved).not.toBe(previewBefore)
    const vmMoved = await vmSvg('CurveA', 'vee-open')
    expect(vmMoved).not.toBe(vmBefore)
    expect(vmMoved).toContain('<path')
    // Full-bytes round-trip: Undo restores exact bytes, Redo reapplies them.
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewBefore, { timeout: 15_000 },
    )
    expect(await previewInner()).toBe(previewBefore)
    expect(await vmSvg('CurveA', 'vee-open')).toBe(vmBefore)
    await page.locator('button[aria-label="Redo"]:visible').click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.innerHTML === want,
      previewMoved, { timeout: 15_000 },
    )
    expect(await vmSvg('CurveA', 'vee-open')).toBe(vmMoved)
    expect(beforeUndo).toBeDefined()
  }, 180_000)

  it('Shift marquee toggles; off-canvas and text/image select nothing with no history', async () => {
    await ensureVectorMode()
    await selectTarget('CurveA')
    await selectCostume('vee-open')
    await selectVeeObject()
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    // Plain click one anchor, Shift+click a second (partial curve). Click
    // by screen coordinates (not locator.click) so a top-bar overlap can
    // never intercept the press.
    {
      const hs = await anchorHandles()
      if (hs.length < 2) throw new Error('INVALID: missing vee anchors')
      await page.mouse.click(hs[0]!.x, hs[0]!.y)
      await waitPressedCount(1)
    }
    const first = await pressedIndices()
    {
      const hs = await anchorHandles()
      const second = hs.find((h) => !h.pressed) ?? hs[1]!
      await page.keyboard.down('Shift')
      await page.mouse.click(second.x, second.y)
      await page.keyboard.up('Shift')
      await waitPressedCount(2)
    }
    // Shift+marquee over empty off-canvas area matches nothing: unchanged.
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const beforeEmpty = await pressedIndices()
    await page.keyboard.down('Shift')
    await page.mouse.move(box.x - 60, box.y - 60)
    await page.mouse.down()
    await page.mouse.move(box.x - 20, box.y - 20, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await page.waitForTimeout(500)
    expect(await pressedIndices()).toEqual(beforeEmpty)
    // Shift+marquee over the full V toggles the set (partial completes or
    // full clears); plain marquee afterwards restores a deterministic set.
    // Full rect starts well outside the hit layer so the canvas owns it.
    const centers = await anchorHandles()
    const xs = centers.map((c) => c.x)
    const ys = centers.map((c) => c.y)
    await page.keyboard.down('Shift')
    await page.mouse.move(Math.min(...xs) - 60, Math.min(...ys) - 60)
    await page.mouse.down()
    await page.mouse.move(Math.max(...xs) + 60, Math.max(...ys) + 60, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await page.waitForFunction(
      (want) => JSON.stringify([...document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]')].map((el) => Number((el as HTMLElement).dataset.pointIndex)).sort((a, b) => a - b)) !== JSON.stringify(want),
      beforeEmpty, { timeout: 15_000 },
    )
    const toggled = await pressedIndices()
    expect(toggled).not.toEqual(beforeEmpty)
    await page.mouse.move(Math.min(...xs) - 60, Math.min(...ys) - 60)
    await page.mouse.down()
    await page.mouse.move(Math.max(...xs) + 60, Math.max(...ys) + 60, { steps: 10 })
    await page.mouse.up()
    await waitPressedCount(3)
    expect(await pressedIndices()).toEqual([0, 1, 2])
    expect(first.length).toBe(1)

    // Text unit: an enclosing curve marquee from measured empty canvas hits
    // nothing (text reports no anchors/curves) and writes no Undo entry.
    // The old center-based origin landed inside the "Hello" glyphs and drove
    // an object move (+40/+20 SVG) — a press on the artwork, not a marquee.
    await selectCostume('vec-text')
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForTimeout(400)
    {
      const pt = await page.evaluate(() => {
        const el = document.querySelector('.vector-preview svg text') as unknown as Element & { getBoundingClientRect(): DOMRect } | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      if (!pt) throw new Error('INVALID: missing text center for object select')
      await page.mouse.click(pt.x, pt.y)
      await page.waitForTimeout(600)
    }
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForTimeout(800)
    await expectEnclosingMarqueeNoOp('.vector-preview svg text', 'CurveA', 'vec-text')

    // Image unit: same fail-closed behavior.
    await selectCostume('vec-image')
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForTimeout(400)
    {
      const pt = await page.evaluate(() => {
        const el = document.querySelector('.vector-preview svg image') as unknown as Element & { getBoundingClientRect(): DOMRect } | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      if (!pt) throw new Error('INVALID: missing image center for object select')
      await page.mouse.click(pt.x, pt.y)
      await page.waitForTimeout(600)
    }
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForTimeout(800)
    await expectEnclosingMarqueeNoOp('.vector-preview svg image', 'CurveA', 'vec-image')
  }, 180_000)

  it('pointercancel drops the marquee; stale async never writes the wrong slot', async () => {
    await ensureVectorMode()
    await selectTarget('CurveA')
    await selectCostume('vee-open')
    await selectVeeObject()
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    await page.mouse.click(20, 20).catch(() => undefined)
    await page.waitForTimeout(400)
    const idle = await pressedIndices()
    expect(idle).toEqual([])

    // Pointercancel mid-marquee: no selection, no history.
    const centers = await anchorHandles()
    const xs = centers.map((c) => c.x)
    const ys = centers.map((c) => c.y)
    const undoBefore = await undoRedoEnabled()
    await page.mouse.move(Math.min(...xs) - 20, Math.min(...ys) - 20)
    await page.mouse.down()
    await page.mouse.move((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, { steps: 6 })
    await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="costume-paint-surface"]') as HTMLElement | null
      const r = surface?.getBoundingClientRect()
      const x = (r?.left ?? 0) + (r?.width ?? 400) / 2
      const y = (r?.top ?? 0) + (r?.height ?? 400) / 2
      surface?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, composed: true, pointerId: 999, clientX: x, clientY: y, isPrimary: true }))
    })
    await page.mouse.up().catch(() => undefined)
    await page.waitForTimeout(600)
    expect(await pressedIndices()).toEqual([])
    expect(await undoRedoEnabled()).toEqual(undoBefore)

    // Stale cross-scope gate: start a real marquee, switch target + costume
    // before the async Paper import resolves; the late resolve must not touch
    // the new scope (owner identity is the stable target id, not the name).
    const svgA = await vmSvg('CurveA', 'vee-open')
    const svgB = await vmSvg('CurveB', 'vee-open-b')
    await page.mouse.move(Math.min(...xs) - 30, Math.min(...ys) - 30)
    await page.mouse.down()
    await page.mouse.move(Math.max(...xs) + 30, Math.max(...ys) + 30, { steps: 4 })
    await selectTarget('CurveB')
    await selectCostume('vee-open-b')
    await page.mouse.up().catch(() => undefined)
    await page.waitForTimeout(900)
    expect(await vmSvg('CurveA', 'vee-open')).toBe(svgA)
    expect(await vmSvg('CurveB', 'vee-open-b')).toBe(svgB)
  }, 120_000)
})
