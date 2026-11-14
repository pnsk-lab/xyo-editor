import type { VectorObjectInfo } from '../../lib/editor-types'
import { editableVectorUnits } from './vector-svg'
import { duplicateVectorUnits } from './vector-move-drag'
import { prependMoveTranslate, toNativeMoveDelta } from './vector-move-translate'

/**
 * Map a world-space drag total into a unit's parent (native) frame.
 * Mirrors the commit path (`moveVectorElementBy` → ancestor-inverse mapping):
 * a unit nested under a transformed wrapper (e.g. `<g transform="scale(2)">`)
 * must be prepended with the inverse-mapped translate, otherwise the preview
 * would move `L * total` world units while the commit moves `total` (and the
 * world-space outline layer, which shifts arithmetically, would diverge from
 * the painted art until pointerup). Returns `null` for singular/non-finite
 * ancestors — the commit refuses those units with no DOM write, so the
 * preview skips them identically instead of painting a phantom move.
 */
function nativePreviewDelta(element: Element, total: { x: number; y: number }): { x: number; y: number } | null {
  const mapped = toNativeMoveDelta(element, total.x, total.y)
  if (!mapped) return null
  return { x: mapped.dx, y: mapped.dy }
}

/**
 * Cheap local move preview: apply the absolute drag total to the source
 * snapshot WITHOUT Paper.js, hashing, or any VM write.
 *
 * Each selected unit gets a prepended `translate(native)` where `native` is
 * the world total mapped into the unit's parent frame (identity for the
 * common top-level case). Group parity holds: the unit node is preserved,
 * children untouched, document order stable. This is visually exact in SVG
 * (translation composes) and costs one DOM parse + serialize — orders of
 * magnitude cheaper than the per-move path it replaces
 * (`currentSvgDocument` load + per-element Paper import/export + runtime
 * viewBox + TextEncoder/storeAsset hashing + `paperVectorObjectList` +
 * `refreshCostumePreview` double list).
 *
 * The final pointerup commit goes through the same unified
 * `moveVectorElementBy` (surgical `translate`) + a single validated CAS so
 * preview and commit bytes are identical (no snap) and Undo/Redo stay
 * byte-exact; the preview itself is display-only and never touches history.
 */
export function buildVectorMovePreviewSvg(
  sourceSvgText: string,
  selection: readonly number[],
  total: { x: number; y: number },
  opts: { duplicate?: boolean } = {},
): { svgText: string; selection: number[] } | undefined {
  if (!Number.isFinite(total.x) || !Number.isFinite(total.y)) return undefined
  if (Math.abs(total.x) < 1e-9 && Math.abs(total.y) < 1e-9 && !opts.duplicate) return undefined
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(sourceSvgText, 'image/svg+xml')
  } catch {
    return undefined
  }
  const svg = doc.documentElement
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') return undefined
  if (doc.getElementsByTagName('parsererror').length > 0) return undefined
  let units = editableVectorUnits(svg)
  let active = [...new Set(selection)].filter((i) => Number.isInteger(i) && i >= 0 && i < units.length)
  if (active.length === 0) return undefined
  if (opts.duplicate) {
    const clones = duplicateVectorUnits(svg, active)
    if (clones.length === 0) return undefined
    units = editableVectorUnits(svg)
    active = clones
  }
  const isZero = Math.abs(total.x) < 1e-9 && Math.abs(total.y) < 1e-9
  if (isZero && !opts.duplicate) return undefined
  if (!isZero) {
    let applied = 0
    for (const index of active) {
      const element = units[index]
      if (!element) continue
      const native = nativePreviewDelta(element, total)
      if (!native) continue
      if (Math.abs(native.x) < 1e-12 && Math.abs(native.y) < 1e-12) {
        applied += 1
        continue
      }
      try {
        if (!prependMoveTranslate(element, total.x, total.y)) return undefined
        applied += 1
      } catch {
        return undefined
      }
    }
    // Every selected unit refused (singular ancestors): paint nothing so the
    // Editor restores the base instead of flashing a move the commit will
    // refuse (no history entry either way).
    if (applied === 0) return undefined
  }
  try {
    return { svgText: new XMLSerializer().serializeToString(doc.documentElement), selection: [...active].sort((a, b) => a - b) }
  } catch {
    return undefined
  }
}

/**
 * Shift cached object bounds arithmetically for the outline layer.
 * No Paper re-measure: translation preserves width/height exactly.
 * When `previewSelection` names clone indices beyond `objects` (Alt
 * duplicate preview), those entries are synthesized as shifted copies of
 * their source bounds so the blue boxes track the previewed artwork.
 *
 * Exactness (no approximation): a world-space translate shifts document-space
 * bounds and Paper document-space points by exactly `total`, regardless of
 * rotation, ancestor transforms, or paint. Raw geometry attributes (`x`/`y`
 * on rect/image/text/circle/ellipse) are intentionally left untouched: the
 * commit prepends a parent-frame `translate` so those attributes never move
 * (only `transform` does). Path-like/`g` units expose world bounds as their
 * `x`/`y`, so those shift with the bounds. Width/height, rotation, paint,
 * and cross-refs are translation-invariant and preserved verbatim, so
 * `userSpaceOnUse` gradients/clips ride identically to the Paper path.
 */
const WORLD_GEOMETRY_TAGS = new Set(['path', 'polygon', 'polyline', 'line', 'use', 'g', 'svg'])

/**
 * Recompute the index-derived list label after a unit moved to a new
 * positional index (Alt-duplicate interleaving shifts originals right and
 * appends clones between them). Mirrors `vectorObjectLabel`
 * (`vector-svg.ts`): `N. tag`, or `N. text: <first-18-chars>` for text units
 * carrying content. Spreading a stale label would show duplicate/wrong
 * numbers in the object list until the next full reload.
 */
function relabelVectorUnitForIndex(object: VectorObjectInfo, index: number): VectorObjectInfo {
  const tag = (object.tag ?? '').toLowerCase()
  let label: string
  if (tag === 'text' && typeof object.text === 'string' && object.text) {
    const short = object.text.split('\n').map((line) => line.trim()).filter(Boolean).join(' ').slice(0, 18)
    label = short ? `${index + 1}. ${tag}: ${short}` : `${index + 1}. ${tag}`
  } else {
    label = `${index + 1}. ${tag}`
  }
  if (object.label === label) return object
  return { ...object, label }
}

function shiftObjectForMove(object: VectorObjectInfo, total: { x: number; y: number }): VectorObjectInfo {
  const boundsX = (object.boundsX ?? object.x ?? 0) + total.x
  const boundsY = (object.boundsY ?? object.y ?? 0) + total.y
  let points = object.points
  if (points && points.length > 0 && (total.x !== 0 || total.y !== 0)) {
    points = points.map((point) => ({ ...point, x: point.x + total.x, y: point.y + total.y }))
  }
  const tag = (object.tag ?? '').toLowerCase()
  if (WORLD_GEOMETRY_TAGS.has(tag) && object.x !== undefined && object.y !== undefined) {
    return { ...object, boundsX, boundsY, x: object.x + total.x, y: object.y + total.y, ...(points ? { points } : {}) }
  }
  return { ...object, boundsX, boundsY, ...(points ? { points } : {}) }
}
export function shiftVectorMoveBounds(
  objects: VectorObjectInfo[],
  selection: readonly number[],
  total: { x: number; y: number },
  opts: { duplicated?: boolean; sources?: readonly number[] } = {},
): VectorObjectInfo[] {
  if (Math.abs(total.x) < 1e-9 && Math.abs(total.y) < 1e-9) return objects
  if (opts.duplicated) {
    // Alt-duplicate preview: originals stay, clones appear shifted.
    // `duplicateVectorUnits` inserts each clone DIRECTLY AFTER its source
    // (interleaved, in ascending source order), so the post-duplicate list is
    // NOT the base with clones appended: every original at old index `j`
    // moves to `j + #{sources < j}`. Rebuild that exact layout (fail-closed:
    // any validation miss returns the input so the caller falls back to the
    // full Paper list). Map clones to sources by sorted order
    // (duplicateVectorUnits clones one per source, in source order).
    const sources = [...new Set(opts.sources ?? [])].sort((a, b) => a - b)
    const clones = [...new Set(selection)].sort((a, b) => a - b)
    if (clones.length === 0 || clones.length > sources.length) return objects
    if (!clones.every((index) => Number.isInteger(index) && index >= 0)) return objects
    if (!sources.every((index) => Number.isInteger(index) && index >= 0)) return objects
    const byIndex = new Map(objects.map((object) => [object.index, object]))
    const rebuiltLength = objects.length + clones.length
    // Every clone index must land inside the rebuilt list.
    if (!clones.every((index) => index < rebuiltLength)) return objects
    const cloneSet = new Set(clones)
    const out: (VectorObjectInfo | undefined)[] = new Array(rebuiltLength).fill(undefined)
    for (const object of objects) {
      const oldIndex = object.index
      if (!Number.isInteger(oldIndex) || oldIndex < 0) return objects
      const shiftedPast = sources.filter((source) => source < oldIndex).length
      const nextIndex = oldIndex + shiftedPast
      if (nextIndex < 0 || nextIndex >= rebuiltLength || cloneSet.has(nextIndex)) return objects
      if (out[nextIndex] !== undefined) return objects
      out[nextIndex] = relabelVectorUnitForIndex({ ...object, index: nextIndex }, nextIndex)
    }
    for (let i = 0; i < clones.length; i += 1) {
      const cloneIndex = clones[i]!
      const sourceIndex = sources[i]!
      const source = byIndex.get(sourceIndex)
      if (source === undefined) return objects
      if (out[cloneIndex] !== undefined) return objects
      out[cloneIndex] = relabelVectorUnitForIndex({ ...shiftObjectForMove(source, total), index: cloneIndex }, cloneIndex)
    }
    if (out.some((object) => object === undefined)) return objects
    const placed = out as VectorObjectInfo[]
    const finite = placed.every(
      (object) => Number.isFinite(object.boundsX ?? object.x ?? 0) && Number.isFinite(object.boundsY ?? object.y ?? 0),
    )
    if (!finite) return objects
    return placed
  }
  const set = new Set(selection)
  return objects.map((object) => {
    if (!set.has(object.index)) return object
    return shiftObjectForMove(object, total)
  })
}
