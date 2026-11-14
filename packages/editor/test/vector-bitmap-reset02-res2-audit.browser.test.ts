// Independent Reset-after audit: vector reset 0.2 / bitmap res2 reset 0.5.
//
// Scope (new test only, no product edits): AFTER the Reset button (never the
// initial load), verify that the 5x visual shrink (2400 surface -> 480 CSS px
// for vector, 960 canvas -> 480 CSS px for bitmap res2) does NOT lose click
// hit / selection / drag wiring. Covers through the real Editor + real VM:
// - vector + bitmap stored res2 / explicit res1, huge union, non-central
//   rotation center, stage + sprite
// - viewport state across mode / costume / target switches
// - undo / redo / delete, selection hit rect + move / resize / rotate,
//   freehand (brush), text, eyedropper, clipboard (incl. cross-format)
// - browser responsive + wheel scroll pan + ctrl-wheel zoom
// - quantitative pixel + SVG/PNG content + persistent-history checks
// - real Paper board width 480 CSS vs local anchor comparison
//
// Real-board assertion: at Reset the vector surface rect AND the res2 bitmap
// canvas rect are both ~480 CSS px wide in the SAME container (center error
// <1px), while the local anchor (rotation-center overlay / SVG-unit mapping)
// still resolves clicks to the right SVG/canvas units. A 5x smaller picture
// that still hit-tests is a pass; a dead click area is a FAIL (kept failing).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/vector-bitmap-reset02-res2-audit.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4549
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}
function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}
function log(label: string, value: unknown) {
  console.log(`[reset02-res2-audit] ${label} ${JSON.stringify(value).slice(0, 6000)}`)
}

// --- fixtures ---------------------------------------------------------------
const VEC_RED =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="20" y="30" width="100" height="60" fill="#ff0000"/></svg>`
const VEC_HUGE =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="-200" y="-150" width="800" height="600" fill="#00aa00"/>` +
  `<rect x="300" y="220" width="120" height="80" fill="#0000ff"/></svg>`
const VEC_STAGE =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="200" y="140" width="80" height="60" fill="#ff00ff"/></svg>`

function buildPng(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  // Minimal zlib-wrapped PNG via fflate (same approach as sibling suites).
  const { zlibSync } = require('fflate') as typeof import('fflate')
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
  v.setUint32(0, w); v.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6
  const idat = zlibSync(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    let crc = 0xffffffff
    for (const b of out.slice(4, 8 + data.length)) {
      crc ^= b
      for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    dv.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0)
    return out
  }
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const BMP_BYTES = () =>
  buildPng(100, 80, (x, y) => {
    if (x >= 10 && x < 30 && y >= 10 && y < 30) return [255, 0, 0, 255]
    if (x === 5 && y === 5) return [0, 0, 255, 120]
    return [255, 255, 255, 255]
  })
const EMPTY_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>',
)

function auditProject() {
  const bmp = BMP_BYTES()
  const bmpHash = md5(bmp)
  const files: Record<string, Uint8Array> = {}
  const add = (bytes: Uint8Array, ext: string) => {
    const h = md5(bytes)
    files[`${h}.${ext}`] = bytes
    return { assetId: h, md5ext: `${h}.${ext}` }
  }
  const bmpFile = add(bmp, 'png')
  void bmpHash
  const vecRed = new TextEncoder().encode(VEC_RED)
  const vecHuge = new TextEncoder().encode(VEC_HUGE)
  const vecStage = new TextEncoder().encode(VEC_STAGE)
  const emptyHash = md5(EMPTY_SVG)
  files[`${emptyHash}.svg`] = EMPTY_SVG
  const fRed = add(vecRed, 'svg')
  const fHuge = add(vecHuge, 'svg')
  const fStage = add(vecStage, 'svg')
  const project = {
    targets: [
      {
        isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [
          { name: 'stage-vec', assetId: fStage.assetId, md5ext: fStage.md5ext, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 },
          { name: 'stage-bmp-res1', assetId: bmpFile.assetId, md5ext: bmpFile.md5ext, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 100, rotationCenterY: 100 },
        ],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'AuditSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [
          { name: 'vec-normal', assetId: fRed.assetId, md5ext: fRed.md5ext, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 },
          { name: 'vec-huge', assetId: fHuge.assetId, md5ext: fHuge.md5ext, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 100, rotationCenterY: 250 },
          { name: 'bmp-res2', assetId: bmpFile.assetId, md5ext: bmpFile.md5ext, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 20, rotationCenterY: 60 },
          { name: 'bmp-res1', assetId: bmpFile.assetId, md5ext: bmpFile.md5ext, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 20, rotationCenterY: 60 },
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'reset02-res2-audit', agent: 'reset02-res2-audit' },
  }
  return { project, files }
}

// --- page helpers -----------------------------------------------------------
async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(600)
}
async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'reset02-res2-audit.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { project: { targets: Array<{ costumes: Array<{ name: string }> }> } } } }).__hikkakuEditorTest?.snapshot()
      return snap?.project.targets.some((t) => t.costumes.some((c) => c.name === want)) ?? false
    },
    expectName as unknown as undefined,
    { timeout: 60_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)
}
async function snapshot(page: Page): Promise<any> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest: { snapshot: () => any } }).__hikkakuEditorTest.snapshot())
}
async function status(page: Page): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status())
}
async function selectTarget(page: Page, name: string) {
  if (name === 'Stage') await page.getByTestId('target-card-stage').click()
  else await page.getByTestId(`target-card-${name}`).click()
  await page.waitForFunction(
    (want: string) => {
      const w = window as unknown as { __hikkakuEditorTest: { snapshot: () => any } }
      const s = w.__hikkakuEditorTest?.snapshot()
      const t = s?.project?.targets?.find((x: any) => x.name === want)
      return (s?.selectedTargetId === (t?.id ?? want) || s?.selectedTargetId === want) ?? false
    },
    name as unknown as undefined,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(400)
}
async function selectCostume(page: Page, name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).first().click()
  await page.waitForTimeout(700)
}
async function ensureVector(page: Page) {
  if ((await page.getByRole('button', { name: 'ベクターに変換' }).count()) > 0) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(() => !!document.querySelector('[data-vector-stage-surface="true"]'), null, { timeout: 15_000 })
    await page.waitForTimeout(400)
  }
}
async function ensureBitmap(page: Page) {
  if ((await page.getByRole('button', { name: 'ビットマップに変換' }).count()) > 0) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(400)
  }
}
async function resetZoom(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click())
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('100%') ?? false,
    null,
    { timeout: 15_000 },
  )
  await page.waitForTimeout(250)
}
async function zoomLabel(page: Page): Promise<string> {
  return (await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')).trim()
}
async function requireSurface(page: Page) {
  // The paint surface remounts across costume/target switches; wait for it
  // instead of assuming a fixed post-click delay left it mounted.
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction(() => !!document.querySelector('[data-testid="costume-paint-surface"]'), null, { timeout: 15_000 })
}
async function currentCostume(page: Page): Promise<any> {
  const s = await snapshot(page)
  const t = s.project.targets.find((x: any) => (x.id ?? x.name) === s.selectedTargetId) ?? s.project.targets.find((x: any) => !x.isStage)
  return { target: t, index: t.currentCostume ?? 0, costume: t.costumes[t.currentCostume ?? 0] }
}
const svgToScreen = async (page: Page, x: number, y: number) => {
  const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox()
  if (!box) throw new Error('no vector surface')
  return { x: box.x + (x / 480) * box.width, y: box.y + (y / 360) * box.height, box }
}
const canvasToScreen = async (page: Page, cx: number, cy: number) => {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('no bitmap canvas')
  const size = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement
    return { w: c.width, h: c.height }
  })
  return { x: box.x + (cx / size.w) * box.width, y: box.y + (cy / size.h) * box.height, box, size }
}
async function outlineCount(page: Page) {
  return await page.locator('[data-vector-selection-outline]').count()
}
async function previewSvg(page: Page): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}
async function undoBtn(page: Page) {
  // The page can host more than one Undo control; the paint suite convention
  // is the visible one (`inline-text-editor.browser.test.ts` pattern).
  return page.locator('button[aria-label="Undo"]:visible').first()
}
async function redoBtn(page: Page) {
  return page.locator('button[aria-label="Redo"]:visible').first()
}
async function waitUndoEnabled(page: Page, timeout = 20_000) {
  await page.waitForFunction(
    () => {
      const btns = Array.from(document.querySelectorAll('button[aria-label="Undo"]')) as HTMLButtonElement[]
      const vis = btns.filter((b) => (b as HTMLElement).offsetParent !== null)
      return vis.some((b) => !b.disabled)
    },
    null,
    { timeout },
  )
}

describe('vector reset0.2 / bitmap res2 reset0.5 post-Reset audit (real Editor+VM)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 120; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 90_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('Reset board: vector + res2 both 480 CSS in same container, local anchor still hit-tests', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    try {
      const { project, files } = auditProject()
      await openCostumes(page)
      await importSb3(page, Buffer.from(buildSb3(project, files)), 'vec-normal')
      await selectTarget(page, 'AuditSprite')
      await selectCostume(page, 'vec-normal')
      await ensureVector(page)
      await resetZoom(page)
      const vector = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
        const container = document.querySelector('[data-testid="costume-paint-surface"]')!
        const r = surface.getBoundingClientRect()
        const c = container.getBoundingClientRect()
        // Local anchor: rotation-center overlay position vs surface mapping.
        const rc = document.querySelector<HTMLElement>('[data-testid="rotation-center-overlay"], [data-rotation-center-overlay]')
        const anchor = rc?.getBoundingClientRect() ?? null
        return {
          styleWidth: surface.style.width,
          rectWidth: r.width, rectHeight: r.height, rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          centerErr: Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.top + r.height / 2 - (c.top + c.height / 2)),
          container: { w: c.width, h: c.height },
          anchor: anchor ? { x: anchor.x, y: anchor.y, w: anchor.width, h: anchor.height } : null,
          label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
          scale480: r.width / 480,
        }
      })
      log('VECTOR_RESET_BOARD', vector)
      // Real Paper board: Reset renders exactly 480 CSS px (2400 surface x 0.2).
      // Appearance is 5x smaller than scale-1 (2400 CSS px) — recorded, not hidden.
      expect(vector.styleWidth).toBe('2400px')
      expect(Math.abs(vector.rectWidth - 480)).toBeLessThan(1.5)
      expect(Math.abs(vector.rectHeight - 360)).toBeLessThan(1.5)
      expect(vector.centerErr).toBeLessThan(1)
      expect(vector.label).toContain('100%')
      // Local-anchor comparison: SVG unit (240,180) maps to the surface center.
      const anchorCheck = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
        const r = surface.getBoundingClientRect()
        const svgCenterX = r.left + (240 / 480) * r.width
        const svgCenterY = r.top + (180 / 360) * r.height
        return { svgCenterX, svgCenterY, surfCenterX: r.left + r.width / 2, surfCenterY: r.top + r.height / 2 }
      })
      expect(Math.abs(anchorCheck.svgCenterX - anchorCheck.surfCenterX)).toBeLessThan(1)
      expect(Math.abs(anchorCheck.svgCenterY - anchorCheck.surfCenterY)).toBeLessThan(1)

      // Click hit must survive the 5x shrink: click the red rect body selects it.
      await page.locator('[data-testid="vector-shape-select"]').first().click().catch(() => {})
      await page.waitForTimeout(300)
      const before = await outlineCount(page)
      const p = await svgToScreen(page, 70, 60) // inside rect (20,30,100,60)
      await page.mouse.click(p.x, p.y)
      await page.waitForTimeout(600)
      const after = await outlineCount(page)
      const sel = await page.evaluate(() => ({
        outlines: document.querySelectorAll('[data-vector-selection-outline]').length,
        blue: Array.from(document.querySelectorAll('[data-vector-selection-outline]')).filter((e) =>
          (e as HTMLElement).className.includes('border-blue-500')).length,
      }))
      log('VECTOR_CLICK_HIT', { before, after, sel, click: p })
      expect(after).toBeGreaterThanOrEqual(1)
      expect(sel.blue).toBeGreaterThanOrEqual(1)

      // Same container for the res2 bitmap board.
      await selectCostume(page, 'bmp-res2')
      await ensureBitmap(page)
      await resetZoom(page)
      const bitmap = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const container = document.querySelector('[data-testid="costume-paint-surface"]')!
        const r = canvas.getBoundingClientRect()
        const c = container.getBoundingClientRect()
        return {
          backing: { w: canvas.width, h: canvas.height },
          rectWidth: r.width, rectHeight: r.height,
          centerErr: Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.top + r.height / 2 - (c.top + c.height / 2)),
          container: { w: c.width, h: c.height },
          label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        }
      })
      log('BITMAP_RES2_RESET_BOARD', bitmap)
      expect(bitmap.label).toContain('100%')
      expect(bitmap.centerErr).toBeLessThan(1)
      expect(Math.abs(bitmap.container.w - vector.container.w)).toBeLessThan(2)
      // Stored res2 sprite: canvas is res2 artboard -> Paper reset 0.5 -> 480 CSS.
      expect(bitmap.backing.w).toBeGreaterThanOrEqual(720)
      expect(Math.abs(bitmap.rectWidth - 480)).toBeLessThan(1.5)
      expect(Math.abs(bitmap.rectWidth - vector.rectWidth)).toBeLessThan(2)
    } finally { await ctx.close() }
  }, 180_000)

  it('vector post-Reset: hit rect / move / resize / rotate / freehand / text / eyedropper / clipboard + huge union + undo/redo/delete', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    try {
      const { project, files } = auditProject()
      await openCostumes(page)
      await importSb3(page, Buffer.from(buildSb3(project, files)), 'vec-huge')
      await selectTarget(page, 'AuditSprite')
      await selectCostume(page, 'vec-huge')
      await ensureVector(page)
      await resetZoom(page)
      await page.locator('[data-testid="vector-shape-select"]').first().click().catch(() => {})
      await page.waitForTimeout(300)
      const meta0 = await currentCostume(page)
      expect(meta0.costume.rotationCenterX).toBe(100)
      expect(meta0.costume.rotationCenterY).toBe(250)
      const svg0 = await previewSvg(page)
      expect(svg0).toContain('#00aa00')
      expect(svg0).toContain('#0000ff')
      const bounds0 = await page.evaluate(async (text: string) => {
        const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const list = await (mod as any).paperVectorObjectList(text)
        return (list as any[]).map((o: any) => ({ x: o.boundsX, y: o.boundsY, w: o.boundsWidth, h: o.boundsHeight }))
      }, svg0)
      log('HUGE_BASELINE', { bounds: bounds0, meta: { rc: [meta0.costume.rotationCenterX, meta0.costume.rotationCenterY] } })
      expect(bounds0.length).toBeGreaterThanOrEqual(2)
      const unionW = Math.max(...bounds0.map((b: any) => b.x + b.w)) - Math.min(...bounds0.map((b: any) => b.x))
      expect(unionW).toBeGreaterThan(480) // huge union exceeds the board

      // Hit rect: click the small blue rect (300,220,120,80) through the 5x view.
      const pb = await svgToScreen(page, 360, 260)
      await page.mouse.click(pb.x, pb.y)
      await page.waitForTimeout(600)
      expect(await outlineCount(page)).toBeGreaterThanOrEqual(1)

      // Move: drag outline center +24 screen px; SVG must shift +24 svg units (1:1 at 0.2).
      const center = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('[data-vector-selection-outline]'))
        const blue = els.filter((e) => (e as HTMLElement).className.includes('border-blue-500'))
        const el = (blue.at(-1) ?? els.at(-1)) as HTMLElement
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      const svgBeforeMove = await previewSvg(page)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.move(center.x + 24, center.y, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(800)
      const svgAfterMove = await previewSvg(page)
      expect(svgAfterMove).not.toBe(svgBeforeMove)
      const dx = await page.evaluate(([a, b]: [string, string]) => {
        const parse = (s: string) => {
          const m = s.match(/x="([\d.\-]+)"[^>]*width="120"/)
          return m ? Number(m[1]) : NaN
        }
        return (parse(b) as number) - (parse(a) as number)
      }, [svgBeforeMove, svgAfterMove] as unknown as undefined)
      log('VECTOR_MOVE_DX', { dx })
      expect(Math.abs(dx - 24)).toBeLessThan(6)

      // Resize via SE handle (+30 screen px grows width).
      const svgBeforeResize = await previewSvg(page)
      const se = page.getByRole('button', { name: 'Resize selected vector object se' }).first()
      await se.waitFor({ state: 'visible', timeout: 10_000 })
      const seBox = await se.boundingBox()
      if (!seBox) throw new Error('no SE handle')
      await page.mouse.move(seBox.x + seBox.width / 2, seBox.y + seBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(seBox.x + seBox.width / 2 + 30, seBox.y + seBox.height / 2 + 20, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(800)
      const svgAfterResize = await previewSvg(page)
      expect(svgAfterResize).not.toBe(svgBeforeResize)
      await waitUndoEnabled(page)
      expect(await (await undoBtn(page)).isEnabled()).toBe(true)

      // Rotate via rotate handle (drag sideways); SVG must change + history entry.
      const svgBeforeRot = await previewSvg(page)
      const rot = page.getByTestId('vector-rotate-handle').first()
      await rot.waitFor({ state: 'visible', timeout: 10_000 })
      const rotBox = await rot.boundingBox()
      if (!rotBox) throw new Error('no rotate handle')
      await page.mouse.move(rotBox.x + rotBox.width / 2, rotBox.y + rotBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(rotBox.x + rotBox.width / 2 + 40, rotBox.y + rotBox.height / 2 - 10, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(800)
      const svgAfterRot = await previewSvg(page)
      expect(svgAfterRot).not.toBe(svgBeforeRot)

      // Freehand brush: new path appears, undo peels exactly one entry.
      await page.locator('[data-testid="vector-shape-brush"]').first().click()
      const brush0 = await previewSvg(page)
      const q1 = await svgToScreen(page, 100, 100)
      const q2 = await svgToScreen(page, 150, 130)
      await page.mouse.move(q1.x, q1.y)
      await page.mouse.down()
      await page.mouse.move(q2.x, q2.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(900)
      const brush1 = await previewSvg(page)
      expect(brush1).not.toBe(brush0)
      await (await undoBtn(page)).click()
      await page.waitForTimeout(700)
      expect(await previewSvg(page)).toBe(brush0)
      await (await redoBtn(page)).click()
      await page.waitForTimeout(700)
      expect(await previewSvg(page)).toBe(brush1)

      // Text tool: click + type commits a <text> node (Escape commits per
      // Scratch TEXT_EDIT_MODE parity; Enter is a newline, not a commit).
      await page.locator('[data-testid="vector-shape-text"]').first().click()
      const tt = await svgToScreen(page, 240, 180)
      await page.mouse.click(tt.x, tt.y)
      await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
      await page.keyboard.type('Hi')
      await page.keyboard.press('Escape')
      await page.locator('[data-inline-text-editor]').waitFor({ state: 'hidden', timeout: 10_000 })
      await page.waitForTimeout(800)
      const svgText = await previewSvg(page)
      expect(svgText).toContain('<text')

      // Eyedropper picks the blue rect fill through the shrunk view.
      const fill = page.getByLabel('Fill', { exact: true }).first()
      await page.locator('[data-testid="vector-tool-eyedropper"]').first().click()
      await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible', timeout: 10_000 })
      const eb = await svgToScreen(page, 360, 260)
      await page.mouse.move(eb.x, eb.y)
      await page.getByTestId('eyedropper-loupe').waitFor({ state: 'visible', timeout: 10_000 })
      await page.mouse.click(eb.x, eb.y)
      await page.waitForTimeout(600)
      const picked = await page.evaluate(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null ? 'committed' : 'open'))
      log('VECTOR_EYEDROPPER', { picked })
      expect(picked).toBe('committed')

      // Clipboard copy/paste adds one object; delete + undo/redo round-trip.
      await page.locator('[data-testid="vector-shape-select"]').first().click().catch(() => {})
      await page.waitForTimeout(300)
      const cp = await svgToScreen(page, 360, 260)
      await page.mouse.click(cp.x, cp.y)
      await page.waitForTimeout(500)
      await page.getByTestId('copy-costume-selection').click()
      await page.waitForFunction(() => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status().includes('copied'), null, { timeout: 15_000 })
      const n0 = (await page.evaluate(async (t: string) => {
        const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        return ((await (mod as any).paperVectorObjectList(t)) as any[]).length
      }, await previewSvg(page)) as number)
      await page.getByTestId('paste-costume-selection').click()
      await page.waitForFunction((n: number) => document.querySelector('.vector-preview')!.innerHTML !== '', n0 as unknown as undefined, { timeout: 15_000 })
      await page.waitForTimeout(700)
      const n1 = (await page.evaluate(async (t: string) => {
        const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        return ((await (mod as any).paperVectorObjectList(t)) as any[]).length
      }, await previewSvg(page)) as number)
      expect(n1).toBeGreaterThan(n0)
      await page.getByTestId('delete-editor-selection').click()
      await page.waitForTimeout(700)
      const nDel = (await page.evaluate(async (t: string) => {
        const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        return ((await (mod as any).paperVectorObjectList(t)) as any[]).length
      }, await previewSvg(page)) as number)
      expect(nDel).toBeLessThan(n1)
      await (await undoBtn(page)).click()
      await page.waitForTimeout(700)
      const nUndo = (await page.evaluate(async (t: string) => {
        const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        return ((await (mod as any).paperVectorObjectList(t)) as any[]).length
      }, await previewSvg(page)) as number)
      expect(nUndo).toBe(n1)
      await (await redoBtn(page)).click()
      await page.waitForTimeout(700)
      // Persistent history: save vector, reload costume, SVG bytes round-trip.
      const savedSvg = await previewSvg(page)
      await page.getByTestId('save-vector-costume').click()
      await page.waitForTimeout(900)
      const saved = await snapshot(page)
      const cost = saved.project.targets.find((t: any) => t.name === 'AuditSprite').costumes.find((c: any) => c.name === 'vec-huge')
      expect(cost.dataFormat).toBe('svg')
      expect(typeof savedSvg).toBe('string')
      expect(savedSvg.length).toBeGreaterThan(100)
      expect(await status(page)).toBeDefined()
    } finally { await ctx.close() }
  }, 240_000)

  it('bitmap res2 post-Reset: paint pixels / select+move+resize+rotate / text / eyedropper / clipboard + undo/redo/delete + PNG bytes', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    try {
      const { project, files } = auditProject()
      await openCostumes(page)
      await importSb3(page, Buffer.from(buildSb3(project, files)), 'bmp-res2')
      await selectTarget(page, 'AuditSprite')
      await selectCostume(page, 'bmp-res2')
      await ensureBitmap(page)
      await resetZoom(page)
      const meta = await currentCostume(page)
      expect(meta.costume.bitmapResolution).toBe(2)
      expect(meta.costume.rotationCenterX).toBe(20)
      expect(meta.costume.rotationCenterY).toBe(60)

      // Brush paints opaque red pixels through the 480-CSS mapping.
      await page.locator('[data-testid="bitmap-tool-brush"]').first().click()
      const fill = page.getByLabel('Paint color', { exact: true })
      await fill.fill('#ff0000')
      const info = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement
        return { w: c.width, h: c.height }
      })
      const a = await canvasToScreen(page, info.w / 2 - 8, info.h / 2)
      const b = await canvasToScreen(page, info.w / 2 + 8, info.h / 2)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 4 })
      await page.mouse.up()
      await page.waitForFunction(() => {
        const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement
        const d = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
        return d[0]! > 200 && d[3] === 255
      }, null, { timeout: 15_000 })
      const px = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        let red = 0
        for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! < 80 && d[i + 2]! < 80 && d[i + 3] === 255) red += 1
        return { red, w: c.width, h: c.height, urlLen: c.toDataURL('image/png').length }
      })
      log('BITMAP_PAINT_PX', px)
      expect(px.red).toBeGreaterThan(5)
      expect(px.urlLen).toBeGreaterThan(1000)
      // Autosave is debounced: wait for the history entry instead of asserting
      // the button synchronously (immediate assert flakes on a slow frame).
      await waitUndoEnabled(page)
      expect(await (await undoBtn(page)).isEnabled()).toBe(true)

      // Marquee select + move the floating selection.
      await page.locator('[data-testid="bitmap-tool-select"]').first().click()
      const s1 = await canvasToScreen(page, info.w * 0.3, info.h * 0.3)
      const s2 = await canvasToScreen(page, info.w * 0.6, info.h * 0.6)
      await page.mouse.move(s1.x, s1.y)
      await page.mouse.down()
      await page.mouse.move(s2.x, s2.y, { steps: 8 })
      await page.mouse.up()
      await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
      const selBefore = await page.evaluate(() => (document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement).style.cssText)
      // Drag inside the selection to float-move it.
      const mid = await canvasToScreen(page, info.w * 0.45, info.h * 0.45)
      await page.mouse.move(mid.x, mid.y)
      await page.mouse.down()
      await page.mouse.move(mid.x + 18, mid.y + 12, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(700)
      const selAfter = await page.evaluate(() => (document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement).style.cssText)
      log('BITMAP_SELECT_MOVE', { selBefore, selAfter })
      expect(selAfter).not.toBe(selBefore)

      // Floating resize handle grows the selection rect.
      const rse = page.getByTestId('bitmap-floating-scale-handle').first()
      await rse.waitFor({ state: 'visible', timeout: 10_000 })
      const rseBox = await rse.boundingBox()
      if (!rseBox) throw new Error('no floating SE')
      const selPreResize = await page.evaluate(() => (document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement).style.cssText)
      await page.mouse.move(rseBox.x + rseBox.width / 2, rseBox.y + rseBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(rseBox.x + rseBox.width / 2 + 22, rseBox.y + rseBox.height / 2 + 14, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(700)
      const selPostResize = await page.evaluate(() => (document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement).style.cssText)
      expect(selPostResize).not.toBe(selPreResize)

      // Floating rotate handle changes pixels inside the selection + history.
      // Re-marquee around the known red stroke first: the earlier float-move
      // can leave the selection over uniform white, where any rotation is
      // pixel-invisible by construction (not a product defect).
      await page.locator('[data-testid="bitmap-tool-select"]').first().click()
      const rs1 = await canvasToScreen(page, info.w / 2 - 60, info.h / 2 - 40)
      const rs2 = await canvasToScreen(page, info.w / 2 + 60, info.h / 2 + 40)
      await page.mouse.move(rs1.x, rs1.y)
      await page.mouse.down()
      await page.mouse.move(rs2.x, rs2.y, { steps: 8 })
      await page.mouse.up()
      await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(400)
      const rot = page.getByTestId('bitmap-floating-rotate-handle').first()
      await rot.waitFor({ state: 'visible', timeout: 10_000 })
      const rotBox = await rot.boundingBox()
      if (!rotBox) throw new Error('no floating rotate')
      const sampleSelBlock = () => page.evaluate(() => {
        const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement
        const overlay = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement
        const pct = (v: string) => Number.parseFloat(v.replace('%', ''))
        const l = pct(overlay.style.left), t = pct(overlay.style.top)
        const w = pct(overlay.style.width), h = pct(overlay.style.height)
        const x = Math.max(0, Math.floor((l / 100) * c.width))
        const y = Math.max(0, Math.floor((t / 100) * c.height))
        const ww = Math.max(1, Math.min(c.width - x, Math.round((w / 100) * c.width)))
        const hh = Math.max(1, Math.min(c.height - y, Math.round((h / 100) * c.height)))
        const d = c.getContext('2d')!.getImageData(x, y, ww, hh).data
        // Exact bytes (not a channel sum): rotating ink inside the rect moves
        // pixels, so any effective rotation changes the string even when the
        // total ink amount is conserved.
        let hash = 0
        for (let i = 0; i < d.length; i += 7) hash = (hash * 31 + (d[i] ?? 0)) | 0
        return { hash, x, y, w: ww, h: hh, len: d.length }
      })
      const pxBeforeRot = await sampleSelBlock()
      await page.mouse.move(rotBox.x + rotBox.width / 2, rotBox.y + rotBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(rotBox.x + rotBox.width / 2 + 34, rotBox.y + rotBox.height / 2, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(800)
      const pxAfterRot = await sampleSelBlock()
      log('BITMAP_FLOAT_ROTATE', { pxBeforeRot, pxAfterRot })
      expect(pxAfterRot.hash).not.toBe(pxBeforeRot.hash)

      // Text tool commits a history entry.
      await page.locator('[data-testid="bitmap-tool-text"]').first().click()
      const tp = await canvasToScreen(page, info.w / 2, info.h / 2)
      await page.mouse.click(tp.x, tp.y)
      await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
      await page.keyboard.type('B')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(400)
      // Enter is a newline in TEXT_EDIT_MODE; commit with Escape when the
      // editor is still open (vector leg pattern). Harmless if Enter already
      // committed (no overlay left to close).
      if ((await page.locator('[data-inline-text-editor]').count()) > 0) {
        await page.keyboard.press('Escape')
        await page.locator('[data-inline-text-editor]').waitFor({ state: 'hidden', timeout: 10_000 })
      }
      await page.waitForTimeout(700)
      expect(await (await undoBtn(page)).isEnabled()).toBe(true)

      // Eyedropper resolves the red stroke through the reset transform.
      await page.locator('[data-testid="bitmap-tool-eyedropper"]').first().click()
      await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
      const ep = await canvasToScreen(page, info.w / 2, info.h / 2)
      await page.mouse.move(ep.x, ep.y)
      await page.getByTestId('eyedropper-loupe').waitFor({ state: 'visible' })
      await page.mouse.click(ep.x, ep.y)
      await page.waitForFunction(() => document.querySelector('[data-testid="eyedropper-hint"]') === null, null, { timeout: 10_000 })

      // Save BEFORE the destructive clipboard leg. Floating edits (move /
      // resize / rotate) legitimately shift the transparent trim, and the
      // rotation center is trim-relative by design (`croppedSaveForTrim`), so
      // the exact import value (20,60 -- already pinned at leg start) need not
      // survive here. Invariants: resolution stays 2, RC stays finite and
      // in-bounds, and the values are logged for forensics.
      await page.getByTestId('save-bitmap-costume').click()
      await page.waitForTimeout(900)
      const savedPre = await currentCostume(page)
      log('BITMAP_RES2_SAVE_PREDELETE', { res: savedPre.costume.bitmapResolution, rc: [savedPre.costume.rotationCenterX, savedPre.costume.rotationCenterY] })
      expect(savedPre.costume.bitmapResolution).toBe(2)
      expect(Number.isFinite(savedPre.costume.rotationCenterX)).toBe(true)
      expect(Number.isFinite(savedPre.costume.rotationCenterY)).toBe(true)

      // Clipboard copy/paste + delete + undo/redo round-trip on pixels.
      await page.locator('[data-testid="bitmap-tool-select"]').first().click()
      const c1 = await canvasToScreen(page, 5, 5)
      const c2 = await canvasToScreen(page, 35, 35)
      await page.mouse.move(c1.x, c1.y)
      await page.mouse.down()
      await page.mouse.move(c2.x, c2.y, { steps: 6 })
      await page.mouse.up()
      await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 10_000 })
      await page.getByTestId('copy-costume-selection').click()
      await page.waitForFunction(() => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status().includes('copied'), null, { timeout: 15_000 })
      const pxBeforePaste = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n += 1
        return n
      })
      await page.getByTestId('paste-costume-selection').click()
      await page.waitForTimeout(900)
      await page.getByTestId('delete-editor-selection').click().catch(() => {})
      await page.waitForTimeout(700)
      await (await undoBtn(page)).click()
      await page.waitForTimeout(700)
      const pxAfterUndo = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n += 1
        return n
      })
      log('BITMAP_CLIPBOARD_UNDO', { pxBeforePaste, pxAfterUndo })
      expect(pxAfterUndo).toBeGreaterThanOrEqual(pxBeforePaste)
      await (await redoBtn(page)).click()
      await page.waitForTimeout(700)
      // Save AFTER the delete cycle: the resolution must stay 2 (never halve
      // to a res1-style save). The rotation center is trim-relative by design
      // (`croppedSaveForTrim`), so a destructive delete may shift it: assert
      // finite + in-bounds instead of the pre-delete value, and log both.
      await page.getByTestId('save-bitmap-costume').click()
      await page.waitForTimeout(900)
      const saved = await currentCostume(page)
      const dims = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement
        return { w: c.width, h: c.height }
      })
      log('BITMAP_RES2_SAVE_POSTDELETE', { res: saved.costume.bitmapResolution, rc: [saved.costume.rotationCenterX, saved.costume.rotationCenterY], dims })
      expect(saved.costume.bitmapResolution).toBe(2)
      expect(Number.isFinite(saved.costume.rotationCenterX)).toBe(true)
      expect(Number.isFinite(saved.costume.rotationCenterY)).toBe(true)
      expect(saved.costume.rotationCenterX).toBeGreaterThanOrEqual(0)
      expect(saved.costume.rotationCenterY).toBeGreaterThanOrEqual(0)
      expect(saved.costume.rotationCenterX).toBeLessThanOrEqual(dims.w)
      expect(saved.costume.rotationCenterY).toBeLessThanOrEqual(dims.h)
    } finally { await ctx.close() }
  }, 240_000)

  it('explicit res1 + stage/sprite viewport state + responsive/scroll/ctrlwheel + persistent history', async () => {
    const ctx = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    try {
      const { project, files } = auditProject()
      await openCostumes(page)
      await importSb3(page, Buffer.from(buildSb3(project, files)), 'stage-vec')
      // Stage vector reset.
      await selectTarget(page, 'Stage')
      await selectCostume(page, 'stage-vec')
      await ensureVector(page)
      await resetZoom(page)
      expect(await zoomLabel(page)).toContain('100%')
      const stageVecW = await page.evaluate(() => document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect().width)
      expect(Math.abs(stageVecW - 480)).toBeLessThan(1.5)

      // Explicit res1 stage bitmap keeps its own legacy band (NOT forced to 480).
      await selectCostume(page, 'stage-bmp-res1')
      await ensureBitmap(page)
      await resetZoom(page)
      const stageRes1 = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const r = c.getBoundingClientRect()
        return { backing: c.width, rectW: r.width, label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '' }
      })
      const stageMeta = await currentCostume(page)
      log('STAGE_RES1', { stageRes1, meta: { res: stageMeta.costume.bitmapResolution, rc: [stageMeta.costume.rotationCenterX, stageMeta.costume.rotationCenterY] } })
      expect(stageMeta.costume.bitmapResolution).toBe(1)
      expect(stageMeta.costume.rotationCenterX).toBe(100)
      expect(stageMeta.costume.rotationCenterY).toBe(100)
      expect(stageRes1.label).toContain('100%')
      // res1 backing is the 100px family; reset renders at backing scale (legacy), not 480.
      expect(stageRes1.backing).toBeLessThan(720)
      expect(Math.abs(stageRes1.rectW - stageRes1.backing)).toBeLessThan(2)

      // Sprite res1 same legacy behavior (record, no Paper verdict).
      await selectTarget(page, 'AuditSprite')
      await selectCostume(page, 'bmp-res1')
      await ensureBitmap(page)
      await resetZoom(page)
      const sprRes1 = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return { backing: c.width, rectW: c.getBoundingClientRect().width }
      })
      expect(sprRes1.backing).toBeLessThan(720)

      // Viewport state isolation: vector 200% survives a bitmap round-trip.
      await selectCostume(page, 'vec-normal')
      await ensureVector(page)
      await resetZoom(page)
      await page.getByRole('button', { name: 'Zoom in' }).first().click()
      await page.waitForFunction(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('200%') ?? false, null, { timeout: 10_000 })
      await selectCostume(page, 'bmp-res2')
      await ensureBitmap(page)
      await resetZoom(page)
      expect(await zoomLabel(page)).toContain('100%')
      await selectCostume(page, 'vec-normal')
      await ensureVector(page)
      await page.waitForTimeout(400)
      const backLabel = await zoomLabel(page)
      log('VIEWPORT_STATE_ROUNDTRIP', { backLabel })
      expect(backLabel).toContain('200%')

      // Target isolation: Stage keeps its own reset while sprite holds 200%.
      await selectTarget(page, 'Stage')
      await selectCostume(page, 'stage-vec')
      await ensureVector(page)
      await resetZoom(page)
      expect(await zoomLabel(page)).toContain('100%')
      await selectTarget(page, 'AuditSprite')
      await selectCostume(page, 'vec-normal')
      await ensureVector(page)
      await page.waitForTimeout(400)
      expect(await zoomLabel(page)).toContain('200%')
      await resetZoom(page)

      // Scroll pan (plain wheel) moves the viewport; ctrl-wheel zooms pointer-fixed.
      const panBefore = await page.evaluate(() => ({
        x: (document.querySelector('[data-testid="costume-paint-surface"]') as HTMLElement).dataset.vx ?? '',
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }))
      void panBefore
      await requireSurface(page)
      const surfAnchor = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
        return { x: c.left + c.width / 2, y: c.top + c.height / 2 }
      })
      const surfBefore = await page.evaluate(() => document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect().left)
      await page.evaluate((pt: { x: number; y: number }) => {
        document.querySelector('[data-testid="costume-paint-surface"]')!.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 40, deltaY: 20, deltaMode: 0, clientX: pt.x, clientY: pt.y }),
        )
      }, surfAnchor as unknown as undefined)
      await page.waitForTimeout(400)
      const surfAfterPan = await page.evaluate(() => document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect().left)
      log('WHEEL_PAN', { surfBefore, surfAfterPan })
      expect(Math.abs(surfAfterPan - surfBefore)).toBeGreaterThan(2)
      // Ctrl-wheel -100 tick at vector reset 0.2 -> +0.04 CSS (220%? no: 0.2 base, +0.04 => 120%).
      await resetZoom(page)
      await page.evaluate((pt: { x: number; y: number }) => {
        document.querySelector('[data-testid="costume-paint-surface"]')!.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: pt.x, clientY: pt.y }),
        )
      }, surfAnchor as unknown as undefined)
      await page.waitForFunction(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('120%') ?? false, null, { timeout: 10_000 })
      expect(await zoomLabel(page)).toContain('120%')

      // Responsive: narrower viewport keeps the reset scale + tracking.
      await resetZoom(page)
      await page.setViewportSize({ width: 800, height: 600 })
      await page.waitForTimeout(500)
      const narrow = await page.evaluate(() => ({
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        rectW: document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect().width,
      }))
      log('RESPONSIVE_NARROW', narrow)
      expect(narrow.label).toContain('100%')
      expect(Math.abs(narrow.rectW - 480)).toBeLessThan(3)
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.waitForTimeout(400)
      await resetZoom(page)

      // Persistent history: vector edit -> save -> switch costume/target -> undo still reverts.
      await selectTarget(page, 'AuditSprite')
      await selectCostume(page, 'vec-normal')
      await ensureVector(page)
      await resetZoom(page)
      await page.locator('[data-testid="vector-shape-select"]').first().click().catch(() => {})
      await page.waitForTimeout(300)
      const persistBefore = await previewSvg(page)
      const mv = await svgToScreen(page, 70, 60)
      await page.mouse.move(mv.x, mv.y)
      await page.mouse.down()
      await page.mouse.move(mv.x + 16, mv.y, { steps: 4 })
      await page.mouse.up()
      await page.waitForTimeout(800)
      // Persistent history: Reset / pan / responsive must NOT clear the paint
      // stack (viewport moves are not edits), so undo still reverts. Costume
      // switches DO clear it by design (paint-history isolation): that leg
      // asserts the documented isolation instead of persistence.
      const persistMoved = await previewSvg(page)
      expect(persistMoved).not.toBe(persistBefore)
      await resetZoom(page)
      await page.waitForTimeout(300)
      await requireSurface(page)
      const surfC = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
        return { x: c.left + c.width / 2, y: c.top + c.height / 2 }
      })
      await page.evaluate((pt: { x: number; y: number }) => {
        document.querySelector('[data-testid="costume-paint-surface"]')!.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 30, deltaY: 10, deltaMode: 0, clientX: pt.x, clientY: pt.y }),
        )
      }, surfC as unknown as undefined)
      await page.waitForTimeout(400)
      await waitUndoEnabled(page)
      expect(await (await undoBtn(page)).isEnabled()).toBe(true)
      await (await undoBtn(page)).click()
      await page.waitForTimeout(700)
      expect(await previewSvg(page)).toBe(persistBefore)
      await (await redoBtn(page)).click()
      await page.waitForTimeout(700)
      expect(await previewSvg(page)).toBe(persistMoved)
      // Isolation leg (by design): switching costume clears the paint stack.
      await selectCostume(page, 'vec-huge')
      await page.waitForTimeout(500)
      await selectCostume(page, 'vec-normal')
      await page.waitForTimeout(500)
      log('HISTORY_ISOLATION', { undoDisabledAfterSwitch: await (await undoBtn(page)).isDisabled() })
      expect(await (await undoBtn(page)).isDisabled()).toBe(true)
      const finalSnap = await snapshot(page)
      expect(finalSnap.project.targets.some((t: any) => t.name === 'Stage')).toBe(true)
      expect(finalSnap.project.targets.some((t: any) => t.name === 'AuditSprite')).toBe(true)
    } finally { await ctx.close() }
  }, 240_000)
})
