import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-Chrome proof for select/reshape hit tolerance vs. the live CSS scale.
//
// Compares scratch-paint's screen-px budgets (select 2px, reshape 6.25px,
// each divided by zoom) against the current fixed 0.5 SVG-unit tolerance in
// `paperVectorHitIndex`, using the real display chain
//   screenPx = svgUnits * 5 (VECTOR_WORKSPACE_SCALE) * viewportScale (0.25..5)
// and N-px-outside clicks on a thin line / small shape at 25%/100%/500%.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4294'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector hit tolerance vs live CSS scale in real Chrome', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4294', '--strictPort'], {
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
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('verifies the real CSS px-per-SVG-unit product is 5*viewportScale', async () => {
    const result = await page.evaluate(async () => {
      const container = document.createElement('div')
      container.style.cssText =
        'position:relative;width:800px;height:600px;overflow:hidden;margin:0;padding:0;'
      document.body.innerHTML = ''
      document.body.appendChild(container)
      const surface = document.createElement('div')
      surface.style.cssText =
        'position:absolute;left:50%;top:50%;width:2400px;height:1800px;transform-origin:center;'
      container.appendChild(surface)
      // Vector art box inside the 2400x1800 surface (480 SVG units * 5).
      const art = document.createElement('div')
      art.style.cssText = 'position:absolute;left:0px;top:0px;width:2400px;height:1800px;'
      surface.appendChild(art)
      const out: Array<{ scale: number; pxPerSvgUnit: number; surfaceWidth: number }> = []
      for (const scale of [0.25, 1, 5]) {
        surface.style.transform = `translate(calc(-50% + 0px), calc(-50% + 0px)) scale(${scale})`
        void surface.offsetWidth
        const rect = art.getBoundingClientRect()
        out.push({ scale, pxPerSvgUnit: rect.width / 480, surfaceWidth: rect.width })
      }
      document.body.innerHTML = ''
      return out
    })
    for (const row of result) {
      expect(row.pxPerSvgUnit).toBeCloseTo(5 * row.scale, 0)
    }
    expect(result[0]!.pxPerSvgUnit).toBeCloseTo(1.25, 1)
    expect(result[1]!.pxPerSvgUnit).toBeCloseTo(5, 0)
    expect(result[2]!.pxPerSvgUnit).toBeCloseTo(25, 0)
  }, 30_000)

  it('measures N-px-outside clicks with fixed 0.5 vs zoom-aware tolerance', async () => {
    const result = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const tol = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-hit-tolerance.ts'
      )
      // Thin horizontal line: stroke 1 SVG unit, so the visible half-width is
      // 0.5 SVG units and an E-px-outside click sits at 0.5 + E/(5*s) SVG units
      // from the centerline. Small filled square for the fill-edge case.
      const lineSvg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<line x1="10" y1="60" x2="110" y2="60" stroke="black" stroke-width="1" fill="none"/></svg>'
      const rectSvg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<rect x="10" y="10" width="4" height="4" fill="red" stroke="none"/></svg>'
      const lineDoc = new DOMParser().parseFromString(lineSvg, 'image/svg+xml')
      const rectDoc = new DOMParser().parseFromString(rectSvg, 'image/svg+xml')
      const lineEls = Array.from(lineDoc.documentElement.children) as Element[]
      const rectEls = Array.from(rectDoc.documentElement.children) as Element[]
      const scales = [0.25, 1, 5]
      const edgeOffsets = [0, 0.5, 1, 1.5, 2, 2.5, 3, 6, 12]
      const lineRows: Array<Record<string, number | boolean>> = []
      const rectRows: Array<Record<string, number | boolean>> = []
      for (const s of scales) {
        const cssPerSvg = 5 * s
        const fixedTol = 0.5
        const zoomTol = tol.vectorSelectToleranceSvgUnits(s)
        for (const e of edgeOffsets) {
          const offSvg = 0.5 + e / cssPerSvg
          const lineFixed = await paper.paperVectorHitIndex(lineEls, { x: 60, y: 60 + offSvg }, fixedTol)
          const lineZoom = await paper.paperVectorHitIndex(lineEls, { x: 60, y: 60 + offSvg }, zoomTol)
          lineRows.push({ scale: s, edgePx: e, fixedHit: lineFixed >= 0, zoomHit: lineZoom >= 0 })
          // Rect spans x/y 10..14; probe just right of the right edge.
          const rectOffSvg = e / cssPerSvg
          const rectFixed = await paper.paperVectorHitIndex(
            rectEls,
            { x: 14 + rectOffSvg, y: 12 },
            fixedTol,
          )
          const rectZoom = await paper.paperVectorHitIndex(
            rectEls,
            { x: 14 + rectOffSvg, y: 12 },
            zoomTol,
          )
          rectRows.push({ scale: s, edgePx: e, fixedHit: rectFixed >= 0, zoomHit: rectZoom >= 0 })
        }
      }
      return {
        lineRows,
        rectRows,
        helper: {
          select025: tol.vectorSelectToleranceSvgUnits(0.25),
          select100: tol.vectorSelectToleranceSvgUnits(1),
          select500: tol.vectorSelectToleranceSvgUnits(5),
          reshape100: tol.vectorReshapeToleranceSvgUnits(1),
          reshape500: tol.vectorReshapeToleranceSvgUnits(5),
          fixed025: tol.fixedToleranceToScreenPx(0.5, 0.25),
          fixed100: tol.fixedToleranceToScreenPx(0.5, 1),
          fixed500: tol.fixedToleranceToScreenPx(0.5, 5),
        },
      }
    })
    // Pure-helper conversion check (2px budget): 1.6 / 0.4 / 0.08 SVG units.
    expect(result.helper.select025).toBeCloseTo(1.6, 10)
    expect(result.helper.select100).toBeCloseTo(0.4, 10)
    expect(result.helper.select500).toBeCloseTo(0.08, 10)
    expect(result.helper.reshape100).toBeCloseTo(1.25, 10)
    expect(result.helper.fixed025).toBeCloseTo(0.625, 10)
    expect(result.helper.fixed100).toBeCloseTo(2.5, 10)
    expect(result.helper.fixed500).toBeCloseTo(12.5, 10)
    // Thin line, E px outside the visible stroke edge:
    // - 25%: fixed (0.625px) misses E=1,2 that the 2px budget should catch.
    // - 500%: fixed (12.5px) catches E=6,12 that the 2px budget must miss.
    const line = (s: number, e: number) =>
      result.lineRows.find((r) => r.scale === s && r.edgePx === e)!
    const rect = (s: number, e: number) =>
      result.rectRows.find((r) => r.scale === s && r.edgePx === e)!
    expect(line(0.25, 1).fixedHit).toBe(false)
    expect(line(0.25, 1).zoomHit).toBe(true)
    // E=2 sits exactly on the zoom-aware boundary (0.5 + 1.6 SVG units) where
    // Paper.js flips to a miss; E=1.5 is safely inside the 2px budget.
    expect(line(0.25, 1.5).fixedHit).toBe(false)
    expect(line(0.25, 1.5).zoomHit).toBe(true)
    expect(line(1, 2).zoomHit).toBe(true)
    expect(line(1, 3).zoomHit).toBe(false)
    expect(line(5, 6).fixedHit).toBe(true)
    expect(line(5, 6).zoomHit).toBe(false)
    expect(line(5, 12).fixedHit).toBe(true)
    expect(line(5, 12).zoomHit).toBe(false)
    // Small filled square, E px outside the right edge: same pattern.
    expect(rect(0.25, 1).fixedHit).toBe(false)
    expect(rect(0.25, 1).zoomHit).toBe(true)
    expect(rect(5, 6).fixedHit).toBe(true)
    expect(rect(5, 6).zoomHit).toBe(false)
    // Keep the raw tables in the assertion message path for the report.
    expect(result.lineRows.length).toBe(27)
    expect(result.rectRows.length).toBe(27)
    return result
  }, 30_000)
})
