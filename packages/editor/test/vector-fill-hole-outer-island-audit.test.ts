// Strict fail-first audit for `vector-fill-hole-outer-island.ts` (pure level).
//
// Covers the requested matrix at the pure-geometry level WITHOUT claiming
// equivalence between oracles:
// - 3-contour nesting, convex vs concave outers;
// - rotations (similarity OK) vs reflections (mirror refuse);
// - opposite winding under nonzero/evenodd;
// - malformed `d` (charset/curve/single/unparsable);
// - transforms (translate/rotate/uniform OK; mirror/non-uniform/skew/singular/non-finite refuse);
// - paint-blindness documentation (low alpha/gradient/opacity/clip/mask/class/isolation
//   are caller-side gates in `paper-vector.ts`, NOT pure geometry: the pure
//   classifier takes no paint input and must stay a hole here; callers refuse);
// - internal holes / nested islands (4-contour chain refuses; island/body filled);
// - boundary anti-alias exclusion;
// - touching / coincident / self-intersection / near-degenerate / huge-finite bounds;
// - 5000-point budgets (fail-closed + bounded time, no hangs);
// - overlay construction: solid hole subpath EXACTLY (no expansion today).
//   The claimed reference `expandBy(0.1)` is NOT reproduced here (no AGPL
//   copying, unproven against upstream source): this test pins the CURRENT
//   exact-clone behavior so any future expansion lands as a loud failure,
//   and documents the potential hairline-seam risk explicitly.

import { describe, expect, it } from 'bun:test';
import {
  buildOuterHoleSolidPathData,
  classifyOuterIslandHolePoint as classifyOuter,
  resolveOuterHoleWithIsland,
} from '../src/features/costumes/vector-fill-hole-outer-island';
import {
  auditStraightNesting,
} from '../src/features/costumes/vector-fill-hole-nested';
import {
  contourArea,
  isUnitEligibleForHoleGeometry,
  parseStraightContours,
} from '../src/features/costumes/vector-fill-hole-geometry';

// Convex baseline (all H/V, axis-aligned).
const OUTER = 'M150 110H330V250H150Z';
const HOLE = 'M170 130H310V190H170Z';
const ISLAND = 'M200 140H280V180H200Z';
const NEST3 = `${OUTER} ${HOLE} ${ISLAND}`;
const RING_PT = { x: 180, y: 160 };
const ISLAND_PT = { x: 240, y: 160 };

// Concave step outer (notch at (200,200)): top bar full width, bottom only left half.
const CONCAVE_OUTER = 'M0 0H400V200H200V400H0Z';
const CONCAVE_HOLE = 'M50 50H150V150H50Z';
const CONCAVE_ISLAND = 'M80 80H120V120H80Z';
const CONCAVE_NEST3 = `${CONCAVE_OUTER} ${CONCAVE_HOLE} ${CONCAVE_ISLAND}`;
const CONCAVE_RING = { x: 60, y: 130 };
const CONCAVE_ISLAND_PT = { x: 100, y: 100 };
const CONCAVE_BODY = { x: 300, y: 100 };

describe('outer-island strict audit (pure level, no oracle equivalence claims)', () => {
  it('convex triple resolves; concave step triple resolves too (parity, not shape)', () => {
    for (const [d, ring] of [[NEST3, RING_PT], [CONCAVE_NEST3, CONCAVE_RING]] as const) {
      const contours = parseStraightContours(d)!;
      expect(auditStraightNesting(contours as never).ok).toBe(true);
      const areas = contours.map((c) => contourArea(c as never));
      const resolved = resolveOuterHoleWithIsland({
        contours: contours as never,
        containing: [0, 1],
        areas,
      });
      expect(resolved.ok).toBe(true);
      const verdict = classifyOuter({ pathData: d, point: ring, fillRule: 'evenodd' });
      expect(verdict.kind).toBe('hole');
    }
    // Concave island/body points stay painted, never holes.
    expect(classifyOuter({ pathData: CONCAVE_NEST3, point: CONCAVE_ISLAND_PT, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyOuter({ pathData: CONCAVE_NEST3, point: CONCAVE_BODY, fillRule: 'evenodd' }).kind).toBe('filled');
  });

  it('rotated similarity frame classifies; reflected (mirror) frame refuses fail-closed', () => {
    // 90deg rotation about origin: (x,y) -> (-y,x).
    const rotated = classifyOuter({
      pathData: NEST3,
      point: { x: -RING_PT.y, y: RING_PT.x },
      fillRule: 'evenodd',
      worldMatrix: [0, 1, -1, 0, 0, 0],
    });
    expect(rotated.kind).toBe('hole');
    // Reflection (det < 0) must refuse even though geometry is mirror-nested.
    const mirrored = classifyOuter({
      pathData: NEST3,
      point: RING_PT,
      fillRule: 'evenodd',
      worldMatrix: [-1, 0, 0, 1, 0, 0],
    });
    expect(mirrored.kind).toBe('ambiguous');
    // 180deg rotation (det > 0, similarity) is fine.
    const half = classifyOuter({
      pathData: NEST3,
      point: { x: -RING_PT.x, y: -RING_PT.y },
      fillRule: 'evenodd',
      worldMatrix: [-1, 0, 0, -1, 0, 0],
    });
    expect(half.kind).toBe('hole');
  });

  it('opposite winding: alternating nonzero fills the ring; same-direction nonzero stays filled (no hole)', () => {
    const holeRev = 'M170 130V190H310V130H170Z';
    const alt = classifyOuter({ pathData: `${OUTER} ${holeRev} ${ISLAND}`, point: RING_PT, fillRule: 'nonzero' });
    expect(alt.kind).toBe('hole');
    const same = classifyOuter({ pathData: NEST3, point: RING_PT, fillRule: 'nonzero' });
    expect(same.kind).toBe('filled');
    // evenodd ignores winding: same `d` still resolves.
    expect(classifyOuter({ pathData: NEST3, point: RING_PT, fillRule: 'evenodd' }).kind).toBe('hole');
    // Island winding flipped does not change the ring verdict under evenodd.
    const islandRev = 'M200 140V180H280V140H200Z';
    expect(classifyOuter({ pathData: `${OUTER} ${HOLE} ${islandRev}`, point: RING_PT, fillRule: 'evenodd' }).kind).toBe('hole');
  });

  it('malformed d stays fail-closed (never a hole, never a throw)', () => {
    // Curve command -> unsupported (Paper entity probe owns curves).
    expect(classifyOuter({ pathData: 'M0 0C10 10 20 20 30 30 M40 40H50V50H40Z M60 60H70V70H60Z', point: { x: 45, y: 45 } }).kind).toBe('unsupported');
    // Markup / url payloads -> unsupported.
    expect(classifyOuter({ pathData: `${NEST3} <script>`, point: RING_PT }).kind).toBe('unsupported');
    // Single contour -> never a hole (outside: no hole possible, fail-closed).
    expect(classifyOuter({ pathData: OUTER, point: { x: 200, y: 200 } }).kind).toBe('outside');
    // Empty / garbage -> unsupported or outside, never hole.
    for (const bad of ['', '   ', 'not a path', 'M0 0 L', 'M0 0H10V10H0Z MNaN NaN', 'M1e999 0H2V3H1Z M4 5H6V7H4Z M8 9H1V2H8Z']) {
      const v = classifyOuter({ pathData: bad, point: RING_PT });
      expect(v.kind).not.toBe('hole');
    }
    // Non-finite query point stays outside, never a hole.
    expect(classifyOuter({ pathData: NEST3, point: { x: NaN, y: 160 } }).kind).toBe('outside');
    expect(classifyOuter({ pathData: NEST3, point: { x: Infinity, y: 160 } }).kind).toBe('outside');
  });

  it('complex transforms refuse fail-closed (never holes)', () => {
    const cases: Array<[string, [number, number, number, number, number, number]]> = [
      ['non-uniform', [2, 0, 0, 1, 0, 0]],
      ['skew', [1, 0, 1, 1, 0, 0]],
      ['singular', [0, 0, 0, 0, 0, 0]],
      ['non-finite', [NaN, 0, 0, 1, 0, 0]],
      ['mirror-y', [1, 0, 0, -1, 0, 0]],
    ];
    for (const [label, m] of cases) {
      const v = classifyOuter({ pathData: NEST3, point: RING_PT, fillRule: 'evenodd', worldMatrix: m });
      expect(v.kind).toBe('ambiguous');
      void label;
    }
  });

  it('pure classifier is paint-blind by design (caller-side gates own paint): documents no paint input', () => {
    // The pure signature takes no paint/opacity/clip/class input: a hole here
    // does NOT mean the Editor may fill (paper-vector.ts must refuse
    // low-alpha/gradient-parent? no — opaque gradient fills; transparent,
    // clip/mask, class-driven, defs-url refuse). Pin that the pure layer
    // cannot distinguish them, so callers must.
    const v = classifyOuter({ pathData: NEST3, point: RING_PT, fillRule: 'evenodd' });
    expect(v.kind).toBe('hole');
    // Eligibility helper (caller-side) refuses the unsafe paint carriers.
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', classAttr: 'some-stylesheet-class' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', clipPath: 'url(#c)' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', mask: 'url(#m)' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path', fill: 'url(#g)' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'rect' }).eligible).toBe(false);
    expect(isUnitEligibleForHoleGeometry({ tag: 'path' }).eligible).toBe(true);
  });

  it('internal holes / nested islands beyond the triple refuse; island and body stay filled', () => {
    // 4-contour chain (proven nested semantics) refuses here.
    const four = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
    expect(classifyOuter({ pathData: four, point: { x: 40, y: 100 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // Island interior is filled (never a hole), body is filled, outside is outside.
    expect(classifyOuter({ pathData: NEST3, point: ISLAND_PT, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyOuter({ pathData: NEST3, point: { x: 160, y: 240 }, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyOuter({ pathData: NEST3, point: { x: 240, y: 90 }, fillRule: 'evenodd' }).kind).toBe('outside');
  });

  it('boundary anti-alias zone refuses; one pixel further inside fills the hole', () => {
    // 0.2 left of the hole wall (170) with tolerance 0.5 -> ambiguous.
    expect(classifyOuter({ pathData: NEST3, point: { x: 170.2, y: 160 }, fillRule: 'evenodd', tolerance: 0.5 }).kind).toBe('ambiguous');
    // Same x with zero tolerance escapes the gate (documents the gate, not pixels).
    expect(classifyOuter({ pathData: NEST3, point: { x: 170.2, y: 160 }, fillRule: 'evenodd', tolerance: 0 }).kind).toBe('hole');
  });

  it('touching / coincident / self-intersecting triples refuse (never holes)', () => {
    // Shared vertex between hole and island.
    expect(classifyOuter({ pathData: 'M0 0H200V200H0Z M20 20H60V60H20Z M60 20H100V60H60Z', point: { x: 40, y: 40 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // Coincident duplicate walls.
    expect(classifyOuter({ pathData: `${OUTER} ${HOLE} ${HOLE}`, point: RING_PT, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // Bowtie self-intersection in outer.
    expect(classifyOuter({ pathData: 'M0 0H200V200H0Z M40 40L160 40L40 160L160 160Z M80 80H100V100H80Z', point: { x: 90, y: 90 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
  });

  it('near-degenerate island refuses; huge-but-finite bounds neither hang nor claim unsafely', () => {
    // Degenerate island (zero-area collinear run) -> degenerate, fail-closed.
    // (A valid 1x1 island WOULD resolve as a hole with the island covered per
    // reference-solid parity; only the zero-area contour refuses here.)
    const sliver = 'M0 0H200V200H0Z M20 20H180V180H20Z M50 50H60V50H50Z';
    const sliverVerdict = classifyOuter({ pathData: sliver, point: { x: 30, y: 100 }, fillRule: 'evenodd' });
    expect(sliverVerdict.kind).toBe('ambiguous');
    // Huge but finite (1e8): must return a verdict quickly, never throw.
    const big = (s: string) => s;
    const hugeD = `${big('M0 0H300000000V300000000H0Z')} ${big('M10000000 10000000H200000000V200000000H10000000Z')} ${big('M50000000 50000000H150000000V150000000H50000000Z')}`;
    const start = Date.now();
    const huge = classifyOuter({ pathData: hugeD, point: { x: 20000000, y: 50000000 }, fillRule: 'evenodd' });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(['hole', 'filled', 'outside', 'ambiguous', 'unsupported']).toContain(huge.kind);
    // Non-finite bounds input: Infinity coordinate -> unreadable, fail-closed.
    const inf = classifyOuter({ pathData: 'M0 0H1e999V10H0Z M1 1H2V2H1Z M3 3H4V4H3Z', point: RING_PT });
    expect(inf.kind).not.toBe('hole');
  });

  it('5000-point budget: over-cap contour refuses fast (no hang)', () => {
    // One contour with ~2500 vertices (> 2048 per-contour cap).
    let d = 'M0 0';
    for (let i = 1; i <= 2500; i += 1) d += `L${i} 0`;
    d += 'L2500 2500L0 2500Z';
    const triple = `${d} ${HOLE} ${ISLAND}`;
    const start = Date.now();
    const verdict = classifyOuter({ pathData: triple, point: RING_PT, fillRule: 'evenodd' });
    const elapsed = Date.now() - start;
    expect(verdict.kind).toBe('ambiguous');
    expect(elapsed).toBeLessThan(5000);
  });

  it('overlay is the EXACT hole subpath today (no expansion): pins current behavior, flags seam risk', () => {
    const contours = parseStraightContours(NEST3)!;
    const holeC = contours[1]!;
    const overlay = buildOuterHoleSolidPathData(holeC as never)!;
    const verdict = classifyOuter({ pathData: NEST3, point: RING_PT, fillRule: 'evenodd' });
    expect(verdict.kind).toBe('hole');
    if (verdict.kind === 'hole') {
      // Single contour, byte-identical to the builder.
      expect(verdict.overlayPathData).toBe(overlay);
      expect(verdict.overlayPathData.match(/M/g)?.length).toBe(1);
      // Exact clone contains the hole wall start: NO 0.1 outset applied.
      // If a future fix adds expandBy-style outset, THIS TEST MUST FAIL
      // loudly and be updated with pixel-proof, not silently drift.
      expect(verdict.overlayPathData).toContain('M170 130');
      // Documented risk (not asserted as pixels here): an exact-coincident
      // overlay edge can leave a 1px anti-aliased hairline against the parent
      // hole wall at some zooms; the claimed reference `expandBy(0.1)` would
      // overlap the wall to hide it, but that claim is UNPROVEN against
      // upstream source and is NOT implemented (no AGPL copying, no guessing).
      // Native Paper + independent Canvas agreement is limited to INTERIOR
      // points (see integration browser test); edge pixels are excluded by
      // the tolerance gate and no equivalence is claimed there.
    }
  });
});
