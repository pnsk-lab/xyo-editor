import { describe, expect, it } from 'bun:test'

import {
  applyRedo,
  applyUndo,
  canRedo,
  canUndo,
  clearScope,
  commitEntry,
  createHistoryState,
  createPendingEntry,
  guardedCommitEntry,
  isEntryForScope,
  redoDepth,
  scopeByteSize,
  scopeIdForIdentity,
  selectScope,
  undoDepth,
  type AssetIdentity,
} from '../src/lib/asset-history-scope'

/**
 * Pure-helper regression suite for the scratch-paint switch behaviour:
 * CLEAR on switch, max 100, isolated per-asset undo/redo.
 *
 * Scope: this file only exercises the NEW pure helper
 * (`src/lib/asset-history-scope.ts`). It does not modify `Editor.svelte` or
 * any existing file, and it does not import AGPL sources.
 *
 * Assumed API / risks (see helper header for the full list):
 * - Stable `targetId` (VM `target.id`) and stable `assetId` are assumed
 *   available at snapshot time; `targetName`/`index` are restore hints only.
 * - `clear` vs `keep` on scope switch is intentionally explicit (no default).
 * - Byte budget counts stored encoded bytes per scope, not decoded RGBA.
 */

function costume(
  targetId: string,
  targetName: string,
  index: number,
  assetId = 'asset-1',
): AssetIdentity {
  return { kind: 'costume', targetId, targetName, index, assetId }
}

function sound(targetId: string, targetName: string, index: number, assetId = 'sound-1'): AssetIdentity {
  return { kind: 'sound', targetId, targetName, index, assetId }
}

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('asset-history-scope: snapshot identity and scope isolation', () => {
  it('scope key ignores display name, so rename keeps the same scope', () => {
    const before = costume('target-stable-1', 'Sprite1', 0)
    const renamed = costume('target-stable-1', 'Renamed', 0)
    expect(scopeIdForIdentity(before)).toBe(scopeIdForIdentity(renamed))
    expect(isEntryForScope(createPendingEntry(renamed, bytesOf(1), { v: 1 }), scopeIdForIdentity(before))).toBe(
      true,
    )
  })

  it('scope key ignores index when assetId is stable, so reorder keeps the same scope', () => {
    const atZero = costume('target-stable-1', 'Sprite1', 0, 'costume-aaa')
    const moved = costume('target-stable-1', 'Sprite1', 2, 'costume-aaa')
    expect(scopeIdForIdentity(atZero)).toBe(scopeIdForIdentity(moved))
  })

  it('kind / target / asset separate scopes (sound+costume mix never shares stacks)', () => {
    const costumeScope = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    const soundScope = scopeIdForIdentity(sound('t1', 'Sprite1', 0, 's1'))
    const otherCostume = scopeIdForIdentity(costume('t1', 'Sprite1', 1, 'c2'))
    const otherTarget = scopeIdForIdentity(costume('t2', 'Sprite2', 0, 'c1'))
    expect(new Set([costumeScope, soundScope, otherCostume, otherTarget]).size).toBe(4)

    let state = createHistoryState<unknown>({ maxEntries: 100 })
    state = commitEntry(state, costumeScope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(1), 0))
    state = commitEntry(state, otherCostume, createPendingEntry(costume('t1', 'Sprite1', 1, 'c2'), bytesOf(2), 0))
    state = commitEntry(state, soundScope, createPendingEntry(sound('t1', 'Sprite1', 0, 's1'), bytesOf(3), 0))

    expect(undoDepth(state, costumeScope)).toBe(1)
    expect(undoDepth(state, otherCostume)).toBe(1)
    expect(undoDepth(state, soundScope)).toBe(1)

    // Undo on one costume scope leaves the other costume and the sound untouched.
    const undone = applyUndo(state, costumeScope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(9), 0))
    expect(undone.entryToRestore?.bytes).toEqual(bytesOf(1))
    expect(undoDepth(undone.state, costumeScope)).toBe(0)
    expect(undoDepth(undone.state, otherCostume)).toBe(1)
    expect(undoDepth(undone.state, soundScope)).toBe(1)
  })
})

describe('asset-history-scope: caps and byte budget', () => {
  it('honours maxEntries per scope and drops the oldest (100-entry shape)', () => {
    let state = createHistoryState<unknown>({ maxEntries: 100 })
    const scope = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    for (let i = 0; i < 101; i += 1) {
      state = commitEntry(state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(i % 251), { i }))
    }
    expect(undoDepth(state, scope)).toBe(100)
    // Oldest dropped: first stored meta is i=1, newest is i=100.
    expect((state.scopes[scope]?.undo[0]?.meta as { i: number }).i).toBe(1)
    expect((state.scopes[scope]?.undo.at(-1)?.meta as { i: number }).i).toBe(100)
  })

  it('honours a per-scope byte budget by evicting oldest entries first', () => {
    let state = createHistoryState<unknown>({ maxEntries: 100, maxBytes: 4 })
    const scope = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    state = commitEntry(state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(1, 2), 0))
    state = commitEntry(state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(3, 4), 1))
    // 2 + 2 = 4 bytes fits.
    expect(scopeByteSize(state, scope)).toBe(4)
    state = commitEntry(state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(5, 6), 2))
    // Budget exceeded: oldest entry evicted, newest two retained.
    expect(scopeByteSize(state, scope)).toBeLessThanOrEqual(4)
    expect(undoDepth(state, scope)).toBe(2)
    expect(state.scopes[scope]?.undo.map((entry) => entry.meta)).toEqual([1, 2])
  })
})

describe('asset-history-scope: redo invalidation is scope-local', () => {
  it('commit clears only its own scope redo', () => {
    const scopeA = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    const scopeB = scopeIdForIdentity(costume('t1', 'Sprite1', 1, 'c2'))
    let state = createHistoryState<unknown>({ maxEntries: 30 })
    state = commitEntry(state, scopeA, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(1), 'a1'))
    state = commitEntry(state, scopeB, createPendingEntry(costume('t1', 'Sprite1', 1, 'c2'), bytesOf(2), 'b1'))
    const undoneA = applyUndo(state, scopeA, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(9), 'a-cur'))
    const undoneB = applyUndo(undoneA.state, scopeB, createPendingEntry(costume('t1', 'Sprite1', 1, 'c2'), bytesOf(8), 'b-cur'))
    expect(redoDepth(undoneB.state, scopeA)).toBe(1)
    expect(redoDepth(undoneB.state, scopeB)).toBe(1)

    // New edit on A drops A's redo but preserves B's redo.
    const next = commitEntry(undoneB.state, scopeA, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(7), 'a2'))
    expect(redoDepth(next, scopeA)).toBe(0)
    expect(redoDepth(next, scopeB)).toBe(1)
    expect(canRedo(next, scopeA)).toBe(false)
    expect(canRedo(next, scopeB)).toBe(true)
  })
})

describe('asset-history-scope: explicit switch policy', () => {
  it("'clear' resets the destination scope (scratch-paint CLEAR analogue)", () => {
    const scopeA = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    const scopeB = scopeIdForIdentity(costume('t1', 'Sprite1', 1, 'c2'))
    let state = createHistoryState<unknown>({ maxEntries: 100 })
    state = commitEntry(state, scopeB, createPendingEntry(costume('t1', 'Sprite1', 1, 'c2'), bytesOf(1), 0))
    expect(canUndo(state, scopeB)).toBe(true)
    state = selectScope(state, scopeA, 'clear')
    expect(state.activeScopeId).toBe(scopeA)
    state = selectScope(state, scopeB, 'clear')
    expect(canUndo(state, scopeB)).toBe(false)
    expect(undoDepth(state, scopeB)).toBe(0)
  })

  it("'keep' preserves the destination scope", () => {
    const scopeA = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    const scopeB = scopeIdForIdentity(costume('t1', 'Sprite1', 1, 'c2'))
    let state = createHistoryState<unknown>({ maxEntries: 100 })
    state = commitEntry(state, scopeB, createPendingEntry(costume('t1', 'Sprite1', 1, 'c2'), bytesOf(1), 0))
    state = selectScope(state, scopeA, 'keep')
    state = selectScope(state, scopeB, 'keep')
    expect(canUndo(state, scopeB)).toBe(true)
    expect(undoDepth(state, scopeB)).toBe(1)
  })

  it('rejects a missing/unknown policy instead of silently picking one', () => {
    const state = createHistoryState<unknown>()
    // @ts-expect-error policy is required; runtime must throw rather than guess.
    expect(() => selectScope(state, 'costume:t1:asset:c1', undefined)).toThrow(RangeError)
  })
})

describe('asset-history-scope: concurrent peek/commit safety', () => {
  it('peek is side-effect free: a no-op discards pending without touching stacks or redo', () => {
    const scope = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    let state = createHistoryState<unknown>({ maxEntries: 30 })
    state = commitEntry(state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(1), 'base'))
    const undone = applyUndo(state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(9), 'cur'))
    expect(redoDepth(undone.state, scope)).toBe(1)

    // Concurrent A peeks but decides no-op: the pending object is dropped,
    // the state object is returned untouched (same reference).
    const peekA = createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(2), 'A')
    void peekA
    const afterNoop = undone.state
    expect(afterNoop).toBe(undone.state)
    expect(redoDepth(afterNoop, scope)).toBe(1)

    // Concurrent B succeeds: redo is cleared by the successful commit only.
    // Note: 'cur' lived on the redo side after the undo above, so the commit
    // clears it and the undo side holds only B.
    const afterB = commitEntry(afterNoop, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(3), 'B'))
    expect(redoDepth(afterB, scope)).toBe(0)
    expect(afterB.scopes[scope]?.undo.map((entry) => entry.meta)).toEqual(['B'])
  })

  it('guarded commit no-ops on stale generation / scope change (redo preserved)', () => {
    const scopeA = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    const scopeB = scopeIdForIdentity(costume('t1', 'Sprite1', 1, 'c2'))
    let state = createHistoryState<unknown>({ maxEntries: 30 })
    state = { ...state, activeScopeId: scopeA }
    const guard = { generation: state.generation, activeScopeId: state.activeScopeId }
    // Meanwhile another edit lands and the selection switches away.
    const advanced = selectScope(
      commitEntry(state, scopeA, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(1), 'other')),
      scopeB,
      'keep',
    )
    const stale = guardedCommitEntry(
      advanced,
      scopeA,
      createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(2), 'late-A'),
      guard,
    )
    expect(stale).toBe(advanced)
    expect(undoDepth(stale, scopeA)).toBe(1)
    expect((stale.scopes[scopeA]?.undo[0]?.meta as string)).toBe('other')
  })

  it('undo/redo round-trip restores entries with an explicit current snapshot', () => {
    const scope = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    let state = createHistoryState<unknown>({ maxEntries: 30 })
    state = commitEntry(state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(1), 'v1'))
    const undone = applyUndo(state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(2), 'v2-cur'))
    expect(undone.entryToRestore?.meta).toBe('v1')
    expect(redoDepth(undone.state, scope)).toBe(1)
    const redone = applyRedo(undone.state, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(1), 'v1-cur'))
    expect(redone.entryToRestore?.meta).toBe('v2-cur')
    expect(undoDepth(redone.state, scope)).toBe(1)
  })
})

describe('asset-history-scope: corruption guards and purity', () => {
  it('copies bytes on peek and commit (caller mutation cannot corrupt history)', () => {
    const scope = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    const source = bytesOf(1, 2, 3)
    const pending = createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), source, 0)
    source[0] = 99
    expect(pending.bytes[0]).toBe(1)
    const pendingBytes = pending.bytes
    const state = commitEntry(createHistoryState<unknown>(), scope, pending)
    pendingBytes[1] = 99
    expect(state.scopes[scope]?.undo[0]?.bytes).toEqual(bytesOf(1, 2, 3))
  })

  it('never mutates input state (all transforms return fresh objects)', () => {
    const scope = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    const base = createHistoryState<unknown>({ maxEntries: 10 })
    const committed = commitEntry(base, scope, createPendingEntry(costume('t1', 'Sprite1', 0, 'c1'), bytesOf(1), 0))
    expect(base.scopes[scope]).toBeUndefined()
    expect(committed).not.toBe(base)
    const undone = applyUndo(committed, scope)
    expect(committed.scopes[scope]?.undo.length).toBe(1)
    expect(undone.state.scopes[scope]?.undo.length).toBe(0)
    const cleared = clearScope(committed, scope)
    expect(committed.scopes[scope]?.undo.length).toBe(1)
    expect(cleared.scopes[scope]?.undo.length).toBe(0)
  })

  it('empty undo/redo returns the same state object with no entry', () => {
    const scope = scopeIdForIdentity(costume('t1', 'Sprite1', 0, 'c1'))
    const state = createHistoryState<unknown>()
    expect(applyUndo(state, scope).state).toBe(state)
    expect(applyUndo(state, scope).entryToRestore).toBeUndefined()
    expect(applyRedo(state, scope).state).toBe(state)
    expect(applyRedo(state, scope).entryToRestore).toBeUndefined()
  })
})
