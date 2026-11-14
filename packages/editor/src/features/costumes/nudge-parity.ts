// Nudge parity expectations (independent pure helper, clean-room math).
//
// Encodes the observable reference behavior of scratch-paint's
// `nudge-tool.js` (read-only reference under `.tmp/`) so browser tests can
// compare it against the current editor without touching
// `Editor`/`BitmapEditor`:
//
// - reference step: `1 / paper.view.zoom`, Shift multiplies by 15
//   (`NUDGE_MORE_MULTIPLIER = 15`).
// - reference bounds: translation is clamped into `getActionBounds()` with a
//   1px margin (`bottom/top/left/right` in nudge-tool.js), applied per keydown.
// - reference history: keydown only translates + refreshes the bounding box;
//   `onUpdateImage()` (the history commit) runs on keyup. Holding a key
//   therefore produces N keydown translations but a single history entry per
//   press-release cycle.
//
// Current behavior (observed in `Editor.svelte`, read-only here):
// - vector: fixed `shift ? 15 : 1`; bitmap: fixed `shift ? 10 : 1`.
// - no zoom division; each keydown commits history immediately
//   (`moveSelectedVectorObjectBy` -> `updateVectorObjects(captureHistory=true)`,
//   bitmap -> `saveBitmapCostume`), so auto-repeat yields N history entries.
// - no keyup coalescing (`handleKeyUp` only forwards runtime keys).

export const REFERENCE_NUDGE_MORE_MULTIPLIER = 15
export const CURRENT_VECTOR_SHIFT_STEP = 15
export const CURRENT_VECTOR_BASE_STEP = 1
export const CURRENT_BITMAP_SHIFT_STEP = 10
export const CURRENT_BITMAP_BASE_STEP = 1

/** CSS viewport scale range shared with `costume-viewport.ts`. */
export const NUDGE_VIEWPORT_VECTOR_MIN_SCALE = 0.333 / 2.5

export const NUDGE_VIEWPORT_BITMAP_RES2_MIN_SCALE = 0.333

export const NUDGE_VIEWPORT_UNKNOWN_MIN_SCALE = 0.25

/**
 * Global lowest minimum across all live per-mode bands (vector 0.1332).
 * Projection math clamps here (not the legacy 0.25) so the vector Paper
 * reset 0.2 / floor 0.1332 map exactly instead of being pushed to 0.25
 * (which clipped 1 screen px to 0.8 SVG units). Per-mode UI-band
 * enforcement lives in the zoom-step/wheel/reset paths, not here.
 * Bitmap res2 (0.333) and unknown (0.25) scales are all above this floor,
 * so their raster math is unchanged.
 */
export const NUDGE_VIEWPORT_MIN_SCALE = 0.333 / 2.5

/** Alias kept explicit for readers mapping to `costume-viewport.ts`. */
export const NUDGE_VIEWPORT_GLOBAL_MIN_SCALE = 0.333 / 2.5

export const NUDGE_VIEWPORT_MAX_SCALE = 5

/** SVG units per vector document unit on the edit surface (5x art box). */
export const NUDGE_VECTOR_WORKSPACE_SCALE = 5

/** Desired on-screen nudge distance: 1px plain, 15px with Shift. */
export const NUDGE_SCREEN_PX = 1

export const NUDGE_SCREEN_PX_SHIFT = 15

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Reference step in document px for one arrow keydown. */
export function referenceNudgeStep(zoom: number, shift: boolean): number {
  const safeZoom = isFiniteNumber(zoom) && zoom > 0 ? zoom : 1
  const base = 1 / safeZoom
  return shift ? base * REFERENCE_NUDGE_MORE_MULTIPLIER : base
}

/** Clamp a CSS viewport scale into the UI range (mirrors costume-viewport). */
export function clampNudgeViewportScale(scale: number): number {
  if (!isFiniteNumber(scale)) return 1
  return Math.max(NUDGE_VIEWPORT_GLOBAL_MIN_SCALE, Math.min(NUDGE_VIEWPORT_MAX_SCALE, scale))
}

/** Per-mode minimum: vector 0.1332, bitmap-res2 0.333, unknown/res1 0.25. */
export function nudgeViewportMinScaleForMode(
  mode: 'vector' | 'bitmap-res2' | 'unknown' = 'unknown',
): number {
  if (mode === 'vector') return NUDGE_VIEWPORT_VECTOR_MIN_SCALE
  if (mode === 'bitmap-res2') return NUDGE_VIEWPORT_BITMAP_RES2_MIN_SCALE
  return NUDGE_VIEWPORT_UNKNOWN_MIN_SCALE
}

/** Clamp into an explicit per-mode band. Non-finite maps to 1. */
export function clampNudgeViewportScaleForMode(
  scale: number,
  mode: 'vector' | 'bitmap-res2' | 'unknown' = 'unknown',
): number {
  if (!isFiniteNumber(scale)) return 1
  return Math.max(nudgeViewportMinScaleForMode(mode), Math.min(NUDGE_VIEWPORT_MAX_SCALE, scale))
}

/**
 * Screen-constant vector step in SVG document units.
 * 1 screen px (15 with Shift) divided by the 5x art-box upscale and the
 * live CSS scale, so the visible travel stays constant across 25%..500%.
 */
export function referenceVectorNudgeStep(viewportScale: number, shift: boolean): number {
  const scale = clampNudgeViewportScale(viewportScale)
  const screenPx = shift ? NUDGE_SCREEN_PX_SHIFT : NUDGE_SCREEN_PX
  return screenPx / (NUDGE_VECTOR_WORKSPACE_SCALE * scale)
}

/**
 * Screen-constant bitmap step in canvas px (fractional).
 * Callers truncate toward zero for the integer raster preview
 * (`previewBitmapFloatingMove` semantics); sub-pixel totals stay pending
 * so repeats accumulate, and a fully sub-pixel single press is a no-op
 * without history (integer-pixel limitation at high zoom).
 */
export function referenceBitmapNudgeStep(viewportScale: number, shift: boolean): number {
  const scale = clampNudgeViewportScale(viewportScale)
  const screenPx = shift ? NUDGE_SCREEN_PX_SHIFT : NUDGE_SCREEN_PX
  return screenPx / scale
}

/** SVG-unit delta -> on-screen px at this zoom (measures apparent travel). */
export function screenPxForVectorStep(svgDelta: number, viewportScale: number): number {
  if (!isFiniteNumber(svgDelta)) return 0
  return svgDelta * NUDGE_VECTOR_WORKSPACE_SCALE * clampNudgeViewportScale(viewportScale)
}

/** Canvas-px delta -> on-screen px at this zoom (measures apparent travel). */
export function screenPxForBitmapStep(canvasDelta: number, viewportScale: number): number {
  if (!isFiniteNumber(canvasDelta)) return 0
  return canvasDelta * clampNudgeViewportScale(viewportScale)
}

/** Current fixed steps (zoom-independent). */
export function currentVectorStep(shift: boolean): number {
  return shift ? CURRENT_VECTOR_SHIFT_STEP : CURRENT_VECTOR_BASE_STEP
}

export function currentBitmapStep(shift: boolean): number {
  return shift ? CURRENT_BITMAP_SHIFT_STEP : CURRENT_BITMAP_BASE_STEP
}

export type NudgeBounds = { left: number; top: number; right: number; bottom: number }

/**
 * Reference per-axis clamp from nudge-tool.js.
 * `rect` is the united selection bounds; `bounds` is `getActionBounds()`.
 * The +-1 terms are verbatim from the reference.
 */
export function referenceClampedAxis(
  axis: 'x' | 'y',
  nudgeAmount: number,
  rect: { left: number; right: number; top: number; bottom: number },
  bounds: NudgeBounds,
): { up: number; down: number } | { left: number; right: number } {
  if (axis === 'y') {
    const bottom = bounds.bottom - rect.top - 1
    const top = bounds.top - rect.bottom + 1
    return {
      up: Math.min(bottom, Math.max(-nudgeAmount, top)),
      down: Math.max(top, Math.min(nudgeAmount, bottom)),
    }
  }
  const left = bounds.left - rect.right + 1
  const right = bounds.right - rect.left - 1
  return {
    left: Math.min(right, Math.max(-nudgeAmount, left)),
    right: Math.max(left, Math.min(nudgeAmount, right)),
  }
}

/** Current bitmap clamp (canvas edges, from `nudgeCostumeSelection`). */
export function currentBitmapClampedOrigin(
  origin: { x: number; y: number },
  size: { width: number; height: number },
  canvas: { width: number; height: number },
  delta: { dx: number; dy: number },
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(canvas.width - size.width, Math.round(origin.x + delta.dx))),
    y: Math.max(0, Math.min(canvas.height - size.height, Math.round(origin.y + delta.dy))),
  }
}

export type NudgeParityRow = {
  zoom: number
  shift: boolean
  reference: number
  currentVector: number
  currentBitmap: number
}

/** Build the 25%/100%/500% x plain/Shift expectation table. */
export function buildNudgeParityTable(zooms: readonly number[]): NudgeParityRow[] {
  const rows: NudgeParityRow[] = []
  for (const zoom of zooms) {
    for (const shift of [false, true]) {
      rows.push({
        zoom,
        shift,
        reference: referenceNudgeStep(zoom, shift),
        currentVector: currentVectorStep(shift),
        currentBitmap: currentBitmapStep(shift),
      })
    }
  }
  return rows
}
