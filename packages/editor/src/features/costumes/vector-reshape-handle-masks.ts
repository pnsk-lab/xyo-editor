// Vector reshape per-anchor handle selection masks (pure, DOM-free).
//
// Position: Paper.js (MIT) distinguishes selection flags the previous
// anchor-only product collapsed. In our own words, behavior-level:
// - `segment.selected = true` sets flags 7 (point 1 + handleIn 2 + handleOut 4).
// - `segment.selected = false` clears all flags to 0.
// - `segment.selected` getter is true for ANY flag (1/2/4/6 still counts).
// - `curve.selected = true` sets start to 5 (point + out) and end to 3
//   (point + in) — only the attached handles.
// - `curve.selected` getter requires both ends' flags (5 on start, 3 on end);
//   clearing one shared curve cascades: shared anchor loses its point bit,
//   the neighbour curve getter goes false, and a handle-only residual (4/2)
//   remains that still counts as `segment.selected`.
// - Clearing one handle from 7 leaves 3; a handle-only state still counts.
// - Closed path's last curve wraps last segment -> first segment.
// - Straight (zero-handle) curves still report 5/3.
//
// The product previously dropped handle-only residuals fail-closed, so a
// shift-off/shift-on round-trip of one shared curve lost the stale out-bit
// (6 pressed vs Paper's 7). This module keeps exact Paper flags including
// latent handle-only selection, while the UI distinguishes:
// - anchor pressed = point bit only (never falsely mark handle-only anchors),
// - handle pressed = in/out bits (latent handles show pressed),
// - segment selected (any bit) = Paper getter parity for toggle/history logic,
// - indices = point-bit projection (display/pressed/aria only, never actions).
// - action indices = any-bit live anchors (nudge/delete/style targets only,
//   never display/pressed).
//
// Rules (own words, behavior-level):
// - Explicit anchor clicks/marquees set 7 (both handles).
// - Curve pairs set start 5, end 3 (ordered as reported: segment1 -> segment2).
// - Plain marquee replaces: union of explicit 7 + curve 5/3 (disjoint flat
//   ranges per path, so no intra-marquee overlap).
// - Shift marquee toggles sequentially in Paper order: anchors first
//   (point-pressed removes the whole segment, otherwise adds 7), then each
//   curve pair in order with the exact Paper curve getter (5 on start and 3
//   on end means selected; clearing removes only those bits, leaving 2/4
//   residuals). Duplicate even slots therefore toggle twice (net no change).
// - Masks keep 1..7 including handle-only 2/4/6 as latent selection; 0 is
//   absent. Indices are the point-bit projection; SVG bytes/history untouched.
// - Display intersects masks with actually existing handles (the point list
//   only contains non-zero handles), so straight polyline endpoints show no
//   controls despite asking for 5/3.

export const RESHAPE_HANDLE_POINT = 1
export const RESHAPE_HANDLE_IN = 2
export const RESHAPE_HANDLE_OUT = 4
export const RESHAPE_HANDLE_ALL = 7
export const RESHAPE_CURVE_START_MASK = 5
export const RESHAPE_CURVE_END_MASK = 3

import type { ReshapeSelectablePoint } from './vector-multi-point-selection'
import { isReshapeAnchorLive } from './vector-multi-point-selection'

export type ReshapeHandleMasks = Record<number, number>

function isValidFlat(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function cleanMask(mask: unknown): number | undefined {
  if (typeof mask !== 'number' || !Number.isInteger(mask)) return undefined
  const narrowed = mask & RESHAPE_HANDLE_ALL
  if (narrowed === 0) return undefined
  // Exact Paper flags: keep 1..7 including latent handle-only 2/4/6. Only the
  // anchor-pressed derivation (point bit) decides UI pressed; the segment
  // getter (any bit) decides selection parity.
  return narrowed
}

/** Normalize a raw masks record: drop junk, clamp to 1..7, keep handle-only latent. */
export function normalizeReshapeHandleMasks(masks: Record<number, number> | undefined | null): ReshapeHandleMasks {
  const out: ReshapeHandleMasks = {}
  if (!masks || typeof masks !== 'object') return out
  for (const [key, value] of Object.entries(masks)) {
    const flat = Number(key)
    if (!isValidFlat(flat)) continue
    const cleaned = cleanMask(value)
    if (cleaned === undefined) continue
    out[flat] = cleaned
  }
  return out
}

/** Anchor indices derived from masks (keys with the point bit, sorted). */
export function reshapeHandleMasksToIndices(masks: ReshapeHandleMasks): number[] {
  const out: number[] = []
  for (const [key, value] of Object.entries(masks)) {
    const flat = Number(key)
    if (!isValidFlat(flat)) continue
    if ((value & RESHAPE_HANDLE_POINT) !== 0) out.push(flat)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/** Paper `segment.selected` getter parity: true for any flag (1/2/4/6 count). */
export function isReshapeSegmentSelected(masks: ReshapeHandleMasks, flat: number): boolean {
  return ((masks[flat] ?? 0) & RESHAPE_HANDLE_ALL) !== 0
}

/**
 * Action-only anchor flats: every mask key with ANY bit set (Paper
 * `segment.selected` parity, so latent 2/4/6 count), sorted. Display,
 * pressed, and aria stay on the point-bit projection
 * (`reshapeHandleMasksToIndices`); this helper is only for action targets
 * (nudge/delete/style). No liveness check: callers intersect with the live
 * point list via `liveReshapeActionIndices` so vanished anchors never act.
 */
export function reshapeSelectedSegmentFlats(masks: ReshapeHandleMasks): number[] {
  const base = normalizeReshapeHandleMasks(masks)
  const out: number[] = []
  for (const key of Object.keys(base)) {
    const flat = Number(key)
    if (!isValidFlat(flat)) continue
    if (isReshapeSegmentSelected(base, flat)) out.push(flat)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * Action-only sorted live-anchor indices from any-bit masks (NOT
 * display/pressed). Keeps every `segment.selected` anchor (any bit, so
 * latent 2/4/6 count) that still resolves to a live anchor in `points`;
 * control slots are excluded via the anchor-liveness check. Closed paths
 * and group transforms need no special casing: `points` already carry the
 * flattened Paper numbering and writers map document coordinates back
 * through ancestor transforms.
 */
export function liveReshapeActionIndices(
  points: readonly ReshapeSelectablePoint[],
  masks: ReshapeHandleMasks,
): number[] {
  const base = normalizeReshapeHandleMasks(masks)
  const out: number[] = []
  for (const flat of reshapeSelectedSegmentFlats(base)) {
    if (isReshapeAnchorLive(points, flat)) out.push(flat)
  }
  return out
}

/** Paper `curve.selected` getter parity: start has 5 and end has 3. */
export function isReshapeCurveSelected(masks: ReshapeHandleMasks, startFlat: number, endFlat: number): boolean {
  const start = masks[startFlat] ?? 0
  const end = masks[endFlat] ?? 0
  return (start & RESHAPE_CURVE_START_MASK) === RESHAPE_CURVE_START_MASK && (end & RESHAPE_CURVE_END_MASK) === RESHAPE_CURVE_END_MASK
}

/** Build masks for an explicit anchor set (every anchor 7). */
export function reshapeMasksForExplicitAnchors(anchors: readonly number[]): ReshapeHandleMasks {
  const out: ReshapeHandleMasks = {}
  for (const flat of anchors) {
    if (!isValidFlat(flat)) continue
    out[flat] = RESHAPE_HANDLE_ALL
  }
  return out
}

/** Union helper: add mask bits (callers pass 7, 5, or 3). */
function unionMask(into: ReshapeHandleMasks, flat: number, mask: number): void {
  const cleaned = cleanMask(mask)
  if (cleaned === undefined) return
  const prev = into[flat]
  const next = prev === undefined ? cleaned : prev | cleaned
  const finalMask = cleanMask(next)
  if (finalMask === undefined) delete into[flat]
  else into[flat] = finalMask
}

/** Clear exact Paper curve bits: start loses 5, end loses 3 (residuals stay). */
function clearCurveBits(live: ReshapeHandleMasks, startFlat: number, endFlat: number): void {
  const startPrev = live[startFlat] ?? 0
  const endPrev = live[endFlat] ?? 0
  const startNext = startPrev & ~RESHAPE_CURVE_START_MASK
  const endNext = endPrev & ~RESHAPE_CURVE_END_MASK
  if (startNext === 0) delete live[startFlat]
  else live[startFlat] = startNext
  if (endNext === 0) delete live[endFlat]
  else live[endFlat] = endNext
}

function isValidCurvePair(pair: readonly unknown[]): pair is readonly [number, number] {
  if (!Array.isArray(pair) || pair.length < 2) return false
  const [a, b] = pair as readonly unknown[]
  return isValidFlat(a) && isValidFlat(b) && a !== b
}

function dedupedCurvePairs(pairs: readonly (readonly number[])[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const seen = new Set<string>()
  for (const pair of pairs) {
    if (!isValidCurvePair(pair as readonly unknown[])) continue
    const [a, b] = pair as unknown as [number, number]
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push([a, b])
  }
  return out
}

/**
 * Curve-aware marquee merge with handle masks (pure).
 * Mirrors `mergeReshapeMarqueeSelectionWithCurves` point projection exactly,
 * while tracking 7 vs 5/3 provenance plus latent 2/4 residuals for display:
 * - plain: replace with explicit 7 + curve 5/3 union.
 * - Shift: toggle anchors by point-pressed (pressed removes the whole
 *   segment, otherwise adds 7), then toggle each curve pair in order with
 *   the exact Paper curve getter (5 on start and 3 on end). Clearing removes
 *   only those bits, leaving handle-only residuals. Sequential so duplicate
 *   even slots toggle twice.
 */
export function mergeReshapeMarqueeSelectionWithMasks(
  current: ReshapeHandleMasks,
  anchorMatched: readonly number[],
  curvePairs: readonly (readonly number[])[],
  append: boolean,
): ReshapeHandleMasks {
  const base = normalizeReshapeHandleMasks(current)
  const cleanAnchors = [...new Set(anchorMatched.filter(isValidFlat))].sort((a, b) => a - b)
  if (!append) {
    const next: ReshapeHandleMasks = {}
    for (const flat of cleanAnchors) next[flat] = RESHAPE_HANDLE_ALL
    for (const [a, b] of dedupedCurvePairs(curvePairs)) {
      unionMask(next, a, RESHAPE_CURVE_START_MASK)
      unionMask(next, b, RESHAPE_CURVE_END_MASK)
    }
    return normalizeReshapeHandleMasks(next)
  }
  const live: ReshapeHandleMasks = { ...base }
  for (const flat of cleanAnchors) {
    if (((live[flat] ?? 0) & RESHAPE_HANDLE_POINT) !== 0) delete live[flat]
    else live[flat] = RESHAPE_HANDLE_ALL
  }
  // Sequential per-entry toggle (reference-exact): use the live Paper curve
  // getter at each step so duplicates cancel and shared-anchor cascades leave
  // handle-only residuals instead of deleting both ends.
  for (const raw of curvePairs) {
    if (!isValidCurvePair(raw as readonly unknown[])) continue
    const [a, b] = raw as unknown as [number, number]
    if (isReshapeCurveSelected(live, a, b)) {
      clearCurveBits(live, a, b)
    } else {
      unionMask(live, a, RESHAPE_CURVE_START_MASK)
      unionMask(live, b, RESHAPE_CURVE_END_MASK)
    }
  }
  return normalizeReshapeHandleMasks(live)
}

/**
 * Single click / Shift+click with masks.
 * Plain replaces with 7. Shift toggles by anchor-pressed (point bit):
 * pressed clears the whole segment (Paper `segment.selected = false`),
 * otherwise upgrades to 7 (Paper `segment.selected = true`, latent OR 7).
 */
export function toggleReshapeHandleSelection(
  current: ReshapeHandleMasks,
  index: number,
  append: boolean,
): ReshapeHandleMasks {
  const base = normalizeReshapeHandleMasks(current)
  if (!isValidFlat(index)) return base
  if (!append) return { [index]: RESHAPE_HANDLE_ALL }
  if (((base[index] ?? 0) & RESHAPE_HANDLE_POINT) !== 0) {
    const next = { ...base }
    delete next[index]
    return normalizeReshapeHandleMasks(next)
  }
  return normalizeReshapeHandleMasks({ ...base, [index]: RESHAPE_HANDLE_ALL })
}

/** Remap mask keys through one contiguous vanished slot range (delete path). */
export function remapReshapeHandleMasksAfterSlotDelete(
  masks: ReshapeHandleMasks,
  deletedIndex: number,
  removedSlots: number,
): ReshapeHandleMasks {
  const base = normalizeReshapeHandleMasks(masks)
  if (!isValidFlat(deletedIndex)) return base
  const shift = Number.isInteger(removedSlots) && removedSlots > 0 ? removedSlots : 1
  const out: ReshapeHandleMasks = {}
  for (const [key, value] of Object.entries(base)) {
    const flat = Number(key)
    if (flat >= deletedIndex && flat < deletedIndex + shift) continue
    const nextFlat = flat >= deletedIndex + shift ? flat - shift : flat
    // Later (higher) entries win on collision (should not collide for valid
    // contiguous ranges, but fail-closed deterministically).
    out[nextFlat] = value
  }
  return normalizeReshapeHandleMasks(out)
}

/** Bulk remap through descending disjoint ranges (deleteVectorPathPoints order). */
export function remapReshapeHandleMasksAfterBulkRanges(
  masks: ReshapeHandleMasks,
  removedRanges: readonly { index: number; slots: number }[],
): ReshapeHandleMasks {
  let next = normalizeReshapeHandleMasks(masks)
  for (const range of removedRanges) {
    if (!range || !isValidFlat(range.index)) continue
    next = remapReshapeHandleMasksAfterSlotDelete(next, range.index, range.slots)
  }
  return next
}

/**
 * Rebase masks through a structural mutation (curved/pointed/add/undo) by
 * anchor coordinates. Each old flat with a mask follows its anchor coordinate
 * to exactly one new anchor (epsilon, claimed-once, fail-closed); ambiguous
 * anchors drop their masks. Mirrors
 * `rebaseReshapeSelectionByAnchorCoordinates` but carries the exact Paper
 * value (7/5/3 plus latent 2/4/6).
 */
export function rebaseReshapeHandleMasksByAnchorCoordinates(
  previousAnchors: readonly { index: number; x: number; y: number }[],
  nextAnchors: readonly { index: number; x: number; y: number }[],
  masks: ReshapeHandleMasks,
  epsilon = 0.01,
): ReshapeHandleMasks {
  const base = normalizeReshapeHandleMasks(masks)
  const tolerance = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0.01
  const previousByIndex = new Map<number, { x: number; y: number }>()
  for (const point of previousAnchors) {
    if (!isValidFlat(point.index) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    if (!previousByIndex.has(point.index)) previousByIndex.set(point.index, { x: point.x, y: point.y })
  }
  const nextList = nextAnchors.filter(
    (point) => isValidFlat(point.index) && Number.isFinite(point.x) && Number.isFinite(point.y),
  )
  const claimed = new Set<number>()
  const out: ReshapeHandleMasks = {}
  for (const [key, value] of Object.entries(base)) {
    const flat = Number(key)
    const previous = previousByIndex.get(flat)
    if (!previous) continue
    const candidates = nextList.filter(
      (point) => !claimed.has(point.index) && Math.abs(point.x - previous.x) <= tolerance && Math.abs(point.y - previous.y) <= tolerance,
    )
    if (candidates.length !== 1) continue
    claimed.add(candidates[0]!.index)
    out[candidates[0]!.index] = value
  }
  return normalizeReshapeHandleMasks(out)
}

/** True when the anchor's point bit is selected (display pressed). */
export function isReshapeAnchorPressed(masks: ReshapeHandleMasks, flat: number): boolean {
  return ((masks[flat] ?? 0) & RESHAPE_HANDLE_POINT) !== 0
}

/** True when the anchor's in/out handle should show pressed (Paper truth). */
export function isReshapeHandlePressed(
  masks: ReshapeHandleMasks,
  relatedAnchorIndex: number,
  controlRole: 'in' | 'out' | undefined,
): boolean {
  const mask = masks[relatedAnchorIndex] ?? 0
  if (controlRole === 'in') return (mask & RESHAPE_HANDLE_IN) !== 0
  if (controlRole === 'out') return (mask & RESHAPE_HANDLE_OUT) !== 0
  return false
}
