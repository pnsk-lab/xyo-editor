import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'
import { svgGradientPaint } from '../src/features/costumes/paint-colors'
import { svgStrokePaint } from '../src/features/costumes/vector-stroke-paint'

// Fixed vector gradient parity: product `userSpaceOnUse` gradients vs the
// reference `style-path.js` `createGradientObject` geometry (behavior notes,
// no upstream source copied).
//
// Reference geometry:
// - radial = circle with origin = bounds center OR the fill click point,
//   radius = max(bounds.width, bounds.height) / 2
// - linear horizontal/vertical = ramp spanning the element bounds.
//
// Product geometry under test:
// - `svgGradientPaint` / `svgStrokePaint` with real local `bounds` (+ click
//   `center` for radial): `userSpaceOnUse` circle/ramp over the element's
//   parent user space (own transform baked in, ancestors excluded so the ramp
//   rides ancestor transforms rigidly). Degenerate spans stay valid SVG.
// - Old imported gradients and unrelated attributes/defs are never touched
//   (new defs are appended, only `fill`/`stroke` + related opacity/style
//   props are rewritten).
//
// This suite rasterizes, in real Chrome, side-by-side SVG images that are
// byte-identical EXCEPT for the gradient definition (reference hand-rolled
// `userSpaceOnUse` vs product-helper `userSpaceOnUse`), draws each through
// `<img>` data-URL + canvas `drawImage`, and compares full RGBA bytes.
// Matrix:
// - landscape / portrait / square x several positions & sizes (fill),
// - fill vs stroke (thick rect outline, fill="none"),
// - click-point origins (center / corner / edge / interior),
// - ancestor transforms (translate / non-uniform scale / rotate).
// Linear gradients are included as a control (expected to match ~exactly).
// After the fix every case must match the reference (tiny raster rounding
// only); the previous `objectBoundingBox r=70%` gap (circle vs ellipse,
// wrong radius even for squares, click ignored) is gone.

type Bounds = { x: number; y: number; width: number; height: number }
type Origin =
  | { kind: 'center' }
  | { kind: 'point'; px: number; py: number; label: string }

type ParityCase = {
  name: string
  canvasW: number
  canvasH: number
  bounds: Bounds
  paint: 'fill' | 'stroke'
  grad: 'radial' | 'horizontal' | 'vertical'
  origin: Origin
  ancestorTransform: string
  strokeWidth: number
}

type CaseResult = {
  name: string
  maxAbs: number
  meanAbs: number
  diffPixels: number
  totalPixels: number
  refCenter: number[]
  newCenter: number[]
  refCorner: number[]
  newCorner: number[]
}

const STOPS = { from: '#ff0000', to: '#0000ff' }
const RED = { r: 255, g: 0, b: 0, a: 255 }
const BLUE = { r: 0, g: 0, b: 255, a: 255 }

// ---------------------------------------------------------------------------
// Case matrix.
// ---------------------------------------------------------------------------
const FILL_CENTER: ParityCase[] = [
  {
    name: 'square-160-fill-center',
    canvasW: 220, canvasH: 220,
    bounds: { x: 30, y: 30, width: 160, height: 160 },
    paint: 'fill', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 0,
  },
  {
    name: 'landscape-200x100-fill-center',
    canvasW: 260, canvasH: 200,
    bounds: { x: 30, y: 50, width: 200, height: 100 },
    paint: 'fill', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 0,
  },
  {
    name: 'portrait-100x200-fill-center',
    canvasW: 220, canvasH: 260,
    bounds: { x: 60, y: 30, width: 100, height: 200 },
    paint: 'fill', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 0,
  },
  {
    name: 'landscape-small-offset-120x60-fill-center',
    canvasW: 260, canvasH: 200,
    bounds: { x: 90, y: 110, width: 120, height: 60 },
    paint: 'fill', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 0,
  },
  {
    name: 'portrait-topleft-80x160-fill-center',
    canvasW: 220, canvasH: 260,
    bounds: { x: 8, y: 12, width: 80, height: 160 },
    paint: 'fill', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 0,
  },
]

const CLICK: ParityCase[] = [
  {
    name: 'landscape-200x100-click-corner',
    canvasW: 260, canvasH: 200,
    bounds: { x: 30, y: 50, width: 200, height: 100 },
    paint: 'fill', grad: 'radial',
    origin: { kind: 'point', px: 30, py: 50, label: 'top-left-corner' },
    ancestorTransform: '', strokeWidth: 0,
  },
  {
    name: 'portrait-100x200-click-edge',
    canvasW: 220, canvasH: 260,
    bounds: { x: 60, y: 30, width: 100, height: 200 },
    paint: 'fill', grad: 'radial',
    origin: { kind: 'point', px: 60, py: 130, label: 'mid-left-edge' },
    ancestorTransform: '', strokeWidth: 0,
  },
  {
    name: 'square-160-click-interior',
    canvasW: 220, canvasH: 220,
    bounds: { x: 30, y: 30, width: 160, height: 160 },
    paint: 'fill', grad: 'radial',
    origin: { kind: 'point', px: 70, py: 70, label: 'quarter-interior' },
    ancestorTransform: '', strokeWidth: 0,
  },
]

const LINEAR_CONTROL: ParityCase[] = [
  {
    name: 'landscape-200x100-fill-horizontal',
    canvasW: 260, canvasH: 200,
    bounds: { x: 30, y: 50, width: 200, height: 100 },
    paint: 'fill', grad: 'horizontal', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 0,
  },
  {
    name: 'portrait-100x200-fill-vertical',
    canvasW: 220, canvasH: 260,
    bounds: { x: 60, y: 30, width: 100, height: 200 },
    paint: 'fill', grad: 'vertical', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 0,
  },
]

const STROKE: ParityCase[] = [
  {
    name: 'landscape-200x100-stroke16-center',
    canvasW: 260, canvasH: 200,
    bounds: { x: 30, y: 50, width: 200, height: 100 },
    paint: 'stroke', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 16,
  },
  {
    name: 'portrait-100x200-stroke16-click-corner',
    canvasW: 220, canvasH: 260,
    bounds: { x: 60, y: 30, width: 100, height: 200 },
    paint: 'stroke', grad: 'radial',
    origin: { kind: 'point', px: 60, py: 30, label: 'top-left-corner' },
    ancestorTransform: '', strokeWidth: 16,
  },
  {
    name: 'square-160-stroke16-center',
    canvasW: 220, canvasH: 220,
    bounds: { x: 30, y: 30, width: 160, height: 160 },
    paint: 'stroke', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: '', strokeWidth: 16,
  },
]

const ANCESTOR: ParityCase[] = [
  {
    name: 'landscape-ancestor-translate',
    canvasW: 260, canvasH: 200,
    bounds: { x: 30, y: 50, width: 200, height: 100 },
    paint: 'fill', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: 'translate(17,23)', strokeWidth: 0,
  },
  {
    name: 'landscape-ancestor-nonuniform-scale',
    canvasW: 320, canvasH: 240,
    bounds: { x: 20, y: 30, width: 120, height: 80 },
    paint: 'fill', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: 'translate(10,10) scale(1.4,0.8)', strokeWidth: 0,
  },
  {
    name: 'landscape-ancestor-rotate30',
    canvasW: 320, canvasH: 280,
    bounds: { x: 60, y: 60, width: 200, height: 100 },
    paint: 'fill', grad: 'radial', origin: { kind: 'center' },
    ancestorTransform: 'rotate(30 160 110)', strokeWidth: 0,
  },
  {
    name: 'portrait-ancestor-rotate30-click-edge',
    canvasW: 300, canvasH: 320,
    bounds: { x: 60, y: 30, width: 100, height: 200 },
    paint: 'fill', grad: 'radial',
    origin: { kind: 'point', px: 60, py: 130, label: 'mid-left-edge' },
    ancestorTransform: 'rotate(30 110 130)', strokeWidth: 0,
  },
]

function productDefsFor(c: ParityCase): string {
  const bounds = { ...c.bounds }
  const center =
    c.origin.kind === 'center'
      ? { x: c.bounds.x + c.bounds.width / 2, y: c.bounds.y + c.bounds.height / 2 }
      : { x: c.origin.px, y: c.origin.py }
  if (c.paint === 'stroke') {
    const paint = svgStrokePaint({
      id: 'g',
      gradient: c.grad,
      primary: RED,
      secondary: BLUE,
      strokeWidth: c.strokeWidth,
      width: c.canvasW,
      height: c.canvasH,
      bounds,
      center: c.grad === 'radial' ? center : undefined,
    })
    return paint.defs
  }
  const paint = svgGradientPaint({
    id: 'g',
    kind: c.grad,
    primary: RED,
    secondary: BLUE,
    width: c.canvasW,
    height: c.canvasH,
    bounds,
    center: c.grad === 'radial' ? center : undefined,
  })
  return paint.defs
}

async function runCases(page: Page, cases: ParityCase[]): Promise<CaseResult[]> {
  const productDefs = cases.map((c) => ({ name: c.name, defs: productDefsFor(c) }))
  // Product defs must already be reference-shaped userSpaceOnUse (no
  // objectBoundingBox, no 70% ellipse): fail fast on the markup itself.
  for (const entry of productDefs) {
    const c = cases.find((item) => item.name === entry.name)!
    if (c.grad === 'radial') {
      if (!entry.defs.includes('gradientUnits="userSpaceOnUse"')) throw new Error(`product radial missing userSpaceOnUse for ${c.name}: ${entry.defs}`)
      if (entry.defs.includes('objectBoundingBox') || entry.defs.includes('70%')) throw new Error(`product radial still uses legacy bbox for ${c.name}: ${entry.defs}`)
    } else {
      if (!entry.defs.includes('gradientUnits="userSpaceOnUse"')) throw new Error(`product linear missing userSpaceOnUse for ${c.name}: ${entry.defs}`)
    }
  }
  return await page.evaluate((input: { cases: ParityCase[]; stops: { from: string; to: string }; productDefs: Array<{ name: string; defs: string }> }) => {
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
    const refDefs = (c: ParityCase): string => {
      const b = c.bounds
      const cx = c.origin.kind === 'center' ? b.x + b.width / 2 : c.origin.px
      const cy = c.origin.kind === 'center' ? b.y + b.height / 2 : c.origin.py
      const stops =
        `<stop offset="0" stop-color="${input.stops.from}"/>` +
        `<stop offset="1" stop-color="${input.stops.to}"/>`
      if (c.grad === 'radial') {
        const r = Math.max(b.width, b.height) / 2
        return `<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">${stops}</radialGradient></defs>`
      }
      if (c.grad === 'vertical') {
        return `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${b.x}" y1="${b.y}" x2="${b.x}" y2="${b.y + b.height}">${stops}</linearGradient></defs>`
      }
      return `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${b.x}" y1="${b.y}" x2="${b.x + b.width}" y2="${b.y}">${stops}</linearGradient></defs>`
    }
    const newDefs = (c: ParityCase): string => {
      const found = input.productDefs.find((entry) => entry.name === c.name)
      if (!found) throw new Error(`missing product defs for ${c.name}`)
      return found.defs
    }
    const shape = (c: ParityCase, paintAttr: string): string => {
      const b = c.bounds
      const rect =
        c.paint === 'fill'
          ? `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${paintAttr}" stroke="none"/>`
          : `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="none" stroke="${paintAttr}" stroke-width="${c.strokeWidth}"/>`
      if (!c.ancestorTransform) return rect
      return `<g transform="${c.ancestorTransform}">${rect}</g>`
    }
    const doc = (c: ParityCase, defs: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${c.canvasW}" height="${c.canvasH}" viewBox="0 0 ${c.canvasW} ${c.canvasH}">${defs}${shape(c, 'url(#g)')}</svg>`
    const runOne = async (c: ParityCase) => {
      const ref = await raster(doc(c, refDefs(c)), c.canvasW, c.canvasH)
      const cur = await raster(doc(c, newDefs(c)), c.canvasW, c.canvasH)
      let maxAbs = 0
      let sum = 0
      let diffPixels = 0
      for (let i = 0; i < ref.length; i += 4) {
        let pixelDiff = 0
        for (let k = 0; k < 4; k += 1) {
          const d = Math.abs(ref[i + k]! - cur[i + k]!)
          if (d > maxAbs) maxAbs = d
          sum += d
          if (d > pixelDiff) pixelDiff = d
        }
        if (pixelDiff > 0) diffPixels += 1
      }
      const at = (data: Uint8ClampedArray, x: number, y: number, w: number): number[] => {
        const ix = Math.max(0, Math.min(w - 1, Math.round(x)))
        const iy = Math.max(0, Math.min(Math.floor(data.length / 4 / w) - 1, Math.round(y)))
        const o = (iy * w + ix) * 4
        return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!]
      }
      const ccx = c.bounds.x + c.bounds.width / 2
      const ccy = c.bounds.y + c.bounds.height / 2
      return {
        name: c.name,
        maxAbs,
        meanAbs: Number((sum / ref.length).toFixed(4)),
        diffPixels,
        totalPixels: ref.length / 4,
        refCenter: at(ref, ccx, ccy, c.canvasW),
        newCenter: at(cur, ccx, ccy, c.canvasW),
        refCorner: at(ref, c.bounds.x + 1, c.bounds.y + 1, c.canvasW),
        newCorner: at(cur, c.bounds.x + 1, c.bounds.y + 1, c.canvasW),
      }
    }
    return (async () => {
      const out = []
      for (const c of input.cases) out.push(await runOne(c))
      return out
    })()
  }, { cases, stops: STOPS, productDefs })
}

function report(tag: string, results: CaseResult[]): void {
  console.log(`[vector-gradient-parity-report:${tag}] ` + JSON.stringify(results))
}

describe('vector gradient userSpaceOnUse vs createGradientObject parity (real pixels)', () => {
  let browser: Browser | undefined
  let page: Page

  beforeAll(async () => {
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    await page.goto('about:blank')
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('fill radial center: product circle matches the reference circle (square + non-squares)', async () => {
    const results = await runCases(page, FILL_CENTER)
    report('fill-center', results)
    for (const r of results) {
      // Reference circle vs product circle: only stop-serialization
      // (`stop-opacity="1"`) and raster rounding may remain.
      expect(r.maxAbs).toBeLessThanOrEqual(4)
      expect(r.meanAbs).toBeLessThan(0.5)
    }
  }, 60_000)

  it('click-point origins: product follows the click like the reference', async () => {
    const results = await runCases(page, CLICK)
    report('click', results)
    for (const r of results) {
      expect(r.maxAbs).toBeLessThanOrEqual(4)
      expect(r.meanAbs).toBeLessThan(0.5)
    }
  }, 60_000)

  it('linear control: bounds-spanning userSpaceOnUse matches objectBoundingBox 0%-100%', async () => {
    const results = await runCases(page, LINEAR_CONTROL)
    report('linear-control', results)
    for (const r of results) {
      // Same shape, same ramp endpoints: only raster rounding may remain.
      expect(r.maxAbs).toBeLessThanOrEqual(4)
    }
  }, 60_000)

  it('stroke radial: product stroke circle matches the reference on the stroke ramp', async () => {
    const results = await runCases(page, STROKE)
    report('stroke', results)
    for (const r of results) {
      expect(r.maxAbs).toBeLessThanOrEqual(8)
      expect(r.meanAbs).toBeLessThan(1)
    }
  }, 60_000)

  it('ancestor transforms: product local circle rides ancestors like the reference', async () => {
    const results = await runCases(page, ANCESTOR)
    report('ancestor', results)
    for (const r of results) {
      expect(r.maxAbs).toBeLessThanOrEqual(8)
      expect(r.meanAbs).toBeLessThan(1)
    }
  }, 60_000)
})
