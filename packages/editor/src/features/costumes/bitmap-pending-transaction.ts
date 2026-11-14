import { isBitmapSourceSizeRefused } from './bitmap-artboard'
import type { PendingBitmapShape } from './bitmap-pending-shape'

/**
 * Async pending-shape commit coordinator (bitmap `rect` / `oval`).
 *
 * Isolated helper only: no product `Editor.svelte` / `BitmapEditor.svelte`
 * wiring, no VM/store access, no timers, no retries, no recursion. The Editor
 * will supply the live scope snapshot and a separate lower-level save
 * function; this coordinator only guarantees the transaction discipline
 * described in `bitmap-pending-transaction-design.md`.
 *
 * Safe writer contract (mandatory for new code, trusted VM interface):
 *
 * - The caller-provided `write` MUST perform an atomic compare-and-swap at
 *   mutation time: it captures `projectGeneration`, the live
 *   target/costume object references / structure epoch, and the slot
 *   identity (`assetId` / `md5ext` / `writeSeq`, plus the selection revision
 *   when relevant) synchronously at commit entry (via `control.expected` /
 *   `control.capture` below), awaits any `storeAsset` work, then re-validates
 *   everything atomically immediately before the mutation and applies only on
 *   a full match. In the real product this is `vm.updateCostumeIfMatch`
 *   (stable-id-only route) with a versioned `expected` plus the per-flight
 *   abort token forwarded as the VM 7th arg; the VM re-validates generation,
 *   structure, selection, hash, and version both before the `storeAsset`
 *   await and after it, so an external write / rename / reload / abort inside
 *   the await window prevents the stale bytes from landing instead of merely
 *   being reported afterwards. The ordinary public write path
 *   (`vm.updateCostume`, and `updateCostumeIfMatch` without the abort token)
 *   is unchanged and stays compatible.
 * - The writer MUST be cancellation aware: it receives `control.isAborted()`
 *   / `control.throwIfAborted()` / `control.abort` and MUST check it after
 *   every await and forward it to the VM CAS. An `abortInFlight` (or a newer
 *   stage / project replacement) therefore prevents the write itself for a
 *   trusted writer. The helper additionally refuses the outcome as `aborted`
 *   / `superseded` without restoring, but it cannot stop an untrusted writer
 *   that ignores the token and mutates anyway — that boundary is documented
 *   here and the writer is trusted to use the VM CAS route.
 * - The writer MUST invoke `control.shouldCommit()` synchronously at the
 *   actual commit point (after any `storeAsset` await, immediately before the
 *   atomic mutation), never before the await. The callback checks the
 *   helper-local abort flag plus the single-slot supersede state
 *   synchronously; the VM-side generation / structure / version checks are
 *   the atomic guard on the store side. The helper cannot enforce a
 *   malicious writer that calls the guard early or never calls it; trusted
 *   writers (the real VM CAS path) satisfy this by construction.
 * - The writer MUST return an explicit result object (never `void` /
 *   `undefined` / a bare `Promise<void>`):
 *   `{ ok: true, applied: true, newIdentity }` on a landed write,
 *   `{ ok: true, applied: false, ... }` when the CAS kept the external write,
 *   `{ ok: false, reason }` on a refusal. `newIdentity` is the post-mutation
 *   slot identity returned by the CAS (`result.current`) and is verified
 *   against `options.getLiveIdentity()` (which must read
 *   `vm.getCostumeIdentity()` for the same slot). A missing `newIdentity`,
 *   a missing live capability on a claimed success, or any legacy
 *   `{ ok: true }` / `void` / `undefined` / non-record resolution is rejected
 *   as `commit-rejected` (fail-closed, retryable when still owned). There is
 *   no backward compatibility: this helper is newly created and unwired, so
 *   no caller may rely on the legacy bare-success shape.
 * - A claimed success returns `committed` only when the verified live
 *   identity still equals the writer's `newIdentity`: the helper never
 *   conflates the writer's post-identity with a later external write that
 *   lands between the mutation and the verification. On mismatch the live
 *   (external) write is preserved and the outcome is `external-conflict`
 *   (or `superseded` when the project generation moved or the writer says
 *   so). Own asset+seq updates therefore report `committed`; any mismatch
 *   preserves the external write; abort/replace prevents the write (trusted
 *   path) rather than reporting after the mutation.
 * - The helper's post-await verification can only refuse the outcome for an
 *   arbitrary writer: a writer that mutates the store directly before
 *   returning an invalid shape still leaves those bytes behind. The
 *   `committed` / `commit-rejected` distinction therefore certifies the
 *   trusted VM CAS path only (`vm.updateCostumeIfMatch` with the captured
 *   `expected` + per-flight abort token, `shouldCommit()` at the actual
 *   commit point). Tests for the exact safe contract use the real VM CAS;
 *   stub writers returning legacy shapes are rejected without a commit.
 *
 * Owner model (exact identity + session generation + live edit epoch):
 * - `targetId` / `costumeIndex` / `assetKey`: exact slot identity.
 * - `loadSerial`: workspace load serial (canvas reloads bump it).
 * - `sessionGeneration`: paint-session generation (scope switches bump it).
 * - `editEpoch`: live edit epoch / preview revision the pending was rendered
 *   from (any restyle-independent external write moves it). New code should
 *   also populate `assetId` / `writeSeq` / `selectionEpoch` / `structureSeq`
 *   (all optional for compatibility) so the CAS `expected` carries the full
 *   version; when absent the helper falls back to `assetKey` / `editEpoch`.
 * - `projectGeneration`: whole-project generation (`loadProject` / `clear`
 *   bumps it; an old success after a bump must not touch the new pending).
 *
 * All comparisons are exact: any field mismatch fails closed.
 */

export type PendingCommitScope = {
  targetId: string
  costumeIndex: number
  assetKey: string
  loadSerial: number
  sessionGeneration: number
  editEpoch: number
  projectGeneration: number
  /** Full CAS identity (optional for compatibility; prefer over assetKey/editEpoch when present). */
  assetId?: string | null
  /** Monotonic per-slot version (optional; falls back to editEpoch when absent). */
  writeSeq?: number | null
  /** VM selection epoch at stage time (optional; checked by the writer's VM selection guard). */
  selectionEpoch?: number | null
  /** Per-target structure sequence at stage time (optional; checked via VM capture). */
  structureSeq?: number | null
}

/** Raw raster base supplied by the caller (copied on stage, never mutated). */
export type PendingCommitBaseInput = {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/** Defensive in-coordinator copy of the base raster. */
export type PendingCommitBase = {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type PendingCommitTaken = {
  shape: PendingBitmapShape
  base: PendingCommitBase
  scope: PendingCommitScope
}

/** Versioned slot identity for the CAS contract (mirrors `vm.getCostumeIdentity`). */
export type PendingCommitSlotIdentity = {
  assetId?: string | null
  md5ext?: string | null
  writeSeq?: number | null
}

/** Explicit CAS success: the write landed; `newIdentity` is the CAS `current`. */
export type PendingCommitWriteApplied = {
  ok: true
  applied: true
  newIdentity: PendingCommitSlotIdentity
}

/** Explicit CAS conflict: the live (external) write was kept, nothing landed. */
export type PendingCommitWriteConflicted = {
  ok: true
  applied: false
  reason?: string
  current?: PendingCommitSlotIdentity
}

/** Explicit refusal: nothing landed, the pending may be retained for retry. */
export type PendingCommitWriteFailed = { ok: false; reason: string }

/**
 * Lower-level save result. Callers MUST return one of the three explicit
 * shapes. Any other resolution — `void` / `undefined` / non-record, a
 * missing or non-boolean `applied` on `{ ok: true }` (including legacy
 * `{ ok: true }`), or a missing `newIdentity` on `applied: true` — is
 * rejected as `commit-rejected` at runtime (fail-closed).
 */
export type PendingCommitWriteResult =
  | PendingCommitWriteApplied
  | PendingCommitWriteConflicted
  | PendingCommitWriteFailed

/** Mutable per-flight abort flag owned by the coordinator, shared with the writer. */
export type PendingCommitAbortToken = {
  aborted: boolean
  reason: string
}

/**
 * Control handed to the writer. `expected` / `capture` are the synchronously
 * captured CAS inputs; `abort` / `isAborted` / `throwIfAborted` are the
 * cancellation channel (forward `abort` to `vm.updateCostumeIfMatch` as the
 * 7th arg); `shouldCommit` is the synchronous guard the trusted writer MUST
 * invoke at the actual commit point (after any `storeAsset` await,
 * immediately before the atomic mutation).
 */
export type PendingCommitControl = {
  expected: PendingCommitSlotIdentity
  capture: {
    projectGeneration: number
    selectionEpoch?: number | null
    structureSeq?: number | null
  }
  abort: PendingCommitAbortToken
  isAborted: () => boolean
  throwIfAborted: () => void
  shouldCommit: () => boolean
}

/**
 * Lower-level save invoked exactly once per commit. Separate from any
 * product-level save entry point so the commit can never recurse into
 * itself. A throw / rejection is treated as `commit-rejected`.
 * The received `base` and `shape` are private copies: mutating them cannot
 * corrupt the retained pending.
 */
export type PendingCommitWrite = (
  taken: PendingCommitTaken,
  control: PendingCommitControl,
) => Promise<PendingCommitWriteResult | void> | PendingCommitWriteResult | void

export type PendingCommitRefusal =
  | 'empty'
  | 'commit-in-flight'
  | 'owner-mismatch'
  | 'external-conflict'
  | 'commit-failed'
  | 'commit-rejected'
  | 'superseded'
  | 'aborted'
  | 'refused-size'
  | 'invalid-base'
  | 'invalid-shape'
  | 'invalid-scope'
  | 'history-gap'

export type PendingCommitResult =
  | { ok: true; kind: 'committed' }
  | { ok: true; kind: 'nothing-to-commit' }
  | { ok: true; kind: 'discarded' }
  | { ok: false; kind: 'refused'; reason: PendingCommitRefusal; detail?: string }

export type PendingStageResult =
  | { ok: true; kind: 'staged' }
  | { ok: false; kind: 'refused'; reason: PendingCommitRefusal; detail?: string }

export type PendingAbortResult = { ok: true; kind: 'aborted' } | { ok: true; kind: 'nothing-in-flight' }

export type PendingCommitOptions = {
  /** Fresh live scope snapshot re-read after every `await` (post-await revalidation). */
  readLive?: () => PendingCommitScope
  /**
   * Fresh live slot identity re-read synchronously after the writer resolves
   * (must read `vm.getCostumeIdentity()` for the same slot). Mandatory for
   * verifying an explicit CAS success; a claimed `applied: true` without
   * this capability is rejected as `commit-rejected`.
   */
  getLiveIdentity?: () => PendingCommitSlotIdentity | undefined
}

function abortedError(reason: string): Error {
  return new Error(reason)
}

function refused(reason: PendingCommitRefusal, detail?: string): { ok: false; kind: 'refused'; reason: PendingCommitRefusal; detail?: string } {
  return detail === undefined ? { ok: false, kind: 'refused', reason } : { ok: false, kind: 'refused', reason, detail }
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message
  return 'unknown error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isOptionalCounter(value: unknown): boolean {
  return value === undefined || value === null || isCounter(value)
}

function isOptionalId(value: unknown): boolean {
  return value === undefined || value === null || isNonEmptyString(value)
}

/** Nonthrow scope guard: malformed owners fail with a status, never a throw. */
export function isValidPendingScope(value: unknown): value is PendingCommitScope {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.targetId)) return false
  if (!isNonEmptyString(value.assetKey)) return false
  if (!isCounter(value.costumeIndex)) return false
  if (!isCounter(value.loadSerial)) return false
  if (!isCounter(value.sessionGeneration)) return false
  if (!isCounter(value.editEpoch)) return false
  if (!isCounter(value.projectGeneration)) return false
  if (!isOptionalId(value.assetId)) return false
  if (!isOptionalCounter(value.writeSeq) && (value as Record<string, unknown>).writeSeq !== undefined && (value as Record<string, unknown>).writeSeq !== null) {
    const seq = (value as Record<string, unknown>).writeSeq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return false
  }
  if (!isOptionalCounter(value.selectionEpoch) && (value as Record<string, unknown>).selectionEpoch !== undefined && (value as Record<string, unknown>).selectionEpoch !== null) {
    const epoch = (value as Record<string, unknown>).selectionEpoch
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) return false
  }
  if (!isOptionalCounter(value.structureSeq) && (value as Record<string, unknown>).structureSeq !== undefined && (value as Record<string, unknown>).structureSeq !== null) {
    const seq = (value as Record<string, unknown>).structureSeq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return false
  }
  return true
}

/** Nonthrow slot-identity guard for writer results and live reads. */
export function isValidSlotIdentity(value: unknown): value is PendingCommitSlotIdentity {
  if (!isRecord(value)) return false
  if (value.assetId !== undefined && value.assetId !== null && typeof value.assetId !== 'string') return false
  if (value.md5ext !== undefined && value.md5ext !== null && typeof value.md5ext !== 'string') return false
  const seq = (value as { writeSeq?: unknown }).writeSeq
  if (seq !== undefined && seq !== null && (typeof seq !== 'number' || !Number.isInteger(seq) || (seq as number) < 0)) return false
  return true
}

/** Exact owner comparison: session generation, edit epoch, and project included. */
export function isPendingScopeCurrent(scope: PendingCommitScope, live: PendingCommitScope): boolean {
  return (
    live.targetId === scope.targetId &&
    live.costumeIndex === scope.costumeIndex &&
    live.assetKey === scope.assetKey &&
    live.loadSerial === scope.loadSerial &&
    live.sessionGeneration === scope.sessionGeneration &&
    live.editEpoch === scope.editEpoch &&
    live.projectGeneration === scope.projectGeneration
  )
}

/** Strict slot-identity equality (asset + version, no alias, no coercion). */
export function isSameSlotIdentity(a: PendingCommitSlotIdentity | undefined | null, b: PendingCommitSlotIdentity | undefined | null): boolean {
  if (!a || !b) return false
  return (
    (a.assetId ?? undefined) === (b.assetId ?? undefined) &&
    (a.md5ext ?? undefined) === (b.md5ext ?? undefined) &&
    (a.writeSeq ?? undefined) === (b.writeSeq ?? undefined)
  )
}

function expectedOfScope(scope: PendingCommitScope): PendingCommitSlotIdentity {
  const writeSeq = typeof scope.writeSeq === 'number' ? scope.writeSeq : scope.editEpoch
  const assetId = typeof scope.assetId === 'string' ? scope.assetId : undefined
  return { assetId: assetId ?? null, md5ext: scope.assetKey, writeSeq }
}

function copyScope(scope: PendingCommitScope): PendingCommitScope {
  return { ...scope }
}

function copyShape(shape: PendingBitmapShape): PendingBitmapShape {
  // Field-wise defensive copy (all fields are primitives / plain box+style
  // records). Malformed records (missing box/style) are stored as-is without
  // throwing: callers (e.g. the pending session) validate via the preview
  // resolver before staging, and `stage` itself never throws.
  const box = (shape as { box?: unknown }).box
  const style = (shape as { style?: unknown }).style
  if (typeof box !== 'object' || box === null || typeof style !== 'object' || style === null) {
    return shape
  }
  return {
    ...shape,
    box: { ...(box as PendingBitmapShape['box']) },
    style: { ...(style as PendingBitmapShape['style']) },
  }
}

function copyBase(base: PendingCommitBase): PendingCommitBase {
  return { width: base.width, height: base.height, data: base.data.slice() }
}

function toStoredBase(input: PendingCommitBaseInput): PendingCommitBase | undefined {
  if (!isRecord(input)) return undefined
  const { width, height, data } = input as { width: unknown; height: unknown; data: unknown }
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined
  if (!(data instanceof Uint8ClampedArray) && !(data instanceof Uint8Array)) return undefined
  if ((data as Uint8Array).length < width * height * 4) return undefined
  // Canvas-size bound (known `bitmap-artboard` gate, no new API): refuse
  // before any state changes so oversized rasters never allocate here.
  if (isBitmapSourceSizeRefused(width, height)) return undefined
  const copy = new Uint8ClampedArray(data as Uint8Array)
  return { width, height, data: copy }
}

/**
 * Create an isolated pending-shape transaction coordinator.
 *
 * State holds plain data only (pending slot + in-flight identity); the
 * in-flight outcome promise is shared with joiners but never stored
 * unsafely: it is created settled-safe (never rejects) and cleared before
 * it resolves, so no floating unhandled rejection can escape.
 */
export function createPendingBitmapTransaction() {
  type Entry = { shape: PendingBitmapShape; base: PendingCommitBase; scope: PendingCommitScope; seq: number }
  type Flight = {
    scope: PendingCommitScope
    opId: number
    seqAtTake: number
    aborted: boolean
    abortReason: string
    abortToken: PendingCommitAbortToken
    outcome: Promise<PendingCommitResult>
    resolve: (result: PendingCommitResult) => void
  }

  let pending: Entry | undefined
  let flight: Flight | undefined
  let stageSeq = 0
  let opSeq = 0

  function snapshot(): PendingTransactionSnapshot {
    return {
      hasPending: pending !== undefined,
      commitInFlight: flight !== undefined,
      pendingScope: pending === undefined ? undefined : copyScope(pending.scope),
      inFlightScope: flight === undefined ? undefined : copyScope(flight.scope),
      stagedCount: stageSeq,
      commitCount: opSeq,
    }
  }

  function stage(shape: unknown, base: unknown, scope: unknown): PendingStageResult {
    if (!isRecord(shape)) return refused('invalid-shape')
    if (!isValidPendingScope(scope)) return refused('invalid-scope')
    const stored = isRecord(base) ? toStoredBase(base as PendingCommitBaseInput) : undefined
    if (stored === undefined) {
      if (
        isRecord(base) &&
        typeof (base as { width: unknown }).width === 'number' &&
        typeof (base as { height: unknown }).height === 'number' &&
        isBitmapSourceSizeRefused(
          (base as { width: number }).width,
          (base as { height: number }).height,
        )
      ) {
        return refused('refused-size')
      }
      return refused('invalid-base')
    }
    stageSeq += 1
    // Single slot (bounded memory): the newest stage wins. A newer stage
    // bumps the sequence so an older in-flight commit can never restore
    // over it or report its success against it.
    // Defensive shape copy: the caller retains its object (and the writer
    // receives the taken reference), so storing the caller's reference would
    // let a later caller/writer mutation corrupt the retained pending that a
    // failed commit restores. The base is already copied by `toStoredBase`;
    // the scope by `copyScope`; the shape is copied field-wise here (all
    // fields are primitives / plain box+style records).
    pending = { shape: copyShape(shape as PendingBitmapShape), base: stored, scope: copyScope(scope), seq: stageSeq }
    return { ok: true, kind: 'staged' }
  }

  /** Shared commit-first join used by save / export / switch alike (never recursive). */
  function joinCommit(
    live: unknown,
    write: PendingCommitWrite,
    options: PendingCommitOptions = {},
  ): Promise<PendingCommitResult> {
    try {
      const active = flight
      if (active !== undefined) {
        // Transaction join: the same owner waits for the running commit
        // instead of starting a second write. A different slot receives an
        // immediate explicit refuse (never waits, never steals or observes
        // another slot's commit); its own pending stays intact for a retry
        // after the flight settles.
        if (isValidPendingScope(live) && isPendingScopeCurrent(active.scope, live)) return active.outcome
        return Promise.resolve(refused('commit-in-flight'))
      }
      const entry = pending
      if (entry === undefined) return Promise.resolve({ ok: true, kind: 'nothing-to-commit' })
      if (!isValidPendingScope(live)) return Promise.resolve(refused('invalid-scope'))
      if (typeof write !== 'function') return Promise.resolve(refused('commit-rejected', 'missing commit writer'))
      if (!isPendingScopeCurrent(entry.scope, live)) {
        const reason: PendingCommitRefusal =
          live.projectGeneration !== entry.scope.projectGeneration ? 'superseded' : 'owner-mismatch'
        // Fail closed before any write: drop the orphaned pending without
        // touching pixels (the live canvas already belongs elsewhere).
        pending = undefined
        return Promise.resolve(refused(reason))
      }
      // Single-shot take: the slot is cleared synchronously BEFORE the first
      // await, so a racing duplicate commit sees an empty slot.
      pending = undefined
      opSeq += 1
      const opId = opSeq
      let resolveOutcome!: (result: PendingCommitResult) => void
      const outcome = new Promise<PendingCommitResult>((resolve) => {
        resolveOutcome = resolve
      })
      const abortToken: PendingCommitAbortToken = { aborted: false, reason: 'aborted' }
      flight = {
        scope: copyScope(entry.scope),
        opId,
        seqAtTake: entry.seq,
        aborted: false,
        abortReason: 'aborted',
        abortToken,
        outcome,
        resolve: resolveOutcome,
      }
      // The async body never throws: every path resolves the shared outcome.
      void runCommit(entry, opId, live, write, options.readLive, options.getLiveIdentity).then(
        (result) => settleFlight(opId, result),
        (error) => settleFlight(opId, refused('commit-rejected', messageOf(error))),
      )
      return outcome
    } catch (error) {
      return Promise.resolve(refused('commit-rejected', messageOf(error)))
    }
  }

  function settleFlight(opId: number, result: PendingCommitResult): void {
    const active = flight
    if (active === undefined || active.opId !== opId) return
    flight = undefined
    active.resolve(result)
  }

  async function runCommit(
    taken: Entry,
    opId: number,
    liveAtTake: PendingCommitScope,
    write: PendingCommitWrite,
    readLive: (() => PendingCommitScope) | undefined,
    getLiveIdentity: (() => PendingCommitSlotIdentity | undefined) | undefined,
  ): Promise<PendingCommitResult> {
    const active = flight
    if (active === undefined || active.opId !== opId) {
      return refused('superseded')
    }
    const expected = expectedOfScope(taken.scope)
    const capture = {
      projectGeneration: taken.scope.projectGeneration,
      selectionEpoch: taken.scope.selectionEpoch ?? null,
      structureSeq: taken.scope.structureSeq ?? null,
    }
    const control: PendingCommitControl = {
      expected: { ...expected },
      capture: { ...capture },
      abort: active.abortToken,
      isAborted: () => active.aborted,
      throwIfAborted: () => {
        if (active.aborted) throw abortedError(active.abortReason)
      },
      // Trusted guard: the writer MUST call this synchronously at the actual
      // commit point (after any `storeAsset` await, immediately before the
      // atomic mutation). It reports the helper-local abort + supersede
      // state; the store-side atomic guard is the VM CAS re-validation.
      shouldCommit: () => {
        const current = flight
        if (current === undefined || current.opId !== opId) return false
        if (current.aborted) return false
        if (pending !== undefined || stageSeq !== taken.seq) return false
        return true
      },
    }

    let raw: unknown
    try {
      // The writer gets private base AND shape copies: even a mutating
      // writer cannot corrupt the values retained for a fail-closed restore
      // (the restore below reuses the pristine `taken` references).
      raw = await write(
        {
          shape: copyShape(taken.shape),
          base: copyBase(taken.base),
          scope: copyScope(taken.scope),
        },
        control,
      )
    } catch (error) {
      if (active.aborted) return refused('aborted', active.abortReason)
      if (pending !== undefined || stageSeq !== taken.seq) return refused('superseded')
      // Rejected save restores the SAME pending only while still owned with
      // no newer stage; otherwise touch nothing.
      const fresh = readLiveScope(readLive, liveAtTake)
      if (fresh !== undefined && isValidPendingScope(fresh) && isPendingScopeCurrent(taken.scope, fresh)) {
        pending = { shape: taken.shape, base: taken.base, scope: taken.scope, seq: taken.seq }
      }
      if (error instanceof Error && error.message === active.abortReason && active.aborted) {
        return refused('aborted', active.abortReason)
      }
      return refused('commit-rejected', messageOf(error))
    }

    const latest = flight
    if (latest === undefined || latest.opId !== opId) {
      // Superseded while awaiting (should not happen: only this op settles
      // its own flight, but never let a late path restore or resolve twice).
      return refused('superseded')
    }
    if (latest.aborted) return refused('aborted', latest.abortReason)

    // A newer stage (retry racing a newer operation, or a fresh pending for
    // a replaced project) wins: never restore over it, never report the old
    // success against it.
    if (pending !== undefined || stageSeq !== taken.seq) return refused('superseded')

    // Explicit void / non-record / malformed resolutions are rejected
    // (fail-closed). No legacy `{ ok: true }` fallback exists.
    if (!isRecord(raw)) {
      const fresh = readLiveScope(readLive, liveAtTake)
      if (fresh !== undefined && isValidPendingScope(fresh) && isPendingScopeCurrent(taken.scope, fresh)) {
        pending = { shape: taken.shape, base: taken.base, scope: taken.scope, seq: taken.seq }
      }
      return refused('commit-rejected', 'writer must return an explicit result')
    }
    const record = raw as Record<string, unknown>

    if (typeof record.ok !== 'boolean') {
      const fresh = readLiveScope(readLive, liveAtTake)
      if (fresh !== undefined && isValidPendingScope(fresh) && isPendingScopeCurrent(taken.scope, fresh)) {
        pending = { shape: taken.shape, base: taken.base, scope: taken.scope, seq: taken.seq }
      }
      return refused('commit-rejected', 'writer must return an explicit result')
    }

    if (record.ok === false) {
      const writerReason = typeof record.reason === 'string' && record.reason.length > 0 ? (record.reason as string) : 'commit refused'
      // Failed save restores the SAME pending only while still owned
      // (no newer stage checked above, scope still current below).
      const fresh = readLiveScope(readLive, liveAtTake)
      if (fresh !== undefined && isValidPendingScope(fresh) && isPendingScopeCurrent(taken.scope, fresh)) {
        pending = { shape: taken.shape, base: taken.base, scope: taken.scope, seq: taken.seq }
        return refused('commit-failed', writerReason)
      }
      if (fresh !== undefined && isValidPendingScope(fresh) && fresh.projectGeneration !== taken.scope.projectGeneration) {
        return refused('superseded')
      }
      return refused('external-conflict')
    }

    // record.ok === true from here. The atomic-CAS mandate requires an
    // explicit `applied` boolean on every success; legacy `{ ok: true }`
    // without it is rejected fail-closed (no scope-check fallback, no
    // commit). An arbitrary writer may already have mutated the store
    // before returning such a shape — the helper can only refuse the
    // outcome, never undo that mutation. The exact safe contract is the
    // trusted VM CAS path (`updateCostumeIfMatch` + `getLiveIdentity`).
    if (!('applied' in record) || (record.applied !== true && record.applied !== false)) {
      const fresh = readLiveScope(readLive, liveAtTake)
      if (fresh !== undefined && isValidPendingScope(fresh) && isPendingScopeCurrent(taken.scope, fresh)) {
        pending = { shape: taken.shape, base: taken.base, scope: taken.scope, seq: taken.seq }
      }
      return refused('commit-rejected', 'writer must return an explicit applied result')
    }

    if (record.applied === false) {
      // Explicit CAS conflict: the live (external) write was kept, nothing
      // landed. Never restore, never touch pixels.
      const reasonValue = typeof record.reason === 'string' ? record.reason : ''
      if (reasonValue === 'superseded') return refused('superseded')
      // A generation move reported as conflict still maps to superseded when
      // the live scope proves the project changed.
      const fresh = readLiveScopeQuiet(readLive)
      if (fresh !== undefined && isValidPendingScope(fresh) && fresh.projectGeneration !== taken.scope.projectGeneration) {
        return refused('superseded')
      }
      return refused('external-conflict')
    }

    if (record.applied === true) {
      const newIdentity = (record as { newIdentity?: unknown }).newIdentity
      if (!isValidSlotIdentity(newIdentity)) {
        const fresh = readLiveScope(readLive, liveAtTake)
        if (fresh !== undefined && isValidPendingScope(fresh) && isPendingScopeCurrent(taken.scope, fresh)) {
          pending = { shape: taken.shape, base: taken.base, scope: taken.scope, seq: taken.seq }
        }
        return refused('commit-rejected', 'writer applied without a verifiable new identity')
      }
      if (typeof getLiveIdentity !== 'function') {
        const fresh = readLiveScope(readLive, liveAtTake)
        if (fresh !== undefined && isValidPendingScope(fresh) && isPendingScopeCurrent(taken.scope, fresh)) {
          pending = { shape: taken.shape, base: taken.base, scope: taken.scope, seq: taken.seq }
        }
        return refused('commit-rejected', 'missing live identity capability')
      }
      let liveIdentity: PendingCommitSlotIdentity | undefined
      try {
        liveIdentity = getLiveIdentity()
      } catch {
        return refused('commit-rejected', 'live identity read failed')
      }
      if (!isValidSlotIdentity(liveIdentity)) {
        // Slot is gone (or backend has no identity): the project/target was
        // replaced under the write; preserve the new side.
        return refused('superseded')
      }
      // Never conflate the writer post-identity with a later external write:
      // the verified live identity must still equal the writer's own update.
      if (!isSameSlotIdentity(newIdentity, liveIdentity)) {
        const fresh = readLiveScopeQuiet(readLive)
        if (fresh !== undefined && isValidPendingScope(fresh) && fresh.projectGeneration !== taken.scope.projectGeneration) {
          return refused('superseded')
        }
        return refused('external-conflict')
      }
      return { ok: true, kind: 'committed' }
    }

    const fresh = readLiveScope(readLive, liveAtTake)
    if (fresh !== undefined && isValidPendingScope(fresh) && isPendingScopeCurrent(taken.scope, fresh)) {
      pending = { shape: taken.shape, base: taken.base, scope: taken.scope, seq: taken.seq }
    }
    return refused('commit-rejected', 'writer must return an explicit result')
  }

  function readLiveScope(
    readLive: (() => PendingCommitScope) | undefined,
    fallback: PendingCommitScope,
  ): PendingCommitScope | undefined {
    if (typeof readLive === 'function') {
      try {
        return readLive()
      } catch {
        return undefined
      }
    }
    return fallback
  }

  function readLiveScopeQuiet(readLive: (() => PendingCommitScope) | undefined): PendingCommitScope | undefined {
    if (typeof readLive !== 'function') return undefined
    try {
      return readLive()
    } catch {
      return undefined
    }
  }

  /** Save path commit-first: refuse the transition when the commit refuses. */
  function requestSavePending(
    live: unknown,
    write: PendingCommitWrite,
    options: PendingCommitOptions = {},
  ): Promise<PendingCommitResult> {
    return joinCommit(live, write, options)
  }

  /** Export path commit-first: the stored-bytes read proceeds only after the commit settles. */
  function requestExportPending(
    live: unknown,
    write: PendingCommitWrite,
    options: PendingCommitOptions = {},
  ): Promise<PendingCommitResult> {
    return joinCommit(live, write, options)
  }

  /** Switch path commit-first: a refused commit refuses the switch. */
  function requestSwitchPending(
    live: unknown,
    write: PendingCommitWrite,
    options: PendingCommitOptions = {},
  ): Promise<PendingCommitResult> {
    return joinCommit(live, write, options)
  }

  /** Undo / Delete path: discard the pending, never while a save is running. */
  function discardPending(live: unknown): PendingCommitResult {
    if (flight !== undefined) return refused('commit-in-flight')
    const entry = pending
    if (entry === undefined) return { ok: true, kind: 'nothing-to-commit' }
    if (!isValidPendingScope(live)) return refused('invalid-scope')
    if (!isPendingScopeCurrent(entry.scope, live)) {
      // External owner now: drop without pixels, touch nothing else.
      pending = undefined
      return refused('owner-mismatch')
    }
    pending = undefined
    return { ok: true, kind: 'discarded' }
  }

  /** Mark the running commit aborted (e.g. project replaced mid-save). Waiters settle on write completion. */
  function abortInFlight(reason = 'aborted'): PendingAbortResult {
    const active = flight
    if (active === undefined) return { ok: true, kind: 'nothing-in-flight' }
    active.aborted = true
    active.abortReason = reason
    active.abortToken.aborted = true
    active.abortToken.reason = reason
    return { ok: true, kind: 'aborted' }
  }

  return {
    stage,
    joinCommit,
    requestSavePending,
    requestExportPending,
    requestSwitchPending,
    discardPending,
    abortInFlight,
    snapshot,
  }
}

export type PendingBitmapTransaction = ReturnType<typeof createPendingBitmapTransaction>

/** Plain-data snapshot for tests/debugging. Never contains a promise. */
export type PendingTransactionSnapshot = {
  hasPending: boolean
  commitInFlight: boolean
  pendingScope: PendingCommitScope | undefined
  inFlightScope: PendingCommitScope | undefined
  stagedCount: number
  commitCount: number
}
