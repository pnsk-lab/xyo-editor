export type BitmapMarqueePoint = { x: number; y: number }

export type BitmapMarqueeRect = { x: number; y: number; width: number; height: number }

// Bitmap marquee quantization (select-tool drag only).
//
// The select marquee resolves fractional canvas-pixel drag corners in the
// live viewport scale, mirroring the reference Paper select behavior:
// `guides.js rectSelect` offsets both Paper corners by half a screen pixel
// (`0.5 / paperZoom`) and `selection-box-tool.js onMouseUpBitmap` rounds
// each normalized edge before clamping to the board and trimming inward to
// opaque pixels. `bitmapPoint` already recovers canvas pixels from CSS, so
// the same half-screen offset applies in canvas px as
// `(0.5 / paperZoom) / k` where `k` is Paper units per canvas px
// (`storedResolution === 1 ? 2 : 1`, matching `bitmapPaperPerCanvasPx`).
// For res2 (`k = 1`) this is exactly `Math.round(edge + 0.5 / paperZoom)`;
// for res1 (`k = 2`) it is the half-screen equivalent in canvas px,
// keeping the visual guide and the rounded selection aligned at every zoom.
// Outward floor/ceil would keep up to one extra transparent pixel ring on
// every fractional drag (e.g. a drag of 10.6 -> 20.4 would still cover
// pixel 10, while round(10.6) = 11 excludes it), and a minimum size of 1
// would turn sub-half-pixel jitter into a one-pixel selection. Returning a
// possibly empty rect lets the opaque trim collapse those drags to
// "no selection" (history-free, like a click).
//
// Only the bitmap marquee uses this. Shape/text padding boxes keep the
// outward `bitmapRect` so their stroke margins are never clipped.
export function bitmapMarqueeRect(
  start: BitmapMarqueePoint,
  end: BitmapMarqueePoint,
  canvasWidth: number,
  canvasHeight: number,
  paperZoom?: number,
  storedResolution?: number,
): BitmapMarqueeRect {
  if (
    !start ||
    !end ||
    !Number.isFinite(start.x) ||
    !Number.isFinite(start.y) ||
    !Number.isFinite(end.x) ||
    !Number.isFinite(end.y) ||
    !Number.isInteger(canvasWidth) ||
    !Number.isInteger(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const paperPerCanvasPx = storedResolution === 1 ? 2 : 1
  const zoom = typeof paperZoom === 'number' && Number.isFinite(paperZoom) && paperZoom > 0 ? paperZoom : undefined
  const offset = zoom === undefined ? 0 : 0.5 / zoom / paperPerCanvasPx
  const x0 = Math.min(start.x, end.x) + offset
  const x1 = Math.max(start.x, end.x) + offset
  const y0 = Math.min(start.y, end.y) + offset
  const y1 = Math.max(start.y, end.y) + offset
  const left = Math.max(0, Math.min(canvasWidth, Math.round(x0)))
  const top = Math.max(0, Math.min(canvasHeight, Math.round(y0)))
  const right = Math.max(0, Math.min(canvasWidth, Math.round(x1)))
  const bottom = Math.max(0, Math.min(canvasHeight, Math.round(y1)))
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
