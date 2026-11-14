import { describe, expect, it } from 'bun:test'
import {
  bitmapDimensionsFromBytes,
  bitmapUploadIntakeMeta,
  bmpDimensionsFromBytes,
  gifDimensionsFromBytes,
  jpegDimensionsFromBytes,
  libraryCostumeIntakeMeta,
  pngDimensionsFromBytes,
} from '../src/lib/costume-intake'

function pngBytes(width: number, height: number): Uint8Array {
  // Minimal valid PNG: signature + IHDR + IEND (CRC omitted, parser only reads IHDR).
  const out = new Uint8Array(45)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0)
  out[16] = (width >>> 24) & 0xff
  out[17] = (width >>> 16) & 0xff
  out[18] = (width >>> 8) & 0xff
  out[19] = width & 0xff
  out[20] = (height >>> 24) & 0xff
  out[21] = (height >>> 16) & 0xff
  out[22] = (height >>> 8) & 0xff
  out[23] = height & 0xff
  return out
}

describe('costume-intake helper', () => {
  it('respects library PNG metadata (Arctic res2 480,360)', () => {
    const meta = libraryCostumeIntakeMeta(
      { dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 480, rotationCenterY: 360 },
      true,
    )
    expect(meta).toEqual({ bitmapResolution: 2, rotationCenterX: 480, rotationCenterY: 360 })
  })

  it('respects library sprite PNG metadata', () => {
    const meta = libraryCostumeIntakeMeta(
      { dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 174, rotationCenterY: 162 },
      false,
    )
    expect(meta).toEqual({ bitmapResolution: 2, rotationCenterX: 174, rotationCenterY: 162 })
  })

  it('respects library SVG centers instead of forcing stage center', () => {
    const spriteSvg = libraryCostumeIntakeMeta(
      { dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 31, rotationCenterY: 100 },
      false,
    )
    expect(spriteSvg).toEqual({ bitmapResolution: 1, rotationCenterX: 31, rotationCenterY: 100 })
  })

  it('falls back to stage/sprite defaults only when metadata is missing', () => {
    expect(libraryCostumeIntakeMeta({ dataFormat: 'png' }, true)).toEqual({
      bitmapResolution: 2,
      rotationCenterX: 480,
      rotationCenterY: 360,
    })
    expect(libraryCostumeIntakeMeta({ dataFormat: 'svg' }, false)).toEqual({
      bitmapResolution: 1,
      rotationCenterX: 48,
      rotationCenterY: 50,
    })
  })

  it('parses PNG dimensions', () => {
    expect(pngDimensionsFromBytes(pngBytes(960, 720))).toEqual({ width: 960, height: 720 })
    expect(pngDimensionsFromBytes(pngBytes(480, 360))).toEqual({ width: 480, height: 360 })
    expect(pngDimensionsFromBytes(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  it('parses GIF dimensions', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xc0, 0x03, 0x68, 0x01])
    expect(gifDimensionsFromBytes(gif)).toEqual({ width: 960, height: 360 })
  })

  it('parses BMP dimensions', () => {
    const bmp = new Uint8Array(26)
    bmp[0] = 0x42
    bmp[1] = 0x4d
    const view = new DataView(bmp.buffer)
    view.setInt32(18, 480, true)
    view.setInt32(22, 360, true)
    expect(bmpDimensionsFromBytes(bmp)).toEqual({ width: 480, height: 360 })
  })

  it('parses JPEG SOF0 dimensions', () => {
    // SOI + SOF0 (length 11) with height 360, width 480.
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x68, 0x01, 0xe0, 0x01, 0x01, 0x01, 0x11, 0x00])
    expect(jpegDimensionsFromBytes(jpg)).toEqual({ width: 480, height: 360 })
  })

  it('sniffs bitmap dimensions sync-first', () => {
    expect(bitmapDimensionsFromBytes(pngBytes(960, 720))).toEqual({ width: 960, height: 720 })
    expect(bitmapDimensionsFromBytes(new Uint8Array([9, 9, 9]))).toBeUndefined()
  })

  it('resolves upload intake as res2 center middle', async () => {
    const meta = await bitmapUploadIntakeMeta(pngBytes(960, 720))
    expect(meta.bitmapResolution).toBe(2)
    expect(meta.rotationCenterX).toBe(480)
    expect(meta.rotationCenterY).toBe(360)
    const small = await bitmapUploadIntakeMeta(pngBytes(480, 360))
    expect(small.rotationCenterX).toBe(240)
    expect(small.rotationCenterY).toBe(180)
  })
})
