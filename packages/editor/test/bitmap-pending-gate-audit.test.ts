import { describe, expect, it } from 'bun:test'
import { classifyBitmapPendingCommand } from '../src/features/costumes/bitmap-pending-preflight'
import { BITMAP_PENDING_UI_ENABLED } from '../src/features/costumes/bitmap-pending-controller'
import {
  BITMAP_PENDING_TEST_ENABLED,
  COMMIT_FIRST_COMMANDS,
  DISCARD_FIRST_COMMANDS,
  LEAVE_PENDING_COMMANDS,
  PENDING_GATED_ROUTES,
  TestPendingController,
  createTestWorld,
  directVmExternalSwitch,
  expectedPolicyFor,
} from './bitmap-pending-test-harness'

const controllerSource = await Bun.file(
  new URL('../src/features/costumes/bitmap-pending-controller.ts', import.meta.url),
).text()

const STYLE = {
  fill: '#ff0000',
  secondary: '#ffffff',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 6,
}

async function stageRect(world: ReturnType<typeof createTestWorld>, controller: TestPendingController) {
  const session = controller.ensure()
  if (!session) throw new Error('test session unavailable')
  const down = await session.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', STYLE)
  expect(down.ok).toBe(true)
  const moved = session.pointerMove({ x: 100, y: 75 })
  expect(moved.ok).toBe(true)
  const up = await session.pointerUp({ x: 100, y: 75 })
  expect(up.ok).toBe(true)
  expect(session.snapshot().hasPending).toBe(true)
  return session
}

describe('bitmap pending test harness (no production bypass)', () => {
  it('keeps production flag OFF while the test flag is ON', () => {
    expect(BITMAP_PENDING_UI_ENABLED).toBe(false)
    expect(BITMAP_PENDING_TEST_ENABLED).toBe(true)
    expect(controllerSource).toContain('export const BITMAP_PENDING_UI_ENABLED = false')
  })

  it('production controller consults no storage/URL/env to re-enable', () => {
    for (const token of [
      'localStorage.',
      'sessionStorage.',
      'URLSearchParams',
      'location.search',
      'location.hash',
      'import.meta.env',
      'process.env',
    ]) {
      expect(controllerSource).not.toContain(token)
    }
  })

  it('classifies every audited product path fail-first', () => {
    for (const command of COMMIT_FIRST_COMMANDS) {
      if (command === 'restyle-noop-unknown-command-fallback') {
        // Unknown commands default to commit-first (fail-closed).
        expect(classifyBitmapPendingCommand(command)).toBe('commit-first')
        continue
      }
      expect(expectedPolicyFor(command)).toBe('commit-first')
    }
    for (const command of DISCARD_FIRST_COMMANDS) {
      expect(expectedPolicyFor(command)).toBe('discard-first')
    }
    for (const command of LEAVE_PENDING_COMMANDS) {
      expect(expectedPolicyFor(command)).toBe('leave-pending')
    }
    // Unknown future ops fail closed to commit-first.
    expect(classifyBitmapPendingCommand('future-op-xyz')).toBe('commit-first')
  })

  it('documents the full gated route list', () => {
    expect(PENDING_GATED_ROUTES.length).toBeGreaterThan(10)
    expect(PENDING_GATED_ROUTES).toContain('route:project-vm-events')
    expect(PENDING_GATED_ROUTES).toContain('route:convert-to-bitmap')
  })
})

describe('bitmap pending fail-first gates (deterministic, test-only)', () => {
  it('commit-first suppresses ghost ops when the commit is refused', async () => {
    const world = createTestWorld()
    const controller = new TestPendingController(world, () => ({
      targetId: world.vm.state.targetId,
      costumeIndex: world.vm.state.index,
      loadSerial: 1,
      sessionGeneration: 1,
    }))
    const session = await stageRect(world, controller)
    // Force refusal: occupy quarantine path via invalid scope by switching slot first.
    directVmExternalSwitch(world, 'target')
    let opRan = 0
    const result = await session.runCommand('select-target', () => {
      opRan += 1
      return 'ghost' as const
    })
    // Either a commit refusal or a stale-continuation refusal: the op must NOT run.
    expect(result.ok).toBe(false)
    expect(opRan).toBe(0)
    // Pending is not silently lost: retained or quarantined.
    const snap = session.snapshot()
    const quarantined = session.getQuarantined() ?? session.getQuarantine()
    expect(snap.hasPending || Boolean(quarantined)).toBe(true)
  })

  it('deterministic direct VM external switch cannot silently destroy pending', async () => {
    for (const kind of ['target', 'costume', 'project', 'bytes'] as const) {
      const world = createTestWorld()
      const controller = new TestPendingController(world, () => ({
        targetId: 'sprite-1',
        costumeIndex: 0,
        loadSerial: 1,
        sessionGeneration: 1,
      }))
      const session = await stageRect(world, controller)
      const touchedBefore = world.canvas.touched.length
      directVmExternalSwitch(world, kind)
      const result = await session.commitPending()
      // Must never report a clean `committed` over an external owner move.
      if (result.ok && result.kind === 'committed') {
        throw new Error(`external ${kind} switch was silently overwritten`)
      }
      const snap = session.snapshot()
      const quarantined = session.getQuarantined() ?? session.getQuarantine() ?? session.getConflicted()
      // Fail-first: pending retained for retry, or quarantined with the
      // external write preserved — never vanished.
      expect(snap.hasPending || Boolean(quarantined)).toBe(true)
      void touchedBefore
    }
  })

  it('move/resize/rotation on a stale floating raster fail without touching pixels', async () => {
    const world = createTestWorld()
    const controller = new TestPendingController(world, () => ({
      targetId: world.vm.state.targetId,
      costumeIndex: world.vm.state.index,
      loadSerial: 1,
      sessionGeneration: 1,
    }))
    const session = await stageRect(world, controller)
    directVmExternalSwitch(world, 'project')
    const touchedBefore = world.canvas.touched.length
    const moved = session.moveBy(10, 5)
    expect(moved.ok).toBe(false)
    const retargeted = session.retarget({ x: 0, y: 0, width: 10, height: 10 })
    expect(retargeted.ok).toBe(false)
    // Floating raster ops use the live canvas: stale owner => no touch.
    expect(world.canvas.touched.length).toBe(touchedBefore)
    const quarantined = session.getQuarantined() ?? session.getQuarantine()
    expect(session.snapshot().hasPending || Boolean(quarantined)).toBe(true)
  })

  it('runtime external VM events quarantine instead of dropping (TARGETS/PROJECT_CHANGED)', async () => {
    const world = createTestWorld()
    const controller = new TestPendingController(world, () => ({
      targetId: 'sprite-1',
      costumeIndex: 0,
      loadSerial: 1,
      sessionGeneration: 1,
    }))
    const session = await stageRect(world, controller)
    // PROJECT_CHANGED / TARGETS_UPDATE arrive as external bytes + epoch bump.
    directVmExternalSwitch(world, 'bytes')
    world.vm.state.selectionEpoch += 1
    const result = await session.runCommand(
      'project-switch',
      () => 'should-not-run',
      () => false,
    )
    expect(result.ok).toBe(false)
  })

  it('copy/cut/flip/erase go through commit-first, never bypass pending', () => {
    for (const command of ['paint-cut', 'paint-copy', 'paint-flip', 'paint-clear', 'paint-paste', 'paint-floating'] as const) {
      expect(classifyBitmapPendingCommand(command)).toBe('commit-first')
    }
  })

  it('bitmap conversion + load/new/export are commit-first', () => {
    for (const command of [
      'convert-to-bitmap',
      'convert-to-vector',
      'load-project',
      'new-project',
      'export-project',
      'export-sb3',
      'export-costume',
      'select-costume',
      'select-target',
    ] as const) {
      expect(classifyBitmapPendingCommand(command)).toBe('commit-first')
    }
  })

  it('history-gap blocks every later op until acknowledged', async () => {
    const world = createTestWorld()
    world.history.failNextCommit = true
    const controller = new TestPendingController(world, () => ({
      targetId: world.vm.state.targetId,
      costumeIndex: world.vm.state.index,
      loadSerial: 1,
      sessionGeneration: 1,
    }))
    const session = controller.ensure()
    if (!session) throw new Error('no session')
    await session.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', STYLE)
    session.pointerMove({ x: 100, y: 75 })
    await session.pointerUp({ x: 100, y: 75 })
    const first = await session.commitPending()
    expect(first.ok).toBe(true)
    expect(first.kind).toBe('committed-without-history')
    expect(session.snapshot().historyGap).toBe(true)
    // Retry with no pending stays nothing-to-commit (never duplicates).
    const retry = await session.commitPending()
    expect(retry.ok).toBe(true)
    expect(retry.kind).toBe('nothing-to-commit')
    // New paint + every continuation refused until ack.
    const repaint = await session.pointerDown({ x: 5, y: 5 }, 'rect', 'filled', STYLE)
    expect(repaint.ok).toBe(false)
    const gated = await session.runCommand('export-sb3', () => 'ghost')
    expect(gated.ok).toBe(false)
    const acked = session.acknowledgeHistoryGap('test-ack')
    expect(acked.acknowledged).toBe(true)
    expect(session.snapshot().historyGap).toBe(false)
  })

  it('slot change destroys the test session without touching pixels', async () => {
    const world = createTestWorld()
    let serial = 1
    const controller = new TestPendingController(world, () => ({
      targetId: world.vm.state.targetId,
      costumeIndex: world.vm.state.index,
      loadSerial: serial,
      sessionGeneration: 1,
    }))
    await stageRect(world, controller)
    const touchedBefore = world.canvas.touched.length
    serial = 2 // reload / switch: new slot key
    const next = controller.ensure()
    expect(next).toBeDefined()
    expect(next?.snapshot().hasPending).toBe(false)
    expect(world.canvas.touched.length).toBe(touchedBefore)
  })
})

describe('bitmap pending beforeunload audit (actionable)', () => {
  it('requires the enabled-only safe beforeunload guard with exact cleanup', async () => {
    const editorSource = await Bun.file(
      new URL('../src/Editor.svelte', import.meta.url),
    ).text()
    // Enabled-only safe listener: installed on mount, removed on destroy.
    expect(editorSource).toContain(`window.addEventListener('beforeunload', handleBitmapPendingBeforeUnload)`)
    expect(editorSource).toContain(`window.removeEventListener('beforeunload', handleBitmapPendingBeforeUnload)`)
    expect(editorSource).toContain('function handleBitmapPendingBeforeUnload')
    // Gate: production flag plus hasUnsavedState (staging/quarantine/gap).
    expect(editorSource).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(editorSource).toContain('bitmapPendingController?.hasUnsavedState()')
    // Warning only: preventDefault + returnValue, no auto-save in handler.
    expect(editorSource).toContain('event.preventDefault()')
    expect(editorSource).toContain(`event.returnValue = ''`)
    const handlerStart = editorSource.indexOf('function handleBitmapPendingBeforeUnload')
    const handlerBlock = editorSource.slice(handlerStart, handlerStart + 800)
    expect(handlerBlock).not.toContain('commitPending')
    expect(handlerBlock).not.toContain('storeAsset')
    expect(handlerBlock).not.toContain('updateCostumeIfMatch')
    // Disabled path is a silent no-op (still asserted in the hostile suite).
    expect(BITMAP_PENDING_UI_ENABLED).toBe(false)
  })
})
