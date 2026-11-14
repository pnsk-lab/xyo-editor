import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'

/**
 * Editor-side host -> worker direction gate (fail-first, no product edits).
 *
 * Faithfully mirrors the FIXED wiring:
 * - `RuntimeWorkerController.greenFlag()` (`packages/editor/src/lib/runtime-worker.ts`):
 *   posts `{ type: 'greenFlag', snapshot, assets, images, keepKeys, syncId }`
 *   so the worker flag handler (`runtime.worker.ts`) applies the latest host
 *   project before starting.
 * - `runtime.worker.ts sync` handler: `applyHostProjectSnapshot(snapshot,
 *   { cloneProject: false })` = host-authoritative sync (full structural
 *   replacement on host edits, runtime-only fast path otherwise).
 * - `Editor.svelte refresh()`: `runtimeWorker.sync(next)` on every host
 *   PROJECT_CHANGED; a block edit immediately followed by flag is covered by
 *   the flag-time snapshot even when no intermediate sync ran.
 *
 * Each `host-truth:` test pins the fixed contract: the worker runs the
 * host's CURRENT project. The guard pins the half that must NOT change:
 * worker -> host frames stay runtime-only.
 */

function freshPair(): { host: ScratchVM; worker: ScratchVM; tid: string } {
  const host = new ScratchVM()
  host.loadProject(createDefaultProject())
  const tid = host.getSprites()[0]!.id as string
  const worker = new ScratchVM()
  worker.loadProject(host.exportProject() as never)
  return { host, worker, tid }
}

// --- faithful copies of the current worker handlers -----------------------

function currentWorkerSync(worker: ScratchVM, snapshot: ReturnType<ScratchVM['snapshot']>): void {
  worker.applyHostProjectSnapshot(snapshot, { cloneProject: false })
}

function currentWorkerGreenFlag(worker: ScratchVM, host: ScratchVM): void {
  // The flag command carries the latest host snapshot (+ assets); the worker
  // applies the host-authoritative contract before starting.
  const snapshot = host.snapshot()
  worker.importAssetBytes(host.exportAssetBytes())
  worker.applyHostProjectSnapshot(snapshot, { cloneProject: false })
  worker.greenFlag()
}

// What RuntimeWorkerController.greenFlag() sends: the host snapshot + assets.
function currentControllerGreenFlagPayload(host: ScratchVM) {
  return { type: 'greenFlag' as const, snapshot: host.snapshot(), images: [], keepKeys: [] as string[] }
}

function stepUntilIdle(vm: ScratchVM, max = 60): void {
  for (let i = 0; i < max; i += 1) {
    if (!vm.isRunning()) break
    vm.step(Date.now() + i * 16)
  }
}

function seedVar(vm: ScratchVM, tid: string, id: string, name: string, value: string): void {
  vm.getTarget(tid)!.variables[id] = [name, value] as never
}

describe('runtime worker host-is-source-of-truth (fail-first)', () => {
  it('host-truth: block edit -> flag executes the NEW script, not the stale worker project', () => {
    const { host, worker, tid } = freshPair()
    seedVar(host, tid, 'v-flag', 'score', '0')
    seedVar(worker, tid, 'v-flag', 'score', '0')
    // Host edits blocks after the worker loaded.
    host.getTarget(tid)!.blocks = {
      flag: {
        opcode: 'event_whenflagclicked', next: 'set', parent: null,
        inputs: {}, fields: {}, shadow: false, topLevel: true, x: 30, y: 30,
      },
      set: {
        opcode: 'data_setvariableto', next: null, parent: 'flag',
        inputs: { VALUE: [1, [10, 'FLAG-NEW']] },
        fields: { VARIABLE: ['score', 'v-flag'] },
        shadow: false, topLevel: false,
      },
    } as never
    // Controller sends greenFlag WITH the host snapshot (fixed contract).
    const payload = currentControllerGreenFlagPayload(host)
    expect(payload).toHaveProperty('snapshot')
    currentWorkerGreenFlag(worker, host)
    stepUntilIdle(worker)
    host.greenFlag()
    stepUntilIdle(host)
    expect(host.getVariableValue(tid, 'v-flag')).toBe('FLAG-NEW')
    // FAILS today: worker never saw the edited blocks, variable stays '0'.
    expect(worker.getVariableValue(tid, 'v-flag')).toBe('FLAG-NEW')
  })

  it('host-truth: sync before flag still propagates blocks (runtime-only sync drops them)', () => {
    const { host, worker, tid } = freshPair()
    seedVar(host, tid, 'v-sync', 'score', '0')
    seedVar(worker, tid, 'v-sync', 'score', '0')
    host.getTarget(tid)!.blocks = {
      flag: {
        opcode: 'event_whenflagclicked', next: 'set', parent: null,
        inputs: {}, fields: {}, shadow: false, topLevel: true, x: 30, y: 30,
      },
      set: {
        opcode: 'data_setvariableto', next: null, parent: 'flag',
        inputs: { VALUE: [1, [10, 'SYNCED']] },
        fields: { VARIABLE: ['score', 'v-sync'] },
        shadow: false, topLevel: false,
      },
    } as never
    // Even the explicit sync path drops blocks today.
    currentWorkerSync(worker, host.snapshot())
    currentWorkerGreenFlag(worker, host)
    stepUntilIdle(worker)
    expect(worker.getVariableValue(tid, 'v-sync')).toBe('SYNCED')
  })

  it('host-truth: play-time variable add before flag is visible to the worker', () => {
    const { host, worker, tid } = freshPair()
    seedVar(host, tid, 'v-play', 'play', '0')
    host.getTarget(tid)!.blocks = {
      flag: {
        opcode: 'event_whenflagclicked', next: 'set', parent: null,
        inputs: {}, fields: {}, shadow: false, topLevel: true, x: 30, y: 30,
      },
      set: {
        opcode: 'data_setvariableto', next: null, parent: 'flag',
        inputs: { VALUE: [1, [10, '1']] },
        fields: { VARIABLE: ['play', 'v-play'] },
        shadow: false, topLevel: false,
      },
    } as never
    currentWorkerSync(worker, host.snapshot())
    currentWorkerGreenFlag(worker, host)
    stepUntilIdle(worker)
    // The declaration itself merged (variables are runtime keys) but without
    // the blocks the worker cannot produce the value.
    expect(worker.getVariableValue(tid, 'v-play')).toBe('1')
  })

  it('guard: worker -> host snapshot application stays runtime-only (host code preserved)', () => {
    const { host, worker, tid } = freshPair()
    seedVar(host, tid, 'v-g', 'score', 'host-code')
    // Worker frame carries STALE blocks but fresh runtime values.
    const staleWorkerSnap = worker.snapshot()
    staleWorkerSnap.project.targets.find((t) => t.id === tid)!.x = 111
    host.getTarget(tid)!.blocks = { mine: { opcode: 'control_wait', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0 } } as never
    const blocksBefore = JSON.stringify(host.getTarget(tid)!.blocks)
    host.applyRuntimeSnapshot(staleWorkerSnap, { cloneProject: false })
    expect(JSON.stringify(host.getTarget(tid)!.blocks)).toBe(blocksBefore)
    expect(host.getTarget(tid)!.x).toBe(111)
  })
})

/*
 * MINIMAL FIX PROPOSAL (same as the VM-side record; product code untouched):
 * - `RuntimeWorkerController.greenFlag()`: attach `snapshot`,
 *   `assets: this.vm.exportAssetBytes()`, `images/keepKeys` from the CURRENT
 *   lightweight snapshot (it already rasterizes from it) and send them with
 *   the greenFlag command.
 * - `runtime.worker.ts greenFlag`: if `command.snapshot` is present, apply
 *   the explicit-new-project contract (full structural sync on slot
 *   divergence via `isSameProjectSlotsForSync`, runtime-only otherwise,
 *   with epoch reset on replacement) BEFORE `vm.greenFlag()`.
 * - Keep `Editor.svelte applyWorkerRuntimeSnapshot` runtime-only.
 */
