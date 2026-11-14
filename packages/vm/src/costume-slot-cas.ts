/**
 * Costume slot compare-and-swap (CAS) shared types.
 *
 * Split out of the VM core so slot-safety policy lives in one feature
 * helper. The VM owns the monotonic counters; this module only defines the
 * wire shape and pure version extraction.
 *
 * Safety model (explicit boundaries, by design):
 *
 * - Stable-id-only CAS vs legacy name resolution are separate routes.
 *   `updateCostumeIfMatch` resolves the target by stable id only and never
 *   steers onto a same-name alias. `updateCostume` keeps the legacy
 *   `id === query || name === query` resolution for existing callers.
 * - Every successful slot write (bytes or metadata-only, including the
 *   synchronous `renameCostume`) bumps a monotonic per-slot version. Callers
 *   capture `{ assetId, md5ext, writeSeq }` via `getCostumeIdentity` and pass
 *   it back as `expected`; a CAS whose version no longer matches keeps the
 *   live (external) write instead of silently deleting it. `expected` without
 *   a version field keeps the legacy hash-only behavior for compatibility.
 *   The VM verifies `expected` both before the `storeAsset` await and after
 *   it (immediately before the atomic mutation), so a rename landing inside
 *   the await window is kept as well.
 * - The slot queue additionally captures the project generation, the live
 *   target/costume object references, and the per-target structure sequence
 *   at enqueue time, and re-validates them before running and after the
 *   `storeAsset` await. `loadProject` / `clear` / whole-project replacement,
 *   target delete/recreate, and index-shifting structure ops therefore always
 *   discard stale queued writes.
 * - `dataFormat` follows patch priority (`patch.dataFormat ?? live format`),
 *   unchanged by this helper.
 * - Out of scope (no protection): direct plain-object mutation of
 *   `project.targets` / costume objects, and plugins that bypass the VM API.
 *   Only writes funneled through the VM slot queue participate in CAS.
 */

/** Versioned compare expectation for one stable costume slot. */
export interface CostumeWriteExpected {
  assetId?: string | null
  md5ext?: string | null
  /**
   * Monotonic per-slot version captured at gesture/source time.
   * `seq` / `version` are accepted aliases; the first valid integer wins.
   * Omitted (legacy shape) keeps hash-only comparison for compatibility.
   */
  writeSeq?: number | null
  seq?: number | null
  version?: number | null
}

/** Strict id-scoped identity read for one stable costume slot. */
export interface CostumeSlotIdentity {
  assetId?: string
  md5ext?: string
  dataFormat?: string
  /** Monotonic write count for this slot (0 when never written). */
  writeSeq: number
}

/** Extract the expected version, or `undefined` for legacy hash-only callers. */
export function expectedWriteSeqOf(expected?: CostumeWriteExpected | null): number | undefined {
  if (!expected) return undefined
  const candidates = [expected.writeSeq, expected.seq, expected.version]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0) return candidate
  }
  return undefined
}

/** Stable slot key for one target id + costume index (never display names). */
export function costumeSlotKeyOf(targetId: string, index: number): string {
  return `${targetId}:${index}`
}

/**
 * Backward-compatible selection precondition for an explicit discrete user
 * commit (click stamp / rect-oval-line drag commit only).
 *
 * - `targetId` / `index` are the *selection* at commit-capture time
 *   (stable target id exact, no display-name fallback; `index` is the
 *   selected costume index, which equals the owner slot for discrete saves).
 * - `projectGeneration` is the VM `getProjectGeneration()` at capture time;
 *   any whole-project replacement (even reusing the same target id)
 *   invalidates the guard.
 * - `selectionEpoch` is the VM `getSelectionEpoch()` at capture time; every
 *   real selection change (target switch, costume switch) bumps it
 *   monotonically, so an away-and-back that ends with the same
 *   `(targetId,index)` still invalidates (final equality alone is not enough).
 * - All fields are optional for backward compatibility: omitted fields are
 *   not checked. Callers that do not pass a selection (previews, cancel
 *   restores, history Undo/Redo, external plugin calls) keep the legacy
 *   behavior unchanged.
 */
export interface CostumeSelectionPrecondition {
  targetId?: string | null
  index?: number | null
  projectGeneration?: number | null
  selectionEpoch?: number | null
}

/** Result reason for `updateCostumeIfMatch` (optional, backward-compatible). */
export type CostumeWriteReason = 'superseded' | 'conflict'

/**
 * Cooperative abort token for `updateCostumeIfMatch` (7th arg, optional).
 *
 * The pending-bitmap coordinator owns a per-flight abort flag and hands it
 * to its trusted writer; the writer forwards it here so an `abortInFlight`
 * (or project-replace discard) that lands inside the `storeAsset` await
 * window prevents the atomic mutation itself instead of merely reporting
 * `aborted` after clobbering. Accepted shapes (all optional, all
 * backward-compatible):
 * - `{ aborted: true }` mutable flag (helper-owned per-flight object),
 * - `{ isAborted: () => true }` callback,
 * - a standard `AbortSignal` (`signal.aborted === true` aborts).
 * `undefined` (omitted) keeps the legacy behavior unchanged.
 */
export type CostumeWriteAbortToken =
  | { aborted?: boolean; isAborted?: (() => boolean) | undefined }
  | AbortSignal
  | undefined

/** True when the cooperative abort token requests cancellation. Never throws. */
export function isCostumeWriteAborted(token: CostumeWriteAbortToken): boolean {
  try {
    if (!token) return false
    if (typeof (token as AbortSignal).aborted === 'boolean') return (token as AbortSignal).aborted === true
    const record = token as { aborted?: unknown; isAborted?: unknown }
    if (record.aborted === true) return true
    if (typeof record.isAborted === 'function') {
      try {
        return (record.isAborted as () => unknown)() === true
      } catch {
        return false
      }
    }
    return false
  } catch {
    return false
  }
}

/** Minimal asset identity for one costume slot (bytes identity only). */
export interface CostumeAssetIdentity {
  assetId?: string | null
  md5ext?: string | null
  dataFormat?: string | null
}

/** True when two slot assets share the same bytes identity (strict, no alias). */
export function isSameCostumeAsset(a: CostumeAssetIdentity | undefined | null, b: CostumeAssetIdentity | undefined | null): boolean {
  if (!a || !b) return false
  return a.assetId === b.assetId && a.md5ext === b.md5ext && (a.dataFormat ?? undefined) === (b.dataFormat ?? undefined)
}

interface SyncProjectLike {
  targets?: Array<{
    id?: string
    isStage?: boolean
    isClone?: boolean
    costumes?: Array<CostumeAssetIdentity | undefined | null> | undefined | null
  } | undefined | null> | undefined | null
}

// All-optional, unknown-valued shapes on purpose: both the live
// `ScratchProject` and postMessage-cloned snapshots must be assignable
// without an index signature, and every comparison below goes through
// JSON key picks, never property access.
interface HostSyncTargetLike {
  id?: unknown
  isStage?: unknown
  isClone?: unknown
  name?: unknown
  variables?: unknown
  lists?: unknown
  broadcasts?: unknown
  blocks?: unknown
  comments?: unknown
  costumes?: unknown
  sounds?: unknown
  textToSpeechLanguage?: unknown
}

interface HostSyncProjectLike {
  targets?: unknown
  monitors?: unknown
  extensions?: unknown
}

/**
 * True when `incoming` is the same logical project as `current` for
 * pure runtime-state sync: same non-clone target id set in the same order,
 * same costume counts, and same per-slot bytes identity (`assetId` /
 * `md5ext` / `dataFormat`) for every slot.
 *
 * Deliberately ignores display names (same-name alias never counts),
 * costume metadata (`name` / `rotationCenterX/Y` — metadata-only external
 * writes keep the same bytes identity), and all runtime-mutable fields
 * (`x` / `y` / variables / `currentCostume` / …). An apparent id match
 * alone is never sufficient: any slot-identity divergence returns false so
 * callers never mistake a true replacement (same target id, different art)
 * for the same project.
 */
export function isSameProjectSlotsForSync(
  current: SyncProjectLike | undefined | null,
  incoming: SyncProjectLike | undefined | null,
): boolean {
  const curTargets = (current?.targets ?? []).filter((t) => t && !t.isClone)
  const incTargets = (incoming?.targets ?? []).filter((t) => t && !t.isClone)
  if (curTargets.length !== incTargets.length) return false
  for (let i = 0; i < curTargets.length; i += 1) {
    const cur = curTargets[i]!
    const inc = incTargets[i]!
    // Stable-id-only comparison: same-name alias never counts.
    if ((cur.id ?? '') !== (inc.id ?? '')) return false
    if (Boolean(cur.isStage) !== Boolean(inc.isStage)) return false
    const curCostumes = cur.costumes ?? []
    const incCostumes = inc.costumes ?? []
    if (curCostumes.length !== incCostumes.length) return false
    for (let j = 0; j < curCostumes.length; j += 1) {
      if (!isSameCostumeAsset(curCostumes[j] ?? undefined, incCostumes[j] ?? undefined)) return false
    }
  }
  return true
}

/**
 * True when `incoming` carries no host-owned structural change relative to
 * `current`, so a host -> worker sync may take the runtime-only fast path
 * (same epoch, execution preserved). Any host edit to code, assets, sounds,
 * target set/order/identity, declarations, or monitor/extension structure
 * returns false and the caller must perform a full host-authoritative
 * replacement with an epoch reset.
 *
 * Runtime-mutable values are deliberately excluded: variable/list contents,
 * positions, costume selection, effects, pen state, and monitor `value`
 * fields flow through either path, so live values alone never force a
 * replacement (and never rewind the worker with stale host values at
 * sync-time granularity — flag-time replacement restarts from host values).
 * Clones are filtered on both sides (worker-owned transient state).
 */
export function isSameHostProjectForSync(
  current: HostSyncProjectLike | undefined | null,
  incoming: HostSyncProjectLike | undefined | null,
): boolean {
  const curTargets = ((current?.targets ?? []) as Array<HostSyncTargetLike | undefined | null>).filter((t) => t && !t.isClone)
  const incTargets = ((incoming?.targets ?? []) as Array<HostSyncTargetLike | undefined | null>).filter((t) => t && !t.isClone)
  if (curTargets.length !== incTargets.length) return false
  for (let i = 0; i < curTargets.length; i += 1) {
    const cur = curTargets[i]!
    const inc = incTargets[i]!
    if ((cur.id ?? '') !== (inc.id ?? '')) return false
    if (Boolean(cur.isStage) !== Boolean(inc.isStage)) return false
    if ((cur.name ?? '') !== (inc.name ?? '')) return false
    if (JSON.stringify(cur.textToSpeechLanguage ?? null) !== JSON.stringify(inc.textToSpeechLanguage ?? null)) return false
    if (JSON.stringify(cur.costumes ?? []) !== JSON.stringify(inc.costumes ?? [])) return false
    if (JSON.stringify(cur.sounds ?? []) !== JSON.stringify(inc.sounds ?? [])) return false
    if (JSON.stringify(cur.blocks ?? {}) !== JSON.stringify(inc.blocks ?? {})) return false
    if (JSON.stringify(cur.comments ?? {}) !== JSON.stringify(inc.comments ?? {})) return false
    if (JSON.stringify(cur.broadcasts ?? {}) !== JSON.stringify(inc.broadcasts ?? {})) return false
    if (!isSameDataDeclarations(cur.variables, inc.variables)) return false
    if (!isSameDataDeclarations(cur.lists, inc.lists)) return false
  }
  const curExtensions = [...new Set((current as { extensions?: unknown })?.extensions as string[] ?? [])].sort()
  const incExtensions = [...new Set((incoming as { extensions?: unknown })?.extensions as string[] ?? [])].sort()
  if (JSON.stringify(curExtensions) !== JSON.stringify(incExtensions)) return false
  return isSameMonitorStructure(current?.monitors, incoming?.monitors)
}

function isSameDataDeclarations(a: unknown, b: unknown): boolean {
  const aEntries = Object.entries((a ?? {}) as Record<string, unknown>)
  const bEntries = Object.entries((b ?? {}) as Record<string, unknown>)
  if (aEntries.length !== bEntries.length) return false
  const bById = new Map(bEntries.map(([id, record]) => [id, record]))
  for (const [id, record] of aEntries) {
    if (!bById.has(id)) return false
    // Declaration identity = id + display name (+ cloud flag for variables).
    // Contents are runtime-mutable and excluded on purpose.
    const aName = Array.isArray(record) ? record[0] : (record as { name?: unknown })?.name
    const bRecord = bById.get(id)
    const bName = Array.isArray(bRecord) ? bRecord[0] : (bRecord as { name?: unknown })?.name
    if (String(aName ?? '') !== String(bName ?? '')) return false
    const aCloud = Array.isArray(record) ? record[2] : undefined
    const bCloud = Array.isArray(bRecord) ? bRecord[2] : undefined
    if (Boolean(aCloud) !== Boolean(bCloud)) return false
  }
  return true
}

function isSameMonitorStructure(a: unknown, b: unknown): boolean {
  const listA = ((a ?? []) as Array<Record<string, unknown> | undefined | null>).filter(Boolean) as Record<string, unknown>[]
  const listB = ((b ?? []) as Array<Record<string, unknown> | undefined | null>).filter(Boolean) as Record<string, unknown>[]
  if (listA.length !== listB.length) return false
  const keyOf = (m: Record<string, unknown>): string => JSON.stringify({
    id: m.id ?? null,
    mode: m.mode ?? null,
    opcode: m.opcode ?? null,
    params: m.params ?? null,
    spriteName: m.spriteName ?? null,
    visible: m.visible ?? null,
    width: m.width ?? null,
    height: m.height ?? null,
    x: m.x ?? null,
    y: m.y ?? null,
    sliderMin: m.sliderMin ?? null,
    sliderMax: m.sliderMax ?? null,
    isDiscrete: m.isDiscrete ?? null,
  })
  const aKeys = listA.map(keyOf).sort()
  const bKeys = listB.map(keyOf).sort()
  return JSON.stringify(aKeys) === JSON.stringify(bKeys)
}

/**
 * Enqueue-time snapshot for one slot write. The VM captures the project
 * generation, the live target/costume object references, and the per-target
 * structure sequence synchronously at enqueue time, then re-validates them
 * before running and after every await. Any project replacement, target
 * delete/recreate, or index-shifting structure op in between discards the
 * stale write. Object references are typed as `unknown` here so this helper
 * stays independent of the VM core; the VM narrows them on use.
 */
export interface SlotWriteCapture {
  generation: number
  target: unknown
  costume: unknown
  structure: number
}
