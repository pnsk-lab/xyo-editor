import { describe, expect, it } from 'bun:test';
import {
  CURVED_FLATTEN_MARGIN,
  CURVED_FLATTEN_TOLERANCE,
  classifyCurvedHolePoint,
  flattenCurvedContours,
} from '../src/features/costumes/vector-fill-hole-curves';

// Independent adversarial review of the curved hole-geometry prototype
// (vector-fill-hole-curves.ts). Pure tests only: no Paper.js, no DOM, no
// existing modules edited. Every expectation below is either an analytic
// truth (circle/ellipse geometry is exact) or a fail-closed property
// (refuse instead of guessing). Anything that needs pixels is covered by
// the companion `*.browser.test.ts` oracle (Canvas Path2D + Paper.js).

const RECT_400 = 'M0 0H400V300H0Z';

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('adversarial: ellipse-arc 90-degree cubic approximation error', () => {
  it('circle via 4 arcs stays within the flatten margin of the true circle', () => {
    // Outer leaves a 100-unit gap around the r100 circle (strictly inside):
    // a touching outer wall would be a degenerate touching topology and must
    // refuse, so the fixture keeps clearance for the decidable-hole claim.
    const d = `M0 0H400V400H0Z M100 200A100 100 0 1 0 300 200A100 100 0 1 0 100 200Z`;
    const contours = flattenCurvedContours(d);
    expect(contours?.length).toBe(2);
    const hole = contours![1]!;
    // Analytic oracle: every flattened vertex must sit within the widened
    // edge margin of the true radius, otherwise a deep-interior hole claim
    // could disagree with the real renderer.
    let worst = 0;
    for (const p of hole.points) {
      worst = Math.max(worst, Math.abs(dist(p, { x: 200, y: 200 }) - 100));
    }
    expect(worst).toBeLessThan(CURVED_FLATTEN_MARGIN);
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 200, y: 200 }, fillRule: 'evenodd' }).kind).toBe('hole');
  });

  it('large ellipse (rx=300, ry=60) hole center is a hole, tips are refused', () => {
    const d = 'M0 0H800V400H0Z M100 200A300 60 0 1 0 700 200A300 60 0 1 0 100 200Z';
    const contours = flattenCurvedContours(d);
    expect(contours?.length).toBe(2);
    const hole = contours![1]!;
    // Normalized ellipse deviation of the flattened polyline stays tiny.
    let worst = 0;
    for (const p of hole.points) {
      const n = ((p.x - 400) / 300) ** 2 + ((p.y - 200) / 60) ** 2;
      worst = Math.max(worst, Math.abs(n - 1));
    }
    expect(worst).toBeLessThan(0.02);
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 400, y: 200 }, fillRule: 'evenodd' }).kind).toBe('hole');
    // Tips sit on the painted edge: must refuse, never claim.
    expect(
      classifyCurvedHolePoint({ pathData: d, point: { x: 700, y: 200 }, fillRule: 'evenodd', tolerance: 2 }).kind,
    ).toBe('ambiguous');
  });

  it('rotated ellipse arcs keep the center a hole (no radius inflation)', () => {
    // Chord (100,300)->(700,300) rotated 30 degrees: (259.8/400)^2+(150/200)^2
    // = 0.98 <= 1, so SVG skips radius inflation (lambda <= 1) and the hole
    // stays strictly inside the outer rect. An inflated variant (chord longer
    // than the rotated radii) would cross the outer wall and must refuse via
    // the overlap gate -- covered by the browser oracle.
    const d = 'M0 0H800V600H0Z M100 300A400 200 30 1 0 700 300A400 200 30 1 0 100 300Z';
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 400, y: 300 }, fillRule: 'evenodd' }).kind).toBe('hole');
  });
});

describe('adversarial: overall scale (coordinates and world matrix)', () => {
  const DONUT_100X = 'M0 0H30000V20000H0Z M3000 6000C3000 4000 6000 4000 6000 6000C6000 8000 3000 8000 3000 6000Z';

  it('100x-coordinate donut still resolves a deep hole', () => {
    expect(classifyCurvedHolePoint({ pathData: DONUT_100X, point: { x: 4500, y: 6000 }, fillRule: 'evenodd' }).kind).toBe(
      'hole',
    );
  });

  it('sub-margin micro donut refuses instead of claiming a hole', () => {
    const tiny = 'M0 0H4V4H0Z M1.5 2A0.5 0.5 0 1 0 2.5 2A0.5 0.5 0 1 0 1.5 2Z';
    // Hole diameter (1.0) is below tolerance (0.5) + margin (0.35): the whole
    // interior is edge zone, so a hole claim would be anti-alias gambling.
    expect(classifyCurvedHolePoint({ pathData: tiny, point: { x: 2, y: 2 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });

  it('uniform world-matrix scale maps deep holes correctly, tiny scales refuse', () => {
    const local = 'M100 100H400V300H100Z M170 150C170 130 190 130 190 150C190 170 170 170 150 150Z';
    const big = classifyCurvedHolePoint({
      pathData: local,
      point: { x: 18000, y: 15000 },
      fillRule: 'evenodd',
      worldMatrix: [100, 0, 0, 100, 0, 0],
    });
    expect(big.kind).toBe('hole');
    const tiny = classifyCurvedHolePoint({
      pathData: local,
      point: { x: 1.8, y: 1.5 },
      fillRule: 'evenodd',
      worldMatrix: [0.01, 0, 0, 0.01, 0, 0],
    });
    // Local exclusion radius 0.5/0.01 + 0.35 swallows the shape: safe refuse.
    expect(tiny.kind).toBe('ambiguous');
  });

  it('flatten tolerance is monotone and invalid values fall back to default', () => {
    const d = 'M0 0H300V200H0Z M30 60C30 40 60 40 60 60C60 80 30 80 30 60Z';
    const fine = flattenCurvedContours(d, 0.1);
    const coarse = flattenCurvedContours(d, 0.5);
    expect(fine?.[1]?.points.length).toBeGreaterThanOrEqual(coarse?.[1]?.points.length ?? 0);
    const fallback = flattenCurvedContours(d, Number.NaN);
    const def = flattenCurvedContours(d, CURVED_FLATTEN_TOLERANCE);
    expect(fallback?.[1]?.points.length).toBe(def?.[1]?.points.length);
    expect(flattenCurvedContours(d, 0)?.[1]?.points.length).toBe(def?.[1]?.points.length);
    expect(flattenCurvedContours(d, 5)?.[1]?.points.length).toBe(def?.[1]?.points.length);
  });
});

describe('adversarial: recursion depth cap and extreme radii', () => {
  it('pathological segment counts refuse instead of guessing', () => {
    const many = `${'M0 0H2000V500H0Z M10 10'}${'C20 0 30 0 40 10'.repeat(1200)}Z`;
    expect(flattenCurvedContours(many)).toBe(undefined);
    expect(classifyCurvedHolePoint({ pathData: many, point: { x: 100, y: 100 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });

  it('non-finite control points refuse', () => {
    const d = 'M0 0H100V100H0Z M20 20C1e309 1e309 1e309 1e309 80 80 80 20 20 20Z';
    expect(flattenCurvedContours(d)).toBe(undefined);
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 50, y: 50 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });

  it('overflowing arc radii (1e308) refuse instead of producing NaN geometry', () => {
    const d = 'M0 0H100V100H0Z M20 50A1e308 10 0 1 0 80 50A1e308 10 0 1 0 20 50Z';
    expect(flattenCurvedContours(d)).toBe(undefined);
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 50, y: 50 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });
});

describe('adversarial: S/Q smooth tangents and relative z+m forms', () => {
  it('S after C reflects (matches explicit reflected cubic exactly)', () => {
    const smooth = `${RECT_400} M60 200C100 100 140 100 180 200S260 200 260 120Z`;
    const explicit = `${RECT_400} M60 200C100 100 140 100 180 200C220 300 260 200 260 120Z`;
    const a = flattenCurvedContours(smooth)?.[1]?.points;
    const b = flattenCurvedContours(explicit)?.[1]?.points;
    expect(a?.length).toBe(b?.length);
    expect(a).toEqual(b);
  });

  it('S after A does NOT reflect arc approximation controls (spec fallback to cursor)', () => {
    const arcS = `${RECT_400} M60 200A60 40 0 0 1 180 200S260 200 260 120Z`;
    const specC = `${RECT_400} M60 200A60 40 0 0 1 180 200C180 200 260 200 260 120Z`;
    const a = flattenCurvedContours(arcS)?.[1]?.points;
    const b = flattenCurvedContours(specC)?.[1]?.points;
    expect(a?.length).toBe(b?.length);
    expect(a).toEqual(b);
  });

  it('T after Q reflects, T after C falls back to cursor', () => {
    const tAfterQ = `${RECT_400} M60 200Q100 120 180 200T260 200Z`;
    // Reflected control: 2*(180,200)-(100,120) = (260,280).
    const explicitQ = `${RECT_400} M60 200Q100 120 180 200Q260 280 260 200Z`;
    expect(flattenCurvedContours(tAfterQ)?.[1]?.points).toEqual(flattenCurvedContours(explicitQ)?.[1]?.points);
    const tAfterC = `${RECT_400} M60 200C100 100 140 100 180 200T260 200Z`;
    const fallbackQ = `${RECT_400} M60 200C100 100 140 100 180 200Q180 200 260 200Z`;
    expect(flattenCurvedContours(tAfterC)?.[1]?.points).toEqual(flattenCurvedContours(fallbackQ)?.[1]?.points);
  });

  it('relative c/s/q/t/a match their absolute spellings', () => {
    const absS = 'M0 0H300V200H0Z M30 60C40 45 50 45 60 60S50 72 40 72Z';
    const relS = 'M0 0H300V200H0Z m30 60c10-15 20-15 30 0s-10 12-20 12z';
    expect(flattenCurvedContours(relS)?.[1]?.points).toEqual(flattenCurvedContours(absS)?.[1]?.points);
    const absT = 'M0 0H300V200H0Z M30 60Q45 40 60 60T90 80Z';
    const relT = 'M0 0H300V200H0Z m30 60q15-20 30 0t30 20z';
    expect(flattenCurvedContours(relT)?.[1]?.points).toEqual(flattenCurvedContours(absT)?.[1]?.points);
    const absA = 'M0 0H300V200H0Z M60 100A30 20 0 1 0 120 100A30 20 0 1 0 60 100Z';
    const relA = 'M0 0H300V200H0Z m60 100a30 20 0 1 0 60 0a30 20 0 1 0-60 0z';
    expect(flattenCurvedContours(relA)?.[1]?.points).toEqual(flattenCurvedContours(absA)?.[1]?.points);
  });

  it('implicit lineto pairs after M resolve (relative m start against cursor)', () => {
    const implicit = 'M0 0H200V200H0Z M30 30 90 30 90 90 30 90Z';
    expect(flattenCurvedContours(implicit)?.length).toBe(2);
    expect(classifyCurvedHolePoint({ pathData: implicit, point: { x: 60, y: 60 }, fillRule: 'evenodd' }).kind).toBe(
      'hole',
    );
  });
});

describe('adversarial: ellipse direction and largeArc/sweep flags', () => {
  const circle = (large: number, sweep: number) =>
    `M0 0H300V300H0Z M60 100A40 40 0 ${large} ${sweep} 140 100A40 40 0 ${large} ${sweep} 60 100Z`;

  it('all four largeArc/sweep combinations keep a full-circle center a hole', () => {
    for (const large of [0, 1]) {
      for (const sweep of [0, 1]) {
        expect(
          classifyCurvedHolePoint({ pathData: circle(large, sweep), point: { x: 100, y: 100 }, fillRule: 'evenodd' })
            .kind,
        ).toBe('hole');
      }
    }
  });

  it('fractional arc flags refuse (never a hole claim)', () => {
    const d = 'M0 0H300V300H0Z M60 100A40 40 0 0.5 0 140 100A40 40 0 0.5 0 60 100Z';
    expect(flattenCurvedContours(d)).toBe(undefined);
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 100, y: 100 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });

  it('zero-radius arcs degrade to lines and refuse degenerate contours', () => {
    const d = 'M0 0H200V200H0Z M60 60A0 0 0 1 0 140 140Z';
    expect(flattenCurvedContours(d)).toBe(undefined);
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 100, y: 100 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });

  it('coincident arc endpoints (omitted segment) refuse degenerate contours', () => {
    const d = 'M0 0H200V200H0Z M60 100A30 20 0 1 0 60 100Z';
    expect(flattenCurvedContours(d)).toBe(undefined);
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 100, y: 100 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });
});

describe('adversarial: near-touching and self-intersecting curves', () => {
  // Two r30 circle holes whose flattened walls leave a 0.4 gap.
  const NEAR_TOUCH =
    'M0 0H400V200H0Z M60 80A30 30 0 1 0 120 80A30 30 0 1 0 60 80Z M120.4 80A30 30 0 1 0 180.4 80A30 30 0 1 0 120.4 80Z';

  it('the gap between near-touching holes is never a hole', () => {
    const mid = classifyCurvedHolePoint({ pathData: NEAR_TOUCH, point: { x: 120.2, y: 80 }, fillRule: 'evenodd' });
    expect(mid.kind).not.toBe('hole');
  });

  it('near-touching hole centers stay hole-or-refused (never filled/outside)', () => {
    for (const x of [90, 150.4]) {
      const verdict = classifyCurvedHolePoint({ pathData: NEAR_TOUCH, point: { x, y: 80 }, fillRule: 'evenodd' });
      expect(['hole', 'ambiguous']).toContain(verdict.kind);
    }
  });

  it('a figure-8 self-crossing contour refuses at its crossing', () => {
    const d =
      'M0 0H300V300H0Z M100 150C150 50 150 250 200 150C150 200 150 100 100 150Z';
    const verdict = classifyCurvedHolePoint({
      pathData: d,
      point: { x: 150, y: 150 },
      fillRule: 'evenodd',
      tolerance: 0.5,
    });
    expect(verdict.kind).toBe('ambiguous');
  });

  it('thin crescent as one closed contour is a hole; touching walls refuse', () => {
    // Single-contour crescent: outer semicircle apex (180,140), inner arc
    // apex (180,152.9); (180,146) sits ~6 units from either wall (analytic).
    const d =
      'M0 0H400V300H0Z M100 200A80 60 0 0 1 260 200L260 210A70 50 0 0 0 100 210Z';
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 180, y: 146 }, fillRule: 'evenodd' }).kind).toBe('hole');
    // Two full circles sharing exactly one wall point: the flattened walls
    // cross within tolerance, so the helper must refuse (renderer-dependent
    // touch) instead of guessing.
    const touching =
      'M0 0H300V300H0Z M100 150A50 50 0 1 0 200 150A50 50 0 1 0 100 150Z M104 150A48 48 0 1 0 200 150A48 48 0 1 0 104 150Z';
    expect(classifyCurvedHolePoint({ pathData: touching, point: { x: 102, y: 150 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
    expect(
      classifyCurvedHolePoint({ pathData: touching, point: { x: 200, y: 150 }, fillRule: 'evenodd', tolerance: 0.5 })
        .kind,
    ).toBe('ambiguous');
  });

  it('nested circles (island-in-hole) refuse per the straight-helper rule', () => {
    const d =
      'M0 0H300V300H0Z M100 150A50 50 0 1 0 200 150A50 50 0 1 0 100 150Z M118 150A40 40 0 1 0 198 150A40 40 0 1 0 118 150Z';
    // Between the circles: unfilled, but an island sits inside the hole.
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 105, y: 150 }, fillRule: 'evenodd' }).kind).toBe(
      'ambiguous',
    );
  });
});

describe('adversarial: unclosed contours and exponent notation', () => {
  it('unclosed quad loop still fills closed (documents SVG close semantics)', () => {
    const open = 'M0 0H200V200H0Z M60 60Q90 40 120 60Q140 90 120 120Q90 140 60 120Q40 90 60 60';
    expect(classifyCurvedHolePoint({ pathData: open, point: { x: 90, y: 90 }, fillRule: 'evenodd' }).kind).toBe('hole');
  });

  it('scientific-notation coordinates resolve', () => {
    const d = 'M0 0H1e2V1e2H0Z M2e1 2e1H8e1V8e1H2e1Z';
    expect(classifyCurvedHolePoint({ pathData: d, point: { x: 50, y: 50 }, fillRule: 'evenodd' }).kind).toBe('hole');
  });
});
