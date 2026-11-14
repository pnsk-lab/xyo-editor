import { describe, expect, it } from 'bun:test'
import {
  BITMAP_RES1_PAPER_FLOOR_CSS_EFFECTIVE,
  BITMAP_RES1_PAPER_RESET_CSS_EFFECTIVE,
  BITMAP_RES1_PAPER_TO_CSS_DENSITY,
  buildCostumeViewportKey,
  buildLegacySlotViewportKey,
  COSTUME_VIEWPORT_BUTTON_STEP,
  COSTUME_VIEWPORT_DEFAULT_SURFACE,
  COSTUME_VIEWPORT_GLOBAL_MIN_SCALE,
  COSTUME_VIEWPORT_LEGACY_PROJECT_SEGMENT,
  COSTUME_VIEWPORT_MAX_SCALE,
  COSTUME_VIEWPORT_MIN_SCALE,
  COSTUME_VIEWPORT_MIN_STEP_TARGET,
  COSTUME_VIEWPORT_SLOT_ASSET_SEGMENT,
  COSTUME_VIEWPORT_VECTOR_MIN_SCALE,
  COSTUME_VIEWPORT_VECTOR_RESET_SCALE,
  COSTUME_VIEWPORT_BITMAP_RES1_MIN_SCALE,
  COSTUME_VIEWPORT_BITMAP_RES1_RESET_SCALE,
  COSTUME_VIEWPORT_BITMAP_RES2_MIN_SCALE,
  COSTUME_VIEWPORT_BITMAP_RES2_RESET_SCALE,
  COSTUME_VIEWPORT_WHEEL_DIVISOR,
  buttonZoomStepAdditive,
  buttonZoomStepForPaperDensity,
  clampViewportScale,
  clampViewportScaleForDensity,
  cssScaleStepForPaperStep,
  viewportMinScaleForDensity,
  viewportResetScaleForDensity,
  viewportUiPercentForDensity,
  normalizeWheelDelta,
  normalizeWheelDeltas,
  panViewport,
  paperStepForCssScaleStep,
  predictSurfaceRect,
  resolveWheelViewport,
  sanitizePaperToCssDensity,
  screenDeltaToSurfaceDelta,
  screenToleranceToSurfaceUnits,
  screenToSurface,
  surfaceDeltaToScreenDelta,
  surfaceToScreen,
  wheelZoomAdditiveScale,
  wheelZoomFactorForDeltaY,
  wheelZoomForPaperDensity,
  resolveWheelViewportForPaperDensity,
  VECTOR_PAPER_FLOOR_CSS_CLAMPED,
  VECTOR_PAPER_FLOOR_CSS_THEORETICAL,
  VECTOR_PAPER_RESET_CSS_THEORETICAL,
  VECTOR_PAPER_TO_CSS_DENSITY,
  zoomViewportAtAnchorOffset,
  zoomViewportAtScreenPoint,
  zoomViewportAtSurfacePoint,
} from '../src/features/costumes/costume-viewport'

const SURFACE = { width: 2400, height: 1800 }
const CENTER = { x: 500, y: 400 }

function screenError(
  before: { x: number; y: number },
  surface: { width: number; height: number },
  center: { x: number; y: number },
  afterViewport: { x: number; y: number; scale: number },
  fixedSurface: { x: number; y: number },
): number {
  const after = surfaceToScreen(fixedSurface, surface, center, afterViewport)
  return Math.hypot(after.x - before.x, after.y - before.y)
}

describe('costume-viewport clamp', () => {
  it('clamps to the current UI range 0.25..5', () => {
    expect(clampViewportScale(1)).toBe(1)
    expect(clampViewportScale(0.249)).toBe(COSTUME_VIEWPORT_MIN_SCALE)
    expect(clampViewportScale(5.001)).toBe(COSTUME_VIEWPORT_MAX_SCALE)
    expect(clampViewportScale(Number.NaN)).toBe(1)
    expect(clampViewportScale(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('costume-viewport wheel normalization', () => {
  it('expands line deltas x15 and passes pixels through', () => {
    expect(normalizeWheelDelta(3, 1)).toBe(45)
    expect(normalizeWheelDelta(3, 0)).toBe(3)
    expect(normalizeWheelDelta(3, 2)).toBe(3)
    expect(normalizeWheelDelta(Number.NaN, 1)).toBe(0)
    expect(normalizeWheelDeltas({ deltaX: 2, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 30, dy: 45 })
  })

  it('keeps the legacy sign-only factor for audit history', () => {
    expect(wheelZoomFactorForDeltaY(10)).toBe(0.9)
    expect(wheelZoomFactorForDeltaY(-10)).toBe(1.1)
    expect(wheelZoomFactorForDeltaY(0)).toBeUndefined()
  })

  it('steps the live wheel additively by -deltaY/1000', () => {
    expect(COSTUME_VIEWPORT_WHEEL_DIVISOR).toBe(1000)
    // Classic tick: -100 -> +0.1 (coincides with the legacy 1.1x at scale 1).
    expect(wheelZoomAdditiveScale(1, -100)).toBeCloseTo(1.1, 12)
    // Magnitude matters now: +50 -> -0.05, not the legacy 0.9x.
    expect(wheelZoomAdditiveScale(1, 50)).toBeCloseTo(0.95, 12)
    // Small trackpad delta gives a small step.
    expect(wheelZoomAdditiveScale(1, -10)).toBeCloseTo(1.01, 12)
    // Line-mode input arrives already expanded x15 by the caller.
    expect(wheelZoomAdditiveScale(1, 30)).toBeCloseTo(0.97, 12)
    // Floor/ceiling hold; zero/non-finite is a no-op.
    expect(wheelZoomAdditiveScale(0.3, 1000)).toBe(COSTUME_VIEWPORT_MIN_SCALE)
    expect(wheelZoomAdditiveScale(4.9, -1000)).toBe(COSTUME_VIEWPORT_MAX_SCALE)
    expect(wheelZoomAdditiveScale(1, 0)).toBe(1)
    expect(wheelZoomAdditiveScale(1, Number.NaN)).toBe(1)
  })
})

describe('costume-viewport additive button steps', () => {
  it('adds +/-0.5 with the minimum-to-0.5 special step', () => {
    expect(COSTUME_VIEWPORT_BUTTON_STEP).toBe(0.5)
    expect(COSTUME_VIEWPORT_MIN_STEP_TARGET).toBe(0.5)
    expect(buttonZoomStepAdditive(1, 1)).toBeCloseTo(1.5, 12)
    expect(buttonZoomStepAdditive(1, -1)).toBeCloseTo(0.5, 12)
    expect(buttonZoomStepAdditive(1.5, -1)).toBeCloseTo(1.0, 12)
    // From the minimum the zoom-in lands on 0.5, not 0.75.
    expect(buttonZoomStepAdditive(0.25, 1)).toBeCloseTo(0.5, 12)
    expect(buttonZoomStepAdditive(0.25, -1)).toBe(COSTUME_VIEWPORT_MIN_SCALE)
    // Zoom-out from 0.5 clamps to the floor.
    expect(buttonZoomStepAdditive(0.5, -1)).toBe(COSTUME_VIEWPORT_MIN_SCALE)
    // Ceiling holds; non-finite falls back to the default scale path.
    expect(buttonZoomStepAdditive(4.8, 1)).toBe(COSTUME_VIEWPORT_MAX_SCALE)
    expect(buttonZoomStepAdditive(Number.NaN, 1)).toBeCloseTo(1.5, 12)
  })

  it('keeps the surface anchor fixed through the additive step', () => {
    const viewport = { x: 12, y: -34, scale: 1 }
    const anchorSurface = { x: 1200, y: 900 }
    const anchorScreen = surfaceToScreen(anchorSurface, SURFACE, CENTER, viewport)
    const next = buttonZoomStepAdditive(1, 1)
    const zoomed = zoomViewportAtSurfacePoint(viewport, SURFACE, CENTER, anchorSurface, next)
    expect(zoomed.appliedScale).toBeCloseTo(1.5, 12)
    const after = surfaceToScreen(anchorSurface, SURFACE, CENTER, zoomed.viewport)
    expect(Math.hypot(after.x - anchorScreen.x, after.y - anchorScreen.y)).toBeLessThan(1)
    // Off-center selection anchors pin too, including the 0.25 -> 0.5 step.
    const offCenter = { x: 600, y: 1350 }
    const offScreen = surfaceToScreen(offCenter, SURFACE, CENTER, { x: 0, y: 0, scale: 0.25 })
    const special = zoomViewportAtSurfacePoint({ x: 0, y: 0, scale: 0.25 }, SURFACE, CENTER, offCenter, buttonZoomStepAdditive(0.25, 1))
    expect(special.appliedScale).toBeCloseTo(0.5, 12)
    const offAfter = surfaceToScreen(offCenter, SURFACE, CENTER, special.viewport)
    expect(Math.hypot(offAfter.x - offScreen.x, offAfter.y - offScreen.y)).toBeLessThan(1)
  })
})

describe('costume-viewport surface<->screen mapping', () => {
  it('centers the artwork on the container at the default viewport', () => {
    const viewport = { x: 0, y: 0, scale: 1 }
    expect(surfaceToScreen({ x: 1200, y: 900 }, SURFACE, CENTER, viewport)).toEqual(CENTER)
    expect(screenToSurface(CENTER, SURFACE, CENTER, viewport)).toEqual({ x: 1200, y: 900 })
    const rect = predictSurfaceRect(SURFACE, CENTER, viewport)
    expect(rect).toEqual({ left: CENTER.x - 1200, top: CENTER.y - 900, width: 2400, height: 1800 })
  })

  it('scales around the artwork center and inverts exactly', () => {
    const viewport = { x: 30, y: -20, scale: 2 }
    const points = [
      { x: 0, y: 0 },
      { x: 2400, y: 1800 },
      { x: 1200, y: 900 },
      { x: 600, y: 1350 },
    ]
    for (const point of points) {
      const screen = surfaceToScreen(point, SURFACE, CENTER, viewport)
      // Artwork center lands on container center + viewport offset.
      if (point.x === 1200 && point.y === 900) {
        expect(screen).toEqual({ x: CENTER.x + 30, y: CENTER.y - 20 })
      }
      const back = screenToSurface(screen, SURFACE, CENTER, viewport)
      expect(back.x).toBeCloseTo(point.x, 10)
      expect(back.y).toBeCloseTo(point.y, 10)
    }
    const rect = predictSurfaceRect(SURFACE, CENTER, viewport)
    expect(rect.width).toBe(4800)
    expect(rect.height).toBe(3600)
    expect(rect.left).toBeCloseTo(CENTER.x + 30 - 2400, 10)
  })

  it('converts deltas with the live scale instead of a fixed 0.5 constant', () => {
    // 1 surface px covers `scale` screen px; the 2400x1800 surface at 2x maps
    // 10 surface px -> 20 screen px.
    expect(surfaceDeltaToScreenDelta(10, 2)).toBe(20)
    expect(screenDeltaToSurfaceDelta(20, 2)).toBe(10)
    // A 1 screen-px brush tolerance is half a surface px at 2x, not 0.5 SVG
    // units blindly reused across zoom levels.
    expect(screenToleranceToSurfaceUnits(1, 2, 1)).toBe(0.5)
    expect(screenToleranceToSurfaceUnits(1, 0.5, 1)).toBe(2)
    // Vector SVG units ride the x5 workspace upscale before the CSS scale.
    expect(screenToleranceToSurfaceUnits(5, 2, 5)).toBe(0.5)
    expect(COSTUME_VIEWPORT_DEFAULT_SURFACE).toEqual({ width: 2400, height: 1800 })
  })
})

describe('costume-viewport pointer-fixed zoom', () => {
  const anchors = [
    { x: 500, y: 400 }, // artwork center
    { x: 620, y: 480 }, // off-center artwork point
    { x: 100, y: 100 }, // container corner (outside artwork)
    { x: 900, y: 700 }, // far corner
  ]
  const factors = [1.1, 0.9, 1.15, 0.85, 2, 0.5, 1.5]
  const scales = [0.25, 0.5, 1, 2, 4]

  it('keeps every fixed point within 1 screen px across factors and scales', () => {
    for (const scale of scales) {
      for (const factor of factors) {
        for (const anchor of anchors) {
          const viewport = { x: 12, y: -34, scale }
          const fixedSurface = screenToSurface(anchor, SURFACE, CENTER, viewport)
          const zoomed = zoomViewportAtScreenPoint(viewport, SURFACE, CENTER, anchor, factor)
          const error = screenError(anchor, SURFACE, CENTER, zoomed.viewport, fixedSurface)
          expect(error).toBeLessThan(1)
        }
      }
    }
  })

  it('applies the anchor-offset entry point identically', () => {
    const viewport = { x: 12, y: -34, scale: 1 }
    const anchor = { x: 620, y: 480 }
    const viaPoint = zoomViewportAtScreenPoint(viewport, SURFACE, CENTER, anchor, 1.1)
    const viaOffset = zoomViewportAtAnchorOffset(
      viewport,
      SURFACE,
      { x: anchor.x - CENTER.x, y: anchor.y - CENTER.y },
      1.1,
    )
    // The offset form works in the container-centered frame, so with the same
    // anchor offset both paths pin the same surface point to the same screen
    // point and must agree exactly.
    expect(viaOffset.viewport.scale).toBeCloseTo(viaPoint.viewport.scale, 12)
    expect(viaOffset.viewport.x).toBeCloseTo(viaPoint.viewport.x, 12)
    expect(viaOffset.viewport.y).toBeCloseTo(viaPoint.viewport.y, 12)
  })

  it('clamps the scale but still pins the fixed point', () => {
    const low = zoomViewportAtScreenPoint({ x: 0, y: 0, scale: 0.3 }, SURFACE, CENTER, { x: 620, y: 480 }, 0.5)
    expect(low.viewport.scale).toBe(COSTUME_VIEWPORT_MIN_SCALE)
    expect(low.clamped).toBe(true)
    const fixedLow = screenToSurface({ x: 620, y: 480 }, SURFACE, CENTER, { x: 0, y: 0, scale: 0.3 })
    expect(screenError({ x: 620, y: 480 }, SURFACE, CENTER, low.viewport, fixedLow)).toBeLessThan(1)

    const high = zoomViewportAtScreenPoint({ x: 0, y: 0, scale: 4 }, SURFACE, CENTER, { x: 620, y: 480 }, 2)
    expect(high.viewport.scale).toBe(COSTUME_VIEWPORT_MAX_SCALE)
    expect(high.clamped).toBe(true)
    const fixedHigh = screenToSurface({ x: 620, y: 480 }, SURFACE, CENTER, { x: 0, y: 0, scale: 4 })
    expect(screenError({ x: 620, y: 480 }, SURFACE, CENTER, high.viewport, fixedHigh)).toBeLessThan(1)
  })

  it('treats non-finite factors as no-ops', () => {
    const viewport = { x: 5, y: 6, scale: 2 }
    expect(zoomViewportAtScreenPoint(viewport, SURFACE, CENTER, CENTER, Number.NaN).appliedFactor).toBe(1)
    expect(zoomViewportAtScreenPoint(viewport, SURFACE, CENTER, CENTER, 0).appliedFactor).toBe(1)
  })
})

describe('costume-viewport wheel resolution', () => {
  const base = { x: 10, y: 20, scale: 1 }

  it('zooms at the pointer on ctrl/meta and pins the cursor', () => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      const wheel = { deltaX: 0, deltaY: -100, deltaMode: 0, ...modifiers }
      const resolved = resolveWheelViewport(base, wheel, {
        surface: SURFACE,
        containerCenter: CENTER,
        screenPoint: { x: 620, y: 480 },
      })
      expect(resolved.kind).toBe('zoom')
      if (resolved.kind !== 'zoom') continue
      expect(resolved.viewport.scale).toBeCloseTo(1.1, 12)
      const fixed = screenToSurface({ x: 620, y: 480 }, SURFACE, CENTER, base)
      const after = surfaceToScreen(fixed, SURFACE, CENTER, resolved.viewport)
      expect(Math.hypot(after.x - 620, after.y - 480)).toBeLessThan(1)
    }
  })

  it('zooms by the delta magnitude on ctrl-wheel and still pins the cursor', () => {
    // +50 -> 1 - 0.05 = 0.95 (magnitude-proportional, not the legacy 0.9x).
    const resolved = resolveWheelViewport(
      base,
      { deltaX: 0, deltaY: 50, deltaMode: 0, ctrlKey: true },
      { surface: SURFACE, containerCenter: CENTER, screenPoint: CENTER },
    )
    expect(resolved.kind).toBe('zoom')
    if (resolved.kind === 'zoom') {
      expect(resolved.viewport.scale).toBeCloseTo(0.95, 12)
      expect(resolved.normalizedDeltaY).toBe(50)
    }
    // Small delta gives a small step and still pins the pointer.
    const small = resolveWheelViewport(
      base,
      { deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true },
      { surface: SURFACE, containerCenter: CENTER, screenPoint: { x: 620, y: 480 } },
    )
    expect(small.kind).toBe('zoom')
    if (small.kind === 'zoom') {
      expect(small.viewport.scale).toBeCloseTo(1.01, 12)
      const fixed = screenToSurface({ x: 620, y: 480 }, SURFACE, CENTER, base)
      const after = surfaceToScreen(fixed, SURFACE, CENTER, small.viewport)
      expect(Math.hypot(after.x - 620, after.y - 480)).toBeLessThan(1)
    }
  })

  it('pans on plain wheel and keeps the scale', () => {
    const resolved = resolveWheelViewport(base, { deltaX: 10, deltaY: 20, deltaMode: 0 }, {})
    expect(resolved.kind).toBe('pan')
    if (resolved.kind === 'pan') {
      expect(resolved.viewport).toEqual({ x: 0, y: 0, scale: 1 })
      expect(resolved.horizontalShift).toBe(false)
    }
  })

  it('pans horizontally on shift when deltaX is zero', () => {
    const resolved = resolveWheelViewport(
      base,
      { deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true },
      {},
    )
    expect(resolved.kind).toBe('pan')
    if (resolved.kind === 'pan') {
      expect(resolved.horizontalShift).toBe(true)
      expect(resolved.viewport).toEqual({ x: -20, y: 20, scale: 1 })
    }
  })

  it('scales line-mode deltas and ignores zero ticks', () => {
    const lined = resolveWheelViewport(base, { deltaX: 0, deltaY: 2, deltaMode: 1 }, {})
    expect(lined.kind).toBe('pan')
    if (lined.kind === 'pan') expect(lined.viewport).toEqual({ x: 10, y: 20 - 30, scale: 1 })
    const none = resolveWheelViewport(base, { deltaX: 0, deltaY: 0, deltaMode: 0 }, {})
    expect(none.kind).toBe('none')
    const zoomNone = resolveWheelViewport(
      base,
      { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: true },
      { surface: SURFACE, containerCenter: CENTER, screenPoint: CENTER },
    )
    expect(zoomNone.kind).toBe('none')
  })

  it('pans with the same helper the zoom uses (shared screen-px frame)', () => {
    expect(panViewport(base, 5, -7)).toEqual({ x: 5, y: 27, scale: 1 })
  })
})

describe('costume-viewport Paper-to-CSS density conversion', () => {
  // Density = surface px per Paper unit (W / Pw). Vector 2400/960 = 2.5 [A3];
  // bitmap res2 960/960 = 1.0 [A1 R-own]; bitmap res1 is undecided (0.5 vs
  // 1.0) so tests derive each reading per assumption and never bake one in.
  const VECTOR_DENSITY = 2400 / 960 // 2.5
  const BITMAP_RES2_DENSITY = 960 / 960 // 1.0

  it('sanitizes the explicit density without assuming one', () => {
    expect(sanitizePaperToCssDensity(2.5)).toBe(2.5)
    expect(sanitizePaperToCssDensity(1)).toBe(1)
    expect(sanitizePaperToCssDensity(0)).toBeUndefined()
    expect(sanitizePaperToCssDensity(-2.5)).toBeUndefined()
    expect(sanitizePaperToCssDensity(Number.NaN)).toBeUndefined()
    expect(sanitizePaperToCssDensity(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('converts Paper steps to CSS steps and back (fail-closed 0)', () => {
    expect(cssScaleStepForPaperStep(0.5, VECTOR_DENSITY)).toBeCloseTo(0.2, 12)
    expect(cssScaleStepForPaperStep(0.1, VECTOR_DENSITY)).toBeCloseTo(0.04, 12)
    expect(cssScaleStepForPaperStep(0.5, BITMAP_RES2_DENSITY)).toBeCloseTo(0.5, 12)
    expect(paperStepForCssScaleStep(0.2, VECTOR_DENSITY)).toBeCloseTo(0.5, 12)
    expect(paperStepForCssScaleStep(0.04, VECTOR_DENSITY)).toBeCloseTo(0.1, 12)
    // Round-trip is exact for finite positive densities.
    expect(paperStepForCssScaleStep(cssScaleStepForPaperStep(0.5, 2.5), 2.5)).toBeCloseTo(0.5, 12)
    // Undecided/invalid densities never silently assume 1.0.
    expect(cssScaleStepForPaperStep(0.5, Number.NaN)).toBe(0)
    expect(cssScaleStepForPaperStep(0.5, 0)).toBe(0)
    expect(cssScaleStepForPaperStep(0.5, -1)).toBe(0)
    expect(cssScaleStepForPaperStep(Number.NaN, 2.5)).toBe(0)
    expect(paperStepForCssScaleStep(0.2, Number.NaN)).toBe(0)
    expect(paperStepForCssScaleStep(Number.NaN, 2.5)).toBe(0)
  })

  it('density 1 is the res2 Paper band (floor 0.333, reset 0.5), not legacy 0.25', () => {
    // Zoom-in above the res2 floor still matches the legacy copy numerically
    // (same +0.5 step, same base): Paper basis, not a legacy assumption.
    // (Exactly at the floor the Paper band exits to the reset 0.5 instead of
    // adding a step, so 0.333 is pinned separately below.)
    for (const scale of [0.5, 1, 1.5, 4]) {
      expect(buttonZoomStepForPaperDensity(scale, 1, 1)).toBeCloseTo(buttonZoomStepAdditive(scale, 1), 12)
    }
    // Floor region diverges by design: res2 floor is 0.333 (Paper 0.333),
    // legacy unknown floor is 0.25. Zoom-out from 0.5 lands on 0.333 (res2)
    // vs 0.25 (legacy); floor-exit returns to the Paper reset 0.5.
    expect(buttonZoomStepForPaperDensity(0.5, -1, 1)).toBeCloseTo(0.333, 12)
    expect(buttonZoomStepAdditive(0.5, -1)).toBe(COSTUME_VIEWPORT_MIN_SCALE)
    expect(buttonZoomStepForPaperDensity(0.333, 1, 1)).toBeCloseTo(0.5, 12)
    expect(viewportMinScaleForDensity(1)).toBeCloseTo(0.333, 12)
    expect(viewportResetScaleForDensity(1)).toBeCloseTo(0.5, 12)
    expect(viewportUiPercentForDensity(0.5, 1)).toBe(100)
    // Non-clamping deltas reproduce the legacy copy numerically at density 1.
    for (const dy of [-100, -10, 50, 30]) {
      expect(wheelZoomForPaperDensity(1, dy, 1)).toBeCloseTo(wheelZoomAdditiveScale(1, dy), 12)
    }
    // Clamping deltas diverge by design at the different floors.
    expect(wheelZoomForPaperDensity(1, 1000, 1)).toBeCloseTo(0.333, 12)
    expect(wheelZoomAdditiveScale(1, 1000)).toBe(COSTUME_VIEWPORT_MIN_SCALE)
  })

  it('scales the vector button step to the true Paper gain (2.5 -> 0.5)', () => {
    // Legacy copy adds +0.5 CSS: Paper gain 0.5 * 2.5 = 1.25 (2.5x too big).
    expect(buttonZoomStepAdditive(1, 1)).toBeCloseTo(1.5, 12)
    // Density-aware step adds +0.2 CSS: Paper gain 0.2 * 2.5 = 0.5 (parity).
    expect(buttonZoomStepForPaperDensity(1, 1, VECTOR_DENSITY)).toBeCloseTo(1.2, 12)
    expect(buttonZoomStepForPaperDensity(1, -1, VECTOR_DENSITY)).toBeCloseTo(0.8, 12)
    const gain = paperStepForCssScaleStep(
      buttonZoomStepForPaperDensity(1, 1, VECTOR_DENSITY) - 1,
      VECTOR_DENSITY,
    )
    expect(gain).toBeCloseTo(0.5, 12)
    // Bitmap res2 at density 1 keeps the legacy gain (parity already held).
    expect(buttonZoomStepForPaperDensity(1, 1, BITMAP_RES2_DENSITY)).toBeCloseTo(1.5, 12)
  })

  it('scales the vector wheel gain to the true Paper gain (0.25 -> 0.1)', () => {
    // Legacy copy: -100 tick -> +0.1 CSS -> Paper gain 0.25 (2.5x too big).
    expect(wheelZoomAdditiveScale(1, -100)).toBeCloseTo(1.1, 12)
    // Density-aware: -100 tick -> +0.04 CSS -> Paper gain 0.1 (parity).
    expect(wheelZoomForPaperDensity(1, -100, VECTOR_DENSITY)).toBeCloseTo(1.04, 12)
    const gain = paperStepForCssScaleStep(wheelZoomForPaperDensity(1, -100, VECTOR_DENSITY) - 1, VECTOR_DENSITY)
    expect(gain).toBeCloseTo(0.1, 12)
    // Magnitude stays proportional: +50 -> Paper -0.05, CSS -0.02 at 2.5.
    expect(wheelZoomForPaperDensity(1, 50, VECTOR_DENSITY)).toBeCloseTo(0.98, 12)
    // Line-mode input still arrives pre-expanded x15 by the caller.
    expect(normalizeWheelDelta(2, 1)).toBe(30)
    expect(wheelZoomForPaperDensity(1, 30, VECTOR_DENSITY)).toBeCloseTo(1 - 0.03 / 2.5, 12)
  })

  it('derives bitmap res1 on the decided 0.5 density (reference 2x basis)', () => {
    // Decided: stored res1 is kept non-destructively (480 canvas) while the
    // reference loader doubles res1 pixels/center to res2 before paint, so
    // 1 canvas px = 2 Paper units (density 0.5). Paper reset 0.5 -> CSS 1.0,
    // floor 0.333 -> CSS 0.666..., button +/-0.5 -> +/-1.0 CSS,
    // classic -100 tick (+0.1 Paper) -> +0.2 CSS.
    const res1 = 480 / 960 // 0.5 (decided)
    expect(buttonZoomStepForPaperDensity(1, 1, res1)).toBeCloseTo(2.0, 12) // +1.0 CSS
    expect(buttonZoomStepForPaperDensity(1, -1, res1)).toBeCloseTo(0.666, 9) // 1 - 1.0 clamps to the res1 floor
    expect(wheelZoomForPaperDensity(1, -100, res1)).toBeCloseTo(1.2, 12)
    expect(viewportResetScaleForDensity(res1)).toBeCloseTo(1.0, 12)
    expect(viewportMinScaleForDensity(res1)).toBeCloseTo(0.666, 9)
    expect(viewportUiPercentForDensity(1.0, res1)).toBe(100)
  })

  it('keeps the per-mode floor-exit, band clamp, and non-finite contract', () => {
    // Floor-exit lands on the Paper reset per density (vector 0.1332 -> 0.2,
    // res2 0.333 -> 0.5), mirroring the audited 0.333 -> 0.5 pattern.
    expect(buttonZoomStepForPaperDensity(COSTUME_VIEWPORT_VECTOR_MIN_SCALE, 1, VECTOR_DENSITY)).toBeCloseTo(
      COSTUME_VIEWPORT_VECTOR_RESET_SCALE,
      12,
    )
    expect(buttonZoomStepForPaperDensity(0.333, 1, 1)).toBeCloseTo(0.5, 12)
    expect(buttonZoomStepForPaperDensity(COSTUME_VIEWPORT_VECTOR_MIN_SCALE, -1, VECTOR_DENSITY)).toBeCloseTo(
      COSTUME_VIEWPORT_VECTOR_MIN_SCALE,
      12,
    )
    expect(buttonZoomStepForPaperDensity(0.25, 1, 1)).toBeCloseTo(0.5, 12) // 0.25 clamps up to the res2 floor 0.333, then floor-exits to reset 0.5
    // Band clamp holds for scaled steps too (per-density ceiling/minimum).
    expect(buttonZoomStepForPaperDensity(4.9, 1, VECTOR_DENSITY)).toBe(COSTUME_VIEWPORT_MAX_SCALE)
    expect(wheelZoomForPaperDensity(4.99, -1000, VECTOR_DENSITY)).toBe(COSTUME_VIEWPORT_MAX_SCALE)
    expect(wheelZoomForPaperDensity(0.14, 1000, VECTOR_DENSITY)).toBeCloseTo(COSTUME_VIEWPORT_VECTOR_MIN_SCALE, 12)
    expect(wheelZoomForPaperDensity(0.34, 1000, 1)).toBeCloseTo(0.333, 12)
    // Non-finite scale/delta/density fail closed (no NaN, no throw).
    // Non-finite scale falls back to the per-density reset (0.2 at 2.5),
    // then takes the density-scaled step: 0.2 + 0.5/2.5 = 0.4.
    expect(buttonZoomStepForPaperDensity(Number.NaN, 1, VECTOR_DENSITY)).toBeCloseTo(0.4, 12)
    expect(buttonZoomStepForPaperDensity(1, 1, Number.NaN)).toBe(clampViewportScale(1))
    expect(buttonZoomStepForPaperDensity(1, 1, 0)).toBe(clampViewportScale(1))
    expect(buttonZoomStepForPaperDensity(1, 1, -2.5)).toBe(clampViewportScale(1))
    expect(wheelZoomForPaperDensity(1, 0, VECTOR_DENSITY)).toBe(1)
    expect(wheelZoomForPaperDensity(1, Number.NaN, VECTOR_DENSITY)).toBe(1)
    expect(wheelZoomForPaperDensity(1, -100, Number.NaN)).toBe(1)
    expect(wheelZoomForPaperDensity(1, -100, 0)).toBe(1)
    expect(wheelZoomForPaperDensity(Number.NaN, -100, VECTOR_DENSITY)).toBeCloseTo(0.24, 12)
  })

  it('pins the surface anchor through the density-aware step', () => {
    const viewport = { x: 12, y: -34, scale: 1 }
    const anchorSurface = { x: 1200, y: 900 }
    const anchorScreen = surfaceToScreen(anchorSurface, SURFACE, CENTER, viewport)
    const next = buttonZoomStepForPaperDensity(1, 1, 2400 / 960)
    expect(next).toBeCloseTo(1.2, 12)
    const zoomed = zoomViewportAtSurfacePoint(viewport, SURFACE, CENTER, anchorSurface, next)
    const after = surfaceToScreen(anchorSurface, SURFACE, CENTER, zoomed.viewport)
    expect(Math.hypot(after.x - anchorScreen.x, after.y - anchorScreen.y)).toBeLessThan(1)
  })
})

describe('costume-viewport vector Paper wiring (BitmapEditor live path)', () => {
  const DENSITY = VECTOR_PAPER_TO_CSS_DENSITY // 2.5 [A3]

  it('pins the vector Paper density constant (2400/960, assumption-tagged)', () => {
    expect(DENSITY).toBeCloseTo(2.5, 12)
    expect(DENSITY).toBeCloseTo(2400 / 960, 12)
  })

  it('normalizes the real Paper floor/reset to CSS on the per-mode band', () => {
    // Theoretical values are live values now (per-mode band, no gap).
    expect(VECTOR_PAPER_FLOOR_CSS_THEORETICAL).toBeCloseTo(0.333 / 2.5, 12)
    expect(VECTOR_PAPER_RESET_CSS_THEORETICAL).toBeCloseTo(0.2, 12)
    expect(VECTOR_PAPER_FLOOR_CSS_THEORETICAL).toBeCloseTo(COSTUME_VIEWPORT_VECTOR_MIN_SCALE, 12)
    expect(VECTOR_PAPER_RESET_CSS_THEORETICAL).toBeCloseTo(COSTUME_VIEWPORT_VECTOR_RESET_SCALE, 12)
    // Effective floor/reset equal the theoretical values (exact, Paper basis).
    expect(VECTOR_PAPER_FLOOR_CSS_CLAMPED).toBeCloseTo(0.333 / 2.5, 12)
    expect(clampViewportScaleForDensity(VECTOR_PAPER_FLOOR_CSS_THEORETICAL, VECTOR_PAPER_TO_CSS_DENSITY)).toBeCloseTo(
      0.333 / 2.5,
      12,
    )
    expect(clampViewportScaleForDensity(VECTOR_PAPER_RESET_CSS_THEORETICAL, VECTOR_PAPER_TO_CSS_DENSITY)).toBeCloseTo(0.2, 12)
    // Res2 band pins.
    expect(COSTUME_VIEWPORT_BITMAP_RES2_MIN_SCALE).toBeCloseTo(0.333, 12)
    expect(COSTUME_VIEWPORT_BITMAP_RES2_RESET_SCALE).toBeCloseTo(0.5, 12)
    // Res1 band pins (decided 0.5: reset 1.0, floor 0.666...).
    expect(BITMAP_RES1_PAPER_TO_CSS_DENSITY).toBeCloseTo(0.5, 12)
    expect(BITMAP_RES1_PAPER_RESET_CSS_EFFECTIVE).toBeCloseTo(1.0, 12)
    expect(BITMAP_RES1_PAPER_FLOOR_CSS_EFFECTIVE).toBeCloseTo(0.666, 9)
    expect(COSTUME_VIEWPORT_BITMAP_RES1_MIN_SCALE).toBeCloseTo(0.666, 9)
    expect(COSTUME_VIEWPORT_BITMAP_RES1_RESET_SCALE).toBeCloseTo(1.0, 12)
    expect(viewportUiPercentForDensity(1.0, BITMAP_RES1_PAPER_TO_CSS_DENSITY)).toBe(100)
    expect(viewportUiPercentForDensity(0.2, VECTOR_PAPER_TO_CSS_DENSITY)).toBe(100)
    expect(viewportUiPercentForDensity(0.5, 1)).toBe(100)
    expect(COSTUME_VIEWPORT_GLOBAL_MIN_SCALE).toBeCloseTo(0.333 / 2.5, 12)
  })

  it('walks the res1 floor ladder without sticking or oscillating', () => {
    // Paper-basis ladder from reset 1.0 (step 1.0): 3.0 -> 2.0 -> 1.0 (reset)
    // -> 0.666... (floor clamp). Floor-exit returns to the reset 1.0,
    // mirroring the audited 0.333 -> 0.5 pattern at density 0.5.
    const d = BITMAP_RES1_PAPER_TO_CSS_DENSITY
    expect(buttonZoomStepForPaperDensity(3, -1, d)).toBeCloseTo(2.0, 12)
    expect(buttonZoomStepForPaperDensity(2, -1, d)).toBeCloseTo(1.0, 12)
    expect(buttonZoomStepForPaperDensity(1.0, -1, d)).toBeCloseTo(0.666, 9)
    expect(buttonZoomStepForPaperDensity(0.666, 1, d)).toBeCloseTo(1.0, 12)
    expect(buttonZoomStepForPaperDensity(1.0, 1, d)).toBeCloseTo(2.0, 12)
    // Round-trip at the boundary is stable (no oscillation).
    expect(buttonZoomStepForPaperDensity(buttonZoomStepForPaperDensity(1.0, -1, d), 1, d)).toBeCloseTo(1.0, 12)
    // Classic -100 wheel tick: +0.2 CSS (Paper +0.1); pointer pin holds.
    expect(wheelZoomForPaperDensity(1, -100, d)).toBeCloseTo(1.2, 12)
    expect(paperStepForCssScaleStep(0.2, d)).toBeCloseTo(0.1, 12)
  })

  it('walks the vector floor ladder without sticking or oscillating', () => {
    // Paper-basis ladder from 1 (step 0.2): 1 -> 0.8 -> 0.6 -> 0.4 -> 0.2
    // (reset) -> 0.1332 (floor clamp). Floor-exit returns to the reset 0.2.
    expect(buttonZoomStepForPaperDensity(1, -1, DENSITY)).toBeCloseTo(0.8, 12)
    expect(buttonZoomStepForPaperDensity(0.8, -1, DENSITY)).toBeCloseTo(0.6, 12)
    expect(buttonZoomStepForPaperDensity(0.6, -1, DENSITY)).toBeCloseTo(0.4, 12)
    expect(buttonZoomStepForPaperDensity(0.4, -1, DENSITY)).toBeCloseTo(0.2, 12)
    expect(buttonZoomStepForPaperDensity(0.2, -1, DENSITY)).toBeCloseTo(0.333 / 2.5, 12)
    expect(buttonZoomStepForPaperDensity(0.333 / 2.5, 1, DENSITY)).toBeCloseTo(0.2, 12)
    expect(buttonZoomStepForPaperDensity(0.5, -1, DENSITY)).toBeCloseTo(0.3, 12)
    expect(buttonZoomStepForPaperDensity(0.3, -1, DENSITY)).toBeCloseTo(0.333 / 2.5, 12) // 0.3 - 0.2 clamps to the vector floor
    // Round-trip at the boundary is stable (no oscillation).
    const back = buttonZoomStepForPaperDensity(
      buttonZoomStepForPaperDensity(0.2, -1, DENSITY),
      1,
      DENSITY,
    )
    expect(back).toBeCloseTo(0.2, 12)
  })

  it('resolves the vector ctrl-wheel through the density (pointer-fixed, line-mode, clamp)', () => {
    const base = { x: 10, y: 20, scale: 1 }
    const pointer = { x: 620, y: 480 }
    const context = { surface: SURFACE, containerCenter: CENTER, screenPoint: pointer }
    // Classic -100 tick: +0.04 CSS (1 -> 1.04), pin holds.
    const tick = resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true }, context, DENSITY)
    expect(tick.kind).toBe('zoom')
    if (tick.kind === 'zoom') {
      expect(tick.viewport.scale).toBeCloseTo(1.04, 12)
      expect(tick.normalizedDeltaY).toBe(-100)
      const fixed = screenToSurface(pointer, SURFACE, CENTER, base)
      const after = surfaceToScreen(fixed, SURFACE, CENTER, tick.viewport)
      expect(Math.hypot(after.x - pointer.x, after.y - pointer.y)).toBeLessThan(1)
    }
    // Small delta stays proportional: -25 -> +0.01 (1 -> 1.01).
    const small = resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: -25, deltaMode: 0, ctrlKey: true }, context, DENSITY)
    expect(small.kind).toBe('zoom')
    if (small.kind === 'zoom') expect(small.viewport.scale).toBeCloseTo(1.01, 12)
    // Line-mode x15 before the density division: dy=2 lines -> 30px -> -0.012 CSS.
    const lined = resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: 2, deltaMode: 1, ctrlKey: true }, context, DENSITY)
    expect(lined.kind).toBe('zoom')
    if (lined.kind === 'zoom') expect(lined.viewport.scale).toBeCloseTo(1 - 30 / 1000 / DENSITY, 12)
    // Meta follows the same pinned branch.
    const meta = resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: -100, deltaMode: 0, metaKey: true }, context, DENSITY)
    expect(meta.kind).toBe('zoom')
    if (meta.kind === 'zoom') expect(meta.viewport.scale).toBeCloseTo(1.04, 12)
    // Clamp holds at the per-mode band edges and still pins the pointer.
    const low = resolveWheelViewportForPaperDensity(
      { x: 0, y: 0, scale: 0.14 },
      { deltaX: 0, deltaY: 1000, deltaMode: 0, ctrlKey: true },
      { surface: SURFACE, containerCenter: CENTER, screenPoint: { x: 620, y: 480 } },
      DENSITY,
    )
    expect(low.kind).toBe('zoom')
    if (low.kind === 'zoom') {
      expect(low.viewport.scale).toBeCloseTo(0.333 / 2.5, 12)
      // The pin holds at the clamp; the flag mirrors the shared
      // zoomViewportAtScreenPoint contract (factor-derived), so only the
      // scale is pinned here, not the flag value.
      const fixedLow = screenToSurface({ x: 620, y: 480 }, SURFACE, CENTER, { x: 0, y: 0, scale: 0.14 })
      const afterLow = surfaceToScreen(fixedLow, SURFACE, CENTER, low.viewport)
      expect(Math.hypot(afterLow.x - 620, afterLow.y - 480)).toBeLessThan(1)
    }
    // Non-finite / zero / invalid density fail closed (no step, no throw).
    expect(resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: true }, context, DENSITY).kind).toBe('none')
    expect(resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: Number.NaN, deltaMode: 0, ctrlKey: true }, context, DENSITY).kind).toBe('none')
    expect(resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true }, context, Number.NaN).kind).toBe('none')
    expect(resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true }, context, 0).kind).toBe('none')
    // Pan branches are density-independent and unchanged.
    const shift = resolveWheelViewportForPaperDensity(base, { deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true }, {}, DENSITY)
    expect(shift.kind).toBe('pan')
    if (shift.kind === 'pan') expect(shift.viewport).toEqual({ x: -20, y: 20, scale: 1 })
  })

  it('keeps unknown bitmap on the legacy path (res1/res2 use the Paper band)', () => {
    // Unknown (no verified coefficient, no stored resolution) keeps the
    // legacy direct-copy helpers with the 0.25 floor. Res1 (density 0.5) and
    // res2 (density 1) use the Paper band (floor 0.666.../0.333, reset
    // 1.0/0.5). Floor-exit returns to the per-mode reset in both.
    for (const scale of [0.5, 1, 1.5, 4]) {
      expect(buttonZoomStepAdditive(scale, 1)).toBeCloseTo(scale + 0.5 > 5 ? 5 : scale + 0.5, 12)
    }
    expect(buttonZoomStepAdditive(0.25, 1)).toBe(COSTUME_VIEWPORT_MIN_STEP_TARGET)
    expect(buttonZoomStepForPaperDensity(0.333, 1, 1)).toBeCloseTo(0.5, 12)
    expect(buttonZoomStepForPaperDensity(0.666, 1, 0.5)).toBeCloseTo(1.0, 12)
    const res1 = 480 / 960 // 0.5 (decided)
    expect(buttonZoomStepForPaperDensity(1, 1, res1)).toBeCloseTo(2.0, 12)
  })
})

describe('costume-viewport scope keys (F2/F3 separation)', () => {
  it('separates by project + slot + costume + mode', () => {
    const base = { slotKey: 'sprite1:1', assetKey: 'md5a:png' } as const
    const bitmap = buildCostumeViewportKey({ ...base, projectId: 'projA', mode: 'bitmap' })
    const vector = buildCostumeViewportKey({ ...base, projectId: 'projA', mode: 'vector' })
    expect(bitmap).not.toBe(vector)
    // Same slot, different asset (slot reuse / different costume bytes).
    expect(buildCostumeViewportKey({ slotKey: 'sprite1:1', assetKey: 'md5b:png', projectId: 'projA', mode: 'bitmap' })).not.toBe(bitmap)
    // Same slot + asset, different project (project replace, identical bytes).
    expect(buildCostumeViewportKey({ ...base, projectId: 'projB', mode: 'bitmap' })).not.toBe(bitmap)
    // Same everything reproduces the same key (rename/reorder-safe identity).
    expect(buildCostumeViewportKey({ ...base, projectId: 'projA', mode: 'bitmap' })).toBe(bitmap)
  })

  it('keeps slot-only scopes shared only when no identity is known', () => {
    // Legacy fallbacks are explicit constants (auditable, not silent).
    expect(COSTUME_VIEWPORT_LEGACY_PROJECT_SEGMENT).toBe('legacy-project')
    expect(COSTUME_VIEWPORT_SLOT_ASSET_SEGMENT).toBe('slot')
    const missing = buildCostumeViewportKey({ slotKey: 'sprite1:1', mode: 'bitmap' })
    expect(missing).toContain(`project=${COSTUME_VIEWPORT_LEGACY_PROJECT_SEGMENT}`)
    expect(missing).toContain(`asset=${COSTUME_VIEWPORT_SLOT_ASSET_SEGMENT}`)
    expect(missing).not.toBe(buildCostumeViewportKey({ slotKey: 'sprite1:2', mode: 'bitmap' }))
    expect(missing).not.toBe(buildCostumeViewportKey({ slotKey: 'sprite1:1', mode: 'vector' }))
  })

  it('keeps the legacy slot key shape for fully-unmigrated wiring', () => {
    expect(buildLegacySlotViewportKey('sprite1:1', 'bitmap')).toBe('sprite1:1:bitmap')
    expect(buildLegacySlotViewportKey('sprite1:1', 'vector')).toBe('sprite1:1:vector')
    // Empty/whitespace identities fall back instead of producing empty segments.
    expect(buildCostumeViewportKey({ slotKey: '', projectId: '', assetKey: '', mode: 'bitmap' })).toBe(
      buildCostumeViewportKey({ slotKey: 'unknown-slot', projectId: undefined, assetKey: undefined, mode: 'bitmap' }),
    )
  })
})
