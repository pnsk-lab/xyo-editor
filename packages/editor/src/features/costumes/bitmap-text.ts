import { isVectorTextEmpty, resolveTextBaseDirection, splitVectorTextLines } from './vector-text'

/**
 * Inline bitmap-text helpers.
 *
 * Canvas 2D has no DOM text node, so the editor shows the same overlay
 * textarea as vector mode and rasterizes once on commit. These pure helpers
 * keep the geometry/font math testable without a browser canvas.
 */

export const BITMAP_TEXT_MIN_FONT_SIZE = 8
export const BITMAP_TEXT_MAX_FONT_SIZE = 200
/**
 * Bitmap multiline advance, in em. Matches the reference paint text tool,
 * which creates `PointText({ fontSize: 40, leading: 46.15 })` for both vector
 * and bitmap and sets the edit textarea to `lineHeight = leading / fontSize`
 * (see `.tmp/scratch-editor/.../helper/tools/text-tool.js` `handleMouseDown`
 * / `beginTextEdit`; no source copied). Paper draws each row at `y += leading`
 * (`PointText._draw`: `ctx.translate(0, leading)`) and reports the block as
 * `numLines * leading` (`_getBounds`), and the bitmap commit rasterizes that
 * item (`rasterize(72, ..., drawnBounds)`), so the raster rows advance by the
 * same `leading`. The ratio `46.15 / 40 = 1.15375` therefore drives the canvas
 * `fillText` row offsets, the gradient block, and the overlay-independent
 * helper below. Single-line commits are unaffected (`firstY` equals the click
 * when there is one row); `textAlign`/`textBaseline` stay `center`/`middle`.
 */
export const BITMAP_TEXT_LINE_HEIGHT = 46.15 / 40
export const BITMAP_TEXT_MAX_CHARS = 500
export const BITMAP_TEXT_DEFAULT_FONT_SIZE = 40
export const BITMAP_TEXT_DEFAULT_FONT_FAMILY = 'Sans Serif'

export function clampBitmapTextFontSize(value: number) {
  if (!Number.isFinite(value)) return BITMAP_TEXT_DEFAULT_FONT_SIZE
  return Math.min(BITMAP_TEXT_MAX_FONT_SIZE, Math.max(BITMAP_TEXT_MIN_FONT_SIZE, Math.round(value)))
}

export function splitBitmapTextLines(text: string) {
  return splitVectorTextLines(text).map((line) => line.slice(0, BITMAP_TEXT_MAX_CHARS))
}

export function isBitmapTextEmpty(text: string) {
  return isVectorTextEmpty(text)
}

export function resolveBitmapTextFont(fontSize: number, fontFamily: string) {
  return `${clampBitmapTextFontSize(fontSize)}px ${fontFamily || BITMAP_TEXT_DEFAULT_FONT_FAMILY}`
}

/**
 * Estimate the tight block used for gradient fills and selection padding.
 * Mirrors the 0.55em average advance + 46.15/40 line height the canvas painter
 * uses, so the gradient geometry matches the rasterized glyphs.
 */
export function bitmapTextBlockBounds(x: number, y: number, text: string, fontSize: number) {
  const size = clampBitmapTextFontSize(fontSize)
  const lines = splitBitmapTextLines(text)
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const width = Math.max(size, longest * size * 0.55)
  const height = Math.max(size, lines.length * size * BITMAP_TEXT_LINE_HEIGHT)
  return { x: x - width / 2, y: y - height / 2, width, height }
}

export function bitmapTextLineHeight(fontSize: number) {
  return clampBitmapTextFontSize(fontSize) * BITMAP_TEXT_LINE_HEIGHT
}

/**
 * Intended canvas `textAlign` for a draft. LTR stays `'center'` (the raster
 * path in the editor draws centered, unchanged); RTL resolves to `'right'` so
 * the click point is the right edge of the block, matching the vector anchor
 * and the reference locale-based justification.
 */
export function resolveBitmapTextAlign(text: string, documentDir?: unknown): 'center' | 'right' {
  return resolveTextBaseDirection(text, documentDir) === 'rtl' ? 'right' : 'center'
}

/**
 * Heuristic advance of one line when no canvas measurement is available.
 * Same 0.55em average advance the block-bounds estimator uses, so the
 * fallback commit offset and the gradient geometry agree with each other.
 */
export function estimateBitmapTextLineWidth(line: string, fontSize: number) {
  const size = clampBitmapTextFontSize(fontSize)
  return Math.max(size, line.length * size * 0.55)
}

/** Optional per-line canvas measurement (`ctx.measureText(line).width`). */
export type BitmapTextLineMeasure = (line: string, font: string) => number | undefined

/**
 * Shared widest-line measurement for RTL raster text (canvas `measureText`
 * with the 0.55em heuristic as fallback). Used by both the pre-shift commit
 * point and the per-line right-aligned draw so the two agree on the same
 * width.
 */
export function measureBitmapTextWidestLine(
  text: string,
  fontSize: number,
  fontFamily: string,
  measure?: BitmapTextLineMeasure,
): number {
  const font = resolveBitmapTextFont(fontSize, fontFamily)
  let width = 0
  for (const line of splitBitmapTextLines(text)) {
    const source = line.length === 0 ? ' ' : line
    let measured: number | undefined
    try {
      measured = measure?.(source, font)
    } catch {
      measured = undefined
    }
    if (!Number.isFinite(measured as number)) measured = undefined
    width = Math.max(width, measured ?? estimateBitmapTextLineWidth(source, fontSize))
  }
  return width
}

/**
 * Right edge x for a per-line right-aligned RTL draw. The caller pre-shifts
 * the commit point left by half the widest line (see
 * {@link resolveBitmapTextCommitPoint}); drawing every row with
 * `textAlign="right"` at `point.x + widest/2` restores the original click
 * as the shared right edge so short rows no longer center on the longest
 * line. Falls back to the commit point when the width is degenerate.
 */
export function resolveBitmapTextRtlDrawX(
  commitX: number,
  text: string,
  fontSize: number,
  fontFamily: string,
  measure?: BitmapTextLineMeasure,
): number {
  const widest = measureBitmapTextWidestLine(text, fontSize, fontFamily, measure)
  if (!(widest > 0)) return commitX
  return commitX + widest / 2
}

/**
 * Map a click point to the raster point the centered canvas draw call needs
 * so an RTL block lands right-based: LTR points pass through untouched, RTL
 * points shift left by half the widest line. The editor then draws every RTL
 * row right-aligned at {@link resolveBitmapTextRtlDrawX}, so multiline
 * blocks align each row's right edge on the click (not just the longest).
 */
export function resolveBitmapTextCommitPoint(
  point: { x: number; y: number },
  text: string,
  fontSize: number,
  fontFamily: string,
  documentDir?: unknown,
  measure?: BitmapTextLineMeasure,
) {
  if (resolveTextBaseDirection(text, documentDir) !== 'rtl') return { x: point.x, y: point.y }
  const width = measureBitmapTextWidestLine(text, fontSize, fontFamily, measure)
  if (!(width > 0)) return { x: point.x, y: point.y }
  return { x: point.x - width / 2, y: point.y }
}
