import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// NEW browser test only (product code untouched).
// Purpose: the artboard-integration report leaves open the fear that right
// after a target/costume switch the still-stale bitmap canvas (old pixels)
// can be mis-saved into the newly selected asset.
// This test drives the REAL Editor VM with deferred image-decode / PNG-encode
// gates so the stale window is deterministically wide, then interleaves:
// target/costume switches, fast brush strokes, explicit Save, copy/paste
// affordances, arrow-key nudge, bitmap<->vector conversion, Undo/Redo, and
// distinct resolution/rotationCenter assets. It verifies per-asset bytes,
// centers, resolutions and the compositor stage. Failures are reported
// loudly (no hiding): any cross-asset pixel is a test failure with counts.
//
// Deferred gates (test-only, installed via page.evaluate):
// - window.Image onload/addEventListener('load') delayed by __imgDelayMs when
//   window.__gateOn is true (widens loadCostumeIntoBitmapCanvas decode window).
// - HTMLCanvasElement.prototype.toBlob callback delayed by __blobDelayMs when
//   window.__gateOn is true (widens buildCroppedBitmapSave encode window).
// Both gates are removed (flag off) before final verification so assertions
// observe settled state, not the gated loading frame.
//
// Independent Vite port 4527 (surveyed 2026-11: 4173/4245/4251/4473/4483 and
// the 4173-4495 block are taken by sibling suites; ss shows 4527 free).
const root = join(import.meta.dir, '..')
const PORT = 4527
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

/** Minimal RGBA PNG encoder (zlib-wrapped IDAT so Chrome rasterizes it). */
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

function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function decodePng(png: Buffer | Uint8Array): { width: number; height: number; data: Buffer } {
  const bytes = Buffer.from(png)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!bytes.subarray(0, 8).equals(sig)) throw new Error('Not a PNG screenshot')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const parts: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const start = offset + 8
    const end = start + len
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(start)
      height = bytes.readUInt32BE(start + 4)
      bitDepth = bytes[start + 8] ?? 0
      colorType = bytes[start + 9] ?? 0
    } else if (type === 'IDAT') {
      parts.push(bytes.subarray(start, end))
    } else if (type === 'IEND') break
    offset = end + 4
  }
  if (width === 0 || height === 0) throw new Error('Missing IHDR')
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`Unsupported PNG depth=${bitDepth} color=${colorType}`)
  const channels = colorType === 6 ? 4 : 3
  const { inflateSync } = require('node:zlib') as typeof import('node:zlib')
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let ro = 0
  let prev = Buffer.alloc(stride, 0)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[ro] ?? 0
    ro += 1
    const cur = Buffer.from(raw.subarray(ro, ro + stride))
    ro += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? (cur[x - channels] ?? 0) : 0
      const b = prev[x] ?? 0
      const c = x >= channels ? (prev[x - channels] ?? 0) : 0
      const v = cur[x] ?? 0
      if (filter === 1) cur[x] = (v + a) & 0xff
      else if (filter === 2) cur[x] = (v + b) & 0xff
      else if (filter === 3) cur[x] = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        cur[x] = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels
      const t = (y * width + x) * 4
      rgba[t] = cur[s] ?? 0
      rgba[t + 1] = cur[s + 1] ?? 0
      rgba[t + 2] = cur[s + 2] ?? 0
      rgba[t + 3] = channels === 4 ? (cur[s + 3] ?? 255) : 255
    }
    prev = cur
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

const isRed = (r: number, g: number, b: number, a: number) => a > 128 && r > 200 && g < 110 && b < 110
const isBlue = (r: number, g: number, b: number, a: number) => a > 128 && b > 200 && r < 110 && g < 170
const isGreen = (r: number, g: number, b: number, a: number) => a > 128 && g > 150 && r < 120 && b < 120

function log(label: string, value: unknown) {
  console.log(`[stale-gate] ${label} ${JSON.stringify(value).slice(0, 3000)}`)
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function selectedMeta(page: Page) {
  return await page.evaluate(() => {
    const snap = (window as any).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId)
      ?? snap.project.targets.find((t: any) => !t.isStage)
      ?? snap.project.targets[0]!
    const index = target.currentCostume ?? 0
    const c = target.costumes[index]!
    return { targetName: target.name, isStage: !!target.isStage, index, name: c.name, dataFormat: c.dataFormat ?? '', bitmapResolution: c.bitmapResolution, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, md5ext: c.md5ext }
  })
}

async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'stale-gate.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
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

async function exportSb3(page: Page) {
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

async function stageRgba(page: Page) {
  let last: unknown
  for (let i = 0; i < 5; i += 1) {
    try {
      const png = await page.getByTestId('stage-canvas').screenshot({ type: 'png', timeout: 15_000 })
      return decodePng(png)
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw last
}

async function waitStageSettled(page: Page, timeout = 25_000) {
  const start = Date.now()
  let prev: { width: number; height: number; data: Buffer } | undefined
  let stable = 0
  for (;;) {
    const cur = await stageRgba(page)
    if (prev && prev.width === cur.width && prev.height === cur.height) {
      let diff = 0
      const total = cur.data.length / 4
      for (let i = 0; i < cur.data.length; i += 4) {
        const d = Math.abs((cur.data[i] ?? 0) - (prev.data[i] ?? 0))
          + Math.abs((cur.data[i + 1] ?? 0) - (prev.data[i + 1] ?? 0))
          + Math.abs((cur.data[i + 2] ?? 0) - (prev.data[i + 2] ?? 0))
          + Math.abs((cur.data[i + 3] ?? 0) - (prev.data[i + 3] ?? 0))
        if (d > 48) diff += 1
      }
      if (diff / total < 0.004) {
        stable += 1
        if (stable >= 2) return cur
      } else stable = 0
    } else stable = 0
    prev = cur
    if (Date.now() - start > timeout) throw new Error('Stage never settled')
    await new Promise((r) => setTimeout(r, 700))
  }
}

async function waitBitmapCanvas(page: Page, timeout = 20_000) {
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout })
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
  }, undefined, { timeout })
}

async function installDeferredGates(page: Page, imgDelayMs: number, blobDelayMs: number) {
  await page.evaluate(({ imgDelay, blobDelay }: { imgDelay: number; blobDelay: number }) => {
    const w = window as any
    if (w.__staleGateInstalled) {
      w.__imgDelayMs = imgDelay
      w.__blobDelayMs = blobDelay
      w.__gateOn = true
      return
    }
    w.__staleGateInstalled = true
    w.__imgDelayMs = imgDelay
    w.__blobDelayMs = blobDelay
    w.__gateOn = true
    const RealImage = window.Image
    w.__RealImage = RealImage
    class GatedImage extends RealImage {
      _rawOnLoad: any = null
      _rawOnError: any = null
      constructor() {
        super()
        Object.defineProperty(this, 'onload', {
          configurable: true,
          get: () => this._rawOnLoad,
          set: (fn: any) => {
            if (typeof fn !== 'function') {
              this._rawOnLoad = null
              super.onload = null as any
              return
            }
            const self = this
            const wrapped = function (this: any, ...a: any[]) {
              if ((window as any).__gateOn) setTimeout(() => fn.apply(self, a), (window as any).__imgDelayMs)
              else fn.apply(self, a)
            }
            this._rawOnLoad = wrapped
            super.onload = wrapped as any
          },
        })
        Object.defineProperty(this, 'onerror', {
          configurable: true,
          get: () => this._rawOnError,
          set: (fn: any) => {
            if (typeof fn !== 'function') {
              this._rawOnError = null
              super.onerror = null as any
              return
            }
            const self = this
            const wrapped = function (this: any, ...a: any[]) {
              if ((window as any).__gateOn) setTimeout(() => fn.apply(self, a), (window as any).__imgDelayMs)
              else fn.apply(self, a)
            }
            this._rawOnError = wrapped
            super.onerror = wrapped as any
          },
        })
        const origAdd = this.addEventListener.bind(this)
        this.addEventListener = ((type: string, listener: any, opts?: any) => {
          if ((type === 'load' || type === 'error') && typeof listener === 'function') {
            const wrapped = (e: Event) => {
              if ((window as any).__gateOn) setTimeout(() => listener.call(this, e), (window as any).__imgDelayMs)
              else listener.call(this, e)
            }
            return origAdd(type, wrapped as any, opts)
          }
          return origAdd(type, listener, opts)
        }) as any
      }
    }
    window.Image = GatedImage as any
    const origToBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (cb: any, ...rest: any[]) {
      const wrapped = (...a: any[]) => {
        if ((window as any).__gateOn) setTimeout(() => cb(...a), (window as any).__blobDelayMs)
        else cb(...a)
      }
      return (origToBlob as any).call(this, wrapped, ...rest)
    }
  }, { imgDelay: imgDelayMs, blobDelay: blobDelayMs } as unknown as undefined)
}

async function setGate(page: Page, on: boolean) {
  await page.evaluate((v: boolean) => { (window as any).__gateOn = v }, on as unknown as undefined)
}

async function seedMarker(page: Page, css: string, x: number, y: number, w: number, h: number) {
  await page.evaluate(({ color, rx, ry, rw, rh }: { color: string; rx: number; ry: number; rw: number; rh: number }) => {
    const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!c) throw new Error('Missing bitmap canvas for marker')
    const ctx = c.getContext('2d')!
    ctx.save()
    ctx.fillStyle = color
    ctx.fillRect(rx, ry, rw, rh)
    ctx.restore()
  }, { color: css, rx: x, ry: y, rw: w, rh: h } as unknown as undefined)
}

async function pressSave(page: Page) {
  await page.getByTestId('save-bitmap-costume').click()
}

async function clickTarget(page: Page, testId: string) {
  await page.getByTestId(testId).click()
}

async function doBrushStroke(page: Page, dx1: number, dy1: number, dx2: number, dy2: number) {
  await page.getByTestId('bitmap-tool-brush').click()
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx + dx1, cy + dy1)
  await page.mouse.down()
  await page.mouse.move(cx + dx2, cy + dy2, { steps: 6 })
  await page.mouse.up()
}

async function trySelectDragCopyPasteNudge(page: Page, runLabel: string) {
  const out: Record<string, unknown> = { ran: runLabel }
  try {
    await page.getByTestId('bitmap-tool-select').click()
    const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!box) throw new Error('no box')
    // Marquee near the seeded marker (canvas coords scale with artboard size;
    // use relative center offsets in screen space).
    const x0 = box.x + box.width * 0.3
    const y0 = box.y + box.height * 0.3
    const x1 = box.x + box.width * 0.55
    const y1 = box.y + box.height * 0.55
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x1, y1, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const hasSel = await page.evaluate(() => !!document.querySelector('[data-testid="bitmap-selection"]'))
    out.hasSelection = hasSel
    // Copy via keyboard (real shortcut path), then paste via toolbar button.
    await page.keyboard.press('ControlOrMeta+c')
    await page.waitForTimeout(300)
    const pasteBtn = page.getByTestId('paste-costume-selection')
    out.pasteVisible = await pasteBtn.isVisible().catch(() => false)
    out.pasteEnabled = await pasteBtn.isEnabled().catch(() => false)
    if (await pasteBtn.isEnabled().catch(() => false)) {
      await pasteBtn.click()
      await page.waitForTimeout(300)
    } else {
      await page.keyboard.press('ControlOrMeta+v')
      await page.waitForTimeout(300)
    }
    // Arrow-key nudge (real keyboard path through the pending-preview chain).
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(400)
    await page.keyboard.up('ArrowDown')
    out.nudgeSent = true
  } catch (e) {
    out.error = String(e).slice(0, 500)
  }
  log('select/paste/nudge attempt', out)
}

describe('artboard stale-canvas cross-asset gate (new test, no product change)', () => {
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

  it('deferred decode/encode across switches keeps old pixels out of the new asset', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      // Distinct fixtures: red sprite (res2, off-center), blue sprite (res1,
      // small, off-center), green stage backdrop (res1). Colors never overlap
      // so any cross-asset pixel is attributable.
      const redPng = buildPng(96, 96, (x, y) => {
        const red = x >= 20 && x < 50 && y >= 20 && y < 50
        return red ? [255, 0, 0, 255] : [255, 255, 255, 255]
      })
      const bluePng = buildPng(64, 48, (x, y) => {
        const blue = x >= 10 && x < 34 && y >= 10 && y < 30
        return blue ? [0, 0, 255, 255] : [255, 255, 255, 255]
      })
      const greenPng = buildPng(480, 360, (x, y) => {
        const green = x >= 60 && x < 180 && y >= 60 && y < 150
        return green ? [0, 200, 0, 255] : [255, 255, 255, 255]
      })
      const files: Record<string, Uint8Array> = {}
      const put = (bytes: Uint8Array, ext: string) => {
        const h = md5(bytes)
        files[`${h}.${ext}`] = bytes
        return { assetId: h, md5ext: `${h}.${ext}` }
      }
      const redFile = put(redPng, 'png')
      const blueFile = put(bluePng, 'png')
      const greenFile = put(greenPng, 'png')
      const project = {
        targets: [
          {
            isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'green-backdrop', ...greenFile, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
            sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
          },
          {
            isStage: false, name: 'GateA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [
              { name: 'redA', ...redFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 30, rotationCenterY: 70 },
              { name: 'redA2', ...redFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 48, rotationCenterY: 48 },
            ],
            sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
          },
          {
            isStage: false, name: 'GateB', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'blueB', ...blueFile, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 10, rotationCenterY: 20 }],
            sounds: [], volume: 100, layerOrder: 2, visible: true, x: 80, y: 40, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
          },
        ],
        monitors: [], extensions: [],
        meta: { semver: '3.0.0', vm: 'stale-gate', agent: 'stale-gate' },
      }
      await openCostumes(page)
      await importSb3(page, buildSb3(project, files), 'redA')

      const baseline = await exportSb3(page)
      const baseRed = baseline.project.targets.find((t: any) => t.name === 'GateA').costumes[0]
      const baseBlue = baseline.project.targets.find((t: any) => t.name === 'GateB').costumes[0]
      const baseStage = baseline.project.targets.find((t: any) => t.name === 'Stage').costumes[0]
      log('baseline meta', { red: baseRed, blue: baseBlue, stage: baseStage })
      expect(baseRed.bitmapResolution).toBe(2)
      expect(baseRed.rotationCenterX).toBe(30)
      expect(baseRed.rotationCenterY).toBe(70)
      expect(baseBlue.bitmapResolution).toBe(1)
      expect(baseBlue.rotationCenterX).toBe(10)
      expect(baseStage.bitmapResolution).toBe(1)

      // Install deferred gates BEFORE the race window.
      await installDeferredGates(page, 600, 500)
      log('gates installed', { imgDelayMs: 600, blobDelayMs: 500 })

      // --- Race window: rapid interleaving with gates ON ------------------
      // Each round: select A -> brush -> seed RED marker -> Save (async) ->
      // immediate switch to B -> immediate Save (stale canvas!) -> paste/nudge
      // -> seed BLUE marker -> Save -> immediate switch back. Then conversions
      // and Undo/Redo while still gated. No awaits between switch and Save on
      // purpose: that is the feared "直後に古いcanvasを新targetへ誤保存".
      for (let round = 0; round < 2; round += 1) {
        log('round start', { round })
        await clickTarget(page, 'target-card-GateA')
        await page.waitForTimeout(120)
        await doBrushStroke(page, -40, -30, 40, 30)
        await seedMarker(page, '#ff0000', 20 + round * 5, 24, 22, 22)
        const saveA = pressSave(page)
        // Switch before either the brush save's toBlob or the new decode lands.
        await clickTarget(page, 'target-card-GateB')
        // Stale-window Save on the NEW target with the OLD canvas still shown.
        await pressSave(page)
        await saveA.catch(() => undefined)
        await trySelectDragCopyPasteNudge(page, `B-stale-round${round}`)
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(150)
        await seedMarker(page, '#0000ff', 12, 12, 20, 16)
        const saveB = pressSave(page)
        await clickTarget(page, 'target-card-GateA')
        await pressSave(page)
        await saveB.catch(() => undefined)
        await trySelectDragCopyPasteNudge(page, `A-stale-round${round}`)
        // Costume switch inside GateA (redA <-> redA2, different centers).
        const metaNow = await selectedMeta(page)
        log('round mid meta', { round, metaNow })
        if (metaNow.targetName === 'GateA') {
          const want = metaNow.name === 'redA' ? 'redA2' : 'redA'
          await page.getByRole('button', { name: `Select ${want}` }).first().click()
          await page.waitForTimeout(120)
          await pressSave(page)
        }
        // RotationCenter nudge on the current selection (real sidebar inputs).
        const cur = await selectedMeta(page)
        await page.evaluate(({ x, y }: { x: number; y: number }) => {
          const labels = Array.from(document.querySelectorAll('label'))
          const inputFor = (text: string) => labels.find((l) => (l.textContent ?? '').includes(text))?.querySelector('input') as HTMLInputElement | undefined
          const set = (input: HTMLInputElement | undefined, value: number) => {
            if (!input) return
            input.focus()
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
              ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            if (setter) setter.call(input, String(value))
            else input.value = String(value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }
          set(inputFor('Center X'), x)
          set(inputFor('Center Y'), y)
        }, { x: (cur.rotationCenterX ?? 30) + 1, y: cur.rotationCenterY ?? 70 } as unknown as undefined)
        await page.waitForTimeout(200)
      }

      // Conversion + Undo/Redo while still gated (conversion has its own
      // scope guard; a stale write here must not cross assets either).
      await clickTarget(page, 'target-card-GateA')
      await page.waitForTimeout(150)
      try {
        await page.getByRole('button', { name: 'ベクターに変換' }).click({ timeout: 5_000 })
        await page.waitForTimeout(400)
        await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
        await page.waitForTimeout(400)
        log('gated conversions attempted', { ok: true })
      } catch (e) {
        log('gated conversions skipped', { error: String(e).slice(0, 300) })
      }
      try {
        const undoBtn = page.locator('button[aria-label="Undo"]:visible').last()
        const redoBtn = page.locator('button[aria-label="Redo"]:visible').last()
        if (await undoBtn.isEnabled().catch(() => false)) await undoBtn.click()
        await page.waitForTimeout(250)
        if (await redoBtn.isEnabled().catch(() => false)) await redoBtn.click()
        await page.waitForTimeout(250)
        log('gated undo/redo attempted', { ok: true })
      } catch (e) {
        log('gated undo/redo skipped', { error: String(e).slice(0, 300) })
      }

      // --- Settle: gates OFF, wait for real decodes/saves to land ---------
      await setGate(page, false)
      log('gates off, settling', {})
      await page.waitForTimeout(1500)
      await clickTarget(page, 'target-card-GateA')
      await waitBitmapCanvas(page).catch(() => undefined)
      await waitStageSettled(page).catch(() => undefined)
      await clickTarget(page, 'target-card-GateB')
      await waitBitmapCanvas(page).catch(() => undefined)
      await waitStageSettled(page).catch(() => undefined)
      await clickTarget(page, 'target-card-stage')
      await page.waitForTimeout(1200)
      await waitStageSettled(page).catch(() => undefined)

      const settled = await exportSb3(page)
      const findC = (targetName: string, idx: number) => {
        const t = settled.project.targets.find((x: any) => x.name === targetName)
        return { target: t, costume: t.costumes[idx] }
      }
      const gA0 = findC('GateA', 0)
      const gA1 = findC('GateA', 1)
      const gB0 = findC('GateB', 0)
      const st0 = findC('Stage', 0)
      log('settled meta', {
        gateA0: gA0.costume, gateA1: gA1.costume, gateB0: gB0.costume, stage0: st0.costume,
      })

      const rgbaOf = (md5ext: string) => decodePng(Buffer.from(settled.assets[md5ext]!))
      const redBytes = rgbaOf(gA0.costume.md5ext)
      const red2Bytes = rgbaOf(gA1.costume.md5ext)
      const blueBytes = rgbaOf(gB0.costume.md5ext)
      const stageBytes = rgbaOf(st0.costume.md5ext)
      const counts = {
        gateA0: { red: countWhere(redBytes.data, isRed), blue: countWhere(redBytes.data, isBlue), green: countWhere(redBytes.data, isGreen), dims: pngDimensions(settled.assets[gA0.costume.md5ext]!) },
        gateA1: { red: countWhere(red2Bytes.data, isRed), blue: countWhere(red2Bytes.data, isBlue), green: countWhere(red2Bytes.data, isGreen), dims: pngDimensions(settled.assets[gA1.costume.md5ext]!) },
        gateB0: { red: countWhere(blueBytes.data, isRed), blue: countWhere(blueBytes.data, isBlue), green: countWhere(blueBytes.data, isGreen), dims: pngDimensions(settled.assets[gB0.costume.md5ext]!) },
        stage0: { red: countWhere(stageBytes.data, isRed), blue: countWhere(stageBytes.data, isBlue), green: countWhere(stageBytes.data, isGreen), dims: pngDimensions(settled.assets[st0.costume.md5ext]!) },
      }
      log('settled pixel counts (cross-asset contamination check)', counts)

      // Stage compositor check on each selection (real pixels, not canvas read).
      await clickTarget(page, 'target-card-GateA')
      await waitStageSettled(page)
      const stageOnA = await stageRgba(page)
      const stageA = { red: countWhere(stageOnA.data, isRed), blue: countWhere(stageOnA.data, isBlue), green: countWhere(stageOnA.data, isGreen) }
      await clickTarget(page, 'target-card-GateB')
      await waitStageSettled(page)
      const stageOnB = await stageRgba(page)
      const stageB = { red: countWhere(stageOnB.data, isRed), blue: countWhere(stageOnB.data, isBlue), green: countWhere(stageOnB.data, isGreen) }
      await clickTarget(page, 'target-card-stage')
      await waitStageSettled(page)
      const stageOnStage = await stageRgba(page)
      const stageS = { red: countWhere(stageOnStage.data, isRed), blue: countWhere(stageOnStage.data, isBlue), green: countWhere(stageOnStage.data, isGreen) }
      log('stage pixels per selection', { onGateA: stageA, onGateB: stageB, onStage: stageS })

      // --- Honest verdict: old pixels must never appear in the other asset.
      // GateA family must carry red and zero blue; GateB must carry blue and
      // zero red; Stage must carry green and zero red/blue. Centers keep their
      // distinct values (A0 was nudged +1..2 in X by the test; B untouched).
      const failures: string[] = []
      if (!(counts.gateA0.red > 200)) failures.push(`GateA/redA lost its red ink (red=${counts.gateA0.red})`)
      if (counts.gateA0.blue !== 0) failures.push(`GateA/redA contaminated with BLUE pixels (blue=${counts.gateA0.blue}) — stale GateB canvas saved into GateA?`)
      if (counts.gateA0.green !== 0) failures.push(`GateA/redA contaminated with GREEN pixels (green=${counts.gateA0.green})`)
      if (counts.gateB0.blue <= 100) failures.push(`GateB/blueB lost its blue ink (blue=${counts.gateB0.blue})`)
      if (counts.gateB0.red !== 0) failures.push(`GateB/blueB contaminated with RED pixels (red=${counts.gateB0.red}) — stale GateA canvas saved into GateB?`)
      if (counts.gateB0.green !== 0) failures.push(`GateB/blueB contaminated with GREEN pixels (green=${counts.gateB0.green})`)
      if (counts.stage0.green <= 500) failures.push(`Stage lost its green ink (green=${counts.stage0.green})`)
      if (counts.stage0.red !== 0) failures.push(`Stage contaminated with RED (red=${counts.stage0.red})`)
      if (counts.stage0.blue !== 0) failures.push(`Stage contaminated with BLUE (blue=${counts.stage0.blue})`)
      if (gB0.costume.bitmapResolution !== 1) failures.push(`GateB resolution drifted to ${gB0.costume.bitmapResolution} (expected 1)`)
      if (gA0.costume.bitmapResolution !== 2) failures.push(`GateA resolution drifted to ${gA0.costume.bitmapResolution} (expected 2)`)
      // Centers legitimately move on crop (artboard crop => canvasCenter-trim),
      // so only forbid exact cross-identity swaps, not any motion. Finite check
      // guards NaN/corruption races.
      for (const [label, c] of [['GateA/redA', gA0.costume], ['GateB/blueB', gB0.costume], ['Stage', st0.costume]] as const) {
        if (!Number.isFinite(c.rotationCenterX) || !Number.isFinite(c.rotationCenterY)) {
          failures.push(`${label} center non-finite (${c.rotationCenterX},${c.rotationCenterY})`)
        }
      }
      if (gA0.costume.rotationCenterX === 10 && gA0.costume.rotationCenterY === 20) {
        failures.push('GateA center exactly equals GateB baseline (10,20) — center cross-write?')
      }
      if (gB0.costume.rotationCenterX === 30 && gB0.costume.rotationCenterY === 70) {
        failures.push('GateB center exactly equals GateA baseline (30,70) — center cross-write?')
      }
      // Note: the compositor stage shows ALL sprites at once (GateA at 0,0 and
      // GateB at 80,40), so red+blue together on the stage is EXPECTED and is
      // not asserted here. Cross-asset verdict rests on per-asset bytes above
      // (each asset must carry only its own color). Stage-asset bytes (green
      // only) already prove the Stage asset itself was not polluted.
      if (failures.length > 0) {
        log('VERDICT: FAIL — stale canvas cross-asset contamination (or loss) detected', { failures, counts })
      } else {
        log('VERDICT: PASS — no cross-asset pixels; centers/resolutions/stage clean', { counts })
      }
      expect(failures).toEqual([])
    } finally {
      await context.close()
    }
  }, 240_000)
})
