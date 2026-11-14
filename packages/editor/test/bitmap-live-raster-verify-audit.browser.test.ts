// Independent audit of `bitmap-live-raster-verify.ts` (NEW verification only,
// product code untouched).
//
// What is under audit (packages/editor/src/features/costumes/bitmap-live-raster-verify.ts):
//   - `liveRasterPixelsMatch`: alpha must match EXACTLY (a 255-vs-0 dropout is
//     the data-loss vector); RGB is ignored only when both alphas are 0 and
//     otherwise compared in premultiplied space with a +-2 tolerance.
//   - `verifyBitmapPlacedPixels`: tile-bounded integer-origin proof (no tile
//     over TILE_PIXELS), transparent-margin proof, fractional-origin full-size
//     reference proof (capped at FRACTIONAL_REF_MAX_AREA), fail-closed on every
//     throw. The editor (`Editor.svelte#verifyBitmapLiveRaster`) additionally
//     gates sizes, canvas identity, a toBlob encode probe (area <= 1M px only),
//     and the `isBitmapRasterRefused` verdict -- that wiring is OUT of scope
//     here except where toBlob behaviour interacts with the verdict.
// - Independent audit rule: real API failure injection covers not only the
//   independent source decode path but also the LIVE path (full-pixel blank,
//   margin pollution, single-pixel partial dropout) plus source drawImage /
//   readback / getContext failures. Every injection must resolve
//   `{ ok: false }`, never throw.
// - Rounding rule: where the audit tolerates unavoidable colour rounding it
//   cites measured browser evidence; it never claims a perfect pixel guarantee
//   the measurements do not support.
//
// Browser proofs in this file (all against the REAL product module, imported
// live from the Vite dev server inside the page -- no copied logic):
//   B1 pure comparator parity (Bun + in-browser identical vectors).
//   B2 alpha exactness: 255-vs-0, 1-vs-0, 1-vs-2 all refuse; transparent RGB
//      ignored; premul diff 2 passes / 3 refuses (boundary pinned).
//   B3 low-alpha disclosure: at alpha<=2 ANY straight-RGB substitution passes
//      the premul +-2 gate (measured, documented as perceptual by design).
//   B4 tile boundaries: 1000x512 forces 2 tiles (tileW=512); corruption at the
//      tile seam (x=511/512), in the trailing partial tile, and in a margin
//      all refuse; clean placement passes.
//   B5 live-path failure injection: full blank, margin pollution, 1px partial
//      dropout each refuse with sourceHasOpaque=true.
//   B6 source-path failure injection: throwing drawImage (blank Image),
//      throwing getImageData (1st call = src side, 2nd call = live side),
//      null getContext -- each resolves ok:false, never rejects.
//   B7 out-of-canvas integer placements (negative / overflowing) refuse;
//      exact-edge placement passes.
//   B8 fractional offsets: identical fractional live draw passes; integer
//      live draw vs fractional proof refuses (filtering mismatch is caught);
//      -0.5 (half-pixel clip) refuses exactly like integer -1 (FIXED D2:
//      extent gate requires the full source rect inside the canvas); -2.5
//      refuses.
//   B9 extreme sides: 65535x2 and 2x65535 verify clean (ok:true, toBlob
//      non-null); blanked live refuses. 100000x2 (over the raster-safe side
//      cap) is FIXED D1: the module applies the side/area gate internally, so
//      an opaque-intent source fails closed as { ok:false } instead of
//      false-passing as transparent. The Editor wiring keeps its own pre-cap
//      + encode probe as the first gate.
//   B10 rounding root measurement: putImageData-exact 1px round-trip through
//      drawImage 1:1 across alpha x RGB sweep; max premultiplied drift table
//      (grounds the +-2 tolerance) + straight-RGB drift at tiny alpha
//      (grounds why straight comparison would false-refuse).
//   B11 transparent / semitransparent: all-transparent passes with
//      sourceHasOpaque=false; alpha=128 pattern passes with true; margin
//      semitransparent pixel refuses.
//
// Dedicated Vite port 4581 (surveyed 2026-11-12: 4251/4291/4387/4389/4473/
// 4483/4487/4490/4492/4496/4497/4527/4531/4533/4535/4539/4540/4542/4549/4561/
// 4567/4569/4573/4599 claimed by sibling suites; 4581 is free). CHROME_BIN is
// inherited with the task-given fallback. No product files are touched; no
// git destructive commands are used.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'
import {
  BITMAP_LIVE_VERIFY_FRACTIONAL_REF_MAX_AREA,
  BITMAP_LIVE_VERIFY_TILE_PIXELS,
  liveRasterPixelsMatch,
} from '../src/features/costumes/bitmap-live-raster-verify'

const root = join(import.meta.dir, '..')
const PORT = 4581
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined

function log(label: string, value: unknown) {
  console.log(`[live-raster-verify-audit] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
}

function px(r: number, g: number, b: number, a: number): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a])
}

describe('liveRasterPixelsMatch pure audit (Bun, product import)', () => {
  it('exports the documented tile/memory budgets', () => {
    expect(BITMAP_LIVE_VERIFY_TILE_PIXELS).toBe(262144)
    expect(BITMAP_LIVE_VERIFY_FRACTIONAL_REF_MAX_AREA).toBe(2_000_000)
  })

  it('alpha must match exactly: 255-vs-0 and 1-vs-0 and 1-vs-2 all refuse', () => {
    // A single dropped opaque pixel (the data-loss vector) must refuse even
    // when RGB is identical.
    expect(liveRasterPixelsMatch(px(255, 0, 0, 255), px(255, 0, 0, 0))).toEqual({ match: false, sawOpaque: true })
    expect(liveRasterPixelsMatch(px(10, 20, 30, 1), px(10, 20, 30, 0))).toEqual({ match: false, sawOpaque: true })
    expect(liveRasterPixelsMatch(px(10, 20, 30, 1), px(10, 20, 30, 2))).toEqual({ match: false, sawOpaque: true })
    // ...in both directions (live brighter than source is equally a mismatch).
    expect(liveRasterPixelsMatch(px(10, 20, 30, 0), px(10, 20, 30, 1))).toEqual({ match: false, sawOpaque: false })
    log('alpha-exact', '255/0, 1/0, 1/2, 0/1 all refuse')
  })

  it('transparent pixels ignore RGB (transparent-black normalisation)', () => {
    expect(liveRasterPixelsMatch(px(255, 128, 64, 0), px(0, 0, 0, 0))).toEqual({ match: true, sawOpaque: false })
    expect(liveRasterPixelsMatch(px(0, 0, 0, 0), px(255, 255, 255, 0))).toEqual({ match: true, sawOpaque: false })
  })

  it('opaque identical pixels pass and report sawOpaque', () => {
    expect(liveRasterPixelsMatch(px(13, 37, 101, 255), px(13, 37, 101, 255))).toEqual({ match: true, sawOpaque: true })
  })

  it('premultiplied boundary: diff 2 passes, diff 3 refuses (opaque)', () => {
    // Opaque: premul == straight, so the boundary is exact in output units.
    const src = px(100, 100, 100, 255)
    expect(liveRasterPixelsMatch(src, px(102, 100, 100, 255)).match).toBe(true)
    expect(liveRasterPixelsMatch(src, px(103, 100, 100, 255)).match).toBe(false)
    expect(liveRasterPixelsMatch(src, px(100, 100, 103, 255)).match).toBe(false)
  })

  it('DISCLOSURE (measured, by design): at alpha<=2 any straight-RGB swap passes', () => {
    // src=(255,255,255,1) vs dst=(0,0,0,1): straight RGB differs by 255, but
    // premultiplied both round to <=1, diff <=1 <= 2. The module header owns
    // this: "Straight RGB at tiny alphas is invisible by construction, so it
    // is weighted by alpha (perceptual)". Pinned so no perfect-pixel claim
    // can be read into the proof: alpha itself is exact, RGB is perceptual.
    const a = liveRasterPixelsMatch(px(255, 255, 255, 1), px(0, 0, 0, 1))
    expect(a).toEqual({ match: true, sawOpaque: true })
    const b = liveRasterPixelsMatch(px(255, 0, 0, 2), px(0, 0, 0, 2))
    expect(b.match).toBe(true)
    // The same swap at full opacity refuses (sanity that the gate is real).
    expect(liveRasterPixelsMatch(px(255, 255, 255, 255), px(0, 0, 0, 255)).match).toBe(false)
    log('low-alpha-disclosure', { alpha1SwapPasses: a.match, alpha2SwapPasses: b.match })
  })

  it('FIXED D4: length mismatch refuses (fail closed, unreachable via product path)', () => {
    // Both product readbacks are always sw*sh*4, so this is unreachable, but
    // the pure comparator must fail closed instead of silently comparing the
    // shared prefix (defect report D4, fixed in the helper).
    const observed = liveRasterPixelsMatch(new Uint8ClampedArray([9, 9, 9, 255]), new Uint8ClampedArray([9, 9, 9, 255, 1, 2, 3, 4]))
    log('length-mismatch', observed)
    expect(observed.match).toBe(false)
    expect(observed.sawOpaque).toBe(true)
    // The reverse direction (opaque bytes only on the live side) still
    // refuses, reporting no source opacity.
    expect(liveRasterPixelsMatch(new Uint8ClampedArray([0, 0, 0, 0]), new Uint8ClampedArray([0, 0, 0, 0, 9, 9, 9, 255]))).toEqual({
      match: false,
      sawOpaque: false,
    })
  })
})

describe('bitmap-live-raster-verify browser audit (real product module)', () => {
  beforeAll(async () => {
    const probe = await fetch(base).then(() => true).catch(() => false)
    if (probe) throw new Error(`port ${PORT} is already in use; stop the holder first`)
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  async function freshPage(): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(base, { waitUntil: 'networkidle' })
    return { page, close: () => context.close() }
  }

  it('B1/B2 browser parity: comparator vectors match Bun inside real Chrome', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
        const px = (r: number, g: number, b: number, a: number) => new Uint8ClampedArray([r, g, b, a])
        const cases: Array<[Uint8ClampedArray, Uint8ClampedArray]> = [
          [px(255, 0, 0, 255), px(255, 0, 0, 0)],
          [px(10, 20, 30, 1), px(10, 20, 30, 0)],
          [px(10, 20, 30, 1), px(10, 20, 30, 2)],
          [px(255, 128, 64, 0), px(0, 0, 0, 0)],
          [px(100, 100, 100, 255), px(102, 100, 100, 255)],
          [px(100, 100, 100, 255), px(103, 100, 100, 255)],
        ]
        return {
          budgets: [m.BITMAP_LIVE_VERIFY_TILE_PIXELS, m.BITMAP_LIVE_VERIFY_FRACTIONAL_REF_MAX_AREA],
          results: cases.map(([s, d]) => m.liveRasterPixelsMatch(s, d)),
        }
      })
      log('browser-parity', out)
      expect(out.budgets).toEqual([262144, 2_000_000])
      expect(out.results).toEqual([
        { match: false, sawOpaque: true },
        { match: false, sawOpaque: true },
        { match: false, sawOpaque: true },
        { match: true, sawOpaque: false },
        { match: true, sawOpaque: true },
        { match: false, sawOpaque: true },
      ])
    } finally {
      await close()
    }
  }, 120_000)

  it('B4 tile seams: clean 1000x512 passes; seam/partial-tile/margin 1px corruption refuses', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
        const W = 1000
        const H = 512 // tileHBase=512 -> tileWBase=512 -> seams at x=512, trailing tile 1000-1024
        const paint = (ctx: CanvasRenderingContext2D, ox: number, oy: number) => {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(ox, oy, W, H)
          ctx.fillStyle = '#00ff00'
          ctx.fillRect(ox + 511, oy, 1, H) // last column of tile 0
          ctx.fillStyle = '#0000ff'
          ctx.fillRect(ox + 512, oy, 1, H) // first column of tile 1
          ctx.fillStyle = '#ff00ff'
          ctx.fillRect(ox + 999, oy, 1, H) // trailing partial tile
        }
        const makeLive = (cw: number, ch: number, ox: number, oy: number) => {
          const c = document.createElement('canvas')
          c.width = cw
          c.height = ch
          const ctx = c.getContext('2d')!
          ctx.clearRect(0, 0, cw, ch)
          paint(ctx, ox, oy)
          return { c, ctx }
        }
        const src = document.createElement('canvas')
        src.width = W
        src.height = H
        paint(src.getContext('2d')!, 0, 0)
        const results: Record<string, unknown> = {}
        // exact-fit clean placement (tileW=512 -> tiles [0,512),[512,1024)x[0,512); checks seam columns)
        {
          const { ctx } = makeLive(W, H, 0, 0)
          results.clean = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, ctx)
        }
        // seam corruption: kill one pixel of the x=512 column on the LIVE side
        {
          const { ctx } = makeLive(W, H, 0, 0)
          ctx.clearRect(512, 100, 1, 1)
          results.seamCorrupt = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, ctx)
        }
        // trailing partial-tile corruption
        {
          const { ctx } = makeLive(W, H, 0, 0)
          ctx.clearRect(999, 7, 1, 1)
          results.partialTileCorrupt = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, ctx)
        }
        // margin pollution: larger canvas, placed at (2,2), opaque pixel at (0,0)
        {
          const { c, ctx } = makeLive(W + 4, H + 4, 2, 2)
          const mctx = c.getContext('2d')!
          mctx.fillStyle = '#ff0000'
          mctx.fillRect(0, 0, 1, 1)
          results.marginPolluted = await m.verifyBitmapPlacedPixels(src, W, H, 2, 2, W + 4, H + 4, ctx)
          void c
        }
        // margin clean control
        {
          const { ctx } = makeLive(W + 4, H + 4, 2, 2)
          results.marginClean = await m.verifyBitmapPlacedPixels(src, W, H, 2, 2, W + 4, H + 4, ctx)
        }
        // Real-path drift magnitude: independent tile readback vs live
        // readback over the whole placed rect (grounds the +-2 gate with a
        // real drawImage path, not just the 1px B10 probe).
        {
          const live = document.createElement('canvas')
          live.width = W
          live.height = H
          live.getContext('2d')!.drawImage(src, 0, 0)
          const tile = document.createElement('canvas')
          tile.width = W
          tile.height = H
          const tctx = tile.getContext('2d')!
          tctx.drawImage(src, 0, 0, W, H, 0, 0, W, H)
          const a = tctx.getImageData(0, 0, W, H).data
          const b = live.getContext('2d')!.getImageData(0, 0, W, H).data
          let maxPremul = 0
          let maxStraight = 0
          for (let i = 0; i < a.length; i += 4) {
            const sa = a[i + 3]!
            const la = b[i + 3]!
            if (sa !== la) {
              maxPremul = 1000 + Math.abs(sa - la)
              break
            }
            if (sa === 0) continue
            const prem = (v: number, al: number) => Math.round((v * al) / 255)
            maxPremul = Math.max(
              maxPremul,
              Math.abs(prem(a[i]!, sa) - prem(b[i]!, la)),
              Math.abs(prem(a[i + 1]!, sa) - prem(b[i + 1]!, la)),
              Math.abs(prem(a[i + 2]!, sa) - prem(b[i + 2]!, la)),
            )
            maxStraight = Math.max(maxStraight, Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!))
          }
          results.realPathDrift = { maxPremul, maxStraight }
        }
        return results
      })
      log('tile-seams', out)
      expect(out.clean).toEqual({ ok: true, sourceHasOpaque: true })
      expect(out.seamCorrupt).toEqual({ ok: false, sourceHasOpaque: true })
      expect(out.partialTileCorrupt).toEqual({ ok: false, sourceHasOpaque: true })
      expect(out.marginClean).toEqual({ ok: true, sourceHasOpaque: true })
      expect(out.marginPolluted).toEqual({ ok: false, sourceHasOpaque: true })
      // Real drawImage-path drift must sit inside the +-2 premul gate.
      const drift = out.realPathDrift as { maxPremul: number; maxStraight: number }
      log('real-path-drift', drift)
      expect(drift.maxPremul).toBeLessThanOrEqual(2)
    } finally {
      await close()
    }
  }, 180_000)

  it('B5 live-path injection: full blank and 1px partial dropout both refuse (sourceHasOpaque=true)', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
        const W = 64
        const H = 48
        const src = document.createElement('canvas')
        src.width = W
        src.height = H
        const sctx = src.getContext('2d')!
        sctx.fillStyle = '#ff0000'
        sctx.fillRect(0, 0, W, H)
        const blank = document.createElement('canvas') // fully transparent live
        blank.width = W
        blank.height = H
        const fullBlank = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, blank.getContext('2d')!)
        const live = document.createElement('canvas')
        live.width = W
        live.height = H
        const lctx = live.getContext('2d')!
        lctx.drawImage(src, 0, 0)
        lctx.clearRect(50, 24, 1, 1) // single-pixel partial dropout (sparse-blindspot shape)
        const partial = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, lctx)
        // source-side 1px loss must equally refuse (both directions covered)
        const srcHole = document.createElement('canvas')
        srcHole.width = W
        srcHole.height = H
        const hctx = srcHole.getContext('2d')!
        hctx.drawImage(src, 0, 0)
        hctx.clearRect(50, 24, 1, 1)
        const liveFull = document.createElement('canvas')
        liveFull.width = W
        liveFull.height = H
        liveFull.getContext('2d')!.drawImage(src, 0, 0)
        const srcLoss = await m.verifyBitmapPlacedPixels(srcHole, W, H, 0, 0, W, H, liveFull.getContext('2d')!)
        return { fullBlank, partial, srcLoss }
      })
      log('live-injection', out)
      expect(out.fullBlank).toEqual({ ok: false, sourceHasOpaque: true })
      expect(out.partial).toEqual({ ok: false, sourceHasOpaque: true })
      expect(out.srcLoss).toEqual({ ok: false, sourceHasOpaque: true })
    } finally {
      await close()
    }
  }, 120_000)

  it('B6 API-failure injection: drawImage throw / getImageData throw (src+live) / null ctx all resolve ok:false', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
        const W = 32
        const H = 24
        const src = document.createElement('canvas')
        src.width = W
        src.height = H
        src.getContext('2d')!.fillStyle = '#00ff00'
        src.getContext('2d')!.fillRect(0, 0, W, H)
        const live = document.createElement('canvas')
        live.width = W
        live.height = H
        live.getContext('2d')!.drawImage(src, 0, 0)
        const results: Record<string, unknown> = {}
        const call = async (label: string, fn: () => Promise<unknown>) => {
          try {
            results[label] = await fn()
          } catch (e) {
            results[label] = { threw: String(e).slice(0, 200) }
          }
        }
        // 1. source drawImage throws: blank Image has no decodable data.
        await call('srcDrawThrows', () => m.verifyBitmapPlacedPixels(new Image(), W, H, 0, 0, W, H, live.getContext('2d')!))
        // 2. src-side getImageData throws (1st readback call), then live-side (2nd).
        for (const failOn of [1, 2]) {
          const proto = CanvasRenderingContext2D.prototype
          const orig = proto.getImageData
          let n = 0
          proto.getImageData = function (this: CanvasRenderingContext2D, ...a: [number, number, number, number]) {
            n += 1
            if (n === failOn) throw new Error(`injected getImageData failure #${String(n)}`)
            return (orig as unknown as (...x: unknown[]) => ImageData).apply(this, a as unknown[])
          }
          try {
            await call(failOn === 1 ? 'srcReadThrows' : 'liveReadThrows', () =>
              m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, live.getContext('2d')!),
            )
          } finally {
            proto.getImageData = orig
          }
        }
        // 3. null 2d context for the internal tile canvas.
        {
          const proto = HTMLCanvasElement.prototype
          const origGet = proto.getContext
          let calls = 0
          proto.getContext = function (this: HTMLCanvasElement, ...a: [string]) {
            calls += 1
            if (calls === 1) return null as unknown as CanvasRenderingContext2D
            return (origGet as unknown as (...x: unknown[]) => CanvasRenderingContext2D).apply(this, a as unknown[])
          }
          try {
            await call('nullTileCtx', () => m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, live.getContext('2d')!))
          } finally {
            proto.getContext = origGet
          }
        }
        return results
      })
      log('api-failures', out)
      for (const key of ['srcDrawThrows', 'srcReadThrows', 'liveReadThrows', 'nullTileCtx']) {
        const r = out[key] as { ok?: boolean; threw?: string }
        expect(r.threw).toBeUndefined()
        expect(r.ok).toBe(false)
      }
    } finally {
      await close()
    }
  }, 120_000)

  it('B7 out-of-canvas integer placements refuse; exact edge passes', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
        const W = 16
        const H = 16
        const CW = 64
        const CH = 48
        const src = document.createElement('canvas')
        src.width = W
        src.height = H
        src.getContext('2d')!.fillStyle = '#123456'
        src.getContext('2d')!.fillRect(0, 0, W, H)
        const at = (ox: number, oy: number) => {
          const c = document.createElement('canvas')
          c.width = CW
          c.height = CH
          const ctx = c.getContext('2d')!
          ctx.clearRect(0, 0, CW, CH)
          ctx.drawImage(src, ox, oy)
          return ctx
        }
        const results: Record<string, unknown> = {}
        for (const [label, ox, oy] of [
          ['negX', -1, 0],
          ['negY', 0, -1],
          ['negBoth', -4, -4],
          ['overRight', 49, 0],
          ['overBottom', 0, 33],
          ['wayOut', 64, 48],
        ] as Array<[string, number, number]>) {
          results[label] = await m.verifyBitmapPlacedPixels(src, W, H, ox, oy, CW, CH, at(ox, oy))
        }
        results.exactEdge = await m.verifyBitmapPlacedPixels(src, W, H, 48, 32, CW, CH, at(48, 32))
        results.zeroOrigin = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, CW, CH, at(0, 0))
        return results
      })
      log('out-of-canvas', out)
      for (const key of ['negX', 'negY', 'negBoth', 'overRight', 'overBottom', 'wayOut']) {
        expect((out[key] as { ok: boolean }).ok).toBe(false)
      }
      expect(out.exactEdge).toEqual({ ok: true, sourceHasOpaque: true })
      expect(out.zeroOrigin).toEqual({ ok: true, sourceHasOpaque: true })
    } finally {
      await close()
    }
  }, 120_000)

  it('B8 fractional offsets: identical filtered draw passes; integer live vs fractional proof refuses; any clip refuses', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
        const W = 32
        const H = 24
        const CW = 64
        const CH = 48
        const src = document.createElement('canvas')
        src.width = W
        src.height = H
        const sctx = src.getContext('2d')!
        sctx.fillStyle = '#ff8800'
        sctx.fillRect(0, 0, W, H)
        sctx.fillStyle = '#0044ff'
        sctx.fillRect(4, 4, 8, 8)
        const at = (ox: number, oy: number) => {
          const c = document.createElement('canvas')
          c.width = CW
          c.height = CH
          const ctx = c.getContext('2d')!
          ctx.clearRect(0, 0, CW, CH)
          ctx.drawImage(src, ox, oy)
          return ctx
        }
        const results: Record<string, unknown> = {}
        // identical fractional placement on both sides -> full-size ref matches
        results.fracMatch = await m.verifyBitmapPlacedPixels(src, W, H, 8.5, 6.25, CW, CH, at(8.5, 6.25))
        // live drawn at integer origin but proof asked for fractional -> filtering differs -> refuse
        results.fracMismatch = await m.verifyBitmapPlacedPixels(src, W, H, 8.5, 6.25, CW, CH, at(8, 6))
        // half-pixel clip: origin -0.5 draws 0.5px outside; the extent gate
        // refuses it (FIXED D2: same verdict as integer -1, no clipping).
        results.halfClip = await m.verifyBitmapPlacedPixels(src, W, H, -0.5, 0, CW, CH, at(-0.5, 0))
        // integer -1 at the same edge refuses (asymmetry with halfClip)
        results.intNeg1 = await m.verifyBitmapPlacedPixels(src, W, H, -1, 0, CW, CH, at(-1, 0))
        // clearly outside fractional range refuses
        results.fracWayOut = await m.verifyBitmapPlacedPixels(src, W, H, -2.5, 0, CW, CH, at(-2.5, 0))
        // fractional ref-area cap: canvas over 2M px refuses without allocating the ref
        {
          const big = document.createElement('canvas')
          big.width = 64
          big.height = 48
          const bctx = big.getContext('2d')!
          const r = await m.verifyBitmapPlacedPixels(src, W, H, 0.5, 0.5, 2048, 1025, bctx)
          results.fracOverAreaCap = r
        }
        return results
      })
      log('fractional', out)
      expect((out.fracMatch as { ok: boolean }).ok).toBe(true)
      expect((out.fracMismatch as { ok: boolean }).ok).toBe(false)
      // FIXED D2: half-pixel clip refuses, exactly like integer -1.
      expect((out.halfClip as { ok: boolean }).ok).toBe(false)
      expect((out.intNeg1 as { ok: boolean }).ok).toBe(false)
      expect((out.fracWayOut as { ok: boolean }).ok).toBe(false)
      expect((out.fracOverAreaCap as { ok: boolean }).ok).toBe(false)
    } finally {
      await close()
    }
  }, 120_000)

  it('B9 extreme sides: 65535x2 and 2x65535 verify clean; blanked live refuses; toBlob recorded', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(
        async ({ widths }: { widths: Array<[number, number]> }) => {
          const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
          const results: Record<string, unknown> = {}
          for (const [W, H] of widths) {
            const tag = `${String(W)}x${String(H)}`
            try {
              const src = document.createElement('canvas')
              src.width = W
              src.height = H
              const sctx = src.getContext('2d')
              if (!sctx) {
                results[tag] = { ctxNull: true }
                continue
              }
              sctx.fillStyle = '#ffffff'
              sctx.fillRect(0, 0, W, H)
              sctx.fillStyle = '#ff0000'
              sctx.fillRect(0, 0, Math.min(10, W), H)
              sctx.fillStyle = '#0000ff'
              sctx.fillRect(Math.max(0, W - 10), 0, Math.min(10, W), H)
              let srcHead: number[] | null = null
              try {
                srcHead = Array.from(sctx.getImageData(0, 0, Math.min(16, W), Math.min(2, H)).data.slice(0, 4))
              } catch {}
              const live = document.createElement('canvas')
              live.width = W
              live.height = H
              const lctx = live.getContext('2d')
              if (!lctx) {
                results[tag] = { liveCtxNull: true }
                continue
              }
              lctx.clearRect(0, 0, W, H)
              lctx.drawImage(src, 0, 0)
              const t0 = performance.now()
              const clean = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, lctx)
              const ms = Math.round(performance.now() - t0)
              lctx.clearRect(0, 0, W, H) // silent-blank raster simulation
              const blanked = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, lctx)
              let head: number[] | null = null
              try {
                head = Array.from(lctx.getImageData(0, 0, Math.min(16, W), Math.min(2, H)).data.slice(0, 4))
              } catch {}
              let toBlobNull: boolean | string = 'unprobed'
              let toBlobSize = -1
              try {
                const blob = await new Promise<Blob | null>((resolve) => {
                  try {
                    live.toBlob(resolve, 'image/png')
                  } catch {
                    resolve(null)
                  }
                })
                toBlobNull = blob === null
                toBlobSize = blob ? blob.size : -1
              } catch (e) {
                toBlobNull = `err:${String(e).slice(0, 80)}`
              }
              results[tag] = { clean, blanked, ms, srcHead, headAfterBlank: head, toBlobNull, toBlobSize }
            } catch (e) {
              results[tag] = { harnessErr: String(e).slice(0, 200) }
            }
          }
          return results
        },
        { widths: [[65535, 2], [2, 65535]] as Array<[number, number]> },
      )
      log('extreme-sides', out)
      const a = out['65535x2'] as { clean: { ok: boolean }; blanked: { ok: boolean }; toBlobNull: boolean }
      expect(a.clean.ok).toBe(true)
      expect(a.blanked.ok).toBe(false)
      const b = out['2x65535'] as { clean: { ok: boolean }; blanked: { ok: boolean } }
      expect(b.clean.ok).toBe(true)
      expect(b.blanked.ok).toBe(false)
    } finally {
      await close()
    }
  }, 240_000)

  it('FIXED D1: 100000x2 fails closed as non-transparent -- internal raster-death gate', async () => {
    // At 100000x2 this Chrome raster is dead (paints do not stick, toBlob
    // null -- see srcHead/headAfterBlank below). verifyBitmapPlacedPixels now
    // carries the side/area gate internally (mirroring
    // isBitmapSourceSizeRefused), so BOTH the independent source tile
    // and the live tile path fail closed instead of agreeing on blank: an
    // opaque-intent source returns { ok:false }. The Editor wiring keeps its
    // own pre-gate + encode probe as the first line of defence.
    // This test ASSERTS the correct behaviour (fixed; fails closed).
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
        const W = 100000
        const H = 2
        const src = document.createElement('canvas')
        src.width = W
        src.height = H
        const sctx = src.getContext('2d')!
        sctx.fillStyle = '#ffffff'
        sctx.fillRect(0, 0, W, H)
        sctx.fillStyle = '#ff0000'
        sctx.fillRect(0, 0, 10, H)
        sctx.fillStyle = '#0000ff'
        sctx.fillRect(W - 10, 0, 10, H)
        const srcHead = Array.from(sctx.getImageData(0, 0, 16, H).data.slice(0, 4))
        const live = document.createElement('canvas')
        live.width = W
        live.height = H
        const lctx = live.getContext('2d')!
        lctx.drawImage(src, 0, 0)
        const clean = await m.verifyBitmapPlacedPixels(src, W, H, 0, 0, W, H, lctx)
        const blob = await new Promise<Blob | null>((resolve) => {
          try {
            live.toBlob(resolve, 'image/png')
          } catch {
            resolve(null)
          }
        })
        return { srcHead, clean, toBlobNull: blob === null }
      })
      log('DEFECT-D1', out)
      // Raster-death proof first: the red head pixel never stuck.
      expect(out.srcHead[3]).toBe(0)
      expect(out.toBlobNull).toBe(true)
      // ...so the proof must fail closed, never certify transparency.
      expect(out.clean.ok).toBe(false)
    } finally {
      await close()
    }
  }, 240_000)

  it('B10 rounding roots: exact-1px round-trip drift across alpha x RGB (grounds the +-2 gate)', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const alphas = [1, 2, 3, 5, 10, 16, 128, 255]
        const rgbs: Array<[number, number, number]> = [
          [255, 0, 0],
          [0, 255, 0],
          [0, 0, 255],
          [255, 255, 255],
          [13, 37, 101],
          [1, 2, 3],
        ]
        const put = document.createElement('canvas')
        put.width = 1
        put.height = 1
        const pctx = put.getContext('2d', { willReadFrequently: true })!
        const dst = document.createElement('canvas')
        dst.width = 1
        dst.height = 1
        const dctx = dst.getContext('2d', { willReadFrequently: true })!
        const rows: Array<{ alpha: number; maxPremul: number; maxStraight: number; worst: string }> = []
        for (const a of alphas) {
          let maxPremul = 0
          let maxStraight = 0
          let worst = ''
          for (const [r, g, b] of rgbs) {
            const img = pctx.createImageData(1, 1)
            img.data[0] = r
            img.data[1] = g
            img.data[2] = b
            img.data[3] = a
            pctx.putImageData(img, 0, 0)
            dctx.clearRect(0, 0, 1, 1)
            dctx.drawImage(put, 0, 0)
            const back = dctx.getImageData(0, 0, 1, 1).data
            const fwd = pctx.getImageData(0, 0, 1, 1).data
            const prem = (v: number, al: number) => Math.round((v * al) / 255)
            const dp =
              Math.max(
                Math.abs(prem(fwd[0]!, fwd[3]!) - prem(back[0]!, back[3]!)),
                Math.abs(prem(fwd[1]!, fwd[3]!) - prem(back[1]!, back[3]!)),
                Math.abs(prem(fwd[2]!, fwd[3]!) - prem(back[2]!, back[3]!)),
              ) + (fwd[3] !== back[3] ? 1000 : 0)
            const ds = Math.max(Math.abs(fwd[0]! - back[0]!), Math.abs(fwd[1]! - back[1]!), Math.abs(fwd[2]! - back[2]!))
            if (dp > maxPremul) {
              maxPremul = dp
              worst = `rgb(${String(r)},${String(g)},${String(b)}) fwd=[${String(fwd[0])},${String(fwd[1])},${String(fwd[2])},${String(fwd[3])}] back=[${String(back[0])},${String(back[1])},${String(back[2])},${String(back[3])}]`
            }
            if (ds > maxStraight) maxStraight = ds
          }
          rows.push({ alpha: a, maxPremul, maxStraight, worst })
        }
        return { rows }
      })
      log('rounding-roots', out)
      for (const row of out.rows) {
        // Alpha itself must round-trip exactly for every tested colour.
        expect(row.maxPremul).toBeLessThan(1000)
        // The premultiplied +-2 gate must cover every observed real drift,
        // with headroom to spare (measured max is the evidence for the gate).
        expect(row.maxPremul).toBeLessThanOrEqual(2)
      }
    } finally {
      await close()
    }
  }, 120_000)

  it('B11 transparency-semantics: all-transparent passes opaque-free; alpha=128 passes; margin haze refuses', async () => {
    const { page, close } = await freshPage()
    try {
      const out = await page.evaluate(async () => {
        const m = await import('/src/features/costumes/bitmap-live-raster-verify.ts')
        const W = 16
        const H = 12
        const blankSrc = document.createElement('canvas')
        blankSrc.width = W
        blankSrc.height = H // never painted: all transparent
        const blankLive = document.createElement('canvas')
        blankLive.width = W
        blankLive.height = H
        const allTransparent = await m.verifyBitmapPlacedPixels(blankSrc, W, H, 0, 0, W, H, blankLive.getContext('2d')!)
        const semi = document.createElement('canvas')
        semi.width = W
        semi.height = H
        const sctx = semi.getContext('2d')!
        sctx.fillStyle = 'rgba(200,40,90,0.5)'
        sctx.fillRect(0, 0, W, H)
        const semiLive = document.createElement('canvas')
        semiLive.width = W
        semiLive.height = H
        semiLive.getContext('2d')!.drawImage(semi, 0, 0)
        const semiMatch = await m.verifyBitmapPlacedPixels(semi, W, H, 0, 0, W, H, semiLive.getContext('2d')!)
        // margin haze: semitransparent 1px outside the placed rect must refuse
        const wide = document.createElement('canvas')
        wide.width = W + 2
        wide.height = H + 2
        const wctx = wide.getContext('2d')!
        wctx.clearRect(0, 0, W + 2, H + 2)
        wctx.drawImage(semi, 1, 1)
        wctx.fillStyle = 'rgba(0,0,0,0.04)'
        wctx.fillRect(0, 0, 1, 1)
        const marginHaze = await m.verifyBitmapPlacedPixels(semi, W, H, 1, 1, W + 2, H + 2, wctx)
        return { allTransparent, semiMatch, marginHaze }
      })
      log('transparency', out)
      expect(out.allTransparent).toEqual({ ok: true, sourceHasOpaque: false })
      expect((out.semiMatch as { ok: boolean }).ok).toBe(true)
      expect((out.semiMatch as { sourceHasOpaque: boolean }).sourceHasOpaque).toBe(true)
      expect((out.marginHaze as { ok: boolean }).ok).toBe(false)
    } finally {
      await close()
    }
  }, 120_000)
})
