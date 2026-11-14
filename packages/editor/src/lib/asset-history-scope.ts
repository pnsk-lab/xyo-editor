/**
 * Scoped paint-history helper (pure, framework-free).
 *
 * Purpose: isolate scratch-paint style per-asset undo/redo from the current
 * Editor behaviour (single shared sound/costume stack, 30 entries) without
 * touching `Editor.svelte` or any existing file. All functions are pure:
 * they never mutate their inputs and never perform I/O.
 *
 * Data-corruption guards built in:
 * - `Uint8Array` payloads are defensively copied on the way in
 *   (`createPendingEntry`) and never stored by reference.
 * - `commitEntry` / `applyUndo` / `applyRedo` return brand-new state
 *   objects; the input state is left untouched (tested).
 * - There is deliberately NO "capture then pop on no-op" API. The old
 *   `slice(0, -1)` + `redoBackup` rollback could delete a concurrent edit
 *   (see `asset-history-noop-race.test.ts`). Here `peek` produces a detached
 *   pending object with zero stack side effects; only an explicit `commit`
 *   mutates (returns) state.
 *
 * Assumed integration API (NOT verified against a running Editor; the
 * integrator must confirm before wiring this into `Editor.svelte`):
 * - Stable target identity is available as `target.id` (VM `ScratchTarget.id`,
 *   optional today). `targetName` is kept for display/restore only.
 * - Stable asset identity is available as `costume.assetId` / `sound.assetId`
 *   (or `md5ext`-derived). `index` is kept for restore but is NOT part of the
 *   scope key, so reorder does not fork history.
 * - The byte payload is the same unit the current history stores
 *   (`vm.loadAsset` / `vm.getSoundBuffer` bytes). Budget accounting uses
 *   `bytes.byteLength`.
 * - Hook points are assumed to be: `selectCostume`,
 *   `resetCostumeEditorSelection`, convert bitmap/vector, and
 *   `undoAssetEdit`/`redoAssetEdit`. This file does not hook anything up.
 *
 * Risks / unconfirmed choices (intentionally NOT decided here):
 * - If `target.id` is absent the caller must supply a stable substitute;
 *   falling back to `targetName` reintroduces rename-aliasing.
 * - If `assetId` is absent the scope falls back to `index:` + position,
 *   so reorder/fork behaviour degrades to the current index-based one.
 * - Byte budget is per-scope encoded bytes, not decoded RGBA; a 480x360 RGBA
 *   frame (~691_200 B) and its PNG/SVG encoding differ by large factors.
 * - The `clear` vs `keep` switch policy has NO default in this helper; the
 *   caller must pass it explicitly every time (`ScopeSwitchPolicy`).
 * - No persistence across reload and no cross-tab sync is provided.
 *
 * This is an independent implementation. It does not copy scratch-paint
 * (AGPL) sources; limits and behaviours are re-expressed with original code
 * and names.
 */

export type AssetKind = 'costume' | 'sound'

/**
 * Stable identity of one editable asset snapshot.
 *
 * - `targetId`: stable target identity. Prefer VM `target.id`; never use the
 *   display name as identity because rename would fork/lose history.
 * - `targetName`: display/restore hint only. Ignored by scope matching.
 * - `index`: restore position hint only. Ignored by scope matching so that
 *   reorder keeps the same undo scope.
 * - `assetId`: stable asset identity (e.g. `assetId` / `md5ext`-derived).
 *   When absent the scope falls back to the positional index (documented
 *   degradation; see `scopeIdForIdentity`).
 */
export interface AssetIdentity {
  kind: AssetKind
  /** Stable target id. Use VM `target.id` when present. */
  targetId: string
  /** Display name only; excluded from scope matching. */
  targetName: string
  /** Restore position hint; excluded from scope matching. */
  index: number
  /** Stable asset id when known; `undefined` degrades to positional scope. */
  assetId?: string
}

export interface PendingHistoryEntry<TMeta = unknown> {
  identity: AssetIdentity
  meta: TMeta
  bytes: Uint8Array
}

export interface HistoryEntry<TMeta = unknown> {
  identity: AssetIdentity
  meta: TMeta
  bytes: Uint8Array
  byteLength: number
}

export interface ScopeStacks<TMeta = unknown> {
  undo: ReadonlyArray<HistoryEntry<TMeta>>
  redo: ReadonlyArray<HistoryEntry<TMeta>>
}

export interface ScopedHistoryState<TMeta = unknown> {
  scopes: Readonly<Record<string, ScopeStacks<TMeta>>>
  /** Currently selected scope id (may be absent from `scopes` until first commit). */
  activeScopeId: string | null
  /** Bumps on every state-transform; used as a commit guard generation. */
  generation: number
  maxEntries: number
  maxBytes: number
}

/** Switching policy. No default is provided on purpose: pass explicitly. */
export type ScopeSwitchPolicy = 'clear' | 'keep'

export interface HistoryOptions {
  /** Per-scope undo depth. Scratch-paint uses 100; current Editor uses 30. */
  maxEntries?: number
  /** Per-scope byte budget for stored `bytes`. */
  maxBytes?: number
}

const EMPTY_STACKS: ScopeStacks<never> = { undo: [], redo: [] }

function emptyStacks<TMeta>(): ScopeStacks<TMeta> {
  return { undo: [], redo: [] }
}

function stacksOf<TMeta>(state: ScopedHistoryState<TMeta>, scopeId: string): ScopeStacks<TMeta> {
  return state.scopes[scopeId] ?? emptyStacks<TMeta>()
}

function identityKeyPart(identity: AssetIdentity): string {
  return identity.assetId !== undefined && identity.assetId !== ''
    ? `asset:${identity.assetId}`
    : `index:${identity.index}`
}

/**
 * Scope key for an asset. Stable across rename (name excluded) and reorder
 * (index excluded when `assetId` is present). Kind + target + asset scoped,
 * so costume and sound (or two costumes, or two targets) never share stacks.
 */
export function scopeIdForIdentity(identity: AssetIdentity): string {
  return `${identity.kind}:${identity.targetId}:${identityKeyPart(identity)}`
}

/**
 * Scope membership check that tolerates rename/reorder drift: compares
 * `kind` + `targetId` + stable asset part only.
 */
export function isEntryForScope<TMeta>(
  entry: Pick<HistoryEntry<TMeta>, 'identity'> | Pick<PendingHistoryEntry<TMeta>, 'identity'>,
  scopeId: string,
): boolean {
  return scopeIdForIdentity(entry.identity) === scopeId
}

export function createHistoryState<TMeta = unknown>(options: HistoryOptions = {}): ScopedHistoryState<TMeta> {
  const maxEntries = options.maxEntries ?? 100
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  if (!Number.isFinite(maxEntries) && maxEntries !== Number.POSITIVE_INFINITY) {
    throw new RangeError('maxEntries must be a finite non-negative number or Infinity')
  }
  if (maxEntries < 0) throw new RangeError('maxEntries must be >= 0')
  if (!(maxBytes >= 0)) throw new RangeError('maxBytes must be >= 0')
  return { scopes: {}, activeScopeId: null, generation: 0, maxEntries, maxBytes }
}

/**
 * Detached pre-commit snapshot. Pure + side-effect free: copies `bytes` so
 * later mutation of the caller's array cannot corrupt the pending value, and
 * touches no history state (concurrent-peek safety: a no-op simply discards
 * the pending object without stack writes or redo restores).
 */
export function createPendingEntry<TMeta>(
  identity: AssetIdentity,
  bytes: Uint8Array,
  meta: TMeta,
): PendingHistoryEntry<TMeta> {
  return {
    identity: { ...identity },
    meta,
    bytes: new Uint8Array(bytes),
  }
}

function toStoredEntry<TMeta>(pending: PendingHistoryEntry<TMeta>): HistoryEntry<TMeta> {
  const bytes = new Uint8Array(pending.bytes)
  return {
    identity: { ...pending.identity },
    meta: pending.meta,
    bytes,
    byteLength: bytes.byteLength,
  }
}

function trimStacks<TMeta>(
  undo: ReadonlyArray<HistoryEntry<TMeta>>,
  redo: ReadonlyArray<HistoryEntry<TMeta>>,
  maxEntries: number,
  maxBytes: number,
): { undo: HistoryEntry<TMeta>[]; redo: HistoryEntry<TMeta>[] } {
  let nextUndo = undo.slice(Math.max(0, undo.length - maxEntries))
  // Byte budget applies to the undo side (redo entries are bounded by the
  // same per-scope cap already; budgeting both sides independently keeps the
  // helper predictable without cross-scope coupling).
  if (Number.isFinite(maxBytes)) {
    let total = nextUndo.reduce((sum, entry) => sum + entry.byteLength, 0)
    let drop = 0
    while (drop < nextUndo.length && total > maxBytes) {
      total -= nextUndo[drop]?.byteLength ?? 0
      drop += 1
    }
    if (drop > 0) nextUndo = nextUndo.slice(drop)
  }
  let nextRedo = redo.slice(Math.max(0, redo.length - maxEntries))
  return { undo: nextUndo, redo: nextRedo }
}

function withScope<TMeta>(
  state: ScopedHistoryState<TMeta>,
  scopeId: string,
  stacks: ScopeStacks<TMeta>,
): ScopedHistoryState<TMeta> {
  return {
    ...state,
    scopes: { ...state.scopes, [scopeId]: { undo: [...stacks.undo], redo: [...stacks.redo] } },
    generation: state.generation + 1,
  }
}

/**
 * Commit a previously peeked entry to one scope. Clears ONLY that scope's
 * redo (isolated redo invalidation); every other scope is untouched.
 */
export function commitEntry<TMeta>(
  state: ScopedHistoryState<TMeta>,
  scopeId: string,
  pending: PendingHistoryEntry<TMeta>,
): ScopedHistoryState<TMeta> {
  const stored = toStoredEntry(pending)
  const previous = stacksOf(state, scopeId)
  const merged = trimStacks(
    [...previous.undo, stored],
    [],
    state.maxEntries,
    state.maxBytes,
  )
  return withScope(state, scopeId, merged)
}

/**
 * Guarded commit for concurrent peek/commit flows: the caller captures
 * `state.generation` (and usually `state.activeScopeId`) before the async
 * `loadAsset`, then commits only when both still match. A stale guard is a
 * no-op returning the input state object unchanged (redo preserved, no
 * cross-scope writes).
 */
export function guardedCommitEntry<TMeta>(
  state: ScopedHistoryState<TMeta>,
  scopeId: string,
  pending: PendingHistoryEntry<TMeta>,
  expected: { generation: number; activeScopeId?: string | null },
): ScopedHistoryState<TMeta> {
  if (state.generation !== expected.generation) return state
  if (expected.activeScopeId !== undefined && state.activeScopeId !== expected.activeScopeId) {
    return state
  }
  if (state.activeScopeId !== null && state.activeScopeId !== scopeId) return state
  return commitEntry(state, scopeId, pending)
}

/**
 * Explicit scope switch. `policy: 'clear'` resets the DESTINATION scope to
 * empty (scratch-paint CLEAR analogue: fresh session for the newly selected
 * asset). `policy: 'keep'` preserves the destination scope. The parameter is
 * required so integrators cannot silently inherit either behaviour.
 */
export function selectScope<TMeta>(
  state: ScopedHistoryState<TMeta>,
  nextScopeId: string,
  policy: ScopeSwitchPolicy,
): ScopedHistoryState<TMeta> {
  if (policy !== 'clear' && policy !== 'keep') {
    throw new RangeError("selectScope requires an explicit policy: 'clear' or 'keep'")
  }
  if (policy === 'keep') {
    if (state.activeScopeId === nextScopeId) return state
    return { ...state, activeScopeId: nextScopeId, generation: state.generation + 1 }
  }
  const cleared: ScopeStacks<TMeta> = emptyStacks()
  const scopes =
    nextScopeId in state.scopes
      ? { ...state.scopes, [nextScopeId]: cleared }
      : { ...state.scopes, [nextScopeId]: cleared }
  return { ...state, scopes, activeScopeId: nextScopeId, generation: state.generation + 1 }
}

export function clearScope<TMeta>(state: ScopedHistoryState<TMeta>, scopeId: string): ScopedHistoryState<TMeta> {
  if (!(scopeId in state.scopes)) return state
  const scopes = { ...state.scopes, [scopeId]: emptyStacks<TMeta>() }
  return { ...state, scopes, generation: state.generation + 1 }
}

export function clearAllScopes<TMeta>(state: ScopedHistoryState<TMeta>): ScopedHistoryState<TMeta> {
  if (Object.keys(state.scopes).length === 0) return state
  return { ...state, scopes: {}, generation: state.generation + 1 }
}

export interface UndoResult<TMeta> {
  state: ScopedHistoryState<TMeta>
  /** Entry the caller should restore, or `undefined` when the scope has no undo. */
  entryToRestore: HistoryEntry<TMeta> | undefined
}

/**
 * Pure undo for one scope. When `current` is supplied it is pushed onto that
 * scope's redo (bounded); otherwise redo is left untouched. Other scopes are
 * never touched. Returns the input state object unchanged when there is
 * nothing to undo.
 */
export function applyUndo<TMeta>(
  state: ScopedHistoryState<TMeta>,
  scopeId: string,
  current?: PendingHistoryEntry<TMeta>,
): UndoResult<TMeta> {
  const stacks = stacksOf(state, scopeId)
  const target = stacks.undo[stacks.undo.length - 1]
  if (!target) return { state, entryToRestore: undefined }
  const nextUndo = stacks.undo.slice(0, -1)
  const nextRedo =
    current !== undefined ? [...stacks.redo, toStoredEntry(current)] : [...stacks.redo]
  const trimmed = trimStacks(nextUndo, nextRedo, state.maxEntries, state.maxBytes)
  return { state: withScope(state, scopeId, trimmed), entryToRestore: target }
}

export interface RedoResult<TMeta> {
  state: ScopedHistoryState<TMeta>
  entryToRestore: HistoryEntry<TMeta> | undefined
}

/** Mirror of {@link applyUndo} for the redo direction. */
export function applyRedo<TMeta>(
  state: ScopedHistoryState<TMeta>,
  scopeId: string,
  current?: PendingHistoryEntry<TMeta>,
): RedoResult<TMeta> {
  const stacks = stacksOf(state, scopeId)
  const target = stacks.redo[stacks.redo.length - 1]
  if (!target) return { state, entryToRestore: undefined }
  const nextRedo = stacks.redo.slice(0, -1)
  const nextUndo =
    current !== undefined ? [...stacks.undo, toStoredEntry(current)] : [...stacks.undo]
  const trimmed = trimStacks(nextUndo, nextRedo, state.maxEntries, state.maxBytes)
  return { state: withScope(state, scopeId, trimmed), entryToRestore: target }
}

export function undoDepth<TMeta>(state: ScopedHistoryState<TMeta>, scopeId: string): number {
  return stacksOf(state, scopeId).undo.length
}

export function redoDepth<TMeta>(state: ScopedHistoryState<TMeta>, scopeId: string): number {
  return stacksOf(state, scopeId).redo.length
}

export function scopeByteSize<TMeta>(state: ScopedHistoryState<TMeta>, scopeId: string): number {
  return stacksOf(state, scopeId).undo.reduce((sum, entry) => sum + entry.byteLength, 0)
}

export function canUndo<TMeta>(state: ScopedHistoryState<TMeta>, scopeId: string): boolean {
  return stacksOf(state, scopeId).undo.length > 0
}

export function canRedo<TMeta>(state: ScopedHistoryState<TMeta>, scopeId: string): boolean {
  return stacksOf(state, scopeId).redo.length > 0
}

export function getEmptyStacks(): ScopeStacks<never> {
  return { undo: [...EMPTY_STACKS.undo], redo: [...EMPTY_STACKS.redo] }
}
