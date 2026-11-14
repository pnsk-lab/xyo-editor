// Independent fill-hole geometry helper for the Scratch fill tool.
//
// Scope (new files only; existing Editor/BitmapEditor/paper-vector untouched):
// the current `paperVectorHoleTargetAtPoint` treats multi-hole / island /
// overlap / relative-`m` / clip-mask / nested-group inputs as ambiguous or
// unsupported no-ops. This module is the first safe step: pure, DOM-free
// geometry that can discriminate *multiple non-overlapping holes*,
// *relative-`m` hole starts*, *non-overlapping islands*, and *strictly
// laminar nested islands* (outer -> hole -> island -> hole, exact limited
// subset only) without guessing. Outer rings that contain an island stay
// `ambiguous` (a solid overlay would cover the island); only the innermost
// unfilled level with no island child becomes a `hole`.
//
// Design rules (all fail-closed):
// - No Paper.js, no DOM, no Svelte, no history. Inputs are strings/numbers
//   only, so `bun test` covers the core without a browser.
// - SVG default `fill-rule` is `nonzero` (missing/invalid inherits as
//   `nonzero`); `evenodd` only when explicitly specified. Both rules are
//   honored via explicit ray-cast / winding-number containment (never
//   area-sign heuristics alone).
// - Curves (`C/S/Q/T/A`) are *unsupported* here: flattening them without the
//   real renderer would drift from Canvas/Paper pixels. Callers must route
//   curved `d` to the Paper entity probe instead of this helper.
// - Transforms are explicit matrices (`parseSvgTransformList`,
//   `tryInvertMatrix`): singular / non-finite matrices refuse (`null`), and
//   ancestor + own transforms compose outer-first. Callers map the document
//   point to local space before classifying.
// - Z-order is out of scope by design: this helper classifies ONE `d` at ONE
//   point. Callers iterate units top-down for Z-order.
// - Anti-aliasing is handled by an exclusion zone: `distanceToContours` lets
//   callers treat points within `tolerance` of any edge as boundary (no hole
//   claim), matching the zoom-aware `2/zoom` hit tolerance.
// - Sanitization: `isPathDataSafeForHoleGeometry` caps length and charset
//   (`<>&"'`, `url(`, `script` rejected). `defs`-hosted paint (`url(#...)`
//   fill/stroke) and clip/mask attributes are declined by
//   `isUnitEligibleForHoleGeometry` because the baked paint cannot be resolved
//   here.
// - Any uncertain overlap (edge crossings, contact, self-intersection,
//   partial overlap, degenerate contours, unreadable winding) returns
//   `ambiguous` (no-op), never a hole claim. The laminar audit lives in
//   `vector-fill-hole-nested.ts` (self-touch + inter-touch + strict
//   nesting); only that exact subset classifies nested depth.
//
// Reference behavior notes (reimplemented from behavior, no upstream source
// copied): a hole interior is unfilled while its outer body is filled; an
// island inside a hole is filled again (evenodd parity / nonzero winding);
// overlapping contours have renderer-dependent fill and must stay no-ops.
//
// Pixel-oracle contract (see `vector-fill-hole-geometry.browser.test.ts`):
// interior sample points (away from edges by >= tolerance) must agree with
// Canvas 2D pixels (`Path2D` + `fill(rule)`) and Paper.js `contains`; edge
// pixels may disagree due to anti-aliasing and must be excluded via
// `distanceToContours`.

import {
  NESTED_AUDIT_BUDGET,
  NESTED_MAX_POINTS_PER_CONTOUR,
  NESTED_MAX_POINTS_TOTAL,
  auditStraightNesting,
  nestedPointCapsExceeded,
  resolveNestedHole,
} from './vector-fill-hole-nested';

export type FillRule = 'evenodd' | 'nonzero';

export type HolePoint = { x: number; y: number };

export type HoleBounds = { x: number; y: number; width: number; height: number };

export type HoleContour = {
  /** Absolute-coordinate vertices in unit-local space. */
  points: HolePoint[];
  /** True when the subpath ends with Z/z. */
  closed: boolean;
};

export type HoleGeometryVerdict =
  | { kind: 'hole'; holeIndex: number; outerIndex: number; holeBounds: HoleBounds; containing: number[] }
  | { kind: 'filled'; containing: number[] }
  | { kind: 'outside'; containing: number[] }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unsupported'; reason: string };

export const HOLE_GEOMETRY_MAX_CHARS = 20000;

/**
 * Fail-closed iteration budgets for the straight classifier (single source of
 * truth lives in `vector-fill-hole-nested.ts`; these aliases keep the
 * geometry-level import surface stable for callers and tests):
 * - `HOLE_GEOMETRY_MAX_POINTS_PER_CONTOUR` / `HOLE_GEOMETRY_MAX_POINTS_TOTAL`
 *   bound every linear scan (distance, containment, area/bounds). Exceeding
 *   them refuses as `ambiguous` (fail-closed), never as a partial safe claim.
 * - `HOLE_GEOMETRY_AUDIT_BUDGET` bounds every quadratic scan (segment-pair
 *   overlap + nesting audit). Exceeding it refuses as `ambiguous`.
 *
 * The 20k-char `d` gate alone cannot bound hover work: one `d` already holds
 * thousands of vertices (`H`/`V` add a vertex in ~2 chars), and the Paper
 * probe calls `contoursOverlap` / `distanceToContours` / `auditStraightNesting`
 * with raw point arrays that bypass the char gate entirely. Every budgeted
 * entry point therefore enforces the caps itself. Normal small/medium SVGs
 * (tens of vertices, hundreds of pair checks) stay far below the caps, so
 * their verdicts are unchanged.
 */
export const HOLE_GEOMETRY_MAX_POINTS_PER_CONTOUR = NESTED_MAX_POINTS_PER_CONTOUR;
export const HOLE_GEOMETRY_MAX_POINTS_TOTAL = NESTED_MAX_POINTS_TOTAL;
export const HOLE_GEOMETRY_AUDIT_BUDGET = NESTED_AUDIT_BUDGET;

/** Matrix in SVG order [a b c d e f]. */
export type HoleMatrix = [number, number, number, number, number, number];

const SAFE_D_PATTERN = /^[MmLlHhVvZz0-9\s.,+\-eE]+$/;

/**
 * Fail-closed charset/length gate for `d` inputs. Only the straight-segment
 * subset (`M/m/L/l/H/h/V/v/Z/z` + numbers) is supported; anything else
 * (curves, arcs, markup, `url(`, over-long payloads) is rejected so callers
 * can route to the Paper entity probe or no-op.
 */
export function isPathDataSafeForHoleGeometry(data: string): boolean {
  if (typeof data !== 'string') return false;
  const trimmed = data.trim();
  if (trimmed.length === 0 || trimmed.length > HOLE_GEOMETRY_MAX_CHARS) return false;
  if (/[<>&"']/.test(trimmed)) return false;
  if (/url\s*\(/i.test(trimmed)) return false;
  if (/script/i.test(trimmed)) return false;
  if (!SAFE_D_PATTERN.test(trimmed)) return false;
  if (!/[Mm]/.test(trimmed)) return false;
  return true;
}

/**
 * Normalize a `fill-rule` value per SVG: missing/invalid -> `nonzero`
 * (the SVG default). Only an explicit `evenodd` selects even-odd parity.
 * Callers must resolve inheritance + inline `style` before calling (see
 * `paper-vector.ts`); this pure helper only normalizes the resolved string.
 */
export function normalizeFillRule(value: string | null | undefined): FillRule {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'evenodd' ? 'evenodd' : 'nonzero';
}

export type HoleEligibility =
  | { eligible: true }
  | { eligible: false; reason: string; verdict: 'unsupported' | 'ambiguous' };

/**
 * Decline units whose paint cannot be resolved purely (`clip-path`, `mask`,
 * `url(#...)` paint, `class`/stylesheet-driven paint, non-`path` tags,
 * `defs` members). Pure attribute + inline-style check (no `getComputedStyle`:
 * detached test doubles and detached `DOMParser` documents have no cascade,
 * so any `class` that could supply paint/clip/visibility is fail-closed here
 * and by the caller-side inherited resolvers in `paper-vector.ts`).
 * Inline `style` beats presentation attributes per CSS cascade, so `style`
 * is scanned for `clip-path:` / `mask:` / `url(` as well.
 */
export function isUnitEligibleForHoleGeometry(options: {
  tag: string;
  fill?: string | null;
  stroke?: string | null;
  clipPath?: string | null;
  mask?: string | null;
  style?: string | null;
  classAttr?: string | null;
  insideDefs?: boolean;
}): HoleEligibility {
  const tag = (options.tag ?? '').trim().toLowerCase();
  if (tag !== 'path') return { eligible: false, reason: `non-path unit <${tag || '?'}> is not hole-probed (fail-closed)`, verdict: 'unsupported' };
  if (options.insideDefs) return { eligible: false, reason: 'defs-hosted path is not hole-probed (fail-closed)', verdict: 'unsupported' };
  if (hasHoleBlockingHoleClass(options.classAttr)) {
    return { eligible: false, reason: 'class-driven paint cannot be computed detached (fail-closed)', verdict: 'unsupported' };
  }
  const paintRefsUrl = (value: string | null | undefined) => (value != null && /url\s*\(/i.test(value));
  if (paintRefsUrl(options.fill) || paintRefsUrl(options.stroke)) {
    return { eligible: false, reason: 'url(#...) paint needs defs resolution (fail-closed)', verdict: 'unsupported' };
  }
  if ((options.clipPath ?? '').trim() !== '' || (options.mask ?? '').trim() !== '') {
    return { eligible: false, reason: 'clip/mask on hole unit (fail-closed)', verdict: 'unsupported' };
  }
  const style = options.style ?? '';
  if (/clip-path\s*:/i.test(style) || /(^|;)\s*mask\s*:/i.test(style)) {
    return { eligible: false, reason: 'clip/mask style on hole unit (fail-closed)', verdict: 'unsupported' };
  }
  if (/url\s*\(/i.test(style)) {
    return { eligible: false, reason: 'url(#...) style paint needs defs resolution (fail-closed)', verdict: 'unsupported' };
  }
  return { eligible: true };
}

/**
 * True when a `class` attribute carries a stylesheet-capable token.
 * The editor explicit-group token (`xyo-vector-explicit-group`) is inert
 * (no URL/fetch/script surface, no stylesheet targets it — see
 * `vector-svg.ts`) and never forces fail-closed; any other token means page
 * / document CSS could supply `fill`, `fill-rule`, `display`, `visibility`,
 * or `opacity`, which a detached clone + `getComputedStyle` cannot compute.
 */
export function hasHoleBlockingHoleClass(classAttr: string | null | undefined): boolean {
  if (typeof classAttr !== 'string' || classAttr.trim() === '') return false;
  try {
    const tokens = classAttr.split(/[\s\u0000-\u0020]+/).filter((token) => token.length > 0);
    const rest = tokens.filter((token) => token !== 'xyo-vector-explicit-group');
    return rest.length > 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Path parsing (straight segments only; relative `m` resolved to absolute).
// ---------------------------------------------------------------------------

type Token = { kind: 'cmd'; value: string } | { kind: 'num'; value: number };

function tokenizePathData(data: string): Token[] | undefined {
  const tokens: Token[] = [];
  const pattern = /([MmLlHhVvZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(data)) !== null) {
    const gap = data.slice(lastIndex, match.index);
    if (!/^[\s,]*$/.test(gap)) return undefined;
    if (match[1]) tokens.push({ kind: 'cmd', value: match[1] });
    else tokens.push({ kind: 'num', value: Number(match[2]) });
    lastIndex = pattern.lastIndex;
  }
  if (!/^[\s,]*$/.test(data.slice(lastIndex))) return undefined;
  return tokens;
}

/**
 * Parse straight-segment `d` into absolute contours.
 *
 * - A leading relative `m` is treated as absolute per SVG (initial moveto).
 * - Later subpaths may start with relative `m`: the offset applies to the
 *   current point, which is exactly the case the old probe declined. Here it
 *   is resolved arithmetically, so `M0 0H10V10H0Z m20 0H40...` works.
 * - Implicit lineto pairs after `M` (e.g. `M0 0 10 0 10 10`) are honored.
 * - Returns `undefined` for empty input, single contours (no hole possible),
 *   curve/arc commands (unsupported elsewhere), or malformed numbers. Callers
 *   treat `undefined` as "not this helper's case" (`outside`/route-to-Paper),
 *   never as a hole.
 */
export function parseStraightContours(data: string): HoleContour[] | undefined {
  if (!isPathDataSafeForHoleGeometry(data)) return undefined;
  const tokens = tokenizePathData(data.trim());
  if (!tokens || tokens.length === 0) return undefined;
  const contours: HoleContour[] = [];
  let current: HolePoint[] = [];
  let closed = false;
  let cursor: HolePoint = { x: 0, y: 0 };
  let subpathStart: HolePoint = { x: 0, y: 0 };
  let hasCursor = false;
  let command: string | null = null;
  let i = 0;

  const flush = () => {
    if (current.length > 0) {
      contours.push({ points: current, closed });
      current = [];
      closed = false;
    }
  };

  const need = (n: number): number[] | undefined => {
    const out: number[] = [];
    for (let k = 0; k < n; k += 1) {
      const token = tokens[i];
      if (!token || token.kind !== 'num' || !Number.isFinite(token.value)) return undefined;
      out.push(token.value);
      i += 1;
    }
    return out;
  };

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind === 'cmd') {
      command = token.value;
      i += 1;
      if (command === 'Z' || command === 'z') {
        if (current.length > 0) closed = true;
        // Per SVG, Z returns the current point to the subpath start so a
        // following relative `m` offsets from the moveto, not the last line.
        cursor = { ...subpathStart };
        continue;
      }
      if (command === 'M' || command === 'm') {
        flush();
        const pair = need(2);
        if (!pair) return undefined;
        const absolute = command === 'm' && hasCursor
          ? { x: cursor.x + pair[0]!, y: cursor.y + pair[1]! }
          : { x: pair[0]!, y: pair[1]! };
        if (!Number.isFinite(absolute.x) || !Number.isFinite(absolute.y)) return undefined;
        cursor = absolute;
        subpathStart = { ...absolute };
        hasCursor = true;
        current = [{ ...cursor }];
        // Subsequent implicit pairs are lineto with the same relativity.
        command = command === 'm' ? 'l' : 'L';
        continue;
      }
      continue;
    }
    // Numeric token: implicit repetition of the previous command.
    if (!command) return undefined;
    if (command === 'L' || command === 'l') {
      const pair = need(2);
      if (!pair) return undefined;
      const pt = command === 'l'
        ? { x: cursor.x + pair[0]!, y: cursor.y + pair[1]! }
        : { x: pair[0]!, y: pair[1]! };
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return undefined;
      cursor = pt;
      current.push({ ...cursor });
    } else if (command === 'H' || command === 'h') {
      const xs = need(1);
      if (!xs) return undefined;
      const x = command === 'h' ? cursor.x + xs[0]! : xs[0]!;
      if (!Number.isFinite(x)) return undefined;
      cursor = { x, y: cursor.y };
      current.push({ ...cursor });
    } else if (command === 'V' || command === 'v') {
      const ys = need(1);
      if (!ys) return undefined;
      const y = command === 'v' ? cursor.y + ys[0]! : ys[0]!;
      if (!Number.isFinite(y)) return undefined;
      cursor = { x: cursor.x, y };
      current.push({ ...cursor });
    } else {
      return undefined;
    }
  }
  flush();
  if (contours.length < 2) return undefined;
  for (const contour of contours) {
    if (contour.points.length < 3) return undefined;
  }
  return contours;
}

// ---------------------------------------------------------------------------
// Containment: evenodd (ray cast) + nonzero (winding number).
// ---------------------------------------------------------------------------

function pointInPolygonEvenOdd(contour: HolePoint[], point: HolePoint): boolean {
  let inside = false;
  for (let a = 0, b = contour.length - 1; a < contour.length; b = a, a += 1) {
    const pa = contour[a]!;
    const pb = contour[b]!;
    const crosses = (pa.y > point.y) !== (pb.y > point.y);
    if (crosses) {
      const x = pb.x + ((point.y - pb.y) / (pa.y - pb.y)) * (pa.x - pb.x);
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

function windingNumber(contour: HolePoint[], point: HolePoint): number {
  let winding = 0;
  for (let a = 0, b = contour.length - 1; a < contour.length; b = a, a += 1) {
    const pa = contour[a]!;
    const pb = contour[b]!;
    if (pb.y <= point.y) {
      if (pa.y > point.y && isLeft(pb, pa, point) > 0) winding += 1;
    } else {
      if (pa.y <= point.y && isLeft(pb, pa, point) < 0) winding -= 1;
    }
  }
  return winding;
}

function isLeft(a: HolePoint, b: HolePoint, p: HolePoint): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

/** Indices of contours containing the point (edge-adjacent counts as inside for pairing; callers exclude by distance first). */
export function containingContourIndices(contours: HoleContour[], point: HolePoint, fillRule: FillRule): number[] {
  const hits: number[] = [];
  for (let i = 0; i < contours.length; i += 1) {
    const inside = fillRule === 'nonzero'
      ? windingNumber(contours[i]!.points, point) !== 0
      : pointInPolygonEvenOdd(contours[i]!.points, point);
    if (inside) hits.push(i);
  }
  return hits;
}

/** True when the point is painted under the fill rule (parity / nonzero winding sum). */
export function isPointFilled(contours: HoleContour[], point: HolePoint, fillRule: FillRule): boolean {
  if (fillRule === 'nonzero') {
    let total = 0;
    for (const contour of contours) total += windingNumber(contour.points, point);
    return total !== 0;
  }
  return containingContourIndices(contours, point, fillRule).length % 2 === 1;
}

export function contourBounds(contour: HoleContour): HoleBounds {
  const xs = contour.points.map((p) => p.x);
  const ys = contour.points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function contourArea(contour: HoleContour): number {
  let sum = 0;
  const pts = contour.points;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function boundsContain(outer: HoleBounds, inner: HoleBounds): boolean {
  return (
    Number.isFinite(outer.x) && Number.isFinite(outer.y) &&
    Number.isFinite(inner.x) && Number.isFinite(inner.y) &&
    outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function segmentsCross(p1: HolePoint, p2: HolePoint, p3: HolePoint, p4: HolePoint): boolean {
  const d1 = direction(p3, p4, p1);
  const d2 = direction(p3, p4, p2);
  const d3 = direction(p1, p2, p3);
  const d4 = direction(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

function direction(a: HolePoint, b: HolePoint, c: HolePoint): number {
  return (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
}

function contourEdges(contour: HoleContour): Array<[HolePoint, HolePoint]> {
  // SVG fill semantics implicitly close every subpath with a straight segment
  // (open `M...` without `Z` still fills closed). Distance / overlap must see
  // that wall, so every contour with >= 2 points contributes its closing edge
  // regardless of the explicit `closed` flag (kept only for callers).
  // Flattened curves may repeat the start point as the final vertex
  // (curve ends at start + Z): drop that duplicate so the closing edge is
  // not a zero-length point, and skip any other zero-length edges.
  const edges: Array<[HolePoint, HolePoint]> = [];
  let pts = contour.points;
  if (pts.length < 2) return edges;
  if (pts.length >= 2) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (Math.abs(first.x - last.x) <= OVERLAP_EPS && Math.abs(first.y - last.y) <= OVERLAP_EPS) {
      pts = pts.slice(0, -1);
    }
  }
  if (pts.length < 2) return edges;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (Math.abs(a.x - b.x) <= OVERLAP_EPS && Math.abs(a.y - b.y) <= OVERLAP_EPS) continue;
    edges.push([a, b]);
  }
  return edges;
}

const OVERLAP_EPS = 1e-9;

function orientEps(a: HolePoint, b: HolePoint, c: HolePoint): number {
  return (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
}

function onSegmentInclusive(a: HolePoint, b: HolePoint, p: HolePoint): boolean {
  if (Math.abs(orientEps(a, b, p)) > OVERLAP_EPS) return false;
  const minX = Math.min(a.x, b.x) - OVERLAP_EPS;
  const maxX = Math.max(a.x, b.x) + OVERLAP_EPS;
  const minY = Math.min(a.y, b.y) - OVERLAP_EPS;
  const maxY = Math.max(a.y, b.y) + OVERLAP_EPS;
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
}

/**
 * Inclusive segment relation: proper crossings, endpoint touching, and
 * collinear overlap all count as contact (fail-closed). Shared vertices alone
 * therefore count — coincident / touching walls are renderer-dependent fill.
 */
function segmentsTouchOrCross(p1: HolePoint, p2: HolePoint, p3: HolePoint, p4: HolePoint): boolean {
  if (segmentsCross(p1, p2, p3, p4)) return true;
  const d1 = orientEps(p3, p4, p1);
  const d2 = orientEps(p3, p4, p2);
  const d3 = orientEps(p1, p2, p3);
  const d4 = orientEps(p1, p2, p4);
  if (Math.abs(d1) <= OVERLAP_EPS && onSegmentInclusive(p3, p4, p1)) return true;
  if (Math.abs(d2) <= OVERLAP_EPS && onSegmentInclusive(p3, p4, p2)) return true;
  if (Math.abs(d3) <= OVERLAP_EPS && onSegmentInclusive(p1, p2, p3)) return true;
  if (Math.abs(d4) <= OVERLAP_EPS && onSegmentInclusive(p1, p2, p4)) return true;
  return false;
}

/** True when any two contours touch or cross (touching counts fail-closed).
 *
 * Fail-closed budgets: contour sets over the point caps, or needing more
 * than `HOLE_GEOMETRY_AUDIT_BUDGET` segment-pair checks, report `true`.
 * Every caller maps `true` to `ambiguous` (never a hole), so a budget
 * exhaustion degrades to "overlap" instead of a best-effort `false` from a
 * partially scanned pair set. Normal small/medium inputs never reach the
 * caps, so their results are unchanged.
 */
export function contoursOverlap(contours: HoleContour[]): boolean {
  try {
    if (!Array.isArray(contours)) return true;
    if (nestedPointCapsExceeded(contours)) return true;
  } catch {
    return true;
  }
  let edgeLists: Array<Array<[HolePoint, HolePoint]>>;
  try {
    edgeLists = contours.map((c) => contourEdges(c));
  } catch {
    return true;
  }
  let checks = 0;
  for (let i = 0; i < edgeLists.length; i += 1) {
    for (let j = i + 1; j < contours.length; j += 1) {
      for (const [a, b] of edgeLists[i]!) {
        for (const [c, d] of edgeLists[j]!) {
          checks += 1;
          if (checks > HOLE_GEOMETRY_AUDIT_BUDGET) return true;
          if (segmentsTouchOrCross(a, b, c, d)) return true;
        }
      }
    }
  }
  return false;
}

/** Minimum distance from the point to any contour edge (for the anti-alias exclusion zone).
 *
 * Fail-closed budgets: contour sets over the point caps, non-finite query
 * points, unreadable edges, or more than `HOLE_GEOMETRY_MAX_POINTS_TOTAL`
 * edge visits report `NaN`. Every caller treats a non-`> tolerance`
 * distance as `ambiguous` (`NaN > x` is false), so exhaustion widens to the
 * edge zone instead of certifying an interior. Normal inputs are unaffected.
 */
export function distanceToContours(contours: HoleContour[], point: HolePoint): number {
  try {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return Number.NaN;
    if (!Array.isArray(contours)) return Number.NaN;
    if (nestedPointCapsExceeded(contours)) return Number.NaN;
  } catch {
    return Number.NaN;
  }
  let best = Number.POSITIVE_INFINITY;
  let edges = 0;
  try {
    for (const contour of contours) {
      for (const [a, b] of contourEdges(contour)) {
        edges += 1;
        if (edges > HOLE_GEOMETRY_MAX_POINTS_TOTAL) return Number.NaN;
        best = Math.min(best, distancePointToSegment(point, a, b));
      }
    }
  } catch {
    return Number.NaN;
  }
  return best;
}

function distancePointToSegment(p: HolePoint, a: HolePoint, b: HolePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0) || !Number.isFinite(len2)) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---------------------------------------------------------------------------
// Transforms (self-contained; singular/non-finite refuse with null).
// ---------------------------------------------------------------------------

const TRANSFORM_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function parseTransformNumbers(args: string): number[] | undefined {
  const trimmed = args.trim();
  if (trimmed === '') return [];
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const out: number[] = [];
  for (const token of tokens) {
    if (!TRANSFORM_NUMBER.test(token)) return undefined;
    const value = Number(token);
    if (!Number.isFinite(value)) return undefined;
    out.push(value);
  }
  return out;
}

function multiplyHoleMatrix(left: HoleMatrix, right: HoleMatrix): HoleMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

/**
 * Parse an SVG `transform` list (`matrix/translate/scale/rotate/skewX/skewY`,
 * left-to-right composition). Unknown operations fail the whole parse
 * (`undefined`); malformed argument lists skip just that operation.
 */
export function parseSvgTransformList(transform: string): HoleMatrix | undefined {
  if (typeof transform !== 'string' || transform.trim() === '') return undefined;
  const operations = [...transform.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g)];
  if (operations.length === 0) {
    // A non-empty transform with no recognized operation is unreadable.
    return undefined;
  }
  let matrix: HoleMatrix = [1, 0, 0, 1, 0, 0];
  for (const operation of operations) {
    const type = operation[1]!;
    const values = parseTransformNumbers(operation[2] ?? '');
    if (!values) continue;
    if (type === 'matrix') {
      if (values.length < 6) continue;
      matrix = multiplyHoleMatrix(matrix, [values[0]!, values[1]!, values[2]!, values[3]!, values[4]!, values[5]!]);
    } else if (type === 'translate') {
      if (values.length < 1) continue;
      matrix = multiplyHoleMatrix(matrix, [1, 0, 0, 1, values[0]!, values.length >= 2 ? values[1]! : 0]);
    } else if (type === 'scale') {
      if (values.length < 1) continue;
      matrix = multiplyHoleMatrix(matrix, [values[0]!, 0, 0, values.length >= 2 ? values[1]! : values[0]!, 0, 0]);
    } else if (type === 'rotate') {
      if (values.length < 1) continue;
      const radians = (values[0]! * Math.PI) / 180;
      const rotation: HoleMatrix = [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0];
      if (values.length >= 3) {
        const cx = values[1]!;
        const cy = values[2]!;
        const around = multiplyHoleMatrix(
          multiplyHoleMatrix([1, 0, 0, 1, cx, cy], rotation),
          [1, 0, 0, 1, -cx, -cy],
        );
        matrix = multiplyHoleMatrix(matrix, around);
      } else {
        matrix = multiplyHoleMatrix(matrix, rotation);
      }
    } else if (type === 'skewX' || type === 'skewY') {
      if (values.length < 1) continue;
      const tangent = Math.tan((values[0]! * Math.PI) / 180);
      if (!Number.isFinite(tangent)) continue;
      matrix = multiplyHoleMatrix(
        matrix,
        type === 'skewX' ? [1, 0, tangent, 1, 0, 0] : [1, tangent, 0, 1, 0, 0],
      );
    }
  }
  return matrix;
}

/** Compose ancestor + own transform strings outer-first (`undefined` when neither carries one). */
export function composeHoleMatrices(ancestorTransform: string, ownTransform: string): HoleMatrix | undefined {
  const ancestor = ancestorTransform.trim() === '' ? undefined : parseSvgTransformList(ancestorTransform);
  const own = ownTransform.trim() === '' ? undefined : parseSvgTransformList(ownTransform);
  // An explicitly provided but unparsable transform is unreadable (fail-closed).
  if (ancestorTransform.trim() !== '' && !ancestor) return undefined;
  if (ownTransform.trim() !== '' && !own) return undefined;
  if (!ancestor) return own;
  if (!own) return ancestor;
  return multiplyHoleMatrix(ancestor, own);
}

/** Fail-closed inversion (`null` for singular / non-finite; never identity fallback). */
export function tryInvertHoleMatrix(matrix: HoleMatrix | undefined | null): HoleMatrix | null {
  try {
    if (!matrix || matrix.length < 6) return null;
    for (let i = 0; i < 6; i += 1) if (!Number.isFinite(matrix[i])) return null;
    const det = matrix[0]! * matrix[3]! - matrix[1]! * matrix[2]!;
    if (!Number.isFinite(det) || det === 0) return null;
    const inverse: HoleMatrix = [
      matrix[3]! / det,
      -matrix[1]! / det,
      -matrix[2]! / det,
      matrix[0]! / det,
      (matrix[2]! * matrix[5]! - matrix[3]! * matrix[4]!) / det,
      (matrix[1]! * matrix[4]! - matrix[0]! * matrix[5]!) / det,
    ];
    for (let i = 0; i < 6; i += 1) if (!Number.isFinite(inverse[i])) return null;
    return inverse;
  } catch {
    return null;
  }
}

export function applyHoleMatrix(matrix: HoleMatrix, point: HolePoint): HolePoint {
  return {
    x: matrix[0]! * point.x + matrix[2]! * point.y + matrix[4]!,
    y: matrix[1]! * point.x + matrix[3]! * point.y + matrix[5]!,
  };
}

/**
 * Conservative local-space exclusion radius for a document-space tolerance.
 *
 * Under a non-uniform world CTM a single local Euclidean distance does not
 * equal the document/screen distance that Canvas (`getImageData` alpha),
 * Paper.js `hitTest(tolerance)` and the computed SVG rendering all observe.
 * For a linear part `[[a,c],[b,d]]` the document displacement satisfies
 * `|M·delta| >= sMin·|delta|` with `sMin` the minimum singular value, so
 * `local > tolerance / sMin` guarantees `document > tolerance` in every
 * direction. The converse is false (an expanded axis can look safe locally
 * while still inside the document tolerance), so this over-refuses near
 * edges under anisotropy instead of claiming a hole — fail-closed.
 *
 * Returns `Infinity` (refuse everything) for singular / non-finite frames;
 * callers already refuse those via `tryInvertHoleMatrix`, this only widens
 * the edge zone. Identity / missing matrices return the input tolerance.
 */
export function localToleranceForHoleMatrix(
  matrix: HoleMatrix | null | undefined,
  documentTolerance: number,
): number {
  if (!Number.isFinite(documentTolerance) || documentTolerance <= 0) return documentTolerance;
  if (!matrix || matrix.length < 6) return documentTolerance;
  const [a, b, c, d] = [matrix[0]!, matrix[1]!, matrix[2]!, matrix[3]!];
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) {
    return Number.POSITIVE_INFINITY;
  }
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) return Number.POSITIVE_INFINITY;
  const trace = a * a + b * b + c * c + d * d;
  if (!Number.isFinite(trace) || !(trace > 0)) return Number.POSITIVE_INFINITY;
  const disc = trace * trace - 4 * det * det;
  if (!Number.isFinite(disc) || disc < 0) return Number.POSITIVE_INFINITY;
  const sMinSq = (trace - Math.sqrt(disc)) / 2;
  if (!Number.isFinite(sMinSq) || !(sMinSq > 1e-24)) return Number.POSITIVE_INFINITY;
  const sMin = Math.sqrt(sMinSq);
  if (!Number.isFinite(sMin) || !(sMin > 0)) return Number.POSITIVE_INFINITY;
  const local = documentTolerance / sMin;
  return Number.isFinite(local) ? local : Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// Main classifier.
// ---------------------------------------------------------------------------

/**
 * Classify one document/local point against one straight-segment `d`.
 *
 * - `documentPoint` is mapped to local space via `worldMatrix` inverse when
 *   provided; a singular/unreadable matrix is `ambiguous` (never identity).
 * - Points within `tolerance` (document units) of any edge are `ambiguous`
 *   (anti-alias / boundary exclusion zone). Under a non-uniform world matrix
 *   the local exclusion radius is widened to `tolerance / sMin` (see
 *   `localToleranceForHoleMatrix`) so a local pass always implies a document
 *   pass; remaining anisotropy stays `ambiguous` instead of a hole claim.
 * - `filled` -> `filled` (bodies AND islands: both are painted; callers use
 *   `containing.length` to tell island depth `>= 3` from body depth `1`).
 * - Unfilled with a strictly laminar chain (exact limited subset in
 *   `vector-fill-hole-nested.ts`) -> `hole` (works for multi-hole `d` and
 *   for nested islands: the smallest containing contour is the hole, its
 *   parent is the outer, and the hole must contain no island child; an
 *   outer ring that contains an island stays `ambiguous` because a solid
 *   overlay would cover that island).
 * - Unfilled with crossings, contact, self-intersection, partial overlap,
 *   degenerate areas, a broken chain, or an island child inside the claimed
 *   hole -> `ambiguous` (fail-closed). A filled island point itself is
 *   still `filled`, so non-overlapping islands are safely discriminated.
 * - Over-cap / over-budget inputs (point caps, overlap pair budget, nesting
 *   audit budget, unreadable distances) -> `ambiguous` (fail-closed), never
 *   a best-effort safe claim from a partially scanned contour set.
 * - Curves/arcs/unsafe payloads/single contours -> `unsupported`/`outside`.
 */
export function classifyHolePoint(options: {
  pathData: string;
  point: HolePoint;
  fillRule?: string | null;
  worldMatrix?: HoleMatrix | null;
  tolerance?: number;
}): HoleGeometryVerdict {
  const { pathData, point } = options;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { kind: 'outside', containing: [] };
  if (!isPathDataSafeForHoleGeometry(pathData)) {
    return /[CcSsQqTtAa]/.test(pathData)
      ? { kind: 'unsupported', reason: 'curved path needs the Paper entity probe (fail-closed)' }
      : { kind: 'unsupported', reason: 'unreadable path data (fail-closed)' };
  }
  const fillRule = normalizeFillRule(options.fillRule);
  const tolerance = options.tolerance ?? 0.5;
  const contours = parseStraightContours(pathData);
  if (!contours) {
    // Single contour (or degenerate): no hole possible; report paint state of
    // the lone contour instead of guessing.
    return { kind: 'outside', containing: [] };
  }
  // Iteration budgets before any O(n)/O(n^2) scan: over-cap inputs refuse as
  // `ambiguous` (fail-closed), never as a best-effort `outside`/`filled` from
  // a partially scanned contour set. This also keeps per-frame hover bounded:
  // a 20k-char `d` already holds thousands of `H`/`V` vertices.
  if (nestedPointCapsExceeded(contours)) {
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
    const edgeDistance = distanceToContours(contours, local);
    if (!(edgeDistance > localTolerance)) {
      return { kind: 'ambiguous', reason: 'point is on/near a painted edge (fail-closed)' };
    }
  }
  if (contoursOverlap(contours)) {
    return { kind: 'ambiguous', reason: 'contours overlap (fail-closed)' };
  }
  // Exact limited subset: self-touch + inter-touch + strict laminar nesting.
  // Anything outside it (crossings, contact, self-intersection, partial
  // overlap, duplicates) refuses here, never as a hole.
  {
    const nesting = auditStraightNesting(contours);
    if (!nesting.ok) {
      return { kind: 'ambiguous', reason: nesting.reason };
    }
  }
  const areas = contours.map((contour) => contourArea(contour));
  if (areas.some((area) => !Number.isFinite(area) || Math.abs(area) <= 1e-9)) {
    return { kind: 'ambiguous', reason: 'degenerate contour (fail-closed)' };
  }
  const containing = containingContourIndices(contours, local, fillRule);
  if (containing.length === 0) return { kind: 'outside', containing };
  if (isPointFilled(contours, local, fillRule)) return { kind: 'filled', containing };
  // Unfilled interior in a laminar family: resolve the exact nested pair
  // (smallest containing = hole, its parent = outer, hole child-free). An
  // outer ring that contains an island stays ambiguous (solid overlay would
  // cover the island); only the innermost child-free level becomes a hole.
  {
    const resolved = resolveNestedHole({ contours, containing, areas });
    if (!resolved.ok) {
      return { kind: 'ambiguous', reason: resolved.reason };
    }
    const holeIndex = resolved.holeIndex;
    const outerIndex = resolved.outerIndex;
    const holeBounds = contourBounds(contours[holeIndex]!);
    if (!(holeBounds.width > 0 && holeBounds.height > 0)) {
      return { kind: 'ambiguous', reason: 'degenerate hole bounds (fail-closed)' };
    }
    return { kind: 'hole', holeIndex, outerIndex, holeBounds, containing };
  }
}

/**
 * Unsupported-case enumeration for status surfaces (no guessing, no AGPL
 * text): curves/arcs, clip/mask, defs-hosted paint, nested groups, text /
 * raster / use units, singular transforms, edge/anti-alias proximity, and
 * overlapping/nested-duplicate contours.
 */
export const HOLE_GEOMETRY_UNSUPPORTED_CASES: readonly string[] = [
  'curved segments (C/S/Q/T/A) need the Paper entity probe',
  'arc segments (A) need the Paper entity probe',
  'clip-path / mask units (baked import ignores clipping)',
  'defs-hosted url(#...) paint (needs defs resolution, inherited urls included)',
  'class / stylesheet-driven paint, fill-rule, display, visibility, or opacity (detached DOM cannot compute styles; fail-closed)',
  'display:none / visibility:hidden|collapse / opacity:0 / fill-opacity:0 units (nothing rendered; no hole)',
  'inline style beats presentation attributes; svg-root values inherit (fill, fill-rule)',
  'nested <g> hole units (per-unit classifier; caller iterates Z-order)',
  'cross-unit Z-order overlap (caller probes top-down; this helper classifies one d only)',
  'text / image / use units (not path holes)',
  'singular or unreadable transforms (no identity fallback)',
  'non-uniform world transforms widen the edge exclusion to tolerance / sMin (fail-closed)',
  'points within tolerance of a painted edge (anti-alias zone)',
  'overlapping or duplicate contours (renderer-dependent fill)',
  'inputs over the point caps (2048 vertices per contour / 6000 total) refuse as ambiguous (fail-closed)',
  'overlap / nesting audits over 400000 elementary checks refuse as ambiguous (fail-closed)',
  'unreadable edge distances refuse as ambiguous (fail-closed)',
  'outer rings containing an island stay ambiguous (a solid overlay would cover the island); only the innermost child-free nested hole resolves',
] as const;
