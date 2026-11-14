import type { BitmapShapeKind, BitmapShapeMode } from './bitmap-shape-mode'
import {
  createPendingBitmapShape,
  movePendingBitmapShape,
  restylePendingBitmapShape,
  retargetPendingBitmapShape,
  withPendingAffine,
  type PendingBitmapShape,
  type PendingBitmapShapeStyle,
} from './bitmap-pending-shape'
import {
  rotatePendingBitmapShape,
  rotatePendingBitmapShapeBy,
  rotatePendingBitmapShapeTo,
  type PendingBitmapRotateDirection,
} from './bitmap-pending-transform'
import {
  compositePendingBitmapShapePreview,
  resolvePendingBitmapShapePreview,
} from './bitmap-pending-shape-preview'
import {
  createPendingBitmapTransaction,
  isPendingScopeCurrent,
  type PendingBitmapTransaction,
  type PendingCommitScope,
  type PendingCommitTaken,
  type PendingCommitWrite,
  type PendingCommitWriteResult,
} from './bitmap-pending-transaction'
import {
  captureBitmapPendingScope,
  createBitmapPendingVmWrite,
  type BitmapPendingScopeExtra,
  type BitmapPendingVmLike,
} from './bitmap-pending-vm-writer'
import {
  createBitmapPendingContinuationGuard,
  runBitmapPendingUiOp,
  type BitmapPendingContinuationCheck,
  type BitmapPendingPreflightResult,
  type BitmapPendingUiCommand,
  type BitmapPendingUiOp,
} from './bitmap-pending-preflight'
import {
  bitmapPaperPerCanvasPx,
  bitmapShapePaperZoom,
  isTinyShapeBox,
  resolveShapeRect,
  type ShapeModifierKeys,
} from './shape-drag'

// Re-exported so the controller (the single integration surface) keeps one
// import site; the canonical definitions live in `bitmap-pending-vm-writer`.
export type { BitmapPendingScopeExtra, BitmapPendingVmLike } from './bitmap-pending-vm-writer'

/**
 * Isolated pending rect/oval session adapter (bitmap `rect` / `oval`, B-3).
 *
 * This is the ONLY new integration surface for the Scratch gap "bitmap rect /
 * oval raster+save on mouseup, no restyle". It composes the four tested
 * primitives without duplicating them and without touching product UI:
 *
 * - parametric side: `bitmap-pending-shape.ts` (create / restyle / move /
 *   retarget, single-shot take semantics mirrored locally);
 * - draw side: `bitmap-pending-shape-preview.ts` (single-pass `base + shape`,
 *   never `live + shape`, so re-renders, restyles and retargets can never
 *   double-compose or bake semi-transparent pixels twice);
 * - commit discipline: `bitmap-pending-transaction.ts` (single slot, strict
 *   CAS, fail-closed restore, exactly-once history via the session write);
 * - transition gates: `bitmap-pending-preflight.ts` (commit-first /
 *   discard-first / leave-pending classifier + continuation guard).
 *
 * No `Editor.svelte` / `BitmapEditor.svelte` import, no VM import, no DOM
 * access, no timers, no retries, no recursion. The future UI wiring supplies:
 *
 * - `CanvasPorts`: the live canvas callbacks (capture / overlay paint /
 *   restore / rasterize / PNG encode). Every render starts from the frozen
 *   pre-stroke base and paints the shape exactly once.
 * - `HistoryPorts`: peek / commit / depth over the paint history side, with an
 *   optional serializable `beginReservation` / `isCurrent` guard mirroring the
 *   Editor `peekCostumeHistory` / `commitPaintHistory` scope guard. The
 *   session reserves BEFORE any VM mutation and re-checks the reservation
 *   after every await, blocking the CAS fail-closed (`history-unavailable`,
 *   zero bytes touched) when history is already stale. The peeked entry is
 *   committed exactly once per landed write, synchronously AFTER the CAS
 *   reports `applied: true` with no await in between, so a failed store /
 *   conflict / abort adds NO entry and a retry cannot double-append. A
 *   `false` / throw AFTER `applied: true` never becomes `history-stale`: the
 *   original VM success is returned (the coordinator maps a post-write
 *   external mutation to `external-conflict`, a still-owned spurious failure
 *   to `committed-without-history` + `historyGap`), so the pending is never
 *   restored and the bytes are never reapplied over committed or external
 *   art.
 *
 * History-gap fail-first rule (strict, tested with real VM + canvas):
 * - a landed-without-history commit returns the DISTINCT
 *   `committed-without-history` (never plain `committed`, never a failure),
 *   sets `snapshot().historyGap`, and leaves the `history-gap` status as the
 *   LAST status (later success paths never overwrite it with
 *   `Bitmap shape committed`);
 * - `runCommand` suppresses its continuation op when its own commit gaps (no
 *   ghost switch/export) and every LATER `runCommand` / new paint
 *   (`pointerDown` / restyle / move / retarget) is refused with
 *   `history-gap` until `acknowledgeHistoryGap()`;
 * - a retry `commitPending` with no pending stays `nothing-to-commit`
 *   (never duplicates bytes); the session never pretends the stroke is
 *   uncommitted and never reverts the VM — no complete atomic undo is
 *   claimed (after the VM emits its synchronous event and history fails,
 *   rollback cannot be guaranteed; the robust reservation makes this
 *   unreachable in the real history backend).
 * - the live `ScratchVM` (stable-id CAS route only) plus Editor-owned
 *   `loadSerial` / `sessionGeneration`.
 *
 * Invariants (mirroring `bitmap-pending-transaction-design.md` I1–I6):
 * - stored asset untouched until commit; overlay is always `base + shape`;
 * - one pending shape + one base at most; restyle/transform never write
 *   history; commit writes exactly one history entry on success, zero on any
 *   refusal (pending retained for retry where still owned);
 * - every transition that would execute a UI op (`save`, `export`,
 *   `select-costume`, `select-target`, ...) runs commit-first through the
 *   preflight gate and executes the op at most once, only on owned success;
 * - every overlay mutation bumps `renderRev` and calls `onInvalidate`, so the
 *   UI can refresh the outline/selection without polling.
 */

export type BitmapPendingSessionPoint = { x: number; y: number }

export type BitmapPendingSessionCanvasPorts = {
  /** Live canvas size in integer canvas px. */
  getCanvasSize: () => { width: number; height: number } | undefined
  /** Full-canvas pre-stroke snapshot (`getImageData`). */
  captureBase: () => ImageData | undefined
  /**
   * Single-pass overlay: restore `base`, paint `shape` once, present the
   * result on the live canvas, and return the presented raster (fresh
   * `ImageData`, input base never mutated). `undefined` on any refusal.
   */
  paintOverlay: (base: ImageData, shape: PendingBitmapShape) => ImageData | undefined
  /** Exact base restore (`putImageData`). */
  restoreBase: (base: ImageData) => boolean
  /**
   * Committed raster for one base+shape pair, WITHOUT touching the live
   * canvas when possible (detached composite preferred). The session paints
   * the overlay for display and rasterizes for encode separately so a failed
   * encode never leaves a half pass on screen.
   */
  rasterize: (base: ImageData, shape: PendingBitmapShape) => ImageData | undefined
  /** PNG encode of a committed raster. `undefined` = encode failure. */
  encodePng: (image: ImageData) => Promise<Uint8Array | undefined>
}

export type BitmapPendingHistoryReservation<E = unknown> = {
  /**
   * Synchronous guard mirroring the backend `commit` guard (scope key +
   * generation, same check `commit` performs). `false` means an external
   * switch/clear already invalidated the peeked entry: the session must
   * block BEFORE any VM mutation.
   */
  isCurrent: () => boolean
  /**
   * Synchronous atomic append. Returns `true` when the entry landed, `false`
   * only when the guard went stale (external switch/clear or a concurrent
   * history invalidation). MUST NOT fail spuriously while `isCurrent()` is
   * still `true`: a spurious `false`/throw after a landed VM write cannot be
   * distinguished from a stale guard, so the session never converts it into
   * a commit failure (fail-closed toward success, never reapply).
   */
  commit: () => boolean
  /** Release the reservation without appending (abort / pre-write refuse). */
  cancel?: () => void
}

export type BitmapPendingSessionHistoryPorts<E = unknown> = {
  /** Peek the pre-commit entry (stored bytes for Undo). */
  peek: () => Promise<E | undefined>
  /**
   * Append one entry; returns `false` when the peeked guard went stale (the
   * session then treats the commit as refused and keeps no entry).
   *
   * CONTRACT (serializable reservation): after a landed VM write (`applied:
   * true`) this MUST succeed whenever the scope is still current. A `false`
   * / throw with no external mutation is a backend contract violation: the
   * session surfaces it via `onStatus('history-gap ...')` + the snapshot
   * `historyGap` flag but still reports the VM success (`committed`) so the
   * transaction never restores the pending, never retries the bytes over the
   * committed art, and never reports `history-stale` for landed pixels.
   */
  commit: (entry: E) => boolean
  /** Current undo depth (for the exactly-once proof). */
  depth: () => number
  /**
   * Optional strict reservation. When present the session reserves BEFORE
   * any VM mutation and re-checks `isCurrent()` after every await, blocking
   * the write fail-closed (`history-unavailable`, no bytes touched) when the
   * history side is already stale. When absent the session falls back to the
   * legacy `peek` / `commit` pair plus its own scope revalidation, with the
   * same post-write rule: never fail after `applied: true`.
   */
  beginReservation?: (entry: E) => BitmapPendingHistoryReservation<E> | undefined
  /** Optional synchronous mirror of the backend commit guard (pre-write check). */
  isCurrent?: () => boolean
  /**
   * Optional synchronous rollback for the reentrant window INSIDE the
   * history append: when a VM callback mutates the store synchronously from
   * within `commit()`, the session rolls the just-pushed stale entry back
   * (only when it is still on top). Return `true` when the entry was removed.
   */
  tryRemove?: (entry: E) => boolean
  /** Legacy alias of `tryRemove` (accepted for test backends). */
  removeLast?: (entry: E) => boolean
}

export type BitmapPendingSessionNotify = {
  /** Called synchronously after every overlay/canvas mutation with the new rev. */
  onInvalidate?: (renderRev: number) => void
  /** Human-readable transition status (commit / refuse / discard reasons). */
  onStatus?: (status: string) => void
}

export type BitmapPendingSessionConfig = {
  /** Stored bitmap resolution (1 or 2; drives the Paper-unit commit gate). */
  storedResolution?: number
  /** CSS viewport scale (drives the zoom-scaled tiny-shape budget). */
  viewportScale?: number
  /** PNG metadata preserved verbatim (never re-derived, never `name`). */
  bitmapResolution?: number
  rotationCenterX?: number
  rotationCenterY?: number
}

export type BitmapPendingSessionEventResult =
  | { ok: true; kind: 'staged' | 'updated' | 'unchanged' | 'committed' | 'discarded' | 'nothing-to-commit' | 'nothing-pending' }
  | { ok: false; kind: 'refused'; reason: string; detail?: string }

/**
 * Session commit outcome. `committed-without-history` is DISTINCT from a
 * failure: the VM bytes already landed (`applied: true`, verified live
 * identity) but the history append returned `false` / threw while still
 * owned, so there is no Undo entry. Callers MUST NOT treat it as
 * `commit-failed` / retry the bytes (that would duplicate art) and MUST NOT
 * treat it as plain `committed` (that would silently continue past the gap).
 * The session sets `snapshot().historyGap === true`, keeps the
 * `history-gap` status as the LAST status (never overwritten by
 * `Bitmap shape committed`), suppresses the `runCommand` continuation op,
 * and blocks new paint until `acknowledgeHistoryGap()` is called.
 */
export type BitmapPendingSessionCommitResult =
  | { ok: true; kind: 'committed' }
  | { ok: true; kind: 'committed-without-history'; historyGap: true }
  | { ok: true; kind: 'nothing-to-commit' }
  | { ok: true; kind: 'discarded' }
  | { ok: false; kind: 'refused'; reason: string; detail?: string }

export type BitmapPendingSessionSnapshot = {
  hasPending: boolean
  commitInFlight: boolean
  renderRev: number
  historyDepth: number
  quarantined?: BitmapPendingQuarantinedView | undefined
  quarantine?: BitmapPendingQuarantinedView | undefined
  pendingKind: BitmapShapeKind | undefined
  pendingMode: BitmapShapeMode | undefined
  /**
   * Landed-bytes-without-undo flag. Set only when the VM CAS reported
   * `applied: true` but the history append returned `false` / threw while
   * the slot was still owned (spurious backend failure, no external
   * mutation). The commit is reported as `committed-without-history`
   * (never `history-stale`, never restored, never reapplied, never plain
   * `committed`); the flag + the sticky `history-gap` status line surface
   * the missing Undo entry explicitly until `acknowledgeHistoryGap()`.
   *
   * While `true`: the session blocks new paint (`pointerDown` / restyle /
   * move / retarget) and suppresses every `runCommand` continuation op with
   * `refused: history-gap` (no ghost switch/export). A retry `commitPending`
   * with no pending stays `nothing-to-commit` (never reapplied) and keeps
   * the flag. The VM bytes are preserved as-is; the session never pretends
   * the stroke is uncommitted and never reverts the VM (no atomic undo is
   * claimed: after the VM emits its synchronous event and history fails,
   * rollback cannot be guaranteed; the robust reservation makes this
   * unreachable in the real history backend).
   */
  historyGap: boolean
}

/**
 * Safe recovery policy for a history gap (documented, explicit, not silent):
 * after `committed-without-history` the UI MUST surface the sticky
 * `history-gap` warning and require an explicit user acknowledgement before
 * any further paint / save / export / switch. `acknowledgeHistoryGap()`
 * records that acknowledgement (clearing `historyGap` so new paint and ops
 * may proceed). Export recovery after acknowledgement re-reads the ALREADY
 * COMMITTED stored bytes (never re-commits, never duplicates); Undo for the
 * gap stroke remains unavailable and the UI must say so. Silent auto-export
 * or auto-continuation past the gap is prohibited.
 */

type DraftStroke = {
  kind: BitmapShapeKind
  start: BitmapPendingSessionPoint
  current: BitmapPendingSessionPoint
  modifiers: ShapeModifierKeys
  mode: BitmapShapeMode
  style: PendingBitmapShapeStyle
  base: ImageData
  /** Live scope captured synchronously with `base` (fail-first canvas guard). */
  scope: PendingCommitScope
}

type StagedMirror = {
  shape: PendingBitmapShape
  base: ImageData
  scope: PendingCommitScope
}

export type BitmapPendingQuarantineReason =
  | 'owner-mismatch'
  | 'external-conflict'
  | 'superseded'
  | 'aborted'
  | 'invalid-scope'
  | 'quarantine-full'

export type BitmapPendingQuarantinedView = {
  shape: PendingBitmapShape
  base: ImageData
  scope: PendingCommitScope
  reason: string
  detail?: string
  format?: string | null
}

type QuarantinedEntry = {
  shape: PendingBitmapShape
  base: ImageData
  scope: PendingCommitScope
  reason: string
  detail?: string
  format?: string | null
}

function isPoint(value: unknown): value is BitmapPendingSessionPoint {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.x === 'number' && Number.isFinite(record.x) && typeof record.y === 'number' && Number.isFinite(record.y)
}

function cloneImageDataSizeOf(base: ImageData): ImageData | undefined {
  try {
    const Ctor = (globalThis as { ImageData?: new (data: Uint8ClampedArray, width: number, height?: number) => ImageData }).ImageData
    if (typeof Ctor !== 'function') return undefined
    return new Ctor(new Uint8ClampedArray(base.data), base.width, base.height)
  } catch {
    return undefined
  }
}

function defaultCanvasPortsFromContext(
  context: CanvasRenderingContext2D | undefined | null,
): BitmapPendingSessionCanvasPorts | undefined {
  if (!context) return undefined
  const canvas = (context as CanvasRenderingContext2D).canvas as unknown as { width?: unknown; height?: unknown } | undefined
  return {
    getCanvasSize: () => {
      const width = canvas?.width
      const height = canvas?.height
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined
      return { width: width as number, height: height as number }
    },
    captureBase: () => {
      try {
        const size = { width: canvas?.width as number, height: canvas?.height as number }
        if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)) return undefined
        return context.getImageData(0, 0, size.width, size.height)
      } catch {
        return undefined
      }
    },
    paintOverlay: (base, shape) => compositePendingBitmapShapePreview(context, base, shape),
    restoreBase: (base) => {
      try {
        context.putImageData(base, 0, 0)
        return true
      } catch {
        return false
      }
    },
    rasterize: (base, shape) => {
      // Detached commit raster: never touches the live canvas, so a failed
      // encode cannot leave a half pass on screen. Falls back to a
      // same-pixels composite when no detached canvas exists.
      try {
        const doc = (globalThis as { document?: unknown }).document as
          | { createElement?: (tag: string) => { width: number; height: number; getContext?: (kind: string) => unknown } }
          | undefined
        const width = (base as ImageData).width
        const height = (base as ImageData).height
        if (doc && typeof doc.createElement === 'function') {
          const off = doc.createElement('canvas')
          off.width = width
          off.height = height
          const offCtx = off.getContext?.('2d') as CanvasRenderingContext2D | null | undefined
          if (offCtx) return compositePendingBitmapShapePreview(offCtx, base, shape) ?? undefined
        }
      } catch {
        // Fall through to the live-context composite below.
      }
      return compositePendingBitmapShapePreview(context, base, shape) ?? undefined
    },
    encodePng: async (image) => {
      try {
        const doc = (globalThis as { document?: unknown }).document as
          | { createElement?: (tag: string) => { width: number; height: number; getContext?: (kind: string) => unknown; toBlob?: (cb: (b: Blob | null) => void, type?: string) => void } }
          | undefined
        if (!doc || typeof doc.createElement !== 'function') return undefined
        const off = doc.createElement('canvas')
        off.width = image.width
        off.height = image.height
        const offCtx = off.getContext?.('2d') as CanvasRenderingContext2D | null | undefined
        if (!offCtx) return undefined
        offCtx.putImageData(image, 0, 0)
        if (typeof off.toBlob !== 'function') return undefined
        const blob = await new Promise<Blob | null>((resolve) => {
          try {
            ;(off.toBlob as (cb: (b: Blob | null) => void, type?: string) => void).call(off, resolve, 'image/png')
          } catch {
            resolve(null)
          }
        })
        if (!blob) return undefined
        return new Uint8Array(await blob.arrayBuffer())
      } catch {
        return undefined
      }
    },
  }
}

export type BitmapPendingSession<E = unknown> = {
  /** Live transaction (exposed for preflight joins; the session owns staging). */
  readonly tx: PendingBitmapTransaction
  configure: (config: BitmapPendingSessionConfig) => void
  pointerDown: (at: BitmapPendingSessionPoint, kind: BitmapShapeKind, mode: BitmapShapeMode, style: PendingBitmapShapeStyle) => Promise<BitmapPendingSessionEventResult>
  pointerMove: (at: BitmapPendingSessionPoint, modifiers?: ShapeModifierKeys) => BitmapPendingSessionEventResult
  pointerUp: (at: BitmapPendingSessionPoint, modifiers?: ShapeModifierKeys) => Promise<BitmapPendingSessionEventResult>
  cancelDraft: () => BitmapPendingSessionEventResult
  restyle: (style: Partial<PendingBitmapShapeStyle>, mode?: BitmapShapeMode) => BitmapPendingSessionEventResult
  moveBy: (dx: number, dy: number) => BitmapPendingSessionEventResult
  retarget: (box: { x: number; y: number; width: number; height: number }) => BitmapPendingSessionEventResult
  /**
   * Test-only parametric affine-scale adapter (no UI wiring: the Editor
   * never calls this; it exists so isolated session fixtures can drive the
   * exact screen-axis `S * R` leg against the real canvas + VM). Follows the
   * exact `moveBy` / `retarget` discipline: history-gap fail-first,
   * empty/owner/canvas/size guards, `withPendingAffine` (local box + scalar
   * rotation + style stay verbatim) plus the same single-shot
   * `restageCurrent` (frozen base, single-pass `base + shape` repaint, no
   * history, no VM write before commit). Invalid matrices fail closed with
   * the staged shape retained.
   */
  stageAffine: (matrix: { a: number; b: number; c: number; d: number; e: number; f: number } | undefined) => BitmapPendingSessionEventResult
  /**
   * Test-only parametric 90-degree rotation adapter (no UI wiring: the Editor
   * never calls this; it exists so isolated session fixtures can drive the
   * pending rotate leg against the real canvas + VM). Follows the exact
   * `moveBy` / `retarget` discipline: history-gap fail-first, empty/owner/
   * canvas/size guards, pure-helper box math via
   * `rotatePendingBitmapShape`, same-object no-op fast path, and
   * `restageCurrent` (frozen base, single-pass `base + shape` repaint, no
   * history, no VM write before commit).
   */
  rotate90: (direction: PendingBitmapRotateDirection) => BitmapPendingSessionEventResult
  /**
   * Absolute arbitrary-angle rotation (free rotate-handle parity): stage
   * `rotationDegrees` (clockwise, normalized to (-180, 180]) about the shape's
   * own center, keeping the local box + style verbatim. Every handle-drag
   * pointermove calls this with `dragStartRotation + gestureDelta` (absolute,
   * never incremental), so repeats and replays from the same pointer cannot
   * drift. Same guards as `rotate90` (gap / empty / owner / canvas / size)
   * plus the same single-shot `restageCurrent` (frozen base, single-pass
   * `base + shape`, no history, no VM write before commit).
   */
  rotateTo: (rotationDegrees: number) => BitmapPendingSessionEventResult
  /**
   * Relative arbitrary-angle rotation: `rotateTo(current + delta)`. Deltas
   * below the shared rotation no-op epsilon keep the staged shape untouched
   * (`unchanged`, no re-render, no history).
   */
  rotateBy: (deltaDegrees: number) => BitmapPendingSessionEventResult
  commitPending: () => Promise<BitmapPendingSessionCommitResult>
  runCommand: <T>(command: BitmapPendingUiCommand | string, runOp: BitmapPendingUiOp<T>, guard?: BitmapPendingContinuationCheck) => Promise<BitmapPendingPreflightResult<T>>
  discardForDeleteOrUndo: () => BitmapPendingSessionEventResult
  abortInFlight: (reason?: string) => { ok: true; kind: 'aborted' | 'nothing-in-flight' }
  /**
   * Explicit user acknowledgement for a `committed-without-history` gap.
   * Clears `snapshot().historyGap` so new paint / ops may proceed; emits an
   * acknowledgement status (the pre-ack `history-gap` warning is otherwise
   * sticky and never overwritten). Returns `acknowledged: false` when there
   * is no gap. Required before export/switch recovery: silent continuation
   * past the gap is prohibited.
   */
  acknowledgeHistoryGap: (note?: string) => { ok: true; acknowledged: boolean; historyGap: boolean }
  snapshot: () => BitmapPendingSessionSnapshot
  getRenderRev: () => number
  getPendingShape: () => PendingBitmapShape | undefined
  getQuarantined: () => BitmapPendingQuarantinedView | undefined
  getQuarantine: () => BitmapPendingQuarantinedView | undefined
  getConflicted: () => BitmapPendingQuarantinedView | undefined
  getPreservedPending: () => BitmapPendingQuarantinedView | undefined
  exportQuarantinedPng: () => Promise<Uint8Array | undefined>
  exportPreservedPng: () => Promise<Uint8Array | undefined>
  exportConflictedPng: () => Promise<Uint8Array | undefined>
  rebaseQuarantinedAfterMetadataRename: () => unknown
  rebaseQuarantine: () => unknown
  adoptExternalRename: () => unknown
  /**
   * Move the staged pending into the bounded single quarantine WITHOUT
   * touching the live canvas and WITHOUT any VM/history write. The pre-stroke
   * base is never restored here (unlike the conflict path, which restores only
   * when still owned): after a slot change the same DOM canvas may already
   * carry the new owner's ink, so any restore could corrupt visible art. The
   * quarantined copy is immutable and exportable via `exportQuarantinedPng`;
   * explicit export/discard is required afterwards. Refuses while a commit is
   * in flight (the flight owns the staged copy until it settles) and while
   * the quarantine is already full (both retained, no silent loss).
   */
  quarantineStagedOffCanvas: (reason?: string, detail?: string) => { ok: true; kind: 'quarantined' | 'nothing-pending' } | { ok: false; kind: 'refused'; reason: string; detail?: string }
  discardQuarantined: () => { ok: true; kind: 'discarded' | 'nothing-pending' }
  discardQuarantine: () => { ok: true; kind: 'discarded' | 'nothing-pending' }
  clearQuarantine: () => { ok: true; kind: 'discarded' | 'nothing-pending' }
}

/**
 * Create an isolated pending-shape session bound to injected canvas/history
 * callbacks and one live VM. No product UI wiring: the future `Editor.svelte`
 * entry points map 1:1 onto these methods (pointerDown/Move/Up, restyle,
 * moveBy/retarget, runCommand for save/export/switch/structural ops,
 * discardForDeleteOrUndo, abortInFlight).
 */
export function createBitmapPendingSession<E = unknown>(
  vm: BitmapPendingVmLike,
  targetId: string,
  costumeIndex: number,
  extra: BitmapPendingScopeExtra,
  ports: BitmapPendingSessionCanvasPorts | CanvasRenderingContext2D | undefined | null,
  history: BitmapPendingSessionHistoryPorts<E>,
  notify: BitmapPendingSessionNotify = {},
  initialConfig: BitmapPendingSessionConfig = {},
): BitmapPendingSession<E> {
  const canvas: BitmapPendingSessionCanvasPorts | undefined =
    ports !== undefined && ports !== null && typeof (ports as CanvasRenderingContext2D).getImageData === 'function'
      ? defaultCanvasPortsFromContext(ports as CanvasRenderingContext2D)
      : (ports as BitmapPendingSessionCanvasPorts | undefined)
  const tx = createPendingBitmapTransaction()
  let config: BitmapPendingSessionConfig = { ...initialConfig }
  let draft: DraftStroke | undefined
  let staged: StagedMirror | undefined
  let renderRev = 0
  let historyGap = false

  const slotId = String(targetId ?? '')
  const slotIndex = Number(costumeIndex)

  function status(text: string): void {
    try {
      notify.onStatus?.(text)
    } catch {
      // Notification must never break the commit discipline.
    }
  }

  function invalidate(): number {
    renderRev += 1
    try {
      notify.onInvalidate?.(renderRev)
    } catch {
      // Notification must never break the commit discipline.
    }
    return renderRev
  }

  /**
   * Sticky gap warning. This is the LAST status after a
   * `committed-without-history` until `acknowledgeHistoryGap()`; later
   * success paths MUST NOT overwrite it with `Bitmap shape committed`.
   */
  function emitHistoryGapWarning(): void {
    status('history-gap: bytes committed without undo entry; explicit acknowledgement required before further paint/export/switch (Undo unavailable for last stroke)')
  }

  function refuseHistoryGap(detail = 'explicit acknowledgement required before further paint/export/switch'): BitmapPendingSessionEventResult {
    emitHistoryGapWarning()
    return { ok: false, kind: 'refused', reason: 'history-gap', detail }
  }

  function captureScope(): PendingCommitScope {
    return captureBitmapPendingScope(vm, slotId, slotIndex, extra)
  }

  function liveIdentity(): { assetId?: string | null; md5ext?: string | null; writeSeq?: number | null } | undefined {
    try {
      const fn = vm.getCostumeIdentity
      if (typeof fn !== 'function') return undefined
      const raw = (fn as (t: string, i: number) => unknown).call(vm, slotId, slotIndex) as Record<string, unknown> | null | undefined
      if (!raw || typeof raw !== 'object') return undefined
      const seqRaw = (raw as Record<string, unknown>).writeSeq
      return {
        assetId: typeof raw.assetId === 'string' ? (raw.assetId as string) : null,
        md5ext: typeof raw.md5ext === 'string' ? (raw.md5ext as string) : null,
        writeSeq: typeof seqRaw === 'number' && Number.isInteger(seqRaw) && seqRaw >= 0 ? seqRaw : null,
      }
    } catch {
      return undefined
    }
  }

  function readLiveScope(): PendingCommitScope {
    return captureScope()
  }

  function ownerCurrent(): boolean {
    if (!staged) return false
    try {
      return isPendingScopeCurrent(staged.scope, captureScope())
    } catch {
      return false
    }
  }

  function repaintOverlay(): boolean {
    if (!canvas || !staged) return false
    // Fail-first canvas ownership: the same DOM canvas element may now
    // belong to a reloaded project / switched target / costume. Verify the
    // full scope + generation + asset + selection tokens synchronously
    // immediately before touching pixels; on any mismatch or uncertainty
    // leave the live canvas alone (the reloader owns it) and report.
    if (!canTouchLiveCanvas(staged.scope, staged.base)) return false
    const presented = canvas.paintOverlay(staged.base, staged.shape)
    if (!presented) return false
    invalidate()
    return true
  }

  /**
   * Strict fail-first canvas ownership gate. Every `restoreBase` /
   * `paintOverlay` call site must pass through here synchronously immediately
   * before touching the live canvas. The captured `scope` (slot id + index +
   * asset key/id + writeSeq/editEpoch + loadSerial + sessionGeneration +
   * projectGeneration + structureSeq + selectionEpoch) must still equal the
   * live scope AND the live canvas geometry must still equal the captured
   * base geometry. Any mismatch, read failure, or uncertainty returns false
   * (do not touch; the reloader / switch owns the pixels). Never throws.
   */
  function canTouchLiveCanvas(scope: PendingCommitScope, base: { width: number; height: number }): boolean {
    try {
      if (!canvas) return false
      if (!scope || typeof scope.targetId !== 'string') return false
      let live: PendingCommitScope
      try {
        live = captureScope()
      } catch {
        return false
      }
      if (!live) return false
      if (live.targetId !== scope.targetId || live.costumeIndex !== scope.costumeIndex) return false
      if (live.loadSerial !== scope.loadSerial) return false
      if (live.sessionGeneration !== scope.sessionGeneration) return false
      if (live.projectGeneration !== scope.projectGeneration) return false
      if ((live.structureSeq ?? null) !== (scope.structureSeq ?? null)) return false
      if ((live.selectionEpoch ?? null) !== (scope.selectionEpoch ?? null)) return false
      if ((live.assetKey ?? '') !== (scope.assetKey ?? '')) return false
      if ((live.assetId ?? undefined) !== (scope.assetId ?? undefined)) return false
      const liveSeq = live.writeSeq ?? live.editEpoch ?? null
      const wantSeq = scope.writeSeq ?? scope.editEpoch ?? null
      if (liveSeq !== null && wantSeq !== null && liveSeq !== wantSeq) return false
      let size: { width: number; height: number } | undefined
      try {
        size = canvas.getCanvasSize()
      } catch {
        return false
      }
      if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)) return false
      if (size.width !== base.width || size.height !== base.height) return false
      if (base.width !== scopeBaseWidth(scope, base)) return false
      return true
    } catch {
      return false
    }
  }

  function scopeBaseWidth(_scope: PendingCommitScope, base: { width: number; height: number }): number {
    // Geometry anchor: the base itself is the anchor; this helper exists so
    // the size check reads explicitly (no silent coercion).
    return base.width
  }

  /** Guarded restore: touches the live canvas only when still owned. */
  function guardedRestoreBase(scope: PendingCommitScope, base: ImageData): boolean {
    if (!canTouchLiveCanvas(scope, base)) {
      status('live canvas left untouched (owner/generation/asset/selection changed or uncertain; reloader owns pixels)')
      return false
    }
    try {
      return canvas?.restoreBase(base) === true
    } catch {
      return false
    }
  }

  function historyGuardCurrent(): boolean | undefined {
    try {
      if (typeof history.isCurrent === 'function') return history.isCurrent() !== false
    } catch {
      return false
    }
    return undefined
  }

  function sameIdentity(
    a: { assetId?: string | null; md5ext?: string | null; writeSeq?: number | null } | undefined,
    b: { assetId?: string | null; md5ext?: string | null; writeSeq?: number | null } | undefined,
  ): boolean {
    if (!a || !b) return false
    return (
      (a.assetId ?? undefined) === (b.assetId ?? undefined) &&
      (a.md5ext ?? undefined) === (b.md5ext ?? undefined) &&
      (a.writeSeq ?? undefined) === (b.writeSeq ?? undefined)
    )
  }

  let quarantined: QuarantinedEntry | undefined

  function copyShapeImmutable(shape: PendingBitmapShape): PendingBitmapShape {
    try {
      const box = (shape as unknown as { box?: unknown }).box
      const style = (shape as unknown as { style?: unknown }).style
      if (typeof box !== 'object' || box === null || typeof style !== 'object' || style === null) return shape
      return {
        ...(shape as object),
        box: { ...(box as Record<string, unknown>) },
        style: { ...(style as Record<string, unknown>) },
      } as PendingBitmapShape
    } catch {
      return shape
    }
  }

  function cloneBaseImmutable(base: ImageData): ImageData | undefined {
    return cloneImageDataSizeOf(base)
  }

  function readLiveFormat(): string | null {
    try {
      const target = (vm as unknown as { getTarget?: (id: string) => { costumes?: { dataFormat?: unknown }[] } }).getTarget?.call(vm, slotId) as
        | { costumes?: { dataFormat?: unknown }[] }
        | undefined
      const format = target?.costumes?.[slotIndex]?.dataFormat
      return typeof format === 'string' ? format : null
    } catch {
      return null
    }
  }

  function quarantineViewOf(entry: QuarantinedEntry): BitmapPendingQuarantinedView {
    const shapeCopy = copyShapeImmutable(entry.shape)
    const baseCopy = cloneBaseImmutable(entry.base) ?? entry.base
    return { shape: shapeCopy, base: baseCopy, scope: { ...entry.scope }, reason: entry.reason, detail: entry.detail, format: entry.format ?? null }
  }

  function quarantineStatusText(reason: string): string {
    return `quarantined: ${reason}; staged shape+base preserved off-canvas (immutable), explicit user action required (exportQuarantinedPng/discardQuarantined); external write preserved, never auto-overwritten`
  }

  /**
   * Move the staged mirror into the bounded single quarantine synchronously
   * before the pending is dropped. Never repaints the old shape onto the
   * live (possibly new-owner) canvas. The pre-stroke base is restored ONLY
   * when the live canvas is still provably owned by the quarantined scope
   * (full scope + generation + asset + selection tokens re-read synchronously
   * immediately before the restore, plus geometry). After a reload / switch /
   * reorder / external write the live canvas is left byte-for-byte untouched
   * (the reloader owns it) with an explicit status. Never touches the VM.
   * Returns true when quarantined, false when the quarantine was already
   * full (originals retained, new input dropped).
   */
  function tryQuarantineStaged(reason: string, detail?: string, stagedBefore?: StagedMirror | undefined): boolean {
    const source = stagedBefore ?? staged
    if (!source) return false
    if (quarantined) {
      // Bounded memory: single quarantine. Refuse to overwrite; retain the
      // original quarantined entry. The caller drops the new staged mirror.
      status(`quarantine-full: retaining original quarantined ${quarantined.reason}; new ${reason} not overwriting`)
      return false
    }
    const shapeCopy = copyShapeImmutable(source.shape)
    const baseCopy = cloneBaseImmutable(source.base)
    if (!baseCopy) return false
    const scopeCopy = { ...source.scope }
    let format: string | null = null
    try {
      format = readLiveFormat()
    } catch {
      format = null
    }
    quarantined = { shape: shapeCopy, base: baseCopy, scope: scopeCopy, reason, detail, format }
    status(quarantineStatusText(reason))
    // Clear the live overlay ONLY when still owned: restore the exact
    // pre-stroke base so a reused slot id never shows the old overlay.
    // After a reload/switch/reorder/external write the live canvas already
    // belongs to the new owner (often DIFFERENT nonblank ink): restoring the
    // OLD base would corrupt visible art, so leave it untouched.
    try {
      if (!guardedRestoreBase(scopeCopy, source.base)) {
        status('quarantine kept off-canvas; live canvas left untouched (owner changed; reloader owns pixels)')
      }
    } catch {
      // Best effort only.
    }
    try {
      invalidate()
    } catch {
      // Best effort only.
    }
    return true
  }

  function forceClearTxPendingWithStagedScope(scope: PendingCommitScope): void {
    try {
      // The coordinator drops only on an exact owner match. Re-present the
      // staged scope to force-clear a pending left behind by an invalid live
      // scope (target delete) without touching pixels.
      tx.discardPending({ ...scope })
    } catch {
      // Best effort only.
    }
  }

  function shouldQuarantineReason(reason: unknown): boolean {
    return reason === 'owner-mismatch' || reason === 'external-conflict' || reason === 'superseded' || reason === 'aborted' || reason === 'invalid-scope'
  }

  function buildCommitWrite(): PendingCommitWrite {
    return async (taken: PendingCommitTaken, control): Promise<PendingCommitWriteResult> => {
      // Cross-slot guard: this session belongs to exactly one stable slot.
      if (taken.scope.targetId !== slotId || taken.scope.costumeIndex !== slotIndex) {
        return { ok: true, applied: false, reason: 'superseded' }
      }
      if (!canvas) return { ok: false, reason: 'missing-canvas' }
      // Rasterize the committed pixels (detached: the live canvas is already
      // showing the identical overlay, so no screen touch is needed here).
      const raster = canvas.rasterize(taken.base as unknown as ImageData, taken.shape)
      if (!raster) return { ok: false, reason: 'raster-failed' }
      let png: Uint8Array | undefined
      try {
        png = await canvas.encodePng(raster)
      } catch {
        return { ok: false, reason: 'encode-failed' }
      }
      if (!png || png.byteLength === 0) return { ok: false, reason: 'encode-failed' }
      // Peek the pre-commit history entry BEFORE the CAS (stored bytes for
      // Undo). The entry is committed only after `applied: true`, so failed
      // / conflicted / aborted writes add NO entry and a retry cannot
      // double-append: exactly one history entry per landed shape.
      //
      // SERIALIZABLE RESERVATION (fail-closed before any write): when the
      // history ports expose `beginReservation` / `isCurrent`, the reservation
      // is held across the encode/peek awaits and re-checked synchronously
      // immediately before the CAS. A stale reservation blocks the VM mutation
      // (`history-unavailable`, zero bytes touched) instead of landing
      // un-undoable art. Reentrant VM callbacks that fire during the awaits
      // therefore race the pre-write check, never the post-write append.
      let entry: E | undefined
      try {
        entry = await history.peek()
      } catch {
        return { ok: false, reason: 'history-unavailable' }
      }
      if (entry === undefined) return { ok: false, reason: 'history-unavailable' }
      let reservation: BitmapPendingHistoryReservation<E> | undefined
      if (typeof history.beginReservation === 'function') {
        try {
          reservation = history.beginReservation(entry) ?? undefined
        } catch {
          reservation = undefined
        }
        if (!reservation) return { ok: false, reason: 'history-unavailable' }
      }
      const cancelReservation = (): void => {
        try {
          reservation?.cancel?.()
        } catch {
          // Reservation release must never break the commit discipline.
        }
        reservation = undefined
      }
      // Pre-write revalidation (no VM mutation has happened yet): abort,
      // supersede, scope drift, and a stale history guard ALL block here.
      try {
        if (control.isAborted()) {
          cancelReservation()
          return { ok: true, applied: false, reason: 'superseded' }
        }
        if (!control.shouldCommit()) {
          cancelReservation()
          return { ok: true, applied: false, reason: 'superseded' }
        }
      } catch {
        cancelReservation()
        return { ok: true, applied: false, reason: 'superseded' }
      }
      try {
        const liveBefore = captureScope()
        // Pre-write slot check (delayed-CAS window): a deferred barrier may
        // park this flight between the take and the atomic mutation while a
        // direct external write lands on the same slot. Only the slot
        // generation (not the mutable asset bytes) must match — the bytes
        // legitimately advance on our own write, so `assetKey`/`editEpoch`
        // drift is expected and must NOT block here. A generation/target move
        // means an external owner wins: block BEFORE any VM mutation. Same
        // slot byte drift is decided atomically by the VM CAS itself (the
        // writer forwards the per-flight abort token + versioned `expected`,
        // re-verified after the `storeAsset` await), and again by the
        // post-write identity verification below — never by overwriting here.
        const slotMoved =
          liveBefore.targetId !== taken.scope.targetId ||
          liveBefore.costumeIndex !== taken.scope.costumeIndex ||
          liveBefore.loadSerial !== taken.scope.loadSerial ||
          liveBefore.sessionGeneration !== taken.scope.sessionGeneration ||
          liveBefore.projectGeneration !== taken.scope.projectGeneration
        if (slotMoved || !isPendingScopeCurrent(taken.scope, liveBefore)) {
          // Full scope equality covers the no-drift fast path; the slot check
          // above additionally tolerates nothing here (both must hold before
          // the write: any drift blocks, since our own write has not landed
          // yet, any drift is external).
          cancelReservation()
          return {
            ok: true,
            applied: false,
            reason: liveBefore.projectGeneration !== taken.scope.projectGeneration ? 'superseded' : 'conflict',
          }
        }
      } catch {
        cancelReservation()
        return { ok: false, reason: 'history-unavailable' }
      }
      const guardCurrent = historyGuardCurrent()
      if (guardCurrent === false) {
        cancelReservation()
        return { ok: false, reason: 'history-unavailable' }
      }
      if (reservation) {
        let reservationCurrent = true
        try {
          reservationCurrent = reservation.isCurrent() !== false
        } catch {
          reservationCurrent = false
        }
        if (!reservationCurrent) {
          cancelReservation()
          return { ok: false, reason: 'history-unavailable' }
        }
      }
      const vmWrite = createBitmapPendingVmWrite(vm, {
        targetId: slotId,
        costumeIndex: slotIndex,
        pngBytes: png,
        bitmapResolution: config.bitmapResolution,
        rotationCenterX: config.rotationCenterX,
        rotationCenterY: config.rotationCenterY,
        width: raster.width,
        height: raster.height,
      })
      let result: PendingCommitWriteResult
      try {
        result = (await vmWrite(taken, control)) as PendingCommitWriteResult
      } catch (error) {
        cancelReservation()
        return { ok: false, reason: error instanceof Error && error.message ? error.message : 'commit-rejected' }
      }
      const applied =
        result !== undefined &&
        typeof result === 'object' &&
        (result as { ok?: unknown }).ok === true &&
        (result as { applied?: unknown }).applied === true
      if (!applied) {
        // NOT landed (conflict / refuse / abort): never touch history, so a
        // retry cannot double-append and the external write is preserved.
        cancelReservation()
        return result
      }
      // LANDED (`applied: true`): the bytes are already in the store. NEVER
      // claim failure and NEVER reapply, even when the history append below
      // returns `false` or throws. The append runs synchronously here with no
      // await between the CAS resolve and this call, so a reentrant listener
      // can only race the pre-write check above, not this append. When the
      // append spuriously fails while the slot is still owned, the commit is
      // still reported as success (`committed` via the coordinator's own
      // identity verification) and the missing Undo entry is surfaced via the
      // `history-gap` status + snapshot flag instead of a ghost `history-stale`
      // refusal that would restore the pending and invite a double retry over
      // committed (or external) art.
      // Pre-append ownership gate (synchronous, no await since the CAS): when
      // an external mutation already invalidated the slot between the CAS
      // resolve and this line (reentrant VM listener), the history append is
      // SKIPPED so the external Undo entry is never buried under a stale
      // pre-write entry. The original VM success is still returned; the
      // coordinator's post-identity verification maps it to
      // `external-conflict` (external preserved, no restore, no reapply).
      const claimedOf = (value: unknown): { assetId?: string | null; md5ext?: string | null; writeSeq?: number | null } | undefined => {
        const record = (value as { newIdentity?: unknown }).newIdentity as
          | { assetId?: string | null; md5ext?: string | null; writeSeq?: number | null }
          | undefined
        return record && typeof record === 'object' ? record : undefined
      }
      const slotGenerationSame = (after: PendingCommitScope): boolean =>
        after.targetId === taken.scope.targetId &&
        after.costumeIndex === taken.scope.costumeIndex &&
        after.loadSerial === taken.scope.loadSerial &&
        after.sessionGeneration === taken.scope.sessionGeneration &&
        after.projectGeneration === taken.scope.projectGeneration
      // Pre-append ownership gate (applied-before-append window, synchronous
      // with no await since the CAS): a deferred barrier may park the CAS
      // result delivery while a direct external write lands on the same slot
      // AFTER our bytes applied but BEFORE this history append. The
      // stage-time `assetKey`/`editEpoch` legitimately advance on our OWN
      // write, so only the slot generation + the CAS identity are compared.
      // When an external mutation already invalidated the slot between the
      // CAS resolve and this line (reentrant VM listener, or a held result
      // gate), the append is SKIPPED so the external Undo entry is never
      // buried under a stale pre-write entry and no phantom history lands on
      // top of external art. The original VM success is still returned; the
      // coordinator's post-identity verification maps it to
      // `external-conflict` (external preserved, no restore, no reapply).
      try {
        const scopeAfter = captureScope()
        const liveAfter = liveIdentity()
        if (!slotGenerationSame(scopeAfter) || !sameIdentity(claimedOf(result), liveAfter)) {
          cancelReservation()
          status('history dropped after external write; external preserved')
          return result
        }
      } catch {
        // Identity read failure after a landed write: fail toward success
        // (never claim failure for landed bytes); attempt the append below
        // and let its outcome surface via the gap flag.
      }
      // Re-check the history reservation synchronously at the append point
      // (covers a history-side switch that landed after the pre-write check
      // but before the CAS, e.g. switched right at the VM notification): a
      // stale reservation skips the push instead of landing un-undoable art
      // silently — the gap flag records it explicitly.
      try {
        if (historyGuardCurrent() === false) {
          cancelReservation()
          historyGap = true
          status('history-gap: bytes committed without undo entry')
          return result
        }
        if (reservation && reservation.isCurrent() === false) {
          cancelReservation()
          historyGap = true
          status('history-gap: bytes committed without undo entry')
          return result
        }
      } catch {
        cancelReservation()
        historyGap = true
        status('history-gap: bytes committed without undo entry')
        return result
      }
      let landed = false
      try {
        landed = reservation ? reservation.commit() : history.commit(entry)
      } catch {
        landed = false
      }
      reservation = undefined
      if (!landed) {
        // Distinguish (for observability only) a stale-guard drop after an
        // external post-write mutation from a spurious backend failure. Both
        // paths return the ORIGINAL VM success: the coordinator re-verifies
        // `newIdentity` vs live and maps the latter to `external-conflict`
        // (external preserved, no restore) and the former to `committed`.
        // A reentrant external write DURING the synchronous commit above (a VM
        // callback mutating the store from inside `history.commit`) lands here
        // with `landed === true` already pushed — the post-append check below
        // rolls that stale entry back when the backend supports removal.
        let stillOwned = false
        try {
          const scopeAfter = captureScope()
          const liveAfter = liveIdentity()
          stillOwned = slotGenerationSame(scopeAfter) && sameIdentity(claimedOf(result), liveAfter)
        } catch {
          stillOwned = false
        }
        historyGap = historyGap || stillOwned
        status(stillOwned ? 'history-gap: bytes committed without undo entry' : 'history dropped after external write; external preserved')
      } else {
        // Post-append reentrant check: a VM callback that mutated the store
        // synchronously inside `history.commit()` (after the pre-append gate)
        // would leave our stale entry on top of the external write. Roll it
        // back when the backend supports removal; the coordinator still maps
        // the VM success to `external-conflict` via its own verification.
        try {
          const scopeAfter = captureScope()
          const liveAfter = liveIdentity()
          if (!slotGenerationSame(scopeAfter) || !sameIdentity(claimedOf(result), liveAfter)) {
            let removed = false
            try {
              if (typeof history.tryRemove === 'function') removed = history.tryRemove(entry) !== false
              else if (reservation === undefined && typeof (history as { removeLast?: (e: E) => boolean }).removeLast === 'function') {
                removed = (history as { removeLast?: (e: E) => boolean }).removeLast?.(entry) !== false
              }
            } catch {
              removed = false
            }
            status(removed ? 'history dropped after external write; external preserved' : 'history dropped after external write; external preserved')
          }
        } catch {
          // Observability only; the VM result below is authoritative.
        }
      }
      return result
    }
  }

  function commitOptions(): { readLive: () => PendingCommitScope; getLiveIdentity: () => { assetId?: string | null; md5ext?: string | null; writeSeq?: number | null } | undefined } {
    return { readLive: readLiveScope, getLiveIdentity: liveIdentity }
  }

  async function commitPending(): Promise<BitmapPendingSessionCommitResult> {
    if (!canvas) return { ok: false, kind: 'refused', reason: 'commit-rejected', detail: 'missing canvas ports' }
    // Fail-first gap gate: a retry with no pending stays `nothing-to-commit`
    // (never reapplied, gap preserved, warning kept). A commit with a pending
    // while gapped is refused (no duplicate bytes over committed art).
    if (historyGap) {
      try {
        if (tx.snapshot().hasPending || tx.snapshot().commitInFlight) {
          emitHistoryGapWarning()
          return { ok: false, kind: 'refused', reason: 'history-gap', detail: 'explicit acknowledgement required before further paint/export/switch' }
        }
      } catch {
        emitHistoryGapWarning()
        return { ok: false, kind: 'refused', reason: 'history-gap', detail: 'explicit acknowledgement required before further paint/export/switch' }
      }
    }
    // Bounded single quarantine: never implicitly discard an already-created
    // shape when capacity cannot be secured. If a quarantine is occupied and
    // a pending is staged, refuse BEFORE the take so both the quarantined
    // original and the staged pending are retained (explicit export/discard
    // required). No tx.take happens here, so nothing is dropped.
    try {
      const snapPre = tx.snapshot()
      if (quarantined && !snapPre.commitInFlight && (staged || snapPre.hasPending)) {
        status(`quarantine-full: commit refused before take while quarantined ${quarantined.reason}; both retained, exportQuarantinedPng/discardQuarantined required`)
        return { ok: false, kind: 'refused', reason: 'quarantine-full', detail: 'quarantine occupied; export or discard explicitly before commit' }
      }
    } catch {
      // Best effort only; fall through to the normal path.
    }
    // Capture the staged mirror synchronously BEFORE any await: async
    // encode/copy ownership stays with this copy even if the live slot,
    // target, or project switches mid-flight.
    let stagedBefore: StagedMirror | undefined
    try {
      if (staged) {
        const baseCopy = cloneImageDataSizeOf(staged.base)
        if (baseCopy) stagedBefore = { shape: copyShapeImmutable(staged.shape), base: baseCopy, scope: { ...staged.scope } }
        else stagedBefore = undefined
      }
    } catch {
      stagedBefore = undefined
    }
    const live = captureScope()
    const write = buildCommitWrite()
    const result = await tx.joinCommit(live, write, commitOptions())
    if (result.ok) {
      if (result.kind === 'committed') {
        staged = undefined
        draft = undefined
        invalidate()
        if (historyGap) {
          // This commit landed WITHOUT history: the sticky `history-gap`
          // warning emitted inside the write is already the last status.
          // NEVER overwrite it with `Bitmap shape committed`; expose the
          // distinct `committed-without-history` result instead.
          return { ok: true, kind: 'committed-without-history', historyGap: true }
        }
        status('Bitmap shape committed')
      } else if (result.kind === 'discarded') {
        staged = undefined
        invalidate()
      } else if (result.kind === 'nothing-to-commit') {
        staged = undefined
        // Keep a pre-existing gap sticky: no status overwrite, no clear.
      }
      return result
    }
    // Recoverable quarantine: on ownership loss (reject/superseded preview
    // owner — rename/metadata conflict, new-bytes conflict, abort,
    // target-delete, reload/project switch) move the taken/staged transaction
    // to the bounded single quarantine synchronously before the drop. Never
    // repaint the old shape onto the live (possibly wrong) canvas; never
    // overwrite the external write. The live canvas is intentionally left
    // showing the stale staged overlay on same-slot conflicts: the session
    // owns no asset bytes to repaint it with, so the Editor (which owns
    // `loadAsset`) performs the scoped rightful-owner reload after this
    // refusal settles (`reloadBitmapCanvasAfterPendingConflict`). The
    // quarantined base+shape stays immutable off-canvas for exact export.
    // Retained-for-retry failures (commit-failed/commit-rejected while still
    // owned) keep the pending and skip quarantine.
    try {
      const snap = tx.snapshot()
      const reason = (result as { reason?: unknown }).reason
      if (stagedBefore && shouldQuarantineReason(reason)) {
        if (snap.hasPending) {
          // Invalid-scope leaves the pending behind (target gone): force
          // clear via the staged scope, then quarantine. A newer stage
          // winning (different pending) means the old taken is obsolete:
          // keep the new pending, quarantine only when the slot is empty.
          if (reason === 'invalid-scope') {
            const scopeForClear = { ...stagedBefore.scope }
            forceClearTxPendingWithStagedScope(scopeForClear)
            const after = tx.snapshot()
            if (!after.hasPending) {
              if (quarantined) {
                status(`quarantine-full: retaining original quarantined ${quarantined.reason}; new ${String(reason)} staged input retained alongside (both kept, explicit action required)`)
                // Retain `staged` (do not clear): no silent discard when full.
              } else {
                tryQuarantineStaged(String(reason), (result as { detail?: unknown }).detail as string | undefined, stagedBefore)
                staged = undefined
                draft = undefined
              }
            } else {
              // A newer pending exists: keep it, do not overwrite quarantine
              // with the stale taken if quarantine is already full.
              if (!quarantined) {
                tryQuarantineStaged(String(reason), (result as { detail?: unknown }).detail as string | undefined, stagedBefore)
              }
              // Keep `staged` pointing at the live pending (do not clear).
            }
          } else {
            // Still-owned retain paths never reach here (different reasons).
            // A newer stage superseding the old taken: keep the new pending,
            // quarantine the old only when the quarantine is empty is wrong
            // (would hide the new pending). Drop the old taken without
            // quarantining when a newer pending is live.
          }
        } else {
          // Defensive: quarantine is bounded single. If it is already full,
          // NEVER silently drop the new staged input: retain `staged` (both
          // the quarantined original and the new staged mirror stay in
          // memory) and report quarantine-full. No overwrite, no hidden loss.
          if (quarantined) {
            status(`quarantine-full: retaining original quarantined ${quarantined.reason}; new ${String(reason)} staged input retained alongside (both kept, explicit action required)`)
            // Keep `staged`/`draft` as-is (do not clear): the new input is
            // explicitly retained, not dropped.
          } else {
            tryQuarantineStaged(String(reason), (result as { detail?: unknown }).detail as string | undefined, stagedBefore)
            staged = undefined
            draft = undefined
          }
        }
      } else {
        // Failed transition retains the pending where still owned: the coordinator
        // re-staged it; repaint the overlay from the retained base so the canvas
        // provably still shows exactly `base + shape` (single-pass, no double
        // composition) and the retry path starts from identical pixels.
        // When quarantined above, the base was already restored (no repaint).
        // Strict ownership: re-read the live scope synchronously immediately
        // before touching pixels; on any mismatch leave the live canvas
        // untouched (reloader owns it).
        const snap2 = tx.snapshot()
        if (snap2.hasPending && staged && !quarantined && canTouchLiveCanvas(staged.scope, staged.base)) {
          if (guardedRestoreBase(staged.scope, staged.base)) repaintOverlay()
        } else if (!snap2.hasPending && !quarantined) {
          staged = undefined
        } else if (!snap2.hasPending && quarantined) {
          staged = undefined
          draft = undefined
        }
      }
    } catch {
      // Best effort only; the refusal result below is authoritative.
    }
    // Explicit conflict status (never silent): quarantine already emitted its
    // `quarantined:` line; keep the refusal reason visible too without
    // overwriting the quarantine warning order (quarantine first, then this).
    if (quarantined && stagedBefore) {
      status(`Bitmap shape commit ${result.reason} (quarantined; external preserved)`)
    } else {
      status(`Bitmap shape commit ${result.reason}`)
    }
    return result
  }

  function stageNewShape(kind: BitmapShapeKind, box: { x: number; y: number; width: number; height: number }, mode: BitmapShapeMode, style: PendingBitmapShapeStyle, base: ImageData, draftScope?: PendingCommitScope): BitmapPendingSessionEventResult {
    if (historyGap) return refuseHistoryGap()
    // Bounded memory single quarantine: while a conflict is quarantined the
    // session refuses new stages and retains the originals (no overwrite, no
    // silent drop). The user must export/discard explicitly first.
    if (quarantined) {
      status(`quarantine-full: refusing new stage while quarantined ${quarantined.reason}; exportQuarantinedPng/discardQuarantined required`)
      // Fail-first: the incoming `base` may predate a reload/switch (draft
      // preview is ownership-gated, so the live canvas already belongs to the
      // new owner). Never restore a possibly-stale base onto it; leave the
      // live canvas untouched for the reloader.
      status('live canvas left untouched (quarantine-full; reloader owns pixels)')
      return { ok: false, kind: 'refused', reason: 'quarantine-full', detail: 'quarantine occupied; export or discard explicitly before new paint' }
    }
    if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
    const size = canvas.getCanvasSize()
    if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) {
      return { ok: false, kind: 'refused', reason: 'empty-canvas' }
    }
    if (base.width !== size.width || base.height !== size.height) {
      return { ok: false, kind: 'refused', reason: 'base-mismatch' }
    }
    // Fail-first draft ownership: `base` was captured at pointerDown. If the
    // project reloaded / target / costume switched mid-drag, the live scope
    // no longer equals the draft scope — refuse WITHOUT touching the live
    // canvas (it already carries the new owner's ink) and without staging.
    if (draftScope && !canTouchLiveCanvas(draftScope, base)) {
      status('live canvas left untouched (draft owner changed before stage; reloader owns pixels)')
      return { ok: false, kind: 'refused', reason: 'owner-mismatch', detail: 'draft base predates a reload/switch; live canvas untouched' }
    }
    const shape = createPendingBitmapShape(kind, box, mode, style)
    // Parametric + pixel gates BEFORE any slot mutation: invisible fills,
    // zero-brush outlines, empty boxes and refused canvases never stage (no
    // history, no render invalidation, draft base untouched).
    const verdict = resolvePendingBitmapShapePreview(shape, size)
    if (verdict.kind !== 'draw') {
      return verdict.kind === 'noop'
        ? { ok: true, kind: 'unchanged' }
        : { ok: false, kind: 'refused', reason: verdict.reason }
    }
    const scope = captureScope()
    const stagedResult = tx.stage(shape, { width: base.width, height: base.height, data: base.data }, scope)
    if (!stagedResult.ok) {
      return { ok: false, kind: 'refused', reason: stagedResult.reason }
    }
    const baseCopy = cloneImageDataSizeOf(base)
    if (!baseCopy) {
      tx.discardPending(scope)
      return { ok: false, kind: 'refused', reason: 'base-unreadable' }
    }
    staged = { shape, base: baseCopy, scope }
    if (!repaintOverlay()) {
      return { ok: false, kind: 'refused', reason: 'paint-failed' }
    }
    status(kind === 'rect' ? 'Bitmap rectangle staged' : 'Bitmap oval staged')
    return { ok: true, kind: 'staged' }
  }

  function restageCurrent(next: PendingBitmapShape): BitmapPendingSessionEventResult {
    if (historyGap) return refuseHistoryGap()
    if (!staged || !canvas) return { ok: false, kind: 'refused', reason: 'empty' }
    if (!ownerCurrent() || !canTouchLiveCanvas(staged.scope, staged.base)) return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
    const size = canvas.getCanvasSize()
    if (!size) return { ok: false, kind: 'refused', reason: 'empty-canvas' }
    const verdict = resolvePendingBitmapShapePreview(next, size)
    if (verdict.kind !== 'draw') {
      return verdict.kind === 'noop'
        ? { ok: true, kind: 'unchanged' }
        : { ok: false, kind: 'refused', reason: verdict.reason }
    }
    const stagedResult = tx.stage(next, { width: staged.base.width, height: staged.base.height, data: staged.base.data }, staged.scope)
    if (!stagedResult.ok) {
      return { ok: false, kind: 'refused', reason: stagedResult.reason }
    }
    staged = { shape: next, base: staged.base, scope: staged.scope }
    if (!repaintOverlay()) {
      return { ok: false, kind: 'refused', reason: 'paint-failed' }
    }
    return { ok: true, kind: 'updated' }
  }

  return {
    tx,

    configure(next: BitmapPendingSessionConfig): void {
      config = { ...config, ...next }
    },

    async pointerDown(at, kind, mode, style): Promise<BitmapPendingSessionEventResult> {
      if (!isPoint(at)) return { ok: false, kind: 'refused', reason: 'bad-input' }
      if (kind !== 'rect' && kind !== 'oval') return { ok: false, kind: 'refused', reason: 'bad-input' }
      if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
      // Fail-first gap gate: no new paint until the user acknowledges the
      // landed-without-history stroke. Never silently continue past the gap.
      if (historyGap) return refuseHistoryGap()
      // Blank-press commit-first (reference row 8): a settled pending shape
      // commits before the new drag starts, so two shapes never share one
      // base and the new draft starts from the committed canvas.
      try {
        if (tx.snapshot().hasPending || tx.snapshot().commitInFlight) {
          const done = await commitPending()
          if (!done.ok) return { ok: false, kind: 'refused', reason: done.reason, detail: done.detail }
          // A blank-press commit that lands WITHOUT history must NOT start a
          // new draft: the gap warning stays last and the caller must
          // acknowledge before further paint.
          if (historyGap || done.kind === 'committed-without-history') return refuseHistoryGap()
        }
      } catch (error) {
        return { ok: false, kind: 'refused', reason: 'commit-rejected', detail: error instanceof Error ? error.message : undefined }
      }
      if (historyGap) return refuseHistoryGap()
      const base = canvas.captureBase()
      if (!base) return { ok: false, kind: 'refused', reason: 'base-unreadable' }
      let draftScope: PendingCommitScope
      try {
        draftScope = captureScope()
      } catch {
        return { ok: false, kind: 'refused', reason: 'base-unreadable' }
      }
      draft = { kind, start: { ...at }, current: { ...at }, modifiers: {}, mode, style: { ...style }, base, scope: draftScope }
      return { ok: true, kind: 'unchanged' }
    },

    pointerMove(at, modifiers = {}): BitmapPendingSessionEventResult {
      if (!draft || !canvas) return { ok: true, kind: 'unchanged' }
      if (!isPoint(at)) return { ok: false, kind: 'refused', reason: 'bad-input' }
      // Fail-first: the same DOM canvas may now belong to a reloaded project
      // or switched slot. Re-read ownership synchronously before any paint;
      // on mismatch leave the live canvas untouched and keep the draft.
      if (!canTouchLiveCanvas(draft.scope, draft.base)) {
        status('live canvas left untouched (draft owner changed or uncertain; reloader owns pixels)')
        return { ok: false, kind: 'refused', reason: 'owner-mismatch', detail: 'live canvas owner changed during draft; reloader owns pixels' }
      }
      draft.current = { ...at }
      draft.modifiers = { ...modifiers }
      // Draft preview (history-free): render the in-progress box from the
      // draft base. A tiny/noop draft restores the base instead of painting.
      const box = resolveShapeRect(draft.start, draft.current, draft.modifiers)
      const size = canvas.getCanvasSize()
      if (!size) return { ok: false, kind: 'refused', reason: 'empty-canvas' }
      const shape = createPendingBitmapShape(draft.kind, box, draft.mode, draft.style)
      const verdict = resolvePendingBitmapShapePreview(shape, size)
      if (verdict.kind !== 'draw') {
        if (guardedRestoreBase(draft.scope, draft.base)) invalidate()
        return { ok: true, kind: 'unchanged' }
      }
      // Re-check immediately before the paint (no await above, but guard
      // explicitly for the paint itself; same-DOM-canvas never implies owner).
      if (!canTouchLiveCanvas(draft.scope, draft.base)) {
        status('live canvas left untouched (draft owner changed or uncertain; reloader owns pixels)')
        return { ok: false, kind: 'refused', reason: 'owner-mismatch', detail: 'live canvas owner changed during draft; reloader owns pixels' }
      }
      if (!canvas.paintOverlay(draft.base, shape)) return { ok: false, kind: 'refused', reason: 'paint-failed' }
      invalidate()
      return { ok: true, kind: 'updated' }
    },

    async pointerUp(at, modifiers = {}): Promise<BitmapPendingSessionEventResult> {
      if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
      if (!draft) return { ok: true, kind: 'nothing-pending' }
      if (historyGap) {
        // A draft can only exist here if it started before the gap (the
        // blank-press gate blocks new drafts while gapped). Drop it without
        // touching committed art and keep the warning sticky. Only restore
        // when the live canvas is still provably the draft owner; otherwise
        // leave it untouched.
        const base = draft.base
        const scope = draft.scope
        draft = undefined
        try {
          guardedRestoreBase(scope, base)
        } catch {
          // Best effort only.
        }
        return refuseHistoryGap()
      }
      if (!isPoint(at)) {
        draft = undefined
        return { ok: false, kind: 'refused', reason: 'bad-input' }
      }
      const finished: DraftStroke = {
        ...draft,
        current: { ...at },
        modifiers: { ...modifiers },
        base: draft.base,
        style: { ...draft.style },
        scope: draft.scope,
      }
      draft = undefined
      const box = resolveShapeRect(finished.start, finished.current, finished.modifiers)
      // Tiny-shape gate (reference parity): clicks / jitter / zero-area drags
      // stay history-free with no selection and no render invalidation. The
      // draft base is restored so the draft preview (if any) leaves no trace.
      const k = bitmapPaperPerCanvasPx(config.storedResolution)
      const zoom = bitmapShapePaperZoom(config.viewportScale ?? 1, config.storedResolution)
      if (isTinyShapeBox(box.width * k, box.height * k, zoom)) {
        guardedRestoreBase(finished.scope, finished.base)
        return { ok: true, kind: 'unchanged' }
      }
      return stageNewShape(finished.kind, box, finished.mode, finished.style, finished.base, finished.scope)
    },

    cancelDraft(): BitmapPendingSessionEventResult {
      // Draft-only cancel (pointercancel / lostpointercapture parity): the
      // settled pending slot is NEVER cleared here. Restore only when the
      // live canvas is still provably the draft owner; otherwise leave it
      // untouched (reloader owns pixels).
      if (!draft) return { ok: true, kind: 'nothing-pending' }
      const base = draft.base
      const scope = draft.scope
      draft = undefined
      if (canvas) guardedRestoreBase(scope, base)
      return { ok: true, kind: 'unchanged' }
    },

    restyle(style, mode): BitmapPendingSessionEventResult {
      if (historyGap) return refuseHistoryGap()
      if (!staged || !tx.snapshot().hasPending) return { ok: false, kind: 'refused', reason: 'empty' }
      if (!ownerCurrent() || !canTouchLiveCanvas(staged.scope, staged.base)) return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
      const { pending, changed } = restylePendingBitmapShape(staged.shape, style, mode)
      // Same-value fast path: the helper returns the SAME object, so the
      // session skips the re-render AND the render invalidation (and writes
      // no history either way).
      if (!changed) return { ok: true, kind: 'unchanged' }
      return restageCurrent(pending)
    },

    moveBy(dx, dy): BitmapPendingSessionEventResult {
      if (historyGap) return refuseHistoryGap()
      if (!staged || !tx.snapshot().hasPending) return { ok: false, kind: 'refused', reason: 'empty' }
      if (!ownerCurrent() || !canTouchLiveCanvas(staged.scope, staged.base)) return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
      if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
      const size = canvas.getCanvasSize()
      if (!size) return { ok: false, kind: 'refused', reason: 'empty-canvas' }
      const next = movePendingBitmapShape(staged.shape, dx, dy, size)
      if (next === staged.shape) return { ok: true, kind: 'unchanged' }
      return restageCurrent(next)
    },

    retarget(box): BitmapPendingSessionEventResult {
      if (historyGap) return refuseHistoryGap()
      if (!staged || !tx.snapshot().hasPending) return { ok: false, kind: 'refused', reason: 'empty' }
      if (!ownerCurrent() || !canTouchLiveCanvas(staged.scope, staged.base)) return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
      if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
      const size = canvas.getCanvasSize()
      if (!size) return { ok: false, kind: 'refused', reason: 'empty-canvas' }
      const { pending, changed } = retargetPendingBitmapShape(staged.shape, box, size)
      if (!changed) return { ok: true, kind: 'unchanged' }
      return restageCurrent(pending)
    },

    rotate90(direction): BitmapPendingSessionEventResult {
      if (historyGap) return refuseHistoryGap()
      if (!staged || !tx.snapshot().hasPending) return { ok: false, kind: 'refused', reason: 'empty' }
      if (!ownerCurrent() || !canTouchLiveCanvas(staged.scope, staged.base)) return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
      if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
      const size = canvas.getCanvasSize()
      if (!size) return { ok: false, kind: 'refused', reason: 'empty-canvas' }
      const { pending, changed } = rotatePendingBitmapShape(staged.shape, direction, size)
      if (!changed) return { ok: true, kind: 'unchanged' }
      return restageCurrent(pending)
    },

    rotateTo(rotationDegrees: number): BitmapPendingSessionEventResult {
      if (historyGap) return refuseHistoryGap()
      if (!staged || !tx.snapshot().hasPending) return { ok: false, kind: 'refused', reason: 'empty' }
      if (!ownerCurrent() || !canTouchLiveCanvas(staged.scope, staged.base)) return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
      if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
      const size = canvas.getCanvasSize()
      if (!size) return { ok: false, kind: 'refused', reason: 'empty-canvas' }
      const { pending, changed } = rotatePendingBitmapShapeTo(staged.shape, rotationDegrees, size)
      if (!changed) return { ok: true, kind: 'unchanged' }
      return restageCurrent(pending)
    },

    rotateBy(deltaDegrees: number): BitmapPendingSessionEventResult {
      if (historyGap) return refuseHistoryGap()
      if (!staged || !tx.snapshot().hasPending) return { ok: false, kind: 'refused', reason: 'empty' }
      if (!ownerCurrent() || !canTouchLiveCanvas(staged.scope, staged.base)) return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
      if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
      const size = canvas.getCanvasSize()
      if (!size) return { ok: false, kind: 'refused', reason: 'empty-canvas' }
      const { pending, changed } = rotatePendingBitmapShapeBy(staged.shape, deltaDegrees, size)
      if (!changed) return { ok: true, kind: 'unchanged' }
      return restageCurrent(pending)
    },

    stageAffine(matrix): BitmapPendingSessionEventResult {
      if (historyGap) return refuseHistoryGap()
      if (!staged || !tx.snapshot().hasPending) return { ok: false, kind: 'refused', reason: 'empty' }
      if (!ownerCurrent() || !canTouchLiveCanvas(staged.scope, staged.base)) return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
      if (!canvas) return { ok: false, kind: 'refused', reason: 'missing-canvas' }
      const size = canvas.getCanvasSize()
      if (!size) return { ok: false, kind: 'refused', reason: 'empty-canvas' }
      const { pending, changed } = withPendingAffine(staged.shape, matrix)
      if (!changed) return { ok: true, kind: 'unchanged' }
      return restageCurrent(pending)
    },

    commitPending,

    async runCommand<T>(command: BitmapPendingUiCommand | string, runOp: BitmapPendingUiOp<T>, guard?: BitmapPendingContinuationCheck): Promise<BitmapPendingPreflightResult<T>> {
      if (!canvas) {
        return { ok: false, kind: 'refused', policy: 'commit-first', reason: 'commit-rejected', commit: undefined, detail: 'missing canvas ports' }
      }
      // Fail-first gap gate: no automatic continuation past the gap. The op
      // (switch/export/...) must NOT run until the user acknowledges; the
      // warning stays last.
      if (historyGap) {
        emitHistoryGapWarning()
        return { ok: false, kind: 'refused', policy: 'commit-first', reason: 'history-gap', commit: undefined, detail: 'explicit acknowledgement required before further paint/export/switch' }
      }
      try {
        const snapPre = tx.snapshot()
        if (quarantined && !snapPre.commitInFlight && (staged || snapPre.hasPending)) {
          status(`quarantine-full: command ${String(command)} refused before take while quarantined ${quarantined.reason}; both retained`)
          return { ok: false, kind: 'refused', policy: 'commit-first', reason: 'quarantine-full', commit: undefined, detail: 'quarantine occupied; export or discard explicitly before commit' } as unknown as BitmapPendingPreflightResult<T>
        }
      } catch {
        // Best effort only; fall through.
      }
      let stagedBeforeOp: StagedMirror | undefined
      try {
        if (staged) {
          const baseCopy = cloneImageDataSizeOf(staged.base)
          if (baseCopy) stagedBeforeOp = { shape: copyShapeImmutable(staged.shape), base: baseCopy, scope: { ...staged.scope } }
        }
      } catch {
        stagedBeforeOp = undefined
      }
      const live = captureScope()
      const write: PendingCommitWrite = buildCommitWrite()
      const continuation = guard ?? createBitmapPendingContinuationGuard(vm)
      const options = { ...commitOptions(), isContinuationCurrent: continuation }
      // Suppress the continuation op when THIS commit lands without history.
      // `joinCommit` reports the write as success (`applied: true`), so the
      // preflight gate would otherwise run the op (ghost switch/export) after
      // the gap flag is set synchronously inside the write. The wrapper runs
      // synchronously at op entry — before any real UI side effect — and
      // aborts with a gap marker the session maps to a `history-gap` refusal
      // (commit preserved as `committed-without-history`, warning sticky).
      // This prevents the ghost op for this call; the entry gate above
      // prevents every FUTURE op until acknowledgement.
      const HISTORY_GAP_OP_ABORT = 'history-gap-op-suppressed'
      const wrappedOp: BitmapPendingUiOp<T> = ((control) => {
        if (historyGap) {
          throw new Error(HISTORY_GAP_OP_ABORT)
        }
        return (runOp as BitmapPendingUiOp<T>)(control)
      }) as BitmapPendingUiOp<T>
      let result: BitmapPendingPreflightResult<T>
      try {
        result = await runBitmapPendingUiOp<T>(tx, command, live, write, wrappedOp, options)
      } catch (error) {
        if (error instanceof Error && error.message === HISTORY_GAP_OP_ABORT && historyGap) {
          staged = undefined
          draft = undefined
          try {
            invalidate()
          } catch {
            // Best effort only.
          }
          // No ghost op ran (the wrapper threw before delegating). Report
          // the landed bytes distinctly; the warning from the write is
          // already last — re-emit to guarantee stickiness.
          emitHistoryGapWarning()
          return { ok: false, kind: 'refused', policy: 'commit-first', reason: 'history-gap', commit: { ok: true, kind: 'committed' }, detail: 'bytes committed without undo entry; continuation suppressed, explicit acknowledgement required' } as unknown as BitmapPendingPreflightResult<T>
        }
        throw error
      }
      // A commit inside this gate that lands WITHOUT history but whose op
      // was refused for another reason (e.g. stale continuation): keep the
      // gap warning last. The pending slot is already empty (single-shot
      // take); just clear mirrors and invalidate for selection refresh.
      if (historyGap) {
        staged = undefined
        draft = undefined
        try {
          invalidate()
        } catch {
          // Best effort only.
        }
        emitHistoryGapWarning()
        if (result.ok) {
          // Defensive: the wrapper above suppresses `proceeded` past a gap,
          // so reaching here with `ok` means no gap was set during the write.
          // If the flag is set anyway (reentrant path), remap rather than
          // claim a clean proceed.
          return { ok: false, kind: 'refused', policy: 'commit-first', reason: 'history-gap', commit: { ok: true, kind: 'committed' }, detail: 'bytes committed without undo entry; continuation suppressed, explicit acknowledgement required' } as unknown as BitmapPendingPreflightResult<T>
        }
        return result
      }
      if (result.ok) {
        if (result.commit !== undefined && result.commit.ok && result.commit.kind === 'committed') {
          staged = undefined
          draft = undefined
          invalidate()
          if (historyGap) {
            // Defensive: same sticky rule as `commitPending` (normally
            // handled by the gap branch above).
            return result
          }
          status('Bitmap shape committed')
        } else if (result.commit !== undefined && result.commit.ok) {
          if (result.commit.kind !== 'nothing-to-commit') invalidate()
          if (tx.snapshot().hasPending === false) staged = undefined
        }
      } else {
        // A history-gap refusal from the entry gate or from the suppressed-op
        // branch above already emitted the sticky warning; do not overwrite
        // it with a generic refused line.
        if ((result as { reason?: unknown }).reason === 'history-gap') {
          try {
            const snap = tx.snapshot()
            if (snap.hasPending && staged && !quarantined && canTouchLiveCanvas(staged.scope, staged.base)) {
              if (guardedRestoreBase(staged.scope, staged.base)) repaintOverlay()
            } else if (!snap.hasPending) {
              staged = undefined
            }
          } catch {
            // Best effort only.
          }
          emitHistoryGapWarning()
          return result
        }
        // Quarantine on ownership loss (same rule as commitPending): move the
        // staged mirror off-canvas before the drop, never repaint, never
        // overwrite the external write. Retained-for-retry stays untouched.
        let quarantinedHere = false
        try {
          const snap = tx.snapshot()
          const commitReason = (result as { commit?: { reason?: unknown } }).commit !== undefined && !(result as { commit?: { ok?: unknown } }).commit
            ? undefined
            : (result as { commit?: { reason?: unknown; ok?: unknown } }).commit !== undefined && !((result as { commit?: { ok?: unknown } }).commit as { ok?: unknown }).ok
              ? ((result as { commit?: { reason?: unknown } }).commit as { reason?: unknown }).reason
              : (result as { reason?: unknown }).reason
          const qReason = typeof commitReason === 'string' ? commitReason : String((result as { reason?: unknown }).reason ?? 'conflict')
          const qDetail = (result as { detail?: unknown }).detail as string | undefined
          if (stagedBeforeOp && shouldQuarantineReason(commitReason ?? (result as { reason?: unknown }).reason)) {
            if (snap.hasPending) {
              if ((commitReason ?? (result as { reason?: unknown }).reason) === 'invalid-scope') {
                if (quarantined) {
                  status(`quarantine-full: retaining original quarantined ${quarantined.reason}; new staged input retained alongside (both kept)`)
                } else {
                  forceClearTxPendingWithStagedScope({ ...stagedBeforeOp.scope })
                  const after = tx.snapshot()
                  if (!after.hasPending) {
                    quarantinedHere = tryQuarantineStaged(qReason, qDetail, stagedBeforeOp)
                    staged = undefined
                    draft = undefined
                  }
                }
              }
            } else {
              if (quarantined) {
                status(`quarantine-full: retaining original quarantined ${quarantined.reason}; new staged input retained alongside (both kept)`)
              } else {
                quarantinedHere = tryQuarantineStaged(qReason, qDetail, stagedBeforeOp)
                staged = undefined
                draft = undefined
              }
            }
          }
          if (!quarantinedHere) {
            const snap2 = tx.snapshot()
            if (snap2.hasPending && staged && !quarantined && canTouchLiveCanvas(staged.scope, staged.base)) {
              if (guardedRestoreBase(staged.scope, staged.base)) repaintOverlay()
            } else if (!snap2.hasPending && !quarantined) {
              staged = undefined
            } else if (!snap2.hasPending && quarantined) {
              staged = undefined
              draft = undefined
            }
          }
        } catch {
          // Best effort only; the refusal result is authoritative.
        }
        if (quarantinedHere || quarantined) status(`Bitmap command ${String(command)} refused: ${result.reason} (quarantined; external preserved)`)
        else status(`Bitmap command ${String(command)} refused: ${result.reason}`)
      }
      return result
    },

    discardForDeleteOrUndo(): BitmapPendingSessionEventResult {
      if (!staged || !tx.snapshot().hasPending) return { ok: true, kind: 'nothing-pending' }
      const live = captureScope()
      const stagedScope = { ...staged.scope }
      const stagedBase = staged.base
      const discarded = tx.discardPending(live)
      if (!discarded.ok) {
        return { ok: false, kind: 'refused', reason: discarded.reason }
      }
      // Restore the pre-stroke base ONLY when still owned (the transaction
      // only drops the slot; pixels are the session's injected-canvas duty).
      // Re-read ownership synchronously immediately before touching pixels;
      // on any mismatch leave the live canvas untouched.
      if (canvas) guardedRestoreBase(stagedScope, stagedBase)
      staged = undefined
      draft = undefined
      invalidate()
      status('Bitmap shape discarded')
      return { ok: true, kind: 'discarded' }
    },

    abortInFlight(reason = 'aborted'): { ok: true; kind: 'aborted' | 'nothing-in-flight' } {
      return tx.abortInFlight(reason)
    },

    acknowledgeHistoryGap(note?: string): { ok: true; acknowledged: boolean; historyGap: boolean } {
      if (!historyGap) return { ok: true, acknowledged: false, historyGap: false }
      historyGap = false
      const suffix = typeof note === 'string' && note.length > 0 ? ` (${note})` : ''
      status(`history gap acknowledged by user${suffix} — undo unavailable for last stroke; export re-reads committed bytes, never re-commits`)
      return { ok: true, acknowledged: true, historyGap: false }
    },

    snapshot(): BitmapPendingSessionSnapshot {
      const snap = tx.snapshot()
      let depth = 0
      try {
        depth = history.depth()
      } catch {
        depth = 0
      }
      const q = quarantined ? quarantineViewOf(quarantined) : undefined
      return {
        hasPending: snap.hasPending,
        commitInFlight: snap.commitInFlight,
        renderRev,
        historyDepth: depth,
        quarantined: q,
        quarantine: q,
        pendingKind: staged?.shape.kind,
        pendingMode: staged?.shape.mode,
        historyGap,
      }
    },

    getRenderRev(): number {
      return renderRev
    },

    getPendingShape(): PendingBitmapShape | undefined {
      return staged?.shape
    },

    getQuarantined(): BitmapPendingQuarantinedView | undefined {
      return quarantined ? quarantineViewOf(quarantined) : undefined
    },

    getQuarantine(): BitmapPendingQuarantinedView | undefined {
      return quarantined ? quarantineViewOf(quarantined) : undefined
    },

    getConflicted(): BitmapPendingQuarantinedView | undefined {
      return quarantined ? quarantineViewOf(quarantined) : undefined
    },

    getPreservedPending(): BitmapPendingQuarantinedView | undefined {
      return quarantined ? quarantineViewOf(quarantined) : undefined
    },

    async exportQuarantinedPng(): Promise<Uint8Array | undefined> {
      if (!quarantined || !canvas) return undefined
      try {
        // Detached reconstruct: original base + shape, zero VM writes.
        // Ownership-protected copies so async encode cannot leak across
        // assets and a target/project switch mid-await cannot corrupt the
        // quarantined originals. Failures are retryable (never cleared).
        const baseCopy = cloneBaseImmutable(quarantined.base)
        const shapeCopy = copyShapeImmutable(quarantined.shape)
        if (!baseCopy) return undefined
        const raster = canvas.rasterize(baseCopy, shapeCopy)
        if (!raster) return undefined
        let png: Uint8Array | undefined
        try {
          png = await canvas.encodePng(raster)
        } catch {
          return undefined
        }
        if (!png || png.byteLength === 0) return undefined
        return new Uint8Array(png)
      } catch {
        return undefined
      }
    },

    async exportPreservedPng(): Promise<Uint8Array | undefined> {
      if (!quarantined || !canvas) return undefined
      try {
        const baseCopy = cloneBaseImmutable(quarantined.base)
        const shapeCopy = copyShapeImmutable(quarantined.shape)
        if (!baseCopy) return undefined
        const raster = canvas.rasterize(baseCopy, shapeCopy)
        if (!raster) return undefined
        const png = await canvas.encodePng(raster)
        if (!png || png.byteLength === 0) return undefined
        return new Uint8Array(png)
      } catch {
        return undefined
      }
    },

    async exportConflictedPng(): Promise<Uint8Array | undefined> {
      if (!quarantined || !canvas) return undefined
      try {
        const baseCopy = cloneBaseImmutable(quarantined.base)
        const shapeCopy = copyShapeImmutable(quarantined.shape)
        if (!baseCopy) return undefined
        const raster = canvas.rasterize(baseCopy, shapeCopy)
        if (!raster) return undefined
        const png = await canvas.encodePng(raster)
        if (!png || png.byteLength === 0) return undefined
        return new Uint8Array(png)
      } catch {
        return undefined
      }
    },

    rebaseQuarantinedAfterMetadataRename(): unknown {
      if (!quarantined) return { ok: false, kind: 'refused', reason: 'empty', detail: 'no quarantined pending' }
      try {
        const liveScope = captureScope()
        const liveId = liveIdentity()
        const qScope = quarantined.scope
        // Exact owner/generation/structure: same slot, same workspace and
        // session generations, same project generation, same structure.
        if (
          liveScope.targetId !== qScope.targetId ||
          liveScope.costumeIndex !== qScope.costumeIndex ||
          liveScope.loadSerial !== qScope.loadSerial ||
          liveScope.sessionGeneration !== qScope.sessionGeneration ||
          liveScope.projectGeneration !== qScope.projectGeneration
        ) {
          return { ok: false, kind: 'refused', reason: 'mismatch', detail: 'generation/slot moved; rebase refused, external preserved' }
        }
        if (
          (liveScope.structureSeq ?? null) !== (qScope.structureSeq ?? null) ||
          (liveScope.selectionEpoch ?? null) !== (qScope.selectionEpoch ?? null)
        ) {
          // Structure/selection moved: not metadata-only.
          return { ok: false, kind: 'refused', reason: 'mismatch', detail: 'structure/selection moved; rebase refused' }
        }
        // Exact original asset bytes: md5/assetId unchanged (rename keeps
        // bytes). New bytes fail here; external is never overwritten.
        const liveAsset = liveId?.assetId ?? liveScope.assetId ?? null
        const liveMd5 = liveId?.md5ext ?? liveScope.assetKey ?? ''
        const qAsset = qScope.assetId ?? null
        const qMd5 = qScope.assetKey ?? ''
        if ((liveAsset ?? undefined) !== (qAsset ?? undefined) || liveMd5 !== qMd5) {
          return { ok: false, kind: 'refused', reason: 'new-bytes', detail: 'stored bytes changed; rebase refused, external preserved' }
        }
        // Geometry/format: base dimensions match the live canvas and the
        // stored format is unchanged.
        try {
          const size = canvas?.getCanvasSize()
          if (size && (quarantined.base.width !== size.width || quarantined.base.height !== size.height)) {
            return { ok: false, kind: 'refused', reason: 'mismatch', detail: 'geometry changed; rebase refused' }
          }
        } catch {
          return { ok: false, kind: 'refused', reason: 'mismatch', detail: 'geometry read failed' }
        }
        const liveFormat = readLiveFormat()
        if (quarantined.format !== undefined && quarantined.format !== null && liveFormat !== undefined && liveFormat !== null && liveFormat !== quarantined.format) {
          return { ok: false, kind: 'refused', reason: 'new-bytes', detail: 'data format changed; rebase refused' }
        }
        // Independently verified: adopt the live version (seq bump from the
        // metadata rename) while keeping shape+base immutable. No VM write,
        // no external overwrite; explicit user action only.
        quarantined.scope = { ...liveScope }
        status('quarantined rebased after metadata rename (bytes/geometry/generation verified); external preserved, no overwrite')
        return { ok: true, kind: 'rebased', scope: { ...liveScope } }
      } catch (error) {
        return { ok: false, kind: 'refused', reason: 'mismatch', detail: error instanceof Error ? error.message : String(error) }
      }
    },

    rebaseQuarantine(): unknown {
      const self = this as unknown as { rebaseQuarantinedAfterMetadataRename: () => unknown }
      return self.rebaseQuarantinedAfterMetadataRename()
    },

    adoptExternalRename(): unknown {
      const self = this as unknown as { rebaseQuarantinedAfterMetadataRename: () => unknown }
      return self.rebaseQuarantinedAfterMetadataRename()
    },

    discardQuarantined(): { ok: true; kind: 'discarded' | 'nothing-pending' } {
      if (!quarantined) return { ok: true, kind: 'nothing-pending' }
      quarantined = undefined
      try {
        invalidate()
      } catch {
        // Best effort only.
      }
      status('quarantined discarded by explicit user action')
      return { ok: true, kind: 'discarded' }
    },

    quarantineStagedOffCanvas(reason = 'recovery-retained', detail?: string): { ok: true; kind: 'quarantined' | 'nothing-pending' } | { ok: false; kind: 'refused'; reason: string; detail?: string } {
      try {
        // Bounded single quarantine: never overwrite an occupied quarantine.
        if (quarantined) {
          status(`quarantine-full: retaining original quarantined ${quarantined.reason}; new ${reason} staged input retained alongside (both kept, explicit action required)`)
          return { ok: false, kind: 'refused', reason: 'quarantine-full', detail: 'quarantine occupied; export or discard explicitly first' }
        }
        const snap = tx.snapshot()
        // A commit in flight owns the staged copy until it settles: never
        // disturb it here (the flight's own fail-closed path quarantines or
        // retains conservatively on its own).
        if (snap.commitInFlight) {
          return { ok: false, kind: 'refused', reason: 'commit-in-flight', detail: 'commit in flight; retry after it settles' }
        }
        if (!staged || !snap.hasPending) return { ok: true, kind: 'nothing-pending' }
        const shapeCopy = copyShapeImmutable(staged.shape)
        const baseCopy = cloneBaseImmutable(staged.base)
        if (!baseCopy) return { ok: false, kind: 'refused', reason: 'base-unreadable' }
        let format: string | null = null
        try {
          format = readLiveFormat()
        } catch {
          format = null
        }
        quarantined = { shape: shapeCopy, base: baseCopy, scope: { ...staged.scope }, reason, detail, format }
        // Drop the transaction pending WITHOUT pixels: the coordinator is
        // pixel-free, and the live canvas is never touched here (the reloader
        // owns it after a slot change; restoring the old base could corrupt
        // the new owner's visible art). The VM and history are never written.
        try {
          tx.discardPending({ ...staged.scope })
        } catch {
          // Best effort only: the mirrors below are authoritative.
        }
        staged = undefined
        draft = undefined
        try {
          invalidate()
        } catch {
          // Best effort only.
        }
        status(quarantineStatusText(reason))
        status('quarantine kept off-canvas; live canvas left untouched (reloader owns pixels)')
        return { ok: true, kind: 'quarantined' }
      } catch (error) {
        return { ok: false, kind: 'refused', reason: 'commit-rejected', detail: error instanceof Error ? error.message : String(error) }
      }
    },

    discardQuarantine(): { ok: true; kind: 'discarded' | 'nothing-pending' } {
      if (!quarantined) return { ok: true, kind: 'nothing-pending' }
      quarantined = undefined
      try {
        invalidate()
      } catch {
        // Best effort only.
      }
      status('quarantined discarded by explicit user action')
      return { ok: true, kind: 'discarded' }
    },

    clearQuarantine(): { ok: true; kind: 'discarded' | 'nothing-pending' } {
      if (!quarantined) return { ok: true, kind: 'nothing-pending' }
      quarantined = undefined
      try {
        invalidate()
      } catch {
        // Best effort only.
      }
      status('quarantined discarded by explicit user action')
      return { ok: true, kind: 'discarded' }
    },
  }
}
