// Real-browser proof for `bitmap-pending-shape-preview.ts` (NEW renderer only,
// product code untouched: no Editor/BitmapEditor wiring changes here).
//
// What is proven (all against the REAL module, imported live from the Vite
// dev server inside the page -- no copied logic for the unit under test):
//   R1 rect filled solid: composite output is STRICTLY byte-equal to an
//      independent hand-rolled reference (putImageData + the shared exclusive
//      painter with a hardcoded hex style) -- the renderer adds zero passes
//      and zero blends. Center pixel is the exact fill color.
//   R2 oval filled solid: strict equality vs the same independent reference;
//      the box corner stays transparent (ellipse, not box) while the center
//      paints.
//   R3 oval/rect outlined: strict reference equality; the contour paints with
//      the FILL style at the shared brush width while the deep interior keeps
//      the base pixels.
//   R4 no alpha-accumulation: a SEMITRANSPARENT gradient (one transparent end)
//      composited TWICE from the same base is byte-identical to one composite
//      and to the single reference render (a missing restore would darken the
//      second pass). The input base bytes are unchanged by every composite.
//   R5 clipped boundaries: an overflowing box composites without throwing,
//      keeps the canvas size, and paints the visible part.
//   R6 transparent fill / zero-brush outline: output bytes equal the base
//      (noop restore path), never a half pass.
//   R7 gradients: horizontal red->blue midpoint blends both channels opaque;
//      radial center pixel is strongly first-stop-dominant (pixel-center
//      sampling sits half a pixel off the exact box center, t~0.035).
//   R8 2x restoration: restoring the base twice reads back byte-identical to
//      the base.
//   R9 fail-closed: refused shapes, base/canvas mismatches and throwing
//      contexts resolve `undefined`/`false`, never a throw.
//
// Dedicated Vite port 4585 (surveyed 2026-11-13: 4583 taken by
// vector-slot-quiescence-failclosed; 4581/4599/4607 taken by earlier audits;
// no literal 4585/4587/4591/4601 claims in test/*.test.ts). CHROME_BIN is
// inherited, with the task-given fallback.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4585
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

type BrowserProof = {
  r1StrictEqual: boolean
  r1Center: number[]
  r1Outside: number[]
  r2StrictEqual: boolean
  r2Corner: number[]
  r2Center: number[]
  r3StrictEqual: boolean
  r3Edge: number[]
  r3Interior: number[]
  r4TwiceEqual: boolean
  r4SingleEqualReference: boolean
  r4BaseUnchanged: boolean
  r4Mid: number[]
  r5Ok: boolean
  r5Size: number[]
  r5Visible: number[]
  r6EqualBase: boolean
  r6ZeroBrushEqualBase: boolean
  r7Mid: number[]
  r7RadialCenter: number[]
  r8RestoreTwiceEqual: boolean
  r9RefusedNull: boolean
  r9MismatchNull: boolean
  r9ThrowingFalse: boolean
}

async function runProofs(): Promise<BrowserProof> {
  if (!page) throw new Error('Browser page not ready')
  return page.evaluate(async (): Promise<BrowserProof> => {
    const mod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
    const ref = await import('/src/features/costumes/bitmap-shape-mode.ts')
    const art = await import('/src/features/costumes/bitmap-artboard.ts')
    const eq: (a: Uint8Array, b: Uint8Array) => boolean = art.bytesEqual
    const W = 100
    const H = 80

    const makeContext = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      return { canvas, ctx }
    }
    const blankBase = (): ImageData => new ImageData(W, H)
    const baseBytes = (data: ImageData): Uint8ClampedArray => new Uint8ClampedArray(data.data)
    const px = (data: ImageData, x: number, y: number): number[] => {
      const o = (y * data.width + x) * 4
      return [data.data[o], data.data[o + 1], data.data[o + 2], data.data[o + 3]]
    }
    const solid = (overrides: Record<string, unknown> = {}) => ({
      fill: '#ff0000',
      secondary: '#ffffff',
      gradient: 'solid',
      fillTransparent: false,
      secondaryTransparent: false,
      brushSize: 6,
      ...overrides,
    })

    // R1: rect filled solid red, independent hardcoded reference.
    const { ctx: ctx1 } = makeContext()
    const base1 = blankBase()
    const shape1 = { kind: 'rect', box: { x: 10, y: 10, width: 40, height: 30 }, mode: 'filled', style: solid() }
    const out1 = mod.compositePendingBitmapShapePreview(ctx1, base1, shape1 as never)
    if (!out1) throw new Error('R1 composite returned undefined')
    const { ctx: ref1 } = makeContext()
    ref1.putImageData(new ImageData(baseBytes(base1), W, H), 0, 0)
    ref1.fillStyle = '#ff0000'
    ref.paintBitmapRectOvalExclusive(ref1, 'rect', 10, 10, 40, 30, 'filled', {
      fillStyle: '#ff0000',
      strokeStyle: '#ff0000',
      lineWidth: 6,
    })
    const refData1 = ref1.getImageData(0, 0, W, H)

    // R2: oval filled solid (same red); corner of the box must stay clear.
    const { ctx: ctx2 } = makeContext()
    const base2 = blankBase()
    const shape2 = { kind: 'oval', box: { x: 10, y: 10, width: 40, height: 30 }, mode: 'filled', style: solid() }
    const out2 = mod.compositePendingBitmapShapePreview(ctx2, base2, shape2 as never)
    if (!out2) throw new Error('R2 composite returned undefined')
    const { ctx: ref2 } = makeContext()
    ref2.putImageData(new ImageData(baseBytes(base2), W, H), 0, 0)
    ref2.fillStyle = '#ff0000'
    ref.paintBitmapRectOvalExclusive(ref2, 'oval', 10, 10, 40, 30, 'filled', {
      fillStyle: '#ff0000',
      strokeStyle: '#ff0000',
      lineWidth: 6,
    })
    const refData2 = ref2.getImageData(0, 0, W, H)

    // R3: outlined rect, brush 8, green fill-carried contour.
    const { ctx: ctx3 } = makeContext()
    const base3 = blankBase()
    const shape3 = {
      kind: 'rect',
      box: { x: 10, y: 10, width: 40, height: 30 },
      mode: 'outlined',
      style: { ...solid(), fill: '#00ff00', brushSize: 8 },
    }
    const out3 = mod.compositePendingBitmapShapePreview(ctx3, base3, shape3 as never)
    if (!out3) throw new Error('R3 composite returned undefined')
    const { ctx: ref3 } = makeContext()
    ref3.putImageData(new ImageData(baseBytes(base3), W, H), 0, 0)
    ref3.strokeStyle = '#00ff00'
    ref3.lineWidth = 8
    ref.paintBitmapRectOvalExclusive(ref3, 'rect', 10, 10, 40, 30, 'outlined', {
      fillStyle: '#00ff00',
      strokeStyle: '#00ff00',
      lineWidth: 8,
    })
    const refData3 = ref3.getImageData(0, 0, W, H)

    // R4: semitransparent horizontal gradient (transparent primary end fades
    // opacity through the surviving red RGB); render twice from one base.
    const { ctx: ctx4 } = makeContext()
    const base4 = blankBase()
    const before4 = baseBytes(base4)
    const shape4 = {
      kind: 'rect',
      box: { x: 0, y: 0, width: 100, height: 80 },
      mode: 'filled',
      style: { ...solid(), gradient: 'horizontal', fillTransparent: true, secondary: '#0000ff' },
    }
    const out4a = mod.compositePendingBitmapShapePreview(ctx4, base4, shape4 as never)
    const out4b = mod.compositePendingBitmapShapePreview(ctx4, base4, shape4 as never)
    if (!out4a || !out4b) throw new Error('R4 composite returned undefined')
    const { ctx: ref4 } = makeContext()
    ref4.putImageData(new ImageData(baseBytes(base4), W, H), 0, 0)
    const grad4 = ref4.createLinearGradient(0, 0, 100, 0)
    // Transparent-match semantics (shared with the editor): a transparent
    // primary end reuses the SURVIVING (blue) end's RGB with alpha 0, so the
    // ramp fades opacity without swinging through red-black. Canvas then
    // interpolates premultiplied, hence the blue-dominant semitransparent mid.
    grad4.addColorStop(0, 'rgba(0, 0, 255, 0)')
    grad4.addColorStop(1, '#0000ff')
    ref4.fillStyle = grad4
    ref.paintBitmapRectOvalExclusive(ref4, 'rect', 0, 0, 100, 80, 'filled', {
      fillStyle: grad4,
      strokeStyle: grad4 as unknown as string,
      lineWidth: 6,
    })
    const refData4 = ref4.getImageData(0, 0, W, H)

    // R5: overflowing box clips without throwing.
    const { ctx: ctx5, canvas: canvas5 } = makeContext()
    const base5 = blankBase()
    let r5Ok = true
    let out5: ImageData | undefined
    try {
      out5 = mod.compositePendingBitmapShapePreview(
        ctx5,
        base5,
        { kind: 'rect', box: { x: -10, y: -10, width: 50, height: 50 }, mode: 'filled', style: solid() } as never,
      )
    } catch {
      r5Ok = false
    }

    // R6: transparent solid fill and zero-brush outline are base-identical.
    const { ctx: ctx6 } = makeContext()
    const base6 = blankBase()
    const out6 = mod.compositePendingBitmapShapePreview(
      ctx6,
      base6,
      { kind: 'rect', box: { x: 10, y: 10, width: 40, height: 30 }, mode: 'filled', style: solid({ fillTransparent: true }) } as never,
    )
    const { ctx: ctx6b } = makeContext()
    const out6b = mod.compositePendingBitmapShapePreview(
      ctx6b,
      base6,
      { kind: 'oval', box: { x: 10, y: 10, width: 40, height: 30 }, mode: 'outlined', style: solid({ brushSize: 0 }) } as never,
    )

    // R7: opaque horizontal red->blue midpoint + radial center stop.
    const { ctx: ctx7 } = makeContext()
    const out7 = mod.compositePendingBitmapShapePreview(
      ctx7,
      blankBase(),
      { kind: 'rect', box: { x: 0, y: 0, width: 100, height: 80 }, mode: 'filled', style: { ...solid(), gradient: 'horizontal', secondary: '#0000ff' } } as never,
    )
    if (!out7) throw new Error('R7 composite returned undefined')
    const { ctx: ctx7r } = makeContext()
    const out7r = mod.compositePendingBitmapShapePreview(
      ctx7r,
      blankBase(),
      { kind: 'rect', box: { x: 10, y: 10, width: 40, height: 40 }, mode: 'filled', style: { ...solid(), gradient: 'radial', secondary: '#0000ff' } } as never,
    )
    if (!out7r) throw new Error('R7 radial composite returned undefined')

    // R8: restore twice === base exactly.
    const { ctx: ctx8 } = makeContext()
    const base8 = blankBase()
    base8.data[4] = 200
    base8.data[7] = 255
    const frame8 = new ImageData(baseBytes(base8), W, H)
    ctx8.putImageData(frame8, 0, 0)
    const okRestore1 = mod.restorePendingShapePreviewBase(ctx8, frame8)
    const okRestore2 = mod.restorePendingShapePreviewBase(ctx8, frame8)
    const read8 = ctx8.getImageData(0, 0, W, H)

    // R9: fail-closed paths never throw.
    const { ctx: ctx9 } = makeContext()
    let r9RefusedNull = false
    let r9MismatchNull = false
    let r9ThrowingFalse = false
    try {
      r9RefusedNull = mod.compositePendingBitmapShapePreview(ctx9, blankBase(), undefined) === undefined
      r9MismatchNull =
        mod.compositePendingBitmapShapePreview(ctx9, { width: 50, height: 80, data: new Uint8ClampedArray(50 * 80 * 4) }, shape1 as never) === undefined
      const throwing = new Proxy(ctx9, {
        get(target, prop) {
          if (prop === 'putImageData' || prop === 'getImageData') {
            return () => { throw new Error('injected taint') }
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop]
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        },
      }) as unknown as CanvasRenderingContext2D
      r9ThrowingFalse = mod.compositePendingBitmapShapePreview(throwing, blankBase(), shape1 as never) === undefined
    } catch {
      r9RefusedNull = false
      r9MismatchNull = false
      r9ThrowingFalse = false
    }

    return {
      r1StrictEqual: eq(out1.data, refData1.data),
      r1Center: px(out1, 30, 25),
      r1Outside: px(out1, 5, 5),
      r2StrictEqual: eq(out2.data, refData2.data),
      r2Corner: px(out2, 10, 10),
      r2Center: px(out2, 30, 25),
      r3StrictEqual: eq(out3.data, refData3.data),
      r3Edge: px(out3, 10, 25),
      r3Interior: px(out3, 30, 25),
      r4TwiceEqual: eq(out4a.data, out4b.data),
      r4SingleEqualReference: eq(out4a.data, refData4.data),
      r4BaseUnchanged: eq(baseBytes(base4), before4),
      r4Mid: px(out4a, 50, 40),
      r5Ok: r5Ok && out5 !== undefined,
      r5Size: out5 ? [out5.width, out5.height] : [-1, -1],
      r5Visible: out5 ? px(out5, 0, 0) : [-1, -1, -1, -1],
      r6EqualBase: out6 ? eq(out6.data, base6.data) : false,
      r6ZeroBrushEqualBase: out6b ? eq(out6b.data, base6.data) : false,
      r7Mid: px(out7, 50, 40),
      r7RadialCenter: px(out7r, 30, 30),
      r8RestoreTwiceEqual: okRestore1 && okRestore2 && eq(read8.data, base8.data),
      r9RefusedNull,
      r9MismatchNull,
      r9ThrowingFalse,
    }
  })
}

describe('bitmap pending-shape preview renderer (real Canvas, port 4585)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, CHROME_BIN: CHROME_PATH },
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
    const fresh = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page = fresh
    await fresh.goto(base, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('matches the shared painter strictly and never accumulates alpha', async () => {
    const proof = await runProofs()
    console.log(`[pending-shape-preview] ${JSON.stringify(proof)}`)

    // R1 rect filled: strict equality + exact color inside, clear outside.
    expect(proof.r1StrictEqual).toBe(true)
    expect(proof.r1Center).toEqual([255, 0, 0, 255])
    expect(proof.r1Outside).toEqual([0, 0, 0, 0])

    // R2 oval filled: strict equality; box corner clear, center painted.
    expect(proof.r2StrictEqual).toBe(true)
    expect(proof.r2Corner[3]).toBe(0)
    expect(proof.r2Center).toEqual([255, 0, 0, 255])

    // R3 outlined: strict equality; green contour, transparent deep interior.
    expect(proof.r3StrictEqual).toBe(true)
    expect(proof.r3Edge).toEqual([0, 255, 0, 255])
    expect(proof.r3Interior).toEqual([0, 0, 0, 0])

    // R4 no accumulation: twice-from-base identical, single matches the
    // independent reference, base bytes untouched, midpoint semitransparent.
    expect(proof.r4TwiceEqual).toBe(true)
    expect(proof.r4SingleEqualReference).toBe(true)
    expect(proof.r4BaseUnchanged).toBe(true)
    expect(proof.r4Mid[3]).toBeGreaterThan(0)
    expect(proof.r4Mid[3]).toBeLessThan(255)

    // R5 clipped overflow: no throw, size kept, visible part painted.
    expect(proof.r5Ok).toBe(true)
    expect(proof.r5Size).toEqual([100, 80])
    expect(proof.r5Visible).toEqual([255, 0, 0, 255])

    // R6 transparent paths are base-identical no-ops.
    expect(proof.r6EqualBase).toBe(true)
    expect(proof.r6ZeroBrushEqualBase).toBe(true)

    // R7 gradients: horizontal midpoint blends opaque; radial center is red.
    // (The radial probe pixel covers [30,31]x[30,31] while the gradient is
    // centered exactly on (30,30), so the pixel-center sample sits t~0.035
    // down the ramp: strongly red-dominant, not bit-exact red.)
    expect(proof.r7Mid[3]).toBe(255)
    expect(proof.r7Mid[0]).toBeGreaterThan(80)
    expect(proof.r7Mid[0]).toBeLessThan(175)
    expect(proof.r7Mid[2]).toBeGreaterThan(80)
    expect(proof.r7Mid[2]).toBeLessThan(175)
    expect(proof.r7RadialCenter[3]).toBe(255)
    expect(proof.r7RadialCenter[0]).toBeGreaterThan(200)
    expect(proof.r7RadialCenter[1]).toBeLessThan(40)
    expect(proof.r7RadialCenter[2]).toBeLessThan(60)

    // R8 2x restore is exact; R9 fail-closed paths never throw.
    expect(proof.r8RestoreTwiceEqual).toBe(true)
    expect(proof.r9RefusedNull).toBe(true)
    expect(proof.r9MismatchNull).toBe(true)
    expect(proof.r9ThrowingFalse).toBe(true)
  }, 60_000)
})
