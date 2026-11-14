import { describe, expect, it } from 'bun:test'
import {
  HSV_DEFAULT,
  displayHsvFor,
  hexToHsv100,
  hsv100ToHex,
  hsv100ToRgb,
  hsvReadout,
  hsvSliderBackground,
  normalizeHsv100,
  parseHsvHex,
  rgbToHsv100,
  rgbToHex,
} from '../src/features/costumes/hsv-color'

// Unit tests for the Scratch-parity HSV picker math. The implementation is
// written independently (standard HSV); expectations below pin the RGB<->HSV
// endpoints, the 0-100 hue scale (x3.6 = degrees), and the display rules for
// transparent / MIXED / black so the toolbar sliders can never silently shift
// stored colors.
describe('hsv-color endpoints', () => {
  it('maps primary RGB corners to the 0-100 HSV scale', () => {
    expect(rgbToHsv100({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, v: 100 })
    const green = rgbToHsv100({ r: 0, g: 255, b: 0 })
    expect(green.h).toBeCloseTo(100 / 3, 8)
    expect(green.s).toBeCloseTo(100, 8)
    expect(green.v).toBeCloseTo(100, 8)
    const blue = rgbToHsv100({ r: 0, g: 0, b: 255 })
    expect(blue.h).toBeCloseTo(200 / 3, 8)
    expect(blue.s).toBeCloseTo(100, 8)
    expect(blue.v).toBeCloseTo(100, 8)
    expect(rgbToHsv100({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 100 })
    expect(rgbToHsv100({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 })
    expect(rgbToHsv100({ r: 128, g: 128, b: 128 }).s).toBe(0)
  })

  it('round-trips HSV 0-100 through RGB without drifting primaries', () => {
    for (const hsv of [
      { h: 0, s: 100, v: 100 },
      { h: 100 / 3, s: 100, v: 100 },
      { h: 50, s: 100, v: 100 },
      { h: 0, s: 0, v: 100 },
      { h: 0, s: 0, v: 0 },
      { h: 75, s: 40, v: 60 },
    ]) {
      const back = rgbToHsv100(hsv100ToRgb(hsv))
      expect(Math.abs(back.h - hsv.h)).toBeLessThan(1)
      expect(Math.abs(back.s - hsv.s)).toBeLessThan(1)
      expect(Math.abs(back.v - hsv.v)).toBeLessThan(1)
    }
  })

  it('converts hex both ways with clamping', () => {
    expect(hsv100ToHex({ h: 0, s: 100, v: 100 })).toBe('#ff0000')
    expect(hsv100ToHex({ h: 50, s: 100, v: 100 })).toBe('#00ffff')
    expect(hexToHsv100('#ff0000')).toEqual({ h: 0, s: 100, v: 100 })
    expect(hexToHsv100('#fff')).toEqual({ h: 0, s: 0, v: 100 })
    expect(hexToHsv100('not-a-color')).toBe(undefined)
    expect(parseHsvHex('#zzz')).toBe(undefined)
    expect(rgbToHex({ r: 300, g: -4, b: 18 })).toBe('#ff0012')
    expect(normalizeHsv100({ h: 140, s: -2, v: Number.NaN })).toEqual({ h: 100, s: 0, v: 0 })
  })

  it('keeps hue endpoints continuous (100 wraps to red)', () => {
    expect(hsv100ToHex({ h: 100, s: 100, v: 100 })).toBe('#ff0000')
    expect(hsv100ToHex({ h: 0, s: 0, v: 50 })).toBe(hsv100ToHex({ h: 63.5, s: 0, v: 50 }))
  })
})

describe('hsv-color display rules', () => {
  it('parks transparent / MIXED / unparseable on the default without writing', () => {
    expect(displayHsvFor(null)).toEqual(HSV_DEFAULT)
    expect(displayHsvFor('#ff0000', true)).toEqual(HSV_DEFAULT)
    expect(displayHsvFor('bogus')).toEqual(HSV_DEFAULT)
    expect(displayHsvFor(undefined)).toEqual(HSV_DEFAULT)
  })

  it('shows black with saturation 100 so the sliders stay usable', () => {
    expect(displayHsvFor('#000000')).toEqual({ h: 0, s: 100, v: 0 })
  })

  it('derives usable slider positions from ordinary colors', () => {
    expect(displayHsvFor('#ff0000')).toEqual({ h: 0, s: 100, v: 100 })
  })

  it('builds per-channel gradient tracks and rounded readouts', () => {
    const hueTrack = hsvSliderBackground('hue', { h: 0, s: 100, v: 100 })
    expect(hueTrack.startsWith('linear-gradient(to left,')).toBe(true)
    expect(hueTrack).toContain('#ff0000')
    expect(hueTrack).toContain('#00ffff')
    const satTrack = hsvSliderBackground('saturation', { h: 0, s: 100, v: 100 })
    expect(satTrack).toContain('#ff0000')
    const brightTrack = hsvSliderBackground('brightness', { h: 0, s: 100, v: 100 })
    expect(brightTrack).toContain('#ff0000')
    expect(brightTrack).toContain('#000000')
    expect(hsvReadout(49.6)).toBe('50')
    expect(hsvReadout(100)).toBe('100')
  })
})
