import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { inflateSync as inflateRaw, strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// New verification only (product code untouched) for two suspected
// bitmap-artboard regressions:
//
//  Suspect 1 (res): `placeSourceOnArtboard` fixes the workspace resolution by
//    `isStage` only (sprite=2/stage=1) and `croppedSaveForTrim` fixes the saved
//    resolution the same way. A sprite PNG stored at res1 (e.g. 100x80,
//    non-central center, semitransparent pixel) would then be drawn 1:1 on a
//    res2 artboard (halving its scratch size) and re-saved as res2 (halving
//    again / halving the VM bounds). Correct behavior preserves the stored
//    resolution and the VM scratch bounds across load -> 1px paint -> save ->
//    reload, with the red ink / res / center stable and the stage screenshot
//    stable (plus the one dot).
//
//  Suspect 2 (memory fallback): over-limit workspaces fall back to
//    `width=min(sw,4096) / height=min(sh,4096)` with origin 0,0, so a
//    5000px-wide source loses everything past 4096. Correct behavior never
//    loses stored ink to the cap (verbatim fallback must keep the full source
//    rect, or the union must be kept when the area budget allows it).
//    This suite puts distinct colours at head / past-4096 / tail of a
//    5000x12 PNG and checks the real asset bytes + decoded pixels across
//    load -> save -> Undo -> Redo, plus the VM scratch bounds and the stage
//    screenshot.
//
// If the product is broken these tests FAIL loudly with reproduction logs;
// nothing is hidden behind a widened threshold.
//
// Dedicated Vite port 4496 (surveyed: 4496 is free; 4483/4490/4473/4527/
// 4531/4533/4251/4291/4387/4389 and the 41xx-44xx block used by the other
// browser suites are taken). Real Editor UI + real VM only.
const root = join(import.meta.dir, '..')
const PORT = 4496
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

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('Not a PNG')
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function decodePng(png: Buffer | Uint8Array): { width: number; height: number; data: Buffer } {
  const bytes = Buffer.from(png)
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

function countWhere(data: Buffer, pred: (r: number, g: number, b: number, a: number) => boolean): number {
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (pred(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0)) n += 1
  }
  return n
}

const isRed = (r: number, g: number, b: number, a: number) => a > 128 && r > 200 && g < 100 && b < 100
const isGreen = (r: number, g: number, b: number, a: number) => a > 128 && g > 150 && r < 120 && b < 120
const isBlue = (r: number, g: number, b: number, a: number) => a > 128 && b > 150 && r < 120 && g < 150
const isSemi = (_r: number, _g: number, _b: number, a: number) => a > 10 && a < 200

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
    if (d > max) max = d
    if (d > 48) differing += 1
  }
  return { ratio: differing / total, max }
}

/** VM scratch bounds for a bitmap costume (same equations as packages/vm targetCostumeBox). */
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
  console.log(`[res1-huge-verify] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'res1-huge-verify.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
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

async function targetVmState(page: Page) {
  return await page.evaluate(() => {
    const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ id?: string; name: string; isStage: boolean; currentCostume?: number; x?: number; y?: number; size?: number; direction?: number; costumes: Array<{ name: string; dataFormat?: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> }> }; selectedTargetId: string } } }).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t) => !t.isStage) ?? snap.project.targets[0]!
    const index = target.currentCostume ?? 0
    const costume = target.costumes[index]!
    const res = Math.max(1, Number(costume.bitmapResolution) || 1)
    const cx = Number.isFinite(costume.rotationCenterX) ? (costume.rotationCenterX as number) : 48
    const cy = Number.isFinite(costume.rotationCenterY) ? (costume.rotationCenterY as number) : 48
    // Width/height are authoritative from decoded bytes only inside the VM;
    // the snapshot meta here carries res/center, dims come from the exported
    // asset. Return the meta side; the test joins it with pngDimensions().
    return { targetName: target.name, isStage: target.isStage, x: target.x ?? 0, y: target.y ?? 0, size: target.size ?? 100, index, costumeName: costume.name, dataFormat: costume.dataFormat ?? '', bitmapResolution: res, rotationCenterX: cx, rotationCenterY: cy, md5ext: costume.md5ext }
  })
}

async function canvasDiag(page: Page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) return { found: false as const }
    const context = canvas.getContext('2d')
    if (!context) return { found: true as const, readable: false as const }
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    let opaque = 0
    let semi = 0
    let left = canvas.width
    let top = canvas.height
    let right = -1
    let bottom = -1
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const a = image.data[(y * canvas.width + x) * 4 + 3] ?? 0
        if (a === 0) continue
        opaque += 1
        if (a > 10 && a < 200) semi += 1
        if (x < left) left = x
        if (y < top) top = y
        if (x > right) right = x
        if (y > bottom) bottom = y
      }
    }
    return { found: true as const, readable: true as const, width: canvas.width, height: canvas.height, opaque, semi, trim: right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null }
  })
}

async function waitCanvasInk(page: Page, timeout = 30_000) {
  const start = Date.now()
  let last = ''
  for (;;) {
    const d = await canvasDiag(page)
    last = JSON.stringify(d)
    if ((d as { readable?: boolean }).readable && ((d as { opaque?: number }).opaque ?? 0) > 0) return d
    if (Date.now() - start > timeout) throw new Error(`canvas never showed ink (last=${last})`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function waitCanvasDiag(page: Page, timeout = 15_000) {
  const start = Date.now()
  for (;;) {
    const d = await canvasDiag(page)
    if ((d as { readable?: boolean }).readable) return d
    if (Date.now() - start > timeout) throw new Error(`canvas never readable: ${JSON.stringify(d)}`)
    await new Promise((r) => setTimeout(r, 300))
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

async function waitMd5Changed(page: Page, banned: string, timeout = 30_000) {
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
}

// --- fixtures ---------------------------------------------------------------

// Sprite res1 100x80: white opaque base, opaque red block, one semitransparent
// blue pixel. Non-central center (20,60) is inside but far from (50,40).
function buildRes1Png(): Uint8Array {
  return buildPng(100, 80, (x, y) => {
    if (x === 5 && y === 5) return [0, 0, 255, 120]
    const red = x >= 10 && x < 30 && y >= 10 && y < 30
    if (red) return [255, 0, 0, 255]
    return [255, 255, 255, 255]
  })
}

// 5000x12 sprite: white base with head red / past-4096 green / tail blue.
// Widths are deliberately wide so a 4096 clamp is visible in bytes.
function buildHugePng(): Uint8Array {
  return buildPng(5000, 12, (x, y) => {
    void y
    if (x >= 0 && x < 20) return [255, 0, 0, 255]
    if (x >= 4100 && x < 4120) return [0, 255, 0, 255]
    if (x >= 4980 && x < 5000) return [0, 0, 255, 255]
    return [255, 255, 255, 255]
  })
}

function emptyBackdropSvg(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>')
}

describe('bitmap-artboard res1 + huge memory-cap verification (real Editor/VM)', () => {
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

  it('sprite PNG res1 100x80 (semitransparent + non-central center): 1px paint -> save -> reload keeps res/bounds/stage', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      const res1Png = buildRes1Png()
      expect(pngDimensions(res1Png)).toEqual({ width: 100, height: 80 })
      const file = `${md5(res1Png)}.png`
      const emptySvg = emptyBackdropSvg()
      const emptyHash = md5(emptySvg)
      const project = {
        targets: [
          { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'backdrop1', assetId: emptyHash, md5ext: `${emptyHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
          { isStage: false, name: 'Res1Sprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'res1pic', assetId: md5(res1Png), md5ext: file, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 20, rotationCenterY: 60 }], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
        ],
        monitors: [],
        extensions: [],
        meta: { semver: '3.0.0', vm: 'res1-huge-verify', agent: 'res1-huge-verify' },
      }
      const sb3 = buildSb3(project, { [file]: res1Png, [`${emptyHash}.svg`]: emptySvg })
      await openCostumes(page)
      await importSb3(page, Buffer.from(sb3), 'res1pic')
      await page.getByTestId('target-card-Res1Sprite').click()
      await page.waitForTimeout(800)
      const meta0 = await selectedCostumeMeta(page)
      log('res1 imported meta', meta0)
      expect(meta0.dataFormat).toBe('png')
      expect(meta0.bitmapResolution).toBe(1)
      expect(meta0.rotationCenterX).toBe(20)
      expect(meta0.rotationCenterY).toBe(60)
      await page.getByRole('button', { name: 'Select res1pic' }).first().click()
      await page.waitForTimeout(600)
      const diag0 = await waitCanvasInk(page)
      const vm0 = await targetVmState(page)
      const stage0 = await waitStageSettled(page)
      const redStage0 = centroid(stage0.data, stage0.width, stage0.height, isRed)
      log('res1 before paint', { canvas: diag0, vm: vm0, redStage: redStage0, shot: { w: stage0.width, h: stage0.height } })
      // VM scratch bounds before any edit: 100x80 units at res1.
      const bounds0 = scratchBoundsOf(100, 80, 20, 60, 1)
      expect(bounds0).toEqual({ left: -20, right: 80, top: 60, bottom: -20, width: 100, height: 80 })
      expect(redStage0.count).toBeGreaterThan(20)
      // Stored bytes themselves carry the red block + the semitransparent pixel.
      const saved0 = await exportSb3(page)
      const costume0 = saved0.project.targets.find((t) => t.name === 'Res1Sprite')!.costumes[0]!
      const bytes0 = saved0.assets[costume0.md5ext!]!
      expect(pngDimensions(bytes0)).toEqual({ width: 100, height: 80 })
      const rgba0 = decodePng(Buffer.from(bytes0))
      const redBytes0 = countWhere(rgba0.data, isRed)
      const semiBytes0 = countWhere(rgba0.data, isSemi)
      log('res1 stored bytes before paint', { dims: pngDimensions(bytes0), red: redBytes0, semi: semiBytes0, meta: { res: costume0.bitmapResolution, cx: costume0.rotationCenterX, cy: costume0.rotationCenterY } })
      expect(redBytes0).toBe(20 * 20)
      expect(semiBytes0).toBeGreaterThanOrEqual(1)

      // 1-pixel-class edit: a single brush dot at the canvas center through
      // the REAL brush tool, then the REAL Save button.
      const diagLive = diag0 as { width: number; height: number }
      const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
      if (!box) throw new Error('Missing bitmap canvas box')
      await page.getByTestId('bitmap-tool-brush').click()
      const toScreen = (cx: number, cy: number) => ({ x: box.x + (cx / diagLive.width) * box.width, y: box.y + (cy / diagLive.height) * box.height })
      // Aim at the canvas center (Scratch 0,0): inside the white base so the
      // dot changes colour, not alpha, and stays inside every trim.
      const dot = toScreen(diagLive.width / 2, diagLive.height / 2)
      await page.mouse.move(dot.x, dot.y)
      await page.mouse.down()
      await page.mouse.move(dot.x + 2, dot.y + 1, { steps: 2 })
      await page.mouse.up()
      await waitMd5Changed(page, meta0.md5ext!)
      const metaEdited = await selectedCostumeMeta(page)
      const diagEdited = await waitCanvasDiag(page)
      log('res1 after 1px dot (autosave)', { meta: metaEdited, canvas: diagEdited })
      await page.getByTestId('save-bitmap-costume').click()
      await page.waitForTimeout(900)
      const metaSaved = await selectedCostumeMeta(page)
      log('res1 after explicit Save (must be idempotent)', { meta: metaSaved })
      expect(metaSaved.md5ext).toBe(metaEdited.md5ext)

      // Collect the full post-save evidence BEFORE asserting, so a res
      // regression still leaves the stage/bounds symptoms in the log.
      const saved = await exportSb3(page)
      const costumeSaved = saved.project.targets.find((t) => t.name === metaSaved.targetName)!.costumes[metaSaved.index]!
      const bytesSaved = saved.assets[costumeSaved.md5ext!]!
      const dimsSaved = pngDimensions(bytesSaved)
      const rgbaSaved = decodePng(Buffer.from(bytesSaved))
      const redSaved = countWhere(rgbaSaved.data, isRed)
      const semiSaved = countWhere(rgbaSaved.data, isSemi)
      const boundsSaved = scratchBoundsOf(dimsSaved.width, dimsSaved.height, costumeSaved.rotationCenterX!, costumeSaved.rotationCenterY!, costumeSaved.bitmapResolution!)
      const vmSaved = await targetVmState(page)
      const stageSaved = await waitStageSettled(page)
      const redStageSaved = centroid(stageSaved.data, stageSaved.width, stageSaved.height, isRed)
      const stageDiff = diffRatio(stage0.data, stageSaved.data)
      log('res1 saved', { meta: costumeSaved, dims: dimsSaved, redBytes: redSaved, semiBytes: semiSaved, bounds: boundsSaved, vm: vmSaved, redStage: redStageSaved, stageDiff })

      // Reload (SB3 export -> re-import): bytes/meta/stage must round-trip.
      // Collected BEFORE asserting so the reload symptoms stay in the log
      // even when the save assertions below already fail.
      const reloadBytes = buildSb3(saved.project, Object.fromEntries(Object.entries(saved.assets).map(([k, v]) => [k, new Uint8Array(v)])))
      await importSb3(page, Buffer.from(reloadBytes), costumeSaved.name)
      await page.getByTestId(`target-card-${metaSaved.targetName}`).click()
      await page.waitForTimeout(800)
      await page.getByRole('button', { name: `Select ${costumeSaved.name}` }).first().click()
      await page.waitForTimeout(600)
      const diagReload = await waitCanvasInk(page)
      const metaReload = await selectedCostumeMeta(page)
      const vmReload = await targetVmState(page)
      const stageReload = await waitStageSettled(page)
      const redStageReload = centroid(stageReload.data, stageReload.width, stageReload.height, isRed)
      const savedReload = await exportSb3(page)
      const costumeReload = savedReload.project.targets.find((t) => t.name === metaReload.targetName)!.costumes[metaReload.index]!
      const bytesReload = savedReload.assets[costumeReload.md5ext!]!
      const rgbaReload = decodePng(Buffer.from(bytesReload))
      log('res1 reload', { meta: metaReload, canvas: diagReload, vm: vmReload, redStage: redStageReload, dims: pngDimensions(bytesReload), redBytes: countWhere(rgbaReload.data, isRed), semiBytes: countWhere(rgbaReload.data, isSemi) })
      // Correct save preserves res1 + the VM bounds; the buggy fixed-res2
      // save halves them (100x80@1 -> 100x80@2). Assert the CORRECT values.
      expect(metaSaved.bitmapResolution).toBe(1)
      // The dot adds ink but must not halve the costume: dims stay 100x80
      // family (dot inside the white base keeps the full-canvas trim), red
      // block intact, semitransparent pixel intact, res still 1.
      expect(dimsSaved).toEqual({ width: 100, height: 80 })
      expect(costumeSaved.bitmapResolution).toBe(1)
      expect(costumeSaved.rotationCenterX).toBe(20)
      expect(costumeSaved.rotationCenterY).toBe(60)
      expect(redSaved).toBe(redBytes0)
      expect(semiSaved).toBeGreaterThanOrEqual(1)
      expect(boundsSaved).toEqual(bounds0)
      // Stage: the red block stays the same size/place (plus the tiny dot).
      // A res1->res2 halving would quarter the red area, so keep this tight.
      expect(Math.abs(redStageSaved.cx - redStage0.cx)).toBeLessThanOrEqual(5)
      expect(Math.abs(redStageSaved.cy - redStage0.cy)).toBeLessThanOrEqual(5)
      expect(redStageSaved.count).toBeGreaterThan(redStage0.count * 0.7)
      expect(redStageSaved.count).toBeLessThan(redStage0.count * 1.5)
      expect(stageDiff.ratio).toBeLessThan(0.02)

      expect(metaReload.bitmapResolution).toBe(1)
      expect(metaReload.rotationCenterX).toBe(20)
      expect(metaReload.rotationCenterY).toBe(60)
      expect(pngDimensions(bytesReload)).toEqual({ width: 100, height: 80 })
      expect(Buffer.from(bytesReload).equals(Buffer.from(bytesSaved))).toBe(true)
      expect(Math.abs(redStageReload.cx - redStageSaved.cx)).toBeLessThanOrEqual(5)
      expect(Math.abs(redStageReload.cy - redStageSaved.cy)).toBeLessThanOrEqual(5)
      expect(diffRatio(stageSaved.data, stageReload.data).ratio).toBeLessThan(0.02)
    } finally {
      await context.close()
    }
  }, 180_000)

  it('5000x12 sprite (head/mid/tail colours): load -> save -> Undo/Redo keeps every stored pixel', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      const hugePng = buildHugePng()
      expect(pngDimensions(hugePng)).toEqual({ width: 5000, height: 12 })
      const file = `${md5(hugePng)}.png`
      const emptySvg = emptyBackdropSvg()
      const emptyHash = md5(emptySvg)
      const project = {
        targets: [
          { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'backdrop1', assetId: emptyHash, md5ext: `${emptyHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
          { isStage: false, name: 'HugeSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'hugepic', assetId: md5(hugePng), md5ext: file, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 2500, rotationCenterY: 6 }], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
        ],
        monitors: [],
        extensions: [],
        meta: { semver: '3.0.0', vm: 'res1-huge-verify', agent: 'res1-huge-verify' },
      }
      const sb3 = buildSb3(project, { [file]: hugePng, [`${emptyHash}.svg`]: emptySvg })
      await openCostumes(page)
      await importSb3(page, Buffer.from(sb3), 'hugepic')
      await page.getByTestId('target-card-HugeSprite').click()
      await page.waitForTimeout(800)
      const meta0 = await selectedCostumeMeta(page)
      log('huge imported meta', meta0)
      expect(meta0.bitmapResolution).toBe(2)
      await page.getByRole('button', { name: 'Select hugepic' }).first().click()
      await page.waitForTimeout(600)
      const diag0 = await waitCanvasInk(page)
      const vm0 = await targetVmState(page)
      log('huge live canvas after load', { canvas: diag0, vm: vm0 })
      const liveRgba0 = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return { found: false as const }
        const ctx = canvas.getContext('2d')
        if (!ctx) return { found: true as const, readable: false as const }
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const at = (x: number, y: number) => {
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null
          const o = (y * canvas.width + x) * 4
          return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]
        }
        return { found: true as const, readable: true as const, width: canvas.width, height: canvas.height, samples: { head: at(5, 6), mid: at(4105, 6), tail: at(4990, 6) } }
      })
      log('huge live pixels after load', liveRgba0)
      const stage0 = await waitStageSettled(page)
      const red0 = countWhere(stage0.data, isRed)
      const green0 = countWhere(stage0.data, isGreen)
      const blue0 = countWhere(stage0.data, isBlue)
      const vmBounds0 = scratchBoundsOf(5000, 12, 2500, 6, 2)
      log('huge stage after load', { red: red0, green: green0, blue: blue0, vmBounds: vmBounds0, shot: { w: stage0.width, h: stage0.height } })

      // Save with no paint edit: the transparent-edge crop of a white-opaque
      // 5000x12 source is the full 5000x12. The buggy 4096 clamp shrinks it.
      const md50 = meta0.md5ext!
      await page.getByTestId('save-bitmap-costume').click()
      await page.waitForTimeout(1200)
      const metaSaved = await selectedCostumeMeta(page)
      const saved = await exportSb3(page)
      const costumeSaved = saved.project.targets.find((t) => t.name === metaSaved.targetName)!.costumes[metaSaved.index]!
      const bytesSaved = saved.assets[costumeSaved.md5ext!]!
      const dimsSaved = pngDimensions(bytesSaved)
      const rgbaSaved = decodePng(Buffer.from(bytesSaved))
      const redSaved = countWhere(rgbaSaved.data, isRed)
      const greenSaved = countWhere(rgbaSaved.data, isGreen)
      const blueSaved = countWhere(rgbaSaved.data, isBlue)
      const diagSaved = await waitCanvasDiag(page)
      const stageSaved = await waitStageSettled(page)
      log('huge after Save', { meta: costumeSaved, dims: dimsSaved, red: redSaved, green: greenSaved, blue: blueSaved, canvas: diagSaved, stage: { red: countWhere(stageSaved.data, isRed), green: countWhere(stageSaved.data, isGreen), blue: countWhere(stageSaved.data, isBlue) } })

      // Undo/Redo on the REAL asset bytes: Undo restores the exact 5000px
      // import, Redo restores the exact saved bytes. Collected before any
      // assert so the whole chain stays in the log on failure.
      const undoBtn = page.getByRole('button', { name: 'Undo' }).last()
      const redoBtn = page.getByRole('button', { name: 'Redo' }).last()
      const savedChanged = metaSaved.md5ext !== md50
      let undoBytes: Uint8Array | undefined
      let undoDims: { width: number; height: number } | undefined
      let undoRed = -1
      let undoGreen = -1
      let undoBlue = -1
      let redoEqualSaved: boolean | undefined
      let redoDims: { width: number; height: number } | undefined
      if (savedChanged) {
        try {
          await undoBtn.click()
          // Undo restores the pre-save asset: pixel-wise it must be the full
          // 5000x12 again. Do not require byte-identical PNG encoding here
          // (Chrome canvas re-encode vs fflate import differ); the ink
          // (dims + head/mid/tail colours) is the invariant under test.
          await waitMd5Changed(page, metaSaved.md5ext!)
          const metaUndo = await selectedCostumeMeta(page)
          const savedUndo = await exportSb3(page)
          const costumeUndo = savedUndo.project.targets.find((t) => t.name === metaUndo.targetName)!.costumes[metaUndo.index]!
          const bytesUndo = savedUndo.assets[costumeUndo.md5ext!]!
          const rgbaUndo = decodePng(Buffer.from(bytesUndo))
          undoBytes = bytesUndo
          undoDims = pngDimensions(bytesUndo)
          undoRed = countWhere(rgbaUndo.data, isRed)
          undoGreen = countWhere(rgbaUndo.data, isGreen)
          undoBlue = countWhere(rgbaUndo.data, isBlue)
          log('huge Undo', { meta: costumeUndo, dims: undoDims, red: undoRed, green: undoGreen, blue: undoBlue })
        } catch (error) {
          const status = await page.evaluate(() => {
            try {
              return (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status()
            } catch {
              return 'no-status'
            }
          })
          const metaNow = await selectedCostumeMeta(page)
          let undoFailDims: unknown = null
          let undoFailCounts: unknown = null
          try {
            const failSaved = await exportSb3(page)
            const failCostume = failSaved.project.targets.find((t) => t.name === metaNow.targetName)!.costumes[metaNow.index]!
            const failBytes = failSaved.assets[failCostume.md5ext!]!
            const failRgba = decodePng(Buffer.from(failBytes))
            undoFailDims = pngDimensions(failBytes)
            undoFailCounts = { red: countWhere(failRgba.data, isRed), green: countWhere(failRgba.data, isGreen), blue: countWhere(failRgba.data, isBlue), meta: failCostume }
          } catch {}
          log('huge Undo FAILED (no md5 restore)', { error: String(error).split('\n')[0], status, metaNow, wantMd5: md50, undoFailDims, undoFailCounts })
        }
        // Redo only when Undo actually restored; otherwise log and continue to
        // reload so the truncation chain stays fully visible.
        if (undoBytes) {
          try {
            await redoBtn.click()
            await waitMd5(page, metaSaved.md5ext!)
            const metaRedo = await selectedCostumeMeta(page)
            const savedRedo = await exportSb3(page)
            const costumeRedo = savedRedo.project.targets.find((t) => t.name === metaRedo.targetName)!.costumes[metaRedo.index]!
            const bytesRedo = savedRedo.assets[costumeRedo.md5ext!]!
            redoDims = pngDimensions(bytesRedo)
            redoEqualSaved = Buffer.from(bytesRedo).equals(Buffer.from(bytesSaved))
            log('huge Redo', { meta: costumeRedo, dims: redoDims, equalSaved: redoEqualSaved })
          } catch (error) {
            log('huge Redo FAILED', { error: String(error).split('\n')[0] })
          }
        } else {
          log('huge Redo skipped (Undo did not restore)', {})
        }
      } else {
        log('huge save was idempotent (no history entry)', { meta: metaSaved })
      }

      // Reload round-trip keeps the full width as well.
      const reloadBytes = buildSb3(saved.project, Object.fromEntries(Object.entries(saved.assets).map(([k, v]) => [k, new Uint8Array(v)])))
      await importSb3(page, Buffer.from(reloadBytes), costumeSaved.name)
      await page.getByTestId(`target-card-${metaSaved.targetName}`).click()
      await page.waitForTimeout(800)
      await page.getByRole('button', { name: `Select ${costumeSaved.name}` }).first().click()
      await page.waitForTimeout(600)
      const diagReload = await waitCanvasInk(page)
      const metaReload = await selectedCostumeMeta(page)
      const savedReload = await exportSb3(page)
      const costumeReload = savedReload.project.targets.find((t) => t.name === metaReload.targetName)!.costumes[metaReload.index]!
      const bytesReload = savedReload.assets[costumeReload.md5ext!]!
      const rgbaReload = decodePng(Buffer.from(bytesReload))
      const stageReload = await waitStageSettled(page)
      log('huge reload', { meta: metaReload, canvas: diagReload, dims: pngDimensions(bytesReload), red: countWhere(rgbaReload.data, isRed), green: countWhere(rgbaReload.data, isGreen), blue: countWhere(rgbaReload.data, isBlue), stage: { red: countWhere(stageReload.data, isRed), green: countWhere(stageReload.data, isGreen), blue: countWhere(stageReload.data, isBlue) } })
      // No ink may be lost to the memory cap at any step: head + past-4096
      // + tail stay in live pixels, saved bytes, Undo/Redo bytes, reload.
      // Asserted here (after every log) so one failure still leaves the full
      // chain in the output.
      expect((diag0 as { width: number }).width).toBeGreaterThanOrEqual(5000)
      expect(dimsSaved).toEqual({ width: 5000, height: 12 })
      expect(redSaved).toBeGreaterThan(0)
      expect(greenSaved).toBeGreaterThan(0)
      expect(blueSaved).toBeGreaterThan(0)
      expect(costumeSaved.bitmapResolution).toBe(2)
      expect(scratchBoundsOf(dimsSaved.width, dimsSaved.height, costumeSaved.rotationCenterX!, costumeSaved.rotationCenterY!, costumeSaved.bitmapResolution!)).toEqual(vmBounds0)
      if (savedChanged) {
        expect(undoDims).toEqual({ width: 5000, height: 12 })
        expect(undoGreen).toBeGreaterThan(0)
        expect(undoBlue).toBeGreaterThan(0)
        expect(redoEqualSaved).toBe(true)
        expect(redoDims).toEqual(dimsSaved)
      } else {
        expect(Buffer.from(bytesSaved).equals(Buffer.from(hugePng))).toBe(true)
      }
      expect(pngDimensions(bytesReload)).toEqual({ width: 5000, height: 12 })
      expect(countWhere(rgbaReload.data, isGreen)).toBeGreaterThan(0)
      expect(countWhere(rgbaReload.data, isBlue)).toBeGreaterThan(0)
      expect((diagReload as { width: number }).width).toBeGreaterThanOrEqual(5000)
    } finally {
      await context.close()
    }
  }, 180_000)
})
