import { describe, expect, it } from 'bun:test'
import {
  createPendingBitmapTransaction,
  type PendingCommitScope,
  type PendingCommitSlotIdentity,
} from '../src/features/costumes/bitmap-pending-transaction'
import { createPendingBitmapShape } from '../src/features/costumes/bitmap-pending-shape'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'

/**
 * Adversarial review of `bitmap-pending-transaction.ts` (helper only, no
 * product wiring). Every case uses the REAL VM writer contract instead of
 * the stub `gate.resolve({ ok: true })` with an unchanged `readLive` used by
 * the 16 passing tests:
 *
 * - the real bitmap save calls the VM CAS route (`updateCostumeIfMatch`):
 *   every success mints a NEW md5ext and bumps the per-slot `writeSeq`.
 *   A faithful `getLiveIdentity` after an own write therefore observes a
 *   changed identity, and the helper verifies the writer's explicit
 *   `{ applied, newIdentity }` against `vm.getCostumeIdentity()` instead of
 *   misreporting the own bump as `external-conflict`.
 * - the VM re-validates `expected` (writeSeq + asset identity) both before
 *   the `storeAsset` await and atomically after it, plus the project
 *   generation / structure epoch. The helper's writer performs the atomic
 *   CAS at mutation time via `updateCostumeIfMatch` with the captured
 *   generation + version + abort token, so a mid-flight external write is
 *   never clobbered (post-await observation alone could never prevent it).
 *
 * Trusted VM interface (documented boundary):
 * - `vm.getCostumeIdentity(targetId, index)` is the live verifier
 *   (`options.getLiveIdentity`); `vm.getProjectGeneration()` /
 *   `vm.getSelectionEpoch()` scope the generation / selection revision.
 * - `vm.updateCostumeIfMatch(t, i, expected, patch, bytes, selection, abort)`
 *   is the atomic mutation; the 7th `abort` arg is the helper per-flight
 *   token. A writer that ignores the token / calls the guard early / skips
 *   the CAS is UNTRUSTED: the helper can only report `aborted`/`superseded`
 *   after the fact, never prevent the clobber. All writers below are the
 *   trusted shape (guard invoked synchronously at the actual commit, after
 *   any `storeAsset` await, immediately before the atomic mutation).
 */

const STYLE = {
  fill: '#ff0000',
  secondary: '#ffffff',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 10,
}

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

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('adversarial: bitmap pending transaction vs real writer contract', () => {
  it('FAIL-FIRST Q1: own successful write bumps assetKey/seq, helper must still report committed', async () => {
    // No external actor at all: the ONLY write is the helper's own writer,
    // which (like writeCroppedBitmapSave via the CAS route) mints a new
    // md5ext + writeSeq. The helper verifies the writer's explicit
    // newIdentity against the live identity instead of comparing the stale
    // taken scope.
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const live0 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), live0).ok).toBe(true)

    const result = await tx.joinCommit(
      live0,
      async (_taken, control) => {
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('OWN'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      liveOpts(vm, tid, 0),
    )
    // DESIRED: the write landed, so the commit must read `committed`.
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(await bytesOf(vm, tid, 0)).toContain('OWN')
  })

  it('FAIL-FIRST Q1b: same-slot joiners share the own-write false conflict', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const live0 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), live0).ok).toBe(true)
    let calls = 0
    const write = async (_taken: unknown, control: never) => {
      calls += 1
      const c = control as unknown as {
        shouldCommit: () => boolean
        expected: PendingCommitSlotIdentity
        abort: { aborted: boolean; reason: string }
      }
      if (!c.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
      const r = await vm.updateCostumeIfMatch(
        tid,
        0,
        { assetId: c.expected.assetId, md5ext: c.expected.md5ext, writeSeq: c.expected.writeSeq },
        { dataFormat: 'svg' },
        svgBytes('OWN'),
        undefined,
        c.abort,
      )
      if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
      return { ok: true as const, applied: true as const, newIdentity: r.current! }
    }
    const opts = liveOpts(vm, tid, 0)
    const a = tx.joinCommit(live0, write as never, opts)
    const b = tx.requestSavePending(live0, write as never, opts)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toEqual({ ok: true, kind: 'committed' })
    expect(rb).toEqual({ ok: true, kind: 'committed' })
    expect(calls).toBe(1)
    expect(await bytesOf(vm, tid, 0)).toContain('OWN')
  })

  it('FAIL-FIRST Q2: external write inside the storeAsset await window still clobbers (post-await cannot prevent)', async () => {
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
    const outcome = tx.joinCommit(
      live0,
      async (_taken, control) => {
        // `await vm.storeAsset(...)` window stands here (deferred above).
        // Trusted CAS path: atomic mutation AFTER the window keeps EXT.
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('STALE'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      liveOpts(vm, tid, 0),
    )
    await flushTicks()
    // External same-slot write lands while our storeAsset is in flight.
    // Synchronous rename (no slot queue): bumps writeSeq immediately so the
    // stale CAS fails closed instead of deadlocking behind the FIFO.
    expect(vm.renameCostume(tid, 0, 'EXT')).toBe(true)
    gate.resolve()
    const result = await outcome
    vm.storeAsset = origStore
    // Detection works AND prevention works: the stale bytes never overwrote
    // the external write inside the VM (last-writer-wins eliminated).
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('external-conflict')
    // DESIRED (CAS-at-mutation): EXT survives.
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('EXT')
    expect(await bytesOf(vm, tid, 0)).toContain('base')
  })

  it('PASS (fix direction) Q2b: CAS-at-mutation writer keeps the external write on the same interleaving', async () => {
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
    const outcome = tx.joinCommit(
      live0,
      async (_taken, control) => {
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('STALE'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: 'conflict' }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      liveOpts(vm, tid, 0),
    )
    await flushTicks()
    expect(vm.renameCostume(tid, 0, 'EXT')).toBe(true)
    gate.resolve()
    const q2bResult = await outcome
    vm.storeAsset = origStore
    expect(q2bResult.ok).toBe(false)
    // With the mandatory CAS contract the external write is never clobbered.
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('EXT')
    expect(await bytesOf(vm, tid, 0)).toContain('base')
  })

  it('FAIL-FIRST Q3: abort during flight does not stop the late writer mutation', async () => {
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
    const outcome = tx.joinCommit(
      live0,
      async (_taken, control) => {
        // Trusted writer: cancellation-aware, guard at actual commit.
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        control.throwIfAborted()
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('STALE'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason ?? 'superseded', current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      liveOpts(vm, tid, 0),
    )
    await flushTicks()
    expect(tx.abortInFlight('project-replaced')).toEqual({ ok: true, kind: 'aborted' })
    gate.resolve()
    const result = await outcome
    vm.storeAsset = origStore
    // Helper bookkeeping is correct (aborted, nothing restored)...
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('aborted')
    // ...and the trusted writer performed no slot mutation after the abort.
    // DESIRED: an aborted flight performs no slot mutation.
    expect(await bytesOf(vm, tid, 0)).toContain('BASE')
  })

  it('FAIL-FIRST Q3b: project replacement during flight — old writer lands on the new generation slot', async () => {
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
        // Trusted writer with generation guard (VM capture): lands nowhere.
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
    // Project is replaced (same target id reused) + fresh pending for gen2.
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
    // Helper state part is correct (superseded, new pending untouched)...
    expect(staleResult.ok).toBe(false)
    if (!staleResult.ok) expect(staleResult.reason).toBe('superseded')
    expect(tx.snapshot().hasPending).toBe(true)
    // ...and the old generation's bytes never overwrote the new project.
    // DESIRED (VM generation guard / writer CAS): NEW-GEN2 survives.
    expect(await bytesOf(vm, tid, 0)).toContain('NEW-GEN2')
  })

  it('FAIL-FIRST Q5a: readLive throw converts an applied success into external-conflict', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const live0 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), live0).ok).toBe(true)

    const result = await tx.joinCommit(
      live0,
      async (_taken, control) => {
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('OWN'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      {
        readLive: () => {
          throw new Error('torn down')
        },
        getLiveIdentity: () => vm.getCostumeIdentity(tid, 0) as PendingCommitSlotIdentity | undefined,
      },
    )
    // The write landed and the live identity verifies it, so a torn-down
    // scope reader must not convert the success into a conflict.
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(await bytesOf(vm, tid, 0)).toContain('OWN')
  })

  it('FAIL-FIRST Q5b: without readLive a mid-flight external write is reported as committed', async () => {
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
    // NOTE: no `readLive` option — verification uses the live identity
    // capability, and the CAS itself prevents the stale overwrite.
    const outcome = tx.joinCommit(
      live0,
      async (_taken, control) => {
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('STALE'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      { getLiveIdentity: () => vm.getCostumeIdentity(tid, 0) as PendingCommitSlotIdentity | undefined },
    )
    await flushTicks()
    // No `readLive`: the synchronous rename bumps the version inside the
    // window so the stale CAS fails closed; the stale bytes never land.
    expect(vm.renameCostume(tid, 0, 'EXT')).toBe(true)
    gate.resolve()
    const result = await outcome
    vm.storeAsset = origStore
    // DESIRED: conflict (external landed first, stale never overwrote it).
    expect(result.ok).toBe(false)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('EXT')
    expect(await bytesOf(vm, tid, 0)).toContain('base')
  })

  it('PASS Q4: async mutating writer cannot corrupt the retained pending (private copy per write)', async () => {
    const tx = createPendingBitmapTransaction()
    const live = {
      targetId: 'target-1',
      costumeIndex: 0,
      assetKey: 'asset-a',
      loadSerial: 7,
      sessionGeneration: 3,
      editEpoch: 11,
      projectGeneration: 1,
    } satisfies PendingCommitScope
    const input = baseOf(4, 4, 77)
    const before = Array.from(input.data)
    expect(tx.stage(shapeOf(), input, live).ok).toBe(true)

    const gate = deferred<void>()
    let seenCopy: Uint8ClampedArray | undefined
    const failed = tx.joinCommit(live, async (taken) => {
      seenCopy = taken.base.data
      expect(Array.from(taken.base.data)).toEqual(before)
      await gate.promise
      // Async mutation AFTER the await: must hit only the private copy.
      taken.base.data.fill(0)
      return { ok: false as const, reason: 'store-full' }
    })
    await flushTicks()
    gate.resolve()
    expect((await failed).ok).toBe(false)
    expect(seenCopy).toBeDefined()
    // Retry observes pristine bytes, proving the retained taken.base was
    // never aliased by the writer's copy (peak cost: retained base + one
    // in-flight copy, both canvas-bounded by the refused-workspace caps).
    const retrySeen: number[][] = []
    const retryIdentity = { assetId: 'asset-new', md5ext: 'asset-new.svg', writeSeq: 99 } as const
    const retry = await tx.joinCommit(
      live,
      (taken) => {
        retrySeen.push(Array.from(taken.base.data))
        return { ok: true as const, applied: true as const, newIdentity: { ...retryIdentity } }
      },
      {
        readLive: () => ({ ...live }),
        getLiveIdentity: () => ({ ...retryIdentity }),
      },
    )
    expect(retry).toEqual({ ok: true, kind: 'committed' })
    expect(retrySeen[0]).toEqual(before)
  })

  it('PASS Q5c: simultaneous same-slot join shares one write; other-slot join refuses without stealing', async () => {
    const tx = createPendingBitmapTransaction()
    const slotA = {
      targetId: 'target-a',
      costumeIndex: 0,
      assetKey: 'asset-a',
      loadSerial: 7,
      sessionGeneration: 3,
      editEpoch: 11,
      projectGeneration: 1,
    } satisfies PendingCommitScope
    const slotB = { ...slotA, targetId: 'target-b', assetKey: 'asset-b' }
    expect(tx.stage(shapeOf(), baseOf(), slotA).ok).toBe(true)
    const gateIdentity = { assetId: 'asset-new', md5ext: 'asset-new.svg', writeSeq: 99 } as const
    const gate = deferred<{ ok: true; applied: true; newIdentity: typeof gateIdentity }>()
    let calls = 0
    const first = tx.joinCommit(
      slotA,
      () => {
        calls += 1
        return gate.promise
      },
      {
        readLive: () => ({ ...slotA }),
        getLiveIdentity: () => ({ ...gateIdentity }),
      },
    )
    const during = await tx.joinCommit(slotB, () => Promise.resolve({ ok: false as const, reason: 'unreachable' }))
    expect(during.ok).toBe(false)
    if (!during.ok) expect(during.reason).toBe('commit-in-flight')
    gate.resolve({ ok: true, applied: true, newIdentity: { ...gateIdentity } })
    expect(await first).toEqual({ ok: true, kind: 'committed' })
    expect(calls).toBe(1)
  })

  it('durable: sync renameCostume inside the await window is kept (versioned CAS conflict)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('press-base'))
    const baseIdent = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
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
    const outcome = tx.joinCommit(
      live0,
      async (_taken, control) => {
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { name: 'stale-restore', dataFormat: 'svg' },
          svgBytes('STALE'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      liveOpts(vm, tid, 0),
    )
    await flushTicks()
    // External metadata-only write: same bytes, bumped writeSeq.
    expect(vm.renameCostume(tid, 0, 'ExtRename')).toBe(true)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    expect(vm.getCostumeIdentity(tid, 0)?.assetId).toBe(baseIdent.assetId)
    gate.resolve()
    const result = await outcome
    vm.storeAsset = origStore
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('external-conflict')
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('ExtRename')
    expect(await bytesOf(vm, tid, 0)).toContain('press-base')
  })

  it('durable: void writer resolutions and missing live capability are rejected fail-closed', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tx = createPendingBitmapTransaction()
    const live0 = scopeFromVM(vm, tid, 0)
    expect(tx.stage(shapeOf(), baseOf(), live0).ok).toBe(true)
    // Plain Promise<void> carries no verifiable outcome: rejected, pending
    // retained while still owned for an explicit retry.
    const voidResult = await tx.joinCommit(live0, (async () => undefined) as never, liveOpts(vm, tid, 0))
    expect(voidResult.ok).toBe(false)
    if (!voidResult.ok) expect(voidResult.reason).toBe('commit-rejected')
    expect(tx.snapshot().hasPending).toBe(true)

    // Claimed success without a live verifier cannot be verified: rejected.
    const noLive = await tx.joinCommit(
      live0,
      async () => ({ ok: true as const, applied: true as const, newIdentity: { assetId: 'a', md5ext: 'm.svg', writeSeq: 999 } }),
      {},
    )
    expect(noLive.ok).toBe(false)
    if (!noLive.ok) expect(noLive.reason).toBe('commit-rejected')
    expect(tx.snapshot().hasPending).toBe(true)

    // Exact history identity: the trusted CAS success bumps the version by
    // exactly one and mints a new md5ext; the next edit re-bases from it.
    const before = vm.getCostumeIdentity(tid, 0)!
    const beforeSeq = vm.getCostumeWriteSeq(tid, 0)
    const committed = await tx.joinCommit(
      scopeFromVM(vm, tid, 0),
      async (_taken, control) => {
        if (!control.shouldCommit()) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('durable-own'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason, current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      liveOpts(vm, tid, 0),
    )
    expect(committed).toEqual({ ok: true, kind: 'committed' })
    const after = vm.getCostumeIdentity(tid, 0)!
    expect(after.md5ext).not.toBe(before.md5ext)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(beforeSeq + 1)
    expect(await bytesOf(vm, tid, 0)).toContain('durable-own')
    expect(tx.snapshot().hasPending).toBe(false)
  })

  it('durable: guard is invoked synchronously at the actual commit, abort token prevents the VM write', async () => {
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
    const guardCalls: boolean[] = []
    const outcome = tx.joinCommit(
      live0,
      async (_taken, control) => {
        await gate.promise
        // Guard MUST be consulted here at the actual commit point, not
        // before the await above: the abort lands inside the window.
        const ok = control.shouldCommit()
        guardCalls.push(ok)
        if (!ok) return { ok: true as const, applied: false as const, reason: 'superseded' }
        const r = await vm.updateCostumeIfMatch(
          tid,
          0,
          { assetId: control.expected.assetId, md5ext: control.expected.md5ext, writeSeq: control.expected.writeSeq },
          { dataFormat: 'svg' },
          svgBytes('LATE'),
          undefined,
          control.abort,
        )
        if (!r.applied) return { ok: true as const, applied: false as const, reason: r.reason ?? 'superseded', current: r.current }
        return { ok: true as const, applied: true as const, newIdentity: r.current! }
      },
      liveOpts(vm, tid, 0),
    )
    await flushTicks()
    expect(tx.abortInFlight('switch')).toEqual({ ok: true, kind: 'aborted' })
    gate.resolve()
    // Release the VM-level store gate too (same deferred doubles as both).
    gate.resolve()
    const result = await outcome
    vm.storeAsset = origStore
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('aborted')
    expect(guardCalls).toEqual([false])
    expect(await bytesOf(vm, tid, 0)).toContain('base')
    expect(tx.snapshot().hasPending).toBe(false)
    expect(tx.snapshot().commitInFlight).toBe(false)
  })
})
