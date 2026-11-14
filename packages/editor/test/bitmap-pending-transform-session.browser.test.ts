// Independent real-Canvas session fixtures for staged pending transforms.
//
// Drives the REAL `createBitmapPendingSession` (live import from the Vite dev
// server inside the page) against a REAL `ScratchVM` and a REAL 2d canvas —
// no `Editor.svelte` / `BitmapEditor.svelte` / controller involvement, no
// production flag flip (asserted on disk before+after). The `rotate90`
// adapter under test is session-level only (test-invokable, never UI-wired).
//
// Legs (each with a fresh canvas + VM + history):
//   move ..... stage rect, `moveBy`, exact stage pixels (new center red, old
//              center restored to base), `commitPending` lands once (depth 1,
//              stored PNG decodes red at the moved center, md5 changed).
//   resize ... stage rect, `retarget` grown box, exact pixels, one commit.
//   rotate ... stage non-square rect, `rotate90('cw')` box swap about the
//              shape center, exact pixels (new center red, old-exclusive
//              corner restored), one commit.
//   failure .. failing encode refuses with pending+overlay retained; retry
//              lands exactly one history entry. Oversized rotate bounds and
//              huge retargets never throw and never allocate (clamped).
//   owner .... external rename bumps writeSeq -> CAS conflict: external bytes
//              preserved, no history, session never overwrites.
//   offcanvas  move partially off-canvas clips and still commits once.
//   reload ... reloading the SAME project bumps projectGeneration: staged
//              `moveBy` / `commitPending` refuse (owner-mismatch/superseded),
//              live canvas digest untouched, no history, stored bytes intact.
//
// Dedicated Vite port 4655 (surveyed 2026-11-13: no literal 4655 claim in
// test/*.test.ts; neighbours 4641/4642/4611/4612/4695/4698/4699 in use).
// CHROME_BIN is inherited, with the task-given fallback.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4655
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
const CONTROLLER_URL = new URL(
  '../src/features/costumes/bitmap-pending-controller.ts',
  import.meta.url,
)
const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await Bun.file(CONTROLLER_URL).text()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[transform-session] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run`,
    )
  }
}

type Proof = Record<string, unknown>

async function runLeg(leg: string): Promise<Proof> {
  if (!page) throw new Error('Browser page not ready')
  const proof = await page.evaluate(async (legName: string): Promise<Proof> => {
    const sessMod = await import('/src/features/costumes/bitmap-pending-session.ts')
    const vmMod = await import('/test/bitmap-pending-session-vm-entry.ts')

    const W = 120
    const H = 90
    const START = { x: 30, y: 15 }
    const END = { x: 90, y: 55 }
    // Staged box: { x: 30, y: 15, width: 60, height: 40 }, center (60, 35).
    const SHAPE_CENTER = { x: 60, y: 35 }
    const px = (ctx: CanvasRenderingContext2D, x: number, y: number): number[] =>
      Array.from(ctx.getImageData(x, y, 1, 1).data)
    const digest = (ctx: CanvasRenderingContext2D): string =>
      Array.from(ctx.getImageData(0, 0, W, H).data).join(',')
    const solid = (overrides: Record<string, unknown> = {}) => ({
      fill: '#ff0000',
      secondary: '#ffffff',
      gradient: 'solid',
      fillTransparent: false,
      secondaryTransparent: false,
      brushSize: 6,
      ...overrides,
    })
    const freshCanvas = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      return { canvas, ctx }
    }
    const freshVm = async (): Promise<{ vm: never; tid: string }> => {
      const vm = new (vmMod as unknown as { ScratchVM: new () => never }).ScratchVM()
      await (vm as unknown as { loadProject: (p: unknown) => Promise<unknown> }).loadProject(
        (vmMod as unknown as { createDefaultProject: () => unknown }).createDefaultProject(),
      )
      const sprites = (vm as unknown as { getSprites: () => { id: string }[] }).getSprites()
      if (!sprites[0]) throw new Error('no sprite in default project')
      const tid = sprites[0].id
      // Settle async asset decode before any md5 read: the VM installs the
      // stored costume asynchronously after loadProject resolves (observed
      // `.svg` placeholder flipping to the decoded `.png` mid-leg), so poll
      // until the md5 is stable over consecutive reads.
      let last: string | undefined
      let stable = 0
      for (let i = 0; i < 100 && stable < 5; i += 1) {
        const t = (vm as unknown as { getTarget: (id: string) => { costumes: { md5ext?: string }[] } }).getTarget(tid)
        const md5 = t?.costumes[0]?.md5ext
        if (md5 !== undefined && md5 === last) stable += 1
        else stable = 0
        last = md5
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return { vm, tid }
    }
    const storedMd5 = (vm: never, tid: string): string | undefined => {
      const t = (vm as unknown as { getTarget: (id: string) => { costumes: { md5ext?: string }[] } }).getTarget(tid)
      return t?.costumes[0]?.md5ext
    }
    const decodeSample = async (bytes: Uint8Array, x: number, y: number): Promise<number[]> => {
      const bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }))
      const off = document.createElement('canvas')
      off.width = bmp.width
      off.height = bmp.height
      const octx = off.getContext('2d')
      if (!octx) throw new Error('no decode context')
      octx.drawImage(bmp, 0, 0)
      return Array.from(octx.getImageData(x, y, 1, 1).data)
    }
    const loadStoredPng = async (vm: never, tid: string): Promise<Uint8Array | undefined> => {
      const md5 = storedMd5(vm, tid)
      if (!md5) return undefined
      return (vm as unknown as { loadAsset: (k: string, f: string) => Promise<Uint8Array> }).loadAsset(md5, 'png')
    }
    const makeHistory = () => {
      const undo: unknown[] = []
      return {
        ports: {
          peek: async (): Promise<unknown> => ({ mark: undo.length }),
          commit: (entry: unknown): boolean => {
            undo.push(entry)
            return true
          },
          depth: (): number => undo.length,
        },
        undo,
      }
    }
    const stageRect = async (
      session: { pointerDown: (at: never, k: never, m: never, s: never) => Promise<unknown>; pointerUp: (at: never) => Promise<unknown> },
    ): Promise<void> => {
      await session.pointerDown(START as never, 'rect' as never, 'filled' as never, solid() as never)
      await session.pointerUp(END as never)
    }

    if (legName === 'move') {
      const { ctx } = freshCanvas()
      const { vm, tid } = await freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await stageRect(session)
      const md5Before = storedMd5(vm, tid)
      const moved = session.moveBy(20, 10)
      // Moved box: { 30,15,60,40 } -> { 50,25,60,40 }; new center (80,45).
      // The old top-left corner (30,15) leaves the shape and restores base.
      const newCenter = px(ctx, 80, 45)
      const oldCorner = px(ctx, START.x, START.y)
      const committed = await session.commitPending()
      const snap = session.snapshot()
      const stored = await loadStoredPng(vm, tid)
      const storedCenter = stored ? await decodeSample(stored, 80, 45) : undefined
      return {
        movedOk: moved.ok, movedKind: moved.ok ? (moved as { kind: string }).kind : (moved as { reason: string }).reason,
        newCenter, oldCorner, md5Before, md5After: storedMd5(vm, tid),
        committedOk: committed.ok, committedKind: committed.ok ? (committed as { kind: string }).kind : 'refused',
        depth: snap.historyDepth, hasPending: snap.hasPending, storedCenter,
      }
    }

    if (legName === 'resize') {
      const { ctx } = freshCanvas()
      const { vm, tid } = await freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await stageRect(session)
      const md5Before = storedMd5(vm, tid)
      const grown = session.retarget({ x: 20, y: 5, width: 80, height: 60 })
      // Grown center (60,35) stays red; grown corner (95,60) now inside.
      const center = px(ctx, SHAPE_CENTER.x, SHAPE_CENTER.y)
      const corner = px(ctx, 95, 60)
      const outside = px(ctx, 5, 5)
      const committed = await session.commitPending()
      const snap = session.snapshot()
      const stored = await loadStoredPng(vm, tid)
      const storedCenter = stored ? await decodeSample(stored, SHAPE_CENTER.x, SHAPE_CENTER.y) : undefined
      return {
        grownOk: grown.ok, grownKind: grown.ok ? (grown as { kind: string }).kind : (grown as { reason: string }).reason,
        center, corner, outside, md5Before, md5After: storedMd5(vm, tid),
        committedOk: committed.ok, committedKind: committed.ok ? (committed as { kind: string }).kind : 'refused',
        depth: snap.historyDepth, hasPending: snap.hasPending, storedCenter,
      }
    }

    if (legName === 'rotate') {
      const { ctx } = freshCanvas()
      const { vm, tid } = await freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await stageRect(session)
      const md5Before = storedMd5(vm, tid)
      if (typeof session.rotate90 !== 'function') throw new Error('session.rotate90 adapter missing')
      const rotated = session.rotate90('cw')
      const shape = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number } } | undefined
      // 60x40 at (30,15) center (60,35) -> 40x60 at (40,5), center unchanged.
      const center = px(ctx, SHAPE_CENTER.x, SHAPE_CENTER.y)
      // Old-exclusive corner (85,20): inside the 60-wide box, outside the
      // 40-wide rotated box -> restored to base transparent.
      const oldCorner = px(ctx, 85, 20)
      // New-exclusive edge (60,60): inside the 60-tall rotated box only.
      const newEdge = px(ctx, 60, 60)
      const committed = await session.commitPending()
      const snap = session.snapshot()
      const stored = await loadStoredPng(vm, tid)
      const storedCenter = stored ? await decodeSample(stored, SHAPE_CENTER.x, SHAPE_CENTER.y) : undefined
      return {
        rotatedOk: rotated.ok, rotatedKind: rotated.ok ? (rotated as { kind: string }).kind : (rotated as { reason: string }).reason,
        box: shape?.box, center, oldCorner, newEdge, md5Before, md5After: storedMd5(vm, tid),
        committedOk: committed.ok, committedKind: committed.ok ? (committed as { kind: string }).kind : 'refused',
        depth: snap.historyDepth, hasPending: snap.hasPending, storedCenter,
      }
    }

    if (legName === 'failure-memory') {
      const { ctx } = freshCanvas()
      const previewMod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
      const { vm, tid } = await freshVm()
      const history = makeHistory()
      let failOpen = true
      const ports = {
        getCanvasSize: () => ({ width: W, height: H }),
        captureBase: () => ctx.getImageData(0, 0, W, H),
        paintOverlay: (b: ImageData, s: never) => previewMod.compositePendingBitmapShapePreview(ctx, b, s),
        restoreBase: (b: ImageData) => {
          try {
            ctx.putImageData(b, 0, 0)
            return true
          } catch {
            return false
          }
        },
        rasterize: (b: ImageData, s: never) => {
          const off = document.createElement('canvas')
          off.width = b.width
          off.height = b.height
          const octx = off.getContext('2d')
          if (!octx) return undefined
          return previewMod.compositePendingBitmapShapePreview(octx, b, s) ?? undefined
        },
        encodePng: async (): Promise<Uint8Array | undefined> => {
          if (failOpen) return undefined
          const off = document.createElement('canvas')
          off.width = W
          off.height = H
          const octx = off.getContext('2d')
          if (!octx) return undefined
          return new Promise((resolve) => {
            try {
              off.toBlob(async (blob) => {
                try {
                  resolve(blob ? new Uint8Array(await blob.arrayBuffer()) : undefined)
                } catch {
                  resolve(undefined)
                }
              }, 'image/png')
            } catch {
              resolve(undefined)
            }
          })
        },
      }
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ports, history.ports, {})
      await stageRect(session)
      const md5Before = storedMd5(vm, tid)
      const failed = await session.commitPending()
      const snapAfterFail = session.snapshot()
      const centerAfterFail = px(ctx, SHAPE_CENTER.x, SHAPE_CENTER.y)
      // Capture the store identity BEFORE the retry: the proof object below
      // is built after the retry resolves, so a late read would observe the
      // retried write instead of the failed attempt.
      const md5AfterFail = storedMd5(vm, tid)
      // Memory safety: oversized rotate bounds + huge retarget never throw.
      let threw = false
      try {
        session.rotate90('sideways' as never)
        session.retarget({ x: 0, y: 0, width: 5000, height: 5000 })
      } catch {
        threw = true
      }
      failOpen = false
      const retried = await session.commitPending()
      const snapAfterRetry = session.snapshot()
      return {
        failedOk: failed.ok, failedKind: failed.ok ? (failed as { kind: string }).kind : (failed as { reason: string }).reason,
        hasPendingAfterFail: snapAfterFail.hasPending, centerAfterFail, depthAfterFail: snapAfterFail.historyDepth,
        threw, md5Before, md5AfterFail,
        retriedOk: retried.ok, retriedKind: retried.ok ? (retried as { kind: string }).kind : 'refused',
        depthAfterRetry: snapAfterRetry.historyDepth, hasPendingAfterRetry: snapAfterRetry.hasPending,
      }
    }

    if (legName === 'owner') {
      const { ctx } = freshCanvas()
      const { vm, tid } = await freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await stageRect(session)
      const md5Before = storedMd5(vm, tid)
      // External rename on the same slot (reference parity: the rename +
      // bytes are preserved, the scope gate refuses owner-mismatch, the
      // stale bytes never land, no history).
      const renamed = (vm as unknown as { renameCostume: (t: string, i: number, n: string) => boolean }).renameCostume(tid, 0, 'EXTERNAL')
      const liveName = (vm as unknown as { getTarget: (id: string) => { costumes: { name: string }[] } }).getTarget(tid)?.costumes[0]?.name
      const done = await session.commitPending()
      const snap = session.snapshot()
      return {
        renamed, liveName, md5Before, md5After: storedMd5(vm, tid),
        doneOk: done.ok, doneKind: done.ok ? (done as { kind: string }).kind : (done as { reason: string }).reason,
        depth: snap.historyDepth,
      }
    }

    if (legName === 'offcanvas') {
      const { ctx } = freshCanvas()
      const { vm, tid } = await freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await stageRect(session)
      // Push partially off the right edge: { 30,15,60,40 } -> { 90,15,60,40 }
      // stays clamped, paint clips, commit still lands once.
      const moved = session.moveBy(60, 0)
      const committed = await session.commitPending()
      const snap = session.snapshot()
      const stored = await loadStoredPng(vm, tid)
      const storedEdge = stored ? await decodeSample(stored, W - 1, SHAPE_CENTER.y) : undefined
      return {
        movedOk: moved.ok, movedKind: moved.ok ? (moved as { kind: string }).kind : (moved as { reason: string }).reason,
        committedOk: committed.ok, committedKind: committed.ok ? (committed as { kind: string }).kind : 'refused',
        depth: snap.historyDepth, hasPending: snap.hasPending, storedEdge,
      }
    }

    if (legName === 'reload') {
      const { ctx } = freshCanvas()
      const { vm, tid } = await freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await stageRect(session)
      const digestStaged = digest(ctx)
      // Reload the SAME project: projectGeneration bumps, the staged scope
      // goes stale. The session must never touch the reloader-owned canvas.
      await (vm as unknown as { loadProject: (p: unknown) => Promise<unknown> }).loadProject(
        (vmMod as unknown as { createDefaultProject: () => unknown }).createDefaultProject(),
      )
      const md5Reloaded = storedMd5(vm, tid)
      const moved = session.moveBy(10, 10)
      const done = await session.commitPending()
      const snap = session.snapshot()
      return {
        digestUntouched: digest(ctx) === digestStaged,
        movedOk: moved.ok, movedReason: moved.ok ? (moved as { kind: string }).kind : (moved as { reason: string }).reason,
        doneOk: done.ok, doneKind: done.ok ? (done as { kind: string }).kind : (done as { reason: string }).reason,
        depth: snap.historyDepth, md5Reloaded, md5After: storedMd5(vm, tid),
      }
    }

    throw new Error(`unknown leg ${legName}`)
  }, leg as unknown as undefined)
  return proof as Proof
}

describe('bitmap pending transform session fixtures (move/resize/rotate, real canvas+VM)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe', env: { ...process.env, CHROME_BIN: CHROME_PATH } },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (transform session) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (transform session) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('move renders exact stage pixels and commits exactly once', async () => {
    const proof = await runLeg('move')
    expect(proof.movedKind).toBe('updated')
    // New center paints exactly red; old corner restores the base.
    expect(proof.newCenter).toEqual([255, 0, 0, 255])
    expect(proof.oldCorner).toEqual([0, 0, 0, 0])
    // Pre-commit VM bytes untouched; commit lands once with new bytes.
    expect(proof.md5Before).toBeDefined()
    expect(proof.committedKind).toBe('committed')
    expect(proof.depth).toBe(1)
    expect(proof.hasPending).toBe(false)
    expect(proof.md5After).toBeDefined()
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
  }, 120_000)

  it('resize renders exact stage pixels and commits exactly once', async () => {
    const proof = await runLeg('resize')
    expect(proof.grownKind).toBe('updated')
    expect(proof.center).toEqual([255, 0, 0, 255])
    expect(proof.corner).toEqual([255, 0, 0, 255])
    expect(proof.outside).toEqual([0, 0, 0, 0])
    expect(proof.committedKind).toBe('committed')
    expect(proof.depth).toBe(1)
    expect(proof.hasPending).toBe(false)
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
  }, 120_000)

  it('rotate swaps the box about the shape center, renders exact pixels, commits once', async () => {
    const proof = await runLeg('rotate')
    expect(proof.rotatedKind).toBe('updated')
    expect(proof.box).toEqual({ x: 40, y: 5, width: 40, height: 60 })
    // Center preserved exactly (rotation-symmetric point stays red).
    expect(proof.center).toEqual([255, 0, 0, 255])
    // Old-exclusive corner restores the base; new-exclusive edge paints.
    expect(proof.oldCorner).toEqual([0, 0, 0, 0])
    expect(proof.newEdge).toEqual([255, 0, 0, 255])
    expect(proof.committedKind).toBe('committed')
    expect(proof.depth).toBe(1)
    expect(proof.hasPending).toBe(false)
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
  }, 120_000)

  it('encode failure retains pending+overlay, retry lands once; oversized input never throws', async () => {
    const proof = await runLeg('failure-memory')
    expect(proof.failedOk).toBe(false)
    expect(proof.hasPendingAfterFail).toBe(true)
    expect(proof.centerAfterFail).toEqual([255, 0, 0, 255])
    expect(proof.depthAfterFail).toBe(0)
    expect(proof.threw).toBe(false)
    expect(proof.md5AfterFail).toBe(proof.md5Before)
    expect(proof.retriedKind).toBe('committed')
    expect(proof.depthAfterRetry).toBe(1)
    expect(proof.hasPendingAfterRetry).toBe(false)
  }, 120_000)

  it('external rename wins: external preserved, refused, no history', async () => {
    const proof = await runLeg('owner')
    expect(proof.renamed).toBe(true)
    expect(proof.liveName).toBe('EXTERNAL')
    expect(proof.doneOk).toBe(false)
    expect(proof.doneKind).toBe('owner-mismatch')
    // External rename + bytes preserved verbatim; nothing appended.
    expect(proof.md5After).toBe(proof.md5Before)
    expect(proof.depth).toBe(0)
  }, 120_000)

  it('off-canvas move clips and still commits once', async () => {
    const proof = await runLeg('offcanvas')
    expect(proof.movedKind).toBe('updated')
    expect(proof.committedKind).toBe('committed')
    expect(proof.depth).toBe(1)
    expect(proof.hasPending).toBe(false)
    expect(proof.storedEdge).toEqual([255, 0, 0, 255])
  }, 120_000)

  it('same-project reload refuses transforms/commits and leaves the canvas byte-identical', async () => {
    const proof = await runLeg('reload')
    expect(proof.digestUntouched).toBe(true)
    expect(proof.movedOk).toBe(false)
    expect(proof.movedReason).toBe('owner-mismatch')
    expect(proof.doneOk).toBe(false)
    expect(proof.depth).toBe(0)
    expect(proof.md5After).toBe(proof.md5Reloaded)
  }, 120_000)
})
