import { describe, expect, it } from 'bun:test'
import {
  vectorLineEndpoints,
  vectorLineRect,
  vectorShapeInRectMarkup,
} from '../src/features/costumes/vector-shapes'

const paint = { defs: '', fill: '#ff0000' }

function savedLinePath(start: { x: number; y: number }, end: { x: number; y: number }) {
  const rect = vectorLineRect(start, end)
  return vectorShapeInRectMarkup({
    shape: 'line',
    rect,
    paint,
    strokeColor: '#000000',
    strokeWidth: 2,
    opacity: 100,
  })
}

describe('vector line drag direction', () => {
  it('keeps the drag vector instead of a normalized box', () => {
    expect(vectorLineRect({ x: 100, y: 80 }, { x: 20, y: 30 })).toEqual({
      x: 100,
      y: 80,
      width: -80,
      height: -50,
    })
  })

  it('distinguishes forward and reverse drags', () => {
    const forward = vectorLineRect({ x: 10, y: 20 }, { x: 90, y: 70 })
    const reverse = vectorLineRect({ x: 90, y: 70 }, { x: 10, y: 20 })
    expect(forward).not.toEqual(reverse)
    expect(vectorLineEndpoints(forward)).toEqual({ x1: 10, y1: 20, x2: 90, y2: 70 })
    expect(vectorLineEndpoints(reverse)).toEqual({ x1: 90, y1: 70, x2: 10, y2: 20 })
  })

  it('round-trips endpoints through the stored rect', () => {
    const cases = [
      [{ x: 10, y: 20 }, { x: 90, y: 70 }],
      [{ x: 90, y: 70 }, { x: 10, y: 20 }],
      [{ x: 90, y: 20 }, { x: 10, y: 70 }],
      [{ x: 10, y: 70 }, { x: 90, y: 20 }],
      [{ x: 50, y: 20 }, { x: 10, y: 20 }],
      [{ x: 10, y: 20 }, { x: 50, y: 20 }],
      [{ x: 10, y: 50 }, { x: 10, y: 10 }],
    ] as const
    for (const [start, end] of cases) {
      expect(vectorLineEndpoints(vectorLineRect(start, end))).toEqual({
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
      })
    }
  })
})

describe('vector line preview matches committed markup', () => {
  it('saves the path from drag start to drag end, even reversed', () => {
    expect(savedLinePath({ x: 10, y: 20 }, { x: 90, y: 70 })).toContain('M10 20 L90 70')
    expect(savedLinePath({ x: 90, y: 70 }, { x: 10, y: 20 })).toContain('M90 70 L10 20')
  })

  it('keeps horizontal and vertical reverse drags on the same axis', () => {
    expect(savedLinePath({ x: 50, y: 20 }, { x: 10, y: 20 })).toContain('M50 20 L10 20')
    expect(savedLinePath({ x: 10, y: 50 }, { x: 10, y: 10 })).toContain('M10 50 L10 10')
  })

  it('uses the same endpoint math as the preview component', async () => {
    const source = await Bun.file(
      new URL('../src/features/CostumeEditor/VectorShapePreview.svelte', import.meta.url),
    ).text()
    expect(source).toContain('vectorLineEndpoints')
    // The committed markup helper is the single source of truth for endpoints.
    const rect = vectorLineRect({ x: 90, y: 70 }, { x: 10, y: 20 })
    const endpoints = vectorLineEndpoints(rect)
    const markup = vectorShapeInRectMarkup({
      shape: 'line',
      rect,
      paint,
      strokeColor: '#000000',
      strokeWidth: 2,
      opacity: 100,
    })
    expect(markup).toContain(`M${endpoints.x1} ${endpoints.y1} L${endpoints.x2} ${endpoints.y2}`)
  })
})

describe('vector line draft wiring', () => {
  it('routes line preview and save through the direction-preserving rect', async () => {
    const source = await Bun.file(
      new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url),
    ).text()
    expect(source).toContain('vectorLineRect')
    const lineRectUses = source.split('\n').filter((line) => line.includes('vectorLineRect('))
    // Once for the live preview rect, once for the pointer-up save rect.
    expect(lineRectUses.length).toBeGreaterThanOrEqual(2)
    const normalizedForLine = source
      .split('\n')
      .filter((line) => line.includes('normalizedRect(draft.start, draft.current)'))
    expect(normalizedForLine).toEqual([])
  })
})
