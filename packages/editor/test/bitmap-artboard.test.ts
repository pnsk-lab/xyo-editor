// Product-helper pin for the bitmap artboard model (imports the helper).
import { describe, expect, it } from 'bun:test'
import {
  artboardForTarget,
  BITMAP_SOURCE_MAX_SIDE,
  bytesEqual,
  croppedSaveForTrim,
  emptyArtboardCanvas,
  isBitmapRasterRefused,
  isBitmapSourceSizeRefused,
  opaqueTrimFromRgba,
  placeSourceOnArtboard,
} from '../src/features/costumes/bitmap-artboard'

describe('bitmap-artboard helper (product)', () => {
  it('sprite artboard is 960x720 res2 center 480,360; stage 480x360 res1 center 240,180', () => {
    expect(artboardForTarget(false)).toEqual({ width: 960, height: 720, resolution: 2, centerX: 480, centerY: 360 })
    expect(artboardForTarget(true)).toEqual({ width: 480, height: 360, resolution: 1, centerX: 240, centerY: 180 })
  })

  it('190x200 @96,96 lands at 384,264 on the sprite artboard', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    expect(placed.width).toBe(960)
    expect(placed.height).toBe(720)
    expect(placed.originX).toBe(384)
    expect(placed.originY).toBe(264)
    expect(placed.canvasCenterX).toBe(480)
    expect(placed.canvasCenterY).toBe(360)
    expect(placed.limited).toBe(false)
  })

  it('60x40 @48,48 and res1 96x96 @48,48 land at 432,312', () => {
    expect(placeSourceOnArtboard(60, 40, 48, 48, false).originX).toBe(432)
    expect(placeSourceOnArtboard(60, 40, 48, 48, false).originY).toBe(312)
    expect(placeSourceOnArtboard(96, 96, 48, 48, false).originX).toBe(432)
  })

  it('huge legacy source expands to the union (world-stable)', () => {
    const placed = placeSourceOnArtboard(2400, 1800, 48, 50, false)
    expect(placed.width).toBe(2832)
    expect(placed.height).toBe(2110)
    expect(placed.originX).toBe(432)
    expect(placed.limited).toBe(false)
  })

  it('res1 sprite 100x80 @20,60 edits on the 480x360 res1 artboard (resolution preserved)', () => {
    const placed = placeSourceOnArtboard(100, 80, 20, 60, false, 1)
    expect(placed.resolution).toBe(1)
    expect(placed.width).toBe(480)
    expect(placed.height).toBe(360)
    expect(placed.originX).toBe(220)
    expect(placed.originY).toBe(120)
    expect(placed.canvasCenterX).toBe(240)
    expect(placed.canvasCenterY).toBe(180)
    expect(placed.limited).toBe(false)
    expect(placed.refused).toBe(false)
    const saved = croppedSaveForTrim({ x: placed.originX, y: placed.originY, width: 100, height: 80 }, placed.canvasCenterX, placed.canvasCenterY, false, 1)
    expect(saved).toEqual({ width: 100, height: 80, rotationCenterX: 20, rotationCenterY: 60, bitmapResolution: 1 })
  })

  it('5000x12 res2 source keeps every pixel via the verbatim fallback (no 4096 clamp)', () => {
    const placed = placeSourceOnArtboard(5000, 12, 2500, 6, false, 2)
    expect(placed.resolution).toBe(2)
    expect(placed.limited).toBe(true)
    expect(placed.refused).toBe(false)
    expect(placed.width).toBe(5000)
    expect(placed.height).toBe(12)
    expect(placed.originX).toBe(0)
    expect(placed.originY).toBe(0)
    const saved = croppedSaveForTrim({ x: 0, y: 0, width: 5000, height: 12 }, placed.canvasCenterX, placed.canvasCenterY, false, 2)
    expect(saved.bitmapResolution).toBe(2)
    expect(saved.rotationCenterX).toBe(2500)
    expect(saved.rotationCenterY).toBe(6)
  })

  it('area-over-budget sources are refused (never truncated, never allocated)', () => {
    const placed = placeSourceOnArtboard(8000, 8000, 4000, 4000, false)
    expect(placed.limited).toBe(true)
    expect(placed.refused).toBe(true)
    // Full source rect is reported (no silent pixel loss) so the caller can
    // reject explicitly instead of persisting a clamped asset.
    expect(placed.width).toBe(8000)
    expect(placed.height).toBe(8000)
  })

  it('extreme sides: 32768x2 and 65535x2 stay editable, 65536x2 and 100000x2 are refused', () => {
    expect(BITMAP_SOURCE_MAX_SIDE).toBe(65535)
    for (const w of [32768, 65535]) {
      const placed = placeSourceOnArtboard(w, 2, w / 2, 1, false, 2)
      expect(placed.refused).toBe(false)
      expect(placed.width).toBe(w)
      expect(placed.height).toBe(2)
      expect(isBitmapSourceSizeRefused(w, 2)).toBe(false)
    }
    for (const w of [65536, 100000]) {
      expect(isBitmapSourceSizeRefused(w, 2)).toBe(true)
      const placed = placeSourceOnArtboard(w, 2, w / 2, 1, false, 2)
      expect(placed.refused).toBe(true)
      // Full source rect is still reported (never truncated) so the editor
      // rejects explicitly with the stored bytes untouched.
      expect(placed.width).toBe(w)
      expect(placed.height).toBe(2)
    }
  })

  it('isBitmapSourceSizeRefused rejects non-positive/NaN dims and over-area sources', () => {
    expect(isBitmapSourceSizeRefused(0, 10)).toBe(true)
    expect(isBitmapSourceSizeRefused(NaN, 10)).toBe(true)
    expect(isBitmapSourceSizeRefused(8000, 8000)).toBe(true)
    expect(isBitmapSourceSizeRefused(5000, 12)).toBe(false)
    expect(isBitmapSourceSizeRefused(960, 720)).toBe(false)
  })

  it('isBitmapRasterRefused fails closed on blank live raster over stored ink', () => {
    const base = { width: 65536, height: 2, readbackWidth: 65536, readbackHeight: 2, readable: true, sourceHasOpaque: true, liveHasOpaque: false }
    // Over-cap size alone refuses, even before looking at the raster.
    expect(isBitmapRasterRefused({ ...base, sourceHasOpaque: false, liveHasOpaque: false })).toBe(true)
    // Under-cap blank live over stored ink (silent-blank raster) refuses.
    expect(isBitmapRasterRefused({ width: 960, height: 720, readbackWidth: 960, readbackHeight: 720, readable: true, sourceHasOpaque: true, liveHasOpaque: false })).toBe(true)
    // Genuinely transparent sources stay convertible (empty round-trip).
    expect(isBitmapRasterRefused({ width: 960, height: 720, readbackWidth: 960, readbackHeight: 720, readable: true, sourceHasOpaque: false, liveHasOpaque: false })).toBe(false)
    // Healthy raster with ink passes.
    expect(isBitmapRasterRefused({ width: 960, height: 720, readbackWidth: 960, readbackHeight: 720, readable: true, sourceHasOpaque: true, liveHasOpaque: true, encodeOk: true })).toBe(false)
    // Unreadable raster, dims mismatch, or failed encode all refuse.
    expect(isBitmapRasterRefused({ width: 960, height: 720, readable: false, sourceHasOpaque: false, liveHasOpaque: false })).toBe(true)
    expect(isBitmapRasterRefused({ width: 960, height: 720, readbackWidth: 960, readbackHeight: 719, readable: true, sourceHasOpaque: false, liveHasOpaque: false })).toBe(true)
    expect(isBitmapRasterRefused({ width: 960, height: 720, readbackWidth: 960, readbackHeight: 720, readable: true, sourceHasOpaque: false, liveHasOpaque: false, encodeOk: false })).toBe(true)
  })

  it('empty canvas is the bare artboard', () => {
    const empty = emptyArtboardCanvas(false)
    expect(empty.width).toBe(960)
    expect(empty.height).toBe(720)
    expect(emptyArtboardCanvas(true).width).toBe(480)
  })

  it('unedited placement crops back to itself with the same center', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    const saved = croppedSaveForTrim({ x: placed.originX, y: placed.originY, width: 190, height: 200 }, placed.canvasCenterX, placed.canvasCenterY, false)
    expect(saved).toEqual({ width: 190, height: 200, rotationCenterX: 96, rotationCenterY: 96, bitmapResolution: 2 })
  })

  it('crop round-trips through reload', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    const trim = { x: placed.originX - 32, y: placed.originY - 12, width: 222, height: 212 }
    const saved = croppedSaveForTrim(trim, placed.canvasCenterX, placed.canvasCenterY, false)
    const reloaded = placeSourceOnArtboard(saved.width, saved.height, saved.rotationCenterX, saved.rotationCenterY, false)
    expect(reloaded.originX).toBe(trim.x)
    expect(reloaded.originY).toBe(trim.y)
  })

  it('opaque trim counts semitransparent alpha as content', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4)
    data[0 * 4 + 3] = 10 // semitransparent corner
    data[(3 * 4 + 3) * 4 + 3] = 255
    const trim = opaqueTrimFromRgba(data, 4, 4)
    expect(trim).toEqual({ x: 0, y: 0, width: 4, height: 4 })
    expect(opaqueTrimFromRgba(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeUndefined()
  })

  it('bytesEqual guards the idempotent Save', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
  })
})
