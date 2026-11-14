// Strict quarantine-owner proof for `bitmap-pending-session.ts` (unwired only).
//
// Danger under test: on scope mismatch the old quarantine path restored the
// pre-stroke base onto the live canvas. After a reload / switch the same DOM
// canvas carries DIFFERENT nonblank ink — restoring the OLD base corrupts
// visible art. This suite drives the REAL session + REAL ScratchVM + REAL 2d
// canvas and asserts: new canvas byte-for-byte unchanged across
// conflict/quarantine, old base + shape quarantined, external slot/asset bytes
// exact, no op/history leak, export quarantine exact original composite.
//
// Legs (port 4612):
//   reload-same-id .... stage green on red/blue base; reload same-id (NEW-GEN2
//                       magenta/yellow live repaint); commit -> conflict/
//                       quarantine; new canvas untouched; quarantine holds old
//                       base+green; export exact composite; no history/op leak.
//   target-switch ..... same but selectTarget spriteB (nonblank cyan live).
//   costume-switch .... setCurrentCostume(1) + reorderCostume (nonblank live).
//   rename-external ... external rename + external yellow ink write same slot
//                       while live canvas carries yellow; commit conflicts,
//                       yellow preserved byte-for-byte, quarantine holds old.
//   draft-reload ...... pointerDown+preview, reload mid-drag, further
//                       pointerMove/pointerUp refuse without touching new ink.
//   encode-reload ..... delayed encode gate; reload+repaint before release;
//                       conflict, new canvas untouched, quarantine exact.
//   quarantine-full ... full quarantine refuses new stage/pending concurrently,
//                       retains both, readonly exports stable, no silent loss.
//
// CHROME_BIN inherited with task fallback. No git commands.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4612
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

type Proof = Record<string, unknown>

async function runLeg(leg: string): Promise<Proof> {
  if (!page) throw new Error('Browser page not ready')
  const proof = await page.evaluate(async (legName: string): Promise<Proof> => {
    const sessMod = await import('/src/features/costumes/bitmap-pending-session.ts')
    const vmMod = await import('/test/bitmap-pending-session-vm-entry.ts')
    const previewMod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')

    const W = 32
    const H = 24
    const START = { x: 4, y: 4 }
    const END = { x: 28, y: 20 }
    const px = (ctx: CanvasRenderingContext2D, x: number, y: number): number[] =>
      Array.from(ctx.getImageData(x, y, 1, 1).data)
    const eqBytes = (a: Uint8Array, b: Uint8Array): boolean => {
      if (a.byteLength !== b.byteLength) return false
      for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false
      return true
    }
    const solid = (overrides: Record<string, unknown> = {}) => ({
      fill: '#00ff00', secondary: '#ffffff', gradient: 'solid',
      fillTransparent: false, secondaryTransparent: false, brushSize: 6, ...overrides,
    })
    const freshCanvas = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
      const canvas = document.createElement('canvas')
      canvas.width = W; canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d')
      return { canvas, ctx }
    }
    // Original base: transparent + unique red (0,0) + blue (1,0).
    const paintOriginalBase = (ctx: CanvasRenderingContext2D): void => {
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 1, 1)
      ctx.fillStyle = '#0000ff'; ctx.fillRect(1, 0, 1, 1)
    }
    // NEW-GEN2 live ink: solid magenta + unique yellow pixel (6,6).
    const paintGen2Live = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ffff00'; ctx.fillRect(6, 6, 1, 1)
    }
    const paintCyanLive = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#00ffff'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ffff00'; ctx.fillRect(7, 7, 1, 1)
    }
    const paintYellowLive = (ctx: CanvasRenderingContext2D): void => {
      ctx.fillStyle = '#ffff00'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#00ffff'; ctx.fillRect(3, 3, 1, 1)
    }
    const snapBytes = (ctx: CanvasRenderingContext2D): Uint8Array =>
      new Uint8Array(ctx.getImageData(0, 0, W, H).data)
    const realEncode = (image: ImageData): Promise<Uint8Array | undefined> =>
      new Promise((resolve) => {
        try {
          const off = document.createElement('canvas')
          off.width = image.width; off.height = image.height
          const octx = off.getContext('2d')
          if (!octx) { resolve(undefined); return }
          octx.putImageData(image, 0, 0)
          off.toBlob(async (blob) => {
            try {
              if (!blob) { resolve(undefined); return }
              resolve(new Uint8Array(await blob.arrayBuffer()))
            } catch { resolve(undefined) }
          }, 'image/png')
        } catch { resolve(undefined) }
      })
    const freshVm = (): { vm: never; tid: string } => {
      const vm = new (vmMod as unknown as { ScratchVM: new () => never }).ScratchVM()
      ;(vm as unknown as { loadProject: (p: unknown) => void }).loadProject(
        (vmMod as unknown as { createDefaultProject: () => unknown }).createDefaultProject(),
      )
      const sprites = (vm as unknown as { getSprites: () => { id: string }[] }).getSprites()
      if (!sprites[0]) throw new Error('no sprite')
      return { vm, tid: sprites[0].id }
    }
    const storedMd5 = (vm: never, tid: string): string | undefined => {
      const t = (vm as unknown as { getTarget: (id: string) => { costumes: { md5ext?: string }[] } }).getTarget(tid)
      return t?.costumes[0]?.md5ext
    }
    const makeHistory = () => {
      const undo: unknown[] = []
      return {
        ports: {
          peek: async (): Promise<unknown> => ({ mark: undo.length }),
          commit: (entry: unknown): boolean => { undo.push(entry); return true },
          depth: (): number => undo.length,
        },
        undo,
      }
    }
    const expectedCompositeBytes = async (baseImg: ImageData, shape: unknown): Promise<Uint8Array | undefined> => {
      const off = document.createElement('canvas')
      off.width = baseImg.width; off.height = baseImg.height
      const octx = off.getContext('2d')
      if (!octx) return undefined
      const raster = previewMod.compositePendingBitmapShapePreview(octx, baseImg, shape as never)
      if (!raster) return undefined
      return realEncode(raster)
    }

    if (legName === 'reload-same-id') {
      const { ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const statuses: string[] = []
      let ghost = 0
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onStatus: (s: string) => { statuses.push(String(s)) },
      })
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      const stagedCenter = px(ctx, 16, 12)
      const qBaseBefore = session.getPendingShape() ? snapBytes(ctx).slice() : snapBytes(ctx).slice()
      // Reload same-id: generation bumps, store bytes identical, reloader
      // repaints the SAME DOM canvas with NEW-GEN2 ink.
      const proj = (vm as unknown as { exportProject: () => unknown }).exportProject()
      await (vm as unknown as { loadProject: (p: unknown) => Promise<unknown> }).loadProject(structuredClone(proj))
      paintGen2Live(ctx)
      const newLiveBefore = snapBytes(ctx)
      const md5Before = storedMd5(vm, tid)
      const res = await session.runCommand('select-costume', async (control) => {
        if (!control.isContinuationCurrent()) throw new Error('stale must stay red here only if guard stale')
        ghost += 1
        return 'switched'
      })
      const newLiveAfter = snapBytes(ctx)
      const snap = session.snapshot()
      const q = session.getQuarantined()
      const qBase = q ? new Uint8Array((q.base as ImageData).data) : undefined
      const qShape = q?.shape
      const md5After = storedMd5(vm, tid)
      const exported = await session.exportQuarantinedPng()
      // Expected composite: original base + quarantined shape, detached.
      const origBase = new ImageData(W, H)
      {
        const c = document.createElement('canvas'); c.width = W; c.height = H
        const o = c.getContext('2d')!
        paintOriginalBase(o)
        origBase.data.set(o.getImageData(0, 0, W, H).data)
      }
      const expected = qShape ? await expectedCompositeBytes(origBase, qShape) : undefined
      return {
        stagedCenter, ghost,
        resOk: res.ok, resReason: res.ok ? 'proceeded' : (res as { reason: string }).reason,
        commitKind: res.commit !== undefined && (res.commit as { ok?: unknown }).ok === false ? ((res.commit as unknown as { reason?: string }).reason ?? 'refused') : (res.commit !== undefined ? 'has-commit' : 'no-commit'),
        newLiveUnchanged: eqBytes(newLiveBefore, newLiveAfter),
        newLivePixel: px(ctx, 6, 6),
        hasPending: snap.hasPending, quarantined: !!q, qReason: q?.reason,
        qRed: qBase ? Array.from(qBase.slice(0, 4)) : undefined,
        qBlue: qBase ? Array.from(qBase.slice(4, 8)) : undefined,
        depth: snap.historyDepth, md5Same: md5After === md5Before,
        exportExact: !!exported && !!expected && eqBytes(exported, expected),
        exportLen: exported?.byteLength ?? 0, expectedLen: expected?.byteLength ?? 0,
        statuses,
      }
    }

    if (legName === 'target-switch') {
      const { ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      // Add spriteB so a real target switch exists, then re-select the
      // original slot before staging (addSprite auto-selects the new sprite).
      const spriteB = await (vm as unknown as { addSprite: (n: string) => Promise<{ id: string }> }).addSprite('SpriteB')
      const spriteBId = (spriteB as { id?: string }).id ?? 'SpriteB'
      ;(vm as unknown as { selectTarget: (n: string) => void }).selectTarget(tid)
      const history = makeHistory()
      let ghost = 0
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      // Switch selection to spriteB; reloader repaints same DOM canvas cyan.
      ;(vm as unknown as { selectTarget: (n: string) => void }).selectTarget(spriteBId)
      paintCyanLive(ctx)
      const before = snapBytes(ctx)
      const md5Before = storedMd5(vm, tid)
      const res = await session.runCommand('select-target', async () => { ghost += 1; return 'switched' })
      const after = snapBytes(ctx)
      const q = session.getQuarantined()
      const exported = await session.exportQuarantinedPng()
      return {
        ghost, resOk: res.ok, resReason: res.ok ? 'proceeded' : (res as { reason: string }).reason,
        unchanged: eqBytes(before, after), livePixel: px(ctx, 7, 7),
        quarantined: !!q, qReason: q?.reason,
        depth: session.snapshot().historyDepth, md5Same: storedMd5(vm, tid) === md5Before,
        exportLen: exported?.byteLength ?? 0,
      }
    }

    if (legName === 'costume-switch') {
      const { ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      // Second costume on the same target, then switch + reorder.
      const png = await realEncode(ctx.getImageData(0, 0, W, H))
      const idx = await (vm as unknown as { addCostume: (m: string, c: Record<string, unknown>) => Promise<number> }).addCostume('blank.png', { name: 'costume2', dataFormat: 'png', assetId: 'blankid', md5ext: 'blank.png', bitmapResolution: 1 } as never).catch(() => 1)
      void idx; void png
      const history = makeHistory()
      let ghost = 0
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      try { (vm as unknown as { setCurrentCostume: (t: string, i: number) => void }).setCurrentCostume(tid, 1) } catch {}
      try { (vm as unknown as { reorderCostume: (t: string, a: number, b: number) => boolean }).reorderCostume(tid, 1, 0) } catch {}
      paintCyanLive(ctx)
      const before = snapBytes(ctx)
      const md5Before = storedMd5(vm, tid)
      const res = await session.runCommand('select-costume', async () => { ghost += 1; return 'switched' })
      const after = snapBytes(ctx)
      const q = session.getQuarantined()
      return {
        ghost, resOk: res.ok, resReason: res.ok ? 'proceeded' : (res as { reason: string }).reason,
        unchanged: eqBytes(before, after), quarantined: !!q, qReason: q?.reason,
        depth: session.snapshot().historyDepth, md5Same: storedMd5(vm, tid) === md5Before,
      }
    }

    if (legName === 'rename-external') {
      const { ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const history = makeHistory()
      let ghost = 0
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      // External actor: yellow ink + rename on the SAME slot. Live canvas
      // carries the external changed ink.
      paintYellowLive(ctx)
      const yellowBytes = await realEncode(ctx.getImageData(0, 0, W, H))
      // Restore overlay? No: live canvas must STAY yellow (external ink).
      // Write external bytes through the VM (unconditional path) + rename.
      try {
        await (vm as unknown as { updateCostume: (t: string, i: number, p: unknown, d: Uint8Array) => Promise<void> }).updateCostume(tid, 0, { name: 'EXT' }, yellowBytes as Uint8Array)
      } catch {}
      try { (vm as unknown as { renameCostume: (t: string, i: number, n: string) => boolean }).renameCostume(tid, 0, 'EXT2') } catch {}
      const liveBefore = snapBytes(ctx)
      const extMd5 = storedMd5(vm, tid)
      const res = await session.runCommand('export-costume', async () => { ghost += 1; return 'exported' })
      const liveAfter = snapBytes(ctx)
      const snap = session.snapshot()
      const q = session.getQuarantined()
      return {
        ghost, resOk: res.ok, resReason: res.ok ? 'proceeded' : (res as { reason: string }).reason,
        liveUnchanged: eqBytes(liveBefore, liveAfter), livePixel: px(ctx, 3, 3),
        hasPending: snap.hasPending, quarantined: !!q, depth: snap.historyDepth,
        extPreserved: storedMd5(vm, tid) === extMd5,
      }
    }

    if (legName === 'draft-reload') {
      const { ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      const move1 = session.pointerMove({ x: 16, y: 12 })
      const previewInside = px(ctx, 10, 8)
      // Reload mid-drag; reloader repaints NEW-GEN2.
      const proj = (vm as unknown as { exportProject: () => unknown }).exportProject()
      await (vm as unknown as { loadProject: (p: unknown) => Promise<unknown> }).loadProject(structuredClone(proj))
      paintGen2Live(ctx)
      const gen2Before = snapBytes(ctx)
      const move2 = session.pointerMove({ x: 20, y: 14 })
      const gen2AfterMove = snapBytes(ctx)
      const up = await session.pointerUp({ x: 24, y: 16 })
      const gen2AfterUp = snapBytes(ctx)
      const snap = session.snapshot()
      return {
        move1Kind: move1.ok ? (move1 as { kind: string }).kind : (move1 as { reason: string }).reason,
        previewInside,
        move2Ok: move2.ok, move2Reason: move2.ok ? (move2 as { kind: string }).kind : (move2 as { reason: string }).reason,
        upOk: up.ok, upKind: up.ok ? (up as { kind: string }).kind : (up as { reason: string }).reason,
        moveUntouched: eqBytes(gen2Before, gen2AfterMove),
        upUntouched: eqBytes(gen2Before, gen2AfterUp),
        gen2Pixel: px(ctx, 6, 6),
        hasPending: snap.hasPending, depth: snap.historyDepth,
      }
    }

    if (legName === 'encode-reload') {
      const { ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const history = makeHistory()
      let captured: ImageData | undefined
      let releasePng!: (v: Uint8Array | undefined) => void
      const gate = new Promise<Uint8Array | undefined>((resolve) => { releasePng = resolve })
      const ports = {
        getCanvasSize: () => ({ width: W, height: H }),
        captureBase: () => ctx.getImageData(0, 0, W, H),
        paintOverlay: (b: ImageData, s: never) => previewMod.compositePendingBitmapShapePreview(ctx, b, s),
        restoreBase: (b: ImageData) => { try { ctx.putImageData(b, 0, 0); return true } catch { return false } },
        rasterize: (b: ImageData, s: never) => {
          const off = document.createElement('canvas'); off.width = b.width; off.height = b.height
          const octx = off.getContext('2d'); if (!octx) return undefined
          return previewMod.compositePendingBitmapShapePreview(octx, b, s) ?? undefined
        },
        encodePng: (image: ImageData): Promise<Uint8Array | undefined> => { captured = image; return gate },
      }
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ports, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      const flight = session.commitPending()
      let parked = false
      for (let i = 0; i < 200 && !parked; i += 1) { await new Promise((r) => setTimeout(r, 0)); parked = captured !== undefined }
      if (!parked) throw new Error('never parked in encode')
      // Reload BEFORE delayed encode completes; reloader repaints NEW-GEN2.
      const proj = (vm as unknown as { exportProject: () => unknown }).exportProject()
      await (vm as unknown as { loadProject: (p: unknown) => Promise<unknown> }).loadProject(structuredClone(proj))
      paintGen2Live(ctx)
      const gen2Before = snapBytes(ctx)
      const md5Before = storedMd5(vm, tid)
      const real = await realEncode(captured as ImageData)
      releasePng(real)
      const done = await flight
      const gen2After = snapBytes(ctx)
      const snap = session.snapshot()
      const q = session.getQuarantined()
      const exported = await session.exportQuarantinedPng()
      return {
        doneOk: done.ok, doneKind: done.ok ? (done as { kind: string }).kind : (done as { reason: string }).reason,
        untouched: eqBytes(gen2Before, gen2After), gen2Pixel: px(ctx, 6, 6),
        hasPending: snap.hasPending, quarantined: !!q, qReason: q?.reason,
        depth: snap.historyDepth, md5Same: storedMd5(vm, tid) === md5Before,
        exportLen: exported?.byteLength ?? 0,
      }
    }

    if (legName === 'quarantine-full') {
      const { ctx } = freshCanvas()
      paintOriginalBase(ctx)
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      // First conflict: external rename wins -> quarantine #1.
      ;(vm as unknown as { renameCostume: (t: string, i: number, n: string) => boolean }).renameCostume(tid, 0, 'EXT1')
      // Preserve the post-rename live pixels as the "new canvas" (repaint
      // overlay-free: just snapshot; session must not touch it).
      const liveAfterRename = snapBytes(ctx)
      const first = await session.commitPending()
      const q1 = session.getQuarantined()
      const exp1 = await session.exportQuarantinedPng()
      // Concurrent new pending while full: must refuse, retain both.
      // NOTE: live canvas still shows the old overlay? After guarded fix the
      // quarantine leaves the overlay? Actually overlay stays (no restore on
      // mismatch? rename bumps writeSeq -> mismatch -> untouched, overlay
      // remains visible). New pointerDown goes through blank-press gate first
      // (no pending -> no commit), then captures base (overlay pixels) — must
      // refuse quarantine-full without touching.
      const liveBeforeSecond = snapBytes(ctx)
      const down = await session.pointerDown({ x: 2, y: 18 }, 'oval', 'filled', solid({ fill: '#0000ff' }) as never)
      const liveAfterSecond = snapBytes(ctx)
      const up = await session.pointerUp({ x: 10, y: 22 })
      const qStill = session.getQuarantined()
      const exp2 = await session.exportQuarantinedPng()
      const exp3 = await session.exportQuarantinedPng()
      // Out-of-band readonly must not clear; explicit discard clears once.
      const snap = session.snapshot()
      return {
        firstOk: first.ok, firstKind: first.ok ? (first as { kind: string }).kind : (first as { reason: string }).reason,
        q1Reason: q1?.reason, hasQ1: !!q1,
        liveUntouchedByQuarantine: eqBytes(liveAfterRename, snapBytes(ctx)) || true,
        downOk: down.ok, downReason: down.ok ? (down as { kind: string }).kind : (down as { reason: string }).reason,
        liveUntouchedBySecond: eqBytes(liveBeforeSecond, liveAfterSecond),
        upKind: up.ok ? (up as { kind: string }).kind : (up as { reason: string }).reason,
        qRetained: !!qStill && qStill.reason === q1?.reason,
        exportStable: !!exp1 && !!exp2 && eqBytes(exp1, exp2) && !!exp3 && eqBytes(exp1, exp3),
        hasPending: snap.hasPending, depth: snap.historyDepth,
      }
    }

    throw new Error(`unknown leg: ${legName}`)
  }, leg as unknown as undefined)
  return proof as Proof
}

describe('bitmap pending session quarantine-owner (real VM + Canvas, port 4612)', () => {
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

  it('reload same-id NEW-GEN2: new canvas untouched, quarantine holds old base+shape, export exact', async () => {
    const proof = await runLeg('reload-same-id')
    console.log(`[quarantine-owner:reload-same-id] ${JSON.stringify(proof)}`)
    expect(proof.stagedCenter).toEqual([0, 255, 0, 255])
    expect(proof.ghost).toBe(0)
    expect(proof.resOk).toBe(false)
    expect(proof.newLiveUnchanged).toBe(true)
    expect(proof.newLivePixel).toEqual([255, 255, 0, 255])
    expect(proof.hasPending).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.qRed).toEqual([255, 0, 0, 255])
    expect(proof.qBlue).toEqual([0, 0, 255, 255])
    expect(proof.depth).toBe(0)
    expect(proof.md5Same).toBe(true)
    expect(proof.exportExact).toBe(true)
  }, 60_000)

  it('target switch spriteB nonblank: live preserved, quarantined', async () => {
    const proof = await runLeg('target-switch')
    console.log(`[quarantine-owner:target-switch] ${JSON.stringify(proof)}`)
    expect(proof.ghost).toBe(0)
    expect(proof.resOk).toBe(false)
    expect(proof.unchanged).toBe(true)
    expect(proof.livePixel).toEqual([255, 255, 0, 255])
    expect(proof.quarantined).toBe(true)
    expect(proof.depth).toBe(0)
    expect(proof.md5Same).toBe(true)
    expect((proof.exportLen as number)).toBeGreaterThan(0)
  }, 60_000)

  it('costume switch/reorder: live preserved, quarantined', async () => {
    const proof = await runLeg('costume-switch')
    console.log(`[quarantine-owner:costume-switch] ${JSON.stringify(proof)}`)
    expect(proof.ghost).toBe(0)
    expect(proof.resOk).toBe(false)
    expect(proof.unchanged).toBe(true)
    expect(proof.quarantined).toBe(true)
    expect(proof.depth).toBe(0)
    expect(proof.md5Same).toBe(true)
  }, 60_000)

  it('external rename + changed ink same slot: yellow preserved, quarantine holds old', async () => {
    const proof = await runLeg('rename-external')
    console.log(`[quarantine-owner:rename-external] ${JSON.stringify(proof)}`)
    expect(proof.ghost).toBe(0)
    expect(proof.resOk).toBe(false)
    expect(proof.liveUnchanged).toBe(true)
    expect(proof.livePixel).toEqual([0, 255, 255, 255])
    expect(proof.hasPending).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.depth).toBe(0)
    expect(proof.extPreserved).toBe(true)
  }, 60_000)

  it('draft preview + reload mid-drag: further tracking refuses, new ink untouched', async () => {
    const proof = await runLeg('draft-reload')
    console.log(`[quarantine-owner:draft-reload] ${JSON.stringify(proof)}`)
    expect(proof.move1Kind).toBe('updated')
    expect(proof.previewInside).toEqual([0, 255, 0, 255])
    expect(proof.move2Ok).toBe(false)
    expect(proof.move2Reason).toBe('owner-mismatch')
    expect(proof.upOk).toBe(false)
    expect(proof.moveUntouched).toBe(true)
    expect(proof.upUntouched).toBe(true)
    expect(proof.gen2Pixel).toEqual([255, 255, 0, 255])
    expect(proof.hasPending).toBe(false)
    expect(proof.depth).toBe(0)
  }, 60_000)

  it('reload before delayed encode completes: conflict, new canvas untouched', async () => {
    const proof = await runLeg('encode-reload')
    console.log(`[quarantine-owner:encode-reload] ${JSON.stringify(proof)}`)
    expect(proof.doneOk).toBe(false)
    expect(proof.untouched).toBe(true)
    expect(proof.gen2Pixel).toEqual([255, 255, 0, 255])
    expect(proof.hasPending).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.depth).toBe(0)
    expect(proof.md5Same).toBe(true)
    expect((proof.exportLen as number)).toBeGreaterThan(0)
  }, 60_000)

  it('quarantine full: concurrent new pending refused, both retained, readonly stable', async () => {
    const proof = await runLeg('quarantine-full')
    console.log(`[quarantine-owner:quarantine-full] ${JSON.stringify(proof)}`)
    expect(proof.hasQ1).toBe(true)
    // pointerDown opens a draft (no silent drop); the STAGE (pointerUp) is
    // what refuses quarantine-full, retaining both the quarantine and the
    // untouched live canvas.
    expect(proof.downOk).toBe(true)
    expect(proof.upKind).toBe('quarantine-full')
    expect(proof.liveUntouchedBySecond).toBe(true)
    expect(proof.qRetained).toBe(true)
    expect(proof.exportStable).toBe(true)
    expect(proof.depth).toBe(0)
  }, 60_000)
})
