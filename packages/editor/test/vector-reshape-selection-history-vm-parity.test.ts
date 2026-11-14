// Real-VM eviction parity: 70 distinct ~64KiB SVG states through the REAL
// `ScratchVM` (real `storeAsset`/`loadAsset`, real per-slot `writeSeq`, real
// project generation) + the REAL history policy (`trimHistoryStacks` with
// `PAINT_HISTORY_MAX_ENTRIES`/`PAINT_HISTORY_MAX_BYTES`) + the REAL selection
// helper, mirroring the exact `Editor.svelte` peek/commit/undo shapes
// (per-entry `WeakMap` snapshots with private copies, 64-slot committed
// priors, delete-gate prior merge, redo-gate prior preference, restore +
// re-baseline). Then undo ALL the way back to the oldest entry and prove:
// live bytes are byte-identical to the oldest committed bytes (fresh
// `loadAsset` buffer, never a self-compare), the restored selection is
// exactly object 4 / [4] / masks {4:3}, the redo side holds exactly the 69
// expected states with no extras, and tampered/cross-slot/stale-seq inputs
// still fail closed. Fail-first: on the pre-fix 4MiB LRU tracker the oldest
// entry's freshness check returns false for valid unchanged bytes (silent
// selection loss on Undo); post-fix every entry stays usable with private
// copies (snapshots own their bytes, never `entry.bytes` by reference).
//
// Fixture honesty: the VM's SVG pipeline drops XML comments on store, so
// padding hidden in a comment would collapse every state to ~232 stored
// bytes and prove nothing about the 64KiB regime. Distinctness and bulk live
// in real elements (850 rects with per-state geometry, all within the exact
// cap), and the canonical ground truth is the READ-BACK stored bytes -- the
// same bytes the Editor's peek/commit gates observe.
import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import {
  PAINT_HISTORY_MAX_BYTES,
  PAINT_HISTORY_MAX_ENTRIES,
  trimHistoryStacks,
} from '../src/lib/paint-history'
import type { AssetHistoryEntry } from '../src/lib/editor-types'
import {
  buildSelectionSnapshot,
  cloneSelectionSnapshot,
  equalSelectionBytes,
  isSelectionSnapshotForSlot,
  isSelectionSnapshotFreshForBytes,
  isSelectionSnapshotStale,
  isSelectionSnapshotUsableForSlot,
  mergeSelectionAtPriorCommitted,
  normalizeSelectionSnapshot,
  reshapeSelectionSlotKey,
  validateSelectionSnapshotForAnchors,
  validateSelectionSnapshotForObjects,
  type ReshapeSelectionSnapshot,
} from '../src/features/costumes/vector-reshape-selection-history'

const textEncoder = new TextEncoder()

function fixtureBytesForIndex(i: number): Uint8Array {
  // Sanitizer-proof bulk: 850 rects whose geometry shifts per state, so the
  // STORED bytes stay distinct and near the 64KiB cap (comments would be
  // stripped on store and must not carry distinctness or bulk).
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g id="v${String(
    i,
  ).padStart(4, '0')}">`
  const tail = `</g></svg>`
  let body = ''
  for (let k = 0; k < 1100; k += 1) {
    const x = (k * 37 + i * 13 + ((i * i) % 29)) % 460
    const y = (k * 53 + i * 7 + ((i * i * 3) % 31)) % 340
    const r = (k * 31 + i * 17) & 0xff
    const g = (k * 57 + i * 23) & 0xff
    const b = (k * 91 + i * 41) & 0xff
    const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
      .toString(16)
      .padStart(2, '0')}`
    body += `<rect x="${x}" y="${y}" width="3" height="4" fill="${hex}"/>`
  }
  return textEncoder.encode(`${head}${body}${tail}`)
}

const SELECTION = { objectIndex: 4, selectedObjectIndices: [4], masks: { 4: 3 }, leafIndices: [4] } as const

describe('real-VM eviction parity: 70 x ~64KiB states, undo to oldest keeps bytes + selection 4/3', () => {
  it('undo back to the oldest entry restores exact bytes and selection 4/3 with no stale redo', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(createDefaultProject())
    const target = vm.getTarget('Sprite1')
    expect(target).toBeDefined()
    const targetName = target!.name
    const targetId = (target!.id ?? targetName) as string
    const costumeIndex = 0
    const slotKey = reshapeSelectionSlotKey(targetId, costumeIndex)
    expect(target!.costumes.length).toBeGreaterThan(0)

    const liveBytes = async (): Promise<Uint8Array> => {
      const costume = vm.getTarget('Sprite1')!.costumes[costumeIndex]!
      const key = costume.md5ext ?? costume.assetId
      const raw = await vm.loadAsset(key, costume.dataFormat ?? 'svg')
      if (!raw) throw new Error('live bytes missing')
      return new Uint8Array(raw)
    }
    const liveSeq = (): number | null => {
      try {
        const identity = (
          vm as unknown as {
            getCostumeIdentity?: (t: string, i: number) => { writeSeq?: unknown }
          }
        ).getCostumeIdentity?.(targetId, costumeIndex)
        const seq = identity?.writeSeq
        return typeof seq === 'number' && Number.isInteger(seq) ? seq : null
      } catch {
        return null
      }
    }
    const generationOf = (): number => {
      try {
        return (
          (vm as unknown as { getProjectGeneration?: () => number }).getProjectGeneration?.() ?? 0
        )
      } catch {
        return 0
      }
    }

    let paintUndoStack: AssetHistoryEntry[] = []
    let paintRedoStack: AssetHistoryEntry[] = []
    const historyReshapeSelection = new WeakMap<AssetHistoryEntry, ReshapeSelectionSnapshot>()
    const committedReshapeSelectionBySlot = new Map<string, ReshapeSelectionSnapshot>()
    const appliedSelections: Array<{
      objectIndex: number
      selectedObjectIndices: number[]
      masks: Record<number, number>
    }> = []

    const snapshotCurrentFor = (
      bytes: Uint8Array,
    ): ReshapeSelectionSnapshot | undefined => {
      const snapshot = buildSelectionSnapshot({
        targetId,
        index: costumeIndex,
        projectGeneration: generationOf(),
        writeSeq: liveSeq(),
        bytes,
        objectIndex: SELECTION.objectIndex,
        selectedObjectIndices: [...SELECTION.selectedObjectIndices],
        masks: { ...SELECTION.masks },
        leafIndices: [...SELECTION.leafIndices],
      })
      return snapshot ? cloneSelectionSnapshot(snapshot) : undefined
    }
    const priorForSlot = (): ReshapeSelectionSnapshot | undefined => {
      const prior = committedReshapeSelectionBySlot.get(slotKey)
      const normalized = normalizeSelectionSnapshot(cloneSelectionSnapshot(prior))
      if (!normalized) return undefined
      if (normalized.targetId !== targetId || normalized.index !== costumeIndex) return undefined
      if (normalized.slotKey !== slotKey || normalized.projectGeneration !== generationOf()) {
        return undefined
      }
      if (isSelectionSnapshotStale(normalized, liveSeq())) return undefined
      return cloneSelectionSnapshot(normalized)
    }
    const rememberCommitted = (bytes: Uint8Array): void => {
      const snapshot = buildSelectionSnapshot({
        targetId,
        index: costumeIndex,
        projectGeneration: generationOf(),
        writeSeq: liveSeq(),
        bytes,
        objectIndex: SELECTION.objectIndex,
        selectedObjectIndices: [...SELECTION.selectedObjectIndices],
        masks: { ...SELECTION.masks },
        leafIndices: [...SELECTION.leafIndices],
      })
      if (!snapshot) {
        committedReshapeSelectionBySlot.delete(slotKey)
        return
      }
      committedReshapeSelectionBySlot.set(slotKey, snapshot)
      if (committedReshapeSelectionBySlot.size > 64) {
        const first = committedReshapeSelectionBySlot.keys().next().value as string | undefined
        if (first && first !== slotKey) committedReshapeSelectionBySlot.delete(first)
      }
    }

    // Canonical states: write each fixture, then read back the STORED bytes
    // (exactly what the Editor's peek/commit gates observe). The stored form
    // must stay in the exact-cap regime and pairwise distinct, or the test
    // proves nothing about per-entry retention.
    const states: Uint8Array[] = []
    for (let i = 0; i < 70; i += 1) {
      await vm.updateCostume(targetName, costumeIndex, { dataFormat: 'svg' }, fixtureBytesForIndex(i))
      states.push(await liveBytes())
    }
    for (const [i, bytes] of states.entries()) {
      expect(bytes.length).toBeGreaterThan(60000)
      expect(bytes.length).toBeLessThanOrEqual(65536)
      expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('<svg')
    }
    for (let a = 0; a < states.length; a += 1) {
      for (const b of [a + 1, a + 7, states.length - 1]) {
        if (b >= states.length || b === a) continue
        expect(equalSelectionBytes(states[a]!, states[b]!)).toBe(false)
      }
    }

    // Reset to state 0 with no history (mirrors project load), then run the
    // 69 edits through the exact peek/commit shapes.
    await vm.updateCostume(targetName, costumeIndex, { dataFormat: 'svg' }, states[0]!)
    rememberCommitted((await liveBytes()).slice())
    for (let i = 1; i < 70; i += 1) {
      const preBytes = await liveBytes()
      expect(equalSelectionBytes(preBytes, states[i - 1]!)).toBe(true)
      const entry: AssetHistoryEntry = {
        kind: 'costume',
        targetName,
        index: costumeIndex,
        meta: structuredClone(vm.getTarget('Sprite1')!.costumes[costumeIndex]!),
        bytes: new Uint8Array(preBytes),
      }
      // Per-entry snapshot owns a PRIVATE copy (never `entry.bytes` by
      // reference): pass a copy in, the helper copies again at the boundary.
      const current = snapshotCurrentFor(entry.bytes.slice())
      if (current) historyReshapeSelection.set(entry, current)
      const trimmed = trimHistoryStacks(
        [...paintUndoStack, entry],
        [],
        PAINT_HISTORY_MAX_ENTRIES,
        PAINT_HISTORY_MAX_BYTES,
      )
      paintUndoStack = trimmed.undo
      paintRedoStack = trimmed.redo
      await vm.updateCostume(targetName, costumeIndex, { dataFormat: 'svg' }, states[i]!)
      rememberCommitted((await liveBytes()).slice())
    }
    expect(paintUndoStack.length).toBe(69)
    expect(paintRedoStack.length).toBe(0)

    // Private-copy proof: every per-entry snapshot owns bytes EQUAL to (but
    // never the same object as) its entry's bytes.
    for (const entry of paintUndoStack) {
      const snap = historyReshapeSelection.get(entry)
      expect(snap).toBeDefined()
      expect(snap!.bytesExact).toBeDefined()
      expect(snap!.bytesExact).not.toBe(entry.bytes)
      expect(equalSelectionBytes(snap!.bytesExact, entry.bytes)).toBe(true)
    }

    // Delete-gate shape (Editor.svelte): the committed prior must be fresh
    // for the live pre-delete bytes (distinct buffers), tampered bytes fail.
    {
      const pendingPreDelete = await liveBytes()
      const candidate = priorForSlot()
      expect(candidate).toBeDefined()
      expect(pendingPreDelete).not.toBe(candidate!.bytesExact)
      expect(equalSelectionBytes(pendingPreDelete, states[69]!)).toBe(true)
      expect(isSelectionSnapshotFreshForBytes(candidate, pendingPreDelete)).toBe(true)
      const tampered = pendingPreDelete.slice()
      tampered[500] = (tampered[500] as number) ^ 0x01
      expect(isSelectionSnapshotFreshForBytes(candidate, tampered)).toBe(false)
      const merged = mergeSelectionAtPriorCommitted(candidate)
      expect(merged?.selectedObjectIndices).toEqual([4])
      expect(merged?.masks).toEqual({ 4: 3 })
    }

    // Undo ALL the way back (mirrors undoHistorySide incl. the redo gate).
    const oldestEntry = paintUndoStack[0]!
    const oldestBytes = oldestEntry.bytes.slice()
    for (let step = 0; step < 69; step += 1) {
      const entry = paintUndoStack.at(-1)!
      // Redo-side capture of the live post-state bytes (real loadAsset copy).
      const livePre = await liveBytes()
      const next: AssetHistoryEntry = {
        kind: 'costume',
        targetName,
        index: costumeIndex,
        meta: structuredClone(vm.getTarget('Sprite1')!.costumes[costumeIndex]!),
        bytes: new Uint8Array(livePre),
      }
      let usedPrior = false
      const prior = priorForSlot()
      if (prior && isSelectionSnapshotFreshForBytes(prior, next.bytes)) {
        if (!isSelectionSnapshotStale(prior, liveSeq())) {
          const cloned = cloneSelectionSnapshot(prior)
          if (cloned) {
            historyReshapeSelection.set(next, cloned)
            usedPrior = true
          }
        }
      }
      if (!usedPrior) {
        const current = snapshotCurrentFor(next.bytes)
        if (current) historyReshapeSelection.set(next, current)
      }
      paintUndoStack = paintUndoStack.slice(0, -1)
      const trimmed = trimHistoryStacks(
        paintUndoStack,
        [...paintRedoStack, next],
        PAINT_HISTORY_MAX_ENTRIES,
        PAINT_HISTORY_MAX_BYTES,
      )
      paintUndoStack = trimmed.undo
      paintRedoStack = trimmed.redo
      // Restore the entry's own bytes through the real VM.
      await vm.updateCostume(targetName, entry.index, { dataFormat: 'svg' }, entry.bytes)
      // Apply the entry's snapshot (slot+generation guarded, verbatim indices).
      const snapshot = historyReshapeSelection.get(entry)
      expect(snapshot).toBeDefined()
      expect(snapshot!.targetId).toBe(targetId)
      expect(snapshot!.projectGeneration).toBe(generationOf())
      appliedSelections.push({
        objectIndex: snapshot!.objectIndex,
        selectedObjectIndices: [...snapshot!.selectedObjectIndices],
        masks: { ...snapshot!.masks },
      })
      rememberCommitted((await liveBytes()).slice())
    }

    // Proved on the oldest entry: bytes correct (distinct fresh buffer) AND
    // the exact selected object/masks -- the pre-fix tracker eviction lost
    // the selection here (fresh false for valid unchanged bytes).
    const restoredLive = await liveBytes()
    expect(restoredLive).not.toBe(oldestEntry.bytes)
    expect(equalSelectionBytes(restoredLive, oldestBytes)).toBe(true)
    expect(equalSelectionBytes(restoredLive, states[0]!)).toBe(true)
    const oldestSnapshot = historyReshapeSelection.get(oldestEntry)!
    expect(oldestSnapshot.selectedObjectIndices).toEqual([4])
    expect(oldestSnapshot.objectIndex).toBe(4)
    expect(oldestSnapshot.masks).toEqual({ 4: 3 })
    // Entry-owned restore (the Editor's undo path) requires slot/generation
    // + exact bytes only -- never seq freshness: the snapshot is bound to the
    // immutable entry bytes by construction. Seq staleness correctly marks it
    // stale for PRIOR-reuse gates (a later delete/redo must not resurrect it
    // as "current"), while its own entry still restores -- exactly the
    // Editor's apply path, which performs no seq check.
    expect(isSelectionSnapshotForSlot(oldestSnapshot, targetId, costumeIndex, generationOf())).toBe(
      true,
    )
    expect(isSelectionSnapshotFreshForBytes(oldestSnapshot, restoredLive)).toBe(true)
    expect(isSelectionSnapshotStale(oldestSnapshot, liveSeq())).toBe(true)
    const lastApplied = appliedSelections[appliedSelections.length - 1]!
    expect(lastApplied.objectIndex).toBe(4)
    expect(lastApplied.selectedObjectIndices).toEqual([4])
    expect(lastApplied.masks).toEqual({ 4: 3 })

    // No extra stale assets: undo is empty, redo holds exactly the 69
    // expected post-states in order (top restores state 1 first).
    expect(paintUndoStack.length).toBe(0)
    expect(paintRedoStack.length).toBe(69)
    const redoTop = paintRedoStack[paintRedoStack.length - 1]!
    expect(equalSelectionBytes(redoTop.bytes, states[1]!)).toBe(true)
    const redoBottom = paintRedoStack[0]!
    expect(equalSelectionBytes(redoBottom.bytes, states[69]!)).toBe(true)
    for (let k = 0; k < paintRedoStack.length; k += 1) {
      const redoEntry = paintRedoStack[k]!
      expect(equalSelectionBytes(redoEntry.bytes, states[69 - k]!)).toBe(true)
      const redoSnap = historyReshapeSelection.get(redoEntry)
      expect(redoSnap).toBeDefined()
      expect(redoSnap!.selectedObjectIndices).toEqual([4])
    }

    // Fail-closed guards still hold on the oldest snapshot: tampered bytes,
    // cross-slot alias with identical bytes, and a same-bytes external
    // writeSeq bump all reject.
    const tamperedOldest = oldestBytes.slice()
    tamperedOldest[777] = (tamperedOldest[777] as number) ^ 0x01
    expect(isSelectionSnapshotFreshForBytes(oldestSnapshot, tamperedOldest)).toBe(false)
    expect(
      isSelectionSnapshotUsableForSlot(
        oldestSnapshot,
        'namesake',
        costumeIndex,
        generationOf(),
        liveSeq(),
        restoredLive,
      ),
    ).toBe(false)
    // Same-bytes external write bumps the slot seq: a freshly remembered
    // prior is usable before the write and rejected after (seq CAS), even
    // though the bytes are identical.
    const liveNow = await liveBytes()
    rememberCommitted(liveNow.slice())
    const freshPrior = priorForSlot()!
    const liveNowAgain = await liveBytes()
    expect(
      isSelectionSnapshotUsableForSlot(
        freshPrior,
        targetId,
        costumeIndex,
        generationOf(),
        liveSeq(),
        liveNowAgain,
      ),
    ).toBe(true)
    const seqBefore = liveSeq()
    await vm.updateCostume(targetName, costumeIndex, { dataFormat: 'svg' }, liveNowAgain.slice())
    const seqAfter = liveSeq()
    expect(typeof seqAfter).toBe('number')
    expect(seqAfter).not.toBe(seqBefore)
    expect(isSelectionSnapshotStale(freshPrior, seqAfter)).toBe(true)
    expect(
      isSelectionSnapshotUsableForSlot(
        freshPrior,
        targetId,
        costumeIndex,
        generationOf(),
        seqAfter,
        await liveBytes(),
      ),
    ).toBe(false)

    // Anchor/object validation of the restored selection stays verbatim and
    // fail-closed (no retarget onto wrong units).
    expect(validateSelectionSnapshotForObjects(oldestSnapshot, [4])?.selectedObjectIndices).toEqual([
      4,
    ])
    expect(validateSelectionSnapshotForObjects(oldestSnapshot, [0])).toBeUndefined()
    expect(
      validateSelectionSnapshotForAnchors(oldestSnapshot, [{ index: 4, x: 1, y: 2 }])?.masks,
    ).toEqual({ 4: 3 })
  }, 180000)
})
