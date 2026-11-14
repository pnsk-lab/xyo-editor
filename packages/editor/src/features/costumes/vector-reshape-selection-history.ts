// Vector reshape selection snapshot metadata (pure, DOM-free).
//
// Oracle (test/vector-delete-undo-selection-parity): Paper 0.12.18
// exportJSON carries per-segment selection flags; scratch snapshots are
// post-states on import/update, selection-only pushes nothing, delete
// snapshots post-delete, undo restores stack[pointer-1]. Consequence: a
// selection made after the last snapshot is LOST by delete->undo unless a
// post-selection edit snapshot recorded it.
//
// Editor stores byte snapshots on peek BEFORE edits. To emulate the oracle
// without serializing selection into SVG bytes, each paint entry carries a
// selection snapshot. For deletes the entry merges the selection at the
// prior committed snapshot rather than the unconditional deletion-time UI
// (which may contain selection-only changes after the last snapshot).
// All other vector edits attach the current UI at peek time (their bytes
// and selection advance together; nudge/style preserve via rebase).
//
// Safety: stable target id only (same-name costumes never alias),
// projectGeneration + byte identity + writeSeq CAS, invalid /
// remap duplicate coords fail-closed (drop ambiguous), memory capped,
// pruned on history invalidation. Bitmap untouched.
//
// Memory ownership (hostile-audit fix, this file only):
// - `AssetHistoryEntry.bytes` (Editor.svelte history stacks, capped by
//   `PAINT_HISTORY_MAX_ENTRIES`/`PAINT_HISTORY_MAX_BYTES` = 24 MiB) is the
//   authoritative artwork store and the byte budget that matters for user
//   assets. Selection snapshots NEVER sacrifice undo metadata to save memory:
//   every snapshot at or under `RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN`
//   retains its exact bytes, so all 100 per-entry snapshots stay usable no
//   matter how many edits land (Scratch parity: 100 snapshots, no eviction).
// - Ownership is by PRIVATE COPY at every boundary: `buildSelectionSnapshot`
//   copies the caller buffer (`slice`), `normalizeSelectionSnapshot` copies
//   inbound `bytesExact`, `cloneSelectionSnapshot` copies again. Callers may
//   freely mutate/reuse their buffer afterwards; other consumers mutating
//   `entry.bytes` or a sibling snapshot never corrupts this snapshot, and
//   vice versa. Per-entry snapshots are therefore DISTINCT objects from their
//   history entry (`bytesExact !== entry.bytes`, equal content), evicted
//   TOGETHER with their entries by `trimHistoryStacks` (WeakMap), never
//   independently. Per-slot committed priors (post-edit bytes, not yet in any
//   entry) each hold one private copy (one per slot, 64 slots max, each <=
//   64 KiB, <= 4 MiB total outside the 24 MiB history budget). The
//   `isSelectionSnapshotFreshAgainstEntryBytes` helper additionally covers
//   call sites that hold the entry at hand (digest + distinct-buffer compare).
// - Degradation is ALWAYS toward selection-lost, never toward the wrong
//   selection and never by dropping history: snapshots whose exact bytes are
//   unavailable (large artwork above the cap, deserialized entries that lost
//   their copy) fall back to versioned SHA-256 digest equality, legacy FNV
//   digests always fail closed.
// - Freshness NEVER authenticates a buffer against itself: every exact path
//   requires DISTINCT buffer objects (`snapshot.bytesExact !== liveBytes`,
//   `snapshot.bytesExact !== entryBytes`, `entryBytes !== liveBytes` for
//   non-empty inputs). A shared reference passed as both sides fails closed,
//   so aliasing can never authorize stale selection. Hashing stays
//   O(n) synchronous CPU (see async-pause note on `hashSelectionBytes`);
//   memory is bounded, time is not claimed zero.
// - `bytesHash` was FNV-1a 32 (`<len>:<hex>`), sampled-then-full. 32 bits
//   cannot claim exact byte identity: a deterministic birthday search over
//   same-length valid SVGs finds two DISTINCT byte sequences with the SAME
//   hash (see `vector-reshape-selection-history-collision.test.ts`). The
//   delete gate (`candidate.bytesHash === hash(pendingEntry.bytes)`) and the
//   redo gate (`prior.bytesHash === hash(liveBytes)`) in `Editor.svelte` use
//   that equality as the freshness authorization that attaches a selection
//   snapshot to artwork, so a collision retargets a STALE selection onto
//   different bytes after Undo/Redo.
// - `writeSeq` CAS narrows but does NOT close the hole: it only rejects
//   priors whose slot saw a newer write. Whenever bytes change WITHOUT a
//   seq bump visible at the gate (out-of-order peek/commit race, direct VM
//   mutation bypass, a future path that forgets the bump, seq reset on
//   reload/import), the hash is the SOLE guard and a collision silently
//   authorizes stale selection. Rename adoption and reload scoping have the
//   same shape (seq/generation checked, bytes trusted via hash).
// - Fix (this file + Editor copies): `hashSelectionBytes` emits a
//   versioned SHA-256 digest (`<len>:sha256:<hex64>`, sync pure-TS so the
//   existing synchronous call sites keep working). Snapshots at or under the
//   exact cap retain a PRIVATE copy of their exact bytes (never the caller's
//   buffer, never `entry.bytes` by reference); exact byte equality compares
//   two DISTINCT buffers with `equalSelectionBytes`, never a buffer with
//   itself and never hash-only for retained artwork. New helpers
//   `equalSelectionBytes`, `isSelectionSnapshotFreshForBytes` (retained-exact
//   first, SHA-256 digest fallback for large/deserialized artwork, legacy FNV
//   digests fail closed) and `isSelectionSnapshotUsableForSlot` (slot +
//   generation + seq CAS + byte identity, all required) give the
//   collision-free equality the gates must use. The Editor calls
//   `isSelectionSnapshotFreshForBytes` at both gates and passes PRIVATE copies
//   (never `entry.bytes` by reference) into per-entry snapshots, so retention
//   is evicted together with its entry with no independent eviction.

import { normalizeReshapeHandleMasks, type ReshapeHandleMasks } from './vector-reshape-handle-masks'
import { normalizeReshapeSelection } from './vector-multi-point-selection'

export const RESHAPE_SELECTION_HISTORY_MAX_FLATS = 2000
export const RESHAPE_SELECTION_HISTORY_MAX_BYTES_HASH_LEN = 96
export const RESHAPE_SELECTION_HISTORY_MAX_OBJECTS = 256
// Per-snapshot exact-retention cap: snapshots at or under 64 KiB retain a
// private copy of their exact bytes (never the caller buffer, never an entry
// reference). Typical vector SVGs are a few KB; 64 KiB covers them. Larger
// artwork keeps a digest only (SHA-256 fallback) and NEVER invalidates the
// snapshot: capacity semantics of the history itself are unchanged.
export const RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN = 65536

export interface ReshapeSelectionSnapshot {
  targetId: string
  index: number
  slotKey: string
  projectGeneration: number
  writeSeq?: number | null
  bytesHash: string
  /**
   * Private per-snapshot exact bytes (defensive copy at the ownership
   * boundary: `build`/`normalize`/`clone` each copy, so callers may mutate or
   * reuse their buffer afterwards and sibling consumers mutating `entry.bytes`
   * or another snapshot never corrupt this snapshot, and vice versa).
   * Distinct object from any history entry or live buffer by construction;
   * freshness compares this against a DISTINCT live buffer with
   * `equalSelectionBytes` -- a shared reference passed as both sides fails
   * closed (never a buffer with itself). Absent for large artwork (digest
   * fallback) and `empty:0`.
   */
  bytesExact?: Uint8Array
  objectIndex: number
  selectedObjectIndices: number[]
  masks: ReshapeHandleMasks
  leafIndices: number[]
}

export function reshapeSelectionSlotKey(targetId: string, index: number): string {
  return `paint:${targetId}:${index}`
}

function isValidSlotIndex(index: unknown): index is number {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0
}

function isValidObjectIndex(index: unknown): boolean {
  return typeof index === 'number' && Number.isInteger(index) && (index as number) >= -1
}

export function normalizeSelectedObjectIndices(value: unknown, fallbackPrimary?: number): number[] {
  const out: number[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) continue
      if (out.includes(entry)) continue
      out.push(entry)
      if (out.length >= RESHAPE_SELECTION_HISTORY_MAX_OBJECTS) break
    }
  }
  out.sort((a, b) => a - b)
  if (out.length === 0 && typeof fallbackPrimary === 'number' && Number.isInteger(fallbackPrimary) && fallbackPrimary >= 0) {
    return [fallbackPrimary]
  }
  if (out.length === 0) return []
  return out
}

// SHA-256 (FIPS 180-4), synchronous pure-TS so the existing synchronous
// `hashSelectionBytes` call sites keep working in both the browser bundle
// and unit tests without an async `SubtleCrypto` integration. No
// dependencies, no DOM, no Node APIs.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function sha256Rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

/** Big-endian 32-bit word load; index-safe for any Uint8Array view (no buffer copy). */
function sha256LoadWord(src: Uint8Array, offset: number): number {
  return (
    (src[offset] as number) * 0x1000000 +
    (((src[offset + 1] as number) << 16) |
      ((src[offset + 2] as number) << 8) |
      (src[offset + 3] as number))
  ) >>> 0
}

/**
 * Single SHA-256 compression over 16 big-endian words at `base`.
 * `w` is a caller-owned 64-word scratch pad (reused across blocks, never
 * input-sized); `h` is the running 8-word state, updated in place.
 */
function sha256CompressBlock(src: Uint8Array, base: number, w: number[], h: number[]): void {
  for (let i = 0; i < 16; i += 1) w[i] = sha256LoadWord(src, base + i * 4)
  for (let i = 16; i < 64; i += 1) {
    const x15 = w[i - 15] as number
    const x2 = w[i - 2] as number
    const s0 = sha256Rotr(x15, 7) ^ sha256Rotr(x15, 18) ^ (x15 >>> 3)
    const s1 = sha256Rotr(x2, 17) ^ sha256Rotr(x2, 19) ^ (x2 >>> 10)
    w[i] = ((((w[i - 16] as number) + s0) | 0) + (((w[i - 7] as number) + s1) | 0)) | 0
  }
  let a = h[0] as number
  let b = h[1] as number
  let c = h[2] as number
  let d = h[3] as number
  let e = h[4] as number
  let f = h[5] as number
  let g = h[6] as number
  let hh = h[7] as number
  for (let i = 0; i < 64; i += 1) {
    const s1 = sha256Rotr(e, 6) ^ sha256Rotr(e, 11) ^ sha256Rotr(e, 25)
    const ch = (e & f) ^ (~e & g)
    const t1 = (((((hh + s1) | 0) + ch) | 0) + (((SHA256_K[i] as number) + (w[i] as number)) | 0)) | 0
    const s0 = sha256Rotr(a, 2) ^ sha256Rotr(a, 13) ^ sha256Rotr(a, 22)
    const maj = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (s0 + maj) | 0
    hh = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  h[0] = ((h[0] as number) + a) | 0
  h[1] = ((h[1] as number) + b) | 0
  h[2] = ((h[2] as number) + c) | 0
  h[3] = ((h[3] as number) + d) | 0
  h[4] = ((h[4] as number) + e) | 0
  h[5] = ((h[5] as number) + f) | 0
  h[6] = ((h[6] as number) + g) | 0
  h[7] = ((h[7] as number) + hh) | 0
}

function sha256Hex(bytes: Uint8Array): string {
  // Streaming (FIPS 180-4), bounded scratch: complete 64-byte blocks are
  // compressed straight from the caller's bytes (read-only indexed loads, no
  // copy, any view offset works); only the padding tail (<= 128 bytes) is
  // materialized. Peak temp is the 64-word schedule + 2 blocks regardless of
  // input size. Length accounting uses doubles (exact to 2^53, far beyond any
  // allocatable buffer); the 64-bit bit-length split is `(hi, lo)` with
  // `lo = (len*8) mod 2^32`, so inputs of any real size stay correct where the
  // previous `((len + 8) >> 6) << 6` padded-length shift wrapped past 2^31.
  // No input is rejected here: larger artwork stays valid via the digest (see
  // `hashSelectionBytes`), so capping would be a behavior break, not safety.
  const len = bytes.length
  const bitLenHi = Math.floor(len / 0x20000000)
  const bitLenLo = (len << 3) >>> 0
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array<number>(64)
  const fullLen = len - (len % 64)
  for (let block = 0; block < fullLen; block += 64) {
    sha256CompressBlock(bytes, block, w, h)
  }
  // Padding tail: remaining bytes + 0x80 + zeros + 8-byte big-endian bit
  // length. One block when rem <= 55, two otherwise; zero-filled scratch.
  const rem = len - fullLen
  const tailLen = rem + 1 + 8 <= 64 ? 64 : 128
  const tail = new Uint8Array(tailLen)
  tail.set(bytes.subarray(fullLen), 0)
  tail[rem] = 0x80
  tail[tailLen - 8] = (bitLenHi >>> 24) & 0xff
  tail[tailLen - 7] = (bitLenHi >>> 16) & 0xff
  tail[tailLen - 6] = (bitLenHi >>> 8) & 0xff
  tail[tailLen - 5] = bitLenHi & 0xff
  tail[tailLen - 4] = (bitLenLo >>> 24) & 0xff
  tail[tailLen - 3] = (bitLenLo >>> 16) & 0xff
  tail[tailLen - 2] = (bitLenLo >>> 8) & 0xff
  tail[tailLen - 1] = bitLenLo & 0xff
  for (let block = 0; block < tailLen; block += 64) {
    sha256CompressBlock(tail, block, w, h)
  }
  const hex = (value: number): string => (value >>> 0).toString(16).padStart(8, '0')
  return (
    hex(h[0] as number) +
    hex(h[1] as number) +
    hex(h[2] as number) +
    hex(h[3] as number) +
    hex(h[4] as number) +
    hex(h[5] as number) +
    hex(h[6] as number) +
    hex(h[7] as number)
  )
}

export function hashSelectionBytes(bytes: Uint8Array | undefined | null): string {
  if (!bytes || bytes.length === 0) return 'empty:0'
  // Versioned cryptographic digest over EVERY byte. The previous FNV-1a 32
  // (`<len>:<hex>`) collides on distinct same-length artwork (deterministic
  // birthday collision, see collision test), which the delete/redo
  // freshness gates (`bytesHash` equality) then accept as "fresh" and
  // restore a stale selection onto different artwork. FNV must never be
  // used as an authorization again; SHA-256 is second-preimage resistant,
  // and exact bytes (below) remove hashing from the decision entirely for
  // artwork within the exact cap. The scan is O(n) but streaming with
  // bounded scratch (64-word schedule + <= 2 padding blocks, no input-sized
  // temp), so giant artwork costs time, not a giant transient allocation.
  return `${bytes.length}:sha256:${sha256Hex(bytes)}`
}

/** True only for digests produced by the current `hashSelectionBytes`. */
export function isSha256BytesHash(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const sep = value.indexOf(':sha256:')
  if (sep <= 0) return false
  const len = Number(value.slice(0, sep))
  if (!Number.isInteger(len) || len <= 0) return false
  const hex = value.slice(sep + 8)
  if (hex.length !== 64) return false
  for (let i = 0; i < hex.length; i += 1) {
    const code = hex.charCodeAt(i)
    const digit = code >= 48 && code <= 57
    const lower = code >= 97 && code <= 102
    if (!digit && !lower) return false
  }
  return true
}

/** Exact byte equality: length-checked, then every byte. Never true on hash alone. */
export function equalSelectionBytes(
  left: Uint8Array | undefined | null,
  right: Uint8Array | undefined | null,
): boolean {
  const a = left ?? undefined
  const b = right ?? undefined
  if (a === undefined && b === undefined) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Collision-free freshness: is `snapshot`'s artwork byte-identical to
 * `liveBytes`? Resolution order:
 * 1. A retained private `bytesExact` copy, when present, decides by exact
 *    equality of two DISTINCT buffers (no hash consulted, never a buffer
 *    with itself -- callers pass a freshly read live buffer, never the
 *    stored object; a shared reference passed as both sides fails closed).
 *    Every in-cap snapshot retains its bytes, so this path never evicts.
 * 2. `empty:0` matches only empty/missing bytes.
 * 3. Non-SHA-256 digests (legacy FNV) always fail closed.
 * 4. Digest-only snapshots (large artwork above the cap, or deserialized
 *    entries that lost their copy): versioned SHA-256 digest equality over
 *    every byte. Second-preimage resistant; still never FNV, never
 *    length-only. Slot/generation/seq CAS (see `isSelectionSnapshotUsableForSlot`)
 *    always apply on top, so the digest is never the sole trust factor.
 * Callers must ALSO require slot/generation (`isSelectionSnapshotForSlot`)
 * and seq CAS (`isSelectionSnapshotStale`) — see
 * `isSelectionSnapshotUsableForSlot`.
 */
export function isSelectionSnapshotFreshForBytes(
  snapshot: ReshapeSelectionSnapshot | undefined,
  liveBytes: Uint8Array | undefined | null,
): boolean {
  if (!snapshot) return false
  if (snapshot.bytesExact) {
    const live = liveBytes ?? undefined
    // No self-comparison auth: the same object on both sides proves nothing
    // (an aliased/shared buffer is always "equal" to itself even after the
    // artwork changed elsewhere). Require distinct buffers; callers pass a
    // freshly read `loadAsset` copy, never the stored object.
    if (snapshot.bytesExact === live) return false
    return equalSelectionBytes(snapshot.bytesExact, live)
  }
  if (snapshot.bytesHash === 'empty:0') return !liveBytes || liveBytes.length === 0
  if (!isSha256BytesHash(snapshot.bytesHash)) return false
  try {
    return snapshot.bytesHash === hashSelectionBytes(liveBytes ?? undefined)
  } catch {
    return false
  }
}

/**
 * Exact freshness against an external authoritative byte store: proves
 * `liveBytes` is byte-identical to the artwork `snapshot` was taken from,
 * using the already-budgeted `AssetHistoryEntry.bytes` (`entryBytes`) as
 * the reference alongside any snapshot-held private copy.
 * - `snapshot.bytesHash` must be the versioned SHA-256 of `entryBytes`
 *   (binds the snapshot to the entry; mismatch fails closed), and
 * - `entryBytes` must be byte-equal to `liveBytes` (`equalSelectionBytes`
 *   over DISTINCT buffers; a shared reference on both sides fails closed).
 * No allocation, no hashing of `liveBytes`. Wherever the
 * Editor already holds the corresponding history entry (undo restore,
 * delete-gate `pendingEntry.bytes`), this is strictly stronger than the
 * digest path. Committed priors that have no corresponding
 * entry carry their own retained private `bytesExact` instead.
 */
export function isSelectionSnapshotFreshAgainstEntryBytes(
  snapshot: ReshapeSelectionSnapshot | undefined,
  entryBytes: Uint8Array | undefined | null,
  liveBytes: Uint8Array | undefined | null,
): boolean {
  if (!snapshot) return false
  const entry = entryBytes ?? undefined
  const live = liveBytes ?? undefined
  if (snapshot.bytesExact) {
    // Retained private copy present: it must match BOTH stores (entry
    // binding + live), each compared as a distinct buffer (never a
    // self-compare: shared references fail closed).
    if (snapshot.bytesExact === entry) return false
    if (snapshot.bytesExact === live) return false
    if (!equalSelectionBytes(snapshot.bytesExact, entry)) return false
    return equalSelectionBytes(snapshot.bytesExact, live)
  }
  if (snapshot.bytesHash === 'empty:0') {
    const entryEmpty = !entry || entry.length === 0
    const liveEmpty = !live || live.length === 0
    return entryEmpty && liveEmpty
  }
  if (!isSha256BytesHash(snapshot.bytesHash)) return false
  try {
    if (snapshot.bytesHash !== hashSelectionBytes(entry)) return false
  } catch {
    return false
  }
  // Same-object entry/live proves nothing unless both empty (handled above).
  if (entry !== undefined && entry === live) return false
  return equalSelectionBytes(entry, live)
}

/**
 * Combined usability for a slot: stable id/index/generation AND seq CAS
 * AND exact byte identity must ALL hold. No single factor — hash included —
 * authorizes reuse alone.
 */
export function isSelectionSnapshotUsableForSlot(
  snapshot: ReshapeSelectionSnapshot | undefined,
  targetId: string,
  index: number,
  projectGeneration: number,
  liveWriteSeq: number | null | undefined,
  liveBytes: Uint8Array | undefined | null,
): boolean {
  if (!isSelectionSnapshotForSlot(snapshot, targetId, index, projectGeneration)) return false
  if (isSelectionSnapshotStale(snapshot, liveWriteSeq)) return false
  if (!isSelectionSnapshotFreshForBytes(snapshot, liveBytes)) return false
  return true
}

export function normalizeSelectionSnapshot(snapshot: unknown): ReshapeSelectionSnapshot | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined
  const rec = snapshot as Record<string, unknown>
  const targetId = rec.targetId
  const index = rec.index
  const objectIndex = rec.objectIndex
  if (typeof targetId !== 'string' || targetId.length === 0 || targetId.length > 256) return undefined
  if (!isValidSlotIndex(index)) return undefined
  if (!isValidObjectIndex(objectIndex)) return undefined
  const slotKey = typeof rec.slotKey === 'string' ? (rec.slotKey as string) : reshapeSelectionSlotKey(targetId, index as number)
  if (slotKey !== reshapeSelectionSlotKey(targetId, index as number)) return undefined
  const projectGeneration = rec.projectGeneration
  if (typeof projectGeneration !== 'number' || !Number.isInteger(projectGeneration) || projectGeneration < 0) return undefined
  const writeSeqRaw = rec.writeSeq
  let writeSeq: number | null | undefined
  if (writeSeqRaw === undefined || writeSeqRaw === null) writeSeq = writeSeqRaw as null | undefined
  else if (typeof writeSeqRaw === 'number' && Number.isInteger(writeSeqRaw) && writeSeqRaw >= 0) writeSeq = writeSeqRaw
  else return undefined
  const bytesHash = rec.bytesHash
  if (typeof bytesHash !== 'string' || bytesHash.length === 0 || bytesHash.length > RESHAPE_SELECTION_HISTORY_MAX_BYTES_HASH_LEN) return undefined
  // Per-snapshot exact retention (ownership boundary). Inbound `bytesExact`
  // handling:
  // - Non-Uint8Array copies reject the whole snapshot (fail-closed wire
  //   hygiene, unchanged).
  // - Oversized copies are dropped (digest fallback for large artwork).
  // - SHA-256 digest + in-cap copy: the pair MUST bind
  //   (`hash(copy) === bytesHash`); a mismatch is a forgery and rejects the
  //   whole snapshot fail-closed. A bound pair is COPIED into a private
  //   buffer on the returned snapshot (never the inbound reference), so the
  //   caller may mutate/reuse its buffer afterwards and exact freshness
  //   never depends on an independently evicted cache.
  // - Legacy non-SHA digest (pre-fix FNV) + in-cap copy: the copy is COPIED
  //   for exact-first freshness (drains with history turnover; no new FNV
  //   digests are ever built). `empty:0` never retains a copy.
  let retainedExact: Uint8Array | undefined
  const bytesExactRaw = rec.bytesExact
  if (bytesExactRaw !== undefined) {
    if (!(bytesExactRaw instanceof Uint8Array)) return undefined
    if (bytesExactRaw.length <= RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN) {
      if (bytesHash === 'empty:0') {
        // Empty artwork carries no exact copy.
      } else if (isSha256BytesHash(bytesHash)) {
        let bound = false
        try {
          bound = hashSelectionBytes(bytesExactRaw) === bytesHash
        } catch {
          bound = false
        }
        if (!bound) return undefined
        retainedExact = bytesExactRaw.slice()
      } else {
        // Legacy digest path: copy for exact-first freshness
        // (drains with history turnover; never built anew).
        retainedExact = bytesExactRaw.slice()
      }
    }
  }
  const masks = normalizeReshapeHandleMasks(rec.masks as ReshapeHandleMasks)
  if (Object.keys(masks).length > RESHAPE_SELECTION_HISTORY_MAX_FLATS) return undefined
  const leafIndices = normalizeReshapeSelection((rec.leafIndices ?? []) as readonly number[])
  if (leafIndices.length > RESHAPE_SELECTION_HISTORY_MAX_FLATS) return undefined
  // Full object selection (per-slot, not only reshape masks). Legacy entries
  // without the field fall back to the primary objectIndex so strict old
  // snapshots stay valid; invalid entries fail closed.
  let selectedObjectIndices: number[]
  if (rec.selectedObjectIndices === undefined) {
    selectedObjectIndices = normalizeSelectedObjectIndices(undefined, objectIndex as number)
  } else {
    if (!Array.isArray(rec.selectedObjectIndices)) return undefined
    selectedObjectIndices = normalizeSelectedObjectIndices(rec.selectedObjectIndices as unknown, undefined)
    // When the stored array explicitly names objects, the primary must be
    // consistent when non-empty: a mismatched primary naming a phantom object
    // fails closed (never retarget the wrong unit).
    if (selectedObjectIndices.length > 0 && (objectIndex as number) >= 0 && !selectedObjectIndices.includes(objectIndex as number)) {
      return undefined
    }
    if (selectedObjectIndices.length === 0 && (objectIndex as number) >= 0) {
      // Empty array with a live primary is allowed only for "no object
      // selection" states (e.g. cleared after delete); keep as-is.
    }
    if (selectedObjectIndices.length > RESHAPE_SELECTION_HISTORY_MAX_OBJECTS) return undefined
  }
  return {
    targetId,
    index: index as number,
    slotKey,
    projectGeneration,
    writeSeq,
    bytesHash,
    ...(retainedExact ? { bytesExact: retainedExact } : {}),
    objectIndex: objectIndex as number,
    selectedObjectIndices,
    masks,
    leafIndices,
  }
}

export function buildSelectionSnapshot(options: {
  targetId: string
  index: number
  projectGeneration: number
  writeSeq?: number | null
  bytes: Uint8Array | undefined | null
  objectIndex: number
  selectedObjectIndices?: readonly number[] | undefined | null
  masks: ReshapeHandleMasks | undefined | null
  leafIndices: readonly number[] | undefined | null
}): ReshapeSelectionSnapshot | undefined {
  if (typeof options.targetId !== 'string' || options.targetId.length === 0) return undefined
  if (!isValidSlotIndex(options.index)) return undefined
  if (!isValidObjectIndex(options.objectIndex)) return undefined
  if (typeof options.projectGeneration !== 'number' || !Number.isInteger(options.projectGeneration) || options.projectGeneration < 0) return undefined
  const masks = normalizeReshapeHandleMasks(options.masks ?? {})
  if (Object.keys(masks).length > RESHAPE_SELECTION_HISTORY_MAX_FLATS) return undefined
  const leafIndices = normalizeReshapeSelection(options.leafIndices ?? [])
  const selectedObjectIndices =
    options.selectedObjectIndices === undefined || options.selectedObjectIndices === null
      ? normalizeSelectedObjectIndices(undefined, options.objectIndex)
      : normalizeSelectedObjectIndices(options.selectedObjectIndices, undefined)
  if (selectedObjectIndices.length > RESHAPE_SELECTION_HISTORY_MAX_OBJECTS) return undefined
  const sourceBytes = options.bytes ?? undefined
  // Private copy at the ownership boundary: the snapshot owns its bytes, so
  // the caller may mutate/reuse `options.bytes` afterwards without corrupting
  // history. `normalizeSelectionSnapshot` below copies once more and binds
  // the copy to the digest (mismatch rejects fail-closed); the transient
  // copy here keeps the boundary explicit even for callers that reuse.
  const bytesHash = hashSelectionBytes(sourceBytes)
  const bytesExact =
    sourceBytes && sourceBytes.length > 0 && sourceBytes.length <= RESHAPE_SELECTION_HISTORY_MAX_BYTES_EXACT_LEN
      ? sourceBytes.slice()
      : undefined
  return normalizeSelectionSnapshot({
    targetId: options.targetId,
    index: options.index,
    slotKey: reshapeSelectionSlotKey(options.targetId, options.index),
    projectGeneration: options.projectGeneration,
    writeSeq: options.writeSeq ?? null,
    bytesHash,
    ...(bytesExact ? { bytesExact } : {}),
    objectIndex: options.objectIndex,
    selectedObjectIndices,
    masks,
    leafIndices,
  })
}

export function cloneSelectionSnapshot(snapshot: ReshapeSelectionSnapshot | undefined): ReshapeSelectionSnapshot | undefined {
  if (!snapshot) return undefined
  const normalized = normalizeSelectionSnapshot(snapshot)
  if (!normalized) return undefined
  // `normalized` already holds a private copy via `normalize` (never the
  // input reference), so the clone is isolated from both the source snapshot
  // and any history entry by construction; no further slice needed here.
  return { ...normalized, selectedObjectIndices: [...normalized.selectedObjectIndices], masks: { ...normalized.masks }, leafIndices: [...normalized.leafIndices] }
}

/** Prior-committed merge: ignore current UI, keep prior (oracle Scenario A/B). */
export function mergeSelectionAtPriorCommitted(
  prior: ReshapeSelectionSnapshot | undefined,
): ReshapeSelectionSnapshot | undefined {
  return cloneSelectionSnapshot(prior)
}

export function isSelectionSnapshotForSlot(
  snapshot: ReshapeSelectionSnapshot | undefined,
  targetId: string,
  index: number,
  projectGeneration: number,
): boolean {
  if (!snapshot) return false
  if (snapshot.targetId !== targetId) return false
  if (snapshot.index !== index) return false
  if (snapshot.slotKey !== reshapeSelectionSlotKey(targetId, index)) return false
  if (snapshot.projectGeneration !== projectGeneration) return false
  return true
}

/** CAS: stale when live writeSeq diverges from snapshot (same-bytes external visible). */
export function isSelectionSnapshotStale(
  snapshot: ReshapeSelectionSnapshot | undefined,
  liveWriteSeq: number | null | undefined,
): boolean {
  if (!snapshot) return true
  const want = snapshot.writeSeq ?? null
  const live = liveWriteSeq ?? null
  if (want === null && live === null) return false
  if (want === null || live === null) return true
  return want !== live
}

export type RestorableAnchor = { index: number; x: number; y: number }

function isValidAnchor(point: unknown): point is RestorableAnchor {
  if (!point || typeof point !== 'object') return false
  const rec = point as Record<string, unknown>
  return (
    typeof rec.index === 'number' &&
    Number.isInteger(rec.index) &&
    (rec.index as number) >= 0 &&
    typeof rec.x === 'number' &&
    Number.isFinite(rec.x) &&
    typeof rec.y === 'number' &&
    Number.isFinite(rec.y)
  )
}

/**
 * Validate a snapshot against restored artwork (fail-closed).
 * - objectIndex must resolve to an existing unit (caller checks).
 * - every mask/leaf flat must name a live anchor; others dropped.
 * - duplicate anchor coordinates within epsilon make the mapping ambiguous:
 *   any mask naming a duplicated coordinate is dropped (never retarget stale).
 * Returns undefined when nothing survives (caller clears selection).
 */
export function validateSelectionSnapshotForAnchors(
  snapshot: ReshapeSelectionSnapshot | undefined,
  liveAnchors: readonly RestorableAnchor[],
  epsilon = 0.01,
): ReshapeSelectionSnapshot | undefined {
  const base = normalizeSelectionSnapshot(snapshot)
  if (!base) return undefined
  const tolerance = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0.01
  const validAnchors = liveAnchors.filter(isValidAnchor)
  const liveSet = new Set(validAnchors.map((point) => point.index))
  // Duplicate-coordinate detection (fail-closed): group by quantized coord.
  const coordGroups = new Map<string, number[]>()
  for (const point of validAnchors) {
    const key = `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}`
    const list = coordGroups.get(key)
    if (list) list.push(point.index)
    else coordGroups.set(key, [point.index])
  }
  const duplicated = new Set<number>()
  for (const list of coordGroups.values()) {
    if (list.length > 1) for (const flat of list) duplicated.add(flat)
  }
  const outMasks: ReshapeHandleMasks = {}
  for (const [key, value] of Object.entries(base.masks)) {
    const flat = Number(key)
    if (!Number.isInteger(flat) || flat < 0) continue
    if (!liveSet.has(flat)) continue
    if (duplicated.has(flat)) continue
    outMasks[flat] = value
  }
  const outLeaves = base.leafIndices.filter((flat) => liveSet.has(flat) && !duplicated.has(flat))
  // Cap memory: already bounded by normalize, re-check after filtering.
  // `base` holds a private copy via `normalize`, so no further byte copy is
  // needed here; the spread below keeps that private buffer.
  if (Object.keys(outMasks).length > RESHAPE_SELECTION_HISTORY_MAX_FLATS) return undefined
  return { ...base, masks: outMasks, leafIndices: outLeaves }
}

/**
 * Validate the full object selection against restored artwork (fail-closed).
 * - No coordinate rebase and no nested-group remapping: indices are used
 *   verbatim, unknown indices are dropped (never retarget the wrong unit).
 * - When the primary `objectIndex` names a vanished unit, the whole object
 *   selection is dropped (caller clears reshape too — no phantom object).
 * - Empty stays empty (cleared selection restores cleared).
 */
export function validateSelectionSnapshotForObjects(
  snapshot: ReshapeSelectionSnapshot | undefined,
  liveObjectIndices: readonly number[],
): ReshapeSelectionSnapshot | undefined {
  const base = normalizeSelectionSnapshot(snapshot)
  if (!base) return undefined
  const liveSet = new Set<number>()
  for (const entry of liveObjectIndices) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) continue
    liveSet.add(entry)
  }
  const filtered = base.selectedObjectIndices.filter((entry) => liveSet.has(entry))
  if (base.objectIndex >= 0) {
    if (!liveSet.has(base.objectIndex)) return undefined
    if (filtered.length > 0 && !filtered.includes(base.objectIndex)) return undefined
    // Primary live but selection empty (e.g. cleared object with live reshape
    // on the same unit) stays as stored: objectIndex drives the owner, the
    // empty array drives the outline state. Do not invent [primary].
  } else {
    if (filtered.length > 0) return undefined
  }
  if (filtered.length > RESHAPE_SELECTION_HISTORY_MAX_OBJECTS) return undefined
  // `base` holds a private copy via `normalize`, so no further byte copy is
  // needed here; the spread below keeps that private buffer.
  return { ...base, selectedObjectIndices: [...filtered] }
}
