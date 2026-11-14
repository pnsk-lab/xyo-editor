// Vector selection move helpers for the select tool.
//
// Scratch Paint's move tool constrains the drag vector to 45-degree steps
// while Shift is held and duplicates the selection when Alt is held at press
// time. The helpers below express only that observable behavior with an
// independent implementation: snapping projects the raw pointer delta onto
// the nearest diagonal/axis, Alt is a press-time duplicate flag, and tiny
// deltas are no-ops so clicks never touch the undo stack. History handling
// itself stays with the Editor (lazy peek/commit), as does DOM work.

import { editableVectorUnits } from './vector-svg'
import { isShortcutTypingTarget } from './selection-shortcuts'

export const VECTOR_MOVE_SNAP_STEP = Math.PI / 4

/** Pointer delta in SVG units. */
export type VectorMoveDelta = { x: number; y: number }

/** Modifier flags sampled from the current pointer event. */
export type VectorMoveModifiers = {
  shiftKey?: boolean
  altKey?: boolean
}

/**
 * Project a drag delta onto the nearest 45-degree axis. Without snapping the
 * delta passes through unchanged; a zero delta stays zero so callers can
 * treat clicks as no-ops before touching history or the DOM.
 */
export function snapVectorMoveDelta(delta: VectorMoveDelta, snap: boolean): VectorMoveDelta {
  if (!snap) return { x: delta.x, y: delta.y }
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return { x: 0, y: 0 }
  if (delta.x === 0 && delta.y === 0) return { x: 0, y: 0 }
  const angle = Math.atan2(delta.y, delta.x)
  const snappedAngle = Math.round(angle / VECTOR_MOVE_SNAP_STEP) * VECTOR_MOVE_SNAP_STEP
  const dirX = Math.cos(snappedAngle)
  const dirY = Math.sin(snappedAngle)
  const distance = dirX * delta.x + dirY * delta.y
  return { x: dirX * distance, y: dirY * distance }
}

/** Resolve the effective move delta for the current modifier state. */
export function resolveVectorMoveDelta(
  rawDelta: VectorMoveDelta,
  modifiers: VectorMoveModifiers = {},
): VectorMoveDelta {
  return snapVectorMoveDelta(rawDelta, modifiers.shiftKey === true)
}

/** True when the effective delta moves nothing (clicks and rounding dust). */
export function isVectorMoveNoop(delta: VectorMoveDelta, epsilon = 1e-9): boolean {
  return Math.abs(delta.x) < epsilon && Math.abs(delta.y) < epsilon
}

/**
 * Whether a press-time Alt should duplicate the selection. Typing hosts and
 * open inline-text sessions never duplicate: Alt there belongs to text input,
 * not to canvas cloning.
 */
export function shouldDuplicateVectorMove(altKey: boolean, typing: boolean): boolean {
  return altKey === true && typing === false
}

/**
 * Whether the given event target should block starting a vector move drag.
 * Inline SVG text editing hosts an overlay input; starting (or cloning)
 * from it would steal Alt/text keys from the editor.
 */
export function isVectorMoveTypingTarget(target: unknown): boolean {
  return isShortcutTypingTarget(target)
}

/**
 * Duplicate the selected units in place (no offset). Each clone is inserted
 * directly after its source so document order stays stable, then the new
 * unit indices are returned in selection order. The caller moves the clones;
 * with a zero follow-up move this stays a pure duplicate.
 */
export function duplicateVectorUnits(svg: Element, indices: readonly number[]): number[] {
  const units = editableVectorUnits(svg)
  const sources = [...new Set(indices)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < units.length)
    .sort((a, b) => a - b)
    .map((index) => units[index])
    .filter((unit): unit is Element => Boolean(unit))
  if (sources.length === 0) return []
  const clones: Element[] = []
  for (const source of sources) {
    const clone = source.cloneNode(true) as Element
    clone.removeAttribute('id')
    source.parentNode?.insertBefore(clone, source.nextSibling)
    clones.push(clone)
  }
  const nextUnits = editableVectorUnits(svg)
  return clones
    .map((clone) => nextUnits.indexOf(clone))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
}
