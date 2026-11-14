import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { inflateSync as inflateRaw, strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Forensics for: "external 60x40 PNG then distant marquee->paste: canvas opaque
// 2400->174280, selection width 108%".
//
// What this pins (healthy expectations, reported openly on failure):
// - source has NO white / NO outline-blue: red opaque + green opaque +
//   semi-transparent blue + a fully-transparent hole. Any white opaque or
//   outline-blue (#2563eb) on the canvas is therefore ALWAYS a spurious
//   generation (background fill / leaked selection outline), never real ink.
// - transparent-hole or empty-artboard marquees must not create opaque: the
//   drag trims to opaque bounds (or clears when fully transparent), so
//   copy/paste/Undo/Redo deltas stay bounded by the clipboard size.
// - far marquee (to canvas edge / beyond canvas) must keep the live canvas at
//   960x720, selection style width <= 100%, and opaque delta <= clipboard
//   opaque (real stamp only, no checkerboard/fill).
// - saved asset RGBA must contain only forensic colors + transparent, dims =
//   live trim, center = (480-trim.x, 360-trim.y), and out-of-range opaque
//   (outside baseline ∪ expected paste dest) must stay 0.
// - Stage screen must show the forensic colors but never outline-blue /
//   unrelated saturated colors.
//
// Product code is untouched: this file only drives the real Editor UI.
// Independent Vite port 4540 (surveyed: 4490/4496/4473/4483/4527/4531/4533/
// 4251/4291/4387/4389 in use; 4540 free, no listener at survey time).
const root = join(import.meta.dir, '..')
const PORT = 4540
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
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
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const crc = (chunk: Uint8Array): Uint8Array => {
    let c = 0xffffffff
    for (const b of chunk) {
      c ^= b
      for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, (c ^ 0xffffffff) >>> 0)
    return out
  }
  const mkChunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length)
    new DataView(out.buffer).setUint32(0, data.length)
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    out.set(crc(out.slice(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const idat = zlibSync(raw)
  const parts = [sig, mkChunk('IHDR', ihdr), mkChunk('IDAT', idat), mkChunk('IEND', new Uint8Array(0))]
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
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function decodePng(png: Buffer | Uint8Array): { width: number; height: number; data: Buffer } {
  const bytes = Buffer.from(png)
  let offset = 8
  let width = 0
  let height = 0
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
      colorType = bytes[dataStart + 9] ?? 0
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
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
    rawOffset += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? (current[x - channels] ?? 0) : 0
      const b = previous[x] ?? 0
      const c = x >= channels ? (previous[x - channels] ?? 0) : 0
      const v = current[x] ?? 0
      if (filter === 1) current[x] = (v + a) & 0xff
      else if (filter === 2) current[x] = (v + b) & 0xff
      else if (filter === 3) current[x] = ((v + ((a + b) >> 1)) as number) & 0xff
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

function log(label: string, value: unknown) {
  console.log(`[transparent-forensics] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
}

async function waitEditorApi(page: Page, timeout = 60_000) {
  await page.waitForFunction(() => !!(window as any).__hikkakuEditorTest, null, { timeout })
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 60_000 })
  await waitEditorApi(page)
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 60_000 })
  await waitEditorApi(page)
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
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 60_000 })
  await waitEditorApi(page)
  await page.waitForTimeout(800)
}

async function canvasBox(page: Page) {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas box')
  return box
}

function toScreen(box: { x: number; y: number; width: number; height: number }, cw: number, ch: number, cx: number, cy: number) {
  return { x: box.x + (cx / cw) * box.width, y: box.y + (cy / ch) * box.height }
}

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

async function waitCanvasDiag(page: Page, timeout = 15_000) {
  const start = Date.now()
  let last: unknown = null
  for (;;) {
    const d = await canvasDiag(page)
    last = d
    if ((d as any).found && (d as any).readable) return d
    if (Date.now() - start > timeout) throw new Error(`bitmap canvas never reappeared: ${JSON.stringify(last)}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

async function waitMd5Changed(page: Page, banned: string, timeout = 30_000) {
  await page.waitForFunction(
    (ban: string) => {
      const snap = (window as any).__hikkakuEditorTest.snapshot()
      const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t: any) => !t.isStage) ?? snap.project.targets[0]!
      const costume = target.costumes[target.currentCostume ?? 0]!
      return (costume.dataFormat ?? '') === 'png' && (costume.md5ext ?? '') !== ban
    },
    banned as unknown as undefined,
    { timeout },
  )
}

async function selectedCostumeMeta(page: Page) {
  return await page.evaluate(() => {
    const snap = (window as any).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t: any) => !t.isStage) ?? snap.project.targets[0]!
    const index = target.currentCostume ?? 0
    const costume = target.costumes[index]!
    return { targetName: target.name, index, name: costume.name, dataFormat: costume.dataFormat ?? '', bitmapResolution: costume.bitmapResolution, rotationCenterX: costume.rotationCenterX, rotationCenterY: costume.rotationCenterY, md5ext: costume.md5ext }
  })
}

async function selectionInfo(page: Page) {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
    let status: unknown = null
    try {
      status = (window as any).__hikkakuEditorTest?.status?.() ?? null
    } catch {}
    const btns = Array.from(document.querySelectorAll('[data-testid="paste-costume-selection"]'))
    if (!el) return { present: false as const, status, pasteCount: btns.length, pasteDisabled: btns.map((b) => (b as HTMLButtonElement).disabled) }
    const parse = (v: string): number => {
      const m = v.trim().match(/^(-?\d+(?:\.\d+)?)%$/)
      return m ? Number.parseFloat(m[1]!) : Number.NaN
    }
    return {
      present: true as const,
      status,
      pasteCount: btns.length,
      pasteDisabled: btns.map((b) => (b as HTMLButtonElement).disabled),
      style: { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height },
      widthPct: parse(el.style.width),
      heightPct: parse(el.style.height),
      leftPct: parse(el.style.left),
      topPct: parse(el.style.top),
    }
  })
}

/** Full-canvas forensic counts computed in-page (no giant buffer transfer). */
async function forensicCanvas(page: Page, allowed: Array<{ x: number; y: number; width: number; height: number }> = []) {
  return await page.evaluate((allowedRects: Array<{ x: number; y: number; width: number; height: number }>) => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) return { found: false as const }
    const context = canvas.getContext('2d')
    if (!context) return { found: true as const, readable: false as const }
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const inside = (x: number, y: number) => allowedRects.some((r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height)
    let opaque = 0
    let red = 0
    let green = 0
    let blueSemi = 0
    let outlineBlue = 0
    let white = 0
    let other = 0
    let outOfRangeOpaque = 0
    let outOfRangeWhite = 0
    let outOfRangeOther = 0
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4
        const r = image.data[i] ?? 0
        const g = image.data[i + 1] ?? 0
        const b = image.data[i + 2] ?? 0
        const a = image.data[i + 3] ?? 0
        if (a === 0) continue
        opaque += 1
        const isRed = a > 200 && r > 200 && g < 100 && b < 100
        const isGreen = a > 200 && g > 200 && r < 100 && b < 100
        const isBlueSemi = a >= 40 && a <= 200 && b > 150 && r < 120 && g < 150
        const isOutline = a > 50 && Math.abs(r - 37) < 30 && Math.abs(g - 99) < 30 && Math.abs(b - 235) < 30
        const isWhite = a > 200 && r > 245 && g > 245 && b > 245
        if (isRed) red += 1
        else if (isGreen) green += 1
        else if (isBlueSemi) blueSemi += 1
        else if (isOutline) outlineBlue += 1
        else if (isWhite) white += 1
        else other += 1
        if (!inside(x, y)) {
          outOfRangeOpaque += 1
          if (isWhite) outOfRangeWhite += 1
          else if (!isRed && !isGreen && !isBlueSemi) outOfRangeOther += 1
        }
      }
    }
    return { found: true as const, readable: true as const, width: canvas.width, height: canvas.height, opaque, red, green, blueSemi, outlineBlue, white, other, outOfRangeOpaque, outOfRangeWhite, outOfRangeOther }
  }, allowed as unknown as undefined)
}

async function clickToolbarButton(page: Page, name: 'Undo' | 'Redo'): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.getByRole('button', { name }).last().click({ timeout: 8_000 })
      return `playwright-click attempt${attempt}`
    } catch (error) {
      const lastError = String(error).split('\n')[0]
      if (attempt === 2) {
        const clicked = await page.evaluate((label: string) => {
          const btns = Array.from(document.querySelectorAll('button')).filter((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === label)
          const target = btns[btns.length - 1] as HTMLButtonElement | undefined
          if (!target) return false
          target.scrollIntoView({ block: 'nearest' })
          target.click()
          return true
        }, name)
        log(`toolbar ${name} fallback`, { clicked, lastError })
        if (!clicked) throw error
        return 'evaluate-click fallback'
      }
      await page.waitForTimeout(800)
    }
  }
  throw new Error('unreachable')
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
    const stream = await download.createStream()
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

function countForensicRgba(data: Buffer) {
  let red = 0
  let green = 0
  let blueSemi = 0
  let outline = 0
  let white = 0
  let other = 0
  let transparent = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    const a = data[i + 3] ?? 0
    if (a === 0) {
      transparent += 1
      continue
    }
    if (a > 200 && r > 200 && g < 100 && b < 100) red += 1
    else if (a > 200 && g > 200 && r < 100 && b < 100) green += 1
    else if (a >= 40 && a <= 200 && b > 150 && r < 120 && g < 150) blueSemi += 1
    else if (a > 50 && Math.abs(r - 37) < 30 && Math.abs(g - 99) < 30 && Math.abs(b - 235) < 30) outline += 1
    else if (a > 200 && r > 245 && g > 245 && b > 245) white += 1
    else other += 1
  }
  return { red, green, blueSemi, outline, white, other, transparent, total: data.length / 4 }
}

async function stageRgba(page: Page) {
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

async function waitStageSettled(page: Page, timeout = 25_000) {
  const start = Date.now()
  let previous: { width: number; height: number; data: Buffer } | undefined
  let stable = 0
  for (;;) {
    const current = await stageRgba(page)
    if (previous && previous.width === current.width && previous.height === current.height) {
      let differing = 0
      const total = previous.data.length / 4
      for (let i = 0; i < previous.data.length; i += 4) {
        const d = Math.abs((previous.data[i] ?? 0) - (current.data[i] ?? 0)) + Math.abs((previous.data[i + 1] ?? 0) - (current.data[i + 1] ?? 0)) + Math.abs((previous.data[i + 2] ?? 0) - (current.data[i + 2] ?? 0))
        if (d > 48) differing += 1
      }
      if (differing / total < 0.004) {
        stable += 1
        if (stable >= 2) return current
      } else stable = 0
    } else stable = 0
    previous = current
    if (Date.now() - start > timeout) throw new Error('Stage never settled')
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}

function stageForensics(data: Buffer) {
  // Stage background is near-white; only flag saturated unrelated ink.
  let red = 0
  let green = 0
  let blueSemi = 0
  let outline = 0
  let saturatedOther = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    const a = data[i + 3] ?? 0
    if (a < 10) continue
    if (a > 200 && r > 200 && g < 100 && b < 100) red += 1
    else if (a > 200 && g > 200 && r < 100 && b < 100) green += 1
    else if (a >= 30 && b > 150 && r < 140 && g < 170) blueSemi += 1
    else if (a > 50 && Math.abs(r - 37) < 34 && Math.abs(g - 99) < 34 && Math.abs(b - 235) < 34) outline += 1
    else {
      const nearWhite = r > 235 && g > 235 && b > 235
      const nearGray = Math.abs(r - g) < 24 && Math.abs(g - b) < 24
      if (!nearWhite && !nearGray) saturatedOther += 1
    }
  }
  return { red, green, blueSemi, outline, saturatedOther }
}

// 48x32 forensic source: red 8x8, green 8x8, semi-blue 8x8, transparent hole 8x8.
// No white anywhere: any canvas white opaque is spurious by construction.
function forensicPixel(x: number, y: number): [number, number, number, number] {
  const inRed = x >= 4 && x < 12 && y >= 4 && y < 12
  if (inRed) return [255, 0, 0, 255]
  const inGreen = x >= 32 && x < 40 && y >= 4 && y < 12
  if (inGreen) return [0, 210, 0, 255]
  const inSemi = x >= 4 && x < 12 && y >= 20 && y < 28
  if (inSemi) return [0, 30, 255, 128]
  return [0, 0, 0, 0]
}

describe('transparent-selection forensics (real Editor UI)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 200; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('marquee/copy/paste/alt/undo/redo keeps transparent holes transparent; far paste is real stamp only', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      const extPng = buildPng(48, 32, forensicPixel)
      await uploadCostumeFile(page, 'forensic-48x32.png', 'image/png', Buffer.from(extPng))
      const meta0 = await selectedCostumeMeta(page)
      const diag0 = await canvasDiag(page)
      const fore0 = await forensicCanvas(page)
      log('0 baseline upload', { meta: meta0, canvas: diag0, forensic: fore0, srcDims: pngDimensions(extPng) })
      expect(meta0.dataFormat).toBe('png')
      expect((diag0 as any).width).toBe(960)
      expect((diag0 as any).height).toBe(720)
      // Forensic ink: 64 red + 64 green + 64 semi = 192 opaque (alpha>0).
      expect((fore0 as any).opaque).toBe(192)
      expect((fore0 as any).red).toBe(64)
      expect((fore0 as any).green).toBe(64)
      expect((fore0 as any).blueSemi).toBe(64)
      // Spurious channels must already be zero on a fresh artboard.
      expect((fore0 as any).outlineBlue).toBe(0)
      expect((fore0 as any).white).toBe(0)
      expect((fore0 as any).other).toBe(0)
      const trim0 = (diag0 as any).trim
      expect(trim0.width).toBe(36)
      expect(trim0.height).toBe(24)
      // Derive canvas block anchors from the live trim (robust to placement):
      // trim x..x+35 covers source x4..39, trim y..y+23 covers source y4..27.
      const redRect = { x: trim0.x, y: trim0.y, width: 8, height: 8 }
      const holeRect = { x: trim0.x + 28, y: trim0.y + 16, width: 8, height: 8 }
      const cw = (diag0 as any).width as number
      const ch = (diag0 as any).height as number
      const box = await canvasBox(page)
      const stage0 = await waitStageSettled(page)
      const stageFore0 = stageForensics(stage0.data)
      log('0 stage baseline', { stageFore: stageFore0 })
      expect(stageFore0.red).toBeGreaterThan(5)
      expect(stageFore0.green).toBeGreaterThan(5)
      expect(stageFore0.outline).toBe(0)

      // Phase 1: INSIDE rect (red block) marquee -> copy -> paste (+10 stagger
      // lands in the transparent gap, no overlap, no blending).
      await page.getByTestId('bitmap-tool-select').click()
      const r0 = toScreen(box, cw, ch, redRect.x - 2, redRect.y - 2)
      const r1 = toScreen(box, cw, ch, redRect.x + 10, redRect.y + 10)
      await page.mouse.move(r0.x, r0.y)
      await page.mouse.down()
      await page.mouse.move(r1.x, r1.y, { steps: 5 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      const sel1 = await selectionInfo(page)
      const fore1sel = await forensicCanvas(page)
      log('1 inside marquee selection', { sel: sel1, forensic: fore1sel })
      expect(sel1.present).toBe(true)
      if (sel1.present) {
        // Selection rectangle must stay inside the canvas (reported 108% bug).
        expect(sel1.widthPct).toBeLessThanOrEqual(100.5)
        expect(sel1.heightPct).toBeLessThanOrEqual(100.5)
      }
      // Marquee alone must not paint: opaque still baseline, no white/outline.
      expect((fore1sel as any).opaque).toBe(192)
      expect((fore1sel as any).white).toBe(0)
      expect((fore1sel as any).outlineBlue).toBe(0)
      await page.getByTestId('copy-costume-selection').click()
      await page.waitForTimeout(400)
      await page.getByTestId('paste-costume-selection').click()
      await page.waitForTimeout(700)
      const diag1 = await canvasDiag(page)
      const fore1 = await forensicCanvas(page, [trim0, { x: redRect.x + 10, y: redRect.y + 10, width: 8, height: 8 }])
      const sel1after = await selectionInfo(page)
      log('1 after inside paste', { canvas: diag1, forensic: fore1, sel: sel1after })
      expect((diag1 as any).width).toBe(960)
      expect((diag1 as any).height).toBe(720)
      if (sel1after.present) {
        expect(sel1after.widthPct).toBeLessThanOrEqual(100.5)
        expect(sel1after.heightPct).toBeLessThanOrEqual(100.5)
      }
      // Real stamp only: +64 red in the gap, no background fill.
      expect((fore1 as any).red).toBe(128)
      expect((fore1 as any).opaque).toBe(256)
      expect((fore1 as any).white).toBe(0)
      expect((fore1 as any).outlineBlue).toBe(0)
      expect((fore1 as any).other).toBe(0)
      expect((fore1 as any).outOfRangeWhite).toBe(0)
      const stage1 = await waitStageSettled(page)
      const stageFore1 = stageForensics(stage1.data)
      log('1 stage after inside paste', { stageFore: stageFore1 })
      expect(stageFore1.outline).toBe(0)
      expect(stageFore1.red).toBeGreaterThan(5)

      // Undo returns to baseline; Redo replays the real stamp (and only it).
      const md5BeforeUndo = (await selectedCostumeMeta(page)).md5ext!
      await clickToolbarButton(page, 'Undo')
      await page.waitForTimeout(1200)
      const fore1undo = await forensicCanvas(page)
      log('1 undo', { forensic: fore1undo })
      expect((fore1undo as any).opaque).toBe(192)
      expect((fore1undo as any).red).toBe(64)
      expect((fore1undo as any).white).toBe(0)
      await clickToolbarButton(page, 'Redo')
      await waitCanvasDiag(page)
      await page.waitForTimeout(900)
      let fore1redo: unknown = null
      for (let i = 0; i < 30; i += 1) {
        fore1redo = await forensicCanvas(page)
        if ((fore1redo as any).readable && (fore1redo as any).opaque === 256) break
        await page.waitForTimeout(500)
      }
      log('1 redo', { forensic: fore1redo, md5BeforeUndo })
      expect((fore1redo as any).opaque).toBe(256)
      expect((fore1redo as any).white).toBe(0)
      // Back to baseline for the next isolated phase.
      await clickToolbarButton(page, 'Undo')
      await waitCanvasDiag(page)
      await page.waitForTimeout(1200)
      const fore1back = await forensicCanvas(page)
      expect((fore1back as any).opaque).toBe(192)

      // Phase 2: transparent HOLE marquee (8x8 fully transparent) -> selection
      // must clear (no opaque to trim to), copy/paste must not invent ink.
      const h0 = toScreen(box, cw, ch, holeRect.x - 1, holeRect.y - 1)
      const h1 = toScreen(box, cw, ch, holeRect.x + 9, holeRect.y + 9)
      await page.getByTestId('bitmap-tool-select').click()
      await page.mouse.move(h0.x, h0.y)
      await page.mouse.down()
      await page.mouse.move(h1.x, h1.y, { steps: 5 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      const sel2 = await selectionInfo(page)
      const fore2sel = await forensicCanvas(page)
      log('2 hole marquee', { sel: sel2, forensic: fore2sel, holeRect })
      // Fully-transparent drag holds no opaque: selection cleared, canvas kept.
      expect(sel2.present).toBe(false)
      expect((fore2sel as any).opaque).toBe(192)
      expect((fore2sel as any).white).toBe(0)
      expect((fore2sel as any).outlineBlue).toBe(0)
      // Copy with no selection falls back to the trimmed raster (existing ink),
      // it must NOT copy a transparent hole as opaque white.
      await page.getByTestId('copy-costume-selection').click()
      await page.waitForTimeout(400)
      await page.getByTestId('paste-costume-selection').click()
      await page.waitForTimeout(700)
      const fore2paste = await forensicCanvas(page)
      const sel2paste = await selectionInfo(page)
      log('2 hole fallback paste', { forensic: fore2paste, sel: sel2paste })
      // Fallback paste stamps the whole trimmed ink at +10: bounded growth,
      // still zero white/outline. Opaque must stay far below the 174280 report.
      expect((fore2paste as any).white).toBe(0)
      expect((fore2paste as any).outlineBlue).toBe(0)
      expect((fore2paste as any).opaque).toBeLessThan(2000)
      expect((fore2paste as any).opaque).toBeGreaterThan(192)
      if (sel2paste.present) {
        expect(sel2paste.widthPct).toBeLessThanOrEqual(100.5)
      }
      await clickToolbarButton(page, 'Undo')
      await waitCanvasDiag(page)
      await page.waitForTimeout(1200)
      expect(((await forensicCanvas(page)) as any).opaque).toBe(192)

      // Phase 3: IMAGE-OUTSIDE marquee (empty artboard area, fully transparent)
      // -> same no-generation contract as the hole.
      const e0 = toScreen(box, cw, ch, 100, 100)
      const e1 = toScreen(box, cw, ch, 150, 140)
      await page.mouse.move(e0.x, e0.y)
      await page.mouse.down()
      await page.mouse.move(e1.x, e1.y, { steps: 5 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      const sel3 = await selectionInfo(page)
      const fore3 = await forensicCanvas(page)
      log('3 outside-image marquee', { sel: sel3, forensic: fore3 })
      expect(sel3.present).toBe(false)
      expect((fore3 as any).opaque).toBe(192)
      expect((fore3 as any).white).toBe(0)
      expect((fore3 as any).outlineBlue).toBe(0)

      // Phase 4a: TRUE far marquee (no selection at drag start, so the drag is
      // a marquee, never a floating/scale handle drag): start from empty
      // artboard (100,100) to just beyond the surface edge (+30px stays in
      // the 1280px viewport; +400 would leave the viewport and drop the
      // pointerup), then copy/paste. Isolates marquee->paste fill from scaling.
      const box4 = await canvasBox(page)
      // Left-edge canvas points sit under the floating tool toolbar
      // (elementFromPoint at 200,250 hit bitmap-tool-fill), so use central
      // points proven on-canvas in phase 1: clear with a click at (500,400)
      // transparent, then start the far marquee INSIDE the ink with no
      // selection present (true marquee, never a handle drag).
      const clearClick = toScreen(box4, cw, ch, 500, 400)
      await page.mouse.move(clearClick.x, clearClick.y)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(400)
      expect((await selectionInfo(page)).present).toBe(false)
      const f0 = toScreen(box4, cw, ch, redRect.x + 2, redRect.y + 2)
      const farEnd = { x: box4.x + box4.width + 30, y: box4.y + box4.height + 30 }
      await page.mouse.move(f0.x, f0.y)
      await page.mouse.down()
      await page.mouse.move(farEnd.x, farEnd.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      const sel4marquee = await selectionInfo(page)
      const fore4marquee = await forensicCanvas(page)
      log('4a true far marquee state', { sel: sel4marquee, forensic: fore4marquee })
      // Marquee alone never paints (outline is preview-only and restored).
      expect((fore4marquee as any).opaque).toBe(192)
      expect((fore4marquee as any).white).toBe(0)
      expect((fore4marquee as any).outlineBlue).toBe(0)
      // True far marquee from empty must trim to the ink (present, bounded).
      expect(sel4marquee.present).toBe(true)
      if (sel4marquee.present) {
        expect(sel4marquee.widthPct).toBeLessThanOrEqual(100.5)
        expect(sel4marquee.heightPct).toBeLessThanOrEqual(100.5)
      }
      await page.getByTestId('copy-costume-selection').click()
      await page.waitForTimeout(400)
      // Clear again so the second far drag is also a true marquee.
      await page.mouse.move(clearClick.x, clearClick.y)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(300)
      await page.mouse.move(f0.x, f0.y)
      await page.mouse.down()
      await page.mouse.move(farEnd.x, farEnd.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      const sel4far = await selectionInfo(page)
      log('4a second true far marquee', { sel: sel4far })
      if (sel4far.present) {
        expect(sel4far.widthPct).toBeLessThanOrEqual(100.5)
        expect(sel4far.heightPct).toBeLessThanOrEqual(100.5)
      }
      const opaqueBeforePaste = ((await forensicCanvas(page)) as any).opaque as number
      await page.getByTestId('paste-costume-selection').click()
      await page.waitForTimeout(700)
      const diag4 = await waitCanvasDiag(page)
      const fore4 = await forensicCanvas(page)
      const sel4 = await selectionInfo(page)
      log('4a true far paste', { canvas: diag4, forensic: fore4, sel: sel4, opaqueBeforePaste })
      expect((diag4 as any).width).toBe(960)
      expect((diag4 as any).height).toBe(720)
      if (sel4.present) {
        expect(sel4.widthPct).toBeLessThanOrEqual(100.5)
        expect(sel4.heightPct).toBeLessThanOrEqual(100.5)
      }
      // Real-stamp bound: pasting the at most 36x24 trimmed ink adds at most
      // a few hundred opaque pixels, never ~172k of background fill.
      expect((fore4 as any).white).toBe(0)
      expect((fore4 as any).outlineBlue).toBe(0)
      expect((fore4 as any).other).toBe(0)
      expect((fore4 as any).opaque - opaqueBeforePaste).toBeLessThan(2000)
      expect((fore4 as any).opaque).toBeLessThan(5000)
      const stage4 = await waitStageSettled(page)
      const stageFore4 = stageForensics(stage4.data)
      log('4a stage after true far paste', { stageFore: stageFore4 })
      expect(stageFore4.outline).toBe(0)
      expect(stageFore4.saturatedOther).toBeLessThan(2000)
      await clickToolbarButton(page, 'Undo')
      await waitCanvasDiag(page)
      await page.waitForTimeout(1200)
      expect(((await forensicCanvas(page)) as any).opaque).toBe(192)
      await clickToolbarButton(page, 'Redo')
      await waitCanvasDiag(page)
      await page.waitForTimeout(1200)
      const fore4redo = await forensicCanvas(page)
      log('4a redo', { forensic: fore4redo })
      expect((fore4redo as any).white).toBe(0)
      await clickToolbarButton(page, 'Undo')
      await waitCanvasDiag(page)
      await page.waitForTimeout(1200)

      // Phase 4b: handle-hit repro (documents the reported 2400->174280 and
      // width 108% path): starting a "far marquee" INSIDE an existing
      // selection corner hits the scale handle, so the drag SCALES the patch
      // instead of marqueing. The opaque growth is then real scaled ink
      // (white/outline stay 0), not checkerboard/background fill. This step
      // only logs + proves the generation source; it does not assert the
      // healthy marquee bound.
      await page.mouse.move(clearClick.x, clearClick.y)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(300)
      const innerStart = toScreen(box, cw, ch, redRect.x - 2, redRect.y - 2)
      const innerEnd = toScreen(box, cw, ch, redRect.x + 10, redRect.y + 10)
      await page.mouse.move(innerStart.x, innerStart.y)
      await page.mouse.down()
      await page.mouse.move(innerEnd.x, innerEnd.y, { steps: 5 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      const sel4bBase = await selectionInfo(page)
      log('4b handle-hit setup selection', { sel: sel4bBase })
      expect(sel4bBase.present).toBe(true)
      const box4b = await canvasBox(page)
      const cornerStart = toScreen(box4b, cw, ch, redRect.x, redRect.y)
      await page.mouse.move(cornerStart.x, cornerStart.y)
      await page.mouse.down()
      await page.mouse.move(box4b.x + box4b.width + 30, box4b.y + box4b.height + 30, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(600)
      const sel4bScaled = await selectionInfo(page)
      const fore4bScaled = await forensicCanvas(page)
      log('4b corner-drag scale state (reported 108% path)', { sel: sel4bScaled, forensic: fore4bScaled })
      // Discriminant: even when the rect blows past 100% via scaling, the new
      // opaque pixels are forensic ink (scaled), never white checker/fill and
      // never outline-blue. That separates "real generation" from background.
      expect((fore4bScaled as any).white).toBe(0)
      expect((fore4bScaled as any).outlineBlue).toBe(0)
      await clickToolbarButton(page, 'Undo')
      await waitCanvasDiag(page)
      await page.waitForTimeout(1200)
      expect(((await forensicCanvas(page)) as any).opaque).toBe(192)

      // Phase 5: Alt-duplicate drag of the FULL ink (+100,+100, no overlap).
      // A tiny 8x8 selection's scale handles cover its center on screen, so an
      // Alt-drag from its middle hits SCALE (not move). The full 36x24 ink
      // rect keeps its center clear of handles, giving a true duplicate.
      const box5 = await canvasBox(page)
      await page.getByTestId('bitmap-tool-select').click()
      // Select-all trims to the full forensic ink (fallback path, no marquee).
      await page.keyboard.down('ControlOrMeta')
      await page.keyboard.press('a')
      await page.keyboard.up('ControlOrMeta')
      await page.waitForTimeout(500)
      const sel5base = await selectionInfo(page)
      log('5 alt setup (select-all)', { sel: sel5base })
      expect(sel5base.present).toBe(true)
      const trim5 = ((await canvasDiag(page)) as any).trim
      const center5 = toScreen(box5, cw, ch, trim5.x + trim5.width / 2, trim5.y + trim5.height / 2)
      // +100 canvas px in screen space (stays inside the surface).
      const dxScreen = (100 / cw) * box5.width
      const dyScreen = (100 / ch) * box5.height
      await page.keyboard.down('Alt')
      await page.mouse.move(center5.x, center5.y)
      await page.mouse.down()
      await page.mouse.move(center5.x + dxScreen, center5.y + dyScreen, { steps: 8 })
      await page.mouse.up()
      await page.keyboard.up('Alt')
      await page.waitForTimeout(900)
      const fore5 = await forensicCanvas(page)
      const sel5 = await selectionInfo(page)
      log('5 alt-duplicate', { forensic: fore5, sel: sel5 })
      expect((fore5 as any).white).toBe(0)
      expect((fore5 as any).outlineBlue).toBe(0)
      expect((sel5 as any).status as string).toMatch(/duplicat/i)
      // Source kept + one full-ink stamp in transparent space (no overlap).
      expect((fore5 as any).red).toBe(128)
      expect((fore5 as any).green).toBe(128)
      expect((fore5 as any).blueSemi).toBe(128)
      expect((fore5 as any).opaque).toBe(384)
      await clickToolbarButton(page, 'Undo')
      await waitCanvasDiag(page)
      await page.waitForTimeout(1200)
      expect(((await forensicCanvas(page)) as any).opaque).toBe(192)

      // Phase 6: saved-asset RGBA audit (before/after far paste).
      const savedBefore = await exportSb3(page)
      const metaBefore = await selectedCostumeMeta(page)
      const costumeBefore = savedBefore.project.targets.find((t: any) => t.name === metaBefore.targetName)!.costumes[metaBefore.index]!
      const bytesBefore = savedBefore.assets[costumeBefore.md5ext!]!
      const dimsBefore = pngDimensions(bytesBefore)
      const rgbaBefore = decodePng(Buffer.from(bytesBefore))
      const countsBefore = countForensicRgba(rgbaBefore.data)
      const liveTrimBefore = ((await canvasDiag(page)) as any).trim
      log('6 saved before', { dims: dimsBefore, counts: countsBefore, liveTrim: liveTrimBefore, center: { x: metaBefore.rotationCenterX, y: metaBefore.rotationCenterY } })
      // Pre-crop upload baseline: stored verbatim 48x32 (transparent margins
      // intact), live trim tight 36x24. White/outline/other still zero.
      expect(dimsBefore).toEqual({ width: 48, height: 32 })
      expect(countsBefore.white).toBe(0)
      expect(countsBefore.outline).toBe(0)
      expect(countsBefore.other).toBe(0)
      expect(countsBefore.red).toBe(64)
      expect(countsBefore.green).toBe(64)
      expect(countsBefore.blueSemi).toBe(64)
      // Re-do one far paste and audit the saved bytes again.
      const box6 = await canvasBox(page)
      await page.mouse.move(toScreen(box6, cw, ch, 500, 400).x, toScreen(box6, cw, ch, 500, 400).y)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(300)
      const f6 = toScreen(box6, cw, ch, redRect.x + 2, redRect.y + 2)
      const far6 = { x: box6.x + box6.width + 30, y: box6.y + box6.height + 30 }
      await page.getByTestId('bitmap-tool-select').click()
      await page.mouse.move(f6.x, f6.y)
      await page.mouse.down()
      await page.mouse.move(far6.x, far6.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(300)
      await page.getByTestId('copy-costume-selection').click()
      await page.waitForTimeout(300)
      await page.getByTestId('paste-costume-selection').click()
      await page.waitForTimeout(700)
      const metaAfter = await selectedCostumeMeta(page)
      const liveTrimAfter = ((await canvasDiag(page)) as any).trim
      const foreAfter = await forensicCanvas(page)
      log('6 live after repaste', { forensic: foreAfter, liveTrim: liveTrimAfter })
      const savedAfter = await exportSb3(page)
      const costumeAfter = savedAfter.project.targets.find((t: any) => t.name === metaAfter.targetName)!.costumes[metaAfter.index]!
      const bytesAfter = savedAfter.assets[costumeAfter.md5ext!]!
      const dimsAfter = pngDimensions(bytesAfter)
      const rgbaAfter = decodePng(Buffer.from(bytesAfter))
      const countsAfter = countForensicRgba(rgbaAfter.data)
      log('6 saved after', { dims: dimsAfter, counts: countsAfter, liveTrim: liveTrimAfter, center: { x: metaAfter.rotationCenterX, y: metaAfter.rotationCenterY } })
      expect(dimsAfter).toEqual({ width: liveTrimAfter.width, height: liveTrimAfter.height })
      expect(countsAfter.white).toBe(0)
      expect(countsAfter.outline).toBe(0)
      expect(countsAfter.other).toBe(0)
      expect(metaAfter.rotationCenterX).toBe(480 - liveTrimAfter.x)
      expect(metaAfter.rotationCenterY).toBe(360 - liveTrimAfter.y)
      // Saved opaque growth is exactly the real stamp (no fill multiplication).
      const opaqueSavedBefore = countsBefore.red + countsBefore.green + countsBefore.blueSemi
      const opaqueSavedAfter = countsAfter.red + countsAfter.green + countsAfter.blueSemi
      log('6 saved opaque delta', { before: opaqueSavedBefore, after: opaqueSavedAfter })
      expect(opaqueSavedAfter - opaqueSavedBefore).toBeLessThan(2000)
      expect(opaqueSavedAfter).toBeLessThan(5000)
    } finally {
      await context.close()
    }
  }, 240_000)
})
