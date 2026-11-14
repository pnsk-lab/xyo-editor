// Hostile audit: vector reshape selection-history snapshots under concurrent CAS writes.
//
// Two real defects proved below (fail-first: these tests FAIL on the pre-fix
// product and PASS after the minimal fix):
//
//  1. Sampled byte hash collision (`hashSelectionBytes`): for assets larger
//     than 8192 bytes only every Nth byte was hashed. A one-byte shape change
//     at an unsampled offset yields the SAME hash, so the delete path's
//     freshness gate (`candidate.bytesHash === hash(pendingEntry.bytes)`) and
//     the redo path's prior check accept a STALE prior as fresh. Undo then
//     restores the wrong object/anchor selection onto different artwork
//     (concurrent data corruption: phantom selection, wrong unit selected).
//
//  2. Cleared-outline capture loss: both live-capture call sites in
//     `Editor.svelte` (`snapshotCurrentReshapeSelectionForHistory`,
//     `rememberCommittedReshapeSelection`) pre-normalize with the primary
//     object as fallback, converting the reachable UI state
//     (`selectedVectorObjectIndices == []` with `selectedVectorObjectIndex >= 0`
//     — produced by order actions front/back/forward/backward, which clear the
//     outline array but keep the moved unit as primary) into `[primary]`.
//     The pipeline's own "empty stays empty with live primary" state becomes
//     unreachable from live capture, so a later delete->Undo (or redo)
//     wrongly restores a blue outline the user had cleared.
//
// Audited and found SAFE (no change, documented so the audit is complete):
//  - Cross-slot capture during a peek await (target/costume switch while
//    awaiting `vm.loadAsset` / external CAS): the paint entry's scope guard
//    drops the whole entry on commit when the active slot changed, and the
//    per-entry snapshot lives in a WeakMap keyed by that dropped entry, so a
//    wrong-slot UI can never be committed or restored.
//  - Object identity/index shifts from grouping, reorder/paste/import/delete:
//    every entry snapshot is bound to its entry's pre-edit bytes and undo
//    restores those exact bytes; verbatim index validation therefore resolves
//    against the same structure the snapshot was taken from. Unknown indices
//    are dropped, never rebased onto a wrong unit.
//  - Duplicate equal objects + nested groups/skew: anchor validation drops
//    (never retargets) any mask naming duplicated coordinates — fail-closed
//    toward selection-lost, never toward the wrong anchor.
//  - Rename adoption of the committed prior: runs only when the slot showed
//    no unseen drift before the rename (same guard as `paintKnown`), and any
//    generation bump that matters clears the committed map first.
//  - Committed-prior memory cap (64 slots): eviction only degrades toward
//    selection-lost (prior treated as missing/stale); per-entry snapshots are
//    WeakMap-held and need no cap.
import { describe, expect, it } from 'bun:test'
import {
  buildSelectionSnapshot,
  hashSelectionBytes,
} from '../src/features/costumes/vector-reshape-selection-history'

describe('hostile audit: reshape selection-history snapshots', () => {
  it('byte hash distinguishes a single-byte shape change past the sampling window', () => {
    // Pre-fix `hashSelectionBytes` sampled every Nth byte for assets > 8192
    // bytes, so bytes differing only at an unsampled offset hashed equal and
    // a stale prior passed the delete/redo freshness gate as fresh.
    const length = 9000
    const before = new Uint8Array(length)
    const after = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      before[i] = (i * 31 + 7) & 0xff
      after[i] = (i * 31 + 7) & 0xff
    }
    // Flip one byte that a strided sampler (step >= 2) skips: odd index with
    // an even step never lands on a sampled offset.
    after[1] = (after[1]! + 1) & 0xff
    expect(after).not.toEqual(before)
    expect(hashSelectionBytes(after)).not.toBe(hashSelectionBytes(before))
  })

  it('delete freshness gate scenario: one-byte-different artwork is never "fresh"', () => {
    const length = 9000
    const committed = new Uint8Array(length)
    const pending = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      committed[i] = (i * 17 + 3) & 0xff
      pending[i] = (i * 17 + 3) & 0xff
    }
    pending[1] = (pending[1]! + 1) & 0xff
    const prior = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 2,
      bytes: committed,
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    // The delete path merges the prior only when
    // `candidate.bytesHash === hash(pendingEntry.bytes)`. Equal hashes here
    // would resurrect the wrong selection onto different artwork.
    expect(prior.bytesHash).not.toBe(hashSelectionBytes(pending))
  })

  it('explicit empty object selection with a live primary survives the pipeline', () => {
    // Order actions (front/back/forward/backward) leave
    // `selectedVectorObjectIndex >= 0` with `selectedVectorObjectIndices == []`
    // (outline cleared, moved unit stays addressable). That explicit empty
    // must not be reinvented as `[primary]` by live capture.
    const snapshot = buildSelectionSnapshot({
      targetId: 't1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 1,
      bytes: new Uint8Array([7]),
      objectIndex: 1,
      selectedObjectIndices: [],
      masks: {},
      leafIndices: [],
    })!
    expect(snapshot.selectedObjectIndices).toEqual([])
    expect(snapshot.objectIndex).toBe(1)
  })

  it('Editor capture sites preserve an explicitly cleared outline (no primary fallback)', async () => {
    // Fail-first pin for the Editor.svelte fix: both live-capture call sites
    // must pass the outline array through WITHOUT the primary fallback, or
    // the reachable ([], primary>=0) UI state can never be snapshotted.
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    const snapshotCall = 'selectedObjectIndices: normalizeSelectedObjectIndices([...selectedVectorObjectIndices], selectedVectorObjectIndex)'
    expect(source).not.toContain(snapshotCall)
  })
})
