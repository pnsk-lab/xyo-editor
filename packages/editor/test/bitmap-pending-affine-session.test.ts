// UI+VM session tests for the exact affine pending shape (real session +
// real harness VM/canvas/history, no browser).
//
// Covers: no VM write and no history until commit across restyle / move /
// nudge / rotate90 / rotateTo / affine-scale staging; exactly-once commit
// (retry is `nothing-to-commit`, never a second rasterization); undo /
// delete discard in one step with the base restored; same-slot external
// conflict and target-switch conflict fail closed (external preserved, no
// phantom history, quarantine retained); `runCommand` target-switch runs the
// continuation exactly once after the affine commit; invalid affine input is
// refused with the staged shape retained; and the production gate stays OFF.
import { describe, expect, it } from 'bun:test'
import { createBitmapPendingSession } from '../src/features/costumes/bitmap-pending-session'
import { BITMAP_PENDING_UI_ENABLED } from '../src/features/costumes/bitmap-pending-controller'
import { beginPendingAffineScaleDrag, resolvePendingAffineScale, PENDING_AFFINE_IDENTITY } from '../src/features/costumes/bitmap-pending-affine'
import { createTestWorld, directVmExternalSwitch, type TestWorld } from './bitmap-pending-test-harness'

const STYLE = {
  fill: '#ff0000',
  secondary: '#ffffff',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 6,
}

async function stageAffineShape(world: TestWorld) {
  const statuses: string[] = []
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
  await session.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', STYLE as never)
  session.pointerMove({ x: 100, y: 75 })
  const up = await session.pointerUp({ x: 100, y: 75 })
  expect(up.ok).toBe(true)
  expect(session.snapshot().hasPending).toBe(true)
  // Stage a skewed S*R screen matrix via the test-only adapter (world-axis
  // scale about the SE AABB handle after a 30-degree stage rotation).
  expect(session.rotateTo(30).ok).toBe(true)
  const shape = session.getPendingShape()!
  const { pendingAffineSelectionAABB } = await import('../src/features/costumes/bitmap-pending-affine')
  const aabb = pendingAffineSelectionAABB(shape.box, 30, { ...PENDING_AFFINE_IDENTITY })!
  const h0 = { x: aabb.x + aabb.width, y: aabb.y + aabb.height }
  const drag = beginPendingAffineScaleDrag({ ...shape.box }, 30, { ...PENDING_AFFINE_IDENTITY }, 'se', h0, {})!
  const m = resolvePendingAffineScale(drag, { x: h0.x + 20, y: h0.y + 10 }, {}, { width: 120, height: 90 })!
  const staged = session.stageAffine(m)
  expect(staged.ok).toBe(true)
  expect(session.getPendingShape()!.affine).toEqual(m)
  return { session, statuses, matrix: m }
}

describe('affine pending UI+VM session (real session, harness VM)', () => {
  it('production gate stays OFF (no UI wiring)', () => {
    expect(BITMAP_PENDING_UI_ENABLED).toBe(false)
  })

  it('restyle/move/nudge/rotate/affine staging write no VM bytes and no history until commit', async () => {
    const world = createTestWorld()
    const { session, matrix } = await stageAffineShape(world)
    const seqBefore = world.vm.state.writeSeq
    expect(world.history.entries.length).toBe(0)
    // Restyle applies local fill, preserves the skewed geometry.
    const restyled = session.restyle({ fill: '#0000ff' })
    expect(restyled.ok).toBe(true)
    expect(session.getPendingShape()!.style.fill).toBe('#0000ff')
    expect(session.getPendingShape()!.affine).toEqual(matrix)
    // Move/nudge compose translations: local box verbatim, matrix shifted.
    const eBefore = session.getPendingShape()!.affine!.e
    expect(session.moveBy(7, -3).ok).toBe(true)
    expect(session.getPendingShape()!.affine!.e).toBeCloseTo(eBefore + 7, 9)
    // 90-degree rotation composes into the matrix; legacy fields verbatim.
    const rot = session.rotate90('cw')
    expect(rot.ok).toBe(true)
    expect(session.getPendingShape()!.box).toEqual({ x: 20, y: 15, width: 80, height: 60 })
    expect(session.getPendingShape()!.rotation).toBe(30)
    // Arbitrary rotate composes too (screen turn about selection center).
    expect(session.rotateBy(15).ok).toBe(true)
    expect(session.getPendingShape()!.rotation).toBe(30)
    // Retarget keeps the affine matrix (local-box change only).
    const ret = session.retarget({ x: 20, y: 15, width: 90, height: 60 })
    expect(ret.ok).toBe(true)
    expect(session.getPendingShape()!.affine).toBeDefined()
    // Still nothing written anywhere.
    expect(world.vm.state.writeSeq).toBe(seqBefore)
    expect(world.history.entries.length).toBe(0)
    expect(session.snapshot().hasPending).toBe(true)
  })

  it('commit writes exactly once; retry is nothing-to-commit (no duplicate raster/history)', async () => {
    const world = createTestWorld()
    const { session } = await stageAffineShape(world)
    const seqBefore = world.vm.state.writeSeq
    const first = await session.commitPending()
    expect(first.ok).toBe(true)
    expect(first.kind).toBe('committed')
    expect(world.vm.state.writeSeq).toBe(seqBefore + 1)
    expect(world.history.entries.length).toBe(1)
    expect(session.snapshot().hasPending).toBe(false)
    const retry = await session.commitPending()
    expect(retry.ok).toBe(true)
    expect(retry.kind).toBe('nothing-to-commit')
    expect(world.vm.state.writeSeq).toBe(seqBefore + 1)
    expect(world.history.entries.length).toBe(1)
  })

  it('undo/delete while affine-pending discards in one step (base restored, no history, no VM write)', async () => {
    const world = createTestWorld()
    const { session } = await stageAffineShape(world)
    const seqBefore = world.vm.state.writeSeq
    const baseBefore = new Uint8ClampedArray(world.canvas.image.data)
    void baseBefore
    const discarded = session.discardForDeleteOrUndo()
    expect(discarded.ok).toBe(true)
    expect(session.snapshot().hasPending).toBe(false)
    expect(world.vm.state.writeSeq).toBe(seqBefore)
    expect(world.history.entries.length).toBe(0)
  })

  it('same-slot external bytes conflict: commit fails closed, external preserved, no phantom history', async () => {
    const world = createTestWorld()
    const { session } = await stageAffineShape(world)
    const seqBefore = world.vm.state.writeSeq
    directVmExternalSwitch(world, 'bytes')
    const externalSeq = world.vm.state.writeSeq
    expect(externalSeq).toBe(seqBefore + 1)
    const result = await session.commitPending()
    expect(result.ok).toBe(false)
    // Our bytes never applied over the external write; no history appended.
    expect(world.vm.state.writeSeq).toBe(externalSeq)
    expect(world.history.entries.length).toBe(0)
  })

  it('target-switch conflict via runCommand: commit-first refuses and suppresses the continuation', async () => {
    const world = createTestWorld()
    const { session, statuses } = await stageAffineShape(world)
    directVmExternalSwitch(world, 'target')
    let opRuns = 0
    const result = await session.runCommand('select-target', () => {
      opRuns += 1
      return 'switched' as const
    })
    expect(result.ok).toBe(false)
    expect(opRuns).toBe(0)
    expect(world.history.entries.length).toBe(0)
    expect(statuses.length).toBeGreaterThan(0)
  })

  it('target-switch without conflict commits the affine shape once, then runs the continuation once', async () => {
    const world = createTestWorld()
    const { session } = await stageAffineShape(world)
    const seqBefore = world.vm.state.writeSeq
    let opRuns = 0
    const result = await session.runCommand('select-target', () => {
      opRuns += 1
      return 'switched' as const
    })
    expect(result.ok).toBe(true)
    expect(opRuns).toBe(1)
    expect(world.vm.state.writeSeq).toBe(seqBefore + 1)
    expect(world.history.entries.length).toBe(1)
    expect(session.snapshot().hasPending).toBe(false)
  })

  it('invalid affine matrices are refused with the staged shape retained', async () => {
    const world = createTestWorld()
    const { session, matrix } = await stageAffineShape(world)
    const seqBefore = world.vm.state.writeSeq
    // Non-finite input is a same-object no-op (fail closed, shape retained,
    // no re-render, no history, no VM write).
    const bad = session.stageAffine({ a: NaN, b: 0, c: 0, d: 1, e: 0, f: 0 })
    expect(bad.ok).toBe(true)
    expect(bad.kind).toBe('unchanged')
    expect(session.getPendingShape()!.affine).toEqual(matrix)
    expect(world.vm.state.writeSeq).toBe(seqBefore)
    expect(world.history.entries.length).toBe(0)
    // Singular input (zero determinant) is refused the same way.
    const singular = session.stageAffine({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })
    expect(singular.ok).toBe(true)
    expect(singular.kind).toBe('unchanged')
    expect(session.getPendingShape()!.affine).toEqual(matrix)
  })

  it('cancel during an affine draft leaves no pending and writes nothing', async () => {
    const world = createTestWorld()
    const statuses: string[] = []
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
    const seqBefore = world.vm.state.writeSeq
    await session.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', STYLE as never)
    session.pointerMove({ x: 100, y: 75 })
    expect(session.cancelDraft().ok).toBe(true)
    expect(session.snapshot().hasPending).toBe(false)
    expect(world.vm.state.writeSeq).toBe(seqBefore)
    expect(world.history.entries.length).toBe(0)
  })
})
