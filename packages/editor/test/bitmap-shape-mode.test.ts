import { describe, expect, it, mock } from 'bun:test'
import {
  normalizeBitmapShapeMode,
  paintBitmapRectOvalExclusive,
  resolveBitmapShapePaint,
  resolveBitmapShapeSelectionPadding,
} from '../src/features/costumes/bitmap-shape-mode'

describe('bitmap rect/oval exclusive paint mode', () => {
  it('defaults to filled for unknown values', () => {
    expect(normalizeBitmapShapeMode(undefined)).toBe('filled')
    expect(normalizeBitmapShapeMode('outlined')).toBe('outlined')
    expect(normalizeBitmapShapeMode('filled')).toBe('filled')
  })

  it('filled paints the interior and ignores the outline', () => {
    const plan = resolveBitmapShapePaint(
      'filled',
      { fillTransparent: false, secondaryTransparent: false, strokeTransparent: true },
      'solid',
      0,
    )
    expect(plan).toEqual({ paintFill: true, paintStroke: false, noop: false })
  })

  it('filled solid-transparent is a no-op even with an opaque outline', () => {
    const plan = resolveBitmapShapePaint(
      'filled',
      { fillTransparent: true, secondaryTransparent: false, strokeTransparent: false },
      'solid',
      8,
    )
    expect(plan.noop).toBe(true)
    expect(plan.paintFill).toBe(false)
  })

  it('filled gradient with one transparent end still paints', () => {
    const plan = resolveBitmapShapePaint(
      'filled',
      { fillTransparent: true, secondaryTransparent: false, strokeTransparent: false },
      'horizontal',
      8,
    )
    expect(plan.noop).toBe(false)
  })

  it('filled gradient with both ends transparent is a no-op', () => {
    const plan = resolveBitmapShapePaint(
      'filled',
      { fillTransparent: true, secondaryTransparent: true, strokeTransparent: false },
      'radial',
      8,
    )
    expect(plan.noop).toBe(true)
  })

  it('outlined paints the contour with the fill color and ignores the stroke', () => {
    const plan = resolveBitmapShapePaint(
      'outlined',
      { fillTransparent: false, secondaryTransparent: false, strokeTransparent: true },
      'solid',
      6,
    )
    expect(plan).toEqual({ paintFill: false, paintStroke: true, noop: false })
  })

  it('outlined transparent fill is a no-op even with an opaque stroke', () => {
    const plan = resolveBitmapShapePaint(
      'outlined',
      { fillTransparent: true, secondaryTransparent: false, strokeTransparent: false },
      'solid',
      6,
    )
    expect(plan.noop).toBe(true)
  })

  it('outlined gradient with one transparent end still paints', () => {
    const plan = resolveBitmapShapePaint(
      'outlined',
      { fillTransparent: true, secondaryTransparent: false, strokeTransparent: true },
      'horizontal',
      6,
    )
    expect(plan.noop).toBe(false)
  })

  it('outlined gradient with both ends transparent is a no-op', () => {
    const plan = resolveBitmapShapePaint(
      'outlined',
      { fillTransparent: true, secondaryTransparent: true, strokeTransparent: false },
      'radial',
      6,
    )
    expect(plan.noop).toBe(true)
  })

  it('outlined zero brush size is a no-op', () => {
    const plan = resolveBitmapShapePaint(
      'outlined',
      { fillTransparent: false, secondaryTransparent: false, strokeTransparent: false },
      'solid',
      0,
    )
    expect(plan.noop).toBe(true)
  })

  it('selection padding follows the exclusive mode', () => {
    expect(resolveBitmapShapeSelectionPadding('filled', 12)).toBe(1)
    expect(resolveBitmapShapeSelectionPadding('outlined', 12)).toBe(7)
    expect(resolveBitmapShapeSelectionPadding('outlined', 0)).toBe(1)
  })

  it('filled draws fill only for rect', () => {
    const context = { fillRect: mock(), strokeRect: mock(), beginPath: mock(), ellipse: mock(), fill: mock(), stroke: mock() }
    paintBitmapRectOvalExclusive(context as unknown as CanvasRenderingContext2D, 'rect', 2, 3, 20, 10, 'filled', {
      fillStyle: '#ff0000',
      strokeStyle: '#0000ff',
      lineWidth: 8,
    })
    expect(context.fillRect).toHaveBeenCalledTimes(1)
    expect(context.strokeRect).not.toHaveBeenCalled()
    expect(context.stroke).not.toHaveBeenCalled()
  })

  it('outlined draws stroke only for rect (stroke carries the fill color)', () => {
    const context = { fillRect: mock(), strokeRect: mock(), beginPath: mock(), ellipse: mock(), fill: mock(), stroke: mock(), lineWidth: 1 }
    paintBitmapRectOvalExclusive(context as unknown as CanvasRenderingContext2D, 'rect', 2, 3, 20, 10, 'outlined', {
      fillStyle: '#ff0000',
      strokeStyle: '#ff0000',
      lineWidth: 8,
    })
    expect(context.strokeRect).toHaveBeenCalledTimes(1)
    expect(context.fillRect).not.toHaveBeenCalled()
    expect(context.fill).not.toHaveBeenCalled()
    expect(context.lineWidth).toBe(8)
  })

  it('filled draws fill only for oval', () => {
    const context = { fillRect: mock(), strokeRect: mock(), beginPath: mock(), ellipse: mock(), fill: mock(), stroke: mock() }
    paintBitmapRectOvalExclusive(context as unknown as CanvasRenderingContext2D, 'oval', 2, 3, 20, 10, 'filled', {
      fillStyle: '#ff0000',
      strokeStyle: '#0000ff',
      lineWidth: 8,
    })
    expect(context.fill).toHaveBeenCalledTimes(1)
    expect(context.stroke).not.toHaveBeenCalled()
    expect(context.fillRect).not.toHaveBeenCalled()
  })

  it('outlined draws stroke only for oval (stroke carries the fill color)', () => {
    const context = { fillRect: mock(), strokeRect: mock(), beginPath: mock(), ellipse: mock(), fill: mock(), stroke: mock(), lineWidth: 1 }
    paintBitmapRectOvalExclusive(context as unknown as CanvasRenderingContext2D, 'oval', 2, 3, 20, 10, 'outlined', {
      fillStyle: '#ff0000',
      strokeStyle: '#ff0000',
      lineWidth: 5,
    })
    expect(context.stroke).toHaveBeenCalledTimes(1)
    expect(context.fill).not.toHaveBeenCalled()
    expect(context.lineWidth).toBe(5)
  })
})
