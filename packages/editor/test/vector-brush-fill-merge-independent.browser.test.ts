// Independent verification for vector-brush-fill.ts / vector-brush-merge.ts.
//
// SCOPE: real browser (Chromium via playwright-core) + real Paper.js +
// real Canvas 2D raster. This file is additive-only: it never edits the
// implementation files, never touches Editor wiring, and never alters
// existing tests. It hunts for fill gaps (塗り欠け) and data loss across:
// sharp corners, ~180-degree reversals, self-intersection, short distances,
// transparent/gradient paint, different parents/transforms, and Z-order.
// It also compares the closed fill outline against the original centerline
// stroke rendering, and proves merge failures are non-destructive.
//
// SAFETY POLICY: every merge test snapshots the live DOM before the call
// and asserts byte-identical DOM + zero node loss on any refusal/failure.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4199'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector brush fill+merge independent verification (real browser)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4199', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    await page.goto(base)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  // ---------- fill: straight capsule parity vs the original centerline stroke ----------

  it('straight stroke: fill matches the original stroked rendering (no gaps)', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const pts = [
        { x: 20, y: 60 },
        { x: 220, y: 60 },
      ]
      const w = 20
      const d = buildVectorBrushFillPathData(pts, w)
      const line = `M${pts[0]!.x} ${pts[0]!.y}L${pts[1]!.x} ${pts[1]!.y}`

      const W = 260
      const H = 120
      const raster = (draw: (ctx: CanvasRenderingContext2D) => void) => {
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.clearRect(0, 0, W, H)
        draw(ctx)
        const px = ctx.getImageData(0, 0, W, H).data
        let n = 0
        for (let i = 3; i < px.length; i += 4) if (px[i] > 127) n++
        return { n, px }
      }
      const stroke = raster((ctx) => {
        ctx.strokeStyle = '#ff0000'
        ctx.lineWidth = w
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke(new Path2D(line))
      })
      const fill = raster((ctx) => {
        ctx.fillStyle = '#ff0000'
        ctx.fill(new Path2D(d))
      })
      // Spine coverage: every centerline sample must be filled.
      const probe = document.createElement('canvas')
      probe.width = W
      probe.height = H
      const pctx = probe.getContext('2d', { willReadFrequently: true })!
      pctx.fillStyle = '#ff0000'
      pctx.fill(new Path2D(d))
      const img = pctx.getImageData(0, 0, W, H).data
      const at = (x: number, y: number) => img[(y * W + x) * 4 + 3]! > 127
      let uncovered = 0
      for (let x = 20; x <= 220; x += 2) if (!at(x, 60)) uncovered++
      // Edge samples just inside the radius must also be filled.
      let edgeMiss = 0
      for (let x = 40; x <= 200; x += 10) {
        if (!at(x, 60 + 9)) edgeMiss++
        if (!at(x, 60 - 9)) edgeMiss++
      }
      return { d, strokeN: stroke.n, fillN: fill.n, uncovered, edgeMiss }
    })
    expect(r.d.endsWith('Z')).toBe(true)
    expect(r.uncovered).toBe(0)
    expect(r.edgeMiss).toBe(0)
    // Capsule area parity within 5% of the stroked original.
    expect(Math.abs(r.fillN - r.strokeN) / r.strokeN).toBeLessThan(0.05)
  }, 30_000)

  // ---------- fill: sharp (acute) corner ----------

  it('sharp corner: closed, no miter explosion, spine covered, gap bounded', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      // ~15-degree interior angle at the joint.
      const pts = [
        { x: 20, y: 100 },
        { x: 180, y: 100 },
        { x: 200, y: 140 },
      ]
      const w = 20
      const d = buildVectorBrushFillPathData(pts, w)
      const path = new scope.Path(d)
      const bounds = { x: path.bounds.x, y: path.bounds.y, w: path.bounds.width, h: path.bounds.height }
      const area = Math.abs(path.area)
      const hasNaN = /NaN|Infinity/.test(d)
      const mid1 = path.contains(new scope.Point(100, 100))
      const mid2 = path.contains(new scope.Point(185, 110))
      const tip = path.contains(new scope.Point(200, 140))
      path.remove()

      // Pixel gap vs the round-join original stroke.
      const W = 260
      const H = 200
      const raster = (draw: (ctx: CanvasRenderingContext2D) => void) => {
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        draw(ctx)
        return ctx.getImageData(0, 0, W, H).data
      }
      const line = `M20 100L180 100L200 140`
      const sPx = raster((ctx) => {
        ctx.strokeStyle = '#ff0000'
        ctx.lineWidth = w
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke(new Path2D(line))
      })
      const fPx = raster((ctx) => {
        ctx.fillStyle = '#ff0000'
        ctx.fill(new Path2D(d))
      })
      let strokeN = 0
      let missing = 0
      for (let i = 3; i < sPx.length; i += 4) {
        if (sPx[i]! > 127) {
          strokeN++
          if (fPx[i]! <= 127) missing++
        }
      }
      scope.project.clear()
      return { d, bounds, area, hasNaN, mid1, mid2, tip, strokeN, missing }
    })
    expect(r.hasNaN).toBe(false)
    expect(r.d.endsWith('Z')).toBe(true)
    expect(r.area).toBeGreaterThan(0)
    // No miter spike: bounds must stay near the stroke extent (length ~190 + caps, width 20).
    expect(r.bounds.w).toBeLessThan(260)
    expect(r.bounds.h).toBeLessThan(120)
    expect(r.mid1).toBe(true)
    expect(r.mid2).toBe(true)
    expect(r.tip).toBe(true)
    // Gap vs round-join original must be bounded (<5% of stroked pixels).
    expect(r.missing / r.strokeN).toBeLessThan(0.05)
    console.log(`[sharp-corner] missing=${r.missing}/${r.strokeN} area=${r.area.toFixed(1)}`)
  }, 30_000)

  // ---------- fill: ~180-degree reversal ----------

  it('near-180-degree reversal: no collapse, no spike, full spine covered', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      // Out along y=100, back ~2px above it (near-perfect reversal).
      const pts = [
        { x: 20, y: 100 },
        { x: 200, y: 100 },
        { x: 30, y: 102 },
      ]
      const w = 16
      const d = buildVectorBrushFillPathData(pts, w)
      const path = new scope.Path(d)
      const area = Math.abs(path.area)
      const bw = path.bounds.width
      const bh = path.bounds.height
      const hasNaN = /NaN|Infinity/.test(d)
      // Every leg of the polyline must be inside the fill (no hollow middle).
      const checks = [
        [60, 100],
        [120, 100],
        [180, 100],
        [100, 101],
        [50, 101],
      ].map(([x, y]) => path.contains(new scope.Point(x, y)))
      path.remove()
      scope.project.clear()
      return { dLen: d.length, area, bw, bh, hasNaN, checks }
    })
    expect(r.hasNaN).toBe(false)
    expect(r.area).toBeGreaterThan(0)
    // Capsule along the 180px leg with r=8: width ~196, height ~16-18. A spike would blow this up.
    expect(r.bw).toBeLessThan(240)
    expect(r.bh).toBeLessThan(60)
    expect(r.checks.every(Boolean)).toBe(true)
  }, 30_000)

  // ---------- fill: self-intersection ----------

  it('self-intersecting stroke: valid closed outline, crossing stays filled', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      // X crossing: the outline polygon self-intersects at (110,60).
      const pts = [
        { x: 20, y: 20 },
        { x: 200, y: 100 },
        { x: 20, y: 100 },
        { x: 200, y: 20 },
      ]
      const w = 18
      const d = buildVectorBrushFillPathData(pts, w)
      const path = new scope.Path(d)
      const area = Math.abs(path.area)
      const hasNaN = /NaN|Infinity/.test(d)
      const closed = (path as unknown as { closed?: boolean }).closed !== false
      path.remove()

      // Canvas raster: exact centerline samples on every leg plus the crossing
      // point must be painted (leg1 is the horizontal return through y=100).
      const W = 240
      const H = 130
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.fillStyle = '#ff0000'
      ctx.fill(new Path2D(d))
      const img = ctx.getImageData(0, 0, W, H).data
      const at = (x: number, y: number) => img[(Math.round(y) * W + Math.round(x)) * 4 + 3]! > 127
      const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, t: number) => ({
        x: p.x + (q.x - p.x) * t,
        y: p.y + (q.y - p.y) * t,
      })
      const samples = [
        lerp(pts[0]!, pts[1]!, 0.2),
        lerp(pts[0]!, pts[1]!, 0.5), // exact crossing (110,60)
        lerp(pts[0]!, pts[1]!, 0.8),
        lerp(pts[1]!, pts[2]!, 0.5), // horizontal return leg
        lerp(pts[2]!, pts[3]!, 0.2),
        lerp(pts[2]!, pts[3]!, 0.5),
        lerp(pts[2]!, pts[3]!, 0.8),
      ]
      const legs = samples.map((s) => at(s.x, s.y))
      const crossFilled = at(110, 60)
      scope.project.clear()
      return { dLen: d.length, area, hasNaN, closed, crossFilled, legs }
    })
    expect(r.hasNaN).toBe(false)
    expect(r.area).toBeGreaterThan(0)
    expect(r.crossFilled).toBe(true)
    expect(r.legs.every(Boolean)).toBe(true)
  }, 30_000)

  // ---------- fill: short distances / degenerate input ----------

  it('short distances: sub-pixel chain and dots never collapse to nothing', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const w = 12
      const expected = Math.PI * 36 // pi*r^2, r=6
      const cases: Array<{ name: string; area: number; d: string; containsCenter: boolean }> = []
      const inputs: Array<{ name: string; pts: Array<{ x: number; y: number }> }> = [
        { name: 'single-dot', pts: [{ x: 50, y: 50 }] },
        { name: 'micro-segment', pts: [{ x: 50, y: 50 }, { x: 50.0000001, y: 50 }] },
        {
          name: 'subpixel-chain',
          pts: [
            { x: 50, y: 50 },
            { x: 50.3, y: 50.1 },
            { x: 50.6, y: 50.4 },
            { x: 51, y: 50.2 },
          ],
        },
        {
          name: 'shorter-than-radius',
          pts: [
            { x: 50, y: 50 },
            { x: 52, y: 50 },
          ],
        },
      ]
      for (const input of inputs) {
        const d = buildVectorBrushFillPathData(input.pts, w)
        if (!d) {
          cases.push({ name: input.name, area: 0, d: '', containsCenter: false })
          continue
        }
        const path = new scope.Path(d)
        const area = Math.abs(path.area)
        const containsCenter = path.contains(new scope.Point(50, 50))
        path.remove()
        cases.push({ name: input.name, area, d, containsCenter })
      }
      scope.project.clear()
      return { cases, expected }
    })
    for (const c of r.cases) {
      expect(c.d.endsWith('Z')).toBe(true)
      expect(c.area).toBeGreaterThan(r.expected * 0.5)
      expect(c.containsCenter).toBe(true)
    }
  }, 30_000)

  // ---------- merge: transparent / gradient refusal is non-destructive ----------

  it('merge refuses transparent and gradient paint without touching the DOM', async () => {
    const r = await page.evaluate(async () => {
      const { mergeBrushElementWithSiblings } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const setup = (extra: string) =>
        new DOMParser().parseFromString(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
            `<rect x="10" y="10" width="100" height="100" fill="#ff0000" stroke="none"/>` +
            `<rect x="90" y="10" width="100" height="100" fill="#ff0000" stroke="none" ${extra}/>` +
            '</svg>',
          'image/svg+xml',
        ).documentElement
      const variants: Array<{ name: string; extra: string }> = [
        { name: 'opacity', extra: 'opacity="0.5"' },
        { name: 'fill-opacity', extra: 'fill-opacity="0.2"' },
        { name: 'gradient', extra: 'fill="url(#g)"' },
        { name: 'rgba', extra: 'fill="rgba(255,0,0,0.5)"' },
        { name: 'alpha-hex', extra: 'fill="#ff000080"' },
        { name: 'visible-stroke', extra: 'stroke="#000000" stroke-width="3"' },
      ]
      const out: Array<{ name: string; merged: boolean; unchanged: boolean; count: number }> = []
      for (const v of variants) {
        const svg = setup(v.extra)
        const before = new XMLSerializer().serializeToString(svg)
        const brush = svg.children[1]!
        const res = mergeBrushElementWithSiblings(scope as never, brush)
        const after = new XMLSerializer().serializeToString(svg)
        out.push({ name: v.name, merged: res.merged, unchanged: before === after, count: svg.children.length })
        scope.project.clear()
      }
      scope.project.clear()
      return out
    })
    for (const v of r) {
      expect(`${v.name}: merged=${v.merged}`).toBe(`${v.name}: merged=false`)
      expect(v.unchanged).toBe(true)
      expect(v.count).toBe(2)
    }
  }, 30_000)

  // ---------- merge: different parent / transform / nested ----------

  it('merge refuses different parents, groups and nested art without loss', async () => {
    const r = await page.evaluate(async () => {
      const { isMergeableBrushCandidate, mergeBrushElementWithSiblings } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()

      // Different parents: same color, overlapping, but grouped apart.
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<g id="a"><rect x="10" y="10" width="100" height="100" fill="#ff0000" stroke="none"/></g>' +
          '<g id="b"><rect x="90" y="10" width="100" height="100" fill="#ff0000" stroke="none"/></g>' +
          '</svg>',
        'image/svg+xml',
      )
      const svg = doc.documentElement
      const rectA = svg.querySelector('#a rect')!
      const rectB = svg.querySelector('#b rect')!
      const crossParent = isMergeableBrushCandidate(rectA, rectB, '#ff0000')
      const groupCand = isMergeableBrushCandidate(svg.querySelector('#a')!, rectB, '#ff0000')

      // DOM-level merge attempt with the brush inside group b: no eligible same-parent sibling.
      const before = new XMLSerializer().serializeToString(svg)
      const res = mergeBrushElementWithSiblings(scope as never, rectB)
      const after = new XMLSerializer().serializeToString(svg)

      // Nested children refusal (unit): a shape carrying element children is left alone.
      const host = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0L10 0" fill="#ff0000"/></g></svg>',
        'image/svg+xml',
      ).documentElement
      const brushEl = host.querySelector('path')!
      brushEl.appendChild(host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'title'))
      const nested = isMergeableBrushCandidate(brushEl, brushEl, '#ff0000')

      scope.project.clear()
      return {
        crossParent,
        groupReason: (groupCand as { reason: string }).reason,
        merged: res.merged,
        unchanged: before === after,
        nestedReason: (nested as { reason: string }).reason,
      }
    })
    expect(r.crossParent).toEqual({ ok: false, reason: 'different-parent' })
    expect(r.groupReason).toBe('group')
    expect(r.merged).toBe(false)
    expect(r.unchanged).toBe(true)
    expect(r.nestedReason).toBe('has-children')
  }, 30_000)

  // ---------- merge: Z-order blocker ----------

  it('merge refuses to lift art over an overlapping unrelated sibling (Z-order)', async () => {
    const r = await page.evaluate(async () => {
      const { isBrushMergeOrderSafe, mergeBrushElementWithSiblings } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      // index 0: red (merge target, below) / index 1: blue blocker overlapping the
      // brush area / index 2: red brush (top). Merging 0+2 would lift red over blue.
      const src =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<rect x="10" y="10" width="120" height="120" fill="#ff0000" stroke="none"/>' +
        '<rect x="60" y="0" width="120" height="200" fill="#0000ff" stroke="none"/>' +
        '<rect x="100" y="10" width="120" height="120" fill="#ff0000" stroke="none"/>' +
        '</svg>'
      const svg = new DOMParser().parseFromString(src, 'image/svg+xml').documentElement
      const before = new XMLSerializer().serializeToString(svg)
      const brush = svg.children[2]!
      const res = mergeBrushElementWithSiblings(scope as never, brush)
      const after = new XMLSerializer().serializeToString(svg)
      const pure = isBrushMergeOrderSafe(2, [0], (i) => i === 1)
      scope.project.clear()
      return { merged: res.merged, unchanged: before === after, count: svg.children.length, pure }
    })
    expect(r.pure).toBe(false)
    expect(r.merged).toBe(false)
    expect(r.unchanged).toBe(true)
    expect(r.count).toBe(3)
  }, 30_000)

  // ---------- merge: non-touching same-color refusal (non-destructive) ----------

  it('merge leaves far same-color shapes alone and loses no nodes', async () => {
    const r = await page.evaluate(async () => {
      const { mergeBrushElementWithSiblings } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const svg = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<rect x="10" y="10" width="50" height="50" fill="#ff0000" stroke="none"/>' +
          '<rect x="300" y="200" width="50" height="50" fill="#ff0000" stroke="none"/>' +
          '</svg>',
        'image/svg+xml',
      ).documentElement
      const before = new XMLSerializer().serializeToString(svg)
      const brush = svg.children[1]!
      const res = mergeBrushElementWithSiblings(scope as never, brush)
      const after = new XMLSerializer().serializeToString(svg)
      scope.project.clear()
      return { merged: res.merged, unchanged: before === after, count: svg.children.length }
    })
    expect(r.merged).toBe(false)
    expect(r.unchanged).toBe(true)
    expect(r.count).toBe(2)
  }, 30_000)

  // ---------- merge: touching DOM merge succeeds via single-child Group resolution ----------
  //
  // History: `project.importSVG` always returns a Group wrapper (children:[Path]),
  // and Group has no `.unite`, so the orchestrator used to skip every candidate.
  // `resolveImportedBrushLeaf` now dissolves single-child Group chains (baking
  // wrapper transforms) while refusing multi-child Groups fail-closed.

  it('touching same-color shapes merge into one node; unrelated nodes keep identity', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData, vectorBrushFillMarkup } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { mergeBrushElementWithSiblings, resolveImportedBrushLeaf } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const d = buildVectorBrushFillPathData(
        [
          { x: 140, y: 60 },
          { x: 260, y: 60 },
        ],
        40,
      )
      const brushMarkup = vectorBrushFillMarkup({ pathData: d, fill: '#ff0000', opacity: 100 })
      const svg = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<rect x="10" y="10" width="130" height="100" fill="#ff0000" stroke="none"/>' +
          '<rect x="400" y="300" width="30" height="30" fill="#ff0000" stroke="none"/>' +
          brushMarkup +
          '</svg>',
        'image/svg+xml',
      ).documentElement
      const farBefore = svg.children[1]!
      const farMarkupBefore = new XMLSerializer().serializeToString(farBefore)
      const beforeCount = svg.children.length
      const brush = svg.children[2]!
      const res = mergeBrushElementWithSiblings(scope as never, brush)
      const afterCount = svg.children.length
      const imp = (el: Element) => {
        const raw = new XMLSerializer().serializeToString(el)
        return (scope.project as unknown as { importSVG: (x: string, o?: object) => any }).importSVG(
          `<svg xmlns="http://www.w3.org/2000/svg">${raw}</svg>`,
          { insert: false, expandShapes: true },
        )
      }
      const brushProbe = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg">${brushMarkup}</svg>`,
        'image/svg+xml',
      ).documentElement.children[0] as Element
      const gBrush: any = imp(brushProbe)
      const importedClasses = [gBrush?.className]
      const uniteType = typeof gBrush?.unite
      const resolved: any = resolveImportedBrushLeaf(gBrush)
      const resolvedClass = resolved?.className
      const cleanup: any[] = [gBrush]
      if (resolved && resolved !== gBrush) cleanup.push(resolved)
      const unitedEl = svg.children[1]!
      const unitedRaw = new XMLSerializer().serializeToString(unitedEl)
      const unitedItem: any = (scope.project as unknown as { importSVG: (x: string, o?: object) => any }).importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg">${unitedRaw}</svg>`,
        { insert: false, expandShapes: true },
      )
      const unitedLeaf: any = resolveImportedBrushLeaf(unitedItem)
      if (unitedLeaf && unitedLeaf !== unitedItem) cleanup.push(unitedLeaf)
      cleanup.push(unitedItem)
      const leafForBounds = unitedLeaf ?? unitedItem
      const b = leafForBounds?.bounds
      const bounds = b && [b.x, b.y, b.width, b.height]
      const area = leafForBounds?.area
      const unitedFill = unitedEl.getAttribute('fill')
      const unitedStroke = unitedEl.getAttribute('stroke')
      const farSameNode = svg.children[0]! === farBefore
      const farSameMarkup = new XMLSerializer().serializeToString(svg.children[0]!) === farMarkupBefore
      for (const item of cleanup) {
        try {
          item.remove()
        } catch {}
      }
      scope.project.clear()
      return {
        merged: res.merged,
        mergedCount: (res as { mergedCount?: number }).mergedCount,
        beforeCount,
        afterCount,
        importedClasses,
        uniteType,
        resolvedClass,
        coreBounds: bounds,
        coreArea: area,
        unitedFill,
        unitedStroke,
        farSameNode,
        farSameMarkup,
      }
    })
    expect(r.merged).toBe(true)
    expect(r.mergedCount).toBe(1)
    expect(r.beforeCount).toBe(3)
    expect(r.afterCount).toBe(2)
    expect(r.importedClasses).toEqual(['Group'])
    expect(r.uniteType).toBe('undefined')
    expect(['Path', 'CompoundPath']).toContain(r.resolvedClass)
    expect(r.coreBounds).toEqual([10, 10, 270, 100])
    expect(r.unitedFill).toBe('#ff0000')
    expect(r.unitedStroke).toBe('none')
    expect(r.farSameNode).toBe(true)
    expect(r.farSameMarkup).toBe(true)
    console.log(`[dom-merge] merged=${r.merged} area=${r.coreArea} bounds=${r.coreBounds}`)
  }, 30_000)

  // ---------- merge: element-level transform is honored, parent preserved ----------

  it('an element-level transform moves geometry into contact and still merges', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData, vectorBrushFillMarkup } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { mergeBrushElementWithSiblings } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const d = buildVectorBrushFillPathData(
        [
          { x: 140, y: 60 },
          { x: 260, y: 60 },
        ],
        40,
      )
      const brushMarkup = vectorBrushFillMarkup({ pathData: d, fill: '#ff0000', opacity: 100 })
      const svg = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<rect x="10" y="10" width="50" height="100" fill="#ff0000" stroke="none" transform="translate(80 0)"/>' +
          '<rect x="400" y="300" width="30" height="30" fill="#ff0000" stroke="none"/>' +
          brushMarkup +
          '</svg>',
        'image/svg+xml',
      ).documentElement
      const farBefore = svg.children[1]!
      const farMarkup = new XMLSerializer().serializeToString(farBefore)
      const brush = svg.children[2]!
      const res = mergeBrushElementWithSiblings(scope as never, brush)
      const count = svg.children.length
      const farSame = svg.children[0]! === farBefore
      const farMarkupSame = new XMLSerializer().serializeToString(svg.children[0]!) === farMarkup
      const unitedEl = res.merged ? svg.children[1]! : undefined
      const unitedFill = unitedEl?.getAttribute('fill')
      scope.project.clear()
      return { merged: res.merged, mergedCount: (res as { mergedCount?: number }).mergedCount, count, farSame, farMarkupSame, unitedFill }
    })
    expect(r.merged).toBe(true)
    expect(r.mergedCount).toBe(1)
    expect(r.count).toBe(2)
    expect(r.farSame).toBe(true)
    expect(r.farMarkupSame).toBe(true)
    expect(r.unitedFill).toBe('#ff0000')
  }, 30_000)

  // ---------- merge: ancestor transform stays on the parent, selection outside intact ----------

  it('merge under a transformed parent keeps the parent transform and outside selection', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData, vectorBrushFillMarkup } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { mergeBrushElementWithSiblings } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const d = buildVectorBrushFillPathData(
        [
          { x: 140, y: 60 },
          { x: 260, y: 60 },
        ],
        40,
      )
      const brushMarkup = vectorBrushFillMarkup({ pathData: d, fill: '#ff0000', opacity: 100 })
      const svg = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<g id="wrap" transform="translate(60 0)">' +
          '<rect x="10" y="10" width="130" height="100" fill="#ff0000" stroke="none"/>' +
          brushMarkup +
          '</g>' +
          '<rect x="400" y="300" width="30" height="30" fill="#ff0000" stroke="none"/>' +
          '</svg>',
        'image/svg+xml',
      ).documentElement
      const wrap = svg.children[0]!
      const farBefore = svg.children[1]!
      const farMarkup = new XMLSerializer().serializeToString(farBefore)
      const brush = wrap.children[1]!
      const res = mergeBrushElementWithSiblings(scope as never, brush)
      const wrapTransform = wrap.getAttribute('transform')
      const wrapCount = wrap.children.length
      const svgCount = svg.children.length
      const farSame = svg.children[1]! === farBefore
      const farMarkupSame = new XMLSerializer().serializeToString(svg.children[1]!) === farMarkup
      const unitedFill = res.merged ? (wrap.children[0] as Element).getAttribute('fill') : undefined
      scope.project.clear()
      return { merged: res.merged, mergedCount: (res as { mergedCount?: number }).mergedCount, wrapTransform, wrapCount, svgCount, farSame, farMarkupSame, unitedFill }
    })
    expect(r.merged).toBe(true)
    expect(r.mergedCount).toBe(1)
    expect(r.wrapTransform).toBe('translate(60 0)')
    expect(r.wrapCount).toBe(1)
    expect(r.svgCount).toBe(2)
    expect(r.farSame).toBe(true)
    expect(r.farMarkupSame).toBe(true)
    expect(r.unitedFill).toBe('#ff0000')
  }, 30_000)

  // ---------- merge: holed shapes keep their holes ----------

  it('a donut candidate merges without filling its hole', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData, vectorBrushFillMarkup } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { mergeBrushElementWithSiblings, resolveImportedBrushLeaf } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const d = buildVectorBrushFillPathData(
        [
          { x: 100, y: 60 },
          { x: 200, y: 60 },
        ],
        30,
      )
      const brushMarkup = vectorBrushFillMarkup({ pathData: d, fill: '#ff0000', opacity: 100 })
      const svg = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<path d="M10 10H110V110H10Z M35 35H85V85H35Z" fill="#ff0000" stroke="none" fill-rule="evenodd"/>' +
          '<rect x="400" y="300" width="30" height="30" fill="#ff0000" stroke="none"/>' +
          brushMarkup +
          '</svg>',
        'image/svg+xml',
      ).documentElement
      const brush = svg.children[2]!
      brush.setAttribute('fill-rule', 'evenodd')
      const res = mergeBrushElementWithSiblings(scope as never, brush)
      const count = svg.children.length
      if (!res.merged) {
        scope.project.clear()
        return { merged: false }
      }
      const unitedEl = svg.children[1]! as Element
      const unitedFillRule = unitedEl.getAttribute('fill-rule')
      const raw = new XMLSerializer().serializeToString(unitedEl)
      const imported: any = (scope.project as unknown as { importSVG: (x: string, o?: object) => any }).importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg">${raw}</svg>`,
        { insert: false, expandShapes: true },
      )
      const leaf: any = resolveImportedBrushLeaf(imported) ?? imported
      const ringInside = leaf.contains(new scope.Point(20, 20))
      const holeInside = leaf.contains(new scope.Point(60, 60))
      const brushInside = leaf.contains(new scope.Point(150, 60))
      try {
        leaf.remove()
      } catch {}
      try {
        imported.remove()
      } catch {}
      scope.project.clear()
      return { merged: true, count, unitedFillRule, ringInside, holeInside, brushInside }
    })
    expect(r.merged).toBe(true)
    expect(r.count).toBe(2)
    expect(r.unitedFillRule).toBe('evenodd')
    expect(r.ringInside).toBe(true)
    expect(r.holeInside).toBe(false)
    expect(r.brushInside).toBe(true)
  }, 30_000)

  // ---------- merge: multiple touching candidates all merge, far stays ----------

  it('a brush bridging two same-color shapes consumes both and keeps the far node', async () => {
    const r = await page.evaluate(async () => {
      const { buildVectorBrushFillPathData, vectorBrushFillMarkup } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-fill.ts'
      )
      const { mergeBrushElementWithSiblings, resolveImportedBrushLeaf } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const d = buildVectorBrushFillPathData(
        [
          { x: 70, y: 60 },
          { x: 230, y: 60 },
        ],
        40,
      )
      const brushMarkup = vectorBrushFillMarkup({ pathData: d, fill: '#ff0000', opacity: 100 })
      const svg = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<rect x="10" y="10" width="80" height="100" fill="#ff0000" stroke="none"/>' +
          '<rect x="210" y="10" width="80" height="100" fill="#ff0000" stroke="none"/>' +
          '<rect x="400" y="300" width="30" height="30" fill="#ff0000" stroke="none"/>' +
          brushMarkup +
          '</svg>',
        'image/svg+xml',
      ).documentElement
      const farBefore = svg.children[2]!
      const farMarkup = new XMLSerializer().serializeToString(farBefore)
      const brush = svg.children[3]!
      const res = mergeBrushElementWithSiblings(scope as never, brush)
      const count = svg.children.length
      const farSame = svg.children[0]! === farBefore
      const farMarkupSame = new XMLSerializer().serializeToString(svg.children[0]!) === farMarkup
      let bounds: unknown
      let area = 0
      if (res.merged) {
        const unitedEl = svg.children[1]! as Element
        const raw = new XMLSerializer().serializeToString(unitedEl)
        const imported: any = (scope.project as unknown as { importSVG: (x: string, o?: object) => any }).importSVG(
          `<svg xmlns="http://www.w3.org/2000/svg">${raw}</svg>`,
          { insert: false, expandShapes: true },
        )
        const leaf: any = resolveImportedBrushLeaf(imported) ?? imported
        const b = leaf.bounds
        bounds = [b.x, b.y, b.width, b.height]
        area = Math.abs(leaf.area)
        try {
          leaf.remove()
        } catch {}
        try {
          imported.remove()
        } catch {}
      }
      scope.project.clear()
      return { merged: res.merged, mergedCount: (res as { mergedCount?: number }).mergedCount, count, farSame, farMarkupSame, bounds, area }
    })
    expect(r.merged).toBe(true)
    expect(r.mergedCount).toBe(2)
    expect(r.count).toBe(2)
    expect(r.farSame).toBe(true)
    expect(r.farMarkupSame).toBe(true)
    expect(r.bounds).toEqual([10, 10, 280, 100])
    const expected = 8000 + 8000 + (160 * 40 + Math.PI * 400) - 3200
    expect(Math.abs((r.area as number) - expected) / expected).toBeLessThan(0.05)
  }, 30_000)


  // ---------- merge: transformed same-parent sibling never false-merges ----------

  it('a transformed same-parent sibling is never corrupted by a merge attempt', async () => {
    const r = await page.evaluate(async () => {
      const { mergeBrushElementWithSiblings } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const svg = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<rect x="10" y="10" width="50" height="50" fill="#ff0000" stroke="none" transform="translate(300 200)"/>' +
          '<rect x="300" y="200" width="50" height="50" fill="#ff0000" stroke="none"/>' +
          '</svg>',
        'image/svg+xml',
      ).documentElement
      const before = new XMLSerializer().serializeToString(svg)
      const res = mergeBrushElementWithSiblings(scope as never, svg.children[1]!)
      const after = new XMLSerializer().serializeToString(svg)
      const count = svg.children.length
      // Survivors must all be solid-filled leaf shapes (no emptied/gradient nodes).
      const paints = Array.from(svg.children).map((el) => ({
        fill: el.getAttribute('fill'),
        nodes: el.childNodes.length,
      }))
      scope.project.clear()
      return { merged: res.merged, unchanged: before === after, count, paints }
    })
    // The element-level transform moves the sibling exactly onto the brush
    // (they overlap). Either refusing or merging is acceptable, but geometry
    // must never be lost or falsely duplicated either way.
    if (r.merged) {
      expect(r.count).toBe(1)
      expect(r.paints[0]!.fill).toBe('#ff0000')
    } else {
      expect(r.unchanged).toBe(true)
      expect(r.count).toBe(2)
    }
  }, 30_000)

  // ---------- merge: boolean failure is non-destructive ----------

  it('a throwing boolean op keeps every node and changes nothing', async () => {
    const r = await page.evaluate(async () => {
      const { tryUniteBrushItems } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { mergeBrushElementWithSiblings } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()

      // Unit level: force unite() to throw; both inputs must survive via `skipped`.
      const a = new scope.Path.Rectangle({ point: [0, 0], size: [100, 100] })
      const b = new scope.Path.Rectangle({ point: [50, 0], size: [100, 100] })
      const proto = Object.getPrototypeOf(a) as { unite?: (...args: never[]) => unknown }
      const original = proto.unite
      ;(proto as Record<string, unknown>).unite = () => {
        throw new Error('forced boolean failure')
      }
      let unitArea = 0
      let skippedLen = 0
      try {
        const out = tryUniteBrushItems(a as never, [b as never])
        skippedLen = out.skipped.length
        unitArea = Math.abs((out.united as unknown as { area: number }).area)
      } finally {
        if (original) (proto as Record<string, unknown>).unite = original
      }
      a.remove()
      b.remove()
      scope.project.clear()

      // DOM level: same forced failure through the orchestrator.
      const svg = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
          '<rect x="10" y="10" width="100" height="100" fill="#ff0000" stroke="none"/>' +
          '<rect x="90" y="10" width="100" height="100" fill="#ff0000" stroke="none"/>' +
          '</svg>',
        'image/svg+xml',
      ).documentElement
      const before = new XMLSerializer().serializeToString(svg)
      const paperProto = Object.getPrototypeOf(scope.project) as Record<string, unknown>
      void paperProto
      // Patch Path unite again for the DOM path.
      const anyScope = scope as unknown as { Path: { prototype: Record<string, unknown> } }
      const origUnite = anyScope.Path.prototype.unite
      anyScope.Path.prototype.unite = () => {
        throw new Error('forced boolean failure')
      }
      let domRes: { merged: boolean; mergedCount: number }
      try {
        domRes = mergeBrushElementWithSiblings(scope as never, svg.children[1]!)
      } finally {
        anyScope.Path.prototype.unite = origUnite
      }
      const after = new XMLSerializer().serializeToString(svg)
      scope.project.clear()
      return { unitArea, skippedLen, domMerged: domRes!.merged, unchanged: before === after, count: svg.children.length }
    })
    expect(r.skippedLen).toBe(1)
    expect(r.unitArea).toBeCloseTo(10000, 0)
    expect(r.domMerged).toBe(false)
    expect(r.unchanged).toBe(true)
    expect(r.count).toBe(2)
  }, 30_000)

  // ---------- merge: chain contact does not over-merge ----------

  it('only directly-touching shapes merge; chained contacts stay put', async () => {
    const r = await page.evaluate(async () => {
      const { tryUniteBrushItems, paperItemsTouch } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-brush-merge.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      // brush [0,100] touches mid [80,180]; far [300,350] touches mid but NOT the brush.
      const brush = new scope.Path.Rectangle({ point: [0, 0], size: [100, 100] })
      const mid = new scope.Path.Rectangle({ point: [80, 0], size: [100, 100] })
      const far = new scope.Path.Rectangle({ point: [300, 0], size: [50, 50] })
      const touchesMid = paperItemsTouch(brush as never, mid as never)
      const touchesFar = paperItemsTouch(brush as never, far as never)
      const { united, skipped } = tryUniteBrushItems(brush as never, [mid as never, far as never])
      const area = Math.abs((united as unknown as { area: number }).area)
      const skippedIsFar = skipped.length === 1 && skipped[0] === (far as unknown)
      united.remove()
      far.remove()
      scope.project.clear()
      return { touchesMid, touchesFar, area, skippedIsFar }
    })
    expect(r.touchesMid).toBe(true)
    expect(r.touchesFar).toBe(false)
    // 100x100 + 100x100 - 20x100 overlap = 18000.
    expect(Math.abs(r.area - 18000)).toBeLessThan(1)
    expect(r.skippedIsFar).toBe(true)
  }, 30_000)
})
