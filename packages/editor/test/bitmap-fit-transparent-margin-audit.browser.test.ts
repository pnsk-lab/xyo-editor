import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strFromU8, strToU8, zipSync, unzipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'
import { resolvePaperFitZoom } from '../src/features/costumes/paper-viewport-parity'
import { resolveInitialFitViewport } from '../src/features/costumes/costume-viewport'

// Independent audit of the first-visit fit (直近初回fit実装):
// bitmapFitState carries the placed SOURCE-IMAGE rectangle, while the
// reference fits the opaque HIT bounds (getHitBounds(raster)):
//   zoomToFit(isBitmap=true) => bounds = getHitBounds(getRaster()).expand(50)
// then padded x1.5, ratio = 0.5 * max(paddedW/clientW, paddedH/clientH) in
// [0.125, 1], zoom to 0.5/ratio only when ratio < 1, centered on
// bounds.center, else stay at base 0.5 board-centered.
//
// This file is product-code read-only (no src/ edits). It runs the REAL
// Editor on an INDEPENDENT fixed port (4599) plus a REAL Paper.js oracle in
// Chromium, and reports every mismatch as a loud failure (fail隠さず).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-fit-transparent-margin-audit.browser.test.ts
const root = join(import.meta.dir, '..')
const PORT = 4599
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

// --- PNG builders -----------------------------------------------------------

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

type Rgba = [number, number, number, number]

function buildRgbaPng(width: number, height: number, paint: (x: number, y: number) => Rgba): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y)
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

function pngDims(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const md5 = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex')

// Ink layouts (constructed truth, also re-proved by the Paper oracle below).
const INK_A = { x: 10, y: 70, w: 2, h: 2 } // 96x96, off-center bottom-left
const INK_H = { x: 50, y: 10, w: 2, h: 2 } // 64x64, different source size so G/H fits differ
const INK_C = { x: 400, y: 300, w: 2, h: 2 } // 480x360 big-transparent

const pngA = () =>
  buildRgbaPng(96, 96, (x, y) =>
    x >= INK_A.x && x < INK_A.x + INK_A.w && y >= INK_A.y && y < INK_A.y + INK_A.h ? [255, 0, 0, 255] : [0, 0, 0, 0],
  )
const pngEmpty96 = () => buildRgbaPng(96, 96, () => [0, 0, 0, 0])
const pngC = () =>
  buildRgbaPng(480, 360, (x, y) =>
    x >= INK_C.x && x < INK_C.x + INK_C.w && y >= INK_C.y && y < INK_C.y + INK_C.h ? [0, 200, 0, 255] : [0, 0, 0, 0],
  )
const pngD = () => buildRgbaPng(2000, 100, () => [0, 0, 255, 255])
const pngH = () =>
  buildRgbaPng(64, 64, (x, y) =>
    x >= INK_H.x && x < INK_H.x + INK_H.w && y >= INK_H.y && y < INK_H.y + INK_H.h ? [255, 0, 0, 255] : [0, 0, 0, 0],
  )

// --- independent oracle (reference lines, no helper import) -----------------

function oracleFitZoom(bw: number, bh: number, cw: number, ch: number, isBitmap: boolean): number {
  const BASE = 0.5
  const MIN = 0.125
  if (!(bw > 0) || !(bh > 0) || !(cw > 0) || !(ch > 0)) return BASE
  if (![bw, bh, cw, ch].every(Number.isFinite)) return BASE
  const paddedW = (bw + (isBitmap ? 50 : 0)) * 1.5
  const paddedH = (bh + (isBitmap ? 50 : 0)) * 1.5
  const raw = BASE * Math.max(paddedW / cw, paddedH / ch)
  if (!Number.isFinite(raw) || raw <= 0) return BASE
  const ratio = Math.max(MIN, Math.min(1, raw))
  return ratio >= 1 ? BASE : BASE / ratio
}

// --- page helpers (real Editor UI only) -------------------------------------

async function openCostumes(): Promise<void> {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function costumeCount(): Promise<number> {
  return await page.getByTestId(/costume-card-\d+/).count()
}

async function uploadFile(name: string, mimeType: string, buffer: Buffer): Promise<void> {
  const before = await costumeCount()
  await page.getByTestId('costume-file-input').setInputFiles({ name, mimeType, buffer })
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
    before as unknown as undefined,
    { timeout: 30_000 },
  )
}

async function selectCostumeCard(index: number): Promise<void> {
  await page.evaluate((i: number) => {
    const cards = document.querySelectorAll('[data-testid^="costume-card-"]')
    const card = cards[i] as HTMLElement | undefined
    const button = card?.querySelector('button[aria-label^="Select"]') as HTMLButtonElement | undefined
    button?.click()
  }, index as unknown as undefined)
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
  // Verify the selection actually landed (distinguishes a missed click from a
  // stalled fit/load downstream).
  try {
    await page.waitForFunction(
      (want: number) => {
        const snap = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest?.snapshot()
        const target = snap?.project.targets.find((t: any) => (t.id ?? t.name) === snap?.selectedTargetId) ?? snap?.project.targets.find((t: any) => !t.isStage)
        return (target?.currentCostume ?? -1) === want
      },
      index as unknown as undefined,
      { timeout: 5_000 },
    )
  } catch (error) {
    const diag = await page.evaluate(() => {
      const snap = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest?.snapshot()
      const target = snap?.project.targets.find((t: any) => (t.id ?? t.name) === snap?.selectedTargetId)
      return {
        cur: target?.currentCostume, names: target?.costumes.map((c: any) => c.name),
        cards: Array.from(document.querySelectorAll('[data-testid^="costume-card-"]')).map((el) => (el.querySelector('button[aria-label^="Select"]') as HTMLElement | null)?.getAttribute('aria-label')),
      }
    })
    console.log(`FIT_AUDIT SELECT_MISS want=${index} ${JSON.stringify(diag)}`)
    throw error
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
}

async function selectCostumeByName(name: string): Promise<void> {
  // JS click by costume name (robust to card reordering; falls back to index).
  await page.evaluate((want: string) => {
    const cards = Array.from(document.querySelectorAll('[data-testid^="costume-card-"]'))
    const hit = cards.find((card) => (card.querySelector('button[aria-label^="Select"]') as HTMLButtonElement | null)?.getAttribute('aria-label') === `Select ${want}`)
    ;(hit?.querySelector('button[aria-label^="Select"]') as HTMLButtonElement | undefined)?.click()
  }, name as unknown as undefined)
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
  await new Promise((resolve) => setTimeout(resolve, 300))
}

async function workspaceToken(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest: { bitmapWorkspaceToken: () => string } }).__hikkakuEditorTest.bitmapWorkspaceToken())
}

function tokenSerial(token: string): number {
  return Number(/serial=(\d+)/.exec(token)?.[1] ?? -1)
}

/**
 * Environmental remount gate: the dev server HMR-remounts the editor when
 * other agents save files, resetting component-local state (serial restarts
 * at 0, viewport map clears) while the VM keeps assets. Loads only advance
 * the serial, so a backward jump proves a remount: product asserts after it
 * are void. Callers branch on the return value and fail with attribution
 * instead of recording a product verdict.
 */
function remountDetected(serialBefore: number, serialAfter: number): boolean {
  return serialAfter < serialBefore
}

async function waitForViewportSettled(timeout = 12_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const surface =
        (document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null) ??
        (document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement | null)
      if (!surface) return false
      const w = surface.getBoundingClientRect().width
      const key = '__fitAuditSettleProbe'
      const store = window as unknown as Record<string, { last: number; stable: number }>
      const prev = store[key]
      if (!prev || Math.abs(prev.last - w) > 1) {
        store[key] = { last: w, stable: 0 }
        return false
      }
      prev.stable += 1
      return prev.stable >= 3
    },
    null,
    { timeout },
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
}

type FitMeasurement = {
  container: { w: number; h: number; cx: number; cy: number }
  surface: { left: number; top: number; width: number; height: number; cx: number; cy: number }
  canvas: { w: number; h: number }
  label: string
  undoDisabled: boolean | null
  redoDisabled: boolean | null
  mode: 'vector' | 'bitmap'
}

async function measureFit(): Promise<FitMeasurement> {
  // The paint surface can remount across tab switches/resizes (and dev HMR
  // while other agents edit): wait, re-click the costumes tab once, and only
  // then fail loudly with the visible testids for forensics.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.waitForSelector('[data-testid="costume-paint-surface"]', { state: 'visible', timeout: 15_000 })
      break
    } catch (error) {
      if (attempt === 1) {
        const diag = await page.evaluate(() => ({
          tab: (window as unknown as { __hikkakuEditorTest?: { selectedTab: () => string } }).__hikkakuEditorTest?.selectedTab(),
          status: (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status(),
          testids: Array.from(document.querySelectorAll('[data-testid]')).map((e) => (e as HTMLElement).dataset.testid).filter((v) => v && (v.includes('costume') || v.includes('tab') || v.includes('paint'))).slice(0, 20),
        }))
        console.log(`FIT_AUDIT SURFACE_MISSING ${JSON.stringify(diag)}`)
        throw error
      }
      await page.getByTestId('main-tab-costumes').click({ timeout: 10_000 }).catch(() => undefined)
    }
  }
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null) !== null ||
      (document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement | null) !== null,
    null,
    { timeout: 15_000 },
  )
  return await page.evaluate(() => {
    const container = document.querySelector('[data-testid="costume-paint-surface"]')!
    const c = container.getBoundingClientRect()
    const vectorSurface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')
    const bitmapCanvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    const surfaceEl = (vectorSurface ?? bitmapCanvas)! as HTMLElement
    const r = surfaceEl.getBoundingClientRect()
    return {
      container: { w: c.width, h: c.height, cx: c.left + c.width / 2, cy: c.top + c.height / 2 },
      surface: { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 },
      canvas: { w: bitmapCanvas?.width ?? 0, h: bitmapCanvas?.height ?? 0 },
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      undoDisabled: document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled ?? null,
      redoDisabled: document.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.disabled ?? null,
      mode: vectorSurface ? ('vector' as const) : ('bitmap' as const),
    }
  })
}

/**
 * Wait until the live surface width converges to the predicted fit width.
 * Unlike settle-polling (which can return during the pre-fit reset window),
 * this times out when a pending fit is DROPPED, turning a dropped fit into a
 * loud failure instead of a premature reset read.
 */
async function waitForSurfaceWidth(predictedWidth: number, tolerance = 60, timeout = 15_000): Promise<FitMeasurement> {
  await page.waitForFunction(
    (want: number) => {
      const surface =
        (document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null) ??
        (document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement | null)
      if (!surface) return false
      return Math.abs(surface.getBoundingClientRect().width - want) < 60
    },
    predictedWidth as unknown as undefined,
    { timeout },
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  const m = await measureFit()
  expect(Math.abs(m.surface.width - predictedWidth)).toBeLessThan(tolerance)
  return m
}

async function containerSize(): Promise<{ w: number; h: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.waitForSelector('[data-testid="costume-paint-surface"]', { state: 'visible', timeout: 15_000 })
      break
    } catch (error) {
      if (attempt === 1) throw error
      await page.getByTestId('main-tab-costumes').click({ timeout: 10_000 }).catch(() => undefined)
    }
  }
  return await page.evaluate(() => {
    const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
    return { w: c.width, h: c.height }
  })
}

function predictViewport(
  boundsSurface: { x: number; y: number; width: number; height: number } | null,
  surfaceW: number,
  surfaceH: number,
  containerW: number,
  containerH: number,
  density: number | undefined,
  isBitmap: boolean,
) {
  return resolveInitialFitViewport({
    contentBoundsSurface: boundsSurface,
    surfaceSize: { width: surfaceW, height: surfaceH },
    containerSize: { width: containerW, height: containerH },
    paperToCssDensity: density,
    isBitmap,
  })
}

function surfaceWidthFor(scale: number, surfaceW: number): number {
  return surfaceW * scale
}

function contentScreen(
  m: FitMeasurement,
  surfaceW: number,
  surfaceH: number,
  ccx: number,
  ccy: number,
): { x: number; y: number } {
  return {
    x: m.surface.left + (ccx / surfaceW) * m.surface.width,
    y: m.surface.top + (ccy / surfaceH) * m.surface.height,
  }
}

function logReport(tag: string, value: unknown): void {
  console.log(`FIT_AUDIT ${tag} ${JSON.stringify(value)}`)
}

function sb3Costume(name: string, bytes: Uint8Array, ext: string, extra: Record<string, unknown>) {
  const hash = md5(bytes)
  return { entry: { name, assetId: hash, md5ext: `${hash}.${ext}`, dataFormat: ext, ...extra }, file: `${hash}.${ext}` as const, bytes }
}

function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function importSb3(bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'fit-audit.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest?.snapshot()
      return snap?.project.targets.some((t: any) => t.costumes.some((c: any) => c.name === want)) ?? false
    },
    expectName as unknown as undefined,
    { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await new Promise((resolve) => setTimeout(resolve, 800))
}

async function exportSb3(): Promise<{ project: any; assets: Record<string, Uint8Array> }> {
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

async function selectedCostumeMeta(): Promise<{ targetName: string; index: number; name: string; dataFormat: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> {
  return await page.evaluate(() => {
    const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => any } }).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId) ?? snap.project.targets.find((t: any) => !t.isStage) ?? snap.project.targets[0]!
    const index = target.currentCostume ?? 0
    const costume = target.costumes[index]!
    return { targetName: target.name, index, name: costume.name, dataFormat: costume.dataFormat ?? '', bitmapResolution: costume.bitmapResolution, rotationCenterX: costume.rotationCenterX, rotationCenterY: costume.rotationCenterY, md5ext: costume.md5ext }
  })
}

describe('bitmap first-fit transparent-margin audit (independent port 4599)', () => {
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
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('paper oracle: expand(50)/x1.5 semantics, raster.bounds vs hit bounds, empty, vector baseline', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.addScriptTag({ path: join(root, 'node_modules/paper/dist/paper-full.js') })
    const dataA = `data:image/png;base64,${Buffer.from(pngA()).toString('base64')}`
    const dataEmpty = `data:image/png;base64,${Buffer.from(pngEmpty96()).toString('base64')}`
    const result = await page.evaluate(async ({ srcA, srcEmpty }: { srcA: string; srcEmpty: string }) => {
      const paper = (window as unknown as { paper: any }).paper
      // expand(50): +50 total per extent (+25/side).
      const rect = new paper.Rectangle(10, 20, 100, 80)
      const expanded = rect.expand(50)
      // Authoritative PNG-content scan via a plain 2D canvas (no Paper
      // involvement): proves the constructed bytes hold only the 2x2 ink.
      // The walk mirrors the reference row/column-blank algorithm, incl. the
      // empty-raster centered zero-area fallback.
      const decode = (src: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('img decode failed'))
          img.src = src
        })
      const scanImage = (img: HTMLImageElement): { x: number; y: number; width: number; height: number } => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(img, 0, 0)
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const w = image.width
        const h = image.height
        const rowBlank = (y: number): boolean => {
          for (let x = 0; x < w; x += 1) if (image.data[(y * w + x) * 4 + 3] !== 0) return false
          return true
        }
        const colBlank = (x: number, top: number, bottom: number): boolean => {
          for (let y = top; y < bottom; y += 1) if (image.data[(y * w + x) * 4 + 3] !== 0) return false
          return true
        }
        let top = 0
        let bottom = h
        let left = 0
        let right = w
        while (top < bottom && rowBlank(top)) top += 1
        while (bottom - 1 > top && rowBlank(bottom - 1)) bottom -= 1
        while (left < right && colBlank(left, top, bottom)) left += 1
        while (right - 1 > left && colBlank(right - 1, top, bottom)) right -= 1
        if (top === bottom) top = bottom = h / 2
        if (left === right) left = right = w / 2
        return { x: left, y: top, width: right - left, height: bottom - top }
      }
      const imgA = await decode(srcA)
      const hitImageA = scanImage(imgA)
      const imgEmpty = await decode(srcEmpty)
      const hitImageEmpty = scanImage(imgEmpty)
      // Real Paper placement: raster at the Editor's origin (artCenter -
      // rotationCenter, upload center = image middle => origin (432,312)).
      // raster.bounds must equal the FULL source rect (what bitmapFitState
      // carries), NOT the opaque hit bounds.
      const loadRasterBounds = (src: string): Promise<{ x: number; y: number; w: number; h: number }> =>
        new Promise((resolve, reject) => {
          const scope = new paper.PaperScope()
          const canvas = document.createElement('canvas')
          canvas.width = 960
          canvas.height = 720
          scope.setup(canvas)
          const raster = new scope.Raster({ source: src, position: new scope.Point(480, 360) })
          raster.onLoad = () => resolve({ x: raster.bounds.x, y: raster.bounds.y, w: raster.bounds.width, h: raster.bounds.height })
          raster.onError = () => reject(new Error('raster load failed'))
          setTimeout(() => reject(new Error('raster load timeout')), 15_000)
        })
      const rasterBoundsA = await loadRasterBounds(srcA)
      const rasterBoundsEmpty = await loadRasterBounds(srcEmpty)
      // Placed hit bounds = image hit + origin offset.
      const hitA = { x: hitImageA.x + 432, y: hitImageA.y + 312, width: hitImageA.width, height: hitImageA.height }
      const hitEmpty = { x: hitImageEmpty.x + 432, y: hitImageEmpty.y + 312, width: hitImageEmpty.width, height: hitImageEmpty.height }
      return {
        expand: { x: expanded.x, y: expanded.y, w: expanded.width, h: expanded.height },
        rasterBoundsA,
        hitA,
        rasterBoundsEmpty,
        hitEmpty,
      }
    }, { srcA: dataA, srcEmpty: dataEmpty } as unknown as undefined)
    const r = result as {
      expand: { x: number; y: number; w: number; h: number }
      rasterBoundsA: { x: number; y: number; w: number; h: number }
      hitA: { x: number; y: number; width: number; height: number }
      rasterBoundsEmpty: { x: number; y: number; w: number; h: number }
      hitEmpty: { x: number; y: number; width: number; height: number }
    }
    logReport('ORACLE_EXPAND', r.expand)
    logReport('ORACLE_RASTER_VS_HIT', { rasterBoundsA: r.rasterBoundsA, hitA: r.hitA, hitEmpty: r.hitEmpty })
    // 1.5x buffer basis: expand(50) adds +50 TOTAL per extent.
    expect(r.expand.w).toBeCloseTo(150, 10)
    expect(r.expand.h).toBeCloseTo(130, 10)
    expect(r.expand.x).toBeCloseTo(-15, 10)
    expect(r.expand.y).toBeCloseTo(-5, 10)
    // raster.bounds is the FULL source rect (96x96 at the placed origin)...
    expect(r.rasterBoundsA.w).toBeCloseTo(96, 10)
    expect(r.rasterBoundsA.h).toBeCloseTo(96, 10)
    expect(r.rasterBoundsA.x).toBeCloseTo(432, 10)
    expect(r.rasterBoundsA.y).toBeCloseTo(312, 10)
    // ...while the opaque hit bounds are the 2x2 ink at canvas (442,382).
    expect(r.hitA.width).toBeCloseTo(2, 10)
    expect(r.hitA.height).toBeCloseTo(2, 10)
    expect(r.hitA.x).toBeCloseTo(442, 10)
    expect(r.hitA.y).toBeCloseTo(382, 10)
    // Empty raster: zero-area centered fallback (no recenter, base zoom).
    expect(r.hitEmpty.width).toBeCloseTo(0, 10)
    expect(r.hitEmpty.height).toBeCloseTo(0, 10)
    // Helper-vs-independent-oracle agreement on the discriminating cases,
    // at two viewport sizes (buffer x1.5, ratio clamp, vector has no buffer).
    for (const [cw, ch] of [[700, 500], [500, 400]] as Array<[number, number]>) {
      expect(resolvePaperFitZoom({ width: 96, height: 96 }, { width: cw, height: ch }, true)).toBeCloseTo(oracleFitZoom(96, 96, cw, ch, true), 12)
      expect(resolvePaperFitZoom({ width: 2, height: 2 }, { width: cw, height: ch }, true)).toBeCloseTo(oracleFitZoom(2, 2, cw, ch, true), 12)
      expect(resolvePaperFitZoom({ width: 100, height: 100 }, { width: cw, height: ch }, false)).toBeCloseTo(oracleFitZoom(100, 100, cw, ch, false), 12)
      // 1.5x buffer reconfirmation spots.
      expect(oracleFitZoom(100, 100, 480, 360, false)).toBeCloseTo(2.4, 10)
      expect(oracleFitZoom(100, 100, 480, 360, true)).toBeCloseTo(1.6, 10)
      expect(oracleFitZoom(10, 10, 480, 360, true)).toBeCloseTo(4, 10)
      expect(oracleFitZoom(0, 10, 480, 360, false)).toBeCloseTo(0.5, 10)
    }
    // The distinction matters: source-rect fit vs true-hit fit differ hugely.
    const srcZoom = oracleFitZoom(96, 96, 700, 500, true)
    const hitZoom = oracleFitZoom(2, 2, 700, 500, true)
    logReport('ORACLE_ZOOM_GAP', { srcZoom, hitZoom })
    expect(Math.abs(srcZoom - hitZoom)).toBeGreaterThan(1)
    expect(hitZoom).toBeCloseTo(4, 10)
  }, 120_000)

  it('editor upload: 96x96 transparent-margin PNG fits the 2x2 ink (opaque hit bounds)', async () => {
    await openCostumes()
    const beforeCount = await costumeCount()
    const preContainer = await containerSize()
    // F1: Scratch `getHitBounds` fits the opaque 2x2 ink at canvas
    // (442,382), density 1.0 (placed origin (432,312) + ink (10,70)).
    const preTruth = predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, preContainer.w, preContainer.h, 1.0, true)
    await uploadFile('audit-ink-96.png', 'image/png', Buffer.from(pngA()))
    await selectCostumeCard(beforeCount)
    const m = await waitForSurfaceWidth(surfaceWidthFor(preTruth.viewport!.scale, 960))
    logReport('DOM_A', m)
    expect(m.mode).toBe('bitmap')
    expect(m.canvas.w).toBe(960)
    expect(m.canvas.h).toBe(720)
    expect(m.undoDisabled).toBe(true)
    expect(m.redoDisabled).toBe(true)
    // Source rect (432,312,96,96) vs Scratch-truth ink (442,382,2,2).
    const src = predictViewport({ x: 432, y: 312, width: 96, height: 96 }, 960, 720, m.container.w, m.container.h, 1.0, true)
    const truth = predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, m.container.w, m.container.h, 1.0, true)
    logReport('HYP_A', { src, truth })
    expect(src.viewport).not.toBeNull()
    expect(truth.viewport).not.toBeNull()
    expect(src.paperZoom).toBeLessThan((truth.paperZoom ?? 0.5) - 1)
    expect(truth.paperZoom).toBeCloseTo(4, 10)
    expect(truth.fitted).toBe(true)
    // F1: DOM fits the ink (max zoom 4) centered on the ink center.
    const truthWidth = surfaceWidthFor(truth.viewport!.scale, 960)
    const truthScreen = contentScreen(m, 960, 720, 443, 383)
    const truthOff = Math.hypot(truthScreen.x - m.container.cx, truthScreen.y - m.container.cy)
    logReport('TRUTH_GAP_A', { truthWidth, domWidth: m.surface.width, truthOff })
    expect(Math.abs(m.surface.width - truthWidth)).toBeLessThan(2)
    expect(truthOff).toBeLessThan(2)
  }, 180_000)

  it('editor upload: fully transparent 96x96 stays at base reset (empty, no ink)', async () => {
    const before = await costumeCount()
    // F1: zero opaque pixels => `null` bounds => base 0.5 board-centered
    // (960 canvas * 0.5 = 480 wide, 100%).
    await uploadFile('audit-empty-96.png', 'image/png', Buffer.from(pngEmpty96()))
    await selectCostumeCard(before)
    const m = await waitForSurfaceWidth(480)
    logReport('DOM_EMPTY', m)
    expect(m.mode).toBe('bitmap')
    expect(m.undoDisabled).toBe(true)
    expect(Math.abs(m.surface.width - 480)).toBeLessThan(2)
    expect(m.label).toContain('100%')
    expect(Math.hypot(m.surface.cx - m.container.cx, m.surface.cy - m.container.cy)).toBeLessThan(2)
  }, 180_000)

  it('editor upload: 480x360 big-transparent + 2x2 ink fits the ink', async () => {
    const before = await costumeCount()
    const preContainer = await containerSize()
    // F1: 480x360 upload at res2 places at origin (240,180) on the 960x720
    // surface; opaque ink (400,300 in source) lands at canvas (640,480,2,2).
    // Size-only prediction is origin-independent; center uses (641,481).
    const preTruth = predictViewport({ x: 640, y: 480, width: 2, height: 2 }, 960, 720, preContainer.w, preContainer.h, 1.0, true)
    await uploadFile('audit-big-transparent.png', 'image/png', Buffer.from(pngC()))
    await selectCostumeCard(before)
    const m = await waitForSurfaceWidth(surfaceWidthFor(preTruth.viewport!.scale, 960))
    logReport('DOM_C', m)
    expect(m.mode).toBe('bitmap')
    expect(m.undoDisabled).toBe(true)
    // Source rect (240,180,480,360) vs truth ink (640,480,2,2).
    const src = predictViewport({ x: 240, y: 180, width: 480, height: 360 }, 960, 720, m.container.w, m.container.h, 1.0, true)
    const truth = predictViewport({ x: 640, y: 480, width: 2, height: 2 }, 960, 720, m.container.w, m.container.h, 1.0, true)
    logReport('HYP_C', { src, truth })
    expect(src.paperZoom).toBeLessThan((truth.paperZoom ?? 0.5) - 0.5)
    expect(truth.paperZoom).toBeCloseTo(4, 10)
    const truthWidth = surfaceWidthFor(truth.viewport!.scale, 960)
    const truthScreen = contentScreen(m, 960, 720, 641, 481)
    logReport('TRUTH_GAP_C', { truthWidth, domWidth: m.surface.width })
    expect(Math.abs(m.surface.width - truthWidth)).toBeLessThan(2)
    expect(Math.hypot(truthScreen.x - m.container.cx, truthScreen.y - m.container.cy)).toBeLessThan(2)
  }, 180_000)

  it('editor upload: 2000x100 large union stays at base without recentering', async () => {
    const before = await costumeCount()
    await uploadFile('audit-large-2000.png', 'image/png', Buffer.from(pngD()))
    await selectCostumeCard(before)
    const m = await waitForSurfaceWidth(1000)
    logReport('DOM_D', m)
    expect(m.mode).toBe('bitmap')
    expect(m.canvas.w).toBe(2000)
    expect(m.canvas.h).toBe(720)
    expect(m.undoDisabled).toBe(true)
    // Fills-or-exceeds => base 0.5 board-centered, surface 2000*0.5 wide.
    expect(Math.abs(m.surface.width - 1000)).toBeLessThan(2)
    expect(m.label).toContain('100%')
    expect(Math.hypot(m.surface.cx - m.container.cx, m.surface.cy - m.container.cy)).toBeLessThan(2)
  }, 180_000)

  it('race R1: rapid switch must not cross-apply, must not lose the fit', async () => {
    // F1: G (96x96 ink at canvas 442,382) and H (64x64 ink at canvas
    // 498,338) are both 2x2 ink => same fit scale (max 4, 3840 wide). Widths
    // cannot distinguish cross-apply; ink centers do (centers ~285px apart in
    // viewport space).
    const countBefore = await costumeCount()
    await uploadFile('audit-race-g.png', 'image/png', Buffer.from(pngA()))
    await uploadFile('audit-race-h.png', 'image/png', Buffer.from(pngH()))
    const idxG = countBefore
    const idxH = countBefore + 1
    await selectCostumeCard(idxG)
    await selectCostumeCard(idxH)
    const settledContainer = await containerSize()
    const hFit = predictViewport({ x: 498, y: 338, width: 2, height: 2 }, 960, 720, settledContainer.w, settledContainer.h, 1.0, true)
    const gFit = predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, settledContainer.w, settledContainer.h, 1.0, true)
    const hFitWidth = surfaceWidthFor(hFit.viewport!.scale, 960)
    const gFitWidth = surfaceWidthFor(gFit.viewport!.scale, 960)
    logReport('RACE_PREDICT', { hFitWidth, gFitWidth, hFit, gFit })
    expect(hFit.paperZoom).toBeCloseTo(4, 10)
    expect(gFit.paperZoom).toBeCloseTo(4, 10)
    expect(Math.hypot(hFit.viewport!.x - gFit.viewport!.x, hFit.viewport!.y - gFit.viewport!.y)).toBeGreaterThan(50)
    // R1: rapid G->H. H's load settles (token: owner=H, pending=none) but a
    // transient post-tick drop loses H's first-fit with no retry: H stays at
    // the default reset until an unrelated remount reruns the effect.
    await page.waitForFunction(
      () => (window as unknown as { __hikkakuEditorTest: { bitmapWorkspaceToken: () => string } }).__hikkakuEditorTest.bitmapWorkspaceToken().includes('pending=none'),
      null,
      { timeout: 20_000 },
    )
    const serialBeforeSleep = tokenSerial(await workspaceToken())
    await new Promise((resolve) => setTimeout(resolve, 6000))
    const tokenR1 = await workspaceToken()
    const hR1a = await measureFit()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const hR1b = await measureFit()
    logReport('RACE_R1', { token: tokenR1, w1: hR1a.surface.width, w2: hR1b.surface.width, label: hR1b.label, hFitWidth, gFitWidth })
    if (remountDetected(serialBeforeSleep, tokenSerial(tokenR1))) {
      expect(`REMOUNT_DETECTED serial ${serialBeforeSleep} -> ${tokenSerial(tokenR1)} (dev HMR during R1; rerun to confirm)`).toBe('no remount during R1')
      return
    }
    expect(tokenR1).toContain('pending=none')
    // H's own load settled (owner index = H), so a missing fit is a lost fit,
    // not a slow load.
    expect(tokenR1).toContain(`:${idxH}:`)
    // Stable (fit would land <2s after settle if it were going to).
    expect(Math.abs(hR1b.surface.width - hR1a.surface.width)).toBeLessThan(1)
    // No cross-apply: H centers its own ink (499,339), not G's (443,383).
    const hOwnScreen = contentScreen(hR1b, 960, 720, 499, 339)
    const hCrossScreen = contentScreen(hR1b, 960, 720, 443, 383)
    logReport('RACE_R1_CENTER', { ownOff: Math.hypot(hOwnScreen.x - hR1b.container.cx, hOwnScreen.y - hR1b.container.cy), crossOff: Math.hypot(hCrossScreen.x - hR1b.container.cx, hCrossScreen.y - hR1b.container.cy) })
    expect(Math.hypot(hOwnScreen.x - hR1b.container.cx, hOwnScreen.y - hR1b.container.cy)).toBeLessThan(10)
    expect(Math.hypot(hCrossScreen.x - hR1b.container.cx, hCrossScreen.y - hR1b.container.cy)).toBeGreaterThan(50)
    // Fit must not be lost: H converges to its own ink fit.
    expect(Math.abs(hR1b.surface.width - hFitWidth)).toBeLessThan(60)
  }, 240_000)

  it('race R2 + user ops: settled selections fit; pre-fit zoom/undo/redo/wheel preserve the viewport', async () => {
    // F2 fixed: rapid-switch reset-saves no longer poison keys (only settled
    // user/fit viewports are saved), so G/H revisit cleanly; R2 still uses
    // FRESH costumes here to prove settled solo loads are healthy.
    const c0 = await costumeCount()
    await uploadFile('audit-settle-i.png', 'image/png', Buffer.from(pngA()))
    await selectCostumeCard(c0)
    const contI = await containerSize()
    const iFit = predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, contI.w, contI.h, 1.0, true)
    const iFitWidth = surfaceWidthFor(iFit.viewport!.scale, 960)
    const mI = await waitForSurfaceWidth(iFitWidth)
    logReport('RACE_R2_I', { width: mI.surface.width })
    expect(Math.abs(mI.surface.width - iFitWidth)).toBeLessThan(60)
    // F1: ink-centered (443,383), not source-centered (surface center).
    const iInkScreen = contentScreen(mI, 960, 720, 443, 383)
    expect(Math.hypot(iInkScreen.x - mI.container.cx, iInkScreen.y - mI.container.cy)).toBeLessThan(10)
    expect(Math.hypot(mI.surface.cx - mI.container.cx, mI.surface.cy - mI.container.cy)).toBeGreaterThan(50)
    const c1 = await costumeCount()
    await uploadFile('audit-settle-j.png', 'image/png', Buffer.from(pngH()))
    await selectCostumeCard(c1)
    const contJ = await containerSize()
    const jFit = predictViewport({ x: 498, y: 338, width: 2, height: 2 }, 960, 720, contJ.w, contJ.h, 1.0, true)
    const jFitWidth = surfaceWidthFor(jFit.viewport!.scale, 960)
    const mJ = await waitForSurfaceWidth(jFitWidth)
    logReport('RACE_R2_J', { width: mJ.surface.width })
    expect(Math.abs(mJ.surface.width - jFitWidth)).toBeLessThan(60)
    const jInkScreen = contentScreen(mJ, 960, 720, 499, 339)
    expect(Math.hypot(jInkScreen.x - mJ.container.cx, jInkScreen.y - mJ.container.cy)).toBeLessThan(10)
    expect(Math.hypot(mJ.surface.cx - mJ.container.cx, mJ.surface.cy - mJ.container.cy)).toBeGreaterThan(50)
    // Pre-fit user zoom wins: fresh costume, zoom before the async fit lands.
    // A single step stays clear of the UI ceiling (ink fits start at scale
    // 4, so two +0.5 steps would pin at 5.0 and hide the wheel delta below).
    const countPre = await costumeCount()
    await uploadFile('audit-prezoom.png', 'image/png', Buffer.from(pngA()))
    await selectCostumeCard(countPre)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const clicked = await measureFit()
    await waitForViewportSettled()
    const settled = await measureFit()
    logReport('PREZOOM', { clickedWidth: clicked.surface.width, settledWidth: settled.surface.width })
    expect(clicked.undoDisabled).toBe(true)
    // No async fit may overwrite the user's zoom afterwards.
    expect(Math.abs(settled.surface.width - clicked.surface.width)).toBeLessThan(1)
    expect(Math.hypot(settled.surface.cx - clicked.surface.cx, settled.surface.cy - clicked.surface.cy)).toBeLessThan(1)
    // Undo/Redo are viewport-inert: disabled buttons change nothing.
    expect(settled.undoDisabled).toBe(true)
    expect(settled.redoDisabled).toBe(true)
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.click()
      document.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.click()
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const afterHistory = await measureFit()
    expect(Math.abs(afterHistory.surface.width - settled.surface.width)).toBeLessThan(1)
    expect(Math.hypot(afterHistory.surface.cx - settled.surface.cx, afterHistory.surface.cy - settled.surface.cy)).toBeLessThan(1)
    // Wheel user-zoom applies and then stays (no trailing fit rewrite).
    // F1: prezoom lands at the max scale (5), so zoom OUT to stay off the
    // ceiling (zooming in at max is a no-op and would prove nothing).
    await page.evaluate(() => {
      const node = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = node.getBoundingClientRect()
      node.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, deltaMode: 0, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }),
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const wheeled = await measureFit()
    await new Promise((resolve) => setTimeout(resolve, 800))
    const wheeledLater = await measureFit()
    logReport('WHEEL', { w0: settled.surface.width, w1: wheeled.surface.width, w2: wheeledLater.surface.width })
    expect(Math.abs(wheeled.surface.width - settled.surface.width)).toBeGreaterThan(1)
    expect(Math.abs(wheeledLater.surface.width - wheeled.surface.width)).toBeLessThan(1)
    expect(wheeledLater.undoDisabled).toBe(true)
  }, 240_000)

  it('F2 revisit: R1 costumes still converge to their own fits on revisit', async () => {
    // F2 regression: the rapid R1 round-trip used to save the pre-fit reset
    // as an existing value, so revisits never ran their first-fit again.
    // Only settled user/fit viewports are saved now: revisiting G/H lands
    // each costume's own ink fit (LOUD on timeout: a poisoned reset stays at
    // 480 and never reaches the fit width).
    await selectCostumeByName('audit-race-g')
    const contG = await containerSize()
    const gFitWidth = surfaceWidthFor(predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, contG.w, contG.h, 1.0, true).viewport!.scale, 960)
    const mG = await waitForSurfaceWidth(gFitWidth)
    logReport('REVISIT_G', { width: mG.surface.width })
    expect(Math.abs(mG.surface.width - gFitWidth)).toBeLessThan(60)
    const gInkScreen = contentScreen(mG, 960, 720, 443, 383)
    expect(Math.hypot(gInkScreen.x - mG.container.cx, gInkScreen.y - mG.container.cy)).toBeLessThan(10)
    await selectCostumeByName('audit-race-h')
    const contH = await containerSize()
    const hFitWidth = surfaceWidthFor(predictViewport({ x: 498, y: 338, width: 2, height: 2 }, 960, 720, contH.w, contH.h, 1.0, true).viewport!.scale, 960)
    const mH = await waitForSurfaceWidth(hFitWidth)
    logReport('REVISIT_H', { width: mH.surface.width })
    expect(Math.abs(mH.surface.width - hFitWidth)).toBeLessThan(60)
    const hInkScreen = contentScreen(mH, 960, 720, 499, 339)
    expect(Math.hypot(hInkScreen.x - mH.container.cx, hInkScreen.y - mH.container.cy)).toBeLessThan(10)
  }, 240_000)

  it('saved bytes: fits are viewport-only (asset dims + centers untouched)', async () => {
    const saved = await exportSb3()
    const findCostumes = (name: string): Array<{ name: string; dataFormat?: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> => {
      const out: Array<{ name: string; dataFormat?: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> = []
      for (const t of saved.project.targets as Array<{ costumes: Array<{ name: string; dataFormat?: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> }>) {
        for (const c of t.costumes) if (c.name.includes('audit-')) out.push(c)
      }
      return out
    }
    const costumes = findCostumes('audit-')
    logReport('SAVED_COSTUMES', costumes.map((c) => ({ name: c.name, res: c.bitmapResolution, rc: [c.rotationCenterX, c.rotationCenterY], md5: c.md5ext })))
    for (const want of ['audit-ink-96', 'audit-empty-96', 'audit-big-transparent', 'audit-large-2000', 'audit-race-g', 'audit-race-h', 'audit-settle-i', 'audit-settle-j', 'audit-prezoom']) {
      expect(costumes.some((c) => c.name === want), `missing saved costume ${want}`).toBe(true)
    }
    for (const c of costumes) {
      const bytes = saved.assets[c.md5ext!]
      expect(bytes).toBeDefined()
      const dims = pngDims(bytes!)
      if (c.name.includes('big-transparent')) {
        expect(dims.width).toBe(480)
        expect(dims.height).toBe(360)
      } else if (c.name.includes('large-2000')) {
        expect(dims.width).toBe(2000)
        expect(dims.height).toBe(100)
      } else if (c.name.includes('race-h') || c.name.includes('settle-j')) {
        expect(dims.width).toBe(64)
        expect(dims.height).toBe(64)
      } else {
        expect(dims.width).toBe(96)
        expect(dims.height).toBe(96)
      }
      // Upload intake keeps resolution 2 with the image-middle center.
      expect(c.bitmapResolution).toBe(2)
    }
  }, 180_000)

  it('second viewport size: fit recomputes for fresh keys, preserved keys keep scale (no auto-refit)', async () => {
    // Preservation: settle a KNOWN ink fit first (audit-ink-96, 2x2 ink at
    // 442,382), then resize and reselect: the saved per-costume scale must
    // win, with no auto-refit to the new container.
    await selectCostumeByName('audit-ink-96')
    const settledA = await measureFit()
    const truthA = predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, settledA.container.w, settledA.container.h, 1.0, true)
    expect(Math.abs(settledA.surface.width - surfaceWidthFor(truthA.viewport!.scale, 960))).toBeLessThan(2)
    const w0 = settledA.surface.width
    await page.setViewportSize({ width: 1024, height: 700 })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const afterResize = await measureFit()
    logReport('RESIZE_KEEP', { w0, w1: afterResize.surface.width })
    expect(Math.abs(afterResize.surface.width - w0)).toBeLessThan(1)
    expect(afterResize.undoDisabled).toBe(true)
    // Fresh fit at the small container follows the small container (2x2 ink
    // maxes to zoom 4 at any container; width + ink-center both checked).
    const before = await costumeCount()
    const preContainerSmall = await containerSize()
    const preSmallTruth = predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, preContainerSmall.w, preContainerSmall.h, 1.0, true)
    await uploadFile('audit-small-vp.png', 'image/png', Buffer.from(pngA()))
    await selectCostumeCard(before)
    const m = await waitForSurfaceWidth(surfaceWidthFor(preSmallTruth.viewport!.scale, 960))
    logReport('DOM_SMALL_VP', { container: m.container, surfaceWidth: m.surface.width, label: m.label })
    const truth = predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, m.container.w, m.container.h, 1.0, true)
    expect(Math.abs(m.surface.width - surfaceWidthFor(truth.viewport!.scale, 960))).toBeLessThan(2)
    const smallInkScreen = contentScreen(m, 960, 720, 443, 383)
    expect(Math.hypot(smallInkScreen.x - m.container.cx, smallInkScreen.y - m.container.cy)).toBeLessThan(5)
    expect(m.label).toContain(`${Math.round((truth.viewport!.scale / 0.5) * 100)}%`)
    await page.setViewportSize({ width: 1280, height: 800 })
  }, 240_000)

  it('sb3 import: offcenter rotationCenter fits the ink', async () => {
    const inkE = buildRgbaPng(96, 96, (x, y) =>
      x >= INK_A.x && x < INK_A.x + INK_A.w && y >= INK_A.y && y < INK_A.y + INK_A.h ? [255, 0, 0, 255] : [0, 0, 0, 0],
    )
    const res1Png = buildRgbaPng(480, 360, (x, y) => (x < 240 && y < 180 ? [255, 0, 0, 255] : [0, 0, 0, 0]))
    const stagePng = buildRgbaPng(480, 360, (x, y) =>
      x >= INK_C.x && x < INK_C.x + INK_C.w && y >= INK_C.y && y < INK_C.y + INK_C.h ? [0, 0, 255, 255] : [0, 0, 0, 0],
    )
    const largePng = pngD()
    const cE = sb3Costume('audit-offcenter', inkE, 'png', { bitmapResolution: 2, rotationCenterX: 10, rotationCenterY: 10 })
    const cF = sb3Costume('audit-res1', res1Png, 'png', { bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 })
    const cD = sb3Costume('audit-large2', largePng, 'png', { bitmapResolution: 2, rotationCenterX: 1000, rotationCenterY: 50 })
    // F3 independent fixture: same bytes as D (shared asset file) at index 3.
    // Upload-phase index 3 (audit-big-transparent) settles to a scale-4 ink
    // fit, while this 2000-wide union must start at the base 1000: slot-only
    // keys inherit 2000*4 = 8000 (must fail before the fix), scoped keys fit
    // fresh (must pass after). D2 cannot discriminate (both sides are base).
    const cD3 = sb3Costume('audit-large-2000b', largePng, 'png', { bitmapResolution: 2, rotationCenterX: 1000, rotationCenterY: 50 })
    const cS = sb3Costume('audit-stage-ink', stagePng, 'png', { bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 })
    const project = {
      targets: [
        { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: cS.entry.name, assetId: cS.entry.assetId, md5ext: cS.entry.md5ext, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
        { isStage: false, name: 'FitSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [cE.entry, cF.entry, cD.entry, cD3.entry], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
      ],
      monitors: [],
      extensions: [],
      meta: { semver: '3.0.0', vm: 'fit-audit', agent: 'fit-audit' },
    }
    // cD3 shares cD's bytes/file (asset dedup by md5, as in real projects).
    const sb3 = buildSb3(project, { [cE.file]: cE.bytes, [cF.file]: cF.bytes, [cD.file]: cD.bytes, [cS.file]: cS.bytes })
    await importSb3(sb3, 'audit-offcenter')
    await page.getByTestId('target-card-FitSprite').click()
    await new Promise((resolve) => setTimeout(resolve, 500))

    // E: origin = (480-10, 360-10) = (470,350); ink at canvas (480,420,2,2).
    const preContainerE = await containerSize()
    const preTruthE = predictViewport({ x: 480, y: 420, width: 2, height: 2 }, 960, 720, preContainerE.w, preContainerE.h, 1.0, true)
    await selectCostumeCard(0)
    const mE = await waitForSurfaceWidth(surfaceWidthFor(preTruthE.viewport!.scale, 960))
    const metaE = await selectedCostumeMeta()
    expect(metaE.bitmapResolution).toBe(2)
    expect(metaE.rotationCenterX).toBe(10)
    expect(metaE.rotationCenterY).toBe(10)
    logReport('DOM_E', mE)
    expect(mE.mode).toBe('bitmap')
    expect(mE.undoDisabled).toBe(true)
    const srcE = predictViewport({ x: 470, y: 350, width: 96, height: 96 }, 960, 720, mE.container.w, mE.container.h, 1.0, true)
    // Truth: ink at canvas (480,420,2,2), center (481,421).
    const truthE = predictViewport({ x: 480, y: 420, width: 2, height: 2 }, 960, 720, mE.container.w, mE.container.h, 1.0, true)
    logReport('HYP_E', { srcE, truthE })
    expect(srcE.paperZoom).toBeLessThan((truthE.paperZoom ?? 0.5) - 1)
    expect(truthE.paperZoom).toBeCloseTo(4, 10)
    const truthWidthE = surfaceWidthFor(truthE.viewport!.scale, 960)
    const truthScreenE = contentScreen(mE, 960, 720, 481, 421)
    logReport('TRUTH_GAP_E', { truthWidth: truthWidthE, domWidth: mE.surface.width })
    expect(Math.abs(mE.surface.width - truthWidthE)).toBeLessThan(2)
    expect(Math.hypot(truthScreenE.x - mE.container.cx, truthScreenE.y - mE.container.cy)).toBeLessThan(2)
  }, 300_000)

  it('sb3 F: slot-key collision inherits the pre-import settled viewport (loud)', async () => {
    // Continuation of the imported project above (FitSprite E/F/D + Stage).
    // Keys are per-slot (`targetId:index`) and survive project replace (same
    // target id, no remount on import): F (index 1) reuses upload-phase A's
    // settled key (F1 ink fit, scale 4), so F loads A's viewport instead of
    // the res1 reset, and F's own fit drops via the settled guard.
    await page.getByTestId('target-card-FitSprite').click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const serialFEntry = tokenSerial(await workspaceToken())
    // F res1: undecided mapping => legacy reset {0,0,1} on the 480x360 surface.
    await selectCostumeCard(1)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const mF = await measureFit()
    logReport('DOM_F_COLLISION', mF)
    if (remountDetected(serialFEntry, tokenSerial(await workspaceToken()))) {
      expect(`REMOUNT_DETECTED serial ${serialFEntry} -> ${tokenSerial(await workspaceToken())} (dev HMR during F; rerun to confirm)`).toBe('no remount during F')
      return
    }
    expect(mF.mode).toBe('bitmap')
    expect(mF.canvas.w).toBe(480)
    expect(mF.canvas.h).toBe(360)
    expect(mF.undoDisabled).toBe(true)
    // F1 ink reference for context (A settles to scale 4); F itself is res1
    // so the Scratch-correct viewport is the legacy reset (480 wide, 100%,
    // centered), which the DOM now shows (no inherited A viewport observed).
    const aScaleLive = predictViewport({ x: 442, y: 382, width: 2, height: 2 }, 960, 720, mF.container.w, mF.container.h, 1.0, true).viewport!.scale
    logReport('F_COLLISION_EXPECT', { aScaleLive, expectWidth: 480 * aScaleLive, domWidth: mF.surface.width })
    expect(Math.abs(mF.surface.width - 480)).toBeLessThan(2)
    expect(mF.label).toContain('100%')
    expect(Math.hypot(mF.surface.cx - mF.container.cx, mF.surface.cy - mF.container.cy)).toBeLessThan(2)
  }, 180_000)

  it('sb3 D2: slot-key collision renders the large union at the inherited scale (loud)', async () => {
    // F1: upload-phase empty-96 now settles to the base reset (scale 0.5, no
    // ink), so D2 (index 2) reusing that key inherits the base scale:
    // 2000-wide surface renders 1000 centered, which coincides with the
    // correct base. No LOUD gap remains for D2 after F1.
    const serialD2Entry = tokenSerial(await workspaceToken())
    await selectCostumeCard(2)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const mD = await measureFit()
    logReport('DOM_D2_COLLISION', mD)
    if (remountDetected(serialD2Entry, tokenSerial(await workspaceToken()))) {
      expect(`REMOUNT_DETECTED serial ${serialD2Entry} -> ${tokenSerial(await workspaceToken())} (dev HMR during D2; rerun to confirm)`).toBe('no remount during D2')
      return
    }
    expect(mD.mode).toBe('bitmap')
    expect(mD.canvas.w).toBe(2000)
    expect(mD.canvas.h).toBe(720)
    expect(mD.undoDisabled).toBe(true)
    expect(Math.abs(mD.surface.width - 1000)).toBeLessThan(3)
    expect(Math.hypot(mD.surface.cx - mD.container.cx, mD.surface.cy - mD.container.cy)).toBeLessThan(2)
    logReport('TRUTH_GAP_D2', { domWidth: mD.surface.width })
    expect(Math.abs(mD.surface.width - 1000)).toBeLessThan(2)
  }, 180_000)

  it('sb3 D3: large union at a zoom-colliding slot starts at base (F3 independent fixture)', async () => {
    // F3 independent fixture (D2 passes by coincidence: both sides are base).
    // Upload-phase index 3 (audit-big-transparent, 480x360) settles to a
    // scale-4 ink fit, while D3 (index 3, 2000-wide union) must start at the
    // base 1000: slot-only keys inherit 2000*4 = 8000 (fails before the fix),
    // project+slot+costume+mode keys fit fresh (passes after).
    const serialD3Entry = tokenSerial(await workspaceToken())
    await selectCostumeCard(3)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const mD3 = await measureFit()
    logReport('DOM_D3_F3', mD3)
    if (remountDetected(serialD3Entry, tokenSerial(await workspaceToken()))) {
      expect(`REMOUNT_DETECTED serial ${serialD3Entry} -> ${tokenSerial(await workspaceToken())} (dev HMR during D3; rerun to confirm)`).toBe('no remount during D3')
      return
    }
    expect(mD3.mode).toBe('bitmap')
    expect(mD3.canvas.w).toBe(2000)
    expect(mD3.canvas.h).toBe(720)
    expect(mD3.undoDisabled).toBe(true)
    expect(Math.abs(mD3.surface.width - 1000)).toBeLessThan(2)
    expect(Math.hypot(mD3.surface.cx - mD3.container.cx, mD3.surface.cy - mD3.container.cy)).toBeLessThan(2)
    expect(mD3.label).toContain('100%')
  }, 180_000)

  it('sb3 stage/convert/bytes: fresh stage reset, per-mode keys survive conversion, saved bytes', async () => {
    // Stage sprite-vs-stage: res1 backdrop => legacy reset on 480x360.
    await page.getByTestId('target-card-stage').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
    const mS = await waitForSurfaceWidth(480)
    logReport('DOM_STAGE', mS)
    expect(mS.mode).toBe('bitmap')
    expect(mS.canvas.w).toBe(480)
    expect(Math.abs(mS.surface.width - 480)).toBeLessThan(2)
    expect(mS.label).toContain('100%')
    expect(mS.undoDisabled).toBe(true)

    // bitmap<=>vector: conversion writes history; per-mode viewports survive.
    await page.getByTestId('target-card-FitSprite').click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await selectCostumeCard(0)
    await waitForViewportSettled()
    const beforeConvert = await measureFit()
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await waitForViewportSettled()
    const asVector = await measureFit()
    logReport('CONVERT_V', { mode: asVector.mode, label: asVector.label, width: asVector.surface.width, undoDisabled: asVector.undoDisabled })
    expect(asVector.mode).toBe('vector')
    expect(asVector.undoDisabled).toBe(false)
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await waitForViewportSettled()
    const backBitmap = await measureFit()
    logReport('CONVERT_B', { mode: backBitmap.mode, width: backBitmap.surface.width, beforeWidth: beforeConvert.surface.width })
    expect(backBitmap.mode).toBe('bitmap')
    expect(Math.abs(backBitmap.surface.width - beforeConvert.surface.width)).toBeLessThan(2)
    expect(Math.hypot(backBitmap.surface.cx - beforeConvert.surface.cx, backBitmap.surface.cy - beforeConvert.surface.cy)).toBeLessThan(2)

    // Saved bytes after everything: untouched costumes keep dims/meta.
    const saved = await exportSb3()
    const byName = new Map<string, { bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string; dataFormat?: string }>()
    for (const t of saved.project.targets as Array<{ costumes: Array<{ name: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string; dataFormat?: string }> }>) {
      for (const c of t.costumes) byName.set(c.name, c)
    }
    const e = byName.get('audit-offcenter')!
    logReport('SAVED_E_CONVERTED', { md5: e.md5ext, format: e.dataFormat, res: e.bitmapResolution, rc: [e.rotationCenterX, e.rotationCenterY] })
    const f = byName.get('audit-res1')!
    expect(pngDims(saved.assets[f.md5ext!]!).width).toBe(480)
    expect(f.bitmapResolution).toBe(1)
    const d = byName.get('audit-large2')!
    expect(pngDims(saved.assets[d.md5ext!]!).width).toBe(2000)
    expect(d.bitmapResolution).toBe(2)
    const d3 = byName.get('audit-large-2000b')!
    expect(pngDims(saved.assets[d3.md5ext!]!).width).toBe(2000)
    expect(d3.bitmapResolution).toBe(2)
    const s = byName.get('audit-stage-ink')!
    expect(pngDims(saved.assets[s.md5ext!]!).width).toBe(480)
    logReport('SAVED_SB3', { f: [f.md5ext, f.bitmapResolution], d: [d.md5ext, d.bitmapResolution], s: [s.md5ext, s.bitmapResolution] })
  }, 300_000)

  it('slot rename/reorder + same-bytes project reimport: rename preserves, reorder refits, reimport fresh-fits bytes-preserved', async () => {
    // F2/F3: the key is project + slot (targetId:index) + costume identity +
    // mode -- the display name is NOT part of it, while the slot index is.
    await selectCostumeByName('audit-offcenter')
    const eFit = await measureFit()
    // User zoom, then rename: same id+index+asset => same key => the zoom
    // survives the rename (rename must never reset or refit).
    await page.getByRole('button', { name: 'Zoom in' }).click()
    const eZoomed = await measureFit()
    expect(Math.abs(eZoomed.surface.width - eFit.surface.width)).toBeGreaterThan(1)
    await page.locator('[data-testid="costume-card-0"] input[aria-label^="Rename"]').fill('audit-offcenter-r')
    await new Promise((resolve) => setTimeout(resolve, 800))
    const eRenamed = await measureFit()
    logReport('RENAME_KEEP', { before: eZoomed.surface.width, after: eRenamed.surface.width })
    expect(Math.abs(eRenamed.surface.width - eZoomed.surface.width)).toBeLessThan(1)
    expect(Math.hypot(eRenamed.surface.cx - eZoomed.surface.cx, eRenamed.surface.cy - eZoomed.surface.cy)).toBeLessThan(1)
    // Reorder via card drag: the costume moves to a new slot => a fresh ink
    // fit, not the carried-over zoom.
    await page.locator('[data-testid="costume-card-0"]').dragTo(page.locator('[data-testid="costume-card-2"]'))
    await page.waitForFunction(
      () => document.querySelector('[data-testid="costume-card-2"] button[aria-label^="Select"]')?.getAttribute('aria-label') === 'Select audit-offcenter-r',
      null,
      { timeout: 15_000 },
    )
    await selectCostumeByName('audit-offcenter-r')
    const contR = await containerSize()
    const rFitWidth = surfaceWidthFor(predictViewport({ x: 480, y: 420, width: 2, height: 2 }, 960, 720, contR.w, contR.h, 1.0, true).viewport!.scale, 960)
    const mR = await waitForSurfaceWidth(rFitWidth)
    logReport('REORDER_REFIT', { width: mR.surface.width, zoomed: eZoomed.surface.width })
    expect(Math.abs(mR.surface.width - rFitWidth)).toBeLessThan(60)
    expect(Math.abs(mR.surface.width - eZoomed.surface.width)).toBeGreaterThan(50)
    const rInkScreen = contentScreen(mR, 960, 720, 481, 421)
    expect(Math.hypot(rInkScreen.x - mR.container.cx, rInkScreen.y - mR.container.cy)).toBeLessThan(10)
    // Same-bytes whole-project reimport (same name, same id, same bytes via
    // the project file input): the bytes are preserved but the viewport
    // fresh-fits. This IS a project replacement, so `projectViewportGeneration`
    // bumps and the project segment separates the keys -- the pre-import user
    // zoom must NOT leak into the new project (project-viewport-generation
    // proves the same contract). The fresh fit equals the reorder-refit width.
    await page.getByRole('button', { name: 'Zoom in' }).click()
    const rZoomed = await measureFit()
    const exported = await exportSb3()
    const eMd5Before = (exported.project.targets as Array<{ costumes: Array<{ name: string; md5ext: string }> }>)
      .flatMap((t) => t.costumes)
      .find((c) => c.name === 'audit-offcenter-r')!.md5ext
    const eBytesBefore = exported.assets[eMd5Before]!
    await importSb3(buildSb3(exported.project, exported.assets), 'audit-offcenter-r')
    await page.getByTestId('target-card-FitSprite').click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await selectCostumeByName('audit-offcenter-r')
    const mRe = await measureFit()
    logReport('REIMPORT_FRESH', { before: rZoomed.surface.width, after: mRe.surface.width, refit: mR.surface.width })
    expect(Math.abs(mRe.surface.width - mR.surface.width)).toBeLessThan(60)
    expect(Math.abs(mRe.surface.width - rZoomed.surface.width)).toBeGreaterThan(50)
    const reInkScreen = contentScreen(mRe, 960, 720, 481, 421)
    expect(Math.hypot(reInkScreen.x - mRe.container.cx, reInkScreen.y - mRe.container.cy)).toBeLessThan(10)
    const savedAgain = await exportSb3()
    const eAgain = (savedAgain.project.targets as Array<{ costumes: Array<{ name: string; md5ext: string }> }>)
      .flatMap((t) => t.costumes)
      .find((c) => c.name === 'audit-offcenter-r')!
    expect(eAgain.md5ext).toBe(eMd5Before)
    expect(pngDims(savedAgain.assets[eAgain.md5ext]!)!.width).toBe(pngDims(eBytesBefore)!.width)
    expect(pngDims(savedAgain.assets[eAgain.md5ext]!)!.height).toBe(pngDims(eBytesBefore)!.height)
  }, 300_000)
})
