// Vector fill-tool hover preview resolver (safe, independent, non-destructive).
//
// Purpose: answer "what would the fill tool preview at this document point?"
// without touching DOM / VM / history. This module never writes: it only
// reads `getAttribute` / `tagName` / `parentElement`, calls the injected
// read-only resolvers, and reuses the pure classifiers in
// `vector-fill-hover.ts`.
//
// Verified against the existing pipeline (read-only, no upstream source
// copied):
// - `paperVectorHitIndex` (`paper-vector.ts`) is select-tool parity
//   (fill+stroke+curves+segments, fixed 0.5 SVG-unit tolerance, index only).
//   The fill path does NOT use it; clicks use `paperVectorFillTargetAtPoint`
//   (fill+stroke only, zoom-aware tolerance, side + match metadata) plus
//   `paperVectorHoleTargetAtPoint` (geometric hole probe, fail-closed).
// - Zoom: the editor commits with `resolveVectorHitTolerance()` (2 screen px
//   divided by the live surface scale `5 * viewportScale`). The pure helper
//   `fillToolToleranceForZoom(zoom) = 2 / zoom` expresses the same budget when
//   only a Paper zoom is known. This resolver accepts an explicit tolerance
//   (preferred: pass the editor value through) and falls back to
//   `fillToolToleranceForZoom` so `bun test` can cover it without Paper.js.
// - Ancestor transforms: both Paper resolvers import via `bakedUnitClone` +
//   fragment sanitizer, so document-space points honor nested `<g>`
//   transforms. This resolver forwards the document point unchanged and
//   requires `units` to be `editableVectorUnits(svg)` (which preserves
//   ancestors and already excludes defs/clipPath/mask companions).
// - Exclusion: `isHoverableFillCandidate` (selected / guide / noHover /
//   helper / locked / clip-mask) plus a local clip/mask ancestor walk
//   (mirrors the hole probe's fail-closed clip decline; the baked import
//   does not apply ancestor clipping, so a clipped unit must not preview).
// - Sides: `hitType` (`fill` vs `stroke`) is commit-scoped; the reference
//   `match` gate (`shouldAcceptFillHoverHit`) rejects fill hits on plain
//   open paths while stroke hits and point-text always qualify.
// - Transparent paint: `hitUnstrokedPathsForFillPaint` gates stroke-side hits
//   on invisible outlines (visible paint must not invent outlines;
//   transparent-solid alone may hit them). Hole overlays additionally honor
//   `fillInvisible` (solid-transparent or both-transparent gradient).
// - Holes: stock Paper never yields hole children; the geometric probe
//   decides `hole-overlay` (colored paint) vs `noop-transparent-hole` vs
//   `ambiguous`/`unsupported` (fail-closed, never a parent recolor).
//
// Non-destructive contract (enforced by tests):
// - No `setAttribute` / `removeAttribute` / `insertBefore` / `remove`.
// - No history (`peek`/`commit`/`capture`), no VM, no selection writes.
// - Preview writes (`applyFillPreviewToElement`, overlays) stay with the
//   caller; this module returns a `targetKey` compatible with
//   `planFillPreviewTransition` instead.

import {
  decideFillHoverTarget,
  fillToolToleranceForZoom,
  hitUnstrokedPathsForFillPaint,
  isHoleFillHit,
  isHoverableFillCandidate,
  shouldAcceptFillHoverHit,
  type FillHoverHitType,
  type FillPreviewTargetKey,
  type HoverableFillCandidateFlags,
} from './vector-fill-hover';

export const FILL_HOVER_PREVIEW_FALLBACK_TOLERANCE = 2;

export type FillHoverPreviewPoint = { x: number; y: number };

export type FillHoverPreviewPaint = {
  /** `solid` | `horizontal` | `vertical` | `radial` (mirrors toolbar state). */
  gradientType: string;
  /** True when the primary fill toggle is transparent. */
  fillTransparent: boolean;
  /** True when the resolved fill paints nothing (`isFillInvisible`). */
  fillInvisible: boolean;
};

export type FillHoverPreviewBodyTarget = {
  index: number;
  hitType: 'fill' | 'stroke';
  isText: boolean;
  hasFill: boolean;
  closed: boolean;
  almostClosed: boolean;
  parentIsCompoundPath: boolean;
  childArea: number | undefined;
};

export type FillHoverPreviewHoleTarget = {
  parentIndex: number;
  holePathData: string;
  holeDocumentBounds: { x: number; y: number; width: number; height: number };
  parentTransform: string;
  parentFillRule: string;
};

export type FillHoverPreviewHoleProbe =
  | { kind: 'hole'; target: FillHoverPreviewHoleTarget }
  | { kind: 'none' }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unsupported'; reason: string };

export type FillHoverPreviewResolvers = {
  resolveBodyTarget: (
    units: Element[],
    point: FillHoverPreviewPoint,
    tolerance: number,
  ) => Promise<FillHoverPreviewBodyTarget | null>;
  resolveHoleProbe: (
    units: Element[],
    point: FillHoverPreviewPoint,
    tolerance: number,
  ) => Promise<FillHoverPreviewHoleProbe>;
};

export type FillHoverPreviewResult =
  | {
      kind: 'none';
      reason: string;
      tolerance: number;
      targetKey: null;
    }
  | {
      kind: 'body';
      index: number;
      property: 'fill' | 'stroke';
      targetKey: FillPreviewTargetKey;
      tolerance: number;
      reason: string;
    }
  | {
      kind: 'hole-overlay';
      parentIndex: number;
      hole: FillHoverPreviewHoleTarget;
      targetKey: FillPreviewTargetKey;
      tolerance: number;
      reason: string;
    }
  | {
      kind: 'noop-transparent-hole';
      tolerance: number;
      targetKey: null;
      reason: string;
    }
  | {
      kind: 'ambiguous';
      reason: string;
      tolerance: number;
      targetKey: null;
    }
  | {
      kind: 'unsupported';
      reason: string;
      tolerance: number;
      targetKey: null;
    };

export type FillHoverPreviewOptions = {
  units: Element[];
  point: FillHoverPreviewPoint;
  /** Preferred: pass the editor zoom-aware tolerance through. */
  tolerance?: number;
  /** Fallback when `tolerance` is missing: `2 / zoom` via `fillToolToleranceForZoom`. */
  zoom?: number;
  paint: FillHoverPreviewPaint;
  resolvers: FillHoverPreviewResolvers;
  /** Currently selected unit indices (hover never targets them). */
  selectedIndices?: ReadonlySet<number> | number[];
  /** Per-unit candidate flags (guide / noHover / helper / locked / clip-mask). */
  getCandidateFlags?: (element: Element, index: number) => HoverableFillCandidateFlags;
  /**
   * Read-only stroke visibility for the unstroked-outline gate. Defaults to
   * a local `stroke` / `stroke-width` / `style` check; callers with inherited
   * group paint should inject an ancestor-aware reader.
   */
  hasVisibleStroke?: (element: Element) => boolean;
};

/**
 * Resolve an explicit tolerance or derive one from a Paper zoom.
 * Explicit finite values win (so the editor can pass
 * `resolveVectorHitTolerance()` through); otherwise `2 / zoom` with a
 * fail-closed fallback that never divides by zero.
 */
export function resolveFillHoverPreviewTolerance(options: {
  tolerance?: number;
  zoom?: number;
}): number {
  if (typeof options.tolerance === 'number' && Number.isFinite(options.tolerance) && options.tolerance >= 0) {
    return options.tolerance;
  }
  if (typeof options.zoom === 'number') return fillToolToleranceForZoom(options.zoom);
  return FILL_HOVER_PREVIEW_FALLBACK_TOLERANCE;
}

function toSelectedSet(input: FillHoverPreviewOptions['selectedIndices']): Set<number> {
  if (!input) return new Set();
  if (input instanceof Set) return new Set(input);
  if (Array.isArray(input)) return new Set(input.filter((value) => Number.isInteger(value)));
  return new Set();
}

/** Read-only ancestor walk: `clip-path` / `mask` (attr or inline style) blocks hover. */
export function isClipBlockedUnit(element: Element): boolean {
  try {
    let node: Element | null = element;
    while (node) {
      try {
        const tag = node.tagName?.toLowerCase();
        if (tag === 'svg') break;
        if (typeof node.hasAttribute === 'function') {
          if (node.hasAttribute('clip-path') || node.hasAttribute('mask')) return true;
        }
        const style = typeof node.getAttribute === 'function' ? (node.getAttribute('style') ?? '') : '';
        if (/clip-path\s*:/i.test(style) || /(^|;)\s*mask\s*:/i.test(style)) return true;
        if (tag === 'clippath' || tag === 'mask') return true;
      } catch {
        // Fail-closed: an unreadable ancestor blocks the preview.
        return true;
      }
      node = node.parentElement;
    }
  } catch {
    return true;
  }
  return false;
}

/** Read-only local stroke check (`stroke="none"` / zero width / transparent style = invisible). */
export function hasLocalVisibleStroke(element: Element): boolean {
  try {
    const style = element.getAttribute('style') ?? '';
    const styleStroke = /stroke\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim().toLowerCase();
    const rawStroke = (element.getAttribute('stroke') ?? styleStroke ?? '').trim().toLowerCase();
    if (rawStroke === '' || rawStroke === 'none' || rawStroke === 'transparent') return false;
    const rawWidth = (element.getAttribute('stroke-width') ?? /stroke-width\s*:\s*([^;]+)/i.exec(style)?.[1] ?? '').trim();
    if (rawWidth !== '') {
      const width = Number(rawWidth);
      if (Number.isFinite(width) && width <= 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readFlags(
  options: FillHoverPreviewOptions,
  element: Element,
  index: number,
  selected: Set<number>,
): HoverableFillCandidateFlags {
  if (selected.has(index)) return { selected: true };
  try {
    return options.getCandidateFlags?.(element, index) ?? {};
  } catch {
    // Fail-closed: unreadable flags exclude the unit.
    return { noHover: true };
  }
}

/**
 * Non-destructive hover resolution. Reads only; never writes DOM / VM /
 * history. Both resolvers run concurrently (they are read-only Paper
 * imports); ordering / gating mirrors `fillVectorObjectAtPoint` in
 * `Editor.svelte` minus its commits.
 */
export async function resolveFillHoverPreview(options: FillHoverPreviewOptions): Promise<FillHoverPreviewResult> {
  const tolerance = resolveFillHoverPreviewTolerance(options);
  const point = options.point;
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return { kind: 'none', reason: 'non-finite point (fail-closed)', tolerance, targetKey: null };
  }
  const units = options.units ?? [];
  if (units.length === 0) {
    return { kind: 'none', reason: 'no selectable units', tolerance, targetKey: null };
  }
  const selected = toSelectedSet(options.selectedIndices);
  const hasVisibleStroke = options.hasVisibleStroke ?? hasLocalVisibleStroke;

  let body: FillHoverPreviewBodyTarget | null;
  let hole: FillHoverPreviewHoleProbe;
  try {
    [body, hole] = await Promise.all([
      options.resolvers.resolveBodyTarget(units, { x: point.x, y: point.y }, tolerance),
      options.resolvers.resolveHoleProbe(units, { x: point.x, y: point.y }, tolerance),
    ]);
  } catch {
    return { kind: 'none', reason: 'hit resolver failed (fail-closed)', tolerance, targetKey: null };
  }

  if (hole.kind === 'ambiguous') {
    return { kind: 'ambiguous', reason: hole.reason, tolerance, targetKey: null };
  }
  if (hole.kind === 'unsupported') {
    return { kind: 'unsupported', reason: hole.reason, tolerance, targetKey: null };
  }

  if (!body) {
    if (hole.kind === 'hole') {
      if (options.paint.fillInvisible) {
        return { kind: 'noop-transparent-hole', tolerance, targetKey: null, reason: 'transparent holes stay empty' };
      }
      return {
        kind: 'hole-overlay',
        parentIndex: hole.target.parentIndex,
        hole: hole.target,
        targetKey: { index: hole.target.parentIndex, property: 'fill', isHoleOverlay: true },
        tolerance,
        reason: 'hole overlay preview',
      };
    }
    return { kind: 'none', reason: 'no shape under the pointer', tolerance, targetKey: null };
  }

  const element = units[body.index];
  if (!element) {
    return { kind: 'none', reason: 'hit index is stale (fail-closed)', tolerance, targetKey: null };
  }
  if (!isHoverableFillCandidate(readFlags(options, element, body.index, selected))) {
    return { kind: 'none', reason: 'excluded unit (selected/guide/helper/locked/clip)', tolerance, targetKey: null };
  }
  if (isClipBlockedUnit(element)) {
    return { kind: 'none', reason: 'clip/mask unit (fail-closed)', tolerance, targetKey: null };
  }

  // Transparent-solid rule: visible paint (or any gradient) must not hit
  // invisible outlines, otherwise hovering where an outline *would* be adds
  // one to non-outlined shapes.
  if (body.hitType === 'stroke') {
    let stroked = false;
    try {
      stroked = hasVisibleStroke(element);
    } catch {
      stroked = false;
    }
    if (!stroked && !hitUnstrokedPathsForFillPaint({ gradientType: options.paint.gradientType, fillTransparent: options.paint.fillTransparent })) {
      return { kind: 'none', reason: 'visible paint ignores invisible outlines', tolerance, targetKey: null };
    }
  }

  const accepted = shouldAcceptFillHoverHit({
    kind: body.isText ? 'text' : 'path',
    hasFill: body.isText ? true : body.hasFill,
    closed: body.isText ? true : body.closed,
    almostClosed: body.isText ? false : body.almostClosed,
    hitType: body.hitType as FillHoverHitType,
  });
  if (!accepted) {
    return { kind: 'none', reason: 'open paths take only outline color', tolerance, targetKey: null };
  }

  if (hole.kind === 'hole' && hole.target.parentIndex > body.index) {
    return { kind: 'none', reason: 'hole overlaps another shape, left unchanged', tolerance, targetKey: null };
  }

  const holeHit = isHoleFillHit({
    parentIsCompoundPath: body.parentIsCompoundPath,
    childArea: body.childArea ?? Number.NaN,
    hitType: body.hitType as FillHoverHitType,
  });
  const decision = decideFillHoverTarget({
    accepted: true,
    isHole: holeHit,
    parentIsCompoundPath: body.parentIsCompoundPath,
    hitType: body.hitType as FillHoverHitType,
    fillTransparent: options.paint.fillTransparent,
  });
  if (decision.action === 'ignore' || decision.action === 'noop-transparent-hole') {
    if (decision.action === 'noop-transparent-hole') {
      return { kind: 'noop-transparent-hole', tolerance, targetKey: null, reason: 'transparent holes stay empty' };
    }
    return { kind: 'none', reason: 'hover target rejected (fail-closed)', tolerance, targetKey: null };
  }
  if (decision.action === 'preview-hole-overlay') {
    if (options.paint.fillInvisible) {
      return { kind: 'noop-transparent-hole', tolerance, targetKey: null, reason: 'transparent holes stay empty' };
    }
    if (hole.kind === 'hole') {
      return {
        kind: 'hole-overlay',
        parentIndex: hole.target.parentIndex,
        hole: hole.target,
        targetKey: { index: hole.target.parentIndex, property: 'fill', isHoleOverlay: true },
        tolerance,
        reason: 'hole overlay preview',
      };
    }
    return { kind: 'none', reason: 'hole geometry is unavailable, left unchanged', tolerance, targetKey: null };
  }
  return {
    kind: 'body',
    index: body.index,
    property: decision.property,
    targetKey: { index: body.index, property: decision.property, isHoleOverlay: false },
    tolerance,
    reason: `preview ${decision.property}`,
  };
}

/**
 * Minimal async-race guard for hover `pointermove` streams. The resolver
 * itself is stateless; callers issue an id per move, await, then drop the
 * result when a newer move has already issued (see integration notes in the
 * test file header). Pure and allocation-free beyond the closure.
 */
export function createFillHoverPreviewTracker(): {
  issue: () => number;
  isStale: (id: number) => boolean;
  current: () => number;
} {
  let current = 0;
  return {
    issue: () => {
      current += 1;
      return current;
    },
    isStale: (id: number) => id !== current,
    current: () => current,
  };
}
