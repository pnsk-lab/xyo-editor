// Vector fill-tool hover/target helper (safe, UI-independent).
//
// Observed reference behavior (reimplemented from behavior notes, no upstream
// source copied):
// - Hover uses a zoom-aware tolerance (2 screen px divided by zoom), fill +
//   stroke hits, no segments/curves, guides excluded. A helper/noHover item, a
//   selected item, or a selection handle/bounds guide is never a hover target.
// - A `fill` hit on a plain path is accepted only when the path already has a
//   fill, is closed, or is almost closed (first/last points closer than 8
//   document units with more than 2 segments). A `stroke` hit on an open path
//   is still accepted (it recolors the outline). Point-text always accepts.
// - Transparent solid paint needs "unstroked" hits, otherwise hovering an
//   outline made transparent would flicker (hit, clear, miss, ...). Any
//   visible paint must not hit invisible outlines (it would add outlines to
//   non-outlined shapes on hover).
// - Compound-path holes (a child with negative area hit on its fill) are not
//   recolored in place: transparent fill on a hole is a no-op, otherwise an
//   ephemeral same-shape overlay fills the hole. Non-hole children recolor the
//   whole compound parent. Radial previews recenter on the pointer even when
//   the target is unchanged; switching targets restores the previous preview.
// - Selection handles/bounds are guide items and never participate in the
//   fill hit test (`guide: false` plus helper/data exclusion).
//
// Current editor gap (read-only observation, not edited here):
// - `paperVectorHitIndex` (`paper-vector.ts`) hits with fill+stroke+curves+
//   segments and a fixed 0.5 SVG-unit tolerance: open paths hit on fill, text
//   has no special case, there is no transparent-dependent unstroked rule, no
//   selected/noHover/guide exclusion beyond unit filtering, and no
//   fill-vs-stroke side is returned (only an index).
// - `fillVectorObjectAtPoint` (`Editor.svelte`) resolves that index and calls
//   `editVectorObject('style', point)`, which backfills *both* fill and stroke
//   from the toolbar and writes the whole unit. There is no hover preview, no
//   hole overlay / hole no-op, and no per-side (outline-only vs fill-only)
//   application.
// - `paperVectorHitIndex` callers now have zoom-aware helpers
//   (`vector-hit-tolerance.ts`), but the fill path still passes a single
//   index without side/hole metadata.
//
// This module is the UI-independent core for that gap: pure target
// classification plus ephemeral preview helpers. It never touches history,
// Paper.js, Svelte, or the live document beyond the explicitly passed stub
// element. Preview writes are fail-closed (unknown/class-driven paints are
// reported, never guessed) and side-scoped (a fill preview never writes
// `stroke`, a stroke preview never writes `fill`, transforms/ids/geometry are
// never touched). Permanent commits stay with the existing style pipeline;
// this module only answers "what would the fill tool target?" and "what
// ephemeral preview is safe to show?".
//
// Security / coordinate notes for callers:
// - Feed Paper.js only sanitized SVG (`sanitizeSvgForPaperImport` /
//   `sanitizeSvgFragmentForPaperImport`); never import raw external SVG.
// - Click/hover points arrive in document space. Map radial centers per
//   element with `documentPointToLocalGradientPoint` and import hit units via
//   `bakedUnitClone` so ancestor transforms are honored without moving
//   ancestors or siblings.
// - Composite shapes (SVG multi-subpath with evenodd / Paper CompoundPath)
//   must use the hole helpers below: a negative-area child hit on fill is a
//   hole, not the parent fill.
// - Never interpolate untrusted `url(#...)` into preview paint; hole overlays
//   carry an explicit `data-*` marker and `pointer-events: none` so a later
//   hover pass can exclude them via `noHover`.

export const VECTOR_FILL_TOOL_TOLERANCE_SCREEN_PX = 2;

/** First/last-point gap below which an open path counts as "almost closed". */
export const VECTOR_FILL_ALMOST_CLOSED_GAP = 8;

/** Minimum segment count for the almost-closed rule (mirrors `> 2`). */
export const VECTOR_FILL_ALMOST_CLOSED_MIN_SEGMENTS = 3;

export type FillHoverHitType = 'fill' | 'stroke' | 'segment' | 'curve' | 'other';

export type FillHoverItemKind = 'path' | 'text' | 'other';

export type FillHoverHitClassification = {
  /** Reference item kind (paths gate fill hits; text always accepts). */
  kind: FillHoverItemKind;
  /** Whether the path already paints a fill (`hasFill()` in the reference). */
  hasFill: boolean;
  /** Whether the path is closed. */
  closed: boolean;
  /** Whether the open path is almost closed (gap rule below). */
  almostClosed: boolean;
  /** Which part of the shape was hit. */
  hitType: FillHoverHitType;
};

export type HoverableFillCandidateFlags = {
  /** Ephemeral preview / guide item (`data.noHover`, hole overlay, hover guide). */
  noHover?: boolean;
  /** Already selected: the reference shows no hover highlight for it. */
  selected?: boolean;
  /** Selection bounds/handle or any guide-layer item. */
  guide?: boolean;
  /** Helper item (`data.isHelperItem`, rect-select, hit-point, ...). */
  isHelperItem?: boolean;
  /** Locked or clip-mask items are never fill targets. */
  locked?: boolean;
  isClipMask?: boolean;
};

/**
 * Zoom-aware fill tolerance: 2 screen px divided by the live zoom. Non-finite
 * or non-positive zooms fall back to the unit tolerance so callers never
 * divide by zero (fail-closed, still hittable).
 */
export function fillToolToleranceForZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return VECTOR_FILL_TOOL_TOLERANCE_SCREEN_PX;
  return VECTOR_FILL_TOOL_TOLERANCE_SCREEN_PX / zoom;
}

/** Distance between two points in document units. */
export function fillGapDistance(
  first: { x: number; y: number },
  last: { x: number; y: number },
): number {
  const dx = first.x - last.x;
  const dy = first.y - last.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Number.POSITIVE_INFINITY;
  return Math.hypot(dx, dy);
}

/**
 * Almost-closed rule: more than 2 segments and the first/last points are
 * closer than 8 document units. Pure geometry so `bun test` can cover it
 * without Paper.js.
 */
export function isAlmostClosedFillPath(
  segmentCount: number,
  first: { x: number; y: number },
  last: { x: number; y: number },
  threshold = VECTOR_FILL_ALMOST_CLOSED_GAP,
): boolean {
  if (!Number.isFinite(segmentCount) || segmentCount < VECTOR_FILL_ALMOST_CLOSED_MIN_SEGMENTS) return false;
  if (!Number.isFinite(threshold) || threshold < 0) return false;
  return fillGapDistance(first, last) < threshold;
}

/**
 * Reference `match` predicate as a pure function. Plain paths accept a fill
 * hit only with an existing fill, a closed contour, or an almost-closed
 * contour; stroke (or any non-fill) hits on paths are always accepted. Text
 * always accepts. Anything else (groups, rasters, symbols, ...) never
 * accepts: callers must resolve to a leaf path/text first.
 */
export function shouldAcceptFillHoverHit(hit: FillHoverHitClassification): boolean {
  if (hit.kind === 'text') return true;
  if (hit.kind !== 'path') return false;
  if (hit.hitType !== 'fill') return true;
  return hit.hasFill || hit.closed || hit.almostClosed;
}

/**
 * Transparent-solid rule: only a solid transparent paint may hit invisible
 * outlines. Any visible paint (or any gradient) must not hit unstroked
 * paths, otherwise hovering where an outline *would* be adds a visible
 * outline to non-outlined shapes.
 */
export function hitUnstrokedPathsForFillPaint(options: {
  gradientType: string;
  fillTransparent: boolean;
}): boolean {
  return options.gradientType === 'solid' && options.fillTransparent;
}

/** True when the hit is a compound-path hole fill (negative-area child). */
export function isHoleFillHit(options: {
  parentIsCompoundPath: boolean;
  childArea: number;
  hitType: FillHoverHitType;
}): boolean {
  if (!options.parentIsCompoundPath) return false;
  if (options.hitType !== 'fill') return false;
  if (!Number.isFinite(options.childArea)) return false;
  return options.childArea < 0;
}

export type FillHoverTargetDecision =
  | { action: 'ignore' }
  | { action: 'preview-parent'; property: 'fill' | 'stroke' }
  | { action: 'preview-hole-overlay'; property: 'fill' }
  | { action: 'noop-transparent-hole' };

/**
 * Decide what a hover/click hit means without touching the document. Holes
 * need an overlay (or nothing when the paint is transparent); non-hole
 * compound children recolor the parent; plain hits recolor the hit side.
 * Rejected hits (`accepted === false`) are always `ignore`.
 */
export function decideFillHoverTarget(options: {
  accepted: boolean;
  isHole: boolean;
  parentIsCompoundPath: boolean;
  hitType: FillHoverHitType;
  fillTransparent: boolean;
}): FillHoverTargetDecision {
  if (!options.accepted) return { action: 'ignore' };
  if (options.isHole) {
    if (options.fillTransparent) return { action: 'noop-transparent-hole' };
    return { action: 'preview-hole-overlay', property: 'fill' };
  }
  if (options.parentIsCompoundPath) {
    return { action: 'preview-parent', property: options.hitType === 'fill' ? 'fill' : 'stroke' };
  }
  return { action: 'preview-parent', property: options.hitType === 'fill' ? 'fill' : 'stroke' };
}

/**
 * Hover-candidate gate mirroring `getHoveredItem` + selection `getItems`:
 * helpers, guides, selected items, locked items, and clip masks never become
 * fill targets. Selection handles/bounds are guides, so they are excluded
 * here even if a hit test reports them.
 */
export function isHoverableFillCandidate(flags: HoverableFillCandidateFlags): boolean {
  if (flags.noHover) return false;
  if (flags.selected) return false;
  if (flags.guide) return false;
  if (flags.isHelperItem) return false;
  if (flags.locked) return false;
  if (flags.isClipMask) return false;
  return true;
}

export type FillPreviewTargetKey = {
  /** Selectable-unit index in `editableVectorUnits(svg)`. */
  index: number;
  /** Which side the pointer hit (`fill` vs `stroke`). */
  property: 'fill' | 'stroke';
  /** True when the target is a hole overlay (not the parent recolor). */
  isHoleOverlay: boolean;
};

function sameFillPreviewTarget(
  left: FillPreviewTargetKey | null | undefined,
  right: FillPreviewTargetKey | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.index === right.index && left.property === right.property && left.isHoleOverlay === right.isHoleOverlay;
}

export type FillPreviewTransition =
  | { action: 'none' }
  | { action: 'update-radial-center' }
  | { action: 'switch-target' };

/**
 * Preview state machine for hover moves. Switching sides (fill vs stroke on
 * the same unit), switching units, or toggling hole-overlay state restores
 * the old preview and applies the new one. Staying on the same target is a
 * no-op except for radial gradients, which recenter on the pointer. Losing
 * the target (`next === null`) restores the old preview via `switch-target`.
 */
export function planFillPreviewTransition(
  previous: FillPreviewTargetKey | null | undefined,
  next: FillPreviewTargetKey | null | undefined,
  gradientType: string,
): FillPreviewTransition {
  if (sameFillPreviewTarget(previous, next)) {
    if (previous && gradientType === 'radial') return { action: 'update-radial-center' };
    return { action: 'none' };
  }
  if (!previous && !next) return { action: 'none' };
  return { action: 'switch-target' };
}

/** Minimal element surface for ephemeral previews (real Elements qualify). */
export type FillPreviewElement = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export const FILL_HOVER_OVERLAY_MARKER = 'data-fill-hover-hole-overlay';

function fillPreviewAttribute(property: 'fill' | 'stroke'): string {
  return property;
}

/**
 * Capture the current paint of one side for a later restore. Returns the raw
 * attribute value (`null` when absent) so `restoreFillPreview` can put back
 * exactly what was there (including `none` vs missing).
 */
export function captureFillPreviewOriginal(
  element: FillPreviewElement,
  property: 'fill' | 'stroke',
): string | null {
  try {
    return element.getAttribute(fillPreviewAttribute(property));
  } catch {
    return null;
  }
}

/**
 * Apply an ephemeral hover preview to exactly one side. Only the hit side's
 * attribute is written; transforms, ids, geometry, opacity, stops, and the
 * other paint side are never touched. Callers must pass a fully resolved CSS
 * paint (`#rrggbb`, `rgba(...)`, or `none`); `url(#...)` from untrusted input
 * must never be passed here (gradients are commit-time only).
 */
export function applyFillPreviewToElement(
  element: FillPreviewElement,
  property: 'fill' | 'stroke',
  previewPaint: string,
): void {
  element.setAttribute(fillPreviewAttribute(property), previewPaint);
}

/** Restore a previewed side to its captured original (`null` removes it). */
export function restoreFillPreviewToElement(
  element: FillPreviewElement,
  property: 'fill' | 'stroke',
  original: string | null,
): void {
  if (original === null) {
    try {
      element.removeAttribute(fillPreviewAttribute(property));
    } catch {
      // Best effort: the attribute write below already stands alone.
    }
    return;
  }
  element.setAttribute(fillPreviewAttribute(property), original);
}

/**
 * Mark an ephemeral hole overlay so later hover passes exclude it (`noHover`
 * parity) and hit tests never treat it as document content. The marker is a
 * plain `data-*` attribute plus `pointer-events: none`; it carries no paint
 * semantics and must be removed together with the overlay node.
 */
export function markHoleFillOverlay(element: FillPreviewElement): void {
  element.setAttribute(FILL_HOVER_OVERLAY_MARKER, 'true');
  element.setAttribute('pointer-events', 'none');
}

/** True when the element is an ephemeral hole overlay (never a fill target). */
export function isHoleFillOverlay(element: FillPreviewElement): boolean {
  try {
    return element.getAttribute(FILL_HOVER_OVERLAY_MARKER) === 'true';
  } catch {
    return false;
  }
}

/** Hover flags for an overlay element (always excluded from targeting). */
export function holeOverlayHoverFlags(): HoverableFillCandidateFlags {
  return { noHover: true, isHelperItem: true };
}
