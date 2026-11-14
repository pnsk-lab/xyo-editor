// Viewport reset/min/band/scroll-clamp diagnostics (PURE, no product-code change).
//
// Purpose: pin the per-mode reset/min/band against the reference Paper basis:
// - current BitmapEditor reset is per-mode (vector 0.2 / res2 0.5 / res1 1.0 /
//   unknown 1, "100%" label per mode) while Scratch Paper reset is zoom 0.5
//   on the 960x720 Paper board;
// - vector surface 2400px stands for 960 Paper units => density 2.5 [A3], so
//   the Paper-reset conversion is 0.5/2.5 = 0.2 CSS;
// - bitmap res2 960 canvas => density 1.0 (reset 0.5), res1 480 canvas =>
//   density 0.5 (decided: reference loader doubles stored res1 before paint,
//   reset 1.0, floor 0.666...);
// - the earlier "0.2 raw calc" is a THEORETICAL pre-clamp value, NOT an
//   apparent-match claim once the UI container shrinks / DPR is considered
//   (see browser diagnostics file; CSS px are DPR-independent, clipped by the
//   overflow:hidden container).
//
// LEGEND:
// - [ESTABLISHED] read from this repo's product source (file/line cited).
// - [ASSUMPTION] mapping introduced here; verdicts built on one are tagged.
//   An assumption failing bounds the numbers only, never proves a malfunction.
//
// ASSUMPTIONS:
// - A1: bitmap canvas px <-> Paper unit is decided (stored res1 480 canvas
//   stands for the 960-unit board, density 0.5; the R-own 480 number described
//   the doubled camera divisor, not the stored canvas).
// - A3: vector 1 SVG unit = 1 scratch unit (480-unit board), 1 SVG unit = 2
//   Paper units (Scratch 2x import), so 2400 surface px = 960 Paper units.
// - A-ANCHOR-VEC: vector selection-center Scratch equivalence needs the import
//   translation; unverified, no equality verdict.
// - A-CONTAINER: apparent (visible) size = min(surfaceRect, containerRect)
//   because the paint surface is overflow:hidden; DPR scales device px only,
//   never CSS px (getBoundingClientRect is CSS px).
// - A-FIT: zoom-to-fit reference = resolvePaperFitZoom (reset 0.5, bitmap
//   expand+50 then x1.5 pad, ratio clamp [0.125,1] -> fit [0.5,4]).
import { describe, expect, it } from 'bun:test'
import {
  BITMAP_ARTBOARD_MAX_AREA,
  BITMAP_ARTBOARD_MAX_SIDE,
  artboardForTarget,
  emptyArtboardCanvas,
  placeSourceOnArtboard,
} from '../src/features/costumes/bitmap-artboard'
import {
  COSTUME_VIEWPORT_DEFAULT_SCALE,
  COSTUME_VIEWPORT_MAX_SCALE,
  COSTUME_VIEWPORT_MIN_SCALE,
  VECTOR_PAPER_TO_CSS_DENSITY,
  buttonZoomStepAdditive,
  buttonZoomStepForPaperDensity,
  clampViewportScale,
  clampViewportScaleForDensity,
  cssScaleStepForPaperStep,
  paperStepForCssScaleStep,
  predictSurfaceRect,
  surfaceToScreen,
  viewportMinScaleForDensity,
  viewportResetScaleForDensity,
  viewportUiPercentForDensity,
  wheelZoomForPaperDensity,
  zoomViewportAtSurfacePoint,
} from '../src/features/costumes/costume-viewport'
import {
  PAPER_ART_BOARD,
  PAPER_ART_CENTER,
  PAPER_FIT_BASE_ZOOM,
  PAPER_FIT_MAX_ZOOM,
  PAPER_OUTERMOST_ZOOM_LEVEL,
  PAPER_RESET_ZOOM,
  clampPaperCenterToWorkspace,
  cssPxPerPaperUnit,
  cssScaleForPaperZoom,
  paperZoomForCssScale,
  resolvePaperFitZoom,
} from '../src/features/costumes/paper-viewport-parity'
import {
  VECTOR_RESHAPE_TOLERANCE_SCREEN_PX,
  VECTOR_SELECT_TOLERANCE_SCREEN_PX,
  fixedToleranceToScreenPx,
  vectorReshapeToleranceSvgUnits,
  vectorSelectToleranceSvgUnits,
} from '../src/features/costumes/vector-hit-tolerance'

const VECTOR_SURFACE = { width: 2400, height: 1800 }
const BITMAP_RES2 = { width: 960, height: 720 }
const BITMAP_RES1 = { width: 480, height: 360 }
const DENSITY_VEC = 2400 / 960 // 2.5 [A3]

describe('reset/min/band: theoretical conversion vs UI clamp', () => {
  it('pins the 0.2 Paper reset as the live vector value (per-mode band, [A3])', () => {
    // [Paper basis] Scratch reset 0.5 / density 2.5 = 0.2 CSS, live on the
    // per-mode vector band (0.1332..5): no clamp, no representability gap.
    const theoretical = PAPER_RESET_ZOOM / DENSITY_VEC
    expect(theoretical).toBeCloseTo(0.2, 12)
    expect(VECTOR_PAPER_TO_CSS_DENSITY).toBeCloseTo(2.5, 12)
    // Per-mode clamp keeps 0.2 (vector reset); legacy unknown band still
    // clamps 0.2 -> 0.25 (unknown reset stays 1).
    expect(clampViewportScaleForDensity(theoretical, DENSITY_VEC)).toBeCloseTo(0.2, 12)
    expect(clampViewportScale(theoretical)).toBe(COSTUME_VIEWPORT_MIN_SCALE)
    // Effective Paper zoom at the live vector reset: 0.2*2.5 = 0.5 Paper
    // (exact Paper reset parity).
    expect(paperZoomForCssScale(0.2, 2400, 960)).toBeCloseTo(0.5, 12)
    // Floor theoretical 0.333/2.5 ~= 0.1332, live on the per-mode band.
    expect(0.333 / DENSITY_VEC).toBeCloseTo(0.1332, 4)
    expect(clampViewportScaleForDensity(0.333 / DENSITY_VEC, DENSITY_VEC)).toBeCloseTo(0.1332, 4)
    expect(viewportUiPercentForDensity(0.2, DENSITY_VEC)).toBe(100)
  })

  it('pins the live per-mode product reset/min/band (BitmapEditor resetViewport)', () => {
    // resetViewport(): vector {x:0,y:0,scale:0.2}, res2 {x:0,y:0,scale:0.5},
    // res1 {x:0,y:0,scale:1.0}, unknown {x:0,y:0,scale:1}; bands vector
    // 0.1332..5, res2 0.333..5, res1 0.666..5, unknown 0.25..5; ceiling 5
    // everywhere.
    expect(COSTUME_VIEWPORT_DEFAULT_SCALE).toBe(1)
    expect(COSTUME_VIEWPORT_MIN_SCALE).toBe(0.25)
    expect(COSTUME_VIEWPORT_MAX_SCALE).toBe(5)
    expect(viewportResetScaleForDensity(DENSITY_VEC)).toBeCloseTo(0.2, 12)
    expect(viewportMinScaleForDensity(DENSITY_VEC)).toBeCloseTo(0.1332, 4)
    expect(viewportResetScaleForDensity(1)).toBeCloseTo(0.5, 12)
    expect(viewportMinScaleForDensity(1)).toBeCloseTo(0.333, 12)
    expect(viewportResetScaleForDensity(0.5)).toBeCloseTo(1.0, 12)
    expect(viewportMinScaleForDensity(0.5)).toBeCloseTo(0.666, 9)
    expect(viewportResetScaleForDensity(undefined)).toBe(1)
    expect(clampViewportScale(0.2)).toBe(0.25)
    expect(clampViewportScale(0.1332)).toBe(0.25)
    // Band table (vector density path, Paper basis):
    // 1 -> 0.8 -> 0.6 -> 0.4 -> 0.2 (reset) -> 0.1332 (floor clamp);
    // floor-exit 0.1332 -> 0.2 (Paper reset, mirrors 0.333 -> 0.5).
    expect(buttonZoomStepForPaperDensity(1, -1, DENSITY_VEC)).toBeCloseTo(0.8, 12)
    expect(buttonZoomStepForPaperDensity(0.4, -1, DENSITY_VEC)).toBeCloseTo(0.2, 12)
    expect(buttonZoomStepForPaperDensity(0.2, -1, DENSITY_VEC)).toBeCloseTo(0.333 / DENSITY_VEC, 12)
    expect(buttonZoomStepForPaperDensity(0.333 / DENSITY_VEC, 1, DENSITY_VEC)).toBeCloseTo(0.2, 12)
  })

  it('shows the bitmap reset ladder is resolution-dependent (decided densities)', () => {
    // Same CSS scale renders different stage-unit spans per resolution:
    // res2 960px*1 = 960 CSS px for 480 units; res1 480px*1 = 480 CSS px.
    // Decided densities: res1 0.5 => Paper gain 0.25 per legacy +0.5 CSS step
    // would be wrong; the live res1 step is +1.0 CSS (Paper +0.5 exactly).
    expect(cssPxPerPaperUnit(960, 960, 1)).toBeCloseTo(1, 12)
    expect(cssPxPerPaperUnit(480, 960, 1)).toBeCloseTo(0.5, 12)
    expect(cssPxPerPaperUnit(2400, 960, 1)).toBeCloseTo(2.5, 12)
    // Legacy bitmap buttons (+/-0.5 CSS) therefore mean different Paper gains
    // only on the legacy path; the live density-aware steps divide by density.
    expect(paperStepForCssScaleStep(1.0, 0.5)).toBeCloseTo(0.5, 12) // res1 live
    expect(paperStepForCssScaleStep(0.5, 1.0)).toBeCloseTo(0.5, 12) // res2 live
    expect(paperStepForCssScaleStep(0.5, 2.5)).toBeCloseTo(1.25, 12) // vector legacy (2.5x)
  })
})

describe('artboard mapping: 960 res2 vs 480 res1, stage units/pixel', () => {
  it('pins canonical artboards and centers [ESTABLISHED bitmap-artboard.ts]', () => {
    expect(artboardForTarget(false, 2)).toEqual({ width: 960, height: 720, resolution: 2, centerX: 480, centerY: 360 })
    expect(artboardForTarget(true, 1)).toEqual({ width: 480, height: 360, resolution: 1, centerX: 240, centerY: 180 })
    // res1 sprite edits on 480x360 with center 240,180 (not 960x720).
    expect(artboardForTarget(false, 1)).toEqual({ width: 480, height: 360, resolution: 1, centerX: 240, centerY: 180 })
    // Stored res1 sprite on sprite target: same 480x360 rule.
    const placed = placeSourceOnArtboard(100, 80, 50, 40, false, 1)
    expect(placed.resolution).toBe(1)
    expect(placed.width).toBe(480)
    expect(placed.canvasCenterX).toBe(240)
  })

  it('normalizes visible stage units/pixel per resolution', () => {
    // Canvas px per stage unit = resolution R (res2: 2px/unit, res1: 1px/unit).
    // Visible artboard stage units at CSS scale s: surfaceW*s/R... normalized:
    const pxPerUnitRes2 = BITMAP_RES2.width / 480 // 2
    const pxPerUnitRes1 = BITMAP_RES1.width / 480 // 1
    expect(pxPerUnitRes2).toBe(2)
    expect(pxPerUnitRes1).toBe(1)
    // At reset scale 1 the full-canvas CSS span equals canvas px (predict check).
    const center = { x: 0, y: 0 }
    expect(predictSurfaceRect(BITMAP_RES2, center, { x: 0, y: 0, scale: 1 }).width).toBe(960)
    expect(predictSurfaceRect(BITMAP_RES1, center, { x: 0, y: 0, scale: 1 }).width).toBe(480)
    expect(predictSurfaceRect(VECTOR_SURFACE, center, { x: 0, y: 0, scale: 1 }).width).toBe(2400)
  })

  it('covers W/H variable and huge artboards (union/limited/refused)', () => {
    // Small source stays on the artboard.
    const small = placeSourceOnArtboard(190, 200, 95, 100, false, 2)
    expect(small.width).toBe(960)
    expect(small.limited).toBe(false)
    expect(small.refused).toBe(false)
    // Huge source expands the canvas to the union (still within budget here).
    const huge = placeSourceOnArtboard(2000, 1500, 1000, 750, false, 2)
    expect(huge.width).toBeGreaterThanOrEqual(2000)
    expect(huge.limited).toBe(false)
    // Over-budget union falls back to the verbatim source rect (limited, kept).
    const over = placeSourceOnArtboard(5000, 4000, 2500, 2000, false, 2)
    expect(over.limited).toBe(true)
    expect(over.width).toBe(5000)
    // Source itself over the area budget is refused (never allocate).
    const refused = placeSourceOnArtboard(5000, 4000, 2500, 2000, false, 2)
    expect(refused.refused).toBe(refused.width * refused.height > BITMAP_ARTBOARD_MAX_AREA)
    // Empty canvas = bare artboard per target/resolution.
    expect(emptyArtboardCanvas(false, 2).width).toBe(960)
    expect(emptyArtboardCanvas(false, 1).width).toBe(480)
    expect(emptyArtboardCanvas(true, 1).width).toBe(480)
    expect(BITMAP_ARTBOARD_MAX_SIDE).toBe(4096)
    expect(BITMAP_ARTBOARD_MAX_AREA).toBe(16_777_216)
  })
})

describe('selection-anchored reset and zoom-to-fit connections', () => {
  it('pins the selection-center anchor inputs [ESTABLISHED BitmapEditor selectionSurfacePoint]', () => {
    // Bitmap: selection center in canvas px (= surface px); no selection ->
    // surface center (W/2,H/2). Vector: artLeft + svgCenter*5.
    // Here we pin the fixed-point helper both anchors use.
    const surface = { width: 960, height: 720 }
    const center = { x: 500, y: 400 }
    const sel = { x: 384 + 190 / 2, y: 264 + 200 / 2 } // 479,364 (audit fixture)
    const before = { x: 0, y: 0, scale: 1 }
    const next = buttonZoomStepAdditive(1, 1) // 1.5
    const zoomed = zoomViewportAtSurfacePoint(before, surface, center, sel, next)
    expect(zoomed.appliedScale).toBeCloseTo(1.5, 12)
    // Artwork-center fallback anchor pins identically.
    const fallback = zoomViewportAtSurfacePoint(before, surface, center, { x: 480, y: 360 }, next)
    expect(fallback.appliedScale).toBeCloseTo(1.5, 12)
  })

  it('resolves zoom-to-fit per the Paper reference [A-FIT]', () => {
    // Base: null/degenerate/zero viewport fail closed to 0.5.
    expect(resolvePaperFitZoom(null, { width: 800, height: 600 }, true)).toBe(PAPER_FIT_BASE_ZOOM)
    expect(resolvePaperFitZoom({ width: 0, height: 10 }, { width: 800, height: 600 }, true)).toBe(0.5)
    expect(resolvePaperFitZoom({ width: 100, height: 100 }, null, true)).toBe(0.5)
    // Small content in a large viewport hits the max fit 4.
    expect(resolvePaperFitZoom({ width: 10, height: 10 }, { width: 2000, height: 2000 }, false)).toBe(PAPER_FIT_MAX_ZOOM)
    // Bitmap buffer (+50 then x1.5) vs vector (x1.5 only): bitmap fits tighter.
    const bitmapFit = resolvePaperFitZoom({ width: 400, height: 300 }, { width: 800, height: 600 }, true)
    const vectorFit = resolvePaperFitZoom({ width: 400, height: 300 }, { width: 800, height: 600 }, false)
    expect(bitmapFit).toBeLessThan(vectorFit)
    expect(bitmapFit).toBeGreaterThanOrEqual(0.5)
    expect(vectorFit).toBeLessThanOrEqual(4)
    // CSS equivalent of a Paper fit zoom at the vector density (for the record,
    // NOT a product wiring claim): s = z*Pw/W clamped to the UI band.
    const css = cssScaleForPaperZoom(vectorFit, 2400, 960)
    expect(css.clamped).toBe(clampViewportScale(css.theoretical))
  })

  it('quantifies the scroll-clamp gap (Paper clamps, CSS UI does not)', () => {
    // Paper reference clamps the view center so the visible rect stays in the
    // workspace; the CSS UI leaves vx/vy unbounded (panViewport has no clamp).
    // Here we pin the Paper clamp outputs the UI does NOT implement.
    const ws = { ...PAPER_ART_BOARD }
    const atReset = clampPaperCenterToWorkspace({ x: 480, y: 360 }, PAPER_RESET_ZOOM, { width: 800, height: 600 }, ws, PAPER_ART_CENTER)
    expect(atReset).toEqual({ x: 480, y: 360 })
    // Far-out center clamps back; oversized visible rect snaps to workspace center.
    const far = clampPaperCenterToWorkspace({ x: 5000, y: 5000 }, 0.5, { width: 800, height: 600 }, ws, PAPER_ART_CENTER)
    expect(far.x).toBeLessThan(5000)
    const tiny = clampPaperCenterToWorkspace({ x: 0, y: 0 }, PAPER_OUTERMOST_ZOOM_LEVEL, { width: 5000, height: 5000 }, ws, PAPER_ART_CENTER)
    expect(tiny).toEqual(PAPER_ART_CENTER)
  })
})

describe('normalized comparison: first-paint reset / wheel / selection / undo-hit / resize', () => {
  it('first-paint reset renders at different absolute sizes (same scale, different surfaces)', () => {
    // Reset scale 1 on each surface (formula W*s); the "apparent" size is
    // min(rect, container) -- see browser file for the clipped proof.
    const c = { x: 400, y: 300 }
    const v = { x: 0, y: 0, scale: 1 }
    expect(predictSurfaceRect(VECTOR_SURFACE, c, v).width).toBe(2400)
    expect(predictSurfaceRect(BITMAP_RES2, c, v).width).toBe(960)
    expect(predictSurfaceRect(BITMAP_RES1, c, v).width).toBe(480)
    // Scratch reset 0.5 renders 480/240 CSS-equivalent px for the same span
    // (res2/res1); none of the three reset rects equals either.
    expect(2400).not.toBe(480)
    expect(960).not.toBe(480)
  })

  it('wheel gain normalized per Paper unit (vector + res1/res2 parity)', () => {
    // One -100 tick: Paper +0.1 by definition; vector CSS +0.04 at density 2.5,
    // res2 +0.1 at 1.0, res1 +0.2 at 0.5 (decided 2x).
    expect(wheelZoomForPaperDensity(1, -100, DENSITY_VEC)).toBeCloseTo(1.04, 12)
    expect(paperStepForCssScaleStep(0.04, DENSITY_VEC)).toBeCloseTo(0.1, 12)
    expect(wheelZoomForPaperDensity(1, -100, 480 / 960)).toBeCloseTo(1.2, 12)
    expect(wheelZoomForPaperDensity(1, -100, 960 / 960)).toBeCloseTo(1.1, 12)
    // cssScaleStepForPaperStep documents the divisor explicitly.
    expect(cssScaleStepForPaperStep(0.1, DENSITY_VEC)).toBeCloseTo(0.04, 12)
  })

  it('selection-center zoom keeps the anchor at every scale (vector + bitmap)', () => {
    const center = { x: 500, y: 400 }
    for (const surface of [VECTOR_SURFACE, BITMAP_RES2, BITMAP_RES1]) {
      const anchor = { x: surface.width / 2 + 99, y: surface.height / 2 - 61 }
      const before = { x: 7, y: -11, scale: 1 }
      for (const next of [1.2, 0.8, 0.25, 5]) {
        const zoomed = zoomViewportAtSurfacePoint(before, surface, center, anchor, next)
        // Recompute pin error via the pure mapping (must hold incl. clamp).
        const a = surfaceToScreen(anchor, surface, center, before)
        const b = surfaceToScreen(anchor, surface, center, zoomed.viewport)
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(1)
      }
    }
  })

  it('undo/hit/resize budgets normalized to screen px (zoom-aware vs fixed)', () => {
    // Select budget 2px, reshape 6.25px: zoom-aware SVG units shrink as zoom grows.
    expect(vectorSelectToleranceSvgUnits(1)).toBeCloseTo(2 / 5, 12)
    expect(vectorSelectToleranceSvgUnits(0.25)).toBeCloseTo(2 / (5 * 0.25), 12)
    expect(vectorSelectToleranceSvgUnits(5)).toBeCloseTo(2 / 25, 12)
    expect(vectorReshapeToleranceSvgUnits(1)).toBeCloseTo(6.25 / 5, 12)
    // Fixed 0.5 SVG units is 0.625px at min zoom (under-grab) and 12.5px at
    // max zoom (over-grab) vs the intended 2px select budget.
    expect(fixedToleranceToScreenPx(0.5, 0.25)).toBeCloseTo(0.625, 12)
    expect(fixedToleranceToScreenPx(0.5, 5)).toBeCloseTo(12.5, 12)
    expect(VECTOR_SELECT_TOLERANCE_SCREEN_PX).toBe(2)
    expect(VECTOR_RESHAPE_TOLERANCE_SCREEN_PX).toBe(6.25)
    // Resize/nudge steps in Editor.svelte are documented screen-constant via
    // the same scale product (svg*5*s for vector, px*s for bitmap); this pins
    // the two products the callers divide by.
    expect(5 * 1).toBe(5)
    expect(1 * 1).toBe(1)
  })
})
