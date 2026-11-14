import { describe, expect, it } from 'bun:test';
import {
  CURVED_FLATTEN_TOLERANCE,
  classifyCurvedHolePoint,
  curvedLocalMarginFor,
  flattenCurvedContours,
  gateCurvedWorldMatrix,
} from '../src/features/costumes/vector-fill-hole-curves';
import {
  contoursOverlap,
  distanceToContours,
} from '../src/features/costumes/vector-fill-hole-geometry';

// Permanent safety-certification review for `vector-fill-hole-curves.ts`.
//
// Scope: new test file only. No Editor wiring.
// The arc path samples the true ellipse with a proven chord bound
// (`maxR * h^2 / 8 <= tol`) plus a dynamic `2 * tol + 1e-6` margin. The
// *relation* checks now operate fail-closed on the flattened polyline:
// point-to-polyline distance (`distanceToContours`, implicit closing edges
// included) and inclusive segment contact between contours
// (`contoursOverlap`: proper crossings + endpoint touching + collinear
// coincidence). When the true curves miss by less than the summed flatten
// error, the polyline can show a gap while the truth intersects (or vice
// versa), and the containing-count parity for a point far from the gap can
// still flip via the ray through the uncertain region. These tests pin the
// certified relations: separation must exceed the error sum + tolerance or
// the whole file fail-closes (`ambiguous`), including open-contour implicit
// walls, self-intersections, collinear touching, and capped O(n^2) audits.
//
// Each `it` below asserts the *safe* behaviour (strict, fail-closed).

const ERROR_SUM = 2 * CURVED_FLATTEN_TOLERANCE; // 0.5 local units
const MARGIN = curvedLocalMarginFor(CURVED_FLATTEN_TOLERANCE); // 0.500001
const EXCLUSION = 0.5 + MARGIN; // document tolerance 0.5 + flatten margin

function minPointGap(d: string): number {
  const contours = flattenCurvedContours(d)!;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < contours.length; i += 1) {
    for (const a of contours[i]!.points) {
      for (let j = 1; j < contours.length; j += 1) {
        if (i === j) continue;
        for (const b of contours[j]!.points) {
          const dd = Math.hypot(a.x - b.x, a.y - b.y);
          if (dd < best) best = dd;
        }
      }
    }
  }
  return best;
}

describe('safety-cert: implicit closing edge is included for distance/overlap', () => {
  // Inner hole is open (no Z): SVG fill closes it with a straight segment
  // (60,140)->(60,60). Distance + overlap must include that implicit wall.
  const OPEN = 'M0 0H200V200H0Z M60 60H140V140H60';

  it('polyline distance sees the true closing wall (~0.4)', () => {
    const contours = flattenCurvedContours(OPEN)!;
    expect(contours.map((c) => c.closed)).toEqual([true, false]);
    // Implicit wall (60,140)->(60,60) is 0.4 away: must be visible.
    expect(distanceToContours(contours, { x: 60.4, y: 100 })).toBeLessThan(1);
    expect(distanceToContours(contours, { x: 60.4, y: 100 })).toBeCloseTo(0.4, 1);
  });

  it('point 0.4 from the true wall must refuse', () => {
    // True distance 0.4 < EXCLUSION (~1.0): the pixel-oracle contract says
    // edge-band points must be `ambiguous`, never a hole claim.
    expect(EXCLUSION).toBeGreaterThan(1.0);
    expect(
      classifyCurvedHolePoint({ pathData: OPEN, point: { x: 60.4, y: 100 }, fillRule: 'evenodd' }).kind,
    ).toBe('ambiguous');
  });
});

describe('safety-cert: inter-contour gap below the summed flatten error', () => {
  // Two r30 arc holes whose flattened walls leave a 0.3 gap (< 0.5 error
  // sum). Each wall may deviate up to 0.25 from truth, so the truth may
  // intersect while the polyline shows a gap. The classifier has no
  // inter-contour separation check and still claims deep holes.
  const NEAR = 'M0 0H400V200H0Z M60 80A30 30 0 1 0 120 80A30 30 0 1 0 60 80Z M120.3 80A30 30 0 1 0 180.3 80A30 30 0 1 0 120.3 80Z';

  it('gap (0.3) is below the error sum (0.5) yet no overlap is reported', () => {
    const contours = flattenCurvedContours(NEAR)!;
    expect(contoursOverlap(contours)).toBe(false);
    expect(minPointGap(NEAR)).toBeLessThan(ERROR_SUM);
  });

  it('deep hole centers must refuse while separation is uncertified, but helper claims holes', () => {
    // Safe behaviour: `ambiguous` until min separation > error sum + docTol.
    // These expectations FAIL today (both return `hole`).
    expect(
      classifyCurvedHolePoint({ pathData: NEAR, point: { x: 90, y: 80 }, fillRule: 'evenodd' }).kind,
    ).toBe('ambiguous');
    expect(
      classifyCurvedHolePoint({ pathData: NEAR, point: { x: 150.15, y: 80 }, fillRule: 'evenodd' }).kind,
    ).toBe('ambiguous');
  });
});

describe('safety-cert: polygon-collinear overlap is invisible to the overlap gate', () => {
  // Two rectangular holes share the full wall x=150 (collinear overlap).
  // `contoursOverlap` only tests proper crossings (strict sign change), so
  // collinear coincidence returns false and the pair is treated as safely
  // separated.
  const SHARED = 'M0 0H300V200H0Z M30 60H150V140H30Z M150 60H270V140H150Z';

  it('shared-wall coincidence must count as an overlap relation', () => {
    // This expectation FAILS today (returns false).
    expect(contoursOverlap(flattenCurvedContours(SHARED)!)).toBe(true);
  });

  it('holes adjacent to a shared wall must not be certified while coincidence is ignored', () => {
    // Documents the phase-swap risk: with coincidence ignored, each hole is
    // certified independently although their walls coincide exactly.
    // Safe behaviour would be `ambiguous`; today both are `hole`.
    expect(
      classifyCurvedHolePoint({ pathData: SHARED, point: { x: 90, y: 100 }, fillRule: 'evenodd' }).kind,
    ).toBe('ambiguous');
  });
});

describe('safety-cert: self-intersection within one contour fail-closes', () => {
  // `contoursOverlap` only compares *pairs* of contours. A self-crossing
  // single hole contour (bowtie) has no pair to compare, so the classifier
  // additionally audits every contour for self-intersection (closing edge
  // included) and fail-closes the whole file when one is found.
  const BOWTIE_INNER = 'M100 100L200 200L200 100L100 200Z';
  const OUTER = 'M0 0H300V300H0Z';
  const D = `${OUTER} ${BOWTIE_INNER}`;

  it('bowtie inner self-crosses in the polyline, but the pair gate sees nothing', () => {
    const contours = flattenCurvedContours(D)!;
    expect(contours.length).toBe(2);
    // No pair touches (only 2 contours, outer vs bowtie): pair gate is false.
    expect(contoursOverlap(contours)).toBe(false);
    // The file still fail-closes globally via the self-intersection audit,
    // even far from the crossing (no safety proof attempted).
    expect(
      classifyCurvedHolePoint({ pathData: D, point: { x: 50, y: 50 }, fillRule: 'evenodd' }).kind,
    ).toBe('ambiguous');
    expect(
      classifyCurvedHolePoint({ pathData: D, point: { x: 150, y: 150 }, fillRule: 'evenodd' }).kind,
    ).toBe('ambiguous');
    // Direct self-cross proof: the inner polyline crosses itself, so a
    // complete relation check would have to refuse. Pin it as true here so
    // the missing check stays visible (this part passes; the cert gap is
    // that the classifier never consults it).
    const pts = contours[1]!.points;
    const dir = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
      (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
    const cross = (p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, p4: { x: number; y: number }) => {
      const d1 = dir(p3, p4, p1);
      const d2 = dir(p3, p4, p2);
      const d3 = dir(p1, p2, p3);
      const d4 = dir(p1, p2, p4);
      return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    };
    let self = false;
    for (let i = 0; i < pts.length && !self; i += 1) {
      for (let j = i + 2; j < pts.length && !self; j += 1) {
        if (i === 0 && j === pts.length - 1) continue;
        if (cross(pts[i]!, pts[(i + 1) % pts.length]!, pts[j]!, pts[(j + 1) % pts.length]!)) self = true;
      }
    }
    expect(self).toBe(true);
  });
});

describe('safety-cert: borderline non-uniform frames refuse (similarity only)', () => {
  it('1.02x stretch refuses: only complete similarity is allowed', () => {
    // Only exact similarity passes. A 2% axis stretch is non-uniform and
    // must refuse fail-closed; the local margin is isotropic and cannot
    // cover direction-dependent document error under anisotropy.
    expect(gateCurvedWorldMatrix([1.02, 0, 0, 1, 0, 0]).ok).toBe(false);
    // Same frame through the classifier must also refuse (never a hole).
    // (No Canvas here; the browser cert cross-checks the same frame.)
    const d = 'M0 0H300V200H0Z M30 60C30 40 60 40 60 60C60 80 30 80 30 60Z';
    expect(
      classifyCurvedHolePoint({
        pathData: d,
        point: { x: 57, y: 60 },
        fillRule: 'evenodd',
        worldMatrix: [1.02, 0, 0, 1, 0, 0],
      }).kind,
    ).toBe('ambiguous');
    // Exact similarity still passes (control).
    expect(gateCurvedWorldMatrix([1, 0, 0, 1, 0, 0]).ok).toBe(true);
    expect(gateCurvedWorldMatrix([2, 0, 0, 2, 0, 0]).ok).toBe(true);
  });
});
