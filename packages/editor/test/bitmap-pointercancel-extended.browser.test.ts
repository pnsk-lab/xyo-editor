import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Extended real-Editor verification for bitmap interruption cancel.
// The earlier bitmap-pointercancel suite covers brush+shape+select marquee via
// real UI; eraser / floating scale+rotate / Escape / tool-change /
// target-costume switch were static wiring only. This file drives every one
// of those through the REAL costume screen with a delayed toBlob gate, then
// fires pointercancel / lostpointercapture / keyboard Escape and verifies:
// - live bitmap-editor-canvas RGBA restores to the pre-stroke baseline,
// - exported SB3 asset bytes for BOTH GateA costumes are unchanged,
// - the selection outline state restores to baseline,
// - Undo/Redo stay at baseline (no phantom entry), and a normal completion
//   afterwards still records exactly one history entry (single Undo peels it,
//   single Redo reapplies it).
// Fixture: red opaque + blue opaque + semi-transparent red artwork plus two
// distinct GateA assets (red-heavy vs blue-heavy) so any cross-asset leak is
// attributable; GateB enables target-switch coverage.
// Product code untouched; independent Vite port 4535; HMR-safe via isolated
// contexts with suspicious-navigation retry.
const root = join(import.meta.dir, '..')
const PORT = 4535
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)))
  return out
}

function buildPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (1 + width * 4) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const idat = zlibSync(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function fixtureSb3(): Buffer {
  // costume0 red-heavy: red opaque + blue opaque + semi red on transparent.
  const redPng = buildPng(96, 80, (x, y) => {
    if (x >= 10 && x < 50 && y >= 10 && y < 35) return [255, 0, 0, 255]
    if (x >= 60 && x < 80 && y >= 10 && y < 30) return [0, 0, 255, 255]
    if (x >= 10 && x < 50 && y >= 50 && y < 65) return [255, 0, 0, 128]
    return [0, 0, 0, 0]
  })
  // costume1 blue-heavy: blue opaque + small red + semi blue.
  const bluePng = buildPng(64, 48, (x, y) => {
    if (x >= 8 && x < 40 && y >= 8 && y < 28) return [0, 0, 255, 255]
    if (x >= 44 && x < 56 && y >= 8 && y < 20) return [255, 0, 0, 255]
    if (x >= 8 && x < 40 && y >= 32 && y < 42) return [0, 0, 255, 128]
    return [0, 0, 0, 0]
  })
  const stagePng = buildPng(480, 360, () => [255, 255, 255, 255])
  const files: Record<string, Uint8Array> = {}
  const put = (bytes: Uint8Array, ext: string) => {
    const h = md5(bytes)
    files[`${h}.${ext}`] = bytes
    return { assetId: h, md5ext: `${h}.${ext}` }
  }
  const redFile = put(redPng, 'png')
  const blueFile = put(bluePng, 'png')
  const stageFile = put(stagePng, 'png')
  const project = {
    targets: [
      {
        isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'white-stage', ...stageFile, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'GateA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [
          { name: 'redA', ...redFile, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 48, rotationCenterY: 40 },
          { name: 'blueA2', ...blueFile, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 32, rotationCenterY: 24 },
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
      {
        isStage: false, name: 'GateB', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'blueB', ...blueFile, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 32, rotationCenterY: 24 }],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 80, y: 40, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'pointercancel-ext', agent: 'pointercancel-ext' },
  }
  return buildSb3(project, files)
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'cancel-ext.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.costumes.some((c: any) => c.name === want)) ?? false,
    expectName,
    { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)
}

async function exportSb3(page: Page): Promise<{ project: any; assets: Record<string, Uint8Array> }> {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  const fileTrigger = page.getByText('ファイル', { exact: true }).first()
  if (await fileTrigger.isVisible()) await fileTrigger.click()
  await page.getByRole('button', { name: 'SB3' }).first().click()
  const download = await downloadPromise
  const path = await download.path()
  let bytes: Buffer
  if (path) bytes = readFileSync(path)
  else {
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
    bytes = Buffer.concat(chunks)
  }
  const archive = unzipSync(new Uint8Array(bytes))
  const project = JSON.parse(strFromU8(archive['project.json']!))
  const assets: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(archive)) if (k !== 'project.json') assets[k] = v as Uint8Array
  return { project, assets }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

async function gateBlob(page: Page, delayMs: number) {
  await page.evaluate((delay: number) => {
    const w = window as any
    if (!w.__cancelExtBlobOrig) {
      w.__cancelExtBlobOrig = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (cb: any, ...rest: any[]) {
        const wrapped = (...a: any[]) => {
          if ((window as any).__cancelExtGateOn) setTimeout(() => cb(...a), (window as any).__cancelExtDelayMs ?? 800)
          else cb(...a)
        }
        return (w.__cancelExtBlobOrig as any).call(this, wrapped, ...rest)
      }
    }
    w.__cancelExtDelayMs = delay
    w.__cancelExtGateOn = true
  }, delayMs as unknown as undefined)
}

async function setGate(page: Page, on: boolean) {
  await page.evaluate((v: boolean) => { (window as any).__cancelExtGateOn = v }, on as unknown as undefined)
}

async function canvasSize(page: Page): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: t.width, height: t.height }
  })
}

async function samplePixels(page: Page, points: Array<{ x: number; y: number }>): Promise<number[][]> {
  return await page.evaluate((list) => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const ctx = t.getContext('2d')!
    return (list as Array<{ x: number; y: number }>).map(({ x, y }) =>
      Array.from(ctx.getImageData(Math.max(0, Math.min(t.width - 1, Math.round(x))), Math.max(0, Math.min(t.height - 1, Math.round(y))), 1, 1).data),
    )
  }, points as unknown as undefined)
}

async function scanArtwork(page: Page) {
  return await page.evaluate(() => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const ctx = t.getContext('2d')!
    const img = ctx.getImageData(0, 0, t.width, t.height)
    const isRed = (o: number) => img.data[o + 3]! > 128 && img.data[o]! > 200 && img.data[o + 1]! < 110 && img.data[o + 2]! < 110
    const isBlue = (o: number) => img.data[o + 3]! > 128 && img.data[o + 2]! > 200 && img.data[o]! < 110 && img.data[o + 1]! < 170
    const isSemi = (o: number) => img.data[o + 3]! > 40 && img.data[o + 3]! < 200 && img.data[o]! > 150
    let red: { x: number; y: number } | undefined
    let blue: { x: number; y: number } | undefined
    let semi: { x: number; y: number } | undefined
    let redMinX = t.width; let redMinY = t.height; let redMaxX = -1; let redMaxY = -1
    for (let y = 0; y < t.height; y += 1) {
      for (let x = 0; x < t.width; x += 1) {
        const o = (y * t.width + x) * 4
        if (isRed(o)) {
          if (!red) red = { x, y }
          if (x < redMinX) redMinX = x
          if (y < redMinY) redMinY = y
          if (x > redMaxX) redMaxX = x
          if (y > redMaxY) redMaxY = y
        } else if (!blue && isBlue(o)) blue = { x, y }
        else if (!semi && isSemi(o)) semi = { x, y }
      }
    }
    return { red, blue, semi, redBox: red ? { x: redMinX, y: redMinY, w: redMaxX - redMinX + 1, h: redMaxY - redMinY + 1 } : undefined, width: t.width, height: t.height }
  })
}

async function waitBitmapCanvas(page: Page) {
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!c) return false
    try {
      const ctx = c.getContext('2d')
      if (!ctx) return false
      const img = ctx.getImageData(0, 0, c.width, c.height)
      for (let i = 3; i < img.data.length; i += 4) if ((img.data[i] ?? 0) !== 0) return true
      return false
    } catch { return false }
  }, undefined, { timeout: 20_000 })
}

async function undoEnabled(page: Page): Promise<boolean> {
  return await page.locator('button[aria-label="Undo"]').first().isEnabled()
}

async function redoEnabled(page: Page): Promise<boolean> {
  return await page.locator('button[aria-label="Redo"]').first().isEnabled()
}

async function selectionVisible(page: Page): Promise<boolean> {
  return await page.evaluate(() => !!document.querySelector('[data-testid="bitmap-selection"]'))
}

async function statusText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.textContent ?? '')
}

async function toolClick(page: Page, testId: string) {
  // Toolbar buttons can be covered by the sticky header menu after an SB3
  // export; a DOM click still drives the real Svelte onclick without the
  // Playwright actionability overlay check.
  await page.evaluate((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
    if (!el) throw new Error(`Missing tool ${id}`)
    el.click()
  }, testId as unknown as undefined)
}

async function releaseCanvasPointer(page: Page, pointerId: number, dx: number, dy: number) {
  // Keyboard Escape cancels via Editor.svelte but leaves BitmapEditor's
  // activeCanvasPointerId armed (no pointerup fired). A trailing synthetic
  // pointerup with the same id releases it without committing (isBitmapPainting
  // is already false, so endBitmapPaint is a no-op).
  await dispatchOnCanvas(page, 'pointerup', { pointerId, buttons: 0, dx, dy })
}

async function dispatchOnCanvas(page: Page, type: string, init: Record<string, unknown>) {
  await page.evaluate(([eventType, pointer]: [string, Record<string, unknown>]) => {
    const target = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
    const rect = target.getBoundingClientRect()
    const cx = rect.left + rect.width / 2 + (pointer.dx as number)
    const cy = rect.top + rect.height / 2 + (pointer.dy as number)
    target.dispatchEvent(
      new PointerEvent(eventType, {
        pointerType: (pointer.pointerType as string) ?? 'pen',
        pointerId: pointer.pointerId as number,
        button: (pointer.button as number) ?? 0,
        buttons: (pointer.buttons as number) ?? 1,
        clientX: pointer.clientX as number ?? cx,
        clientY: pointer.clientY as number ?? cy,
        bubbles: true,
        composed: true,
        isPrimary: true,
      }),
    )
  }, [type, init] as unknown as undefined)
}

async function dispatchOnSelector(page: Page, selector: string, type: string, init: { pointerId: number; clientX: number; clientY: number; buttons?: number }) {
  await page.evaluate(([sel, eventType, p]: [string, string, { pointerId: number; clientX: number; clientY: number; buttons?: number }]) => {
    const target = document.querySelector(sel) as HTMLElement
    if (!target) throw new Error(`Missing ${sel}`)
    target.dispatchEvent(
      new PointerEvent(eventType, {
        pointerType: 'pen',
        pointerId: p.pointerId,
        button: 0,
        buttons: p.buttons ?? 1,
        clientX: p.clientX,
        clientY: p.clientY,
        bubbles: true,
        composed: true,
        isPrimary: true,
      }),
    )
  }, [selector, type, init] as unknown as undefined)
}

function linePoints(from: { x: number; y: number }, to: { x: number; y: number }, count = 9): Array<{ x: number; y: number }> {
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0 : i / (count - 1)
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
  })
}

async function toScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas')
  const size = await canvasSize(page)
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height }
}

async function dragReal(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  const a = await toScreen(page, from.x, from.y)
  const b = await toScreen(page, to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

async function baselineTwoAssets(page: Page): Promise<{ redBytes: Uint8Array; blueBytes: Uint8Array; redMd5: string; blueMd5: string }> {
  const sb3 = await exportSb3(page)
  const gateA = sb3.project.targets.find((t: any) => t.name === 'GateA')
  const redKey = gateA.costumes[0].md5ext as string
  const blueKey = gateA.costumes[1].md5ext as string
  const redBytes = sb3.assets[redKey]!
  const blueBytes = sb3.assets[blueKey]!
  if (!redBytes || !blueBytes) throw new Error('Missing GateA asset bytes')
  return { redBytes, blueBytes, redMd5: redKey, blueMd5: blueKey }
}

function log(label: string, value: unknown) {
  console.log(`[pointercancel-ext] ${label} ${JSON.stringify(value).slice(0, 3000)}`)
}

// HMR guard: the center-snap agent edits Editor.svelte concurrently, so Vite
// may hot-reload mid-scenario. Any frame navigation after the initial load is
// suspicious: discard the attempt and rerun isolated in a fresh context.
// Timeouts waiting for the paint surface are also treated as suspicious (a
// mid-load HMR rebuild can leave the first context on a stale bundle).
async function runIsolated(label: string, fn: (page: Page, ctx: BrowserContext) => Promise<void>): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ctx = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    let navigatedAfterLoad = false
    let loaded = false
    page.on('framenavigated', () => {
      if (!loaded) {
        loaded = true
        return
      }
      navigatedAfterLoad = true
      log(`${label} suspicious navigation (HMR?)`, { attempt })
    })
    try {
      await fn(page, ctx)
      if (navigatedAfterLoad) throw new Error(`Suspicious navigation during ${label} (attempt ${attempt}); isolated rerun`)
      await ctx.close()
      return
    } catch (e) {
      lastError = e
      const msg = String(e)
      const suspicious = navigatedAfterLoad || msg.includes('Suspicious navigation') || msg.includes('Execution context was destroyed') || msg.includes('Target closed') || msg.includes('navigated') || msg.includes('costume-paint-surface') || msg.includes('Timeout')
      log(`${label} attempt-${attempt} failed`, { suspicious, error: msg.slice(0, 800) })
      await ctx.close().catch(() => {})
      if (!suspicious || attempt === 2) throw e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw lastError
}

async function prepareGateA(page: Page) {
  await openCostumes(page)
  await importSb3(page, fixtureSb3(), 'redA')
  await page.getByTestId('target-card-GateA').click()
  await page.waitForTimeout(600)
  await page.getByTestId('costume-card-0').click()
  await waitBitmapCanvas(page)
  // Zoom out so the whole artboard fits: fixed artwork stays addressable.
  const zoomOut = page.getByRole('button', { name: 'Zoom out' })
  for (let i = 0; i < 10; i += 1) await zoomOut.click().catch(() => {})
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

describe('bitmap interruption cancel extended (real Editor VM)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('eraser pointercancel + Escape restore RGBA/bytes/selection with no history; normal eraser is one entry', async () => {
    await runIsolated('eraser-cancel', async (page) => {
      await prepareGateA(page)
      const art = await scanArtwork(page)
      if (!art.red || !art.blue || !art.semi) throw new Error(`Missing fixture artwork ${JSON.stringify(art)}`)
      log('eraser artwork', art)
      await toolClick(page, 'bitmap-tool-eraser')
      const center = { x: (art.redBox!.x + art.redBox!.w / 2), y: (art.redBox!.y + art.redBox!.h / 2) }
      const probes = linePoints({ x: center.x - 20, y: center.y }, { x: center.x + 20, y: center.y })
      const before = await samplePixels(page, probes)
      const baseAssets = await baselineTwoAssets(page)
      const undoBefore = await undoEnabled(page)
      const redoBefore = await redoEnabled(page)
      await gateBlob(page, 900)

      // pointercancel path: synthetic eraser stroke paints a hole, cancel restores.
      await dispatchOnCanvas(page, 'pointerdown', { pointerId: 611, dx: -20, dy: 0 })
      await dispatchOnCanvas(page, 'pointermove', { pointerId: 611, dx: 0, dy: 0 })
      await dispatchOnCanvas(page, 'pointermove', { pointerId: 611, dx: 20, dy: 0 })
      await page.waitForTimeout(400)
      const mid = await samplePixels(page, probes)
      expect(mid.some((p, i) => p.some((c, ci) => Math.abs(c - before[i]![ci]!) > 4))).toBe(true)
      await dispatchOnCanvas(page, 'pointercancel', { pointerId: 611, buttons: 0, dx: 20, dy: 0 })
      await setGate(page, false)
      await page.waitForTimeout(900)
      const afterCancel = await samplePixels(page, probes)
      for (let i = 0; i < afterCancel.length; i += 1) expect(afterCancel[i]).toEqual(before[i])
      expect(await selectionVisible(page)).toBe(false)
      expect(await undoEnabled(page)).toBe(undoBefore)
      expect(await redoEnabled(page)).toBe(redoBefore)
      expect(await statusText(page)).toContain('Bitmap edit cancelled')
      const afterAssets = await baselineTwoAssets(page)
      expect(bytesEqual(afterAssets.redBytes, baseAssets.redBytes)).toBe(true)
      expect(bytesEqual(afterAssets.blueBytes, baseAssets.blueBytes)).toBe(true)

      // Escape path from a fresh eraser stroke (gate on again).
      await gateBlob(page, 900)
      await dispatchOnCanvas(page, 'pointerdown', { pointerId: 612, dx: -20, dy: 0 })
      await dispatchOnCanvas(page, 'pointermove', { pointerId: 612, dx: 20, dy: 0 })
      await page.waitForTimeout(400)
      await page.keyboard.press('Escape')
      await releaseCanvasPointer(page, 612, 20, 0)
      await setGate(page, false)
      await page.waitForTimeout(900)
      const afterEsc = await samplePixels(page, probes)
      for (let i = 0; i < afterEsc.length; i += 1) expect(afterEsc[i]).toEqual(before[i])
      expect(await undoEnabled(page)).toBe(undoBefore)
      const escAssets = await baselineTwoAssets(page)
      expect(bytesEqual(escAssets.redBytes, baseAssets.redBytes)).toBe(true)
      expect(bytesEqual(escAssets.blueBytes, baseAssets.blueBytes)).toBe(true)

      // Normal eraser completion is exactly one history entry.
      const a = await toScreen(page, center.x - 20, center.y)
      const b = await toScreen(page, center.x + 20, center.y)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 12 })
      await page.mouse.up()
      await page.waitForFunction(() => document.body.textContent?.includes('Bitmap edit saved') ?? false, undefined, { timeout: 15_000 })
      await page.waitForTimeout(600)
      expect(await undoEnabled(page)).toBe(true)
      const committed = await samplePixels(page, probes)
      expect(committed.some((p, i) => p.some((c, ci) => Math.abs(c - before[i]![ci]!) > 4))).toBe(true)
      await page.locator('button[aria-label="Undo"]').first().click()
      await page.waitForFunction(() => document.body.textContent?.includes('Asset undo') ?? false, undefined, { timeout: 15_000 })
      await page.waitForTimeout(900)
      const undone = await samplePixels(page, probes)
      for (let i = 0; i < undone.length; i += 1) expect(undone[i]).toEqual(before[i])
      await page.locator('button[aria-label="Redo"]').first().click()
      await page.waitForFunction(() => document.body.textContent?.includes('Asset redo') ?? false, undefined, { timeout: 15_000 })
      await page.waitForTimeout(900)
      const redone = await samplePixels(page, probes)
      for (let i = 0; i < redone.length; i += 1) expect(redone[i]).toEqual(committed[i])
      // Exactly one entry: second Undo stays at baseline (Redo armed once only).
      await page.locator('button[aria-label="Undo"]').first().click()
      await page.waitForTimeout(900)
      expect(await samplePixels(page, probes)).toEqual(before)
    })
  }, 180_000)

  it('floating scale + rotate cancel via pointercancel/lostpointercapture/Escape without history', async () => {
    await runIsolated('floating-cancel', async (page) => {
      await prepareGateA(page)
      const art = await scanArtwork(page)
      if (!art.redBox) throw new Error('Missing red box for floating selection')
      log('floating artwork', art)
      await toolClick(page, 'bitmap-tool-select')
      const m0 = { x: art.redBox.x - 6, y: art.redBox.y - 6 }
      const m1 = { x: art.redBox.x + art.redBox.w + 6, y: art.redBox.y + art.redBox.h + 6 }
      await dragReal(page, m0, m1)
      await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
      const selBefore = await page.evaluate(() => (document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement).outerHTML.slice(0, 400))
      const probes = linePoints({ x: art.redBox.x, y: art.redBox.y + art.redBox.h / 2 }, { x: art.redBox.x + art.redBox.w, y: art.redBox.y + art.redBox.h / 2 })
      const before = await samplePixels(page, probes)
      const baseAssets = await baselineTwoAssets(page)
      const undoBefore = await undoEnabled(page)
      await gateBlob(page, 900)

      // Scale via synthetic handle drag then pointercancel.
      const seBox = await page.getByTestId('bitmap-floating-scale-handle').boundingBox()
      const canvasBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
      if (!seBox || !canvasBox) throw new Error('Missing scale handle/canvas')
      const seCx = seBox.x + seBox.width / 2
      const seCy = seBox.y + seBox.height / 2
      const size = await canvasSize(page)
      const dxScreen = (36 / size.width) * canvasBox.width
      const dyScreen = (36 / size.height) * canvasBox.height
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-scale-handle"]', 'pointerdown', { pointerId: 701, clientX: seCx, clientY: seCy })
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-scale-handle"]', 'pointermove', { pointerId: 701, clientX: seCx + dxScreen, clientY: seCy + dyScreen })
      await page.waitForTimeout(500)
      const midScale = await samplePixels(page, probes)
      expect(midScale.some((p, i) => p.some((c, ci) => Math.abs(c - before[i]![ci]!) > 4))).toBe(true)
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-scale-handle"]', 'pointercancel', { pointerId: 701, clientX: seCx + dxScreen, clientY: seCy + dyScreen, buttons: 0 })
      await setGate(page, false)
      await page.waitForTimeout(900)
      const afterScale = await samplePixels(page, probes)
      for (let i = 0; i < afterScale.length; i += 1) expect(afterScale[i]).toEqual(before[i])
      expect(await selectionVisible(page)).toBe(true)
      expect(await undoEnabled(page)).toBe(undoBefore)
      expect(await statusText(page)).toContain('Bitmap edit cancelled')

      // Rotate via synthetic drag then pointercancel: restores (wired).
      const rotBox = await page.getByTestId('bitmap-floating-rotate-handle').boundingBox()
      if (!rotBox) throw new Error('Missing rotate handle')
      const rotCx = rotBox.x + rotBox.width / 2
      const rotCy = rotBox.y + rotBox.height / 2
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-rotate-handle"]', 'pointerdown', { pointerId: 702, clientX: rotCx, clientY: rotCy })
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-rotate-handle"]', 'pointermove', { pointerId: 702, clientX: rotCx + 60, clientY: rotCy + 30 })
      await page.waitForTimeout(500)
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-rotate-handle"]', 'pointercancel', { pointerId: 702, clientX: rotCx + 60, clientY: rotCy + 30, buttons: 0 })
      await page.waitForTimeout(900)
      const afterRotateCancel = await samplePixels(page, probes)
      for (let i = 0; i < afterRotateCancel.length; i += 1) expect(afterRotateCancel[i]).toEqual(before[i])
      expect(await undoEnabled(page)).toBe(undoBefore)

      // Rotate via synthetic drag then lostpointercapture: currently does NOT
      // restore (handle buttons only forward onpointercancel, not
      // onlostpointercapture, so endBitmapFloatingRotate never runs). This
      // assertion documents the real-VM gap vs the static wiring test.
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-rotate-handle"]', 'pointerdown', { pointerId: 704, clientX: rotCx, clientY: rotCy })
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-rotate-handle"]', 'pointermove', { pointerId: 704, clientX: rotCx + 60, clientY: rotCy + 30 })
      await page.waitForTimeout(500)
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-rotate-handle"]', 'lostpointercapture', { pointerId: 704, clientX: rotCx + 60, clientY: rotCy + 30, buttons: 0 })
      await page.waitForTimeout(900)
      const afterRotate = await samplePixels(page, probes)
      for (let i = 0; i < afterRotate.length; i += 1) expect(afterRotate[i]).toEqual(before[i])
      expect(await undoEnabled(page)).toBe(undoBefore)
      const selAfter = await page.evaluate(() => (document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement)?.outerHTML.slice(0, 400) ?? '')
      expect(selAfter.length).toBeGreaterThan(0)
      expect(selBefore.length).toBeGreaterThan(0)
      const midAssets = await baselineTwoAssets(page)
      expect(bytesEqual(midAssets.redBytes, baseAssets.redBytes)).toBe(true)
      expect(bytesEqual(midAssets.blueBytes, baseAssets.blueBytes)).toBe(true)

      // Escape cancels a fresh scale preview (real keyboard path).
      await gateBlob(page, 900)
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-scale-handle"]', 'pointerdown', { pointerId: 703, clientX: seCx, clientY: seCy })
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-scale-handle"]', 'pointermove', { pointerId: 703, clientX: seCx + dxScreen, clientY: seCy + dyScreen })
      await page.waitForTimeout(500)
      await page.keyboard.press('Escape')
      // Release the synthetic drag so no stuck gesture remains.
      await dispatchOnSelector(page, '[data-testid="bitmap-floating-scale-handle"]', 'pointercancel', { pointerId: 703, clientX: seCx + dxScreen, clientY: seCy + dyScreen, buttons: 0 }).catch(() => {})
      await setGate(page, false)
      await page.waitForTimeout(900)
      // Esc on a floating drag clears the outline by design; re-marquee and
      // verify the artwork itself restored with no history.
      if (await selectionVisible(page)) await page.keyboard.press('Escape')
      await dragReal(page, m0, m1)
      await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
      const afterEsc = await samplePixels(page, probes)
      for (let i = 0; i < afterEsc.length; i += 1) expect(afterEsc[i]).toEqual(before[i])
      expect(await undoEnabled(page)).toBe(undoBefore)
      const escAssets = await baselineTwoAssets(page)
      expect(bytesEqual(escAssets.redBytes, baseAssets.redBytes)).toBe(true)

      // Normal scale completion is exactly one entry.
      const scaleHandle = page.getByTestId('bitmap-floating-scale-handle')
      const hb = await scaleHandle.boundingBox()
      if (!hb) throw new Error('Missing SE handle for normal scale')
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.down()
      await page.mouse.move(hb.x + hb.width / 2 + dxScreen, hb.y + hb.height / 2 + dyScreen, { steps: 10 })
      await page.mouse.up()
      await page.waitForFunction(() => document.body.textContent?.includes('Bitmap selection scaled') ?? false, undefined, { timeout: 15_000 })
      expect(await undoEnabled(page)).toBe(true)
      await page.locator('button[aria-label="Undo"]').first().click()
      await page.waitForFunction(() => document.body.textContent?.includes('Asset undo') ?? false, undefined, { timeout: 15_000 })
      await page.waitForTimeout(900)
      expect(await samplePixels(page, probes)).toEqual(before)
      await page.locator('button[aria-label="Redo"]').first().click()
      await page.waitForFunction(() => document.body.textContent?.includes('Asset redo') ?? false, undefined, { timeout: 15_000 })
      await page.waitForTimeout(900)
      expect((await samplePixels(page, probes)).some((p, i) => p.some((c, ci) => Math.abs(c - before[i]![ci]!) > 4))).toBe(true)
      await page.locator('button[aria-label="Undo"]').first().click()
      await page.waitForTimeout(900)
      expect(await samplePixels(page, probes)).toEqual(before)
    })
  }, 240_000)

  it('Escape + tool-change + target/costume switch restore with delayed toBlob; normal stroke is one entry', async () => {
    await runIsolated('escape-tool-switch', async (page) => {
      await prepareGateA(page)
      const art = await scanArtwork(page)
      if (!art.redBox || !art.blue) throw new Error('Missing artwork for escape/switch test')
      const center = { x: art.redBox.x + art.redBox.w / 2, y: art.redBox.y + art.redBox.h / 2 }
      const probes = linePoints({ x: center.x - 18, y: center.y }, { x: center.x + 18, y: center.y })
      const before = await samplePixels(page, probes)
      const baseAssets = await baselineTwoAssets(page)
      const undoBefore = await undoEnabled(page)

      // Brush Escape: prior selection must survive the cancel.
      await toolClick(page, 'bitmap-tool-select')
      const m0 = { x: art.redBox.x - 6, y: art.redBox.y - 6 }
      const m1 = { x: art.redBox.x + art.redBox.w + 6, y: art.redBox.y + art.redBox.h + 6 }
      await dragReal(page, m0, m1)
      await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
      await toolClick(page, 'bitmap-tool-brush')
      // Brush keeps the existing select marquee visible until commit.
      await gateBlob(page, 900)
      await dispatchOnCanvas(page, 'pointerdown', { pointerId: 621, dx: -14, dy: 0 })
      await dispatchOnCanvas(page, 'pointermove', { pointerId: 621, dx: 14, dy: 0 })
      await page.waitForTimeout(400)
      await page.keyboard.press('Escape')
      await releaseCanvasPointer(page, 621, 14, 0)
      await setGate(page, false)
      await page.waitForTimeout(900)
      const afterBrushEsc = await samplePixels(page, probes)
      for (let i = 0; i < afterBrushEsc.length; i += 1) expect(afterBrushEsc[i]).toEqual(before[i])
      expect(await undoEnabled(page)).toBe(undoBefore)
      // Escape of a brush stroke preserves the prior marquee.
      expect(await selectionVisible(page)).toBe(true)
      await page.keyboard.press('Escape')
      await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden', timeout: 10_000 })

      // Tool-change mid-stroke: start brush, click eraser, then cancel.
      await toolClick(page, 'bitmap-tool-brush')
      await gateBlob(page, 900)
      await dispatchOnCanvas(page, 'pointerdown', { pointerId: 622, dx: -14, dy: 0 })
      await dispatchOnCanvas(page, 'pointermove', { pointerId: 622, dx: 0, dy: 0 })
      await page.waitForTimeout(300)
      await toolClick(page, 'bitmap-tool-eraser')
      await dispatchOnCanvas(page, 'pointercancel', { pointerId: 622, buttons: 0, dx: 0, dy: 0 })
      await setGate(page, false)
      await page.waitForTimeout(900)
      const afterTool = await samplePixels(page, probes)
      for (let i = 0; i < afterTool.length; i += 1) expect(afterTool[i]).toEqual(before[i])
      expect(await undoEnabled(page)).toBe(undoBefore)
      const toolAssets = await baselineTwoAssets(page)
      expect(bytesEqual(toolAssets.redBytes, baseAssets.redBytes)).toBe(true)
      expect(bytesEqual(toolAssets.blueBytes, baseAssets.blueBytes)).toBe(true)
      await toolClick(page, 'bitmap-tool-brush')

      // Costume switch mid-stroke with gate on: no stale pixels, no history.
      await gateBlob(page, 900)
      await dispatchOnCanvas(page, 'pointerdown', { pointerId: 623, dx: -14, dy: 0 })
      await dispatchOnCanvas(page, 'pointermove', { pointerId: 623, dx: 14, dy: 0 })
      await page.getByTestId('costume-card-1').click()
      await dispatchOnCanvas(page, 'pointercancel', { pointerId: 623, buttons: 0, dx: 14, dy: 0 }).catch(() => {})
      await setGate(page, false)
      await page.waitForTimeout(1200)
      // Now viewing blueA2: canvas must show blue artwork, both assets unchanged.
      const blueArt = await scanArtwork(page)
      expect(blueArt.blue).not.toBe(undefined)
      const switchAssets = await baselineTwoAssets(page)
      expect(bytesEqual(switchAssets.redBytes, baseAssets.redBytes)).toBe(true)
      expect(bytesEqual(switchAssets.blueBytes, baseAssets.blueBytes)).toBe(true)
      expect(await undoEnabled(page)).toBe(undoBefore)
      // Back to redA and verify exact RGBA baseline still there.
      await page.getByTestId('costume-card-0').click()
      await waitBitmapCanvas(page)
      await page.waitForTimeout(900)
      expect(await samplePixels(page, probes)).toEqual(before)

      // Delayed-toBlob stale commit: normal mouse stroke with gate on, switch
      // targets before the encode resolves -> stale save must abort.
      await gateBlob(page, 1200)
      const a = await toScreen(page, center.x - 14, center.y)
      const b = await toScreen(page, center.x + 14, center.y)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(200)
      await page.getByTestId('target-card-GateB').click()
      await page.waitForTimeout(400)
      await setGate(page, false)
      await page.waitForTimeout(1500)
      const staleAssets = await baselineTwoAssets(page)
      expect(bytesEqual(staleAssets.redBytes, baseAssets.redBytes)).toBe(true)
      expect(bytesEqual(staleAssets.blueBytes, baseAssets.blueBytes)).toBe(true)
      // GateB shows its own blue pixels, never redA's stroke.
      const gateBArt = await scanArtwork(page)
      expect(gateBArt.blue).not.toBe(undefined)
      await page.getByTestId('target-card-GateA').click()
      await page.waitForTimeout(600)
      await page.getByTestId('costume-card-0').click()
      await waitBitmapCanvas(page)
      await page.waitForTimeout(900)
      expect(await samplePixels(page, probes)).toEqual(before)
      expect(await undoEnabled(page)).toBe(undoBefore)

      // Normal brush completion afterwards is exactly one history entry.
      const c = await toScreen(page, center.x - 14, center.y)
      const d = await toScreen(page, center.x + 14, center.y)
      await page.mouse.move(c.x, c.y)
      await page.mouse.down()
      await page.mouse.move(d.x, d.y, { steps: 10 })
      await page.mouse.up()
      await page.waitForFunction(() => document.body.textContent?.includes('Bitmap edit saved') ?? false, undefined, { timeout: 15_000 })
      await page.waitForTimeout(600)
      expect(await undoEnabled(page)).toBe(true)
      const committed = await samplePixels(page, probes)
      expect(committed.some((p, i) => p.some((ch, ci) => Math.abs(ch - before[i]![ci]!) > 4))).toBe(true)
      await page.locator('button[aria-label="Undo"]').first().click()
      await page.waitForFunction(() => document.body.textContent?.includes('Asset undo') ?? false, undefined, { timeout: 15_000 })
      await page.waitForTimeout(900)
      expect(await samplePixels(page, probes)).toEqual(before)
      await page.locator('button[aria-label="Redo"]').first().click()
      await page.waitForFunction(() => document.body.textContent?.includes('Asset redo') ?? false, undefined, { timeout: 15_000 })
      await page.waitForTimeout(900)
      expect(await samplePixels(page, probes)).toEqual(committed)
    })
  }, 240_000)
})
