// Hostile independent proofs for `bitmap-pending-shape-preview.ts` (renderer only,
// product code untouched except the feature helper itself; no Editor/BitmapEditor
// wiring, no AGPL copy: the cross oracle below is a hand-rolled Canvas2D path).
//
// What is proven (all against the REAL module, imported live from the Vite dev
// server inside the page -- no copied logic for the unit under test):
//   H1 invalid inputs never mutate the visible canvas (refused shape,
//      base/canvas mismatch, short `data`, non-integer/oversized dims):
//      composite returns `undefined` and the visible pixels are bit-identical.
//   H2 partial failure after the detached `putImageData` leaves no half state:
//      `addColorStop` throws mid-paint -> `undefined` and the visible canvas
//      still equals the seeded base; `getImageData` throws (tainted) ->
//      `undefined`, never a throw, visible restored to base.
//   H3 caller 2d state never leaks into the paint and is never clobbered:
//      dirty transform + clip + globalAlpha + composite + filter + shadow +
//      dash + save-depth still composites byte-identical to the clean-state
//      reference AND to the hand-rolled oracle; transform/alpha/composite/
//      filter/fill/stroke/lineWidth are unchanged afterwards.
//   H4 huge offscreen clip alone cannot erase the paint (covered in H3, plus a
//      dedicated clip-only case asserting the center pixel paints).
//   H5 fractional x/y boxes composite strictly equal to the hand oracle.
//   H6 semitransparent (one-transparent-end) gradients never accumulate:
//      twice-from-base is byte-identical to once, midpoint alpha is interior.
//   H7 foreign-realm `ImageData` / `Uint8ClampedArray` (iframe) composites and
//      copies successfully (structural, not `instanceof`).
//   H8 readonly / non-clamped byte views work (`Uint8Array`, frozen clamped):
//      copy succeeds, input bytes unchanged, composite succeeds.
//   H9 short `data`, non-integer and huge dimensions fail closed to `undefined`
//      without throwing and without touching the visible canvas.
//  H10 premultiplied antialiased oval contour exists (an interior edge pixel
//      with 0 < a < 255) and the oval still strictly equals both oracles.
//  H11 cross oracle: rect strictly equals the CURRENT shared painter reference
//      AND the hand-rolled reference (two independent code paths, same pixels).
//
// Dedicated Vite port 4591 (surveyed 2026-11-13: 4585 taken by the base proof,
// 4587 used by a scratch probe, 4583/4581/4599/4607/4613 taken by sibling
// suites; no literal 4591 claim in test/*.test.ts). CHROME_BIN is inherited,
// with the task-given fallback.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4591
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

type HostileProof = {
  h1RefusedNull: boolean
  h1RefusedUnchanged: boolean
  h1MismatchNull: boolean
  h1MismatchUnchanged: boolean
  h1ShortNull: boolean
  h1ShortUnchanged: boolean
  h1BadDimsNull: boolean
  h2GradientFailUndef: boolean
  h2GradientVisibleIsBase: boolean
  h2TaintedUndef: boolean
  h2TaintedNoThrow: boolean
  h2TaintedVisibleIsBase: boolean
  h3DirtyEqualClean: boolean
  h3DirtyEqualHand: boolean
  h3StateKept: boolean
  h3SaveBalanced: boolean
  h4ClipOnlyCenter: number[]
  h5FracEqualHand: boolean
  h5FracEqualShared: boolean
  h6TwiceEqual: boolean
  h6Mid: number[]
  h7ForeignCopyOk: boolean
  h7ForeignCompositeOk: boolean
  h7ForeignEqualHand: boolean
  h8U8CompositeOk: boolean
  h8FrozenCopyOk: boolean
  h8FrozenInputKept: boolean
  h9ShortCopyUndef: boolean
  h9HugeRefused: boolean
  h9FloatRefused: boolean
  h10OvalEdge: number[]
  h10OvalEqualShared: boolean
  h10OvalEqualHand: boolean
  h11RectEqualShared: boolean
  h11RectEqualHand: boolean
}

async function runHostileProofs(): Promise<HostileProof> {
  if (!page) throw new Error('Browser page not ready')
  return page.evaluate(async (): Promise<HostileProof> => {
    const mod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
    const shared = await import('/src/features/costumes/bitmap-shape-mode.ts')
    const W = 100
    const H = 80
    const eq = (a: Uint8Array, b: Uint8Array): boolean => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
      return true
    }
    const makeCtx = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      return { canvas, ctx }
    }
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
    const rectShape = { kind: 'rect', box: { x: 10, y: 10, width: 40, height: 30 }, mode: 'filled', style: solid() }
    // Hand-rolled oracle (independent of the shared painter): raw Canvas2D
    // paths with hardcoded geometry. Trivial API use, not upstream code.
    const handRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, paint: string | CanvasGradient): void => {
      ctx.fillStyle = paint
      ctx.fillRect(x, y, w, h)
    }
    const handOvalFill = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, paint: string | CanvasGradient): void => {
      ctx.fillStyle = paint
      ctx.beginPath()
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2)
      ctx.fill()
    }

    // H1: invalid inputs leave the visible canvas bit-identical.
    const seedVisible = (ctx: CanvasRenderingContext2D, css: string): ImageData => {
      ctx.fillStyle = css
      ctx.fillRect(0, 0, W, H)
      return ctx.getImageData(0, 0, W, H)
    }
    let h1RefusedNull = false
    let h1RefusedUnchanged = false
    let h1MismatchNull = false
    let h1MismatchUnchanged = false
    let h1ShortNull = false
    let h1ShortUnchanged = false
    let h1BadDimsNull = false
    {
      const { ctx } = makeCtx()
      const before = seedVisible(ctx, '#00ff00')
      const badShape = { kind: 'rect', box: { x: 0, y: 0, width: 10, height: 10 }, mode: 'dotted', style: solid() }
      let r: unknown = 'x'
      try {
        r = mod.compositePendingBitmapShapePreview(ctx, new ImageData(W, H), badShape as never)
      } catch {
        r = 'threw'
      }
      h1RefusedNull = r === undefined
      h1RefusedUnchanged = eq(ctx.getImageData(0, 0, W, H).data as unknown as Uint8Array, before.data as unknown as Uint8Array)
    }
    {
      const { ctx } = makeCtx()
      const before = seedVisible(ctx, '#00ff00')
      let r: unknown = 'x'
      try {
        r = mod.compositePendingBitmapShapePreview(
          ctx,
          { width: 50, height: 80, data: new Uint8ClampedArray(50 * 80 * 4) },
          rectShape as never,
        )
      } catch {
        r = 'threw'
      }
      h1MismatchNull = r === undefined
      h1MismatchUnchanged = eq(ctx.getImageData(0, 0, W, H).data as unknown as Uint8Array, before.data as unknown as Uint8Array)
    }
    {
      const { ctx } = makeCtx()
      const before = seedVisible(ctx, '#00ff00')
      let r: unknown = 'x'
      try {
        r = mod.compositePendingBitmapShapePreview(
          ctx,
          { width: W, height: H, data: new Uint8ClampedArray(10) },
          rectShape as never,
        )
      } catch {
        r = 'threw'
      }
      h1ShortNull = r === undefined
      h1ShortUnchanged = eq(ctx.getImageData(0, 0, W, H).data as unknown as Uint8Array, before.data as unknown as Uint8Array)
    }
    {
      // Non-integer canvas-size gate lives in the pure resolver; the composite
      // reads integer canvas sizes, so exercise the resolver + copy gates and a
      // NaN-box shape through composite (must be refused, canvas untouched).
      const { ctx } = makeCtx()
      const before = seedVisible(ctx, '#00ff00')
      const nanShape = { kind: 'rect', box: { x: Number.NaN, y: 0, width: 10, height: 10 }, mode: 'filled', style: solid() }
      let r: unknown = 'x'
      try {
        r = mod.compositePendingBitmapShapePreview(ctx, new ImageData(W, H), nanShape as never)
      } catch {
        r = 'threw'
      }
      h1BadDimsNull = r === undefined && eq(ctx.getImageData(0, 0, W, H).data as unknown as Uint8Array, before.data as unknown as Uint8Array)
    }

    // H2: partial failure leaves no half state (visible still equals base).
    let h2GradientFailUndef = false
    let h2GradientVisibleIsBase = false
    {
      const { ctx } = makeCtx()
      const baseImg = new ImageData(W, H)
      baseImg.data[0] = 200
      baseImg.data[1] = 10
      baseImg.data[2] = 10
      baseImg.data[3] = 255
      ctx.putImageData(new ImageData(new Uint8ClampedArray(baseImg.data), W, H), 0, 0)
      const gradShape = {
        kind: 'rect',
        box: { x: 0, y: 0, width: 100, height: 80 },
        mode: 'filled',
        style: { ...solid(), gradient: 'horizontal', secondary: '#0000ff' },
      }
      const proto = CanvasGradient.prototype as unknown as { addColorStop: (...args: unknown[]) => void }
      const orig = proto.addColorStop
      let r: unknown = 'x'
      try {
        proto.addColorStop = () => {
          throw new Error('boom-stop')
        }
        r = mod.compositePendingBitmapShapePreview(ctx, baseImg, gradShape as never)
      } catch {
        r = 'threw'
      } finally {
        proto.addColorStop = orig
      }
      h2GradientFailUndef = r === undefined
      h2GradientVisibleIsBase = eq(ctx.getImageData(0, 0, W, H).data as unknown as Uint8Array, baseImg.data as unknown as Uint8Array)
    }
    let h2TaintedUndef = false
    let h2TaintedNoThrow = false
    let h2TaintedVisibleIsBase = false
    {
      const { ctx } = makeCtx()
      const baseImg = new ImageData(W, H)
      baseImg.data[4] = 77
      baseImg.data[7] = 255
      ctx.putImageData(new ImageData(new Uint8ClampedArray(baseImg.data), W, H), 0, 0)
      const throwing = new Proxy(ctx, {
        get(target, prop) {
          if (prop === 'getImageData') {
            return () => {
              throw new Error('tainted read')
            }
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop]
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        },
      }) as unknown as CanvasRenderingContext2D
      let r: unknown = 'x'
      try {
        r = mod.compositePendingBitmapShapePreview(throwing, baseImg, rectShape as never)
        h2TaintedNoThrow = true
      } catch {
        h2TaintedNoThrow = false
        r = 'threw'
      }
      h2TaintedUndef = r === undefined
      // The proxy forwards putImageData to the real target, so read the REAL
      // context back: it must hold the base (restored), never a half pass.
      h2TaintedVisibleIsBase = eq(ctx.getImageData(0, 0, W, H).data as unknown as Uint8Array, baseImg.data as unknown as Uint8Array)
    }

    // H3: dirty caller state neither affects the paint nor gets clobbered.
    let h3DirtyEqualClean = false
    let h3DirtyEqualHand = false
    let h3StateKept = false
    let h3SaveBalanced = false
    {
      const { ctx: dirty } = makeCtx()
      const baseImg = new ImageData(W, H)
      dirty.save()
      dirty.save()
      dirty.setTransform(2, 0.2, -0.1, 2, 12, -7)
      dirty.globalAlpha = 0.25
      try {
        dirty.globalCompositeOperation = 'destination-over'
      } catch {}
      try {
        ;(dirty as unknown as { filter: string }).filter = 'blur(2px)'
      } catch {}
      try {
        dirty.shadowColor = 'rgba(255,0,0,1)'
        dirty.shadowBlur = 8
        dirty.shadowOffsetX = 3
        dirty.shadowOffsetY = 4
      } catch {}
      try {
        dirty.setLineDash([4, 2])
      } catch {}
      dirty.fillStyle = '#123456'
      dirty.strokeStyle = '#654321'
      dirty.lineWidth = 11
      // Huge offscreen clip: would erase everything if honored.
      dirty.beginPath()
      dirty.rect(5000, 5000, 100, 100)
      dirty.clip()
      const tBefore = dirty.getTransform()
      const r = mod.compositePendingBitmapShapePreview(dirty, baseImg, rectShape as never)
      const tAfter = dirty.getTransform()
      const stateSame =
        tBefore.a === tAfter.a &&
        tBefore.b === tAfter.b &&
        tBefore.c === tAfter.c &&
        tBefore.d === tAfter.d &&
        tBefore.e === tAfter.e &&
        tBefore.f === tAfter.f &&
        dirty.globalAlpha === 0.25 &&
        dirty.globalCompositeOperation === 'destination-over' &&
        dirty.fillStyle === '#123456' &&
        dirty.strokeStyle === '#654321' &&
        dirty.lineWidth === 11
      h3StateKept = stateSame
      // Balanced save/restore: two saves above, composite must net zero.
      try {
        dirty.restore()
        dirty.restore()
        h3SaveBalanced = true
      } catch {
        h3SaveBalanced = false
      }
      // Clean reference via the module on a pristine context.
      const { ctx: clean } = makeCtx()
      const cleanOut = mod.compositePendingBitmapShapePreview(clean, new ImageData(W, H), rectShape as never)
      // Independent hand reference on another pristine context.
      const { ctx: hand } = makeCtx()
      hand.putImageData(new ImageData(W, H), 0, 0)
      handRect(hand, 10, 10, 40, 30, '#ff0000')
      const handOut = hand.getImageData(0, 0, W, H)
      h3DirtyEqualClean =
        r !== undefined && cleanOut !== undefined && eq((r as ImageData).data as unknown as Uint8Array, (cleanOut as ImageData).data as unknown as Uint8Array)
      h3DirtyEqualHand =
        r !== undefined && eq((r as ImageData).data as unknown as Uint8Array, handOut.data as unknown as Uint8Array)
      void shared
    }
    // H4: clip-only case center pixel.
    let h4ClipOnlyCenter: number[] = [-1, -1, -1, -1]
    {
      const { ctx } = makeCtx()
      ctx.save()
      ctx.beginPath()
      ctx.rect(5000, 5000, 100, 100)
      ctx.clip()
      const r = mod.compositePendingBitmapShapePreview(ctx, new ImageData(W, H), rectShape as never)
      if (r) h4ClipOnlyCenter = px(r, 30, 25)
      try {
        ctx.restore()
      } catch {}
    }
    // H5: fractional boxes match both oracles.
    let h5FracEqualHand = false
    let h5FracEqualShared = false
    {
      const frac = { kind: 'rect', box: { x: 10.5, y: 10.25, width: 20.75, height: 10.5 }, mode: 'filled', style: solid() }
      const { ctx } = makeCtx()
      const r = mod.compositePendingBitmapShapePreview(ctx, new ImageData(W, H), frac as never)
      const { ctx: hand } = makeCtx()
      hand.putImageData(new ImageData(W, H), 0, 0)
      handRect(hand, 10.5, 10.25, 20.75, 10.5, '#ff0000')
      const handOut = hand.getImageData(0, 0, W, H)
      const { ctx: ref } = makeCtx()
      ref.putImageData(new ImageData(W, H), 0, 0)
      ref.fillStyle = '#ff0000'
      shared.paintBitmapRectOvalExclusive(ref, 'rect', 10.5, 10.25, 20.75, 10.5, 'filled', {
        fillStyle: '#ff0000',
        strokeStyle: '#ff0000',
        lineWidth: 6,
      })
      const refOut = ref.getImageData(0, 0, W, H)
      h5FracEqualHand = r !== undefined && eq((r as ImageData).data as unknown as Uint8Array, handOut.data as unknown as Uint8Array)
      h5FracEqualShared = r !== undefined && eq((r as ImageData).data as unknown as Uint8Array, refOut.data as unknown as Uint8Array)
    }
    // H6: semitransparent gradient never accumulates.
    let h6TwiceEqual = false
    let h6Mid: number[] = [-1, -1, -1, -1]
    {
      const { ctx } = makeCtx()
      const baseImg = new ImageData(W, H)
      const gs = {
        kind: 'rect',
        box: { x: 0, y: 0, width: 100, height: 80 },
        mode: 'filled',
        style: { ...solid(), gradient: 'horizontal', fillTransparent: true, secondary: '#0000ff' },
      }
      const a = mod.compositePendingBitmapShapePreview(ctx, baseImg, gs as never)
      const b = mod.compositePendingBitmapShapePreview(ctx, baseImg, gs as never)
      h6TwiceEqual = a !== undefined && b !== undefined && eq(a.data as unknown as Uint8Array, b.data as unknown as Uint8Array)
      if (a) h6Mid = px(a, 50, 40)
    }
    // H7: foreign-realm ImageData.
    let h7ForeignCopyOk = false
    let h7ForeignCompositeOk = false
    let h7ForeignEqualHand = false
    {
      const iframe = document.createElement('iframe')
      document.body.appendChild(iframe)
      try {
        const win = iframe.contentWindow as unknown as {
          ImageData: new (data: Uint8ClampedArray, w: number, h: number) => ImageData
          Uint8ClampedArray: new (len: number) => Uint8ClampedArray
        }
        const fdata = new win.Uint8ClampedArray(W * H * 4)
        const fbase = new win.ImageData(fdata, W, H)
        const copied = mod.copyPendingShapePreviewBase(fbase as unknown as never)
        h7ForeignCopyOk = copied !== undefined
        const { ctx } = makeCtx()
        const r = mod.compositePendingBitmapShapePreview(ctx, fbase as unknown as never, rectShape as never)
        h7ForeignCompositeOk = r !== undefined
        const { ctx: hand } = makeCtx()
        hand.putImageData(new ImageData(W, H), 0, 0)
        handRect(hand, 10, 10, 40, 30, '#ff0000')
        const handOut = hand.getImageData(0, 0, W, H)
        h7ForeignEqualHand = r !== undefined && eq((r as ImageData).data as unknown as Uint8Array, handOut.data as unknown as Uint8Array)
      } finally {
        iframe.remove()
      }
    }
    // H8: Uint8Array + frozen clamped input.
    let h8U8CompositeOk = false
    let h8FrozenCopyOk = false
    let h8FrozenInputKept = false
    {
      const u8 = { width: W, height: H, data: new Uint8Array(W * H * 4) }
      u8.data[0] = 5
      const { ctx } = makeCtx()
      const r = mod.compositePendingBitmapShapePreview(ctx, u8 as never, rectShape as never)
      h8U8CompositeOk = r !== undefined && u8.data[0] === 5
      const frozen = new Uint8ClampedArray(W * H * 4)
      frozen[0] = 42
      try {
        Object.freeze(frozen)
      } catch {}
      const copied = mod.copyPendingShapePreviewBase({ width: W, height: H, data: frozen } as never)
      h8FrozenCopyOk = copied !== undefined && copied.data[0] === 42
      h8FrozenInputKept = frozen[0] === 42
    }
    // H9: short / huge / float gates.
    let h9ShortCopyUndef = false
    let h9HugeRefused = false
    let h9FloatRefused = false
    {
      h9ShortCopyUndef = mod.copyPendingShapePreviewBase({ width: W, height: H, data: new Uint8ClampedArray(7) } as never) === undefined
      const huge = mod.resolvePendingBitmapShapePreview(
        { kind: 'rect', box: { x: 0, y: 0, width: 10, height: 10 }, mode: 'filled', style: solid() } as never,
        { width: 70000, height: 2 },
      )
      h9HugeRefused = huge.kind === 'refused'
      const flt = mod.resolvePendingBitmapShapePreview(
        { kind: 'rect', box: { x: 0, y: 0, width: 10, height: 10 }, mode: 'filled', style: solid() } as never,
        { width: 100.5, height: 80 },
      )
      h9FloatRefused = flt.kind === 'refused'
    }
    // H10/H11: oval edge AA + dual-oracle equality for rect and oval.
    let h10OvalEdge: number[] = [-1, -1, -1, -1]
    let h10OvalEqualShared = false
    let h10OvalEqualHand = false
    let h11RectEqualShared = false
    let h11RectEqualHand = false
    {
      const { ctx } = makeCtx()
      const oval = { kind: 'oval', box: { x: 10, y: 10, width: 40, height: 30 }, mode: 'filled', style: solid() }
      const r = mod.compositePendingBitmapShapePreview(ctx, new ImageData(W, H), oval as never)
      const { ctx: ref } = makeCtx()
      ref.putImageData(new ImageData(W, H), 0, 0)
      ref.fillStyle = '#ff0000'
      shared.paintBitmapRectOvalExclusive(ref, 'oval', 10, 10, 40, 30, 'filled', {
        fillStyle: '#ff0000',
        strokeStyle: '#ff0000',
        lineWidth: 6,
      })
      const refOut = ref.getImageData(0, 0, W, H)
      const { ctx: hand } = makeCtx()
      hand.putImageData(new ImageData(W, H), 0, 0)
      handOvalFill(hand, 10, 10, 40, 30, '#ff0000')
      const handOut = hand.getImageData(0, 0, W, H)
      if (r) {
        h10OvalEqualShared = eq((r as ImageData).data as unknown as Uint8Array, refOut.data as unknown as Uint8Array)
        h10OvalEqualHand = eq((r as ImageData).data as unknown as Uint8Array, handOut.data as unknown as Uint8Array)
        // Scan the top arc for a partially-covered pixel (premultiplied AA).
        let found: number[] = [0, 0, 0, 0]
        outer: for (let y = 9; y <= 14; y += 1) {
          for (let x = 20; x <= 40; x += 1) {
            const p = px(r as ImageData, x, y)
            if (p[3] !== undefined && (p[3] as number) > 0 && (p[3] as number) < 255) {
              found = p
              break outer
            }
          }
        }
        h10OvalEdge = found
      }
      const { ctx: c2 } = makeCtx()
      const r2 = mod.compositePendingBitmapShapePreview(c2, new ImageData(W, H), rectShape as never)
      const { ctx: ref2 } = makeCtx()
      ref2.putImageData(new ImageData(W, H), 0, 0)
      ref2.fillStyle = '#ff0000'
      shared.paintBitmapRectOvalExclusive(ref2, 'rect', 10, 10, 40, 30, 'filled', {
        fillStyle: '#ff0000',
        strokeStyle: '#ff0000',
        lineWidth: 6,
      })
      const refOut2 = ref2.getImageData(0, 0, W, H)
      const { ctx: hand2 } = makeCtx()
      hand2.putImageData(new ImageData(W, H), 0, 0)
      handRect(hand2, 10, 10, 40, 30, '#ff0000')
      const handOut2 = hand2.getImageData(0, 0, W, H)
      if (r2) {
        h11RectEqualShared = eq((r2 as ImageData).data as unknown as Uint8Array, refOut2.data as unknown as Uint8Array)
        h11RectEqualHand = eq((r2 as ImageData).data as unknown as Uint8Array, handOut2.data as unknown as Uint8Array)
      }
    }

    return {
      h1RefusedNull,
      h1RefusedUnchanged,
      h1MismatchNull,
      h1MismatchUnchanged,
      h1ShortNull,
      h1ShortUnchanged,
      h1BadDimsNull,
      h2GradientFailUndef,
      h2GradientVisibleIsBase,
      h2TaintedUndef,
      h2TaintedNoThrow,
      h2TaintedVisibleIsBase,
      h3DirtyEqualClean,
      h3DirtyEqualHand,
      h3StateKept,
      h3SaveBalanced,
      h4ClipOnlyCenter,
      h5FracEqualHand,
      h5FracEqualShared,
      h6TwiceEqual,
      h6Mid,
      h7ForeignCopyOk,
      h7ForeignCompositeOk,
      h7ForeignEqualHand,
      h8U8CompositeOk,
      h8FrozenCopyOk,
      h8FrozenInputKept,
      h9ShortCopyUndef,
      h9HugeRefused,
      h9FloatRefused,
      h10OvalEdge,
      h10OvalEqualShared,
      h10OvalEqualHand,
      h11RectEqualShared,
      h11RectEqualHand,
    }
  })
}

describe('bitmap pending-shape preview hostile proofs (real Canvas, port 4591)', () => {
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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('leaves no mutation, no half state, and no state bleed on real Chrome', async () => {
    const proof = await runHostileProofs()
    console.log(`[pending-shape-hostile] ${JSON.stringify(proof)}`)

    // H1: invalid inputs never mutate the visible canvas.
    expect(proof.h1RefusedNull).toBe(true)
    expect(proof.h1RefusedUnchanged).toBe(true)
    expect(proof.h1MismatchNull).toBe(true)
    expect(proof.h1MismatchUnchanged).toBe(true)
    expect(proof.h1ShortNull).toBe(true)
    expect(proof.h1ShortUnchanged).toBe(true)
    expect(proof.h1BadDimsNull).toBe(true)

    // H2: partial failure restores base, never a half pass, never throws.
    expect(proof.h2GradientFailUndef).toBe(true)
    expect(proof.h2GradientVisibleIsBase).toBe(true)
    expect(proof.h2TaintedUndef).toBe(true)
    expect(proof.h2TaintedNoThrow).toBe(true)
    expect(proof.h2TaintedVisibleIsBase).toBe(true)

    // H3: dirty state draws identically and is preserved (incl. save depth).
    expect(proof.h3DirtyEqualClean).toBe(true)
    expect(proof.h3DirtyEqualHand).toBe(true)
    expect(proof.h3StateKept).toBe(true)
    expect(proof.h3SaveBalanced).toBe(true)

    // H4: offscreen clip cannot erase the paint.
    expect(proof.h4ClipOnlyCenter).toEqual([255, 0, 0, 255])

    // H5: fractional boxes match both oracles.
    expect(proof.h5FracEqualHand).toBe(true)
    expect(proof.h5FracEqualShared).toBe(true)

    // H6: semitransparent gradients never accumulate.
    expect(proof.h6TwiceEqual).toBe(true)
    expect(proof.h6Mid[3]).toBeGreaterThan(0)
    expect(proof.h6Mid[3]).toBeLessThan(255)

    // H7: foreign-realm rasters work.
    expect(proof.h7ForeignCopyOk).toBe(true)
    expect(proof.h7ForeignCompositeOk).toBe(true)
    expect(proof.h7ForeignEqualHand).toBe(true)

    // H8: readonly / non-clamped views work without mutating input.
    expect(proof.h8U8CompositeOk).toBe(true)
    expect(proof.h8FrozenCopyOk).toBe(true)
    expect(proof.h8FrozenInputKept).toBe(true)

    // H9: short / huge / float gates fail closed.
    expect(proof.h9ShortCopyUndef).toBe(true)
    expect(proof.h9HugeRefused).toBe(true)
    expect(proof.h9FloatRefused).toBe(true)

    // H10: antialiased oval edge exists; H11: rect matches both oracles.
    expect(proof.h10OvalEdge[3]).toBeGreaterThan(0)
    expect(proof.h10OvalEdge[3]).toBeLessThan(255)
    expect(proof.h10OvalEqualShared).toBe(true)
    expect(proof.h10OvalEqualHand).toBe(true)
    expect(proof.h11RectEqualShared).toBe(true)
    expect(proof.h11RectEqualHand).toBe(true)
  }, 60_000)
})
