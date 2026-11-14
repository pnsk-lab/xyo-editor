import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '../src/index'

/**
 * Runtime-sync epoch preservation (fail-first for the generation-guard fix).
 *
 * - Pure runtime state sync (`applyRuntimeSnapshot`, running or idle) must
 *   preserve the same project's identity / writeSeq / queue: a gated
 *   in-flight preview across the sync still commits, an external
 *   metadata-only (same bytes) write is never overwritten by stale worker
 *   data, and the next versioned CAS does not false-fire.
 * - `commitRuntimeSnapshot` on the same project bumps the generation exactly
 *   once (stale gated preview discarded) while preserving the monotonic
 *   writeSeq so persistent CAS survives and the next gesture re-bases.
 * - True replacement (`loadProject` reusing the same target id) still fully
 *   resets the epoch and discards stale queued writes.
 * - `storeAsset` failure never corrupts the queue: tails settle, seq
 *   unchanged, retry succeeds.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()
const svg = (n: number | string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text>${n}</text></svg>`
const svgBytes = (n: number | string) => enc.encode(svg(n))

async function bytesOf(vm: ScratchVM, targetId: string, index: number): Promise<string | undefined> {
  const t = vm.getTarget(targetId)
  const c = t?.costumes[index]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  const b = await vm.loadAsset(key, c?.dataFormat ?? 'svg')
  return b ? dec.decode(b) : undefined
}

function freshVM(): { vm: ScratchVM; tid: string } {
  const vm = new ScratchVM()
  vm.loadProject(createDefaultProject())
  const sprite = vm.getSprites()[0]!
  return { vm, tid: sprite.id as string }
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function workerStyleSnapshot(vm: ScratchVM, mutate?: (p: ReturnType<ScratchVM['exportProject']>) => void) {
  const snap = vm.snapshot()
  const edited = JSON.parse(JSON.stringify(snap)) as typeof snap
  if (mutate) mutate(edited.project as never)
  return edited
}

describe('runtime sync preserves CAS epoch (apply vs commit vs reload)', () => {
  it('non-running worker update (x/y only) preserves seq/queue/generation', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    const genBefore = vm.getProjectGeneration()
    const snap = workerStyleSnapshot(vm, (p: { targets: Array<{ id?: string; x?: number; y?: number }> }) => {
      const t = p.targets.find((x) => x.id === tid)
      if (t) {
        t.x = 123
        t.y = -45
      }
    })
    snap.running = false
    snap.threads = []
    vm.applyRuntimeSnapshot(snap, { cloneProject: false })
    expect(vm.getProjectGeneration()).toBe(genBefore)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq)
    expect(vm.getTarget(tid)?.x).toBe(123)
    // Host paint still works with the preserved baseline (no false external).
    const ident = vm.getCostumeIdentity(tid, 0)!
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: ident.assetId, md5ext: ident.md5ext, writeSeq: ident.writeSeq },
      { dataFormat: 'svg' },
      svgBytes('after-sync'),
    )
    expect(r.applied).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('after-sync')
  })

  it('running worker update (greenFlag) preserves a gated drag (not discarded)', async () => {
    const { vm, tid } = freshVM()
    // Real flag-hat thread keeps `running === true` (mirrors the browser audit).
    const sprite = vm.getTarget(tid)!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'wait', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 30, y: 30 },
      wait: { opcode: 'control_wait', next: null, parent: 'flag', inputs: { DURATION: [1, [4, '0.1']] }, fields: {}, shadow: false, topLevel: false },
    } as never
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    vm.greenFlag()
    expect(vm.isRunning()).toBe(true)
    const genBefore = vm.getProjectGeneration()
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('drag'))
    await tick(20)
    // Worker RUNTIME_STEP-style sync: only runtime fields move.
    const snap = workerStyleSnapshot(vm, (p: { targets: Array<{ id?: string; x?: number }> }) => {
      const t = p.targets.find((x) => x.id === tid)
      if (t) t.x = 42
    })
    snap.running = true
    vm.applyRuntimeSnapshot(snap, { cloneProject: false })
    expect(vm.getProjectGeneration()).toBe(genBefore)
    release()
    const res = await pending
    vm.storeAsset = orig
    vm.stopAll()
    expect(res.applied).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('drag')
  })

  it('external metadata-only (same bytes) survives a stale worker sync', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const baseBytes = await bytesOf(vm, tid, 0)
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    // Host external: metadata-only, same bytes identity.
    await vm.updateCostume(tid, 0, { name: 'ExtMeta', rotationCenterX: 999, rotationCenterY: 888 })
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    // Stale worker snapshot (pre-external metadata) must NOT overwrite host.
    const stale = workerStyleSnapshot(vm, (p: { targets: Array<{ id?: string; costumes: Array<{ name: string }> }> }) => {
      const t = p.targets.find((x) => x.id === tid)
      if (t?.costumes[0]) t.costumes[0].name = 'OldName'
    })
    // Force the incoming snapshot to carry the OLD name (stale worker).
    const idx = stale.project.targets.findIndex((t) => t.id === tid)
    if (idx >= 0) {
      const live = vm.getTarget(tid)!.costumes[0]!
      void live
      // stale already has old name via structured snapshot before external? Re-set explicitly:
      const staleCostume = (stale.project.targets[idx] as unknown as { costumes: Array<{ name: string }> }).costumes[0]!
      staleCostume.name = 'StaleWorkerName'
    }
    vm.applyRuntimeSnapshot(stale, { cloneProject: false })
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('ExtMeta')
    expect(await bytesOf(vm, tid, 0)).toBe(baseBytes)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    // Stale versioned restore still correctly refused (external kept).
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: vm.getCostumeIdentity(tid, 0)!.assetId, md5ext: vm.getCostumeIdentity(tid, 0)!.md5ext, writeSeq: baseSeq },
      { rotationCenterX: 111, rotationCenterY: 111, dataFormat: 'svg' },
      svgBytes('stale-edit'),
    )
    expect(r.applied).toBe(false)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('ExtMeta')
  })

  it('same-bytes external rewrite + worker sync keeps the external (no hash-only miss)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { name: 'Orig', dataFormat: 'svg' }, svgBytes('same'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    const raw = await bytesOf(vm, tid, 0)
    await vm.updateCostume(tid, 0, { name: 'ExtSame' }, enc.encode(raw!))
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    const snap = workerStyleSnapshot(vm, (p: { targets: Array<{ id?: string; x?: number }> }) => {
      const t = p.targets.find((x) => x.id === tid)
      if (t) t.x = 7
    })
    vm.applyRuntimeSnapshot(snap, { cloneProject: false })
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('ExtSame')
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { name: 'Orig', dataFormat: 'svg' },
      enc.encode(raw!),
    )
    expect(r.applied).toBe(false)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('ExtSame')
  })

  it('commit on the same project bumps once, discards the gated preview, preserves seq', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const seqBefore = vm.getCostumeWriteSeq(tid, 0)
    const genBefore = vm.getProjectGeneration()
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('gated'))
    await tick(20)
    const snap = vm.snapshot()
    const edited = JSON.parse(JSON.stringify(snap)) as typeof snap
    edited.running = false
    edited.threads = []
    vm.commitRuntimeSnapshot(edited)
    expect(vm.getProjectGeneration()).toBe(genBefore + 1)
    release()
    const res = await pending
    vm.storeAsset = orig
    expect(res.applied).toBe(false)
    expect(await bytesOf(vm, tid, 0)).toContain('base')
    // Persistent CAS survives: seq preserved, next gesture re-bases cleanly.
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(seqBefore)
    const ident = vm.getCostumeIdentity(tid, 0)!
    const ok = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: ident.assetId, md5ext: ident.md5ext, writeSeq: ident.writeSeq },
      { dataFormat: 'svg' },
      svgBytes('fresh-after-commit'),
    )
    expect(ok.applied).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('fresh-after-commit')
  })

  it('stale queued old-project writes still discarded after true reload (same id)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes(1))
    const genBefore = vm.getProjectGeneration()
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(999))
    await tick(20)
    const proj = vm.exportProject() as unknown as {
      targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }>
    }
    const idx = proj.targets.findIndex((t) => t.id === tid)
    const stored = await orig(enc.encode(svg(777)), 'svg')
    proj.targets[idx]!.costumes[0] = {
      ...proj.targets[idx]!.costumes[0],
      assetId: stored.assetId,
      md5ext: stored.md5ext,
      dataFormat: 'svg',
    }
    ;(vm as unknown as { assetBytes: Map<string, Uint8Array> }).assetBytes.set(stored.assetId, enc.encode(svg(777)))
    ;(vm as unknown as { assetBytes: Map<string, Uint8Array> }).assetBytes.set(stored.md5ext, enc.encode(svg(777)))
    await vm.loadProject(proj)
    expect(vm.getProjectGeneration()).toBeGreaterThan(genBefore)
    release()
    const res = await pending
    vm.storeAsset = orig
    expect(res.applied).toBe(false)
    expect(await bytesOf(vm, tid, 0)).toContain('777')
  })

  it('storeAsset failure recovers: queue intact, seq unchanged, retry succeeds', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const seqBefore = vm.getCostumeWriteSeq(tid, 0)
    const orig = vm.storeAsset.bind(vm)
    let failOnce = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (failOnce) {
        failOnce = false
        throw new Error('API failure (injected)')
      }
      return orig(d, f)
    }
    await expect(vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('boom'))).rejects.toThrow('API failure')
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(seqBefore)
    expect(await bytesOf(vm, tid, 0)).toContain('base')
    const ok = await vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('retry'))
    vm.storeAsset = orig
    expect(ok.applied).toBe(true)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(seqBefore + 1)
    expect(await bytesOf(vm, tid, 0)).toContain('retry')
  })
})
