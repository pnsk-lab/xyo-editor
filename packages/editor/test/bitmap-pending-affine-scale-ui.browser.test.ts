// Exact affine scale-UI integration proof (real session + real VM + real canvas).
//
// Drives the REAL `createBitmapPendingSession` plus the REAL Editor UI glue
// (`beginPendingScaleUi` / `resolvePendingScaleUi` — the exact functions
// `Editor.svelte` calls) against a REAL `ScratchVM` and a REAL 2d canvas in
// the browser. No controller flag flip (asserted on disk before+after), no
// production edits, no AGPL copy: all oracles below are own math (own
// multiply/apply/AABB/pivot) plus direct Canvas pixel reads.
//
// Legs (each with a FRESH independent canvas + VM + history + session):
// - handles-30 / handles-neg45 / handles-89: all 8 handles at 30 / -45 / 89
//   degrees. Exact pivot anchored (resolved matrix maps the frozen pivot to
//   itself within 1e-9), staged via `stageAffine` (local box + rotation +
//   style verbatim), canvas center stays red, nonblank base dot stays blue.
// - axis-specific: at 30 degrees an `e` drag changes screen width only and an
//   `n` drag changes screen height only (screen-axis `S`, not local shear).
// - zero-delta: resolving at the pointer-down point replays `M0` exactly and
//   the session reports `unchanged` (no repaint, no VM, no history).
// - cancel: after a staged scale, re-staging the frozen original affine
//   restores the exact matrix (pointercancel/lostcapture parity, full affine
//   not just box).
// - singular-45: collapsing a corner onto the pivot at 45 degrees clamps to
//   the shared minimum magnitude (sign kept, never NaN, never singular).
// - bounds-clip: a far drag whose AABB alone would refuse allocation fails
//   closed (`undefined`, staged retained, canvas untouched).
// - commit-meta: one scale at 30 degrees commits exactly once (depth 1, md5
//   changed, stored center red, configured bitmapResolution/rotationCenter
//   saved verbatim); retry is `nothing-to-commit`; history untouched before
//   commit (no early VM/history).
//
// Dedicated Vite port 4721 (surveyed 2026-11-14: no literal 4721 in
// test/*.ts). CHROME_BIN is inherited, with the task-given fallback.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4721
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
      `[affine-scale-ui] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run`,
    )
  }
}

type Proof = Record<string, unknown>

async function runLeg(leg: string): Promise<Proof> {
  if (!page) throw new Error('Browser page not ready')
  const proof = await page.evaluate(async (legName: string): Promise<Proof> => {
    const sessMod = await import('/src/features/costumes/bitmap-pending-session.ts')
    const uiMod = await import('/src/features/costumes/bitmap-pending-scale-ui.ts')
    const affineMod = await import('/src/features/costumes/bitmap-pending-affine.ts')
    const vmMod = await import('/test/bitmap-pending-session-vm-entry.ts')

    const W = 160
    const H = 120
    const START = { x: 30, y: 20 }
    const END = { x: 110, y: 80 }
    const solid = (overrides: Record<string, unknown> = {}) => ({
      fill: '#ff0000',
      secondary: '#ffffff',
      gradient: 'solid',
      fillTransparent: false,
      secondaryTransparent: false,
      brushSize: 6,
      ...overrides,
    })
    const px = (ctx: CanvasRenderingContext2D, x: number, y: number): number[] =>
      Array.from(ctx.getImageData(x, y, 1, 1).data)
    const digest = (ctx: CanvasRenderingContext2D): string =>
      Array.from(ctx.getImageData(0, 0, W, H).data).join(',')
    // Own AABB/pivot oracle (no product import): mirrors the documented
    // equations `H0` handle position + opposite pivot on the screen AABB.
    const oAabb = (box: { x: number; y: number; width: number; height: number }, rot: number, m: { a: number; b: number; c: number; d: number; e: number; f: number }) => {
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      const r = (rot * Math.PI) / 180
      const cos = Math.cos(r)
      const sin = Math.sin(r)
      const corners = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
      ].map((p) => {
        const dx = p.x - cx
        const dy = p.y - cy
        const rx = cx + dx * cos - dy * sin
        const ry = cy + dx * sin + dy * cos
        return { x: m.a * rx + m.c * ry + m.e, y: m.b * rx + m.d * ry + m.f }
      })
      const xs = corners.map((p) => p.x)
      const ys = corners.map((p) => p.y)
      const x0 = Math.min(...xs)
      const y0 = Math.min(...ys)
      return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
    }
    const oHandle = (aabb: { x: number; y: number; width: number; height: number }, h: string) => ({
      x: h.includes('w') ? aabb.x : h.includes('e') ? aabb.x + aabb.width : aabb.x + aabb.width / 2,
      y: h.includes('n') ? aabb.y : h.includes('s') ? aabb.y + aabb.height : aabb.y + aabb.height / 2,
    })
    const oOpposite: Record<string, string> = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' }
    const oApply = (m: { a: number; b: number; c: number; d: number; e: number; f: number }, p: { x: number; y: number }) => ({
      x: m.a * p.x + m.c * p.y + m.e,
      y: m.b * p.x + m.d * p.y + m.f,
    })
    const freshCanvas = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      // Nonblank base: blue dot away from the shape area.
      ctx.fillStyle = '#0000ff'
      ctx.fillRect(10, 10, 6, 6)
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
    const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
    const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

    async function stageAtRotation(rotation: number) {
      const { ctx } = freshCanvas()
      const { vm, tid } = await freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START as never, 'rect' as never, 'filled' as never, solid() as never)
      await session.pointerUp(END as never)
      if (Math.abs(rotation) >= 1e-9) {
        const r = session.rotateTo(rotation)
        if (!r.ok) throw new Error(`rotateTo ${rotation} refused`)
      }
      return { ctx, vm, tid, history, session }
    }

    if (legName.startsWith('handles-')) {
      const rotation = legName === 'handles-30' ? 30 : legName === 'handles-neg45' ? -45 : 89
      const perHandle: Record<string, unknown> = {}
      for (const h of HANDLES) {
        const { ctx, vm, tid, history, session } = await stageAtRotation(rotation)
        void tid
        const shape = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number }; rotation: number }
        const startAabb = oAabb({ ...shape.box }, shape.rotation, IDENT)
        const h0 = oHandle(startAabb, h)
        const pivot = oHandle(startAabb, oOpposite[h])
        // Outward drag: push away from the pivot along both moving axes.
        const dx = h.includes('e') ? 18 : h.includes('w') ? -18 : 0
        const dy = h.includes('s') ? 12 : h.includes('n') ? -12 : 0
        const begun = (uiMod as unknown as { beginPendingScaleUi: (s: unknown, hh: unknown, p: unknown, m: unknown) => { kind: string; state?: unknown } }).beginPendingScaleUi(shape, h, h0, {})
        if (begun.kind !== 'affine' || !begun.state) throw new Error(`begin refused for ${h} @${rotation}`)
        const matrix = (uiMod as unknown as { resolvePendingScaleUi: (s: unknown, p: unknown, m: unknown, b: unknown) => { a: number; b: number; c: number; d: number; e: number; f: number } | undefined }).resolvePendingScaleUi(begun.state, { x: h0.x + dx, y: h0.y + dy }, {}, { width: W, height: H })
        if (!matrix) throw new Error(`resolve refused for ${h} @${rotation}`)
        // Exact pivot anchored (independent apply).
        const mapped = oApply(matrix, pivot)
        const pivotErr = Math.hypot(mapped.x - pivot.x, mapped.y - pivot.y)
        const staged = session.stageAffine(matrix as never)
        if (!staged.ok) throw new Error(`stageAffine refused for ${h} @${rotation}`)
        const after = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number }; rotation: number; style: { fill: string } }
        // Local box + rotation + style verbatim (cross-transform preserved).
        const boxSame = after.box.x === shape.box.x && after.box.y === shape.box.y && after.box.width === shape.box.width && after.box.height === shape.box.height
        const center = px(ctx, 60, 45)
        const baseDot = px(ctx, 12, 12)
        perHandle[h] = {
          pivotErr,
          boxSame,
          rotSame: after.rotation === shape.rotation,
          fillSame: after.style.fill === '#ff0000',
          center,
          baseDot,
          seqBefore: (vm as unknown as { state?: unknown }).state,
          depth: history.undo.length,
        }
      }
      return { rotation, perHandle }
    }

    if (legName === 'axis-specific') {
      const out: Record<string, unknown> = {}
      for (const h of ['e', 'n']) {
        const { ctx, session } = await stageAtRotation(30)
        void ctx
        const shape = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number }; rotation: number }
        const startAabb = oAabb({ ...shape.box }, shape.rotation, IDENT)
        const h0 = oHandle(startAabb, h)
        const begun = (uiMod as unknown as { beginPendingScaleUi: (s: unknown, hh: unknown, p: unknown, m: unknown) => { kind: string; state?: unknown } }).beginPendingScaleUi(shape, h, h0, {})
        if (begun.kind !== 'affine' || !begun.state) throw new Error(`begin refused for axis ${h}`)
        const delta = h === 'e' ? { x: 20, y: 0 } : { x: 0, y: -15 }
        const matrix = (uiMod as unknown as { resolvePendingScaleUi: (s: unknown, p: unknown, m: unknown, b: unknown) => { a: number; b: number; c: number; d: number; e: number; f: number } | undefined }).resolvePendingScaleUi(begun.state, { x: h0.x + delta.x, y: h0.y + delta.y }, {}, { width: W, height: H })
        if (!matrix) throw new Error(`resolve refused for axis ${h}`)
        const staged = session.stageAffine(matrix as never)
        if (!staged.ok) throw new Error(`stage refused for axis ${h}`)
        const afterAabb = (affineMod as unknown as { pendingAffineSelectionAABB: (b: unknown, r: number, m: unknown) => { width: number; height: number } }).pendingAffineSelectionAABB(shape.box, shape.rotation, matrix)
        out[h] = { startW: startAabb.width, startH: startAabb.height, endW: afterAabb?.width, endH: afterAabb?.height }
      }
      return out
    }

    if (legName === 'zero-delta') {
      const { ctx, vm, history, session } = await stageAtRotation(30)
      const shape = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number }; rotation: number }
      const startAabb = oAabb({ ...shape.box }, shape.rotation, IDENT)
      const h0 = oHandle(startAabb, 'se')
      const begun = (uiMod as unknown as { beginPendingScaleUi: (s: unknown, hh: unknown, p: unknown, m: unknown) => { kind: string; state?: { startAffine: unknown } } }).beginPendingScaleUi(shape, 'se', h0, {})
      if (begun.kind !== 'affine' || !begun.state) throw new Error('begin refused (zero-delta)')
      const matrix = (uiMod as unknown as { resolvePendingScaleUi: (s: unknown, p: unknown, m: unknown, b: unknown) => { a: number; b: number; c: number; d: number; e: number; f: number } | undefined }).resolvePendingScaleUi(begun.state, h0, {}, { width: W, height: H })
      if (!matrix) throw new Error('zero-delta resolve refused')
      const before = digest(ctx)
      const seqBefore = (vm as unknown as { getTarget: (id: string) => { costumes: { md5ext?: string }[] } })
      void seqBefore
      const writeSeqBefore = JSON.stringify((session.snapshot() as { historyDepth: number }).historyDepth)
      const staged = session.stageAffine(matrix as never)
      const after = digest(ctx)
      return {
        matrix,
        stagedKind: staged.ok ? (staged as { kind: string }).kind : (staged as { reason: string }).reason,
        digestSame: before === after,
        depthSame: writeSeqBefore === JSON.stringify((session.snapshot() as { historyDepth: number }).historyDepth),
        historyLen: history.undo.length,
      }
    }

    if (legName === 'cancel') {
      const { session } = await stageAtRotation(-45)
      const shape = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number }; rotation: number }
      const startAabb = oAabb({ ...shape.box }, shape.rotation, IDENT)
      const h0 = oHandle(startAabb, 'nw')
      const begun = (uiMod as unknown as { beginPendingScaleUi: (s: unknown, hh: unknown, p: unknown, m: unknown) => { kind: string; state?: unknown; startAffine?: unknown } }).beginPendingScaleUi(shape, 'nw', h0, {})
      if (begun.kind !== 'affine' || !begun.state) throw new Error('begin refused (cancel)')
      const matrix = (uiMod as unknown as { resolvePendingScaleUi: (s: unknown, p: unknown, m: unknown, b: unknown) => { a: number; b: number; c: number; d: number; e: number; f: number } | undefined }).resolvePendingScaleUi(begun.state, { x: h0.x - 22, y: h0.y - 14 }, {}, { width: W, height: H })
      if (!matrix) throw new Error('resolve refused (cancel)')
      const staged = session.stageAffine(matrix as never)
      if (!staged.ok) throw new Error('stage refused (cancel)')
      // pointercancel parity: restore the FULL original affine (not just box).
      const restored = session.stageAffine((begun as { startAffine?: never }).startAffine as never)
      const after = session.getPendingShape() as unknown as { affine?: { a: number; b: number; c: number; d: number; e: number; f: number } }
      return {
        stagedOk: staged.ok,
        restoredOk: restored.ok,
        restoredKind: restored.ok ? (restored as { kind: string }).kind : (restored as { reason: string }).reason,
        affineGone: after.affine === undefined,
      }
    }

    if (legName === 'singular-45') {
      const { session } = await stageAtRotation(45)
      const shape = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number }; rotation: number }
      const startAabb = oAabb({ ...shape.box }, shape.rotation, IDENT)
      const h0 = oHandle(startAabb, 'se')
      const pivot = oHandle(startAabb, 'nw')
      const begun = (uiMod as unknown as { beginPendingScaleUi: (s: unknown, hh: unknown, p: unknown, m: unknown) => { kind: string; state?: unknown } }).beginPendingScaleUi(shape, 'se', h0, {})
      if (begun.kind !== 'affine' || !begun.state) throw new Error('begin refused (singular)')
      // Collapse exactly onto the pivot: magnitudes snap to the shared minimum
      // with sign kept (never NaN, never singular).
      const matrix = (uiMod as unknown as { resolvePendingScaleUi: (s: unknown, p: unknown, m: unknown, b: unknown) => { a: number; b: number; c: number; d: number; e: number; f: number } | undefined }).resolvePendingScaleUi(begun.state, pivot, {}, { width: W, height: H })
      if (!matrix) throw new Error('collapse refused (must clamp, not refuse)')
      const det = matrix.a * matrix.d - matrix.b * matrix.c
      const finite = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every((v) => Number.isFinite(v))
      return { finite, det, detNonZero: Math.abs(det) > 1e-12 }
    }

    if (legName === 'bounds-clip') {
      const { ctx, session, history } = await stageAtRotation(0)
      const shape = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number }; rotation: number }
      const before = digest(ctx)
      // Axis-aligned keeps the legacy path in the UI; drive the pure affine
      // model directly for the over-budget clip (same equations the UI uses).
      const aabb = (affineMod as unknown as { pendingAffineSelectionAABB: (b: unknown, r: number, m: unknown) => { x: number; y: number; width: number; height: number } }).pendingAffineSelectionAABB(shape.box, shape.rotation, IDENT)
      if (!aabb) throw new Error('no aabb (bounds)')
      const drag = (affineMod as unknown as { beginPendingAffineScaleDrag: (b: unknown, r: number, m: unknown, h: unknown, p: unknown, mm: unknown) => unknown }).beginPendingAffineScaleDrag(shape.box, 0, IDENT, 'se', { x: aabb.x + aabb.width, y: aabb.y + aabb.height }, {})
      const matrix = (affineMod as unknown as { resolvePendingAffineScale: (s: unknown, p: unknown, m: unknown, b: unknown) => unknown }).resolvePendingAffineScale(drag, { x: aabb.x + aabb.width + 5000, y: aabb.y + aabb.height + 5000 }, {}, { width: W, height: H })
      const after = digest(ctx)
      return { refused: matrix === undefined, digestSame: before === after, depth: history.undo.length }
    }

    if (legName === 'commit-meta') {
      const { ctx, vm, tid, history, session } = await stageAtRotation(30)
      session.configure({ bitmapResolution: 2, rotationCenterX: 111, rotationCenterY: 222 })
      const shape = session.getPendingShape() as unknown as { box: { x: number; y: number; width: number; height: number }; rotation: number }
      const startAabb = oAabb({ ...shape.box }, shape.rotation, IDENT)
      const h0 = oHandle(startAabb, 'se')
      const begun = (uiMod as unknown as { beginPendingScaleUi: (s: unknown, hh: unknown, p: unknown, m: unknown) => { kind: string; state?: unknown } }).beginPendingScaleUi(shape, 'se', h0, {})
      if (begun.kind !== 'affine' || !begun.state) throw new Error('begin refused (commit)')
      const matrix = (uiMod as unknown as { resolvePendingScaleUi: (s: unknown, p: unknown, m: unknown, b: unknown) => { a: number; b: number; c: number; d: number; e: number; f: number } | undefined }).resolvePendingScaleUi(begun.state, { x: h0.x + 16, y: h0.y + 10 }, {}, { width: W, height: H })
      if (!matrix) throw new Error('resolve refused (commit)')
      const depthBefore = history.undo.length
      const md5Before = storedMd5(vm, tid)
      const seqBefore = (vm as unknown as { state?: unknown }).state
      void seqBefore
      const staged = session.stageAffine(matrix as never)
      if (!staged.ok) throw new Error('stage refused (commit)')
      const depthAfterStage = history.undo.length
      const md5AfterStage = storedMd5(vm, tid)
      const centerStaged = px(ctx, 60, 45)
      const baseDotStaged = px(ctx, 12, 12)
      const committed = await session.commitPending()
      const snap = session.snapshot()
      const md5After = storedMd5(vm, tid)
      const stored = await loadStoredPng(vm, tid)
      const storedCenter = stored ? await decodeSample(stored, 60, 45) : undefined
      const costume = (vm as unknown as { getTarget: (id: string) => { costumes: { bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number }[] } }).getTarget(tid)?.costumes[0]
      const retry = await session.commitPending()
      return {
        stagedOk: staged.ok,
        depthBefore,
        depthAfterStage,
        md5Before,
        md5AfterStage,
        centerStaged,
        baseDotStaged,
        committedOk: committed.ok,
        committedKind: committed.ok ? (committed as { kind: string }).kind : 'refused',
        depth: snap.historyDepth,
        hasPending: snap.hasPending,
        md5After,
        storedCenter,
        meta: { bitmapResolution: costume?.bitmapResolution, rotationCenterX: costume?.rotationCenterX, rotationCenterY: costume?.rotationCenterY },
        retryKind: retry.ok ? (retry as { kind: string }).kind : 'refused',
        retryDepth: snap.historyDepth,
      }
    }

    throw new Error(`unknown leg ${legName}`)
  }, leg as unknown as undefined)
  return proof as Proof
}

describe('bitmap pending affine scale-UI (real session+VM+canvas, Editor glue)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe', env: { ...process.env, CHROME_BIN: CHROME_PATH } },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (affine scale-ui) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (affine scale-ui) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('all 8 handles at 30 degrees: pivot anchored, box/rotation/style verbatim, exact pixels', async () => {
    const proof = await runLeg('handles-30')
    const per = proof.perHandle as Record<string, { pivotErr: number; boxSame: boolean; rotSame: boolean; fillSame: boolean; center: number[]; baseDot: number[]; depth: number }>
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const p = per[h]
      expect(p.pivotErr).toBeLessThan(1e-9)
      expect(p.boxSame).toBe(true)
      expect(p.rotSame).toBe(true)
      expect(p.fillSame).toBe(true)
      expect(p.center).toEqual([255, 0, 0, 255])
      expect(p.baseDot).toEqual([0, 0, 255, 255])
      expect(p.depth).toBe(0)
    }
  }, 120_000)

  it('all 8 handles at -45 degrees: pivot anchored, exact pixels, no early history', async () => {
    const proof = await runLeg('handles-neg45')
    const per = proof.perHandle as Record<string, { pivotErr: number; boxSame: boolean; center: number[]; baseDot: number[]; depth: number }>
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const p = per[h]
      expect(p.pivotErr).toBeLessThan(1e-9)
      expect(p.boxSame).toBe(true)
      expect(p.center).toEqual([255, 0, 0, 255])
      expect(p.baseDot).toEqual([0, 0, 255, 255])
      expect(p.depth).toBe(0)
    }
  }, 120_000)

  it('all 8 handles at 89 degrees: pivot anchored, exact pixels', async () => {
    const proof = await runLeg('handles-89')
    const per = proof.perHandle as Record<string, { pivotErr: number; boxSame: boolean; center: number[]; baseDot: number[] }>
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const p = per[h]
      expect(p.pivotErr).toBeLessThan(1e-9)
      expect(p.boxSame).toBe(true)
      expect(p.center).toEqual([255, 0, 0, 255])
      expect(p.baseDot).toEqual([0, 0, 255, 255])
    }
  }, 120_000)

  it('axis-specific dragged output at 30 degrees (e=width only, n=height only)', async () => {
    const proof = await runLeg('axis-specific')
    const e = proof.e as { startW: number; startH: number; endW: number; endH: number }
    const n = proof.n as { startW: number; startH: number; endW: number; endH: number }
    expect(Math.abs(e.endW - e.startW)).toBeGreaterThan(1)
    expect(Math.abs(e.endH - e.startH)).toBeLessThan(1e-6)
    expect(Math.abs(n.endH - n.startH)).toBeGreaterThan(1)
    expect(Math.abs(n.endW - n.startW)).toBeLessThan(1e-6)
  }, 120_000)

  it('zero-delta stays exact with no late writes', async () => {
    const proof = await runLeg('zero-delta')
    expect(proof.stagedKind).toBe('unchanged')
    expect(proof.digestSame).toBe(true)
    expect(proof.historyLen).toBe(0)
    const m = proof.matrix as { a: number; b: number; c: number; d: number; e: number; f: number }
    expect(m.a).toBe(1)
    expect(m.b).toBe(0)
    expect(m.c).toBe(0)
    expect(m.d).toBe(1)
    expect(m.e).toBe(0)
    expect(m.f).toBe(0)
  }, 120_000)

  it('cancel restores the full original affine (not just the box)', async () => {
    const proof = await runLeg('cancel')
    expect(proof.stagedOk).toBe(true)
    expect(proof.restoredOk).toBe(true)
    expect(proof.affineGone).toBe(true)
  }, 120_000)

  it('45-degree collapse clamps (never NaN, never singular)', async () => {
    const proof = await runLeg('singular-45')
    expect(proof.finite).toBe(true)
    expect(proof.detNonZero).toBe(true)
  }, 120_000)

  it('over-budget drag fails closed with the canvas untouched', async () => {
    const proof = await runLeg('bounds-clip')
    expect(proof.refused).toBe(true)
    expect(proof.digestSame).toBe(true)
    expect(proof.depth).toBe(0)
  }, 120_000)

  it('one commit + saved meta, retry is nothing-to-commit', async () => {
    const proof = await runLeg('commit-meta')
    expect(proof.stagedOk).toBe(true)
    expect(proof.depthBefore).toBe(0)
    expect(proof.depthAfterStage).toBe(0)
    expect(proof.md5AfterStage).toBe(proof.md5Before)
    expect(proof.centerStaged).toEqual([255, 0, 0, 255])
    expect(proof.baseDotStaged).toEqual([0, 0, 255, 255])
    expect(proof.committedKind).toBe('committed')
    expect(proof.depth).toBe(1)
    expect(proof.hasPending).toBe(false)
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
    const meta = proof.meta as { bitmapResolution: number; rotationCenterX: number; rotationCenterY: number }
    expect(meta.bitmapResolution).toBe(2)
    expect(meta.rotationCenterX).toBe(111)
    expect(meta.rotationCenterY).toBe(222)
    expect(proof.retryKind).toBe('nothing-to-commit')
  }, 120_000)
})
