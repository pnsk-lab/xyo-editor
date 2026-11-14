// Strict fail-first regression for the first-anchor delete selection-remap bug.
//
// Flattened Paper scheme for the cubic fixture below (open, 3 anchors):
//   s0 anchor(0) + out(1); s1 anchor(2) + in(3) + out(4); s2 anchor(5) + in(6).
// Deleting the first anchor (0) removes its own slots {0,1} and clears the new
// open end's dangling incoming handle at old slot 3. The vanished set is the
// disjoint {0,1,3} with the surviving old anchor 2 between the ranges. The
// legacy contiguous report {index:0,slots:3} covers 0..2 and wrongly drops the
// survivor (old 2 -> should become new 0).
//
// Uses real Paper.js geometry (no DOM): the bulk DOM wrapper is covered by the
// companion browser suite; here the Paper core plus the pure remap helpers
// prove the exact old/new IDs.

import { describe, expect, it } from 'bun:test'
import paper from 'paper'
import { deletePaperPoint, resolvePaperPoint } from '../src/features/costumes/vector-path-points'
import {
  countFlattenedSlotsForAnchor,
  remapReshapeSelectionAfterBulkPreciseSlots,
  remapReshapeSelectionAfterBulkRanges,
  remapReshapeSelectionAfterPreciseSlots,
  remapReshapeSelectionAfterSlotDelete,
  normalizeReshapeSelection,
  type ReshapeSelectablePoint,
} from '../src/features/costumes/vector-multi-point-selection'

function makeScope() {
  const scope = new paper.PaperScope()
  scope.setup(new scope.Size(480, 360))
  return scope
}

function cubicPath(scope: paper.PaperScope) {
  return new scope.Path('M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30') as paper.Path
}

function flatKinds(item: paper.Item, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const r = resolvePaperPoint(item, i)
    if (!r) return 'missing'
    if (r.kind === 'anchor') return 'anchor'
    return `control:${(r as { controlRole: string }).controlRole}`
  })
}

describe('first-anchor delete vanished slots are disjoint', () => {
  it('open cubic: deleting 0 vanishes exactly {0,1,3}, survivor 2 lives', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      expect(flatKinds(path as paper.Item, 7)).toEqual([
        'anchor',
        'control:out',
        'anchor',
        'control:in',
        'control:out',
        'anchor',
        'control:in',
      ])
      // Own slots of anchor 0: anchor + out = 2. The re-aim clears the new
      // start's incoming handle (old slot 3).
      expect(deletePaperPoint(path as paper.Item, 0)).toBe(true)
      expect(path.segments.length).toBe(2)
      // New flattened: s1 anchor -> 0, s1 out (old 4) -> 1, s2 anchor (old 5)
      // -> 2, s2 in (old 6) -> 3.
      expect(flatKinds(path as paper.Item, 5)).toEqual([
        'anchor',
        'control:out',
        'anchor',
        'control:in',
        'missing',
      ])
      expect(resolvePaperPoint(path as paper.Item, 4)).toBeUndefined()
      // Exact old/new anchor IDs by position.
      expect([path.segments[0]!.point.x, path.segments[0]!.point.y]).toEqual([40, 30])
      expect([path.segments[1]!.point.x, path.segments[1]!.point.y]).toEqual([70, 30])
    } finally {
      scope.remove()
    }
  })

  it('fail-first: legacy contiguous {0,3} drops survivor 2, precise keeps 2->0', () => {
    const selection = [2, 4, 5, 6]
    // Legacy contiguous report: covers 0,1,2 -> survivor 2 wrongly dropped.
    expect(remapReshapeSelectionAfterSlotDelete(selection, 0, 3)).toEqual([1, 2, 3])
    // Precise disjoint set {0,1,3}: 2->0, 4->1, 5->2, 6->3.
    expect(remapReshapeSelectionAfterPreciseSlots(selection, [0, 1, 3])).toEqual([0, 1, 2, 3])
    // Disjoint ranges highest-first replay is also exact.
    expect(
      remapReshapeSelectionAfterBulkRanges(selection, [
        { index: 3, slots: 1 },
        { index: 0, slots: 2 },
      ]),
    ).toEqual([0, 1, 2, 3])
    expect(remapReshapeSelectionAfterBulkPreciseSlots(selection, [[0, 1, 3]])).toEqual([0, 1, 2, 3])
    // Control-slot-only selection is dropped in both, but legacy additionally
    // drops the live anchor.
    expect(remapReshapeSelectionAfterSlotDelete([2], 0, 3)).toEqual([])
    expect(remapReshapeSelectionAfterPreciseSlots([2], [0, 1, 3])).toEqual([0])
  })

  it('anchor+two handles: middle delete stays contiguous {2,3}', () => {
    // Deleting middle anchor 2 removes {2,3,4} (anchor+in+out), no clearing.
    expect(remapReshapeSelectionAfterPreciseSlots([0, 2, 5], [2, 3, 4])).toEqual([0, 2])
    expect(remapReshapeSelectionAfterSlotDelete([0, 2, 5], 2, 3)).toEqual([0, 2])
  })

  it('neighboring handle clearing below stays contiguous {4,3}', () => {
    // Deleting last anchor 5 removes {5,6} plus cleared below slot 4.
    expect(remapReshapeSelectionAfterPreciseSlots([7, 8, 9], [4, 5, 6])).toEqual([4, 5, 6])
    expect(remapReshapeSelectionAfterSlotDelete([7, 8, 9], 4, 3)).toEqual([4, 5, 6])
  })

  it('closed wrapping: deleting first anchor clears the wrap handle above', () => {
    const scope = makeScope()
    try {
      const loop = cubicPath(scope)
      loop.add(new scope.Point(100, 30))
      loop.closed = true
      // Positional end rule: no segment precedes index 0, so the surviving
      // first segment loses its incoming (wrap) handle.
      expect(deletePaperPoint(loop as paper.Item, 0)).toBe(true)
      expect(loop.segments.length).toBe(3)
      expect(loop.closed).toBe(true)
      expect((loop.segments[0]!.handleIn as paper.Point).length).toBe(0)
      expect(loop.pathData).not.toContain('NaN')
    } finally {
      scope.remove()
    }
  })

  it('multi delete descending: higher removal never disturbs lower indices', () => {
    // Two-path flattened: pathA cubic 0..6, pathB straight 7..9. Delete pathB
    // middle (8, one slot) then pathA last (5, {4,5,6} contiguous below-case).
    // Descending precise replay keeps pathB survivors exact.
    const first: readonly number[] = [4, 5, 6]
    const second: readonly number[] = [8]
    // Apply highest first: [7,8,9] with {8} -> [7,8] in intermediate numbering
    // (old 9 shifts to 8); then {4,5,6} -> [4,5].
    let next = remapReshapeSelectionAfterPreciseSlots([7, 8, 9], second)
    expect(next).toEqual([7, 8])
    next = remapReshapeSelectionAfterPreciseSlots(next, first)
    expect(next).toEqual([4, 5])
    expect(remapReshapeSelectionAfterBulkPreciseSlots([7, 8, 9], [second, first])).toEqual([4, 5])
  })

  it('count helper counts own slots only; out-of-bounds falls back to 1', () => {
    const points: ReshapeSelectablePoint[] = [
      { index: 0, x: 0, y: 0, kind: 'anchor' },
      { index: 1, x: 5, y: 0, kind: 'control', controlRole: 'out', relatedAnchorIndex: 0 },
      { index: 2, x: 10, y: 0, kind: 'anchor' },
      { index: 3, x: 8, y: -2, kind: 'control', controlRole: 'in', relatedAnchorIndex: 2 },
      { index: 4, x: 12, y: 2, kind: 'control', controlRole: 'out', relatedAnchorIndex: 2 },
      { index: 5, x: 20, y: 0, kind: 'anchor' },
      { index: 6, x: 18, y: -2, kind: 'control', controlRole: 'in', relatedAnchorIndex: 5 },
    ]
    expect(countFlattenedSlotsForAnchor(points, 2)).toBe(3)
    expect(countFlattenedSlotsForAnchor(points, 0)).toBe(2)
    expect(countFlattenedSlotsForAnchor(points, 5)).toBe(2)
    expect(countFlattenedSlotsForAnchor(points, 99)).toBe(1)
    // Reshape selection control: control slots are never live anchors, and a
    // non-integer / negative deletion is a normalizing no-op.
    expect(normalizeReshapeSelection([2, 1, 5])).toEqual([1, 2, 5])
    expect(remapReshapeSelectionAfterSlotDelete([0, 1, 2], -1, 3)).toEqual([0, 1, 2])
    expect(remapReshapeSelectionAfterPreciseSlots([0, 1, 2], [])).toEqual([0, 1, 2])
  })
})
