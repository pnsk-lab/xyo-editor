// Bitmap floating-selection helpers: move / Alt-duplicate / scale / rotate.
//
// Independent, DOM-free geometry + ImageData operations for rectangular
// bitmap selections. This module never touches the real Editor, the DOM, or
// CanvasRenderingContext2D: callers pass `{ width, height, data }` images and
// receive new images, so `bun test` can exercise every path without a canvas.
// Wiring into `Editor.svelte` / `BitmapEditor.svelte` is intentionally left
// to a separate task; the integration guide lives in the section at the end
// of this file ("EDITOR INTEGRATION GUIDE (no wiring here)").
//
// Coordinate convention:
// - Rectangles are canvas pixels: `{ x, y, width, height }` in the same space
//   as `getImageData` coordinates. Fractional rectangle edges snap *outward*
//   (floor the origin, ceil the far edge) so a drag never drops an edge pixel.
//   This matches the snapping already used by `trimBitmapRectToOpaque` in
//   `bitmap-selection.ts` (reused here for the trim step, not duplicated).
// - `dx` / `dy` are truncated toward zero to whole pixels before compositing.
// - Placement clips against the canvas: source and destination pixels outside
//   `[0, width) x [0, height)` are skipped. Oversized or fully-offscreen
//   placements therefore degrade to partial or empty no-ops instead of
//   throwing. Sizes are arbitrary; the 2400x1800 costume canvas is just the
//   motivating case (hot loops only touch the selection rectangle, never scan
//   the whole canvas, so previews stay O(selection) on large costumes).
//
// Pixel-move semantics (deliberate, documented):
// - Moving or Alt-duplicating a selection composites the lifted rectangle
//   with Porter-Duff source-over, matching the Canvas 2D `drawImage` default
//   (and the Scratch floating-raster behaviour): fully-transparent patch
//   pixels leave the destination untouched, opaque pixels replace it, and
//   semi-transparent pixels blend over the destination. A verbatim overwrite
//   would erase the background wherever the rectangle has transparent margins
//   or interior holes, so it is *not* used here.
// - The full RGBA tuple travels verbatim through extract, punch-hole, scale,
//   flip, and rotate (alpha is never forced to 255 and colors are never
//   premultiplied), so source alpha survives round-trips. Only the final
//   stamp (`compositeFloatingPatch` / `previewFloatingMove`) blends.
// - Plain move punches the source rectangle to transparent in the preview
//   base; Alt-duplicate (`{ copy: true }`) keeps the source pixels in the
//   base. The input image is never mutated in either mode: previews allocate
//   a fresh buffer (or return the input reference unchanged for no-ops).
// - Smoothing/interpolation is intentionally *not* applied here (nearest
//   neighbour everywhere). If the editor wants a smoothed on-screen drag it
//   can `drawImage` the patch onto a canvas itself; the committed pixels
//   should come from these helpers so history stays deterministic.
//
// No-op contract (mirrors `bitmap-fill.ts`):
// - Unusable images (wrong dimensions, bad buffer length), empty rectangles,
//   non-finite numbers, zero scales, empty placements, and fully-transparent
//   stamps (source-over would change nothing) return
//   `{ changed: false }` with the *input reference* (`result.image === input`
//   for image results, `result.patch === input` for patch results) so callers
//   can skip history commits and DOM writes.
// - Cancelling is discarding the preview and keeping the original reference:
//   `cancelFloatingPreview(original)` returns `original` itself.
//
// This module was written independently for this repository. It reproduces
// observable paint-tool behavior (rectangular lift/move/duplicate/scale/
// rotate with transparent punch-hole) without copying any third-party source.

import { trimBitmapRectToOpaque } from './bitmap-selection'

export type BitmapFloatingImage = {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type BitmapFloatingRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BitmapFloatingPatch = BitmapFloatingImage

export type BitmapFloatingPreviewOptions = {
  /**
   * Alt-duplicate: keep the source pixels in the preview base and stamp a
   * copy at the destination. `false` (default) punches the source rectangle
   * to transparent first (plain move).
   */
  copy?: boolean
}

export type BitmapFloatingPreviewResult = {
  /** Preview image; `=== input` when `changed` is false. */
  image: BitmapFloatingImage
  /** False when nothing would change (no-op, empty, or unusable input). */
  changed: boolean
  /** Clamped source rectangle the patch was lifted from, if any. */
  sourceRect: BitmapFloatingRect | undefined
  /** Clipped destination rectangle actually stamped, if any. */
  placedRect: BitmapFloatingRect | undefined
  /** True when the Alt-duplicate path was taken. */
  copy: boolean
}

export type BitmapFloatingPatchResult = {
  /** Result patch; `=== input` when `changed` is false. */
  patch: BitmapFloatingPatch
  changed: boolean
}

export type BitmapFloatingFlipOptions = {
  horizontal?: boolean
  vertical?: boolean
}

export type BitmapFloatingTransformFlags = {
  dx?: number
  dy?: number
  scaleX?: number
  scaleY?: number
  /** Clockwise degrees. */
  rotationDegrees?: number
  flipHorizontal?: boolean
  flipVertical?: boolean
}

/** Largest patch dimension produced by scale/rotate (keeps buffers sane). */
export const MAX_BITMAP_FLOATING_EDGE = 8192
/** Largest patch pixel count produced by scale/rotate. */
export const MAX_BITMAP_FLOATING_PIXELS = MAX_BITMAP_FLOATING_EDGE * MAX_BITMAP_FLOATING_EDGE

export function isUsableBitmapFloatingImage(image: BitmapFloatingImage): boolean {
  return (
    !!image &&
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    image.data instanceof Uint8ClampedArray &&
    image.data.length === image.width * image.height * 4
  )
}

function isFiniteRect(rect: BitmapFloatingRect): boolean {
  return (
    !!rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  )
}

/**
 * Validate a caller-supplied rectangle. Positive area is required
 * (`width <= 0 || height <= 0` is empty, not an error: returns `undefined`).
 * Fractional values are preserved here; snapping happens in
 * `clampFloatingRectToImage`.
 */
export function normalizeFloatingRect(rect: BitmapFloatingRect): BitmapFloatingRect | undefined {
  if (!isFiniteRect(rect)) return undefined
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

export { trimBitmapRectToOpaque }

/**
 * Snap a rectangle outward to whole pixels and intersect it with the canvas.
 * Returns `undefined` for empty, non-finite, or fully-offscreen rectangles.
 * Works for any canvas size (2400x1800 and beyond alike).
 */
export function clampFloatingRectToImage(
  imageWidth: number,
  imageHeight: number,
  rect: BitmapFloatingRect,
): BitmapFloatingRect | undefined {
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight)) return undefined
  if (imageWidth <= 0 || imageHeight <= 0) return undefined
  if (!isFiniteRect(rect)) return undefined
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const left = Math.max(0, Math.min(imageWidth, Math.floor(rect.x)))
  const top = Math.max(0, Math.min(imageHeight, Math.floor(rect.y)))
  const right = Math.max(0, Math.min(imageWidth, Math.ceil(rect.x + rect.width)))
  const bottom = Math.max(0, Math.min(imageHeight, Math.ceil(rect.y + rect.height)))
  if (right <= left || bottom <= top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export type BitmapFloatingExtractResult = {
  patch: BitmapFloatingPatch
  /** The clamped source rectangle the patch was copied from. */
  rect: BitmapFloatingRect
}

/**
 * Lift a verbatim copy of the rectangle's pixels. Never mutates the input;
 * the patch owns a fresh buffer with identical RGBA bytes (alpha preserved).
 * Returns `undefined` for unusable images and empty/offscreen rectangles.
 */
export function extractFloatingPatch(
  image: BitmapFloatingImage,
  rect: BitmapFloatingRect,
): BitmapFloatingExtractResult | undefined {
  if (!isUsableBitmapFloatingImage(image)) return undefined
  const clamped = clampFloatingRectToImage(image.width, image.height, rect)
  if (!clamped) return undefined
  const data = new Uint8ClampedArray(clamped.width * clamped.height * 4)
  const src = image.data
  const srcWidth = image.width
  for (let row = 0; row < clamped.height; row += 1) {
    const srcOffset = ((clamped.y + row) * srcWidth + clamped.x) * 4
    const dstOffset = row * clamped.width * 4
    data.set(src.subarray(srcOffset, srcOffset + clamped.width * 4), dstOffset)
  }
  return { patch: { width: clamped.width, height: clamped.height, data }, rect: clamped }
}

function unchangedImage(image: BitmapFloatingImage): { image: BitmapFloatingImage; changed: false } {
  return { image, changed: false }
}

function unchangedPatch(patch: BitmapFloatingPatch): BitmapFloatingPatchResult {
  return { patch, changed: false }
}

/**
 * Preview base for a plain move: the source rectangle punched to transparent.
 * Pixels outside the rectangle are byte-identical to the input. Returns the
 * input reference with `changed: false` for unusable/empty input.
 */
export function clearFloatingRectForMove(
  image: BitmapFloatingImage,
  rect: BitmapFloatingRect,
): { image: BitmapFloatingImage; changed: boolean; clearedRect: BitmapFloatingRect | undefined } {
  if (!isUsableBitmapFloatingImage(image)) return { ...unchangedImage(image), clearedRect: undefined }
  const clamped = clampFloatingRectToImage(image.width, image.height, rect)
  if (!clamped) return { ...unchangedImage(image), clearedRect: undefined }
  const data = new Uint8ClampedArray(image.data)
  for (let row = 0; row < clamped.height; row += 1) {
    const rowStart = ((clamped.y + row) * image.width + clamped.x) * 4
    data.fill(0, rowStart, rowStart + clamped.width * 4)
  }
  return { image: { width: image.width, height: image.height, data }, changed: true, clearedRect: clamped }
}

export type BitmapFloatingCompositeResult = {
  image: BitmapFloatingImage
  changed: boolean
  /** Clipped destination rectangle actually written, if any. */
  placedRect: BitmapFloatingRect | undefined
}

/**
 * Stamp a patch onto a base image with source-over compositing, clipped to
 * the canvas. `(destX, destY)` is the canvas position of the patch's
 * top-left pixel (truncated toward zero). Neither input is mutated.
 *
 * Per-pixel rule (non-premultiplied Porter-Duff source-over):
 * - source alpha 0: destination pixel is left untouched;
 * - source alpha 255: destination pixel is replaced by the source pixel;
 * - otherwise the two pixels are blended; stamping over a transparent
 *   destination copies the source pixel through unchanged.
 * A patch whose clipped pixels are all transparent changes nothing and
 * returns the input reference with `changed: false`.
 */
export function compositeFloatingPatch(
  base: BitmapFloatingImage,
  patch: BitmapFloatingPatch,
  destX: number,
  destY: number,
): BitmapFloatingCompositeResult {
  if (!isUsableBitmapFloatingImage(base) || !isUsableBitmapFloatingImage(patch)) {
    return { ...unchangedImage(base), placedRect: undefined }
  }
  if (!Number.isFinite(destX) || !Number.isFinite(destY)) {
    return { ...unchangedImage(base), placedRect: undefined }
  }
  const x = Math.trunc(destX)
  const y = Math.trunc(destY)
  const left = Math.max(0, x)
  const top = Math.max(0, y)
  const right = Math.min(base.width, x + patch.width)
  const bottom = Math.min(base.height, y + patch.height)
  if (right <= left || bottom <= top) return { ...unchangedImage(base), placedRect: undefined }

  const data = new Uint8ClampedArray(base.data)
  const src = patch.data
  let touched = false
  for (let row = top; row < bottom; row += 1) {
    const patchRow = row - y
    for (let col = left; col < right; col += 1) {
      const patchCol = col - x
      const srcOffset = (patchRow * patch.width + patchCol) * 4
      const sR = src[srcOffset]!
      const sG = src[srcOffset + 1]!
      const sB = src[srcOffset + 2]!
      const sA = src[srcOffset + 3]!
      if (sA === 0) continue
      touched = true
      const dstOffset = (row * base.width + col) * 4
      if (sA === 255) {
        data[dstOffset] = sR
        data[dstOffset + 1] = sG
        data[dstOffset + 2] = sB
        data[dstOffset + 3] = 255
        continue
      }
      const dR = data[dstOffset]!
      const dG = data[dstOffset + 1]!
      const dB = data[dstOffset + 2]!
      const dA = data[dstOffset + 3]!
      if (dA === 0) {
        data[dstOffset] = sR
        data[dstOffset + 1] = sG
        data[dstOffset + 2] = sB
        data[dstOffset + 3] = sA
        continue
      }
      const aS = sA / 255
      const aD = dA / 255
      const outA = aS + aD * (1 - aS)
      const k = 1 / outA
      const rest = aD * (1 - aS)
      data[dstOffset] = Math.round((sR * aS + dR * rest) * k)
      data[dstOffset + 1] = Math.round((sG * aS + dG * rest) * k)
      data[dstOffset + 2] = Math.round((sB * aS + dB * rest) * k)
      data[dstOffset + 3] = Math.round(outA * 255)
    }
  }
  if (!touched) return { ...unchangedImage(base), placedRect: undefined }
  return {
    image: { width: base.width, height: base.height, data },
    changed: true,
    placedRect: { x: left, y: top, width: right - left, height: bottom - top },
  }
}

/**
 * Full non-destructive move/duplicate preview in one call:
 * lift `rect`, optionally punch the hole (plain move), and stamp the patch at
 * `rect + (dx, dy)`. The input image is never mutated.
 *
 * - `dx`/`dy` truncate toward zero; `(0, 0)` is always a no-op returning the
 *   input reference (stamping the identical block back over itself changes
 *   nothing in both move and copy modes).
 * - Fully-offscreen sources or destinations are no-ops.
 */
export function previewFloatingMove(
  image: BitmapFloatingImage,
  rect: BitmapFloatingRect,
  dx: number,
  dy: number,
  options: BitmapFloatingPreviewOptions = {},
): BitmapFloatingPreviewResult {
  const copy = options.copy === true
  if (!isUsableBitmapFloatingImage(image)) {
    return { image, changed: false, sourceRect: undefined, placedRect: undefined, copy }
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { image, changed: false, sourceRect: undefined, placedRect: undefined, copy }
  }
  const extracted = extractFloatingPatch(image, rect)
  if (!extracted) {
    return { image, changed: false, sourceRect: undefined, placedRect: undefined, copy }
  }
  const stepX = Math.trunc(dx)
  const stepY = Math.trunc(dy)
  if (stepX === 0 && stepY === 0) {
    return { image, changed: false, sourceRect: extracted.rect, placedRect: extracted.rect, copy }
  }
  const base = copy
    ? { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
    : clearFloatingRectForMove(image, extracted.rect).image
  const stamped = compositeFloatingPatch(base, extracted.patch, extracted.rect.x + stepX, extracted.rect.y + stepY)
  if (!stamped.changed) {
    // Destination fully offscreen. In copy mode the visible pixels are
    // unchanged; in move mode the hole punch *would* change pixels, so keep
    // the punched base instead of reporting a no-op.
    if (copy) return { image, changed: false, sourceRect: extracted.rect, placedRect: undefined, copy }
    return { image: base, changed: true, sourceRect: extracted.rect, placedRect: undefined, copy }
  }
  return { image: stamped.image, changed: true, sourceRect: extracted.rect, placedRect: stamped.placedRect, copy }
}

/**
 * Cancel a drag: discard the preview and keep the original. Returns the
 * original reference so callers can assert `cancelled === beforeDrag`.
 */
export function cancelFloatingPreview<T>(original: T): T {
  return original
}

/**
 * Nearest-neighbour scale of a patch with verbatim RGBA (alpha preserved).
 * Negative factors mirror that axis (equivalent to flip + positive scale).
 * `1, 1` (and unusable/zero/non-finite factors, or outputs past the edge /
 * pixel caps) is a no-op returning the input reference.
 */
export function scaleFloatingPatch(
  patch: BitmapFloatingPatch,
  scaleX: number,
  scaleY: number,
): BitmapFloatingPatchResult {
  if (!isUsableBitmapFloatingImage(patch)) return unchangedPatch(patch)
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return unchangedPatch(patch)
  if (scaleX === 0 || scaleY === 0) return unchangedPatch(patch)
  if (scaleX === 1 && scaleY === 1) return unchangedPatch(patch)
  const outWidth = Math.round(patch.width * Math.abs(scaleX))
  const outHeight = Math.round(patch.height * Math.abs(scaleY))
  if (!Number.isInteger(outWidth) || !Number.isInteger(outHeight)) return unchangedPatch(patch)
  if (outWidth <= 0 || outHeight <= 0) return unchangedPatch(patch)
  if (outWidth > MAX_BITMAP_FLOATING_EDGE || outHeight > MAX_BITMAP_FLOATING_EDGE) return unchangedPatch(patch)
  if (outWidth * outHeight > MAX_BITMAP_FLOATING_PIXELS) return unchangedPatch(patch)
  const flipX = scaleX < 0
  const flipY = scaleY < 0
  const data = new Uint8ClampedArray(outWidth * outHeight * 4)
  const src = patch.data
  for (let outY = 0; outY < outHeight; outY += 1) {
    let srcY = Math.min(patch.height - 1, Math.floor((outY * patch.height) / outHeight))
    if (flipY) srcY = patch.height - 1 - srcY
    for (let outX = 0; outX < outWidth; outX += 1) {
      let srcX = Math.min(patch.width - 1, Math.floor((outX * patch.width) / outWidth))
      if (flipX) srcX = patch.width - 1 - srcX
      const srcOffset = (srcY * patch.width + srcX) * 4
      const dstOffset = (outY * outWidth + outX) * 4
      data[dstOffset] = src[srcOffset]!
      data[dstOffset + 1] = src[srcOffset + 1]!
      data[dstOffset + 2] = src[srcOffset + 2]!
      data[dstOffset + 3] = src[srcOffset + 3]!
    }
  }
  return { patch: { width: outWidth, height: outHeight, data }, changed: true }
}

/**
 * Mirror a patch. Both flags false (or an unusable patch) returns the input
 * reference with `changed: false`. Alpha travels verbatim.
 */
export function flipFloatingPatch(
  patch: BitmapFloatingPatch,
  options: BitmapFloatingFlipOptions = {},
): BitmapFloatingPatchResult {
  if (!isUsableBitmapFloatingImage(patch)) return unchangedPatch(patch)
  const horizontal = options.horizontal === true
  const vertical = options.vertical === true
  if (!horizontal && !vertical) return unchangedPatch(patch)
  const data = new Uint8ClampedArray(patch.data.length)
  const src = patch.data
  for (let y = 0; y < patch.height; y += 1) {
    const srcY = vertical ? patch.height - 1 - y : y
    for (let x = 0; x < patch.width; x += 1) {
      const srcX = horizontal ? patch.width - 1 - x : x
      const srcOffset = (srcY * patch.width + srcX) * 4
      const dstOffset = (y * patch.width + x) * 4
      data[dstOffset] = src[srcOffset]!
      data[dstOffset + 1] = src[srcOffset + 1]!
      data[dstOffset + 2] = src[srcOffset + 2]!
      data[dstOffset + 3] = src[srcOffset + 3]!
    }
  }
  return { patch: { width: patch.width, height: patch.height, data }, changed: true }
}

/** Normalize any clockwise degree value to `0 | 1 | 2 | 3` quarter turns. */
export function normalizeQuarterTurns(degreesClockwise: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(degreesClockwise)) return 0
  const turns = Math.round(degreesClockwise / 90) % 4
  return ((turns % 4) + 4) % 4 as 0 | 1 | 2 | 3
}

/**
 * Exact quarter-turn rotation (clockwise). `0` (including 360, -90+90, and
 * non-finite input) returns the input reference. Alpha travels verbatim.
 */
export function rotateFloatingPatch90(
  patch: BitmapFloatingPatch,
  degreesClockwise: number,
): BitmapFloatingPatchResult {
  if (!isUsableBitmapFloatingImage(patch)) return unchangedPatch(patch)
  const turns = normalizeQuarterTurns(degreesClockwise)
  if (turns === 0) return unchangedPatch(patch)
  const swap = turns % 2 === 1
  const outWidth = swap ? patch.height : patch.width
  const outHeight = swap ? patch.width : patch.height
  const data = new Uint8ClampedArray(outWidth * outHeight * 4)
  const src = patch.data
  for (let y = 0; y < patch.height; y += 1) {
    for (let x = 0; x < patch.width; x += 1) {
      const srcOffset = (y * patch.width + x) * 4
      let outX = x
      let outY = y
      if (turns === 1) {
        outX = patch.height - 1 - y
        outY = x
      } else if (turns === 2) {
        outX = patch.width - 1 - x
        outY = patch.height - 1 - y
      } else {
        outX = y
        outY = patch.width - 1 - x
      }
      const dstOffset = (outY * outWidth + outX) * 4
      data[dstOffset] = src[srcOffset]!
      data[dstOffset + 1] = src[srcOffset + 1]!
      data[dstOffset + 2] = src[srcOffset + 2]!
      data[dstOffset + 3] = src[srcOffset + 3]!
    }
  }
  return { patch: { width: outWidth, height: outHeight, data }, changed: true }
}

/**
 * Arbitrary clockwise rotation with nearest-neighbour sampling into a tight
 * bounding box. The background is transparent; every sampled pixel keeps its
 * verbatim RGBA. Near-multiples of 360deg (within 1e-9) are a no-op; exact
 * multiples of 90deg delegate to `rotateFloatingPatch90` so right angles stay
 * pixel-exact. Oversized outputs (past the edge/pixel caps) are a no-op.
 */
export function rotateFloatingPatch(
  patch: BitmapFloatingPatch,
  degreesClockwise: number,
): BitmapFloatingPatchResult {
  if (!isUsableBitmapFloatingImage(patch)) return unchangedPatch(patch)
  if (!Number.isFinite(degreesClockwise)) return unchangedPatch(patch)
  const normalized = ((degreesClockwise % 360) + 360) % 360
  if (normalized < 1e-9 || 360 - normalized < 1e-9) return unchangedPatch(patch)
  const nearQuarter = Math.abs(normalized / 90 - Math.round(normalized / 90)) < 1e-9
  if (nearQuarter) return rotateFloatingPatch90(patch, normalized)

  const radians = (normalized * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  // Clockwise rotation of the patch corners around its center.
  const hw = patch.width / 2
  const hh = patch.height / 2
  const corners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [cx, cy] of corners) {
    const rx = cx * cos - cy * sin
    const ry = cx * sin + cy * cos
    if (rx < minX) minX = rx
    if (rx > maxX) maxX = rx
    if (ry < minY) minY = ry
    if (ry > maxY) maxY = ry
  }
  const outWidth = Math.max(1, Math.ceil(maxX - minX))
  const outHeight = Math.max(1, Math.ceil(maxY - minY))
  if (outWidth > MAX_BITMAP_FLOATING_EDGE || outHeight > MAX_BITMAP_FLOATING_EDGE) return unchangedPatch(patch)
  if (outWidth * outHeight > MAX_BITMAP_FLOATING_PIXELS) return unchangedPatch(patch)

  const data = new Uint8ClampedArray(outWidth * outHeight * 4)
  const src = patch.data
  const outCx = outWidth / 2
  const outCy = outHeight / 2
  // Inverse-map each destination pixel (counter-clockwise) to the source.
  const icos = Math.cos(radians)
  const isin = Math.sin(radians)
  for (let outY = 0; outY < outHeight; outY += 1) {
    for (let outX = 0; outX < outWidth; outX += 1) {
      const dx = outX + 0.5 - outCx
      const dy = outY + 0.5 - outCy
      const srcCenterX = dx * icos + dy * isin + hw
      const srcCenterY = -dx * isin + dy * icos + hh
      const srcX = Math.floor(srcCenterX)
      const srcY = Math.floor(srcCenterY)
      if (srcX < 0 || srcY < 0 || srcX >= patch.width || srcY >= patch.height) continue
      const srcOffset = (srcY * patch.width + srcX) * 4
      const dstOffset = (outY * outWidth + outX) * 4
      data[dstOffset] = src[srcOffset]!
      data[dstOffset + 1] = src[srcOffset + 1]!
      data[dstOffset + 2] = src[srcOffset + 2]!
      data[dstOffset + 3] = src[srcOffset + 3]!
    }
  }
  return { patch: { width: outWidth, height: outHeight, data }, changed: true }
}

export type BitmapFloatingHalo = {
  /** Larger source image that contains `patch` (for example a few extra pixels around the selection). */
  image: BitmapFloatingImage
  /** Patch top-left relative to the halo top-left, in halo pixels (truncated toward zero). */
  offsetX: number
  /** Patch top-left relative to the halo top-left, in halo pixels (truncated toward zero). */
  offsetY: number
}

/**
 * Arbitrary clockwise rotation with a halo parameter that is *safely ignored*
 * outside the selection (halo-aware signature, patch-only sampling).
 *
 * Background: an earlier experimental revision sampled real neighbour texels
 * beyond the patch, so an opaque ring directly outside the selection was
 * copied into the rotated patch (independent audit: outside blue appears
 * inside the rotated output). The reference path avoids that by committing
 * through a selection-sized mask over transparent padding: outside-selection
 * pixels never become stamped pixels.
 *
 * Safety rule enforced here: every halo texel outside the selection
 * rectangle is treated as `alpha = 0`, and only selection-interior pixels
 * are used. That is exactly `rotateFloatingPatch` (transparent outside the
 * patch, verbatim RGBA inside, nearest neighbour, same tight box, same
 * 90-degree delegation, same caps, same no-op contract). With or without a
 * usable halo the result is byte-for-byte identical to `rotateFloatingPatch`,
 * so wiring this helper later cannot duplicate outside pixels into the
 * commit. Callers that own no halo keep calling `rotateFloatingPatch`.
 * Alpha travels verbatim; no smoothing/blending is applied here.
 */
export function rotateFloatingPatchWithHalo(
  patch: BitmapFloatingImage,
  halo: BitmapFloatingHalo | undefined,
  degreesClockwise: number,
): BitmapFloatingPatchResult {
  // Safe halo: neighbours outside the selection are always transparent.
  // The halo argument is accepted for signature compatibility only and is
  // never sampled; this keeps the helper unwired-but-harmless if a future
  // task passes a lifted halo with opaque outside neighbours.
  void halo
  return rotateFloatingPatch(patch, degreesClockwise)
}

/** True when a drag carries no visible change (all defaults / identity). */
export function isNoopFloatingTransform(flags: BitmapFloatingTransformFlags = {}): boolean {
  const dx = flags.dx ?? 0
  const dy = flags.dy ?? 0
  const scaleX = flags.scaleX ?? 1
  const scaleY = flags.scaleY ?? 1
  const rotation = flags.rotationDegrees ?? 0
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return true
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return true
  if (!Number.isFinite(rotation)) return true
  if (Math.trunc(dx) !== 0 || Math.trunc(dy) !== 0) return false
  if (scaleX !== 1 || scaleY !== 1) return false
  if (flags.flipHorizontal === true || flags.flipVertical === true) return false
  const normalized = ((rotation % 360) + 360) % 360
  if (!(normalized < 1e-9 || 360 - normalized < 1e-9)) return false
  return true
}

/**
 * Destination geometry for handles/overlays without touching pixels: the
 * clamped source rect shifted by truncated `(dx, dy)`, intersected with the
 * canvas. Returns `undefined` when nothing would be visible.
 */
export function resolveFloatingPlacedRect(
  imageWidth: number,
  imageHeight: number,
  rect: BitmapFloatingRect,
  dx: number,
  dy: number,
): BitmapFloatingRect | undefined {
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight)) return undefined
  if (imageWidth <= 0 || imageHeight <= 0) return undefined
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return undefined
  const clamped = clampFloatingRectToImage(imageWidth, imageHeight, rect)
  if (!clamped) return undefined
  return clampFloatingRectToImage(imageWidth, imageHeight, {
    x: clamped.x + Math.trunc(dx),
    y: clamped.y + Math.trunc(dy),
    width: clamped.width,
    height: clamped.height,
  })
}

// ---------------------------------------------------------------------------
// EDITOR INTEGRATION GUIDE (no wiring here)
// ---------------------------------------------------------------------------
// This module is intentionally Editor-free. A future wiring task owns the
// `BitmapEditor.svelte` drag state, history commits, and canvas I/O. Suggested
// integration, mirroring the existing pure-helper pattern (`bitmap-fill.ts`
// + `applyBitmapFill` in the Editor):
//
// 1. Drag start: `trimBitmapRectToOpaque(liveImage, dragRect)` to drop
//    transparent margins, then `extractFloatingPatch(liveImage, trimmed)` to
//    freeze the lifted pixels. Keep the live image untouched until commit.
// 2. Drag preview (each pointermove): `previewFloatingMove(committedImage,
//    sourceRect, dx, dy, { copy: altHeld })`. Render `result.image` via a
//    single `putImageData`; skip rendering + history when `changed === false`.
// 3. Handles: `scaleFloatingPatch` / `flipFloatingPatch` /
//    `rotateFloatingPatch(90)` transform the *patch*, then
//    `compositeFloatingPatch(base, transformedPatch, destX, destY)` stamps it.
//    `resolveFloatingPlacedRect` drives handle/outline overlays without pixels.
// 4. Commit on pointerup with `changed === true` only; cancel/Escape calls
//    `cancelFloatingPreview(committedImage)` (keeps the original reference,
//    writes nothing). `isNoopFloatingTransform` guards zero-delta commits.
// 5. Canvas exchange: `getImageData` -> `{ width, height, data }` in,
//    `new ImageData(patch.width, patch.height)` + `data.set(...)` +
//    `putImageData` out. For a smoothed on-screen drag the Editor may
//    `drawImage` the patch to an overlay canvas, but commit the helper
//    output so undo stays pixel-exact.
// ---------------------------------------------------------------------------
