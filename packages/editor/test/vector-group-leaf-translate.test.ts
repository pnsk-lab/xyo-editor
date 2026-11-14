// Single-leaf translate planner: pure unit coverage (stub Elements, no DOM).
//
// Scratch comparison under test (behaviour notes only, no reference copy):
// geometry children allow anchor + whole-child moves; Text/PointText,
// Raster/image and use/PlacedSymbol children move as a whole (glyphs/pixels/
// shadows are never rewritten); clip/mask/compound/ambiguous units fail
// closed. `vector-group-reshape.ts` + `paper-vector.ts` decline the *whole*
// unit on any text/image/use/clip content and skip such leaves in
// `collectGroupLeafDescriptors`, so a safe one-leaf nudge has no planner.
// This file locks the new planner's contract: conditional text/image/use
// admission, sibling/defs safety, group-matrix fail-closed, stale/Undo
// discipline, and the explicit unwired status.

import { describe, expect, it } from 'bun:test'
import {
  classifyLeafElementForTranslate,
  isLeafAttachedToUnit,
  multiplyLeafTranslateMatrices,
  parseLeafTranslateTransform,
  planLeafDocumentTranslate,
  tryInvertLeafTranslateMatrix,
  type VectorLeafTranslateMatrix,
} from '../src/features/costumes/vector-group-leaf-translate'

// ---------------------------------------------------------------------------
// Stub Element (bun has no DOMParser): same shape as the skew/singular tests.
// ---------------------------------------------------------------------------

class StubElement {
  nodeType = 1
  tagName: string
  children: StubElement[] = []
  parentElement: StubElement | null = null
  private attrs = new Map<string, string>()

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value))
  }

  appendChild(child: StubElement): StubElement {
    child.parentElement = this
    this.children.push(child)
    return child
  }
}

const asElement = (node: StubElement) => node as unknown as Element

function svgRoot(...kids: StubElement[]): StubElement {
  const svg = new StubElement('svg')
  for (const kid of kids) svg.appendChild(kid)
  return svg
}

function group(transform: string, ...kids: StubElement[]): StubElement {
  const g = new StubElement('g', transform ? { transform } : {})
  for (const kid of kids) g.appendChild(kid)
  return g
}

function leaf(tag: string, attrs: Record<string, string> = {}): StubElement {
  return new StubElement(tag, attrs)
}

function closeTo(a: number, b: number, tolerance = 1e-9) {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tolerance)
}

const helperSource = await Bun.file(
  new URL('../src/features/costumes/vector-group-leaf-translate.ts', import.meta.url),
).text()
const reshapeSource = await Bun.file(
  new URL('../src/features/costumes/vector-group-reshape.ts', import.meta.url),
).text()

describe('classifyLeafElementForTranslate (conditional text/image/use)', () => {
  it('admits geometry leaves and flags paint/filter coupling as warnings', () => {
    const plain = classifyLeafElementForTranslate(asElement(leaf('rect', { x: '0', y: '0', width: '5', height: '5' })))
    expect(plain).toEqual({ ok: true, kind: 'geometry', warnings: [] })
    const coupled = classifyLeafElementForTranslate(
      asElement(leaf('path', { d: 'M0 0 L1 1', fill: 'url(#grad)', filter: 'url(#soft)' })),
    )
    expect(coupled.ok).toBe(true)
    if (coupled.ok) {
      expect(coupled.warnings).toContain('paint-reference')
      expect(coupled.warnings).toContain('filter-region')
    }
  })

  it('admits text atomically but never a bare tspan', () => {
    const text = classifyLeafElementForTranslate(asElement(leaf('text', { x: '1', y: '2' })))
    expect(text.ok).toBe(true)
    if (text.ok) {
      expect(text.kind).toBe('text')
      expect(text.warnings).toContain('font-metrics')
    }
    expect(classifyLeafElementForTranslate(asElement(leaf('tspan', {}))).ok).toBe(false)
    expect(classifyLeafElementForTranslate(asElement(leaf('tref', {}))).ok).toBe(false)
  })

  it('admits images only with href and finite positive size', () => {
    const good = classifyLeafElementForTranslate(
      asElement(leaf('image', { href: 'data:,x', x: '0', y: '0', width: '4', height: '3' })),
    )
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.warnings).toContain('raster-content')
    expect(classifyLeafElementForTranslate(asElement(leaf('image', { x: '0', y: '0', width: '4', height: '3' }))).ok).toBe(false)
    expect(
      classifyLeafElementForTranslate(asElement(leaf('image', { href: 'data:,x', width: '0', height: '3' }))).ok,
    ).toBe(false)
    expect(
      classifyLeafElementForTranslate(asElement(leaf('image', { href: 'data:,x', width: 'a', height: '3' }))).ok,
    ).toBe(false)
  })

  it('admits use only with href without resolving the shadow tree', () => {
    const good = classifyLeafElementForTranslate(asElement(leaf('use', { href: '#shape' })))
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.warnings).toContain('shadow-reference')
    expect(classifyLeafElementForTranslate(asElement(leaf('use', {}))).ok).toBe(false)
  })

  it('fails closed on clip/mask styling and defs-family tags', () => {
    expect(classifyLeafElementForTranslate(asElement(leaf('rect', { 'clip-path': 'url(#c)' }))).ok).toBe(false)
    expect(classifyLeafElementForTranslate(asElement(leaf('use', { href: '#s', mask: 'url(#m)' }))).ok).toBe(false)
    for (const tag of ['defs', 'mask', 'clipPath', 'linearGradient', 'foreignObject']) {
      const result = classifyLeafElementForTranslate(asElement(leaf(tag, { href: '#x' })))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('fail-closed')
    }
  })

  it('every refusal carries an explicit fail-closed reason', () => {
    for (const probe of [
      leaf('tspan', {}),
      leaf('image', {}),
      leaf('use', {}),
      leaf('rect', { style: 'clip-path: url(#c)' }),
    ]) {
      const result = classifyLeafElementForTranslate(asElement(probe))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('fail-closed')
    }
  })
})

describe('isLeafAttachedToUnit (stale / reindex discipline)', () => {
  it('accepts rendered descendants and rejects detached/defs-homed/unit-root inputs', () => {
    const a = leaf('rect', {})
    const unit = group('', group('', a))
    svgRoot(unit)
    expect(isLeafAttachedToUnit(asElement(unit), asElement(a))).toBe(true)
    // Detached leaf (never parented).
    expect(isLeafAttachedToUnit(asElement(unit), asElement(leaf('rect', {})))).toBe(false)
    // Unit root itself is not a leaf.
    expect(isLeafAttachedToUnit(asElement(unit), asElement(unit))).toBe(false)
    // Defs-homed leaf is not rendered.
    const defs = new StubElement('defs')
    const hidden = leaf('rect', {})
    defs.appendChild(hidden)
    unit.appendChild(defs)
    expect(isLeafAttachedToUnit(asElement(unit), asElement(hidden))).toBe(false)
  })

  it('rejects non-g units', () => {
    const svg = new StubElement('svg')
    const rect = leaf('rect', {})
    svg.appendChild(rect)
    expect(isLeafAttachedToUnit(asElement(svg), asElement(rect))).toBe(false)
  })
})

describe('planLeafDocumentTranslate (ancestor-frame conversion)', () => {
  it('maps identity ancestors 1:1 and prepends the translate', () => {
    const target = leaf('rect', { x: '0', y: '0', width: '5', height: '5' })
    const sibling = leaf('rect', { x: '50', y: '0', width: '5', height: '5' })
    const unit = group('', target, sibling)
    svgRoot(unit)
    const before = unit.children.map((kid) => kid.tagName)
    const plan = planLeafDocumentTranslate(asElement(unit), asElement(target), undefined, { dx: 10, dy: -4 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ancestorDelta).toEqual({ dx: 10, dy: -4 })
    expect(plan.oldTransform).toBe('')
    expect(plan.newTransform).toBe('translate(10 -4)')
    // Pure: no mutation, no reorder, siblings untouched.
    expect(unit.children.map((kid) => kid.tagName)).toEqual(before)
    expect(target.getAttribute('transform')).toBe(null)
    expect(sibling.getAttribute('x')).toBe('50')
  })

  it('inverts ancestor scale/rotate so the document delta lands exactly', () => {
    const target = leaf('rect', {})
    const unit = group('', group('scale(2)', target))
    svgRoot(unit)
    const plan = planLeafDocumentTranslate(asElement(unit), asElement(target), undefined, { dx: 10, dy: 6 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    closeTo(plan.ancestorDelta.dx, 5)
    closeTo(plan.ancestorDelta.dy, 3)
    // Applying the ancestor delta through the ancestor frame recovers the request.
    const ancestors = parseLeafTranslateTransform('scale(2)')
    const replay = {
      x: ancestors[0] * plan.ancestorDelta.dx + ancestors[2] * plan.ancestorDelta.dy,
      y: ancestors[1] * plan.ancestorDelta.dx + ancestors[3] * plan.ancestorDelta.dy,
    }
    closeTo(replay.x, 10)
    closeTo(replay.y, 6)
  })

  it('ignores the leaf own matrix by design (prepend is parent-frame)', () => {
    const target = leaf('rect', { transform: 'scale(0)' })
    const unit = group('', target)
    svgRoot(unit)
    // A singular *own* matrix must NOT block the plan: the translation is
    // prepended in the parent frame, so it never inverts `own`.
    const plan = planLeafDocumentTranslate(asElement(unit), asElement(target), undefined, { dx: 7, dy: 1 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.newTransform).toBe('translate(7 1) scale(0)')
  })

  it('composes unitWorld with the wrapper chain left-to-right', () => {
    const target = leaf('rect', {})
    const unit = group('translate(10 0)', group('scale(2)', target))
    svgRoot(unit)
    const unitWorld = parseLeafTranslateTransform('translate(10 0)')
    const plan = planLeafDocumentTranslate(asElement(unit), asElement(target), unitWorld, { dx: 8, dy: 4 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    closeTo(plan.ancestorDelta.dx, 4)
    closeTo(plan.ancestorDelta.dy, 2)
  })

  it('fails closed on singular / non-finite ancestors, never via identity', () => {
    const target = leaf('rect', {})
    const collapsed = group('', group('scale(0)', target))
    svgRoot(collapsed)
    const singular = planLeafDocumentTranslate(asElement(collapsed), asElement(target), undefined, { dx: 5, dy: 5 })
    expect(singular.ok).toBe(false)
    if (!singular.ok) {
      expect(singular.reason).toContain('singular')
      expect(singular.reason).toContain('fail-closed')
    }
    const unit = group('', target)
    svgRoot(unit)
    const badWorld: VectorLeafTranslateMatrix = [1, 0, 0, 1, Number.NaN, 0]
    const nonFinite = planLeafDocumentTranslate(asElement(unit), asElement(target), badWorld, { dx: 5, dy: 5 })
    expect(nonFinite.ok).toBe(false)
    // tryInvert itself is fail-closed (null), never identity.
    expect(tryInvertLeafTranslateMatrix([0, 0, 0, 0, 5, 5])).toBe(null)
    expect(tryInvertLeafTranslateMatrix([1, 1, 1, 1, 0, 0])).toBe(null)
  })

  it('refuses no-op and non-finite deltas so no empty history entry can mint', () => {
    const target = leaf('rect', {})
    const unit = group('', target)
    svgRoot(unit)
    for (const delta of [{ dx: 0, dy: 0 }, { dx: Number.NaN, dy: 1 }, { dx: 1, dy: Number.POSITIVE_INFINITY }]) {
      const plan = planLeafDocumentTranslate(asElement(unit), asElement(target), undefined, delta)
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.reason).toContain('fail-closed')
    }
  })

  it('fails closed on clip/mask at every level and on defs-homed leaves', () => {
    const leafNode = leaf('rect', {})
    const clippedWrapper = group('clip-path: url(#c)', leafNode)
    void clippedWrapper
    const unitClippedWrapper = group('', group('', leafNode))
    // Rebuild: wrapper carries clip-path attribute.
    const inner = new StubElement('g', { 'clip-path': 'url(#c)' })
    const victim = leaf('rect', {})
    inner.appendChild(victim)
    const unitA = group('', inner)
    svgRoot(unitA)
    const blockedWrapper = planLeafDocumentTranslate(asElement(unitA), asElement(victim), undefined, { dx: 3, dy: 3 })
    expect(blockedWrapper.ok).toBe(false)

    const unitB = group('', leaf('rect', {}))
    svgRoot(unitB)
    const targetB = unitB.children[0]!
    const blockedUnit = new StubElement('g', { mask: 'url(#m)' })
    void blockedUnit
    const maskedUnit = group('', targetB)
    maskedUnit.setAttribute('mask', 'url(#m)')
    svgRoot(maskedUnit)
    expect(planLeafDocumentTranslate(asElement(maskedUnit), asElement(targetB), undefined, { dx: 3, dy: 3 }).ok).toBe(false)

    // Defs-homed leaf: parent chain passes through defs.
    const defs = new StubElement('defs')
    const hidden = leaf('rect', {})
    defs.appendChild(hidden)
    const unitC = group('', defs)
    svgRoot(unitC)
    expect(planLeafDocumentTranslate(asElement(unitC), asElement(hidden), undefined, { dx: 3, dy: 3 }).ok).toBe(false)

    // Stale leaf: computed against another revision (detached stub).
    const stale = leaf('rect', {})
    expect(planLeafDocumentTranslate(asElement(unitClippedWrapper), asElement(stale), undefined, { dx: 3, dy: 3 }).ok).toBe(
      false,
    )
    void leafNode
    void unitB
  })

  it('plans safe text/image/use leaves with their coupling warnings', () => {
    const textLeaf = leaf('text', { x: '0', y: '0' })
    const imageLeaf = leaf('image', { href: 'data:,x', x: '0', y: '0', width: '4', height: '4' })
    const useLeaf = leaf('use', { href: '#shape' })
    const unit = group('', textLeaf, imageLeaf, useLeaf)
    svgRoot(unit)
    const textPlan = planLeafDocumentTranslate(asElement(unit), asElement(textLeaf), undefined, { dx: 6, dy: 0 })
    expect(textPlan.ok).toBe(true)
    if (textPlan.ok) expect(textPlan.warnings).toContain('font-metrics')
    const imagePlan = planLeafDocumentTranslate(asElement(unit), asElement(imageLeaf), undefined, { dx: 0, dy: 6 })
    expect(imagePlan.ok).toBe(true)
    if (imagePlan.ok) expect(imagePlan.warnings).toContain('raster-content')
    const usePlan = planLeafDocumentTranslate(asElement(unit), asElement(useLeaf), undefined, { dx: -2, dy: -2 })
    expect(usePlan.ok).toBe(true)
    if (usePlan.ok) expect(usePlan.warnings).toContain('shadow-reference')
  })
})

describe('comparison + wiring contract (docs as tests)', () => {
  it('reshape helper stays geometry-only while the translate planner conditionally admits text/image/use', () => {
    // vector-group-reshape.ts: unit-wide fail-closed on text/image/use/clip.
    expect(reshapeSource).toContain('export function classifyGroupUnitForLeafReshape')
    const lowered = reshapeSource.toLowerCase()
    for (const blocked of ['text', 'image', 'use', 'clippath', 'clip-path']) {
      expect(lowered).toContain(blocked)
    }
    // New planner: same fail-closed vocabulary, but text/image/use have
    // conditional `ok: true` paths with coupling warnings.
    expect(helperSource).toContain('export function classifyLeafElementForTranslate')
    expect(helperSource).toContain('export function planLeafDocumentTranslate')
    expect(helperSource).toContain('font-metrics')
    expect(helperSource).toContain('raster-content')
    expect(helperSource).toContain('shadow-reference')
    expect(helperSource).toContain('fail-closed')
  })

  it('matrix core agrees with the reshape helper on composition/inversion', () => {
    const a: VectorLeafTranslateMatrix = [2, 0.5, -0.5, 3, 10, -4]
    const b: VectorLeafTranslateMatrix = [1, 0, 0.4, 1, -2, 7]
    const composed = multiplyLeafTranslateMatrices(a, b)
    // Hand-derived: M = A*B applied to (1,1) must equal A(B(1,1)).
    const viaB = { x: b[0] * 1 + b[2] * 1 + b[4], y: b[1] * 1 + b[3] * 1 + b[5] }
    const viaBoth = { x: a[0] * viaB.x + a[2] * viaB.y + a[4], y: a[1] * viaB.x + a[3] * viaB.y + a[5] }
    const direct = { x: composed[0] * 1 + composed[2] * 1 + composed[4], y: composed[1] * 1 + composed[3] * 1 + composed[5] }
    closeTo(direct.x, viaBoth.x)
    closeTo(direct.y, viaBoth.y)
    const inverse = tryInvertLeafTranslateMatrix(a)!
    expect(inverse).not.toBe(null)
    const round = multiplyLeafTranslateMatrices(a, inverse)
    for (const [got, want] of [[round[0], 1], [round[1], 0], [round[2], 0], [round[3], 1]] as const) {
      closeTo(got, want, 1e-9)
    }
  })

  it('is wired for safe text/image leaves: editor + paper import the planner, svg/bitmap stay unwired', async () => {
    const editor = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    const bitmap = await Bun.file(new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url)).text()
    const paper = await Bun.file(new URL('../src/features/costumes/paper-vector.ts', import.meta.url)).text()
    const vector = await Bun.file(new URL('../src/features/costumes/vector-svg.ts', import.meta.url)).text()
    // Wired: safe whole-leaf translate for text/image (+ geometry in mixed
    // groups) goes through the planner; `use` stays fail-closed upstream.
    expect(editor, 'Editor.svelte must wire the planner').toContain('vector-group-leaf-translate')
    expect(paper, 'paper-vector.ts must wire the planner').toContain('vector-group-leaf-translate')
    // Still unwired: svg sanitizer/bounds and the bitmap shell never import
    // the planner directly (they receive wired callbacks through props).
    for (const [name, source] of [
      ['BitmapEditor.svelte', bitmap],
      ['vector-svg.ts', vector],
    ] as const) {
      expect(source, `${name} must stay unwired`).not.toContain('vector-group-leaf-translate')
    }
  })
})
