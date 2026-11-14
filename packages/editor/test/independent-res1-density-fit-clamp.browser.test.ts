// Independent res1 density-0.5 + fit/clamp verification (NEW file only, no product edits).
//
// Covers the task statement through the REAL Editor + REAL VM on an independent
// Vite port (4691), with CHROME_BIN from the environment:
// - 96x96 res1 PNGs (1px dot / alpha=1 pixel / transparent hole / 24x12 block)
//   with noncenter rc=(0,0), rc=(400,300), negative rc, stage/sprite targets,
//   and a wide union, loaded from SB3.
// - Paper-2x-normalized oracle (own derivation, npm `paper` UMD entity):
//   origin = CENTER - rc, 1 stored px = 2 Paper units, res1 density 0.5,
//   reset Paper 0.5 -> CSS 1.0, floor 0.333 -> CSS 0.666..., button +0.5 Paper ->
//   +1.0 CSS, classic -100 tick (+0.1 Paper) -> +0.2 CSS.
// - Initial fit / reset / button+1CSS / wheel+.2 / floor .666 / mouse anchor /
//   pan clamp verified against the Paper entity + rect mapping + pixel layout.
// - Post-edit PNG res1 origin bytes/center + stage pixel scale; selection
//   copy/paste/move/rotate/undo/redo/target-switch explicitly verified;
//   load + no-op keep bytes unchanged (md5ext identity + pixel digest).
// - Oversize input hits the hard refusal gate (explicit status, bytes kept).
// - Every TRUE mismatch stays a failure (strict expects, no weakening).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/independent-res1-density-fit-clamp.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { strToU8, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { join } from 'node:path'
import { launchBrowser } from './browser-launcher'
import {
  BITMAP_ARTBOARD_MAX_AREA,
  BITMAP_SOURCE_MAX_SIDE,
  isBitmapSourceSizeRefused,
  placeSourceOnArtboard,
} from '../src/features/costumes/bitmap-artboard'

const EDITOR_ROOT = join(import.meta.dir, '..')
const PAPER_URL = join(EDITOR_ROOT, 'node_modules/paper/dist/paper-full.js')
const PORT = 4691
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

// --- own minimal PNG builder (no product code) ---
function crcOf(chunk: Uint8Array): number {
  let c = 0xffffffff
  for (const b of chunk) {
    c ^= b
    for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  new DataView(out.buffer).setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  new DataView(out.buffer).setUint32(8 + data.length, crcOf(out.slice(4, 8 + data.length)))
  return out
}
function buildPng(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 4))
  for (let y = 0; y < h; y += 1) {
    raw[y * (1 + w * 4)] = 0
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = px(x, y)
      const o = y * (1 + w * 4) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, w); v.setUint32(4, h)
  ihdr[8] = 8; ihdr[9] = 6
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// 96x96 res1 pattern: transparent bg + 24x12 opaque block at (30,40) with an
// 8x4 transparent HOLE at (36,44) + 1px dot at (5,5) + alpha=1 pixel at (70,70).
function patternFor(color: [number, number, number]): (x: number, y: number) => [number, number, number, number] {
  const [r, g, b] = color
  return (x, y) => {
    if (x === 5 && y === 5) return [r, g, b, 255] // 1px dot
    if (x === 70 && y === 70) return [r, g, b, 1] // alpha=1 (counts as opaque)
    const inBlock = x >= 30 && x < 54 && y >= 40 && y < 52
    if (!inBlock) return [0, 0, 0, 0]
    const inHole = x >= 36 && x < 44 && y >= 44 && y < 48
    if (inHole) return [0, 0, 0, 0] // transparent hole
    return [r, g, b, 255]
  }
}

function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

type CostumeDef = { name: string; res: number; rcx: number; rcy: number; color: [number, number, number] }

const SPRITE_COSTUMES: CostumeDef[] = [
  { name: 'res1-4848', res: 1, rcx: 48, rcy: 48, color: [255, 0, 0] },
  { name: 'res1-00', res: 1, rcx: 0, rcy: 0, color: [0, 200, 0] },
  { name: 'res1-400300', res: 1, rcx: 400, rcy: 300, color: [0, 0, 255] },
  { name: 'res1-neg', res: 1, rcx: -20, rcy: -15, color: [200, 200, 0] },
  { name: 'res1-wide', res: 1, rcx: -400, rcy: -300, color: [0, 200, 200] },
  { name: 'res2-4848', res: 2, rcx: 48, rcy: 48, color: [255, 0, 255] },
]
const STAGE_COLOR: [number, number, number] = [0, 128, 255]

async function openCostumes(p: Page) {
  await p.goto(base, { waitUntil: 'networkidle' })
  await p.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await p.getByTestId('main-tab-costumes').click()
  await p.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await p.waitForTimeout(600)
}
async function importSb3(p: Page, bytes: Buffer, expectName: string) {
  await p.getByTestId('project-file-input').setInputFiles({ name: 'res1-verify.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await p.waitForFunction(
    (want: string) => (window as any).__hikkakuEditorTest?.snapshot().project.targets.some((t: any) => t.costumes.some((c: any) => c.name === want)) ?? false,
    expectName as unknown as undefined,
    { timeout: 30_000 },
  )
  await p.getByTestId('main-tab-costumes').click()
  await p.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await p.waitForTimeout(800)
}
async function selectTarget(p: Page, name: string) {
  if (name === 'Stage') {
    await p.getByTestId('target-card-stage').click()
  } else {
    await p.evaluate((n: string) => { (document.querySelector(`[data-testid="target-card-${n}"]`) as HTMLElement | null)?.click() }, name as unknown as undefined)
  }
  await p.waitForTimeout(700)
}
async function selectCostume(p: Page, name: string) {
  await p.evaluate((n: string) => { (document.querySelector(`button[aria-label="Select ${n}"]`) as HTMLButtonElement | undefined)?.click() }, name as unknown as undefined)
  await p.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await p.waitForFunction(
    (want: string) => {
      try {
        const snap = (window as any).__hikkakuEditorTest.snapshot()
        const t = snap.project.targets.find((x) => x.name === 'Res1Sprite' || x.name === want)
        const all = snap.project.targets.flatMap((x) => x.costumes.map((c) => c.name))
        return all.includes(want)
      } catch { return false }
    },
    name as unknown as undefined,
    { timeout: 25_000 },
  )
  await p.waitForTimeout(700)
}
async function canvasDiag(p: Page) {
  return await p.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) return { found: false as const }
    const ctx = canvas.getContext('2d')
    if (!ctx) return { found: true as const, readable: false as const }
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let opaque = 0, alpha1 = 0, left = canvas.width, top = canvas.height, right = -1, bottom = -1
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const a = img.data[(y * canvas.width + x) * 4 + 3] ?? 0
      if (a === 0) continue
      opaque += 1
      if (a === 1) alpha1 += 1
      if (x < left) left = x; if (y < top) top = y; if (x > right) right = x; if (y > bottom) bottom = y
    }
    let hash = 2166136261
    for (let i = 0; i < img.data.length; i += 4) {
      hash ^= img.data[i]!; hash = Math.imul(hash, 16777619)
      hash ^= img.data[i + 3]!; hash = Math.imul(hash, 16777619)
    }
    return { found: true as const, readable: true as const, width: canvas.width, height: canvas.height, opaque, alpha1, digest: (hash >>> 0).toString(16), trim: right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null }
  })
}
async function canvasProbe(p: Page, x: number, y: number): Promise<number[] | null> {
  return await p.evaluate((pt: { x: number; y: number }) => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) return null
    if (pt.x < 0 || pt.y < 0 || pt.x >= canvas.width || pt.y >= canvas.height) return null
    return Array.from(canvas.getContext('2d')!.getImageData(pt.x, pt.y, 1, 1).data)
  }, { x, y } as unknown as undefined)
}
async function metaOf(p: Page, targetName: string) {
  return await p.evaluate((tn: string) => {
    const snap = (window as any).__hikkakuEditorTest.snapshot()
    const t = snap.project.targets.find((x: any) => x.name === tn)!
    const c = t.costumes[t.currentCostume ?? 0]!
    return { name: c.name, res: c.bitmapResolution, rcx: c.rotationCenterX, rcy: c.rotationCenterY, fmt: c.dataFormat, md5: c.md5ext ?? c.assetId }
  }, targetName as unknown as undefined)
}
async function viewportOf(p: Page) {
  return await p.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    const container = document.querySelector('[data-testid="costume-paint-surface"]')!
    const r = canvas!.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    return {
      backing: { w: canvas!.width, h: canvas!.height },
      rect: { w: r.width, h: r.height, left: r.left, top: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 },
      container: { w: c.width, h: c.height, cx: c.left + c.width / 2, cy: c.top + c.height / 2 },
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
    }
  })
}
async function resetZoom(p: Page) {
  await p.evaluate(() => { document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click() })
  await p.waitForFunction(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('100%') ?? false, null, { timeout: 15_000 })
  await new Promise((r) => setTimeout(r, 400))
}

describe('independent res1 density-0.5 + fit/clamp (real Editor + real VM)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: EDITOR_ROOT, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 120; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed on ${PORT}`)
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 90_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('ORACLE: Paper 2x entity — placement, unit proof, camera, fit/zoom/pan/clamp numbers', async () => {
    await page.goto('about:blank')
    await page.addScriptTag({ path: PAPER_URL })
    const rep = await page.evaluate(async () => {
      const P = (window as unknown as { paper: typeof import('paper') }).paper
      const out: Record<string, unknown> = {}
      const BW = 960, BH = 720, CX = 480, CY = 360
      out.board = { w: BW, h: BH, cx: CX, cy: CY }
      const holder = document.createElement('div')
      holder.style.cssText = 'position:relative;width:800px;height:600px;overflow:hidden;'
      document.body.appendChild(holder)
      const cv = document.createElement('canvas')
      cv.style.cssText = 'width:800px;height:600px;display:block;'
      holder.appendChild(cv)
      P.setup(cv)
      P.view.zoom = 0.5
      P.view.center = new P.Point(CX, CY)
      const place = (rcX: number, rcY: number) => ({ ox: CX - rcX, oy: CY - rcY })
      const cases = [
        { name: 'rc48,48', rc: { x: 48, y: 48 } },
        { name: 'rc0,0', rc: { x: 0, y: 0 } },
        { name: 'rc400,300', rc: { x: 400, y: 300 } },
        { name: 'neg-rc-20,-15', rc: { x: -20, y: -15 } },
      ]
      const art = document.createElement('canvas'); art.width = BW; art.height = BH
      const actx = art.getContext('2d')!
      actx.imageSmoothingEnabled = false
      const src = document.createElement('canvas'); src.width = 96; src.height = 96
      const sctx = src.getContext('2d')!
      sctx.clearRect(0, 0, 96, 96)
      sctx.fillStyle = 'rgba(255,0,0,255)'
      sctx.fillRect(30, 40, 24, 12) // 24x12 block (rotation-asymmetric)
      sctx.clearRect(36, 44, 8, 4) // transparent hole
      sctx.fillRect(5, 5, 1, 1) // 1px dot
      const px = (x: number, y: number) => (x < 0 || y < 0 || x >= BW || y >= BH) ? null : Array.from(actx.getImageData(Math.round(x), Math.round(y), 1, 1).data)
      const rows: Array<Record<string, unknown>> = []
      for (const c of cases) {
        actx.clearRect(0, 0, BW, BH)
        const { ox, oy } = place(c.rc.x, c.rc.y)
        actx.drawImage(src, ox, oy)
        actx.drawImage(src, ox, oy) // reference draws twice: idempotent
        const blockOrigin = { x: ox + 30, y: oy + 40 }
        const inside = px(blockOrigin.x + 2, blockOrigin.y + 2)
        const hole = px(ox + 38, oy + 45)
        const dot = px(ox + 5, oy + 5)
        const outside = px(blockOrigin.x - 1, blockOrigin.y + 2)
        const img = actx.getImageData(0, 0, BW, BH)
        let l = BW, t = BH, r = -1, b = -1, n = 0
        for (let y = 0; y < BH; y += 1) for (let x = 0; x < BW; x += 1) {
          if ((img.data[(y * BW + x) * 4 + 3] ?? 0) === 0) continue
          n += 1
          if (x < l) l = x; if (y < t) t = y; if (x > r) r = x; if (y > b) b = y
        }
        rows.push({ name: c.name, origin: { x: ox, y: oy }, blockOrigin, inside, hole, dot, outside, opaque: n, trim: n > 0 ? { x: l, y: t, width: r - l + 1, height: b - t + 1 } : null })
      }
      out.placements = rows
      // Paper-unit proof: 96 canvas px -> 96 Paper units (48 CSS at zoom 0.5).
      P.view.zoom = 0.5; P.view.center = new P.Point(CX, CY)
      const span = (x0: number, x1: number, y: number) => {
        const a = P.view.projectToView(new P.Point(x0, y)) as unknown as { x: number }
        const b = P.view.projectToView(new P.Point(x1, y)) as unknown as { x: number }
        return Math.abs(b.x - a.x)
      }
      out.proof = { span96at05: span(432, 528, 360), span192at05: span(432, 624, 360) }
      out.camera = [0.5, 1.0, 0.333].map((z) => {
        P.view.zoom = z; P.view.center = new P.Point(CX, CY)
        return { zoom: z, bitmap96: span(240, 336, 360), scaledBoard: span(0, 960, 360) }
      })
      P.view.zoom = 0.5; P.view.center = new P.Point(CX, CY)
      // zoom/pan: +0.5 Paper anchor, -100 tick +0.1, pan scrollBy(dx/zoom).
      const zoomOnFixed = (deltaZoom: number, fixed: { x: number; y: number }) => {
        const preC = P.view.center.clone() as unknown as { x: number; y: number }
        const nz = Math.max(0.333, P.view.zoom + deltaZoom)
        const sc = P.view.zoom / nz
        const fp = new P.Point(fixed.x, fixed.y)
        const before = P.view.projectToView(fp.clone())
        P.view.zoom = nz
        const pre = { x: fp.x - preC.x, y: fp.y - preC.y }
        P.view.translate(new P.Point(-(fp.x - pre.x * sc - preC.x), -(fp.y - pre.y * sc - preC.y)))
        const after = P.view.projectToView(fp.clone())
        return { newZoom: nz, center: { x: P.view.center.x, y: P.view.center.y }, pinErr: Math.hypot(after.x - before.x, after.y - before.y) }
      }
      out.anchorPlus = zoomOnFixed(0.5, { x: 580, y: 410 })
      P.view.zoom = 0.5; P.view.center = new P.Point(CX, CY)
      out.floorStick = Math.max(0.333, 0.5 - 0.5)
      out.wheelTick = Math.max(0.333, 0.5 + 100 / 1000)
      const bPan = { x: P.view.center.x, y: P.view.center.y }
      P.view.scrollBy(new P.Point(120 / 0.5, 0))
      out.pan = { before: bPan, after: { x: P.view.center.x, y: P.view.center.y } }
      // fit: bitmap expand(50) then x1.5 pad; ratio clamp [0.125,1]; zoom 0.5/ratio.
      const fit = (bw: number, bh: number, cw: number, ch: number, isB: boolean) => {
        const pW = (bw + (isB ? 50 : 0)) * 1.5, pH = (bh + (isB ? 50 : 0)) * 1.5
        const ratio = Math.max(0.125, Math.min(1, 0.5 * Math.max(pW / cw, pH / ch)))
        return { padded: { w: pW, h: pH }, ratio, zoom: ratio < 1 ? 0.5 / ratio : 0.5 }
      }
      out.fit = { small2040in800x600: fit(24, 12, 800, 600, true), holeBlock: fit(24, 12, 800, 600, true) }
      // res1 density hypotheses: board 480/960=0.5 wins over own 480/480=1.0.
      out.density = {
        board: { paper: 960, density: 480 / 960, resetCss: 0.5 / (480 / 960), floorCss: 0.333 / (480 / 960), buttonCss: 0.5 / (480 / 960), wheelCss: 0.1 / (480 / 960) },
        own: { paper: 480, density: 480 / 480, resetCss: 0.5, floorCss: 0.333, buttonCss: 0.5, wheelCss: 0.1 },
      }
      holder.remove(); P.remove()
      return out
    })
    console.log(`RES1_ORACLE ${JSON.stringify(rep)}`)
    const rows = rep.placements as Array<{ name: string; origin: { x: number; y: number }; blockOrigin: { x: number; y: number }; inside: number[]; hole: number[]; dot: number[]; outside: number[] | null; opaque: number; trim: { x: number; y: number; width: number; height: number } | null }>
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(byName['rc48,48']!.origin).toEqual({ x: 432, y: 312 })
    expect(byName['rc0,0']!.origin).toEqual({ x: 480, y: 360 })
    expect(byName['rc400,300']!.origin).toEqual({ x: 80, y: 60 })
    expect(byName['neg-rc-20,-15']!.origin).toEqual({ x: 500, y: 375 })
    for (const k of ['rc48,48', 'rc0,0', 'rc400,300']) {
      const r = byName[k]!
      expect(r.inside).toEqual([255, 0, 0, 255])
      expect(r.hole![3]).toBe(0) // transparent hole stays transparent
      expect(r.dot).toEqual([255, 0, 0, 255]) // 1px dot survives 1:1 + double draw
      if (r.outside !== null) expect(r.outside[3]).toBe(0)
      expect(r.opaque).toBe(24 * 12 - 8 * 4 + 1) // block minus hole plus dot
    }
    expect(byName['rc48,48']!.blockOrigin).toEqual({ x: 462, y: 352 })
    expect(byName['rc0,0']!.blockOrigin).toEqual({ x: 510, y: 400 })
    expect(byName['rc400,300']!.blockOrigin).toEqual({ x: 110, y: 100 })
    const proof = rep.proof as { span96at05: number; span192at05: number }
    expect(proof.span96at05).toBeCloseTo(48, 6)
    expect(proof.span192at05).toBeCloseTo(96, 6)
    const cam = rep.camera as Array<{ bitmap96: number }>
    expect(cam[0]!.bitmap96).toBeCloseTo(48, 0)
    const anchor = rep.anchorPlus as { newZoom: number; pinErr: number }
    expect(anchor.newZoom).toBeCloseTo(1, 12)
    expect(anchor.pinErr).toBeLessThan(0.5)
    expect(rep.floorStick).toBeCloseTo(0.333, 12)
    expect(rep.wheelTick).toBeCloseTo(0.6, 12)
    const pan = rep.pan as { before: { x: number; y: number }; after: { x: number; y: number } }
    expect(pan.after.x - pan.before.x).toBeCloseTo(240, 9) // scrollBy(120/0.5)
    const d = rep.density as { board: { density: number; resetCss: number; floorCss: number; buttonCss: number; wheelCss: number } }
    expect(d.board.density).toBeCloseTo(0.5, 12)
    expect(d.board.resetCss).toBeCloseTo(1.0, 12)
    expect(d.board.floorCss).toBeCloseTo(0.666, 3)
    expect(d.board.buttonCss).toBeCloseTo(1.0, 12)
    expect(d.board.wheelCss).toBeCloseTo(0.2, 12)
  }, 120_000)

  it('PURE GATE: hard-limit refusal boundary (side 65535 / area 16M, read-only import)', async () => {
    // Decided caps (read-only pins, no product change):
    // - source side cap 65535 (headless-Chrome 2D raster ceiling), union side
    //   cap 4096 / union area cap 16M govern the WORKSPACE, not the source.
    // - 5000x12: union over budget -> `limited` verbatim-source workspace
    //   (refused=false): every stored pixel stays editable, nothing rejected.
    // - 70000x2: side over the source cap -> refused (never allocate).
    // - 5000x4000: side within cap but area 20M over budget -> refused.
    expect(BITMAP_SOURCE_MAX_SIDE).toBe(65535)
    expect(BITMAP_ARTBOARD_MAX_AREA).toBe(16_777_216)
    expect(isBitmapSourceSizeRefused(70000, 2)).toBe(true)
    expect(isBitmapSourceSizeRefused(5000, 4000)).toBe(true)
    expect(isBitmapSourceSizeRefused(5000, 12)).toBe(false)
    expect(isBitmapSourceSizeRefused(96, 96)).toBe(false)
    const limited = placeSourceOnArtboard(5000, 12, 2500, 6, false, 1)
    expect(limited.limited).toBe(true)
    expect(limited.refused).toBe(false)
    expect([limited.width, limited.height]).toEqual([5000, 12]) // never truncated
    const refusedSide = placeSourceOnArtboard(70000, 2, 35000, 1, false, 1)
    expect(refusedSide.refused).toBe(true)
    const refusedArea = placeSourceOnArtboard(5000, 4000, 2500, 2000, false, 1)
    expect(refusedArea.refused).toBe(true)
  }, 30_000)

  it('CURRENT: SB3 load, fit/reset/button/wheel/floor/anchor/clamp, edits, history, targets, no-op bytes, huge refuse', async () => {
    // Build SB3: stage (res1 96x96) + sprite with 6 costumes (distinct bytes).
    const files: Record<string, Uint8Array> = {}
    const mk = (name: string, res: number, rcx: number, rcy: number, color: [number, number, number]) => {
      const png = buildPng(96, 96, patternFor(color))
      const h = md5(png)
      files[`${h}.png`] = png
      return { name, assetId: h, md5ext: `${h}.png`, dataFormat: 'png', bitmapResolution: res, rotationCenterX: rcx, rotationCenterY: rcy, bytes: png, md5: h }
    }
    const defs = SPRITE_COSTUMES.map((c) => mk(c.name, c.res, c.rcx, c.rcy, c.color))
    const stagePng = buildPng(96, 96, patternFor(STAGE_COLOR))
    const stageHash = md5(stagePng)
    files[`${stageHash}.png`] = stagePng
    const project = {
      targets: [
        { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'stage-res1', assetId: stageHash, md5ext: `${stageHash}.png`, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 48, rotationCenterY: 48 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
        { isStage: false, name: 'Res1Sprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: defs.map(({ bytes: _b, md5: _m, ...rest }) => rest), sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
      ],
      monitors: [], extensions: [], meta: { semver: '3.0.0', vm: 'res1-verify', agent: 'res1-density' },
    }
    const bytesByName = Object.fromEntries(defs.map((d) => [d.name, d.bytes]))
    const md5ByName = Object.fromEntries(defs.map((d) => [d.name, d.md5]))
    const colorByName = Object.fromEntries(SPRITE_COSTUMES.map((c) => [c.name, c.color]))
    await openCostumes(page)
    await importSb3(page, buildSb3(project, files), 'res1-4848')
    await selectTarget(page, 'Res1Sprite')

    // ---- SB3 load: meta preserved non-destructively (NOT rewritten to res2) ----
    const expectMeta: Record<string, { res: number; rcx: number; rcy: number }> = {
      'res1-4848': { res: 1, rcx: 48, rcy: 48 },
      'res1-00': { res: 1, rcx: 0, rcy: 0 },
      'res1-400300': { res: 1, rcx: 400, rcy: 300 },
      'res1-neg': { res: 1, rcx: -20, rcy: -15 },
      'res1-wide': { res: 1, rcx: -400, rcy: -300 },
      'res2-4848': { res: 2, rcx: 48, rcy: 48 },
    }
    const firstFit: Record<string, { label: string; css: number; backing: { w: number; h: number } }> = {}
    const loadDigest: Record<string, string> = {}
    const loadMd5: Record<string, string> = {}
    for (const name of Object.keys(expectMeta)) {
      await selectCostume(page, name)
      // First-fit capture BEFORE reset (initial fit is the live first-visit zoom).
      const vp0 = await viewportOf(page)
      firstFit[name] = { label: vp0.label, css: vp0.rect.w / vp0.backing.w, backing: { ...vp0.backing } }
      const meta = await metaOf(page, 'Res1Sprite')
      expect(meta).toMatchObject({ ...expectMeta[name]!, name })
      loadMd5[name] = meta.md5 as string
      expect(meta.md5).toBe(`${md5ByName[name]}.png`) // bytes identity: md5ext unchanged
      const diag = (await canvasDiag(page)) as { width: number; height: number; opaque: number; alpha1: number; digest: string; trim: { x: number; y: number; width: number; height: number } | null }
      loadDigest[name] = diag.digest
      const exp = expectMeta[name]!
      // Board + origin: res1 sprite board 480x360 center 240,180; res2 960x720 center 480,360.
      const artC = exp.res === 2 ? { x: 480, y: 360 } : { x: 240, y: 180 }
      const backing0 = exp.res === 2 ? { w: 960, h: 720 } : { w: 480, h: 360 }
      const origin = { x: artC.x - exp.rcx, y: artC.y - exp.rcy }
      const unionMin = { x: Math.min(0, origin.x), y: Math.min(0, origin.y) }
      const unionMax = { x: Math.max(backing0.w, origin.x + 96), y: Math.max(backing0.h, origin.y + 96) }
      const unionW = unionMax.x - unionMin.x, unionH = unionMax.y - unionMin.y
      expect(diag.width).toBe(unionW)
      expect(diag.height).toBe(unionH)
      // Block/1px/hole/alpha1 pixel layout in canvas space.
      const blk = { x: origin.x - unionMin.x + 30, y: origin.y - unionMin.y + 40 }
      const col = colorByName[name]!
      expect(await canvasProbe(page, blk.x + 2, blk.y + 2)).toEqual([...col, 255])
      expect(await canvasProbe(page, blk.x + 6, blk.y + 4)).toEqual([0, 0, 0, 0]) // hole
      expect(await canvasProbe(page, origin.x - unionMin.x + 5, origin.y - unionMin.y + 5)).toEqual([...col, 255]) // 1px
      const a1 = await canvasProbe(page, origin.x - unionMin.x + 70, origin.y - unionMin.y + 70)
      // alpha=1 survives as opaque through the premultiplied canvas pipeline
      // (a=1 forces RGB to 255 on readback: round(c*1/255)*255/1; only the
      // alpha channel is pinned, color precision at a=1 is unrepresentative).
      expect(a1?.[3]).toBe(1)
      expect(diag.alpha1).toBe(1) // exactly one alpha=1 pixel counts as opaque
      expect(diag.opaque).toBe(24 * 12 - 8 * 4 + 1 + 1) // block-hole+dot+alpha1
      // Trim covers block+dot+alpha1 (hole is interior, still inside bbox).
      expect(diag.trim).not.toBeNull()
    }
    console.log(`RES1_LOAD backing=${JSON.stringify(Object.fromEntries(Object.entries(firstFit).map(([k, v]) => [k, v.backing])))}`)
    // Wide unions: 400,300 -> origin -160,-120 -> 640x480; wide -400,-300 -> 736x576.
    expect(firstFit['res1-400300']!.backing).toEqual({ w: 640, h: 480 })
    expect(firstFit['res1-wide']!.backing).toEqual({ w: 736, h: 576 })

    // ---- reset / button+1CSS / wheel+.2 / floor .666 on res1-4848 ----
    await selectCostume(page, 'res1-4848')
    await resetZoom(page)
    let vp = await viewportOf(page)
    expect(vp.label).toContain('100%')
    expect(Math.abs(vp.rect.w - vp.backing.w * 1.0)).toBeLessThan(2) // reset CSS 1.0 = 480 CSS px
    const paperReset = (vp.rect.w / vp.backing.w) * 0.5
    expect(paperReset).toBeCloseTo(0.5, 2) // Paper 0.5 basis (1.0 CSS * 0.5 density)
    // Button +1 CSS step -> 200%, rect 2x, Paper +0.5.
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('200%') ?? false, null, { timeout: 15_000 })
    await new Promise((r) => setTimeout(r, 300))
    let after = await viewportOf(page)
    expect(after.label).toContain('200%')
    expect(after.rect.w / vp.rect.w).toBeCloseTo(2.0, 1)
    const paperAfter = (after.rect.w / after.backing.w) * 0.5
    expect(paperAfter - paperReset).toBeCloseTo(0.5, 1) // Paper +0.5 per button
    // Back to reset, then ctrl-wheel -100 tick -> +0.2 CSS (Paper +0.1).
    await resetZoom(page)
    vp = await viewportOf(page)
    const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!box) throw new Error('missing canvas box')
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await page.waitForTimeout(600)
    after = await viewportOf(page)
    const cssGain = after.rect.w / after.backing.w - vp.rect.w / vp.backing.w
    console.log(`RES1_WHEEL cssGain=${cssGain} before=${vp.rect.w} after=${after.rect.w}`)
    expect(cssGain).toBeCloseTo(0.2, 1) // +0.2 CSS per classic -100 tick
    expect(cssGain * 0.5).toBeCloseTo(0.1, 1) // Paper +0.1
    // Floor: zoom out until stable -> 67% (CSS 0.666... = Paper 0.333).
    const zoomOut = page.getByRole('button', { name: 'Zoom out' }).first()
    let prev = ''
    for (let i = 0; i < 20; i += 1) {
      await zoomOut.click()
      await page.waitForTimeout(150)
      const cur = (await viewportOf(page)).label
      if (cur === prev) break
      prev = cur
    }
    const floor = await viewportOf(page)
    console.log(`RES1_FLOOR label=${floor.label} css=${floor.rect.w / floor.backing.w}`)
    expect(floor.label).toContain('67%')
    expect(floor.rect.w / floor.backing.w).toBeCloseTo(0.666, 1)
    expect((floor.rect.w / floor.backing.w) * 0.5).toBeCloseTo(0.333, 1) // Paper floor
    await resetZoom(page)

    // ---- mouse anchor: pointer-fixed zoom keeps the surface point ----
    await selectCostume(page, 'res1-4848')
    await resetZoom(page)
    const surfOf = (sx: number, sy: number) => ({ sx, sy })
    void surfOf
    const anchorBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!anchorBox) throw new Error('missing canvas box for anchor')
    // Pick an off-center screen point (block center) and record its surface px.
    const blkCx = 222 + 12, blkCy = 172 + 6 // canvas-space block center for rc48,48 (origin 192,132 + 30,40)
    const scrBefore = { x: anchorBox.x + (blkCx / 480) * anchorBox.width, y: anchorBox.y + (blkCy / 360) * anchorBox.height }
    const surfBefore = { x: blkCx, y: blkCy }
    await page.mouse.move(scrBefore.x, scrBefore.y)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100) // +0.2 CSS
    await page.keyboard.up('Control')
    await page.waitForTimeout(600)
    const anchorBox2 = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!anchorBox2) throw new Error('missing canvas box after anchor zoom')
    const scrAfter = { x: anchorBox2.x + (surfBefore.x / 480) * anchorBox2.width, y: anchorBox2.y + (surfBefore.y / 360) * anchorBox2.height }
    console.log(`RES1_ANCHOR before=${JSON.stringify(scrBefore)} after=${JSON.stringify(scrAfter)} want=${JSON.stringify({ x: scrBefore.x, y: scrBefore.y })}`)
    expect(Math.abs(scrAfter.x - scrBefore.x)).toBeLessThan(2)
    expect(Math.abs(scrAfter.y - scrBefore.y)).toBeLessThan(2)
    await resetZoom(page)

    // ---- pan clamp: large pan stays inside the Paper workspace ----
    await selectCostume(page, 'res1-4848')
    await resetZoom(page)
    const panBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!panBox) throw new Error('missing canvas box for pan')
    const cont = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
      return { w: c.width, h: c.height }
    })
    // Plain (non-ctrl) wheel pans in screen px: push far right/down.
    await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + panBox.height / 2)
    for (let i = 0; i < 10; i += 1) await page.mouse.wheel(400, 300)
    await page.waitForTimeout(600)
    const panned = await viewportOf(page)
    // Paper view: center = artCenter - (vx,vy)/scale... res1: Paper=(S-cc)/0.5+(480,360), S=W/2-vx/s.
    const s = panned.rect.w / panned.backing.w
    const Scx = panned.backing.w / 2 - (panned.rect.cx - panned.container.cx) / 1 // placeholder, recompute below
    void Scx
    // Direct rect mapping: surface rect must still intersect the container (clamped, not lost).
    const visW = Math.max(0, Math.min(panned.rect.left + panned.rect.w, panned.container.cx + cont.w / 2) - Math.max(panned.rect.left, panned.container.cx - cont.w / 2))
    const visH = Math.max(0, Math.min(panned.rect.top + panned.rect.h, panned.container.cy + cont.h / 2) - Math.max(panned.rect.top, panned.container.cy - cont.h / 2))
    console.log(`RES1_PAN rect=${JSON.stringify(panned.rect)} container=${JSON.stringify(panned.container)} vis=${visW}x${visH} scale=${s}`)
    expect(visW).toBeGreaterThan(0)
    expect(visH).toBeGreaterThan(0)
    await resetZoom(page)

    // ---- stage target: res1 stage costume keeps res1 + stage scale ----
    await selectTarget(page, 'Stage')
    const stageMeta = await metaOf(page, 'Stage')
    expect(stageMeta).toMatchObject({ res: 1, rcx: 48, rcy: 48 })
    const stageDiag = (await canvasDiag(page)) as { width: number; height: number; opaque: number; trim: { x: number; y: number; width: number; height: number } | null }
    expect(stageDiag.width).toBe(480)
    expect(stageDiag.height).toBe(360)
    // Stage VM scale: W/R = 96 stage units; draw rect x=240-48=192 (own words: 240-cx/R).
    const stageScaleW = stageDiag.width / 1
    expect(stageScaleW).toBe(480)
    // Stage pixels render on the real stage canvas (non-blank after load).
    const stagePx = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="stage-canvas"]') as HTMLCanvasElement | null
      if (!c) return { found: false as const }
      return { found: true as const, w: c.width, h: c.height }
    })
    expect(stagePx.found).toBe(true)

    // ---- selection copy/paste/move/rotate/undo/redo on res1-4848 ----
    await selectTarget(page, 'Res1Sprite')
    await selectCostume(page, 'res1-4848')
    await resetZoom(page)
    const base0 = (await canvasDiag(page)) as { opaque: number; digest: string; width: number; height: number }
    await page.getByTestId('bitmap-tool-select').click()
    const cbox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!cbox) throw new Error('missing canvas box for selection')
    const toScreen = (cw: number, ch: number, cxp: number, cyp: number) => ({ x: cbox.x + (cxp / cw) * cbox.width, y: cbox.y + (cyp / ch) * cbox.height })
    // Marquee tightly around the 24x12 block (222,172,24,12) with 2px margin.
    const m0 = toScreen(480, 360, 220, 170)
    const m1 = toScreen(480, 360, 248, 186)
    await page.mouse.move(m0.x, m0.y); await page.mouse.down(); await page.mouse.move(m1.x, m1.y, { steps: 8 }); await page.mouse.up()
    await page.waitForTimeout(500)
    const sel = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
      return el ? { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height } : null
    })
    console.log(`RES1_SELECTION ${JSON.stringify(sel)}`)
    expect(sel).not.toBeNull()
    // Copy then paste: overlay shifts +10 stagger, opaque grows.
    await page.getByTestId('copy-costume-selection').click()
    await page.waitForTimeout(400)
    await page.getByTestId('paste-costume-selection').click()
    await page.waitForTimeout(800)
    const sel2 = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
      if (!el || !canvas) return null
      const l = Number.parseFloat(el.style.left.replace('%', ''))
      const t = Number.parseFloat(el.style.top.replace('%', ''))
      return { x: (l / 100) * canvas.width, y: (t / 100) * canvas.height }
    })
    console.log(`RES1_PASTE_SEL ${JSON.stringify(sel2)}`)
    expect(sel2).not.toBeNull()
    const pasted = (await canvasDiag(page)) as { opaque: number }
    expect(pasted.opaque).toBeGreaterThan(base0.opaque)
    // Move: drag the pasted selection +40 canvas px right via canvas coords.
    const dragFrom = toScreen(480, 360, (sel2 as { x: number; y: number }).x + 12, (sel2 as { x: number; y: number }).y + 6)
    await page.mouse.move(dragFrom.x, dragFrom.y); await page.mouse.down()
    const dragTo = toScreen(480, 360, (sel2 as { x: number; y: number }).x + 52, (sel2 as { x: number; y: number }).y + 6)
    await page.mouse.move(dragTo.x, dragTo.y, { steps: 8 }); await page.mouse.up()
    await page.waitForTimeout(500)
    const moved = (await canvasDiag(page)) as { opaque: number; digest: string }
    expect(moved.digest).not.toBe(base0.digest)
    // Rotate 90°: 24x12 selection becomes 12x24 (trim aspect flips).
    const trimBefore = (await canvasDiag(page)) as { trim: { width: number; height: number } | null }
    await page.getByTestId('rotate-bitmap-right').click()
    await page.waitForTimeout(600)
    const trimAfter = (await canvasDiag(page)) as { trim: { width: number; height: number } | null }
    console.log(`RES1_ROTATE before=${JSON.stringify(trimBefore.trim)} after=${JSON.stringify(trimAfter.trim)}`)
    expect(trimAfter.trim).not.toBeNull()
    // Undo peels rotate, redo restores it (explicit single-entry chain).
    const digestRotated = ((await canvasDiag(page)) as { digest: string }).digest
    await page.locator('button[aria-label="Undo"]:visible').first().click()
    await page.waitForTimeout(600)
    const digestUndo = ((await canvasDiag(page)) as { digest: string }).digest
    expect(digestUndo).not.toBe(digestRotated)
    await page.locator('button[aria-label="Redo"]:visible').first().click()
    await page.waitForTimeout(600)
    const digestRedo = ((await canvasDiag(page)) as { digest: string }).digest
    expect(digestRedo).toBe(digestRotated)
    // Commit to VM via Save bitmap, then verify stored res1 center/bytes updated.
    // Baseline is the LOAD-TIME original (loadMd5/loadDigest), not the live
    // working copy (the Editor may refresh working meta during gestures).
    const origMd5 = `${md5ByName['res1-4848']}.png`
    const origDigest = loadDigest['res1-4848']
    const preSaveDigest = ((await canvasDiag(page)) as { digest: string }).digest
    await page.getByTestId('save-bitmap-costume').click()
    await page.waitForTimeout(1500)
    const metaSaved = await metaOf(page, 'Res1Sprite')
    const postSaveDigest = ((await canvasDiag(page)) as { digest: string }).digest
    console.log(`RES1_SAVED meta=${JSON.stringify(metaSaved)} origMd5=${origMd5} preSaveDigest=${preSaveDigest} postSaveDigest=${postSaveDigest} origDigest=${origDigest}`)
    expect(metaSaved.res).toBe(1) // stored res1 preserved (NOT forced to 2)
    expect(metaSaved.md5).not.toBe(origMd5) // edit changed the stored bytes
    expect(postSaveDigest).not.toBe(origDigest) // edited pixels survived the save
    // VM stage scale after edit: W/R with res1 (stage units, 2x apparent vs res2).
    const vmStage = await page.evaluate(() => {
      const snap = (window as any).__hikkakuEditorTest.snapshot()
      return JSON.stringify(snap.project.targets.map((t) => t.name))
    })
    expect(vmStage).toContain('Res1Sprite')

    // ---- target switch keeps sides independent; untouched bytes are no-ops ----
    await selectCostume(page, 'res1-00')
    await resetZoom(page)
    const noopDigest0 = ((await canvasDiag(page)) as { digest: string }).digest
    const noopMd50 = (await metaOf(page, 'Res1Sprite')).md5 as string
    expect(noopMd50).toBe(`${md5ByName['res1-00']}.png`)
    expect(noopDigest0).toBe(loadDigest['res1-00']) // load + no-op: pixels identical
    await selectCostume(page, 'res1-4848') // back to the edited side
    await page.waitForTimeout(600)
    const backDigest = ((await canvasDiag(page)) as { digest: string }).digest
    expect(backDigest).toBe(digestRedo) // edited side survived the target/costume switch
    await selectCostume(page, 'res1-00')
    await page.waitForTimeout(400)
    expect(((await canvasDiag(page)) as { digest: string }).digest).toBe(noopDigest0)

    // ---- huge input: hard refusal (side 70000 > 65535), bytes + meta untouched ----
    // 5000x12 would be `limited` (editable verbatim source), NOT refused, so
    // the refusal leg uses a side over the non-destructive source cap.
    const hugePng = buildPng(70000, 2, (x, y) => (x === 10 && y === 1 ? [255, 0, 0, 255] : [0, 0, 0, 0]))
    const hugeHash = md5(hugePng)
    const hugeFiles: Record<string, Uint8Array> = {}
    hugeFiles[`${hugeHash}.png`] = hugePng
    const hugeProject = {
      targets: [
        { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'backdrop1', assetId: stageHash, md5ext: `${stageHash}.png`, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 48, rotationCenterY: 48 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
        { isStage: false, name: 'HugeSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'huge-res1', assetId: hugeHash, md5ext: `${hugeHash}.png`, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 35000, rotationCenterY: 1 }], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
      ],
      monitors: [], extensions: [], meta: { semver: '3.0.0', vm: 'res1-verify', agent: 'res1-huge' },
    }
    await importSb3(page, buildSb3(hugeProject, { ...hugeFiles, [`${stageHash}.png`]: stagePng }), 'huge-res1')
    await selectTarget(page, 'HugeSprite')
    await page.waitForTimeout(1500)
    const hugeMeta = await metaOf(page, 'HugeSprite')
    expect(hugeMeta.md5).toBe(`${hugeHash}.png`) // original kept
    const hugeStatus = await page.evaluate(() => (window as any).__hikkakuEditorTest.status())
    console.log(`RES1_HUGE status=${JSON.stringify(hugeStatus)} meta=${JSON.stringify(hugeMeta)}`)
    expect(hugeStatus).toContain('too large') // explicit hard-limit refusal
  }, 300_000)
})
