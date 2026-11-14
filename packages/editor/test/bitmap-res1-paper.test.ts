// Stored-res1 Paper oracle split (pure unit pins, no DOM/product change).
//
// The decided res1 coefficient lives in `bitmap-res1-paper.ts` (reference VM
// 2x-doubling basis, stored bytes kept non-destructively); the live viewport
// consumes it through `costume-viewport.ts`. This suite pins that the two
// modules agree exactly, plus the conversion conveniences (canvas<->Paper,
// fit buffer in canvas px, artboard centers) the task statement requires:
//
// - density 480 canvas / 960 Paper = 0.5 (1 canvas px = 2 Paper units),
// - reset Paper 0.5 -> CSS 1.0, floor Paper 0.333 -> CSS 0.666,
//   button +/-0.5 Paper -> +/-1.0 CSS, classic -100 tick (+0.1 Paper) -> +0.2,
// - fit buffer 50 Paper = 25 canvas px, artboard center 240,180 canvas =
//   480,360 Paper (x2).
// - save path untouched here: no 2x bake (bytes/metadata/resolution kept).
import { describe, expect, it } from 'bun:test'
import {
  BITMAP_RES1_BUTTON_CSS_STEP,
  BITMAP_RES1_CANVAS_CENTER,
  BITMAP_RES1_FIT_BUFFER_CANVAS_PX,
  BITMAP_RES1_FLOOR_CSS,
  BITMAP_RES1_PAPER_CENTER,
  BITMAP_RES1_PAPER_TO_CSS_DENSITY,
  BITMAP_RES1_RESET_CSS,
  BITMAP_RES1_WHEEL_TICK_CSS,
  res1CanvasToPaperUnits,
  res1FitBufferCanvasPx,
  res1PaperToCanvasUnits,
} from '../src/features/costumes/bitmap-res1-paper'
import {
  BITMAP_RES1_PAPER_FLOOR_CSS_EFFECTIVE,
  BITMAP_RES1_PAPER_RESET_CSS_EFFECTIVE,
  BITMAP_RES1_PAPER_TO_CSS_DENSITY as LIVE_RES1_DENSITY,
  viewportMinScaleForDensity,
  viewportResetScaleForDensity,
} from '../src/features/costumes/costume-viewport'

describe('bitmap-res1-paper oracle split (decided 2x basis)', () => {
  it('pins the decided density/reset/floor and agrees with the live viewport', () => {
    expect(BITMAP_RES1_PAPER_TO_CSS_DENSITY).toBeCloseTo(0.5, 12)
    expect(BITMAP_RES1_RESET_CSS).toBeCloseTo(1.0, 12)
    expect(BITMAP_RES1_FLOOR_CSS).toBeCloseTo(0.666, 12)
    expect(BITMAP_RES1_BUTTON_CSS_STEP).toBeCloseTo(1.0, 12)
    expect(BITMAP_RES1_WHEEL_TICK_CSS).toBeCloseTo(0.2, 12)
    // Live viewport consumes the same decided numbers.
    expect(LIVE_RES1_DENSITY).toBeCloseTo(BITMAP_RES1_PAPER_TO_CSS_DENSITY, 12)
    expect(BITMAP_RES1_PAPER_RESET_CSS_EFFECTIVE).toBeCloseTo(BITMAP_RES1_RESET_CSS, 12)
    expect(BITMAP_RES1_PAPER_FLOOR_CSS_EFFECTIVE).toBeCloseTo(BITMAP_RES1_FLOOR_CSS, 12)
    expect(viewportResetScaleForDensity(LIVE_RES1_DENSITY)).toBeCloseTo(1.0, 12)
    expect(viewportMinScaleForDensity(LIVE_RES1_DENSITY)).toBeCloseTo(0.666, 12)
  })

  it('converts canvas<->Paper at x2 with fail-closed 0', () => {
    expect(res1CanvasToPaperUnits(480)).toBeCloseTo(960, 12)
    expect(res1CanvasToPaperUnits(20)).toBeCloseTo(40, 12)
    expect(res1PaperToCanvasUnits(960)).toBeCloseTo(480, 12)
    expect(res1PaperToCanvasUnits(50)).toBeCloseTo(25, 12)
    expect(res1CanvasToPaperUnits(Number.NaN)).toBe(0)
    expect(res1PaperToCanvasUnits(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('pins the fit buffer and artboard centers on the 2x basis', () => {
    // 50 Paper buffer = 25 canvas px at density 0.5 (fit expand-then-pad).
    expect(BITMAP_RES1_FIT_BUFFER_CANVAS_PX).toBeCloseTo(25, 12)
    expect(res1FitBufferCanvasPx()).toBeCloseTo(25, 12)
    // Artboard center doubles: stored 240,180 canvas = 480,360 Paper.
    expect(BITMAP_RES1_CANVAS_CENTER).toEqual({ x: 240, y: 180 })
    expect(BITMAP_RES1_PAPER_CENTER).toEqual({ x: 480, y: 360 })
    expect(BITMAP_RES1_PAPER_CENTER.x).toBe(BITMAP_RES1_CANVAS_CENTER.x * 2)
    expect(BITMAP_RES1_PAPER_CENTER.y).toBe(BITMAP_RES1_CANVAS_CENTER.y * 2)
  })
})
