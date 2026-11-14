import { describe, expect, it } from 'bun:test';
import {
  applyHoleMatrix,
  classifyHolePoint,
  composeHoleMatrices,
  containingContourIndices,
  contoursOverlap,
  distanceToContours,
  isPathDataSafeForHoleGeometry,
  isPointFilled,
  isUnitEligibleForHoleGeometry,
  normalizeFillRule,
  parseStraightContours,
  parseSvgTransformList,
  tryInvertHoleMatrix,
} from '../src/features/costumes/vector-fill-hole-geometry';

// Pure-geometry coverage for the independent hole helper (no Paper.js, no DOM,
// no existing modules). Mirrors the fail-closed contract: safe multi-hole /
// relative-m / island cases resolve, uncertain overlaps refuse.

const DONUT = 'M150 90H330V270H150Z M210 150H270V210H210Z';
const TWO_HOLES = 'M0 0H200V100H0Z M20 20H60V60H20Z M120 20H160V60H120Z';
const RELATIVE_M = 'M0 0H200V100H0Z m20 20H60V60H20Z';
const ISLAND = 'M0 0H200V200H0Z M40 40H160V160H40Z M80 80H120V120H80Z';
const OVERLAP = 'M0 0H100V100H0Z M50 50H150V150H50Z';

describe('hole-geometry input gates', () => {
  it('accepts straight safe data and rejects untrusted payloads', () => {
    expect(isPathDataSafeForHoleGeometry(DONUT)).toBe(true);
    expect(isPathDataSafeForHoleGeometry('')).toBe(false);
    expect(isPathDataSafeForHoleGeometry('L10 10')).toBe(false);
    expect(isPathDataSafeForHoleGeometry('M0 0L10 0"><script>')).toBe(false);
    expect(isPathDataSafeForHoleGeometry('M0 0 url(#x)')).toBe(false);
    expect(isPathDataSafeForHoleGeometry('M0 0C10 10 20 20 30 30')).toBe(false);
    expect(isPathDataSafeForHoleGeometry('M0 0A10 10 0 0 1 20 20')).toBe(false);
  });

  it('normalizes fill-rule to SVG default nonzero (missing/invalid -> nonzero)', () => {
    expect(normalizeFillRule('nonzero')).toBe('nonzero');
    expect(normalizeFillRule('evenodd')).toBe('evenodd');
    expect(normalizeFillRule(null)).toBe('nonzero');
    expect(normalizeFillRule('')).toBe('nonzero');
    expect(normalizeFillRule('bogus')).toBe('nonzero');
  });

  it('declines clip/mask/defs/url paint and non-path units', () => {
    expect(isUnitEligibleForHoleGeometry({ tag: 'path' })).toEqual({ eligible: true });
    expect(isUnitEligibleForHoleGeometry({ tag: 'g' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', clipPath: 'url(#c)' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', mask: 'url(#m)' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', style: 'clip-path:url(#c)' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', fill: 'url(#g)' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', insideDefs: true }).eligible).toBe(false);
  });
});

describe('straight-contour parsing with relative m', () => {
  it('splits absolute multi-hole data', () => {
    const contours = parseStraightContours(TWO_HOLES);
    expect(contours?.length).toBe(3);
  });

  it('resolves a relative-m hole start against the previous cursor', () => {
    const relative = parseStraightContours(RELATIVE_M);
    const absolute = parseStraightContours('M0 0H200V100H0Z M20 20H60V60H20Z');
    expect(relative?.length).toBe(2);
    expect(relative?.[1]?.points).toEqual(absolute?.[1]?.points ?? []);
  });

  it('treats a leading relative m as absolute per SVG', () => {
    const contours = parseStraightContours('m10 10H20V20H10Z M30 30H40V40H30Z');
    expect(contours?.length).toBe(2);
    expect(contours?.[0]?.points[0]).toEqual({ x: 10, y: 10 });
  });

  it('declines single contours and curves', () => {
    expect(parseStraightContours('M0 0H10V10H0Z')).toBe(undefined);
    expect(parseStraightContours('M0 0C10 10 20 20 30 30 M40 40H50V50H40Z')).toBe(undefined);
  });
});

describe('fill-rule classification', () => {
  it('finds donut hole vs body under evenodd', () => {
    expect(classifyHolePoint({ pathData: DONUT, point: { x: 160, y: 100 }, fillRule: 'evenodd' }).kind).toBe('filled');
    const hole = classifyHolePoint({ pathData: DONUT, point: { x: 240, y: 180 }, fillRule: 'evenodd' });
    expect(hole.kind).toBe('hole');
    if (hole.kind === 'hole') {
      expect(hole.holeIndex).toBe(1);
      expect(hole.outerIndex).toBe(0);
    }
    expect(classifyHolePoint({ pathData: DONUT, point: { x: 0, y: 0 }, fillRule: 'evenodd' }).kind).toBe('outside');
  });

  it('resolves both holes of a multi-hole path independently', () => {
    const first = classifyHolePoint({ pathData: TWO_HOLES, point: { x: 40, y: 40 }, fillRule: 'evenodd' });
    const second = classifyHolePoint({ pathData: TWO_HOLES, point: { x: 140, y: 40 }, fillRule: 'evenodd' });
    expect(first.kind).toBe('hole');
    expect(second.kind).toBe('hole');
    if (first.kind === 'hole' && second.kind === 'hole') {
      expect(first.holeIndex).toBe(1);
      expect(second.holeIndex).toBe(2);
      expect(first.outerIndex).toBe(0);
      expect(second.outerIndex).toBe(0);
    }
    // Between the holes is still painted body.
    expect(classifyHolePoint({ pathData: TWO_HOLES, point: { x: 90, y: 40 }, fillRule: 'evenodd' }).kind).toBe('filled');
  });

  it('discriminates a non-overlapping island as filled (depth 3), hole-with-island ring stays ambiguous', () => {
    const island = classifyHolePoint({ pathData: ISLAND, point: { x: 100, y: 100 }, fillRule: 'evenodd' });
    expect(island.kind).toBe('filled');
    if (island.kind === 'filled') expect(island.containing).toEqual([0, 1, 2]);
    // Ring between outer and middle contour shares the middle hole contour
    // with an island: a single-path hole overlay would cover that island, so
    // the ring point honestly refuses instead of claiming a hole.
    expect(classifyHolePoint({ pathData: ISLAND, point: { x: 50, y: 100 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // A separate non-overlapping island (outside the donut) is safely filled.
    const separate = 'M0 0H100V100H0Z M20 20H40V40H20Z M200 200H260V260H200Z';
    expect(classifyHolePoint({ pathData: separate, point: { x: 230, y: 230 }, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyHolePoint({ pathData: separate, point: { x: 30, y: 30 }, fillRule: 'evenodd' }).kind).toBe('hole');
  });

  it('honors nonzero winding (opposite directions cancel)', () => {
    // Same box twice, opposite winding: nonzero cancels to unfilled, evenodd
    // parity also reports unfilled here (2 = even). The key nonzero check is
    // same-direction doubling stays filled.
    const doubled = 'M0 0H100V100H0Z M0 0H100V100H0Z';
    const contours = parseStraightContours(doubled)!;
    expect(isPointFilled(contours, { x: 50, y: 50 }, 'nonzero')).toBe(true);
    expect(containingContourIndices(contours, { x: 50, y: 50 }, 'evenodd').length).toBe(2);
    // Opposite-direction inner cancels the outer under nonzero.
    const canceled = 'M0 0H100V100H0Z M0 100H100V0H0Z';
    const canceledContours = parseStraightContours(canceled)!;
    expect(isPointFilled(canceledContours, { x: 50, y: 50 }, 'nonzero')).toBe(false);
  });

  it('fail-closes overlapping contours', () => {
    expect(contoursOverlap(parseStraightContours(OVERLAP)!)).toBe(true);
    expect(classifyHolePoint({ pathData: OVERLAP, point: { x: 75, y: 75 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
  });

  it('fail-closes edge proximity (anti-alias zone)', () => {
    const contours = parseStraightContours(DONUT)!;
    expect(distanceToContours(contours, { x: 150, y: 100 })).toBeCloseTo(0, 6);
    expect(classifyHolePoint({ pathData: DONUT, point: { x: 150.2, y: 100 }, fillRule: 'evenodd', tolerance: 0.5 }).kind).toBe(
      'ambiguous',
    );
  });

  it('marks curves as unsupported (Paper probe owns them)', () => {
    expect(
      classifyHolePoint({ pathData: 'M0 0C10 10 20 20 30 30 M40 40H50V50H40Z', point: { x: 45, y: 45 } }).kind,
    ).toBe('unsupported');
  });
});

describe('transform inversion and ancestor composition', () => {
  it('inverts translations and refuses singular scales', () => {
    const matrix = parseSvgTransformList('translate(20 10)')!;
    const inverse = tryInvertHoleMatrix(matrix)!;
    expect(applyHoleMatrix(inverse, { x: 30, y: 20 })).toEqual({ x: 10, y: 10 });
    expect(tryInvertHoleMatrix(parseSvgTransformList('scale(0 1)')!)).toBe(null);
    expect(tryInvertHoleMatrix(parseSvgTransformList('scale(1 0)')!)).toBe(null);
  });

  it('composes ancestor + own transforms outer-first', () => {
    const world = composeHoleMatrices('translate(20 10)', 'translate(5 5)')!;
    expect(applyHoleMatrix(world, { x: 0, y: 0 })).toEqual({ x: 25, y: 15 });
  });

  it('maps document points to local space before classifying', () => {
    const world = composeHoleMatrices('translate(20 10)', '')!;
    // Document (160,100) is body paint without the matrix, but maps to local
    // (140,90) outside the donut once the ancestor translate is inverted.
    expect(classifyHolePoint({ pathData: DONUT, point: { x: 160, y: 100 }, fillRule: 'evenodd', worldMatrix: world }).kind).toBe(
      'outside',
    );
    expect(classifyHolePoint({ pathData: DONUT, point: { x: 160, y: 100 }, fillRule: 'evenodd' }).kind).toBe('filled');
    // Local hole center (240,180) appears at document (260,190).
    expect(classifyHolePoint({ pathData: DONUT, point: { x: 260, y: 190 }, fillRule: 'evenodd', worldMatrix: world }).kind).toBe(
      'hole',
    );
  });

  it('handles mirrored (negative-determinant) transforms without flipping the verdict', () => {
    const world = parseSvgTransformList('translate(200 0) scale(-1 1)')!;
    const hole = classifyHolePoint({ pathData: DONUT, point: { x: -60, y: 180 }, fillRule: 'evenodd', worldMatrix: world });
    expect(hole.kind).toBe('hole');
  });
});
