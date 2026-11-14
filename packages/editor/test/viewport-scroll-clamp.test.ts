// Pure oracle tests for viewport-scroll-clamp (no DOM, no product change).
//
// Pins the reference workspace/clamp/scroll model against the current CSS
// camera in our own words. Reference values are re-typed numbers with survey
// line refs in comments (no third-party source copied). Res1 is decided
// (0.5: stored 480 canvas stands for the 960-unit board; reference loader
// doubles stored res1 before paint). Fit targets are NOT decided
// here (another agent owns fit).
import { describe, expect, it } from 'bun:test'
import {
  SCROLL_ART_BOARD,
  SCROLL_ART_CENTER,
  SCROLL_CSS_MAX,
  SCROLL_CSS_RES1_MIN,
  SCROLL_CSS_RES1_RESET,
  SCROLL_CSS_RES2_MIN,
  SCROLL_CSS_UNKNOWN_MIN,
  SCROLL_CSS_VECTOR_MIN,
  SCROLL_HUGE_PROBE_SURFACE,
  SCROLL_LINE_MULTIPLIER,
  SCROLL_MAX_WORKSPACE,
  SCROLL_OUTERMOST_ZOOM,
  SCROLL_RESET_ZOOM,
  SCROLL_RES1_DENSITY,
  SCROLL_WHEEL_DIVISOR,
  SCROLL_WORKSPACE_BUFFER,
  actionBoundsForMode,
  clampViewToWorkspace,
  cssOutOfRangeAmount,
  cssPanScreenForDelta,
  cssPinAfterClamp,
  cssPxPerPaperUnitForSurface,
  cssSurfaceToScreen,
  expandRectTotal,
  intersectRects,
  normalizeScrollDelta,
  paperPanWorldForDelta,
  paperScrollbarMatrixForDrag,
  paperWheelGain,
  paperZoomThenClamp,
  predictCssSurfaceRect,
  res1DensityReadings,
  uniteRects,
  workspaceBoundsForContent,
} from '../src/features/costumes/viewport-scroll-clamp'

describe('scroll-clamp oracle: workspace constants', () => {
  it('pins art/max/buffer/floor/reset/wheel numbers', () => {
    expect(SCROLL_ART_BOARD).toEqual({ width: 960, height: 720 })
    expect(SCROLL_ART_CENTER).toEqual({ x: 480, y: 360 })
    // MAX = (-240,-180,1440,1080) as rect (right 1200, bottom 900).
    expect(SCROLL_MAX_WORKSPACE).toEqual({ left: -240, top: -180, right: 1200, bottom: 900 })
    expect(SCROLL_WORKSPACE_BUFFER).toBe(50)
    expect(SCROLL_OUTERMOST_ZOOM).toBe(0.333)
    expect(SCROLL_RESET_ZOOM).toBe(0.5)
    expect(SCROLL_WHEEL_DIVISOR).toBe(1000)
    expect(SCROLL_LINE_MULTIPLIER).toBe(15)
    // Expanded MAX (+50 total => 1490x1130 at -265,-205).
    const expanded = expandRectTotal(SCROLL_MAX_WORKSPACE, 50)
    expect(expanded).toEqual({ left: -265, top: -205, right: 1225, bottom: 925 })
    expect(expanded.right - expanded.left).toBe(1490)
    expect(expanded.bottom - expanded.top).toBe(1130)
  })

  it('pins per-mode CSS bands and huge probe surface', () => {
    expect(SCROLL_CSS_VECTOR_MIN).toBeCloseTo(0.333 / 2.5, 12)
    expect(SCROLL_CSS_RES2_MIN).toBeCloseTo(0.333, 12)
    expect(SCROLL_CSS_RES1_MIN).toBeCloseTo(0.666, 9)
    expect(SCROLL_CSS_RES1_RESET).toBeCloseTo(1.0, 12)
    expect(SCROLL_RES1_DENSITY).toBeCloseTo(0.5, 12)
    expect(SCROLL_CSS_UNKNOWN_MIN).toBe(0.25)
    expect(SCROLL_CSS_MAX).toBe(5)
    expect(SCROLL_HUGE_PROBE_SURFACE).toEqual({ width: 6400, height: 4800 })
  })
})

describe('scroll-clamp oracle: setWorkspaceBounds model', () => {
  it('starts from the art board when empty and unclipped', () => {
    // Empty content, no view: art board verbatim (intersected with expanded
    // MAX keeps it: art is inside expanded MAX).
    const ws = workspaceBoundsForContent({ itemBounds: [], clipEmpty: true })
    expect(ws).toEqual({ left: 0, top: 0, right: 960, bottom: 720 })
  })

  it('covers the visible view when not clipping empty space', () => {
    const ws = workspaceBoundsForContent({
      viewBounds: { left: -500, top: -400, right: 1400, bottom: 1100 },
      clipEmpty: false,
    })
    // Unite(art, view) = (-500,-400,1400,1100), intersect expanded MAX
    // (-265,-205,1225,925) => that rect, then the center-in-view rule widens
    // it because the view (1900x1500) is larger than the intersected
    // workspace (1490x1130): grow x by (1900-1490)/2=205, y by 185.
    expect(ws).toEqual({ left: -470, top: -390, right: 1430, bottom: 1110 })
  })

  it('trims empty space when clipping (zoom/reset path)', () => {
    // Small view (inside the art board): clipEmpty drops the view, the
    // center-in-view rule does not trigger (workspace 960x720 >= view).
    const wide = workspaceBoundsForContent({
      viewBounds: { left: 80, top: 60, right: 880, bottom: 660 },
      clipEmpty: true,
    })
    expect(wide).toEqual({ left: 0, top: 0, right: 960, bottom: 720 })
  })

  it('extends to drawn items plus buffer, capped at expanded MAX', () => {
    // Item far right at 1100..1300 Paper units (+25 buffer each side).
    const ws = workspaceBoundsForContent({
      itemBounds: [{ left: 1100, top: 100, right: 1300, bottom: 200 }],
      clipEmpty: true,
    })
    // Unite(art, 1075..1325) = 0..1325 then intersect ..1225.
    expect(ws.right).toBe(1225)
    expect(ws.left).toBe(0)
  })

  it('widens symmetrically when the view is larger than the workspace', () => {
    // Zoomed far out: view 3200 wide vs art 960 -> unite covers the view,
    // intersect cuts to expanded MAX (1490x1130 at -265,-205), then the
    // center-in-view rule grows to the view size: x (3200-1490)/2=855 each
    // side, y (2400-1130)/2=635 each side.
    const ws = workspaceBoundsForContent({
      viewBounds: { left: 480 - 1600, top: 360 - 1200, right: 480 + 1600, bottom: 360 + 1200 },
      clipEmpty: false,
    })
    expect(ws).toEqual({ left: -1120, top: -840, right: 2080, bottom: 1560 })
  })
})

describe('scroll-clamp oracle: clampViewBounds order', () => {
  const ws = { left: 0, top: 0, right: 960, bottom: 720 }

  it('pushes each overflowing edge back inside (left/top/bottom/right order)', () => {
    const r = clampViewToWorkspace({ left: -100, top: -50, right: 700, bottom: 550 }, ws)
    expect(r.clamped).toBe(true)
    expect(r.edges).toEqual(['left', 'top'])
    expect(r.dx).toBe(100)
    expect(r.dy).toBe(50)
    expect(r.viewBounds).toEqual({ left: 0, top: 0, right: 800, bottom: 600 })
  })

  it('handles the oversized-view snap (visible larger than workspace)', () => {
    // View 2000 wide centered at 480 cannot fit 0..960: left<0 pushes +520,
    // then right>960 pushes -1040? Sequential order leaves it pinned to the
    // last edge (right), NOT centered -- the workspace model widens instead
    // (see workspaceBoundsForContent), so a raw oversized clamp is a
    // degenerate input pinned here for the record.
    const r = clampViewToWorkspace({ left: -520, top: -640, right: 1480, bottom: 1360 }, ws)
    expect(r.clamped).toBe(true)
    expect(r.edges).toContain('left')
    expect(r.edges).toContain('right')
  })

  it('is a no-op when already inside', () => {
    const r = clampViewToWorkspace({ left: 80, top: 60, right: 880, bottom: 660 }, ws)
    expect(r.clamped).toBe(false)
    expect(r.dx).toBe(0)
    expect(r.dy).toBe(0)
    expect(r.edges).toEqual([])
  })
})

describe('scroll-clamp oracle: action bounds fork', () => {
  it('keeps bitmap tools on the art board', () => {
    expect(actionBoundsForMode(true, { left: -500, top: -500, right: 2000, bottom: 2000 })).toEqual({
      left: 0,
      top: 0,
      right: 960,
      bottom: 720,
    })
  })

  it('lets vector tools roam to view unite art, capped at raw MAX', () => {
    // View covering the workspace: unite(view, art) then intersect raw MAX
    // gives the full MAX workspace.
    const far = actionBoundsForMode(false, { left: -500, top: -400, right: 1500, bottom: 1100 })
    expect(far).toEqual(SCROLL_MAX_WORKSPACE)
    // Partially overlapping view: unite(art, 1000..2000) = 0..2000 capped to
    // 0..1200 / 0..900 (left/top stay at the board, right/bottom at MAX).
    const clipped = actionBoundsForMode(false, { left: 1000, top: 800, right: 2000, bottom: 1600 })
    expect(clipped).toEqual({ left: 0, top: 0, right: 1200, bottom: 900 })
    const near = actionBoundsForMode(false, { left: 80, top: 60, right: 880, bottom: 660 })
    expect(near).toEqual({ left: 0, top: 0, right: 960, bottom: 720 })
  })
})

describe('scroll-clamp oracle: wheel/pan/scrollbar gains', () => {
  it('pins wheel gain and line-mode expansion', () => {
    expect(normalizeScrollDelta(3, 1)).toBe(45)
    expect(normalizeScrollDelta(3, 0)).toBe(3)
    expect(paperWheelGain(-100)).toBeCloseTo(0.1, 12)
    expect(paperWheelGain(120)).toBeCloseTo(-0.12, 12)
    expect(paperWheelGain(0)).toBe(0)
  })

  it('forks pan gain: Paper divides by zoom, CSS does not', () => {
    // dy=120 CSS px at reset 0.5: Paper scrolls 240 world units.
    expect(paperPanWorldForDelta(120, 0.5)).toBe(240)
    // Same gesture on the CSS camera moves 120 screen px.
    expect(cssPanScreenForDelta(120)).toBe(120)
    // Zoomed in the fork widens: 120px at zoom 2 is 60 world vs 120 screen.
    expect(paperPanWorldForDelta(120, 2)).toBe(60)
    expect(cssPanScreenForDelta(120)).toBe(120)
  })

  it('pins scrollbar matrix gain dx*zoom*2', () => {
    expect(paperScrollbarMatrixForDrag(10, 0.5)).toBe(10)
    expect(paperScrollbarMatrixForDrag(10, 2)).toBe(40)
    expect(paperScrollbarMatrixForDrag(10, 0.333)).toBeCloseTo(6.66, 2)
  })
})

describe('scroll-clamp oracle: camera table and res1 fork', () => {
  it('maps 480 stage-units to screen via the explicit assumption', () => {
    // Bitmap reading: 480 canvas px stand for 480 Paper units => 240 CSS px
    // at reset through a 480-wide surface.
    expect(cssPxPerPaperUnitForSurface(480, 480, 0.5)).toBeCloseTo(0.5, 12)
    expect(480 * 0.5).toBe(240)
    // Vector reading [仮定A3]: 2400 surface for 960 Paper => 480 CSS px.
    expect(cssPxPerPaperUnitForSurface(2400, 960, 0.2)).toBeCloseTo(0.5, 12)
    expect(960 * 0.5).toBe(480)
    // res2: 960/960=1 density => 480 CSS px at reset.
    expect(cssPxPerPaperUnitForSurface(960, 960, 0.5)).toBeCloseTo(0.5, 12)
  })

  it('decides the res1 density (0.5 board basis)', () => {
    const r = res1DensityReadings(480)
    expect(r.board).toBeCloseTo(0.5, 12)
    expect(r.own).toBeCloseTo(1.0, 12)
    expect(r.decided).toBeCloseTo(0.5, 12)
    // Wheel +0.1 Paper means +0.2 CSS on the decided board (reference 2x).
    expect(0.1 / r.decided).toBeCloseTo(0.2, 12)
    expect(0.1 / r.board).toBeCloseTo(0.2, 12)
  })

  it('predicts the CSS rect and round-trips surface<->screen', () => {
    const center = { x: 500, y: 400 }
    const rect = predictCssSurfaceRect({ width: 2400, height: 1800 }, center, { x: 0, y: 0, scale: 1 })
    expect(rect).toEqual({ left: -700, top: -500, width: 2400, height: 1800 })
    const p = cssSurfaceToScreen({ x: 1200, y: 900 }, { width: 2400, height: 1800 }, center, { x: 30, y: -20, scale: 2 })
    expect(p).toEqual({ x: 530, y: 380 })
  })
})

describe('scroll-clamp oracle: out-of-range and clip record', () => {
  it('measures zero overhang at reset and unbounded growth when panned out', () => {
    const container = { left: 0, top: 0, width: 800, height: 600 }
    const centered = predictCssSurfaceRect({ width: 960, height: 720 }, { x: 400, y: 300 }, { x: 0, y: 0, scale: 0.5 })
    const atReset = cssOutOfRangeAmount(centered, container)
    // 480x360 surface rect centered in 800x600: fully inside => all overhangs negative.
    expect(atReset.max).toBeLessThanOrEqual(0)
    expect(atReset.fullyOutside).toBe(false)
    expect(atReset.visibleRatio).toBeCloseTo(1, 12)
    // Pan 5000px: surface fully leaves the container (unbounded CSS).
    const far = predictCssSurfaceRect({ width: 960, height: 720 }, { x: 400, y: 300 }, { x: 5000, y: 0, scale: 0.5 })
    const out = cssOutOfRangeAmount(far, container)
    expect(out.fullyOutside).toBe(true)
    expect(out.visibleRatio).toBe(0)
    expect(out.max).toBeGreaterThan(4000)
  })

  it('clips the 6400 huge surface to the container (overflow:hidden record)', () => {
    const container = { left: 0, top: 0, width: 800, height: 600 }
    const huge = predictCssSurfaceRect(SCROLL_HUGE_PROBE_SURFACE, { x: 400, y: 300 }, { x: 0, y: 0, scale: 1 })
    expect(huge.width).toBe(6400)
    const clipped = cssOutOfRangeAmount(huge, container)
    expect(clipped.visibleWidth).toBe(800)
    expect(clipped.visibleHeight).toBe(600)
    expect(clipped.visibleRatio).toBeCloseTo((800 * 600) / (6400 * 4800), 12)
    expect(uniteRects({ left: 0, top: 0, right: 960, bottom: 720 }, SCROLL_MAX_WORKSPACE)).toEqual(SCROLL_MAX_WORKSPACE)
    expect(intersectRects({ left: -1000, top: -1000, right: 5000, bottom: 5000 }, SCROLL_MAX_WORKSPACE)).toEqual(
      SCROLL_MAX_WORKSPACE,
    )
  })
})

describe('scroll-clamp oracle: fixed-point vs clamp priority', () => {
  it('Paper: clamp wins -- edge zoom slips the fixed point', () => {
    // Zoom +0.5 about a point near the right workspace edge: pre-clamp pin
    // holds, post-clamp view is pushed back inside so the point slips.
    // preOffset = 900-480 = 420, scaling = 0.5, postOffset = 900-210-480 =
    // 210, preClampCenter = 480-210 = 270.
    const ws = { left: 0, top: 0, right: 960, bottom: 720 }
    const r = paperZoomThenClamp(0.5, 0.5, { x: 900, y: 360 }, { x: 480, y: 360 }, { width: 800, height: 600 }, ws)
    expect(r.appliedZoom).toBeCloseTo(1, 12)
    expect(r.preClampCenter.x).toBeCloseTo(270, 9)
    // View 800 wide at center 270 spans -130..670: left underflows 0 by 130
    // so the clamp pushes +130 (left edge first in the survey order).
    expect(r.postClampCenter.x).toBeCloseTo(400, 9)
    expect(r.clampPinErrorCssPx).toBeCloseTo(130, 9)
    expect(r.clamped).toBe(true)
  })

  it('Paper: interior zoom keeps the pin (no clamp, no slip)', () => {
    const ws = { left: -265, top: -205, right: 1225, bottom: 925 }
    const r = paperZoomThenClamp(0.5, 0.5, { x: 580, y: 410 }, { x: 480, y: 360 }, { width: 800, height: 600 }, ws)
    expect(r.clampPinErrorCssPx).toBeCloseTo(0, 9)
    expect(r.postClampCenter).toEqual(r.preClampCenter)
  })

  it('CSS: pin wins -- even the band clamp holds the cursor', () => {
    const center = { x: 500, y: 400 }
    const surface = { width: 2400, height: 1800 }
    const pointer = { x: 620, y: 480 }
    // Interior factor: no clamp, pin holds.
    const mid = cssPinAfterClamp({ x: 12, y: -34, scale: 1 }, surface, center, pointer, 1.1)
    expect(mid.clamped).toBe(false)
    expect(mid.pinErrorCssPx).toBeLessThan(1)
    // Floor clamp: requested 0.3*0.5=0.15 -> 0.25, translation uses the
    // clamped scale so the pin still holds (<1px).
    const low = cssPinAfterClamp({ x: 0, y: 0, scale: 0.3 }, surface, center, pointer, 0.5, SCROLL_CSS_UNKNOWN_MIN)
    expect(low.appliedScale).toBe(SCROLL_CSS_UNKNOWN_MIN)
    expect(low.clamped).toBe(true)
    expect(low.pinErrorCssPx).toBeLessThan(1)
    // Vector floor: 0.14*0.5=0.07 -> 0.1332, same pin contract.
    const vec = cssPinAfterClamp({ x: 0, y: 0, scale: 0.14 }, surface, center, pointer, 0.5, SCROLL_CSS_VECTOR_MIN)
    expect(vec.appliedScale).toBeCloseTo(SCROLL_CSS_VECTOR_MIN, 12)
    expect(vec.pinErrorCssPx).toBeLessThan(1)
  })
})
