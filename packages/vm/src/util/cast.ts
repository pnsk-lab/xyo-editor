import { Color, type RGBObject } from './color'

export const LIST_INVALID = 'INVALID'
export const LIST_ALL = 'ALL'

export const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return Number.isNaN(value) ? 0 : value
  const number = Number(value)
  return Number.isNaN(number) ? 0 : number
}

export const toBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value !== '' && value !== '0' && value.toLowerCase() !== 'false'
  return toNumber(value) !== 0
}

export const toString = (value: unknown): string => String(value)

export const toRgbColorObject = (value: unknown): RGBObject => {
  if (typeof value === 'string' && value.startsWith('#')) return Color.hexToRgb(value) ?? { r: 0, g: 0, b: 0, a: 255 }
  return Color.decimalToRgb(toNumber(value))
}

export const toRgbColorList = (value: unknown): [number, number, number] => {
  const color = toRgbColorObject(value)
  return [color.r, color.g, color.b]
}

export const isWhiteSpace = (value: unknown): boolean => value === null || (typeof value === 'string' && value.trim().length === 0)

export const compare = (v1: unknown, v2: unknown): number => {
  let n1 = Number(v1)
  let n2 = Number(v2)
  if (n1 === 0 && isWhiteSpace(v1)) n1 = Number.NaN
  if (n2 === 0 && isWhiteSpace(v2)) n2 = Number.NaN
  if (Number.isNaN(n1) || Number.isNaN(n2)) {
    const s1 = toString(v1).toLowerCase()
    const s2 = toString(v2).toLowerCase()
    if (s1 === s2) return 0
    return s1 < s2 ? -1 : 1
  }
  if ((n1 === Infinity && n2 === Infinity) || (n1 === -Infinity && n2 === -Infinity)) return 0
  return n1 - n2
}

export const isInt = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isNaN(value) || value === Math.trunc(value)
  if (typeof value === 'boolean') return true
  if (typeof value === 'string') return !value.includes('.')
  return false
}

export const toListIndex = (index: unknown, length: number, acceptAll: boolean): number | string => {
  if (typeof index !== 'number') {
    const text = toString(index).toLowerCase()
    if (text === 'all') return acceptAll ? LIST_ALL : LIST_INVALID
    if (text === 'last') return length > 0 ? length : LIST_INVALID
    if (text === 'random' || text === 'any') return length > 0 ? 1 + Math.floor(Math.random() * length) : LIST_INVALID
  }
  const numericIndex = Math.floor(toNumber(index))
  return numericIndex < 1 || numericIndex > length ? LIST_INVALID : numericIndex
}

export class Cast {
  static get LIST_INVALID(): string {
    return LIST_INVALID
  }

  static get LIST_ALL(): string {
    return LIST_ALL
  }

  static toNumber = toNumber
  static toBoolean = toBoolean
  static toString = toString
  static toRgbColorObject = toRgbColorObject
  static toRgbColorList = toRgbColorList
  static isWhiteSpace = isWhiteSpace
  static compare = compare
  static isInt = isInt
  static toListIndex = toListIndex
}
