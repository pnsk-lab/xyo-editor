// Independent stroke-paint helpers for Scratch Paint parity.
//
// Observed reference behavior (reimplemented here from behavior notes, no
// upstream source copied):
// - Fill and stroke keep independent primary/secondary colors plus an
//   independent gradient kind (solid / horizontal / vertical / radial).
//   Each side stores a CSS color string or `null` for transparent. A
//   multi-item selection with differing values shows a MIXED indicator.
// - When exactly one gradient endpoint is transparent, the transparent end
//   reuses the surviving end's RGB with alpha 0, so only opacity
//   interpolates (no fade through black/gray). Both-transparent stays
//   transparent.
// - A stroke width of 0 is treated as "no stroke": the stroke color reads
//   back as transparent and no stroke gradient is displayed.
// - Paper.js-side gradients are per-item objects; on SVG export each
//   gradient becomes a `<linearGradient>` / `<radialGradient>` in `<defs>`
//   referenced via `stroke="url(#id)"`.
//
// Current editor gap (`Editor.svelte`, `vector-shapes.ts`):
// - `paintColor` / `secondaryPaintColor` / `paintGradient` are fill-side
//   only; `strokeColor` is a single always-opaque hex string with no second
//   color, no independent gradient kind, and no gradient output (stroke is
//   always a flat `stroke="..."` attribute).
// - `vectorPaintStyle()` mints its fill gradient id with `Date.now()` plus
//   `Math.random()`, so it is impure and can collide when markup from two
//   documents (each holding e.g. `id="g1"`) is combined.
//
// This module is the stroke-side counterpart of `paint-colors.ts` /
// `transparent-paint.ts`: UI-independent, DOM-library-free, and pure (the
// caller supplies every id, so output is byte-deterministic per input).
// Element mutation is expressed through a minimal `get/set/removeAttribute`
// interface so `bun test` can exercise it with lightweight stubs and no
// `DOMParser`. String-level `<defs>` helpers work on serialized SVG text for
// the document-merge / ID-collision cases. Paper.js objects, Svelte state,
// and CanvasGradient creation are deliberately left to callers.

import {
  paintToCss,
  paintToHex,
  parseHexPaintRgba,
  resolveGradientEndpoints,
  resolveVectorLinearUserSpace,
  resolveVectorRadialUserSpace,
  type PaintColor,
  type PaintGradientKind,
  type PaintRgba,
  type VectorGradientBounds,
  type VectorGradientCenter,
} from './paint-colors';

export type StrokeGradientKind = PaintGradientKind;
export type StrokePaintColor = PaintColor;

export type StrokePaintState = {
  /** First stroke color. `null` = transparent. */
  primary: StrokePaintColor;
  /** Second stroke color for gradients. `null` = transparent. */
  secondary: StrokePaintColor;
  /** Independent stroke gradient kind (fill kind is a separate value). */
  gradient: StrokeGradientKind;
  /** Stroke width in SVG user units. `<= 0` (or non-finite) means no stroke. */
  width: number;
};

export type SvgStrokePaintOptions = {
  /** Caller-supplied gradient id (kept pure: no `Date.now()`/random inside). */
  id: string;
  gradient: StrokeGradientKind;
  primary: StrokePaintColor;
  secondary: StrokePaintColor;
  /** Stroke width gate: `<= 0` (or non-finite) forces `stroke="none"`. */
  strokeWidth: number;
  /** Legacy size; ignored when `bounds` is supplied. Kept for API compatibility. */
  width: number;
  height: number;
  /**
   * Real local bounds of the referencing element (parent user space, own
   * transform baked in, ancestors excluded). With `bounds`, gradients use
   * `userSpaceOnUse` over the real bounds (radial `max(w,h)/2`,
   * click-centered when `center` is given); without it, the legacy
   * `objectBoundingBox` fallback is kept.
   */
  bounds?: VectorGradientBounds;
  /** Optional radial center (fill-tool click in parent user space). */
  center?: VectorGradientCenter;
};

export type SvgStrokePaint = {
  defs: string;
  /** Value for the `stroke` attribute (`'none'`, a CSS color, or `url(#id)`). */
  stroke: string;
  /** Gradient id referenced by `stroke`, or `''` for solid paints. */
  id: string;
};

/** Minimal element surface used for stroke replacement (DOM stubs qualify). */
export type StrokePaintElement = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export type StrokeTogglePaintOptions = {
  /** Caller-supplied gradient id (kept pure). */
  id: string;
  strokeTransparent: boolean;
  strokeHex: string;
  secondaryTransparent: boolean;
  secondaryHex: string;
  gradient: StrokeGradientKind;
  strokeWidth: number;
  width: number;
  height: number;
  bounds?: VectorGradientBounds;
  center?: VectorGradientCenter;
};

export type StrokeSwapState = {
  primary: string;
  primaryTransparent: boolean;
  secondary: string;
  secondaryTransparent: boolean;
};

function opaqueFallback(): PaintRgba {
  return { r: 0, g: 0, b: 0, a: 255 };
}

function hexToStrokeRgba(hex: string): PaintRgba {
  return parseHexPaintRgba(hex) ?? opaqueFallback();
}

/** First stroke color as a `PaintColor`: `null` when the transparent toggle is on. */
export function strokePrimaryInput(strokeTransparent: boolean, strokeHex: string): StrokePaintColor {
  if (strokeTransparent) return null;
  return hexToStrokeRgba(strokeHex);
}

/** Second stroke color as a `PaintColor`: `null` when its transparent toggle is on. */
export function strokeSecondaryInput(secondaryTransparent: boolean, secondaryHex: string): StrokePaintColor {
  if (secondaryTransparent) return null;
  return hexToStrokeRgba(secondaryHex);
}

function isUsableStrokeWidth(width: number): boolean {
  return Number.isFinite(width) && width > 0;
}

/**
 * True when the stroke paints nothing: zero/negative/non-finite width, a
 * transparent solid, or a both-transparent gradient. A one-transparent-end
 * gradient still paints (it fades opacity), so it is *not* invisible.
 */
export function isStrokeInvisible(
  primary: StrokePaintColor,
  secondary: StrokePaintColor,
  gradient: StrokeGradientKind,
  strokeWidth: number,
): boolean {
  if (!isUsableStrokeWidth(strokeWidth)) return true;
  if (gradient === 'solid') return primary === null;
  return primary === null && secondary === null;
}

function escapeGradientId(id: string): string {
  return id.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function svgStrokeStop(color: PaintRgba, offset: number): string {
  return `<stop offset="${offset}" stop-color="${paintToHex(color)}" stop-opacity="${trimStrokeAlpha(color.a / 255)}"/>`;
}

function trimStrokeAlpha(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0';
  return String(Math.round(fraction * 1000) / 1000);
}

function formatStrokeGradientNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(3));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Deterministic SVG stroke markup for one stroke state.
 *
 * - Solid + transparent (or any non-positive/non-finite `strokeWidth`) yields
 *   `{ defs: '', stroke: 'none', id: '' }`: no gradient is emitted, matching
 *   the reference rule that a width-0 stroke displays no gradient.
 * - Solid + opaque yields `{ defs: '', stroke: <css>, id: '' }` (translucent
 *   solids keep their `rgba()` form).
 * - Gradients split color/opacity into `stop-color` + `stop-opacity` and
 *   resolve a transparent end to the surviving end's RGB with alpha 0 via
 *   `resolveGradientEndpoints`, so only opacity interpolates. With `bounds`
 *   (+ optional click `center`), geometry is a `userSpaceOnUse` circle/ramp
 *   over the element's real local bounds (reference parity); without
 *   `bounds`, the legacy `objectBoundingBox` percentages are kept.
 */
export function svgStrokePaint(options: SvgStrokePaintOptions): SvgStrokePaint {
  const { id, gradient, primary, secondary, strokeWidth, bounds, center } = options;
  if (!isUsableStrokeWidth(strokeWidth)) return { defs: '', stroke: 'none', id: '' };
  if (gradient === 'solid') {
    if (primary === null) return { defs: '', stroke: 'none', id: '' };
    return { defs: '', stroke: paintToCss(primary), id: '' };
  }
  const safeId = escapeGradientId(id);
  const { from, to } = resolveGradientEndpoints(primary, secondary);
  const stops = `${svgStrokeStop(from, 0)}${svgStrokeStop(to, 1)}`;
  if (gradient === 'radial') {
    if (bounds) {
      const circle = resolveVectorRadialUserSpace(bounds, center);
      return {
        defs: `<defs><radialGradient id="${safeId}" gradientUnits="userSpaceOnUse" cx="${formatStrokeGradientNumber(circle.cx)}" cy="${formatStrokeGradientNumber(circle.cy)}" r="${formatStrokeGradientNumber(circle.r)}">${stops}</radialGradient></defs>`,
        stroke: `url(#${safeId})`,
        id,
      };
    }
    return {
      defs: `<defs><radialGradient id="${safeId}" gradientUnits="objectBoundingBox" cx="50%" cy="50%" r="70%">${stops}</radialGradient></defs>`,
      stroke: `url(#${safeId})`,
      id,
    };
  }
  if (bounds) {
    const vector = resolveVectorLinearUserSpace(bounds, gradient);
    return {
      defs: `<defs><linearGradient id="${safeId}" gradientUnits="userSpaceOnUse" x1="${formatStrokeGradientNumber(vector.x1)}" y1="${formatStrokeGradientNumber(vector.y1)}" x2="${formatStrokeGradientNumber(vector.x2)}" y2="${formatStrokeGradientNumber(vector.y2)}">${stops}</linearGradient></defs>`,
      stroke: `url(#${safeId})`,
      id,
    };
  }
  const vector = gradient === 'vertical' ? `x1="0%" y1="0%" x2="0%" y2="100%"` : `x1="0%" y1="0%" x2="100%" y2="0%"`;
  return {
    defs: `<defs><linearGradient id="${safeId}" gradientUnits="objectBoundingBox" ${vector}>${stops}</linearGradient></defs>`,
    stroke: `url(#${safeId})`,
    id,
  };
}

/**
 * Toggle-level convenience mirroring `resolveVectorFillPaint`: maps the
 * editor's `{ hex, transparent }` stroke state onto {@link svgStrokePaint}.
 * Hex strings are preserved opaquely (parsed, never rewritten), so toggling
 * transparency off restores the previous color.
 */
export function resolveVectorStrokePaint(options: StrokeTogglePaintOptions): SvgStrokePaint {
  return svgStrokePaint({
    id: options.id,
    gradient: options.gradient,
    primary: strokePrimaryInput(options.strokeTransparent, options.strokeHex),
    secondary: strokeSecondaryInput(options.secondaryTransparent, options.secondaryHex),
    strokeWidth: options.strokeWidth,
    width: options.width,
    height: options.height,
    bounds: options.bounds,
    center: options.center,
  });
}

/**
 * Exchange the first/second stroke colors with their transparent flags. The
 * hex strings are carried opaquely (no parsing/normalization) so the
 * operation is an exact involution: applying it twice restores the input.
 */
export function swapStrokePaintState(state: StrokeSwapState): StrokeSwapState {
  return {
    primary: state.secondary,
    primaryTransparent: state.secondaryTransparent,
    secondary: state.primary,
    secondaryTransparent: state.primaryTransparent,
  };
}

/** Format a stroke width for the `stroke-width` attribute (`Math.max(0, w)`). */
export function formatStrokeWidthAttribute(width: number): string | undefined {
  if (!Number.isFinite(width)) return undefined;
  return String(Math.max(0, width));
}

/**
 * Apply resolved stroke paint to one element. Sets `stroke` always; sets
 * `stroke-width` only when `strokeWidth` is a finite number. Never reads or
 * writes `fill`, `fill-*`, `stop-*`, transforms, geometry (`d`, `points`,
 * `x`/`y`/`cx`/…), or any other attribute, so fill paint and existing stops
 * survive stroke replacement untouched.
 */
export function applyStrokePaintToElement(
  element: StrokePaintElement,
  paint: { stroke: string; strokeWidth?: number },
): void {
  element.setAttribute('stroke', paint.stroke);
  if (paint.strokeWidth !== undefined) {
    const formatted = formatStrokeWidthAttribute(paint.strokeWidth);
    if (formatted !== undefined) element.setAttribute('stroke-width', formatted);
  }
}

// -- ID collision avoidance (pure string helpers) ---------------------------

/** Collect every `id="…"` / `id='…'` value in serialized SVG/XML text. */
export function collectGradientIds(svgText: string): Set<string> {
  const ids = new Set<string>();
  const pattern = /\bid\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(svgText)) !== null) {
    const value = match[2] ?? match[3] ?? '';
    if (value) ids.add(value);
  }
  return ids;
}

function sanitizedStrokeBaseId(preferredId: string): string {
  const trimmed = preferredId.trim();
  return trimmed ? trimmed : 'stroke-paint';
}

/**
 * Pick a gradient id that does not collide with `existingIds` (which should
 * hold *all* ids in the target document, not just gradient ids). Returns
 * `preferredId` unchanged when free; otherwise appends `-stroke`, `-stroke-2`,
 * … deterministically (no randomness, so retries are stable and testable).
 */
export function uniqueStrokeGradientId(preferredId: string, existingIds: ReadonlySet<string>): string {
  const base = sanitizedStrokeBaseId(preferredId);
  if (!existingIds.has(base)) return base;
  const stem = `${base}-stroke`;
  if (!existingIds.has(stem)) return stem;
  let counter = 2;
  while (existingIds.has(`${stem}-${counter}`)) counter += 1;
  return `${stem}-${counter}`;
}

/**
 * Parse a `stroke`/`fill` attribute value of the form `url(#id)` (optional
 * quotes/whitespace). Returns the referenced id, or `undefined` when the
 * value is not a local fragment reference.
 */
export function extractStrokeGradientId(ref: string | null | undefined): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const match = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(ref);
  return match ? match[1] : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite the gradient definition id inside a `defs` markup string from
 * `oldId` to `newId` (exact `id="oldId"` match only, so `g1` never rewrites
 * `g10`). Returns the input unchanged when `oldId` is empty.
 */
export function rekeyStrokeGradientDefs(defsMarkup: string, oldId: string, newId: string): string {
  if (!oldId) return defsMarkup;
  return defsMarkup.replace(
    new RegExp(`(\\bid\\s*=\\s*["'])${escapeRegExp(oldId)}(["'])`, 'g'),
    `$1${newId}$2`,
  );
}

/**
 * Rewrite a `stroke="url(#oldId)"` reference to `url(#newId)` (exact-id
 * match: a trailing id character blocks the rewrite, so `url(#g1)` never
 * touches `url(#g10)`). Non-`url(#…)` values pass through unchanged.
 */
export function rekeyStrokePaintReference(ref: string, oldId: string, newId: string): string {
  if (!oldId) return ref;
  return ref.replace(
    new RegExp(`(#${escapeRegExp(oldId)})(?![A-Za-z0-9\\-_.:])`, 'g'),
    `#${newId}`,
  );
}

export type StrokeReplacePaintOptions = Omit<SvgStrokePaintOptions, 'id'> & {
  /** Desired gradient id; renamed deterministically when it collides. */
  preferredId: string;
  /** All ids already present in the target document. */
  existingIds: ReadonlySet<string>;
};

/**
 * Resolve stroke paint for insertion into a document that may already hold
 * the preferred id (e.g. merging markup from a second SVG that also defines
 * `g1`): picks a collision-free id first, then builds the markup for it, so
 * the new `<defs>` never shadows or merges with an unrelated gradient.
 */
export function resolveStrokePaintForReplace(options: StrokeReplacePaintOptions): SvgStrokePaint {
  const id = uniqueStrokeGradientId(options.preferredId, options.existingIds);
  return svgStrokePaint({ ...options, id });
}

/**
 * Insert a `<defs>…</defs>` block right after the `<svg …>` open tag.
 * Returns `svgText` unchanged when `defsMarkup` is empty or when no `<svg>`
 * open tag is found (fail-closed: never prepend markup to a non-SVG string).
 * A second top-level `<defs>` block is valid SVG, so no merge into an
 * existing `<defs>` is attempted (keeps this pure and non-destructive).
 */
export function insertStrokeDefsIntoSvg(svgText: string, defsMarkup: string): string {
  if (!defsMarkup) return svgText;
  const match = /<svg\b[^>]*>/i.exec(svgText);
  if (!match || match.index === undefined) return svgText;
  const at = match.index + match[0].length;
  return `${svgText.slice(0, at)}${defsMarkup}${svgText.slice(at)}`;
}

const gradientElementPattern = /<(linearGradient|radialGradient)\b[^>]*>[\s\S]*?<\/\1>|<(linearGradient|radialGradient)\b[^>]*\/>/gi;

function gradientElementId(tag: string): string | undefined {
  const match = /\bid\s*=\s*("([^"]*)"|'([^']*)')/.exec(tag.slice(0, tag.indexOf('>') + 1));
  const value = match ? (match[2] ?? match[3] ?? '') : '';
  return value || undefined;
}

/**
 * Remove the `<linearGradient>` / `<radialGradient>` element(s) whose `id`
 * exactly equals `id`. Other gradients (including ids that merely share a
 * prefix, e.g. fill's `g1` vs stroke's `g1-stroke`) are left byte-identical.
 * A `<defs>` block left empty/whitespace-only by the removal is dropped as
 * well; non-empty `<defs>` and every other part of the document pass
 * through untouched. Returns the input unchanged when `id` is empty.
 */
export function removeGradientDefsById(svgText: string, id: string): string {
  if (!id) return svgText;
  gradientElementPattern.lastIndex = 0;
  let next = svgText;
  let match: RegExpExecArray | null;
  // Collect first (regex is global/sticky across calls), then splice back to
  // front so indices stay valid.
  const hits: Array<{ start: number; end: number }> = [];
  while ((match = gradientElementPattern.exec(svgText)) !== null) {
    const tag = match[0];
    if (gradientElementId(tag) === id) {
      hits.push({ start: match.index, end: match.index + tag.length });
    }
    // Guard against zero-length matches stalling the scan.
    if (tag.length === 0) gradientElementPattern.lastIndex += 1;
  }
  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const hit = hits[index]!;
    next = `${next.slice(0, hit.start)}${next.slice(hit.end)}`;
  }
  if (hits.length === 0) return svgText;
  // Drop `<defs>` blocks emptied by the removal (whitespace-only counts as
  // empty); blocks that still hold other gradients/children are preserved.
  next = next.replace(/<defs\b[^>]*>\s*<\/defs\s*>/gi, '');
  next = next.replace(/<defs\b[^>]*\/>/gi, '');
  return next;
}

/** True when `url(#id)` (exact id) is still referenced anywhere in the text. */
export function isGradientIdReferenced(svgText: string, id: string): boolean {
  if (!id) return false;
  return new RegExp(`url\\(\\s*['"]?#${escapeRegExp(id)}(?![A-Za-z0-9\\-_.:])['"]?\\s*\\)`).test(svgText);
}

/**
 * Drop the old stroke gradient definition after replacement, but only when
 * nothing references it anymore. Fill gradients, other stroke gradients, and
 * still-referenced defs are never removed: when `url(#oldId)` remains (e.g.
 * another element still uses it), the input is returned unchanged.
 */
export function pruneUnreferencedStrokeGradient(svgText: string, oldId: string): string {
  if (!oldId) return svgText;
  if (isGradientIdReferenced(svgText, oldId)) return svgText;
  return removeGradientDefsById(svgText, oldId);
}
