/**
 * Vector costume write gate (ordering + transaction barrier + gesture token
 * + structural atomicity).
 *
 * Race being closed (vector-drag-race-gate: point/rotate/leaf preview
 * `vm.updateCostume` awaits a VM write; an Escape/cancel/target-switch that
 * lands while the write is pending loses last-writer-wins when the stale
 * preview lands AFTER the restore, corrupting bytes with no Undo):
 *
 * - Per-costume serialized writes. Every vector costume write is enqueued on
 *   a per-slot FIFO chain (`vector-write:<targetId>:<index>`), so completion
 *   order always equals initiation order for the same asset, no matter how
 *   the underlying promises/exceptions resolve. A cancel restore enqueued
 *   after its gesture's previews therefore always lands AFTER them and is the
 *   final write of that gesture. A newer legitimate edit enqueued after the
 *   restore lands after the restore, so the restore can never erase it.
 * - Gesture tokens. Each drag mints one token object. Cancel flips its
 *   `cancelled` flag in place; previews hold the same object reference, so
 *   they observe the mark inside the queue and skip their VM write without
 *   touching history — whether they were queued before the cancel (still
 *   waiting behind a long in-flight write) or arrive late (async computation
 *   finishing after the cancel). A stale old-gesture frame can therefore
 *   never land on top of the restore, with no upper bound and no prune:
 *   there is no global cancelled set to overflow, and memory is bounded by
 *   live tokens only (GC reclaims them once drags/queue closures drop them).
 *   Restores (`barrier`) always run: they write only their own source bytes,
 *   never an unconditional whole snapshot, and FIFO keeps the latest
 *   legitimate edit last.
 * - ID scope separation. Slot keys use the stable target id
 *   (`target.id ?? target.name`), never the display name, so two targets with
 *   the same name (DupSprite) serialize on different slots and history guards
 *   stay per-asset. Rename-safe: renames keep the id, so the slot survives.
 *   Reorder/delete/restore handlers cancel active gestures (callers) so an old
 *   index never rewrites shifted artwork; outside-slot writes are untouched.
 * - Promise/exception safety. Tails swallow settlements internally so one
 *   rejection never breaks the chain; the caller's write rejection still
 *   propagates to that caller. Resize/move previews share the same queue as
 *   `edit` writes (no barrier needed: Escape keeps applied moves), and
 *   Undo/Redo costume restores enqueue as `edit` so they order after any
 *   in-flight cancel restore instead of racing it. Pointer-up commits exactly
 *   one history entry (callers), unchanged by this gate.
 *
 * Structural atomicity (diag-B: delayed slot0 preview vs Delete slot0).
 *
 * The per-slot FIFO alone cannot close the index-shift race: the test gate
 * wraps the whole `vm.updateCostume` (including its internal `storeAsset`
 * await) with a delay, so a preview whose VM call has STARTED (its slot-guard
 * already passed) still lands AFTER a synchronous `deleteCostume`/`reorder`
 * that ran during the delay. The delayed call re-resolves
 * `target.costumes[index]` at invocation time, so the old slot0 bytes
 * overwrite the shifted slot0 (old slot1). A check-before-await guard in the
 * drag preview is therefore insufficient: the check passes, the write starts,
 * the structure mutates the array, and the pending write lands on the wrong
 * artwork.
 *
 * Fix: structural costume-list mutations (delete/reorder/duplicate/restore)
 * run inside `withTargetVectorStructure`:
 *
 * - The caller retires active gestures synchronously first (existing
 *   `abandonVectorGesturesForCostumeStructure`), so late async preview
 *   continuations observe the cleared drag state / cancelled token and
 *   never enqueue.
 * - The gate drains ALL in-flight slot writes for that target and bumps a
 *   per-target structure epoch. Already-started delayed VM writes complete
 *   BEFORE the array is mutated, so they land on the pre-structure indices.
 * - Previews carrying the pre-structure epoch (captured at drag start) skip
 *   even if they enqueue after the bump; they address shifted artwork and
 *   must not run. New edits capture the post-structure epoch, wait for the
 *   active structure barrier, then run on the new layout.
 * - Serialization is per-target only: no global lock, so a structural op on
 *   VecA never blocks VecB writes.
 *
 * Boundary conditions (explicit, by design):
 *
 * - Direct `vm.updateCostume` / `vm.deleteCostume` / `vm.reorderCostume`
 *   calls that bypass `enqueueVectorCostumeWrite` / `withTargetVectorStructure`
 *   are NOT serialized by this gate. Product code routes every vector write
 *   through the gate; the diagnostic "external vm直呼び" leg documents the
 *   bypass as a boundary, not a product path.
 * - `vm.getTarget(name)` matches `id === query || name === query`, so two
 *   targets sharing a display name alias on lookup. Slot keys and epoch maps
 *   are keyed by stable id, and previews resolve via `vectorWriteTargetById`
 *   with a verified id hit (callers), so a name collision can never steer a
 *   write onto the namesake asset.
 */

export type VectorWriteKind = 'preview' | 'restore' | 'edit'

export function vectorWriteSlotKey(targetId: string, costumeIndex: number): string {
  return `vector-write:${targetId}:${costumeIndex}`
}

export function vectorWriteSlotKeyFor(
  target: { id?: string | null; name: string },
  costumeIndex: number,
): string {
  return vectorWriteSlotKey(target.id ?? target.name, costumeIndex)
}

const SLOT_PREFIX = 'vector-write:'

const tails = new Map<string, Promise<void>>()
/**
 * Per-slot in-flight execution count: incremented when a queued write starts
 * running (after barrier/epoch/cancel gates) and decremented when it
 * settles. Unlike `tails` keys (which persist forever), this drops to zero
 * exactly when the slot has no running write, so a discrete-save barrier can
 * observe genuine slot busyness even after the drag globals were replaced or
 * the gesture identity was retired early. Scoped by exact slot key: other
 * slots/targets never read as busy.
 */
const slotPending = new Map<string, number>()
let gestureSeq = 0

/**
 * Live gesture token. `beginVectorWriteGesture` mints one object per drag;
 * `cancelVectorWriteGesture` flips its `cancelled` flag in place. Queued and
 * not-yet-enqueued previews both hold the same object reference, so a cancel
 * is observed no matter when the preview enqueues or runs. No global
 * cancelled set exists, so there is nothing to prune and no cap to trade
 * safety against: memory is bounded by live tokens only (the queue closures
 * + active drag state the product already retains), reclaimed by GC once
 * those references drop.
 */
export interface VectorWriteGesture {
  readonly id: number
  cancelled: boolean
}

/** Per-target structure epoch: bumped on every shifting mutation. */
const targetEpochs = new Map<string, number>()
/** Active structure barrier per target (new writes wait, old writes skip). */
const targetActive = new Map<string, Promise<void>>()
/** Per-target chain serializing consecutive structural ops. */
const targetChains = new Map<string, Promise<void>>()

/** Mint a fresh gesture token for one drag (point/rotate/leaf/resize). */
export function beginVectorWriteGesture(): VectorWriteGesture {
  gestureSeq += 1
  return { id: gestureSeq, cancelled: false }
}

/** Synchronously retire a gesture so late previews skip their write. */
export function cancelVectorWriteGesture(gesture: VectorWriteGesture | undefined | null): void {
  if (!gesture) return
  gesture.cancelled = true
}

export function isVectorWriteGestureCancelled(gesture: VectorWriteGesture | undefined | null): boolean {
  return gesture?.cancelled ?? false
}

export function targetIdFromVectorWriteSlotKey(slotKey: string): string | undefined {
  if (!slotKey.startsWith(SLOT_PREFIX)) return undefined
  const rest = slotKey.slice(SLOT_PREFIX.length)
  const sep = rest.lastIndexOf(':')
  if (sep < 0) return undefined
  return rest.slice(0, sep)
}

/** Current structure epoch for a target (0 when never mutated). */
export function getTargetVectorEpoch(targetId: string): number {
  return targetEpochs.get(targetId) ?? 0
}

/**
 * Enqueue `write` on the slot FIFO. Previews whose gesture token was cancelled
 * resolve `undefined` without calling `write`; restores/edits always call it.
 * The returned promise settles with the write result (or `undefined` when
 * skipped); queue tails never reject so later writes always proceed.
 *
 * `expectedEpoch`: structure epoch captured at drag/source time. When set,
 * the write runs only when the target epoch still matches at execution time;
 * a structural mutation in between makes it skip. When omitted, the enqueue
 * -time epoch is used implicitly: writes enqueued during an active structure
 * wait for the barrier, pre-structure writes never wait (the structure waits
 * for them) and skip when stale.
 */
export function enqueueVectorCostumeWrite<T>(
  slotKey: string,
  gesture: VectorWriteGesture | undefined,
  kind: VectorWriteKind,
  write: () => Promise<T>,
  expectedEpoch?: number,
): Promise<T | undefined> {
  const targetId = targetIdFromVectorWriteSlotKey(slotKey)
  const seenEpoch =
    expectedEpoch ?? (targetId !== undefined ? (targetEpochs.get(targetId) ?? 0) : undefined)
  const prev = tails.get(slotKey) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(async (): Promise<T | undefined> => {
    if (targetId !== undefined && seenEpoch !== undefined) {
      for (;;) {
        const active = targetActive.get(targetId)
        if (!active) break
        const current = targetEpochs.get(targetId) ?? 0
        // Old-epoch writes predate the active structure: the structure drains
        // them, so they proceed without waiting (and skip below when stale).
        if (seenEpoch !== current) break
        try {
          await active
        } catch {
          // Barrier releases even on structural failure; fall through.
        }
      }
      const current = targetEpochs.get(targetId) ?? 0
      if (seenEpoch !== current) return undefined
    }
    if (kind === 'preview' && gesture !== undefined && gesture.cancelled) {
      return undefined
    }
    // Mark the slot busy for the exact execution window (skipped previews
    // above never mark: they wrote nothing). The decrement runs in a
    // `finally` so a throwing write still releases the slot.
    slotPending.set(slotKey, (slotPending.get(slotKey) ?? 0) + 1)
    try {
      return await write()
    } finally {
      const left = (slotPending.get(slotKey) ?? 1) - 1
      if (left <= 0) slotPending.delete(slotKey)
      else slotPending.set(slotKey, left)
    }
  })
  tails.set(slotKey, next.catch(() => undefined).then(() => undefined))
  return next
}

/**
 * Drain all in-flight slot writes for one target (all indices). New writes
 * enqueued during the drain chain behind the snapshot via the slot FIFO;
 * with an active structure barrier they wait for the structure instead of
 * extending the drain. Never rejects.
 */
export async function drainTargetVectorWrites(targetId: string): Promise<void> {
  const prefix = `${SLOT_PREFIX}${targetId}:`
  const pending = [...tails.entries()]
    .filter(([key]) => key === prefix.slice(0, -1) || key.startsWith(prefix))
    .map(([, tail]) => tail)
  if (pending.length === 0) return
  await Promise.allSettled(pending)
}

/** Drain every in-flight vector write (project replacement path). */
export async function drainAllVectorWrites(): Promise<void> {
  const pending = [...tails.values()]
  if (pending.length === 0) return
  await Promise.allSettled(pending)
}

/**
 * Run a costume-list structural mutation atomically for one target:
 * serialize against sibling structures, drain in-flight writes, optionally
 * bump the epoch (index-shifting ops), run `op`, then release so post-
 * structure edits proceed. Other targets are never blocked.
 *
 * Callers must retire active vector gestures synchronously BEFORE calling
 * (existing `abandonVectorGesturesForCostumeStructure`), so late preview
 * continuations never enqueue with the new epoch.
 */
export async function withTargetVectorStructure<T>(
  targetId: string,
  op: () => Promise<T> | T,
  opts?: { invalidate?: boolean },
): Promise<T> {
  const invalidate = opts?.invalidate ?? true
  const prevChain = targetChains.get(targetId) ?? Promise.resolve()
  let releaseChain!: () => void
  const chainPromise = new Promise<void>((resolve) => {
    releaseChain = resolve
  })
  const nextChain = prevChain.catch(() => undefined).then(() => chainPromise)
  targetChains.set(targetId, nextChain)
  await prevChain.catch(() => undefined)

  let releaseActive!: () => void
  const activePromise = new Promise<void>((resolve) => {
    releaseActive = resolve
  })
  targetActive.set(targetId, activePromise)
  const snapshot = [...tails.entries()]
    .filter(([key]) => key.startsWith(`${SLOT_PREFIX}${targetId}:`))
    .map(([, tail]) => tail)
  if (invalidate) {
    targetEpochs.set(targetId, (targetEpochs.get(targetId) ?? 0) + 1)
  }
  try {
    await Promise.allSettled(snapshot)
    return await op()
  } finally {
    if (targetActive.get(targetId) === activePromise) targetActive.delete(targetId)
    releaseActive()
    releaseChain()
    if (targetChains.get(targetId) === nextChain) targetChains.delete(targetId)
    await nextChain.catch(() => undefined)
  }
}

/** True while the exact slot key has a write executing right now. */
export function isVectorSlotWritePending(slotKey: string): boolean {
  return (slotPending.get(slotKey) ?? 0) > 0
}

/** Test-only reset of tails/epochs (fresh page state per suite). */
export function resetVectorWriteGateForTests(): void {
  tails.clear()
  slotPending.clear()
  targetEpochs.clear()
  targetActive.clear()
  targetChains.clear()
  gestureSeq = 0
}

/**
 * Strict audit helper for structure-write-safety diagnostics (no behavior
 * change). Returns the per-target structure epoch, whether a structure
 * barrier is currently held, the number of in-flight slot tails for the
 * target, and whether a structural chain is queued. Tests use this to
 * separate a sync-premise failure (structure never entered: epoch unchanged,
 * no barrier, no writes) from a barrier deadlock (barrier held, tails never
 * settle) and from an async-UI wait issue (barrier released, epoch bumped,
 * VM already shifted while the UI preview/status lags one tick).
 */
export function debugTargetVectorWriteState(targetId: string): {
  epoch: number
  hasActiveBarrier: boolean
  inFlightTails: number
  hasQueuedStructure: boolean
} {
  const prefix = `${SLOT_PREFIX}${targetId}:`
  let inFlightTails = 0
  for (const key of tails.keys()) {
    if (key.startsWith(prefix)) inFlightTails += 1
  }
  return {
    epoch: targetEpochs.get(targetId) ?? 0,
    hasActiveBarrier: targetActive.has(targetId),
    inFlightTails,
    hasQueuedStructure: targetChains.has(targetId),
  }
}
