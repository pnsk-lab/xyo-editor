// Bitmap eraser stamp logic: the eraser stamps a brush mark along a Bresenham
// line with `destination-out`, instead of a smoothed anti-aliased stroke.
// The disc footprint lives in `./bitmap-stamp` and is shared with the brush
// so the same-diameter pair cancels exactly.
import { fillStampDisc, outlineStampDisc } from './bitmap-stamp';
import {
  assertBrushPoint,
  BITMAP_BRUSH_MAX_POINTS,
  BITMAP_BRUSH_MAX_SEGMENT_STEPS,
  BITMAP_BRUSH_MAX_STAMPS,
  forEachBrushLinePoint,
  normalizeBrushDiameter,
} from './bitmap-brush';
import { ERASER_MARK_CACHE_LIMIT, cacheCanvasMark } from './bounded-mark-cache';

export const BITMAP_ERASER_DEFAULT_SIZE = 40;
export const VECTOR_ERASER_DEFAULT_SIZE = 40;

type Point = { x: number; y: number };

export function forEachLinePoint(point1: Point, point2: Point, callback: (x: number, y: number) => void) {
  // Thin wrapper over the shared brush walk so line/brush/eraser
  // interpolation can never drift apart. The reference truncates with `~~`;
  // `forEachBrushLinePoint` truncates with `Math.trunc` (identical while
  // |coord| <= 2^31 - 1) and fails closed outside that range instead of
  // wrapping, plus a per-segment step cap against OOM loops.
  assertBrushPoint(point1, 'point1');
  assertBrushPoint(point2, 'point2');
  forEachBrushLinePoint(point1, point2, callback);
  // Keep the imported cap referenced for the fail-closed contract even though
  // the shared walk enforces it (prevents unused-import drift if inlined).
  void BITMAP_BRUSH_MAX_SEGMENT_STEPS;
}

const eraserMarkCache = new Map<string, HTMLCanvasElement>();

// Squares at small sizes, crisp pixel discs above that. Alpha is what matters
// because stamps are drawn with `destination-out`. The filled disc plus the
// 1px guide ring share the brush footprint, so the same diameter cancels.
export function getBitmapEraserMark(size: number, guideColor = 'white'): HTMLCanvasElement {
  // Same 1..100 clamp as the brush (toolbar `bitBrushSize` contract): avoids
  // the old `~~size` int32 wrap on huge inputs and any oversized canvas alloc.
  // Non-finite maps to 1 via the shared normalizer, matching brush behavior.
  const normalized = normalizeBrushDiameter(size);
  const cacheKey = `${normalized}:${guideColor}`;
  return cacheCanvasMark(
    eraserMarkCache,
    cacheKey,
    () => {
      const canvas = document.createElement('canvas');
      const roundedUpRadius = Math.ceil(normalized / 2);
      canvas.width = roundedUpRadius * 2;
      canvas.height = roundedUpRadius * 2;
      const context = canvas.getContext('2d');
      if (context) {
        context.imageSmoothingEnabled = false;
        context.fillStyle = 'white';
        if (normalized <= 5) {
          let offset = 0;
          if (normalized % 2) offset = 1;
          context.fillStyle = guideColor;
          context.fillRect(offset, offset, normalized, normalized);
          context.fillStyle = 'white';
          context.fillRect(offset + 1, offset + 1, normalized - 2, normalized - 2);
        } else {
          fillStampDisc(context, normalized);
          context.fillStyle = guideColor;
          outlineStampDisc(context, normalized);
        }
      }
      return canvas;
    },
    ERASER_MARK_CACHE_LIMIT,
  );
}

function stampEraserAt(context: CanvasRenderingContext2D, mark: HTMLCanvasElement, size: number, x: number, y: number) {
  const roundedUpRadius = Math.ceil(size / 2);
  context.drawImage(mark, Math.trunc(x) - roundedUpRadius, Math.trunc(y) - roundedUpRadius);
}

/**
 * Fail-closed pre-validation for a whole eraser stroke, without touching the
 * canvas. Same caps as the brush (shared pixel walk); eraser-specific
 * messages. Returns the total stamp count when feasible. Editors must call
 * this (or catch the painter) BEFORE mutating pixels so a refusal leaves no
 * partial `destination-out` stamps.
 */
export function validateBitmapEraserStroke(points: Point[]): number {
  if (points.length > BITMAP_BRUSH_MAX_POINTS) {
    throw new RangeError(`bitmap eraser stroke too many points (fail-closed): ${points.length}`);
  }
  if (points.length <= 1) {
    if (points.length === 1) assertBrushPoint(points[0]!, 'points[0]');
    return points.length;
  }
  for (let index = 0; index < points.length; index += 1) {
    assertBrushPoint(points[index]!, `points[${index}]`);
  }
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const deltaX = Math.abs(Math.trunc(end.x) - Math.trunc(start.x));
    const deltaY = Math.abs(Math.trunc(end.y) - Math.trunc(start.y));
    if (deltaX > BITMAP_BRUSH_MAX_SEGMENT_STEPS || deltaY > BITMAP_BRUSH_MAX_SEGMENT_STEPS) {
      throw new RangeError(`bitmap eraser segment too long (fail-closed): dx=${deltaX} dy=${deltaY}`);
    }
    total += Math.max(deltaX, deltaY) + 1;
    if (total > BITMAP_BRUSH_MAX_STAMPS) {
      throw new RangeError(`bitmap eraser stroke too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} stamps`);
    }
  }
  return total;
}

/**
 * Stamp one validated eraser segment (inclusive endpoints). Atomic: validates
 * before the first `drawImage`, so a refusal erases nothing. Enables
 * incremental per-move painting (O(segment) per move) instead of replaying
 * the whole point list per move (O(N^2)).
 */
export function drawBitmapEraserSegment(
  context: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  size: number,
): void {
  const normalized = normalizeBrushDiameter(size);
  const mark = getBitmapEraserMark(normalized);
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.imageSmoothingEnabled = false;
  try {
    // Atomic gate inside save/restore (balanced on throw).
    assertBrushPoint(start, 'start');
    assertBrushPoint(end, 'end');
    const deltaX = Math.abs(Math.trunc(end.x) - Math.trunc(start.x));
    const deltaY = Math.abs(Math.trunc(end.y) - Math.trunc(start.y));
    if (deltaX > BITMAP_BRUSH_MAX_SEGMENT_STEPS || deltaY > BITMAP_BRUSH_MAX_SEGMENT_STEPS) {
      throw new RangeError(`bitmap eraser segment too long (fail-closed): dx=${deltaX} dy=${deltaY}`);
    }
    const expected = Math.max(deltaX, deltaY) + 1;
    if (expected > BITMAP_BRUSH_MAX_STAMPS) {
      throw new RangeError(`bitmap eraser stroke too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} stamps`);
    }
    forEachLinePoint(start, end, (x, y) => {
      stampEraserAt(context, mark, normalized, x, y);
    });
  } finally {
    context.restore();
  }
}

// Replay the whole drag from the saved base, matching scratch-paint's
// incremental `forEachLinePoint` stamping. Atomic: pre-validates before the
// first stamp so a refusal erases nothing. Callers restore the preview base
// first when redrawing an in-progress stroke; on `RangeError` they must
// restore the base again and report without committing history.
export function drawBitmapEraserStroke(
  context: CanvasRenderingContext2D,
  points: Point[],
  size: number,
) {
  if (points.length === 0) return;
  // Shared 1..100 clamp (was `Math.max(1, ~~size)` with no upper bound: a
  // huge finite size would allocate a huge mark canvas and OOM). Matches the
  // brush/line toolbar contract.
  const normalized = normalizeBrushDiameter(size);
  const mark = getBitmapEraserMark(normalized);
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.imageSmoothingEnabled = false;
  try {
    // Atomic gate inside save/restore (balanced on throw).
    validateBitmapEraserStroke(points);
    if (points.length === 1) {
      assertBrushPoint(points[0]!, 'points[0]');
      stampEraserAt(context, mark, normalized, points[0]!.x, points[0]!.y);
    } else {
      let stamped = 0;
      for (let index = 0; index < points.length - 1; index += 1) {
        forEachLinePoint(points[index]!, points[index + 1]!, (x, y) => {
          stamped += 1;
          if (stamped > BITMAP_BRUSH_MAX_STAMPS) {
            throw new RangeError(`bitmap eraser stroke too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} stamps`);
          }
          stampEraserAt(context, mark, normalized, x, y);
        });
      }
    }
  } finally {
    context.restore();
  }
}
