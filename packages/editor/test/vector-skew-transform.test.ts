// Skew-aware SVG transform parser audit (`vector-svg.ts` + `vector-group-reshape.ts`).
//
// Covers the reported gap: `transformMatrix` used to silently drop `skewX` /
// `skewY` while Paper.js hit-testing applies them, so ancestor-inverse
// coordinate mapping for reshape point move/add diverged on skewed ancestors.
// Verified here without a browser (bun unit test, stub Elements):
//
// - `skewX` / `skewY` closed-form matrices (SVG: x' = x + tan(a)*y,
//   y' = tan(a)*x + y, angles in degrees) including hand-computed anchors.
// - Composition order: left-to-right post-multiply (`outer inner` ===
//   outer * inner), with order-sensitivity witnesses for skew.
// - Number forms: negative / decimal / exponent / `+` sign / comma and space
//   separators.
// - Malformed values fail closed per-operation (skip the op, never NaN), and
//   unknown/case-mismatched ops are ignored.
// - Existing `matrix` / `translate` / `scale` / `rotate` behavior is unchanged
//   (same expectations as before the fix).
// - Non-invertible matrices (singular / overflow / NaN) invert to identity
//   and leaf-local converters fall back to the input point.
// - The two parsers (`transformMatrix` vs `parseSvgTransformAttribute`) agree
//   on a generated corpus, and ancestor chains compose identically in both.
// - Reshape-facing mapping (`worldTransformMatrix` + inverse round-trip,
//   `moveVectorEditablePoint` on a skewed-ancestor rect) recovers local coords.
//
// Browser-oracle coverage (real `DOMMatrix` / SVG `consolidate()` / Paper.js
// `globalToLocal` plus a live-editor skew-ancestor leaf move with
// undo/redo and sibling invariance) lives in
// `vector-skew-transform.browser.test.ts`.

import { describe, expect, it } from 'bun:test'
import {
  ancestorWorldMatrix,
  documentPointToLocalGradientPoint,
  invertVectorMatrix,
  moveVectorEditablePoint,
  transformMatrix,
  transformVectorPoint,
  worldTransformMatrix,
  type VectorMatrix,
} from '../src/features/costumes/vector-svg'
import {
  applyGroupMatrix,
  collectGroupLeafDescriptors,
  composeUnitWorldMatrix,
  documentCtmForLeaf,
  documentPointToLeafLocal,
  invertGroupMatrix,
  parseSvgTransformAttribute,
  type VectorGroupMatrix,
} from '../src/features/costumes/vector-group-reshape'

// ---------------------------------------------------------------------------
// Stub Element (bun has no DOMParser): just enough for the transform helpers.
// ---------------------------------------------------------------------------

class StubElement {
  nodeType = 1
  tagName: string
  children: StubElement[] = []
  parentElement: StubElement | null = null
  nodeName: string
  private attrs = new Map<string, string>()

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag
    this.nodeName = tag
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value))
  }
}

const asElement = (node: StubElement) => node as unknown as Element

function svgRoot(...kids: StubElement[]): StubElement {
  const svg = new StubElement('svg')
  for (const kid of kids) {
    kid.parentElement = svg
    svg.children.push(kid)
  }
  return svg
}

function group(transform: string, ...kids: StubElement[]): StubElement {
  const g = new StubElement('g', transform ? { transform } : {})
  for (const kid of kids) {
    kid.parentElement = g
    g.children.push(kid)
  }
  return g
}

function rect(attrs: Record<string, string> = {}): StubElement {
  return new StubElement('rect', attrs)
}

// ---------------------------------------------------------------------------
// Independent spec-derived oracle (own derivation, no reference code copied).
// ---------------------------------------------------------------------------

type Mat = [number, number, number, number, number, number]

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

function mul(left: Mat, right: Mat): Mat {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

const tanDeg = (degrees: number) => Math.tan((degrees * Math.PI) / 180)

function closeToMatrix(actual: readonly number[], expected: readonly number[], tolerance = 1e-9) {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(tolerance)
  }
}

// Deterministic PRNG so the corpus is stable across runs.
const SkewCorpusSeed = 151521
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomNumberText(rand: () => number): string {
  const style = rand()
  const magnitude = (rand() - 0.35) * 200
  if (style < 0.25) return String(Math.round(magnitude * 1000) / 1000)
  if (style < 0.5) return magnitude.toExponential(2).replace('e', rand() < 0.5 ? 'e' : 'E')
  if (style < 0.7) return (magnitude >= 0 ? '+' : '') + (Math.round(magnitude * 100) / 100).toFixed(2)
  return `.${Math.floor(Math.abs(magnitude * 10) % 10)}${Math.floor(rand() * 90 + 10)}`
}

function randomTransformText(rand: () => number, maxOps = 4): string {
  const kinds = ['matrix', 'translate', 'scale', 'rotate', 'skewX', 'skewY'] as const
  const count = 1 + Math.floor(rand() * maxOps)
  const ops: string[] = []
  for (let i = 0; i < count; i++) {
    const kind = kinds[Math.floor(rand() * kinds.length)]!
    const sep = rand() < 0.5 ? ' ' : ','
    const pad = rand() < 0.5 ? '' : ' '
    const n = () => randomNumberText(rand)
    if (kind === 'matrix') ops.push(`matrix(${pad}${[n(), n(), n(), n(), n(), n()].join(sep)}${pad})`)
    else if (kind === 'translate') ops.push(rand() < 0.5 ? `translate(${pad}${n()}${pad})` : `translate(${pad}${n()}${sep}${n()}${pad})`)
    else if (kind === 'scale') ops.push(rand() < 0.5 ? `scale(${pad}${n()}${pad})` : `scale(${pad}${n()}${sep}${n()}${pad})`)
    else if (kind === 'rotate') ops.push(rand() < 0.5 ? `rotate(${pad}${n()}${pad})` : `rotate(${pad}${n()}${sep}${n()}${sep}${n()}${pad})`)
    else ops.push(`${kind}(${pad}${n()}${pad})`)
  }
  return ops.join(rand() < 0.5 ? ' ' : ', ')
}

// ---------------------------------------------------------------------------
// Closed-form skew anchors (hand-computed from the SVG definitions).
// ---------------------------------------------------------------------------

describe('skew closed forms', () => {
  it('skewX(45) shears x by y', () => {
    closeToMatrix(transformMatrix('skewX(45)')!, [1, 0, 1, 1, 0, 0])
  })

  it('skewY(45) shears y by x', () => {
    closeToMatrix(transformMatrix('skewY(45)')!, [1, 1, 0, 1, 0, 0])
  })

  it('skew of zero is identity; negative angles negate the tangent', () => {
    closeToMatrix(transformMatrix('skewX(0)')!, [...IDENTITY])
    closeToMatrix(transformMatrix('skewY(0)')!, [...IDENTITY])
    closeToMatrix(transformMatrix('skewX(-45)')!, [1, 0, -1, 1, 0, 0])
    closeToMatrix(transformMatrix('skewY(-45)')!, [1, -1, 0, 1, 0, 0])
  })

  it('skewX(30) matches tan(30deg)', () => {
    const t = tanDeg(30)
    closeToMatrix(transformMatrix('skewX(30)')!, [1, 0, t, 1, 0, 0])
    const mapped = transformVectorPoint(transformMatrix('skewX(30)')!, 2, 3)
    expect(mapped.x).toBeCloseTo(2 + t * 3, 9)
    expect(mapped.y).toBeCloseTo(3, 9)
  })

  it('group-reshape parser agrees on the skew closed forms', () => {
    closeToMatrix(parseSvgTransformAttribute('skewX(45)'), [1, 0, 1, 1, 0, 0])
    closeToMatrix(parseSvgTransformAttribute('skewY(45)'), [1, 1, 0, 1, 0, 0])
    closeToMatrix(parseSvgTransformAttribute('skewX(-45)'), [1, 0, -1, 1, 0, 0])
    closeToMatrix(parseSvgTransformAttribute('skewY(-30)'), [1, tanDeg(-30), 0, 1, 0, 0])
  })
})

// ---------------------------------------------------------------------------
// Composition order.
// ---------------------------------------------------------------------------

describe('transform composition order with skew', () => {
  it('outer inner === outer * inner (nested-g equivalence)', () => {
    const outer = transformMatrix('translate(10 0)')!
    const inner = transformMatrix('skewX(45)')!
    closeToMatrix(transformMatrix('translate(10 0) skewX(45)')!, mul(outer, inner))
  })

  it('skew/translate order is observable (witness points differ)', () => {
    // "translate(0 5) skewX(45)": skew first, then translate -> (0,0) maps to (0,5).
    const skewedThenMoved = transformVectorPoint(transformMatrix('translate(0 5) skewX(45)')!, 0, 0)
    expect(skewedThenMoved.x).toBeCloseTo(0, 9)
    expect(skewedThenMoved.y).toBeCloseTo(5, 9)
    // "skewX(45) translate(0 5)": translate first, then skew drags x by y -> (5,5).
    const movedThenSkewed = transformVectorPoint(transformMatrix('skewX(45) translate(0 5)')!, 0, 0)
    expect(movedThenSkewed.x).toBeCloseTo(5, 9)
    expect(movedThenSkewed.y).toBeCloseTo(5, 9)
  })

  it('mixed chains fold left: translate, skew, scale, rotate, matrix', () => {
    const chain = 'translate(10 -4) skewX(20) scale(2 0.5) skewY(-15) rotate(30) matrix(1 0 0 1 3 4)'
    const parts = ['translate(10 -4)', 'skewX(20)', 'scale(2 0.5)', 'skewY(-15)', 'rotate(30)', 'matrix(1 0 0 1 3 4)']
    let expected: Mat = [...IDENTITY]
    for (const part of parts) expected = mul(expected, transformMatrix(part)!)
    closeToMatrix(transformMatrix(chain)!, expected, 1e-9)
    closeToMatrix(parseSvgTransformAttribute(chain), expected, 1e-9)
  })
})

// ---------------------------------------------------------------------------
// Number forms: negative / decimal / exponent / separators.
// ---------------------------------------------------------------------------

describe('number forms', () => {
  it.each([
    ['translate(-1.5e2 2.5E-1)', [1, 0, 0, 1, -150, 0.25]],
    ['translate(+10 +20)', [1, 0, 0, 1, 10, 20]],
    ['translate(10,20)', [1, 0, 0, 1, 10, 20]],
    ['translate(.5 -.25)', [1, 0, 0, 1, 0.5, -0.25]],
    ['scale(-2 .5)', [-2, 0, 0, 0.5, 0, 0]],
    ['scale(2e0)', [2, 0, 0, 2, 0, 0]],
    ['skewX(-3e1)', [1, 0, tanDeg(-30), 1, 0, 0]],
    ['skewY(1.5e1)', [1, tanDeg(15), 0, 1, 0, 0]],
    ['rotate(1e2)', [Math.cos((100 * Math.PI) / 180), Math.sin((100 * Math.PI) / 180), -Math.sin((100 * Math.PI) / 180), Math.cos((100 * Math.PI) / 180), 0, 0]],
    ['matrix(1e0 0 0 1 -5 +5)', [1, 0, 0, 1, -5, 5]],
  ])('%s parses exactly', (text, expected) => {
    closeToMatrix(transformMatrix(text)!, expected as number[], 1e-9)
    closeToMatrix(parseSvgTransformAttribute(text), expected as number[], 1e-9)
  })
})

// ---------------------------------------------------------------------------
// Malformed input fails closed (skips the op, never NaN, never throws).
// ---------------------------------------------------------------------------

describe('malformed transforms fail closed', () => {
  it('empty transform has no matrix', () => {
    expect(transformMatrix('')).toBeUndefined()
    expect(transformMatrix('   ')).toBeUndefined()
    closeToMatrix(parseSvgTransformAttribute(''), [...IDENTITY])
    closeToMatrix(parseSvgTransformAttribute(null), [...IDENTITY])
  })

  it.each([
    'translate()',
    'translate(foo)',
    'translate(10 abc)',
    'scale()',
    'scale(foo)',
    'rotate()',
    'skewX()',
    'skewX(foo)',
    'skewY()',
    'skewY(1 2 3 bogus)',
    'matrix(1 2 3)',
    'matrix(1 0 0 1 0)',
    'translate(1e9999)',
    'skewX(Infinity)',
    'skewY(NaN)',
    'skewx(30)',
    'skewy(30)',
    'SKEWX(30)',
    'skew(30)',
    'translate(10 20',
    'skewX30)',
  ])('%s contributes identity', (text) => {
    const vector = transformMatrix(text)
    if (vector !== undefined) closeToMatrix(vector, [...IDENTITY])
    closeToMatrix(parseSvgTransformAttribute(text), [...IDENTITY])
  })

  it('a malformed op does not poison its neighbours', () => {
    const mixed = 'translate(10 20) skewX(bogus) scale(2)'
    closeToMatrix(transformMatrix(mixed)!, transformMatrix('translate(10 20) scale(2)')!)
    closeToMatrix(parseSvgTransformAttribute(mixed), parseSvgTransformAttribute('translate(10 20) scale(2)'))
  })

  it('unknown operations are ignored', () => {
    closeToMatrix(transformMatrix('frobnicate(1 2) translate(5 5)')!, [1, 0, 0, 1, 5, 5])
    closeToMatrix(parseSvgTransformAttribute('foo(1 2) skewX(45)'), [1, 0, 1, 1, 0, 0])
  })

  it('malformed input never yields NaN entries', () => {
    const probes = ['translate(NaN NaN)', 'scale(Infinity)', 'matrix(0 0 0 0 0 0) skewX()', 'rotate(foo 1 2)']
    for (const text of probes) {
      for (const matrix of [transformMatrix(text) ?? [...IDENTITY], parseSvgTransformAttribute(text)]) {
        for (const entry of matrix) expect(Number.isFinite(entry) || entry === 0).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Existing op behavior is unchanged.
// ---------------------------------------------------------------------------

describe('existing ops are unchanged', () => {
  it('matrix / translate / scale / rotate keep their historical values', () => {
    closeToMatrix(transformMatrix('matrix(1 2 3 4 5 6)')!, [1, 2, 3, 4, 5, 6])
    closeToMatrix(transformMatrix('translate(10 20)')!, [1, 0, 0, 1, 10, 20])
    closeToMatrix(transformMatrix('translate(7)')!, [1, 0, 0, 1, 7, 0])
    closeToMatrix(transformMatrix('scale(2)')!, [2, 0, 0, 2, 0, 0])
    closeToMatrix(transformMatrix('scale(2 3)')!, [2, 0, 0, 3, 0, 0])
    const radians = (30 * Math.PI) / 180
    closeToMatrix(transformMatrix('rotate(30)')!, [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0])
    const about = mul([1, 0, 0, 1, 10, 20], mul([Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0], [1, 0, 0, 1, -10, -20]))
    closeToMatrix(transformMatrix('rotate(30 10 20)')!, about)
  })

  it('two-arg rotate keeps the historical leniency (extra arg ignored)', () => {
    closeToMatrix(transformMatrix('rotate(30 10)')!, transformMatrix('rotate(30)')!)
  })
})

// ---------------------------------------------------------------------------
// Cross-parser agreement on a generated corpus.
// ---------------------------------------------------------------------------

describe('vector-svg and group-reshape parsers agree', () => {
  it('matches on 300 generated transforms including skew/exponents', () => {
    const rand = mulberry32(SkewCorpusSeed)
    for (let i = 0; i < 300; i++) {
      const text = randomTransformText(rand)
      const vector = transformMatrix(text) ?? ([...IDENTITY] as VectorMatrix)
      const grouped = parseSvgTransformAttribute(text)
      closeToMatrix(vector, grouped, 1e-9)
      for (const entry of [...vector, ...grouped]) {
        expect(Number.isFinite(entry)).toBe(true)
      }
    }
  })

  it('matches on skewed ancestor chains composed through the DOM stubs', () => {
    const leaf = rect({ x: '4', y: '6', width: '10', height: '10' })
    const inner = group('translate(5 5)', leaf)
    const outer = group('skewX(30)', inner)
    svgRoot(outer, rect({ x: '0', y: '0', width: '1', height: '1' }))
    const ancestors = ancestorWorldMatrix(asElement(leaf))
    expect(ancestors).toBeDefined()
    closeToMatrix(ancestors!, parseSvgTransformAttribute('skewX(30) translate(5 5)'), 1e-9)
    closeToMatrix(worldTransformMatrix(asElement(leaf))!, ancestors!, 1e-9)
  })
})

// ---------------------------------------------------------------------------
// Non-invertible handling.
// ---------------------------------------------------------------------------

describe('non-invertible transforms', () => {
  it('singular / overflowed / NaN matrices invert to identity', () => {
    expect(invertVectorMatrix([0, 0, 0, 0, 5, 5])).toEqual([1, 0, 0, 1, 0, 0])
    expect(invertVectorMatrix(transformMatrix('scale(0)')!)).toEqual([1, 0, 0, 1, 0, 0])
    expect(invertVectorMatrix(transformMatrix('matrix(1 2 2 4 0 0)')!)).toEqual([1, 0, 0, 1, 0, 0])
    expect(invertVectorMatrix([1e308, 0, 0, 1e308, 0, 0])).toEqual([1, 0, 0, 1, 0, 0])
    expect(invertVectorMatrix([NaN, 0, 0, 1, 0, 0])).toEqual([1, 0, 0, 1, 0, 0])
    expect(invertGroupMatrix([1, 1, 1, 1, 0, 0])).toEqual([1, 0, 0, 1, 0, 0])
    expect(invertGroupMatrix([0, 0, 0, 0, 0, 0])).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('leaf-local converters fall back to the input point on degenerate CTMs', () => {
    const leaf = rect({ x: '0', y: '0', width: '10', height: '10' })
    const collapsed = group('scale(0)', leaf)
    svgRoot(collapsed)
    const point = { x: 42, y: 17 }
    expect(documentPointToLocalGradientPoint(asElement(leaf), point)).toEqual(point)
  })

  it('group helper detects the degenerate CTM and falls back', () => {
    const doc = new StubElement('g', { transform: 'scale(0)' })
    const leafEl = rect({})
    leafEl.parentElement = doc
    doc.children.push(leafEl)
    const [descriptor] = collectGroupLeafDescriptors(asElement(doc))
    expect(descriptor).toBeDefined()
    const unitWorld = parseSvgTransformAttribute('scale(0)')
    const point = { x: 9, y: 3 }
    expect(documentPointToLeafLocal(descriptor!, unitWorld, point)).toEqual(point)
    // ...while invertible skew CTMs still convert exactly.
    const skewed = group('skewY(20)', rect({}))
    const skewedLeaf = skewed.children[0]!
    const skewedUnit = group('', skewed)
    svgRoot(skewedUnit)
    const [skewedDescriptor] = collectGroupLeafDescriptors(asElement(skewed))
    expect(skewedDescriptor).toBeDefined()
    const ctm = documentCtmForLeaf(skewedDescriptor!, undefined)
    const local = { x: 4, y: 6 }
    const moved = applyGroupMatrix(ctm, local.x, local.y)
    const back = documentPointToLeafLocal(skewedDescriptor!, undefined, moved)
    expect(Math.abs(back.x - local.x)).toBeLessThan(1e-9)
    expect(Math.abs(back.y - local.y)).toBeLessThan(1e-9)
    void skewedLeaf
    void skewedUnit
  })
})

// ---------------------------------------------------------------------------
// Reshape-facing mapping: skewed ancestors must round-trip exactly.
// ---------------------------------------------------------------------------

describe('reshape mapping under skew', () => {
  it('world/inverse round-trips through skewed ancestors', () => {
    const rand = mulberry32(99)
    for (let i = 0; i < 100; i++) {
      const outerText = randomTransformText(rand, 2)
      const outer = transformMatrix(outerText) ?? ([...IDENTITY] as Mat)
      if (Math.abs(outer[0] * outer[3] - outer[1] * outer[2]) < 1e-6) continue
      const leaf = rect({})
      const parent = group(outerText, leaf)
      svgRoot(parent)
      const world = worldTransformMatrix(asElement(leaf))!
      const local = { x: rand() * 40 - 20, y: rand() * 40 - 20 }
      const docPoint = transformVectorPoint(world, local.x, local.y)
      const back = transformVectorPoint(invertVectorMatrix(world), docPoint.x, docPoint.y)
      expect(Math.abs(back.x - local.x)).toBeLessThan(1e-6)
      expect(Math.abs(back.y - local.y)).toBeLessThan(1e-6)
    }
  })

  it('moveVectorEditablePoint lands on the document target under a skew ancestor', () => {
    // Rect corner (10,10), ancestor skewX(45): document position is (20,10).
    const leaf = rect({ x: '10', y: '10', width: '20', height: '5' })
    const parent = group('skewX(45)', leaf)
    svgRoot(parent)
    // Drag document point (20,10) to (30,15): local target is (15,15), so the
    // rect moves its top-left corner there (bottom stays at 15, height clamps
    // to the 1px minimum).
    moveVectorEditablePoint(asElement(leaf), 0, 30, 15)
    expect(leaf.getAttribute('x')).toBe('15')
    expect(leaf.getAttribute('y')).toBe('15')
    expect(leaf.getAttribute('width')).toBe('15')
    expect(leaf.getAttribute('height')).toBe('1')
  })

  it('skew ancestors compose across nesting levels identically in both parsers', () => {
    const leaf = rect({})
    const mid = group('skewY(20) scale(1.5)', leaf)
    const top = group('translate(-4 2.5e1) skewX(-10)', mid)
    svgRoot(top)
    const vector = worldTransformMatrix(asElement(leaf))!
    const groupedLeaves = collectGroupLeafDescriptors(asElement(top))
    expect(groupedLeaves.length).toBe(1)
    // The unit root's own transform is deliberately excluded from the leaf
    // CTM; document-space callers compose it via `composeUnitWorldMatrix`.
    const unitWorld = composeUnitWorldMatrix(top.getAttribute('transform'), undefined)
    const groupedCtm = documentCtmForLeaf(groupedLeaves[0]!, unitWorld)
    closeToMatrix(vector, groupedCtm, 1e-9)
  })
})
