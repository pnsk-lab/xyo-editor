// Costume format-conversion geometry (clean-room, no third-party paint source).
//
// What this module does:
// - Pure coordinate math for vector<->bitmap costume conversion that preserves
//   the runtime (VM) stage appearance: scratch-unit bounds, rotation center,
//   and ink position. It never touches the DOM, canvas, network, or Paper.js,
//   so unit tests run in Node.
// - The DOM/canvas raster steps stay in `Editor.svelte` (sanitized SVG bytes
//   -> <img> -> canvas for vector->bitmap; canvas trim -> data: PNG -> SVG
//   text for bitmap->vector). This module only computes sizes/centers and
//   builds the final vector SVG text from an allowlisted data: URL.
//
// Coordinate model (matches `packages/vm/src/index.ts` `drawCostumeImage` /
// `drawBackdropImage` / `targetCostumeBox`):
// - A sprite costume with pixel size W x H, resolution R, and rotation center
//   (cx, cy) in asset pixels renders `W / R` x `H / R` scratch units, with
//   scratch bounds left=-cx/R, right=(W-cx)/R, top=cy/R, bottom=-(H-cy)/R.
//   Vector costumes use R=1; sprite bitmaps use R=2; stage bitmaps use R=1.
// - Preserving appearance therefore means preserving `W / R`, `H / R`,
//   `cx / R`, and `cy / R` (plus the ink offset inside the costume for the
//   trimmed bitmap->vector path).
//
// Why the previous mapping was wrong (recorded here so tests pin it):
// - vector->bitmap rasterized every sprite SVG (e.g. 96x96) into a fixed
//   2400x1800 workspace canvas by stretching it to 480x360 (`drawImage` with
//   480x360 dest), then stored the whole 2400x1800 PNG with resolution 2 and
//   kept the old SVG center (48,50). The stored scratch size became
//   2400/2 x 1800/2 = 1200x900 units (12.5x too wide) and the center stayed
//   48/2=24 units off instead of 48 units.
// - bitmap->vector built a full-canvas SVG (`2400/2 x 1800/2 = 1200x900`)
//   with the trimmed image placed at `trim / resolution` while keeping the old
//   bitmap center. For a correctly sized asset centered with padding this
//   shifts the ink (full-canvas padding moves the scratch origin), and for a
//   legacy full-bleed 2400 canvas it keeps the 1200x900 blow-up.
// - The reference behavior this fixes toward places the *drawing bounds* at
//   1:1 coordinates: the converted asset is sized to the content (SVG size x
//   resolution, or trimmed bitmap size / resolution) with the center scaled by
//   the same factor, so `W / R` and `cx / R` are invariant.
//
// Compatibility:
// - The formulas below use the *actual* source size/center/trim, so legacy
//   oversized 2400x1800 bitmaps keep their (oversized) on-stage appearance
//   after bitmap->vector (the new SVG is also oversized by the same factor)
//   instead of jumping. New vector->bitmap assets are correctly sized, so old
//   works are untouched (no migration of stored bytes).
// - Stage uses resolution 1, sprites use resolution 2, matching the VM and
//   the existing `updateBitmapCostumeFromCanvas` convention.

export const CONVERSION_BITMAP_RESOLUTION_STAGE = 1
export const CONVERSION_BITMAP_RESOLUTION_SPRITE = 2
export const CONVERSION_VECTOR_RESOLUTION = 1

/**
 * Non-destructive conversion caps (mirror the bitmap artboard source caps:
 * the converted raster must survive a real Canvas2D raster + PNG encode in
 * this environment). Vector->bitmap targets above the side cap, or bitmap->
 * vector sources above it, are refused before any canvas is allocated or any
 * asset is overwritten: persisting a blank raster/encode as an empty SVG
 * would silently destroy the stored bytes (65536x2 vector). The static side
 * cap is the first gate; the editor additionally verifies the live raster
 * and the encode result and refuses when the environment cannot hold them.
 */
export const CONVERSION_MAX_SIDE = 65535
export const CONVERSION_MAX_AREA = 16_777_216

/** True when a W x H converted raster must be refused before allocating. */
export function isConversionRasterSizeRefused(width: unknown, height: unknown): boolean {
  if (typeof width !== 'number' || typeof height !== 'number') return true
  if (!Number.isFinite(width) || !Number.isFinite(height)) return true
  if (!(width > 0 && height > 0)) return true
  if (width > CONVERSION_MAX_SIDE || height > CONVERSION_MAX_SIDE) return true
  if (width > CONVERSION_MAX_AREA / Math.max(1, height)) return true
  return false
}

/** True when a vector->bitmap spec must be refused (never rasterize/write). */
export function isVectorToBitmapSpecRefused(spec: { bitmapWidth: number; bitmapHeight: number } | undefined): boolean {
  if (!spec) return true
  return isConversionRasterSizeRefused(spec.bitmapWidth, spec.bitmapHeight)
}

/** True when a bitmap->vector conversion must be refused (never overwrite). */
export function isBitmapToVectorSourceRefused(
  canvasWidth: unknown,
  canvasHeight: unknown,
  trim?: { width: unknown; height: unknown } | undefined,
): boolean {
  if (isConversionRasterSizeRefused(canvasWidth, canvasHeight)) return true
  // A trimmed raster larger than the cap can never encode faithfully either.
  if (trim && typeof trim.width === 'number' && typeof trim.height === 'number') {
    if (trim.width > CONVERSION_MAX_SIDE || trim.height > CONVERSION_MAX_SIDE) return true
    if (trim.width > 0 && trim.height > 0 && trim.width > CONVERSION_MAX_AREA / Math.max(1, trim.height)) return true
  }
  return false
}

export type ConversionTrim = { x: number; y: number; width: number; height: number }

export type SvgGeometry = {
  width: number
  height: number
  viewBoxX: number
  viewBoxY: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeResolution(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && (value as number) > 0 ? (value as number) : fallback
}

function normalizeCenter(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? (value as number) : fallback
}

/** Target bitmap resolution: 1 for stage, 2 for sprites. */
export function targetBitmapResolution(isStage: boolean): number {
  return isStage ? CONVERSION_BITMAP_RESOLUTION_STAGE : CONVERSION_BITMAP_RESOLUTION_SPRITE
}

/**
 * Parse an SVG document's geometry without touching the DOM (regex only, no
 * network). Returns width/height in SVG units with the same fallbacks the
 * editor uses elsewhere (stage 480x360, sprite 96x96), plus the viewBox
 * origin (0,0 when absent/unparseable). Never throws.
 */
export function parseConversionSvgGeometry(svgText: unknown, isStage: boolean): SvgGeometry {
  const fallbackWidth = isStage ? 480 : 96
  const fallbackHeight = isStage ? 360 : 96
  if (typeof svgText !== 'string' || svgText.length === 0) {
    return { width: fallbackWidth, height: fallbackHeight, viewBoxX: 0, viewBoxY: 0 }
  }
  try {
    const svgOpen = /<svg\b[^>]*>/i.exec(svgText)
    const tag = svgOpen?.[0] ?? ''
    const width = parseSvgLength(/width\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1])
    const height = parseSvgLength(/height\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1])
    const viewBoxRaw = /viewBox\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    const viewBoxParts = viewBoxRaw
      .trim()
      .split(/[\s,]+/)
      .filter((part) => part.length > 0)
      .map(Number)
    const viewBoxX = viewBoxParts.length >= 1 && Number.isFinite(viewBoxParts[0]) ? (viewBoxParts[0] as number) : 0
    const viewBoxY = viewBoxParts.length >= 2 && Number.isFinite(viewBoxParts[1]) ? (viewBoxParts[1] as number) : 0
    const viewBoxWidth = viewBoxParts.length >= 3 && Number.isFinite(viewBoxParts[2]) ? (viewBoxParts[2] as number) : undefined
    const viewBoxHeight = viewBoxParts.length >= 4 && Number.isFinite(viewBoxParts[3]) ? (viewBoxParts[3] as number) : undefined
    return {
      width: width ?? viewBoxWidth ?? fallbackWidth,
      height: height ?? viewBoxHeight ?? fallbackHeight,
      viewBoxX,
      viewBoxY,
    }
  } catch {
    return { width: fallbackWidth, height: fallbackHeight, viewBoxX: 0, viewBoxY: 0 }
  }
}

function parseSvgLength(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  // Accept `96`, `96px`, `96.5`, `1e2`; reject percentages and other units
  // (they need layout context the converter does not have).
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(px)?$/i.exec(trimmed)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export type VectorToBitmapSpec = {
  /** Stored PNG pixels. */
  bitmapWidth: number
  bitmapHeight: number
  bitmapResolution: number
  rotationCenterX: number
  rotationCenterY: number
}

/**
 * Compute the bitmap asset that renders exactly like the source SVG.
 * `svgWidth`/`svgHeight` are SVG units; `rotationCenter` is in SVG units
 * (resolution 1). The result scales both by the target bitmap resolution, so
 * `bitmapWidth / bitmapResolution === svgWidth` and
 * `rotationCenterX / bitmapResolution === svgCenterX`.
 */
export function resolveVectorToBitmapSpec(input: {
  svgWidth: number
  svgHeight: number
  rotationCenterX?: number
  rotationCenterY?: number
  isStage: boolean
}): VectorToBitmapSpec {
  const resolution = targetBitmapResolution(input.isStage)
  const svgWidth = isFiniteNumber(input.svgWidth) && input.svgWidth > 0 ? input.svgWidth : input.isStage ? 480 : 96
  const svgHeight = isFiniteNumber(input.svgHeight) && input.svgHeight > 0 ? input.svgHeight : input.isStage ? 360 : 96
  const centerX = normalizeCenter(input.rotationCenterX, svgWidth / 2)
  const centerY = normalizeCenter(input.rotationCenterY, svgHeight / 2)
  return {
    bitmapWidth: Math.max(1, Math.round(svgWidth * resolution)),
    bitmapHeight: Math.max(1, Math.round(svgHeight * resolution)),
    bitmapResolution: resolution,
    rotationCenterX: centerX * resolution,
    rotationCenterY: centerY * resolution,
  }
}

export type BitmapToVectorSpec = {
  svgWidth: number
  svgHeight: number
  /** Placement of the trimmed PNG inside the new SVG (SVG units). Null when fully transparent. */
  image: { x: number; y: number; width: number; height: number } | null
  rotationCenterX: number
  rotationCenterY: number
  bitmapResolution: number
}

/**
 * Compute the vector asset that renders exactly like the source bitmap.
 * `canvasWidth`/`canvasHeight` are the bitmap canvas pixels (which equal the
 * stored PNG pixels in the current editor: the workspace canvas is stored
 * verbatim). `trim` is the opaque bounds in the same pixels (undefined when
 * fully transparent). `rotationCenter`/`bitmapResolution` describe the source
 * bitmap. The result keeps every scratch-unit measure invariant:
 * - Full-canvas bounds: `svgWidth === canvasWidth / resolution` would hold for
 *   a full-bleed canvas; with a trim the SVG is sized to the *drawing bounds*
 *   (`trim.width / resolution`), and the center is shifted by the trim origin
 *   (`(center - trim.x) / resolution`) so the ink stays at the same scratch
 *   position with the image at the trimmed origin (0,0). Fully transparent sources keep the full-canvas size with no
 *   image (still transparent, same bounds for compatibility).
 */
export function resolveBitmapToVectorSpec(input: {
  canvasWidth: number
  canvasHeight: number
  trim?: ConversionTrim
  rotationCenterX?: number
  rotationCenterY?: number
  bitmapResolution: number
}): BitmapToVectorSpec {
  const resolution = normalizeResolution(input.bitmapResolution, 1)
  const canvasWidth = isFiniteNumber(input.canvasWidth) && input.canvasWidth > 0 ? input.canvasWidth : 1
  const canvasHeight = isFiniteNumber(input.canvasHeight) && input.canvasHeight > 0 ? input.canvasHeight : 1
  const sourceCenterX = normalizeCenter(input.rotationCenterX, canvasWidth / 2)
  const sourceCenterY = normalizeCenter(input.rotationCenterY, canvasHeight / 2)
  const trim = normalizeTrim(input.trim, canvasWidth, canvasHeight)
  if (!trim) {
    return {
      svgWidth: Math.max(1, canvasWidth / resolution),
      svgHeight: Math.max(1, canvasHeight / resolution),
      image: null,
      rotationCenterX: sourceCenterX / resolution,
      rotationCenterY: sourceCenterY / resolution,
      bitmapResolution: resolution,
    }
  }
  return {
    svgWidth: Math.max(1, trim.width / resolution),
    svgHeight: Math.max(1, trim.height / resolution),
    image: {
      x: 0,
      y: 0,
      width: trim.width / resolution,
      height: trim.height / resolution,
    },
    rotationCenterX: (sourceCenterX - trim.x) / resolution,
    rotationCenterY: (sourceCenterY - trim.y) / resolution,
    bitmapResolution: resolution,
  }
}

export type BitmapVectorConvertPlacement = {
  /** Canvas geometry the vector spec is resolved against. */
  canvasWidth: number
  canvasHeight: number
  /** Rotation center in the same canvas pixels. */
  rotationCenterX: number
  rotationCenterY: number
}

function normalizeTrim(trim: ConversionTrim | undefined, canvasWidth: number, canvasHeight: number): ConversionTrim | undefined {
  if (!trim) return undefined
  if (!isFiniteNumber(trim.x) || !isFiniteNumber(trim.y)) return undefined
  if (!isFiniteNumber(trim.width) || !isFiniteNumber(trim.height)) return undefined
  if (trim.width <= 0 || trim.height <= 0) return undefined
  // Clamp fail-closed into the canvas instead of throwing on rounding drift.
  const x = Math.min(Math.max(0, trim.x), canvasWidth)
  const y = Math.min(Math.max(0, trim.y), canvasHeight)
  const width = Math.min(trim.width, canvasWidth - x)
  const height = Math.min(trim.height, canvasHeight - y)
  if (width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

/**
 * Resolve the bitmap->vector conversion placement on the bitmap artboard.
 * `trim` is the live opaque bounds (canvas pixels); the stored center lives
 * in asset pixels and is mapped onto the canvas through the tracked artboard
 * origin, so the converted SVG keeps the VM world position. When the live
 * canvas is fully transparent (`trim` undefined), the geometry falls back to
 * the decoded stored asset dims/center (not the artboard workspace), so an
 * empty round-trip keeps its size (transparent 192x192 -> 96x96 vector)
 * instead of blowing up to the artboard bounds. Without either, the live
 * canvas is used verbatim (fail-closed compatibility).
 */
export function resolveBitmapVectorConvertPlacement(input: {
  trim?: ConversionTrim
  storedWidth?: number
  storedHeight?: number
  storedCenterX?: number
  storedCenterY?: number
  liveWidth: number
  liveHeight: number
  artCenterX: number
  artCenterY: number
  artOriginX: number
  artOriginY: number
}): BitmapVectorConvertPlacement {
  const liveWidth = isFiniteNumber(input.liveWidth) && input.liveWidth > 0 ? input.liveWidth : 1
  const liveHeight = isFiniteNumber(input.liveHeight) && input.liveHeight > 0 ? input.liveHeight : 1
  const artCenterX = isFiniteNumber(input.artCenterX) ? (input.artCenterX as number) : liveWidth / 2
  const artCenterY = isFiniteNumber(input.artCenterY) ? (input.artCenterY as number) : liveHeight / 2
  const artOriginX = isFiniteNumber(input.artOriginX) ? (input.artOriginX as number) : 0
  const artOriginY = isFiniteNumber(input.artOriginY) ? (input.artOriginY as number) : 0
  const impliedCenterX = artCenterX - artOriginX
  const impliedCenterY = artCenterY - artOriginY
  const storedCenterX = normalizeCenter(input.storedCenterX, impliedCenterX)
  const storedCenterY = normalizeCenter(input.storedCenterY, impliedCenterY)
  const trim = normalizeTrim(input.trim, liveWidth, liveHeight)
  if (trim) {
    return {
      canvasWidth: liveWidth,
      canvasHeight: liveHeight,
      rotationCenterX: artOriginX + storedCenterX,
      rotationCenterY: artOriginY + storedCenterY,
    }
  }
  const storedWidth = isFiniteNumber(input.storedWidth) && (input.storedWidth as number) > 0 ? Math.round(input.storedWidth as number) : 0
  const storedHeight = isFiniteNumber(input.storedHeight) && (input.storedHeight as number) > 0 ? Math.round(input.storedHeight as number) : 0
  if (storedWidth > 0 && storedHeight > 0) {
    return {
      canvasWidth: storedWidth,
      canvasHeight: storedHeight,
      rotationCenterX: isFiniteNumber(input.storedCenterX) ? (input.storedCenterX as number) : storedWidth / 2,
      rotationCenterY: isFiniteNumber(input.storedCenterY) ? (input.storedCenterY as number) : storedHeight / 2,
    }
  }
  return {
    canvasWidth: liveWidth,
    canvasHeight: liveHeight,
    rotationCenterX: artOriginX + storedCenterX,
    rotationCenterY: artOriginY + storedCenterY,
  }
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatSvgNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  // Keep full precision for center/size round-trips (no 3-decimal quantization:
  // rotation centers like 48/50 and 240/180 must survive byte-for-byte, and
  // trimmed placements like 1104/2=552 must not drift).
  if (Number.isInteger(value)) return String(value)
  return String(value)
}

/**
 * Build the converted vector SVG text from a spec and an allowlisted embedded
 * raster `data:` URL. Returns '' when the href is not allowlisted (caller
 * treats it as a fail-closed no-op with no history). The document uses a
 * `0 0 W H` viewBox with the trimmed image at its spec position; a null image
 * yields an empty (fully transparent) document of the same size. Never throws,
 * never fetches.
 */
export function buildConvertedVectorSvg(spec: BitmapToVectorSpec, href: string): string {
  try {
    if (!spec || !isFiniteNumber(spec.svgWidth) || !isFiniteNumber(spec.svgHeight)) return ''
    if (spec.svgWidth <= 0 || spec.svgHeight <= 0) return ''
    const width = formatSvgNumber(spec.svgWidth)
    const height = formatSvgNumber(spec.svgHeight)
    const open =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    if (!spec.image) return `${open}</svg>`
    if (typeof href !== 'string' || href.length === 0) return ''
    const compact = href.trim().toLowerCase()
    const allowed = [
      'data:image/png;base64,',
      'data:image/jpeg;base64,',
      'data:image/jpg;base64,',
      'data:image/gif;base64,',
      'data:image/webp;base64,',
    ]
    if (!allowed.some((prefix) => compact.startsWith(prefix))) return ''
    const image = spec.image
    if (!isFiniteNumber(image.x) || !isFiniteNumber(image.y)) return ''
    if (!isFiniteNumber(image.width) || !isFiniteNumber(image.height)) return ''
    if (image.width <= 0 || image.height <= 0) return ''
    const safe = escapeXmlAttribute(href)
    return (
      `${open}<image href="${safe}" xlink:href="${safe}" ` +
      `x="${formatSvgNumber(image.x)}" y="${formatSvgNumber(image.y)}" ` +
      `width="${formatSvgNumber(image.width)}" height="${formatSvgNumber(image.height)}"/></svg>`
    )
  } catch {
    return ''
  }
}

/**
 * Scratch-unit bounds of a costume (the quantity the stage renderer draws).
 * Used by tests to assert the conversion preserves on-stage position/size:
 * vector `W,H,cx,cy,R=1` vs bitmap `W,H,cx,cy,R` must yield equal bounds.
 */
export function conversionScratchBounds(input: {
  width: number
  height: number
  rotationCenterX: number
  rotationCenterY: number
  resolution: number
}): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
  const resolution = normalizeResolution(input.resolution, 1)
  const width = isFiniteNumber(input.width) ? input.width : 0
  const height = isFiniteNumber(input.height) ? input.height : 0
  const cx = isFiniteNumber(input.rotationCenterX) ? input.rotationCenterX : 0
  const cy = isFiniteNumber(input.rotationCenterY) ? input.rotationCenterY : 0
  const left = -cx / resolution
  const right = (width - cx) / resolution
  const top = cy / resolution
  const bottom = -(height - cy) / resolution
  return { left, right, top, bottom, width: right - left, height: top - bottom }
}
