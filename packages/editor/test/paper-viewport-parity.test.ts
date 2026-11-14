import { describe, expect, it } from 'bun:test'
import {
  BITMAP_STAGE_SIZE,
  clampCssViewportScale,
  clampCssViewportScaleForBoard,
  clampPaperCenterToWorkspace,
  clampPaperZoom,
  cssPxPerPaperUnit,
  cssScaleForPaperZoom,
  cssScreenToSurface,
  cssSurfaceToScreen,
  cssZoomAtScreenPoint,
  CSS_VIEWPORT_MAX_SCALE,
  CSS_VIEWPORT_MIN_SCALE,
  DEFAULT_EDIT_SURFACE,
  measuredCssPxPerPaperUnit,
  PAPER_ART_BOARD,
  PAPER_ART_CENTER,
  PAPER_FIT_BASE_ZOOM,
  PAPER_FIT_MAX_ZOOM,
  PAPER_OUTERMOST_ZOOM_LEVEL,
  PAPER_RESET_ZOOM,
  PAPER_ZOOM_PERCENT_MAPPING,
  PAPER_ZOOM_SAFE_MAX,
  paperToScreen,
  paperWheelZoomAdditive,
  paperZoomAtScreenPoint,
  paperZoomForCssScale,
  paperZoomStepAdditive,
  resolvePaperFitZoom,
  screenToPaper,
} from '../src/features/costumes/paper-viewport-parity'

// Clean-room parity math for the zoom audit: derives the Paper <-> CSS
// correspondence from actual-size formulas. No DOM, no Paper.js, no vendor
// code copied. Existing product files are not touched here.

describe('paper-viewport-parity actual-size formula', () => {
  it('derives CSS px per Paper unit as (W / Pw) * s', () => {
    // Bitmap default: 2400 surface px stand for the 960 Paper-unit board.
    expect(cssPxPerPaperUnit(2400, 960, 1)).toBeCloseTo(2.5, 12)
    // At 25% the density quarters; at 500% it quintuples.
    expect(cssPxPerPaperUnit(2400, 960, 0.25)).toBeCloseTo(0.625, 12)
    expect(cssPxPerPaperUnit(2400, 960, 5)).toBeCloseTo(12.5, 12)
    // Vector art box: 1 SVG unit = 5 surface px, so 1 Paper unit = 5*s CSS px
    // when the caller maps SVG units 1:1 to Paper units.
    expect(cssPxPerPaperUnit(480 * 5, 480, 1)).toBeCloseTo(5, 12)
    // Resize flows through the parameters (no hardcoded container size).
    expect(cssPxPerPaperUnit(1200, 960, 1)).toBeCloseTo(1.25, 12)
    // Mode difference is explicit: same scale, different W/Pw per mode.
    const bitmap = cssPxPerPaperUnit(2400, 960, 2)
    const vectorArt = cssPxPerPaperUnit(480, 96, 2)
    expect(bitmap).toBeCloseTo(5, 12)
    expect(vectorArt).toBeCloseTo(10, 12)
  })

  it('fails closed on non-finite / zero inputs (unlaid-out, zero bounds)', () => {
    expect(cssPxPerPaperUnit(0, 960, 1)).toBe(0)
    expect(cssPxPerPaperUnit(2400, 0, 1)).toBe(0)
    expect(cssPxPerPaperUnit(Number.NaN, 960, 1)).toBe(0)
    expect(cssPxPerPaperUnit(2400, 960, Number.NaN)).toBeCloseTo(0.5, 12) // non-finite scale falls back to the board Paper reset (0.2 * 2.5)
    expect(measuredCssPxPerPaperUnit(0, 960)).toBe(0)
    expect(measuredCssPxPerPaperUnit(2400, 0)).toBe(0)
    expect(measuredCssPxPerPaperUnit(Number.NaN, 960)).toBe(0)
  })

  it('converts Paper zoom <-> CSS scale as exact inverses (round-trip)', () => {
    // s=1 with the default surfaces <=> Paper 2.5; Scratch reset 0.5 is the
    // live CSS 0.2 on the per-board band (vector 0.1332..5: exact, no gap).
    expect(paperZoomForCssScale(1, 2400, 960)).toBeCloseTo(2.5, 12)
    expect(cssScaleForPaperZoom(0.5, 2400, 960).theoretical).toBeCloseTo(0.2, 12)
    expect(cssScaleForPaperZoom(0.5, 2400, 960).clamped).toBeCloseTo(0.2, 12)
    expect(paperZoomForCssScale(0.2, 2400, 960)).toBeCloseTo(0.5, 12)
    // Round-trip on the theoretical value across modes/scales/resizes.
    const cases = [
      { s: 0.25, W: 2400, Pw: 960 },
      { s: 0.2, W: 2400, Pw: 960 },
      { s: 1, W: 2400, Pw: 960 },
      { s: 5, W: 2400, Pw: 960 },
      { s: 2, W: 1200, Pw: 960 },
      { s: 1, W: 480, Pw: 96 },
      { s: 0.5, W: 960, Pw: 960 },
      { s: 0.333, W: 960, Pw: 960 },
    ]
    for (const { s, W, Pw } of cases) {
      const z = paperZoomForCssScale(s, W, Pw)
      const back = cssScaleForPaperZoom(z, W, Pw)
      expect(back.theoretical).toBeCloseTo(clampCssViewportScaleForBoard(s, W, Pw), 10)
    }
    // Guarded inputs never leak NaN/Infinity: a non-finite Paper zoom falls
    // back to reset 0.5, i.e. CSS 0.2 theoretical, live on the vector board.
    expect(paperZoomForCssScale(1, 0, 960)).toBe(PAPER_RESET_ZOOM)
    expect(cssScaleForPaperZoom(Number.NaN, 2400, 960).theoretical).toBeCloseTo(0.2, 12)
    expect(cssScaleForPaperZoom(Number.NaN, 2400, 960).clamped).toBeCloseTo(0.2, 12)
  })
})

describe('paper-viewport-parity zoom steps', () => {
  it('steps buttons additively +/-0.5 with the 0.333 floor', () => {
    expect(paperZoomStepAdditive(0.5, 1)).toBeCloseTo(1.0, 12)
    expect(paperZoomStepAdditive(1.0, -1)).toBeCloseTo(0.5, 12)
    // From the floor the reference toolbar returns directly to reset zoom.
    expect(paperZoomStepAdditive(0.333, 1)).toBeCloseTo(0.5, 12)
    expect(paperZoomStepAdditive(0.333, -1)).toBe(PAPER_OUTERMOST_ZOOM_LEVEL)
    // Unbounded above (unlike the CSS 5 cap).
    expect(paperZoomStepAdditive(5, 1)).toBeCloseTo(5.5, 12)
    expect(paperZoomStepAdditive(Number.NaN, 1)).toBeCloseTo(1.0, 12)
  })

  it('applies the ctrl-wheel additive gain -deltaY/1000', () => {
    expect(paperWheelZoomAdditive(0.5, -100)).toBeCloseTo(0.6, 12)
    expect(paperWheelZoomAdditive(0.5, 100)).toBeCloseTo(0.4, 12)
    expect(paperWheelZoomAdditive(0.5, 0)).toBe(0.5)
    // Floor holds for large positive deltas.
    expect(paperWheelZoomAdditive(0.4, 1000)).toBe(PAPER_OUTERMOST_ZOOM_LEVEL)
    // Non-finite delta is a no-op.
    expect(paperWheelZoomAdditive(0.5, Number.NaN)).toBe(0.5)
  })

  it('prevents overflow on the unbounded zoom axis', () => {
    expect(clampPaperZoom(Number.POSITIVE_INFINITY)).toBe(PAPER_RESET_ZOOM)
    expect(clampPaperZoom(1e308)).toBe(PAPER_ZOOM_SAFE_MAX)
    expect(paperWheelZoomAdditive(PAPER_ZOOM_SAFE_MAX, -1e9)).toBe(PAPER_ZOOM_SAFE_MAX)
    expect(paperZoomStepAdditive(PAPER_ZOOM_SAFE_MAX, 1)).toBe(PAPER_ZOOM_SAFE_MAX)
    // CSS side stays in its band even for extreme Paper zooms.
    expect(cssScaleForPaperZoom(PAPER_ZOOM_SAFE_MAX, 2400, 960).clamped).toBe(CSS_VIEWPORT_MAX_SCALE)
    expect(clampCssViewportScale(99)).toBe(CSS_VIEWPORT_MAX_SCALE)
    expect(clampCssViewportScale(0.1)).toBe(CSS_VIEWPORT_MIN_SCALE)
  })
})

describe('paper-viewport-parity fixed point and forward/inverse', () => {
  const SURFACE = { width: 2400, height: 1800 }
  const CENTER = { x: 500, y: 400 }

  it('keeps the CSS anchor within 1px and inverts exactly', () => {
    const viewport = { x: 12, y: -34, scale: 2 }
    const points = [
      { x: 0, y: 0 },
      { x: 2400, y: 1800 },
      { x: 1200, y: 900 },
      { x: 600, y: 1350 },
    ]
    for (const point of points) {
      const screen = cssSurfaceToScreen(point, SURFACE, CENTER, viewport)
      const back = cssScreenToSurface(screen, SURFACE, CENTER, viewport)
      expect(back.x).toBeCloseTo(point.x, 10)
      expect(back.y).toBeCloseTo(point.y, 10)
    }
    for (const factor of [1.1, 0.9, 2, 0.5]) {
      for (const anchor of [CENTER, { x: 620, y: 480 }, { x: 100, y: 100 }]) {
        const fixed = cssScreenToSurface(anchor, SURFACE, CENTER, viewport)
        const zoomed = cssZoomAtScreenPoint(viewport, SURFACE, CENTER, anchor, factor)
        const after = cssSurfaceToScreen(fixed, SURFACE, CENTER, zoomed.viewport)
        expect(Math.hypot(after.x - anchor.x, after.y - anchor.y)).toBeLessThan(1)
      }
    }
    // Non-finite factor is a no-op.
    expect(cssZoomAtScreenPoint(viewport, SURFACE, CENTER, CENTER, Number.NaN).appliedFactor).toBe(1)
  })

  it('keeps the Paper anchor fixed and inverts exactly', () => {
    const view = { center: { ...PAPER_ART_CENTER }, zoom: 0.5 }
    const screenCenter = { x: 500, y: 400 }
    const paperPoints = [
      { x: 480, y: 360 },
      { x: 0, y: 0 },
      { x: 960, y: 720 },
      { x: 600, y: 200 },
    ]
    for (const point of paperPoints) {
      const screen = paperToScreen(point, view, screenCenter)
      const back = screenToPaper(screen, view, screenCenter)
      expect(back.x).toBeCloseTo(point.x, 10)
      expect(back.y).toBeCloseTo(point.y, 10)
    }
    // Pointer-fixed: additive wheel gain then re-anchor; error < 1 screen px.
    for (const deltaY of [-100, 100, -500]) {
      const nextZoom = paperWheelZoomAdditive(view.zoom, deltaY)
      const anchor = { x: screenCenter.x + 60, y: screenCenter.y + 40 }
      const fixed = screenToPaper(anchor, view, screenCenter)
      const zoomed = paperZoomAtScreenPoint(view, screenCenter, anchor, nextZoom)
      const after = paperToScreen(fixed, zoomed.view, screenCenter)
      expect(Math.hypot(after.x - anchor.x, after.y - anchor.y)).toBeLessThan(1)
      expect(zoomed.appliedZoom).toBeCloseTo(nextZoom, 12)
    }
    // Selection-center variant: zooming about the selection center keeps the
    // selection center on the same screen pixel by construction.
    const selectionCenter = { x: 600, y: 200 }
    const selectionView = { center: selectionCenter, zoom: 1 }
    const zoomedSelection = paperZoomAtScreenPoint(
      selectionView,
      screenCenter,
      paperToScreen(selectionCenter, selectionView, screenCenter),
      1.5,
    )
    const afterSelection = paperToScreen(selectionCenter, zoomedSelection.view, screenCenter)
    const beforeSelection = paperToScreen(selectionCenter, selectionView, screenCenter)
    expect(Math.hypot(afterSelection.x - beforeSelection.x, afterSelection.y - beforeSelection.y)).toBeLessThan(1)
  })
})

describe('paper-viewport-parity FIT', () => {
  // Viewport unit contract: client CSS px (canvas.clientWidth/Height), NOT
  // Paper units. At the 0.5 base zoom a 480x360 client shows exactly the
  // 960x720 art board (visible Paper = client / zoom).
  const CLIENT = { width: 480, height: 360 }

  // Independent oracle: plain re-execution of the reference `zoomToFit`
  // lines (reset 0.5, expand-then-pad, ratio against client CSS px, clamp
  // [0.125, 1], zoom when < 1). No helper import, no vendor code.
  const oracleFitZoom = (
    bounds: { width: number; height: number } | null | undefined,
    client: { width: number; height: number } | null | undefined,
    isBitmap: boolean,
  ): number => {
    const BASE = 0.5
    const MIN = 0.125
    if (!bounds || !client) return BASE
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return BASE
    if (bounds.width <= 0 || bounds.height <= 0) return BASE
    if (!Number.isFinite(client.width) || !Number.isFinite(client.height)) return BASE
    if (client.width <= 0 || client.height <= 0) return BASE
    // Proven Paper.js semantics: expand(50) adds +50 TOTAL per extent.
    const expandedW = bounds.width + (isBitmap ? 50 : 0)
    const expandedH = bounds.height + (isBitmap ? 50 : 0)
    const paddedW = expandedW * 1.5
    const paddedH = expandedH * 1.5
    if (!Number.isFinite(paddedW) || !Number.isFinite(paddedH)) return BASE
    const raw = BASE * Math.max(paddedW / client.width, paddedH / client.height)
    if (!Number.isFinite(raw) || raw <= 0) return BASE
    const ratio = Math.max(MIN, Math.min(1, raw))
    if (ratio >= 1) return BASE
    return BASE / ratio
  }

  it('proves Paper Rectangle.expand(50) adds +50 total per extent (real Paper.js)', async () => {
    const paper = (await import('paper')).default
    const before = new paper.Rectangle(10, 20, 100, 80)
    const expanded = before.expand(50)
    expect(expanded.width).toBeCloseTo(150, 12)
    expect(expanded.height).toBeCloseTo(130, 12)
    expect(expanded.x).toBeCloseTo(10 - 25, 12)
    expect(expanded.y).toBeCloseTo(20 - 25, 12)
    // Center preserved, per-side growth is 25 -- not 50.
    expect(expanded.center.x).toBeCloseTo(before.center.x, 12)
    expect(expanded.center.y).toBeCloseTo(before.center.y, 12)
  })

  it('matches the independent oracle on concrete values (expand-then-pad over client CSS px)', () => {
    const cases = [
      { bounds: { width: 10, height: 10 }, client: CLIENT, isBitmap: false },
      { bounds: { width: 10, height: 10 }, client: CLIENT, isBitmap: true },
      { bounds: { width: 100, height: 100 }, client: CLIENT, isBitmap: false },
      { bounds: { width: 100, height: 100 }, client: CLIENT, isBitmap: true },
      { bounds: { width: 400, height: 300 }, client: CLIENT, isBitmap: false },
      { bounds: { width: 400, height: 300 }, client: CLIENT, isBitmap: true },
      { bounds: { width: 960, height: 720 }, client: CLIENT, isBitmap: false },
      { bounds: { width: 960, height: 720 }, client: CLIENT, isBitmap: true },
      { bounds: { width: 5000, height: 5000 }, client: CLIENT, isBitmap: false },
      { bounds: { width: 1, height: 1000 }, client: CLIENT, isBitmap: true },
      { bounds: { width: 1000, height: 1 }, client: CLIENT, isBitmap: false },
      { bounds: { width: 200, height: 100 }, client: { width: 1280, height: 800 }, isBitmap: true },
    ]
    for (const { bounds, client, isBitmap } of cases) {
      expect(resolvePaperFitZoom(bounds, client, isBitmap)).toBeCloseTo(
        oracleFitZoom(bounds, client, isBitmap),
        12,
      )
    }
    // Hand-computed spot values pin the corrected formula:
    // - vector 100x100 on 480x360: padded 150x150,
    //   ratio = 0.5 * 150/360 = 0.20833... -> 0.5/0.20833... = 2.4.
    expect(resolvePaperFitZoom({ width: 100, height: 100 }, CLIENT, false)).toBeCloseTo(2.4, 12)
    // - bitmap 100x100: expanded 150, padded 225,
    //   ratio = 0.5 * 225/360 = 0.3125 -> 1.6 (NOT the old 1.44 from +100-after-pad).
    expect(resolvePaperFitZoom({ width: 100, height: 100 }, CLIENT, true)).toBeCloseTo(1.6, 12)
    // - bitmap 10x10 hits the MIN_RATIO boundary exactly:
    //   (10 + 50) * 1.5 = 90, 0.5 * 90/360 = 0.125 -> 4.
    expect(resolvePaperFitZoom({ width: 10, height: 10 }, CLIENT, true)).toBeCloseTo(4, 12)
    // - full-board vector content stays at the base (ratio clamps to 1).
    expect(resolvePaperFitZoom({ ...PAPER_ART_BOARD }, CLIENT, false)).toBeCloseTo(0.5, 12)
    // - huge content zooms fully out to the base (never below the floor).
    expect(resolvePaperFitZoom({ width: 5000, height: 5000 }, CLIENT, false)).toBeCloseTo(0.5, 12)
    expect(PAPER_FIT_MAX_ZOOM).toBe(4)
    expect(PAPER_FIT_BASE_ZOOM).toBe(0.5)
  })

  it('matches the oracle on extreme aspect ratios and tiny/large viewports', () => {
    const extremes = [
      { bounds: { width: 1, height: 1 }, client: { width: 480, height: 360 }, isBitmap: false },
      { bounds: { width: 1, height: 1 }, client: { width: 480, height: 360 }, isBitmap: true },
      { bounds: { width: 1, height: 2000 }, client: { width: 480, height: 360 }, isBitmap: false },
      { bounds: { width: 2000, height: 1 }, client: { width: 480, height: 360 }, isBitmap: true },
      { bounds: { width: 320, height: 240 }, client: { width: 50, height: 40 }, isBitmap: false },
      { bounds: { width: 320, height: 240 }, client: { width: 3840, height: 2160 }, isBitmap: true },
      { bounds: { width: 0.125, height: 0.125 }, client: { width: 480, height: 360 }, isBitmap: false },
      { bounds: { width: 1e6, height: 1 }, client: { width: 480, height: 360 }, isBitmap: false },
    ]
    for (const { bounds, client, isBitmap } of extremes) {
      expect(resolvePaperFitZoom(bounds, client, isBitmap)).toBeCloseTo(
        oracleFitZoom(bounds, client, isBitmap),
        10,
      )
    }
    // Output range holds on every extreme: [0.5, 4].
    for (const { bounds, client, isBitmap } of extremes) {
      const zoom = resolvePaperFitZoom(bounds, client, isBitmap)
      expect(zoom).toBeGreaterThanOrEqual(0.5)
      expect(zoom).toBeLessThanOrEqual(4)
    }
  })

  it('fails closed on no selection, zero bounds, bad viewport, non-finite', () => {
    for (const isBitmap of [false, true]) {
      expect(resolvePaperFitZoom(null, CLIENT, isBitmap)).toBe(PAPER_FIT_BASE_ZOOM)
      expect(resolvePaperFitZoom(undefined, CLIENT, isBitmap)).toBe(PAPER_FIT_BASE_ZOOM)
      expect(resolvePaperFitZoom({ width: 0, height: 100 }, CLIENT, isBitmap)).toBe(PAPER_FIT_BASE_ZOOM)
      expect(resolvePaperFitZoom({ width: 100, height: 0 }, CLIENT, isBitmap)).toBe(PAPER_FIT_BASE_ZOOM)
      expect(resolvePaperFitZoom({ width: -5, height: 10 }, CLIENT, isBitmap)).toBe(PAPER_FIT_BASE_ZOOM)
      expect(resolvePaperFitZoom({ width: Number.NaN, height: 10 }, CLIENT, isBitmap)).toBe(PAPER_FIT_BASE_ZOOM)
      expect(resolvePaperFitZoom({ width: 100, height: 100 }, null, isBitmap)).toBe(PAPER_FIT_BASE_ZOOM)
      expect(oracleFitZoom({ width: 100, height: 100 }, null, isBitmap)).toBe(PAPER_FIT_BASE_ZOOM)
    }
    expect(resolvePaperFitZoom({ width: 100, height: 100 }, { width: 0, height: 360 }, false)).toBe(
      PAPER_FIT_BASE_ZOOM,
    )
    expect(resolvePaperFitZoom({ width: 100, height: 100 }, { width: Number.NaN, height: 360 }, false)).toBe(
      PAPER_FIT_BASE_ZOOM,
    )
    // Absurd bounds cannot leak Infinity: overflow in the padded extent
    // falls back to the base zoom (fully zoomed out).
    expect(resolvePaperFitZoom({ width: 1e308, height: 1e308 }, CLIENT, false)).toBe(PAPER_FIT_BASE_ZOOM)
    expect(oracleFitZoom({ width: 1e308, height: 1e308 }, CLIENT, false)).toBe(PAPER_FIT_BASE_ZOOM)
  })

  it('documents the resize contract via explicit client CSS px viewport', () => {
    // Same Paper-unit content in a half-size client needs ~2x the zoom-out
    // denominator, so FIT reports a smaller zoom (more zoomed out).
    const wide = resolvePaperFitZoom({ width: 400, height: 300 }, { width: 960, height: 720 }, false)
    const narrow = resolvePaperFitZoom({ width: 400, height: 300 }, { width: 480, height: 360 }, false)
    expect(narrow).toBeLessThan(wide)
    expect(wide).toBeCloseTo(oracleFitZoom({ width: 400, height: 300 }, { width: 960, height: 720 }, false), 12)
    expect(narrow).toBeCloseTo(oracleFitZoom({ width: 400, height: 300 }, { width: 480, height: 360 }, false), 12)
  })
})

describe('paper-viewport-parity scroll clamp', () => {
  it('keeps the visible rect inside the workspace, centering when larger', () => {
    // 800x600 container at zoom 0.5 sees 1600x1200 Paper units, larger than
    // the 960x720 board -> center snaps to the board center.
    expect(clampPaperCenterToWorkspace({ x: 0, y: 0 }, 0.5, { width: 800, height: 600 })).toEqual(PAPER_ART_CENTER)
    // Zoomed in: 800x600 at zoom 4 sees 200x150, so the center can roam but
    // is clamped to [100, 860] x [75, 645].
    expect(clampPaperCenterToWorkspace({ x: 0, y: 0 }, 4, { width: 800, height: 600 })).toEqual({ x: 100, y: 75 })
    expect(clampPaperCenterToWorkspace({ x: 5000, y: 5000 }, 4, { width: 800, height: 600 })).toEqual({
      x: 860,
      y: 645,
    })
    // Non-finite viewport fails closed to the workspace center.
    expect(
      clampPaperCenterToWorkspace({ x: 100, y: 100 }, 1, { width: Number.NaN, height: 600 }),
    ).toEqual(PAPER_ART_CENTER)
  })

  it('records the stage/workspace sizes behind the default surface', () => {
    expect(BITMAP_STAGE_SIZE).toEqual({ width: 480, height: 360 })
    expect(DEFAULT_EDIT_SURFACE).toEqual({ width: 2400, height: 1800 })
  })
})

describe('paper-viewport-parity percent mapping', () => {
  it('leaves the Paper percent conversion undecided (explicit unknown)', () => {
    // The current UX percent is Math.round(cssScale * 100); the Paper-side
    // percent (is 0.5 "50%" or "100%"?) is not established, so the module
    // exports an explicit unknown marker instead of a conversion.
    expect(PAPER_ZOOM_PERCENT_MAPPING).toBe('unknown')
    expect(Math.round(1 * 100)).toBe(100)
    expect(Math.round(1.15 * 100)).toBe(115)
  })
})
