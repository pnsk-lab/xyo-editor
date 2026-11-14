// Full-coverage live-raster pixel proof (clean-room, no third-party paint).
//
// Split from `Editor.svelte#verifyBitmapLiveRaster` per file-splitting rules:
// this module owns the independent pixel comparison, the editor only wires
// canvas/context/size gates, the encode probe, and the `isBitmapRasterRefused`
// verdict (stale serial/revision gating stays with the caller).
//
// What it proves: every pixel of the placed source rect matches the live
// canvas, chunk-by-chunk, from an INDEPENDENT source readback (sub-rect
// `drawImage` of the decoded image onto a tiny tile canvas) vs the live
// readback of the same window. A single dropped opaque pixel refuses.
//   - Alpha must match exactly (a 255-vs-0 dropout is the data-loss vector).
//   - RGB is ignored ONLY when both alphas are 0 (transparent-black
//     normalisation after the canvas round-trip). Otherwise RGB is compared
//     in premultiplied space with a +-2 tolerance for premultiply/unpremultiply
//     rounding and gamut wobble. Straight RGB at tiny alphas is invisible by
//     construction, so it is weighted by alpha (perceptual).
//   - Integer origins use the fast sub-rect path (tile-bounded, no full-size
//     allocation). Fractional origins (odd-size small art, dragged center)
//     replicate the exact filtered draw on a same-size reference and compare
//     that reference tile-by-tile; fractional references over
//     `FRACTIONAL_REF_MAX_AREA` refuse rather than allocate huge.
//   - Margins outside the placed rect must stay transparent (catches stale
//     preview / HMR pollution). Anything clipped (placed rect outside the
//     canvas) fails closed.
// Tile-bounded memory: no tile exceeds `TILE_PIXELS` px.
//
// Size gate (D1 fix): mirrors the canonical `isBitmapSourceSizeRefused`
// (side over 65535, area over 16_777_216, non-positive/non-finite dims) and
// applies it to BOTH the decoded source size and the canvas size BEFORE any
// allocation. A dead raster (e.g. 100000x2: paints do not stick, encode null)
// reads back blank on both sides, so without this gate an opaque-intent
// source would false-pass as transparent. Fail closed here instead.
// Canonical source: `features/costumes/bitmap-artboard.ts`.
//
// Extent gate (D2 fix): the full source rect
// `[originX, originX + decodedWidth] x [originY, originY + decodedHeight]`
// must sit entirely inside the canvas with no clipping, for integer AND
// fractional origins alike. A normal fractional translation fully inside the
// canvas (e.g. 8.5,6.25) still verifies via the filtered reference; any
// overhang (including a half-pixel clip such as -0.5) refuses, exactly like
// the integer -1 case. Small floating epsilon (1e-9) absorbs binary
// representation noise around exact edges.
//
// Length gate (D4 fix): `liveRasterPixelsMatch` refuses when the two buffers
// have different lengths (unreachable via the product path, where both sides
// are always sw*sh*4, but fail closed for direct callers instead of silently
// comparing the shared prefix).
//
// Tolerance disclosure (no perfect-pixel claim):
//   - FALSE POSITIVE (by design, perceptual): at tiny alpha the premultiplied
//     projection collapses large straight-RGB differences, so e.g.
//     (255,255,255,1) vs (0,0,0,1) passes. Alpha itself is still exact, so no
//     ink appears or disappears; only the invisible colour payload differs.
//   - FALSE NEGATIVE avoided (why straight comparison is wrong): at tiny
//     alpha the canvas premultiply round-trip moves straight RGB by large
//     amounts, so a straight-RGB gate would refuse healthy pixels. The alpha-
//     weighted (premultiplied) gate is required, not optional.
//   - Opaque end: premultiplied == straight, so the +-2 gate is an exact +-2
//     output-unit window. Real-Chrome measurements in this repo show drift 0
//     on the opaque sweep and on the real drawImage path; other engines are
//     unmeasured, so the +-2 window is kept as a conservative compatibility
//     bound and is NOT tightened on the basis of one engine's zero.

/** Per-tile pixel budget (px). Bounds every transient allocation. */
export const BITMAP_LIVE_VERIFY_TILE_PIXELS = 262144

/** Full-size fractional reference cap (px). Over it, fail closed. */
export const BITMAP_LIVE_VERIFY_FRACTIONAL_REF_MAX_AREA = 2_000_000

const RGB_TOLERANCE_PREMUL = 2

/** Canonical side cap (mirrors `BITMAP_SOURCE_MAX_SIDE`). */
const LIVE_VERIFY_MAX_SIDE = 65535

/** Canonical area cap (mirrors `BITMAP_ARTBOARD_MAX_AREA`). */
const LIVE_VERIFY_MAX_AREA = 16_777_216

/** Local mirror of `isBitmapSourceSizeRefused` (kept in-module so this proof
 *  fails closed even when a future caller skips the editor pre-gate). */
function isLiveVerifySizeRefused(w: unknown, h: unknown): boolean {
  if (typeof w !== 'number' || typeof h !== 'number') return true
  if (!Number.isFinite(w) || !Number.isFinite(h)) return true
  if (!(w > 0 && h > 0)) return true
  if (w > LIVE_VERIFY_MAX_SIDE || h > LIVE_VERIFY_MAX_SIDE) return true
  // Guard the w*h product against float overflow: compare via division.
  if (w > LIVE_VERIFY_MAX_AREA / Math.max(1, h)) return true
  return false
}

/**
 * Pure byte comparator over two same-length RGBA buffers.
 * Returns `match` false on the first alpha/RGB disagreement and reports
 * whether the SOURCE side carried any opaque pixel.
 * Buffers of different lengths refuse (`match: false`); the source side is
 * still scanned for opacity so callers can distinguish "genuinely blank"
 * from "opaque ink lost".
 */
export function liveRasterPixelsMatch(
  src: Uint8ClampedArray | Uint8Array,
  dst: Uint8ClampedArray | Uint8Array,
): { match: boolean; sawOpaque: boolean } {
  if (src.length !== dst.length) {
    let sawOpaque = false
    for (let i = 3; i < src.length; i += 4) {
      if ((src[i] ?? 0) !== 0) {
        sawOpaque = true
        break
      }
    }
    return { match: false, sawOpaque }
  }
  let sawOpaque = false
  const length = src.length
  for (let i = 0; i + 3 < length + 1; i += 4) {
    const sa = src[i + 3] ?? 0
    const la = dst[i + 3] ?? 0
    if (sa !== 0) sawOpaque = true
    if (sa !== la) return { match: false, sawOpaque }
    if (sa === 0) continue
    const sr = src[i] ?? 0
    const sg = src[i + 1] ?? 0
    const sb = src[i + 2] ?? 0
    const lr = dst[i] ?? 0
    const lg = dst[i + 1] ?? 0
    const lb = dst[i + 2] ?? 0
    if (sr === lr && sg === lg && sb === lb) continue
    const psr = Math.round((sr * sa) / 255)
    const psg = Math.round((sg * sa) / 255)
    const psb = Math.round((sb * sa) / 255)
    const plr = Math.round((lr * la) / 255)
    const plg = Math.round((lg * la) / 255)
    const plb = Math.round((lb * la) / 255)
    if (Math.abs(psr - plr) > RGB_TOLERANCE_PREMUL || Math.abs(psg - plg) > RGB_TOLERANCE_PREMUL || Math.abs(psb - plb) > RGB_TOLERANCE_PREMUL) {
      return { match: false, sawOpaque }
    }
  }
  return { match: true, sawOpaque }
}

export type BitmapPlacedPixelsProof = {
  /** True when every placed pixel (and transparent margins) verified. */
  ok: boolean
  /** True when the placed source carried any opaque pixel. */
  sourceHasOpaque: boolean
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const EXTENT_EPS = 1e-9

/**
 * Chunked placed-rect proof. Reads the live canvas read-only (tiled) and an
 * independent source readback (tiled sub-rect draws, never the full-size
 * raster). Never throws; every failure mode returns `{ ok: false }` so the
 * caller refuses non-destructively. Stale serial/revision gating lives with
 * the caller: this function only compares what it is given.
 */
export async function verifyBitmapPlacedPixels(
  image: CanvasImageSource,
  decodedWidth: number,
  decodedHeight: number,
  originX: number,
  originY: number,
  canvasWidth: number,
  canvasHeight: number,
  live: CanvasRenderingContext2D,
): Promise<BitmapPlacedPixelsProof> {
  const fail = (sourceHasOpaque: boolean): BitmapPlacedPixelsProof => ({ ok: false, sourceHasOpaque })
  try {
    // Size gate first (D1): fail closed before any canvas exists.
    if (isLiveVerifySizeRefused(decodedWidth, decodedHeight)) return fail(false)
    if (isLiveVerifySizeRefused(canvasWidth, canvasHeight)) return fail(false)
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) return fail(false)
    const originXi = Math.round(originX)
    const originYi = Math.round(originY)
    const integerOrigin = Math.abs(originX - originXi) < 1e-9 && Math.abs(originY - originYi) < 1e-9
    // Extent gate (D2): the full source rect must sit inside the canvas with
    // no clipping, fractional or not. Normal fully-inside fractional
    // translations pass; any overhang (including -0.5) refuses.
    const insideX = originX >= -EXTENT_EPS && originX + decodedWidth <= canvasWidth + EXTENT_EPS
    const insideY = originY >= -EXTENT_EPS && originY + decodedHeight <= canvasHeight + EXTENT_EPS
    if (!insideX || !insideY) return fail(false)
    if (integerOrigin && (originXi < 0 || originYi < 0 || originXi + decodedWidth > canvasWidth || originYi + decodedHeight > canvasHeight)) {
      return fail(false)
    }
    let sourceHasOpaque = false
    if (!integerOrigin) {
      const area = canvasWidth * canvasHeight
      if (!(area > 0) || area > BITMAP_LIVE_VERIFY_FRACTIONAL_REF_MAX_AREA) return fail(false)
      const ref = document.createElement('canvas')
      ref.width = canvasWidth
      ref.height = canvasHeight
      const refCtx = ref.getContext('2d')
      if (!refCtx) return fail(false)
      try {
        refCtx.clearRect(0, 0, canvasWidth, canvasHeight)
        refCtx.drawImage(image, originX, originY, decodedWidth, decodedHeight)
      } catch {
        return fail(sourceHasOpaque)
      }
      let refPixels: ImageData
      let livePixels: ImageData
      try {
        refPixels = refCtx.getImageData(0, 0, canvasWidth, canvasHeight)
        livePixels = live.getImageData(0, 0, canvasWidth, canvasHeight)
      } catch {
        return fail(sourceHasOpaque)
      }
      const compared = liveRasterPixelsMatch(refPixels.data, livePixels.data)
      if (!compared.match) return fail(compared.sawOpaque || sourceHasOpaque)
      return { ok: true, sourceHasOpaque: compared.sawOpaque }
    }
    const tileHBase = Math.max(1, Math.min(decodedHeight, 512))
    const tileWBase = Math.max(1, Math.min(decodedWidth, Math.floor(BITMAP_LIVE_VERIFY_TILE_PIXELS / tileHBase)))
    const srcCanvas = document.createElement('canvas')
    let srcCtx: CanvasRenderingContext2D | null = null
    let tiles = 0
    for (let sy = 0; sy < decodedHeight; sy += tileHBase) {
      const sh = Math.min(tileHBase, decodedHeight - sy)
      for (let sx = 0; sx < decodedWidth; sx += tileWBase) {
        const sw = Math.min(tileWBase, decodedWidth - sx)
        const dx = originXi + sx
        const dy = originYi + sy
        if (srcCanvas.width !== sw || srcCanvas.height !== sh) {
          srcCanvas.width = sw
          srcCanvas.height = sh
          srcCtx = null
        }
        if (!srcCtx) {
          srcCtx = srcCanvas.getContext('2d')
          if (!srcCtx) return fail(sourceHasOpaque)
        }
        let srcData: ImageData
        let liveData: ImageData
        try {
          srcCtx.clearRect(0, 0, sw, sh)
          srcCtx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
          srcData = srcCtx.getImageData(0, 0, sw, sh)
          liveData = live.getImageData(dx, dy, sw, sh)
        } catch {
          return fail(sourceHasOpaque)
        }
        const compared = liveRasterPixelsMatch(srcData.data, liveData.data)
        if (compared.sawOpaque) sourceHasOpaque = true
        if (!compared.match) return fail(sourceHasOpaque)
        tiles += 1
        if (tiles % 8 === 0) await yieldToEventLoop()
      }
    }
    const marginRects: Array<[number, number, number, number]> = []
    if (originYi > 0) marginRects.push([0, 0, canvasWidth, originYi])
    if (originYi + decodedHeight < canvasHeight) marginRects.push([0, originYi + decodedHeight, canvasWidth, canvasHeight - (originYi + decodedHeight)])
    if (originXi > 0) marginRects.push([0, originYi, originXi, decodedHeight])
    if (originXi + decodedWidth < canvasWidth) marginRects.push([originXi + decodedWidth, originYi, canvasWidth - (originXi + decodedWidth), decodedHeight])
    for (const [mx, my, mw, mh] of marginRects) {
      if (!(mw > 0 && mh > 0)) continue
      const mTileW = Math.max(1, Math.min(mw, 512))
      const mTileH = Math.max(1, Math.min(mh, Math.floor(BITMAP_LIVE_VERIFY_TILE_PIXELS / mTileW)))
      for (let y = my; y < my + mh; y += mTileH) {
        const th = Math.min(mTileH, my + mh - y)
        for (let x = mx; x < mx + mw; x += mTileW) {
          const tw = Math.min(mTileW, mx + mw - x)
          let d: ImageData
          try {
            d = live.getImageData(x, y, tw, th)
          } catch {
            return fail(sourceHasOpaque)
          }
          const arr = d.data
          for (let i = 3; i < arr.length; i += 4) {
            if ((arr[i] ?? 0) !== 0) return fail(sourceHasOpaque)
          }
          tiles += 1
          if (tiles % 16 === 0) await yieldToEventLoop()
        }
      }
    }
    return { ok: true, sourceHasOpaque }
  } catch {
    return fail(false)
  }
}
