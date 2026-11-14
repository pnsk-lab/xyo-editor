import { describe, expect, it } from 'bun:test'
import { createBitmapPendingSession } from '../src/features/costumes/bitmap-pending-session'
import { shouldReloadBitmapCanvasAfterPendingConflict } from '../src/features/costumes/bitmap-pending-recovery-reload'
import { createTestWorld, directVmExternalSwitch, type TestWorld } from './bitmap-pending-test-harness'

const STYLE = { fill: '#ff0000', secondary: '#ffffff', gradient: 'solid', fillTransparent: false, secondaryTransparent: false, brushSize: 6 }

const BOX = { x: 20, y: 15, width: 80, height: 60 }

async function stageRed(world: TestWorld, statuses: string[]) {
  const session = createBitmapPendingSession(
    world.vm,
    'sprite-1',
    0,
    { loadSerial: 1, sessionGeneration: 1 },
    world.canvas.ports,
    world.history.ports,
    { onStatus: (text: string) => statuses.push(text) },
    {},
  )
  const baseBefore = new Uint8ClampedArray(world.canvas.image.data)
  await session.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', STYLE as never)
  session.pointerMove({ x: 100, y: 75 })
  const up = await session.pointerUp({ x: 100, y: 75 })
  expect(up.ok).toBe(true)
  expect(session.snapshot().hasPending).toBe(true)
  const touchedAfterStage = world.canvas.touched.length
  return { session, baseBefore, touchedAfterStage }
}

function liveIdentity(world: TestWorld) {
  return (world.vm.getCostumeIdentity as (t: string, i: number) => { assetId?: string; md5ext?: string; writeSeq?: number })('sprite-1', 0)
}

describe('bitmap pending same-slot recovery (deterministic barriers, no browser)', () => {
  it('pre-CAS hold + same-slot external GREEN wins: conflict, quarantine exact, canvas untouched, no phantom history', async () => {
    const world = createTestWorld()
    const statuses: string[] = []
    const { session, baseBefore, touchedAfterStage } = await stageRed(world, statuses)
    const blueMd5 = liveIdentity(world).md5ext
    // Deferred CAS barrier (deterministic, no timers): park the flight
    // between the take and the atomic mutation.
    let releaseCas: (() => void) | undefined
    const casGate = new Promise<void>((resolve) => {
      releaseCas = resolve
    })
    const origCas = world.vm.updateCostumeIfMatch!
    ;(world.vm as Record<string, unknown>).updateCostumeIfMatch = async (...args: unknown[]) => {
      await casGate
      return (origCas as (...a: unknown[]) => Promise<unknown>)(...args)
    }
    const commitP = session.commitPending()
    for (let i = 0; i < 20 && !session.snapshot().commitInFlight; i += 1) await Promise.resolve()
    expect(session.snapshot().commitInFlight).toBe(true)
    // Hostile GREEN lands in-flight, AFTER the CAS gate parked.
    directVmExternalSwitch(world, 'bytes')
    const green = liveIdentity(world)
    expect(green.md5ext).toBeDefined()
    expect(green.md5ext).not.toBe(blueMd5)
    releaseCas!()
    const result = await commitP
    expect(result.ok).toBe(false)
    expect((result as { reason?: string }).reason).toBe('external-conflict')
    // External wins byte-exact in the store.
    expect(liveIdentity(world).md5ext).toBe(green.md5ext)
    // Staged red+blue retained OFF-CANVAS, byte-exact: base equals the
    // pre-stroke base, shape equals the staged red box.
    const snap = session.snapshot()
    expect(Boolean(snap.quarantined ?? snap.quarantine)).toBe(true)
    const view = session.getQuarantined()
    expect(view).toBeDefined()
    expect(Array.from(view!.base.data as unknown as Uint8Array)).toEqual(Array.from(baseBefore))
    expect(view!.shape.box).toEqual(expect.objectContaining(BOX))
    expect(String(view!.reason)).toMatch(/conflict|external/)
    // Live canvas untouched (no restore onto the reloader-owned pixels, no
    // stale repaint): only the staging paint happened.
    expect(world.canvas.touched.length).toBe(touchedAfterStage)
    expect(Array.from(world.canvas.image.data)).toEqual(Array.from(baseBefore))
    // Quarantined export available (exact off-canvas composite path).
    const exported = await session.exportQuarantinedPng()
    expect(exported).toBeDefined()
    expect(exported!.byteLength).toBeGreaterThan(0)
    // No phantom history: zero staged writes leaked, histories scoped.
    expect(world.history.entries.length).toBe(0)
    // Conflict signal visible (quarantine keyword), never a bare success.
    expect(statuses.join('\n')).toMatch(/quarantin|conflict/)
  })

  it('applied-before-append hold: external lands after CAS applied, before history append -> conflict, no phantom history', async () => {
    const world = createTestWorld()
    const statuses: string[] = []
    const { session, baseBefore } = await stageRed(world, statuses)
    const before = world.vm.state.writeSeq
    // Hold RESULT delivery after the CAS applied in the store: the external
    // write lands in the applied-before-append window.
    let releaseResult: (() => void) | undefined
    let resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve
    })
    void resultGate
    const origCas = world.vm.updateCostumeIfMatch!
    let gateArmed = true
    ;(world.vm as Record<string, unknown>).updateCostumeIfMatch = async (...args: unknown[]) => {
      const out = await (origCas as (...a: unknown[]) => Promise<unknown>)(...args)
      if (gateArmed) await resultGate
      return out
    }
    const commitP = session.commitPending()
    for (let i = 0; i < 200 && world.vm.state.writeSeq === before; i += 1) await Promise.resolve()
    // CAS applied (own writeSeq bumped), result still held.
    expect(world.vm.state.writeSeq).toBe(before + 1)
    expect(session.snapshot().commitInFlight).toBe(true)
    // External GREEN lands after applied, before append.
    directVmExternalSwitch(world, 'bytes')
    const green = liveIdentity(world)
    gateArmed = true
    releaseResult!()
    const result = await commitP
    // Coordinator maps applied-but-superseded to external-conflict: the live
    // (external) write is preserved, no restore, no reapply.
    expect(result.ok).toBe(false)
    expect((result as { reason?: string }).reason).toBe('external-conflict')
    expect(liveIdentity(world).md5ext).toBe(green.md5ext)
    // Stale pre-write entry never lands on top of external art (removed when
    // the backend supports it, never committed otherwise): no phantom history.
    expect(world.history.entries.length).toBe(0)
    const view = session.getQuarantined()
    expect(view).toBeDefined()
    expect(Array.from(view!.base.data as unknown as Uint8Array)).toEqual(Array.from(baseBefore))
    expect(await session.exportQuarantinedPng()).toBeDefined()
    expect(statuses.join('\n')).toMatch(/quarantin|conflict|external/)
  })

  it('metadata-only SAME-slot rename (same bytes, bumped seq): conflict, staged quarantined, rebase preserves, no bytes move', async () => {
    const world = createTestWorld()
    const statuses: string[] = []
    const { session, baseBefore } = await stageRed(world, statuses)
    const blueMd5 = liveIdentity(world).md5ext
    const seqBefore = world.vm.state.writeSeq
    // External metadata-only write: same bytes, bumped version.
    world.vm.state.writeSeq += 1
    expect(liveIdentity(world).md5ext).toBe(blueMd5)
    const result = await session.commitPending()
    // Version drift on the same slot is caught by the pre-write scope gate
    // (`owner-mismatch`: take-time `editEpoch` no longer current); the CAS
    // itself is never reached. Either way the external meta wins, the staged
    // red quarantines, and no bytes move.
    expect(result.ok).toBe(false)
    expect((result as { reason?: string }).reason).toBe('owner-mismatch')
    // External meta wins with identical bytes (md5 stable).
    expect(liveIdentity(world).md5ext).toBe(blueMd5)
    expect(world.vm.state.writeSeq).toBe(seqBefore + 1)
    // Staged red quarantined off-canvas; zero staged writes; no history.
    expect(Boolean(session.snapshot().quarantined ?? session.snapshot().quarantine)).toBe(true)
    expect(world.history.entries.length).toBe(0)
    const view = session.getQuarantined()
    expect(Array.from(view!.base.data as unknown as Uint8Array)).toEqual(Array.from(baseBefore))
    // Explicit rebase after the metadata rename: same slot/generation,
    // same bytes -> adopted version, shape+base immutable, no VM write.
    const seqAfterRename = world.vm.state.writeSeq
    const rebased = session.rebaseQuarantinedAfterMetadataRename() as { ok?: boolean; kind?: string; scope?: { writeSeq?: number | null } }
    expect(rebased.ok).toBe(true)
    expect(rebased.scope?.writeSeq).toBe(seqAfterRename)
    expect(world.vm.state.writeSeq).toBe(seqAfterRename)
    expect(liveIdentity(world).md5ext).toBe(blueMd5)
    expect(await session.exportQuarantinedPng()).toBeDefined()
    expect(statuses.join('\n')).toMatch(/quarantin/)
  })

  it('same ID new generation: superseded, quarantine, live wins, no phantom history', async () => {
    const world = createTestWorld()
    const statuses: string[] = []
    const { session, baseBefore } = await stageRed(world, statuses)
    // Whole-project replacement reusing the SAME ids with NEW-GEN bytes.
    world.vm.state.projectGeneration += 1
    world.vm.state.selectionEpoch += 1
    directVmExternalSwitch(world, 'bytes')
    const green = liveIdentity(world)
    const result = await session.commitPending()
    expect(result.ok).toBe(false)
    expect((result as { reason?: string }).reason).toBe('superseded')
    expect(liveIdentity(world).md5ext).toBe(green.md5ext)
    expect(Boolean(session.snapshot().quarantined ?? session.snapshot().quarantine)).toBe(true)
    expect(world.history.entries.length).toBe(0)
    const view = session.getQuarantined()
    expect(Array.from(view!.base.data as unknown as Uint8Array)).toEqual(Array.from(baseBefore))
    expect(await session.exportQuarantinedPng()).toBeDefined()
  })

  it('clean commit control: exactly one history entry, no gap, no reapply on retry', async () => {
    const world = createTestWorld()
    const statuses: string[] = []
    const { session } = await stageRed(world, statuses)
    const before = world.vm.state.writeSeq
    const result = await session.commitPending()
    expect((result as { kind?: string }).kind).toBe('committed')
    expect(world.vm.state.writeSeq).toBe(before + 1)
    expect(world.history.entries.length).toBe(1)
    expect(session.snapshot().historyGap).toBe(false)
    const retry = await session.commitPending()
    expect((retry as { kind?: string }).kind).toBe('nothing-to-commit')
    expect(world.vm.state.writeSeq).toBe(before + 1)
    expect(world.history.entries.length).toBe(1)
  })

  it('reload decision matrix: scope to captured target/slot/version, never unconditional', () => {
    const scope = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-blue', writeSeq: 4, projectGeneration: 7 }
    const liveGreen = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-green', writeSeq: 5, projectGeneration: 7 }
    // Same-slot external wins -> reload.
    expect(shouldReloadBitmapCanvasAfterPendingConflict(scope, liveGreen, {}).reload).toBe(true)
    // Canvas already settled showing the live key -> no reload.
    expect(
      shouldReloadBitmapCanvasAfterPendingConflict(scope, liveGreen, {
        ownerTargetId: 'sprite-1',
        ownerIndex: 0,
        ownerAssetKey: 'md5-green',
        ownerSettled: true,
      }).reload,
    ).toBe(false)
    // A load for the live key already pending -> no reload.
    expect(
      shouldReloadBitmapCanvasAfterPendingConflict(scope, liveGreen, {
        pendingAssetKey: 'md5-green',
        pendingIsLiveSlot: true,
      }).reload,
    ).toBe(false)
    // Metadata-only (same bytes) -> no reload, rebase owns the version.
    expect(
      shouldReloadBitmapCanvasAfterPendingConflict(scope, { ...liveGreen, assetKey: 'md5-blue', writeSeq: 5 }, {}).reload,
    ).toBe(false)
    // Same ids, new project generation -> reload (never restore old base).
    expect(
      shouldReloadBitmapCanvasAfterPendingConflict(scope, { ...liveGreen, projectGeneration: 8 }, {}).reload,
    ).toBe(true)
    // Slot moved -> reload the LIVE owner's bytes (scoped), unless shown.
    expect(
      shouldReloadBitmapCanvasAfterPendingConflict(scope, { ...liveGreen, targetId: 'sprite-2' }, {}).reload,
    ).toBe(true)
    expect(
      shouldReloadBitmapCanvasAfterPendingConflict(scope, { ...liveGreen, targetId: 'sprite-2' }, {
        ownerTargetId: 'sprite-2',
        ownerIndex: 0,
        ownerAssetKey: 'md5-green',
        ownerSettled: true,
      }).reload,
    ).toBe(false)
    // Unknown/missing live -> never touch.
    expect(shouldReloadBitmapCanvasAfterPendingConflict(scope, undefined, {}).reload).toBe(false)
    expect(shouldReloadBitmapCanvasAfterPendingConflict(scope, { ...liveGreen, assetKey: '' }, {}).reload).toBe(false)
    expect(shouldReloadBitmapCanvasAfterPendingConflict(undefined, liveGreen, {}).reload).toBe(false)
  })

  it('no debug/test hooks in prod sources; pending flag stays false', async () => {
    const controllerSource = await Bun.file(
      new URL('../src/features/costumes/bitmap-pending-controller.ts', import.meta.url),
    ).text()
    const needle = 'export const BITMAP_PENDING_UI_ENABLED = false as const'
    expect(controllerSource.split(needle).length - 1).toBe(1)
    for (const token of [
      'localStorage.',
      'sessionStorage.',
      'URLSearchParams',
      'location.search',
      'location.hash',
      'import.meta.env',
      'process.env',
      '__directVm',
      '__directRace',
      'direct-cas-pre',
      'direct-store',
      'direct-history-append',
    ]) {
      expect(controllerSource.includes(token)).toBe(false)
    }
    const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    for (const token of ['__directVm', '__directRace']) {
      expect(editorSource.includes(token)).toBe(false)
    }
    const sessionSource = await Bun.file(
      new URL('../src/features/costumes/bitmap-pending-session.ts', import.meta.url),
    ).text()
    for (const token of ['__directVm', '__directRace', 'direct-cas-pre']) {
      expect(sessionSource.includes(token)).toBe(false)
    }
  })
})
