// Pure paint-color helpers for Scratch Paint parity work.
//
// Scratch Paint (observed behavior, no source copied here) vs. the current
// editor:
// - Scratch keeps fill and stroke colors independently. Each side stores a CSS
//   color string or `null` for transparent, plus a second color for gradients
//   and a gradient kind (solid / horizontal / vertical / radial). When the
//   selection holds several different colors the UI shows a MIXED indicator
//   instead of a concrete color. A stroke width of 0 is treated as transparent
//   for that state. The eyedropper can pick a fully transparent pixel (yields
//   transparent, not black).
// - When exactly one gradient endpoint is transparent, Scratch does not fade
//   through black/gray: the transparent end reuses the opaque end's RGB with
//   alpha 0, so only opacity interpolates. Both-transparent stays transparent.
// - The current editor (`Editor.svelte`) keeps `paintColor` /
//   `secondaryPaintColor` / `strokeColor` as always-opaque `#rrggbb` hex
//   strings, a shared `paintGradient` kind, and a separate `vectorOpacity`
//   number input. There is no transparent swatch, no MIXED indicator, no
//   fill/stroke swap or second stroke color, the bitmap eyedropper drops the
//   alpha channel, solid bitmap fills force alpha 255, and gradient stops are
//   always opaque. `vectorPaintStyle()` also mints its gradient id with
//   `Date.now()` + `Math.random()`, so it is impure and hard to test.
//
// This module is the UI-independent core that closes the *value* gap without
// touching any component: transparent as `null`, MIXED as a sentinel,
// per-channel RGBA interpolation, transparent-aware gradient endpoints, point
// sampling for canvas fills, and deterministic SVG gradient markup. DOM,
// Paper.js, Svelte, and CanvasGradient objects are deliberately left to
// callers so `bun test` can exercise everything here.

export type PaintChannel = number;

export type PaintRgba = {
  /** Red 0-255 (integer after normalization). */
  r: number;
  /** Green 0-255 (integer after normalization). */
  g: number;
  /** Blue 0-255 (integer after normalization). */
  b: number;
  /** Alpha 0-255 (integer after normalization). `0` = fully transparent. */
  a: number;
};

/**
 * A single paint value. `null` means transparent (Scratch's `null` fill/stroke:
 * rendered as SVG `none` / CSS `transparent`, not as black).
 */
export type PaintColor = PaintRgba | null;

/** Sentinel shown when a selection holds more than one paint value. */
export const PAINT_MIXED = 'MIXED' as const;
export type PaintMixed = typeof PAINT_MIXED;

/** Gradient kinds shared by the fill UI and the bitmap/vector painters. */
export type PaintGradientKind = 'solid' | 'horizontal' | 'vertical' | 'radial';

export type PaintBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PaintPoint = {
  x: number;
  y: number;
};

function clampChannel(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return 0;
  if (rounded < 0) return 0;
  if (rounded > 255) return 255;
  return rounded;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Normalize any numeric RGBA into integer 0-255 channels. */
export function normalizePaintRgba(color: {
  r: number;
  g: number;
  b: number;
  a: number;
}): PaintRgba {
  return {
    r: clampChannel(color.r),
    g: clampChannel(color.g),
    b: clampChannel(color.b),
    a: clampChannel(color.a),
  };
}

/** `true` when the paint is transparent (`null`). */
export function isTransparentPaint(color: PaintColor | PaintMixed | undefined): color is null {
  return color === null;
}

/** `true` when the value is the MIXED selection sentinel. */
export function isMixedPaint(value: unknown): value is PaintMixed {
  return value === PAINT_MIXED;
}

/**
 * Reduce a list of paint values to the shared color, or `MIXED` when they
 * disagree. Transparent (`null`) only matches transparent; an opaque color
 * never equals transparent even with alpha 0 stored differently (all inputs
 * are normalized first). An empty list yields `MIXED` (nothing to show).
 */
export function commonPaintColor(colors: readonly PaintColor[]): PaintColor | PaintMixed {
  if (colors.length === 0) return PAINT_MIXED;
  const first = normalizePaintValue(colors[0]);
  for (let index = 1; index < colors.length; index += 1) {
    const next = normalizePaintValue(colors[index]);
    if (!paintColorsEqual(first, next)) return PAINT_MIXED;
  }
  return first;
}

function normalizePaintValue(color: PaintColor): PaintColor {
  if (color === null) return null;
  return normalizePaintRgba(color);
}

function paintColorsEqual(left: PaintColor, right: PaintColor): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.r === right.r && left.g === right.g && left.b === right.b && left.a === right.a;
}

function toHexByte(value: number): string {
  return clampChannel(value).toString(16).padStart(2, '0');
}

/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` (leading `#` optional). */
export function parseHexPaintRgba(input: string): PaintRgba | undefined {
  const text = input.trim().replace(/^#/, '');
  const isHex = /^[0-9a-fA-F]+$/.test(text);
  if (!isHex) return undefined;
  if (text.length === 3) {
    const r = Number.parseInt(text[0]! + text[0], 16);
    const g = Number.parseInt(text[1]! + text[1], 16);
    const b = Number.parseInt(text[2]! + text[2], 16);
    return { r, g, b, a: 255 };
  }
  if (text.length === 6) {
    return {
      r: Number.parseInt(text.slice(0, 2), 16),
      g: Number.parseInt(text.slice(2, 4), 16),
      b: Number.parseInt(text.slice(4, 6), 16),
      a: 255,
    };
  }
  if (text.length === 8) {
    return {
      r: Number.parseInt(text.slice(0, 2), 16),
      g: Number.parseInt(text.slice(2, 4), 16),
      b: Number.parseInt(text.slice(4, 6), 16),
      a: Number.parseInt(text.slice(6, 8), 16),
    };
  }
  return undefined;
}

/**
 * Parse a user/CSS paint value into the `PaintColor` model.
 *
 * - `null` / `undefined` / `''` / `'none'` / `'transparent'` map to
 *   transparent (`null`).
 * - `#rgb` / `#rrggbb` / `#rrggbbaa` map to that RGBA.
 * - `rgb(r, g, b)` maps to opaque; `rgba(r, g, b, a)` maps to alpha 0-1 or
 *   0-255 (values `<= 1` are treated as 0-1 fractions, larger ones as 0-255).
 * - Anything else yields `undefined` (unknown, distinct from transparent) so
 *   callers can keep the previous color instead of clearing it.
 */
export function parsePaintColor(input: string | null | undefined): PaintColor | undefined {
  if (input === null || input === undefined) return null;
  const text = input.trim().toLowerCase();
  if (text === '' || text === 'none' || text === 'transparent') return null;
  if (text.startsWith('#') || /^[0-9a-f]{3}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(text)) {
    return parseHexPaintRgba(text);
  }
  const rgbMatch =
    /^rgba?\(\s*([+-]?(?:\d*\.)?\d+)\s*,\s*([+-]?(?:\d*\.)?\d+)\s*,\s*([+-]?(?:\d*\.)?\d+)(?:\s*,\s*([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?))?\s*\)$/.exec(
      text,
    );
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    let a = 255;
    if (rgbMatch[4] !== undefined) {
      const raw = Number(rgbMatch[4]);
      if (!Number.isFinite(raw)) return undefined;
      a = raw <= 1 && raw >= 0 ? raw * 255 : raw;
    }
    if (![r, g, b].every(Number.isFinite)) return undefined;
    return normalizePaintRgba({ r, g, b, a });
  }
  return undefined;
}

/** Opaque `#rrggbb` form (alpha is dropped; use {@link paintToCss} to keep it). */
export function paintToHex(color: PaintRgba): string {
  return `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`;
}

/** Full `#rrggbbaa` form preserving alpha. */
export function paintToHex8(color: PaintRgba): string {
  return `${paintToHex(color)}${toHexByte(color.a)}`;
}

/**
 * CSS form of a paint value: `'transparent'` for `null`, `#rrggbb` for opaque,
 * `rgba(r, g, b, a)` otherwise (alpha as a 0-1 fraction with up to 3 decimals).
 */
export function paintToCss(color: PaintColor): string {
  if (color === null) return 'transparent';
  const normalized = normalizePaintRgba(color);
  if (normalized.a === 255) return paintToHex(normalized);
  return `rgba(${normalized.r}, ${normalized.g}, ${normalized.b}, ${trimAlpha(normalized.a / 255)})`;
}

/** SVG `fill`/`stroke` attribute form: `'none'` for transparent. */
export function paintToSvgPaint(color: PaintColor): string {
  if (color === null) return 'none';
  return paintToCss(color);
}

function trimAlpha(fraction: number): string {
  return String(Math.round(fraction * 1000) / 1000);
}

/**
 * Linear per-channel interpolation (including alpha) in straight sRGB.
 * `t` is clamped to 0-1; endpoints are normalized so fractional inputs behave
 * like their stored 0-255 equivalents.
 */
export function interpolatePaintRgba(
  from: { r: number; g: number; b: number; a: number },
  to: { r: number; g: number; b: number; a: number },
  t: number,
): PaintRgba {
  const amount = clamp01(t);
  const start = normalizePaintRgba(from);
  const end = normalizePaintRgba(to);
  return {
    r: clampChannel(start.r + (end.r - start.r) * amount),
    g: clampChannel(start.g + (end.g - start.g) * amount),
    b: clampChannel(start.b + (end.b - start.b) * amount),
    a: clampChannel(start.a + (end.a - start.a) * amount),
  };
}

/**
 * Transparent version of an opaque color: same RGB, alpha 0.
 * This is the adjustment Scratch applies to a transparent gradient endpoint
 * so the ramp fades opacity without swinging through black/gray.
 */
export function transparentMatchFor(color: { r: number; g: number; b: number }): PaintRgba {
  const normalized = normalizePaintRgba({ r: color.r, g: color.g, b: color.b, a: 255 });
  return { r: normalized.r, g: normalized.g, b: normalized.b, a: 0 };
}

export type ResolvedGradientEndpoints = {
  from: PaintRgba;
  to: PaintRgba;
};

/**
 * Resolve possibly-transparent gradient endpoints to two concrete RGBA stops.
 *
 * - Both opaque: returned as-is (normalized).
 * - One transparent: the transparent side takes the other's RGB with alpha 0,
 *   so interpolation only fades opacity (no hue swing through black).
 * - Both transparent: transparent black on both ends (renders as nothing, but
 *   keeps sampling/markup total).
 */
export function resolveGradientEndpoints(
  primary: PaintColor,
  secondary: PaintColor,
): ResolvedGradientEndpoints {
  if (primary !== null && secondary !== null) {
    return { from: normalizePaintRgba(primary), to: normalizePaintRgba(secondary) };
  }
  if (primary !== null) {
    const from = normalizePaintRgba(primary);
    return { from, to: { r: from.r, g: from.g, b: from.b, a: 0 } };
  }
  if (secondary !== null) {
    const to = normalizePaintRgba(secondary);
    return { from: { r: to.r, g: to.g, b: to.b, a: 0 }, to };
  }
  return { from: { r: 0, g: 0, b: 0, a: 0 }, to: { r: 0, g: 0, b: 0, a: 0 } };
}

export type GradientSampleOptions = {
  kind: PaintGradientKind;
  primary: PaintColor;
  secondary: PaintColor;
  bounds: PaintBounds;
  point: PaintPoint;
};

/**
 * Sample the painted color at one point inside `bounds`.
 *
 * - `solid` ignores `point` and returns the primary (transparent stays
 *   transparent).
 * - `horizontal` ramps with `x`, `vertical` with `y` (clamped to the bounds).
 * - `radial` ramps with distance from the bounds center to a radius of
 *   `max(width, height) / 2`, matching the current editor's canvas/vector
 *   geometry. Degenerate (zero-size) bounds return the primary end.
 */
export function sampleGradientColor(options: GradientSampleOptions): PaintRgba {
  const { kind, primary, secondary, bounds, point } = options;
  if (kind === 'solid') {
    return primary === null ? { r: 0, g: 0, b: 0, a: 0 } : normalizePaintRgba(primary);
  }
  const { from, to } = resolveGradientEndpoints(primary, secondary);
  if (kind === 'horizontal') {
    const span = bounds.width;
    if (!(span > 0)) return from;
    return interpolatePaintRgba(from, to, (point.x - bounds.x) / span);
  }
  if (kind === 'vertical') {
    const span = bounds.height;
    if (!(span > 0)) return from;
    return interpolatePaintRgba(from, to, (point.y - bounds.y) / span);
  }
  const radius = Math.max(bounds.width, bounds.height) / 2;
  if (!(radius > 0)) return from;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const distance = Math.hypot(point.x - centerX, point.y - centerY);
  return interpolatePaintRgba(from, to, distance / radius);
}

export type CanvasGradientStop = {
  offset: number;
  css: string;
};

/**
 * Canvas `addColorStop` arguments for the resolved gradient. Alpha is kept in
 * `rgba()` strings (unlike the current editor, which only emits opaque hex),
 * so callers can forward each entry to `gradient.addColorStop(offset, css)`.
 */
export function canvasGradientStops(
  primary: PaintColor,
  secondary: PaintColor,
): [CanvasGradientStop, CanvasGradientStop] {
  const { from, to } = resolveGradientEndpoints(primary, secondary);
  return [
    { offset: 0, css: paintToCss(from) },
    { offset: 1, css: paintToCss(to) },
  ];
}

export type VectorGradientBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VectorGradientCenter = {
  x: number;
  y: number;
};

export type SvgGradientOptions = {
  /** Caller-supplied id (no `Date.now()`/`Math.random()` inside: stays pure). */
  id: string;
  kind: PaintGradientKind;
  primary: PaintColor;
  secondary: PaintColor;
  /**
   * Kept for API compatibility. Ignored when `bounds` is supplied.
   * Without `bounds`, linear/radial geometry falls back to the legacy
   * per-object (`objectBoundingBox`) ramp.
   */
  width: number;
  height: number;
  /**
   * Real local bounds of the referencing element (parent user space: raw
   * geometry plus the element's own transform, ancestors excluded so the
   * `userSpaceOnUse` ramp rides ancestor transforms rigidly). When supplied,
   * gradients are emitted as `userSpaceOnUse` circles/ramps matching the
   * reference `createGradientObject` geometry: radial radius
   * `max(width, height) / 2`, linear spanning the bounds (degenerate
   * zero-spans clamped to a `0.01` vector so orthogonal line ramps stay
   * non-degenerate like the reference). Degenerate radial spans use
   * clamped `r="1"`; nothing throws.
   */
  bounds?: VectorGradientBounds;
  /**
   * Optional radial center in the same local space (fill-tool click point
   * converted to parent user space). Defaults to the bounds center.
   * Ignored for solid/linear.
   */
  center?: VectorGradientCenter;
};

export type SvgGradientPaint = {
  defs: string;
  fill: string;
};

function escapeGradientId(id: string): string {
  return id.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function svgStop(color: PaintRgba, offset: number): string {
  return `<stop offset="${offset}" stop-color="${paintToHex(color)}" stop-opacity="${trimAlpha(color.a / 255)}"/>`;
}

function finiteGradientNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function formatGradientNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(3));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function sanitizedGradientBounds(bounds: VectorGradientBounds): { x: number; y: number; width: number; height: number } {
  const x = finiteGradientNumber(bounds.x, 0);
  const y = finiteGradientNumber(bounds.y, 0);
  const width = Number.isFinite(bounds.width) ? Math.max(0, bounds.width) : 0;
  const height = Number.isFinite(bounds.height) ? Math.max(0, bounds.height) : 0;
  return { x, y, width, height };
}

/**
 * Reference radial geometry (behavior notes, no upstream source copied):
 * a circle centered on the bounds center (or the fill click point) with
 * radius `max(width, height) / 2`. Degenerate bounds yield `r="1"` so the
 * markup stays valid SVG instead of `r="0"`.
 */
export function resolveVectorRadialUserSpace(
  bounds: VectorGradientBounds,
  center?: VectorGradientCenter,
): { cx: number; cy: number; r: number } {
  const clean = sanitizedGradientBounds(bounds);
  const cx =
    center && Number.isFinite(center.x) && Number.isFinite(center.y)
      ? finiteGradientNumber(center.x, clean.x + clean.width / 2)
      : clean.x + clean.width / 2;
  const cy =
    center && Number.isFinite(center.x) && Number.isFinite(center.y)
      ? finiteGradientNumber(center.y, clean.y + clean.height / 2)
      : clean.y + clean.height / 2;
  const rawRadius = Math.max(clean.width, clean.height) / 2;
  const r = Number.isFinite(rawRadius) && rawRadius > 0 ? rawRadius : 1;
  return { cx, cy, r };
}

/**
 * Reference linear geometry: a ramp spanning the element bounds
 * (horizontal `x -> x + width`, vertical `y -> y + height`). A degenerate
 * span (zero width/height, e.g. a horizontal/vertical line with an
 * orthogonal ramp) is clamped to the reference minimum vector length of
 * `0.01`: equal endpoints render as a solid last-stop color in SVG instead
 * of the real ramp, so the orthogonal direction stays non-degenerate.
 */
export function resolveVectorLinearUserSpace(
  bounds: VectorGradientBounds,
  kind: PaintGradientKind,
): { x1: number; y1: number; x2: number; y2: number } {
  const clean = sanitizedGradientBounds(bounds);
  const MIN_LINEAR_SPAN = 0.01;
  if (kind === 'vertical') {
    const span = clean.height > MIN_LINEAR_SPAN ? clean.height : MIN_LINEAR_SPAN;
    return { x1: clean.x, y1: clean.y, x2: clean.x, y2: clean.y + span };
  }
  const span = clean.width > MIN_LINEAR_SPAN ? clean.width : MIN_LINEAR_SPAN;
  return { x1: clean.x, y1: clean.y, x2: clean.x + span, y2: clean.y };
}

/**
 * Deterministic SVG gradient markup for vector fills.
 * Drop-in shape for the current `vectorPaintStyle(width, height)` return
 * (`{ defs, fill }`), but pure and transparent-aware:
 * solid-transparent yields `{ defs: '', fill: 'none' }`, solid-opaque yields no
 * defs, and gradients split color/opacity into `stop-color` + `stop-opacity`
 * so a transparent end survives SVG serialization.
 *
 * With `bounds` (and optional click `center`), radial/linear gradients are
 * emitted as `userSpaceOnUse` circles/ramps over the element's real local
 * bounds, matching the reference circle (`max(w,h)/2`, click-centered).
 * Without `bounds`, the legacy `objectBoundingBox` fallback is kept for
 * API compatibility (existing callers/tests without geometry).
 */
export function svgGradientPaint(options: SvgGradientOptions): SvgGradientPaint {
  const { id, kind, primary, secondary, bounds, center } = options;
  if (kind === 'solid') {
    if (primary === null) return { defs: '', fill: 'none' };
    return { defs: '', fill: paintToCss(primary) };
  }
  const safeId = escapeGradientId(id);
  const { from, to } = resolveGradientEndpoints(primary, secondary);
  const stops = `${svgStop(from, 0)}${svgStop(to, 1)}`;
  if (kind === 'radial') {
    if (bounds) {
      const circle = resolveVectorRadialUserSpace(bounds, center);
      return {
        defs: `<defs><radialGradient id="${safeId}" gradientUnits="userSpaceOnUse" cx="${formatGradientNumber(circle.cx)}" cy="${formatGradientNumber(circle.cy)}" r="${formatGradientNumber(circle.r)}">${stops}</radialGradient></defs>`,
        fill: `url(#${safeId})`,
      };
    }
    return {
      defs: `<defs><radialGradient id="${safeId}" gradientUnits="objectBoundingBox" cx="50%" cy="50%" r="70%">${stops}</radialGradient></defs>`,
      fill: `url(#${safeId})`,
    };
  }
  if (bounds) {
    const vector = resolveVectorLinearUserSpace(bounds, kind);
    return {
      defs: `<defs><linearGradient id="${safeId}" gradientUnits="userSpaceOnUse" x1="${formatGradientNumber(vector.x1)}" y1="${formatGradientNumber(vector.y1)}" x2="${formatGradientNumber(vector.x2)}" y2="${formatGradientNumber(vector.y2)}">${stops}</linearGradient></defs>`,
      fill: `url(#${safeId})`,
    };
  }
  // Legacy per-object linear ramp (matches old VectorShapePreview
  // percentages): the gradient spans the referencing element's own bbox.
  // Kept only for callers without real local bounds.
  const vector = kind === 'vertical' ? `x1="0%" y1="0%" x2="0%" y2="100%"` : `x1="0%" y1="0%" x2="100%" y2="0%"`;
  return {
    defs: `<defs><linearGradient id="${safeId}" gradientUnits="objectBoundingBox" ${vector}>${stops}</linearGradient></defs>`,
    fill: `url(#${safeId})`,
  };
}

export type EyeDropperPixel = {
  r: number;
  g: number;
  b: number;
  a: number;
};

/**
 * Map a sampled bitmap pixel to a paint value. Fully transparent pixels yield
 * transparent (`null`) instead of opaque black; anything else keeps its RGBA
 * (the current bitmap eyedropper drops alpha and can never produce
 * transparent).
 */
export function eyeDropperPaint(pixel: EyeDropperPixel): PaintColor {
  const normalized = normalizePaintRgba(pixel);
  if (normalized.a === 0) return null;
  return normalized;
}

export type FillPaintPair = {
  primary: string;
  primaryTransparent: boolean;
  secondary: string;
  secondaryTransparent: boolean;
};

/**
 * Exchange the first/second fill colors together with their transparent
 * flags. The hex strings are carried opaquely (no parsing/normalization) so
 * the operation is an exact involution: applying it twice restores the input
 * even when both ends hold the same color or both are transparent.
 */
export function swapFillPaintState(state: FillPaintPair): FillPaintPair {
  return {
    primary: state.secondary,
    primaryTransparent: state.secondaryTransparent,
    secondary: state.primary,
    secondaryTransparent: state.primaryTransparent,
  };
}
