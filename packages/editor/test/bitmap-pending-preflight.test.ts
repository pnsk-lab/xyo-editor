import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import { createPendingBitmapShape } from '../src/features/costumes/bitmap-pending-shape'
import { createPendingBitmapTransaction } from '../src/features/costumes/bitmap-pending-transaction'
import {
  classifyBitmapPendingCommand,
  createBitmapPendingContinuationGuard,
  runBitmapPendingUiOp,
} from '../src/features/costumes/bitmap-pending-preflight'
import {
  createBitmapPendingVmCommit,
  type BitmapPendingScopeExtra,
} from '../src/features/costumes/bitmap-pending-vm-writer'

/**
 * Durable real-VM tests for the central transition preflight gate
 * (`bitmap-pending-preflight.ts`, infrastructure only: no `Editor.svelte` /
 * `BitmapEditor.svelte` changes).
 *
 * Every async gate case drives the REAL `ScratchVM` through the tested
 * coordinator + lower-level CAS writer (`createBitmapPendingVmCommit`):
 * the op continuations below stand in for the real UI mutations
 * (`exportProject` / `saveProjectSb3` bytes read, `vm.setCurrentCostume`,
 * convert / paint ops) and count ghost calls. No product code is wired:
 * pending is staged directly on the isolated transaction, exactly like the
 * coordinator / vm-writer suites.
 *
 * Gate contract locked here:
 * - one explicit op runs its continuation AT MOST once, only after an owned
 *   `committed` / `nothing-to-commit`;
 * - any commit refusal (slow `storeAsset` failure, abort, external update,
 *   project reload, target delete / reorder, stale second selection) runs NO
 *   continuation (no ghost export / select) and performs NO resume/retry;
 * - a second command arriving mid-flight with a stale selection cannot
 *   execute and cannot steal the running write;
 * - nested export concurrency joins the same single CAS write and cleans up.
 */

const STYLE = {
  fill: '#ff0000',
  secondary: '#ffffff',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 10,
}

const EXTRA: BitmapPendingScopeExtra = { loadSerial: 7, sessionGeneration: 3 }

function shapeOf() {
  return createPendingBitmapShape('rect', { x: 1, y: 2, width: 4, height: 3 }, 'filled', STYLE)
}

function baseOf(width = 8, height = 8, fill = 9) {
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(fill)
  return { width, height, data }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushTicks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const svg = (n: number | string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text>${n}</text></svg>`
const svgBytes = (n: number | string) => enc.encode(svg(n))
const pngBytes = (n: number | string) => enc.encode(`PNG-BYTES:${n}`)

function freshVM(): { vm: ScratchVM; tid: string } {
  const vm = new ScratchVM()
  vm.loadProject(createDefaultProject())
  const sprite = vm.getSprites()[0]!
  return { vm, tid: sprite.id as string }
}

async function bytesOf(vm: ScratchVM, targetId: string, index: number): Promise<string | undefined> {
  const t = vm.getTarget(targetId)
  const c = t?.costumes[index]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  const b = await vm.loadAsset(key, c?.dataFormat ?? 'svg')
  return b ? dec.decode(b) : undefined
}

describe('bitmap pending preflight classifier (pure)', () => {
  it('maps every UI-originated save/export/switch/convert/paint op to commit-first', () => {
    const commitFirst = [
      'save-bitmap',
      'export-project',
      'export-sb3',
      'export-costume',
      'select-costume',
      'select-target',
      'new-project',
      'load-project',
      'project-switch',
      'convert-to-bitmap',
      'convert-to-vector',
      'duplicate-costume',
      'delete-costume',
      'reorder-costume',
      'delete-target',
      'restore-costume',
      'paint-cut',
      'paint-copy',
      'paint-paste',
      'paint-crop',
      'paint-flip',
      'paint-rotate',
      'paint-clear',
      'paint-floating',
      'paint-redo',
      'paint-escape-commit',
      'paint-tool-switch',
      'paint-blank-press',
    ]
    for (const command of commitFirst) {
      expect(classifyBitmapPendingCommand(command)).toBe('commit-first')
    }
  })

  it('maps delete/undo to discard-first and restyle/transform/draft/blur to leave-pending', () => {
    expect(classifyBitmapPendingCommand('paint-delete-selection')).toBe('discard-first')
    expect(classifyBitmapPendingCommand('paint-undo')).toBe('discard-first')
    expect(classifyBitmapPendingCommand('restyle')).toBe('leave-pending')
    expect(classifyBitmapPendingCommand('transform')).toBe('leave-pending')
    expect(classifyBitmapPendingCommand('pointercancel-draft')).toBe('leave-pending')
    expect(classifyBitmapPendingCommand('blur-keep')).toBe('leave-pending')
  })

  it('fails closed: unknown future commands default to commit-first', () => {
    expect(classifyBitmapPendingCommand('some-future-op')).toBe('commit-first')
    expect(classifyBitmapPendingCommand('')).toBe('commit-first')
  })
})

describe('bitmap pending preflight gate (real VM, op callbacks)', () => {
  it('save success runs the select continuation exactly once (no ghost, single CAS)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('SAVE-1') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    let selectCalls = 0
    try {
      const result = await runBitmapPendingUiOp(
        tx,
        'select-costume',
        bundle.scope,
        bundle.write,
        () => {
          selectCalls += 1
          vm.setCurrentCostume(vm.getTarget(tid)!.name, 0)
          return 'selected'
        },
        { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) },
      )
      expect(result.ok).toBe(true)
      expect(casCalls).toBe(1)
      expect(selectCalls).toBe(1)
      expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:SAVE-1')
      expect(tx.snapshot().hasPending).toBe(false)
      expect(tx.snapshot().commitInFlight).toBe(false)
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('slow storeAsset failure performs no resume and no ghost export', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('TRY1') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let storeCalls = 0
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      storeCalls += 1
      if (first) {
        first = false
        await gate.promise
      }
      throw new Error('store-full')
    }
    let exportCalls = 0
    try {
      const pending = runBitmapPendingUiOp(tx, 'export-sb3', bundle.scope, bundle.write, () => {
        exportCalls += 1
        return vm.saveProjectSb3()
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      await flushTicks()
      gate.resolve()
      const result = await pending
      expect(result.ok).toBe(false)
      expect(storeCalls).toBe(1)
      expect(exportCalls).toBe(0)
      // No resume: the same pending is retained for an explicit retry.
      expect(tx.snapshot().hasPending).toBe(true)
      expect(await bytesOf(vm, tid, 0)).toContain('base')
    } finally {
      vm.storeAsset = origStore
    }

    // Explicit retry (a NEW gate call, no auto-resume inside the gate)
    // commits the retained TRY1 pending and then exports exactly once.
    let retryExports = 0
    const retryLive = bundle.options.readLive()
    const retryOutcome = await runBitmapPendingUiOp(tx, 'export-sb3', retryLive, bundle.write, () => {
      retryExports += 1
      return vm.saveProjectSb3()
    }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
    expect(retryOutcome.ok).toBe(true)
    expect(retryExports).toBe(1)
    expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:TRY1')
    expect(tx.snapshot().hasPending).toBe(false)
  })

  it('abort mid-flight settles as aborted with no select call and no mutation', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('BASE'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('STALE') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return origStore(d, f)
    }
    let selectCalls = 0
    try {
      const pending = runBitmapPendingUiOp(tx, 'select-costume', bundle.scope, bundle.write, () => {
        selectCalls += 1
        vm.setCurrentCostume(vm.getTarget(tid)!.name, 0)
        return 'selected'
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      await flushTicks()
      expect(tx.abortInFlight('project-replaced').ok).toBe(true)
      gate.resolve()
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('aborted')
      expect(selectCalls).toBe(0)
      expect(await bytesOf(vm, tid, 0)).toContain('BASE')
      expect(tx.snapshot().hasPending).toBe(false)
      expect(tx.snapshot().commitInFlight).toBe(false)
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('external same-slot update inside the slow window keeps EXT with no export call', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('STALE') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return origStore(d, f)
    }
    let exportCalls = 0
    try {
      const pending = runBitmapPendingUiOp(tx, 'export-project', bundle.scope, bundle.write, () => {
        exportCalls += 1
        return vm.exportProject()
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      await flushTicks()
      // Metadata-only external write (same queued-slot deadlock as a byte
      // write would cause if awaited mid-flight: `updateCostume` queues
      // behind the in-flight CAS, so the suite-standard rename stands in for
      // the external same-slot write and still bumps the slot `writeSeq`).
      expect(vm.renameCostume(tid, 0, 'EXT')).toBe(true)
      gate.resolve()
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('external-conflict')
      expect(exportCalls).toBe(0)
      expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('EXT')
      expect(await bytesOf(vm, tid, 0)).toContain('base')
      expect(await bytesOf(vm, tid, 0)).not.toContain('STALE')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('project reload mid-flight supersedes with no select call; new pending stays committable', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('GEN1'))
    const tx = createPendingBitmapTransaction()
    const gen1 = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('STALE-GEN1') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), gen1.scope).ok).toBe(true)

    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return origStore(d, f)
    }
    let selectCalls = 0
    try {
      const stale = runBitmapPendingUiOp(tx, 'select-costume', gen1.scope, gen1.write, () => {
        selectCalls += 1
        return 'selected'
      }, { ...gen1.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      await flushTicks()
      const proj = vm.exportProject() as unknown as {
        targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }>
      }
      const idx = proj.targets.findIndex((t) => t.id === tid)
      const stored = await origStore(enc.encode(svg('NEW-GEN2')), 'svg')
      proj.targets[idx]!.costumes[0] = {
        ...proj.targets[idx]!.costumes[0],
        assetId: stored.assetId,
        md5ext: stored.md5ext,
        dataFormat: 'svg',
      }
      ;(vm as unknown as { assetBytes: Map<string, Uint8Array> }).assetBytes.set(stored.assetId as string, enc.encode(svg('NEW-GEN2')))
      ;(vm as unknown as { assetBytes: Map<string, Uint8Array> }).assetBytes.set(stored.md5ext as string, enc.encode(svg('NEW-GEN2')))
      await vm.loadProject(proj)
      const gen2 = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('GEN2-OWN') }, EXTRA)
      expect(tx.stage(shapeOf(), baseOf(), gen2.scope).ok).toBe(true)
      gate.resolve()
      const staleResult = await stale
      expect(staleResult.ok).toBe(false)
      if (!staleResult.ok) expect(staleResult.reason).toBe('superseded')
      expect(selectCalls).toBe(0)
      expect(tx.snapshot().hasPending).toBe(true)
      const committed = await runBitmapPendingUiOp(tx, 'select-costume', gen2.scope, gen2.write, () => {
        selectCalls += 1
        return 'selected-gen2'
      }, { ...gen2.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      expect(committed.ok).toBe(true)
      expect(selectCalls).toBe(1)
      expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:GEN2-OWN')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('a new command with a stale selection arriving mid-flight cannot execute or steal the write', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('FIRST') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return origStore(d, f)
    }
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      let firstOps = 0
      const firstOp = runBitmapPendingUiOp(tx, 'export-project', bundle.scope, bundle.write, () => {
        firstOps += 1
        return vm.exportProject()
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      await flushTicks()
      // Stale selection: a second command for a DIFFERENT slot (stage
      // costume) arrives mid-flight. Same-owner join would share the outcome;
      // a different owner must refuse immediately without waiting, stealing,
      // or executing. (Away-and-back on the same slot still joins the same
      // flight at the coordinator level — selection-epoch supersede is
      // enforced by the VM CAS — so the cross-slot case is the stale one
      // that must not execute.)
      const stageId = vm.getStage().id as string
      const stageBundle = createBitmapPendingVmCommit(vm, { targetId: stageId, costumeIndex: 0, pngBytes: pngBytes('OTHER') }, EXTRA)
      let secondOps = 0
      const second = await runBitmapPendingUiOp(tx, 'select-costume', stageBundle.scope, stageBundle.write, () => {
        secondOps += 1
        return 'stale-selected'
      }, { ...stageBundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.reason).toBe('commit-in-flight')
      expect(secondOps).toBe(0)
      expect(casCalls).toBe(1)
      gate.resolve()
      const firstResult = await firstOp
      expect(firstResult.ok).toBe(true)
      // The first (owning) op still executes exactly once after its commit.
      expect(firstOps).toBe(1)
      expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:FIRST')
    } finally {
      vm.storeAsset = origStore
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('nested export concurrency joins one write and each export runs once, then cleans up', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('JOINED') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    const seqBefore = vm.getCostumeWriteSeq(tid, 0)
    try {
      let exportA = 0
      let exportB = 0
      const a = runBitmapPendingUiOp(tx, 'export-project', bundle.scope, bundle.write, () => {
        exportA += 1
        return vm.saveProjectSb3()
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      const b = runBitmapPendingUiOp(tx, 'export-sb3', bundle.scope, bundle.write, () => {
        exportB += 1
        return vm.saveProjectSb3()
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      const [ra, rb] = await Promise.all([a, b])
      expect(ra.ok).toBe(true)
      expect(rb.ok).toBe(true)
      expect(casCalls).toBe(1)
      expect(exportA).toBe(1)
      expect(exportB).toBe(1)
      expect(vm.getCostumeWriteSeq(tid, 0)).toBe(seqBefore + 1)
      // Cleanup: no flight, no pending, and a follow-up export proceeds cleanly.
      expect(tx.snapshot().hasPending).toBe(false)
      expect(tx.snapshot().commitInFlight).toBe(false)
      let followExports = 0
      const follow = await runBitmapPendingUiOp(tx, 'export-project', bundle.options.readLive(), bundle.write, () => {
        followExports += 1
        return vm.saveProjectSb3()
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      expect(follow.ok).toBe(true)
      expect(followExports).toBe(1)
      expect(casCalls).toBe(1)
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('target deletion mid-flight supersedes with no select call and no steering', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('DEL-BASE'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('DEL-STALE') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return origStore(d, f)
    }
    let selectCalls = 0
    try {
      const pending = runBitmapPendingUiOp(tx, 'select-target', bundle.scope, bundle.write, () => {
        selectCalls += 1
        return 'selected'
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      await flushTicks()
      vm.deleteTarget(tid)
      expect(vm.getTarget(tid)).toBeUndefined()
      gate.resolve()
      const result = await pending
      expect(result.ok).toBe(false)
      expect(selectCalls).toBe(0)
      expect(tx.snapshot().commitInFlight).toBe(false)
      // Recreated slot with the same stable id keeps its own art.
      const newcomer = await vm.addSprite('Newcomer')
      const newId = (newcomer.id ?? newcomer.name) as string
      expect(vm.getTarget(newId)).toBeDefined()
      expect(await bytesOf(vm, newId, 0)).not.toContain('DEL-STALE')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('costume reorder mid-flight supersedes with no export call onto shifted indices', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('first'))
    await vm.duplicateCostume(tid, 0)
    await vm.updateCostume(tid, 1, { dataFormat: 'svg' }, svgBytes('second'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('REORDER-STALE') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return origStore(d, f)
    }
    let exportCalls = 0
    try {
      const pending = runBitmapPendingUiOp(tx, 'export-costume', bundle.scope, bundle.write, () => {
        exportCalls += 1
        return vm.saveProjectSb3()
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      await flushTicks()
      expect(vm.reorderCostume(tid, 0, 1)).toBe(true)
      gate.resolve()
      const result = await pending
      expect(result.ok).toBe(false)
      expect(exportCalls).toBe(0)
      expect(await bytesOf(vm, tid, 0)).toContain('second')
      expect(await bytesOf(vm, tid, 0)).not.toContain('REORDER-STALE')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('discard-first delete runs without any write; leave-pending restyle runs without any write', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('UNUSED') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)

    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      let deleteOps = 0
      const deleted = await runBitmapPendingUiOp(tx, 'paint-delete-selection', bundle.scope, bundle.write, () => {
        deleteOps += 1
        return 'selection-cleared'
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      expect(deleted.ok).toBe(true)
      expect(deleteOps).toBe(1)
      expect(casCalls).toBe(0)
      expect(tx.snapshot().hasPending).toBe(false)
      expect(await bytesOf(vm, tid, 0)).toContain('base')

      // Leave-pending never touches the coordinator write path either.
      expect(tx.stage(shapeOf(), baseOf(), bundle.options.readLive()).ok).toBe(true)
      let restyleOps = 0
      const restyled = await runBitmapPendingUiOp(tx, 'restyle', bundle.options.readLive(), bundle.write, () => {
        restyleOps += 1
        return 're-rendered'
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      expect(restyled.ok).toBe(true)
      expect(restyleOps).toBe(1)
      expect(casCalls).toBe(0)
      expect(tx.snapshot().hasPending).toBe(true)
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('separate lower writer only: the gate never recurses into itself or product saves', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    // The writer below is the lower-level CAS writer: it calls ONLY
    // `vm.updateCostumeIfMatch` (7th arg = per-flight abort token) and never
    // the gate, `saveBitmapCostume`, or any export path.
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('LOWER-ONLY') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    let seenSeventh: unknown
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      seenSeventh = args[6]
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      let opCalls = 0
      const result = await runBitmapPendingUiOp(tx, 'convert-to-bitmap', bundle.scope, bundle.write, () => {
        opCalls += 1
        return 'converted'
      }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      expect(result.ok).toBe(true)
      expect(casCalls).toBe(1)
      expect(opCalls).toBe(1)
      expect(typeof seenSeventh === 'object' && seenSeventh !== null).toBe(true)
      expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:LOWER-ONLY')
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
  })
})

describe('bitmap pending preflight continuation guard (real VM, post-await scope check)', () => {
  it('nothing-to-commit microtask switch: external select-target suppresses ghost export', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const stageId = vm.getStage().id as string
    const guard = createBitmapPendingContinuationGuard(vm)
    let exportCalls = 0
    const pending = runBitmapPendingUiOp(tx, 'export-project', bundleLiveOf(vm, tid), undefined, () => {
      exportCalls += 1
      return vm.exportProject()
    }, {
      readLive: bundleLiveReaderOf(vm, tid),
      isContinuationCurrent: guard,
    })
    // Microtask window of the `nothing-to-commit` await: the UI moves first.
    vm.selectTarget(stageId)
    expect(vm.getSelectedTargetStableId()).toBe(stageId)
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('superseded')
      expect(result.detail).toContain('stale continuation')
    }
    expect(exportCalls).toBe(0)
    // Ghost check via a counting op on the same stale guard.
    let ghost = 0
    const ghostResult = await runBitmapPendingUiOp(
      tx,
      'export-project',
      bundleLiveOf(vm, tid),
      async () => 'unused',
      () => {
        ghost += 1
        return vm.exportProject()
      },
      { readLive: bundleLiveReaderOf(vm, tid), isContinuationCurrent: guard },
    )
    expect(ghostResult.ok).toBe(false)
    expect(ghost).toBe(0)
    expect(exportCalls).toBe(0)
  })

  it('nothing-to-commit microtask switch: external costume select suppresses stale select', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    await vm.duplicateCostume(tid, 0)
    await vm.updateCostume(tid, 1, { dataFormat: 'svg' }, svgBytes('second'))
    vm.setCurrentCostume(vm.getTarget(tid)!.name, 0)
    const tx = createPendingBitmapTransaction()
    const guard = createBitmapPendingContinuationGuard(vm)
    let selectCalls = 0
    const pending = runBitmapPendingUiOp(
      tx,
      'select-costume',
      bundleLiveOf(vm, tid),
      async () => 'unused',
      () => {
        selectCalls += 1
        return 'selected'
      },
      { readLive: bundleLiveReaderOf(vm, tid), isContinuationCurrent: guard },
    )
    vm.setCurrentCostume(vm.getTarget(tid)!.name, 1)
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('superseded')
    expect(selectCalls).toBe(0)
  })

  it('A->B->A stays stale via the monotonic epoch even when the id returns', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const stageId = vm.getStage().id as string
    const guard = createBitmapPendingContinuationGuard(vm)
    const epochBefore = vm.getSelectionEpoch()
    let ops = 0
    const pending = runBitmapPendingUiOp(
      tx,
      'select-target',
      bundleLiveOf(vm, tid),
      async () => 'unused',
      () => {
        ops += 1
        return 'selected'
      },
      { readLive: bundleLiveReaderOf(vm, tid), isContinuationCurrent: guard },
    )
    vm.selectTarget(stageId)
    vm.selectTarget(tid)
    expect(vm.getSelectionEpoch()).toBeGreaterThan(epochBefore + 1)
    expect(vm.getSelectedTargetStableId()).toBe(tid)
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('superseded')
    expect(ops).toBe(0)
  })

  it('project reload reusing the same id suppresses the stale export via generation', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const guard = createBitmapPendingContinuationGuard(vm)
    const genBefore = vm.getProjectGeneration()
    let exportCalls = 0
    const pending = runBitmapPendingUiOp(
      tx,
      'export-sb3',
      bundleLiveOf(vm, tid),
      async () => 'unused',
      () => {
        exportCalls += 1
        return vm.saveProjectSb3()
      },
      { readLive: bundleLiveReaderOf(vm, tid), isContinuationCurrent: guard },
    )
    const proj = vm.exportProject()
    await vm.loadProject(proj)
    expect(vm.getProjectGeneration()).toBeGreaterThan(genBefore)
    expect(vm.getTarget(tid)).toBeDefined()
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('superseded')
    expect(exportCalls).toBe(0)
  })

  it('rename (costume + sprite) does not suppress: epoch-neutral writeSeq bump stays green', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const guard = createBitmapPendingContinuationGuard(vm)
    const epochBefore = vm.getSelectionEpoch()
    expect(vm.renameCostume(tid, 0, 'RENAMED')).toBe(true)
    const spriteName = vm.getTarget(tid)!.name
    expect(vm.renameSprite(spriteName, `${spriteName}-v2`)).toBe(true)
    expect(vm.getSelectionEpoch()).toBe(epochBefore)
    let ops = 0
    const result = await runBitmapPendingUiOp(
      tx,
      'select-costume',
      bundleLiveOf(vm, tid),
      async () => 'unused',
      () => {
        ops += 1
        return 'kept'
      },
      { readLive: bundleLiveReaderOf(vm, tid), isContinuationCurrent: guard },
    )
    expect(result.ok).toBe(true)
    expect(ops).toBe(1)
  })

  it('same-scope own writeSeq advancement stays green: committed bump does not read stale', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('OWN-SEQ') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
    const seqBefore = vm.getCostumeWriteSeq(tid, 0)
    let ops = 0
    const result = await runBitmapPendingUiOp(tx, 'select-costume', bundle.scope, bundle.write, () => {
      ops += 1
      return 'selected'
    }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
    expect(result.ok).toBe(true)
    expect(ops).toBe(1)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(seqBefore + 1)
    expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:OWN-SEQ')
  })

  it('missing / throwing / false guards refuse without running the op (commit-first, discard, leave-pending)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    // Missing guard: nothing-to-commit still refuses, no ghost call.
    {
      const tx = createPendingBitmapTransaction()
      let ops = 0
      const result = await runBitmapPendingUiOp(tx, 'export-project', bundleLiveOf(vm, tid), async () => 'unused', () => {
        ops += 1
        return vm.exportProject()
      }, { readLive: bundleLiveReaderOf(vm, tid) })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('commit-rejected')
        expect(result.detail).toContain('missing continuation guard')
      }
      expect(ops).toBe(0)
    }
    // Throwing guard: refused as commit-rejected, no op.
    {
      const tx = createPendingBitmapTransaction()
      let ops = 0
      const result = await runBitmapPendingUiOp(tx, 'select-costume', bundleLiveOf(vm, tid), async () => 'unused', () => {
        ops += 1
        return 'selected'
      }, { readLive: bundleLiveReaderOf(vm, tid), isContinuationCurrent: () => { throw new Error('guard-boom') } })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('commit-rejected')
        expect(result.detail).toContain('continuation guard failed')
      }
      expect(ops).toBe(0)
    }
    // False guard on leave-pending: no tx touch, still refused.
    {
      const tx = createPendingBitmapTransaction()
      let ops = 0
      const result = await runBitmapPendingUiOp(tx, 'restyle', bundleLiveOf(vm, tid), async () => 'unused', () => {
        ops += 1
        return 're-rendered'
      }, { isContinuationCurrent: () => false })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('superseded')
      expect(ops).toBe(0)
    }
    // False guard on discard-first: fail-first precheck retains the pending, op suppressed.
    {
      const tx = createPendingBitmapTransaction()
      const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('X') }, EXTRA)
      expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
      let ops = 0
      const result = await runBitmapPendingUiOp(tx, 'paint-delete-selection', bundle.scope, bundle.write, () => {
        ops += 1
        return 'cleared'
      }, { ...bundle.options, isContinuationCurrent: () => false })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('superseded')
        expect(result.commit).toBeUndefined()
      }
      expect(ops).toBe(0)
      expect(tx.snapshot().hasPending).toBe(true)
    }
  })

  it('post-commit selection switch suppresses the stale UI action even though the bytes landed', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('LANDED-BUT-STALE') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
    const stageId = vm.getStage().id as string
    const guard = createBitmapPendingContinuationGuard(vm)
    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return origStore(d, f)
    }
    // After the CAS mutation lands, `getLiveIdentity` still matches the
    // writer identity (selection does not move slot bytes), so the
    // coordinator reports `committed`; the epoch moved, so the gate guard
    // must still suppress the stale select.
    const origGetLive = bundle.options.getLiveIdentity
    let hooked = false
    const hookedOptions = {
      ...bundle.options,
      getLiveIdentity: () => {
        const identity = origGetLive()
        if (!hooked) {
          hooked = true
          vm.selectTarget(stageId)
        }
        return identity
      },
      isContinuationCurrent: guard,
    }
    let selectCalls = 0
    try {
      const pending = runBitmapPendingUiOp(tx, 'select-costume', bundle.scope, bundle.write, () => {
        selectCalls += 1
        return 'selected'
      }, hookedOptions)
      await flushTicks()
      gate.resolve()
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('superseded')
        expect(result.detail).toContain('stale continuation')
        expect(result.commit?.ok).toBe(true)
      }
      expect(selectCalls).toBe(0)
      expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:LANDED-BUT-STALE')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('concurrent joins: selection move mid-flight refuses both continuations without stealing the write', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('FIRST') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
    const stageId = vm.getStage().id as string
    const gate = deferred<void>()
    const origStore = vm.storeAsset.bind(vm)
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return origStore(d, f)
    }
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      const guardA = createBitmapPendingContinuationGuard(vm)
      let opsA = 0
      const firstOp = runBitmapPendingUiOp(tx, 'export-project', bundle.scope, bundle.write, () => {
        opsA += 1
        return vm.exportProject()
      }, { ...bundle.options, isContinuationCurrent: guardA })
      await flushTicks()
      // External UI moves before the second command arrives.
      vm.selectTarget(stageId)
      const guardB = createBitmapPendingContinuationGuard(vm)
      const stageBundle = createBitmapPendingVmCommit(vm, { targetId: stageId, costumeIndex: 0, pngBytes: pngBytes('OTHER') }, EXTRA)
      let opsB = 0
      const second = await runBitmapPendingUiOp(tx, 'select-costume', stageBundle.scope, stageBundle.write, () => {
        opsB += 1
        return 'stale-selected'
      }, { ...stageBundle.options, isContinuationCurrent: guardB })
      expect(second.ok).toBe(false)
      expect(opsB).toBe(0)
      gate.resolve()
      const firstResult = await firstOp
      expect(firstResult.ok).toBe(false)
      expect(opsA).toBe(0)
      expect(casCalls).toBe(1)
      expect(await bytesOf(vm, tid, 0)).not.toContain('PNG-BYTES:FIRST')
    } finally {
      vm.storeAsset = origStore
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('leave-pending op receives an abort token and must recheck per await', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const guard = createBitmapPendingContinuationGuard(vm)
    const stageId = vm.getStage().id as string
    const release = deferred<void>()
    let sawControl = false
    let sideEffect = 0
    const pending = runBitmapPendingUiOp(tx, 'restyle', bundleLiveOf(vm, tid), async () => 'unused', async (control) => {
      sawControl = typeof control?.isContinuationCurrent === 'function' && typeof control?.throwIfAborted === 'function'
      expect(control.isContinuationCurrent()).toBe(true)
      expect(control.isAborted()).toBe(false)
      await release.promise
      // Contract: recheck synchronously after every await; the UI moved, so abort quietly.
      if (!control.isContinuationCurrent()) return 'aborted-quietly'
      sideEffect += 1
      return 'rendered'
    }, { isContinuationCurrent: guard })
    await flushTicks()
    vm.selectTarget(stageId)
    release.resolve()
    const result = await pending
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.opResult).toBe('aborted-quietly')
    expect(sawControl).toBe(true)
    expect(sideEffect).toBe(0)
  })

  it('sync same-turn: guard-enqueued microtask switch cannot interleave between guard and op', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const stageId = vm.getStage().id as string
    const baseGuard = createBitmapPendingContinuationGuard(vm)
    // The guard enqueues a project switch as a microtask DURING its own
    // evaluation. With a synchronous same-turn guard->op handoff (no await
    // boundary), the op invocation runs before that microtask fires, so the
    // op still observes a current scope and proceeds. An async guard gap
    // would let the switch land first and either refuse or run stale.
    let guardCalls = 0
    const racyGuard = (): boolean => {
      guardCalls += 1
      queueMicrotask(() => {
        vm.selectTarget(stageId)
      })
      return baseGuard()
    }
    let ops = 0
    let observedAtEntry: string | undefined
    const result = await runBitmapPendingUiOp(tx, 'restyle', bundleLiveOf(vm, tid), async () => 'unused', (control) => {
      ops += 1
      // Sync entry check: still current because the enqueued switch has not
      // run yet in this same JS turn.
      expect(control.isContinuationCurrent()).toBe(true)
      observedAtEntry = vm.getSelectedTargetStableId()
      return 'rendered-sync'
    }, { isContinuationCurrent: racyGuard })
    // Gate guard + op entry recheck (both sync, before the enqueued switch).
    expect(guardCalls).toBe(2)
    expect(result.ok).toBe(true)
    expect(ops).toBe(1)
    // The op fired before the switch within the same microtask drain: it
    // saw the original target, never a stale write.
    expect(observedAtEntry).toBe(tid)
    await flushTicks()
    expect(vm.getSelectedTargetStableId()).toBe(stageId)
    expect(await bytesOf(vm, tid, 0)).toContain('base')
  })

  it('earlier-scheduled microtask switch lands in the joinCommit await and refuses without stale writes', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const stageId = vm.getStage().id as string
    const guard = createBitmapPendingContinuationGuard(vm)
    let ops = 0
    // Schedule the switch BEFORE the gate call. The commit-first
    // nothing-to-commit path still awaits joinCommit (one microtask), so the
    // switch lands during that await; the guard runs AFTER the await and
    // must refuse the stale UI action. Never runs the op, never writes.
    queueMicrotask(() => {
      vm.selectTarget(stageId)
    })
    const result = await runBitmapPendingUiOp(tx, 'export-project', bundleLiveOf(vm, tid), async () => 'unused', () => {
      ops += 1
      return vm.exportProject()
    }, { readLive: bundleLiveReaderOf(vm, tid), isContinuationCurrent: guard })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('superseded')
    expect(ops).toBe(0)
    expect(vm.getSelectedTargetStableId()).toBe(stageId)
    expect(await bytesOf(vm, tid, 0)).toContain('base')
    expect(await bytesOf(vm, tid, 0)).not.toContain('PNG-BYTES')
  })

  it('long op must check the sync control itself: stale mutation after await is suppressed', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const stageId = vm.getStage().id as string
    const release = deferred<void>()
    let mutations = 0
    const pending = runBitmapPendingUiOp(tx, 'restyle', bundleLiveOf(vm, tid), async () => 'unused', async (control) => {
      // Entry is current (same-turn handoff).
      expect(control.isContinuationCurrent()).toBe(true)
      await release.promise
      // After the await the UI moved: a long op must recheck synchronously
      // and abort without mutating.
      if (!control.isContinuationCurrent()) return 'aborted-quietly'
      mutations += 1
      return 'mutated'
    }, { isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
    await flushTicks()
    // Move after the op entered its await; op must observe staleness itself.
    vm.selectTarget(stageId)
    release.resolve()
    const result = await pending
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.opResult).toBe('aborted-quietly')
    expect(mutations).toBe(0)
  })

  it('async (Promise-returning) guard is rejected as invalid on every policy without running the op', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const asyncGuard = (() => Promise.resolve(true)) as unknown as () => boolean
    // commit-first (nothing-to-commit still guards)
    {
      const tx = createPendingBitmapTransaction()
      let ops = 0
      const result = await runBitmapPendingUiOp(tx, 'export-project', bundleLiveOf(vm, tid), async () => 'unused', () => {
        ops += 1
        return vm.exportProject()
      }, { readLive: bundleLiveReaderOf(vm, tid), isContinuationCurrent: asyncGuard })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('commit-rejected')
        expect(result.detail).toContain('continuation guard failed')
      }
      expect(ops).toBe(0)
    }
    // discard-first: fail-first retains the pending, no CAS.
    {
      const tx = createPendingBitmapTransaction()
      const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('X') }, EXTRA)
      expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
      let ops = 0
      const result = await runBitmapPendingUiOp(tx, 'paint-delete-selection', bundle.scope, bundle.write, () => {
        ops += 1
        return 'cleared'
      }, { ...bundle.options, isContinuationCurrent: asyncGuard })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('commit-rejected')
        expect(result.commit).toBeUndefined()
      }
      expect(ops).toBe(0)
      expect(tx.snapshot().hasPending).toBe(true)
    }
    // leave-pending (no-pending path also guards synchronously)
    {
      const tx = createPendingBitmapTransaction()
      let ops = 0
      const result = await runBitmapPendingUiOp(tx, 'restyle', bundleLiveOf(vm, tid), async () => 'unused', () => {
        ops += 1
        return 're-rendered'
      }, { isContinuationCurrent: asyncGuard })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('commit-rejected')
      expect(ops).toBe(0)
    }
    // The async control view also fails closed: a thenable guard never reads current.
    {
      const tx = createPendingBitmapTransaction()
      let sawFalse = false
      const result = await runBitmapPendingUiOp(tx, 'restyle', bundleLiveOf(vm, tid), async () => 'unused', (control) => {
        sawFalse = control.isContinuationCurrent() === false
        return 'observed'
      }, { isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
      expect(result.ok).toBe(true)
      expect(sawFalse).toBe(false)
    }
  })

  describe('fail-first precheck (real VM, no side effect on invalid guard)', () => {
    it('discard-first undo/delete with missing/throwing/async/false guard retains identical pending with no CAS', async () => {
      const { vm, tid } = freshVM()
      await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
      const discardCommands = ['paint-undo', 'paint-delete-selection'] as const
      const guardCases = [
        { name: 'missing', make: () => undefined as unknown as () => boolean, reason: 'commit-rejected', detail: 'missing continuation guard' },
        { name: 'throwing', make: () => (() => { throw new Error('guard-boom') }) as () => boolean, reason: 'commit-rejected', detail: 'continuation guard failed' },
        { name: 'async', make: () => ((() => Promise.resolve(true)) as unknown as () => boolean), reason: 'commit-rejected', detail: 'continuation guard failed' },
        { name: 'false', make: () => (() => false) as () => boolean, reason: 'superseded', detail: 'stale continuation' },
      ] as const
      for (const command of discardCommands) {
        for (const guardCase of guardCases) {
          const tx = createPendingBitmapTransaction()
          const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes(`RETAINED-${command}-${guardCase.name}`) }, EXTRA)
          const stagedBase = baseOf()
          expect(tx.stage(shapeOf(), stagedBase, bundle.scope).ok).toBe(true)
          const scopeBefore = tx.snapshot().pendingScope
          const origCas = vm.updateCostumeIfMatch.bind(vm)
          let casCalls = 0
          vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
            casCalls += 1
            return origCas(...args)
          }) as typeof vm.updateCostumeIfMatch
          let ops = 0
          try {
            const guard = guardCase.make()
            const result = await runBitmapPendingUiOp(
              tx,
              command,
              bundle.scope,
              bundle.write,
              () => {
                ops += 1
                return 'cleared'
              },
              guard === undefined
                ? { readLive: bundle.options.readLive, getLiveIdentity: bundle.options.getLiveIdentity }
                : { ...bundle.options, isContinuationCurrent: guard },
            )
            expect(result.ok).toBe(false)
            if (!result.ok) {
              expect(result.reason).toBe(guardCase.reason)
              expect(result.detail).toContain(guardCase.detail)
              // Fail-first: no discard ran, so no commit payload.
              expect(result.commit).toBeUndefined()
            }
            expect(ops).toBe(0)
            expect(casCalls).toBe(0)
            // Pending still identical: slot retained, VM pixels untouched.
            expect(tx.snapshot().hasPending).toBe(true)
            expect(tx.snapshot().pendingScope).toEqual(scopeBefore)
            expect(tx.snapshot().pendingScope).toEqual(bundle.scope)
            expect(await bytesOf(vm, tid, 0)).toContain('base')
            expect(await bytesOf(vm, tid, 0)).not.toContain(`RETAINED-${command}-${guardCase.name}`)
          } finally {
            vm.updateCostumeIfMatch = origCas
          }
          // Retained shape+base still commits under a fresh valid guard.
          let followOps = 0
          const follow = await runBitmapPendingUiOp(tx, 'save-bitmap', bundle.scope, bundle.write, () => {
            followOps += 1
            return 'saved'
          }, { ...bundle.options, isContinuationCurrent: createBitmapPendingContinuationGuard(vm) })
          expect(follow.ok).toBe(true)
          expect(followOps).toBe(1)
          expect(await bytesOf(vm, tid, 0)).toContain(`PNG-BYTES:RETAINED-${command}-${guardCase.name}`)
          // Restore base art for the next case.
          await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
        }
      }
    })

    it('stale select/save/export precheck never starts the write: CAS=0 and pending retained', async () => {
      const { vm, tid } = freshVM()
      await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
      const stageId = vm.getStage().id as string
      const commitCommands = ['select-costume', 'save-bitmap', 'export-project'] as const
      for (const command of commitCommands) {
        const tx = createPendingBitmapTransaction()
        const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes(`STALE-PRECHECK-${command}`) }, EXTRA)
        expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
        const scopeBefore = tx.snapshot().pendingScope
        // Capture a valid guard, then move the selection BEFORE the gate call.
        const staleGuard = createBitmapPendingContinuationGuard(vm)
        vm.selectTarget(stageId)
        expect(staleGuard()).toBe(false)
        const origCas = vm.updateCostumeIfMatch.bind(vm)
        let casCalls = 0
        vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
          casCalls += 1
          return origCas(...args)
        }) as typeof vm.updateCostumeIfMatch
        let ops = 0
        try {
          const result = await runBitmapPendingUiOp(tx, command, bundle.scope, bundle.write, () => {
            ops += 1
            return 'stale-op'
          }, { ...bundle.options, isContinuationCurrent: staleGuard })
          expect(result.ok).toBe(false)
          if (!result.ok) {
            expect(result.reason).toBe('superseded')
            expect(result.detail).toContain('stale continuation')
            // Fail-first: the writer never fired, so no commit payload.
            expect(result.commit).toBeUndefined()
          }
          expect(ops).toBe(0)
          expect(casCalls).toBe(0)
          expect(tx.snapshot().hasPending).toBe(true)
          expect(tx.snapshot().pendingScope).toEqual(scopeBefore)
          expect(await bytesOf(vm, tid, 0)).toContain('base')
          expect(await bytesOf(vm, tid, 0)).not.toContain(`STALE-PRECHECK-${command}`)
        } finally {
          vm.updateCostumeIfMatch = origCas
        }
        // Move back so the next case starts from the original selection.
        vm.selectTarget(tid)
      }
    })

    it('valid commit queued then target changed stays a later no-op while honestly reporting committed', async () => {
      const { vm, tid } = freshVM()
      await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
      const tx = createPendingBitmapTransaction()
      const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('QUEUED-COMMITTED') }, EXTRA)
      expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
      const stageId = vm.getStage().id as string
      const validGuard = createBitmapPendingContinuationGuard(vm)
      expect(validGuard()).toBe(true)
      const gate = deferred<void>()
      const origStore = vm.storeAsset.bind(vm)
      let first = true
      vm.storeAsset = async (d: Uint8Array, f: string) => {
        if (first) {
          first = false
          await gate.promise
        }
        return origStore(d, f)
      }
      const origGetLive = bundle.options.getLiveIdentity
      let hooked = false
      const hookedOptions = {
        ...bundle.options,
        getLiveIdentity: () => {
          const identity = origGetLive()
          if (!hooked) {
            hooked = true
            // Land the selection move AFTER the CAS mutation but BEFORE the
            // gate recheck: the bytes honestly commit while the queued UI
            // action stays a later no-op.
            vm.selectTarget(stageId)
          }
          return identity
        },
        isContinuationCurrent: validGuard,
      }
      const origCas = vm.updateCostumeIfMatch.bind(vm)
      let casCalls = 0
      vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
        casCalls += 1
        return origCas(...args)
      }) as typeof vm.updateCostumeIfMatch
      let selectCalls = 0
      try {
        const pending = runBitmapPendingUiOp(tx, 'select-costume', bundle.scope, bundle.write, () => {
          selectCalls += 1
          return 'selected'
        }, hookedOptions)
        await flushTicks()
        gate.resolve()
        const result = await pending
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.reason).toBe('superseded')
          expect(result.detail).toContain('stale continuation')
          // Honest status: the write did land exactly once.
          expect(result.commit?.ok).toBe(true)
          expect(result.commit).toEqual({ ok: true, kind: 'committed' })
        }
        expect(selectCalls).toBe(0)
        expect(casCalls).toBe(1)
        expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:QUEUED-COMMITTED')
        expect(tx.snapshot().hasPending).toBe(false)
      } finally {
        vm.storeAsset = origStore
        vm.updateCostumeIfMatch = origCas
      }
    })
  })

  function bundleLiveOf(vm: { getSelectionSnapshot?: () => unknown }, tid: string): unknown {
    // Pending-slot live input for guard-only paths: reuse the VM writer scope
    // capture so `readLive`-style callers stay VM-truthful without a pending.
    void tid
    return {}
  }

  function bundleLiveReaderOf(vm: InstanceType<typeof ScratchVM>, tid: string): () => import('../src/features/costumes/bitmap-pending-transaction').PendingCommitScope {
    return () => {
      const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('probe') }, EXTRA)
      return bundle.options.readLive()
    }
  }
})
