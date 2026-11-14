import { describe, expect, it } from 'bun:test'
import {
  rotateFloatingPatch,
  rotateFloatingPatchWithHalo,
  type BitmapFloatingImage,
  type BitmapFloatingHalo,
} from '../src/features/costumes/bitmap-floating'
import {
  beginBitmapFloatingSession,
  renderBitmapFloatingSession,
  rotateBitmapFloatingSessionArbitraryWithHalo,
} from '../src/features/costumes/bitmap-floating-session'

type RGBA = [number, number, number, number]
const RED: RGBA = [255, 0, 0, 255]
const GREEN: RGBA = [0, 255, 0, 255]
const BLUE: RGBA = [0, 0, 255, 255]
const WHITE: RGBA = [255, 255, 255, 255]
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

describe('halo-aware arbitrary rotation (safe: halo masked, patch-only sampling)', () => {
  it('matches patch-only sampling without a halo', () => {
    const patch = makeImage(10, 10, TRANSPARENT)
    for (let y = 2; y < 8; y += 1) for (let x = 2; x < 8; x += 1) paint(patch, x, y, RED)
    paint(patch, 4, 4, GREEN)
    for (const deg of [15, 45, 30, 120]) {
      const plain = rotateFloatingPatch(patch, deg)
      const haloed = rotateFloatingPatchWithHalo(patch, undefined, deg)
      expect(haloed.changed).toBe(plain.changed)
      expect(haloed.patch.width).toBe(plain.patch.width)
      expect(haloed.patch.height).toBe(plain.patch.height)
      expect(haloed.patch.data).toEqual(plain.patch.data)
    }
  })

  it('falls back to patch-only sampling for unusable halos', () => {
    const patch = makeImage(6, 6, RED)
    const plain = rotateFloatingPatch(patch, 15)
    const badHalos: Array<BitmapFloatingHalo | undefined> = [
      undefined,
      { image: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, offsetX: 0, offsetY: 0 },
      { image: makeImage(6, 6, BLUE), offsetX: Number.NaN, offsetY: 0 },
      // Patch does not fit inside the halo (offset pushes it outside).
      { image: makeImage(6, 6, BLUE), offsetX: 1, offsetY: 0 },
      { image: makeImage(6, 6, BLUE), offsetX: -1, offsetY: 0 },
    ]
    for (const halo of badHalos) {
      const result = rotateFloatingPatchWithHalo(patch, halo, 15)
      expect(result.changed).toBe(true)
      expect(result.patch.data).toEqual(plain.patch.data)
    }
  })

  it('keeps quarter turns pixel-exact even with a halo', () => {
    const patch = makeImage(2, 2, TRANSPARENT)
    paint(patch, 0, 0, RED)
    paint(patch, 1, 0, GREEN)
    paint(patch, 0, 1, BLUE)
    paint(patch, 1, 1, WHITE)
    const haloImage = makeImage(6, 6, GREEN)
    for (let y = 2; y < 4; y += 1) for (let x = 2; x < 4; x += 1) paint(haloImage, x, y, RED)
    const halo: BitmapFloatingHalo = { image: haloImage, offsetX: 2, offsetY: 2 }
    const turned = rotateFloatingPatchWithHalo(patch, halo, 90)
    expect(turned.changed).toBe(true)
    expect(colorAt(turned.patch, 0, 0)).toEqual([...BLUE])
    expect(colorAt(turned.patch, 1, 0)).toEqual([...RED])
    // No-op contract is preserved.
    expect(rotateFloatingPatchWithHalo(patch, halo, 0).patch).toBe(patch)
    expect(rotateFloatingPatchWithHalo(patch, halo, 360).patch).toBe(patch)
    expect(rotateFloatingPatchWithHalo(patch, halo, Number.NaN).patch).toBe(patch)
  })

  it('ignores opaque neighbours outside the selection (safe halo: transparent outside)', () => {
    // Trimmed-style patch: opaque to the boundary (no margin).
    const patch = makeImage(6, 6, RED)
    // Halo: same 6x6 centered in a 10x10 blue field (2px opaque neighbours).
    // Safe rule: halo texels outside the selection rect are treated as
    // alpha=0, so only selection-interior pixels are used. The result must be
    // byte-identical to patch-only rotation with no blue leakage.
    const haloImage = makeImage(10, 10, BLUE)
    for (let y = 0; y < 6; y += 1) for (let x = 0; x < 6; x += 1) paint(haloImage, x + 2, y + 2, RED)
    const halo: BitmapFloatingHalo = { image: haloImage, offsetX: 2, offsetY: 2 }
    const plain = rotateFloatingPatch(patch, 15)
    const haloed = rotateFloatingPatchWithHalo(patch, halo, 15)
    expect(haloed.changed).toBe(true)
    expect([haloed.patch.width, haloed.patch.height]).toEqual([plain.patch.width, plain.patch.height])
    expect(haloed.patch.data).toEqual(plain.patch.data)
    // No outside blue may leak in: every output pixel is either red or transparent.
    let blue = 0
    for (let i = 0; i < haloed.patch.data.length; i += 4) {
      if (haloed.patch.data[i] === 0 && haloed.patch.data[i + 1] === 0 && haloed.patch.data[i + 2] === 255 && haloed.patch.data[i + 3] === 255) blue += 1
    }
    expect(blue).toBe(0)
    // Transparent-margin halo stays identical to patch-only sampling.
    const clearHaloImage = makeImage(10, 10, TRANSPARENT)
    for (let y = 0; y < 6; y += 1) for (let x = 0; x < 6; x += 1) paint(clearHaloImage, x + 2, y + 2, RED)
    const clearHalo: BitmapFloatingHalo = { image: clearHaloImage, offsetX: 2, offsetY: 2 }
    expect(rotateFloatingPatchWithHalo(patch, clearHalo, 15).patch.data).toEqual(plain.patch.data)
  })

  it('keeps every sampled pixel verbatim RGBA (no blending)', () => {
    const patch = makeImage(4, 4, TRANSPARENT)
    paint(patch, 1, 1, [10, 20, 30, 128])
    paint(patch, 2, 2, RED)
    const haloImage = makeImage(8, 8, TRANSPARENT)
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) {
      const index = (y * 4 + x) * 4
      const haloIndex = ((y + 2) * 8 + (x + 2)) * 4
      haloImage.data[haloIndex] = patch.data[index]!
      haloImage.data[haloIndex + 1] = patch.data[index + 1]!
      haloImage.data[haloIndex + 2] = patch.data[index + 2]!
      haloImage.data[haloIndex + 3] = patch.data[index + 3]!
    }
    const haloed = rotateFloatingPatchWithHalo(patch, { image: haloImage, offsetX: 2, offsetY: 2 }, 30)
    expect(haloed.changed).toBe(true)
    // Only verbatim source colors or transparent may appear (nearest neighbour, no blends).
    const allowed = new Set(['0,0,0,0', '10,20,30,128', '255,0,0,255'])
    for (let i = 0; i < haloed.patch.data.length; i += 4) {
      const key = `${haloed.patch.data[i]},${haloed.patch.data[i + 1]},${haloed.patch.data[i + 2]},${haloed.patch.data[i + 3]}`
      expect(allowed.has(key)).toBe(true)
    }
  })

  it('session halo rotation restarts from the frozen original and never mutates committed', () => {
    const canvas = makeImage(12, 12, WHITE)
    for (let y = 3; y < 9; y += 1) for (let x = 3; x < 9; x += 1) paint(canvas, x, y, RED)
    const session = beginBitmapFloatingSession(canvas, { x: 3, y: 3, width: 6, height: 6 })!
    const committedBefore = new Uint8ClampedArray(session.committed.data)
    const original = { width: session.patch.width, height: session.patch.height, data: new Uint8ClampedArray(session.patch.data) }
    const haloImage = makeImage(10, 10, BLUE)
    for (let y = 0; y < 6; y += 1) for (let x = 0; x < 6; x += 1) paint(haloImage, x + 2, y + 2, RED)
    const first = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, { image: haloImage, offsetX: 2, offsetY: 2 }, 15)
    expect(first.changed).toBe(true)
    const second = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, { image: haloImage, offsetX: 2, offsetY: 2 }, 45)
    expect(second.changed).toBe(true)
    // Restarting from the same original at 15deg reproduces the first preview (no accumulation).
    const replay = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, { image: haloImage, offsetX: 2, offsetY: 2 }, 15)
    expect(replay.patch.data).toEqual(first.patch.data)
    expect(session.committed.data).toEqual(committedBefore)
    // Near-zero resets to a copy of the original without history.
    const reset = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, { image: haloImage, offsetX: 2, offsetY: 2 }, 0)
    expect(reset.changed).toBe(false)
    expect(reset.patch.data).toEqual(original.data)
    expect(reset.patch.data).not.toBe(original.data)
  })

  it('clips negative/outside destinations source-over (rotate recenters may go negative)', () => {
    const canvas = makeImage(6, 6, WHITE)
    const session = beginBitmapFloatingSession(canvas, { x: 1, y: 1, width: 2, height: 2 })!
    // Destination partially negative: only the on-canvas part stamps.
    const clipped = renderBitmapFloatingSession(session, -1, -1)
    expect(clipped.changed).toBe(true)
    expect(clipped.placedRect).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    // Fully outside with copy stays a no-op on the committed reference.
    const outsideCopy = renderBitmapFloatingSession(session, 100, 100, { copy: true })
    expect(outsideCopy.changed).toBe(false)
    expect(outsideCopy.image).toBe(session.committed)
    // Fully outside plain move keeps the punched hole (matches previewFloatingMove).
    const outsideMove = renderBitmapFloatingSession(session, 100, 100)
    expect(outsideMove.changed).toBe(true)
    expect(outsideMove.placedRect).toBeUndefined()
  })
})
