// Independent helper: closed fill outline for the vector brush.
//
// Gap: the current vector brush stores a centerline `<path stroke=...>` while
// scratch-paint style brushes produce a closed filled shape of constant width
// with round ends, later united with touching same-color shapes. This module
// only builds the closed outline from an existing input point list and a
// thickness. It is intentionally independent: pure geometry, no Paper.js, no
// DOM, no sanitizer, so it stays usable from unit tests and future Editor
// wiring without touching existing components.
//
// Original implementation for this repository (no copied brush code).
// Sharp interior joins use a clamped miter with a bevel fallback; round caps
// are exact semicircle arcs (`A` commands). Self-intersecting / sharply
// reversing polylines are not specially handled (see limits in the merge
// helper docs).

export type VectorBrushPoint = { x: number; y: number }

const DEDUP_EPSILON = 1e-9

function isFinitePoint(point: VectorBrushPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function deduplicatePoints(points: VectorBrushPoint[]): VectorBrushPoint[] {
  const out: VectorBrushPoint[] = []
  for (const point of points) {
    if (!isFinitePoint(point)) continue
    const prev = out[out.length - 1]
    if (prev && Math.hypot(point.x - prev.x, point.y - prev.y) <= DEDUP_EPSILON) continue
    out.push({ x: point.x, y: point.y })
  }
  return out
}

function formatSvgNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(3))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

/** Effective brush radius, matching the existing single-dot stamp (`max(1, w)/2`). */
export function vectorBrushFillRadius(strokeWidth: number): number {
  if (!Number.isFinite(strokeWidth)) return 0.5
  return Math.max(1, strokeWidth) / 2
}

function circlePathData(center: VectorBrushPoint, radius: number): string {
  const r = formatSvgNumber(radius)
  const leftX = formatSvgNumber(center.x - radius)
  const rightX = formatSvgNumber(center.x + radius)
  const cy = formatSvgNumber(center.y)
  return `M${leftX} ${cy}A${r} ${r} 0 1 0 ${rightX} ${cy}A${r} ${r} 0 1 0 ${leftX} ${cy}Z`
}

type Vec = { x: number; y: number }

function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y }
}

function length(v: Vec): number {
  return Math.hypot(v.x, v.y)
}

function normalize(v: Vec): Vec | undefined {
  const len = length(v)
  if (!(len > 0) || !Number.isFinite(len)) return undefined
  return { x: v.x / len, y: v.y / len }
}

function perp(v: Vec): Vec {
  return { x: -v.y, y: v.x }
}

/**
 * Build a closed `d` for a constant-width round-capped outline.
 * Returns `''` when no geometry can be built (no points / bad width).
 */
export function buildVectorBrushFillPathData(
  points: VectorBrushPoint[],
  strokeWidth: number,
): string {
  if (!Array.isArray(points) || points.length === 0) return ''
  if (!Number.isFinite(strokeWidth)) return ''
  const radius = vectorBrushFillRadius(strokeWidth)
  if (!(radius > 0)) return ''
  const clean = deduplicatePoints(points)
  if (clean.length === 0) return ''
  if (clean.length === 1) return circlePathData(clean[0]!, radius)

  const count = clean.length
  const dirs: Vec[] = []
  for (let i = 0; i < count - 1; i += 1) {
    const d = normalize(sub(clean[i + 1]!, clean[i]!))
    // After dedup every segment has non-zero length; guard anyway.
    dirs.push(d ?? { x: 1, y: 0 })
  }

  const left: Vec[] = []
  const right: Vec[] = []
  for (let i = 0; i < count; i += 1) {
    const center = clean[i]!
    let normal: Vec
    let scale = 1
    if (i === 0) {
      normal = perp(dirs[0]!)
    } else if (i === count - 1) {
      normal = perp(dirs[dirs.length - 1]!)
    } else {
      const prevNormal = perp(dirs[i - 1]!)
      const nextNormal = perp(dirs[i]!)
      const miter = { x: prevNormal.x + nextNormal.x, y: prevNormal.y + nextNormal.y }
      const miterLen = length(miter)
      if (miterLen < 1e-9) {
        // 180-degree reversal: fall back to the incoming side normal.
        normal = prevNormal
      } else {
        const unit = { x: miter.x / miterLen, y: miter.y / miterLen }
        const dot = unit.x * prevNormal.x + unit.y * prevNormal.y
        if (dot < 0.5) {
          // Sharp corner: clamp to a bevel using the averaged tangent normal
          // instead of an exploding miter spike.
          const tangent = normalize({
            x: dirs[i - 1]!.x + dirs[i]!.x,
            y: dirs[i - 1]!.y + dirs[i]!.y,
          })
          normal = tangent ? perp(tangent) : prevNormal
        } else {
          normal = unit
          scale = 1 / dot
        }
      }
    }
    const offset = radius * scale
    left.push({ x: center.x + normal.x * offset, y: center.y + normal.y * offset })
    right.push({ x: center.x - normal.x * offset, y: center.y - normal.y * offset })
  }

  const r = formatSvgNumber(radius)
  let d = `M${formatSvgNumber(left[0]!.x)} ${formatSvgNumber(left[0]!.y)}`
  for (let i = 1; i < left.length; i += 1) {
    d += `L${formatSvgNumber(left[i]!.x)} ${formatSvgNumber(left[i]!.y)}`
  }
  d += `A${r} ${r} 0 0 0 ${formatSvgNumber(right[right.length - 1]!.x)} ${formatSvgNumber(right[right.length - 1]!.y)}`
  for (let i = right.length - 2; i >= 0; i -= 1) {
    d += `L${formatSvgNumber(right[i]!.x)} ${formatSvgNumber(right[i]!.y)}`
  }
  d += `A${r} ${r} 0 0 0 ${formatSvgNumber(left[0]!.x)} ${formatSvgNumber(left[0]!.y)}Z`
  return d
}

export type VectorBrushFillMarkupOptions = {
  /** Closed outline from {@link buildVectorBrushFillPathData}. */
  pathData: string
  /** Solid fill color (e.g. `#ff0000`). */
  fill: string
  /** Opacity in the editor's 0-100 scale, matching `vectorBrushMarkup`. */
  opacity: number
}

function opacityValue(opacity: number): number {
  if (!Number.isFinite(opacity)) return 1
  return Math.max(0, Math.min(1, opacity / 100))
}

/**
 * Markup for the closed brush shape. Always `fill`-only (`stroke="none"`)
 * so a later boolean union sees solid filled geometry instead of a stroked
 * centerline. Returns `''` when `pathData` is empty.
 */
export function vectorBrushFillMarkup(options: VectorBrushFillMarkupOptions): string {
  const { pathData, fill, opacity } = options
  if (!pathData) return ''
  return `<path d="${pathData}" fill="${fill}" stroke="none" opacity="${opacityValue(opacity)}"/>`
}
