import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '../src/index'

/**
 * Durable regression suite for the `renameCostume` / CAS name-clobber race.
 *
 * Bug (fail-first): `renameCostume` rewrote `costume.name` synchronously with
 * no `writeSeq` bump, and `updateCostumeIfMatch` verified `expected` only
 * *before* the `storeAsset` await. A history restore (or any other CAS) whose
 * patch carries `name` could therefore land on a stale `writeSeq` and
 * silently delete an external rename — synchronously, or inside the await
 * window. The fix keeps the public sync API / events / slot FIFO unchanged:
 *
 * - `renameCostume` bumps the per-slot `writeSeq` synchronously on every real
 *   name change (no-op same-name renames stay version-neutral), so stale
 *   versioned CAS fails closed instead of clobbering.
 * - `updateCostumeIfMatch` re-verifies `expected` (hash + `writeSeq`) after
 *   the `storeAsset` await, immediately before the atomic mutation, so a
 *   rename landing inside the await window is also kept.
 *
 * Normal-flow note (no false external conflict for user-initiated renames):
 * a *new* edit started after the rename captures a fresh identity via
 * `getCostumeIdentity()` (post-rename `writeSeq`), so its CAS still applies.
 * Only CAS captured *before* the rename (stale `writeSeq`) is rejected, and
 * an Undo/Redo whose pre-check/expected predates the user's own rename is
 * likewise refused fail-closed (stack intact) — the Editor must refresh its
 * last-known slot identity after driving `renameCostume` (Editor-side
 * follow-up; `Editor.svelte` untouched here).
 *
 * Boundary (by design, same as the slot-CAS suite): direct plain-object
 * mutation of `project.targets` / costume objects, plugins bypassing the VM
 * API, and legacy hash-only callers (`expected` without a version field) stay
 * outside the version protection.
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

function tailsOf(vm: ScratchVM): Map<string, Promise<void>> {
  return (vm as unknown as { costumeWriteTails: Map<string, Promise<void>> }).costumeWriteTails
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('renameCostume / CAS name-clobber race (fail-first durable)', () => {
  it('stale versioned CAS with a name patch rejects after a synchronous rename (external name kept)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    // External rename AFTER the capture (the lost-update window).
    expect(vm.renameCostume(tid, 0, 'External')).toBe(true)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    // Stale history-restore-style CAS: old expected + patch carrying a name.
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { name: 'StaleRestore', dataFormat: 'svg' },
      svgBytes('stale-bytes'),
    )
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('conflict')
    const live = vm.getTarget(tid)!.costumes[0]!
    expect(live.name).toBe('External')
    expect(await bytesOf(vm, tid, 0)).toContain('base')
    expect(await bytesOf(vm, tid, 0)).not.toContain('stale-bytes')
    // The rejection itself bumps nothing further.
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
  })

  it('rename inside the storeAsset await rejects on release (external name and bytes kept)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
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
      tid,
      0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { name: 'StaleRestore', dataFormat: 'svg' },
      svgBytes('stale-bytes'),
    )
    while (!entered) await tick(5)
    expect(vm.renameCostume(tid, 0, 'ExternalMidFlight')).toBe(true)
    release()
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('conflict')
    const live = vm.getTarget(tid)!.costumes[0]!
    expect(live.name).toBe('ExternalMidFlight')
    expect(await bytesOf(vm, tid, 0)).toContain('base')
    expect(await bytesOf(vm, tid, 0)).not.toContain('stale-bytes')
  })

  it('rename during await still reports conflict (not superseded) when the selection is current', async () => {
    const vm = new ScratchVM()
    vm.loadProject(createDefaultProject())
    const tid = vm.getSprites()[0]!.id as string
    vm.selectTarget(tid)
    vm.setCurrentCostume(tid, 0)
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const sel = {
      targetId: tid,
      index: 0,
      projectGeneration: vm.getProjectGeneration(),
      selectionEpoch: vm.getSelectionEpoch(),
    }
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
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
      tid,
      0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { name: 'StaleRestore', dataFormat: 'svg' },
      svgBytes('stale-bytes'),
      sel,
    )
    while (!entered) await tick(5)
    // Rename keeps the stable id and never bumps the epoch, so the selection
    // guard stays green — the version guard must report `conflict`.
    expect(vm.renameCostume(tid, 0, 'External')).toBe(true)
    release()
    const r = await pending
    vm.storeAsset = orig
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('conflict')
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('External')
  })

  it('fresh capture after a rename still applies (no false conflict for new user edits)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    expect(vm.renameCostume(tid, 0, 'UserRename')).toBe(true)
    // A new edit started AFTER the rename captures the post-rename version.
    const fresh = vm.getCostumeIdentity(tid, 0)!
    const freshSeq = vm.getCostumeWriteSeq(tid, 0)
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: fresh.assetId, md5ext: fresh.md5ext, writeSeq: freshSeq },
      { dataFormat: 'svg' },
      svgBytes('new-edit'),
    )
    expect(r.applied).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('new-edit')
    // Bytes-only patch preserves the user's rename.
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('UserRename')
  })

  it('undo-style restore with a stale pre-rename expected is refused fail-closed', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { name: 'Orig', dataFormat: 'svg' }, svgBytes('orig'))
    const stale = vm.getCostumeIdentity(tid, 0)!
    const staleSeq = vm.getCostumeWriteSeq(tid, 0)
    // User's own rename lands after the history entry was recorded.
    expect(vm.renameCostume(tid, 0, 'UserRename')).toBe(true)
    // Restoring the pre-rename entry (old bytes + old name) must not delete
    // the rename: refused with the stack (here: the slot) intact.
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: stale.assetId, md5ext: stale.md5ext, writeSeq: staleSeq },
      { name: 'Orig', dataFormat: 'svg' },
      svgBytes('orig'),
    )
    expect(r.applied).toBe(false)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('UserRename')
    // Re-captured (post-rename) restores apply — the Editor refresh path.
    const fresh = vm.getCostumeIdentity(tid, 0)!
    const r2 = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: fresh.assetId, md5ext: fresh.md5ext, writeSeq: vm.getCostumeWriteSeq(tid, 0) },
      { name: 'Orig', dataFormat: 'svg' },
      svgBytes('orig'),
    )
    expect(r2.applied).toBe(true)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('Orig')
  })

  it('no-op same-name rename stays version-neutral (no false conflict)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const current = vm.getTarget(tid)!.costumes[0]!.name
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    expect(vm.renameCostume(tid, 0, current)).toBe(true)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq)
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { name: 'Next', dataFormat: 'svg' },
      svgBytes('next'),
    )
    expect(r.applied).toBe(true)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('Next')
  })

  it('rename keeps the public sync API and events (boolean + PROJECT_CHANGED/TARGETS_UPDATE)', async () => {
    const { vm, tid } = freshVM()
    const events: string[] = []
    vm.on('PROJECT_CHANGED', () => events.push('PROJECT_CHANGED'))
    vm.on('TARGETS_UPDATE', () => events.push('TARGETS_UPDATE'))
    expect(vm.renameCostume(tid, 0, 'Renamed')).toBe(true)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('Renamed')
    expect(events).toContain('PROJECT_CHANGED')
    expect(events).toContain('TARGETS_UPDATE')
    expect(vm.renameCostume(tid, 99, 'Missing')).toBe(false)
    expect(vm.renameCostume(tid, 0, '   ')).toBe(false)
  })

  it('non-selected same-name collision: rename is slot-scoped, no cross-slot pollution', async () => {
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
    const baseB = vm.getCostumeIdentity('idB', 0)!
    const seqB = vm.getCostumeWriteSeq('idB', 0)
    const seqABefore = vm.getCostumeWriteSeq('idA', 0)
    // Rename the NON-selected colliding slot (stable-id route).
    expect(vm.renameCostume('idA', 0, 'RenamedA')).toBe(true)
    expect(vm.getTarget('idA')!.costumes[0]!.name).toBe('RenamedA')
    expect(vm.getCostumeWriteSeq('idA', 0)).toBe(seqABefore + 1)
    // The untouched namesake slot keeps its version: fresh CAS still applies.
    expect(vm.getCostumeWriteSeq('idB', 0)).toBe(seqB)
    const ok = await vm.updateCostumeIfMatch(
      'idB',
      0,
      { assetId: baseB.assetId, md5ext: baseB.md5ext, writeSeq: seqB },
      { dataFormat: 'svg' },
      svgBytes('BBB2'),
    )
    expect(ok.applied).toBe(true)
    expect(await bytesOf(vm, 'idB', 0)).toContain('BBB2')
    // And stale CAS on the renamed slot rejects.
    const stale = await vm.updateCostumeIfMatch(
      'idA',
      0,
      { assetId: baseB.assetId, md5ext: baseB.md5ext, writeSeq: seqABefore },
      { name: 'Clobber', dataFormat: 'svg' },
      svgBytes('clobber'),
    )
    expect(stale.applied).toBe(false)
    expect(vm.getTarget('idA')!.costumes[0]!.name).toBe('RenamedA')
  })

  it('dataFormat patch with a stale expected rejects (live format preserved)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    expect(vm.renameCostume(tid, 0, 'External')).toBe(true)
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { name: 'Stale', dataFormat: 'png' },
      png,
    )
    expect(r.applied).toBe(false)
    const live = vm.getTarget(tid)!.costumes[0]!
    expect(live.name).toBe('External')
    expect(live.dataFormat).toBe('svg')
  })

  it('rename then duplicate/reorder/delete/project-replacement: stale CAS stays rejected, FIFO recovers', async () => {
    // Rename + duplicate: the duplicated slot starts clean; stale rejects.
    {
      const { vm, tid } = freshVM()
      await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
      const base = vm.getCostumeIdentity(tid, 0)!
      const baseSeq = vm.getCostumeWriteSeq(tid, 0)
      expect(vm.renameCostume(tid, 0, 'External')).toBe(true)
      await vm.duplicateCostume(tid, 0)
      const stale = await vm.updateCostumeIfMatch(
        tid,
        0,
        { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
        { name: 'Clobber', dataFormat: 'svg' },
        svgBytes('clobber'),
      )
      expect(stale.applied).toBe(false)
      // Queue recovered: a fresh write on the duplicated slot applies.
      const fresh = vm.getCostumeIdentity(tid, 1)
      const ok = await vm.updateCostumeIfMatch(
        tid,
        1,
        { assetId: fresh?.assetId, md5ext: fresh?.md5ext, writeSeq: vm.getCostumeWriteSeq(tid, 1) },
        { dataFormat: 'svg' },
        svgBytes('dup-ok'),
      )
      expect(ok.applied).toBe(true)
      expect(tailsOf(vm).size).toBe(0)
    }
    // Rename + reorder shifting the selected index: stale rejects, FIFO recovers.
    {
      const { vm, tid } = freshVM()
      await vm.addCostume('c2.svg', { name: 'c2', dataFormat: 'svg' } as never, tid)
      await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('s0'))
      await vm.updateCostume(tid, 1, { dataFormat: 'svg' }, svgBytes('s1'))
      const base = vm.getCostumeIdentity(tid, 0)!
      const baseSeq = vm.getCostumeWriteSeq(tid, 0)
      expect(vm.renameCostume(tid, 0, 'External')).toBe(true)
      vm.reorderCostume(tid, 0, 1)
      const stale = await vm.updateCostumeIfMatch(
        tid,
        0,
        { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
        { name: 'Clobber', dataFormat: 'svg' },
        svgBytes('clobber'),
      )
      expect(stale.applied).toBe(false)
      expect(await bytesOf(vm, tid, 0)).not.toContain('clobber')
      expect(await bytesOf(vm, tid, 1)).not.toContain('clobber')
      const fresh = vm.getCostumeIdentity(tid, 0)!
      const ok = await vm.updateCostumeIfMatch(
        tid,
        0,
        { assetId: fresh.assetId, md5ext: fresh.md5ext, writeSeq: vm.getCostumeWriteSeq(tid, 0) },
        { dataFormat: 'svg' },
        svgBytes('reorder-ok'),
      )
      expect(ok.applied).toBe(true)
      expect(tailsOf(vm).size).toBe(0)
    }
    // Rename + delete: stale rejects (slot gone), project stays consistent.
    {
      const { vm, tid } = freshVM()
      await vm.addCostume('c2.svg', { name: 'c2', dataFormat: 'svg' } as never, tid)
      await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('s0'))
      const base = vm.getCostumeIdentity(tid, 0)!
      const baseSeq = vm.getCostumeWriteSeq(tid, 0)
      expect(vm.renameCostume(tid, 0, 'External')).toBe(true)
      expect(vm.deleteCostume(tid, 0)).not.toBeNull()
      const stale = await vm.updateCostumeIfMatch(
        tid,
        0,
        { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
        { name: 'Clobber', dataFormat: 'svg' },
        svgBytes('clobber'),
      )
      expect(stale.applied).toBe(false)
      expect(tailsOf(vm).size).toBe(0)
    }
    // Rename + whole-project replacement reusing the same target id: the old
    // generation (and its rename version) never lands on the new project.
    {
      const { vm, tid } = freshVM()
      await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
      const base = vm.getCostumeIdentity(tid, 0)!
      const baseSeq = vm.getCostumeWriteSeq(tid, 0)
      const genBefore = vm.getProjectGeneration()
      expect(vm.renameCostume(tid, 0, 'External')).toBe(true)
      const orig = vm.storeAsset.bind(vm)
      const stored = await orig(enc.encode(svg('reloaded')), 'svg')
      const proj = vm.exportProject() as unknown as {
        targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }>
      }
      const idx = proj.targets.findIndex((t) => t.id === tid)
      proj.targets[idx]!.costumes[0] = {
        ...proj.targets[idx]!.costumes[0],
        assetId: stored.assetId,
        md5ext: stored.md5ext,
        dataFormat: 'svg',
      }
      ;(vm as unknown as { assetBytes: Map<string, Uint8Array> }).assetBytes.set(stored.assetId, enc.encode(svg('reloaded')))
      ;(vm as unknown as { assetBytes: Map<string, Uint8Array> }).assetBytes.set(stored.md5ext, enc.encode(svg('reloaded')))
      await vm.loadProject(proj)
      expect(vm.getProjectGeneration()).toBeGreaterThan(genBefore)
      const stale = await vm.updateCostumeIfMatch(
        tid,
        0,
        { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
        { name: 'Clobber', dataFormat: 'svg' },
        svgBytes('clobber'),
      )
      expect(stale.applied).toBe(false)
      expect(await bytesOf(vm, tid, 0)).toContain('reloaded')
      expect(vm.getTarget(tid)!.costumes[0]!.name).not.toBe('Clobber')
    }
  })

  it('rejected rename CAS leaves the same-slot FIFO healthy (fresh retry applies)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    expect(vm.renameCostume(tid, 0, 'External')).toBe(true)
    const rejected = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { name: 'Clobber', dataFormat: 'svg' },
      svgBytes('clobber'),
    )
    expect(rejected.applied).toBe(false)
    const fresh = vm.getCostumeIdentity(tid, 0)!
    const retry = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: fresh.assetId, md5ext: fresh.md5ext, writeSeq: vm.getCostumeWriteSeq(tid, 0) },
      { dataFormat: 'svg' },
      svgBytes('retry-ok'),
    )
    expect(retry.applied).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('retry-ok')
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('External')
    expect(tailsOf(vm).size).toBe(0)
  })
})
