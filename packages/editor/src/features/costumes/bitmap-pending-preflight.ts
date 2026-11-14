import type {
  PendingBitmapTransaction,
  PendingCommitOptions,
  PendingCommitRefusal,
  PendingCommitResult,
  PendingCommitWrite,
} from './bitmap-pending-transaction'

/**
 * Central transition preflight gate for the future pending bitmap shape.
 *
 * Infrastructure only: no `Editor.svelte` / `BitmapEditor.svelte` wiring, no
 * DOM/canvas access, no timers, no retries, no recursion. The Editor will map
 * each UI entry point to one `BitmapPendingUiCommand`, capture the live scope
 * synchronously at the event entry, and call `runBitmapPendingUiOp` INSTEAD of
 * touching `vm.setCurrentCostume` / `vm.selectTarget` / `vm.loadProject` /
 * `exportProject` / `saveProjectSb3` / `vm.updateCostume` directly. The gate
 * awaits the shared pending-shape commit first and runs the UI continuation
 * at most once, only on an owned success.
 *
 * Why this file exists (and is not redundant): `bitmap-pending-shape.ts`
 * classifies low-level pending triggers (`blank-press`, `tool-switch`, ...)
 * and `bitmap-pending-transaction.ts` owns the single-slot commit discipline
 * (`stage` / `joinCommit` / `discardPending` / `abortInFlight`), while
 * `bitmap-pending-vm-writer.ts` adapts the coordinator to the real
 * `ScratchVM` CAS route. None of them knows the product UI commands
 * (`saveBitmapCostume`, `exportSb3`, `selectCostume`, `convertCurrentCostume*`,
 * paint ops, ...). This adapter is the single reusable bridge from those
 * UI-originated requests to the tested coordinator: a pure command
 * classifier plus one async gate that enforces commit-first with an explicit
 * lower-level writer and an explicit UI continuation. There is no other
 * helper covering UI command -> gate policy -> op callback gating.
 *
 * Recursion boundary: the `write` passed to the gate MUST be a separate
 * lower-level save (the `createBitmapPendingVmWrite` CAS writer), never
 * `saveBitmapCostume` / `exportSb3` / the gate itself. The `runOp`
 * continuation is the deferred UI mutation (export bytes read,
 * `vm.setCurrentCostume`, `vm.selectTarget`, convert, paint op, ...). The
 * gate never calls product save paths and never calls itself.
 *
 * Failure discipline (fail-closed, no resume): exactly one `joinCommit`
 * attempt per gate call, no retry loop. On any refusal the continuation is
 * NOT executed (no ghost `exportProject` / `vm.setCurrentCostume` call) and
 * the coordinator retains or drops the pending per its own rule; the caller
 * retries with a fresh explicit gate call after re-staging.
 */

export type BitmapPendingUiCommand =
  | 'save-bitmap'
  | 'export-project'
  | 'export-sb3'
  | 'export-costume'
  | 'select-costume'
  | 'select-target'
  | 'new-project'
  | 'load-project'
  | 'project-switch'
  | 'convert-to-bitmap'
  | 'convert-to-vector'
  | 'duplicate-costume'
  | 'delete-costume'
  | 'reorder-costume'
  | 'delete-target'
  | 'restore-costume'
  | 'paint-cut'
  | 'paint-copy'
  | 'paint-paste'
  | 'paint-crop'
  | 'paint-flip'
  | 'paint-rotate'
  | 'paint-clear'
  | 'paint-floating'
  | 'paint-redo'
  | 'paint-escape-commit'
  | 'paint-tool-switch'
  | 'paint-blank-press'
  | 'paint-delete-selection'
  | 'paint-undo'
  | 'restyle'
  | 'transform'
  | 'pointercancel-draft'
  | 'blur-keep'

export type BitmapPendingGatePolicy = 'commit-first' | 'discard-first' | 'leave-pending'

/**
 * Pure reusable UI command classifier (no VM, no state, no side effects).
 *
 * - `commit-first`: destructive / structural / exporting transitions must
 *   await the shared commit and refuse the UI op on failure. Covers every
 *   UI-originated save / export / switch / convert / paint op request:
 *   `saveBitmapCostume`, `exportProject` / `exportSb3` / `exportCostume`,
 *   `selectCostume` (`vm.setCurrentCostume`), target-select
 *   (`vm.selectTarget`), `resetProjectUiState` / `newProject` / `loadProject`
 *   (`vm.loadProject`), `convertCurrentCostumeToBitmap/ToVector`,
 *   `duplicate/delete/reorderCostume`, target delete, paint
 *   cut/copy/paste/crop/flip/rotate/clear, floating sessions, redo,
 *   Escape-deselect, tool-switch, blank-press new-shape.
 * - `discard-first`: the pending shape is dropped (base restored when still
 *   owned) before the UI op: `deleteEditorSelection` /
 *   `deleteBitmapSelection`, `undoAssetEdit` (discard-then-undo).
 * - `leave-pending`: the pending slot is untouched and no commit runs:
 *   in-place restyle (color / fill / gradient / transparent / brushSize /
 *   filled<->outlined toggle), bounding-box move / scale, draft-only
 *   `cancelBitmapStroke` (`pointercancel` / `lostpointercapture`), page
 *   blur / unmount / popstate keep-pending.
 *
 * Unknown commands default to `commit-first` (fail-closed): a future UI op
 * the classifier does not know yet must not slip past an uncommitted shape.
 */
export function classifyBitmapPendingCommand(command: string): BitmapPendingGatePolicy {
  switch (command) {
    case 'paint-delete-selection':
    case 'paint-undo':
      return 'discard-first'
    case 'restyle':
    case 'transform':
    case 'pointercancel-draft':
    case 'blur-keep':
      return 'leave-pending'
    default:
      return 'commit-first'
  }
}

export type BitmapPendingContinuationCheck = () => boolean

/**
 * Control handed to the UI continuation. The gate has already revalidated
 * `isContinuationCurrent` synchronously in the same JS turn immediately
 * before invoking the op (no await boundary between guard and op); the op
 * MUST recheck `control.isContinuationCurrent()` synchronously after every
 * await before touching UI/VM state (`vm.setCurrentCostume` /
 * `vm.selectTarget` / export bytes read / paint ops). A `false` (or throw,
 * or non-`true`, or a returned Promise which is rejected as invalid) means
 * the captured UI scope is stale (external select, reload, reorder,
 * concurrent join) and the op must abort without side effects. The `abort`
 * flag starts un-aborted; the op may set it when it observes staleness.
 * `isAborted` / `throwIfAborted` reflect that flag synchronously for
 * convenience.
 */
export type BitmapPendingOpControl = {
  isContinuationCurrent: () => boolean
  isAborted: () => boolean
  throwIfAborted: () => void
  abort: { aborted: boolean; reason: string }
}

export type BitmapPendingUiOp<T> = (control: BitmapPendingOpControl) => Promise<T> | T

export type BitmapPendingPreflightOptions = PendingCommitOptions & {
  /**
   * Mandatory SYNCHRONOUS UI-scope continuation guard, captured synchronously
   * at the UI event entry and evaluated synchronously in the same JS turn
   * immediately before the op runs (no await boundary between guard and op),
   * on every path that would execute the op (commit-first success including
   * `nothing-to-commit`, discard-first success, leave-pending). Must compare
   * the exact captured UI scope: whole-project generation + monotonic
   * selection epoch + slot target reference (selected stable id + index).
   * It MUST NOT compare the per-slot `writeSeq`: the gate's own successful
   * commit bumps `writeSeq` by exactly one and must not read as stale. A
   * display-name rename bumps `writeSeq` only (never the selection epoch),
   * so it stays green unless the rename also moved the selection. The epoch
   * is monotonic, so an away-and-back (`A -> B -> A`) still reads stale via
   * the epoch even when the final `(targetId, index)` equality holds again;
   * a reload reusing the same stable id still reads stale via the
   * generation. The guard MUST be synchronous (`() => boolean`): a returned
   * Promise (thenable) is rejected as invalid and fails closed, because an
   * async guard cannot honestly assert it checked immediately before the op.
   * Missing / throwing / Promise-returning / non-`true` guards fail closed
   * (the op is refused, never run).
   */
  isContinuationCurrent?: BitmapPendingContinuationCheck
}

/** Captured UI continuation scope (project + monotonic selection + slot reference). */
export type BitmapPendingContinuationSnapshot = {
  projectGeneration: number
  selectionEpoch: number
  selectedTargetId: string
  selectedIndex: number
}

/** Minimal VM selection surface needed by the continuation guard factory. */
export type BitmapPendingContinuationVmLike = {
  getSelectionSnapshot?: () => unknown
  getProjectGeneration?: () => unknown
  getSelectionEpoch?: () => unknown
  getSelectedTargetStableId?: () => unknown
  getSelectedTarget?: () => unknown
}

function isCounterLike(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && (value as number) >= 0
}

function readContinuationSnapshot(vm: unknown): BitmapPendingContinuationSnapshot | undefined {
  try {
    const candidate = vm as BitmapPendingContinuationVmLike
    const snapFn = candidate?.getSelectionSnapshot
    if (typeof snapFn === 'function') {
      const raw = (snapFn as () => unknown).call(vm) as Record<string, unknown>
      const targetId = (raw as Record<string, unknown>)?.targetId
      const index = (raw as Record<string, unknown>)?.index
      const selectionEpoch = (raw as Record<string, unknown>)?.selectionEpoch
      const projectGeneration = (raw as Record<string, unknown>)?.projectGeneration
      if (
        typeof targetId === 'string' &&
        isCounterLike(index) &&
        isCounterLike(selectionEpoch) &&
        isCounterLike(projectGeneration)
      ) {
        return {
          projectGeneration: projectGeneration as number,
          selectionEpoch: selectionEpoch as number,
          selectedTargetId: targetId as string,
          selectedIndex: index as number,
        }
      }
      return undefined
    }
    const genFn = candidate?.getProjectGeneration
    const epochFn = candidate?.getSelectionEpoch
    const idFn = candidate?.getSelectedTargetStableId
    const selFn = candidate?.getSelectedTarget
    if (typeof genFn !== 'function' || typeof epochFn !== 'function') return undefined
    const projectGeneration = (genFn as () => unknown).call(vm)
    const selectionEpoch = (epochFn as () => unknown).call(vm)
    if (!isCounterLike(projectGeneration) || !isCounterLike(selectionEpoch)) return undefined
    let selectedTargetId = ''
    if (typeof idFn === 'function') {
      const id = (idFn as () => unknown).call(vm)
      if (typeof id === 'string') selectedTargetId = id
    } else if (typeof selFn === 'function') {
      const selected = (selFn as () => unknown).call(vm) as Record<string, unknown>
      const id = (selected as Record<string, unknown>)?.id
      if (typeof id === 'string') selectedTargetId = id
    }
    let selectedIndex = 0
    if (typeof selFn === 'function') {
      const selected = (selFn as () => unknown).call(vm) as Record<string, unknown>
      const current = (selected as Record<string, unknown>)?.currentCostume
      if (isCounterLike(current)) selectedIndex = current as number
    }
    return {
      projectGeneration: projectGeneration as number,
      selectionEpoch: selectionEpoch as number,
      selectedTargetId,
      selectedIndex,
    }
  } catch {
    return undefined
  }
}

/**
 * Capture the exact UI continuation scope synchronously and return a guard
 * that re-reads live state on every invocation. Compares only
 * `projectGeneration` + `selectionEpoch` + selected stable id + selected
 * index (exact, no alias, no coercion). Never compares `writeSeq`, so the
 * gate's own successful commit (one `writeSeq` bump on the same slot) and an
 * unrelated display-name rename (same bytes, bumped version, epoch-neutral)
 * both stay green. Away-and-back still reads stale via the monotonic epoch;
 * same-id reload still reads stale via the generation. Fail-closed: an
 * uncapturable scope yields a guard that always returns `false`.
 */
export function createBitmapPendingContinuationGuard(vm: unknown): BitmapPendingContinuationCheck {
  const captured = readContinuationSnapshot(vm)
  if (!captured) return () => false
  const want = { ...captured }
  return () => {
    try {
      const live = readContinuationSnapshot(vm)
      if (!live) return false
      return (
        live.projectGeneration === want.projectGeneration &&
        live.selectionEpoch === want.selectionEpoch &&
        live.selectedTargetId === want.selectedTargetId &&
        live.selectedIndex === want.selectedIndex
      )
    } catch {
      return false
    }
  }
}

export type BitmapPendingPreflightResult<T> =
  | { ok: true; kind: 'proceeded'; policy: BitmapPendingGatePolicy; commit: PendingCommitResult | undefined; opResult: T }
  | {
      ok: false
      kind: 'refused'
      policy: BitmapPendingGatePolicy
      reason: PendingCommitRefusal
      detail?: string
      commit: PendingCommitResult | undefined
    }

function refusedResult<T>(
  policy: BitmapPendingGatePolicy,
  reason: PendingCommitRefusal,
  commit: PendingCommitResult | undefined,
  detail?: string,
): BitmapPendingPreflightResult<T> {
  return detail === undefined
    ? { ok: false, kind: 'refused', policy, reason, commit }
    : { ok: false, kind: 'refused', policy, reason, detail, commit }
}

function commitRefusalOf(result: PendingCommitResult): { reason: PendingCommitRefusal; detail?: string } {
  if (result.ok) return { reason: 'commit-rejected', detail: 'expected a refusal' }
  return result.detail === undefined ? { reason: result.reason } : { reason: result.reason, detail: result.detail }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function checkContinuationCurrent(
  options: BitmapPendingPreflightOptions | undefined,
): { current: boolean; missing: boolean; threw: boolean } {
  const guard = (options as BitmapPendingPreflightOptions | undefined)?.isContinuationCurrent
  if (typeof guard !== 'function') return { current: false, missing: true, threw: false }
  try {
    const value = (guard as BitmapPendingContinuationCheck)()
    if (isThenable(value)) {
      // Async guard rejected as invalid: it cannot honestly assert it
      // checked immediately before the op. Swallow a later rejection so a
      // Promise-returning guard never surfaces as an unhandled rejection.
      try {
        ;(value as PromiseLike<unknown>).then(undefined, () => undefined)
      } catch {
        // ignore `then` accessor side effects
      }
      return { current: false, missing: false, threw: true }
    }
    return value === true ? { current: true, missing: false, threw: false } : { current: false, missing: false, threw: false }
  } catch {
    return { current: false, missing: false, threw: true }
  }
}

function buildOpControl(
  options: BitmapPendingPreflightOptions | undefined,
  abort: { aborted: boolean; reason: string },
): BitmapPendingOpControl {
  const guard = (options as BitmapPendingPreflightOptions | undefined)?.isContinuationCurrent
  const isContinuationCurrent = (): boolean => {
    if (typeof guard !== 'function') return false
    try {
      const value = (guard as BitmapPendingContinuationCheck)()
      if (isThenable(value)) {
        try {
          ;(value as PromiseLike<unknown>).then(undefined, () => undefined)
        } catch {
          // ignore
        }
        return false
      }
      return value === true
    } catch {
      return false
    }
  }
  return {
    isContinuationCurrent,
    isAborted: () => abort.aborted,
    throwIfAborted: () => {
      if (abort.aborted) throw new Error(abort.reason)
    },
    abort,
  }
}

/**
 * Run one UI-originated op through the pending-shape preflight gate.
 *
 * `commit-first`: awaits `tx.joinCommit(live, write, options)` exactly once
 * (joins a running flight for the same owner instead of starting a second
 * write; a different owner gets an immediate refuse). Only
 * `committed` / `nothing-to-commit` reaches the continuation guard; every
 * refusal returns without executing `runOp` (no ghost export / select call).
 * `joinCommit` remains awaited; the guard runs AFTER that await (including
 * the `nothing-to-commit` microtask) and synchronously in the same JS turn
 * as the `op` invocation with no await boundary between guard and op, so a
 * selection/project switch landing in the commit window refuses the stale
 * UI action instead of racing it.
 *
 * `discard-first`: fail-first guard BEFORE `tx.discardPending(live)` (an
 * invalid guard never drops the pending shape/bytes); refuses while a commit
 * is in flight (never discards under a running save); otherwise discards and
 * then rechecks the guard synchronously in the same turn as `runOp`. The
 * discard itself is sync, and the guard-to-op handoff has no await boundary,
 * but the op runs after and may await, so the guard plus the op abort token
 * cover both the pre-continuation point and the op's later awaits. The guard
 * is a pure synchronous predicate and MUST NOT mutate selection/VM state.
 *
 * `leave-pending`: checks the continuation guard synchronously in the same
 * turn as `runOp`, then executes `runOp` directly without touching `tx` /
 * `write` (in-place restyle / transform / draft-cancel / blur-keep). No
 * await sits between guard and op on this path either. The `runOp` itself
 * must still re-validate the pending owner before touching pixels; the gate
 * deliberately performs no commit here.
 *
 * Continuation guard (mandatory synchronous, fail-closed, fail-first):
 * `options.isContinuationCurrent` (`() => boolean`) is evaluated
 * synchronously BEFORE any transaction side effect on every policy, then
 * rechecked synchronously in the same JS turn immediately before `runOp`
 * after the side effect (after the `joinCommit` await on commit-first,
 * same-turn recheck after the sync discard on discard-first). Missing /
 * throwing / Promise-returning (async, rejected as invalid) / non-`true`
 * guards refuse without executing `runOp` and without touching `tx`/`write`
 * on the precheck (`commit: undefined`, pending retained, no CAS). A stale
 * (`false`) guard after a successful commit/discards reports `superseded`
 * with detail `stale continuation` and preserves the commit result in
 * `commit` (the bytes already landed; only the stale UI action is
 * suppressed). Missing/throwing/async guards report `commit-rejected`. The
 * guard compares only project generation + monotonic
 * selection epoch + selected stable id/index, so the gate's own `writeSeq`
 * bump and epoch-neutral renames stay green, while `A -> B -> A` still reads
 * stale via the epoch and same-id reloads via the generation.
 *
 * Op contract: `runOp` receives a `BitmapPendingOpControl` and MUST recheck
 * `control.isContinuationCurrent()` synchronously after every await before
 * touching UI/VM state, aborting without side effects when it returns
 * `false`. A long op must check itself: the gate cannot cover awaits inside
 * the op.
 *
 * Never throws for gate reasons (malformed `tx` / `live` / `write`, missing /
 * throwing / async guard yields a `refused` result without executing
 * `runOp`). A throwing `runOp` after a successful guard propagates to the
 * caller (the commit already landed).
 */
export async function runBitmapPendingUiOp<T>(
  tx: PendingBitmapTransaction | undefined | null,
  command: BitmapPendingUiCommand | string,
  live: unknown,
  write: PendingCommitWrite | undefined | null,
  runOp: BitmapPendingUiOp<T> | undefined | null,
  options: BitmapPendingPreflightOptions = {},
): Promise<BitmapPendingPreflightResult<T>> {
  const policy = classifyBitmapPendingCommand(command)
  if (typeof runOp !== 'function') {
    return refusedResult(policy, 'commit-rejected', undefined, 'missing op continuation')
  }
  const op = runOp as BitmapPendingUiOp<T>
  // Fail-first: synchronous continuation precheck BEFORE any transaction
  // side effect on every policy. The guard is a pure synchronous predicate
  // (`() => boolean`); it MUST NOT mutate UI/VM state itself (a guard that
  // moves the selection synchronously inside the predicate is hostile and
  // unsupported — use a pure callable or a post-read). With a pure guard the
  // precheck and the post-side-effect recheck below agree unless a real
  // selection/project switch landed in between (commit await window). A
  // failing precheck refuses with `commit: undefined`: no `discardPending`,
  // no `joinCommit`, no writer invocation, so the pending shape/bytes stay
  // retained for an explicit retry.
  const precheck = checkContinuationCurrent(options)
  if (!precheck.current) {
    if (precheck.missing) return refusedResult(policy, 'commit-rejected', undefined, 'missing continuation guard')
    if (precheck.threw) return refusedResult(policy, 'commit-rejected', undefined, 'continuation guard failed')
    return refusedResult(policy, 'superseded', undefined, 'stale continuation')
  }
  if (policy === 'leave-pending') {
    // No await between precheck and op: same JS turn. No tx touch.
    const abort = { aborted: false, reason: 'aborted' }
    const opResult = await op(buildOpControl(options, abort))
    return { ok: true, kind: 'proceeded', policy, commit: undefined, opResult }
  }
  if (tx === undefined || tx === null || typeof (tx as PendingBitmapTransaction).snapshot !== 'function') {
    return refusedResult(policy, 'commit-rejected', undefined, 'missing transaction')
  }
  if (policy === 'discard-first') {
    // Precheck above already passed, so `discardPending` runs only under a
    // valid continuation. The discard itself is sync; recheck synchronously
    // in the same turn before `runOp` (pure guard: same answer barring a
    // hostile mutating predicate, which is unsupported).
    let discarded: PendingCommitResult
    try {
      discarded = (tx as PendingBitmapTransaction).discardPending(live)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'discard failed'
      return refusedResult(policy, 'commit-rejected', undefined, detail)
    }
    if (!discarded.ok) {
      const { reason, detail } = commitRefusalOf(discarded)
      return refusedResult(policy, reason, discarded, detail)
    }
    // No await between discard and op: same JS turn.
    const checked = checkContinuationCurrent(options)
    if (!checked.current) {
      if (checked.missing) return refusedResult(policy, 'commit-rejected', discarded, 'missing continuation guard')
      if (checked.threw) return refusedResult(policy, 'commit-rejected', discarded, 'continuation guard failed')
      return refusedResult(policy, 'superseded', discarded, 'stale continuation')
    }
    const abort = { aborted: false, reason: 'aborted' }
    const opResult = await op(buildOpControl(options, abort))
    return { ok: true, kind: 'proceeded', policy, commit: discarded, opResult }
  }
  let commit: PendingCommitResult
  try {
    commit = await (tx as PendingBitmapTransaction).joinCommit(live, write as PendingCommitWrite, options)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'commit failed'
    return refusedResult(policy, 'commit-rejected', undefined, detail)
  }
  if (!commit.ok) {
    const { reason, detail } = commitRefusalOf(commit)
    return refusedResult(policy, reason, commit, detail)
  }
  // Recheck AFTER the joinCommit await, synchronously in the same JS
  // turn as the op invocation below (no await boundary between them). The
  // precheck above guarantees the writer never fired on a stale/missing
  // guard; this recheck suppresses a UI action whose scope moved during the
  // await (own `writeSeq` bump stays green — the guard never compares it).
  // On a stale post-commit the bytes already landed, so the refusal honestly
  // reports the `committed` result in `commit` while running no op.
  const checked = checkContinuationCurrent(options)
  if (!checked.current) {
    if (checked.missing) return refusedResult(policy, 'commit-rejected', commit, 'missing continuation guard')
    if (checked.threw) return refusedResult(policy, 'commit-rejected', commit, 'continuation guard failed')
    return refusedResult(policy, 'superseded', commit, 'stale continuation')
  }
  const abort = { aborted: false, reason: 'aborted' }
  const opResult = await op(buildOpControl(options, abort))
  return { ok: true, kind: 'proceeded', policy, commit, opResult }
}
