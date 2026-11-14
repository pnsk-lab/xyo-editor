/**
 * Vector resize commit gate (PURE, UNWIRED diagnostic helper).
 *
 * Product code (`Editor.svelte`) is NOT edited by this file. It models the
 * fix for diag-A so a unit test can prove the call-order bug without a
 * browser:
 *
 * - Buggy Editor resize: `peek` per first effective move, then
 *   `await vm.updateCostume` (VM async gate), then `commit`. `pointerup`
 *   (`endVectorObjectResize`) only `await applyLiveVectorResize(final)` once.
 *   When the gate delays the write, `applying === true` at pointerup, the
 *   call stores `pendingClientX/Y` and returns, the end handler reads
 *   `historyCaptured === false` and clears `vectorResizeDrag`. The in-flight
 *   write later resumes, sees the drag is gone (`if (!vectorResizeDrag)
 *   return`) and drops BOTH the pending coalesced frame AND the already
 *   peeked `pendingEntry` commit. Live bytes advance (resized SVG) but undo
 *   keeps only the shape entry, so one Undo restores blank (2 steps erased).
 * - Fixed (rotate/point/leaf parity): `historyReady` is peeked once at
 *   `begin` (deferred `pendingEntry`), every preview writes with
 *   `{gestureId, kind:'preview'}` on the same per-slot FIFO, pointerup sets
 *   `committing = true` synchronously (trailing implicit
 *   `lostpointercapture` becomes a no-op), waits for quiescence
 *   (`applying === false && pendingClientX === undefined`), re-applies the
 *   final absolute delta once from the immutable `sourceReady` snapshot, then
 *   commits exactly one entry when the final artwork actually changed.
 *
 * This module is intentionally side-effect free: no DOM, no Paper.js, no VM.
 * The unit test drives it with a fake gated VM + the real
 * `paint-history.ts` / `vector-costume-write-gate.ts` primitives.
 */

export type ResizeHistoryPhase = 'idle' | 'dragging' | 'committing' | 'done';

export interface VectorResizeCommitState {
  phase: ResizeHistoryPhase;
  /** Deferred pre-drag entry (peeked at begin, committed once at end). */
  hasPendingEntry: boolean;
  /** True once at least one preview write was enqueued/applied. */
  moved: boolean;
  /** Sync claim mirroring rotate/point/leaf `committing`. */
  committing: boolean;
  /** True while one `applyLive` iteration owns the async write. */
  applying: boolean;
  /** Coalesced pointer waiting for the in-flight iteration. */
  hasPendingPointer: boolean;
}

export function createVectorResizeCommitState(): VectorResizeCommitState {
  return {
    phase: 'idle',
    hasPendingEntry: false,
    moved: false,
    committing: false,
    applying: false,
    hasPendingPointer: false,
  };
}

/**
 * Begin: record that the deferred peek resolved (mirrors
 * `historyReady.then(entry => pendingEntry = entry)` in rotate/point/leaf).
 * No commit happens here; a click/no-op drag therefore leaves undo/redo
 * untouched.
 */
export function resizeCommitOnBegin(
  state: VectorResizeCommitState,
  peekResolved: boolean,
): VectorResizeCommitState {
  if (state.phase !== 'idle') return state;
  return {
    ...state,
    phase: 'dragging',
    hasPendingEntry: peekResolved,
  };
}

/** One preview frame applied against the immutable snapshot. */
export function resizeCommitOnPreviewApplied(state: VectorResizeCommitState): VectorResizeCommitState {
  if (state.phase !== 'dragging') return state;
  return { ...state, moved: true };
}

/**
 * Pointerup claim: must run synchronously before the first await so the
 * trailing implicit `lostpointercapture` auto-loss after pointerup cannot
 * cancel the just-released drag (rotate/point/leaf parity).
 */
export function resizeCommitOnPointerUp(state: VectorResizeCommitState): VectorResizeCommitState {
  if (state.phase !== 'dragging') return state;
  return { ...state, phase: 'committing', committing: true };
}

/**
 * Whether the end handler may commit exactly one history entry. Only when a
 * preview actually moved AND the deferred peek resolved. Returning to start
 * (moved === false) or a failed peek commits nothing, so no empty Undo entry
 * is created and redo survives.
 */
export function shouldCommitVectorResizeHistory(state: VectorResizeCommitState): boolean {
  return state.phase === 'committing' && state.committing && state.moved && state.hasPendingEntry;
}

/** Genuine `pointercancel`/`lostpointercapture` during drag cancels (no commit). */
export function shouldCancelVectorResizeOnSignal(
  state: VectorResizeCommitState,
  signal: 'pointercancel' | 'lostpointercapture',
): boolean {
  void signal;
  // A pointerup-claimed commit owns the gesture: trailing auto-loss is a no-op.
  if (state.committing) return false;
  return state.phase === 'dragging';
}
