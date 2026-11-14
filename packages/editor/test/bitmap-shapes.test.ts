import { describe, expect, it, mock } from 'bun:test'
import { drawBitmapShape } from '../src/features/costumes/bitmap-shapes'

describe('bitmap shape outlines', () => {
  for (const shape of ['oval', 'rect', 'line'] as const) {
    it(`uses the requested width for ${shape}`, () => {
      const context = { lineWidth: 1, beginPath: mock(), moveTo: mock(), lineTo: mock(), stroke: mock(), fill: mock(), ellipse: mock(), fillRect: mock(), strokeRect: mock() }
      drawBitmapShape(context as unknown as CanvasRenderingContext2D, shape, { x: 0, y: 0 }, { x: 30, y: 20 }, 12)
      expect(context.lineWidth).toBe(12)
      expect(shape === 'rect' ? context.strokeRect : context.stroke).toHaveBeenCalledTimes(1)
    })

    it(`does not stroke ${shape} at zero width`, () => {
      const context = { lineWidth: 5, beginPath: mock(), moveTo: mock(), lineTo: mock(), stroke: mock(), fill: mock(), ellipse: mock(), fillRect: mock(), strokeRect: mock() }
      drawBitmapShape(context as unknown as CanvasRenderingContext2D, shape, { x: 0, y: 0 }, { x: 30, y: 20 }, 0)
      expect(context.stroke).not.toHaveBeenCalled()
      expect(context.strokeRect).not.toHaveBeenCalled()
      if (shape !== 'line') expect(shape === 'rect' ? context.fillRect : context.fill).toHaveBeenCalledTimes(1)
    })
  }
})
