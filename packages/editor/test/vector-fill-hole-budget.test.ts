// Straight-hole compute-budget coverage (independent-audit follow-up).
//
// The 20k-char `d` gate alone cannot bound hover work: short `H`/`V` runs add
// a vertex in ~2 chars, and the Paper probe calls the pure helpers with raw
// point arrays that bypass the char gate entirely. These tests pin the
// fail-closed iteration budgets (point caps + O(n^2) audit budget) instead of
// wall-clock time:
// - small/medium fixtures keep their exact verdicts (no regression);
// - over-cap / over-budget inputs refuse as `ambiguous` (fail-closed), never
//   as a best-effort safe claim (`hole`/`filled`/`outside`) from a partially
//   scanned contour set;
// - direct contour-array calls (char-gate bypass) enforce the same caps;
// - large/small-scale shapes and self-touch keep their precision;
// - a 20k-char high-vertex / deep-nesting `d` classified 10x (hover frames)
//   stays `ambiguous` every frame within a loose hang guard.

import { describe, expect, it } from 'bun:test';
import {
  HOLE_GEOMETRY_AUDIT_BUDGET,
  HOLE_GEOMETRY_MAX_CHARS,
  HOLE_GEOMETRY_MAX_POINTS_PER_CONTOUR,
  HOLE_GEOMETRY_MAX_POINTS_TOTAL,
  classifyHolePoint,
  contoursOverlap,
  distanceToContours,
  parseStraightContours,
} from '../src/features/costumes/vector-fill-hole-geometry';
import {
  NESTED_AUDIT_BUDGET,
  NESTED_MAX_POINTS_PER_CONTOUR,
  NESTED_MAX_POINTS_TOTAL,
  auditStraightNesting,
  resolveNestedHole,
} from '../src/features/costumes/vector-fill-hole-nested';

const SIMPLE_DONUT = 'M0 0H100V100H0Z M20 20H60V60H20Z';

function circlePoints(cx: number, cy: number, r: number, n: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k < n; k += 1) {
    const a = (2 * Math.PI * k) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Zigzag strip polygon: simple (non-self-touching), n vertices, compact text. */
function zigzagHole(n: number): string {
  let d = 'M0 0H2000V2000H0Z M100 100';
  for (let k = 1; k < n; k += 1) {
    const x = k % 2 === 0 ? 100 : 300;
    const y = 100 + k;
    d += `L${x} ${y}`;
  }
  return `${d}Z`;
}

/** Deeply nested squares: laminar, 4 vertices each, compact text. */
function nestedSquares(count: number, size: number): string {
  const parts: string[] = [];
  for (let k = 0; k < count; k += 1) {
    const o = k;
    const s = size - k * 2;
    parts.push(`M${o} ${o}H${o + s}V${o + s}H${o}Z`);
  }
  return parts.join(' ');
}

describe('straight-hole budgets are reviewed constants', () => {
  it('pins the cap values shared with the curved helper', () => {
    expect(HOLE_GEOMETRY_MAX_POINTS_PER_CONTOUR).toBe(2048);
    expect(HOLE_GEOMETRY_MAX_POINTS_TOTAL).toBe(6000);
    expect(HOLE_GEOMETRY_AUDIT_BUDGET).toBe(400000);
    expect(NESTED_MAX_POINTS_PER_CONTOUR).toBe(HOLE_GEOMETRY_MAX_POINTS_PER_CONTOUR);
    expect(NESTED_MAX_POINTS_TOTAL).toBe(HOLE_GEOMETRY_MAX_POINTS_TOTAL);
    expect(NESTED_AUDIT_BUDGET).toBe(HOLE_GEOMETRY_AUDIT_BUDGET);
  });
});

describe('small/medium fixtures are unchanged by the budgets', () => {
  it('donut / nesting / overlap verdicts match the pre-budget contract', () => {
    expect(parseStraightContours(SIMPLE_DONUT)?.length).toBe(2);
    expect(classifyHolePoint({ pathData: SIMPLE_DONUT, point: { x: 40, y: 40 }, fillRule: 'evenodd' }).kind).toBe('hole');
    expect(classifyHolePoint({ pathData: SIMPLE_DONUT, point: { x: 10, y: 10 }, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyHolePoint({ pathData: SIMPLE_DONUT, point: { x: 200, y: 200 }, fillRule: 'evenodd' }).kind).toBe('outside');
    expect(contoursOverlap(parseStraightContours(SIMPLE_DONUT)!)).toBe(false);
    expect(auditStraightNesting(parseStraightContours(SIMPLE_DONUT)!).ok).toBe(true);
    const overlap = parseStraightContours('M0 0H100V100H0Z M50 50H150V150H50Z')!;
    expect(contoursOverlap(overlap)).toBe(true);
    expect(auditStraightNesting(overlap).ok).toBe(false);
    const touch = parseStraightContours('M0 0H200V200H0Z M20 20H60V60H20Z M60 20H100V60H60Z')!;
    expect(auditStraightNesting(touch).ok).toBe(false);
    const bowtie = parseStraightContours('M0 0H200V200H0Z M40 40L160 40L40 160L160 160Z')!;
    expect(auditStraightNesting(bowtie).ok).toBe(false);
  });
});

describe('per-contour point cap via a char-gate-passing d', () => {
  it('refuses a 20k-char high-vertex hole as ambiguous (fail-closed)', () => {
    const d = zigzagHole(HOLE_GEOMETRY_MAX_POINTS_PER_CONTOUR + 150);
    expect(d.length).toBeLessThanOrEqual(HOLE_GEOMETRY_MAX_CHARS);
    const contours = parseStraightContours(d);
    expect(contours?.length).toBe(2);
    expect(contours![1]!.points.length).toBeGreaterThan(HOLE_GEOMETRY_MAX_POINTS_PER_CONTOUR);
    const audit = auditStraightNesting(contours!);
    expect(audit.ok).toBe(false);
    if (!audit.ok) expect(audit.reason).toContain('cap');
    // A point deep inside the zigzag band must not become a hole claim.
    const verdict = classifyHolePoint({ pathData: d, point: { x: 200, y: 1500 }, fillRule: 'evenodd' });
    expect(verdict.kind).toBe('ambiguous');
    if (verdict.kind === 'ambiguous') expect(verdict.reason).toContain('cap');
    // Far-outside points also refuse instead of certifying `outside` from a
    // partially scanned set.
    expect(classifyHolePoint({ pathData: d, point: { x: 5000, y: 5000 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // The budgeted overlap helper degrades to overlap (callers map it to
    // `ambiguous`), never to a best-effort `false`.
    expect(contoursOverlap(contours!)).toBe(true);
    expect(Number.isNaN(distanceToContours(contours!, { x: 200, y: 1500 }))).toBe(true);
  });
});

describe('overall input cap bypass via raw contour arrays', () => {
  it('raw point arrays cannot bypass the total cap (no d involved)', () => {
    const contours = [0, 1, 2, 3].map((k) => ({ points: circlePoints(k * 10000, 0, 100, 1600) }));
    const total = contours.reduce((sum, c) => sum + c.points.length, 0);
    expect(total).toBeGreaterThan(HOLE_GEOMETRY_MAX_POINTS_TOTAL);
    for (const c of contours) expect(c.points.length).toBeLessThanOrEqual(HOLE_GEOMETRY_MAX_POINTS_PER_CONTOUR);
    const audit = auditStraightNesting(contours);
    expect(audit.ok).toBe(false);
    if (!audit.ok) expect(audit.reason).toContain('cap');
    expect(contoursOverlap(contours as never)).toBe(true);
    expect(Number.isNaN(distanceToContours(contours as never, { x: 0, y: 0 }))).toBe(true);
    const areas = contours.map(() => 1);
    const resolved = resolveNestedHole({ contours, containing: [0, 1], areas });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain('cap');
  });
});

describe('overlap iteration budget (O(E^2) cap)', () => {
  it('disjoint high-vertex circles refuse via budget, small disjoint stay clean', () => {
    const big = [
      { points: circlePoints(0, 0, 100, 1000) },
      { points: circlePoints(10000, 0, 100, 1000) },
    ];
    // Within the point caps (1000/contour, 2000 total) so only the pair
    // budget can trip: 1000*1000 edge pairs > 400000.
    expect(big[0]!.points.length * big[1]!.points.length).toBeGreaterThan(HOLE_GEOMETRY_AUDIT_BUDGET);
    expect(contoursOverlap(big as never)).toBe(true);
    const audit = auditStraightNesting(big);
    expect(audit.ok).toBe(false);
    if (!audit.ok) expect(audit.reason).toContain('budget');
    const small = [
      { points: circlePoints(0, 0, 100, 32) },
      { points: circlePoints(10000, 0, 100, 32) },
    ];
    expect(contoursOverlap(small as never)).toBe(false);
    expect(auditStraightNesting(small).ok).toBe(true);
  });
});

describe('precision at non-uniform large/small scales and self-contact', () => {
  it('scaled donuts keep hole verdicts; self-touch still refuses', () => {
    const big = 'M0 0H100000V100000H0Z M20000 20000H60000V60000H20000Z';
    expect(classifyHolePoint({ pathData: big, point: { x: 40000, y: 40000 }, fillRule: 'evenodd' }).kind).toBe('hole');
    expect(classifyHolePoint({ pathData: big, point: { x: 5000, y: 5000 }, fillRule: 'evenodd' }).kind).toBe('filled');
    const tiny = 'M0 0H0.1V0.1H0Z M0.02 0.02H0.06V0.06H0.02Z';
    expect(
      classifyHolePoint({ pathData: tiny, point: { x: 0.04, y: 0.04 }, fillRule: 'evenodd', tolerance: 0.000001 }).kind,
    ).toBe('hole');
    const selfTouch = 'M0 0H200V200H0Z M40 40L160 40L40 160L160 160Z';
    expect(classifyHolePoint({ pathData: selfTouch, point: { x: 100, y: 100 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
  });
});

describe('hover benchmark: 20k-char nesting, 10th frame stays bounded', () => {
  it('deep nesting refuses every frame (caps asserted, hang guard is loose)', () => {
    const d = nestedSquares(700, 2000);
    expect(d.length).toBeLessThanOrEqual(HOLE_GEOMETRY_MAX_CHARS);
    const contours = parseStraightContours(d)!;
    expect(contours.length).toBe(700);
    const probe = { x: 1000, y: 1000 };
    const started = Date.now();
    for (let frame = 1; frame <= 10; frame += 1) {
      const verdict = classifyHolePoint({ pathData: d, point: probe, fillRule: 'evenodd' });
      // Never a safe claim from a partially scanned set; the budget trips
      // before containment pairing. Frame 10 must look exactly like frame 1.
      expect(verdict.kind).toBe('ambiguous');
      if (verdict.kind === 'ambiguous') expect(verdict.reason).toMatch(/budget|cap|overlap/);
    }
    // Loose hang guard only (deterministic cap assertions above are the real
    // benchmark); 10 frames of bounded ~400k-check audits finish in ~seconds.
    expect(Date.now() - started).toBeLessThan(30000);
  });
});
