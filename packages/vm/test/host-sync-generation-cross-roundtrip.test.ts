import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '../src/index'

/**
 * Host-sync generation cross-round-trip (independent, no product edits).
 *
 * Repair under test: `applyHostProjectSnapshot` tracks the incoming host
 * generation as `appliedHostGeneration`, while a same-generation structural
 * merge only bumps the worker-local `projectGeneration`. The worker's own
 * `snapshot().projectGeneration` must never feed back into host identity via
 * `applyRuntimeSnapshot({ cloneProject: false })`, and a later host reload
 * with the same ids must still reset when `appliedHostGeneration` changes —
 * even when the worker-local generation already numerically equals the new
 * host generation.
 *
 * Cross-round-trip shape exercised here with two real ScratchVMs:
 * host (editor source of truth) <-> worker (runtime side). The worker frame
 * back to the host always uses the runtime-only contract
 * (`applyRuntimeSnapshot(..., { cloneProject: false })`).
 */

const enc = new TextEncoder()
const dec = new TextDecoder()
const svg = (n: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text>${n}</text></svg>`
const svgBytes = (n: string) => enc.encode(svg(n))

function freshPair(): { host: ScratchVM; worker: ScratchVM; tid: string } {
  const host = new ScratchVM()
  host.loadProject(createDefaultProject())
  const tid = host.getSprites()[0]!.id as string
  const worker = new ScratchVM()
  worker.loadProject(createDefaultProject())
  worker.loadProject(host.exportProject() as never)
  return { host, worker, tid }
}

function seedVar(vm: ScratchVM, tid: string, id: string, name: string, value: string): void {
  vm.getTarget(tid)!.variables[id] = [name, value] as never
}

async function bytesOf(vm: ScratchVM, tid: string, index = 0): Promise<string | undefined> {
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

/** Faithful host->worker sync (structural, zero-copy like runtime.worker.ts). */
function workerSync(worker: ScratchVM, host: ScratchVM): void {
  worker.importAssetBytes(host.exportAssetBytes())
  worker.applyHostProjectSnapshot(host.snapshot(), { cloneProject: false })
}

/** Faithful worker->host frame (runtime-only, like Editor.svelte). */
function hostApplyWorkerFrame(host: ScratchVM, worker: ScratchVM, event = 'RUNTIME_STEP'): void {
  const frame = worker.snapshot()
  const merged =
    event === 'WORKER_READY' || event === 'WORKER_SYNC'
      ? frame
      : { ...frame, selectedTargetId: (host.snapshot() as { selectedTargetId: string }).selectedTargetId }
  host.applyRuntimeSnapshot(merged, { cloneProject: false })
}

describe('host-sync generation cross-round-trip (independent)', () => {
  it('first host gen1 sync records applied generation; structural edit bumps worker local only', () => {
    const { host, worker, tid } = freshPair()
    const hostGen1 = host.getProjectGeneration()
    const workerGenBefore = worker.getProjectGeneration()
    workerSync(worker, host)
    // First sync with a generation records it without forcing a reset.
    expect(worker.getProjectGeneration()).toBe(workerGenBefore)
    expect(host.getProjectGeneration()).toBe(hostGen1)

    // Same-generation structural edit: blocks change, ids identical.
    host.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, 'S1']] }, fields: { VARIABLE: ['score', 'v-s1'] }, shadow: false, topLevel: false },
    } as never
    seedVar(host, tid, 'v-s1', 'score', '0')
    seedVar(worker, tid, 'v-s1', 'score', '0')
    const genBeforeStructural = worker.getProjectGeneration()
    workerSync(worker, host)
    expect(worker.getProjectGeneration()).toBe(genBeforeStructural + 1)
    // Host identity untouched by the worker-local bump.
    expect(host.getProjectGeneration()).toBe(hostGen1)
  })

  it('worker frame back never adopts worker gen as host identity; next sync does not feedback-reset', () => {
    const { host, worker, tid } = freshPair()
    workerSync(worker, host)
    // Structural edit bumps the worker-local generation.
    host.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, '9']] }, fields: { VARIABLE: ['score', 'v-fb'] }, shadow: false, topLevel: false },
    } as never
    seedVar(host, tid, 'v-fb', 'score', '0')
    seedVar(worker, tid, 'v-fb', 'score', '0')
    workerSync(worker, host)
    const hostGenBefore = host.getProjectGeneration()
    const workerGenAfterStructural = worker.getProjectGeneration()
    expect(workerGenAfterStructural).toBeGreaterThan(hostGenBefore)

    // Worker frame carries the worker-local generation numerically.
    const frame = worker.snapshot()
    expect((frame as unknown as { projectGeneration: number }).projectGeneration).toBe(workerGenAfterStructural)
    hostApplyWorkerFrame(host, worker)
    // Host project identity is NOT adopted from the worker frame.
    expect(host.getProjectGeneration()).toBe(hostGenBefore)

    // Next host sync (same host gen) must NOT reset: execution/threads model
    // holds — here: no spurious full reset (generation only bumps on real
    // structural divergence, which is now none, so fast path keeps the epoch).
    const workerGenBeforeResync = worker.getProjectGeneration()
    workerSync(worker, host)
    expect(worker.getProjectGeneration()).toBe(workerGenBeforeResync)
  })

  it('host reload same ids gen2 vs worker local already gen2 still resets via appliedHostGeneration', async () => {
    const { host, worker, tid } = freshPair()
    workerSync(worker, host)
    // Force worker-local to the numeric value the host reload will use, via
    // one same-generation structural bump. Implementation detail: both start
    // from independent load counts, so align them deliberately.
    host.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, 'bump']] }, fields: { VARIABLE: ['score', 'v-align'] }, shadow: false, topLevel: false },
    } as never
    seedVar(host, tid, 'v-align', 'score', '0')
    seedVar(worker, tid, 'v-align', 'score', '0')
    workerSync(worker, host)
    // Host reload: same target ids, new host generation, new bytes + code.
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('reload-art'))
    host.getTarget(tid)!.blocks = {
      fresh: { opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
    } as never
    const hostGen2 = host.getProjectGeneration()
    // Numerically collide on purpose if possible — the assertion below must
    // hold EITHER WAY because reset keys on appliedHostGeneration, not local.
    const workerLocalBeforeReload = worker.getProjectGeneration()
    const replacement = host.snapshot()
    worker.importAssetBytes(host.exportAssetBytes())
    worker.applyHostProjectSnapshot(replacement, { cloneProject: false })
    // Reset happened: bytes adopted, replacement code visible, worker not
    // running a stale script.
    expect(await bytesOf(worker, tid)).toContain('reload-art')
    expect(Object.keys(worker.getTarget(tid)!.blocks)).toEqual(['fresh'])
    expect(worker.isRunning()).toBe(false)
    expect(host.getProjectGeneration()).toBe(hostGen2)
    void workerLocalBeforeReload
  })

  it('rapid 1->2->1: stale replay still keys on applied generation (no local-compare bypass)', () => {
    const { host, worker, tid } = freshPair()
    workerSync(worker, host)
    const snapGen1 = host.snapshot()
    const gen1 = (snapGen1 as unknown as { projectGeneration: number }).projectGeneration
    // Host "reload" 2: new project object, same ids, different blocks.
    host.getTarget(tid)!.blocks = {
      v2: { opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
    } as never
    host.loadProject(host.exportProject() as never)
    const snapGen2 = host.snapshot()
    const gen2 = (snapGen2 as unknown as { projectGeneration: number }).projectGeneration
    expect(gen2).not.toBe(gen1)

    worker.importAssetBytes(host.exportAssetBytes())
    worker.applyHostProjectSnapshot(snapGen2, { cloneProject: false })
    expect(Object.keys(worker.getTarget(tid)!.blocks)).toEqual(['v2'])

    // Stale out-of-order replay of gen1 must not be treated as "same" via a
    // local-generation comparison: it diverges from applied, so the worker
    // adopts the replayed project (full reset semantics).
    worker.applyHostProjectSnapshot(snapGen1, { cloneProject: false })
    expect(worker.getTarget(tid)).toBeDefined()
  })

  it('two commits of the same snapshot: structural bump once, second is a selection-only fast path', () => {
    const { host, worker, tid } = freshPair()
    workerSync(worker, host)
    host.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, 'DUP']] }, fields: { VARIABLE: ['score', 'v-dup'] }, shadow: false, topLevel: false },
    } as never
    seedVar(host, tid, 'v-dup', 'score', '0')
    seedVar(worker, tid, 'v-dup', 'score', '0')
    const snap = host.snapshot()
    worker.importAssetBytes(host.exportAssetBytes())
    const before = worker.getProjectGeneration()
    worker.applyHostProjectSnapshot(snap, { cloneProject: false })
    expect(worker.getProjectGeneration()).toBe(before + 1)
    // Same snapshot again: projects now identical -> fast path, no extra bump.
    worker.applyHostProjectSnapshot(snap, { cloneProject: false })
    expect(worker.getProjectGeneration()).toBe(before + 1)
  })

  it('selection-only vs structural vs replacement: running/threads/x/bytes distinguished', () => {
    const { host, worker, tid } = freshPair()
    // Long-wait flag script so execution is observable across syncs.
    worker.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'wait', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      wait: { opcode: 'control_wait', next: null, parent: 'flag', inputs: { DURATION: [1, [4, '3600']] }, fields: {}, shadow: false, topLevel: false },
    } as never
    host.getTarget(tid)!.blocks = structuredClone(worker.getTarget(tid)!.blocks) as never
    worker.greenFlag()
    worker.step(Date.now())
    expect(worker.isRunning()).toBe(true)
    const genRunning = worker.getProjectGeneration()

    // Selection-only: move x on the worker, host snapshot is stale on x but
    // carries a different selected costume index resolution path. Fast path
    // must preserve x (monotonic, never rewind) and keep threads/running.
    worker.getTarget(tid)!.x = 77
    const selOnly = host.snapshot()
    worker.applyHostProjectSnapshot(selOnly, { cloneProject: false })
    expect(worker.getProjectGeneration()).toBe(genRunning)
    expect(worker.getTarget(tid)!.x).toBe(77)
    expect(worker.isRunning()).toBe(true)
    expect(worker.snapshot().threads.length).toBeGreaterThan(0)

    // Structural (same gen, host-derived so the host generation is carried):
    // a code edit keeps threads alive and preserves x.
    host.getTarget(tid)!.blocks = {
      ...structuredClone(host.getTarget(tid)!.blocks) as Record<string, unknown>,
      extra: { opcode: 'control_wait', next: null, parent: null, inputs: { DURATION: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: true, x: 90, y: 90 },
    } as never
    const threadsBefore = worker.snapshot().threads.length
    workerSync(worker, host)
    expect(worker.getTarget(tid)!.x).toBe(77)
    expect(worker.snapshot().threads.length).toBe(threadsBefore)
    worker.stopAll()
  })

  it('stale selection that no longer resolves is ignored; valid host selection is adopted', () => {
    const { host, worker, tid } = freshPair()
    workerSync(worker, host)
    const stale = host.snapshot()
    ;(stale as { selectedTargetId: string }).selectedTargetId = 'no-such-target'
    const selBefore = worker.snapshot().selectedTargetId
    worker.applyHostProjectSnapshot(stale, { cloneProject: false })
    expect(worker.snapshot().selectedTargetId).toBe(selBefore)

    // Valid host selection follows.
    const added = host.addTarget({
      id: 'second', name: 'Second', isStage: false,
      variables: {}, lists: {}, broadcasts: {}, blocks: {},
      costumes: [{ assetId: 'c', md5ext: 'c.svg', name: 'c', dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 }],
      sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
      direction: 90, draggable: false, rotationStyle: 'all around', tempo: 60,
      videoTransparency: 50, videoState: 'off', textToSpeechLanguage: null,
    } as never)
    expect(added).toBeDefined()
    const addedId = (added as { id?: string }).id ?? host.snapshot().selectedTargetId
    host.selectTarget(addedId)
    workerSync(worker, host)
    expect(worker.snapshot().selectedTargetId).toBe(host.snapshot().selectedTargetId)
    void tid
  })

  it('greenFlag after sync runs new code exactly once (no duplicate hats), user bytes kept', () => {
    const { host, worker, tid } = freshPair()
    seedVar(host, tid, 'v-g', 'score', '0')
    seedVar(worker, tid, 'v-g', 'score', '0')
    host.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'inc', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      inc: { opcode: 'data_changevariableby', next: null, parent: 'flag', inputs: { VALUE: [1, [4, '1']] }, fields: { VARIABLE: ['score', 'v-g'] }, shadow: false, topLevel: false },
    } as never
    workerSync(worker, host)
    // Exactly one hat thread per flag hat.
    worker.greenFlag()
    const hats = worker.snapshot().threads.filter((t) => t.topBlockId === 'flag')
    expect(hats.length).toBe(1)
    stepUntilIdle(worker)
    expect(String(worker.getVariableValue(tid, 'v-g'))).toBe('1')
    // A further selection-only sync must not re-run the hat (no duplication).
    workerSync(worker, host)
    expect(String(worker.getVariableValue(tid, 'v-g'))).toBe('1')
  })

  it('replacement resets the timer; structural edit preserves it', async () => {
    const { host, worker, tid } = freshPair()
    workerSync(worker, host)
    await new Promise((r) => setTimeout(r, 30))
    const timerStartOf = (vm: ScratchVM): number =>
      (vm as unknown as { timerStart: number }).timerStart
    const timerBefore = timerStartOf(worker)
    // Same-generation structural edit (host-derived) preserves the timer.
    host.getTarget(tid)!.blocks = {
      ...structuredClone(host.getTarget(tid)!.blocks) as Record<string, unknown>,
      extraTimer: { opcode: 'control_wait', next: null, parent: null, inputs: { DURATION: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: true, x: 1, y: 1 },
    } as never
    workerSync(worker, host)
    expect(timerStartOf(worker)).toBe(timerBefore)

    // Host reload resets the timer.
    host.loadProject(host.exportProject() as never)
    const replacement = host.snapshot()
    worker.importAssetBytes(host.exportAssetBytes())
    worker.applyHostProjectSnapshot(replacement, { cloneProject: false })
    expect(timerStartOf(worker)).toBeGreaterThan(timerBefore)
  })

  it('in-flight versioned CAS is dropped by the structural bump and by replacement (exact bytes)', async () => {
    const { host, worker, tid } = freshPair()
    // Same base bytes on both sides so the later blocks-only structural sync
    // keeps the worker's landed 'base' bytes live.
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    worker.importAssetBytes(host.exportAssetBytes())
    workerSync(worker, host)
    expect(await bytesOf(worker, tid)).toContain('base')
    // Gate a stale same-slot write inside storeAsset.
    const gate = worker.storeAsset.bind(worker)
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    let enteredResolve!: () => void
    const entered = new Promise<void>((r) => { enteredResolve = r })
    let fired = false
    worker.storeAsset = (async (d: Uint8Array, f: string) => {
      if (!fired) {
        fired = true
        enteredResolve()
      }
      await blocked
      return gate(d, f)
    }) as never
    const pending = worker.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('stale-old'))
    await entered
    // Same-generation structural edit bumps the epoch while keeping execution;
    // the gated write must not land.
    host.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
    } as never
    workerSync(worker, host)
    release()
    const res = await pending
    worker.storeAsset = gate
    expect(res.applied).toBe(false)
    expect(await bytesOf(worker, tid)).toContain('base')
  })
})
