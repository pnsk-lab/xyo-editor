// Reshape-anchor keyboard nudge helpers (clean-room, no AGPL copy).
//
// Reference behavior restated in our own words:
// reshape keydown moves each *selected segment's anchor point* by one zoom
// unit with no Shift multiplier, no action-bounds clamp and no clone;
// keyup commits a single history entry per press-release cycle and the
// point selection is never mutated by the keyboard path.
//
// Current-editor mapping (screen-constant 1px): vector SVG units reach the
// screen as `svg * 5 * viewportScale`, so one screen px is
// `1 / (5 * scale)` SVG units. Shift and Alt are ignored on this path
// (unlike select-mode nudge, which multiplies by 15 under Shift).

import { referenceVectorNudgeStep } from './nudge-parity'
import {
  isReshapeAnchorLive,
  normalizeReshapeSelection,
  type ReshapeSelectablePoint,
} from './vector-multi-point-selection'

export type { ReshapeSelectablePoint }

/** One screen-px step in SVG document units; modifiers are ignored. */
export function reshapeNudgeStep(viewportScale: number): number {
  return referenceVectorNudgeStep(viewportScale, false)
}

/** Stable pending-session key for a reshape point selection. */
export function reshapeNudgeSelectionKey(
  objectIndex: number,
  pointIndices: readonly number[],
): string | undefined {
  if (!Number.isInteger(objectIndex) || objectIndex < 0) return undefined
  const clean = normalizeReshapeSelection(pointIndices)
  if (clean.length === 0) return undefined
  return `vr:${objectIndex}:${clean.join(',')}`
}

/** True when the reshape selection can own an arrow-nudge cycle. */
export function isReshapeNudgeSelection(
  objectIndex: number,
  pointIndices: readonly number[],
): boolean {
  return reshapeNudgeSelectionKey(objectIndex, pointIndices) !== undefined
}

/** Keep only still-live anchor slots (fail-closed: never invent indices). */
export function liveReshapeNudgeIndices(
  points: readonly ReshapeSelectablePoint[],
  pointIndices: readonly number[],
): number[] {
  const clean = normalizeReshapeSelection(pointIndices)
  return clean.filter((index) => isReshapeAnchorLive(points, index))
}

/** Absolute document-space targets for one keydown (handles ride rigidly). */
export function reshapeNudgeTargets(
  points: readonly ReshapeSelectablePoint[],
  pointIndices: readonly number[],
  dx: number,
  dy: number,
): Array<{ index: number; x: number; y: number }> {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return []
  const live = liveReshapeNudgeIndices(points, pointIndices)
  const targets: Array<{ index: number; x: number; y: number }> = []
  for (const index of live) {
    const point = points[index]
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    targets.push({ index, x: point.x + dx, y: point.y + dy })
  }
  return targets
}
