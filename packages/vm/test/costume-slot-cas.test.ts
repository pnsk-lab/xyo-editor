import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '../src/index'

/**
 * Permanent regression suite for slot-scoped costume CAS.
 *
 * Covers the independent CAS audit cases:
 * - old-project queued writes must not land on a reloaded project reusing
 *   the same target id (project generation guard),
 * - metadata-only external writes must be detected by monotonic version even
 *   when bytes (and therefore asset identity) are unchanged,
 * - UI conflicts keep the external write,
 * - Map tail cleanup removes only the last settled tail (identity-checked),
 *   never breaks queue order, never creates keys for unknown targets, and
 *   stays bounded under 1001 stale cancellations / 1000-target churn.
 *
 * Boundary (by design, documented on the VM): direct `project.targets` /
 * costume plain-object mutation and plugins bypassing the VM API are outside
 * the protection scope. Stable-id-only CAS (`updateCostumeIfMatch`) and the
 * legacy name-resolution path (`updateCostume`) are explicit separate routes.
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
function seqsOf(vm: ScratchVM): Map<string, number> {
  return (vm as unknown as { costumeWriteSeq: Map<string, number> }).costumeWriteSeq
}
function structsOf(vm: ScratchVM): Map<string, number> {
  return (vm as unknown as { costumeStructureSeq: Map<string, number> }).costumeStructureSeq
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('costume slot CAS (generation + version + structure)', () => {
  it('metadata-only external write is detected by version: stale versioned CAS keeps external', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    // External metadata-only update: no bytes, so asset identity is unchanged.
    await vm.updateCostume(tid, 0, { name: 'Ext', rotationCenterX: 999, rotationCenterY: 999 })
    const afterExt = vm.getTarget(tid)!.costumes[0]!
    expect(afterExt.assetId).toBe(base.assetId)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    // Stale versioned preview must NOT clobber the external center.
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { rotationCenterX: 111, rotationCenterY: 111, bitmapResolution: 1, dataFormat: 'svg' },
      svgBytes('edit'),
    )
    const live = vm.getTarget(tid)!.costumes[0]!
    expect(r.applied).toBe(false)
    expect(live.rotationCenterX).toBe(999)
    expect(live.rotationCenterY).toBe(999)
  })

  it('same-bytes rename still bumps version: stale versioned restore keeps external name', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { name: 'Orig', dataFormat: 'svg' }, svgBytes('same'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    const raw = await bytesOf(vm, tid, 0)
    // External: same bytes via a new store call + rename. Identity is stable.
    await vm.updateCostume(tid, 0, { name: 'ExtSame' }, enc.encode(raw!))
    const after = vm.getCostumeIdentity(tid, 0)!
    expect(after.assetId).toBe(base.assetId)
    expect(after.md5ext).toBe(base.md5ext)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    // Stale versioned restore (old meta + same bytes) must keep the external.
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

  it('legacy hash-only expected stays compatible (no version field accepted)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('v1'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const r = await vm.updateCostumeIfMatch(tid, 0, { assetId: base.assetId, md5ext: base.md5ext }, { dataFormat: 'svg' }, svgBytes('v2'))
    expect(r.applied).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('v2')
  })

  it('queued old-project writes are discarded after reload reusing the same target id', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes(1))
    const genBefore = vm.getProjectGeneration()
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let calls = 0
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      calls += 1
      if (calls === 1) await gate
      return orig(d, f)
    }
    const barrier = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(10))
    const victim = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(999))
    await tick(20)
    // Reload a new project reusing the SAME target id with different bytes.
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
    const [rb, rv] = await Promise.all([barrier, victim])
    vm.storeAsset = orig
    expect(rb.applied).toBe(false)
    expect(rv.applied).toBe(false)
    const after = await bytesOf(vm, tid, 0)
    expect(after).toContain('777')
    expect(after).not.toContain('999')
    expect(after).not.toContain('>10<')
  })

  it('target delete discards pending write; recreate starts clean', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes(5))
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(666))
    await tick(20)
    vm.deleteTarget(tid)
    release()
    const res = await pending
    vm.storeAsset = orig
    expect(res.applied).toBe(false)
    expect(vm.getTarget(tid)).toBeUndefined()
    const proj = createDefaultProject() as unknown as {
      targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }>
    }
    proj.targets[1]!.id = tid
    proj.targets[1]!.costumes[0] = { ...proj.targets[1]!.costumes[0], name: 'recreated' }
    await vm.loadProject(proj)
    expect(vm.getTarget(tid)?.costumes[0]?.name).toBe('recreated')
  })

  it('index-shifting structure ops during pending write never land stale bytes (delete/reorder/duplicate)', async () => {
    for (const op of ['delete', 'reorder', 'duplicate'] as const) {
      const { vm, tid } = freshVM()
      await vm.addCostume('c2.svg', { name: 'c2', dataFormat: 'svg' } as never, tid)
      await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes(100))
      await vm.updateCostume(tid, 1, { dataFormat: 'svg' }, svgBytes(200))
      const orig = vm.storeAsset.bind(vm)
      let release!: () => void
      const gate = new Promise<void>((res) => (release = res))
      vm.storeAsset = async (d: Uint8Array, f: string) => {
        await gate
        return orig(d, f)
      }
      const pending = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(999))
      await tick(20)
      if (op === 'delete') vm.deleteCostume(tid, 0)
      if (op === 'reorder') vm.reorderCostume(tid, 0, 1)
      if (op === 'duplicate') await vm.duplicateCostume(tid, 0)
      release()
      const res = await pending
      vm.storeAsset = orig
      expect(res.applied).toBe(false)
      expect(await bytesOf(vm, tid, 0)).not.toContain('999')
    }
  })

  it('FIFO order is preserved and tails settle to zero (only-last cleanup)', async () => {
    const { vm, tid } = freshVM()
    const order: string[] = []
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let first = true
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (first) {
        first = false
        await gate
      }
      return orig(d, f)
    }
    const p1 = vm
      .updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(11))
      .then((r) => {
        order.push('p1')
        return r
      })
    const p2 = vm
      .updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(22))
      .then((r) => {
        order.push('p2')
        return r
      })
    const p3 = vm
      .updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(33))
      .then((r) => {
        order.push('p3')
        return r
      })
    await tick(20)
    // Three chained writes on one slot: a single shared tail.
    expect(tailsOf(vm).size).toBe(1)
    release()
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    vm.storeAsset = orig
    expect([r1.applied, r2.applied, r3.applied]).toEqual([true, true, true])
    expect(order).toEqual(['p1', 'p2', 'p3'])
    expect(await bytesOf(vm, tid, 0)).toContain('33')
    // Settled tails are pruned; only the last settlement removes the key.
    expect(tailsOf(vm).size).toBe(0)
  })

  it('unknown target creates no tail key', async () => {
    const { vm } = freshVM()
    const before = tailsOf(vm).size
    const r = await vm.updateCostumeIfMatch('no-such-target', 0, undefined, { dataFormat: 'svg' }, svgBytes('x'))
    expect(r.applied).toBe(false)
    expect(tailsOf(vm).size).toBe(before)
  })

  it('1001 stale-versioned cancellations stay bounded and keep the external write', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('press-base'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    // External same-slot write wins.
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('external'))
    const results: boolean[] = []
    for (let i = 0; i < 1001; i += 1) {
      const r = await vm.updateCostumeIfMatch(
        tid,
        0,
        { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
        { dataFormat: 'svg' },
        svgBytes(`stale-${i}`),
      )
      results.push(r.applied)
    }
    expect(results.every((applied) => applied === false)).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('external')
    expect(tailsOf(vm).size).toBe(0)
    expect(seqsOf(vm).size).toBeLessThanOrEqual(2)
  })

  it('1000-target churn leaves no tail/seq/structure leak and reload clears generations', async () => {
    const { vm } = freshVM()
    const base = createDefaultProject() as unknown as {
      targets: Array<{ id?: string; name: string; isStage: boolean; costumes: Array<Record<string, unknown>> }>
    }
    const sprite = base.targets[1]!
    for (let i = 0; i < 1000; i += 1) {
      base.targets.push({ ...structuredClone(sprite), id: `leak-${i}`, name: `Leak${i}` })
    }
    await vm.loadProject(base)
    // Independent slots run concurrently. PNG bytes skip SVG sanitizing so
    // the 1000-write churn stays fast; queue/generation/prune behavior is
    // format-independent.
    const pngBytes = (i: number) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, i & 255, (i >> 8) & 255])
    const applied = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => vm.updateCostumeIfMatch(`leak-${i}`, 0, undefined, { dataFormat: 'png' }, pngBytes(i))),
    )
    expect(applied.every((r) => r.applied === true)).toBe(true)
    expect(tailsOf(vm).size).toBe(0)
    for (let i = 0; i < 1000; i += 1) vm.deleteTarget(`leak-${i}`)
    expect(tailsOf(vm).size).toBe(0)
    // Per-target seq/structure entries are pruned with the target.
    for (const key of [...seqsOf(vm).keys()]) {
      expect(key.startsWith('leak-')).toBe(false)
    }
    expect(structsOf(vm).size).toBe(0)
    await vm.loadProject(createDefaultProject())
    expect(tailsOf(vm).size).toBe(0)
    expect(seqsOf(vm).size).toBe(0)
    expect(structsOf(vm).size).toBe(0)
  }, 30000)

  it('dataFormat follows patch priority through CAS (svg live + png patch converts)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('v'))
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
    const r = await vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'png' }, png)
    const live = vm.getTarget(tid)!.costumes[0]!
    expect(r.applied).toBe(true)
    expect(live.dataFormat).toBe('png')
    expect(live.md5ext?.endsWith('.png')).toBe(true)
  })

  it('stable-id CAS never steers onto a same-name alias; legacy name path stays explicit', async () => {
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
    const r = await vm.updateCostumeIfMatch('idB', 0, undefined, { dataFormat: 'svg' }, svgBytes(333))
    expect(r.applied).toBe(true)
    expect(await bytesOf(vm, 'idA', 0)).toContain('AAA')
    expect(await bytesOf(vm, 'idB', 0)).toContain('333')
    // Legacy name resolution documents first-match aliasing (explicit path).
    await vm.updateCostume('Dup', 0, { dataFormat: 'svg' }, svgBytes('via-name'))
    expect(await bytesOf(vm, 'idA', 0)).toContain('via-name')
    expect(await bytesOf(vm, 'idB', 0)).toContain('333')
  })

  it('second operation after a settled write races cleanly (no lost update)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('first'))
    const mid = vm.getCostumeIdentity(tid, 0)!
    const midSeq = vm.getCostumeWriteSeq(tid, 0)
    const r = await vm.updateCostumeIfMatch(
      tid,
      0,
      { assetId: mid.assetId, md5ext: mid.md5ext, writeSeq: midSeq },
      { dataFormat: 'svg' },
      svgBytes('second'),
    )
    expect(r.applied).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('second')
    expect(tailsOf(vm).size).toBe(0)
  })
})
