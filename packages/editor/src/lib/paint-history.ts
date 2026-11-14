/**
 * Paint/sound history policy (pure, framework-free).
 *
 * Scratch-paint parity, re-expressed with original code:
 * - Drawing (costume) undo and sound undo live on SEPARATE stacks, so a
 *   costume Undo never rewinds a sound edit and vice versa. A new commit
 *   truncates only its own side's redo (isolated redo invalidation).
 * - Drawing history is per-slot: selecting another costume (or another
 *   target) CLEARs the paint stacks, so the newly selected artwork starts
 *   with an independent session. Tab switches and bitmap/vector conversions
 *   keep the active paint scope and preserve history.
 * - Sound history is GLOBAL across sounds (and targets): switching the
 *   active sound (or target) preserves the sound stacks, so an edit to
 *   sound A can still be undone/redone after selecting sound B. This keeps
 *   the legacy multi-sound/target behaviour while paint enjoys parity.
 * - A no-op path peeks without side effects and simply drops the peeked
 *   bytes, leaving both stacks and redo untouched.
 *
 * Scope identity deliberately excludes the content hash (`assetId`/`md5ext`):
 * every save mints a fresh content hash, so keying on it would fork a new
 * scope per keystroke. The paint scope is `stableTargetId:index`, which
 * survives saves, renames (target id and costume names are display-only) and
 * bitmap/vector conversions (same index). Sound entries carry their own
 * capture scope (`stableTargetId:index` + generation) but commits/restores
 * check the generation only, never the active sound key, so cross-sound
 * commits land and cross-sound undo restores the entry's own asset.
 * Reorder/delete of the SELECTED asset can keep the same numeric index with
 * different artwork behind it: paint handlers clear when the affected slot
 * is at or before the active one (plus unconditional clears on
 * reorder/restore), while ANY sound-list structural change (delete, restore,
 * reorder, duplicate) clears the whole global sound history, so a shifted
 * index can never mis-rewrite another sound. Async peek/commit pairs carry
 * a scope guard (`scopeKey` + `scopeGeneration`): paint drops a late commit
 * after a switch/clear, sound drops it only after an explicit clear
 * (generation bump), and redo is preserved in both cases.
 *
 * Memory evaluation (stored unit is ENCODED bytes, never decoded pixels):
 * - Costumes store PNG/SVG bytes as produced by `vm.loadAsset`. A 480x360
 *   RGBA frame decodes to 691,200 B and the 2400x1800 workspace canvas would
 *   decode to ~17.3 MB, but neither is stored; typical PNG artwork encodes
 *   to tens of KB (large photo imports: low single-digit MB), SVG to a few
 *   KB. 100 x 200 KB ~= 20 MB worst-typical, bounded below by the byte
 *   budget with oldest-first eviction.
 * - Sounds store WAV bytes from `vm.getSoundBuffer`. 44.1 kHz 16-bit mono
 *   is ~88 KB/s, so 30 s ~= 2.6 MB and 100 full-length entries would exceed
 *   250 MB unbounded; the byte budget is the binding cap here.
 * - Budgets cover undo+redo of one side combined; entry caps apply per side.
 *   A commit clears its own side's redo, so steady-state total stays within
 *   one side's cap + budget in practice.
 */

export const PAINT_HISTORY_MAX_ENTRIES = 100
export const SOUND_HISTORY_MAX_ENTRIES = 100

/** Encoded-bytes budget for one paint (costume) side, undo+redo combined. */
export const PAINT_HISTORY_MAX_BYTES = 24 * 1024 * 1024
/** Encoded-bytes budget for one sound side, undo+redo combined. */
export const SOUND_HISTORY_MAX_BYTES = 32 * 1024 * 1024

export interface HistoryScopeTarget {
  id?: string | null
  name: string
}

/** Stable target identity: VM `target.id`, falling back to the name. */
export function stableTargetId(target: HistoryScopeTarget): string {
  return target.id ?? target.name
}

/**
 * Drawing scope for the active costume. Excludes content hash and display
 * names on purpose (see header): same scope across saves, renames and
 * bitmap/vector conversions of the same slot.
 */
export function paintScopeId(targetId: string, costumeIndex: number): string {
  return `paint:${targetId}:${costumeIndex}`
}

/** Sound scope for the active sound slot. Same stability rules as paint. */
export function soundScopeId(targetId: string, soundIndex: number): string {
  return `sound:${targetId}:${soundIndex}`
}

export function paintScopeFor(target: HistoryScopeTarget, costumeIndex: number): string {
  return paintScopeId(stableTargetId(target), costumeIndex)
}

export function soundScopeFor(target: HistoryScopeTarget, soundIndex: number): string {
  return soundScopeId(stableTargetId(target), soundIndex)
}

/**
 * Async peek/commit guard. The caller snapshots `{ scopeKey,
 * scopeGeneration }` before the async `loadAsset`/`getSoundBuffer` read and
 * commits only while both still match. A switch or explicit clear bumps the
 * generation, so a late commit is dropped with redo preserved. Ordinary
 * commits, undos and redos never bump the generation, so concurrent edits to
 * the same scope still land in completion order.
 */
export interface HistoryScopeGuard {
  scopeKey: string
  scopeGeneration: number
}

export function createScopeGuard(scopeKey: string, scopeGeneration: number): HistoryScopeGuard {
  return { scopeKey, scopeGeneration }
}

export function isGuardCurrent(
  activeScopeKey: string,
  activeScopeGeneration: number,
  guard: HistoryScopeGuard,
): boolean {
  return guard.scopeKey === activeScopeKey && guard.scopeGeneration === activeScopeGeneration
}

export interface HistoryByteEntry {
  bytes: Uint8Array
}

export function historyByteSize(entries: readonly HistoryByteEntry[]): number {
  let total = 0
  for (const entry of entries) total += entry.bytes.byteLength
  return total
}

/**
 * Bound one history side (undo+redo of either paint or sound). Pure:
 * returns fresh arrays, never mutates inputs. Each side is capped at
 * `maxEntries`; the combined encoded bytes are capped at `maxBytes` by
 * evicting the oldest undo entries first, then the oldest redo entries.
 * Redo entries are never promoted into undo by trimming.
 *
 * Newest-per-side guarantee: the newest (last) entry of each non-empty
 * stack is always retained, even when that single entry alone exceeds
 * `maxBytes` (or when `maxEntries` is 0). Everything else is evicted
 * oldest-first until the combined total fits the budget. In other words
 * the latest real edit stays undoable/redoable at least once; only the
 * older entries are capacity-limited.
 *
 * Memory trade-off (documented exception): the combined total can exceed
 * `maxBytes` by up to the protected newest entries (one per non-empty
 * stack). The commit path passes an empty redo, so steady-state excess is
 * at most one over-budget entry; the undo/redo-move paths can transiently
 * hold one over-budget entry per side. Callers accept this so a single
 * >24 MB paint snapshot (or >32 MB sound snapshot) never wipes the whole
 * history and leaves the edit without any recovery step.
 */
export function trimHistoryStacks<TEntry extends HistoryByteEntry>(
  undo: readonly TEntry[],
  redo: readonly TEntry[],
  maxEntries: number,
  maxBytes: number,
): { undo: TEntry[]; redo: TEntry[] } {
  const cap = Math.max(0, maxEntries)
  let nextUndo = cap === 0 ? [] : undo.slice(Math.max(0, undo.length - cap))
  let nextRedo = cap === 0 ? [] : redo.slice(Math.max(0, redo.length - cap))
  // Entry-count floor: a non-empty side always keeps its newest entry, so
  // the latest edit survives even `maxEntries: 0`. `slice` above already
  // keeps the newest for cap >= 1; only the cap-0 wipe needs restoring.
  if (undo.length > 0 && nextUndo.length === 0) nextUndo = [undo[undo.length - 1] as TEntry]
  if (redo.length > 0 && nextRedo.length === 0) nextRedo = [redo[redo.length - 1] as TEntry]
  if (Number.isFinite(maxBytes)) {
    let total = historyByteSize(nextUndo) + historyByteSize(nextRedo)
    // Byte budget: evict oldest-first but never the newest entry of a
    // non-empty stack. `evictableUndo`/`evictableRedo` exclude the
    // protected tail, so a lone over-budget entry (or a newest pair whose
    // sum still exceeds the budget) is kept as the documented exception.
    const evictableUndo = Math.max(0, nextUndo.length - (nextUndo.length > 0 ? 1 : 0))
    let dropUndo = 0
    while (dropUndo < evictableUndo && total > maxBytes) {
      total -= nextUndo[dropUndo]?.bytes.byteLength ?? 0
      dropUndo += 1
    }
    if (dropUndo > 0) nextUndo = nextUndo.slice(dropUndo)
    const evictableRedo = Math.max(0, nextRedo.length - (nextRedo.length > 0 ? 1 : 0))
    let dropRedo = 0
    while (dropRedo < evictableRedo && total > maxBytes) {
      total -= nextRedo[dropRedo]?.bytes.byteLength ?? 0
      dropRedo += 1
    }
    if (dropRedo > 0) nextRedo = nextRedo.slice(dropRedo)
  }
  return { undo: nextUndo, redo: nextRedo }
}
