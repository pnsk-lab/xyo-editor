import { describe, expect, it, mock } from 'bun:test'
import {
  compositePendingBitmapShapePreview,
  copyPendingShapePreviewBase,
  paintPendingBitmapShapePreview,
  resolvePendingBitmapShapePreview,
  resolvePendingShapePreviewStyle,
  restorePendingShapePreviewBase,
  type PendingShapePreviewDraw,
} from '../src/features/costumes/bitmap-pending-shape-preview'
import { createPendingBitmapShape } from '../src/features/costumes/bitmap-pending-shape'

function solidStyle(overrides: Record<string, unknown> = {}) {
  return {
    fill: '#ff0000',
    secondary: '#ffffff',
    gradient: 'solid',
    fillTransparent: false,
    secondaryTransparent: false,
    brushSize: 6,
    ...overrides,
  }
}

function shapeOf(box: { x: number; y: number; width: number; height: number }, mode: 'filled' | 'outlined' = 'filled', kind: 'rect' | 'oval' = 'rect', style = solidStyle()) {
  return createPendingBitmapShape(kind, box, mode, style as never)
}

function mockGradient() {
  return { addColorStop: mock() }
}

function mockContext(overrides: Record<string, unknown> = {}) {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: mock(),
    strokeRect: mock(),
    beginPath: mock(),
    ellipse: mock(),
    fill: mock(),
    stroke: mock(),
    createLinearGradient: mock(() => mockGradient()),
    createRadialGradient: mock(() => mockGradient()),
    putImageData: mock(),
    getImageData: mock(() => ({ width: 0, height: 0, data: new Uint8ClampedArray(0) })),
    ...overrides,
  }
}

describe('resolvePendingBitmapShapePreview (pure, DOM-free)', () => {
  it('resolves a filled rect draw with the exact box', () => {
    const resolved = resolvePendingBitmapShapePreview(shapeOf({ x: 2, y: 3, width: 20, height: 10 }), { width: 100, height: 80 })
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(resolved.draw.box).toEqual({ x: 2, y: 3, width: 20, height: 10 })
    expect(resolved.draw.mode).toBe('filled')
    expect(resolved.draw.brushSize).toBe(6)
  })

  it('clamps an overflowing box to the canvas address range', () => {
    const resolved = resolvePendingBitmapShapePreview(shapeOf({ x: -50, y: -20, width: 200, height: 100 }), { width: 100, height: 80 })
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(resolved.draw.box).toEqual({ x: -50, y: -20, width: 100, height: 80 })
  })

  it('reports noop for transparent solid fill (transparent outline included)', () => {
    const resolved = resolvePendingBitmapShapePreview(
      shapeOf({ x: 2, y: 3, width: 20, height: 10 }, 'filled', 'rect', solidStyle({ fillTransparent: true })),
      { width: 100, height: 80 },
    )
    expect(resolved).toEqual({ kind: 'noop', reason: 'invisible-fill' })
  })

  it('reports noop zero-brush for an outlined shape with no width', () => {
    const resolved = resolvePendingBitmapShapePreview(
      shapeOf({ x: 2, y: 3, width: 20, height: 10 }, 'outlined', 'oval', solidStyle({ brushSize: 0 })),
      { width: 100, height: 80 },
    )
    expect(resolved).toEqual({ kind: 'noop', reason: 'zero-brush' })
  })

  it('reports noop empty-box for zero-area boxes (clicks never paint)', () => {
    const resolved = resolvePendingBitmapShapePreview(shapeOf({ x: 5, y: 5, width: 0, height: 10 }), { width: 100, height: 80 })
    expect(resolved).toEqual({ kind: 'noop', reason: 'empty-box' })
  })

  it('refuses malformed shapes without throwing', () => {
    const canvas = { width: 100, height: 80 }
    expect(resolvePendingBitmapShapePreview(undefined, canvas)).toEqual({ kind: 'refused', reason: 'bad-input' })
    expect(resolvePendingBitmapShapePreview(null, canvas)).toEqual({ kind: 'refused', reason: 'bad-input' })
    expect(resolvePendingBitmapShapePreview({ kind: 'line' } as never, canvas).kind).toBe('refused')
    expect(resolvePendingBitmapShapePreview({ kind: 'rect', box: { x: 0, y: 0, width: 1, height: 1 }, mode: 'dotted', style: solidStyle() } as never, canvas)).toEqual({
      kind: 'refused',
      reason: 'bad-input',
    })
    expect(
      resolvePendingBitmapShapePreview(
        { kind: 'rect', box: { x: Number.NaN, y: 0, width: 1, height: 1 }, mode: 'filled', style: solidStyle() } as never,
        canvas,
      ),
    ).toEqual({ kind: 'refused', reason: 'bad-input' })
    expect(
      resolvePendingBitmapShapePreview(
        { kind: 'rect', box: { x: 0, y: 0, width: 1, height: 1 }, mode: 'filled', style: solidStyle({ fill: 'not-a-color' }) } as never,
        canvas,
      ),
    ).toEqual({ kind: 'refused', reason: 'bad-input' })
    expect(
      resolvePendingBitmapShapePreview(
        { kind: 'rect', box: { x: 0, y: 0, width: 1, height: 1 }, mode: 'filled', style: solidStyle({ gradient: 'diagonal' }) } as never,
        canvas,
      ),
    ).toEqual({ kind: 'refused', reason: 'bad-input' })
    expect(
      resolvePendingBitmapShapePreview(
        { kind: 'rect', box: { x: 0, y: 0, width: 1, height: 1 }, mode: 'filled', style: solidStyle({ brushSize: Number.NaN }) } as never,
        canvas,
      ),
    ).toEqual({ kind: 'refused', reason: 'bad-input' })
  })

  it('refuses empty and oversized canvases before any copy', () => {
    const shape = shapeOf({ x: 0, y: 0, width: 10, height: 10 })
    expect(resolvePendingBitmapShapePreview(shape, { width: 0, height: 80 })).toEqual({ kind: 'refused', reason: 'empty-canvas' })
    expect(resolvePendingBitmapShapePreview(shape, { width: 100.5, height: 80 })).toEqual({ kind: 'refused', reason: 'bad-input' })
    expect(resolvePendingBitmapShapePreview(shape, undefined)).toEqual({ kind: 'refused', reason: 'bad-input' })
    // Over the raster-safe side cap (65535) and over the area budget (16M px).
    expect(resolvePendingBitmapShapePreview(shape, { width: 70000, height: 2 })).toEqual({ kind: 'refused', reason: 'oversized' })
    expect(resolvePendingBitmapShapePreview(shape, { width: 5000, height: 5000 })).toEqual({ kind: 'refused', reason: 'oversized' })
  })
})

describe('copyPendingShapePreviewBase (immutable copy)', () => {
  it('copies bytes so mutating the output never touches the input', () => {
    const base = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]) }
    const copy = copyPendingShapePreviewBase(base)
    expect(copy?.width).toBe(2)
    expect(copy?.height).toBe(1)
    expect(Array.from(copy!.data)).toEqual([255, 0, 0, 255, 0, 0, 0, 0])
    copy!.data[0] = 1
    expect(base.data[0]).toBe(255)
  })

  it('fails closed on malformed, short, and oversized inputs without throwing', () => {
    expect(copyPendingShapePreviewBase(undefined)).toBeUndefined()
    expect(copyPendingShapePreviewBase(null)).toBeUndefined()
    expect(copyPendingShapePreviewBase({ width: 0, height: 4, data: new Uint8ClampedArray(0) })).toBeUndefined()
    expect(copyPendingShapePreviewBase({ width: 2, height: 2, data: new Uint8ClampedArray(4) })).toBeUndefined()
    expect(copyPendingShapePreviewBase({ width: 2, height: 2, data: 'nope' as never })).toBeUndefined()
    expect(copyPendingShapePreviewBase({ width: 70000, height: 2, data: new Uint8ClampedArray(0) })).toBeUndefined()
  })
})

describe('resolvePendingShapePreviewStyle (mock context)', () => {
  const draw: PendingShapePreviewDraw = {
    kind: 'rect',
    box: { x: 2, y: 3, width: 20, height: 10 },
    mode: 'filled',
    fill: '#ff0000',
    secondary: '#0000ff',
    gradient: 'solid',
    fillTransparent: false,
    secondaryTransparent: false,
    brushSize: 6,
  }

  it('resolves solid opaque to the hex and transparent to clear rgba', () => {
    const context = mockContext()
    expect(resolvePendingShapePreviewStyle(context as never, draw)).toEqual({ paint: '#ff0000', lineWidth: 6 })
    expect(resolvePendingShapePreviewStyle(context as never, { ...draw, fillTransparent: true })).toEqual({
      paint: 'rgba(0, 0, 0, 0)',
      lineWidth: 6,
    })
  })

  it('resolves linear gradients spanning the box', () => {
    const context = mockContext()
    const style = resolvePendingShapePreviewStyle(context as never, { ...draw, gradient: 'horizontal' })
    expect(style?.lineWidth).toBe(6)
    expect(context.createLinearGradient).toHaveBeenCalledTimes(1)
    expect(context.createLinearGradient).toHaveBeenCalledWith(2, 3, 22, 3)
    const vertical = mockContext()
    resolvePendingShapePreviewStyle(vertical as never, { ...draw, gradient: 'vertical' })
    expect(vertical.createLinearGradient).toHaveBeenCalledWith(2, 3, 2, 13)
  })

  it('resolves radial gradients centered on the box with the longest-side radius', () => {
    const context = mockContext()
    resolvePendingShapePreviewStyle(context as never, { ...draw, gradient: 'radial' })
    expect(context.createRadialGradient).toHaveBeenCalledWith(12, 8, 0, 12, 8, 10)
  })

  it('returns undefined (never throws) on unusable contexts and draws', () => {
    expect(resolvePendingShapePreviewStyle(undefined, draw)).toBeUndefined()
    expect(resolvePendingShapePreviewStyle({} as never, draw)).toBeUndefined()
    expect(resolvePendingShapePreviewStyle(mockContext() as never, undefined)).toBeUndefined()
    expect(resolvePendingShapePreviewStyle(mockContext() as never, { ...draw, box: { x: 0, y: 0, width: 0, height: 5 } })).toBeUndefined()
    const throwing = mockContext({ createLinearGradient: mock(() => { throw new Error('tainted') }) })
    expect(resolvePendingShapePreviewStyle(throwing as never, { ...draw, gradient: 'horizontal' })).toBeUndefined()
  })
})

describe('paintPendingBitmapShapePreview (shared painter, no duplicate code)', () => {
  it('filled paints fill only for rect', () => {
    const context = mockContext()
    const draw: PendingShapePreviewDraw = {
      kind: 'rect', box: { x: 2, y: 3, width: 20, height: 10 }, mode: 'filled',
      fill: '#ff0000', secondary: '#ffffff', gradient: 'solid',
      fillTransparent: false, secondaryTransparent: false, brushSize: 6,
    }
    expect(paintPendingBitmapShapePreview(context as never, draw)).toBe(true)
    expect(context.fillStyle).toBe('#ff0000')
    expect(context.fillRect).toHaveBeenCalledTimes(1)
    expect(context.strokeRect).not.toHaveBeenCalled()
    expect(context.stroke).not.toHaveBeenCalled()
  })

  it('outlined strokes with the fill style and shared brush size for oval', () => {
    const context = mockContext()
    const draw: PendingShapePreviewDraw = {
      kind: 'oval', box: { x: 2, y: 3, width: 20, height: 10 }, mode: 'outlined',
      fill: '#00ff00', secondary: '#ffffff', gradient: 'solid',
      fillTransparent: false, secondaryTransparent: false, brushSize: 8,
    }
    expect(paintPendingBitmapShapePreview(context as never, draw)).toBe(true)
    expect(context.strokeStyle).toBe('#00ff00')
    expect(context.lineWidth).toBe(8)
    expect(context.stroke).toHaveBeenCalledTimes(1)
    expect(context.fill).not.toHaveBeenCalled()
    expect(context.fillRect).not.toHaveBeenCalled()
  })

  it('returns false (never throws) on bad inputs', () => {
    expect(paintPendingBitmapShapePreview(undefined, undefined)).toBe(false)
    const context = mockContext()
    expect(paintPendingBitmapShapePreview(context as never, undefined)).toBe(false)
    expect(paintPendingBitmapShapePreview(context as never, { kind: 'rect', box: { x: 0, y: 0, width: 0, height: 0 }, mode: 'filled', fill: '#ff0000', secondary: '#fff', gradient: 'solid', fillTransparent: false, secondaryTransparent: false, brushSize: 1 } as never)).toBe(false)
  })
})

describe('restorePendingShapePreviewBase (2x restoration)', () => {
  it('restores via putImageData and fails closed without throwing', () => {
    const context = mockContext()
    const frame = { width: 2, height: 1, data: new Uint8ClampedArray(8) }
    expect(restorePendingShapePreviewBase(context as never, frame as never)).toBe(true)
    expect(context.putImageData).toHaveBeenCalledTimes(1)
    expect(restorePendingShapePreviewBase(undefined, frame as never)).toBe(false)
    expect(restorePendingShapePreviewBase(context as never, undefined)).toBe(false)
    const throwing = mockContext({ putImageData: mock(() => { throw new Error('tainted') }) })
    expect(restorePendingShapePreviewBase(throwing as never, frame as never)).toBe(false)
  })
})

describe('compositePendingBitmapShapePreview fail-closed paths (Bun, no ImageData global)', () => {
  const shape = shapeOf({ x: 2, y: 3, width: 20, height: 10 })
  const base = { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) }

  it('returns undefined (never throws) on missing context, refused shapes, and base mismatches', () => {
    const context = mockContext({ canvas: { width: 100, height: 80 } })
    expect(compositePendingBitmapShapePreview(undefined, base, shape)).toBeUndefined()
    expect(compositePendingBitmapShapePreview(context as never, base, undefined)).toBeUndefined()
    expect(
      compositePendingBitmapShapePreview(context as never, base, { kind: 'rect', box: { x: 0, y: 0, width: 1, height: 1 }, mode: 'dotted', style: solidStyle() } as never),
    ).toBeUndefined()
    expect(compositePendingBitmapShapePreview(context as never, { width: 50, height: 80, data: new Uint8ClampedArray(50 * 80 * 4) }, shape)).toBeUndefined()
    expect(compositePendingBitmapShapePreview(context as never, undefined, shape)).toBeUndefined()
  })
})
