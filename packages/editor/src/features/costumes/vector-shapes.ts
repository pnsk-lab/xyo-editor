import { escapeXml } from '../../lib/editor-utils'

export type VectorShapeKind = 'rect' | 'oval' | 'line' | 'text'
export type VectorPaintStyle = { defs: string; fill: string }

type VectorRect = { x: number; y: number; width: number; height: number }

type ShapeMarkupOptions = {
  shape: VectorShapeKind
  width: number
  height: number
  center?: { x: number; y: number }
  paint: VectorPaintStyle
  strokeColor: string
  strokeWidth: number
  opacity: number
  text: string
}

export function vectorShapeMarkup(options: ShapeMarkupOptions) {
  const { shape, width, height, center, paint, strokeColor, strokeWidth, opacity, text } = options
  const cx = typeof center?.x === 'number' ? center.x : width / 2
  const cy = typeof center?.y === 'number' ? center.y : height / 2
  const clampedOpacity = opacityValue(opacity)
  const scaledStroke = Math.max(0, strokeWidth)
  const lineStroke = Math.max(1, strokeWidth * 2)

  if (shape === 'rect') {
    return `${paint.defs}<rect x="${cx - 36}" y="${cy - 36}" width="72" height="72" rx="8" fill="${paint.fill}" stroke="${strokeColor}" stroke-width="${scaledStroke}" opacity="${clampedOpacity}"/>`
  }
  if (shape === 'line') {
    return `<path d="M${cx - 34} ${cy + 26} C${cx - 20} ${cy - 30} ${cx + 14} ${cy - 30} ${cx + 34} ${cy + 6}" fill="none" stroke="${strokeColor}" stroke-width="${lineStroke}" stroke-linecap="round" opacity="${clampedOpacity}"/>`
  }
  if (shape === 'text') {
    return `${paint.defs}<text x="${cx}" y="${cy + 8}" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="${paint.fill}" stroke="${strokeColor}" stroke-width="${Math.max(0, strokeWidth / 4)}" opacity="${clampedOpacity}">${escapeXml(text)}</text>`
  }
  return `${paint.defs}<ellipse cx="${cx}" cy="${cy}" rx="38" ry="34" fill="${paint.fill}" stroke="${strokeColor}" stroke-width="${scaledStroke}" opacity="${clampedOpacity}"/>`
}

type ShapeInRectOptions = {
  shape: Exclude<VectorShapeKind, 'text'>
  rect: VectorRect
  paint: VectorPaintStyle
  strokeColor: string
  strokeWidth: number
  opacity: number
}

export function vectorShapeInRectMarkup(options: ShapeInRectOptions) {
  const { shape, rect, paint, strokeColor, strokeWidth, opacity } = options
  const clampedOpacity = opacityValue(opacity)
  const scaledStroke = Math.max(0, strokeWidth)
  if (shape === 'rect') {
    return `${paint.defs}<rect x="${rect.x}" y="${rect.y}" width="${Math.max(1, rect.width)}" height="${Math.max(1, rect.height)}" rx="8" fill="${paint.fill}" stroke="${strokeColor}" stroke-width="${scaledStroke}" opacity="${clampedOpacity}"/>`
  }
  if (shape === 'oval') {
    return `${paint.defs}<ellipse cx="${rect.x + rect.width / 2}" cy="${rect.y + rect.height / 2}" rx="${Math.max(1, rect.width / 2)}" ry="${Math.max(1, rect.height / 2)}" fill="${paint.fill}" stroke="${strokeColor}" stroke-width="${scaledStroke}" opacity="${clampedOpacity}"/>`
  }
  return `<path d="M${rect.x} ${rect.y} L${rect.x + rect.width} ${rect.y + rect.height}" fill="none" stroke="${strokeColor}" stroke-width="${Math.max(1, strokeWidth * 2)}" stroke-linecap="round" opacity="${clampedOpacity}"/>`
}

type BrushMarkupOptions = {
  path: string
  strokeColor: string
  strokeWidth: number
  opacity: number
}

export function vectorBrushMarkup(options: BrushMarkupOptions) {
  const { path, strokeColor, strokeWidth, opacity } = options
  return `<path d="${path}" fill="none" stroke="${strokeColor}" stroke-width="${Math.max(1, strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacityValue(opacity)}"/>`
}

function opacityValue(opacity: number) {
  return Math.max(0, Math.min(1, opacity / 100))
}
