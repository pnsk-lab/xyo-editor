// Bitmap straight-line stamp logic.
//
// Observed Scratch Paint behavior this module reproduces (without copying
// that codebase):
// - a bitmap straight line is not a vector `lineTo`/`stroke` path;
// - it is the same pre-rendered brush stamp used by the brush tool,
//   stamped once per integer pixel between the two endpoints.
//
// Current gap: `bitmap-shapes.ts` draws the `line` shape with
// `moveTo`/`lineTo`/`stroke`, which is an anti-aliased vector stroke. That
// disagrees with the pixel-stamp look of brush/eraser drags (crisp squares
// at small sizes, crisp pixel circles above that, no smoothing). This
// module closes the gap for lines by reusing `bitmap-brush.ts` as the
// single stamp source: same diameter normalization, same Bresenham pixel
// walk (`forEachBrushLinePoint`), same cached mark (`getBitmapBrushMark`),
// and same `ceil(diameter / 2)` stamp anchor.
//
// Caller contract (mirrors the brush stroke contract, Editor.svelte is the
// intended wiring point but is intentionally left untouched here):
// - the caller owns the preview base: `restoreBitmapPreviewBase()` first,
//   then `drawBitmapLine(...)` for preview redraws, and commits costume
//   history on pointer-up;
// - `width` is a stroke width in canvas pixels and maps 1:1 to the brush
//   stamp diameter (truncated to an integer, minimum 1);
// - `start`/`end` are canvas-pixel coordinates; they are truncated to
//   integer pixels by the shared pixel walk, matching brush/eraser input
//   handling.

import {
  assertBrushPoint,
  BITMAP_BRUSH_DEFAULT_SIZE,
  BITMAP_BRUSH_MAX_SEGMENT_STEPS,
  BITMAP_BRUSH_MAX_STAMPS,
  forEachBrushLinePoint,
  getBitmapBrushMark,
  normalizeBrushDiameter,
} from './bitmap-brush';

export type BitmapLinePoint = { x: number; y: number };

/** Default line width in canvas pixels. Same as the brush default because width maps to stamp diameter. */
export const BITMAP_LINE_DEFAULT_WIDTH = BITMAP_BRUSH_DEFAULT_SIZE;

/** Line width in whole canvas pixels, at least 1. Delegates to the brush normalization. */
export function normalizeBitmapLineWidth(width: number): number {
  return normalizeBrushDiameter(width);
}

/**
 * Top-left canvas origin where the stamp is drawn so integer pixel
 * (x, y) sits under the stamp center. Matches the brush anchor
 * `trunc(coord) - ceil(diameter / 2)`.
 */
export function bitmapLineStampOrigin(
  x: number,
  y: number,
  diameter: number,
): BitmapLinePoint {
  const normalized = normalizeBrushDiameter(diameter);
  const radius = Math.ceil(normalized / 2);
  return { x: Math.trunc(x) - radius, y: Math.trunc(y) - radius };
}

/**
 * Fail-closed pre-validation for one straight line, without touching the
 * canvas or allocating the pixel list. Returns the stamp count
 * (`max(dx,dy)+1`). Editors must call this (or catch the painter) BEFORE
 * mutating pixels so a refusal paints nothing. Direct (unsupported public)
 * callers get the same throw from the painter itself, which validates first.
 */
export function validateBitmapLine(start: BitmapLinePoint, end: BitmapLinePoint): number {
  assertBrushPoint(start, 'start');
  assertBrushPoint(end, 'end');
  const deltaX = Math.abs(Math.trunc(end.x) - Math.trunc(start.x));
  const deltaY = Math.abs(Math.trunc(end.y) - Math.trunc(start.y));
  if (deltaX > BITMAP_BRUSH_MAX_SEGMENT_STEPS || deltaY > BITMAP_BRUSH_MAX_SEGMENT_STEPS) {
    throw new RangeError(`bitmap line segment too long (fail-closed): dx=${deltaX} dy=${deltaY}`);
  }
  const total = Math.max(deltaX, deltaY) + 1;
  if (total > BITMAP_BRUSH_MAX_STAMPS) {
    throw new RangeError(`bitmap line too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} pixels`);
  }
  return total;
}

/**
 * Pure pixel walk for a straight line: every integer pixel between `start`
 * and `end`, inclusive and 8-connected. Thin wrapper over the shared brush
 * walk so line/brush/eraser interpolation can never drift apart. Fail-closed:
 * non-finite or out-of-int32-range endpoints throw `RangeError` instead of
 * wrapping/hanging (see `forEachBrushLinePoint`). Atomic: pre-validates the
 * length arithmetically before allocating/walking, so a refusal allocates
 * nothing and walks nothing.
 */
export function getBitmapLinePixels(start: BitmapLinePoint, end: BitmapLinePoint): BitmapLinePoint[] {
  // Atomic gate: fail fast without a 500k-element allocation on refusal.
  validateBitmapLine(start, end);
  const pixels: BitmapLinePoint[] = [];
  forEachBrushLinePoint(start, end, (x, y) => {
    if (pixels.length > BITMAP_BRUSH_MAX_STAMPS) {
      throw new RangeError(`bitmap line too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} pixels`);
    }
    pixels.push({ x, y });
  });
  return pixels;
}

/**
 * Draw one straight bitmap line by stamping the cached brush mark along
 * every interpolated pixel. A clicked point (start == end after
 * truncation) stamps exactly once. Fail-closed on huge/non-finite endpoints
 * (no OOM loop); width follows the shared 1..100 brush clamp.
 */
export function drawBitmapLine(
  context: CanvasRenderingContext2D,
  start: BitmapLinePoint,
  end: BitmapLinePoint,
  width: number,
  color: string,
): void {
  const normalized = normalizeBrushDiameter(width);
  const mark = getBitmapBrushMark(normalized, color);
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.imageSmoothingEnabled = false;
  try {
    // Atomic gate inside save/restore (balanced on throw).
    validateBitmapLine(start, end);
    let stamped = 0;
    forEachBrushLinePoint(start, end, (x, y) => {
      stamped += 1;
      if (stamped > BITMAP_BRUSH_MAX_STAMPS) {
        throw new RangeError(`bitmap line too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} stamps`);
      }
      const origin = bitmapLineStampOrigin(x, y, normalized);
      context.drawImage(mark, origin.x, origin.y);
    });
  } finally {
    context.restore();
  }
}
