import { describe, expect, it, mock } from 'bun:test'
import {
  BITMAP_BRUSH_MAX_POINTS,
  BITMAP_BRUSH_MAX_SEGMENT_STEPS,
  BITMAP_BRUSH_MAX_STAMPS,
  bitmapBrushSegmentStampCount,
  drawBitmapBrushSegment,
  drawBitmapBrushStroke,
  forEachBrushLinePoint,
  validateBitmapBrushStroke,
} from '../src/features/costumes/bitmap-brush'
import {
  drawBitmapEraserSegment,
  drawBitmapEraserStroke,
  validateBitmapEraserStroke,
} from '../src/features/costumes/bitmap-eraser'
import { drawBitmapLine, getBitmapLinePixels, validateBitmapLine } from '../src/features/costumes/bitmap-line'

type FakeContext = {
  imageSmoothingEnabled: boolean
  fillStyle: string
  globalCompositeOperation: string
  fillRect: ReturnType<typeof mock>
  drawImage: ReturnType<typeof mock>
  save: ReturnType<typeof mock>
  restore: ReturnType<typeof mock>
}

function makeContext(): FakeContext {
  return {
    imageSmoothingEnabled: true,
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    fillRect: mock(),
    drawImage: mock(),
    save: mock(),
    restore: mock(),
  }
}

function stubDocument(context: FakeContext) {
  const realDocument = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => context,
    }),
  }
  return () => {
    ;(globalThis as Record<string, unknown>).document = realDocument
  }
}

describe('bitmap stroke caps: feasible canvas stays paintable', () => {
  it('segment cap covers the max live side (65535)', () => {
    expect(BITMAP_BRUSH_MAX_SEGMENT_STEPS).toBe(65535)
  })

  it('old 50000/50001 segments now pass (valid canvas regression)', () => {
    const a = { x: 0, y: 0 }
    expect(() => forEachBrushLinePoint(a, { x: 50000, y: 0 }, () => {})).not.toThrow()
    expect(() => forEachBrushLinePoint(a, { x: 50001, y: 0 }, () => {})).not.toThrow()
    expect(bitmapBrushSegmentStampCount(a, { x: 50001, y: 0 })).toBe(50002)
  })

  it('cap boundary: 65535 passes, 65536 throws', () => {
    const a = { x: 0, y: 0 }
    expect(() => forEachBrushLinePoint(a, { x: 65535, y: 0 }, () => {})).not.toThrow()
    expect(() => forEachBrushLinePoint(a, { x: 65536, y: 0 }, () => {})).toThrow(RangeError)
    expect(() => validateBitmapBrushStroke([a, { x: 65535, y: 0 }])).not.toThrow()
    expect(() => validateBitmapBrushStroke([a, { x: 65536, y: 0 }])).toThrow(RangeError)
    expect(() => validateBitmapLine(a, { x: 65535, y: 0 })).not.toThrow()
    expect(() => validateBitmapLine(a, { x: 65536, y: 0 })).toThrow(RangeError)
    expect(() => validateBitmapEraserStroke([a, { x: 65535, y: 0 }])).not.toThrow()
    expect(() => validateBitmapEraserStroke([a, { x: 65536, y: 0 }])).toThrow(RangeError)
  })

  it('full-width 60000x1 stroke is feasible (single segment)', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 60000, y: 0 },
    ]
    expect(validateBitmapBrushStroke(points)).toBe(60001)
    expect(validateBitmapLine(points[0]!, points[1]!)).toBe(60001)
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      drawBitmapBrushStroke(context as unknown as CanvasRenderingContext2D, points, 4, '#ff0000')
      expect(context.drawImage.mock.calls.length).toBe(60001)
      expect(context.save).toHaveBeenCalledTimes(1)
      expect(context.restore).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('points cap boundary: 10000 passes, 10001 throws', () => {
    const ok = Array.from({ length: 10000 }, () => ({ x: 0, y: 0 }))
    const tooMany = Array.from({ length: 10001 }, () => ({ x: 0, y: 0 }))
    // 10000 identical points: 9999 one-pixel segments (joints double-counted
    // per the painter); the cap counts points, the total counts stamps.
    expect(validateBitmapBrushStroke(ok)).toBe(9999)
    expect(() => validateBitmapBrushStroke(tooMany)).toThrow(RangeError)
    expect(() => validateBitmapEraserStroke(tooMany)).toThrow(RangeError)
    expect(BITMAP_BRUSH_MAX_POINTS).toBe(10000)
  })

  it('cumulative stamps cap: ~458k passes, ~524k throws', () => {
    // 7 segments x 65535 dx = 7*65536 stamps (~458k) feasible; 8 segments (~524k) refused.
    const seven: Array<{ x: number; y: number }> = []
    for (let i = 0; i <= 7; i += 1) seven.push({ x: i % 2 === 0 ? 0 : 65535, y: 0 })
    const eight: Array<{ x: number; y: number }> = []
    for (let i = 0; i <= 8; i += 1) eight.push({ x: i % 2 === 0 ? 0 : 65535, y: 0 })
    expect(validateBitmapBrushStroke(seven)).toBe(7 * 65536)
    expect(7 * 65536).toBeLessThanOrEqual(BITMAP_BRUSH_MAX_STAMPS)
    expect(() => validateBitmapBrushStroke(eight)).toThrow(RangeError)
    expect(BITMAP_BRUSH_MAX_STAMPS).toBe(500000)
  })

  it('huge 32-bit / non-finite coords throw fast', () => {
    expect(() => forEachBrushLinePoint({ x: 2147483648, y: 0 }, { x: 0, y: 0 }, () => {})).toThrow(RangeError)
    expect(() => forEachBrushLinePoint({ x: 1e15, y: 0 }, { x: -1e15, y: 0 }, () => {})).toThrow(RangeError)
    expect(() => forEachBrushLinePoint({ x: Number.NaN, y: 0 }, { x: 5, y: 5 }, () => {})).toThrow(RangeError)
    expect(() => forEachBrushLinePoint({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }, () => {})).toThrow(RangeError)
    expect(() => validateBitmapLine({ x: 0, y: 0 }, { x: 1e12, y: 1e12 })).toThrow(RangeError)
    expect(() => getBitmapLinePixels({ x: 0, y: 0 }, { x: 400000, y: 0 })).toThrow(RangeError)
  })

  it('reference behavior unchanged for normal strokes', () => {
    const visited: Array<[number, number]> = []
    forEachBrushLinePoint({ x: 1, y: 2 }, { x: 4, y: 2 }, (x, y) => visited.push([x, y]))
    expect(visited).toEqual([
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ])
    expect(getBitmapLinePixels({ x: 0, y: 0 }, { x: 3, y: 2 }).at(-1)).toEqual({ x: 3, y: 2 })
  })
})

describe('atomic fail-closed: no partial mutation on refusal', () => {
  it('brush full replay paints nothing when the second segment is too long', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const points = [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 70000, y: 0 },
      ]
      expect(() => drawBitmapBrushStroke(context as unknown as CanvasRenderingContext2D, points, 4, '#ff0000')).toThrow(RangeError)
      // Atomic: no stamp ran, save/restore still balanced via try/finally.
      expect(context.drawImage).not.toHaveBeenCalled()
      expect(context.save).toHaveBeenCalledTimes(1)
      expect(context.restore).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('brush segment helper validates inside save/restore (balanced, no paint)', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      expect(() => drawBitmapBrushSegment(context as unknown as CanvasRenderingContext2D, { x: 0, y: 0 }, { x: 70000, y: 0 }, 4, '#000')).toThrow(
        RangeError,
      )
      expect(context.drawImage).not.toHaveBeenCalled()
      expect(context.save).toHaveBeenCalledTimes(1)
      expect(context.restore).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('eraser full replay paints nothing when over the points cap', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const points = Array.from({ length: 10001 }, () => ({ x: 0, y: 0 }))
      expect(() => drawBitmapEraserStroke(context as unknown as CanvasRenderingContext2D, points, 4)).toThrow(RangeError)
      expect(context.drawImage).not.toHaveBeenCalled()
      expect(context.save).toHaveBeenCalledTimes(1)
      expect(context.restore).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('eraser segment paints nothing on oversized segment', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      expect(() => drawBitmapEraserSegment(context as unknown as CanvasRenderingContext2D, { x: 0, y: 0 }, { x: 0, y: 70000 }, 4)).toThrow(
        RangeError,
      )
      expect(context.drawImage).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('line paints nothing on huge endpoints and keeps save/restore balanced', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      expect(() => drawBitmapLine(context as unknown as CanvasRenderingContext2D, { x: 0, y: 0 }, { x: 1e12, y: 1e12 }, 5, '#000')).toThrow(
        RangeError,
      )
      expect(context.drawImage).not.toHaveBeenCalled()
      expect(context.save).toHaveBeenCalledTimes(1)
      expect(context.restore).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })
})
