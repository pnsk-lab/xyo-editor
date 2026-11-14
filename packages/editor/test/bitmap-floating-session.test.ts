import { describe, expect, it } from 'bun:test'
import {
  beginBitmapFloatingSession,
  bitmapFloatingDestRect,
  centeredBitmapFloatingDest,
  flipBitmapFloatingSession,
  isBitmapFloatingCornerHandle,
  isNoopBitmapFloatingMove,
  previewBitmapFloatingMove,
  renderBitmapFloatingSession,
  resolveBitmapFloatingScale,
  resolveBitmapFloatingScaleForHandle,
  rotateBitmapFloatingSession,
  scaleBitmapFloatingSession,
  type BitmapFloatingImage,
} from '../src/features/costumes/bitmap-floating-session'

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

describe('bitmap floating session: move / Alt-duplicate previews', () => {
  it('moves verbatim from the committed snapshot and never mutates it', () => {
    const image = makeImage(6, 4, WHITE)
    paint(image, 1, 1, RED)
    paint(image, 2, 1, GREEN)
    const snapshot = new Uint8ClampedArray(image.data)
    const session = beginBitmapFloatingSession(image, { x: 1, y: 1, width: 2, height: 1 })!
    expect(session).toBeDefined()
    expect(session.sourceRect).toEqual({ x: 1, y: 1, width: 2, height: 1 })
    expect(session.copy).toBe(false)

    const first = previewBitmapFloatingMove(session, 2, 1)
    expect(first.changed).toBe(true)
    expect(first.destX).toBe(3)
    expect(first.destY).toBe(2)
    expect(colorAt(first.image, 3, 2)).toEqual([...RED])
    expect(colorAt(first.image, 1, 1)).toEqual([...TRANSPARENT])

    // A second preview renders from the committed snapshot, not from the
    // first preview, so repeated moves cannot accumulate.
    const second = previewBitmapFloatingMove(session, 1, 0)
    expect(colorAt(second.image, 2, 1)).toEqual([...RED])
    expect(colorAt(second.image, 3, 2)).toEqual([...WHITE])
    expect(image.data).toEqual(snapshot)
    expect(session.committed.data).toEqual(snapshot)
  })

  it('keeps the source on Alt-duplicate and truncates fractional deltas', () => {
    const image = makeImage(6, 4, WHITE)
    paint(image, 1, 1, BLUE)
    const session = beginBitmapFloatingSession(image, { x: 1, y: 1, width: 1, height: 1 }, { copy: true })!
    expect(session.copy).toBe(true)
    const preview = previewBitmapFloatingMove(session, 2.9, 0.9)
    expect(preview.changed).toBe(true)
    expect(preview.destX).toBe(3)
    expect(preview.destY).toBe(1)
    expect(colorAt(preview.image, 1, 1)).toEqual([...BLUE])
    expect(colorAt(preview.image, 3, 1)).toEqual([...BLUE])
    expect(bitmapFloatingDestRect(session, 2.9, 0.9)).toEqual({ x: 3, y: 1, width: 1, height: 1 })
  })

  it('preserves transparent holes (source-over) and protects other pixels', () => {
    const image = makeImage(5, 1, GREEN)
    paint(image, 0, 0, RED)
    paint(image, 1, 0, TRANSPARENT)
    const session = beginBitmapFloatingSession(image, { x: 0, y: 0, width: 2, height: 1 })!
    const preview = previewBitmapFloatingMove(session, 3, 0)
    expect(preview.changed).toBe(true)
    expect(colorAt(preview.image, 3, 0)).toEqual([...RED])
    // The transparent patch pixel leaves the green destination untouched
    // instead of erasing it.
    expect(colorAt(preview.image, 4, 0)).toEqual([...GREEN])
    expect(colorAt(preview.image, 2, 0)).toEqual([...GREEN])
  })

  it('blends semi-transparent pixels source-over the destination', () => {
    const image = makeImage(2, 1, WHITE)
    paint(image, 0, 0, SEMI)
    const session = beginBitmapFloatingSession(image, { x: 0, y: 0, width: 1, height: 1 })!
    // Destination (1, 0) is white; stamping the semi pixel there blends.
    const preview = previewBitmapFloatingMove(session, 1, 0)
    expect(preview.changed).toBe(true)
    expect(colorAt(preview.image, 1, 0)).toEqual([132, 137, 142, 255])
    expect(colorAt(preview.image, 0, 0)).toEqual([...TRANSPARENT])
  })

  it('clips placements at canvas edges and reports the clipped rect', () => {
    const image = makeImage(4, 4, WHITE)
    paint(image, 0, 0, RED)
    paint(image, 1, 0, GREEN)
    const session = beginBitmapFloatingSession(image, { x: 0, y: 0, width: 2, height: 1 })!
    const preview = previewBitmapFloatingMove(session, 3, 0)
    expect(preview.changed).toBe(true)
    expect(preview.placedRect).toEqual({ x: 3, y: 0, width: 1, height: 1 })
    expect(colorAt(preview.image, 3, 0)).toEqual([...RED])
    expect(colorAt(preview.image, 0, 0)).toEqual([...TRANSPARENT])
  })

  it('treats zero deltas and offscreen Alt stamps as no-ops', () => {
    const image = makeImage(3, 3, WHITE)
    paint(image, 1, 1, RED)
    const session = beginBitmapFloatingSession(image, { x: 1, y: 1, width: 1, height: 1 })!
    const noop = previewBitmapFloatingMove(session, 0, 0)
    expect(noop.changed).toBe(false)
    expect(noop.image).toBe(session.committed)
    expect(isNoopBitmapFloatingMove(0, 0)).toBe(true)
    expect(isNoopBitmapFloatingMove(2, 0)).toBe(false)
    // Fully-offscreen Alt-duplicate changes nothing.
    const offscreen = renderBitmapFloatingSession(session, 99, 99, { copy: true })
    expect(offscreen.changed).toBe(false)
    expect(offscreen.image).toBe(session.committed)
    // Fully-offscreen plain move keeps the punched hole.
    const punched = renderBitmapFloatingSession(session, 99, 99, { copy: false })
    expect(punched.changed).toBe(true)
    expect(punched.placedRect).toBeUndefined()
    expect(colorAt(punched.image, 1, 1)).toEqual([...TRANSPARENT])
  })

  it('rejects unusable images and empty rects without throwing', () => {
    const image = makeImage(3, 3, WHITE)
    expect(beginBitmapFloatingSession(image, { x: 1, y: 1, width: 0, height: 1 })).toBeUndefined()
    expect(beginBitmapFloatingSession(image, { x: 99, y: 99, width: 2, height: 2 })).toBeUndefined()
    expect(
      beginBitmapFloatingSession({ width: 2, height: 2, data: new Uint8ClampedArray(3) }, { x: 0, y: 0, width: 1, height: 1 }),
    ).toBeUndefined()
  })
})

describe('bitmap floating session: scale / rotate / flip transforms', () => {
  function twoByTwo(): BitmapFloatingImage {
    const patch = makeImage(2, 2, TRANSPARENT)
    paint(patch, 0, 0, RED)
    paint(patch, 1, 0, GREEN)
    paint(patch, 0, 1, BLUE)
    paint(patch, 1, 1, SEMI)
    return patch
  }

  it('resolves SE handle scales from the original source size', () => {
    const image = makeImage(10, 10, WHITE)
    const session = beginBitmapFloatingSession(image, { x: 2, y: 3, width: 4, height: 2 })!
    // NW corner pinned at (2, 3): pointer at (10, 7) doubles both axes.
    expect(resolveBitmapFloatingScale(session, 10, 7)).toEqual({ scaleX: 2, scaleY: 2 })
    // Shift pins a uniform scale from the dominant axis.
    expect(resolveBitmapFloatingScale(session, 10, 5, { uniform: true })).toEqual({ scaleX: 2, scaleY: 2 })
    // Dragging past the anchor is a no-op (keep the last preview).
    expect(resolveBitmapFloatingScale(session, 2, 3)).toBeUndefined()
    expect(resolveBitmapFloatingScale(session, 0, 0)).toBeUndefined()
    expect(resolveBitmapFloatingScale(session, Number.NaN, 5)).toBeUndefined()
  })

  it('scales the patch 2x and stamps it at the pinned NW corner', () => {
    const patch = makeImage(2, 1, TRANSPARENT)
    paint(patch, 0, 0, RED)
    paint(patch, 1, 0, SEMI)
    const image = makeImage(8, 4, WHITE)
    const session = beginBitmapFloatingSession(image, { x: 1, y: 1, width: 2, height: 1 })!
    // Swap in the known patch to assert exact bytes (same size class).
    session.patch = { width: patch.width, height: patch.height, data: new Uint8ClampedArray(patch.data) }
    const scaled = scaleBitmapFloatingSession(session, 2, 2)
    expect(scaled.changed).toBe(true)
    expect(session.patch.width).toBe(4)
    expect(session.patch.height).toBe(2)
    const preview = renderBitmapFloatingSession(session, session.sourceRect.x, session.sourceRect.y)
    expect(preview.changed).toBe(true)
    expect(colorAt(preview.image, 1, 1)).toEqual([...RED])
    expect(colorAt(preview.image, 2, 1)).toEqual([...RED])
    // The semi-transparent patch pixels blend source-over the white base
    // (byte-exact Canvas `drawImage` result), they do not stamp verbatim.
    expect(colorAt(preview.image, 3, 1)).toEqual([132, 137, 142, 255])
    // No-op scales keep the same patch reference.
    const before = session.patch
    expect(scaleBitmapFloatingSession(session, 1, 1).changed).toBe(false)
    expect(session.patch).toBe(before)
  })

  it('rotates the patch by quarter turns and centers toolbar rotation', () => {
    const image = makeImage(10, 10, WHITE)
    const session = beginBitmapFloatingSession(image, { x: 1, y: 1, width: 2, height: 2 })!
    session.patch = twoByTwo()
    const rotated = rotateBitmapFloatingSession(session, 90)
    expect(rotated.changed).toBe(true)
    expect(session.patch.width).toBe(2)
    expect(colorAt(session.patch, 0, 0)).toEqual([...BLUE])
    expect(colorAt(session.patch, 1, 0)).toEqual([...RED])
    expect(rotateBitmapFloatingSession(session, 0).changed).toBe(false)
    // Non-square source rotates in place around its center.
    expect(centeredBitmapFloatingDest({ x: 1, y: 1, width: 4, height: 2 }, 2, 4)).toEqual({ x: 2, y: 0 })
  })

  it('flips the patch and round-trips exactly', () => {
    const image = makeImage(10, 10, WHITE)
    const session = beginBitmapFloatingSession(image, { x: 1, y: 1, width: 2, height: 2 })!
    const original = twoByTwo()
    session.patch = { width: 2, height: 2, data: new Uint8ClampedArray(original.data) }
    expect(flipBitmapFloatingSession(session, { horizontal: true }).changed).toBe(true)
    expect(colorAt(session.patch, 0, 0)).toEqual([...GREEN])
    expect(flipBitmapFloatingSession(session, { horizontal: true }).changed).toBe(true)
    expect(session.patch.data).toEqual(original.data)
    const before = session.patch
    expect(flipBitmapFloatingSession(session, {}).changed).toBe(false)
    expect(session.patch).toBe(before)
  })

  it('renders transformed patches source-over without touching the committed snapshot', () => {
    const image = makeImage(10, 10, WHITE)
    paint(image, 1, 1, RED)
    paint(image, 2, 1, GREEN)
    paint(image, 1, 2, BLUE)
    paint(image, 2, 2, SEMI)
    const snapshot = new Uint8ClampedArray(image.data)
    const session = beginBitmapFloatingSession(image, { x: 1, y: 1, width: 2, height: 2 })!
    scaleBitmapFloatingSession(session, 2, 2)
    rotateBitmapFloatingSession(session, 90)
    const preview = renderBitmapFloatingSession(session, 5, 5)
    expect(preview.changed).toBe(true)
    expect(preview.placedRect).toEqual({ x: 5, y: 5, width: 4, height: 4 })
    expect(colorAt(preview.image, 5, 5)).toEqual([...BLUE])
    expect(colorAt(preview.image, 1, 1)).toEqual([...TRANSPARENT])
    expect(colorAt(preview.image, 0, 0)).toEqual([...WHITE])
    expect(session.committed.data).toEqual(snapshot)
  })
})

describe('bitmap floating session: 8-handle scale', () => {
  function sessionAt2x3(): NonNullable<ReturnType<typeof beginBitmapFloatingSession>> {
    const image = makeImage(10, 10, WHITE)
    return beginBitmapFloatingSession(image, { x: 2, y: 3, width: 4, height: 2 })!
  }

  it('keeps corners uniform by default and frees them with Shift', () => {
    const session = sessionAt2x3()
    // Pointer (10, 5): free factors would be (2, 1); the corner default
    // unifies to the dominant axis.
    const uniform = resolveBitmapFloatingScaleForHandle(session, 'se', 10, 5)!
    expect(uniform).toMatchObject({ scaleX: 2, scaleY: 2, destX: 2, destY: 3, width: 8, height: 4 })
    expect(uniform.isUniform).toBe(true)
    expect(uniform.flippedX).toBe(false)
    const free = resolveBitmapFloatingScaleForHandle(session, 'se', 10, 5, { shiftKey: true })!
    expect(free).toMatchObject({ scaleX: 2, scaleY: 1, destX: 2, destY: 3, width: 8, height: 2 })
    expect(free.isUniform).toBe(false)
  })

  it('scales a single axis on edge handles regardless of Shift', () => {
    const session = sessionAt2x3()
    const east = resolveBitmapFloatingScaleForHandle(session, 'e', 10, 999)!
    expect(east).toMatchObject({ scaleX: 2, scaleY: 1, destX: 2, destY: 3, width: 8, height: 2 })
    expect(east.isUniform).toBe(false)
    const north = resolveBitmapFloatingScaleForHandle(session, 'n', 999, 1, { shiftKey: true })!
    expect(north).toMatchObject({ scaleX: 1, scaleY: 2, destX: 2, destY: 1, width: 4, height: 4 })
  })

  it('pins the diagonal fixed point per handle', () => {
    const session = sessionAt2x3()
    // NW drag to (0, 1) with default uniform: pivot stays at SE (6, 5).
    const nw = resolveBitmapFloatingScaleForHandle(session, 'nw', 0, 1)!
    expect(nw).toMatchObject({ scaleX: 2, scaleY: 2, destX: -2, destY: 1, width: 8, height: 4 })
    expect(nw.pivot).toEqual({ x: 6, y: 5 })
  })

  it('pins the selection center with Alt', () => {
    const session = sessionAt2x3()
    const centered = resolveBitmapFloatingScaleForHandle(session, 'se', 8, 6, { altKey: true })!
    expect(centered).toMatchObject({ scaleX: 2, scaleY: 2, destX: 0, destY: 2, width: 8, height: 4 })
    expect(centered.isCentered).toBe(true)
    expect(centered.pivot).toEqual({ x: 4, y: 4 })
  })

  it('mirrors with negative factors past the fixed point', () => {
    const session = sessionAt2x3()
    const mirrored = resolveBitmapFloatingScaleForHandle(session, 'se', 0, 0)!
    expect(mirrored.scaleX).toBeLessThan(0)
    expect(mirrored.scaleY).toBeLessThan(0)
    expect(mirrored.flippedX).toBe(true)
    expect(mirrored.flippedY).toBe(true)
    expect(mirrored).toMatchObject({ scaleX: -1.5, scaleY: -1.5, destX: -4, destY: 0, width: 6, height: 3 })
    // The negative factors feed the existing mirror-capable scaler and the
    // fixed NW pivot stays stamped at its canvas point.
    const scaled = scaleBitmapFloatingSession(session, mirrored.scaleX, mirrored.scaleY)
    expect(scaled.changed).toBe(true)
    const preview = renderBitmapFloatingSession(session, mirrored.destX, mirrored.destY)
    expect(preview.changed).toBe(true)
  })

  it('rejects unusable handles and pointers without throwing', () => {
    const session = sessionAt2x3()
    expect(resolveBitmapFloatingScaleForHandle(session, 'se', Number.NaN, 5)).toBeUndefined()
    expect(
      resolveBitmapFloatingScaleForHandle(session, 'middle' as never, 10, 5),
    ).toBeUndefined()
    expect(isBitmapFloatingCornerHandle('se')).toBe(true)
    expect(isBitmapFloatingCornerHandle('e')).toBe(false)
  })
})
