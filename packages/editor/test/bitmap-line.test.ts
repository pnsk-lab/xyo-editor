import { describe, expect, it, mock } from 'bun:test'
import {
  BITMAP_LINE_DEFAULT_WIDTH,
  bitmapLineStampOrigin,
  drawBitmapLine,
  getBitmapLinePixels,
  normalizeBitmapLineWidth,
} from '../src/features/costumes/bitmap-line'
import {
  BITMAP_BRUSH_DEFAULT_SIZE,
  drawBitmapBrushStroke,
} from '../src/features/costumes/bitmap-brush'

type FakeContext = {
  imageSmoothingEnabled: boolean
  globalCompositeOperation: string
  drawImage: ReturnType<typeof mock>
  save: ReturnType<typeof mock>
  restore: ReturnType<typeof mock>
  // Vector path APIs the old line implementation used; the stamp
  // implementation must leave all of them untouched.
  beginPath: ReturnType<typeof mock>
  moveTo: ReturnType<typeof mock>
  lineTo: ReturnType<typeof mock>
  stroke: ReturnType<typeof mock>
}

function makeContext(): FakeContext {
  return {
    imageSmoothingEnabled: true,
    globalCompositeOperation: 'copy',
    drawImage: mock(),
    save: mock(),
    restore: mock(),
    beginPath: mock(),
    moveTo: mock(),
    lineTo: mock(),
    stroke: mock(),
  }
}

function stubDocument() {
  const realDocument = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: true,
        fillStyle: '',
        fillRect: mock(),
      }),
    }),
  }
  return () => {
    ;(globalThis as Record<string, unknown>).document = realDocument
  }
}

describe('normalizeBitmapLineWidth', () => {
  it('maps stroke width to whole stamp pixels with a minimum of one', () => {
    expect(normalizeBitmapLineWidth(7)).toBe(7)
    expect(normalizeBitmapLineWidth(7.9)).toBe(7)
    expect(normalizeBitmapLineWidth(0)).toBe(1)
    expect(normalizeBitmapLineWidth(-3)).toBe(1)
    expect(normalizeBitmapLineWidth(Number.NaN)).toBe(1)
  })

  it('shares the brush default because width maps to stamp diameter', () => {
    expect(BITMAP_LINE_DEFAULT_WIDTH).toBe(BITMAP_BRUSH_DEFAULT_SIZE)
  })
})

describe('getBitmapLinePixels', () => {
  it('visits every integer pixel of a horizontal line including both ends', () => {
    expect(
      getBitmapLinePixels({ x: 1, y: 2 }, { x: 4, y: 2 }),
    ).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ])
  })

  it('keeps diagonal lines connected without gaps', () => {
    const pixels = getBitmapLinePixels({ x: 0, y: 0 }, { x: 3, y: 2 })
    expect(pixels[0]).toEqual({ x: 0, y: 0 })
    expect(pixels.at(-1)).toEqual({ x: 3, y: 2 })
    for (let index = 1; index < pixels.length; index += 1) {
      const prev = pixels[index - 1]!
      const current = pixels[index]!
      expect(Math.abs(current.x - prev.x) <= 1 && Math.abs(current.y - prev.y) <= 1).toBe(true)
    }
  })

  it('truncates fractional endpoints and collapses a click to one pixel', () => {
    expect(getBitmapLinePixels({ x: 1.9, y: 2.7 }, { x: 1.9, y: 2.7 })).toEqual([{ x: 1, y: 2 }])
  })
})

describe('bitmapLineStampOrigin', () => {
  it('anchors the stamp with ceil(diameter / 2) like the brush', () => {
    // 4px stamp: trunc(10.7) - 2 == 8, trunc(12.2) - 2 == 10.
    expect(bitmapLineStampOrigin(10.7, 12.2, 4)).toEqual({ x: 8, y: 10 })
    // 7px stamp radius is ceil(7 / 2) == 4.
    expect(bitmapLineStampOrigin(10.7, 12.2, 7)).toEqual({ x: 6, y: 8 })
  })
})

describe('drawBitmapLine', () => {
  it('stamps once for a click without calling vector path APIs', () => {
    const context = makeContext()
    const restore = stubDocument()
    try {
      drawBitmapLine(context as unknown as CanvasRenderingContext2D, { x: 10.7, y: 12.2 }, { x: 10.7, y: 12.2 }, 4, '#ff0000')
      expect(context.drawImage.mock.calls.length).toBe(1)
      const [, dx, dy] = context.drawImage.mock.calls[0] as unknown as [unknown, number, number]
      expect([dx, dy]).toEqual([8, 10])
      expect(context.beginPath).not.toHaveBeenCalled()
      expect(context.moveTo).not.toHaveBeenCalled()
      expect(context.lineTo).not.toHaveBeenCalled()
      expect(context.stroke).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('stamps every interpolated pixel of a drag with source-over and no smoothing', () => {
    const context = makeContext()
    const restore = stubDocument()
    try {
      drawBitmapLine(context as unknown as CanvasRenderingContext2D, { x: 0, y: 0 }, { x: 6, y: 0 }, 4, '#ff0000')
      // 7 Bresenham pixels over x = 0..6, each stamped at (x - 2, -2).
      expect(context.drawImage.mock.calls.length).toBe(7)
      expect(context.drawImage.mock.calls[0]?.slice(1)).toEqual([-2, -2])
      expect(context.drawImage.mock.calls.at(-1)?.slice(1)).toEqual([4, -2])
      expect(context.save).toHaveBeenCalledTimes(1)
      expect(context.restore).toHaveBeenCalledTimes(1)
      expect(context.globalCompositeOperation).toBe('source-over')
      expect(context.imageSmoothingEnabled).toBe(false)
      expect(context.lineTo).not.toHaveBeenCalled()
      expect(context.stroke).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('normalizes fractional widths to whole pixels', () => {
    const context = makeContext()
    const restore = stubDocument()
    try {
      drawBitmapLine(context as unknown as CanvasRenderingContext2D, { x: 5, y: 5 }, { x: 5, y: 5 }, 4.9, '#ff0000')
      const [, dx, dy] = context.drawImage.mock.calls[0] as unknown as [unknown, number, number]
      expect([dx, dy]).toEqual([3, 3])
    } finally {
      restore()
    }
  })

  it('matches a two-point brush stroke footprint', () => {
    const lineContext = makeContext()
    const brushContext = makeContext()
    const restore = stubDocument()
    try {
      const start = { x: 2, y: 3 }
      const end = { x: 9, y: 7 }
      drawBitmapLine(lineContext as unknown as CanvasRenderingContext2D, start, end, 5, '#00abcdef')
      drawBitmapBrushStroke(brushContext as unknown as CanvasRenderingContext2D, [start, end], 5, '#00abcdef')
      expect(lineContext.drawImage.mock.calls.length).toBe(brushContext.drawImage.mock.calls.length)
      expect(lineContext.drawImage.mock.calls.map(call => call.slice(1))).toEqual(
        brushContext.drawImage.mock.calls.map(call => call.slice(1)),
      )
    } finally {
      restore()
    }
  })
})

describe('bitmap line editor wiring', () => {
  const editorUrl = new URL('../src/Editor.svelte', import.meta.url)

  async function editorSource(): Promise<string> {
    return Bun.file(editorUrl).text()
  }

  function lineBranch(source: string): string {
    const marker = "if (bitmapTool === 'line') {"
    const start = source.indexOf(marker, source.indexOf('function drawBitmapShape'))
    if (start < 0) throw new Error('Missing line branch in drawBitmapShape')
    // Fail-closed block grew the branch (pre-validation + safe restore);
    // keep the window wide enough to include the stamp call.
    return source.slice(start, start + 2000)
  }

  it('routes the bitmap line preview and commit through the stamp helper', async () => {
    const source = await editorSource()
    expect(source).toContain('drawBitmapLine')
    expect(source).toContain("from './features/costumes/bitmap-line'")
    // Both the drag preview (drawBitmapDraft) and the pointer-up commit
    // (endBitmapPaint) replay through drawBitmapShape. A transparent fill
    // skips the commit without history (transparentNoop), so no empty undo
    // entry is recorded.
    expect(source).toMatch(/function drawBitmapDraft[\s\S]*drawBitmapShape\(event, false\)/)
    expect(source).toMatch(/if \(shapeDragged && !transparentNoop\)[\s\S]*drawBitmapShape\(event, true\)/)
    // The shared drawBitmapShape line branch is the single stamp entry point.
    const branch = lineBranch(source)
    expect(branch).toContain("drawBitmapLine(context, bitmapStart, end, brushSize, fillTransparent ? 'rgba(0, 0, 0, 0)' : paintColor)")
  })

  it('matches the reference single-color and shared-size contract', async () => {
    const source = await editorSource()
    const branch = lineBranch(source)
    // Single fill color + shared brush size; the outline color/width and the
    // gradient fill stay out of the line path.
    expect(branch).toContain('brushSize')
    expect(branch).toContain('paintColor')
    expect(branch).not.toContain('strokeWidth')
    expect(branch).not.toContain('strokeColor')
    expect(branch).not.toContain('bitmapPaintStyle')
    expect(branch).not.toContain('paintBitmapShape')
  })

  it('paints rect/oval exclusively: filled interior or outlined contour', async () => {
    const source = await editorSource()
    expect(source).toContain("drawBitmapShape as paintBitmapShape")
    expect(source).toContain('paintBitmapRectOvalExclusive')
    expect(source).toContain('resolveBitmapShapePaint')
    // Rect/oval preview still resolves Shift/Alt drags.
    expect(source).toMatch(/resolveShapeRect\(bitmapStart, end, readShapeModifiers\(event\)\)/)
    // Filled keeps the previous fill geometry byte-for-byte (fill-only via a
    // zero outline width) with the gradient-aware fill style.
    expect(source).toMatch(/context\.fillStyle = bitmapPaintStyle\(context, rect\.x, rect\.y, rect\.width, rect\.height\)[\s\S]*paintBitmapShape\(context, bitmapTool, \{ x: rect\.x, y: rect\.y \}, \{ x: rect\.x \+ rect\.width, y: rect\.y \+ rect\.height \}, 0\)/)
    // Outlined strokes the contour alone with the FILL style and the shared
    // brush size (reference `styleRect`/`styleOval` + `bitBrushSize` parity);
    // the stroke color/width stay out of bitmap shapes entirely.
    expect(source).toMatch(/context\.strokeStyle = bitmapPaintStyle\(context, rect\.x, rect\.y, rect\.width, rect\.height\)[\s\S]*paintBitmapRectOvalExclusive\([\s\S]*lineWidth: brushSize/)
    // Rect/oval commit margin follows the exclusive mode (filled ends at the
    // box, outlined extends half the shared brush size past it).
    expect(source).toContain('resolveBitmapShapeSelectionPadding(shapeMode, brushSize)')
    // The mode defaults to Filled, matching the reference initial state.
    expect(source).toMatch(/let bitmapShapeMode: BitmapShapeMode = 'filled'/)
  })

  it('sizes the committed line selection from the stamp size', async () => {
    const source = await editorSource()
    expect(source).toContain("const padding = bitmapTool === 'line'")
    expect(source).toContain('Math.trunc(brushSize)')
    // The committed line still selects its bounds and commits one history entry.
    expect(source).toMatch(/if \(shapeDragged && !transparentNoop\)[\s\S]*bitmapSelection = bitmapRect\(/)
    expect(source).toMatch(/if \(shouldCommit\) await saveBitmapCostume\('Bitmap edit saved'\)/)
  })
})
