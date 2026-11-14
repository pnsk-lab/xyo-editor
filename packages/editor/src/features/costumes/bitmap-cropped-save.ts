// Bitmap cropped-save preparation (clean-room, no third-party paint source).
//
// Pure synchronous preparation for the editor cropped-save builder:
// given an already-read RGBA raster plus the artboard/center
// bookkeeping, validate it and compute the exact stored-asset geometry the
// async PNG encode will persist.
//
// What this module does:
// - Mirrors the synchronous decision prefix of the editor save builder
//   byte-for-byte (source-size gate, opaque trim, artboard-center math,
//   rotation-center drag offset, conversion-size gate) without touching the
//   DOM, canvas, VM, history, status, timers, or events, so unit tests run in
//   Node and future pending-shape CAS integration can reuse it as the
//   non-recursive lower save preparation.
// - Never throws: every malformed input fails closed to `refused` or
//   `transparent` (the same verdicts the editor maps to its refused sentinel
//   / `undefined`). Read failures (image readback throw, null 2d context)
//   are modelled by passing `rgba: undefined` and always refuse — never a
//   transparent no-op, so stored ink can never be blanked by an unreadable
//   raster.
//
// What this module never does:
// - No document/canvas/ImageData allocation, no toBlob encode, no VM store
//   reads/writes, no history peek/commit, no status write, no
//   owner/serial/revision async re-validation. Those stay with the caller
//   (`Editor.svelte`), which keeps its pre/post-encode gates and event timing
//   unchanged.
//
// Byte-for-byte contract (pinned by `test/bitmap-cropped-save.test.ts`):
// - `ccx/ccy` use the live track only when `track.isStage === isStage`,
//   else the resolution-matched artboard center; `originX/Y` fall back to 0
//   on a stage mismatch (verbatim `Editor.svelte`).
// - `storedCx/Cy` prefer the finite stored center, else `cc - origin`.
// - `offset = centerOffset + (storedNow - placementCenter)`; the returned
//   `rotationCenter` already includes the offset, and `centerOffsetX/Y` carry
//   it for the post-write bookkeeping (idempotent pure re-saves).
// - The stored resolution is preserved verbatim via `croppedSaveForTrim`
//   (never re-derived from the target kind).

import {
  artboardForTarget,
  croppedSaveForTrim,
  isBitmapSourceSizeRefused,
  opaqueTrimFromRgba,
  bytesEqual,
  type BitmapTrim,
} from './bitmap-artboard'
import { isConversionRasterSizeRefused } from './costume-conversion'

/** Live artboard track consumed by the save math (plain data, no DOM). */
export type BitmapCroppedSaveTrack = {
  canvasCenterX: number
  canvasCenterY: number
  originX: number
  originY: number
  isStage: boolean
}

/** Input for the pure preparation (already-read raster + bookkeeping). */
export type BitmapCroppedSaveInput = {
  /** Raw RGBA bytes of the source raster (`undefined` models an unreadable raster). */
  rgba: Uint8ClampedArray | Uint8Array | undefined | null
  imageWidth: number
  imageHeight: number
  isStage: boolean
  storedResolution?: unknown
  track: BitmapCroppedSaveTrack
  storedCenterX?: unknown
  storedCenterY?: unknown
  centerOffset: { x: number; y: number }
  placementCenter: { x: number; y: number }
}

export type BitmapCroppedSaveMeta = {
  width: number
  height: number
  rotationCenterX: number
  rotationCenterY: number
  bitmapResolution: number
  centerOffsetX: number
  centerOffsetY: number
}

export type PreparedCroppedBitmapSave =
  | { kind: 'refused'; reason: 'source-size' | 'conversion-size' | 'unreadable' }
  | { kind: 'transparent' }
  | ({ kind: 'save'; trim: BitmapTrim } & BitmapCroppedSaveMeta)

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function toCenterOffset(value: unknown): { x: number; y: number } {
  if (!value || typeof value !== 'object') return { x: 0, y: 0 }
  const record = value as Record<string, unknown>
  return {
    x: isFiniteNumber(record.x) ? (record.x as number) : 0,
    y: isFiniteNumber(record.y) ? (record.y as number) : 0,
  }
}

/**
 * Pure validation + geometry for one cropped bitmap save.
 * Never throws, never mutates its input, never touches DOM/VM/history.
 */
export function prepareCroppedBitmapSave(input: BitmapCroppedSaveInput): PreparedCroppedBitmapSave {
  try {
    if (!input || typeof input !== 'object') return { kind: 'refused', reason: 'unreadable' }
    const { imageWidth, imageHeight, isStage, storedResolution, track } = input
    if (typeof imageWidth !== 'number' || typeof imageHeight !== 'number') return { kind: 'refused', reason: 'source-size' }
    if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight)) return { kind: 'refused', reason: 'source-size' }
    if (!(imageWidth > 0 && imageHeight > 0)) return { kind: 'refused', reason: 'source-size' }
    if (isBitmapSourceSizeRefused(imageWidth, imageHeight)) return { kind: 'refused', reason: 'source-size' }
    const rgba = (input as { rgba?: unknown }).rgba
    // `undefined`/`null` models the editor's `getContext() === null` and
    // `getImageData` throw paths: an unreadable raster refuses, never a
    // transparent no-op (otherwise stored ink would be blanked).
    if (rgba === undefined || rgba === null) return { kind: 'refused', reason: 'unreadable' }
    if (!(rgba instanceof Uint8ClampedArray) && !(rgba instanceof Uint8Array)) return { kind: 'refused', reason: 'unreadable' }
    // Short-array gate: a raster shorter than width*height*4 can never be a
    // faithful readback (ImageData always yields exactly that many bytes).
    // Without this, `opaqueTrimFromRgba` returns `undefined` for the short
    // input and the helper would report `transparent`, letting the caller
    // delete stored ink (or drop unsaved ink) on malformed data. Refuse
    // instead — never a transparent no-op. Longer arrays are tolerated (the
    // trim scan reads the leading need bytes verbatim).
    {
      const need = imageWidth * imageHeight * 4
      if (!Number.isFinite(need)) return { kind: 'refused', reason: 'unreadable' }
      if ((rgba as Uint8ClampedArray).length < need) return { kind: 'refused', reason: 'unreadable' }
    }
    let trim: BitmapTrim | undefined
    try {
      trim = opaqueTrimFromRgba(rgba as Uint8ClampedArray, imageWidth, imageHeight)
    } catch {
      return { kind: 'refused', reason: 'unreadable' }
    }
    if (!trim) return { kind: 'transparent' }
    if (!(trim.width > 0 && trim.height > 0)) return { kind: 'transparent' }
    // A trimmed raster over the conversion caps can never encode faithfully
    // (65536-wide crops resolve toBlob null): refuse before allocating.
    if (isConversionRasterSizeRefused(trim.width, trim.height)) return { kind: 'refused', reason: 'conversion-size' }
    if (!track || typeof track !== 'object') return { kind: 'refused', reason: 'unreadable' }
    const trackCenterX = (track as BitmapCroppedSaveTrack).canvasCenterX
    const trackCenterY = (track as BitmapCroppedSaveTrack).canvasCenterY
    const trackOriginX = (track as BitmapCroppedSaveTrack).originX
    const trackOriginY = (track as BitmapCroppedSaveTrack).originY
    const trackIsStage = (track as BitmapCroppedSaveTrack).isStage
    if (!isFiniteNumber(trackCenterX) || !isFiniteNumber(trackCenterY)) return { kind: 'refused', reason: 'unreadable' }
    if (!isFiniteNumber(trackOriginX) || !isFiniteNumber(trackOriginY)) return { kind: 'refused', reason: 'unreadable' }
    const fallback = artboardForTarget(isStage, storedResolution)
    const sameStage = trackIsStage === isStage
    const ccx = sameStage ? (trackCenterX as number) : fallback.centerX
    const ccy = sameStage ? (trackCenterY as number) : fallback.centerY
    const originX = sameStage ? (trackOriginX as number) : 0
    const originY = sameStage ? (trackOriginY as number) : 0
    const storedCx = isFiniteNumber(input.storedCenterX) ? (input.storedCenterX as number) : ccx - originX
    const storedCy = isFiniteNumber(input.storedCenterY) ? (input.storedCenterY as number) : ccy - originY
    const offset = toCenterOffset(input.centerOffset)
    const placement = toCenterOffset(input.placementCenter)
    const offsetX = offset.x + (storedCx - placement.x)
    const offsetY = offset.y + (storedCy - placement.y)
    const saved = croppedSaveForTrim({ x: trim.x, y: trim.y, width: trim.width, height: trim.height }, ccx, ccy, isStage, storedResolution)
    saved.rotationCenterX += offsetX
    saved.rotationCenterY += offsetY
    return {
      kind: 'save',
      trim: { x: trim.x, y: trim.y, width: trim.width, height: trim.height },
      width: saved.width,
      height: saved.height,
      rotationCenterX: saved.rotationCenterX,
      rotationCenterY: saved.rotationCenterY,
      bitmapResolution: saved.bitmapResolution,
      centerOffsetX: offsetX,
      centerOffsetY: offsetY,
    }
  } catch {
    return { kind: 'refused', reason: 'unreadable' }
  }
}

/** Stored-bytes side of the same-content Save guard (pure comparison, no VM read). */
export type StoredCroppedBitmapSide = {
  bytes?: Uint8Array | undefined
  rotationCenterX?: number | undefined
  rotationCenterY?: number | undefined
  bitmapResolution?: number | undefined
}

/** Pending side of the same-content Save guard (post-encode bytes + meta). */
export type PendingCroppedBitmapSide = {
  bytes: Uint8Array
  rotationCenterX: number
  rotationCenterY: number
  bitmapResolution: number
}

/**
 * Pure same-content comparison mirroring `isBitmapSaveNoop` without the
 * `vm.loadAsset` read: `true` means the explicit Save is idempotent and must
 * skip capture+write (no empty Undo entry). Never throws.
 */
export function isCroppedBitmapSaveUnchanged(
  stored: StoredCroppedBitmapSide | undefined | null,
  pending: PendingCroppedBitmapSide | undefined | null,
): boolean {
  try {
    if (!stored || typeof stored !== 'object') return false
    if (!pending || typeof pending !== 'object') return false
    const storedBytes = (stored as StoredCroppedBitmapSide).bytes
    const pendingBytes = (pending as PendingCroppedBitmapSide).bytes
    if (!(storedBytes instanceof Uint8Array) || !(pendingBytes instanceof Uint8Array)) return false
    if (!bytesEqual(storedBytes, pendingBytes)) return false
    const cx = (stored as StoredCroppedBitmapSide).rotationCenterX
    const cy = (stored as StoredCroppedBitmapSide).rotationCenterY
    const res = (stored as StoredCroppedBitmapSide).bitmapResolution
    if (cx === pending.rotationCenterX && cy === pending.rotationCenterY && res === pending.bitmapResolution) return true
    // Same pixels but a pending center race: still a real meta change unless
    // the stored side carries no center at all (legacy asset).
    if (cx === undefined && cy === undefined) return true
    return false
  } catch {
    return false
  }
}
