import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { inflateSync as inflateRaw, strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real Editor/VM verification for the costume-conversion fix.
//
// Product code is untouched: this file only drives the REAL costume editor
// through Playwright (the same `ベクターに変換` / `ビットマップに変換`
// buttons production users press) and asserts the REAL VM project state
// (`__hikkakuEditorTest.snapshot()` meta), the REAL persisted bytes (SB3
// export downloads: asset PNG IHDR dims / SVG text geometry), and the REAL
// stage pixels (stage-canvas compositor screenshots decoded to RGBA, never
// `stage.getContext()` which is transferred to OffscreenCanvas).
//
// Covers (without loosening expectations):
// - small 96x96 sprite SVG: non-central rotationCenter (30,70), negative
//   viewBox (-10 -10 96 96), semitransparent circle, clipped overflow rect,
//   opaque background (full-canvas trim => exact 96<->192 round-trip)
// - large / slender / empty SVGs (dims, resolution, transparency)
// - stage 480x360 backdrop vector<->bitmap (resolution 1)
// - bitmap sources with transparent margins at resolution 2 (sprite upload)
//   and resolution 1 (SB3 import), verifying trimmed 1:1 vectors
// - legacy oversized 2400x1800 bitmap: before -> vector -> back to bitmap
//   (compatibly oversized 1200x900 SVG, then exact 2400x1800 restoration)
// - every conversion: asset dims + bitmapResolution + rotationCenter +
//   real stage RGBA (ink colour presence, centroid position, before/after diff)
// - extra paint edit after the round-trip + Save button + SB3 export (save)
//   + SB3 re-import (reload) persistence
// - Undo/Redo: asset bytes (SB3) and meta (snapshot) round-trip byte-exact
//
// Dedicated Vite port 4483 (surveyed 2026-11: 4173/4178/4179/4180/4183/
// 4189/4191/4197/4198/4199/4205/4213/4227/4228/4231/4232/4234/4235/4236/
// 4237/4238/4241/4242/4244/4245/4247/4249/4252/4253/4255/4256/4259/4261/
// 4263/4264/4265/4271/4277/4281/4288/4289/4291/4293/4294/4295/4297/4299/
// 4311/4313/4317/4321/4322/4323/4327/4329/4330/4331/4333/4334/4335/4337/
// 4341/4345/4347/4348/4355/4361/4367/4371/4377/4381/4395/4399/4401/4427/
// 4449/4451/4461/4477/4478/4495 are taken by the other suites).
const root = join(import.meta.dir, '..')
const PORT = 4483
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined

// --- deterministic builders (no product imports) ---------------------------

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

/** Minimal RGBA PNG encoder (opaque + transparent + alpha). */
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
  // PNG IDATs must be zlib-wrapped (RFC 1950), not raw deflate: Chrome
  // decodes the dimensions but rasterizes raw-deflate IDATs as blank, so
  // test uploads would paint/stage nothing while Node rejects them.
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

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('Not a PNG')
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return { width, height }
}

function svgSize(text: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(tag)?.[1] ?? ''
    const v = Number(m)
    return Number.isFinite(v) && v > 0 ? v : undefined
  }
  return { width: num(/width\s*=\s*["']([^"']*)["']/i) ?? 0, height: num(/height\s*=\s*["']([^"']*)["']/i) ?? 0 }
}

function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function sb3Costume(name: string, bytes: Uint8Array, ext: string, extra: Record<string, unknown>) {
  const hash = md5(bytes)
  return { entry: { name, assetId: hash, md5ext: `${hash}.${ext}`, dataFormat: ext, ...extra }, file: `${hash}.${ext}` as const, bytes }
}

// --- PNG screenshot decode (compositor path, no stage.getContext) -----------

function decodePng(png: Buffer | Uint8Array): { width: number; height: number; data: Buffer } {
  const bytes = Buffer.from(png)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('Not a PNG screenshot')
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
    if (dataEnd + 4 > bytes.length) throw new Error('Truncated PNG screenshot')
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
  if (width === 0 || height === 0) throw new Error('Missing PNG image header')
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG screenshot format (depth=${bitDepth}, color=${colorType})`)
  }
  const channels = colorType === 6 ? 4 : 3
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idatParts))
  } catch {
    // Chrome screenshots use zlib-wrapped IDATs; keep accepting raw-deflate
    // too (older test-built fixtures). Browsers rasterize raw-deflate IDATs
    // as blank, so only the zlib path carries real stage pixels.
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
    if (current.length !== stride) throw new Error('Truncated PNG scanline')
    rawOffset += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? (current[x - channels] ?? 0) : 0
      const b = previous[x] ?? 0
      const c = x >= channels ? (previous[x - channels] ?? 0) : 0
      const currentByte = current[x] ?? 0
      if (filter === 1) current[x] = (currentByte + a) & 0xff
      else if (filter === 2) current[x] = (currentByte + b) & 0xff
      else if (filter === 3) current[x] = (currentByte + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        current[x] = (currentByte + predictor) & 0xff
      }
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels
      const target = (y * width + x) * 4
      rgba[target] = current[source] ?? 0
      rgba[target + 1] = current[source + 1] ?? 0
      rgba[target + 2] = current[source + 2] ?? 0
      rgba[target + 3] = channels === 4 ? (current[source + 3] ?? 255) : 255
    }
    previous = current
  }
  return { width, height, data: rgba }
}

function countWhere(data: Buffer, pred: (r: number, g: number, b: number, a: number) => boolean): number {
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (pred(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0)) n += 1
  }
  return n
}

const isRed = (r: number, g: number, b: number, a: number) => a > 128 && r > 200 && g < 100 && b < 100
const isGreen = (r: number, g: number, b: number, a: number) => a > 128 && g > 150 && r < 120 && b < 120
const isNonWhite = (r: number, g: number, b: number, a: number) => a > 10 && (r < 245 || g < 245 || b < 245)

function centroid(data: Buffer, width: number, height: number, pred: (r: number, g: number, b: number, a: number) => boolean) {
  let n = 0
  let sx = 0
  let sy = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      if (pred(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0)) {
        n += 1
        sx += x
        sy += y
      }
    }
  }
  return n === 0 ? { count: 0, cx: -1, cy: -1 } : { count: n, cx: sx / n, cy: sy / n }
}

function diffRatio(a: Buffer, b: Buffer): { ratio: number; max: number } {
  if (a.length !== b.length) return { ratio: 1, max: 4 * 255 }
  let differing = 0
  let max = 0
  const total = a.length / 4
  for (let i = 0; i < a.length; i += 4) {
    const d =
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) +
      Math.abs((a[i + 3] ?? 0) - (b[i + 3] ?? 0))
    if (d > max) max = d
    if (d > 48) differing += 1
  }
  return { ratio: differing / total, max }
}

// --- page helpers (real Editor UI only) -------------------------------------

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function costumeCount(page: Page): Promise<number> {
  return await page.getByTestId(/costume-card-\d+/).count()
}

async function uploadCostumeFile(page: Page, name: string, mimeType: string, buffer: Buffer | Uint8Array) {
  const before = await costumeCount(page)
  await page.getByTestId('costume-file-input').setInputFiles({ name, mimeType, buffer: Buffer.from(buffer) })
  await page.waitForFunction((count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count, before, { timeout: 30_000 })
  const shortName = name.replace(/\.[^.]+$/, '')
  await page.getByRole('button', { name: `Select ${shortName}` }).last().click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)
}

async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'conversion-verify.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as any).__hikkakuEditorTest?.snapshot()
      return snap?.project.targets.some((t: any) => t.costumes.some((c: any) => c.name === want)) ?? false
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
    const snap = (window as any).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t: any) => !t.isStage) ?? snap.project.targets[0]!
    const index = target.currentCostume ?? 0
    const costume = target.costumes[index]!
    return { targetName: target.name, index, name: costume.name, dataFormat: costume.dataFormat ?? '', bitmapResolution: costume.bitmapResolution, rotationCenterX: costume.rotationCenterX, rotationCenterY: costume.rotationCenterY, md5ext: costume.md5ext }
  })
}

async function waitDataFormat(page: Page, format: string, notMd5?: string, timeout = 30_000) {
  await page.waitForFunction(
    ({ wantFormat, banMd5 }: { wantFormat: string; banMd5?: string }) => {
      const snap = (window as any).__hikkakuEditorTest.snapshot()
      const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t: any) => !t.isStage) ?? snap.project.targets[0]!
      const costume = target.costumes[target.currentCostume ?? 0]!
      if ((costume.dataFormat ?? '') !== wantFormat) return false
      if (banMd5 && costume.md5ext === banMd5) return false
      return true
    },
    { wantFormat: format, banMd5: notMd5 } as unknown as undefined,
    { timeout },
  )
}

async function waitCostume(page: Page, pred: (meta: CostumeMeta) => boolean, timeout = 30_000) {
  const source = `(${pred.toString()})`
  await page.waitForFunction(
    (fn: string) => {
      const snap = (window as any).__hikkakuEditorTest.snapshot()
      const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t: any) => !t.isStage) ?? snap.project.targets[0]!
      const index = target.currentCostume ?? 0
      const costume = target.costumes[index]!
      const meta = { targetName: target.name, index, name: costume.name, dataFormat: costume.dataFormat ?? '', bitmapResolution: costume.bitmapResolution, rotationCenterX: costume.rotationCenterX, rotationCenterY: costume.rotationCenterY, md5ext: costume.md5ext }
      const test = new Function('meta', `return (${fn})(meta)`) as (m: unknown) => boolean
      return test(meta)
    },
    source,
    { timeout },
  )
}

async function waitMd5(page: Page, md5ext: string, timeout = 30_000) {
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as any).__hikkakuEditorTest.snapshot()
      const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t: any) => !t.isStage) ?? snap.project.targets[0]!
      const costume = target.costumes[target.currentCostume ?? 0]!
      return costume.md5ext === want
    },
    md5ext as unknown as undefined,
    { timeout },
  )
}

async function setRotationCenter(page: Page, x: number, y: number) {
  // The Center X/Y number inputs live in the costume sidebar (may be below
  // the fold while the paint surface has focus), so set them through the
  // real inputs with real input/change events rather than a visibility-
  // dependent fill. This still exercises the production onchange path
  // (`updateCostumeRotationCenter`).
  await page.evaluate(
    ({ wantX, wantY }: { wantX: number; wantY: number }) => {
      const labels = Array.from(document.querySelectorAll('label'))
      const inputFor = (text: string): HTMLInputElement | undefined => {
        const label = labels.find((l) => (l.textContent ?? '').includes(text))
        return label?.querySelector('input') as HTMLInputElement | undefined
      }
      const set = (input: HTMLInputElement | undefined, value: number) => {
        if (!input) throw new Error('Missing Center input in costume sidebar')
        input.scrollIntoView({ block: 'nearest' })
        input.focus()
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
          ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        if (setter) setter.call(input, String(value))
        else input.value = String(value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      set(inputFor('Center X'), wantX)
      set(inputFor('Center Y'), wantY)
    },
    { wantX: x, wantY: y } as unknown as undefined,
  )
  await page.waitForFunction(
    ({ wantX, wantY }: { wantX: number; wantY: number }) => {
      const snap = (window as any).__hikkakuEditorTest.snapshot()
      const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets[0]!
      const costume = target.costumes[target.currentCostume ?? 0]!
      return costume.rotationCenterX === wantX && costume.rotationCenterY === wantY
    },
    { wantX: x, wantY: y } as unknown as undefined,
    { timeout: 15_000 },
  )
}

async function convertToBitmap(page: Page) {
  const before = await selectedCostumeMeta(page)
  await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  await waitDataFormat(page, 'png', before.md5ext)
  await page.waitForTimeout(600)
}

async function convertToVector(page: Page) {
  const before = await selectedCostumeMeta(page)
  await page.getByRole('button', { name: 'ベクターに変換' }).click()
  await waitDataFormat(page, 'svg', before.md5ext)
  await page.waitForTimeout(600)
}

async function undoRedoButtons(page: Page) {
  return {
    undo: page.getByRole('button', { name: 'Undo' }).last(),
    redo: page.getByRole('button', { name: 'Redo' }).last(),
  }
}

async function exportSb3(page: Page): Promise<{ project: { targets: Array<{ name: string; isStage: boolean; currentCostume: number; costumes: Array<{ name: string; dataFormat?: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> }> }; assets: Record<string, Uint8Array> }> {
  const fileTrigger = page.getByText('ファイル', { exact: true }).first()
  if (await fileTrigger.isVisible()) await fileTrigger.click()
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: 'SB3' }).first().click()
  const download = await downloadPromise
  const path = await download.path()
  let bytes: Buffer
  if (path) {
    bytes = readFileSync(path)
  } else {
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
    bytes = Buffer.concat(chunks)
  }
  const archive = unzipSync(new Uint8Array(bytes))
  const project = JSON.parse(strFromU8(archive['project.json']!))
  const assets: Record<string, Uint8Array> = {}
  for (const [key, value] of Object.entries(archive)) {
    if (key !== 'project.json') assets[key] = value as Uint8Array
  }
  return { project, assets }
}

function findCostume(project: { targets: Array<{ name: string; isStage: boolean; currentCostume: number; costumes: Array<{ name: string; dataFormat?: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> }> }, targetName: string, index: number) {
  const target = project.targets.find((t) => t.name === targetName)!
  return { target, costume: target.costumes[index]! }
}

async function stageRgba(page: Page) {
  // Element screenshots go through the compositor (safe for the transferred
  // OffscreenCanvas). Retry detached-element flakes from concurrent HMR
  // remounts; a full page reload loses VM state and fails loudly downstream.
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const png = await page.getByTestId('stage-canvas').screenshot({ type: 'png', timeout: 15_000 })
      return decodePng(png)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError
}

// The VM renderer decodes costume images asynchronously (new Image() +
// object URL per asset), so a screenshot taken immediately after an upload
// or conversion can catch a partially loaded frame. Poll until two
// consecutive compositor screenshots are stable instead of asserting on a
// loading frame. Thresholds elsewhere stay strict; this only removes the
// test race.
async function waitStageSettled(page: Page, timeout = 25_000): Promise<{ width: number; height: number; data: Buffer }> {
  const start = Date.now()
  let previous: { width: number; height: number; data: Buffer } | undefined
  let stable = 0
  let lastDiff = 1
  for (;;) {
    const current = await stageRgba(page)
    if (previous && previous.width === current.width && previous.height === current.height) {
      lastDiff = diffRatio(previous.data, current.data).ratio
      if (lastDiff < 0.004) {
        stable += 1
        if (stable >= 2) return current
      } else {
        stable = 0
      }
    } else {
      stable = 0
    }
    previous = current
    if (Date.now() - start > timeout) {
      throw new Error(`Stage never settled (lastDiff=${lastDiff})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}

/** Live bitmap-canvas content at conversion time (honest trim witness). */
async function canvasDiag(page: Page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) return { found: false as const }
    const context = canvas.getContext('2d')
    if (!context) return { found: true as const, readable: false as const }
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    let opaque = 0
    let left = canvas.width
    let top = canvas.height
    let right = -1
    let bottom = -1
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if ((image.data[(y * canvas.width + x) * 4 + 3] ?? 0) === 0) continue
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

/** Wait until the live bitmap canvas shows ink (upload reloads are async and
 * revision-guarded; a fixed sleep races them). Tolerates the mode-switch
 * remount (element may briefly detach). Throws loudly when the product
 * leaves the canvas blank, instead of laundering it into a conversion diff. */
async function waitCanvasInk(page: Page, timeout = 25_000): Promise<void> {
  const start = Date.now()
  let last = ''
  for (;;) {
    const diag = await canvasDiag(page)
    last = JSON.stringify(diag)
    if (diag.found && (diag as { readable?: boolean }).readable && (diag as { opaque?: number }).opaque! > 0) return
    if (Date.now() - start > timeout) {
      throw new Error(`Bitmap canvas never showed ink after upload (last=${last})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Re-click the current costume's Select button to force a deterministic
 * preview reload on the live (post-remount) canvas element. */
async function reselectCurrentCostume(page: Page): Promise<void> {
  const meta = await selectedCostumeMeta(page)
  await page.getByRole('button', { name: `Select ${meta.name}` }).first().click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(500)
}

/** Extract the embedded raster from a converted vector SVG (honest byte check). */
function embeddedPngFromVectorSvg(vectorText: string): Uint8Array {
  const match = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(vectorText)
  if (!match) throw new Error('Converted vector SVG carries no embedded PNG data URL')
  return new Uint8Array(Buffer.from(match[1], 'base64'))
}

function logReport(label: string, value: unknown) {
  console.log(`[conversion-verify] ${label} ${JSON.stringify(value).slice(0, 2000)}`)
}

// --- fixtures ----------------------------------------------------------------

const SMALL_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-10 -10 96 96">` +
  `<rect x="-10" y="-10" width="96" height="96" fill="#ffffff"/>` +
  `<rect x="10" y="10" width="30" height="30" fill="#ff0000"/>` +
  `<circle cx="55" cy="55" r="15" fill="#0000ff" opacity="0.5"/>` +
  `<rect x="80" y="80" width="20" height="20" fill="#00ff00"/>` +
  `</svg>`

describe('costume conversion in the real Editor/VM (no synthetic canvas)', () => {
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
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('96x96 sprite (non-central center, negative viewBox, translucency, clip) round-trips with identical stage ink', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await uploadCostumeFile(page, 'conv-small.svg', 'image/svg+xml', Buffer.from(SMALL_SVG, 'utf8'))
      await setRotationCenter(page, 30, 70)
      const metaVector0 = await selectedCostumeMeta(page)
      expect(metaVector0.dataFormat).toBe('svg')
      expect(metaVector0.rotationCenterX).toBe(30)
      expect(metaVector0.rotationCenterY).toBe(70)
      const saved0 = await exportSb3(page)
      const beforeCostume0 = findCostume(saved0.project, metaVector0.targetName, metaVector0.index).costume
      const beforeBytes0 = saved0.assets[beforeCostume0.md5ext!]!
      expect(beforeBytes0.length).toBeGreaterThan(0)
      const beforeText0 = Buffer.from(beforeBytes0).toString('utf8')
      expect(svgSize(beforeText0)).toEqual({ width: 96, height: 96 })
      expect(beforeText0).toContain('viewBox="-10 -10 96 96"')
      const stage0 = await waitStageSettled(page)
      const red0 = centroid(stage0.data, stage0.width, stage0.height, isRed)
      const green0 = countWhere(stage0.data, isGreen)
      logReport('small vector0', { meta: metaVector0, red: red0, green: green0, shot: { w: stage0.width, h: stage0.height } })
      expect(red0.count).toBeGreaterThan(50)
      expect(green0).toBeGreaterThan(20)

      // vector -> bitmap: 96x96 @2x = 192x192, center scaled 30->60 / 70->140.
      await convertToBitmap(page)
      const metaBitmap = await selectedCostumeMeta(page)
      expect(metaBitmap.dataFormat).toBe('png')
      expect(metaBitmap.bitmapResolution).toBe(2)
      expect(metaBitmap.rotationCenterX).toBe(60)
      expect(metaBitmap.rotationCenterY).toBe(140)
      const savedBitmap = await exportSb3(page)
      const bitmapCostume = findCostume(savedBitmap.project, metaBitmap.targetName, metaBitmap.index).costume
      expect(bitmapCostume.bitmapResolution).toBe(2)
      expect(bitmapCostume.rotationCenterX).toBe(60)
      expect(bitmapCostume.rotationCenterY).toBe(140)
      const bitmapBytes = savedBitmap.assets[bitmapCostume.md5ext!]!
      expect(pngDimensions(bitmapBytes)).toEqual({ width: 192, height: 192 })
      // The stored raster itself must carry the ink (decoding here proves the
      // vector->bitmap raster path is sound even when the editing surface
      // later disagrees with it).
      const bitmapRgba = decodePng(Buffer.from(bitmapBytes))
      expect(countWhere(bitmapRgba.data, isRed)).toBeGreaterThan(1000)
      const stageBitmap = await waitStageSettled(page)
      const redBitmap = centroid(stageBitmap.data, stageBitmap.width, stageBitmap.height, isRed)
      const diffVb = diffRatio(stage0.data, stageBitmap.data)
      logReport('small bitmap', { meta: metaBitmap, red: redBitmap, diff: diffVb })
      expect(redBitmap.count).toBeGreaterThan(50)
      expect(Math.abs(redBitmap.cx - red0.cx)).toBeLessThanOrEqual(4)
      expect(Math.abs(redBitmap.cy - red0.cy)).toBeLessThanOrEqual(4)
      expect(diffVb.ratio).toBeLessThan(0.02)

      // bitmap -> vector: fully opaque trim => exact 96x96 with center (30,70).
      const canvasDiagBefore = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return { found: false as const }
        const context = canvas.getContext('2d')
        if (!context) return { found: true as const, readable: false as const }
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        let opaque = 0
        let left = canvas.width
        let top = canvas.height
        let right = -1
        let bottom = -1
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            if ((image.data[(y * canvas.width + x) * 4 + 3] ?? 0) === 0) continue
            opaque += 1
            if (x < left) left = x
            if (y < top) top = y
            if (x > right) right = x
            if (y > bottom) bottom = y
          }
        }
        return { found: true as const, readable: true as const, width: canvas.width, height: canvas.height, opaque, trim: right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null }
      })
      logReport('small canvas before vectorize', canvasDiagBefore)
      await convertToVector(page)
      const metaVector1 = await selectedCostumeMeta(page)
      expect(metaVector1.dataFormat).toBe('svg')
      expect(metaVector1.bitmapResolution).toBe(1)
      expect(metaVector1.rotationCenterX).toBeCloseTo(30, 9)
      expect(metaVector1.rotationCenterY).toBeCloseTo(70, 9)
      const savedVector1 = await exportSb3(page)
      const vectorCostume1 = findCostume(savedVector1.project, metaVector1.targetName, metaVector1.index).costume
      const vectorBytes1 = savedVector1.assets[vectorCostume1.md5ext!]!
      const vectorText1 = Buffer.from(vectorBytes1).toString('utf8')
      const size1 = svgSize(vectorText1)
      const statusAfterVectorize = await page.evaluate(() => (window as any).__hikkakuEditorTest.status())
      logReport('small vector1', { meta: metaVector1, size: size1, hasImage: vectorText1.includes('<image'), hasData: vectorText1.includes('data:image'), len: vectorText1.length, head: vectorText1.slice(0, 600), status: statusAfterVectorize })
      expect(size1.width).toBeCloseTo(96, 0)
      expect(size1.height).toBeCloseTo(96, 0)
      // The persisted vector must still carry the trimmed raster (fail-closed
      // sanitizers on both boundaries keep allowlisted data: PNG images).
      expect(vectorText1.includes('<image')).toBe(true)
      const embedded1 = embeddedPngFromVectorSvg(vectorText1)
      expect(pngDimensions(embedded1)).toEqual({ width: 192, height: 192 })
      const embeddedRgba1 = decodePng(Buffer.from(embedded1))
      const embeddedRed1 = countWhere(embeddedRgba1.data, isRed)
      logReport('small vector1 embedded', { red: embeddedRed1, w: embeddedRgba1.width, h: embeddedRgba1.height })
      expect(embeddedRed1).toBeGreaterThan(1000)
      const stageVector1 = await waitStageSettled(page)
      const redVector1 = centroid(stageVector1.data, stageVector1.width, stageVector1.height, isRed)
      const diffBv = diffRatio(stageBitmap.data, stageVector1.data)
      const diffVv = diffRatio(stage0.data, stageVector1.data)
      logReport('small vector1 stage', { red: redVector1, diffBv, diffVv })
      expect(redVector1.count).toBeGreaterThan(50)
      expect(Math.abs(redVector1.cx - red0.cx)).toBeLessThanOrEqual(4)
      expect(Math.abs(redVector1.cy - red0.cy)).toBeLessThanOrEqual(4)
      expect(diffBv.ratio).toBeLessThan(0.02)
      expect(diffVv.ratio).toBeLessThan(0.02)

      // Undo restores the bitmap bytes+meta, Redo restores the vector bytes+meta.
      const { undo, redo } = await undoRedoButtons(page)
      await undo.click()
      await waitCostume(page, (meta) => meta.dataFormat === 'png' && meta.rotationCenterX === 60)
      const metaUndo = await selectedCostumeMeta(page)
      expect(metaUndo.md5ext).toBe(metaBitmap.md5ext)
      const savedUndo = await exportSb3(page)
      const undoCostume = findCostume(savedUndo.project, metaUndo.targetName, metaUndo.index).costume
      expect(undoCostume.md5ext).toBe(bitmapCostume.md5ext)
      expect(Buffer.from(savedUndo.assets[undoCostume.md5ext!]!).equals(Buffer.from(bitmapBytes))).toBe(true)
      await redo.click()
      await waitMd5(page, metaVector1.md5ext!)
      const metaRedo = await selectedCostumeMeta(page)
      expect(metaRedo.md5ext).toBe(metaVector1.md5ext)
      const savedRedo = await exportSb3(page)
      const redoCostume = findCostume(savedRedo.project, metaRedo.targetName, metaRedo.index).costume
      expect(Buffer.from(savedRedo.assets[redoCostume.md5ext!]!).equals(Buffer.from(vectorBytes1))).toBe(true)

      // Extra edit after the round-trip + Save + export(save) + re-import(reload).
      await convertToBitmap(page)
      const metaPreEdit = await selectedCostumeMeta(page)
      const canvasBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
      if (!canvasBox) throw new Error('Missing bitmap canvas')
      await page.getByTestId('bitmap-tool-brush').click()
      const cx = canvasBox.x + canvasBox.width / 2
      const cy = canvasBox.y + canvasBox.height / 2
      await page.mouse.move(cx - 20, cy - 20)
      await page.mouse.down()
      await page.mouse.move(cx + 20, cy + 20, { steps: 8 })
      await page.mouse.up()
      await page.getByTestId('save-bitmap-costume').click()
      await waitDataFormat(page, 'png', metaPreEdit.md5ext)
      const metaEdited = await selectedCostumeMeta(page)
      const savedEdited = await exportSb3(page)
      const editedCostume = findCostume(savedEdited.project, metaEdited.targetName, metaEdited.index).costume
      const editedBytes = savedEdited.assets[editedCostume.md5ext!]!
      expect(pngDimensions(editedBytes)).toEqual({ width: 192, height: 192 })
      expect(Buffer.from(editedBytes).equals(Buffer.from(bitmapBytes))).toBe(false)
      const reloadBytes = buildSb3(savedEdited.project, Object.fromEntries(Object.entries(savedEdited.assets).map(([k, v]) => [k, new Uint8Array(v)])))
      await importSb3(page, reloadBytes, editedCostume.name)
      const metaReload = await selectedCostumeMeta(page)
      logReport('small reload', { meta: metaReload })
      expect(metaReload.dataFormat).toBe('png')
      expect(metaReload.bitmapResolution).toBe(2)
    } finally {
      await context.close()
    }
  }, 180_000)

  it('large / slender / empty SVGs convert with exact asset geometry and stage parity', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      const cases: Array<{ file: string; svg: string; w: number; h: number; empty: boolean }> = [
        {
          file: 'conv-large.svg',
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect x="0" y="0" width="320" height="160" fill="#ffffff"/><rect x="20" y="20" width="60" height="40" fill="#ff0000"/></svg>`,
          w: 320,
          h: 160,
          empty: false,
        },
        {
          file: 'conv-slender.svg',
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="192" viewBox="0 0 24 192"><rect x="0" y="0" width="24" height="192" fill="#ffffff"/><rect x="4" y="80" width="16" height="32" fill="#ff0000"/></svg>`,
          w: 24,
          h: 192,
          empty: false,
        },
        {
          file: 'conv-empty.svg',
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"></svg>`,
          w: 96,
          h: 96,
          empty: true,
        },
      ]
      for (const item of cases) {
        await uploadCostumeFile(page, item.file, 'image/svg+xml', Buffer.from(item.svg, 'utf8'))
        const metaV = await selectedCostumeMeta(page)
        expect(metaV.dataFormat).toBe('svg')
        // Sprite uploads default the center to (48,48); the conversion must
        // scale that exact center (not recenter to the SVG middle).
        expect(metaV.rotationCenterX).toBe(48)
        expect(metaV.rotationCenterY).toBe(48)
        const stageV = await waitStageSettled(page)
        const redV = countWhere(stageV.data, isRed)
        const nonWhiteV = countWhere(stageV.data, isNonWhite)
        await convertToBitmap(page)
        const metaB = await selectedCostumeMeta(page)
        expect(metaB.bitmapResolution).toBe(2)
        expect(metaB.rotationCenterX).toBe(96)
        expect(metaB.rotationCenterY).toBe(96)
        const savedB = await exportSb3(page)
        const costumeB = findCostume(savedB.project, metaB.targetName, metaB.index).costume
        const dimsB = pngDimensions(savedB.assets[costumeB.md5ext!]!)
        logReport(`shape ${item.file} bitmap`, { meta: metaB, dims: dimsB, redV })
        expect(dimsB).toEqual({ width: item.w * 2, height: item.h * 2 })
        expect(costumeB.rotationCenterX).toBe(96)
        expect(costumeB.rotationCenterY).toBe(96)
        const stageB = await waitStageSettled(page)
        const diff = diffRatio(stageV.data, stageB.data)
        logReport(`shape ${item.file} stage`, { diff, redB: countWhere(stageB.data, isRed) })
        expect(diff.ratio).toBeLessThan(0.02)
        if (item.empty) {
          expect(redV).toBe(0)
          expect(countWhere(stageB.data, isRed)).toBe(0)
          expect(nonWhiteV).toBeLessThan(countWhere(stageB.data, isNonWhite) + 2000)
        } else {
          expect(redV).toBeGreaterThan(10)
          expect(countWhere(stageB.data, isRed)).toBeGreaterThan(10)
        }
        await convertToVector(page)
        const metaBack = await selectedCostumeMeta(page)
        expect(metaBack.dataFormat).toBe('svg')
        const savedBack = await exportSb3(page)
        const costumeBack = findCostume(savedBack.project, metaBack.targetName, metaBack.index).costume
        const textBack = Buffer.from(savedBack.assets[costumeBack.md5ext!]!).toString('utf8')
        if (item.empty) {
          expect(textBack.includes('<image')).toBe(false)
          expect(svgSize(textBack)).toEqual({ width: item.w, height: item.h })
        } else {
          const sizeBack = svgSize(textBack)
          expect(sizeBack.width).toBeCloseTo(item.w, 0)
          expect(sizeBack.height).toBeCloseTo(item.h, 0)
          // Stage diffs alone are too coarse here (small ink vs 2% budget),
          // so pin the raster payload directly: non-empty vectors must carry
          // the trimmed raster, and the stage must still show the ink.
          expect(textBack.includes('<image')).toBe(true)
        }
        const stageBack = await waitStageSettled(page)
        expect(diffRatio(stageB.data, stageBack.data).ratio).toBeLessThan(0.02)
        if (!item.empty) expect(countWhere(stageBack.data, isRed)).toBeGreaterThan(10)
      }
    } finally {
      await context.close()
    }
  }, 180_000)

  it('documents the VM 300-wide SVG sizing quirk on the real stage (exact-300 width is forced to center*2)', async () => {
    // Pre-existing VM behavior, unrelated to the conversion math under test:
    // `costumeImageSize` rewrites ANY SVG whose natural width is exactly 300
    // to `center*2` (a legacy placeholder heuristic). A 300x150 sprite with
    // center (48,48) therefore renders at 96x96 instead of 300x150, so the
    // conversion's correct 600x300 bitmap cannot match the stage. This test
    // pins the CORRECT expectation (300-wide artwork renders 300 wide) and
    // reports the quirk honestly instead of hiding it behind a non-300 size.
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await uploadCostumeFile(page, 'conv-300wide.svg', 'image/svg+xml', Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150"><rect x="0" y="0" width="300" height="150" fill="#ffffff"/><rect x="20" y="20" width="60" height="40" fill="#ff0000"/></svg>`,
        'utf8',
      ))
      const stageV = await waitStageSettled(page)
      const redV = countWhere(stageV.data, isRed)
      logReport('300-wide quirk stage', { redV })
      // Correct rendering draws the full 60x40-unit rect (~2600 screen px at
      // ~1.05 device scale). The quirk shrinks it to ~1/5 of that.
      expect(redV).toBeGreaterThan(1500)
    } finally {
      await context.close()
    }
  }, 120_000)

  it('stage backdrop and bitmap resolutions (1/2) with transparent margins keep ink position', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      // Stage backdrop: select Stage, upload 480x360 SVG, convert both ways.
      await page.getByTestId('target-card-stage').click()
      await page.waitForTimeout(800)
      const backdropSvg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
        `<rect x="0" y="0" width="480" height="360" fill="#ffffff"/>` +
        `<rect x="60" y="60" width="120" height="90" fill="#ff0000"/>` +
        `<circle cx="360" cy="240" r="40" fill="#0000ff" opacity="0.5"/></svg>`
      await uploadCostumeFile(page, 'conv-backdrop.svg', 'image/svg+xml', Buffer.from(backdropSvg, 'utf8'))
      const metaStageV = await selectedCostumeMeta(page)
      expect(metaStageV.dataFormat).toBe('svg')
      const stageV = await waitStageSettled(page)
      const redV = centroid(stageV.data, stageV.width, stageV.height, isRed)
      expect(redV.count).toBeGreaterThan(200)
      await convertToBitmap(page)
      const metaStageB = await selectedCostumeMeta(page)
      expect(metaStageB.dataFormat).toBe('png')
      expect(metaStageB.bitmapResolution).toBe(1)
      const savedStageB = await exportSb3(page)
      const costumeStageB = findCostume(savedStageB.project, metaStageB.targetName, metaStageB.index).costume
      expect(pngDimensions(savedStageB.assets[costumeStageB.md5ext!]!)).toEqual({ width: 480, height: 360 })
      expect(costumeStageB.rotationCenterX).toBe(240)
      expect(costumeStageB.rotationCenterY).toBe(180)
      const stageB = await waitStageSettled(page)
      const redB = centroid(stageB.data, stageB.width, stageB.height, isRed)
      const diffStage = diffRatio(stageV.data, stageB.data)
      logReport('backdrop bitmap', { meta: metaStageB, redB, diffStage })
      expect(Math.abs(redB.cx - redV.cx)).toBeLessThanOrEqual(4)
      expect(Math.abs(redB.cy - redV.cy)).toBeLessThanOrEqual(4)
      expect(diffStage.ratio).toBeLessThan(0.02)
      await convertToVector(page)
      const metaStageBack = await selectedCostumeMeta(page)
      expect(metaStageBack.dataFormat).toBe('svg')
      const savedStageBack = await exportSb3(page)
      const costumeStageBack = findCostume(savedStageBack.project, metaStageBack.targetName, metaStageBack.index).costume
      const textStageBack = Buffer.from(savedStageBack.assets[costumeStageBack.md5ext!]!).toString('utf8')
      expect(svgSize(textStageBack)).toEqual({ width: 480, height: 360 })
      expect(textStageBack.includes('<image')).toBe(true)
      const stageBack = await waitStageSettled(page)
      const diffBack = diffRatio(stageB.data, stageBack.data)
      logReport('backdrop vector', { meta: metaStageBack, diffBack })
      expect(diffBack.ratio).toBeLessThan(0.02)

      // Sprite bitmap resolution 2 with transparent margins (upload PNG).
      await page.getByTestId('target-card-Sprite1').click()
      await page.waitForTimeout(800)
      const paddedPng = buildPng(192, 192, (x, y) => {
        const inside = x >= 48 && x < 144 && y >= 48 && y < 144
        if (!inside) return [0, 0, 0, 0]
        const red = x >= 60 && x < 100 && y >= 60 && y < 100
        return red ? [255, 0, 0, 255] : [255, 255, 255, 255]
      })
      await uploadCostumeFile(page, 'conv-padded.png', 'image/png', Buffer.from(paddedPng))
      const metaPadB = await selectedCostumeMeta(page)
      expect(metaPadB.dataFormat).toBe('png')
      expect(metaPadB.bitmapResolution).toBe(2)
      await reselectCurrentCostume(page)
      await waitCanvasInk(page)
      const stagePadB = await waitStageSettled(page)
      const redPadB = centroid(stagePadB.data, stagePadB.width, stagePadB.height, isRed)
      expect(redPadB.count).toBeGreaterThan(20)
      logReport('padded canvas before vectorize', await canvasDiag(page))
      await convertToVector(page)
      const metaPadV = await selectedCostumeMeta(page)
      expect(metaPadV.dataFormat).toBe('svg')
      const savedPadV = await exportSb3(page)
      const costumePadV = findCostume(savedPadV.project, metaPadV.targetName, metaPadV.index).costume
      const textPadV = Buffer.from(savedPadV.assets[costumePadV.md5ext!]!).toString('utf8')
      const sizePadV = svgSize(textPadV)
      logReport('padded res2 vector', { meta: metaPadV, size: sizePadV })
      // 96x96 opaque ink centered in 192px => 48x48 vector, trimmed 1:1.
      expect(sizePadV.width).toBeCloseTo(48, 0)
      expect(sizePadV.height).toBeCloseTo(48, 0)
      expect(textPadV.includes('<image')).toBe(true)
      const stagePadV = await waitStageSettled(page)
      const redPadV = centroid(stagePadV.data, stagePadV.width, stagePadV.height, isRed)
      expect(Math.abs(redPadV.cx - redPadB.cx)).toBeLessThanOrEqual(5)
      expect(Math.abs(redPadV.cy - redPadB.cy)).toBeLessThanOrEqual(5)
      expect(diffRatio(stagePadB.data, stagePadV.data).ratio).toBeLessThan(0.03)

      // Sprite bitmap resolution 1 with transparent margins (SB3 import).
      const res1Png = buildPng(96, 96, (x, y) => {
        const inside = x >= 24 && x < 72 && y >= 24 && y < 72
        if (!inside) return [0, 0, 0, 0]
        const red = x >= 30 && x < 50 && y >= 30 && y < 50
        return red ? [255, 0, 0, 255] : [255, 255, 255, 255]
      })
      const built = sb3Costume('res1pad', res1Png, 'png', { bitmapResolution: 1, rotationCenterX: 48, rotationCenterY: 48 })
      const project = {
        targets: [
          { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'backdrop1', assetId: built.entry.assetId, md5ext: built.entry.md5ext, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
          { isStage: false, name: 'Res1Sprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: built.entry.name, assetId: built.entry.assetId, md5ext: built.entry.md5ext, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 48, rotationCenterY: 48 }], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
        ],
        monitors: [],
        extensions: [],
        meta: { semver: '3.0.0', vm: 'conversion-verify', agent: 'conversion-verify' },
      }
      // Stage needs a real SVG asset; reuse the default empty backdrop bytes.
      const emptyBackdrop = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>')
      const emptyHash = md5(emptyBackdrop)
      project.targets[0]!.costumes[0] = { name: 'backdrop1', assetId: emptyHash, md5ext: `${emptyHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }
      const sb3 = buildSb3(project, { [built.file]: built.bytes, [`${emptyHash}.svg`]: emptyBackdrop })
      await importSb3(page, sb3, 'res1pad')
      await page.getByTestId('target-card-Res1Sprite').click()
      await page.waitForTimeout(800)
      const metaRes1B = await selectedCostumeMeta(page)
      expect(metaRes1B.bitmapResolution).toBe(1)
      await reselectCurrentCostume(page)
      await waitCanvasInk(page)
      const stageRes1B = await waitStageSettled(page)
      const redRes1B = centroid(stageRes1B.data, stageRes1B.width, stageRes1B.height, isRed)
      expect(redRes1B.count).toBeGreaterThan(10)
      logReport('res1 canvas before vectorize', await canvasDiag(page))
      await convertToVector(page)
      const metaRes1V = await selectedCostumeMeta(page)
      expect(metaRes1V.bitmapResolution).toBe(1)
      const savedRes1V = await exportSb3(page)
      const costumeRes1V = findCostume(savedRes1V.project, metaRes1V.targetName, metaRes1V.index).costume
      const sizeRes1V = svgSize(Buffer.from(savedRes1V.assets[costumeRes1V.md5ext!]!).toString('utf8'))
      logReport('padded res1 vector', { meta: metaRes1V, size: sizeRes1V })
      expect(sizeRes1V.width).toBeCloseTo(48, 0)
      expect(sizeRes1V.height).toBeCloseTo(48, 0)
      const stageRes1V = await waitStageSettled(page)
      const redRes1V = centroid(stageRes1V.data, stageRes1V.width, stageRes1V.height, isRed)
      expect(Math.abs(redRes1V.cx - redRes1B.cx)).toBeLessThanOrEqual(5)
      expect(Math.abs(redRes1V.cy - redRes1B.cy)).toBeLessThanOrEqual(5)
      expect(diffRatio(stageRes1B.data, stageRes1V.data).ratio).toBeLessThan(0.03)
    } finally {
      await context.close()
    }
  }, 240_000)

  it('legacy 2400x1800 bitmap converts compatibly and restores exactly with Undo/Redo bytes', async () => {
    // Full-bleed legacy asset (canvas == asset, fully opaque 2400x1800):
    // upload stores the PNG verbatim and the canvas shows it 1:1. The red
    // marker sits inside the stage-visible region: with center (48,50) at
    // resolution 2 the visible scratch window maps to bitmap x 0..528 /
    // y 0..410, so bitmap (100..300, 100..300) => scratch (26..126, -25..-125).
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      const legacyPng = buildPng(2400, 1800, (x, y) => {
        const red = x >= 100 && x < 300 && y >= 100 && y < 300
        return red ? [255, 0, 0, 255] : [240, 240, 240, 255]
      })
      await uploadCostumeFile(page, 'conv-legacy.png', 'image/png', Buffer.from(legacyPng))
      await setRotationCenter(page, 48, 50)
      await reselectCurrentCostume(page)
      await waitCanvasInk(page)
      const metaLegacy = await selectedCostumeMeta(page)
      expect(metaLegacy.dataFormat).toBe('png')
      expect(metaLegacy.bitmapResolution).toBe(2)
      expect(metaLegacy.rotationCenterX).toBe(48)
      expect(metaLegacy.rotationCenterY).toBe(50)
      const savedLegacy = await exportSb3(page)
      const legacyCostume = findCostume(savedLegacy.project, metaLegacy.targetName, metaLegacy.index).costume
      const legacyBytes = savedLegacy.assets[legacyCostume.md5ext!]!
      expect(pngDimensions(legacyBytes)).toEqual({ width: 2400, height: 1800 })
      const legacyRgba = decodePng(Buffer.from(legacyBytes))
      expect(countWhere(legacyRgba.data, isRed)).toBeGreaterThan(100)
      const stageLegacy = await waitStageSettled(page)
      const redLegacy = centroid(stageLegacy.data, stageLegacy.width, stageLegacy.height, isRed)
      expect(redLegacy.count).toBeGreaterThan(20)
      logReport('legacy before', { meta: metaLegacy, red: redLegacy })

      // bitmap -> vector stays compatibly oversized (1200x900, center 24,25).
      logReport('legacy canvas before vectorize', await canvasDiag(page))
      await convertToVector(page)
      const metaLegacyV = await selectedCostumeMeta(page)
      expect(metaLegacyV.dataFormat).toBe('svg')
      expect(metaLegacyV.rotationCenterX).toBeCloseTo(24, 9)
      expect(metaLegacyV.rotationCenterY).toBeCloseTo(25, 9)
      const savedLegacyV = await exportSb3(page)
      const costumeLegacyV = findCostume(savedLegacyV.project, metaLegacyV.targetName, metaLegacyV.index).costume
      const textLegacyV = Buffer.from(savedLegacyV.assets[costumeLegacyV.md5ext!]!).toString('utf8')
      const sizeLegacyV = svgSize(textLegacyV)
      logReport('legacy vector', { meta: metaLegacyV, size: sizeLegacyV })
      expect(sizeLegacyV).toEqual({ width: 1200, height: 900 })
      expect(costumeLegacyV.rotationCenterX).toBeCloseTo(24, 9)
      expect(costumeLegacyV.rotationCenterY).toBeCloseTo(25, 9)
      expect(textLegacyV.includes('<image')).toBe(true)
      const stageLegacyV = await waitStageSettled(page)
      const redLegacyV = centroid(stageLegacyV.data, stageLegacyV.width, stageLegacyV.height, isRed)
      const diffLegacyBv = diffRatio(stageLegacy.data, stageLegacyV.data)
      logReport('legacy vector stage', { red: redLegacyV, diff: diffLegacyBv })
      expect(redLegacyV.count).toBeGreaterThan(20)
      expect(Math.abs(redLegacyV.cx - redLegacy.cx)).toBeLessThanOrEqual(6)
      expect(Math.abs(redLegacyV.cy - redLegacy.cy)).toBeLessThanOrEqual(6)
      expect(diffLegacyBv.ratio).toBeLessThan(0.03)

      // vector -> bitmap restores the exact 2400x1800 asset geometry.
      await convertToBitmap(page)
      const metaLegacyB2 = await selectedCostumeMeta(page)
      expect(metaLegacyB2.dataFormat).toBe('png')
      expect(metaLegacyB2.bitmapResolution).toBe(2)
      expect(metaLegacyB2.rotationCenterX).toBeCloseTo(48, 9)
      expect(metaLegacyB2.rotationCenterY).toBeCloseTo(50, 9)
      const savedLegacyB2 = await exportSb3(page)
      const costumeLegacyB2 = findCostume(savedLegacyB2.project, metaLegacyB2.targetName, metaLegacyB2.index).costume
      const bytesLegacyB2 = savedLegacyB2.assets[costumeLegacyB2.md5ext!]!
      expect(pngDimensions(bytesLegacyB2)).toEqual({ width: 2400, height: 1800 })
      const stageLegacyB2 = await waitStageSettled(page)
      const diffLegacyVb = diffRatio(stageLegacyV.data, stageLegacyB2.data)
      logReport('legacy bitmap2 stage', { meta: metaLegacyB2, diff: diffLegacyVb })
      expect(diffLegacyVb.ratio).toBeLessThan(0.03)

      // Undo walks back bytes+meta through every step; Redo replays them.
      const { undo, redo } = await undoRedoButtons(page)
      await undo.click()
      await waitCostume(page, (meta) => meta.dataFormat === 'svg' && (meta.rotationCenterX ?? 0) === 24)
      expect((await selectedCostumeMeta(page)).md5ext).toBe(metaLegacyV.md5ext)
      const savedUndoV = await exportSb3(page)
      const undoVCostume = findCostume(savedUndoV.project, metaLegacyV.targetName, metaLegacyV.index).costume
      expect(Buffer.from(savedUndoV.assets[undoVCostume.md5ext!]!).equals(Buffer.from(savedLegacyV.assets[costumeLegacyV.md5ext!]!))).toBe(true)
      await undo.click()
      await waitMd5(page, metaLegacy.md5ext!)
      const savedUndoB = await exportSb3(page)
      const undoBCostume = findCostume(savedUndoB.project, metaLegacy.targetName, metaLegacy.index).costume
      expect(undoBCostume.md5ext).toBe(legacyCostume.md5ext)
      expect(Buffer.from(savedUndoB.assets[undoBCostume.md5ext!]!).equals(Buffer.from(legacyBytes))).toBe(true)
      await redo.click()
      await waitMd5(page, metaLegacyV.md5ext!)
      await redo.click()
      await waitMd5(page, metaLegacyB2.md5ext!)
      const savedRedoB = await exportSb3(page)
      const redoBCostume = findCostume(savedRedoB.project, metaLegacyB2.targetName, metaLegacyB2.index).costume
      expect(Buffer.from(savedRedoB.assets[redoBCostume.md5ext!]!).equals(Buffer.from(bytesLegacyB2))).toBe(true)
    } finally {
      await context.close()
    }
  }, 240_000)
})
