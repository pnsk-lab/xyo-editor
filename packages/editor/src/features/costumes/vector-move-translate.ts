// Unified vector-move geometry translation semantics (preview == commit).
//
// Background: the fast local preview (`vector-move-preview.ts`) prepends a
// `translate(native)` in the unit's parent frame, so `userSpaceOnUse`
// gradients/clips ride with the artwork. The legacy pointerup commit
// (`moveVectorElementBy` in `paper-vector.ts`) baked leaf geometry through
// Paper.js, leaving `userSpaceOnUse` defs fixed in canvas space. Moving a
// gradient/clipped object therefore snapped on release: mid-drag pixels
// (carried) vs committed pixels (fixed).
//
// Reference behavior (observed parity notes only, no reference source
// copied): Scratch Paint moves Paper.js items, which carries the item's
// paint with it. The unified semantics here is "geometry translation": the
// artwork (including its `userSpaceOnUse` paint/clip appearance) rides with
// the move. Both preview and commit prepend the same parent-frame
// `translate`, so mid-drag and committed pixels are identical and no snap
// or undo loss occurs. The user explicitly prioritizes smoothness.
//
// Safety contract (why the Paper bake is skipped for moves):
// - Translation preserves width/height exactly; runtime/export dimensions
//   (`vectorRuntimeCostume` recomputes tight viewBox/rotationCenter from
//   `vectorObjectBounds`, which folds `transform`) are identical either way.
// - Prepending preserves `rotate()` (rotation center), inherited paint
//   (no attribute rewrite), document order / Z-order (no reorder, children
//   untouched) and unit identity (no synthetic `<g>` wrapper).
// - Only the selected units' own `transform` attributes are touched; `defs`
//   (`linearGradient`/`radialGradient`/`clipPath`/...) and cross-unit
//   `url(#...)`/`href` references are never rewritten, so external fragments
//   and sibling units are unaffected.
// - Singular / non-finite ancestors have no unique preimage: both preview
//   and commit refuse with no DOM write (fail-closed), so a later ancestor
//   repair cannot teleport the leaf and no empty history entry is minted.
//
// This module is Paper-free so the preview path stays cheap (one DOM parse
// + serialize, zero VM writes). Formatting is fixed to 3 decimals (same as
// the legacy `formatSvgNumber`) so preview bytes and commit bytes are
// identical for the same total.

import { ancestorWorldMatrix, combineSvgTransforms, tryInvertVectorMatrix } from './vector-svg'

export function formatMoveTranslateNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(3))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

/**
 * Map a world-space delta into the unit's parent (native) frame.
 * Siblings of `nativePreviewDelta` / `toNativeDelta`: ancestors-only
 * inverse (the unit's own transform is never inverted because prepending
 * puts the translation in the parent frame). Returns `null` for
 * singular/non-finite ancestors (fail-closed: caller refuses with no DOM
 * write).
 */
export function toNativeMoveDelta(element: Element, dx: number, dy: number): { dx: number; dy: number } | null {
  try {
    const ancestors = ancestorWorldMatrix(element)
    if (!ancestors) return { dx, dy }
    const inverse = tryInvertVectorMatrix(ancestors)
    if (!inverse) return null
    const mapped = {
      dx: inverse[0]! * dx + inverse[2]! * dy,
      dy: inverse[1]! * dx + inverse[3]! * dy,
    }
    if (!Number.isFinite(mapped.dx) || !Number.isFinite(mapped.dy)) return null
    return mapped
  } catch {
    return null
  }
}

/**
 * Prepend `translate(native)` for a world-space move. Returns `false` with
 * no DOM write for zero / non-finite deltas and singular ancestors.
 */
export function prependMoveTranslate(element: Element, dx: number, dy: number): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
  if (dx === 0 && dy === 0) return false
  const native = toNativeMoveDelta(element, dx, dy)
  if (!native) return false
  if (!Number.isFinite(native.dx) || !Number.isFinite(native.dy)) return false
  if (Math.abs(native.dx) < 1e-12 && Math.abs(native.dy) < 1e-12) return true
  const prefix = `translate(${formatMoveTranslateNumber(native.dx)} ${formatMoveTranslateNumber(native.dy)})`
  try {
    element.setAttribute('transform', combineSvgTransforms(prefix, element.getAttribute('transform') ?? ''))
    return true
  } catch {
    return false
  }
}
