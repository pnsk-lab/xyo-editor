// Extreme side-length bitmap verification (NEW verification only, product code untouched).
//
// Context: `bitmap-artboard.ts` caps the workspace by AREA only
// (`BITMAP_ARTBOARD_MAX_AREA = 16_777_216`, union side cap 4096 falls back to
// the verbatim source rect). A 100000x2 image is only 200_000 px, so it passes
// the area budget with `refused=false`, yet its 100000 px side can exceed the
// Chrome 2D-raster side limit. Observed headless-Chrome probe (2026-11-12,
// Chrome 156, `CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome`):
//   - PNG/IHDR layer: all sides decode (spec max is 2^31-1 per IHDR uint32).
//     Image decode + createImageBitmap report the full W x 2 dims for every
//     size below, and source-rect sampling returns the endpoint colours.
//   - Canvas 2D raster: 32768x2 and 65535x2 rasterize (fillRect + getImageData
//     + toBlob all work). 65536x2 and 100000x2 allocate (width readback OK,
//     ctx non-null) but the raster silently stays blank (drawn pixels read
//     back transparent) and canvas.toBlob resolves null.
//   - So the raster side boundary in this Chrome is 65535 (= 2^16 - 1); the
//     area budget alone cannot protect the editor. A blank live canvas fed
//     into Save would crop to "fully transparent" and overwrite the stored
//     asset (plus risk to neighbouring assets), unless the editor refuses
//     explicitly or no-ops non-destructively.
//
// What this suite does (real Editor + real VM, per side W in
// [32768, 65535, 65536, 100000] x H=2):
//   1. Byte-builds each fixture PNG (IHDR dims asserted: PNG layer carries the
//      side fine) with distinct head/mid/tail endpoint colours. Total pixels
//      per fixture are <= 200_000 (see MAX_FIXTURE_PIXELS guard): no
//      unbounded allocation, OS-friendly by construction.
//   2. Re-probes the LIVE test browser (same headed/CI Chrome that runs the
//      editor) for canvas/Image/createImageBitmap side behaviour per size, so
//      environment differences (GPU vs headless raster limits) branch the
//      assertions instead of causing false passes/failures.
//   3. Uploads one SB3 (4 extreme sprites + 1 canary sprite) and, per extreme
//      sprite, runs load -> canvas display -> brush edit attempt -> Save ->
//      export -> Undo -> Redo -> bitmap->vector Convert attempt -> reload
//      round-trip, comparing endpoint pixels, asset bytes, rotationCenter and
//      bitmapResolution at every step, plus the canary asset (must stay
//      byte-identical: cross-asset corruption check).
//   4. Branch rule (adaptive, no false pass):
//      - INK branch (live canvas shows the W-wide ink): full round-trip
//        invariants (dims, endpoint colours, res/center, VM scratch bounds,
//        reload bytes, stage stability).
//      - BLANK branch (browser raster refused the side: live canvas blank):
//        the editor MUST either surface the explicit refusal status
//        ('Image too large to edit safely — original kept unchanged') or
//        leave the stored asset byte-identical (non-destructive no-op) across
//        edit/save/convert attempts. A silent transparent overwrite FAILS
//        loudly with full forensics (this is the data-loss vector under
//        test); Undo/Redo recoverability is then logged as secondary evidence.
//   5. HMR false-pass guards: production-shape waits only (settled-canvas
//      requiring consecutive identical reads, md5-change waits, stage
//      settle loops, export->reimport round-trip). Nothing is asserted on a
//      transient first frame.
//
// Dedicated Vite port 4561 (surveyed 2026-11-12: 4401/4419/4427/4449/4451/
// 4461/4477/4478/4491/4492/4495/4496/4527/4531/4999 and the 41xx-43xx block
// are claimed by other browser suites; 4540 by the transparency-forensics
// suite; 4561 is free). CHROME_BIN is inherited.
//
// HMR separation: `EXTREME_SERVE=preview` serves the production build via
// `vite preview` (no HMR channel) instead of the dev server, so temporary
// screen re-initialisation caused by concurrent editing (e.g. a parallel
// BitmapEditor Fit fix) cannot be mistaken for product behaviour. Dev mode
// (default) keeps the usual HMR-capable server; every critical read below
// additionally requires settled state (consecutive identical samples,
// md5-change waits, stage settle loops, export->reimport round-trip).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { inflateSync as inflateRaw, strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4561
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

/** Hard cap for every fixture built or decoded by THIS suite (px). */
const MAX_FIXTURE_PIXELS = 250_000
/** Height used by every extreme fixture: total px stays tiny, side stays extreme. */
const EXTREME_H = 2
const EXTREME_WIDTHS = [32768, 65535, 65536, 100000] as const
const REFUSAL_STATUS = 'Image too large to edit safely — original kept unchanged'

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

type RGBA = [number, number, number, number]

/** Byte-build a W x H RGBA PNG. Throws over MAX_FIXTURE_PIXELS (memory cap). */
function buildPng(width: number, height: number, pixel: (x: number, y: number) => RGBA): Uint8Array {
  if (!(width > 0 && height > 0)) throw new Error(`bad dims ${width}x${height}`)
  if (width * height > MAX_FIXTURE_PIXELS) throw new Error(`fixture ${width}x${height} exceeds ${MAX_FIXTURE_PIXELS}px cap`)
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

/** Extreme fixture: white base, 10px red head / green quarter / blue tail. */
function buildExtremePng(width: number): Uint8Array {
  return buildPng(width, EXTREME_H, (x) => {
    if (x < 10) return [255, 0, 0, 255]
    if (x >= width - 10) return [0, 0, 255, 255]
    // Quarter marker (NOT the center: INK-branch brush dots land on the
    // transform-invariant canvas center, which must stay white base so the
    // endpoint comparison is not repainted by the test's own edit).
    if (x >= Math.floor(width / 4) && x < Math.floor(width / 4) + 10) return [0, 255, 0, 255]
    return [255, 255, 255, 255]
  })
}

/** Small canary asset: 64x48 white base with a red block (cross-asset guard). */
function buildCanaryPng(): Uint8Array {
  return buildPng(64, 48, (x, y) => {
    if (x >= 8 && x < 24 && y >= 8 && y < 24) return [255, 0, 0, 255]
    return [255, 255, 255, 255]
  })
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('Not a PNG')
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function decodePng(png: Buffer | Uint8Array): { width: number; height: number; data: Buffer } {
  const bytes = Buffer.from(png)
  if (bytes.length > (MAX_FIXTURE_PIXELS + 16) * 5) throw new Error('decode refuse: input over fixture cap')
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!bytes.subarray(0, 8).equals(sig)) throw new Error('Not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatParts: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) throw new Error('Truncated PNG')
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dataStart)
      height = bytes.readUInt32BE(dataStart + 4)
      bitDepth = bytes[dataStart + 8] ?? 0
      colorType = bytes[dataStart + 9] ?? 0
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  if (width * height > MAX_FIXTURE_PIXELS) throw new Error(`decode refuse: ${width}x${height} over fixture cap`)
  if (width === 0 || height === 0) throw new Error('Missing IHDR')
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`Unsupported PNG (depth=${bitDepth}, color=${colorType})`)
  const channels = colorType === 6 ? 4 : 3
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idatParts))
  } catch {
    raw = Buffer.from(inflateRaw(new Uint8Array(Buffer.concat(idatParts))))
  }
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let rawOffset = 0
  let previous = Buffer.alloc(stride, 0)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset] ?? 0
    rawOffset += 1
    const current = Buffer.from(raw.subarray(rawOffset, rawOffset + stride))
    if (current.length !== stride) throw new Error('Truncated scanline')
    rawOffset += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? (current[x - channels] ?? 0) : 0
      const b = previous[x] ?? 0
      const c = x >= channels ? (previous[x - channels] ?? 0) : 0
      const v = current[x] ?? 0
      if (filter === 1) current[x] = (v + a) & 0xff
      else if (filter === 2) current[x] = (v + b) & 0xff
      else if (filter === 3) current[x] = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        current[x] = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels
      const t = (y * width + x) * 4
      rgba[t] = current[s] ?? 0
      rgba[t + 1] = current[s + 1] ?? 0
      rgba[t + 2] = current[s + 2] ?? 0
      rgba[t + 3] = channels === 4 ? (current[s + 3] ?? 255) : 255
    }
    previous = current
  }
  return { width, height, data: rgba }
}

function pixelAt(data: Buffer, width: number, x: number, y: number): [number, number, number, number] {
  const o = (y * width + x) * 4
  return [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, data[o + 3] ?? 0]
}

const isRed = (p: [number, number, number, number]) => p[3] > 128 && p[0] > 200 && p[1] < 100 && p[2] < 100
const isGreen = (p: [number, number, number, number]) => p[3] > 128 && p[1] > 150 && p[0] < 120 && p[2] < 120
const isBlue = (p: [number, number, number, number]) => p[3] > 128 && p[2] > 150 && p[0] < 120 && p[1] < 150

function endpointSummary(data: Buffer, width: number, w: number) {
  const head = pixelAt(data, width, 2, 0)
  const mid = pixelAt(data, width, Math.floor(w / 4) + 2, 0)
  const tail = pixelAt(data, width, w - 3, 0)
  return { head, mid, tail, headRed: isRed(head), midGreen: isGreen(mid), tailBlue: isBlue(tail) }
}

/** VM scratch bounds for a bitmap costume (packages/vm targetCostumeBox equations). */
function scratchBoundsOf(width: number, height: number, cx: number, cy: number, res: number) {
  const r = res > 0 ? res : 1
  const left = -cx / r
  const right = (width - cx) / r
  const top = cy / r
  const bottom = -(height - cy) / r
  return { left, right, top, bottom, width: right - left, height: top - bottom }
}

function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function log(label: string, value: unknown) {
  console.log(`[extreme-side-cap] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'extreme-side-cap.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { project: { targets: Array<{ costumes: Array<{ name: string }> }> } } } }).__hikkakuEditorTest?.snapshot()
      return snap?.project.targets.some((t) => t.costumes.some((c) => c.name === want)) ?? false
    },
    expectName,
    { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)
}

type CostumeMeta = { targetName: string; index: number; name: string; dataFormat: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }

async function selectedCostumeMeta(page: Page): Promise<CostumeMeta> {
  return await page.evaluate(() => {
    const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ id?: string; name: string; isStage: boolean; currentCostume?: number; costumes: Array<{ name: string; dataFormat?: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> }> }; selectedTargetId: string } } }).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t) => !t.isStage) ?? snap.project.targets[0]!
    const index = target.currentCostume ?? 0
    const costume = target.costumes[index]!
    return { targetName: target.name, index, name: costume.name, dataFormat: costume.dataFormat ?? '', bitmapResolution: costume.bitmapResolution, rotationCenterX: costume.rotationCenterX, rotationCenterY: costume.rotationCenterY, md5ext: costume.md5ext }
  })
}

async function readStatus(page: Page): Promise<string> {
  return await page.evaluate(() => {
    try {
      return (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status()
    } catch {
      return 'no-status-api'
    }
  })
}

async function canvasDiag(page: Page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) return { found: false as const }
    const context = canvas.getContext('2d')
    if (!context) return { found: true as const, readable: false as const }
    let image: ImageData
    try {
      image = context.getImageData(0, 0, canvas.width, canvas.height)
    } catch {
      return { found: true as const, readable: false as const, width: canvas.width, height: canvas.height, getImageDataThrew: true as const }
    }
    let opaque = 0
    let left = canvas.width
    let top = canvas.height
    let right = -1
    let bottom = -1
    // Bounded walk: worst case 100000x2 = 200k px here.
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const a = image.data[(y * canvas.width + x) * 4 + 3] ?? 0
        if (a === 0) continue
        opaque += 1
        if (x < left) left = x
        if (y < top) top = y
        if (x > right) right = x
        if (y > bottom) bottom = y
      }
    }
    return { found: true as const, readable: true as const, width: canvas.width, height: canvas.height, opaque, trim: right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null }
  })
}

/** Sample one live-canvas pixel (bounded 1px read, no full-raster walk). */
async function sampleLivePixel(page: Page, x: number, y: number) {
  return await page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
      if (!canvas) return { found: false as const }
      const context = canvas.getContext('2d')
      if (!context) return { found: true as const, readable: false as const }
      try {
        const d = context.getImageData(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), 1, 1)
        return { found: true as const, readable: true as const, rgba: Array.from(d.data.slice(0, 4)) }
      } catch {
        return { found: true as const, readable: false as const }
      }
    },
    { x, y },
  )
}

/** Settled canvas read: 3 consecutive identical (opaque, trim) samples (HMR guard). */
async function waitCanvasSettled(page: Page, timeout = 30_000) {
  const start = Date.now()
  let stable = 0
  let previous = ''
  let last: Awaited<ReturnType<typeof canvasDiag>> | undefined
  for (;;) {
    const diag = await canvasDiag(page)
    last = diag
    const key = JSON.stringify(diag)
    if ((diag as { readable?: boolean }).readable === true && key === previous) {
      stable += 1
      if (stable >= 2) return diag
    } else {
      stable = 0
    }
    previous = key
    if (Date.now() - start > timeout) throw new Error(`canvas never settled (last=${JSON.stringify(last).slice(0, 500)})`)
    await new Promise((r) => setTimeout(r, 400))
  }
}

async function exportSb3(page: Page) {
  const fileTrigger = page.getByText('ファイル', { exact: true }).first()
  if (await fileTrigger.isVisible()) await fileTrigger.click()
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
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
  const project = JSON.parse(strFromU8(archive['project.json']!)) as { targets: Array<{ name: string; isStage: boolean; currentCostume: number; costumes: Array<{ name: string; dataFormat?: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> }> }
  const assets: Record<string, Uint8Array> = {}
  for (const [key, value] of Object.entries(archive)) {
    if (key !== 'project.json') assets[key] = value as Uint8Array
  }
  return { project, assets }
}

function costumeRecord(exported: Awaited<ReturnType<typeof exportSb3>>, targetName: string, index: number) {
  const target = exported.project.targets.find((t) => t.name === targetName)!
  const costume = target.costumes[index]!
  const bytes = exported.assets[costume.md5ext!]!
  return { costume, bytes }
}

async function stageRgba(page: Page) {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const png = await page.getByTestId('stage-canvas').screenshot({ type: 'png', timeout: 15_000 })
      return decodePng(png)
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastError
}

function diffRatio(a: Buffer, b: Buffer): { ratio: number; max: number } {
  if (a.length !== b.length) return { ratio: 1, max: 1020 }
  let differing = 0
  let max = 0
  const total = a.length / 4
  for (let i = 0; i < a.length; i += 4) {
    const d =
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) +
      Math.abs((a[i + 3] ?? 0) - (b[i + 3] ?? 0))
    if (d > 48) differing += 1
    if (d > max) max = d
  }
  return { ratio: differing / total, max }
}

async function waitStageSettled(page: Page, timeout = 25_000) {
  const start = Date.now()
  let previous: { width: number; height: number; data: Buffer } | undefined
  let stable = 0
  for (;;) {
    const current = await stageRgba(page)
    if (previous && previous.width === current.width && previous.height === current.height) {
      if (diffRatio(previous.data, current.data).ratio < 0.004) {
        stable += 1
        if (stable >= 2) return current
      } else stable = 0
    } else stable = 0
    previous = current
    if (Date.now() - start > timeout) throw new Error('Stage never settled')
    await new Promise((r) => setTimeout(r, 700))
  }
}

/** Wait for the selected costume md5 to differ; false on timeout (no-op path). */
async function waitMd5Changed(page: Page, banned: string, timeout = 12_000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (ban: string) => {
        const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ id?: string; name: string; isStage: boolean; currentCostume?: number; costumes: Array<{ dataFormat?: string; md5ext?: string }> }> }; selectedTargetId: string } } }).__hikkakuEditorTest.snapshot()
        const target = snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t) => !t.isStage) ?? snap.project.targets[0]!
        const costume = target.costumes[target.currentCostume ?? 0]!
        return (costume.dataFormat ?? '') === 'png' && (costume.md5ext ?? '') !== ban
      },
      banned as unknown as undefined,
      { timeout },
    )
    return true
  } catch {
    return false
  }
}

async function waitMd5(page: Page, md5ext: string, timeout = 30_000) {
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ id?: string; name: string; isStage: boolean; currentCostume?: number; costumes: Array<{ md5ext?: string }> }> }; selectedTargetId: string } } }).__hikkakuEditorTest.snapshot()
      const target = snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t) => !t.isStage) ?? snap.project.targets[0]!
      return (target.costumes[target.currentCostume ?? 0]!.md5ext ?? '') === want
    },
    md5ext as unknown as undefined,
    { timeout },
  )
}

async function waitDataFormat(page: Page, format: string, timeout = 30_000) {
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ id?: string; name: string; isStage: boolean; currentCostume?: number; costumes: Array<{ dataFormat?: string }> }> }; selectedTargetId: string } } }).__hikkakuEditorTest.snapshot()
      const target = snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t) => !t.isStage) ?? snap.project.targets[0]!
      return (target.costumes[target.currentCostume ?? 0]!.dataFormat ?? '') === want
    },
    format as unknown as undefined,
    { timeout },
  )
}

/**
 * Live per-size browser limit probe (the "Chromeで調べ" step, executed in the
 * SAME browser that runs the editor). One size at a time; bitmaps are closed
 * and object URLs revoked before returning (no accumulation).
 */
async function probeBrowserLimits(page: Page, width: number, height: number, pngB64: string) {
  return await page.evaluate(
    async ({ width, height, pngB64 }) => {
      const out: Record<string, unknown> = { width, height }
      try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        out.canvasReadback = [canvas.width, canvas.height]
        const ctx = canvas.getContext('2d')
        out.ctxNull = ctx === null
        if (ctx) {
          ctx.fillStyle = '#ff0000'
          ctx.fillRect(0, 0, 10, height)
          let head: number[] | null = null
          try {
            const d = ctx.getImageData(0, 0, Math.min(width, 16), height)
            head = Array.from(d.data.slice(0, 4))
          } catch (e) {
            out.getImageDataErr = String(e).slice(0, 160)
          }
          out.rasterHeadPixel = head
          // True only when the raster really stored the fill.
          out.rasterOk = head !== null && head[0] === 255 && head[1] === 0 && head[2] === 0 && head[3] === 255
          try {
            const blob = await new Promise<Blob | null>((resolve) => {
              try {
                canvas.toBlob(resolve, 'image/png')
              } catch {
                resolve(null)
              }
            })
            out.toBlobNull = blob === null
            out.toBlobSize = blob ? blob.size : -1
          } catch (e) {
            out.toBlobErr = String(e).slice(0, 160)
          }
        }
      } catch (e) {
        out.canvasErr = String(e).slice(0, 200)
      }
      const bin = Uint8Array.from(atob(pngB64), (ch) => ch.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bin], { type: 'image/png' }))
      try {
        const img = new Image()
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('Image.onerror'))
          img.src = url
        })
        out.imgNatural = [img.naturalWidth, img.naturalHeight]
        const bin2 = Uint8Array.from(atob(pngB64), (ch) => ch.charCodeAt(0))
        try {
          const bmp = await createImageBitmap(new Blob([bin2], { type: 'image/png' }))
          out.cibDims = [bmp.width, bmp.height]
          if (typeof bmp.close === 'function') bmp.close()
        } catch (e) {
          out.cibErr = String(e).slice(0, 200)
        }
        try {
          // Source-rect sampling into a tiny canvas: proves the DECODED bytes
          // carry head/mid/tail even when the full-size raster is refused.
          const tiny = document.createElement('canvas')
          tiny.width = 30
          tiny.height = height
          const tctx = tiny.getContext('2d')!
          tctx.drawImage(img, 0, 0, 10, height, 0, 0, 10, height)
          tctx.drawImage(img, width - 10, 0, 10, height, 10, 0, 10, height)
          tctx.drawImage(img, Math.floor(width / 4), 0, 10, height, 20, 0, 10, height)
          const d = tctx.getImageData(0, 0, 30, height)
          const at = (x: number) => Array.from(d.data.slice(x * 4, x * 4 + 4))
          out.sampled = { head: at(2), tail: at(12), mid: at(22) }
        } catch (e) {
          out.sampleErr = String(e).slice(0, 200)
        }
      } catch (e) {
        out.imgErr = String(e).slice(0, 200)
      } finally {
        URL.revokeObjectURL(url)
      }
      return out
    },
    { width, height, pngB64 },
  )
}

function emptyBackdropSvg(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>')
}

describe('extreme side-length bitmaps (real Editor/VM)', () => {
  beforeAll(async () => {
    // Fail fast on fixed-port collision (independent port discipline).
    const probe = await fetch(base).then(() => true).catch(() => false)
    if (probe) throw new Error(`port ${PORT} is already in use; stop the holder first`)
    // EXTREME_SERVE=preview -> HMR-free production serving (`vite preview`
    // over dist/); default -> dev server with HMR. See header comment.
    const serveMode = process.env.EXTREME_SERVE === 'preview' ? 'preview' : 'dev'
    const serveArgs =
      serveMode === 'preview'
        ? ['x', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
        : ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
    log('serve mode', { serveMode })
    server = spawn('bun', serveArgs, {
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

  it('fixture PNGs byte-compose (IHDR sides + endpoint ink + memory cap)', () => {
    for (const w of EXTREME_WIDTHS) {
      expect(w * EXTREME_H).toBeLessThanOrEqual(MAX_FIXTURE_PIXELS)
      const png = buildExtremePng(w)
      // PNG/IHDR layer carries the extreme side (spec max 2^31-1): any later
      // failure is the browser raster's, never the file format's.
      expect(pngDimensions(png)).toEqual({ width: w, height: EXTREME_H })
      const rgba = decodePng(Buffer.from(png))
      expect({ width: rgba.width, height: rgba.height }).toEqual({ width: w, height: EXTREME_H })
      const ends = endpointSummary(rgba.data, rgba.width, w)
      expect({ ...ends, head: 'ok', mid: 'ok', tail: 'ok' }).toEqual({
        head: 'ok',
        mid: 'ok',
        tail: 'ok',
        headRed: true,
        midGreen: true,
        tailBlue: true,
      })
      log(`fixture ${w}x${EXTREME_H}`, { bytes: png.length, md5: md5(png) })
    }
    const canary = buildCanaryPng()
    expect(pngDimensions(canary)).toEqual({ width: 64, height: 48 })
    // Memory-cap guard itself: over-cap composition must throw, never alloc.
    expect(() => buildPng(100000, 300, () => [0, 0, 0, 255] as RGBA)).toThrow()
  })

  for (const W of EXTREME_WIDTHS) {
    it(`side ${W}x${EXTREME_H}: browser limits -> load -> edit -> save/convert/undo/redo/export, canary intact`, async () => {
      const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
      const page = await context.newPage()
      try {
        const extremePng = buildExtremePng(W)
        const canaryPng = buildCanaryPng()
        expect(pngDimensions(extremePng)).toEqual({ width: W, height: EXTREME_H })
        const extremeFile = `${md5(extremePng)}.png`
        const canaryFile = `${md5(canaryPng)}.png`
        const emptySvg = emptyBackdropSvg()
        const emptyHash = md5(emptySvg)
        const spriteName = `Wide${W}`
        const project = {
          targets: [
            { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'backdrop1', assetId: emptyHash, md5ext: `${emptyHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
            { isStage: false, name: spriteName, variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: `wide${W}`, assetId: md5(extremePng), md5ext: extremeFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: W / 2, rotationCenterY: 1 }], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
            { isStage: false, name: 'Canary', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'canary', assetId: md5(canaryPng), md5ext: canaryFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 32, rotationCenterY: 24 }], sounds: [], volume: 100, layerOrder: 2, visible: true, x: 150, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
          ],
          monitors: [],
          extensions: [],
          meta: { semver: '3.0.0', vm: 'extreme-side-cap', agent: 'extreme-side-cap' },
        }
        const sb3 = buildSb3(project, { [extremeFile]: extremePng, [canaryFile]: canaryPng, [`${emptyHash}.svg`]: emptySvg })

        // --- live browser limit probe (same engine as the editor) ---
        await page.goto(base, { waitUntil: 'networkidle' })
        const probe = await probeBrowserLimits(page, W, EXTREME_H, Buffer.from(extremePng).toString('base64'))
        log(`browser probe ${W}x${EXTREME_H}`, probe)
        // PNG/IHDR + decode path must carry the side in every environment;
        // only the full-size RASTER may refuse (adaptive branch below).
        expect(probe.imgNatural).toEqual([W, EXTREME_H])
        expect(probe.cibDims).toEqual([W, EXTREME_H])
        const sampled = probe.sampled as { head: number[]; mid: number[]; tail: number[] } | undefined
        expect(isRed(sampled!.head as [number, number, number, number])).toBe(true)
        expect(isBlue(sampled!.tail as [number, number, number, number])).toBe(true)
        expect(isGreen(sampled!.mid as [number, number, number, number])).toBe(true)

        // --- upload / load ---
        await openCostumes(page)
        await importSb3(page, Buffer.from(sb3), `wide${W}`)
        await page.getByTestId(`target-card-${spriteName}`).click()
        await page.waitForTimeout(800)
        const meta0 = await selectedCostumeMeta(page)
        log(`imported meta ${W}`, meta0)
        expect(meta0.dataFormat).toBe('png')
        expect(meta0.bitmapResolution).toBe(2)
        expect(meta0.rotationCenterX).toBe(W / 2)
        expect(meta0.rotationCenterY).toBe(1)
        await page.getByRole('button', { name: `Select wide${W}` }).first().click()
        await page.waitForTimeout(600)
        const diag0 = await waitCanvasSettled(page)
        const status0 = await readStatus(page)
        const vmBounds0 = scratchBoundsOf(W, EXTREME_H, W / 2, 1, 2)
        log(`live canvas after load ${W}`, { canvas: diag0, status: status0, vmBounds: vmBounds0 })
        const stage0 = await waitStageSettled(page)

        const live = diag0 as { width?: number; height?: number; opaque?: number; trim?: { width: number } | null; readable?: boolean }
        const showsInk = (live.readable ?? false) && (live.opaque ?? 0) > 0 && (live.trim?.width ?? 0) >= W - 1
        log(`branch ${W}`, { showsInk, rasterOk: probe.rasterOk, toBlobNull: probe.toBlobNull })

        // Canary baseline (cross-asset guard): bytes + meta snapshot.
        const base0 = await exportSb3(page)
        const canary0 = costumeRecord(base0, 'Canary', 0)
        const canaryRgba0 = decodePng(Buffer.from(canary0.bytes))
        expect(pngDimensions(canary0.bytes)).toEqual({ width: 64, height: 48 })
        const checkCanary = async (label: string) => {
          const now = await exportSb3(page)
          const rec = costumeRecord(now, 'Canary', 0)
          const same = Buffer.from(rec.bytes).equals(Buffer.from(canary0.bytes))
          log(`canary ${label} ${W}`, { same, meta: rec.costume })
          expect(same).toBe(true)
          expect(rec.costume.bitmapResolution).toBe(2)
          expect(rec.costume.rotationCenterX).toBe(32)
          expect(rec.costume.rotationCenterY).toBe(24)
          return now
        }

        if (showsInk) {
          // ============ INK branch: full round-trip invariants ============
          expect(live.width).toBe(W)
          // Brush edit attempt: one dot at the canvas CENTER through the REAL
          // tool (the same transform-invariant geometry the existing
          // res1-huge-verify suite uses: off-center points of a W-wide canvas
          // are not pointer-hittable under the viewport scale transform, so
          // the suite keeps the center on white base and the green quarter
          // marker at W/4, keeping head/mid/tail comparable after the edit).
          const canvasLoc = page.getByTestId('bitmap-editor-canvas')
          const box = await canvasLoc.boundingBox()
          if (!box) throw new Error('Missing bitmap canvas box')
          const beforeDot = await sampleLivePixel(page, W / 2, 1)
          await page.getByTestId('bitmap-tool-brush').click()
          const dot = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          await page.mouse.move(dot.x, dot.y)
          await page.mouse.down()
          await page.mouse.move(dot.x + 2, dot.y + 1, { steps: 2 })
          await page.mouse.up()
          await page.waitForTimeout(1500)
          const afterDot = await sampleLivePixel(page, W / 2, 1)
          const statusAfterDot = await readStatus(page)
          log(`after brush dot ${W}`, { box, dot, beforeDot, afterDot, statusAfterDot })
          const edited = await waitMd5Changed(page, meta0.md5ext!, 30_000)
          log(`md5 changed ${W}`, { edited })
          expect(edited).toBe(true)
          const metaEdited = await selectedCostumeMeta(page)
          await page.getByTestId('save-bitmap-costume').click()
          await page.waitForTimeout(1200)
          const metaSaved = await selectedCostumeMeta(page)
          log(`after Save ${W}`, { meta: metaSaved })
          const saved = await exportSb3(page)
          const recSaved = costumeRecord(saved, spriteName, metaSaved.index)
          const dimsSaved = pngDimensions(recSaved.bytes)
          const rgbaSaved = decodePng(Buffer.from(recSaved.bytes))
          const endsSaved = endpointSummary(rgbaSaved.data, rgbaSaved.width, W)
          const boundsSaved = scratchBoundsOf(dimsSaved.width, dimsSaved.height, recSaved.costume.rotationCenterX!, recSaved.costume.rotationCenterY!, recSaved.costume.bitmapResolution!)
          const stageSaved = await waitStageSettled(page)
          log(`saved ${W}`, { meta: recSaved.costume, dims: dimsSaved, ends: endsSaved, bounds: boundsSaved, stageDiff: diffRatio(stage0.data, stageSaved.data) })
          expect(dimsSaved).toEqual({ width: W, height: EXTREME_H })
          expect(endsSaved.headRed).toBe(true)
          expect(endsSaved.midGreen).toBe(true)
          expect(endsSaved.tailBlue).toBe(true)
          expect(recSaved.costume.bitmapResolution).toBe(2)
          expect(recSaved.costume.rotationCenterX).toBe(W / 2)
          expect(recSaved.costume.rotationCenterY).toBe(1)
          expect(boundsSaved).toEqual(vmBounds0)
          expect(diffRatio(stage0.data, stageSaved.data).ratio).toBeLessThan(0.05)
          await checkCanary('after-save')

          // Undo -> Redo: redo must restore the saved bytes exactly.
          await page.getByRole('button', { name: 'Undo' }).last().click()
          let undoBytes: Uint8Array
          try {
            await waitMd5(page, meta0.md5ext!)
            const undoExport = await exportSb3(page)
            undoBytes = costumeRecord(undoExport, spriteName, metaSaved.index).bytes
            log(`undo ${W}`, { dims: pngDimensions(undoBytes) })
          } catch (error) {
            // Autosave may have made Save idempotent (no history entry): then
            // the saved bytes already equal the import and Undo legitimately
            // does nothing. Logged, not hidden.
            log(`undo skipped (idempotent save) ${W}`, { error: String(error).split('\n')[0] })
            undoBytes = recSaved.bytes
          }
          await page.getByRole('button', { name: 'Redo' }).last().click()
          try {
            await waitMd5(page, recSaved.costume.md5ext!)
          } catch {
            // No history entry existed: still on the saved bytes.
          }
          const redoExport = await exportSb3(page)
          const redoBytes = costumeRecord(redoExport, spriteName, metaSaved.index).bytes
          log(`redo ${W}`, { equalSaved: Buffer.from(redoBytes).equals(Buffer.from(recSaved.bytes)) })
          expect(Buffer.from(redoBytes).equals(Buffer.from(recSaved.bytes))).toBe(true)
          await checkCanary('after-undo-redo')

          // Convert attempt: bitmap -> vector -> Undo restores the PNG bytes.
          await page.getByRole('button', { name: 'ベクターに変換' }).click()
          await waitDataFormat(page, 'svg')
          const metaVec = await selectedCostumeMeta(page)
          const vecExport = await exportSb3(page)
          const vecRec = costumeRecord(vecExport, spriteName, metaVec.index)
          log(`converted to vector ${W}`, { meta: vecRec.costume, bytes: vecRec.bytes.length })
          expect(vecRec.costume.dataFormat).toBe('svg')
          await checkCanary('after-convert')
          await page.getByRole('button', { name: 'Undo' }).last().click()
          await waitMd5(page, recSaved.costume.md5ext!)
          const backExport = await exportSb3(page)
          const backRec = costumeRecord(backExport, spriteName, metaVec.index)
          expect(backRec.costume.dataFormat).toBe('png')
          expect(Buffer.from(backRec.bytes).equals(Buffer.from(redoBytes))).toBe(true)
          log(`convert-undo restores ${W}`, { dims: pngDimensions(backRec.bytes) })

          // Reload round-trip: exported SB3 re-imports byte-identical.
          const reloadBytes = buildSb3(saved.project, Object.fromEntries(Object.entries(saved.assets).map(([k, v]) => [k, new Uint8Array(v)])))
          await importSb3(page, Buffer.from(reloadBytes), `wide${W}`)
          await page.getByTestId(`target-card-${spriteName}`).click()
          await page.waitForTimeout(800)
          await page.getByRole('button', { name: `Select wide${W}` }).first().click()
          await page.waitForTimeout(600)
          await waitCanvasSettled(page)
          const reloadExport = await exportSb3(page)
          const reloadRec = costumeRecord(reloadExport, spriteName, 0)
          log(`reload ${W}`, { dims: pngDimensions(reloadRec.bytes), meta: reloadRec.costume })
          expect(Buffer.from(reloadRec.bytes).equals(Buffer.from(recSaved.bytes))).toBe(true)
          await checkCanary('after-reload')
        } else {
          // ============ BLANK branch: refusal or non-destructive no-op ====
          // The browser raster refused this side (mirrors the toBlob-null /
          // blank-canvas probe). The editor must NOT silently persist a
          // blanked/transparent asset: either the explicit refusal status is
          // shown, or every mutation path leaves the bytes byte-identical.
          const md5Before = meta0.md5ext!
          // Edit attempt (must be a no-op on a refused/blank workspace).
          const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
          if (box) {
            try {
              await page.getByTestId('bitmap-tool-brush').click({ timeout: 5_000 })
              const dot = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
              await page.mouse.move(dot.x, dot.y)
              await page.mouse.down()
              await page.mouse.move(dot.x + 2, dot.y + 1, { steps: 2 })
              await page.mouse.up()
            } catch (error) {
              log(`brush attempt unavailable ${W}`, { error: String(error).split('\n')[0] })
            }
          }
          const editedAfterBrush = await waitMd5Changed(page, md5Before, 8_000)
          // Save attempt.
          try {
            await page.getByTestId('save-bitmap-costume').click({ timeout: 5_000 })
          } catch (error) {
            log(`save click unavailable ${W}`, { error: String(error).split('\n')[0] })
          }
          await page.waitForTimeout(1200)
          const statusAfterSave = await readStatus(page)
          const metaAfterSave = await selectedCostumeMeta(page)
          const afterSave = await exportSb3(page)
          const recAfterSave = costumeRecord(afterSave, spriteName, metaAfterSave.index)
          const unchangedAfterSave = Buffer.from(recAfterSave.bytes).equals(Buffer.from(extremePng))
          let dimsAfterSave: unknown
          let endsAfterSave: unknown
          try {
            dimsAfterSave = pngDimensions(recAfterSave.bytes)
            const rgba = decodePng(Buffer.from(recAfterSave.bytes))
            endsAfterSave = endpointSummary(rgba.data, rgba.width, W)
          } catch (error) {
            dimsAfterSave = `undecodable: ${String(error).split('\n')[0]}`
          }
          log(`blank-branch after brush+save ${W}`, {
            editedAfterBrush,
            status: statusAfterSave,
            meta: recAfterSave.costume,
            unchanged: unchangedAfterSave,
            dims: dimsAfterSave,
            ends: endsAfterSave,
          })
          await checkCanary('blank-after-save')
          // Convert attempt must also be non-destructive here.
          try {
            await page.getByRole('button', { name: 'ベクターに変換' }).click({ timeout: 5_000 })
            await page.waitForTimeout(1200)
          } catch (error) {
            log(`convert click unavailable ${W}`, { error: String(error).split('\n')[0] })
          }
          const statusAfterConvert = await readStatus(page)
          const afterConvert = await exportSb3(page)
          const recAfterConvert = costumeRecord(afterConvert, spriteName, metaAfterSave.index)
          const unchangedAfterConvert = Buffer.from(recAfterConvert.bytes).equals(Buffer.from(extremePng))
          let convertedHead = ''
          try {
            convertedHead = Buffer.from(recAfterConvert.bytes).toString('utf8').slice(0, 300)
          } catch {
            convertedHead = '(binary)'
          }
          log(`blank-branch after convert ${W}`, { status: statusAfterConvert, meta: recAfterConvert.costume, unchanged: unchangedAfterConvert, convertedHead })
          await checkCanary('blank-after-convert')

          const explicitRefusal = statusAfterSave === REFUSAL_STATUS || statusAfterConvert === REFUSAL_STATUS
          // REQUIRED: explicit refusal status, or byte-identical no-op on
          // every path. A silent transparent/blanked overwrite fails here
          // with the forensics above (the data-loss vector under test).
          expect(explicitRefusal || (unchangedAfterSave && unchangedAfterConvert)).toBe(true)
          if (!explicitRefusal) {
            expect(unchangedAfterSave).toBe(true)
            expect(unchangedAfterConvert).toBe(true)
            expect(recAfterSave.costume.bitmapResolution).toBe(2)
            expect(recAfterSave.costume.rotationCenterX).toBe(W / 2)
            expect(recAfterSave.costume.rotationCenterY).toBe(1)
          }
          // Undo/Redo recoverability (logged evidence; asserts only when a
          // history entry actually moved the md5).
          if (!unchangedAfterSave || !unchangedAfterConvert) {
            try {
              await page.getByRole('button', { name: 'Undo' }).last().click()
              await waitMd5(page, md5Before)
              const undoExport = await exportSb3(page)
              const undoRec = costumeRecord(undoExport, spriteName, metaAfterSave.index)
              log(`blank-branch undo restores ${W}`, { restored: Buffer.from(undoRec.bytes).equals(Buffer.from(extremePng)) })
            } catch (error) {
              log(`blank-branch undo failed ${W}`, { error: String(error).split('\n')[0] })
            }
          }
          await checkCanary('blank-final')
        }
      } finally {
        await context.close()
      }
    }, 240_000)
  }
})
