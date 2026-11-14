import { describe, expect, it } from 'bun:test'
import {
  discreteSaveScopeOf,
  isDiscreteSaveScopeCurrent,
  isVectorCommitApplied,
  type VectorDiscreteSaveScope,
} from '../src/features/costumes/vector-discrete-save'

function liveOf(scope: VectorDiscreteSaveScope, patch: Record<string, unknown> = {}) {
  return {
    selectedTargetId: scope.targetId,
    selectedIndex: scope.index,
    paintScopeKey: scope.paintScopeKey,
    paintScopeGeneration: scope.paintScopeGeneration,
    projectGeneration: scope.projectGeneration,
    targetEpoch: scope.targetEpoch,
    structureSeq: scope.structureSeq,
    ...patch,
  }
}

describe('vector-discrete-save scope guard', () => {
  const scope = discreteSaveScopeOf('target-A', 0, 'paint:target-A:0', 3, 7, 1, 0)

  it('stays current when nothing moved', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope))).toBe(true)
  })

  it('rejects a target switch', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope, { selectedTargetId: 'target-B' }))).toBe(false)
  })

  it('rejects a costume-index switch on the same target', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope, { selectedIndex: 1 }))).toBe(false)
  })

  it('rejects a paint-scope key change (target switch via history scope)', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope, { paintScopeKey: 'paint:target-A:1' }))).toBe(false)
  })

  it('rejects a paint-generation bump (external-conflict invalidation / clear)', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope, { paintScopeGeneration: 4 }))).toBe(false)
  })

  it('rejects a project-generation bump (loadProject / clear)', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope, { projectGeneration: 8 }))).toBe(false)
  })

  it('rejects a write-gate epoch bump (delete / reorder / duplicate)', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope, { targetEpoch: 2 }))).toBe(false)
  })

  it('rejects a VM structure-sequence bump (index-shifting mutation)', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope, { structureSeq: 1 }))).toBe(false)
  })

  it('rejects a lost selection', () => {
    expect(isDiscreteSaveScopeCurrent(scope, liveOf(scope, { selectedTargetId: undefined }))).toBe(false)
  })

  it('distinguishes applied from conflict/skipped CAS results', () => {
    expect(isVectorCommitApplied({ kind: 'applied', svgText: '<svg/>' })).toBe(true)
    expect(isVectorCommitApplied({ kind: 'conflict', reason: 'external', svgText: '<svg/>' })).toBe(false)
    expect(isVectorCommitApplied({ kind: 'skipped', reason: 'epoch', svgText: '<svg/>' })).toBe(false)
  })
})
