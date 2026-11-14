import {
  BITMAP_RES1_PAPER_TO_CSS_DENSITY,
  BITMAP_RES2_PAPER_TO_CSS_DENSITY,
  VECTOR_PAPER_TO_CSS_DENSITY,
} from './costume-viewport'
import { PAPER_OUTERMOST_ZOOM_LEVEL, PAPER_ZOOM_SAFE_MAX } from './paper-viewport-parity'

type Point = { x: number; y: number }

/** Reference tiny-shape budget: 2 screen px, divided by the live Paper zoom. */
export const SHAPE_COMMIT_TOLERANCE_SCREEN_PX = 2

/** Preview gate: hides the in-progress outline for clicks and jitter. */
export function isShapeDrag(start: Point, end: Point): boolean {
  return Math.abs(end.x - start.x) > 2 || Math.abs(end.y - start.y) > 2
}

/**
 * Modifier keys for rectangle / ellipse creation, mirroring scratch-paint:
 * Shift constrains to a square (rect) / circle (oval),
 * Alt draws from the center instead of corner to corner.
 */
export type ShapeModifierKeys = {
  shift?: boolean
  alt?: boolean
}

export type ShapeRect = { x: number; y: number; width: number; height: number }

/**
 * Paper zoom backing a shape drag from the live CSS viewport scale.
 *
 * `viewportScale` is the CSS `scale()` factor and `density` is the
 * surface-px-per-Paper-unit for the mode (vector 2.5, bitmap res2 1.0,
 * bitmap res1 0.5). The product is the on-screen Paper density
 * (`view.zoom` equivalent), floored at the reference outermost level so a
 * fully zoomed-out canvas still discards only truly tiny boxes.
 */
export function resolveShapePaperZoom(viewportScale: number, density: number): number {
  const scale = typeof viewportScale === 'number' && Number.isFinite(viewportScale) ? viewportScale : 1
  const perUnit = typeof density === 'number' && Number.isFinite(density) && density > 0 ? density : 1
  const zoom = scale * perUnit
  if (!Number.isFinite(zoom) || zoom <= 0) return 0.5
  return Math.max(PAPER_OUTERMOST_ZOOM_LEVEL, Math.min(PAPER_ZOOM_SAFE_MAX, zoom))
}

/** Paper zoom for a vector shape drag at this viewport scale. */
export function vectorShapePaperZoom(viewportScale: number): number {
  return resolveShapePaperZoom(viewportScale, VECTOR_PAPER_TO_CSS_DENSITY)
}

/** Paper zoom for a bitmap shape drag at this viewport scale and stored resolution. */
export function bitmapShapePaperZoom(viewportScale: number, storedResolution?: number): number {
  const density =
    storedResolution === 1
      ? BITMAP_RES1_PAPER_TO_CSS_DENSITY
      : storedResolution === 2
        ? BITMAP_RES2_PAPER_TO_CSS_DENSITY
        : 1
  return resolveShapePaperZoom(viewportScale, density)
}

/**
 * SVG document units per Paper unit (2x import). The vector edit surface is
 * the 2400x1800 workspace box for the 960x720 Paper board (surface px per
 * Paper unit 2.5 at CSS scale 1), while SVG document units map as
 * Paper = svg * 2 (surface = svg * 5, / 2.5). Area therefore scales by 4:
 * Paper area = (w_svg * 2) * (h_svg * 2) = 4 * w_svg * h_svg.
 */
export const SVG_TO_PAPER_SCALE = 2

/**
 * True when a normalized shape box is too small to keep, mirroring the
 * reference rect/oval tools: discard while `|width * height|` (in Paper
 * units) is below the 2-screen-px budget divided by the live Paper zoom.
 * A straight horizontal or vertical drag has zero area and is discarded;
 * Shift squares the box first (via `resolveShapeRect`), so a Shift drag
 * keeps the squared area.
 *
 * NOTE: inputs are Paper units. Vector callers pass SVG document units and
 * must convert first (see `shouldCommitShapeDrag`); 1 SVG unit = 2 Paper
 * units, so 1 SVG area = 4 Paper area.
 */
export function isTinyShapeBox(width: number, height: number, paperZoom: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return true
  const zoom =
    typeof paperZoom === 'number' && Number.isFinite(paperZoom) && paperZoom > 0 ? paperZoom : 0.5
  const threshold = SHAPE_COMMIT_TOLERANCE_SCREEN_PX / zoom
  return Math.abs(width * height) < threshold
}

/** Paper units per bitmap canvas px from the explicit stored resolution. */
export const BITMAP_RES1_PAPER_PER_CANVAS_PX = 2
export const BITMAP_RES2_PAPER_PER_CANVAS_PX = 1

/** Paper units covered by 1 bitmap canvas px (res1 kept 480-wide => k=2, else k=1). */
export function bitmapPaperPerCanvasPx(storedResolution?: number): number {
  return storedResolution === 1 ? BITMAP_RES1_PAPER_PER_CANVAS_PX : BITMAP_RES2_PAPER_PER_CANVAS_PX
}

/**
 * Commit gate for a bitmap rect/oval drag in canvas px (floats, clamped).
 *
 * Reference parity with bit-tools rect/oval: Shift squares first via
 * `resolveShapeRect`, then the squared box is measured as a Paper area
 * `|w*k * h*k|` against the strict budget `2 / paperZoom` where
 * `k = storedResolution === 1 ? 2 : 1` (res1 1 canvas px = 2 Paper units,
 * res2 1 canvas px = 1 Paper unit) and
 * `paperZoom = bitmapShapePaperZoom(viewportScale, storedResolution)`.
 * Clicks, sub-pixel jitter, and axis-zero drags without Shift fall below the
 * budget (discard: no selection, no history, preview untouched); the
 * 2x2 (res2) / 1x1 (res1) boundary commits because `<` is strict.
 * Bitmap line keeps the legacy `isShapeDrag` gate and never calls this.
 */
export function shouldCommitBitmapShapeDrag(
  startCanvas: Point,
  currentCanvas: Point,
  modifiers: ShapeModifierKeys = {},
  storedResolution?: number,
  viewportScale = 1,
): boolean {
  const rect = resolveShapeRect(startCanvas, currentCanvas, modifiers)
  const k = bitmapPaperPerCanvasPx(storedResolution)
  const zoom = bitmapShapePaperZoom(viewportScale, storedResolution)
  return !isTinyShapeBox(rect.width * k, rect.height * k, zoom)
}

/**
 * Commit gate for a rect/oval drag. Inputs `start`/`current` are SVG document
 * units (vectorBrushPointFromEvent domain, 0..480). The Shift square (and Alt
 * centering) apply first through `resolveShapeRect`, then the squared SVG box
 * is converted to Paper units (Paper = svg * 2 per axis, area x4) and measured
 * against the zoom-scaled budget `2 / paperZoom`. Clicks, sub-pixel jitter,
 * and axis-zero drags without Shift fall below the budget and stay history-free
 * with no selection change; a Shift drag keeps the squared area even when one
 * raw axis is zero.
 *
 * Surface-scale cross-check: on screen, 1 SVG unit covers
 * `5 * viewportScale` screen px (VECTOR_WORKSPACE_SCALE * CSS scale) while
 * 1 Paper unit covers `paperZoom` screen px (`view.zoom` equivalent
 * `viewportScale * 2.5`). Both give the same on-screen density
 * (`5 * s / 2 = 2.5 * s`), so the SVG->Paper x2 conversion and the
 * `viewportScale * 2.5` zoom stay in the same loop.
 */
export function shouldCommitShapeDrag(
  start: Point,
  current: Point,
  modifiers: ShapeModifierKeys = {},
  paperZoom = 1,
): boolean {
  const rect = resolveShapeRect(start, current, modifiers)
  return !isTinyShapeBox(
    rect.width * SVG_TO_PAPER_SCALE,
    rect.height * SVG_TO_PAPER_SCALE,
    paperZoom,
  )
}

/** Pick modifier flags out of a pointer/keyboard/mouse event. Pure helper for call-site wiring. */
export function readShapeModifiers(event: { shiftKey?: boolean; altKey?: boolean }): ShapeModifierKeys {
  return { shift: event.shiftKey === true, alt: event.altKey === true }
}

/**
 * Apply the Shift square/circle constraint to a drag end point, mirroring
 * scratch-paint's getSquareDimensions: the constrained side is
 * `max(|dx|, |dy|)` with each axis keeping its original drag quadrant.
 * A zero offset keeps its direction as positive so a straight vertical or
 * horizontal drag still produces a square extending to the lower right,
 * exactly like the reference.
 */
export function constrainShapeEnd(start: Point, current: Point, modifiers: ShapeModifierKeys): Point {
  if (!modifiers.shift) return { x: current.x, y: current.y }
  const dx = current.x - start.x
  const dy = current.y - start.y
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  // Mirror getSquareDimensions: a zero offset counts as positive so the
  // square keeps a deterministic quadrant instead of pinning one axis.
  const signX = dx === 0 ? 1 : Math.sign(dx)
  const signY = dy === 0 ? 1 : Math.sign(dy)
  return {
    x: start.x + signX * side,
    y: start.y + signY * side,
  }
}

/**
 * Resolve a rectangle/ellipse (oval) bounding box from a shape drag,
 * mirroring scratch-paint's rect/oval tools. With Alt the start point is
 * the center and the box keeps the dragged dimensions (Shift still squares
 * them first); otherwise the box spans start to (Shift-constrained) current.
 * The result is always normalized (`width`/`height` >= 0) and shared by
 * rect and oval rendering since an oval is drawn inside the same box.
 */
export function resolveShapeRect(start: Point, current: Point, modifiers: ShapeModifierKeys = {}): ShapeRect {
  const end = constrainShapeEnd(start, current, modifiers)
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (modifiers.alt) {
    // Reference behavior: the drag dimensions are unchanged and the start
    // point becomes the center, so halve each side around the start.
    const width = Math.abs(dx)
    const height = Math.abs(dy)
    return {
      x: start.x - width / 2,
      y: start.y - height / 2,
      width,
      height,
    }
  }
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(dx),
    height: Math.abs(dy),
  }
}
