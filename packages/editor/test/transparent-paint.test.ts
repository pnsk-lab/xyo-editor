import { describe, expect, it } from 'bun:test'
import { floodFillBitmap } from '../src/features/costumes/bitmap-fill'
import {
  fillPaintInput,
  hexToPaintRgba,
  isBitmapPaintNoop,
  isFillInvisible,
  previewGradientEndCss,
  resolveBitmapGradientStops,
  resolveBitmapSolidFill,
  resolveEyedropperPixel,
  resolveVectorFillPaint,
  resolveVectorStroke,
  secondaryPaintInput,
} from '../src/features/costumes/transparent-paint'

// Transparent (`null`) fill/stroke mapping for Scratch Paint parity: the hex
// picker values are preserved while a toggle is on, so untoggling restores
// the previous opaque color.
describe('transparent-paint toggle model', () => {
  it('parses picker hex and maps toggles to null without losing the hex', () => {
    expect(hexToPaintRgba('#ffab19')).toEqual({ r: 255, g: 171, b: 25, a: 255 })
    expect(fillPaintInput(false, '#ffab19')).toEqual({ r: 255, g: 171, b: 25, a: 255 })
    expect(fillPaintInput(true, '#ffab19')).toBe(null)
    expect(secondaryPaintInput(false, '#ffffff')).toEqual({ r: 255, g: 255, b: 255, a: 255 })
    expect(secondaryPaintInput(true, '#ffffff')).toBe(null)
    expect(resolveVectorStroke(false, '#0f172a')).toBe('#0f172a')
    expect(resolveVectorStroke(true, '#0f172a')).toBe('none')
  })

  it('emits SVG none for a transparent solid vector fill', () => {
    const paint = resolveVectorFillPaint({
      fillTransparent: true,
      fillHex: '#ffab19',
      secondaryTransparent: false,
      secondaryHex: '#ffffff',
      gradient: 'solid',
      width: 480,
      height: 360,
      id: 't1',
    })
    expect(paint).toEqual({ defs: '', fill: 'none' })
    const opaque = resolveVectorFillPaint({
      fillTransparent: false,
      fillHex: '#ffab19',
      secondaryTransparent: false,
      secondaryHex: '#ffffff',
      gradient: 'solid',
      width: 480,
      height: 360,
      id: 't1',
    })
    // Untoggling restores the exact previous color (no reset to a default).
    expect(opaque).toEqual({ defs: '', fill: '#ffab19' })
  })

  it('fades only opacity when exactly one gradient end is transparent', () => {
    for (const gradient of ['horizontal', 'vertical', 'radial'] as const) {
      const paint = resolveVectorFillPaint({
        fillTransparent: false,
        fillHex: '#ff0000',
        secondaryTransparent: true,
        secondaryHex: '#0000ff',
        gradient,
        width: 480,
        height: 360,
        id: 'g1',
      })
      expect(paint.fill).toBe('url(#g1)')
      // The surviving red RGB is reused with alpha 0: no blue, no black swing.
      expect(paint.defs).toContain('stop-color="#ff0000"')
      expect(paint.defs).toContain('stop-opacity="0"')
      expect(paint.defs).not.toContain('#0000ff')
      expect(paint.defs).not.toContain('#000000')
    }
    const flipped = resolveVectorFillPaint({
      fillTransparent: true,
      fillHex: '#ff0000',
      secondaryTransparent: false,
      secondaryHex: '#0000ff',
      gradient: 'horizontal',
      width: 480,
      height: 360,
      id: 'g2',
    })
    expect(flipped.defs).toContain('stop-color="#0000ff"')
    expect(flipped.defs).toContain('stop-opacity="0"')
  })

  it('keeps both-transparent gradients fully transparent', () => {
    const paint = resolveVectorFillPaint({
      fillTransparent: true,
      fillHex: '#ff0000',
      secondaryTransparent: true,
      secondaryHex: '#0000ff',
      gradient: 'horizontal',
      width: 480,
      height: 360,
      id: 'g3',
    })
    expect(paint.fill).toBe('url(#g3)')
    expect(paint.defs).toContain('stop-opacity="0"')
  })

  it('is deterministic for the same id and toggle state', () => {
    const options = {
      fillTransparent: false,
      fillHex: '#ff0000',
      secondaryTransparent: true,
      secondaryHex: '#0000ff',
      gradient: 'horizontal' as const,
      width: 480,
      height: 360,
      id: 'stable',
    }
    expect(resolveVectorFillPaint(options)).toEqual(resolveVectorFillPaint({ ...options }))
  })
})

describe('transparent-paint bitmap mapping', () => {
  it('paints alpha 0 for a transparent solid flood fill (erase)', () => {
    expect(resolveBitmapSolidFill(true, '#ffab19')).toEqual([0, 0, 0, 0])
    expect(resolveBitmapSolidFill(false, '#ffab19')).toEqual([255, 171, 25, 255])
    const data = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255])
    const image = { width: 2, height: 2, data }
    const [r, g, b, a] = resolveBitmapSolidFill(true, '#ffab19')
    const result = floodFillBitmap(image, 0, 0, [r, g, b, a])
    expect(result.changed).toBe(true)
    expect([...result.image.data.slice(0, 4)]).toEqual([0, 0, 0, 0])
    // Filling an already-transparent region with transparent is a no-op that
    // must skip save/history.
    const again = floodFillBitmap(result.image, 0, 0, [r, g, b, a])
    expect(again.changed).toBe(false)
  })

  it('emits alpha-preserving canvas stops for transparent gradient ends', () => {
    const [from, to] = resolveBitmapGradientStops(false, '#ff0000', true, '#0000ff')
    expect(from).toEqual({ offset: 0, css: '#ff0000' })
    expect(to.offset).toBe(1)
    expect(to.css).toContain('rgba(255, 0, 0, 0)')
    expect(to.css).not.toContain('rgba(0, 0, 0')
  })

  it('maps eyedropper pixels to transparent without touching the stored hex', () => {
    expect(resolveEyedropperPixel({ r: 0, g: 0, b: 0, a: 0 })).toEqual({ transparent: true })
    expect(resolveEyedropperPixel({ r: 255, g: 0, b: 0, a: 255 })).toEqual({ transparent: false, hex: '#ff0000' })
  })

  it('previews gradient ends with RGB-matched transparency', () => {
    const stops = previewGradientEndCss(false, '#ff0000', true, '#0000ff')
    expect(stops.from).toBe('#ff0000')
    expect(stops.to).toContain('rgba(255, 0, 0, 0)')
  })
})

describe('transparent-paint no-op guards', () => {
  it('detects invisible fills', () => {
    expect(isFillInvisible(true, false, 'solid')).toBe(true)
    expect(isFillInvisible(false, false, 'solid')).toBe(false)
    expect(isFillInvisible(true, true, 'horizontal')).toBe(true)
    expect(isFillInvisible(true, false, 'horizontal')).toBe(false)
  })

  it('skips history for bitmap gestures that paint nothing', () => {
    const transparent = { fillTransparent: true, secondaryTransparent: false, strokeTransparent: false }
    expect(isBitmapPaintNoop('brush', transparent, 'solid')).toBe(true)
    expect(isBitmapPaintNoop('line', transparent, 'solid')).toBe(true)
    // Hollow shapes (transparent fill + opaque stroke) still paint.
    expect(isBitmapPaintNoop('rect', transparent, 'solid')).toBe(false)
    expect(isBitmapPaintNoop('oval', transparent, 'solid')).toBe(false)
    expect(isBitmapPaintNoop('text', transparent, 'solid')).toBe(false)
    const allTransparent = { fillTransparent: true, secondaryTransparent: false, strokeTransparent: true }
    expect(isBitmapPaintNoop('rect', allTransparent, 'solid')).toBe(true)
    expect(isBitmapPaintNoop('text', allTransparent, 'solid')).toBe(true)
    const opaque = { fillTransparent: false, secondaryTransparent: false, strokeTransparent: false }
    expect(isBitmapPaintNoop('brush', opaque, 'solid')).toBe(false)
    expect(isBitmapPaintNoop('rect', opaque, 'solid')).toBe(false)
  })
})
