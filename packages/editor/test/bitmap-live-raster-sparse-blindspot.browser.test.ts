// Sparse-scan blind-spot + monkey-patched raster-loss repro (NEW verification,
// full-coverage product guard).
//
// New implementation (`verifyBitmapPlacedPixels` + `verifyBitmapLiveRaster` in
// `Editor.svelte`): every placed pixel is compared chunk-by-chunk against an
// independent source readback, so a FULL-BLANK or PARTIAL (gap-pixel) raster
// dropout refuses with 'Image too large to edit safely — original kept
// unchanged' and the stored 64x48 bytes stay byte-identical. These repros
// ASSERT that refusal (strict: failures are never hidden): load status must be
// the refusal, and before/after asset bytes + rotationCenter + bitmapResolution
// + canary + Undo/Redo must match exactly, with Save/Convert leaving the asset
// unchanged. The original pixels are additionally proven lossless by decoding
// the ORIGINAL built PNG at the gap point (ground truth) and the saved bytes
// at the same point.
//
// Fault injection itself is kept (this suite only): FULL-BLANK drops every
// draw onto `bitmap-editor-canvas`; PARTIAL keeps every placed pixel EXCEPT
// the gap pixel (clearRect dx+50,dy+24 after the real draw).
//
// GPU/environment uncertainty is RECORDED, never used to soften asserts: the
// native 65535x2-vs-100000x2 boundary probe logs userAgent + WebGL renderer +
// raster/toBlob evidence, and the FULL/PARTIAL canvas diags + statuses are
// logged before asserting. A GPU that rasterizes differently still fails loudly
// here instead of passing silently.
//
// Dedicated Vite port 4573 (surveyed 2026-11-12: 4561 extreme-side-cap,
// 4567/4569 nearby suites, 4540 transparency-forensics; 4573 is free).
// CHROME_BIN is inherited. No product files are touched; no git destructive
// commands are used.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4573
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
const REFUSAL_STATUS = 'Image too large to edit safely — original kept unchanged'

const SW = 64
const SH = 48
const GAP_X = 50
const GAP_Y = 24

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

function buildPng(width: number, height: number, pixel: (x: number, y: number) => RGBA): Uint8Array {
  if (width * height > 250_000) throw new Error(`fixture ${width}x${height} over cap`)
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

/** Transparent 64x48 with ONE opaque red pixel at the scan gap (50,24). */
function buildSparseSingle(): Uint8Array {
  return buildPng(SW, SH, (x, y) => (x === GAP_X && y === GAP_Y ? [255, 0, 0, 255] : [0, 0, 0, 0]))
}

/** Red 8x8 head block (sampled) + ONE blue gap pixel (50,24, unsampled). */
function buildSparseHeadGap(): Uint8Array {
  return buildPng(SW, SH, (x, y) => {
    if (x < 8 && y < 8) return [255, 0, 0, 255]
    if (x === GAP_X && y === GAP_Y) return [0, 0, 255, 255]
    return [0, 0, 0, 0]
  })
}

function buildCanaryPng(): Uint8Array {
  return buildPng(64, 48, (x, y) => (x >= 8 && x < 24 && y >= 8 && y < 24 ? [255, 0, 0, 255] : [255, 255, 255, 255]))
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Minimal PNG decoder for small saved-asset forensics (copied geometry from
 *  the extreme-side-cap suite; inputs here are <=64x48, never over any cap). */
function decodePng(png: Buffer | Uint8Array): { width: number; height: number; data: Buffer } {
  const bytes = Buffer.from(png)
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
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`Unsupported PNG (depth=${bitDepth}, color=${colorType})`)
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idatParts))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let rawOffset = 0
  let previous = Buffer.alloc(stride, 0)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset] ?? 0
    rawOffset += 1
    const current = Buffer.from(raw.subarray(rawOffset, rawOffset + stride))
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

function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function log(label: string, value: unknown) {
  console.log(`[sparse-blindspot] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'sparse-blindspot.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
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
    for (let i = 3; i < image.data.length; i += 4) {
      if ((image.data[i] ?? 0) !== 0) opaque += 1
    }
    return { found: true as const, readable: true as const, width: canvas.width, height: canvas.height, opaque }
  })
}

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

async function undoDisabled(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => (document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true)
  } catch {
    return true
  }
}

async function redoDisabled(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => (document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled ?? true)
  } catch {
    return true
  }
}

/** Environment/GPU record (logged, never used to soften asserts). */
async function gpuRecord(page: Page) {
  return await page.evaluate(() => {
    const out: Record<string, unknown> = {}
    try {
      out.userAgent = navigator.userAgent
    } catch {
      out.userAgent = 'unknown'
    }
    try {
      out.hardwareConcurrency = (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency ?? 'unknown'
    } catch {
      out.hardwareConcurrency = 'unknown'
    }
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      if (!gl) {
        out.webgl = 'unavailable'
      } else {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        out.webgl = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : 'available-no-debug-info'
      }
    } catch (e) {
      out.webgl = `error: ${String(e).slice(0, 160)}`
    }
    return out
  })
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

function spriteProject(spriteName: string, costumeName: string, png: Uint8Array, cx: number, cy: number, canaryPng: Uint8Array) {
  const extremeFile = `${md5(png)}.png`
  const canaryFile = `${md5(canaryPng)}.png`
  const emptySvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>')
  const emptyHash = md5(emptySvg)
  const project = {
    targets: [
      { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'backdrop1', assetId: emptyHash, md5ext: `${emptyHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
      { isStage: false, name: spriteName, variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: costumeName, assetId: md5(png), md5ext: extremeFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: cx, rotationCenterY: cy }], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
      { isStage: false, name: 'Canary', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'canary', assetId: md5(canaryPng), md5ext: canaryFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 32, rotationCenterY: 24 }], sounds: [], volume: 100, layerOrder: 2, visible: true, x: 150, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: 'sparse-blindspot', agent: 'sparse-blindspot' },
  }
  return { project, files: { [extremeFile]: png, [canaryFile]: canaryPng, [`${emptyHash}.svg`]: emptySvg } as Record<string, Uint8Array> }
}

describe('sparse live-raster blind spot (real Editor/VM)', () => {
  beforeAll(async () => {
    const probe = await fetch(base).then(() => true).catch(() => false)
    if (probe) throw new Error(`port ${PORT} is already in use; stop the holder first`)
    const serveMode = process.env.SPARSE_SERVE === 'preview' ? 'preview' : 'dev'
    const serveArgs =
      serveMode === 'preview'
        ? ['x', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
        : ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
    log('serve mode', { serveMode })
    server = spawn('bun', serveArgs, { cwd: root, stdio: 'pipe' })
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

  it('sparse 1px at non-sampled X is invisible to the 4-strip + 3-sample scan (full alpha proves ink)', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    try {
      await page.goto(base, { waitUntil: 'networkidle' })
      const png = buildSparseSingle()
      expect(pngDimensions(png)).toEqual({ width: SW, height: SH })
      const result = await page.evaluate(
        async ({ b64, gapX, gapY }) => {
          const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bin], { type: 'image/png' }))
          const img = new Image()
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve()
            img.onerror = () => reject(new Error('Image.onerror'))
            img.src = url
          })
          const W = img.naturalWidth
          const H = img.naturalHeight
          // --- exact copy of the product 4-strip source probe geometry ---
          const headW = Math.max(1, Math.min(10, W))
          const tailW = Math.max(1, Math.min(10, W))
          const tailX = Math.max(0, W - tailW)
          const midX = Math.max(0, Math.min(W - 1, Math.floor(W / 4)))
          const centerX = Math.max(0, Math.min(W - 1, Math.floor(W / 2)))
          const strips = [
            [0, headW],
            [tailX, tailW],
            [midX, Math.max(1, Math.min(10, W - midX))],
            [centerX, Math.max(1, Math.min(10, W - centerX))],
          ]
          const gapCoveredByStrips = strips.some(([sx, sw]) => gapX >= sx && gapX < sx + sw)
          const probe = document.createElement('canvas')
          probe.width = 42
          probe.height = Math.max(1, Math.min(H, 8))
          const pctx = probe.getContext('2d')!
          pctx.clearRect(0, 0, probe.width, probe.height)
          pctx.drawImage(img, 0, 0, headW, H, 0, 0, 10, probe.height)
          pctx.drawImage(img, tailX, 0, tailW, H, 11, 0, 10, probe.height)
          pctx.drawImage(img, midX, 0, Math.max(1, Math.min(10, W - midX)), H, 22, 0, 10, probe.height)
          pctx.drawImage(img, centerX, 0, Math.max(1, Math.min(10, W - centerX)), H, 32, 0, 10, probe.height)
          const pixels = pctx.getImageData(0, 0, probe.width, probe.height)
          let sparseSourceHasOpaque = false
          for (let i = 3; i < pixels.data.length; i += 4) {
            if ((pixels.data[i] ?? 0) !== 0) {
              sparseSourceHasOpaque = true
              break
            }
          }
          // --- full-coverage ground truth: whole image into a 1:1 canvas ---
          const full = document.createElement('canvas')
          full.width = W
          full.height = H
          const fctx = full.getContext('2d')!
          fctx.clearRect(0, 0, W, H)
          fctx.drawImage(img, 0, 0)
          const fullPixels = fctx.getImageData(0, 0, W, H)
          let totalOpaque = 0
          for (let i = 3; i < fullPixels.data.length; i += 4) {
            if ((fullPixels.data[i] ?? 0) !== 0) totalOpaque += 1
          }
          const at = (x: number, y: number) => fullPixels.data[(y * W + x) * 4 + 3] ?? 0
          URL.revokeObjectURL(url)
          return { W, H, strips, gapCoveredByStrips, sparseSourceHasOpaque, totalOpaque, gapAlpha: at(gapX, gapY) }
        },
        { b64: Buffer.from(png).toString('base64'), gapX: GAP_X, gapY: GAP_Y },
      )
      log('sparse scan vs full alpha', result)
      // Ground truth: the fixture really carries exactly 1 opaque pixel.
      expect(result.totalOpaque).toBe(1)
      expect(result.gapAlpha).toBe(255)
      // The blind spot: no strip covers x=50, so the sparse scan reports
      // "transparent source" despite stored ink.
      expect(result.gapCoveredByStrips).toBe(false)
      expect(result.sparseSourceHasOpaque).toBe(false)
      // Hypothesis proven when the next two real-Editor repros (below) show a
      // blank/partial live canvas over this ink saving white: a minority
      // sample cannot certify transparency without subdividing the real source.
    } finally {
      await context.close()
    }
  })

  it('FULL-BLANK monkey-patched live over sparse ink refuses with original 64x48 bytes intact', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      const sparse = buildSparseSingle()
      const canary = buildCanaryPng()
      const { project, files } = spriteProject('SparseSingle', 'sparse', sparse, SW / 2, SH / 2, canary)
      const sb3 = buildSb3(project, files)

      await page.goto(base, { waitUntil: 'networkidle' })
      await openCostumes(page)
      // Monkey-patched canvas path: drop EVERY draw onto the live bitmap
      // canvas (silent-blank raster simulation). Tiny probe canvases are
      // untouched, so the source-ink strips behave exactly like product.
      // NOTE: installed AFTER openCostumes (which navigates) so the patch
      // survives until the import below triggers the placement draw.
      await page.evaluate(() => {
        const proto = CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>
        if (proto.__sparseFullBlankPatched) return
        proto.__sparseFullBlankPatched = true
        const orig = CanvasRenderingContext2D.prototype.drawImage
        CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          try {
            const cv = this.canvas as HTMLCanvasElement | null
            if (cv && typeof cv.getAttribute === 'function' && cv.getAttribute('data-testid') === 'bitmap-editor-canvas') {
              this.clearRect(0, 0, this.canvas.width, this.canvas.height)
              return undefined as unknown as void
            }
          } catch {}
          return (orig as unknown as (...a: unknown[]) => void).apply(this, args)
        }
      })
      await importSb3(page, Buffer.from(sb3), 'sparse')
      await page.getByTestId('target-card-SparseSingle').click()
      await page.waitForTimeout(800)
      const meta0 = await selectedCostumeMeta(page)
      expect(meta0.dataFormat).toBe('png')
      // Original-pixel ground truth (lossless proof): the built PNG itself
      // carries exactly one opaque red pixel at the scan gap.
      const origRgba = decodePng(Buffer.from(sparse))
      expect({ width: origRgba.width, height: origRgba.height }).toEqual({ width: SW, height: SH })
      {
        let totalOpaque = 0
        for (let i = 3; i < origRgba.data.length; i += 4) if ((origRgba.data[i] ?? 0) !== 0) totalOpaque += 1
        expect(totalOpaque).toBe(1)
        const o = (GAP_Y * origRgba.width + GAP_X) * 4
        expect([origRgba.data[o], origRgba.data[o + 1], origRgba.data[o + 2], origRgba.data[o + 3]]).toEqual([255, 0, 0, 255])
      }
      const gpu = await gpuRecord(page)
      const undoBefore = await undoDisabled(page)
      const redoBefore = await redoDisabled(page)
      await page.getByRole('button', { name: 'Select sparse' }).first().click()
      await page.waitForTimeout(600)
      const diag0 = await waitCanvasSettled(page)
      const status0 = await readStatus(page)
      log('full-blank live after load', { canvas: diag0, status: status0, meta: meta0, gpu })
      // FULL dropout must be explicitly refused at load (strict: never hidden).
      expect(status0).toBe(REFUSAL_STATUS)

      // Save attempt must leave the stored asset byte-identical.
      await page.getByTestId('save-bitmap-costume').click()
      await page.waitForTimeout(1200)
      const statusAfterSave = await readStatus(page)
      const metaAfterSave = await selectedCostumeMeta(page)
      const afterSave = await exportSb3(page)
      const recAfterSave = costumeRecord(afterSave, 'SparseSingle', metaAfterSave.index)
      const savedRgba = decodePng(Buffer.from(recAfterSave.bytes))
      let savedTotalOpaque = 0
      for (let i = 3; i < savedRgba.data.length; i += 4) if ((savedRgba.data[i] ?? 0) !== 0) savedTotalOpaque += 1
      const savedGapOffset = (GAP_Y * savedRgba.width + GAP_X) * 4
      log('full-blank after Save', {
        status: statusAfterSave,
        meta: recAfterSave.costume,
        dims: pngDimensions(recAfterSave.bytes),
        savedTotalOpaque,
        savedGap: [savedRgba.data[savedGapOffset], savedRgba.data[savedGapOffset + 1], savedRgba.data[savedGapOffset + 2], savedRgba.data[savedGapOffset + 3]],
        gpu,
      })
      expect(statusAfterSave).toBe(REFUSAL_STATUS)
      // Before/after complete match: bytes, center, resolution, container.
      expect(Buffer.from(recAfterSave.bytes).equals(Buffer.from(sparse))).toBe(true)
      expect(pngDimensions(recAfterSave.bytes)).toEqual({ width: SW, height: SH })
      expect(recAfterSave.costume.rotationCenterX).toBe(meta0.rotationCenterX)
      expect(recAfterSave.costume.rotationCenterY).toBe(meta0.rotationCenterY)
      expect(recAfterSave.costume.bitmapResolution).toBe(meta0.bitmapResolution)
      expect(recAfterSave.costume.md5ext).toBe(meta0.md5ext)
      // Saved pixels stay lossless at the decoded gap point.
      expect({ width: savedRgba.width, height: savedRgba.height }).toEqual({ width: SW, height: SH })
      expect(savedTotalOpaque).toBe(1)
      expect([savedRgba.data[savedGapOffset], savedRgba.data[savedGapOffset + 1], savedRgba.data[savedGapOffset + 2], savedRgba.data[savedGapOffset + 3]]).toEqual([255, 0, 0, 255])
      // Canary stays byte-identical (cross-asset guard).
      const canaryNow = costumeRecord(afterSave, 'Canary', 0)
      expect(Buffer.from(canaryNow.bytes).equals(Buffer.from(canary))).toBe(true)
      expect(canaryNow.costume.bitmapResolution).toBe(2)
      expect(canaryNow.costume.rotationCenterX).toBe(32)
      expect(canaryNow.costume.rotationCenterY).toBe(24)
      // Undo/Redo stay exactly as before (refused Save writes no entry).
      expect(await undoDisabled(page)).toBe(undoBefore)
      expect(await redoDisabled(page)).toBe(redoBefore)

      // Convert attempt must also refuse (never an empty SVG) with no change.
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
      await page.waitForTimeout(1200)
      const statusAfterConvert = await readStatus(page)
      const afterConvert = await exportSb3(page)
      const recAfterConvert = costumeRecord(afterConvert, 'SparseSingle', metaAfterSave.index)
      const unchangedAfterConvert = Buffer.from(recAfterConvert.bytes).equals(Buffer.from(sparse))
      log('full-blank after Convert', { status: statusAfterConvert, meta: recAfterConvert.costume, unchanged: unchangedAfterConvert, gpu })
      expect(statusAfterConvert).toBe(REFUSAL_STATUS)
      expect(recAfterConvert.costume.dataFormat).toBe('png')
      expect(unchangedAfterConvert).toBe(true)
      expect(recAfterConvert.costume.rotationCenterX).toBe(meta0.rotationCenterX)
      expect(recAfterConvert.costume.rotationCenterY).toBe(meta0.rotationCenterY)
      expect(recAfterConvert.costume.bitmapResolution).toBe(meta0.bitmapResolution)
      const canaryAfterConvert = costumeRecord(afterConvert, 'Canary', 0)
      expect(Buffer.from(canaryAfterConvert.bytes).equals(Buffer.from(canary))).toBe(true)
      expect(await undoDisabled(page)).toBe(undoBefore)
      expect(await redoDisabled(page)).toBe(redoBefore)
    } finally {
      await context.close()
    }
  }, 240_000)

  it('PARTIAL monkey-patched live (gap pixel dropped) refuses with head+gap pixels intact', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      const sparse = buildSparseHeadGap()
      const canary = buildCanaryPng()
      const { project, files } = spriteProject('SparseHeadGap', 'sparsehead', sparse, SW / 2, SH / 2, canary)
      const sb3 = buildSb3(project, files)

      await openCostumes(page)
      // Monkey-patched canvas path: keep every placed pixel EXCEPT the gap
      // pixel (partial dropout simulation). Fault injection itself is kept.
      // NOTE: installed AFTER openCostumes (which navigates) so the patch
      // survives until the import below triggers the placement draw.
      await page.evaluate(
        ({ w, h, gx, gy }) => {
          const proto = CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>
          if (proto.__sparsePartialPatched) return
          proto.__sparsePartialPatched = true
          const orig = CanvasRenderingContext2D.prototype.drawImage
          CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, img: CanvasImageSource, ...rest: unknown[]) {
            const result = (orig as unknown as (img: CanvasImageSource, ...r: unknown[]) => void).call(this, img, ...rest)
            try {
              const cv = this.canvas as HTMLCanvasElement | null
              const isMain = cv && typeof cv.getAttribute === 'function' && cv.getAttribute('data-testid') === 'bitmap-editor-canvas'
              const isPlacedImage = typeof (img as HTMLImageElement)?.naturalWidth === 'number' && (img as HTMLImageElement).naturalWidth === w && (img as HTMLImageElement).naturalHeight === h
              if (isMain && isPlacedImage && rest.length >= 2 && typeof rest[0] === 'number' && typeof rest[1] === 'number') {
                this.clearRect((rest[0] as number) + gx, (rest[1] as number) + gy, 1, 1)
              }
            } catch {}
            return result
          }
        },
        { w: SW, h: SH, gx: GAP_X, gy: GAP_Y },
      )
      await importSb3(page, Buffer.from(sb3), 'sparsehead')
      await page.getByTestId('target-card-SparseHeadGap').click()
      await page.waitForTimeout(800)
      const meta0 = await selectedCostumeMeta(page)
      // Original-pixel ground truth: head block + gap pixel both present.
      const origRgba = decodePng(Buffer.from(sparse))
      expect({ width: origRgba.width, height: origRgba.height }).toEqual({ width: SW, height: SH })
      {
        const head = [origRgba.data[(4 * origRgba.width + 4) * 4], origRgba.data[(4 * origRgba.width + 4) * 4 + 1], origRgba.data[(4 * origRgba.width + 4) * 4 + 2], origRgba.data[(4 * origRgba.width + 4) * 4 + 3]]
        expect(head).toEqual([255, 0, 0, 255])
        const o = (GAP_Y * origRgba.width + GAP_X) * 4
        expect([origRgba.data[o], origRgba.data[o + 1], origRgba.data[o + 2], origRgba.data[o + 3]]).toEqual([0, 0, 255, 255])
      }
      const gpu = await gpuRecord(page)
      const undoBefore = await undoDisabled(page)
      const redoBefore = await redoDisabled(page)
      await page.getByRole('button', { name: 'Select sparsehead' }).first().click()
      await page.waitForTimeout(600)
      const diag0 = await waitCanvasSettled(page)
      const status0 = await readStatus(page)
      log('partial live after load', { canvas: diag0, meta: meta0, status: status0, gpu })
      // PARTIAL dropout (one pixel missing) must refuse at load, not pass as
      // healthy because the sampled head ink is still visible.
      expect(status0).toBe(REFUSAL_STATUS)

      // Save must leave head block AND gap pixel intact (no silent crop).
      await page.getByTestId('save-bitmap-costume').click()
      await page.waitForTimeout(1200)
      const statusAfterSave = await readStatus(page)
      const metaAfterSave = await selectedCostumeMeta(page)
      const afterSave = await exportSb3(page)
      const recAfterSave = costumeRecord(afterSave, 'SparseHeadGap', metaAfterSave.index)
      const dimsAfterSave = pngDimensions(recAfterSave.bytes)
      const canaryNow = costumeRecord(afterSave, 'Canary', 0)
      const canarySame = Buffer.from(canaryNow.bytes).equals(Buffer.from(canary))
      let gapBlue: boolean | string = 'undecoded'
      let gapAlpha: number | string = 'undecoded'
      let headRed: boolean | string = 'undecoded'
      try {
        const savedRgba = decodePng(Buffer.from(recAfterSave.bytes))
        const o = (GAP_Y * savedRgba.width + GAP_X) * 4
        const px: [number, number, number, number] = [savedRgba.data[o] ?? 0, savedRgba.data[o + 1] ?? 0, savedRgba.data[o + 2] ?? 0, savedRgba.data[o + 3] ?? 0]
        gapAlpha = px[3]
        gapBlue = px[3] > 128 && px[2] > 150 && px[0] < 120 && px[1] < 150
        const ho = (4 * savedRgba.width + 4) * 4
        headRed = (savedRgba.data[ho + 3] ?? 0) > 128 && (savedRgba.data[ho] ?? 0) > 200 && (savedRgba.data[ho + 1] ?? 0) < 100 && (savedRgba.data[ho + 2] ?? 0) < 100
      } catch (e) {
        gapBlue = `undecodable: ${String(e).split('\n')[0]}`
      }
      log('partial after Save', { status: statusAfterSave, meta: recAfterSave.costume, dims: dimsAfterSave, gapBlue, gapAlpha, headRed, canarySame, gpu })
      expect(statusAfterSave).toBe(REFUSAL_STATUS)
      // Before/after complete match: bytes, center, resolution, container.
      expect(Buffer.from(recAfterSave.bytes).equals(Buffer.from(sparse))).toBe(true)
      expect(dimsAfterSave).toEqual({ width: SW, height: SH })
      expect(recAfterSave.costume.rotationCenterX).toBe(meta0.rotationCenterX)
      expect(recAfterSave.costume.rotationCenterY).toBe(meta0.rotationCenterY)
      expect(recAfterSave.costume.bitmapResolution).toBe(meta0.bitmapResolution)
      expect(recAfterSave.costume.md5ext).toBe(meta0.md5ext)
      // Original pixels lossless at decoded points (head + gap).
      expect(gapBlue).toBe(true)
      expect(headRed).toBe(true)
      // Canary byte-identical.
      expect(canarySame).toBe(true)
      expect(canaryNow.costume.bitmapResolution).toBe(2)
      expect(canaryNow.costume.rotationCenterX).toBe(32)
      expect(canaryNow.costume.rotationCenterY).toBe(24)
      // Undo/Redo unchanged (no history entry from a refused Save).
      expect(await undoDisabled(page)).toBe(undoBefore)
      expect(await redoDisabled(page)).toBe(redoBefore)

      // Convert must also refuse with no change (never a cropped SVG).
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
      await page.waitForTimeout(1200)
      const statusAfterConvert = await readStatus(page)
      const afterConvert = await exportSb3(page)
      const recAfterConvert = costumeRecord(afterConvert, 'SparseHeadGap', metaAfterSave.index)
      log('partial after Convert', { status: statusAfterConvert, meta: recAfterConvert.costume, gpu })
      expect(statusAfterConvert).toBe(REFUSAL_STATUS)
      expect(recAfterConvert.costume.dataFormat).toBe('png')
      expect(Buffer.from(recAfterConvert.bytes).equals(Buffer.from(sparse))).toBe(true)
      expect(recAfterConvert.costume.rotationCenterX).toBe(meta0.rotationCenterX)
      expect(recAfterConvert.costume.rotationCenterY).toBe(meta0.rotationCenterY)
      expect(recAfterConvert.costume.bitmapResolution).toBe(meta0.bitmapResolution)
      const canaryAfterConvert = costumeRecord(afterConvert, 'Canary', 0)
      expect(Buffer.from(canaryAfterConvert.bytes).equals(Buffer.from(canary))).toBe(true)
      expect(await undoDisabled(page)).toBe(undoBefore)
      expect(await redoDisabled(page)).toBe(redoBefore)
    } finally {
      await context.close()
    }
  }, 240_000)

  it('Chrome native side boundary: 65535 rasterizes, 100000 refuses (both ends)', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    try {
      await page.goto(base, { waitUntil: 'networkidle' })
      // GPU/environment uncertainty is recorded here and never softens the
      // asserts below: a different raster ceiling still fails loudly.
      log('native boundary gpu', await gpuRecord(page))
      for (const W of [65535, 100000]) {
        const probe = await page.evaluate(async ({ width, height }: { width: number; height: number }) => {
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
              try {
                const d = ctx.getImageData(0, 0, Math.min(width, 16), height)
                const head = Array.from(d.data.slice(0, 4))
                out.rasterHeadPixel = head
                out.rasterOk = head[0] === 255 && head[1] === 0 && head[2] === 0 && head[3] === 255
              } catch (e) {
                out.getImageDataErr = String(e).slice(0, 160)
              }
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
          return out
        }, { width: W, height: 2 })
        log(`native boundary ${W}x2`, probe)
        if (W === 65535) {
          expect(probe.canvasReadback).toEqual([65535, 2])
          expect(probe.rasterOk).toBe(true)
          expect(probe.toBlobNull).toBe(false)
        } else {
          expect(probe.canvasReadback).toEqual([100000, 2])
          // Native refusal: allocate OK but raster blank + encode null.
          expect(probe.rasterOk).toBe(false)
          expect(probe.toBlobNull).toBe(true)
        }
      }
    } finally {
      await context.close()
    }
  })
})
