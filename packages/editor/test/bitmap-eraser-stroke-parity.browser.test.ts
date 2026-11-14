// Bitmap eraser stroke parity vs the scratch-paint reference (real Chrome Canvas).
//
// Scope: B-5 scratch-paint-gap-matrix. Compares the CURRENT product stroke
// (`drawBitmapEraserStroke` in `src/features/costumes/bitmap-eraser.ts`)
// against the REAL scratch-paint reference runtime (`getBrushMark` with
// `isEraser=true` + `forEachLinePoint` + `destination-out` stamping at
// `~~coord - ceil(size/2)`, as wired by `bit-tools/brush-tool.js`) by applying
// both to the SAME initial RGBA tile and diffing pixels exactly (RGBA channels).
//
// Matrix (all pixel-exact, alpha and RGBA):
//   - diameters 1..100 (integers) x strokes: tap, horizontal, vertical,
//     diagonal, reverse-diagonal, off-canvas entering, off-canvas leaving,
//     fully off-canvas, multi-segment zigzag, fractional drag
//   - initial alpha extremes: 0, 1, 127, 254, 255 (uniform fills)
//   - RGBA overlap base (opaque checker + translucent overlay) x diameters 1..100
//   - erase applied 1x / 2x / 3x (idempotence)
//   - brush-vs-eraser parity: brush stamp then same-diameter/same-anchor erase
//     cancels exactly, for the ref pipeline, the product pipeline, and crosses
//   - zoom-like fractional coordinates (scale factors 0.5/1.5/2/4 produce the
//     same truncated raster points in both implementations)
//
// Reference handling (NO vendored copy, NO network):
//   - This file contains NO copy of the reference stamp/interpolation code.
//   - The Node side reads the original reference file (`bitmap.js`) at runtime
//     and passes its text into the isolated browser scope. The browser builds
//     the reference functions by stripping `import`/`export` lines and
//     evaluating the ORIGINAL text in a closed `new Function` scope with stub
//     dependencies. Nothing from the reference is stored as a script in repo.
//   - Product code is imported as modules via Vite (`/src/features/...`).
//   - `brush-tool.js` is read as TEXT only for anchor/interpolation evidence
//     (string inspection); its `draw` wiring (anchor + `destination-out`) is
//     re-expressed below as a minimal test harness using public Canvas APIs.
//   - Existing product code is NOT edited by this test; it only reads.
//
// Constraints (also reported in the final summary):
//   - AGPL-licensed reference code is never copied into this repo.
//   - `Editor.svelte` / `BitmapEditor.svelte` are NOT touched (another agent
//     owns them); the only fix surface allowed is the pure helper
//     `bitmap-eraser.ts`, changed only with a before/after test run.
//   - Match range: integer diameters 1..100, finite coordinates with
//     |coord| < 2^31 (both sides truncate toward zero identically there;
//     `~~` vs `Math.trunc` can differ only outside int32, which no canvas
//     coordinate reaches). Non-finite / non-positive sizes are clamped to 1
//     by the product helper while the reference yields an empty mark; that
//     out-of-range case is documented, not asserted pixel-equal.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4393'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

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

describe('bitmap eraser stroke parity vs scratch-paint reference (real Canvas)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4393', '--strictPort'], {
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

  it('matches the reference pixel-exactly across the full eraser matrix', async () => {
    const result = await page.evaluate(
      async ({ bitmapJs, brushToolJs }: { bitmapJs: string; brushToolJs: string }) => {
        const eraserMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-eraser.ts')
        const brushMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-brush.ts')
        const curDrawEraser = eraserMod.drawBitmapEraserStroke as (
          ctx: CanvasRenderingContext2D,
          points: Array<{ x: number; y: number }>,
          size: number,
        ) => void
        const curDrawBrush = brushMod.drawBitmapBrushStroke as (
          ctx: CanvasRenderingContext2D,
          points: Array<{ x: number; y: number }>,
          diameter: number,
          color: string,
        ) => void

        // ---- Isolated reference scope (no repo copy) ----
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
          forEachLinePoint: (
            a: { x: number; y: number },
            b: { x: number; y: number },
            cb: (x: number, y: number) => void,
          ) => void
        }

        // Anchor/interpolation evidence from the tool text (string checks only).
        const hasTruncAnchor =
          /~~x\s*-\s*roundedUpRadius/.test(brushToolJs) && /Math\.ceil\(this\.size \/ 2\)/.test(brushToolJs)
        const hasBresenham = /callback\(x1, y1\)/.test(bitmapJs) && /err \* 2/.test(bitmapJs)
        const hasDestinationOut = /destination-out/.test(brushToolJs)

        const TILE = 64

        // Minimal harness wiring for the reference stroke: stamp the reference
        // eraser mark at the reference anchor with `destination-out`. This uses
        // only public Canvas APIs plus the reference primitives above.
        const refDrawEraserStroke = (
          dest: CanvasRenderingContext2D,
          points: Array<{ x: number; y: number }>,
          size: number,
        ) => {
          if (points.length === 0) return
          const normalized = Math.max(1, size | 0)
          const mark = ref.getBrushMark(normalized, '#000000', true)
          const radius = Math.ceil(normalized / 2)
          const stamp = (x: number, y: number) => {
            dest.save()
            dest.globalCompositeOperation = 'destination-out'
            dest.imageSmoothingEnabled = false
            dest.drawImage(mark, ~~x - radius, ~~y - radius)
            dest.restore()
          }
          if (points.length === 1) {
            stamp(points[0]!.x, points[0]!.y)
            return
          }
          for (let i = 0; i < points.length - 1; i += 1) {
            ref.forEachLinePoint(points[i]!, points[i + 1]!, (x, y) => stamp(x, y))
          }
        }

        const refDrawBrushStroke = (
          dest: CanvasRenderingContext2D,
          points: Array<{ x: number; y: number }>,
          size: number,
          color: string,
        ) => {
          if (points.length === 0) return
          const normalized = Math.max(1, size | 0)
          const mark = ref.getBrushMark(normalized, color, false)
          const radius = Math.ceil(normalized / 2)
          const stamp = (x: number, y: number) => {
            dest.save()
            dest.globalCompositeOperation = 'source-over'
            dest.imageSmoothingEnabled = false
            dest.drawImage(mark, ~~x - radius, ~~y - radius)
            dest.restore()
          }
          if (points.length === 1) {
            stamp(points[0]!.x, points[0]!.y)
            return
          }
          for (let i = 0; i < points.length - 1; i += 1) {
            ref.forEachLinePoint(points[i]!, points[i + 1]!, (x, y) => stamp(x, y))
          }
        }

        const makeTile = (paint: (ctx: CanvasRenderingContext2D) => void) => {
          const canvas = document.createElement('canvas')
          canvas.width = TILE
          canvas.height = TILE
          const ctx = canvas.getContext('2d')!
          ctx.imageSmoothingEnabled = false
          paint(ctx)
          return canvas
        }

        const solidBase = (r: number, g: number, b: number, a: number) => (ctx: CanvasRenderingContext2D) => {
          ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`
          ctx.fillRect(0, 0, TILE, TILE)
        }

        const overlapBase = (ctx: CanvasRenderingContext2D) => {
          // RGBA overlap: opaque red/green checker plus a translucent overlay.
          const cell = 8
          for (let y = 0; y < TILE; y += cell) {
            for (let x = 0; x < TILE; x += cell) {
              ctx.fillStyle = ((x + y) / cell) % 2 === 0 ? '#ff0000' : '#00ff00'
              ctx.fillRect(x, y, cell, cell)
            }
          }
          ctx.fillStyle = 'rgba(0,64,255,0.5)'
          ctx.fillRect(8, 8, TILE - 16, TILE - 16)
          ctx.fillStyle = 'rgba(255,255,255,0.25)'
          ctx.fillRect(0, 0, TILE / 2, TILE / 2)
        }

        const diffPixels = (a: HTMLCanvasElement, b: HTMLCanvasElement) => {
          const da = a.getContext('2d')!.getImageData(0, 0, TILE, TILE).data
          const db = b.getContext('2d')!.getImageData(0, 0, TILE, TILE).data
          let diff = 0
          for (let i = 0; i < da.length; i += 4) {
            if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
              diff += 1
            }
          }
          return diff
        }

        const applyPair = (
          base: (ctx: CanvasRenderingContext2D) => void,
          points: Array<{ x: number; y: number }>,
          size: number,
          repeats: number,
        ) => {
          const a = makeTile(base)
          const b = makeTile(base)
          const actx = a.getContext('2d')!
          const bctx = b.getContext('2d')!
          for (let r = 0; r < repeats; r += 1) {
            refDrawEraserStroke(actx, points, size)
            curDrawEraser(bctx, points, size)
          }
          return diffPixels(a, b)
        }

        type Case = { name: string; diff: number }
        const cases: Case[] = []

        const STROKES: Array<{ name: string; points: Array<{ x: number; y: number }> }> = [
          { name: 'tap', points: [{ x: 32, y: 32 }] },
          { name: 'horizontal', points: [{ x: 8, y: 32 }, { x: 56, y: 32 }] },
          { name: 'vertical', points: [{ x: 32, y: 8 }, { x: 32, y: 56 }] },
          { name: 'diagonal', points: [{ x: 8, y: 8 }, { x: 56, y: 48 }] },
          { name: 'reverse-diagonal', points: [{ x: 56, y: 48 }, { x: 8, y: 8 }] },
          { name: 'offcanvas-entering', points: [{ x: -20, y: -12 }, { x: 24, y: 24 }] },
          { name: 'offcanvas-leaving', points: [{ x: 40, y: 40 }, { x: 84, y: 72 }] },
          { name: 'fully-offcanvas', points: [{ x: -40, y: -40 }, { x: -12, y: -8 }] },
          {
            name: 'multisegment',
            points: [
              { x: 8, y: 8 },
              { x: 56, y: 8 },
              { x: 56, y: 56 },
              { x: 8, y: 56 },
            ],
          },
          { name: 'fractional', points: [{ x: 8.7, y: 32.2 }, { x: 55.9, y: 33.8 }] },
        ]

        // A: full diameter sweep on an opaque base, every stroke shape.
        const magenta = solidBase(255, 0, 255, 255)
        let maxStrokeDiff = 0
        const strokeOffenders: string[] = []
        for (let d = 1; d <= 100; d += 1) {
          for (const stroke of STROKES) {
            const diff = applyPair(magenta, stroke.points, d, 1)
            if (diff !== 0) {
              strokeOffenders.push(`d=${d} ${stroke.name} diff=${diff}`)
            }
            if (diff > maxStrokeDiff) maxStrokeDiff = diff
          }
        }
        cases.push({ name: 'stroke-sweep-1..100', diff: maxStrokeDiff })

        // B: initial-alpha extremes on a horizontal drag.
        const horizontal = STROKES[1]!.points
        const alphaSamples: Case[] = []
        for (const alpha of [0, 1, 127, 254, 255]) {
          let worst = 0
          for (const d of [1, 2, 3, 5, 6, 10, 40, 100]) {
            const diff = applyPair(solidBase(10, 200, 90, alpha), horizontal, d, 1)
            if (diff > worst) worst = diff
          }
          alphaSamples.push({ name: `alpha-${alpha}`, diff: worst })
        }

        // C: RGBA overlap base across the full diameter sweep.
        let maxOverlapDiff = 0
        const overlapOffenders: string[] = []
        for (let d = 1; d <= 100; d += 1) {
          const diff = applyPair(overlapBase, STROKES[3]!.points, d, 1)
          if (diff !== 0) overlapOffenders.push(`d=${d} diff=${diff}`)
          if (diff > maxOverlapDiff) maxOverlapDiff = diff
        }
        cases.push({ name: 'rgba-overlap-1..100', diff: maxOverlapDiff })

        // D: repeated erasing is idempotent and identical.
        const repeatSamples: Case[] = []
        for (const repeats of [2, 3]) {
          let worst = 0
          for (const d of [1, 5, 10, 40]) {
            const diff = applyPair(magenta, STROKES[3]!.points, d, repeats)
            if (diff > worst) worst = diff
          }
          repeatSamples.push({ name: `erase-${repeats}x`, diff: worst })
        }

        // E: brush-vs-eraser parity. Same-diameter erase cancels the brush
        // exactly in both pipelines, and cross pairs leave no residue.
        let maxProdResidue = 0
        let maxRefResidue = 0
        let maxCrossA = 0
        let maxCrossB = 0
        let maxPipelineDiff = 0
        const pipelineOffenders: string[] = []
        for (let d = 1; d <= 100; d += 1) {
          // Residue measured on a transparent tile: brush paints, eraser cuts.
          const residue = (
            paint: (ctx: CanvasRenderingContext2D) => void,
            cut: (ctx: CanvasRenderingContext2D) => void,
          ) => {
            const c = makeTile(() => {})
            const ctx = c.getContext('2d')!
            paint(ctx)
            cut(ctx)
            const data = ctx.getImageData(0, 0, TILE, TILE).data
            let left = 0
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] !== 0) left += 1
            }
            return left
          }
          const anchor = [{ x: 32, y: 32 }]
          const drag = [
            { x: 12, y: 32 },
            { x: 52, y: 32 },
          ]
          for (const pts of [anchor, drag]) {
            const prodRes = residue(
              (ctx) => curDrawBrush(ctx, pts, d, '#123456'),
              (ctx) => curDrawEraser(ctx, pts, d),
            )
            const refRes = residue(
              (ctx) => refDrawBrushStroke(ctx, pts, d, '#123456'),
              (ctx) => refDrawEraserStroke(ctx, pts, d),
            )
            const crossA = residue(
              (ctx) => curDrawBrush(ctx, pts, d, '#123456'),
              (ctx) => refDrawEraserStroke(ctx, pts, d),
            )
            const crossB = residue(
              (ctx) => refDrawBrushStroke(ctx, pts, d, '#123456'),
              (ctx) => curDrawEraser(ctx, pts, d),
            )
            if (prodRes > maxProdResidue) maxProdResidue = prodRes
            if (refRes > maxRefResidue) maxRefResidue = refRes
            if (crossA > maxCrossA) maxCrossA = crossA
            if (crossB > maxCrossB) maxCrossB = crossB
            // Full-pipeline pixel parity: own brush + own eraser, same start.
            const pa = makeTile(() => {})
            const pb = makeTile(() => {})
            curDrawBrush(pa.getContext('2d')!, pts, d, '#123456')
            refDrawBrushStroke(pb.getContext('2d')!, pts, d, '#123456')
            curDrawEraser(pa.getContext('2d')!, pts, d)
            refDrawEraserStroke(pb.getContext('2d')!, pts, d)
            const pd = diffPixels(pa, pb)
            if (pd !== 0) pipelineOffenders.push(`d=${d} diff=${pd}`)
            if (pd > maxPipelineDiff) maxPipelineDiff = pd
          }
        }
        cases.push({ name: 'brush-eraser-pipeline-1..100', diff: maxPipelineDiff })

        // F: zoom-like fractional coordinates (same raster points in both).
        const zoomSamples: Case[] = []
        for (const zoom of [0.5, 1.5, 2, 4]) {
          let worst = 0
          const pts = [
            { x: 11.3 * zoom, y: 9.7 * zoom },
            { x: 47.9 * zoom, y: 33.1 * zoom },
          ]
          for (const d of [3, 7, 20]) {
            const diff = applyPair(magenta, pts, d, 1)
            if (diff > worst) worst = diff
          }
          zoomSamples.push({ name: `zoom-${zoom}`, diff: worst })
        }

        // Fractional diameters normalize with `~~` on both sides.
        let maxFracSizeDiff = 0
        for (const d of [4.9, 7.5]) {
          const diff = applyPair(magenta, horizontal, d, 1)
          if (diff > maxFracSizeDiff) maxFracSizeDiff = diff
        }

        return {
          hasTruncAnchor,
          hasBresenham,
          hasDestinationOut,
          maxStrokeDiff,
          strokeOffenders: strokeOffenders.slice(0, 20),
          strokeOffenderCount: strokeOffenders.length,
          alphaSamples,
          maxOverlapDiff,
          overlapOffenders: overlapOffenders.slice(0, 20),
          overlapOffenderCount: overlapOffenders.length,
          repeatSamples,
          brushEraser: { maxProdResidue, maxRefResidue, maxCrossA, maxCrossB, maxPipelineDiff },
          pipelineOffenders: pipelineOffenders.slice(0, 20),
          pipelineOffenderCount: pipelineOffenders.length,
          zoomSamples,
          maxFracSizeDiff,
          cases,
          constraints: {
            agplCopied: false,
            productFilesEdited: [],
            helperOnlyFixAllowed: 'bitmap-eraser.ts',
            matchRange: 'integer diameters 1..100, finite coords |coord| < 2^31',
          },
        }
      },
      { bitmapJs: bitmapJsText, brushToolJs: brushToolJsText },
    )

    console.log(JSON.stringify(result, null, 2))

    // Reference wiring evidence: the tool text shows the trunc anchor,
    // Bresenham interpolation, and destination-out erasing.
    expect(result.hasTruncAnchor).toBe(true)
    expect(result.hasBresenham).toBe(true)
    expect(result.hasDestinationOut).toBe(true)

    // All pixel-exact comparisons must hold with zero diffs.
    expect(result.maxStrokeDiff).toBe(0)
    expect(result.strokeOffenderCount).toBe(0)
    for (const sample of result.alphaSamples) {
      expect(sample.diff).toBe(0)
    }
    expect(result.maxOverlapDiff).toBe(0)
    expect(result.overlapOffenderCount).toBe(0)
    for (const sample of result.repeatSamples) {
      expect(sample.diff).toBe(0)
    }
    expect(result.brushEraser.maxProdResidue).toBe(0)
    expect(result.brushEraser.maxRefResidue).toBe(0)
    expect(result.brushEraser.maxCrossA).toBe(0)
    expect(result.brushEraser.maxCrossB).toBe(0)
    expect(result.brushEraser.maxPipelineDiff).toBe(0)
    expect(result.pipelineOffenderCount).toBe(0)
    for (const sample of result.zoomSamples) {
      expect(sample.diff).toBe(0)
    }
    expect(result.maxFracSizeDiff).toBe(0)

    return result
  }, 120_000)
})
