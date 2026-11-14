export type BitmapSelectionRect = { x: number; y: number; width: number; height: number }

type BitmapImageDataLike = {
  data: Uint8ClampedArray
  width: number
  height: number
}

// Mirror scratch-paint's getHitBounds: tighten a drag rectangle inwards so it
// only covers opaque pixels, ignoring transparent margins.
//
// Oracle notes (read-only, no third-party code copied):
// - The reference caller rounds both drag corners (`Math.round`) and clamps
//   to the canvas before trimming; the reference trim itself then scans for
//   `alpha !== 0` (so alpha 1 and semi-transparent both count as opaque) and
//   reports "no selection" for an all-transparent region (zero-area in the
//   reference, `undefined` here so callers can skip history/DOM writes).
// - Paper rectangles normalize reverse drags (from/to), so a drag from
//   bottom-right to top-left selects the same normalized region. This helper
//   therefore normalizes `rect` via min/max instead of rejecting negative
//   sizes, matching that end-to-end behavior for direct calls. Production
//   callers (Editor `bitmapRect`) already normalize, so this changes no
//   production path.
// - Non-finite rects and unusable images (bad dimensions/buffer length) are
//   fail-safe no-ops returning `undefined` instead of NaN rects or OOB reads.
export function trimBitmapRectToOpaque(image: BitmapImageDataLike, rect: BitmapSelectionRect): BitmapSelectionRect | undefined {
  const rawWidth = image?.width
  const rawHeight = image?.height
  if (!Number.isInteger(rawWidth) || !Number.isInteger(rawHeight)) return undefined
  const width = rawWidth as number
  const height = rawHeight as number
  if (width <= 0 || height <= 0) return undefined
  const data = image?.data
  if (!data || data.length !== width * height * 4) return undefined
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return undefined
  }
  // Normalize reverse drags (Paper from/to semantics), then round both corners
  // like the reference caller before clamping to the canvas.
  const x0 = Math.min(rect.x, rect.x + rect.width)
  const x1 = Math.max(rect.x, rect.x + rect.width)
  const y0 = Math.min(rect.y, rect.y + rect.height)
  const y1 = Math.max(rect.y, rect.y + rect.height)
  const left = Math.max(0, Math.min(width, Math.round(x0)))
  const top = Math.max(0, Math.min(height, Math.round(y0)))
  const right = Math.max(0, Math.min(width, Math.round(x1)))
  const bottom = Math.max(0, Math.min(height, Math.round(y1)))
  if (right <= left || bottom <= top) return undefined

  const rowBlank = (y: number) => {
    for (let x = left; x < right; x += 1) {
      if (data[(y * width + x) * 4 + 3] !== 0) return false
    }
    return true
  }
  const columnBlank = (x: number, topEdge: number, bottomEdge: number) => {
    for (let y = topEdge; y < bottomEdge; y += 1) {
      if (data[(y * width + x) * 4 + 3] !== 0) return false
    }
    return true
  }

  let trimmedTop = top
  let trimmedBottom = bottom
  let trimmedLeft = left
  let trimmedRight = right
  while (trimmedTop < trimmedBottom && rowBlank(trimmedTop)) trimmedTop += 1
  while (trimmedBottom - 1 >= trimmedTop && rowBlank(trimmedBottom - 1)) trimmedBottom -= 1
  while (trimmedLeft < trimmedRight && columnBlank(trimmedLeft, trimmedTop, trimmedBottom)) trimmedLeft += 1
  while (trimmedRight - 1 >= trimmedLeft && columnBlank(trimmedRight - 1, trimmedTop, trimmedBottom)) trimmedRight -= 1
  if (trimmedBottom <= trimmedTop || trimmedRight <= trimmedLeft) return undefined
  return { x: trimmedLeft, y: trimmedTop, width: trimmedRight - trimmedLeft, height: trimmedBottom - trimmedTop }
}
