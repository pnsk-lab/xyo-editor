import { describe, expect, it } from 'bun:test'
import {
  BITMAP_PENDING_UI_ENABLED,
  createBitmapPendingControllerForTest,
  BitmapPendingController,
  type BitmapPendingSlot,
} from '../src/features/costumes/bitmap-pending-controller'

const controllerSource = await Bun.file(
  new URL('../src/features/costumes/bitmap-pending-controller.ts', import.meta.url),
).text()
const editorSource = await Bun.file(
  new URL('../src/Editor.svelte', import.meta.url),
).text()

function fakeVm() {
  return {
    getCostumeIdentity: () => ({ assetId: 'a', md5ext: 'm', writeSeq: 1 }),
    getProjectGeneration: () => 7,
    getSelectionEpoch: () => 3,
    getCostumeStructureSeq: () => 0,
    updateCostumeIfMatch: async () => ({ ok: false, applied: false, reason: 'conflict' }),
  }
}

function fakeCb() {
  const statuses: string[] = []
  return {
    cb: {
      onSelection: () => {},
      onStatus: (text: string) => { statuses.push(String(text)) },
      onSnapshot: () => {},
      onRecoverySnapshot: () => {},
      peekHistory: async <E,>(): Promise<E | undefined> => undefined,
      commitHistory: <E,>(): boolean => false,
      historyDepth: () => 0,
      historyIsCurrent: () => true,
      readConfig: () => ({}),
    },
    statuses,
  }
}

function fakeCanvas(width = 120, height = 90): HTMLCanvasElement {
  const store = new Uint8ClampedArray(width * height * 4)
  const ctx = {
    getImageData: () => ({ width, height, data: new Uint8ClampedArray(store.slice(0, 8)) }),
    putImageData: () => {},
  }
  return { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement
}

/** Minimal mock pending session the controller can retain/export/discard. */
function mockSession(opts: {
  hasPending?: boolean
  commitInFlight?: boolean
  historyGap?: boolean
  quarantined?: boolean
  exportBytes?: Uint8Array | undefined
  commitResult?: unknown
} = {}) {
  const hasPending = opts.hasPending ?? true
  const commitInFlight = opts.commitInFlight ?? false
  const historyGap = opts.historyGap ?? false
  const quarantined = opts.quarantined ?? false
  const exportBytes = 'exportBytes' in opts ? opts.exportBytes : new Uint8Array([1, 2, 3])
  return {
    __mock: true,
    snapshot: () => ({
      hasPending,
      commitInFlight,
      renderRev: 1,
      historyDepth: 0,
      quarantined: quarantined ? { shape: {}, base: {}, scope: {}, reason: 'mock' } : undefined,
      quarantine: quarantined ? { shape: {}, base: {}, scope: {}, reason: 'mock' } : undefined,
      pendingKind: undefined,
      pendingMode: undefined,
      historyGap,
    }),
    configure: () => {},
    getPendingShape: () => undefined,
    quarantineStagedOffCanvas: () => ({ ok: true, kind: 'quarantined' }),
    discardQuarantined: () => ({ ok: true, kind: 'discarded' }),
    exportQuarantinedPng: async () => (quarantined || hasPending ? exportBytes : undefined),
    exportPreservedPng: async () => undefined,
    exportConflictedPng: async () => undefined,
    commitPending: async () => opts.commitResult ?? { ok: true, kind: 'nothing-to-commit' },
  }
}

function keyOf(slot: BitmapPendingSlot): string {
  return `${slot.targetId}:${slot.costumeIndex}:${slot.loadSerial}:${slot.sessionGeneration}`
}

const slotA: BitmapPendingSlot = { targetId: 'sprite-1', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
const slotB: BitmapPendingSlot = { targetId: 'sprite-2', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
const slotC: BitmapPendingSlot = { targetId: 'sprite-3', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }

function injectActive(controller: BitmapPendingController, slot: BitmapPendingSlot, session: unknown) {
  const anyCtrl = controller as unknown as Record<string, unknown>
  anyCtrl['session'] = session
  anyCtrl['slot'] = { ...slot }
  anyCtrl['slotKey'] = keyOf(slot)
  anyCtrl['currentSlot'] = { ...slot }
}

describe('bitmap pending controller hostile audit (flag OFF, strict)', () => {
  it('production flag stays false with no runtime bypass surface', () => {
    expect(BITMAP_PENDING_UI_ENABLED).toBe(false)
    expect(controllerSource).toContain('export const BITMAP_PENDING_UI_ENABLED = false')
    for (const token of [
      'localStorage.',
      'sessionStorage.',
      'URLSearchParams',
      'location.search',
      'location.hash',
      'import.meta.env',
      'process.env',
      'document.cookie',
    ]) {
      expect(controllerSource).not.toContain(token)
    }
  })

  it('production constructor never bypasses the flag; destroy on close drops nothing observable', () => {
    const { cb } = fakeCb()
    const prod = new BitmapPendingController(fakeVm() as never, cb as never)
    expect(prod.ensure(slotA, fakeCanvas())).toBeUndefined()
    expect(prod.get()).toBeUndefined()
    expect(prod.hasPending()).toBe(false)
    expect(prod.hasUnsavedState()).toBe(false)
    expect(prod.hasRecovery()).toBe(false)
    expect(prod.getBeforeUnloadState()).toEqual({ hasUnsaved: false, needsPreventDefault: false, reason: undefined })
    prod.destroy('teardown')
    prod.destroy('explicit-destructive-close')
    expect(prod.hasRecovery()).toBe(false)
    expect(prod.getBeforeUnloadState().needsPreventDefault).toBe(false)
  })

  it('production never imports the test factory nor passes testForceEnabled', () => {
    expect(editorSource).not.toContain('createBitmapPendingControllerForTest')
    expect(editorSource).not.toContain('testForceEnabled')
    // Editor owns the constructor without options (single prod path).
    expect(editorSource).toContain('new BitmapPendingController(')
  })

  it('page-close wiring: enabled-only safe beforeunload guard with exact cleanup', () => {
    // The Editor owns the beforeunload guard (another agent's surface): the
    // controller exposes hasUnsavedState/getBeforeUnloadState but the Editor
    // wires them to a window beforeunload listener with exact cleanup.
    // Enabled-only, safe, no auto-save, no bypass.
    expect(editorSource).toContain(`bitmapPendingController?.destroy('teardown')`)
    // Listener install + exact cleanup (symmetric add/remove of the same handler).
    expect(editorSource).toContain(`window.addEventListener('beforeunload', handleBitmapPendingBeforeUnload)`)
    expect(editorSource).toContain(`window.removeEventListener('beforeunload', handleBitmapPendingBeforeUnload)`)
    expect(editorSource).toContain('function handleBitmapPendingBeforeUnload')
    // Enabled-only gate: flag check plus hasUnsavedState (covers active
    // staging / quarantine / history-gap / retained recovery).
    expect(editorSource).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(editorSource).toContain('bitmapPendingController?.hasUnsavedState()')
    // Safe warning only: preventDefault + returnValue, no commit/save.
    expect(editorSource).toContain('event.preventDefault()')
    expect(editorSource).toContain(`event.returnValue = ''`)
    // No auto-save inside the unload path: the handler never commits,
    // stores, or CAS-writes.
    const handlerStart = editorSource.indexOf('function handleBitmapPendingBeforeUnload')
    const handlerBlock = editorSource.slice(handlerStart, handlerStart + 800)
    expect(handlerBlock).not.toContain('commitPending')
    expect(handlerBlock).not.toContain('commitRecovery')
    expect(handlerBlock).not.toContain('storeAsset')
    expect(handlerBlock).not.toContain('updateCostumeIfMatch')
    // No browser bypass surface in the controller: flag stays a plain const.
    expect(editorSource).not.toContain('createBitmapPendingControllerForTest')
  })

  it('multi-target staging while recovery pending is refused with zero loss', () => {
    const { cb } = fakeCb()
    const ctrl = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    const canvas = fakeCanvas()
    injectActive(ctrl, slotA, mockSession({ hasPending: true }))
    // External switch B: old pending retained off-canvas, new stage refused.
    expect(ctrl.ensure(slotB, canvas)).toBeUndefined()
    expect(ctrl.hasRecovery()).toBe(true)
    expect(ctrl.recoverySlotKeys()).toEqual([keyOf(slotA)])
    expect(ctrl.get()).toBeUndefined()
    expect(ctrl.hasUnsavedState()).toBe(true)
    expect(ctrl.getBeforeUnloadState().needsPreventDefault).toBe(true)
    // Third target C while recovery pending: still refused, original kept.
    expect(ctrl.ensure(slotC, canvas)).toBeUndefined()
    expect(ctrl.hasRecovery()).toBe(true)
    expect(ctrl.recoverySlotKeys()).toEqual([keyOf(slotA)])
    expect(ctrl.getBeforeUnloadState().needsPreventDefault).toBe(true)
  })

  it('two-retained overflow never overwrites: third retain keeps all three without loss', () => {
    const { cb } = fakeCb()
    const ctrl = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    const canvas = fakeCanvas()
    const anyCtrl = ctrl as unknown as Record<string, unknown>
    const first = mockSession({ hasPending: true, exportBytes: new Uint8Array([10]) })
    const second = mockSession({ hasPending: true, exportBytes: new Uint8Array([20]) })
    const third = mockSession({ hasPending: true, exportBytes: new Uint8Array([30]) })
    anyCtrl['recovered'] = { session: first, slot: { ...slotA }, slotKey: keyOf(slotA) }
    anyCtrl['overflowStale'] = { session: second, slot: { ...slotB }, slotKey: keyOf(slotB) }
    injectActive(ctrl, slotC, third)
    expect(ctrl.ensure({ targetId: 'sprite-4', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }, canvas)).toBeUndefined()
    const state = ctrl.getRecoveryState()
    expect(state.hasRecovery).toBe(true)
    // Both originals preserved byte-identical; newest active NOT silently dropped.
    expect(ctrl.recoverySlotKeys()).toEqual([keyOf(slotA), keyOf(slotB)])
    expect((ctrl as unknown as { get(): unknown }).get()).toBe(third)
    expect(ctrl.hasUnsavedState()).toBe(true)
  })

  it('destroy/unmount with captured pending retains; explicit destructive clears', () => {
    const { cb } = fakeCb()
    const ctrl = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    injectActive(ctrl, slotA, mockSession({ hasPending: true }))
    ctrl.destroy('teardown')
    expect(ctrl.hasRecovery()).toBe(true)
    expect(ctrl.recoverySlotKeys()).toEqual([keyOf(slotA)])
    // Ordinary unmount-like destroys keep retaining, never drop.
    ctrl.destroy('target-change')
    ctrl.destroy()
    expect(ctrl.hasRecovery()).toBe(true)
    // Explicit user-confirmed destructive close is the only clearing path.
    ctrl.destroy('explicit-destructive-close')
    expect(ctrl.hasRecovery()).toBe(false)
    expect(ctrl.hasUnsavedState()).toBe(false)
    expect(ctrl.getBeforeUnloadState().needsPreventDefault).toBe(false)
  })

  it('discardRecovery requires explicit confirmation; confirmed discard clears FIFO', async () => {
    const { cb } = fakeCb()
    const ctrl = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    injectActive(ctrl, slotA, mockSession({ hasPending: true }))
    expect(ctrl.ensure(slotB, fakeCanvas())).toBeUndefined()
    expect(ctrl.discardRecovery()).toEqual({ ok: false, kind: 'refused' })
    expect(ctrl.hasRecovery()).toBe(true)
    expect(await ctrl.exportRecoveryPng()).toBeDefined()
    expect(ctrl.discardRecovery({ confirmed: true })).toEqual({ ok: true, kind: 'discarded' })
    expect(ctrl.hasRecovery()).toBe(false)
    expect(await ctrl.exportRecoveryPng()).toBeUndefined()
    expect(ctrl.discardRecovery({ confirmed: true })).toEqual({ ok: true, kind: 'nothing-pending' })
  })

  it('failed export/encode retains recovery and keeps beforeunload armed', async () => {
    const { cb } = fakeCb()
    const ctrl = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    injectActive(ctrl, slotA, mockSession({ hasPending: true, quarantined: true, exportBytes: undefined }))
    expect(ctrl.ensure(slotB, fakeCanvas())).toBeUndefined()
    expect(await ctrl.exportRecoveryPng()).toBeUndefined()
    expect(await ctrl.exportRecoveredPng()).toBeUndefined()
    expect(ctrl.hasRecovery()).toBe(true)
    expect(ctrl.hasUnsavedState()).toBe(true)
    expect(ctrl.getBeforeUnloadState()).toEqual({
      hasUnsaved: true,
      needsPreventDefault: true,
      reason: 'bitmap-pending-recovery: staged edit retained off-canvas; close would discard it without explicit export/discard',
    })
  })

  it('beforeunload guard false stays silent; armed recovery demands preventDefault', async () => {
    const { cb } = fakeCb()
    const prod = new BitmapPendingController(fakeVm() as never, cb as never)
    expect(prod.getBeforeUnloadState().needsPreventDefault).toBe(false)
    const { cb: cb2 } = fakeCb()
    const ctrl = createBitmapPendingControllerForTest(fakeVm() as never, cb2 as never)
    expect(ctrl.getBeforeUnloadState().needsPreventDefault).toBe(false)
    injectActive(ctrl, slotA, mockSession({ hasPending: true }))
    expect(ctrl.ensure(slotB, fakeCanvas())).toBeUndefined()
    expect(ctrl.getBeforeUnloadState().needsPreventDefault).toBe(true)
    const exported = await ctrl.exportRecoveryPng()
    expect(exported?.byteLength).toBeGreaterThan(0)
    // Successful export does NOT auto-clear: explicit discard still required.
    expect(ctrl.hasRecovery()).toBe(true)
    expect(ctrl.getBeforeUnloadState().needsPreventDefault).toBe(true)
  })
})
