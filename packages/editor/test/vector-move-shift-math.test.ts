// Vector move shifted-cache math unit (no browser, no DOMParser).
//
// Strict arithmetic contract of `shiftVectorMoveBounds` (the pointerup fast
// path reuses it instead of a Paper re-measure):
// - a world-space translate shifts document-space bounds/points by exactly
//   `total` (translation preserves width/height),
// - raw geometry attributes (`x`/`y` on rect/image/text/circle/ellipse) stay
//   untouched (the commit prepends a parent-frame `translate`),
// - path-like/`g` units expose world bounds as `x`/`y`, so those shift,
// - Alt-duplicate maps sorted clones to sorted sources, originals stay,
// - near-zero totals return the input unchanged (caller falls back to Paper).
import { describe, expect, it } from 'bun:test'
import { shiftVectorMoveBounds } from '../src/features/costumes/vector-move-preview'

const rect = (over: Record<string, unknown> = {}) => ({
  index: 0,
  tag: 'rect',
  boundsX: 10,
  boundsY: 20,
  boundsWidth: 30,
  boundsHeight: 40,
  x: 10,
  y: 20,
  width: 30,
  height: 40,
  ...over,
})

describe('shiftVectorMoveBounds math (unit, no browser)', () => {
  it('shifts rect bounds but leaves raw x/y/width/height untouched', () => {
    const out = shiftVectorMoveBounds([rect() as never], [0], { x: 3, y: -2 })
    const o = out[0] as unknown as Record<string, number>
    expect(o.boundsX).toBeCloseTo(13, 9)
    expect(o.boundsY).toBeCloseTo(18, 9)
    expect(o.boundsWidth).toBe(30)
    expect(o.boundsHeight).toBe(40)
    expect(o.x).toBe(10)
    expect(o.y).toBe(20)
  })

  it('shifts path world x/y plus every anchor point exactly', () => {
    const base = [
      {
        index: 0,
        tag: 'path',
        boundsX: 10,
        boundsY: 20,
        boundsWidth: 5,
        boundsHeight: 7,
        x: 10,
        y: 20,
        points: [
          { index: 0, x: 10, y: 20, kind: 'anchor' },
          { index: 1, x: 15, y: 27, kind: 'anchor' },
        ],
      },
    ]
    const out = shiftVectorMoveBounds(base as never, [0], { x: 3, y: -2 })
    const o = out[0] as unknown as {
      x: number
      y: number
      boundsX: number
      boundsY: number
      points: { x: number; y: number }[]
    }
    expect(o.x).toBeCloseTo(13, 9)
    expect(o.y).toBeCloseTo(18, 9)
    expect(o.boundsX).toBeCloseTo(13, 9)
    expect(o.boundsY).toBeCloseTo(18, 9)
    expect(o.points[0]!.x).toBeCloseTo(13, 9)
    expect(o.points[0]!.y).toBeCloseTo(18, 9)
    expect(o.points[1]!.x).toBeCloseTo(18, 9)
    expect(o.points[1]!.y).toBeCloseTo(25, 9)
  })

  it('shifts only the selected units', () => {
    const base = [rect({ index: 0 }), rect({ index: 1, boundsX: 100, boundsY: 100, x: 100, y: 100 })]
    const out = shiftVectorMoveBounds(base as never, [1], { x: 5, y: 5 })
    const a = out[0] as unknown as Record<string, number>
    const b = out[1] as unknown as Record<string, number>
    expect(a.boundsX).toBe(10)
    expect(b.boundsX).toBeCloseTo(105, 9)
    expect(b.x).toBe(100)
  })

  it('near-zero totals return the input unchanged', () => {
    const base = [rect() as never]
    const out = shiftVectorMoveBounds(base, [0], { x: 1e-10, y: -1e-10 })
    expect(out).toBe(base)
  })

  it('Alt-duplicate rebuilds the interleaved layout (clones sit after sources)', () => {
    // duplicateVectorUnits inserts each clone DIRECTLY AFTER its source, so
    // duplicating sources [0,2] of [A,B,C] yields [A,A',B,C,C'] — originals
    // shift right, they do not stay at stale indices.
    const base = [
      rect({ index: 0 }),
      rect({ index: 1, boundsX: 50, boundsY: 60, x: 50, y: 60 }),
      rect({ index: 2, boundsX: 90, boundsY: 10, x: 90, y: 10 }),
    ]
    const out = shiftVectorMoveBounds(base as never, [4, 1], { x: 7, y: 8 }, { duplicated: true, sources: [2, 0] })
    expect(out.length).toBe(5)
    const list = out as unknown as { index: number; boundsX: number; boundsY: number; x: number }[]
    expect(list.map((o) => o.index)).toEqual([0, 1, 2, 3, 4])
    // Originals untouched (clones carry the move): A stays, B shifts right.
    expect(list[0]!.boundsX).toBe(10)
    expect(list[2]!.boundsX).toBe(50)
    expect(list[2]!.index).toBe(2)
    expect(list[3]!.boundsX).toBe(90)
    expect(list[3]!.index).toBe(3)
    // Sorted clones [1,4] map to sorted sources [0,2].
    expect(list[1]!.boundsX).toBeCloseTo(17, 9)
    expect(list[1]!.boundsY).toBeCloseTo(28, 9)
    expect(list[4]!.boundsX).toBeCloseTo(97, 9)
    expect(list[4]!.boundsY).toBeCloseTo(18, 9)
  })

  it('Alt-duplicate fails closed to the input on unresolvable/clashing clones', () => {
    const base = [rect({ index: 0 }), rect({ index: 1 })]
    // Clone index outside the rebuilt list.
    expect(shiftVectorMoveBounds(base as never, [9], { x: 7, y: 8 }, { duplicated: true, sources: [0] })).toBe(base)
    // Source that does not resolve.
    expect(shiftVectorMoveBounds(base as never, [2], { x: 7, y: 8 }, { duplicated: true, sources: [5] })).toBe(base)
    // Zero-total duplicate returns the input (caller falls back to Paper).
    expect(shiftVectorMoveBounds(base as never, [2], { x: 0, y: 0 }, { duplicated: true, sources: [0] })).toBe(base)
  })

  it('group units shift world x/y; text units do not', () => {
    const base = [
      { index: 0, tag: 'g', boundsX: 1, boundsY: 2, boundsWidth: 3, boundsHeight: 4, x: 1, y: 2 },
      { index: 1, tag: 'text', boundsX: 10, boundsY: 20, boundsWidth: 30, boundsHeight: 5, x: 10, y: 20 },
    ]
    const out = shiftVectorMoveBounds(base as never, [0, 1], { x: 4, y: 6 })
    const g = out[0] as unknown as Record<string, number>
    const t = out[1] as unknown as Record<string, number>
    expect(g.x).toBeCloseTo(5, 9)
    expect(g.y).toBeCloseTo(8, 9)
    expect(t.x).toBe(10)
    expect(t.y).toBe(20)
    expect(t.boundsX).toBeCloseTo(14, 9)
    expect(t.boundsY).toBeCloseTo(26, 9)
  })
})
