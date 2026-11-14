// Unit tests for per-anchor handle masks (pure, no DOM/Paper).
// Exact Paper flags including latent handle-only selection (V-7 fix).
import { describe, expect, it } from 'bun:test'
import {
  isReshapeAnchorPressed,
  isReshapeCurveSelected,
  isReshapeHandlePressed,
  isReshapeSegmentSelected,
  liveReshapeActionIndices,
  mergeReshapeMarqueeSelectionWithMasks,
  normalizeReshapeHandleMasks,
  rebaseReshapeHandleMasksByAnchorCoordinates,
  remapReshapeHandleMasksAfterBulkRanges,
  remapReshapeHandleMasksAfterSlotDelete,
  reshapeHandleMasksToIndices,
  reshapeSelectedSegmentFlats,
  toggleReshapeHandleSelection,
} from '../src/features/costumes/vector-reshape-handle-masks'

describe('handle masks paper truth', () => {
  it('explicit is 7, curve is 5/3', () => {
    const plain = mergeReshapeMarqueeSelectionWithMasks({}, [], [[0, 2]], false)
    expect(plain).toEqual({ 0: 5, 2: 3 })
    expect(reshapeHandleMasksToIndices(plain)).toEqual([0, 2])
    const explicit = mergeReshapeMarqueeSelectionWithMasks({}, [0, 2], [], false)
    expect(explicit).toEqual({ 0: 7, 2: 7 })
  })

  it('shift toggles sequentially, duplicates cancel', () => {
    expect(mergeReshapeMarqueeSelectionWithMasks({ 0: 5, 1: 3 }, [], [[0, 1]], true)).toEqual({})
    expect(mergeReshapeMarqueeSelectionWithMasks({}, [], [[0, 1], [0, 1]], true)).toEqual({})
    expect(mergeReshapeMarqueeSelectionWithMasks({}, [], [[0, 1], [0, 1]], false)).toEqual({ 0: 5, 1: 3 })
  })

  it('overlapping shared anchor unions then cascades on remove', () => {
    const one = mergeReshapeMarqueeSelectionWithMasks({}, [], [[0, 2]], false)
    const both = mergeReshapeMarqueeSelectionWithMasks(one, [], [[2, 5]], true)
    expect(both).toEqual({ 0: 5, 2: 7, 5: 3 })
    // Toggling one of two overlapping selected curves clears only the curve's
    // Paper bits (5 on start, 3 on end), leaving a handle-only residual that
    // still counts as segment-selected but not as anchor-pressed.
    const removed = mergeReshapeMarqueeSelectionWithMasks(both, [], [[0, 2]], true)
    expect(removed).toEqual({ 2: 4, 5: 3 })
    expect(reshapeHandleMasksToIndices(removed)).toEqual([5])
  })

  it('click toggles explicit 7', () => {
    expect(toggleReshapeHandleSelection({}, 2, false)).toEqual({ 2: 7 })
    expect(toggleReshapeHandleSelection({ 2: 7 }, 2, true)).toEqual({})
    expect(toggleReshapeHandleSelection({ 0: 5, 2: 3 }, 0, true)).toEqual({ 2: 3 })
  })

  it('remaps and rebases carrying masks', () => {
    expect(remapReshapeHandleMasksAfterSlotDelete({ 0: 5, 2: 3 }, 0, 2)).toEqual({ 0: 3 })
    expect(remapReshapeHandleMasksAfterBulkRanges({ 0: 5, 2: 7, 5: 3 }, [{ index: 0, slots: 2 }])).toEqual({ 0: 7, 3: 3 })
    const prev = [{ index: 0, x: 0, y: 0 }, { index: 2, x: 10, y: 0 }]
    const next = [{ index: 0, x: 0, y: 0 }, { index: 4, x: 10, y: 0 }]
    expect(rebaseReshapeHandleMasksByAnchorCoordinates(prev, next, { 2: 3 })).toEqual({ 4: 3 })
  })
})

describe('handle masks exact Paper flags with latent handle-only (V-7)', () => {
  it('normalizer keeps handle-only 2/4/6, indices stay point projection', () => {
    expect(normalizeReshapeHandleMasks({ 0: 5, 2: 6, 5: 3 })).toEqual({ 0: 5, 2: 6, 5: 3 })
    expect(normalizeReshapeHandleMasks({ 0: 2, 1: 4, 2: 6 })).toEqual({ 0: 2, 1: 4, 2: 6 })
    expect(normalizeReshapeHandleMasks({ 0: 0, 1: 8 })).toEqual({})
    expect(reshapeHandleMasksToIndices({ 0: 5, 2: 4, 5: 3 })).toEqual([0, 5])
    expect(reshapeHandleMasksToIndices({ 0: 2, 1: 4, 2: 6 })).toEqual([])
  })

  it('segment getter is any-bit, anchor pressed is point-bit only', () => {
    expect(isReshapeSegmentSelected({ 2: 4 }, 2)).toBe(true)
    expect(isReshapeSegmentSelected({ 2: 2 }, 2)).toBe(true)
    expect(isReshapeSegmentSelected({ 2: 6 }, 2)).toBe(true)
    expect(isReshapeSegmentSelected({ 2: 0 }, 2)).toBe(false)
    expect(isReshapeSegmentSelected({}, 2)).toBe(false)
    expect(isReshapeAnchorPressed({ 2: 4 }, 2)).toBe(false)
    expect(isReshapeAnchorPressed({ 2: 2 }, 2)).toBe(false)
    expect(isReshapeAnchorPressed({ 2: 5 }, 2)).toBe(true)
    expect(isReshapeAnchorPressed({ 2: 3 }, 2)).toBe(true)
    expect(isReshapeHandlePressed({ 2: 4 }, 2, 'out')).toBe(true)
    expect(isReshapeHandlePressed({ 2: 4 }, 2, 'in')).toBe(false)
    expect(isReshapeHandlePressed({ 2: 2 }, 2, 'in')).toBe(true)
    expect(isReshapeHandlePressed({ 2: 2 }, 2, 'out')).toBe(false)
  })

  it('curve getter requires 5 on start and 3 on end', () => {
    expect(isReshapeCurveSelected({ 0: 5, 2: 3 }, 0, 2)).toBe(true)
    expect(isReshapeCurveSelected({ 0: 7, 2: 7 }, 0, 2)).toBe(true)
    expect(isReshapeCurveSelected({ 0: 5, 2: 4 }, 0, 2)).toBe(false)
    expect(isReshapeCurveSelected({ 0: 1, 2: 3 }, 0, 2)).toBe(false)
    expect(isReshapeCurveSelected({ 0: 5, 2: 3 }, 2, 0)).toBe(false)
  })

  it('shared curve cascade leaves handle-only, reselect restores 7 both orders', () => {
    const one = mergeReshapeMarqueeSelectionWithMasks({}, [], [[0, 2]], false)
    const both = mergeReshapeMarqueeSelectionWithMasks(one, [], [[2, 5]], true)
    // Toggle first off: start cleared, shared keeps out-only residual.
    const removedFirst = mergeReshapeMarqueeSelectionWithMasks(both, [], [[0, 2]], true)
    expect(removedFirst).toEqual({ 2: 4, 5: 3 })
    expect(isReshapeSegmentSelected(removedFirst, 2)).toBe(true)
    expect(isReshapeAnchorPressed(removedFirst, 2)).toBe(false)
    // Reselect restores the stale out-bit to 7 (Paper-exact, was 6 before V-7).
    const retoggledFirst = mergeReshapeMarqueeSelectionWithMasks(removedFirst, [], [[0, 2]], true)
    expect(retoggledFirst).toEqual({ 0: 5, 2: 7, 5: 3 })
    // Toggle second off instead: shared keeps in-only residual.
    const removedSecond = mergeReshapeMarqueeSelectionWithMasks(both, [], [[2, 5]], true)
    expect(removedSecond).toEqual({ 0: 5, 2: 2 })
    expect(isReshapeSegmentSelected(removedSecond, 2)).toBe(true)
    expect(isReshapeAnchorPressed(removedSecond, 2)).toBe(false)
    const retoggledSecond = mergeReshapeMarqueeSelectionWithMasks(removedSecond, [], [[2, 5]], true)
    expect(retoggledSecond).toEqual({ 0: 5, 2: 7, 5: 3 })
  })

  it('explicit 7 is never downgraded by a later curve union', () => {
    expect(mergeReshapeMarqueeSelectionWithMasks({ 0: 7 }, [], [[0, 2]], true)).toEqual({ 0: 7, 2: 3 })
  })

  it('anchor shift-toggle upgrades latent handle-only to 7, clears point to 0', () => {
    // Handle-only anchor Shift+clicked becomes explicitly selected.
    expect(toggleReshapeHandleSelection({ 2: 4 }, 2, true)).toEqual({ 2: 7 })
    expect(toggleReshapeHandleSelection({ 2: 2 }, 2, true)).toEqual({ 2: 7 })
    // Point-selected anchor Shift+clicked clears the whole segment.
    expect(toggleReshapeHandleSelection({ 2: 4, 5: 3 }, 5, true)).toEqual({ 2: 4 })
    expect(mergeReshapeMarqueeSelectionWithMasks({ 0: 5, 2: 4, 5: 3 }, [2], [], true)).toEqual({
      0: 5,
      2: 7,
      5: 3,
    })
  })

  it('remap and rebase carry latent handle-only masks', () => {
    expect(remapReshapeHandleMasksAfterSlotDelete({ 2: 4, 5: 3 }, 0, 2)).toEqual({ 0: 4, 3: 3 })
    const prev = [
      { index: 0, x: 0, y: 0 },
      { index: 2, x: 10, y: 0 },
    ]
    const nextAnchors = [
      { index: 0, x: 0, y: 0 },
      { index: 4, x: 10, y: 0 },
    ]
    expect(rebaseReshapeHandleMasksByAnchorCoordinates(prev, nextAnchors, { 0: 5, 2: 4 })).toEqual({
      0: 5,
      4: 4,
    })
  })
})
