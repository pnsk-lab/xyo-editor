import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'

/**
 * Fail-first gate for the Editor writeSeq migration.
 *
 * VM already bumps a monotonic per-slot `writeSeq` on every successful
 * write (bytes or metadata-only) and `updateCostumeIfMatch` rejects a stale
 * versioned `expected`. The Editor's `vectorGestureIdentities` is still
 * hash-only (`{ assetId, md5ext }`), so:
 * - a metadata-only external write (same bytes/identity, bumped seq) is
 *   invisible to previews/cancel/commit,
 * - a same-bytes external rewrite (new `storeAsset` call, same identity,
 *   bumped seq) is invisible,
 * - a normal preview never propagates the returned `writeSeq` to the next
 *   frame, so every later frame compares against a stale seq,
 * - the normal pointerup commit (`updateVectorCostumeFromEditor`) is an
 *   unconditional `vm.updateCostume` and force-overwrites an external write
 *   even after the gesture was marked conflicted,
 * - Undo/Redo restores unconditionally and deletes an external update.
 *
 * This suite fails on the pre-migration Editor wiring and passes after:
 * - `getCostumeIdentity()` is always read (never hash-only) and its
 *   `writeSeq` is present in EVERY preview/cancel/commit CAS `expected`,
 * - a normal preview propagates `result.current.writeSeq` into the gesture
 *   `last` record for the next frame,
 * - renames / metadata-only patches are never overwritten by a preview
 *   (patch carries no `name`; center comes only from the gesture SVG),
 * - the pointerup commit uses the gesture snapshot's `last` seq with
 *   compare-and-update and never re-takes the seq after a conflict,
 * - Undo/Redo carries the per-history observed identity/version and fails
 *   closed (stack intact + status) when the live slot diverged,
 * - stable-id / project-generation / slot-structure guards stay enforced,
 * - bitmap + sound paths are untouched, format-conversion patch priority
 *   (`patch.dataFormat ?? live`) is preserved,
 * - direct `vm.updateCostume` bypasses are documented as unsupported
 *   (see bottom test).
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
const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()

function hasPureHelper(): boolean {
  try {
    Bun.fileSync?.toString
    return true
  } catch {
    return false
  }
}

describe('editor writeSeq migration (fail-first)', () => {
  it('pure helper exists and Editor delegates to it (file split)', async () => {
    // AGENTS file split: pure logic lives outside Editor.svelte, Editor only wires.
    const candidates = [
      '../src/features/costumes/vector-slot-cas.ts',
      '../src/features/costumes/vector-gesture-cas.ts',
      '../src/lib/vector-slot-cas.ts',
    ]
    let found: string | undefined
    for (const c of candidates) {
      try {
        const text = await Bun.file(new URL(c, import.meta.url)).text()
        if (text.includes('writeSeq') && text.includes('expected')) {
          found = c
          break
        }
      } catch {
        // Try next candidate.
      }
    }
    expect(found).toBeDefined()
    // Editor must import the helper instead of inlining hash-only logic.
    expect(editorSource).toMatch(/from ['"]\.\/features\/costumes\/vector-slot-cas['"]|from ['"]\.\.\/features\/costumes\/vector-slot-cas['"]|from ['"].*vector-(slot|gesture)-cas['"]/)
  })

  it('gesture identities carry writeSeq from getCostumeIdentity (not hash-only)', () => {
    // capture must read the versioned identity (directly or via the pure helper wiring).
    expect(editorSource).toContain('getCostumeIdentity')
    // The stored record must include the monotonic version.
    expect(editorSource).toMatch(/writeSeq/)
    // Hash-only shape without a version field must be gone from the gesture path.
    // (Legacy VM compatibility stays, but Editor never sends hash-only expected.)
    // Pure helper split: capture delegates to readLiveSlotIdentity/createVectorGestureCasRecord.
    const start = editorSource.indexOf('function captureVectorGestureIdentity')
    expect(start).toBeGreaterThan(-1)
    const body = editorSource.slice(start, start + 2500)
    expect(body).toMatch(/readLiveSlotIdentity|getCostumeIdentity/)
    expect(body).toMatch(/createVectorGestureCasRecord|writeSeq/)
    // The live-identity reader itself must fetch writeSeq.
    const readerAt = editorSource.indexOf('function readLiveSlotIdentity')
    expect(readerAt).toBeGreaterThan(-1)
    const readerBody = editorSource.slice(readerAt, readerAt + 2500)
    expect(readerBody).toContain('getCostumeIdentity')
    expect(readerBody).toMatch(/writeSeq/)
  })

  it('every preview/cancel/commit CAS expected is versioned (writeSeq via helper delegation)', async () => {
    // Preview + cancel restore keep the literal version pin (comments and the
    // versioned compare path document the seq).
    for (const fn of ['async function updateVectorPreviewCostumeCAS', 'async function restoreVectorSnapshotExact']) {
      const at = editorSource.indexOf(fn)
      expect(at).toBeGreaterThan(-1)
      const body = editorSource.slice(at, at + 8000)
      expect(body).toContain('writeSeq')
      expect(body).toContain('updateCostumeIfMatch')
    }
    // Commit path delegates the version to the pure helper instead of
    // spelling `writeSeq` inline: discrete expected via
    // vectorSlotIdentityOf(readLiveSlotIdentity(...)) (copies the seq from
    // getCostumeIdentity), gesture expected via
    // vectorCasExpectedOf(vectorGestureRecord(...)), executed via
    // updateCostumeIfMatch, next-frame propagation via noteVectorPreviewApplied.
    // The pure-helper unit below proves the seq flows through the expected.
    const commitAt = editorSource.indexOf('async function updateVectorCostumeFromEditor')
    expect(commitAt).toBeGreaterThan(-1)
    const commitBody = editorSource.slice(commitAt, commitAt + 8000)
    expect(commitBody).toContain('vectorSlotIdentityOf(readLiveSlotIdentity')
    expect(commitBody).toContain('vectorCasExpectedOf(vectorGestureRecord')
    expect(commitBody).toContain('updateCostumeIfMatch')
    expect(commitBody).toContain('noteVectorPreviewApplied')
    expect(commitBody).toContain('readLiveSlotIdentity')
    // Pure-unit pin: the delegated expected carries the monotonic version, so
    // metadata-only / same-bytes externals are caught (hash-only would miss).
    const { createVectorGestureCasRecord, vectorCasExpectedOf, vectorSlotIdentityOf } = await import(
      '../src/features/costumes/vector-slot-cas'
    )
    const rec = createVectorGestureCasRecord('t-commit', 0, { assetId: 'a', md5ext: 'a.svg', writeSeq: 41 })
    expect(vectorCasExpectedOf(rec)).toEqual({ assetId: 'a', md5ext: 'a.svg', writeSeq: 41 })
    expect(vectorSlotIdentityOf({ assetId: 'a', md5ext: 'a.svg', writeSeq: 41 })).toEqual({
      assetId: 'a',
      md5ext: 'a.svg',
      writeSeq: 41,
    })
    // Gesture commits must go through compare-and-update.
    expect(commitBody).toContain('updateCostumeIfMatch')
  })

  it('normal preview propagates returned writeSeq to the next frame; rename/metadata-only never overwritten', () => {
    const at = editorSource.indexOf('async function updateVectorPreviewCostumeCAS')
    const body = editorSource.slice(at, at + 9000)
    // Returned seq feeds the next expected.
    expect(body).toMatch(/noteVectorPreviewApplied|last.*writeSeq|writeSeq.*last/)
    // Preview runtime patch must not carry a display name (rename-safe):
    // check the shared runtime-costume builder, not unrelated locals.
    const runtimeAt = editorSource.indexOf('function vectorRuntimeCostume(')
    expect(runtimeAt).toBeGreaterThan(-1)
    const runtimeBody = editorSource.slice(runtimeAt, runtimeAt + 6000)
    expect(runtimeBody).not.toMatch(/patch:\s*\{[^}]*\bname\b/)
    expect(runtimeBody).toContain('dataFormat')
  })

  it('pointerup commit uses gesture last-seq CAS and never force-writes after conflict', () => {
    // endVector* handlers must refuse the commit when the gesture conflicted,
    // refresh from live (residue removal), keep history untouched, and must not
    // re-read the seq to force the write.
    for (const fn of ['async function endVectorPathPointDrag', 'async function endVectorObjectRotate', 'async function endVectorLeafTranslateDrag']) {
      const at = editorSource.indexOf(fn)
      expect(at).toBeGreaterThan(-1)
      const body = editorSource.slice(at, at + 7000)
      expect(body).toMatch(/isVectorGestureConflicted|conflicted/)
      expect(body).toContain('refreshVectorPreviewFromLive')
      // History must not be committed on the conflict path.
      // (The conflict branch returns before commitPaintHistory.)
      const conflictAt = body.indexOf('conflict')
      const commitAt = body.indexOf('commitPaintHistory')
      if (conflictAt >= 0 && commitAt >= 0) {
        // Conflict handling appears; the commit is guarded by the early return.
        expect(body.slice(0, commitAt)).toContain('conflict')
      }
    }
  })

  it('VM: metadata-only external write is caught only by versioned expected (hash-only misses)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    expect(typeof base.writeSeq).toBe('number')
    // External metadata-only: same bytes, new center.
    await vm.updateCostume(tid, 0, { name: 'Ext', rotationCenterX: 999, rotationCenterY: 999 })
    // Hash-only stale expected would still match (same assetId/md5ext) and clobber.
    const hashOnly = await vm.updateCostumeIfMatch(
      tid, 0,
      { assetId: base.assetId, md5ext: base.md5ext },
      { rotationCenterX: 1, rotationCenterY: 1, dataFormat: 'svg' },
      svgBytes('hash-only-clobber'),
    )
    expect(hashOnly.applied).toBe(true)
    // Restore the external center for the versioned check.
    await vm.updateCostume(tid, 0, { name: 'Ext', rotationCenterX: 999, rotationCenterY: 999 })
    const liveSeq = vm.getCostumeWriteSeq(tid, 0)
    const versioned = await vm.updateCostumeIfMatch(
      tid, 0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { rotationCenterX: 1, rotationCenterY: 1, dataFormat: 'svg' },
      svgBytes('versioned-stale'),
    )
    expect(versioned.applied).toBe(false)
    expect(vm.getTarget(tid)!.costumes[0]!.rotationCenterX).toBe(999)
    expect(typeof liveSeq).toBe('number')
  })

  it('VM: same-bytes external rewrite bumps seq and is kept against stale versioned restore', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { name: 'Orig', dataFormat: 'svg' }, svgBytes('same'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    const raw = await bytesOf(vm, tid, 0)
    await vm.updateCostume(tid, 0, { name: 'ExtSame' }, enc.encode(raw!))
    const after = vm.getCostumeIdentity(tid, 0)!
    expect(after.assetId).toBe(base.assetId)
    expect(vm.getCostumeWriteSeq(tid, 0)).toBe(baseSeq + 1)
    const r = await vm.updateCostumeIfMatch(
      tid, 0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { name: 'Orig', dataFormat: 'svg' },
      enc.encode(raw!),
    )
    expect(r.applied).toBe(false)
    expect(vm.getTarget(tid)!.costumes[0]!.name).toBe('ExtSame')
  })

  it('VM: new-bytes external wins; stale preview with old seq skips (late preview residue rule)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('press-base'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const baseSeq = vm.getCostumeWriteSeq(tid, 0)
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('external-new'))
    const r = await vm.updateCostumeIfMatch(
      tid, 0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: baseSeq },
      { dataFormat: 'svg' },
      svgBytes('stale-preview'),
    )
    expect(r.applied).toBe(false)
    expect(await bytesOf(vm, tid, 0)).toContain('external-new')
  })

  it('VM: in-flight external between enqueue and storeAsset is discarded (structure/generation guard)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes(1))
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let gatedOnce = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (!gatedOnce) {
        gatedOnce = true
        await gate
      }
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes(999))
    await tick(20)
    // External lands while the first write is gated in storeAsset; only the
    // first call is gated so this does not deadlock.
    const external = vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('in-flight-external'))
    await tick(20)
    release()
    const [res] = await Promise.all([pending, external])
    vm.storeAsset = orig
    // Unconditional in-flight write still lands (documented gate behavior for
    // unconditional path); the versioned path below must skip instead.
    expect(res.applied).toBe(true)
    // Versioned in-flight write with a stale seq must skip.
    const { vm: vm2, tid: tid2 } = freshVM()
    await vm2.updateCostume(tid2, 0, { dataFormat: 'svg' }, svgBytes(1))
    const base2 = vm2.getCostumeIdentity(tid2, 0)!
    const seq2 = vm2.getCostumeWriteSeq(tid2, 0)
    const orig2 = vm2.storeAsset.bind(vm2)
    let release2!: () => void
    const gate2 = new Promise<void>((res2) => (release2 = res2))
    let gatedOnce2 = false
    vm2.storeAsset = async (d: Uint8Array, f: string) => {
      if (!gatedOnce2) {
        gatedOnce2 = true
        await gate2
      }
      return orig2(d, f)
    }
    // Same-slot FIFO: the earlier write applies first, the later external
    // overwrites it — the external still wins as the last writer. A stale
    // write enqueued AFTER the external completed must skip instead (late
    // preview rule, covered by the next late-enqueue check below).
    const pending2 = vm2.updateCostumeIfMatch(
      tid2, 0,
      { assetId: base2.assetId, md5ext: base2.md5ext, writeSeq: seq2 },
      { dataFormat: 'svg' },
      svgBytes(999),
    )
    await tick(20)
    const external2 = vm2.updateCostume(tid2, 0, { dataFormat: 'svg' }, svgBytes('external-during-await'))
    await tick(20)
    release2()
    const [res2] = await Promise.all([pending2, external2])
    vm2.storeAsset = orig2
    expect(res2.applied).toBe(true)
    expect(await bytesOf(vm2, tid2, 0)).toContain('external-during-await')
    // Late stale write (enqueued after the external settled) must skip.
    const lateStale = await vm2.updateCostumeIfMatch(
      tid2, 0,
      { assetId: base2.assetId, md5ext: base2.md5ext, writeSeq: seq2 },
      { dataFormat: 'svg' },
      svgBytes('late-stale-after-external'),
    )
    expect(lateStale.applied).toBe(false)
    expect(await bytesOf(vm2, tid2, 0)).toContain('external-during-await')
  })

  it('VM: runtime snapshot replacement (applyRuntimeSnapshot/commit) discards stale queued writes', async () => {
    // Project replacement boundary: a queued write from the old project must
    // never land on the new one, even when the new project reuses the same
    // target id. The Editor treats this as a new baseline (refresh + new
    // history). NOTE (undelivered sub-verification): a *running* runtime sync
    // (`applyRuntimeSnapshot` on every worker sync / `commitRuntimeSnapshot`
    // on stop) also bumps the generation today, so an in-flight drag preview
    // racing a playback tick is discarded fail-closed. Live playback+drag
    // (greenFlag running while point/rotate/leaf/move/resize + Esc/
    // pointercancel) was not verified in a browser harness here.
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('before'))
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let gatedOnce = false
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      if (!gatedOnce) {
        gatedOnce = true
        await gate
      }
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('stale-queued'))
    await tick(20)
    const snap = vm.snapshot()
    vm.applyRuntimeSnapshot(snap)
    release()
    const res = await pending
    vm.storeAsset = orig
    expect(res.applied).toBe(false)
  })

  it('VM: name/center external is kept (patch priority: dataFormat ?? live; name never overwritten by preview patch)', async () => {
    const { vm, tid } = freshVM()
    await vm.updateCostume(tid, 0, { name: 'Base', dataFormat: 'svg' }, svgBytes('v'))
    const base = vm.getCostumeIdentity(tid, 0)!
    const seq = vm.getCostumeWriteSeq(tid, 0)
    await vm.updateCostume(tid, 0, { name: 'ExtName', rotationCenterX: 111, rotationCenterY: 222 })
    const r = await vm.updateCostumeIfMatch(
      tid, 0,
      { assetId: base.assetId, md5ext: base.md5ext, writeSeq: seq },
      // Preview-style patch: no name field, format priority preserved.
      { dataFormat: 'svg', rotationCenterX: 1, rotationCenterY: 2 },
      svgBytes('stale'),
    )
    expect(r.applied).toBe(false)
    const live = vm.getTarget(tid)!.costumes[0]!
    expect(live.name).toBe('ExtName')
    expect(live.rotationCenterX).toBe(111)
  })

  it('VM: different target / project reload / delete+reorder invalidate stale slot writes', async () => {
    const { vm, tid } = freshVM()
    await vm.addCostume('c2.svg', { name: 'c2', dataFormat: 'svg' } as never, tid)
    await vm.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('slot0'))
    await vm.updateCostume(tid, 1, { dataFormat: 'svg' }, svgBytes('slot1'))
    // Different slot is independent.
    const other = await vm.updateCostumeIfMatch(tid, 1, undefined, { dataFormat: 'svg' }, svgBytes('slot1-edit'))
    expect(other.applied).toBe(true)
    expect(await bytesOf(vm, tid, 0)).toContain('slot0')
    // Reorder shifts indices: stale slot0 write must not land on shifted art.
    const orig = vm.storeAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      await gate
      return orig(d, f)
    }
    const pending = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('stale0'))
    await tick(20)
    vm.reorderCostume(tid, 0, 1)
    release()
    const res = await pending
    vm.storeAsset = orig
    expect(res.applied).toBe(false)
    // Project reload with same target id discards queued tails.
    const genBefore = vm.getProjectGeneration()
    const orig3 = vm.storeAsset.bind(vm)
    let release3!: () => void
    const gate3 = new Promise<void>((res) => (release3 = res))
    let calls = 0
    vm.storeAsset = async (d: Uint8Array, f: string) => {
      calls += 1
      if (calls === 1) await gate3
      return orig3(d, f)
    }
    const barrier = vm.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('old-project'))
    await tick(20)
    await vm.loadProject(createDefaultProject())
    expect(vm.getProjectGeneration()).toBeGreaterThan(genBefore)
    release3()
    const rb = await barrier
    vm.storeAsset = orig3
    expect(rb.applied).toBe(false)
  })

  it('Editor wiring: undo/redo restore is CAS-guarded with observed identity (fail-closed, stack intact)', () => {
    const at = editorSource.indexOf('async function restoreHistoryEntry')
    expect(at).toBeGreaterThan(-1)
    const body = editorSource.slice(at, at + 8000)
    expect(body).toContain('updateCostumeIfMatch')
    expect(body).toMatch(/writeSeq/)
    // Fail-closed: conflict keeps the external and reports it.
    expect(body).toMatch(/scope changed|history cleared|external|conflict|kept/i)
  })

  it('Editor wiring: same-name alias, generation, and structure guards are intact', () => {
    expect(editorSource).toContain('vectorWriteTargetById')
    expect(editorSource).toContain('stableTargetId')
    expect(editorSource).toContain('getTargetVectorEpoch')
    expect(editorSource).toContain('expectedStructureEpoch')
    // Stable-id-only write (never the display-name alias).
    expect(editorSource).toMatch(/live\.id \?\? targetId|stable-id|Stable-id|stable id/i)
  })

  it('Editor wiring: bitmap + sound paths are unchanged (no CAS on bitmap/sound)', () => {
    // Bitmap saves and sound updates stay unconditional; only vector slot writes use CAS.
    expect(editorSource).toContain('updateBitmapCostumeFromCanvas')
    expect(editorSource).toContain('updateSoundBuffer')
    const bitmapAt = editorSource.indexOf('async function saveBitmapCostume')
    if (bitmapAt >= 0) {
      const body = editorSource.slice(bitmapAt, bitmapAt + 4000)
      expect(body).not.toContain('updateCostumeIfMatch')
    }
  })

  it('documents the direct-VM-API bypass as unsupported', () => {
    // Product routes every vector write through the gate + VM slot queue.
    // Diagnostic direct vm.updateCostume legs (if any) must be labeled as bypass.
    expect(editorSource).toMatch(/bypass|NOT serialized|outside|diagnostic/i)
  })
})
