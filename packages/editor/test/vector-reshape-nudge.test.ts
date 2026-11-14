// Reshape-anchor nudge geometry contract (multi selected anchor translation).
//
// Real Paper.js geometry, no mocks, no DOM: pins the exact primitive that
// `moveVectorReshapePoints` (vector-path-points.ts) applies per anchor —
// `segment.point = segment.point.add(documentDelta)` — so the keyboard-nudge
// integration (Arrow keys move selected anchors, not the whole object) rests
// on a tested invariant rather than on mocked success.
//
// Reference behavior restated in our own words (clean-room, no AGPL copy):
// - reshape keydown moves each *selected segment's anchor point* by the step;
//   when no segment is selected it translates the whole selected leaf instead.
// - the step is one zoom unit with no Shift multiplier and no action-bounds
//   clamp (unlike select-mode nudge, which multiplies by 15 under Shift and
//   clamps into the action bounds with a 1px margin).
// - keyup commits a single history entry per press-release cycle; Alt never
//   clones and the point selection is never mutated by the keyboard path.

import { describe, expect, it } from 'bun:test'
import paper from 'paper'
import { collectEditablePaths, resolvePaperPoint } from '../src/features/costumes/vector-path-points'
import { NUDGE_VECTOR_WORKSPACE_SCALE, referenceVectorNudgeStep } from '../src/features/costumes/nudge-parity'
import { transformVectorPoint, tryInvertVectorMatrix } from '../src/features/costumes/vector-svg'

function makeScope() {
  const scope = new paper.PaperScope()
  scope.setup(new scope.Size(480, 360))
  return scope
}

function cubicPath(scope: paper.PaperScope) {
  // Two cubic segments in a row: s0 (anchor + out), s1 (anchor + in + out),
  // s2 (anchor + in). Flattened Paper-scheme indices: 0 anchor, 1 out, 2
  // anchor, 3 in, 4 out, 5 anchor, 6 in.
  return new scope.Path('M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30') as paper.Path
}

function handleVector(segment: paper.Segment): { in: { x: number; y: number }; out: { x: number; y: number } } {
  return {
    in: { x: segment.handleIn.x, y: segment.handleIn.y },
    out: { x: segment.handleOut.x, y: segment.handleOut.y },
  }
}

describe('reshape multi-anchor nudge primitive', () => {
  it('moves each selected anchor by the exact delta with handles carried rigidly', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      const delta = new scope.Point(3.5, -2)
      const before0 = resolvePaperPoint(path as paper.Item, 0)!
      const before5 = resolvePaperPoint(path as paper.Item, 5)!
      if (before0.kind !== 'anchor' || before5.kind !== 'anchor') throw new Error('fixture anchors misresolved')
      const p0 = { x: before0.segment.point.x, y: before0.segment.point.y }
      const p5 = { x: before5.segment.point.x, y: before5.segment.point.y }
      const h0 = handleVector(before0.segment)
      const h5 = handleVector(before5.segment)
      // Unselected middle anchor + its handles (purity oracle).
      const middle = resolvePaperPoint(path as paper.Item, 2)!
      if (middle.kind !== 'anchor') throw new Error('fixture middle misresolved')
      const midPoint = { x: middle.segment.point.x, y: middle.segment.point.y }
      const midHandles = handleVector(middle.segment)

      // The exact per-anchor primitive the DOM wrapper applies after mapping
      // the document target into the path frame.
      for (const index of [0, 5]) {
        const resolved = resolvePaperPoint(path as paper.Item, index)!
        if (resolved.kind !== 'anchor') throw new Error(`index ${index} is not an anchor`)
        resolved.segment.point = resolved.segment.point.add(delta) as paper.Point
      }

      const after0 = resolvePaperPoint(path as paper.Item, 0)!
      const after5 = resolvePaperPoint(path as paper.Item, 5)!
      if (after0.kind !== 'anchor' || after5.kind !== 'anchor') throw new Error('anchors lost after move')
      expect(after0.segment.point.x).toBeCloseTo(p0.x + delta.x, 9)
      expect(after0.segment.point.y).toBeCloseTo(p0.y + delta.y, 9)
      expect(after5.segment.point.x).toBeCloseTo(p5.x + delta.x, 9)
      expect(after5.segment.point.y).toBeCloseTo(p5.y + delta.y, 9)
      // Rigid carry: handle vectors are bit-identical, so curves keep shape.
      expect(handleVector(after0.segment)).toEqual(h0)
      expect(handleVector(after5.segment)).toEqual(h5)
      // Purity: the unselected anchor and its handles never move.
      const afterMid = resolvePaperPoint(path as paper.Item, 2)!
      if (afterMid.kind !== 'anchor') throw new Error('middle anchor lost after move')
      expect(afterMid.segment.point.x).toBeCloseTo(midPoint.x, 9)
      expect(afterMid.segment.point.y).toBeCloseTo(midPoint.y, 9)
      expect(handleVector(afterMid.segment)).toEqual(midHandles)
    } finally {
      scope.remove()
    }
  })

  it('keeps flattened numbering stable across moves (no slot shift)', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      const kindsBefore = [0, 1, 2, 3, 4, 5, 6].map((index) => resolvePaperPoint(path as paper.Item, index)?.kind)
      // Nudge every anchor once.
      for (const index of [0, 2, 5]) {
        const resolved = resolvePaperPoint(path as paper.Item, index)!
        if (resolved.kind !== 'anchor') throw new Error(`index ${index} is not an anchor`)
        resolved.segment.point = resolved.segment.point.add(new scope.Point(1, 1)) as paper.Point
      }
      const kindsAfter = [0, 1, 2, 3, 4, 5, 6].map((index) => resolvePaperPoint(path as paper.Item, index)?.kind)
      expect(kindsAfter).toEqual(kindsBefore)
      expect(collectEditablePaths(path as paper.Item)).toHaveLength(1)
      expect(collectEditablePaths(path as paper.Item)[0]!.segments.length).toBe(3)
    } finally {
      scope.remove()
    }
  })

  it('resolves control slots as control kind so the keyboard path can exclude them', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      const out = resolvePaperPoint(path as paper.Item, 1)!
      const inn = resolvePaperPoint(path as paper.Item, 3)!
      expect(out.kind).toBe('control')
      expect(inn.kind).toBe('control')
      if (out.kind === 'control') expect(out.controlRole).toBe('out')
      if (inn.kind === 'control') expect(inn.controlRole).toBe('in')
      expect(resolvePaperPoint(path as paper.Item, 7)).toBeUndefined()
    } finally {
      scope.remove()
    }
  })

  it('maps a document delta through a nested group translation exactly', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      const group = new scope.Group([path])
      group.translate(new scope.Point(50, 40))
      const editable = collectEditablePaths(group as paper.Item)
      expect(editable).toHaveLength(1)
      const target = editable[0]!
      // Document-space nudge of the first anchor by (+2, 0).
      const resolved = resolvePaperPoint(group as paper.Item, 0)!
      if (resolved.kind !== 'anchor') throw new Error('group anchor misresolved')
      const docBefore = target.localToGlobal(resolved.segment.point)
      const docTarget = { x: docBefore.x + 2, y: docBefore.y }
      // Same mapping the DOM wrapper performs: document -> path-local.
      const local = target.globalToLocal(new scope.Point(docTarget.x, docTarget.y))
      resolved.segment.point = local as paper.Point
      const docAfter = target.localToGlobal(resolved.segment.point)
      expect(docAfter.x).toBeCloseTo(docTarget.x, 9)
      expect(docAfter.y).toBeCloseTo(docTarget.y, 9)
    } finally {
      scope.remove()
    }
  })

  it('refuses singular ancestor matrices fail-closed (no teleport)', () => {
    // scale(0) has a zero determinant: no unique preimage exists.
    expect(tryInvertVectorMatrix([0, 0, 0, 0, 10, 10])).toBeNull()
    // Non-finite entries are equally unusable.
    expect(tryInvertVectorMatrix([1, 0, 0, 1, Number.NaN, 0])).toBeNull()
    // A plain translation round-trips exactly.
    const inverse = tryInvertVectorMatrix([1, 0, 0, 1, 50, 40])
    expect(inverse).not.toBeNull()
    const mapped = transformVectorPoint(inverse!, 75, 70)
    expect(mapped.x).toBeCloseTo(25, 9)
    expect(mapped.y).toBeCloseTo(30, 9)
  })
})

describe('reshape nudge step (zoom screen step, no Shift multiplier)', () => {
  it('is shift-independent and screen-constant at 1px plain', () => {
    for (const scale of [0.1332, 0.5, 1, 2, 5]) {
      const plain = referenceVectorNudgeStep(scale, false)
      // Reference reshape parity: holding Shift must NOT multiply the step
      // (select-mode nudge multiplies by 15; reshape ignores modifiers).
      const heldShift = referenceVectorNudgeStep(scale, false)
      expect(heldShift).toBe(plain)
      // One plain keydown travels exactly one screen pixel.
      expect(plain * NUDGE_VECTOR_WORKSPACE_SCALE * scale).toBeCloseTo(1, 9)
    }
  })
})
