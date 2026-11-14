import { isFillInvisible } from './transparent-paint'
import type { PaintGradientKind } from './paint-colors'

/**
 * Bitmap rectangle / oval paint mode.
 *
 * `filled` paints the interior only (fill color / gradient).
 * `outlined` paints the contour only, but with the FILL color / gradient and
 * the shared bitmap brush size (scratch-paint `bitBrushSize`). The stroke
 * color and the outline width are ignored in both modes. This matches the
 * reference bitmap rectangle / ellipse behavior (`rect-tool.js` /
 * `oval-tool.js` `styleRect`/`styleOval` use a single `this.color` = fillColor
 * state for both passes, and `bit-rect-mode.jsx` / `bit-oval-mode.jsx` map
 * `thickness` from `bitBrushSize`).
 */
export type BitmapShapeMode = 'filled' | 'outlined'

export type BitmapShapeKind = 'rect' | 'oval'

export type BitmapShapeToggles = {
  fillTransparent: boolean
  secondaryTransparent: boolean
  strokeTransparent: boolean
}

export function isBitmapShapeMode(value: unknown): value is BitmapShapeMode {
  return value === 'filled' || value === 'outlined'
}

export function normalizeBitmapShapeMode(value: unknown): BitmapShapeMode {
  return value === 'outlined' ? 'outlined' : 'filled'
}

export type BitmapShapePaintPlan = {
  /** Paint the interior with the fill style. */
  paintFill: boolean
  /** Paint the contour with the stroke style. */
  paintStroke: boolean
  /** True when the gesture would change no pixels (skip history/save). */
  noop: boolean
}

/**
 * Decide which pass runs for a bitmap rect/oval gesture.
 *
 * Both modes paint with the FILL color / gradient (reference `styleRect` /
 * `styleOval` use one `this.color` for fill and outline alike):
 * - Filled paints the interior; no-op only when the fill itself is invisible
 *   (solid transparent, or a gradient with both ends transparent).
 * - Outlined strokes the contour with the same fill style and the shared
 *   bitmap brush size (`bitBrushSize`); no-op when the fill is invisible or
 *   the brush size is zero / not finite. The stroke transparency toggle and
 *   the outline width are ignored.
 */
export function resolveBitmapShapePaint(
  mode: BitmapShapeMode,
  toggles: BitmapShapeToggles,
  gradient: PaintGradientKind,
  brushSize: number,
): BitmapShapePaintPlan {
  const paintFill = !isFillInvisible(toggles.fillTransparent, toggles.secondaryTransparent, gradient)
  if (mode === 'outlined') {
    const width = Number.isFinite(brushSize) ? brushSize : 0
    const paintStroke = paintFill && width > 0
    return { paintFill: false, paintStroke, noop: !paintStroke }
  }
  return { paintFill, paintStroke: false, noop: !paintFill }
}

/**
 * Selection outline margin for a committed bitmap shape.
 *
 * Filled shapes end exactly at their box (1px for the dashed outline).
 * Outlined shapes extend half the shared brush size past the box on each
 * side (reference outline is `bitBrushSize` wide).
 */
export function resolveBitmapShapeSelectionPadding(mode: BitmapShapeMode, brushSize: number): number {
  if (mode === 'filled') return 1
  const width = Number.isFinite(brushSize) ? Math.max(0, brushSize) : 0
  return width / 2 + 1
}

export type BitmapShapeDrawStyle = {
  fillStyle: string | CanvasGradient
  strokeStyle: string
  lineWidth: number
}

/**
 * Paint one exclusive pass for a bitmap rect/oval box (`width`/`height` >= 0).
 * Filled draws the interior only; outlined strokes the contour only with the
 * shared brush size. The caller resolves `fillStyle` / `strokeStyle`
 * (including gradients and transparent handling) before calling: for
 * reference parity the outlined `strokeStyle` must be the FILL style and
 * `lineWidth` the shared brush size.
 */
export function paintBitmapRectOvalExclusive(
  context: CanvasRenderingContext2D,
  kind: BitmapShapeKind,
  x: number,
  y: number,
  width: number,
  height: number,
  mode: BitmapShapeMode,
  style: BitmapShapeDrawStyle,
): void {
  if (mode === 'filled') {
    context.fillStyle = style.fillStyle
    if (kind === 'rect') {
      context.fillRect(x, y, width, height)
      return
    }
    context.beginPath()
    context.ellipse(x + width / 2, y + height / 2, Math.max(1, width / 2), Math.max(1, height / 2), 0, 0, Math.PI * 2)
    context.fill()
    return
  }
  if (Number.isFinite(style.lineWidth) && style.lineWidth > 0) context.lineWidth = style.lineWidth
  context.strokeStyle = style.strokeStyle
  if (kind === 'rect') {
    context.strokeRect(x, y, width, height)
    return
  }
  context.beginPath()
  context.ellipse(x + width / 2, y + height / 2, Math.max(1, width / 2), Math.max(1, height / 2), 0, 0, Math.PI * 2)
  context.stroke()
}
