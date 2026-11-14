import { describe, expect, it } from 'bun:test'
import {
  COSTUME_VIEWPORT_BUTTON_STEP,
  COSTUME_VIEWPORT_DEFAULT_SCALE,
  COSTUME_VIEWPORT_MAX_SCALE,
  COSTUME_VIEWPORT_MIN_SCALE,
  COSTUME_VIEWPORT_MIN_STEP_TARGET,
  COSTUME_VIEWPORT_WHEEL_DIVISOR,
  buttonZoomStepAdditive,
  clampViewportScale,
  wheelZoomAdditiveScale,
} from '../src/features/costumes/costume-viewport'

// Scratch Paint reference numbers (read-only, hardcoded from
// `.tmp/scratch-editor/packages/scratch-paint`):
// - `containers/paint-editor.jsx`: ZOOM_INCREMENT = 0.5 (additive, Paper zoom units)
// - `helper/view.js`: OUTERMOST_ZOOM_LEVEL = 0.333, resetZoom zoom = 0.5,
//   zoomToFit padding PADDING_PERCENT = 25, BUFFER = 50, MIN_RATIO = 0.125,
//   CENTER = (480, 360) in the 960x720 Paper project frame
// - `containers/scrollable-canvas.jsx`: ctrl-wheel deltaZoom = -deltaY / 1000,
//   line-mode multiplier x15, pan deltas divided by view.zoom
const SCRATCH = {
  zoomIncrement: 0.5,
  outermostZoomLevel: 0.333,
  resetZoom: 0.5,
  wheelDeltaDivisor: 1000,
  lineDeltaMultiplier: 15,
  paddingPercent: 25,
  buffer: 50,
  minRatio: 0.125,
  artBoard: { width: 960, height: 720 },
  center: { x: 480, y: 360 },
} as const

describe('zoom parity audit (reference numbers vs reproduced product behavior)', () => {
  it('reproduces the additive button step about the selection center', () => {
    // Reference: zoom += +/-0.5 Paper units about the selection center
    // (or the view center with no selection), e.g. 0.5 -> 1.0 doubles.
    expect(SCRATCH.zoomIncrement).toBe(0.5)
    // Product: scale += +/-0.5 CSS units about the selection-center surface
    // point (or the artwork center), e.g. 1.0 -> 1.5.
    expect(COSTUME_VIEWPORT_BUTTON_STEP).toBe(0.5)
    expect(buttonZoomStepAdditive(1, 1)).toBeCloseTo(1.5, 12)
    expect(buttonZoomStepAdditive(1, -1)).toBeCloseTo(0.5, 12)
    expect(0.5 + SCRATCH.zoomIncrement).toBe(1.0)
  })

  it('reproduces the minimum-to-0.5 special step', () => {
    // Reference: zooming in from exactly the 0.333 floor lands on the 0.5
    // reset level (delta 0.167) instead of adding the full 0.5.
    expect(SCRATCH.outermostZoomLevel).toBe(0.333)
    expect(SCRATCH.resetZoom).toBe(0.5)
    // Product: zooming in from exactly the 0.25 minimum lands on 0.5
    // (delta 0.25) instead of adding the full 0.5.
    expect(COSTUME_VIEWPORT_MIN_SCALE).toBe(0.25)
    expect(COSTUME_VIEWPORT_MIN_STEP_TARGET).toBe(0.5)
    expect(buttonZoomStepAdditive(0.25, 1)).toBeCloseTo(0.5, 12)
  })

  it('records the range difference (floor vs band)', () => {
    // Scratch: floor only, 0.333; zoom-out clamps, zoom-in unbounded.
    expect(SCRATCH.outermostZoomLevel).toBe(0.333)
    // Current: closed band 0.25..5 (25%..500% on the Reset label).
    expect(COSTUME_VIEWPORT_MIN_SCALE).toBe(0.25)
    expect(COSTUME_VIEWPORT_MAX_SCALE).toBe(5)
    expect(clampViewportScale(0.1)).toBe(0.25)
    expect(clampViewportScale(99)).toBe(5)
  })

  it('records reset/fit targets', () => {
    // Scratch reset: zoom = 0.5 (center preserved, then clamped to workspace).
    expect(SCRATCH.resetZoom).toBe(0.5)
    // Current reset: { x: 0, y: 0, scale: 1 } (artwork center = container center).
    expect(COSTUME_VIEWPORT_DEFAULT_SCALE).toBe(1)
    // Scratch fit: reset to 0.5 then zoom /= clamp(ratio, 0.125, 1) with a
    // 25%-per-side padding factor (x1.5 extent) and a 50px hit-bounds buffer
    // (bitmap). Current UI has no Fit path: listed as missing, not asserted
    // against product code.
    expect(SCRATCH.paddingPercent).toBe(25)
    expect(SCRATCH.buffer).toBe(50)
    expect(SCRATCH.minRatio).toBe(0.125)
  })

  it('reproduces the ctrl-wheel delta magnitude', () => {
    // Reference: additive gain -deltaY/1000 Paper units (deltaY=-100 ->
    // +0.1), pinned at the project point under the cursor, floor 0.333.
    expect(-(-100) / SCRATCH.wheelDeltaDivisor).toBeCloseTo(0.1, 12)
    // Product: same divisor in CSS units (deltaY=-100 -> +0.1), pinned at
    // the surface point under the cursor, clamped to 0.25..5.
    expect(COSTUME_VIEWPORT_WHEEL_DIVISOR).toBe(1000)
    expect(wheelZoomAdditiveScale(1, -100)).toBeCloseTo(1.1, 12)
    expect(wheelZoomAdditiveScale(1, 50)).toBeCloseTo(0.95, 12)
    expect(wheelZoomAdditiveScale(1, -10)).toBeCloseTo(1.01, 12)
  })

  it('records the center-guide coordinate frames', () => {
    // Scratch crosshair/artwork anchor: Paper project px (480, 360) in the
    // 960x720 art board; crosshair drawn 16 project units then rescaled by
    // 1/view.zoom to hold a constant screen size.
    expect(SCRATCH.center).toEqual({ x: 480, y: 360 })
    expect(SCRATCH.artBoard).toEqual({ width: 960, height: 720 })
    // Current centering: CSS px translate (vx, vy) added to the container
    // center; surface is 2400x1800 CSS px (480x360 stage at 5x).
    expect({ width: 480 * 5, height: 360 * 5 }).toEqual({ width: 2400, height: 1800 })
  })
})
