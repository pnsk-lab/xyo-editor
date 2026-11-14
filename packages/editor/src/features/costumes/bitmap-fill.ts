// Pure bitmap fill helpers ported from scratch-paint
// (`src/helper/bitmap.js` `matchesColor_`/`colorPixel_`/`floodFillInternal_`/
// `floodFill`/`floodFillAll` + `src/helper/bit-tools/fill-tool.js` click/shift-click dispatch).
//
// Comparison with scratch-paint:
// - Match rule is identical: strict per-channel RGBA equality (`===` on R/G/B/A,
//   no tolerance, no premultiplication). Anti-aliased fringes therefore stop the
//   fill exactly like upstream. In particular there is no `colorDistance`
//   threshold: near-identical colors such as `[254, 255, 255, 255]` never match
//   `[255, 255, 255, 255]`.
// - The full alpha channel participates in both matching and painting. The fill
//   color is written verbatim (after Uint8 clamping, see below); alpha is never
//   forced to 255.
// - Connected fill uses the same scanline loop: walk up to the top of the run,
//   paint downwards, and push each contiguous left/right neighbour run once
//   (`lastLeftMatchedColor` / `lastRightMatchedColor`). Shift-click uses the same
//   whole-canvas exact-match sweep as `floodFillAll`.
// - Differences are deliberate so this module stays pure and DOM-free:
//   scratch-paint reads/writes via `CanvasRenderingContext2D.getImageData` /
//   `putImageData` and resolves CSS strings via `fillStyleToColor_` (a 1x1 canvas).
//   Here callers pass RGBA tuples directly and every function takes/returns a
//   `{ width, height, data }` image without mutating its input, so `bun test` can
//   exercise it without a canvas. Out-of-bounds (or non-finite) seeds are a
//   `changed: false` no-op (scratch-paint would sample outside the canvas instead).
// - Fill colors are normalized with the same result `fillStyleToColor_` would
//   produce: each channel is rounded and clamped to an integer 0-255 before the
//   no-op comparison and before painting, so fractional or out-of-range inputs
//   behave like their canvas equivalent.
// - Gradient fills reuse the same regions: `floodFillMaskBitmap` /
//   `floodFillAllMaskBitmap` below derive a 1-byte-per-pixel mask from the exact
//   same match rule (by replaying the solid fill with a sentinel color that is
//   guaranteed to differ from the seed and diffing the result), so the masked
//   region is identical to what the solid fill would paint. Callers render the
//   selected gradient onto an offscreen canvas sized to the mask's tight bounds
//   and keep it only where the mask is set (`destination-in` composite) before
//   drawing it back, mirroring the mask-then-composite approach without any
//   DOM dependency in this module.
// - Performance: the hot loops avoid per-pixel function calls and per-pixel
//   `[x, y]` tuple allocations (flat numeric stack, row-relative indexing, and a
//   single strided pass for the global sweep), giving linear-time fills with
//   O(pending runs) extra memory instead of O(pixels).

export type BitmapFillRGBA = readonly [r: number, g: number, b: number, a: number];

export type BitmapFillImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type BitmapFillResult = {
  /** New image; the input image is never mutated. */
  image: BitmapFillImage;
  /** False when nothing was painted (out of bounds, empty image, or no-op color). */
  changed: boolean;
  /** Number of pixels repainted with the new color. */
  filledCount: number;
};

export type BitmapFillMaskBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BitmapFillMaskResult = {
  width: number;
  height: number;
  /**
   * One byte per pixel (`1` = belongs to the fill region, `0` = untouched),
   * row-major. Empty when the image itself is unusable.
   */
  mask: Uint8Array;
  /** False when the region is empty (out of bounds or empty image). */
  changed: boolean;
  /** Number of `1` bytes in `mask`. */
  filledCount: number;
  /** The seed pixel color the region was matched against, if any. */
  seedColor: [r: number, g: number, b: number, a: number] | undefined;
  /** Tight bounds of the `1` bytes, if any. */
  bounds: BitmapFillMaskBounds | undefined;
};

function isUsableImage(image: BitmapFillImage): boolean {
  return (
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    image.data instanceof Uint8ClampedArray &&
    image.data.length === image.width * image.height * 4
  );
}

export function bitmapColorsEqual(a: BitmapFillRGBA, b: BitmapFillRGBA): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** Round + clamp one channel the way `Uint8ClampedArray` (and canvas) stores it. */
function clampChannel(value: number): number {
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > 255) return 255;
  return rounded;
}

/**
 * Normalize a caller-supplied color to the integer tuple the canvas would hold,
 * mirroring scratch-paint `fillStyleToColor_` (which always yields 0-255 ints).
 * Normalizing before the no-op check keeps e.g. alpha `300` from looking like a
 * different color than the `255` it paints as.
 */
function normalizeColor(color: BitmapFillRGBA): [r: number, g: number, b: number, a: number] {
  return [clampChannel(color[0]), clampChannel(color[1]), clampChannel(color[2]), clampChannel(color[3])];
}

function readPixel(data: Uint8ClampedArray, index: number): BitmapFillRGBA {
  return [data[index]!, data[index + 1]!, data[index + 2]!, data[index + 3]!];
}

/** Sample one pixel; returns `undefined` when `(x, y)` is outside the image. */
export function getBitmapPixel(image: BitmapFillImage, x: number, y: number): BitmapFillRGBA | undefined {
  if (!isUsableImage(image)) return undefined;
  const ix = Math.trunc(x);
  const iy = Math.trunc(y);
  if (!Number.isFinite(ix) || !Number.isFinite(iy)) return undefined;
  if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return undefined;
  return readPixel(image.data, (iy * image.width + ix) * 4);
}

function noChange(image: BitmapFillImage): BitmapFillResult {
  return { image, changed: false, filledCount: 0 };
}

/**
 * Connected (4-way) flood fill from the seed pixel.
 * Normal click in scratch-paint's fill tool (`fill-tool.js` without Shift).
 *
 * Runs in linear time: every pixel is painted at most once (painted pixels no
 * longer match `oldColor` because old and new colors differ), and each
 * contiguous vertical run pushes each neighbour column at most once, exactly
 * like `floodFillInternal_`. The stack is a flat number list (`x0, y0, ...`)
 * so pending runs cost two numbers instead of a per-run tuple allocation, and
 * the inner loop indexes the row directly instead of recomputing
 * `(y * width + x) * 4` per channel access.
 */
export function floodFillBitmap(
  image: BitmapFillImage,
  startX: number,
  startY: number,
  newColor: BitmapFillRGBA,
): BitmapFillResult {
  if (!isUsableImage(image)) return noChange(image);
  const x = Math.trunc(startX);
  const y = Math.trunc(startY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return noChange(image);
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return noChange(image);

  const { width, height } = image;
  const seedIndex = (y * width + x) * 4;
  const oldR = image.data[seedIndex]!;
  const oldG = image.data[seedIndex + 1]!;
  const oldB = image.data[seedIndex + 2]!;
  const oldA = image.data[seedIndex + 3]!;
  const [newR, newG, newB, newA] = normalizeColor(newColor);
  if (oldR === newR && oldG === newG && oldB === newB && oldA === newA) return noChange(image);

  const data = new Uint8ClampedArray(image.data);
  // Flat stack of pending seeds: [x0, y0, x1, y1, ...]. Pushed at most once per
  // contiguous neighbour run (see lastLeftMatched / lastRightMatched below).
  const stack: number[] = [x, y];
  let filledCount = 0;
  while (stack.length > 0) {
    const seedY = stack.pop()!;
    const seedX = stack.pop()!;

    // Walk up to the top of this column's matching run (mirrors the
    // `while (y > 0 && matchesColor_(x, y - 1, ...)) y--` preamble upstream).
    let row = seedY;
    while (row > 0) {
      const above = ((row - 1) * width + seedX) * 4;
      if (data[above] !== oldR || data[above + 1] !== oldG || data[above + 2] !== oldB || data[above + 3] !== oldA) break;
      row -= 1;
    }

    let lastLeftMatched = false;
    let lastRightMatched = false;
    for (; row < height; row += 1) {
      const index = (row * width + seedX) * 4;
      if (data[index] !== oldR || data[index + 1] !== oldG || data[index + 2] !== oldB || data[index + 3] !== oldA) break;
      data[index] = newR;
      data[index + 1] = newG;
      data[index + 2] = newB;
      data[index + 3] = newA;
      filledCount += 1;
      if (seedX > 0) {
        // Same-row left neighbour lives 4 bytes before this pixel.
        const left = index - 4;
        if (data[left] === oldR && data[left + 1] === oldG && data[left + 2] === oldB && data[left + 3] === oldA) {
          if (!lastLeftMatched) {
            stack.push(seedX - 1, row);
            lastLeftMatched = true;
          }
        } else {
          lastLeftMatched = false;
        }
      }
      if (seedX < width - 1) {
        // Same-row right neighbour lives 4 bytes after this pixel.
        const right = index + 4;
        if (data[right] === oldR && data[right + 1] === oldG && data[right + 2] === oldB && data[right + 3] === oldA) {
          if (!lastRightMatched) {
            stack.push(seedX + 1, row);
            lastRightMatched = true;
          }
        } else {
          lastRightMatched = false;
        }
      }
    }
  }
  if (filledCount === 0) return noChange(image);
  return { image: { width, height, data }, changed: true, filledCount };
}

/**
 * Global exact-match replacement of the seed pixel's color.
 * Shift-click in scratch-paint's fill tool (`floodFillAll`).
 *
 * Single strided pass over the pixel buffer (row-major, +4 bytes per pixel):
 * no per-pixel function calls and no per-pixel coordinate multiply. Painted
 * pixels cannot re-match because old and new colors differ, so one pass
 * suffices and `filledCount` is exact.
 */
export function floodFillAllBitmap(
  image: BitmapFillImage,
  startX: number,
  startY: number,
  newColor: BitmapFillRGBA,
): BitmapFillResult {
  if (!isUsableImage(image)) return noChange(image);
  const x = Math.trunc(startX);
  const y = Math.trunc(startY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return noChange(image);
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return noChange(image);

  const { width, height } = image;
  const seedIndex = (y * width + x) * 4;
  const oldR = image.data[seedIndex]!;
  const oldG = image.data[seedIndex + 1]!;
  const oldB = image.data[seedIndex + 2]!;
  const oldA = image.data[seedIndex + 3]!;
  const [newR, newG, newB, newA] = normalizeColor(newColor);
  if (oldR === newR && oldG === newG && oldB === newB && oldA === newA) return noChange(image);

  const data = new Uint8ClampedArray(image.data);
  let filledCount = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] === oldR && data[index + 1] === oldG && data[index + 2] === oldB && data[index + 3] === oldA) {
      data[index] = newR;
      data[index + 1] = newG;
      data[index + 2] = newB;
      data[index + 3] = newA;
      filledCount += 1;
    }
  }
  if (filledCount === 0) return noChange(image);
  return { image: { width, height, data }, changed: true, filledCount };
}

function emptyMask(): BitmapFillMaskResult {
  return { width: 0, height: 0, mask: new Uint8Array(0), changed: false, filledCount: 0, seedColor: undefined, bounds: undefined };
}

function maskNoChange(width: number, height: number): BitmapFillMaskResult {
  return { width, height, mask: new Uint8Array(width * height), changed: false, filledCount: 0, seedColor: undefined, bounds: undefined };
}

/**
 * Diff a repainted image against its source to build the fill mask.
 * Every pixel the solid fill changed becomes a `1` byte; everything else
 * stays `0`. The tight bounds of the set bits are tracked in the same pass
 * so callers can size gradients to the filled region.
 */
function maskFromRepainted(source: BitmapFillImage, repainted: BitmapFillImage): BitmapFillMaskResult {
  const { width, height } = source;
  const mask = new Uint8Array(width * height);
  const before = source.data;
  const after = repainted.data;
  let filledCount = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const rowBase = y * width;
    for (let x = 0; x < width; x += 1) {
      const byte = (rowBase + x) * 4;
      if (before[byte] !== after[byte] || before[byte + 1] !== after[byte + 1] || before[byte + 2] !== after[byte + 2] || before[byte + 3] !== after[byte + 3]) {
        mask[rowBase + x] = 1;
        filledCount += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (filledCount === 0) return maskNoChange(width, height);
  return {
    width,
    height,
    mask,
    changed: true,
    filledCount,
    seedColor: [before[(minY * width + minX) * 4]!, before[(minY * width + minX) * 4 + 1]!, before[(minY * width + minX) * 4 + 2]!, before[(minY * width + minX) * 4 + 3]!],
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

/**
 * Read the seed pixel with the same truncation/out-of-bounds semantics as the
 * solid fills. Returns `undefined` when there is no seed to match against.
 */
function readSeedColor(image: BitmapFillImage, startX: number, startY: number): [r: number, g: number, b: number, a: number] | undefined {
  const x = Math.trunc(startX);
  const y = Math.trunc(startY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return undefined;
  const index = (y * image.width + x) * 4;
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!, image.data[index + 3]!];
}

/**
 * Connected fill region as a mask: the same strict-RGBA 4-way region
 * `floodFillBitmap` would paint, but as `1` bytes instead of a new color.
 *
 * The region is derived by replaying the solid fill with a sentinel color
 * (seed red + 1 mod 256, which always differs from the seed) and diffing the
 * repainted image against the source. Because the scanline walk only depends
 * on the seed color — never on the replacement color, as long as it differs —
 * the mask is exactly the set of pixels the solid fill would repaint.
 * Callers composite their own paint (e.g. the selected gradient) through it.
 */
export function floodFillMaskBitmap(image: BitmapFillImage, startX: number, startY: number): BitmapFillMaskResult {
  if (!isUsableImage(image)) return emptyMask();
  const seed = readSeedColor(image, startX, startY);
  if (!seed) return maskNoChange(image.width, image.height);
  const sentinel: BitmapFillRGBA = [(seed[0] + 1) & 255, seed[1], seed[2], seed[3]];
  const repainted = floodFillBitmap(image, startX, startY, sentinel);
  if (!repainted.changed) return maskNoChange(image.width, image.height);
  const result = maskFromRepainted(image, repainted.image);
  // The seed color is the matched color, not the sentinel-painted one.
  return { ...result, seedColor: seed };
}

/**
 * Global exact-match region as a mask: the same whole-canvas replacement set
 * `floodFillAllBitmap` would paint (Shift-click), but as `1` bytes.
 * Derived the same way as `floodFillMaskBitmap` so the two stay in lockstep.
 */
export function floodFillAllMaskBitmap(image: BitmapFillImage, startX: number, startY: number): BitmapFillMaskResult {
  if (!isUsableImage(image)) return emptyMask();
  const seed = readSeedColor(image, startX, startY);
  if (!seed) return maskNoChange(image.width, image.height);
  const sentinel: BitmapFillRGBA = [(seed[0] + 1) & 255, seed[1], seed[2], seed[3]];
  const repainted = floodFillAllBitmap(image, startX, startY, sentinel);
  if (!repainted.changed) return maskNoChange(image.width, image.height);
  const result = maskFromRepainted(image, repainted.image);
  return { ...result, seedColor: seed };
}
