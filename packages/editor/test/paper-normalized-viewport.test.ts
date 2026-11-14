// Paper-normalized viewport (PURE, product-code read-only except new helpers).
//
// Re-derives the viewport normalization INDEPENDENTLY from the current
// implementation and pins the reliable vector/res2 conversions:
//
// - Scratch Paper board 960x720 Paper units; vector SVG imports at 2x, so
//   480 SVG units (= 480 stage units) stand for 960 Paper units.
// - Paper camera: screen px per Paper unit = zoom. Reset zoom 0.5, floor
//   (OUTERMOST) 0.333, button +/-0.5, ctrl-wheel -deltaY/1000, no ceiling.
// - Current CSS camera: screen px = surfaceW * scale, surface 2400 (vector
//   480svg*5) or live canvas (res2 960 / res1 480). UI band per mode
//   (vector 0.1332..5, res2 0.333..5, res1 0.666..5, unknown 0.25..5), reset
//   scale = Paper 0.5 / density (Paper basis, "100%" label per mode).
// - Normalized density: CSS scale step = Paper step / density, with
//   vector 2400/960 = 2.5 [A3], bitmap res2 960/960 = 1.0, and bitmap res1
//   480/960 = 0.5 (decided: reference loader doubles stored res1 before
//   paint while this repo keeps stored res1 non-destructively).
//
// LEGEND: [確定] paper-truth diagnostics pins / [仮定] mapping introduced
// here (A3 vector 2x, R-own/R-board bitmap readings). A failing assumption
// only bounds the numbers, never proves a malfunction.
//
// AGPL: no vendor code copied; numbers are re-typed pins, math is clean-room.
import { describe, expect, it } from 'bun:test'
import {
  BITMAP_RES1_PAPER_FLOOR_CSS_EFFECTIVE,
  BITMAP_RES1_PAPER_RESET_CSS_EFFECTIVE,
  BITMAP_RES1_PAPER_TO_CSS_DENSITY,
  BITMAP_RES2_PAPER_RESET_CSS_EFFECTIVE,
  BITMAP_RES2_PAPER_FLOOR_CSS_EFFECTIVE,
  BITMAP_RES2_PAPER_TO_CSS_DENSITY,
  VECTOR_PAPER_RESET_CSS_EFFECTIVE,
  VECTOR_PAPER_FLOOR_CSS_EFFECTIVE,
  VECTOR_PAPER_TO_CSS_DENSITY,
  buttonZoomStepAdditive,
  buttonZoomStepForPaperDensity,
  clampViewportScale,
  clampViewportScaleForDensity,
  cssScaleStepForPaperStep,
  cssScaleToUiPercent,
  viewportUiPercentForDensity,
  densityForBitmapCanvas,
  densityForBitmapStoredResolution,
  classifyBitmapCanvasResolution,
  paperFloorCssEffective,
  paperFloorCssTheoretical,
  paperResetCssEffective,
  paperResetCssTheoretical,
  paperStepForCssScaleStep,
  predictSurfaceRect,
  surfaceToScreen,
  wheelZoomForPaperDensity,
  zoomViewportAtSurfacePoint,
} from '../src/features/costumes/costume-viewport'
import {
  PAPER_ART_BOARD,
  PAPER_FIT_BASE_ZOOM,
  PAPER_OUTERMOST_ZOOM_LEVEL,
  PAPER_RESET_ZOOM,
  PAPER_ZOOM_INCREMENT,
  PAPER_ZOOM_SAFE_MAX,
  clampPaperCenterToWorkspace,
  clampPaperZoom,
  cssPxPerPaperUnit,
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

describe('normalized derivation: board/import/camera (independent re-derivation)', () => {
  it('pins the Paper board/import numbers (re-typed, no vendor copy)', () => {
    // 480 SVG units x2 import = 960 Paper units = ART_BOARD width.
    expect(480 * 2).toBe(960)
    expect(PAPER_ART_BOARD).toEqual({ width: 960, height: 720 })
    expect(PAPER_RESET_ZOOM).toBe(0.5)
    expect(PAPER_OUTERMOST_ZOOM_LEVEL).toBe(0.333)
    expect(PAPER_ZOOM_INCREMENT).toBe(0.5)
  })

  it('re-derives the camera table independently (zoom * paperUnits)', () => {
    // Scratch reset renders 480 stage-units at:
    // - bitmap res2 reading: 960 Paper px * 0.5 = 480 screen px.
    // - vector reading: 960 Paper units * 0.5 = 480 screen px.
    expect(960 * 0.5).toBe(480)
    // Current UI at reset scale 1 renders the same span at:
    // - vector: 2400 surface px * 1 = 2400 (5x the Paper reset).
    // - res2: 960 * 1 = 960 (2x the Paper reset).
    expect(2400 * 1).toBe(2400)
    expect(960 * 1).toBe(960)
    expect(2400 / 480).toBe(5)
    expect(960 / 480).toBe(2)
    // Res1 current artboard is 480 wide: 480*1 = 480 at scale 1, which
    // numerically EQUALS the Paper reset size but must NOT be read as proof
    // of parity (different unit basis: res1 half-board question). Pinned as
    // coincidence, no verdict.
    expect(480 * 1).toBe(480)
  })

  it('derives densities from the actual-size formula (W / Pw)', () => {
    // cssPxPerPaperUnit(W, Pw, 1) = W/Pw IS the density at scale 1.
    expect(cssPxPerPaperUnit(2400, 960, 1)).toBeCloseTo(2.5, 12)
    expect(cssPxPerPaperUnit(960, 960, 1)).toBeCloseTo(1.0, 12)
    expect(VECTOR_PAPER_TO_CSS_DENSITY).toBeCloseTo(2.5, 12)
    expect(BITMAP_RES2_PAPER_TO_CSS_DENSITY).toBeCloseTo(1.0, 12)
    // Res1 decided: 480 canvas stands for the 960-unit board (0.5).
    expect(cssPxPerPaperUnit(480, 960, 1)).toBeCloseTo(0.5, 12)
    expect(BITMAP_RES1_PAPER_TO_CSS_DENSITY).toBeCloseTo(0.5, 12)
  })
})

describe('normalized reset/floor: vector + res2 + res1 (decided)', () => {
  it('derives theoretical reset/floor per density (Paper 0.5 / 0.333)', () => {
    expect(paperResetCssTheoretical(2.5)).toBeCloseTo(0.2, 12)
    expect(paperFloorCssTheoretical(2.5)).toBeCloseTo(0.1332, 4)
    expect(paperResetCssTheoretical(1.0)).toBeCloseTo(0.5, 12)
    expect(paperFloorCssTheoretical(1.0)).toBeCloseTo(0.333, 12)
    // Invalid density fails closed (no silent 1.0 assumption for res1).
    expect(paperResetCssTheoretical(NaN)).toBeUndefined()
    expect(paperResetCssTheoretical(0)).toBeUndefined()
    expect(paperFloorCssTheoretical(-1)).toBeUndefined()
  })

  it('derives effective reset/floor through the per-mode band (Paper basis)', () => {
    // Per-mode band (Paper 0.5 reset / 0.333 floor): vector 0.2 / 0.1332,
    // res2 0.5 / 0.333, res1 1.0 / 0.666.... No representability gap: the
    // band minimum moved per mode so the live reset IS the Paper reset.
    expect(paperResetCssEffective(2.5)).toBeCloseTo(0.2, 12)
    expect(paperFloorCssEffective(2.5)).toBeCloseTo(0.333 / 2.5, 12)
    expect(VECTOR_PAPER_RESET_CSS_EFFECTIVE).toBeCloseTo(0.2, 12)
    expect(VECTOR_PAPER_FLOOR_CSS_EFFECTIVE).toBeCloseTo(0.333 / 2.5, 12)
    // Res2 is exact inside the band.
    expect(paperResetCssEffective(1.0)).toBeCloseTo(0.5, 12)
    expect(paperFloorCssEffective(1.0)).toBeCloseTo(0.333, 12)
    expect(BITMAP_RES2_PAPER_RESET_CSS_EFFECTIVE).toBeCloseTo(0.5, 12)
    expect(BITMAP_RES2_PAPER_FLOOR_CSS_EFFECTIVE).toBeCloseTo(0.333, 12)
    // Res1 (decided 0.5) is exact inside its band too.
    expect(paperResetCssEffective(0.5)).toBeCloseTo(1.0, 12)
    expect(paperFloorCssEffective(0.5)).toBeCloseTo(0.666, 9)
    expect(BITMAP_RES1_PAPER_RESET_CSS_EFFECTIVE).toBeCloseTo(1.0, 12)
    expect(BITMAP_RES1_PAPER_FLOOR_CSS_EFFECTIVE).toBeCloseTo(0.666, 9)
  })

  it('keeps the expansion ceiling at 5 (Paper unbounded above, 明記)', () => {
    expect(clampViewportScale(99)).toBe(5)
    expect(clampViewportScale(0.2)).toBe(0.25) // legacy unknown band keeps 0.25
    expect(clampViewportScaleForDensity(0.2, 2.5)).toBeCloseTo(0.2, 12) // vector band keeps the Paper reset
    expect(clampViewportScaleForDensity(0.2, 1)).toBeCloseTo(0.333, 12) // res2 floor clamps 0.2 up
    // Paper side itself has no ceiling, only the overflow guard.
    expect(clampPaperZoom(1e9)).toBe(PAPER_ZOOM_SAFE_MAX)
    expect(PAPER_ZOOM_SAFE_MAX).toBe(1_000_000)
  })

  it('separates the UI label from the internal scale (reset always 100%)', () => {
    expect(cssScaleToUiPercent(1)).toBe(100) // legacy unknown form
    expect(viewportUiPercentForDensity(0.2, 2.5)).toBe(100) // vector Paper reset
    expect(viewportUiPercentForDensity(0.5, 1)).toBe(100) // res2 Paper reset
    expect(viewportUiPercentForDensity(1.0, 0.5)).toBe(100) // res1 Paper reset
    expect(viewportUiPercentForDensity(1, undefined)).toBe(100) // unknown legacy reset
    expect(viewportUiPercentForDensity(0.4, 2.5)).toBe(200)
    expect(viewportUiPercentForDensity(1.0, 1)).toBe(200)
    expect(viewportUiPercentForDensity(2.0, 0.5)).toBe(200) // res1 one button step up
    // Paper 0.5 zoom has no separate percent mapping (separation, not equality).
    expect(paperZoomForCssScale(1, 2400, 960)).toBeCloseTo(2.5, 12)
  })

  it('classifies bitmap canvases: res2 and res1 decided, unknown fail-closed', () => {
    expect(classifyBitmapCanvasResolution(960)).toBe('res2')
    expect(classifyBitmapCanvasResolution(480)).toBe('res1')
    expect(densityForBitmapCanvas(960)).toBeCloseTo(1.0, 12)
    expect(densityForBitmapCanvas(480)).toBeCloseTo(0.5, 12)
    expect(densityForBitmapCanvas(0)).toBeUndefined()
    expect(densityForBitmapCanvas(960, 2)).toBeCloseTo(1.0, 12)
    expect(densityForBitmapCanvas(480, 1)).toBeCloseTo(0.5, 12)
    expect(densityForBitmapCanvas(960, 1)).toBeCloseTo(0.5, 12) // stored wins over width
  })
})

describe('normalized button/wheel/anchor: vector + res2 + res1 parity', () => {
  it('button: +0.5 Paper gain is exact through all densities', () => {
    // Vector: +0.5 Paper / 2.5 = +0.2 CSS; Paper gain of the CSS step = 0.5.
    expect(buttonZoomStepForPaperDensity(1, 1, 2.5)).toBeCloseTo(1.2, 12)
    expect(paperStepForCssScaleStep(0.2, 2.5)).toBeCloseTo(0.5, 12)
    expect(cssScaleStepForPaperStep(0.5, 2.5)).toBeCloseTo(0.2, 12)
    // Res2: +0.5 Paper / 1.0 = +0.5 CSS, identical to the legacy copy.
    expect(buttonZoomStepForPaperDensity(1, 1, 1.0)).toBeCloseTo(buttonZoomStepAdditive(1, 1), 12)
    expect(buttonZoomStepForPaperDensity(1, -1, 1.0)).toBeCloseTo(buttonZoomStepAdditive(1, -1), 12)
    expect(paperStepForCssScaleStep(0.5, 1.0)).toBeCloseTo(0.5, 12)
    // Res1 (decided 0.5): +0.5 Paper / 0.5 = +1.0 CSS (from reset 1.0 to 2.0).
    expect(buttonZoomStepForPaperDensity(1, 1, 0.5)).toBeCloseTo(2.0, 12)
    expect(paperStepForCssScaleStep(1.0, 0.5)).toBeCloseTo(0.5, 12)
    // Invalid density fails closed to the clamped current scale.
    expect(buttonZoomStepForPaperDensity(1, 1, NaN)).toBe(1)
  })

  it('wheel: -100 tick gain is exact through all densities', () => {
    // Scratch: +0.1 Paper. Vector: +0.04 CSS; res2: +0.1 CSS (= legacy);
    // res1: +0.2 CSS.
    expect(wheelZoomForPaperDensity(1, -100, 2.5)).toBeCloseTo(1.04, 12)
    expect(wheelZoomForPaperDensity(1, -100, 1.0)).toBeCloseTo(1.1, 12)
    expect(wheelZoomForPaperDensity(1, -100, 0.5)).toBeCloseTo(1.2, 12)
    expect(paperStepForCssScaleStep(0.04, 2.5)).toBeCloseTo(0.1, 12)
    expect(paperStepForCssScaleStep(0.1, 1.0)).toBeCloseTo(0.1, 12)
    expect(paperStepForCssScaleStep(0.2, 0.5)).toBeCloseTo(0.1, 12)
  })

  it('anchor: selection-center fixed point holds <1px incl. clamps (vector + res2)', () => {
    const center = { x: 500, y: 400 }
    for (const [surface, next] of [
      [VECTOR_SURFACE, 1.2],
      [VECTOR_SURFACE, 0.25],
      [BITMAP_RES2, 1.5],
      [BITMAP_RES2, 0.333],
    ] as const) {
      const anchor = { x: surface.width / 2 + 99, y: surface.height / 2 - 61 }
      const before = { x: 7, y: -11, scale: 1 }
      const zoomed = zoomViewportAtSurfacePoint(before, surface, center, anchor, next)
      const a = surfaceToScreen(anchor, surface, center, before)
      const b = surfaceToScreen(anchor, surface, center, zoomed.viewport)
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(1)
    }
  })
})

describe('normalized comparison: SVG artboard 480units -> 480 CSS px at same container', () => {
  it('vector artbox, res2 and res1 canvases all normalize to 480 CSS px at Paper reset', () => {
    // Same surface-container math (W*s): vector 2400 * 0.2 (Paper reset) =
    // 480; res2 960 * 0.5 = 480; res1 480 * 1.0 = 480. All effective resets
    // are live values on the per-mode band (no gap), so the helpers agree.
    expect(2400 * 0.2).toBeCloseTo(480, 9)
    expect(960 * 0.5).toBeCloseTo(480, 9)
    expect(480 * 1.0).toBeCloseTo(480, 9)
    expect(predictSurfaceRect(BITMAP_RES2, { x: 0, y: 0 }, { x: 0, y: 0, scale: 0.5 }).width).toBeCloseTo(480, 9)
    expect(predictSurfaceRect(VECTOR_SURFACE, { x: 0, y: 0 }, { x: 0, y: 0, scale: 0.2 }).width).toBeCloseTo(480, 9)
    expect(predictSurfaceRect(BITMAP_RES1, { x: 0, y: 0 }, { x: 0, y: 0, scale: 1.0 }).width).toBeCloseTo(480, 9)
    // Vector artbox fills the surface: 480 SVG units * 5 = 2400 surface px,
    // so the art span at Paper reset is also 480 CSS px (same container).
    expect(480 * 5 * 0.2).toBe(480)
    expect(960 * 0.5).toBe(480)
    // Live per-mode resets (Paper basis): vector 0.2 -> 480, res2 0.5 -> 480,
    // res1 1.0 -> 480 (decided 0.5 density).
    expect(predictSurfaceRect(VECTOR_SURFACE, { x: 0, y: 0 }, { x: 0, y: 0, scale: VECTOR_PAPER_RESET_CSS_EFFECTIVE }).width).toBeCloseTo(480, 9)
    expect(predictSurfaceRect(BITMAP_RES2, { x: 0, y: 0 }, { x: 0, y: 0, scale: BITMAP_RES2_PAPER_RESET_CSS_EFFECTIVE }).width).toBeCloseTo(480, 9)
    expect(predictSurfaceRect(BITMAP_RES1, { x: 0, y: 0 }, { x: 0, y: 0, scale: BITMAP_RES1_PAPER_RESET_CSS_EFFECTIVE }).width).toBeCloseTo(480, 9)
    // Old scale-1 widths pinned as the pre-normalization gap (5x / 2x / 1x).
    expect(predictSurfaceRect(VECTOR_SURFACE, { x: 0, y: 0 }, { x: 0, y: 0, scale: 1 }).width).toBe(2400)
    expect(predictSurfaceRect(BITMAP_RES2, { x: 0, y: 0 }, { x: 0, y: 0, scale: 1 }).width).toBe(960)
  })

  it('normalized screen-shift equivalence (CSS pan vs Paper scrollBy/zoom)', () => {
    // CSS pan is screen px; Paper pan is world/dx/zoom. Normalized: a 120px
    // screen pan at Paper reset 0.5 equals 240 world units (120/0.5).
    expect(120 / 0.5).toBe(240)
  })
})

describe('normalized budgets: mask/hit tolerance/nudge/brush/selection/text/floating', () => {
  it('zoom-aware tolerances stay screen-constant (vs fixed 0.5 over/under-grab)', () => {
    expect(vectorSelectToleranceSvgUnits(1)).toBeCloseTo(2 / 5, 12)
    expect(vectorSelectToleranceSvgUnits(0.25)).toBeCloseTo(2 / (5 * 0.25), 12)
    expect(vectorReshapeToleranceSvgUnits(1)).toBeCloseTo(6.25 / 5, 12)
    expect(fixedToleranceToScreenPx(0.5, 0.25)).toBeCloseTo(0.625, 12)
    expect(fixedToleranceToScreenPx(0.5, 5)).toBeCloseTo(12.5, 12)
    expect(VECTOR_SELECT_TOLERANCE_SCREEN_PX).toBe(2)
    expect(VECTOR_RESHAPE_TOLERANCE_SCREEN_PX).toBe(6.25)
    // Nudge/brush/selection products callers divide by (documented):
    expect(5 * 1).toBe(5) // vector svg*5*s
    expect(1 * 1).toBe(1) // bitmap px*s
  })
})

describe('INCOMPLETE (no definitive evidence: unchanged, marked)', () => {
  it('INCOMPLETE-fit: first-fit zoom-to-fit stays untouched (base 0.5, max 4)', () => {
    // Initial shouldZoomToFit behavior has async/sandbox evidence gaps; the
    // pure formula is pinned but NOT wired as a first-paint change here.
    expect(resolvePaperFitZoom(null, { width: 800, height: 600 }, true)).toBe(PAPER_FIT_BASE_ZOOM)
    expect(resolvePaperFitZoom({ width: 10, height: 10 }, { width: 2000, height: 2000 }, false)).toBe(4)
  })

  it('DECIDED-res1: res1 density is 0.5 (reference 2x basis, stored kept)', () => {
    expect(densityForBitmapCanvas(480)).toBeCloseTo(0.5, 12)
    expect(densityForBitmapStoredResolution(undefined)).toBeUndefined()
    expect(densityForBitmapStoredResolution(1)).toBeCloseTo(0.5, 12)
    expect(densityForBitmapStoredResolution(2)).toBeCloseTo(1.0, 12)
    // Stored res1 480 canvas stands for the 960-unit Paper board (1 canvas px
    // = 2 Paper units); the R-own 480 number described the doubled camera
    // divisor, not the stored canvas, and is kept only as a camera pin below.
    expect(cssPxPerPaperUnit(480, 960, 1)).toBeCloseTo(0.5, 12)
  })

  it('INCOMPLETE-pan-cap: CSS pan stays unclamped (Paper clamps, UI does not)', () => {
    // Paper reference clamps into the workspace; the CSS UI leaves vx/vy
    // unbounded. Quantified but NOT changed here for lack of a definitive
    // UX mandate (oversized-visible-rect snap would alter current panning).
    const tiny = clampPaperCenterToWorkspace({ x: 0, y: 0 }, 0.333, { width: 5000, height: 5000 })
    expect(tiny).toEqual({ x: 480, y: 360 })
  })
})
