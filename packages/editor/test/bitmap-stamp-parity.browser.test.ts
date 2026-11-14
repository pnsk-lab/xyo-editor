// Scratch Paint bitmap brush/eraser stamp parity probe (real Canvas, diameters 1-100).
//
// Purpose: quantify stamp-generation differences between the reference
// scratch-paint bitmap helper and the current `bitmap-brush.ts` /
// `bitmap-eraser.ts` under identical real-Canvas conditions:
//   - per-diameter diff pixels (RGBA exact + alpha mask),
//   - anti-aliasing (semi-transparent pixels),
//   - brush-vs-eraser leftover (stamp then erase at the same anchor),
//   - anchor/centroid position shift.
//
// Reference handling (no vendored copy, no network):
//   - This file contains NO copy of the reference stamp algorithm.
//   - The Node side reads the original reference files at runtime and passes
//     their text into the isolated browser scope. The browser builds the
//     reference functions by stripping `import`/`export` lines and evaluating
//     the original text in a closed `new Function` scope with stubbed imports.
//     Nothing from the reference is stored as a script in this repo.
//   - Product code is imported as modules via Vite (`/src/features/...`).
//   - No `fetch` to external URLs; the only file reads are the local reference
//     sources supplied as `page.evaluate` arguments.
//
// Existing product code is not edited by this test; it only reads.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4377'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

// Original reference sources (read at runtime, never copied as a script).
const bitmapJsPath = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/bitmap.js',
)
const brushToolJsPath = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/brush-tool.js',
)
const bitmapJsText = readFileSync(bitmapJsPath, 'utf8')
const brushToolJsText = readFileSync(brushToolJsPath, 'utf8')

describe('bitmap stamp parity vs scratch-paint reference (real Canvas, d=1..100)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4377', '--strictPort'], {
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
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('quantifies stamp diffs, AA, brush/eraser residue and anchor shift', async () => {
    const result = await page.evaluate(
      async ({ bitmapJs, brushToolJs }: { bitmapJs: string; brushToolJs: string }) => {
        const brushMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-brush.ts')
        const eraserMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-eraser.ts')

        // ---- Isolated reference scope (no repo copy) ----
        // Strip ESM import/export lines from the ORIGINAL reference text and
        // evaluate it in a closed scope. Only `document` + stubs are supplied;
        // paper/layer helpers are undefined because stamp builders never call
        // them at stamp-build time.
        const stripped = bitmapJs
          .split('\n')
          .filter((line) => !/^\s*import\s/.test(line))
          .join('\n')
          .replace(/export\s*\{[^}]*\}\s*;?\s*$/, '')
        const buildRef = new Function(
          'document',
          'getGuideColor',
          'paper',
          'createCanvas',
          'clearRaster',
          'getRaster',
          'hideGuideLayers',
          'showGuideLayers',
          'clearSelection',
          'ART_BOARD_WIDTH',
          'ART_BOARD_HEIGHT',
          'CENTER',
          'MAX_WORKSPACE_BOUNDS',
          'Formats',
          'log',
          `${stripped}\nreturn { getBrushMark, forEachLinePoint };`,
        )
        const ref = buildRef(
          document,
          () => '#009dec',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ) as {
          getBrushMark: (size: number, color: string, isEraser?: boolean) => HTMLCanvasElement
          forEachLinePoint: (a: { x: number; y: number }, b: { x: number; y: number }, cb: (x: number, y: number) => void) => void
        }

        // Reference anchor evidence (string inspection only, no execution copy):
        // brush-tool.js `draw(x, y)` stamps at `~~x - ceil(size/2)`.
        const hasTruncAnchor =
          /~~x\s*-\s*roundedUpRadius/.test(brushToolJs) && /Math\.ceil\(this\.size \/ 2\)/.test(brushToolJs)
        const hasBresenham = /callback\(x1, y1\)/.test(bitmapJs) && /err \* 2/.test(bitmapJs)

        type Row = {
          d: number
          edge: number
          refEdge: number
          brushOpaque: number
          refBrushOpaque: number
          brushRgbaDiff: number
          brushAlphaDiff: number
          brushAA: number
          refBrushAA: number
          eraserOpaque: number
          refEraserOpaque: number
          eraserRgbaDiff: number
          eraserAlphaDiff: number
          eraserAA: number
          refEraserAA: number
          centroidDx: number
          centroidDy: number
          prodResidue: number
          refResidue: number
          crossProdBrushRefEraser: number
          crossRefBrushProdEraser: number
        }

        const alphaMask = (canvas: HTMLCanvasElement) => {
          const ctx = canvas.getContext('2d')!
          const { width, height } = canvas
          const data = ctx.getImageData(0, 0, width, height).data
          const mask = new Uint8Array(width * height)
          let opaque = 0
          let aa = 0
          let sumX = 0
          let sumY = 0
          let minX = width
          let minY = height
          let maxX = -1
          let maxY = -1
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              const a = data[(y * width + x) * 4 + 3]!
              if (a > 0) {
                mask[y * width + x] = 1
                opaque += 1
                sumX += x
                sumY += y
                if (x < minX) minX = x
                if (y < minY) minY = y
                if (x > maxX) maxX = x
                if (y > maxY) maxY = y
              }
              if (a > 0 && a < 255) aa += 1
            }
          }
          return {
            mask,
            opaque,
            aa,
            width,
            height,
            centroid: opaque > 0 ? { x: sumX / opaque, y: sumY / opaque } : { x: -1, y: -1 },
            bbox: opaque > 0 ? { minX, minY, maxX, maxY } : null,
            raw: data,
          }
        }

        const rows: Row[] = []
        // End-to-end stamped-canvas diff for a few representative diameters.
        const stampedDiffs: Array<{ d: number; diff: number; canvasSize: number }> = []
        // Cancellation (brush then eraser) on a real destination canvas.
        const cancelSamples: Array<{
          d: number
          prodProd: number
          refRef: number
          prodBrushRefEraser: number
          refBrushProdEraser: number
        }> = []

        const stampAt = (
          dest: CanvasRenderingContext2D,
          mark: HTMLCanvasElement,
          size: number,
          x: number,
          y: number,
          comp: GlobalCompositeOperation,
        ) => {
          const r = Math.ceil(size / 2)
          dest.save()
          dest.globalCompositeOperation = comp
          dest.imageSmoothingEnabled = false
          dest.drawImage(mark, Math.trunc(x) - r, Math.trunc(y) - r)
          dest.restore()
        }

        const destDiff = (a: HTMLCanvasElement, b: HTMLCanvasElement) => {
          const ca = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data
          const cb = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data
          let diff = 0
          for (let i = 0; i < ca.length; i += 4) {
            if (ca[i] !== cb[i] || ca[i + 1] !== cb[i + 1] || ca[i + 2] !== cb[i + 2] || ca[i + 3] !== cb[i + 3]) {
              diff += 1
            }
          }
          return diff
        }

        const leftoverAfterErase = (
          brushMark: HTMLCanvasElement,
          brushSize: number,
          eraserMark: HTMLCanvasElement,
          eraserSize: number,
        ) => {
          const S = 160
          const c = document.createElement('canvas')
          c.width = S
          c.height = S
          const ctx = c.getContext('2d')!
          ctx.imageSmoothingEnabled = false
          // Solid base so brush coverage is total, then erase at the same anchor.
          ctx.fillStyle = '#ff00ff'
          ctx.fillRect(0, 0, S, S)
          stampAt(ctx, brushMark, brushSize, 80, 80, 'source-over')
          // Brush paints opaque; eraser punches with destination-out.
          stampAt(ctx, eraserMark, eraserSize, 80, 80, 'destination-out')
          const data = ctx.getImageData(0, 0, S, S).data
          let left = 0
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) left += 1
          }
          // Ideal full cancellation leaves 0 opaque pixels in the whole tile
          // only if the eraser covers the brush. The base fill outside both
          // stamps stays opaque, so restrict to the union bbox of both stamps.
          // Simpler comparable metric: count opaque pixels inside the centered
          // 120x120 window minus the untouched border is noisy; instead return
          // the raw leftover inside the brush bbox by re-measuring: stamp the
          // same pair on a transparent canvas (brush black, eraser cuts) and
          // count remaining brush pixels. That isolates footprint mismatch.
          const c2 = document.createElement('canvas')
          c2.width = S
          c2.height = S
          const ctx2 = c2.getContext('2d')!
          ctx2.imageSmoothingEnabled = false
          stampAt(ctx2, brushMark, brushSize, 80, 80, 'source-over')
          stampAt(ctx2, eraserMark, eraserSize, 80, 80, 'destination-out')
          const d2 = ctx2.getImageData(0, 0, S, S).data
          let residue = 0
          for (let i = 3; i < d2.length; i += 4) {
            if (d2[i] !== 0) residue += 1
          }
          return { fullTileLeft: left, residue }
        }

        for (let d = 1; d <= 100; d += 1) {
          const prodBrush = brushMod.getBitmapBrushMark(d, '#000000') as HTMLCanvasElement
          const refBrush = ref.getBrushMark(d, '#000000', false)
          const prodEraser = eraserMod.getBitmapEraserMark(d, '#009dec') as HTMLCanvasElement
          const refEraser = ref.getBrushMark(d, '#000000', true)
          const pb = alphaMask(prodBrush)
          const rb = alphaMask(refBrush)
          const pe = alphaMask(prodEraser)
          const re = alphaMask(refEraser)

          let brushRgbaDiff = 0
          let brushAlphaDiff = 0
          if (prodBrush.width === refBrush.width && prodBrush.height === refBrush.height) {
            const a = prodBrush.getContext('2d')!.getImageData(0, 0, prodBrush.width, prodBrush.height).data
            const b = refBrush.getContext('2d')!.getImageData(0, 0, refBrush.width, refBrush.height).data
            for (let i = 0; i < a.length; i += 4) {
              const alphaSame = (a[i + 3]! > 0) === (b[i + 3]! > 0)
              if (!alphaSame) brushAlphaDiff += 1
              if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
                brushRgbaDiff += 1
              }
            }
          } else {
            brushRgbaDiff = -1
            brushAlphaDiff = -1
          }

          let eraserRgbaDiff = 0
          let eraserAlphaDiff = 0
          if (prodEraser.width === refEraser.width && prodEraser.height === refEraser.height) {
            const a = prodEraser.getContext('2d')!.getImageData(0, 0, prodEraser.width, prodEraser.height).data
            const b = refEraser.getContext('2d')!.getImageData(0, 0, refEraser.width, refEraser.height).data
            for (let i = 0; i < a.length; i += 4) {
              const alphaSame = (a[i + 3]! > 0) === (b[i + 3]! > 0)
              if (!alphaSame) eraserAlphaDiff += 1
              if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
                eraserRgbaDiff += 1
              }
            }
          } else {
            eraserRgbaDiff = -1
            eraserAlphaDiff = -1
          }

          // Footprint residue within the same implementation (same edge/anchor).
          let prodResidue = 0
          let refResidue = 0
          let crossProdBrushRefEraser = 0
          let crossRefBrushProdEraser = 0
          if (pb.width === pe.width && pb.height === pe.height) {
            for (let i = 0; i < pb.mask.length; i += 1) {
              if (pb.mask[i] === 1 && pe.mask[i] === 0) prodResidue += 1
            }
          }
          if (rb.width === re.width && rb.height === re.height) {
            for (let i = 0; i < rb.mask.length; i += 1) {
              if (rb.mask[i] === 1 && re.mask[i] === 0) refResidue += 1
            }
          }
          if (pb.width === re.width && pb.height === re.height) {
            for (let i = 0; i < pb.mask.length; i += 1) {
              if (pb.mask[i] === 1 && re.mask[i] === 0) crossProdBrushRefEraser += 1
            }
          }
          if (rb.width === pe.width && rb.height === pe.height) {
            for (let i = 0; i < rb.mask.length; i += 1) {
              if (rb.mask[i] === 1 && pe.mask[i] === 0) crossRefBrushProdEraser += 1
            }
          }

          rows.push({
            d,
            edge: prodBrush.width,
            refEdge: refBrush.width,
            brushOpaque: pb.opaque,
            refBrushOpaque: rb.opaque,
            brushRgbaDiff,
            brushAlphaDiff,
            brushAA: pb.aa,
            refBrushAA: rb.aa,
            eraserOpaque: pe.opaque,
            refEraserOpaque: re.opaque,
            eraserRgbaDiff,
            eraserAlphaDiff,
            eraserAA: pe.aa,
            refEraserAA: re.aa,
            centroidDx: pb.centroid.x - rb.centroid.x,
            centroidDy: pb.centroid.y - rb.centroid.y,
            prodResidue,
            refResidue,
            crossProdBrushRefEraser,
            crossRefBrushProdEraser,
          })

          if (d === 6 || d === 7 || d === 10 || d === 20 || d === 40 || d === 100) {
            // End-to-end: stamp each brush once at the same integer point on a
            // fresh tile and diff the tiles (anchor + content combined).
            const mk = () => {
              const c = document.createElement('canvas')
              c.width = 160
              c.height = 160
              return c
            }
            const ca = mk()
            const cb = mk()
            stampAt(ca.getContext('2d')!, prodBrush, d, 80, 80, 'source-over')
            stampAt(cb.getContext('2d')!, refBrush, d, 80, 80, 'source-over')
            stampedDiffs.push({ d, diff: destDiff(ca, cb), canvasSize: 160 })
            const pp = leftoverAfterErase(prodBrush, d, prodEraser, d)
            const rr = leftoverAfterErase(refBrush, d, refEraser, d)
            const pr = leftoverAfterErase(prodBrush, d, refEraser, d)
            const rp = leftoverAfterErase(refBrush, d, prodEraser, d)
            cancelSamples.push({
              d,
              prodProd: pp.residue,
              refRef: rr.residue,
              prodBrushRefEraser: pr.residue,
              refBrushProdEraser: rp.residue,
            })
          }
        }

        const summarize = (pick: (r: Row) => number) => {
          const vals = rows.map(pick)
          return {
            max: Math.max(...vals),
            nonzeroDiameters: rows.filter((r) => pick(r) !== 0).map((r) => r.d),
          }
        }

        return {
          hasTruncAnchor,
          hasBresenham,
          rows,
          summary: {
            brushRgba: summarize((r) => r.brushRgbaDiff),
            brushAlpha: summarize((r) => r.brushAlphaDiff),
            eraserRgba: summarize((r) => r.eraserRgbaDiff),
            eraserAlpha: summarize((r) => r.eraserAlphaDiff),
            prodResidue: summarize((r) => r.prodResidue),
            refResidue: summarize((r) => r.refResidue),
            crossProdBrushRefEraser: summarize((r) => r.crossProdBrushRefEraser),
            crossRefBrushProdEraser: summarize((r) => r.crossRefBrushProdEraser),
          },
          stampedDiffs,
          cancelSamples,
        }
      },
      { bitmapJs: bitmapJsText, brushToolJs: brushToolJsText },
    )

    // ---- Report (also surfaced via stdout on failure paths) ----
    console.log(
      JSON.stringify(
        {
          anchorEvidence: { truncAnchor: result.hasTruncAnchor, bresenham: result.hasBresenham },
          summary: result.summary,
          stampedDiffs: result.stampedDiffs,
          cancelSamples: result.cancelSamples,
          // Full per-diameter table for the report.
          rows: result.rows,
        },
        null,
        2,
      ),
    )

    // Structural parity that must hold on a real Canvas.
    expect(result.hasTruncAnchor).toBe(true)
    expect(result.hasBresenham).toBe(true)
    // Stamp canvas edges always match the reference (ceil(d/2)*2).
    for (const row of result.rows) {
      expect(row.edge).toBe(row.refEdge)
    }
    // No anti-aliasing anywhere: every stamp is crisp fillRect pixels.
    for (const row of result.rows) {
      expect(row.brushAA).toBe(0)
      expect(row.refBrushAA).toBe(0)
      expect(row.eraserAA).toBe(0)
      expect(row.refEraserAA).toBe(0)
    }
    // Small pixel-art diameters are exact squares in both implementations.
    for (const d of [1, 2, 3, 4, 5]) {
      const row = result.rows[d - 1]!
      expect(row.brushRgbaDiff).toBe(0)
      expect(row.brushAlphaDiff).toBe(0)
      expect(row.eraserAlphaDiff).toBe(0)
    }
    // The reference brush/eraser pair cancels exactly (baseline: no residue).
    for (const row of result.rows) {
      expect(row.refResidue).toBe(0)
    }

    // Quantified divergences below are the measured report values. The shared
    // footprint keeps every diameter at exact parity, so all diffs stay zero;
    // a future regression shows up as an intentional non-zero update.
    const brushDiffDiameters = result.summary.brushAlpha.nonzeroDiameters
    // All circular brush stamps match the shared stepper exactly.
    expect(brushDiffDiameters).toEqual([])
    expect(result.summary.brushAlpha.max).toBe(0)
    expect(result.summary.brushRgba.max).toBe(0)
    expect(result.summary.prodResidue.max).toBe(0)
    expect(result.summary.crossProdBrushRefEraser.max).toBe(0)
    expect(result.summary.crossRefBrushProdEraser.max).toBe(0)
    // Eraser stamps replicate the reference stepper, so alpha footprints match.
    expect(result.summary.eraserAlpha.max).toBe(0)
    expect(result.summary.eraserRgba.max).toBe(0)
    // d=1 eraser: the inner rect is issued without clamping, exactly like the
    // reference, so both the alpha and RGBA footprints match.
    expect(result.rows[0]!.eraserAlphaDiff).toBe(0)
    expect(result.rows[0]!.eraserRgbaDiff).toBe(0)
    // Same-anchor cancellation samples: both implementations cancel exactly.
    expect(result.cancelSamples).toEqual([
      { d: 6, prodProd: 0, refRef: 0, prodBrushRefEraser: 0, refBrushProdEraser: 0 },
      { d: 7, prodProd: 0, refRef: 0, prodBrushRefEraser: 0, refBrushProdEraser: 0 },
      { d: 10, prodProd: 0, refRef: 0, prodBrushRefEraser: 0, refBrushProdEraser: 0 },
      { d: 20, prodProd: 0, refRef: 0, prodBrushRefEraser: 0, refBrushProdEraser: 0 },
      { d: 40, prodProd: 0, refRef: 0, prodBrushRefEraser: 0, refBrushProdEraser: 0 },
      { d: 100, prodProd: 0, refRef: 0, prodBrushRefEraser: 0, refBrushProdEraser: 0 },
    ])
    expect(result.stampedDiffs).toEqual([
      { d: 6, diff: 0, canvasSize: 160 },
      { d: 7, diff: 0, canvasSize: 160 },
      { d: 10, diff: 0, canvasSize: 160 },
      { d: 20, diff: 0, canvasSize: 160 },
      { d: 40, diff: 0, canvasSize: 160 },
      { d: 100, diff: 0, canvasSize: 160 },
    ])
    // Anchors/centroids do not shift: same edge, same ceil(d/2) placement and
    // symmetric discs keep the centroid delta at exactly zero.
    for (const row of result.rows) {
      expect(row.centroidDx).toBe(0)
      expect(row.centroidDy).toBe(0)
    }

    return result
  }, 30_000)
})
