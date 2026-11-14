/**
 * Scoped same-slot external-wins reload decision (bitmap pending conflict path).
 *
 * Focused feature helper (AGENTS split): pure decision logic, no Svelte, no
 * DOM, no VM access. The Editor owns the async reload itself
 * (`refreshCostumePreview` / `loadCostumeIntoBitmapCanvas`, whose
 * revision/serial guards already scope the draw); this module only answers
 * "must the live latest asset be reloaded now, and why".
 *
 * Problem it solves: a pending rect/oval commit holds the writer CAS gate
 * (`direct-cas-pre`) while a direct external `vm.updateCostume` lands fresh
 * bytes on the SAME stable slot. The in-flight refresh (if any) still carries
 * the pre-commit own-write skip, so it skips the external reload; the pending
 * CAS then conflicts correctly (external green wins in the store) and the
 * session quarantines the staged red+blue off-canvas while leaving the live
 * canvas untouched (the reloader owns the pixels). Without an explicit
 * post-settle reload the canvas keeps showing the stale staged overlay
 * forever (digest equals staged, not green).
 *
 * Decision contract (all fail-closed toward "do not touch"):
 * - same stable slot + live bytes differ from the quarantined staged base ->
 *   reload the LIVE latest asset (exact green, no old red, no overwrite of the
 *   external write). The quarantined base+shape stays immutable off-canvas for
 *   exact export.
 * - same slot + identical bytes (metadata-only rename/center patch) -> no
 *   reload: the live bytes equal the staged base, the overlay is preserved,
 *   and the rebase path (`rebaseQuarantinedAfterMetadataRename`) owns the
 *   version adoption with no bytes moving.
 * - same slot + whole-project generation moved (loadProject/clear reusing the
 *   same ids, even with identical bytes) -> reload: the overlay belongs to the
 *   old project generation and must never paint onto the new one.
 * - live slot moved (different stable target/index) -> reload the LIVE
 *   slot's own bytes only when the canvas does not already show them; never
 *   paint the quarantined old base onto the new owner.
 * - canvas already settled showing the live key, or a load for the live key
 *   already pending -> no reload (no unconditional clear/splat, no redundant
 *   decode; the in-flight load is the scoped owner of the pixels).
 * - live slot unknown/missing -> no reload (cannot scope; never clear).
 *
 * Versioning note (writeSeq vs projectGeneration/selectionEpoch): the same
 * slot compares on the stored-bytes key (`md5ext` preferred, `assetId`
 * fallback) because that is what the pixels prove. `writeSeq` corroborates
 * (every slot write bumps it, including metadata-only renames) and
 * `projectGeneration` scopes whole-project replacement; neither alone
 * decides. Selection-epoch bumps without slot/bytes/generation drift never
 * reload (same-target reselect preserves intentional state).
 */

export type PendingConflictReloadScope = {
  /** Stable slot the staged (now quarantined) pending was captured for. */
  targetId: string
  costumeIndex: number
  /** Stored-bytes key of the staged pre-stroke base (`md5ext ?? assetId`). */
  assetKey: string
  /** Monotonic per-slot version at stage time (optional corroboration). */
  writeSeq?: number | null
  /** Whole-project generation at stage time (optional). */
  projectGeneration?: number | null
}

export type PendingConflictReloadLive = {
  /** Stable slot currently selected live (rightful owner of the canvas). */
  targetId: string
  costumeIndex: number
  /** Stored-bytes key currently live for that slot. */
  assetKey: string
  /** Monotonic per-slot version currently live (optional corroboration). */
  writeSeq?: number | null
  /** Whole-project generation currently live (optional). */
  projectGeneration?: number | null
}

export type PendingConflictReloadCanvas = {
  /** Last fully drawn asset (workspace owner), if any. */
  ownerTargetId?: string
  ownerIndex?: number
  ownerAssetKey?: string
  /** Whether that owner draw is settled (no newer load pending, same serial/revision). */
  ownerSettled?: boolean
  /** Asset key of a currently pending load for the live slot, if any. */
  pendingAssetKey?: string
  /** Whether the pending load (when present) targets the live slot. */
  pendingIsLiveSlot?: boolean
}

export type PendingConflictReloadVerdict = {
  reload: boolean
  reason: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function sameSlot(scope: PendingConflictReloadScope, live: PendingConflictReloadLive): boolean {
  return scope.targetId === live.targetId && scope.costumeIndex === live.costumeIndex
}

/**
 * Decide whether the Editor must reload the live latest asset after a pending
 * commit settled as `external-conflict` / `superseded` with the staged
 * red+blue quarantined off-canvas. Pure: never touches canvas, VM, or history.
 */
export function shouldReloadBitmapCanvasAfterPendingConflict(
  scope: PendingConflictReloadScope | undefined | null,
  live: PendingConflictReloadLive | undefined | null,
  canvas: PendingConflictReloadCanvas = {},
): PendingConflictReloadVerdict {
  if (!scope || !isNonEmptyString(scope.targetId) || !Number.isInteger(scope.costumeIndex) || scope.costumeIndex < 0) {
    return { reload: false, reason: 'no-quarantined-scope' }
  }
  if (!live || !isNonEmptyString(live.targetId) || !Number.isInteger(live.costumeIndex) || live.costumeIndex < 0) {
    // Live owner unknown: cannot scope a reload, never clear the canvas.
    return { reload: false, reason: 'no-live-slot' }
  }
  if (!isNonEmptyString(live.assetKey)) {
    // Live bytes missing/undecodable: the empty-canvas path (not the pending
    // path) owns this; never splat from here.
    return { reload: false, reason: 'live-bytes-missing' }
  }
  // A load for the live key is already in flight: it owns the pixels
  // (last-starter-wins serial); starting another decode is redundant churn.
  if (canvas.pendingIsLiveSlot === true && canvas.pendingAssetKey === live.assetKey) {
    return { reload: false, reason: 'reload-pending' }
  }
  const scopeGen = typeof scope.projectGeneration === 'number' ? scope.projectGeneration : null
  const liveGen = typeof live.projectGeneration === 'number' ? live.projectGeneration : null
  if (scopeGen !== null && liveGen !== null && scopeGen !== liveGen) {
    // Same ids, new project generation: the overlay (and even a
    // byte-identical base) belongs to the old project. Reload the new
    // generation's latest bytes; never restore the old base onto it.
    // (The settled shortcut below must NOT apply across a generation move:
    // the owner token may name identical bytes while the canvas still shows
    // the old overlay.)
    return { reload: true, reason: 'external-wins-new-generation' }
  }
  if (!sameSlot(scope, live)) {
    // Slot moved (different stable target/index): the canvas now belongs to
    // the live owner. Reload the LIVE slot's own bytes only when the canvas
    // does not already show them; never paint the quarantined old base.
    if (
      canvas.ownerSettled === true &&
      canvas.ownerTargetId === live.targetId &&
      canvas.ownerIndex === live.costumeIndex &&
      canvas.ownerAssetKey === live.assetKey
    ) {
      return { reload: false, reason: 'already-live' }
    }
    return { reload: true, reason: 'external-wins-slot-moved' }
  }
  // Same stable slot, same project generation from here.
  if (scope.assetKey === live.assetKey) {
    // Identical bytes (metadata-only rename/center patch, or a no-op): the
    // live store equals the staged base, so there is nothing newer to load.
    // The overlay stays as-is and the rebase path adopts the bumped version
    // with no bytes moving and no overwrite.
    return { reload: false, reason: 'same-bytes' }
  }
  // Same slot, divergent bytes: the external write won the CAS
  // (`writeSeq` moved with it; the quarantined scope still names the staged
  // base). The canvas is provably stale (it shows `base + shape`, never the
  // live key) unless the workspace owner already settled on the live key.
  if (
    canvas.ownerSettled === true &&
    canvas.ownerTargetId === live.targetId &&
    canvas.ownerIndex === live.costumeIndex &&
    canvas.ownerAssetKey === live.assetKey
  ) {
    return { reload: false, reason: 'already-live' }
  }
  return { reload: true, reason: 'external-wins-same-slot' }
}
