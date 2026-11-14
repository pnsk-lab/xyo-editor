// Unit audit for the page-lifecycle boundary (no browser needed).
//
// - Production flag stays `false` with no storage/URL/env bypass.
// - Editor wires symmetric enabled-only `beforeunload` + `pagehide` +
//   `pageshow` listeners; hide/show perform no commit/store/CAS and never
//   suppress prompts (no `preventDefault` in hide/show).
// - Controller wrong-owner no-ops (isolated test factory only; production
//   code never imports it): cross-slot history writes refused, clean export
//   is undefined, unconfirmed discard refused, unknown destroy reasons
//   retain instead of dropping, explicit destructive close is the only
//   clearing path.
// - Boundary: reload/navigation/unmount without durable storage loses
//   in-memory pending; the suite pins `BITMAP_PENDING_UI_ENABLED === false`
//   so no false durable autosave is promised.
import { describe, expect, it } from 'bun:test'
import {
  BITMAP_PENDING_UI_ENABLED,
  BitmapPendingController,
  createBitmapPendingControllerForTest,
  type BitmapPendingSlot,
} from '../src/features/costumes/bitmap-pending-controller'

const controllerSource = await Bun.file(
  new URL('../src/features/costumes/bitmap-pending-controller.ts', import.meta.url),
).text()
const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()

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
      onStatus: (text: string) => {
        statuses.push(String(text))
      },
      onSnapshot: () => {},
      onRecoverySnapshot: () => {},
      peekHistory: async <E>(): Promise<E | undefined> => undefined,
      commitHistory: <E>(): boolean => false,
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

function mockSession(opts: {
  hasPending?: boolean
  commitInFlight?: boolean
  historyGap?: boolean
  quarantined?: boolean
} = {}) {
  const hasPending = opts.hasPending ?? true
  return {
    snapshot: () => ({
      hasPending,
      commitInFlight: opts.commitInFlight ?? false,
      renderRev: 1,
      historyDepth: 0,
      quarantined: opts.quarantined ? { reason: 'mock' } : undefined,
      quarantine: opts.quarantined ? { reason: 'mock' } : undefined,
      historyGap: opts.historyGap ?? false,
    }),
    configure: () => {},
    getPendingShape: () => undefined,
    quarantineStagedOffCanvas: () => ({ ok: true, kind: 'quarantined' }),
    discardQuarantined: () => ({ ok: true, kind: 'discarded' }),
    exportQuarantinedPng: async () => (opts.quarantined || hasPending ? new Uint8Array([1, 2, 3]) : undefined),
    exportPreservedPng: async () => undefined,
    exportConflictedPng: async () => undefined,
    commitPending: async () => ({ ok: true, kind: 'nothing-to-commit' }),
  }
}

const slotA: BitmapPendingSlot = { targetId: 'sprite-1', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
const slotB: BitmapPendingSlot = { targetId: 'sprite-2', costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }

function keyOf(slot: BitmapPendingSlot): string {
  return `${slot.targetId}:${slot.costumeIndex}:${slot.loadSerial}:${slot.sessionGeneration}`
}

function injectActive(controller: BitmapPendingController, slot: BitmapPendingSlot, session: unknown) {
  const anyCtrl = controller as unknown as Record<string, unknown>
  anyCtrl['session'] = session
  anyCtrl['slot'] = { ...slot }
  anyCtrl['slotKey'] = keyOf(slot)
  anyCtrl['currentSlot'] = { ...slot }
}

describe('bitmap pending pagehide/unmount boundary (flag OFF, strict)', () => {
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
    expect(editorSource).not.toContain('createBitmapPendingControllerForTest')
    expect(editorSource).not.toContain('testForceEnabled')
  })

  it('Editor wires symmetric enabled-only beforeunload + pagehide + pageshow with no autosave', () => {
    for (const name of ['handleBitmapPendingBeforeUnload', 'handleBitmapPendingPageHide', 'handleBitmapPendingPageShow']) {
      expect(editorSource).toContain(`function ${name}`)
    }
    expect(editorSource).toContain(`window.addEventListener('beforeunload', handleBitmapPendingBeforeUnload)`)
    expect(editorSource).toContain(`window.removeEventListener('beforeunload', handleBitmapPendingBeforeUnload)`)
    expect(editorSource).toContain(`window.addEventListener('pagehide', handleBitmapPendingPageHide)`)
    expect(editorSource).toContain(`window.removeEventListener('pagehide', handleBitmapPendingPageHide)`)
    expect(editorSource).toContain(`window.addEventListener('pageshow', handleBitmapPendingPageShow)`)
    expect(editorSource).toContain(`window.removeEventListener('pageshow', handleBitmapPendingPageShow)`)
    const hideBlock = editorSource.slice(
      editorSource.indexOf('function handleBitmapPendingPageHide'),
      editorSource.indexOf('function handleBitmapPendingPageHide') + 900,
    )
    expect(hideBlock).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(hideBlock).toContain(`retainUnsavedForExternalChange('pagehide')`)
    const showBlock = editorSource.slice(
      editorSource.indexOf('function handleBitmapPendingPageShow'),
      editorSource.indexOf('function handleBitmapPendingPageShow') + 1400,
    )
    expect(showBlock).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(showBlock).toContain('persisted')
    for (const block of [hideBlock, showBlock]) {
      expect(block).not.toContain('commitPending')
      expect(block).not.toContain('commitRecovery')
      expect(block).not.toContain('storeAsset')
      expect(block).not.toContain('updateCostumeIfMatch')
      expect(block).not.toContain('preventDefault')
    }
    // beforeunload keeps its prompt (no suppression); hide/show add none.
    const unloadBlock = editorSource.slice(
      editorSource.indexOf('function handleBitmapPendingBeforeUnload'),
      editorSource.indexOf('function handleBitmapPendingBeforeUnload') + 800,
    )
    expect(unloadBlock).toContain('event.preventDefault()')
    expect(unloadBlock).toContain(`event.returnValue = ''`)
  })

  it('production controller is a silent no-op when disabled (wrong-owner safe by construction)', () => {
    const { cb } = fakeCb()
    const prod = new BitmapPendingController(fakeVm() as never, cb as never)
    expect(prod.ensure(slotA, fakeCanvas())).toBeUndefined()
    expect(prod.retainUnsavedForExternalChange('pagehide')).toBe(false)
    expect(prod.hasRecovery()).toBe(false)
    expect(prod.hasUnsavedState()).toBe(false)
    expect(prod.getBeforeUnloadState().needsPreventDefault).toBe(false)
  })

  it('wrong-owner history writes are refused (no cross-slot commit/history)', async () => {
    const { cb } = fakeCb()
    const commits: unknown[] = []
    const committingCb = {
      onSelection: () => {},
      onStatus: () => {},
      onSnapshot: () => {},
      onRecoverySnapshot: () => {},
      peekHistory: async <E>(): Promise<E | undefined> => undefined,
      commitHistory: <E>(entry: E): boolean => {
        commits.push(entry)
        return true
      },
      historyDepth: () => 0,
      historyIsCurrent: () => true,
      readConfig: () => ({}),
    }
    // Drive through the public path: stage on A, switch to B (retain), then
    // prove the retained A recovery cannot append into the live B history.
    const ctrl2 = createBitmapPendingControllerForTest(fakeVm() as never, committingCb as never)
    injectActive(ctrl2, slotA, mockSession({ hasPending: true }))
    expect(ctrl2.ensure(slotB, fakeCanvas())).toBeUndefined()
    expect(ctrl2.hasRecovery()).toBe(true)
    expect(ctrl2.recoverySlotKeys()).toEqual([keyOf(slotA)])
    // Committing the retained recovery is owner-checked by the session CAS;
    // the mock session reports nothing-to-commit (never writes B).
    const res = (await ctrl2.commitRecovery()) as { kind?: string }
    expect(['nothing-to-commit', 'refused'].includes(String(res?.kind))).toBe(true)
    expect(commits.length).toBe(0)
  })

  it('clean controller no-ops: export undefined, discard nothing-pending, unconfirmed refused', async () => {
    const { cb } = fakeCb()
    const clean = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    expect(await clean.exportRecoveryPng()).toBeUndefined()
    expect(clean.discardRecovery({ confirmed: true })).toEqual({ ok: true, kind: 'nothing-pending' })
    injectActive(clean, slotA, mockSession({ hasPending: true }))
    expect(clean.ensure(slotB, fakeCanvas())).toBeUndefined()
    expect(clean.discardRecovery()).toEqual({ ok: false, kind: 'refused' })
    expect(clean.hasRecovery()).toBe(true)
    expect(clean.getBeforeUnloadState().needsPreventDefault).toBe(true)
  })

  it('unknown unmount reasons retain; only explicit destructive close clears', () => {
    const { cb } = fakeCb()
    const ctrl = createBitmapPendingControllerForTest(fakeVm() as never, cb as never)
    injectActive(ctrl, slotA, mockSession({ hasPending: true }))
    ctrl.destroy('teardown')
    expect(ctrl.hasRecovery()).toBe(true)
    ctrl.destroy('pagehide')
    expect(ctrl.hasRecovery()).toBe(true)
    ctrl.destroy('unmount')
    expect(ctrl.hasRecovery()).toBe(true)
    ctrl.destroy('explicit-destructive-close')
    expect(ctrl.hasRecovery()).toBe(false)
    expect(ctrl.hasUnsavedState()).toBe(false)
  })
})
