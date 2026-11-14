import { isBitmapSourceSizeRefused } from './bitmap-artboard'
import {
  isValidSlotIdentity,
  type PendingCommitControl,
  type PendingCommitScope,
  type PendingCommitSlotIdentity,
  type PendingCommitTaken,
  type PendingCommitWrite,
  type PendingCommitWriteResult,
} from './bitmap-pending-transaction'

/**
 * Bitmap pending-shape VM writer (Scratch paint parity, isolated adapter).
 *
 * Focused feature adapter only (AGENTS split): bridges the isolated
 * `bitmap-pending-transaction` coordinator to the real ScratchVM, with the
 * asset PNG bytes supplied as an argument. No `Editor.svelte` /
 * `BitmapEditor.svelte` edits, no canvas/DOM access, no timers, no retries.
 *
 * Responsibilities:
 * - capture the exact stable slot identity synchronously
 *   (`targetId` / `costumeIndex` / `projectGeneration` / structure seq /
 *   `writeSeq` / `assetId` / `md5ext` / selection revision);
 * - expose the `readLive` / `getLiveIdentity` scope adapters the coordinator
 *   expects in `PendingCommitOptions`;
 * - build a trusted `PendingCommitWrite` that calls the atomic CAS route
 *   `vm.updateCostumeIfMatch` with the per-flight abort token forwarded as
 *   the 7th arg and correct PNG metadata but no `name` overwrite, returning
 *   the exact CAS `current` identity on success.
 *
 * Side-effect boundary: importing this module and calling the capture /
 * reader factories performs VM reads only (`getCostumeIdentity`,
 * `getProjectGeneration`, `getSelectionEpoch`, `getCostumeStructureSeq`).
 * The ONLY VM mutation is the single `updateCostumeIfMatch` inside the
 * returned writer, invoked exactly once per coordinator commit. Failed
 * encode / oversize validation returns `{ ok: false }` without touching the
 * VM so the coordinator preserves the original pending for retry.
 */

/** Minimal structural VM surface used by this adapter (real `ScratchVM` satisfies it). */
export type BitmapPendingVmLike = {
  getCostumeIdentity?: (targetId: string, index: number) => unknown
  getProjectGeneration?: () => unknown
  getSelectionEpoch?: () => unknown
  getCostumeStructureSeq?: (targetId: string) => unknown
  updateCostumeIfMatch?: (
    targetId: string,
    index: number,
    expected: unknown,
    patch: Record<string, unknown>,
    data?: Uint8Array,
    selection?: Record<string, unknown> | undefined,
    abort?: unknown,
  ) => Promise<unknown>
}

/** Editor-owned fixed fields that the VM cannot supply. */
export type BitmapPendingScopeExtra = {
  loadSerial: number
  sessionGeneration: number
  /** Preview revision the pending was rendered from; defaults to the live `writeSeq`. */
  editEpoch?: number
}

/** PNG payload for one pending commit (bytes supplied by the caller). */
export type BitmapPendingPngPayload = {
  /** Exact PNG bytes to store (copied per write; never mutated). */
  pngBytes: Uint8Array
  /** Stored resolution preserved verbatim (never re-derived). */
  bitmapResolution?: number
  rotationCenterX?: number
  rotationCenterY?: number
  /** Optional pre-encode dimensions for the oversize gate (refuse before any VM call). */
  width?: number
  height?: number
}

export type BitmapPendingVmWriterArgs = {
  targetId: string
  costumeIndex: number
} & BitmapPendingPngPayload

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function toCounterOr(value: unknown, fallback: number): number {
  return isCounter(value) ? (value as number) : fallback
}

function toOptionalCounter(value: unknown): number | null {
  return isCounter(value) ? (value as number) : null
}

function toOptionalId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizeIdentity(value: unknown): { assetId: string | null; md5ext: string | null; writeSeq: number | null } {
  if (!value || typeof value !== 'object') return { assetId: null, md5ext: null, writeSeq: null }
  const record = value as Record<string, unknown>
  const seqRaw = record.writeSeq ?? record.seq ?? record.version
  return {
    assetId: toOptionalId(record.assetId),
    md5ext: toOptionalId(record.md5ext),
    writeSeq: toOptionalCounter(seqRaw),
  }
}

function readIdentity(vm: BitmapPendingVmLike, targetId: string, index: number): { assetId: string | null; md5ext: string | null; writeSeq: number | null } | undefined {
  try {
    const fn = vm.getCostumeIdentity
    if (typeof fn !== 'function') return undefined
    const raw = (fn as (t: string, i: number) => unknown).call(vm, targetId, index)
    if (!raw || typeof raw !== 'object') return undefined
    return normalizeIdentity(raw)
  } catch {
    return undefined
  }
}

function readProjectGeneration(vm: BitmapPendingVmLike): number {
  try {
    const fn = vm.getProjectGeneration
    if (typeof fn !== 'function') return 0
    return toCounterOr((fn as () => unknown).call(vm), 0)
  } catch {
    return 0
  }
}

function readSelectionEpoch(vm: BitmapPendingVmLike): number | null {
  try {
    const fn = vm.getSelectionEpoch
    if (typeof fn !== 'function') return null
    const value = (fn as () => unknown).call(vm)
    return isCounter(value) ? (value as number) : null
  } catch {
    return null
  }
}

function readStructureSeq(vm: BitmapPendingVmLike, targetId: string): number | null {
  try {
    const fn = vm.getCostumeStructureSeq
    if (typeof fn !== 'function') return null
    const value = (fn as (t: string) => unknown).call(vm, targetId)
    return isCounter(value) ? (value as number) : null
  } catch {
    return null
  }
}

/**
 * Capture the exact stable scope for one slot, synchronously (no await in
 * between). Reads the live VM identity / generation / selection / structure
 * and merges the Editor-owned `loadSerial` / `sessionGeneration`.
 * Read-only: never mutates the VM.
 */
export function captureBitmapPendingScope(
  vm: BitmapPendingVmLike,
  targetId: string,
  costumeIndex: number,
  extra: BitmapPendingScopeExtra,
): PendingCommitScope {
  const slotId = String(targetId ?? '')
  const slotIndex = Number(costumeIndex)
  const loadSerial = toCounterOr(extra.loadSerial, 0)
  const sessionGeneration = toCounterOr(extra.sessionGeneration, 0)
  const identity = readIdentity(vm, slotId, slotIndex)
  const projectGeneration = readProjectGeneration(vm)
  const selectionEpoch = readSelectionEpoch(vm)
  const structureSeq = readStructureSeq(vm, slotId)
  const liveWriteSeq = identity?.writeSeq
  const editEpoch =
    typeof extra.editEpoch === 'number' && Number.isInteger(extra.editEpoch) && extra.editEpoch >= 0
      ? extra.editEpoch
      : typeof liveWriteSeq === 'number'
        ? liveWriteSeq
        : 0
  const writeSeq = typeof liveWriteSeq === 'number' ? liveWriteSeq : editEpoch
  // `assetKey` mirrors the stored-bytes key (`md5ext` preferred, `assetId`
  // fallback). When the slot is gone the scope is deliberately invalid
  // (empty key) so the coordinator fails closed instead of restoring.
  const assetKey = identity?.md5ext ?? identity?.assetId ?? ''
  return {
    targetId: slotId,
    costumeIndex: Number.isInteger(slotIndex) && slotIndex >= 0 ? slotIndex : 0,
    assetKey,
    loadSerial,
    sessionGeneration,
    editEpoch,
    projectGeneration,
    assetId: identity?.assetId ?? null,
    writeSeq,
    selectionEpoch,
    structureSeq,
  }
}

/** Fresh live slot identity read for `options.getLiveIdentity` (same slot, stable id only). */
export function readBitmapPendingLiveIdentity(
  vm: BitmapPendingVmLike,
  targetId: string,
  costumeIndex: number,
): PendingCommitSlotIdentity | undefined {
  const identity = readIdentity(vm, String(targetId ?? ''), Number(costumeIndex))
  if (!identity) return undefined
  return { assetId: identity.assetId, md5ext: identity.md5ext, writeSeq: identity.writeSeq }
}

/**
 * Scope adapters the coordinator expects. Both close over the exact stable
 * slot (`targetId` / `costumeIndex`); no display-name fallback, so stage and
 * sprite slots never crosstalk. Read-only until the writer runs.
 */
export function createBitmapPendingScopeReaders(
  vm: BitmapPendingVmLike,
  targetId: string,
  costumeIndex: number,
  extra: BitmapPendingScopeExtra,
): {
  readLive: () => PendingCommitScope
  getLiveIdentity: () => PendingCommitSlotIdentity | undefined
} {
  const slotId = String(targetId ?? '')
  const slotIndex = Number(costumeIndex)
  const fixed: BitmapPendingScopeExtra = {
    loadSerial: toCounterOr(extra.loadSerial, 0),
    sessionGeneration: toCounterOr(extra.sessionGeneration, 0),
  }
  return {
    readLive: () => captureBitmapPendingScope(vm, slotId, slotIndex, fixed),
    getLiveIdentity: () => readBitmapPendingLiveIdentity(vm, slotId, slotIndex),
  }
}

function isValidPngBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength > 0
}

function buildPngPatch(args: BitmapPendingVmWriterArgs): Record<string, unknown> {
  // PNG metadata only: `dataFormat` + resolution/center. Never `name` — the
  // rename layer owns the display name, so a pending commit must not clobber
  // a concurrent rename.
  const patch: Record<string, unknown> = { dataFormat: 'png' }
  if (typeof args.bitmapResolution === 'number' && Number.isFinite(args.bitmapResolution) && args.bitmapResolution > 0) {
    patch.bitmapResolution = args.bitmapResolution
  }
  if (typeof args.rotationCenterX === 'number' && Number.isFinite(args.rotationCenterX)) {
    patch.rotationCenterX = args.rotationCenterX
  }
  if (typeof args.rotationCenterY === 'number' && Number.isFinite(args.rotationCenterY)) {
    patch.rotationCenterY = args.rotationCenterY
  }
  return patch
}

function isValidCasResult(value: unknown): value is { applied: boolean; reason?: unknown; current?: unknown } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.applied === 'boolean'
}

/**
 * Build the trusted CAS writer for one pending commit. The PNG bytes are
 * supplied as an argument (copied per write); the writer captures nothing
 * until the coordinator invokes it.
 *
 * Contract (mirrors the coordinator's safe-writer mandate):
 * - validates encode/oversize first and returns `{ ok: false }` without
 *   touching the VM so the pending is preserved for retry;
 * - refuses cross-slot invocations fail-closed (`applied: false`);
 * - invokes `control.shouldCommit()` synchronously at the actual commit
 *   point (immediately before the atomic mutation, after any await — this
 *   writer performs no await before the CAS);
 * - forwards the per-flight abort token as the VM 7th arg and honors
 *   `throwIfAborted()` before the mutation;
 * - calls `vm.updateCostumeIfMatch` with the exact stable slot
 *   (`control.expected` + selection precondition from `control.capture`,
 *   never a display-name alias) and PNG metadata without `name`;
 * - returns the exact CAS `current` as `newIdentity`; a missing/invalid
 *   identity on a claimed success is reported as `{ ok: false }`
 *   (fail-closed, retryable while still owned).
 */
export function createBitmapPendingVmWrite(
  vm: BitmapPendingVmLike,
  args: BitmapPendingVmWriterArgs,
): PendingCommitWrite {
  const slotId = String(args.targetId ?? '')
  const slotIndex = Number(args.costumeIndex)
  const pngBytes = args.pngBytes
  const patch = buildPngPatch(args)
  const hasDims = args.width !== undefined || args.height !== undefined
  const dimWidth = args.width
  const dimHeight = args.height

  return async (taken: PendingCommitTaken, control: PendingCommitControl): Promise<PendingCommitWriteResult> => {
    // Cross-slot guard: this writer belongs to exactly one stable slot, so a
    // mis-wired coordinator invocation (stage vs sprite, shifted index) can
    // never steer PNG bytes into the wrong asset.
    if (taken.scope.targetId !== slotId || taken.scope.costumeIndex !== slotIndex) {
      return { ok: true, applied: false, reason: 'superseded' }
    }
    // Failed encode / oversize: no VM touch, pending preserved for retry.
    if (!isValidPngBytes(pngBytes)) {
      return { ok: false, reason: 'encode-failed' }
    }
    if (hasDims) {
      if (
        typeof dimWidth !== 'number' ||
        typeof dimHeight !== 'number' ||
        !Number.isFinite(dimWidth) ||
        !Number.isFinite(dimHeight) ||
        isBitmapSourceSizeRefused(dimWidth, dimHeight)
      ) {
        return { ok: false, reason: 'refused-size' }
      }
    }
    // Trusted guard at the actual commit point (no await before this line).
    if (!control.shouldCommit()) {
      return { ok: true, applied: false, reason: 'superseded' }
    }
    control.throwIfAborted()
    const cas = vm.updateCostumeIfMatch
    if (typeof cas !== 'function') {
      return { ok: false, reason: 'missing-cas' }
    }
    const expected = {
      assetId: control.expected.assetId ?? null,
      md5ext: control.expected.md5ext ?? null,
      writeSeq: control.expected.writeSeq ?? null,
    }
    // Explicit discrete-save selection precondition from the synchronous
    // capture (stable id exact, no alias; generation + selection epoch).
    const captureProject = control.capture.projectGeneration
    const captureSelection = control.capture.selectionEpoch
    const selection: Record<string, unknown> = { targetId: slotId, index: slotIndex }
    if (typeof captureProject === 'number' && Number.isInteger(captureProject) && captureProject >= 0) {
      selection.projectGeneration = captureProject
    }
    if (typeof captureSelection === 'number' && Number.isInteger(captureSelection) && captureSelection >= 0) {
      selection.selectionEpoch = captureSelection
    }
    // Per-write bytes copy: a mutating backend cannot corrupt the caller's
    // buffer or the retained pending.
    const bytesCopy = new Uint8Array(pngBytes)
    const raw = await (cas as (...callArgs: unknown[]) => Promise<unknown>).call(
      vm,
      slotId,
      slotIndex,
      expected,
      { ...patch },
      bytesCopy,
      selection,
      control.abort,
    )
    if (!isValidCasResult(raw)) {
      return { ok: false, reason: 'missing-result' }
    }
    if (raw.applied !== true) {
      const reason = typeof raw.reason === 'string' && raw.reason.length > 0 ? raw.reason : 'conflict'
      const current = isValidSlotIdentity(raw.current)
        ? { assetId: (raw.current as PendingCommitSlotIdentity).assetId ?? null, md5ext: (raw.current as PendingCommitSlotIdentity).md5ext ?? null, writeSeq: (raw.current as PendingCommitSlotIdentity).writeSeq ?? null }
        : undefined
      return current === undefined
        ? { ok: true, applied: false, reason }
        : { ok: true, applied: false, reason, current }
    }
    // Claimed success must carry the verifiable post-mutation identity.
    if (!isValidSlotIdentity(raw.current)) {
      return { ok: false, reason: 'missing-identity' }
    }
    const current = raw.current as PendingCommitSlotIdentity
    return {
      ok: true,
      applied: true,
      newIdentity: { assetId: current.assetId ?? null, md5ext: current.md5ext ?? null, writeSeq: current.writeSeq ?? null },
    }
  }
}

/**
 * Convenience bundle for one pending commit: the stage-time scope plus the
 * matching writer and coordinator options. The scope is captured
 * synchronously at call time; the writer/options re-read live state on every
 * coordinator callback, so a successful own write is observed via the CAS
 * `current` and the next transaction re-bases from the correct post
 * identity. No VM mutation happens here.
 */
export function createBitmapPendingVmCommit(
  vm: BitmapPendingVmLike,
  args: BitmapPendingVmWriterArgs,
  extra: BitmapPendingScopeExtra,
): {
  scope: PendingCommitScope
  write: PendingCommitWrite
  options: { readLive: () => PendingCommitScope; getLiveIdentity: () => PendingCommitSlotIdentity | undefined }
} {
  const slotId = String(args.targetId ?? '')
  const slotIndex = Number(args.costumeIndex)
  const scope = captureBitmapPendingScope(vm, slotId, slotIndex, extra)
  const write = createBitmapPendingVmWrite(vm, { ...args, targetId: slotId, costumeIndex: slotIndex })
  const options = createBitmapPendingScopeReaders(vm, slotId, slotIndex, extra)
  return { scope, write, options }
}
