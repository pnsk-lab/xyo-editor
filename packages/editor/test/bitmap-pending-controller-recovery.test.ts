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
  const selections: unknown[] = []
  const snapshots: unknown[] = []
  const recoveries: unknown[] = []
  return {
    cb: {
      onSelection: (selection: unknown) => {
        selections.push(selection)
      },
      onStatus: (text: string) => {
        statuses.push(text)
      },
      onSnapshot: (snapshot: unknown) => {
        snapshots.push(snapshot)
      },
      onRecoverySnapshot: (recovery: unknown) => {
        recoveries.push(recovery)
      },
      peekHistory: async <E,>(): Promise<E | undefined> => undefined,
      commitHistory: <E,>(): boolean => false,
      historyDepth: () => 0,
      historyIsCurrent: () => true,
      readConfig: () => ({}),
    },
    statuses,
    selections,
    snapshots,
    recoveries,
  }
}

function fakeCanvas(width = 120, height = 90): HTMLCanvasElement {
  const store = new Uint8ClampedArray(width * height * 4)
  const ctx = {
    getImageData: (x: number, y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(store.slice(0, w * h * 4)) }),
    putImageData: () => {},
  }
  return { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement
}

const slotA: BitmapPendingSlot = { targetId: 'sprite-1', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
const slotB: BitmapPendingSlot = { targetId: 'sprite-2', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }

describe('bitmap pending controller recovery (flag OFF, test factory only)', () => {
  it('keeps production flag OFF and offers no runtime bypass', () => {
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
    ]) {
      expect(controllerSource).not.toContain(token)
    }
  })

  it('production constructor stays disabled: ensure/get observe nothing', () => {
    const { cb } = fakeCb()
    const controller = new BitmapPendingController(fakeVm() as never, cb as never)
    expect(controller.ensure(slotA, fakeCanvas())).toBeUndefined()
    expect(controller.get()).toBeUndefined()
    expect(controller.hasPending()).toBe(false)
    expect(controller.hasUnsavedState()).toBe(false)
    expect(controller.hasRecovery()).toBe(false)
    expect(controller.getBeforeUnloadState().needsPreventDefault).toBe(false)
  })

  it('test factory creates a session and reuses it for the same slot', () => {
    const { cb } = fakeCb()
    const controller = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    const canvas = fakeCanvas()
    const first = controller.ensure(slotA, canvas)
    expect(first).toBeDefined()
    const second = controller.ensure(slotA, canvas)
    expect(second).toBe(first)
    expect(controller.hasRecovery()).toBe(false)
    expect(controller.hasUnsavedState()).toBe(false)
  })

  it('clean slot change drops without recovery and stays reentrant-safe', () => {
    const { cb } = fakeCb()
    const controller = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    const canvas = fakeCanvas()
    const first = controller.ensure(slotA, canvas)
    expect(first).toBeDefined()
    // Reentrant ensure from inside a status callback must not corrupt state.
    const reentrant = { count: 0 }
    const { cb: cb2 } = fakeCb()
    void cb2
    const controller2 = createBitmapPendingControllerForTest(fakeVm() as never, {
      onSelection: () => {
        if (reentrant.count === 0) {
          reentrant.count += 1
          controller2.ensure(slotA, canvas)
        }
      },
      onStatus: () => {},
      peekHistory: async () => undefined,
      commitHistory: () => false,
      historyDepth: () => 0,
      historyIsCurrent: () => true,
      readConfig: () => ({}),
    } as never)
    expect(controller2.ensure(slotA, canvas)).toBeDefined()
    const next = controller.ensure(slotB, canvas)
    expect(next).toBeDefined()
    expect(next).not.toBe(first)
    expect(controller.hasRecovery()).toBe(false)
  })

  it('ordinary destroy retains nothing when clean; explicit destructive clears', () => {
    const { cb } = fakeCb()
    const controller = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    const canvas = fakeCanvas()
    controller.ensure(slotA, canvas)
    controller.destroy('slot-change')
    expect(controller.hasRecovery()).toBe(false)
    expect(controller.get()).toBeUndefined()
    controller.ensure(slotA, canvas)
    controller.destroy('explicit-destructive-close')
    expect(controller.hasRecovery()).toBe(false)
    expect(controller.get()).toBeUndefined()
  })

  it('discard without confirmation is refused and keeps recovery state stable', async () => {
    const { cb } = fakeCb()
    const controller = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    expect(controller.discardRecovery()).toEqual({ ok: false, kind: 'refused' })
    expect(controller.hasRecovery()).toBe(false)
    const exported = await controller.exportRecoveryPng()
    expect(exported).toBeUndefined()
  })

  it('invalid slot/canvas never drops or touches recovery', () => {
    const { cb, statuses } = fakeCb()
    const controller = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    const canvas = fakeCanvas()
    controller.ensure(slotA, canvas)
    expect(controller.ensure({ targetId: '', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }, canvas)).toBeUndefined()
    expect(controller.ensure(slotA, undefined)).toBeUndefined()
    expect(controller.hasRecovery()).toBe(false)
    expect(statuses.length).toBeGreaterThan(0)
  })

  it('beforeunload interface reports no unsaved state when clean', () => {
    const { cb } = fakeCb()
    const controller = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    controller.ensure(slotA, fakeCanvas())
    const state = controller.getBeforeUnloadState()
    expect(state.hasUnsaved).toBe(false)
    expect(state.needsPreventDefault).toBe(false)
  })
})
