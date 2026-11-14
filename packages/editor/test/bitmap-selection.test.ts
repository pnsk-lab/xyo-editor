import { describe, expect, it } from 'bun:test'
import { trimBitmapRectToOpaque } from '../src/features/costumes/bitmap-selection'

function imageWithOpaque(width: number, height: number, opaque: Array<[number, number]>) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y] of opaque) {
    data[(y * width + x) * 4 + 3] = 255
  }
  return { data, width, height }
}

function imageWithAlpha(width: number, height: number, pixels: Array<[number, number, number]>) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y, a] of pixels) {
    data[(y * width + x) * 4 + 3] = a
  }
  return { data, width, height }
}

describe('trimBitmapRectToOpaque', () => {
  it('trims transparent margins like scratch-paint getHitBounds', () => {
    const image = imageWithOpaque(8, 6, [
      [3, 2],
      [4, 2],
      [3, 3],
    ])
    expect(trimBitmapRectToOpaque(image, { x: 0, y: 0, width: 8, height: 6 })).toEqual({
      x: 3,
      y: 2,
      width: 2,
      height: 2,
    })
  })

  it('keeps fully opaque rectangles unchanged', () => {
    const opaque: Array<[number, number]> = []
    for (let y = 1; y < 4; y += 1) for (let x = 2; x < 6; x += 1) opaque.push([x, y])
    const image = imageWithOpaque(8, 6, opaque)
    expect(trimBitmapRectToOpaque(image, { x: 2, y: 1, width: 4, height: 3 })).toEqual({
      x: 2,
      y: 1,
      width: 4,
      height: 3,
    })
  })

  it('returns undefined when the rectangle holds no opaque pixels', () => {
    const image = imageWithOpaque(8, 6, [[0, 0]])
    expect(trimBitmapRectToOpaque(image, { x: 2, y: 1, width: 4, height: 3 })).toBeUndefined()
  })

  it('clamps rectangles that extend past the canvas', () => {
    const image = imageWithOpaque(8, 6, [[7, 5]])
    expect(trimBitmapRectToOpaque(image, { x: 5, y: 4, width: 10, height: 10 })).toEqual({
      x: 7,
      y: 5,
      width: 1,
      height: 1,
    })
  })

  // S-4 adversarial cross-oracle coverage. Expectations below were derived by
  // reading the reference trim/callers (round both corners + clamp, scan
  // `alpha !== 0`, reverse normalized, empty => no selection) without copying
  // their source; the helper must match that observable behavior.
  it('counts alpha 1 as opaque and alpha 0 as transparent', () => {
    const one = imageWithAlpha(8, 6, [[3, 2, 1]])
    expect(trimBitmapRectToOpaque(one, { x: 0, y: 0, width: 8, height: 6 })).toEqual({
      x: 3,
      y: 2,
      width: 1,
      height: 1,
    })
    const zero = imageWithAlpha(8, 6, [[3, 2, 0]])
    expect(trimBitmapRectToOpaque(zero, { x: 0, y: 0, width: 8, height: 6 })).toBeUndefined()
  })

  it('counts semi-transparent pixels as opaque', () => {
    const semi = imageWithAlpha(8, 6, [[3, 2, 128]])
    expect(trimBitmapRectToOpaque(semi, { x: 0, y: 0, width: 8, height: 6 })).toEqual({
      x: 3,
      y: 2,
      width: 1,
      height: 1,
    })
  })

  it('rounds fractional corners like the reference caller (not outward)', () => {
    // Opaque pixel at x=10 is outside round(10.6)..round(20.4) => no selection.
    const image = imageWithOpaque(32, 32, [[10, 12]])
    expect(trimBitmapRectToOpaque(image, { x: 10.6, y: 10, width: 9.8, height: 5 })).toBeUndefined()
    // Same pixel is inside round(10.2)..round(20.7) => selected.
    expect(trimBitmapRectToOpaque(image, { x: 10.2, y: 10, width: 10.5, height: 5 })).toEqual({
      x: 10,
      y: 12,
      width: 1,
      height: 1,
    })
  })

  it('treats a half-pixel drag as empty (round collapses it)', () => {
    const image = imageWithOpaque(8, 6, [[0, 0]])
    expect(trimBitmapRectToOpaque(image, { x: 0.5, y: 0.5, width: 1, height: 1 })).toBeUndefined()
  })

  it('treats a sub-half-pixel drag as empty', () => {
    const image = imageWithOpaque(32, 32, [[10, 10]])
    expect(trimBitmapRectToOpaque(image, { x: 10, y: 10, width: 0.4, height: 0.4 })).toBeUndefined()
  })

  it('normalizes reverse drags like Paper from/to', () => {
    const image = imageWithOpaque(8, 6, [[2, 2]])
    expect(trimBitmapRectToOpaque(image, { x: 5, y: 5, width: -4, height: -4 })).toEqual({
      x: 2,
      y: 2,
      width: 1,
      height: 1,
    })
  })

  it('keeps single-pixel inclusive boundaries at the corners', () => {
    expect(trimBitmapRectToOpaque(imageWithOpaque(8, 6, [[0, 0]]), { x: 0, y: 0, width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
    expect(trimBitmapRectToOpaque(imageWithOpaque(8, 6, [[7, 5]]), { x: 7, y: 5, width: 1, height: 1 })).toEqual({
      x: 7,
      y: 5,
      width: 1,
      height: 1,
    })
  })

  it('returns undefined for fully offscreen rectangles (negative and beyond)', () => {
    const image = imageWithOpaque(8, 6, [[0, 0]])
    expect(trimBitmapRectToOpaque(image, { x: -10, y: -10, width: 5, height: 5 })).toBeUndefined()
    const far = imageWithOpaque(8, 6, [[7, 5]])
    expect(trimBitmapRectToOpaque(far, { x: 20, y: 20, width: 5, height: 5 })).toBeUndefined()
  })

  it('handles res1 and res2 canvas sizes', () => {
    expect(
      trimBitmapRectToOpaque(imageWithOpaque(480, 360, [[100, 100]]), { x: 90, y: 90, width: 20, height: 20 }),
    ).toEqual({ x: 100, y: 100, width: 1, height: 1 })
    expect(
      trimBitmapRectToOpaque(imageWithOpaque(960, 720, [[200, 200]]), { x: 190, y: 190, width: 20, height: 20 }),
    ).toEqual({ x: 200, y: 200, width: 1, height: 1 })
  })

  it('is a pure no-op for empty regions (no pixels touched, undefined for history skip)', () => {
    const image = imageWithOpaque(8, 6, [[0, 0]])
    const before = new Uint8ClampedArray(image.data)
    expect(trimBitmapRectToOpaque(image, { x: 2, y: 1, width: 4, height: 3 })).toBeUndefined()
    expect(image.data).toEqual(before)
  })

  it('never mutates the input image (nearest-neighbor/exact, no resampling)', () => {
    const image = imageWithAlpha(8, 6, [
      [3, 2, 128],
      [4, 2, 1],
    ])
    const before = new Uint8ClampedArray(image.data)
    const trimmed = trimBitmapRectToOpaque(image, { x: 0, y: 0, width: 8, height: 6 })
    expect(trimmed).toEqual({ x: 3, y: 2, width: 2, height: 1 })
    expect(image.data).toEqual(before)
  })

  it('fails safe on non-finite rects', () => {
    const image = imageWithOpaque(8, 6, [[0, 0]])
    expect(trimBitmapRectToOpaque(image, { x: NaN, y: 0, width: 4, height: 3 })).toBeUndefined()
    expect(trimBitmapRectToOpaque(image, { x: 0, y: 0, width: Infinity, height: 3 })).toBeUndefined()
  })

  it('fails safe on unusable images (bad dimensions/buffer, taint/size-cap stand-in)', () => {
    const good = imageWithOpaque(8, 6, [[0, 0]])
    expect(trimBitmapRectToOpaque(good, { x: 0, y: 0, width: 8, height: 6 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
    const badLength = { data: new Uint8ClampedArray(10), width: 8, height: 6 }
    expect(trimBitmapRectToOpaque(badLength, { x: 0, y: 0, width: 8, height: 6 })).toBeUndefined()
    const zeroSize = { data: new Uint8ClampedArray(0), width: 0, height: 0 }
    expect(trimBitmapRectToOpaque(zeroSize, { x: 0, y: 0, width: 1, height: 1 })).toBeUndefined()
  })
})
