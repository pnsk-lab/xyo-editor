import { describe, expect, it } from 'bun:test';
import {
  CURVED_HOLE_UNSUPPORTED_CASES,
  classifyCurvedHolePoint,
  curvedHoleDataHasCurves,
  flattenCurvedContours,
  gateCurvedWorldMatrix,
  isPathDataSafeForCurvedHoleGeometry,
} from '../src/features/costumes/vector-fill-hole-curves';

// Pure-geometry coverage for the curved hole helper prototype (no Paper.js,
// no DOM, no existing modules edited). Mirrors the straight helper's
// fail-closed contract, plus curve-specific gates: flattening, arcs,
// similarity-only transforms, widened edge zones.

const CURVED_DONUT =
  'M100 100H400V300H100Z M170 150C170 130 190 130 190 150C190 170 170 170 170 150Z';
const TWO_CURVED_HOLES =
  'M0 0H300V200H0Z M30 60C30 40 60 40 60 60C60 80 30 80 30 60Z M180 60C180 40 210 40 210 60C210 80 180 80 180 60Z';
const ARC_ELLIPSE_HOLE =
  'M0 0H300V200H0Z M60 100A30 20 0 1 0 120 100A30 20 0 1 0 60 100Z';
const RELATIVE_M_CURVE =
  'M0 0H300V200H0Z m30 60C30 40 60 40 60 60C60 80 30 80 30 60Z';
const QUAD_DONUT = 'M0 0H200V200H0Z M60 60Q90 40 120 60Q140 90 120 120Q90 140 60 120Q40 90 60 60Z';
const OVERLAP_CURVED =
  'M0 0H200V200H0Z M60 60C60 20 140 20 140 60C140 100 60 100 60 60Z M100 100H260V260H100Z';

describe('curved hole-geometry input gates', () => {
  it('accepts curved safe data and rejects untrusted payloads', () => {
    expect(isPathDataSafeForCurvedHoleGeometry(CURVED_DONUT)).toBe(true);
    expect(isPathDataSafeForCurvedHoleGeometry(ARC_ELLIPSE_HOLE)).toBe(true);
    expect(isPathDataSafeForCurvedHoleGeometry('')).toBe(false);
    expect(isPathDataSafeForCurvedHoleGeometry('L10 10')).toBe(false);
    expect(isPathDataSafeForCurvedHoleGeometry('M0 0C10 10 20 20 30 30"><script>')).toBe(false);
    expect(isPathDataSafeForCurvedHoleGeometry('M0 0 url(#x)')).toBe(false);
    expect(curvedHoleDataHasCurves(CURVED_DONUT)).toBe(true);
    expect(curvedHoleDataHasCurves('M0 0H10V10H0Z M20 20H30V30H20Z')).toBe(false);
  });

  it('flattens cubics, smooth commands, quads, and arcs to >=3-point contours', () => {
    expect(flattenCurvedContours(CURVED_DONUT)?.length).toBe(2);
    expect(flattenCurvedContours(TWO_CURVED_HOLES)?.length).toBe(3);
    expect(flattenCurvedContours(ARC_ELLIPSE_HOLE)?.length).toBe(2);
    expect(flattenCurvedContours(QUAD_DONUT)?.length).toBe(2);
    const smooth = 'M0 0H200V200H0Z M60 100C80 60 120 60 140 100S120 140 100 140Z';
    expect(flattenCurvedContours(smooth)?.length).toBe(2);
    // Single contour: no hole possible.
    expect(flattenCurvedContours('M0 0C10 0 10 10 0 10Z')).toBe(undefined);
    // Malformed numbers fail-closed.
    expect(flattenCurvedContours('M0 0C10 10 M20 20H30V30H20Z')).toBe(undefined);
  });

  it('resolves a relative-m curved hole start against the previous cursor', () => {
    const relative = flattenCurvedContours(RELATIVE_M_CURVE);
    const absolute = flattenCurvedContours(
      'M0 0H300V200H0Z M30 60C30 40 60 40 60 60C60 80 30 80 30 60Z',
    );
    expect(relative?.length).toBe(2);
    expect(relative?.[1]?.points.length).toBe(absolute?.[1]?.points.length);
    const first = relative?.[1]?.points[0];
    const firstAbs = absolute?.[1]?.points[0];
    expect(first?.x).toBeCloseTo(firstAbs?.x ?? 0, 6);
    expect(first?.y).toBeCloseTo(firstAbs?.y ?? 0, 6);
  });
});

describe('curved fill-rule classification', () => {
  it('finds a cubic hole interior vs body vs outside (evenodd)', () => {
    expect(classifyCurvedHolePoint({ pathData: CURVED_DONUT, point: { x: 110, y: 110 }, fillRule: 'evenodd' }).kind).toBe(
      'filled',
    );
    const hole = classifyCurvedHolePoint({
      pathData: CURVED_DONUT,
      point: { x: 180, y: 150 },
      fillRule: 'evenodd',
    });
    expect(hole.kind).toBe('hole');
    if (hole.kind === 'hole') {
      expect(hole.holeIndex).toBe(1);
      expect(hole.outerIndex).toBe(0);
    }
    expect(classifyCurvedHolePoint({ pathData: CURVED_DONUT, point: { x: 10, y: 10 }, fillRule: 'evenodd' }).kind).toBe(
      'outside',
    );
  });

  it('resolves two curved holes independently', () => {
    const first = classifyCurvedHolePoint({ pathData: TWO_CURVED_HOLES, point: { x: 45, y: 60 }, fillRule: 'evenodd' });
    const second = classifyCurvedHolePoint({ pathData: TWO_CURVED_HOLES, point: { x: 195, y: 60 }, fillRule: 'evenodd' });
    expect(first.kind).toBe('hole');
    expect(second.kind).toBe('hole');
    if (first.kind === 'hole' && second.kind === 'hole') {
      expect(first.holeIndex).toBe(1);
      expect(second.holeIndex).toBe(2);
    }
    expect(classifyCurvedHolePoint({ pathData: TWO_CURVED_HOLES, point: { x: 120, y: 100 }, fillRule: 'evenodd' }).kind).toBe(
      'filled',
    );
  });

  it('resolves an arc ellipse hole interior', () => {
    const hole = classifyCurvedHolePoint({ pathData: ARC_ELLIPSE_HOLE, point: { x: 90, y: 100 }, fillRule: 'evenodd' });
    expect(hole.kind).toBe('hole');
    expect(classifyCurvedHolePoint({ pathData: ARC_ELLIPSE_HOLE, point: { x: 20, y: 20 }, fillRule: 'evenodd' }).kind).toBe(
      'filled',
    );
  });

  it('honors nonzero winding for curves (opposite directions cancel)', () => {
    const canceled = 'M0 0H200V200H0Z M0 200H200V0H0Z M60 60Q90 40 120 60Q140 90 120 120Q90 140 60 120Q40 90 60 60Z';
    // Opposite outer windings cancel under nonzero; the point is unfilled but
    // pairs 3 contours, so the helper must not claim a hole.
    expect(
      classifyCurvedHolePoint({ pathData: canceled, point: { x: 100, y: 100 }, fillRule: 'nonzero' }).kind,
    ).not.toBe('hole');
  });

  it('fail-closes overlapping curved contours', () => {
    expect(classifyCurvedHolePoint({ pathData: OVERLAP_CURVED, point: { x: 120, y: 120 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });

  it('fail-closes edge proximity with the widened flatten margin', () => {
    const contours = flattenCurvedContours(CURVED_DONUT)!;
    expect(contours.length).toBe(2);
    // A point 0.4 local units from the flattened edge sits inside the
    // document tolerance (0.5) + flatten margin (0.35) exclusion band.
    const near = classifyCurvedHolePoint({
      pathData: 'M0 0H200V200H0Z M60 60H120V120H60Z',
      point: { x: 60.4, y: 90 },
      fillRule: 'evenodd',
      tolerance: 0.5,
    });
    expect(near.kind).toBe('ambiguous');
  });
});

describe('smooth S/T reflection (SVG semantics)', () => {
  const OUTER = 'M0 0H200V200H0Z';
  const innerPoints = (d: string) => flattenCurvedContours(`${OUTER} ${d}`)?.[1]?.points;
  const expectSameFlatten = (a: string, b: string) => {
    const pa = innerPoints(a);
    const pb = innerPoints(b);
    expect(pa).toBeDefined();
    expect(pb).toBeDefined();
    expect(pa?.length).toBe(pb?.length);
    for (let i = 0; i < (pa?.length ?? 0); i += 1) {
      expect(pa?.[i]?.x).toBeCloseTo(pb?.[i]?.x ?? 0, 9);
      expect(pa?.[i]?.y).toBeCloseTo(pb?.[i]?.y ?? 0, 9);
    }
  };

  it('reflects C->S (c1 mirrors previous c2 across cursor)', () => {
    // C c2=(120,40), cursor=(140,60) -> reflected c1=(160,80).
    expectSameFlatten(
      'M60 60C80 40 120 40 140 60S160 100 140 120Z',
      'M60 60C80 40 120 40 140 60C160 80 160 100 140 120Z',
    );
  });

  it('reflects Q->T (control mirrors across cursor)', () => {
    // Q c=(100,40), cursor=(140,60) -> reflected c=(180,80).
    expectSameFlatten('M60 60Q100 40 140 60T180 100Z', 'M60 60Q100 40 140 60Q180 80 180 100Z');
  });

  it('falls back to cursor when S/T has no prev (M/L break, undefined/null safe)', () => {
    // S with no previous cubic: c1 coincides with the cursor.
    expectSameFlatten('M60 60S160 100 140 120Z', 'M60 60C60 60 160 100 140 120Z');
    // L between C and S breaks the chain: fallback, not reflection.
    expectSameFlatten(
      'M60 60C80 40 120 40 140 60L150 70S170 90 160 110Z',
      'M60 60C80 40 120 40 140 60L150 70C150 70 170 90 160 110Z',
    );
    // L between Q and T breaks the chain likewise.
    expectSameFlatten(
      'M60 60Q100 40 140 60L150 70T190 110Z',
      'M60 60Q100 40 140 60L150 70Q150 70 190 110Z',
    );
  });

  it('does not reflect across curve-type boundaries (Q->S, C->T)', () => {
    expectSameFlatten(
      'M60 60Q100 40 140 60S170 90 160 110Z',
      'M60 60Q100 40 140 60C140 60 170 90 160 110Z',
    );
    expectSameFlatten(
      'M60 60C80 40 120 40 140 60T190 110Z',
      'M60 60C80 40 120 40 140 60Q140 60 190 110Z',
    );
  });

  it('does not reflect S/T off arc geometry (A breaks the chain)', () => {
    const pre = 'M60 60C80 40 120 40 140 60';
    expectSameFlatten(
      `${pre}A10 10 0 0 1 160 60S180 80 170 100Z`,
      `${pre}A10 10 0 0 1 160 60C160 60 180 80 170 100Z`,
    );
    const preQ = 'M60 60Q100 40 140 60';
    expectSameFlatten(
      `${preQ}A10 10 0 0 1 160 60T190 100Z`,
      `${preQ}A10 10 0 0 1 160 60Q160 60 190 100Z`,
    );
  });

  it('handles relative c->s with the same reflection', () => {
    expectSameFlatten(
      'M60 60c20 -20 60 -20 80 0s20 40 0 60Z',
      'M60 60c20 -20 60 -20 80 0C160 80 160 100 140 120Z',
    );
  });
});

describe('curved transform gates (similarity only)', () => {
  it('accepts translation and uniform scale+rotation', () => {
    expect(gateCurvedWorldMatrix([1, 0, 0, 1, 20, 10]).ok).toBe(true);
    expect(gateCurvedWorldMatrix([2, 0, 0, 2, 0, 0]).ok).toBe(true);
    const rotated: [number, number, number, number, number, number] = [
      Math.cos(0.5),
      Math.sin(0.5),
      -Math.sin(0.5),
      Math.cos(0.5),
      0,
      0,
    ];
    expect(gateCurvedWorldMatrix(rotated).ok).toBe(true);
  });

  it('refuses mirror, non-uniform, skew, and singular frames', () => {
    expect(gateCurvedWorldMatrix([0, 0, 0, 0, 0, 0]).ok).toBe(false);
    expect(gateCurvedWorldMatrix([-1, 0, 0, 1, 200, 0]).ok).toBe(false);
    expect(gateCurvedWorldMatrix([4, 0, 0, 1, 0, 0]).ok).toBe(false);
    expect(gateCurvedWorldMatrix([1, 0, 0.5, 1, 0, 0]).ok).toBe(false);
    const mirror = classifyCurvedHolePoint({
      pathData: CURVED_DONUT,
      point: { x: 20, y: 150 },
      fillRule: 'evenodd',
      worldMatrix: [-1, 0, 0, 1, 200, 0],
    });
    expect(mirror.kind).toBe('ambiguous');
    const skew = classifyCurvedHolePoint({
      pathData: CURVED_DONUT,
      point: { x: 180, y: 150 },
      fillRule: 'evenodd',
      worldMatrix: [1, 0, 0.5, 1, 0, 0],
    });
    expect(skew.kind).toBe('ambiguous');
    const singular = classifyCurvedHolePoint({
      pathData: CURVED_DONUT,
      point: { x: 180, y: 150 },
      fillRule: 'evenodd',
      worldMatrix: [0, 0, 0, 1, 0, 0],
    });
    expect(singular.kind).toBe('ambiguous');
  });

  it('maps translated document points to local space before classifying', () => {
    const world: [number, number, number, number, number, number] = [1, 0, 0, 1, 20, 10];
    expect(
      classifyCurvedHolePoint({ pathData: CURVED_DONUT, point: { x: 200, y: 160 }, fillRule: 'evenodd', worldMatrix: world })
        .kind,
    ).toBe('hole');
  });

  it('enumerates unsupported cases honestly', () => {
    expect(CURVED_HOLE_UNSUPPORTED_CASES.length).toBeGreaterThanOrEqual(8);
    expect(CURVED_HOLE_UNSUPPORTED_CASES.join('\n')).toContain('Paper entity probe');
  });
});
