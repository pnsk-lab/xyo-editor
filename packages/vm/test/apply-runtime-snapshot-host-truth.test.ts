import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '../src/index'

/**
 * Host-is-source-of-truth gate for the runtime-only `applyRuntimeSnapshot`.
 *
 * Current `VM.applyRuntimeSnapshot(snapshot, { cloneProject: false })`
 * (packages/vm/src/index.ts `mergeRuntimeStateOnly`) intentionally merges
 * ONLY runtime-mutable fields (x/y/variables/lists/currentCostume/...
 * + clones + monitors) so a stale worker frame never overwrites host
 * costume bytes / CAS epoch. That is correct for worker -> host frames.
 *
 * The host -> worker direction used by
 * `packages/editor/src/lib/runtime.worker.ts` must therefore use the
 * explicit host-authoritative contract instead:
 *   `sync`  -> `vm.applyHostProjectSnapshot(command.snapshot, { cloneProject: false })`
 *   `greenFlag` -> apply `command.snapshot` the same way, then `vm.greenFlag()`
 * so block edits, sprite add/remove, costume add/remove/reorder and sound
 * add/remove made on the host reach the worker, and `greenFlag` executes
 * the host's CURRENT project. The helpers below mirror that wiring.
 *
 * This suite reproduces the worker side faithfully (same two calls, same
 * options) with two ScratchVMs: `host` is the editor source of truth,
 * `worker` is the runtime.worker.ts VM. Every `host-truth:` test FAILS on
 * the current runtime-only merge and PASSES once the host -> worker path
 * performs a legitimate "explicit new project" contract (full structural
 * sync when the host hands over a new project), while the worker -> host
 * guards (stale-worker never overwrites host bytes, CAS epoch preserved)
 * keep passing.
 *
 * Product code is NOT touched by this file (fail-first record only).
 * Minimal fix proposal is in the trailing comment.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()
const svg = (n: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text>${n}</text></svg>`
const svgBytes = (n: string) => enc.encode(svg(n))

function freshPair(): { host: ScratchVM; worker: ScratchVM; tid: string } {
  const host = new ScratchVM()
  host.loadProject(createDefaultProject())
  const tid = host.getSprites()[0]!.id as string
  const worker = new ScratchVM()
  worker.loadProject(createDefaultProject())
  // Align ids: default projects use stable ids, but force-sync once via the
  // OLD full-replacement path so both start from the same logical project.
  worker.loadProject(host.exportProject() as never)
  return { host, worker, tid }
}

/** Faithful copy of runtime.worker.ts `sync` handler (structural part). */
function workerSync(worker: ScratchVM, host: ScratchVM): void {
  const snapshot = host.snapshot()
  // runtime.worker.ts `sync`: host-authoritative sync — full structural
  // replacement on host edits, runtime-only fast path otherwise.
  worker.importAssetBytes(host.exportAssetBytes())
  worker.applyHostProjectSnapshot(snapshot, { cloneProject: false })
}

/** Faithful copy of runtime.worker.ts `greenFlag` handler (with snapshot). */
function workerGreenFlag(worker: ScratchVM, host: ScratchVM): void {
  // runtime.worker.ts `greenFlag`: apply the latest host snapshot (sent with
  // the flag command by RuntimeWorkerController.greenFlag) then flag.
  const snapshot = host.snapshot()
  worker.importAssetBytes(host.exportAssetBytes())
  worker.applyHostProjectSnapshot(snapshot, { cloneProject: false })
  worker.greenFlag()
}

function seedVar(vm: ScratchVM, tid: string, id: string, name: string, value: string): void {
  const t = vm.getTarget(tid)!
  t.variables[id] = [name, value] as never
}

function seedList(vm: ScratchVM, tid: string, id: string, name: string, value: string[]): void {
  const t = vm.getTarget(tid)!
  t.lists[id] = [name, [...value]] as never
}

function flagSetsVar(host: ScratchVM, tid: string, varId: string, value: string): void {
  const target = host.getTarget(tid)!
  target.blocks = {
    flag: {
      opcode: 'event_whenflagclicked', next: 'set', parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true, x: 30, y: 30,
    },
    set: {
      opcode: 'data_setvariableto', next: null, parent: 'flag',
      inputs: { VALUE: [1, [10, value]] },
      fields: { VARIABLE: ['my variable', varId] },
      shadow: false, topLevel: false,
    },
  } as never
}

function stepUntilIdle(vm: ScratchVM, max = 50): void {
  for (let i = 0; i < max; i += 1) {
    if (!vm.isRunning()) break
    vm.step(Date.now() + i * 16)
  }
}

describe('applyRuntimeSnapshot host-is-source-of-truth (fail-first)', () => {
  it('host-truth: block edit before flag reaches the worker (runtime-only merge loses it)', () => {
    const { host, worker, tid } = freshPair()
    const varId = 'var-block-edit'
    seedVar(host, tid, varId, 'my variable', '0')
    seedVar(worker, tid, varId, 'my variable', '0')
    // Host edits the flag script AFTER the worker already loaded the project.
    flagSetsVar(host, tid, varId, 'EDITED-42')
    workerSync(worker, host)
    workerGreenFlag(worker, host)
    stepUntilIdle(worker)
    // Direct-ScratchVM reference: the same project run on the host itself
    // produces EDITED-42. The worker must match the host (source of truth).
    host.greenFlag()
    stepUntilIdle(host)
    expect(host.getVariableValue(tid, varId)).toBe('EDITED-42')
    expect(worker.getVariableValue(tid, varId)).toBe('EDITED-42')
  })

  it('host-truth: added sprite + its flag script runs on the worker', () => {
    const { host, worker } = freshPair()
    const added = host.addTarget({
      // NOTE: VM.addTarget assigns a fresh unique id (`uniqueTargetId`
      // always suffixes), so the harness names the sprite 'sprite-added'
      // and resolves it by stable display name below — the VM API contract
      // (unique ids) is intentionally left untouched.
      id: 'sprite-added', name: 'sprite-added', isStage: false,
      variables: { 'var-added': ['score', '0'] },
      lists: {}, broadcasts: {}, blocks: {
        flag: {
          opcode: 'event_whenflagclicked', next: 'set', parent: null,
          inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10,
        },
        set: {
          opcode: 'data_setvariableto', next: null, parent: 'flag',
          inputs: { VALUE: [1, [10, '7']] },
          fields: { VARIABLE: ['score', 'var-added'] },
          shadow: false, topLevel: false,
        },
      },
      costumes: [{ assetId: 'c1', md5ext: 'c1.svg', name: 'c', dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 }],
      sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
      direction: 90, draggable: false, rotationStyle: 'all around', tempo: 60,
      videoTransparency: 50, videoState: 'off', textToSpeechLanguage: null,
    } as never)
    expect(added).toBeDefined()
    workerSync(worker, host)
    workerGreenFlag(worker, host)
    stepUntilIdle(worker)
    expect(worker.getTarget('sprite-added')).toBeDefined()
    expect(worker.getVariableValue('sprite-added', 'var-added')).toBe('7')
  })

  it('old-vs-new semantics: full replacement (loadProject) always reflected; runtime-only merge is the regression', () => {
    const { host, worker, tid } = freshPair()
    seedVar(host, tid, 'v-old', 'score', '0')
    seedVar(worker, tid, 'v-old', 'score', '0')
    flagSetsVar(host, tid, 'v-old', 'OLD-PATH-OK')
    // OLD semantics (before runtime-only change): whole-project replacement.
    worker.loadProject(host.exportProject() as never)
    worker.greenFlag()
    stepUntilIdle(worker)
    expect(worker.getVariableValue(tid, 'v-old')).toBe('OLD-PATH-OK')
    // Host-authoritative sync: the same host edit via applyHostProjectSnapshot.
    const worker2 = new ScratchVM()
    worker2.loadProject(createDefaultProject())
    seedVar(worker2, tid, 'v-old', 'score', '0')
    workerSync(worker2, host)
    workerGreenFlag(worker2, host)
    stepUntilIdle(worker2)
    // Regression pin: the same edit must survive the host -> worker sync.
    expect(worker2.getVariableValue(tid, 'v-old')).toBe('OLD-PATH-OK')
  })

  it('host-truth: removed sprite disappears from the worker', () => {
    const { host, worker, tid } = freshPair()
    expect(worker.getTarget(tid)).toBeDefined()
    host.deleteTarget(tid)
    workerSync(worker, host)
    expect(worker.getTarget(tid)).toBeUndefined()
  })

  it('host-truth: added costume is visible to the worker (count + switch)', async () => {
    const { host, worker, tid } = freshPair()
    const before = worker.getTarget(tid)!.costumes.length
    await host.addCostume(tid, { name: 'added', dataFormat: 'svg', assetId: 'added-c', md5ext: 'added-c.svg' }, tid)
    workerSync(worker, host)
    expect(worker.getTarget(tid)!.costumes.length).toBe(before + 1)
    expect(worker.getTarget(tid)!.costumes.some((c) => c.md5ext === 'added-c.svg')).toBe(true)
  })

  it('host-truth: added sound reaches the worker project', () => {
    const { host, worker, tid } = freshPair()
    host.addSound(tid, { name: 'pop', assetId: 'pop-avm', md5ext: 'pop-avm.wav', dataFormat: 'wav', rate: 22050, sampleCount: 100 } as never)
    workerSync(worker, host)
    expect(worker.getTarget(tid)!.sounds.some((s) => s.md5ext === 'pop-avm.wav')).toBe(true)
  })

  it('host-truth: new variable declaration + setter block executes on worker', () => {
    const { host, worker, tid } = freshPair()
    seedVar(host, tid, 'v-new', 'fresh', '0')
    flagSetsVar(host, tid, 'v-new', '99')
    workerSync(worker, host)
    workerGreenFlag(worker, host)
    stepUntilIdle(worker)
    expect(worker.getVariableValue(tid, 'v-new')).toBe('99')
  })

  it('host-truth: new list + add-to-list block executes on worker', () => {
    const { host, worker, tid } = freshPair()
    seedList(host, tid, 'l-new', 'items', [])
    const target = host.getTarget(tid)!
    target.blocks = {
      flag: {
        opcode: 'event_whenflagclicked', next: 'add', parent: null,
        inputs: {}, fields: {}, shadow: false, topLevel: true, x: 30, y: 30,
      },
      add: {
        opcode: 'data_addtolist', next: null, parent: 'flag',
        inputs: { ITEM: [1, [10, 'hello']] },
        fields: { LIST: ['items', 'l-new'] },
        shadow: false, topLevel: false,
      },
    } as never
    workerSync(worker, host)
    workerGreenFlag(worker, host)
    stepUntilIdle(worker)
    host.greenFlag()
    stepUntilIdle(host)
    expect(hostList(host, tid, 'l-new')).toContain('hello')
    expect(workerList(worker, tid, 'l-new')).toContain('hello')
  })

  it('host-truth: execution output and snapshot agree during play (live values flow, blocks stay host-owned)', () => {
    const { host, worker, tid } = freshPair()
    seedVar(host, tid, 'v-live', 'score', '0')
    seedVar(worker, tid, 'v-live', 'score', '0')
    flagSetsVar(host, tid, 'v-live', 'LIVE')
    // Baseline: worker loaded the project BEFORE the edit, so it runs stale.
    // After the fix, workerSync must carry the blocks and live output must
    // equal the worker snapshot's variable value.
    workerSync(worker, host)
    workerGreenFlag(worker, host)
    stepUntilIdle(worker)
    const snap = worker.snapshot()
    const snapVal = snap.project.targets.find((t) => t.id === tid)!.variables['v-live']?.[1]
    expect(worker.getVariableValue(tid, 'v-live')).toBe('LIVE')
    expect(snapVal).toBe('LIVE')
  })

  it('guard (must keep passing): stale worker frame never overwrites host costume bytes', async () => {
    const { host, worker, tid } = freshPair()
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('host-bytes'))
    const hostBytes = await bytesOf(host, tid, 0)
    // Stale worker still holds the OLD costume; its frame must not clobber host.
    const stale = worker.snapshot()
    stale.project.targets.find((t) => t.id === tid)!.x = 999
    host.applyRuntimeSnapshot(stale, { cloneProject: false })
    expect(await bytesOf(host, tid, 0)).toBe(hostBytes)
    expect(host.getTarget(tid)!.x).toBe(999)
  })

  it('guard (must keep passing): same-project runtime sync preserves generation + writeSeq', async () => {
    const { host, tid } = freshPair()
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const gen = host.getProjectGeneration()
    const seq = host.getCostumeWriteSeq(tid, 0)
    const snap = host.snapshot()
    snap.project.targets.find((t) => t.id === tid)!.x = 5
    snap.running = false
    snap.threads = []
    host.applyRuntimeSnapshot(snap, { cloneProject: false })
    expect(host.getProjectGeneration()).toBe(gen)
    expect(host.getCostumeWriteSeq(tid, 0)).toBe(seq)
    expect(host.getTarget(tid)!.x).toBe(5)
  })

  it('guard (must keep passing): commit on same project bumps generation once, keeps seq, drops gated write', async () => {
    const { host, tid } = freshPair()
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const seq = host.getCostumeWriteSeq(tid, 0)
    const gen = host.getProjectGeneration()
    const gate = host.storeAsset.bind(host)
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    host.storeAsset = (async (d: Uint8Array, f: string) => { await blocked; return gate(d, f) }) as never
    const pending = host.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('gated'))
    await new Promise((r) => setTimeout(r, 20))
    const snap = host.snapshot()
    const edited = JSON.parse(JSON.stringify(snap)) as typeof snap
    edited.running = false
    edited.threads = []
    host.commitRuntimeSnapshot(edited)
    expect(host.getProjectGeneration()).toBe(gen + 1)
    release()
    const res = await pending
    host.storeAsset = gate
    expect(res.applied).toBe(false)
    expect(host.getCostumeWriteSeq(tid, 0)).toBe(seq)
  })

  it('contract: cloneProject true still owes structural sync for an explicit new project (old async write must not cross)', async () => {
    const { host, worker, tid } = freshPair()
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('v1'))
    // Old gated host write starts BEFORE the worker hands over its snapshot.
    const gate = host.storeAsset.bind(host)
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    host.storeAsset = (async (d: Uint8Array, f: string) => { await blocked; return gate(d, f) }) as never
    const pending = host.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('old-gated'))
    await new Promise((r) => setTimeout(r, 20))
    // Worker hands over an EXPLICIT new project (different costume bytes identity).
    const incoming = worker.snapshot()
    const stored = await gate(svgBytes('worker-new'), 'svg')
    const wt = incoming.project.targets.find((t) => t.id === tid)!
    wt.costumes[0] = { ...wt.costumes[0]!, assetId: stored.assetId, md5ext: stored.md5ext, dataFormat: 'svg' }
    // cloneProject:true = "I am giving you a new project object, take it".
    // It must be reflected structurally (costume identity changes).
    host.applyRuntimeSnapshot(incoming, { cloneProject: true })
    release()
    const res = await pending
    host.storeAsset = gate
    expect(res.applied).toBe(false)
    expect(host.getTarget(tid)!.costumes[0]!.md5ext).toBe(stored.md5ext)
  })
})

async function bytesOf(vm: ScratchVM, tid: string, index: number): Promise<string | undefined> {
  const c = vm.getTarget(tid)?.costumes[index]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  const b = await vm.loadAsset(key, c?.dataFormat ?? 'svg')
  return b ? dec.decode(b) : undefined
}

function hostList(vm: ScratchVM, tid: string, id: string): unknown[] {
  const t = vm.getTarget(tid)!
  return (t.lists[id]?.[1] ?? []) as unknown[]
}

function workerList(vm: ScratchVM, tid: string, id: string): unknown[] {
  const t = vm.getTarget(tid)
  if (!t) return []
  return (t.lists[id]?.[1] ?? []) as unknown[]
}

/*
 * MINIMAL FIX PROPOSAL (product code untouched — implement separately):
 *
 * The worker needs BOTH modes, selected by an explicit host contract:
 *
 *   1. `sync` (host -> worker, structural): replace the runtime-only merge
 *      with a full project replacement when the host hands over a project
 *      whose slot identity DIVERGED (`!isSameProjectSlotsForSync(
 *      worker.project, incoming.project)`), i.e. blocks/costumes/sounds/
 *      target set/order changed. Same-slot-identity frames stay runtime-only
 *      (preserve worker CAS epoch exactly like today). Replacement must go
 *      through the same epoch reset as `loadProject` (`resetCostumeWriteEpoch`)
 *      so old async writes can never cross the boundary. `cloneProject:false`
 *      may keep its zero-copy fast path ONLY for the same-identity case.
 *   2. `greenFlag` (host -> worker, start): include the host snapshot in the
 *      greenFlag command (`{ type:'greenFlag', snapshot, assets, images,
 *      keepKeys, syncId }`) and apply step (1) BEFORE `vm.greenFlag()`,
 *      otherwise a block edit -> flag with no intermediate `sync` always runs
 *      stale. `RuntimeWorkerController.greenFlag()` already rasterizes from
 *      `vm.lightweightSnapshot()` — forward that snapshot + `exportAssetBytes()`.
 *   3. Keep worker -> host (`Editor.svelte applyWorkerRuntimeSnapshot`) as
 *      runtime-only merge: a stale worker project must never overwrite host
 *      code/assets (today's behavior is the correct half).
 *
 * Concretely (worker):
 * ```ts
 * case 'sync': {
 *   applyingHostSnapshot = true; stopFrameTimer()
 *   vm.importAssetBytes(command.assets)
 *   cacheCostumeImages(command.images, true, command.keepKeys, command.snapshot)
 *   vm.applyHostProjectSnapshot(command.snapshot) // NEW: full-or-runtime merge
 *   ...
 * }
 * case 'greenFlag': {
 *   applyingHostSnapshot = true
 *   if (command.snapshot) {
 *     vm.importAssetBytes(command.assets ?? {})
 *     cacheCostumeImages(command.images, true, command.keepKeys, command.snapshot)
 *     vm.applyHostProjectSnapshot(command.snapshot) // NEW
 *   } else cacheCostumeImages(command.images, true, command.keepKeys)
 *   applyingHostSnapshot = false
 *   vm.greenFlag(); beginFrameTimer(); break
 * }
 * ```
 * with `VM.applyHostProjectSnapshot(snapshot)` = same-identity ? runtime-only
 * merge (today's `mergeRuntimeStateOnly`) : full replacement + epoch reset.
 * A cheaper alternative is `await vm.loadProject(snapshot.project)` on every
 * host sync/flag, but that discards the CAS-epoch fast path and must still
 * import assets first; the branch above keeps both.
 */
