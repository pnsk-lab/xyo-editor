// Outer-hole-with-island geometry gate (exact 3-contour straight subset).
//
// Scope (new file only; existing Editor / BitmapEditor untouched):
// the straight helper (`vector-fill-hole-geometry.ts`) and the nested audit
// (`vector-fill-hole-nested.ts`) intentionally refuse every outer ring that
// contains an island (`hole contains an island contour` -> ambiguous /
// unsupported) because a solid single-path overlay covers that island.
// The reference fill tool (observed behavior only, no source copied) fills
// such an outer hole by cloning the hole outline as a sibling overlay placed
// directly above the parent (`insertAbove(parent)` parity: our commit path
// `parent.insertBefore(overlay, source.nextSibling)`). The clone is a solid
// single subpath, so the island underneath is visibly covered (reversible:
// the source path is untouched, the overlay is a new sibling, Undo removes
// the overlay and restores the island). Independent oracles prove this:
// - Chromium Canvas2D oracle (3-nest `OUTER/HOLE/ISLAND`): base parent ring
//   alpha 0 / island 255; solid `HOLE` overlay alpha 255 at both ring and
//   island under `evenodd` and `nonzero`; layered green solid over red parent
//   yields green island pixels, while a hole+island compound leaves red.
// - Native Paper oracle (`paper-full.js` in Chromium): 3 children laminar
//   (0 pairwise intersections), areas strictly decreasing outer > hole >
//   island, `CompoundPath.contains(ring) == false` / `contains(island) ==
//   true`, hole-child `contains(islandPt) == true` and hole bounds strictly
//   contain island bounds, so a solid clone necessarily covers the island.
// This module therefore proves the same well-formed safe subset as before
// but returns the reference-solid overlay (hole subpath only), not an
// island-excluding compound:
//
// - exactly 3 straight-segment, simple, pairwise non-touching contours that
//   are laminar (every pair disjoint or strictly nested, same 1e-9 EPS as the
//   nested audit);
// - strictly nested chain outer -> hole -> island (areas strictly decreasing,
//   bounds + parity nesting each step);
// - the click point sits in the outer hole but outside the island
//   (`containing == [outer, hole]`, `isPointFilled == false` under the active
//   rule: evenodd parity even, or nonzero winding sum zero with alternating
//   winding; same-direction nonzero stays `filled` and never becomes a hole);
// - exactly one non-containing contour (the island) strictly inside the hole;
// - similarity transforms only (translation / rotation / uniform-scale;
//   mirror / non-uniform / skew / singular refuse, same as the nested Paper
//   gate); CSS clip/mask, class-driven paint, defs `url()` paint,
//   invisibility, and non-`path` tags stay fail-closed caller-side.
//
// Overlay construction (reference parity, reversible, no destructive edit):
// - the overlay `d` is the hole subpath only (`M...Z`, single contour).
//   Callers copy the source unit's own `transform` verbatim onto the sibling
//   overlay (existing commit path) and insert it directly after the source,
//   so ancestors / siblings / parent paint are untouched; gradient bounds use
//   the hole bounds (existing path). The island is covered by construction
//   (reference parity); Undo removes the sibling and restores the island.
// - edge exclusion (`distanceToContours > tolerance`, widened to
//   `tolerance / sMin` under a world matrix) and the shared point-cap / audit
//   budgets (`2048` per contour / `6000` total / `400000` checks) refuse as
//   `ambiguous`, never as holes.
//
// Everything else stays fail-closed (`ambiguous`, never a hole): crossings,
// contact (including shared vertices), self-touch, partial overlaps,
// degenerate areas, duplicate contours, unreadable geometry, curves/arcs,
// wrong-winding fills, and any contour count other than exactly 3.

import {
  NESTED_AUDIT_BUDGET,
  NESTED_MAX_POINTS_PER_CONTOUR,
  NESTED_MAX_POINTS_TOTAL,
  auditStraightNesting,
  nestedPointCapsExceeded,
} from './vector-fill-hole-nested';
import {
  applyHoleMatrix,
  containingContourIndices,
  contourArea,
  contourBounds,
  contoursOverlap,
  distanceToContours,
  isPathDataSafeForHoleGeometry,
  isPointFilled,
  localToleranceForHoleMatrix,
  normalizeFillRule,
  parseStraightContours,
  tryInvertHoleMatrix,
  type FillRule,
  type HoleBounds,
  type HoleContour,
  type HoleMatrix,
  type HolePoint,
} from './vector-fill-hole-geometry';
import { holeContourToPathData } from './vector-hole-probe-shared';
import { gateCurvedWorldMatrix } from './vector-fill-hole-curves';

export type OuterIslandResolution =
  | { ok: true; holeIndex: number; outerIndex: number; islandIndices: number[] }
  | { ok: false; reason: string };

export type OuterIslandHoleVerdict =
  | {
      kind: 'hole';
      holeIndex: number;
      outerIndex: number;
      islandIndices: number[];
      holeBounds: HoleBounds;
      containing: number[];
      /** Solid `d` (hole subpath only) ready for the sibling overlay; island is covered per reference. */
      overlayPathData: string;
    }
  | { kind: 'filled'; containing: number[] }
  | { kind: 'outside'; containing: number[] }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unsupported'; reason: string };

function outerIslandBoundsContain(
  outer: HoleBounds,
  inner: HoleBounds,
): boolean {
  return (
    Number.isFinite(outer.x) &&
    Number.isFinite(outer.y) &&
    Number.isFinite(inner.x) &&
    Number.isFinite(inner.y) &&
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function pointInEvenOdd(contour: HoleContour, point: HolePoint): boolean {
  let inside = false;
  const pts = contour.points;
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a, a += 1) {
    const pa = pts[a]!;
    const pb = pts[b]!;
    const crosses = (pa.y > point.y) !== (pb.y > point.y);
    if (crosses) {
      const x = pb.x + ((point.y - pb.y) / (pa.y - pb.y)) * (pa.x - pb.x);
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Resolve the outer-hole-with-island triple for a laminar 3-contour family.
 *
 * Preconditions (checked by the caller): laminar audit passed, the point is
 * geometrically unfilled under the active rule, `containing` holds the
 * contours containing the point. This function proves the exact subset:
 * - exactly 3 contours total, exactly 2 containing (outer + hole);
 * - the single non-containing contour sits strictly inside the hole
 *   (bounds + parity sample) and strictly inside the outer chain;
 * - areas strictly decrease outer > hole > island;
 * - the chain nests strictly (hole inside outer, island inside hole).
 * Anything else is `ambiguous`, never a hole.
 */
export function resolveOuterHoleWithIsland(options: {
  contours: HoleContour[];
  containing: number[];
  areas: number[];
}): OuterIslandResolution {
  const { contours, containing, areas } = options;
  try {
    if (!Array.isArray(contours) || !Array.isArray(containing) || !Array.isArray(areas)) {
      return { ok: false, reason: 'unreadable pairing (fail-closed)' };
    }
    if (nestedPointCapsExceeded(contours as never)) {
      return { ok: false, reason: 'point cap exceeded (fail-closed)' };
    }
  } catch {
    return { ok: false, reason: 'unreadable pairing (fail-closed)' };
  }
  if (contours.length !== 3) {
    return { ok: false, reason: `outer-island subset needs exactly 3 contours (fail-closed)` };
  }
  if (containing.length !== 2) {
    return { ok: false, reason: `unfilled point pairs ${containing.length} contours (fail-closed)` };
  }
  for (const index of containing) {
    if (!Number.isInteger(index) || index < 0 || index >= contours.length) {
      return { ok: false, reason: 'unreadable pairing (fail-closed)' };
    }
    if (!Number.isFinite(areas[index]!)) {
      return { ok: false, reason: 'unreadable pairing (fail-closed)' };
    }
  }
  const ordered = [...containing].sort((a, b) => Math.abs(areas[b]!) - Math.abs(areas[a]!));
  const outerIndex = ordered[0]!;
  const holeIndex = ordered[1]!;
  if (!(Math.abs(areas[outerIndex]!) > Math.abs(areas[holeIndex]!))) {
    return { ok: false, reason: 'hole is not strictly smaller than its outer contour (fail-closed)' };
  }
  const outerBounds = contourBounds(contours[outerIndex]!);
  const holeBounds = contourBounds(contours[holeIndex]!);
  if (!outerIslandBoundsContain(outerBounds, holeBounds)) {
    return { ok: false, reason: 'hole is not strictly inside its outer contour (fail-closed)' };
  }
  // Parity sample: hole strictly inside outer (laminar audit already proved
  // global disjoint-or-nested, this pins the chain direction).
  if (!pointInEvenOdd(contours[outerIndex]!, contours[holeIndex]!.points[0]!)) {
    return { ok: false, reason: 'contours partially overlap (fail-closed)' };
  }
  // The single non-containing contour must be the island inside the hole.
  const islandCandidates = [0, 1, 2].filter((i) => !ordered.includes(i));
  if (islandCandidates.length !== 1) {
    return { ok: false, reason: 'unreadable pairing (fail-closed)' };
  }
  const islandIndex = islandCandidates[0]!;
  if (!Number.isFinite(areas[islandIndex]!)) {
    return { ok: false, reason: 'unreadable pairing (fail-closed)' };
  }
  if (!(Math.abs(areas[holeIndex]!) > Math.abs(areas[islandIndex]!))) {
    return { ok: false, reason: 'hole is not strictly smaller than its outer contour (fail-closed)' };
  }
  const islandBounds = contourBounds(contours[islandIndex]!);
  if (!(holeBounds.width > 0 && holeBounds.height > 0 && islandBounds.width > 0 && islandBounds.height > 0)) {
    return { ok: false, reason: 'degenerate hole bounds (fail-closed)' };
  }
  if (!outerIslandBoundsContain(holeBounds, islandBounds)) {
    return { ok: false, reason: 'contours partially overlap (fail-closed)' };
  }
  if (!outerIslandBoundsContain(outerBounds, islandBounds)) {
    return { ok: false, reason: 'contours partially overlap (fail-closed)' };
  }
  if (!pointInEvenOdd(contours[holeIndex]!, contours[islandIndex]!.points[0]!)) {
    return { ok: false, reason: 'contours partially overlap (fail-closed)' };
  }
  if (!pointInEvenOdd(contours[outerIndex]!, contours[islandIndex]!.points[0]!)) {
    return { ok: false, reason: 'contours partially overlap (fail-closed)' };
  }
  return { ok: true, holeIndex, outerIndex, islandIndices: [islandIndex] };
}

/** Signed-area sign helper (winding direction proxy for straight polygons). */
function signedAreaSign(contour: HoleContour): number {
  const area = contourArea(contour);
  if (!Number.isFinite(area) || Math.abs(area) <= 1e-9) return 0;
  return area > 0 ? 1 : -1;
}

/**
 * Build the reference-solid hole `d` (hole subpath only, single contour).
 *
 * Reference parity: the reference tool clones the hole child as a solid
 * sibling directly above the parent, so the island underneath is covered.
 * The source path is untouched (reversible via Undo which removes the
 * sibling). The hole subpath keeps its winding; `fill-rule` is irrelevant
 * for a single contour (both `evenodd` and `nonzero` paint it solid).
 */
export function buildOuterHoleSolidPathData(hole: HoleContour): string | undefined {
  try {
    if (!hole || hole.points.length < 3) return undefined;
    const area = contourArea(hole);
    if (!Number.isFinite(area) || Math.abs(area) <= 1e-9) return undefined;
    const d = holeContourToPathData(hole as never);
    if (!d || d.length === 0 || d.length > 20000) return undefined;
    return d;
  } catch {
    return undefined;
  }
}

/**
 * Build the island-excluding compound `d` (hole + islands, opposite winding).
 *
 * Deprecated for the fill path: kept exported so existing user code keeps
 * linking, but the classifier below no longer uses it. Reference parity
 * covers the island with a solid clone (see `buildOuterHoleSolidPathData`);
 * an island-excluding compound would intentionally deviate from the
 * reference and is retained here only for oracle comparison / documentation.
 *
 * The commit path copies `d` verbatim without setting `fill-rule`, so a
 * same-winding compound would paint the island under the SVG-default
 * `nonzero`. Forcing the island winding opposite the hole winding excludes
 * the island under BOTH `evenodd` (parity) and `nonzero` (winding sum zero),
 * with no bleed and no extra attributes. The hole subpath keeps its winding;
 * each island subpath is reversed when its sign matches the hole sign.
 */
export function buildIslandExcludingHolePathData(
  hole: HoleContour,
  islands: HoleContour[],
): string | undefined {
  try {
    if (!hole || hole.points.length < 3 || !Array.isArray(islands) || islands.length === 0) return undefined;
    const holeSign = signedAreaSign(hole);
    if (holeSign === 0) return undefined;
    const parts: string[] = [holeContourToPathData(hole as never)];
    for (const island of islands) {
      if (!island || island.points.length < 3) return undefined;
      const islandSign = signedAreaSign(island);
      if (islandSign === 0) return undefined;
      let pts = island.points;
      if (islandSign === holeSign) {
        pts = [...island.points].reverse();
      }
      parts.push(holeContourToPathData({ points: pts, closed: island.closed } as never));
    }
    const combined = parts.join(' ');
    if (combined.length === 0 || combined.length > 20000) return undefined;
    return combined;
  } catch {
    return undefined;
  }
}

/**
 * Classify one document/local point for the outer-hole-with-island subset.
 *
 * Mirrors `classifyHolePoint` gates (charset/length, point caps, world-matrix
 * inverse, edge exclusion with `tolerance / sMin` widening, overlap refusal,
 * laminar audit, degenerate-area refusal) then proves the 3-contour
 * outer-hole triple. Returns a `hole` with the reference-solid
 * `overlayPathData` (hole subpath only; the island is covered per reference,
 * reversible via Undo) only for that exact subset; everything else is
 * `filled` / `outside` / `ambiguous` / `unsupported` (fail-closed, never a
 * best-effort hole).
 */
export function classifyOuterIslandHolePoint(options: {
  pathData: string;
  point: HolePoint;
  fillRule?: string | null;
  worldMatrix?: HoleMatrix | null;
  tolerance?: number;
}): OuterIslandHoleVerdict {
  const { pathData, point } = options;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { kind: 'outside', containing: [] };
  if (!isPathDataSafeForHoleGeometry(pathData)) {
    return /[CcSsQqTtAa]/.test(pathData)
      ? { kind: 'unsupported', reason: 'curved path needs the Paper entity probe (fail-closed)' }
      : { kind: 'unsupported', reason: 'unreadable path data (fail-closed)' };
  }
  const fillRule: FillRule = normalizeFillRule(options.fillRule);
  const tolerance = options.tolerance ?? 0.5;
  // Exact-placement gate (same as the nested Paper gate): translation /
  // rotation / uniform-scale only. Mirrors, non-uniform scales, skews, and
  // singular frames refuse here even though the straight helper would widen
  // the edge zone for them: a solid overlay must place exactly,
  // never approximately.
  if (options.worldMatrix) {
    try {
      const gate = gateCurvedWorldMatrix(options.worldMatrix);
      if (!gate.ok) return { kind: 'ambiguous', reason: `${gate.reason} (fail-closed)` };
    } catch {
      return { kind: 'ambiguous', reason: 'hole transform is unreadable (fail-closed)' };
    }
  }
  const contours = parseStraightContours(pathData);
  if (!contours) {
    return { kind: 'outside', containing: [] };
  }
  if (contours.length !== 3) {
    return { kind: 'ambiguous', reason: 'outer-island subset needs exactly 3 contours (fail-closed)' };
  }
  if (nestedPointCapsExceeded(contours as never)) {
    return { kind: 'ambiguous', reason: 'point cap exceeded (fail-closed)' };
  }
  let local = point;
  if (options.worldMatrix) {
    const inverse = tryInvertHoleMatrix(options.worldMatrix);
    if (!inverse) return { kind: 'ambiguous', reason: 'singular/unreadable transform (fail-closed)' };
    local = applyHoleMatrix(inverse, point);
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) {
      return { kind: 'ambiguous', reason: 'transform maps point out of range (fail-closed)' };
    }
  }
  if (Number.isFinite(tolerance) && tolerance > 0) {
    const localTolerance = options.worldMatrix
      ? localToleranceForHoleMatrix(options.worldMatrix, tolerance)
      : tolerance;
    const edgeDistance = distanceToContours(contours as never, local as never);
    if (!(edgeDistance > localTolerance)) {
      return { kind: 'ambiguous', reason: 'point is on/near a painted edge (fail-closed)' };
    }
  }
  if (contoursOverlap(contours as never)) {
    return { kind: 'ambiguous', reason: 'contours overlap (fail-closed)' };
  }
  {
    const nesting = auditStraightNesting(contours as never);
    if (!nesting.ok) {
      return { kind: 'ambiguous', reason: nesting.reason };
    }
  }
  const areas = contours.map((contour) => contourArea(contour as never));
  if (areas.some((area) => !Number.isFinite(area) || Math.abs(area) <= 1e-9)) {
    return { kind: 'ambiguous', reason: 'degenerate contour (fail-closed)' };
  }
  const containing = containingContourIndices(contours as never, local as never, fillRule as never);
  if (containing.length === 0) return { kind: 'outside', containing };
  if (isPointFilled(contours as never, local as never, fillRule as never)) {
    return { kind: 'filled', containing };
  }
  const resolved = resolveOuterHoleWithIsland({ contours: contours as never, containing, areas });
  if (!resolved.ok) {
    return { kind: 'ambiguous', reason: resolved.reason };
  }
  const hole = contours[resolved.holeIndex]!;
  const overlayPathData = buildOuterHoleSolidPathData(hole as never);
  if (!overlayPathData) {
    return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
  }
  const holeBounds = contourBounds(hole as never);
  if (!(holeBounds.width > 0 && holeBounds.height > 0)) {
    return { kind: 'ambiguous', reason: 'degenerate hole bounds (fail-closed)' };
  }
  return {
    kind: 'hole',
    holeIndex: resolved.holeIndex,
    outerIndex: resolved.outerIndex,
    islandIndices: resolved.islandIndices,
    holeBounds,
    containing,
    overlayPathData,
  };
}

/** Unsupported-case enumeration for status surfaces (no guessing). */
export const OUTER_ISLAND_UNSUPPORTED_CASES: readonly string[] = [
  'outer-island subset needs exactly 3 straight laminar contours (outer -> hole -> island, disjoint or strictly nested, never touching)',
  'self-intersecting or self-touching contours refuse (including collinear runs)',
  'touching, crossing, or coincident contours refuse (shared vertices included)',
  'partially overlapping contours refuse (neither disjoint nor strictly nested)',
  'points inside the island (filled) or outside all contours stay filled/outside, never holes',
  'same-direction nonzero winding that paints the outer ring stays filled (wrong-winding no-op)',
  'curved segments (C/S/Q/T/A) and arcs (A) need the Paper entity probe (fail-closed here)',
  'clip-path / mask, defs-hosted url(#...) paint, class-driven paint, and invisibility refuse caller-side (fail-closed)',
  'mirror / non-uniform / skew / singular transforms refuse (translation / rotation / uniform-scale only)',
  'points within tolerance of a painted edge refuse (anti-alias zone)',
  'inputs over the point caps (2048 vertices per contour / 6000 total) refuse as ambiguous (fail-closed)',
  'audits over 400000 elementary checks (segment pairs + containment traversals) refuse as ambiguous (fail-closed)',
  'more or fewer than 3 contours refuse (proven SVG complex semantics stay fail-closed)',
] as const;

export { NESTED_AUDIT_BUDGET, NESTED_MAX_POINTS_PER_CONTOUR, NESTED_MAX_POINTS_TOTAL };
