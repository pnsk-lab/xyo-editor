// Bitmap floating-drag session: Editor wiring state for rectangular bitmap
// selection moves / Alt-duplicates / handle scales / selection-scoped flips,
// 90-degree rotations, and arbitrary-angle rotation-handle drags.
//
// This module is DOM-free (no canvas, no Editor, no history): it only
// reshapes the `{ width, height, data }` images that `bitmap-floating.ts`
// already defines, so `bun test` can exercise every path without a browser.
// The Editor owns canvas I/O (`getImageData` in, `new ImageData` +
// `putImageData` out), pointer capture, zoom mapping, history commits, and
// Esc cancellation; this module only answers "what pixels would change".
//
// Contract (mirrors `bitmap-floating.ts` and the Scratch floating raster):
// - Lift is verbatim (alpha preserved); stamping is Porter-Duff source-over
//   so transparent patch pixels leave the destination untouched, opaque
//   pixels replace it, and semi-transparent pixels blend over it.
// - Every preview renders from the immutable `committed` snapshot, never from
//   the previous preview, so repeated pointermoves cannot accumulate
//   rounding or double-blend.
// - Previews never mutate their inputs; `changed === false` returns the
//   relevant input reference so the Editor can skip canvas writes and history.
// - Cancelling is discarding the session and restoring `committed`: no entry
//   here mutates, so there is nothing to undo.
// - Scale/rotate helpers keep the patch anchored for the Editor's chosen
//   origin (move keeps the drag delta; the SE handle keeps the NW corner;
//   toolbar rotate re-centers). Anchor math lives here so the Editor and the
//   tests share one implementation.
//
// This module was written independently for this repository without copying
// any third-party source.

import {
  clearFloatingRectForMove,
  compositeFloatingPatch,
  extractFloatingPatch,
  flipFloatingPatch,
  isNoopFloatingTransform,
  rotateFloatingPatch,
  rotateFloatingPatch90,
  rotateFloatingPatchWithHalo,
  scaleFloatingPatch,
  type BitmapFloatingHalo,
  type BitmapFloatingImage,
  type BitmapFloatingRect,
} from './bitmap-floating'

export type BitmapFloatingSession = {
  /** Immutable drag-start snapshot; previews render from this, never mutate it. */
  committed: BitmapFloatingImage
  /** Clamped source rect the patch was lifted from. */
  sourceRect: BitmapFloatingRect
  /** Current (possibly scaled/rotated/flipped) patch. */
  patch: BitmapFloatingImage
  /** Alt-duplicate evaluated at drag start; the Editor may refresh it live. */
  copy: boolean
}

export type BitmapFloatingSessionPreview = {
  /** Preview image; `=== committed` (or `=== base`) when `changed` is false. */
  image: BitmapFloatingImage
  changed: boolean
  /** Clipped canvas rect actually stamped, if any. */
  placedRect: BitmapFloatingRect | undefined
  /** Destination top-left the patch was stamped at (unclipped, truncated). */
  destX: number
  destY: number
  copy: boolean
}

export type BitmapFloatingScaleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** Legacy alias: previously only `'nw'` was modelled; now any handle. */
export type BitmapFloatingScaleAnchor = BitmapFloatingScaleHandle

export type BitmapFloatingScaleModifiers = {
  /** Corner handles stay uniform unless `true` (edges always stay single-axis). */
  shiftKey?: boolean
  /** `true` pins the selection center instead of the diagonal fixed point. */
  altKey?: boolean
  /** Explicit uniform override; defaults to corner-without-Shift. */
  uniform?: boolean
}

export type BitmapFloatingScaleResult = {
  scaleX: number
  scaleY: number
  /** Rounded canvas top-left that keeps the pivot fixed. */
  destX: number
  destY: number
  /** Rounded scaled patch size (`round(source * |scale|)`). */
  width: number
  height: number
  /** Fixed point the scale is applied around (canvas pixels). */
  pivot: { x: number; y: number }
  handle: BitmapFloatingScaleHandle
  isUniform: boolean
  isCentered: boolean
  flippedX: boolean
  flippedY: boolean
}

/** Smallest absolute scale kept; tinier drags snap to this with sign kept. */
export const MIN_BITMAP_FLOATING_SCALE_FACTOR = 0.001

/** Corner handles (`nw`/`ne`/`se`/`sw`) scale both axes; edges scale one. */
export function isBitmapFloatingCornerHandle(handle: BitmapFloatingScaleHandle): boolean {
  return handle.length === 2
}

function bitmapFloatingCenter(rect: BitmapFloatingRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function bitmapFloatingGrabbedPoint(
  handle: BitmapFloatingScaleHandle,
  rect: BitmapFloatingRect,
): { x: number; y: number } {
  const center = bitmapFloatingCenter(rect)
  return {
    x: handle.includes('w') ? rect.x : handle.includes('e') ? rect.x + rect.width : center.x,
    y: handle.includes('n') ? rect.y : handle.includes('s') ? rect.y + rect.height : center.y,
  }
}

function bitmapFloatingOpposingPoint(
  handle: BitmapFloatingScaleHandle,
  rect: BitmapFloatingRect,
): { x: number; y: number } {
  const center = bitmapFloatingCenter(rect)
  return {
    x: handle.includes('w') ? rect.x + rect.width : handle.includes('e') ? rect.x : center.x,
    y: handle.includes('n') ? rect.y + rect.height : handle.includes('s') ? rect.y : center.y,
  }
}

function clampBitmapFloatingScaleFactor(value: number): number {
  if (!Number.isFinite(value)) return 1
  if (Math.abs(value) >= MIN_BITMAP_FLOATING_SCALE_FACTOR) return value
  return value < 0 ? -MIN_BITMAP_FLOATING_SCALE_FACTOR : MIN_BITMAP_FLOATING_SCALE_FACTOR
}

function isBitmapFloatingScaleHandle(value: unknown): value is BitmapFloatingScaleHandle {
  return (
    value === 'nw' ||
    value === 'n' ||
    value === 'ne' ||
    value === 'e' ||
    value === 'se' ||
    value === 's' ||
    value === 'sw' ||
    value === 'w'
  )
}

function isRect(value: unknown): value is BitmapFloatingRect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  )
}

/**
 * Freeze a floating session from the live canvas image and the current
 * selection rect. Returns `undefined` for unusable/empty/offscreen input so
 * the Editor can fall back to marquee selection. The input image is copied,
 * never retained by reference.
 */
export function beginBitmapFloatingSession(
  image: BitmapFloatingImage,
  rect: BitmapFloatingRect,
  options: { copy?: boolean } = {},
): BitmapFloatingSession | undefined {
  if (!isRect(rect)) return undefined
  const extracted = extractFloatingPatch(image, rect)
  if (!extracted) return undefined
  return {
    committed: {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
    },
    sourceRect: { ...extracted.rect },
    patch: {
      width: extracted.patch.width,
      height: extracted.patch.height,
      data: new Uint8ClampedArray(extracted.patch.data),
    },
    copy: options.copy === true,
  }
}

/**
 * Render a session at a destination top-left with source-over stamping.
 * Plain moves punch the source rect first; Alt-duplicates keep it.
 * `(destX, destY)` truncate toward zero; placements clip against the canvas.
 * Fully-offscreen Alt stamps are a no-op (`changed: false`); fully-offscreen
 * plain moves keep the punched hole (`changed: true`), matching
 * `previewFloatingMove`.
 */
export function renderBitmapFloatingSession(
  session: BitmapFloatingSession,
  destX: number,
  destY: number,
  options: { copy?: boolean } = {},
): BitmapFloatingSessionPreview {
  const copy = options.copy ?? session.copy
  if (!session || !Number.isFinite(destX) || !Number.isFinite(destY)) {
    return {
      image: session.committed,
      changed: false,
      placedRect: undefined,
      destX: 0,
      destY: 0,
      copy,
    }
  }
  const x = Math.trunc(destX)
  const y = Math.trunc(destY)
  const base = copy
    ? {
      width: session.committed.width,
      height: session.committed.height,
      data: new Uint8ClampedArray(session.committed.data),
    }
    : clearFloatingRectForMove(session.committed, session.sourceRect).image
  const stamped = compositeFloatingPatch(base, session.patch, x, y)
  if (!stamped.changed) {
    if (copy) {
      return { image: session.committed, changed: false, placedRect: undefined, destX: x, destY: y, copy }
    }
    return { image: base, changed: true, placedRect: undefined, destX: x, destY: y, copy }
  }
  return { image: stamped.image, changed: true, placedRect: stamped.placedRect, destX: x, destY: y, copy }
}

/**
 * Session preview for a move drag: the destination follows the clamped
 * source rect shifted by the truncated pointer delta.
 */
export function previewBitmapFloatingMove(
  session: BitmapFloatingSession,
  dx: number,
  dy: number,
  options: { copy?: boolean } = {},
): BitmapFloatingSessionPreview {
  if (!session || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    return {
      image: session.committed,
      changed: false,
      placedRect: undefined,
      destX: session.sourceRect.x,
      destY: session.sourceRect.y,
      copy: options.copy ?? session.copy,
    }
  }
  // Zero-delta moves stamp the identical block back over itself: a no-op
  // returning the committed reference (mirrors `previewFloatingMove`), so
  // clicks and sub-pixel jitter never produce history entries. Transformed
  // patches (scale/rotate) render through `renderBitmapFloatingSession`
  // instead, where the same origin with a different patch is a real change.
  if (Math.trunc(dx) === 0 && Math.trunc(dy) === 0) {
    const copy = options.copy ?? session.copy
    return {
      image: session.committed,
      changed: false,
      placedRect: { ...session.sourceRect },
      destX: session.sourceRect.x,
      destY: session.sourceRect.y,
      copy,
    }
  }
  return renderBitmapFloatingSession(
    session,
    session.sourceRect.x + Math.trunc(dx),
    session.sourceRect.y + Math.trunc(dy),
    options,
  )
}

/** Full destination rect (unclipped) for overlays and selection updates. */
export function bitmapFloatingDestRect(
  session: BitmapFloatingSession,
  dx: number,
  dy: number,
): BitmapFloatingRect {
  const stepX = Number.isFinite(dx) ? Math.trunc(dx) : 0
  const stepY = Number.isFinite(dy) ? Math.trunc(dy) : 0
  return {
    x: session.sourceRect.x + stepX,
    y: session.sourceRect.y + stepY,
    width: session.patch.width,
    height: session.patch.height,
  }
}

/**
 * Scale factors for the SE handle drag with the NW corner pinned. The drag
 * always measures from the *original* source size (never incrementally), so
 * repeated moves cannot drift. Returns `undefined` for non-positive or
 * non-finite factors, oversized output, or unusable sessions; callers keep
 * the last preview in that case.
 */
export function resolveBitmapFloatingScale(
  session: BitmapFloatingSession,
  pointerX: number,
  pointerY: number,
  options: { uniform?: boolean } = {},
): { scaleX: number; scaleY: number } | undefined {
  if (!session || !Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return undefined
  const { sourceRect } = session
  if (!(sourceRect.width > 0) || !(sourceRect.height > 0)) return undefined
  let scaleX = (pointerX - sourceRect.x) / sourceRect.width
  let scaleY = (pointerY - sourceRect.y) / sourceRect.height
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return undefined
  if (options.uniform === true) {
    const uniform = Math.max(scaleX, scaleY)
    scaleX = uniform
    scaleY = uniform
  }
  if (!(scaleX > 0) || !(scaleY > 0)) return undefined
  return { scaleX, scaleY }
}

/**
 * Scale factors + fixed-pivot destination for any of the 8 handles.
 * The drag always measures from the *original* source size (never
 * incrementally), so repeated moves cannot drift and mid-drag Alt/Shift
 * toggles recompute cleanly from the current modifiers. Corner handles stay
 * uniform unless Shift is held; edge handles scale a single axis; Alt pins
 * the selection center (distances count double, both sides grow); crossing
 * the fixed point yields a negative factor so the patch mirrors instead of
 * stalling. Callers keep the last preview when this returns `undefined`
 * (unusable session/handle or non-finite pointer).
 */
export function resolveBitmapFloatingScaleForHandle(
  session: BitmapFloatingSession,
  handle: BitmapFloatingScaleHandle,
  pointerX: number,
  pointerY: number,
  modifiers: BitmapFloatingScaleModifiers = {},
): BitmapFloatingScaleResult | undefined {
  if (!session || !isBitmapFloatingScaleHandle(handle)) return undefined
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return undefined
  const { sourceRect } = session
  if (!sourceRect || !(sourceRect.width > 0) || !(sourceRect.height > 0)) return undefined
  const center = bitmapFloatingCenter(sourceRect)
  const grabbed = bitmapFloatingGrabbedPoint(handle, sourceRect)
  const opposing = bitmapFloatingOpposingPoint(handle, sourceRect)
  const movesX = handle.includes('w') || handle.includes('e')
  const movesY = handle.includes('n') || handle.includes('s')
  const movedX = movesX ? pointerX : center.x
  const movedY = movesY ? pointerY : center.y
  const centered = modifiers.altKey === true
  const currentX = centered ? (movedX - center.x) * 2 : movedX - opposing.x
  const currentY = centered ? (movedY - center.y) * 2 : movedY - opposing.y
  const spanX = grabbed.x - opposing.x
  const spanY = grabbed.y - opposing.y
  const hasSpanX = Math.abs(spanX) > 1e-7
  const hasSpanY = Math.abs(spanY) > 1e-7
  let scaleX = movesX && hasSpanX ? currentX / spanX : 1
  let scaleY = movesY && hasSpanY ? currentY / spanY : 1
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return undefined

  const corner = isBitmapFloatingCornerHandle(handle)
  const uniform = modifiers.uniform ?? (corner && modifiers.shiftKey !== true)
  let isUniform = false
  if (uniform && corner) {
    const magnitude = Math.max(Math.abs(scaleX), Math.abs(scaleY))
    scaleX = (scaleX < 0 ? -1 : 1) * magnitude
    scaleY = (scaleY < 0 ? -1 : 1) * magnitude
    isUniform = true
  }
  if (movesX) scaleX = clampBitmapFloatingScaleFactor(scaleX)
  else scaleX = 1
  if (movesY) scaleY = clampBitmapFloatingScaleFactor(scaleY)
  else scaleY = 1

  const pivot = centered ? { ...center } : { ...opposing }
  const width = Math.round(sourceRect.width * Math.abs(scaleX))
  const height = Math.round(sourceRect.height * Math.abs(scaleY))
  const leftPrime = pivot.x + (sourceRect.x - pivot.x) * scaleX
  const rightPrime = pivot.x + (sourceRect.x + sourceRect.width - pivot.x) * scaleX
  const topPrime = pivot.y + (sourceRect.y - pivot.y) * scaleY
  const bottomPrime = pivot.y + (sourceRect.y + sourceRect.height - pivot.y) * scaleY
  return {
    scaleX,
    scaleY,
    destX: Math.round(Math.min(leftPrime, rightPrime)),
    destY: Math.round(Math.min(topPrime, bottomPrime)),
    width,
    height,
    pivot,
    handle,
    isUniform,
    isCentered: centered,
    flippedX: scaleX < 0,
    flippedY: scaleY < 0,
  }
}

/**
 * Scale the session patch in place (nearest neighbour, alpha verbatim) and
 * return the scaled patch. No-op scales return the input reference with
 * `changed: false`; the session keeps pointing at the same patch.
 */
export function scaleBitmapFloatingSession(
  session: BitmapFloatingSession,
  scaleX: number,
  scaleY: number,
): { patch: BitmapFloatingImage; changed: boolean } {
  const scaled = scaleFloatingPatch(session.patch, scaleX, scaleY)
  if (!scaled.changed) return { patch: session.patch, changed: false }
  session.patch = scaled.patch
  return { patch: scaled.patch, changed: true }
}

/** Exact quarter-turn rotation of the session patch (clockwise degrees). */
export function rotateBitmapFloatingSession(
  session: BitmapFloatingSession,
  degreesClockwise: number,
): { patch: BitmapFloatingImage; changed: boolean } {
  const rotated = rotateFloatingPatch90(session.patch, degreesClockwise)
  if (!rotated.changed) return { patch: session.patch, changed: false }
  session.patch = rotated.patch
  return { patch: rotated.patch, changed: true }
}

/**
 * Arbitrary-angle rotation of the session patch from a frozen `original`
 * patch (clockwise degrees). Every preview restarts from `original`, never
 * from the previous preview, so repeated pointermoves cannot accumulate
 * resampling. Near-zero angles (and oversized/unusable output) report
 * `changed: false` and reset `session.patch` to a copy of `original` so the
 * Editor can restore the committed snapshot without history.
 */
export function rotateBitmapFloatingSessionArbitrary(
  session: BitmapFloatingSession,
  original: BitmapFloatingImage,
  degreesClockwise: number,
): { patch: BitmapFloatingImage; changed: boolean } {
  const fallback = {
    width: original.width,
    height: original.height,
    data: new Uint8ClampedArray(original.data),
  }
  if (!session || !Number.isFinite(degreesClockwise)) {
    session.patch = fallback
    return { patch: fallback, changed: false }
  }
  const rotated = rotateFloatingPatch(original, degreesClockwise)
  if (!rotated.changed) {
    session.patch = fallback
    return { patch: fallback, changed: false }
  }
  session.patch = rotated.patch
  return { patch: rotated.patch, changed: true }
}

/**
 * Halo-aware arbitrary rotation of the session patch (safe: halo neighbours
 * outside the selection are treated as transparent, so the result is
 * byte-identical to `rotateBitmapFloatingSessionArbitrary`). `halo` is
 * accepted for signature compatibility only and never sampled outside the
 * selection (see `rotateFloatingPatchWithHalo`); a missing/unusable halo
 * likewise falls back to patch-only sampling byte-for-byte.
 * Every preview restarts from `original`, never incrementally.
 */
export function rotateBitmapFloatingSessionArbitraryWithHalo(
  session: BitmapFloatingSession,
  original: BitmapFloatingImage,
  halo: BitmapFloatingHalo | undefined,
  degreesClockwise: number,
): { patch: BitmapFloatingImage; changed: boolean } {
  const fallback = {
    width: original.width,
    height: original.height,
    data: new Uint8ClampedArray(original.data),
  }
  if (!session || !Number.isFinite(degreesClockwise)) {
    session.patch = fallback
    return { patch: fallback, changed: false }
  }
  const rotated = rotateFloatingPatchWithHalo(original, halo, degreesClockwise)
  if (!rotated.changed) {
    session.patch = fallback
    return { patch: fallback, changed: false }
  }
  session.patch = rotated.patch
  return { patch: rotated.patch, changed: true }
}

/** Mirror the session patch. Flagless calls are a no-op. */
export function flipBitmapFloatingSession(
  session: BitmapFloatingSession,
  options: { horizontal?: boolean; vertical?: boolean } = {},
): { patch: BitmapFloatingImage; changed: boolean } {
  const flipped = flipFloatingPatch(session.patch, options)
  if (!flipped.changed) return { patch: session.patch, changed: false }
  session.patch = flipped.patch
  return { patch: flipped.patch, changed: true }
}

/**
 * Destination that keeps the patch centered on the source rect (used by the
 * toolbar 90-degree rotation so non-square selections rotate in place
 * instead of sliding to the top-left anchor).
 */
export function centeredBitmapFloatingDest(
  sourceRect: BitmapFloatingRect,
  patchWidth: number,
  patchHeight: number,
): { x: number; y: number } {
  const centerX = sourceRect.x + sourceRect.width / 2
  const centerY = sourceRect.y + sourceRect.height / 2
  return { x: Math.round(centerX - patchWidth / 2), y: Math.round(centerY - patchHeight / 2) }
}

/** True when a move drag carries no visible change (zero delta). */
export function isNoopBitmapFloatingMove(dx: number, dy: number): boolean {
  return isNoopFloatingTransform({ dx, dy })
}

export { isNoopFloatingTransform }
export type { BitmapFloatingImage, BitmapFloatingRect }
