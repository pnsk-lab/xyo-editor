// Nested-island exact-geometry coverage (fail-first for V-5 matrix).
//
// Limited subset only: straight, simple, laminar (disjoint or strictly
// nested, never touching) contours. Outer -> hole -> island -> hole must
// alternate unfilled/filled by parity (evenodd) or winding sum (nonzero with
// reversed winding); only the innermost child-free unfilled level becomes a
// `hole`, outer rings containing an island stay `ambiguous` (a solid overlay
// would cover the island). Crossings / contact / self-intersection / partial
// overlap / degenerate contours stay fail-closed, unknown CSS/clip/mask
// mixing stays fail-closed caller-side, and sanitize gates stay absolute.

import { describe, expect, it } from 'bun:test';
import {
  classifyHolePoint,
  contourBounds,
  parseStraightContours,
} from '../src/features/costumes/vector-fill-hole-geometry';
import {
  auditStraightNesting,
  resolveNestedHole,
} from '../src/features/costumes/vector-fill-hole-nested';

// Straight simple fixtures (all H/V, all coordinates original to this file).
const OUTER = 'M0 0H200V200H0Z';
const HOLE = 'M40 40H160V160H40Z';
const ISLAND = 'M80 80H120V120H80Z';
const NEST3 = `${OUTER} ${HOLE} ${ISLAND}`;

const OUTER4 = 'M0 0H200V200H0Z';
const HOLE4 = 'M30 30H170V170H30Z';
const ISLAND4 = 'M60 60H140V140H60Z';
const INNER4 = 'M90 90H110V110H90Z';
const NEST4 = `${OUTER4} ${HOLE4} ${ISLAND4} ${INNER4}`;

// Reversed-winding twins (each level alternates direction): nonzero cancels
// to unfilled at every even depth, same as evenodd parity.
const HOLE_REV = 'M40 40V160H160V40H40Z';
const NEST3_NONZERO = `${OUTER} ${HOLE_REV} ${ISLAND}`;
const HOLE4_REV = 'M30 30V170H170V30H30Z';
const INNER4_REV = 'M90 90V110H110V90H90Z';
const NEST4_NONZERO = `${OUTER4} ${HOLE4_REV} ${ISLAND4} ${INNER4_REV}`;
// Same-direction doubling: nonzero sums to filled (no hole anywhere).
const NEST4_SAME_DIR = `${OUTER4} ${HOLE4} ${ISLAND4} ${INNER4}`;

describe('nested island audit (exact limited subset)', () => {
  it('accepts laminar 3-4 nesting, refuses touch/overlap/self-touch', () => {
    expect(auditStraightNesting(parseStraightContours(NEST3)!).ok).toBe(true);
    expect(auditStraightNesting(parseStraightContours(NEST4)!).ok).toBe(true);
    const touch = parseStraightContours('M0 0H200V200H0Z M20 20H60V60H20Z M60 20H100V60H60Z')!;
    expect(auditStraightNesting(touch).ok).toBe(false);
    const overlap = parseStraightContours('M0 0H100V100H0Z M50 50H150V150H50Z')!;
    expect(auditStraightNesting(overlap).ok).toBe(false);
    // Bow-tie hole self-intersects: the whole file refuses.
    const bowtie = parseStraightContours('M0 0H200V200H0Z M40 40L160 40L40 160L160 160Z')!;
    expect(auditStraightNesting(bowtie).ok).toBe(false);
  });

  it('resolves the innermost pair directly (hole = smallest, outer = parent)', () => {
    const contours = parseStraightContours(NEST4)!;
    const areas = contours.map((c) => {
      let sum = 0;
      for (let i = 0; i < c.points.length; i += 1) {
        const a = c.points[i]!;
        const b = c.points[(i + 1) % c.points.length]!;
        sum += a.x * b.y - b.x * a.y;
      }
      return sum / 2;
    });
    const resolved = resolveNestedHole({ contours, containing: [0, 1, 2, 3], areas });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.holeIndex).toBe(3);
      expect(resolved.outerIndex).toBe(2);
    }
  });
});

describe('nested island classification (evenodd)', () => {
  it('3-level: island is filled, outer ring with island stays ambiguous', () => {
    // Island interior: depth 3, painted.
    const island = classifyHolePoint({ pathData: NEST3, point: { x: 100, y: 100 }, fillRule: 'evenodd' });
    expect(island.kind).toBe('filled');
    // Hole ring outside the island but inside the hole: unfilled, yet the
    // claimed hole would cover the island -> fail-closed.
    expect(classifyHolePoint({ pathData: NEST3, point: { x: 50, y: 100 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // Body and outside are unchanged.
    expect(classifyHolePoint({ pathData: NEST3, point: { x: 10, y: 10 }, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyHolePoint({ pathData: NEST3, point: { x: 250, y: 250 }, fillRule: 'evenodd' }).kind).toBe('outside');
  });

  it('4-level: innermost hole resolves, middle rings stay safe', () => {
    const inner = classifyHolePoint({ pathData: NEST4, point: { x: 100, y: 100 }, fillRule: 'evenodd' });
    expect(inner.kind).toBe('hole');
    if (inner.kind === 'hole') {
      expect(inner.holeIndex).toBe(3);
      expect(inner.outerIndex).toBe(2);
      expect(inner.containing).toEqual([0, 1, 2, 3]);
      expect(inner.holeBounds).toEqual(contourBounds(parseStraightContours(NEST4)![3]!));
    }
    // Island ring (inside the island, outside the inner hole): painted.
    expect(classifyHolePoint({ pathData: NEST4, point: { x: 70, y: 100 }, fillRule: 'evenodd' }).kind).toBe('filled');
    // Outer hole ring (contains the island): ambiguous, never a hole.
    expect(classifyHolePoint({ pathData: NEST4, point: { x: 40, y: 100 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // Body / outside unchanged.
    expect(classifyHolePoint({ pathData: NEST4, point: { x: 10, y: 10 }, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyHolePoint({ pathData: NEST4, point: { x: 250, y: 100 }, fillRule: 'evenodd' }).kind).toBe('outside');
  });
});

describe('nested island classification (nonzero + reversed winding)', () => {
  it('alternating winding cancels to a hole; same direction stays filled', () => {
    const inner = classifyHolePoint({ pathData: NEST4_NONZERO, point: { x: 100, y: 100 }, fillRule: 'nonzero' });
    expect(inner.kind).toBe('hole');
    if (inner.kind === 'hole') {
      expect(inner.holeIndex).toBe(3);
      expect(inner.outerIndex).toBe(2);
    }
    // Same-direction nesting sums to filled under nonzero (no hole).
    expect(classifyHolePoint({ pathData: NEST4_SAME_DIR, point: { x: 100, y: 100 }, fillRule: 'nonzero' }).kind).toBe('filled');
    // 3-level alternating: island filled, outer ring ambiguous (same as evenodd).
    expect(classifyHolePoint({ pathData: NEST3_NONZERO, point: { x: 100, y: 100 }, fillRule: 'nonzero' }).kind).toBe('filled');
    expect(classifyHolePoint({ pathData: NEST3_NONZERO, point: { x: 50, y: 100 }, fillRule: 'nonzero' }).kind).toBe('ambiguous');
  });

  it('evenodd ignores winding (reversed data still resolves)', () => {
    const inner = classifyHolePoint({ pathData: NEST4_NONZERO, point: { x: 100, y: 100 }, fillRule: 'evenodd' });
    expect(inner.kind).toBe('hole');
  });
});

describe('nested fail-closed gates (no guessing)', () => {
  it('touching / overlapping / self-intersecting nests refuse', () => {
    const touchD = 'M0 0H200V200H0Z M20 20H60V60H20Z M60 20H100V60H60Z';
    expect(classifyHolePoint({ pathData: touchD, point: { x: 40, y: 40 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    const overlapD = 'M0 0H100V100H0Z M50 50H150V150H50Z';
    expect(classifyHolePoint({ pathData: overlapD, point: { x: 75, y: 75 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    const bowtieD = 'M0 0H200V200H0Z M40 40L160 40L40 160L160 160Z';
    expect(classifyHolePoint({ pathData: bowtieD, point: { x: 100, y: 100 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
  });

  it('edge proximity refuses even for the innermost hole', () => {
    expect(
      classifyHolePoint({ pathData: NEST4, point: { x: 90.2, y: 100 }, fillRule: 'evenodd', tolerance: 0.5 }).kind,
    ).toBe('ambiguous');
  });

  it('single contours are no-ops, curves stay unsupported', () => {
    expect(classifyHolePoint({ pathData: 'M0 0H100V100H0Z', point: { x: 50, y: 50 }, fillRule: 'evenodd' }).kind).toBe('outside');
    expect(
      classifyHolePoint({ pathData: 'M0 0C10 10 20 20 30 30 M40 40H50V50H40Z', point: { x: 45, y: 45 } }).kind,
    ).toBe('unsupported');
  });
});
