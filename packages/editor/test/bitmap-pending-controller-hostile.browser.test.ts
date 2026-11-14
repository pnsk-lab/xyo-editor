import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Hostile real VM + Canvas legs for the bounded recovery audit (port 4642).
// Production flag stays false; every leg drives the isolated
// `createBitmapPendingControllerForTest` factory against REAL ScratchVM +
// REAL 2d canvas. Covers the gaps beyond the base recovery file:
// - multi-target refusal (A pending, B/C refused, original preserved)
// - ensure-during-commit across 3 nested awaits (encode/peek/CAS windows)
// - destroy/unmount lifecycle with captured pending + discard confirmation
// - export exact pixels + prod-guard beforeunload silence.
const root = join(import.meta.dir, '..')
const PORT = 4642
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
    const paintBase = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#f0f0f0'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, 1, 1)
    }
    const paintCyan = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#00ffff'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ffff00'
      ctx.fillRect(7, 7, 1, 1)
    }
    const paintGreen = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#00ff00'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#0000ff'
      ctx.fillRect(9, 9, 1, 1)
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
          onStatus: (text: string) => { statuses.push(String(text)) },
          onSnapshot: () => {},
          onRecoverySnapshot: () => {},
          peekHistory: async (): Promise<unknown> => ({ mark: undo.length }),
          commitHistory: (entry: unknown): boolean => { undo.push(entry); return true },
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

    if (legName === 'multi-target') {
      const { canvas, ctx } = freshCanvas()
      paintBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      const controller = controllerMod.createBitmapPendingControllerForTest(vm as never, made.callbacks as never)
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas)
      if (!staged) throw new Error('no session A')
      await (staged as unknown as { pointerDown: (a: unknown, k: string, m: string, s: unknown) => Promise<unknown> }).pointerDown(START, 'rect', 'filled', solidRed() as never)
      await (staged as unknown as { pointerUp: (a: unknown) => Promise<unknown> }).pointerUp(END)
      const stagedRed = px(ctx, CENTER.x, CENTER.y).join(',') === '255,0,0,255'
      const md5A = storedMd5(vm, tid)
      const b = await vmApi(vm).addSprite('SpriteB')
      const idB = (b.id ?? '') as string
      vmApi(vm).selectTarget(idB)
      paintCyan(ctx)
      const liveB = snapBytes(ctx)
      const slotB = { targetId: idB, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const nextB = controller.ensure(slotB, canvas)
      const liveBAfter = snapBytes(ctx)
      const c = await vmApi(vm).addSprite('SpriteC')
      const idC = (c.id ?? '') as string
      vmApi(vm).selectTarget(idC)
      paintGreen(ctx)
      const liveC = snapBytes(ctx)
      const slotC = { targetId: idC, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const nextC = controller.ensure(slotC, canvas)
      const liveCAfter = snapBytes(ctx)
      const exported = await controller.exportRecoveryPng()
      return {
        stagedRed, nextBUndefined: nextB === undefined, nextCUndefined: nextC === undefined,
        hasRecovery: controller.hasRecovery(),
        keys: controller.recoverySlotKeys(),
        liveBUnchanged: eqBytes(liveB, liveBAfter),
        liveCUnchanged: eqBytes(liveC, liveCAfter),
        exportedLen: exported?.byteLength ?? 0,
        exportedCenter: exported ? await pngCenter(exported) : undefined,
        md5Stable: storedMd5(vm, tid) === md5A,
        beforeUnload: controller.getBeforeUnloadState(),
        depth: made.undo.length,
      }
    }

    if (legName === 'commit-awaits') {
      const { canvas, ctx } = freshCanvas()
      paintBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      const controller = controllerMod.createBitmapPendingControllerForTest(vm as never, made.callbacks as never)
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas)
      if (!staged) throw new Error('no session')
      await (staged as unknown as { pointerDown: (a: unknown, k: string, m: string, s: unknown) => Promise<unknown> }).pointerDown(START, 'rect', 'filled', solidRed() as never)
      await (staged as unknown as { pointerUp: (a: unknown) => Promise<unknown> }).pointerUp(END)
      const md5Before = storedMd5(vm, tid)
      const flight = (staged as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      // 3 nested await windows: encode -> peek -> CAS. Hit ensure in each.
      const newcomer = await vmApi(vm).addSprite('SpriteB')
      const idB = (newcomer.id ?? '') as string
      vmApi(vm).selectTarget(idB)
      paintCyan(ctx)
      const liveBefore = snapBytes(ctx)
      const slotB = { targetId: idB, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const e1 = controller.ensure(slotB, canvas)
      await Promise.resolve()
      const e2 = controller.ensure(slotB, canvas)
      await new Promise((r) => setTimeout(r, 0))
      const e3 = controller.ensure(slotB, canvas)
      const done = await flight
      const liveAfter = snapBytes(ctx)
      const exported = await controller.exportRecoveryPng()
      return {
        e1Undefined: e1 === undefined, e2Undefined: e2 === undefined, e3Undefined: e3 === undefined,
        doneOk: (done as { ok?: unknown }).ok,
        hasRecovery: controller.hasRecovery(),
        liveUnchanged: eqBytes(liveBefore, liveAfter),
        md5Stable: storedMd5(vm, tid) === md5Before,
        depth: made.undo.length,
        exportedLen: exported?.byteLength ?? 0,
        exportedCenter: exported ? await pngCenter(exported) : undefined,
      }
    }

    if (legName === 'destroy-lifecycle') {
      const { canvas, ctx } = freshCanvas()
      paintBase(ctx)
      const { vm, tid } = freshVm()
      const made = makeCallbacks()
      const controller = controllerMod.createBitmapPendingControllerForTest(vm as never, made.callbacks as never)
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas)
      if (!staged) throw new Error('no session')
      await (staged as unknown as { pointerDown: (a: unknown, k: string, m: string, s: unknown) => Promise<unknown> }).pointerDown(START, 'rect', 'filled', solidRed() as never)
      await (staged as unknown as { pointerUp: (a: unknown) => Promise<unknown> }).pointerUp(END)
      const b = await vmApi(vm).addSprite('SpriteB')
      const idB = (b.id ?? '') as string
      vmApi(vm).selectTarget(idB)
      paintCyan(ctx)
      const slotB = { targetId: idB, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      controller.ensure(slotB, canvas)
      const unsavedBefore = controller.hasUnsavedState()
      const beforeUnloadBefore = controller.getBeforeUnloadState()
      controller.destroy('target-change')
      const afterOrdinary = controller.hasRecovery()
      controller.destroy()
      const afterTeardown = controller.hasRecovery()
      const unconfirmed = controller.discardRecovery()
      const exportedBeforeConfirm = await controller.exportRecoveryPng()
      const exportedCenter = exportedBeforeConfirm ? await pngCenter(exportedBeforeConfirm) : undefined
      const confirmed = controller.discardRecovery({ confirmed: true })
      const afterConfirmed = controller.hasRecovery()
      const beforeUnloadAfter = controller.getBeforeUnloadState()
      // Prod guard stays silent throughout (constructor without factory).
      const prod = new controllerMod.BitmapPendingController(vm as never, made.callbacks as never)
      prod.ensure(slotA as never, canvas as never)
      const prodBeforeUnload = prod.getBeforeUnloadState()
      return {
        unsavedBefore, needsBefore: beforeUnloadBefore.needsPreventDefault,
        afterOrdinary, afterTeardown,
        unconfirmedOk: (unconfirmed as { ok?: unknown }).ok,
        exportedLen: exportedBeforeConfirm?.byteLength ?? 0,
        exportedCenter,
        confirmedOk: (confirmed as { ok?: unknown }).ok,
        afterConfirmed, needsAfter: beforeUnloadAfter.needsPreventDefault,
        prodNeeds: (prodBeforeUnload as { needsPreventDefault?: unknown }).needsPreventDefault,
      }
    }

    throw new Error(`unknown leg: ${legName}`)
  }, leg as unknown as undefined)
  return proof as Proof
}

describe('bitmap pending controller hostile (real VM + Canvas, port 4642)', () => {
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
        if ((await fetch(base)).ok) { ready = true; break }
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

  it('multi-target staging refused with zero loss and exact live bytes', async () => {
    const proof = await runLeg('multi-target')
    console.log(`[hostile:multi-target] ${JSON.stringify(proof)}`)
    expect(proof.stagedRed).toBe(true)
    expect(proof.nextBUndefined).toBe(true)
    expect(proof.nextCUndefined).toBe(true)
    expect(proof.hasRecovery).toBe(true)
    expect((proof.keys as string[]).length).toBe(1)
    expect(proof.liveBUnchanged).toBe(true)
    expect(proof.liveCUnchanged).toBe(true)
    expect(proof.exportedLen as number).toBeGreaterThan(0)
    expect(proof.exportedCenter).toEqual([255, 0, 0, 255])
    expect(proof.md5Stable).toBe(true)
    expect((proof.beforeUnload as { needsPreventDefault?: unknown }).needsPreventDefault).toBe(true)
    expect(proof.depth).toBe(0)
  }, 120_000)

  it('ensure during commit 3 nested awaits stays fail-closed with exact recovery', async () => {
    const proof = await runLeg('commit-awaits')
    console.log(`[hostile:commit-awaits] ${JSON.stringify(proof)}`)
    expect(proof.e1Undefined).toBe(true)
    expect(proof.e2Undefined).toBe(true)
    expect(proof.e3Undefined).toBe(true)
    expect(proof.doneOk).toBe(false)
    expect(proof.hasRecovery).toBe(true)
    expect(proof.liveUnchanged).toBe(true)
    expect(proof.md5Stable).toBe(true)
    expect(proof.depth).toBe(0)
    expect(proof.exportedLen as number).toBeGreaterThan(0)
    expect(proof.exportedCenter).toEqual([255, 0, 0, 255])
  }, 120_000)

  it('destroy/unmount lifecycle, discard confirmation, export pixels, prod guard silence', async () => {
    const proof = await runLeg('destroy-lifecycle')
    console.log(`[hostile:destroy-lifecycle] ${JSON.stringify(proof)}`)
    expect(proof.unsavedBefore).toBe(true)
    expect(proof.needsBefore).toBe(true)
    expect(proof.afterOrdinary).toBe(true)
    expect(proof.afterTeardown).toBe(true)
    expect(proof.unconfirmedOk).toBe(false)
    expect(proof.exportedLen as number).toBeGreaterThan(0)
    expect(proof.exportedCenter).toEqual([255, 0, 0, 255])
    expect(proof.confirmedOk).toBe(true)
    expect(proof.afterConfirmed).toBe(false)
    expect(proof.needsAfter).toBe(false)
    expect(proof.prodNeeds).toBe(false)
  }, 120_000)
})
