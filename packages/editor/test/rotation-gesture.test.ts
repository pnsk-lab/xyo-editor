import { describe, expect, it } from 'bun:test'
import {
  accumulateRotationPath,
  accumulateRotationStep,
  isRotationNoop,
  normalizeRotationDegrees,
  resolveRotationDelta,
  resolveRotationGesture,
  rotationAngleOfPoint,
  ROTATION_SNAP_STEP_DEGREES,
  shortestRotationDeltaDegrees,
  snapRotationDegrees,
  toWorldDelta,
  toWorldPoint,
  unwrapRotationDegrees,
} from '../src/features/costumes/rotation-gesture'

const CENTER = { x: 0, y: 0 }

function pointAt(degreesClockwise: number, radius = 100) {
  // 画面 y 下向き: 時計回り正の偏角を持つ点を返す。
  const radians = (degreesClockwise * Math.PI) / 180
  return { x: Math.cos(radians) * radius, y: Math.sin(radians) * radius }
}

describe('rotation-gesture basic delta (screen clockwise positive)', () => {
  it('exposes 45-degree snap step shared with canvas/vector', () => {
    expect(ROTATION_SNAP_STEP_DEGREES).toBe(45)
  })

  it('measures a quarter turn clockwise as +90 in screen coordinates', () => {
    expect(rotationAngleOfPoint(CENTER, { x: 1, y: 0 })).toBeCloseTo(0, 10)
    expect(rotationAngleOfPoint(CENTER, { x: 0, y: 1 })).toBeCloseTo(90, 10)
    expect(rotationAngleOfPoint(CENTER, { x: -1, y: 0 })).toBeCloseTo(180, 10)
    expect(rotationAngleOfPoint(CENTER, { x: 0, y: -1 })).toBeCloseTo(-90, 10)
    const delta = resolveRotationDelta(CENTER, { x: 1, y: 0 }, { x: 0, y: 1 })
    expect(delta.valid).toBe(true)
    expect(delta.deltaDegrees).toBeCloseTo(90, 10)
  })

  it('passes arbitrary angles through without Shift (no snapping)', () => {
    const gesture = resolveRotationGesture(CENTER, pointAt(10), pointAt(47))
    expect(gesture.valid).toBe(true)
    expect(gesture.snapped).toBe(false)
    expect(gesture.appliedDeltaDegrees).toBeCloseTo(37, 10)
    expect(gesture.snappedDeltaDegrees).toBeCloseTo(37, 10)
    expect(gesture.noop).toBe(false)
  })

  it('snaps the delta to 45-degree steps while Shift is held', () => {
    // 37 度 → 45 度へ吸着。
    const snapped = resolveRotationGesture(CENTER, pointAt(10), pointAt(47), { shiftKey: true })
    expect(snapped.snapped).toBe(true)
    expect(snapped.appliedDeltaDegrees).toBeCloseTo(45, 10)
    // 20 度 → 0 度へ吸着し no-op になる (履歴を積まない契約)。
    const settled = resolveRotationGesture(CENTER, pointAt(0), pointAt(20), { shiftKey: true })
    expect(settled.appliedDeltaDegrees).toBe(0)
    expect(settled.noop).toBe(true)
    // 87 度 → 90 度。
    expect(snapRotationDegrees(87, true)).toBe(90)
    expect(snapRotationDegrees(87, false)).toBe(87)
  })
})

describe('rotation-gesture zero distance', () => {
  it('reports undefined angles for coincident points', () => {
    expect(rotationAngleOfPoint(CENTER, CENTER)).toBeUndefined()
    expect(rotationAngleOfPoint(CENTER, { x: 0, y: 0 })).toBeUndefined()
  })

  it('treats press/current on the center as noop instead of a wild spin', () => {
    const pressOnCenter = resolveRotationGesture(CENTER, CENTER, pointAt(90))
    expect(pressOnCenter.valid).toBe(false)
    expect(pressOnCenter.deltaDegrees).toBe(0)
    expect(pressOnCenter.noop).toBe(true)
    const moveOntoCenter = resolveRotationGesture(CENTER, pointAt(0), CENTER)
    expect(moveOntoCenter.valid).toBe(false)
    expect(moveOntoCenter.noop).toBe(true)
    const step = accumulateRotationStep(30, CENTER, pointAt(0), CENTER)
    expect(step.valid).toBe(false)
    expect(step.stepDeltaDegrees).toBe(0)
    expect(step.cumulativeDegrees).toBe(30)
  })

  it('treats non-finite input as noop', () => {
    const broken = resolveRotationGesture(CENTER, { x: Number.NaN, y: 0 }, pointAt(45))
    expect(broken.valid).toBe(false)
    expect(broken.noop).toBe(true)
    expect(isRotationNoop(Number.NaN)).toBe(true)
    expect(isRotationNoop(0)).toBe(true)
    expect(isRotationNoop(1e-12)).toBe(true)
    expect(isRotationNoop(0.5)).toBe(false)
  })
})

describe('rotation-gesture ±180 boundary and unwrap', () => {
  it('takes the short way across the branch cut', () => {
    // 179 → -179 は +2 度であって -358 度ではない。
    expect(shortestRotationDeltaDegrees(179, -179)).toBeCloseTo(2, 10)
    expect(shortestRotationDeltaDegrees(-179, 179)).toBeCloseTo(-2, 10)
    expect(normalizeRotationDegrees(-180)).toBe(180)
    expect(normalizeRotationDegrees(180)).toBe(180)
    expect(normalizeRotationDegrees(540)).toBe(180)
  })

  it('unwraps raw angles onto the previous continuous angle', () => {
    // 179 の次に -179 が来ても連続角は 181 へ進む。
    expect(unwrapRotationDegrees(179, -179)).toBeCloseTo(181, 10)
    expect(unwrapRotationDegrees(-179, 179)).toBeCloseTo(-181, 10)
    expect(unwrapRotationDegrees(10, 370)).toBeCloseTo(10, 10)
  })

  it('accumulates across the cut without jumping', () => {
    let cumulative = 0
    const first = accumulateRotationStep(cumulative, CENTER, pointAt(170), pointAt(179))
    cumulative = first.cumulativeDegrees
    expect(first.stepDeltaDegrees).toBeCloseTo(9, 10)
    const across = accumulateRotationStep(cumulative, CENTER, pointAt(179), pointAt(-179))
    expect(across.stepDeltaDegrees).toBeCloseTo(2, 10)
    expect(across.cumulativeDegrees).toBeCloseTo(11, 10)
  })
})

describe('rotation-gesture rewind and multi-turn accumulation', () => {
  it('subtracts when the drag rewinds', () => {
    // +90, +90 と進んで -90 戻る → 累積 +90。
    const path = accumulateRotationPath(CENTER, [pointAt(0), pointAt(90), pointAt(180), pointAt(90)])
    expect(path.valid).toBe(true)
    expect(path.stepDeltas.map((value) => Math.round(value))).toEqual([90, 90, -90])
    expect(path.cumulativeDegrees).toBeCloseTo(90, 8)
  })

  it('accumulates beyond ±180 for full turns', () => {
    const path = accumulateRotationPath(CENTER, [
      pointAt(0),
      pointAt(90),
      pointAt(180),
      pointAt(-90),
      pointAt(0),
    ])
    expect(path.cumulativeDegrees).toBeCloseTo(360, 8)
    // 逆回転は -360 に蓄積する。
    const reverse = accumulateRotationPath(CENTER, [
      pointAt(0),
      pointAt(-90),
      pointAt(180),
      pointAt(90),
      pointAt(0),
    ])
    expect(reverse.cumulativeDegrees).toBeCloseTo(-360, 8)
  })

  it('keeps snapped cumulative angles continuous for multi-turn drags', () => {
    // スナップは正規化しないので 370 → 360 の連続性を保つ。
    expect(snapRotationDegrees(370, true)).toBe(360)
    expect(snapRotationDegrees(-370, true)).toBe(-360)
    expect(normalizeRotationDegrees(snapRotationDegrees(370, true))).toBe(0)
  })
})

describe('rotation-gesture screen coordinates and zoom', () => {
  it('treats y-down as clockwise positive (canvas/SVG shared)', () => {
    // 画面下方向 (0, +1) が +90 度 = 時計回り。
    const down = resolveRotationDelta(CENTER, { x: 10, y: 0 }, { x: 0, y: 10 })
    expect(down.deltaDegrees).toBeCloseTo(90, 10)
    // 数学 (y 上向き) とは符号が逆であることを明示する。
    const upOnScreen = resolveRotationDelta(CENTER, { x: 10, y: 0 }, { x: 0, y: -10 })
    expect(upOnScreen.deltaDegrees).toBeCloseTo(-90, 10)
  })

  it('is zoom-invariant once client coordinates are converted to world', () => {
    const origin = { x: 100, y: 50 }
    const zoom = 2
    const centerClient = { x: 100, y: 50 }
    const startClient = { x: 200, y: 50 }
    const currentClient = { x: 100, y: 150 }
    const centerWorld = toWorldPoint(centerClient, origin, zoom)
    const startWorld = toWorldPoint(startClient, origin, zoom)
    const currentWorld = toWorldPoint(currentClient, origin, zoom)
    expect(centerWorld).toEqual({ x: 0, y: 0 })
    expect(startWorld).toEqual({ x: 50, y: 0 })
    expect(currentWorld).toEqual({ x: 0, y: 50 })
    const zoomed = resolveRotationGesture(centerWorld, startWorld, currentWorld)
    const unzoomed = resolveRotationGesture(CENTER, { x: 50, y: 0 }, { x: 0, y: 50 })
    expect(zoomed.appliedDeltaDegrees).toBeCloseTo(unzoomed.appliedDeltaDegrees, 10)
    expect(zoomed.appliedDeltaDegrees).toBeCloseTo(90, 10)
    // 差分の換算も zoom 除算であること。
    expect(toWorldDelta({ x: 20, y: -10 }, 2)).toEqual({ x: 10, y: -5 })
    expect(toWorldPoint({ x: 110, y: 60 }, { x: 10, y: 10 }, 0)).toEqual({ x: 100, y: 50 })
  })
})
