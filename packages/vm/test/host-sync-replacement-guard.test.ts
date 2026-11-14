import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '../src/index'

/**
 * Host-sync replacement guard (fail-first, hostile review).
 *
 * `applyHostProjectSnapshot` (host -> worker direction) currently merges
 * EVERYTHING in place and preserves `projectGeneration` even for a full
 * project replacement that merely reuses the same target ids. That leaves
 * the replacement boundary implicit (it only holds today via object-identity
 * side effects) and keeps stale execution alive:
 *
 * - no explicit reset/generation contract: a replacement must bump the
 *   costume-write epoch and drop execution, normal edits must not;
 * - snapshots carry no host generation, so the worker cannot tell a
 *   replacement from an edit;
 * - a parent stuck in `broadcastAndWait` on a dropped child waits forever;
 * - clones share `blocks/comments/costumes/sounds` references with their
 *   owner, so an in-place owner merge leaves clones running stale code.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()
const svg = (n: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text>${n}</text></svg>`
const svgBytes = (n: string) => enc.encode(svg(n))
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function freshPair(): { host: ScratchVM; worker: ScratchVM; tid: string } {
  const host = new ScratchVM()
  host.loadProject(createDefaultProject())
  const tid = host.getSprites()[0]!.id as string
  const worker = new ScratchVM()
  worker.loadProject(createDefaultProject())
  worker.loadProject(host.exportProject() as never)
  return { host, worker, tid }
}

async function bytesOf(vm: ScratchVM, tid: string, index: number): Promise<string | undefined> {
  const c = vm.getTarget(tid)?.costumes[index]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  const b = await vm.loadAsset(key, c?.dataFormat ?? 'svg')
  return b ? dec.decode(b) : undefined
}

function stepUntilIdle(vm: ScratchVM, max = 60): void {
  for (let i = 0; i < max; i += 1) {
    if (!vm.isRunning()) break
    vm.step(Date.now() + i * 16)
  }
}

describe('host sync replacement guard (fail-first)', () => {
  it('snapshots carry the host project generation', () => {
    const { host } = freshPair()
    const gen = host.getProjectGeneration()
    const snap = host.snapshot() as unknown as Record<string, unknown>
    expect(snap.projectGeneration).toBe(gen)
    host.loadProject(createDefaultProject())
    expect(host.snapshot().projectGeneration).toBe(host.getProjectGeneration())
    expect(host.getProjectGeneration()).toBeGreaterThan(gen)
  })

  it('explicit reset replaces the project and discards a stale gated write', async () => {
    const { host, worker, tid } = freshPair()
    await worker.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('worker-base'))
    const genBefore = worker.getProjectGeneration()
    // Old-project gated write blocks inside storeAsset. Await the actual
    // `storeAsset` entry (not a tick) so the reload always lands inside the
    // await window deterministically.
    const gate = worker.storeAsset.bind(worker)
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    let enteredResolve!: () => void
    const entered = new Promise<void>((r) => { enteredResolve = r })
    let enteredFired = false
    worker.storeAsset = (async (d: Uint8Array, f: string) => {
      if (!enteredFired) {
        enteredFired = true
        enteredResolve()
      }
      await blocked
      return gate(d, f)
    }) as never
    const pending = worker.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('old-gated'))
    await entered
    // Host hands over an explicit new project reusing the same target id.
    const incoming = host.snapshot()
    const stored = await gate(svgBytes('new-exact'), 'svg')
    const wt = incoming.project.targets.find((t) => t.id === tid)!
    wt.costumes[0] = { ...wt.costumes[0]!, assetId: stored.assetId, md5ext: stored.md5ext, dataFormat: 'svg' }
    wt.blocks = { fresh: { opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 } } as never
    worker.importAssetBytes(host.exportAssetBytes())
    worker.applyHostProjectSnapshot(incoming, { cloneProject: false, reset: true })
    expect(worker.getProjectGeneration()).toBeGreaterThan(genBefore)
    expect(worker.isRunning()).toBe(false)
    release()
    const res = await pending
    worker.storeAsset = gate
    expect(res.applied).toBe(false)
    expect(worker.getTarget(tid)!.costumes[0]!.md5ext).toBe(stored.md5ext)
  })

  it('host generation change forces a reset without an explicit flag', async () => {
    const { host, worker, tid } = freshPair()
    // Baseline sync records the host generation on the worker.
    worker.applyHostProjectSnapshot(host.snapshot(), { cloneProject: false })
    const genBefore = worker.getProjectGeneration()
    // Host replaces the whole project (same ids, new art + new code).
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('host-new'))
    const replacement = host.snapshot()
    expect((replacement as unknown as Record<string, unknown>).projectGeneration).not.toBeUndefined()
    worker.importAssetBytes(host.exportAssetBytes())
    worker.applyHostProjectSnapshot(replacement, { cloneProject: false })
    expect(worker.getProjectGeneration()).toBeGreaterThan(genBefore)
    expect(worker.isRunning()).toBe(false)
    expect(await bytesOf(worker, tid, 0)).toContain('host-new')
  })

  it('same-generation structural edit preserves execution (no forced reset)', () => {
    const { host, worker, tid } = freshPair()
    const target = worker.getTarget(tid)!
    target.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'wait', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      wait: { opcode: 'control_wait', next: null, parent: 'flag', inputs: { DURATION: [1, [4, '3600']] }, fields: {}, shadow: false, topLevel: false },
    } as never
    worker.greenFlag()
    worker.step(Date.now())
    expect(worker.isRunning()).toBe(true)
    const genBefore = worker.getProjectGeneration()
    const threadsBefore = worker.snapshot().threads.length
    expect(threadsBefore).toBeGreaterThan(0)
    // Same-generation host edit (comment only): must preserve execution.
    const incoming = worker.snapshot()
    incoming.project.targets.find((t) => t.id === tid)!.comments = { c1: { text: 'note' } } as never
    worker.applyHostProjectSnapshot(incoming, { cloneProject: false })
    expect(worker.getProjectGeneration()).toBe(genBefore)
    expect(worker.isRunning()).toBe(true)
    expect(worker.snapshot().threads.length).toBe(threadsBefore)
    worker.stopAll()
  })

  it('broadcastAndWait parent does not hang on a child dropped by a structural edit', () => {
    const { worker, tid } = freshPair()
    const target = worker.getTarget(tid)!
    target.variables = { v: ['done', '0'] }
    target.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'bwait', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      bwait: { opcode: 'event_broadcastandwait', next: 'set', parent: 'flag', inputs: { BROADCAST_INPUT: [1, [10, 'go']] }, fields: {}, shadow: false, topLevel: false },
      set: { opcode: 'data_setvariableto', next: null, parent: 'bwait', inputs: { VALUE: [1, [10, 'parent-done']] }, fields: { VARIABLE: ['done', 'v'] }, shadow: false, topLevel: false },
      recv: { opcode: 'event_whenbroadcastreceived', next: 'cwait', parent: null, inputs: {}, fields: { BROADCAST_OPTION: ['go', 'recv'] }, shadow: false, topLevel: true, x: 60, y: 10 },
      cwait: { opcode: 'control_wait', next: null, parent: 'recv', inputs: { DURATION: [1, [4, '3600']] }, fields: {}, shadow: false, topLevel: false },
    } as never
    worker.greenFlag()
    worker.step(Date.now())
    worker.step(Date.now() + 16)
    expect(worker.snapshot().threads.length).toBe(2)
    // Structural edit removes the receiver hat: the child is dropped and the
    // parent must not wait on it forever.
    const incoming = worker.snapshot()
    const live = incoming.project.targets.find((t) => t.id === tid)!
    delete (live.blocks as Record<string, unknown>).recv
    delete (live.blocks as Record<string, unknown>).cwait
    worker.applyHostProjectSnapshot(incoming, { cloneProject: false })
    worker.step(Date.now() + 32)
    worker.step(Date.now() + 48)
    const threads = worker.snapshot().threads
    expect(threads.length).toBe(0)
    expect(worker.isRunning()).toBe(false)
  })

  it('clones re-point to the owner blocks after a structural edit', () => {
    const { worker, tid } = freshPair()
    const target = worker.getTarget(tid)!
    target.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'clone', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      clone: { opcode: 'control_create_clone_of', next: null, parent: 'flag', inputs: {}, fields: { CLONE_OPTION: ['_myself_', '_myself_'] }, shadow: false, topLevel: false },
    } as never
    worker.greenFlag()
    stepUntilIdle(worker)
    const clones = worker.snapshot().project.targets.filter((t) => t.isClone)
    expect(clones.length).toBe(1)
    // Structural edit touches the owner blocks.
    const incoming = worker.snapshot()
    const live = incoming.project.targets.find((t) => t.id === tid)!
    ;(live.blocks as Record<string, unknown>).extra = { opcode: 'control_wait', next: null, parent: null, inputs: { DURATION: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: true, x: 90, y: 90 }
    worker.applyHostProjectSnapshot(incoming, { cloneProject: false })
    const owner = worker.getTarget(tid)!
    const clone = worker.snapshot().project.targets.find((t) => t.isClone)!
    expect(clone.cloneOf).toBe(owner.id ?? owner.name)
    expect(clone.blocks).toEqual(owner.blocks)
    worker.stopAll()
  })

  it('stale gated write never lands on the replacement exact bytes', async () => {
    const { host, worker, tid } = freshPair()
    await worker.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const gate = worker.storeAsset.bind(worker)
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    let enteredResolve!: () => void
    const entered = new Promise<void>((r) => { enteredResolve = r })
    let enteredFired = false
    worker.storeAsset = (async (d: Uint8Array, f: string) => {
      if (!enteredFired) {
        enteredFired = true
        enteredResolve()
      }
      await blocked
      return gate(d, f)
    }) as never
    const pending = worker.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('stale-old'))
    await entered
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('replacement-exact'))
    const replacement = host.snapshot()
    worker.importAssetBytes(host.exportAssetBytes())
    worker.applyHostProjectSnapshot(replacement, { cloneProject: false, reset: true })
    release()
    const res = await pending
    worker.storeAsset = gate
    expect(res.applied).toBe(false)
    expect(await bytesOf(worker, tid, 0)).toContain('replacement-exact')
  })
})
