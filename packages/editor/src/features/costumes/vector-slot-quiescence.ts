/**
 * Per-slot vector quiescence barrier (fail-closed).
 *
 * Split out of `Editor.svelte` per `packages/editor/AGENTS.md` (features/
 * owns paint-editor logic). Pure + framework-free so unit tests can drive
 * it deterministically without the Editor or the VM.
 *
 * Problem closed here: the old `waitForVectorSlotQuiescence` polled the
 * live drag globals for `200 * 10ms` and then returned `void` even when
 * still busy, while a `catch {}` around the cancel barrier silently
 * committed. A move delayed past ~2s (gated `storeAsset`) therefore let a
 * stamp build on the pre-move base and overwrite the move via the versioned
 * CAS. Replacing the global (`vectorDrag` etc.) with a new op on another
 * slot also looked "not busy" even though the old slot's final frame was
 * still queued.
 *
 * Contract:
 * - The caller supplies an `isBusy` probe that reports per-slot busyness
 *   from versioned tokens/generations (gesture ids + slot tails), NOT from
 *   a single replaceable global. The probe must stay true while the exact
 *   in-flight gesture/completion for this slot has not settled, even after
 *   the globals were replaced by another slot's op.
 * - `drain` waits the captured exact final completion for this slot (the
 *   per-slot FIFO tails snapshot); `waitCancel` waits the captured cancel
 *   barrier promise for this slot. Both are awaited only after the probe
 *   reports idle, then the probe is rechecked once for stragglers enqueued
 *   during the drain.
 * - Bounded: `timeoutMs` (default 2000) total. On expiry returns
 *   `{ ok: false, reason: 'timeout' }` — the caller must abort WITHOUT
 *   writing history/selection/bytes or a success status, and WITHOUT a
 *   speculative resume (no extra drain/write after the timeout).
 * - Barrier failure (`drain`/`waitCancel` rejects) returns
 *   `{ ok: false, reason: 'barrier' }` — fail closed with an actionable
 *   status, never a silent commit.
 * - This helper never cancels gestures: other-slot ops are untouched.
 */

export interface VectorSlotQuiescenceHooks {
  /** True while the exact in-flight work for this slot has not settled. */
  isBusy: () => boolean;
  /** Wait the captured exact slot completion (FIFO tails snapshot). */
  drain: () => Promise<unknown>;
  /** Wait the captured cancel-barrier promise for this slot (if any). */
  waitCancel: () => Promise<unknown>;
}

export type VectorSlotQuiescenceReason = 'timeout' | 'barrier';

export interface VectorSlotQuiescenceResult {
  ok: boolean;
  reason?: VectorSlotQuiescenceReason;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_INTERVAL_MS = 10;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForVectorSlotQuiescenceGate(
  hooks: VectorSlotQuiescenceHooks,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<VectorSlotQuiescenceResult> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const step = Math.max(1, intervalMs);
  for (;;) {
    if (!hooks.isBusy()) {
      // Capture the exact final completion for this slot only after the
      // probe reports idle, then wait it safely: a straggler enqueued
      // during the drain is caught by the recheck below.
      try {
        await hooks.drain();
      } catch {
        return { ok: false, reason: 'barrier' };
      }
      try {
        await hooks.waitCancel();
      } catch {
        return { ok: false, reason: 'barrier' };
      }
      if (!hooks.isBusy()) return { ok: true };
      // Straggler landed during the barrier: keep waiting within budget.
    }
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout' };
    const remaining = deadline - Date.now();
    await sleep(Math.min(step, Math.max(1, remaining)));
  }
}

/**
 * Commit-side settle state for one pointerup end (move/resize/rotate/point/
 * leaf). `settled` means the flags report idle for OUR gesture (or the
 * pointerup's own drag); `busy` means our frames are still in flight;
 * `gone` means the global no longer belongs to us (a newcomer took over, or
 * the drag was cleared elsewhere) — the old commit must finish locally
 * WITHOUT waiting on the newcomer's writes.
 */
export type VectorGestureSettleState = 'settled' | 'busy' | 'gone';

/**
 * Wait the captured exact slot completion before a pointerup end retires its
 * gesture identity. The old per-end `200 * 10ms` flag loops expire while a
 * gated write is still running (>2s `storeAsset` gate): the identity is then
 * retired early, `noteVectorPreviewApplied` no-ops while live advances, and
 * `known` strands behind `live` so the next Undo falsely reports an external
 * write. Draining the captured slot tails here keeps the identity alive until
 * the final frame lands, so the completion is observed exactly once.
 *
 * Bounded (default 30s) fail-safe: on expiry this proceeds like the old loop
 * so a wedged slot cannot stall pointerup forever. The per-slot pending
 * counter (`isVectorSlotWritePending`) still keeps discrete-save barriers
 * closed while tails are genuinely in flight, and other slots/targets are
 * never waited on. Never cancels gestures.
 */
export async function settleVectorGestureSlotCompletion(
  probe: () => VectorGestureSettleState,
  drainSlot: () => Promise<unknown>,
  maxAttempts: number = 3000,
  intervalMs: number = 10,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const state = probe();
    if (state === 'gone') return;
    if (state === 'settled') {
      try {
        await drainSlot();
      } catch {
        // `drainTargetVectorWrites` never rejects; ignore defensively.
      }
      if (probe() === 'settled') {
        try {
          await drainSlot();
        } catch {
          // Same defensive ignore.
        }
        return;
      }
      continue;
    }
    await sleep(Math.max(1, intervalMs));
  }
  // Fail-safe expiry: proceed (old bounded-loop behavior).
  try {
    await drainSlot();
  } catch {
    // Same defensive ignore.
  }
}
