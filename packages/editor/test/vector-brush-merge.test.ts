import { describe, expect, it } from 'bun:test'
import paper from 'paper'
import {
  checkBrushElementForMerge,
  isBrushMergeOrderSafe,
  isMergeableBrushCandidate,
  normalizeBrushFill,
  paperItemsTouch,
  tryUniteBrushItems,
} from '../src/features/costumes/vector-brush-merge'

type Attrs = Record<string, string>

function stubElement(tag: string, attrs: Attrs = {}, parent: unknown = null, childCount = 0) {
  return {
    tagName: tag,
    getAttribute: (name: string) => attrs[name] ?? null,
    parentNode: parent,
    children: { length: childCount },
  } as unknown as Element
}

function makeScope() {
  const scope = new paper.PaperScope()
  scope.setup(new scope.Size(480, 360))
  return scope
}

describe('normalizeBrushFill', () => {
  it('expands short hex and lowercases', () => {
    expect(normalizeBrushFill('#F00')).toBe('#ff0000')
    expect(normalizeBrushFill('  #FF0000 ')).toBe('#ff0000')
    expect(normalizeBrushFill('red')).toBe('red')
  })

  it('fails closed on gradients, none and transparency', () => {
    expect(normalizeBrushFill('url(#grad)')).toBeUndefined()
    expect(normalizeBrushFill('none')).toBeUndefined()
    expect(normalizeBrushFill('transparent')).toBeUndefined()
    expect(normalizeBrushFill(null)).toBeUndefined()
    expect(normalizeBrushFill('rgba(255,0,0,0.5)')).toBeUndefined()
    expect(normalizeBrushFill('#ff000080')).toBeUndefined()
  })
})

describe('isMergeableBrushCandidate', () => {
  it('accepts a same-color leaf shape under the same parent', () => {
    const parent = {}
    const brush = stubElement('path', { fill: '#ff0000' }, parent)
    const candidate = stubElement('path', { fill: '#FF0000', stroke: 'none' }, parent)
    expect(isMergeableBrushCandidate(candidate, brush, '#ff0000')).toEqual({ ok: true, reason: 'mergeable' })
  })

  it('refuses different fills, gradients, groups and non-shapes', () => {
    const parent = {}
    const brush = stubElement('path', { fill: '#ff0000' }, parent)
    expect(isMergeableBrushCandidate(stubElement('path', { fill: '#0000ff' }, parent), brush, '#ff0000').ok).toBe(false)
    expect(isMergeableBrushCandidate(stubElement('path', { fill: 'url(#g)' }, parent), brush, '#ff0000')).toEqual({
      ok: false,
      reason: 'gradient',
    })
    expect(isMergeableBrushCandidate(stubElement('g', { fill: '#ff0000' }, parent), brush, '#ff0000')).toEqual({
      ok: false,
      reason: 'group',
    })
    expect(isMergeableBrushCandidate(stubElement('text', { fill: '#ff0000' }, parent), brush, '#ff0000')).toEqual({
      ok: false,
      reason: 'non-shape',
    })
    expect(isMergeableBrushCandidate(stubElement('image', { fill: '#ff0000' }, parent), brush, '#ff0000').ok).toBe(
      false,
    )
  })

  it('keeps transparency, strokes, clips and cross-parent shapes untouched', () => {
    const parent = {}
    const otherParent = {}
    const brush = stubElement('path', { fill: '#ff0000' }, parent)
    expect(
      isMergeableBrushCandidate(stubElement('path', { fill: '#ff0000', opacity: '0.5' }, parent), brush, '#ff0000'),
    ).toEqual({ ok: false, reason: 'transparent' })
    expect(
      isMergeableBrushCandidate(
        stubElement('path', { fill: '#ff0000', stroke: '#000000', 'stroke-width': '2' }, parent),
        brush,
        '#ff0000',
      ),
    ).toEqual({ ok: false, reason: 'visible-stroke' })
    expect(
      isMergeableBrushCandidate(stubElement('path', { fill: '#ff0000', 'clip-path': 'url(#c)' }, parent), brush, '#ff0000'),
    ).toEqual({ ok: false, reason: 'clip-or-mask' })
    expect(
      isMergeableBrushCandidate(stubElement('path', { fill: '#ff0000' }, otherParent), brush, '#ff0000'),
    ).toEqual({ ok: false, reason: 'different-parent' })
  })

  it('refuses nested children so groups are never flattened', () => {
    const parent = {}
    const brush = stubElement('path', { fill: '#ff0000' }, parent)
    expect(
      isMergeableBrushCandidate(stubElement('path', { fill: '#ff0000' }, parent, 2), brush, '#ff0000'),
    ).toEqual({ ok: false, reason: 'has-children' })
  })
})

describe('checkBrushElementForMerge', () => {
  it('refuses gradient and transparent brushes', () => {
    const parent = {}
    expect(checkBrushElementForMerge(stubElement('path', { fill: 'url(#g)' }, parent)).ok).toBe(false)
    expect(checkBrushElementForMerge(stubElement('path', { fill: '#ff0000', opacity: '0' }, parent))).toEqual({
      ok: false,
      reason: 'transparent',
    })
    expect(checkBrushElementForMerge(stubElement('path', { fill: '#ff0000' }, parent))).toEqual({
      ok: true,
      reason: 'mergeable',
    })
  })
})

describe('isBrushMergeOrderSafe', () => {
  it('allows merges with no overlapping blocker between', () => {
    expect(isBrushMergeOrderSafe(3, [0, 2], () => false)).toBe(true)
    expect(isBrushMergeOrderSafe(3, [], () => true)).toBe(true)
  })

  it('refuses when an unrelated overlapping sibling sits between', () => {
    const blocker = (index: number) => index === 1
    expect(isBrushMergeOrderSafe(3, [0, 2], blocker)).toBe(false)
    // A blocker outside the merged span does not matter.
    expect(isBrushMergeOrderSafe(3, [2], blocker)).toBe(true)
  })
})

describe('paper boolean union for brush merging', () => {
  it('unites touching same-color shapes and skips far ones', () => {
    const scope = makeScope()
    try {
      const brush = new scope.Path.Rectangle({ point: [0, 0], size: [100, 100], fillColor: 'red' })
      const touching = new scope.Path.Rectangle({ point: [80, 0], size: [100, 100], fillColor: 'red' })
      const far = new scope.Path.Rectangle({ point: [300, 300], size: [20, 20], fillColor: 'red' })
      expect(paperItemsTouch(brush as paper.Item, touching as paper.Item)).toBe(true)
      expect(paperItemsTouch(brush as paper.Item, far as paper.Item)).toBe(false)

      const { united, skipped } = tryUniteBrushItems(brush as paper.Item, [touching as paper.Item, far as paper.Item])
      expect(skipped).toHaveLength(1)
      expect(skipped[0]).toBe(far as paper.Item)
      // 100x100 + 100x100 - 20x100 overlap = 18000.
      expect(Math.abs((united as paper.Path).area - 18000)).toBeLessThan(1)
      united.remove()
      far.remove()
    } finally {
      scope.remove()
    }
  })

  it('keeps both shapes when a boolean op fails instead of dropping art', () => {
    const scope = makeScope()
    try {
      const brush = new scope.Path.Rectangle({ point: [0, 0], size: [50, 50], fillColor: 'red' })
      // A degenerate zero-area candidate touches by bounds but cannot unite
      // cleanly; the helper must keep it in `skipped`.
      const far = new scope.Path.Rectangle({ point: [400, 300], size: [10, 10], fillColor: 'red' })
      const { united, skipped } = tryUniteBrushItems(brush as paper.Item, [far as paper.Item])
      expect(skipped).toContain(far as paper.Item)
      expect((united as paper.Path).area).toBeCloseTo(2500, 0)
      united.remove()
      far.remove()
    } finally {
      scope.remove()
    }
  })
})
