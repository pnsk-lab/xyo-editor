// Outer-hole-with-island exact-geometry coverage (V-5 safe subset).
//
// Limited subset only: exactly 3 straight, simple, laminar (disjoint or
// strictly nested, never touching) contours, outer -> hole -> island, with an
// unfilled outer-hole point (containing == [outer, hole]). Only that triple
// becomes a `hole` with the reference-solid `d` (hole subpath only; the
// island is covered per reference, reversible via Undo which removes the
// sibling overlay). Everything else stays fail-closed: same-direction
// nonzero fills, edge proximity, touch/overlap/self-touch, != 3 contours,
// curves, and mirror / non-uniform / skew / singular transforms.
//
// Reference parity note (independent oracles, no upstream source copied):
// Chromium Canvas2D shows a solid `HOLE` overlay paints both ring and island
// (alpha 255 under evenodd/nonzero) and layered green-solid over red parent
// yields green island pixels; native Paper shows the hole child contains the
// island point with laminar (0-intersection) nesting. The legacy
// island-excluding compound is retained only as a deprecated helper for
// oracle comparison, never for fills.

import { describe, expect, it } from 'bun:test';
import {
  buildIslandExcludingHolePathData,
  buildOuterHoleSolidPathData,
  classifyOuterIslandHolePoint,
  resolveOuterHoleWithIsland,
} from '../src/features/costumes/vector-fill-hole-outer-island';
import {
  classifyHolePoint,
  containingContourIndices,
  contourArea,
  isPointFilled,
  normalizeFillRule,
  parseStraightContours,
} from '../src/features/costumes/vector-fill-hole-geometry';
import { auditStraightNesting } from '../src/features/costumes/vector-fill-hole-nested';

// Straight fixtures (all H/V, all coordinates original to this file).
const OUTER = 'M150 110H330V250H150Z';
const HOLE = 'M170 130H310V190H170Z';
const ISLAND = 'M200 140H280V180H200Z';
const NEST3 = `${OUTER} ${HOLE} ${ISLAND}`;

const HOLE_REV = 'M170 130V190H310V130H170Z';
const ISLAND_REV = 'M200 140V180H280V140H200Z';
const NEST3_NONZERO_ALT = `${OUTER} ${HOLE_REV} ${ISLAND}`;
const NEST3_SAME_DIR = `${OUTER} ${HOLE} ${ISLAND}`;

const OUTER_RING_PT = { x: 180, y: 160 };
const ISLAND_PT = { x: 240, y: 160 };
const BODY_PT = { x: 160, y: 240 };
const OUTSIDE_PT = { x: 240, y: 90 };

function signedAreasOfCompound(compound: string): number[] {
  const contours = parseStraightContours(compound)!;
  return contours.map((c) => contourArea(c as never));
}

describe('outer-island resolution (exact 3-contour subset)', () => {
  it('laminar audit passes but the straight classifier stays fail-closed on the outer ring', () => {
    const contours = parseStraightContours(NEST3)!;
    expect(auditStraightNesting(contours as never).ok).toBe(true);
    // The historical single-hole classifier refuses the island-bearing ring.
    expect(classifyHolePoint({ pathData: NEST3, point: OUTER_RING_PT, fillRule: 'evenodd' }).kind).toBe('ambiguous');
  });

  it('resolves the outer triple directly (hole + parent + single island)', () => {
    const contours = parseStraightContours(NEST3)!;
    const areas = contours.map((c) => contourArea(c as never));
    const resolved = resolveOuterHoleWithIsland({ contours: contours as never, containing: [0, 1], areas });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.outerIndex).toBe(0);
      expect(resolved.holeIndex).toBe(1);
      expect(resolved.islandIndices).toEqual([2]);
    }
  });

  it('classifies the outer ring as a hole with the reference-solid overlay (island covered)', () => {
    const verdict = classifyOuterIslandHolePoint({ pathData: NEST3, point: OUTER_RING_PT, fillRule: 'evenodd' });
    expect(verdict.kind).toBe('hole');
    if (verdict.kind === 'hole') {
      expect(verdict.outerIndex).toBe(0);
      expect(verdict.holeIndex).toBe(1);
      expect(verdict.islandIndices).toEqual([2]);
      expect(verdict.containing).toEqual([0, 1]);
      // Reference-solid `d` holds exactly the hole subpath (single contour).
      expect(verdict.overlayPathData.match(/M/g)?.length).toBe(1);
      expect(verdict.overlayPathData.endsWith('Z')).toBe(true);
      expect(verdict.overlayPathData).toContain('M170 130');
      // The solid overlay paints both the ring and the island under BOTH
      // rules (reference covers the island; Undo restores it). A single
      // contour never parses via `parseStraightContours` (>= 2 required),
      // so oracle against the source hole contour directly.
      const sourceContours = parseStraightContours(NEST3)!;
      const holeC = sourceContours[1]!;
      for (const rule of ['evenodd', 'nonzero'] as const) {
        // Outer ring point: inside hole -> painted.
        expect(isPointFilled([holeC] as never, OUTER_RING_PT as never, rule as never)).toBe(true);
        // Island interior: inside the solid hole -> painted (covered).
        expect(isPointFilled([holeC] as never, ISLAND_PT as never, rule as never)).toBe(true);
      }
      // Solid builder agrees byte-for-byte with the classifier overlay.
      const contours = parseStraightContours(NEST3)!;
      expect(buildOuterHoleSolidPathData(contours[1]! as never)).toBe(verdict.overlayPathData);
    }
    // Island / body stay filled, outside stays outside (never holes).
    expect(classifyOuterIslandHolePoint({ pathData: NEST3, point: ISLAND_PT, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyOuterIslandHolePoint({ pathData: NEST3, point: BODY_PT, fillRule: 'evenodd' }).kind).toBe('filled');
    expect(classifyOuterIslandHolePoint({ pathData: NEST3, point: OUTSIDE_PT, fillRule: 'evenodd' }).kind).toBe('outside');
  });

  it('honors nonzero winding: alternating fills the hole, same direction is a wrong-winding no-op', () => {
    // Alternating (outer CW, hole CCW, island CW): outer ring unfilled -> hole.
    const alt = classifyOuterIslandHolePoint({ pathData: NEST3_NONZERO_ALT, point: OUTER_RING_PT, fillRule: 'nonzero' });
    expect(alt.kind).toBe('hole');
    if (alt.kind === 'hole') {
      // Solid even for the alternating case (single contour covers island).
      expect(alt.overlayPathData.match(/M/g)?.length).toBe(1);
    }
    // Same direction: nonzero sums to filled -> no hole (wrong-winding no-op).
    const same = classifyOuterIslandHolePoint({ pathData: NEST3_SAME_DIR, point: OUTER_RING_PT, fillRule: 'nonzero' });
    expect(same.kind).toBe('filled');
    // Evenodd ignores winding: the same-direction `d` still resolves.
    const even = classifyOuterIslandHolePoint({ pathData: NEST3_SAME_DIR, point: OUTER_RING_PT, fillRule: 'evenodd' });
    expect(even.kind).toBe('hole');
  });

  it('honors translated / rotated / uniform-scale transforms and refuses complex frames', () => {
    // Ancestor translate(10 20): document point shifts by the same offset.
    const translated = classifyOuterIslandHolePoint({
      pathData: NEST3,
      point: { x: OUTER_RING_PT.x + 10, y: OUTER_RING_PT.y + 20 },
      fillRule: 'evenodd',
      worldMatrix: [1, 0, 0, 1, 10, 20],
    });
    expect(translated.kind).toBe('hole');
    // Uniform scale 2 about the origin.
    const scaled = classifyOuterIslandHolePoint({
      pathData: NEST3,
      point: { x: OUTER_RING_PT.x * 2, y: OUTER_RING_PT.y * 2 },
      fillRule: 'evenodd',
      worldMatrix: [2, 0, 0, 2, 0, 0],
    });
    expect(scaled.kind).toBe('hole');
    // Rotation 90deg about the origin: (x,y) -> (-y,x).
    const rotated = classifyOuterIslandHolePoint({
      pathData: NEST3,
      point: { x: -OUTER_RING_PT.y, y: OUTER_RING_PT.x },
      fillRule: 'evenodd',
      worldMatrix: [0, 1, -1, 0, 0, 0],
    });
    expect(rotated.kind).toBe('hole');
    // Mirror / non-uniform / skew / singular stay fail-closed (never holes).
    expect(
      classifyOuterIslandHolePoint({ pathData: NEST3, point: OUTER_RING_PT, fillRule: 'evenodd', worldMatrix: [-1, 0, 0, 1, 0, 0] }).kind,
    ).toBe('ambiguous');
    expect(
      classifyOuterIslandHolePoint({ pathData: NEST3, point: OUTER_RING_PT, fillRule: 'evenodd', worldMatrix: [2, 0, 0, 1, 0, 0] }).kind,
    ).toBe('ambiguous');
    expect(
      classifyOuterIslandHolePoint({ pathData: NEST3, point: OUTER_RING_PT, fillRule: 'evenodd', worldMatrix: [1, 0, 1, 1, 0, 0] }).kind,
    ).toBe('ambiguous');
    expect(
      classifyOuterIslandHolePoint({ pathData: NEST3, point: OUTER_RING_PT, fillRule: 'evenodd', worldMatrix: [0, 0, 0, 0, 0, 0] }).kind,
    ).toBe('ambiguous');
  });
});

describe('outer-island fail-closed gates (no guessing)', () => {
  it('edge proximity refuses even for the outer hole', () => {
    expect(
      classifyOuterIslandHolePoint({ pathData: NEST3, point: { x: 170.2, y: 160 }, fillRule: 'evenodd', tolerance: 0.5 }).kind,
    ).toBe('ambiguous');
  });

  it('touching / overlapping / self-intersecting triples refuse', () => {
    const touchD = 'M0 0H200V200H0Z M20 20H60V60H20Z M60 20H100V60H60Z';
    expect(classifyOuterIslandHolePoint({ pathData: touchD, point: { x: 40, y: 40 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    const overlapD = 'M0 0H100V100H0Z M50 50H150V150H50Z M200 200H300V300H200Z';
    expect(classifyOuterIslandHolePoint({ pathData: overlapD, point: { x: 75, y: 75 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    const bowtieD = 'M0 0H200V200H0Z M40 40L160 40L40 160L160 160Z M80 80H100V100H80Z';
    expect(classifyOuterIslandHolePoint({ pathData: bowtieD, point: { x: 90, y: 90 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
  });

  it('proven complex semantics stay fail-closed: != 3 contours never become holes', () => {
    // 4 contours (proven nested semantics) refuse here.
    const four = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
    expect(classifyOuterIslandHolePoint({ pathData: four, point: { x: 40, y: 100 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // 2 contours (plain donut) refuse here (owned by the single-hole path).
    const two = 'M0 0H200V200H0Z M40 40H160V160H40Z';
    expect(classifyOuterIslandHolePoint({ pathData: two, point: { x: 100, y: 100 }, fillRule: 'evenodd' }).kind).toBe('ambiguous');
    // Curves stay unsupported (Paper entity probe owns them).
    expect(
      classifyOuterIslandHolePoint({ pathData: 'M0 0C10 10 20 20 30 30 M40 40H50V50H40Z M60 60H70V70H60Z', point: { x: 45, y: 45 } }).kind,
    ).toBe('unsupported');
  });

  it('solid builder covers the island while the deprecated compound excludes it (oracle comparison)', () => {
    const contours = parseStraightContours(NEST3)!;
    const holeC = contours[1]!;
    const islandC = contours[2]!;
    // Solid: single contour painting both ring and island (reference parity).
    const solid = buildOuterHoleSolidPathData(holeC as never)!;
    expect(solid.match(/M/g)?.length).toBe(1);
    expect(isPointFilled([holeC] as never, OUTER_RING_PT as never, 'evenodd' as never)).toBe(true);
    expect(isPointFilled([holeC] as never, ISLAND_PT as never, 'evenodd' as never)).toBe(true);
    expect(isPointFilled([holeC] as never, ISLAND_PT as never, 'nonzero' as never)).toBe(true);
    // Deprecated compound: same winding in `d` reverses the island so the
    // compound excludes it under nonzero (kept only for comparison).
    const built = buildIslandExcludingHolePathData(holeC as never, [islandC as never])!;
    const [builtHole, builtIsland] = signedAreasOfCompound(built);
    expect(Math.sign(builtIsland!)).toBe(-Math.sign(builtHole!));
    // Degenerate / empty inputs never produce a `d`.
    expect(buildOuterHoleSolidPathData({ points: [{ x: 0, y: 0 }], closed: true } as never)).toBeUndefined();
    expect(buildIslandExcludingHolePathData(holeC as never, [])).toBeUndefined();
    expect(
      buildIslandExcludingHolePathData({ points: [{ x: 0, y: 0 }], closed: true } as never, [islandC as never]),
    ).toBeUndefined();
  });

  it('island interiors and bodies are never holes (parity / winding agreement)', () => {
    const contours = parseStraightContours(NEST3)!;
    // Pure parity/winding oracles agree with the classifier on paint state.
    for (const rule of ['evenodd', 'nonzero'] as const) {
      const norm = normalizeFillRule(rule);
      // Outer ring unfilled only for evenodd here (same-direction `d` sums
      // to filled under nonzero) — the classifier already proved the
      // evenodd hole above; here pin the oracle itself.
      expect(containingContourIndices(contours as never, OUTER_RING_PT as never, norm as never).length).toBe(2);
      expect(isPointFilled(contours as never, OUTER_RING_PT as never, 'evenodd' as never)).toBe(false);
      expect(isPointFilled(contours as never, ISLAND_PT as never, 'evenodd' as never)).toBe(true);
      void norm;
    }
    expect(containingContourIndices(contours as never, ISLAND_PT as never, 'evenodd' as never).length).toBe(3);
  });
});
