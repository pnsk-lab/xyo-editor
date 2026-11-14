import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// NEW browser test only (product code untouched).
// Purpose: real-UI audit for `bitmapDestinationLocked` (destructive UI disable)
// and `bitmapWorkspaceBusy` (explicit loading display).
// - Real decode/verify delay injection (Image + toBlob + getImageData) widens
//   the pending window deterministically (test-only, via page.evaluate).
// - While pending: spinner role=status visible, Paste/Save/Delete/Flip/Rotate/
//   Convert disabled; after image load completes: enabled again.
// - Vector mode: never locked by the bitmap workspace.
// - While pending: fast target/costume switches + copy history keep old/new
//   asset bytes/metadata/selection/undo non-destructive (Chrome DOM + VM
//   snapshot + exported sb3 bytes independently verified).
// - Cancel-wait and post-switch old resolves never write.
// - Oversize (huge-side PNG) / verify-fail (forced toBlob null) stay
//   permanently locked with the explicit refusal status and stored bytes kept.
// - Project reload/new and textarea focus also verified.
//
// Dedicated Vite port 4607 (surveyed 2026-11-12: 4251/4291/4387/4389/4473/
// 4483/4487/4490/4492/4496/4497/4527/4531/4533/4535/4539/4540/4542/4549/
// 4561/4567/4569/4571/4573/4581/4599 taken; 4607 free, ss confirms).
const root = join(import.meta.dir, '..')
const PORT = 4607
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

function log(label: string, value: unknown) {
  console.log(`[dest-lock-audit] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'dest-lock-audit.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
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

async function installGates(page: Page, imgDelayMs: number, blobDelayMs: number, readbackDelayMs: number) {
  await page.evaluate(
    ({ imgDelay, blobDelay, rbDelay }: { imgDelay: number; blobDelay: number; rbDelay: number }) => {
      const w = window as any
      w.__imgDelayMs = imgDelay
      w.__blobDelayMs = blobDelay
      w.__rbDelayMs = rbDelay
      w.__gateOn = true
      if (typeof w.__forceVerifyFail !== 'boolean') w.__forceVerifyFail = false
      if (!w.__destLockGatesInstalled) {
        w.__destLockGatesInstalled = true
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
            const forceFail = (window as any).__forceVerifyFail === true
            if (forceFail) {
              const delay = (window as any).__gateOn ? (window as any).__blobDelayMs : 0
              setTimeout(() => cb(null), delay)
              return
            }
            if ((window as any).__gateOn) setTimeout(() => cb(...a), (window as any).__blobDelayMs)
            else cb(...a)
          }
          return (origToBlob as any).call(this, wrapped, ...rest)
        }
        const proto = CanvasRenderingContext2D.prototype as any
        if (!proto.__destLockGetImageDataWrapped) {
          proto.__destLockGetImageDataWrapped = true
          const origGet = proto.getImageData
          proto.getImageData = function (...args: any[]) {
            const gateOn = (window as any).__gateOn
            const delay = (window as any).__rbDelayMs ?? 0
            if (!gateOn || !(delay > 0)) return origGet.apply(this, args)
            const self = this
            // Widen the source-canvas verification window: block the caller
            // for `delay` ms, then run the real readback (no data change).
            const start = Date.now()
            while (Date.now() - start < delay) {
              // busy-wait keeps it synchronous for the editor's await chain
            }
            return origGet.apply(self, args)
          }
        }
      }
    },
    { imgDelay: imgDelayMs, blobDelay: blobDelayMs, rbDelay: readbackDelayMs } as unknown as undefined,
  )
}

async function setGate(page: Page, on: boolean) {
  await page.evaluate((v: boolean) => { (window as any).__gateOn = v }, on as unknown as undefined)
}

async function setForceVerifyFail(page: Page, on: boolean) {
  await page.evaluate((v: boolean) => { (window as any).__forceVerifyFail = v }, on as unknown as undefined)
}

async function uiState(page: Page) {
  return await page.evaluate(() => {
    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null
    const isDisabled = (el: Element | null) => (el as HTMLButtonElement | null)?.disabled === true
    const overlay = document.querySelector('[data-testid="bitmap-workspace-loading-overlay"]')
    const spinner = document.querySelector('[data-testid="bitmap-workspace-loading"]')
    const convertBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('ベクターに変換')) ?? null
    return {
      overlayVisible: overlay !== null && (overlay as HTMLElement).offsetParent !== null,
      overlayRole: overlay?.getAttribute('role'),
      spinnerVisible: spinner !== null && (spinner as HTMLElement).offsetParent !== null,
      spinnerRole: spinner?.getAttribute('role'),
      spinnerText: (spinner?.textContent ?? '').trim(),
      saveDisabled: isDisabled(q('save-bitmap-costume')),
      pasteDisabled: isDisabled(q('paste-costume-selection')),
      copyDisabled: isDisabled(q('copy-costume-selection')),
      deleteDisabled: isDisabled(q('delete-editor-selection')),
      flipHDisabled: isDisabled(q('flip-bitmap-horizontal')),
      flipVDisabled: isDisabled(q('flip-bitmap-vertical')),
      rotateLDisabled: isDisabled(q('rotate-bitmap-left')),
      rotateRDisabled: isDisabled(q('rotate-bitmap-right')),
      convertDisabled: (convertBtn as HTMLButtonElement | null)?.disabled === true,
      convertVisible: convertBtn !== null,
      legacyPasteDisabled: isDisabled(q('legacy-paste-costume-selection')),
      selectionPresent: document.querySelector('[data-testid="bitmap-selection"]') !== null,
      status: (window as any).__hikkakuEditorTest?.status() ?? '',
      token: (window as any).__hikkakuEditorTest?.bitmapWorkspaceToken() ?? '',
      tab: (window as any).__hikkakuEditorTest?.selectedTab() ?? '',
    }
  })
}

async function vmCostume(page: Page, targetName: string, index: number) {
  return await page.evaluate(
    ({ want, idx }: { want: string; idx: number }) => {
      const snap = (window as any).__hikkakuEditorTest.snapshot()
      const t = snap.project.targets.find((x: any) => x.name === want)!
      const c = t.costumes[idx]!
      return {
        name: c.name,
        dataFormat: c.dataFormat ?? '',
        bitmapResolution: c.bitmapResolution,
        rotationCenterX: c.rotationCenterX,
        rotationCenterY: c.rotationCenterY,
        md5ext: c.md5ext,
        assetId: c.assetId,
      }
    },
    { want: targetName, idx: index } as unknown as undefined,
  )
}

describe('bitmap destination lock UI audit (new test, no product change)', () => {
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

  it('pending lock UI, cross-asset safety, refusal lock, reload and textarea focus', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      const redPng = buildPng(96, 96, (x, y) => {
        const red = x >= 20 && x < 50 && y >= 20 && y < 50
        return red ? [255, 0, 0, 255] : [255, 255, 255, 255]
      })
      const bluePng = buildPng(64, 48, (x, y) => {
        const blue = x >= 10 && x < 34 && y >= 10 && y < 30
        return blue ? [0, 0, 255, 255] : [255, 255, 255, 255]
      })
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="30" fill="#00aa00"/></svg>`
      const svgBytes = new TextEncoder().encode(svgText)
      const files: Record<string, Uint8Array> = {}
      const put = (bytes: Uint8Array, ext: string) => {
        const h = md5(bytes)
        files[`${h}.${ext}`] = bytes
        return { assetId: h, md5ext: `${h}.${ext}` }
      }
      const redFile = put(redPng, 'png')
      const red2File = put(redPng, 'png')
      const blueFile = put(bluePng, 'png')
      const svgFile = put(svgBytes, 'svg')
      const project = {
        targets: [
          {
            isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'stage-white', ...put(buildPng(32, 24, () => [255, 255, 255, 255]), 'png'), dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 16, rotationCenterY: 12 }],
            sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
          },
          {
            isStage: false, name: 'LockA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [
              { name: 'redA', ...redFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 30, rotationCenterY: 70 },
              { name: 'redA2', ...red2File, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 48, rotationCenterY: 48 },
            ],
            sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
          },
          {
            isStage: false, name: 'LockB', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'blueB', ...blueFile, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 10, rotationCenterY: 20 }],
            sounds: [], volume: 100, layerOrder: 2, visible: true, x: 80, y: 40, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
          },
          {
            isStage: false, name: 'VecV', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'vecV', ...svgFile, dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 }],
            sounds: [], volume: 100, layerOrder: 3, visible: true, x: -80, y: -40, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
          },
        ],
        monitors: [], extensions: [],
        meta: { semver: '3.0.0', vm: 'dest-lock-audit', agent: 'dest-lock-audit' },
      }
      await openCostumes(page)
      await importSb3(page, buildSb3(project, files), 'redA')
      const baseline = await exportSb3(page)
      const baseA = baseline.project.targets.find((t: any) => t.name === 'LockA').costumes[0]
      const baseB = baseline.project.targets.find((t: any) => t.name === 'LockB').costumes[0]
      log('baseline', { baseA, baseB })
      expect(baseA.bitmapResolution).toBe(2)
      expect(baseB.bitmapResolution).toBe(1)

      // Settle on LockA and fill the clipboard (copy needs settled art).
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(900)
      let settled = await uiState(page)
      log('settled LockA UI', settled)
      expect(settled.spinnerVisible).toBe(false)
      expect(settled.overlayVisible).toBe(false)
      // Make a selection then copy so Paste has a clipboard entry.
      // Retry the marquee a few times: headless pointer routing can drop
      // the first drag, and Delete enablement needs a real selection.
      await page.getByTestId('bitmap-tool-select').click()
      let selAttempts = 0
      for (; selAttempts < 3; selAttempts += 1) {
        const canvasBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
        if (!canvasBox) throw new Error('missing bitmap canvas box')
        await page.mouse.move(canvasBox.x + canvasBox.width * 0.25, canvasBox.y + canvasBox.height * 0.25)
        await page.mouse.down()
        await page.mouse.move(canvasBox.x + canvasBox.width * 0.65, canvasBox.y + canvasBox.height * 0.65, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(400)
        const probe = await uiState(page)
        if (probe.selectionPresent) break
      }
      log('selection attempts', { selAttempts })
      const withSel = await uiState(page)
      log('with selection (settled)', withSel)
      await page.getByTestId('copy-costume-selection').click()
      await page.waitForTimeout(500)
      const afterCopy = await uiState(page)
      log('after copy (settled, clipboard filled)', afterCopy)
      // Settled + clipboard: Paste/Save/Flip/Rotate/Convert must be enabled.
      expect(afterCopy.pasteDisabled).toBe(false)
      expect(afterCopy.saveDisabled).toBe(false)
      expect(afterCopy.flipHDisabled).toBe(false)
      expect(afterCopy.rotateLDisabled).toBe(false)
      expect(afterCopy.convertDisabled).toBe(false)

      // Install real decode + source-canvas verification delays.
      await installGates(page, 900, 700, 450)
      log('gates installed', { img: 900, blob: 700, readback: 450 })

      // Trigger pending via fast target switch; assert the lock UI mid-flight.
      await page.getByTestId('target-card-LockB').click()
      // Poll quickly: the pending window is ~900ms decode + verify.
      let pending: Awaited<ReturnType<typeof uiState>> | undefined
      for (let i = 0; i < 20; i += 1) {
        const s = await uiState(page)
        if (s.spinnerVisible || s.overlayVisible || s.saveDisabled) {
          pending = s
          break
        }
        await page.waitForTimeout(100)
      }
      if (!pending) pending = await uiState(page)
      log('pending LockB UI (decode/verify gated)', pending)
      // Spinner must be explicit role=status with the loading text.
      expect(pending.overlayVisible).toBe(true)
      expect(pending.overlayRole).toBe('status')
      expect(pending.spinnerVisible).toBe(true)
      expect(pending.spinnerRole).toBe('status')
      expect(pending.spinnerText).toContain('Loading bitmap')
      // Destructive bitmap UI must be disabled while pending.
      expect(pending.saveDisabled).toBe(true)
      expect(pending.pasteDisabled).toBe(true)
      expect(pending.copyDisabled).toBe(true)
      expect(pending.flipHDisabled).toBe(true)
      expect(pending.flipVDisabled).toBe(true)
      expect(pending.rotateLDisabled).toBe(true)
      expect(pending.rotateRDisabled).toBe(true)
      expect(pending.convertDisabled).toBe(true)
      expect(pending.legacyPasteDisabled).toBe(true)
      // Disabled clicks must not write: click Save/Paste while locked.
      const vmBeforeClick = await vmCostume(page, 'LockB', 0)
      await page.getByTestId('save-bitmap-costume').click({ force: true }).catch(() => undefined)
      await page.getByTestId('paste-costume-selection').click({ force: true }).catch(() => undefined)
      await page.waitForTimeout(200)
      const vmAfterDisabledClick = await vmCostume(page, 'LockB', 0)
      expect(vmAfterDisabledClick.md5ext).toBe(vmBeforeClick.md5ext)

      // Vector mode is unrelated: switch to VecV mid-pending.
      await page.getByTestId('target-card-VecV').click()
      await page.waitForTimeout(500)
      const vecState = await uiState(page)
      const vecMode = await page.evaluate(() => {
        const snap = (window as any).__hikkakuEditorTest.snapshot()
        const t = snap.project.targets.find((x: any) => x.name === 'VecV')!
        return t.costumes[t.currentCostume ?? 0].dataFormat
      })
      log('vector during bitmap pending', { vecState, vecMode })
      expect(vecMode).toBe('svg')
      expect(vecState.spinnerVisible).toBe(false)
      expect(vecState.overlayVisible).toBe(false)
      // Vector flip path stays per vector selection (not bitmap-locked).
      expect(vecState.flipHDisabled).toBe(true) // no vector selection yet -> disabled for its own reason, not lock

      // Fast costume switch inside LockA while still gated (race window).
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(150)
      await page.getByRole('button', { name: 'Select redA2' }).first().click().catch(() => undefined)
      await page.waitForTimeout(150)
      // Copy attempt while unsettled must refuse and keep clipboard source clean.
      await page.keyboard.press('ControlOrMeta+c')
      await page.waitForTimeout(250)
      const copyStatus = await page.evaluate(() => (window as any).__hikkakuEditorTest?.status() ?? '')
      log('copy-during-pending status', { copyStatus })
      // Paste attempt via keyboard while pending must also refuse safely.
      await page.keyboard.press('ControlOrMeta+v')
      await page.waitForTimeout(250)
      // Immediate stale-window Save on the new selection with old pixels shown.
      await page.getByTestId('save-bitmap-costume').click({ force: true }).catch(() => undefined)
      await page.getByTestId('target-card-LockB').click()
      await page.getByTestId('save-bitmap-costume').click({ force: true }).catch(() => undefined)
      // Undo/redo while gated must not pop across assets.
      try {
        const undoBtn = page.locator('button[aria-label="Undo"]:visible').last()
        if (await undoBtn.isEnabled().catch(() => false)) await undoBtn.click()
        await page.waitForTimeout(250)
        const redoBtn = page.locator('button[aria-label="Redo"]:visible').last()
        if (await redoBtn.isEnabled().catch(() => false)) await redoBtn.click()
        await page.waitForTimeout(250)
      } catch {}
      log('race window done', {})

      // Cancel-wait: start an async Save on LockA, switch before it resolves.
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(150)
      const savePromise = page.getByTestId('save-bitmap-costume').click({ force: true }).catch(() => undefined)
      await page.getByTestId('target-card-LockB').click()
      await savePromise
      await page.waitForTimeout(300)
      log('cancel-wait switch done', {})

      // Settle: gates OFF, wait for real decodes/saves.
      await setGate(page, false)
      await setForceVerifyFail(page, false)
      await page.waitForTimeout(1800)
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(1200)
      await page.getByTestId('target-card-LockB').click()
      await page.waitForTimeout(1200)
      const settledB = await uiState(page)
      log('settled LockB UI (gates off)', settledB)
      expect(settledB.spinnerVisible).toBe(false)
      expect(settledB.overlayVisible).toBe(false)
      expect(settledB.saveDisabled).toBe(false)
      expect(settledB.flipHDisabled).toBe(false)
      expect(settledB.rotateLDisabled).toBe(false)
      expect(settledB.convertDisabled).toBe(false)
      // Paste re-enables because the earlier copy filled the clipboard.
      expect(settledB.pasteDisabled).toBe(false)
      // Pending-derived `Loading bitmap…` must not survive the same-asset
      // settle: pending cleared + overlay hidden + Save enabled yet the
      // status still claims loading is the stale bug. The guarded settle
      // advances only that pending Loading to the completion display, never
      // a later operation / other-target error / refusal.
      expect(settledB.token).toContain('pending=none')
      expect(settledB.status).not.toContain('Loading bitmap')
      expect(settledB.status).toBe('Costume selected')

      // Chrome DOM + VM snapshot + exported bytes must agree: no cross-asset ink.
      const vmA = await vmCostume(page, 'LockA', 0)
      const vmB = await vmCostume(page, 'LockB', 0)
      log('vm meta after race', { vmA, vmB })
      expect(vmB.bitmapResolution).toBe(1)
      expect(vmA.bitmapResolution).toBe(2)
      const exported = await exportSb3(page)
      const findC = (name: string, idx: number) => {
        const t = exported.project.targets.find((x: any) => x.name === name)
        return { target: t, costume: t.costumes[idx] }
      }
      const eA = findC('LockA', 0)
      const eB = findC('LockB', 0)
      const rgbaA = decodePng(Buffer.from(exported.assets[eA.costume.md5ext]!))
      const rgbaB = decodePng(Buffer.from(exported.assets[eB.costume.md5ext]!))
      const counts = {
        lockA: { red: countWhere(rgbaA.data, isRed), blue: countWhere(rgbaA.data, isBlue) },
        lockB: { red: countWhere(rgbaB.data, isRed), blue: countWhere(rgbaB.data, isBlue) },
      }
      log('exported pixel counts (cross-asset check)', counts)
      const failures: string[] = []
      if (!(counts.lockA.red > 200)) failures.push(`LockA lost red ink (red=${counts.lockA.red})`)
      if (counts.lockA.blue !== 0) failures.push(`LockA contaminated with BLUE (blue=${counts.lockA.blue})`)
      if (!(counts.lockB.blue > 100)) failures.push(`LockB lost blue ink (blue=${counts.lockB.blue})`)
      if (counts.lockB.red !== 0) failures.push(`LockB contaminated with RED (red=${counts.lockB.red})`)
      if (!Number.isFinite(eA.costume.rotationCenterX) || !Number.isFinite(eA.costume.rotationCenterY)) failures.push('LockA center non-finite')
      if (!Number.isFinite(eB.costume.rotationCenterX) || !Number.isFinite(eB.costume.rotationCenterY)) failures.push('LockB center non-finite')
      if (eA.costume.rotationCenterX === 10 && eA.costume.rotationCenterY === 20) failures.push('LockA center equals LockB baseline — cross-write?')
      if (eB.costume.rotationCenterX === 30 && eB.costume.rotationCenterY === 70) failures.push('LockB center equals LockA baseline — cross-write?')
      if (failures.length > 0) log('VERDICT FAIL cross-asset', { failures, counts })
      expect(failures).toEqual([])

      // Oversize refusal: huge-side PNG (66000x2 solid) stays locked with refusal.
      const hugePng = buildPng(66000, 2, () => [0, 200, 0, 255])
      const hugeFiles: Record<string, Uint8Array> = {}
      const hugePut = (bytes: Uint8Array, ext: string) => {
        const h = md5(bytes)
        hugeFiles[`${h}.${ext}`] = bytes
        return { assetId: h, md5ext: `${h}.${ext}` }
      }
      const hugeFile = hugePut(hugePng, 'png')
      const hugeProject = {
        targets: [
          {
            isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 's', ...hugePut(buildPng(16, 12, () => [255, 255, 255, 255]), 'png'), dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 8, rotationCenterY: 6 }],
            sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
          },
          {
            isStage: false, name: 'Huge', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'huge', ...hugeFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 33000, rotationCenterY: 1 }],
            sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
          },
        ],
        monitors: [], extensions: [],
        meta: { semver: '3.0.0', vm: 'dest-lock-huge', agent: 'dest-lock-huge' },
      }
      await importSb3(page, buildSb3(hugeProject, hugeFiles), 'huge')
      await page.getByTestId('target-card-Huge').click()
      await page.waitForTimeout(2500)
      const hugeState = await uiState(page)
      log('oversize refusal UI', hugeState)
      expect(hugeState.spinnerVisible).toBe(false)
      expect(hugeState.saveDisabled).toBe(true)
      expect(hugeState.flipHDisabled).toBe(true)
      expect(hugeState.rotateLDisabled).toBe(true)
      expect(hugeState.convertDisabled).toBe(true)
      expect(hugeState.pasteDisabled).toBe(true)
      expect(hugeState.status).toContain('Image too large')
      const hugeExport = await exportSb3(page)
      const hugeCostume = hugeExport.project.targets.find((t: any) => t.name === 'Huge').costumes[0]
      expect(hugeCostume.md5ext).toBe(hugeFile.md5ext)

      // Validation-failure refusal: force toBlob null on a normal asset.
      await importSb3(page, buildSb3(project, files), 'redA')
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(1200)
      await installGates(page, 100, 100, 50)
      await setForceVerifyFail(page, true)
      // Force a fresh load under the failing probe.
      await page.getByTestId('target-card-LockB').click()
      await page.waitForTimeout(400)
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(2000)
      await setGate(page, false)
      const failState = await uiState(page)
      log('verify-fail refusal UI', failState)
      expect(failState.saveDisabled).toBe(true)
      expect(failState.status).toContain('Image too large')
      const failExport = await exportSb3(page)
      const failA = failExport.project.targets.find((t: any) => t.name === 'LockA').costumes[0]
      expect(failA.bitmapResolution).toBe(2)
      // Recovery: clear the forced failure and reload the asset.
      await setForceVerifyFail(page, false)
      await page.getByTestId('target-card-LockB').click()
      await page.waitForTimeout(1200)
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(1500)
      const recovered = await uiState(page)
      log('recovered UI', recovered)
      expect(recovered.saveDisabled).toBe(false)
      expect(recovered.spinnerVisible).toBe(false)

      // Project reload: re-import baseline and verify clean lock + bytes.
      // A re-import bumps the preview revision; force fresh loads on both
      // bitmap targets so the owner token re-settles (same-target click alone
      // may not trigger a reload when the selection is unchanged).
      await importSb3(page, buildSb3(project, files), 'redA')
      await page.getByTestId('target-card-LockB').click()
      await page.waitForTimeout(1400)
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(1600)
      const reloaded = await uiState(page)
      log('reloaded UI', reloaded)
      expect(reloaded.spinnerVisible).toBe(false)
      expect(reloaded.saveDisabled).toBe(false)

      // Textarea focus: open bitmap text, click canvas, verify focused textarea.
      await page.getByTestId('target-card-LockA').click()
      await page.waitForTimeout(900)
      await page.getByTestId('bitmap-tool-text').click()
      const box2 = await page.getByTestId('bitmap-editor-canvas').boundingBox()
      if (!box2) throw new Error('missing canvas for text')
      await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2)
      await page.waitForTimeout(600)
      const textFocus = await page.evaluate(() => {
        const ta = document.querySelector('[data-inline-text-editor] textarea') as HTMLTextAreaElement | null
        return { present: ta !== null, focused: ta !== null && document.activeElement === ta }
      })
      log('textarea focus', textFocus)
      expect(textFocus.present).toBe(true)
      expect(textFocus.focused).toBe(true)
      // Cancel the draft without writing (Escape commits per product; use Cancel button to discard).
      const cancelBtn = page.getByRole('button', { name: 'Cancel text editing' })
      if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click()
      await page.waitForTimeout(400)
      log('done', { ok: true })
    } finally {
      await context.close()
    }
  }, 240_000)
})
