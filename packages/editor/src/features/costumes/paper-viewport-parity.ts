// Paper <-> CSS viewport parity math (clean-room, pure, no DOM / Paper.js).
//
// Purpose: derive the Paper-coordinate correspondence of the current CSS
// viewport (`BitmapEditor.svelte` style binding
// `translate(calc(-50% + vx), calc(-50% + vy)) scale(s)` on a W x H surface,
// default 2400x1800) from actual-size formulas, without editing
// `BitmapEditor.svelte`, `Editor.svelte`, or `costume-viewport.ts`.
//
// Reference numbers below are *observed* values recorded in
// `test/zoom-parity-audit.test.ts` (Scratch paint audit: Paper floor 0.333,
// button +/-0.5 additive with the floor->0.5 special step, ctrl-wheel
// `-deltaY/1000` additive, selection center / pointer-fixed zoom, FIT
// `(bounds + expand(50)) x1.5` over `canvas.clientWidth/Height` from base
// zoom 0.5 up to 4). They are re-typed here as plain numbers for parity
// math; no third-party (AGPL) source is copied, imported, or quoted.
//
// Actual-size derivation (the core of this module):
// - Let the edit surface be W CSS px wide before the viewport scale (bitmap:
//   `bitmapCanvasWidth`, default 2400; vector: fixed 2400 workspace). Let the
//   Paper extent it stands for be Pw Paper units wide (bitmap default: 960,
//   the 960x720 art board; vector art: caller passes the SVG extent it maps).
// - Before the CSS `scale(s)`, 1 Paper unit covers `W / Pw` surface px.
//   After `scale(s)`, 1 Paper unit covers `(W / Pw) * s` CSS px on screen.
//   That product is `cssPxPerPaperUnit`. It is measured in the browser as
//   `measuredRect.width / Pw` and must equal the formula within 1px; the
//   browser test in `test/paper-viewport-parity.browser.test.ts` does exactly
//   that from the real container/image rects.
// - Paper screen density is `z` screen px per Paper unit (`view.zoom`). The
//   same on-screen size therefore satisfies `z = (W / Pw) * s`, i.e.
//   `s = z * Pw / W` and `z = s * W / Pw`. These are the forward/inverse
//   conversions (`paperZoomForCssScale` / `cssScaleForPaperZoom`). They are
//   exact inverses (round-trip) up to the documented clamps.
//
// What this module deliberately does NOT decide:
// - UX percent mapping for Paper zoom is UNKNOWN. The current UI label is
//   `Math.round(scale * 100)%` (CSS scale percent: 1 -> "100%"). Whether
//   Paper 0.5 means "50%" or "100%" is not established by the audit, so no
//   `paperZoom -> percent` conversion is provided. See
//   `PAPER_ZOOM_PERCENT_MAPPING` below. Do not hard-code it.

export type PaperPoint = { x: number; y: number }

export type PaperSize = { width: number; height: number }

export type CssViewport = { x: number; y: number; scale: number }

export type PaperView = {
  /** Paper project point the view is centered on (e.g. selection center). */
  center: PaperPoint
  /** Paper `view.zoom` (screen px per Paper unit). Floor 0.333, no ceiling. */
  zoom: number
}

/** Scratch-paint reference floor (zoom-out clamp, zoom-in unbounded). */
export const PAPER_OUTERMOST_ZOOM_LEVEL = 0.333

/** Scratch-paint reset zoom (center preserved, then clamped to workspace). */
export const PAPER_RESET_ZOOM = 0.5

/** Scratch-paint toolbar step (additive Paper zoom units). */
export const PAPER_ZOOM_INCREMENT = 0.5

/** Scratch-paint ctrl-wheel divisor (additive gain `-deltaY / 1000`). */
export const PAPER_WHEEL_DELTA_DIVISOR = 1000

/** Line-mode wheel multiplier (Firefox `deltaMode === 1` x15). */
export const PAPER_LINE_DELTA_MULTIPLIER = 15

/** FIT padding: 25% per side => each extent x1.5 (`1 + 2 * 25 / 100`). */
export const PAPER_FIT_PADDING_PERCENT = 25

export const PAPER_FIT_EXTENT_FACTOR = 1.5

/**
 * FIT bitmap hit-bounds `Rectangle.expand()` amount (Paper units).
 *
 * Proven against real Paper.js (`paper.Rectangle.expand(amount)` returns
 * `new Rectangle(x - amount / 2, y - amount / 2, width + amount,
 * height + amount)`): a single numeric `expand(50)` adds +50 in total to
 * each extent (+25 per side), NOT +100. The padded FIT extent for bitmap is
 * therefore `(bounds + 50) * 1.5`, i.e. the buffer contributes +75 after
 * the padding factor -- not `bounds * 1.5 + 100`.
 */
export const PAPER_FIT_BITMAP_BUFFER = 50

/** FIT ratio clamp lower bound (0.5 / 0.125 = 4 max expansion). */
export const PAPER_FIT_MIN_RATIO = 0.125

/** FIT base zoom (reset before fit) and max fit zoom (0.5 / 0.125). */
export const PAPER_FIT_BASE_ZOOM = 0.5

export const PAPER_FIT_MAX_ZOOM = 4

/** Reference art board and center (960x720, center 480,360). */
export const PAPER_ART_BOARD: PaperSize = { width: 960, height: 720 }

export const PAPER_ART_CENTER: PaperPoint = { x: 480, y: 360 }

/**
 * Stored-res1 live density (decided): 480 canvas px stand for the 960-unit
 * Paper board (1 canvas px = 2 Paper units), because the reference VM loader
 * doubles stored res1 PNG pixels/center to res2 before paint while this repo
 * keeps stored res1 bytes non-destructively. Reset CSS = 0.5/0.5 = 1.0,
 * floor CSS = 0.333/0.5 = 0.666..., button CSS step = 1.0, classic -100
 * wheel tick = +0.2 CSS. Fit buffer 50 Paper = 25 canvas px.
 */
export const PAPER_RES1_DENSITY = 480 / 960

export const PAPER_RES1_RESET_CSS = 0.5 / (480 / 960)

export const PAPER_RES1_FLOOR_CSS = 0.333 / (480 / 960)

/** Current CSS viewport band for the unknown/res1 path (legacy convention). */
export const CSS_VIEWPORT_MIN_SCALE = 0.25

export const CSS_VIEWPORT_MAX_SCALE = 5

export const CSS_VIEWPORT_DEFAULT_SCALE = 1

/**
 * Per-board CSS scale band (Paper basis, derived from the actual-size
 * formula): for a surface standing for a Paper extent, the density is
 * `W / Pw` and the Paper floor 0.333 maps to `0.333 / density` CSS.
 * Vector board (2400/960): 0.1332..5, so the Paper reset 0.2 is live.
 * Res2 board (960/960): 0.333..5, so the Paper reset 0.5 is live.
 * Res1 board (480/960): 0.666...5, so the Paper reset 1.0 is live
 * (stored res1 kept non-destructively while the reference loader doubles
 * res1 pixels/center to res2 before paint: 1 canvas px = 2 Paper units).
 * Unknown extents (non-finite/non-positive W or Pw) fall back to the legacy
 * `[0.25, 5]` band. The ceiling 5 stays OUR safety bound in every band.
 */
export function cssViewportMinScaleForBoard(surfaceWidthPx: number, paperWidthUnits: number): number {
  if (!isFiniteNumber(surfaceWidthPx) || surfaceWidthPx <= 0) return CSS_VIEWPORT_MIN_SCALE
  if (!isFiniteNumber(paperWidthUnits) || paperWidthUnits <= 0) return CSS_VIEWPORT_MIN_SCALE
  const density = surfaceWidthPx / paperWidthUnits
  if (!isFiniteNumber(density) || density <= 0) return CSS_VIEWPORT_MIN_SCALE
  return Math.min(CSS_VIEWPORT_MAX_SCALE, Math.max(PAPER_OUTERMOST_ZOOM_LEVEL / density, 1e-9))
}

/** Clamp a CSS scale into the per-board Paper band. Non-finite maps to the board reset. */
export function clampCssViewportScaleForBoard(scale: number, surfaceWidthPx: number, paperWidthUnits: number): number {
  const min = cssViewportMinScaleForBoard(surfaceWidthPx, paperWidthUnits)
  if (!isFiniteNumber(scale)) {
    if (!isFiniteNumber(surfaceWidthPx) || surfaceWidthPx <= 0) return CSS_VIEWPORT_DEFAULT_SCALE
    if (!isFiniteNumber(paperWidthUnits) || paperWidthUnits <= 0) return CSS_VIEWPORT_DEFAULT_SCALE
    return Math.max(min, Math.min(CSS_VIEWPORT_MAX_SCALE, PAPER_RESET_ZOOM / (surfaceWidthPx / paperWidthUnits)))
  }
  return Math.max(min, Math.min(CSS_VIEWPORT_MAX_SCALE, scale))
}

/**
 * Global lowest minimum across all live boards (vector 0.333/2.5).
 * Pure surface<->screen mapping helpers clamp here (not the legacy 0.25)
 * so the live vector reset 0.2 projects exactly.
 */
export const CSS_VIEWPORT_GLOBAL_MIN_SCALE = 0.333 / (2400 / 960)

/** Clamp for projection math: `[GLOBAL_MIN, MAX]`, non-finite => default 1. */
export function clampCssViewportScaleLenient(scale: number): number {
  if (!isFiniteNumber(scale)) return CSS_VIEWPORT_DEFAULT_SCALE
  return Math.max(CSS_VIEWPORT_GLOBAL_MIN_SCALE, Math.min(CSS_VIEWPORT_MAX_SCALE, scale))
}

/** Stage / workspace geometry backing the 2400x1800 default surface. */
export const BITMAP_STAGE_SIZE: PaperSize = { width: 480, height: 360 }

export const WORKSPACE_SCALE = 5

export const DEFAULT_EDIT_SURFACE: PaperSize = { width: 2400, height: 1800 }

/**
 * Overflow guard for the unbounded Paper zoom axis. Scratch defines no
 * ceiling; repeated additive steps on huge zooms could overflow to Infinity
 * and poison center math. This cap is OUR safety bound (not a Scratch
 * number): conversions and steps clamp the *computed* zoom into
 * `[PAPER_OUTERMOST_ZOOM_LEVEL, PAPER_ZOOM_SAFE_MAX]` so downstream
 * arithmetic stays finite. Chosen as 1e6 (far above any FIT/UI zoom <= 12.5
 * equivalent) while keeping `zoom * extent` products exactly representable.
 */
export const PAPER_ZOOM_SAFE_MAX = 1_000_000

/**
 * UX percent mapping for Paper zoom is UNKNOWN (see module header). The
 * current UI percent is `Math.round(cssScale * 100)`; whether Paper 0.5 is
 * "50%" or "100%" was not established, so this module provides no Paper
 * percent conversion. The constant exists so callers must confront the gap
 * instead of hard-coding one interpretation.
 */
export const PAPER_ZOOM_PERCENT_MAPPING = 'unknown' as const

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizePoint(point: PaperPoint | undefined, fallbackX = 0, fallbackY = 0): PaperPoint {
  return {
    x: isFiniteNumber(point?.x) ? (point as PaperPoint).x : fallbackX,
    y: isFiniteNumber(point?.y) ? (point as PaperPoint).y : fallbackY,
  }
}

function sanitizeSize(size: PaperSize | undefined, fallback: PaperSize): PaperSize {
  const width = isFiniteNumber(size?.width) && (size as PaperSize).width > 0 ? (size as PaperSize).width : fallback.width
  const height =
    isFiniteNumber(size?.height) && (size as PaperSize).height > 0 ? (size as PaperSize).height : fallback.height
  return { width, height }
}

/** Clamp a CSS scale into the UI band. Non-finite maps to the default. */
export function clampCssViewportScale(scale: number): number {
  if (!isFiniteNumber(scale)) return CSS_VIEWPORT_DEFAULT_SCALE
  return Math.max(CSS_VIEWPORT_MIN_SCALE, Math.min(CSS_VIEWPORT_MAX_SCALE, scale))
}

/**
 * Clamp a Paper zoom into `[0.333, PAPER_ZOOM_SAFE_MAX]`. Non-finite maps to
 * the reset zoom (0.5); zero/negative maps to the floor (0.333) so an
 * additive step that crosses zero still lands on the floor instead of
 * jumping back to reset. The upper cap is only an overflow guard; Scratch
 * itself is unbounded above.
 */
export function clampPaperZoom(zoom: number): number {
  if (!isFiniteNumber(zoom)) return PAPER_RESET_ZOOM
  if (zoom <= 0) return PAPER_OUTERMOST_ZOOM_LEVEL
  return Math.max(PAPER_OUTERMOST_ZOOM_LEVEL, Math.min(PAPER_ZOOM_SAFE_MAX, zoom))
}

/** Toolbar-equivalent additive step: `zoom +/- 0.5`, floored at 0.333. */
export function paperZoomStepAdditive(zoom: number, direction: 1 | -1): number {
  const base = clampPaperZoom(zoom)
  // Guard the addition itself: huge-but-finite + 0.5 could round to Infinity
  // only past 1e308, but clamp anyway so the contract is total.
  // The reference toolbar's first zoom-in from the outermost level returns
  // to the reset level rather than adding the regular increment.
  const next = direction > 0 && base === PAPER_OUTERMOST_ZOOM_LEVEL
    ? PAPER_RESET_ZOOM
    : base + direction * PAPER_ZOOM_INCREMENT
  if (!isFiniteNumber(next)) return direction > 0 ? PAPER_ZOOM_SAFE_MAX : PAPER_OUTERMOST_ZOOM_LEVEL
  return clampPaperZoom(next)
}

/** Normalize one wheel delta into Paper units pre-divisor (line mode x15). */
export function normalizePaperWheelDelta(delta: number, deltaMode: number): number {
  if (!isFiniteNumber(delta)) return 0
  if (deltaMode === 1) return delta * PAPER_LINE_DELTA_MULTIPLIER
  return delta
}

/**
 * Ctrl-wheel additive gain: `zoom + (-deltaY / 1000)`, floored at 0.333.
 * `deltaY` is the *normalized* (line-expanded) vertical delta. Non-finite
 * input is a no-op returning the clamped current zoom.
 */
export function paperWheelZoomAdditive(zoom: number, normalizedDeltaY: number): number {
  const base = clampPaperZoom(zoom)
  if (!isFiniteNumber(normalizedDeltaY) || normalizedDeltaY === 0) return base
  const next = base + -normalizedDeltaY / PAPER_WHEEL_DELTA_DIVISOR
  if (!isFiniteNumber(next)) {
    return normalizedDeltaY < 0 ? PAPER_ZOOM_SAFE_MAX : PAPER_OUTERMOST_ZOOM_LEVEL
  }
  return clampPaperZoom(next)
}

/**
 * Actual-size formula: CSS px per 1 Paper unit at this viewport scale.
 *
 *   cssPxPerPaperUnit = (surfaceWidthPx / paperWidthUnits) * clampedCssScale
 *
 * `surfaceWidthPx` is the edit-surface width before `scale()` (bitmap:
 * canvas width, default 2400; vector: 2400 workspace). `paperWidthUnits` is
 * the Paper extent that surface stands for (bitmap default: 960 art board).
 * Non-finite/non-positive inputs fail closed to 0 (caller treats 0 as
 * "unmeasurable": unlaid-out container, zero bounds, bad scale).
 */
export function cssPxPerPaperUnit(
  surfaceWidthPx: number,
  paperWidthUnits: number,
  cssScale: number,
): number {
  if (!isFiniteNumber(surfaceWidthPx) || surfaceWidthPx <= 0) return 0
  if (!isFiniteNumber(paperWidthUnits) || paperWidthUnits <= 0) return 0
  const scale = clampCssViewportScaleForBoard(cssScale, surfaceWidthPx, paperWidthUnits)
  const perUnit = (surfaceWidthPx / paperWidthUnits) * scale
  if (!isFiniteNumber(perUnit) || perUnit <= 0) return 0
  // Overflow guard: W up to ~1e6 px * scale 5 / tiny paper extent could
  // exceed float range; cap at a still-absurd but finite density.
  return Math.min(perUnit, PAPER_ZOOM_SAFE_MAX)
}

/**
 * Paper zoom equivalent of a CSS scale for the same on-screen density:
 * `z = s * W / Pw`. The CSS input is clamped to the per-board Paper band
 * (vector 0.1332..5, res2 0.333..5) so the live Paper reset 0.5 maps exactly;
 * the Paper side is only overflow-guarded.
 */
export function paperZoomForCssScale(
  cssScale: number,
  surfaceWidthPx: number,
  paperWidthUnits: number,
): number {
  if (!isFiniteNumber(surfaceWidthPx) || surfaceWidthPx <= 0) return PAPER_RESET_ZOOM
  if (!isFiniteNumber(paperWidthUnits) || paperWidthUnits <= 0) return PAPER_RESET_ZOOM
  const scale = clampCssViewportScaleForBoard(cssScale, surfaceWidthPx, paperWidthUnits)
  const zoom = (scale * surfaceWidthPx) / paperWidthUnits
  return clampPaperZoom(zoom)
}

/**
 * CSS scale for the same on-screen density as a Paper zoom:
 * `s_theoretical = z * Pw / W`, then clamped into the per-board Paper band
 * for display (vector 0.1332..5: reset 0.2 exact; res2 0.333..5: reset 0.5
 * exact). Returns both so tests can assert the round-trip on the theoretical
 * value while the UI uses the clamped one. Paper side is only
 * overflow-guarded.
 */
export function cssScaleForPaperZoom(
  paperZoom: number,
  surfaceWidthPx: number,
  paperWidthUnits: number,
): { theoretical: number; clamped: number } {
  const fallback = { theoretical: CSS_VIEWPORT_DEFAULT_SCALE, clamped: CSS_VIEWPORT_DEFAULT_SCALE }
  if (!isFiniteNumber(surfaceWidthPx) || surfaceWidthPx <= 0) return fallback
  if (!isFiniteNumber(paperWidthUnits) || paperWidthUnits <= 0) return fallback
  const zoom = clampPaperZoom(paperZoom)
  const theoretical = (zoom * paperWidthUnits) / surfaceWidthPx
  if (!isFiniteNumber(theoretical)) {
    return { theoretical: CSS_VIEWPORT_MAX_SCALE, clamped: CSS_VIEWPORT_MAX_SCALE }
  }
  return { theoretical, clamped: clampCssViewportScaleForBoard(theoretical, surfaceWidthPx, paperWidthUnits) }
}

/**
 * CSS surface<->screen mapping re-derived from the style binding (same math
 * as `costume-viewport.ts`, kept local so this module is standalone):
 * the unscaled W x H box is centered on the container center, shifted by
 * (vx, vy), then scaled by s around that anchor.
 */
export function cssSurfaceToScreen(
  surfacePoint: PaperPoint,
  surface: PaperSize,
  containerCenter: PaperPoint,
  viewport: CssViewport,
): PaperPoint {
  const safeSurface = sanitizeSize(surface, DEFAULT_EDIT_SURFACE)
  const safeCenter = sanitizePoint(containerCenter)
  const safePoint = sanitizePoint(surfacePoint)
  const scale = clampCssViewportScaleLenient(viewport?.scale)
  const vx = isFiniteNumber(viewport?.x) ? viewport.x : 0
  const vy = isFiniteNumber(viewport?.y) ? viewport.y : 0
  return {
    x: safeCenter.x + vx + (safePoint.x - safeSurface.width / 2) * scale,
    y: safeCenter.y + vy + (safePoint.y - safeSurface.height / 2) * scale,
  }
}

export function cssScreenToSurface(
  screenPoint: PaperPoint,
  surface: PaperSize,
  containerCenter: PaperPoint,
  viewport: CssViewport,
): PaperPoint {
  const safeSurface = sanitizeSize(surface, DEFAULT_EDIT_SURFACE)
  const safeCenter = sanitizePoint(containerCenter)
  const safePoint = sanitizePoint(screenPoint)
  const scale = clampCssViewportScaleLenient(viewport?.scale)
  const vx = isFiniteNumber(viewport?.x) ? viewport.x : 0
  const vy = isFiniteNumber(viewport?.y) ? viewport.y : 0
  return {
    x: safeSurface.width / 2 + (safePoint.x - safeCenter.x - vx) / scale,
    y: safeSurface.height / 2 + (safePoint.y - safeCenter.y - vy) / scale,
  }
}

/**
 * Minimal Paper screen model for fixed-point math (differential only):
 * `screen = screenCenter + (paper - viewCenter) * zoom`. This is the
 * standard affine view mapping restricted to what the audit pins down
 * (gain `zoom`, fixed point at cursor/selection center); it does not copy
 * any vendor view implementation.
 */
export function paperToScreen(
  paperPoint: PaperPoint,
  view: PaperView,
  screenCenter: PaperPoint,
): PaperPoint {
  const safePoint = sanitizePoint(paperPoint)
  const safeScreen = sanitizePoint(screenCenter)
  const safeCenter = sanitizePoint(view?.center, PAPER_ART_CENTER.x, PAPER_ART_CENTER.y)
  const zoom = clampPaperZoom(view?.zoom)
  return {
    x: safeScreen.x + (safePoint.x - safeCenter.x) * zoom,
    y: safeScreen.y + (safePoint.y - safeCenter.y) * zoom,
  }
}

export function screenToPaper(
  screenPoint: PaperPoint,
  view: PaperView,
  screenCenter: PaperPoint,
): PaperPoint {
  const safePoint = sanitizePoint(screenPoint)
  const safeScreen = sanitizePoint(screenCenter)
  const safeCenter = sanitizePoint(view?.center, PAPER_ART_CENTER.x, PAPER_ART_CENTER.y)
  const zoom = clampPaperZoom(view?.zoom)
  return {
    x: safeCenter.x + (safePoint.x - safeScreen.x) / zoom,
    y: safeCenter.y + (safePoint.y - safeScreen.y) / zoom,
  }
}

export type PaperFixedPointResult = {
  view: PaperView
  appliedZoom: number
  /** `appliedZoom / previousZoom`. */
  appliedFactor: number
  clamped: boolean
}

/**
 * Paper pointer-fixed zoom: keep the Paper point under `anchorScreen` on the
 * same screen pixel while `zoom -> newZoom`. New center:
 * `c' = anchorPaper - (anchorScreen - screenCenter) / z'`.
 * The requested zoom is floored at 0.333 (overflow-guarded above); the
 * translation always uses the applied zoom so the anchor holds at the
 * boundary too.
 */
export function paperZoomAtScreenPoint(
  view: PaperView,
  screenCenter: PaperPoint,
  anchorScreen: PaperPoint,
  nextZoom: number,
): PaperFixedPointResult {
  const safeCenter = sanitizePoint(view?.center, PAPER_ART_CENTER.x, PAPER_ART_CENTER.y)
  const safeScreenCenter = sanitizePoint(screenCenter)
  const safeAnchor = sanitizePoint(anchorScreen)
  const previousZoom = clampPaperZoom(view?.zoom)
  const appliedZoom = clampPaperZoom(nextZoom)
  const clamped = appliedZoom !== nextZoom
  const anchorPaper = screenToPaper(safeAnchor, { center: safeCenter, zoom: previousZoom }, safeScreenCenter)
  const center = {
    x: anchorPaper.x - (safeAnchor.x - safeScreenCenter.x) / appliedZoom,
    y: anchorPaper.y - (safeAnchor.y - safeScreenCenter.y) / appliedZoom,
  }
  const safeResult = { x: isFiniteNumber(center.x) ? center.x : safeCenter.x, y: isFiniteNumber(center.y) ? center.y : safeCenter.y }
  return {
    view: { center: safeResult, zoom: appliedZoom },
    appliedZoom,
    appliedFactor: appliedZoom / previousZoom,
    clamped,
  }
}

export type CssFixedPointResult = {
  viewport: CssViewport
  appliedScale: number
  appliedFactor: number
  clamped: boolean
}

/**
 * CSS pointer-fixed zoom (same derivation as the Paper one, in surface px):
 * keeps the surface point under the cursor fixed on screen. Provided here
 * so parity tests can drive both sides from one anchor without importing
 * `costume-viewport.ts`.
 */
export function cssZoomAtScreenPoint(
  viewport: CssViewport,
  surface: PaperSize,
  containerCenter: PaperPoint,
  screenPoint: PaperPoint,
  factor: number,
): CssFixedPointResult {
  const safeSurface = sanitizeSize(surface, DEFAULT_EDIT_SURFACE)
  const safeCenter = sanitizePoint(containerCenter)
  const safeScreen = sanitizePoint(screenPoint)
  const vx = isFiniteNumber(viewport?.x) ? (viewport as CssViewport).x : 0
  const vy = isFiniteNumber(viewport?.y) ? (viewport as CssViewport).y : 0
  const previousScale = clampCssViewportScale(viewport?.scale)
  if (!isFiniteNumber(factor) || factor <= 0) {
    return { viewport: { x: vx, y: vy, scale: previousScale }, appliedScale: previousScale, appliedFactor: 1, clamped: false }
  }
  const requested = previousScale * factor
  // Overflow guard before the band clamp: factor could be Infinity.
  const finiteRequested = isFiniteNumber(requested) ? requested : CSS_VIEWPORT_MAX_SCALE
  const appliedScale = clampCssViewportScale(finiteRequested)
  const clamped = appliedScale !== requested
  const fixedSurface = cssScreenToSurface(safeScreen, safeSurface, safeCenter, { x: vx, y: vy, scale: previousScale })
  const x = safeScreen.x - safeCenter.x - (fixedSurface.x - safeSurface.width / 2) * appliedScale
  const y = safeScreen.y - safeCenter.y - (fixedSurface.y - safeSurface.height / 2) * appliedScale
  return {
    viewport: {
      x: isFiniteNumber(x) ? x : vx,
      y: isFiniteNumber(y) ? y : vy,
      scale: appliedScale,
    },
    appliedScale,
    appliedFactor: appliedScale / previousScale,
    clamped,
  }
}

export type FitContentBounds = {
  width: number
  height: number
} | null | undefined

export type FitViewportSize = {
  width: number
  height: number
} | null | undefined

/**
 * FIT zoom from content bounds to viewport size.
 *
 * Units are explicit: `contentBounds` is in Paper units (the pre-expand
 * hit-bounds extent: bitmap `getHitBounds()` output, vector union of
 * `item.bounds`), while `viewportCssPx` is the live canvas size in client
 * CSS px (`canvas.clientWidth` / `canvas.clientHeight`). Do NOT pass a
 * Paper-unit viewport here; the reference divides Paper-unit extents by CSS
 * px and re-scales by the base zoom, so passing Paper units silently
 * changes the ratio.
 *
 * Reference model (`helper/view.js` `zoomToFit`, re-stated in own words):
 * - reset to the base zoom 0.5 first (`resetZoom()` sets `view.zoom = 0.5`)
 * - bitmap: expand the hit-bounds via `Rectangle.expand(50)` (proven +50 in
 *   total per extent, +25 per side), vector: union `item.bounds` as-is
 * - pad each expanded extent by the 25%-per-side factor x1.5, i.e.
 *   `padded = (bounds + (isBitmap ? 50 : 0)) * 1.5`
 * - `ratio = 0.5 * max(paddedW / clientW, paddedH / clientH)`,
 *   clamped into `[0.125, 1]`; when the clamped ratio is below 1 the view
 *   centers on `bounds.center` and zooms to `0.5 / clampedRatio`
 *   (range `[0.5, 4]`), otherwise it stays at the base 0.5. The 0.333 floor
 *   never triggers on this path (minimum output is 0.5).
 * - No selection (null/undefined), zero/negative/non-finite bounds, or
 *   missing/zero/non-finite viewport all fail closed to the base zoom 0.5
 *   instead of dividing by zero or returning Infinity. Callers that want the
 *   artboard fallback pass `PAPER_ART_BOARD` explicitly.
 *
 * Resize/mode handling: both extents and the CSS-px viewport are explicit
 * parameters (no hardcoded container size), and `isBitmap` toggles the
 * expand-then-pad path, so bitmap/vector and resized containers flow
 * through one formula.
 */
export function resolvePaperFitZoom(
  contentBounds: FitContentBounds,
  viewportCssPx: FitViewportSize,
  isBitmap: boolean,
): number {
  if (!contentBounds) return PAPER_FIT_BASE_ZOOM
  const boundsW = contentBounds.width
  const boundsH = contentBounds.height
  if (!isFiniteNumber(boundsW) || !isFiniteNumber(boundsH)) return PAPER_FIT_BASE_ZOOM
  if (boundsW <= 0 || boundsH <= 0) return PAPER_FIT_BASE_ZOOM
  if (!viewportCssPx) return PAPER_FIT_BASE_ZOOM
  const clientW = viewportCssPx.width
  const clientH = viewportCssPx.height
  if (!isFiniteNumber(clientW) || !isFiniteNumber(clientH)) return PAPER_FIT_BASE_ZOOM
  if (clientW <= 0 || clientH <= 0) return PAPER_FIT_BASE_ZOOM
  // Expand-then-pad (NOT pad-then-add): bitmap `expand(50)` adds +50 in total
  // per extent (proven against real Paper.js), and the x1.5 padding factor
  // applies to the expanded extent. Overflow in the padded extent falls back
  // to the base zoom (fully zoomed out) instead of producing NaN.
  const expand = isBitmap ? PAPER_FIT_BITMAP_BUFFER : 0
  const paddedW = (boundsW + expand) * PAPER_FIT_EXTENT_FACTOR
  const paddedH = (boundsH + expand) * PAPER_FIT_EXTENT_FACTOR
  if (!isFiniteNumber(paddedW) || !isFiniteNumber(paddedH)) return PAPER_FIT_BASE_ZOOM
  const ratio = PAPER_FIT_BASE_ZOOM * Math.max(paddedW / clientW, paddedH / clientH)
  if (!isFiniteNumber(ratio) || ratio <= 0) return PAPER_FIT_BASE_ZOOM
  const clampedRatio = Math.max(PAPER_FIT_MIN_RATIO, Math.min(1, ratio))
  const fitZoom = PAPER_FIT_BASE_ZOOM / clampedRatio
  if (!isFiniteNumber(fitZoom)) return PAPER_FIT_MAX_ZOOM
  // Range is [0.5, 4] by construction; run through the floor/overflow guard
  // anyway so future constant changes cannot leak Infinity.
  return clampPaperZoom(Math.min(fitZoom, PAPER_FIT_MAX_ZOOM))
}

/**
 * Scroll-clamp model for the Paper center (workspace clamp comparison).
 * Keeps the visible rect (`viewportSizePaper = containerCss / zoom`) inside
 * `workspace` when it fits; when the viewport is larger than the workspace
 * (zoomed far out or tiny artboard after resize) the center snaps to the
 * workspace center. Non-finite inputs fail closed to the workspace center.
 * The current CSS UI does NOT clamp pan (vx/vy unbounded); this helper
 * exists so tests can quantify that difference.
 */
export function clampPaperCenterToWorkspace(
  center: PaperPoint,
  paperZoom: number,
  viewportSizeCssPx: PaperSize,
  workspace: PaperSize = PAPER_ART_BOARD,
  workspaceCenter: PaperPoint = PAPER_ART_CENTER,
): PaperPoint {
  const safeWorkspace = sanitizeSize(workspace, PAPER_ART_BOARD)
  const safeCenter = sanitizePoint(workspaceCenter, PAPER_ART_CENTER.x, PAPER_ART_CENTER.y)
  const requested = sanitizePoint(center, safeCenter.x, safeCenter.y)
  const zoom = clampPaperZoom(paperZoom)
  const viewport = viewportSizeCssPx
  if (!viewport || !isFiniteNumber(viewport.width) || !isFiniteNumber(viewport.height)) return safeCenter
  if (viewport.width <= 0 || viewport.height <= 0) return safeCenter
  const visibleW = viewport.width / zoom
  const visibleH = viewport.height / zoom
  if (!isFiniteNumber(visibleW) || !isFiniteNumber(visibleH)) return safeCenter
  const minX = 0
  const minY = 0
  const maxX = safeWorkspace.width
  const maxY = safeWorkspace.height
  const clampAxis = (value: number, visible: number, lo: number, hi: number, fallback: number): number => {
    if (!isFiniteNumber(value) || !isFiniteNumber(visible) || visible <= 0) return fallback
    if (visible >= hi - lo) return (lo + hi) / 2
    const half = visible / 2
    return Math.max(lo + half, Math.min(hi - half, value))
  }
  return {
    x: clampAxis(requested.x, visibleW, minX, maxX, safeCenter.x),
    y: clampAxis(requested.y, visibleH, minY, maxY, safeCenter.y),
  }
}

/**
 * Measure `cssPxPerPaperUnit` from real layout rects (browser side).
 * `measuredSurfaceRectWidthCssPx / paperWidthUnits` must equal
 * `cssPxPerPaperUnit(surfaceWidthPx, paperWidthUnits, measuredScale)` where
 * `measuredScale = measuredSurfaceRectWidthCssPx / surfaceWidthPx`.
 * Pure division with the same fail-closed 0 contract; the browser test feeds
 * it `getBoundingClientRect()` widths.
 */
export function measuredCssPxPerPaperUnit(measuredSurfaceRectWidthCssPx: number, paperWidthUnits: number): number {
  if (!isFiniteNumber(measuredSurfaceRectWidthCssPx) || measuredSurfaceRectWidthCssPx <= 0) return 0
  if (!isFiniteNumber(paperWidthUnits) || paperWidthUnits <= 0) return 0
  const density = measuredSurfaceRectWidthCssPx / paperWidthUnits
  return isFiniteNumber(density) ? density : 0
}
