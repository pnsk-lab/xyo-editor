import { describe, expect, it } from 'bun:test'
import {
  createPendingBitmapShape,
  restylePendingBitmapShape,
} from '../src/features/costumes/bitmap-pending-shape'
import {
  createPendingBitmapTransaction,
  type PendingCommitScope,
  type PendingCommitSlotIdentity,
  type PendingCommitWrite,
} from '../src/features/costumes/bitmap-pending-transaction'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'

const STYLE = {
  fill: '#ff0000',
  secondary: '#ffffff',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 10,
}

function scopeOf(overrides: Partial<PendingCommitScope> = {}): PendingCommitScope {
  return {
    targetId: 'target-1',
    costumeIndex: 0,
    assetKey: 'asset-a',
    loadSerial: 7,
    sessionGeneration: 3,
    editEpoch: 11,
    projectGeneration: 1,
    ...overrides,
  }
}

function baseOf(width = 8, height = 8, fill = 9): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(fill)
  return { width, height, data }
}

function shapeOf() {
  return createPendingBitmapShape('rect', { x: 1, y: 2, width: 4, height: 3 }, 'filled', STYLE)
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

function scopeFromVM(vm: ScratchVM, tid: string, index = 0): PendingCommitScope {
  const ident = vm.getCostumeIdentity(tid, index)!
  return {
    targetId: tid,
    costumeIndex: index,
    assetKey: ident.md5ext!,
    loadSerial: 7,
    sessionGeneration: 3,
    editEpoch: ident.writeSeq,
    projectGeneration: vm.getProjectGeneration(),
    assetId: ident.assetId,
    writeSeq: ident.writeSeq,
    selectionEpoch: vm.getSelectionEpoch(),
  }
}

function liveOpts(vm: ScratchVM, tid: string, index = 0) {
  return {
    readLive: () => scopeFromVM(vm, tid, index),
    getLiveIdentity: () => vm.getCostumeIdentity(tid, index) as PendingCommitSlotIdentity | undefined,
  }
}

/**
 * Exact safe contract for hermetic (non-VM) tests: the writer consults
 * `shouldCommit()` synchronously at the actual commit point and returns an
 * explicit `{ applied, newIdentity }` verified against `getLiveIdentity`.
 * Same generation, `assetId` + `md5ext` + `writeSeq` identity — never a
 * bare `{ ok: true }`, never a synchronous version bump standing in for a
 * store snapshot.
 */
function fakeIdentity(): PendingCommitSlotIdentity {
  return { assetId: 'asset-new', md5ext: 'asset-new.svg', writeSeq: 99 }
}

function fakeLiveOpts(live: PendingCommitScope, identity: PendingCommitSlotIdentity) {
  return {
    readLive: () => ({ ...live }),
    getLiveIdentity: () => ({ ...identity }),
  }
}

function fakeCasSuccess(identity: PendingCommitSlotIdentity): PendingCommitWrite {
  return async (_taken, control) => {
    if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
    return { ok: true as const, applied: true as const, newIdentity: { ...identity } }
  }
}

/** Trusted VM CAS writer: forwards the per-flight abort token as the 7th arg. */
function vmCasWriter(vm: ScratchVM, tid: string, bytes: Uint8Array): PendingCommitWrite {
  return async (_taken, control) => {
    if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
    control.throwIfAborted()
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
      { dataFormat: 'svg' },
      bytes,
      undefined,
      control.abort,
    )
    if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
    return { ok: true as const, applied: true as const, newIdentity: r.current! }
  }
}

describe('pending bitmap transaction coordinator (commit-first, fail-closed)', () => {
  it('two joins commit once: concurrent joiners share one write', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    expect(tx.stage(shapeOf(), baseOf(), live).ok).toBe(true)

    const identity = fakeIdentity()
    const gate = deferred<PendingCommitSlotIdentity>()
    let calls = 0
    const write: PendingCommitWrite = async (_taken, control) => {
      calls += 1
      const landed = await gate.promise
      if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
      return { ok: true as const, applied: true as const, newIdentity: { ...landed } }
    }
    const opts = fakeLiveOpts(live, identity)
    const first = tx.joinCommit(live, write, opts)
    const second = tx.joinCommit(live, write, opts)
    await flushTicks()
    expect(calls).toBe(1)
    gate.resolve({ ...identity })
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ ok: true, kind: 'committed' })
    expect(b).toEqual({ ok: true, kind: 'committed' })
    expect(calls).toBe(1)
    expect(tx.snapshot().hasPending).toBe(false)
  })

  it('failed save restores the same pending for retry (rejected write never rejects the join)', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    const shape = shapeOf()
    expect(tx.stage(shape, baseOf(), live).ok).toBe(true)

    const failure = await tx.joinCommit(live, () => Promise.resolve({ ok: false as const, reason: 'store-full' }), {
      readLive: () => ({ ...live }),
    })
    expect(failure.ok).toBe(false)
    if (!failure.ok) expect(failure.reason).toBe('commit-failed')
    // Same pending is retained so the caller can retry.
    expect(tx.snapshot().hasPending).toBe(true)

    const rejected = await tx.joinCommit(
      live,
      () => Promise.reject(new Error('encode boom')),
      { readLive: () => ({ ...live }) },
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe('commit-rejected')
    expect(tx.snapshot().hasPending).toBe(true)

    const identity = fakeIdentity()
    const retry = await tx.joinCommit(live, fakeCasSuccess(identity), fakeLiveOpts(live, identity))
    expect(retry).toEqual({ ok: true, kind: 'committed' })
    expect(tx.snapshot().hasPending).toBe(false)
  })

  it('different slot is allowed after the first commit settles (no cross-slot join)', async () => {
    const tx = createPendingBitmapTransaction()
    const slotA = scopeOf({ targetId: 'target-a', assetKey: 'asset-a' })
    const slotB = scopeOf({ targetId: 'target-b', assetKey: 'asset-b' })
    expect(tx.stage(shapeOf(), baseOf(), slotA).ok).toBe(true)

    const identityA = fakeIdentity()
    const gate = deferred<void>()
    let callsA = 0
    const first = tx.joinCommit(
      slotA,
      async (_taken, control) => {
        callsA += 1
        await gate.promise
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        return { ok: true as const, applied: true as const, newIdentity: { ...identityA } }
      },
      fakeLiveOpts(slotA, identityA),
    )
    // A different slot must not join A's in-flight commit: explicit refuse
    // while A keeps running (no wait, no steal).
    const during = await tx.joinCommit(slotB, fakeCasSuccess(fakeIdentity()), fakeLiveOpts(slotB, fakeIdentity()))
    expect(during.ok).toBe(false)
    if (!during.ok) expect(during.reason).toBe('commit-in-flight')

    gate.resolve()
    expect(await first).toEqual({ ok: true, kind: 'committed' })
    // After A settles, B stages and commits independently.
    expect(tx.stage(shapeOf(), baseOf(), slotB).ok).toBe(true)
    const identityB = fakeIdentity()
    const second = await tx.joinCommit(slotB, fakeCasSuccess(identityB), fakeLiveOpts(slotB, identityB))
    expect(second).toEqual({ ok: true, kind: 'committed' })
    expect(callsA).toBe(1)
  })

  it('switch waits for the commit and refuses on failure (pending retained)', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    expect(tx.stage(shapeOf(), baseOf(), live).ok).toBe(true)

    const identity = fakeIdentity()
    const gate = deferred<void>()
    let writerCalls = 0
    const inFlight = tx.joinCommit(
      live,
      async (_taken, control) => {
        writerCalls += 1
        await gate.promise
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        return { ok: true as const, applied: true as const, newIdentity: { ...identity } }
      },
      fakeLiveOpts(live, identity),
    )
    // A switch must commit-first: it joins the running commit instead of
    // starting a second write (the writer would throw if called again).
    const waiter = tx.requestSwitchPending(live, () => {
      throw new Error('must join, not rewrite')
    })
    await flushTicks()
    expect(writerCalls).toBe(1)
    gate.resolve()
    expect(await inFlight).toEqual({ ok: true, kind: 'committed' })
    expect(await waiter).toEqual({ ok: true, kind: 'committed' })

    // Failure path: the switch refuses and the pending survives for retry.
    expect(tx.stage(shapeOf(), baseOf(), live).ok).toBe(true)
    const failing = tx.requestSwitchPending(live, () => Promise.resolve({ ok: false as const, reason: 'disk-full' }), {
      readLive: () => ({ ...live }),
    })
    const outcome = await failing
    expect(outcome.ok).toBe(false)
    expect(tx.snapshot().hasPending).toBe(true)
  })

  it('save and export join commit-first too', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    expect(tx.stage(shapeOf(), baseOf(), live).ok).toBe(true)
    const identity = fakeIdentity()
    expect(await tx.requestSavePending(live, fakeCasSuccess(identity), fakeLiveOpts(live, identity))).toEqual({
      ok: true,
      kind: 'committed',
    })
    // Nothing left: export proceeds cleanly with no second write.
    let exportCalls = 0
    expect(
      await tx.requestExportPending(live, () => {
        exportCalls += 1
        return Promise.resolve({ ok: false as const, reason: 'unreachable' })
      }),
    ).toEqual({ ok: true, kind: 'nothing-to-commit' })
    expect(exportCalls).toBe(0)
  })

  it('external change before commit fails closed with no write', async () => {
    const tx = createPendingBitmapTransaction()
    const staged = scopeOf()
    expect(tx.stage(shapeOf(), baseOf(), staged).ok).toBe(true)
    let calls = 0
    const live = scopeOf({ editEpoch: staged.editEpoch + 1 })
    const outcome = await tx.joinCommit(live, () => {
      calls += 1
      return Promise.resolve({ ok: false as const, reason: 'unreachable' })
    })
    expect(calls).toBe(0)
    expect(outcome.ok).toBe(false)
    expect(tx.snapshot().hasPending).toBe(false)
    expect(tx.snapshot().commitInFlight).toBe(false)
  })

  it('mid-flight external change is kept: VM CAS refuses the stale write', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const live0 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), live0).ok).toBe(true)

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
    const outcome = tx.joinCommit(live0, vmCasWriter(vm, tid, svgBytes('STALE')), liveOpts(vm, tid, 0))
    await flushTicks()
    // An external same-slot write lands while the save is in flight.
    expect(vm.renameCostume(tid, 0, 'EXT')).toBe(true)
    gate.resolve()
    const result = await outcome
    vm.storeAsset = origStore
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('external-conflict')
    expect(tx.snapshot().hasPending).toBe(false)
    // The stale bytes never overwrote the external write.
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('EXT')
    expect(await bytesOf(vm, tid, 0)).toContain('base')
  })

  it('old success after a project replacement cannot mutate the newly created pending', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('GEN1'))
    const tx = createPendingBitmapTransaction()
    const gen1 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), gen1).ok).toBe(true)

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
    const stale = tx.joinCommit(
      gen1,
      async (_taken, control) => {
        await gate.promise
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('STALE-GEN1'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason ?? 'superseded', current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      { readLive: () => scopeFromVM(vm, tid, 0), getLiveIdentity: () => vm.getCostumeIdentity(tid, 0) as PendingCommitSlotIdentity | undefined },
    )
    await flushTicks()

    // The project is replaced and a fresh pending is staged for generation 2.
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
    const gen2 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), gen2).ok).toBe(true)

    gate.resolve()
    const staleResult = await stale
    vm.storeAsset = origStore
    expect(staleResult.ok).toBe(false)
    if (!staleResult.ok) expect(staleResult.reason).toBe('superseded')
    // The new pending is untouched and still committable.
    expect(tx.snapshot().hasPending).toBe(true)
    const gen2Identity = vm.getCostumeIdentity(tid, 0)!
    const committed = await tx.joinCommit(
      gen2,
      async (_taken, control) => {
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('GEN2-OWN'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      liveOpts(vm, tid, 0),
    )
    expect(committed).toEqual({ ok: true, kind: 'committed' })
    expect(vm.getCostumeIdentity(tid, 0)!.md5ext).not.toBe(gen2Identity.md5ext)
  })

  it('abort while in flight settles waiters as aborted with no slot mutation', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('BASE'))
    const tx = createPendingBitmapTransaction()
    const live0 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), live0).ok).toBe(true)
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
    const outcome = tx.joinCommit(live0, vmCasWriter(vm, tid, svgBytes('STALE')), liveOpts(vm, tid, 0))
    await flushTicks()
    expect(tx.abortInFlight('project-replaced')).toEqual({ ok: true, kind: 'aborted' })
    gate.resolve()
    const result = await outcome
    vm.storeAsset = origStore
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('aborted')
    expect(tx.snapshot().hasPending).toBe(false)
    expect(tx.snapshot().commitInFlight).toBe(false)
    // The trusted writer forwarded the abort token, so no slot mutation landed.
    expect(await bytesOf(vm, tid, 0)).toContain('BASE')
  })

  it('duplicate commit after success performs no second write', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    expect(tx.stage(shapeOf(), baseOf(), live).ok).toBe(true)
    const identity = fakeIdentity()
    let calls = 0
    const write: PendingCommitWrite = async (_taken, control) => {
      calls += 1
      if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
      return { ok: true as const, applied: true as const, newIdentity: { ...identity } }
    }
    expect(await tx.joinCommit(live, write, fakeLiveOpts(live, identity))).toEqual({ ok: true, kind: 'committed' })
    expect(await tx.joinCommit(live, write, fakeLiveOpts(live, identity))).toEqual({ ok: true, kind: 'nothing-to-commit' })
    expect(calls).toBe(1)
  })

  it('undo/discard while a save runs is explicitly refused', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    expect(tx.stage(shapeOf(), baseOf(), live).ok).toBe(true)
    const identity = fakeIdentity()
    const gate = deferred<void>()
    const outcome = tx.joinCommit(
      live,
      async (_taken, control) => {
        await gate.promise
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        return { ok: true as const, applied: true as const, newIdentity: { ...identity } }
      },
      fakeLiveOpts(live, identity),
    )
    await flushTicks()
    const discarded = tx.discardPending(live)
    expect(discarded.ok).toBe(false)
    if (!discarded.ok) expect(discarded.reason).toBe('commit-in-flight')
    gate.resolve()
    expect(await outcome).toEqual({ ok: true, kind: 'committed' })
  })

  it('discard with a matching owner drops the pending with no write', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    expect(tx.stage(shapeOf(), baseOf(), live).ok).toBe(true)
    let calls = 0
    expect(tx.discardPending(live)).toEqual({ ok: true, kind: 'discarded' })
    expect(tx.snapshot().hasPending).toBe(false)
    const identity = fakeIdentity()
    expect(
      await tx.joinCommit(
        live,
        async () => {
          calls += 1
          return { ok: true as const, applied: true as const, newIdentity: { ...identity } }
        },
        fakeLiveOpts(live, identity),
      ),
    ).toEqual({ ok: true, kind: 'nothing-to-commit' })
    expect(calls).toBe(0)
  })

  it('canvas-size bound refuses oversized bases before any state changes', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    const oversized = tx.stage(shapeOf(), baseOf(70000, 2), live)
    expect(oversized.ok).toBe(false)
    if (!oversized.ok) expect(oversized.reason).toBe('refused-size')
    const overArea = tx.stage(shapeOf(), baseOf(5000, 5000), live)
    expect(overArea.ok).toBe(false)
    expect(tx.snapshot().hasPending).toBe(false)
    let calls = 0
    expect(
      await tx.joinCommit(live, () => {
        calls += 1
        return Promise.resolve({ ok: false as const, reason: 'unreachable' })
      }),
    ).toEqual({ ok: true, kind: 'nothing-to-commit' })
    expect(calls).toBe(0)
  })

  it('original base pixels are never mutated, even by a mutating writer', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    const input = baseOf(4, 4, 77)
    const before = Array.from(input.data)
    expect(tx.stage(shapeOf(), input, live).ok).toBe(true)
    // Staging copies: mutating the caller buffer afterwards cannot leak in.
    input.data.fill(0)
    const seen: number[][] = []
    const mutating: PendingCommitWrite = (taken) => {
      seen.push(Array.from(taken.base.data))
      taken.base.data.fill(0)
      return Promise.resolve({ ok: false as const, reason: 'store-full' })
    }
    const failed = await tx.joinCommit(live, mutating, { readLive: () => ({ ...live }) })
    expect(failed.ok).toBe(false)
    expect(seen.length).toBe(1)
    expect(seen[0]).toEqual(before)
    // The retained pending still holds the pristine bytes for the retry.
    const retrySeen: number[][] = []
    const identity = fakeIdentity()
    const retry = await tx.joinCommit(
      live,
      (taken) => {
        retrySeen.push(Array.from(taken.base.data))
        return Promise.resolve({ ok: true as const, applied: true as const, newIdentity: { ...identity } })
      },
      fakeLiveOpts(live, identity),
    )
    expect(retry).toEqual({ ok: true, kind: 'committed' })
    expect(retrySeen[0]).toEqual(before)
    expect(Array.from(input.data).every((value) => value === 0)).toBe(true)
  })

  it('works with the real parametric helper: restyled shapes keep identity through the commit', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    const created = shapeOf()
    const { pending: restyled, changed } = restylePendingBitmapShape(created, { fill: '#0000ff' })
    expect(changed).toBe(true)
    expect(tx.stage(restyled, baseOf(), live).ok).toBe(true)
    let received: unknown
    const identity = fakeIdentity()
    const outcome = await tx.joinCommit(
      live,
      (taken) => {
        received = taken.shape
        return Promise.resolve({ ok: true as const, applied: true as const, newIdentity: { ...identity } })
      },
      fakeLiveOpts(live, identity),
    )
    expect(outcome).toEqual({ ok: true, kind: 'committed' })
    // Defensive copy at stage: the writer sees an equal-valued shape, never
    // the caller's live reference, so a caller mutation after stage cannot
    // corrupt the commit or a fail-closed restore.
    expect(received).toEqual(restyled)
    expect(received).not.toBe(restyled)
  })

  it('invalid arguments fail with a status reason instead of throwing', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    expect(tx.stage(shapeOf(), baseOf(), { ...live, targetId: '' }).ok).toBe(false)
    // @ts-expect-error - invalid base shape must not throw
    expect(tx.stage(shapeOf(), undefined, live).ok).toBe(false)
    expect(tx.snapshot().hasPending).toBe(false)
    const outcome = await tx.joinCommit(live, undefined as never)
    expect(outcome.ok).toBe(true)
  })

  it('legacy { ok: true } without applied is refused fail-closed (no commit)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const live0 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), live0).ok).toBe(true)

    // Same captured expected, but an external write lands first: a legacy
    // writer that ignores versioning must not report a commit.
    await vm.renameCostume(tid, 0, 'EXT')
    const legacy = await tx.joinCommit(
      live0,
      async () => ({ ok: true as const }) as never,
      liveOpts(vm, tid, 0),
    )
    expect(legacy.ok).toBe(false)
    if (!legacy.ok) expect(legacy.reason).toBe('commit-rejected')
    // No commit was reported; the external write is untouched.
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('EXT')
    expect(await bytesOf(vm, tid, 0)).toContain('base')

    // A legacy void resolution is likewise refused and retains the pending
    // while still owned for an explicit retry.
    const tx2 = createPendingBitmapTransaction()
    const live2 = scopeFromVM(vm, tid, 0)
    expect(tx2.stage(shapeOf(), baseOf(), live2).ok).toBe(true)
    const voidResult = await tx2.joinCommit(live2, (async () => undefined) as never, liveOpts(vm, tid, 0))
    expect(voidResult.ok).toBe(false)
    if (!voidResult.ok) expect(voidResult.reason).toBe('commit-rejected')
    expect(tx2.snapshot().hasPending).toBe(true)
  })

  it('stage copies the shape: caller/writer mutation cannot corrupt the commit or restore', async () => {
    const tx = createPendingBitmapTransaction()
    const live = scopeOf()
    const original = shapeOf()
    expect(tx.stage(original, baseOf(), live).ok).toBe(true)
    // Caller mutates its own object after staging (box + style).
    original.box.width = 999
    original.style.fill = '#00ff00'
    let received: unknown
    const identity: PendingCommitSlotIdentity = { assetId: 'a', md5ext: 'asset-a', writeSeq: 11 }
    // Writer likewise tries to mutate the taken shape before failing.
    const outcome = await tx.joinCommit(
      live,
      (taken) => {
        received = { ...(taken.shape as Record<string, unknown>) }
        ;(taken.shape as { box: { width: number } }).box.width = -1
        ;(taken.shape as { style: { fill: string } }).style.fill = '#000000'
        return Promise.resolve({ ok: false as const, reason: 'store down' })
      },
      {
        readLive: () => ({ ...live }),
        getLiveIdentity: () => ({ ...identity }),
      },
    )
    expect(outcome.ok).toBe(false)
    // Fail-closed restore keeps the pending; retry sees the STAGED values,
    // not the caller/writer mutations.
    expect(tx.snapshot().hasPending).toBe(true)
    const committed = await tx.joinCommit(
      live,
      (taken) => {
        received = taken.shape
        return Promise.resolve({ ok: true as const, applied: true as const, newIdentity: { ...identity } })
      },
      {
        readLive: () => ({ ...live }),
        getLiveIdentity: () => ({ ...identity }),
      },
    )
    expect(committed).toEqual({ ok: true, kind: 'committed' })
    expect(received).toEqual(shapeOf())
  })
})
