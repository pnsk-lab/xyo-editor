import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '../src/index'
import type { CostumeSelectionPrecondition } from '../src/costume-slot-cas'

/**
 * Discrete-save selection precondition (`updateCostumeIfMatch` 6th arg).
 *
 * Fail-first suite for the vector-discrete-save-race T1/T2 window: the Editor
 * `isAlive` check runs inside the per-slot gate, so a target/costume switch
 * that lands after `isAlive` passed but during the VM `storeAsset` await
 * would still steer bytes into the newly selected asset without a VM guard.
 * The VM therefore validates the *actual* VM selection
 * (`getSelectedTarget()` stable id exact — never a display-name fallback —
 * plus `currentCostume`) and the monotonic `selectionEpoch` / project
 * `generation` at three points: synchronously at enqueue, at queue start
 * (before the CAS), and after `storeAsset` immediately before the atomic
 * mutation. Only explicit discrete user commits pass a selection; previews,
 * cancel restores, history Undo/Redo, and external plugin calls omit it and
 * keep legacy behavior.
 *
 * On precondition failure the VM returns
 * `{ applied: false, reason: 'superseded' }` with the live identity and
 * touches no bytes/meta/history/status/selection (no `writeSeq` bump, no
 * emit). The Editor consumes it silently.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()
const svg = (n: number | string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text>${n}</text></svg>`
const svgBytes = (n: number | string) => enc.encode(svg(n))
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function bytesOf(vm: ScratchVM, targetId: string, index: number): Promise<string | undefined> {
  const t = vm.getTarget(targetId)
  const c = t?.costumes[index]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  const b = await vm.loadAsset(key, c?.dataFormat ?? 'svg')
  return b ? dec.decode(b) : undefined
}

async function loadTwoTargets(vm: ScratchVM): Promise<{ idA: string; idB: string }> {
  const base = createDefaultProject() as unknown as {
    targets: Array<{ id?: string; name: string; costumes: Array<Record<string, unknown>> }>
  }
  base.targets[1]!.id = 'vecA'
  base.targets[1]!.name = 'VecA'
  base.targets.push({ ...structuredClone(base.targets[1]!), id: 'vecB', name: 'VecB' })
  base.targets[1]!.costumes.push({ ...structuredClone(base.targets[1]!.costumes[0]!) })
  await vm.loadProject(base)
  return { idA: 'vecA', idB: 'vecB' }
}

function discreteSelectionOf(vm: ScratchVM, targetId: string, index: number): CostumeSelectionPrecondition {
  return {
    targetId,
    index,
    projectGeneration: vm.getProjectGeneration(),
    selectionEpoch: vm.getSelectionEpoch(),
  }
}

describe('discrete-save selection precondition (fail-first)', () => {
  it('normal discrete save with a current selection still applies (no false conflict)', async () => {
    const vm = new ScratchVM()
    const { idA } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const sel = discreteSelectionOf(vm, idA, 0)
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    const r = await vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('discrete-ok'),
      sel,
    )
    expect(r.applied).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(await bytesOf(vm, idA, 0)).toContain('discrete-ok')
  })

  it('target switch during delayed storeAsset supersedes (no bytes/meta/seq/emit)', async () => {
    const vm = new ScratchVM()
    const { idA, idB } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base-A'))
    await vm.updateCostume(idB, 0, { dataFormat: 'svg' }, svgBytes('base-B'))
    const bytesBPre = await bytesOf(vm, idB, 0)
    const sel = discreteSelectionOf(vm, idA, 0)
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    const seqPre = vm.getCostumeWriteSeq(idA, 0)
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let entered = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      entered = true
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('stale-stamp'),
      sel,
    )
    while (!entered) await tick(5)
    // Switch mid-save via the real VM selection route (stable ids exact).
    vm.selectTarget(idB)
    release()
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('superseded')
    // New selection untouched: bytes + identity identical, no stamp leaked.
    expect(await bytesOf(vm, idB, 0)).toBe(bytesBPre)
    // Old slot untouched: stale bytes never landed.
    expect(await bytesOf(vm, idA, 0)).toContain('base-A')
    expect(await bytesOf(vm, idA, 0)).not.toContain('stale-stamp')
    // No seq bump, no history/status/selection side effects on the VM.
    expect(vm.getCostumeWriteSeq(idA, 0)).toBe(seqPre)
    expect(vm.getSelectedTargetStableId()).toBe(idB)
  })

  it('target away-and-back (A -> B -> A) still supersedes via the epoch', async () => {
    const vm = new ScratchVM()
    const { idA, idB } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base-A'))
    const sel = discreteSelectionOf(vm, idA, 0)
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let entered = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      entered = true
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('away-back'),
      sel,
    )
    while (!entered) await tick(5)
    // Away and back: final (targetId,index) equality holds again, but the
    // monotonic epoch moved twice, so the guard must still supersede.
    vm.selectTarget(idB)
    vm.selectTarget(idA)
    expect(vm.getSelectedTargetStableId()).toBe(idA)
    release()
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('superseded')
    expect(await bytesOf(vm, idA, 0)).toContain('base-A')
    expect(await bytesOf(vm, idA, 0)).not.toContain('away-back')
  })

  it('costume switch away-and-back (0 -> 1 -> 0) supersedes via the epoch', async () => {
    const vm = new ScratchVM()
    const { idA } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('slot0-base'))
    await vm.updateCostume(idA, 1, { dataFormat: 'svg' }, svgBytes('slot1-base'))
    const sibPre = await bytesOf(vm, idA, 1)
    const sel = discreteSelectionOf(vm, idA, 0)
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let entered = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      entered = true
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('costume-away-back'),
      sel,
    )
    while (!entered) await tick(5)
    vm.setCurrentCostume(idA, 1)
    vm.setCurrentCostume(idA, 0)
    release()
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('superseded')
    expect(await bytesOf(vm, idA, 0)).toContain('slot0-base')
    expect(await bytesOf(vm, idA, 1)).toBe(sibPre)
  })

  it('delayed queue start (switch before the turn) supersedes at start', async () => {
    const vm = new ScratchVM()
    const { idA, idB } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base-A'))
    await vm.updateCostume(idB, 0, { dataFormat: 'svg' }, svgBytes('base-B'))
    const sel = discreteSelectionOf(vm, idA, 0)
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    // Block the slot with a long first write so the discrete save waits in
    // the same-slot FIFO (delayed start, not delayed store).
    const orig = vm.storeAsset.bind(vm)
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((res) => (releaseFirst = res))
    let firstEntered = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (!firstEntered) {
        firstEntered = true
        await firstGate
      }
      return orig(d, f)
    }
    const first = vm.updateCostumeIfMatch(idA, 0, undefined, { dataFormat: 'svg' }, svgBytes('first'))
    while (!firstEntered) await tick(5)
    // Enqueue the discrete save while the first write holds the slot, then
    // switch before its turn starts.
    const pending = vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('queued-stale'),
      sel,
    )
    await tick(20)
    vm.selectTarget(idB)
    releaseFirst()
    await first
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('superseded')
    expect(await bytesOf(vm, idA, 0)).toContain('first')
    expect(await bytesOf(vm, idA, 0)).not.toContain('queued-stale')
  })

  it('project reload reusing the same target id invalidates via the generation', async () => {
    const vm = new ScratchVM()
    const { idA } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const sel = discreteSelectionOf(vm, idA, 0)
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let entered = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      entered = true
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('post-reload-stale'),
      sel,
    )
    while (!entered) await tick(5)
    // Reload a new project reusing the SAME target id with different bytes.
    const proj = vm.exportProject() as unknown as {
      targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }>
    }
    const stored = await orig(enc.encode(svg('reloaded')), 'svg')
    const idx = proj.targets.findIndex((t) => t.id === idA)
    proj.targets[idx]!.costumes[0] = {
      ...proj.targets[idx]!.costumes[0],
      assetId: stored.assetId,
      md5ext: stored.md5ext,
      dataFormat: 'svg',
    }
    ;(vm as unknown as { assetBytes: Map<string, Uint8Array> }).assetBytes.set(stored.assetId, enc.encode(svg('reloaded')))
    ;(vm as unknown as { assetBytes: Map<string, Uint8Array> }).assetBytes.set(stored.md5ext, enc.encode(svg('reloaded')))
    await vm.loadProject(proj)
    // Even if the UI re-selects the same id after reload, the captured
    // generation no longer matches, so the old save must not land.
    vm.selectTarget(idA)
    release()
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('superseded')
    expect(await bytesOf(vm, idA, 0)).toContain('reloaded')
    expect(await bytesOf(vm, idA, 0)).not.toContain('post-reload-stale')
  })

  it('reorder moving the selected index supersedes (no stale bytes on shifted art)', async () => {
    const vm = new ScratchVM()
    const { idA } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('slot0'))
    await vm.updateCostume(idA, 1, { dataFormat: 'svg' }, svgBytes('slot1'))
    const sel = discreteSelectionOf(vm, idA, 0)
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let entered = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      entered = true
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('stale-after-reorder'),
      sel,
    )
    while (!entered) await tick(5)
    vm.reorderCostume(idA, 0, 1)
    release()
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('superseded')
    expect(await bytesOf(vm, idA, 0)).not.toContain('stale-after-reorder')
    expect(await bytesOf(vm, idA, 1)).not.toContain('stale-after-reorder')
  })

  it('synchronous renameCostume during the store await conflicts (rename kept, no silent clobber)', async () => {
    const vm = new ScratchVM()
    const { idA } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base'))
    // Rename keeps the stable id and never bumps the epoch, so the selection
    // guard stays green — but the rename bumps the slot `writeSeq`, so a
    // versioned CAS captured before the rename must fail closed with
    // `conflict` (live rename kept) instead of landing stale bytes over it.
    // A new edit that captures its expected AFTER the rename still applies
    // (see the rename CAS suite); only the stale in-flight write is refused.
    const sel = discreteSelectionOf(vm, idA, 0)
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let entered = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      entered = true
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('after-rename'),
      sel,
    )
    while (!entered) await tick(5)
    expect(vm.renameCostume(idA, 0, 'renamed-mid-save')).toBe(true)
    release()
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('conflict')
    expect(await bytesOf(vm, idA, 0)).toContain('base')
    expect(await bytesOf(vm, idA, 0)).not.toContain('after-rename')
    // The synchronous rename is preserved.
    expect(vm.getTarget(idA)?.costumes[0]?.name).toBe('renamed-mid-save')
    // Queue recovered: a fresh post-rename capture applies cleanly.
    const fresh = vm.getCostumeIdentity(idA, 0)!
    const retry = await vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: fresh.assetId, md5ext: fresh.md5ext, writeSeq: vm.getCostumeWriteSeq(idA, 0) },
      { dataFormat: 'svg' },
      svgBytes('after-rename-retry'),
      discreteSelectionOf(vm, idA, 0),
    )
    expect(retry.applied).toBe(true)
    expect(await bytesOf(vm, idA, 0)).toContain('after-rename-retry')
    expect(vm.getTarget(idA)?.costumes[0]?.name).toBe('renamed-mid-save')
  })

  it('same-name alias never steers the selection guard (IDs exact)', async () => {
    const vm = new ScratchVM()
    const proj = createDefaultProject() as unknown as {
      targets: Array<{ id?: string; name: string }>
    }
    proj.targets[1]!.id = 'idA'
    proj.targets[1]!.name = 'Dup'
    proj.targets.push({ ...structuredClone(proj.targets[1]!), id: 'idB', name: 'Dup' })
    await vm.loadProject(proj)
    await vm.updateCostume('idA', 0, { dataFormat: 'svg' }, svgBytes('AAA'))
    await vm.updateCostume('idB', 0, { dataFormat: 'svg' }, svgBytes('BBB'))
    vm.selectTarget('idA')
    vm.setCurrentCostume('idA', 0)
    const selForB: CostumeSelectionPrecondition = {
      targetId: 'idB',
      index: 0,
      projectGeneration: vm.getProjectGeneration(),
      selectionEpoch: vm.getSelectionEpoch(),
    }
    // Selection is on idA but the precondition claims idB (same display name
    // `Dup`): IDs differ, so it must supersede even though the names match.
    const baseB = vm.getCostumeIdentity('idB', 0)
    const seqB = vm.getCostumeWriteSeq('idB', 0)
    const r = await vm.updateCostumeIfMatch(
      'idB',
      0,
      { assetId: baseB?.assetId, md5ext: baseB?.md5ext, writeSeq: seqB },
      { dataFormat: 'svg' },
      svgBytes('alias-steer'),
      selForB,
    )
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('superseded')
    expect(await bytesOf(vm, 'idB', 0)).toContain('BBB')
  })

  it('omitted selection keeps legacy behavior (preview/cancel/history/external)', async () => {
    const vm = new ScratchVM()
    const { idA, idB } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    // Switch away, then write without a selection (legacy preview path):
    // no superseded, the write still lands (unconditional w.r.t. selection).
    vm.selectTarget(idB)
    const r = await vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('legacy-no-selection'),
    )
    expect(r.applied).toBe(true)
    expect(await bytesOf(vm, idA, 0)).toContain('legacy-no-selection')
  })

  it('independent parallel targets keep throughput (same-slot FIFO unchanged)', async () => {
    const vm = new ScratchVM()
    const { idA, idB } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base-A'))
    await vm.updateCostume(idB, 0, { dataFormat: 'svg' }, svgBytes('base-B'))
    const selA = discreteSelectionOf(vm, idA, 0)
    const baseA = vm.getCostumeIdentity(idA, 0)
    const seqA = vm.getCostumeWriteSeq(idA, 0)
    // A selection-pinned write on VecA and an unconditional write on VecB
    // run concurrently on different slots: neither blocks the other.
    const [rA, rB] = await Promise.all([
      vm.updateCostumeIfMatch(
        idA,
        0,
        { assetId: baseA?.assetId, md5ext: baseA?.md5ext, writeSeq: seqA },
        { dataFormat: 'svg' },
        svgBytes('parallel-A'),
        selA,
      ),
      vm.updateCostumeIfMatch(idB, 0, undefined, { dataFormat: 'svg' }, svgBytes('parallel-B')),
    ])
    expect(rA.applied).toBe(true)
    expect(rB.applied).toBe(true)
    expect(await bytesOf(vm, idA, 0)).toContain('parallel-A')
    expect(await bytesOf(vm, idB, 0)).toContain('parallel-B')
  })

  it('dataFormat follows patch priority through the guarded CAS', async () => {
    const vm = new ScratchVM()
    const { idA } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('v'))
    const sel = discreteSelectionOf(vm, idA, 0)
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
    const r = await vm.updateCostumeIfMatch(idA, 0, undefined, { dataFormat: 'png' }, png, sel)
    const live = vm.getTarget(idA)!.costumes[0]!
    expect(r.applied).toBe(true)
    expect(live.dataFormat).toBe('png')
    expect(live.md5ext?.endsWith('.png')).toBe(true)
  })

  it('version conflict still reports conflict (not superseded) when selection is current', async () => {
    const vm = new ScratchVM()
    const { idA } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    vm.setCurrentCostume(idA, 0)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('press-base'))
    const base = vm.getCostumeIdentity(idA, 0)
    const baseSeq = vm.getCostumeWriteSeq(idA, 0)
    // External same-slot write wins (bumps seq).
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('external'))
    const sel = discreteSelectionOf(vm, idA, 0)
    const r = await vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('stale'),
      sel,
    )
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('conflict')
    expect(await bytesOf(vm, idA, 0)).toContain('external')
  })

  it('enqueue-time selection mismatch fails fast without creating a tail', async () => {
    const vm = new ScratchVM()
    const { idA, idB } = await loadTwoTargets(vm)
    vm.selectTarget(idA)
    await vm.updateCostume(idA, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const tails = (vm as unknown as { costumeWriteTails: Map<string, Promise<void>> }).costumeWriteTails
    const before = tails.size
    vm.selectTarget(idB)
    // Precondition still claims idA (stale capture before the switch).
    const staleSel: CostumeSelectionPrecondition = {
      targetId: idA,
      index: 0,
      projectGeneration: vm.getProjectGeneration(),
      selectionEpoch: vm.getSelectionEpoch() - 1,
    }
    const base = vm.getCostumeIdentity(idA, 0)
    const r = await vm.updateCostumeIfMatch(
      idA,
      0,
      { assetId: base?.assetId, md5ext: base?.md5ext },
      { dataFormat: 'svg' },
      svgBytes('never-queued'),
      staleSel,
    )
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('superseded')
    expect(tails.size).toBe(before)
    expect(await bytesOf(vm, idA, 0)).toContain('base')
  })
})
