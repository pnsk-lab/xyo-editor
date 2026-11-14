// Vector selection-style helpers: safe read + MIXED summary + selective patch.
//
// Observed scratch-paint behavior (reimplemented from behavior notes, no
// upstream source copied):
// - Fill and stroke keep independent primary/secondary colors plus an
//   independent gradient kind (solid / horizontal / vertical / radial). Each
//   side stores a CSS color string or `null` for transparent. A multi-item
//   selection with differing values shows a MIXED indicator instead of a
//   concrete value. A stroke width of 0 reads back as transparent with no
//   displayed gradient. Gradients with a transparent end reuse the surviving
//   end's RGB with alpha 0 (opacity-only fade, never through black).
// - Changing one paint field applies only that field: untouched fields keep
//   their per-item values, so a mixed fill is never flattened by a
//   stroke-width change. Changing a gradient stop preserves the item's own
//   gradient kind; changing the gradient kind preserves the item's own colors
//   (a solid-to-gradient upgrade picks up the current secondary color).
//
// Current editor gap (`Editor.svelte`, `BitmapEditor.svelte`):
// - The toolbar holds global `paintColor` / `secondaryPaintColor` /
//   `paintGradient` / `strokeColor` / `strokeSecondaryColor` /
//   `strokeGradient` / `strokeWidth` / `vectorOpacity` and the visible
//   "Apply fill and stroke" rewrites *every* selected element's
//   fill/stroke/width/opacity at once, so touching one control flattens mixed
//   values the user never edited. Selection changes never rewrite the artwork
//   (good), but the toolbar keeps showing the last global values with no MIXED
//   indication, so the user cannot tell what is mixed.
//
// This module is the UI-independent core for that gap: read-only parsing of
// one element's paint (never mutates the document), a cross-item summary that
// collapses disagreements to the MIXED sentinel, and a per-element patch merge
// that overlays only explicitly-changed fields. DOM, Paper.js, Svelte, and
// gradient-id minting stay with callers so `bun test` can exercise everything
// with lightweight stubs.

import {
  PAINT_MIXED,
  parsePaintColor,
  type PaintColor,
  type PaintGradientKind,
  type PaintRgba,
} from './paint-colors';
import {
  vectorStrokeSvgToUi,
  vectorTextUiForSvgElement,
} from './vector-stroke-scale';
import { EXPLICIT_VECTOR_GROUP_CLASS } from './vector-svg';

export { PAINT_MIXED };
export type SelectionMixed = typeof PAINT_MIXED;

/** `true` when the summary value is the MIXED sentinel. */
export function isMixedSelectionValue(value: unknown): value is SelectionMixed {
  return value === PAINT_MIXED;
}

/** Minimal attribute surface: real `Element` and test stubs both qualify. */
export type SelectionStyleElement = {
  getAttribute(name: string): string | null;
  getElementsByTagName?(tag: string): ArrayLike<{ getAttribute(name: string): string | null }>;
  /** Present on real DOM nodes: enables parent-chain inheritance walks. */
  parentElement?: SelectionStyleElement | null;
  /** Fallback parent link for lightweight stubs (`parentNode`). */
  parentNode?: SelectionStyleElement | null;
  tagName?: string;
  nodeName?: string;
};

/** Resolved gradient definition for one `url(#id)` reference. */
export type SelectionGradientDef = {
  /** `linearGradient` or `radialGradient` (anything else is unknown). */
  tag: string;
  x1: string | null;
  y1: string | null;
  x2: string | null;
  y2: string | null;
  stops: Array<{ color: string | null; opacity: string | null }>;
};

export type VectorElementPaint = {
  /** First fill color. `null` = transparent. */
  fill: PaintColor;
  /** Gradient end color. `null` = solid (no second color) or transparent end. */
  fillSecondary: PaintColor | null;
  fillGradient: PaintGradientKind;
  /** First stroke color. `null` = transparent (includes width-0 gate). */
  stroke: PaintColor;
  /** Stroke gradient end. `null` = solid / transparent end. */
  strokeSecondary: PaintColor | null;
  strokeGradient: PaintGradientKind;
  /** Toolbar UI width (Paper units: SVG `*2`, text `*2` simple else verbatim). `0` when the stroke paints nothing. */
  strokeWidth: number;
  /** Effective opacity as 0-100. */
  opacity: number;
};

export type VectorSelectionSummary = {
  fill: PaintColor | SelectionMixed;
  fillSecondary: PaintColor | null | SelectionMixed;
  fillGradient: PaintGradientKind | SelectionMixed;
  stroke: PaintColor | SelectionMixed;
  strokeSecondary: PaintColor | null | SelectionMixed;
  strokeGradient: PaintGradientKind | SelectionMixed;
  strokeWidth: number | SelectionMixed;
  opacity: number | SelectionMixed;
};

export type VectorStylePatch = {
  fill?: PaintColor;
  fillSecondary?: PaintColor | null;
  fillGradient?: PaintGradientKind;
  stroke?: PaintColor;
  strokeSecondary?: PaintColor | null;
  strokeGradient?: PaintGradientKind;
  strokeWidth?: number;
  opacity?: number;
};

const GRADIENT_KINDS: readonly PaintGradientKind[] = ['solid', 'horizontal', 'vertical', 'radial'];

export function isGradientKind(value: unknown): value is PaintGradientKind {
  return typeof value === 'string' && (GRADIENT_KINDS as readonly string[]).includes(value);
}

function normalizeRgba(color: PaintRgba): PaintRgba {
  const clamp = (v: number) => {
    const r = Math.round(v);
    if (!Number.isFinite(r)) return 0;
    if (r < 0) return 0;
    if (r > 255) return 255;
    return r;
  };
  return { r: clamp(color.r), g: clamp(color.g), b: clamp(color.b), a: clamp(color.a) };
}

function paintEquals(left: PaintColor, right: PaintColor): boolean {
  if (left === null || right === null) return left === null && right === null;
  const a = normalizeRgba(left);
  const b = normalizeRgba(right);
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/**
 * Parse `url(#id)` with an optional paint fallback (`url(#id) red`,
 * `url(#id) none`). The match is anchored: the whole value must be a single
 * local fragment reference plus at most one fallback token. Values that
 * merely contain a `url(` substring (`myurl(#g)`, external
 * `url(http://…)`, …) are NOT gradient references — callers must treat them
 * as unknown (fail-closed) instead of extracting a plausible-looking id. A
 * second `url()` token parses as a fallback which then fails closed to MIXED
 * (it is not a usable solid color).
 */
const ANCHORED_PAINT_URL_PATTERN =
  /^[Uu][Rr][Ll]\(\s*['"]?#([^'")\s]+)['"]?\s*\)(?:\s+(.+))?$/;

export type PaintWithFallback =
  | { kind: 'color'; color: PaintColor }
  | { kind: 'gradient'; id: string; fallback: string | undefined }
  | { kind: 'unknown' };

export function parsePaintWithFallback(value: string | null | undefined): PaintWithFallback {
  if (value === null || value === undefined) return { kind: 'unknown' };
  const trimmed = value.trim();
  if (!trimmed) return { kind: 'color', color: null };
  if (isNonePaint(trimmed)) return { kind: 'color', color: null };
  const urlMatch = ANCHORED_PAINT_URL_PATTERN.exec(trimmed);
  if (urlMatch) {
    return { kind: 'gradient', id: urlMatch[1]!, fallback: urlMatch[2]?.trim() || undefined };
  }
  // A `url(` substring that is not the whole value (external url, multiple
  // refs, function wrappers) is unresolvable: never partially extract an id.
  if (/[Uu][Rr][Ll]\s*\(/.test(trimmed)) return { kind: 'unknown' };
  const parsed = parsePaintColor(trimmed);
  if (parsed === undefined) return { kind: 'unknown' };
  return { kind: 'color', color: parsed ?? null };
}

/** Parse `url(#id)` (optional quotes/whitespace); anything else is not a ref. */
export function extractPaintGradientId(ref: string | null | undefined): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const match = ANCHORED_PAINT_URL_PATTERN.exec(trimmed);
  return match ? match[1] : undefined;
}

function isNonePaint(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const text = value.trim().toLowerCase();
  return text === 'none' || text === 'transparent' || text === '';
}

/**
 * Parse a solid `fill`/`stroke` attribute to a `PaintColor`.
 * Returns `{ kind: 'color', color }` for concrete paints (including `null`
 * for `none`/`transparent`), `{ kind: 'gradient', id }` for `url(#id)`, and
 * `{ kind: 'unknown' }` for missing/unsupported values so callers can fall
 * back to MIXED instead of guessing (fail-closed: never invent a color).
 */
export function parseSolidPaintAttribute(value: string | null | undefined):
  | { kind: 'color'; color: PaintColor }
  | { kind: 'gradient'; id: string }
  | { kind: 'unknown' } {
  if (value === null || value === undefined) return { kind: 'unknown' };
  const trimmed = value.trim();
  if (!trimmed) return { kind: 'color', color: null };
  if (isNonePaint(trimmed)) return { kind: 'color', color: null };
  const gradientId = extractPaintGradientId(trimmed);
  if (gradientId !== undefined) return { kind: 'gradient', id: gradientId };
  const parsed = parsePaintColor(trimmed);
  if (parsed === undefined) {
    // Named CSS colors (`red`, `cornflowerblue`), `currentColor`, `inherit`,
    // `style="..."` indirection, and other exotic forms: report unknown so
    // the summary shows MIXED and selective apply leaves them untouched.
    return { kind: 'unknown' };
  }
  return { kind: 'color', color: parsed ?? null };
}

/**
 * Parse an inline `style="…"` attribute into property → value (lowercased
 * property names, `!important` stripped, last declaration wins). Never throws.
 */
export function parseStyleDeclarations(style: string | null | undefined): Map<string, string> {
  const declarations = new Map<string, string>();
  if (typeof style !== 'string' || !style) return declarations;
  try {
    for (const part of style.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const property = part.slice(0, colon).trim().toLowerCase();
      if (!property) continue;
      let value = part.slice(colon + 1).trim();
      if (!value) continue;
      value = value.replace(/\s*!important\s*$/i, '').trim();
      if (!value) continue;
      declarations.set(property, value);
    }
  } catch {
    // Fail-closed: return what parsed so far.
  }
  return declarations;
}

function getParentStyleElement(element: SelectionStyleElement): SelectionStyleElement | null {
  try {
    const candidate =
      (element as { parentElement?: unknown }).parentElement ??
      (element as { parentNode?: unknown }).parentNode ??
      null;
    if (!candidate || typeof (candidate as SelectionStyleElement).getAttribute !== 'function') return null;
    return candidate as SelectionStyleElement;
  } catch {
    return null;
  }
}

function readOwnStyleProperty(element: SelectionStyleElement, property: string): string | undefined {
  try {
    const declarations = parseStyleDeclarations(element.getAttribute('style'));
    const value = declarations.get(property);
    return value === undefined || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

function hasOwnClass(element: SelectionStyleElement): boolean {
  try {
    const value = element.getAttribute('class');
    if (value === null || value.trim() === '') return false;
    // The explicit-group token is inert (no stylesheet survives the
    // sanitizers, and no page rule targets it), so it must not force MIXED
    // paint: only other classes keep the fail-closed unknown behavior.
    const rest = value
      .split(/[\s\u0000-\u0020]+/)
      .filter((token) => token.length > 0 && token !== EXPLICIT_VECTOR_GROUP_CLASS);
    return rest.length > 0;
  } catch {
    return false;
  }
}

function isInheritKeyword(value: string): boolean {
  return value.trim().toLowerCase() === 'inherit';
}

export type InheritedPaintValue =
  | { status: 'value'; value: string }
  | { status: 'missing' }
  | { status: 'unknown' };

/**
 * Resolve one inheritable presentation property (`fill`, `stroke`,
 * `fill-opacity`, `stroke-opacity`, `stroke-width`, `opacity`, …) for an
 * element with CSS-cascade fidelity limited to what the sanitized document
 * carries:
 *
 * - inline `style` beats the presentation attribute on the same node;
 * - the first definition walking self → ancestors wins (inheritance);
 * - `inherit` continues the walk;
 * - a `class` attribute anywhere on the walked path that could supply the
 *   property makes the result `unknown` (fail-closed: page/document CSS is
 *   not visible to this parser, so guessing the attribute value would
 *   misread the rendered paint as black/transparent).
 */
export function resolveInheritedPaintValue(
  element: SelectionStyleElement,
  property: string,
): InheritedPaintValue {
  const name = property.trim().toLowerCase();
  let node: SelectionStyleElement | null = element;
  while (node) {
    const styleValue = readOwnStyleProperty(node, name);
    if (styleValue !== undefined) {
      if (isInheritKeyword(styleValue)) {
        node = getParentStyleElement(node);
        continue;
      }
      return { status: 'value', value: styleValue };
    }
    let attribute: string | null = null;
    try {
      attribute = node.getAttribute(name);
    } catch {
      attribute = null;
    }
    const classy = hasOwnClass(node);
    if (attribute !== null && attribute.trim() !== '' && !isInheritKeyword(attribute)) {
      // A class rule beats a presentation attribute, so an attribute value on
      // a classed node is not the rendered value.
      if (classy) return { status: 'unknown' };
      return { status: 'value', value: attribute };
    }
    if (attribute !== null && isInheritKeyword(attribute)) {
      node = getParentStyleElement(node);
      continue;
    }
    // No usable declaration here: a class on this node may still paint it via
    // CSS (including overriding inherited values), so the value is unknown.
    if (classy) return { status: 'unknown' };
    node = getParentStyleElement(node);
  }
  return { status: 'missing' };
}

export type EffectiveOpacityValue = { status: 'value'; factor: number } | { status: 'unknown' };

function parseOpacityFactorText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.endsWith('%')) {
    const percent = Number(trimmed.slice(0, -1));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
    return percent / 100;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return undefined;
  return parsed;
}

/**
 * Effective `opacity` multiplier: the product of every `opacity` in the
 * ancestor chain (group opacity multiplies in rendering, unlike the inherited
 * paint properties which take the nearest definition). Any class-controlled
 * or unparsable step fails the whole factor closed to `unknown`.
 */
export function resolveEffectiveOpacityFactor(element: SelectionStyleElement): EffectiveOpacityValue {
  let factor = 1;
  let node: SelectionStyleElement | null = element;
  while (node) {
    const styleValue = readOwnStyleProperty(node, 'opacity');
    if (styleValue !== undefined) {
      if (!isInheritKeyword(styleValue)) {
        const parsed = parseOpacityFactorText(styleValue);
        if (parsed === undefined) return { status: 'unknown' };
        factor *= parsed;
      }
    } else {
      let attribute: string | null = null;
      try {
        attribute = node.getAttribute('opacity');
      } catch {
        attribute = null;
      }
      if (attribute !== null && attribute.trim() !== '') {
        if (isInheritKeyword(attribute)) {
          // Explicit inherit: no local multiplier, ancestors still apply.
        } else {
          const parsed = parseOpacityFactorText(attribute);
          if (parsed === undefined) return { status: 'unknown' };
          factor *= parsed;
        }
      } else if (hasOwnClass(node)) {
        // A class may set opacity on this node/group; the product is unknown.
        return { status: 'unknown' };
      }
    }
    node = getParentStyleElement(node);
  }
  return { status: 'value', factor };
}

function parseWidthValueText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const withoutUnit = /px$/i.test(trimmed) ? trimmed.slice(0, -2).trim() : trimmed;
  if (!withoutUnit) return undefined;
  const parsed = Number(withoutUnit);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function applyOpacityFactorToColor(color: PaintColor, factor: number): PaintColor {
  if (color === null) return null;
  const alpha = Math.round(normalizeRgba(color).a * factor);
  if (alpha <= 0) return null;
  const normalized = normalizeRgba(color);
  return { r: normalized.r, g: normalized.g, b: normalized.b, a: Math.min(255, alpha) };
}

function parseStopAlpha(opacity: string | null): number | undefined {
  if (opacity === null) return 1;
  const trimmed = opacity.trim();
  if (!trimmed) return 1;
  // Percentages (`50%`) and unit fractions (`0.5`) both occur in the wild.
  if (trimmed.endsWith('%')) {
    const percent = Number(trimmed.slice(0, -1));
    if (!Number.isFinite(percent)) return undefined;
    return Math.max(0, Math.min(1, percent / 100));
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
}

function parseStopColor(color: string | null, opacity: string | null): PaintColor | SelectionMixed {
  const base = parseSolidPaintAttribute(color);
  if (base.kind !== 'color') return PAINT_MIXED;
  const alpha = parseStopAlpha(opacity);
  if (alpha === undefined) return PAINT_MIXED;
  if (base.color === null) {
    // `stop-color="none"` is degenerate; treat a zero-opacity stop as
    // transparent and anything else as unknown (MIXED, fail-closed).
    return alpha === 0 ? null : PAINT_MIXED;
  }
  const normalized = normalizeRgba(base.color);
  const a = Math.round(alpha * 255);
  if (a === 0) return null;
  return { r: normalized.r, g: normalized.g, b: normalized.b, a };
}

function parseGradientCoord(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  // Percentages (`0%`/`100%` from objectBoundingBox output and the live
  // preview) normalize to 0-1; plain numbers (userSpaceOnUse or 0-1 box
  // fractions) compare as-is. Unparsable values stay undefined so the
  // missing-coordinate fallback applies instead of misreading direction.
  if (text.endsWith('%')) {
    const value = Number(text.slice(0, -1));
    return Number.isFinite(value) ? value / 100 : undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function gradientKindFromDef(def: SelectionGradientDef): PaintGradientKind | SelectionMixed {
  const tag = def.tag.toLowerCase();
  if (tag === 'radialgradient') return 'radial';
  if (tag !== 'lineargradient') return PAINT_MIXED;
  // New editor output is per-object `objectBoundingBox` percentages
  // (`x2="100%"` horizontal, `y2="100%"` vertical); imported artwork keeps
  // `userSpaceOnUse` numbers (`x2="480"`) or unit fractions (`x2="1"`).
  // A linear ramp that only varies along y is vertical, everything else
  // reads as horizontal (same convention as the reference behavior notes).
  // Missing coordinates fall back to the SVG default (horizontal), matching
  // `<linearGradient>` without explicit vectors.
  const x1 = parseGradientCoord(def.x1);
  const x2 = parseGradientCoord(def.x2);
  const y1 = parseGradientCoord(def.y1);
  const y2 = parseGradientCoord(def.y2);
  const xVaries = x1 !== undefined && x2 !== undefined ? Math.abs(x2 - x1) > 1e-9 : true;
  const yVaries = y1 !== undefined && y2 !== undefined ? Math.abs(y2 - y1) > 1e-9 : false;
  if (!xVaries && yVaries) return 'vertical';
  return 'horizontal';
}

export type ElementPaintSide = {
  primary: PaintColor | SelectionMixed;
  secondary: PaintColor | null | SelectionMixed;
  gradient: PaintGradientKind | SelectionMixed;
};

function resolveFallbackSolidColor(
  fallback: string | undefined,
  opacityFactor: number,
): PaintColor | SelectionMixed | undefined {
  if (fallback === undefined) return undefined;
  const parsed = parsePaintWithFallback(fallback);
  // A fallback that is itself a gradient/url is not a usable solid color.
  if (parsed.kind !== 'color') return PAINT_MIXED;
  return applyOpacityFactorToColor(parsed.color, opacityFactor);
}

function readPaintSide(
  raw: InheritedPaintValue,
  opacityRaw: InheritedPaintValue,
  missingFallback: PaintColor,
  resolveGradient: (id: string) => SelectionGradientDef | undefined,
): ElementPaintSide {
  if (raw.status === 'unknown' || opacityRaw.status === 'unknown') {
    return { primary: PAINT_MIXED, secondary: PAINT_MIXED, gradient: PAINT_MIXED };
  }
  let opacityFactor = 1;
  if (opacityRaw.status === 'value') {
    const parsed = parseOpacityFactorText(opacityRaw.value);
    if (parsed === undefined) {
      return { primary: PAINT_MIXED, secondary: PAINT_MIXED, gradient: PAINT_MIXED };
    }
    opacityFactor = parsed;
  }
  if (raw.status === 'missing') {
    return {
      primary: applyOpacityFactorToColor(missingFallback, opacityFactor),
      secondary: null,
      gradient: 'solid',
    };
  }
  const parsed = parsePaintWithFallback(raw.value);
  if (parsed.kind === 'color') {
    return {
      primary: applyOpacityFactorToColor(parsed.color, opacityFactor),
      secondary: null,
      gradient: 'solid',
    };
  }
  if (parsed.kind === 'unknown') return { primary: PAINT_MIXED, secondary: PAINT_MIXED, gradient: PAINT_MIXED };
  const def = resolveGradient(parsed.id);
  if (!def) {
    // Local fallback (`url(#missing) red`): use the concrete fallback solid
    // so a deleted gradient still reads as its authored fallback color.
    // Without a fallback (or with an unparsable one) stay MIXED.
    const fallbackColor = resolveFallbackSolidColor(parsed.fallback, opacityFactor);
    if (fallbackColor === undefined) {
      return { primary: PAINT_MIXED, secondary: PAINT_MIXED, gradient: PAINT_MIXED };
    }
    if (isMixedSelectionValue(fallbackColor)) {
      return { primary: PAINT_MIXED, secondary: PAINT_MIXED, gradient: PAINT_MIXED };
    }
    return { primary: fallbackColor, secondary: null, gradient: 'solid' };
  }
  if (def.stops.length !== 2) {
    // The reference treats non-2-stop ramps as MIXED on both ends; mirror
    // that (fail-closed) instead of sampling an arbitrary stop.
    return { primary: PAINT_MIXED, secondary: PAINT_MIXED, gradient: PAINT_MIXED };
  }
  const first = parseStopColor(def.stops[0]?.color ?? null, def.stops[0]?.opacity ?? null);
  const second = parseStopColor(def.stops[1]?.color ?? null, def.stops[1]?.opacity ?? null);
  if (isMixedSelectionValue(first) || isMixedSelectionValue(second)) {
    return { primary: PAINT_MIXED, secondary: PAINT_MIXED, gradient: PAINT_MIXED };
  }
  const kind = gradientKindFromDef(def);
  if (isMixedSelectionValue(kind)) return { primary: PAINT_MIXED, secondary: PAINT_MIXED, gradient: PAINT_MIXED };
  return {
    primary: applyOpacityFactorToColor(first, opacityFactor),
    secondary: second === null ? null : applyOpacityFactorToColor(second, opacityFactor),
    gradient: kind,
  };
}

/** Per-element paint where every field may independently be MIXED (fail-closed). */
export type DetailedVectorElementPaint = {
  fill: PaintColor | SelectionMixed;
  fillSecondary: PaintColor | null | SelectionMixed;
  fillGradient: PaintGradientKind | SelectionMixed;
  stroke: PaintColor | SelectionMixed;
  strokeSecondary: PaintColor | null | SelectionMixed;
  strokeGradient: PaintGradientKind | SelectionMixed;
  strokeWidth: number | SelectionMixed;
  opacity: number | SelectionMixed;
};

/** `true` when any field of a detailed paint is MIXED (some side is unknown). */
export function isDetailedPaintUnknown(paint: DetailedVectorElementPaint): boolean {
  return (
    isMixedSelectionValue(paint.fill) ||
    isMixedSelectionValue(paint.fillSecondary) ||
    isMixedSelectionValue(paint.fillGradient) ||
    isMixedSelectionValue(paint.stroke) ||
    isMixedSelectionValue(paint.strokeSecondary) ||
    isMixedSelectionValue(paint.strokeGradient) ||
    isMixedSelectionValue(paint.strokeWidth) ||
    isMixedSelectionValue(paint.opacity)
  );
}

export function isDetailedFillSideUnknown(paint: DetailedVectorElementPaint): boolean {
  return (
    isMixedSelectionValue(paint.fill) ||
    isMixedSelectionValue(paint.fillSecondary) ||
    isMixedSelectionValue(paint.fillGradient)
  );
}

export function isDetailedStrokeSideUnknown(paint: DetailedVectorElementPaint): boolean {
  return (
    isMixedSelectionValue(paint.stroke) ||
    isMixedSelectionValue(paint.strokeSecondary) ||
    isMixedSelectionValue(paint.strokeGradient)
  );
}

function elementTagName(element: SelectionStyleElement): string {
  try {
    const tag = (element.tagName ?? element.nodeName ?? '').toString().toLowerCase();
    return tag;
  } catch {
    return '';
  }
}

function uiWidthForTag(svgWidth: number, tag: string, element?: SelectionStyleElement): number {
  if (!(svgWidth > 0)) return 0;
  // Text stores `UI/2` on a simple scale-1 chain (inverse `*2`); scaled or
  // complex text (`scale(0.5)` Scratch bytes, skew/matrix, style transform,
  // scaled ancestors) protects to verbatim (Scratch Paper-local parity, so
  // `<text stroke-width="4" transform="scale(0.5)">` reads UI `4`, not `8`).
  // All other shapes store `UI/2`, inverse `*2`. Width 0 stays 0 (gate).
  if (tag === 'text') return vectorTextUiForSvgElement(svgWidth, element);
  return vectorStrokeSvgToUi(svgWidth);
}

/**
 * Toolbar UI width for one selectable unit (SVG `*2`, text `*2` on a simple
 * chain else verbatim protection).
 *
 * Scratch parity: stored SVG bytes are Paper/2, Paper shows UI verbatim, so
 * selecting stored `5` shows UI `10`. Imported bytes are preserved until the
 * user edits; this read never rewrites. For non-text, ancestor `transform`
 * scales are deliberately NOT folded in (Scratch reads `item.strokeWidth`,
 * the local Paper value, not the world-scaled pixel width), so a scaled group
 * does not double-count geometry: pixel width = SVG * worldScale,
 * toolbar = SVG * 2. For text the same local-read rule means Scratch bytes
 * with `scale(0.5)` read verbatim (UI `4` for SVG `4`); only a provably
 * scale-1 chain (no/scale(1)/translate/rotate, self + ancestors, no style
 * transform) uses `*2`, otherwise verbatim protection (no forced conversion).
 * `transparent` (width 0) and `stroke="url(#…)"` gradients ride the same path
 * as solids — only the width number is scaled. Unresolvable style/class
 * stays MIXED fail-closed.
 *
 * Groups: when the unit is a `<g>` with explicit descendant widths that
 * disagree, the group reads MIXED (children would otherwise be hidden behind
 * the group's own inherited value). A single consensus (or no explicit
 * descendant width) falls back to the group's own inherited UI width.
 */
export function readEffectiveStrokeWidth(element: SelectionStyleElement): number | SelectionMixed {
  const tag = elementTagName(element);
  if (tag === 'g') {
    const grouped = groupDescendantUiWidth(element);
    if (grouped !== undefined) return grouped;
  }
  const raw = resolveInheritedPaintValue(element, 'stroke-width');
  if (raw.status === 'unknown') return PAINT_MIXED;
  if (raw.status === 'missing') return uiWidthForTag(1, tag, element);
  const parsed = parseWidthValueText(raw.value);
  if (parsed === undefined) return PAINT_MIXED;
  return uiWidthForTag(parsed, tag, element);
}

function ownStrokeSvgWidth(child: { getAttribute(name: string): string | null }): number | undefined {
  try {
    const style = child.getAttribute('style');
    if (typeof style === 'string' && style) {
      const declarations = parseStyleDeclarations(style);
      const inline = declarations.get('stroke-width');
      if (inline !== undefined && inline !== '') {
        const parsed = parseWidthValueText(inline);
        if (parsed !== undefined) return parsed;
      }
    }
  } catch {}
  try {
    const attr = child.getAttribute('stroke-width');
    if (attr !== null && attr.trim() !== '') {
      const parsed = parseWidthValueText(attr.trim());
      if (parsed !== undefined) return parsed;
    }
  } catch {}
  return undefined;
}

function groupDescendantUiWidth(element: SelectionStyleElement): number | SelectionMixed | undefined {
  try {
    const getter = element.getElementsByTagName;
    if (typeof getter !== 'function') return undefined;
    const seen = new Set<number>();
    const collect = (list: ArrayLike<{ getAttribute(name: string): string | null; tagName?: string; nodeName?: string; parentElement?: unknown; parentNode?: unknown }>) => {
      for (let index = 0; index < list.length; index += 1) {
        const child = list[index];
        if (!child || child === (element as unknown)) continue;
        const childTag = (() => {
          try {
            return ((child as { tagName?: unknown }).tagName ?? (child as { nodeName?: unknown }).nodeName ?? '').toString().toLowerCase();
          } catch {
            return '';
          }
        })();
        if (childTag === 'defs' || childTag === 'lineargradient' || childTag === 'radialgradient' || childTag === 'metadata' || childTag === 'title' || childTag === 'desc') continue;
        const svg = ownStrokeSvgWidth(child);
        if (svg === undefined) continue;
        const ui = uiWidthForTag(svg, childTag, child as unknown as SelectionStyleElement);
        let dup = false;
        for (const prior of seen) {
          if (Math.abs(prior - ui) < 1e-9) {
            dup = true;
            break;
          }
        }
        if (!dup) seen.add(ui);
        if (seen.size > 1) return PAINT_MIXED as unknown as undefined;
      }
      return undefined;
    };
    // Real DOM supports `*`; lightweight stubs may only implement named tags.
    let list: ArrayLike<{ getAttribute(name: string): string | null }> | undefined;
    try {
      list = getter.call(element, '*') as unknown as ArrayLike<{ getAttribute(name: string): string | null }>;
    } catch {
      list = undefined;
    }
    if (list && typeof list.length === 'number' && list.length > 0) {
      const result = collect(list as ArrayLike<{ getAttribute(name: string): string | null; tagName?: string; nodeName?: string }>);
      if (result !== undefined) return result as unknown as number | SelectionMixed;
      if (seen.size > 1) return PAINT_MIXED;
      if (seen.size === 1) return [...seen][0]!;
      return undefined;
    }
    for (const name of ['rect', 'ellipse', 'circle', 'path', 'line', 'polyline', 'polygon', 'text', 'g', 'use', 'image']) {
      let named: ArrayLike<{ getAttribute(name: string): string | null }> | undefined;
      try {
        named = getter.call(element, name) as unknown as ArrayLike<{ getAttribute(name: string): string | null }>;
      } catch {
        continue;
      }
      if (!named || typeof named.length !== 'number' || named.length === 0) continue;
      const result = collect(named as ArrayLike<{ getAttribute(name: string): string | null; tagName?: string; nodeName?: string }>);
      if (result !== undefined) return result as unknown as number | SelectionMixed;
      if (seen.size > 1) return PAINT_MIXED;
    }
    if (seen.size > 1) return PAINT_MIXED;
    if (seen.size === 1) return [...seen][0]!;
    return undefined;
  } catch {
    return undefined;
  }
}

function readEffectiveOpacity(element: SelectionStyleElement): number | SelectionMixed {
  const resolved = resolveEffectiveOpacityFactor(element);
  if (resolved.status === 'unknown') return PAINT_MIXED;
  return Math.round(resolved.factor * 1000) / 10;
}

/**
 * Read one selectable unit's effective paint field-by-field without touching
 * the document. Resolution order per property: inline `style` beats the
 * presentation attribute on the same node; the nearest definition walking
 * self → ancestors wins; `class` without a resolvable declaration fails that
 * field closed to MIXED (CSS is invisible here, so the attribute value must
 * not be mistaken for the rendered paint). `fill-opacity` folds into the
 * fill alpha, `stroke-opacity` into the stroke alpha, and ancestor `opacity`
 * multiplies into `opacity`. Missing `fill` defaults to opaque black (SVG
 * default); missing `stroke` to transparent; missing `stroke-width` to UI 2
 * (SVG 1 `*2`, text simple `*2` else verbatim `1`); missing `opacity` to 100. `strokeWidth` is always
 * toolbar UI units (SVG `*2`, text `*2` simple else verbatim) so the toolbar displays it verbatim.
 * A non-positive stroke width gates the stroke side to transparent/solid
 * (width-0 rule); the width itself still reads 0.
 */
export function readVectorElementPaintDetailed(
  element: SelectionStyleElement,
  resolveGradient: (id: string) => SelectionGradientDef | undefined,
): DetailedVectorElementPaint {
  const fillRaw = resolveInheritedPaintValue(element, 'fill');
  const fillOpacityRaw = resolveInheritedPaintValue(element, 'fill-opacity');
  const strokeRaw = resolveInheritedPaintValue(element, 'stroke');
  const strokeOpacityRaw = resolveInheritedPaintValue(element, 'stroke-opacity');
  const fillSide = readPaintSide(fillRaw, fillOpacityRaw, { r: 0, g: 0, b: 0, a: 255 }, resolveGradient);
  const strokeSide = readPaintSide(strokeRaw, strokeOpacityRaw, null, resolveGradient);
  const width = readEffectiveStrokeWidth(element);
  const opacity = readEffectiveOpacity(element);
  if (!isMixedSelectionValue(width) && !(width > 0)) {
    return {
      fill: fillSide.primary,
      fillSecondary: fillSide.secondary,
      fillGradient: fillSide.gradient,
      stroke: null,
      strokeSecondary: null,
      strokeGradient: 'solid',
      strokeWidth: 0,
      opacity,
    };
  }
  return {
    fill: fillSide.primary,
    fillSecondary: fillSide.secondary,
    fillGradient: fillSide.gradient,
    stroke: strokeSide.primary,
    strokeSecondary: strokeSide.secondary,
    strokeGradient: strokeSide.gradient,
    strokeWidth: width,
    opacity,
  };
}

/**
 * Reduce per-element detailed paints to one summary. An empty selection
 * yields all MIXED. Each field collapses independently: any element whose own
 * field is MIXED (unresolvable style/class/inheritance/opacity/fallback)
 * poisons only that field, so a concrete stroke stays editable while an
 * unknown fill shows MIXED and is skipped by selective apply. Gradient-kind
 * disagreement additionally poisons both colors of that side (a solid red
 * and a red ramp must not display a concrete shared primary).
 */
export function summarizeDetailedVectorElementPaints(
  paints: ReadonlyArray<DetailedVectorElementPaint>,
): VectorSelectionSummary {
  const mixed: VectorSelectionSummary = {
    fill: PAINT_MIXED,
    fillSecondary: PAINT_MIXED,
    fillGradient: PAINT_MIXED,
    stroke: PAINT_MIXED,
    strokeSecondary: PAINT_MIXED,
    strokeGradient: PAINT_MIXED,
    strokeWidth: PAINT_MIXED,
    opacity: PAINT_MIXED,
  };
  if (paints.length === 0) return mixed;
  const first = paints[0]!;
  let fill = first.fill;
  let fillSecondary = first.fillSecondary;
  let fillGradient = first.fillGradient;
  let stroke = first.stroke;
  let strokeSecondary = first.strokeSecondary;
  let strokeGradient = first.strokeGradient;
  let strokeWidth = first.strokeWidth;
  let opacity = first.opacity;
  let fillMixed = isMixedSelectionValue(fill);
  let fillSecondaryMixed = isMixedSelectionValue(fillSecondary);
  let fillGradientMixed = isMixedSelectionValue(fillGradient);
  let strokeMixed = isMixedSelectionValue(stroke);
  let strokeSecondaryMixed = isMixedSelectionValue(strokeSecondary);
  let strokeGradientMixed = isMixedSelectionValue(strokeGradient);
  let strokeWidthMixed = isMixedSelectionValue(strokeWidth);
  let opacityMixed = isMixedSelectionValue(opacity);
  for (let index = 1; index < paints.length; index += 1) {
    const next = paints[index]!;
    if (!fillMixed && (isMixedSelectionValue(next.fill) || !paintEquals(fill as PaintColor, next.fill as PaintColor))) {
      fillMixed = true;
      fill = PAINT_MIXED as unknown as PaintColor;
    }
    if (
      !fillSecondaryMixed &&
      (isMixedSelectionValue(next.fillSecondary) ||
        isMixedSelectionValue(fillSecondary) ||
        !secondaryEquals(fillSecondary as PaintColor | null, next.fillSecondary as PaintColor | null))
    ) {
      fillSecondaryMixed = true;
      fillSecondary = PAINT_MIXED as unknown as PaintColor | null;
    }
    if (!fillGradientMixed && (isMixedSelectionValue(next.fillGradient) || fillGradient !== next.fillGradient)) {
      fillGradientMixed = true;
      fillGradient = PAINT_MIXED as unknown as PaintGradientKind;
    }
    if (!strokeMixed && (isMixedSelectionValue(next.stroke) || !paintEquals(stroke as PaintColor, next.stroke as PaintColor))) {
      strokeMixed = true;
      stroke = PAINT_MIXED as unknown as PaintColor;
    }
    if (
      !strokeSecondaryMixed &&
      (isMixedSelectionValue(next.strokeSecondary) ||
        isMixedSelectionValue(strokeSecondary) ||
        !secondaryEquals(strokeSecondary as PaintColor | null, next.strokeSecondary as PaintColor | null))
    ) {
      strokeSecondaryMixed = true;
      strokeSecondary = PAINT_MIXED as unknown as PaintColor | null;
    }
    if (!strokeGradientMixed && (isMixedSelectionValue(next.strokeGradient) || strokeGradient !== next.strokeGradient)) {
      strokeGradientMixed = true;
      strokeGradient = PAINT_MIXED as unknown as PaintGradientKind;
    }
    if (!strokeWidthMixed && (isMixedSelectionValue(next.strokeWidth) || strokeWidth !== next.strokeWidth)) {
      strokeWidthMixed = true;
      strokeWidth = PAINT_MIXED as unknown as number;
    }
    if (!opacityMixed && (isMixedSelectionValue(next.opacity) || Math.abs((opacity as number) - (next.opacity as number)) > 1e-9)) {
      opacityMixed = true;
      opacity = PAINT_MIXED as unknown as number;
    }
  }
  if (fillGradientMixed) {
    fill = PAINT_MIXED as unknown as PaintColor;
    fillSecondary = PAINT_MIXED as unknown as PaintColor | null;
  }
  if (strokeGradientMixed) {
    stroke = PAINT_MIXED as unknown as PaintColor;
    strokeSecondary = PAINT_MIXED as unknown as PaintColor | null;
  }
  return {
    fill: fillMixed || fillGradientMixed ? PAINT_MIXED : fill,
    fillSecondary: fillSecondaryMixed || fillGradientMixed ? PAINT_MIXED : fillSecondary,
    fillGradient: fillGradientMixed ? PAINT_MIXED : fillGradient,
    stroke: strokeMixed || strokeGradientMixed ? PAINT_MIXED : stroke,
    strokeSecondary: strokeSecondaryMixed || strokeGradientMixed ? PAINT_MIXED : strokeSecondary,
    strokeGradient: strokeGradientMixed ? PAINT_MIXED : strokeGradient,
    strokeWidth: strokeWidthMixed ? PAINT_MIXED : strokeWidth,
    opacity: opacityMixed ? PAINT_MIXED : opacity,
  };
}

export type DetailedPatchSkipped = {
  fill: boolean;
  stroke: boolean;
  strokeWidth: boolean;
  opacity: boolean;
};

export type DetailedPatchResult = {
  fill: { primary: PaintColor; secondary: PaintColor | null; gradient: PaintGradientKind } | null;
  stroke:
    | { primary: PaintColor; secondary: PaintColor | null; gradient: PaintGradientKind; width: number }
    | null;
  strokeWidth: number | null;
  opacity: number | null;
  skipped: DetailedPatchSkipped;
};

/**
 * Merge an explicit user patch over one element's detailed paint. Fields left
 * `undefined` keep the element's own value; fields on an unknown (MIXED) side
 * are skipped (`skipped` flags) so selective apply never invents a color for
 * style/class/inheritance/opacity/fallback paints it could not resolve. The
 * width-0 gate is re-applied: a zero width always yields a transparent solid
 * stroke side.
 */
export function mergeDetailedPaintWithPatch(
  current: DetailedVectorElementPaint,
  patch: VectorStylePatch,
  fallbackSecondary?: { fill?: PaintColor | null; stroke?: PaintColor | null },
): DetailedPatchResult {
  const skipped: DetailedPatchSkipped = { fill: false, stroke: false, strokeWidth: false, opacity: false };
  const wantFill = patch.fill !== undefined || patch.fillSecondary !== undefined || patch.fillGradient !== undefined;
  const wantStroke =
    patch.stroke !== undefined || patch.strokeSecondary !== undefined || patch.strokeGradient !== undefined;
  const wantWidth = patch.strokeWidth !== undefined;
  const wantOpacity = patch.opacity !== undefined;

  let fill: DetailedPatchResult['fill'] = null;
  if (wantFill) {
    if (isDetailedFillSideUnknown(current)) {
      skipped.fill = true;
    } else {
      const currentFill = {
        primary: current.fill as PaintColor,
        secondary: current.fillSecondary as PaintColor | null,
        gradient: current.fillGradient as PaintGradientKind,
      };
      let nextGradient = patch.fillGradient !== undefined ? patch.fillGradient : currentFill.gradient;
      let nextSecondary = patch.fillSecondary !== undefined ? patch.fillSecondary : currentFill.secondary;
      const nextPrimary = patch.fill !== undefined ? patch.fill : currentFill.primary;
      if (nextGradient === 'solid') {
        nextSecondary = null;
      } else if (currentFill.gradient === 'solid' && patch.fillGradient !== undefined && patch.fillSecondary === undefined) {
        nextSecondary =
          fallbackSecondary?.fill !== undefined ? (fallbackSecondary.fill as PaintColor | null) : currentFill.secondary;
        if (nextSecondary === null && currentFill.secondary !== null) nextSecondary = currentFill.secondary;
      }
      fill = { primary: nextPrimary, secondary: nextGradient === 'solid' ? null : nextSecondary, gradient: nextGradient };
    }
  }

  const widthValue = wantWidth
    ? (patch.strokeWidth as number)
    : isMixedSelectionValue(current.strokeWidth)
      ? undefined
      : (current.strokeWidth as number);
  let stroke: DetailedPatchResult['stroke'] = null;
  if (wantStroke) {
    if (isDetailedStrokeSideUnknown(current) || widthValue === undefined) {
      skipped.stroke = true;
    } else {
      const currentStroke = {
        primary: current.stroke as PaintColor,
        secondary: current.strokeSecondary as PaintColor | null,
        gradient: current.strokeGradient as PaintGradientKind,
      };
      let nextGradient = patch.strokeGradient !== undefined ? patch.strokeGradient : currentStroke.gradient;
      let nextSecondary = patch.strokeSecondary !== undefined ? patch.strokeSecondary : currentStroke.secondary;
      const nextPrimary = patch.stroke !== undefined ? patch.stroke : currentStroke.primary;
      if (nextGradient === 'solid') {
        nextSecondary = null;
      } else if (
        currentStroke.gradient === 'solid' &&
        patch.strokeGradient !== undefined &&
        patch.strokeSecondary === undefined
      ) {
        nextSecondary =
          fallbackSecondary?.stroke !== undefined ? (fallbackSecondary.stroke as PaintColor | null) : currentStroke.secondary;
        if (nextSecondary === null && currentStroke.secondary !== null) nextSecondary = currentStroke.secondary;
      }
      if (!(widthValue > 0)) {
        stroke = { primary: null, secondary: null, gradient: 'solid', width: 0 };
      } else {
        stroke = {
          primary: nextPrimary,
          secondary: nextGradient === 'solid' ? null : nextSecondary,
          gradient: nextGradient,
          width: widthValue,
        };
      }
    }
  }

  let strokeWidth: number | null = null;
  if (wantWidth) {
    if (isMixedSelectionValue(current.strokeWidth)) {
      skipped.strokeWidth = true;
    } else {
      strokeWidth = Math.max(0, patch.strokeWidth as number);
    }
  }

  let opacity: number | null = null;
  if (wantOpacity) {
    if (isMixedSelectionValue(current.opacity)) {
      skipped.opacity = true;
    } else {
      opacity = patch.opacity as number;
    }
  }

  // A zero width gates the stroke side even when only the width changed.
  if (strokeWidth !== null && !(strokeWidth > 0) && stroke === null && !skipped.stroke) {
    stroke = { primary: null, secondary: null, gradient: 'solid', width: 0 };
  }

  return { fill, stroke, strokeWidth, opacity, skipped };
}

/**
 * Collect gradient `<stop>` children from a gradient element. Works with real
 * DOM elements (`getElementsByTagName`) and with the lightweight stubs used
 * in unit tests (`stops` array carried opaquely is handled by the caller via
 * `resolveGradient`, so this is only the DOM path).
 */
export function readGradientDefFromElement(element: SelectionStyleElement, tag: string): SelectionGradientDef {
  const stops: SelectionGradientDef['stops'] = [];
  try {
    const list = element.getElementsByTagName?.('stop');
    if (list) {
      for (let index = 0; index < list.length; index += 1) {
        const stop = list[index];
        if (!stop) continue;
        stops.push({ color: stop.getAttribute('stop-color'), opacity: stop.getAttribute('stop-opacity') });
      }
    }
  } catch {
    // Fail-closed: leave stops empty so the side reports MIXED.
  }
  return {
    tag,
    x1: element.getAttribute('x1'),
    y1: element.getAttribute('y1'),
    x2: element.getAttribute('x2'),
    y2: element.getAttribute('y2'),
    stops,
  };
}

/**
 * Read one selectable unit's effective paint without touching the document.
 * Backwards-compatible wrapper over {@link readVectorElementPaintDetailed}:
 * any MIXED field fails the whole element closed to MIXED so legacy callers
 * (and their tests) keep the old fail-closed contract. New code should use
 * the detailed reader plus {@link mergeDetailedPaintWithPatch} for per-side
 * selective apply.
 *
 * Effective resolution: inline `style` beats presentation attributes, the
 * nearest ancestor definition wins for inherited paint, `fill-opacity` /
 * `stroke-opacity` fold into their side's alpha, ancestor `opacity`
 * multiplies into `opacity`, and `class` / unparsable / fallback-less `url()`
 * values become MIXED. A non-positive stroke width gates the stroke side to
 * transparent/solid (width-0 rule; the width itself still reads as 0).
 */
export function readVectorElementPaint(
  element: SelectionStyleElement,
  resolveGradient: (id: string) => SelectionGradientDef | undefined,
): VectorElementPaint | SelectionMixed {
  const detailed = readVectorElementPaintDetailed(element, resolveGradient);
  if (isDetailedPaintUnknown(detailed)) return PAINT_MIXED;
  const width = detailed.strokeWidth as number;
  const opacity = detailed.opacity as number;
  if (!(width > 0)) {
    return {
      fill: detailed.fill as PaintColor,
      fillSecondary: detailed.fillSecondary as PaintColor | null,
      fillGradient: detailed.fillGradient as PaintGradientKind,
      stroke: null,
      strokeSecondary: null,
      strokeGradient: 'solid',
      strokeWidth: 0,
      opacity,
    };
  }
  return {
    fill: detailed.fill as PaintColor,
    fillSecondary: detailed.fillSecondary as PaintColor | null,
    fillGradient: detailed.fillGradient as PaintGradientKind,
    stroke: detailed.stroke as PaintColor,
    strokeSecondary: detailed.strokeSecondary as PaintColor | null,
    strokeGradient: detailed.strokeGradient as PaintGradientKind,
    strokeWidth: width,
    opacity,
  };
}

/**
 * Reduce per-element paints to one summary. An empty selection yields all
 * MIXED (nothing to show). Any element that itself read as MIXED poisons every
 * field to MIXED (fail-closed: unknown singletons must not look concrete).
 * Disagreements collapse per field; agreements (including shared transparent
 * and shared gradients) stay concrete. Stroke widths compare exactly;
 * opacities compare at 0.1 precision (the stored serialization step).
 */
export function summarizeVectorElementPaints(paints: ReadonlyArray<VectorElementPaint | SelectionMixed>): VectorSelectionSummary {
  const mixed: VectorSelectionSummary = {
    fill: PAINT_MIXED,
    fillSecondary: PAINT_MIXED,
    fillGradient: PAINT_MIXED,
    stroke: PAINT_MIXED,
    strokeSecondary: PAINT_MIXED,
    strokeGradient: PAINT_MIXED,
    strokeWidth: PAINT_MIXED,
    opacity: PAINT_MIXED,
  };
  if (paints.length === 0) return mixed;
  if (paints.some((paint) => paint === PAINT_MIXED)) return mixed;
  const concrete = paints as VectorElementPaint[];
  const first = concrete[0]!;
  let fill = first.fill;
  let fillSecondary = first.fillSecondary;
  let fillGradient = first.fillGradient;
  let stroke = first.stroke;
  let strokeSecondary = first.strokeSecondary;
  let strokeGradient = first.strokeGradient;
  let strokeWidth = first.strokeWidth;
  let opacity = first.opacity;
  let fillMixed = false;
  let fillSecondaryMixed = false;
  let fillGradientMixed = false;
  let strokeMixed = false;
  let strokeSecondaryMixed = false;
  let strokeGradientMixed = false;
  let strokeWidthMixed = false;
  let opacityMixed = false;
  for (let index = 1; index < concrete.length; index += 1) {
    const next = concrete[index]!;
    if (!fillMixed && !paintEquals(fill, next.fill)) {
      fillMixed = true;
      fill = PAINT_MIXED as unknown as PaintColor;
    }
    if (!fillSecondaryMixed && !secondaryEquals(fillSecondary, next.fillSecondary)) {
      fillSecondaryMixed = true;
      fillSecondary = PAINT_MIXED as unknown as PaintColor | null;
    }
    if (!fillGradientMixed && fillGradient !== next.fillGradient) {
      fillGradientMixed = true;
      fillGradient = PAINT_MIXED as unknown as PaintGradientKind;
    }
    if (!strokeMixed && !paintEquals(stroke, next.stroke)) {
      strokeMixed = true;
      stroke = PAINT_MIXED as unknown as PaintColor;
    }
    if (!strokeSecondaryMixed && !secondaryEquals(strokeSecondary, next.strokeSecondary)) {
      strokeSecondaryMixed = true;
      strokeSecondary = PAINT_MIXED as unknown as PaintColor | null;
    }
    if (!strokeGradientMixed && strokeGradient !== next.strokeGradient) {
      strokeGradientMixed = true;
      strokeGradient = PAINT_MIXED as unknown as PaintGradientKind;
    }
    if (!strokeWidthMixed && strokeWidth !== next.strokeWidth) {
      strokeWidthMixed = true;
      strokeWidth = PAINT_MIXED as unknown as number;
    }
    if (!opacityMixed && Math.abs(opacity - next.opacity) > 1e-9) {
      opacityMixed = true;
      opacity = PAINT_MIXED as unknown as number;
    }
  }
  // A mixed gradient kind poisons both colors (a solid red and a red ramp
  // must not display a concrete red primary that Apply would then flatten).
  if (fillGradientMixed) {
    fill = PAINT_MIXED as unknown as PaintColor;
    fillSecondary = PAINT_MIXED as unknown as PaintColor | null;
  }
  if (strokeGradientMixed) {
    stroke = PAINT_MIXED as unknown as PaintColor;
    strokeSecondary = PAINT_MIXED as unknown as PaintColor | null;
  }
  return {
    fill: fillMixed || fillGradientMixed ? PAINT_MIXED : fill,
    fillSecondary: fillSecondaryMixed || fillGradientMixed ? PAINT_MIXED : fillSecondary,
    fillGradient: fillGradientMixed ? PAINT_MIXED : fillGradient,
    stroke: strokeMixed || strokeGradientMixed ? PAINT_MIXED : stroke,
    strokeSecondary: strokeSecondaryMixed || strokeGradientMixed ? PAINT_MIXED : strokeSecondary,
    strokeGradient: strokeGradientMixed ? PAINT_MIXED : strokeGradient,
    strokeWidth: strokeWidthMixed ? PAINT_MIXED : strokeWidth,
    opacity: opacityMixed ? PAINT_MIXED : opacity,
  };
}

function secondaryEquals(left: PaintColor | null, right: PaintColor | null): boolean {
  if (left === null || right === null) return left === right;
  return paintEquals(left, right);
}

/**
 * Merge an explicit user patch over one element's current paint. Fields left
 * `undefined` keep the element's own value (mixed items survive untouched);
 * only the fields in the patch change. Gradient-kind upgrades preserve colors:
 * solid-to-gradient picks up the patch secondary (or the supplied fallback
 * secondary when the patch carries none); gradient-to-solid keeps the primary
 * and drops the secondary. The width-0 gate from the reader is re-applied so
 * a zero width always yields a transparent solid stroke side.
 */
export function mergeElementPaintWithPatch(
  current: VectorElementPaint,
  patch: VectorStylePatch,
  fallbackSecondary?: { fill?: PaintColor | null; stroke?: PaintColor | null },
): VectorElementPaint {
  const nextFill = patch.fill !== undefined ? patch.fill : current.fill;
  const nextStroke = patch.stroke !== undefined ? patch.stroke : current.stroke;
  let nextFillGradient = patch.fillGradient !== undefined ? patch.fillGradient : current.fillGradient;
  let nextStrokeGradient = patch.strokeGradient !== undefined ? patch.strokeGradient : current.strokeGradient;
  let nextFillSecondary = patch.fillSecondary !== undefined ? patch.fillSecondary : current.fillSecondary;
  let nextStrokeSecondary = patch.strokeSecondary !== undefined ? patch.strokeSecondary : current.strokeSecondary;
  const nextWidth = patch.strokeWidth !== undefined ? patch.strokeWidth : current.strokeWidth;
  const nextOpacity = patch.opacity !== undefined ? patch.opacity : current.opacity;

  if (nextFillGradient === 'solid') {
    nextFillSecondary = null;
  } else if (current.fillGradient === 'solid' && patch.fillGradient !== undefined && patch.fillSecondary === undefined) {
    // Solid-to-gradient upgrade without an explicit secondary: use the
    // caller's fallback (the toolbar's current secondary) so the new ramp has
    // two ends instead of duplicating the primary.
    nextFillSecondary = fallbackSecondary?.fill !== undefined ? (fallbackSecondary.fill as PaintColor | null) : current.fillSecondary;
    if (nextFillSecondary === null && current.fillSecondary !== null) nextFillSecondary = current.fillSecondary;
  }
  if (nextStrokeGradient === 'solid') {
    nextStrokeSecondary = null;
  } else if (current.strokeGradient === 'solid' && patch.strokeGradient !== undefined && patch.strokeSecondary === undefined) {
    nextStrokeSecondary = fallbackSecondary?.stroke !== undefined ? (fallbackSecondary.stroke as PaintColor | null) : current.strokeSecondary;
    if (nextStrokeSecondary === null && current.strokeSecondary !== null) nextStrokeSecondary = current.strokeSecondary;
  }
  if (!(nextWidth > 0)) {
    return {
      fill: nextFill,
      fillSecondary: nextFillGradient === 'solid' ? null : nextFillSecondary,
      fillGradient: nextFillGradient,
      stroke: null,
      strokeSecondary: null,
      strokeGradient: 'solid',
      strokeWidth: 0,
      opacity: nextOpacity,
    };
  }
  return {
    fill: nextFill,
    fillSecondary: nextFillGradient === 'solid' ? null : nextFillSecondary,
    fillGradient: nextFillGradient,
    stroke: nextStroke,
    strokeSecondary: nextStrokeGradient === 'solid' ? null : nextStrokeSecondary,
    strokeGradient: nextStrokeGradient,
    strokeWidth: nextWidth,
    opacity: nextOpacity,
  };
}

/** Field keys tracked as "explicitly changed by the user" for selective apply. */
export const VECTOR_STYLE_PATCH_FIELDS = [
  'fill',
  'fillSecondary',
  'fillGradient',
  'stroke',
  'strokeSecondary',
  'strokeGradient',
  'strokeWidth',
  'opacity',
] as const;

export type VectorStylePatchField = (typeof VECTOR_STYLE_PATCH_FIELDS)[number];

/** `true` when the patch carries no explicit change (Apply must be a no-op). */
export function isEmptyVectorStylePatch(patch: VectorStylePatch): boolean {
  return (
    patch.fill === undefined &&
    patch.fillSecondary === undefined &&
    patch.fillGradient === undefined &&
    patch.stroke === undefined &&
    patch.strokeSecondary === undefined &&
    patch.strokeGradient === undefined &&
    patch.strokeWidth === undefined &&
    patch.opacity === undefined
  );
}
