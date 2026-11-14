/**
 * Versioned own-write skip + in-flight barrier for the bitmap canvas reload
 * (fail-closed, production-only, no test hooks).
 *
 * Focused feature helper (AGENTS split): pure decision logic, no Svelte, no
 * DOM, no VM/history access. The Editor owns all VM reads (`getCostumeIdentity`,
 * `getProjectGeneration`, `getSelectionEpoch`) and the async reload itself;
 * this module only answers "may this reload be skipped, and why".
 *
 * Leak it fixes: pre-arming only `targetId:index` BEFORE `await commit` lets
 * ANY same-slot external reload during the flight be swallowed (the consumer
 * sees the slot key match with `assetKey/writeSeq === undefined` and skips).
 * An external green, a same-bytes rename bump (same `md5ext`, `writeSeq` + 1),
 * a target switch or a project replacement all share that slot key, so the
 * swallowed reload hides foreign art behind a stale canvas.
 *
 * Discipline:
 * - BEFORE any `await`, the Editor captures a barrier (`captureReloadBarrier`)
 *   with the exact pre-flight identity: slot key, live `assetKey`, live
 *   `writeSeq`, live `projectGeneration`, live `selectionEpoch`. The barrier
 *   NEVER authorizes a skip: while it is armed for the slot, the consumer
 *   must reload (or buffer until the flight settles), never skip.
 * - AFTER a PROVEN local write (CAS `applied: true` verified by the pending
 *   coordinator, or the `await vm.updateCostume` resolved for legacy saves),
 *   the Editor arms a versioned skip (`armReloadSkipFromLive`) from a fresh
 *   live read: slot key + committed `assetKey` + committed `writeSeq` +
 *   current `projectGeneration` + current `selectionEpoch`.
 * - The consumer (`shouldSkipBitmapCanvasReload`) skips only when every field
 *   matches the fresh live read: same slot, same bytes key, same `writeSeq`
 *   (external same-byte writes bump it, so a rename never reads as own),
 *   same `projectGeneration` (loadProject/clear reusing ids never skips), and
 *   same `selectionEpoch` (an away-and-back switch never skips even when the
 *   final slot equality holds again). Legacy key-only tokens
 *   (`assetKey === undefined`) NEVER skip.
 * - Local saves mint an unpredictable new `md5ext`: the barrier covers the
 *   flight (no skip while in flight), and the post-write arm re-reads the
 *   live identity, so no pre-commit guess is needed. Reloads arriving during
 *   the flight buffer (`deferred` flag) and reconcile from live after the
 *   flight settles: never silently dropped, never painted stale, never
 *   losing the pending/second pointer (pointer state is untouched here).
 */

export type BitmapReloadLiveIdentity = {
  /** Slot key (`stableTargetId:index`), exact, never a display-name alias. */
  key: string
  /** Stored-bytes key currently live (`md5ext ?? assetId ?? ''`). */
  assetKey: string
  /** Monotonic per-slot version currently live (`null` when unknown). */
  writeSeq: number | null
  /** Whole-project generation currently live. */
  projectGeneration: number
  /** Monotonic selection epoch currently live (`null` when unknown). */
  selectionEpoch: number | null
}

export type BitmapReloadSkipToken = {
  key: string
  assetKey: string
  writeSeq: number | null
  projectGeneration: number
  selectionEpoch: number | null
}

export type BitmapReloadBarrier = {
  key: string
  baseAssetKey: string
  baseWriteSeq: number | null
  projectGeneration: number
  selectionEpoch: number | null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Normalize a live identity read (fail-closed: unknown slot never skips). */
export function normalizeReloadLiveIdentity(value: unknown): BitmapReloadLiveIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.key)) return undefined
  if (typeof record.assetKey !== 'string') return undefined
  const writeSeq = record.writeSeq
  const projectGeneration = record.projectGeneration
  const selectionEpoch = record.selectionEpoch
  if (!isCounter(projectGeneration)) return undefined
  if (writeSeq !== null && writeSeq !== undefined && !isCounter(writeSeq)) return undefined
  if (selectionEpoch !== null && selectionEpoch !== undefined && !isCounter(selectionEpoch)) return undefined
  return {
    key: record.key as string,
    assetKey: record.assetKey as string,
    writeSeq: typeof writeSeq === 'number' ? (writeSeq as number) : null,
    projectGeneration: projectGeneration as number,
    selectionEpoch: typeof selectionEpoch === 'number' ? (selectionEpoch as number) : null,
  }
}

/** Versioned tokens only: unknown versions never skip (fail-closed). */
export function isVersionedReloadSkipToken(value: unknown): value is BitmapReloadSkipToken {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.key)) return false
  if (typeof record.assetKey !== 'string' || (record.assetKey as string).length === 0) return false
  if (!isCounter(record.writeSeq)) return false
  if (!isCounter(record.projectGeneration)) return false
  if (!isCounter(record.selectionEpoch)) return false
  return true
}

/**
 * Decide whether the pending canvas reload may be skipped. Pure.
 *
 * - `barrier` armed for this slot (commit/save still in flight) -> never
 *   skip: the reload must buffer until the flight settles and reconcile from
 *   live then (returns `skip: false, buffered: true`).
 * - versioned `token` present and every field matches `live` (plus `png`
 *   gate) -> skip once (own committed bytes, canvas already shows them).
 * - anything else (legacy key-only token, any drift, unknown live) ->
 *   reload (`skip: false`).
 */
export function shouldSkipBitmapCanvasReload(
  token: BitmapReloadSkipToken | undefined | null,
  barrier: BitmapReloadBarrier | undefined | null,
  live: BitmapReloadLiveIdentity | undefined | null,
  dataFormat: string | undefined,
): { skip: boolean; buffered: boolean; reason: string } {
  if (!live) return { skip: false, buffered: false, reason: 'live-unknown' }
  if (barrier && barrier.key === live.key) {
    // In-flight own write: no skip may be consumed yet. The caller buffers
    // (defers) this reload and reconciles from live after the flight
    // settles, so an external green/rename/switch/load during the flight is
    // never swallowed and no stale pre-flight bytes are painted.
    return { skip: false, buffered: true, reason: 'commit-in-flight' }
  }
  if (dataFormat !== 'png') return { skip: false, buffered: false, reason: 'not-png' }
  if (!isVersionedReloadSkipToken(token)) return { skip: false, buffered: false, reason: 'unversioned-token' }
  if (token.key !== live.key) return { skip: false, buffered: false, reason: 'slot-moved' }
  if (token.assetKey !== live.assetKey) return { skip: false, buffered: false, reason: 'bytes-drift' }
  if (!isCounter(token.writeSeq) || !isCounter(live.writeSeq)) {
    return { skip: false, buffered: false, reason: 'seq-unknown' }
  }
  if (token.writeSeq !== live.writeSeq) {
    return { skip: false, buffered: false, reason: 'seq-drift' }
  }
  if (token.projectGeneration !== live.projectGeneration) return { skip: false, buffered: false, reason: 'generation-moved' }
  if (!isCounter(token.selectionEpoch) || !isCounter(live.selectionEpoch)) {
    return { skip: false, buffered: false, reason: 'selection-unknown' }
  }
  if (token.selectionEpoch !== live.selectionEpoch) {
    return { skip: false, buffered: false, reason: 'selection-moved' }
  }
  return { skip: true, buffered: false, reason: 'own-committed-version' }
}
