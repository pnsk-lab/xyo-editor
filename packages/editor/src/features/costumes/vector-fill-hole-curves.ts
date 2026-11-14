// Curved fill-hole geometry helper (Scratch-Paint-style compound paths).
//
// Scope (new file only; existing Editor / BitmapEditor / paper-vector untouched):
// the straight-only helper (`vector-fill-hole-geometry.ts`) declines curves
// (`C/S/Q/T/A`) so flattening can never drift from the real renderer. The
// Paper entity probe (`paper-vector.ts`) already judges curves via real
// Paper.js entities (`contains` / `hitTest` / `getIntersections`). This module
// is a *prototype* pure fallback for curved multi-contour `d`: it flattens
// beziers/arcs to polylines with a bounded deviation and reuses the straight
// helper's containment / overlap / bounds / matrix primitives, staying
// fail-closed everywhere the flattening could lie.
//
// Design rules (all fail-closed, reimplemented from SVG behavior — no upstream
// source copied, AGPL text never reproduced):
// - Pure, DOM-free, no Paper.js: inputs are strings/numbers only, so `bun
//   test` covers the core without a browser. Shared primitives
//   (`normalizeFillRule`, `containingContourIndices`, `isPointFilled`,
//   `contourBounds`, `contoursOverlap`, `distanceToContours`,
//   `parseSvgTransformList`, `tryInvertHoleMatrix`, `applyHoleMatrix`,
//   `localToleranceForHoleMatrix`, `isUnitEligibleForHoleGeometry`) are
//   imported from the straight helper so behavior never diverges.
// - SVG `d` subset: `M/m/L/l/H/h/V/v/C/S/Q/T/A/Z/z` + numbers. Anything else
//   (markup, `url(`, `script`, over-long payloads, missing `M`) is rejected.
// - Flattening: cubics/quadratics via recursive de Casteljau subdivision with
//   a flatness bound (`CURVED_FLATTEN_TOLERANCE = 0.25` local units). Arcs are
//   NOT routed through <=90-degree cubic approximation (its radius-proportional
//   error, ~0.00027 * R per 90 degrees, exceeds any fixed margin for large R:
//   R=10000 drifts ~2.7 local units, so a fixed 0.35 margin misclaims holes).
//   Instead arcs use endpoint->center conversion (SVG 1.1 F.6.5) followed by
//   direct polyline sampling of the true ellipse with a proven chord bound
//   (sagitta `1 - cos(h/2) <= h^2/8`, scaled by `max(rx,ry)`; see
//   `pushArcCenterTo`). The sampling step is chosen per arc so the chord
//   deviation is itself <= flatten tolerance, independent of radius. Arcs whose
//   required sample count exceeds the point caps refuse as `ambiguous`.
//   Point caps (per-contour / total) refuse pathological inputs as
//   `ambiguous`, never as holes.
// - Edge zone: the straight helper's document `tolerance` is converted to
//   local space (`tolerance / sMin`, `Infinity` for singular frames) and then
//   widened by a *dynamic* flatten margin `2 * flattenTolerance + 1e-6`
//   (one tolerance for the bezier/sampling chord stage, one full tolerance of
//   slack for the non-rigorous bezier flatness test, plus a numeric guard).
//   No fixed 0.35 constant is used for arbitrary radii. The margin applies even
//   when the document tolerance is zero/invalid/tiny, so flatten drift alone
//   can never produce a hole claim. Curve perimeters, contour bands, and
//   near-touching contours stay `ambiguous`.
// - Transforms: translation / rotation / uniform-scale pass through the same
//   inverse mapping as the straight helper. Singular matrices refuse;
//   mirrors (det < 0), non-uniform scales, and skews refuse as `ambiguous`
//   for curves (fail-closed): flattening + Paper's baked geometry diverge
//   under anisotropy, and winding signs flip under mirrors. This is stricter
//   than the straight helper on purpose.
// - Fill rules: `evenodd` only when explicit, otherwise SVG-default `nonzero`
//   (via `normalizeFillRule`). Nonzero uses summed winding on the flattened
//   polygon; evenodd uses parity. Overlapping / touching contours, degenerate
//   areas, non-2 containing counts, and island-in-hole nesting all refuse.
// - Out of scope (caller-side, same as straight): Z-order (one `d` per call,
//   callers iterate top-down), clip/mask, `defs` `url(#...)` paint,
//   class/stylesheet paint, invisibility (`display:none` / `opacity:0` /
//   `fill:none`), non-`path` tags, text/raster/`use` units. Inline `style`
//   beats presentation attributes and `svg`-root values inherit — the caller
//   resolves them before calling (see `paper-vector.ts`); this helper only
//   normalizes the resolved `fill-rule` string.
//
// Pixel-oracle contract (see `vector-fill-hole-curves.browser.test.ts`):
// interior sample points (away from edges by >= tolerance + flatten margin)
// must agree with Canvas 2D pixels (`Path2D` + `fill(rule)`) and Paper.js
// `contains`; edge pixels may disagree via anti-aliasing + flattening and
// must be refused via the widened exclusion zone. Mirror / skew /
// non-uniform / singular / overlapping cases must refuse even when the
// oracles render a hole — safe fail, never a hole claim.

import {
  applyHoleMatrix,
  containingContourIndices,
  contourArea,
  contourBounds,
  contoursOverlap,
  distanceToContours,
  isPointFilled,
  isUnitEligibleForHoleGeometry,
  localToleranceForHoleMatrix,
  normalizeFillRule,
  tryInvertHoleMatrix,
  type FillRule,
  type HoleBounds,
  type HoleContour,
  type HoleGeometryVerdict,
  type HoleMatrix,
  type HolePoint,
} from './vector-fill-hole-geometry';
import { auditStraightNesting, resolveNestedHole } from './vector-fill-hole-nested';

export { isUnitEligibleForHoleGeometry, normalizeFillRule };
export type { FillRule, HoleBounds, HoleContour, HoleGeometryVerdict, HoleMatrix, HolePoint };

export const CURVED_HOLE_MAX_CHARS = 20000;

/** Flatten flatness bound in local units (upper-bounded deviation per segment). */
export const CURVED_FLATTEN_TOLERANCE = 0.25;
/**
 * Legacy fixed margin (kept only for backward-compatible imports).
 * @deprecated Do not use for arbitrary radii: the old cubic-arc approximation
 * error grows with radius (~2.7 at R=10000) and exceeds this constant.
 * The classifier now uses `curvedLocalMarginFor(flattenTolerance)` instead.
 */
export const CURVED_FLATTEN_MARGIN = 0.35;
/** Numeric guard for cos/sin/affine rounding in arc sampling (local units). */
export const CURVED_ARC_NUMERIC_GUARD = 1e-6;
/**
 * Dynamic local-space flatten margin for a given flatten tolerance.
 *
 * Total Hausdorff deviation of the flattened polyline from the true curve is
 * bounded stage-wise: each bezier subdivision chord deviates <= tol from its
 * true bezier (convex-combination argument on the control-distance test), and
 * each arc sampling chord deviates <= tol from its true ellipse (proven
 * sagitta bound `maxR * h^2 / 8 <= tol` enforced by the sample count in
 * `pushArcCenterTo`). A second full `tol` of slack covers the non-rigorous
 * bezier flatness test, and `CURVED_ARC_NUMERIC_GUARD` covers floating-point
 * evaluation noise. The result is a *sufficient* (deliberately loose) upper
 * bound, valid for any radius that passes the point caps; radii needing more
 * samples than the caps allow refuse instead of guessing.
 */
export function curvedLocalMarginFor(flattenTolerance: number): number {
  const tol =
    Number.isFinite(flattenTolerance) && flattenTolerance > 0 && flattenTolerance <= 1
      ? (flattenTolerance as number)
      : CURVED_FLATTEN_TOLERANCE;
  return 2 * tol + CURVED_ARC_NUMERIC_GUARD;
}
/** Fail-closed point caps (pathological curves refuse instead of guessing). */
export const CURVED_MAX_POINTS_PER_CONTOUR = 2048;
export const CURVED_MAX_POINTS_TOTAL = 6000;
/** Fail-closed per-arc-piece sample cap (larger needs refuse via point caps). */
export const CURVED_MAX_ARC_SAMPLES_PER_PIECE = 1024;

const CURVED_SAFE_D_PATTERN = /^[MmLlHhVvCcSsQqTtAaZz0-9\s.,+\-eE]+$/;

/**
 * Fail-closed charset/length gate for curved `d` inputs. Allows the straight
 * subset plus `C/S/Q/T/A`; still rejects markup, `url(`, scripts, over-long
 * payloads, and data without a moveto.
 */
export function isPathDataSafeForCurvedHoleGeometry(data: string): boolean {
  if (typeof data !== 'string') return false;
  const trimmed = data.trim();
  if (trimmed.length === 0 || trimmed.length > CURVED_HOLE_MAX_CHARS) return false;
  if (/[<>&"']/.test(trimmed)) return false;
  if (/url\s*\(/i.test(trimmed)) return false;
  if (/script/i.test(trimmed)) return false;
  if (!CURVED_SAFE_D_PATTERN.test(trimmed)) return false;
  if (!/[Mm]/.test(trimmed)) return false;
  return true;
}

/** True when the data contains at least one curve/arc command. */
export function curvedHoleDataHasCurves(data: string): boolean {
  return /[CcSsQqTtAa]/.test(data);
}

// ---------------------------------------------------------------------------
// Path parsing (absolute resolution) + flattening.
// ---------------------------------------------------------------------------

type CurveToken = { kind: 'cmd'; value: string } | { kind: 'num'; value: number };

function tokenizeCurvedPathData(data: string): CurveToken[] | undefined {
  const tokens: CurveToken[] = [];
  const pattern = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
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

function midpoint(a: HolePoint, b: HolePoint): HolePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distancePointToChord(p: HolePoint, a: HolePoint, b: HolePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0) || !Number.isFinite(len2)) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const clamped = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x - (a.x + clamped * dx), p.y - (a.y + clamped * dy));
}

function flattenCubicSegment(
  p0: HolePoint,
  c1: HolePoint,
  c2: HolePoint,
  p3: HolePoint,
  tolerance: number,
  out: HolePoint[],
  depth: number,
): boolean {
  if (depth > 14) return false;
  const d1 = distancePointToChord(c1, p0, p3);
  const d2 = distancePointToChord(c2, p0, p3);
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return false;
  if (Math.max(d1, d2) <= tolerance) {
    out.push({ ...p3 });
    return true;
  }
  // de Casteljau split at t = 1/2.
  const p01 = midpoint(p0, c1);
  const p12 = midpoint(c1, c2);
  const p23 = midpoint(c2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const p0123 = midpoint(p012, p123);
  if (
    ![p01, p12, p23, p012, p123, p0123].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  ) {
    return false;
  }
  return (
    flattenCubicSegment(p0, p01, p012, p0123, tolerance, out, depth + 1) &&
    flattenCubicSegment(p0123, p123, p23, p3, tolerance, out, depth + 1)
  );
}

function flattenQuadSegment(
  p0: HolePoint,
  c: HolePoint,
  p2: HolePoint,
  tolerance: number,
  out: HolePoint[],
  depth: number,
): boolean {
  if (depth > 14) return false;
  const d = distancePointToChord(c, p0, p2);
  if (!Number.isFinite(d)) return false;
  if (d <= tolerance) {
    out.push({ ...p2 });
    return true;
  }
  const p01 = midpoint(p0, c);
  const p12 = midpoint(c, p2);
  const p012 = midpoint(p01, p12);
  if (![p01, p12, p012].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  return (
    flattenQuadSegment(p0, p01, p012, tolerance, out, depth + 1) &&
    flattenQuadSegment(p012, p12, p2, tolerance, out, depth + 1)
  );
}

function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (!(len > 0) || !Number.isFinite(dot) || !Number.isFinite(len)) return Number.NaN;
  const clamped = Math.min(1, Math.max(-1, dot / len));
  const angle = Math.acos(clamped);
  if (!Number.isFinite(angle)) return Number.NaN;
  // Sign via cross product.
  return ux * vy - uy * vx < 0 ? -angle : angle;
}

type ArcCenterParams = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  phi: number;
  theta1: number;
  delta: number;
};

/**
 * Convert an SVG elliptical arc (endpoint parameterization) to center
 * parameterization (SVG 1.1 F.6.5 endpoint->center only).
 *
 * Deliberately stops before the center->cubic-bezier expansion: the cubic
 * approximation error is radius-proportional and cannot be covered by any
 * fixed margin for arbitrary radii, so arcs are sampled directly from the
 * true ellipse in `pushArcCenterTo` with a proven chord bound instead.
 * Returns `undefined` for unreadable parameters (caller fail-closes).
 * A zero-radius arc degrades to a straight line (pushed as line target).
 */
function arcCenterParams(
  from: HolePoint,
  rx0: number,
  ry0: number,
  rotationDeg: number,
  largeArc: number,
  sweep: number,
  to: HolePoint,
): ArcCenterParams | { lineTo: HolePoint } | undefined {
  if (![rx0, ry0, rotationDeg].every(Number.isFinite)) return undefined;
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(to.x) || !Number.isFinite(to.y)) {
    return undefined;
  }
  if (largeArc !== 0 && largeArc !== 1) return undefined;
  if (sweep !== 0 && sweep !== 1) return undefined;
  let rx = Math.abs(rx0);
  let ry = Math.abs(ry0);
  if (!(rx > 0) || !(ry > 0)) return { lineTo: { ...to } };
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return undefined;
  // Degenerate radii (sub-pixel dust or overflow): refuse instead of sampling
  // noise. The lower bound keeps `rx*rx`/`ry*ry` and the sagitta sample count
  // finite; the upper bound keeps `cos/sin * R` evaluation error inside the
  // numeric guard (larger frames refuse via the point caps below anyway).
  if (!(rx >= 1e-9) || !(ry >= 1e-9)) return undefined;
  if (!(rx <= 1e7) || !(ry <= 1e7)) return undefined;
  if (from.x === to.x && from.y === to.y) return undefined;
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  if (![cosPhi, sinPhi, phi].every(Number.isFinite)) return undefined;
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return undefined;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  if (!Number.isFinite(x1p) || !Number.isFinite(y1p)) return undefined;
  const rxSq = rx * rx;
  const rySq = ry * ry;
  if (!Number.isFinite(rxSq) || !Number.isFinite(rySq) || !(rxSq > 0) || !(rySq > 0)) return undefined;
  const lambda = (x1p * x1p) / rxSq + (y1p * y1p) / rySq;
  if (!Number.isFinite(lambda)) return undefined;
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    if (!Number.isFinite(scale) || !(scale > 0)) return undefined;
    rx *= scale;
    ry *= scale;
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return undefined;
    if (!(rx <= 1e7) || !(ry <= 1e7)) return undefined;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  if (!Number.isFinite(rx2) || !Number.isFinite(ry2)) return undefined;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  if (!Number.isFinite(num) || !Number.isFinite(den) || !(den > 0)) return undefined;
  const factor = Math.sqrt(Math.max(0, num / den));
  if (!Number.isFinite(factor)) return undefined;
  const sign = largeArc === sweep ? -1 : 1;
  const cxp = (sign * factor * rx * y1p) / ry;
  const cyp = (-sign * factor * ry * x1p) / rx;
  if (![cxp, cyp].every(Number.isFinite)) return undefined;
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;
  if (![cx, cy].every(Number.isFinite)) return undefined;
  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angleBetween((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!Number.isFinite(theta1) || !Number.isFinite(delta)) return undefined;
  if (sweep === 0 && delta > 0) delta -= 2 * Math.PI;
  if (sweep === 1 && delta < 0) delta += 2 * Math.PI;
  if (!Number.isFinite(delta) || delta === 0) return undefined;
  if (!(Math.abs(delta) <= 2 * Math.PI + 1e-9)) return undefined;
  return { cx, cy, rx, ry, phi, theta1, delta };
}

/**
 * Sample a center-parameterized ellipse arc directly to a polyline whose
 * chord deviation from the true ellipse is <= `tolerance` (local units).
 *
 * Provenance (all elementary, no upstream text copied):
 * - Split `delta` into `segments` pieces of <= 90 degrees (SVG-style cap 16,
 *   same as before). Each piece of angular width `h` is sampled with `n`
 *   equal sub-steps. On the unit circle the sagitta (max radial gap between
 *   arc and chord) is `1 - cos(h/(2n)) <= (h/(2n))^2 / 2 = h^2/(8n^2)` via
 *   `1 - cos(x) <= x^2/2`. The ellipse maps the unit circle through
 *   `diag(rx,ry)` then a rotation: rotation is an isometry, and the diagonal
 *   scaling stretches distances by at most `max(rx,ry)`. Hence each chord
 *   deviates from the true ellipse by at most `maxR * h^2/(8n^2)`.
 * - Choosing `n >= |h| * sqrt(maxR/(8*tol))` forces that bound <= tol.
 * - `n` is capped per piece; arcs needing more samples (huge radii,
 *   pathologically small `tol`) return `false` so the caller fail-closes
 *   instead of guessing. All arithmetic is finite-checked; any non-finite
 *   sample fail-closes.
 */
function pushArcCenterTo(
  center: ArcCenterParams,
  tolerance: number,
  push: (pt: HolePoint) => boolean,
): boolean {
  const { cx, cy, rx, ry, phi, theta1, delta } = center;
  if (![cx, cy, rx, ry, phi, theta1, delta].every(Number.isFinite)) return false;
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return false;
  if (!(rx > 0) || !(ry > 0)) return false;
  const maxR = Math.max(rx, ry);
  if (!Number.isFinite(maxR) || !(maxR > 0)) return false;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  if (!Number.isFinite(segments) || segments < 1 || segments > 16) return false;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  if (![cosPhi, sinPhi].every(Number.isFinite)) return false;
  const mapLocal = (lx: number, ly: number): HolePoint => ({
    x: cosPhi * rx * lx + -sinPhi * ry * ly + cx,
    y: sinPhi * rx * lx + cosPhi * ry * ly + cy,
  });
  const step = delta / segments;
  if (!Number.isFinite(step) || step === 0) return false;
  const denom = 8 * tolerance;
  if (!(denom > 0) || !Number.isFinite(denom)) return false;
  const ratio = maxR / denom;
  if (!Number.isFinite(ratio) || !(ratio >= 0)) return false;
  const root = Math.sqrt(ratio);
  if (!Number.isFinite(root) || !(root >= 0)) return false;
  for (let i = 0; i < segments; i += 1) {
    const piece = step;
    const needed = Math.abs(piece) * root;
    if (!Number.isFinite(needed) || !(needed >= 0)) return false;
    let n = Math.ceil(needed);
    if (!Number.isFinite(n) || n < 1) n = 1;
    // `needed < 1` still needs one chord; `needed` already is that chord's
    // sufficient count. Cap before sampling so huge radii fail closed.
    if (n > CURVED_MAX_ARC_SAMPLES_PER_PIECE) return false;
    const t0 = theta1 + i * step;
    const dt = piece / n;
    if (!Number.isFinite(t0) || !Number.isFinite(dt) || dt === 0) return false;
    for (let k = 1; k <= n; k += 1) {
      const t = t0 + k * dt;
      if (!Number.isFinite(t)) return false;
      const c = Math.cos(t);
      const s = Math.sin(t);
      if (!Number.isFinite(c) || !Number.isFinite(s)) return false;
      const pt = mapLocal(c, s);
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
      if (!push(pt)) return false;
    }
  }
  return true;
}

type FlattenOutcome =
  | { status: 'ok'; contours: HoleContour[] }
  | { status: 'single' }
  | { status: 'error'; reason: string };

function flattenCurvedData(data: string, tolerance: number): FlattenOutcome {
  const tokens = tokenizeCurvedPathData(data.trim());
  if (!tokens || tokens.length === 0) return { status: 'error', reason: 'unreadable path data (fail-closed)' };
  const contours: HoleContour[] = [];
  let current: HolePoint[] = [];
  let closed = false;
  let cursor: HolePoint = { x: 0, y: 0 };
  let subpathStart: HolePoint = { x: 0, y: 0 };
  let hasCursor = false;
  let command: string | null = null;
  let prevCubic: HolePoint | null = null;
  let prevQuad: HolePoint | null = null;
  let totalPoints = 0;
  let i = 0;

  const flush = () => {
    if (current.length > 0) {
      contours.push({ points: current, closed });
      totalPoints += current.length;
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

  const pushLineTo = (pt: HolePoint): boolean => {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
    cursor = { ...pt };
    current.push({ ...cursor });
    prevCubic = null;
    prevQuad = null;
    return true;
  };

  const pushCubicTo = (c1: HolePoint, c2: HolePoint, end: HolePoint): boolean => {
    if (![c1, c2, end].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
    const start = { ...cursor };
    const scratch: HolePoint[] = [];
    const ok = flattenCubicSegment(start, c1, c2, end, tolerance, scratch, 0);
    if (!ok) return false;
    if (current.length + scratch.length > CURVED_MAX_POINTS_PER_CONTOUR + 8) return false;
    for (const p of scratch) current.push(p);
    cursor = { ...end };
    prevCubic = { ...c2 };
    prevQuad = null;
    return true;
  };

  const pushQuadTo = (c: HolePoint, end: HolePoint): boolean => {
    if (![c, end].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
    const start = { ...cursor };
    const scratch: HolePoint[] = [];
    const ok = flattenQuadSegment(start, c, end, tolerance, scratch, 0);
    if (!ok) return false;
    if (current.length + scratch.length > CURVED_MAX_POINTS_PER_CONTOUR + 8) return false;
    for (const p of scratch) current.push(p);
    cursor = { ...end };
    prevQuad = { ...c };
    prevCubic = null;
    return true;
  };

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind === 'cmd') {
      command = token.value;
      i += 1;
      if (command === 'Z' || command === 'z') {
        if (current.length > 0) closed = true;
        cursor = { ...subpathStart };
        prevCubic = null;
        prevQuad = null;
        continue;
      }
      if (command === 'M' || command === 'm') {
        flush();
        const pair = need(2);
        if (!pair) return { status: 'error', reason: 'unreadable moveto (fail-closed)' };
        const absolute =
          command === 'm' && hasCursor
            ? { x: cursor.x + pair[0]!, y: cursor.y + pair[1]! }
            : { x: pair[0]!, y: pair[1]! };
        if (!Number.isFinite(absolute.x) || !Number.isFinite(absolute.y)) {
          return { status: 'error', reason: 'non-finite moveto (fail-closed)' };
        }
        cursor = absolute;
        subpathStart = { ...absolute };
        hasCursor = true;
        current = [{ ...cursor }];
        prevCubic = null;
        prevQuad = null;
        command = command === 'm' ? 'l' : 'L';
        continue;
      }
      continue;
    }
    if (!command) return { status: 'error', reason: 'missing command (fail-closed)' };
    if (command === 'L' || command === 'l') {
      const pair = need(2);
      if (!pair) return { status: 'error', reason: 'unreadable lineto (fail-closed)' };
      const pt =
        command === 'l' ? { x: cursor.x + pair[0]!, y: cursor.y + pair[1]! } : { x: pair[0]!, y: pair[1]! };
      if (!pushLineTo(pt)) return { status: 'error', reason: 'non-finite lineto (fail-closed)' };
    } else if (command === 'H' || command === 'h') {
      const xs = need(1);
      if (!xs) return { status: 'error', reason: 'unreadable horizontal (fail-closed)' };
      const x = command === 'h' ? cursor.x + xs[0]! : xs[0]!;
      if (!pushLineTo({ x, y: cursor.y })) return { status: 'error', reason: 'non-finite horizontal (fail-closed)' };
    } else if (command === 'V' || command === 'v') {
      const ys = need(1);
      if (!ys) return { status: 'error', reason: 'unreadable vertical (fail-closed)' };
      const y = command === 'v' ? cursor.y + ys[0]! : ys[0]!;
      if (!pushLineTo({ x: cursor.x, y })) return { status: 'error', reason: 'non-finite vertical (fail-closed)' };
    } else if (command === 'C' || command === 'c') {
      const v = need(6);
      if (!v) return { status: 'error', reason: 'unreadable cubic (fail-closed)' };
      const relative = command === 'c';
      const c1 = relative ? { x: cursor.x + v[0]!, y: cursor.y + v[1]! } : { x: v[0]!, y: v[1]! };
      const c2 = relative ? { x: cursor.x + v[2]!, y: cursor.y + v[3]! } : { x: v[2]!, y: v[3]! };
      const end = relative ? { x: cursor.x + v[4]!, y: cursor.y + v[5]! } : { x: v[4]!, y: v[5]! };
      if (!pushCubicTo(c1, c2, end)) return { status: 'error', reason: 'unflattenable cubic (fail-closed)' };
    } else if (command === 'S' || command === 's') {
      const v = need(4);
      if (!v) return { status: 'error', reason: 'unreadable smooth cubic (fail-closed)' };
      const relative = command === 's';
      // Snapshot via assertion: TS control flow keeps the outer `prevCubic`
      // narrowed to `null` (its only non-null assignment lives inside the
      // `pushCubicTo` closure), so testing it directly narrows to `never`.
      // The assertion restores the declared union for a sound check.
      // `!= null` covers both runtime `null` and `undefined`.
      // SVG S reflects the previous C/S second control point; otherwise the
      // first control point coincides with the cursor (fallback below).
      const prev = prevCubic as HolePoint | null | undefined;
      const c1 =
        prev != null
          ? { x: 2 * cursor.x - prev.x, y: 2 * cursor.y - prev.y }
          : { ...cursor };
      const c2 = relative ? { x: cursor.x + v[0]!, y: cursor.y + v[1]! } : { x: v[0]!, y: v[1]! };
      const end = relative ? { x: cursor.x + v[2]!, y: cursor.y + v[3]! } : { x: v[2]!, y: v[3]! };
      if (!pushCubicTo(c1, c2, end)) return { status: 'error', reason: 'unflattenable cubic (fail-closed)' };
    } else if (command === 'Q' || command === 'q') {
      const v = need(4);
      if (!v) return { status: 'error', reason: 'unreadable quadratic (fail-closed)' };
      const relative = command === 'q';
      const c = relative ? { x: cursor.x + v[0]!, y: cursor.y + v[1]! } : { x: v[0]!, y: v[1]! };
      const end = relative ? { x: cursor.x + v[2]!, y: cursor.y + v[3]! } : { x: v[2]!, y: v[3]! };
      if (!pushQuadTo(c, end)) return { status: 'error', reason: 'unflattenable quadratic (fail-closed)' };
    } else if (command === 'T' || command === 't') {
      const v = need(2);
      if (!v) return { status: 'error', reason: 'unreadable smooth quadratic (fail-closed)' };
      const relative = command === 't';
      // Same snapshot rationale as the S branch above: outer-flow `prevQuad`
      // is CFA-narrowed to `null`, so test an asserted copy.
      // SVG T reflects the previous Q/T control point; otherwise it falls
      // back to the cursor.
      const prevQ = prevQuad as HolePoint | null | undefined;
      const c =
        prevQ != null
          ? { x: 2 * cursor.x - prevQ.x, y: 2 * cursor.y - prevQ.y }
          : { ...cursor };
      const end = relative ? { x: cursor.x + v[0]!, y: cursor.y + v[1]! } : { x: v[0]!, y: v[1]! };
      if (!pushQuadTo(c, end)) return { status: 'error', reason: 'unflattenable quadratic (fail-closed)' };
    } else if (command === 'A' || command === 'a') {
      const v = need(7);
      if (!v) return { status: 'error', reason: 'unreadable arc (fail-closed)' };
      const relative = command === 'a';
      const end = relative ? { x: cursor.x + v[5]!, y: cursor.y + v[6]! } : { x: v[5]!, y: v[6]! };
      const center = arcCenterParams(cursor, v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, end);
      if (!center) return { status: 'error', reason: 'unreadable arc (fail-closed)' };
      if ('lineTo' in center) {
        if (!pushLineTo(center.lineTo)) return { status: 'error', reason: 'non-finite arc (fail-closed)' };
      } else {
        // Direct ellipse sampling with a proven chord bound (see
        // `pushArcCenterTo`): the polyline never drifts radius-proportionally
        // the way cubic approximation does, so one dynamic margin covers any
        // radius that fits the point caps. Over-cap / degenerate arcs refuse.
        const pushArcPoint = (pt: HolePoint): boolean => {
          if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
          if (current.length + 1 > CURVED_MAX_POINTS_PER_CONTOUR + 8) return false;
          current.push({ ...pt });
          return true;
        };
        if (!pushArcCenterTo(center, tolerance, pushArcPoint)) {
          return { status: 'error', reason: 'unflattenable arc (fail-closed)' };
        }
        cursor = { ...end };
        if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) {
          return { status: 'error', reason: 'non-finite arc (fail-closed)' };
        }
        // SVG S/T reflect only after C/S and Q/T respectively. Arcs never
        // feed the smooth-tangent chain, so reset here so a later S/T falls
        // back to the cursor instead of reflecting off arc geometry.
        prevCubic = null;
        prevQuad = null;
      }
    } else {
      return { status: 'error', reason: 'unsupported command (fail-closed)' };
    }
    if (totalPoints + current.length > CURVED_MAX_POINTS_TOTAL + 64) {
      return { status: 'error', reason: 'path is too complex to flatten safely (fail-closed)' };
    }
  }
  flush();
  if (contours.length < 2) return { status: 'single' };
  for (const contour of contours) {
    if (contour.points.length < 3) return { status: 'error', reason: 'degenerate contour (fail-closed)' };
    if (contour.points.length > CURVED_MAX_POINTS_PER_CONTOUR) {
      return { status: 'error', reason: 'contour is too complex to flatten safely (fail-closed)' };
    }
  }
  if (totalPoints > CURVED_MAX_POINTS_TOTAL) {
    return { status: 'error', reason: 'path is too complex to flatten safely (fail-closed)' };
  }
  return { status: 'ok', contours };
}

/**
 * Flatten curved `d` to absolute polygonal contours (bounded deviation).
 * Returns `undefined` for empty / single-contour / malformed / over-cap
 * inputs. Callers treat `undefined` as "not this helper's case".
 */
export function flattenCurvedContours(
  data: string,
  flattenTolerance: number = CURVED_FLATTEN_TOLERANCE,
): HoleContour[] | undefined {
  if (!isPathDataSafeForCurvedHoleGeometry(data)) return undefined;
  const tolerance =
    Number.isFinite(flattenTolerance) && flattenTolerance > 0 && flattenTolerance <= 1
      ? flattenTolerance
      : CURVED_FLATTEN_TOLERANCE;
  const outcome = flattenCurvedData(data, tolerance);
  if (outcome.status !== 'ok') return undefined;
  return outcome.contours;
}

// ---------------------------------------------------------------------------
// Transforms: curves allow similarity only (mirror / skew / non-uniform fail).
// ---------------------------------------------------------------------------

export type CurvedMatrixGate =
  | { ok: true; uniformScale: number }
  | { ok: false; reason: string };

/**
 * Similarity gate for curved hole geometry. Translation / rotation /
 * uniform-scale pass; singular, mirrored, non-uniform, or skewed frames
 * refuse fail-closed (flattening + baked Paper geometry diverge there).
 *
 * Only complete similarity is allowed: any axis-scale ratio above
 * `1 + 1e-9` or any skew above `1e-9` refuses. The old 1.02 leeway is
 * removed — under anisotropy a shared flatten margin cannot cover the
 * direction-dependent document error, so borderline stretches fail closed.
 */
export function gateCurvedWorldMatrix(matrix: HoleMatrix | null | undefined): CurvedMatrixGate {
  if (!matrix) return { ok: true, uniformScale: 1 };
  if (matrix.length < 6) return { ok: false, reason: 'unreadable transform (fail-closed)' };
  const [a, b, c, d] = [matrix[0]!, matrix[1]!, matrix[2]!, matrix[3]!];
  if (![a, b, c, d, matrix[4], matrix[5]].every(Number.isFinite)) {
    return { ok: false, reason: 'non-finite transform (fail-closed)' };
  }
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) return { ok: false, reason: 'singular transform (fail-closed)' };
  if (det < 0) return { ok: false, reason: 'mirrored transform needs the Paper entity probe (fail-closed)' };
  const n0 = Math.hypot(a, b);
  const n1 = Math.hypot(c, d);
  if (!(n0 > 1e-12) || !(n1 > 1e-12) || !Number.isFinite(n0) || !Number.isFinite(n1)) {
    return { ok: false, reason: 'degenerate transform (fail-closed)' };
  }
  const ratio = Math.max(n0, n1) / Math.min(n0, n1);
  if (!(ratio <= 1 + 1e-9)) return { ok: false, reason: 'non-uniform transform needs the Paper entity probe (fail-closed)' };
  const cos = (a * c + b * d) / (n0 * n1);
  if (!Number.isFinite(cos) || Math.abs(cos) > 1e-9) {
    return { ok: false, reason: 'skewed transform needs the Paper entity probe (fail-closed)' };
  }
  return { ok: true, uniformScale: (n0 + n1) / 2 };
}

// ---------------------------------------------------------------------------
// Fail-closed topology audit (implicit close + self/touch/separation + budget).
// ---------------------------------------------------------------------------

/** O(n^2) audit budget: exceeded checks fail safe as `ambiguous`. */
export const CURVED_TOPOLOGY_BUDGET = 400000;

const TOPO_EPS = 1e-9;

function topoOrient(a: HolePoint, b: HolePoint, c: HolePoint): number {
  return (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
}

function topoOnSegment(a: HolePoint, b: HolePoint, p: HolePoint): boolean {
  if (Math.abs(topoOrient(a, b, p)) > TOPO_EPS) return false;
  return (
    p.x >= Math.min(a.x, b.x) - TOPO_EPS &&
    p.x <= Math.max(a.x, b.x) + TOPO_EPS &&
    p.y >= Math.min(a.y, b.y) - TOPO_EPS &&
    p.y <= Math.max(a.y, b.y) + TOPO_EPS
  );
}

function topoProperCross(p1: HolePoint, p2: HolePoint, p3: HolePoint, p4: HolePoint): boolean {
  const d1 = topoOrient(p3, p4, p1);
  const d2 = topoOrient(p3, p4, p2);
  const d3 = topoOrient(p1, p2, p3);
  const d4 = topoOrient(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function topoSegmentsTouch(p1: HolePoint, p2: HolePoint, p3: HolePoint, p4: HolePoint): boolean {
  if (topoProperCross(p1, p2, p3, p4)) return true;
  if (Math.abs(topoOrient(p3, p4, p1)) <= TOPO_EPS && topoOnSegment(p3, p4, p1)) return true;
  if (Math.abs(topoOrient(p3, p4, p2)) <= TOPO_EPS && topoOnSegment(p3, p4, p2)) return true;
  if (Math.abs(topoOrient(p1, p2, p3)) <= TOPO_EPS && topoOnSegment(p1, p2, p3)) return true;
  if (Math.abs(topoOrient(p1, p2, p4)) <= TOPO_EPS && topoOnSegment(p1, p2, p4)) return true;
  return false;
}

function topoPointSegDist(p: HolePoint, a: HolePoint, b: HolePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0) || !Number.isFinite(len2)) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function topoSegSegDist(p1: HolePoint, p2: HolePoint, p3: HolePoint, p4: HolePoint): number {
  if (topoSegmentsTouch(p1, p2, p3, p4)) return 0;
  return Math.min(
    topoPointSegDist(p1, p3, p4),
    topoPointSegDist(p2, p3, p4),
    topoPointSegDist(p3, p1, p2),
    topoPointSegDist(p4, p1, p2),
  );
}

function topoEdgesOf(points: HolePoint[]): Array<[HolePoint, HolePoint]> {
  const edges: Array<[HolePoint, HolePoint]> = [];
  if (points.length < 2) return edges;
  let pts = points;
  if (pts.length >= 2) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (Math.abs(first.x - last.x) <= TOPO_EPS && Math.abs(first.y - last.y) <= TOPO_EPS) {
      pts = pts.slice(0, -1);
    }
  }
  if (pts.length < 2) return edges;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (Math.abs(a.x - b.x) <= TOPO_EPS && Math.abs(a.y - b.y) <= TOPO_EPS) continue;
    edges.push([a, b]);
  }
  return edges;
}

export type CurvedTopologyAudit =
  | { ok: true; minGap: number }
  | { ok: false; reason: string };

/**
 * Fail-closed relation audit over the flattened polylines (SVG fill closes
 * every subpath, so closing edges are always included):
 * - degenerate / non-finite geometry refuses;
 * - any self-intersection or collinear self-touch within one contour refuses;
 * - any inter-contour touch / crossing / collinear coincidence refuses;
 * - any inter-contour gap `<= 2 * margin + localDocTol` refuses (the true
 *   curves may intersect while the polyline shows a gap; without a separation
 *   proof every point in the file is uncertified, so the whole file refuses);
 * - more than `CURVED_TOPOLOGY_BUDGET` edge-pair checks refuses (O(n^2) cap).
 */
export function auditCurvedTopology(
  contours: HoleContour[],
  flattenTolerance: number,
  localDocTol: number,
): CurvedTopologyAudit {
  const margin = curvedLocalMarginFor(flattenTolerance);
  if (!Number.isFinite(margin) || !(margin > 0)) return { ok: false, reason: 'unreadable flatten margin (fail-closed)' };
  const docPart = Number.isFinite(localDocTol) && localDocTol > 0 ? localDocTol : 0;
  const threshold = 2 * margin + docPart;
  if (!Number.isFinite(threshold)) return { ok: false, reason: 'unreadable separation bound (fail-closed)' };
  const edgeLists = contours.map((c) => topoEdgesOf(c.points));
  for (let i = 0; i < contours.length; i += 1) {
    const pts = contours[i]!.points;
    if (pts.length < 3) return { ok: false, reason: 'degenerate contour (fail-closed)' };
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, reason: 'non-finite contour (fail-closed)' };
    }
  }
  let checks = 0;
  // Self-intersection (including collinear self-touch), closing edge included.
  for (let i = 0; i < edgeLists.length; i += 1) {
    const edges = edgeLists[i]!;
    for (let a = 0; a < edges.length; a += 1) {
      for (let b = a + 1; b < edges.length; b += 1) {
        const adjacent = b === a + 1 || (a === 0 && b === edges.length - 1);
        const [p1, p2] = edges[a]!;
        const [p3, p4] = edges[b]!;
        checks += 1;
        if (checks > CURVED_TOPOLOGY_BUDGET) {
          return { ok: false, reason: 'topology audit budget exceeded (fail-closed)' };
        }
        if (adjacent) {
          // Consecutive edges share an endpoint by construction: only a
          // collinear run past the shared vertex counts as self-touch.
          const sharedIsP2P3 =
            Math.abs(p2.x - p3.x) <= TOPO_EPS && Math.abs(p2.y - p3.y) <= TOPO_EPS;
          const sharedIsP1P4 =
            Math.abs(p1.x - p4.x) <= TOPO_EPS && Math.abs(p1.y - p4.y) <= TOPO_EPS;
          let beyond = false;
          if (sharedIsP2P3) {
            if (topoOnSegment(p1, p2, p4) && !(Math.abs(p4.x - p2.x) <= TOPO_EPS && Math.abs(p4.y - p2.y) <= TOPO_EPS)) beyond = true;
            if (topoOnSegment(p3, p4, p1) && !(Math.abs(p1.x - p3.x) <= TOPO_EPS && Math.abs(p1.y - p3.y) <= TOPO_EPS)) beyond = true;
          } else if (sharedIsP1P4) {
            if (topoOnSegment(p1, p2, p3) && !(Math.abs(p3.x - p1.x) <= TOPO_EPS && Math.abs(p3.y - p1.y) <= TOPO_EPS)) beyond = true;
            if (topoOnSegment(p3, p4, p2) && !(Math.abs(p2.x - p4.x) <= TOPO_EPS && Math.abs(p2.y - p4.y) <= TOPO_EPS)) beyond = true;
          } else if (topoSegmentsTouch(p1, p2, p3, p4)) {
            beyond = true;
          }
          if (beyond) return { ok: false, reason: 'contour self-touches (fail-closed)' };
          continue;
        }
        if (topoSegmentsTouch(p1, p2, p3, p4)) {
          return { ok: false, reason: 'contour self-intersects (fail-closed)' };
        }
      }
    }
  }
  // Inter-contour touch + separation (closing edges included).
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < edgeLists.length; i += 1) {
    for (let j = i + 1; j < edgeLists.length; j += 1) {
      const aEdges = edgeLists[i]!;
      const bEdges = edgeLists[j]!;
      for (const [p1, p2] of aEdges) {
        for (const [p3, p4] of bEdges) {
          checks += 1;
          if (checks > CURVED_TOPOLOGY_BUDGET) {
            return { ok: false, reason: 'topology audit budget exceeded (fail-closed)' };
          }
          if (topoSegmentsTouch(p1, p2, p3, p4)) {
            return { ok: false, reason: 'contours touch or overlap (fail-closed)' };
          }
          const d = topoSegSegDist(p1, p2, p3, p4);
          if (!Number.isFinite(d)) return { ok: false, reason: 'non-finite contour gap (fail-closed)' };
          if (d < minGap) minGap = d;
        }
      }
    }
  }
  if (!(minGap > threshold)) {
    return { ok: false, reason: 'contour separation is within the flatten error sum (fail-closed)' };
  }
  return { ok: true, minGap };
}

// ---------------------------------------------------------------------------
// Main classifier.
// ---------------------------------------------------------------------------

function countMovetos(data: string): number {
  const matches = data.match(/[Mm]/g);
  return matches ? matches.length : 0;
}

/**
 * Classify one document/local point against one curved multi-contour `d`.
 *
 * Mirrors `classifyHolePoint` verdicts (`hole` / `filled` / `outside` /
 * `ambiguous` / `unsupported`) with curve-specific fail-closed gates:
 * - unsafe payloads -> `unsupported` (unreadable) ;
 * - single contours -> `outside` (no hole possible);
 * - malformed / over-cap flattening -> `ambiguous` (multi-contour only);
 * - mirror / skew / non-uniform / singular -> `ambiguous`;
 * - points within `tolerance + flatten margin` of any flattened edge ->
 *   `ambiguous` (anti-alias + flatten zone);
 * - crossings / degenerate areas / broken laminar chains / island children -> `ambiguous`;
 * - otherwise the same strict hole pairing as the straight helper.
 */
export function classifyCurvedHolePoint(options: {
  pathData: string;
  point: HolePoint;
  fillRule?: string | null;
  worldMatrix?: HoleMatrix | null;
  tolerance?: number;
  flattenTolerance?: number;
}): HoleGeometryVerdict {
  const { pathData, point } = options;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { kind: 'outside', containing: [] };
  if (!isPathDataSafeForCurvedHoleGeometry(pathData)) {
    return { kind: 'unsupported', reason: 'unreadable path data (fail-closed)' };
  }
  const fillRule = normalizeFillRule(options.fillRule);
  const documentTolerance = options.tolerance ?? 0.5;
  const flattenTolerance =
    options.flattenTolerance !== undefined &&
    Number.isFinite(options.flattenTolerance) &&
    (options.flattenTolerance as number) > 0 &&
    (options.flattenTolerance as number) <= 1
      ? (options.flattenTolerance as number)
      : CURVED_FLATTEN_TOLERANCE;
  if (options.worldMatrix) {
    const gate = gateCurvedWorldMatrix(options.worldMatrix);
    if (!gate.ok) return { kind: 'ambiguous', reason: gate.reason };
  }
  const outcome = flattenCurvedData(pathData, flattenTolerance);
  if (outcome.status === 'single') return { kind: 'outside', containing: [] };
  if (outcome.status === 'error') {
    if (countMovetos(pathData) < 2) return { kind: 'outside', containing: [] };
    return { kind: 'ambiguous', reason: outcome.reason };
  }
  const contours = outcome.contours;
  let local = point;
  if (options.worldMatrix) {
    const inverse = tryInvertHoleMatrix(options.worldMatrix);
    if (!inverse) return { kind: 'ambiguous', reason: 'singular/unreadable transform (fail-closed)' };
    local = applyHoleMatrix(inverse, point);
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) {
      return { kind: 'ambiguous', reason: 'transform maps point out of range (fail-closed)' };
    }
  }
  // Edge exclusion is unconditional (fail-closed for zero/invalid/tiny
  // document tolerances): flatten drift alone must never produce a hole
  // claim. The document tolerance maps to local space via `tolerance / sMin`
  // (`Infinity` for singular frames refuses everything); the dynamic flatten
  // margin `curvedLocalMarginFor` covers the proven chord bound for any radius
  // that fits the point caps. Under a uniform world scale `s`, the local
  // check `localDist > docTol/sMin + margin` implies the document check
  // `docDist > docTol + sMin*margin` in every direction, so a local pass
  // always implies a document pass.
  let localBaseForAudit = 0;
  {
    const docBase =
      Number.isFinite(documentTolerance) && documentTolerance > 0 ? documentTolerance : 0;
    const localBase = options.worldMatrix
      ? localToleranceForHoleMatrix(options.worldMatrix, docBase)
      : docBase;
    if (!Number.isFinite(localBase)) {
      return { kind: 'ambiguous', reason: 'singular/unreadable transform (fail-closed)' };
    }
    localBaseForAudit = localBase;
    const localTolerance = localBase + curvedLocalMarginFor(flattenTolerance);
    if (!Number.isFinite(localTolerance)) {
      return { kind: 'ambiguous', reason: 'singular/unreadable transform (fail-closed)' };
    }
    const edgeDistance = distanceToContours(contours, local);
    if (!Number.isFinite(edgeDistance) || !(edgeDistance > localTolerance)) {
      return { kind: 'ambiguous', reason: 'point is on/near a painted edge (fail-closed)' };
    }
  }
  // Fail-closed topology audit (SVG implicit close included everywhere):
  // isolated/degenerate/self-intersecting/collinear-touching contours and any
  // inter-contour gap within the flatten-error sum refuse the whole file.
  // Without a separation proof every point is uncertified, so one global
  // `ambiguous` is sufficient (no safety proof attempted here).
  {
    const audit = auditCurvedTopology(contours, flattenTolerance, localBaseForAudit);
    if (!audit.ok) return { kind: 'ambiguous', reason: audit.reason };
  }
  if (contoursOverlap(contours)) {
    return { kind: 'ambiguous', reason: 'contours overlap (fail-closed)' };
  }
  const areas = contours.map((contour) => contourArea(contour));
  if (areas.some((area) => !Number.isFinite(area) || Math.abs(area) <= 1e-9)) {
    return { kind: 'ambiguous', reason: 'degenerate contour (fail-closed)' };
  }
  // Laminar nesting on the flattened polylines (same exact subset as the
  // straight helper): self-touch / inter-touch / partial overlap refuse even
  // when the flatten audit above passed.
  {
    const laminar = auditStraightNesting(contours);
    if (!laminar.ok) return { kind: 'ambiguous', reason: laminar.reason };
  }
  const containing = containingContourIndices(contours, local, fillRule);
  if (containing.length === 0) return { kind: 'outside', containing };
  if (isPointFilled(contours, local, fillRule)) return { kind: 'filled', containing };
  // Nested islands: smallest containing = hole, parent = outer, hole child-free.
  // Outer rings containing an island stay ambiguous (solid overlay coverage).
  {
    const resolved = resolveNestedHole({ contours, containing, areas });
    if (!resolved.ok) return { kind: 'ambiguous', reason: resolved.reason };
    const holeBounds = contourBounds(contours[resolved.holeIndex]!);
    if (!(holeBounds.width > 0 && holeBounds.height > 0)) {
      return { kind: 'ambiguous', reason: 'degenerate hole bounds (fail-closed)' };
    }
    return { kind: 'hole', holeIndex: resolved.holeIndex, outerIndex: resolved.outerIndex, holeBounds, containing };
  }
}

/**
 * Unsupported-case enumeration for status surfaces (no guessing, no AGPL
 * text): curve flattening bounds, arc handling, mirror/skew/non-uniform
 * refusal, singular transforms, edge+flatten zones, overlap/island nesting,
 * and the shared caller-side gates (clip/mask, defs `url()`, class paint,
 * invisibility, Z-order, text/raster/use).
 */
export const CURVED_HOLE_UNSUPPORTED_CASES: readonly string[] = [
  'curved segments are flattened with bounded deviation; the widened edge zone is never a hole',
  'arc segments (A) are sampled directly from the true ellipse with a proven chord bound (never cubic approximation); over-cap radii refuse',
  'degenerate / sub-epsilon / overflowing arc radii refuse (fail-closed)',
  'mirrored transforms (negative determinant) need the Paper entity probe',
  'non-uniform scales and skews need the Paper entity probe (similarity only)',
  'singular or unreadable transforms (no identity fallback)',
  'points within tolerance + flatten margin of a painted edge (anti-alias + flatten zone)',
  'overlapping, crossing, or duplicate contours (renderer-dependent fill)',
  'outer rings containing an island stay ambiguous (a solid overlay would cover the island); only the innermost child-free nested hole resolves',
  'clip-path / mask units (baked import ignores clipping)',
  'defs-hosted url(#...) paint (needs defs resolution, inherited urls included)',
  'class / stylesheet-driven paint, fill-rule, display, visibility, or opacity (detached DOM cannot compute styles; fail-closed)',
  'display:none / visibility:hidden|collapse / opacity:0 / fill-opacity:0 units (nothing rendered; no hole)',
  'inline style beats presentation attributes; svg-root values inherit (fill, fill-rule)',
  'cross-unit Z-order overlap (caller probes top-down; this helper classifies one d only)',
  'text / image / use units (not path holes)',
] as const;
