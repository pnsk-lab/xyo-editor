// Selection snapshot metadata: oracle parity (prior-committed for deletes).
import { describe, expect, it } from 'bun:test'
import {
  buildSelectionSnapshot,
  cloneSelectionSnapshot,
  hashSelectionBytes,
  isSelectionSnapshotForSlot,
  isSelectionSnapshotStale,
  mergeSelectionAtPriorCommitted,
  normalizeSelectedObjectIndices,
  normalizeSelectionSnapshot,
  reshapeSelectionSlotKey,
  validateSelectionSnapshotForAnchors,
  validateSelectionSnapshotForObjects,
  RESHAPE_SELECTION_HISTORY_MAX_FLATS,
  RESHAPE_SELECTION_HISTORY_MAX_OBJECTS,
} from '../src/features/costumes/vector-reshape-selection-history'

describe('vector reshape selection history metadata', () => {
  it('slot keys use stable id, never display names', () => {
    expect(reshapeSelectionSlotKey('id-1', 0)).toBe('paint:id-1:0')
    expect(reshapeSelectionSlotKey('id-1', 0)).not.toBe(reshapeSelectionSlotKey('id-2', 0))
  })

  it('build/normalize/clone round-trip masks + leaves, caps flats', () => {
    const snapshot = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 3,
      writeSeq: 7,
      bytes: new Uint8Array([1, 2, 3]),
      objectIndex: 0,
      masks: { 5: 4, 8: 3 },
      leafIndices: [1],
    })
    expect(snapshot?.masks).toEqual({ 5: 4, 8: 3 })
    expect(snapshot?.slotKey).toBe('paint:t1:0')
    const cloned = cloneSelectionSnapshot(snapshot)
    expect(cloned).toEqual(snapshot)
    expect(cloned).not.toBe(snapshot)
    // Over-cap fails closed.
    const huge: Record<number, number> = {}
    for (let i = 0; i < RESHAPE_SELECTION_HISTORY_MAX_FLATS + 10; i++) huge[i] = 7
    expect(
      buildSelectionSnapshot({
        targetId: 't1',
        index: 0,
        projectGeneration: 0,
        bytes: new Uint8Array([0]),
        objectIndex: 0,
        masks: huge,
        leafIndices: [],
      }),
    ).toBeUndefined()
  })

  it('prior-committed merge ignores current UI (oracle Scenarios A/B)', () => {
    const prior = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 1,
      bytes: new Uint8Array([9]),
      objectIndex: 0,
      masks: { 5: 4, 8: 3 },
      leafIndices: [],
    })
    // Scenario B: UI changed to S2 after nudge, delete still merges prior S1.
    const merged = mergeSelectionAtPriorCommitted(prior)
    expect(merged?.masks).toEqual({ 5: 4, 8: 3 })
    // Scenario A: no prior => no selection (lost, per oracle).
    expect(mergeSelectionAtPriorCommitted(undefined)).toBeUndefined()
  })

  it('applicability requires stable id/index/generation; CAS sees same-bytes external', () => {
    const snapshot = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 2,
      writeSeq: 5,
      bytes: new Uint8Array([1]),
      objectIndex: 0,
      masks: { 2: 7 },
      leafIndices: [],
    })!
    expect(isSelectionSnapshotForSlot(snapshot, 't1', 0, 2)).toBe(true)
    expect(isSelectionSnapshotForSlot(snapshot, 'namesake', 0, 2)).toBe(false)
    expect(isSelectionSnapshotForSlot(snapshot, 't1', 1, 2)).toBe(false)
    expect(isSelectionSnapshotForSlot(snapshot, 't1', 0, 3)).toBe(false)
    expect(isSelectionSnapshotStale(snapshot, 5)).toBe(false)
    expect(isSelectionSnapshotStale(snapshot, 6)).toBe(true)
  })

  it('validate drops vanished anchors and duplicate-coordinate masks fail-closed', () => {
    const snapshot = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      bytes: new Uint8Array([1]),
      objectIndex: 0,
      masks: { 0: 7, 2: 4, 99: 7 },
      leafIndices: [0, 99],
    })!
    const anchors = [
      { index: 0, x: 0, y: 0 },
      { index: 2, x: 10, y: 0 },
    ]
    const validated = validateSelectionSnapshotForAnchors(snapshot, anchors)!
    expect(validated.masks).toEqual({ 0: 7, 2: 4 })
    expect(validated.leafIndices).toEqual([0])
    // Duplicate coords: both masked anchors dropped, never retargeted.
    const dupAnchors = [
      { index: 0, x: 5, y: 5 },
      { index: 2, x: 5, y: 5 },
    ]
    const dupValidated = validateSelectionSnapshotForAnchors(snapshot, dupAnchors)!
    expect(dupValidated.masks).toEqual({})
  })

  it('bytes hash distinguishes content; invalid snapshots rejected', () => {
    expect(hashSelectionBytes(new Uint8Array([1, 2]))).not.toBe(hashSelectionBytes(new Uint8Array([1, 3])))
    expect(normalizeSelectionSnapshot(undefined)).toBeUndefined()
    expect(normalizeSelectionSnapshot({})).toBeUndefined()
  })

  it('full object selection defaults to primary, dedupes/sorts/caps, rejects phantom primary', () => {
    // Legacy build without the field falls back to the primary.
    const legacy = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 1,
      bytes: new Uint8Array([1]),
      objectIndex: 1,
      masks: {},
      leafIndices: [],
    })!
    expect(legacy.selectedObjectIndices).toEqual([1])
    // Explicit array dedupes + sorts.
    expect(normalizeSelectedObjectIndices([2, 1, 2, 1], 1)).toEqual([1, 2])
    // Empty with no primary stays empty (cleared selection).
    expect(normalizeSelectedObjectIndices([], undefined)).toEqual([])
    expect(normalizeSelectedObjectIndices(undefined, -1)).toEqual([])
    // Cap bounded.
    const huge = Array.from({ length: RESHAPE_SELECTION_HISTORY_MAX_OBJECTS + 10 }, (_, i) => i)
    expect(normalizeSelectedObjectIndices(huge, 0).length).toBe(RESHAPE_SELECTION_HISTORY_MAX_OBJECTS)
    // Primary naming a phantom object fails closed.
    expect(
      normalizeSelectionSnapshot({
        targetId: 't1',
        index: 0,
        slotKey: 'paint:t1:0',
        projectGeneration: 0,
        writeSeq: 1,
        bytesHash: '1:aa',
        objectIndex: 5,
        selectedObjectIndices: [1],
        masks: {},
        leafIndices: [],
      }),
    ).toBeUndefined()
  })

  it('object validation uses indices verbatim (no rebase), drops unknown, fail-closed on vanished primary', () => {
    const snapshot = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 1,
      bytes: new Uint8Array([7]),
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    // Live has the rect: survives verbatim.
    expect(validateSelectionSnapshotForObjects(snapshot, [0, 1])?.selectedObjectIndices).toEqual([1])
    // Rect gone (undo before the other edit): primary vanished -> whole snapshot dropped.
    expect(validateSelectionSnapshotForObjects(snapshot, [0])).toBeUndefined()
    // Unknown indices dropped, never retargeted.
    const multi = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      bytes: new Uint8Array([7]),
      objectIndex: 0,
      selectedObjectIndices: [0],
      masks: {},
      leafIndices: [],
    })!
    expect(validateSelectionSnapshotForObjects(multi, [0, 9])?.selectedObjectIndices).toEqual([0])
    // Cleared selection stays cleared.
    const cleared = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      bytes: new Uint8Array([7]),
      objectIndex: -1,
      selectedObjectIndices: [],
      masks: {},
      leafIndices: [],
    })!
    expect(validateSelectionSnapshotForObjects(cleared, [0, 1])?.selectedObjectIndices).toEqual([])
    // Same-name slot confusion is impossible: slot key binds stable id.
    expect(validateSelectionSnapshotForObjects(snapshot, [])).toBeUndefined()
  })

  it('nudge/brush/rect style post-edit prior carries full object selection for delete->undo', () => {
    // Nudge post-state: wave selected with latent 4/3.
    const nudged = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 2,
      bytes: new Uint8Array([1, 2, 3]),
      objectIndex: 0,
      selectedObjectIndices: [0],
      masks: { 99: 4, 100: 3 },
      leafIndices: [],
    })!
    // Rect post-state: new rect selected, masks cleared.
    const postRect = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 3,
      bytes: new Uint8Array([4, 5, 6]),
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    expect(postRect.bytesHash).not.toBe(nudged.bytesHash)
    // Delete merges the prior (post-rect), not the stale nudged wave.
    const merged = mergeSelectionAtPriorCommitted(postRect)!
    expect(merged.selectedObjectIndices).toEqual([1])
    expect(merged.objectIndex).toBe(1)
    expect(merged.masks).toEqual({})
    // CAS: same-bytes external bumps writeSeq -> prior stale fail-closed.
    expect(isSelectionSnapshotStale(postRect, 3)).toBe(false)
    expect(isSelectionSnapshotStale(postRect, 4)).toBe(true)
  })
})
