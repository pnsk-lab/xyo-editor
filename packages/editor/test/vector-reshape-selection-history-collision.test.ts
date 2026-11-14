// Collision audit: the pre-fix `bytesHash` was FNV-1a 32 (`<len>:<hex>`).
// This suite proves, deterministically, that two DISTINCT valid same-length
// SVG byte sequences share one FNV-32 value (birthday search, fixed seed,
// <= 200k candidates), so `bytesHash` equality can NEVER authorize
// selection reuse alone: the pre-fix delete/redo gates
// (`candidate.bytesHash === hash(pendingEntry.bytes)`) would accept a STALE
// prior as fresh and restore the wrong selection onto different artwork
// after Undo/Redo. The post-fix helpers must reject the same pair while
// accepting identical bytes, and slot/generation/seq CAS must keep
// rejecting same-slot external writes, renames, and out-of-order commits.
//
// Fail-first: every `expect` below FAILS on the pre-fix product
// (FNV equality accepts the colliding pair; no exact helper exists) and
// PASSES after the fix.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import {
  buildSelectionSnapshot,
  cloneSelectionSnapshot,
  equalSelectionBytes,
  hashSelectionBytes,
  isSelectionSnapshotForSlot,
  isSelectionSnapshotFreshAgainstEntryBytes,
  isSelectionSnapshotFreshForBytes,
  isSelectionSnapshotStale,
  isSelectionSnapshotUsableForSlot,
  isSha256BytesHash,
  normalizeSelectionSnapshot,
  reshapeSelectionSlotKey,
  RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN,
  validateSelectionSnapshotForAnchors,
  validateSelectionSnapshotForObjects,
} from '../src/features/costumes/vector-reshape-selection-history'

const textEncoder = new TextEncoder()

/** The exact pre-fix algorithm (full-byte FNV-1a 32, `<len>:<hex>`). */
function fnv1a32Legacy(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] as number
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${bytes.length}:${hash.toString(16)}`
}

/** Deterministic PRNG (fixed seed): no Math.random, reproducible search. */
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

/** Valid SVG: identical skeleton, fixed-width 8-hex comment token. */
function svgBytesForToken(token: string): Uint8Array {
  return textEncoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg"><g id="v"><rect width="8" height="8" fill="red"/></g><!--${token}--></svg>`,
  )
}

interface CollidingPair {
  first: { token: string; bytes: Uint8Array; n: number }
  second: { token: string; bytes: Uint8Array; n: number }
}

/** Deterministic birthday search over <= 200k same-length valid SVGs. */
function findFnvCollision(): CollidingPair {
  const random = mulberry32(1)
  const seen = new Map<string, { token: string; bytes: Uint8Array; n: number }>()
  for (let n = 0; n < 200000; n += 1) {
    let token = ''
    for (let k = 0; k < 8; k += 1) token += HEX_DIGITS[random() % 16]
    const bytes = svgBytesForToken(token)
    const digest = fnv1a32Legacy(bytes)
    const prev = seen.get(digest)
    if (prev) {
      // A regenerated PRNG token yields byte-identical inputs: not a hash
      // collision, keep searching.
      if (equalSelectionBytes(prev.bytes, bytes)) continue
      return { first: prev, second: { token, bytes, n } }
    }
    seen.set(digest, { token, bytes, n })
  }
  throw new Error('no FNV-1a 32 collision within 200k deterministic candidates')
}

describe('collision audit: FNV-1a 32 cannot authorize selection reuse', () => {
  it('grounds the legacy algorithm (known FNV-1a 32 vectors)', () => {
    expect(fnv1a32Legacy(textEncoder.encode(''))).toBe('0:811c9dc5')
    expect(fnv1a32Legacy(textEncoder.encode('a'))).toBe('1:e40c292c')
    expect(fnv1a32Legacy(textEncoder.encode('foobar'))).toBe('6:bf9cf968')
  })

  it('finds two distinct valid same-length SVGs with the same FNV-1a 32 (<=200k candidates)', () => {
    const pair = findFnvCollision()
    expect(pair.second.n).toBeLessThan(200000)
    const { bytes: a } = pair.first
    const { bytes: b } = pair.second
    // Distinct sequences ...
    expect(equalSelectionBytes(a, b)).toBe(false)
    expect(pair.first.token).not.toBe(pair.second.token)
    // ... of identical length ...
    expect(a.length).toBe(b.length)
    expect(a.length).toBeGreaterThan(0)
    // ... that are both well-formed SVGs (svg root, comment payload only).
    for (const bytes of [a, b] as const) {
      const text = new TextDecoder().decode(bytes)
      expect(text.startsWith('<svg')).toBe(true)
      expect(text.endsWith('</svg>')).toBe(true)
      expect(text).toContain('<!--')
    }
    // ... colliding under the pre-fix hash: the old gate equality holds.
    expect(fnv1a32Legacy(a)).toBe(fnv1a32Legacy(b))
  })

  it('fail-first: the shipped digest distinguishes the colliding pair', () => {
    const pair = findFnvCollision()
    const { bytes: a } = pair.first
    const { bytes: b } = pair.second
    // Pre-fix product: both digests equal (test would FAIL here). Post-fix:
    expect(hashSelectionBytes(a)).not.toBe(hashSelectionBytes(b))
    expect(isSha256BytesHash(hashSelectionBytes(a))).toBe(true)
    // Legacy digests are never SHA-256 and must fail closed everywhere.
    expect(isSha256BytesHash(fnv1a32Legacy(a))).toBe(false)
    expect(isSha256BytesHash('empty:0')).toBe(false)
  })

  it('fail-first: exact freshness rejects the colliding artwork, accepts identical bytes', () => {
    const pair = findFnvCollision()
    const bytesA = pair.first.bytes.slice()
    const bytesB = pair.second.bytes.slice()
    const priorA = buildSelectionSnapshot({
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
    // Per-snapshot exact retention (eviction parity): the snapshot retains
    // its exact bytes, so exactness needs no independently evicted cache.
    expect(priorA.bytesExact).toBeDefined()
    expect(equalSelectionBytes(priorA.bytesExact, bytesA)).toBe(true)
    expect(isSha256BytesHash(priorA.bytesHash)).toBe(true)
    // CollisionGate: seq matches (no observed bump at the gate) and the
    // pre-fix hash matches, yet the bytes differ -> MUST be stale.
    expect(isSelectionSnapshotStale(priorA, 5)).toBe(false)
    expect(isSelectionSnapshotFreshForBytes(priorA, bytesB)).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(priorA, 'stable-1', 0, 0, 5, bytesB)).toBe(false)
    // Identical bytes stay usable (no behavior change for the honest path).
    expect(isSelectionSnapshotFreshForBytes(priorA, bytesA)).toBe(true)
    expect(isSelectionSnapshotUsableForSlot(priorA, 'stable-1', 0, 0, 5, bytesA)).toBe(true)
  })

  it('fail-first: a legacy FNV snapshot authorizes stale selection by string equality, the helper does not', () => {
    const pair = findFnvCollision()
    const bytesA = pair.first.bytes
    const bytesB = pair.second.bytes
    // A pre-fix shaped entry: FNV digest, no exact copy.
    const legacy = normalizeSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      slotKey: 'paint:stable-1:0',
      projectGeneration: 0,
      writeSeq: 5,
      bytesHash: fnv1a32Legacy(bytesA),
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    // The pre-fix gate (`bytesHash === hash(bytes)`) ACCEPTS different
    // artwork as fresh — this is the exploitable authorization.
    expect(legacy.bytesHash).toBe(fnv1a32Legacy(bytesB))
    // The post-fix helper fails closed on legacy digests.
    expect(isSelectionSnapshotFreshForBytes(legacy, bytesB)).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(legacy, 'stable-1', 0, 0, 5, bytesB)).toBe(false)
  })

  it('same-slot external write / redo: seq CAS rejects reuse even for identical bytes', () => {
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
    // A same-slot external write (same bytes or not) bumps writeSeq: the
    // redo-side prior must not be reused afterwards.
    expect(isSelectionSnapshotStale(prior, 5)).toBe(false)
    expect(isSelectionSnapshotStale(prior, 6)).toBe(true)
    expect(isSelectionSnapshotUsableForSlot(prior, 'stable-1', 0, 0, 6, bytesA)).toBe(false)
    // Generation mismatch (project reload / history invalidation) also drops.
    expect(isSelectionSnapshotUsableForSlot(prior, 'stable-1', 0, 1, 5, bytesA)).toBe(false)
    // Rename adoption rule: stale pre-rename priors are dropped, never adopted.
    const stale = normalizeSelectionSnapshot(cloneSelectionSnapshot(prior))
    expect(isSelectionSnapshotStale(stale, 6)).toBe(true)
    const adopted = normalizeSelectionSnapshot({ ...cloneSelectionSnapshot(prior)!, writeSeq: 6 })
    expect(adopted).toBeDefined()
    expect(isSelectionSnapshotStale(adopted, 6)).toBe(false)
    expect(isSelectionSnapshotFreshForBytes(adopted, bytesA)).toBe(true)
  })

  it('nested groups with the same display name never alias; indices stay verbatim', () => {
    const bytes = svgBytesForToken('bbbbbbbb')
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
    // Same display name / same slot on another target never matches.
    expect(isSelectionSnapshotForSlot(snapshot, 'namesake', 0, 0)).toBe(false)
    expect(isSelectionSnapshotForSlot(snapshot, 'stable-1', 1, 0)).toBe(false)
    expect(isSelectionSnapshotForSlot(snapshot, 'stable-1', 0, 0)).toBe(true)
    // Nested-group unit indices are used verbatim: live units keep the
    // selection, a vanished primary drops the whole snapshot (no remap onto
    // a same-named nested group).
    expect(validateSelectionSnapshotForObjects(snapshot, [0, 1, 2])?.selectedObjectIndices).toEqual([1])
    expect(validateSelectionSnapshotForObjects(snapshot, [0, 2])).toBeUndefined()
    // Duplicate coordinates across nested same-position groups fail closed.
    const dupAnchors = [
      { index: 0, x: 5, y: 5 },
      { index: 2, x: 5, y: 5 },
    ]
    expect(validateSelectionSnapshotForAnchors(snapshot, dupAnchors)?.masks).toEqual({})
  })

  it('out-of-order promise: a delayed peek commit after a concurrent write must drop', () => {
    const bytesP = svgBytesForToken('cccccccc')
    const bytesQ = svgBytesForToken('dddddddd')
    // Peek captured pre-edit bytes at seq 5; a concurrent write moved the
    // slot to seq 6 with different bytes before the delayed commit lands.
    const peeked = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes: bytesP,
      objectIndex: 0,
      selectedObjectIndices: [0],
      masks: {},
      leafIndices: [],
    })!
    expect(isSelectionSnapshotUsableForSlot(peeked, 'stable-1', 0, 0, 6, bytesQ)).toBe(false)
    expect(isSelectionSnapshotUsableForSlot(peeked, 'stable-1', 0, 0, 6, bytesP)).toBe(false)
    // The ordered path (no interleaving write) still commits.
    expect(isSelectionSnapshotUsableForSlot(peeked, 'stable-1', 0, 0, 5, bytesP)).toBe(true)
  })

  it('digest vectors: versioned SHA-256, empty handling, one-bit sensitivity', () => {
    expect(hashSelectionBytes(undefined)).toBe('empty:0')
    expect(hashSelectionBytes(null)).toBe('empty:0')
    expect(hashSelectionBytes(new Uint8Array(0))).toBe('empty:0')
    expect(hashSelectionBytes(textEncoder.encode('abc'))).toBe(
      '3:sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const a = textEncoder.encode('abc')
    const b = textEncoder.encode('abd')
    expect(hashSelectionBytes(a)).not.toBe(hashSelectionBytes(b))
    expect(equalSelectionBytes(a, b)).toBe(false)
    expect(equalSelectionBytes(a, a.slice())).toBe(true)
    expect(equalSelectionBytes(a, undefined)).toBe(false)
    expect(equalSelectionBytes(undefined, undefined)).toBe(true)
  })

  it('bounded exact storage: per-snapshot retention, private copies, digest fallback for large artwork', () => {
    expect(RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN).toBe(65536)
    const small = svgBytesForToken('eeeeeeee')
    const smallSnap = buildSelectionSnapshot({
      targetId: 't',
      index: 0,
      projectGeneration: 0,
      writeSeq: 0,
      bytes: small,
      objectIndex: -1,
      selectedObjectIndices: [],
      masks: {},
      leafIndices: [],
    })!
    // Per-snapshot exact retention: the snapshot owns a PRIVATE copy at the
    // ownership boundary -- callers may mutate/reuse the buffer afterwards,
    // so freshness always decides by the copied bytes with no independently
    // evicted cache.
    expect(smallSnap.bytesExact).toBeDefined()
    expect(smallSnap.bytesExact).not.toBe(small)
    expect(equalSelectionBytes(smallSnap.bytesExact, small)).toBe(true)
    expect(isSha256BytesHash(smallSnap.bytesHash)).toBe(true)
    const pristine = svgBytesForToken('eeeeeeee')
    expect(equalSelectionBytes(small, pristine)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(smallSnap, pristine)).toBe(true)
    // Freshness compares DISTINCT buffers: a tampered live buffer (different
    // content, different object) fails closed, never retargets.
    const tamperedSmall = pristine.slice()
    tamperedSmall[10] = (tamperedSmall[10] as number) ^ 0xff
    expect(equalSelectionBytes(small, tamperedSmall)).toBe(false)
    expect(isSelectionSnapshotFreshForBytes(smallSnap, tamperedSmall)).toBe(false)
    // Large artwork stores no copy but stays valid via the digest.
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
    expect(isSelectionSnapshotFreshForBytes(largeSnap, large)).toBe(true)
    const tampered = large.slice()
    tampered[1000] = (tampered[1000] as number) ^ 0x01
    expect(isSelectionSnapshotFreshForBytes(largeSnap, tampered)).toBe(false)
    // Oversized copies in untrusted input are dropped, never fatal.
    const dropped = normalizeSelectionSnapshot({ ...largeSnap, bytesExact: large })
    expect(dropped).toBeDefined()
    expect(dropped?.bytesExact).toBeUndefined()
    // Non-byte copies are rejected outright.
    expect(normalizeSelectionSnapshot({ ...largeSnap, bytesExact: 'nope' })).toBeUndefined()
  })
})

describe('streaming digest audit: bounded-scratch SHA-256, exact-not-hash proof, key identity', () => {
  function fillBytes(length: number, seed = 7): Uint8Array {
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed) & 0xff
    return out
  }

  function cryptoDigestHex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
  }

  function shippedDigestHex(bytes: Uint8Array): string {
    const digest = hashSelectionBytes(bytes)
    return digest.slice(digest.lastIndexOf(':') + 1)
  }

  it('matches node:crypto at final-block boundaries, multiblock, and 1 MiB', () => {
    // 55/56 = one-vs-two padding blocks; 63/64/65 = block edges; 119-129 =
    // two-block padding region; 65535-65537 = exact-cap boundary; 1000/1MiB
    // cover multiblock streaming. A striding or copy-based padding bug would
    // surface at one of these lengths.
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65535, 65536, 65537]) {
      const bytes = fillBytes(length)
      expect(shippedDigestHex(bytes)).toBe(cryptoDigestHex(bytes))
    }
    const random = fillBytes(1 << 20, 123)
    let x = 0x12345678
    for (let i = 0; i < random.length; i += 1) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= (x << 5) >>> 0
      random[i] = ((random[i] as number) ^ (x & 0xff)) & 0xff
    }
    expect(shippedDigestHex(random)).toBe(cryptoDigestHex(random))
    // Known vector pins the versioned format, not just oracle agreement.
    expect(hashSelectionBytes(textEncoder.encode('abc'))).toBe(
      '3:sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes any Uint8Array view without copying or mutating caller bytes', () => {
    const backing = fillBytes(300, 9)
    const view = new Uint8Array(backing.buffer, 100, 130)
    const before = view.slice()
    expect(shippedDigestHex(view)).toBe(cryptoDigestHex(view))
    // Read-only indexed loads: the caller buffer is bit-identical afterwards.
    expect(equalSelectionBytes(view, before)).toBe(true)
    expect(equalSelectionBytes(backing.subarray(100, 230), before)).toBe(true)
    // Snapshot build/clone/freshness also leave inputs untouched.
    const snap = buildSelectionSnapshot({
      targetId: 't',
      index: 0,
      projectGeneration: 0,
      writeSeq: 0,
      bytes: view,
      objectIndex: -1,
      selectedObjectIndices: [],
      masks: {},
      leafIndices: [],
    })!
    expect(equalSelectionBytes(view, before)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(snap, view)).toBe(true)
    expect(equalSelectionBytes(view, before)).toBe(true)
  })

  it('proof: retained exact bytes decide freshness, never the digest string alone', () => {
    const bytesA = svgBytesForToken('eeeeeeee').slice()
    const bytesB = svgBytesForToken('ffffffff').slice()
    expect(equalSelectionBytes(bytesA, bytesB)).toBe(false)
    // Evil case 1: legacy FNV digest, but a legacy exact copy matches the
    // live bytes -> fresh. Legacy (non-SHA) copies are retained on the
    // snapshot for exact-first compat (they drain with history turnover; no
    // new FNV entries are ever built). Hash-string comparison alone would
    // reject; equality accepts because no hash is consulted on this path.
    const legacyShaped = normalizeSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      slotKey: 'paint:stable-1:0',
      projectGeneration: 0,
      writeSeq: 5,
      bytesHash: fnv1a32Legacy(bytesA),
      bytesExact: bytesA.slice(),
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    expect(legacyShaped.bytesExact).toBeDefined()
    expect(isSelectionSnapshotFreshForBytes(legacyShaped, bytesA)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(legacyShaped, bytesB)).toBe(false)
    // Evil case 2: the digest string is the CORRECT SHA-256 of bytesB, but
    // the inbound copy is bytesA (forged mismatch). Binding fails closed:
    // normalize rejects the forged pair outright instead of trusting either
    // side, so no snapshot that could authorize the wrong artwork survives.
    expect(
      normalizeSelectionSnapshot({
        targetId: 'stable-1',
        index: 0,
        slotKey: 'paint:stable-1:0',
        projectGeneration: 0,
        writeSeq: 5,
        bytesHash: hashSelectionBytes(bytesB),
        bytesExact: bytesA.slice(),
        objectIndex: 1,
        selectedObjectIndices: [1],
        masks: {},
        leafIndices: [],
      }),
    ).toBeUndefined()
    // The honest snapshot for bytesB owns a private copy of bytesB and is
    // fresh for bytesB only: exact equality of two distinct buffers, never
    // the digest string alone.
    const honestB = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes: bytesB,
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    expect(honestB.bytesExact).toBeDefined()
    expect(equalSelectionBytes(honestB.bytesExact, bytesB)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(honestB, bytesB)).toBe(true)
    expect(isSelectionSnapshotFreshForBytes(honestB, bytesA)).toBe(false)
  })

  it('slot keys never alias across colon-containing stable ids; forged keys/digests fail closed', () => {
    const snapshot = buildSelectionSnapshot({
      targetId: 'x:0',
      index: 1,
      projectGeneration: 0,
      writeSeq: 0,
      bytes: svgBytesForToken('aaaaaaaa'),
      objectIndex: 0,
      selectedObjectIndices: [0],
      masks: {},
      leafIndices: [],
    })!
    expect(snapshot.slotKey).toBe('paint:x:0:1')
    // The key splits unambiguously at the last colon (index is a bare
    // integer), so no other (targetId, index) pair matches this slot.
    expect(isSelectionSnapshotForSlot(snapshot, 'x:0', 1, 0)).toBe(true)
    expect(isSelectionSnapshotForSlot(snapshot, 'x', 0, 0)).toBe(false)
    expect(isSelectionSnapshotForSlot(snapshot, 'x:0:1', 0, 0)).toBe(false)
    expect(reshapeSelectionSlotKey('a:b', 2)).toBe('paint:a:b:2')
    // Forged slot key for a valid (targetId, index) is rejected.
    expect(
      normalizeSelectionSnapshot({ ...snapshot, slotKey: 'paint:x:0:2' }),
    ).toBeUndefined()
    // Over-long digest strings (beyond RESHAPE_SELECTION_HISTORY_MAX_BYTES_HASH_LEN) fail closed.
    expect(
      normalizeSelectionSnapshot({ ...snapshot, bytesHash: `1:sha256:${'ab'.repeat(64)}` }),
    ).toBeUndefined()
  })
})

describe('memory ownership: 100 entries x 64KiB keep every selection usable (eviction parity)', () => {
  function bytesForIndex(i: number): Uint8Array {
    const out = new Uint8Array(65536)
    // Distinct first 8 bytes per entry (unique digest), deterministic fill.
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

  it('100 x 64KiB snapshots keep every selection usable (per-entry retention, no independent eviction)', () => {
    const heapBefore = process.memoryUsage().heapUsed
    const inputs: Uint8Array[] = []
    const snapshots = []
    for (let i = 0; i < 100; i += 1) {
      const bytes = bytesForIndex(i)
      inputs.push(bytes)
      const snap = buildSelectionSnapshot({
        targetId: 'stable-1',
        index: 0,
        projectGeneration: 0,
        writeSeq: i,
        bytes,
        objectIndex: 0,
        selectedObjectIndices: [0],
        masks: {},
        leafIndices: [],
      })!
      snapshots.push(snap)
    }
    // Every in-cap snapshot retains a PRIVATE copy of its exact bytes
    // (never the caller buffer: ownership boundary copies).
    for (const snap of snapshots) expect(snap.bytesExact).toBeDefined()
    // Newest entry is usable ...
    const newest = snapshots[snapshots.length - 1]!
    expect(isSelectionSnapshotFreshForBytes(newest, bytesForIndex(99))).toBe(true)
    expect(snapshots.length).toBe(100)
    for (const snap of snapshots) expect(snap.bytesHash.startsWith('65536:sha256:')).toBe(true)
    const oldest = snapshots[0]!
    // ... and the oldest entry is STILL usable for its own unchanged bytes
    // (distinct buffer, never a self-compare): Scratch parity, no silent
    // metadata loss after >64 edits. Tampered bytes still fail closed.
    const oldestLive = bytesForIndex(0)
    expect(oldestLive).not.toBe(oldest.bytesExact)
    expect(isSelectionSnapshotFreshForBytes(oldest, oldestLive)).toBe(true)
    const tampered = bytesForIndex(0)
    tampered[0] = (tampered[0] as number) ^ 0xff
    expect(isSelectionSnapshotFreshForBytes(oldest, tampered)).toBe(false)
    // Retention is per-entry with private copies: each snapshot owns a copy
    // equal to (but never the same object as) its input buffer.
    for (let i = 0; i < 100; i += 1) {
      expect(snapshots[i]!.bytesExact).toBeDefined()
      expect(snapshots[i]!.bytesExact).not.toBe(inputs[i])
      expect(equalSelectionBytes(snapshots[i]!.bytesExact, inputs[i])).toBe(true)
    }
    const heapAfter = process.memoryUsage().heapUsed
    // Heap observable: report heap + external + rss (ArrayBuffers live
    // outside `heapUsed`, so `heapUsed` alone understates byte retention).
    // Retention is bounded per entry (<=64KiB each, private copies evicted
    // together with history entries in the Editor); heap delta is reported,
    // not asserted to zero (hashing + harness noise).
    const memAfter = process.memoryUsage()
    // eslint-disable-next-line no-console
    console.log(
      `[memory] 100x64KiB snapshots: retained=100x64KiB heapDelta=${heapAfter - heapBefore}B rss=${memAfter.rss}B external=${memAfter.external}B`,
    )
  })

  it('external-authoritative entry bytes give exact freshness for retained snapshots', () => {
    const entryBytes = svgBytesForToken('eeeeeeee').slice()
    const liveSame = entryBytes.slice()
    const liveTampered = entryBytes.slice()
    liveTampered[3] = (liveTampered[3] as number) ^ 0x01
    const snap = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes: entryBytes,
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    // Entry binds (same bytes): exact decision with no cache involved.
    expect(isSelectionSnapshotFreshAgainstEntryBytes(snap, entryBytes, liveSame)).toBe(true)
    expect(isSelectionSnapshotFreshAgainstEntryBytes(snap, entryBytes, liveTampered)).toBe(false)
    // Entry mismatch (different entry bytes than the snapshot digest): fail closed.
    expect(isSelectionSnapshotFreshAgainstEntryBytes(snap, liveTampered, liveSame)).toBe(false)
    // Works with no cache at all (retained bytes decide, zero cache dependency).
    expect(isSelectionSnapshotFreshAgainstEntryBytes(snap, entryBytes, liveSame)).toBe(true)
    expect(isSelectionSnapshotFreshAgainstEntryBytes(snap, entryBytes, liveTampered)).toBe(false)
    // Legacy FNV digests fail closed even with an entry.
    const legacy = normalizeSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      slotKey: 'paint:stable-1:0',
      projectGeneration: 0,
      writeSeq: 5,
      bytesHash: '8:deadbeef',
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    expect(isSelectionSnapshotFreshAgainstEntryBytes(legacy, entryBytes, liveSame)).toBe(false)
  })

  it('same display name never aliases; external identity (seq/CAS) still enforced', () => {
    const bytes = svgBytesForToken('aaaaaaaa')
    const snap = buildSelectionSnapshot({
      targetId: 'stable-1',
      index: 0,
      projectGeneration: 0,
      writeSeq: 5,
      bytes,
      objectIndex: 1,
      selectedObjectIndices: [1],
      masks: {},
      leafIndices: [],
    })!
    // Same name on another stable id never matches (key binds stable id).
    expect(isSelectionSnapshotUsableForSlot(snap, 'namesake', 0, 0, 5, bytes)).toBe(false)
    // Same bytes after an external write (seq bump) still rejected.
    expect(isSelectionSnapshotUsableForSlot(snap, 'stable-1', 0, 0, 6, bytes)).toBe(false)
    // Honest path still usable.
    expect(isSelectionSnapshotUsableForSlot(snap, 'stable-1', 0, 0, 5, bytes.slice())).toBe(true)
  })

  it('large-input hashing cost is observable (async pause risk), memory stays bounded', () => {
    const big = new Uint8Array(4 * 1024 * 1024)
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + 7) & 0xff
    const start = performance.now()
    const digest = hashSelectionBytes(big)
    const elapsed = performance.now() - start
    expect(isSha256BytesHash(digest)).toBe(true)
    // Large artwork retains no copy: digest-only, zero retained growth.
    // The cost is CPU time on the calling thread (sync pure-TS SHA-256), not
    // memory: report it so callers can schedule large peeks off the critical
    // path. No zero-cost claim: time grows O(n) with input bytes.
    // eslint-disable-next-line no-console
    console.log(`[perf] hash 4MiB sync: ${elapsed.toFixed(1)}ms digest=${digest.slice(0, 24)}...`)
  })
})
