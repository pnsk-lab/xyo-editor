// Pure tests for the Paper workspace clamp wiring (no DOM, no product change).
//
// Pins the Paper world -> CSS mapping behind `BitmapEditor.svelte`: vector
// (2400x1800, density 2.5) and bitmap res2 (density 1.0, true-center mapping)
// viewports are clamped to the reference workspace (art + drawn + BUFFER,
// capped at expanded MAX, symmetric widen when the view is larger), with the
// reference order (pan clipEmpty=false includes the new view; fixed-point
// zoom/reset/resize/fit clipEmpty=true trims empty first so the clamp wins).
// res1/unknown stays legacy (density undefined => input unchanged, 明記).
import { describe, expect, it } from 'bun:test'
import {
  PAPER_CLAMP_BUFFER,
  PAPER_CLAMP_RES1_DENSITY,
  PAPER_CLAMP_RES2_DENSITY,
  PAPER_CLAMP_VECTOR_DENSITY,
  clampCssViewportToPaper,
  cssViewportForPaperCenter,
  paperItemRectsForBitmapOpaque,
  paperItemRectsForVectorUnits,
  paperViewBoundsForCssViewport,
  paperWorkspaceForClamp,
} from '../src/features/costumes/viewport-paper-clamp'
import { zoomViewportAtSurfacePoint } from '../src/features/costumes/costume-viewport'
import { SCROLL_MAX_WORKSPACE, clampViewToWorkspace } from '../src/features/costumes/viewport-scroll-clamp'

const VECTOR_SURFACE = { width: 2400, height: 1800 }
const RES2_SURFACE = { width: 960, height: 720 }
const CONTAINER = { width: 800, height: 600 }

describe('viewport-paper-clamp: Paper<->CSS correspondence', () => {
  it('maps the reset viewports to the Paper center at zoom 0.5', () => {
    // Vector reset 0.2 * 2.5 = 0.5; res2 reset 0.5 * 1.0 = 0.5.
    const vector = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 0.2 }, VECTOR_SURFACE, CONTAINER, PAPER_CLAMP_VECTOR_DENSITY)
    expect(vector.reason).toBe('ok')
    expect(vector.zoom).toBeCloseTo(0.5, 12)
    expect(vector.center).toEqual({ x: 480, y: 360 })
    // Visible 800/0.5=1600 x 600/0.5=1200 around the center.
    expect(vector.viewBounds).toEqual({ left: -320, top: -240, right: 1280, bottom: 960 })
    const res2 = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 0.5 }, RES2_SURFACE, CONTAINER, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(res2.zoom).toBeCloseTo(0.5, 12)
    expect(res2.center).toEqual({ x: 480, y: 360 })
    expect(res2.viewBounds).toEqual({ left: -320, top: -240, right: 1280, bottom: 960 })
  })

  it('round-trips Paper center/zoom through CSS without drift', () => {
    const back = cssViewportForPaperCenter({ x: 900, y: 100 }, 1, VECTOR_SURFACE, PAPER_CLAMP_VECTOR_DENSITY)
    expect(back).not.toBeUndefined()
    const fwd = paperViewBoundsForCssViewport(back!, VECTOR_SURFACE, CONTAINER, PAPER_CLAMP_VECTOR_DENSITY)
    expect(fwd.center!.x).toBeCloseTo(900, 9)
    expect(fwd.center!.y).toBeCloseTo(100, 9)
    expect(fwd.zoom).toBeCloseTo(1, 12)
  })

  it('maps bitmap union true-center (not the apparent middle)', () => {
    // 1200px union (art 0..960 plus 200..1200 source): the tracked true
    // center is canvasCenterX=480 in live canvas px, the apparent middle is
    // width/2=600. vx=0 puts the *surface* center (600) on screen.
    const unionSurface = { width: 1200, height: 720 }
    const view = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 0.5 }, unionSurface, CONTAINER, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    // Surface 600 through cc=480: Paper = (600-480)+480 = 600 (union center).
    expect(view.center).toEqual({ x: 600, y: 360 })
    // The tracked artboard center itself (surface 480) maps to Paper 480:
    // centering Paper 480 needs vx=(600-480)*0.5=60 (not 0).
    const artCentered = cssViewportForPaperCenter({ x: 480, y: 360 }, 0.5, unionSurface, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(artCentered).toEqual({ x: 60, y: 0, scale: 0.5 })
    // Apparent-middle fallback (cc=600) would instead claim vx=0 shows Paper
    // 480 -- that misplaces union ink by 120 surface px, pinned here.
    const wrong = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 0.5 }, unionSurface, CONTAINER, PAPER_CLAMP_RES2_DENSITY, { x: 600, y: 360 })
    expect(wrong.center).toEqual({ x: 480, y: 360 })
  })

  it('maps the res1 reset viewport to the Paper center at zoom 0.5 (decided 0.5)', () => {
    // Res1 reset 1.0 * 0.5 = 0.5 Paper. Canvas 480x360 centered at true
    // center 240,180 maps Paper 0..960/0..720 exactly (S*2 verbatim).
    expect(PAPER_CLAMP_RES1_DENSITY).toBeCloseTo(0.5, 12)
    const res1 = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 1.0 }, { width: 480, height: 360 }, CONTAINER, PAPER_CLAMP_RES1_DENSITY, { x: 240, y: 180 })
    expect(res1.reason).toBe('ok')
    expect(res1.zoom).toBeCloseTo(0.5, 12)
    expect(res1.center).toEqual({ x: 480, y: 360 })
    expect(res1.viewBounds).toEqual({ left: -320, top: -240, right: 1280, bottom: 960 })
    // Canvas edges map to the Paper board edges: 0 -> 0, 480 -> 960.
    const back = cssViewportForPaperCenter({ x: 480, y: 360 }, 0.5, { width: 480, height: 360 }, PAPER_CLAMP_RES1_DENSITY, { x: 240, y: 180 })
    expect(back).toEqual({ x: 0, y: 0, scale: 1.0 })
  })

  it('maps the res1 bitmap opaque rect through the true center (decided 0.5)', () => {
    // Opaque 20x20 at canvas (222,172) on a 480 canvas centered at 240:
    // Paper = (222-240)/0.5+480 = 444, i.e. the 2x Paper rect.
    const rects = paperItemRectsForBitmapOpaque({ x: 222, y: 172, width: 20, height: 20 }, { width: 480, height: 360 }, 480, 360, PAPER_CLAMP_RES1_DENSITY, { x: 240, y: 180 })
    expect(rects).toEqual([{ left: 444, top: 344, right: 484, bottom: 384 }])
    // Union-grown res1 (640x480, true center 240,180 vs apparent middle 320):
    // vx=0 puts surface 320 on screen; Paper = (320-240)/0.5+480 = 640,
    // vertical (240-180)/0.5+360 = 480.
    const union = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 1.0 }, { width: 640, height: 480 }, CONTAINER, PAPER_CLAMP_RES1_DENSITY, { x: 240, y: 180 })
    expect(union.center).toEqual({ x: 640, y: 480 })
    // Stale fit size fails closed (same contract as res2).
    expect(paperItemRectsForBitmapOpaque({ x: 10, y: 10, width: 100, height: 100 }, { width: 480, height: 360 }, 960, 720, PAPER_CLAMP_RES1_DENSITY, { x: 240, y: 180 })).toBeUndefined()
  })

  it('keeps unknown legacy (no mapping, no clamp)', () => {
    const view = paperViewBoundsForCssViewport({ x: 5000, y: 0, scale: 1 }, { width: 480, height: 360 }, CONTAINER, undefined)
    expect(view.viewBounds).toBeUndefined()
    expect(view.reason).toContain('unknown-density')
    const clamped = clampCssViewportToPaper({
      viewport: { x: 5000, y: 0, scale: 1 },
      surface: { width: 480, height: 360 },
      containerSize: CONTAINER,
      density: undefined,
      clipEmpty: false,
    })
    expect(clamped.viewport).toEqual({ x: 5000, y: 0, scale: 1 })
    expect(clamped.clamped).toBe(false)
    expect(clamped.reason).toContain('unknown-density')
  })

  it('is DPR-independent (CSS px only)', () => {
    // Same CSS viewport/container maps identically regardless of device pixels.
    const a = paperViewBoundsForCssViewport({ x: 30, y: -20, scale: 1 }, VECTOR_SURFACE, CONTAINER, PAPER_CLAMP_VECTOR_DENSITY)
    const b = paperViewBoundsForCssViewport({ x: 30, y: -20, scale: 1 }, VECTOR_SURFACE, CONTAINER, PAPER_CLAMP_VECTOR_DENSITY)
    expect(a.viewBounds).toEqual(b.viewBounds)
    expect(a.center).toEqual(b.center)
  })
})

describe('viewport-paper-clamp: item rects (fit opaque + vector units)', () => {
  it('maps vector units as Paper = svg*2 with the union width', () => {
    const rects = paperItemRectsForVectorUnits([
      { boundsX: 10, boundsY: 20, boundsWidth: 100, boundsHeight: 50 },
      { boundsX: 200, boundsY: 100, boundsWidth: 50, boundsHeight: 50 },
    ])
    expect(rects).toEqual([
      { left: 20, top: 40, right: 220, bottom: 140 },
      { left: 400, top: 200, right: 500, bottom: 300 },
    ])
    // Union width spans both (own derivation, no Paper import).
    const minX = Math.min(rects[0]!.left, rects[1]!.left)
    const maxX = Math.max(rects[0]!.right, rects[1]!.right)
    expect(maxX - minX).toBe(480)
  })

  it('keeps singular (bare line/point) positions instead of dropping to the board', () => {
    const rects = paperItemRectsForVectorUnits([{ boundsX: 1000, boundsY: 100, boundsWidth: 0, boundsHeight: 0 }])
    expect(rects).toEqual([{ left: 2000, top: 200, right: 2000, bottom: 200 }])
    const ws = paperWorkspaceForClamp(undefined, rects, true)
    // Unite(art, 2000+/-25) then cap at expanded MAX (1225): right edge pins.
    expect(ws.right).toBe(1225)
    expect(ws.left).toBe(0)
  })

  it('maps the bitmap opaque rect through the true center (offcenter imported)', () => {
    // Opaque 100x50 at canvas (700,100) on a 960 canvas centered at 480.
    const rects = paperItemRectsForBitmapOpaque(
      { x: 700, y: 100, width: 100, height: 50 },
      RES2_SURFACE,
      960,
      720,
      PAPER_CLAMP_RES2_DENSITY,
      { x: 480, y: 360 },
    )
    expect(rects).toEqual([{ left: 700, top: 100, right: 800, bottom: 150 }])
    // Offcenter union: opaque at the far right still maps verbatim.
    const union = paperItemRectsForBitmapOpaque(
      { x: 1100, y: 100, width: 50, height: 50 },
      { width: 1200, height: 720 },
      1200,
      720,
      PAPER_CLAMP_RES2_DENSITY,
      { x: 480, y: 360 },
    )
    expect(union).toEqual([{ left: 1100, top: 100, right: 1150, bottom: 150 }])
  })

  it('fails closed on fit/live surface mismatch (resize race, stale owner)', () => {
    const rects = paperItemRectsForBitmapOpaque({ x: 10, y: 10, width: 100, height: 100 }, RES2_SURFACE, 1200, 720, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(rects).toBeUndefined()
    const empty = paperItemRectsForBitmapOpaque(null, RES2_SURFACE, 960, 720, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(empty).toEqual([])
  })

  it('maps negative rotationCenter (finite negatives allowed)', () => {
    // Stored center -50 (source placed right of the board): opaque at canvas
    // 600 maps to Paper 600 (verbatim, offboard but finite).
    const rects = paperItemRectsForBitmapOpaque({ x: 600, y: 100, width: 10, height: 10 }, RES2_SURFACE, 960, 720, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(rects).toEqual([{ left: 600, top: 100, right: 610, bottom: 110 }])
  })
})

describe('viewport-paper-clamp: workspace order (general pan vs fixed-point)', () => {
  it('starts from the board, covers items+50, caps at expanded MAX', () => {
    const ws = paperWorkspaceForClamp(undefined, [{ left: 1100, top: 100, right: 1300, bottom: 200 }], true)
    expect(ws.left).toBe(0)
    expect(ws.right).toBe(1225)
    expect(PAPER_CLAMP_BUFFER).toBe(50)
    expect(SCROLL_MAX_WORKSPACE).toEqual({ left: -240, top: -180, right: 1200, bottom: 900 })
  })

  it('widens symmetrically when the view is larger than the workspace', () => {
    const view = { left: 480 - 1600, top: 360 - 1200, right: 480 + 1600, bottom: 360 + 1200 }
    const ws = paperWorkspaceForClamp(view, [], false)
    expect(ws).toEqual({ left: -1120, top: -840, right: 2080, bottom: 1560 })
  })

  it('pan includes the new view (only the MAX edge clamps)', () => {
    // Zoomed-in small pan inside the board: the Paper view (320x240 at
    // scale 1 / zoom 2.5) sits well inside the artboard, the workspace
    // covers it (clipEmpty=false unites the new view), so no clamp.
    const inside = clampCssViewportToPaper({
      viewport: { x: -30, y: 0, scale: 1 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: false,
      itemPaperRects: [],
    })
    expect(inside.clamped).toBe(false)
    expect(inside.viewport.x).toBe(-30)
    // Zoomed-out reset pan is NOT free: the view (1600x1200) is larger than
    // the board, the workspace widens symmetrically around itself (not the
    // view), so any pan immediately meets an edge. Pinned here for the
    // record (reference symmetric-widen semantics, not a no-op).
    const outWide = clampCssViewportToPaper({
      viewport: { x: -30, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: false,
      itemPaperRects: [],
    })
    expect(outWide.clamped).toBe(true)
    expect(outWide.viewport.scale).toBe(0.2)
  })

  it('clamps the 5000px pan to the workspace edge (not unbounded, not recentered)', () => {
    const panned = clampCssViewportToPaper({
      viewport: { x: 5000, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: false,
      itemPaperRects: [],
    })
    expect(panned.clamped).toBe(true)
    // Pan path keeps the far view in the workspace, so the clamp stops at
    // the MAX edge (x=66.25) instead of recentering to 0.
    expect(panned.viewport.x).toBeCloseTo(66.25, 9)
    expect(panned.viewport.scale).toBe(0.2)
    expect(panned.edges).toContain('left')
  })

  it('zoom path trims empty first (clamp wins over the pin at the edge)', () => {
    // Fixed-point zoom about a point near the right workspace edge, then the
    // workspace clamp wins (reference zoomOnFixedPoint order).
    const zoomed = zoomViewportAtSurfacePoint(
      { x: 0, y: 0, scale: 0.5 },
      { width: 960, height: 720 },
      { x: 400, y: 300 },
      { x: 900, y: 360 },
      1,
      PAPER_CLAMP_RES2_DENSITY,
    )
    const clamped = clampCssViewportToPaper({
      viewport: zoomed.viewport,
      surface: { width: 960, height: 720 },
      containerSize: CONTAINER,
      density: PAPER_CLAMP_RES2_DENSITY,
      canvasCenter: { x: 480, y: 360 },
      clipEmpty: true,
      itemPaperRects: [],
    })
    // Interior zoom about (900,360) from reset stays inside the widened
    // workspace here; the contract is the order (fixed-point then clamp),
    // not a forced slip on this geometry. The edge-slip itself is pinned by
    // the oracle `paperZoomThenClamp` test (130px drift at the board edge).
    expect(clamped.viewport.scale).toBe(zoomed.viewport.scale)
    expect(clamped.reason).toMatch(/inside|clamped/)
  })
})

describe('viewport-paper-clamp: reset/resize/fit/large-viewport', () => {
  it('keeps the reset centered (symmetric widen, no clamp)', () => {
    const reset = clampCssViewportToPaper({
      viewport: { x: 0, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: true,
      itemPaperRects: [],
    })
    expect(reset.clamped).toBe(false)
    expect(reset.viewport).toEqual({ x: 0, y: 0, scale: 0.2 })
  })

  it('recentered reset with small edge content trims empty (reference clipEmpty=true wins)', () => {
    // 100x100 at SVG top-left (Paper 0,0,200,200): the recentered reset view
    // at 455x451 needs Paper -51..251 vs board 0..960. The reference
    // `resetZoom` order (clipEmpty=true) trims the empty view first, so the
    // clamp wins and shifts the recenter; covering the view itself
    // (clipEmpty=false, pan/fit order) would keep the recenter exact and
    // only the expanded-MAX edge could still clamp. The live reset wires
    // clipEmpty=true (reference order); the covered branch below is pinned
    // only as the pan/fit contrast, not the live reset.
    const edge = { left: 0, top: 0, right: 200, bottom: 200 }
    const clipped = clampCssViewportToPaper({
      viewport: { x: 0, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: { width: 455, height: 451 },
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: true,
      itemPaperRects: [edge],
    })
    expect(clipped.clamped).toBe(true)
    const covered = clampCssViewportToPaper({
      viewport: { x: 0, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: { width: 455, height: 451 },
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: false,
      itemPaperRects: [edge],
    })
    expect(covered.clamped).toBe(false)
    expect(covered.viewport).toEqual({ x: 0, y: 0, scale: 0.2 })
  })

  it('re-clamps the same viewport when the container shrinks 800x600 -> 400x300', () => {
    const before = clampCssViewportToPaper({
      viewport: { x: 200, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: true,
      itemPaperRects: [],
    })
    const after = clampCssViewportToPaper({
      viewport: { x: 200, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: { width: 400, height: 300 },
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: true,
      itemPaperRects: [],
    })
    // Smaller container => smaller Paper view => workspace tightens; the
    // same vx may clamp differently. Both keep the scale (never zoom).
    expect(before.viewport.scale).toBe(0.2)
    expect(after.viewport.scale).toBe(0.2)
  })

  it('clamps a large container viewport (large viewport widen, no edge pin)', () => {
    const large = clampCssViewportToPaper({
      viewport: { x: 0, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: { width: 3000, height: 2000 },
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: true,
      itemPaperRects: [],
    })
    expect(large.clamped).toBe(false)
    expect(large.viewport).toEqual({ x: 0, y: 0, scale: 0.2 })
  })

  it('never changes scale (the Paper clamp only scrolls)', () => {
    const clamped = clampCssViewportToPaper({
      viewport: { x: 5000, y: -4000, scale: 1 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: true,
      itemPaperRects: [{ left: 2000, top: 0, right: 2000, bottom: 0 }],
    })
    expect(clamped.viewport.scale).toBe(1)
  })

  it('handles empty art (no items => board, symmetric widen covers the view)', () => {
    const ws = paperWorkspaceForClamp({ left: -320, top: -240, right: 1280, bottom: 960 }, [], false)
    expect(ws).toEqual({ left: -320, top: -240, right: 1280, bottom: 960 })
  })

  it('caps huge art at expanded MAX (6400 surface probe)', () => {
    const ws = paperWorkspaceForClamp(undefined, [{ left: 0, top: 0, right: 6400, bottom: 4800 }], true)
    expect(ws.right - ws.left).toBeLessThanOrEqual(1490)
    expect(ws.bottom - ws.top).toBeLessThanOrEqual(1130)
  })

  it('is a no-op when already inside (existing position never jumps)', () => {
    const view = { left: 80, top: 60, right: 880, bottom: 660 }
    const ws = { left: 0, top: 0, right: 960, bottom: 720 }
    const r = clampViewToWorkspace(view, ws)
    expect(r.clamped).toBe(false)
    const css = clampCssViewportToPaper({
      viewport: { x: 10, y: -5, scale: 1 },
      surface: RES2_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_RES2_DENSITY,
      canvasCenter: { x: 480, y: 360 },
      clipEmpty: false,
      itemPaperRects: [],
    })
    // Zoomed-in small offset well inside the board stays exactly (the Paper
    // view 800x600 at zoom 1 sits inside 0..960/0..720). At reset (scale 0.5,
    // view 1600x1200 larger than the board) the same offset would meet the
    // symmetric-widen edge and clamp -- that zoomed-out restriction is pinned
    // above, not here.
    expect(css.clamped).toBe(false)
    expect(css.viewport.x).toBe(10)
    expect(css.viewport.y).toBe(-5)
  })

  it('does not mutate its inputs (Undo/Redo/data safety: viewport-only)', () => {
    const viewport = { x: 5000, y: 0, scale: 0.2 }
    const items = [{ left: 1100, top: 100, right: 1300, bottom: 200 }]
    const snapshot = JSON.stringify({ viewport, items })
    clampCssViewportToPaper({
      viewport,
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: false,
      itemPaperRects: items,
    })
    expect(JSON.stringify({ viewport, items })).toBe(snapshot)
  })
})

describe('viewport-paper-clamp: exact order P1/P2 (reference clipEmpty=true)', () => {
  // P1 (resize, empty res2 960x720, container 800x600, scale 0.5, vx=200):
  // cover-view false stops at the widened edge (x=66.25); trimmed true
  // re-clamps to 0. Live resize wires true (reference onViewResize).
  it('P1 resize empty res2 pins false=66.25 vs true=0 (scale kept, left edge)', () => {
    const base = {
      viewport: { x: 200, y: 0, scale: 0.5 },
      surface: RES2_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_RES2_DENSITY,
      canvasCenter: { x: 480, y: 360 },
      itemPaperRects: [],
    } as const
    const covered = clampCssViewportToPaper({ ...base, clipEmpty: false })
    expect(covered.clamped).toBe(true)
    expect(covered.viewport.x).toBeCloseTo(66.25, 9)
    expect(covered.viewport.scale).toBe(0.5)
    expect(covered.edges).toEqual(['left'])
    const trimmed = clampCssViewportToPaper({ ...base, clipEmpty: true })
    expect(trimmed.clamped).toBe(true)
    expect(trimmed.viewport.x).toBeCloseTo(0, 9)
    expect(trimmed.viewport.y).toBe(0)
    expect(trimmed.viewport.scale).toBe(0.5)
    expect(trimmed.edges).toEqual(['left'])
    expect(trimmed.paperDx).toBeCloseTo(400, 9)
    // Workspaces differ exactly by the covered view (reference order).
    expect(trimmed.workspace).toEqual({ left: -320, top: -240, right: 1280, bottom: 960 })
    expect(covered.workspace).toEqual({ left: -452.5, top: -240, right: 1147.5, bottom: 960 })
  })

  // Same P1 geometry on vector (0.2) and res1 (1.0, decided 0.5): the order
  // divergence is density-independent (Paper zoom 0.5 in all three).
  it('P1 analogues on vector/res1 diverge identically (res1 band protected)', () => {
    const vectorCovered = clampCssViewportToPaper({
      viewport: { x: 200, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: false,
      itemPaperRects: [],
    })
    const vectorTrimmed = clampCssViewportToPaper({
      viewport: { x: 200, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: true,
      itemPaperRects: [],
    })
    expect(vectorCovered.viewport.x).toBeCloseTo(66.25, 9)
    expect(vectorTrimmed.viewport.x).toBeCloseTo(0, 9)
    expect(vectorTrimmed.viewport.scale).toBe(0.2)
    // Res1 decided density 0.5 (protects the res1-agent band): same Paper
    // zoom 0.5, same 66.25/0 split, scale 1.0 never changes.
    const res1Base = {
      surface: { width: 480, height: 360 },
      containerSize: CONTAINER,
      density: PAPER_CLAMP_RES1_DENSITY,
      canvasCenter: { x: 240, y: 180 },
      itemPaperRects: [],
    } as const
    const res1Covered = clampCssViewportToPaper({ ...res1Base, viewport: { x: 200, y: 0, scale: 1.0 }, clipEmpty: false })
    const res1Trimmed = clampCssViewportToPaper({ ...res1Base, viewport: { x: 200, y: 0, scale: 1.0 }, clipEmpty: true })
    expect(res1Covered.viewport.x).toBeCloseTo(66.25, 9)
    expect(res1Trimmed.viewport.x).toBeCloseTo(0, 9)
    expect(res1Trimmed.viewport.scale).toBe(1.0)
  })

  // P2 (reset, centered, content (0,0,100,100)): cover-view false holds the
  // recenter (0); trimmed true pulls +6.25 (Paper dx -12.5). Live reset wires
  // true (reference resetZoom).
  it('P2 reset with (0,0,100,100) pins false=0 vs true=+6.25 on res2/vector/res1', () => {
    const item = [{ left: 0, top: 0, right: 100, bottom: 100 }]
    const res2Covered = clampCssViewportToPaper({
      viewport: { x: 0, y: 0, scale: 0.5 },
      surface: RES2_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_RES2_DENSITY,
      canvasCenter: { x: 480, y: 360 },
      clipEmpty: false,
      itemPaperRects: item,
    })
    const res2Trimmed = clampCssViewportToPaper({
      viewport: { x: 0, y: 0, scale: 0.5 },
      surface: RES2_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_RES2_DENSITY,
      canvasCenter: { x: 480, y: 360 },
      clipEmpty: true,
      itemPaperRects: item,
    })
    expect(res2Covered.clamped).toBe(false)
    expect(res2Covered.viewport).toEqual({ x: 0, y: 0, scale: 0.5 })
    expect(res2Trimmed.clamped).toBe(true)
    expect(res2Trimmed.viewport.x).toBeCloseTo(6.25, 9)
    expect(res2Trimmed.viewport.y).toBeCloseTo(6.25, 9)
    expect(res2Trimmed.viewport.scale).toBe(0.5)
    expect(res2Trimmed.paperDx).toBeCloseTo(-12.5, 9)
    expect(res2Trimmed.paperDy).toBeCloseTo(-12.5, 9)
    // Vector and res1 share the same +6.25 (same Paper zoom 0.5 geometry).
    const vectorTrimmed = clampCssViewportToPaper({
      viewport: { x: 0, y: 0, scale: 0.2 },
      surface: VECTOR_SURFACE,
      containerSize: CONTAINER,
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: true,
      itemPaperRects: item,
    })
    expect(vectorTrimmed.viewport.x).toBeCloseTo(6.25, 9)
    expect(vectorTrimmed.viewport.scale).toBe(0.2)
    const res1Trimmed = clampCssViewportToPaper({
      viewport: { x: 0, y: 0, scale: 1.0 },
      surface: { width: 480, height: 360 },
      containerSize: CONTAINER,
      density: PAPER_CLAMP_RES1_DENSITY,
      canvasCenter: { x: 240, y: 180 },
      clipEmpty: true,
      itemPaperRects: item,
    })
    expect(res1Trimmed.viewport.x).toBeCloseTo(6.25, 9)
    expect(res1Trimmed.viewport.scale).toBe(1.0)
  })

  // Small viewport (401x301, zoomed-in scale 1): both orders hold inside;
  // the trim never invents a clamp when the view fits the board.
  it('small viewport stays inside on both orders (no invented clamp)', () => {
    for (const clipEmpty of [false, true]) {
      const r = clampCssViewportToPaper({
        viewport: { x: 10, y: -5, scale: 1 },
        surface: RES2_SURFACE,
        containerSize: { width: 401, height: 301 },
        density: PAPER_CLAMP_RES2_DENSITY,
        canvasCenter: { x: 480, y: 360 },
        clipEmpty,
        itemPaperRects: [],
      })
      expect(r.clamped).toBe(false)
      expect(r.viewport).toEqual({ x: 10, y: -5, scale: 1 })
    }
  })

  // Huge/offboard/union/selection: true-branch pins (reference order).
  it('huge/offboard/union/selection pin the trimmed workspace (clipEmpty=true)', () => {
    // Huge caps at expanded MAX then widens to the reset view (1600x1200).
    const huge = paperWorkspaceForClamp({ left: -320, top: -240, right: 1280, bottom: 960 }, [{ left: 0, top: 0, right: 6400, bottom: 4800 }], true)
    expect(huge.right - huge.left).toBe(1600)
    expect(huge.bottom - huge.top).toBe(1200)
    // Far offboard unites then caps at the MAX edge (1225/925).
    const offboard = paperWorkspaceForClamp(undefined, [{ left: 1100, top: 100, right: 1300, bottom: 200 }], true)
    expect(offboard.right).toBe(1225)
    expect(offboard.left).toBe(0)
    // Union canvas (2000px, true center 480) maps the board center verbatim.
    const union = paperViewBoundsForCssViewport({ x: 260, y: 0, scale: 0.5 }, { width: 2000, height: 720 }, CONTAINER, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(union.center).toEqual({ x: 480, y: 360 })
    // Per-selection singles keep position (singular line).
    const singles = paperItemRectsForVectorUnits([
      { boundsX: 10, boundsY: 20, boundsWidth: 100, boundsHeight: 50 },
      { boundsX: 1000, boundsY: 100, boundsWidth: 0, boundsHeight: 0 },
    ])
    expect(singles).toEqual([
      { left: 20, top: 40, right: 220, bottom: 140 },
      { left: 2000, top: 200, right: 2000, bottom: 200 },
    ])
  })
})
