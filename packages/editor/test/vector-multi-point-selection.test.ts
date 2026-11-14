// Unit tests for the pure reshape multi-point selection helper.
// No DOM / Paper.js: fabricated flattened point lists are enough because the
// module only does index arithmetic and coordinate comparisons.

import { describe, expect, it } from 'bun:test'
import {
  countFlattenedSlotsForAnchor,
  isReshapeAnchorLive,
  mergeReshapeMarqueeSelection,
  moveReshapePoints,
  normalizeReshapeRect,
  normalizeReshapeSelection,
  rebaseReshapeSelectionByAnchorCoordinates,
  remapReshapeSelectionAfterAnchorDelete,
  remapReshapeSelectionAfterSlotDelete,
  reshapeBulkMoveTargets,
  reshapePointsInRect,
  toggleReshapePointSelection,
  type ReshapeSelectablePoint,
} from '../src/features/costumes/vector-multi-point-selection'

function anchor(index: number, x: number, y: number): ReshapeSelectablePoint {
  return { index, x, y, kind: 'anchor' }
}

function control(index: number, x: number, y: number, relatedAnchorIndex: number, controlRole: 'in' | 'out' = 'out'): ReshapeSelectablePoint {
  return { index, x, y, kind: 'control', controlRole, relatedAnchorIndex }
}

// Flattened layout: a0, a0/out, a1, a1/in, a1/out, a2, a2/in.
function samplePoints(): ReshapeSelectablePoint[] {
  return [
    anchor(0, 0, 0),
    control(1, 5, 0, 0),
    anchor(2, 10, 0),
    control(3, 8, -2, 2, 'in'),
    control(4, 12, 2, 2, 'out'),
    anchor(5, 20, 0),
    control(6, 18, -2, 5, 'in'),
  ]
}

describe('normalizeReshapeRect', () => {
  it('handles reversed drags', () => {
    expect(normalizeReshapeRect({ x: 10, y: 10, width: -8, height: -6 })).toEqual({
      left: 2,
      top: 4,
      right: 10,
      bottom: 10,
    })
  })

  it('yields an empty rect for non-finite input', () => {
    expect(reshapePointsInRect(samplePoints(), { x: NaN, y: 0, width: 10, height: 10 })).toEqual([])
  })
})

describe('reshapePointsInRect', () => {
  it('selects anchors inside, edges inclusive, controls excluded by default', () => {
    // Covers a0 (0,0) and a1 (10,0); controls at (5,0)/(8,-2)/(12,2) are inside but excluded.
    expect(reshapePointsInRect(samplePoints(), { x: -1, y: -1, width: 12, height: 2 })).toEqual([0, 2])
  })

  it('matches controls only when asked', () => {
    expect(
      reshapePointsInRect(samplePoints(), { x: -1, y: -1, width: 12, height: 2 }, { includeControl: true }),
    ).toEqual([0, 1, 2])
  })

  it('handles negative drag sizes', () => {
    expect(reshapePointsInRect(samplePoints(), { x: 11, y: 1, width: -12, height: -2 })).toEqual([0, 2])
  })
})

describe('toggle / merge selection', () => {
  it('plain click replaces, shift toggles', () => {
    expect(toggleReshapePointSelection([0, 2], 5, false)).toEqual([5])
    expect(toggleReshapePointSelection([0, 2], 5, true)).toEqual([0, 2, 5])
    expect(toggleReshapePointSelection([0, 2], 2, true)).toEqual([0])
  })

  it('marquee replace vs shift-toggle mirrors object marquee merge', () => {
    expect(mergeReshapeMarqueeSelection([0, 5], [2, 5], false)).toEqual([2, 5])
    // 5 is already selected so it is removed; 2 is added.
    expect(mergeReshapeMarqueeSelection([0, 5], [2, 5], true)).toEqual([0, 2])
    expect(mergeReshapeMarqueeSelection([0], [], true)).toEqual([0])
  })

  it('normalize drops junk and dedupes', () => {
    expect(normalizeReshapeSelection([5, 2, 2, -1, 1.5, NaN])).toEqual([2, 5])
    expect(isReshapeAnchorLive(samplePoints(), 2)).toBe(true)
    expect(isReshapeAnchorLive(samplePoints(), 1)).toBe(false)
    expect(isReshapeAnchorLive(samplePoints(), 99)).toBe(false)
  })
})

describe('delete remap', () => {
  it('counts the anchor slot plus trailing handles', () => {
    // a1 owns anchor 2 + in(3) + out(4).
    expect(countFlattenedSlotsForAnchor(samplePoints(), 2)).toBe(3)
    expect(countFlattenedSlotsForAnchor(samplePoints(), 0)).toBe(2)
    expect(countFlattenedSlotsForAnchor(samplePoints(), 5)).toBe(2)
    expect(countFlattenedSlotsForAnchor(samplePoints(), 99)).toBe(1)
  })

  it('drops the deleted anchor and shifts later indices', () => {
    // Delete a1 (flattened 2..4 vanish): selection [2,5] -> [2] (old 5 shifts to 2).
    expect(remapReshapeSelectionAfterAnchorDelete([0, 2, 5], samplePoints(), 2)).toEqual([0, 2])
    // Deleting an unselected earlier anchor still shifts.
    expect(remapReshapeSelectionAfterAnchorDelete([5], samplePoints(), 0)).toEqual([3])
    expect(remapReshapeSelectionAfterSlotDelete([3, 4], 2, 3)).toEqual([])
  })
})

describe('bulk delete fold', () => {
  it('remaps surviving selection through descending removals', () => {
    // Mirrors the Editor bulk-delete fold: removals arrive in descending
    // flattened order ({index, slots}), each applied oldest-last so higher
    // removals never disturb lower indices.
    const removals = [
      { index: 2, slots: 3 },
      { index: 0, slots: 2 },
    ]
    let next = normalizeReshapeSelection([0, 2, 5])
    for (const removal of removals) {
      next = remapReshapeSelectionAfterSlotDelete(next, removal.index, removal.slots)
    }
    expect(next).toEqual([0])
  })

  it('keeps unselected survivors shifted by earlier deletions', () => {
    // Delete anchors 0 and 2 (slots 2 and 3); survivor 5 lands on 0.
    expect(remapReshapeSelectionAfterSlotDelete([5], 2, 3)).toEqual([2])
    expect(remapReshapeSelectionAfterSlotDelete([2], 2, 3)).toEqual([])
    expect(remapReshapeSelectionAfterSlotDelete([2], 0, 2)).toEqual([0])
  })
})

describe('bulk move', () => {
  it('moves selected anchors with their own handles only', () => {
    const moved = moveReshapePoints(samplePoints(), [2], 10, 5)
    const byIndex = new Map(moved.map((p) => [p.index, p]))
    // a1 + its handles travel rigidly.
    expect([byIndex.get(2)!.x, byIndex.get(2)!.y]).toEqual([20, 5])
    expect([byIndex.get(3)!.x, byIndex.get(3)!.y]).toEqual([18, 3])
    expect([byIndex.get(4)!.x, byIndex.get(4)!.y]).toEqual([22, 7])
    // Everything else is untouched.
    expect([byIndex.get(0)!.x, byIndex.get(0)!.y]).toEqual([0, 0])
    expect([byIndex.get(1)!.x, byIndex.get(1)!.y]).toEqual([5, 0])
    expect([byIndex.get(5)!.x, byIndex.get(5)!.y]).toEqual([20, 0])
    expect([byIndex.get(6)!.x, byIndex.get(6)!.y]).toEqual([18, -2])
  })

  it('ignores selected control slots by default', () => {
    const moved = moveReshapePoints(samplePoints(), [3], 10, 5)
    expect(moved).toEqual(samplePoints())
  })

  it('emits ordered bulk targets without index invalidation', () => {
    const targets = reshapeBulkMoveTargets(samplePoints(), [0, 2], 1, 1)
    expect(targets.map((t) => t.index)).toEqual([0, 1, 2, 3, 4])
    expect(targets.find((t) => t.index === 2)).toEqual({ index: 2, x: 11, y: 1 })
    expect(reshapeBulkMoveTargets(samplePoints(), [0], 0, 0)).toEqual([])
  })

  it('never mutates the input', () => {
    const points = samplePoints()
    const snapshot = structuredClone(points)
    moveReshapePoints(points, [0, 2, 5], 3, -4)
    expect(points).toEqual(snapshot)
  })
})

describe('rebaseReshapeSelectionByAnchorCoordinates', () => {
  // Curving anchor 0 inserts two handle slots: later anchors shift 2 -> 4,
  // 5 -> 7 while staying put. The rebase must follow the coordinates.
  const before = [anchor(0, 0, 0), anchor(2, 10, 0), anchor(5, 20, 0)]
  const afterCurve = [anchor(0, 0, 0), anchor(4, 10, 0), anchor(7, 20, 0)]

  it('follows shifted anchors by coordinates', () => {
    expect(rebaseReshapeSelectionByAnchorCoordinates(before, afterCurve, [2, 5])).toEqual([4, 7])
    expect(rebaseReshapeSelectionByAnchorCoordinates(before, afterCurve, [0])).toEqual([0])
  })

  it('drops the selection fail-closed when ambiguous', () => {
    // No candidate (deleted anchor).
    expect(rebaseReshapeSelectionByAnchorCoordinates(before, afterCurve, [99])).toEqual([])
    // Two candidates within epsilon: cannot name the anchor, drop it.
    const doubled = [...afterCurve, anchor(8, 10.005, 0)]
    expect(rebaseReshapeSelectionByAnchorCoordinates(before, doubled, [2])).toEqual([])
    // Two selected anchors sharing one coordinate claim a single candidate once.
    const stackedPrev = [anchor(0, 10, 0), anchor(1, 10, 0)]
    expect(rebaseReshapeSelectionByAnchorCoordinates(stackedPrev, afterCurve, [0, 1])).toEqual([4])
  })

  it('ignores non-finite input and never mutates', () => {
    const prev = [...before]
    const next = [...afterCurve]
    expect(
      rebaseReshapeSelectionByAnchorCoordinates(prev, next, [2, -1, 1.5, NaN as unknown as number]),
    ).toEqual([4])
    expect(prev).toEqual(before)
    expect(next).toEqual(afterCurve)
  })
})
