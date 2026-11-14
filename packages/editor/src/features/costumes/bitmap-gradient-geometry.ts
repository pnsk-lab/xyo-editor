// Pure radial-gradient geometry for the bitmap fill tool.
//
// The fill region is described by its tight mask bounds, while the gradient
// highlight follows the click point that started the fill. Keeping this
// mapping in a DOM-free helper lets `bun test` lock the numbers without a
// canvas: callers feed the result into `createRadialGradient` and clamp the
// radius to a positive value at the call site.

export type BitmapFillGradientBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BitmapFillGradientPoint = {
  x: number;
  y: number;
};

export type BitmapFillRadialGeometry = {
  /** Highlight / outer-circle center in canvas pixels. */
  centerX: number;
  centerY: number;
  /** Outer radius in canvas pixels before the call-site `max(1, ...)` clamp. */
  radius: number;
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function sanitizedExtent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value;
}

/**
 * Resolve where a bitmap fill radial gradient is centered and how far it
 * reaches.
 *
 * - `bounds` is the tight fill-region bounds (mask bounds for a plain click,
 *   global mask bounds for Shift).
 * - `click` is the fill seed in canvas pixels. A finite click wins; a
 *   missing or non-finite click falls back to the bounds center so the
 *   gradient still paints.
 * - `radius` is half the longest side (`max(width, height) / 2`). Degenerate
 *   bounds yield `0`; callers clamp to a positive radius when creating the
 *   canvas gradient.
 *
 * The geometry carries no color information, so opacity (opaque, transparent,
 * or translucent ends) never changes it.
 */
export function resolveBitmapFillRadialGeometry(
  bounds: BitmapFillGradientBounds,
  click: BitmapFillGradientPoint | undefined | null,
): BitmapFillRadialGeometry {
  const x = finiteOr(bounds.x, 0);
  const y = finiteOr(bounds.y, 0);
  const width = sanitizedExtent(bounds.width);
  const height = sanitizedExtent(bounds.height);
  const radius = Math.max(width, height) / 2;
  if (click && Number.isFinite(click.x) && Number.isFinite(click.y)) {
    return { centerX: click.x, centerY: click.y, radius };
  }
  return { centerX: x + width / 2, centerY: y + height / 2, radius };
}

/** Bounds center on its own (fallback legibility for callers and tests). */
export function bitmapFillBoundsCenter(bounds: BitmapFillGradientBounds): BitmapFillGradientPoint {
  const x = finiteOr(bounds.x, 0);
  const y = finiteOr(bounds.y, 0);
  const width = sanitizedExtent(bounds.width);
  const height = sanitizedExtent(bounds.height);
  return { x: x + width / 2, y: y + height / 2 };
}
