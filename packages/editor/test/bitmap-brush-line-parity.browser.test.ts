// Bitmap brush + line parity vs the scratch-paint reference (real Chrome Canvas).
//
// Scope: B-1/B-2 scratch-paint-gap. Compares the CURRENT product helpers
// (`drawBitmapBrushStroke` in `bitmap-brush.ts`, `drawBitmapLine` in
// `bitmap-line.ts`) against the REAL scratch-paint reference runtime
// (`getBrushMark` + `forEachLinePoint` + `~~coord - ceil(size/2)` stamping at
// `source-over`, as wired by `bit-tools/brush-tool.js` and
// `bit-tools/line-tool.js`) by applying both to the SAME initial RGBA tile
// and diffing pixels exactly (strict RGBA equality).
//
// Matrix (all pixel-exact):
//   - diameters/widths 1..100 (integers) x strokes: tap, horizontal,
//     vertical, diagonal, reverse-diagonal, slope k/8 (k=0..8),
//     stationary (repeated point), multi-segment zigzag, fractional,
//     negative-fractional rounding signs, off-canvas entering/leaving/fully
//     off-canvas, long lines (clipped, still exact)
//   - zoom-like fractional coordinates (x0.25 / x1 / x5 map canvas px the way
//     the 25%/100%/500% viewport scale does: same truncated raster points)
//   - alpha/transparency: opaque, semi-transparent cumulative single vs double
//     stamps, fully transparent no-op (`rgba(0,0,0,0)` paints nothing)
//   - line-vs-brush: two-point brush stroke equals the line segment at the
//     same width/color/anchor (shared stamp contract)
//   - fail-closed stress: huge finite / non-finite / out-of-range coords and
//     oversized segments throw `RangeError` fast (no hang, no OOM canvas
//     alloc); oversized sizes clamp to the shared 1..100 toolbar contract
//     (no huge mark canvas); `save`/`restore` stay balanced on throw.
//
// Reference handling (NO vendored copy, NO network):
//   - This file contains NO copy of the reference stamp/interpolation code.
//   - The Node side reads the original reference files (`bitmap.js`,
//     `bit-tools/brush-tool.js`, `bit-tools/line-tool.js`) at runtime and
//     passes their text into the isolated browser scope. The browser builds
//     the reference functions by stripping `import`/`export` lines and
//     evaluating the ORIGINAL text in a closed `new Function` scope with
//     stubbed dependencies. Nothing from the reference is stored as a script.
//   - Product code is imported as modules via Vite (`/src/features/...`).
//   - `brush-tool.js` / `line-tool.js` are read as TEXT only for
//     anchor/composite evidence (string inspection); their `draw` wiring
//     (anchor + `source-over`) is re-expressed below as a minimal test
//     harness using public Canvas APIs.
//   - Existing product code is NOT edited by this test; it only reads.
//
// Constraints:
//   - AGPL-licensed reference code is never copied into this repo.
//   - `Editor.svelte` / `BitmapEditor.svelte` are NOT touched (another agent
//     owns them); the only fix surface allowed is the isolated helpers.
//   - Match range: integer diameters 1..100, finite coordinates with
//     |coord| <= 2^31 - 1 (both sides truncate toward zero identically there;
//     `~~` vs `Math.trunc` can differ only outside int32, which no canvas
//     coordinate reaches and which now fails closed). Non-finite /
//     out-of-range / oversized-segment inputs throw instead of painting.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4631
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

const bitmapJsPath = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/bitmap.js',
)
const brushToolJsPath = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/brush-tool.js',
)
const lineToolJsPath = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/line-tool.js',
)
const bitmapJsText = readFileSync(bitmapJsPath, 'utf8')
const brushToolJsText = readFileSync(brushToolJsPath, 'utf8')
const lineToolJsText = readFileSync(lineToolJsPath, 'utf8')

describe('bitmap brush + line parity vs scratch-paint reference (real Canvas)', () => {
  beforeAll(async () => {
    const probe = await fetch(base).then(() => true).catch(() => false)
    if (probe) throw new Error(`port ${PORT} is already in use; stop the holder first`)
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
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('matches the reference pixel-exactly across the brush/line matrix', async () => {
    const result = await page!.evaluate(
      async ({ bitmapJs, brushToolJs, lineToolJs }: { bitmapJs: string; brushToolJs: string; lineToolJs: string }) => {
        const brushMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-brush.ts')
        const lineMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-line.ts')
        const curDrawBrush = brushMod.drawBitmapBrushStroke as (
          ctx: CanvasRenderingContext2D,
          points: Array<{ x: number; y: number }>,
          diameter: number,
          color: string,
        ) => void
        const curDrawLine = lineMod.drawBitmapLine as (
          ctx: CanvasRenderingContext2D,
          start: { x: number; y: number },
          end: { x: number; y: number },
          width: number,
          color: string,
        ) => void
        const curWalk = brushMod.forEachBrushLinePoint as (
          a: { x: number; y: number },
          b: { x: number; y: number },
          cb: (x: number, y: number) => void,
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

        // Anchor/composite evidence from the tool texts (string checks only).
        const brushAnchor =
          /~~x\s*-\s*roundedUpRadius/.test(brushToolJs) && /Math\.ceil\(this\.size \/ 2\)/.test(brushToolJs)
        const lineAnchor =
          /~~x\s*-\s*roundedUpRadius/.test(lineToolJs) && /Math\.ceil\(this\.size \/ 2\)/.test(lineToolJs)
        const hasBresenham = /callback\(x1, y1\)/.test(bitmapJs) && /err \* 2/.test(bitmapJs)
        const brushSourceOver = /source-over/.test(brushToolJs)
        // The line tool stamps with plain drawImage (source-over default);
        // the brush tool text explicitly names both composites.
        const lineNoDestinationOut = !/destination-out/.test(lineToolJs)

        const TILE = 96

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

        const refDrawLine = (
          dest: CanvasRenderingContext2D,
          start: { x: number; y: number },
          end: { x: number; y: number },
          size: number,
          color: string,
        ) => {
          const normalized = Math.max(1, size | 0)
          const mark = ref.getBrushMark(normalized, color, false)
          const radius = Math.ceil(normalized / 2)
          dest.save()
          dest.globalCompositeOperation = 'source-over'
          dest.imageSmoothingEnabled = false
          try {
            ref.forEachLinePoint(start, end, (x, y) => {
              dest.drawImage(mark, ~~x - radius, ~~y - radius)
            })
          } finally {
            dest.restore()
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

        const applyBrushPair = (
          base: (ctx: CanvasRenderingContext2D) => void,
          points: Array<{ x: number; y: number }>,
          size: number,
          color: string,
        ) => {
          const a = makeTile(base)
          const b = makeTile(base)
          refDrawBrushStroke(a.getContext('2d')!, points, size, color)
          curDrawBrush(b.getContext('2d')!, points, size, color)
          return diffPixels(a, b)
        }

        const applyLinePair = (
          base: (ctx: CanvasRenderingContext2D) => void,
          start: { x: number; y: number },
          end: { x: number; y: number },
          size: number,
          color: string,
        ) => {
          const a = makeTile(base)
          const b = makeTile(base)
          refDrawLine(a.getContext('2d')!, start, end, size, color)
          curDrawLine(b.getContext('2d')!, start, end, size, color)
          return diffPixels(a, b)
        }

        const STROKES: Array<{ name: string; points: Array<{ x: number; y: number }> }> = [
          { name: 'tap', points: [{ x: 48, y: 48 }] },
          { name: 'tap-frac', points: [{ x: 48.7, y: 47.2 }] },
          { name: 'stationary-repeat', points: [{ x: 20, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 20 }] },
          { name: 'horizontal', points: [{ x: 8, y: 48 }, { x: 88, y: 48 }] },
          { name: 'vertical', points: [{ x: 48, y: 8 }, { x: 48, y: 88 }] },
          { name: 'diagonal', points: [{ x: 8, y: 8 }, { x: 88, y: 80 }] },
          { name: 'reverse-diagonal', points: [{ x: 88, y: 80 }, { x: 8, y: 8 }] },
          { name: 'reverse-horizontal', points: [{ x: 88, y: 48 }, { x: 8, y: 48 }] },
          ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({
            name: `slope-${k}/8`,
            points: [{ x: 8, y: 40 }, { x: 88, y: 40 + 10 * k }],
          })),
          {
            name: 'multisegment',
            points: [
              { x: 8, y: 8 },
              { x: 88, y: 8 },
              { x: 88, y: 88 },
              { x: 8, y: 88 },
            ],
          },
          { name: 'fractional', points: [{ x: 8.7, y: 47.2 }, { x: 87.9, y: 49.8 }] },
          { name: 'rounding-neg', points: [{ x: -5.9, y: 48.2 }, { x: 20.4, y: -2.7 }] },
          { name: 'rounding-signs', points: [{ x: 10.5, y: 10.5 }, { x: 10.9, y: 11.9 }] },
          { name: 'offcanvas-entering', points: [{ x: -30, y: -18 }, { x: 36, y: 36 }] },
          { name: 'offcanvas-leaving', points: [{ x: 60, y: 60 }, { x: 126, y: 104 }] },
          { name: 'fully-offcanvas', points: [{ x: -60, y: -60 }, { x: -18, y: -12 }] },
          { name: 'long-clipped', points: [{ x: -400, y: 48 }, { x: 500, y: 52 }] },
        ]

        const magenta = solidBase(255, 0, 255, 255)
        const transparentBase = solidBase(0, 0, 0, 0)
        const translucentBase = solidBase(10, 200, 90, 128)

        // A: full diameter sweep, brush strokes.
        let maxBrushDiff = 0
        const brushOffenders: string[] = []
        for (let d = 1; d <= 100; d += 1) {
          for (const stroke of STROKES) {
            const diff = applyBrushPair(magenta, stroke.points, d, '#123456')
            if (diff !== 0) brushOffenders.push(`d=${d} ${stroke.name} diff=${diff}`)
            if (diff > maxBrushDiff) maxBrushDiff = diff
          }
        }

        // B: full width sweep, line segments (single-segment subset).
        const LINE_STROKES = STROKES.filter((s) => s.points.length === 2)
        let maxLineDiff = 0
        const lineOffenders: string[] = []
        for (let d = 1; d <= 100; d += 1) {
          for (const stroke of LINE_STROKES) {
            const diff = applyLinePair(magenta, stroke.points[0]!, stroke.points[1]!, d, '#123456')
            if (diff !== 0) lineOffenders.push(`d=${d} ${stroke.name} diff=${diff}`)
            if (diff > maxLineDiff) maxLineDiff = diff
          }
        }

        // C: zoom-like fractional coordinates (25% / 100% / 500%).
        const zoomSamples: Array<{ name: string; diff: number }> = []
        for (const zoom of [0.25, 1, 5]) {
          let worst = 0
          const pts = [
            { x: 11.3 * zoom + 20, y: 9.7 * zoom + 20 },
            { x: 47.9 * zoom + 20, y: 33.1 * zoom + 20 },
          ]
          for (const d of [3, 7, 20]) {
            const b = applyBrushPair(magenta, pts, d, '#123456')
            const l = applyLinePair(magenta, pts[0]!, pts[1]!, d, '#123456')
            if (b > worst) worst = b
            if (l > worst) worst = l
          }
          zoomSamples.push({ name: `zoom-${zoom}`, diff: worst })
        }

        // D: alpha / transparency cumulative stamps.
        let maxAlphaDiff = 0
        const alphaCases: Array<{ name: string; diff: number }> = []
        {
          // Semi-transparent cumulative: same stroke twice must match.
          const pts = [{ x: 12, y: 48 }, { x: 84, y: 48 }]
          for (const d of [1, 5, 10, 40]) {
            const a = makeTile(translucentBase)
            const b = makeTile(translucentBase)
            refDrawBrushStroke(a.getContext('2d')!, pts, d, 'rgba(255,0,0,0.5)')
            curDrawBrush(b.getContext('2d')!, pts, d, 'rgba(255,0,0,0.5)')
            // Second cumulative pass on both.
            refDrawBrushStroke(a.getContext('2d')!, pts, d, 'rgba(255,0,0,0.5)')
            curDrawBrush(b.getContext('2d')!, pts, d, 'rgba(255,0,0,0.5)')
            const diff = diffPixels(a, b)
            alphaCases.push({ name: `cumulative-2x-d${d}`, diff })
            if (diff > maxAlphaDiff) maxAlphaDiff = diff
          }
          // Fully transparent stamp is a no-op in both pipelines.
          for (const d of [4, 10]) {
            const bDiff = applyBrushPair(magenta, pts, d, 'rgba(0,0,0,0)')
            const lDiff = applyLinePair(magenta, pts[0]!, pts[1]!, d, 'rgba(0,0,0,0)')
            alphaCases.push({ name: `transparent-brush-d${d}`, diff: bDiff })
            alphaCases.push({ name: `transparent-line-d${d}`, diff: lDiff })
            if (bDiff > maxAlphaDiff) maxAlphaDiff = bDiff
            if (lDiff > maxAlphaDiff) maxAlphaDiff = lDiff
          }
          // Transparent base: opaque brush on empty tile must match.
          for (const d of [2, 9]) {
            const diff = applyBrushPair(transparentBase, pts, d, '#00abcdef')
            alphaCases.push({ name: `transparent-base-d${d}`, diff })
            if (diff > maxAlphaDiff) maxAlphaDiff = diff
          }
        }

        // E: line-vs-brush shared contract (two-point brush == line).
        let maxLineBrushDiff = 0
        {
          const mk = () => {
            const c = document.createElement('canvas')
            c.width = TILE
            c.height = TILE
            return c
          }
          for (let d = 1; d <= 100; d += 1) {
            for (const stroke of LINE_STROKES.slice(0, 6)) {
              const a = mk()
              const b = mk()
              curDrawBrush(a.getContext('2d')!, stroke.points, d, '#123456')
              curDrawLine(b.getContext('2d')!, stroke.points[0]!, stroke.points[1]!, d, '#123456')
              const diff = diffPixels(a, b)
              if (diff > maxLineBrushDiff) maxLineBrushDiff = diff
            }
          }
        }

        // F: fractional sizes normalize identically (~~ on both sides).
        let maxFracSizeDiff = 0
        for (const d of [4.9, 7.5]) {
          const b = applyBrushPair(magenta, STROKES[3]!.points, d, '#123456')
          const l = applyLinePair(magenta, STROKES[3]!.points[0]!, STROKES[3]!.points[1]!, d, '#123456')
          if (b > maxFracSizeDiff) maxFracSizeDiff = b
          if (l > maxFracSizeDiff) maxFracSizeDiff = l
        }

        // G: fail-closed stress (no OOM, no hang, balanced save/restore).
        const failClosed: Record<string, boolean | string> = {}
        {
          const expectThrow = (label: string, fn: () => void) => {
            const t0 = performance.now()
            try {
              fn()
              failClosed[label] = 'NO-THROW'
            } catch (e) {
              failClosed[label] = e instanceof RangeError ? true : `WRONG:${String(e).slice(0, 80)}`
            } finally {
              const dt = performance.now() - t0
              if (dt > 2000) failClosed[`${label}-slow-ms`] = Math.round(dt)
            }
          }
          const mkCtx = () => {
            const c = document.createElement('canvas')
            c.width = 8
            c.height = 8
            return c.getContext('2d')!
          }
          expectThrow('walk-NaN', () => curWalk({ x: Number.NaN, y: 0 }, { x: 5, y: 5 }, () => {}))
          expectThrow('walk-Infinity', () => curWalk({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }, () => {}))
          expectThrow('walk-huge-1e15', () => curWalk({ x: 1e15, y: 0 }, { x: -1e15, y: 0 }, () => {}))
          expectThrow('walk-huge-int32+1', () => curWalk({ x: 2147483648, y: 0 }, { x: 0, y: 0 }, () => {}))
          expectThrow('walk-long-segment', () => curWalk({ x: 0, y: 0 }, { x: 400000, y: 0 }, () => {}))
          expectThrow('brush-NaN', () => curDrawBrush(mkCtx(), [{ x: Number.NaN, y: 0 }], 5, '#000'))
          expectThrow('brush-huge', () => curDrawBrush(mkCtx(), [{ x: 0, y: 0 }, { x: 1e15, y: 0 }], 5, '#000'))
          expectThrow('brush-too-many-points', () =>
            curDrawBrush(mkCtx(), Array.from({ length: 10001 }, () => ({ x: 0, y: 0 })), 5, '#000'),
          )
          expectThrow('line-NaN', () => curDrawLine(mkCtx(), { x: Number.NaN, y: 0 }, { x: 5, y: 5 }, 5, '#000'))
          expectThrow('line-huge', () => curDrawLine(mkCtx(), { x: 0, y: 0 }, { x: 1e12, y: 1e12 }, 5, '#000'))
          // Oversized sizes clamp (no huge canvas alloc, no throw).
          try {
            const mark = brushMod.getBitmapBrushMark(1e9, '#000') as HTMLCanvasElement
            failClosed['size-huge-clamps-100'] = mark.width <= 100 && mark.height <= 100
          } catch {
            failClosed['size-huge-clamps-100'] = 'THREW'
          }
          // Save/restore balance on throw: spy context.
          {
            const c = document.createElement('canvas')
            c.width = 8
            c.height = 8
            const ctx = c.getContext('2d')!
            let saves = 0
            let restores = 0
            const origSave = ctx.save.bind(ctx)
            const origRestore = ctx.restore.bind(ctx)
            ctx.save = () => { saves += 1; return origSave() }
            ctx.restore = () => { restores += 1; return origRestore() }
            try {
              curDrawBrush(ctx, [{ x: 0, y: 0 }, { x: 1e15, y: 0 }], 5, '#000')
            } catch {}
            failClosed['brush-save-restore-balanced'] = saves === restores && saves >= 1
          }
        }

        return {
          brushAnchor,
          lineAnchor,
          hasBresenham,
          brushSourceOver,
          lineNoDestinationOut,
          maxBrushDiff,
          brushOffenderCount: brushOffenders.length,
          brushOffenders: brushOffenders.slice(0, 20),
          maxLineDiff,
          lineOffenderCount: lineOffenders.length,
          lineOffenders: lineOffenders.slice(0, 20),
          zoomSamples,
          alphaCases,
          maxAlphaDiff,
          maxLineBrushDiff,
          maxFracSizeDiff,
          failClosed,
        }
      },
      { bitmapJs: bitmapJsText, brushToolJs: brushToolJsText, lineToolJs: lineToolJsText },
    )

    console.log(JSON.stringify(result, null, 2))

    expect(result.brushAnchor).toBe(true)
    expect(result.lineAnchor).toBe(true)
    expect(result.hasBresenham).toBe(true)
    expect(result.brushSourceOver).toBe(true)
    expect(result.lineNoDestinationOut).toBe(true)

    expect(result.maxBrushDiff).toBe(0)
    expect(result.brushOffenderCount).toBe(0)
    expect(result.maxLineDiff).toBe(0)
    expect(result.lineOffenderCount).toBe(0)
    for (const sample of result.zoomSamples) {
      expect(sample.diff).toBe(0)
    }
    for (const sample of result.alphaCases) {
      expect(sample.diff).toBe(0)
    }
    expect(result.maxAlphaDiff).toBe(0)
    expect(result.maxLineBrushDiff).toBe(0)
    expect(result.maxFracSizeDiff).toBe(0)

    // Fail-closed contract: every hostile input throws RangeError fast.
    for (const key of [
      'walk-NaN',
      'walk-Infinity',
      'walk-huge-1e15',
      'walk-huge-int32+1',
      'walk-long-segment',
      'brush-NaN',
      'brush-huge',
      'brush-too-many-points',
      'line-NaN',
      'line-huge',
    ]) {
      expect((result.failClosed as Record<string, unknown>)[key]).toBe(true)
    }
    expect(result.failClosed['size-huge-clamps-100']).toBe(true)
    expect(result.failClosed['brush-save-restore-balanced']).toBe(true)

    return result
  }, 180_000)
})
