// Nested-island geometry audit for the Scratch fill tool (straight segments).
//
// Scope (new file only; existing Editor / BitmapEditor / paper-vector untouched):
// the straight helper (`vector-fill-hole-geometry.ts`) and the curved helper
// (`vector-fill-hole-curves.ts`) historically refused every nesting deeper than
// one hole (`containing.length !== 2` -> `ambiguous`, any island inside a hole
// -> `ambiguous`). The Paper runtime entity (`paper.contains` / `hitTest` on
// the real compound import) and Canvas 2D (`Path2D` + `fill(rule)` pixels)
// both paint nested islands deterministically: outer -> hole -> island ->
// hole alternates unfilled/filled by parity (evenodd) or winding sum
// (nonzero). This module is the exact-geometry gate for the *limited subset*
// that can be classified without guessing:
//
// - straight-segment, simple (non-self-intersecting), pairwise non-touching
//   contours that are laminar (every pair is disjoint or strictly nested);
// - the claimed hole is the smallest containing contour, its parent is the
//   second smallest, the chain nests strictly, and no other contour sits
//   inside the claimed hole (an outer ring that contains an island stays
//   `ambiguous`: a solid single-path overlay would cover that island).
//
// Everything else stays fail-closed (`ambiguous`, never a hole): crossings,
// contact (including shared vertices / collinear coincidence), self-touch,
// degenerate areas, partial overlaps, duplicate contours, and unreadable
// geometry. CSS / clip / mask / defs `url()` / class-driven paint mixing is
// out of scope here (caller-side fail-closed, unchanged).
//
// Design rules (all fail-closed, reimplemented from SVG behavior, no upstream
// source copied, no AGPL text reproduced):
// - Pure, DOM-free, no Paper.js: inputs are plain point arrays so `bun test`
//   covers the core without a browser. No imports from the sibling helpers
//   (this module is imported BY them; importing them would cycle).
// - Fill rules are honored geometrically: nesting uses parity containment
//   (ray cast, winding-independent) so reversed winding never flips the
//   laminar verdict; the caller still decides painted/unfilled via its own
//   `isPointFilled` (parity / winding sum).
// - Epsilon is `1e-9` (same as the straight helper): touching counts as
//   contact, never as nesting.
// - Sanitization and external-data safety are caller-side (charset/length
//   gates, `url(`/script/markup rejection, `defs`/clip/mask/class decline);
//   this module only sees already-gated point arrays and never parses `d`.

export type NestedPoint = { x: number; y: number };

export type NestedContour = { points: NestedPoint[] };

export type NestedAudit =
  | { ok: true }
  | { ok: false; reason: string };

export type NestedHoleResolution =
  | { ok: true; holeIndex: number; outerIndex: number }
  | { ok: false; reason: string };

const NESTED_EPS = 1e-9;
const NESTED_MIN_AREA = 1e-9;

/**
 * Fail-closed input caps for the straight laminar audit (mirrors the curved
 * helper's `CURVED_MAX_POINTS_*` so a 20k-char `d` can never force unbounded
 * hover work):
 * - more than `NESTED_MAX_POINTS_PER_CONTOUR` vertices in one contour, or more
 *   than `NESTED_MAX_POINTS_TOTAL` vertices overall, refuses as `ambiguous`
 *   (fail-closed), even when the `d` charset/length gate passed;
 * - more than `NESTED_AUDIT_BUDGET` elementary checks (segment-pair touches +
 *   containment edge traversals) refuses as `ambiguous` (fail-closed).
 *
 * Normal small/medium SVGs (tens of vertices, hundreds of pair checks) never
 * approach these bounds, so their verdicts are unchanged. The caps also close
 * the "overall input" bypass: `auditStraightNesting` / `resolveNestedHole`
 * accept raw point arrays (flattened curves, Paper-probe contours), so they
 * must enforce the budgets themselves instead of trusting the caller-side
 * `d` length gate. Budget paths never claim safety: an aborted audit returns
 * `ok: false`, never `ok: true` from a partially scanned pair set.
 */
export const NESTED_MAX_POINTS_PER_CONTOUR = 2048;
export const NESTED_MAX_POINTS_TOTAL = 6000;
/** Shared O(n^2) audit budget (same order as `CURVED_TOPOLOGY_BUDGET`). */
export const NESTED_AUDIT_BUDGET = 400000;

/** True when the contour set is too large to audit exactly (fail-closed). */
export function nestedPointCapsExceeded(contours: NestedContour[]): boolean {
  try {
    let total = 0;
    for (const contour of contours) {
      const n = contour?.points?.length ?? 0;
      if (!(n >= 0) || n > NESTED_MAX_POINTS_PER_CONTOUR) return true;
      total += n;
      if (total > NESTED_MAX_POINTS_TOTAL) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function nestedOrient(a: NestedPoint, b: NestedPoint, c: NestedPoint): number {
  return (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
}

function nestedOnSegment(a: NestedPoint, b: NestedPoint, p: NestedPoint): boolean {
  if (Math.abs(nestedOrient(a, b, p)) > NESTED_EPS) return false;
  return (
    p.x >= Math.min(a.x, b.x) - NESTED_EPS &&
    p.x <= Math.max(a.x, b.x) + NESTED_EPS &&
    p.y >= Math.min(a.y, b.y) - NESTED_EPS &&
    p.y <= Math.max(a.y, b.y) + NESTED_EPS
  );
}

function nestedProperCross(p1: NestedPoint, p2: NestedPoint, p3: NestedPoint, p4: NestedPoint): boolean {
  const d1 = nestedOrient(p3, p4, p1);
  const d2 = nestedOrient(p3, p4, p2);
  const d3 = nestedOrient(p1, p2, p3);
  const d4 = nestedOrient(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function nestedSegmentsTouch(p1: NestedPoint, p2: NestedPoint, p3: NestedPoint, p4: NestedPoint): boolean {
  if (nestedProperCross(p1, p2, p3, p4)) return true;
  if (Math.abs(nestedOrient(p3, p4, p1)) <= NESTED_EPS && nestedOnSegment(p3, p4, p1)) return true;
  if (Math.abs(nestedOrient(p3, p4, p2)) <= NESTED_EPS && nestedOnSegment(p3, p4, p2)) return true;
  if (Math.abs(nestedOrient(p1, p2, p3)) <= NESTED_EPS && nestedOnSegment(p1, p2, p3)) return true;
  if (Math.abs(nestedOrient(p1, p2, p4)) <= NESTED_EPS && nestedOnSegment(p1, p2, p4)) return true;
  return false;
}

function nestedEdgesOf(points: NestedPoint[]): Array<[NestedPoint, NestedPoint]> {
  const edges: Array<[NestedPoint, NestedPoint]> = [];
  if (points.length < 2) return edges;
  let pts = points;
  if (pts.length >= 2) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (Math.abs(first.x - last.x) <= NESTED_EPS && Math.abs(first.y - last.y) <= NESTED_EPS) {
      pts = pts.slice(0, -1);
    }
  }
  if (pts.length < 2) return edges;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (Math.abs(a.x - b.x) <= NESTED_EPS && Math.abs(a.y - b.y) <= NESTED_EPS) continue;
    edges.push([a, b]);
  }
  return edges;
}

export function nestedContourArea(contour: NestedContour): number {
  let sum = 0;
  const pts = contour.points;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function nestedBounds(contour: NestedContour): { x: number; y: number; width: number; height: number } {
  const xs = contour.points.map((p) => p.x);
  const ys = contour.points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function nestedPointInEvenOdd(contour: NestedContour, point: NestedPoint): boolean {
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

function nestedBoundsContain(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Number.isFinite(outer.x) && Number.isFinite(outer.y) &&
    Number.isFinite(inner.x) && Number.isFinite(inner.y) &&
    outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

/**
 * Fail-closed laminar audit for straight contours (SVG fill closes every
 * subpath, so closing edges are always included):
 * - degenerate / non-finite geometry refuses;
 * - point caps (`NESTED_MAX_POINTS_*`) refuse before any O(n^2) work;
 * - any self-intersection or collinear self-touch within one contour refuses
 *   (adjacent edges sharing a vertex only refuse on a collinear run past the
 *   shared vertex);
 * - any inter-contour touch / crossing / collinear coincidence refuses;
 * - any partially overlapping pair (neither disjoint nor strictly nested)
 *   refuses: strict nesting needs bounds containment one way plus ALL
 *   vertices of the inner contour inside the outer contour (parity);
 *   split vertices mean overlap;
 * - more than `NESTED_AUDIT_BUDGET` elementary checks refuses (fail-closed):
 *   the counter is shared across the self / inter / laminar phases and the
 *   laminar vertex scans bill their outer-edge traversals, so an aborted run
 *   never reports `ok: true` from a partially scanned pair set.
 */
export function auditStraightNesting(contours: NestedContour[]): NestedAudit {
  try {
    if (!Array.isArray(contours)) return { ok: false, reason: 'unreadable contour set (fail-closed)' };
    if (nestedPointCapsExceeded(contours)) {
      return { ok: false, reason: 'point cap exceeded (fail-closed)' };
    }
  } catch {
    return { ok: false, reason: 'unreadable contour set (fail-closed)' };
  }
  for (let i = 0; i < contours.length; i += 1) {
    const pts = contours[i]!.points;
    if (pts.length < 3) return { ok: false, reason: 'degenerate contour (fail-closed)' };
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, reason: 'non-finite contour (fail-closed)' };
    }
    if (!Number.isFinite(nestedContourArea(contours[i]!)) || Math.abs(nestedContourArea(contours[i]!)) <= NESTED_MIN_AREA) {
      return { ok: false, reason: 'degenerate contour (fail-closed)' };
    }
  }
  const edgeLists = contours.map((c) => nestedEdgesOf(c.points));
  let checks = 0;
  // Self-intersection (closing edge included).
  for (let i = 0; i < edgeLists.length; i += 1) {
    const edges = edgeLists[i]!;
    for (let a = 0; a < edges.length; a += 1) {
      for (let b = a + 1; b < edges.length; b += 1) {
        checks += 1;
        if (checks > NESTED_AUDIT_BUDGET) {
          return { ok: false, reason: 'audit budget exceeded (fail-closed)' };
        }
        const adjacent = b === a + 1 || (a === 0 && b === edges.length - 1);
        const [p1, p2] = edges[a]!;
        const [p3, p4] = edges[b]!;
        if (adjacent) {
          const sharedIsP2P3 =
            Math.abs(p2.x - p3.x) <= NESTED_EPS && Math.abs(p2.y - p3.y) <= NESTED_EPS;
          const sharedIsP1P4 =
            Math.abs(p1.x - p4.x) <= NESTED_EPS && Math.abs(p1.y - p4.y) <= NESTED_EPS;
          let beyond = false;
          if (sharedIsP2P3) {
            if (nestedOnSegment(p1, p2, p4) && !(Math.abs(p4.x - p2.x) <= NESTED_EPS && Math.abs(p4.y - p2.y) <= NESTED_EPS)) beyond = true;
            if (nestedOnSegment(p3, p4, p1) && !(Math.abs(p1.x - p3.x) <= NESTED_EPS && Math.abs(p1.y - p3.y) <= NESTED_EPS)) beyond = true;
          } else if (sharedIsP1P4) {
            if (nestedOnSegment(p1, p2, p3) && !(Math.abs(p3.x - p1.x) <= NESTED_EPS && Math.abs(p3.y - p1.y) <= NESTED_EPS)) beyond = true;
            if (nestedOnSegment(p3, p4, p2) && !(Math.abs(p2.x - p4.x) <= NESTED_EPS && Math.abs(p2.y - p4.y) <= NESTED_EPS)) beyond = true;
          } else if (nestedSegmentsTouch(p1, p2, p3, p4)) {
            beyond = true;
          }
          if (beyond) return { ok: false, reason: 'contour self-touches (fail-closed)' };
          continue;
        }
        if (nestedSegmentsTouch(p1, p2, p3, p4)) {
          return { ok: false, reason: 'contour self-intersects (fail-closed)' };
        }
      }
    }
  }
  // Inter-contour touch / crossing.
  for (let i = 0; i < edgeLists.length; i += 1) {
    for (let j = i + 1; j < edgeLists.length; j += 1) {
      for (const [p1, p2] of edgeLists[i]!) {
        for (const [p3, p4] of edgeLists[j]!) {
          checks += 1;
          if (checks > NESTED_AUDIT_BUDGET) {
            return { ok: false, reason: 'audit budget exceeded (fail-closed)' };
          }
          if (nestedSegmentsTouch(p1, p2, p3, p4)) {
            return { ok: false, reason: 'contours touch or overlap (fail-closed)' };
          }
        }
      }
    }
  }
  // Laminar (disjoint or strictly nested); anything else is overlap.
  const boundsList = contours.map((c) => nestedBounds(c));
  for (let i = 0; i < contours.length; i += 1) {
    for (let j = i + 1; j < contours.length; j += 1) {
      const bi = boundsList[i]!;
      const bj = boundsList[j]!;
      const iContainsJ = nestedBoundsContain(bi, bj);
      const jContainsI = nestedBoundsContain(bj, bi);
      if (!iContainsJ && !jContainsI) continue; // Bounds-disjoint (or edge-overlapping without containment): disjoint.
      // Bounds claim nesting one way: every vertex of the inner contour must
      // sit inside the outer contour (parity, winding-independent). A split
      // verdict means the walls interleave without touching at the sampled
      // resolution -> overlap, fail closed. Each vertex scan bills its
      // outer-edge traversals against the shared budget so huge laminar
      // families refuse instead of hanging hover.
      if (iContainsJ && !jContainsI) {
        let inside = 0;
        const outerPts = contours[i]!.points.length;
        for (const p of contours[j]!.points) {
          checks += outerPts;
          if (checks > NESTED_AUDIT_BUDGET) {
            return { ok: false, reason: 'audit budget exceeded (fail-closed)' };
          }
          if (nestedPointInEvenOdd(contours[i]!, p)) inside += 1;
        }
        if (inside === contours[j]!.points.length) continue;
        if (inside === 0) continue; // Bounds overlap but geometry is disjoint (e.g. L-shapes): allowed.
        return { ok: false, reason: 'contours partially overlap (fail-closed)' };
      }
      if (jContainsI && !iContainsJ) {
        let inside = 0;
        const outerPts = contours[j]!.points.length;
        for (const p of contours[i]!.points) {
          checks += outerPts;
          if (checks > NESTED_AUDIT_BUDGET) {
            return { ok: false, reason: 'audit budget exceeded (fail-closed)' };
          }
          if (nestedPointInEvenOdd(contours[j]!, p)) inside += 1;
        }
        if (inside === contours[i]!.points.length) continue;
        if (inside === 0) continue;
        return { ok: false, reason: 'contours partially overlap (fail-closed)' };
      }
      // Bounds contain each other both ways (identical boxes): coincident or
      // duplicate contours -> renderer-dependent, fail closed.
      return { ok: false, reason: 'contours partially overlap (fail-closed)' };
    }
  }
  return { ok: true };
}

/**
 * Resolve the hole/outer pair for an unfilled point in a laminar family.
 *
 * Preconditions (checked by the caller): the point is geometrically unfilled
 * under the active fill rule and sits inside >= 1 contours. This function
 * proves the exact limited subset:
 * - sort the containing contours by area (largest = outermost);
 * - every step of the chain nests strictly (bounds + parity sample);
 * - the smallest (hole) is strictly smaller than its parent and strictly
 *   inside it;
 * - no non-containing contour sits inside the hole (an outer ring that
 *   contains an island stays `ambiguous`: a solid overlay would cover it).
 * Anything else is `ambiguous`, never a hole.
 */
export function resolveNestedHole(options: {
  contours: NestedContour[];
  containing: number[];
  areas: number[];
}): NestedHoleResolution {
  const { contours, containing, areas } = options;
  try {
    if (!Array.isArray(contours) || !Array.isArray(containing) || !Array.isArray(areas)) {
      return { ok: false, reason: 'unreadable pairing (fail-closed)' };
    }
    if (nestedPointCapsExceeded(contours)) {
      return { ok: false, reason: 'point cap exceeded (fail-closed)' };
    }
  } catch {
    return { ok: false, reason: 'unreadable pairing (fail-closed)' };
  }
  if (containing.length < 2) {
    return { ok: false, reason: `unfilled point pairs ${containing.length} contours (fail-closed)` };
  }
  if (containing.length > NESTED_MAX_POINTS_TOTAL) {
    return { ok: false, reason: 'point cap exceeded (fail-closed)' };
  }
  for (const index of containing) {
    if (!Number.isInteger(index) || index < 0 || index >= contours.length) {
      return { ok: false, reason: 'unreadable pairing (fail-closed)' };
    }
    if (!Number.isFinite(areas[index]!)) {
      return { ok: false, reason: 'unreadable pairing (fail-closed)' };
    }
  }
  let checks = 0;
  const ordered = [...containing].sort((a, b) => Math.abs(areas[b]!) - Math.abs(areas[a]!));
  for (let k = 0; k < ordered.length - 1; k += 1) {
    const outerIdx = ordered[k]!;
    const innerIdx = ordered[k + 1]!;
    const outerBounds = nestedBounds(contours[outerIdx]!);
    const innerBounds = nestedBounds(contours[innerIdx]!);
    if (!(Math.abs(areas[outerIdx]!) > Math.abs(areas[innerIdx]!))) {
      return { ok: false, reason: 'hole is not strictly smaller than its outer contour (fail-closed)' };
    }
    if (!nestedBoundsContain(outerBounds, innerBounds)) {
      return { ok: false, reason: 'hole is not strictly inside its outer contour (fail-closed)' };
    }
    checks += contours[outerIdx]!.points.length;
    if (checks > NESTED_AUDIT_BUDGET) {
      return { ok: false, reason: 'audit budget exceeded (fail-closed)' };
    }
    const sample = contours[innerIdx]!.points[0]!;
    if (!nestedPointInEvenOdd(contours[outerIdx]!, sample)) {
      return { ok: false, reason: 'contours partially overlap (fail-closed)' };
    }
  }
  const holeIndex = ordered[ordered.length - 1]!;
  const outerIndex = ordered[ordered.length - 2]!;
  const holeBounds = nestedBounds(contours[holeIndex]!);
  const outerBounds = nestedBounds(contours[outerIndex]!);
  if (!(holeBounds.width > 0 && holeBounds.height > 0)) {
    return { ok: false, reason: 'degenerate hole bounds (fail-closed)' };
  }
  if (!nestedBoundsContain(outerBounds, holeBounds)) {
    return { ok: false, reason: 'hole is not strictly inside its outer contour (fail-closed)' };
  }
  // A third contour boxed inside the claimed hole is an island the solid
  // overlay would cover -> the hole claim is unsafe. The outer ring of a
  // nested island therefore stays ambiguous; only the innermost hole (which
  // contains nothing) resolves. Island scans bill their parity traversals
  // against the same budget so adversarial families cannot hang hover.
  for (let i = 0; i < contours.length; i += 1) {
    if (ordered.includes(i)) continue;
    checks += 1;
    if (checks > NESTED_AUDIT_BUDGET) {
      return { ok: false, reason: 'audit budget exceeded (fail-closed)' };
    }
    const other = nestedBounds(contours[i]!);
    if (other.width > 0 && other.height > 0 && nestedBoundsContain(holeBounds, other)) {
      checks += contours[holeIndex]!.points.length;
      if (checks > NESTED_AUDIT_BUDGET) {
        return { ok: false, reason: 'audit budget exceeded (fail-closed)' };
      }
      const sample = contours[i]!.points[0]!;
      if (nestedPointInEvenOdd(contours[holeIndex]!, sample)) {
        return { ok: false, reason: 'hole contains an island contour (fail-closed)' };
      }
    }
    // Consistency: a non-containing contour that geometrically contains the
    // hole would have to contain the point as well -> unreadable pairing.
    if (nestedBoundsContain(other, holeBounds)) {
      checks += contours[i]!.points.length;
      if (checks > NESTED_AUDIT_BUDGET) {
        return { ok: false, reason: 'audit budget exceeded (fail-closed)' };
      }
      const holeSample = contours[holeIndex]!.points[0]!;
      if (nestedPointInEvenOdd(contours[i]!, holeSample)) {
        return { ok: false, reason: 'contours partially overlap (fail-closed)' };
      }
    }
  }
  return { ok: true, holeIndex, outerIndex };
}

/**
 * Unsupported-case enumeration for status surfaces (no guessing, no AGPL
 * text): laminar straight nesting only; crossings / contact / self-touch /
 * partial overlap / duplicate contours / island-bearing outer rings /
 * clip-mask / defs-url / class-driven paint / invisibility / singular
 * transforms / edge proximity stay fail-closed.
 */
export const NESTED_HOLE_UNSUPPORTED_CASES: readonly string[] = [
  'nested islands resolve only as strictly laminar straight contours (disjoint or nested, never touching)',
  'self-intersecting or self-touching contours (including collinear runs) refuse',
  'touching, crossing, or coincident contours refuse (shared vertices included)',
  'partially overlapping contours refuse (neither disjoint nor strictly nested)',
  'an outer ring containing an island stays ambiguous (a solid overlay would cover the island)',
  'only the innermost unfilled level with no island child becomes a hole overlay',
  'inputs over the point caps (2048 vertices per contour / 6000 total) refuse as ambiguous (fail-closed)',
  'audits over 400000 elementary checks (segment pairs + containment traversals) refuse as ambiguous (fail-closed)',
] as const;
