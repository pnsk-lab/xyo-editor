/**
 * Vector slot CAS helpers (pure, framework-free).
 *
 * The VM (`costume-slot-cas.ts` + `ScratchVM`) owns the monotonic per-slot
 * `writeSeq` and the project-generation / per-target structure guards. The
 * Editor must never compare slots by hash alone: a metadata-only external
 * write (same `assetId`/`md5ext`, bumped `writeSeq`) and a same-bytes
 * external rewrite (new `storeAsset` call, same identity, bumped `writeSeq`)
 * are invisible to `{ assetId, md5ext }` but visible to the version.
 *
 * This module is the single place that builds versioned CAS `expected`
 * values from `getCostumeIdentity()` and tracks the gesture's last known
 * identity. `Editor.svelte` only wires it: capture at press time, expect the
 * last known identity on every preview/cancel/commit, propagate the returned
 * `writeSeq` to the next frame, and fail closed (keep the external, warn,
 * drop preview residue, no history) on conflict. Direct `vm.updateCostume`
 * calls that bypass the VM slot queue are NOT protected (documented
 * boundary, same as the VM helper).
 *
 * History safety: each peeked paint entry records the observed slot identity
 * (`assetId`/`md5ext`/`writeSeq`) at capture time. Undo/Redo compares the
 * live slot identity against the observed identity and the Editor's last
 * known `writeSeq` for the slot; any divergence means an external write
 * landed in between, so the restore is refused with the stack intact. A
 * selection re-intake after an external write starts a new history baseline.
 */

/** Versioned slot identity read from `vm.getCostumeIdentity()`. */
export interface VectorSlotIdentity {
  assetId?: string | null
  md5ext?: string | null
  /** Monotonic per-slot version. Absent only for legacy backends. */
  writeSeq?: number | null
}

/** CAS expected value for one stable slot (VM `CostumeWriteExpected` shape). */
export interface VectorSlotExpected {
  assetId?: string | null
  md5ext?: string | null
  writeSeq?: number | null
}

/** Per-gesture CAS record: press-time base + last editor-known identity. */
export interface VectorGestureCasRecord {
  targetId: string
  index: number
  base: VectorSlotIdentity
  last: VectorSlotIdentity
  conflicted: boolean
}

/** Normalize any identity-like value to a slot identity (copies seq). */
export function vectorSlotIdentityOf(value: unknown): VectorSlotIdentity {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const out: VectorSlotIdentity = {}
  if (typeof record.assetId === 'string' || record.assetId === null) out.assetId = record.assetId as string | null
  else if (record.assetId !== undefined) out.assetId = record.assetId as VectorSlotIdentity['assetId']
  if (typeof record.md5ext === 'string' || record.md5ext === null) out.md5ext = record.md5ext as string | null
  else if (record.md5ext !== undefined) out.md5ext = record.md5ext as VectorSlotIdentity['md5ext']
  const seq = record.writeSeq ?? record.seq ?? record.version
  if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) out.writeSeq = seq
  return out
}

/** True when the identity carries a usable monotonic version. */
export function hasVectorWriteSeq(identity: VectorSlotIdentity | undefined | null): boolean {
  return typeof identity?.writeSeq === 'number' && Number.isInteger(identity.writeSeq) && (identity.writeSeq as number) >= 0
}

/** Create a gesture CAS record from the press-time identity. */
export function createVectorGestureCasRecord(
  targetId: string,
  index: number,
  identity: VectorSlotIdentity | undefined | null,
): VectorGestureCasRecord {
  const base = vectorSlotIdentityOf(identity ?? {})
  return { targetId, index, base: { ...base }, last: { ...base }, conflicted: false }
}

/** Build the CAS `expected` for the next write from the last known identity. */
export function vectorCasExpectedOf(record: VectorGestureCasRecord | undefined | null): VectorSlotExpected | undefined {
  if (!record) return undefined
  return { ...record.last }
}

/** Record a successful preview/commit: the next frame expects the new seq. */
export function noteVectorCasApplied(
  record: VectorGestureCasRecord | undefined | null,
  current: VectorSlotIdentity | undefined | null,
): void {
  if (!record || !current) return
  record.last = vectorSlotIdentityOf(current)
}

/** Mark the gesture conflicted (external won; never force-write after this). */
export function markVectorCasConflicted(record: VectorGestureCasRecord | undefined | null): void {
  if (record) record.conflicted = true
}

/** True when the gesture already lost to an external write. */
export function isVectorCasConflicted(record: VectorGestureCasRecord | undefined | null): boolean {
  return record?.conflicted === true
}

/** Per-history observed slot identity (paint entry capture time). */
export interface VectorHistoryObserved {
  assetId?: string | null
  md5ext?: string | null
  writeSeq?: number | null
}

/** Snapshot the observed identity for a history entry. */
export function observeVectorHistoryIdentity(identity: VectorSlotIdentity | undefined | null): VectorHistoryObserved {
  return vectorSlotIdentityOf(identity ?? {})
}

/**
 * Fail-closed external check for Undo/Redo.
 *
 * Returns `true` when the live slot diverged from the Editor's last known
 * state and the restore must be refused (stack intact + status):
 * - when both sides carry a version, any `writeSeq` mismatch blocks, even
 *   when hashes match (metadata-only / same-bytes external);
 * - without a version on either side, fall back to hash comparison.
 */
export function isVectorHistoryStale(
  live: VectorHistoryObserved | undefined | null,
  known: VectorHistoryObserved | undefined | null,
): boolean {
  if (!live || !known) return false
  const liveSeq = live.writeSeq
  const knownSeq = known.writeSeq
  if (typeof liveSeq === 'number' && typeof knownSeq === 'number') return liveSeq !== knownSeq
  if (typeof liveSeq === 'number' || typeof knownSeq === 'number') return true
  return live.assetId !== known.assetId || live.md5ext !== known.md5ext
}

/**
 * Status text for a safely rejected external conflict (external kept).
 * Pure so tests and the Editor share the exact wording.
 */
export function vectorExternalConflictStatus(action: string): string {
  return `External costume change kept — ${action} canceled without overwriting it`
}
