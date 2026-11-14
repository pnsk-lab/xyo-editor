import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor preview/commit parity + fill-tool radial center + transparent +
// Undo/Redo, all verified on real pixels (rasterized in real Chrome from the
// real editor's own SVG strings, never from synthetic helper output).
//
// - Draws landscape/portrait rects at different positions with horizontal,
//   vertical, and radial fill gradients; captures the live
//   `VectorShapePreview` SVG mid-drag and the committed `.vector-preview` SVG
//   after mouse-up, isolates each shape (+ its own defs) into a 480x360 SVG,
//   rasterizes both via `<img>` + canvas, and compares full RGBA bytes.
//   Preview and commit must use identical `userSpaceOnUse` geometry (no
//   legacy `objectBoundingBox`).
// - Draws a horizontal line with a vertical stroke gradient and a vertical
//   line with a horizontal stroke gradient (orthogonal zero-span): the commit
//   must carry a non-degenerate `userSpaceOnUse` ramp (span `0.01`, never
//   equal endpoints) and rasterize to real gradient pixels, matching the
//   preview pixels.
// - Fill-tool radial center: draws a rect, switches the fill to radial, and
//   clicks the fill tool at two different interior points with otherwise
//   unchanged colors. The second click must still write history (recenter),
//   change pixels, and survive Undo/Redo. A repeat click on the same point
//   with the same colors stays a clean no-op without touching history/redo.
// - Transparent fill+stroke via Apply: an opaque rect becomes `fill="none"`
//   + `stroke="none"`, the interior rasterizes to transparent, and Undo/Redo
//   restores it pixel-exactly. (Drawing a fully transparent shape is a
//   no-op by design, so this path goes through Apply instead.)

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4371'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

type RasterComparison = {
  maxAbs: number
  meanAbs: number
  diffPixels: number
  totalPixels: number
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewChange(before: string) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before,
    { timeout: 15_000 },
  )
}

async function clearCanvas() {
  await page.getByTestId('vector-shape-select').last().click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-vector-selection-outline]').length === 0,
    null,
    { timeout: 10_000 },
  )
}

async function surfaceBox() {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  return box
}

async function setFillGradient(kind: string) {
  await page.getByLabel('Vector paint style').selectOption(kind)
}

async function setStrokeGradient(kind: string) {
  await page.getByTestId('vector-stroke-gradient').selectOption(kind)
}

async function ensureToggle(name: string, wantOn: boolean) {
  const toggle = page.getByRole('button', { name })
  await toggle.waitFor({ state: 'visible', timeout: 10_000 })
  const pressed = await toggle.getAttribute('aria-pressed')
  if ((pressed === 'true') !== wantOn) await toggle.click()
}

function applyButton() {
  return page.getByTestId('apply-vector-style')
}

function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(
    () => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status(),
  )
}

// Draw a shape and capture the live preview SVG mid-drag plus the committed
// `.vector-preview` SVG after mouse-up. Returns both raw strings.
// NOTE: `data-testid="vector-shape-preview"` lives on the `<svg>` itself.
async function drawWithPreviewCapture(
  toolTestId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<{ previewSvg: string; committedSvg: string }> {
  await page.getByTestId(toolTestId).last().click()
  const before = await previewSvg()
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.locator('[data-testid="vector-shape-preview"]').waitFor({ state: 'attached', timeout: 5_000 })
  const previewCaptured = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="vector-shape-preview"]')
    return node ? (node as unknown as SVGSVGElement).outerHTML : ''
  })
  await page.mouse.up()
  await waitForPreviewChange(before)
  const committed = await previewSvg()
  return { previewSvg: previewCaptured, committedSvg: committed }
}

// Rasterize two real-editor SVG strings (preview overlay SVG + committed
// `.vector-preview` innerHTML) by isolating each shape and its own defs into
// a 480x360 document, then compare full RGBA bytes in real Chrome.
async function comparePreviewVsCommit(
  previewSvgText: string,
  committedSvgText: string,
): Promise<{ parity: RasterComparison; previewDefs: string; commitDefs: string }> {
  return await page.evaluate(
    ({ preview, committed }: { preview: string; committed: string }) => {
      const loadImage = (svgText: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('svg-image-load-failed'))
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText)
        })
      const raster = async (svgText: string, w: number, h: number): Promise<Uint8ClampedArray> => {
        const img = await loadImage(svgText)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        return ctx.getImageData(0, 0, w, h).data
      }
      const isolatePreview = (svgText: string): string => {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
        const defs = Array.from(doc.querySelectorAll('defs')).map((d) => d.innerHTML).join('')
        const shape = doc.querySelector('rect, ellipse, line, path, circle')
        if (!shape) throw new Error('preview shape missing')
        return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs>${defs}</defs>${shape.outerHTML}</svg>`
      }
      const isolateCommitLast = (svgText: string): string => {
        const doc = new DOMParser().parseFromString(`<div>${svgText}</div>`, 'text/html')
        const svg = doc.querySelector('svg')
        if (!svg) throw new Error('commit svg missing')
        const defs = Array.from(svg.querySelectorAll('defs')).map((d) => d.innerHTML).join('')
        const shapes = Array.from(svg.querySelectorAll('rect, ellipse, line, path, circle'))
        if (shapes.length === 0) throw new Error('commit shape missing')
        const last = shapes[shapes.length - 1]!
        return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs>${defs}</defs>${last.outerHTML}</svg>`
      }
      const previewDefs = (() => {
        const doc = new DOMParser().parseFromString(preview, 'image/svg+xml')
        return Array.from(doc.querySelectorAll('defs')).map((d) => d.innerHTML).join('')
      })()
      const commitDefs = (() => {
        const doc = new DOMParser().parseFromString(`<div>${committed}</div>`, 'text/html')
        const svg = doc.querySelector('svg')
        return svg ? Array.from(svg.querySelectorAll('defs')).map((d) => d.innerHTML).join('') : ''
      })()
      const run = async () => {
        const a = await raster(isolatePreview(preview), 480, 360)
        const b = await raster(isolateCommitLast(committed), 480, 360)
        let maxAbs = 0
        let sum = 0
        let diffPixels = 0
        for (let i = 0; i < a.length; i += 4) {
          let pixelDiff = 0
          for (let k = 0; k < 4; k += 1) {
            const d = Math.abs(a[i + k]! - b[i + k]!)
            if (d > maxAbs) maxAbs = d
            sum += d
            if (d > pixelDiff) pixelDiff = d
          }
          if (pixelDiff > 0) diffPixels += 1
        }
        return {
          parity: {
            maxAbs,
            meanAbs: Number((sum / a.length).toFixed(4)),
            diffPixels,
            totalPixels: a.length / 4,
          } satisfies RasterComparison,
          previewDefs,
          commitDefs,
        }
      }
      return run()
    },
    { preview: previewSvgText, committed: committedSvgText },
  )
}

// Gradient element referenced by the last committed shape's stroke (or fill),
// by id. Defs from cleared shapes accumulate in the document, so picking the
// first gradient of a kind is wrong; follow the shape's own `url(#id)`.
async function commitLastShapeGradientCoords(
  svgText: string,
  side: 'fill' | 'stroke',
): Promise<{ tag: string; units: string | null; coords: string; ref: string } | undefined> {
  return await page.evaluate(
    ({ svg, side: s }: { svg: string; side: 'fill' | 'stroke' }) => {
      const doc = new DOMParser().parseFromString(`<div>${svg}</div>`, 'text/html')
      const svgEl = doc.querySelector('svg')
      if (!svgEl) return undefined
      const shapes = Array.from(svgEl.querySelectorAll('rect, ellipse, line, path, circle'))
      const last = shapes[shapes.length - 1] as unknown as Element | undefined
      if (!last) return undefined
      const raw = last.getAttribute(s) ?? ''
      const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(raw)
      if (!m) return { tag: '', units: null, coords: '', ref: raw }
      const g = svgEl.querySelector(`linearGradient[id="${m[1]}"], radialGradient[id="${m[1]}"]`)
      if (!g) return undefined
      return {
        tag: g.tagName.toLowerCase(),
        units: g.getAttribute('gradientUnits'),
        coords: ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r']
          .map((n) => `${n}=${g.getAttribute(n) ?? ''}`)
          .join(' '),
        ref: raw,
      }
    },
    { svg: svgText, side },
  )
}

// Full-RGBA diff between two committed SVGs (isolated last shape each),
// rasterized in real Chrome. Proves a fill click actually repainted.
async function diffCommittedSvgs(aSvg: string, bSvg: string): Promise<RasterComparison> {
  return await page.evaluate(
    ({ a, b }: { a: string; b: string }) => {
      const isolateLast = (svgText: string): string => {
        const doc = new DOMParser().parseFromString(`<div>${svgText}</div>`, 'text/html')
        const svg = doc.querySelector('svg')!
        const defs = Array.from(svg.querySelectorAll('defs')).map((d) => d.outerHTML).join('')
        const shapes = Array.from(svg.querySelectorAll('rect, ellipse, line, path, circle'))
        const last = shapes[shapes.length - 1]!
        return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${defs}${last.outerHTML}</svg>`
      }
      const loadImage = (text: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('svg-image-load-failed'))
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text)
        })
      return (async () => {
        const load = async (svgText: string) => {
          const img = await loadImage(isolateLast(svgText))
          const canvas = document.createElement('canvas')
          canvas.width = 480
          canvas.height = 360
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!
          ctx.clearRect(0, 0, 480, 360)
          ctx.drawImage(img, 0, 0, 480, 360)
          return ctx.getImageData(0, 0, 480, 360).data
        }
        const ra = await load(a)
        const rb = await load(b)
        let maxAbs = 0
        let sum = 0
        let diffPixels = 0
        for (let i = 0; i < ra.length; i += 4) {
          let pixelDiff = 0
          for (let k = 0; k < 4; k += 1) {
            const d = Math.abs(ra[i + k]! - rb[i + k]!)
            if (d > maxAbs) maxAbs = d
            sum += d
            if (d > pixelDiff) pixelDiff = d
          }
          if (pixelDiff > 0) diffPixels += 1
        }
        return { maxAbs, meanAbs: Number((sum / ra.length).toFixed(4)), diffPixels, totalPixels: ra.length / 4 }
      })()
    },
    { a: aSvg, b: bSvg },
  )
}

// Radial focus (cx/cy) of the last committed shape's fill gradient.
async function commitFillRadialFocus(svgText: string): Promise<{ cx: number; cy: number; r: number } | undefined> {
  return await page.evaluate((svg: string) => {
    const doc = new DOMParser().parseFromString(`<div>${svg}</div>`, 'text/html')
    const svgEl = doc.querySelector('svg')
    if (!svgEl) return undefined
    const shapes = Array.from(svgEl.querySelectorAll('rect, ellipse, line, path, circle'))
    const last = shapes[shapes.length - 1] as unknown as Element | undefined
    if (!last) return undefined
    const fill = last.getAttribute('fill') ?? ''
    const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(fill)
    if (!m) return undefined
    const def = svgEl.querySelector(`radialGradient[id="${m[1]}"]`)
    if (!def) return undefined
    const cx = Number(def.getAttribute('cx'))
    const cy = Number(def.getAttribute('cy'))
    const r = Number(def.getAttribute('r'))
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return undefined
    return { cx, cy, r }
  }, svgText)
}

async function rasterizeCommitShapePixels(svgText: string): Promise<{
  center: number[]
  left: number[]
  right: number[]
  top: number[]
  bottom: number[]
  qLeft: number[]
  qRight: number[]
  qTop: number[]
  qBottom: number[]
  bounds: { x: number; y: number; width: number; height: number }
}> {
  return await page.evaluate((svg: string) => {
    const doc = new DOMParser().parseFromString(`<div>${svg}</div>`, 'text/html')
    const svgEl = doc.querySelector('svg')!
    const shapes = Array.from(svgEl.querySelectorAll('rect, ellipse, line, path, circle'))
    const last = shapes[shapes.length - 1] as unknown as Element
    const defs = Array.from(svgEl.querySelectorAll('defs')).map((d) => d.outerHTML).join('')
    const isolated = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${defs}${last.outerHTML}</svg>`
    const num = (v: string | null) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : 0
    }
    const tag = last.tagName.toLowerCase()
    let bounds = { x: 0, y: 0, width: 0, height: 0 }
    if (tag === 'rect') {
      bounds = { x: num(last.getAttribute('x')), y: num(last.getAttribute('y')), width: num(last.getAttribute('width')), height: num(last.getAttribute('height')) }
    } else if (tag === 'ellipse') {
      const cx = num(last.getAttribute('cx'))
      const cy = num(last.getAttribute('cy'))
      const rx = num(last.getAttribute('rx'))
      const ry = num(last.getAttribute('ry'))
      bounds = { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 }
    } else {
      const xs: number[] = []
      const ys: number[] = []
      for (const n of ['x1', 'x2']) {
        const v = last.getAttribute(n)
        if (v !== null) xs.push(Number(v))
      }
      for (const n of ['y1', 'y2']) {
        const v = last.getAttribute(n)
        if (v !== null) ys.push(Number(v))
      }
      const d = last.getAttribute('d') ?? ''
      const nums = Array.from(d.matchAll(/-?\d+(?:\.\d+)?/g), (m) => Number(m[0])).filter(Number.isFinite)
      // Path data is x,y pairs in order: even indices are x, odd are y.
      for (let i = 0; i + 1 < nums.length; i += 2) {
        xs.push(nums[i]!)
        ys.push(nums[i + 1]!)
      }
      if (xs.length > 0 && ys.length > 0) {
        const left = Math.min(...xs)
        const right = Math.max(...xs)
        const top = Math.min(...ys)
        const bottom = Math.max(...ys)
        bounds = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
      }
    }
    const loadImage = (text: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('svg-image-load-failed'))
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text)
      })
    return (async () => {
      const img = await loadImage(isolated)
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 360
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.clearRect(0, 0, 480, 360)
      ctx.drawImage(img, 0, 0, 480, 360)
      const data = ctx.getImageData(0, 0, 480, 360).data
      const at = (x: number, y: number): number[] => {
        const ix = Math.max(0, Math.min(479, Math.round(x)))
        const iy = Math.max(0, Math.min(359, Math.round(y)))
        const o = (iy * 480 + ix) * 4
        return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!]
      }
      const cx = bounds.x + bounds.width / 2
      const cy = bounds.y + bounds.height / 2
      return {
        center: at(cx, cy),
        left: at(bounds.x + 2, cy),
        right: at(bounds.x + bounds.width - 2, cy),
        top: at(cx, bounds.y + 2),
        bottom: at(cx, bounds.y + bounds.height - 2),
        // Quarter points sit well inside the outline stroke (default width 4
        // covers ~2px each side), so the fill ramp reads unpolluted.
        qLeft: at(bounds.x + bounds.width * 0.25, cy),
        qRight: at(bounds.x + bounds.width * 0.75, cy),
        qTop: at(cx, bounds.y + bounds.height * 0.25),
        qBottom: at(cx, bounds.y + bounds.height * 0.75),
        bounds,
      }
    })()
  }, svgText)
}

describe('vector shape preview/commit parity on the real editor (pixels)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4371', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
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
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('main-tab-costumes').click({ timeout: 120_000 })
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible', timeout: 60_000 })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 60_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('landscape/portrait rect fills: preview pixels equal commit pixels (horizontal/vertical/radial)', async () => {
    await clearCanvas()
    await ensureToggle('Transparent fill', false)
    // Secondary inputs only render for non-solid gradients: reveal them first.
    await setFillGradient('horizontal')
    await page.getByLabel('Secondary paint color', { exact: true }).fill('#0000ff')
    await page.getByLabel('Stroke color', { exact: true }).first().fill('#000000')
    const box = await surfaceBox()
    const cases: Array<{ name: string; tool: string; grad: string; from: { x: number; y: number }; to: { x: number; y: number } }> = [
      {
        name: 'landscape-horizontal',
        tool: 'vector-shape-rect',
        grad: 'horizontal',
        from: { x: box.x + box.width * 0.3, y: box.y + box.height * 0.35 },
        to: { x: box.x + box.width * 0.7, y: box.y + box.height * 0.55 },
      },
      {
        name: 'portrait-vertical',
        tool: 'vector-shape-rect',
        grad: 'vertical',
        from: { x: box.x + box.width * 0.62, y: box.y + box.height * 0.25 },
        to: { x: box.x + box.width * 0.78, y: box.y + box.height * 0.75 },
      },
      {
        name: 'square-radial',
        tool: 'vector-shape-rect',
        grad: 'radial',
        from: { x: box.x + box.width * 0.2, y: box.y + box.height * 0.6 },
        to: { x: box.x + box.width * 0.4, y: box.y + box.height * 0.85 },
      },
    ]
    const reports: Array<{ name: string; maxAbs: number; meanAbs: number; diffPixels: number }> = []
    for (const c of cases) {
      await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
      await setFillGradient(c.grad)
      await setStrokeGradient('solid')
      const { previewSvg: preview, committedSvg: committed } = await drawWithPreviewCapture(c.tool, c.from, c.to)
      expect(preview.length).toBeGreaterThan(0)
      // Preview itself must already be userSpaceOnUse (no legacy bbox).
      expect(preview).toContain('gradientUnits="userSpaceOnUse"')
      expect(preview).not.toContain('gradientUnits="objectBoundingBox"')
      const compared = await comparePreviewVsCommit(preview, committed)
      expect(compared.previewDefs).toContain('gradientUnits="userSpaceOnUse"')
      expect(compared.commitDefs).toContain('gradientUnits="userSpaceOnUse"')
      expect(compared.commitDefs).not.toContain('gradientUnits="objectBoundingBox"')
      reports.push({ name: c.name, ...compared.parity })
      expect(compared.parity.maxAbs).toBeLessThanOrEqual(12)
      expect(compared.parity.meanAbs).toBeLessThan(1.5)
      // Committed pixels must show the real ramp (not a flat last-stop).
      const pixels = await rasterizeCommitShapePixels(committed)
      // The ramp must vary across the shape (never a flat last-stop solid).
      // Quarter points sit inside the outline stroke, so the fill reads clean.
      if (c.grad === 'horizontal') {
        console.log(`[vector-ramp-debug:${c.name}] ${JSON.stringify({ bounds: pixels.bounds, qLeft: pixels.qLeft, qRight: pixels.qRight })}`)
        expect(pixels.qLeft[0] - pixels.qRight[0]).toBeGreaterThan(15)
        expect(pixels.qRight[2] - pixels.qLeft[2]).toBeGreaterThan(15)
      } else if (c.grad === 'vertical') {
        console.log(`[vector-ramp-debug:${c.name}] ${JSON.stringify({ bounds: pixels.bounds, qTop: pixels.qTop, qBottom: pixels.qBottom })}`)
        expect(pixels.qTop[0] - pixels.qBottom[0]).toBeGreaterThan(15)
        expect(pixels.qBottom[2] - pixels.qTop[2]).toBeGreaterThan(15)
      } else {
        expect(pixels.center[0]).toBeGreaterThan(120)
        const cornerRed = pixels.left[0] ?? 0
        const cornerBlue = pixels.left[2] ?? 0
        expect(cornerBlue + cornerRed).toBeGreaterThan(60)
      }
      await clearCanvas()
    }
    console.log(`[vector-preview-commit-parity] ${JSON.stringify(reports)}`)
  }, 180_000)

  it('orthogonal line gradients stay non-degenerate and match the preview', async () => {
    await clearCanvas()
    await ensureToggle('Transparent fill', false)
    await ensureToggle('Transparent stroke', false)
    // Reveal the stroke-secondary input before filling it.
    await setStrokeGradient('vertical')
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    await page.getByLabel('Secondary paint color', { exact: true }).fill('#0000ff')
    await page.getByLabel('Stroke color', { exact: true }).first().fill('#ff0000')
    await page.getByLabel('Secondary stroke color', { exact: true }).fill('#0000ff')
    await setFillGradient('solid')
    const box = await surfaceBox()
    const midY = box.y + box.height * 0.4
    const midX = box.x + box.width * 0.5

    // Horizontal line + vertical stroke ramp (zero height span).
    await setStrokeGradient('vertical')
    const horizontal = await drawWithPreviewCapture(
      'vector-shape-line',
      { x: box.x + box.width * 0.25, y: midY },
      { x: box.x + box.width * 0.75, y: midY },
    )
    expect(horizontal.previewSvg).toContain('gradientUnits="userSpaceOnUse"')
    const hCompared = await comparePreviewVsCommit(horizontal.previewSvg, horizontal.committedSvg)
    expect(hCompared.parity.maxAbs).toBeLessThanOrEqual(16)
    // Follow the line's own stroke reference (defs from cleared shapes linger).
    const hStroke = await commitLastShapeGradientCoords(horizontal.committedSvg, 'stroke')
    expect(hStroke?.tag).toBe('lineargradient')
    expect(hStroke?.units).toBe('userSpaceOnUse')
    // Non-degenerate: y1 != y2 (0.01 minimum), never equal endpoints.
    const hY1 = Number(/y1=([^\s]+)/.exec(hStroke?.coords ?? '')?.[1])
    const hY2 = Number(/y2=([^\s]+)/.exec(hStroke?.coords ?? '')?.[1])
    expect(Number.isFinite(hY1) && Number.isFinite(hY2)).toBe(true)
    expect(Math.abs((hY2 as number) - (hY1 as number))).toBeGreaterThan(0.005)
    const hPixels = await rasterizeCommitShapePixels(horizontal.committedSvg)
    // The stroked line must paint real pixels (not invisible degenerate).
    expect((hPixels.center[3] ?? 0)).toBeGreaterThan(0)
    await clearCanvas()

    // Vertical line + horizontal stroke ramp (zero width span).
    await setStrokeGradient('horizontal')
    const vertical = await drawWithPreviewCapture(
      'vector-shape-line',
      { x: midX, y: box.y + box.height * 0.25 },
      { x: midX, y: box.y + box.height * 0.75 },
    )
    expect(vertical.previewSvg).toContain('gradientUnits="userSpaceOnUse"')
    const vCompared = await comparePreviewVsCommit(vertical.previewSvg, vertical.committedSvg)
    expect(vCompared.parity.maxAbs).toBeLessThanOrEqual(16)
    const vStroke = await commitLastShapeGradientCoords(vertical.committedSvg, 'stroke')
    expect(vStroke?.tag).toBe('lineargradient')
    expect(vStroke?.units).toBe('userSpaceOnUse')
    const vX1 = Number(/x1=([^\s]+)/.exec(vStroke?.coords ?? '')?.[1])
    const vX2 = Number(/x2=([^\s]+)/.exec(vStroke?.coords ?? '')?.[1])
    expect(Number.isFinite(vX1) && Number.isFinite(vX2)).toBe(true)
    expect(Math.abs((vX2 as number) - (vX1 as number))).toBeGreaterThan(0.005)
    const vPixels = await rasterizeCommitShapePixels(vertical.committedSvg)
    expect((vPixels.center[3] ?? 0)).toBeGreaterThan(0)
    console.log(`[vector-orthogonal-line-parity] ${JSON.stringify({ h: hCompared.parity, v: vCompared.parity })}`)
    await clearCanvas()
  }, 180_000)

  it('fill-tool radial center applies with unchanged colors, then undo/redo stays pixel-exact', async () => {
    await clearCanvas()
    await ensureToggle('Transparent fill', false)
    await ensureToggle('Transparent stroke', false)
    await setFillGradient('radial')
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    await page.getByLabel('Secondary paint color', { exact: true }).fill('#0000ff')
    await setStrokeGradient('solid')
    const box = await surfaceBox()
    const { committedSvg: baseCommitted } = await drawWithPreviewCapture(
      'vector-shape-rect',
      { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 },
      { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 },
    )
    const baseFocus = await commitFillRadialFocus(baseCommitted)
    expect(baseFocus).toBeDefined()

    // Select the rect, then fill-click at two different interior points with
    // the *same* toolbar colors (no dirty change in between). Each click must
    // recenter the radial focus and repaint the real editor pixels.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 1,
      null,
      { timeout: 10_000 },
    )
    // NOTE: a fresh vector costume carries an empty template `<g>` that only
    // becomes a selectable unit once a shape is drawn beside it
    // (`editableVectorUnits` unwraps lone groups). Always click the largest
    // outline so a phantom empty-group outline can never steal the click.
    const largestBlueOutline = async () => {
      const handles = await page.locator('[data-vector-selection-outline].border-blue-500').elementHandles()
      if (handles.length === 0) throw new Error('selection outline missing')
      let best: { x: number; y: number; width: number; height: number } | undefined
      for (const handle of handles) {
        const box = await handle.boundingBox()
        if (!box) continue
        if (!best || box.width * box.height > best.width * best.height) best = box
      }
      if (!best) throw new Error('outline box missing')
      return best
    }
    await largestBlueOutline()
    const clickAt = async (fx: number, fy: number) => {
      await page.getByTestId('vector-shape-fill').last().click()
      await page.waitForTimeout(300)
      const attempt = async () => {
        const before = await previewSvg()
        // Re-read the outlines each attempt and keep the largest: selection
        // geometry is stable, but a stale box after a repaint would miss.
        const freshBox = await largestBlueOutline()
        await page.mouse.click(freshBox.x + freshBox.width * fx, freshBox.y + freshBox.height * fy)
        await page.waitForFunction(
          (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
          before,
          { timeout: 8_000 },
        )
        return await previewSvg()
      }
      try {
        return await attempt()
      } catch {
        const status = await editorStatus()
        console.log(`[vector-fill-click-debug:retry] ${JSON.stringify({ status })}`)
        return await attempt()
      }
    }
    // First click (corner-ish) must write history even though colors are unchanged.
    const afterFirst = await clickAt(0.25, 0.25)
    expect(afterFirst).not.toBe(baseCommitted)
    const firstFocus = await commitFillRadialFocus(afterFirst)
    const firstFill = await commitLastShapeGradientCoords(afterFirst, 'fill')
    expect(firstFocus).toBeDefined()
    expect(Math.hypot(firstFocus!.cx - baseFocus!.cx, firstFocus!.cy - baseFocus!.cy)).toBeGreaterThan(1)
    const liveDom = await page.evaluate(() => {
      const svg = document.querySelector('.vector-preview svg')
      if (!svg) return { found: false as const }
      const grads = Array.from(svg.querySelectorAll('radialGradient'))
      const rect = svg.querySelector('rect')
      return {
        found: true as const,
        gradCount: grads.length,
        namespaces: grads.map((g) => (g as unknown as Element).namespaceURI),
        rectFill: rect?.getAttribute('fill'),
        rectOpacity: rect?.getAttribute('opacity'),
        defsCount: svg.querySelectorAll('defs').length,
      }
    })
    // Both the draw-time and the click-time gradients must live in the SVG
    // namespace; a null-namespace (`xmlns=""`) gradient parses but never
    // resolves `url(#id)` at render time.
    expect(liveDom.found).toBe(true)
    if (liveDom.found) {
      expect(liveDom.namespaces.every((ns) => ns === 'http://www.w3.org/2000/svg')).toBe(true)
    }
    // String-rasterize with the same proven helper as the shape tests: the
    // isolated click-time gradient must render opaque (not blank).
    const firstPixels = await rasterizeCommitShapePixels(afterFirst)
    expect(firstPixels.center[3]).toBeGreaterThan(0)
    // Full-RGBA diff between the two click states must show the repaint.
    const firstDiff = await diffCommittedSvgs(baseCommitted, afterFirst)
    expect(firstDiff.diffPixels).toBeGreaterThan(50)
    // Second click (opposite corner) must recenter again and repaint.
    const afterSecond = await clickAt(0.75, 0.75)
    expect(afterSecond).not.toBe(afterFirst)
    const secondFocus = await commitFillRadialFocus(afterSecond)
    const secondFill = await commitLastShapeGradientCoords(afterSecond, 'fill')
    expect(secondFocus).toBeDefined()
    expect(Math.hypot(secondFocus!.cx - firstFocus!.cx, secondFocus!.cy - firstFocus!.cy)).toBeGreaterThan(1)
    const secondPixels = await rasterizeCommitShapePixels(afterSecond)
    expect(secondPixels.center[3]).toBeGreaterThan(0)
    const secondDiff = await diffCommittedSvgs(afterFirst, afterSecond)
    expect(secondDiff.diffPixels).toBeGreaterThan(50)

    // Undo restores the first click's pixels; redo reapplies the second.
    // Compare via string-rasterized centers (proven path) rather than PNG
    // screenshots.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterFirst,
      { timeout: 10_000 },
    )
    const undoFocus = await commitFillRadialFocus(await previewSvg())
    expect(Math.hypot(undoFocus!.cx - firstFocus!.cx, undoFocus!.cy - firstFocus!.cy)).toBeLessThan(1e-6)
    const undoPixels = await rasterizeCommitShapePixels(await previewSvg())
    expect(JSON.stringify(undoPixels.center)).toBe(JSON.stringify(firstPixels.center))
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterSecond,
      { timeout: 10_000 },
    )
    const redoFocus = await commitFillRadialFocus(await previewSvg())
    expect(Math.hypot(redoFocus!.cx - secondFocus!.cx, redoFocus!.cy - secondFocus!.cy)).toBeLessThan(1e-6)
    const redoPixels = await rasterizeCommitShapePixels(await previewSvg())
    expect(JSON.stringify(redoPixels.center)).toBe(JSON.stringify(secondPixels.center))

    // Repeat click on the already-active focus with the same colors is a
    // clean no-op: step back to the first click (redo becomes available),
    // re-click its own point, and confirm nothing is written while redo
    // survives; then redo re-applies the second click.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterFirst,
      { timeout: 10_000 },
    )
    expect(await redoButton().isDisabled()).toBe(false)
    await page.getByTestId('vector-shape-fill').last().click()
    const noOpBefore = await previewSvg()
    const noOpBox = await largestBlueOutline()
    await page.mouse.click(noOpBox.x + noOpBox.width * 0.25, noOpBox.y + noOpBox.height * 0.25)
    await page.waitForTimeout(600)
    expect(await previewSvg()).toBe(noOpBefore)
    expect(await editorStatus()).toMatch(/No paint change/)
    expect(await redoButton().isDisabled()).toBe(false)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      afterSecond,
      { timeout: 10_000 },
    )
    console.log(
      `[vector-fill-click-center] ${JSON.stringify({ base: baseFocus, first: firstFocus, second: secondFocus, firstRef: firstFill?.ref, secondRef: secondFill?.ref })}`,
    )
    await page.keyboard.press('Escape')
    await clearCanvas()
  }, 180_000)

  it('transparent fill and stroke apply as none with pixel-exact undo/redo', async () => {
    // A fully transparent drag is a no-op by design, so cover transparency
    // through Apply: draw opaque, then apply transparent fill+stroke.
    await clearCanvas()
    await ensureToggle('Transparent fill', false)
    await ensureToggle('Transparent stroke', false)
    await setFillGradient('solid')
    await setStrokeGradient('solid')
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    await page.getByLabel('Stroke color', { exact: true }).first().fill('#000000')
    const box = await surfaceBox()
    const { committedSvg: opaqueCommitted } = await drawWithPreviewCapture(
      'vector-shape-rect',
      { x: box.x + box.width * 0.3, y: box.y + box.height * 0.35 },
      { x: box.x + box.width * 0.65, y: box.y + box.height * 0.65 },
    )
    const opaquePixels = await rasterizeCommitShapePixels(opaqueCommitted)
    expect(opaquePixels.center[3]).toBeGreaterThan(0)

    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 1,
      null,
      { timeout: 10_000 },
    )
    // Transparent toggles mark their fields dirty, so Apply writes none/none.
    await ensureToggle('Transparent fill', true)
    await ensureToggle('Transparent stroke', true)
    const beforeApply = await previewSvg()
    await applyButton().click()
    await page.waitForFunction(
      (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
      beforeApply,
      { timeout: 15_000 },
    )
    const transparentCommitted = await previewSvg()
    expect(transparentCommitted).toContain('fill="none"')
    expect(transparentCommitted).toContain('stroke="none"')
    const transparentPixels = await rasterizeCommitShapePixels(transparentCommitted)
    expect(transparentPixels.center[3]).toBe(0)

    // Undo restores the opaque pixels; redo reapplies transparency.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      opaqueCommitted,
      { timeout: 10_000 },
    )
    const undoPixels = await rasterizeCommitShapePixels(await previewSvg())
    expect(JSON.stringify(undoPixels.center)).toBe(JSON.stringify(opaquePixels.center))
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      transparentCommitted,
      { timeout: 10_000 },
    )
    const redoPixels = await rasterizeCommitShapePixels(await previewSvg())
    expect(JSON.stringify(redoPixels.center)).toBe(JSON.stringify(transparentPixels.center))
    await ensureToggle('Transparent fill', false)
    await ensureToggle('Transparent stroke', false)
    await clearCanvas()
  }, 180_000)
})
