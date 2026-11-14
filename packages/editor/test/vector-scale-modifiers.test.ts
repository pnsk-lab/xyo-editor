import { describe, expect, it } from 'bun:test'
import {
  MIN_VECTOR_SCALE_FACTOR,
  applyVectorScaleToPoint,
  isCornerResizeHandle,
  resolveVectorScale,
} from '../src/features/costumes/vector-scale-modifiers'

const bounds = { x: 10, y: 20, width: 100, height: 50 }

describe('vector-scale-modifiers corner behavior', () => {
  it('keeps aspect on corner handles by default', () => {
    const result = resolveVectorScale('se', bounds, 20, 5)
    expect(result.isUniform).toBe(true)
    expect(Math.abs(result.scaleX)).toBeCloseTo(Math.abs(result.scaleY), 10)
    // X の伸びが支配的なので両軸とも 1.2 倍になる
    expect(result.scaleX).toBeCloseTo(1.2, 10)
    expect(result.scaleY).toBeCloseTo(1.2, 10)
  })

  it('allows free ratio on corner handles with Shift', () => {
    const result = resolveVectorScale('se', bounds, 20, 5, { shiftKey: true })
    expect(result.isUniform).toBe(false)
    expect(result.scaleX).toBeCloseTo(1.2, 10)
    expect(result.scaleY).toBeCloseTo(1.1, 10)
  })

  it('keeps edge handles free regardless of Shift', () => {
    const plain = resolveVectorScale('e', bounds, 20, 40)
    const shifted = resolveVectorScale('e', bounds, 20, 40, { shiftKey: true })
    expect(plain.isUniform).toBe(false)
    expect(shifted.isUniform).toBe(false)
    expect(plain.scaleX).toBeCloseTo(1.2, 10)
    expect(plain.scaleY).toBe(1)
    expect(shifted.scaleY).toBe(1)
  })

  it('classifies corner and edge handles', () => {
    expect(isCornerResizeHandle('nw')).toBe(true)
    expect(isCornerResizeHandle('se')).toBe(true)
    expect(isCornerResizeHandle('n')).toBe(false)
    expect(isCornerResizeHandle('e')).toBe(false)
  })
})

describe('vector-scale-modifiers Alt centering', () => {
  it('uses the bounds center as the pivot with Alt', () => {
    const result = resolveVectorScale('se', bounds, 20, 5, { altKey: true })
    expect(result.isCentered).toBe(true)
    expect(result.pivot.x).toBeCloseTo(60, 10)
    expect(result.pivot.y).toBeCloseTo(45, 10)
  })

  it('matches double-sided growth with Alt', () => {
    const centered = resolveVectorScale('e', bounds, 10, 0, { altKey: true })
    // 中心基準では片側 +10 が両側 +20 相当になる
    expect(centered.scaleX).toBeCloseTo(1.2, 10)
    const plain = resolveVectorScale('e', bounds, 10, 0)
    expect(plain.pivot.x).toBeCloseTo(10, 10)
    expect(plain.scaleX).toBeCloseTo(1.1, 10)
  })

  it('keeps uniform aspect with Alt unless Shift is held', () => {
    const uniform = resolveVectorScale('se', bounds, 20, 5, { altKey: true })
    expect(uniform.isUniform).toBe(true)
    expect(Math.abs(uniform.scaleX)).toBeCloseTo(Math.abs(uniform.scaleY), 10)
    const free = resolveVectorScale('se', bounds, 20, 5, { altKey: true, shiftKey: true })
    expect(free.isUniform).toBe(false)
  })
})

describe('vector-scale-modifiers negative scale and clamping', () => {
  it('reports a flip when dragged past the fixed point', () => {
    // se の固定点は nw (10, 20)。-120 動かすと反対側へ突き抜ける。
    const result = resolveVectorScale('se', bounds, -120, -60)
    expect(result.flippedX).toBe(true)
    expect(result.flippedY).toBe(true)
    expect(result.scaleX).toBeLessThan(0)
    expect(result.scaleY).toBeLessThan(0)
  })

  it('maps points mirrored around the pivot on flip', () => {
    const result = resolveVectorScale('se', bounds, -120, 0)
    expect(result.flippedX).toBe(true)
    const grabbedCorner = { x: 110, y: 70 }
    const mapped = applyVectorScaleToPoint(grabbedCorner, result.pivot, result.scaleX, result.scaleY)
    // 固定点 (10, 20) 基準で X 反転する
    expect(mapped.x).toBeLessThan(result.pivot.x)
    expect(mapped.y).toBeGreaterThan(result.pivot.y)
  })

  it('clamps near-zero scale while preserving the flip sign', () => {
    // 固定点ちょうどまで戻すと 0 に潰れるため下限へ丸められる
    const positive = resolveVectorScale('se', bounds, -100, -50)
    expect(positive.scaleX).toBeCloseTo(MIN_VECTOR_SCALE_FACTOR, 10)
    expect(positive.scaleY).toBeCloseTo(MIN_VECTOR_SCALE_FACTOR, 10)
    const negative = resolveVectorScale('se', bounds, -100.001, 0, { shiftKey: true })
    expect(negative.scaleX).toBeCloseTo(-MIN_VECTOR_SCALE_FACTOR, 10)
    expect(negative.flippedX).toBe(true)
  })

  it('ignores axes the handle does not control', () => {
    const horizontal = resolveVectorScale('e', bounds, 0, 999)
    expect(horizontal.scaleX).toBe(1)
    expect(horizontal.scaleY).toBe(1)
  })
})
