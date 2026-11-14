// Vector reshape multi-point selection helpers (pure, DOM-free).
//
// Position: this module fills the gap between scratch-paint's reshape
// behaviour and the current single `selectedVectorPointIndex`
// (`vectorReshapePointIndex` in `Editor.svelte`).
//
// Observed difference (behaviour-level summary, no reference code copied):
// - Reference reshape: Shift+click toggles one anchor in/out of the point
//   selection, and a point marquee selects every anchor whose document point
//   lies inside the dragged rect. With Shift held, the marquee *toggles* the
//   matched anchors (already-selected ones are removed) instead of only
//   adding; without Shift it *replaces* the selection. The selection is a set
//   of flattened anchor indices that survives (remapped) across style/add/
//   delete mutations and is cleared when the object changes.
// - Current code: `vectorReshapePointIndex: number | undefined` holds at most
//   one flattened index. `beginVectorPathPointDrag` overwrites it on every
//   handle press, `addVectorPathPointAt` overwrites it on insert, and
//   `deleteVectorReshapePoint` clears it. There is no point marquee, no Shift
//   toggle, and no index tracking across mutations beyond "drop when stale"
//   (overlay effect + `live` check in `deleteEditorSelection`). Object-level
//   marquee already implements Shift-toggle (`selectVectorObjectsInRect`), so
//   the point-level equivalent below deliberately mirrors its kept/added
//   merge — but at anchor granularity, not object granularity.
//
// What this module provides (all pure; no Paper.js, DOM, history, or UI):
// - `normalizeReshapeRect` / `reshapePointsInRect`: marquee hit testing in
//   document coordinates (negative drag sizes handled, edges inclusive,
//   anchor-only by default so dragging near a Bezier handle never selects it).
// - `toggleReshapePointSelection` / `mergeReshapeMarqueeSelection`: Shift
//   toggle vs replace, mirroring the existing object-marquee merge.
// - `normalizeReshapeSelection` / `isReshapeAnchorLive`: selection index
//   tracking helpers (dedupe/sort/filter + stale-index validation).
// - `remapReshapeSelectionAfterAnchorDelete`: index bookkeeping after one
//   anchor deletion (the deleted anchor slot plus its trailing in/out handle
//   slots disappear, so later flattened indices shift down).
// - `moveReshapePoints` / `reshapeBulkMoveTargets`: bulk translation that
//   moves each selected anchor together with its own in/out handles by the
//   same delta, leaving every other segment/handle byte-identical. This is
//   intentionally *translation-only*: single-point control-handle mirroring
//   (`shouldMirrorHandles` in `paper-vector.ts`) and curve/pointed styling
//   (`vector-point-style.ts`) stay single-point behaviours.
//
// Contracts the integrator must keep (see also the report in the final
// message; this module cannot enforce them):
// - Coordinates are document (world) coordinates — the same space as
//   `VectorPathPointInfo.x/y`, `moveVectorEditablePoint`, and
//   `addVectorPathPoint`. Convert marquee/mouse positions before calling.
// - Group/ancestor transforms are owned by the existing DOM/Paper wrappers
//   (`ancestorWorldMatrix` inverse mapping inside `moveVectorEditablePoint` /
//   `deleteVectorPathPoint`). Never pre-transform points here.
// - Bulk moves must be applied to one loaded document and serialized once,
//   with exactly one history entry (the `peekCostumeHistory` /
//   `commitAssetHistory` pattern used by add/delete). Do not capture history
//   per point.
// - After add/delete/style/undo, flattened indices may shift or vanish.
//   Revalidate with `isReshapeAnchorLive` / `normalizeReshapeSelection`
//   instead of trusting a stored array.
//
// Safety: no parsing, no serialization, no mutation of inputs. All functions
// return new arrays/objects and ignore non-finite coordinates.

import type { VectorPathPointInfo } from '../../lib/editor-types'

/** Minimal point shape this module operates on. `VectorPathPointInfo` fits. */
export type ReshapeSelectablePoint = Pick<VectorPathPointInfo, 'index' | 'x' | 'y'> &
  Partial<Pick<VectorPathPointInfo, 'kind' | 'relatedAnchorIndex'>>

/** Drag rect in document coordinates; width/height may be negative while dragging. */
export type ReshapeMarqueeRect = { x: number; y: number; width: number; height: number }

export type ReshapePointsInRectOptions = {
  /** Include `kind === 'control'` handles in the match. Default false (anchors only). */
  includeControl?: boolean
}

export type ReshapeBulkMoveOptions = {
  /**
   * When true, explicitly selected control handles move on their own without
   * pulling their anchor. Default false: control entries in `selection` are
   * ignored and each selected anchor carries its own handles along, which is
   * the only mode guaranteed not to reshape neighbouring segments.
   */
  moveSelectedControlsIndependently?: boolean
}

type NormalizedRect = { left: number; top: number; right: number; bottom: number }

function isFinitePoint(point: ReshapeSelectablePoint): boolean {
  return Number.isInteger(point.index) && point.index >= 0 && Number.isFinite(point.x) && Number.isFinite(point.y)
}

/** Normalize a drag rect so reversed drags (negative w/h) still match. NaN rects yield an empty rect. */
export function normalizeReshapeRect(rect: ReshapeMarqueeRect): NormalizedRect {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return { left: 0, top: 0, right: -1, bottom: -1 }
  }
  const x2 = rect.x + rect.width
  const y2 = rect.y + rect.height
  return {
    left: Math.min(rect.x, x2),
    top: Math.min(rect.y, y2),
    right: Math.max(rect.x, x2),
    bottom: Math.max(rect.y, y2),
  }
}

function isAnchor(point: ReshapeSelectablePoint): boolean {
  return point.kind === undefined || point.kind === 'anchor'
}

/**
 * Marquee hit test over an already-resolved point list (document coordinates).
 * Returns sorted unique flattened indices. Anchor-only unless
 * `includeControl` is set. Edges are inclusive; degenerate (zero-area) rects
 * match points exactly on the line, mirroring "segment point sits inside"
 * semantics used by `paperItemIntersectsRect` for the object marquee.
 */
export function reshapePointsInRect(
  points: readonly ReshapeSelectablePoint[],
  rect: ReshapeMarqueeRect,
  options: ReshapePointsInRectOptions = {},
): number[] {
  const { left, top, right, bottom } = normalizeReshapeRect(rect)
  const out = new Set<number>()
  for (const point of points) {
    if (!isFinitePoint(point)) continue
    if (!options.includeControl && !isAnchor(point)) continue
    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) out.add(point.index)
  }
  return [...out].sort((a, b) => a - b)
}

/** Anchor coordinate snapshot for stable-identity rebasing across mutations. */
export type ReshapeAnchorCoordinate = Pick<ReshapeSelectablePoint, 'index' | 'x' | 'y'>

/**
 * Rebase a flattened anchor selection through a structural mutation
 * (curved/pointed handle churn, point add, undo/redo) by anchor coordinates.
 *
 * Flattened indices are positional: inserting/removing handle slots shifts
 * later indices, so a stored number may name another anchor after the
 * mutation (editing the wrong point). Anchors themselves do not move for
 * curve/point/add/surviving-delete/undo, so an old index whose anchor
 * coordinate matches exactly one new anchor is rebased to the new index.
 * Anything ambiguous (no candidate, or 2+ candidates within `epsilon`, or
 * an already-claimed candidate) is dropped fail-closed so a later edit can
 * never land on the wrong anchor. Inputs are never mutated.
 */
export function rebaseReshapeSelectionByAnchorCoordinates(
  previousAnchors: readonly ReshapeAnchorCoordinate[],
  nextAnchors: readonly ReshapeAnchorCoordinate[],
  selection: readonly number[],
  epsilon = 0.01,
): number[] {
  const tolerance = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0.01
  const previousByIndex = new Map<number, { x: number; y: number }>()
  for (const point of previousAnchors) {
    if (!Number.isInteger(point.index) || point.index < 0) continue
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    if (!previousByIndex.has(point.index)) previousByIndex.set(point.index, { x: point.x, y: point.y })
  }
  const nextList: ReshapeAnchorCoordinate[] = []
  for (const point of nextAnchors) {
    if (!Number.isInteger(point.index) || point.index < 0) continue
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    nextList.push(point)
  }
  const claimed = new Set<number>()
  const out: number[] = []
  for (const index of selection) {
    if (!Number.isInteger(index) || index < 0) continue
    const previous = previousByIndex.get(index)
    if (!previous) continue
    const candidates = nextList.filter(
      (point) =>
        !claimed.has(point.index) && Math.abs(point.x - previous.x) <= tolerance && Math.abs(point.y - previous.y) <= tolerance,
    )
    if (candidates.length !== 1) continue
    claimed.add(candidates[0]!.index)
    out.push(candidates[0]!.index)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/** Sort/dedupe a raw index list; optionally keep only indices present in `valid`. */
export function normalizeReshapeSelection(selection: readonly number[], valid?: readonly number[]): number[] {
  const allowed = valid === undefined ? undefined : new Set(valid.filter((index) => Number.isInteger(index) && index >= 0))
  const out = new Set<number>()
  for (const index of selection) {
    if (!Number.isInteger(index) || index < 0) continue
    if (allowed && !allowed.has(index)) continue
    out.add(index)
  }
  return [...out].sort((a, b) => a - b)
}

/** True when `index` still resolves to a live anchor (mirrors the overlay's stale-index effect). */
export function isReshapeAnchorLive(points: readonly ReshapeSelectablePoint[], index: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false
  return points.some((point) => point.index === index && isAnchor(point))
}

/**
 * Single-click / Shift+click update for one anchor index.
 * - `append === false`: replace the selection with `[index]` (plain click).
 * - `append === true` (Shift): toggle `index` in/out, mirroring the
 *   object-level Shift+marquee toggle in `selectVectorObjectsInRect`.
 */
export function toggleReshapePointSelection(
  current: readonly number[],
  index: number,
  append: boolean,
): number[] {
  if (!Number.isInteger(index) || index < 0) return normalizeReshapeSelection(current)
  if (!append) return [index]
  const set = new Set(normalizeReshapeSelection(current))
  if (set.has(index)) set.delete(index)
  else set.add(index)
  return [...set].sort((a, b) => a - b)
}

/**
 * Merge a marquee match into the current selection.
 * - `append === false`: replace with `matched` (plain marquee).
 * - `append === true` (Shift+marquee): toggle each matched index —
 *   already-selected ones are removed, new ones are added — exactly like the
 *   existing `selectVectorObjectsInRect` kept/added merge, but per anchor.
 */
export function mergeReshapeMarqueeSelection(
  current: readonly number[],
  matched: readonly number[],
  append: boolean,
): number[] {
  const cleanCurrent = normalizeReshapeSelection(current)
  const cleanMatched = normalizeReshapeSelection(matched)
  if (!append) return cleanMatched
  const matchedSet = new Set(cleanMatched)
  const kept = cleanCurrent.filter((index) => !matchedSet.has(index))
  const currentSet = new Set(cleanCurrent)
  const added = cleanMatched.filter((index) => !currentSet.has(index))
  return [...kept, ...added].sort((a, b) => a - b)
}

/**
 * One intersected curve as its two endpoint flattened anchor indices.
 * Mirrors Paper.js `curve.selected`, which selects exactly the two endpoint
 * anchors (plus their adjacent handles) — never a lone middle point and
 * never a control handle. The product tracks anchors only, so a curve maps
 * to this pair with no extra state.
 */
export type ReshapeCurveEndpointPair = readonly [number, number]

function cleanCurvePairs(
  pairs: readonly (readonly number[])[] | readonly ReshapeCurveEndpointPair[],
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const seen = new Set<string>()
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const a = pair[0]
    const b = pair[1]
    if (!Number.isInteger(a) || (a as number) < 0) continue
    if (!Number.isInteger(b) || (b as number) < 0) continue
    if (a === b) continue
    const key = (a as number) < (b as number) ? `${a}:${b}` : `${b}:${a}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push([a as number, b as number])
  }
  return out
}

/**
 * Curve-aware marquee merge mirroring scratch-paint's reshape rectangular
 * selection (runtime oracle, no reference code copied):
 * - anchors inside the marquee toggle individually (Shift) or replace;
 * - a kept curve crossing (every other Paper intersection in order) toggles
 *   its two endpoint anchors as a unit (`curve.selected` semantics: both
 *   anchors together, never handles alone). Kept entries apply sequentially
 *   in Paper order, so the same curve on two even slots toggles twice with
 *   Shift (net no change). Plain marquee replaces with anchors + curve ends.
 * Processing order is anchors first, then curves in Paper order, matching
 * the reference per-path sequential mutation.
 */
export function mergeReshapeMarqueeSelectionWithCurves(
  current: readonly number[],
  anchorMatched: readonly number[],
  curvePairs: readonly (readonly number[])[] | readonly ReshapeCurveEndpointPair[],
  append: boolean,
): number[] {
  const cleanAnchors = normalizeReshapeSelection(anchorMatched)
  const pairs = cleanCurvePairs(curvePairs)
  if (!append) {
    const union = new Set<number>(cleanAnchors)
    for (const [a, b] of pairs) {
      union.add(a)
      union.add(b)
    }
    return [...union].sort((a, b) => a - b)
  }
  const live = new Set<number>(normalizeReshapeSelection(current))
  for (const index of cleanAnchors) {
    if (live.has(index)) live.delete(index)
    else live.add(index)
  }
  // Sequential per-entry toggle (reference-exact): each kept intersection
  // toggles the live set as it arrives, so duplicate pairs cancel instead
  // of collapsing to a single toggle.
  for (const pair of curvePairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const a = pair[0]
    const b = pair[1]
    if (!Number.isInteger(a) || a < 0 || !Number.isInteger(b) || b < 0 || a === b) continue
    if (live.has(a) && live.has(b)) {
      live.delete(a)
      live.delete(b)
    } else {
      live.add(a)
      live.add(b)
    }
  }
  return [...live].sort((a, b) => a - b)
}

/**
 * Count how many flattened slots disappear when the anchor at `deletedIndex`
 * is removed: the anchor slot itself plus its trailing non-zero in/out
 * handle slots (controls that immediately follow it before the next anchor).
 * Falls back to 1 when the anchor entry is missing.
 */
export function countFlattenedSlotsForAnchor(
  pointsBefore: readonly ReshapeSelectablePoint[],
  deletedIndex: number,
): number {
  const ordered = [...pointsBefore].filter(isFinitePoint).sort((a, b) => a.index - b.index)
  const anchorPos = ordered.findIndex((point) => point.index === deletedIndex && isAnchor(point))
  if (anchorPos < 0) return 1
  let count = 1
  for (let i = anchorPos + 1; i < ordered.length; i++) {
    const next = ordered[i]!
    if (isAnchor(next)) break
    if (next.index !== deletedIndex + count) break
    count += 1
  }
  return count
}

/**
 * Remap a multi-point selection after one anchor deletion.
 * The deleted anchor (and its handle slots, if the caller tracked them) are
 * dropped; every selected index above the deletion shifts down by the number
 * of removed flattened slots so it still points at the same anchor.
 */
export function remapReshapeSelectionAfterAnchorDelete(
  selection: readonly number[],
  pointsBefore: readonly ReshapeSelectablePoint[],
  deletedIndex: number,
): number[] {
  if (!Number.isInteger(deletedIndex) || deletedIndex < 0) return normalizeReshapeSelection(selection)
  const removedSlots = Math.max(1, countFlattenedSlotsForAnchor(pointsBefore, deletedIndex))
  return remapReshapeSelectionAfterSlotDelete(selection, deletedIndex, removedSlots)
}

/**
 * Lower-level remap when the caller already knows how many flattened slots
 * were removed at `deletedIndex` (e.g. from Paper-side bookkeeping).
 *
 * NOTE: only exact when the vanished slots form one contiguous range starting
 * at `deletedIndex`. A deleted first anchor whose cleared neighbour handle
 * sits above the deletion vanishes disjointly (`{anchor, out, nextIn}` with
 * the survivor anchor between), so the contiguous `removedSlots` count
 * over-covers the survivor — use `remapReshapeSelectionAfterPreciseSlots` /
 * `remapReshapeSelectionAfterBulkPreciseSlots` (or the disjoint
 * `removedRanges` entries) for that case.
 */
export function remapReshapeSelectionAfterSlotDelete(
  selection: readonly number[],
  deletedIndex: number,
  removedSlots: number,
): number[] {
  if (!Number.isInteger(deletedIndex) || deletedIndex < 0) return normalizeReshapeSelection(selection)
  const shift = Number.isInteger(removedSlots) && removedSlots > 0 ? removedSlots : 1
  const out: number[] = []
  for (const index of normalizeReshapeSelection(selection)) {
    if (index >= deletedIndex && index < deletedIndex + shift) continue
    out.push(index >= deletedIndex + shift ? index - shift : index)
  }
  return out
}

/**
 * Exact remap through an explicit vanished flat-slot set (any shape, sorted
 * or not): selected slots in the set are dropped, every other selected slot
 * shifts down by how many vanished slots sit below it. This is the precise
 * primitive for a deleted first anchor (`{0, 1, 3}`): the survivor anchor `2`
 * is not in the set and shifts by the two slots below it to `0`.
 */
export function remapReshapeSelectionAfterPreciseSlots(
  selection: readonly number[],
  vanishedSlots: readonly number[],
): number[] {
  const vanished = [...new Set(vanishedSlots.filter((slot) => Number.isInteger(slot) && slot >= 0))].sort((a, b) => a - b)
  if (vanished.length === 0) return normalizeReshapeSelection(selection)
  const gone = new Set(vanished)
  const out: number[] = []
  for (const index of normalizeReshapeSelection(selection)) {
    if (gone.has(index)) continue
    let shift = 0
    for (const slot of vanished) {
      if (slot < index) shift += 1
      else break
    }
    out.push(index - shift)
  }
  return out
}

/**
 * Exact bulk remap through per-deletion precise slot sets in descending
 * application order (the order `deleteVectorPathPoints` reports
 * `removedSlots` in): higher deletions never disturb lower indices, so each
 * set applies to the numbering produced by the previous (higher) ones.
 */
export function remapReshapeSelectionAfterBulkPreciseSlots(
  selection: readonly number[],
  removedSlotsList: readonly (readonly number[])[],
): number[] {
  let next = normalizeReshapeSelection(selection)
  for (const vanished of removedSlotsList) {
    next = remapReshapeSelectionAfterPreciseSlots(next, vanished)
  }
  return next
}

/**
 * Exact bulk remap through flattened disjoint ranges in descending
 * application order (the order `deleteVectorPathPoints` reports
 * `removedRanges` in): each entry replays through the legacy contiguous
 * primitive, highest range first so a disjoint pair within one deletion
 * (`{3,1}` then `{0,2}`) keeps the survivor between them.
 */
export function remapReshapeSelectionAfterBulkRanges(
  selection: readonly number[],
  removedRanges: readonly { index: number; slots: number }[],
): number[] {
  let next = normalizeReshapeSelection(selection)
  for (const range of removedRanges) {
    if (!range || !Number.isInteger(range.index) || range.index < 0) continue
    next = remapReshapeSelectionAfterSlotDelete(next, range.index, range.slots)
  }
  return next
}

/**
 * Pure bulk translation of a resolved point list.
 * Each selected anchor moves by `(dx, dy)` together with its own in/out
 * handles (matched via `relatedAnchorIndex`), so the local curve shape
 * travels rigidly and no other segment or handle is touched. Unselected
 * points are returned unchanged (same values, new objects). Inputs are never
 * mutated. Non-finite deltas return a copy with no movement.
 */
export function moveReshapePoints(
  points: readonly ReshapeSelectablePoint[],
  selection: readonly number[],
  dx: number,
  dy: number,
  options: ReshapeBulkMoveOptions = {},
): ReshapeSelectablePoint[] {
  const selected = new Set(normalizeReshapeSelection(selection))
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return points.map((point) => ({ ...point }))
  }
  // Anchor index -> its own flattened index, resolved via relatedAnchorIndex
  // for controls (same convention as `VectorPathPointInfo.relatedAnchorIndex`).
  const anchorOf = new Map<number, number>()
  for (const point of points) {
    if (!isFinitePoint(point)) continue
    if (isAnchor(point)) anchorOf.set(point.index, point.index)
    else if (typeof point.relatedAnchorIndex === 'number') anchorOf.set(point.index, point.relatedAnchorIndex)
  }
  return points.map((point) => {
    if (!isFinitePoint(point)) return { ...point }
    if (isAnchor(point)) {
      if (!selected.has(point.index)) return { ...point }
      return { ...point, x: point.x + dx, y: point.y + dy }
    }
    const owner = anchorOf.get(point.index) ?? point.relatedAnchorIndex
    if (owner !== undefined && selected.has(owner)) {
      // The handle belongs to a selected anchor: carry it along rigidly.
      return { ...point, x: point.x + dx, y: point.y + dy }
    }
    if (options.moveSelectedControlsIndependently && selected.has(point.index)) {
      return { ...point, x: point.x + dx, y: point.y + dy }
    }
    return { ...point }
  })
}

/**
 * Concrete `{ index, x, y }` targets for applying a bulk move through the
 * existing single-point writer (`moveVectorEditablePoint`) or its Paper
 * equivalent. Only entries whose coordinates actually change are returned,
 * in ascending flattened-index order so sequential application never
 * invalidates a later index (moves do not add/remove slots).
 *
 * Paper.js note: moving an anchor (`segment.point = ...`) already carries
 * its handle vectors along, so Paper-backed callers should apply only the
 * `kind === 'anchor'` targets (filter by the live point list). The handle
 * entries are for the token-based fallback (`vector-svg.ts`, which stores
 * absolute coordinates) and for verifying the rigid translation.
 */
export function reshapeBulkMoveTargets(
  points: readonly ReshapeSelectablePoint[],
  selection: readonly number[],
  dx: number,
  dy: number,
  options: ReshapeBulkMoveOptions = {},
): Array<{ index: number; x: number; y: number }> {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return []
  const moved = moveReshapePoints(points, selection, dx, dy, options)
  const before = new Map<number, ReshapeSelectablePoint>()
  for (const point of points) {
    if (isFinitePoint(point) && !before.has(point.index)) before.set(point.index, point)
  }
  const targets: Array<{ index: number; x: number; y: number }> = []
  for (const point of moved) {
    const prev = before.get(point.index)
    if (!prev) continue
    if (point.x !== prev.x || point.y !== prev.y) targets.push({ index: point.index, x: point.x, y: point.y })
  }
  return targets.sort((a, b) => a.index - b.index)
}
