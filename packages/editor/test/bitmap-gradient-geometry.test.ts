import { describe, expect, it } from 'bun:test'
import {
  bitmapFillBoundsCenter,
  resolveBitmapFillRadialGeometry,
} from '../src/features/costumes/bitmap-gradient-geometry'

// Radial-gradient geometry for the bitmap fill tool: the highlight follows
// the click seed while the radius follows the fill-region bounds. Real
// Canvas pixel gaps for these cases are locked by
// `bitmap-gradient-geometry.browser.test.ts`.
describe('bitmap fill radial geometry', () => {
  it('centers on the click with radius half the longest side', () => {
    const geometry = resolveBitmapFillRadialGeometry({ x: 1, y: 1, width: 5, height: 3 }, { x: 1, y: 1 })
    expect(geometry).toEqual({ centerX: 1, centerY: 1, radius: 2.5 })
  })

  it('matches the bounds center when the click starts there', () => {
    const bounds = { x: 1, y: 1, width: 5, height: 3 }
    const center = bitmapFillBoundsCenter(bounds)
    expect(center).toEqual({ x: 3.5, y: 2.5 })
    const geometry = resolveBitmapFillRadialGeometry(bounds, { x: 3.5, y: 2.5 })
    expect(geometry).toEqual({ centerX: 3.5, centerY: 2.5, radius: 2.5 })
  })

  it('keeps the radius stable while the center follows off-center clicks', () => {
    const bounds = { x: 1, y: 1, width: 5, height: 3 }
    const corner = resolveBitmapFillRadialGeometry(bounds, { x: 1, y: 1 })
    const edge = resolveBitmapFillRadialGeometry(bounds, { x: 6, y: 4 })
    const inside = resolveBitmapFillRadialGeometry(bounds, { x: 2, y: 3 })
    expect(corner.radius).toBe(2.5)
    expect(edge.radius).toBe(2.5)
    expect(inside.radius).toBe(2.5)
    // The current bounds-centered painter would put every case at (3.5, 2.5);
    // the click-anchored geometry differs by the seed offset.
    expect(corner.centerX).not.toBe(3.5)
    expect(edge.centerX).not.toBe(3.5)
    expect(inside.centerX).not.toBe(3.5)
    expect(Math.hypot(corner.centerX - 3.5, corner.centerY - 2.5)).toBeGreaterThan(2)
  })

  it('sizes the radius from the longest side (wide, tall, square, 1x1)', () => {
    expect(resolveBitmapFillRadialGeometry({ x: 0, y: 0, width: 6, height: 2 }, { x: 3, y: 1 }).radius).toBe(3)
    expect(resolveBitmapFillRadialGeometry({ x: 0, y: 0, width: 2, height: 6 }, { x: 1, y: 3 }).radius).toBe(3)
    expect(resolveBitmapFillRadialGeometry({ x: 0, y: 0, width: 4, height: 4 }, { x: 2, y: 2 }).radius).toBe(2)
    expect(resolveBitmapFillRadialGeometry({ x: 1, y: 1, width: 1, height: 1 }, { x: 1, y: 1 }).radius).toBe(0.5)
  })

  it('falls back to the bounds center for missing or non-finite clicks', () => {
    const bounds = { x: 1, y: 1, width: 5, height: 3 }
    const expected = { centerX: 3.5, centerY: 2.5, radius: 2.5 }
    expect(resolveBitmapFillRadialGeometry(bounds, undefined)).toEqual(expected)
    expect(resolveBitmapFillRadialGeometry(bounds, null)).toEqual(expected)
    expect(resolveBitmapFillRadialGeometry(bounds, { x: Number.NaN, y: 2 })).toEqual(expected)
    expect(resolveBitmapFillRadialGeometry(bounds, { x: 2, y: Number.POSITIVE_INFINITY })).toEqual(expected)
  })

  it('sanitizes degenerate bounds to a zero radius with a finite center', () => {
    expect(resolveBitmapFillRadialGeometry({ x: 0, y: 0, width: 0, height: 0 }, { x: 5, y: 5 })).toEqual({
      centerX: 5,
      centerY: 5,
      radius: 0,
    })
    expect(resolveBitmapFillRadialGeometry({ x: 0, y: 0, width: -4, height: 3 }, undefined)).toEqual({
      centerX: 0,
      centerY: 1.5,
      radius: 1.5,
    })
    const nan = resolveBitmapFillRadialGeometry({ x: Number.NaN, y: 0, width: Number.NaN, height: 2 }, undefined)
    expect(nan.radius).toBe(1)
    expect(Number.isFinite(nan.centerX)).toBe(true)
    expect(Number.isFinite(nan.centerY)).toBe(true)
  })

  it('distinguishes connected and Shift-global selection bounds', () => {
    // Two chambers split by a wall: plain click covers one 2x3 chamber,
    // Shift covers the 5x3 union. The radius and fallback center both move.
    const connected = resolveBitmapFillRadialGeometry({ x: 0, y: 0, width: 2, height: 3 }, { x: 0, y: 1 })
    const global = resolveBitmapFillRadialGeometry({ x: 0, y: 0, width: 5, height: 3 }, { x: 0, y: 1 })
    expect(connected).toEqual({ centerX: 0, centerY: 1, radius: 1.5 })
    expect(global).toEqual({ centerX: 0, centerY: 1, radius: 2.5 })
    expect(global.radius - connected.radius).toBe(1)
    expect(bitmapFillBoundsCenter({ x: 0, y: 0, width: 2, height: 3 })).toEqual({ x: 1, y: 1.5 })
    expect(bitmapFillBoundsCenter({ x: 0, y: 0, width: 5, height: 3 })).toEqual({ x: 2.5, y: 1.5 })
  })
})
