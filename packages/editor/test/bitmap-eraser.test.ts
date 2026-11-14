import { afterEach, describe, expect, it, mock } from 'bun:test'
import { drawBitmapEraserStroke, forEachLinePoint, getBitmapEraserMark } from '../src/features/costumes/bitmap-eraser'

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

afterEach(() => {
  // Each test installs its own stub and restores via the returned callback.
})

describe('forEachLinePoint', () => {
  it('visits every pixel of a horizontal line including both ends', () => {
    const visited: Array<[number, number]> = []
    forEachLinePoint({ x: 1, y: 2 }, { x: 4, y: 2 }, (x, y) => visited.push([x, y]))
    expect(visited).toEqual([
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ])
  })

  it('keeps diagonal lines connected without gaps', () => {
    const visited: Array<[number, number]> = []
    forEachLinePoint({ x: 0, y: 0 }, { x: 3, y: 2 }, (x, y) => visited.push([x, y]))
    expect(visited[0]).toEqual([0, 0])
    expect(visited.at(-1)).toEqual([3, 2])
    for (let index = 1; index < visited.length; index += 1) {
      const [px, py] = visited[index - 1]!
      const [x, y] = visited[index]!
      expect(Math.abs(x - px) <= 1 && Math.abs(y - py) <= 1).toBe(true)
    }
  })

  it('calls back once for a single point', () => {
    const visited: Array<[number, number]> = []
    forEachLinePoint({ x: 5, y: 5 }, { x: 5, y: 5 }, (x, y) => visited.push([x, y]))
    expect(visited).toEqual([[5, 5]])
  })
})

describe('getBitmapEraserMark', () => {
  it('draws the guide border and caches it separately from the eraser stamp', () => {
    const context = makeContext()
    const colors: string[] = []
    context.fillRect = mock(() => { colors.push(context.fillStyle) })
    const restore = stubDocument(context)
    try {
      const cursor = getBitmapEraserMark(5, '#009dec')
      expect(colors).toEqual(['#009dec', 'white'])
      expect(getBitmapEraserMark(5, '#009dec')).toBe(cursor)
      expect(getBitmapEraserMark(5)).not.toBe(cursor)
      colors.length = 0
      getBitmapEraserMark(8, '#009dec')
      expect(colors).toContain('white')
      expect(colors).toContain('#009dec')
    } finally {
      restore()
    }
  })

  it('builds a square mark for small pixel-art sizes', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const mark = getBitmapEraserMark(3)
      expect(mark.width).toBe(4)
      expect(mark.height).toBe(4)
      expect(context.fillRect.mock.calls.length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('issues the same inner rect as the reference at diameter 1', () => {
    // Small eraser squares paint the guide color first, then punch the white
    // inner rect without clamping: at diameter 1 the inner call is
    // `fillRect(2, 2, -1, -1)`, exactly like the reference. Alpha stays opaque
    // either way, so `destination-out` erasing is unaffected; only the guide
    // RGBA matches the reference.
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const mark = getBitmapEraserMark(1, '#009dec')
      expect(mark.width).toBe(2)
      expect(mark.height).toBe(2)
      expect(context.fillRect.mock.calls).toEqual([
        [1, 1, 1, 1],
        [2, 2, -1, -1],
      ])
    } finally {
      restore()
    }
  })

  it('matches the pixel footprint of the six-pixel eraser mark', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      getBitmapEraserMark(6)
      const pixels = Array.from({ length: 6 }, () => Array(6).fill('.'))
      for (const [x, y, width, height] of context.fillRect.mock.calls as number[][]) {
        for (let py = Math.max(0, y!); py < Math.min(6, y! + height!); py++) {
          for (let px = Math.max(0, x!); px < Math.min(6, x! + width!); px++) pixels[py]![px] = '#'
        }
      }
      expect(pixels.map((row) => row.join(''))).toEqual([
        '.####.',
        '######',
        '######',
        '######',
        '######',
        '.####.',
      ])
    } finally {
      restore()
    }
  })

  it('builds a circular mark at larger sizes and reuses it', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      const first = getBitmapEraserMark(40)
      expect(first.width).toBe(40)
      expect(first.height).toBe(40)
      expect(getBitmapEraserMark(40)).toBe(first)
    } finally {
      restore()
    }
  })
})

describe('drawBitmapEraserStroke', () => {
  it('erases with destination-out along the whole drag', () => {
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
      drawBitmapEraserStroke(context as unknown as CanvasRenderingContext2D, [{ x: 0, y: 0 }, { x: 6, y: 0 }], 4)
      expect(context.save).toHaveBeenCalledTimes(1)
      expect(context.restore).toHaveBeenCalledTimes(1)
      expect(seen).toContain('destination-out')
      // 7 Bresenham pixels stamped with the cached 4px mark.
      expect(context.drawImage.mock.calls.length).toBe(7)
    } finally {
      restore()
    }
  })

  it('stamps once for a click without dragging', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      drawBitmapEraserStroke(context as unknown as CanvasRenderingContext2D, [{ x: 10, y: 12 }], 4)
      expect(context.drawImage.mock.calls.length).toBe(1)
    } finally {
      restore()
    }
  })

  it('does nothing without points', () => {
    const context = makeContext()
    drawBitmapEraserStroke(context as unknown as CanvasRenderingContext2D, [], 4)
    expect(context.save).not.toHaveBeenCalled()
    expect(context.drawImage).not.toHaveBeenCalled()
  })
})
