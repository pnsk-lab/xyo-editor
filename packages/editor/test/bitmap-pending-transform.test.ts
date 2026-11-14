import { describe, expect, it } from 'bun:test'
import { createPendingBitmapShape } from '../src/features/costumes/bitmap-pending-shape'
import { rotatePendingBitmapShape } from '../src/features/costumes/bitmap-pending-transform'

const SOLID = {
  fill: '#ff0000',
  secondary: '#ffffff',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 6,
}

const BOUNDS = { width: 960, height: 720 }

describe('rotatePendingBitmapShape (pure 90deg parametric rotation)', () => {
  it('rotates a non-square rect cw about its own center with swapped dimensions', () => {
    // Box 200x100 at (280,260): center (380,310) -> 100x200 at (330,210).
    const pending = createPendingBitmapShape('rect', { x: 280, y: 260, width: 200, height: 100 }, 'filled', SOLID)
    const { pending: next, changed } = rotatePendingBitmapShape(pending, 'cw', BOUNDS)
    expect(changed).toBe(true)
    expect(next.box).toEqual({ x: 330, y: 210, width: 100, height: 200 })
    expect(next.kind).toBe('rect')
    expect(next.mode).toBe('filled')
    // Input untouched (pure box math, raster untouched until commit).
    expect(pending.box).toEqual({ x: 280, y: 260, width: 200, height: 100 })
    expect(next).not.toBe(pending)
  })

  it('cw and ccw share the same swapped box (quarter-turn symmetry)', () => {
    const pending = createPendingBitmapShape('rect', { x: 280, y: 260, width: 200, height: 100 }, 'filled', SOLID)
    const cw = rotatePendingBitmapShape(pending, 'cw', BOUNDS)
    const ccw = rotatePendingBitmapShape(pending, 'ccw', BOUNDS)
    expect(cw.pending.box).toEqual(ccw.pending.box)
    expect(cw.pending.box).toEqual({ x: 330, y: 210, width: 100, height: 200 })
  })

  it('four quarter turns return to the exact original box (even sizes)', () => {
    const pending = createPendingBitmapShape('oval', { x: 100, y: 80, width: 200, height: 100 }, 'outlined', SOLID)
    let current = pending
    for (let i = 0; i < 4; i += 1) {
      const result = rotatePendingBitmapShape(current, 'cw', BOUNDS)
      expect(result.changed).toBe(true)
      current = result.pending
    }
    expect(current.box).toEqual(pending.box)
  })

  it('snaps asymmetric odd sizes to integers (at most 0.5px center drift)', () => {
    // w=101 (odd) -> cx=x+50.5; exact rotated origin x+25.5 rounds to x+26.
    const pending = createPendingBitmapShape('rect', { x: 0, y: 0, width: 101, height: 51 }, 'filled', SOLID)
    const { pending: next, changed } = rotatePendingBitmapShape(pending, 'cw', BOUNDS)
    expect(changed).toBe(true)
    // center (50.5, 25.5), swapped 51x101 -> (round(50.5-25.5), round(25.5-50.5)) = (25, -25).
    expect(next.box).toEqual({ x: 25, y: -25, width: 51, height: 101 })
    expect(Number.isInteger(next.box.x)).toBe(true)
    expect(Number.isInteger(next.box.y)).toBe(true)
    expect(Number.isInteger(next.box.width)).toBe(true)
    expect(Number.isInteger(next.box.height)).toBe(true)
  })

  it('square keeps its box exactly (rotation-symmetric) for solid fills', () => {
    const pending = createPendingBitmapShape('rect', { x: 280, y: 260, width: 100, height: 100 }, 'filled', SOLID)
    const { pending: next, changed } = rotatePendingBitmapShape(pending, 'cw', BOUNDS)
    expect(changed).toBe(false)
    expect(next).toBe(pending)
  })

  it('square with a linear gradient flips kind but keeps stops and colors', () => {
    const pending = createPendingBitmapShape(
      'rect',
      { x: 280, y: 260, width: 100, height: 100 },
      'filled',
      { ...SOLID, gradient: 'horizontal' as const, secondary: '#0000ff' },
    )
    const { pending: next, changed } = rotatePendingBitmapShape(pending, 'cw', BOUNDS)
    expect(changed).toBe(true)
    expect(next.box).toEqual(pending.box)
    expect(next.style.gradient).toBe('vertical')
    expect(next.style.fill).toBe('#ff0000')
    expect(next.style.secondary).toBe('#0000ff')
    expect(pending.style.gradient).toBe('horizontal')
  })

  it('swaps gradient kind on non-square shapes and preserves mode/kind/brush', () => {
    const pending = createPendingBitmapShape(
      'oval',
      { x: 10, y: 20, width: 200, height: 100 },
      'outlined',
      { ...SOLID, gradient: 'vertical' as const, brushSize: 8 },
    )
    const { pending: next } = rotatePendingBitmapShape(pending, 'ccw', BOUNDS)
    expect(next.style.gradient).toBe('horizontal')
    expect(next.kind).toBe('oval')
    expect(next.mode).toBe('outlined')
    expect(next.style.brushSize).toBe(8)
  })

  it('keeps solid and radial gradients as-is', () => {
    const solid = createPendingBitmapShape('rect', { x: 10, y: 20, width: 200, height: 100 }, 'filled', SOLID)
    expect(rotatePendingBitmapShape(solid, 'cw', BOUNDS).pending.style.gradient).toBe('solid')
    const radial = createPendingBitmapShape(
      'rect',
      { x: 10, y: 20, width: 200, height: 100 },
      'filled',
      { ...SOLID, gradient: 'radial' as const },
    )
    expect(rotatePendingBitmapShape(radial, 'cw', BOUNDS).pending.style.gradient).toBe('radial')
  })

  it('clamps a rotated box that would exceed the canvas (no allocation, clip at draw)', () => {
    const pending = createPendingBitmapShape('rect', { x: 10, y: 10, width: 90, height: 70 }, 'filled', SOLID)
    const small = { width: 100, height: 80 }
    const { pending: next, changed } = rotatePendingBitmapShape(pending, 'cw', small)
    expect(changed).toBe(true)
    // Swapped 70x90 exceeds height 80 -> clamped to 70x80, origin clamped into range.
    expect(next.box.width).toBe(70)
    expect(next.box.height).toBe(80)
    expect(next.box.x).toBeLessThanOrEqual(small.width)
    expect(next.box.y).toBeLessThanOrEqual(small.height)
  })

  it('refuses invalid inputs without throwing (same object, unchanged)', () => {
    const pending = createPendingBitmapShape('rect', { x: 10, y: 10, width: 30, height: 20 }, 'filled', SOLID)
    expect(rotatePendingBitmapShape(pending, 'diagonal' as never, BOUNDS).changed).toBe(false)
    expect(rotatePendingBitmapShape(pending, 'diagonal' as never, BOUNDS).pending).toBe(pending)
    expect(rotatePendingBitmapShape(pending, 'cw', { width: 0, height: 80 }).pending).toBe(pending)
    expect(rotatePendingBitmapShape(pending, 'cw', { width: 100.5, height: 80 }).pending).toBe(pending)
    expect(rotatePendingBitmapShape(pending, 'cw', { width: 70000, height: 2 }).pending).toBe(pending)
    expect(rotatePendingBitmapShape(undefined as never, 'cw', BOUNDS).changed).toBe(false)
    expect(rotatePendingBitmapShape({ kind: 'line' } as never, 'cw', BOUNDS).changed).toBe(false)
    const zero = createPendingBitmapShape('rect', { x: 5, y: 5, width: 0, height: 10 }, 'filled', SOLID)
    expect(rotatePendingBitmapShape(zero, 'cw', BOUNDS).changed).toBe(false)
  })

  it('exhaustive direction×kind stop parity: only ccw-h and cw-v reverse (opaque)', () => {
    const base = { ...SOLID, fill: '#ff0000', secondary: '#0000ff', fillTransparent: false, secondaryTransparent: false } as const
    const box = { x: 280, y: 260, width: 200, height: 100 }
    // cw horizontal→vertical: kind swaps, stops kept.
    const cwH = createPendingBitmapShape('rect', box, 'filled', { ...base, gradient: 'horizontal' as const })
    const cwHNext = rotatePendingBitmapShape(cwH, 'cw', BOUNDS).pending
    expect(cwHNext.style.gradient).toBe('vertical')
    expect(cwHNext.style.fill).toBe('#ff0000')
    expect(cwHNext.style.secondary).toBe('#0000ff')
    expect(cwHNext.style.fillTransparent).toBe(false)
    expect(cwHNext.style.secondaryTransparent).toBe(false)
    // ccw horizontal→vertical: kind swaps, stops REVERSED.
    const ccwH = createPendingBitmapShape('rect', box, 'filled', { ...base, gradient: 'horizontal' as const })
    const ccwHNext = rotatePendingBitmapShape(ccwH, 'ccw', BOUNDS).pending
    expect(ccwHNext.style.gradient).toBe('vertical')
    expect(ccwHNext.style.fill).toBe('#0000ff')
    expect(ccwHNext.style.secondary).toBe('#ff0000')
    expect(ccwHNext.style.fillTransparent).toBe(false)
    expect(ccwHNext.style.secondaryTransparent).toBe(false)
    // cw vertical→horizontal: kind swaps, stops REVERSED.
    const cwV = createPendingBitmapShape('rect', box, 'filled', { ...base, gradient: 'vertical' as const })
    const cwVNext = rotatePendingBitmapShape(cwV, 'cw', BOUNDS).pending
    expect(cwVNext.style.gradient).toBe('horizontal')
    expect(cwVNext.style.fill).toBe('#0000ff')
    expect(cwVNext.style.secondary).toBe('#ff0000')
    // ccw vertical→horizontal: kind swaps, stops kept.
    const ccwV = createPendingBitmapShape('rect', box, 'filled', { ...base, gradient: 'vertical' as const })
    const ccwVNext = rotatePendingBitmapShape(ccwV, 'ccw', BOUNDS).pending
    expect(ccwVNext.style.gradient).toBe('horizontal')
    expect(ccwVNext.style.fill).toBe('#ff0000')
    expect(ccwVNext.style.secondary).toBe('#0000ff')
    // Square boxes share the same four stop rules (box unchanged, style changes).
    const square = { x: 100, y: 100, width: 60, height: 60 }
    const sqCwH = rotatePendingBitmapShape(
      createPendingBitmapShape('rect', square, 'filled', { ...base, gradient: 'horizontal' as const }),
      'cw',
      BOUNDS,
    ).pending
    expect(sqCwH.box).toEqual(square)
    expect(sqCwH.style.gradient).toBe('vertical')
    expect([sqCwH.style.fill, sqCwH.style.secondary]).toEqual(['#ff0000', '#0000ff'])
    const sqCcwH = rotatePendingBitmapShape(
      createPendingBitmapShape('rect', square, 'filled', { ...base, gradient: 'horizontal' as const }),
      'ccw',
      BOUNDS,
    ).pending
    expect(sqCcwH.box).toEqual(square)
    expect(sqCcwH.style.gradient).toBe('vertical')
    expect([sqCcwH.style.fill, sqCcwH.style.secondary]).toEqual(['#0000ff', '#ff0000'])
  })

  it('reversed stops travel with their transparent flags (no lossy hex restore)', () => {
    const box = { x: 40, y: 30, width: 120, height: 80 }
    // Transparent primary, opaque secondary: reversal must swap flags with hex.
    const style = {
      ...SOLID,
      gradient: 'horizontal' as const,
      fill: '#ff0000',
      secondary: '#0000ff',
      fillTransparent: true,
      secondaryTransparent: false,
    }
    const ccw = rotatePendingBitmapShape(createPendingBitmapShape('rect', box, 'filled', style), 'ccw', BOUNDS).pending
    expect(ccw.style.gradient).toBe('vertical')
    expect(ccw.style.fill).toBe('#0000ff')
    expect(ccw.style.secondary).toBe('#ff0000')
    expect(ccw.style.fillTransparent).toBe(false)
    expect(ccw.style.secondaryTransparent).toBe(true)
    // Stored hex survives the round trip (untoggle restores the same hex).
    const back = rotatePendingBitmapShape(ccw, 'cw', BOUNDS).pending
    expect(back.style.gradient).toBe('horizontal')
    expect(back.style.fill).toBe('#ff0000')
    expect(back.style.secondary).toBe('#0000ff')
    expect(back.style.fillTransparent).toBe(true)
    expect(back.style.secondaryTransparent).toBe(false)
    // Opaque primary, transparent secondary on the other reversing leg.
    const styleV = { ...style, gradient: 'vertical' as const, fillTransparent: false, secondaryTransparent: true }
    const cw = rotatePendingBitmapShape(createPendingBitmapShape('rect', box, 'filled', styleV), 'cw', BOUNDS).pending
    expect(cw.style.gradient).toBe('horizontal')
    expect(cw.style.fill).toBe('#0000ff')
    expect(cw.style.secondary).toBe('#ff0000')
    expect(cw.style.fillTransparent).toBe(true)
    expect(cw.style.secondaryTransparent).toBe(false)
    // Non-reversing legs keep flags in place.
    const kept = rotatePendingBitmapShape(createPendingBitmapShape('rect', box, 'filled', style), 'cw', BOUNDS).pending
    expect(kept.style.fillTransparent).toBe(true)
    expect(kept.style.secondaryTransparent).toBe(false)
    expect(kept.style.fill).toBe('#ff0000')
  })

  it('four quarter turns are the identity (box + kind + stops + flags), cw and ccw', () => {
    const box = { x: 50, y: 40, width: 200, height: 100 }
    for (const gradient of ['horizontal', 'vertical'] as const) {
      for (const transparent of [
        { fillTransparent: false, secondaryTransparent: false },
        { fillTransparent: true, secondaryTransparent: false },
        { fillTransparent: false, secondaryTransparent: true },
      ]) {
        const start = createPendingBitmapShape('rect', box, 'outlined', {
          ...SOLID,
          gradient,
          fill: '#ff0000',
          secondary: '#0000ff',
          brushSize: 7,
          ...transparent,
        })
        let cw = start
        for (let i = 0; i < 4; i += 1) cw = rotatePendingBitmapShape(cw, 'cw', BOUNDS).pending
        expect(cw.box).toEqual(start.box)
        expect(cw.style).toEqual(start.style)
        let ccw = start
        for (let i = 0; i < 4; i += 1) ccw = rotatePendingBitmapShape(ccw, 'ccw', BOUNDS).pending
        expect(ccw.box).toEqual(start.box)
        expect(ccw.style).toEqual(start.style)
        // Inverse pairs return immediately.
        const oneCw = rotatePendingBitmapShape(start, 'cw', BOUNDS).pending
        expect(rotatePendingBitmapShape(oneCw, 'ccw', BOUNDS).pending.style).toEqual(start.style)
        expect(rotatePendingBitmapShape(oneCw, 'ccw', BOUNDS).pending.box).toEqual(start.box)
        const oneCcw = rotatePendingBitmapShape(start, 'ccw', BOUNDS).pending
        expect(rotatePendingBitmapShape(oneCcw, 'cw', BOUNDS).pending.style).toEqual(start.style)
      }
    }
  })

  it('preserves kind/mode/brush and never emits NaNs; odd/even + res1/res2 share the math', () => {
    const even = createPendingBitmapShape(
      'oval',
      { x: 20, y: 10, width: 200, height: 100 },
      'outlined',
      { ...SOLID, gradient: 'vertical' as const, fill: '#ff0000', secondary: '#0000ff', brushSize: 8 },
    )
    for (const dir of ['cw', 'ccw'] as const) {
      const next = rotatePendingBitmapShape(even, dir, BOUNDS).pending
      expect(next.kind).toBe('oval')
      expect(next.mode).toBe('outlined')
      expect(next.style.brushSize).toBe(8)
      for (const v of [next.box.x, next.box.y, next.box.width, next.box.height]) {
        expect(Number.isFinite(v)).toBe(true)
        expect(Number.isNaN(v)).toBe(false)
      }
    }
    // Odd dimensions snap to integers (at most 0.5px drift), no NaNs.
    const odd = createPendingBitmapShape('rect', { x: 7, y: 3, width: 101, height: 51 }, 'filled', {
      ...SOLID,
      gradient: 'horizontal' as const,
      fill: '#ff0000',
      secondary: '#0000ff',
    })
    const oddNext = rotatePendingBitmapShape(odd, 'ccw', BOUNDS).pending
    expect(Number.isInteger(oddNext.box.x)).toBe(true)
    expect(Number.isInteger(oddNext.box.y)).toBe(true)
    expect(oddNext.style.gradient).toBe('vertical')
    expect([oddNext.style.fill, oddNext.style.secondary]).toEqual(['#0000ff', '#ff0000'])
    // res1 (480x360) and res2 (960x720) agree on box+style for the same shape.
    const shape = { x: 100, y: 80, width: 160, height: 90 }
    const style = { ...SOLID, gradient: 'vertical' as const, fill: '#ff0000', secondary: '#0000ff' }
    const res1 = rotatePendingBitmapShape(createPendingBitmapShape('rect', shape, 'filled', style), 'cw', { width: 480, height: 360 })
    const res2 = rotatePendingBitmapShape(createPendingBitmapShape('rect', shape, 'filled', style), 'cw', { width: 960, height: 720 })
    expect(res1.pending.box).toEqual(res2.pending.box)
    expect(res1.pending.style).toEqual(res2.pending.style)
    // Outside clipping keeps the reversal and never allocates.
    const clipped = rotatePendingBitmapShape(
      createPendingBitmapShape('rect', { x: 10, y: 10, width: 90, height: 70 }, 'filled', {
        ...SOLID,
        gradient: 'vertical' as const,
        fill: '#ff0000',
        secondary: '#0000ff',
      }),
      'cw',
      { width: 100, height: 80 },
    ).pending
    expect(clipped.style.gradient).toBe('horizontal')
    expect([clipped.style.fill, clipped.style.secondary]).toEqual(['#0000ff', '#ff0000'])
    expect(clipped.box.width).toBeLessThanOrEqual(100)
    expect(clipped.box.height).toBeLessThanOrEqual(80)
  })

  it('solid/radial never swap or reverse; square solid stays a same-object no-op (backwards API)', () => {
    const box = { x: 10, y: 20, width: 200, height: 100 }
    for (const dir of ['cw', 'ccw'] as const) {
      const solid = rotatePendingBitmapShape(createPendingBitmapShape('rect', box, 'filled', SOLID), dir, BOUNDS).pending
      expect(solid.style.gradient).toBe('solid')
      expect(solid.style.fill).toBe(SOLID.fill)
      expect(solid.style.secondary).toBe(SOLID.secondary)
      expect(solid.style.fillTransparent).toBe(false)
      const radial = rotatePendingBitmapShape(
        createPendingBitmapShape('rect', box, 'filled', { ...SOLID, gradient: 'radial' as const, secondary: '#0000ff' }),
        dir,
        BOUNDS,
      ).pending
      expect(radial.style.gradient).toBe('radial')
      expect(radial.style.fill).toBe(SOLID.fill)
      expect(radial.style.secondary).toBe('#0000ff')
    }
    const squareSolid = createPendingBitmapShape('rect', { x: 5, y: 5, width: 40, height: 40 }, 'filled', SOLID)
    const noop = rotatePendingBitmapShape(squareSolid, 'cw', BOUNDS)
    expect(noop.changed).toBe(false)
    expect(noop.pending).toBe(squareSolid)
    // NaN/Infinity inputs fail closed with the same object, never NaN out.
    // (Bypass createPendingBitmapShape: it normalizes NaN to 0 by design.)
    const nanPending = {
      kind: 'rect',
      box: { x: Number.NaN, y: 0, width: 30, height: 20 },
      mode: 'filled',
      style: { ...SOLID },
    } as never
    const nanResult = rotatePendingBitmapShape(nanPending, 'cw', BOUNDS)
    expect(nanResult.changed).toBe(false)
    expect(nanResult.pending).toBe(nanPending)
    const infPending = {
      kind: 'rect',
      box: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 20 },
      mode: 'filled',
      style: { ...SOLID },
    } as never
    expect(rotatePendingBitmapShape(infPending, 'cw', BOUNDS).changed).toBe(false)
  })
})
