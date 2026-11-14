// Dedicated eyedropper geometry + raster helpers (clean-room implementation).
//
// Observed scratch-paint behavior reproduced here without copying its source:
// - A dedicated picker (not a double-click shortcut) works in both bitmap and
//   vector modes, follows the pointer with a magnifier, and commits on release
//   only when the pointer is inside the artwork.
// - A fully transparent sample yields transparent (the stored hex is kept for
//   restore); anything else yields its RGB hex and clears transparency.
// - The magnifier hides outside the artwork, stays zoom-aware, and Escape (or
//   a second click on the picker, or a click outside the artwork) cancels
//   without touching colors. Text editing keeps priority: an open draft
//   commits first and one click never writes two history entries.
//
// This module stays UI-independent so `bun test` can cover the math: DOM and
// canvas sampling live with the callers (`Editor.svelte` owns colors,
// `BitmapEditor.svelte` owns the surface), exactly like `paint-colors.ts` and
// `transparent-paint.ts` do for paint values.

export type EyedropperTarget = 'fill' | 'stroke';

export type EyedropperRgba = { r: number; g: number; b: number; a: number };

/** Source-pixel radius sampled around the cursor for the magnifier. */
export const EYEDROPPER_LOUPE_RADIUS = 20;
/** Fixed magnification of the loupe canvas (independent of canvas zoom). */
export const EYEDROPPER_LOUPE_ZOOM = 3;
/** Loupe canvas edge in device pixels (diameter * zoom). */
export const EYEDROPPER_LOUPE_CANVAS_SIZE = EYEDROPPER_LOUPE_RADIUS * 2 * EYEDROPPER_LOUPE_ZOOM;

/** Offscreen raster scale for vector previews so one artwork pixel feeds several loupe pixels. */
export const EYEDROPPER_VECTOR_RASTER_SCALE = 3;

export type EyedropperPixelLocation = {
  /** Integer artwork pixel under the cursor. */
  x: number;
  y: number;
  /** False when the cursor is outside the artwork (loupe hides, release cancels). */
  inside: boolean;
};

/**
 * Map a client point to an integer artwork pixel. The bounding rect already
 * includes the current zoom/pan (via `getBoundingClientRect`), so sampling
 * stays correct at any viewport scale. Zero-size rects never report inside.
 */
export function eyedropperPixelFromClient(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  artworkWidth: number,
  artworkHeight: number,
): EyedropperPixelLocation {
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0, inside: false };
  const fx = ((clientX - rect.left) / rect.width) * artworkWidth;
  const fy = ((clientY - rect.top) / rect.height) * artworkHeight;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  if (x < 0 || y < 0 || x >= artworkWidth || y >= artworkHeight) return { x, y, inside: false };
  return { x, y, inside: true };
}

export type LoupeSourceRect = {
  /** Clamped top-left in source pixels. */
  sx: number;
  sy: number;
  /** Clamped size in source pixels (<= diameter, smaller at artwork edges). */
  sw: number;
  sh: number;
};

/** Clamp the loupe neighborhood to the artwork bounds. */
export function loupeSourceRect(
  centerX: number,
  centerY: number,
  radius: number,
  artworkWidth: number,
  artworkHeight: number,
): LoupeSourceRect {
  const safeRadius = Math.max(1, Math.floor(radius));
  const sx = Math.max(0, centerX - safeRadius);
  const sy = Math.max(0, centerY - safeRadius);
  const ex = Math.min(artworkWidth, centerX + safeRadius);
  const ey = Math.min(artworkHeight, centerY + safeRadius);
  return { sx, sy, sw: Math.max(0, ex - sx), sh: Math.max(0, ey - sy) };
}

/**
 * Pad a clamped neighborhood out to the full loupe diameter with transparent
 * black, so the magnifier keeps a stable size at artwork edges. `rows` is the
 * clamped source block in row-major RGBA order (`sw * sh * 4` entries).
 */
export function padLoupePixels(
  rows: Uint8ClampedArray,
  source: LoupeSourceRect,
  centerX: number,
  centerY: number,
  radius: number,
): { data: Uint8ClampedArray; size: number } {
  const diameter = Math.max(1, Math.floor(radius)) * 2;
  const padded = new Uint8ClampedArray(diameter * diameter * 4);
  const leftPad = Math.max(0, Math.max(1, Math.floor(radius)) - centerX + source.sx);
  const topPad = Math.max(0, Math.max(1, Math.floor(radius)) - centerY + source.sy);
  for (let y = 0; y < source.sh; y += 1) {
    for (let x = 0; x < source.sw; x += 1) {
      const from = (y * source.sw + x) * 4;
      const to = ((topPad + y) * diameter + (leftPad + x)) * 4;
      padded[to] = rows[from] ?? 0;
      padded[to + 1] = rows[from + 1] ?? 0;
      padded[to + 2] = rows[from + 2] ?? 0;
      padded[to + 3] = rows[from + 3] ?? 0;
    }
  }
  return { data: padded, size: diameter };
}

/** CSS color for the loupe ring / center cell (transparent shows checkered alpha elsewhere). */
export function eyedropperCss(pixel: EyedropperRgba): string {
  const r = Math.max(0, Math.min(255, Math.round(pixel.r)));
  const g = Math.max(0, Math.min(255, Math.round(pixel.g)));
  const b = Math.max(0, Math.min(255, Math.round(pixel.b)));
  const a = Math.max(0, Math.min(255, Math.round(pixel.a)));
  if (a === 255) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
}

/**
 * Resolve which paint target a release commits to. A Shift+click picks the
 * opposite target for that commit only (so one picker covers fill + stroke
 * without forcing a target switch first).
 */
export function resolveEyedropperCommitTarget(
  activeTarget: EyedropperTarget,
  shiftKey: boolean,
): EyedropperTarget {
  if (!shiftKey) return activeTarget;
  return activeTarget === 'fill' ? 'stroke' : 'fill';
}

/**
 * Rasterize an SVG preview string to an offscreen canvas for vector picking.
 * Returns `undefined` for empty markup or raster failures so callers can fall
 * back to a no-op instead of throwing inside a pointer handler. The canvas is
 * `width * scale` by `height * scale`; callers map artwork units by dividing
 * sample coordinates by `scale`.
 */
export async function rasterizeVectorPreview(
  svgText: string,
  width: number,
  height: number,
  scale = EYEDROPPER_VECTOR_RASTER_SCALE,
): Promise<{ canvas: HTMLCanvasElement; scale: number } | undefined> {
  if (!svgText.includes('<svg')) return undefined;
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    const loaded = await new Promise<boolean>((resolve) => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    });
    if (!loaded || !(image.width > 0) || !(image.height > 0)) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = safeWidth * safeScale;
    canvas.height = safeHeight * safeScale;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.clearRect(0, 0, canvas.width, canvas.height);
    try {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    } catch {
      // A tainted or undecodable vector preview must never break the pointer
      // handler; callers fall back to a no-op pick.
      return undefined;
    }
    return { canvas, scale: safeScale };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Exact-string cache identity for the vector eyedropper raster.
 * The full SVG source plus dimensions is the key: even same-length SVGs
 * can share a short hash while rendering different pixels, so no hash
 * (FNV or otherwise) may authorize reuse. Strings are immutable, so the
 * retained key also identifies the exact input used for an async raster.
 */
export const VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS = 3;

export function buildVectorEyedropperCacheKey(
  svgText: string,
  width: number,
  height: number,
): string {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 1;
  return `${safeWidth}x${safeHeight}:${svgText ?? ''}`;
}

/** Exact comparison: only a byte-identical key counts as current. */
export function isVectorEyedropperKeyCurrent(requestedKey: string, currentKey: string): boolean {
  return requestedKey === currentKey;
}

export type VectorEyedropperRaster = { canvas: HTMLCanvasElement; scale: number };

export type VectorEyedropperSnapshot = {
  key: string;
  svgText: string;
  width: number;
  height: number;
};

/**
 * Bounded gated refresh for the vector eyedropper raster.
 * Captures the exact-string key before the async decode, then compares the
 * current key after the await: a mismatch (same-length external replacement
 * or selection-target switch during the decode, or any edit without a new
 * refresh) discards the stale raster and retries bounded times. Cancellation
 * (owner switch / overlay cancel) discards without installing, so no stale
 * cache ever lands and no accidental cache survives a scope change.
 */
export async function gatedRefreshVectorEyedropperCache(
  readSnapshot: () => VectorEyedropperSnapshot,
  rasterize: (snapshot: VectorEyedropperSnapshot) => Promise<VectorEyedropperRaster | undefined>,
  isCancelled: () => boolean,
  maxAttempts: number = VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS,
): Promise<{ key: string; raster: VectorEyedropperRaster | undefined } | undefined> {
  const attempts = Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isCancelled()) return undefined;
    const requested = readSnapshot();
    const raster = await rasterize(requested);
    if (isCancelled()) return undefined;
    const current = readSnapshot();
    if (!isVectorEyedropperKeyCurrent(requested.key, current.key)) continue;
    return { key: requested.key, raster };
  }
  return undefined;
}

/** Read one pixel from a canvas; outside points report `inside: false`. */
export function sampleCanvasPixel(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
): { pixel: EyedropperRgba; inside: boolean } {
  const context = canvas.getContext('2d');
  if (!context) return { pixel: { r: 0, g: 0, b: 0, a: 0 }, inside: false };
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
    return { pixel: { r: 0, g: 0, b: 0, a: 0 }, inside: false };
  }
  let data: Uint8ClampedArray;
  try {
    const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
    data = Uint8ClampedArray.from([r ?? 0, g ?? 0, b ?? 0, a ?? 0]);
  } catch {
    // A cross-origin-tainted canvas throws on read; report outside so the
    // overlay hides and the release cancels instead of throwing in the
    // pointer handler.
    return { pixel: { r: 0, g: 0, b: 0, a: 0 }, inside: false };
  }
  return { pixel: { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0, a: data[3] ?? 0 }, inside: true };
}
