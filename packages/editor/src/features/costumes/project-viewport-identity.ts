// Per-project viewport identity for the costume editor (Editor-owned).
//
// The costume viewport key is scoped by project + slot + costume + mode
// (`buildCostumeViewportKey` in `costume-viewport.ts`, consumed via
// `BitmapEditor`'s `projectIdentity` / `costumeIdentity` props). The project
// segment MUST be a per-loaded-project token: without it, a different project
// that reuses the same target/index and the same costume asset bytes shares
// the previous project's viewport (F3).
//
// Contract (Editor wiring):
// - `projectViewportGeneration` is a monotonically increasing counter owned
//   by `Editor.svelte`. It starts at 0 (identity `project-gen-0` so even the
//   initial project is scoped, never legacy) and is bumped ONLY after a whole
//   project replacement succeeds: `newProject` (`vm.clear()`), `loadProject`
//   via `vm.loadProject()` (sb2/sb3), and `loadProject` via `vm.importJSON()`
//   (json). Failures, cancellations (no file picked), and every same-project
//   mutation (costume paint/save, undo/redo, target/costume switch, sprite or
//   costume rename, reorder/duplicate/delete, mode conversion, sprite/costume
//   library imports) MUST NOT bump it, so those operations preserve the
//   viewport through BitmapEditor's same-slot inheritance.
// - `projectIdentity` is derived via `formatProjectViewportIdentity()` and
//   passed verbatim to `BitmapEditor`. Empty/whitespace never occurs: the
//   formatter always returns a non-empty token.
// - `costumeIdentity` is intentionally a stable empty string (see
//   `resolveCostumeViewportIdentity()`): BitmapEditor's settled
//   `bitmapFitState.assetKey` fallback already scopes bitmap viewports per
//   content, and vector has no in-component content signal so it stays
//   slot-scoped. Passing `md5ext` verbatim here would fork a second key per
//   edit: every save/flip/convert mints a new md5ext (`vm.updateCostume`
//   re-hashes on data writes), so a vector 200% zoom would be abandoned on
//   the first mode conversion and a converted-back bitmap would never find
//   its settled key. Stable-empty keeps per-mode viewports across md5
//   rotations via same-slot inheritance (bitmap) and slot stability
//   (vector), while a project replace still changes the project segment and
//   starts unsettled (fresh fit).

export const PROJECT_VIEWPORT_IDENTITY_PREFIX = 'project-gen-'

/** Initial per-project viewport generation (initial project is scoped, not legacy). */
export function initialProjectViewportGeneration(): number {
  return 0
}

/**
 * Next per-project viewport generation. Pure and monotonic: always returns
 * `current + 1` for a valid counter, and fails closed to `1` for any invalid
 * input (non-integer, negative, non-finite) so a corrupted value still moves
 * forward instead of reusing a previous token.
 */
export function nextProjectViewportGeneration(current: unknown): number {
  if (typeof current === 'number' && Number.isSafeInteger(current) && current >= 0) {
    return current + 1
  }
  return initialProjectViewportGeneration() + 1
}

/**
 * Opaque project token for `BitmapEditor`'s `projectIdentity` prop. Always
 * non-empty; invalid inputs map to the initial token (`project-gen-0`) so the
 * caller never falls back to the legacy project segment by accident.
 */
export function formatProjectViewportIdentity(generation: unknown): string {
  if (typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0) {
    return `${PROJECT_VIEWPORT_IDENTITY_PREFIX}${generation}`
  }
  return `${PROJECT_VIEWPORT_IDENTITY_PREFIX}${initialProjectViewportGeneration()}`
}

export type CostumeViewportIdentitySource = {
  md5ext?: string | null
  assetId?: string | null
} | null | undefined

/**
 * Stable costume content identity for `BitmapEditor`'s `costumeIdentity` prop.
 *
 * Always returns `''` (slot-scoped): the caller passes no per-asset segment
 * and BitmapEditor falls back to its settled `bitmapFitState.assetKey` for
 * bitmap (per-content scoping without per-render volatility) while vector
 * stays slot-scoped. This is deliberate, not a TODO:
 * - `vm.updateCostume` mints a NEW `md5ext` on every data write (paint save,
 *   flip/rotate, either mode conversion), while `renameCostume` keeps the
 *   md5ext and `reorderCostume` only moves the slot index. Threading md5ext
 *   through would therefore abandon the settled vector key on every
 *   conversion round-trip (vector 200% -> bitmap 100% -> vector reset) and
 *   fork bitmap keys per edit instead of inheriting the user zoom.
 * - Same-project saves keep the viewport via BitmapEditor's same-slot
 *   inheritance (slot + mode unchanged, settled outgoing viewport copied to
 *   the re-resolved key); renames keep slot + fallback asset so the key never
 *   moves; reorder round-trips restore the original slot key; a project
 *   replace changes the project segment so even identical bytes start
 *   unsettled (fresh fit).
 * The argument is accepted (and type-checked) so call sites keep passing the
 * selected costume; the return stays `''` regardless of its content.
 */
export function resolveCostumeViewportIdentity(_costume: CostumeViewportIdentitySource): string {
  return ''
}
