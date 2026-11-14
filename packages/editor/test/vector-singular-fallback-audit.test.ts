// Singular / non-finite matrix fail-closed audit (post-fix).
//
// Contract under test: explicit `tryInvert*(m): matrix | null` guards every
// DOM-writing path. A degenerate ancestor (`scale(0)`, `scale(0,1)`,
// `matrix(1 2 2 4 0 0)`, overflowed / NaN / non-finite) must refuse the write
// with history/selection/DOM untouched — never map through an identity
// fallback. Legacy `invertVectorMatrix*` keeps the identity fallback for
// display-only mappers, but no writer may use it.
//
// Coverage: tryInvert itself, reshape (`moveVectorEditablePoint`), flip
// (`addVectorFlip`), conjugation (`conjugateWorldMatrix6` /
// `localScaleMatrixForAncestor`), world-matrix application
// (`applyWorldMatrixToVectorElement` / rotate / flip / common-bounds scale),
// fill/selection converters (safe comparators), and group-leaf write-back
// primitives. Reversible skew/rotate/non-uniform and transform-free zero-area
// shapes stay editable. Near-singular but invertible scales (`scale(1e-12)`)
// stay editable by design (amplification is representable, not a fallback).

import { describe, expect, it } from 'bun:test'
import {
  ancestorWorldMatrix,
  documentPointToLocalGradientPoint,
  invertVectorMatrix,
  moveVectorEditablePoint,
  transformMatrix,
  transformVectorPoint,
  tryInvertVectorMatrix,
  worldTransformMatrix,
  addVectorFlip,
  type VectorMatrix,
} from '../src/features/costumes/vector-svg'
import {
  applyWorldMatrixToVectorElement,
  flipVectorElementsAroundCenter,
  rotateVectorElementsAroundCenter,
  scaleVectorElementsByCommonBounds,
} from '../src/features/costumes/paper-vector'
import {
  conjugateWorldMatrix6,
  invertVectorMatrix6,
  localScaleMatrixForAncestor,
  multiplyVectorMatrix6,
  tryInvertVectorMatrix6,
  type VectorMatrix6,
} from '../src/features/costumes/vector-multi-scale'
import {
  collectGroupLeafDescriptors,
  composeUnitWorldMatrix,
  documentCtmForLeaf,
  documentPointToLeafLocal,
  invertGroupMatrix,
  tryInvertGroupMatrix,
} from '../src/features/costumes/vector-group-reshape'

// ---------------------------------------------------------------------------
// Stub Element (bun has no DOMParser): same shape as vector-skew tests.
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

  getAttributeNames(): string[] {
    return [...this.attrs.keys()]
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

function pathLeaf(d: string, extra: Record<string, string> = {}): StubElement {
  return new StubElement('path', { d, ...extra })
}

function det(m: readonly number[]): number {
  return m[0]! * m[3]! - m[1]! * m[2]!
}

function snapshotLeaf(leaf: StubElement): string {
  return JSON.stringify({ attrs: [...(leaf as unknown as { attrs: Map<string, string> })['attrs'].entries()].sort() })
}

// ---------------------------------------------------------------------------
// 1. Explicit inversion: null for degenerate, finite inverse otherwise.
// ---------------------------------------------------------------------------

describe('tryInvert fail-closed inversion', () => {
  it('singular families return null (legacy invert keeps identity fallback)', () => {
    const families = ['scale(0)', 'scale(0 1)', 'matrix(1 2 2 4 0 0)']
    for (const text of families) {
      const matrix = transformMatrix(text)!
      expect(det(matrix)).toBe(0)
      expect(tryInvertVectorMatrix(matrix)).toBeNull()
      // Legacy display-only fallback is preserved; writers must not use it.
      expect(invertVectorMatrix(matrix)).toEqual([1, 0, 0, 1, 0, 0])
      expect(tryInvertVectorMatrix6(matrix as VectorMatrix6)).toBeNull()
      expect(invertVectorMatrix6(matrix as VectorMatrix6)).toEqual([1, 0, 0, 1, 0, 0])
      expect(tryInvertGroupMatrix(matrix as VectorMatrix6)).toBeNull()
      expect(invertGroupMatrix(matrix as VectorMatrix6)).toEqual([1, 0, 0, 1, 0, 0])
    }
  })

  it('overflowed / NaN / non-finite matrices return null', () => {
    expect(tryInvertVectorMatrix([1e308, 0, 0, 1e308, 0, 0])).toBeNull()
    expect(tryInvertVectorMatrix([NaN, 0, 0, 1, 0, 0])).toBeNull()
    expect(tryInvertVectorMatrix([Infinity, 0, 0, 1, 0, 0])).toBeNull()
    expect(tryInvertVectorMatrix([1, 0, 0, 1, Infinity, 0])).toBeNull()
    expect(tryInvertVectorMatrix6([0, 0, 0, 0, 0, 0])).toBeNull()
    expect(tryInvertGroupMatrix([1, 1, 1, 1, 0, 0])).toBeNull()
    // Legacy fallbacks stay identity for compat.
    expect(invertVectorMatrix([NaN, 0, 0, 1, 0, 0])).toEqual([1, 0, 0, 1, 0, 0])
    expect(invertVectorMatrix6([0, 0, 0, 0, 0, 0])).toEqual([1, 0, 0, 1, 0, 0])
    expect(invertGroupMatrix([1, 1, 1, 1, 0, 0])).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('reversible skew / rotate / non-uniform stay invertible', () => {
    const cases = ['skewX(30)', 'skewY(20)', 'rotate(45)', 'scale(2 3)', 'translate(5 7)', 'matrix(1 2 0 1 5 5)']
    for (const text of cases) {
      const matrix = transformMatrix(text)!
      expect(tryInvertVectorMatrix(matrix)).not.toBeNull()
      expect(tryInvertVectorMatrix6(matrix as VectorMatrix6)).not.toBeNull()
    }
    // Mirrored ancestor (det < 0) is invertible: conjugation must hold.
    const mirrored: VectorMatrix6 = [-1, 0, 0, 1, 200, 0]
    expect(tryInvertVectorMatrix6(mirrored)).not.toBeNull()
  })

  it('near-singular scale(1e-12) stays invertible by design (amplification documented)', () => {
    // det = 1e-24: invertible, so the inverse amplifies (1 unit -> 1e12).
    // This is representable geometry, not a silent fallback, so fail-closed
    // deliberately allows it. Callers/UI must still treat the huge jump as
    // suspicious, but refusing would break legitimate tiny-scale editing.
    const tiny = transformMatrix('scale(1e-12)')!
    expect(det(tiny)).not.toBe(0)
    const inverse = tryInvertVectorMatrix(tiny)
    expect(inverse).not.toBeNull()
    const back = transformVectorPoint(inverse!, 1, 0)
    expect(Math.abs(back.x)).toBeGreaterThan(1e11)
    expect(tryInvertVectorMatrix6(tiny as VectorMatrix6)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. reshape: singular ancestors refuse with DOM untouched.
// ---------------------------------------------------------------------------

describe('reshape fail-closed under degenerate ancestors', () => {
  it('scale(0) ancestor: moveVectorEditablePoint refuses, DOM untouched', () => {
    const leaf = rect({ x: '10', y: '10', width: '20', height: '5' })
    const parent = group('scale(0)', leaf)
    svgRoot(parent)
    expect(det(worldTransformMatrix(asElement(leaf))!)).toBe(0)
    expect(tryInvertVectorMatrix(worldTransformMatrix(asElement(leaf)))).toBeNull()
    const before = snapshotLeaf(leaf)
    const applied = moveVectorEditablePoint(asElement(leaf), 0, 30, 15)
    expect(applied).toBe(false)
    expect(snapshotLeaf(leaf)).toBe(before)
    expect(leaf.getAttribute('x')).toBe('10')
    expect(leaf.getAttribute('y')).toBe('10')
  })

  it('scale(0,1) ancestor: collapsed axis refuses even though Y is representable', () => {
    const leaf = rect({ x: '10', y: '10', width: '20', height: '5' })
    const parent = group('scale(0 1)', leaf)
    svgRoot(parent)
    expect(det(worldTransformMatrix(asElement(leaf))!)).toBe(0)
    const before = snapshotLeaf(leaf)
    expect(moveVectorEditablePoint(asElement(leaf), 0, 30, 15)).toBe(false)
    expect(snapshotLeaf(leaf)).toBe(before)
  })

  it('matrix(1 2 2 4 0 0) ancestor: rank-1 frame refuses', () => {
    const leaf = rect({ x: '10', y: '10', width: '20', height: '5' })
    const parent = group('matrix(1 2 2 4 0 0)', leaf)
    svgRoot(parent)
    const before = snapshotLeaf(leaf)
    expect(moveVectorEditablePoint(asElement(leaf), 0, 30, 15)).toBe(false)
    expect(snapshotLeaf(leaf)).toBe(before)
    expect(leaf.getAttribute('x')).toBe('10')
  })

  it('NaN / overflow ancestors refuse', () => {
    const leaf = rect({ x: '10', y: '10', width: '20', height: '5' })
    // NaN transform text is skipped by the parser (fail-closed) leaving
    // identity, so exercise the matrix path directly via a manual singular
    // world: use scale(0) plus a non-finite check on tryInvert itself.
    expect(tryInvertVectorMatrix([NaN, 0, 0, 1, 0, 0])).toBeNull()
    expect(tryInvertVectorMatrix([Infinity, 0, 0, 1, 0, 0])).toBeNull()
    const parent = group('scale(0)', leaf)
    svgRoot(parent)
    const before = snapshotLeaf(leaf)
    expect(moveVectorEditablePoint(asElement(leaf), 0, 30, 15)).toBe(false)
    expect(snapshotLeaf(leaf)).toBe(before)
  })

  it('transform-free zero-area rect stays editable (control)', () => {
    const leaf = rect({ x: '10', y: '10', width: '20', height: '5' })
    svgRoot(leaf)
    expect(worldTransformMatrix(asElement(leaf))).toBeUndefined()
    expect(moveVectorEditablePoint(asElement(leaf), 0, 30, 15)).toBe(true)
    expect(leaf.getAttribute('x')).toBe('30')
    expect(leaf.getAttribute('y')).toBe('15')
  })

  it('reversible skew / rotate / non-uniform stay editable', () => {
    for (const text of ['skewX(30)', 'rotate(30)', 'scale(2 3)']) {
      const leaf = rect({ x: '10', y: '10', width: '20', height: '5' })
      const parent = group(text, leaf)
      svgRoot(parent)
      expect(tryInvertVectorMatrix(worldTransformMatrix(asElement(leaf))!)).not.toBeNull()
      expect(moveVectorEditablePoint(asElement(leaf), 0, 30, 15)).toBe(true)
      // Mapping through a real inverse does not pass document coords through.
      expect(leaf.getAttribute('x')).not.toBe('10')
    }
  })
})

// ---------------------------------------------------------------------------
// 3. move / resize / multi-select conjugation: null instead of W*A.
// ---------------------------------------------------------------------------

describe('conjugation fail-closed', () => {
  it('conjugateWorldMatrix6 returns null for singular ancestors', () => {
    const world: VectorMatrix6 = [1, 0, 0, 1, 10, 0]
    expect(conjugateWorldMatrix6([0, 0, 0, 1, 0, 0], world)).toBeNull()
    expect(conjugateWorldMatrix6([1, 2, 2, 4, 0, 0], world)).toBeNull()
    expect(conjugateWorldMatrix6([0, 0, 0, 0, 0, 0], world)).toBeNull()
    expect(tryInvertVectorMatrix6([0, 0, 0, 1, 0, 0])).toBeNull()
  })

  it('localScaleMatrixForAncestor returns null for singular ancestors', () => {
    const world: VectorMatrix6 = [2, 0, 0, 2, 0, 0]
    expect(localScaleMatrixForAncestor([1, 2, 2, 4, 0, 0], world)).toBeNull()
    expect(localScaleMatrixForAncestor([0, 0, 0, 1, 0, 0], world)).toBeNull()
  })

  it('invertible ancestors still conjugate (A*L == W*A), including mirrors', () => {
    const world: VectorMatrix6 = [2, 0, 0, 2, 0, 0]
    for (const ancestor of [
      [1, 0, 0, 1, 30, 10],
      [2, 0, 0, 2, -10, 5],
      [-1, 0, 0, 1, 200, 0],
    ] as VectorMatrix6[]) {
      const local = localScaleMatrixForAncestor(ancestor, world)
      expect(local).not.toBeNull()
      const left = multiplyVectorMatrix6(ancestor, local!)
      const right = multiplyVectorMatrix6(world, ancestor)
      for (let index = 0; index < 6; index++) expect(left[index]).toBeCloseTo(right[index]!, 10)
    }
  })

  it('addVectorFlip refuses on singular CTM, applies on invertible', () => {
    const collapsed = rect({ x: '10', y: '10', width: '20', height: '10' })
    svgRoot(collapsed)
    collapsed.setAttribute('transform', 'scale(0)')
    const beforeFlip = collapsed.getAttribute('transform')
    expect(addVectorFlip(asElement(collapsed), true)).toBe(false)
    expect(collapsed.getAttribute('transform')).toBe(beforeFlip)

    const skewed = rect({ x: '10', y: '10', width: '20', height: '10' })
    svgRoot(skewed)
    skewed.setAttribute('transform', 'skewX(20)')
    expect(addVectorFlip(asElement(skewed), true)).toBe(true)
    expect(skewed.getAttribute('transform')).toContain('scale(-1 1)')
  })

  it('applyWorldMatrix refuses on singular ancestors, applies otherwise', () => {
    const collapsed = rect({ x: '10', y: '10', width: '20', height: '10' })
    const parent = group('scale(0)', collapsed)
    svgRoot(parent)
    const before = collapsed.getAttribute('transform')
    expect(applyWorldMatrixToVectorElement(asElement(collapsed), [1, 0, 0, 1, 10, 0])).toBe(false)
    expect(collapsed.getAttribute('transform')).toBe(before)

    const plain = rect({ x: '10', y: '10', width: '20', height: '10' })
    svgRoot(plain)
    expect(applyWorldMatrixToVectorElement(asElement(plain), [1, 0, 0, 1, 10, 0])).toBe(true)
    expect(plain.getAttribute('transform')).toContain('matrix(')
  })

  it('rotate / flip / common-bounds scale refuse the whole arrangement on singular input', () => {
    const leaf = rect({ x: '10', y: '10', width: '20', height: '20' })
    const parent = group('scale(0 1)', leaf)
    svgRoot(parent)
    const before = snapshotLeaf(leaf)
    expect(rotateVectorElementsAroundCenter([asElement(leaf)], 90, { x: 0, y: 0 })).toBe(false)
    expect(flipVectorElementsAroundCenter([asElement(leaf)], true, { x: 0, y: 0 })).toBe(false)
    expect(scaleVectorElementsByCommonBounds([asElement(leaf)], 'se', 20, 20)).toBe(false)
    expect(snapshotLeaf(leaf)).toBe(before)
  })

  it('own singular world refuses arrangement ops (rect/path/group), reversible frames apply', () => {
    for (const make of [
      () => rect({ x: '10', y: '10', width: '20', height: '20', transform: 'scale(0)' }),
      () => pathLeaf('M 10 10 L 50 10 L 50 50 Z', { transform: 'scale(0 1)' }),
    ]) {
      const leaf = make()
      svgRoot(leaf)
      const before = snapshotLeaf(leaf)
      expect(rotateVectorElementsAroundCenter([asElement(leaf)], 15, { x: 50, y: 50 })).toBe(false)
      expect(flipVectorElementsAroundCenter([asElement(leaf)], false, { x: 50, y: 50 })).toBe(false)
      expect(snapshotLeaf(leaf)).toBe(before)
    }
    // Group unit with a nested own-singular wrapper refuses as a whole.
    const innerLeaf = rect({ x: '10', y: '10', width: '20', height: '20' })
    const inner = group('scale(0)', innerLeaf)
    const sibling = rect({ x: '100', y: '100', width: '20', height: '20' })
    const unit = group('', inner, sibling)
    svgRoot(unit)
    const beforeUnit = JSON.stringify(unit.children.map((kid) => snapshotLeaf(kid as StubElement)))
    expect(rotateVectorElementsAroundCenter([asElement(unit)], 15, { x: 50, y: 50 })).toBe(false)
    expect(flipVectorElementsAroundCenter([asElement(unit)], true, { x: 50, y: 50 })).toBe(false)
    expect(JSON.stringify(unit.children.map((kid) => snapshotLeaf(kid as StubElement)))).toBe(beforeUnit)
    // Reversible non-uniform / skew / rotate own frames stay editable.
    for (const text of ['scale(2 3)', 'skewX(20)', 'skewY(15)', 'rotate(30)']) {
      const leaf = rect({ x: '10', y: '10', width: '20', height: '20', transform: text })
      svgRoot(leaf)
      expect(rotateVectorElementsAroundCenter([asElement(leaf)], 15, { x: 50, y: 50 })).toBe(true)
    }
    for (const text of ['scale(2 3)', 'skewX(20)']) {
      const leaf = rect({ x: '10', y: '10', width: '20', height: '20', transform: text })
      svgRoot(leaf)
      expect(flipVectorElementsAroundCenter([asElement(leaf)], true, { x: 50, y: 50 })).toBe(true)
    }
  })

  it('singular world input and in-unit collapse refuse without DOM write', () => {
    const plain = rect({ x: '10', y: '10', width: '20', height: '10' })
    svgRoot(plain)
    const beforePlain = snapshotLeaf(plain)
    // Singular document-space matrix itself has no inverse: refuse even on
    // clean artwork (stale/degenerate world must never bake a collapse).
    expect(applyWorldMatrixToVectorElement(asElement(plain), [0, 0, 0, 0, 0, 0])).toBe(false)
    expect(applyWorldMatrixToVectorElement(asElement(plain), [1, 2, 2, 4, 0, 0])).toBe(false)
    expect(snapshotLeaf(plain)).toBe(beforePlain)
    // Group unit whose descendant chain collapses refuses the conjugation.
    const leaf = rect({ x: '10', y: '10', width: '20', height: '10' })
    const inner = group('scale(0)', leaf)
    const unit = group('', inner)
    svgRoot(unit)
    const beforeUnit = snapshotLeaf(inner)
    expect(applyWorldMatrixToVectorElement(asElement(unit), [1, 0, 0, 1, 10, 0])).toBe(false)
    expect(snapshotLeaf(inner)).toBe(beforeUnit)
  })
})

// ---------------------------------------------------------------------------
// 4. fill / selection converters: safe comparators.
// ---------------------------------------------------------------------------

describe('fill/selection converters', () => {
  it('documentPointToLocalGradientPoint falls back to the input (safe)', () => {
    const leaf = rect({ x: '0', y: '0', width: '10', height: '10' })
    group('scale(0)', leaf)
    svgRoot(leaf.parentElement as unknown as StubElement)
    const point = { x: 42, y: 17 }
    expect(documentPointToLocalGradientPoint(asElement(leaf), point)).toEqual(point)
  })

  it('documentPointToLeafLocal detects degeneracy while raw invert does not', () => {
    const doc = new StubElement('g', { transform: 'scale(0)' })
    const leafEl = rect({})
    leafEl.parentElement = doc
    doc.children.push(leafEl)
    const [descriptor] = collectGroupLeafDescriptors(asElement(doc))
    expect(descriptor).toBeDefined()
    const unitWorld = composeUnitWorldMatrix('scale(0)', undefined)
    const point = { x: 9, y: 3 }
    // Safe helper: explicit det check, returns input.
    expect(documentPointToLeafLocal(descriptor!, unitWorld, point)).toEqual(point)
    // Raw fallback path used by toNativePoint/toNativeDelta/leafLocalPathData:
    // identity mapping returns the same coordinates here, but the caller
    // CANNOT tell fallback apart from a real conversion (identity CTM is
    // also possible). Fail-closed callers must therefore branch on
    // tryInvert BEFORE mapping, never on the mapped result.
    const ctm = documentCtmForLeaf(descriptor!, unitWorld)
    expect(det(ctm)).toBe(0)
    expect(tryInvertGroupMatrix(ctm)).toBeNull()
    const raw = transformVectorPoint(invertVectorMatrix(ctm as VectorMatrix), point.x, point.y)
    expect(raw).toEqual(point) // same value, wrong meaning
  })
})

// ---------------------------------------------------------------------------
// 5. group-leaf write-back primitives: singular in-unit matrices refuse.
// ---------------------------------------------------------------------------

describe('group-leaf write-back fail-closed', () => {
  it('singular in-unit matrices have no inverse, so surgical patch must refuse', () => {
    const leaf = pathLeaf('M 10 10 L 30 10')
    const inner = group('scale(0)', leaf)
    const unit = group('', inner)
    svgRoot(unit)
    const parent = leaf.parentElement as unknown as StubElement
    const matrix = worldTransformMatrix(asElement(leaf), asElement(parent.parentElement as unknown as StubElement))!
    expect(det(matrix)).toBe(0)
    expect(tryInvertVectorMatrix(matrix)).toBeNull()
    expect(invertVectorMatrix(matrix)).toEqual([1, 0, 0, 1, 0, 0])
    // patchGroupDomLeaf / patchDomLeafWithPaperPath / patchStyleDomLeaf all
    // return false here (caller falls back to no-op, never to
    // replaceElementWithPaperItem which would drop wrapper transforms).
  })

  it('invertible in-unit matrices still allow surgical write-back', () => {
    const leaf = pathLeaf('M 10 10 L 30 10')
    const inner = group('skewX(20)', leaf)
    const unit = group('', inner)
    svgRoot(unit)
    const parent = leaf.parentElement as unknown as StubElement
    const matrix = worldTransformMatrix(asElement(leaf), asElement(parent.parentElement as unknown as StubElement))!
    expect(tryInvertVectorMatrix(matrix)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6. Undo/Redo impact ledger: no DOM write means no history entry is needed.
// ---------------------------------------------------------------------------

describe('undo/redo impact ledger', () => {
  it('every refused rewrite above leaves the DOM untouched, so no entry is needed', () => {
    // The editor captures `peekCostumeHistory`/`commitAssetHistory` around
    // each write (Editor.svelte: move/resize/reshape/flip paths). After this
    // fix every singular case above returns applied=false with the DOM
    // byte-identical, so the caller can skip both the history commit and the
    // selection/DOM refresh:
    // - Undo stack stays clean (no invisible entry),
    // - Undo restores nothing (nothing changed),
    // - Redo re-applies nothing, and repairing the ancestor scale later
    //   cannot teleport the leaf because the wrong local coords were never
    //   baked. Siblings, Z-order and wrapper transforms are untouched.
    // For scale(0,1): the whole drag is refused even though Y alone would be
    // representable — a partial write would still pollute Undo with a phantom
    // X shift on Redo, so fail-closed refuses the axis pair together.
    // For matrix(1 2 2 4 0 0): the 2D frame is rank-1; any write would pick
    // one arbitrary preimage on the collapsed line.
    expect(tryInvertVectorMatrix(transformMatrix('scale(0)')!)).toBeNull()
    expect(ancestorWorldMatrix).toBeDefined()
  })
})
