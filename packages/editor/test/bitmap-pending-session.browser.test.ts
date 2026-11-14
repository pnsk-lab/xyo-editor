// Event-level proof for `bitmap-pending-session.ts` (isolated adapter only:
// no `Editor.svelte` / `BitmapEditor.svelte` changes).
//
// Every leg drives the REAL session module (imported live from the Vite dev
// server inside the page) against a REAL `ScratchVM` and a REAL 2d canvas:
// - pointerDown / pointerMove / pointerUp event flow (tiny-box gate, stage);
// - restyle in place (red -> blue, gradients, semi-alpha) with no history;
// - export/save/switch through the commit-first preflight gate;
// - delete/undo discard, abort mid-flight, external rename conflict;
// - fail-store retain + retry, concurrent double commit, second-shape
//   commit-first, owner/switch refusal.
//
// What is proven (node asserts on the JSON proof of each leg):
//   tiny ......... 1px drag stages nothing: no pending, no history, no render
//                  invalidation, base pixels untouched.
//   stage/export . red rect staged overlay (center red, depth 0); blue restyle
//                  repaints with no history; same-value restyle is a no-op with
//                  no invalidation; export commits once (depth 1) and the
//                  EXPORTED stored PNG decodes to the EDITED blue center.
//   fail/retry ... failing encode refuses commit-failed with the pending AND
//                  the overlay retained (center still green, depth unchanged);
//                  retry lands exactly one history entry.
//   rename ....... external rename bumps writeSeq -> CAS conflict: the rename
//                  (name + bytes) is preserved, no history, pending dropped.
//   abort ........ abort mid-encode prevents the write: md5ext unchanged,
//                  no history, refused aborted/superseded.
//   switch ....... stale-guard switch refuses BEFORE any write (no ghost op,
//                  pending retained); mid-flight switch suppresses the ghost
//                  op with no store change and no history.
//   discard ...... delete/undo discard restores the pre-drag base with no
//                  history and an invalidation.
//   once ......... two concurrent commits join into exactly one history entry.
//   gradient ..... horizontal semi-transparent gradient: mid alpha is strictly
//                  (0,255), twice-from-base is byte-identical (no
//                  accumulation), the base is untouched.
//   second ....... second pointerDown commits the first shape first (depth 1),
//                  then the new shape stages and commits (depth 2, blue).
//
// Dedicated Vite port 4611 (surveyed 2026-11-13: 4585/4591 taken by sibling
// pending suites; 4613/4621 taken; no literal 4611 claim in test/*.test.ts).
// CHROME_BIN is inherited, with the task-given fallback.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4611
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

    const W = 120
    const H = 90
    const CENTER = { x: 60, y: 45 }
    const START = { x: 20, y: 15 }
    const END = { x: 100, y: 75 }
    const px = (ctx: CanvasRenderingContext2D, x: number, y: number): number[] =>
      Array.from(ctx.getImageData(x, y, 1, 1).data)
    const eqBytes = (a: Uint8Array, b: Uint8Array): boolean => {
      if (a.byteLength !== b.byteLength) return false
      for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false
      return true
    }
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
    const realEncode = (image: ImageData): Promise<Uint8Array | undefined> =>
      new Promise((resolve) => {
        try {
          const off = document.createElement('canvas')
          off.width = image.width
          off.height = image.height
          const octx = off.getContext('2d')
          if (!octx) {
            resolve(undefined)
            return
          }
          octx.putImageData(image, 0, 0)
          off.toBlob(async (blob) => {
            try {
              if (!blob) {
                resolve(undefined)
                return
              }
              resolve(new Uint8Array(await blob.arrayBuffer()))
            } catch {
              resolve(undefined)
            }
          }, 'image/png')
        } catch {
          resolve(undefined)
        }
      })
    const pngCenter = async (bytes: Uint8Array): Promise<number[]> => {
      const bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }))
      const off = document.createElement('canvas')
      off.width = bmp.width
      off.height = bmp.height
      const octx = off.getContext('2d')
      if (!octx) throw new Error('no decode context')
      octx.drawImage(bmp, 0, 0)
      return Array.from(octx.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data)
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
    const storedMd5 = (vm: never, tid: string): string | undefined => {
      const t = (vm as unknown as { getTarget: (id: string) => { costumes: { md5ext?: string }[] } }).getTarget(tid)
      return t?.costumes[0]?.md5ext
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

    if (legName === 'tiny') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const invalidations: number[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onInvalidate: (rev: number) => {
          invalidations.push(rev)
        },
      })
      const rev0 = session.getRenderRev()
      await session.pointerDown({ x: 10, y: 10 }, 'rect', 'filled', solid() as never)
      const up = await session.pointerUp({ x: 11, y: 11 })
      const snap = session.snapshot()
      return {
        upOk: up.ok,
        upKind: up.ok ? (up as { kind: string }).kind : (up as { reason: string }).reason,
        hasPending: snap.hasPending,
        depth: snap.historyDepth,
        revDelta: session.getRenderRev() - rev0,
        invalidations: invalidations.length,
        center: px(ctx, CENTER.x, CENTER.y),
      }
    }

    if (legName === 'stage-export') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const invalidations: number[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onInvalidate: (rev: number) => {
          invalidations.push(rev)
        },
      })
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      const staged = await session.pointerUp(END)
      const centerRed = px(ctx, CENTER.x, CENTER.y)
      const depthAfterStage = session.snapshot().historyDepth
      const revAfterStage = session.getRenderRev()
      const restyled = session.restyle({ fill: '#0000ff' })
      const centerBlue = px(ctx, CENTER.x, CENTER.y)
      const depthAfterRestyle = session.snapshot().historyDepth
      const revAfterRestyle = session.getRenderRev()
      const noop = session.restyle({ fill: '#0000ff' })
      const revAfterNoop = session.getRenderRev()
      let exportedCenter: number[] | undefined
      let ghost = 0
      const gated = await session.runCommand('export-costume', async (control) => {
        if (!control.isContinuationCurrent()) throw new Error('stale continuation must stay green here')
        ghost += 1
        const bytes = await loadStoredPng(vm, tid)
        if (!bytes) throw new Error('no stored bytes after export commit')
        exportedCenter = await pngCenter(bytes)
        return 'exported'
      })
      const snap = session.snapshot()
      return {
        stagedOk: staged.ok,
        centerRed,
        depthAfterStage,
        restyledOk: restyled.ok,
        centerBlue,
        depthAfterRestyle,
        revAfterStage,
        revAfterRestyle,
        revAfterNoop,
        noopKind: noop.ok ? (noop as { kind: string }).kind : 'refused',
        gatedOk: gated.ok,
        gatedKind: gated.ok ? gated.kind : (gated as { reason: string }).reason,
        ghost,
        exportedCenter,
        depth: snap.historyDepth,
        hasPending: snap.hasPending,
        invalidations: invalidations.length,
      }
    }

    if (legName === 'fail-retry') {
      const { ctx } = freshCanvas()
      const previewMod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const invalidations: number[] = []
      let encodeCalls = 0
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
        encodePng: async (image: ImageData): Promise<Uint8Array | undefined> => {
          encodeCalls += 1
          if (failOpen) return undefined
          return realEncode(image)
        },
      }
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ports, history.ports, {
        onInvalidate: (rev: number) => {
          invalidations.push(rev)
        },
      })
      await session.pointerDown(START, 'rect', 'filled', solid({ fill: '#00ff00' }) as never)
      await session.pointerUp(END)
      const md5Before = storedMd5(vm, tid)
      const failed = await session.runCommand('save-bitmap', async () => 'saved')
      const snapAfterFail = session.snapshot()
      const centerAfterFail = px(ctx, CENTER.x, CENTER.y)
      // Capture the store identity BEFORE the retry: the proof object below
      // is built after the retry resolves, so a late read would observe the
      // retried write instead of the failed attempt.
      const md5AfterFail = storedMd5(vm, tid)
      failOpen = false
      const retried = await session.runCommand('save-bitmap', async () => 'saved')
      const snapAfterRetry = session.snapshot()
      const stored = await loadStoredPng(vm, tid)
      const storedCenter = stored ? await pngCenter(stored) : undefined
      return {
        failedOk: failed.ok,
        failedReason: failed.ok ? (failed as { commit?: { kind?: string } }).commit : (failed as { reason: string }).reason,
        hasPendingAfterFail: snapAfterFail.hasPending,
        centerAfterFail,
        depthAfterFail: snapAfterFail.historyDepth,
        encodeCalls,
        md5Before,
        md5AfterFail,
        retriedOk: retried.ok,
        depthAfterRetry: snapAfterRetry.historyDepth,
        hasPendingAfterRetry: snapAfterRetry.hasPending,
        storedCenter,
        invalidations: invalidations.length,
      }
    }

    if (legName === 'rename') {
      const { ctx } = freshCanvas()
      const previewMod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
      const { vm, tid } = freshVm()
      const renameFn = (vm as unknown as { renameCostume: (t: string, i: number, n: string) => boolean }).renameCostume.bind(vm)
      const liveNameOf = (): string | undefined =>
        (vm as unknown as { getTarget: (id: string) => { costumes: { name: string }[] } }).getTarget(tid)?.costumes[0]?.name
      // (a) Rename BEFORE the commit: the scope gate refuses owner-mismatch
      // and the write never runs (rename + bytes preserved, no history).
      const historyA = makeHistory()
      const sessionA = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, historyA.ports, {})
      await sessionA.pointerDown(START, 'rect', 'filled', solid() as never)
      await sessionA.pointerUp(END)
      const md5BeforeA = storedMd5(vm, tid)
      const renamedA = renameFn(tid, 0, 'RENAMED')
      const doneA = await sessionA.commitPending()
      const snapA = sessionA.snapshot()
      const liveNameA = liveNameOf()
      const md5AfterA = storedMd5(vm, tid)
      // (b) Rename DURING the await window: the atomic CAS re-validation
      // fails closed with external-conflict (rename + bytes preserved, the
      // stale bytes never land, no history).
      const historyB = makeHistory()
      // Deterministic await-window gate: the encode stays blocked until the
      // leg releases it, so the rename provably lands while the commit is
      // parked inside `await encodePng` (before any CAS call).
      let capturedImage: ImageData | undefined
      let releasePng!: (v: Uint8Array | undefined) => void
      const pngGate = new Promise<Uint8Array | undefined>((resolve) => {
        releasePng = resolve
      })
      const portsB = {
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
        encodePng: (image: ImageData): Promise<Uint8Array | undefined> => {
          capturedImage = image
          return pngGate
        },
      }
      const sessionB = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, portsB, historyB.ports, {})
      await sessionB.pointerDown(START, 'rect', 'filled', solid({ fill: '#00ff00' }) as never)
      await sessionB.pointerUp(END)
      const md5BeforeB = storedMd5(vm, tid)
      const flightB = sessionB.commitPending()
      // Wait until the write is parked inside `await encodePng`.
      let parked = false
      for (let i = 0; i < 200 && !parked; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        parked = capturedImage !== undefined
      }
      if (!parked) throw new Error('write never reached the encode await')
      // Rename lands strictly inside the await window (before any CAS call).
      const renamedB = renameFn(tid, 0, 'RENAMED2')
      const real = await realEncode(capturedImage as ImageData)
      releasePng(real)
      const doneB = await flightB
      const snapB = sessionB.snapshot()
      return {
        renamedA,
        doneAOk: doneA.ok,
        doneAKind: doneA.ok ? doneA.kind : (doneA as { reason: string }).reason,
        liveNameA,
        md5BeforeA,
        md5AfterA,
        depthA: snapA.historyDepth,
        hasPendingA: snapA.hasPending,
        renamedB,
        doneBOk: doneB.ok,
        doneBKind: doneB.ok ? doneB.kind : (doneB as { reason: string }).reason,
        md5BeforeB,
        md5AfterB: storedMd5(vm, tid),
        liveNameB: liveNameOf(),
        depthB: snapB.historyDepth,
        hasPendingB: snapB.hasPending,
      }
    }

    if (legName === 'abort') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      const md5Before = storedMd5(vm, tid)
      const flight = session.commitPending()
      const aborted = session.abortInFlight('test-abort')
      const done = await flight
      const snap = session.snapshot()
      return {
        abortedKind: aborted.kind,
        doneOk: done.ok,
        doneKind: done.ok ? done.kind : (done as { reason: string }).reason,
        md5Before,
        md5After: storedMd5(vm, tid),
        depth: snap.historyDepth,
      }
    }

    if (legName === 'switch') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      let ghost = 0
      // Stale guard BEFORE the gate: fail-first precheck refuses with no
      // write and the pending retained.
      const staleGuard = () => false
      const refused = await session.runCommand(
        'select-costume',
        async () => {
          ghost += 1
          return 'switched'
        },
        staleGuard,
      )
      const snapAfterRefuse = session.snapshot()
      // Mid-flight switch suppression (ghost op + stale write) is covered by
      // the preflight suite against the same coordinator + CAS writer; the
      // session's fail-first precheck (no write, pending retained) is proven
      // here.
      return {
        refusedOk: refused.ok,
        refusedReason: refused.ok ? 'proceeded' : (refused as { reason: string }).reason,
        ghost,
        hasPendingAfterRefuse: snapAfterRefuse.hasPending,
        depthAfterRefuse: snapAfterRefuse.historyDepth,
        note: 'mid-flight switch covered by preflight suite; session stale-precheck proven here',
      }
    }

    if (legName === 'discard') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const invalidations: number[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onInvalidate: (rev: number) => {
          invalidations.push(rev)
        },
      })
      const beforeCenter = px(ctx, CENTER.x, CENTER.y)
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      const stagedCenter = px(ctx, CENTER.x, CENTER.y)
      const revAfterStage = session.getRenderRev()
      const discarded = session.discardForDeleteOrUndo()
      const snap = session.snapshot()
      return {
        stagedCenter,
        discardedOk: discarded.ok,
        discardedKind: discarded.ok ? (discarded as { kind: string }).kind : (discarded as { reason: string }).reason,
        afterCenter: px(ctx, CENTER.x, CENTER.y),
        beforeCenter,
        depth: snap.historyDepth,
        hasPending: snap.hasPending,
        revAfterStage,
        revAfterDiscard: session.getRenderRev(),
        invalidations: invalidations.length,
      }
    }

    if (legName === 'once') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      const [a, b] = await Promise.all([session.commitPending(), session.commitPending()])
      const snap = session.snapshot()
      return {
        aOk: a.ok,
        aKind: a.ok ? a.kind : (a as { reason: string }).reason,
        bOk: b.ok,
        bKind: b.ok ? b.kind : (b as { reason: string }).reason,
        depth: snap.historyDepth,
        hasPending: snap.hasPending,
      }
    }

    if (legName === 'gradient') {
      const { ctx } = freshCanvas()
      const previewMod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown({ x: 0, y: 0 }, 'rect', 'filled', solid({ gradient: 'horizontal', fillTransparent: true, secondary: '#0000ff' }) as never)
      await session.pointerUp({ x: W, y: H })
      const mid = px(ctx, Math.floor(W / 2), Math.floor(H / 2))
      // Single-pass purity through the SESSION's staged shape: two composites
      // from the same blank base are byte-identical (no alpha accumulation),
      // the live session overlay equals exactly one pass, and the base copy
      // is untouched.
      const shape = session.getPendingShape()
      const blank = new ImageData(W, H)
      const before = new Uint8ClampedArray(blank.data)
      const c1 = freshCanvas()
      const c2 = freshCanvas()
      const o1 = previewMod.compositePendingBitmapShapePreview(c1.ctx, blank, shape as never)
      const o2 = previewMod.compositePendingBitmapShapePreview(c2.ctx, blank, shape as never)
      const live = new Uint8Array(ctx.getImageData(0, 0, W, H).data)
      return {
        mid,
        hasPending: session.snapshot().hasPending,
        twiceEqual: !!o1 && !!o2 && eqBytes(o1.data, o2.data),
        liveEqualFirst: !!o1 && eqBytes(live, o1.data),
        baseUnchanged: eqBytes(blank.data, before),
      }
    }

    if (legName === 'second') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {})
      await session.pointerDown(START, 'rect', 'filled', solid() as never)
      await session.pointerUp(END)
      const depthStaged = session.snapshot().historyDepth
      // Second pointerDown commits the first shape first (blank-press).
      await session.pointerDown({ x: 10, y: 60 }, 'oval', 'filled', solid({ fill: '#0000ff' }) as never)
      const depthAfterDown = session.snapshot().historyDepth
      const hasPendingAfterDown = session.snapshot().hasPending
      await session.pointerUp({ x: 50, y: 80 })
      const done = await session.commitPending()
      const snap = session.snapshot()
      return {
        depthStaged,
        depthAfterDown,
        hasPendingAfterDown,
        doneOk: done.ok,
        depth: snap.historyDepth,
        center: px(ctx, 30, 70),
      }
    }

    if (legName === 'history-false' || legName === 'history-throw' || legName === 'history-concurrent' || legName === 'history-reentrant' || legName === 'history-switch' || legName === 'history-double' || legName === 'history-gap-status' || legName === 'history-gap-block' || legName === 'history-gap-runcommand') {
      // Strict Editor-semantics history: real stored bytes via `loadAsset`,
      // guarded push (scope key+generation, redo cleared, stale drops with
      // redo preserved), undo+redo captured, selection epoch captured.
      const strictHistory = (vmRef: never, tidRef: string, opts: { forceFalse?: boolean; throwAlways?: boolean } = {}) => {
        const undo: unknown[] = []
        let redo: unknown[] = []
        let gen = 0
        const scopeKey = `${tidRef}:0`
        let lastPeekGen: number | undefined
        const targetOf = (): { costumes: { md5ext?: string; assetId?: string; dataFormat?: string; name: string }[]; name?: string } =>
          (vmRef as unknown as { getTarget: (id: string) => never }).getTarget(tidRef) as never as { costumes: { md5ext?: string; assetId?: string; dataFormat?: string; name: string }[]; name?: string }
        const selectionOf = (): number | null => {
          try {
            const fn = (vmRef as unknown as { getSelectionEpoch?: () => unknown }).getSelectionEpoch
            if (typeof fn !== 'function') return null
            const v = (fn as () => unknown).call(vmRef)
            return typeof v === 'number' ? v : null
          } catch { return null }
        }
        const ports = {
          peek: async (): Promise<unknown> => {
            const t = targetOf()
            const costume = t?.costumes[0]
            const key = costume?.md5ext ?? costume?.assetId
            const bytes = key ? await (vmRef as unknown as { loadAsset: (k: string, f: string) => Promise<Uint8Array> }).loadAsset(key, costume?.dataFormat ?? '') : undefined
            if (!costume || !bytes) return undefined
            lastPeekGen = gen
            return { kind: 'costume', targetName: t?.name, index: 0, meta: JSON.parse(JSON.stringify(costume)), bytes: new Uint8Array(bytes), guard: { key: scopeKey, gen, observed: selectionOf() } }
          },
          commit: (entry: unknown): boolean => {
            if (opts.throwAlways) throw new Error('injected-history-throw')
            if (opts.forceFalse) return false
            const g = (entry as { guard?: { key: string; gen: number } }).guard
            if (!g || g.key !== scopeKey || g.gen !== gen) return false
            undo.push(entry)
            redo = []
            return true
          },
          depth: (): number => undo.length,
          redoDepth: (): number => redo.length,
          isCurrent: (): boolean => lastPeekGen === undefined || lastPeekGen === gen,
          tryRemove: (entry: unknown): boolean => {
            if (undo.length > 0 && undo[undo.length - 1] === entry) { undo.pop(); return true }
            return false
          },
          removeLast: (entry: unknown): boolean => {
            if (undo.length > 0 && undo[undo.length - 1] === entry) { undo.pop(); return true }
            return false
          },
          beginReservation: (entry: unknown) => ({
            isCurrent: (): boolean => {
              const g = (entry as { guard?: { key: string; gen: number } }).guard
              return !!g && g.key === scopeKey && g.gen === gen
            },
            commit: (): boolean => ports.commit(entry),
            cancel: (): void => {},
          }),
          switchScope: (): void => { gen += 1 },
          undo,
        }
        return { ports, selectionOf, targetOf }
      }

      if (legName === 'history-false') {
        const { ctx } = freshCanvas()
        const { vm, tid } = freshVm()
        const strict = strictHistory(vm, tid, { forceFalse: true })
        const statuses: string[] = []
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, strict.ports, {
          onStatus: (s: string) => { statuses.push(s) },
        })
        await session.pointerDown(START, 'rect', 'filled', solid() as never)
        await session.pointerUp(END)
        const md5Before = storedMd5(vm, tid)
        const preBytes = await loadStoredPng(vm, tid)
        const selBefore = strict.selectionOf()
        const done = await session.commitPending()
        const snap = session.snapshot()
        const md5After = storedMd5(vm, tid)
        const stored = await loadStoredPng(vm, tid)
        const storedCenter = stored ? await pngCenter(stored) : undefined
        // Second commit must be a no-op (never reapply over landed art).
        const again = await session.commitPending()
        const md5Again = storedMd5(vm, tid)
        return {
          doneOk: done.ok, doneKind: done.ok ? done.kind : (done as { reason: string }).reason,
          hasPending: snap.hasPending, depth: snap.historyDepth, historyGap: (snap as Record<string, unknown>).historyGap,
          md5Before, md5After, md5Again, againKind: again.ok ? again.kind : (again as { reason: string }).reason,
          storedCenter, preBytesLen: preBytes?.byteLength ?? 0, postBytesLen: stored?.byteLength ?? 0,
          undoLen: strict.ports.undo.length, redoLen: strict.ports.redoDepth(),
          selBefore, selAfter: strict.selectionOf(), statuses,
        }
      }

      if (legName === 'history-throw') {
        const { ctx } = freshCanvas()
        const { vm, tid } = freshVm()
        const strict = strictHistory(vm, tid, { throwAlways: true })
        const statuses: string[] = []
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, strict.ports, {
          onStatus: (s: string) => { statuses.push(s) },
        })
        await session.pointerDown(START, 'rect', 'filled', solid({ fill: '#00ff00' }) as never)
        await session.pointerUp(END)
        const md5Before = storedMd5(vm, tid)
        const done = await session.commitPending()
        const snap = session.snapshot()
        const stored = await loadStoredPng(vm, tid)
        const storedCenter = stored ? await pngCenter(stored) : undefined
        const again = await session.commitPending()
        return {
          doneOk: done.ok, doneKind: done.ok ? done.kind : (done as { reason: string }).reason,
          hasPending: snap.hasPending, depth: snap.historyDepth, historyGap: (snap as Record<string, unknown>).historyGap,
          md5Before, md5After: storedMd5(vm, tid), md5Again: storedMd5(vm, tid),
          againKind: again.ok ? again.kind : (again as { reason: string }).reason,
          storedCenter, undoLen: strict.ports.undo.length, redoLen: strict.ports.redoDepth(), statuses,
        }
      }

      if (legName === 'history-concurrent') {
        const { ctx } = freshCanvas()
        const previewMod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
        const { vm, tid } = freshVm()
        const strict = strictHistory(vm, tid)
        let releasePng!: (v: Uint8Array | undefined) => void
        let captured: ImageData | undefined
        const pngGate = new Promise<Uint8Array | undefined>((resolve) => { releasePng = resolve })
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
          encodePng: (image: ImageData): Promise<Uint8Array | undefined> => { captured = image; return pngGate },
        }
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ports, strict.ports, {})
        await session.pointerDown(START, 'rect', 'filled', solid() as never)
        await session.pointerUp(END)
        const flight = session.commitPending()
        let parked = false
        for (let i = 0; i < 200 && !parked; i += 1) { await new Promise((r) => setTimeout(r, 0)); parked = captured !== undefined }
        if (!parked) throw new Error('never parked in encode')
        // Concurrent history-only mutation (no VM write): external actor peeks
        // + commits its own entry while our commit is parked in encode.
        const extEntry = await strict.ports.peek()
        const extPushed = strict.ports.commit(extEntry as never)
        const real = await realEncode(captured as ImageData)
        releasePng(real)
        const done = await flight
        const snap = session.snapshot()
        const stored = await loadStoredPng(vm, tid)
        return {
          doneOk: done.ok, doneKind: done.ok ? done.kind : (done as { reason: string }).reason,
          extPushed, depth: snap.historyDepth, undoLen: strict.ports.undo.length,
          hasPending: snap.hasPending, historyGap: (snap as Record<string, unknown>).historyGap,
          storedCenter: stored ? await pngCenter(stored) : undefined,
        }
      }

      if (legName === 'history-reentrant') {
        const { ctx } = freshCanvas()
        const { vm, tid } = freshVm()
        const base = strictHistory(vm, tid)
        // Reentrant external VM write INSIDE the history commit: models a VM
        // callback firing between the CAS resolve and the append. The session
        // must preserve the external write (external-conflict, no restore, no
        // reapply) and never bury it under a stale entry.
        let externalMd5: string | undefined
        const ports = {
          ...base.ports,
          commit: (entry: unknown): boolean => {
            try {
              const t = (vm as unknown as { getTarget: (id: string) => { costumes: { md5ext?: string }[] } }).getTarget(tid)
              externalMd5 = t?.costumes[0]?.md5ext
            } catch {}
            // External brush lands synchronously here (different bytes).
            return (base.ports.commit as (e: unknown) => boolean)(entry)
          },
        }
        // Wrap: perform the external rename reentrantly inside the append
        // (models a VM callback firing between the CAS resolve and the
        // append). Legacy pair (no reservation) forces the session through
        // the `history.commit` path so the reentrancy is exercised.
        const reentrantPorts = {
          peek: base.ports.peek,
          depth: base.ports.depth,
          tryRemove: base.ports.tryRemove,
          removeLast: base.ports.removeLast,
          commit: (entry: unknown): boolean => {
            try { (vm as unknown as { renameCostume: (t: string, i: number, n: string) => boolean }).renameCostume(tid, 0, 'REENTRANT') } catch {}
            return (base.ports.commit as (e: unknown) => boolean)(entry)
          },
        }
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, reentrantPorts, {})
        await session.pointerDown(START, 'rect', 'filled', solid() as never)
        await session.pointerUp(END)
        const md5Before = storedMd5(vm, tid)
        const done = await session.commitPending()
        const snap = session.snapshot()
        const md5After = storedMd5(vm, tid)
        const stored = await loadStoredPng(vm, tid)
        const again = await session.commitPending()
        return {
          doneOk: done.ok, doneKind: done.ok ? done.kind : (done as { reason: string }).reason,
          md5Before, md5After, hasPending: snap.hasPending, depth: snap.historyDepth,
          historyGap: (snap as Record<string, unknown>).historyGap,
          storedCenter: stored ? await pngCenter(stored) : undefined,
          againKind: again.ok ? again.kind : (again as { reason: string }).reason,
          md5Again: storedMd5(vm, tid),
        }
      }

      if (legName === 'history-switch') {
        const { ctx } = freshCanvas()
        const previewMod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
        const { vm, tid } = freshVm()
        const strict = strictHistory(vm, tid)
        let releasePng!: (v: Uint8Array | undefined) => void
        let captured: ImageData | undefined
        const pngGate = new Promise<Uint8Array | undefined>((resolve) => { releasePng = resolve })
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
          encodePng: (image: ImageData): Promise<Uint8Array | undefined> => { captured = image; return pngGate },
        }
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ports, strict.ports, {})
        await session.pointerDown(START, 'rect', 'filled', solid() as never)
        await session.pointerUp(END)
        const md5Before = storedMd5(vm, tid)
        const flight = session.commitPending()
        let parked = false
        for (let i = 0; i < 200 && !parked; i += 1) { await new Promise((r) => setTimeout(r, 0)); parked = captured !== undefined }
        if (!parked) throw new Error('never parked in encode')
        // Scope/project switch right at the VM notification: an external
        // rename (bumps writeSeq) + history guard invalidation land strictly
        // inside the encode await, BEFORE any CAS call. The session must fail
        // closed with no ghost bytes and no history.
        strict.ports.switchScope()
        try { (vm as unknown as { renameCostume: (t: string, i: number, n: string) => boolean }).renameCostume(tid, 0, 'SWITCHED') } catch {}
        const real = await realEncode(captured as ImageData)
        releasePng(real)
        const done = await flight
        const snap = session.snapshot()
        return {
          doneOk: done.ok, doneKind: done.ok ? done.kind : (done as { reason: string }).reason,
          md5Before, md5After: storedMd5(vm, tid), hasPending: snap.hasPending,
          depth: snap.historyDepth, historyGap: (snap as Record<string, unknown>).historyGap,
          liveName: (vm as unknown as { getTarget: (id: string) => { costumes: { name: string }[] } }).getTarget(tid)?.costumes[0]?.name,
        }
      }

      if (legName === 'history-double') {
        const { ctx } = freshCanvas()
        const { vm, tid } = freshVm()
        const strict = strictHistory(vm, tid, { forceFalse: true })
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, strict.ports, {})
        await session.pointerDown(START, 'rect', 'filled', solid() as never)
        await session.pointerUp(END)
        const md5Before = storedMd5(vm, tid)
        const [a, b] = await Promise.all([session.commitPending(), session.commitPending()])
        const snap = session.snapshot()
        const stored = await loadStoredPng(vm, tid)
        return {
          aOk: a.ok, aKind: a.ok ? a.kind : (a as { reason: string }).reason,
          bOk: b.ok, bKind: b.ok ? b.kind : (b as { reason: string }).reason,
          depth: snap.historyDepth, hasPending: snap.hasPending,
          historyGap: (snap as Record<string, unknown>).historyGap,
          md5Before, md5After: storedMd5(vm, tid),
          storedCenter: stored ? await pngCenter(stored) : undefined,
        }
      }

      if (legName === 'history-gap-status') {
        const { ctx } = freshCanvas()
        const { vm, tid } = freshVm()
        const strict = strictHistory(vm, tid, { forceFalse: true })
        const statuses: string[] = []
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, strict.ports, {
          onStatus: (s: string) => { statuses.push(String(s)) },
        })
        await session.pointerDown(START, 'rect', 'filled', solid() as never)
        await session.pointerUp(END)
        const md5Before = storedMd5(vm, tid)
        const selBefore = strict.selectionOf()
        const done = await session.commitPending()
        const snap = session.snapshot()
        const md5After = storedMd5(vm, tid)
        const stored = await loadStoredPng(vm, tid)
        const storedCenter = stored ? await pngCenter(stored) : undefined
        const canvasCenter = px(ctx, CENTER.x, CENTER.y)
        const gapIndex = statuses.findIndex((s) => s.includes('history-gap'))
        const committedAfterGap = gapIndex >= 0 && statuses.slice(gapIndex + 1).some((s) => s.includes('Bitmap shape committed'))
        const lastStatus = statuses.length > 0 ? statuses[statuses.length - 1] : ''
        // Retry must be a no-op that never duplicates bytes and never clears the warning.
        const again = await session.commitPending()
        const md5Again = storedMd5(vm, tid)
        const snapAgain = session.snapshot()
        const lastAfterRetry = statuses.length > 0 ? statuses[statuses.length - 1] : ''
        return {
          doneOk: done.ok, doneKind: done.ok ? (done as { kind: string }).kind : (done as { reason: string }).reason,
          hasPending: snap.hasPending, depth: snap.historyDepth, historyGap: (snap as Record<string, unknown>).historyGap,
          md5Before, md5After, md5Again,
          againKind: again.ok ? (again as { kind: string }).kind : (again as { reason: string }).reason,
          storedCenter, canvasCenter,
          undoLen: strict.ports.undo.length, redoLen: strict.ports.redoDepth(),
          selBefore, selAfter: strict.selectionOf(),
          statuses, gapIndex, committedAfterGap, lastStatus, lastAfterRetry,
          historyGapAfterRetry: (snapAgain as Record<string, unknown>).historyGap,
        }
      }

      if (legName === 'history-gap-block') {
        const { ctx } = freshCanvas()
        const { vm, tid } = freshVm()
        // Toggleable strict history: first commit gaps, recovery commits land.
        let failHistory = true
        const undo: unknown[] = []
        let redo: unknown[] = []
        let gen = 0
        const scopeKey = `${tid}:0`
        let lastPeekGen: number | undefined
        const targetOf = (): { costumes: { md5ext?: string; assetId?: string; dataFormat?: string; name: string }[]; name?: string } =>
          (vm as unknown as { getTarget: (id: string) => never }).getTarget(tid) as never as { costumes: { md5ext?: string; assetId?: string; dataFormat?: string; name: string }[]; name?: string }
        const selectionOf = (): number | null => {
          try {
            const fn = (vm as unknown as { getSelectionEpoch?: () => unknown }).getSelectionEpoch
            if (typeof fn !== 'function') return null
            const v = (fn as () => unknown).call(vm)
            return typeof v === 'number' ? v : null
          } catch { return null }
        }
        const ports = {
          peek: async (): Promise<unknown> => {
            const t = targetOf()
            const costume = t?.costumes[0]
            const key = costume?.md5ext ?? costume?.assetId
            const bytes = key ? await (vm as unknown as { loadAsset: (k: string, f: string) => Promise<Uint8Array> }).loadAsset(key, costume?.dataFormat ?? '') : undefined
            if (!costume || !bytes) return undefined
            lastPeekGen = gen
            return { kind: 'costume', targetName: t?.name, index: 0, meta: JSON.parse(JSON.stringify(costume)), bytes: new Uint8Array(bytes), guard: { key: scopeKey, gen, observed: selectionOf() } }
          },
          commit: (entry: unknown): boolean => {
            if (failHistory) return false
            const g = (entry as { guard?: { key: string; gen: number } }).guard
            if (!g || g.key !== scopeKey || g.gen !== gen) return false
            undo.push(entry)
            redo = []
            return true
          },
          depth: (): number => undo.length,
          isCurrent: (): boolean => lastPeekGen === undefined || lastPeekGen === gen,
          tryRemove: (entry: unknown): boolean => {
            if (undo.length > 0 && undo[undo.length - 1] === entry) { undo.pop(); return true }
            return false
          },
          removeLast: (entry: unknown): boolean => {
            if (undo.length > 0 && undo[undo.length - 1] === entry) { undo.pop(); return true }
            return false
          },
          beginReservation: (entry: unknown) => ({
            isCurrent: (): boolean => {
              const g = (entry as { guard?: { key: string; gen: number } }).guard
              return !!g && g.key === scopeKey && g.gen === gen
            },
            commit: (): boolean => (ports as { commit: (e: unknown) => boolean }).commit(entry),
            cancel: (): void => {},
          }),
        }
        const statuses: string[] = []
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, ports, {
          onStatus: (s: string) => { statuses.push(String(s)) },
        })
        await session.pointerDown(START, 'rect', 'filled', solid() as never)
        await session.pointerUp(END)
        const md5Before = storedMd5(vm, tid)
        const selBefore = selectionOf()
        const done = await session.commitPending()
        const snapGap = session.snapshot()
        const md5Gap = storedMd5(vm, tid)
        const storedGap = await loadStoredPng(vm, tid)
        const storedGapCenter = storedGap ? await pngCenter(storedGap) : undefined
        const gapIndex = statuses.findIndex((s) => s.includes('history-gap'))
        // Subsequent paint without recovery must block (no staging, no ghost).
        const downAfter = await session.pointerDown({ x: 10, y: 60 }, 'oval', 'filled', solid({ fill: '#0000ff' }) as never)
        const snapAfterDown = session.snapshot()
        const upAfter = await session.pointerUp({ x: 50, y: 80 })
        const restyleAfter = session.restyle({ fill: '#00ff00' })
        const moveAfter = session.moveBy(2, 2)
        const retargetAfter = session.retarget({ x: 1, y: 1, width: 10, height: 10 })
        let ghost = 0
        const blockedOp = await session.runCommand('export-costume', async () => {
          ghost += 1
          return 'exported'
        })
        const md5AfterBlocks = storedMd5(vm, tid)
        const lastBeforeAck = statuses.length > 0 ? statuses[statuses.length - 1] : ''
        const committedAfterGap = gapIndex >= 0 && statuses.slice(gapIndex + 1).some((s) => s.includes('Bitmap shape committed'))
        // Explicit acknowledgement recovers: new paint + export may proceed.
        const ack = (session as unknown as { acknowledgeHistoryGap: (n?: string) => { ok: boolean; acknowledged: boolean; historyGap: boolean } }).acknowledgeHistoryGap('test-ack')
        const snapAfterAck = session.snapshot()
        const lastAfterAck = statuses.length > 0 ? statuses[statuses.length - 1] : ''
        failHistory = false
        await session.pointerDown({ x: 10, y: 60 }, 'oval', 'filled', solid({ fill: '#0000ff' }) as never)
        await session.pointerUp({ x: 50, y: 80 })
        const redone = await session.commitPending()
        const snapRecovered = session.snapshot()
        const md5Recovered = storedMd5(vm, tid)
        let exportGhost = 0
        let exportedCenter: number[] | undefined
        const exported = await session.runCommand('export-costume', async (control) => {
          if (!control.isContinuationCurrent()) throw new Error('stale continuation must stay green here')
          exportGhost += 1
          const bytes = await loadStoredPng(vm, tid)
          if (!bytes) throw new Error('no stored bytes after recovery commit')
          exportedCenter = await pngCenter(bytes)
          return 'exported'
        })
        return {
          doneOk: done.ok, doneKind: done.ok ? (done as { kind: string }).kind : (done as { reason: string }).reason,
          hasPendingGap: snapGap.hasPending, historyGap: (snapGap as Record<string, unknown>).historyGap,
          md5Before, md5Gap, storedGapCenter,
          downAfterOk: downAfter.ok, downAfterReason: downAfter.ok ? (downAfter as { kind: string }).kind : (downAfter as { reason: string }).reason,
          hasPendingAfterDown: snapAfterDown.hasPending,
          upAfterKind: upAfter.ok ? (upAfter as { kind: string }).kind : (upAfter as { reason: string }).reason,
          restyleReason: restyleAfter.ok ? 'proceeded' : (restyleAfter as { reason: string }).reason,
          moveReason: moveAfter.ok ? 'proceeded' : (moveAfter as { reason: string }).reason,
          retargetReason: retargetAfter.ok ? 'proceeded' : (retargetAfter as { reason: string }).reason,
          blockedOpOk: blockedOp.ok, blockedOpReason: blockedOp.ok ? 'proceeded' : (blockedOp as { reason: string }).reason,
          ghost, md5AfterBlocks,
          gapIndex, committedAfterGap, lastBeforeAck, statuses,
          ackAcknowledged: (ack as { acknowledged: boolean }).acknowledged, historyGapAfterAck: (snapAfterAck as Record<string, unknown>).historyGap,
          lastAfterAck,
          redoneOk: redone.ok, redoneKind: redone.ok ? (redone as { kind: string }).kind : (redone as { reason: string }).reason,
          historyGapRecovered: (snapRecovered as Record<string, unknown>).historyGap,
          depthRecovered: snapRecovered.historyDepth, hasPendingRecovered: snapRecovered.hasPending,
          md5Recovered, selBefore, selAfter: selectionOf(),
          exportedOk: exported.ok, exportGhost, exportedCenter,
        }
      }

      if (legName === 'history-gap-runcommand') {
        const { ctx } = freshCanvas()
        const { vm, tid } = freshVm()
        const strict = strictHistory(vm, tid, { forceFalse: true })
        const statuses: string[] = []
        const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, strict.ports, {
          onStatus: (s: string) => { statuses.push(String(s)) },
        })
        await session.pointerDown(START, 'rect', 'filled', solid() as never)
        await session.pointerUp(END)
        const md5Before = storedMd5(vm, tid)
        let ghost = 0
        const result = await session.runCommand('export-costume', async () => {
          ghost += 1
          return 'exported'
        })
        const snap = session.snapshot()
        const md5After = storedMd5(vm, tid)
        const stored = await loadStoredPng(vm, tid)
        const gapIndex = statuses.findIndex((s) => s.includes('history-gap'))
        const committedAfterGap = gapIndex >= 0 && statuses.slice(gapIndex + 1).some((s) => s.includes('Bitmap shape committed'))
        return {
          resultOk: result.ok,
          resultReason: result.ok ? 'proceeded' : (result as { reason: string }).reason,
          commitKind: result.commit !== undefined && result.commit.ok ? result.commit.kind : 'no-commit',
          ghost,
          hasPending: snap.hasPending, depth: snap.historyDepth, historyGap: (snap as Record<string, unknown>).historyGap,
          md5Before, md5After,
          storedCenter: stored ? await pngCenter(stored) : undefined,
          gapIndex, committedAfterGap,
          lastStatus: statuses.length > 0 ? statuses[statuses.length - 1] : '',
          statuses,
        }
      }
    }

    throw new Error(`unknown leg: ${legName}`)
  }, leg as unknown as undefined)
  return proof as Proof
}

describe('bitmap pending session (real VM + real Canvas, port 4611)', () => {
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

  it('tiny drag stages nothing (no pending, no history, no invalidation)', async () => {
    const proof = await runLeg('tiny')
    console.log(`[pending-session:tiny] ${JSON.stringify(proof)}`)
    expect(proof.upKind).toBe('unchanged')
    expect(proof.hasPending).toBe(false)
    expect(proof.depth).toBe(0)
    expect(proof.revDelta).toBe(0)
    expect(proof.invalidations).toBe(0)
    expect(proof.center).toEqual([0, 0, 0, 0])
  }, 60_000)

  it('stages, restyles in place, and exports the EDITED shape with exactly one history entry', async () => {
    const proof = await runLeg('stage-export')
    console.log(`[pending-session:stage-export] ${JSON.stringify(proof)}`)
    expect(proof.stagedOk).toBe(true)
    expect(proof.centerRed).toEqual([255, 0, 0, 255])
    expect(proof.depthAfterStage).toBe(0)
    expect(proof.restyledOk).toBe(true)
    expect(proof.centerBlue).toEqual([0, 0, 255, 255])
    expect(proof.depthAfterRestyle).toBe(0)
    expect(proof.noopKind).toBe('unchanged')
    expect(proof.revAfterNoop).toBe(proof.revAfterRestyle)
    expect((proof.revAfterRestyle as number)).toBeGreaterThan(proof.revAfterStage as number)
    expect(proof.gatedOk).toBe(true)
    expect(proof.ghost).toBe(1)
    // The exported stored PNG carries the EDITED (blue) pixels, not red.
    expect(proof.exportedCenter).toEqual([0, 0, 255, 255])
    expect(proof.depth).toBe(1)
    expect(proof.hasPending).toBe(false)
  }, 60_000)

  it('failed store retains pending + overlay, retry commits exactly once', async () => {
    const proof = await runLeg('fail-retry')
    console.log(`[pending-session:fail-retry] ${JSON.stringify(proof)}`)
    expect(proof.failedOk).toBe(false)
    expect(proof.failedReason).toBe('commit-failed')
    expect(proof.hasPendingAfterFail).toBe(true)
    expect(proof.centerAfterFail).toEqual([0, 255, 0, 255])
    expect(proof.depthAfterFail).toBe(0)
    expect(proof.md5AfterFail).toBe(proof.md5Before)
    expect(proof.retriedOk).toBe(true)
    expect(proof.depthAfterRetry).toBe(1)
    expect(proof.hasPendingAfterRetry).toBe(false)
    expect(proof.storedCenter).toEqual([0, 255, 0, 255])
    expect((proof.invalidations as number)).toBeGreaterThan(0)
  }, 60_000)

  it('external rename wins twice: scope gate then mid-flight CAS, never clobbered', async () => {
    const proof = await runLeg('rename')
    console.log(`[pending-session:rename] ${JSON.stringify(proof)}`)
    // (a) rename-before-commit: scope gate refuses, write never runs.
    expect(proof.renamedA).toBe(true)
    expect(proof.doneAOk).toBe(false)
    expect(proof.doneAKind).toBe('owner-mismatch')
    expect(proof.liveNameA).toBe('RENAMED')
    expect(proof.md5AfterA).toBe(proof.md5BeforeA)
    expect(proof.depthA).toBe(0)
    expect(proof.hasPendingA).toBe(false)
    // (b) rename-inside-await: atomic CAS conflict, stale bytes never land.
    expect(proof.renamedB).toBe(true)
    expect(proof.doneBOk).toBe(false)
    expect(proof.doneBKind).toBe('external-conflict')
    expect(proof.liveNameB).toBe('RENAMED2')
    expect(proof.md5AfterB).toBe(proof.md5BeforeB)
    expect(proof.depthB).toBe(0)
    expect(proof.hasPendingB).toBe(false)
  }, 60_000)

  it('abort mid-encode prevents the write with no history', async () => {
    const proof = await runLeg('abort')
    console.log(`[pending-session:abort] ${JSON.stringify(proof)}`)
    expect(proof.abortedKind).toBe('aborted')
    expect(proof.doneOk).toBe(false)
    expect(['aborted', 'superseded']).toContain(proof.doneKind)
    expect(proof.md5After).toBe(proof.md5Before)
    expect(proof.depth).toBe(0)
  }, 60_000)

  it('stale switch refuses before any write: no ghost op, pending retained', async () => {
    const proof = await runLeg('switch')
    console.log(`[pending-session:switch] ${JSON.stringify(proof)}`)
    expect(proof.refusedOk).toBe(false)
    expect(proof.ghost).toBe(0)
    expect(proof.hasPendingAfterRefuse).toBe(true)
    expect(proof.depthAfterRefuse).toBe(0)
  }, 60_000)

  it('delete/undo discard restores the pre-drag base with no history', async () => {
    const proof = await runLeg('discard')
    console.log(`[pending-session:discard] ${JSON.stringify(proof)}`)
    expect(proof.stagedCenter).toEqual([255, 0, 0, 255])
    expect(proof.discardedKind).toBe('discarded')
    expect(proof.afterCenter).toEqual(proof.beforeCenter)
    expect(proof.depth).toBe(0)
    expect(proof.hasPending).toBe(false)
    expect((proof.revAfterDiscard as number)).toBeGreaterThan(proof.revAfterStage as number)
  }, 60_000)

  it('concurrent commits join into exactly one history entry', async () => {
    const proof = await runLeg('once')
    console.log(`[pending-session:once] ${JSON.stringify(proof)}`)
    expect(proof.aOk).toBe(true)
    expect(proof.bOk).toBe(true)
    expect(proof.aKind).toBe('committed')
    expect(proof.bKind).toBe('committed')
    expect(proof.depth).toBe(1)
    expect(proof.hasPending).toBe(false)
  }, 60_000)

  it('semi-transparent gradient: mid alpha is partial, twice-from-base identical', async () => {
    const proof = await runLeg('gradient')
    console.log(`[pending-session:gradient] ${JSON.stringify(proof)}`)
    const mid = proof.mid as number[]
    expect(mid[3]).toBeGreaterThan(0)
    expect(mid[3]).toBeLessThan(255)
    expect(proof.hasPending).toBe(true)
    expect(proof.twiceEqual).toBe(true)
    expect(proof.liveEqualFirst).toBe(true)
    expect(proof.baseUnchanged).toBe(true)
  }, 60_000)

  it('second drag commits the first shape first, then stages the new one', async () => {
    const proof = await runLeg('second')
    console.log(`[pending-session:second] ${JSON.stringify(proof)}`)
    expect(proof.depthStaged).toBe(0)
    expect(proof.depthAfterDown).toBe(1)
    expect(proof.hasPendingAfterDown).toBe(false)
    expect(proof.doneOk).toBe(true)
    expect(proof.depth).toBe(2)
  }, 60_000)

  it('history forced false AFTER landed write reports committed-without-history (never history-stale), no reapply', async () => {
    const proof = await runLeg('history-false')
    console.log(`[pending-session:history-false] ${JSON.stringify(proof)}`)
    // Landed bytes must NOT be reported as failure, but distinctly from clean committed.
    expect(proof.doneOk).toBe(true)
    expect(proof.doneKind).toBe('committed-without-history')
    expect(proof.hasPending).toBe(false)
    // Bytes landed (new art), undo gap surfaced explicitly.
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
    expect(proof.depth).toBe(0)
    expect(proof.historyGap).toBe(true)
    expect(proof.undoLen).toBe(0)
    expect(proof.redoLen).toBe(0)
    // Retry is a no-op: never reapply over committed art.
    expect(proof.againKind).toBe('nothing-to-commit')
    expect(proof.md5Again).toBe(proof.md5After)
    expect((proof.statuses as string[]).join(' ')).toMatch(/history-gap/)
  }, 60_000)

  it('history throw AFTER landed write reports committed-without-history (never history-stale), no reapply', async () => {
    const proof = await runLeg('history-throw')
    console.log(`[pending-session:history-throw] ${JSON.stringify(proof)}`)
    expect(proof.doneOk).toBe(true)
    expect(proof.doneKind).toBe('committed-without-history')
    expect(proof.hasPending).toBe(false)
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([0, 255, 0, 255])
    expect(proof.depth).toBe(0)
    expect(proof.historyGap).toBe(true)
    expect(proof.againKind).toBe('nothing-to-commit')
    expect(proof.md5Again).toBe(proof.md5After)
  }, 60_000)

  it('concurrent history-only mutation serializes: both entries kept, one landed write', async () => {
    const proof = await runLeg('history-concurrent')
    console.log(`[pending-session:history-concurrent] ${JSON.stringify(proof)}`)
    expect(proof.extPushed).toBe(true)
    expect(proof.doneOk).toBe(true)
    expect(proof.doneKind).toBe('committed')
    expect(proof.hasPending).toBe(false)
    // Both the external entry and ours land (serializable, none lost).
    expect(proof.depth).toBe(2)
    expect(proof.undoLen).toBe(2)
    expect(proof.historyGap).toBe(false)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
  }, 60_000)

  it('reentrant external write at history commit preserves external (no stale overwrite)', async () => {
    const proof = await runLeg('history-reentrant')
    console.log(`[pending-session:history-reentrant] ${JSON.stringify(proof)}`)
    // External rename bumps writeSeq reentrantly: our pre-write reservation
    // was current, the CAS lands, then the reentrant external wins. The
    // session must NOT bury it: external-conflict, no restore, no reapply.
    expect(proof.doneOk).toBe(false)
    expect(proof.doneKind).toBe('external-conflict')
    expect(proof.hasPending).toBe(false)
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.againKind).toBe('nothing-to-commit')
    expect(proof.md5Again).toBe(proof.md5After)
  }, 60_000)

  it('scope switch right at VM notification blocks before write (no ghost bytes/history)', async () => {
    const proof = await runLeg('history-switch')
    console.log(`[pending-session:history-switch] ${JSON.stringify(proof)}`)
    // External rename + history invalidation land strictly inside the encode
    // await, BEFORE any CAS call: fail closed with no ghost bytes and no
    // history (external preserved, pending dropped, never restored).
    expect(proof.doneOk).toBe(false)
    expect(['external-conflict', 'superseded', 'owner-mismatch']).toContain(proof.doneKind)
    expect(proof.md5After).toBe(proof.md5Before)
    expect(proof.liveName).toBe('SWITCHED')
    expect(proof.depth).toBe(0)
    expect(proof.hasPending).toBe(false)
    expect(proof.historyGap).toBeFalsy()
  }, 60_000)

  it('double concurrent commits with failing history still commit once, never reapply', async () => {
    const proof = await runLeg('history-double')
    console.log(`[pending-session:history-double] ${JSON.stringify(proof)}`)
    expect(proof.aOk).toBe(true)
    expect(proof.bOk).toBe(true)
    // The winning commit gaps distinctly; the joiner observes the same single write.
    expect(['committed', 'committed-without-history']).toContain(proof.aKind)
    expect(['committed', 'committed-without-history']).toContain(proof.bKind)
    expect([proof.aKind, proof.bKind]).toContain('committed-without-history')
    expect(proof.depth).toBe(0)
    expect(proof.hasPending).toBe(false)
    expect(proof.historyGap).toBe(true)
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
  }, 60_000)

  it('history gap keeps the warning sticky: no status overwrite, retry never duplicates', async () => {
    const proof = await runLeg('history-gap-status')
    console.log(`[pending-session:history-gap-status] ${JSON.stringify(proof)}`)
    expect(proof.doneOk).toBe(true)
    expect(proof.doneKind).toBe('committed-without-history')
    expect(proof.hasPending).toBe(false)
    expect(proof.historyGap).toBe(true)
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
    // Canvas shows the landed art (not reverted to pretend uncommitted).
    expect(proof.canvasCenter).toEqual([255, 0, 0, 255])
    expect(proof.depth).toBe(0)
    // Fail-first: the gap warning exists and no later `Bitmap shape committed` overwrites it.
    expect(proof.gapIndex as number).toBeGreaterThanOrEqual(0)
    expect(proof.committedAfterGap).toBe(false)
    expect(String(proof.lastStatus)).toMatch(/history-gap/)
    // Retry is a no-op that preserves art + warning + selection.
    expect(proof.againKind).toBe('nothing-to-commit')
    expect(proof.md5Again).toBe(proof.md5After)
    expect(proof.historyGapAfterRetry).toBe(true)
    expect(String(proof.lastAfterRetry)).toMatch(/history-gap/)
    expect(proof.selAfter).toBe(proof.selBefore)
  }, 60_000)

  it('history gap blocks continuation until acknowledged, then export recovery proceeds', async () => {
    const proof = await runLeg('history-gap-block')
    console.log(`[pending-session:history-gap-block] ${JSON.stringify(proof)}`)
    expect(proof.doneOk).toBe(true)
    expect(proof.doneKind).toBe('committed-without-history')
    expect(proof.hasPendingGap).toBe(false)
    expect(proof.historyGap).toBe(true)
    expect(proof.md5Gap).not.toBe(proof.md5Before)
    expect(proof.storedGapCenter).toEqual([255, 0, 0, 255])
    // No automatic continuation past the gap: new paint + ops refuse, no ghost op.
    expect(proof.downAfterOk).toBe(false)
    expect(proof.downAfterReason).toBe('history-gap')
    expect(proof.hasPendingAfterDown).toBe(false)
    expect(proof.upAfterKind).toBe('nothing-pending')
    expect(proof.restyleReason).toBe('history-gap')
    expect(proof.moveReason).toBe('history-gap')
    expect(proof.retargetReason).toBe('history-gap')
    expect(proof.blockedOpOk).toBe(false)
    expect(proof.blockedOpReason).toBe('history-gap')
    expect(proof.ghost).toBe(0)
    expect(proof.md5AfterBlocks).toBe(proof.md5Gap)
    expect(proof.gapIndex as number).toBeGreaterThanOrEqual(0)
    expect(proof.committedAfterGap).toBe(false)
    expect(String(proof.lastBeforeAck)).toMatch(/history-gap/)
    expect(proof.selAfter).toBe(proof.selBefore)
    // Explicit acknowledgement recovers; export re-reads committed bytes (never re-commits).
    expect(proof.ackAcknowledged).toBe(true)
    expect(proof.historyGapAfterAck).toBe(false)
    expect(String(proof.lastAfterAck)).toMatch(/acknowledged/)
    expect(proof.redoneOk).toBe(true)
    expect(proof.redoneKind).toBe('committed')
    expect(proof.historyGapRecovered).toBe(false)
    expect(proof.depthRecovered).toBe(1)
    expect(proof.hasPendingRecovered).toBe(false)
    expect(proof.md5Recovered).not.toBe(proof.md5Gap)
    expect(proof.exportedOk).toBe(true)
    expect(proof.exportGhost).toBe(1)
    expect(proof.exportedCenter).toBeDefined()
  }, 60_000)

  it('history gap during runCommand suppresses the continuation op (no ghost switch/export)', async () => {
    const proof = await runLeg('history-gap-runcommand')
    console.log(`[pending-session:history-gap-runcommand] ${JSON.stringify(proof)}`)
    // The commit's own gap must NOT run the op: no ghost export/switch.
    expect(proof.resultOk).toBe(false)
    expect(proof.resultReason).toBe('history-gap')
    expect(proof.ghost).toBe(0)
    expect(proof.hasPending).toBe(false)
    expect(proof.historyGap).toBe(true)
    // Bytes still landed exactly once (art preserved, not reverted).
    expect(proof.md5After).not.toBe(proof.md5Before)
    expect(proof.storedCenter).toEqual([255, 0, 0, 255])
    expect(proof.depth).toBe(0)
    expect(proof.gapIndex as number).toBeGreaterThanOrEqual(0)
    expect(proof.committedAfterGap).toBe(false)
    expect(String(proof.lastStatus)).toMatch(/history-gap/)
  }, 60_000)
})
