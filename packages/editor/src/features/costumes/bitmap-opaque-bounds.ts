// Bitmap opaque-bounds scan for first-fit (clean-room, no third-party paint).
//
// Scratch `zoomToFit(isBitmap=true)` fits `getHitBounds(getRaster())`, i.e.
// the minimal opaque rect (alpha !== 0 counts, incl. semitransparent), not the
// placed source-image rect. This module derives that rect from the live canvas
// raster without mutating bitmap data/history:
//
// - Empty (zero opaque pixels) / unreadable raster => `undefined` so callers
//   publish `null` and the fit helper fails closed to the base reset.
// - Small canvases reuse the existing `trimBitmapRectToOpaque` helper on a
//   single readback (row/column-blank walk, same alpha rule).
// - Large canvases never allocate a full W*H*4 readback at once (that single
//   allocation can exceed the artboard area cap): top/bottom are found with
//   full-width horizontal strips, then left/right with vertical strips limited
//   to the opaque vertical span, each strip bounded by `tile` px.
// - Pure read path: only `getImageData` probes, no canvas writes, no VM/history
//   mutation. Stale serial/revision gating lives with the caller (Editor).

import { trimBitmapRectToOpaque } from './bitmap-selection'
import type { BitmapTrim } from './bitmap-artboard'

/** Strip height/width for the tiled scan (px). Bounds worst-case bytes. */
export const BITMAP_OPAQUE_SCAN_TILE = 128

/**
 * Single-readback area cap: at or below this canvas area a full `getImageData`
 * is used via the existing trim helper; above it the tiled walk runs so one
 * allocation never approaches the artboard area cap.
 */
export const BITMAP_OPAQUE_SCAN_SINGLE_AREA = 1_000_000

function isUsableCanvas(canvas: HTMLCanvasElement): boolean {
  const w = canvas?.width ?? 0
  const h = canvas?.height ?? 0
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
}

/**
 * Minimal opaque rect of the live canvas in canvas px, or `undefined` when
 * empty/unreadable. Never throws; failures fail closed to `undefined` (caller
 * publishes `null` => base reset) so a switch/undo/late-load race can never
 * emit stale bounds.
 */
export function scanBitmapOpaqueBounds(canvas: HTMLCanvasElement, tile = BITMAP_OPAQUE_SCAN_TILE): BitmapTrim | undefined {
  try {
    if (!canvas || !isUsableCanvas(canvas)) return undefined
    const w = canvas.width
    const h = canvas.height
    if (!(w > 0 && h > 0)) return undefined
    const step = Number.isFinite(tile) && tile > 0 ? Math.floor(tile) : BITMAP_OPAQUE_SCAN_TILE
    const area = w * h
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    // Small path: single readback through the existing trim helper (same
    // row/column-blank + alpha!==0 semantics as scratch `getHitBounds`).
    if (area <= BITMAP_OPAQUE_SCAN_SINGLE_AREA) {
      try {
        const image = ctx.getImageData(0, 0, w, h)
        const trimmed = trimBitmapRectToOpaque(image, { x: 0, y: 0, width: w, height: h })
        if (!trimmed) return undefined
        if (!(trimmed.width > 0 && trimmed.height > 0)) return undefined
        return { x: trimmed.x, y: trimmed.y, width: trimmed.width, height: trimmed.height }
      } catch {
        return undefined
      }
    }
    // Large path: tiled strips, never a full-canvas allocation.
    let top = -1
    try {
      outerTop: for (let y0 = 0; y0 < h; y0 += step) {
        const hh = Math.min(step, h - y0)
        const image = ctx.getImageData(0, y0, w, hh)
        const d = image.data
        for (let y = 0; y < hh; y += 1) {
          const row = y * w * 4
          for (let x = 0; x < w; x += 1) {
            if ((d[row + x * 4 + 3] ?? 0) !== 0) {
              top = y0 + y
              break outerTop
            }
          }
        }
      }
    } catch {
      return undefined
    }
    if (top < 0) return undefined
    let bottomExclusive = -1
    try {
      let y1 = h
      outerBottom: while (y1 > top) {
        const hh = Math.min(step, y1 - top)
        const y0 = y1 - hh
        const image = ctx.getImageData(0, y0, w, hh)
        const d = image.data
        for (let y = hh - 1; y >= 0; y -= 1) {
          const row = y * w * 4
          for (let x = 0; x < w; x += 1) {
            if ((d[row + x * 4 + 3] ?? 0) !== 0) {
              bottomExclusive = y0 + y + 1
              break outerBottom
            }
          }
        }
        y1 = y0
      }
    } catch {
      return undefined
    }
    if (!(bottomExclusive > top)) return undefined
    const sliceTop = top
    const sliceH = bottomExclusive - top
    let left = -1
    try {
      outerLeft: for (let x0 = 0; x0 < w; x0 += step) {
        const ww = Math.min(step, w - x0)
        const image = ctx.getImageData(x0, sliceTop, ww, sliceH)
        const d = image.data
        for (let x = 0; x < ww; x += 1) {
          for (let y = 0; y < sliceH; y += 1) {
            if ((d[(y * ww + x) * 4 + 3] ?? 0) !== 0) {
              left = x0 + x
              break outerLeft
            }
          }
        }
      }
    } catch {
      return undefined
    }
    if (left < 0) return undefined
    let rightExclusive = -1
    try {
      let x1 = w
      outerRight: while (x1 > left) {
        const ww = Math.min(step, x1 - left)
        const x0 = x1 - ww
        const image = ctx.getImageData(x0, sliceTop, ww, sliceH)
        const d = image.data
        for (let x = ww - 1; x >= 0; x -= 1) {
          for (let y = 0; y < sliceH; y += 1) {
            if ((d[(y * ww + x) * 4 + 3] ?? 0) !== 0) {
              rightExclusive = x0 + x + 1
              break outerRight
            }
          }
        }
        x1 = x0
      }
    } catch {
      return undefined
    }
    if (!(rightExclusive > left)) return undefined
    return { x: left, y: top, width: rightExclusive - left, height: bottomExclusive - top }
  } catch {
    return undefined
  }
}
