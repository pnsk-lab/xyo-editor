// Bitmap artboard geometry (clean-room, no third-party paint source).
//
// Display workspace vs stored asset separation:
// - The edit canvas is a Scratch artboard sized from the STORED asset
//   resolution R: 480x360 stage units x R (sprite default R=2 -> 960x720,
//   stage default R=1 -> 480x360; a stored res1 sprite therefore edits on a
//   480x360 canvas, not 960x720). Its center pixel maps to Scratch (0,0).
// - A stored bitmap (W0 x H0, center c0, resolution R) is placed verbatim at
//   artboard origin O = artCenter(R) - c0, transparent margins elsewhere.
// - Saving crops to opaque bounds T and stores center c' = canvasCenter -
//   T.origin with the STORED resolution R, so cropped bytes reload onto the
//   same pixels and the VM scratch bounds (W/R, cx/R) never change.
// - Huge sources expand the canvas to union(artboard, source rect); when the
//   union exceeds the memory budget the workspace falls back to the verbatim
//   source rect (full W0 x H0, never truncated). When even the source itself
//   exceeds the side/area budget the placement is marked `refused`: callers must
//   NOT allocate/truncate and must leave the stored asset unmodified with an
//   explicit user-facing rejection.

export const BITMAP_SPRITE_ARTBOARD_WIDTH = 960
export const BITMAP_SPRITE_ARTBOARD_HEIGHT = 720
export const BITMAP_SPRITE_ARTBOARD_RESOLUTION = 2
export const BITMAP_SPRITE_ARTBOARD_CENTER_X = 480
export const BITMAP_SPRITE_ARTBOARD_CENTER_Y = 360

export const BITMAP_STAGE_ARTBOARD_WIDTH = 480
export const BITMAP_STAGE_ARTBOARD_HEIGHT = 360
export const BITMAP_STAGE_ARTBOARD_RESOLUTION = 1
export const BITMAP_STAGE_ARTBOARD_CENTER_X = 240
export const BITMAP_STAGE_ARTBOARD_CENTER_Y = 180

/** Stage units covered by every artboard (canvas pixels = units x resolution). */
export const BITMAP_ARTBOARD_STAGE_UNITS_WIDTH = 480
export const BITMAP_ARTBOARD_STAGE_UNITS_HEIGHT = 360

/** Memory guard: union-workspace side cap and total-area cap. */
export const BITMAP_ARTBOARD_MAX_SIDE = 4096
export const BITMAP_ARTBOARD_MAX_AREA = 16_777_216

/**
 * Non-destructive source cap: a stored side longer than this is refused
 * before any canvas is allocated. Observed headless-Chrome 2D raster limit
 * (2026-11-12, Chrome 156) is 65535 = 2^16 - 1: 65535x2 rasterizes while
 * 65536x2 allocates (width readback OK, ctx non-null) but stays blank with
 * toBlob null. The exact raster ceiling is environment dependent (GPU vs
 * headless), so this static pre-cap is only the first gate: the editor
 * additionally verifies the live raster (readback + sampled ink +
 * encode probe) and refuses when the environment cannot hold the pixels,
 * keeping asset bytes/metadata untouched.
 */
export const BITMAP_SOURCE_MAX_SIDE = 65535

export type BitmapArtboard = {
  width: number
  height: number
  resolution: number
  centerX: number
  centerY: number
}

export type BitmapPlacedCanvas = {
  width: number
  height: number
  canvasCenterX: number
  canvasCenterY: number
  originX: number
  originY: number
  /** Workspace resolution (always the stored asset resolution). */
  resolution: number
  /** True when the union exceeded the memory cap and fell back to the source. */
  limited: boolean
  /**
   * True when even the source itself exceeds the area budget. The returned
   * width/height still describe the full source rect (never truncated), but
   * callers must NOT allocate a canvas of that size: refuse the edit
   * explicitly and keep the stored asset unmodified.
   */
  refused: boolean
}

export type BitmapTrim = { x: number; y: number; width: number; height: number }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeResolution(value: unknown, fallback: number): number {
  if (isFiniteNumber(value) && (value as number) > 0) return value as number
  return fallback > 0 ? fallback : 1
}

/** Default workspace resolution for a target with no stored asset yet. */
export function defaultBitmapResolution(isStage: boolean): number {
  return isStage ? 1 : 2
}

export function artboardForTarget(isStage: boolean, resolution?: unknown): BitmapArtboard {
  const res = normalizeResolution(resolution, defaultBitmapResolution(isStage))
  // Canonical artboards keep their historic pixel sizes; any other stored
  // resolution sizes the artboard from stage units (480x360 x R) so res1
  // sprites edit on 480x360 with the center at 240,180.
  if (resolution === undefined) {
    if (isStage) {
      return {
        width: BITMAP_STAGE_ARTBOARD_WIDTH,
        height: BITMAP_STAGE_ARTBOARD_HEIGHT,
        resolution: BITMAP_STAGE_ARTBOARD_RESOLUTION,
        centerX: BITMAP_STAGE_ARTBOARD_CENTER_X,
        centerY: BITMAP_STAGE_ARTBOARD_CENTER_Y,
      }
    }
    return {
      width: BITMAP_SPRITE_ARTBOARD_WIDTH,
      height: BITMAP_SPRITE_ARTBOARD_HEIGHT,
      resolution: BITMAP_SPRITE_ARTBOARD_RESOLUTION,
      centerX: BITMAP_SPRITE_ARTBOARD_CENTER_X,
      centerY: BITMAP_SPRITE_ARTBOARD_CENTER_Y,
    }
  }
  const width = Math.max(1, Math.round(BITMAP_ARTBOARD_STAGE_UNITS_WIDTH * res))
  const height = Math.max(1, Math.round(BITMAP_ARTBOARD_STAGE_UNITS_HEIGHT * res))
  return { width, height, resolution: res, centerX: width / 2, centerY: height / 2 }
}

function normalizeCenter(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? (value as number) : fallback
}

/**
 * Pure pre-allocation gate: true when a W x H source must be refused before
 * any canvas exists (side over the raster-safe cap, non-positive/NaN dims,
 * or area over the memory budget). Callers keep the stored asset
 * byte-identical and surface the explicit refusal status.
 */
export function isBitmapSourceSizeRefused(sourceWidth: unknown, sourceHeight: unknown): boolean {
  if (!isFiniteNumber(sourceWidth) || !isFiniteNumber(sourceHeight)) return true
  const w = sourceWidth as number
  const h = sourceHeight as number
  if (!(w > 0 && h > 0)) return true
  if (w > BITMAP_SOURCE_MAX_SIDE || h > BITMAP_SOURCE_MAX_SIDE) return true
  // Guard the w*h product against float overflow: compare via division.
  if (w > BITMAP_ARTBOARD_MAX_AREA / Math.max(1, h)) return true
  return false
}

export type BitmapRasterEvidence = {
  /** Intended (placed) canvas size. */
  width: number
  height: number
  /** Actual canvas readback size (undefined when unreadable). */
  readbackWidth?: unknown
  readbackHeight?: unknown
  /** False when getContext/getImageData threw or returned unusable data. */
  readable: boolean
  /** True when the decoded source is known to carry opaque pixels. */
  sourceHasOpaque: boolean
  /** True when the live canvas shows at least one opaque pixel. */
  liveHasOpaque: boolean
  /** False when a full-canvas encode probe resolved null/threw. Omit when unprobed. */
  encodeOk?: boolean
}

/**
 * Pure verdict over live-raster evidence (no DOM here so unit tests run in
 * Node; the editor supplies the evidence from a detached probe + the live
 * canvas). Any mismatch fails closed to refusal: dims mismatch, unreadable
 * raster, opaque source with a blank live canvas (the 65536x2 silent-blank
 * vector), or a failed encode probe. A genuinely transparent source
 * (blank live, blank source) is NOT a refusal.
 */
export function isBitmapRasterRefused(evidence: BitmapRasterEvidence): boolean {
  const { width, height, readable, sourceHasOpaque, liveHasOpaque } = evidence
  if (!(width > 0 && height > 0)) return true
  if (isBitmapSourceSizeRefused(width, height)) return true
  if (readable !== true) return true
  if (typeof evidence.readbackWidth === 'number' && typeof evidence.readbackHeight === 'number') {
    if (evidence.readbackWidth !== width || evidence.readbackHeight !== height) return true
  }
  if (sourceHasOpaque && !liveHasOpaque) return true
  if (evidence.encodeOk === false) return true
  return false
}

/**
 * Place a stored source on the resolution-matched artboard. Small sources
 * stay exactly on the artboard; huge sources grow the canvas to the union of
 * the artboard rect and the placed source rect. Over the memory cap the
 * workspace falls back to the verbatim source rect (full pixels, never
 * truncated); when the source itself exceeds the area budget the result is
 * marked `refused` so the caller can reject the edit without touching ink.
 */
export function placeSourceOnArtboard(
  sourceWidth: number,
  sourceHeight: number,
  centerX: number,
  centerY: number,
  isStage: boolean,
  storedResolution?: unknown,
): BitmapPlacedCanvas {
  const resolution = normalizeResolution(storedResolution, defaultBitmapResolution(isStage))
  const art = artboardForTarget(isStage, resolution)
  const sw = isFiniteNumber(sourceWidth) && sourceWidth > 0 ? Math.round(sourceWidth) : 1
  const sh = isFiniteNumber(sourceHeight) && sourceHeight > 0 ? Math.round(sourceHeight) : 1
  const cx = normalizeCenter(centerX, sw / 2)
  const cy = normalizeCenter(centerY, sh / 2)
  const wantOriginX = art.centerX - cx
  const wantOriginY = art.centerY - cy
  const minX = Math.min(0, wantOriginX)
  const minY = Math.min(0, wantOriginY)
  const maxX = Math.max(art.width, wantOriginX + sw)
  const maxY = Math.max(art.height, wantOriginY + sh)
  const unionWidth = Math.round(maxX - minX)
  const unionHeight = Math.round(maxY - minY)
  const unionFits =
    unionWidth <= BITMAP_ARTBOARD_MAX_SIDE &&
    unionHeight <= BITMAP_ARTBOARD_MAX_SIDE &&
    unionWidth * unionHeight <= BITMAP_ARTBOARD_MAX_AREA
  if (unionFits) {
    return {
      width: unionWidth,
      height: unionHeight,
      canvasCenterX: art.centerX - minX,
      canvasCenterY: art.centerY - minY,
      originX: wantOriginX - minX,
      originY: wantOriginY - minY,
      resolution,
      limited: false,
      refused: false,
    }
  }
  // Union over budget: keep every stored pixel via the verbatim source rect.
  // The side cap governs the union workspace only; the source rect itself is
  // never truncated (e.g. 5000x12 keeps all 5000 columns). Sources over the
  // non-destructive side/area caps are refused so the caller rejects the edit
  // without touching ink (65536-wide sides allocate a blank raster with a
  // null encode: persisting it would silently blank the asset).
  if (isBitmapSourceSizeRefused(sw, sh)) {
    return {
      width: sw,
      height: sh,
      canvasCenterX: cx,
      canvasCenterY: cy,
      originX: 0,
      originY: 0,
      resolution,
      limited: true,
      refused: true,
    }
  }
  return {
    width: sw,
    height: sh,
    canvasCenterX: cx,
    canvasCenterY: cy,
    originX: 0,
    originY: 0,
    resolution,
    limited: true,
    refused: false,
  }
}

/** Empty-canvas workspace (no source bytes yet): the bare artboard. */
export function emptyArtboardCanvas(isStage: boolean, storedResolution?: unknown): BitmapPlacedCanvas {
  const art = artboardForTarget(isStage, storedResolution ?? defaultBitmapResolution(isStage))
  return {
    width: art.width,
    height: art.height,
    canvasCenterX: art.centerX,
    canvasCenterY: art.centerY,
    originX: art.centerX,
    originY: art.centerY,
    resolution: art.resolution,
    limited: false,
    refused: false,
  }
}

/** Canvas pixel (top-left origin) -> Scratch units via the canvas center. */
export function canvasPixelToScratch(
  px: number,
  py: number,
  canvasCenterX: number,
  canvasCenterY: number,
  resolution: number,
): { sx: number; sy: number } {
  const res = isFiniteNumber(resolution) && resolution > 0 ? resolution : 1
  return { sx: (px - canvasCenterX) / res, sy: (canvasCenterY - py) / res }
}

/** Stored-asset pixel -> Scratch units via its rotation center. */
export function assetPixelToScratch(
  ix: number,
  iy: number,
  cx: number,
  cy: number,
  resolution: number,
): { sx: number; sy: number } {
  const res = isFiniteNumber(resolution) && resolution > 0 ? resolution : 1
  return { sx: (ix - cx) / res, sy: (cy - iy) / res }
}

/**
 * Transparent-edge crop save: opaque canvas rect -> stored PNG + center.
 * The stored resolution is preserved verbatim (never re-derived from the
 * target kind), so res1 sprites stay res1 and stage stays res1.
 */
export function croppedSaveForTrim(
  trim: BitmapTrim,
  canvasCenterX: number,
  canvasCenterY: number,
  isStage: boolean,
  storedResolution?: unknown,
): { width: number; height: number; rotationCenterX: number; rotationCenterY: number; bitmapResolution: number } {
  return {
    width: Math.max(1, Math.round(trim.width)),
    height: Math.max(1, Math.round(trim.height)),
    rotationCenterX: canvasCenterX - trim.x,
    rotationCenterY: canvasCenterY - trim.y,
    bitmapResolution: normalizeResolution(storedResolution, defaultBitmapResolution(isStage)),
  }
}

/** Opaque bounds of RGBA bytes (alpha > 0 counts, incl. semitransparent). */
export function opaqueTrimFromRgba(data: Uint8ClampedArray | Uint8Array, width: number, height: number): BitmapTrim | undefined {
  if (!(width > 0 && height > 0) || !data || data.length < width * height * 4) return undefined
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) === 0) continue
      if (x < left) left = x
      if (y < top) top = y
      if (x > right) right = x
      if (y > bottom) bottom = y
    }
  }
  if (right < left) return undefined
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/** Byte equality for the same-content Save guard (no empty Undo). */
export function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b) return false
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}
