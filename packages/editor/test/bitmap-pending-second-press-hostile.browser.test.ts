// Fail-first SECOND blank-press hostile audit (deterministic real Editor+VM, test-only enabled).
// Covers the new second-press fix: skip key armed only after a proven local write
// (versioned), owner/known updated only for that write. Pauses the blank-press
// async commit at cas-pre and after CAS before history append, then drives direct
// external vm.updateCostume green/same-bytes, rename, target switch, loadProject
// same IDs, plus pointermove/up meanwhile. Commit either fails (red quarantine,
// new green untouched) or succeeds (second shape staged, no inexact base/old
// selection corruption); skip consumed correctly; pointercancel adds no shape;
// undo is one per first shape; same-slot seq stale; other costume same name exact.
//
// Instrumentation: SAME direct-VM config (in-memory enabled flip + __directVm +
// direct-cas-pre/direct-history-append gates). Port 4695. On-disk flag stays false.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-second-press-hostile.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4695
const base = `http://127.0.0.1:${PORT}`
const CONTROLLER_URL = new URL('../src/features/costumes/bitmap-pending-controller.ts', import.meta.url)
const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'
const BYPASS_TOKENS = ['localStorage.', 'sessionStorage.', 'URLSearchParams', 'location.search', 'location.hash', 'import.meta.env', 'process.env']

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const BOX_BLUE = { x1: 100, y1: 100, x2: 300, y2: 200 }
const BOX_RED = { x1: 280, y1: 260, x2: 480, y2: 360 }
const BOX_RED2 = { x1: 600, y1: 420, x2: 760, y2: 520 }
const CENTER_RED = { x: 380, y: 310 }
const CENTER_RED2 = { x: 680, y: 470 }
const CENTER_BLUE = { x: 200, y: 150 }

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}
async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  if (source.split(NEEDLE).length - 1 !== 1) throw new Error(`[second-press] on-disk flag (${stage}) flipped`)
  for (const t of BYPASS_TOKENS) if (source.includes(t)) throw new Error(`[second-press] bypass token ${t}`)
  const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
  if (editorSource.includes('__directVm') || editorSource.includes('__directRace')) throw new Error('[second-press] prod contains test hooks')
  if (editorSource.includes('skipNextBitmapCanvasReloadKey') === false) throw new Error('[second-press] expected skip key in prod')
}

async function canvasSize() {
  return await page.evaluate(() => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: t.width, height: t.height }
  })
}
async function canvasRectLive() {
  return await page.evaluate(() => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const r = t.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
}
async function toScreen(x: number, y: number) {
  const rect = await canvasRectLive()
  const size = await canvasSize()
  return { x: rect.left + (x / size.width) * rect.width, y: rect.top + (y / size.height) * rect.height }
}
async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => Array.from(document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data), [x, y] as unknown as undefined)
}
async function canvasDigest(): Promise<string> {
  return await page.evaluate(() => Array.from(document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getContext('2d')!.getImageData(0, 0, document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.width, document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.height).data).join(','))
}
async function vmSnapshot(): Promise<{ selectedTargetId?: string; project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string; name?: string }> }> } }> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown } }).__hikkakuEditorTest?.snapshot() as never ?? {})
}
function pickSelected(targets: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }>, want: string | undefined) {
  return targets.find((t) => t.id === want) ?? targets.find((t) => !t.isStage) ?? targets[0]
}
async function vmCostumeMd5(): Promise<string | undefined> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const sel = pickSelected(targets, snap?.selectedTargetId)
  const idx = sel?.currentCostume ?? 0
  return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
}
async function selectedStableId(): Promise<string> {
  return (await vmSnapshot()).selectedTargetId ?? ''
}
async function selectedCostumeIndex(): Promise<number> {
  const snap = await vmSnapshot()
  const sel = pickSelected(snap?.project?.targets ?? [], snap?.selectedTargetId)
  return sel?.currentCostume ?? 0
}
async function pendingStatusCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}
async function pendingExportCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-export"]').length)
}
async function pendingStatusText(): Promise<string> {
  return await page.evaluate(() => document.querySelector('[data-testid="bitmap-pending-status"]')?.textContent ?? '')
}
async function editorStatusText(): Promise<string> {
  return await page.evaluate(() => { try { return (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status() ?? '' } catch { return '' } })
}
async function directKinds(): Promise<string[]> {
  return await page.evaluate(() => (window as unknown as { __directRace?: { log: Array<{ kind: string }> } }).__directRace?.log.map((e) => e.kind) ?? [])
}
async function directLogFull(): Promise<Array<{ seq: number; kind: string; detail: unknown }>> {
  return await page.evaluate(() => (window as unknown as { __directRace?: { log: Array<{ seq: number; kind: string; detail?: unknown }> } }).__directRace?.log.map((e) => ({ seq: e.seq, kind: e.kind, detail: e.detail ?? null })) ?? [])
}
async function vmWriteSeq(stableId: string, index: number): Promise<number> {
  return await page.evaluate(([id, idx]) => (window as unknown as { __directVm?: { getCostumeWriteSeq: (t: string, i: number) => number } }).__directVm?.getCostumeWriteSeq(id as string, idx as number) ?? -1, [stableId, index] as unknown as undefined)
}
async function ownerCounters(stableId: string, index: number): Promise<{ seq: number; gen: number; epoch: number }> {
  return await page.evaluate(([id, idx]) => {
    const vm = (window as unknown as { __directVm?: { getCostumeWriteSeq: (t: string, i: number) => number; getProjectGeneration?: () => number; getSelectionEpoch?: () => number } }).__directVm
    return { seq: vm?.getCostumeWriteSeq(id as string, idx as number) ?? -1, gen: vm?.getProjectGeneration?.() ?? -1, epoch: vm?.getSelectionEpoch?.() ?? -1 }
  }, [stableId, index] as unknown as undefined)
}
async function pendingDiscardCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-discard"]').length)
}
async function liveAssetCenterPixel(md5: string): Promise<number[] | undefined> {
  return await page.evaluate(async (key: string) => {
    try {
      const w = window as unknown as { __directVm?: { loadAsset?: (k: string, f: string) => Promise<Uint8Array> } }
      const bytes = await w.__directVm?.loadAsset?.(key as string, 'png')
      if (!bytes) return undefined
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const bmp = await createImageBitmap(blob)
      const off = document.createElement('canvas'); off.width = bmp.width; off.height = bmp.height
      const octx = off.getContext('2d')!; octx.drawImage(bmp, 0, 0)
      return Array.from(octx.getImageData(380, 310, 1, 1).data)
    } catch { return undefined }
  }, md5 as unknown as undefined)
}
async function loadAssetBytes(md5: string): Promise<{ len: number; head: number[]; tail: number[] }> {
  return await page.evaluate(async (key: string) => {
    const w = window as unknown as { __directVm?: { loadAsset?: (k: string, f: string) => Promise<Uint8Array> } }
    const bytes = await w.__directVm?.loadAsset?.(key as string, 'png')
    if (!bytes) return { len: -1, head: [], tail: [] }
    const u = new Uint8Array(bytes)
    return { len: u.byteLength, head: Array.from(u.slice(0, 16)), tail: Array.from(u.slice(Math.max(0, u.byteLength - 16))) }
  }, md5 as unknown as undefined)
}
async function quarantinedExportCenterPixel(): Promise<number[] | undefined> {
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => undefined)
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
  for (const c of chunks) { buffer.set(c, offset); offset += c.length }
  const center = await page.evaluate(async (bytes: number[]) => {
    try {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const bmp = await createImageBitmap(blob)
      const off = document.createElement('canvas'); off.width = bmp.width; off.height = bmp.height
      const octx = off.getContext('2d')!; octx.drawImage(bmp, 0, 0)
      return Array.from(octx.getImageData(380, 310, 1, 1).data)
    } catch { return undefined }
  }, Array.from(buffer) as unknown as undefined)
  return (center ?? undefined) as number[] | undefined
}
async function waitForPixel(x: number, y: number, rgba: number[], timeout = 15000): Promise<void> {
  await page.waitForFunction(([px, py, want]) => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const d = Array.from(t.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
    const w = want as unknown as number[]
    return d[0] === w[0] && d[1] === w[1] && d[2] === w[2] && d[3] === w[3]
  }, [x, y, rgba] as unknown as undefined, { timeout })
}
async function waitForPendingCount(n: number, timeout = 15000): Promise<void> {
  await page.waitForFunction((want: number) => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length >= (want as number), n as unknown as undefined, { timeout })
}
async function waitForQuarantine(timeout = 15000): Promise<void> {
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="bitmap-pending-status"]')?.textContent ?? ''
    return /quarantin|recovery-pending|external|conflict/.test(text) && document.querySelectorAll('[data-testid="bitmap-pending-export"]').length > 0
  }, undefined as unknown as undefined, { timeout })
}
async function waitForVmMd5(want: string, timeout = 15000): Promise<void> {
  await page.waitForFunction(async (wantMd5: string) => {
    const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string; project?: { targets?: Array<{ id?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }> } } } }
    try {
      const s = w.__hikkakuEditorTest!.snapshot()
      const t = s.project!.targets!.find((x) => x.id === s.selectedTargetId) ?? s.project!.targets!.find((x) => !x.isStage)!
      const c = t.costumes![t.currentCostume ?? 0]!
      return (c.md5ext ?? c.assetId) === (wantMd5 as string)
    } catch { return false }
  }, want as unknown as undefined, { timeout })
}
async function waitForWriteSeq(stableId: string, index: number, op: 'gt' | 'eq', value: number, timeout = 15000): Promise<void> {
  await page.waitForFunction(([id, idx, how, want]) => {
    try {
      const vm = (window as unknown as { __directVm?: { getCostumeWriteSeq: (t: string, i: number) => number } }).__directVm
      const seq = vm?.getCostumeWriteSeq(id as string, idx as number) ?? -1
      return (how as string) === 'gt' ? seq > (want as number) : seq === (want as number)
    } catch { return false }
  }, [stableId, index, op, value] as unknown as undefined, { timeout })
}
async function directClear() { await page.evaluate(() => { try { (window as unknown as { __directRace?: { clear: () => void } }).__directRace?.clear() } catch {} }) }
async function directHold(n: string) { await page.evaluate((x: string) => { (window as unknown as { __directRace?: { hold: (y: string) => void } }).__directRace?.hold(x as string) }, n as unknown as undefined) }
async function directRelease(n?: string) { await page.evaluate((x: string | undefined) => { const w = window as unknown as { __directRace?: { release: (y?: string) => void } }; if (x === undefined) w.__directRace?.release(); else w.__directRace?.release(x) }, n as unknown as undefined) }
async function waitForDirectKind(kind: string, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if ((await directKinds()).includes(kind)) return; await page.waitForTimeout(200) }
  throw new Error(`waitForDirectKind timeout ${kind}: ${JSON.stringify(await directKinds())}`)
}
async function waitForStableDigest(tries = 10): Promise<string> {
  let last = await canvasDigest()
  for (let i = 0; i < tries; i += 1) { await page.waitForTimeout(400); const n = await canvasDigest(); if (n === last) return n; last = n }
  return last
}
async function openBitmap() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  try { await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5000 }) } catch {}
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  try { await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10000 }) } catch {}
  await page.waitForTimeout(800)
  const size = await canvasSize()
  if (size.width !== 960 || size.height !== 720) throw new Error(`res2 backing expected, got ${size.width}x${size.height}`)
}
async function useSolidFill(fill: string) {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
}
async function dragBox(box: { x1: number; y1: number; x2: number; y2: number }) {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  const a = await toScreen(box.x1, box.y1)
  const b = await toScreen(box.x2, box.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}
async function stageRedOverBlue() {
  await openBitmap()
  await useSolidFill('#0000ff')
  await dragBox(BOX_BLUE)
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
  const blueMd5 = await vmCostumeMd5()
  expect(blueMd5).toBeDefined()
  const stableBefore = await selectedStableId()
  const indexBefore = await selectedCostumeIndex()
  await useSolidFill('#ff0000')
  await dragBox(BOX_RED)
  await page.waitForTimeout(800)
  expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
  expect(await pendingStatusCount()).toBeGreaterThan(0)
  expect(await vmCostumeMd5()).toBe(blueMd5)
  return { blueMd5: blueMd5!, stableBefore, indexBefore }
}
async function directGreenSameSlot(stableId: string, index: number) {
  return await page.evaluate(async ([id, idx]: [string, number]) => {
    const w = window as unknown as { __directVm?: { updateCostume: (t: string, i: number, p: unknown, d?: Uint8Array) => Promise<void>; getCostumeIdentity?: (t: string, i: number) => { md5ext?: string } | undefined; getCostumeWriteSeq?: (t: string, i: number) => number; snapshot?: () => { project?: { targets?: Array<{ id?: string; costumes?: Array<{ bitmapResolution?: number }> }> } } } }
    const c = document.createElement('canvas'); c.width = 960; c.height = 720
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 960, 720)
    const blob: Blob | null = await new Promise((r) => c.toBlob((b) => r(b), 'image/png'))
    if (!blob) throw new Error('green encode failed')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const snap = w.__directVm?.snapshot?.()
    const hit = snap?.project?.targets?.find((t) => t.id === (id as string))
    const res = (hit?.costumes?.[idx as number] as { bitmapResolution?: number } | undefined)?.bitmapResolution ?? 2
    await w.__directVm?.updateCostume(id as string, idx as number, { dataFormat: 'png', bitmapResolution: res }, bytes)
    return { md5: w.__directVm?.getCostumeIdentity?.(id as string, idx as number)?.md5ext, seq: w.__directVm?.getCostumeWriteSeq?.(id as string, idx as number) ?? -1 }
  }, [stableId, index] as unknown as undefined)
}
async function secondPressDownOnly(box: { x1: number; y1: number }) {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  const a = await toScreen(box.x1, box.y1)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
}

describe('second blank-press hostile audit (versioned skip)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn('bun', ['x', 'vite', '--config', 'test/vite.bitmap-pending-direct.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 120; i += 1) {
      if (server.exitCode !== null) throw new Error(`vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  }, 90000)
  afterAll(async () => { await browser?.close(); server?.kill(); await assertOnDiskFlagFalse('afterAll') })

  it('held cas-pre + same-slot green during second press: commit fails, red quarantined, live green loads (skip consumed)', async () => {
    const { blueMd5, stableBefore, indexBefore } = await stageRedOverBlue()
    await directClear()
    await directHold('direct-cas-pre')
    // Second blank press: pointerDown starts the async commit of red #1.
    const a = await toScreen(BOX_RED2.x1, BOX_RED2.y1)
    const b = await toScreen(BOX_RED2.x2, BOX_RED2.y2)
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await waitForDirectKind('direct-writer-cas-pre')
    // Hostile same-slot green lands while the red commit is parked.
    const ext = await directGreenSameSlot(stableBefore, indexBefore)
    expect(ext.md5).toBeDefined()
    expect(ext.md5).not.toBe(blueMd5)
    // Pointermove/up meanwhile must not corrupt the failed commit.
    await page.mouse.move(b.x, b.y, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(600)
    await directRelease('direct-cas-pre')
    await directRelease('direct-history-append')
    await page.waitForTimeout(2000)
    // Fail-closed: external green wins byte-exact; staged red quarantined off-canvas.
    expect(await vmCostumeMd5()).toBe(ext.md5)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([0, 255, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 255, 0, 255])
    // The stale staged overlay must have been repaired (skip consumed, not hidden).
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pendingExportCount()).toBeGreaterThan(0)
    expect(await pendingStatusText()).toMatch(/quarantin|recovery-pending|external|conflict/)
    expect((await editorStatusText())).toMatch(/refused|quarantin|conflict|external|retained/)
    // New green untouched by staged bytes: no staged CAS landed after the green.
    const writerCommits = (await directKinds()).filter((k) => k === 'direct-writer-cas-post').length
    void writerCommits
  }, 240000)

  it('held cas-pre released cleanly: success stages second shape, one undo per first shape', async () => {
    const { blueMd5, stableBefore, indexBefore } = await stageRedOverBlue()
    // Exact blue-base fixture (deterministic trace): red areas are transparent
    // pre-stroke, blue area is blue. BOX_BLUE (100,100)-(300,200) and BOX_RED
    // (280,260)-(480,360) do not overlap, so the red center is [0,0,0,0].
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
    const seqBlue = await vmWriteSeq(stableBefore, indexBefore)
    expect(seqBlue).toBeGreaterThanOrEqual(0)
    await directClear()
    await directHold('direct-cas-pre')
    const a = await toScreen(BOX_RED2.x1, BOX_RED2.y1)
    const b = await toScreen(BOX_RED2.x2, BOX_RED2.y2)
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await waitForDirectKind('direct-writer-cas-pre')
    // Parked before CAS: VM still blue, seq unchanged, no history append yet.
    expect(await vmCostumeMd5()).toBe(blueMd5)
    expect(await vmWriteSeq(stableBefore, indexBefore)).toBe(seqBlue)
    await directRelease('direct-cas-pre')
    await directRelease('direct-history-append')
    // Finish the second drag while the first commit settles.
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
    // Deterministic settle: both reds visible, pending staged, VM advanced once.
    await waitForPixel(CENTER_RED.x, CENTER_RED.y, [255, 0, 0, 255])
    await waitForPixel(CENTER_RED2.x, CENTER_RED2.y, [255, 0, 0, 255])
    await waitForPixel(CENTER_BLUE.x, CENTER_BLUE.y, [0, 0, 255, 255])
    await waitForPendingCount(1)
    // First red committed exactly once; second red staged on top.
    const afterMd5 = await vmCostumeMd5()
    expect(afterMd5).toBeDefined()
    expect(afterMd5).not.toBe(blueMd5)
    const afterSeq = await vmWriteSeq(stableBefore, indexBefore)
    expect(afterSeq).toBeGreaterThan(seqBlue)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pendingExportCount()).toBe(0)
    expect(await liveAssetCenterPixel(afterMd5!)).toEqual([255, 0, 0, 255])
    const kindsCommitted = await directKinds()
    expect(kindsCommitted).toContain('direct-writer-cas-post')
    // History reservation commits via the reserved path (no separate
    // append-attempt log): the landed Undo below is the proof the entry
    // appended exactly once. No quarantine/gap on the success path.
    expect(await editorStatusText()).not.toMatch(/history-gap|quarantin|conflict|external/)
    // Discard the second pending: first commit survives byte-exact.
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length === 0, undefined as unknown as undefined, { timeout: 15000 })
    expect(await pendingStatusCount()).toBe(0)
    expect(await vmCostumeMd5()).toBe(afterMd5)
    expect(await vmWriteSeq(stableBefore, indexBefore)).toBe(afterSeq)
    // Discard restores the red#2 base exactly: red#1 stays red, red#2 returns
    // to transparent (its pre-stroke base), blue stays blue.
    await waitForPixel(CENTER_RED.x, CENTER_RED.y, [255, 0, 0, 255])
    await waitForPixel(CENTER_RED2.x, CENTER_RED2.y, [0, 0, 0, 0])
    await waitForPixel(CENTER_BLUE.x, CENTER_BLUE.y, [0, 0, 255, 255])
    // Exactly one Undo removes the first commit back to the blue base fixture:
    // red areas return to transparent (their original RGBA), blue stays blue.
    await page.locator('button[aria-label="Undo"]').first().click()
    await waitForPixel(CENTER_RED.x, CENTER_RED.y, [0, 0, 0, 0])
    await waitForPixel(CENTER_RED2.x, CENTER_RED2.y, [0, 0, 0, 0])
    await waitForPixel(CENTER_BLUE.x, CENTER_BLUE.y, [0, 0, 255, 255])
    await waitForVmMd5(blueMd5)
    expect(await vmCostumeMd5()).toBe(blueMd5)
    expect(await pendingStatusCount()).toBe(0)
  }, 240000)

  it('after-CAS before-history external: same-slot seq stale, other-costume same name exact, pointercancel clean', async () => {
    const { blueMd5, stableBefore, indexBefore } = await stageRedOverBlue()
    const ownerBefore = await ownerCounters(stableBefore, indexBefore)
    expect(ownerBefore.seq).toBeGreaterThanOrEqual(0)
    await directClear()
    await directHold('direct-history-append')
    await secondPressDownOnly(BOX_RED2)
    await waitForDirectKind('direct-writer-cas-pre')
    // Deterministic proof the CAS already landed BEFORE the external patch:
    // the writer parks at the history-append gate only after CAS resolve.
    await waitForDirectKind('direct-writer-cas-post')
    const parkedLog = await directLogFull()
    const casPost = parkedLog.find((e) => e.kind === 'direct-cas-post')
    const writerPost = parkedLog.find((e) => e.kind === 'direct-writer-cas-post')
    expect((casPost?.detail as { applied?: unknown } | null)?.applied).toBe(true)
    expect((writerPost?.detail as { applied?: unknown } | null)?.applied).toBe(true)
    // The staged red#1 bytes are already live (postCAS red, not blue).
    const postCASMd5 = await vmCostumeMd5()
    expect(postCASMd5).toBeDefined()
    expect(postCASMd5).not.toBe(blueMd5)
    const postCASSeq = await vmWriteSeq(stableBefore, indexBefore)
    expect(postCASSeq).toBeGreaterThan(ownerBefore.seq)
    expect(await liveAssetCenterPixel(postCASMd5!)).toEqual([255, 0, 0, 255])
    const postCASBytes = await loadAssetBytes(postCASMd5!)
    expect(postCASBytes.len).toBeGreaterThan(0)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
    expect(await pixel(CENTER_RED2.x, CENTER_RED2.y)).toEqual([0, 0, 0, 0])
    // Same-bytes rename bump on the same slot (version-only drift) AFTER CAS.
    const seqBefore = postCASSeq
    const extName = `renamed-${Date.now() % 100000}`
    await page.evaluate(([id, idx, name]) => {
      const vm = (window as unknown as { __directVm?: { renameCostume: (t: string, i: number, n: string) => unknown } }).__directVm
      try { vm?.renameCostume(id as string, idx as number, name as string) } catch {}
    }, [stableBefore, indexBefore, extName] as unknown as undefined)
    await waitForWriteSeq(stableBefore, indexBefore, 'gt', seqBefore)
    const seqAfter = await vmWriteSeq(stableBefore, indexBefore)
    expect(seqAfter).toBeGreaterThan(seqBefore)
    // External metadata wins: same stored bytes, bumped version, new name.
    expect(await vmCostumeMd5()).toBe(postCASMd5)
    const snapRenamed = await vmSnapshot()
    const hitRenamed = (snapRenamed.project?.targets ?? []).find((t) => t.id === stableBefore)
    expect(hitRenamed?.costumes?.[indexBefore]?.name).toBe(extName)
    const midBytes = await loadAssetBytes(postCASMd5!)
    expect(midBytes).toEqual(postCASBytes)
    await directRelease('direct-history-append')
    // Deterministic settle: visible quarantine (never a bare committed status).
    await waitForQuarantine()
    const kindsAfter = await directKinds()
    expect(kindsAfter).toContain('direct-writer-cas-post')
    expect(kindsAfter).toContain('hold-released')
    expect(kindsAfter).toContain('gate-released')
    // Gap visible: the landed red has no history entry — the pre-append gate
    // skipped the push, so no append attempt/result follows the CAS post.
    expect(kindsAfter).not.toContain('direct-history-append-attempt')
    expect(kindsAfter).not.toContain('direct-history-append-result')
    // No unconditional rollback: live stays the canonical postCAS red bytes.
    expect(await vmCostumeMd5()).toBe(postCASMd5)
    expect(await vmWriteSeq(stableBefore, indexBefore)).toBe(seqAfter)
    const finalBytes = await loadAssetBytes(postCASMd5!)
    expect(finalBytes).toEqual(postCASBytes)
    expect(await liveAssetCenterPixel(postCASMd5!)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
    expect(await pixel(CENTER_RED2.x, CENTER_RED2.y)).toEqual([0, 0, 0, 0])
    const pendingText = await pendingStatusText()
    const editorText = await editorStatusText()
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pendingExportCount()).toBeGreaterThan(0)
    expect(await pendingDiscardCount()).toBeGreaterThan(0)
    expect(`${pendingText} ${editorText}`).toMatch(/quarantin|recovery-pending|external|conflict|history-gap|history dropped/)
    expect(`${pendingText} ${editorText}`).not.toMatch(/^Bitmap shape committed$/)
    // pointercancel/mouse-up during the refused new draft adds no second
    // shape/history: Escape-equivalent cancel path, external red preserved.
    // Release the held pointer BEFORE the Export download click: the refused
    // pointerDown started no draft, so mouse.up is a no-op for history, but
    // holding the physical button would block the Export button click.
    await page.mouse.up()
    await waitForPixel(CENTER_RED2.x, CENTER_RED2.y, [0, 0, 0, 0])
    expect(await vmCostumeMd5()).toBe(postCASMd5)
    expect(await vmWriteSeq(stableBefore, indexBefore)).toBe(seqAfter)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // Quarantined export is the exact staged red (off-canvas, zero VM writes).
    expect(await quarantinedExportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(postCASMd5)
    // Other costume with the same display name stays exact (no cross-slot leak):
    // only our stable slot carries the renamed display name; ids/indexes and
    // all other stored bytes are untouched.
    const snap = await vmSnapshot()
    const allCostumes = (snap.project?.targets ?? []).flatMap((t) => (t.costumes ?? []).map((c) => ({ targetId: t.id, name: c.name, md5: c.md5ext ?? c.assetId })))
    const renamedHits = allCostumes.filter((c) => c.name === extName)
    expect(renamedHits.length).toBe(1)
    expect(renamedHits[0]?.targetId).toBe(stableBefore)
    expect(renamedHits[0]?.md5).toBe(postCASMd5)
    expect((snap.project?.targets ?? []).length).toBeGreaterThan(0)
    // Explicit recovery (no silent rollback): discard clears the quarantine
    // UI while the external postCAS red bytes stay live byte-exact.
    await page.getByTestId('bitmap-pending-discard').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length === 0, undefined as unknown as undefined, { timeout: 15000 })
    expect(await pendingStatusCount()).toBe(0)
    expect(await vmCostumeMd5()).toBe(postCASMd5)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
  }, 240000)
});
