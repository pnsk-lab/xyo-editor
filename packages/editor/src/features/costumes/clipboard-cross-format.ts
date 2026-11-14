// Cross-format clipboard geometry for bitmap <-> vector copy/paste.
//
// Clean-room mapping that follows scratch-paint `copy-paste-hoc.jsx` /
// `keyboard-shortcuts-hoc.jsx` observable behavior without copying its
// source: a single shared stagger (`+10px * pasteOffset`, bumped per paste),
// position-preserving placement, transparent-hole preservation (any alpha
// !== 0 counts as content), sanitizer-gated vector entries, and history only
// on visible change.
//
// Coordinate conventions (see Editor.svelte):
// - Bitmap rectangles are live-artboard canvas pixels (sprite 960x720,
//   stage 480x360).
// - Vector rectangles are editor SVG units (480x360 viewBox).
// - `bitmapResolution` (1 for stage, 2 for sprites) converts canvas pixels to
//   SVG units for the bitmap -> vector path, mirroring
//   `convertCurrentCostumeToVector` (`trim.x / bitmapResolution`).
// - The vector -> bitmap path scales SVG units by the *destination asset*
//   resolution (`vectorToBitmapScaleForTarget`: 2 for sprites, 1 for stage),
//   mirroring the artboard mapping (sprite canvas px = 2 x unit, stage
//   canvas px = 1 x unit), so pasted ink keeps its VM world position and the
//   follow-up transparent-edge crop save round-trips it.
//   `VECTOR_TO_BITMAP_SCALE` (5) is kept only as the legacy default for
//   `vectorBoundsToBitmapAnchor`'s optional scale parameter.
// - The stagger itself follows the *destination* convention: +10 SVG units for
//   vector destinations (same as `pasteVectorSelection`), +10 canvas px for
//   bitmap destinations (same as `resolveBitmapPasteRect`).

export const CROSS_FORMAT_PASTE_STEP = 10

/** Legacy workspace canvas px per editor SVG unit (default scale parameter only). */
export const VECTOR_TO_BITMAP_SCALE = 5

/**
 * Canvas px per editor SVG unit for vector -> bitmap placement: the asset
 * bitmap resolution (2 for sprites, 1 for stage). Sprite unit (ux,uy) lands
 * on canvas (2*ux, 2*uy) [= artboard center + scratch*2 for centered art],
 * stage unit lands 1:1, so the cropped save keeps the pasted ink at the same
 * VM stage position as the vector source.
 */
export function vectorToBitmapScaleForTarget(isStage: boolean, storedResolution?: unknown): number {
  if (typeof storedResolution === 'number' && Number.isFinite(storedResolution) && storedResolution > 0) {
    return storedResolution
  }
  return isStage ? 1 : 2
}

export type CrossFormatSize = { width: number; height: number }

export type CrossFormatRect = { x: number; y: number; width: number; height: number }

export type CrossFormatImage = {
  width: number
  height: number
  data: Uint8ClampedArray | ArrayLike<number>
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * True when every pixel is fully transparent (alpha === 0). Any alpha !== 0
 * — including semitransparent holes — counts as content, matching
 * `trimBitmapRectToOpaque` / scratch-paint `getHitBounds` (`+3 !== 0`).
 */
export function isFullyTransparentImage(image: CrossFormatImage | undefined): boolean {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) return true
  if (image.width <= 0 || image.height <= 0) return true
  const { data } = image
  if (!data || data.length !== image.width * image.height * 4) return true
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) !== 0) return false
  }
  return true
}

function normalizeResolution(resolution: unknown): number {
  return typeof resolution === 'number' && Number.isFinite(resolution) && resolution > 0 ? resolution : 1
}

/**
 * Copy-time source snapshot bundled with the bitmap clipboard so a later
 * paste on another target / costume / stage-vs-sprite / res1-vs-res2
 * destination still maps through the *source* workspace. Canvas pixels were
 * captured at `resolution` (live artboard resolution at copy time, which
 * equals the stored asset resolution); the origin / canvas-center /
 * rotation-center companions pin the copy-time world frame (top-left
 * artboard alignment: canvas px / sourceResolution = SVG units) and
 * `copyPasteOffset` records the reset stagger base (always 1 after a copy).
 * Old clipboard state predates this snapshot (`undefined`), so every
 * consumer must fall back to the destination resolution.
 */
export type BitmapClipboardSourceSnapshot = {
  resolution: number
  originX: number
  originY: number
  canvasCenterX: number
  canvasCenterY: number
  rotationCenterX: number
  rotationCenterY: number
  isStage: boolean
  copyPasteOffset: number
}

function isFiniteNumberOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function createBitmapClipboardSourceSnapshot(input: {
  resolution: unknown
  destFallbackResolution: unknown
  originX: unknown
  originY: unknown
  canvasCenterX: unknown
  canvasCenterY: unknown
  rotationCenterX: unknown
  rotationCenterY: unknown
  isStage: boolean
  copyPasteOffset: unknown
}): BitmapClipboardSourceSnapshot {
  const destFallback =
    typeof input.destFallbackResolution === 'number' &&
    Number.isFinite(input.destFallbackResolution) &&
    (input.destFallbackResolution as number) > 0
      ? (input.destFallbackResolution as number)
      : 1
  const resolution =
    typeof input.resolution === 'number' && Number.isFinite(input.resolution) && (input.resolution as number) > 0
      ? (input.resolution as number)
      : destFallback
  return {
    resolution,
    originX: isFiniteNumberOrFallback(input.originX, 0),
    originY: isFiniteNumberOrFallback(input.originY, 0),
    canvasCenterX: isFiniteNumberOrFallback(input.canvasCenterX, 0),
    canvasCenterY: isFiniteNumberOrFallback(input.canvasCenterY, 0),
    rotationCenterX: isFiniteNumberOrFallback(input.rotationCenterX, 0),
    rotationCenterY: isFiniteNumberOrFallback(input.rotationCenterY, 0),
    isStage: input.isStage === true,
    copyPasteOffset:
      typeof input.copyPasteOffset === 'number' && Number.isFinite(input.copyPasteOffset)
        ? (input.copyPasteOffset as number)
        : 1,
  }
}

/**
 * Resolve the divisor for the bitmap -> vector path. Prefers the copy-time
 * source resolution (real size/position parity across res1/res2 and
 * stage/sprite switches: a sprite-res2 copy stays px/2 even when the
 * destination vector costume stores bitmapResolution=1 after
 * `convertCurrentCostumeToVector`); falls back to the destination
 * resolution for old clipboard state without a snapshot.
 */
export function resolveBitmapToVectorSourceResolution(
  sourceResolution: unknown,
  destFallbackResolution: unknown,
): number {
  if (typeof sourceResolution === 'number' && Number.isFinite(sourceResolution) && sourceResolution > 0) {
    return sourceResolution
  }
  return normalizeResolution(destFallbackResolution)
}

function normalizeScale(scale: unknown): number {
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : VECTOR_TO_BITMAP_SCALE
}

/**
 * Map a bitmap-canvas rect to editor SVG units for the bitmap -> vector
 * `<image>` placement, adding the shared destination stagger.
 * Returns undefined for empty / non-finite input.
 */
export function bitmapRectToVectorRect(
  rectCanvas: CrossFormatRect,
  resolution: number,
  offset: number,
): CrossFormatRect | undefined {
  if (!rectCanvas || !isFiniteNumber(rectCanvas.x) || !isFiniteNumber(rectCanvas.y)) return undefined
  if (!isFiniteNumber(rectCanvas.width) || !isFiniteNumber(rectCanvas.height)) return undefined
  if (rectCanvas.width <= 0 || rectCanvas.height <= 0) return undefined
  if (!isFiniteNumber(offset)) return undefined
  const safeResolution = normalizeResolution(resolution)
  const delta = CROSS_FORMAT_PASTE_STEP * offset
  return {
    x: rectCanvas.x / safeResolution + delta,
    y: rectCanvas.y / safeResolution + delta,
    width: rectCanvas.width / safeResolution,
    height: rectCanvas.height / safeResolution,
  }
}

/**
 * Map vector SVG bounds to a bitmap-canvas anchor (before stagger/clamp).
 * The caller feeds this anchor into `resolveBitmapPasteRect` together with
 * the raster size so stagger + canvas clamping stay identical to same-mode
 * bitmap paste. Returns undefined for empty / non-finite input.
 */
export function vectorBoundsToBitmapAnchor(
  boundsSvg: CrossFormatRect,
  scale: number = VECTOR_TO_BITMAP_SCALE,
): CrossFormatRect | undefined {
  if (!boundsSvg || !isFiniteNumber(boundsSvg.x) || !isFiniteNumber(boundsSvg.y)) return undefined
  if (!isFiniteNumber(boundsSvg.width) || !isFiniteNumber(boundsSvg.height)) return undefined
  if (boundsSvg.width <= 0 || boundsSvg.height <= 0) return undefined
  const safeScale = normalizeScale(scale)
  return {
    x: boundsSvg.x * safeScale,
    y: boundsSvg.y * safeScale,
    width: boundsSvg.width * safeScale,
    height: boundsSvg.height * safeScale,
  }
}

/** Union of SVG bounds; undefined when no positive-area bound exists. */
export function unionVectorBounds(bounds: readonly CrossFormatRect[]): CrossFormatRect | undefined {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const bound of bounds) {
    if (!bound || !isFiniteNumber(bound.x) || !isFiniteNumber(bound.y)) continue
    if (!isFiniteNumber(bound.width) || !isFiniteNumber(bound.height)) continue
    if (bound.width <= 0 || bound.height <= 0) continue
    left = Math.min(left, bound.x)
    top = Math.min(top, bound.y)
    right = Math.max(right, bound.x + bound.width)
    bottom = Math.max(bottom, bound.y + bound.height)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return undefined
  }
  if (right <= left || bottom <= top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Build an `<image>` element for the bitmap -> vector path. The href must be
 * an allowlisted embedded-raster `data:` URL (`data:image/png;base64,…`,
 * produced by the Editor canvas encoder); anything else returns '' so the
 * caller treats it as a no-op instead of importing an external vector.
 */
export function buildVectorImageMarkup(href: string, rect: CrossFormatRect): string {
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
  if (!rect || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y)) return ''
  if (!isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) return ''
  if (rect.width <= 0 || rect.height <= 0) return ''
  const safe = escapeXmlAttribute(href)
  // Self-contained `xmlns:xlink`: the Paper-import fragment sanitizer wraps
  // bare elements in a plain `<svg>` root, so an undeclared `xlink:` prefix
  // would be a fail-closed XML parse error. Declaring it on the element keeps
  // the fragment parse-safe in any wrapper (the same pattern the sanitizer
  // audit fixtures use); full documents additionally declare it on `<svg>`.
  return `<image xmlns:xlink="http://www.w3.org/1999/xlink" href="${safe}" xlink:href="${safe}" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"/>`
}

/**
 * Build a standalone SVG document holding exactly the pasted vector units for
 * the vector -> bitmap raster step. Items keep their absolute coordinates and
 * the viewBox is the union bounds, so relative layout survives the raster.
 * Returns '' when there is nothing rasterizable.
 */
export function buildVectorPasteRasterDocument(
  units: readonly string[],
  bounds: CrossFormatRect,
  defs: string = '',
): string {
  if (!bounds || !isFiniteNumber(bounds.x) || !isFiniteNumber(bounds.y)) return ''
  if (!isFiniteNumber(bounds.width) || !isFiniteNumber(bounds.height)) return ''
  if (bounds.width <= 0 || bounds.height <= 0) return ''
  const body = [...units.map((unit) => unit.trim()).filter((unit) => unit.length > 0)]
  if (body.length === 0) return ''
  const defsBlock = defs.trim().length > 0 ? `<defs>${defs}</defs>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}">` +
    `${defsBlock}${body.join('')}</svg>`
  )
}
