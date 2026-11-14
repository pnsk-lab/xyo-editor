/**
 * Bitmap pending-loading status settle guard.
 *
 * The bitmap workspace shows an explicit `Loading bitmap…` status while a
 * decode/raster/verify load is in flight (`bitmapWorkspacePending`). Paste
 * entry points reuse that same string to refuse safely while unsettled.
 * Without a guarded settle, the string survives after the load commits:
 * pending clears, the overlay hides and Save re-enables, yet the status bar
 * still claims loading.
 *
 * The fix updates that pending-derived loading status to the settled
 * completion display only when the *same* asset load settles. Every other
 * status — a different target/costume error, a later user operation, the
 * oversize/verify refusal (`Image too large …`) — must be preserved. In
 * particular this helper never performs a static `status === LOADING ->
 * SETTLED` rewrite: the caller may write the settled status only when the
 * live Svelte reactive async tokens still identify the settling load
 * (owner target/index, load serial, preview revision, workspace generation)
 * and no load remains pending.
 */

export const BITMAP_LOADING_STATUS = 'Loading bitmap…'
export const BITMAP_LOAD_SETTLED_STATUS = 'Costume selected'

export type BitmapLoadingSettleOwner = {
  targetId: string
  index: number
  loadSerial: number
  revision: number
  generation: number
}

export type BitmapLoadingSettleInput = {
  /** Current status bar text. */
  status: string
  /** Live workspace owner token (post-commit). */
  owner: BitmapLoadingSettleOwner | undefined
  /** Live pending token; must be cleared for a settled write. */
  pending: unknown
  /** Live `bitmapCanvasReloadSerial`. */
  serial: number
  /** Live `assetPreviewRevision`. */
  revision: number
  /** Live `bitmapWorkspaceGeneration`. */
  generation: number
  /** Live selection the status belongs to. */
  liveTargetId: string
  liveIndex: number
  /** Live `bitmapArtboard.refused === true`. */
  refused: boolean
}

/**
 * Decide whether a `Loading bitmap…` status may be replaced by the settled
 * completion display. Returns `true` only when every guard holds:
 * - the visible status is still the pending-derived loading status (so a
 *   later user operation or a refusal/error is never overwritten);
 * - no load remains pending;
 * - the workspace is not refused (oversize/verify refusal keeps its own
 *   explicit status);
 * - the committed owner still identifies the live target/costume slot and
 *   its load serial / preview revision / workspace generation still match
 *   the live reactive values (target/costume switch or a late stale load
 *   must not inject a completion status).
 */
export function shouldResolveBitmapLoadingStatus(input: BitmapLoadingSettleInput): boolean {
  if (input.status !== BITMAP_LOADING_STATUS) return false
  if (input.pending !== undefined && input.pending !== null) return false
  if (input.refused) return false
  const owner = input.owner
  if (!owner) return false
  if (owner.targetId !== input.liveTargetId) return false
  if (owner.index !== input.liveIndex) return false
  if (owner.loadSerial !== input.serial) return false
  if (owner.revision !== input.revision) return false
  if (owner.generation !== input.generation) return false
  return true
}

/**
 * Resolve the status to write on a settled bitmap load, or `undefined` when
 * the caller must leave the live status untouched.
 */
export function resolveBitmapLoadingSettleStatus(input: BitmapLoadingSettleInput): string | undefined {
  if (!shouldResolveBitmapLoadingStatus(input)) return undefined
  return BITMAP_LOAD_SETTLED_STATUS
}
