// Transparent-fill helpers for Scratch Paint parity (transparent = `null`).
//
// Observed Scratch Paint behavior reproduced here (no upstream source copied):
// - The fill and stroke pickers each have a transparent swatch. Transparent is
//   stored as `null`, independent from the last opaque hex color, so toggling
//   back restores the previous color instead of resetting to a default.
// - A transparent vector fill serializes as SVG `fill="none"` (not black, not
//   `transparent`), and a transparent stroke as `stroke="none"`.
// - A transparent bitmap flood fill paints alpha 0 (it erases the region).
// - Rect/oval/text honor transparent fill (hollow when the stroke stays
//   opaque); a gradient with exactly one transparent end fades only opacity by
//   reusing the surviving end's RGB with alpha 0 (never through black), and a
//   both-transparent gradient stays fully transparent.
// - The eyedropper on a fully transparent pixel yields transparent, keeping the
//   stored hex untouched for a later restore.
//
// The color math itself lives in `paint-colors.ts`; this module only maps the
// editor's `{ hex, transparent }` toggle state onto it so `Editor.svelte` and
// `BitmapEditor.svelte` stay thin and `bun test` can cover the mapping.

import {
  canvasGradientStops,
  normalizePaintRgba,
  paintToCss,
  paintToHex,
  parseHexPaintRgba,
  resolveGradientEndpoints,
  svgGradientPaint,
  type PaintColor,
  type PaintGradientKind,
  type PaintRgba,
  type VectorGradientBounds,
  type VectorGradientCenter,
} from './paint-colors';

export type TransparentPaintState = {
  /** True when the primary fill is transparent (`null`). The hex is kept for restore. */
  fillTransparent: boolean;
  /** True when the gradient end color is transparent (`null`). Only read when gradient is not solid. */
  secondaryTransparent: boolean;
  /** True when the stroke/outline is transparent (`none`). The hex is kept for restore. */
  strokeTransparent: boolean;
};

export type TransparentPaintColors = {
  fillHex: string;
  secondaryHex: string;
  strokeHex: string;
};

function opaqueFallback(): PaintRgba {
  return { r: 0, g: 0, b: 0, a: 255 };
}

/** Parse an `#rrggbb` picker value into RGBA; falls back to opaque black for unexpected input. */
export function hexToPaintRgba(hex: string): PaintRgba {
  return parseHexPaintRgba(hex) ?? opaqueFallback();
}

/** Primary fill as a `PaintColor`: `null` when the transparent toggle is on. */
export function fillPaintInput(fillTransparent: boolean, fillHex: string): PaintColor {
  if (fillTransparent) return null;
  return hexToPaintRgba(fillHex);
}

/** Gradient end color as a `PaintColor`: `null` when its transparent toggle is on. */
export function secondaryPaintInput(secondaryTransparent: boolean, secondaryHex: string): PaintColor {
  if (secondaryTransparent) return null;
  return hexToPaintRgba(secondaryHex);
}

export type VectorFillPaintOptions = {
  fillTransparent: boolean;
  fillHex: string;
  secondaryTransparent: boolean;
  secondaryHex: string;
  gradient: PaintGradientKind;
  width: number;
  height: number;
  /** Caller-supplied gradient id (kept out of this module so it stays pure). */
  id: string;
  /** Real local bounds for `userSpaceOnUse` gradients (omitted = legacy fallback). */
  bounds?: VectorGradientBounds;
  /** Optional radial center (fill-tool click in local space). */
  center?: VectorGradientCenter;
};

/**
 * Vector `fill` attribute markup for the current toggle state.
 * Solid-transparent yields `{ defs: '', fill: 'none' }`; gradients resolve a
 * transparent end to the surviving end's RGB with alpha 0 via
 * `svgGradientPaint`, so only opacity interpolates. With `bounds`, the ramp
 * is a `userSpaceOnUse` circle/ramp over the real local bounds (reference
 * parity); without it, the legacy `objectBoundingBox` fallback is kept.
 */
export function resolveVectorFillPaint(options: VectorFillPaintOptions): { defs: string; fill: string } {
  return svgGradientPaint({
    id: options.id,
    kind: options.gradient,
    primary: fillPaintInput(options.fillTransparent, options.fillHex),
    secondary: secondaryPaintInput(options.secondaryTransparent, options.secondaryHex),
    width: options.width,
    height: options.height,
    bounds: options.bounds,
    center: options.center,
  });
}

/** Vector `stroke` attribute value: `'none'` when transparent, else the stored hex. */
export function resolveVectorStroke(strokeTransparent: boolean, strokeHex: string): string {
  return strokeTransparent ? 'none' : strokeHex;
}

/** Bitmap solid flood-fill color: alpha 0 (erase) when transparent, else the opaque hex RGB. */
export function resolveBitmapSolidFill(
  fillTransparent: boolean,
  fillHex: string,
): [r: number, g: number, b: number, a: number] {
  if (fillTransparent) return [0, 0, 0, 0];
  const { r, g, b } = hexToPaintRgba(fillHex);
  return [r, g, b, 255];
}

/**
 * Canvas `addColorStop` arguments for the current toggle state. Alpha survives
 * in `rgba()` strings (unlike the previous opaque-hex stops), so a
 * transparent gradient end fades opacity without swinging through black.
 */
export function resolveBitmapGradientStops(
  fillTransparent: boolean,
  fillHex: string,
  secondaryTransparent: boolean,
  secondaryHex: string,
): [{ offset: number; css: string }, { offset: number; css: string }] {
  return canvasGradientStops(
    fillPaintInput(fillTransparent, fillHex),
    secondaryPaintInput(secondaryTransparent, secondaryHex),
  );
}

export type EyedropperResolution =
  | { transparent: true }
  | { transparent: false; hex: string };

/**
 * Map a sampled bitmap pixel to editor state. Fully transparent pixels yield
 * transparent (the stored hex is left untouched so untoggling restores it);
 * anything else yields its opaque-or-translucent hex and clears transparency.
 * Translucent (nonzero alpha) pixels keep their RGB; canvas `fillStyle` cannot
 * hold them losslessly, so the hex stores RGB and alpha is dropped, matching
 * the previous picker behavior for opaque colors.
 */
export function resolveEyedropperPixel(pixel: { r: number; g: number; b: number; a: number }): EyedropperResolution {
  const normalized = normalizePaintRgba(pixel);
  if (normalized.a === 0) return { transparent: true };
  return { transparent: false, hex: paintToHex(normalized) };
}

/**
 * CSS preview colors for both gradient ends after transparent matching: a
 * transparent end reuses the surviving end's RGB with alpha 0 (as `rgba()`),
 * so live previews fade opacity instead of swinging through black. Returned
 * strings feed `stop-color` directly; `VectorShapePreview` needs no changes.
 */
export function previewGradientEndCss(
  fillTransparent: boolean,
  fillHex: string,
  secondaryTransparent: boolean,
  secondaryHex: string,
): { from: string; to: string } {
  const { from, to } = resolveGradientEndpoints(
    fillPaintInput(fillTransparent, fillHex),
    secondaryPaintInput(secondaryTransparent, secondaryHex),
  );
  return { from: paintToCss(from), to: paintToCss(to) };
}

/** True when the primary fill paints nothing (solid transparent, or a both-transparent gradient). */
export function isFillInvisible(
  fillTransparent: boolean,
  secondaryTransparent: boolean,
  gradient: PaintGradientKind,
): boolean {
  if (gradient === 'solid') return fillTransparent;
  return fillTransparent && secondaryTransparent;
}

/**
 * Whether a bitmap paint gesture with the current toggles would change no
 * pixels, so the editor can skip history/save instead of committing an empty
 * undo entry. The bitmap brush/line stamps paint with the (solid) fill color;
 * a transparent fill stamp is a no-op. Rect/oval paint nothing only when the
 * fill is invisible *and* the outline is transparent.
 */
export function isBitmapPaintNoop(
  tool: 'brush' | 'line' | 'rect' | 'oval' | 'text',
  state: { fillTransparent: boolean; secondaryTransparent: boolean; strokeTransparent: boolean },
  gradient: PaintGradientKind,
): boolean {
  if (tool === 'brush' || tool === 'line') return state.fillTransparent;
  if (tool === 'text') return isFillInvisible(state.fillTransparent, state.secondaryTransparent, gradient) && state.strokeTransparent;
  return isFillInvisible(state.fillTransparent, state.secondaryTransparent, gradient) && state.strokeTransparent;
}
