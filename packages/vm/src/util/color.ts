export interface RGBObject {
  r: number
  g: number
  b: number
  a?: number
}

export interface HSVObject {
  h: number
  s: number
  v: number
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

export const RGB_BLACK: RGBObject = { r: 0, g: 0, b: 0 }
export const RGB_WHITE: RGBObject = { r: 255, g: 255, b: 255 }

export const decimalToHex = (decimal: number): string => {
  let value = Number(decimal)
  if (value < 0) value += 0xffffff + 1
  const hex = Math.trunc(value).toString(16)
  return `#${'000000'.slice(0, Math.max(0, 6 - hex.length))}${hex}`.slice(0, 7)
}

export const decimalToRgb = (decimal: number): RGBObject => {
  const value = Math.trunc(Number(decimal)) || 0
  const a = (value >> 24) & 0xff
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, a: a > 0 ? a : 255 }
}

export const hexToRgb = (hex: string): RGBObject | null => {
  const expanded = String(hex).replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, (_m, r, g, b) => `${r}${r}${g}${g}${b}${b}`)
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(expanded)
  return match ? { r: Number.parseInt(match[1]!, 16), g: Number.parseInt(match[2]!, 16), b: Number.parseInt(match[3]!, 16) } : null
}

export const rgbToDecimal = (rgb: RGBObject): number => ((rgb.r & 0xff) << 16) + ((rgb.g & 0xff) << 8) + (rgb.b & 0xff)

export const rgbToHex = (rgb: RGBObject): string => decimalToHex(rgbToDecimal(rgb))

export const hexToDecimal = (hex: string): number => {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToDecimal(rgb) : 0
}

export const hsvToRgb = (hsv: HSVObject): RGBObject => {
  let h = hsv.h % 360
  if (h < 0) h += 360
  const s = clamp(hsv.s, 0, 1)
  const v = clamp(hsv.v, 0, 1)
  const i = Math.floor(h / 60)
  const f = h / 60 - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  const options: Array<[number, number, number]> = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ]
  const parts = options[i] ?? [v, t, p]
  return { r: Math.floor(parts[0] * 255), g: Math.floor(parts[1] * 255), b: Math.floor(parts[2] * 255) }
}

export const rgbToHsv = (rgb: RGBObject): HSVObject => {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  let h = 0
  let s = 0
  if (min !== max) {
    const f = r === min ? g - b : g === min ? b - r : r - g
    const i = r === min ? 3 : g === min ? 5 : 1
    h = ((i - f / (max - min)) * 60) % 360
    s = (max - min) / max
  }
  return { h, s, v: max }
}

export const mixRgb = (rgb0: RGBObject, rgb1: RGBObject, fraction1: number): RGBObject => {
  if (fraction1 <= 0) return rgb0
  if (fraction1 >= 1) return rgb1
  const fraction0 = 1 - fraction1
  return { r: fraction0 * rgb0.r + fraction1 * rgb1.r, g: fraction0 * rgb0.g + fraction1 * rgb1.g, b: fraction0 * rgb0.b + fraction1 * rgb1.b }
}

export class Color {
  static get RGB_BLACK(): RGBObject {
    return RGB_BLACK
  }

  static get RGB_WHITE(): RGBObject {
    return RGB_WHITE
  }

  static decimalToHex = decimalToHex
  static decimalToRgb = decimalToRgb
  static hexToRgb = hexToRgb
  static rgbToDecimal = rgbToDecimal
  static rgbToHex = rgbToHex
  static hexToDecimal = hexToDecimal
  static hsvToRgb = hsvToRgb
  static rgbToHsv = rgbToHsv
  static mixRgb = mixRgb
}
