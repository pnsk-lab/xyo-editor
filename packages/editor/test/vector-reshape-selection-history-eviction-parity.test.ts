// Eviction parity: Scratch preserves 100 selection snapshots; the helper must
// too. Fail-first: 70 distinct ~64KiB states (each entry at the old
// `bytesExact` cap) with selection object 4 / masks {4:3}, then the OLDEST
// entry must still be fresh for its own unchanged bytes (distinct buffer,
// never a self-compare). Pre-fix the global 4MiB LRU tracker evicts the
// oldest exact bytes after >64 edits and `isSelectionSnapshotFreshForBytes`
// returns false for valid unchanged artwork (silent selection loss on Undo).
// Post-fix every per-entry snapshot stays usable within the original history
// budget (entries + metadata evicted together, never metadata alone).
import { describe, expect, it } from 'bun:test'
import {
  buildSelectionSnapshot,
  equalSelectionBytes,
  isSelectionSnapshotFreshForBytes,
  isSelectionSnapshotUsableForSlot,
} from '../src/features/costumes/vector-reshape-selection-history'

function bytesForIndex(i: number): Uint8Array {
  const out = new Uint8Array(65536)
  out[0] = (i >>> 24) & 0xff
  out[1] = (i >>> 16) & 0xff
  out[2] = (i >>> 8) & 0xff
  out[3] = i & 0xff
  out[4] = 0xa5
  out[5] = 0x5a
  out[6] = (i * 7) & 0xff
  out[7] = (i * 13 + 1) & 0xff
  for (let k = 8; k < out.length; k += 1) out[k] = (k * 31 + i) & 0xff
  return out
}

describe('eviction parity: 70 x ~64KiB entries keep the oldest selection usable', () => {
  it('oldest snapshot stays fresh for its own unchanged bytes (distinct buffer)', () => {
    const snapshots = []
    for (let i = 0; i < 70; i += 1) {
      const snap = buildSelectionSnapshot({
        targetId: 'stable-1',
        index: 0,
        projectGeneration: 0,
        writeSeq: i,
        bytes: bytesForIndex(i),
        objectIndex: 4,
        selectedObjectIndices: [4],
        masks: { 4: 3 },
        leafIndices: [4],
      })!
      snapshots.push(snap)
    }
    const oldest = snapshots[0]!
    const newest = snapshots[snapshots.length - 1]!
    // Selection payload survives on both ends (object 4 / masks 4:3).
    expect(oldest.selectedObjectIndices).toEqual([4])
    expect(oldest.masks).toEqual({ 4: 3 })
    expect(newest.selectedObjectIndices).toEqual([4])
    // Freshness is proven against a DISTINCT buffer with identical content:
    // never a self-compare of a buffer with itself.
    const oldestLive = bytesForIndex(0)
    expect(oldestLive).not.toBe(oldest.bytesExact)
    expect(equalSelectionBytes(oldest.bytesExact ?? undefined, oldestLive)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(oldest, oldestLive)).toBe(true)
    expect(isSelectionSnapshotUsableForSlot(oldest, 'stable-1', 0, 0, 0, oldestLive)).toBe(true)
    const newestLive = bytesForIndex(69)
    expect(isSelectionSnapshotFreshForBytes(newest, newestLive)).toBe(true)
    // Tampered bytes still fail closed (no retarget onto different artwork).
    const tampered = bytesForIndex(0)
    tampered[1000] = (tampered[1000] as number) ^ 0x01
    expect(isSelectionSnapshotFreshForBytes(oldest, tampered)).toBe(false)
    // Cross-slot / generation / seq guards still hold for identical bytes.
    expect(isSelectionSnapshotUsableForSlot(oldest, 'namesake', 0, 0, 0, oldestLive)).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(oldest, 'stable-1', 0, 1, 0, oldestLive)).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(oldest, 'stable-1', 0, 0, 1, oldestLive)).toBe(false)
  })
})
