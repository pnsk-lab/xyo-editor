// Tests for the independent vector reshape add/delete helper.
// Uses real Paper.js geometry (no browser/DOM): core functions operate on
// `paper.Item` trees, and the SVG tag guards plus wrapper early-returns are
// covered with lightweight element stubs so no DOMParser is required.

import { describe, expect, it } from 'bun:test'
import paper from 'paper'
import {
  addPaperPoint,
  canDeletePaperPoint,
  collectEditablePaths,
  deletePaperPoint,
  deleteVectorPathPoint,
  editableAnchorCount,
  expandShapesToPaths,
  isPathPointEditableElement,
  resolvePaperPoint,
  addVectorPathPoint,
} from '../src/features/costumes/vector-path-points'
import { remapReshapeSelectionAfterSlotDelete } from '../src/features/costumes/vector-multi-point-selection'

function makeScope() {
  const scope = new paper.PaperScope()
  scope.setup(new scope.Size(480, 360))
  return scope
}

function straightLine(scope: paper.PaperScope, points: Array<[number, number]> = [[0, 0], [50, 0], [100, 0]]) {
  const path = new scope.Path()
  for (const [x, y] of points) path.add(new scope.Point(x, y))
  return path as paper.Path
}

function cubicPath(scope: paper.PaperScope) {
  // Same shape as the reshape browser test: two cubic segments in a row.
  return new scope.Path('M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30') as paper.Path
}

function stubElement(tag: string) {
  return { tagName: tag } as unknown as Element
}

describe('isPathPointEditableElement', () => {
  it.each(['path', 'g', 'rect', 'ellipse', 'circle', 'line', 'polyline', 'polygon'])(
    'allows %s',
    (tag) => {
      expect(isPathPointEditableElement(stubElement(tag))).toBe(true)
    },
  )

  it.each(['text', 'image', 'defs', 'metadata', 'title'])('refuses %s', (tag) => {
    expect(isPathPointEditableElement(stubElement(tag))).toBe(false)
  })
})

describe('resolvePaperPoint ordering', () => {
  it('matches the paper-vector flattened scheme (anchor, in-handle, out-handle)', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      // s0: anchor + out; s1: anchor + in + out; s2: anchor + in.
      const kinds = [0, 1, 2, 3, 4, 5, 6].map((index) => {
        const resolved = resolvePaperPoint(path as paper.Item, index)
        return resolved?.kind === 'control'
          ? `control:${(resolved as { controlRole: string }).controlRole}`
          : resolved?.kind
      })
      expect(kinds).toEqual(['anchor', 'control:out', 'anchor', 'control:in', 'control:out', 'anchor', 'control:in'])
      expect(resolvePaperPoint(path as paper.Item, 7)).toBeUndefined()
      expect(resolvePaperPoint(path as paper.Item, -1)).toBeUndefined()
    } finally {
      scope.remove()
    }
  })
})

describe('collectEditablePaths', () => {
  it('finds paths nested in groups while ignoring shape items until expanded', () => {
    const scope = makeScope()
    try {
      const first = straightLine(scope)
      const second = straightLine(scope, [[0, 100], [50, 100], [100, 100]])
      const inner = new scope.Group([first])
      const outer = new scope.Group([inner, second])
      expect(collectEditablePaths(outer as paper.Item)).toHaveLength(2)
      expect(editableAnchorCount(outer as paper.Item)).toBe(6)

      const shape = new scope.Shape.Ellipse({
        center: new scope.Point(200, 200),
        radius: new scope.Point(30, 20),
      })
      expect(collectEditablePaths(shape as unknown as paper.Item)).toHaveLength(0)
      const converted = expandShapesToPaths(shape as unknown as paper.Item)
      expect(collectEditablePaths(converted)).toHaveLength(1)
      expect(editableAnchorCount(converted)).toBeGreaterThan(0)
    } finally {
      scope.remove()
    }
  })
})

describe('deletePaperPoint with real Paper.js', () => {
  it('removes a middle anchor and keeps the surviving positions', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope)
      expect(deletePaperPoint(path as paper.Item, 1)).toBe(true)
      expect(path.segments.length).toBe(2)
      expect([path.segments[0]!.point.x, path.segments[0]!.point.y]).toEqual([0, 0])
      expect([path.segments[1]!.point.x, path.segments[1]!.point.y]).toEqual([100, 0])
    } finally {
      scope.remove()
    }
  })

  it('re-aims cubic neighbours across the joined curve (direction kept, length = joined * ratio)', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      // Oracle: two 30-long collinear cubics join into one 60-long curve;
      // reshape delete re-sizes each surviving handle to 60 * 0.3902628565.
      expect(deletePaperPoint(path as paper.Item, 2)).toBe(true)
      expect(path.segments.length).toBe(2)
      const joined = (path.segments[0] as unknown as { curve: paper.Curve }).curve.length
      expect(joined).toBeCloseTo(60, 4)
      const expected = joined * 0.3902628565
      const out = path.segments[0]!.handleOut as paper.Point
      const rev = path.segments[1]!.handleIn as paper.Point
      // Exact handle geometry: direction preserved (collinear, opposing), magnitude exact.
      expect(out.length).toBeCloseTo(expected, 6)
      expect(rev.length).toBeCloseTo(expected, 6)
      expect(out.normalize().dot(new scope.Point(1, 0))).toBeCloseTo(1, 6)
      expect(rev.normalize().dot(new scope.Point(-1, 0))).toBeCloseTo(1, 6)
      // Approximate pixel coverage: the joined curve spans the full gap with
      // finite samples and no collapsed/NaN geometry.
      expect(path.length).toBeCloseTo(60, 4)
      expect(Number.isFinite(path.length)).toBe(true)
      for (let i = 0; i <= 8; i++) {
        const at = path.getPointAt((path.length * i) / 8)
        expect(Number.isFinite(at.x)).toBe(true)
        expect(Number.isFinite(at.y)).toBe(true)
      }
      expect(path.pathData).not.toContain('NaN')
      expect(path.segments[0]!.point.x).toBeCloseTo(10, 6)
      expect(path.segments[1]!.point.x).toBeCloseTo(70, 6)
    } finally {
      scope.remove()
    }
  })

  it('leaves zero handles alone so straight spans stay straight (no non-finite scaling)', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope)
      expect(deletePaperPoint(path as paper.Item, 1)).toBe(true)
      expect(path.segments.length).toBe(2)
      expect((path.segments[0]!.handleOut as paper.Point).length).toBe(0)
      expect((path.segments[1]!.handleIn as paper.Point).length).toBe(0)
      expect(path.length).toBeCloseTo(100, 6)
      expect(path.pathData).not.toContain('NaN')
      // Still a straight span: midpoint sample sits on the line.
      const middle = path.getPointAt(path.length / 2)
      expect(middle.x).toBeCloseTo(50, 4)
      expect(middle.y).toBeCloseTo(0, 6)
    } finally {
      scope.remove()
    }
  })

  it('re-aims quadratic neighbours across the joined curve', () => {
    const scope = makeScope()
    try {
      const makeQuad = () => new scope.Path('M0 0 Q50 80 100 0 L150 0') as paper.Path
      const oracle = makeQuad()
      // Flattened: s0 anchor(0) + out(1); s1 anchor(2) ... delete middle anchor.
      const beforeDir = (oracle.segments[0]!.handleOut as paper.Point).normalize()
      oracle.removeSegment(1)
      // Joined length read post-removal, pre-adjustment: the exact input the
      // re-aim scales by.
      const joinedAtRemoval = (oracle.segments[0] as unknown as { curve: paper.Curve }).curve.length
      const path = makeQuad()
      expect(deletePaperPoint(path as paper.Item, 2)).toBe(true)
      expect(path.segments.length).toBe(2)
      const out = path.segments[0]!.handleOut as paper.Point
      expect(out.length).toBeCloseTo(joinedAtRemoval * 0.3902628565, 6)
      expect(out.normalize().dot(beforeDir)).toBeCloseTo(1, 6)
      expect(path.pathData).not.toContain('NaN')
      expect(Number.isFinite(path.length)).toBe(true)
      // Approximate pixel coverage: the merged curve still spans the gap.
      expect(path.segments[0]!.point.x).toBeCloseTo(0, 6)
      expect(path.segments[1]!.point.x).toBeCloseTo(150, 6)
      for (let i = 0; i <= 8; i++) {
        const at = path.getPointAt((path.length * i) / 8)
        expect(Number.isFinite(at.x)).toBe(true)
        expect(Number.isFinite(at.y)).toBe(true)
      }
    } finally {
      scope.remove()
    }
  })

  it('clears the dangling handle when deleting the first anchor of an open path', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      // Flattened index 0 = first anchor; its removal leaves s1 as the new
      // start, whose incoming handle no longer spans any curve.
      expect(deletePaperPoint(path as paper.Item, 0)).toBe(true)
      expect(path.segments.length).toBe(2)
      expect((path.segments[0]!.handleIn as paper.Point).length).toBe(0)
      expect(path.pathData).not.toContain('NaN')
      expect([path.segments[0]!.point.x, path.segments[0]!.point.y]).toEqual([40, 30])
    } finally {
      scope.remove()
    }
  })

  it('clears the dangling handle when deleting the last anchor of an open path', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      // Flattened: s2 anchor is index 5. Its removal leaves s1 as the new end.
      expect(deletePaperPoint(path as paper.Item, 5)).toBe(true)
      expect(path.segments.length).toBe(2)
      expect((path.segments[1]!.handleOut as paper.Point).length).toBe(0)
      expect(path.pathData).not.toContain('NaN')
      expect([path.segments[1]!.point.x, path.segments[1]!.point.y]).toEqual([40, 30])
    } finally {
      scope.remove()
    }
  })

  it('re-aims both sides when deleting a middle anchor of a closed loop', () => {
    const scope = makeScope()
    try {
      // 4-anchor closed loop: cubic head (collinear handles) + straight tail.
      // Flattened: s0 anchor(0)+out(1); s1 anchor(2)+in(3)+out(4);
      // s2 anchor(5)+in(6); s3 anchor(7).
      const makeLoop = () => {
        const loop = cubicPath(scope)
        loop.add(new scope.Point(100, 30))
        loop.closed = true
        return loop
      }
      const loop = makeLoop()
      const beforeDir = (loop.segments[0]!.handleOut as paper.Point).normalize()
      const afterDir = (loop.segments[2]!.handleIn as paper.Point).normalize()
      expect(deletePaperPoint(loop as paper.Item, 2)).toBe(true)
      expect(loop.segments.length).toBe(3)
      expect(loop.closed).toBe(true)
      // Removal joins s0(10,30) -> s2(70,30): a straight 60-long span.
      const out = loop.segments[0]!.handleOut as paper.Point
      const rev = loop.segments[1]!.handleIn as paper.Point
      expect(out.length).toBeCloseTo(60 * 0.3902628565, 6)
      expect(rev.length).toBeCloseTo(60 * 0.3902628565, 6)
      expect(out.normalize().dot(beforeDir)).toBeCloseTo(1, 6)
      expect(rev.normalize().dot(afterDir)).toBeCloseTo(1, 6)
      expect(loop.pathData).not.toContain('NaN')
    } finally {
      scope.remove()
    }
  })

  it('clears the wrap handle when deleting the first anchor of a closed loop', () => {
    const scope = makeScope()
    try {
      const loop = cubicPath(scope)
      loop.add(new scope.Point(100, 30))
      loop.closed = true
      // Positional end rule: no segment precedes index 0, so the surviving
      // first segment loses its incoming (wrap) handle.
      expect(deletePaperPoint(loop as paper.Item, 0)).toBe(true)
      expect(loop.segments.length).toBe(3)
      expect(loop.closed).toBe(true)
      expect((loop.segments[0]!.handleIn as paper.Point).length).toBe(0)
      expect(loop.pathData).not.toContain('NaN')
    } finally {
      scope.remove()
    }
  })

  it('refuses control slots, unknown indices and degenerate deletions', () => {
    const scope = makeScope()
    try {
      const curved = cubicPath(scope)
      expect(canDeletePaperPoint(curved as paper.Item, 1)).toEqual({ ok: false, reason: 'control-point' })
      expect(deletePaperPoint(curved as paper.Item, 1)).toBe(false)
      expect(curved.segments.length).toBe(3)

      const line = straightLine(scope, [[0, 0], [100, 0]])
      expect(canDeletePaperPoint(line as paper.Item, 0)).toEqual({ ok: false, reason: 'minimum-segments' })
      expect(deletePaperPoint(line as paper.Item, 0)).toBe(false)

      const triangle = new scope.Path({ closed: true })
      triangle.add(new scope.Point(0, 0))
      triangle.add(new scope.Point(100, 0))
      triangle.add(new scope.Point(50, 80))
      expect(canDeletePaperPoint(triangle as paper.Item, 0)).toEqual({ ok: false, reason: 'minimum-segments' })

      const rect = new scope.Path.Rectangle({ point: [0, 0], size: [100, 80] })
      expect(deletePaperPoint(rect as paper.Item, 0)).toBe(true)
      expect(rect.segments.length).toBe(3)

      expect(canDeletePaperPoint(curved as paper.Item, 99)).toEqual({ ok: false, reason: 'not-found' })
    } finally {
      scope.remove()
    }
  })

  it('deletes across grouped paths using flattened indices', () => {
    const scope = makeScope()
    try {
      const first = straightLine(scope)
      const second = straightLine(scope, [[0, 100], [50, 100], [100, 100]])
      const group = new scope.Group([first, second])
      // Indices 0-2 belong to the first path, 3-5 to the second.
      expect(deletePaperPoint(group as paper.Item, 4)).toBe(true)
      expect(first.segments.length).toBe(3)
      expect(second.segments.length).toBe(2)
      expect([second.segments[1]!.point.x, second.segments[1]!.point.y]).toEqual([100, 100])
    } finally {
      scope.remove()
    }
  })

  it('keeps flattened selection remap exact when an end delete clears a handle slot', () => {
    // Contract for the DOM bulk path (`deleteVectorPathPoints`): a cleared
    // dangling handle is one more vanished slot, recorded contiguously, so
    // replaying (index, slots) in descending order keeps every survivor.
    // pathA: cubic, 3 anchors = 7 slots [0..6]; pathB: straight = slots [7..9].
    const runCase = (deletedFlattened: number, expectedIndex: number, expectedSlots: number) => {
      const scope = makeScope()
      try {
        const first = cubicPath(scope)
        const second = straightLine(scope, [[0, 100], [50, 100], [100, 100]])
        const group = new scope.Group([first, second])
        expect(deletePaperPoint(group as paper.Item, deletedFlattened)).toBe(true)
        // pathA keeps 4 slots (own slots minus the cleared end handle), so
        // pathB's anchors now live at flattened [4, 5, 6].
        for (const anchor of [4, 5, 6]) {
          expect(resolvePaperPoint(group as paper.Item, anchor)?.kind).toBe('anchor')
        }
        expect(resolvePaperPoint(group as paper.Item, 7)).toBeUndefined()
        // Replaying the recorded bookkeeping maps the old pathB selection exactly.
        expect(remapReshapeSelectionAfterSlotDelete([7, 8, 9], expectedIndex, expectedSlots)).toEqual([4, 5, 6])
      } finally {
        scope.remove()
      }
    }
    // Deleting pathA's last anchor (flattened 5 = anchor + in-handle): the new
    // last anchor's dangling out-handle (slot 4) is cleared too -> {4, 3}.
    runCase(5, 4, 3)
    // Deleting pathA's first anchor (flattened 0 = anchor + out-handle): the
    // new first anchor's dangling in-handle is cleared too -> {0, 3}.
    runCase(0, 0, 3)
    // Deleting pathA's middle anchor (flattened 2): both neighbours survive
    // and are re-aimed, so only the 3 own slots vanish -> {2, 3}.
    runCase(2, 2, 3)
  })
})

describe('addPaperPoint with real Paper.js', () => {
  it('inserts a midpoint anchor on a straight path shape', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope, [[0, 0], [100, 0]])
      const before = path.length
      const result = addPaperPoint(path as paper.Item, scope, 50, 1, 8)
      expect(result.added).toBe(true)
      expect(result.pointIndex).toBe(1)
      expect(path.segments.length).toBe(3)
      expect(path.segments[1]!.point.x).toBeCloseTo(50, 6)
      expect(path.segments[1]!.point.y).toBeCloseTo(0, 6)
      expect(path.length).toBeCloseTo(before, 2)
    } finally {
      scope.remove()
    }
  })

  it('subdivides existing curves without changing their shape', () => {
    const scope = makeScope()
    try {
      const path = cubicPath(scope)
      const beforeLength = path.length
      // Quarter-length sits on the first cubic segment, not on an anchor.
      const middle = path.getPointAt(path.length / 4)
      const result = addPaperPoint(path as paper.Item, scope, middle.x, middle.y, 8)
      expect(result.added).toBe(true)
      expect(path.segments.length).toBe(4)
      expect(path.length).toBeCloseTo(beforeLength, 2)
      // The new anchor carries handles, so the curve stays smooth.
      const created = path.segments[result.pointIndex!]!
      expect((created.handleIn as paper.Point).length + (created.handleOut as paper.Point).length).toBeGreaterThan(0)
    } finally {
      scope.remove()
    }
  })

  it('adds to the nearest grouped path and leaves siblings untouched', () => {
    const scope = makeScope()
    try {
      const first = straightLine(scope)
      const firstData = first.pathData
      const second = straightLine(scope, [[0, 100], [100, 100]])
      const group = new scope.Group([first, second])
      const result = addPaperPoint(group as paper.Item, scope, 50, 101, 8)
      expect(result.added).toBe(true)
      expect(first.pathData).toBe(firstData)
      expect(second.segments.length).toBe(3)
      // Flattened index 3: first path owns 0-1, the new anchor is the middle of the second.
      expect(result.pointIndex).toBe(4)
    } finally {
      scope.remove()
    }
  })

  it('snaps to an existing anchor instead of stacking a duplicate', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope)
      const result = addPaperPoint(path as paper.Item, scope, 0.2, 0.1, 6)
      expect(result).toEqual({ added: false, pointIndex: 0, reason: 'already-anchor' })
      expect(path.segments.length).toBe(3)
    } finally {
      scope.remove()
    }
  })

  it('refuses points far from any curve without mutating', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope)
      const result = addPaperPoint(path as paper.Item, scope, 200, 200, 8)
      expect(result).toEqual({ added: false, reason: 'too-far' })
      expect(path.segments.length).toBe(3)
    } finally {
      scope.remove()
    }
  })
})

describe('SVG wrapper guards', () => {
  it('refuses non-path elements before touching Paper or the DOM', async () => {
    await expect(deleteVectorPathPoint(stubElement('text'), 0)).resolves.toEqual({
      deleted: false,
      reason: 'not-editable',
    })
    await expect(deleteVectorPathPoint(stubElement('image'), 1)).resolves.toEqual({
      deleted: false,
      reason: 'not-editable',
    })
    await expect(addVectorPathPoint(stubElement('text'), 10, 10)).resolves.toEqual({
      added: false,
      reason: 'not-editable',
    })
    await expect(addVectorPathPoint(stubElement('image'), 10, 10)).resolves.toEqual({
      added: false,
      reason: 'not-editable',
    })
  })
})
