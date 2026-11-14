// Pure zoom-aware vector hit tolerance (no DOM / Paper.js).
//
// scratch-paint reference (`.tmp/scratch-editor/.../selection-tools/`):
// - `SelectTool.TOLERANCE = 2` screen px, used as `2 / paper.view.zoom`.
// - `ReshapeTool.TOLERANCE = HANDLE_RADIUS (5.25) + HANDLE_PADDING (1) = 6.25`
//   screen px, used as `6.25 / paper.view.zoom`.
// Both are *screen-space* budgets divided by the live zoom so the on-screen
// grab distance stays constant.
//
// Current editor state (read-only observation, not edited here):
// - `paperVectorHitIndex(..., tolerance = 0.5)` takes SVG units, call sites in
//   `Editor.svelte` pass no tolerance, so every zoom uses a fixed 0.5.
// - `VECTOR_PATH_POINT_ADD_TOLERANCE = 6` is likewise fixed SVG units.
// - Vector SVG units reach the screen as
//     screenPx = svgUnits * VECTOR_WORKSPACE_SCALE(5) * viewportScale(0.25..5)
//   (`BitmapEditor.svelte`: art box `vectorCanvasWidth*5` inside an edit
//   surface scaled by `viewportScale`; point mapping via
//   `(client-rect.left)/rect.width*vectorCanvasWidth` observes the same
//   product).
//
// Hence the fixed 0.5 SVG units is really `0.5*5*s = 2.5*s` screen px:
// 0.625px at 25%, 2.5px at 100%, 12.5px at 500% -- under at min zoom and
// increasingly over at max zoom versus the intended 2px.
//
// Correct conversion (this module):
//   svgUnits = desiredScreenPx / (workspaceScale * viewportScale)
// with viewportScale clamped to [0.25, 5], mirroring
// `costume-viewport.ts` (`screenToleranceToSurfaceUnits`). Callers keep
// passing the result as the `tolerance` argument of the existing
// `paperVectorHitIndex` / reshape-add helper; no signature change needed.

export const VECTOR_SELECT_TOLERANCE_SCREEN_PX = 2

export const VECTOR_RESHAPE_TOLERANCE_SCREEN_PX = 6.25

/** SVG units -> surface px before the CSS viewport scale (vector art box). */
export const VECTOR_WORKSPACE_SCALE = 5

export const VECTOR_VIEWPORT_VECTOR_MIN_SCALE = 0.333 / 2.5

export const VECTOR_VIEWPORT_UNKNOWN_MIN_SCALE = 0.25

export const VECTOR_VIEWPORT_MIN_SCALE = 0.333 / 2.5

/** Alias kept explicit for readers mapping to `costume-viewport.ts`. */
export const VECTOR_VIEWPORT_GLOBAL_MIN_SCALE = 0.333 / 2.5

export const VECTOR_VIEWPORT_MAX_SCALE = 5

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function clampVectorViewportScale(scale: number): number {
  if (!isFiniteNumber(scale)) return 1
  return Math.max(VECTOR_VIEWPORT_GLOBAL_MIN_SCALE, Math.min(VECTOR_VIEWPORT_MAX_SCALE, scale))
}

/**
 * Convert a desired on-screen grab distance into Paper.js SVG units.
 * `workspaceScale` is 5 for the vector art box; `viewportScale` is the live
 * CSS `scale()` (clamped to 0.25..5). Non-finite desired px maps to 0.
 */
export function vectorToleranceToSvgUnits(
  desiredScreenPx: number,
  viewportScale: number,
  workspaceScale = VECTOR_WORKSPACE_SCALE,
): number {
  if (!isFiniteNumber(desiredScreenPx)) return 0
  const perUnit =
    isFiniteNumber(workspaceScale) && workspaceScale > 0 ? workspaceScale : VECTOR_WORKSPACE_SCALE
  return desiredScreenPx / (perUnit * clampVectorViewportScale(viewportScale))
}

/** scratch-paint select budget (2 screen px) in SVG units at this zoom. */
export function vectorSelectToleranceSvgUnits(
  viewportScale: number,
  workspaceScale = VECTOR_WORKSPACE_SCALE,
): number {
  return vectorToleranceToSvgUnits(VECTOR_SELECT_TOLERANCE_SCREEN_PX, viewportScale, workspaceScale)
}

/** scratch-paint reshape budget (6.25 screen px) in SVG units at this zoom. */
export function vectorReshapeToleranceSvgUnits(
  viewportScale: number,
  workspaceScale = VECTOR_WORKSPACE_SCALE,
): number {
  return vectorToleranceToSvgUnits(VECTOR_RESHAPE_TOLERANCE_SCREEN_PX, viewportScale, workspaceScale)
}

/** What the legacy fixed 0.5 SVG-unit tolerance really means on screen. */
export function fixedToleranceToScreenPx(
  fixedSvgUnits: number,
  viewportScale: number,
  workspaceScale = VECTOR_WORKSPACE_SCALE,
): number {
  if (!isFiniteNumber(fixedSvgUnits)) return 0
  const perUnit =
    isFiniteNumber(workspaceScale) && workspaceScale > 0 ? workspaceScale : VECTOR_WORKSPACE_SCALE
  return fixedSvgUnits * perUnit * clampVectorViewportScale(viewportScale)
}

/**
 * Zoom-aware tolerance from a measured surface scale (screen px per SVG
 * unit, e.g. `rect.width / vectorCanvasWidth` which already equals
 * `5 * viewportScale`). Lets pointer handlers convert the layout-measured
 * scale without re-deriving the viewport state; falls back to the legacy
 * fixed tolerance when the measured scale is unusable.
 */
export function vectorToleranceFromSurfaceScale(
  surfacePxPerSvgUnit: number,
  desiredScreenPx: number,
  fallbackSvgUnits = 0.5,
): number {
  if (!isFiniteNumber(desiredScreenPx)) return 0
  if (!isFiniteNumber(surfacePxPerSvgUnit) || surfacePxPerSvgUnit <= 0) return fallbackSvgUnits
  return desiredScreenPx / surfacePxPerSvgUnit
}

/** Select tolerance (2 screen px) from a measured surface scale. */
export function vectorSelectToleranceFromSurfaceScale(surfacePxPerSvgUnit: number): number {
  return vectorToleranceFromSurfaceScale(surfacePxPerSvgUnit, VECTOR_SELECT_TOLERANCE_SCREEN_PX)
}

/** Reshape tolerance (6.25 screen px) from a measured surface scale. */
export function vectorReshapeToleranceFromSurfaceScale(surfacePxPerSvgUnit: number): number {
  return vectorToleranceFromSurfaceScale(
    surfacePxPerSvgUnit,
    VECTOR_RESHAPE_TOLERANCE_SCREEN_PX,
    VECTOR_PATH_POINT_ADD_FALLBACK_TOLERANCE,
  )
}

/** Legacy fixed reshape tolerance used when no zoom is known. */
export const VECTOR_PATH_POINT_ADD_FALLBACK_TOLERANCE = 6
