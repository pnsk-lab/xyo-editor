// Paint toolbar size limits shared by the bitmap/vector toolbar.
//
// Reference behavior (read from `.tmp/scratch-editor/...`, no code copied):
// - vector brush has its OWN size 1..100 defaulting to 10
//   (`reducers/brush-mode.js`);
// - bitmap brush/line/outlined-contour share `bitBrushSize` 1..100 default 10
//   (`mode-tools.jsx`, `reducers/bit-brush-size.js`);
// - vector stroke width is 0..100 (`reducers/stroke-width.js`
//   `MAX_STROKE_WIDTH = 100`);
// - stroke controls are disabled while BRUSH/TEXT/FILL is active and fill is
//   disabled while LINE is active.
//
// This module only holds facts (numbers) and pure clamps/predicates so unit
// tests and both Svelte shells share one frame. DOM, history, and painting
// stay with the callers.

export const VECTOR_BRUSH_DEFAULT_SIZE = 10;
export const VECTOR_BRUSH_MIN_SIZE = 1;
export const VECTOR_BRUSH_MAX_SIZE = 100;

export const BITMAP_BRUSH_MIN_SIZE = 1;
export const BITMAP_BRUSH_MAX_SIZE = 100;

export const STROKE_WIDTH_MIN = 0;
export const STROKE_WIDTH_MAX = 100;

/** Vector brush diameter in whole canvas units, at least 1 and at most 100. */
export function normalizeVectorBrushSize(value: number): number {
  if (!Number.isFinite(value)) return VECTOR_BRUSH_DEFAULT_SIZE;
  return Math.min(VECTOR_BRUSH_MAX_SIZE, Math.max(VECTOR_BRUSH_MIN_SIZE, Math.trunc(value)));
}

/** Bitmap brush/line/outlined-contour diameter in whole canvas pixels, 1..100. */
export function normalizeBitmapBrushSize(value: number): number {
  if (!Number.isFinite(value)) return VECTOR_BRUSH_DEFAULT_SIZE;
  return Math.min(BITMAP_BRUSH_MAX_SIZE, Math.max(BITMAP_BRUSH_MIN_SIZE, Math.trunc(value)));
}

/** Vector stroke width in whole units, 0..100 (0 keeps the outline slot, like the reference). */
export function clampStrokeWidth(value: number): number {
  if (!Number.isFinite(value)) return STROKE_WIDTH_MIN;
  return Math.min(STROKE_WIDTH_MAX, Math.max(STROKE_WIDTH_MIN, value));
}

export type VectorToolbarTool = 'select' | 'reshape' | 'brush' | 'eraser' | 'fill' | 'rect' | 'oval' | 'line' | 'text';

export type BitmapToolbarTool = 'select' | 'brush' | 'eraser' | 'fill' | 'text' | 'line' | 'oval' | 'rect';

export type BitmapShapeMode = 'filled' | 'outlined';

/** Reference parity: BRUSH/TEXT/FILL disable the stroke side (brush uses its own size). */
export function isVectorStrokeDisabled(mode: 'bitmap' | 'vector', tool: VectorToolbarTool): boolean {
  if (mode !== 'vector') return false;
  return tool === 'brush' || tool === 'text' || tool === 'fill';
}

/** Reference parity: LINE disables the fill side (a line has no interior). */
export function isVectorFillDisabled(mode: 'bitmap' | 'vector', tool: VectorToolbarTool): boolean {
  if (mode !== 'vector') return false;
  return tool === 'line';
}

// Bitmap toolbar visibility (read from `.tmp/scratch-editor/...`, no code copied):
// - the bitmap top row shows the fill indicator only; there is no stroke
//   color/width control (`paint-editor.jsx` bitmap branch). Stroke state
//   (color/width/gradient) survives in the shell but stays hidden in bitmap.
// - the shared brush/thickness slider (`bitBrushSize` 1..100) appears for
//   brush + line always, and for rect/oval only while outlined (filled hides
//   it). Select/fill/text/eraser show no brush slider; eraser has its own
//   size control (`mode-tools.jsx` per-mode branches).

/** Bitmap stroke/outline controls are vector-only; bitmap never shows them. */
export function isBitmapStrokeControlsVisible(mode: 'bitmap' | 'vector'): boolean {
  return mode === 'vector';
}

/** Shared bitmap brush/thickness slider visibility per tool + shape mode. */
export function isBitmapBrushSizeVisible(tool: BitmapToolbarTool, shapeMode: BitmapShapeMode): boolean {
  if (tool === 'brush' || tool === 'line') return true;
  if (tool === 'rect' || tool === 'oval') return shapeMode === 'outlined';
  return false;
}
