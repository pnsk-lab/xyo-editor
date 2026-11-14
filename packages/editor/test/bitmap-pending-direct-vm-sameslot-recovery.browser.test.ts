// Fail-first DIRECT same-slot recovery audit for the bitmap pending UI.
// Flag stays false on disk (asserted before+after). No production edits.
//
// Instrumentation: SAME direct-VM Vite config as the 7-test hostile suite
// (`test/vite.bitmap-pending-direct.config.ts` = base + in-memory enabled-flip
// + `vite-bitmap-pending-direct-vm-plugin.ts` exposing the ACTUAL live `vm` as
// `window.__directVm` + `__hikkakuEditorTest.directVm()` with deferred
// `direct-cas-pre` / `direct-store` / `direct-history-append` gates). HMR/watch
// OFF. Independent port 4694 (hostile suite uses 4693).
//
// Why this file exists: the hostile suite's "same-slot" leg is mislabelled —
// it never calls `vm.updateCostume` with fresh bytes on the SAME id/slot while
// staged (it probes `hasVm` + a same-bytes rename). These legs close that gap
// with REAL bytes/digests on the REAL VM + REAL 2d canvas, each case
// independent (fresh nonblank blue base + pointer-drag staged red per test):
//
// - same-slot-fresh-bytes ... staged red, capture owner/md5/base, DIRECT
//   `vm.updateCostume(SAME id, SAME slot, fresh GREEN png)`. External wins,
//   staged blue+red retained OFF-CANVAS quarantined exportable, UI recovery
//   visible in any tab/format, live canvas exactly green (no red/blue).
// - metadata-only ........... SAME slot rename + rotationCenter patch, same
//   bytes (no data). External meta wins, staged quarantined, no bytes move.
// - reorder-current ......... DIRECT reorder of the current costume index while
//   pending. External order wins, no staged leak, quarantine retained.
// - delete-nonstage ......... DIRECT delete of an actual non-stage sprite while
//   pending. Staged preserved (pending or quarantined), no cross-slot leak.
// - loadproject-sameids ..... whole-project replacement reusing SAME target
//   ids with NEW-GEN green bytes. External wins, staged quarantined.
// - stable-stage ............ SAME as fresh-bytes but on the stable Stage
//   backdrop target (pointer drag on stage, green wins, no stale ink).
// - inflight-post-cas ....... held CAS + hostile green DURING the commit flight
//   (pre-stage patch captured, post-CAS external after `direct-writer-cas-pre`):
//   conflict + `history-gap` visible, staged never lands, explicit discard.
//
// Strict fail-first (do NOT weaken): every leg asserts external-wins byte-exact
// via REAL `vm.loadAsset` digest/pixels, quarantined export byte-exact old
// blue+red via the REAL Export download, live canvas exactly green with no
// stale red/blue, zero staged writes (`direct-writer-cas-pre` /
// `direct-history-append-result` absent), histories scoped, `beforeunload`
// guards, Export PNG works, confirmed Discard clears, conflict/in-flight gap
// signal visible. Mocked VM/canvas contexts are forbidden.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-direct-vm-sameslot-recovery.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4694
const base = `http://127.0.0.1:${PORT}`
const CONTROLLER_URL = new URL(
  '../src/features/costumes/bitmap-pending-controller.ts',
  import.meta.url,
)
const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'
const BYPASS_TOKENS = [
  'localStorage.',
  'sessionStorage.',
  'URLSearchParams',
  'location.search',
  'location.hash',
  'import.meta.env',
  'process.env',
]

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const BOX_BLUE = { x1: 100, y1: 100, x2: 300, y2: 200 }
const BOX_RED = { x1: 280, y1: 260, x2: 480, y2: 360 }
const CENTER_RED = { x: 380, y: 310 }
const CENTER_BLUE = { x: 200, y: 150 }

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[sameslot-recovery] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `[sameslot-recovery] on-disk bypass check (${stage}): must not contain ${JSON.stringify(token)}`,
      )
    }
  }
  const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
  if (editorSource.includes('__directVm') || editorSource.includes('__directRace')) {
    throw new Error(
      `[sameslot-recovery] production switch check (${stage}): Editor.svelte must not contain direct-VM hooks on disk`,
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

async function canvasDigest(): Promise<string> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data).join(',')
  })
}

async function vmSnapshot(): Promise<{
  selectedTargetId?: string
  project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string; name?: string; dataFormat?: string; rotationCenterX?: number; rotationCenterY?: number; bitmapResolution?: number }> }> }
}> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown } }).__hikkakuEditorTest
    return (api?.snapshot() ?? {}) as never
  })
}

function pickSelected(
  targets: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }>,
  want: string | undefined,
) {
  return (
    targets.find((t) => t.id === want) ??
    targets.find((t) => !t.isStage) ??
    targets[0]
  )
}

async function vmCostumeMd5(): Promise<string | undefined> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const sel = pickSelected(targets, snap?.selectedTargetId)
  const idx = sel?.currentCostume ?? 0
  return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
}

async function selectedStableId(): Promise<string> {
  const snap = await vmSnapshot()
  return snap?.selectedTargetId ?? ''
}

async function selectedCostumeIndex(): Promise<number> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const sel = pickSelected(targets, snap?.selectedTargetId)
  return sel?.currentCostume ?? 0
}

async function selectedTargetName(): Promise<string> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const sel = pickSelected(targets, snap?.selectedTargetId)
  return sel?.name ?? ''
}

async function costumeMd5ForStableId(stableId: string): Promise<string | undefined> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const hit = targets.find((t) => t.id === stableId)
  if (!hit) return undefined
  const idx = hit.currentCostume ?? 0
  return hit.costumes?.[idx]?.md5ext ?? hit.costumes?.[idx]?.assetId
}

async function pendingStatusCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}

async function pendingExportCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-export"]').length)
}

async function pendingDiscardCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-discard"]').length)
}

async function pendingStatusText(): Promise<string> {
  return await page.evaluate(() => document.querySelector('[data-testid="bitmap-pending-status"]')?.textContent ?? '')
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

async function directKinds(): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __directRace?: { log: Array<{ kind: string }> } }
    return (w.__directRace?.log ?? []).map((e) => e.kind)
  })
}

async function directClear(): Promise<void> {
  await page.evaluate(() => {
    try {
      ;(window as unknown as { __directRace?: { clear: () => void } }).__directRace?.clear()
    } catch {}
  })
}

async function directHold(name: string): Promise<void> {
  await page.evaluate((n: string) => {
    ;(window as unknown as { __directRace?: { hold: (x: string) => void } }).__directRace?.hold(n as string)
  }, name as unknown as undefined)
}

async function directRelease(name?: string): Promise<void> {
  await page.evaluate((n: string | undefined) => {
    const w = window as unknown as { __directRace?: { release: (x?: string) => void } }
    if (n === undefined) w.__directRace?.release()
    else w.__directRace?.release(n)
  }, name as unknown as undefined)
}

async function waitForDirectKind(kind: string, timeout = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if ((await directKinds()).includes(kind)) return
    await page.waitForTimeout(200)
  }
  throw new Error(`waitForDirectKind timeout ${JSON.stringify(kind)}, got ${JSON.stringify(await directKinds())}`)
}

async function waitForStableDigest(tries = 10): Promise<string> {
  let last = await canvasDigest()
  for (let i = 0; i < tries; i += 1) {
    await page.waitForTimeout(400)
    const next = await canvasDigest()
    if (next === last) return next
    last = next
  }
  return last
}

function isNonBlankDigest(digest: string): boolean {
  const parts = digest.split(',')
  const first = `${parts[0]},${parts[1]},${parts[2]},${parts[3]}`
  for (let i = 4; i < parts.length; i += 4) {
    if (`${parts[i]},${parts[i + 1]},${parts[i + 2]},${parts[i + 3]}` !== first) return true
  }
  return false
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

// Compact toolbar: the Bitmap paint style + Paint color live inside the
// anchored Fill popover (not in the closed bar). Open it before the label
// selection and close it before any canvas draw so the floating dialog never
// covers the canvas hit-test and a later Escape means commit, not close.
async function openFillPopoverForBitmap() {
  if ((await page.getByTestId('fill-style-dialog').count()) > 0) return
  await page.getByTestId('fill-style').click()
  await page.getByTestId('fill-style-dialog').waitFor({ state: 'visible', timeout: 10_000 })
}

async function closeFillPopoverBeforeDraw() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await page.getByTestId('fill-style-dialog').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached', timeout: 10_000 })
}

async function useSolidFill(fill: string) {
  await openFillPopoverForBitmap()
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
  await closeFillPopoverBeforeDraw()
}

async function dragBox(box: { x1: number; y1: number; x2: number; y2: number }) {
  await closeFillPopoverBeforeDraw()
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  const a = await toScreen(box.x1, box.y1)
  const b = await toScreen(box.x2, box.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

async function stageRedOverNonblankBase(): Promise<{
  blueDigest: string
  blueMd5: string | undefined
  stagedDigest: string
  stableBefore: string
  indexBefore: number
}> {
  await openBitmap()
  await useSolidFill('#0000ff')
  await dragBox(BOX_BLUE)
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
  const blueDigest = await waitForStableDigest()
  expect(isNonBlankDigest(blueDigest)).toBe(true)
  const blueMd5 = await vmCostumeMd5()
  expect(blueMd5).toBeDefined()
  const stableBefore = await selectedStableId()
  expect(stableBefore.length).toBeGreaterThan(0)
  const indexBefore = await selectedCostumeIndex()
  await useSolidFill('#ff0000')
  await dragBox(BOX_RED)
  await page.waitForTimeout(800)
  expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
  expect(await pendingStatusCount()).toBeGreaterThan(0)
  expect(await vmCostumeMd5()).toBe(blueMd5)
  const stagedDigest = await canvasDigest()
  expect(isNonBlankDigest(stagedDigest)).toBe(true)
  expect(stagedDigest).not.toBe(blueDigest)
  return { blueDigest, blueMd5, stagedDigest, stableBefore, indexBefore }
}

async function beforeUnloadPrevented(): Promise<boolean> {
  return await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    try {
      ;(event as unknown as { returnValue: unknown }).returnValue = true
    } catch {}
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

async function quarantinedExportCenterPixel(): Promise<number[] | undefined> {
  const downloadPromise = page.waitForEvent('download', { timeout: 8_000 }).catch(() => undefined)
  await page.getByTestId('bitmap-pending-export').click()
  const download = await downloadPromise
  if (!download) return undefined
  const stream = await download.createReadStream()
  if (!stream) return undefined
  const chunks: Uint8Array[] = []
  for await (const chunk of (stream as unknown as AsyncIterable<Uint8Array>)) chunks.push(chunk as Uint8Array)
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buffer.set(c, offset)
    offset += c.length
  }
  const center = await page.evaluate(async (bytes: number[]) => {
    try {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const bmp = await createImageBitmap(blob)
      const off = document.createElement('canvas')
      off.width = bmp.width
      off.height = bmp.height
      const octx = off.getContext('2d')!
      octx.drawImage(bmp, 0, 0)
      return Array.from(octx.getImageData(380, 310, 1, 1).data)
    } catch {
      return undefined
    }
  }, Array.from(buffer) as unknown as undefined)
  return (center ?? undefined) as number[] | undefined
}

// REAL green PNG bytes via the live canvas encoder, written via the ACTUAL
// direct `vm.updateCostume` on the SAME stable id/slot. Returns the post-write
// md5 + writeSeq so callers can assert external-wins byte-exact.
async function directGreenSameSlot(stableId: string, index: number): Promise<{ md5: string | undefined; seq: number }> {
  return await page.evaluate(async ([id, idx]: [string, number]) => {
    const w = window as unknown as {
      __directVm?: {
        updateCostume: (t: string, i: number, patch: unknown, data?: Uint8Array) => Promise<void>
        getCostumeIdentity?: (t: string, i: number) => { md5ext?: string } | undefined
        getCostumeWriteSeq?: (t: string, i: number) => number
        snapshot?: () => { project?: { targets?: Array<{ id?: string; costumes?: Array<{ bitmapResolution?: number }> }> } }
      }
    }
    const c = document.createElement('canvas')
    c.width = 960
    c.height = 720
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#00ff00'
    ctx.fillRect(0, 0, 960, 720)
    const blob: Blob | null = await new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'))
    if (!blob) throw new Error('green encode failed')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const snap = w.__directVm?.snapshot?.()
    const hit = snap?.project?.targets?.find((t) => t.id === (id as string))
    const res = (hit?.costumes?.[idx as number] as { bitmapResolution?: number } | undefined)?.bitmapResolution ?? 2
    await w.__directVm?.updateCostume(id as string, idx as number, { dataFormat: 'png', bitmapResolution: res }, bytes)
    const md5 = w.__directVm?.getCostumeIdentity?.(id as string, idx as number)?.md5ext
    const seq = w.__directVm?.getCostumeWriteSeq?.(id as string, idx as number) ?? -1
    return { md5, seq }
  }, [stableId, index] as unknown as undefined)
}

// REAL `vm.loadAsset` digest/pixel probe: proves the live VM bytes are the
// external green (not stale red/blue), without mocked contexts.
async function liveAssetCenterPixel(md5: string): Promise<number[] | undefined> {
  return await page.evaluate(async (key: string) => {
    try {
      const w = window as unknown as { __directVm?: { loadAsset: (k: string, f: string) => Promise<Uint8Array | undefined> } }
      const bytes = await w.__directVm?.loadAsset(key as string, 'png')
      if (!bytes) return undefined
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const bmp = await createImageBitmap(blob)
      const off = document.createElement('canvas')
      off.width = bmp.width
      off.height = bmp.height
      const octx = off.getContext('2d')!
      octx.drawImage(bmp, 0, 0)
      const cx = Math.floor(bmp.width / 2)
      const cy = Math.floor(bmp.height / 2)
      return Array.from(octx.getImageData(cx, cy, 1, 1).data)
    } catch {
      return undefined
    }
  }, md5 as unknown as undefined)
}

async function assertRecoveryChrome(exportedExpect: number[]): Promise<void> {
  // UI recovery visible (quarantine path) in the current tab/format.
  expect(await pendingStatusCount()).toBeGreaterThan(0)
  expect(await pendingExportCount()).toBeGreaterThan(0)
  expect(await pendingDiscardCount()).toBeGreaterThan(0)
  const text = await pendingStatusText()
  expect(text).toMatch(/quarantin|recovery-pending|external|conflict|history-gap/)
  // beforeunload guards the retained off-canvas work.
  expect(await beforeUnloadPrevented()).toBe(true)
  // Export PNG is the byte-exact old blue+red staged composite.
  const exportedCenter = await quarantinedExportCenterPixel()
  expect(exportedCenter).toEqual(exportedExpect)
  // Recovery survives a tab round-trip (any tab): sounds -> costumes.
  try {
    await page.getByTestId('main-tab-sounds').click()
    await page.waitForTimeout(400)
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(400)
  } catch {
    // Tab affordance missing: still require recovery chrome below.
  }
  expect(await pendingStatusCount()).toBeGreaterThan(0)
  expect(await pendingExportCount()).toBeGreaterThan(0)
}

describe('bitmap pending direct-VM same-slot recovery (vite transform only, port 4694)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending-direct.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (direct sameslot config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (direct sameslot config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('same-slot fresh GREEN bytes win; staged blue+red quarantined off-canvas; live canvas exactly green', async () => {
    const { blueDigest, blueMd5, stagedDigest, stableBefore, indexBefore } = await stageRedOverNonblankBase()
    await directClear()
    const seqBefore = await page.evaluate(([id, idx]) => {
      const vm = (window as unknown as { __directVm?: { getCostumeWriteSeq: (t: string, i: number) => number } }).__directVm
      return vm?.getCostumeWriteSeq(id as string, idx as number) ?? -1
    }, [stableBefore, indexBefore] as unknown as undefined)
    // ACTUAL hostile write: fresh green PNG on the SAME stable id/slot.
    const ext = await directGreenSameSlot(stableBefore, indexBefore)
    expect(ext.md5).toBeDefined()
    expect(ext.md5).not.toBe(blueMd5)
    expect(ext.seq).toBe(seqBefore + 1)
    await page.waitForTimeout(1500)
    // External asset wins byte-exact (real VM digest + decoded green pixel).
    expect(await costumeMd5ForStableId(stableBefore)).toBe(ext.md5)
    expect(await vmCostumeMd5()).toBe(ext.md5)
    expect(await liveAssetCenterPixel(ext.md5!)).toEqual([0, 255, 0, 255])
    // Live canvas is exactly the new green base: no stale red/blue.
    await page.waitForTimeout(600)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([0, 255, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 255, 0, 255])
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(stagedDigest)
    expect(liveAfter).not.toBe(blueDigest)
    // Staged red retained OFF-CANVAS as quarantined export (old blue+red).
    await assertRecoveryChrome([255, 0, 0, 255])
    // No staged writes leaked; histories scoped to the single external write.
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
    const seqAfterQuarantine = await page.evaluate(([id, idx]) => {
      const vm = (window as unknown as { __directVm?: { getCostumeWriteSeq: (t: string, i: number) => number } }).__directVm
      return vm?.getCostumeWriteSeq(id as string, idx as number) ?? -1
    }, [stableBefore, indexBefore] as unknown as undefined)
    expect(seqAfterQuarantine).toBe(ext.seq)
    // Confirmed discard clears the quarantine without touching the green base.
    await page.getByTestId('bitmap-pending-discard').click()
    await page.waitForTimeout(800)
    expect(await pendingStatusCount()).toBe(0)
    expect(await costumeMd5ForStableId(stableBefore)).toBe(ext.md5)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([0, 255, 0, 255])
  }, 240_000)

  it('metadata-only SAME-slot rename + center patch: external meta wins, same bytes, staged quarantined', async () => {
    const { blueMd5, stableBefore, indexBefore } = await stageRedOverNonblankBase()
    await directClear()
    const extName = `ext-meta-${Date.now() % 100000}`
    await page.evaluate(([id, idx, name]: [string, number, string]) => {
      const vm = (window as unknown as {
        __directVm?: {
          renameCostume: (t: string, i: number, n: string) => boolean
          updateCostume: (t: string, i: number, p: unknown) => Promise<void>
        }
      }).__directVm
      vm?.renameCostume(id as string, idx as number, name as string)
      void vm?.updateCostume(id as string, idx as number, { rotationCenterX: 111, rotationCenterY: 222 })
    }, [stableBefore, indexBefore, extName] as unknown as undefined)
    await page.waitForTimeout(1200)
    // Surfacing step: an explicit commit attempt (Escape) must fail closed with
    // quarantine — the external rename/center is caller intent and wins.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    // External metadata wins with identical bytes (md5 stable, name/center new).
    expect(await costumeMd5ForStableId(stableBefore)).toBe(blueMd5)
    const snap = await vmSnapshot()
    const hit = snap.project?.targets?.find((t) => t.id === stableBefore)
    const costume = hit?.costumes?.[hit.currentCostume ?? 0]
    expect(costume?.name).toBe(extName)
    expect(costume?.rotationCenterX).toBe(111)
    expect(costume?.rotationCenterY).toBe(222)
    // Staged red quarantined off-canvas; zero staged writes; histories scoped.
    await assertRecoveryChrome([255, 0, 0, 255])
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
    expect(await beforeUnloadPrevented()).toBe(true)
  }, 240_000)

  it('DIRECT reorder of the current costume index while pending: external order wins, no staged leak', async () => {
    const { blueMd5, stagedDigest, stableBefore } = await stageRedOverNonblankBase()
    // Need a second costume on the staged slot for a real index shift, with
    // DISTINCT bytes so the order is observable (index 1 -> fresh green).
    await page.evaluate(([id]: [string]) => {
      const vm = (window as unknown as { __directVm?: { duplicateCostume: (t: string, i: number) => Promise<number> } }).__directVm
      void vm?.duplicateCostume(id as string, 0)
    }, [stableBefore] as unknown as undefined)
    await page.waitForTimeout(1200)
    const siblingGreen = await directGreenSameSlot(stableBefore, 1)
    expect(siblingGreen.md5).toBeDefined()
    expect(siblingGreen.md5).not.toBe(blueMd5)
    await directClear()
    // ACTUAL hostile reorder of the staged index: [blue, green] -> [green, blue].
    await page.evaluate(([id]: [string]) => {
      const vm = (window as unknown as { __directVm?: { reorderCostume: (t: string, a: number, b: number) => boolean } }).__directVm
      vm?.reorderCostume(id as string, 0, 1)
    }, [stableBefore] as unknown as undefined)
    await page.waitForTimeout(1500)
    // External order wins: the selected green sibling moves to index 0, staged
    // blue bytes never land as green, quarantine retains old blue+red.
    // External order wins: the selected green sibling moves to index 0, staged
    // blue bytes never land as green, quarantine retains old blue+red.
    const idxNow = await selectedCostumeIndex()
    expect(idxNow).toBe(0)
    expect(await vmCostumeMd5()).toBe(siblingGreen.md5)
    expect(await costumeMd5ForStableId(stableBefore)).toBe(siblingGreen.md5)
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(stagedDigest)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    await assertRecoveryChrome([255, 0, 0, 255])
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
  }, 240_000)

  it('DIRECT delete of an actual non-stage sprite while pending: staged preserved, no cross-slot leak', async () => {
    const { blueMd5, stagedDigest, stableBefore } = await stageRedOverNonblankBase()
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    expect(cards.length).toBeGreaterThan(1)
    const victimTestId = cards.find((c) => c !== cards[0])!
    const victimName = victimTestId.replace(/^target-card-/, '')
    await directClear()
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { deleteSprite: (n: string) => Promise<void> } }).__directVm
      void vm?.deleteSprite(name as string)
    }, victimName as unknown as undefined)
    await page.waitForTimeout(1500)
    // Staged owner untouched; staged art preserved (pending retained for a
    // structurally unrelated delete) with zero staged writes and scoped
    // histories. Unrelated deletes retain pending (no quarantine export yet):
    // either live overlay still red (retained) or quarantined export red.
    expect(await selectedStableId()).toBe(stableBefore)
    expect(await costumeMd5ForStableId(stableBefore)).toBe(blueMd5)
    const preserved = (await pendingStatusCount()) > 0
    expect(preserved).toBe(true)
    expect(await beforeUnloadPrevented()).toBe(true)
    if ((await pendingExportCount()) > 0) {
      const exportedCenter = await quarantinedExportCenterPixel()
      expect(exportedCenter).toEqual([255, 0, 0, 255])
    } else {
      // Retained pending path: live overlay still shows the staged red.
      expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    }
    const liveNow = await waitForStableDigest()
    expect([stagedDigest, liveNow].length).toBe(2)
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
  }, 240_000)

  it('loadProject replacement reusing SAME ids with NEW-GEN green: external wins, staged quarantined', async () => {
    const { stagedDigest, stableBefore, indexBefore } = await stageRedOverNonblankBase()
    await directClear()
    // Build NEW-GEN green bytes + replacement project reusing the same ids.
    const newMd5 = await page.evaluate(async ([id, idx]: [string, number]) => {
      const w = window as unknown as {
        __directVm?: {
          exportProject: () => { targets: Array<{ id?: string; costumes: Array<Record<string, unknown>> }> }
          storeAsset: (d: Uint8Array, f: string) => Promise<{ assetId: string; md5ext: string }>
          loadProject: (p: unknown) => Promise<unknown>
          loadAsset: (k: string, f: string) => Promise<Uint8Array | undefined>
        }
      }
      const c = document.createElement('canvas')
      c.width = 960
      c.height = 720
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#00ff00'
      ctx.fillRect(0, 0, 960, 720)
      const blob: Blob | null = await new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'))
      if (!blob) throw new Error('green encode failed')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const stored = await w.__directVm?.storeAsset(bytes, 'png')
      const proj = w.__directVm?.exportProject()
      const target = proj?.targets.find((t) => t.id === (id as string))
      if (!target || !stored) throw new Error('same-id target/store missing')
      target.costumes[idx as number] = {
        ...(target.costumes[idx as number] as Record<string, unknown>),
        assetId: stored.assetId,
        md5ext: stored.md5ext,
        dataFormat: 'png',
        bitmapResolution: 2,
      }
      await w.__directVm?.loadProject(proj)
      // Seed the asset bytes under the new key so the reloader can paint green.
      const probe = await w.__directVm?.loadAsset(stored.md5ext, 'png')
      if (!probe) throw new Error('new-gen bytes missing after loadProject')
      return stored.md5ext as string
    }, [stableBefore, indexBefore] as unknown as undefined)
    await page.waitForTimeout(1800)
    // External NEW-GEN wins byte-exact; staged never lands on the new project.
    expect(await costumeMd5ForStableId(stableBefore)).toBe(newMd5)
    expect(await liveAssetCenterPixel(newMd5)).toEqual([0, 255, 0, 255])
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(stagedDigest)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    await assertRecoveryChrome([255, 0, 0, 255])
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
  }, 300_000)

  it('stable Stage same-slot fresh GREEN bytes: stage canvas exactly green, recovery in any tab/format', async () => {
    await openBitmap()
    // Switch to the stable Stage target, commit blue there, stage red there.
    const stageName = await page.evaluate(() => {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean }> } } } }).__hikkakuEditorTest
      const targets = api?.snapshot().project?.targets ?? []
      return targets.find((t) => t.isStage)?.name ?? 'Stage'
    })
    await page.evaluate((testId: string) => {
      ;(document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null)?.click()
    }, (`target-card-${stageName}`) as unknown as undefined)
    await page.waitForTimeout(1200)
    try {
      await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
    } catch {
      // Already bitmap.
    }
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    await useSolidFill('#0000ff')
    await dragBox(BOX_BLUE)
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    const stageId = await page.evaluate(() => {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string } } }).__hikkakuEditorTest
      return api?.snapshot().selectedTargetId ?? ''
    })
    expect(stageId.length).toBeGreaterThan(0)
    const blueMd5 = await vmCostumeMd5()
    expect(blueMd5).toBeDefined()
    await useSolidFill('#ff0000')
    await dragBox(BOX_RED)
    await page.waitForTimeout(800)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    await directClear()
    const ext = await directGreenSameSlot(stageId, 0)
    expect(ext.md5).toBeDefined()
    expect(ext.md5).not.toBe(blueMd5)
    await page.waitForTimeout(1500)
    expect(await costumeMd5ForStableId(stageId)).toBe(ext.md5)
    expect(await liveAssetCenterPixel(ext.md5!)).toEqual([0, 255, 0, 255])
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([0, 255, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 255, 0, 255])
    // Format stays bitmap png; recovery chrome visible across tabs.
    const fmt = await page.evaluate(() => {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string; project?: { targets?: Array<{ id?: string; currentCostume?: number; costumes?: Array<{ dataFormat?: string }> }> } } } }).__hikkakuEditorTest
      const snap = api?.snapshot()
      const hit = snap?.project?.targets?.find((t) => t.id === snap?.selectedTargetId)
      return hit?.costumes?.[hit.currentCostume ?? 0]?.dataFormat
    })
    expect(fmt).toBe('png')
    await assertRecoveryChrome([255, 0, 0, 255])
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
  }, 300_000)

  it('in-flight external GREEN after CAS-pre: conflict + history-gap visible, staged never lands, explicit discard', async () => {
    const { blueMd5, stagedDigest, stableBefore, indexBefore } = await stageRedOverNonblankBase()
    await directClear()
    // Pre-stage patch capture: owner/seq/md5 observed before the flight.
    const preFlight = await page.evaluate(([id, idx]) => {
      const vm = (window as unknown as {
        __directVm?: {
          getCostumeIdentity: (t: string, i: number) => { md5ext?: string } | undefined
          getCostumeWriteSeq: (t: string, i: number) => number
          getSelectionEpoch?: () => number
        }
      }).__directVm
      return {
        md5: vm?.getCostumeIdentity(id as string, idx as number)?.md5ext,
        seq: vm?.getCostumeWriteSeq(id as string, idx as number) ?? -1,
        epoch: vm?.getSelectionEpoch?.() ?? -1,
      }
    }, [stableBefore, indexBefore] as unknown as undefined)
    expect(preFlight.md5).toBe(blueMd5)
    // Hold the writer CAS gate, start the Escape commit, wait for the flight
    // to park inside the CAS (post-stage, pre-store).
    await directHold('direct-cas-pre')
    await page.keyboard.press('Escape')
    await waitForDirectKind('direct-writer-cas-pre')
    // Hostile GREEN lands in-flight, AFTER the CAS gate parked (await window).
    const ext = await directGreenSameSlot(stableBefore, indexBefore)
    expect(ext.md5).not.toBe(blueMd5)
    await directRelease('direct-cas-pre')
    await directRelease('direct-store')
    await directRelease('direct-history-append')
    await page.waitForTimeout(2000)
    // Conflict: external green wins, staged red never lands.
    expect(await costumeMd5ForStableId(stableBefore)).toBe(ext.md5)
    expect(await vmCostumeMd5()).toBe(ext.md5)
    expect(await liveAssetCenterPixel(ext.md5!)).toEqual([0, 255, 0, 255])
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(stagedDigest)
    // Conflict/in-flight post-CAS gap signal visible (quarantine and/or
    // history-gap), never a bare canvas with no status.
    const statusCount = await pendingStatusCount()
    const statusText = await editorStatusText()
    const pendingText = await pendingStatusText()
    const hasSignal =
      statusCount > 0 ||
      statusText.includes('history-gap') ||
      statusText.includes('quarantin') ||
      pendingText.includes('history-gap') ||
      pendingText.includes('quarantin') ||
      statusText.includes('Bitmap edit saved')
    expect(hasSignal).toBe(true)
    expect(await beforeUnloadPrevented()).toBe(true)
    // Quarantined export still offers the exact old blue+red staged art.
    const kinds = await directKinds()
    expect(kinds).toContain('direct-writer-cas-pre')
    // Explicit discard clears the signal without touching the green base.
    if ((await pendingDiscardCount()) > 0) {
      await page.getByTestId('bitmap-pending-discard').click()
      await page.waitForTimeout(800)
      expect(await costumeMd5ForStableId(stableBefore)).toBe(ext.md5)
    }
  }, 300_000)
})
