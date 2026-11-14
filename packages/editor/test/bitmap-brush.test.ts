import { describe, expect, it, mock } from 'bun:test'
import {
  BITMAP_BRUSH_DEFAULT_SIZE,
  bitmapBrushMarkEdge,
  drawBitmapBrushStroke,
  forEachBrushLinePoint,
  getBitmapBrushMark,
  normalizeBrushDiameter,
} from '../src/features/costumes/bitmap-brush'
import { getBitmapEraserMark } from '../src/features/costumes/bitmap-eraser'

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

describe('normalizeBrushDiameter', () => {
  it('uses the integer brush size in canvas pixels with a minimum of one', () => {
    expect(normalizeBrushDiameter(7)).toBe(7)
    expect(normalizeBrushDiameter(7.9)).toBe(7)
    expect(normalizeBrushDiameter(0)).toBe(1)
    expect(normalizeBrushDiameter(-3)).toBe(1)
    expect(normalizeBrushDiameter(Number.NaN)).toBe(1)
    expect(BITMAP_BRUSH_DEFAULT_SIZE).toBe(10)
  })
})

describe('bitmapBrushMarkEdge', () => {
  it('rounds the stamp canvas up to an even edge', () => {
    expect(bitmapBrushMarkEdge(1)).toBe(2)
    expect(bitmapBrushMarkEdge(4)).toBe(4)
    expect(bitmapBrushMarkEdge(5)).toBe(6)
    expect(bitmapBrushMarkEdge(6)).toBe(6)
    expect(bitmapBrushMarkEdge(7)).toBe(8)
  })
})

describe('forEachBrushLinePoint', () => {
  it('visits every integer pixel of a horizontal drag including both ends', () => {
    const visited: Array<[number, number]> = []
    forEachBrushLinePoint({ x: 1, y: 2 }, { x: 4, y: 2 }, (x, y) => visited.push([x, y]))
    expect(visited).toEqual([
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ])
  })

  it('keeps diagonal drags connected without gaps', () => {
    const visited: Array<[number, number]> = []
    forEachBrushLinePoint({ x: 0, y: 0 }, { x: 3, y: 2 }, (x, y) => visited.push([x, y]))
    expect(visited[0]).toEqual([0, 0])
    expect(visited.at(-1)).toEqual([3, 2])
    for (let index = 1; index < visited.length; index += 1) {
      const [px, py] = visited[index - 1]!
      const [x, y] = visited[index]!
      expect(Math.abs(x - px) <= 1 && Math.abs(y - py) <= 1).toBe(true)
    }
  })

  it('truncates fractional pointer positions to integer pixels', () => {
    const visited: Array<[number, number]> = []
    forEachBrushLinePoint({ x: 1.9, y: 2.7 }, { x: 1.9, y: 2.7 }, (x, y) => visited.push([x, y]))
    expect(visited).toEqual([[1, 2]])
  })
})

describe('getBitmapBrushMark', () => {
  it('builds a square stamp for pixel-art sizes', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const mark = getBitmapBrushMark(3, '#ff0000')
      expect(mark.width).toBe(4)
      expect(mark.height).toBe(4)
      expect(context.fillStyle).toBe('#ff0000')
      expect(context.fillRect.mock.calls).toEqual([[1, 1, 3, 3]])
    } finally {
      restore()
    }
  })

  it('centers even small squares without an offset', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      getBitmapBrushMark(4, '#00ff00')
      expect(context.fillRect.mock.calls).toEqual([[0, 0, 4, 4]])
    } finally {
      restore()
    }
  })

  it('builds a symmetric filled circle with empty corners at larger sizes', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const mark = getBitmapBrushMark(8, '#0000ff')
      expect(mark.width).toBe(8)
      expect(mark.height).toBe(8)
      // The shared stepper fills integer spans (width/height > 1), so expand
      // every fillRect into its covered pixels before asserting.
      const filled = new Set<string>()
      for (const [x, y, w, h] of context.fillRect.mock.calls as unknown as Array<[number, number, number, number]>) {
        for (let dy = 0; dy < h; dy += 1) {
          for (let dx = 0; dx < w; dx += 1) {
            filled.add(`${x + dx},${y + dy}`)
          }
        }
      }
      expect(filled.size).toBeGreaterThan(20)
      // Center pixels are painted.
      expect(filled.has('3,3')).toBe(true)
      expect(filled.has('4,4')).toBe(true)
      // Corners stay empty for a circle.
      expect(filled.has('0,0')).toBe(false)
      expect(filled.has('7,0')).toBe(false)
      expect(filled.has('0,7')).toBe(false)
      expect(filled.has('7,7')).toBe(false)
      // The disc is symmetric about its center.
      for (const key of filled) {
        const [x, y] = key.split(',').map(Number)
        expect(filled.has(`${7 - x!},${y}`)).toBe(true)
        expect(filled.has(`${x},${7 - y!}`)).toBe(true)
      }
    } finally {
      restore()
    }
  })

  it('caches stamps per diameter and color', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const first = getBitmapBrushMark(9, '#123456')
      expect(getBitmapBrushMark(9, '#123456')).toBe(first)
      expect(getBitmapBrushMark(9, '#654321')).not.toBe(first)
      expect(getBitmapBrushMark(10, '#123456')).not.toBe(first)
    } finally {
      restore()
    }
  })
})

describe('large brush stamp boundary', () => {
  let stampNonce = 0

  function stampPixels(render: () => unknown, context: FakeContext): Set<string> {
    const restore = stubDocument(context)
    try {
      render()
    } finally {
      restore()
    }
    const pixels = new Set<string>()
    for (const [x, y, w, h] of context.fillRect.mock.calls as unknown as Array<[number, number, number, number]>) {
      for (let dy = 0; dy < h; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) {
          pixels.add(`${x + dx},${y + dy}`)
        }
      }
    }
    return pixels
  }

  function brushPixels(diameter: number): Set<string> {
    // The stamp cache is keyed by diameter and color, so every capture
    // uses a fresh color to force a re-render into the mock context.
    stampNonce += 1
    return stampPixels(() => getBitmapBrushMark(diameter, `brush-boundary-${diameter}-${stampNonce}`), makeContext())
  }

  function eraserPixels(diameter: number): Set<string> {
    // The eraser stamp draws a filled disc plus a 1px guide ring; the ring
    // is a subset of the fill, so the union of every fillRect is the stamp
    // footprint stamped with `destination-out`.
    stampNonce += 1
    return stampPixels(() => getBitmapEraserMark(diameter, `eraser-boundary-${diameter}-${stampNonce}`), makeContext())
  }

  it('pairs odd diameters with the even diameter below them', () => {
    for (const odd of [7, 9, 11, 21, 39]) {
      expect(brushPixels(odd)).toEqual(brushPixels(odd - 1))
    }
  })

  it('matches the eraser stamp footprint at every diameter from 1 to 100', () => {
    // The brush and the eraser share the same disc stepper, so the union of
    // every fillRect (the `destination-out` footprint) is identical at the
    // same diameter: full cancellation with no leftover boundary pixels.
    for (let diameter = 1; diameter <= 100; diameter += 1) {
      expect(brushPixels(diameter)).toEqual(eraserPixels(diameter))
    }
  })

  it('keeps odd circles rotationally symmetric about the integer center', () => {
    for (const diameter of [7, 9]) {
      const center = Math.trunc(diameter / 2)
      const filled = brushPixels(diameter)
      expect(filled.size).toBeGreaterThan(0)
      for (const key of filled) {
        const [x, y] = key.split(',').map(Number)
        expect(filled.has(`${2 * center - 1 - x!},${2 * center - 1 - y!}`)).toBe(true)
      }
    }
  })

  it('covers exactly the eraser pixels at every diameter from 1 to 100', () => {
    // Shared footprint: no missing pixels and no extra boundary pixels, so a
    // same-diameter erase cancels the brush exactly.
    for (let diameter = 1; diameter <= 100; diameter += 1) {
      const brush = brushPixels(diameter)
      const eraser = eraserPixels(diameter)
      let missing = 0
      for (const key of eraser) {
        if (!brush.has(key)) missing += 1
      }
      let extra = 0
      for (const key of brush) {
        if (!eraser.has(key)) extra += 1
      }
      expect(missing).toBe(0)
      expect(extra).toBe(0)
    }
  })

  it('anchors odd diameters with the same ceil(diameter / 2) offset', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      drawBitmapBrushStroke(context as unknown as CanvasRenderingContext2D, [{ x: 10.7, y: 12.2 }], 7, '#ff0000')
      // 7px mark radius is ceil(7 / 2) = 4, truncated point (10, 12) stamps at (6, 8).
      const [, dx, dy] = context.drawImage.mock.calls[0] as unknown as [unknown, number, number]
      expect([dx, dy]).toEqual([6, 8])
    } finally {
      restore()
    }
  })
})

describe('drawBitmapBrushStroke', () => {
  it('stamps once for a click without dragging', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      drawBitmapBrushStroke(context as unknown as CanvasRenderingContext2D, [{ x: 10.7, y: 12.2 }], 4, '#ff0000')
      expect(context.save).toHaveBeenCalledTimes(1)
      expect(context.restore).toHaveBeenCalledTimes(1)
      // 4px mark radius is 2, truncated point (10, 12) stamps at (8, 10).
      expect(context.drawImage.mock.calls.length).toBe(1)
      const [, dx, dy] = context.drawImage.mock.calls[0] as unknown as [unknown, number, number]
      expect([dx, dy]).toEqual([8, 10])
    } finally {
      restore()
    }
  })

  it('paints with source-over along the whole interpolated drag', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const seen: string[] = []
      Object.defineProperty(context, 'globalCompositeOperation', {
        get: () => seen.at(-1) ?? 'source-over',
        set: (value: string) => {
          seen.push(value)
        },
        configurable: true,
      })
      drawBitmapBrushStroke(
        context as unknown as CanvasRenderingContext2D,
        [
          { x: 0, y: 0 },
          { x: 6, y: 0 },
        ],
        4,
        '#ff0000',
      )
      expect(seen).toContain('source-over')
      // 7 Bresenham pixels stamped with the cached 4px mark.
      expect(context.drawImage.mock.calls.length).toBe(7)
    } finally {
      restore()
    }
  })

  it('normalizes fractional diameters to whole pixels', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      drawBitmapBrushStroke(context as unknown as CanvasRenderingContext2D, [{ x: 5, y: 5 }], 4.9, '#ff0000')
      const [, dx, dy] = context.drawImage.mock.calls[0] as unknown as [unknown, number, number]
      expect([dx, dy]).toEqual([3, 3])
    } finally {
      restore()
    }
  })

  it('does nothing without points', () => {
    const context = makeContext()
    drawBitmapBrushStroke(context as unknown as CanvasRenderingContext2D, [], 4, '#ff0000')
    expect(context.save).not.toHaveBeenCalled()
    expect(context.drawImage).not.toHaveBeenCalled()
  })
})
