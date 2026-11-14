// Move/select parity geometry for Scratch-Paint compatibility work.
//
// Clean-room, pure, DOM-free helper. It encodes the *observable* behavior of
// the reference move/select path (read-only files under `.tmp/`, never
// imported or quoted here) in our own words and variable names so that unit
// and browser tests can pin the pix coefficients without touching
// `Editor.svelte`, `BitmapEditor.svelte`, or any existing vector helper
// (all owned by other work right now).
//
// Reference facts used below (numbers only, no source copied):
// - art board 960x720, rotation center (480, 360).
// - center-snap budget 4 screen px, guide fade distance 10 screen px; both
//   are divided by the live Paper zoom to get document units.
// - box closeness: |dx| < budget AND |dy| < budget (not radial).
// - Shift projects the drag delta onto the nearest 45-degree axis; Shift
//   also disables center snapping. Reshape mode never center-snaps (it shows
//   no center crosshair).
// - Alt duplicates the selection at press time, before the drag vector is
//   measured. The drag then moves the clones from their recorded origins.
// - Pointer is clamped into action bounds before the drag vector is built:
//   bitmap is the art board itself; vector is (view bounds united with the
//   art board) intersected with the max workspace.
// - While dragging, a center crosshair is shown at full opacity 0.75 inside
//   the moved selection bounds and faded to 0 outside over the fade distance
//   (corner => radial distance, edge => axial distance minus half extent).
// - Guide stroke widths, marquee dash, hit points, select tolerance, scale
//   handles and the selection anchor are all screen-px budgets divided by the
//   live zoom so the on-screen grab distance stays constant.
//
// Current-editor mapping (read-only observation, not edited here):
// - vector SVG units reach the screen as
//   `screenPx = svgUnits * 5 * viewportScale` (480x360 art box at 5x inside a
//   2400x1800 surface scaled by 0.25..5). Bitmap canvas px reach the screen as
//   `screenPx = canvasPx * viewportScale`.
// - `vector-move-drag.ts` already projects Shift drags onto PI/4 and gates
//   Alt duplication on press-time Alt outside text editing, but it has no
//   center snap, no action-bounds clamp, and no crosshair guide.
// - bitmap floating moves track Alt live per pointermove (copy flag can flip
//   mid-drag) and have no Shift angle projection at all.
//
// This module decides nothing about wiring. The integration guide at the end
// lists what a future Editor change must do; nothing here writes to history,
// the DOM, or Paper.js.

export type MovePoint = { x: number; y: number }

export type MoveRect = { left: number; top: number; right: number; bottom: number }

export type MoveSize = { width: number; height: number }

/** Reference art board in Paper document units. */
export const MOVE_ART_BOARD: MoveSize = { width: 960, height: 720 }

/** Reference rotation center (art-board center) in Paper units. */
export const MOVE_ART_CENTER: MovePoint = { x: 480, y: 360 }

/**
 * Reference max workspace: (-240, -180, 1440, 1080) expressed as a rect.
 * Vector drags may roam here; bitmap drags may not leave the art board.
 */
export const MOVE_MAX_WORKSPACE: MoveRect = { left: -240, top: -180, right: 1200, bottom: 900 }

/** Center-snap budget: 4 screen px (divided by zoom for document units). */
export const MOVE_SNAP_SCREEN_PX = 4

/** Guide fade distance: 10 screen px (divided by zoom for document units). */
export const MOVE_FADE_SCREEN_PX = 10

/** Shift angle step: 45 degrees. */
export const MOVE_SNAP_STEP_RADIANS = Math.PI / 4

/** Drag crosshair full opacity while the center sits inside the selection. */
export const MOVE_CROSSHAIR_FULL_OPACITY = 0.75

/** Crosshair nominal on-screen size (diameter budget, screen px). */
export const MOVE_CROSSHAIR_SIZE_SCREEN_PX = 16

/** Guide stroke budget: 1 screen px. */
export const MOVE_GUIDE_STROKE_SCREEN_PX = 1

/** Marquee dash budget: 3 screen px on / 3 off. */
export const MOVE_MARQUEE_DASH_SCREEN_PX = 3

/** Hit-point radius budget: 4 screen px. */
export const MOVE_HITPOINT_RADIUS_SCREEN_PX = 4

/** Select hit budget: 2 screen px. */
export const MOVE_SELECT_TOLERANCE_SCREEN_PX = 2

/** Scale-handle dot radius budget: 4 screen px (12% shadow at 5.5). */
export const MOVE_SCALE_HANDLE_RADIUS_SCREEN_PX = 4

/** Selection-anchor nominal size: 12 screen px. */
export const MOVE_SELECTION_ANCHOR_SCREEN_PX = 12

/** Paper zoom floor/reset/guard (observed reference numbers). */
export const MOVE_PAPER_FLOOR_ZOOM = 0.333

export const MOVE_PAPER_RESET_ZOOM = 0.5

export const MOVE_PAPER_ZOOM_SAFE_MAX = 1_000_000

/** Current CSS viewport band (mirrored so this module stays standalone). */
export const MOVE_VIEWPORT_VECTOR_MIN_SCALE = 0.333 / 2.5

export const MOVE_VIEWPORT_BITMAP_RES2_MIN_SCALE = 0.333

export const MOVE_VIEWPORT_UNKNOWN_MIN_SCALE = 0.25

/**
 * Global lowest minimum across all live per-mode bands (vector 0.1332).
 * Projection math clamps here so the vector Paper reset 0.2 / floor 0.1332
 * map exactly (legacy 0.25 clipped 1 screen px to 0.8 SVG units at 100%).
 * Bitmap res2 (0.333) / unknown (0.25) scales sit above this floor, so
 * their canvas-px math is unchanged. Live drags prefer the measured
 * surface scale (`rect.width / canvas.width`, `4 / scale`) and only fall
 * back to this clamp; this fix changes the fallback/pure helper, not the
 * live measured path.
 */
export const MOVE_VIEWPORT_MIN_SCALE = 0.333 / 2.5

/** Alias kept explicit for readers mapping to `costume-viewport.ts`. */
export const MOVE_VIEWPORT_GLOBAL_MIN_SCALE = 0.333 / 2.5

export const MOVE_VIEWPORT_MAX_SCALE = 5

export const MOVE_VIEWPORT_DEFAULT_SCALE = 1

/** Vector art-box upscale into the 2400x1800 edit surface. */
export const MOVE_VECTOR_WORKSPACE_SCALE = 5

export function isFiniteMoveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Clamp a Paper zoom into [0.333, 1e6]; non-finite maps to the reset 0.5. */
export function clampMovePaperZoom(zoom: number): number {
  if (!isFiniteMoveNumber(zoom)) return MOVE_PAPER_RESET_ZOOM
  if (zoom <= 0) return MOVE_PAPER_FLOOR_ZOOM
  return Math.max(MOVE_PAPER_FLOOR_ZOOM, Math.min(MOVE_PAPER_ZOOM_SAFE_MAX, zoom))
}

/** Clamp a CSS viewport scale into [global-min, 5]; non-finite maps to 1. */
export function clampMoveViewportScale(scale: number): number {
  if (!isFiniteMoveNumber(scale)) return MOVE_VIEWPORT_DEFAULT_SCALE
  return Math.max(MOVE_VIEWPORT_GLOBAL_MIN_SCALE, Math.min(MOVE_VIEWPORT_MAX_SCALE, scale))
}

/** Per-mode minimum: vector 0.1332, bitmap-res2 0.333, unknown 0.25. */
export function moveViewportMinScaleForMode(
  mode: 'vector' | 'bitmap-res2' | 'unknown' = 'unknown',
): number {
  if (mode === 'vector') return MOVE_VIEWPORT_VECTOR_MIN_SCALE
  if (mode === 'bitmap-res2') return MOVE_VIEWPORT_BITMAP_RES2_MIN_SCALE
  return MOVE_VIEWPORT_UNKNOWN_MIN_SCALE
}

/** Clamp into an explicit per-mode band. Non-finite maps to 1. */
export function clampMoveViewportScaleForMode(
  scale: number,
  mode: 'vector' | 'bitmap-res2' | 'unknown' = 'unknown',
): number {
  if (!isFiniteMoveNumber(scale)) return MOVE_VIEWPORT_DEFAULT_SCALE
  return Math.max(moveViewportMinScaleForMode(mode), Math.min(MOVE_VIEWPORT_MAX_SCALE, scale))
}

/**
 * Reference snap budget in Paper document units: 4 screen px / zoom.
 * At zoom 0.5 the window is 8 units wide; at zoom 4 it is 1 unit.
 */
export function snapThresholdPaperUnits(paperZoom: number): number {
  return MOVE_SNAP_SCREEN_PX / clampMovePaperZoom(paperZoom)
}

/** Reference fade distance in Paper units: 10 screen px / zoom. */
export function fadeDistancePaperUnits(paperZoom: number): number {
  return MOVE_FADE_SCREEN_PX / clampMovePaperZoom(paperZoom)
}

/** Reference guide stroke width in Paper units: 1 screen px / zoom. */
export function guideStrokePaperUnits(paperZoom: number): number {
  return MOVE_GUIDE_STROKE_SCREEN_PX / clampMovePaperZoom(paperZoom)
}

/** Reference marquee dash length in Paper units: 3 screen px / zoom. */
export function marqueeDashPaperUnits(paperZoom: number): number {
  return MOVE_MARQUEE_DASH_SCREEN_PX / clampMovePaperZoom(paperZoom)
}

/** Reference hit-point radius in Paper units: 4 screen px / zoom. */
export function hitPointRadiusPaperUnits(paperZoom: number): number {
  return MOVE_HITPOINT_RADIUS_SCREEN_PX / clampMovePaperZoom(paperZoom)
}

/** Reference select tolerance in Paper units: 2 screen px / zoom. */
export function selectTolerancePaperUnits(paperZoom: number): number {
  return MOVE_SELECT_TOLERANCE_SCREEN_PX / clampMovePaperZoom(paperZoom)
}

/**
 * Box closeness used by the reference snap check: strict `<` on each axis,
 * not a radial distance. `thresholdPaper` is already in document units
 * (4 / zoom). Non-finite coordinates never count as close.
 */
export function isBoxClose(a: MovePoint, b: MovePoint, thresholdPaper: number): boolean {
  if (!isFiniteMoveNumber(a?.x) || !isFiniteMoveNumber(a?.y)) return false
  if (!isFiniteMoveNumber(b?.x) || !isFiniteMoveNumber(b?.y)) return false
  if (!isFiniteMoveNumber(thresholdPaper) || thresholdPaper <= 0) return false
  return Math.abs(a.x - b.x) < thresholdPaper && Math.abs(a.y - b.y) < thresholdPaper
}

export type CenterSnapInput = {
  /** United selection center captured at press time. */
  selectionCenter: MovePoint
  /** Raw drag vector (clamped pointer minus press point), Paper units. */
  dragVector: MovePoint
  /** Rotation center; defaults to the art-board center. */
  artCenter?: MovePoint
  /** Snap budget in Paper units (4 / zoom). */
  thresholdPaper: number
  /** Shift held: angle projection wins, center snap is skipped. */
  shiftKey?: boolean
  /** Reshape mode shows no center crosshair, so it never center-snaps. */
  isReshape?: boolean
}

export type CenterSnapResult = {
  snapped: boolean
  /** Exact vector that lands the selection center on the art center. */
  snapVector: MovePoint | undefined
}

/**
 * Decide the reference center snap. When the moved selection center lands
 * inside the box window around the art center (and neither Shift nor reshape
 * applies), the drag snaps exactly: every item moves by
 * `artCenter - selectionCenter`, not by the raw pointer delta.
 */
export function resolveCenterSnap(input: CenterSnapInput): CenterSnapResult {
  const none: CenterSnapResult = { snapped: false, snapVector: undefined }
  if (input.shiftKey === true || input.isReshape === true) return none
  const center = input.artCenter ?? MOVE_ART_CENTER
  const moved = {
    x: input.selectionCenter.x + input.dragVector.x,
    y: input.selectionCenter.y + input.dragVector.y,
  }
  if (!isBoxClose(moved, center, input.thresholdPaper)) return none
  return {
    snapped: true,
    snapVector: { x: center.x - input.selectionCenter.x, y: center.y - input.selectionCenter.y },
  }
}

/**
 * Project a drag delta onto the nearest multiple of `step` radians while
 * preserving the projected length (Shift angle constraint). Zero and
 * non-finite deltas map to zero so clicks stay history-clean. The default
 * step is PI/4 (45 degrees). Written independently from the generic polar
 * projection idea; variable names and structure are our own.
 */
export function projectDeltaToStep(delta: MovePoint, step = MOVE_SNAP_STEP_RADIANS): MovePoint {
  if (!isFiniteMoveNumber(delta?.x) || !isFiniteMoveNumber(delta?.y)) return { x: 0, y: 0 }
  if (delta.x === 0 && delta.y === 0) return { x: 0, y: 0 }
  const safeStep = isFiniteMoveNumber(step) && step > 0 ? step : MOVE_SNAP_STEP_RADIANS
  const rawAngle = Math.atan2(delta.y, delta.x)
  const snappedAngle = Math.round(rawAngle / safeStep) * safeStep
  const axisX = Math.cos(snappedAngle)
  const axisY = Math.sin(snappedAngle)
  const projectedLength = axisX * delta.x + axisY * delta.y
  return { x: axisX * projectedLength, y: axisY * projectedLength }
}

/** Apply the Shift rule to a raw drag vector (Shift => 45-degree project). */
export function resolveShiftConstrainedDelta(raw: MovePoint, shiftKey: boolean): MovePoint {
  if (shiftKey !== true) return { x: raw?.x ?? 0, y: raw?.y ?? 0 }
  return projectDeltaToStep(raw, MOVE_SNAP_STEP_RADIANS)
}

/**
 * Final per-item displacement. Center snap wins over Shift (the reference
 * checks snap first and only consults Shift when no snap applies).
 */
export function resolveItemDisplacement(
  dragVector: MovePoint,
  snap: CenterSnapResult,
  shiftKey: boolean,
): MovePoint {
  if (snap.snapped && snap.snapVector) return { ...snap.snapVector }
  return resolveShiftConstrainedDelta(dragVector, shiftKey)
}

/** True when a displacement moves nothing (clicks stay off the undo stack). */
export function isMoveNoop(displacement: MovePoint, epsilon = 1e-9): boolean {
  const x = isFiniteMoveNumber(displacement?.x) ? displacement.x : 0
  const y = isFiniteMoveNumber(displacement?.y) ? displacement.y : 0
  return Math.abs(x) < epsilon && Math.abs(y) < epsilon
}

/**
 * Press-time Alt duplication gate. Typing hosts (inline text, inputs) never
 * duplicate: Alt there belongs to text input, not canvas cloning.
 */
export function shouldDuplicateOnPress(altKey: boolean, typing: boolean): boolean {
  return altKey === true && typing === false
}

/** Clamp one pointer coordinate into action bounds (per axis, inclusive). */
export function clampPointerIntoBounds(point: MovePoint, bounds: MoveRect): MovePoint {
  const x = isFiniteMoveNumber(point?.x) ? point.x : bounds.left
  const y = isFiniteMoveNumber(point?.y) ? point.y : bounds.top
  return {
    x: Math.max(bounds.left, Math.min(x, bounds.right)),
    y: Math.max(bounds.top, Math.min(y, bounds.bottom)),
  }
}

/** Bitmap action bounds: exactly the art board (0,0)-(960,720). */
export function bitmapActionBounds(): MoveRect {
  return { left: 0, top: 0, right: MOVE_ART_BOARD.width, bottom: MOVE_ART_BOARD.height }
}

/**
 * Vector action bounds: (view bounds united with the art board) intersected
 * with the max workspace. `viewBounds` is the live Paper view rect in Paper
 * units; callers pass `paper.view.bounds`. Pure min/max math, no Paper.js.
 */
export function vectorActionBounds(viewBounds: MoveRect): MoveRect {
  const art: MoveRect = { left: 0, top: 0, right: MOVE_ART_BOARD.width, bottom: MOVE_ART_BOARD.height }
  const united: MoveRect = {
    left: Math.min(viewBounds.left, art.left),
    top: Math.min(viewBounds.top, art.top),
    right: Math.max(viewBounds.right, art.right),
    bottom: Math.max(viewBounds.bottom, art.bottom),
  }
  return {
    left: Math.max(united.left, MOVE_MAX_WORKSPACE.left),
    top: Math.max(united.top, MOVE_MAX_WORKSPACE.top),
    right: Math.min(united.right, MOVE_MAX_WORKSPACE.right),
    bottom: Math.min(united.bottom, MOVE_MAX_WORKSPACE.bottom),
  }
}

/** Union of selection item bounds (empty input => undefined, like no snap). */
export function uniteSelectionBounds(rects: readonly MoveRect[]): MoveRect | undefined {
  let acc: MoveRect | undefined
  for (const rect of rects) {
    if (!rect || !isFiniteMoveNumber(rect.left) || !isFiniteMoveNumber(rect.top)) continue
    if (!isFiniteMoveNumber(rect.right) || !isFiniteMoveNumber(rect.bottom)) continue
    if (rect.right < rect.left || rect.bottom < rect.top) continue
    acc = acc
      ? {
          left: Math.min(acc.left, rect.left),
          top: Math.min(acc.top, rect.top),
          right: Math.max(acc.right, rect.right),
          bottom: Math.max(acc.bottom, rect.bottom),
        }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  }
  return acc
}

/** Center of a rect (selection center / bounds center). */
export function rectCenter(rect: MoveRect): MovePoint {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
}

/**
 * Drag-crosshair opacity for the moved selection bounds. Inside the bounds
 * the crosshair stays at full opacity; outside it fades linearly to 0 over
 * the fade distance (10 screen px / zoom). Corners use the radial gap to the
 * nearest corner; straight-above/below/left/right use the axial gap minus
 * the half extent. `movedCenter` is `selectionCenter + dragVector` (raw, not
 * snapped) because the reference measures the fade from the pointer-driven
 * position. Pure math, no layers.
 */
export function crosshairOpacityForBounds(
  movedBounds: MoveRect,
  movedCenter: MovePoint,
  artCenter: MovePoint = MOVE_ART_CENTER,
  fadePaper: number,
): number {
  if (!isFiniteMoveNumber(fadePaper) || fadePaper <= 0) return MOVE_CROSSHAIR_FULL_OPACITY
  const corner =
    (artCenter.y < movedBounds.top && artCenter.x < movedBounds.left) ||
    (artCenter.y > movedBounds.bottom && artCenter.x < movedBounds.left) ||
    (artCenter.y < movedBounds.top && artCenter.x > movedBounds.right) ||
    (artCenter.y > movedBounds.bottom && artCenter.x > movedBounds.right)
  let multiplier = 1
  if (corner) {
    const gapX = Math.max(artCenter.x - movedBounds.right, movedBounds.left - artCenter.x)
    const gapY = Math.max(artCenter.y - movedBounds.bottom, movedBounds.top - artCenter.y)
    const radial = Math.sqrt(gapX * gapX + gapY * gapY)
    multiplier = Math.max(0, 1 - radial / fadePaper)
  } else if (artCenter.y < movedBounds.top || artCenter.y > movedBounds.bottom) {
    const halfH = (movedBounds.bottom - movedBounds.top) / 2
    multiplier = Math.max(0, 1 - (Math.abs(artCenter.y - movedCenter.y) - halfH) / fadePaper)
  } else if (artCenter.x < movedBounds.left || artCenter.x > movedBounds.right) {
    const halfW = (movedBounds.right - movedBounds.left) / 2
    multiplier = Math.max(0, 1 - (Math.abs(artCenter.x - movedCenter.x) - halfW) / fadePaper)
  }
  return MOVE_CROSSHAIR_FULL_OPACITY * Math.max(0, Math.min(1, multiplier))
}

/**
 * Screen-constant budgets expressed in current-editor units.
 *
 * - vector SVG units: `svg = screenPx / (5 * viewportScale)`.
 * - bitmap canvas px: `px = screenPx / viewportScale` (fractional; callers
 *   truncate toward zero for the integer raster preview and accumulate the
 *   sub-pixel remainder, matching the documented high-zoom limitation).
 */
export function vectorUnitsForScreenPx(screenPx: number, viewportScale: number): number {
  if (!isFiniteMoveNumber(screenPx)) return 0
  return screenPx / (MOVE_VECTOR_WORKSPACE_SCALE * clampMoveViewportScale(viewportScale))
}

export function bitmapPxForScreenPx(screenPx: number, viewportScale: number): number {
  if (!isFiniteMoveNumber(screenPx)) return 0
  return screenPx / clampMoveViewportScale(viewportScale)
}

/** 4 screen-px snap budget in vector SVG units at this viewport scale. */
export function vectorSnapThresholdSvgUnits(viewportScale: number): number {
  return vectorUnitsForScreenPx(MOVE_SNAP_SCREEN_PX, viewportScale)
}

/** 10 screen-px fade distance in vector SVG units at this viewport scale. */
export function vectorFadeDistanceSvgUnits(viewportScale: number): number {
  return vectorUnitsForScreenPx(MOVE_FADE_SCREEN_PX, viewportScale)
}

/** 4 screen-px snap budget in bitmap canvas px at this viewport scale. */
export function bitmapSnapThresholdCanvasPx(viewportScale: number): number {
  return bitmapPxForScreenPx(MOVE_SNAP_SCREEN_PX, viewportScale)
}

/** 10 screen-px fade distance in bitmap canvas px at this viewport scale. */
export function bitmapFadeDistanceCanvasPx(viewportScale: number): number {
  return bitmapPxForScreenPx(MOVE_FADE_SCREEN_PX, viewportScale)
}

/** What a fixed SVG-unit tolerance really covers on screen (audit helper). */
export function fixedSvgToleranceToScreenPx(fixedSvgUnits: number, viewportScale: number): number {
  if (!isFiniteMoveNumber(fixedSvgUnits)) return 0
  return fixedSvgUnits * MOVE_VECTOR_WORKSPACE_SCALE * clampMoveViewportScale(viewportScale)
}

// EDITOR INTEGRATION GUIDE (no wiring here -- this module stays pure):
// 1. Vector move: after computing the raw client delta in SVG units, convert
//    the united selection center to the same space, call `resolveCenterSnap`
//    (skip when Shift or reshape-text editing), and move by the winning
//    `resolveItemDisplacement`. Clamp the pointer with `vectorActionBounds`
//    first; show a center crosshair with `crosshairOpacityForBounds` during
//    the drag (visible=true on first effective move, hidden on pointerup,
//    opacity updated per move). Record history only when the final
//    displacement is not a noop, mirroring the moved-flag rule.
// 2. Bitmap floating move: same snap/opacity math applies in canvas px via
//    `bitmapSnapThresholdCanvasPx` / `bitmapFadeDistanceCanvasPx`, but the
//    pointer clamp is `bitmapActionBounds` (art board only). Alt must become
//    press-time (`shouldDuplicateOnPress` at drag start, like vector), not
//    the current per-pointermove toggle, and Shift should project the delta
//    with `projectDeltaToStep` instead of moving freely.
// 3. Zoom: never reuse a fixed SVG-unit budget. Derive every grab/snap/fade
//    budget from screen px through `vectorUnitsForScreenPx` /
//    `bitmapPxForScreenPx` so the per-mode band stays visually constant
//    (vector 0.1332..5, res2 0.333..5, unknown 0.25..5). The Paper floor
//    0.333 maps per mode (0.333/2.5 = 0.1332 vector, 0.333 res2); the
//    projection clamp is the global minimum 0.1332 so the vector Paper
//    reset 0.2 maps exactly. Live drags prefer the measured surface scale
//    (`rect.width / canvas.width`, `4 / scale`) and only fall back here.
// 4. Do not copy reference sources: re-verify any newly wired numbers with
//    `test/move-snap-parity.test.ts` (real Paper.js oracle) and the browser
//    oracle before merging.
