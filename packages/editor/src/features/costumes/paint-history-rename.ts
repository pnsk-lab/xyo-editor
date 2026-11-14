/**
 * Paint-history rename ownership (pure, framework-free).
 *
 * Scratch parity, re-expressed with original code: in scratch-paint, undo
 * snapshots are paper JSON (artwork only). `_restore` funnels through
 * `onUpdateImage` into the VM `updateSvg`/`updateBitmap` routes, which never
 * touch `costume.name`. Rename travels a separate path (`onUpdateName` into
 * `vm.renameCostume` on the editing target). Paint Undo/Redo therefore never
 * reverts a rename: the rename layer owns the display name, the paint layer
 * owns bytes plus geometry metadata.
 *
 * This Editor mirrors that split:
 *
 * - User rename is owned by the VM `renameCostume` route (stable-id, still
 *   synchronous, still bumps the per-slot `writeSeq` on a real name change).
 *   The Editor adopts the post-rename identity into its last-known slot
 *   version synchronously after driving the rename, so a
 *   draw -> rename -> Undo sequence keeps working instead of tripping the
 *   external-conflict guard. Adoption happens only when the slot showed no
 *   unseen drift before the rename; an external write that landed first
 *   stays fail-closed (stack intact, conflict surfaced).
 * - Paint-history writes own bytes plus geometry metadata only. Every
 *   history-driven restore patch is stripped of `name`
 *   (`historyCostumeRestorePatch`), so Undo/Redo/cancel rewinds the drawing
 *   while the live (possibly renamed) name survives — the same way
 *   scratch-paint never rewrites names on undo. New-name clobber by a stale
 *   entry is therefore impossible even when the version check passes.
 * - External same-slot bytes/metadata drift, project replacement, slot
 *   shifts, and cross-asset switches keep the existing fail-closed guards
 *   (live-vs-known pre-check, versioned CAS `expected`, scope/generation,
 *   selection preconditions, and stack snapshot restore on conflict).
 *   Undo-stack restore failure never corrupts the stacks: callers restore
 *   the snapshots they took before popping.
 *
 * Out of scope (documented boundary, same as the slot-CAS helpers): direct
 * plain-object mutation of the VM project, plugins bypassing the VM API,
 * and legacy hash-only callers without a version field.
 */

/**
 * Strip the display name from a history restore patch. Returns a fresh
 * object; the input is never mutated. Bytes travel separately, so dropping
 * `name` keeps the live (possibly user-renamed) name while the restore
 * still rewinds artwork plus geometry metadata (`dataFormat`,
 * `rotationCenterX/Y`, `bitmapResolution`, ...).
 */
export function historyCostumeRestorePatch<Meta extends object>(meta: Meta): Omit<Meta, 'name'> {
  const clone: Record<string, unknown> = { ...(meta as Record<string, unknown>) }
  delete clone.name
  return clone as Omit<Meta, 'name'>
}

/** One in-flight gesture record, reduced to the rename-handoff decision. */
export interface PostRenameGestureInput {
  /** Map key of the gesture record (opaque to this helper). */
  key: number
  targetId: string
  index: number
  conflicted: boolean
  /** True when the record already diverged from the pre-rename live slot. */
  stale: boolean
}

/** Pure inputs for the post-rename adoption decision (all precomputed). */
export interface PostRenameHandoff {
  targetId: string
  index: number
  /** False when the slot has no Editor-known baseline yet. */
  hasKnown: boolean
  /** True when the pre-rename live slot already diverged from known. */
  liveBeforeStale: boolean
  gestures: readonly PostRenameGestureInput[]
}

/** Pure adoption plan: what the Editor may refresh after its own rename. */
export interface PostRenamePlan {
  /** Adopt the post-rename live identity as the slot's known baseline. */
  adoptKnown: boolean
  /** Gesture keys whose `last` may advance to the post-rename identity. */
  advanceGestureKeys: number[]
}

/**
 * Decide what a user-driven rename may refresh. Adoption is allowed only
 * when the slot showed no unseen drift before the rename: a no-baseline
 * slot establishes one, an in-sync slot advances it, and a slot with an
 * external write already pending stays fail-closed (no adoption, no gesture
 * touch, so the next Undo/Redo still refuses with the stacks intact).
 * Gestures advance only when they address the renamed slot, are not already
 * conflicted, and were in sync with the pre-rename live slot — rename and
 * paint commute (disjoint fields), so an in-sync drag survives the rename
 * instead of breaking on its next frame.
 */
export function planPostRenameAdoption(handoff: PostRenameHandoff): PostRenamePlan {
  if (handoff.hasKnown && handoff.liveBeforeStale) {
    return { adoptKnown: false, advanceGestureKeys: [] }
  }
  const advanceGestureKeys = handoff.gestures
    .filter(
      (gesture) =>
        gesture.targetId === handoff.targetId &&
        gesture.index === handoff.index &&
        !gesture.conflicted &&
        !gesture.stale,
    )
    .map((gesture) => gesture.key)
  return { adoptKnown: true, advanceGestureKeys }
}
