import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import { createPendingBitmapShape } from '../src/features/costumes/bitmap-pending-shape'
import {
  createPendingBitmapTransaction,
  type PendingCommitControl,
  type PendingCommitScope,
  type PendingCommitSlotIdentity,
  type PendingCommitTaken,
} from '../src/features/costumes/bitmap-pending-transaction'
import {
  captureBitmapPendingScope,
  createBitmapPendingScopeReaders,
  createBitmapPendingVmCommit,
  createBitmapPendingVmWrite,
  type BitmapPendingScopeExtra,
} from '../src/features/costumes/bitmap-pending-vm-writer'

/**
 * Durable real-VM unit tests for `bitmap-pending-vm-writer.ts` (isolated
 * adapter only: no `Editor.svelte` / `BitmapEditor.svelte`).
 *
 * Every case drives the REAL `ScratchVM` exactly like
 * `bitmap-pending-transaction-adversarial.test.ts`:
 * - the pending bytes go through the atomic CAS route
 *   `vm.updateCostumeIfMatch` (7th arg = per-flight abort token);
 * - every success mints a NEW md5ext and bumps the per-slot `writeSeq`;
 * - the VM re-validates `expected` + selection + capture both before the
 *   `storeAsset` await and after it, so an external write / rename / reload
 *   inside the await window fails closed instead of being clobbered.
 *
 * False-safety watches (each has a dedicated test that fails if the adapter
 * regresses to the naive shape):
 * - selection revision is commit-time (`control.capture`), never captured at
 *   writer creation (`creation-vs-commit` test);
 * - the abort token is the live token forwarded as the VM 7th arg and the
 *   CAS re-checks after the await (`abort` test: same object, aborted);
 * - the post identity is never assumed to carry `dataFormat`
 *   (`isSameSlotIdentity` ignores it; the png test commits svg -> png);
 * - the guard runs before the mutation: cross-slot / shouldCommit-false
 *   writers never reach the CAS (`cross-slot`, `guard-before-mutation`).
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

function freshVM(): { vm: ScratchVM; tid: string; stageId: string } {
  const vm = new ScratchVM()
  vm.loadProject(createDefaultProject())
  const sprite = vm.getSprites()[0]!
  return { vm, tid: sprite.id as string, stageId: vm.getStage().id as string }
}

async function bytesOf(vm: ScratchVM, targetId: string, index: number): Promise<string | undefined> {
  const t = vm.getTarget(targetId)
  const c = t?.costumes[index]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  const b = await vm.loadAsset(key, c?.dataFormat ?? 'svg')
  return b ? dec.decode(b) : undefined
}

async function rawBytesOf(vm: ScratchVM, targetId: string, index: number): Promise<Uint8Array | undefined> {
  const t = vm.getTarget(targetId)
  const c = t?.costumes[index]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  return vm.loadAsset(key, c?.dataFormat ?? 'png')
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** Commit one pending through the real adapter bundle (stage + joinCommit). */
async function commitPng(
  vm: ScratchVM,
  tid: string,
  index: number,
  payload: Uint8Array,
  meta: { bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number } = {},
) {
  const tx = createPendingBitmapTransaction()
  const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: index, pngBytes: payload, ...meta }, EXTRA)
  expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
  const result = await tx.joinCommit(bundle.scope, bundle.write, bundle.options)
  return { tx, bundle, result }
}

function stubControl(overrides: Partial<PendingCommitControl> = {}): PendingCommitControl {
  return {
    expected: { assetId: null, md5ext: null, writeSeq: null },
    capture: { projectGeneration: 0, selectionEpoch: null, structureSeq: null },
    abort: { aborted: false, reason: 'aborted' },
    isAborted: () => false,
    throwIfAborted: () => {},
    shouldCommit: () => true,
    ...overrides,
  }
}

function stubTaken(scope: PendingCommitScope): PendingCommitTaken {
  return {
    shape: shapeOf(),
    base: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) },
    scope: { ...scope },
  }
}

describe('bitmap pending VM writer (real ScratchVM)', () => {
  it('stores the exact PNG bytes byte-for-byte with png dataFormat', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const payload = pngBytes('exact-1')
    const { result } = await commitPng(vm, tid, 0, payload, { bitmapResolution: 2 })
    expect(result).toEqual({ ok: true, kind: 'committed' })
    const live = vm.getTarget(tid)!.costumes[0]!
    expect(live.dataFormat).toBe('png')
    const stored = await rawBytesOf(vm, tid, 0)
    expect(stored).toBeDefined()
    expect(arraysEqual(stored!, new Uint8Array(payload))).toBe(true)
    // The post identity carries no dataFormat assumption: the writer's
    // newIdentity (asset/md5/seq only) still verifies against the png live.
    const identity = vm.getCostumeIdentity(tid, 0)!
    expect(identity.dataFormat).toBe('png')
    expect(typeof identity.assetId).toBe('string')
    expect(typeof identity.md5ext).toBe('string')
  })

  it('preserves meta verbatim (resolution/rotationCenter) and never clobbers name', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    expect(vm.renameCostume(tid, 0, 'KeepMe')).toBe(true)
    const { result } = await commitPng(vm, tid, 0, pngBytes('meta-1'), {
      bitmapResolution: 2,
      rotationCenterX: 11,
      rotationCenterY: 22,
    })
    expect(result).toEqual({ ok: true, kind: 'committed' })
    const live = vm.getTarget(tid)!.costumes[0]!
    expect(live.bitmapResolution).toBe(2)
    expect(live.rotationCenterX).toBe(11)
    expect(live.rotationCenterY).toBe(22)
    expect(live.dataFormat).toBe('png')
    expect(live.name).toBe('KeepMe')
    expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:meta-1')
  })

  it('encode failure touches no VM state and keeps the pending for retry', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('orig'))
    const before = vm.getCostumeIdentity(tid, 0)!
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      const tx = createPendingBitmapTransaction()
      const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: new Uint8Array(0) }, EXTRA)
      expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
      const result = await tx.joinCommit(bundle.scope, bundle.write, bundle.options)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('commit-failed')
        expect(result.detail).toBe('encode-failed')
      }
      expect(casCalls).toBe(0)
      expect(tx.snapshot().hasPending).toBe(true)
      expect(await bytesOf(vm, tid, 0)).toContain('orig')
      expect(vm.getCostumeIdentity(tid, 0)).toEqual(before)
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
    // Retry with valid bytes succeeds on the retained pending.
    const retry = await commitPng(vm, tid, 0, pngBytes('retry-ok'), { bitmapResolution: 2 })
    expect(retry.result).toEqual({ ok: true, kind: 'committed' })
    expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:retry-ok')
  })

  it('oversize dims refuse before any VM call and keep the original', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('orig'))
    const before = vm.getCostumeIdentity(tid, 0)!
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      const tx = createPendingBitmapTransaction()
      const bundle = createBitmapPendingVmCommit(
        vm,
        { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('too-big'), width: 70000, height: 2 },
        EXTRA,
      )
      expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
      const result = await tx.joinCommit(bundle.scope, bundle.write, bundle.options)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('commit-failed')
        expect(result.detail).toBe('refused-size')
      }
      expect(casCalls).toBe(0)
      expect(tx.snapshot().hasPending).toBe(true)
      expect(await bytesOf(vm, tid, 0)).toContain('orig')
      expect(vm.getCostumeIdentity(tid, 0)).toEqual(before)
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('same-slot external bytes before commit fail closed (EXT kept)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('STALE') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
    // External same-slot bytes land after staging (stale expected from here).
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('EXT'))
    const result = await tx.joinCommit(bundle.scope, bundle.write, bundle.options)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('external-conflict')
    expect(tx.snapshot().hasPending).toBe(false)
    expect(await bytesOf(vm, tid, 0)).toContain('EXT')
    expect(await bytesOf(vm, tid, 0)).not.toContain('STALE')
  })

  it('synchronous rename inside the gated storeAsset window is kept (post-await CAS re-check)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const baseIdent = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
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
    try {
      const outcome = tx.joinCommit(bundle.scope, bundle.write, bundle.options)
      await flushTicks()
      // Metadata-only external write: same bytes, bumped writeSeq.
      expect(vm.renameCostume(tid, 0, 'ExtRename')).toBe(true)
      expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
      expect(vm.getCostumeIdentity(tid, 0)?.assetId).toBe(baseIdent.assetId)
      gate.resolve()
      const result = await outcome
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('external-conflict')
      expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('ExtRename')
      expect(await bytesOf(vm, tid, 0)).toContain('base')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('abort during the gated flight forwards the live token and writes nothing', async () => {
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
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    let seenSeventh: unknown
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      seenSeventh = args[6]
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      const outcome = tx.joinCommit(bundle.scope, bundle.write, bundle.options)
      await flushTicks()
      expect(tx.abortInFlight('project-replaced')).toEqual({ ok: true, kind: 'aborted' })
      gate.resolve()
      const result = await outcome
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('aborted')
      // The adapter reached the CAS (guard passed pre-abort) with the live
      // per-flight token: the same object the coordinator marked aborted.
      expect(casCalls).toBe(1)
      expect(typeof seenSeventh === 'object' && seenSeventh !== null).toBe(true)
      expect((seenSeventh as { aborted?: unknown }).aborted).toBe(true)
      expect(await bytesOf(vm, tid, 0)).toContain('BASE')
      expect(tx.snapshot().hasPending).toBe(false)
      expect(tx.snapshot().commitInFlight).toBe(false)
    } finally {
      vm.storeAsset = origStore
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('guard-before-mutation: shouldCommit-false never reaches the CAS', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      const write = createBitmapPendingVmWrite(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('x') })
      const scope = captureBitmapPendingScope(vm, tid, 0, EXTRA)
      const result = await write(stubTaken(scope), stubControl({ shouldCommit: () => false }))
      expect(result).toEqual({ ok: true, applied: false, reason: 'superseded' })
      expect(casCalls).toBe(0)
      expect(await bytesOf(vm, tid, 0)).toContain('base')
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('project reload with the same target id supersedes the old flight (NEW-GEN2 survives)', async () => {
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
    try {
      const stale = tx.joinCommit(gen1.scope, gen1.write, gen1.options)
      await flushTicks()
      const proj = vm.exportProject() as unknown as {
        targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }>
      }
      const idx = proj.targets.findIndex((t) => t.id === tid)
      expect(idx).toBeGreaterThanOrEqual(0)
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
      expect(tx.snapshot().hasPending).toBe(true)
      expect(await bytesOf(vm, tid, 0)).toContain('NEW-GEN2')
      const committed = await tx.joinCommit(gen2.scope, gen2.write, gen2.options)
      expect(committed).toEqual({ ok: true, kind: 'committed' })
      expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:GEN2-OWN')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('target delete (+recreate) during the flight never steers old bytes onto the new target', async () => {
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
    try {
      const outcome = tx.joinCommit(bundle.scope, bundle.write, bundle.options)
      await flushTicks()
      vm.deleteTarget(tid)
      expect(vm.getTarget(tid)).toBeUndefined()
      const newcomer = await vm.addSprite('Newcomer')
      const newId = (newcomer.id ?? newcomer.name) as string
      // `addSprite` reuses the freed stable id (`sprite1`): this is the
      // same-id delete+recreate case — the stale flight must still discard
      // via the target-object capture + selection epoch, never steering old
      // bytes onto the recreated slot.
      expect(vm.getTarget(newId)).toBeDefined()
      gate.resolve()
      const result = await outcome
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('superseded')
      // The recreated target keeps its own art; the stale PNG never landed.
      expect(await bytesOf(vm, newId, 0)).not.toContain('DEL-STALE')
      expect(await bytesOf(vm, newId, 0)).not.toContain('DEL-BASE')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('reorder during the flight supersedes (no write onto shifted indices)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('first'))
    await vm.duplicateCostume(tid, 0)
    await vm.updateCostume(tid, 1, { dataFormat: 'svg' }, svgBytes('second'))
    expect(vm.getTarget(tid)!.costumes).toHaveLength(2)
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
    try {
      const outcome = tx.joinCommit(bundle.scope, bundle.write, bundle.options)
      await flushTicks()
      expect(vm.reorderCostume(tid, 0, 1)).toBe(true)
      gate.resolve()
      const result = await outcome
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('superseded')
      // Index 0 now holds the reordered sibling, not the stale PNG.
      expect(await bytesOf(vm, tid, 0)).toContain('second')
      expect(await bytesOf(vm, tid, 0)).not.toContain('REORDER-STALE')
    } finally {
      vm.storeAsset = origStore
    }
  })

  it('selection away-and-back with the same slot supersedes via the epoch', async () => {
    const { vm, tid, stageId } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('STALE-SEL') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
    const epochBefore = vm.getSelectionEpoch()
    vm.selectTarget(stageId)
    vm.selectTarget(tid)
    expect(vm.getSelectionEpoch()).toBeGreaterThan(epochBefore)
    // Live selection is back on (tid, 0): final equality holds, epoch moved.
    const result = await tx.joinCommit(bundle.scope, bundle.write, bundle.options)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('superseded')
    expect(await bytesOf(vm, tid, 0)).toContain('base')
    expect(await bytesOf(vm, tid, 0)).not.toContain('STALE-SEL')
  })

  it('writer uses commit-time selection, not creation-time (no false supersede)', async () => {
    const { vm, tid, stageId } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    // Writer created BEFORE the selection excursion captures no selection.
    const earlyWrite = createBitmapPendingVmWrite(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('FRESH-SEL') })
    vm.selectTarget(stageId)
    vm.selectTarget(tid)
    // Fresh scope staged AFTER the excursion; the commit must apply.
    const tx = createPendingBitmapTransaction()
    const freshScope = captureBitmapPendingScope(vm, tid, 0, EXTRA)
    const freshOptions = createBitmapPendingScopeReaders(vm, tid, 0, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), freshScope).ok).toBe(true)
    const result = await tx.joinCommit(freshScope, earlyWrite, freshOptions)
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:FRESH-SEL')
  })

  it('store failure rejects fail-closed and the retry commits', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const origStore = vm.storeAsset.bind(vm)
    vm.storeAsset = async () => {
      throw new Error('store-full')
    }
    const tx = createPendingBitmapTransaction()
    const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('TRY1') }, EXTRA)
    expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
    const failed = await tx.joinCommit(bundle.scope, bundle.write, bundle.options)
    vm.storeAsset = origStore
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.reason).toBe('commit-rejected')
    expect(tx.snapshot().hasPending).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('base')
    const retry = await commitPng(vm, tid, 0, pngBytes('TRY2'), { bitmapResolution: 2 })
    expect(retry.result).toEqual({ ok: true, kind: 'committed' })
    expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:TRY2')
  })

  it('same-slot concurrent joiners share one mutation (seq +1, one CAS)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const seqBefore = vm.getCostumeWriteSeq(tid, 0)
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      const tx = createPendingBitmapTransaction()
      const bundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('JOINED') }, EXTRA)
      expect(tx.stage(shapeOf(), baseOf(), bundle.scope).ok).toBe(true)
      const a = tx.joinCommit(bundle.scope, bundle.write, bundle.options)
      const b = tx.requestSavePending(bundle.scope, bundle.write, bundle.options)
      const [ra, rb] = await Promise.all([a, b])
      expect(ra).toEqual({ ok: true, kind: 'committed' })
      expect(rb).toEqual({ ok: true, kind: 'committed' })
      expect(casCalls).toBe(1)
      expect(vm.getCostumeWriteSeq(tid, 0)).toBe(seqBefore + 1)
      expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:JOINED')
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
  })

  it('after success the next transaction rebases from the post identity', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const first = await commitPng(vm, tid, 0, pngBytes('v1'), { bitmapResolution: 2 })
    expect(first.result).toEqual({ ok: true, kind: 'committed' })
    const post1 = vm.getCostumeIdentity(tid, 0)!
    const seq1 = vm.getCostumeWriteSeq(tid, 0)
    // The next scope observes the post-write identity (no stale rebase).
    const second = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('v2') }, EXTRA)
    const sameIdentity: PendingCommitSlotIdentity = {
      assetId: second.scope.assetId ?? null,
      md5ext: second.scope.assetKey,
      writeSeq: second.scope.writeSeq ?? null,
    }
    expect(sameIdentity.assetId).toBe(post1.assetId)
    expect(sameIdentity.md5ext).toBe(post1.md5ext)
    expect(sameIdentity.writeSeq).toBe(post1.writeSeq)
    const tx2 = createPendingBitmapTransaction()
    expect(tx2.stage(shapeOf(), baseOf(), second.scope).ok).toBe(true)
    const r2 = await tx2.joinCommit(second.scope, second.write, second.options)
    expect(r2).toEqual({ ok: true, kind: 'committed' })
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(seq1 + 1)
    expect(await bytesOf(vm, tid, 0)).toContain('PNG-BYTES:v2')
  })

  it('stage vs sprite: cross-slot writer never touches the other slot', async () => {
    const { vm, tid, stageId } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('sprite-base'))
    await vm.updateCostume(stageId, 0, { dataFormat: 'svg' }, svgBytes('stage-base'))
    const origCas = vm.updateCostumeIfMatch.bind(vm)
    let casCalls = 0
    vm.updateCostumeIfMatch = (async (...args: Parameters<typeof origCas>) => {
      casCalls += 1
      return origCas(...args)
    }) as typeof vm.updateCostumeIfMatch
    try {
      const spriteWrite = createBitmapPendingVmWrite(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('SPRITE-PNG') })
      const stageScope = captureBitmapPendingScope(vm, stageId, 0, EXTRA)
      // Direct cross-slot invocation fails closed before the CAS.
      const direct = await spriteWrite(stubTaken(stageScope), stubControl())
      expect(direct).toEqual({ ok: true, applied: false, reason: 'superseded' })
      expect(casCalls).toBe(0)
      // Coordinator-level: a stage live scope never drives the sprite pending.
      const tx = createPendingBitmapTransaction()
      const spriteBundle = createBitmapPendingVmCommit(vm, { targetId: tid, costumeIndex: 0, pngBytes: pngBytes('SPRITE-PNG') }, EXTRA)
      expect(tx.stage(shapeOf(), baseOf(), spriteBundle.scope).ok).toBe(true)
      expect(spriteBundle.options.readLive().targetId).toBe(tid)
      const refused = await tx.joinCommit(stageScope, spriteWrite, spriteBundle.options)
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.reason).toBe('owner-mismatch')
      expect(casCalls).toBe(0)
      expect(await bytesOf(vm, tid, 0)).toContain('sprite-base')
      expect(await bytesOf(vm, stageId, 0)).toContain('stage-base')
    } finally {
      vm.updateCostumeIfMatch = origCas
    }
  })
})
