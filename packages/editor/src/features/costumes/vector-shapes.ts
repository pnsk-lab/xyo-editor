import { escapeXml } from '../../lib/editor-utils'
import {
  vectorLineSvgForUi,
  vectorStrokeUiToSvg,
  vectorTextSvgForUi,
} from './vector-stroke-scale'

export type VectorShapeKind = 'rect' | 'oval' | 'line' | 'text'
export type VectorPaintStyle = { defs: string; fill: string }
/** Stroke paint for vector outlines. `{ defs, stroke }` mirrors `VectorPaintStyle`: solid paints emit `{ defs: '', stroke: <css|'none'> }`, gradients emit defs + `stroke="url(#id)"`. */
export type VectorStrokePaintStyle = { defs: string; stroke: string }

type VectorRect = { x: number; y: number; width: number; height: number }

type VectorPoint = { x: number; y: number }

/**
 * Build the rect stored for a line-tool drag. Unlike rect/oval (which use a
 * normalized bounding box), a line keeps the drag vector: `x`/`y` is the
 * drag start and `width`/`height` are the signed deltas to the drag current
 * point. A reverse drag therefore yields a different rect than the forward
 * drag instead of collapsing to the same normalized box.
 */
export function vectorLineRect(start: VectorPoint, end: VectorPoint): VectorRect {
  return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y }
}

/** Resolve the two endpoints of a stored line rect, preserving drag direction. */
export function vectorLineEndpoints(rect: VectorRect): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: normalizeZero(rect.x),
    y1: normalizeZero(rect.y),
    x2: normalizeZero(rect.x + rect.width),
    y2: normalizeZero(rect.y + rect.height),
  }
}

function normalizeZero(value: number) {
  return value === 0 ? 0 : value
}

type ShapeMarkupOptions = {
  shape: VectorShapeKind
  width: number
  height: number
  center?: { x: number; y: number }
  paint: VectorPaintStyle
  strokeColor: string
  /** Independent stroke gradient paint. When given, `stroke` wins over `strokeColor` and `defs` is prepended without touching `paint.defs` (fill defs survive byte-identical). */
  strokePaint?: VectorStrokePaintStyle
  strokeWidth: number
  opacity: number
  text: string
}

export function vectorShapeMarkup(options: ShapeMarkupOptions) {
  const { shape, width, height, center, paint, strokeWidth, opacity, text } = options
  const strokePaint = options.strokePaint ?? { defs: '', stroke: options.strokeColor }
  const combinedDefs = `${paint.defs}${strokePaint.defs}`
  const stroke = strokePaint.stroke
  const cx = typeof center?.x === 'number' ? center.x : width / 2
  const cy = typeof center?.y === 'number' ? center.y : height / 2
  const clampedOpacity = opacityValue(opacity)
  // Scratch parity: toolbar UI widths are Paper units; stored SVG is half
  // (`vector-stroke-scale.ts`). Rect/oval keep a 0 floor (UI 0 = no outline);
  // line uses the Paper-unit floor `max(1, UI) / 2` (UI 1 -> SVG 0.5).
  // Text stores `UI / 2` for new no-transform markup (Scratch PointText keeps
  // `SVG = UI` verbatim + `scale(0.5)` geometry for a `UI / 2` stage look, so
  // transform-free markup halves for the same visual; scaled/complex text is
  // protected to verbatim on read/write, see `vector-stroke-scale.ts`).
  const scaledStroke = vectorStrokeUiToSvg(Math.max(0, strokeWidth))
  const lineStroke = vectorLineSvgForUi(strokeWidth)

  if (shape === 'rect') {
    return `${combinedDefs}<rect x="${cx - 36}" y="${cy - 36}" width="72" height="72" fill="${paint.fill}" stroke="${stroke}" stroke-width="${scaledStroke}" opacity="${clampedOpacity}"/>`
  }
  if (shape === 'line') {
    return `${strokePaint.defs}<path d="M${cx - 34} ${cy + 26} C${cx - 20} ${cy - 30} ${cx + 14} ${cy - 30} ${cx + 34} ${cy + 6}" fill="none" stroke="${stroke}" stroke-width="${lineStroke}" stroke-linecap="round" opacity="${clampedOpacity}"/>`
  }
  if (shape === 'text') {
    return `${combinedDefs}<text x="${cx}" y="${cy + 8}" text-anchor="middle" font-family="Sans Serif" font-size="40" font-weight="700" fill="${paint.fill}" stroke="${stroke}" stroke-width="${vectorTextSvgForUi(strokeWidth)}" opacity="${clampedOpacity}">${escapeXml(text)}</text>`
  }
  return `${combinedDefs}<ellipse cx="${cx}" cy="${cy}" rx="38" ry="34" fill="${paint.fill}" stroke="${stroke}" stroke-width="${scaledStroke}" opacity="${clampedOpacity}"/>`
}

type ShapeInRectOptions = {
  shape: Exclude<VectorShapeKind, 'text'>
  /**
   * Bounding box for rect/oval (`width`/`height` >= 0). For line, the rect
   * produced by {@link vectorLineRect}: `x`/`y` is the drag start and
   * `width`/`height` are signed deltas preserving drag direction.
   */
  rect: VectorRect
  paint: VectorPaintStyle
  strokeColor: string
  /** Independent stroke gradient paint (same precedence as click stamps: wins over `strokeColor`, defs prepended without touching fill defs). */
  strokePaint?: VectorStrokePaintStyle
  strokeWidth: number
  opacity: number
}

export function vectorShapeInRectMarkup(options: ShapeInRectOptions) {
  const { shape, rect, paint, strokeWidth, opacity } = options
  const strokePaint = options.strokePaint ?? { defs: '', stroke: options.strokeColor }
  const combinedDefs = `${paint.defs}${strokePaint.defs}`
  const stroke = strokePaint.stroke
  const clampedOpacity = opacityValue(opacity)
  // Same parity scale as click stamps (see `vectorShapeMarkup`).
  const scaledStroke = vectorStrokeUiToSvg(Math.max(0, strokeWidth))
  if (shape === 'rect') {
    return `${combinedDefs}<rect x="${rect.x}" y="${rect.y}" width="${Math.max(1, rect.width)}" height="${Math.max(1, rect.height)}" fill="${paint.fill}" stroke="${stroke}" stroke-width="${scaledStroke}" opacity="${clampedOpacity}"/>`
  }
  if (shape === 'oval') {
    return `${combinedDefs}<ellipse cx="${rect.x + rect.width / 2}" cy="${rect.y + rect.height / 2}" rx="${Math.max(1, rect.width / 2)}" ry="${Math.max(1, rect.height / 2)}" fill="${paint.fill}" stroke="${stroke}" stroke-width="${scaledStroke}" opacity="${clampedOpacity}"/>`
  }
  const endpoints = vectorLineEndpoints(rect)
  return `${strokePaint.defs}<path d="M${endpoints.x1} ${endpoints.y1} L${endpoints.x2} ${endpoints.y2}" fill="none" stroke="${stroke}" stroke-width="${vectorLineSvgForUi(strokeWidth)}" stroke-linecap="round" opacity="${clampedOpacity}"/>`
}

type BrushMarkupOptions = {
  path: string
  strokeColor: string
  strokeWidth: number
  opacity: number
}

export function vectorBrushMarkup(options: BrushMarkupOptions) {
  const { path, strokeColor, strokeWidth, opacity } = options
  // Legacy stroke brush (path with outline): line-like parity scale with the
  // Paper-unit floor. The live vector brush is fill-based and untouched.
  return `<path d="${path}" fill="none" stroke="${strokeColor}" stroke-width="${vectorLineSvgForUi(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacityValue(opacity)}"/>`
}

function opacityValue(opacity: number) {
  return Math.max(0, Math.min(1, opacity / 100))
}
