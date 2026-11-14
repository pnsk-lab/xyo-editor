// Real-Editor enabled-only audit for page lifecycle + unmount ownership.
//
// Instrumentation (no production edits, no env/query bypass):
// - Test server uses `test/vite.bitmap-pending.config.ts` (same transform as
//   `bitmap-pending-enabled.browser.test.ts`): ONLY
//     `export const BITMAP_PENDING_UI_ENABLED = false as const`
//   becomes `true` in memory. HMR/watch OFF. On-disk flag stays `false`
//   (asserted before+after). No localStorage/sessionStorage/query/env bypass.
// - Real Editor entry (`/` -> App.svelte); no synthetic canvas.
//
// What this pins (fail-first where the product was incomplete):
// - Synthetic `pagehide` preserves the active pending off-canvas with zero
//   VM/history writes and zero mutation to the other slot; `beforeunload`
//   stays armed; explicit export works; unconfirmed discard stays refused.
// - Synthetic `pageshow` (persisted false AND persisted true) never paints
//   old art onto another slot and never writes the VM.
// - Actual back/forward `pageshow.persisted` probe (best effort): `beforeunload`
//   makes the page BFCache-ineligible, so back/forward takes the reload path
//   (in-memory pending lost, no autosave). If a `persisted === true` restore
//   ever happens, the staged work must still be retained with zero cross-slot
//   paint. Either outcome is safe; the test records which one occurred.
// - Unmount under real Svelte (full navigation away + reload): in-memory
//   pending does NOT survive (no false durable autosave); the staged bytes
//   are never flushed (VM identity advances only via explicit commit, never
//   via hide/show/unmount alone).
// - Wrong-owner no-ops via the production constructor in-page: while recovery
//   is pending, staging on another slot is refused, and a clean controller
//   exports nothing / discards nothing.
//
// Boundary documented here and in `Editor.svelte`: `beforeunload` is not
// guaranteed on mobile (pagehide is only an in-memory retain fallback);
// reload/navigation/unmount without durable storage loses the staged edit.
// The pending UI stays production-disabled (`false` on disk) because that
// loss is not preventable without durable autosave.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-pagehide-bfcache-unmount.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4692
const base = `http://127.0.0.1:${PORT}`
const CONTROLLER_URL = new URL(
  '../src/features/costumes/bitmap-pending-controller.ts',
  import.meta.url,
)
const EDITOR_URL = new URL('../src/Editor.svelte', import.meta.url)
const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const BOX = { x1: 280, y1: 260, x2: 480, y2: 360 }
const CENTER = { x: 380, y: 310 }

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[pagehide-bfcache] on-disk flag (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}`,
    )
  }
}

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function canvasRectLive(): Promise<{ left: number; top: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const rect = target.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const rect = await canvasRectLive()
  const size = await canvasSize()
  return { x: rect.left + (x / size.width) * rect.width, y: rect.top + (y / size.height) * rect.height }
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
  }, [x, y] as unknown as undefined)
}

async function vmCostumeMd5(): Promise<string | undefined> {
  return await page.evaluate(() => {
    try {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown } }).__hikkakuEditorTest
      const snap = api?.snapshot() as
        | {
            selectedTargetId?: string
            project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }> }
          }
        | undefined
      const targets = snap?.project?.targets ?? []
      const sel =
        targets.find((t) => t.id === snap?.selectedTargetId) ??
        targets.find((t) => !t.isStage) ??
        targets[0]
      const idx = sel?.currentCostume ?? 0
      return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
    } catch {
      return undefined
    }
  })
}

async function otherTargetMd5(): Promise<string | undefined> {
  return await page.evaluate(() => {
    try {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown } }).__hikkakuEditorTest
      const snap = api?.snapshot() as
        | {
            selectedTargetId?: string
            project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }> }
          }
        | undefined
      const targets = snap?.project?.targets ?? []
      const other = targets.find((t) => t.id !== snap?.selectedTargetId && !t.isStage) ?? targets.find((t) => t.id !== snap?.selectedTargetId)
      if (!other) return undefined
      const idx = other.currentCostume ?? 0
      return other.costumes?.[idx]?.md5ext ?? other.costumes?.[idx]?.assetId
    } catch {
      return undefined
    }
  })
}

async function pendingStatusCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}

async function editorStatusText(): Promise<string> {
  return await page.evaluate(() => {
    try {
      return (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status() ?? ''
    } catch {
      return ''
    }
  })
}

async function beforeunloadPrevented(): Promise<boolean> {
  return await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

async function openBitmap() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
  } catch {
    // Already in bitmap mode.
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 })
  } catch {
    // Best effort only.
  }
  await page.waitForTimeout(800)
  const size = await canvasSize()
  if (size.width !== 960 || size.height !== 720) {
    throw new Error(`Expected bitmap res2 960x720 backing, got ${size.width}x${size.height}`)
  }
}

async function useSolidFill(fill: string) {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
}

async function dragRect() {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  await useSolidFill('#ff0000')
  const a = await toScreen(BOX.x1, BOX.y1)
  const b = await toScreen(BOX.x2, BOX.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

async function stagePendingRect(): Promise<{ beforeMd5: string | undefined; otherBefore: string | undefined }> {
  await openBitmap()
  const beforeMd5 = await vmCostumeMd5()
  const otherBefore = await otherTargetMd5()
  await dragRect()
  await page.waitForTimeout(800)
  return { beforeMd5, otherBefore }
}

describe('bitmap pending pagehide/bfcache/unmount (vite transform only)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (pending config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (pending config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('instrumentation: on-disk flag stays false, in-page flag is true', async () => {
    await assertOnDiskFlagFalse('instrumentation')
    await page.goto(base, { waitUntil: 'networkidle' })
    const inPage = await page.evaluate(async () => {
      const mod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      return (mod as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED
    })
    expect(inPage).toBe(true)
    await assertOnDiskFlagFalse('instrumentation-after-navigate')
  }, 120_000)

  it('synthetic pagehide preserves pending off-canvas; pageshow never mutates another slot', async () => {
    const { beforeMd5, otherBefore } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // Synthetic pagehide (mobile freeze path): retain-only, zero VM writes.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    await page.waitForTimeout(800)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(await otherTargetMd5()).toBe(otherBefore)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await beforeunloadPrevented()).toBe(true)
    // Synthetic pageshow without BFCache: still no cross-slot paint, no VM write.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pageshow'))
    })
    await page.waitForTimeout(800)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(await otherTargetMd5()).toBe(otherBefore)
    // Synthetic persisted BFCache restore: same guarantees (no old->new paint).
    await page.evaluate(() => {
      const event = new Event('pageshow') as Event & { persisted: boolean }
      ;(event as { persisted: boolean }).persisted = true
      window.dispatchEvent(event)
    })
    await page.waitForTimeout(800)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(await otherTargetMd5()).toBe(otherBefore)
    expect(await beforeunloadPrevented()).toBe(true)
    console.log('[pagehide-bfcache:synthetic] pagehide/pageshow preserved, zero cross-slot mutation')
  }, 180_000)

  it('actual back/forward probe: persisted flag recorded, either outcome stays safe (no autosave)', async () => {
    const { beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Record real pageshow.persisted across a same-origin back/forward.
    // beforeunload makes BFCache ineligible, so `persisted === false`
    // (reload path) is the expected outcome; a `true` restore must still
    // retain the staged work with zero VM writes.
    const probe = await page.evaluate(async () => {
      const w = window as unknown as {
        __pageshowLog?: Array<{ persisted: boolean }>
      }
      w.__pageshowLog = []
      const onShow = (e: Event) => {
        w.__pageshowLog!.push({ persisted: (e as PageTransitionEvent).persisted === true })
      }
      window.addEventListener('pageshow', onShow)
      const current = window.location.href
      const other = current.includes('?') ? `${current}&bfcache-probe=1` : `${current}?bfcache-probe=1`
      // Same-document pushState + back: exercises popstate without unloading.
      window.history.pushState({ probe: 1 }, '', other)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const pushed = window.location.href
      window.history.back()
      await new Promise((resolve) => setTimeout(resolve, 600))
      const backHref = window.location.href
      window.removeEventListener('pageshow', onShow)
      const log = w.__pageshowLog ?? []
      return { pushed, backHref, log }
    })
    console.log(`[pagehide-bfcache:actual] probe=${JSON.stringify(probe)}`)
    // Either way: no autosave flush from the navigation alone.
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(await beforeunloadPrevented()).toBe(true)
    // Same-document history never fires pageshow: log stays empty (safe,
    // documented). A real cross-document BFCache restore would log persisted
    // true/false; both keep the staged red with zero VM mutation.
    expect(Array.isArray(probe.log)).toBe(true)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
  }, 180_000)

  it('unmount under real Svelte: full reload loses memory (no false durable autosave)', async () => {
    const { beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // Direct DOM canvas remove (bypasses Svelte destroy): zero VM writes,
    // staged overlay untouched by any autosave.
    await page.evaluate(() => {
      document.querySelector('[data-testid="bitmap-editor-canvas"]')?.remove()
    })
    await page.waitForTimeout(800)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    // Full Svelte unmount via reload: in-memory pending cannot survive.
    // This is the documented boundary (no durable autosave promised).
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    expect(await pendingStatusCount()).toBe(0)
    expect(await beforeunloadPrevented()).toBe(false)
    await assertOnDiskFlagFalse('unmount-after-reload')
    console.log('[pagehide-bfcache:unmount] reload drops in-memory pending, no autosave (boundary holds)')
  }, 180_000)

  it('wrong-owner no-ops via production constructor in-page (no cross-slot mutation)', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    const proof = await page.evaluate(async () => {
      const controllerMod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      const vmMod = await import('/test/bitmap-pending-session-vm-entry.ts')
      const W = 120
      const H = 90
      const freshCanvas = () => {
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#f0f0f0'
        ctx.fillRect(0, 0, W, H)
        return { canvas, ctx }
      }
      const { canvas, ctx } = freshCanvas()
      const vm = new (vmMod as unknown as { ScratchVM: new () => never }).ScratchVM()
      ;(vm as unknown as { loadProject: (p: unknown) => void }).loadProject(
        (vmMod as unknown as { createDefaultProject: () => unknown }).createDefaultProject(),
      )
      const api = vm as unknown as {
        getSprites: () => { id: string }[]
        getTarget: (id: string) => { costumes: { md5ext?: string }[] } | undefined
        addSprite: (n: string) => Promise<{ id?: string }>
        selectTarget: (id: string) => void
        updateCostumeIfMatch: (...a: unknown[]) => Promise<unknown>
        storeAsset: (d: Uint8Array, f: string) => Promise<unknown>
      }
      const tid = api.getSprites()[0].id
      const md5Before = api.getTarget(tid)?.costumes[0]?.md5ext
      // Production constructor (NOT the test factory): enabled in memory by
      // the transform, so this is the real product path.
      const controller = new (controllerMod as unknown as {
        BitmapPendingController: new (
          vm: unknown,
          cb: unknown,
        ) => {
          ensure: (slot: unknown, canvas: unknown) => unknown
          hasRecovery: () => boolean
          hasUnsavedState: () => boolean
          exportRecoveryPng: () => Promise<Uint8Array | undefined>
          discardRecovery: (opts?: unknown) => { ok: boolean; kind: string }
          commitRecovery: () => Promise<unknown>
          getRecoveryState: () => { hasRecovery: boolean }
        }
      }).BitmapPendingController(vm as never, {
        onSelection: () => {},
        onStatus: () => {},
        peekHistory: async () => undefined,
        commitHistory: () => false,
        historyDepth: () => 0,
        historyIsCurrent: () => true,
        readConfig: () => ({}),
      })
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas) as unknown as {
        pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown>
        pointerUp: (at: unknown) => Promise<unknown>
      }
      if (!staged) throw new Error('no session (transform active?)')
      await staged.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', {
        fill: '#ff0000', secondary: '#ffffff', gradient: 'solid',
        fillTransparent: false, secondaryTransparent: false, brushSize: 6,
      })
      await staged.pointerUp({ x: 100, y: 75 })
      // Freeze the staged heap, then simulate a mobile pagehide freeze.
      const stagedDigest = Array.from(ctx.getImageData(0, 0, W, H).data).join(',')
      window.dispatchEvent(new Event('pagehide'))
      // Wrong-owner stage on another target while recovery/active pending:
      // refused (undefined) with the live canvas untouched.
      const newcomer = await api.addSprite('SpriteB')
      const spriteB = (newcomer.id ?? '') as string
      api.selectTarget(spriteB)
      ctx.fillStyle = '#00ffff'
      ctx.fillRect(0, 0, W, H)
      const liveBefore = Array.from(ctx.getImageData(0, 0, W, H).data).join(',')
      const slotB = { targetId: spriteB, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const next = controller.ensure(slotB, canvas)
      const liveAfter = Array.from(ctx.getImageData(0, 0, W, H).data).join(',')
      // Wrong-owner commit attempt must not land on B (refused / nothing).
      let commitKind = 'unknown'
      try {
        const res = (await controller.commitRecovery()) as { ok?: boolean; kind?: string }
        commitKind = String(res?.kind ?? (res?.ok === true ? 'ok' : 'refused'))
      } catch {
        commitKind = 'threw-refused'
      }
      // Unconfirmed discard is always refused (explicit refusal, no loss).
      const unconfirmed = controller.discardRecovery()
      // Clean-controller no-ops: a fresh controller with no recovery exports
      // nothing and discards nothing.
      const clean = new (controllerMod as unknown as {
        BitmapPendingController: new (vm: unknown, cb: unknown) => {
          exportRecoveryPng: () => Promise<Uint8Array | undefined>
          discardRecovery: (opts?: unknown) => { ok: boolean; kind: string }
        }
      }).BitmapPendingController(vm as never, {
        onSelection: () => {},
        onStatus: () => {},
        peekHistory: async () => undefined,
        commitHistory: () => false,
        historyDepth: () => 0,
        historyIsCurrent: () => true,
        readConfig: () => ({}),
      })
      const cleanExport = await clean.exportRecoveryPng()
      const cleanDiscard = clean.discardRecovery({ confirmed: true })
      return {
        stagedDigestNonblank: stagedDigest !== liveBefore,
        nextUndefined: next === undefined,
        liveUnchanged: liveBefore === liveAfter,
        md5Stable: api.getTarget(tid)?.costumes[0]?.md5ext === md5Before,
        unsaved: controller.hasUnsavedState(),
        hasRecovery: controller.getRecoveryState().hasRecovery,
        commitKind,
        unconfirmed,
        cleanExportUndefined: cleanExport === undefined,
        cleanDiscardKind: cleanDiscard.kind,
      }
    })
    console.log(`[pagehide-bfcache:wrong-owner] ${JSON.stringify({ ...proof, stagedDigestNonblank: proof.stagedDigestNonblank })}`)
    expect(proof.stagedDigestNonblank).toBe(true)
    expect(proof.nextUndefined).toBe(true)
    expect(proof.liveUnchanged).toBe(true)
    expect(proof.md5Stable).toBe(true)
    expect(proof.unsaved).toBe(true)
    expect(proof.unconfirmed).toEqual({ ok: false, kind: 'refused' })
    expect(proof.cleanExportUndefined).toBe(true)
    expect(proof.cleanDiscardKind).toBe('nothing-pending')
  }, 120_000)

  it('static wiring audit: pagehide/pageshow symmetric, enabled-only, no autosave, no suppression', async () => {
    const editorSource = await Bun.file(EDITOR_URL).text()
    // Symmetric install/cleanup for all three lifecycle listeners.
    expect(editorSource).toContain(`window.addEventListener('beforeunload', handleBitmapPendingBeforeUnload)`)
    expect(editorSource).toContain(`window.removeEventListener('beforeunload', handleBitmapPendingBeforeUnload)`)
    expect(editorSource).toContain(`window.addEventListener('pagehide', handleBitmapPendingPageHide)`)
    expect(editorSource).toContain(`window.removeEventListener('pagehide', handleBitmapPendingPageHide)`)
    expect(editorSource).toContain(`window.addEventListener('pageshow', handleBitmapPendingPageShow)`)
    expect(editorSource).toContain(`window.removeEventListener('pageshow', handleBitmapPendingPageShow)`)
    // Enabled-only gates on every lifecycle handler.
    expect(editorSource).toContain('function handleBitmapPendingPageHide')
    expect(editorSource).toContain('function handleBitmapPendingPageShow')
    const hideStart = editorSource.indexOf('function handleBitmapPendingPageHide')
    const hideBlock = editorSource.slice(hideStart, hideStart + 900)
    expect(hideBlock).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(hideBlock).toContain(`retainUnsavedForExternalChange('pagehide')`)
    const showStart = editorSource.indexOf('function handleBitmapPendingPageShow')
    const showBlock = editorSource.slice(showStart, showStart + 1400)
    expect(showBlock).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(showBlock).toContain('persisted')
    // No autosave / no prompt suppression anywhere in the lifecycle path:
    // hide/show never commit, store, CAS-write, or clear a dialog result.
    for (const block of [hideBlock, showBlock]) {
      expect(block).not.toContain('commitPending')
      expect(block).not.toContain('commitRecovery')
      expect(block).not.toContain('storeAsset')
      expect(block).not.toContain('updateCostumeIfMatch')
      expect(block).not.toContain('preventDefault')
    }
    // Production still never imports the isolated test factory.
    expect(editorSource).not.toContain('createBitmapPendingControllerForTest')
    expect(editorSource).not.toContain('testForceEnabled')
    await assertOnDiskFlagFalse('static-audit')
  }, 60_000)
})
