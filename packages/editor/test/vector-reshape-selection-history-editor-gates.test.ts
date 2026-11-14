// Editor gate audit: the two selection-reuse freshness gates in `Editor.svelte`
// must use collision-free `isSelectionSnapshotFreshForBytes` (exact <=64KiB
// bytes equality, SHA-256 otherwise), never `bytesHash === hashSelectionBytes`.
// Static part pins the shipped source; behavioral part replays the exact gate
// shape (priorCommitted slot/generation/seq CAS + fresh) with deterministic
// distinct same-length colliding FNV SVGs, direct external overwrite, undo and
// rename adoption, asserting no wrong selection, no stale bytes, and the 65k+
// SHA-256 fallback.
import { describe, expect, it } from 'bun:test'
import {
  buildSelectionSnapshot,
  cloneSelectionSnapshot,
  equalSelectionBytes,
  isSelectionSnapshotForSlot,
  isSelectionSnapshotFreshAgainstEntryBytes,
  isSelectionSnapshotFreshForBytes,
  isSelectionSnapshotStale,
  isSelectionSnapshotUsableForSlot,
  normalizeSelectionSnapshot,
  RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN,
  validateSelectionSnapshotForAnchors,
  validateSelectionSnapshotForObjects,
} from '../src/features/costumes/vector-reshape-selection-history'

const textEncoder = new TextEncoder()

function fnv1a32Legacy(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] as number
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${bytes.length}:${hash.toString(16)}`
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0)
  }
}

const HEX_DIGITS = '0123456789abcdef'

function svgBytesForToken(token: string): Uint8Array {
  return textEncoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg"><g id="v"><rect width="8" height="8" fill="red"/></g><!--${token}--></svg>`,
  )
}

function findFnvCollision(): { a: Uint8Array; b: Uint8Array } {
  const random = mulberry32(1)
  const seen = new Map<string, Uint8Array>()
  for (let n = 0; n < 200000; n += 1) {
    let token = ''
    for (let k = 0; k < 8; k += 1) token += HEX_DIGITS[random() % 16]
    const bytes = svgBytesForToken(token)
    const digest = fnv1a32Legacy(bytes)
    const prev = seen.get(digest)
    if (prev) {
      if (equalSelectionBytes(prev, bytes)) continue
      return { a: prev.slice(), b: bytes.slice() }
    }
    seen.set(digest, bytes)
  }
  throw new Error('no FNV-1a 32 collision within 200k deterministic candidates')
}

// Exact mirror of the Editor.svelte delete gate shape:
// candidate already passed slot/generation/seq CAS inside
// `priorCommittedReshapeSelectionForSlot`; the gate then requires freshness.
function editorDeleteGateFresh(
  candidate: Parameters<typeof isSelectionSnapshotFreshForBytes>[0],
  pendingBytes: Uint8Array | undefined | null,
): boolean {
  return (
    candidate !== undefined &&
    isSelectionSnapshotFreshForBytes(candidate, pendingBytes)
  )
}

// Exact mirror of the Editor.svelte redo gate shape: fresh for live bytes AND
// not stale against the live write seq.
function editorRedoGateUsePrior(
  prior: Parameters<typeof isSelectionSnapshotFreshForBytes>[0],
  liveBytes: Uint8Array,
  liveWriteSeq: number | null | undefined,
): boolean {
  if (!(prior && isSelectionSnapshotFreshForBytes(prior, liveBytes))) return false
  let staleness = true
  try {
    staleness = isSelectionSnapshotStale(prior, liveWriteSeq ?? null)
  } catch {
    staleness = true
  }
  return !staleness
}

describe('Editor.svelte selection gates use isSelectionSnapshotFreshForBytes (static)', () => {
  it('imports the helper and gates both call sites on it', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    expect(source).toContain('isSelectionSnapshotFreshForBytes')
    expect(source).toContain(
      'isSelectionSnapshotFreshForBytes(candidate, pendingEntry.bytes as unknown as Uint8Array | undefined | null)',
    )
    expect(source).toContain('isSelectionSnapshotFreshForBytes(prior, liveBytes)')
  })

  it('no bytesHash === hashSelectionBytes gate remains', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    expect(source).not.toContain('bytesHash === hashSelectionBytes')
  })

  it('preserves slot/generation/writeSeq checks around both gates', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    // Delete gate still resolves via the slot-scoped committed prior and merges
    // at the prior committed snapshot.
    expect(source).toContain('priorCommittedReshapeSelectionForSlot(deleteTargetId, costumeIndex)')
    expect(source).toContain('mergeSelectionAtPriorCommitted(fresh ? candidate : undefined)')
    // Redo gate still checks seq staleness against the live slot identity.
    expect(source).toContain('isSelectionSnapshotStale(prior, readLiveSlotIdentity(targetId, entry.index).writeSeq ?? null)')
    // Slot/generation helpers remain wired.
    expect(source).toContain('isSelectionSnapshotForSlot')
    expect(source).toContain('isSelectionSnapshotStale')
    expect(source).toContain('readLiveSlotIdentity')
  })
})

describe('Editor gate behavior with colliding FNV SVGs (real helpers)', () => {
  it('colliding pair collides under FNV but the Editor fresh gate rejects it', () => {
    const { a, b } = findFnvCollision()
    expect(a.length).toBe(b.length)
    expect(equalSelectionBytes(a, b)).toBe(false)
    expect(fnv1a32Legacy(a)).toBe(fnv1a32Legacy(b))

    const priorA = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes: a,
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    // Sanity: in-cap snapshots retain a PRIVATE copy of their exact bytes
    // (never the caller buffer), so exactness needs no independently evicted
    // cache.
    expect(priorA.bytesExact).toBeDefined()
    expect(equalSelectionBytes(priorA.bytesExact, a)).toBe(true)
    expect(equalSelectionBytes(priorA.bytesExact, b)).toBe(false)

    // Delete gate: pending bytes are the colliding artwork -> not fresh, so
    // the prior is dropped (selection-lost, never retargeted).
    expect(editorDeleteGateFresh(priorA, b)).toBe(false)
    expect(editorDeleteGateFresh(priorA, a)).toBe(true)
    // Redo gate: live bytes are the colliding artwork -> prior not reused.
    expect(editorRedoGateUsePrior(priorA, b, 5)).toBe(false)
    expect(editorRedoGateUsePrior(priorA, a, 5)).toBe(true)
  })

  it('direct external overwrite bumps writeSeq: same bytes still rejected', () => {
    const bytesA = svgBytesForToken('aaaaaaaa')
    const prior = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes: bytesA,
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    // Same bytes, but the slot moved (external write) -> stale.
    expect(isSelectionSnapshotStale(prior, 6)).toBe(true)
    expect(editorRedoGateUsePrior(prior, bytesA.slice(), 6)).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(prior, 'stable-1', 0, 0, 6, bytesA)).toBe(false)
    // Ordered path still commits.
    expect(editorRedoGateUsePrior(prior, bytesA.slice(), 5)).toBe(true)
  })

  it('undo/rename scoping: generation mismatch drops, adopted seq reuses', () => {
    const bytesA = svgBytesForToken('bbbbbbbb')
    const prior = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes: bytesA,
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    // Undo across a generation bump (project reload / history invalidation)
    // drops the prior even for identical bytes.
    expect(isSelectionSnapshotUsableForSlot(prior, 'stable-1', 0, 1, 5, bytesA)).toBe(false)
    // Rename adoption: stale pre-rename prior dropped, adopted prior (seq
    // bumped to the live seq, same slot+generation) reuses identical bytes
    // and still rejects colliding bytes.
    const { b: colliding } = findFnvCollision()
    const stale = normalizeSelectionSnapshot(cloneSelectionSnapshot(prior))
    expect(isSelectionSnapshotStale(stale, 6)).toBe(true)
    const adopted = normalizeSelectionSnapshot({ ...cloneSelectionSnapshot(prior)!, writeSeq: 6 })!
    expect(isSelectionSnapshotStale(adopted, 6)).toBe(false)
    expect(isSelectionSnapshotFreshForBytes(adopted, bytesA)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(adopted, colliding)).toBe(false)
  })

  it('no wrong selection: vanished primary and duplicated anchors fail closed', () => {
    const bytes = svgBytesForToken('cccccccc')
    const snapshot = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes,
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: { 0: 7 },
      leafIndices: [0],
    })!
    // Slot helper never aliases another target/index/generation.
    expect(isSelectionSnapshotForSlot(snapshot, 'namesake', 0, 0)).toBe(false)
    expect(isSelectionSnapshotForSlot(snapshot, 'stable-1', 1, 0)).toBe(false)
    expect(isSelectionSnapshotForSlot(snapshot, 'stable-1', 0, 0)).toBe(true)
    // Vanished primary drops the whole object selection (no remap onto a
    // same-named nested unit).
    expect(validateSelectionSnapshotForObjects(snapshot, [0, 2])).toBeUndefined()
    expect(validateSelectionSnapshotForObjects(snapshot, [0, 1, 2])?.selectedObjectIndices).toEqual([1])
    // Duplicate coordinates drop masks (never retarget stale anchors).
    const dupAnchors = [
      { index: 0, x: 5, y: 5 },
      { index: 2, x: 5, y: 5 },
    ]
    expect(validateSelectionSnapshotForAnchors(snapshot, dupAnchors)?.masks).toEqual({})
  })

  it('no stale bytes: one-bit difference is never fresh', () => {
    const { a } = findFnvCollision()
    const prior = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes: a,
      objectIndex: 0,
      selectedObjectIndices: [0],
      masks: {},
      leafIndices: [],
    })!
    const tampered = a.slice()
    tampered[0] = (tampered[0] as number) ^ 0x01
    expect(equalSelectionBytes(a, tampered)).toBe(false)
    expect(editorDeleteGateFresh(prior, tampered)).toBe(false)
    expect(editorRedoGateUsePrior(prior, tampered, 5)).toBe(false)
  })

  it('bytes 65k+ fall back to SHA-256 (digest-only, still strong decision)', () => {
    expect(RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN).toBe(65536)
    const large = new Uint8Array(RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN + 16)
    for (let i = 0; i < large.length; i += 1) large[i] = (i * 31 + 7) & 0xff
    const largeSnap = buildSelectionSnapshot({
      targetId: 't',
      index: 0,
      projectGeneration: 0,
      writeSeq: 0,
      bytes: large,
      objectIndex: -1,
      selectedObjectIndices: [],
      masks: {},
      leafIndices: [],
    })!
    expect(largeSnap.bytesExact).toBeUndefined()
    // Large artwork retains no copy (digest-only by construction).
    expect(isSelectionSnapshotFreshForBytes(largeSnap, large)).toBe(true)
    const tampered = large.slice()
    tampered[1000] = (tampered[1000] as number) ^ 0x01
    expect(isSelectionSnapshotFreshForBytes(largeSnap, tampered)).toBe(false)
    // The external-authoritative entry helper gives the same answer for
    // large artwork too.
    expect(isSelectionSnapshotFreshAgainstEntryBytes(largeSnap, large, large.slice())).toBe(true)
    expect(isSelectionSnapshotFreshAgainstEntryBytes(largeSnap, large, tampered)).toBe(false)
    // Same-length colliding small SVGs retain exact bytes, so the
    // large-artwork digest path never confuses the two regimes.
    const { a, b } = findFnvCollision()
    expect(a.length).toBeLessThan(RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN)
    expect(b.length).toBeLessThan(RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN)
  })
})
