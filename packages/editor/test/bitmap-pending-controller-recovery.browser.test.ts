import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Controller recovery proof: REAL VM + REAL 2d canvas, test-only factory only.
//
// Production `BITMAP_PENDING_UI_ENABLED` stays `false` (asserted in-page).
// The controller is driven through the isolated `createBitmapPendingControllerForTest`
// factory (explicit injection, no storage/URL/env bypass) against a nonblank
// base + staged red rect, then direct external VM changes:
//
// - target-switch .... stage on sprite-1, addSprite+selectTarget sprite-2,
//   reloader repaints the SAME canvas (cyan + marker); ensure(newSlot) retains
//   the old session off-canvas, returns undefined (new stage rejected), new
//   canvas byte-exact unchanged, old staged exportable with zero VM writes,
//   ordinary destroy() calls retain, unconfirmed discard refused, explicit
//   confirmed discard clears, next ensure creates fresh.
// - reload-same-id .. same target id, project reload with NEW-GEN2 bytes +
//   bumped loadSerial (same-id generation change); retention + explicit
//   commitRecovery() quarantines fail-closed (no VM write), then export works.
// - rename ........... same-slot metadata rename quarantines in the active
//   session via explicit commit (no overwrite); ordinary destroy retains it as
//   recovery; explicit destructive close clears.
// - bytes ............ same-slot external new bytes: conflict preserved,
//   export offered, never auto-overwritten.
// - inflight ......... commit started, then target switch + ensure mid-flight:
//   accepted conservatively (no throw, no cross-slot write/history), recovery
//   retained, new canvas untouched.
// - reentrant ........ status-callback reentrant ensure() stays consistent.
//
// Dedicated Vite port 4641. CHROME_BIN inherited with task fallback.
const root = join(import.meta.dir, '..')
const PORT = 4641
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

type Proof = Record<string, unknown>

async function runLeg(leg: string): Promise<Proof> {
  if (!page) throw new Error('Browser page not ready')
  const proof = await page.evaluate(async (legName: string): Promise<Proof> => {
    const controllerMod = await import('/src/features/costumes/bitmap-pending-controller.ts')
    const vmMod = await import('/test/bitmap-pending-session-vm-entry.ts')

    const W = 120
    const H = 90
    const CENTER = { x: 60, y: 45 }
    const START = { x: 20, y: 15 }
    const END = { x: 100, y: 75 }
    const px = (ctx: CanvasRenderingContext2D, x: number, y: number): number[] =>
      Array.from(ctx.getImageData(x, y, 1, 1).data)
    const snapBytes = (ctx: CanvasRenderingContext2D): Uint8Array =>
      new Uint8Array(ctx.getImageData(0, 0, W, H).data)
    const eqBytes = (a: Uint8Array, b: Uint8Array): boolean => {
      if (a.byteLength !== b.byteLength) return false
      for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false
      return true
    }
    const solidRed = () => ({
      fill: '#ff0000', secondary: '#ffffff', gradient: 'solid',
      fillTransparent: false, secondaryTransparent: false, brushSize: 6,
    })
    const freshCanvas = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      return { canvas, ctx }
    }
    const paintOriginalBase = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#f0f0f0'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, 1, 1)
      ctx.fillStyle = '#0000ff'
      ctx.fillRect(1, 0, 1, 1)
    }
    const paintCyanLive = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#00ffff'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ffff00'
      ctx.fillRect(7, 7, 1, 1)
    }
    const paintMagentaLive = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#ff00ff'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ffff00'
      ctx.fillRect(10, 10, 1, 1)
    }
    const freshVm = (): { vm: never; tid: string } => {
      const vm = new (vmMod as unknown as { ScratchVM: new () => never }).ScratchVM()
      ;(vm as unknown as { loadProject: (p: unknown) => void }).loadProject(
        (vmMod as unknown as { createDefaultProject: () => unknown }).createDefaultProject(),
      )
      const sprites = (vm as unknown as { getSprites: () => { id: string }[] }).getSprites()
      if (!sprites[0]) throw new Error('no sprite in default project')
      return { vm, tid: sprites[0].id }
    }
    const vmApi = (vm: never) =>
      vm as unknown as {
        getTarget: (id: string) => { costumes: { md5ext?: string; name: string }[] } | undefined
        renameCostume: (t: string, i: number, n: string) => boolean
        updateCostume: (t: string, i: number, p: unknown, d: Uint8Array) => Promise<void>
        addSprite: (n: string) => Promise<{ id?: string }>
        selectTarget: (id: string) => void
        exportProject: () => unknown
        loadProject: (p: unknown) => Promise<unknown>
        storeAsset: (d: Uint8Array, f: string) => Promise<{ assetId: string; md5ext: string }>
        updateCostumeIfMatch: (...a: unknown[]) => Promise<unknown>
      }
    const storedMd5 = (vm: never, tid: string): string | undefined => vmApi(vm).getTarget(tid)?.costumes[0]?.md5ext
    const makeCallbacks = () => {
      const undo: unknown[] = []
      const statuses: string[] = []
      return {
        statuses,
        undo,
        callbacks: {
          onSelection: () => {},
          onStatus: (text: string) => {
            statuses.push(String(text))
          },
          onSnapshot: () => {},
          onRecoverySnapshot: () => {},
          peekHistory: async (): Promise<unknown> => ({ mark: undo.length }),
          commitHistory: (entry: unknown): boolean => {
            undo.push(entry)
            return true
          },
          historyDepth: (): number => undo.length,
          historyIsCurrent: (): boolean => true,
          readConfig: () => ({}),
        },
      }
    }
    const pngCenter = async (bytes: Uint8Array): Promise<number[] | undefined> => {
      try {
        const bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }))
        const off = document.createElement('canvas')
        off.width = bmp.width
        off.height = bmp.height
        const octx = off.getContext('2d')
        if (!octx) return undefined
        octx.drawImage(bmp, 0, 0)
        return Array.from(octx.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data)
      } catch {
        return undefined
      }
    }
    const watchVmWrites = (vm: never): { count: () => number; restore: () => void } => {
      let writes = 0
      const target = vm as unknown as Record<string, unknown>
      const origStore = target['storeAsset'] as ((d: Uint8Array, f: string) => Promise<unknown>) | undefined
      const origCas = target['updateCostumeIfMatch'] as ((...a: unknown[]) => Promise<unknown>) | undefined
      if (typeof origStore === 'function') {
        target['storeAsset'] = async (d: Uint8Array, f: string) => {
          writes += 1
          return (origStore as (d: Uint8Array, f: string) => Promise<unknown>).call(vm, d, f)
        }
      }
      if (typeof origCas === 'function') {
        target['updateCostumeIfMatch'] = async (...a: unknown[]) => {
          writes += 1
          return (origCas as (...a: unknown[]) => Promise<unknown>).apply(vm, a)
        }
      }
      return {
        count: () => writes,
        restore: () => {
          if (origStore) target['storeAsset'] = origStore
          if (origCas) target['updateCostumeIfMatch'] = origCas
        },
      }
    }

    if (legName === 'flag') {
      return { flag: (controllerMod as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED }
    }

    if (legName === 'target-switch') {
      const { canvas, ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      const controller = controllerMod.createBitmapPendingControllerForTest(vm as never, made.callbacks as never)
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas)
      if (!staged) throw new Error('no session for slotA')
      await (staged as unknown as { pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown> }).pointerDown(START, 'rect', 'filled', solidRed() as never)
      await (staged as unknown as { pointerUp: (at: unknown) => Promise<unknown> }).pointerUp(END)
      const stagedCenterRed = px(ctx, CENTER.x, CENTER.y).join(',') === '255,0,0,255'
      const md5Staged = storedMd5(vm, tid)
      // Direct external target switch + reloader repaint (same DOM canvas).
      const newcomer = await vmApi(vm).addSprite('SpriteB')
      const spriteB = (newcomer.id ?? '') as string
      vmApi(vm).selectTarget(spriteB)
      paintCyanLive(ctx)
      const liveBefore = snapBytes(ctx)
      const liveMarkerBefore = px(ctx, 7, 7)
      const slotB = { targetId: spriteB, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const next = controller.ensure(slotB, canvas)
      const liveAfter = snapBytes(ctx)
      const hasRecovery = controller.hasRecovery()
      const unsaved = controller.hasUnsavedState()
      const beforeUnload = controller.getBeforeUnloadState()
      // Explicit export of the old staged art: zero VM writes, red center.
      const watcher = watchVmWrites(vm)
      const exported = await controller.exportRecoveryPng()
      const writesDuringExport = watcher.count()
      watcher.restore()
      const md5AfterExport = storedMd5(vm, tid)
      const exportedCenter = exported ? await pngCenter(exported) : undefined
      // Ordinary destroys must retain; unconfirmed discard refused.
      controller.destroy('target-change')
      const afterOrdinaryDestroy = controller.hasRecovery()
      controller.destroy()
      const afterTeardownDestroy = controller.hasRecovery()
      const unconfirmed = controller.discardRecovery()
      const afterUnconfirmed = controller.hasRecovery()
      // Explicit retry is a no-op that never reapplies, then confirmed discard clears.
      const retry = await controller.commitRecovery()
      const md5AfterRetry = storedMd5(vm, tid)
      const confirmed = controller.discardRecovery({ confirmed: true })
      const afterConfirmed = controller.hasRecovery()
      const unsavedAfter = controller.hasUnsavedState()
      const fresh = controller.ensure(slotB, canvas)
      return {
        stagedCenterRed, nextUndefined: next === undefined,
        hasRecovery, unsaved, needsPreventDefault: beforeUnload.needsPreventDefault,
        liveUnchanged: eqBytes(liveBefore, liveAfter),
        liveMarkerBefore, liveMarkerAfter: px(ctx, 7, 7),
        exportedLen: exported?.byteLength ?? 0,
        exportedCenter, writesDuringExport,
        md5Stable: md5AfterExport === md5Staged,
        afterOrdinaryDestroy, afterTeardownDestroy,
        unconfirmedOk: (unconfirmed as { ok?: unknown }).ok, afterUnconfirmed,
        retryOk: (retry as { ok?: unknown }).ok,
        retryKind: (retry as { kind?: unknown }).kind ?? (retry as { reason?: unknown }).reason,
        md5AfterRetry, confirmedOk: (confirmed as { ok?: unknown }).ok,
        afterConfirmed, unsavedAfter,
        freshDefined: fresh !== undefined,
        freshHasPending: fresh ? (fresh as unknown as { snapshot: () => { hasPending?: unknown } }).snapshot().hasPending : 'n/a',
        statuses: made.statuses,
      }
    }

    if (legName === 'reload-same-id') {
      const { canvas, ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      const controller = controllerMod.createBitmapPendingControllerForTest(vm as never, made.callbacks as never)
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas)
      if (!staged) throw new Error('no session')
      await (staged as unknown as { pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown> }).pointerDown(START, 'rect', 'filled', solidRed() as never)
      await (staged as unknown as { pointerUp: (at: unknown) => Promise<unknown> }).pointerUp(END)
      const stagedCenterRed = px(ctx, CENTER.x, CENTER.y).join(',') === '255,0,0,255'
      const md5Before = storedMd5(vm, tid)
      // Same-id project reload with NEW-GEN2 bytes.
      const proj = vmApi(vm).exportProject() as unknown as { targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }> }
      const idx = proj.targets.findIndex((t) => t.id === tid)
      const stored = await vmApi(vm).storeAsset(new TextEncoder().encode('NEW-GEN2'), 'svg')
      proj.targets[idx]!.costumes[0] = { ...proj.targets[idx]!.costumes[0], assetId: stored.assetId, md5ext: stored.md5ext, dataFormat: 'svg' }
      await vmApi(vm).loadProject(proj)
      paintMagentaLive(ctx)
      const liveBefore = snapBytes(ctx)
      const md5Reloaded = storedMd5(vm, tid)
      // Same target id, bumped Editor generation (reload serial).
      const slotGen2 = { targetId: tid, costumeIndex: 0, loadSerial: 2, sessionGeneration: 1 }
      const next = controller.ensure(slotGen2, canvas)
      const liveAfter = snapBytes(ctx)
      const exportBeforeCommit = await controller.exportRecoveryPng()
      // Retention already quarantined off-canvas (no VM write); explicit retry
      // is a no-op that never reapplies, then export works.
      const watcher = watchVmWrites(vm)
      const retry = await controller.commitRecovery()
      const writesDuringRetry = watcher.count()
      const exported = await controller.exportRecoveryPng()
      const writesDuringExport = watcher.count() - writesDuringRetry
      watcher.restore()
      const exportedCenter = exported ? await pngCenter(exported) : undefined
      return {
        stagedCenterRed,
        md5Changed: md5Reloaded !== md5Before,
        nextUndefined: next === undefined,
        hasRecovery: controller.hasRecovery(),
        liveUnchanged: eqBytes(liveBefore, liveAfter),
        liveCenterAfter: px(ctx, CENTER.x, CENTER.y),
        exportBeforeCommitLen: exportBeforeCommit?.byteLength ?? 0,
        retryOk: (retry as { ok?: unknown }).ok,
        retryKind: (retry as { kind?: unknown }).kind ?? (retry as { reason?: unknown }).reason,
        writesDuringRetry,
        exportedLen: exported?.byteLength ?? 0,
        exportedCenter,
        writesDuringExport,
        md5Stable: storedMd5(vm, tid) === md5Reloaded,
        depth: made.undo.length,
        statuses: made.statuses,
      }
    }

    if (legName === 'rename') {
      const { canvas, ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      const controller = controllerMod.createBitmapPendingControllerForTest(vm as never, made.callbacks as never)
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas)
      if (!staged) throw new Error('no session')
      await (staged as unknown as { pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown> }).pointerDown(START, 'rect', 'filled', solidRed() as never)
      await (staged as unknown as { pointerUp: (at: unknown) => Promise<unknown> }).pointerUp(END)
      const md5Before = storedMd5(vm, tid)
      const renamed = vmApi(vm).renameCostume(tid, 0, 'RENAMED')
      const sameSlot = controller.ensure(slotA, canvas)
      const watcher = watchVmWrites(vm)
      const done = await (controller.get() as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      const writesDuringCommit = watcher.count()
      watcher.restore()
      const active = controller.get() as unknown as {
        snapshot: () => Record<string, unknown>
        exportQuarantinedPng: () => Promise<Uint8Array | undefined>
      }
      const snap = active.snapshot()
      const exported = await controller.exportActiveQuarantinePng()
      const exportedCenter = exported ? await pngCenter(exported) : undefined
      controller.destroy('slot-change')
      const retainedAfterOrdinary = controller.hasRecovery()
      controller.destroy('explicit-destructive-close')
      const afterDestructive = controller.hasRecovery()
      return {
        renamed,
        sameSlotReturned: sameSlot !== undefined,
        doneOk: (done as { ok?: unknown }).ok,
        hasPending: snap['hasPending'],
        quarantined: Boolean(snap['quarantined'] ?? snap['quarantine']),
        writesDuringCommit,
        exportedLen: exported?.byteLength ?? 0,
        exportedCenter,
        liveName: vmApi(vm).getTarget(tid)?.costumes[0]?.name,
        md5Stable: storedMd5(vm, tid) === md5Before,
        depth: made.undo.length,
        retainedAfterOrdinary, afterDestructive,
        statuses: made.statuses,
      }
    }

    if (legName === 'bytes') {
      const { canvas, ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      const controller = controllerMod.createBitmapPendingControllerForTest(vm as never, made.callbacks as never)
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas)
      if (!staged) throw new Error('no session')
      await (staged as unknown as { pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown> }).pointerDown(START, 'rect', 'filled', solidRed() as never)
      await (staged as unknown as { pointerUp: (at: unknown) => Promise<unknown> }).pointerUp(END)
      await vmApi(vm).updateCostume(tid, 0, { dataFormat: 'svg' }, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><text>EXT</text></svg>'))
      const md5External = storedMd5(vm, tid)
      const done = await (controller.get() as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      const snap = (controller.get() as unknown as { snapshot: () => Record<string, unknown> }).snapshot()
      const exported = await controller.exportActiveQuarantinePng()
      const exportedCenter = exported ? await pngCenter(exported) : undefined
      return {
        doneOk: (done as { ok?: unknown }).ok,
        quarantined: Boolean(snap['quarantined'] ?? snap['quarantine']),
        externalPreserved: storedMd5(vm, tid) === md5External,
        exportedLen: exported?.byteLength ?? 0,
        exportedCenter,
        depth: made.undo.length,
        statuses: made.statuses,
      }
    }

    if (legName === 'inflight') {
      const { canvas, ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      const controller = controllerMod.createBitmapPendingControllerForTest(vm as never, made.callbacks as never)
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas)
      if (!staged) throw new Error('no session')
      await (staged as unknown as { pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown> }).pointerDown(START, 'rect', 'filled', solidRed() as never)
      await (staged as unknown as { pointerUp: (at: unknown) => Promise<unknown> }).pointerUp(END)
      const md5Before = storedMd5(vm, tid)
      // Start the commit (encode await yields), then switch + ensure mid-flight.
      const flight = (staged as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      const newcomer = await vmApi(vm).addSprite('SpriteB')
      const spriteB = (newcomer.id ?? '') as string
      vmApi(vm).selectTarget(spriteB)
      paintCyanLive(ctx)
      const liveBefore = snapBytes(ctx)
      const slotB = { targetId: spriteB, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const next = controller.ensure(slotB, canvas)
      const done = await flight
      const liveAfter = snapBytes(ctx)
      const exported = await controller.exportRecoveryPng()
      return {
        nextUndefined: next === undefined,
        doneOk: (done as { ok?: unknown }).ok,
        doneKind: (done as { ok?: boolean; kind?: string; reason?: string }).ok ? (done as { kind?: string }).kind : (done as { reason?: string }).reason,
        hasRecovery: controller.hasRecovery(),
        liveUnchanged: eqBytes(liveBefore, liveAfter),
        md5Stable: storedMd5(vm, tid) === md5Before,
        depth: made.undo.length,
        exportedLen: exported?.byteLength ?? 0,
        statuses: made.statuses,
      }
    }

    if (legName === 'reentrant') {
      const { canvas, ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      let controller = undefined as unknown as { ensure: (s: unknown, c: unknown) => unknown; get: () => { snapshot: () => { hasPending?: unknown } } | undefined; hasRecovery: () => boolean }
      let reentered = 0
      const callbacks = {
        ...made.callbacks,
        onSelection: () => {
          if (reentered === 0) {
            reentered += 1
            controller.ensure({ targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }, canvas)
          }
        },
      }
      controller = controllerMod.createBitmapPendingControllerForTest(vm as never, callbacks as never) as never as typeof controller
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const first = controller.ensure(slotA as never, canvas as never) as unknown as {
        pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown>
        pointerUp: (at: unknown) => Promise<unknown>
      }
      if (!first) throw new Error('no session')
      // Staging drives selection (none -> box) through the controller's
      // notify path, which re-enters ensure() synchronously mid-flight.
      await first.pointerDown(START, 'rect', 'filled', solidRed() as never)
      await first.pointerUp(END)
      const second = controller.ensure(slotA as never, canvas as never)
      const live = controller.get()
      return {
        firstDefined: first !== undefined,
        secondDefined: second !== undefined,
        sameSession: second === (live as unknown),
        reentered,
        hasRecovery: controller.hasRecovery(),
        hasPending: live ? live.snapshot().hasPending : 'n/a',
      }
    }

    throw new Error(`unknown leg: ${legName}`)
  }, leg as unknown as undefined)
  return proof as Proof
}

describe('bitmap pending controller recovery (real VM + Canvas, port 4641)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, CHROME_BIN: CHROME_PATH },
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const fresh = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page = fresh
    await fresh.goto(base, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('production flag stays false in-page', async () => {
    const proof = await runLeg('flag')
    expect(proof.flag).toBe(false)
  }, 60_000)

  it('target switch retains staged art: new canvas exact, old exportable, destroy/discard semantics', async () => {
    const proof = await runLeg('target-switch')
    console.log(`[controller-recovery:target-switch] ${JSON.stringify(proof)}`)
    expect(proof.stagedCenterRed).toBe(true)
    expect(proof.nextUndefined).toBe(true)
    expect(proof.hasRecovery).toBe(true)
    expect(proof.unsaved).toBe(true)
    expect(proof.needsPreventDefault).toBe(true)
    expect(proof.liveUnchanged).toBe(true)
    expect(proof.liveMarkerAfter).toEqual(proof.liveMarkerBefore)
    expect(proof.liveMarkerAfter).toEqual([255, 255, 0, 255])
    expect(proof.exportedLen as number).toBeGreaterThan(0)
    expect(proof.exportedCenter).toEqual([255, 0, 0, 255])
    expect(proof.writesDuringExport).toBe(0)
    expect(proof.md5Stable).toBe(true)
    expect(proof.afterOrdinaryDestroy).toBe(true)
    expect(proof.afterTeardownDestroy).toBe(true)
    expect(proof.unconfirmedOk).toBe(false)
    expect(proof.afterUnconfirmed).toBe(true)
    expect(proof.retryOk).toBe(true)
    expect(proof.retryKind).toBe('nothing-to-commit')
    expect(proof.md5AfterRetry).toBeDefined()
    expect(proof.confirmedOk).toBe(true)
    expect(proof.afterConfirmed).toBe(false)
    expect(proof.unsavedAfter).toBe(false)
    expect(proof.freshDefined).toBe(true)
    expect(proof.freshHasPending).toBe(false)
  }, 120_000)

  it('same-id reload generation change: explicit retry quarantines, then export works with zero writes', async () => {
    const proof = await runLeg('reload-same-id')
    console.log(`[controller-recovery:reload-same-id] ${JSON.stringify(proof)}`)
    expect(proof.stagedCenterRed).toBe(true)
    expect(proof.md5Changed).toBe(true)
    expect(proof.nextUndefined).toBe(true)
    expect(proof.hasRecovery).toBe(true)
    expect(proof.liveUnchanged).toBe(true)
    expect(proof.liveCenterAfter).toEqual([255, 0, 255, 255])
    expect(proof.exportBeforeCommitLen as number).toBeGreaterThan(0)
    expect(proof.retryOk).toBe(true)
    expect(proof.retryKind).toBe('nothing-to-commit')
    expect(proof.writesDuringRetry).toBe(0)
    expect(proof.exportedLen as number).toBeGreaterThan(0)
    expect(proof.exportedCenter).toEqual([255, 0, 0, 255])
    expect(proof.writesDuringExport).toBe(0)
    expect(proof.md5Stable).toBe(true)
    expect(proof.depth).toBe(0)
  }, 120_000)

  it('same-slot rename quarantines with external preserved; ordinary destroy retains', async () => {
    const proof = await runLeg('rename')
    console.log(`[controller-recovery:rename] ${JSON.stringify(proof)}`)
    expect(proof.renamed).toBe(true)
    expect(proof.sameSlotReturned).toBe(true)
    expect(proof.doneOk).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.writesDuringCommit).toBe(0)
    expect(proof.exportedLen as number).toBeGreaterThan(0)
    expect(proof.exportedCenter).toEqual([255, 0, 0, 255])
    expect(proof.liveName).toBe('RENAMED')
    expect(proof.md5Stable).toBe(true)
    expect(proof.depth).toBe(0)
    expect(proof.retainedAfterOrdinary).toBe(true)
    expect(proof.afterDestructive).toBe(false)
  }, 120_000)

  it('same-slot external bytes keep the conflict with export offered', async () => {
    const proof = await runLeg('bytes')
    console.log(`[controller-recovery:bytes] ${JSON.stringify(proof)}`)
    expect(proof.doneOk).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.externalPreserved).toBe(true)
    expect(proof.exportedLen as number).toBeGreaterThan(0)
    expect(proof.exportedCenter).toEqual([255, 0, 0, 255])
    expect(proof.depth).toBe(0)
  }, 120_000)

  it('mid-flight commit across a target switch is accepted conservatively', async () => {
    const proof = await runLeg('inflight')
    console.log(`[controller-recovery:inflight] ${JSON.stringify(proof)}`)
    expect(proof.nextUndefined).toBe(true)
    expect(proof.doneOk).toBe(false)
    expect(proof.hasRecovery).toBe(true)
    expect(proof.liveUnchanged).toBe(true)
    expect(proof.md5Stable).toBe(true)
    expect(proof.depth).toBe(0)
    expect(proof.exportedLen as number).toBeGreaterThan(0)
  }, 120_000)

  it('reentrant ensure calls stay consistent', async () => {
    const proof = await runLeg('reentrant')
    console.log(`[controller-recovery:reentrant] ${JSON.stringify(proof)}`)
    expect(proof.firstDefined).toBe(true)
    expect(proof.secondDefined).toBe(true)
    expect(proof.sameSession).toBe(true)
    expect(proof.reentered).toBe(1)
    expect(proof.hasRecovery).toBe(false)
    expect(proof.hasPending).toBe(true)
  }, 120_000)
})
