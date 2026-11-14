// Bitmap brush stamp logic: the brush paints with a pre-rendered stamp, one
// stamp per integer pixel, with drags interpolated pixel-by-pixel so fast
// moves stay connected. Small diameters are solid squares (pixel-art
// friendly); larger diameters reuse the crisp disc in `./bitmap-stamp` that
// the eraser shares, so the same diameter cancels exactly. The diameter is an
// integer number of canvas pixels, and every preview redraw replays the whole
// drag from the saved base image.
//
// This module only builds the stamp and replays strokes. Callers own the
// preview base (save/restore around the drag) and the costume history commit,
// so drawing preview, undo history, and the eraser path stay untouched.
import { fillStampDisc } from './bitmap-stamp';
import { BRUSH_MARK_CACHE_LIMIT, cacheCanvasMark } from './bounded-mark-cache';
import { BITMAP_BRUSH_MAX_SIZE, BITMAP_BRUSH_MIN_SIZE } from './paint-toolbar-sizes';

export const BITMAP_BRUSH_DEFAULT_SIZE = 10;

export type BitmapBrushPoint = { x: number; y: number };

/**
 * Fail-closed bounds for the integer pixel walk.
 *
 * The reference `forEachLinePoint` truncates with `~~` (int32 wrap) while this
 * module truncates with `Math.trunc`. Both agree bit-for-bit while every
 * coordinate satisfies `|coord| <= 2^31 - 1`; outside that range `~~` wraps
 * silently and `Math.trunc` preserves the magnitude (loop/OOM risk). The walk
 * below therefore refuses non-finite or out-of-range endpoints instead of
 * wrapping or hanging: callers get a `RangeError`, never a silent remap.
 */
export const BITMAP_BRUSH_MAX_COORD = 2147483647;
/**
 * Per-segment step cap: must cover the largest valid live canvas side
 * (`BITMAP_SOURCE_MAX_SIDE` / live-verify side cap = 65535) so a full-width
 * stroke on a feasible 60000x1 / 65535-wide canvas never throws. Clamped
 * Editor points always satisfy `dx,dy <= canvas side <= 65535`; anything
 * larger is outside every feasible canvas and fails closed. A 4096px canvas
 * diagonal is ~5793 steps, so 65535 is generous without opening an OOM loop.
 */
export const BITMAP_BRUSH_MAX_SEGMENT_STEPS = 65535;
/** Total stamp cap per stroke replay: blocks points-array / segment abuse without touching valid drags. */
export const BITMAP_BRUSH_MAX_STAMPS = 500000;
/** Points-array cap: pointer drags hold hundreds of points; 10k is generous. */
export const BITMAP_BRUSH_MAX_POINTS = 10000;

function assertBrushCoord(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > BITMAP_BRUSH_MAX_COORD) {
    throw new RangeError(`bitmap brush ${label} out of range (fail-closed): ${String(value)}`);
  }
}

export function assertBrushPoint(point: BitmapBrushPoint, label: string): void {
  assertBrushCoord(point.x, `${label}.x`);
  assertBrushCoord(point.y, `${label}.y`);
}

const brushMarkCache = new Map<string, HTMLCanvasElement>();

/** Diameter in whole canvas pixels, clamped to 1..100 (reference `bitBrushSize`). */
export function normalizeBrushDiameter(size: number): number {
  if (!Number.isFinite(size)) return 1;
  return Math.min(BITMAP_BRUSH_MAX_SIZE, Math.max(BITMAP_BRUSH_MIN_SIZE, Math.trunc(size)));
}

/** Canvas edge length for a stamp of the given diameter. */
export function bitmapBrushMarkEdge(diameter: number): number {
  const normalized = normalizeBrushDiameter(diameter);
  return Math.ceil(normalized / 2) * 2;
}

/**
 * Visit every integer pixel between two points (inclusive, 8-connected).
 * Classic Bresenham interpolation written for this module: endpoints are
 * truncated to integers and each step moves at most one pixel in x/y.
 * Fail-closed: non-finite or out-of-int32-range endpoints throw `RangeError`
 * (the reference `~~` would wrap silently); segments longer than
 * `BITMAP_BRUSH_MAX_SEGMENT_STEPS` throw instead of looping/OOMing.
 */
export function forEachBrushLinePoint(
  start: BitmapBrushPoint,
  end: BitmapBrushPoint,
  visit: (x: number, y: number) => void,
): void {
  assertBrushPoint(start, 'start');
  assertBrushPoint(end, 'end');
  let cursorX = Math.trunc(start.x);
  let cursorY = Math.trunc(start.y);
  const targetX = Math.trunc(end.x);
  const targetY = Math.trunc(end.y);
  const deltaX = Math.abs(targetX - cursorX);
  const deltaY = Math.abs(targetY - cursorY);
  if (deltaX > BITMAP_BRUSH_MAX_SEGMENT_STEPS || deltaY > BITMAP_BRUSH_MAX_SEGMENT_STEPS) {
    throw new RangeError(
      `bitmap brush segment too long (fail-closed): dx=${deltaX} dy=${deltaY}`,
    );
  }
  const stepX = cursorX < targetX ? 1 : -1;
  const stepY = cursorY < targetY ? 1 : -1;
  let error = deltaX - deltaY;

  visit(cursorX, cursorY);
  while (cursorX !== targetX || cursorY !== targetY) {
    const doubled = error * 2;
    if (doubled > -deltaY) {
      error -= deltaY;
      cursorX += stepX;
    }
    if (doubled < deltaX) {
      error += deltaX;
      cursorY += stepY;
    }
    visit(cursorX, cursorY);
  }
}

function paintSquareMark(context: CanvasRenderingContext2D, diameter: number): void {
  // Odd diameters are centered with a one-pixel offset so the stamp covers
  // exactly `diameter` pixels, matching the observed small-brush footprint.
  const offset = diameter % 2 === 1 ? 1 : 0;
  context.fillRect(offset, offset, diameter, diameter);
}

function paintCircleMark(context: CanvasRenderingContext2D, diameter: number): void {
  // Crisp pixel disc shared with the eraser: the stepper in `./bitmap-stamp`
  // fills integer `fillRect` spans, so the footprint cancels exactly at the
  // same diameter. The caller sets `fillStyle` to the brush color first.
  fillStampDisc(context, diameter);
}

/**
 * Pre-rendered brush stamp for a diameter/color pair. Small diameters are
 * squares, larger ones are filled circles. Stamps are cached because a drag
 * replays them once per interpolated pixel.
 */
export function getBitmapBrushMark(diameter: number, color: string): HTMLCanvasElement {
  const normalized = normalizeBrushDiameter(diameter);
  const cacheKey = `${normalized}:${color}`;
  return cacheCanvasMark(
    brushMarkCache,
    cacheKey,
    () => {
      const canvas = document.createElement('canvas');
      const edge = bitmapBrushMarkEdge(normalized);
      canvas.width = edge;
      canvas.height = edge;
      const context = canvas.getContext('2d');
      if (context) {
        context.imageSmoothingEnabled = false;
        context.fillStyle = color;
        if (normalized <= 5) {
          paintSquareMark(context, normalized);
        } else {
          paintCircleMark(context, normalized);
        }
      }
      return canvas;
    },
    BRUSH_MARK_CACHE_LIMIT,
  );
}

function stampBrushAt(
  context: CanvasRenderingContext2D,
  mark: HTMLCanvasElement,
  diameter: number,
  x: number,
  y: number,
): void {
  // Anchor the stamp so integer point (x, y) lands under the stamp center,
  // matching the observed `~~coord - ceil(size / 2)` placement.
  const radius = Math.ceil(diameter / 2);
  context.drawImage(mark, Math.trunc(x) - radius, Math.trunc(y) - radius);
}

/**
 * Stamp count for one segment without walking pixels: Bresenham visits
 * `max(dx,dy)+1` integer pixels (inclusive endpoints). Pure arithmetic, so
 * pre-validation stays O(segments) instead of O(stamps).
 */
export function bitmapBrushSegmentStampCount(start: BitmapBrushPoint, end: BitmapBrushPoint): number {
  assertBrushPoint(start, 'start');
  assertBrushPoint(end, 'end');
  const deltaX = Math.abs(Math.trunc(end.x) - Math.trunc(start.x));
  const deltaY = Math.abs(Math.trunc(end.y) - Math.trunc(start.y));
  if (deltaX > BITMAP_BRUSH_MAX_SEGMENT_STEPS || deltaY > BITMAP_BRUSH_MAX_SEGMENT_STEPS) {
    throw new RangeError(`bitmap brush segment too long (fail-closed): dx=${deltaX} dy=${deltaY}`);
  }
  return Math.max(deltaX, deltaY) + 1;
}

/**
 * Fail-closed pre-validation for a whole brush stroke, without touching the
 * canvas. Throws `RangeError` for the same unsupported inputs the painter
 * refuses (too many points, bad coords, oversized segment, too many stamps).
 * Editors must call this (or catch the painter) BEFORE mutating pixels so a
 * refusal leaves no partial stamps. Direct (unsupported public) callers get
 * the same throw from the painter itself, which validates first and paints
 * only after the whole stroke proves feasible (atomic: no partial mutation
 * on refusal).
 */
export function validateBitmapBrushStroke(points: BitmapBrushPoint[]): number {
  if (points.length > BITMAP_BRUSH_MAX_POINTS) {
    throw new RangeError(`bitmap brush stroke too many points (fail-closed): ${points.length}`);
  }
  if (points.length <= 1) {
    if (points.length === 1) assertBrushPoint(points[0]!, 'points[0]');
    return points.length;
  }
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    assertBrushPoint(points[index]!, `points[${index}]`);
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const deltaX = Math.abs(Math.trunc(end.x) - Math.trunc(start.x));
    const deltaY = Math.abs(Math.trunc(end.y) - Math.trunc(start.y));
    if (deltaX > BITMAP_BRUSH_MAX_SEGMENT_STEPS || deltaY > BITMAP_BRUSH_MAX_SEGMENT_STEPS) {
      throw new RangeError(`bitmap brush segment too long (fail-closed): dx=${deltaX} dy=${deltaY}`);
    }
    total += Math.max(deltaX, deltaY) + 1;
    if (total > BITMAP_BRUSH_MAX_STAMPS) {
      throw new RangeError(`bitmap brush stroke too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} stamps`);
    }
  }
  return total;
}

/**
 * Stamp one validated segment (inclusive endpoints) without touching other
 * pixels. Atomic: validates before the first `drawImage`, so a refusal
 * paints nothing. Editors use this for incremental per-move painting
 * (O(segment) per move, O(total) per stroke) instead of replaying the whole
 * point list per move (O(N^2)).
 */
export function drawBitmapBrushSegment(
  context: CanvasRenderingContext2D,
  start: BitmapBrushPoint,
  end: BitmapBrushPoint,
  diameter: number,
  color: string,
): void {
  const normalized = normalizeBrushDiameter(diameter);
  const mark = getBitmapBrushMark(normalized, color);
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.imageSmoothingEnabled = false;
  try {
    // Atomic gate inside save/restore (balanced on throw): no drawImage runs
    // when this throws.
    const expected = bitmapBrushSegmentStampCount(start, end);
    if (expected > BITMAP_BRUSH_MAX_STAMPS) {
      throw new RangeError(`bitmap brush stroke too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} stamps`);
    }
    forEachBrushLinePoint(start, end, (x, y) => {
      stampBrushAt(context, mark, normalized, x, y);
    });
  } finally {
    context.restore();
  }
}

/**
 * Replay a whole brush drag by stamping along every interpolated pixel.
 * Atomic: pre-validates the entire point list before the first stamp, so a
 * refusal paints nothing (no partial mutation). The caller restores the
 * preview base before calling during a drag so the visible stroke always
 * reflects the full point list from a clean base; on `RangeError` the caller
 * must restore the base again (the painter leaves the canvas untouched, but
 * an earlier preview of the same stroke may already be visible) and report
 * without committing history.
 */
export function drawBitmapBrushStroke(
  context: CanvasRenderingContext2D,
  points: BitmapBrushPoint[],
  diameter: number,
  color: string,
): void {
  if (points.length === 0) return;
  const normalized = normalizeBrushDiameter(diameter);
  const mark = getBitmapBrushMark(normalized, color);
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.imageSmoothingEnabled = false;
  try {
    // Atomic gate inside save/restore (balanced on throw): validates the
    // whole stroke before the first drawImage, so a refusal paints nothing.
    validateBitmapBrushStroke(points);
    if (points.length === 1) {
      assertBrushPoint(points[0]!, 'points[0]');
      stampBrushAt(context, mark, normalized, points[0]!.x, points[0]!.y);
    } else {
      let stamped = 0;
      for (let index = 0; index < points.length - 1; index += 1) {
        forEachBrushLinePoint(points[index]!, points[index + 1]!, (x, y) => {
          stamped += 1;
          if (stamped > BITMAP_BRUSH_MAX_STAMPS) {
            throw new RangeError(
              `bitmap brush stroke too long (fail-closed): >${BITMAP_BRUSH_MAX_STAMPS} stamps`,
            );
          }
          stampBrushAt(context, mark, normalized, x, y);
        });
      }
    }
  } finally {
    context.restore();
  }
}
