import { describe, expect, it } from 'bun:test'
import {
  createVectorGestureCasRecord,
  isVectorCasConflicted,
  isVectorHistoryStale,
  markVectorCasConflicted,
  noteVectorCasApplied,
  observeVectorHistoryIdentity,
  vectorCasExpectedOf,
  vectorExternalConflictStatus,
  vectorSlotIdentityOf,
} from '../src/features/costumes/vector-slot-cas'

describe('vector-slot-cas pure helper', () => {
  it('normal preview propagates returned writeSeq to the next expected', () => {
    const rec = createVectorGestureCasRecord('t1', 0, { assetId: 'a', md5ext: 'a.svg', writeSeq: 5 })
    expect(vectorCasExpectedOf(rec)).toEqual({ assetId: 'a', md5ext: 'a.svg', writeSeq: 5 })
    noteVectorCasApplied(rec, { assetId: 'b', md5ext: 'b.svg', writeSeq: 6 })
    expect(vectorCasExpectedOf(rec)).toEqual({ assetId: 'b', md5ext: 'b.svg', writeSeq: 6 })
    expect(isVectorCasConflicted(rec)).toBe(false)
  })

  it('conflict marks once and never clears (no force-write after)', () => {
    const rec = createVectorGestureCasRecord('t1', 0, { writeSeq: 5 })
    markVectorCasConflicted(rec)
    expect(isVectorCasConflicted(rec)).toBe(true)
    // A later successful write must not be fed: callers check conflicted first.
    // The helper itself never auto-clears.
    expect(isVectorCasConflicted(rec)).toBe(true)
  })

  it('metadata-only / same-bytes divergence is stale only by version', () => {
    // Same hash, bumped seq => external (hash-only would miss).
    expect(isVectorHistoryStale({ assetId: 'a', md5ext: 'a.svg', writeSeq: 6 }, { assetId: 'a', md5ext: 'a.svg', writeSeq: 5 })).toBe(true)
    // Same hash, same seq => not stale.
    expect(isVectorHistoryStale({ assetId: 'a', md5ext: 'a.svg', writeSeq: 5 }, { assetId: 'a', md5ext: 'a.svg', writeSeq: 5 })).toBe(false)
    // New bytes (different hash, bumped seq) => stale.
    expect(isVectorHistoryStale({ assetId: 'b', md5ext: 'b.svg', writeSeq: 6 }, { assetId: 'a', md5ext: 'a.svg', writeSeq: 5 })).toBe(true)
  })

  it('observed identity copies the version (rename-safe: no name in expected)', () => {
    const observed = observeVectorHistoryIdentity({ assetId: 'a', md5ext: 'a.svg', writeSeq: 7 })
    expect(observed).toEqual({ assetId: 'a', md5ext: 'a.svg', writeSeq: 7 })
    const normalized = vectorSlotIdentityOf({ assetId: 'a', md5ext: 'a.svg', writeSeq: 7, name: 'X' } as unknown)
    expect('name' in normalized).toBe(false)
  })

  it('conflict status keeps the external (wording contract)', () => {
    expect(vectorExternalConflictStatus('Rotate')).toContain('External costume change kept')
  })
})
