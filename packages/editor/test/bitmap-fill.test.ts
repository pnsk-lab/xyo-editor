import { describe, expect, it } from 'bun:test'
import {
  bitmapColorsEqual,
  floodFillAllBitmap,
  floodFillAllMaskBitmap,
  floodFillBitmap,
  floodFillMaskBitmap,
  getBitmapPixel,
  type BitmapFillImage,
  type BitmapFillRGBA,
} from '../src/features/costumes/bitmap-fill'

const WHITE: BitmapFillRGBA = [255, 255, 255, 255]
const BLACK: BitmapFillRGBA = [0, 0, 0, 255]
const RED: BitmapFillRGBA = [255, 0, 0, 255]
const BLUE: BitmapFillRGBA = [0, 0, 255, 255]
const TRANSPARENT: BitmapFillRGBA = [0, 0, 0, 0]

function paint(image: BitmapFillImage, x: number, y: number, color: BitmapFillRGBA) {
  const index = (y * image.width + x) * 4
  image.data[index] = color[0]
  image.data[index + 1] = color[1]
  image.data[index + 2] = color[2]
  image.data[index + 3] = color[3]
}

function makeImage(width: number, height: number, base: BitmapFillRGBA): BitmapFillImage {
  const data = new Uint8ClampedArray(width * height * 4)
  const image = { width, height, data }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) paint(image, x, y, base)
  return image
}

function colorAt(image: BitmapFillImage, x: number, y: number): BitmapFillRGBA {
  return getBitmapPixel(image, x, y)!
}

/** 5x5 with a 1px black border, white interior. */
function borderedImage(): BitmapFillImage {
  const image = makeImage(5, 5, WHITE)
  for (let i = 0; i < 5; i += 1) {
    paint(image, i, 0, BLACK)
    paint(image, i, 4, BLACK)
    paint(image, 0, i, BLACK)
    paint(image, 4, i, BLACK)
  }
  return image
}

describe('bitmap fill (scratch-paint parity)', () => {
  it('flood-fills the connected interior but stops at the strict-RGBA border', () => {
    const before = borderedImage()
    const snapshot = new Uint8ClampedArray(before.data)
    const result = floodFillBitmap(before, 2, 2, RED)

    expect(result.changed).toBe(true)
    expect(result.filledCount).toBe(9)
    // Interior 3x3 repainted.
    for (let y = 1; y <= 3; y += 1) for (let x = 1; x <= 3; x += 1) expect(colorAt(result.image, x, y)).toEqual([...RED])
    // Border untouched (strict RGBA barrier, like scratch-paint matchesColor_).
    for (let i = 0; i < 5; i += 1) {
      expect(colorAt(result.image, i, 0)).toEqual([...BLACK])
      expect(colorAt(result.image, i, 4)).toEqual([...BLACK])
    }
    // Pure: input not mutated.
    expect(before.data).toEqual(snapshot)
  })

  it('treats near-identical colors as different (no tolerance)', () => {
    const image = makeImage(3, 1, [255, 255, 255, 255])
    paint(image, 1, 0, [254, 255, 255, 255])
    const result = floodFillBitmap(image, 0, 0, RED)
    expect(result.changed).toBe(true)
    expect(result.filledCount).toBe(1)
    expect(colorAt(result.image, 0, 0)).toEqual([...RED])
    expect(colorAt(result.image, 1, 0)).toEqual([254, 255, 255, 255])
    expect(colorAt(result.image, 2, 0)).toEqual([255, 255, 255, 255])
  })

  it('treats alpha as part of the match', () => {
    const image = makeImage(2, 1, TRANSPARENT)
    paint(image, 1, 0, [0, 0, 0, 255])
    const result = floodFillBitmap(image, 0, 0, BLUE)
    expect(result.filledCount).toBe(1)
    expect(colorAt(result.image, 0, 0)).toEqual([...BLUE])
    expect(colorAt(result.image, 1, 0)).toEqual([0, 0, 0, 255])
  })

  it('is a no-op when the seed already has the new color', () => {
    const image = makeImage(2, 2, RED)
    const result = floodFillBitmap(image, 0, 0, RED)
    expect(result.changed).toBe(false)
    expect(result.filledCount).toBe(0)
    expect(result.image).toBe(image)
  })

  it('is a no-op for out-of-bounds seeds', () => {
    const image = makeImage(2, 2, WHITE)
    for (const [x, y] of [[-1, 0], [0, -1], [2, 0], [0, 2]] as const) {
      const result = floodFillBitmap(image, x, y, RED)
      expect(result.changed).toBe(false)
      expect(result.filledCount).toBe(0)
    }
    expect(image.data).toEqual(makeImage(2, 2, WHITE).data)
  })

  it('floodFillAll replaces every exact match (shift-click parity)', () => {
    const image = makeImage(4, 2, WHITE)
    paint(image, 1, 0, BLACK)
    paint(image, 3, 1, BLACK)
    const result = floodFillAllBitmap(image, 0, 0, BLUE)
    expect(result.changed).toBe(true)
    expect(result.filledCount).toBe(6)
    expect(colorAt(result.image, 1, 0)).toEqual([...BLACK])
    expect(colorAt(result.image, 3, 1)).toEqual([...BLACK])
    expect(colorAt(result.image, 2, 0)).toEqual([...BLUE])
    expect(colorAt(result.image, 0, 1)).toEqual([...BLUE])
  })

  it('floodFillAll crosses walls that stop connected fill', () => {
    const connected = floodFillBitmap(borderedImage(), 2, 2, RED)
    const global = floodFillAllBitmap(borderedImage(), 2, 2, RED)
    expect(connected.filledCount).toBe(9)
    expect(global.filledCount).toBe(9)
    // Split the interior with a black wall: left and right white chambers are
    // disconnected, so connected fill paints one side while shift-click paints both.
    const split = borderedImage()
    paint(split, 2, 1, BLACK)
    paint(split, 2, 2, BLACK)
    paint(split, 2, 3, BLACK)
    const oneSide = floodFillBitmap(split, 1, 1, RED)
    const bothSides = floodFillAllBitmap(split, 1, 1, RED)
    expect(oneSide.filledCount).toBe(3)
    expect(bothSides.filledCount).toBe(6)
    expect(colorAt(bothSides.image, 3, 2)).toEqual([...RED])
    expect(colorAt(oneSide.image, 3, 2)).toEqual([...WHITE])
  })

  it('does not leak through diagonals (4-way connectivity)', () => {
    // (0,0) touches (1,1) only at a corner; orthogonal neighbours are black.
    const image = makeImage(2, 2, WHITE)
    paint(image, 1, 0, BLACK)
    paint(image, 0, 1, BLACK)
    const result = floodFillBitmap(image, 0, 0, RED)
    expect(result.changed).toBe(true)
    expect(result.filledCount).toBe(1)
    expect(colorAt(result.image, 0, 0)).toEqual([...RED])
    // Diagonal white pixel is disconnected, so it must stay white.
    expect(colorAt(result.image, 1, 1)).toEqual([...WHITE])
  })

  it('writes the fill color alpha verbatim (never forces opaque)', () => {
    const image = makeImage(2, 1, WHITE)
    const semi: BitmapFillRGBA = [255, 0, 0, 128]
    const result = floodFillBitmap(image, 0, 0, semi)
    expect(result.changed).toBe(true)
    expect(result.filledCount).toBe(2)
    expect(colorAt(result.image, 0, 0)).toEqual([255, 0, 0, 128])
    expect(colorAt(result.image, 1, 0)).toEqual([255, 0, 0, 128])
    // The global (shift-click) path must preserve alpha too.
    const global = floodFillAllBitmap(makeImage(2, 1, WHITE), 0, 0, semi)
    expect(colorAt(global.image, 1, 0)).toEqual([255, 0, 0, 128])
  })

  it('normalizes fractional/out-of-range fill colors like canvas fillStyle', () => {
    const image = makeImage(1, 1, WHITE)
    const result = floodFillBitmap(image, 0, 0, [255, 0.4, 0, 300])
    expect(result.changed).toBe(true)
    expect(colorAt(result.image, 0, 0)).toEqual([255, 0, 0, 255])
    // A color that normalizes to the seed color is a no-op.
    const already = makeImage(1, 1, RED)
    expect(floodFillBitmap(already, 0, 0, [255, 0, 0, 300]).changed).toBe(false)
    expect(floodFillAllBitmap(already, 0, 0, [255, 0, 0, 300]).changed).toBe(false)
  })

  it('floodFillAll is pure and no-ops like connected fill', () => {
    const image = makeImage(2, 2, RED)
    const same = floodFillAllBitmap(image, 0, 0, RED)
    expect(same.changed).toBe(false)
    expect(same.filledCount).toBe(0)
    expect(same.image).toBe(image)

    const white = makeImage(2, 2, WHITE)
    const snapshot = new Uint8ClampedArray(white.data)
    const oob = floodFillAllBitmap(white, 9, 9, BLUE)
    expect(oob.changed).toBe(false)
    expect(oob.filledCount).toBe(0)
    const painted = floodFillAllBitmap(white, 0, 0, BLUE)
    expect(painted.changed).toBe(true)
    expect(painted.filledCount).toBe(4)
    // Pure: input not mutated.
    expect(white.data).toEqual(snapshot)
  })

  it('floodFillAll treats near-identical colors as different (no tolerance)', () => {
    const image = makeImage(3, 1, [255, 255, 255, 255])
    paint(image, 1, 0, [254, 255, 255, 255])
    const result = floodFillAllBitmap(image, 0, 0, BLUE)
    expect(result.changed).toBe(true)
    expect(result.filledCount).toBe(2)
    expect(colorAt(result.image, 0, 0)).toEqual([...BLUE])
    expect(colorAt(result.image, 1, 0)).toEqual([254, 255, 255, 255])
    expect(colorAt(result.image, 2, 0)).toEqual([...BLUE])
  })

  it('fills large solid areas exactly (linear-time smoke test)', () => {
    const size = 256
    const white = makeImage(size, size, WHITE)
    const snapshot = new Uint8ClampedArray(white.data)
    const connected = floodFillBitmap(white, 0, 0, RED)
    expect(connected.changed).toBe(true)
    expect(connected.filledCount).toBe(size * size)
    expect(colorAt(connected.image, 0, 0)).toEqual([...RED])
    expect(colorAt(connected.image, size - 1, size - 1)).toEqual([...RED])
    expect(white.data).toEqual(snapshot)

    const global = floodFillAllBitmap(makeImage(size, size, WHITE), size - 1, 0, BLUE)
    expect(global.filledCount).toBe(size * size)
    expect(colorAt(global.image, 0, size - 1)).toEqual([...BLUE])
  })

  it('exposes strict RGBA helpers', () => {
    expect(bitmapColorsEqual([1, 2, 3, 4], [1, 2, 3, 4])).toBe(true)
    expect(bitmapColorsEqual([1, 2, 3, 4], [1, 2, 3, 5])).toBe(false)
    const image = makeImage(1, 1, WHITE)
    expect(getBitmapPixel(image, 5, 5)).toBeUndefined()
  })
})

describe('bitmap fill masks (gradient compositing)', () => {
  function maskSet(mask: Uint8Array, width: number, x: number, y: number): boolean {
    return mask[y * width + x] === 1
  }

  it('derives the connected mask with tight bounds for the interior', () => {
    const before = borderedImage()
    const snapshot = new Uint8ClampedArray(before.data)
    const mask = floodFillMaskBitmap(before, 2, 2)

    expect(mask.changed).toBe(true)
    expect(mask.filledCount).toBe(9)
    expect(mask.width).toBe(5)
    expect(mask.height).toBe(5)
    expect(mask.seedColor).toEqual([255, 255, 255, 255])
    expect(mask.bounds).toEqual({ x: 1, y: 1, width: 3, height: 3 })
    for (let y = 1; y <= 3; y += 1) for (let x = 1; x <= 3; x += 1) expect(maskSet(mask.mask, 5, x, y)).toBe(true)
    expect(maskSet(mask.mask, 5, 0, 0)).toBe(false)
    expect(maskSet(mask.mask, 5, 4, 2)).toBe(false)
    // Pure: input not mutated.
    expect(before.data).toEqual(snapshot)
  })

  it('matches the solid fill pixel-for-pixel (sentinel replay parity)', () => {
    const image = borderedImage()
    paint(image, 2, 1, BLACK)
    paint(image, 2, 2, BLACK)
    paint(image, 2, 3, BLACK)
    const mask = floodFillMaskBitmap(image, 1, 1)
    const solid = floodFillBitmap(image, 1, 1, RED)
    expect(mask.changed).toBe(true)
    expect(mask.filledCount).toBe(solid.filledCount)
    expect(mask.filledCount).toBe(3)
    expect(mask.bounds).toEqual({ x: 1, y: 1, width: 1, height: 3 })
    // Every masked pixel is repainted by the solid fill and vice versa.
    let repainted = 0
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const index = (y * image.width + x) * 4
        const changed =
          solid.image.data[index] !== image.data[index] ||
          solid.image.data[index + 1] !== image.data[index + 1] ||
          solid.image.data[index + 2] !== image.data[index + 2] ||
          solid.image.data[index + 3] !== image.data[index + 3]
        expect(maskSet(mask.mask, image.width, x, y)).toBe(changed)
        if (changed) repainted += 1
      }
    }
    expect(repainted).toBe(mask.filledCount)
  })

  it('keeps the strict match rule: tolerance, alpha, and 4-way connectivity', () => {
    const near = makeImage(3, 1, [255, 255, 255, 255])
    paint(near, 1, 0, [254, 255, 255, 255])
    expect(floodFillMaskBitmap(near, 0, 0).filledCount).toBe(1)

    const alpha = makeImage(2, 1, TRANSPARENT)
    paint(alpha, 1, 0, [0, 0, 0, 255])
    const alphaMask = floodFillMaskBitmap(alpha, 0, 0)
    expect(alphaMask.filledCount).toBe(1)
    expect(alphaMask.seedColor).toEqual([0, 0, 0, 0])

    const diagonal = makeImage(2, 2, WHITE)
    paint(diagonal, 1, 0, BLACK)
    paint(diagonal, 0, 1, BLACK)
    const diagonalMask = floodFillMaskBitmap(diagonal, 0, 0)
    expect(diagonalMask.filledCount).toBe(1)
    expect(diagonalMask.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('derives the global mask (shift-click parity) across walls', () => {
    const split = borderedImage()
    paint(split, 2, 1, BLACK)
    paint(split, 2, 2, BLACK)
    paint(split, 2, 3, BLACK)
    const oneSide = floodFillMaskBitmap(split, 1, 1)
    const bothSides = floodFillAllMaskBitmap(split, 1, 1)
    const solidBoth = floodFillAllBitmap(split, 1, 1, BLUE)
    expect(oneSide.filledCount).toBe(3)
    expect(bothSides.filledCount).toBe(6)
    expect(bothSides.filledCount).toBe(solidBoth.filledCount)
    expect(bothSides.bounds).toEqual({ x: 1, y: 1, width: 3, height: 3 })
    expect(maskSet(bothSides.mask, 5, 3, 2)).toBe(true)
    expect(maskSet(oneSide.mask, 5, 3, 2)).toBe(false)
  })

  it('is a no-op for out-of-bounds seeds and unusable images', () => {
    const image = makeImage(2, 2, WHITE)
    for (const [x, y] of [[-1, 0], [0, -1], [2, 0], [0, 2]] as const) {
      for (const mask of [floodFillMaskBitmap(image, x, y), floodFillAllMaskBitmap(image, x, y)]) {
        expect(mask.changed).toBe(false)
        expect(mask.filledCount).toBe(0)
        expect(mask.bounds).toBeUndefined()
        expect(mask.seedColor).toBeUndefined()
      }
    }
    expect(image.data).toEqual(makeImage(2, 2, WHITE).data)

    const broken = { width: 2, height: 2, data: new Uint8ClampedArray(3) }
    expect(floodFillMaskBitmap(broken, 0, 0).changed).toBe(false)
    expect(floodFillAllMaskBitmap(broken, 0, 0).changed).toBe(false)
    expect(floodFillMaskBitmap(broken, 0, 0).mask.length).toBe(0)
  })
})
