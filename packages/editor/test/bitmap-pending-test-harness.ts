// Test-only harness for the bitmap pending path (NO production bypass).
//
// Production `BITMAP_PENDING_UI_ENABLED` stays `false` in
// `src/features/costumes/bitmap-pending-controller.ts`. This file is a
// *separate test-only copied/injected module*: it re-implements the
// controller's slot-key ensure/destroy semantics on top of the REAL
// `createBitmapPendingSession` with a compile-time TEST flag, so audit/gate
// tests can enable the path in-process without touching the production
// constant, user data, Editor.svelte, or BitmapEditor.
//
// AGPL: test-only, no production copy; imports the real session/transaction/
// preflight modules (same license, same repo).

import type {
  BitmapPendingScopeExtra,
  BitmapPendingVmLike,
} from '../src/features/costumes/bitmap-pending-vm-writer'
import {
  createBitmapPendingSession as createSession,
  type BitmapPendingSession,
  type BitmapPendingSessionCanvasPorts,
  type BitmapPendingSessionHistoryPorts,
} from '../src/features/costumes/bitmap-pending-session'

// Bun (`bun test`) ships no DOM `ImageData`; the session clones bases via
// `new globalThis.ImageData(data, w, h)`. Install a minimal test-only
// polyfill (width/height/data only) so the REAL session module works in
//-process. Browser suites use the native constructor untouched.
{
  const scope = globalThis as unknown as Record<string, unknown>
  if (typeof scope.ImageData !== 'function') {
    class TestImageData {
      readonly width: number
      readonly height: number
      readonly data: Uint8ClampedArray
      constructor(dataOrWidth: unknown, widthOrHeight?: unknown, height?: unknown) {
        if (dataOrWidth instanceof Uint8ClampedArray && typeof widthOrHeight === 'number') {
          this.data = new Uint8ClampedArray(dataOrWidth)
          this.width = widthOrHeight
          this.height = typeof height === 'number' ? height : 0
        } else if (typeof dataOrWidth === 'number' && typeof widthOrHeight === 'number') {
          this.width = dataOrWidth
          this.height = widthOrHeight
          this.data = new Uint8ClampedArray(dataOrWidth * widthOrHeight * 4)
        } else {
          throw new TypeError('unsupported TestImageData constructor')
        }
      }
    }
    scope.ImageData = TestImageData as unknown
  }
}
import { classifyBitmapPendingCommand } from '../src/features/costumes/bitmap-pending-preflight'

/** Compile-time TEST flag only. Never imported by production code. */
export const BITMAP_PENDING_TEST_ENABLED = true as const

export type TestSlot = {
  targetId: string
  costumeIndex: number
  loadSerial: number
  sessionGeneration: number
}

export function testSlotKey(slot: TestSlot): string {
  return `${slot.targetId}:${slot.costumeIndex}:${slot.loadSerial}:${slot.sessionGeneration}`
}

export type FakeImage = { width: number; height: number; data: Uint8ClampedArray }

export function makeFakeImage(width: number, height: number, fill = 0): FakeImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(fill) }
}

export type TestWorld = {
  vm: BitmapPendingVmLike & {
    state: {
      targetId: string
      index: number
      assetId: string
      md5ext: string
      writeSeq: number
      projectGeneration: number
      selectionEpoch: number
      structureSeq: number
    }
  }
  canvas: {
    image: FakeImage
    touched: string[]
    ports: BitmapPendingSessionCanvasPorts
  }
  history: {
    entries: unknown[]
    depth: () => number
    ports: BitmapPendingSessionHistoryPorts<unknown>
    failNextCommit: boolean
  }
  statuses: string[]
}

/** In-memory VM following the writer's structural surface. */
export function createTestWorld(seed: Partial<TestWorld['vm']['state']> = {}): TestWorld {
  const state = {
    targetId: 'sprite-1',
    index: 0,
    assetId: 'asset-1',
    md5ext: 'md5-1',
    writeSeq: 1,
    projectGeneration: 7,
    selectionEpoch: 3,
    structureSeq: 0,
    ...seed,
  }
  const statuses: string[] = []
  const image = makeFakeImage(120, 90)
  const touched: string[] = []
  const entries: unknown[] = []
  const world = {} as TestWorld

  const vm: TestWorld['vm'] = {
    state,
    getCostumeIdentity: ((targetId: string, index: number) => {
      if (targetId !== state.targetId || index !== state.index) return undefined
      return { assetId: state.assetId, md5ext: state.md5ext, writeSeq: state.writeSeq }
    }) as BitmapPendingVmLike['getCostumeIdentity'],
    getProjectGeneration: (() => state.projectGeneration) as BitmapPendingVmLike['getProjectGeneration'],
    getSelectionEpoch: (() => state.selectionEpoch) as BitmapPendingVmLike['getSelectionEpoch'],
    getCostumeStructureSeq: (() => state.structureSeq) as unknown as BitmapPendingVmLike['getCostumeStructureSeq'],
    updateCostumeIfMatch: (async (targetId: string, index: number, expected: unknown) => {
      // Deterministic CAS: succeed only when slot + writeSeq still match.
      const exp = expected as { writeSeq?: number | null } | undefined
      if (targetId !== state.targetId || index !== state.index) {
        return { ok: false as const, reason: 'conflict' as const }
      }
      if (exp && typeof exp.writeSeq === 'number' && exp.writeSeq !== state.writeSeq) {
        return { ok: false as const, reason: 'conflict' as const }
      }
      state.writeSeq += 1
      state.assetId = `asset-${state.writeSeq}`
      state.md5ext = `md5-${state.writeSeq}`
      return {
        ok: true as const,
        applied: true as const,
        current: { assetId: state.assetId, md5ext: state.md5ext, writeSeq: state.writeSeq },
      }
    }) as unknown as BitmapPendingVmLike['updateCostumeIfMatch'],
  }

  const asImageData = (img: FakeImage): ImageData => img as unknown as ImageData
  const clone = (img: FakeImage): FakeImage => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) })

  const ports: BitmapPendingSessionCanvasPorts = {
    getCanvasSize: () => ({ width: image.width, height: image.height }),
    captureBase: () => clone(image) as unknown as ImageData,
    paintOverlay: (base: ImageData) => {
      touched.push('paintOverlay')
      // Single-pass `base + shape` stand-in: return a copy so the session can stage.
      const b = base as unknown as FakeImage
      return clone(b) as unknown as ImageData
    },
    restoreBase: (base: ImageData) => {
      touched.push('restoreBase')
      const b = base as unknown as FakeImage
      image.width = b.width
      image.height = b.height
      image.data = new Uint8ClampedArray(b.data)
      return true
    },
    rasterize: (base: ImageData) => {
      const b = base as unknown as FakeImage
      return clone(b) as unknown as ImageData
    },
    encodePng: async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
  }

  const historyPorts: BitmapPendingSessionHistoryPorts<unknown> = {
    peek: async () => ({ kind: 'test-entry', seq: state.writeSeq }),
    commit: (entry: unknown) => {
      if (world.history.failNextCommit) {
        world.history.failNextCommit = false
        return false
      }
      entries.push(entry)
      return true
    },
    depth: () => entries.length,
    isCurrent: () => true,
    tryRemove: (entry: unknown) => {
      if (entries.at(-1) === entry) {
        entries.pop()
        return true
      }
      return false
    },
    beginReservation: (entry: unknown) => {
      let released = false
      return {
        isCurrent: () => !released,
        commit: () => {
          if (released) return false
          released = true
          if (world.history.failNextCommit) {
            world.history.failNextCommit = false
            return false
          }
          entries.push(entry)
          return true
        },
        cancel: () => {
          released = true
        },
      }
    },
  }

  world.vm = vm
  world.canvas = { image, touched, ports }
  world.history = { entries, depth: () => entries.length, ports: historyPorts, failNextCommit: false }
  world.statuses = statuses
  void asImageData
  void createSession
  return world
}

/** Test-only controller mirroring BitmapPendingController slot semantics. */
export class TestPendingController {
  private session: BitmapPendingSession<unknown> | undefined
  private slotKey = ''

  constructor(
    private readonly world: TestWorld,
    private readonly slotOf: () => TestSlot,
  ) {}

  ensure(): BitmapPendingSession<unknown> | undefined {
    if (!BITMAP_PENDING_TEST_ENABLED) {
      this.destroy('disabled')
      return undefined
    }
    const slot = this.slotOf()
    const key = testSlotKey(slot)
    if (this.session && this.slotKey === key) return this.session
    // Slot change: drop WITHOUT touching pixels (mirrors production destroy).
    this.destroy('slot-change')
    this.session = createSession<unknown>(
      this.world.vm,
      slot.targetId,
      slot.costumeIndex,
      { loadSerial: slot.loadSerial, sessionGeneration: slot.sessionGeneration },
      this.world.canvas.ports,
      this.world.history.ports,
      { onStatus: (text) => this.world.statuses.push(text) },
      {},
    )
    this.slotKey = key
    return this.session
  }

  get(): BitmapPendingSession<unknown> | undefined {
    if (!BITMAP_PENDING_TEST_ENABLED) return undefined
    return this.session
  }

  destroy(_reason = 'teardown'): void {
    this.session = undefined
    this.slotKey = ''
  }
}

/**
 * Deterministic direct-VM external switch that can destroy pending.
 *
 * Simulates what `vm.setCurrentCostume` / `vm.selectTarget` / `vm.loadProject`
 * do OUTSIDE the session: bump generation/epoch and/or move the slot, with no
 * session hook. A correct gate must refuse/quarantine afterwards, never
 * silently drop the staged shape.
 */
export function directVmExternalSwitch(
  world: TestWorld,
  kind: 'target' | 'costume' | 'project' | 'bytes',
): void {
  const s = world.vm.state
  if (kind === 'target') {
    s.targetId = 'sprite-2'
    s.selectionEpoch += 1
  } else if (kind === 'costume') {
    s.index = 1
    s.selectionEpoch += 1
  } else if (kind === 'project') {
    s.projectGeneration += 1
    s.selectionEpoch += 1
  } else {
    // External bytes on the SAME slot (rename / runtime event write).
    s.writeSeq += 1
    s.assetId = `asset-ext-${s.writeSeq}`
    s.md5ext = `md5-ext-${s.writeSeq}`
  }
}

/** Product paths audited from Editor.svelte + preflight (fail-first table). */
export const COMMIT_FIRST_COMMANDS = [
  'save-bitmap',
  'export-project',
  'export-sb3',
  'export-costume',
  'select-costume',
  'select-target',
  'new-project',
  'load-project',
  'project-switch',
  'convert-to-bitmap',
  'convert-to-vector',
  'duplicate-costume',
  'delete-costume',
  'reorder-costume',
  'delete-target',
  'restore-costume',
  'paint-cut',
  'paint-copy',
  'paint-paste',
  'paint-crop',
  'paint-flip',
  'paint-rotate',
  'paint-clear',
  'paint-floating',
  'paint-redo',
  'paint-escape-commit',
  'paint-tool-switch',
  'paint-blank-press',
  'restyle-noop-unknown-command-fallback',
] as const

export const DISCARD_FIRST_COMMANDS = ['paint-delete-selection', 'paint-undo'] as const
export const LEAVE_PENDING_COMMANDS = ['restyle', 'transform', 'pointercancel-draft', 'blur-keep'] as const

export function expectedPolicyFor(command: string): 'commit-first' | 'discard-first' | 'leave-pending' {
  return classifyBitmapPendingCommand(command)
}

/** Route/tab list audited from Editor.svelte (all must gate pending). */
export const PENDING_GATED_ROUTES = [
  'tab:code',
  'tab:costumes',
  'tab:sounds',
  'tab:external-plugin',
  'route:load-project-input',
  'route:export-project-button',
  'route:export-sb3-button',
  'route:new-project-button',
  'route:select-target-sprite-pane',
  'route:select-costume-costume-list',
  'route:convert-to-bitmap',
  'route:convert-to-vector',
  'route:copy-cut-paste-bitmap-clipboard',
  'route:flip-bitmap-toolbar',
  'route:erase-clear-bitmap-selection',
  'route:delete-costume-target',
  'route:project-vm-events',
] as const

/**
 * Browser `beforeunload` inspection result (static audit, no DOM needed).
 *
 * `Editor.svelte` installs an enabled-only `beforeunload` guard
 * (`handleBitmapPendingBeforeUnload`): `BITMAP_PENDING_UI_ENABLED &&
 * bitmapPendingController.hasUnsavedState()` -> `preventDefault()` +
 * `returnValue = ''`, with symmetric `removeEventListener` cleanup in
 * `onDestroy`. No auto-save, no storage/URL/env bypass. The disabled path is
 * a silent no-op.
 */
export const BEFOREUNLOAD_AUDIT = {
  hasBeforeUnloadGuard: true,
  hasPageHideGuard: false,
  consequence: 'staged pending warns on reload/close when enabled; silent no-op when disabled',
} as const
