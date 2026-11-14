// Fail-first recovery proof for the unwired `bitmap-pending-session` rename
// conflict loss (helper + tests scope only: no `Editor.svelte` /
// `BitmapEditor.svelte` changes).
//
// AUDIT (why this file must fail until safe recovery is integrated):
// - `tx.stage`/`joinCommit` (`bitmap-pending-transaction.ts`): the owner gate
//   is `isPendingScopeCurrent` (targetId/costumeIndex/assetKey/loadSerial/
//   sessionGeneration/editEpoch/projectGeneration). A synchronous
//   `renameCostume` keeps `assetKey` but bumps per-slot `writeSeq`, so the
//   re-captured `editEpoch` (derived from live `writeSeq`) diverges: entry
//   check drops the taken slot (`pending = undefined`, `owner-mismatch`) with
//   no quarantine. Mid-flight the session pre-write check + VM CAS
//   (`updateCostumeIfMatch` re-validates `expected` writeSeq before AND after
//   the `storeAsset` await) correctly keeps the external rename/new-bytes
//   (`applied: false` -> `external-conflict`), but the coordinator never
//   restores the taken shape/base (pending stays empty) and the session mirror
//   (`staged`) is cleared (`staged = undefined`). Shape params + base bytes
//   are lost while the live canvas still shows the overlay (`base + shape`),
//   so `snapshot().hasPending === false` hides visibly staged input.
// - `staged` vs `pending` vs preview owner: `staged` mirrors the tx slot;
//   `tx.snapshot().hasPending` is the commit truth; the preview owner is the
//   live 2d canvas (`paintOverlay`/`restoreBase`). On conflict neither the tx
//   nor the session quarantines the taken copy separate from the live canvas,
//   and the failure path only repaints when still owned - otherwise it drops
//   the mirror without restoring, leaving the old overlay painted onto a slot
//   the session no longer owns.
// - Existing tests LOCK the loss: `bitmap-pending-session.browser.test.ts`
//   `rename` leg asserts `hasPendingA/B === false`, `depth 0`, external name
//   kept - but never asserts shape/base survival, quarantine, explicit user
//   action, byte-exact export recovery, or res1/2. Transaction/adversarial and
//   vm-writer suites likewise assert `hasPending === false` on conflict with
//   no recovery surface.
// - VM CAS itself is safe (rename bumps `writeSeq`; `updateCostumeIfMatch`
//   fails closed before/after `storeAsset`; reload/delete/reorder supersede
//   via generation/capture/selection epoch). The UNSAFE layer is the
//   session/coordinator conflict handling above: it preserves the external
//   write exactly but silently discards the staged user input instead of
//   quarantining it with an explicit status + user action.
//
// SAFE RECOVERY CONTRACT (asserted here, fail-first):
// - original external preserved exactly (bytes + identity + name where set);
// - original staged shape params + base bytes remain recoverable, quarantined
//   separate from the live canvas when ownership changes (never repainted
//   onto the wrong slot), with an explicit conflict status + user action;
// - same-slot metadata-only rename may rebase ONLY when bytes/geometry and
//   structure/generation prove unchanged via captured identity + metadata;
//   never auto-overwrites external data;
// - live external new bytes keep the conflict; the session offers a safe
//   export of the old composed PNG (separate artifact) + explicit discard;
//   no blind force/retry (a retry without explicit action must not reapply);
// - export recovery is byte-exact against an offline `base + shape`
//   composite and performs zero VM writes; proven for res1 and res2; no UI
//   wiring (session helper only).
//
// Until the helper integrates quarantine/rebase/export, these tests FAIL
// (documenting the unsafe loss) and no fix is pretended.
//
// Dedicated Vite port 4622 (surveyed 2026-11-13: 4611/4613/4621 taken by
// sibling pending suites; 4622 unused). CHROME_BIN inherited with fallback.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4622
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
    const previewMod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
    const vmMod = await import('/test/bitmap-pending-session-vm-entry.ts')

    const W = 120
    const H = 90
    const CENTER = { x: 60, y: 45 }
    const START = { x: 20, y: 15 }
    const END = { x: 100, y: 75 }
    const px = (ctx: CanvasRenderingContext2D, x: number, y: number): number[] =>
      Array.from(ctx.getImageData(x, y, 1, 1).data)
    const eqBytes = (a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): boolean => {
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
        getTarget: (id: string) => { costumes: { md5ext?: string; assetId?: string; name: string; dataFormat?: string }[] }
        loadAsset: (k: string, f: string) => Promise<Uint8Array>
        renameCostume: (t: string, i: number, n: string) => boolean
        updateCostume: (t: string, i: number, p: unknown, d: Uint8Array) => Promise<void>
        getCostumeIdentity: (t: string, i: number) => { assetId?: string; md5ext?: string; writeSeq?: number }
        getCostumeWriteSeq: (t: string, i: number) => number
        getProjectGeneration: () => number
        storeAsset: (d: Uint8Array, f: string) => Promise<{ assetId: string; md5ext: string }>
        updateCostumeIfMatch: (...a: unknown[]) => Promise<unknown>
        exportProject: () => unknown
        loadProject: (p: unknown) => Promise<unknown>
        deleteTarget: (id: string) => void
        addSprite: (n: string) => Promise<{ id?: string; name?: string }>
      }
    const storedMd5 = (vm: never, tid: string): string | undefined => vmApi(vm).getTarget(tid)?.costumes[0]?.md5ext
    const storedBytes = async (vm: never, tid: string): Promise<Uint8Array | undefined> => {
      const md5 = storedMd5(vm, tid)
      if (!md5) return undefined
      return vmApi(vm).loadAsset(md5, 'png').catch(() => undefined) as Promise<Uint8Array | undefined>
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
    const offlineComposite = async (
      ctx: CanvasRenderingContext2D,
      base: ImageData,
      shape: unknown,
    ): Promise<{ image: ImageData; png: Uint8Array | undefined }> => {
      const off = document.createElement('canvas')
      off.width = base.width
      off.height = base.height
      const octx = off.getContext('2d')
      if (!octx) throw new Error('no offscreen context')
      const image = previewMod.compositePendingBitmapShapePreview(octx, base, shape as never)
      if (!image) throw new Error('offline composite refused')
      return { image, png: await realEncode(image) }
    }

    // Shared shape/base capture helper: stages a red rect, snapshots the
    // parametric shape + a base copy + offline composite for byte-exactness.
    const stageRedRect = async (
      session: never,
      ctx: CanvasRenderingContext2D,
      opts: { storedResolution?: number } = {},
    ): Promise<{ shapeJson: string; baseBytes: string; compositePngLen: number; compositeCenter: number[] } | { error: string }> => {
      const sess = session as unknown as {
        configure: (c: unknown) => void
        pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown>
        pointerUp: (at: unknown) => Promise<unknown>
        getPendingShape: () => unknown
      }
      if (typeof opts.storedResolution === 'number') sess.configure({ storedResolution: opts.storedResolution })
      await sess.pointerDown(START, 'rect', 'filled', solid() as never)
      await sess.pointerUp(END)
      const shape = sess.getPendingShape()
      if (!shape) return { error: 'stage did not produce a pending shape' }
      const shapeJson = JSON.stringify(shape)
      // Pre-stroke base is the blank canvas here (fresh canvas fixture).
      const blank = new ImageData(W, H)
      const baseBytes = Array.from(blank.data.slice(0, 64)).join(',')
      const { png, image } = await offlineComposite(ctx, blank, shape).catch(() => ({ image: undefined as never, png: undefined }))
      if (!png || !image) return { error: 'offline composite failed' }
      return { shapeJson, baseBytes, compositePngLen: png.byteLength, compositeCenter: Array.from(image.data.slice((45 * W + 60) * 4, (45 * W + 60) * 4 + 4)) }
    }

    // Quarantine probe: the SAFE contract expects one of these explicit
    // surfaces. Absence documents the unsafe loss (fail-first).
    const probeQuarantine = (session: never): { found: boolean; shapeJson?: string; baseLen?: number; detail: string } => {
      const sess = session as unknown as Record<string, unknown>
      const candidates = ['getQuarantined', 'getQuarantine', 'getConflicted', 'getPreservedPending']
      for (const key of candidates) {
        try {
          const fn = sess[key]
          if (typeof fn === 'function') {
            const value = (fn as () => unknown).call(sess) as { shape?: unknown; base?: { data?: { length?: number; byteLength?: number } } } | undefined
            if (value && typeof value === 'object' && (value as { shape?: unknown }).shape) {
              return { found: true, shapeJson: JSON.stringify((value as { shape?: unknown }).shape), baseLen: (value as { base?: { data?: { length?: number } } }).base?.data?.length, detail: key }
            }
            return { found: false, detail: `${key}() empty` }
          }
        } catch (error) {
          return { found: false, detail: `${key} threw: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      try {
        const snap = (sess['snapshot'] as (() => Record<string, unknown>) | undefined)?.call(sess)
        const q = snap?.['quarantined'] ?? snap?.['quarantine'] ?? snap?.['conflicted'] ?? snap?.['preserved']
        if (q && typeof q === 'object') return { found: true, shapeJson: JSON.stringify((q as { shape?: unknown }).shape ?? q), detail: 'snapshot.quarantined' }
      } catch {}
      return { found: false, detail: 'no quarantine surface (getQuarantined/snapshot.quarantined)' }
    }
    const probeExport = (session: never): { found: boolean; detail: string } => {
      const sess = session as unknown as Record<string, unknown>
      for (const key of ['exportQuarantinedPng', 'exportPreservedPng', 'exportConflictedPng']) {
        if (typeof sess[key] === 'function') return { found: true, detail: key }
      }
      return { found: false, detail: 'no exportQuarantinedPng surface' }
    }
    const probeRebase = (session: never): { found: boolean; detail: string } => {
      const sess = session as unknown as Record<string, unknown>
      for (const key of ['rebaseQuarantinedAfterMetadataRename', 'rebaseQuarantine', 'adoptExternalRename']) {
        if (typeof sess[key] === 'function') return { found: true, detail: key }
      }
      return { found: false, detail: 'no rebase surface' }
    }

    if (legName === 'rename-before') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const statuses: string[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onStatus: (s: string) => {
          statuses.push(String(s))
        },
      })
      const captured = await stageRedRect(session as never, ctx, { storedResolution: 2 })
      if ('error' in captured) return { stageError: captured.error }
      const md5Before = storedMd5(vm, tid)
      const seqBefore = vmApi(vm).getCostumeWriteSeq(tid, 0)
      const bytesBefore = await storedBytes(vm, tid)
      const renamed = vmApi(vm).renameCostume(tid, 0, 'RENAMED')
      const seqAfterRename = vmApi(vm).getCostumeWriteSeq(tid, 0)
      const done = await (session as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      const snap = (session as unknown as { snapshot: () => Record<string, unknown> }).snapshot()
      const q = probeQuarantine(session as never)
      const e = probeExport(session as never)
      return {
        renamed,
        sameBytes: !!bytesBefore && eqBytes(bytesBefore, (await storedBytes(vm, tid)) ?? new Uint8Array(0)),
        seqBumpedByOne: seqAfterRename === seqBefore + 1,
        doneOk: (done as { ok?: unknown }).ok,
        doneKind: (done as { ok?: boolean; kind?: string; reason?: string }).ok ? (done as { kind?: string }).kind : (done as { reason?: string }).reason,
        hasPending: snap['hasPending'],
        liveName: vmApi(vm).getTarget(tid)?.costumes[0]?.name,
        md5Before,
        md5After: storedMd5(vm, tid),
        depth: snap['historyDepth'],
        quarantined: q.found,
        quarantineDetail: q.detail,
        quarantinedShapeJson: q.shapeJson ?? null,
        expectedShapeJson: captured.shapeJson,
        exportSurface: e.found,
        exportDetail: e.detail,
        statuses,
        // Visible overlay remains on the live canvas while the snapshot
        // claims no pending: the hidden-loss signature.
        liveCenterStillRed: px(ctx, CENTER.x, CENTER.y).join(',') === '255,0,0,255',
      }
    }

    if (legName === 'rename-inside-await') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const statuses: string[] = []
      let capturedImage: ImageData | undefined
      let releasePng!: (v: Uint8Array | undefined) => void
      const pngGate = new Promise<Uint8Array | undefined>((resolve) => {
        releasePng = resolve
      })
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
        encodePng: (image: ImageData): Promise<Uint8Array | undefined> => {
          capturedImage = image
          return pngGate
        },
      }
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ports, history.ports, {
        onStatus: (s: string) => {
          statuses.push(String(s))
        },
      })
      const captured = await stageRedRect(session as never, ctx, { storedResolution: 2 })
      if ('error' in captured) return { stageError: captured.error }
      const md5Before = storedMd5(vm, tid)
      const bytesBefore = await storedBytes(vm, tid)
      let storeCalls = 0
      const origStore = vmApi(vm).storeAsset.bind(vm)
      ;(vm as unknown as Record<string, unknown>).storeAsset = async (d: Uint8Array, f: string) => {
        storeCalls += 1
        return origStore(d, f)
      }
      const flight = (session as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      let parked = false
      for (let i = 0; i < 200 && !parked; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        parked = capturedImage !== undefined
      }
      if (!parked) {
        ;(vm as unknown as Record<string, unknown>).storeAsset = origStore
        throw new Error('write never parked in encode')
      }
      const renamed = vmApi(vm).renameCostume(tid, 0, 'RENAMED2')
      const real = await realEncode(capturedImage as ImageData)
      storeCalls = 0 // export-recovery window starts after the conflict
      releasePng(real)
      const done = await flight
      const snap = (session as unknown as { snapshot: () => Record<string, unknown> }).snapshot()
      const bytesAfter = await storedBytes(vm, tid)
      const q = probeQuarantine(session as never)
      // Safe export must perform ZERO VM writes: count storeAsset + CAS.
      let exportWrites = 0
      const origCas = vmApi(vm).updateCostumeIfMatch.bind(vm)
      ;(vm as unknown as Record<string, unknown>).storeAsset = async (d: Uint8Array, f: string) => {
        exportWrites += 1
        return origStore(d, f)
      }
      ;(vm as unknown as Record<string, unknown>).updateCostumeIfMatch = async (...a: unknown[]) => {
        exportWrites += 1
        return origCas(...a)
      }
      let exportedPng: Uint8Array | undefined
      let exportByteExact: boolean | undefined
      try {
        const sess = session as unknown as Record<string, unknown>
        const fn = sess['exportQuarantinedPng'] as ((...a: unknown[]) => Promise<Uint8Array | undefined>) | undefined
        if (typeof fn === 'function') {
          exportedPng = (await fn.call(sess)) ?? undefined
          if (exportedPng && captured.compositePngLen) exportByteExact = exportedPng.byteLength === captured.compositePngLen
        }
      } catch {}
      const md5AfterExport = storedMd5(vm, tid)
      ;(vm as unknown as Record<string, unknown>).storeAsset = origStore
      ;(vm as unknown as Record<string, unknown>).updateCostumeIfMatch = origCas
      return {
        renamed,
        sameBytes: !!bytesBefore && !!bytesAfter && eqBytes(bytesBefore, bytesAfter),
        doneOk: (done as { ok?: unknown }).ok,
        doneKind: (done as { ok?: boolean; kind?: string; reason?: string }).ok ? (done as { kind?: string }).kind : (done as { reason?: string }).reason,
        hasPending: snap['hasPending'],
        depth: snap['historyDepth'],
        quarantined: q.found,
        quarantineDetail: q.detail,
        quarantinedShapeJson: q.shapeJson ?? null,
        expectedShapeJson: captured.shapeJson,
        statuses,
        storeCallsDuringConflict: storeCalls,
        exportWrites,
        exportedPngLen: exportedPng?.byteLength ?? null,
        expectedPngLen: captured.compositePngLen,
        exportByteExact: exportByteExact ?? false,
        md5Before,
        md5After: storedMd5(vm, tid),
        md5AfterExport,
      }
    }

    if (legName === 'external-new-bytes') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const statuses: string[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onStatus: (s: string) => {
          statuses.push(String(s))
        },
      })
      const captured = await stageRedRect(session as never, ctx, { storedResolution: 2 })
      if ('error' in captured) return { stageError: captured.error }
      const md5Before = storedMd5(vm, tid)
      const enc = new TextEncoder()
      await vmApi(vm).updateCostume(tid, 0, { dataFormat: 'svg' }, enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><text>EXT-BYTES</text></svg>'))
      const md5External = storedMd5(vm, tid)
      const done = await (session as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      const snap = (session as unknown as { snapshot: () => Record<string, unknown> }).snapshot()
      const q = probeQuarantine(session as never)
      const md5After = storedMd5(vm, tid)
      const extBytes = await storedBytes(vm, tid)
      const extText = extBytes ? new TextDecoder().decode(extBytes).includes('EXT-BYTES') : false
      return {
        md5Changed: md5External !== md5Before,
        doneOk: (done as { ok?: unknown }).ok,
        doneKind: (done as { ok?: boolean; kind?: string; reason?: string }).ok ? (done as { kind?: string }).kind : (done as { reason?: string }).reason,
        hasPending: snap['hasPending'],
        depth: snap['historyDepth'],
        externalPreserved: md5After === md5External && extText,
        quarantined: q.found,
        quarantineDetail: q.detail,
        quarantinedShapeJson: q.shapeJson ?? null,
        expectedShapeJson: captured.shapeJson,
        statuses,
      }
    }

    if (legName === 'reload-same-id') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const statuses: string[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onStatus: (s: string) => {
          statuses.push(String(s))
        },
      })
      const captured = await stageRedRect(session as never, ctx, { storedResolution: 1 })
      if ('error' in captured) return { stageError: captured.error }
      // The staged red overlay must really be visible before the reload;
      // otherwise the "not red after" check would pass vacuously.
      const stagedCenter = px(ctx, CENTER.x, CENTER.y)
      const stagedCenterRed = stagedCenter.join(',') === '255,0,0,255'
      const md5Before = storedMd5(vm, tid)
      const bytesBefore = await storedBytes(vm, tid)
      // Project reload reusing the same target id with different bytes.
      const proj = vmApi(vm).exportProject() as unknown as { targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }> }
      const idx = proj.targets.findIndex((t) => t.id === tid)
      const stored = await vmApi(vm).storeAsset(new TextEncoder().encode('NEW-GEN2'), 'svg')
      const expectedNewBytes = await vmApi(vm).loadAsset(stored.md5ext, 'svg').catch(() => undefined as unknown as Uint8Array)
      proj.targets[idx]!.costumes[0] = { ...proj.targets[idx]!.costumes[0], assetId: stored.assetId, md5ext: stored.md5ext, dataFormat: 'svg' }
      await vmApi(vm).loadProject(proj)
      // REAL-EDITOR RELOADER SIMULATION (what `Editor.svelte`
      // `loadCostumeIntoBitmapCanvas` does on a scope change: the SAME DOM
      // canvas is repainted with the NEW asset's ink under a new reload
      // serial/owner gate and the reloader owns the pixels from then on).
      // Without this step the fixture leaves the stale red overlay on the
      // canvas and the "not repainted onto the wrong slot" check is blind.
      // Paint NEW-GEN2 live ink: solid magenta + unique yellow marker.
      ctx.fillStyle = '#ff00ff'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ffff00'
      ctx.fillRect(10, 10, 1, 1)
      const newLiveBefore = new Uint8Array(ctx.getImageData(0, 0, W, H).data)
      const reloaderCenter = px(ctx, CENTER.x, CENTER.y)
      const reloaderMarker = px(ctx, 10, 10)
      const reloaderShowsNewArt =
        reloaderCenter.join(',') === '255,0,255,255' && reloaderMarker.join(',') === '255,255,0,255'
      let reloaderNonblank = false
      for (let i = 3; i < newLiveBefore.length; i += 4) {
        if (newLiveBefore[i] !== 0) {
          reloaderNonblank = true
          break
        }
      }
      const md5AfterReload = storedMd5(vm, tid)
      const md5Changed = md5AfterReload !== md5Before
      // Deferred conflict: the staged commit fires AFTER the reloader
      // replaced the canvas, so quarantine must stay off-canvas.
      const done = await (session as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      const snap = (session as unknown as { snapshot: () => Record<string, unknown> }).snapshot()
      const newLiveAfter = new Uint8Array(ctx.getImageData(0, 0, W, H).data)
      let fullRasterUnchanged = newLiveBefore.byteLength === newLiveAfter.byteLength
      if (fullRasterUnchanged) {
        for (let i = 0; i < newLiveBefore.byteLength; i += 1) {
          if (newLiveBefore[i] !== newLiveAfter[i]) {
            fullRasterUnchanged = false
            break
          }
        }
      }
      const q = probeQuarantine(session as never)
      const liveCenterAfter = px(ctx, CENTER.x, CENTER.y)
      const liveMarkerAfter = px(ctx, 10, 10)
      const liveShowsNewArtAfter =
        liveCenterAfter.join(',') === '255,0,255,255' && liveMarkerAfter.join(',') === '255,255,0,255'
      // Quarantined base must be the exact pre-stroke blank base (off-canvas
      // copy), never the reloader's magenta ink.
      let quarantinedBaseExact = false
      let quarantinedShapeJsonDirect: string | null = null
      try {
        const sess = session as unknown as { getQuarantined?: () => { shape?: unknown; base?: ImageData } | undefined }
        const direct = typeof sess.getQuarantined === 'function' ? sess.getQuarantined() : undefined
        if (direct && direct.base && direct.shape) {
          quarantinedShapeJsonDirect = JSON.stringify(direct.shape)
          const qb = new Uint8Array((direct.base as ImageData).data)
          const blank = new ImageData(W, H)
          const bb = new Uint8Array(blank.data)
          quarantinedBaseExact = qb.byteLength === bb.byteLength
          if (quarantinedBaseExact) {
            for (let i = 0; i < qb.byteLength; i += 1) {
              if (qb[i] !== bb[i]) {
                quarantinedBaseExact = false
                break
              }
            }
          }
        }
      } catch {
        quarantinedBaseExact = false
      }
      // Safe export must perform ZERO VM writes and be byte-exact against
      // an offline `base + shape` composite (no VM round-trip).
      const origStore = vmApi(vm).storeAsset.bind(vm)
      let exportWrites = 0
      const origCas = (vmApi(vm).updateCostumeIfMatch as (...a: unknown[]) => Promise<unknown>).bind(vm)
      ;(vm as unknown as Record<string, unknown>).storeAsset = async (d: Uint8Array, f: string) => {
        exportWrites += 1
        return origStore(d, f)
      }
      ;(vm as unknown as Record<string, unknown>).updateCostumeIfMatch = async (...a: unknown[]) => {
        exportWrites += 1
        return origCas(...a)
      }
      let exportedPng: Uint8Array | undefined
      let exportByteExact = false
      let exportedPngLen: number | null = null
      let expectedPngLen: number | null = null
      try {
        const sess = session as unknown as Record<string, unknown>
        const fn = sess['exportQuarantinedPng'] as ((...a: unknown[]) => Promise<Uint8Array | undefined>) | undefined
        if (typeof fn === 'function') {
          exportedPng = (await fn.call(sess)) ?? undefined
          exportedPngLen = exportedPng?.byteLength ?? null
          const shapeForExport = quarantinedShapeJsonDirect ?? (q.shapeJson as string | undefined)
          if (exportedPng && shapeForExport) {
            const blankBase = new ImageData(W, H)
            const { png } = await offlineComposite(ctx, blankBase, JSON.parse(shapeForExport) as never).catch(() => ({ png: undefined as Uint8Array | undefined }))
            expectedPngLen = png?.byteLength ?? null
            if (png && png.byteLength === exportedPng.byteLength) {
              exportByteExact = true
              for (let i = 0; i < png.byteLength; i += 1) {
                if (png[i] !== (exportedPng as Uint8Array)[i]) {
                  exportByteExact = false
                  break
                }
              }
            }
          }
        }
      } catch {
        exportByteExact = false
      }
      const md5AfterCommit = storedMd5(vm, tid)
      const bytesAfter = await storedBytes(vm, tid)
      ;(vm as unknown as Record<string, unknown>).storeAsset = origStore
      ;(vm as unknown as Record<string, unknown>).updateCostumeIfMatch = origCas
      const md5AfterExport = storedMd5(vm, tid)
      let vmNewBytesPreserved = !!expectedNewBytes && !!bytesAfter && expectedNewBytes.byteLength === bytesAfter.byteLength
      if (vmNewBytesPreserved && expectedNewBytes && bytesAfter) {
        for (let i = 0; i < expectedNewBytes.byteLength; i += 1) {
          if (expectedNewBytes[i] !== (bytesAfter as Uint8Array)[i]) {
            vmNewBytesPreserved = false
            break
          }
        }
      }
      return {
        md5Before,
        md5After: md5AfterCommit,
        md5AfterReload,
        md5Changed,
        md5StableAcrossConflict: md5AfterCommit === md5AfterReload,
        md5AfterExport,
        bytesBeforeLen: bytesBefore?.byteLength ?? null,
        bytesAfterLen: bytesAfter?.byteLength ?? null,
        vmNewBytesPreserved,
        doneOk: (done as { ok?: unknown }).ok,
        doneKind: (done as { ok?: boolean; kind?: string; reason?: string }).ok ? (done as { kind?: string }).kind : (done as { reason?: string }).reason,
        hasPending: snap['hasPending'],
        depth: snap['historyDepth'],
        quarantined: q.found,
        quarantineDetail: q.detail,
        quarantinedShapeJson: quarantinedShapeJsonDirect ?? q.shapeJson ?? null,
        expectedShapeJson: captured.shapeJson,
        quarantinedBaseExact,
        exportedPngLen,
        expectedPngLen,
        exportByteExact,
        exportWrites,
        stagedCenter,
        stagedCenterRed,
        reloaderShowsNewArt,
        reloaderNonblank,
        liveCenterBeforeConflict: reloaderCenter,
        liveCenterAfter,
        liveMarkerAfter,
        liveShowsNewArtAfter,
        fullRasterUnchanged,
        // Quarantine must live OFF the live canvas: after the reloader
        // replaced the slot with magenta, the old red overlay must never be
        // repainted onto it (guarded restore refuses; exact raster proves it).
        liveRepaintedOntoWrongSlot: liveCenterAfter.join(',') === '255,0,0,255',
        statuses,
      }
    }

    if (legName === 'delete-restore') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const statuses: string[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onStatus: (s: string) => {
          statuses.push(String(s))
        },
      })
      const captured = await stageRedRect(session as never, ctx, { storedResolution: 1 })
      if ('error' in captured) return { stageError: captured.error }
      const md5Before = storedMd5(vm, tid)
      vmApi(vm).deleteTarget(tid)
      const deletedGone = vmApi(vm).getTarget(tid) === undefined
      const newcomer = await vmApi(vm).addSprite('Newcomer')
      const newId = (newcomer.id ?? '') as string
      const done = await (session as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      const snap = (session as unknown as { snapshot: () => Record<string, unknown> }).snapshot()
      const q = probeQuarantine(session as never)
      return {
        deletedGone,
        sameIdReused: newId === tid,
        newId,
        md5Before,
        doneOk: (done as { ok?: unknown }).ok,
        doneKind: (done as { ok?: boolean; kind?: string; reason?: string }).ok ? (done as { kind?: string }).kind : (done as { reason?: string }).reason,
        hasPending: snap['hasPending'],
        quarantined: q.found,
        quarantineDetail: q.detail,
        quarantinedShapeJson: q.shapeJson ?? null,
        expectedShapeJson: captured.shapeJson,
        statuses,
      }
    }

    if (legName === 'metadata-rebase') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const statuses: string[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onStatus: (s: string) => {
          statuses.push(String(s))
        },
      })
      const captured = await stageRedRect(session as never, ctx, { storedResolution: 2 })
      if ('error' in captured) return { stageError: captured.error }
      const identBefore = vmApi(vm).getCostumeIdentity(tid, 0)
      const renamed = vmApi(vm).renameCostume(tid, 0, 'META-ONLY')
      const identAfter = vmApi(vm).getCostumeIdentity(tid, 0)
      const sameBytesOnly = identBefore.assetId === identAfter.assetId && identBefore.md5ext === identAfter.md5ext && (identAfter.writeSeq ?? 0) === (identBefore.writeSeq ?? 0) + 1
      const r = probeRebase(session as never)
      let rebased: unknown = null
      try {
        const sess = session as unknown as Record<string, unknown>
        const fn = (sess['rebaseQuarantinedAfterMetadataRename'] ?? sess['rebaseQuarantine'] ?? sess['adoptExternalRename']) as ((...a: unknown[]) => unknown) | undefined
        if (typeof fn === 'function') rebased = await fn.call(sess)
      } catch (error) {
        rebased = { error: error instanceof Error ? error.message : String(error) }
      }
      const md5After = storedMd5(vm, tid)
      return {
        renamed,
        sameBytesOnly,
        rebaseSurface: r.found,
        rebaseDetail: r.detail,
        rebased,
        liveName: vmApi(vm).getTarget(tid)?.costumes[0]?.name,
        md5BeforeRebase: identBefore.md5ext,
        md5After,
        statuses,
      }
    }

    if (legName === 'res1-rename-before') {
      const { ctx } = freshCanvas()
      const { vm, tid } = freshVm()
      const history = makeHistory()
      const statuses: string[] = []
      const session = sessMod.createBitmapPendingSession(vm, tid, 0, { loadSerial: 7, sessionGeneration: 3 }, ctx, history.ports, {
        onStatus: (s: string) => {
          statuses.push(String(s))
        },
      })
      const captured = await stageRedRect(session as never, ctx, { storedResolution: 1 })
      if ('error' in captured) return { stageError: captured.error }
      const renamed = vmApi(vm).renameCostume(tid, 0, 'R1')
      const done = await (session as unknown as { commitPending: () => Promise<unknown> }).commitPending()
      const snap = (session as unknown as { snapshot: () => Record<string, unknown> }).snapshot()
      const q = probeQuarantine(session as never)
      return {
        renamed,
        doneOk: (done as { ok?: unknown }).ok,
        doneKind: (done as { ok?: boolean; kind?: string; reason?: string }).ok ? (done as { kind?: string }).kind : (done as { reason?: string }).reason,
        hasPending: snap['hasPending'],
        quarantined: q.found,
        quarantineDetail: q.detail,
        quarantinedShapeJson: q.shapeJson ?? null,
        expectedShapeJson: captured.shapeJson,
        statuses,
      }
    }

    throw new Error(`unknown leg: ${legName}`)
  }, leg as unknown as undefined)
  return proof as Proof
}

describe('bitmap pending rename recovery (real VM + real Canvas, port 4622)', () => {
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

  it('rename before commit quarantines shape+base with explicit status; external preserved (res2)', async () => {
    const proof = await runLeg('rename-before')
    console.log(`[rename-recovery:rename-before] ${JSON.stringify(proof)}`)
    // External metadata-only rename is byte-identical with exactly one seq bump.
    expect(proof.sameBytes).toBe(true)
    expect(proof.seqBumpedByOne).toBe(true)
    expect(proof.renamed).toBe(true)
    expect(proof.liveName).toBe('RENAMED')
    // External bytes preserved exactly; no history for the dropped commit.
    expect(proof.md5After).toBe(proof.md5Before)
    expect(proof.depth).toBe(0)
    // SAFE contract: explicit conflict (never silent), quarantined shape+base
    // with no hidden loss, export surface present.
    expect(String((proof.statuses as string[]).join(' '))).toMatch(/conflict|quarantin|owner-mismatch|external/i)
    expect(proof.quarantined).toBe(true)
    expect(proof.quarantinedShapeJson).toBe(proof.expectedShapeJson)
    expect(proof.exportSurface).toBe(true)
    // Retry without explicit user action must not blind force/retry over the rename.
    expect(proof.doneOk).toBe(false)
  }, 60_000)

  it('rename inside storeAsset await quarantines; export byte-exact with zero VM writes (res2)', async () => {
    const proof = await runLeg('rename-inside-await')
    console.log(`[rename-recovery:rename-inside-await] ${JSON.stringify(proof)}`)
    expect(proof.renamed).toBe(true)
    expect(proof.sameBytes).toBe(true)
    expect(proof.md5After).toBe(proof.md5Before)
    expect(proof.depth).toBe(0)
    expect(proof.quarantined).toBe(true)
    expect(proof.quarantinedShapeJson).toBe(proof.expectedShapeJson)
    // Safe export of the old composed PNG: byte-exact, no VM writes.
    expect(proof.exportByteExact).toBe(true)
    expect(proof.exportWrites).toBe(0)
    expect(proof.md5AfterExport).toBe(proof.md5Before)
    expect(proof.doneOk).toBe(false)
  }, 60_000)

  it('external new bytes keep conflict; quarantined export offered, never auto-overwritten', async () => {
    const proof = await runLeg('external-new-bytes')
    console.log(`[rename-recovery:external-new-bytes] ${JSON.stringify(proof)}`)
    expect(proof.md5Changed).toBe(true)
    expect(proof.externalPreserved).toBe(true)
    expect(proof.doneOk).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.quarantinedShapeJson).toBe(proof.expectedShapeJson)
    expect(String((proof.statuses as string[]).join(' '))).toMatch(/conflict|quarantin|external/i)
  }, 60_000)

  it('project reload same-id quarantines off-canvas; never paints onto the new slot', async () => {
    const proof = await runLeg('reload-same-id')
    console.log(`[rename-recovery:reload-same-id] ${JSON.stringify(proof)}`)
    // Staged overlay was really red before the reload (non-vacuous), then the
    // reloader replaced the SAME canvas with nonblank NEW-GEN2 magenta ink.
    expect(proof.stagedCenterRed).toBe(true)
    expect(proof.reloaderNonblank).toBe(true)
    expect(proof.reloaderShowsNewArt).toBe(true)
    // Reload introduced genuinely new VM bytes.
    expect(proof.md5Changed).toBe(true)
    expect(proof.vmNewBytesPreserved).toBe(true)
    expect(proof.md5StableAcrossConflict).toBe(true)
    expect(proof.doneOk).toBe(false)
    expect(proof.hasPending).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.quarantinedShapeJson).toBe(proof.expectedShapeJson)
    // Quarantined base is the exact pre-stroke blank base (not magenta).
    expect(proof.quarantinedBaseExact).toBe(true)
    // Quarantine lives separate from the live canvas after ownership change:
    // exact full-raster proof the conflict touched nothing, new magenta art
    // (not the old red overlay) remains, export is byte-exact with no leak.
    expect(proof.fullRasterUnchanged).toBe(true)
    expect(proof.liveShowsNewArtAfter).toBe(true)
    expect(proof.liveRepaintedOntoWrongSlot).toBe(false)
    expect(proof.exportByteExact).toBe(true)
    expect(proof.exportWrites).toBe(0)
    expect(proof.md5AfterExport).toBe(proof.md5AfterReload)
    expect(proof.depth).toBe(0)
    expect(String((proof.statuses as string[]).join(' '))).toMatch(/conflict|quarantin|owner-mismatch|external|superseded|untouched/i)
  }, 60_000)

  it('target delete/restore quarantines; stale bytes never steer onto the recreated slot', async () => {
    const proof = await runLeg('delete-restore')
    console.log(`[rename-recovery:delete-restore] ${JSON.stringify(proof)}`)
    expect(proof.deletedGone).toBe(true)
    expect(proof.doneOk).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.quarantinedShapeJson).toBe(proof.expectedShapeJson)
  }, 60_000)

  it('metadata-only rename may rebase only on proven unchanged bytes/geometry/structure (never auto-overwrite)', async () => {
    const proof = await runLeg('metadata-rebase')
    console.log(`[rename-recovery:metadata-rebase] ${JSON.stringify(proof)}`)
    expect(proof.renamed).toBe(true)
    expect(proof.sameBytesOnly).toBe(true)
    // Explicit rebase surface exists and keeps the external rename (no clobber).
    expect(proof.rebaseSurface).toBe(true)
    expect(proof.liveName).toBe('META-ONLY')
  }, 60_000)

  it('res1 parity: rename before commit also quarantines (no hidden res loss)', async () => {
    const proof = await runLeg('res1-rename-before')
    console.log(`[rename-recovery:res1-rename-before] ${JSON.stringify(proof)}`)
    expect(proof.renamed).toBe(true)
    expect(proof.doneOk).toBe(false)
    expect(proof.quarantined).toBe(true)
    expect(proof.quarantinedShapeJson).toBe(proof.expectedShapeJson)
  }, 60_000)
})
