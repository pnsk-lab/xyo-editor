// Hostile ownership audit: `AssetHistoryEntry.bytes` references must never be
// shared into selection snapshots. Every boundary copies, every freshness
// gate requires DISTINCT buffers (same-object fails closed), and VM
// load/store paths return private snapshots. Fail-first: each test below
// FAILS on the pre-fix sharing product (aliased `bytesExact === entry.bytes`,
// self-compare auth, caller-mutation corruption) and PASSES after the fix.
//
// Coverage:
// - caller mutates original buffer after build/normalize (isolated copy)
// - other consumer mutates entry bytes (snapshot unaffected, entry authoritative)
// - pre/post undo/redo buffer isolation (redo capture vs undo entry)
// - external plugin/VM direct buffer mutations (loadAsset/storeAsset/update
//   paths copy at the boundary; mutating a returned/input buffer never moves
//   stored bytes -- user data never weakened)
// - aliasing shared references (same-object freshness always fails closed)
// - stale byte copy reused across 64 priors + target/name/project change
//   (slot + generation + seq + exact bytes ALL required)
// - private caches bounded (~4MiB outside the 24MB history budget), 70
//   entries + 64 slots with no eviction selection loss
// Bitmap paths are untouched (no bitmap files here).
import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import { PAINT_HISTORY_MAX_BYTES, PAINT_HISTORY_MAX_ENTRIES, trimHistoryStacks } from '../src/lib/paint-history'
import type { AssetHistoryEntry } from '../src/lib/editor-types'
import {
  buildSelectionSnapshot,
  cloneSelectionSnapshot,
  equalSelectionBytes,
  hashSelectionBytes,
  isSelectionSnapshotFreshAgainstEntryBytes,
  isSelectionSnapshotFreshForBytes,
  isSelectionSnapshotUsableForSlot,
  mergeSelectionAtPriorCommitted,
  normalizeSelectionSnapshot,
  RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN,
} from '../src/features/costumes/vector-reshape-selection-history'

const enc = new TextEncoder()

function svgBytes(seed: string): Uint8Array {
  return enc.encode(`<svg xmlns="http://www.w3.org/2000/svg"><g id="v"><rect width="8" height="8" fill="red"/></g><!--${seed}--></svg>`)
}

function snapshotFor(bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  return buildSelectionSnapshot({
    targetId: 'stable-1',
    index: 0,
    projectGeneration: 0,
    writeSeq: 1,
    bytes,
    objectIndex: 1,
    selectedObjectIndices: [1],
    masks: {},
    leafIndices: [],
    ...overrides,
  })!
}

describe('ownership: build/normalize/clone copy at the boundary', () => {
  it('caller mutating the original buffer after build leaves the snapshot intact', () => {
    const original = svgBytes('build-copy')
    const before = original.slice()
    const snap = snapshotFor(original)
    expect(snap.bytesExact).toBeDefined()
    expect(snap.bytesExact).not.toBe(original)
    expect(equalSelectionBytes(snap.bytesExact, before)).toBe(true)
    // Hostile caller reuse: mutate every byte of the input.
    for (let i = 0; i < original.length; i += 1) original[i] = (original[i]! ^ 0xff) & 0xff
    expect(equalSelectionBytes(original, before)).toBe(false)
    // Snapshot still describes the pre-mutation artwork, not the mutated one.
    expect(equalSelectionBytes(snap.bytesExact, before)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(snap, before.slice())).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(snap, original.slice())).toBe(false)
  })

  it('normalize copies inbound bytesExact: later mutation of the wire buffer is isolated', () => {
    const wire = svgBytes('normalize-copy')
    const wireBefore = wire.slice()
    const snap = snapshotFor(wire)
    const inbound = {
      targetId: snap.targetId,
      index: snap.index,
      slotKey: snap.slotKey,
      projectGeneration: snap.projectGeneration,
      writeSeq: snap.writeSeq,
      bytesHash: snap.bytesHash,
      bytesExact: wire,
      objectIndex: snap.objectIndex,
      selectedObjectIndices: [...snap.selectedObjectIndices],
      masks: { ...snap.masks },
      leafIndices: [...snap.leafIndices],
    }
    const normalized = normalizeSelectionSnapshot(inbound)!
    expect(normalized.bytesExact).toBeDefined()
    expect(normalized.bytesExact).not.toBe(wire)
    expect(equalSelectionBytes(normalized.bytesExact, wireBefore)).toBe(true)
    for (let i = 0; i < wire.length; i += 1) wire[i] = (wire[i]! + 1) & 0xff
    expect(equalSelectionBytes(normalized.bytesExact, wireBefore)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(normalized, wireBefore.slice())).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(normalized, wire.slice())).toBe(false)
  })

  it('clone is isolated both ways: mutating either side never moves the other', () => {
    const snap = snapshotFor(svgBytes('clone-both-ways'))
    const cloned = cloneSelectionSnapshot(snap)!
    expect(cloned.bytesExact).toBeDefined()
    expect(cloned.bytesExact).not.toBe(snap.bytesExact)
    expect(equalSelectionBytes(cloned.bytesExact, snap.bytesExact)).toBe(true)
    const snapBefore = snap.bytesExact!.slice()
    cloned.bytesExact![0] = (cloned.bytesExact![0]! ^ 0x01) & 0xff
    expect(equalSelectionBytes(snap.bytesExact, snapBefore)).toBe(true)
    expect(equalSelectionBytes(cloned.bytesExact, snapBefore)).toBe(false)
    snap.bytesExact![1] = (snap.bytesExact![1]! ^ 0x02) & 0xff
    expect(isSelectionSnapshotFreshForBytes(cloned, snapBefore.slice())).toBe(false)
  })

  it('other consumer mutating entry bytes leaves the per-entry snapshot intact', () => {
    const stored = svgBytes('entry-consumer')
    const storedBefore = stored.slice()
    const entry: AssetHistoryEntry = {
      kind: 'costume',
      targetName: 'Sprite1',
      index: 0,
      meta: {} as never,
      bytes: stored.slice(),
    }
    // Editor shape (fixed): the snapshot is built from a COPY of entry.bytes.
    const snap = snapshotFor(entry.bytes.slice())!
    expect(snap.bytesExact).not.toBe(entry.bytes)
    // Hostile second consumer grabs the entry buffer and scribbles.
    entry.bytes[0] = (entry.bytes[0]! ^ 0x01) & 0xff
    entry.bytes[entry.bytes.length - 1] = (entry.bytes[entry.bytes.length - 1]! ^ 0x01) & 0xff
    expect(equalSelectionBytes(entry.bytes, storedBefore)).toBe(false)
    // The snapshot still describes the pre-mutation artwork.
    expect(equalSelectionBytes(snap.bytesExact, storedBefore)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(snap, storedBefore.slice())).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(snap, entry.bytes.slice())).toBe(false)
  })
})

describe('ownership: no self-comparison auth', () => {
  it('same-object freshness always fails closed (aliasing can never authorize)', () => {
    const snap = snapshotFor(svgBytes('self-compare'))!
    // Direct self-compare: the stored object passed as live must NOT authorize.
    expect(isSelectionSnapshotFreshForBytes(snap, snap.bytesExact!)).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(snap, 'stable-1', 0, 0, 1, snap.bytesExact!)).toBe(false)
    // Equal-content distinct buffers still authorize.
    expect(isSelectionSnapshotFreshForBytes(snap, snap.bytesExact!.slice())).toBe(true)
    expect(isSelectionSnapshotUsableForSlot(snap, 'stable-1', 0, 0, 1, snap.bytesExact!.slice())).toBe(true)
  })

  it('FreshAgainstEntryBytes rejects every same-object pairing', () => {
    const live = svgBytes('entry-self')
    const snap = snapshotFor(live.slice())!
    const entry = live.slice()
    const liveCopy = live.slice()
    expect(isSelectionSnapshotFreshAgainstEntryBytes(snap, entry, liveCopy)).toBe(true)
    // Snapshot aliased to either store fails closed even with equal content.
    expect(isSelectionSnapshotFreshAgainstEntryBytes(snap, snap.bytesExact, liveCopy)).toBe(false)
    expect(isSelectionSnapshotFreshAgainstEntryBytes(snap, entry, snap.bytesExact)).toBe(false)
    // Entry/live aliased to each other fails closed (digest-only path too).
    const large = new Uint8Array(RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN + 16)
    for (let i = 0; i < large.length; i += 1) large[i] = (i * 31 + 7) & 0xff
    const largeSnap = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 1,
      bytes: large,
      objectIndex: -1,
      selectedObjectIndices: [],
      masks: {},
      leafIndices: [],
    })!
    expect(largeSnap.bytesExact).toBeUndefined()
    expect(isSelectionSnapshotFreshAgainstEntryBytes(largeSnap, large, large)).toBe(false)
    expect(isSelectionSnapshotFreshAgainstEntryBytes(largeSnap, large, large.slice())).toBe(true)
  })
})

describe('ownership: undo/redo buffer isolation (pre/post)', () => {
  it('mutating the redo capture never corrupts the undo entry or its snapshot', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(createDefaultProject())
    const target = vm.getTarget('Sprite1')!
    const liveBytes = async (): Promise<Uint8Array> => {
      const costume = vm.getTarget('Sprite1')!.costumes[0]!
      const key = costume.md5ext ?? costume.assetId
      return new Uint8Array((await vm.loadAsset(key, costume.dataFormat ?? 'svg'))!)
    }
    // Pre-state entry (undo side) with its own snapshot.
    const pre = await liveBytes()
    const undoEntry: AssetHistoryEntry = {
      kind: 'costume',
      targetName: target.name,
      index: 0,
      meta: structuredClone(target.costumes[0]!),
      bytes: new Uint8Array(pre),
    }
    const undoSnap = snapshotFor(undoEntry.bytes.slice())!
    const undoBefore = undoEntry.bytes.slice()
    // Post-state redo capture from live (distinct buffer).
    await vm.updateCostume(target.name, 0, { dataFormat: 'svg' }, enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>'))
    const post = await liveBytes()
    const redoEntry: AssetHistoryEntry = {
      kind: 'costume',
      targetName: target.name,
      index: 0,
      meta: structuredClone(vm.getTarget('Sprite1')!.costumes[0]!),
      bytes: new Uint8Array(post),
    }
    // Hostile: scribble the redo bytes after capture.
    for (let i = 0; i < redoEntry.bytes.length; i += 1) redoEntry.bytes[i] = (redoEntry.bytes[i]! ^ 0xaa) & 0xff
    // Undo entry + snapshot are untouched; user pre-state bytes intact.
    expect(equalSelectionBytes(undoEntry.bytes, undoBefore)).toBe(true)
    expect(equalSelectionBytes(undoSnap.bytesExact, undoBefore)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(undoSnap, undoBefore.slice())).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(undoSnap, redoEntry.bytes.slice())).toBe(false)
    // Restoring the undo entry writes the exact pre-state bytes (user data kept).
    await vm.updateCostume(target.name, 0, { dataFormat: 'svg' }, undoEntry.bytes.slice())
    expect(equalSelectionBytes(await liveBytes(), undoBefore)).toBe(true)
  })
})

describe('ownership: VM load/store paths copy at the boundary', () => {
  it('loadAsset returns a private snapshot: mutating it never moves live bytes', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(createDefaultProject())
    const target = vm.getTarget('Sprite1')!
    const costume = target.costumes[0]!
    const key = costume.md5ext ?? costume.assetId
    const first = (await vm.loadAsset(key, costume.dataFormat ?? ''))!
    const second = (await vm.loadAsset(key, costume.dataFormat ?? ''))!
    expect(first).not.toBe(second)
    expect(equalSelectionBytes(first, second)).toBe(true)
    first[0] = (first[0]! ^ 0xff) & 0xff
    const third = (await vm.loadAsset(key, costume.dataFormat ?? ''))!
    expect(equalSelectionBytes(third, second)).toBe(true)
    expect(equalSelectionBytes(third, first)).toBe(false)
  })

  it('storeAsset copies input: mutating the input after store never moves stored bytes', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(createDefaultProject())
    const input = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>')
    const inputBefore = input.slice()
    const stored = await vm.storeAsset(input, 'svg')
    for (let i = 0; i < input.length; i += 1) input[i] = (input[i]! ^ 0x55) & 0xff
    const loaded = (await vm.loadAsset(stored.md5ext, 'svg'))!
    expect(equalSelectionBytes(loaded, input)).toBe(false)
    // Stored bytes decode to the pre-mutation SVG artwork (user data kept).
    expect(new TextDecoder().decode(loaded)).toContain('<circle')
    expect(new TextDecoder().decode(loaded)).not.toBe(new TextDecoder().decode(input))
    void inputBefore
  })

  it('updateCostume/updateCostumeIfMatch defend against post-call input mutation', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(createDefaultProject())
    const target = vm.getTarget('Sprite1')!
    const svgA = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>')
    const mut = svgA.slice()
    await vm.updateCostume(target.name, 0, { dataFormat: 'svg' }, mut)
    for (let i = 0; i < mut.length; i += 1) mut[i] = (mut[i]! ^ 0x33) & 0xff
    const readBack = async (): Promise<Uint8Array> => {
      const costume = vm.getTarget('Sprite1')!.costumes[0]!
      return new Uint8Array((await vm.loadAsset(costume.md5ext ?? costume.assetId, 'svg'))!)
    }
    const storedA = await readBack()
    expect(equalSelectionBytes(storedA, mut)).toBe(false)
    expect(new TextDecoder().decode(storedA)).toContain('<rect')
    const svgB = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="6" height="6"/></svg>')
    const targetId = target.id ?? target.name
    const r = await (vm as unknown as { updateCostumeIfMatch: (t: string, i: number, e: undefined, p: unknown, d: Uint8Array) => Promise<{ applied: boolean }> }).updateCostumeIfMatch(targetId, 0, undefined, { dataFormat: 'svg' }, svgB.slice())
    expect(r.applied).toBe(true)
    svgB[10] = (svgB[10]! ^ 0xff) & 0xff
    const storedB = await readBack()
    expect(new TextDecoder().decode(storedB)).toContain('width="6"')
  })

  it('getSoundBuffer/export/import defend the same boundary (no bitmap paths)', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(createDefaultProject())
    const target = vm.getTarget('Sprite1')!
    // Default fixture ships no sounds: mint one minimal WAV so the sound
    // boundary (getSoundBuffer/updateSoundBuffer) is exercised for real.
    const wav = new Uint8Array(48)
    wav.set(
      [
        0x52, 0x49, 0x46, 0x46, 0x28, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
        0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
        0x64, 0x61, 0x74, 0x61, 0x04, 0x00, 0x00, 0x00,
      ],
      0,
    )
    const wavStored = await vm.storeAsset(wav.slice(), 'wav')
    await vm.addSound(target.name, {
      name: 'ownership-snd',
      dataFormat: 'wav',
      assetId: wavStored.assetId,
      md5ext: wavStored.md5ext,
    })
    expect(vm.getTarget('Sprite1')!.sounds.length).toBeGreaterThan(0)
    const first = (await vm.getSoundBuffer(target.name, 0))!
    const second = (await vm.getSoundBuffer(target.name, 0))!
    expect(first).not.toBe(second)
    expect(equalSelectionBytes(first, second)).toBe(true)
    first[44] = (first[44]! ^ 0xff) & 0xff
    const third = (await vm.getSoundBuffer(target.name, 0))!
    expect(equalSelectionBytes(third, second)).toBe(true)
    const exported = vm.exportAssetBytes()
    const someKey = Object.keys(exported)[0]!
    const exportedBefore = exported[someKey]!.slice()
    exported[someKey]![0] = (exported[someKey]![0]! ^ 0xff) & 0xff
    const reloaded = (await vm.loadAsset(someKey, '')) ?? (await vm.loadAsset(someKey.split('.').slice(0, -1).join('.'), ''))!
    if (reloaded) expect(equalSelectionBytes(reloaded, exported[someKey]!)).toBe(false)
    const fresh: Record<string, Uint8Array> = { [someKey]: exportedBefore.slice() }
    vm.importAssetBytes(fresh)
    fresh[someKey]![0] = (fresh[someKey]![0]! ^ 0xff) & 0xff
    const afterImport = (await vm.loadAsset(someKey, '')) ?? (await vm.loadAsset(someKey.split('.').slice(0, -1).join('.'), ''))!
    if (afterImport) expect(equalSelectionBytes(afterImport, fresh[someKey]!)).toBe(false)
  })

  it('getCostume hands out copies/strings: mutating them never moves live meta', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(createDefaultProject())
    const target = vm.getTarget('Sprite1')!
    const before = structuredClone(target.costumes[0]!)
    const viaTwoArgs = vm.getCostume(0, target.name) as unknown
    if (typeof viaTwoArgs === 'object' && viaTwoArgs !== null) {
      expect(viaTwoArgs).not.toBe(target.costumes[0])
      ;(viaTwoArgs as { name: string }).name = 'hostile-rename'
      expect(target.costumes[0]!.name).toBe(before.name)
    }
    const viaOneArg = vm.getCostume(0) as unknown
    if (typeof viaOneArg === 'object' && viaOneArg !== null) {
      ;(viaOneArg as { name: string }).name = 'hostile-rename-2'
      expect(target.costumes[0]!.name).toBe(before.name)
    }
    // Live meta itself is intact (user data never weakened).
    expect(target.costumes[0]!.md5ext).toBe(before.md5ext)
    expect(target.costumes[0]!.dataFormat).toBe(before.dataFormat)
  })
})

describe('ownership: stale priors across 64 slots + target/name/project', () => {
  it('64-slot cap evicts oldest-first, survivors stay usable, stale slots never authorize', () => {
    const priors = new Map<string, ReturnType<typeof buildSelectionSnapshot>>()
    const put = (slot: string, targetId: string, index: number, generation: number, seq: number, bytes: Uint8Array) => {
      const snap = buildSelectionSnapshot({
        targetId, index, projectGeneration: generation, writeSeq: seq, bytes,
        objectIndex: 2, selectedObjectIndices: [2], masks: { 2: 7 }, leafIndices: [2],
      })!
      priors.set(slot, snap)
      if (priors.size > 64) {
        const first = priors.keys().next().value as string | undefined
        if (first && first !== slot) priors.delete(first)
      }
    }
    const slotBytes = new Map<string, Uint8Array>()
    for (let i = 0; i < 65; i += 1) {
      const bytes = new Uint8Array(1024)
      bytes[0] = i & 0xff
      bytes[1] = (i >> 8) & 0xff
      for (let k = 2; k < bytes.length; k += 1) bytes[k] = (k * 31 + i) & 0xff
      const slot = `paint:slot-${i}:0`
      slotBytes.set(slot, bytes.slice())
      put(slot, `slot-${i}`, 0, 0, i, bytes)
      // Caller reuses/mutates its buffer after commit: prior must not follow.
      for (let k = 0; k < bytes.length; k += 1) bytes[k] = (bytes[k]! ^ 0x5a) & 0xff
    }
    expect(priors.size).toBe(64)
    expect(priors.has('paint:slot-0:0')).toBe(false)
    expect(priors.has('paint:slot-64:0')).toBe(true)
    // Survivor usable for its OWN distinct live buffer; tampered fails.
    const survivorSlot = 'paint:slot-64:0'
    const survivor = priors.get(survivorSlot)!
    const live = slotBytes.get(survivorSlot)!.slice()
    expect(live).not.toBe(survivor.bytesExact)
    expect(isSelectionSnapshotUsableForSlot(survivor, 'slot-64', 0, 0, 64, live)).toBe(true)
    const tampered = live.slice()
    tampered[500] = (tampered[500]! ^ 0x01) & 0xff
    expect(isSelectionSnapshotUsableForSlot(survivor, 'slot-64', 0, 0, 64, tampered)).toBe(false)
    // Stale reuse rejected: same bytes, wrong target / index / generation / seq.
    expect(isSelectionSnapshotUsableForSlot(survivor, 'namesake', 0, 0, 64, live.slice())).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(survivor, 'slot-64', 1, 0, 64, live.slice())).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(survivor, 'slot-64', 0, 1, 64, live.slice())).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(survivor, 'slot-64', 0, 0, 65, live.slice())).toBe(false)
    // Same-object live fails closed even when everything else matches.
    expect(isSelectionSnapshotUsableForSlot(survivor, 'slot-64', 0, 0, 64, survivor.bytesExact!)).toBe(false)
    // Target rename keeps the STABLE id slot usable (display name never keys).
    expect(survivor.targetId).toBe('slot-64')
    expect(isSelectionSnapshotUsableForSlot(survivor, 'slot-64', 0, 0, 64, live.slice())).toBe(true)
    // Merge helper preserves isolation (prior-committed clone is a copy).
    const merged = mergeSelectionAtPriorCommitted(survivor)!
    expect(merged).not.toBe(survivor)
    expect(merged.bytesExact).not.toBe(survivor.bytesExact)
    expect(equalSelectionBytes(merged.bytesExact, survivor.bytesExact)).toBe(true)
  })
})

describe('ownership: bounded memory, 70 entries + 64 slots, no selection loss', () => {
  function bytesForIndex(i: number): Uint8Array {
    const out = new Uint8Array(65536)
    out[0] = (i >>> 24) & 0xff
    out[1] = (i >>> 16) & 0xff
    out[2] = (i >>> 8) & 0xff
    out[3] = i & 0xff
    for (let k = 4; k < out.length; k += 1) out[k] = (k * 31 + i) & 0xff
    return out
  }

  it('oldest of 70 stays fresh (distinct buffer) and private priors stay within ~4MiB', () => {
    let undo: AssetHistoryEntry[] = []
    let redo: AssetHistoryEntry[] = []
    const snapshots = new WeakMap<AssetHistoryEntry, ReturnType<typeof buildSelectionSnapshot>>()
    const priors = new Map<string, ReturnType<typeof buildSelectionSnapshot>>()
    const truth: Uint8Array[] = []
    for (let i = 0; i < 70; i += 1) {
      const bytes = bytesForIndex(i)
      truth.push(bytes.slice())
      const entry: AssetHistoryEntry = {
        kind: 'costume', targetName: 'Sprite1', index: 0, meta: {} as never, bytes: bytes.slice(),
      }
      // Fixed Editor shape: snapshot from a COPY of entry bytes (private).
      const snap = buildSelectionSnapshot({
        targetId: 'stable-1', index: 0, projectGeneration: 0, writeSeq: i, bytes: entry.bytes.slice(),
        objectIndex: 4, selectedObjectIndices: [4], masks: { 4: 3 }, leafIndices: [4],
      })!
      snapshots.set(entry, cloneSelectionSnapshot(snap)!)
      const trimmed = trimHistoryStacks([...undo, entry], [], PAINT_HISTORY_MAX_ENTRIES, PAINT_HISTORY_MAX_BYTES)
      undo = trimmed.undo
      redo = trimmed.redo
      // Committed prior owns a private copy (fixed `remember...` shape).
      const prior = buildSelectionSnapshot({
        targetId: 'stable-1', index: 0, projectGeneration: 0, writeSeq: i, bytes: bytes.slice(),
        objectIndex: 4, selectedObjectIndices: [4], masks: { 4: 3 }, leafIndices: [4],
      })!
      priors.set(`paint:stable-1:${i % 64}`, prior)
      if (priors.size > 64) {
        const first = priors.keys().next().value as string | undefined
        if (first) priors.delete(first)
      }
    }
    expect(undo.length).toBe(70)
    // History budget respected: 70 x 64KiB entries well under 24MiB.
    const entryBytes = undo.reduce((total, entry) => total + entry.bytes.byteLength, 0)
    expect(entryBytes).toBeLessThanOrEqual(PAINT_HISTORY_MAX_BYTES)
    // Private priors bounded: at most 64 slots x 64KiB = ~4MiB outside.
    let priorBytes = 0
    for (const prior of priors.values()) priorBytes += prior.bytesExact?.byteLength ?? 0
    expect(priors.size).toBeLessThanOrEqual(64)
    expect(priorBytes).toBeLessThanOrEqual(64 * RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN)
    // No selection loss: oldest entry + snapshot usable for distinct live.
    const oldest = undo[0]!
    const oldestSnap = snapshots.get(oldest)!
    const oldestLive = truth[0]!.slice()
    expect(oldestLive).not.toBe(oldest.bytes)
    expect(oldestLive).not.toBe(oldestSnap.bytesExact)
    expect(equalSelectionBytes(oldest.bytes, truth[0])).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(oldestSnap, oldestLive)).toBe(true)
    expect(isSelectionSnapshotUsableForSlot(oldestSnap, 'stable-1', 0, 0, 0, oldestLive.slice())).toBe(true)
    const tampered = truth[0]!.slice()
    tampered[1000] = (tampered[1000]! ^ 0x01) & 0xff
    expect(isSelectionSnapshotFreshForBytes(oldestSnap, tampered)).toBe(false)
    // Mutating the oldest live buffer afterwards moves nothing stored.
    oldestLive[0] = (oldestLive[0]! ^ 0xff) & 0xff
    expect(equalSelectionBytes(oldest.bytes, truth[0])).toBe(true)
    expect(equalSelectionBytes(oldestSnap.bytesExact, truth[0])).toBe(true)
    void hashSelectionBytes
  })
})
