import { describe, expect, it } from 'bun:test'

import {
  PAINT_HISTORY_MAX_BYTES,
  PAINT_HISTORY_MAX_ENTRIES,
  SOUND_HISTORY_MAX_BYTES,
  SOUND_HISTORY_MAX_ENTRIES,
  createScopeGuard,
  historyByteSize,
  isGuardCurrent,
  paintScopeFor,
  paintScopeId,
  soundScopeFor,
  soundScopeId,
  stableTargetId,
  trimHistoryStacks,
} from '../src/lib/paint-history'

/**
 * Pure-helper unit tests for the paint/sound history policy.
 *
 * Scope keys exclude the content hash (`assetId`/`md5ext`, re-minted on every
 * save) and display names (rename-safe); async peek/commit guards invalidate
 * late commits after a switch/clear; caps are 100 entries + encoded-bytes
 * budgets (see `src/lib/paint-history.ts` for the memory evaluation).
 */

function entryOf(size: number, marker = 0): { bytes: Uint8Array; marker: number } {
  return { bytes: new Uint8Array(size).fill(marker), marker }
}

describe('paint-history: scope identity (no content hash)', () => {
  it('uses the stable target id, falling back to the name', () => {
    expect(stableTargetId({ id: 'target-1', name: 'Sprite1' })).toBe('target-1')
    expect(stableTargetId({ name: 'Sprite1' })).toBe('Sprite1')
  })

  it('ignores display names, so rename keeps the scope', () => {
    const before = paintScopeFor({ id: 't1', name: 'Sprite1' }, 0)
    const renamed = paintScopeFor({ id: 't1', name: 'Renamed' }, 0)
    expect(before).toBe(renamed)
  })

  it('separates kind / target / slot without any content hash', () => {
    const paint = paintScopeId('t1', 0)
    const otherCostume = paintScopeId('t1', 1)
    const otherTarget = paintScopeId('t2', 0)
    const sound = soundScopeId('t1', 0)
    expect(new Set([paint, otherCostume, otherTarget, sound]).size).toBe(4)
    expect(paint).not.toContain('md5')
    expect(paint).not.toContain('asset')
    expect(soundScopeFor({ id: 't1', name: 'Sprite1' }, 0)).toBe(sound)
  })
})

describe('paint-history: scope guards', () => {
  it('accepts the current scope+generation, rejects switch/clear', () => {
    const guard = createScopeGuard('paint:t1:0', 3)
    expect(isGuardCurrent('paint:t1:0', 3, guard)).toBe(true)
    // Switch to another costume.
    expect(isGuardCurrent('paint:t1:1', 4, guard)).toBe(false)
    // Same key but cleared (generation bumped).
    expect(isGuardCurrent('paint:t1:0', 4, guard)).toBe(false)
  })
})

describe('paint-history: caps and byte budgets', () => {
  it('caps entries at 100 and drops the oldest first', () => {
    expect(PAINT_HISTORY_MAX_ENTRIES).toBe(100)
    expect(SOUND_HISTORY_MAX_ENTRIES).toBe(100)
    const undo = Array.from({ length: 101 }, (_, i) => entryOf(1, i))
    const trimmed = trimHistoryStacks(undo, [], PAINT_HISTORY_MAX_ENTRIES, PAINT_HISTORY_MAX_BYTES)
    expect(trimmed.undo.length).toBe(100)
    expect(trimmed.undo[0]?.marker).toBe(1)
    expect(trimmed.undo.at(-1)?.marker).toBe(100)
    expect(trimmed.redo).toEqual([])
  })

  it('evicts oldest undo entries first under the byte budget', () => {
    const undo = [entryOf(2, 1), entryOf(2, 2), entryOf(2, 3)]
    const trimmed = trimHistoryStacks(undo, [], 100, 4)
    expect(historyByteSize(trimmed.undo)).toBeLessThanOrEqual(4)
    expect(trimmed.undo.map((entry) => entry.marker)).toEqual([2, 3])
  })

  it('counts redo bytes in the combined budget', () => {
    // Redo bytes count toward the combined total: 3+3+3=9 > 6, so the
    // oldest undo entry is evicted first while the newest tails survive.
    const trimmed = trimHistoryStacks([entryOf(3, 1), entryOf(3, 2)], [entryOf(3, 3)], 100, 6)
    expect(historyByteSize(trimmed.undo) + historyByteSize(trimmed.redo)).toBeLessThanOrEqual(6)
    expect(trimmed.undo.map((entry) => entry.marker)).toEqual([2])
    expect(trimmed.redo.map((entry) => entry.marker)).toEqual([3])
  })

  it('never mutates its inputs', () => {
    const undo = [entryOf(2, 1), entryOf(2, 2)]
    const redo = [entryOf(2, 9)]
    const undoLength = undo.length
    const trimmed = trimHistoryStacks(undo, redo, 100, 2)
    expect(undo.length).toBe(undoLength)
    expect(redo.length).toBe(1)
    expect(trimmed).not.toBe(undo)
  })

  it('declares byte budgets that bound the evaluated worst cases', () => {
    // Typical PNG artwork (tens of KB, large photo imports low single-digit
    // MB): 100 x 200 KB ~= 20 MB fits the 24 MB paint budget.
    expect(PAINT_HISTORY_MAX_BYTES).toBe(24 * 1024 * 1024)
    expect(100 * 200 * 1024).toBeLessThanOrEqual(PAINT_HISTORY_MAX_BYTES)
    // 44.1 kHz 16-bit mono WAV ~= 88 KB/s: unbounded 100-entry sound history
    // would exceed 250 MB, so the 32 MB budget is the binding cap.
    expect(SOUND_HISTORY_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(Math.ceil((44100 * 2 * 30) / 1024)).toBeGreaterThan(2000)
  })
})

describe('paint-history: over-budget newest guarantee', () => {
  it('keeps a single paint snapshot exceeding 24MB so the edit stays undoable', () => {
    const over = PAINT_HISTORY_MAX_BYTES + 1
    const huge = { bytes: new Uint8Array(over), marker: 1 }
    const trimmed = trimHistoryStacks([huge], [], PAINT_HISTORY_MAX_ENTRIES, PAINT_HISTORY_MAX_BYTES)
    expect(trimmed.undo.length).toBe(1)
    expect(trimmed.undo[0]).toBe(huge)
    expect(trimmed.redo).toEqual([])
    // Documented exception: the protected entry may exceed the budget.
    expect(historyByteSize(trimmed.undo)).toBeGreaterThan(PAINT_HISTORY_MAX_BYTES)
  })

  it('keeps a single sound snapshot exceeding 32MB so the edit stays undoable', () => {
    const over = SOUND_HISTORY_MAX_BYTES + 1
    const huge = { bytes: new Uint8Array(over), marker: 7 }
    const trimmed = trimHistoryStacks([huge], [], SOUND_HISTORY_MAX_ENTRIES, SOUND_HISTORY_MAX_BYTES)
    expect(trimmed.undo.length).toBe(1)
    expect(trimmed.undo[0]).toBe(huge)
    expect(trimmed.redo).toEqual([])
    expect(historyByteSize(trimmed.undo)).toBeGreaterThan(SOUND_HISTORY_MAX_BYTES)
  })

  it('commit keeps the newest huge entry and still clears redo', () => {
    // Editor commit shape: trim([...undo, entry], [], ...). 2+2+8=12 > 10,
    // so the oldest entry is evicted but the newest huge commit survives.
    const old = [entryOf(2, 1), entryOf(2, 2)]
    const hugeCommit = { bytes: new Uint8Array(8), marker: 3 }
    const trimmed = trimHistoryStacks([...old, hugeCommit], [], 100, 10)
    expect(trimmed.redo).toEqual([])
    expect(trimmed.undo.at(-1)).toBe(hugeCommit)
    expect(trimmed.undo.map((entry) => (entry as { marker: number }).marker)).toEqual([2, 3])
    // A lone commit larger than the whole budget is still kept on its own.
    const solo = trimHistoryStacks([hugeCommit], [], 100, 4)
    expect(solo.undo.length).toBe(1)
    expect(solo.undo[0]).toBe(hugeCommit)
    expect(solo.redo).toEqual([])
  })

  it('undo move symmetrically keeps the just-pushed redo entry over budget', () => {
    // Editor undo shape: pop undo, then trim(undoSide, [...redoSide, current]).
    const remainingUndo = [entryOf(2, 1)]
    const redoCurrent = { bytes: new Uint8Array(8), marker: 9 }
    const trimmed = trimHistoryStacks(remainingUndo, [redoCurrent], 100, 4)
    expect(trimmed.redo.length).toBe(1)
    expect(trimmed.redo[0]).toBe(redoCurrent)
    // The other side is still capacity-limited (oldest-first), order kept.
    expect(trimmed.undo.map((entry) => entry.marker)).toEqual([1])
  })

  it('redo move symmetrically keeps the just-pushed undo entry over budget', () => {
    // Editor redo shape: pop redo, then trim([...undoSide, current], redoSide).
    const undoCurrent = { bytes: new Uint8Array(8), marker: 5 }
    const remainingRedo = [entryOf(2, 8)]
    const trimmed = trimHistoryStacks([undoCurrent], remainingRedo, 100, 4)
    expect(trimmed.undo.length).toBe(1)
    expect(trimmed.undo[0]).toBe(undoCurrent)
    expect(trimmed.redo.map((entry) => entry.marker)).toEqual([8])
  })

  it('mixed stacks keep the newest per side and evict oldest-first', () => {
    const undo = [entryOf(3, 1), entryOf(3, 2), entryOf(3, 3)]
    const redo = [entryOf(3, 8), entryOf(3, 9)]
    const trimmed = trimHistoryStacks(undo, redo, 100, 6)
    // Newest tails survive on both sides; eviction starts at the oldest head.
    expect(trimmed.undo.at(-1)?.marker).toBe(3)
    expect(trimmed.redo.at(-1)?.marker).toBe(9)
    expect(historyByteSize(trimmed.undo) + historyByteSize(trimmed.redo)).toBeLessThanOrEqual(6)
    // Undo is eaten before redo: [2,3] + [] would fit 6, but the redo tail
    // is protected so redo keeps [9] and undo keeps only what still fits.
    expect(trimmed.redo.map((entry) => entry.marker)).toEqual([9])
    expect(trimmed.undo.map((entry) => entry.marker)).toEqual([3])
  })

  it('mixed over-budget newest pair is the documented exception', () => {
    const newestUndo = { bytes: new Uint8Array(8), marker: 3 }
    const newestRedo = { bytes: new Uint8Array(8), marker: 9 }
    const trimmed = trimHistoryStacks(
      [entryOf(1, 1), newestUndo],
      [entryOf(1, 2), newestRedo],
      100,
      10,
    )
    expect(trimmed.undo.at(-1)).toBe(newestUndo)
    expect(trimmed.redo.at(-1)).toBe(newestRedo)
    expect(trimmed.undo.map((entry) => entry.marker)).toEqual([3])
    expect(trimmed.redo.map((entry) => entry.marker)).toEqual([9])
    expect(historyByteSize(trimmed.undo) + historyByteSize(trimmed.redo)).toBeGreaterThan(10)
  })

  it('boundary: exact budget keeps all, one byte over evicts oldest only', () => {
    const undo = [entryOf(2, 1), entryOf(2, 2)]
    expect(trimHistoryStacks(undo, [], 100, 4).undo.map((entry) => entry.marker)).toEqual([1, 2])
    const over = [entryOf(2, 1), entryOf(2, 2), entryOf(1, 3)]
    const trimmed = trimHistoryStacks(over, [], 100, 4)
    expect(trimmed.undo.map((entry) => entry.marker)).toEqual([2, 3])
  })

  it('floors a non-empty side at one entry even with maxEntries 0', () => {
    const undo = [entryOf(1, 1), entryOf(1, 2)]
    const trimmed = trimHistoryStacks(undo, [], 0, Number.POSITIVE_INFINITY)
    expect(trimmed.undo.map((entry) => entry.marker)).toEqual([2])
    expect(trimmed.redo).toEqual([])
  })

  it('multi-step commit/undo/redo cycle preserves order, immutability and redo clearing', () => {
    const maxEntries = 100
    const maxBytes = 5
    const commit = <T extends { bytes: Uint8Array; marker: number }>(undo: T[], entry: T) =>
      trimHistoryStacks([...undo, entry], [], maxEntries, maxBytes)
    const undoMove = <T extends { bytes: Uint8Array; marker: number }>(undoSide: T[], redoSide: T[], current: T) =>
      trimHistoryStacks(undoSide, [...redoSide, current], maxEntries, maxBytes)
    const redoMove = <T extends { bytes: Uint8Array; marker: number }>(undoSide: T[], redoSide: T[], current: T) =>
      trimHistoryStacks([...undoSide, current], redoSide, maxEntries, maxBytes)

    const a = entryOf(2, 1)
    const b = entryOf(2, 2)
    const c = entryOf(2, 3)
    let undo: typeof a[] = []
    let redo: typeof a[] = []

    // Commit x3 with a tight budget: oldest-first eviction keeps newest order.
    let step = commit(undo, a)
    undo = step.undo
    redo = step.redo
    step = commit(undo, b)
    undo = step.undo
    redo = step.redo
    step = commit(undo, c)
    undo = step.undo
    redo = step.redo
    expect(undo.map((entry) => entry.marker)).toEqual([2, 3])
    expect(redo).toEqual([])

    // Undo: pop undo tail, push live bytes onto redo (symmetric trim).
    const popped = undo.at(-1)
    expect(popped?.marker).toBe(3)
    const undoSide = undo.slice(0, -1)
    const live = entryOf(2, 30)
    const afterUndo = undoMove(undoSide, redo, live)
    expect(afterUndo.redo.at(-1)).toBe(live)
    expect(afterUndo.undo.map((entry) => entry.marker)).toEqual([2])
    // Inputs untouched, outputs are fresh arrays.
    expect(undoSide.map((entry) => entry.marker)).toEqual([2])
    expect(afterUndo.undo).not.toBe(undoSide)

    // Redo: pop redo tail, push live bytes back onto undo.
    const redoSide = afterUndo.redo.slice(0, -1)
    const liveAgain = entryOf(2, 31)
    const afterRedo = redoMove(afterUndo.undo, redoSide, liveAgain)
    expect(afterRedo.undo.at(-1)).toBe(liveAgain)
    expect(afterRedo.undo.map((entry) => entry.marker)).toEqual([2, 31])
    expect(afterRedo.redo).toEqual([])

    // A fresh commit after undo/redo still discards redo.
    const fresh = entryOf(2, 40)
    const afterCommit = commit(afterRedo.undo, fresh)
    expect(afterCommit.redo).toEqual([])
    expect(afterCommit.undo.at(-1)).toBe(fresh)
  })
})
