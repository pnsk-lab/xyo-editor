import { describe, expect, it } from 'bun:test'
import {
  bitmapTextBlockBounds,
  clampBitmapTextFontSize,
  estimateBitmapTextLineWidth,
  isBitmapTextEmpty,
  resolveBitmapTextAlign,
  resolveBitmapTextCommitPoint,
  resolveBitmapTextFont,
  splitBitmapTextLines,
} from '../src/features/costumes/bitmap-text'

describe('bitmap inline text helpers', () => {
  it('clamps font sizes into the raster range', () => {
    expect(clampBitmapTextFontSize(4)).toBe(8)
    expect(clampBitmapTextFontSize(28)).toBe(28)
    expect(clampBitmapTextFontSize(9999)).toBe(200)
  })

  it('treats whitespace-only drafts as empty', () => {
    expect(isBitmapTextEmpty('  \n ')).toBe(true)
    expect(isBitmapTextEmpty('a')).toBe(false)
  })

  it('splits lines and builds a css font', () => {
    expect(splitBitmapTextLines('a\r\nb')).toEqual(['a', 'b'])
    expect(resolveBitmapTextFont(24, 'Arial, sans-serif')).toBe('24px Arial, sans-serif')
  })

  it('estimates a non-empty block for gradients', () => {
    const bounds = bitmapTextBlockBounds(100, 100, 'hi\nthere', 20)
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(20)
    expect(bounds.x).toBeLessThan(100)
  })

  it('resolves canvas alignment from content or the document', () => {
    expect(resolveBitmapTextAlign('hello')).toBe('center')
    expect(resolveBitmapTextAlign('日本語テスト')).toBe('center')
    expect(resolveBitmapTextAlign('123')).toBe('center')
    expect(resolveBitmapTextAlign('שלום')).toBe('right')
    expect(resolveBitmapTextAlign('hello שלום')).toBe('center')
    expect(resolveBitmapTextAlign('שלום hello')).toBe('right')
    expect(resolveBitmapTextAlign('hello', 'rtl')).toBe('right')
    expect(resolveBitmapTextAlign('שלום', 'ltr')).toBe('right')
  })

  it('passes LTR commit points through untouched', () => {
    expect(resolveBitmapTextCommitPoint({ x: 100, y: 100 }, 'hi', 28, 'Arial')).toEqual({ x: 100, y: 100 })
    expect(resolveBitmapTextCommitPoint({ x: 100, y: 100 }, '日本語', 28, 'Arial')).toEqual({ x: 100, y: 100 })
  })

  it('shifts RTL commits left by half the widest line', () => {
    // Injected canvas measurement: longest line (200px) decides the offset.
    const measured = resolveBitmapTextCommitPoint(
      { x: 100, y: 100 },
      'שלום\nעולם!',
      28,
      'Arial',
      undefined,
      (line) => (line === 'עולם!' ? 200 : 100),
    )
    expect(measured.x).toBe(0)
    expect(measured.y).toBe(100)
    // Without measurement the 0.55em heuristic agrees with the block bounds.
    const fallback = resolveBitmapTextCommitPoint({ x: 100, y: 100 }, 'שלום', 20, 'Arial')
    const longest = 'שלום'.length
    expect(fallback.x).toBeCloseTo(100 - Math.max(20, longest * 20 * 0.55) / 2, 10)
    expect(estimateBitmapTextLineWidth('שלום', 20)).toBeGreaterThan(0)
  })
})
