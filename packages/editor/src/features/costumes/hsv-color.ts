// HSV helpers for the Scratch-Parity color picker.
//
// Observed Scratch Paint behavior reproduced here (no upstream source copied,
// standard HSV math written independently):
// - Three sliders, each 0-100: hue (0-100 maps to 0-360deg), saturation,
//   brightness/value. The current editor only has native `<input type=color>`
//   (opaque `#rrggbb`, no H/S/V decomposition, no numeric readouts).
// - Each slider's track is a live gradient over its own channel with the other
//   two channels fixed (hue track = rainbow at current S/V, etc.).
// - Transparent (`null`) and MIXED selections show a default HSV instead of a
//   concrete color; moving a slider then writes a fresh opaque color without
//   clearing the stored hex (the transparent toggle keeps the old hex for
//   restore, matching the native picker which also leaves the toggle alone).
// - Pure black parses as HSV(0,0,0) but is displayed with saturation 100 so the
//   sliders show a usable position.
// - The radio/saturation extremes: achromatic colors carry no hue; callers that
//   need hue stability (dragging hue while gray) must keep the hue locally
//   instead of re-deriving it from the hex on every tick.
//
// This module is pure (no DOM/Svelte) so `bun test` can cover it. DOM and
// history stay with the callers: slider input only rewrites the hex string and
// marks the vector style dirty; history is written by the existing apply/paint
// paths, exactly like the native picker.

export type Hsv100 = {
  /** Hue 0-100 (×3.6 = degrees 0-360). */
  h: number;
  /** Saturation 0-100. */
  s: number;
  /** Brightness/value 0-100. */
  v: number;
};

export type Rgb = {
  r: number;
  g: number;
  b: number;
};

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function clampByte(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return 0;
  if (rounded < 0) return 0;
  if (rounded > 255) return 255;
  return rounded;
}

/** Default HSV shown for transparent / MIXED / unparseable colors. */
export const HSV_DEFAULT: Hsv100 = { h: 50, s: 100, v: 100 };

/** Normalize any numeric HSV into the 0-100 ranges. */
export function normalizeHsv100(color: { h: number; s: number; v: number }): Hsv100 {
  return { h: clamp100(color.h), s: clamp100(color.s), v: clamp100(color.v) };
}

/** Standard sRGB (0-255) to HSV (0-100 each, hue scaled from 0-360). */
export function rgbToHsv100(color: { r: number; g: number; b: number }): Hsv100 {
  const r = clampByte(color.r) / 255;
  const g = clampByte(color.g) / 255;
  const b = clampByte(color.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max * 100;
  const s = max === 0 ? 0 : (delta / max) * 100;
  let degrees = 0;
  if (delta !== 0) {
    if (max === r) degrees = 60 * (((g - b) / delta) % 6);
    else if (max === g) degrees = 60 * ((b - r) / delta + 2);
    else degrees = 60 * ((r - g) / delta + 4);
    if (degrees < 0) degrees += 360;
  }
  return { h: clamp100(degrees / 3.6), s: clamp100(s), v: clamp100(v) };
}

/** Standard HSV (0-100 each) to sRGB (0-255 integers). */
export function hsv100ToRgb(color: { h: number; s: number; v: number }): Rgb {
  const normalized = normalizeHsv100(color);
  const degrees = (normalized.h / 100) * 360;
  const s = normalized.s / 100;
  const v = normalized.v / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((degrees / 60) % 2) - 1));
  const m = v - c;
  let prime: [number, number, number] = [0, 0, 0];
  if (degrees < 60) prime = [c, x, 0];
  else if (degrees < 120) prime = [x, c, 0];
  else if (degrees < 180) prime = [0, c, x];
  else if (degrees < 240) prime = [0, x, c];
  else if (degrees < 300) prime = [x, 0, c];
  else prime = [c, 0, x];
  return {
    r: clampByte((prime[0] + m) * 255),
    g: clampByte((prime[1] + m) * 255),
    b: clampByte((prime[2] + m) * 255),
  };
}

function toHexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0');
}

/** Parse `#rgb` / `#rrggbb` (leading `#` optional); `undefined` when unparseable. */
export function parseHsvHex(input: string): Rgb | undefined {
  const text = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(text)) return undefined;
  if (text.length === 3) {
    return {
      r: Number.parseInt(text[0]! + text[0], 16),
      g: Number.parseInt(text[1]! + text[1], 16),
      b: Number.parseInt(text[2]! + text[2], 16),
    };
  }
  if (text.length === 6) {
    return {
      r: Number.parseInt(text.slice(0, 2), 16),
      g: Number.parseInt(text.slice(2, 4), 16),
      b: Number.parseInt(text.slice(4, 6), 16),
    };
  }
  return undefined;
}

/** RGB to opaque `#rrggbb`. */
export function rgbToHex(color: { r: number; g: number; b: number }): string {
  return `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`;
}

/** HSV (0-100) to opaque `#rrggbb`. */
export function hsv100ToHex(color: { h: number; s: number; v: number }): string {
  return rgbToHex(hsv100ToRgb(color));
}

/** Opaque hex to HSV (0-100); `undefined` when unparseable. */
export function hexToHsv100(hex: string): Hsv100 | undefined {
  const rgb = parseHsvHex(hex);
  if (!rgb) return undefined;
  return rgbToHsv100(rgb);
}

/**
 * Display HSV for a picker bound to an opaque hex string.
 *
 * - `null` (transparent toggle on), the MIXED sentinel (`mixed === true`), or
 *   an unparseable hex yields the default (same position Scratch shows for
 *   transparent/MIXED) so the sliders never write until the user moves one.
 * - Pure black (`v === 0 && s === 0`) is shown with saturation 100 so the
 *   sliders sit on a usable color instead of the degenerate corner.
 */
export function displayHsvFor(hex: string | null | undefined, mixed = false): Hsv100 {
  if (mixed || hex === null || hex === undefined) return { ...HSV_DEFAULT };
  const hsv = hexToHsv100(hex);
  if (!hsv) return { ...HSV_DEFAULT };
  if (hsv.v === 0 && hsv.s === 0) return { h: hsv.h, s: 100, v: hsv.v };
  return hsv;
}

export type HsvChannel = 'hue' | 'saturation' | 'brightness';

/**
 * Live slider-track background for one channel with the other two fixed.
 * Eleven stops (100..0 step 10) as `linear-gradient(to left, ...)` so value 0
 * sits on the left in LTR; RTL containers mirror the native range input while
 * the gradient direction stays tied to the track geometry like the reference.
 */
export function hsvSliderBackground(channel: HsvChannel, fixed: { h: number; s: number; v: number }): string {
  const base = normalizeHsv100(fixed);
  const stops: string[] = [];
  for (let n = 100; n >= 0; n -= 10) {
    if (channel === 'hue') stops.push(hsv100ToHex({ h: n, s: base.s, v: base.v }));
    else if (channel === 'saturation') stops.push(hsv100ToHex({ h: base.h, s: n, v: base.v }));
    else stops.push(hsv100ToHex({ h: base.h, s: base.s, v: n }));
  }
  return `linear-gradient(to left, ${stops.join(',')})`;
}

/** Rounded readout for a 0-100 channel (matches the reference label readout). */
export function hsvReadout(value: number): string {
  return String(Math.round(clamp100(value)));
}
