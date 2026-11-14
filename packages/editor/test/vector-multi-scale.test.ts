import { describe, expect, it } from 'bun:test'
import {
  conjugateWorldMatrix6,
  formatVectorMatrix6Attribute,
  invertVectorMatrix6,
  isNoopVectorScale,
  localScaleMatricesForSelection,
  localScaleMatrixForAncestor,
  multiplyVectorMatrix6,
  prependVectorMatrix6Attribute,
  resolveCommonVectorScale,
  transformVectorPoint6,
  unionVectorScaleBounds,
  worldScaleMatrix6,
  type VectorMatrix6,
} from '../src/features/costumes/vector-multi-scale'

const common = { x: 10, y: 20, width: 100, height: 50 }

function closeToMatrix(actual: VectorMatrix6, expected: VectorMatrix6, digits = 10) {
  expect(actual.length).toBe(6)
  for (let i = 0; i < 6; i++) expect(actual[i]).toBeCloseTo(expected[i]!, digits)
}

describe('vector-multi-scale common-bounds semantics', () => {
  it('keeps corner aspect by default, free with Shift', () => {
    const uniform = resolveCommonVectorScale('se', common, 20, 5)
    expect(uniform.isUniform).toBe(true)
    expect(uniform.scaleX).toBeCloseTo(1.2, 10)
    expect(uniform.scaleY).toBeCloseTo(1.2, 10)
    expect(uniform.noop).toBe(false)
    const free = resolveCommonVectorScale('se', common, 20, 5, { shiftKey: true })
    expect(free.isUniform).toBe(false)
    expect(free.scaleX).toBeCloseTo(1.2, 10)
    expect(free.scaleY).toBeCloseTo(1.1, 10)
  })

  it('keeps edge handles single-axis and Shift-independent', () => {
    const plain = resolveCommonVectorScale('e', common, 20, 999)
    const shifted = resolveCommonVectorScale('e', common, 20, 999, { shiftKey: true })
    expect(plain.scaleX).toBeCloseTo(1.2, 10)
    expect(plain.scaleY).toBe(1)
    expect(shifted.scaleY).toBe(1)
    expect(plain.isUniform).toBe(false)
    expect(shifted.isUniform).toBe(false)
  })

  it('uses the common diagonal fixed point, center with Alt', () => {
    const plain = resolveCommonVectorScale('se', common, 20, 5)
    // se の固定点は共通バウンズの nw (10, 20)。
    expect(plain.pivot.x).toBeCloseTo(10, 10)
    expect(plain.pivot.y).toBeCloseTo(20, 10)
    expect(plain.isCentered).toBe(false)
    const centered = resolveCommonVectorScale('se', common, 20, 5, { altKey: true })
    expect(centered.isCentered).toBe(true)
    expect(centered.pivot.x).toBeCloseTo(60, 10)
    expect(centered.pivot.y).toBeCloseTo(45, 10)
  })

  it('doubles one-sided growth with Alt', () => {
    const centered = resolveCommonVectorScale('e', common, 10, 0, { altKey: true })
    expect(centered.scaleX).toBeCloseTo(1.2, 10)
    const plain = resolveCommonVectorScale('e', common, 10, 0)
    expect(plain.scaleX).toBeCloseTo(1.1, 10)
  })

  it('reports flips with negative factors', () => {
    const flipped = resolveCommonVectorScale('se', common, -120, -60)
    expect(flipped.flippedX).toBe(true)
    expect(flipped.flippedY).toBe(true)
    expect(flipped.scaleX).toBeLessThan(0)
    expect(flipped.scaleY).toBeLessThan(0)
  })

  it('treats identity as noop', () => {
    const idle = resolveCommonVectorScale('se', common, 0, 0)
    expect(idle.noop).toBe(true)
    expect(isNoopVectorScale(idle.scaleX, idle.scaleY)).toBe(true)
    const edgeIdle = resolveCommonVectorScale('e', common, 0, 999)
    expect(edgeIdle.noop).toBe(true)
  })
})

describe('vector-multi-scale world/local matrices', () => {
  it('matches pivot scaling for points', () => {
    const resolved = resolveCommonVectorScale('se', common, 20, 5, { shiftKey: true })
    const mapped = transformVectorPoint6(resolved.world, { x: 110, y: 70 })
    // 固定点 (10, 20) 基準の 1.2 / 1.1 倍。
    expect(mapped.x).toBeCloseTo(10 + 100 * 1.2, 10)
    expect(mapped.y).toBeCloseTo(20 + 50 * 1.1, 10)
  })

  it('maps the grabbed corner onto the dragged position (free ratio)', () => {
    const resolved = resolveCommonVectorScale('se', common, 20, 5, { shiftKey: true })
    const mapped = transformVectorPoint6(resolved.world, { x: 110, y: 70 })
    expect(mapped.x).toBeCloseTo(130, 10)
    expect(mapped.y).toBeCloseTo(75, 10)
  })

  it('returns world as-is without ancestors', () => {
    const resolved = resolveCommonVectorScale('e', common, 20, 0)
    closeToMatrix(localScaleMatrixForAncestor(undefined, resolved.world), resolved.world)
  })

  it('conjugates per-ancestor matrices (A * L == W * A)', () => {
    const resolved = resolveCommonVectorScale('se', common, 20, 5, { shiftKey: true })
    const ancestors: Array<VectorMatrix6 | undefined> = [
      undefined,
      [1, 0, 0, 1, 30, 10],
      [2, 0, 0, 2, -10, 5],
    ]
    const locals = localScaleMatricesForSelection(ancestors, resolved.world)
    expect(locals.length).toBe(ancestors.length)
    for (let i = 0; i < ancestors.length; i++) {
      const ancestor = ancestors[i]
      const local = locals[i]!
      if (!ancestor) {
        closeToMatrix(local, resolved.world)
        continue
      }
      // 異なる祖先でも表示結果は同一の W になる: A * L == W * A。
      closeToMatrix(multiplyVectorMatrix6(ancestor, local), multiplyVectorMatrix6(resolved.world, ancestor))
    }
  })

  it('keeps mirrored-ancestor conjugation consistent', () => {
    // 反転した祖先 (det < 0) の下でも共役関係が成り立つこと。
    const resolved = resolveCommonVectorScale('e', common, 20, 0, { shiftKey: true })
    const ancestor: VectorMatrix6 = [-1, 0, 0, 1, 200, 0]
    const local = localScaleMatrixForAncestor(ancestor, resolved.world)
    closeToMatrix(multiplyVectorMatrix6(ancestor, local), multiplyVectorMatrix6(resolved.world, ancestor))
    // 負倍率 (反転ドラッグ) と反転祖先の合成も壊れない。
    const flipped = resolveCommonVectorScale('se', common, -120, 0, { shiftKey: true })
    const flippedLocal = localScaleMatrixForAncestor(ancestor, flipped.world)
    closeToMatrix(multiplyVectorMatrix6(ancestor, flippedLocal), multiplyVectorMatrix6(flipped.world, ancestor))
  })

  it('inverts matrices and falls back for singular input', () => {
    const matrix: VectorMatrix6 = [2, 0, 0, 3, 4, 5]
    closeToMatrix(multiplyVectorMatrix6(matrix, invertVectorMatrix6(matrix)), [1, 0, 0, 1, 0, 0])
    closeToMatrix(invertVectorMatrix6([0, 0, 0, 0, 0, 0]), [1, 0, 0, 1, 0, 0])
    void worldScaleMatrix6
  })

  it('prepends without touching order', () => {
    const resolved = resolveCommonVectorScale('e', common, 20, 0)
    const local = localScaleMatrixForAncestor([1, 0, 0, 1, 30, 10], resolved.world)
    const next = prependVectorMatrix6Attribute('translate(1 2)', local)
    expect(next.startsWith(formatVectorMatrix6Attribute(local))).toBe(true)
    expect(next.endsWith('translate(1 2)')).toBe(true)
    expect(prependVectorMatrix6Attribute('', local)).toBe(formatVectorMatrix6Attribute(local))
  })
})

describe('vector-multi-scale bounds union', () => {
  it('unions document-space bounds', () => {
    const union = unionVectorScaleBounds([
      { x: 10, y: 20, width: 40, height: 20 },
      { x: 80, y: 30, width: 40, height: 20 },
    ])
    expect(union).toEqual({ x: 10, y: 20, width: 110, height: 30 })
  })

  it('returns undefined for empty input', () => {
    expect(unionVectorScaleBounds([])).toBeUndefined()
    expect(unionVectorScaleBounds([{ x: 0, y: 0, width: 0, height: 0 }])).toBeUndefined()
  })
})
