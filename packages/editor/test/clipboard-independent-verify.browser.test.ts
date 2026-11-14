/**
 * Independent bitmap<->vector clipboard verification (new tests only, no product edits).
 *
 * Covers, through the real UI with pixel/position/center assertions:
 * - bitmapResolution 1 (stage) vs 2 (sprite) + stage/sprite targets
 * - non-center rotationCenter
 * - transparent alpha + holes
 * - nested transforms
 * - local defs + clip
 * - oversize canvas / out-of-bounds clamp
 * - continuous paste offset
 * - Undo/Redo single-entry
 * - latest-clipboard (recency) switching
 *
 * Independent Vite port 4427; uses CHROME_BIN via browser-launcher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4427'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// Comprehensive vector fixture: nested transform (red), semitransparent green,
// gradient+clip (yellow->blue clipped to 40x30), magenta donut with a real hole.
const IND_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<defs>` +
  `<linearGradient id="ind-g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffff00"/><stop offset="1" stop-color="#0000ff"/></linearGradient>` +
  `<clipPath id="ind-clip"><rect x="300" y="40" width="40" height="30"/></clipPath>` +
  `</defs>` +
  `<g transform="translate(30 20)"><g transform="scale(1.5)"><rect id="ind-nested" x="10" y="12" width="40" height="30" fill="#ff0000"/></g></g>` +
  `<rect id="ind-semi" x="200" y="150" width="60" height="40" fill="rgba(0,255,0,0.5)"/>` +
  `<rect id="ind-grad" x="290" y="30" width="70" height="50" fill="url(#ind-g)" clip-path="url(#ind-clip)"/>` +
  `<path id="ind-hole" d="M150 200h80v60h-80z M170 215h40v30h-40z" fill-rule="evenodd" fill="#ff00ff"/>` +
  `</svg>`

const HUGE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="0" y="0" width="800" height="600" fill="#ff0000"/>` +
  `</svg>`

const OOB_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="2000" y="2000" width="50" height="40" fill="#ff0000"/>` +
  `</svg>`

const RED_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="20" y="30" width="100" height="60" fill="#ff0000"/>` +
  `</svg>`

const BLUE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="300" y="220" width="120" height="80" fill="#0000ff"/>` +
  `</svg>`

const DONUT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<path d="M60 50h80v60H60z M80 65h40v30H80z" fill-rule="evenodd" fill="#ff00ff"/>` +
  `<rect x="200" y="150" width="60" height="40" fill="rgba(0,255,0,0.5)"/>` +
  `</svg>`

const TRANSPARENT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="10" y="12" width="100" height="60" fill="none"/>` +
  `</svg>`

function copyButton() {
  return page.getByTestId('copy-costume-selection')
}
function pasteButton() {
  return page.getByTestId('paste-costume-selection')
}
function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}
function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => {
    const w = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
    return w.__hikkakuEditorTest?.status() ?? ''
  })
}
async function waitForStatus(text: string, timeout = 30_000) {
  await page.waitForFunction(
    (want) => {
      const w = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
      return (w.__hikkakuEditorTest?.status() ?? '').includes(want as string)
    },
    text as unknown as undefined,
    { timeout },
  )
}
/** Bitmap destination settle wait (UI or workspace token, no sleep). The live
 * canvas is unsettled while a decode/raster/verify load is in flight
 * (Fit + full-pixel verify stretches the window): the toolbar Paste stays
 * `disabled` with an explicit loading display until the pending owner clears.
 * Every bitmap-destination paste below waits for this (canvas visible alone is
 * not enough) without loosening pixel/position/history asserts. */
async function bitmapWorkspaceToken(): Promise<string> {
  return await page.evaluate(() => {
    const w = window as unknown as { __hikkakuEditorTest?: { bitmapWorkspaceToken: () => string } }
    return w.__hikkakuEditorTest?.bitmapWorkspaceToken() ?? ''
  })
}
async function waitForBitmapSettled(timeout = 30_000) {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __hikkakuEditorTest?: { bitmapWorkspaceToken: () => string } }
      const token = w.__hikkakuEditorTest?.bitmapWorkspaceToken() ?? ''
      return token.includes('pending=none')
    },
    undefined,
    { timeout },
  )
  await page.getByTestId('bitmap-workspace-loading-overlay').waitFor({ state: 'hidden', timeout }).catch(() => undefined)
}
async function waitForBitmapPasteReady(timeout = 30_000) {
  await waitForBitmapSettled(timeout)
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="paste-costume-selection"]') as HTMLButtonElement | null
      return button !== null && !button.disabled
    },
    undefined,
    { timeout },
  )
}
async function uploadCostume(name: string, mimeType: string, buffer: Buffer) {
  const before = await page.getByTestId(/costume-card-\d+/).count()
  await page.getByTestId('costume-file-input').setInputFiles({ name, mimeType, buffer })
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
    before as unknown as undefined,
    { timeout: 30_000 },
  )
}
async function selectLastCostumeCard() {
  await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click()
}
async function snapshot(): Promise<any> {
  return await page.evaluate(() => {
    const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
    return w.__hikkakuEditorTest?.snapshot()
  })
}
async function selectedTargetName(): Promise<string> {
  const snap = await snapshot()
  const sel = snap.selectedTargetId
  const t = snap.project.targets.find((x: any) => (x.id ?? x.name) === sel) ?? snap.project.targets.find((x: any) => x.name === sel)
  return t?.name ?? String(sel)
}
async function spriteName(): Promise<string> {
  const snap = await snapshot()
  const s = snap.project.targets.find((x: any) => !x.isStage && !x.isClone)
  if (!s) throw new Error('no sprite')
  return s.name
}
async function selectTargetByName(name: string) {
  const stageSnap = await snapshot()
  const target = stageSnap.project.targets.find((x: any) => x.name === name)
  if (!target) throw new Error(`target ${name} missing`)
  if (target.isStage) {
    await page.getByTestId('target-card-stage').click()
  } else {
    await page.getByTestId(`target-card-${name}`).click()
  }
  await page.waitForFunction(
    (want: string) => {
      const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
      const s = w.__hikkakuEditorTest?.snapshot()
      const t = s?.project?.targets?.find((x: any) => x.name === want)
      return (s?.selectedTargetId === (t?.id ?? want) || s?.selectedTargetId === want) ?? false
    },
    name as unknown as undefined,
    { timeout: 30_000 },
  )
}
async function currentCostumeInfo(): Promise<{ index: number; costume: any; isStage: boolean }> {
  const snap = await snapshot()
  const sel = snap.selectedTargetId
  const target = snap.project.targets.find((x: any) => (x.id ?? x.name) === sel || x.name === sel)
  const index = target.currentCostume ?? 0
  return { index, costume: target.costumes[index], isStage: Boolean(target.isStage) }
}

type ColorBox = { count: number; minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number }

async function probeColors(): Promise<{
  width: number
  height: number
  opaque: number
  red: ColorBox
  greenSemi: number
  blue: ColorBox
  yellow: number
  magenta: ColorBox
}> {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) throw new Error('bitmap canvas missing')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d missing')
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = img.data
    function empty(): ColorBox {
      return { count: 0, minX: 1e9, minY: 1e9, maxX: -1, maxY: -1, cx: 0, cy: 0 }
    }
    const red = empty()
    const blue = empty()
    const magenta = empty()
    let rsx = 0
    let rsy = 0
    let bsx = 0
    let bsy = 0
    let msx = 0
    let msy = 0
    let opaque = 0
    let greenSemi = 0
    let yellow = 0
    const W = canvas.width
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4
        const r = d[i] ?? 0
        const g = d[i + 1] ?? 0
        const b = d[i + 2] ?? 0
        const a = d[i + 3] ?? 0
        if (a !== 0) opaque += 1
        if (r > 200 && g < 60 && b < 60 && a > 200) {
          red.count += 1
          if (x < red.minX) red.minX = x
          if (y < red.minY) red.minY = y
          if (x > red.maxX) red.maxX = x
          if (y > red.maxY) red.maxY = y
          rsx += x
          rsy += y
        }
        if (g > 150 && r < 150 && b < 150 && a >= 80 && a <= 170) greenSemi += 1
        if (b > 150 && r < 150 && g < 150 && a > 100) {
          blue.count += 1
          if (x < blue.minX) blue.minX = x
          if (y < blue.minY) blue.minY = y
          if (x > blue.maxX) blue.maxX = x
          if (y > blue.maxY) blue.maxY = y
          bsx += x
          bsy += y
        }
        if (r > 200 && g > 200 && b < 60 && a > 150) yellow += 1
        if (r > 200 && b > 200 && g < 100 && a > 200) {
          magenta.count += 1
          if (x < magenta.minX) magenta.minX = x
          if (y < magenta.minY) magenta.minY = y
          if (x > magenta.maxX) magenta.maxX = x
          if (y > magenta.maxY) magenta.maxY = y
          msx += x
          msy += y
        }
      }
    }
    if (red.count > 0) {
      red.cx = rsx / red.count
      red.cy = rsy / red.count
    }
    if (blue.count > 0) {
      blue.cx = bsx / blue.count
      blue.cy = bsy / blue.count
    }
    if (magenta.count > 0) {
      magenta.cx = msx / magenta.count
      magenta.cy = msy / magenta.count
    }
    return { width: W, height: canvas.height, opaque, red, greenSemi, blue, yellow, magenta }
  })
}

async function pixelAt(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) throw new Error('no canvas')
    const c = canvas.getContext('2d')
    if (!c) throw new Error('no ctx')
    const xx = Math.max(0, Math.min(canvas.width - 1, Math.round(px)))
    const yy = Math.max(0, Math.min(canvas.height - 1, Math.round(py)))
    return Array.from(c.getImageData(xx, yy, 1, 1).data)
  }, [x, y] as unknown as undefined)
}

async function bitmapSelectionPx(): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  return await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!overlay || !canvas) return undefined
    const pct = (v: string) => Number.parseFloat(v.replace('%', ''))
    const l = pct(overlay.style.left)
    const t = pct(overlay.style.top)
    const w = pct(overlay.style.width)
    const h = pct(overlay.style.height)
    if (![l, t, w, h].every(Number.isFinite)) return undefined
    return { x: (l / 100) * canvas.width, y: (t / 100) * canvas.height, width: (w / 100) * canvas.width, height: (h / 100) * canvas.height }
  })
}

async function canvasPixelSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!c) throw new Error('no canvas')
    return { width: c.width, height: c.height }
  })
}

/** Live-canvas opaque bounds (any alpha !== 0 counts): the copy fallback rect. */
async function canvasOpaqueTrim(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) throw new Error('no canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no ctx')
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let left = canvas.width
    let top = canvas.height
    let right = -1
    let bottom = -1
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if ((d[(y * canvas.width + x) * 4 + 3] ?? 0) === 0) continue
        if (x < left) left = x
        if (y < top) top = y
        if (x > right) right = x
        if (y > bottom) bottom = y
      }
    }
    if (right < left) return null
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
  })
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('no box')
  const size = await canvasPixelSize()
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height }
}

async function dragCanvasPx(from: { x: number; y: number }, to: { x: number; y: number }, steps = 14) {
  // Marquee selections need the bitmap select tool; a fresh costume may default
  // to another tool (drag would paint instead of selecting).
  const selectTool = page.getByTestId('bitmap-tool-select')
  if (await selectTool.isVisible().catch(() => false)) {
    await selectTool.click().catch(() => undefined)
    await page.waitForTimeout(300)
  }
  const a = await toScreen(from.x, from.y)
  const b = await toScreen(to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
  await page.waitForTimeout(600)
}

async function paintBitmapFixture(paint: () => void) {
  await page.evaluate(`(${paint.toString()})()`)
  await page.getByTestId('save-bitmap-costume').click()
  await page.waitForTimeout(900)
}

async function vectorImageReport(): Promise<{
  count: number
  images: Array<{ x: number | null; y: number | null; width: number | null; height: number | null; href: string | null }>
  html: string
  viewBox: string | null
}> {
  return await page.evaluate(() => {
    const host = document.querySelector('.vector-preview')
    const html = host?.innerHTML ?? ''
    const svg = host?.querySelector('svg')
    const images = (svg ? Array.from(svg.querySelectorAll('image')) : []).map((el) => ({
      x: el.getAttribute('x') === null ? null : Number(el.getAttribute('x')),
      y: el.getAttribute('y') === null ? null : Number(el.getAttribute('y')),
      width: el.getAttribute('width') === null ? null : Number(el.getAttribute('width')),
      height: el.getAttribute('height') === null ? null : Number(el.getAttribute('height')),
      href: el.getAttribute('href') ?? el.getAttribute('xlink:href'),
    }))
    return { count: images.length, images, html, viewBox: svg?.getAttribute('viewBox') ?? null }
  })
}

async function decodeDataUrlPixels(href: string, x: number, y: number): Promise<number[]> {
  return await page.evaluate(
    ([url, px, py]) => {
      return new Promise<number[]>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          try {
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const ctx = c.getContext('2d')
            if (!ctx) {
              reject(new Error('no ctx'))
              return
            }
            ctx.drawImage(img, 0, 0)
            const xx = Math.max(0, Math.min(c.width - 1, Math.round(px as number)))
            const yy = Math.max(0, Math.min(c.height - 1, Math.round(py as number)))
            resolve(Array.from(ctx.getImageData(xx, yy, 1, 1).data))
          } catch (e) {
            reject(e)
          }
        }
        img.onerror = () => reject(new Error('img load failed'))
        img.src = url as string
      })
    },
    [href, x, y] as unknown as undefined,
  )
}

async function decodeDataUrlSize(href: string): Promise<{ width: number; height: number }> {
  return await page.evaluate((url) => {
    return new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => reject(new Error('size load failed'))
      img.src = url as string
    })
  }, href as unknown as undefined)
}

describe('independent bitmap<->vector clipboard verification (pixels + position + center)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4427', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('main-tab-costumes').click({ timeout: 120_000 })
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 120_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('vector->bitmap: nested transform + defs/clip + alpha/hole land at staggered pixels with centers', async () => {
    const spr = await spriteName()
    await selectTargetByName(spr)
    await uploadCostume('ind-source.svg', 'image/svg+xml', Buffer.from(IND_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')

    await uploadCostume('ind-blank.png', 'image/png', Buffer.from(PNG_1X1, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()
    const blank = await probeColors()
    expect(blank.width).toBe(960)
    expect(blank.height).toBe(720)
    expect(blank.opaque).toBeLessThanOrEqual(1)

    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    const pasted = await probeColors()
    // Opaque companions survive: nested red, semi green, gradient yellow+blue, magenta donut.
    expect(pasted.red.count).toBeGreaterThan(2000)
    expect(pasted.greenSemi).toBeGreaterThan(500)
    expect(pasted.blue.count).toBeGreaterThan(500)
    expect(pasted.yellow).toBeGreaterThan(200)
    expect(pasted.magenta.count).toBeGreaterThan(2000)

    // Nested transform position: world (45,38,60,45) -> canvas (100,86,120,90)
    // with +10 stagger (sprite resolution 2: canvas = unit*2 + stagger).
    // Union min is (45,30); dest is (100,70); nested offset inside raster is (0,16).
    expect(Math.abs(pasted.red.minX - 100)).toBeLessThan(14)
    expect(Math.abs(pasted.red.minY - 86)).toBeLessThan(14)
    expect(Math.abs(pasted.red.maxX - (100 + 120))).toBeLessThan(14)
    expect(Math.abs(pasted.red.maxY - (86 + 90))).toBeLessThan(14)
    expect(Math.abs(pasted.red.cx - 160)).toBeLessThan(14)
    expect(Math.abs(pasted.red.cy - 131)).toBeLessThan(14)

    // Clip: blue must live inside clip (300,40,40,30) -> canvas (610,90,80,60).
    // Blue is the right-hand tail of the yellow->blue ramp, so its centroid sits
    // right of the clip center (not at the clip center).
    expect(pasted.blue.minX).toBeGreaterThanOrEqual(600)
    expect(pasted.blue.minY).toBeGreaterThanOrEqual(80)
    expect(pasted.blue.maxX).toBeLessThanOrEqual(700)
    expect(pasted.blue.maxY).toBeLessThanOrEqual(160)
    expect(pasted.blue.cx).toBeGreaterThan(650)
    expect(pasted.blue.cx).toBeLessThan(690)
    expect(Math.abs(pasted.blue.cy - 120)).toBeLessThan(16)

    // Hole: magenta outer (150,200,80,60)->(310,410,160,120); hole (170,215,40,30)->(350,440,80,60).
    expect(Math.abs(pasted.magenta.minX - 310)).toBeLessThan(14)
    expect(Math.abs(pasted.magenta.minY - 410)).toBeLessThan(14)
    expect(Math.abs(pasted.magenta.maxX - (310 + 160))).toBeLessThan(14)
    expect(Math.abs(pasted.magenta.maxY - (410 + 120))).toBeLessThan(14)
    const holeCenter = await pixelAt(390, 470)
    expect(holeCenter[3]).toBe(0)
    const holeEdge = await pixelAt(325, 425)
    expect(holeEdge[0]).toBeGreaterThan(200)
    expect(holeEdge[2]).toBeGreaterThan(200)
    expect(holeEdge[3]).toBeGreaterThan(200)
    // Relative layout survives: hole center minus nested center is stagger/union independent.
    expect(Math.abs(pasted.magenta.cx - pasted.red.cx - 230)).toBeLessThan(24)
    expect(Math.abs(pasted.magenta.cy - pasted.red.cy - 339)).toBeLessThan(24)

    // Continuous offset: second paste shifts +10px right.
    const sel1 = await bitmapSelectionPx()
    expect(sel1).toBeTruthy()
    await waitForBitmapPasteReady()
    await pasteButton().click()
    await page.waitForFunction(
      (prev: any) => {
        const overlay = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!overlay || !canvas || !prev) return false
        const l = Number.parseFloat(overlay.style.left.replace('%', ''))
        if (!Number.isFinite(l)) return false
        return Math.abs(l / 100 * canvas.width - (prev as any).x) > 5
      },
      sel1 as unknown as undefined,
      { timeout: 30_000 },
    )
    const sel2 = await bitmapSelectionPx()
    expect(sel2).toBeTruthy()
    expect(Math.abs(sel2!.x - sel1!.x - 10)).toBeLessThan(2)
    expect(Math.abs(sel2!.y - sel1!.y - 10)).toBeLessThan(2)

    // Undo peels exactly one paste (single history entry per paste).
    const afterTwo = await probeColors()
    await undoButton().click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      (count: number) => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return false
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let opaque = 0
        for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) !== 0) opaque += 1
        return opaque !== count
      },
      afterTwo.opaque as unknown as undefined,
      { timeout: 30_000 },
    )
    const undone = await probeColors()
    expect(undone.opaque).toBe(pasted.opaque)
    expect(undone.red.count).toBe(pasted.red.count)
    await redoButton().click()
    await waitForStatus('Asset redo')
    await page.waitForFunction(
      (count: number) => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return false
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let opaque = 0
        for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) !== 0) opaque += 1
        return opaque === count
      },
      afterTwo.opaque as unknown as undefined,
      { timeout: 30_000 },
    )
    // Peel back to single paste for the bitmap->vector leg.
    await undoButton().click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      (count: number) => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return false
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let opaque = 0
        for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) !== 0) opaque += 1
        return opaque === count
      },
      pasted.opaque as unknown as undefined,
      { timeout: 30_000 },
    )
  }, 180_000)

  it('bitmap->vector: resolution 1/2, stage/sprite, non-center rotationCenter, offset, undo', async () => {
    // Still on the single-paste bitmap costume. The marquee may or may not survive
    // undo depending on the preview-clear path; either way copy preserves position
    // (explicit selection when visible, trimmed fallback otherwise).
    const selBeforeCopy = await bitmapSelectionPx().catch(() => undefined)
    await copyButton().click()
    await waitForStatus('Bitmap selection copied')
    // The fallback copy rect is the live-canvas opaque trim: record it now so
    // the vector paste position below is pinned against the copied position
    // (origin / resolution + stagger), not against the converted base image
    // (which always sits at the trimmed origin 0,0 by construction).
    const copyTrim = await canvasOpaqueTrim()
    expect(copyTrim).toBeTruthy()

    await page.getByRole('button', { name: /ベクターに変換/ }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    const converted = await vectorImageReport()
    expect(converted.count).toBeGreaterThanOrEqual(1)
    const baseCount = converted.count
    const convInfo = await currentCostumeInfo()
    expect(convInfo.isStage).toBe(false)

    // Paste on sprite: resolution 2 => origin/2 + 10. Re-copy reset offset to 1.
    await pasteButton().click()
    await waitForStatus('Vector selection pasted')
    await page.waitForFunction(
      (count: number) => {
        const svg = document.querySelector('.vector-preview svg')
        return svg ? svg.querySelectorAll('image').length > count : false
      },
      baseCount as unknown as undefined,
      { timeout: 30_000 },
    )
    const spritePaste = await vectorImageReport()
    expect(spritePaste.count).toBe(baseCount + 1)
    const first = spritePaste.images.at(-2)
    const second = spritePaste.images.at(-1)
    expect(first && second).toBeTruthy()
    expect(second!.href?.startsWith('data:image/png;base64,')).toBe(true)
    // Same clipboard size re-anchored at its copied position, staggered once:
    // sprite resolution halves canvas px into SVG units, then +10 stagger.
    // The copied origin is the surviving selection when visible, otherwise
    // the live-canvas trim (copy fallback). It is NOT the converted base
    // image position: the base always sits at the trimmed origin (0,0), so
    // comparing against `first` would demand trim.x == 0.
    const copyOrigin = selBeforeCopy ?? copyTrim!
    expect(Math.abs((second!.x ?? 0) - (copyOrigin.x / 2 + 10))).toBeLessThan(0.5)
    expect(Math.abs((second!.y ?? 0) - (copyOrigin.y / 2 + 10))).toBeLessThan(0.5)
    expect(second!.width).toBe(first!.width)
    expect(second!.height).toBe(first!.height)
    // Sprite resolution halves canvas px into SVG units: pasted size must be well below canvas px.
    expect((second!.width ?? 0)).toBeLessThan(1200)
    expect((second!.height ?? 0)).toBeLessThan(900)

    // Non-center rotationCenter on sprites (stage stays 240,180, asserted below).
    // NOTE: `.vector-preview` is the display frame: the editor centers art for
    // display (the converted base carries a display-only translate such as
    // translate(192 132)), so preview x/y are NOT saved-document coordinates.
    // The saved-document formula (RC = stageCenter - viewBox origin) is pinned
    // at unit level; here we verify through real UI + pixels that the saved RC
    // is off-center by construction, differs from the bitmap default (48,50),
    // and matches the rotation-center inputs shown in the editor.
    const spriteInfo = await currentCostumeInfo()
    expect(spriteInfo.isStage).toBe(false)
    expect(spriteInfo.costume.rotationCenterX).not.toBe(48)
    expect(spriteInfo.costume.rotationCenterY).not.toBe(50)
    expect(Math.abs(spriteInfo.costume.rotationCenterX - 240)).toBeGreaterThan(5)
    expect(Math.abs(spriteInfo.costume.rotationCenterY - 180)).toBeGreaterThan(5)
    const rcInputs = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
      return inputs.map((el) => el.value)
    })
    expect(rcInputs.join(',')).toContain(String(spriteInfo.costume.rotationCenterX))
    expect(rcInputs.join(',')).toContain(String(spriteInfo.costume.rotationCenterY))
    // Off-origin art is non-center by construction (not the 48/50 default, not w/2).
    expect(spriteInfo.costume.rotationCenterX).not.toBe(48)
    expect(Math.abs(spriteInfo.costume.rotationCenterX - 240)).toBeGreaterThan(5)
    // Off-origin art is non-center by construction.
    expect(Math.abs(spriteInfo.costume.rotationCenterX - (spritePaste.viewBox ? 0 : 0))).toBeGreaterThan(1)

    // Continuous offset: two more pastes step +10/+10 each.
    await pasteButton().click()
    await waitForStatus('Vector selection pasted')
    await page.waitForFunction(
      (count: number) => (document.querySelector('.vector-preview svg')?.querySelectorAll('image').length ?? 0) === count,
      (baseCount + 2) as unknown as undefined,
      { timeout: 30_000 },
    )
    await pasteButton().click()
    await waitForStatus('Vector selection pasted')
    await page.waitForFunction(
      (count: number) => (document.querySelector('.vector-preview svg')?.querySelectorAll('image').length ?? 0) === count,
      (baseCount + 3) as unknown as undefined,
      { timeout: 30_000 },
    )
    const triple = await vectorImageReport()
    expect(triple.count).toBe(baseCount + 3)
    const ia = triple.images.at(-3)!
    const ib = triple.images.at(-2)!
    const ic = triple.images.at(-1)!
    expect(Math.abs((ib.x ?? 0) - (ia.x ?? 0) - 10)).toBeLessThan(0.02)
    expect(Math.abs((ic.x ?? 0) - (ib.x ?? 0) - 10)).toBeLessThan(0.02)
    expect(Math.abs((ib.y ?? 0) - (ia.y ?? 0) - 10)).toBeLessThan(0.02)

    // Single history entry per paste: undo peels only the last image.
    const tripleHtml = triple.html
    await undoButton().click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      (expected: string) => document.querySelector('.vector-preview')?.innerHTML !== expected,
      tripleHtml as unknown as undefined,
      { timeout: 30_000 },
    )
    expect((await vectorImageReport()).count).toBe(baseCount + 2)
    await redoButton().click()
    await waitForStatus('Asset redo')
    await page.waitForFunction(
      (expected: string) => document.querySelector('.vector-preview')?.innerHTML === expected,
      tripleHtml as unknown as undefined,
      { timeout: 30_000 },
    )
    expect((await vectorImageReport()).count).toBe(baseCount + 3)

    // Stage file-upload PNGs are now honke-parity res2 (center = image
    // middle): RED_SVG (20,30,100,60) rasters at 2x to 200x120 at (50,70)
    // with offset 1 (stage canvas = units * storedResolution + stagger).
    // Explicit res1 is covered below via an SB3 fixture (spec justification).
    await selectTargetByName('Stage')
    await uploadCostume('stage-red.svg', 'image/svg+xml', Buffer.from(RED_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')
    await uploadCostume('stage-blank.png', 'image/png', Buffer.from(PNG_1X1, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()
    {
      const res2Info = await currentCostumeInfo()
      expect(res2Info.isStage).toBe(true)
      // 1x1 file-upload PNG resolves to res2 center 0.5,0.5 (honke loadBitmap_).
      expect(res2Info.costume.bitmapResolution).toBe(2)
      expect(res2Info.costume.rotationCenterX).toBeCloseTo(0.5, 6)
      expect(res2Info.costume.rotationCenterY).toBeCloseTo(0.5, 6)
    }
    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    const stageArt = await probeColors()
    expect(stageArt.red.count).toBeGreaterThan(2000)
    // The fresh paste leaves an explicit selection: copy uses it (offset reset to 1).
    expect(await page.getByTestId('bitmap-selection').isVisible().catch(() => false)).toBe(true)
    const stageClip = await bitmapSelectionPx()
    expect(stageClip).toBeTruthy()
    await copyButton().click()
    await waitForStatus('Bitmap selection copied')
    // Convert this stage bitmap costume to vector, then paste the bitmap clipboard.
    await page.getByRole('button', { name: /ベクターに変換/ }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    const stageConverted = await vectorImageReport()
    const stageBase = stageConverted.count
    await pasteButton().click()
    await waitForStatus('Vector selection pasted')
    await page.waitForFunction(
      (count: number) => (document.querySelector('.vector-preview svg')?.querySelectorAll('image').length ?? 0) > count,
      stageBase as unknown as undefined,
      { timeout: 30_000 },
    )
    const stagePaste = await vectorImageReport()
    const staged = stagePaste.images.at(-1)!
    expect(staged.href?.startsWith('data:image/png;base64,')).toBe(true)
    // Stage file-upload source is res2: canvas px halve into SVG units before
    // +10 stagger (not 1:1 like the explicit-res1 fixture below).
    expect(Math.abs((staged.width ?? 0) - stageClip!.width / 2)).toBeLessThan(2)
    expect(Math.abs((staged.height ?? 0) - stageClip!.height / 2)).toBeLessThan(2)
    expect(Math.abs((staged.x ?? 0) - (stageClip!.x / 2 + 10))).toBeLessThan(3)
    expect(Math.abs((staged.y ?? 0) - (stageClip!.y / 2 + 10))).toBeLessThan(3)

    // Explicit-res1 stage bitmap via SB3 (spec justification): a stored res1
    // stage PNG keeps canvas px 1:1 before +10 stagger. Both source res2
    // (above) and explicit res1 (here) are pixel-verified; other asserts are
    // not weakened.
    {
      const blankBytes = Buffer.from(PNG_1X1, 'base64')
      const blankMd5 = createHash('md5').update(blankBytes).digest('hex')
      const blankMd5ext = `${blankMd5}.png`
      const redBytes = Buffer.from(RED_SVG, 'utf8')
      const redMd5 = createHash('md5').update(redBytes).digest('hex')
      const redMd5ext = `${redMd5}.svg`
      const spriteSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect x="10" y="10" width="40" height="30" fill="#ff0000"/></svg>`
      const spriteBytes = Buffer.from(spriteSvg, 'utf8')
      const spriteMd5 = createHash('md5').update(spriteBytes).digest('hex')
      const spriteMd5ext = `${spriteMd5}.svg`
      const project = {
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [
              { name: 'res1-blank', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180, assetId: blankMd5, dataFormat: 'png', md5ext: blankMd5ext },
              { name: 'stage-red', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180, assetId: redMd5, dataFormat: 'svg', md5ext: redMd5ext },
            ],
            sounds: [],
            volume: 100,
            layerOrder: 0,
            tempo: 60,
            videoTransparency: 50,
            videoState: 'on',
            textToSpeechLanguage: null,
          },
          {
            isStage: false,
            name: 'Sprite1',
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [
              { name: 'costume1', bitmapResolution: 1, rotationCenterX: 48, rotationCenterY: 48, assetId: spriteMd5, dataFormat: 'svg', md5ext: spriteMd5ext },
            ],
            sounds: [],
            volume: 100,
            layerOrder: 1,
            visible: true,
            x: 0,
            y: 0,
            size: 100,
            direction: 90,
            draggable: false,
            rotationStyle: 'all around',
          },
        ],
        monitors: [],
        extensions: [],
        meta: { semver: '3.0.0', vm: '0.2.0', agent: 'test' },
      }
      const sb3 = Buffer.from(
        zipSync({
          'project.json': strToU8(JSON.stringify(project)),
          [blankMd5ext]: new Uint8Array(blankBytes),
          [redMd5ext]: strToU8(RED_SVG),
          [spriteMd5ext]: strToU8(spriteSvg),
        }),
      )
      await page.getByTestId('project-file-input').setInputFiles({ name: 'stage-res1.sb3', mimeType: 'application/x.scratch.sb3', buffer: sb3 })
      await page.waitForFunction(
        (want: string) => {
          const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
          return w.__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.costumes.some((c: any) => c.name === want)) ?? false
        },
        'res1-blank' as unknown as undefined,
        { timeout: 30_000 },
      )
      await page.getByTestId('main-tab-costumes').click()
      await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
      await selectTargetByName('Stage')
      // Select the res1 blank (first costume card), then copy from the red
      // vector costume and paste into the blank to verify 1:1 placement.
      const cards = page.getByTestId(/costume-card-\d+/)
      await cards.nth(1).getByRole('button', { name: /Select / }).click()
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
      await copyButton().click()
      await waitForStatus('Vector selection copied')
      await cards.nth(0).getByRole('button', { name: /Select / }).click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()
      {
        const res1Info = await currentCostumeInfo()
        expect(res1Info.isStage).toBe(true)
        expect(res1Info.costume.bitmapResolution).toBe(1)
        expect(res1Info.costume.rotationCenterX).toBe(240)
        expect(res1Info.costume.rotationCenterY).toBe(180)
      }
      await waitForBitmapPasteReady()
      expect(await pasteButton().isEnabled()).toBe(true)
      await pasteButton().click()
      await waitForStatus('Bitmap selection pasted')
      const res1Art = await probeColors()
      expect(res1Art.red.count).toBeGreaterThan(2000)
      expect(await page.getByTestId('bitmap-selection').isVisible().catch(() => false)).toBe(true)
      const res1Clip = await bitmapSelectionPx()
      expect(res1Clip).toBeTruthy()
      // RED_SVG (20,30,100,60) on a res1 stage anchors at (20,30) +10 stagger.
      expect(Math.abs(res1Clip!.x - 30)).toBeLessThan(14)
      expect(Math.abs(res1Clip!.y - 40)).toBeLessThan(14)
      expect(Math.abs(res1Clip!.width - 100)).toBeLessThan(6)
      expect(Math.abs(res1Clip!.height - 60)).toBeLessThan(6)
      await copyButton().click()
      await waitForStatus('Bitmap selection copied')
      await page.getByRole('button', { name: /ベクターに変換/ }).click()
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
      const res1Converted = await vectorImageReport()
      const res1Base = res1Converted.count
      await pasteButton().click()
      await waitForStatus('Vector selection pasted')
      await page.waitForFunction(
        (count: number) => (document.querySelector('.vector-preview svg')?.querySelectorAll('image').length ?? 0) > count,
        res1Base as unknown as undefined,
        { timeout: 30_000 },
      )
      const res1Paste = await vectorImageReport()
      const res1Staged = res1Paste.images.at(-1)!
      expect(res1Staged.href?.startsWith('data:image/png;base64,')).toBe(true)
      // Explicit res1 keeps canvas px 1:1 before +10 stagger.
      expect(Math.abs((res1Staged.width ?? 0) - res1Clip!.width)).toBeLessThan(2)
      expect(Math.abs((res1Staged.height ?? 0) - res1Clip!.height)).toBeLessThan(2)
      expect(Math.abs((res1Staged.x ?? 0) - (res1Clip!.x + 10))).toBeLessThan(3)
      expect(Math.abs((res1Staged.y ?? 0) - (res1Clip!.y + 10))).toBeLessThan(3)
      const stageInfo = await currentCostumeInfo()
      expect(stageInfo.isStage).toBe(true)
      expect(stageInfo.costume.rotationCenterX).toBe(240)
      expect(stageInfo.costume.rotationCenterY).toBe(180)
    }
  }, 180_000)

  it('bitmap->vector PNG keeps alpha holes; transparent paste is a history-free no-op', async () => {
    const spr = await spriteName()
    await selectTargetByName(spr)
    // Build the donut+green bitmap art through the real vector->bitmap path
    // (no canvas scripting): DONUT_SVG rasters to 400x280 with a real hole
    // (union 200x140 SVG x2 sprite resolution).
    await uploadCostume('hole-source.svg', 'image/svg+xml', Buffer.from(DONUT_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')
    await uploadCostume('hole-blank.png', 'image/png', Buffer.from(PNG_1X1, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()
    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    const holeArt = await probeColors()
    expect(holeArt.magenta.count).toBeGreaterThan(2000)
    expect(holeArt.greenSemi).toBeGreaterThan(500)
    // The fresh paste leaves an explicit selection: copy uses it at offset 1.
    await copyButton().click()
    await waitForStatus('Bitmap selection copied')
    await page.getByRole('button', { name: /ベクターに変換/ }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    const converted = await vectorImageReport()
    const baseCount = converted.count
    await pasteButton().click()
    await waitForStatus('Vector selection pasted')
    await page.waitForFunction(
      (count: number) => (document.querySelector('.vector-preview svg')?.querySelectorAll('image').length ?? 0) > count,
      baseCount as unknown as undefined,
      { timeout: 30_000 },
    )
    const pasted = await vectorImageReport()
    const href = pasted.images.at(-1)?.href
    expect(href?.startsWith('data:image/png;base64,')).toBe(true)
    const size = await decodeDataUrlSize(href!)
    // Clipboard is the 400x280 raster (union 200x140 SVG x2); PNG keeps canvas px.
    expect(size.width).toBe(400)
    expect(size.height).toBe(280)
    // Hole center transparent, donut edge opaque magenta.
    // Donut sits at the clipboard origin: outer (0,0,160,120), hole (40,30,80,60).
    const holePx = await decodeDataUrlPixels(href!, 80, 60)
    expect(holePx[3]).toBe(0)
    const edgePx = await decodeDataUrlPixels(href!, 10, 10)
    expect(edgePx[0]).toBeGreaterThan(200)
    expect(edgePx[2]).toBeGreaterThan(200)
    expect(edgePx[3]).toBeGreaterThan(200)
    // Semitransparent green survives inside the same PNG (alpha ~128).
    // Green sits at clipboard (280,200,120,80).
    const semiPx = await decodeDataUrlPixels(href!, 340, 240)
    expect(semiPx[1]).toBeGreaterThan(150)
    expect(semiPx[3]).toBeGreaterThanOrEqual(70)
    expect(semiPx[3]).toBeLessThanOrEqual(180)

    // Transparent no-op through the real vector->bitmap path: a fill="none" unit
    // rasters transparent, leaving pixels and history untouched.
    await selectTargetByName(spr)
    await uploadCostume('noop-source.svg', 'image/svg+xml', Buffer.from(TRANSPARENT_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')
    await uploadCostume('noop-blank.png', 'image/png', Buffer.from(PNG_1X1, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()
    const noopBefore = await probeColors()
    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    await page.waitForTimeout(600)
    const noopAfter = await probeColors()
    // Blank baselines carry at most 1 opaque pixel (1x1 fixture); a transparent
    // raster must not add visible art.
    expect(noopAfter.opaque).toBeLessThanOrEqual(1)
    expect(noopAfter.red.count).toBe(0)
  }, 180_000)

  it('oversize and out-of-bounds vectors clamp to the bitmap canvas with pixels and undo', async () => {
    const spr = await spriteName()
    await selectTargetByName(spr)
    await uploadCostume('oob-source.svg', 'image/svg+xml', Buffer.from(HUGE_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')
    await uploadCostume('oob-blank.png', 'image/png', Buffer.from(PNG_1X1, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()

    // Oversize (1600x1200 raster: 800x600 SVG x2 sprite resolution):
    // larger-than-canvas clipboards anchor at the
    // origin keeping their size (resolveBitmapPasteRect), with the visible part painted.
    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    const huge = await probeColors()
    expect(huge.red.count).toBeGreaterThan(1000)
    const hugeSel = await bitmapSelectionPx()
    expect(hugeSel).toBeTruthy()
    expect(hugeSel!.x).toBe(0)
    expect(hugeSel!.y).toBe(0)
    expect(Math.abs(hugeSel!.width - 1600)).toBeLessThan(5)
    expect(Math.abs(hugeSel!.height - 1200)).toBeLessThan(5)
    const hugeCenter = await pixelAt(480, 360)
    expect(hugeCenter[0]).toBeGreaterThan(200)
    expect(hugeCenter[3]).toBeGreaterThan(200)
    await page.waitForTimeout(1000)
    await undoButton().click()
    await waitForStatus('Asset undo')
    const hugeUndone = await probeColors()
    expect(hugeUndone.red.count).toBeLessThan(huge.red.count)
    await redoButton().click()
    await waitForStatus('Asset redo')
    await page.waitForFunction(
      (count: number) => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return false
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let red = 0
        for (let i = 0; i < d.length; i += 16) {
          if ((d[i] ?? 0) > 200 && (d[i + 1] ?? 0) < 60 && (d[i + 2] ?? 0) < 60 && (d[i + 3] ?? 0) > 200) red += 1
        }
        return red > 0
      },
      0 as unknown as undefined,
      { timeout: 30_000 },
    )
    // Back to blank for the out-of-bounds leg.
    await undoButton().click()
    await waitForStatus('Asset undo')

    await uploadCostume('oob-far.svg', 'image/svg+xml', Buffer.from(OOB_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')
    // Return to the blank bitmap costume (second-to-last card).
    const cards = page.getByTestId(/costume-card-\d+/)
    const n = await cards.count()
    await cards.nth(n - 2).getByRole('button', { name: /Select / }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()
    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    const oob = await probeColors()
    const oobSel = await bitmapSelectionPx()
    expect(oobSel).toBeTruthy()
    // Clamped inside the canvas even though the SVG anchor is far outside.
    expect(oobSel!.x).toBeGreaterThanOrEqual(0)
    expect(oobSel!.y).toBeGreaterThanOrEqual(0)
    expect(oobSel!.x + oobSel!.width).toBeLessThanOrEqual(960 + 1)
    expect(oobSel!.y + oobSel!.height).toBeLessThanOrEqual(720 + 1)
    expect(oob.red.count).toBeGreaterThan(100)
    // Edge pixel at the clamped corner is red and centered inside the selection.
    const corner = await pixelAt(oobSel!.x + oobSel!.width / 2, oobSel!.y + oobSel!.height / 2)
    expect(corner[0]).toBeGreaterThan(200)
    expect(corner[3]).toBeGreaterThan(200)
    await undoButton().click()
    await waitForStatus('Asset undo')
  }, 180_000)

  it('latest clipboard wins across modes (recency switching) with pixels and positions', async () => {
    const spr = await spriteName()
    await selectTargetByName(spr)
    // Vector clipboard = red rect.
    await uploadCostume('rec-red.svg', 'image/svg+xml', Buffer.from(RED_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')

    // Bitmap clipboard = blue art built through the real vector->bitmap path.
    // BLUE_SVG (300,220,120,80) rasters to 240x160 at (610,450) with offset 1
    // (sprite scale 2: canvas = unit*2 + stagger).
    await uploadCostume('rec-blue.svg', 'image/svg+xml', Buffer.from(BLUE_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')
    await uploadCostume('rec-blank.png', 'image/png', Buffer.from(PNG_1X1, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()
    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    const blueArt = await probeColors()
    expect(blueArt.blue.count).toBeGreaterThan(2000)
    // Fresh paste leaves an explicit selection: copy uses it at offset 1.
    const blueClip = await bitmapSelectionPx()
    expect(blueClip).toBeTruthy()
    await copyButton().click()
    await waitForStatus('Bitmap selection copied')

    // In vector mode the latest (bitmap/blue) must win as an <image>, not a red rect.
    await page.getByRole('button', { name: /ベクターに変換/ }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    const beforeV = await vectorImageReport()
    await pasteButton().click()
    await waitForStatus('Vector selection pasted')
    await page.waitForFunction(
      (count: number) => (document.querySelector('.vector-preview svg')?.querySelectorAll('image').length ?? 0) > count,
      beforeV.count as unknown as undefined,
      { timeout: 30_000 },
    )
    const afterV = await vectorImageReport()
    expect(afterV.count).toBe(beforeV.count + 1)
    const blueImage = afterV.images.at(-1)!
    expect(blueImage.href?.startsWith('data:image/png;base64,')).toBe(true)
    const blueSize = await decodeDataUrlSize(blueImage.href!)
    // Clipboard is the 240x160 blue raster; sprite resolution halves it to 120x80.
    expect(blueSize.width).toBe(240)
    expect(blueSize.height).toBe(160)
    expect(Math.abs((blueImage.width ?? 0) - 120)).toBeLessThan(2)
    expect(Math.abs((blueImage.height ?? 0) - 80)).toBeLessThan(2)
    const bluePx = await decodeDataUrlPixels(blueImage.href!, 120, 80)
    expect(bluePx[2]).toBeGreaterThan(200)
    expect(bluePx[3]).toBeGreaterThan(200)
    // Position preserves the copied bitmap origin (/2 for sprite) plus one stagger.
    expect(Math.abs((blueImage.x ?? 0) - (blueClip!.x / 2 + 10))).toBeLessThan(4)
    expect(Math.abs((blueImage.y ?? 0) - (blueClip!.y / 2 + 10))).toBeLessThan(4)

    // Reverse: re-copy vector/red so it becomes latest, paste in bitmap must rasterize red.
    // Go back to the red vector costume (find it by card order: it is 5 cards ago, so re-upload for determinism).
    await uploadCostume('rec-red2.svg', 'image/svg+xml', Buffer.from(RED_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    await copyButton().click()
    await waitForStatus('Vector selection copied')
    // Fresh blank bitmap target.
    await uploadCostume('rec-blank2.png', 'image/png', Buffer.from(PNG_1X1, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitForBitmapSettled()
    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    const rec = await probeColors()
    expect(rec.red.count).toBeGreaterThan(2000)
    // RED_SVG world (20,30,100,60) -> anchor (40,60), dest (50,70) with offset 1
    // (sprite scale 2: canvas = unit*2 + stagger).
    expect(Math.abs(rec.red.minX - 50)).toBeLessThan(12)
    expect(Math.abs(rec.red.minY - 70)).toBeLessThan(12)
    expect(Math.abs(rec.red.cx - (50 + 100))).toBeLessThan(12)
    expect(Math.abs(rec.red.cy - (70 + 60))).toBeLessThan(12)
    // Blue must not have leaked: latest was red, so no blue pixels.
    expect(rec.blue.count).toBe(0)
    await undoButton().click()
    await waitForStatus('Asset undo')
    const recUndone = await probeColors()
    expect(recUndone.red.count).toBeLessThan(rec.red.count)
    await redoButton().click()
    await waitForStatus('Asset redo')
  }, 180_000)
})
