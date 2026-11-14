import { describe, expect, it } from 'bun:test'
import {
  beginBitmapFloatingSession,
  centeredBitmapFloatingDest,
  renderBitmapFloatingSession,
  rotateBitmapFloatingSessionArbitrary,
  type BitmapFloatingImage,
} from '../src/features/costumes/bitmap-floating-session'
import {
  isRotationNoop,
  resolveRotationGesture,
} from '../src/features/costumes/rotation-gesture'

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
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      image.data[index] = base[0]
      image.data[index + 1] = base[1]
      image.data[index + 2] = base[2]
      image.data[index + 3] = base[3]
    }
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

describe('rotation handle: arbitrary bitmap rotation from the start snapshot', () => {
  it('rotates 45 degrees into a larger tight box without touching committed', () => {
    const image = makeImage(12, 12, WHITE)
    paint(image, 5, 5, RED)
    paint(image, 6, 5, GREEN)
    paint(image, 5, 6, BLUE)
    const snapshot = new Uint8ClampedArray(image.data)
    const session = beginBitmapFloatingSession(image, { x: 4, y: 4, width: 4, height: 4 })!
    const original = { width: session.patch.width, height: session.patch.height, data: new Uint8ClampedArray(session.patch.data) }
    const rotated = rotateBitmapFloatingSessionArbitrary(session, original, 45)
    expect(rotated.changed).toBe(true)
    // 4x4 at 45 degrees grows to a 6x6 tight box (ceil(4*sqrt(2))).
    expect(session.patch.width).toBe(6)
    expect(session.patch.height).toBe(6)
    const dest = centeredBitmapFloatingDest(session.sourceRect, session.patch.width, session.patch.height)
    expect(dest).toEqual({ x: 3, y: 3 })
    const preview = renderBitmapFloatingSession(session, dest.x, dest.y)
    expect(preview.changed).toBe(true)
    expect(session.committed.data).toEqual(snapshot)
  })

  it('restarts from the original patch every time (no accumulation)', () => {
    const image = makeImage(12, 12, WHITE)
    const session = beginBitmapFloatingSession(image, { x: 4, y: 4, width: 4, height: 4 })!
    const original = { width: session.patch.width, height: session.patch.height, data: new Uint8ClampedArray(session.patch.data) }
    const first = rotateBitmapFloatingSessionArbitrary(session, original, 30)
    expect(first.changed).toBe(true)
    const firstBytes = new Uint8ClampedArray(session.patch.data)
    // Second preview with the same angle restarts from original: identical bytes.
    const second = rotateBitmapFloatingSessionArbitrary(session, original, 30)
    expect(second.changed).toBe(true)
    expect(session.patch.data).toEqual(firstBytes)
    expect(session.patch.width).toBe(first.patch.width)
  })

  it('treats zero / snapped-to-zero / non-finite angles as no-ops', () => {
    const image = makeImage(8, 8, WHITE)
    const session = beginBitmapFloatingSession(image, { x: 2, y: 2, width: 3, height: 3 })!
    const original = { width: session.patch.width, height: session.patch.height, data: new Uint8ClampedArray(session.patch.data) }
    expect(rotateBitmapFloatingSessionArbitrary(session, original, 0).changed).toBe(false)
    expect(rotateBitmapFloatingSessionArbitrary(session, original, 360).changed).toBe(false)
    expect(rotateBitmapFloatingSessionArbitrary(session, original, Number.NaN).changed).toBe(false)
    expect(isRotationNoop(0)).toBe(true)
  })

  it('resolves Shift 45-degree snap on the absolute gesture delta', () => {
    const center = { x: 0, y: 0 }
    const start = { x: 100, y: 0 }
    // ~37 degrees clockwise in screen (y-down) coordinates.
    const current = { x: 100 * Math.cos((37 * Math.PI) / 180), y: 100 * Math.sin((37 * Math.PI) / 180) }
    const free = resolveRotationGesture(center, start, current, {})
    expect(free.snapped).toBe(false)
    expect(free.appliedDeltaDegrees).toBeCloseTo(37, 0)
    expect(free.noop).toBe(false)
    const snapped = resolveRotationGesture(center, start, current, { shiftKey: true })
    expect(snapped.snapped).toBe(true)
    expect(snapped.appliedDeltaDegrees).toBeCloseTo(45, 0)
    // Mid-drag Shift toggle recomputes from the same endpoints, so releasing
    // Shift returns the free angle (no latch).
    const released = resolveRotationGesture(center, start, current, { shiftKey: false })
    expect(released.appliedDeltaDegrees).toBeCloseTo(37, 0)
    // Small drags snap to zero and stay undo-clean.
    const tinyCurrent = { x: 100 * Math.cos((10 * Math.PI) / 180), y: 100 * Math.sin((10 * Math.PI) / 180) }
    const tiny = resolveRotationGesture(center, start, tinyCurrent, { shiftKey: true })
    expect(tiny.appliedDeltaDegrees).toBe(0)
    expect(tiny.noop).toBe(true)
  })

  it('treats a press on the rotation center as a no-op, not a wild spin', () => {
    const center = { x: 5, y: 5 }
    const gesture = resolveRotationGesture(center, { ...center }, { x: 9, y: 5 }, {})
    expect(gesture.valid).toBe(false)
    expect(gesture.noop).toBe(true)
  })
})
