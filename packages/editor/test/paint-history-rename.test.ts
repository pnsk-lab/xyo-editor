import { describe, expect, it } from 'bun:test'
import {
  historyCostumeRestorePatch,
  planPostRenameAdoption,
} from '../src/features/costumes/paint-history-rename'

// Pure-helper edge coverage for the rename handoff. No product code is
// touched; these tests pin the fail-closed adoption contract the Editor
// relies on (draw -> rename -> Undo keeps the new name, external drift
// before rename stays fail-closed).
describe('paint-history-rename pure helpers', () => {
  it('strips name without mutating the input and keeps geometry metadata', () => {
    const meta = {
      name: 'old',
      dataFormat: 'png',
      rotationCenterX: 16,
      rotationCenterY: 16,
      bitmapResolution: 2,
      assetId: 'a',
    }
    const patched = historyCostumeRestorePatch(meta)
    expect('name' in patched).toBe(false)
    expect(patched).toEqual({
      dataFormat: 'png',
      rotationCenterX: 16,
      rotationCenterY: 16,
      bitmapResolution: 2,
      assetId: 'a',
    })
    // Input untouched.
    expect(meta.name).toBe('old')
  })

  it('keeps an already-nameless patch intact (fresh object)', () => {
    const meta = { dataFormat: 'svg', rotationCenterX: 1, rotationCenterY: 2 }
    const patched = historyCostumeRestorePatch(meta)
    expect(patched).toEqual(meta)
    expect(patched).not.toBe(meta)
  })

  it('does not leak prototype or extra fields', () => {
    const meta = { name: 'n', dataFormat: 'png' } as Record<string, unknown>
    const patched = historyCostumeRestorePatch(meta)
    expect(Object.keys(patched).sort()).toEqual(['dataFormat'])
  })

  it('adopts with no baseline (first rename establishes known)', () => {
    const plan = planPostRenameAdoption({
      targetId: 't1',
      index: 0,
      hasKnown: false,
      liveBeforeStale: false,
      gestures: [],
    })
    expect(plan).toEqual({ adoptKnown: true, advanceGestureKeys: [] })
  })

  it('adopts in-sync slot and advances only matching in-sync gestures', () => {
    const plan = planPostRenameAdoption({
      targetId: 't1',
      index: 0,
      hasKnown: true,
      liveBeforeStale: false,
      gestures: [
        { key: 1, targetId: 't1', index: 0, conflicted: false, stale: false },
        // Other slot: never advances (commute guard).
        { key: 2, targetId: 't1', index: 1, conflicted: false, stale: false },
        // Other target: never advances.
        { key: 3, targetId: 't2', index: 0, conflicted: false, stale: false },
        // Already conflicted: pinned.
        { key: 4, targetId: 't1', index: 0, conflicted: true, stale: false },
        // Stale vs pre-rename live: pinned.
        { key: 5, targetId: 't1', index: 0, conflicted: false, stale: true },
      ],
    })
    expect(plan).toEqual({ adoptKnown: true, advanceGestureKeys: [1] })
  })

  it('stays fail-closed when unseen drift landed before rename', () => {
    const plan = planPostRenameAdoption({
      targetId: 't1',
      index: 0,
      hasKnown: true,
      liveBeforeStale: true,
      gestures: [{ key: 9, targetId: 't1', index: 0, conflicted: false, stale: false }],
    })
    // No adoption, no gesture touch: next Undo/Redo must still refuse.
    expect(plan).toEqual({ adoptKnown: false, advanceGestureKeys: [] })
  })

  it('ignores liveBeforeStale when there is no baseline to be stale against', () => {
    const plan = planPostRenameAdoption({
      targetId: 't1',
      index: 0,
      hasKnown: false,
      liveBeforeStale: true,
      gestures: [{ key: 7, targetId: 't1', index: 0, conflicted: false, stale: false }],
    })
    expect(plan).toEqual({ adoptKnown: true, advanceGestureKeys: [7] })
  })

  it('empty gesture list never advances', () => {
    const plan = planPostRenameAdoption({
      targetId: 't1',
      index: 3,
      hasKnown: true,
      liveBeforeStale: false,
      gestures: [],
    })
    expect(plan).toEqual({ adoptKnown: true, advanceGestureKeys: [] })
  })
})
