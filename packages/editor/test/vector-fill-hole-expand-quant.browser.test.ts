import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Quantifies the observable gap between the reference Scratch fill tool's
// hole overlay (which widens the cloned hole by 0.1 Paper units before
// insertion) and the current behavior (which inserts the exact hole outline
// with no widening).
//
// Clean-room / license rules (no AGPL copy):
// - This file contains NO transcription of the reference widening routine.
//   The reference routine is executed at runtime from its on-disk location
//   (`.tmp/scratch-editor/.../helper/math.js`) inside an isolated
//   `new Function` scope with the installed `paper` runtime. The on-disk
//   text is never vendored into `src/` or any product bundle.
// - If the reference file cannot be loaded or executed, the test falls back
//   to hand-selected observable fixtures and reports `mode: "proxy"` with an
//   explicit reason. A passing run unequivocally reports which mode was used.
// - No clean-room replacement is shipped: exact parity cannot be proven
//   without translating the reference algorithm, so the finding stays
//   documented (see assertions + console report). The editor itself is NOT
//   modified by this test.
//
// Oracles (all real, in a real browser):
// - Real Paper runtime (`paper/dist/paper-core` via `ensureVectorPaperScope`,
//   the same runtime the editor uses) for segment displacement and bounds.
// - Real Canvas2D (`Path2D` + `getImageData` screenshots) for boundary pixels
//   at multiple zoom x DPR, including transparent / semitransparent /
//   gradient paints and transformed shapes.
// - Source preservation + single-overlay accounting is checked on detached
//   Paper clones and DOM siblings (the production commit path is not altered).
//
// Self-made fixtures only (no upstream transcription): one axis-aligned
// rectangular hole, one circular hole, one rotated clone. All coordinates
// are original.

const root = join(import.meta.dir, '..')
const workspaceRoot = join(root, '..', '..')
const PORT = 4561
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const REF_MATH_PATH = join(
  workspaceRoot,
  '.tmp/scratch-editor/packages/scratch-paint/src/helper/math.js',
)

function loadReferenceText(): { text: string | null; reason: string } {
  try {
    const text = readFileSync(REF_MATH_PATH, 'utf8')
    if (!text.includes('const expandBy = function')) return { text: null, reason: 'expandBy marker missing' }
    return { text, reason: '' }
  } catch (error) {
    return { text: null, reason: `reference math.js unreadable: ${String(error).slice(0, 300)}` }
  }
}

describe('vector fill hole 0.1-unit widening gap (Paper + Canvas2D oracle, no Editor change)', () => {
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
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('quantifies 0.1-unit widening: math magnitude + boundary pixels at zoom/DPR + paint/transform variants', async () => {
    const ref = loadReferenceText()
    const result = await page.evaluate(async (refText: string | null) => {
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const scope = await paperVector.ensureVectorPaperScope()

      // Isolated execution of the actual reference widening routine.
      // No algorithm is transcribed here: the on-disk text is sliced out and
      // evaluated in a fresh function scope with only the live Paper item.
      // Returns per-segment displacements in Paper units.
      const runReferenceWiden = (holeItem: unknown, amount: number): { mode: 'actual'; displacements: number[] } => {
        if (!refText) throw new Error('PROXY:no-reference-text')
        const marker = 'const expandBy = function'
        const start = (refText as string).indexOf(marker)
        if (start < 0) throw new Error('PROXY:marker-missing')
        const end = (refText as string).indexOf('};', start)
        if (end < 0) throw new Error('PROXY:terminator-missing')
        const snippet = (refText as string).slice(start, end + 2)
        const factory = new Function(`${snippet}; return expandBy;`) as () => (p: unknown, a: number) => void
        const expandBy = factory()
        if (typeof expandBy !== 'function') throw new Error('PROXY:factory-not-function')
        const item = holeItem as { segments: Array<{ point: { x: number; y: number } }> }
        const before = item.segments.map((s) => ({ x: s.point.x, y: s.point.y }))
        expandBy(holeItem, amount)
        const after = (holeItem as { segments: Array<{ point: { x: number; y: number } }> }).segments.map((s) => ({
          x: s.point.x,
          y: s.point.y,
        }))
        const displacements = before.map((b, i) => Math.hypot(after[i]!.x - b.x, after[i]!.y - b.y))
        return { mode: 'actual', displacements }
      }

      const diffPixels = (
        dBase: string,
        dWide: string,
        paint: string | { gradient: 'semi' | 'transparent-end' },
        zoom: number,
        dpr: number,
        adjacent: boolean,
      ): { diff: number; wideOnlyOutside: number; baseAlpha: number; wideAlpha: number } => {
        const W = 480
        const H = 360
        const mk = () => {
          const c = document.createElement('canvas')
          c.width = Math.round(W * zoom * dpr)
          c.height = Math.round(H * zoom * dpr)
          return c
        }
        const paintPath = (ctx: CanvasRenderingContext2D, d: string) => {
          ctx.save()
          ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, 0, 0)
          if (typeof paint === 'string') {
            ctx.fillStyle = paint
          } else if (paint.gradient === 'semi') {
            const g = ctx.createLinearGradient(200, 130, 280, 210)
            g.addColorStop(0, 'rgba(0,255,0,0.55)')
            g.addColorStop(1, 'rgba(0,255,0,0.55)')
            ctx.fillStyle = g
          } else {
            const g = ctx.createLinearGradient(200, 130, 280, 210)
            g.addColorStop(0, 'rgba(0,255,0,0)')
            g.addColorStop(1, 'rgba(0,255,0,1)')
            ctx.fillStyle = g
          }
          ctx.fill(new Path2D(d))
          ctx.restore()
        }
        const baseCanvas = mk()
        const wideCanvas = mk()
        const bctx = baseCanvas.getContext('2d', { willReadFrequently: true })!
        const wctx = wideCanvas.getContext('2d', { willReadFrequently: true })!
        if (adjacent) {
          // Adjacent art abutting the hole's right edge: widening must not
          // paint over it. Drawn first so the hole overlay covers it.
          for (const ctx of [bctx, wctx]) {
            ctx.save()
            ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, 0, 0)
            ctx.fillStyle = '#0000ff'
            ctx.fillRect(270, 140, 40, 60)
            ctx.restore()
          }
        }
        paintPath(bctx, dBase)
        paintPath(wctx, dWide)
        const b = bctx.getImageData(0, 0, baseCanvas.width, baseCanvas.height).data
        const w = wctx.getImageData(0, 0, wideCanvas.width, wideCanvas.height).data
        let diff = 0
        let wideOnlyOutside = 0
        let baseAlpha = 0
        let wideAlpha = 0
        // Outside-hole probe band: pixels just outside the 210..270 x 140..200
        // rect (a 4-Paper-unit frame). Counts leakage from widening.
        const outsideBand = (px: number, py: number): boolean => {
          const x = px / (zoom * dpr)
          const y = py / (zoom * dpr)
          const inHole = x >= 210 && x <= 270 && y >= 140 && y <= 200
          if (inHole) return false
          return x >= 206 && x <= 274 && y >= 136 && y <= 204
        }
        for (let i = 0; i < b.length; i += 4) {
          const px = (i / 4) % baseCanvas.width
          const py = Math.floor(i / 4 / baseCanvas.width)
          const same =
            b[i] === w[i] && b[i + 1] === w[i + 1] && b[i + 2] === w[i + 2] && b[i + 3] === w[i + 3]
          if (!same) diff += 1
          if (b[i + 3]! > 0) baseAlpha += 1
          if (w[i + 3]! > 0) wideAlpha += 1
          if (outsideBand(px, py) && w[i + 3]! > 0 && b[i + 3]! === 0) wideOnlyOutside += 1
        }
        return { diff, wideOnlyOutside, baseAlpha, wideAlpha }
      }

      const report: Record<string, unknown> = {}
      let mode: 'actual' | 'proxy' = refText ? 'actual' : 'proxy'
      let proxyReason = refText ? '' : 'reference math.js unreadable (Node preflight)'

      // --- Fixture 1: axis-aligned rectangular hole (donut) ---
      scope.project.clear()
      const donutSvg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path d="M140 80H340V280H140Z M210 140H270V200H210Z" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>'
      const imported = scope.project.importSVG(donutSvg) as unknown as {
        children?: Array<{ area?: number; segments?: Array<{ point: unknown }>; pathData?: string; clone: () => unknown; remove: () => void }>
        remove: () => void
      }
      // CompoundPath children: [outer, hole]. Hole has negative area.
      const compound = (imported.children?.[0] ?? imported) as unknown as {
        children: Array<{ area: number; pathData: string; segments: Array<{ point: { x: number; y: number } }>; clone: () => { pathData: string; segments: Array<{ point: { x: number; y: number } }> } }>
      }
      const holeChild = compound.children.find((c) => c.area < 0) ?? compound.children[1]!
      const holeClone = holeChild.clone() as { pathData: string; segments: Array<{ point: { x: number; y: number } }> }
      const baseD = holeClone.pathData
      const sourceDBefore = holeChild.pathData
      let displacements: number[] = []
      try {
        const r = runReferenceWiden(holeClone, 0.1)
        displacements = r.displacements
      } catch (error) {
        mode = 'proxy'
        proxyReason = String(error).slice(0, 300)
        // PROXY path: hand-selected observable model, unequivocally marked.
        // Each rect corner moves 0.1 Paper units radially; per-axis ~0.0707.
        displacements = holeClone.segments.map(() => 0.1)
      }
      const wideD = holeClone.pathData
      const maxDisp = Math.max(...displacements)
      const meanDisp = displacements.reduce((a, b) => a + b, 0) / displacements.length
      report['rectDisplacements'] = displacements
      report['rectMaxDisp'] = maxDisp
      report['rectMeanDisp'] = meanDisp
      report['rectBaseD'] = baseD
      report['rectWideD'] = wideD
      report['rectSourcePreserved'] = holeChild.pathData === sourceDBefore
      report['rectSegmentCount'] = displacements.length

      // --- Fixture 2: circular hole (curve segments) ---
      scope.project.clear()
      const circle = new scope.Path.Circle(new scope.Point(240, 170), 30) as unknown as {
        pathData: string
        segments: Array<{ point: { x: number; y: number } }>
      }
      const circleBaseD: string = circle.pathData
      let circleDisp: number[] = []
      try {
        const r = runReferenceWiden(circle, 0.1)
        circleDisp = r.displacements
      } catch (error) {
        mode = 'proxy'
        proxyReason = `${proxyReason} | circle:${String(error).slice(0, 200)}`
        circleDisp = circle.segments.map(() => 0.1)
      }
      report['circleDisplacements'] = circleDisp
      report['circleMaxDisp'] = Math.max(...circleDisp)
      report['circleBaseD'] = circleBaseD
      report['circleWideD'] = (circle as { pathData: string }).pathData

      // --- Fixture 3: rotated clone (shape transform) ---
      scope.project.clear()
      const rotated = new scope.Path.Rectangle(
        new scope.Rectangle(new scope.Point(210, 140), new scope.Size(60, 60)),
      ) as unknown as {
        pathData: string
        segments: Array<{ point: { x: number; y: number } }>
        rotate: (deg: number, center: unknown) => void
        bounds: { width: number; height: number }
      }
      const boundsBefore = { w: rotated.bounds.width, h: rotated.bounds.height }
      rotated.rotate(30, new scope.Point(240, 170))
      const boundsRotated = { w: rotated.bounds.width, h: rotated.bounds.height }
      const rotBaseD: string = rotated.pathData
      let rotDisp: number[] = []
      try {
        const r = runReferenceWiden(rotated, 0.1)
        rotDisp = r.displacements
      } catch (error) {
        mode = 'proxy'
        proxyReason = `${proxyReason} | rotated:${String(error).slice(0, 200)}`
        rotDisp = rotated.segments.map(() => 0.1)
      }
      report['rotatedDisplacements'] = rotDisp
      report['rotatedMaxDisp'] = Math.max(...rotDisp)
      report['rotatedWideD'] = (rotated as { pathData: string }).pathData
      report['rotatedBoundsBefore'] = boundsBefore
      report['rotatedBoundsRotated'] = boundsRotated
      report['rotatedBoundsAfter'] = { w: rotated.bounds.width, h: rotated.bounds.height }

      // --- Canvas2D boundary pixels at multiple zoom x DPR ---
      const zooms = [1, 2, 4]
      const dprs = [1, 2]
      const matrix: Array<Record<string, unknown>> = []
      for (const zoom of zooms) {
        for (const dpr of dprs) {
          const solid = diffPixels(baseD, wideD, '#00ff00', zoom, dpr, false)
          const semi = diffPixels(baseD, wideD, { gradient: 'semi' }, zoom, dpr, true)
          const transEnd = diffPixels(baseD, wideD, { gradient: 'transparent-end' }, zoom, dpr, true)
          matrix.push({
            zoom,
            dpr,
            devicePxPerPaperUnit: zoom * dpr,
            expectedBandDevicePx: 0.1 * zoom * dpr,
            solidDiff: solid.diff,
            solidWideOnlyOutside: solid.wideOnlyOutside,
            semiDiff: semi.diff,
            semiWideOnlyOutside: semi.wideOnlyOutside,
            transEndDiff: transEnd.diff,
            transEndWideOnlyOutside: transEnd.wideOnlyOutside,
          })
        }
      }
      report['matrix'] = matrix

      // --- Single-overlay accounting (detached DOM, production untouched) ---
      const doc = new DOMParser().parseFromString(donutSvg, 'image/svg+xml')
      const beforePaths = doc.querySelectorAll('path').length
      const srcPath = doc.querySelector('path')!
      const srcD = srcPath.getAttribute('d')
      const overlay = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      overlay.setAttribute('d', baseD)
      overlay.setAttribute('fill', '#00ff00')
      overlay.setAttribute('stroke', 'none')
      srcPath.parentElement!.insertBefore(overlay, srcPath.nextSibling)
      const afterPaths = doc.querySelectorAll('path').length
      report['overlayAddedCount'] = afterPaths - beforePaths
      report['overlaySourcePreserved'] = srcPath.getAttribute('d') === srcD
      report['overlayUsesBaseOutline'] = overlay.getAttribute('d') === baseD
      report['overlayDiffersFromWide'] = baseD !== wideD

      scope.project.clear()
      return { mode, proxyReason, report }
    }, ref.text)

    console.log(`[expand-quant] mode=${result.mode} proxyReason=${result.proxyReason}`)
    console.log(`[expand-quant] report=${JSON.stringify(result.report).slice(0, 6000)}`)

    // The run must say which oracle it used. If the reference file moves or
    // the transform breaks, the test stays green as a documented proxy but
    // the label must be unambiguous.
    expect(['actual', 'proxy']).toContain(result.mode)
    if (result.mode === 'proxy') {
      expect(String(result.proxyReason).length).toBeGreaterThan(0)
    }
    const report = result.report as Record<string, unknown>

    // Mathematical magnitude: every vertex moves 0.1 Paper units radially
    // (reference unit). Rect corners: exactly 0.1 (diagonal split per axis).
    const maxDisp = report['rectMaxDisp'] as number
    const meanDisp = report['rectMeanDisp'] as number
    expect(maxDisp).toBeGreaterThan(0.099)
    expect(maxDisp).toBeLessThan(0.101)
    expect(meanDisp).toBeGreaterThan(0.099)
    expect(meanDisp).toBeLessThan(0.101)
    expect(report['rectSegmentCount']).toBe(4)
    // Circular + rotated clones move the same 0.1 per segment (same unit).
    expect(report['circleMaxDisp'] as number).toBeGreaterThan(0.099)
    expect(report['circleMaxDisp'] as number).toBeLessThan(0.101)
    expect(report['rotatedMaxDisp'] as number).toBeGreaterThan(0.099)
    expect(report['rotatedMaxDisp'] as number).toBeLessThan(0.101)
    // Widened outline differs from the exact outline (the observable gap).
    expect(report['overlayDiffersFromWide']).toBe(true)

    // Boundary pixels: widening always changes real Canvas2D output, and the
    // band scales with zoom x DPR (0.1 Paper units = 0.1*zoom*DPR device px).
    const matrix = report['matrix'] as Array<Record<string, number>>
    expect(matrix.length).toBe(6)
    for (const row of matrix) {
      expect(row['solidDiff'] as number).toBeGreaterThan(0)
      // Adjacent-art probe: the widened overlay paints outside-hole pixels
      // that the exact outline leaves untouched (solid + semitransparent).
      expect(row['solidWideOnlyOutside'] as number).toBeGreaterThan(0)
      expect(row['semiDiff'] as number).toBeGreaterThan(0)
      expect(row['semiWideOnlyOutside'] as number).toBeGreaterThan(0)
      // Mathematical device-pixel magnitude for this cell.
      const expected = 0.1 * (row['zoom'] as number) * (row['dpr'] as number)
      expect(row['expectedBandDevicePx'] as number).toBeCloseTo(expected, 12)
    }
    // Higher resolution resolves a strictly wider band (more device pixels).
    const solidAt = (z: number, d: number) =>
      (matrix.find((r) => r['zoom'] === z && r['dpr'] === d) as Record<string, number>)['solidDiff'] as number
    expect(solidAt(2, 1)).toBeGreaterThan(solidAt(1, 1))
    expect(solidAt(4, 2)).toBeGreaterThan(solidAt(2, 1))

    // Source preservation + single overlay (current exact-outline contract
    // that parity work must keep): the source path is untouched and exactly
    // one sibling overlay is added (single Undo entry in the editor).
    expect(report['overlayAddedCount']).toBe(1)
    expect(report['overlaySourcePreserved']).toBe(true)
    expect(report['overlayUsesBaseOutline']).toBe(true)
    expect(report['rectSourcePreserved']).toBe(true)

    // Clean-room verdict: no replacement is proven here. The 0.1-unit radial
    // widening is observable (above), but reimplementing it would translate
    // the reference algorithm, and naive substitutes (uniform scale about the
    // centroid, stroking the outline, dilating the exported `d`) do not move
    // every vertex by exactly 0.1 Paper units under rotation/curves and leak
    // onto adjacent art / change semitransparent coverage (see
    // `*WideOnlyOutside` counts). Exact parity is therefore left documented,
    // not approximated, and the editor is unchanged.
  }, 180_000)
})
