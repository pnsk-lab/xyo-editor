import { describe, expect, it } from 'bun:test'
import {
  PAINT_MIXED,
  canvasGradientStops,
  commonPaintColor,
  eyeDropperPaint,
  interpolatePaintRgba,
  isMixedPaint,
  isTransparentPaint,
  paintToCss,
  paintToSvgPaint,
  parseHexPaintRgba,
  parsePaintColor,
  resolveGradientEndpoints,
  sampleGradientColor,
  svgGradientPaint,
  transparentMatchFor,
} from '../src/features/costumes/paint-colors'

describe('paint-colors transparent model', () => {
  it('treats null as transparent and MIXED as mixed', () => {
    expect(isTransparentPaint(null)).toBe(true)
    expect(isTransparentPaint({ r: 255, g: 0, b: 0, a: 255 })).toBe(false)
    expect(isMixedPaint(PAINT_MIXED)).toBe(true)
    expect(isMixedPaint(null)).toBe(false)
    expect(paintToCss(null)).toBe('transparent')
    expect(paintToSvgPaint(null)).toBe('none')
  })

  it('reduces selections to a common color or MIXED', () => {
    expect(commonPaintColor([])).toBe(PAINT_MIXED)
    expect(commonPaintColor([null, null])).toBe(null)
    expect(
      commonPaintColor([
        { r: 255, g: 0, b: 0, a: 255 },
        { r: 255, g: 0, b: 0, a: 255 },
      ]),
    ).toEqual({ r: 255, g: 0, b: 0, a: 255 })
    expect(
      commonPaintColor([{ r: 255, g: 0, b: 0, a: 255 }, null]),
    ).toBe(PAINT_MIXED)
    expect(
      commonPaintColor([
        { r: 255, g: 0, b: 0, a: 255 },
        { r: 0, g: 0, b: 255, a: 255 },
      ]),
    ).toBe(PAINT_MIXED)
  })

  it('parses hex and css paints, keeping transparent distinct from unknown', () => {
    expect(parsePaintColor(null)).toBe(null)
    expect(parsePaintColor('transparent')).toBe(null)
    expect(parsePaintColor('none')).toBe(null)
    expect(parsePaintColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 255 })
    expect(parsePaintColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 })
    expect(parsePaintColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 128 })
    expect(parseHexPaintRgba('#zzz')).toBe(undefined)
    expect(parsePaintColor('not-a-color')).toBe(undefined)
  })

  it('serializes opaque as hex and translucent as rgba', () => {
    expect(paintToCss({ r: 255, g: 171, b: 25, a: 255 })).toBe('#ffab19')
    expect(paintToCss({ r: 255, g: 0, b: 0, a: 128 })).toBe('rgba(255, 0, 0, 0.502)')
    expect(paintToSvgPaint({ r: 255, g: 0, b: 0, a: 255 })).toBe('#ff0000')
  })
})

describe('paint-colors gradient interpolation', () => {
  it('interpolates every channel linearly with clamped t', () => {
    expect(
      interpolatePaintRgba(
        { r: 0, g: 0, b: 0, a: 255 },
        { r: 255, g: 255, b: 255, a: 255 },
        0.5,
      ),
    ).toEqual({ r: 128, g: 128, b: 128, a: 255 })
    expect(
      interpolatePaintRgba(
        { r: 255, g: 0, b: 0, a: 255 },
        { r: 255, g: 0, b: 0, a: 0 },
        0.5,
      ),
    ).toEqual({ r: 255, g: 0, b: 0, a: 128 })
    // Clamped endpoints.
    expect(
      interpolatePaintRgba({ r: 10, g: 20, b: 30, a: 40 }, { r: 200, g: 200, b: 200, a: 200 }, -1),
    ).toEqual({ r: 10, g: 20, b: 30, a: 40 })
    expect(
      interpolatePaintRgba({ r: 10, g: 20, b: 30, a: 40 }, { r: 200, g: 200, b: 200, a: 200 }, 2),
    ).toEqual({ r: 200, g: 200, b: 200, a: 200 })
  })

  it('matches transparent to the surviving endpoint RGB (no black swing)', () => {
    expect(transparentMatchFor({ r: 255, g: 171, b: 25 })).toEqual({ r: 255, g: 171, b: 25, a: 0 })
    const resolved = resolveGradientEndpoints({ r: 255, g: 0, b: 0, a: 255 }, null)
    expect(resolved).toEqual({
      from: { r: 255, g: 0, b: 0, a: 255 },
      to: { r: 255, g: 0, b: 0, a: 0 },
    })
    const flipped = resolveGradientEndpoints(null, { r: 0, g: 0, b: 255, a: 255 })
    expect(flipped.from).toEqual({ r: 0, g: 0, b: 255, a: 0 })
    // Midpoint fades only alpha, hue stays red.
    const mid = interpolatePaintRgba(resolved.from, resolved.to, 0.5)
    expect(mid).toEqual({ r: 255, g: 0, b: 0, a: 128 })
    expect(resolveGradientEndpoints(null, null)).toEqual({
      from: { r: 0, g: 0, b: 0, a: 0 },
      to: { r: 0, g: 0, b: 0, a: 0 },
    })
  })

  it('samples solid/linear/radial gradients inside bounds', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 50 }
    const red = { r: 255, g: 0, b: 0, a: 255 }
    const blue = { r: 0, g: 0, b: 255, a: 255 }
    expect(sampleGradientColor({ kind: 'solid', primary: red, secondary: blue, bounds, point: { x: 99, y: 49 } })).toEqual(red)
    expect(sampleGradientColor({ kind: 'solid', primary: null, secondary: blue, bounds, point: { x: 0, y: 0 } })).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 0,
    })
    expect(
      sampleGradientColor({ kind: 'horizontal', primary: red, secondary: blue, bounds, point: { x: 50, y: 0 } }),
    ).toEqual({ r: 128, g: 0, b: 128, a: 255 })
    expect(
      sampleGradientColor({ kind: 'vertical', primary: red, secondary: blue, bounds, point: { x: 0, y: 25 } }),
    ).toEqual({ r: 128, g: 0, b: 128, a: 255 })
    // Clamped outside.
    expect(
      sampleGradientColor({ kind: 'horizontal', primary: red, secondary: blue, bounds, point: { x: -10, y: 0 } }),
    ).toEqual(red)
    // Radial: center is primary, rim is secondary.
    expect(
      sampleGradientColor({ kind: 'radial', primary: red, secondary: blue, bounds, point: { x: 50, y: 25 } }),
    ).toEqual(red)
    expect(
      sampleGradientColor({ kind: 'radial', primary: red, secondary: blue, bounds, point: { x: 100, y: 25 } }),
    ).toEqual(blue)
  })

  it('emits canvas stops that preserve alpha', () => {
    const [from, to] = canvasGradientStops({ r: 255, g: 0, b: 0, a: 255 }, null)
    expect(from).toEqual({ offset: 0, css: '#ff0000' })
    expect(to.offset).toBe(1)
    expect(to.css).toContain('rgba(255, 0, 0, 0)')
  })

  it('emits deterministic SVG markup with split stop opacity', () => {
    const solid = svgGradientPaint({ id: 'g1', kind: 'solid', primary: null, secondary: null, width: 100, height: 100 })
    expect(solid).toEqual({ defs: '', fill: 'none' })
    const linear = svgGradientPaint({
      id: 'g1',
      kind: 'horizontal',
      primary: { r: 255, g: 0, b: 0, a: 255 },
      secondary: null,
      width: 480,
      height: 360,
    })
    expect(linear.fill).toBe('url(#g1)')
    expect(linear.defs).toContain('linearGradient')
    expect(linear.defs).toContain('stop-color="#ff0000"')
    expect(linear.defs).toContain('stop-opacity="0"')
    // Per-object ramp: spans the element bbox at any position/size, never a
    // fixed 480x360 canvas slice, so direction/center survive moves.
    expect(linear.defs).toContain('gradientUnits="objectBoundingBox"')
    expect(linear.defs).toContain('x2="100%"')
    expect(linear.defs).not.toContain('x2="480"')
    const vertical = svgGradientPaint({
      id: 'gv',
      kind: 'vertical',
      primary: { r: 255, g: 0, b: 0, a: 255 },
      secondary: { r: 0, g: 0, b: 255, a: 255 },
      width: 480,
      height: 360,
    })
    expect(vertical.defs).toContain('y2="100%"')
    expect(vertical.defs).not.toContain('y2="360"')
    // Same input id yields byte-identical output (no Date.now/random).
    const again = svgGradientPaint({
      id: 'g1',
      kind: 'horizontal',
      primary: { r: 255, g: 0, b: 0, a: 255 },
      secondary: null,
      width: 480,
      height: 360,
    })
    expect(again).toEqual(linear)
    const radial = svgGradientPaint({
      id: 'r1',
      kind: 'radial',
      primary: { r: 255, g: 0, b: 0, a: 255 },
      secondary: { r: 0, g: 0, b: 255, a: 255 },
      width: 100,
      height: 100,
    })
    expect(radial.defs).toContain('radialGradient')
  })
})

describe('paint-colors eyedropper', () => {
  it('maps fully transparent pixels to transparent', () => {
    expect(eyeDropperPaint({ r: 0, g: 0, b: 0, a: 0 })).toBe(null)
    expect(eyeDropperPaint({ r: 255, g: 0, b: 0, a: 255 })).toEqual({ r: 255, g: 0, b: 0, a: 255 })
    expect(eyeDropperPaint({ r: 10, g: 20, b: 30, a: 128 })).toEqual({ r: 10, g: 20, b: 30, a: 128 })
  })
})
