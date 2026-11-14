// Bitmap res1 Paper mapping (clean-room, pure, DOM-free).
//
// Decided coefficient for stored resolution 1 (not a guess):
// this repo keeps stored res1 bytes/metadata non-destructively (480x360
// canvas, center 240,180), while the reference VM loader upscales res1 PNG
// pixels 2x (width/height x2, rotationCenter x2, resolution rewritten to 2)
// before the paint GUI ever sees the costume, so the live paint raster is
// always res2 (960x720 Paper board). Survey pins (own words, no third-party
// copy; file/line refs are survey pins, not quotations):
// - VM import `load-costume.js`: fetch path documents res1 -> res2
//   conversion; bitmap path doubles each PNG dimension and each rotation
//   center component, then records resolution 2; the skin path divides the
//   doubled center by 2 back to stage units (90s/140s-170s/230s-250s lines).
// - Paper board: 960x720 Paper units, center 480,360 (reference view.js
//   ART_BOARD_W/H + CENTER survey pins used across the viewport oracles).
//
// Consequence for the xyo edit canvas (stored res1 kept as-is):
// one canvas px covers 2 Paper units, so the Paper-to-CSS density is
//
//   d_res1 = 480 canvas px / 960 Paper units = 0.5 surface px per Paper unit.
//
// All Paper steps divide by this density (CSS step = Paper step / density):
// - reset: Paper 0.5 / 0.5 = 1.0 CSS (numerically the legacy reset, now on a
//   Paper basis instead of coincidence).
// - floor: Paper 0.333 / 0.5 = 0.666... CSS (replaces the legacy 0.25).
// - button: Paper +/-0.5 / 0.5 = +/-1.0 CSS per step.
// - ctrl-wheel classic -100 tick: Paper +0.1 / 0.5 = +0.2 CSS.
// - first-fit: trim bounds are canvas px, Paper extent is bounds / 0.5
//   (2x); the +50 Paper buffer equals +25 canvas px; the artboard center
//   240,180 canvas maps to 480,360 Paper (x2).
// - workspace clamp: Paper = (S - cc) / 0.5 + (480,360) with the tracked
//   true artboard center cc in canvas px (union canvases shift cc); the
//   reference ART/MAX/BUFFER numbers stay in Paper units, unchanged.
//
// What this module does NOT do:
// - no byte/metadata/resolution rewrite on save (non-destructive: stored
//   res1 stays res1, rotationCenter stays stored; user edits + undo/redo are
//   preserved verbatim by the Editor/paint-history path, untouched here).
// - no vector/res2 changes (their densities 2.5 / 1.0 are pinned elsewhere).
// - no DOM/Paper.js/VM/history writes: pure numbers only.

/** Stored-res1 Paper-to-CSS density: 480 canvas px per 960 Paper units. */
export const BITMAP_RES1_PAPER_TO_CSS_DENSITY = 480 / 960 // 0.5 (decided)

/** Stored-res1 Paper board extent behind the 480-wide canvas. */
export const BITMAP_RES1_PAPER_WIDTH_UNITS = 960

/** Stored-res1 Paper board height behind the 360-tall canvas. */
export const BITMAP_RES1_PAPER_HEIGHT_UNITS = 720

/** Stored-res1 artboard center in canvas px (non-destructive stored value). */
export const BITMAP_RES1_CANVAS_CENTER = { x: 240, y: 180 } as const

/** Stored-res1 artboard center in Paper units (canvas center x2). */
export const BITMAP_RES1_PAPER_CENTER = { x: 480, y: 360 } as const

/** Paper reset/floor/button/wheel steps behind the res1 CSS values. */
export const BITMAP_RES1_PAPER_RESET_ZOOM = 0.5
export const BITMAP_RES1_PAPER_FLOOR_ZOOM = 0.333
export const BITMAP_RES1_PAPER_BUTTON_STEP = 0.5
export const BITMAP_RES1_PAPER_WHEEL_DIVISOR = 1000
export const BITMAP_RES1_PAPER_FIT_BUFFER = 50

/** Live res1 CSS band values (Paper step / 0.5 density). */
export const BITMAP_RES1_RESET_CSS = 1.0 // 0.5 / 0.5
export const BITMAP_RES1_FLOOR_CSS = 0.333 / 0.5 // 0.666...
export const BITMAP_RES1_BUTTON_CSS_STEP = 0.5 / 0.5 // 1.0
export const BITMAP_RES1_WHEEL_TICK_CSS = 0.1 / 0.5 // +0.2 per classic -100 tick

/** Fit buffer in canvas px: 50 Paper units at density 0.5. */
export const BITMAP_RES1_FIT_BUFFER_CANVAS_PX = 50 * BITMAP_RES1_PAPER_TO_CSS_DENSITY // 25

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Canvas px -> Paper units at the res1 density (x2). Fail-closed to 0. */
export function res1CanvasToPaperUnits(canvasPx: number): number {
  if (!isFiniteNumber(canvasPx)) return 0
  const out = canvasPx / BITMAP_RES1_PAPER_TO_CSS_DENSITY
  return isFiniteNumber(out) ? out : 0
}

/** Paper units -> canvas px at the res1 density (/2). Fail-closed to 0. */
export function res1PaperToCanvasUnits(paperUnits: number): number {
  if (!isFiniteNumber(paperUnits)) return 0
  const out = paperUnits * BITMAP_RES1_PAPER_TO_CSS_DENSITY
  return isFiniteNumber(out) ? out : 0
}

/** Paper fit buffer (50) expressed in res1 canvas px (25). */
export function res1FitBufferCanvasPx(paperBuffer = BITMAP_RES1_PAPER_FIT_BUFFER): number {
  if (!isFiniteNumber(paperBuffer) || paperBuffer <= 0) return 0
  return paperBuffer * BITMAP_RES1_PAPER_TO_CSS_DENSITY
}
