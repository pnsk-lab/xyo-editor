/**
 * Vector discrete-save guard (stamp / rect-oval-line drag commit).
 *
 * Split out of `Editor.svelte` per `packages/editor/AGENTS.md` (features/
 * owns paint-editor logic). Pure + framework-free: the Editor captures a
 * scope synchronously (no await in between) and re-validates it after every
 * await. Any mismatch aborts silently — no selection, status, or history
 * writes — so a target/costume switch, project replacement, or structural
 * shift during a delayed drain can never steer the shape into the newly
 * selected asset.
 *
 * Scope (all synchronous at capture time):
 * - `targetId` / `index`: stable target id + costume slot the save belongs to.
 * - `paintScopeKey` / `paintScopeGeneration`: Editor paint-history scope; a
 *   switch or explicit clear bumps the generation, invalidating in-flight saves.
 * - `projectGeneration`: `vm.getProjectGeneration()`; whole-project
 *   replacement (`loadProject`/`clear`) bumps it and discards queued writes.
 * - `targetEpoch`: per-target structure epoch from the write gate
 *   (`getTargetVectorEpoch`); delete/reorder/duplicate/restore bumps it.
 * - `structureSeq`: VM per-target structure sequence
 *   (`vm.getCostumeStructureSeq`); same index-shifting mutations bump it.
 *
 * History discipline: callers `peek` (detached, no stack effects) and commit
 * only after a successful CAS while the scope is still current. The guarded
 * commit drops stale completions with redo preserved, so a late completion
 * never deletes a concurrent edit's history entry.
 */

export type VectorEditorCommitKind = 'applied' | 'conflict' | 'skipped'

export interface VectorEditorCommitSuccess {
  kind: 'applied'
  /** Runtime-normalized SVG text that was committed. */
  svgText: string
  /** Live slot identity returned by the VM (`writeSeq` included). */
  current?: { assetId?: string | null; md5ext?: string | null; writeSeq?: number | null }
}

export interface VectorEditorCommitFailure {
  kind: 'conflict' | 'skipped'
  /**
   * Machine-readable reason:
   * - `external`: a versioned CAS mismatch — a same-slot external write won.
   * - `epoch`: per-target structure epoch moved (delete/reorder/duplicate).
   * - `superseded`: selection / paint scope / project generation moved.
   */
  reason: 'external' | 'epoch' | 'superseded'
  /**
   * Bytes safe to display: the live external text when the scope is still
   * current, otherwise the attempted text (caller must not paint it while
   * superseded).
   */
  svgText: string
  current?: { assetId?: string | null; md5ext?: string | null; writeSeq?: number | null }
}

export type VectorEditorCommitResult = VectorEditorCommitSuccess | VectorEditorCommitFailure

export function isVectorCommitApplied(
  result: VectorEditorCommitResult,
): result is VectorEditorCommitSuccess {
  return result.kind === 'applied'
}

/** Synchronous snapshot for one discrete vector save. All fields are values. */
export interface VectorDiscreteSaveScope {
  targetId: string
  index: number
  paintScopeKey: string
  paintScopeGeneration: number
  projectGeneration: number
  targetEpoch: number
  structureSeq: number
}

export interface VectorDiscreteSaveLive {
  selectedTargetId: string | undefined
  selectedIndex: number | undefined
  paintScopeKey: string
  paintScopeGeneration: number
  projectGeneration: number
  targetEpoch: number
  structureSeq: number
}

/**
 * True while the live Editor/VM state still belongs to the captured save.
 * Pure comparison — callers supply the live values (no VM access here so
 * this stays framework-free and unit-testable).
 */
export function isDiscreteSaveScopeCurrent(
  scope: VectorDiscreteSaveScope,
  live: VectorDiscreteSaveLive,
): boolean {
  if (live.selectedTargetId === undefined) return false
  if (live.selectedTargetId !== scope.targetId) return false
  if (live.selectedIndex !== scope.index) return false
  if (live.paintScopeKey !== scope.paintScopeKey) return false
  if (live.paintScopeGeneration !== scope.paintScopeGeneration) return false
  if (live.projectGeneration !== scope.projectGeneration) return false
  if (live.targetEpoch !== scope.targetEpoch) return false
  if (live.structureSeq !== scope.structureSeq) return false
  return true
}

export function discreteSaveScopeOf(
  targetId: string,
  index: number,
  paintScopeKey: string,
  paintScopeGeneration: number,
  projectGeneration: number,
  targetEpoch: number,
  structureSeq: number,
): VectorDiscreteSaveScope {
  return {
    targetId,
    index,
    paintScopeKey,
    paintScopeGeneration,
    projectGeneration,
    targetEpoch,
    structureSeq,
  }
}

/**
 * Conflict-report eligibility after the Editor's own generation bump.
 *
 * A discrete save that loses its CAS to a same-slot external write bumps
 * `paintScopeGeneration` (invalidating the just-peeked history) before its
 * caller re-checks scope — a naive check would read the self-inflicted bump
 * as "superseded" and stay silent, leaving the external write's own
 * `Project changed` status in place instead of the conflict status the
 * design documents. Same-slot external writes never move any other scope
 * component (no selection/paint-scope/project/epoch change), so
 * generation == scope + 1 with everything else equal means the scope is
 * still current and the conflict status must be reported. Any real switch,
 * replacement, or structural shift still fails this check and stays silent.
 */
export function isDiscreteSaveScopeCurrentAfterOwnBump(
  scope: VectorDiscreteSaveScope,
  live: VectorDiscreteSaveLive,
): boolean {
  if (live.selectedTargetId !== scope.targetId) return false
  if (live.selectedIndex !== scope.index) return false
  if (live.paintScopeKey !== scope.paintScopeKey) return false
  if (live.paintScopeGeneration !== scope.paintScopeGeneration + 1) return false
  if (live.projectGeneration !== scope.projectGeneration) return false
  if (live.targetEpoch !== scope.targetEpoch) return false
  if (live.structureSeq !== scope.structureSeq) return false
  return true
}
