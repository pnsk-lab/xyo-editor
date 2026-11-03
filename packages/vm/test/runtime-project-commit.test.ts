import { describe, expect, it } from 'bun:test'
import { ScratchVM } from '../src/index'

describe('commitRuntimeSnapshot', () => {
  it('commits detached live values, preserves editor state and assets, and notifies listeners', async () => {
    const vm = new ScratchVM()
    const original = vm.snapshot()
    const asset = original.project.targets[1]!.costumes[0]!
    const bytes = await vm.loadAsset(asset.md5ext!, asset.dataFormat)
    let clears = 0
    let draws = 0
    vm.attachRenderer({ clearCachedCostumes: () => { clears++ }, requestDraw: () => { draws++ } })
    const events: string[] = []
    for (const event of ['PROJECT_CHANGED', 'TARGETS_UPDATE', 'WORKSPACE_UPDATE']) vm.on(event, () => events.push(event))
    const detached = vm.snapshot()
    detached.project.targets[1]!.x = 123
    detached.project.targets[1]!.variables.score = ['score', 42]
    detached.selectedTargetId = detached.project.targets[0]!.id!
    detached.origin = 'different'
    vm.commitRuntimeSnapshot(detached)
    detached.project.targets[1]!.x = 999
    expect(vm.getTarget('sprite1')!.x).toBe(123)
    expect(vm.getTarget('sprite1')!.variables.score).toEqual(['score', 42])
    expect(vm.snapshot().selectedTargetId).toBe(original.selectedTargetId)
    expect(vm.snapshot().origin).toBe(original.origin)
    expect(await vm.loadAsset(asset.md5ext!, asset.dataFormat)).toEqual(bytes)
    expect(clears).toBe(0)
    expect(draws).toBeGreaterThan(0)
    expect(events).toEqual(['PROJECT_CHANGED', 'TARGETS_UPDATE', 'WORKSPACE_UPDATE'])
  })

  it('invalidates all project lookup and compiled caches', () => {
    const vm = new ScratchVM()
    const internals = vm as unknown as { variableLookupCache: WeakMap<object, unknown>; listLookupCache: WeakMap<object, unknown>; reporterCache: WeakMap<object, unknown>; statementCache: WeakMap<object, unknown>; procedureCache: WeakMap<object, unknown>; hatCache: Map<string, unknown> }
    const key = {}
    for (const cache of [internals.variableLookupCache, internals.listLookupCache, internals.reporterCache, internals.statementCache, internals.procedureCache]) cache.set(key, {})
    internals.hatCache.set('hat', [])
    vm.commitRuntimeSnapshot(vm.snapshot())
    for (const cache of [internals.variableLookupCache, internals.listLookupCache, internals.reporterCache, internals.statementCache, internals.procedureCache]) expect(cache.has(key)).toBe(false)
    expect(internals.hatCache.size).toBe(0)
  })

  it('rejects active snapshots and preserves the project on failure', () => {
    const vm = new ScratchVM()
    const before = vm.snapshot()
    const detached = vm.snapshot()
    detached.project.targets[1]!.x = 100
    detached.running = true
    expect(() => vm.commitRuntimeSnapshot(detached)).toThrow()
    expect(vm.snapshot()).toEqual(before)
    detached.running = false
    detached.project.targets = detached.project.targets.filter((target) => target.id !== before.selectedTargetId)
    expect(() => vm.commitRuntimeSnapshot(detached)).toThrow()
    expect(vm.snapshot()).toEqual(before)
  })
})
