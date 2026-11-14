import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-Canvas quantification for the bitmap fill radial-center gap.
//
// The current painter centers every radial gradient on the mask bounds
// center; click-anchored geometry (see `bitmap-gradient-geometry.ts`) centers
// it on the fill seed instead. This suite renders both variants with
// `createRadialGradient` on a real canvas and records the pixel gaps for
// different click positions, selection bounds, and translucent ends.
describe('bitmap fill radial geometry with real Canvas', () => {
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

  it('renders identically when the click starts at the bounds center', async () => {
    const result = await page.evaluate(() => {
      const render = (cx: number, cy: number, r: number) => {
        const canvas = document.createElement('canvas')
        canvas.width = 7
        canvas.height = 7
        const context = canvas.getContext('2d')!
        const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r))
        gradient.addColorStop(0, '#ff0000')
        gradient.addColorStop(1, '#0000ff')
        context.fillStyle = gradient
        context.fillRect(0, 0, 7, 7)
        return context.getImageData(0, 0, 7, 7).data
      }
      const bounds = { x: 1, y: 1, width: 5, height: 3 }
      const centerX = bounds.x + bounds.width / 2
      const centerY = bounds.y + bounds.height / 2
      const radius = Math.max(bounds.width, bounds.height) / 2
      const a = render(centerX, centerY, radius)
      const b = render(centerX, centerY, radius)
      let max = 0
      for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i]! - b[i]!))
      return { max }
    })
    expect(result.max).toBe(0)
  }, 30_000)

  it('quantifies the off-center click gap (corner, edge, interior)', async () => {
    const result = await page.evaluate(() => {
      const render = (cx: number, cy: number, r: number) => {
        const canvas = document.createElement('canvas')
        canvas.width = 7
        canvas.height = 7
        const context = canvas.getContext('2d')!
        const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r))
        gradient.addColorStop(0, '#ff0000')
        gradient.addColorStop(1, '#0000ff')
        context.fillStyle = gradient
        context.fillRect(0, 0, 7, 7)
        return context.getImageData(0, 0, 7, 7).data
      }
      const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let max = 0
        let sum = 0
        for (let i = 0; i < a.length; i += 1) {
          const d = Math.abs(a[i]! - b[i]!)
          if (d > max) max = d
          sum += d
        }
        return { max, mean: sum / a.length }
      }
      const center: [number, number] = [3.5, 2.5]
      const radius = 2.5
      const base = render(center[0], center[1], radius)
      const cases: Array<{ click: [number, number]; max: number; mean: number }> = []
      for (const click of [[1, 1], [6, 4], [2, 3]] as Array<[number, number]>) {
        const other = render(click[0], click[1], radius)
        const d = diff(base, other)
        cases.push({ click, max: d.max, mean: Number(d.mean.toFixed(2)) })
      }
      return { cases }
    })
    expect(result.cases).toHaveLength(3)
    for (const entry of result.cases) {
      // Any off-center seed visibly moves the ramp (up to a full-channel swing).
      expect(entry.max).toBeGreaterThanOrEqual(100)
      expect(entry.mean).toBeGreaterThan(5)
    }
  }, 30_000)

  it('quantifies selection-bounds and translucent-end gaps', async () => {
    const result = await page.evaluate(() => {
      const renderRadial = (cx: number, cy: number, r: number) => {
        const canvas = document.createElement('canvas')
        canvas.width = 7
        canvas.height = 3
        const context = canvas.getContext('2d')!
        const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r))
        gradient.addColorStop(0, '#ff0000')
        gradient.addColorStop(1, '#0000ff')
        context.fillStyle = gradient
        context.fillRect(0, 0, 7, 3)
        return context.getImageData(0, 0, 7, 3).data
      }
      const renderLinear = (from: string, to: string, alphaTest = false) => {
        const canvas = document.createElement('canvas')
        canvas.width = 4
        canvas.height = 1
        const context = canvas.getContext('2d')!
        const gradient = context.createLinearGradient(0, 0, 4, 0)
        gradient.addColorStop(0, from)
        gradient.addColorStop(1, to)
        context.fillStyle = gradient
        context.fillRect(0, 0, 4, 1)
        const data = Array.from(context.getImageData(0, 0, 4, 1).data)
        if (!alphaTest) return { data, max: 0, mid: data.slice(4, 8) }
        return { data, max: 0, mid: data.slice(4, 8) }
      }
      // Connected 2x3 chamber (radius 1.5) vs Shift-global 5x3 union (radius 2.5).
      const narrow = renderRadial(0, 1, 1.5)
      const wide = renderRadial(0, 1, 2.5)
      let boundsMax = 0
      for (let i = 0; i < narrow.length; i += 1) boundsMax = Math.max(boundsMax, Math.abs(narrow[i]! - wide[i]!))
      // Transparent end: surviving-RGB fade vs fade through black.
      const good = renderLinear('#ff0000', 'rgba(255,0,0,0)')
      const bad = renderLinear('#ff0000', 'rgba(0,0,0,0)')
      let transparentMax = 0
      for (let i = 0; i < good.data.length; i += 1) {
        transparentMax = Math.max(transparentMax, Math.abs(good.data[i]! - bad.data[i]!))
      }
      // Translucent end: half-alpha red keeps full red at the midpoint alpha ramp.
      const half = renderLinear('#ff0000', 'rgba(255,0,0,0.5)')
      const opaque = renderLinear('#ff0000', '#0000ff')
      let translucentMax = 0
      for (let i = 0; i < half.data.length; i += 1) {
        translucentMax = Math.max(translucentMax, Math.abs(half.data[i]! - opaque.data[i]!))
      }
      return {
        boundsMax,
        transparentMax,
        goodMid: good.mid,
        badMid: bad.mid,
        halfMid: half.mid,
        opaqueMid: opaque.mid,
        translucentMax,
      }
    })
    // A wider Shift selection reaches further, so the same seed paints differently.
    expect(result.boundsMax).toBeGreaterThan(0)
    // Fading through black shifts the midpoint red (255 vs dark); the
    // surviving-RGB stop is why the editor keeps the opaque end's RGB.
    expect(result.transparentMax).toBeGreaterThan(100)
    expect(result.goodMid[0]).toBeGreaterThan(200)
    expect(result.badMid[0]).toBeLessThan(200)
    // A translucent end is a third distinct ramp, not opaque.
    expect(result.translucentMax).toBeGreaterThan(20)
    expect(result.halfMid[3]).toBeGreaterThan(100)
    expect(result.halfMid[3]).toBeLessThan(255)
  }, 30_000)
})
