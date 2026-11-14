import { describe, expect, it } from 'bun:test'
import paper from 'paper'
import {
  buildVectorBrushFillPathData,
  vectorBrushFillMarkup,
  vectorBrushFillRadius,
} from '../src/features/costumes/vector-brush-fill'

function makeScope() {
  const scope = new paper.PaperScope()
  scope.setup(new scope.Size(480, 360))
  return scope
}

describe('vector brush fill outline', () => {
  it('refuses empty input and non-finite width', () => {
    expect(buildVectorBrushFillPathData([], 10)).toBe('')
    expect(buildVectorBrushFillPathData([{ x: 0, y: 0 }], Number.NaN)).toBe('')
    expect(vectorBrushFillMarkup({ pathData: '', fill: '#ff0000', opacity: 100 })).toBe('')
  })

  it('matches the existing single-dot radius (max(1, w) / 2)', () => {
    expect(vectorBrushFillRadius(10)).toBe(5)
    expect(vectorBrushFillRadius(0.2)).toBe(0.5)
    const d = buildVectorBrushFillPathData([{ x: 50, y: 60 }], 20)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    // Two semicircle arcs form the dot.
    expect((d.match(/A/g) ?? []).length).toBe(2)
    expect(d).toContain('40 60')
    expect(d).toContain('60 60')
  })

  it('builds a constant-width round-capped outline for a straight stroke', () => {
    const d = buildVectorBrushFillPathData(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      20,
    )
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    // Left edge at y=+10, right edge at y=-10 for a horizontal stroke.
    expect(d).toContain('0 10')
    expect(d).toContain('100 10')
    expect(d).toContain('100 -10')
    expect(d).toContain('0 -10')
    // Round caps are exact semicircle arcs with r=10, bulging outward
    // (sweep 0 from the left edge to the right edge and back).
    expect(d).toContain('A10 10')
    expect(d).toContain('0 0 0')

    const scope = makeScope()
    try {
      const path = new scope.Path(d)
      try {
        expect(path.bounds.width).toBeCloseTo(120, 0)
        expect(path.bounds.height).toBeCloseTo(20, 0)
        expect(path.contains(new scope.Point(110, 0))).toBe(true)
        expect(path.contains(new scope.Point(-10, 0))).toBe(true)
        expect(path.contains(new scope.Point(50, 0))).toBe(true)
        expect(path.contains(new scope.Point(50, 30))).toBe(false)
      } finally {
        path.remove()
      }
    } finally {
      scope.remove()
    }
  })

  it('keeps width constant on an L-shaped stroke and stays closed', () => {
    const d = buildVectorBrushFillPathData(
      [
        { x: 0, y: 0 },
        { x: 60, y: 0 },
        { x: 60, y: 40 },
      ],
      20,
    )
    expect(d.endsWith('Z')).toBe(true)
    expect((d.match(/A/g) ?? []).length).toBe(2)

    const scope = makeScope()
    try {
      const path = new scope.Path(d)
      try {
        // Straight stretch keeps +/-10 offset: sample mid of first leg.
        expect(path.bounds.height).toBeCloseTo(60, 0)
        expect(path.bounds.width).toBeCloseTo(80, 0)
        // Round tip extends one radius beyond the last anchor.
        expect(path.bounds.bottom).toBeGreaterThanOrEqual(49)
        expect(path.bounds.top).toBeLessThanOrEqual(-10)
        // Interior of the stroke hits; far away misses.
        expect(path.contains(new scope.Point(30, 0))).toBe(true)
        expect(path.contains(new scope.Point(60, 20))).toBe(true)
        expect(path.contains(new scope.Point(200, 200))).toBe(false)
      } finally {
        path.remove()
      }
    } finally {
      scope.remove()
    }
  })

  it('ignores duplicate consecutive points instead of collapsing', () => {
    const d = buildVectorBrushFillPathData(
      [
        { x: 10, y: 10 },
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 10 },
      ],
      12,
    )
    expect(d.endsWith('Z')).toBe(true)
    expect(d).toContain('A6 6')
  })

  it('emits fill-only markup matching the editor opacity scale', () => {
    const d = buildVectorBrushFillPathData(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      10,
    )
    const markup = vectorBrushFillMarkup({ pathData: d, fill: '#00ff00', opacity: 50 })
    expect(markup).toContain(`d="${d}"`)
    expect(markup).toContain('fill="#00ff00"')
    expect(markup).toContain('stroke="none"')
    expect(markup).toContain('opacity="0.5"')
  })
})
