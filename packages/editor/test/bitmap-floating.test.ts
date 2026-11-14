import { describe, expect, it } from 'bun:test'
import {
  cancelFloatingPreview,
  clampFloatingRectToImage,
  clearFloatingRectForMove,
  compositeFloatingPatch,
  extractFloatingPatch,
  flipFloatingPatch,
  isNoopFloatingTransform,
  normalizeFloatingRect,
  previewFloatingMove,
  resolveFloatingPlacedRect,
  rotateFloatingPatch,
  rotateFloatingPatch90,
  scaleFloatingPatch,
  trimBitmapRectToOpaque,
  type BitmapFloatingImage,
} from '../src/features/costumes/bitmap-floating'

type RGBA = [number, number, number, number]

const RED: RGBA = [255, 0, 0, 255]
const GREEN: RGBA = [0, 255, 0, 255]
const BLUE: RGBA = [0, 0, 255, 255]
const WHITE: RGBA = [255, 255, 255, 255]
const SEMI: RGBA = [10, 20, 30, 128]
const TRANSPARENT: RGBA = [0, 0, 0, 0]

function makeImage(width: number, height: number, base: RGBA): BitmapFloatingImage {
  const data = new Uint8ClampedArray(width * height * 4)
  const image = { width, height, data }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) paint(image, x, y, base)
  }
  return image
}

function paint(image: BitmapFloatingImage, x: number, y: number, color: RGBA) {
  const index = (y * image.width + x) * 4
  image.data[index] = color[0]
  image.data[index + 1] = color[1]
  image.data[index + 2] = color[2]
  image.data[index + 3] = color[3]
}

function colorAt(image: BitmapFloatingImage, x: number, y: number): RGBA {
  const index = (y * image.width + x) * 4
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!, image.data[index + 3]!]
}

describe('bitmap floating selection: extract + move preview', () => {
  it('moves a block verbatim and punches the source to transparent', () => {
    const image = makeImage(6, 4, WHITE)
    paint(image, 1, 1, RED)
    paint(image, 2, 1, GREEN)
    const snapshot = new Uint8ClampedArray(image.data)

    const result = previewFloatingMove(image, { x: 1, y: 1, width: 2, height: 1 }, 2, 1)

    expect(result.changed).toBe(true)
    expect(result.copy).toBe(false)
    expect(result.sourceRect).toEqual({ x: 1, y: 1, width: 2, height: 1 })
    expect(result.placedRect).toEqual({ x: 3, y: 2, width: 2, height: 1 })
    // Destination carries the exact source bytes.
    expect(colorAt(result.image, 3, 2)).toEqual([...RED])
    expect(colorAt(result.image, 4, 2)).toEqual([...GREEN])
    // Source hole is transparent.
    expect(colorAt(result.image, 1, 1)).toEqual([...TRANSPARENT])
    expect(colorAt(result.image, 2, 1)).toEqual([...TRANSPARENT])
    // Non-selected pixels are untouched.
    expect(colorAt(result.image, 0, 0)).toEqual([...WHITE])
    expect(colorAt(result.image, 5, 3)).toEqual([...WHITE])
    // Pure: the input image is not mutated.
    expect(image.data).toEqual(snapshot)
    expect(result.image.data).not.toBe(image.data)
  })

  it('Alt-duplicate keeps the source pixels and stamps a copy', () => {
    const image = makeImage(6, 4, WHITE)
    paint(image, 1, 1, BLUE)
    const result = previewFloatingMove(image, { x: 1, y: 1, width: 1, height: 1 }, 3, 0, { copy: true })

    expect(result.changed).toBe(true)
    expect(result.copy).toBe(true)
    expect(colorAt(result.image, 1, 1)).toEqual([...BLUE])
    expect(colorAt(result.image, 4, 1)).toEqual([...BLUE])
    expect(colorAt(result.image, 0, 0)).toEqual([...WHITE])
  })

  it('preserves source alpha through extract, hole-punch, and composite', () => {
    const image = makeImage(4, 2, TRANSPARENT)
    paint(image, 0, 0, SEMI)
    paint(image, 1, 0, [200, 100, 50, 1])
    const extracted = extractFloatingPatch(image, { x: 0, y: 0, width: 2, height: 1 })!
    expect(colorAt(extracted.patch, 0, 0)).toEqual([...SEMI])
    expect(colorAt(extracted.patch, 1, 0)).toEqual([200, 100, 50, 1])

    const preview = previewFloatingMove(image, { x: 0, y: 0, width: 2, height: 1 }, 2, 1)
    expect(preview.changed).toBe(true)
    expect(colorAt(preview.image, 2, 1)).toEqual([...SEMI])
    expect(colorAt(preview.image, 3, 1)).toEqual([200, 100, 50, 1])
    // Alpha 1 and 128 survive verbatim: never forced to 255.
    expect(colorAt(preview.image, 2, 1)[3]).toBe(128)
    expect(colorAt(preview.image, 3, 1)[3]).toBe(1)
  })

  it('leaves the destination untouched where the patch is transparent (source-over)', () => {
    const image = makeImage(5, 1, GREEN)
    // 2px block: opaque red followed by a transparent pixel.
    paint(image, 0, 0, RED)
    paint(image, 1, 0, TRANSPARENT)
    const preview = previewFloatingMove(image, { x: 0, y: 0, width: 2, height: 1 }, 3, 0)
    expect(preview.changed).toBe(true)
    expect(colorAt(preview.image, 3, 0)).toEqual([...RED])
    // Transparent patch pixels preserve the background instead of erasing it,
    // matching Canvas `drawImage` source-over (verified against a real canvas).
    expect(colorAt(preview.image, 4, 0)).toEqual([...GREEN])
  })

  it('blends semi-transparent patch pixels source-over the destination', () => {
    const base = makeImage(2, 1, WHITE)
    const patchBase = makeImage(1, 1, TRANSPARENT)
    paint(patchBase, 0, 0, SEMI)
    const patch = { width: 1, height: 1, data: patchBase.data }
    const stamped = compositeFloatingPatch(base, patch, 0, 0)
    expect(stamped.changed).toBe(true)
    // (10,20,30,128) over white: byte-exact Canvas `drawImage` result.
    expect(colorAt(stamped.image, 0, 0)).toEqual([132, 137, 142, 255])
    expect(colorAt(stamped.image, 1, 0)).toEqual([...WHITE])
    // Stamping over a transparent destination copies the source through.
    const empty = makeImage(1, 1, TRANSPARENT)
    const overEmpty = compositeFloatingPatch(empty, patch, 0, 0)
    expect(colorAt(overEmpty.image, 0, 0)).toEqual([...SEMI])
    // Opaque source pixels still replace the destination.
    const opaquePatchBase = makeImage(1, 1, TRANSPARENT)
    paint(opaquePatchBase, 0, 0, RED)
    const opaqueStamped = compositeFloatingPatch(base, { width: 1, height: 1, data: opaquePatchBase.data }, 0, 0)
    expect(colorAt(opaqueStamped.image, 0, 0)).toEqual([...RED])
  })

  it('treats a fully-transparent stamp as a no-op returning the input reference', () => {
    const base = makeImage(3, 2, WHITE)
    const snapshot = new Uint8ClampedArray(base.data)
    const clear = makeImage(2, 1, TRANSPARENT)
    const stamped = compositeFloatingPatch(base, clear, 0, 0)
    expect(stamped.changed).toBe(false)
    expect(stamped.image).toBe(base)
    expect(stamped.placedRect).toBeUndefined()
    expect(base.data).toEqual(snapshot)
  })

  it('never mutates the base or patch passed to composite', () => {
    const base = makeImage(2, 1, WHITE)
    const patchImage = makeImage(1, 1, TRANSPARENT)
    paint(patchImage, 0, 0, SEMI)
    const patch = { width: 1, height: 1, data: patchImage.data }
    const baseSnapshot = new Uint8ClampedArray(base.data)
    const patchSnapshot = new Uint8ClampedArray(patch.data)
    compositeFloatingPatch(base, patch, 0, 0)
    expect(base.data).toEqual(baseSnapshot)
    expect(patch.data).toEqual(patchSnapshot)
  })

  it('clips placements at canvas boundaries and reports the clipped rect', () => {
    const image = makeImage(4, 4, WHITE)
    paint(image, 0, 0, RED)
    paint(image, 1, 0, GREEN)
    const result = previewFloatingMove(image, { x: 0, y: 0, width: 2, height: 1 }, 3, 0)
    expect(result.changed).toBe(true)
    expect(result.placedRect).toEqual({ x: 3, y: 0, width: 1, height: 1 })
    expect(colorAt(result.image, 3, 0)).toEqual([...RED])
    // The hole punch still clears the whole source rect.
    expect(colorAt(result.image, 0, 0)).toEqual([...TRANSPARENT])
    expect(resolveFloatingPlacedRect(4, 4, { x: 0, y: 0, width: 2, height: 1 }, 3, 0)).toEqual({
      x: 3, y: 0, width: 1, height: 1,
    })
  })

  it('clamps oversized and negative source rects instead of throwing', () => {
    const image = makeImage(4, 4, WHITE)
    paint(image, 3, 3, RED)
    expect(clampFloatingRectToImage(4, 4, { x: -5, y: -5, width: 20, height: 20 })).toEqual({
      x: 0, y: 0, width: 4, height: 4,
    })
    const result = previewFloatingMove(image, { x: 2, y: 2, width: 10, height: 10 }, 0, 0)
    // (0, 0) delta is a no-op even for a clamped rect.
    expect(result.changed).toBe(false)
    expect(result.image).toBe(image)
    expect(result.sourceRect).toEqual({ x: 2, y: 2, width: 2, height: 2 })
    const moved = previewFloatingMove(image, { x: 2, y: 2, width: 10, height: 10 }, -2, -2)
    expect(moved.changed).toBe(true)
    expect(colorAt(moved.image, 1, 1)).toEqual([...RED])
  })

  it('treats zero deltas, empty rects, and bad input as no-ops returning the input reference', () => {
    const image = makeImage(3, 3, WHITE)
    paint(image, 1, 1, RED)
    for (const delta of [[0, 0], [0.4, -0.4]] as const) {
      const result = previewFloatingMove(image, { x: 1, y: 1, width: 1, height: 1 }, delta[0], delta[1])
      expect(result.changed).toBe(false)
      expect(result.image).toBe(image)
    }
    expect(previewFloatingMove(image, { x: 1, y: 1, width: 0, height: 1 }, 1, 0).changed).toBe(false)
    expect(previewFloatingMove(image, { x: 99, y: 99, width: 2, height: 2 }, 1, 0).changed).toBe(false)
    expect(previewFloatingMove(image, { x: 0, y: 0, width: 1, height: 1 }, Number.NaN, 0).changed).toBe(false)
    const broken = { width: 2, height: 2, data: new Uint8ClampedArray(3) }
    expect(previewFloatingMove(broken, { x: 0, y: 0, width: 1, height: 1 }, 1, 0).changed).toBe(false)
    // Alt copy onto itself is also a no-op.
    const dup = previewFloatingMove(image, { x: 1, y: 1, width: 1, height: 1 }, 0, 0, { copy: true })
    expect(dup.changed).toBe(false)
    expect(dup.image).toBe(image)
    expect(isNoopFloatingTransform({})).toBe(true)
    expect(isNoopFloatingTransform({ dx: 0, dy: 0, scaleX: 1, scaleY: 1, rotationDegrees: 360 })).toBe(true)
    expect(isNoopFloatingTransform({ dx: 1 })).toBe(false)
    expect(isNoopFloatingTransform({ scaleX: -1 })).toBe(false)
    expect(isNoopFloatingTransform({ flipVertical: true })).toBe(false)
    expect(isNoopFloatingTransform({ rotationDegrees: 90 })).toBe(false)
  })

  it('cancelling discards the preview and keeps the original reference', () => {
    const image = makeImage(3, 3, WHITE)
    paint(image, 0, 0, RED)
    const preview = previewFloatingMove(image, { x: 0, y: 0, width: 1, height: 1 }, 2, 2)
    expect(preview.changed).toBe(true)
    expect(colorAt(preview.image, 2, 2)).toEqual([...RED])
    const cancelled = cancelFloatingPreview(image)
    expect(cancelled).toBe(image)
    expect(colorAt(cancelled, 0, 0)).toEqual([...RED])
    expect(colorAt(cancelled, 2, 2)).toEqual([...WHITE])
  })

  it('trims transparent margins via the shared selection helper before lifting', () => {
    const data = new Uint8ClampedArray(8 * 6 * 4)
    const image = { width: 8, height: 6, data }
    paint(image, 3, 2, RED)
    paint(image, 4, 2, GREEN)
    paint(image, 3, 3, BLUE)
    const trimmed = trimBitmapRectToOpaque(image, { x: 0, y: 0, width: 8, height: 6 })
    expect(trimmed).toEqual({ x: 3, y: 2, width: 2, height: 2 })
    const extracted = extractFloatingPatch(image, trimmed!)
    expect(extracted?.patch.width).toBe(2)
    expect(extracted?.patch.height).toBe(2)
    expect(colorAt(extracted!.patch, 0, 0)).toEqual([...RED])
    expect(colorAt(extracted!.patch, 1, 0)).toEqual([...GREEN])
    expect(colorAt(extracted!.patch, 0, 1)).toEqual([...BLUE])
    expect(colorAt(extracted!.patch, 1, 1)).toEqual([...TRANSPARENT])
    expect(trimBitmapRectToOpaque(image, { x: 0, y: 0, width: 2, height: 2 })).toBeUndefined()
  })

  it('handles 2400x1800 geometry without allocating the full canvas', () => {
    // Geometry-only: clamping/placement on the costume-canvas size.
    expect(clampFloatingRectToImage(2400, 1800, { x: 2390, y: 1790, width: 50, height: 50 })).toEqual({
      x: 2390, y: 1790, width: 10, height: 10,
    })
    expect(resolveFloatingPlacedRect(2400, 1800, { x: 2390, y: 1790, width: 10, height: 10 }, 5, 5)).toEqual({
      x: 2395, y: 1795, width: 5, height: 5,
    })
    expect(resolveFloatingPlacedRect(2400, 1800, { x: 0, y: 0, width: 100, height: 100 }, 5000, 0)).toBeUndefined()
    expect(normalizeFloatingRect({ x: 0, y: 0, width: 2400, height: 1800 })).toEqual({
      x: 0, y: 0, width: 2400, height: 1800,
    })
    // A real 2400x1800 pixel round-trip on a sparse selection stays O(rect).
    const big = makeImage(2400, 1800, TRANSPARENT)
    paint(big, 1200, 900, SEMI)
    paint(big, 1201, 900, RED)
    const snapshotByte = big.data[(900 * 2400 + 1200) * 4 + 3]
    const moved = previewFloatingMove(big, { x: 1200, y: 900, width: 2, height: 1 }, 10, -10)
    expect(moved.changed).toBe(true)
    expect(moved.placedRect).toEqual({ x: 1210, y: 890, width: 2, height: 1 })
    expect(colorAt(moved.image, 1210, 890)).toEqual([...SEMI])
    expect(colorAt(moved.image, 1211, 890)).toEqual([...RED])
    expect(colorAt(moved.image, 1200, 900)).toEqual([...TRANSPARENT])
    expect(colorAt(moved.image, 0, 0)).toEqual([...TRANSPARENT])
    expect(big.data[(900 * 2400 + 1200) * 4 + 3]).toBe(snapshotByte)
  })
})

describe('bitmap floating selection: patch transforms', () => {
  function twoByTwo(): BitmapFloatingImage {
    const patch = makeImage(2, 2, TRANSPARENT)
    paint(patch, 0, 0, RED)
    paint(patch, 1, 0, GREEN)
    paint(patch, 0, 1, BLUE)
    paint(patch, 1, 1, SEMI)
    return patch
  }

  it('scales with nearest neighbour and keeps alpha verbatim', () => {
    const patch = makeImage(2, 1, TRANSPARENT)
    paint(patch, 0, 0, RED)
    paint(patch, 1, 0, SEMI)
    const scaled = scaleFloatingPatch(patch, 2, 2)
    expect(scaled.changed).toBe(true)
    expect(scaled.patch.width).toBe(4)
    expect(scaled.patch.height).toBe(2)
    for (const y of [0, 1]) {
      expect(colorAt(scaled.patch, 0, y)).toEqual([...RED])
      expect(colorAt(scaled.patch, 1, y)).toEqual([...RED])
      expect(colorAt(scaled.patch, 2, y)).toEqual([...SEMI])
      expect(colorAt(scaled.patch, 3, y)).toEqual([...SEMI])
    }
    const half = scaleFloatingPatch(makeImage(4, 4, RED), 0.5, 0.5)
    expect(half.patch.width).toBe(2)
    expect(half.patch.height).toBe(2)
    expect(colorAt(half.patch, 1, 1)).toEqual([...RED])
    // No-op scale returns the input reference.
    expect(scaleFloatingPatch(patch, 1, 1).patch).toBe(patch)
    expect(scaleFloatingPatch(patch, 0, 1).changed).toBe(false)
    expect(scaleFloatingPatch(patch, Number.NaN, 1).changed).toBe(false)
  })

  it('treats negative scales as mirror + scale', () => {
    const patch = twoByTwo()
    const mirrored = scaleFloatingPatch(patch, -1, 1)
    expect(mirrored.changed).toBe(true)
    expect(colorAt(mirrored.patch, 0, 0)).toEqual([...GREEN])
    expect(colorAt(mirrored.patch, 1, 0)).toEqual([...RED])
    expect(colorAt(mirrored.patch, 0, 1)).toEqual([...SEMI])
    expect(colorAt(mirrored.patch, 1, 1)).toEqual([...BLUE])
  })

  it('flips horizontally and vertically, preserving alpha', () => {
    const patch = twoByTwo()
    const h = flipFloatingPatch(patch, { horizontal: true })
    expect(h.changed).toBe(true)
    expect(colorAt(h.patch, 0, 0)).toEqual([...GREEN])
    expect(colorAt(h.patch, 1, 1)).toEqual([...BLUE])
    const v = flipFloatingPatch(patch, { vertical: true })
    expect(colorAt(v.patch, 0, 0)).toEqual([...BLUE])
    expect(colorAt(v.patch, 0, 1)).toEqual([...RED])
    const both = flipFloatingPatch(patch, { horizontal: true, vertical: true })
    expect(colorAt(both.patch, 0, 0)).toEqual([...SEMI])
    expect(colorAt(both.patch, 1, 1)).toEqual([...RED])
    // Double flip round-trips exactly, alpha included.
    const roundTripped = flipFloatingPatch(both.patch, { horizontal: true, vertical: true })
    expect(roundTripped.patch.data).toEqual(patch.data)
    // Flagless flip is a no-op returning the input reference.
    expect(flipFloatingPatch(patch).patch).toBe(patch)
  })

  it('rotates by quarter turns with exact pixel permutation', () => {
    const patch = twoByTwo()
    const cw = rotateFloatingPatch90(patch, 90)
    expect(cw.changed).toBe(true)
    expect(cw.patch.width).toBe(2)
    expect(cw.patch.height).toBe(2)
    // (0,0)=R (1,0)=G / (0,1)=B (1,1)=S  ->  CW  ->  (0,0)=B (1,0)=R / (0,1)=S (1,1)=G
    expect(colorAt(cw.patch, 0, 0)).toEqual([...BLUE])
    expect(colorAt(cw.patch, 1, 0)).toEqual([...RED])
    expect(colorAt(cw.patch, 0, 1)).toEqual([...SEMI])
    expect(colorAt(cw.patch, 1, 1)).toEqual([...GREEN])
    const half = rotateFloatingPatch90(patch, 180)
    expect(colorAt(half.patch, 0, 0)).toEqual([...SEMI])
    expect(colorAt(half.patch, 1, 1)).toEqual([...RED])
    const ccw = rotateFloatingPatch90(patch, -90)
    expect(colorAt(ccw.patch, 0, 0)).toEqual([...GREEN])
    expect(colorAt(ccw.patch, 0, 1)).toEqual([...RED])
    // Four quarter turns round-trip byte-exact.
    let roundTripped = patch
    for (let i = 0; i < 4; i += 1) roundTripped = rotateFloatingPatch90(roundTripped, 90).patch
    expect(roundTripped.data).toEqual(patch.data)
    // 0/360 degrees is a no-op returning the input reference.
    expect(rotateFloatingPatch90(patch, 0).patch).toBe(patch)
    expect(rotateFloatingPatch90(patch, 360).patch).toBe(patch)
  })

  it('rotates by arbitrary angles into a tight box with transparent background', () => {
    const patch = makeImage(3, 1, TRANSPARENT)
    paint(patch, 1, 0, RED)
    const turned = rotateFloatingPatch(patch, 180)
    // Exact multiple of 90 delegates to the pixel-exact path.
    expect(turned.patch.width).toBe(3)
    expect(turned.patch.height).toBe(1)
    expect(colorAt(turned.patch, 1, 0)).toEqual([...RED])
    const diagonal = rotateFloatingPatch(makeImage(2, 2, RED), 45)
    expect(diagonal.changed).toBe(true)
    expect(diagonal.patch.width).toBeGreaterThan(2)
    // Corners outside the rotated square stay transparent.
    expect(colorAt(diagonal.patch, 0, 0)[3]).toBe(0)
    // 0/360 is a no-op returning the input reference.
    const solid = makeImage(2, 2, RED)
    expect(rotateFloatingPatch(solid, 0).patch).toBe(solid)
    expect(rotateFloatingPatch(solid, 360).patch).toBe(solid)
  })

  it('composes a scale+rotate+move chain without touching the source', () => {
    const image = makeImage(10, 10, WHITE)
    paint(image, 1, 1, RED)
    paint(image, 2, 1, GREEN)
    paint(image, 1, 2, BLUE)
    paint(image, 2, 2, SEMI)
    const snapshot = new Uint8ClampedArray(image.data)

    const extracted = extractFloatingPatch(image, { x: 1, y: 1, width: 2, height: 2 })!
    const scaled = scaleFloatingPatch(extracted.patch, 2, 2)
    expect(scaled.patch.width).toBe(4)
    const rotated = rotateFloatingPatch90(scaled.patch, 90)
    const base = clearFloatingRectForMove(image, extracted.rect).image
    const stamped = compositeFloatingPatch(base, rotated.patch, 5, 5)
    expect(stamped.changed).toBe(true)
    expect(stamped.placedRect).toEqual({ x: 5, y: 5, width: 4, height: 4 })
    // Scaled 2x block corners after a clockwise turn:
    // top row [B B R R], bottom rows [S S G G] (CW of [[R R G G] x2 / [B B S S] x2]).
    // Opaque corners replace the white base; the semi-transparent corner
    // blends source-over it ((10,20,30,128) over white = [132,137,142,255],
    // byte-exact with Canvas `drawImage`).
    expect(colorAt(stamped.image, 5, 5)).toEqual([...BLUE])
    expect(colorAt(stamped.image, 8, 5)).toEqual([...RED])
    expect(colorAt(stamped.image, 5, 8)).toEqual([132, 137, 142, 255])
    expect(colorAt(stamped.image, 8, 8)).toEqual([...GREEN])
    expect(colorAt(stamped.image, 1, 1)).toEqual([...TRANSPARENT])
    expect(colorAt(stamped.image, 0, 0)).toEqual([...WHITE])
    expect(image.data).toEqual(snapshot)
  })
})
