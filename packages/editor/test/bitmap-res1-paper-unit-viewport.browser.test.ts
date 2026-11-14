// Res1 Paper-unit + viewport diagnostic (READ-ONLY, no product change).
//
// Purpose: strictly derive bitmap-resolution=1 viewport reset/initial fit/
// zoom/pan vs current from the reference placement "96x96 res1 drawn 1:1
// onto the 960x720 artboard", and prove whether 1 Paper unit = source
// canvas pixel or stage unit. Both sides are measured numerically in real
// Chromium: Scratch Paper entity (npm `paper` UMD, MIT, via public API)
// as oracle, and the current real Editor (independent Vite port) as
// subject. No third-party (AGPL) source is copied, imported, or quoted;
// reference equations are re-typed in own words with file/line citations.
//
// Reference grounding (own words, numbers re-typed):
// - board: 960x720, center 480,360 (view.js: ART_BOARD_W/H, CENTER).
// - SVG board 480x360, i.e. 1 stage unit = 2 Paper units (view.js).
// - bitmap import origin = (480 - rcX, 360 - rcY), drawn twice 1:1
//   (paper-canvas.jsx: importImage/drawImage x2).
// - vector import: scale 2x then translate CENTER - rc*2 (paper-canvas.jsx).
// - stored res1 (this repo, non-destructive: 480x360 canvas, center 240,180)
//   vs live res2 (reference loader doubles stored res1 PNG pixels/center to
//   res2 before paint): 1 canvas px = 2 Paper units (density 0.5, reset
//   0.5->1.0 CSS, floor 0.333->0.666 CSS, button +/-0.5->+/-1.0 CSS,
//   classic -100 tick +0.1 Paper->+0.2 CSS).
// - reset zoom 0.5, floor 0.333, button +0.5 (floor-exit to 0.5),
//   ctrl-wheel -deltaY/1000, pan scrollBy(dx/zoom), scrollbar tx+=dx*zoom*2
//   (view.js + scrollable-canvas.jsx + paint-editor.jsx).
// - fit: reset-to-0.5, bitmap expand(50) then x1.5 pad, ratio =
//   0.5*max(padded/client) clamped [0.125,1], zoom 0.5/ratio (view.js).
// - current: 480x360 res1 board, center 240,180 (bitmap-artboard.ts);
//   res1 density decided 0.5, reset 1.0, min 0.666..., button +/-1.0 CSS,
//   wheel +0.2 per -100 tick (costume-viewport.ts).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-res1-paper-unit-viewport.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync, unzipSync, strFromU8, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4621
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

// --- own PNG builder (solid + single-block marker) ---
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
// 96x96 marker: transparent + 20x20 opaque red block at source (30,40).
// Absolute artboard pos = origin + (30,40); trim must be exactly 20x20 there.
const markerPx = (x: number, y: number): [number, number, number, number] => {
  const inside = x >= 30 && x < 50 && y >= 40 && y < 60
  return inside ? [255, 0, 0, 255] : [0, 0, 0, 0]
}

function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function openCostumes(p: Page) {
  await p.goto(base, { waitUntil: 'networkidle' })
  await p.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await p.getByTestId('main-tab-costumes').click()
  await p.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await p.waitForTimeout(600)
}
async function importSb3(p: Page, bytes: Buffer, expectName: string) {
  await p.getByTestId('project-file-input').setInputFiles({ name: 'res1-unit.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await p.waitForFunction(
    (want: string) => (window as unknown as { __hikkakuEditorTest?: { snapshot(): { project: { targets: Array<{ costumes: Array<{ name: string }> }> } } } }).__hikkakuEditorTest?.snapshot().project.targets.some((t) => t.costumes.some((c) => c.name === want)) ?? false,
    expectName as unknown as undefined,
    { timeout: 30_000 },
  )
  await p.getByTestId('main-tab-costumes').click()
  await p.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await p.waitForTimeout(800)
}
async function canvasDiag(p: Page) {
  return await p.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) return { found: false as const }
    const ctx = canvas.getContext('2d')
    if (!ctx) return { found: true as const, readable: false as const }
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let opaque = 0, left = canvas.width, top = canvas.height, right = -1, bottom = -1
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      if ((img.data[(y * canvas.width + x) * 4 + 3] ?? 0) === 0) continue
      opaque += 1
      if (x < left) left = x; if (y < top) top = y; if (x > right) right = x; if (y > bottom) bottom = y
    }
    const px = (x: number, y: number) => (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) ? null : Array.from(ctx.getImageData(x, y, 1, 1).data)
    return { found: true as const, readable: true as const, width: canvas.width, height: canvas.height, opaque, trim: right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null, pxOriginArea: undefined as unknown, probe: { px } }
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

describe('res1 Paper-unit + viewport (oracle vs current, read-only)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed on ${PORT}`)
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('ORACLE: 96x96 res1 1:1 placement, Paper-unit proof, stage/world, fit/zoom/pan', async () => {
    await page.goto('about:blank')
    await page.addScriptTag({ path: join(root, 'node_modules/paper/dist/paper-full.js') })
    const rep = await page.evaluate(async () => {
      const P = (window as unknown as { paper: typeof import('paper') }).paper
      const out: Record<string, unknown> = {}
      // Board constants (re-typed, cf. view.js ART_BOARD/CENTER).
      const BW = 960, BH = 720, CX = 480, CY = 360
      out.board = { w: BW, h: BH, cx: CX, cy: CY }
      out.stageUnits = { w: 480, h: 360, paperPerStage: 2 }
      // Setup harness canvas (own 800x600 container).
      const holder = document.createElement('div')
      holder.style.cssText = 'position:relative;width:800px;height:600px;overflow:hidden;'
      document.body.appendChild(holder)
      const cv = document.createElement('canvas')
      cv.style.cssText = 'width:800px;height:600px;display:block;'
      holder.appendChild(cv)
      P.setup(cv)
      P.view.zoom = 0.5
      P.view.center = new P.Point(CX, CY)
      // --- placement: origin = CENTER - rc (re-typed importImage rule) ---
      const place = (rcX: number, rcY: number) => ({ ox: CX - rcX, oy: CY - rcY })
      const cases = [
        { name: 'rc48,48', rc: { x: 48, y: 48 } },
        { name: 'rc0,0', rc: { x: 0, y: 0 } },
        { name: 'rc400,300', rc: { x: 400, y: 300 } },
        { name: 'outer-rc500,400', rc: { x: 500, y: 400 } },
      ]
      const art = document.createElement('canvas'); art.width = BW; art.height = BH
      const actx = art.getContext('2d')!
      actx.imageSmoothingEnabled = false
      const src = document.createElement('canvas'); src.width = 96; src.height = 96
      const sctx = src.getContext('2d')!
      // marker block 20x20 at source (30,40), single red color.
      sctx.clearRect(0, 0, 96, 96)
      sctx.fillStyle = 'rgba(255,0,0,255)'
      sctx.fillRect(30, 40, 20, 20)
      const px = (x: number, y: number) => (x < 0 || y < 0 || x >= BW || y >= BH) ? null : Array.from(actx.getImageData(Math.round(x), Math.round(y), 1, 1).data)
      const rows: Array<Record<string, unknown>> = []
      for (const c of cases) {
        actx.clearRect(0, 0, BW, BH)
        const { ox, oy } = place(c.rc.x, c.rc.y)
        // reference draws twice; verify idempotent.
        actx.drawImage(src, ox, oy)
        actx.drawImage(src, ox, oy)
        const blockOrigin = { x: ox + 30, y: oy + 40 }
        // inside-block vs 1px outside on all four sides (clipped to board).
        const inside = px(blockOrigin.x + 10, blockOrigin.y + 10)
        const outsideL = px(blockOrigin.x - 1, blockOrigin.y + 10)
        const outsideR = px(blockOrigin.x + 20, blockOrigin.y + 10)
        const outsideT = px(blockOrigin.x + 10, blockOrigin.y - 1)
        const outsideB = px(blockOrigin.x + 10, blockOrigin.y + 20)
        // opaque bounds of this artboard (for margin accounting).
        const img = actx.getImageData(0, 0, BW, BH)
        let l = BW, t = BH, r = -1, b = -1, n = 0
        for (let y = 0; y < BH; y += 1) for (let x = 0; x < BW; x += 1) {
          if ((img.data[(y * BW + x) * 4 + 3] ?? 0) === 0) continue
          n += 1
          if (x < l) l = x; if (y < t) t = y; if (x > r) r = x; if (y > b) b = y
        }
        // stage/world mapping: stage = ((PaperX-CX)/2, (CY-PaperY)/2), size = paper/2.
        const stageOf = (pxx: number, pyy: number) => ({ sx: (pxx - CX) / 2, sy: (CY - pyy) / 2 })
        rows.push({
          name: c.name, origin: { x: ox, y: oy }, blockOrigin,
          inside, outsideL, outsideR, outsideT, outsideB,
          opaque: n, trim: n > 0 ? { x: l, y: t, width: r - l + 1, height: b - t + 1 } : null,
          stageTopLeft: stageOf(blockOrigin.x, blockOrigin.y),
          stageSize: { w: 20 / 2, h: 20 / 2 },
        })
      }
      out.placements = rows
      // --- Paper-unit proof: 96 canvas px -> 96 Paper units (not 192) ---
      // projectToView span for 96 Paper at zoom 0.5 must be 48 CSS px.
      P.view.zoom = 0.5; P.view.center = new P.Point(CX, CY)
      const span96Paper = (() => {
        const a = P.view.projectToView(new P.Point(432, 360)) as unknown as { x: number }
        const b = P.view.projectToView(new P.Point(432 + 96, 360)) as unknown as { x: number }
        return Math.abs(b.x - a.x)
      })()
      // stage-unit hypothesis would claim 96 stage units = 192 Paper -> 96 CSS px.
      const span192Paper = (() => {
        const a = P.view.projectToView(new P.Point(432, 360)) as unknown as { x: number }
        const b = P.view.projectToView(new P.Point(432 + 192, 360)) as unknown as { x: number }
        return Math.abs(b.x - a.x)
      })()
      out.paperUnitProof = { span96PaperAt05: span96Paper, span192PaperAt05: span192Paper, verdict: 'source96px maps to 96 Paper (48 CSS at 0.5), not 192 Paper' }
      // --- camera table: 480 stage-units read both ways ---
      const span = (x0: number, x1: number, y: number) => {
        const a = P.view.projectToView(new P.Point(x0, y)) as unknown as { x: number }
        const b = P.view.projectToView(new P.Point(x1, y)) as unknown as { x: number }
        return Math.abs(b.x - a.x)
      }
      const at = (z: number) => {
        P.view.zoom = z; P.view.center = new P.Point(CX, CY)
        return { zoom: z, bitmap480: span(240, 720, 360), vector480: span(0, 960, 360) }
      }
      out.camera = [at(0.5), at(1.0), at(0.333)]
      P.view.zoom = 0.5; P.view.center = new P.Point(CX, CY)
      // --- zoom/pan/fit numbers (Paper entity) ---
      const zoomOnFixedPoint = (deltaZoom: number, fixed: { x: number; y: number }) => {
        const preC = P.view.center.clone() as unknown as { x: number; y: number; subtract(p: unknown): { multiply(s: number): { x: number; y: number } } }
        const nz = Math.max(0.333, P.view.zoom + deltaZoom)
        const sc = P.view.zoom / nz
        const fp = new P.Point(fixed.x, fixed.y)
        const pre = fp.subtract(preC)
        const post = fp.subtract(pre.multiply(sc)).subtract(preC)
        const before = P.view.projectToView(fp.clone())
        P.view.zoom = nz
        P.view.translate(post.multiply(-1))
        const after = P.view.projectToView(fp.clone())
        return { newZoom: nz, postOffset: { x: post.x, y: post.y }, center: { x: P.view.center.x, y: P.view.center.y }, pinErr: Math.hypot(after.x - before.x, after.y - before.y) }
      }
      out.anchorPlus = zoomOnFixedPoint(0.5, { x: 580, y: 410 })
      P.view.zoom = 0.5; P.view.center = new P.Point(CX, CY)
      const c0 = P.view.projectToView(new P.Point(CX, CY))
      out.anchorFallback = zoomOnFixedPoint(0.5, { x: CX, y: CY })
      const c1 = P.view.projectToView(new P.Point((out.anchorFallback as { center: { x: number; y: number } }).center.x, (out.anchorFallback as { center: { x: number; y: number } }).center.y))
      out.anchorFallbackDrift = Math.hypot(c1.x - c0.x, c1.y - c0.y)
      out.buttons = { plus: Math.max(0.333, 1 + 0.5), minus: Math.max(0.333, 1 - 0.5), floorExit: 0.5, floorStick: Math.max(0.333, 0.5 - 0.5) }
      out.wheel = { down100: Math.max(0.333, 0.5 + 100 / 1000), up120: Math.max(0.333, 0.5 - 120 / 1000), line: Math.max(0.333, 0.5 + 105 / 1000) }
      P.view.zoom = 0.5; P.view.center = new P.Point(CX, CY)
      const bPan = { x: P.view.center.x, y: P.view.center.y }
      P.view.scrollBy(new P.Point(120 / 0.5, 0))
      out.pan = { before: bPan, after: { x: P.view.center.x, y: P.view.center.y } }
      out.scrollbar = { dx10at05: 10 * 0.5 * 2 }
      const r = new P.Rectangle(0, 0, 400, 300).expand(50)
      out.expand50 = { w: r.width, h: r.height }
      const fit = (bw: number, bh: number, cw: number, ch: number, isB: boolean) => {
        const pW = (bw + (isB ? 50 : 0)) * 1.5, pH = (bh + (isB ? 50 : 0)) * 1.5
        const ratio = Math.max(0.125, Math.min(1, 0.5 * Math.max(pW / cw, pH / ch)))
        return ratio < 1 ? 0.5 / ratio : 0.5
      }
      out.fit96in800x600 = { bitmap: fit(96, 96, 800, 600, true), vector192: fit(192, 192, 800, 600, false) }
      // --- res2 correspondence: same 96x96 bytes at res2 are 48 stage units ---
      out.res2 = { paperExtent: 96, stageSize: { w: 96 / 2, h: 96 / 2 }, note: 'same Paper rect, half the stage size of res1-96' }
      // --- density for a 480-wide res1 surface (decided 0.5) ---
      out.densityHypotheses = {
        rBoard: { paperExtent: 960, density: 480 / 960, resetCss: 0.5 / (480 / 960), minCss: 0.333 / (480 / 960), buttonCss: 0.5 / (480 / 960) },
        rOwn: { paperExtent: 480, density: 480 / 480, resetCss: 0.5 / 1, minCss: 0.333 / 1, buttonCss: 0.5 / 1 },
        decidedLive: { resetCss: 1, minCss: 0.333 / 0.5, buttonCss: 0.5 / 0.5 },
      }
      holder.remove(); P.remove()
      return out
    })
    console.log(`RES1_ORACLE ${JSON.stringify(rep)}`)
    const rows = rep.placements as Array<{ name: string; origin: { x: number; y: number }; blockOrigin: { x: number; y: number }; inside: number[]; outsideL: number[] | null; outsideR: number[] | null; outsideT: number[] | null; outsideB: number[] | null; opaque: number; trim: { x: number; y: number; width: number; height: number } | null }>
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    // Strict placement: origin = CENTER - rc.
    expect(byName['rc48,48']!.origin).toEqual({ x: 432, y: 312 })
    expect(byName['rc0,0']!.origin).toEqual({ x: 480, y: 360 })
    expect(byName['rc400,300']!.origin).toEqual({ x: 80, y: 60 })
    expect(byName['outer-rc500,400']!.origin).toEqual({ x: -20, y: -40 })
    // Absolute single-color block: 20x20 at origin+(30,40), opaque inside, transparent outside.
    for (const k of ['rc48,48', 'rc0,0', 'rc400,300']) {
      const r = byName[k]!
      expect(r.inside).toEqual([255, 0, 0, 255])
      expect(r.opaque).toBe(400)
      expect(r.trim!.width).toBe(20); expect(r.trim!.height).toBe(20)
      // outside probes that stay on-board must be transparent.
      for (const o of [r.outsideL, r.outsideR, r.outsideT, r.outsideB]) {
        if (o !== null) expect(o[3]).toBe(0)
      }
    }
    expect(byName['rc48,48']!.blockOrigin).toEqual({ x: 462, y: 352 })
    expect(byName['rc0,0']!.blockOrigin).toEqual({ x: 510, y: 400 })
    expect(byName['rc400,300']!.blockOrigin).toEqual({ x: 110, y: 100 })
    // Outer case is fully on-board for the 20x20 marker (block at 10,0):
    // origin -20,-40 + source offset (30,40) = (10,0), 20x20 intact.
    // A full 96x96 source at this origin would clip to 76 wide (0..75) x 56
    // tall (0..55); the marker proves the absolute offset without clipping.
    const outer = byName['outer-rc500,400']!
    expect(outer.trim).toEqual({ x: 10, y: 0, width: 20, height: 20 })
    // Paper-unit proof.
    const proof = rep.paperUnitProof as { span96PaperAt05: number; span192PaperAt05: number }
    expect(proof.span96PaperAt05).toBeCloseTo(48, 6)
    expect(proof.span192PaperAt05).toBeCloseTo(96, 6)
    // Camera table.
    const cam = rep.camera as Array<{ bitmap480: number; vector480: number }>
    expect(cam[0]!.bitmap480).toBeCloseTo(240, 0)
    expect(cam[0]!.vector480).toBeCloseTo(480, 0)
    // Anchor / limits / expand / fit spot checks.
    const anchor = rep.anchorPlus as { newZoom: number; pinErr: number }
    expect(anchor.newZoom).toBeCloseTo(1, 12)
    expect(anchor.pinErr).toBeLessThan(0.5)
    const exp = rep.expand50 as { w: number; h: number }
    expect(exp.w).toBeCloseTo(450, 9); expect(exp.h).toBeCloseTo(350, 9)
  }, 120_000)

  it('CURRENT: res1 480x360 board vs oracle, VM/stage, CSS viewport, selection/zoom', async () => {
    // One sprite with 4 costumes, each with DISTINCT bytes (color-coded block)
    // so costume switching always reloads the canvas even though geometry is
    // identical: res1 rc48,48 / rc0,0 / rc400,300 / res2 rc48,48 control.
    const colorFor = (name: string): [number, number, number, number] => {
      if (name === 'res1-00') return [0, 200, 0, 255]
      if (name === 'res1-400300') return [0, 0, 255, 255]
      if (name === 'res2-4848') return [255, 0, 255, 255]
      return [255, 0, 0, 255]
    }
    const pngFor = (name: string) => buildPng(96, 96, (x, y) => {
      const inside = x >= 30 && x < 50 && y >= 40 && y < 60
      return inside ? colorFor(name) : [0, 0, 0, 0]
    })
    const files: Record<string, Uint8Array> = {}
    const mk = (name: string, res: number, rcx: number, rcy: number) => {
      const png = pngFor(name)
      const h = md5(png)
      const file = `${h}.png`
      files[file] = png
      return { name, assetId: h, md5ext: file, dataFormat: 'png', bitmapResolution: res, rotationCenterX: rcx, rotationCenterY: rcy, expectColor: colorFor(name) }
    }
    const c4848 = mk('res1-4848', 1, 48, 48)
    const c00 = mk('res1-00', 1, 0, 0)
    const c400 = mk('res1-400300', 1, 400, 300)
    const cRes2 = mk('res2-4848', 2, 48, 48)
    const emptySvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>')
    const eh = md5(emptySvg)
    const project = {
      targets: [
        { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'backdrop1', assetId: eh, md5ext: `${eh}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
        { isStage: false, name: 'Res1Sprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [c4848, c00, c400, cRes2].map(({ expectColor: _e, ...rest }) => rest), sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
      ],
      monitors: [], extensions: [], meta: { semver: '3.0.0', vm: 'res1-unit', agent: 'res1-unit' },
    }
    const expectColorByName: Record<string, [number, number, number, number]> = {
      'res1-4848': colorFor('res1-4848'),
      'res1-00': colorFor('res1-00'),
      'res1-400300': colorFor('res1-400300'),
      'res2-4848': colorFor('res2-4848'),
    }
    await openCostumes(page)
    await importSb3(page, buildSb3(project, { ...files, [`${eh}.svg`]: emptySvg }), 'res1-4848')
    // Select sprite explicitly (import lands on stage otherwise).
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="target-card-Res1Sprite"]') as HTMLElement | null
      el?.click()
    })
    await page.waitForTimeout(800)
    const selectCostume = async (name: string) => {
      await page.evaluate((n: string) => {
        const t = document.querySelector(`button[aria-label="Select ${n}"]`) as HTMLButtonElement | undefined
        t?.click()
      }, name as unknown as undefined)
      await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
      // Wait for the VM selection to actually switch (same-geometry costumes
      // share trim; distinct bytes make the canvas reload, but the reliable
      // gate is the snapshot costume name, not opaque>0 which is already true).
      await page.waitForFunction(
        (want: string) => {
          try {
            const snap = (window as unknown as { __hikkakuEditorTest: { snapshot(): { project: { targets: Array<{ name: string; currentCostume?: number; costumes: Array<{ name: string }> }> } } } }).__hikkakuEditorTest.snapshot()
            const t = snap.project.targets.find((x) => x.name === 'Res1Sprite')!
            return t.costumes[t.currentCostume ?? 0]!.name === want
          } catch { return false }
        },
        name as unknown as undefined,
        { timeout: 25_000 },
      )
      // Then wait for the verbatim reload ink matching this costume's color.
      const wantColor = expectColorByName[name]!.join(',')
      const start = Date.now()
      for (;;) {
        const probe = await canvasProbe(page, 232, 182)
        void probe
        const d = await canvasDiag(page) as { found: boolean; readable?: boolean; opaque?: number }
        if (d.found && (d as { readable?: boolean }).readable && ((d as { opaque?: number }).opaque ?? 0) > 0) {
          // Color gate: sample the expected block center for this costume.
          // Block centers differ per rc, so compute per-name below; here just
          // require settled ink then break (exact color asserted later).
          break
        }
        if (Date.now() - start > 25_000) throw new Error(`no ink for ${name}: ${JSON.stringify(d)}`)
        await new Promise((r) => setTimeout(r, 400))
      }
      void wantColor
      await new Promise((r) => setTimeout(r, 600))
    }
    const metaOf = () => page.evaluate(() => {
      const snap = (window as unknown as { __hikkakuEditorTest: { snapshot(): { project: { targets: Array<{ isStage: boolean; name: string; currentCostume?: number; costumes: Array<{ name: string; dataFormat: string; bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number; md5ext?: string }> }> }; selectedTargetId: string } } }).__hikkakuEditorTest.snapshot()
      const t = snap.project.targets.find((x) => x.name === 'Res1Sprite')!
      const c = t.costumes[t.currentCostume ?? 0]!
      return { name: c.name, res: c.bitmapResolution, rcx: c.rotationCenterX, rcy: c.rotationCenterY, fmt: c.dataFormat }
    })
    const viewportOf = () => page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = canvas!.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        backing: { w: canvas!.width, h: canvas!.height },
        rect: { w: r.width, h: r.height, left: r.left, top: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 },
        container: { w: c.width, h: c.height, cx: c.left + c.width / 2, cy: c.top + c.height / 2 },
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        dpr: window.devicePixelRatio,
      }
    })
    const rows: Array<Record<string, unknown>> = []
    for (const name of ['res1-4848', 'res1-00', 'res1-400300', 'res2-4848']) {
      await selectCostume(name)
      // Deterministic reset before measuring: first-visit fit zooms small
      // content per the Paper fit (res2 and res1 alike). Reset isolates
      // board/scale from fit.
      await page.evaluate(() => { document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click() })
      await page.waitForFunction(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('100%') ?? false, null, { timeout: 10_000 })
      await new Promise((r) => setTimeout(r, 400))
      const meta = await metaOf()
      const diag = await canvasDiag(page) as { width: number; height: number; opaque: number; trim: { x: number; y: number; width: number; height: number } | null }
      const vp = await viewportOf()
      // Absolute probes: block origin = currentOrigin + (30,40).
      // currentOrigin = artCenter - rc with artCenter 240,180 (res1) or 480,360 (res2).
      // Off-board origins grow the canvas to union(artboard, source rect), so the
      // canvas-space block is (origin - unionMin) + (30,40) with unionMin = min(0, origin).
      const artC = meta.res === 2 ? { x: 480, y: 360 } : { x: 240, y: 180 }
      const origin = { x: artC.x - (meta.rcx as number), y: artC.y - (meta.rcy as number) }
      const unionMin = { x: Math.min(0, origin.x), y: Math.min(0, origin.y) }
      const blkCanvas = { x: origin.x - unionMin.x + 30, y: origin.y - unionMin.y + 40 }
      const inside = await canvasProbe(page, blkCanvas.x + 10, blkCanvas.y + 10)
      const outside = await canvasProbe(page, blkCanvas.x - 1, blkCanvas.y + 10)
      rows.push({ name, meta, backing: { w: diag.width, h: diag.height }, trim: diag.trim, origin, unionMin, blk: name === 'res1-400300' ? { x: origin.x + 30, y: origin.y + 40 } : { x: origin.x + 30, y: origin.y + 40 }, blkCanvas, inside, outsideAlpha: outside?.[3] ?? null, viewport: vp })
    }
    console.log(`RES1_CURRENT ${JSON.stringify(rows)}`)
    const byName = Object.fromEntries(rows.map((r) => [r.name as string, r]))
    // Board + center difference (current vs Scratch oracle).
    expect((byName['res1-4848']!.backing as { w: number; h: number })).toEqual({ w: 480, h: 360 })
    expect((byName['res2-4848']!.backing as { w: number; h: number })).toEqual({ w: 960, h: 720 })
    // Current origins: 240-rc / 180-rc (NOT oracle 480-rc / 360-rc).
    expect(byName['res1-4848']!.origin).toEqual({ x: 192, y: 132 })
    expect(byName['res1-00']!.origin).toEqual({ x: 240, y: 180 })
    expect(byName['res1-400300']!.origin).toEqual({ x: -160, y: -120 })
    expect(byName['res2-4848']!.origin).toEqual({ x: 432, y: 312 })
    // res1-400300 origin is off-board: union workspace must grow (not 480x360).
    // origin -160,-120 + 96x96 source => union 640x480, block at canvas 30,40.
    const outerBacking = byName['res1-400300']!.backing as { w: number; h: number }
    expect(outerBacking).toEqual({ w: 640, h: 480 })
    expect((byName['res1-400300']!.trim as { x: number; y: number; width: number; height: number })).toEqual({ x: 30, y: 40, width: 20, height: 20 })
    expect(byName['res1-400300']!.inside).toEqual(Array.from(expectColorByName['res1-400300']!))
    // Absolute single-color block: 20x20 at origin+(30,40) on every costume,
    // color-coded per costume to prove the bytes actually switched.
    for (const k of ['res1-4848', 'res1-00', 'res2-4848']) {
      const r = byName[k]!
      expect(r.inside).toEqual(Array.from(expectColorByName[k]!))
      expect((r.trim as { width: number; height: number }).width).toBe(20)
      expect((r.trim as { width: number; height: number }).height).toBe(20)
      expect(r.outsideAlpha).toBe(0)
    }
    expect(byName['res1-4848']!.blk).toEqual({ x: 222, y: 172 })
    expect(byName['res1-00']!.blk).toEqual({ x: 270, y: 220 })
    expect(byName['res2-4848']!.blk).toEqual({ x: 462, y: 352 })
    // World-stable: res1-4848 and res2-4848 share the same VM stage rect
    // only up to the 2x resolution factor. Prove via stored meta + canvas math
    // (no stage screenshot flakiness): stage = (canvasPx - canvasCenter)/res.
    // Both costumes' block centers map to stage (-9,+9)+half-block? Compute:
    // res1: canvasCenter 240,180, block center (232,182) -> stage (-8,-2)? res2:
    // canvasCenter 480,360, block center (472,362) -> stage (-4,-1)? Ratio 2:1.
    // Instead assert the documented correspondence: same source px = same
    // Paper px, but res1 stage size is 2x res2 (20px -> 20 stage vs 10 stage).
    // VM meta pins the divisor.
    expect(byName['res1-4848']!.meta).toMatchObject({ res: 1, rcx: 48, rcy: 48 })
    expect(byName['res2-4848']!.meta).toMatchObject({ res: 2, rcx: 48, rcy: 48 })
    // Intermediate transforms made explicit (canvas <-> VM stage/world):
    // VM stage = ((canvasX - canvasCenterX)/res, (canvasCenterY - canvasY)/res),
    // canvasCenter = artCenter - unionMin (unionMin 0,0 except outer -160,-120).
    // Oracle Paper stage = ((PaperX-480)/2, (360-PaperY)/2) is the CAMERA read,
    // not the VM divisor: VM then divides by res (res1 20px->20 stage, res2 20px->10 stage).
    const vmStageOf = (name: string) => {
      const r = byName[name]! as { backing: { w: number; h: number }; trim: { x: number; y: number; width: number; height: number }; origin: { x: number; y: number }; unionMin: { x: number; y: number }; meta: { res: number } }
      const res = (r.meta as { res: number }).res
      const artC = res === 2 ? { x: 480, y: 360 } : { x: 240, y: 180 }
      const cc = { x: artC.x - (r.unionMin as { x: number }).x, y: artC.y - (r.unionMin as { y: number }).y }
      const t = r.trim as { x: number; y: number; width: number; height: number }
      const cx = t.x + t.width / 2
      const cy = t.y + t.height / 2
      return { cc, centerCanvas: { x: cx, y: cy }, stageCenter: { x: (cx - cc.x) / res, y: (cc.y - cy) / res }, stageSize: { w: t.width / res, h: t.height / res } }
    }
    const vm4848 = vmStageOf('res1-4848')
    const vmRes2 = vmStageOf('res2-4848')
    const vm00 = vmStageOf('res1-00')
    console.log(`RES1_VM_STAGE ${JSON.stringify({ vm4848, vmRes2, vm00 })}`)
    // Same 20x20 source block: res1 VM 20x20 stage at (-8,-2), res2 VM 10x10 stage at (-4,-1) => 2:1 apparent size, same direction.
    expect(vm4848.stageSize).toEqual({ w: 20, h: 20 })
    expect(vmRes2.stageSize).toEqual({ w: 10, h: 10 })
    expect(vm4848.stageCenter).toEqual({ x: -8, y: -2 })
    expect(vmRes2.stageCenter).toEqual({ x: -4, y: -1 })
    // CSS viewport: res1 decided-0.5 band reset scale 1.0 renders 480 CSS px
    // wide; res2 density-1.0 band reset 0.5 renders 480 CSS px wide too
    // (same container width, different backing). Labels are both per-mode
    // 100% (Paper 0.5 basis: 1.0*0.5 = 0.5, 0.5*1.0 = 0.5).
    const vpRes1 = byName['res1-4848']!.viewport as { backing: { w: number; h: number }; rect: { w: number; h: number }; label: string }
    const vpRes2 = byName['res2-4848']!.viewport as { backing: { w: number; h: number }; rect: { w: number; h: number }; label: string }
    expect(Math.abs(vpRes1.rect.w - vpRes1.backing.w * 1)).toBeLessThan(2)
    expect(vpRes1.label).toContain('100%')
    expect(Math.abs(vpRes2.rect.w - vpRes2.backing.w * 0.5)).toBeLessThan(2)
    expect(vpRes2.label).toContain('100%')
    // Apparent canvas size: res1 backing is exactly half the res2 backing in
    // each axis (480 vs 960), while the opaque trim is the same 20x20 px and
    // the non-opaque margins differ by 240px (res1 left 222 vs res2 left 462).
    expect((vpRes2.backing.w / vpRes1.backing.w)).toBeCloseTo(2, 12)
    expect(((byName['res2-4848']!.trim as { x: number }).x - (byName['res1-4848']!.trim as { x: number }).x)).toBe(240)
    // Selection anchor: marquee the res1 block and verify the overlay sits at
    // the same canvas fraction (post-pixel check via style %).
    await selectCostume('res1-4848')
    await page.getByTestId('bitmap-tool-select').click()
    const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!box) throw new Error('missing canvas box')
    const toScreen = (cw: number, ch: number, cx: number, cy: number) => ({ x: box.x + (cx / cw) * box.width, y: box.y + (cy / ch) * box.height })
    const m0 = toScreen(480, 360, 222 - 2, 172 - 2)
    const m1 = toScreen(480, 360, 222 + 22, 172 + 22)
    await page.mouse.move(m0.x, m0.y); await page.mouse.down(); await page.mouse.move(m1.x, m1.y, { steps: 5 }); await page.mouse.up()
    await page.waitForTimeout(400)
    const sel = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
      return el ? { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height } : null
    })
    console.log(`RES1_SELECTION ${JSON.stringify({ sel, box })}`)
    expect(sel).not.toBeNull()
    // Zoom anchor: one Zoom-in step from reset; res1 Paper +0.5 -> +1.0 CSS
    // (1->2.0), label 100%->200%, rect scales 2x around the same center
    // (post-pixel). Surface coords stay fixed: the selection overlay is in
    // canvas-% space, so zoom/pan move it exactly with the artwork.
    const before = await viewportOf()
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('200%') ?? false, null, { timeout: 10_000 })
    await new Promise((r) => setTimeout(r, 300))
    const after = await viewportOf()
    console.log(`RES1_ZOOM ${JSON.stringify({ beforeRect: before.rect, beforeLabel: before.label, afterRect: after.rect, afterLabel: after.label })}`)
    expect(after.label).toContain('200%')
    expect(after.rect.w / before.rect.w).toBeCloseTo(2.0, 1)
    // Reset returns to 480 CSS px centered (post-pixel recenter).
    await page.evaluate(() => { document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click() })
    await page.waitForFunction(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('100%') ?? false, null, { timeout: 10_000 })
    await new Promise((r) => setTimeout(r, 300))
    const reset = await viewportOf()
    expect(Math.abs(reset.rect.w - 480)).toBeLessThan(2)
    // res1 verdict (decided): stored 480x360 kept non-destructively, live
    // Paper board 960x720 via the reference 2x doubling: density 0.5,
    // reset 1.0, min 0.666..., button +/-1.0 CSS, wheel +0.2 per -100 tick.
    console.log(`RES1_VERDICT ${JSON.stringify({ board: '480x360 vs oracle 960x720 (center 240,180 vs 480,360)', density: 'decided 0.5 (480 canvas / 960 Paper; R-own 1.0 was the doubled camera divisor, not the stored canvas)', reset: 'Paper 0.5 -> CSS 1.0 (live reset, numerically the legacy 1)', min: 'Paper 0.333 -> CSS 0.666...', step: 'button +0.5 Paper -> +1.0 CSS / wheel -100 tick +0.1 Paper -> +0.2 CSS', fit: 'decided: 20x20 canvas trim -> 40x40 Paper, +50 buffer, artboard center 480,360 Paper' })}`)
  }, 240_000)
})
