// Costume viewport pure geometry for the current CSS transform.
//
// Observed current implementation (`BitmapEditor.svelte`, read-only here):
// the edit surface is an absolutely positioned box at `left: 50%; top: 50%`
// with
//
//   transform: translate(calc(-50% + <viewportX>px),
//                        calc(-50% + <viewportY>px)) scale(<viewportScale>)
//   transform-origin: center
//
// The parent (the `costume-paint-surface` node) is the viewport container.
// This module derives everything from that transform without touching the
// DOM, Paper.js, or any third-party paint source (clean-room math).
//
// Screen model (all units are CSS/screen px unless noted):
// - Let the surface be W x H (bitmap: 480*5 x 360*5 = 2400x1800; vector edit
//   surface uses the same 2400x1800 box). Let the container center be
//   C = (cx, cy) in client coordinates and the viewport be V = (vx, vy, s).
// - `translate(-50%, -50%)` centers the unscaled W x H box on the container
//   center; the `+ vx/vy` part then shifts that center to A = C + (vx, vy).
// - `scale(s)` with `transform-origin: center` expands around A, so the
//   surface rect is
//
//       left = Ax - W*s/2, top = Ay - H*s/2, width = W*s, height = H*s
//
//   and a surface point S maps to screen P as
//
//       P = A + (S - (W/2, H/2)) * s
//       S = (W/2, H/2) + (P - A) / s
//
// Consequences used below:
// - Panning in this system is a screen-px translation: moving the wheel by
//   (dx, dy) screen px means `vx -= dx, vy -= dy`. There is deliberately no
//   `/ zoom` division here. The reference Paper.js code divides by
//   `view.zoom` because `scrollBy` takes world units; the CSS offsets are
//   already screen px, so dividing would under-pan when zoomed in.
// - Pointer-fixed zoom keeps the surface point under the cursor: with the
//   anchor offset `a = P - C` and old/new scales `s -> s'`,
//
//       vx' = ax - (ax - vx) * s'/s
//
//   (equivalently `vx' = ax - (Sx - W/2) * s'`). The same holds for Y.
// - Hit tolerances must NOT reuse a fixed `0.5` SVG-unit constant. A fixed
//   SVG-unit value changes its on-screen size with both the artwork upscale
//   (x5 into the 2400x1800 surface) and the CSS `scale(s)`. Callers convert a
//   desired screen-px budget via `screenDeltaToSurfaceDelta` /
//   `surfaceDeltaToScreenDelta` (or `screenToleranceToSurfaceUnits`) so the
//   2400x1800 surface and the live CSS scale stay in the loop.

export type CostumeViewport = {
  /** Screen-px offset of the artwork center from the container center (translate X). */
  x: number
  /** Screen-px offset of the artwork center from the container center (translate Y). */
  y: number
  /** CSS `scale()` factor. Clamped to [MIN, MAX] on write. */
  scale: number
}

export type CostumeSurfaceSize = {
  width: number
  height: number
}

export type CostumePoint = {
  x: number
  y: number
}

/** Current `clampZoom` range in `BitmapEditor.svelte` (0.25x .. 5x). */
export const COSTUME_VIEWPORT_MIN_SCALE = 0.25
export const COSTUME_VIEWPORT_MAX_SCALE = 5
export const COSTUME_VIEWPORT_DEFAULT_SCALE = 1

/**
 * Per-mode Paper-reset viewport band (live behavior, Paper 0.5 reset basis).
 *
 * - vector (density 2.5 = 2400 surface / 960 Paper): reset 0.5/2.5 = 0.2,
 *   floor 0.333/2.5 ≈ 0.1332. At reset the 2400 surface renders 480 CSS px,
 *   exactly the Paper reset span (960 Paper units * 0.5).
 * - bitmap res2 (density 1.0 = 960 canvas / 960 Paper): reset 0.5 exact,
 *   floor 0.333 exact. At reset the 960 canvas renders 480 CSS px (same
 *   container width as the vector artboard at reset).
 * - bitmap res1 (density 0.5 = 480 canvas / 960 Paper): reset 0.5/0.5 = 1.0,
 *   floor 0.333/0.5 = 0.666... At reset the 480 canvas renders 480 CSS px
 *   (same container width; 1 canvas px = 2 Paper units because the reference
 *   VM loader doubles stored res1 PNG pixels/center to res2 before paint).
 * - unknown (no explicit stored resolution): legacy convention reset 1
 *   ("100%" = scale 1), floor 0.25. Canvas-width guessing is NOT used for
 *   the live path; without an explicit stored resolution the viewport stays
 *   on this legacy band (fail-closed, unknown only).
 */
export const COSTUME_VIEWPORT_VECTOR_MIN_SCALE = 0.333 / 2.5
export const COSTUME_VIEWPORT_VECTOR_RESET_SCALE = 0.5 / 2.5
export const COSTUME_VIEWPORT_BITMAP_RES2_MIN_SCALE = 0.333
export const COSTUME_VIEWPORT_BITMAP_RES2_RESET_SCALE = 0.5
export const COSTUME_VIEWPORT_BITMAP_RES1_MIN_SCALE = 0.333 / 0.5
export const COSTUME_VIEWPORT_BITMAP_RES1_RESET_SCALE = 0.5 / 0.5
export const COSTUME_VIEWPORT_UNKNOWN_RESET_SCALE = 1

/**
 * Global lowest minimum across all live bands (vector 0.333/2.5).
 * Pure surface<->screen mapping helpers clamp to `[GLOBAL_MIN, MAX]` (not
 * the legacy 0.25) so the vector reset 0.2 maps exactly instead of being
 * pushed to 0.25. UI-band enforcement (per-mode minima) lives in the
 * zoom-step/wheel/reset paths, not in the projection math.
 */
export const COSTUME_VIEWPORT_GLOBAL_MIN_SCALE = 0.333 / 2.5

/** Clamp for projection math: `[GLOBAL_MIN, MAX]`, non-finite => default 1. */
export function clampViewportScaleLenient(scale: number): number {
  if (!isFiniteNumber(scale)) return COSTUME_VIEWPORT_DEFAULT_SCALE
  return Math.max(COSTUME_VIEWPORT_GLOBAL_MIN_SCALE, Math.min(COSTUME_VIEWPORT_MAX_SCALE, scale))
}

/**
 * Minimum CSS scale for an explicit Paper-to-CSS density.
 * Valid densities (vector 2.5, res2 1.0) map the Paper floor 0.333 into CSS;
 * invalid/unknown densities fall back to the legacy UI minimum 0.25.
 */
export function viewportMinScaleForDensity(paperToCssDensity: number | undefined): number {
  const density = sanitizePaperToCssDensity(paperToCssDensity as number)
  if (density === undefined) return COSTUME_VIEWPORT_MIN_SCALE
  return Math.min(COSTUME_VIEWPORT_MAX_SCALE, Math.max(0.333 / density, 1e-9))
}

/**
 * Paper-reset CSS scale for an explicit density: `0.5 / density`.
 * Unknown densities return the legacy reset 1 (UI "100%" convention kept).
 * The result is clamped into `[minForDensity, max]` so vector 0.2 and res2
 * 0.5 are both live values (no representability gap: the band minimum moved
 * per mode instead of clamping the reset up to 0.25).
 */
export function viewportResetScaleForDensity(paperToCssDensity: number | undefined): number {
  const density = sanitizePaperToCssDensity(paperToCssDensity as number)
  if (density === undefined) return COSTUME_VIEWPORT_UNKNOWN_RESET_SCALE
  const min = viewportMinScaleForDensity(density)
  const reset = 0.5 / density
  if (!isFiniteNumber(reset)) return COSTUME_VIEWPORT_UNKNOWN_RESET_SCALE
  return Math.max(min, Math.min(COSTUME_VIEWPORT_MAX_SCALE, reset))
}

/** Clamp a scale into the per-density band. Non-finite maps to that band's reset. */
export function clampViewportScaleForDensity(scale: number, paperToCssDensity?: number): number {
  const min = viewportMinScaleForDensity(paperToCssDensity)
  if (!isFiniteNumber(scale)) return viewportResetScaleForDensity(paperToCssDensity)
  return Math.max(min, Math.min(COSTUME_VIEWPORT_MAX_SCALE, scale))
}

/**
 * Per-mode UI percent: `round(clampedScale / resetScale * 100)`.
 * Reset always reads "100%" (vector 0.2, res2 0.5, unknown 1); the internal
 * CSS scale is separated from the label. Unknown densities reproduce the
 * legacy `cssScaleToUiPercent` exactly.
 */
export function viewportUiPercentForDensity(scale: number, paperToCssDensity?: number): number {
  const reset = viewportResetScaleForDensity(paperToCssDensity)
  const clamped = clampViewportScaleForDensity(scale, paperToCssDensity)
  if (!isFiniteNumber(reset) || reset <= 0) return Math.round(clamped * 100)
  return Math.round((clamped / reset) * 100)
}

/**
 * Legacy ctrl-wheel sign-only factors (kept for audit history; the live
 * wheel path below uses the additive divisor instead).
 */
export const COSTUME_VIEWPORT_WHEEL_ZOOM_IN_FACTOR = 1.1
export const COSTUME_VIEWPORT_WHEEL_ZOOM_OUT_FACTOR = 0.9

/**
 * Legacy toolbar multiplicative factors (kept for audit history; the live
 * toolbar path uses the additive step instead).
 */
export const COSTUME_VIEWPORT_BUTTON_ZOOM_IN_FACTOR = 1.15
export const COSTUME_VIEWPORT_BUTTON_ZOOM_OUT_FACTOR = 0.85

/**
 * Toolbar additive step in CSS scale units (own derivation of the audited
 * reference pattern: buttons add/subtract a fixed amount while keeping a
 * selection-anchored point fixed, instead of multiplying).
 */
export const COSTUME_VIEWPORT_BUTTON_STEP = 0.5

/**
 * Zoom-in target when starting exactly at the minimum scale. Mirrors the
 * audited reference pattern where the first step out of the floor lands on
 * a mid level (there: 0.333 -> 0.5) rather than adding a full step.
 */
export const COSTUME_VIEWPORT_MIN_STEP_TARGET = 0.5

/** Ctrl-wheel additive divisor: `scale + (-deltaY / divisor)`. */
export const COSTUME_VIEWPORT_WHEEL_DIVISOR = 1000

/**
 * `WheelEvent.deltaMode === 1` (lines) multiplier. Matches the reference
 * scrollable-canvas handling (`deltaMode === 0x1 ? 15 : 1`, needed for
 * Firefox) so one line notch pans like ~15px. Page mode (`2`) is passed
 * through unscaled, like the reference.
 */
export const COSTUME_VIEWPORT_LINE_DELTA_MULTIPLIER = 15

/** Default edit-surface size (480x360 stage at 5x => 2400x1800). */
export const COSTUME_VIEWPORT_DEFAULT_SURFACE: CostumeSurfaceSize = {
  width: 2400,
  height: 1800,
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizeScale(scale: number): number {
  if (!isFiniteNumber(scale) || scale <= 0) return COSTUME_VIEWPORT_DEFAULT_SCALE
  return scale
}

function sanitizeSurface(surface: CostumeSurfaceSize): CostumeSurfaceSize {
  const width = isFiniteNumber(surface?.width) && surface.width > 0 ? surface.width : COSTUME_VIEWPORT_DEFAULT_SURFACE.width
  const height =
    isFiniteNumber(surface?.height) && surface.height > 0 ? surface.height : COSTUME_VIEWPORT_DEFAULT_SURFACE.height
  return { width, height }
}

function sanitizePoint(point: CostumePoint): CostumePoint {
  return {
    x: isFiniteNumber(point?.x) ? point.x : 0,
    y: isFiniteNumber(point?.y) ? point.y : 0,
  }
}

function sanitizeViewport(viewport: CostumeViewport): CostumeViewport {
  return {
    x: isFiniteNumber(viewport?.x) ? viewport.x : 0,
    y: isFiniteNumber(viewport?.y) ? viewport.y : 0,
    scale: sanitizeScale(viewport?.scale),
  }
}

/** Clamp a scale into the UI range. Non-finite input maps to the default. */
export function clampViewportScale(scale: number): number {
  if (!isFiniteNumber(scale)) return COSTUME_VIEWPORT_DEFAULT_SCALE
  return Math.max(COSTUME_VIEWPORT_MIN_SCALE, Math.min(COSTUME_VIEWPORT_MAX_SCALE, scale))
}

/** Normalize one wheel delta into screen px (line mode x15). Non-finite => 0. */
export function normalizeWheelDelta(delta: number, deltaMode: number): number {
  if (!isFiniteNumber(delta)) return 0
  if (deltaMode === 1) return delta * COSTUME_VIEWPORT_LINE_DELTA_MULTIPLIER
  return delta
}

/** Normalize both wheel axes into screen px. */
export function normalizeWheelDeltas(wheel: { deltaX: number; deltaY: number; deltaMode: number }): {
  dx: number
  dy: number
} {
  return {
    dx: normalizeWheelDelta(wheel.deltaX, wheel.deltaMode),
    dy: normalizeWheelDelta(wheel.deltaY, wheel.deltaMode),
  }
}

/**
 * Legacy sign-only ctrl-wheel factor (audit history; not used by the live
 * wheel path, which is magnitude-proportional via `wheelZoomAdditiveScale`).
 */
export function wheelZoomFactorForDeltaY(normalizedDeltaY: number): number | undefined {
  if (!isFiniteNumber(normalizedDeltaY) || normalizedDeltaY === 0) return undefined
  return normalizedDeltaY > 0
    ? COSTUME_VIEWPORT_WHEEL_ZOOM_OUT_FACTOR
    : COSTUME_VIEWPORT_WHEEL_ZOOM_IN_FACTOR
}

/**
 * Toolbar-equivalent additive step: `scale +/- 0.5`, clamped to the UI band.
 * From exactly the minimum, zooming in lands on 0.5 (the audited
 * floor-exit pattern) instead of adding a full step.
 */
export function buttonZoomStepAdditive(scale: number, direction: 1 | -1): number {
  const base = clampViewportScale(scale)
  const next = direction > 0 && base === COSTUME_VIEWPORT_MIN_SCALE
    ? COSTUME_VIEWPORT_MIN_STEP_TARGET
    : base + direction * COSTUME_VIEWPORT_BUTTON_STEP
  if (!isFiniteNumber(next)) return direction > 0 ? COSTUME_VIEWPORT_MAX_SCALE : COSTUME_VIEWPORT_MIN_SCALE
  return clampViewportScale(next)
}

/**
 * Ctrl-wheel additive gain: `scale + (-normalizedDeltaY / 1000)`, clamped to
 * the UI band. Small trackpad deltas give small steps; one classic
 * -100 tick gives +0.1. Non-finite/zero input returns the clamped current
 * scale (no-op).
 */
export function wheelZoomAdditiveScale(scale: number, normalizedDeltaY: number): number {
  const base = clampViewportScale(scale)
  if (!isFiniteNumber(normalizedDeltaY) || normalizedDeltaY === 0) return base
  const next = base + -normalizedDeltaY / COSTUME_VIEWPORT_WHEEL_DIVISOR
  if (!isFiniteNumber(next)) {
    return normalizedDeltaY < 0 ? COSTUME_VIEWPORT_MAX_SCALE : COSTUME_VIEWPORT_MIN_SCALE
  }
  return clampViewportScale(next)
}

/**
 * Paper-to-CSS density: surface px per 1 Paper unit (`W / Pw`).
 *
 * Own derivation from the actual-size formula in `paper-viewport-parity.ts`
 * (`cssPxPerPaperUnit = (W / Pw) * s`, so at scale 1 the density IS `W / Pw`):
 * a CSS scale step `deltaCss` adds `deltaCss * density` screen px per Paper
 * unit, while a Scratch Paper step adds its own numeric value by definition
 * (button +0.5, ctrl-wheel `-deltaY / 1000`). Parity therefore needs
 * `deltaCss = deltaPaper / density`.
 *
 * Source-grounded densities (explicit argument, all decided):
 * - vector 2400 surface for the 960-unit Paper board => 2.5 [A3]
 *   (480 SVG units x5 surface, 1 SVG unit = 2 Paper units via the 2x import).
 * - bitmap res2 960 canvas for the 960-unit board => 1.0 [確実 res2].
 * - bitmap res1 480 canvas for the 960-unit board => 0.5 (decided: stored
 *   res1 kept non-destructively while the reference loader doubles res1
 *   pixels/center to res2 before paint, so 1 canvas px = 2 Paper units).
 *   An invalid density still fails closed to a no-op (see below).
 *
 * `density = 1` reproduces the legacy direct-copy behavior exactly
 * (`buttonZoomStepAdditive` / `wheelZoomAdditiveScale`), so existing callers
 * (`BitmapEditor.svelte`, still wired to the legacy helpers) keep working
 * until the follow-up wiring passes per-mode densities. That wiring is
 * intentionally NOT done here.
 */
export function sanitizePaperToCssDensity(density: number): number | undefined {
  if (!isFiniteNumber(density) || density <= 0) return undefined
  return density
}

/**
 * Convert a Paper-unit step into a CSS scale step for the given density:
 * `cssStep = paperStep / density`. Fail-closed to 0 (caller treats 0 as
 * "no step") when either input is non-finite or the density is not a
 * positive finite number -- no silent `1.0` assumption for unknown bitmap
 * densities.
 */
export function cssScaleStepForPaperStep(paperStep: number, paperToCssDensity: number): number {
  if (!isFiniteNumber(paperStep)) return 0
  const density = sanitizePaperToCssDensity(paperToCssDensity)
  if (density === undefined) return 0
  const step = paperStep / density
  return isFiniteNumber(step) ? step : 0
}

/**
 * Convert a CSS scale step back into Paper units for the given density:
 * `paperStep = cssStep * density`. Same fail-closed 0 contract. Tests use
 * this to measure the per-Paper-unit gain of a density-aware gesture.
 */
export function paperStepForCssScaleStep(cssStep: number, paperToCssDensity: number): number {
  if (!isFiniteNumber(cssStep)) return 0
  const density = sanitizePaperToCssDensity(paperToCssDensity)
  if (density === undefined) return 0
  const step = cssStep * density
  return isFiniteNumber(step) ? step : 0
}

/**
 * Density-aware toolbar step: `scale +/- (0.5 / density)`, clamped to the UI
 * band. The `0.5` numerator is the audited Paper button increment
 * (`PAPER_ZOOM_INCREMENT`); dividing by the explicit density converts the
 * true Paper screen-px/unit gain into CSS scale units.
 *
 * Band/bounds contract (unchanged from `buttonZoomStepAdditive`):
 * - from exactly the minimum, zooming in lands on
 *   `COSTUME_VIEWPORT_MIN_STEP_TARGET` (0.5) rather than adding a partial
 *   step. This floor-exit target is a UI-band rule mirroring the audited
 *   floor pattern (there: 0.333 -> 0.5), NOT a Paper-gain conversion, so it
 *   stays density-independent.
 * - ceiling/floor clamp to [0.25, 5]; non-finite scale falls back through
 *   `clampViewportScale` (default 1); invalid density (non-finite / <= 0)
 *   fails closed to the clamped current scale (no step, no assumption).
 */
export function buttonZoomStepForPaperDensity(
  scale: number,
  direction: 1 | -1,
  paperToCssDensity: number,
): number {
  const density = sanitizePaperToCssDensity(paperToCssDensity)
  if (density === undefined) return clampViewportScale(scale)
  // Per-mode Paper band: base clamped to [floorForDensity, 5], floor-exit
  // lands on the Paper reset (0.5/density), NOT the legacy 0.5 UI target.
  // vector 0.1332 -> 0.2; res2 0.333 -> 0.5; unknown keeps legacy via early return.
  const base = clampViewportScaleForDensity(scale, density)
  const min = viewportMinScaleForDensity(density)
  const reset = viewportResetScaleForDensity(density)
  if (direction > 0 && base === min) return reset
  const step = cssScaleStepForPaperStep(COSTUME_VIEWPORT_BUTTON_STEP, density)
  const next = base + direction * step
  if (!isFiniteNumber(next)) return direction > 0 ? COSTUME_VIEWPORT_MAX_SCALE : min
  return clampViewportScaleForDensity(next, density)
}

/**
 * Vector Paper-to-CSS density for the live edit surface [A3].
 *
 * The vector edit surface is the fixed 2400x1800 workspace box (480x360 stage
 * at 5x). It stands for the 960x720 Paper board, so 1 Paper unit covers
 * `2400 / 960 = 2.5` surface px at CSS scale 1. One Scratch Paper button step
 * (+0.5 Paper units) is therefore `0.5 / 2.5 = +0.2` CSS scale units, and one
 * classic ctrl-wheel -100 tick (+0.1 Paper units) is `+0.04` CSS units.
 */
export const VECTOR_PAPER_TO_CSS_DENSITY = 2400 / 960 // 2.5 [A3]

/**
 * Bitmap res2 Paper-to-CSS density [確実].
 *
 * Sprite res2 canvas 960x720 stands for the 960x720 Paper board verbatim
 * (1 canvas px = 1 Paper unit: Scratch draws res2 content pixel-verbatim
 * onto the 960x720 raster at `(ART_BOARD/2 - rotationCenter)`, and this repo
 * places stored sources verbatim via `bitmap-artboard.ts`).
 *
 * At this density the Paper button/wheel gains reproduce the legacy
 * direct-copy behavior exactly (+0.5 CSS = +0.5 Paper, -100 tick +0.1 CSS =
 * +0.1 Paper), so wiring it is behavior-preserving while making the parity
 * explicit and testable.
 */
export const BITMAP_RES2_PAPER_TO_CSS_DENSITY = 960 / 960 // 1.0 [確実 res2]

/**
 * Bitmap res1 Paper-to-CSS density (decided).
 *
 * Stored res1 is kept non-destructively (480x360 canvas, center 240,180)
 * while the reference VM loader doubles stored res1 PNG pixels and the
 * rotation center to res2 before paint, so the live paint board stays the
 * 960x720 Paper board. Hence 1 canvas px = 2 Paper units:
 * density = 480 canvas / 960 Paper = 0.5. Paper reset 0.5 -> CSS 1.0,
 * floor 0.333 -> CSS 0.666..., button +/-0.5 -> +/-1.0 CSS,
 * classic -100 wheel tick (+0.1 Paper) -> +0.2 CSS.
 */
export const BITMAP_RES1_PAPER_TO_CSS_DENSITY = 480 / 960 // 0.5 (decided)

/** Bitmap res1 effective reset/floor (constants for wiring + tests). */
export const BITMAP_RES1_PAPER_RESET_CSS_EFFECTIVE = 0.5 / 0.5 // 1.0
export const BITMAP_RES1_PAPER_FLOOR_CSS_EFFECTIVE = 0.333 / 0.5 // 0.666...

/**
 * Density for the live bitmap path from the EXPLICIT stored resolution only.
 * Pass the costume's stored `bitmapResolution` (2 => 1.0, 1 => 0.5, anything
 * else => undefined). Canvas-width guessing is deliberately NOT done here:
 * without an explicit stored resolution the caller stays `unknown`
 * (legacy band). `densityForBitmapCanvas` below keeps the width heuristic
 * for audit/tests only; live wiring must use this function.
 */
export function densityForBitmapStoredResolution(storedResolution?: number): number | undefined {
  if (!isFiniteNumber(storedResolution)) return undefined
  if (storedResolution === 2) return BITMAP_RES2_PAPER_TO_CSS_DENSITY
  if (storedResolution === 1) return BITMAP_RES1_PAPER_TO_CSS_DENSITY
  return undefined
}

/**
 * Classify a live bitmap canvas width into res2 vs res1 vs unknown.
 * Sprite/stage artboards are 480 stage-units wide: res2 = 960 canvas px
 * (2px/unit), res1 = 480 canvas px (1px/unit). Union-expanded canvases keep
 * the stored resolution, so width alone is a heuristic; callers pass the
 * stored resolution when known. Returns 'res2' only for the canonical
 * 960-wide (or wider res2-union) canvas, 'res1' for the 480-wide canvas,
 * 'unknown' otherwise (fail closed to legacy).
 */
export function classifyBitmapCanvasResolution(canvasWidth: number): 'res2' | 'res1' | 'unknown' {
  if (!isFiniteNumber(canvasWidth) || canvasWidth <= 0) return 'unknown'
  // 480-wide res1 family vs 960-wide res2 family (union workspaces only grow,
  // never shrink below artboard). Mid-gap widths stay 'unknown' (fail closed).
  if (canvasWidth >= 720) return 'res2'
  if (canvasWidth <= 600) return 'res1'
  return 'unknown'
}

/**
 * Density for a live bitmap canvas width: 1.0 for res2, 0.5 for res1
 * (decided: 480 canvas px stand for the 960-unit Paper board), undefined
 * for unknown (fail closed to the legacy direct-copy path). The stored
 * resolution, when known, wins over the width heuristic.
 */
export function densityForBitmapCanvas(canvasWidth: number, storedResolution?: number): number | undefined {
  if (isFiniteNumber(storedResolution)) {
    if (storedResolution === 2) return BITMAP_RES2_PAPER_TO_CSS_DENSITY
    if (storedResolution === 1) return BITMAP_RES1_PAPER_TO_CSS_DENSITY
    return undefined
  }
  const kind = classifyBitmapCanvasResolution(canvasWidth)
  if (kind === 'res2') return BITMAP_RES2_PAPER_TO_CSS_DENSITY
  if (kind === 'res1') return BITMAP_RES1_PAPER_TO_CSS_DENSITY
  return undefined
}

/**
 * Real Paper floor/reset normalized to CSS at the vector density
 * (theoretical values, BEFORE the per-mode band clamp).
 *
 * - Paper floor 0.333 (OUTERMOST_ZOOM_LEVEL) -> 0.333 / 2.5 = ~0.1332 CSS.
 * - Paper reset 0.5 -> 0.5 / 2.5 = 0.2 CSS.
 *
 * The live band is per-mode (see `viewportMinScaleForDensity`): vector
 * 0.1332..5, res2 0.333..5, unknown 0.25..5. The old 0.25 global minimum
 * produced a representability gap (reset 0.2 clamped to 0.25); the per-mode
 * band removes it so the live reset IS the Paper reset. The floor-exit
 * special is per-mode too (floor -> reset), mirroring the audited
 * 0.333 -> 0.5 pattern at each density.
 * Boundary behavior is fail-safe: scaled steps clamp to the per-density
 * band, the fixed-point pin holds at the clamp, and non-finite inputs are
 * no-ops (pinned by the boundary tests below).
 */
export const VECTOR_PAPER_FLOOR_CSS_THEORETICAL = 0.333 / VECTOR_PAPER_TO_CSS_DENSITY
export const VECTOR_PAPER_RESET_CSS_THEORETICAL = 0.5 / VECTOR_PAPER_TO_CSS_DENSITY
export const VECTOR_PAPER_FLOOR_CSS_CLAMPED = 0.333 / VECTOR_PAPER_TO_CSS_DENSITY // per-mode band minimum (0.1332)

/**
 * Paper-normalized reset/floor in CSS scale units for an explicit density.
 *
 * Theoretical (pre-clamp): `PAPER_RESET_ZOOM (0.5) / density` and
 * `PAPER_OUTERMOST (0.333) / density`. Effective: clamped into the
 * PER-MODE band `[floorForDensity, 5]` (the expansion ceiling 5 is kept
 * as-is: Scratch is unbounded above, so the ceiling is OUR safety bound,
 * 明記; see also `PAPER_ZOOM_SAFE_MAX` in paper-viewport-parity.ts).
 *
 * - vector (2.5): reset 0.2 effective, floor 0.1332 effective (both exact,
 *   no gap: the band minimum moved per mode).
 * - bitmap res2 (1.0): reset 0.5 -> effective 0.5 (exact); floor 0.333 ->
 *   effective 0.333 (exact).
 * - bitmap res1 (0.5): reset 0.5/0.5 = 1.0 effective; floor 0.333/0.5 =
 *   0.666... effective (both exact on the res1 band 0.666...5).
 * - unknown density: undefined input fails closed to undefined (no silent
 *   coefficient).
 *
 * The live `resetViewport()` in BitmapEditor.svelte uses these effective
 * values per mode (vector 0.2 / res2 0.5 / res1 1.0 / unknown 1). The UI label is the
 * per-mode percent (`viewportUiPercentForDensity`: reset always "100%"),
 * so internal scale and the "100%" display are separated (see
 * `cssScaleToUiPercent` for the legacy unknown-only form).
 */
export function paperResetCssTheoretical(paperToCssDensity: number): number | undefined {
  const density = sanitizePaperToCssDensity(paperToCssDensity)
  if (density === undefined) return undefined
  return 0.5 / density
}

export function paperFloorCssTheoretical(paperToCssDensity: number): number | undefined {
  const density = sanitizePaperToCssDensity(paperToCssDensity)
  if (density === undefined) return undefined
  return 0.333 / density
}

export function paperResetCssEffective(paperToCssDensity: number): number | undefined {
  const theoretical = paperResetCssTheoretical(paperToCssDensity)
  if (theoretical === undefined) return undefined
  return clampViewportScaleForDensity(theoretical, paperToCssDensity)
}

export function paperFloorCssEffective(paperToCssDensity: number): number | undefined {
  const theoretical = paperFloorCssTheoretical(paperToCssDensity)
  if (theoretical === undefined) return undefined
  return clampViewportScaleForDensity(theoretical, paperToCssDensity)
}

/** Vector effective reset/floor (constants for wiring + tests). */
export const VECTOR_PAPER_RESET_CSS_EFFECTIVE = 0.5 / VECTOR_PAPER_TO_CSS_DENSITY // 0.2
export const VECTOR_PAPER_FLOOR_CSS_EFFECTIVE = 0.333 / VECTOR_PAPER_TO_CSS_DENSITY // ~0.1332

/** Bitmap res2 effective reset/floor (constants for wiring + tests). */
export const BITMAP_RES2_PAPER_RESET_CSS_EFFECTIVE = 0.5 // paperResetCssEffective(1.0)
export const BITMAP_RES2_PAPER_FLOOR_CSS_EFFECTIVE = 0.333 // paperFloorCssEffective(1.0)

/**
 * Existing UI percent notation: `Math.round(scale * 100)%`.
 * `scale = 1` reads "100%" (legacy unknown-band convention). Live modes use
 * `viewportUiPercentForDensity` (reset always "100%"); this helper stays as
 * the unknown/legacy form (`viewportUiPercentForDensity(scale, undefined)`).
 */
export function cssScaleToUiPercent(scale: number): number {
  return Math.round(clampViewportScale(scale) * 100)
}

/**
 * Density-aware ctrl-wheel gain:
 * `scale + ((-normalizedDeltaY / 1000) / density)`, clamped to the
 * per-density band. The numerator is the audited Paper wheel gain; the
 * caller still expands line-mode deltas x15 via `normalizeWheelDelta`
 * before passing `normalizedDeltaY` (unchanged). One classic -100 tick at
 * density 2.5 gives +0.04 CSS (Paper gain 0.1); at density 1 it gives
 * +0.1 CSS. Zero/non-finite delta returns the per-density clamped current
 * scale (no-op); invalid density fails closed the same way.
 */
export function wheelZoomForPaperDensity(
  scale: number,
  normalizedDeltaY: number,
  paperToCssDensity: number,
): number {
  const density = sanitizePaperToCssDensity(paperToCssDensity)
  if (density === undefined) return clampViewportScale(scale)
  const base = clampViewportScaleForDensity(scale, density)
  if (!isFiniteNumber(normalizedDeltaY) || normalizedDeltaY === 0) return base
  const paperGain = -normalizedDeltaY / COSTUME_VIEWPORT_WHEEL_DIVISOR
  const cssGain = cssScaleStepForPaperStep(paperGain, density)
  const next = base + cssGain
  if (!isFiniteNumber(next)) {
    return normalizedDeltaY < 0 ? COSTUME_VIEWPORT_MAX_SCALE : viewportMinScaleForDensity(density)
  }
  return clampViewportScaleForDensity(next, density)
}

/**
 * Map a surface point (0..W, 0..H) to client coordinates.
 * `containerCenter` is the viewport container's client center
 * (`viewportNode.getBoundingClientRect()` center).
 */
export function surfaceToScreen(
  surfacePoint: CostumePoint,
  surface: CostumeSurfaceSize,
  containerCenter: CostumePoint,
  viewport: CostumeViewport,
): CostumePoint {
  const safeSurface = sanitizeSurface(surface)
  const safeCenter = sanitizePoint(containerCenter)
  const safeViewport = sanitizeViewport(viewport)
  const safePoint = sanitizePoint(surfacePoint)
  const scale = clampViewportScaleLenient(safeViewport.scale)
  return {
    x: safeCenter.x + safeViewport.x + (safePoint.x - safeSurface.width / 2) * scale,
    y: safeCenter.y + safeViewport.y + (safePoint.y - safeSurface.height / 2) * scale,
  }
}

/**
 * Map client coordinates back to surface coordinates (0..W, 0..H, unbounded
 * so off-artwork positions stay meaningful for clamping checks).
 */
export function screenToSurface(
  screenPoint: CostumePoint,
  surface: CostumeSurfaceSize,
  containerCenter: CostumePoint,
  viewport: CostumeViewport,
): CostumePoint {
  const safeSurface = sanitizeSurface(surface)
  const safeCenter = sanitizePoint(containerCenter)
  const safeViewport = sanitizeViewport(viewport)
  const safePoint = sanitizePoint(screenPoint)
  const scale = clampViewportScaleLenient(safeViewport.scale)
  return {
    x: safeSurface.width / 2 + (safePoint.x - safeCenter.x - safeViewport.x) / scale,
    y: safeSurface.height / 2 + (safePoint.y - safeCenter.y - safeViewport.y) / scale,
  }
}

/**
 * Predict the surface element's client rect from the same inputs the style
 * binding uses. Lets tests compare the pure model against a measured
 * `getBoundingClientRect()` without mounting the editor.
 */
export function predictSurfaceRect(
  surface: CostumeSurfaceSize,
  containerCenter: CostumePoint,
  viewport: CostumeViewport,
): { left: number; top: number; width: number; height: number } {
  const safeSurface = sanitizeSurface(surface)
  const safeCenter = sanitizePoint(containerCenter)
  const safeViewport = sanitizeViewport(viewport)
  const scale = clampViewportScaleLenient(safeViewport.scale)
  const width = safeSurface.width * scale
  const height = safeSurface.height * scale
  return {
    left: safeCenter.x + safeViewport.x - width / 2,
    top: safeCenter.y + safeViewport.y - height / 2,
    width,
    height,
  }
}

/** Surface-px delta => screen-px delta (multiply by the live scale). */
export function surfaceDeltaToScreenDelta(deltaSurface: number, scale: number): number {
  if (!isFiniteNumber(deltaSurface)) return 0
  return deltaSurface * clampViewportScaleLenient(scale)
}

/** Screen-px delta => surface-px delta (divide by the live scale). */
export function screenDeltaToSurfaceDelta(deltaScreen: number, scale: number): number {
  if (!isFiniteNumber(deltaScreen)) return 0
  return deltaScreen / clampViewportScaleLenient(scale)
}

/**
 * Convert a desired on-screen tolerance (px) into surface units.
 * `cssPixelsPerSurfaceUnit` is the layout upscale before the viewport scale
 * (1 for the 2400x1800 bitmap surface where 1 surface px == 1 css px;
 * 5 for vector SVG units mapped through `VECTOR_WORKSPACE_SCALE`).
 * This is the zoom-aware replacement for reusing a fixed `0.5` constant.
 */
export function screenToleranceToSurfaceUnits(
  desiredScreenPx: number,
  viewportScale: number,
  cssPixelsPerSurfaceUnit = 1,
): number {
  if (!isFiniteNumber(desiredScreenPx)) return 0
  const perUnit = isFiniteNumber(cssPixelsPerSurfaceUnit) && cssPixelsPerSurfaceUnit > 0 ? cssPixelsPerSurfaceUnit : 1
  return desiredScreenPx / (clampViewportScaleLenient(viewportScale) * perUnit)
}

export type FixedPointZoomResult = {
  viewport: CostumeViewport
  /** Scale actually applied after clamping. */
  appliedScale: number
  /** `appliedScale / previousScale`. */
  appliedFactor: number
  /** True when the requested scale hit the [0.25, 5] clamp. */
  clamped: boolean
}

/**
 * Zoom while keeping the surface point under `screenPoint` fixed on screen.
 * The pointer stays within floating-point round-off (tests assert < 1px);
 * when the scale clamps, the translation still uses the clamped scale so the
 * fixed point holds at the boundary too.
 */
export function zoomViewportAtScreenPoint(
  viewport: CostumeViewport,
  surface: CostumeSurfaceSize,
  containerCenter: CostumePoint,
  screenPoint: CostumePoint,
  factor: number,
  paperToCssDensity?: number,
): FixedPointZoomResult {
  const safeViewport = sanitizeViewport(viewport)
  const safeSurface = sanitizeSurface(surface)
  const safeCenter = sanitizePoint(containerCenter)
  const safeScreen = sanitizePoint(screenPoint)
  const density = sanitizePaperToCssDensity(paperToCssDensity as number)
  const clampForMode =
    density === undefined ? clampViewportScale : (value: number) => clampViewportScaleForDensity(value, density)
  const previousScale = clampForMode(safeViewport.scale)
  if (!isFiniteNumber(factor) || factor <= 0) {
    return { viewport: { ...safeViewport, scale: previousScale }, appliedScale: previousScale, appliedFactor: 1, clamped: false }
  }
  const requested = previousScale * factor
  const appliedScale = clampForMode(requested)
  const clamped = appliedScale !== requested
  // Surface point under the cursor before the zoom.
  const fixedSurface = screenToSurface(
    safeScreen,
    safeSurface,
    safeCenter,
    { x: safeViewport.x, y: safeViewport.y, scale: previousScale },
  )
  // Re-anchor so the same surface point maps back to the same screen point.
  const x = safeScreen.x - safeCenter.x - (fixedSurface.x - safeSurface.width / 2) * appliedScale
  const y = safeScreen.y - safeCenter.y - (fixedSurface.y - safeSurface.height / 2) * appliedScale
  return {
    viewport: { x, y, scale: appliedScale },
    appliedScale,
    appliedFactor: appliedScale / previousScale,
    clamped,
  }
}

/**
 * Core fixed-point zoom taking the anchor as an offset from the container
 * center (`anchorOffset = screenPoint - containerCenter`). Pure wrapper over
 * `zoomViewportAtScreenPoint` for callers that already track the offset.
 */
export function zoomViewportAtAnchorOffset(
  viewport: CostumeViewport,
  surface: CostumeSurfaceSize,
  anchorOffset: CostumePoint,
  factor: number,
): FixedPointZoomResult {
  const safeAnchor = sanitizePoint(anchorOffset)
  return zoomViewportAtScreenPoint(
    viewport,
    surface,
    { x: 0, y: 0 },
    { x: safeAnchor.x, y: safeAnchor.y },
    factor,
  )
}

/**
 * Zoom about a surface-space anchor (e.g. a selection center) while keeping
 * that anchor on the same screen pixel. Single fixed-point path: converts
 * the surface anchor to its screen position, then reuses
 * `zoomViewportAtScreenPoint` with `nextScale / previousScale`. Callers pass
 * the additive `nextScale` (button `+/-0.5`, wheel `+(-dy/1000)`); the factor
 * derivation and clamping stay in one place so the pin holds at the band
 * edges too.
 *
 * When `paperToCssDensity` is provided, both the previous and next scales
 * clamp to the per-density band (vector 0.1332..5, res2 0.333..5, res1
 * 0.666...5) instead of the legacy 0.25..5, so the Paper reset/floor stay
 * fixed points. Without a density the legacy band is kept (unknown
 * fail-closed).
 */
export function zoomViewportAtSurfacePoint(
  viewport: CostumeViewport,
  surface: CostumeSurfaceSize,
  containerCenter: CostumePoint,
  surfacePoint: CostumePoint,
  nextScale: number,
  paperToCssDensity?: number,
): FixedPointZoomResult {
  const safeViewport = sanitizeViewport(viewport)
  const safeSurface = sanitizeSurface(surface)
  const safeCenter = sanitizePoint(containerCenter)
  const safeAnchor = sanitizePoint(surfacePoint)
  const density = sanitizePaperToCssDensity(paperToCssDensity as number)
  const clampForMode = (value: number): number =>
    density === undefined ? clampViewportScale(value) : clampViewportScaleForDensity(value, density)
  const previousScale = clampForMode(safeViewport.scale)
  const appliedScale = clampForMode(nextScale)
  if (!isFiniteNumber(nextScale) || appliedScale <= 0 || previousScale <= 0) {
    return { viewport: { ...safeViewport, scale: previousScale }, appliedScale: previousScale, appliedFactor: 1, clamped: false }
  }
  const screenPoint = surfaceToScreen(
    safeAnchor,
    safeSurface,
    safeCenter,
    { x: safeViewport.x, y: safeViewport.y, scale: previousScale },
  )
  return zoomViewportAtScreenPoint(
    { x: safeViewport.x, y: safeViewport.y, scale: previousScale },
    safeSurface,
    safeCenter,
    screenPoint,
    appliedScale / previousScale,
    paperToCssDensity,
  )
}

/** Pan by screen-px deltas (wheel deltas already normalized to screen px). */
export function panViewport(viewport: CostumeViewport, dxScreen: number, dyScreen: number): CostumeViewport {
  const safeViewport = sanitizeViewport(viewport)
  const dx = isFiniteNumber(dxScreen) ? dxScreen : 0
  const dy = isFiniteNumber(dyScreen) ? dyScreen : 0
  return {
    x: safeViewport.x - dx,
    y: safeViewport.y - dy,
    scale: clampViewportScaleLenient(safeViewport.scale),
  }
}

export type WheelLike = {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

export type WheelViewportContext = {
  surface?: CostumeSurfaceSize
  /** Viewport container's client center. Required for the zoom branch. */
  containerCenter?: CostumePoint
  /** Client position of the pointer. Required for the zoom branch. */
  screenPoint?: CostumePoint
}

export type WheelViewportResolution =
  | {
      kind: 'zoom'
      viewport: CostumeViewport
      factor: number
      clamped: boolean
      normalizedDeltaY: number
    }
  | {
      kind: 'pan'
      viewport: CostumeViewport
      dx: number
      dy: number
      horizontalShift: boolean
    }
  | { kind: 'none'; viewport: CostumeViewport }

/**
 * Resolve one wheel tick into a viewport update for the CSS transform.
 *
 * - ctrl/meta: pointer-fixed additive zoom
 *   (`next = scale + (-normalizedDeltaY / 1000)`, clamped to 0.25..5, so a
 *   classic -100 tick is +0.1 and small trackpad deltas give small steps).
 *   Needs `containerCenter` and `screenPoint`; without finite values it falls
 *   back to a centered zoom so the scale still tracks the gesture instead of
 *   dropping it. `deltaY == 0` is a no-op.
 * - shift with `deltaX == 0`: horizontal pan from the vertical delta
 *   (covers trackpads/mice that never set `deltaX`).
 * - otherwise: two-dimensional pan. Both pan branches use line-normalized
 *   screen-px deltas (`deltaMode === 1` x15) and keep `scale` unchanged.
 */
export function resolveWheelViewport(
  viewport: CostumeViewport,
  wheel: WheelLike,
  context: WheelViewportContext = {},
): WheelViewportResolution {
  const safeViewport = sanitizeViewport(viewport)
  const base: CostumeViewport = {
    x: safeViewport.x,
    y: safeViewport.y,
    scale: clampViewportScale(safeViewport.scale),
  }
  const ctrl = wheel.ctrlKey === true || wheel.metaKey === true
  const shift = wheel.shiftKey === true
  const { dx, dy } = normalizeWheelDeltas({
    deltaX: wheel.deltaX,
    deltaY: wheel.deltaY,
    deltaMode: wheel.deltaMode,
  })

  if (ctrl) {
    if (!isFiniteNumber(dy) || dy === 0) return { kind: 'none', viewport: base }
    const requested = base.scale + -dy / COSTUME_VIEWPORT_WHEEL_DIVISOR
    const appliedScale = wheelZoomAdditiveScale(base.scale, dy)
    const clamped = appliedScale !== requested
    const factor = appliedScale / base.scale
    const surface = sanitizeSurface(
      context.surface ?? { ...COSTUME_VIEWPORT_DEFAULT_SURFACE },
    )
    const center = context.containerCenter
    const point = context.screenPoint
    if (center && point && isFiniteNumber(center.x) && isFiniteNumber(center.y) && isFiniteNumber(point.x) && isFiniteNumber(point.y)) {
      const zoomed = zoomViewportAtScreenPoint(base, surface, center, point, factor)
      return {
        kind: 'zoom',
        viewport: zoomed.viewport,
        factor: zoomed.appliedFactor,
        clamped: zoomed.clamped,
        normalizedDeltaY: dy,
      }
    }
    // Fallback: keep the scale gesture, anchor at the artwork center.
    return {
      kind: 'zoom',
      viewport: { x: base.x, y: base.y, scale: appliedScale },
      factor,
      clamped,
      normalizedDeltaY: dy,
    }
  }

  if (shift && dx === 0 && dy !== 0) {
    return {
      kind: 'pan',
      viewport: panViewport(base, dy, 0),
      dx: dy,
      dy: 0,
      horizontalShift: true,
    }
  }

  if (dx === 0 && dy === 0) return { kind: 'none', viewport: base }
  return {
    kind: 'pan',
    viewport: panViewport(base, dx, dy),
    dx,
    dy,
    horizontalShift: false,
  }
}

/**
 * Density-aware wheel resolver for the Paper-parity path (vector + res2 + res1).
 *
 * Same branching as `resolveWheelViewport` (ctrl/meta pointer-fixed zoom,
 * shift horizontal pan, plain 2D pan, line-mode x15 via
 * `normalizeWheelDeltas`), but the zoom gain is
 * `(-normalizedDeltaY / 1000) / density` via `wheelZoomForPaperDensity`,
 * clamped to the per-density band (vector 0.1332..5, res2 0.333..5, res1
 * 0.666...5). The pointer-fixed pin (`zoomViewportAtScreenPoint`) and the
 * centered fallback are shared, so the cursor/selection-center contract
 * holds at every density.
 *
 * Unknown callers must NOT use this (no verified coefficient): they
 * keep the legacy `resolveWheelViewport`. An invalid density (non-finite /
 * <= 0) fails closed to `{ kind: 'none' }` -- no step, no silent 1.0
 * assumption.
 */
export function resolveWheelViewportForPaperDensity(
  viewport: CostumeViewport,
  wheel: WheelLike,
  context: WheelViewportContext = {},
  paperToCssDensity: number,
): WheelViewportResolution {
  const safeViewport = sanitizeViewport(viewport)
  const density = sanitizePaperToCssDensity(paperToCssDensity)
  const base: CostumeViewport = {
    x: safeViewport.x,
    y: safeViewport.y,
    scale: density === undefined ? clampViewportScale(safeViewport.scale) : clampViewportScaleForDensity(safeViewport.scale, density),
  }
  const ctrl = wheel.ctrlKey === true || wheel.metaKey === true
  const shift = wheel.shiftKey === true
  const { dx, dy } = normalizeWheelDeltas({
    deltaX: wheel.deltaX,
    deltaY: wheel.deltaY,
    deltaMode: wheel.deltaMode,
  })

  if (ctrl) {
    if (!isFiniteNumber(dy) || dy === 0) return { kind: 'none', viewport: base }
    if (density === undefined) return { kind: 'none', viewport: base }
    const paperGain = -dy / COSTUME_VIEWPORT_WHEEL_DIVISOR
    const cssGain = cssScaleStepForPaperStep(paperGain, density)
    if (!isFiniteNumber(cssGain) || cssGain === 0) return { kind: 'none', viewport: base }
    const requested = base.scale + cssGain
    const appliedScale = wheelZoomForPaperDensity(base.scale, dy, density)
    const clamped = appliedScale !== requested
    const factor = appliedScale / base.scale
    const surface = sanitizeSurface(
      context.surface ?? { ...COSTUME_VIEWPORT_DEFAULT_SURFACE },
    )
    const center = context.containerCenter
    const point = context.screenPoint
    if (center && point && isFiniteNumber(center.x) && isFiniteNumber(center.y) && isFiniteNumber(point.x) && isFiniteNumber(point.y)) {
      const zoomed = zoomViewportAtScreenPoint(base, surface, center, point, factor, density)
      return {
        kind: 'zoom',
        viewport: zoomed.viewport,
        factor: zoomed.appliedFactor,
        clamped: zoomed.clamped,
        normalizedDeltaY: dy,
      }
    }
    // Fallback: keep the scale gesture, anchor at the artwork center.
    return {
      kind: 'zoom',
      viewport: { x: base.x, y: base.y, scale: appliedScale },
      factor,
      clamped,
      normalizedDeltaY: dy,
    }
  }

  if (shift && dx === 0 && dy !== 0) {
    return {
      kind: 'pan',
      viewport: panViewport(base, dy, 0),
      dx: dy,
      dy: 0,
      horizontalShift: true,
    }
  }

  if (dx === 0 && dy === 0) return { kind: 'none', viewport: base }
  return {
    kind: 'pan',
    viewport: panViewport(base, dx, dy),
    dx,
    dy,
    horizontalShift: false,
  }
}

// ---------------------------------------------------------------------------
// Viewport state scope (per-costume viewport identity for the live editor).
//
// F2/F3 separation: viewport state is keyed by project identity + target
// identity + costume identity + edit mode. Slot-only keys
// (`targetId:index:mode`) poison revisits in two ways:
//
// - F2: an async/reset placeholder saved under the slot marks the key
//   settled, so the delayed first-fit finds a "saved" value and drops --
//   revisits then never fit. Only an explicit user pan/zoom, an explicit
//   reset, or an applied first-fit may settle a key; an arrived-but-undecoded
//   placeholder must never be saved.
// - F3: a project replace reuses the previous project's viewport for the
//   same `targetId:index` slot. The project identity (and the costume content
//   identity) must be part of the key so a replaced project starts unsettled.
//
// Keys are opaque tokens compared by equality only; segments are kept
// verbatim (no lossy sanitization) so distinct identities never merge.

/** Edit mode side of a viewport state key (bitmap/vector viewports are independent). */
export type CostumeViewportScopeMode = 'bitmap' | 'vector'

export type CostumeViewportScope = {
  /** Project identity (sb3 hash / load generation). Absent => legacy project scope (F3 pending Editor wiring). */
  projectId?: string | null
  /**
   * Opaque Editor slot token; carries `targetId:index` (`stableTargetId` +
   * costume slot). Kept whole so user names containing separators can never
   * split the key.
   */
  slotKey: string
  /** Costume content identity (md5ext/assetId [+ dataFormat]). Absent => slot scope (F3 pending Editor wiring). */
  assetKey?: string | null
  /** Edit mode side of the key. */
  mode: CostumeViewportScopeMode
}

/** Project segment used while the Editor does not pass a project identity (F3 incomplete: same-asset reimports share keys). */
export const COSTUME_VIEWPORT_LEGACY_PROJECT_SEGMENT = 'legacy-project'
/** Asset segment used while no costume content identity is known (F3 incomplete: slot reuse shares keys). */
export const COSTUME_VIEWPORT_SLOT_ASSET_SEGMENT = 'slot'

function viewportScopeSegment(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string' || value === '') return fallback
  return value
}

/**
 * Build the canonical viewport state key for a project + target + costume +
 * mode scope. Missing project/asset identities fall back to the legacy/slot
 * segments (documented above); callers pass the Editor-owned identities as
 * soon as they exist so project replacement and slot reuse start unsettled.
 */
export function buildCostumeViewportKey(scope: CostumeViewportScope): string {
  const project = viewportScopeSegment(scope.projectId, COSTUME_VIEWPORT_LEGACY_PROJECT_SEGMENT)
  const slot = viewportScopeSegment(scope.slotKey, 'unknown-slot')
  const asset = viewportScopeSegment(scope.assetKey, COSTUME_VIEWPORT_SLOT_ASSET_SEGMENT)
  return `costume-viewport|project=${project}|slot=${slot}|asset=${asset}|mode=${scope.mode}`
}

/**
 * Legacy slot-only key (`targetId:index:mode`, kept for the unmigrated path).
 * Collides across project replaces and across asset swaps in the same slot
 * (F3); prefer `buildCostumeViewportKey` with explicit identities.
 */
export function buildLegacySlotViewportKey(slotKey: string, mode: CostumeViewportScopeMode): string {
  return `${slotKey}:${mode}`
}

// ---------------------------------------------------------------------------
// Initial fit (first-visit zoom-to-fit, reference `zoomToFit` basis).
//
// Clean-room mapping of the Scratch Paper `zoomToFit` model onto the current
// CSS transform (`translate(+vx,+vy) scale(s)` on a W x H surface centered on
// the container). No drawing data or history is touched: this only derives a
// viewport (`x`, `y`, `scale`).
//
// Reference model (own words, numbers re-typed, no third-party copy):
// - reset to the base zoom first (Paper 0.5; CSS per-mode reset via
//   `viewportResetScaleForDensity`: vector 0.2, bitmap res2 0.5, res1 1.0,
//   unknown 1).
// - bitmap expands trim bounds by +50 Paper units total per extent (res1
//   canvas: +25 canvas px at density 0.5; res2: +50 canvas px at density
//   1.0), vector uses the union as-is; both pad each expanded extent x1.5.
// - `ratio = 0.5 * max(paddedW / clientW, paddedH / clientH)` clamped into
//   `[0.125, 1]`; only when `ratio < 1` the view centers on `bounds.center`
//   and zooms to `0.5 / ratio` (range `[0.5, 4]`). Otherwise the view stays
//   at the base (centered on the board, NOT on the content).
//
// CSS translation:
// - Paper zoom `z` and CSS scale `s` share on-screen density via
//   `z = s * (W / Pw)` (`cssPxPerPaperUnit`), so `s = z / density` with the
//   explicit per-mode density (vector 2.5, bitmap res2 1.0, bitmap res1
//   0.5). An invalid/unknown density fails closed to the legacy reset
//   (behavior preserved for unknown only; reason `unknown-density`).
// - Centering: the surface point for `bounds.center` is `Cc` (surface px).
//   At scale `s` the viewport that puts `Cc` on the container center is
//   `vx = -(Cc.x - W/2) * s`, `vy = -(Cc.y - H/2) * s` (surface-center math
//   in `surfaceToScreen`: `P = C + (vx,vy) + (S - W/2) * s`, set `P = C`).
// - `contentBoundsSurface` is already in surface px (bitmap: canvas px trim;
//   vector: `artLeft + svg*5`), so artboard offset/rotationCenter are baked
//   in by the caller. `containerSize` is the live viewport container in CSS
//   px (`canvas.clientWidth/Height` analogue); surface/container sizes are
//   explicit parameters so resize flows through the formula (no hardcoded
//   size). Undo/redo never calls this (first-visit gate lives in the caller
//   via the per-costume+mode saved-state map).

export type InitialFitSurfaceRect = {
  x: number
  y: number
  width: number
  height: number
}

export type InitialFitContainerSize = {
  width: number
  height: number
}

export type InitialFitInput = {
  /** Trim/union bounds in surface px (`null` when empty/unusable). */
  contentBoundsSurface?: InitialFitSurfaceRect | null
  /** Edit surface size (`W x H`, vector 2400x1800 / bitmap canvas). */
  surfaceSize: { width: number; height: number }
  /** Live viewport container in CSS px (`null` when unlaid-out). */
  containerSize?: InitialFitContainerSize | null
  /** Explicit Paper-to-CSS density (vector 2.5 / res2 1.0 / res1 0.5). */
  paperToCssDensity?: number
  /** Toggles the bitmap expand-then-pad path (`expand(50)` + x1.5). */
  isBitmap: boolean
}

export type InitialFitResult = {
  /**
   * Viewport to apply, or `null` when inputs are not ready (unlaid-out
   * container/surface: caller must NOT save, retry when laid out).
   */
  viewport: CostumeViewport | null
  /** Paper fit zoom (`0.5` base, `0.5..4` fitted, `null` when not ready/unknown). */
  paperZoom: number | null
  /** True only when centered on the content (`ratio < 1` zoom-in path). */
  fitted: boolean
  /** Machine-readable reason for tests/reports. */
  reason: string
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Union a list of surface rects (vector SVG->surface conversions or bitmap
 * trims). Ignores `null`/`undefined`/non-finite entries; zero-area rects are
 * KEPT (Paper `unite` includes them) so a bare line still yields a singular
 * union that the fit gate then fails closed to the base. Returns `null` when
 * no finite rect remains.
 */
export function unionFitRects(
  rects: Array<{ x: number; y: number; width: number; height: number } | null | undefined>,
): InitialFitSurfaceRect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let count = 0
  for (const rect of rects) {
    if (!rect) continue
    const { x, y, width, height } = rect
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + width)
    maxY = Math.max(maxY, y + height)
    count += 1
  }
  if (count === 0 || !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function initialFitResetViewport(density: number | undefined): CostumeViewport {
  return { x: 0, y: 0, scale: viewportResetScaleForDensity(density) }
}

/**
 * Resolve the first-visit viewport for explicit bounds/sizes/density.
 * Pure: no DOM, no Paper.js, no history. Callers gate on first-visit (no
 * saved per-costume+mode state) and on settled artwork/owner so async
 * load/race/target-switch never applies a stale fit, and never call this for
 * undo/redo paints.
 */
export function resolveInitialFitViewport(input: InitialFitInput): InitialFitResult {
  const density = sanitizePaperToCssDensity(input.paperToCssDensity as number)
  // Unknown: no verified coefficient. Fail closed to the legacy reset
  // (current behavior preserved for unknown only). Callers still save it so
  // the key settles without retrying every artwork update.
  if (density === undefined) {
    return {
      viewport: initialFitResetViewport(undefined),
      paperZoom: null,
      fitted: false,
      reason: 'unknown-density: unknown Paper mapping, keep legacy reset',
    }
  }
  const surface = input.surfaceSize
  if (!surface || !isPositiveFinite(surface.width) || !isPositiveFinite(surface.height)) {
    return { viewport: null, paperZoom: null, fitted: false, reason: 'not-ready: bad surface size' }
  }
  const container = input.containerSize
  if (!container || !isPositiveFinite(container.width) || !isPositiveFinite(container.height)) {
    return { viewport: null, paperZoom: null, fitted: false, reason: 'not-ready: bad container size' }
  }
  const bounds = input.contentBoundsSurface
  if (!bounds || !isFiniteNumber(bounds.x) || !isFiniteNumber(bounds.y)) {
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'empty: no content bounds, base zoom',
    }
  }
  if (!isFiniteNumber(bounds.width) || !isFiniteNumber(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
    // Singular (bare line/point) or zero-area: reference `bounds.width &&
    // bounds.height` fails closed to the base (no centering).
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'singular: zero-area bounds, base zoom',
    }
  }
  // Surface px -> Paper units for the fit ratio (`w_p = w_s / density`).
  const paperW = bounds.width / density
  const paperH = bounds.height / density
  if (!isPositiveFinite(paperW) || !isPositiveFinite(paperH)) {
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'empty: non-finite Paper bounds, base zoom',
    }
  }
  // Reference FIT against live container CSS px (own re-implementation of the
  // audited expand-then-pad + ratio clamp; kept dependency-free here so unit
  // tests stay hermetic -- keep in sync with `resolvePaperFitZoom` in
  // paper-viewport-parity.ts).
  const expand = input.isBitmap ? 50 : 0
  const paddedW = (paperW + expand) * 1.5
  const paddedH = (paperH + expand) * 1.5
  if (!isPositiveFinite(paddedW) || !isPositiveFinite(paddedH)) {
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'empty: overflowed padded bounds, base zoom',
    }
  }
  const rawRatio = 0.5 * Math.max(paddedW / container.width, paddedH / container.height)
  if (!isFiniteNumber(rawRatio) || rawRatio <= 0) {
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'empty: non-finite fit ratio, base zoom',
    }
  }
  const clampedRatio = Math.max(0.125, Math.min(1, rawRatio))
  if (!(clampedRatio < 1)) {
    // Content fills or exceeds the viewport (full-board / huge / large-thin):
    // reference stays at the base WITHOUT recentering (board-centered reset).
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'fills-or-exceeds: ratio >= 1, base zoom without recentering',
    }
  }
  const paperZoom = 0.5 / clampedRatio
  if (!isPositiveFinite(paperZoom)) {
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'empty: non-finite fit zoom, base zoom',
    }
  }
  const theoreticalCss = paperZoom / density
  const cssScale = clampViewportScaleForDensity(theoreticalCss, density)
  if (!isPositiveFinite(cssScale)) {
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'empty: non-finite CSS scale, base zoom',
    }
  }
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  if (!isFiniteNumber(centerX) || !isFiniteNumber(centerY)) {
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'empty: non-finite bounds center, base zoom',
    }
  }
  const vx = -(centerX - surface.width / 2) * cssScale
  const vy = -(centerY - surface.height / 2) * cssScale
  if (!isFiniteNumber(vx) || !isFiniteNumber(vy)) {
    return {
      viewport: initialFitResetViewport(density),
      paperZoom: 0.5,
      fitted: false,
      reason: 'empty: non-finite fit pan, base zoom',
    }
  }
  return {
    viewport: { x: vx, y: vy, scale: cssScale },
    paperZoom,
    fitted: true,
    reason: 'fit: centered on content bounds',
  }
}
