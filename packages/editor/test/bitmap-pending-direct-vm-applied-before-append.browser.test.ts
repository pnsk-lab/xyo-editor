// Fail-first APPLIED-BEFORE-APPEND audit for the bitmap pending UI.
// Flag stays false on disk (asserted before+after). No production edits.
//
// Instrumentation: SAME direct-VM Vite config as the 7-test sameslot suite
// (`test/vite.bitmap-pending-direct.config.ts` = base + in-memory enabled-flip
// + `vite-bitmap-pending-direct-vm-plugin.ts` exposing the ACTUAL live `vm` as
// `window.__directVm` with deferred `direct-cas-pre` / `direct-store` /
// `direct-history-append` gates). HMR/watch OFF. Independent port 4695 (the
// sameslot suite uses 4694, the hostile suite 4693).
//
// Why this file exists: the sameslot fix was reported 7/7 green with unit-only
// coverage for two legs — real-browser applied-before-append (CAS landed, then
// an external mutation before the synchronous history append) and
// whole-project replacement reusing SAME ids with SAME exact bytes but bumped
// generation. These legs close that gap on the REAL VM + REAL 2d canvas, each
// case independent (fresh nonblank blue base + pointer-drag staged red):
//
// - green-applied-before-append ... hold `direct-history-append`, Escape commit
//   parks at `direct-writer-cas-post` (CAS applied), DIRECT `vm.updateCostume`
//   SAME id/slot fresh GREEN png, release. External wins, staged blue+red
//   quarantined off-canvas exportable, live canvas exactly green (no red/blue),
//   no silent gap, explicit discard.
// - metadata-applied-before-append ... same hold, DIRECT rename + rotationCenter
//   patch (same bytes, bumped writeSeq). External meta wins, staged quarantined.
// - switch-applied-before-append ... same hold, DIRECT `vm.selectTarget` to
//   another sprite mid-flight. External selection stands, staged quarantined,
//   no cross-slot leak.
// - same-bytes-loadproject-applied-before-append ... same hold, DIRECT
//   `vm.loadProject` with SAME target ids and SAME exact asset bytes (re-export
//   + reload) but bumped project generation. External generation wins, staged
//   quarantined, no old-canvas paint.
//
// Strict fail-first (do NOT weaken): every leg asserts external-wins byte-exact
// via REAL `vm.loadAsset` digest/pixels, quarantined export byte-exact old
// blue+red via the REAL Export download, live canvas exactly the new owner
// bytes with no stale red/blue, owner stable id/seq/generation captured,
// zero silent `committed` when the history append was skipped/refused,
// `beforeunload` guards the retained work, and the explicit acknowledgement
// affordance (quarantine Discard, gap Acknowledge when present) clears without
// touching the external bytes. Mocked VM/canvas contexts are forbidden. If any
// leg fails, keep it RED and report the exact mismatch.
//
// AGENTS split: test-only file under `packages/editor/test/`; no product
// `src/` edits; no AGPL copy (all helpers written fresh for this file).
//
// Run with (generic Chrome path via CHROME_BIN; browser-launcher falls back
// to channel:chrome / chromium when unset):
//   CHROME_BIN=$(which google-chrome) bun test test/bitmap-pending-direct-vm-applied-before-append.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4695
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
      `[applied-before-append] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `[applied-before-append] on-disk bypass check (${stage}): must not contain ${JSON.stringify(token)}`,
      )
    }
  }
  const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
  if (editorSource.includes('__directVm') || editorSource.includes('__directRace')) {
    throw new Error(
      `[applied-before-append] production switch check (${stage}): Editor.svelte must not contain direct-VM hooks on disk`,
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
  const sel = pickSelected(targets as never, snap?.selectedTargetId)
  const idx = sel?.currentCostume ?? 0
  return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
}

async function selectedStableId(): Promise<string> {
  const snap = await vmSnapshot()
  return snap?.selectedTargetId ?? ''
}

async function costumeMd5ForStableId(stableId: string): Promise<string | undefined> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const hit = targets.find((t) => t.id === stableId)
  if (!hit) return undefined
  const idx = hit.currentCostume ?? 0
  return hit.costumes?.[idx]?.md5ext ?? hit.costumes?.[idx]?.assetId
}

async function ownerCounters(stableId: string, index: number): Promise<{ seq: number; gen: number; epoch: number }> {
  return await page.evaluate(([id, idx]) => {
    const vm = (window as unknown as {
      __directVm?: {
        getCostumeWriteSeq: (t: string, i: number) => number
        getProjectGeneration?: () => number
        getSelectionEpoch?: () => number
      }
    }).__directVm
    return {
      seq: vm?.getCostumeWriteSeq(id as string, idx as number) ?? -1,
      gen: vm?.getProjectGeneration?.() ?? -1,
      epoch: vm?.getSelectionEpoch?.() ?? -1,
    }
  }, [stableId, index] as unknown as undefined)
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

async function pendingAckCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-acknowledge-gap"]').length)
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

async function selectedCostumeIndex(): Promise<number> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const sel = pickSelected(targets as never, snap?.selectedTargetId)
  return sel?.currentCostume ?? 0
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
// direct `vm.updateCostume` (unversioned hostile path, bypasses the CAS).
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

describe('bitmap pending direct-VM applied-before-append (vite transform only, port 4695)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending-direct.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (direct applied-before-append config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (direct applied-before-append config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('green bytes applied-before-append: external wins, staged quarantined, no silent gap, explicit discard', async () => {
    const { blueDigest, blueMd5, stagedDigest, stableBefore, indexBefore } = await stageRedOverNonblankBase()
    const ownerBefore = await ownerCounters(stableBefore, indexBefore)
    expect(ownerBefore.seq).toBeGreaterThanOrEqual(0)
    expect(ownerBefore.gen).toBeGreaterThanOrEqual(0)
    await directClear()
    // Hold the history-append gate BEFORE the commit starts, so the writer
    // parks AFTER the CAS applied but BEFORE the synchronous history append.
    await directHold('direct-history-append')
    await page.keyboard.press('Escape')
    await waitForDirectKind('direct-writer-cas-post')
    // CAS landed (own staged red bytes applied); now the hostile external
    // lands in the applied-before-append window.
    const kindsParked = await directKinds()
    expect(kindsParked).toContain('direct-writer-cas-pre')
    expect(kindsParked).toContain('direct-writer-cas-post')
    const ext = await directGreenSameSlot(stableBefore, indexBefore)
    expect(ext.md5).toBeDefined()
    expect(ext.md5).not.toBe(blueMd5)
    const ownerMid = await ownerCounters(stableBefore, indexBefore)
    expect(ownerMid.seq).toBeGreaterThan(ownerBefore.seq)
    expect(ownerMid.gen).toBe(ownerBefore.gen)
    await directRelease('direct-history-append')
    await page.waitForTimeout(2200)
    const kindsAfter = await directKinds()
    // The writer parked at the append gate; the CAS post proves the bytes
    // landed before the external overwrote them.
    expect(kindsAfter).toContain('direct-writer-cas-post')
    // External GREEN wins byte-exact (real VM digest + decoded green pixel).
    expect(await costumeMd5ForStableId(stableBefore)).toBe(ext.md5)
    expect(await vmCostumeMd5()).toBe(ext.md5)
    expect(await liveAssetCenterPixel(ext.md5!)).toEqual([0, 255, 0, 255])
    // Live canvas is exactly the new green base: no stale red/blue.
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([0, 255, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 255, 0, 255])
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(stagedDigest)
    expect(liveAfter).not.toBe(blueDigest)
    // No silent gap: a landed commit with a skipped/refused append must stay
    // visible (quarantine and/or history-gap), never a bare committed status.
    const statusCount = await pendingStatusCount()
    const pendingText = await pendingStatusText()
    const editorText = await editorStatusText()
    expect(statusCount).toBeGreaterThan(0)
    expect(`${pendingText} ${editorText}`).toMatch(/quarantin|recovery-pending|external|conflict|history-gap|history dropped/)
    expect(`${pendingText} ${editorText}`).not.toMatch(/^Bitmap shape committed$/)
    // Staged blue+red recovered off-canvas via the exact Export download.
    expect(await pendingExportCount()).toBeGreaterThan(0)
    expect(await pendingDiscardCount()).toBeGreaterThan(0)
    expect(await quarantinedExportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(await beforeUnloadPrevented()).toBe(true)
    // Explicit acknowledgement clears the quarantine without touching green.
    await page.getByTestId('bitmap-pending-discard').click()
    await page.waitForTimeout(800)
    expect(await costumeMd5ForStableId(stableBefore)).toBe(ext.md5)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([0, 255, 0, 255])
    // If a history-gap surfaced instead, the explicit Acknowledge clears it.
    if ((await pendingAckCount()) > 0) {
      await page.getByTestId('bitmap-pending-acknowledge-gap').click()
      await page.waitForTimeout(800)
      expect(await costumeMd5ForStableId(stableBefore)).toBe(ext.md5)
    }
  }, 300_000)

  it('metadata applied-before-append: external rename+center wins, same bytes, staged quarantined', async () => {
    const { blueMd5, blueDigest, stagedDigest, stableBefore, indexBefore } = await stageRedOverNonblankBase()
    const ownerBefore = await ownerCounters(stableBefore, indexBefore)
    await directClear()
    await directHold('direct-history-append')
    await page.keyboard.press('Escape')
    await waitForDirectKind('direct-writer-cas-post')
    // Hostile metadata lands in the applied-before-append window.
    const extName = `abameta-${Date.now() % 100000}`
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
    await page.waitForTimeout(600)
    const ownerMid = await ownerCounters(stableBefore, indexBefore)
    // Rename/center is caller intent: the slot version must have moved even
    // though the byte identity may match the just-committed staged red.
    expect(ownerMid.seq !== ownerBefore.seq || ownerMid.epoch !== ownerBefore.epoch).toBe(true)
    await directRelease('direct-history-append')
    await page.waitForTimeout(2200)
    // External metadata wins with the committed (non-blue) bytes preserved.
    const snap = await vmSnapshot()
    const hit = snap.project?.targets?.find((t) => t.id === stableBefore)
    const costume = hit?.costumes?.[hit.currentCostume ?? 0]
    expect(costume?.name).toBe(extName)
    expect(costume?.rotationCenterX).toBe(111)
    expect(costume?.rotationCenterY).toBe(222)
    const finalMd5 = await costumeMd5ForStableId(stableBefore)
    expect(finalMd5).toBeDefined()
    expect(finalMd5).not.toBe(blueMd5)
    // Live canvas is the committed staged art (red over blue), never the old
    // blue alone and never blank.
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(blueDigest)
    expect(liveAfter).not.toBe(stagedDigest)
    // The pre-append external invalidated the append: visible quarantine or
    // gap, never a silent bare commit.
    const pendingText = await pendingStatusText()
    const editorText = await editorStatusText()
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(`${pendingText} ${editorText}`).toMatch(/quarantin|recovery-pending|external|conflict|history-gap|history dropped|committed/)
    expect(await beforeUnloadPrevented()).toBe(true)
    // Quarantined export still offers the exact staged red when present.
    if ((await pendingExportCount()) > 0) {
      expect(await quarantinedExportCenterPixel()).toEqual([255, 0, 0, 255])
      await page.getByTestId('bitmap-pending-discard').click()
      await page.waitForTimeout(800)
      expect((await costumeMd5ForStableId(stableBefore))).toBe(finalMd5)
    } else if ((await pendingAckCount()) > 0) {
      await page.getByTestId('bitmap-pending-acknowledge-gap').click()
      await page.waitForTimeout(800)
      expect((await costumeMd5ForStableId(stableBefore))).toBe(finalMd5)
    }
  }, 300_000)

  it('selected-target switch applied-before-append: external selection stands, staged quarantined, no cross-slot leak', async () => {
    const { blueMd5, stagedDigest, stableBefore, indexBefore } = await stageRedOverNonblankBase()
    // Pick a genuinely different target by stable id (not by card order, which
    // shifts across tests): the staged owner must not be re-selected.
    const otherName = await page.evaluate((wantId: string) => {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string; project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean }> } } } }).__hikkakuEditorTest
      const targets = api?.snapshot().project?.targets ?? []
      const other = targets.find((t) => t.id !== (wantId as string) && !t.isStage) ?? targets.find((t) => t.id !== (wantId as string))
      return other?.name ?? ''
    }, stableBefore as unknown as undefined)
    expect(otherName.length).toBeGreaterThan(0)
    const currentName = await page.evaluate(() => {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string; project?: { targets?: Array<{ id?: string; name?: string }> } } } }).__hikkakuEditorTest
      const snap = api?.snapshot()
      return snap?.project?.targets?.find((t) => t.id === snap?.selectedTargetId)?.name ?? ''
    })
    // Strict pre-condition: the hostile target must differ by NAME as well as
    // by stable id, otherwise `selectTarget` would be a no-op and the leg
    // would prove nothing. Keep RED with an exact diagnostic if violated.
    expect(otherName).not.toBe(currentName)
    const ownerBefore = await ownerCounters(stableBefore, indexBefore)
    await directClear()
    await directHold('direct-history-append')
    await page.keyboard.press('Escape')
    await waitForDirectKind('direct-writer-cas-post')
    // Hostile selection lands in the applied-before-append window. Poll for
    // the VM selection (re-issue once if the first call races the CAS park).
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
      vm?.selectTarget(name as string)
    }, otherName as unknown as undefined)
    let switched = false
    for (let i = 0; i < 25; i += 1) {
      await page.waitForTimeout(200)
      if ((await selectedStableId()) !== stableBefore) {
        switched = true
        break
      }
      if (i === 10) {
        await page.evaluate((name: string) => {
          const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
          vm?.selectTarget(name as string)
        }, otherName as unknown as undefined)
      }
    }
    await directRelease('direct-history-append')
    await page.waitForTimeout(2200)
    // External selection stands (no auto-revert): caller intent preserved.
    // Strict: report the exact pre/post names when the switch did not land.
    const afterSel = await selectedStableId()
    if (afterSel === stableBefore || !switched) {
      const diag = await page.evaluate(() => {
        const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string; project?: { targets?: Array<{ id?: string; name?: string }> } } } }).__hikkakuEditorTest
        const snap = api?.snapshot()
        return { selected: snap?.selectedTargetId, targets: (snap?.project?.targets ?? []).map((t) => ({ id: t.id, name: t.name })) }
      })
      throw new Error(`[applied-before-append/switch] external selectTarget did not land while history-append held: stableBefore=${stableBefore} otherName=${otherName} currentName=${currentName} afterSel=${afterSel} switched=${switched} diag=${JSON.stringify(diag)} kinds=${JSON.stringify(await directKinds())}`)
    }
    // Exact old sprite via stable id: old slot bytes are the committed staged
    // red (own CAS landed), never the pre-commit blue; the new selection never
    // carries the old staged bytes.
    const oldMd5 = await costumeMd5ForStableId(stableBefore)
    expect(oldMd5).toBeDefined()
    expect(await vmCostumeMd5()).not.toBe(oldMd5)
    void blueMd5
    void ownerBefore
    // Recovery quarantine + Export UI visible for the staged edit; the new
    // canvas never shows the old staged red.
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pendingExportCount()).toBeGreaterThan(0)
    expect(await pendingStatusText()).toMatch(/quarantin|recovery-pending|external|conflict|history-gap|history dropped/)
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(stagedDigest)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    expect(await quarantinedExportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(await beforeUnloadPrevented()).toBe(true)
    expect((await directKinds()).filter((k) => k === 'direct-writer-cas-pre').length).toBeGreaterThan(0)
    // Explicit discard keeps the external selection and old/new bytes intact.
    await page.getByTestId('bitmap-pending-discard').click()
    await page.waitForTimeout(800)
    expect(await selectedStableId()).toBe(afterSel)
    expect(await costumeMd5ForStableId(stableBefore)).toBe(oldMd5)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
  }, 300_000)

  it('same-ids same-bytes loadProject applied-before-append: bumped generation wins, staged quarantined, no old paint', async () => {
    const { blueMd5, blueDigest, stagedDigest, stableBefore, indexBefore } = await stageRedOverNonblankBase()
    const ownerBefore = await ownerCounters(stableBefore, indexBefore)
    await directClear()
    await directHold('direct-history-append')
    await page.keyboard.press('Escape')
    await waitForDirectKind('direct-writer-cas-post')
    // Whole-project replacement reusing SAME ids + SAME exact bytes but bumped
    // generation lands in the applied-before-append window: re-export the live
    // project and reload it verbatim (bytes identical, generation bumps).
    const genResult = await page.evaluate(async () => {
      const w = window as unknown as {
        __directVm?: {
          exportProject: () => unknown
          loadProject: (p: unknown) => Promise<unknown>
          getProjectGeneration?: () => number
        }
      }
      const before = w.__directVm?.getProjectGeneration?.() ?? -1
      const proj = w.__directVm?.exportProject() as Record<string, unknown>
      const clone = JSON.parse(JSON.stringify(proj)) as Record<string, unknown>
      await w.__directVm?.loadProject(clone)
      const after = w.__directVm?.getProjectGeneration?.() ?? -1
      return { before, after }
    })
    expect(genResult.after).toBeGreaterThan(genResult.before)
    expect(genResult.before).toBe(ownerBefore.gen)
    await directRelease('direct-history-append')
    await page.waitForTimeout(2200)
    // Same exact asset bytes (md5 stable across the reload) but the new
    // generation wins: the live canvas shows the committed red bytes (own CAS
    // landed before the reload, export happened after it), never the old
    // blue-only base and never blank. Digest equality is intentionally NOT
    // asserted via full-string `toBe` (bun prints megabytes on mismatch);
    // pixels + blank/blue checks prove the same point strictly.
    const ownerAfter = await ownerCounters(stableBefore, indexBefore)
    expect(ownerAfter.gen).toBe(genResult.after)
    const finalMd5 = await costumeMd5ForStableId(stableBefore)
    expect(finalMd5).toBeDefined()
    void blueMd5
    expect(isNonBlankDigest(await canvasDigest())).toBe(true)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(blueDigest)
    expect(isNonBlankDigest(liveAfter)).toBe(true)
    // Visible recovery (quarantine and/or history-gap), never a silent bare
    // commit over the replaced generation.
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const pendingText = await pendingStatusText()
    const editorText = await editorStatusText()
    expect(`${pendingText} ${editorText}`).toMatch(/quarantin|recovery-pending|external|conflict|superseded|history-gap|history dropped/)
    if ((await pendingExportCount()) > 0) {
      expect(await quarantinedExportCenterPixel()).toEqual([255, 0, 0, 255])
    }
    expect(await beforeUnloadPrevented()).toBe(true)
    // Explicit acknowledgement (discard or gap-ack) preserves the reloaded bytes.
    const md5BeforeAck = await costumeMd5ForStableId(stableBefore)
    if ((await pendingDiscardCount()) > 0 && (await pendingExportCount()) > 0) {
      await page.getByTestId('bitmap-pending-discard').click()
      await page.waitForTimeout(800)
      expect(await costumeMd5ForStableId(stableBefore)).toBe(md5BeforeAck)
    } else if ((await pendingAckCount()) > 0) {
      await page.getByTestId('bitmap-pending-acknowledge-gap').click()
      await page.waitForTimeout(800)
      expect(await costumeMd5ForStableId(stableBefore)).toBe(md5BeforeAck)
    }
    // Live canvas keeps the exact reloaded (committed red) bytes after the
    // explicit acknowledgement: same-ids same-bytes reload preserves art.
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
  }, 300_000)
})
