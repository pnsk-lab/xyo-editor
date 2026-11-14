// Pure unit audit of `liveRasterPixelsMatch` (Bun, no browser/DOM).
// Complements the browser audit (`bitmap-live-raster-verify-audit.browser.test.ts`):
// pins transparent-RGB semantics, opaque/gamut boundaries, half-alpha
// reliability, low-alpha perceptual disclosure, and the D4 length gate.
// No numeric claim beyond what the module documents: opaque +-2 passes,
// +-3 refuses; low-alpha straight swaps pass by design (alpha-weighted).
import { describe, expect, it } from 'bun:test'
import { liveRasterPixelsMatch } from '../src/features/costumes/bitmap-live-raster-verify'

const px = (r: number, g: number, b: number, a: number) => new Uint8ClampedArray([r, g, b, a])

describe('liveRasterPixelsMatch unit (transparent / gamut / half-alpha / noise)', () => {
  it('transparent RGB ignored on both sides (transparent-black normalisation)', () => {
    expect(liveRasterPixelsMatch(px(255, 128, 64, 0), px(0, 0, 0, 0))).toEqual({ match: true, sawOpaque: false })
    expect(liveRasterPixelsMatch(px(0, 0, 0, 0), px(255, 255, 255, 0))).toEqual({ match: true, sawOpaque: false })
    // Transparent vs opaque still refuses (alpha exactness, not RGB).
    expect(liveRasterPixelsMatch(px(255, 255, 255, 0), px(255, 255, 255, 1))).toEqual({ match: false, sawOpaque: false })
  })

  it('opaque gamut primaries: exact passes, +-2 passes, +-3 refuses', () => {
    const primaries: Array<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [0, 255, 255],
      [255, 0, 255],
      [13, 37, 101],
    ]
    for (const [r, g, b] of primaries) {
      expect(liveRasterPixelsMatch(px(r, g, b, 255), px(r, g, b, 255))).toEqual({ match: true, sawOpaque: true })
      expect(liveRasterPixelsMatch(px(r, g, b, 255), px(Math.min(255, r + 2), g, b, 255))).toEqual({
        match: true,
        sawOpaque: true,
      })
      expect(liveRasterPixelsMatch(px(r, g, b, 255), px(Math.min(255, r + 3), g, b, 255)).match).toBe(
        r + 3 > 255 ? true : false,
      )
    }
    // Pin the boundary away from the clamp edge.
    expect(liveRasterPixelsMatch(px(100, 100, 100, 255), px(102, 100, 100, 255)).match).toBe(true)
    expect(liveRasterPixelsMatch(px(100, 100, 100, 255), px(103, 100, 100, 255)).match).toBe(false)
  })

  it('half-alpha (128): exact passes; large straight swap refuses (reliable end)', () => {
    expect(liveRasterPixelsMatch(px(200, 40, 90, 128), px(200, 40, 90, 128)) ).toEqual({ match: true, sawOpaque: true })
    // +-2 premul drift passes (engine rounding headroom).
    expect(liveRasterPixelsMatch(px(200, 40, 90, 128), px(202, 40, 90, 128)).match).toBe(true)
    // Full straight swap at half alpha cannot hide in premul space: refuses.
    expect(liveRasterPixelsMatch(px(255, 255, 255, 128), px(0, 0, 0, 128)).match).toBe(false)
    // Alpha itself stays exact at half coverage.
    expect(liveRasterPixelsMatch(px(200, 40, 90, 128), px(200, 40, 90, 129)).match).toBe(false)
  })

  it('low-alpha disclosure: tiny-alpha straight swaps pass by design (perceptual), alpha stays exact', () => {
    // Documented false positive: invisible colour payload differs, ink does not.
    expect(liveRasterPixelsMatch(px(255, 255, 255, 1), px(0, 0, 0, 1)).match).toBe(true)
    expect(liveRasterPixelsMatch(px(255, 0, 0, 2), px(0, 0, 0, 2)).match).toBe(true)
    // Same swap at half/full alpha refuses (gate is real).
    expect(liveRasterPixelsMatch(px(255, 255, 255, 128), px(0, 0, 0, 128)).match).toBe(false)
    expect(liveRasterPixelsMatch(px(255, 255, 255, 255), px(0, 0, 0, 255)).match).toBe(false)
    // Alpha off-by-one at tiny coverage still refuses.
    expect(liveRasterPixelsMatch(px(10, 20, 30, 1), px(10, 20, 30, 2)).match).toBe(false)
  })

  it('D4 length gate: unequal buffers refuse; source opacity still reported', () => {
    expect(liveRasterPixelsMatch(new Uint8ClampedArray([9, 9, 9, 255]), new Uint8ClampedArray([9, 9, 9, 255, 1, 2, 3, 4]))).toEqual({
      match: false,
      sawOpaque: true,
    })
    expect(liveRasterPixelsMatch(new Uint8ClampedArray([0, 0, 0, 0]), new Uint8ClampedArray([0, 0, 0, 0, 9, 9, 9, 255]))).toEqual({
      match: false,
      sawOpaque: false,
    })
    expect(liveRasterPixelsMatch(new Uint8ClampedArray([]), new Uint8ClampedArray([]))).toEqual({ match: true, sawOpaque: false })
  })
})
