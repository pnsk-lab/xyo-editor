import { describe, expect, it, mock } from 'bun:test'
import { drawBitmapEraserSegment, drawBitmapEraserStroke, forEachLinePoint } from '../src/features/costumes/bitmap-eraser'
import { drawBitmapBrushStroke } from '../src/features/costumes/bitmap-brush'

// Wiring coverage for the transparent bitmap brush: a transparent (`null`)
// brush erases with destination-out at the same brush size (reference
// brush-tool.js draws a null-color brush with destination-out), reusing the
// existing eraser stamp path. The transparent line stays a no-op: the
// reference line tool has no destination-out path and forces an opaque
// default color on activation instead.
describe('transparent brush editor wiring', () => {
  const editorUrl = new URL('../src/Editor.svelte', import.meta.url)

  async function editorSource(): Promise<string> {
    return Bun.file(editorUrl).text()
  }

  function paperStrokeBranch(source: string): string {
    const marker = 'function drawBitmapPaperStroke'
    const start = source.indexOf(marker)
    if (start < 0) throw new Error('Missing drawBitmapPaperStroke in Editor.svelte')
    // Slice to the next sibling function so comment growth above the stamp
    // calls (fail-closed gate, reference notes) cannot truncate the branch.
    const next = source.indexOf('\n  function ', start + marker.length)
    return next < 0 ? source.slice(start) : source.slice(start, next)
  }

  function noopGuard(source: string): string {
    const marker = 'const transparentNoop ='
    const start = source.indexOf(marker)
    if (start < 0) throw new Error('Missing transparentNoop guard in Editor.svelte')
    // Slice through the shouldCommit line so added ternary branches
    // (rect/oval exclusive mode) stay inside the window.
    const anchor = 'let shouldCommit'
    const anchorStart = source.indexOf(anchor, start)
    if (anchorStart < 0) throw new Error('Missing shouldCommit after transparentNoop in Editor.svelte')
    const lineEnd = source.indexOf('\n', anchorStart)
    return source.slice(start, lineEnd < 0 ? source.length : lineEnd)
  }

  function lineBranch(source: string): string {
    const marker = "if (bitmapTool === 'line') {"
    const start = source.indexOf(marker, source.indexOf('function drawBitmapShape'))
    if (start < 0) throw new Error('Missing line branch in drawBitmapShape')
    // The fail-closed comments above the stamp call grew past the old window;
    // keep it wide enough to include the stamp call (same width as the bitmap
    // line wiring test).
    return source.slice(start, start + 2000)
  }

  it('routes a transparent brush through the eraser stamp at the brush size', async () => {
    const source = await editorSource()
    // Match the import by symbol + module, not exact formatting/order, so
    // sibling helper imports (segment/validate) do not break the test.
    expect(source).toContain('drawBitmapEraserStroke')
    expect(source).toContain("from './features/costumes/bitmap-eraser'")
    const branch = paperStrokeBranch(source)
    // Transparent brush erases at the same brush size (not the eraser size).
    expect(branch).toContain('if (fillTransparent) {')
    expect(branch).toContain('drawBitmapEraserStroke(context, bitmapPaperPoints, brushSize)')
    // The opaque brush path keeps the solid fill color (no transparent rgba stamp).
    expect(branch).toContain('drawBitmapBrushStroke(context, bitmapPaperPoints, brushSize, paintColor)')
    expect(branch).not.toContain("fillTransparent ? 'rgba(0, 0, 0, 0)'")
  })

  it('keeps the transparent brush out of the no-op guard so it commits history', async () => {
    const source = await editorSource()
    const guard = noopGuard(source)
    // Only line/rect/oval consult the no-op helper; brush always commits.
    expect(guard).toContain("bitmapTool === 'line'")
    expect(guard).not.toContain("bitmapTool === 'brush'")
    expect(source).toMatch(/let shouldCommit = bitmapTool !== 'select' && \(!isShape \|\| shapeDragged\) && !transparentNoop/)
  })

  it('keeps the transparent line as a no-op stamp without an erase path', async () => {
    const source = await editorSource()
    const branch = lineBranch(source)
    // The line still stamps a transparent rgba pixel with source-over (no
    // destination-out), which endBitmapPaint then skips without history.
    expect(branch).toContain("drawBitmapLine(context, bitmapStart, end, brushSize, fillTransparent ? 'rgba(0, 0, 0, 0)' : paintColor)")
    expect(branch).not.toContain('drawBitmapEraserStroke')
  })
})

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

// Strict helper checks for the reused erase path: the wiring above only pins
// names, so pin the actual semantics here (destination-out, exact first+last
// segment, opaque contrast) against the real helpers.
describe('transparent brush eraser helpers (strict)', () => {
  it('erases with destination-out along the whole drag at the brush size', () => {
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

  it('erases one incremental segment with destination-out and exact first+last stamps', () => {
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
      drawBitmapEraserSegment(context as unknown as CanvasRenderingContext2D, { x: 0, y: 0 }, { x: 6, y: 0 }, 4)
      expect(seen).toContain('destination-out')
      // 4px mark radius is ceil(4 / 2) == 2: first stamp at (-2, -2), last at (4, -2).
      expect(context.drawImage.mock.calls.length).toBe(7)
      expect(context.drawImage.mock.calls[0]?.slice(1)).toEqual([-2, -2])
      expect(context.drawImage.mock.calls.at(-1)?.slice(1)).toEqual([4, -2])
    } finally {
      restore()
    }
  })

  it('walks exact first+last endpoints inclusive for the shared pixel walk', () => {
    const visited: Array<[number, number]> = []
    forEachLinePoint({ x: 0, y: 0 }, { x: 6, y: 0 }, (x, y) => visited.push([x, y]))
    expect(visited[0]).toEqual([0, 0])
    expect(visited.at(-1)).toEqual([6, 0])
    expect(visited.length).toBe(7)
  })

  it('keeps the opaque brush on source-over as the transparent contrast', () => {
    const context = makeContext()
    const restore = stubDocument(context)
    try {
      drawBitmapBrushStroke(context as unknown as CanvasRenderingContext2D, [{ x: 0, y: 0 }, { x: 6, y: 0 }], 4, '#ff0000')
      expect(context.globalCompositeOperation).toBe('source-over')
      expect(context.drawImage.mock.calls.length).toBe(7)
    } finally {
      restore()
    }
  })
})
