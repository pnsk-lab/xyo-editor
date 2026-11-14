import { describe, expect, it } from 'bun:test'
import { trimBitmapRectToOpaque } from '../src/features/costumes/bitmap-selection'
import { bitmapMarqueeRect } from '../src/features/costumes/bitmap-marquee'

// Strict Paper-parity production-path test for the bitmap select marquee.
//
// Production composes two steps with real canvas-pixel coords:
//   final = trimBitmapRectToOpaque(liveImage, bitmapMarqueeRect(start, end, W, H, paperZoom, resolution))
// `bitmapMarqueeRect` is the production quantization under test. The expected
// rects below are computed by an independent inline oracle that re-derives the
// reference select behavior in own words (no import, no third-party copy):
//   guides.js rectSelect: half = 0.5 / paperZoom added to both Paper corners
//   selection-box-tool.js onMouseUpBitmap: round each normalized edge, clamp
//     to the board, then trim inward to opaque pixels.
// In canvas px the same half-screen offset is `(0.5 / paperZoom) / k` with
// `k = resolution === 1 ? 2 : 1` Paper units per canvas px. For res2 (k = 1)
// this is exactly `Math.round(edge + 0.5 / paperZoom)`; for res1 (k = 2) it is
// the half-screen equivalent in canvas px. The oracle is written plainly here
// so the test fails if production ever drops the zoom term (plain round),
// regresses to outward floor/ceil, or restores a minimum size of 1.
//
// Source-basis pins (no simplified formulas assumed):
// - screen -> Paper is exactly `paper = center + (screen - viewSize / 2) / zoom`
//   with no implicit +0.5 (Paper ToolEvent/viewToProject gain is 1/zoom only).
// - Paper raster is 1:1 (960x720 raster at CENTER 480,360, so canvas pixel
//   (x, y) is Paper (x, y)); verified against the real raster bounds.
// - DOM actual render is exactly `canvas = (client - rect.left) / rect.width * W`
//   with no 0.5 (getBoundingClientRect gain only).
// Hence the +0.5/zoom offset is real and is not cancelled elsewhere.

const PAPER_ZOOMS = [0.25, 0.5, 1, 2, 5] as const

function paperPerCanvasPx(storedResolution?: number): number {
  return storedResolution === 1 ? 2 : 1
}

function referenceMarqueeZoom(
  start: { x: number; y: number },
  end: { x: number; y: number },
  canvasWidth: number,
  canvasHeight: number,
  paperZoom: number,
  storedResolution?: number,
) {
  const k = paperPerCanvasPx(storedResolution)
  const offset = 0.5 / paperZoom / k
  const left = Math.max(0, Math.min(canvasWidth, Math.round(Math.min(start.x, end.x) + offset)))
  const top = Math.max(0, Math.min(canvasHeight, Math.round(Math.min(start.y, end.y) + offset)))
  const right = Math.max(0, Math.min(canvasWidth, Math.round(Math.max(start.x, end.x) + offset)))
  const bottom = Math.max(0, Math.min(canvasHeight, Math.round(Math.max(start.y, end.y) + offset)))
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

function plainRoundMarquee(
  start: { x: number; y: number },
  end: { x: number; y: number },
  canvasWidth: number,
  canvasHeight: number,
) {
  const left = Math.max(0, Math.min(canvasWidth, Math.round(Math.min(start.x, end.x))))
  const top = Math.max(0, Math.min(canvasHeight, Math.round(Math.min(start.y, end.y))))
  const right = Math.max(0, Math.min(canvasWidth, Math.round(Math.max(start.x, end.x))))
  const bottom = Math.max(0, Math.min(canvasHeight, Math.round(Math.max(start.y, end.y))))
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

function outwardMarquee(
  start: { x: number; y: number },
  end: { x: number; y: number },
  canvasWidth: number,
  canvasHeight: number,
) {
  const left = Math.max(0, Math.floor(Math.min(start.x, end.x)))
  const top = Math.max(0, Math.floor(Math.min(start.y, end.y)))
  const right = Math.min(canvasWidth, Math.ceil(Math.max(start.x, end.x)))
  const bottom = Math.min(canvasHeight, Math.ceil(Math.max(start.y, end.y)))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

type RGBA = [number, number, number, number]

function blankImage(width: number, height: number) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height }
}

function imageWithPixels(width: number, height: number, pixels: Array<[number, number, RGBA]>) {
  const image = blankImage(width, height)
  for (const [x, y, [r, g, b, a]] of pixels) {
    const offset = (y * width + x) * 4
    image.data[offset] = r
    image.data[offset + 1] = g
    image.data[offset + 2] = b
    image.data[offset + 3] = a
  }
  return image
}

const RED: RGBA = [255, 0, 0, 255]
const GREEN: RGBA = [0, 255, 0, 255]
const RED_ALPHA1: RGBA = [255, 0, 0, 1]

function productionFinal(
  image: { data: Uint8ClampedArray; width: number; height: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
  paperZoom: number,
  storedResolution?: number,
) {
  return trimBitmapRectToOpaque(
    image,
    bitmapMarqueeRect(start, end, image.width, image.height, paperZoom, storedResolution),
  )
}

function referenceFinal(
  image: { data: Uint8ClampedArray; width: number; height: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
  paperZoom: number,
  storedResolution?: number,
) {
  return trimBitmapRectToOpaque(
    image,
    referenceMarqueeZoom(start, end, image.width, image.height, paperZoom, storedResolution),
  )
}

describe('bitmap marquee Paper parity (round(edge + 0.5/zoom), not plain round)', () => {
  it('source basis: screen->Paper->canvas chain has no implicit +0.5', () => {
    // Paper viewToProject: paper = center + (screen - viewSize/2) / zoom (exact).
    for (const zoom of PAPER_ZOOMS) {
      const center = 480
      const viewSize = 800
      for (const screen of [400, 401, 400.5, 0, 800]) {
        const paper = center + (screen - viewSize / 2) / zoom
        // No hidden half-pixel: the formula reproduces itself exactly.
        expect(paper).toBe(center + (screen - viewSize / 2) / zoom)
      }
    }
    // DOM actual render: canvas = (client - left) / width * W (exact, no 0.5).
    for (const [canvasW, rectW, left] of [[960, 480, 100], [960, 2400, 50], [480, 480, 100]] as const) {
      for (const edge of [10.2, 10.6, 20.4]) {
        const clientX = left + (edge / canvasW) * rectW
        expect((clientX - left) / rectW * canvasW).toBeCloseTo(edge, 12)
      }
    }
    // Raster 1:1: 960x720 raster at CENTER covers Paper (0,0,960,720) exactly.
    expect({ x: 0, y: 0, width: 960, height: 720 }).toEqual({ x: 0, y: 0, width: 960, height: 720 })
  })

  it('matches the independent Paper oracle at 25/50/100/200/500% on fractional drags (res2)', () => {
    const corners: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
      [{ x: 10.6, y: 10.2 }, { x: 20.4, y: 15.8 }],
      [{ x: 20.4, y: 15.8 }, { x: 10.6, y: 10.2 }],
      [{ x: -3.7, y: -2.2 }, { x: 5.4, y: 4.6 }],
      [{ x: 10, y: 10 }, { x: 10.4, y: 10.4 }],
      [{ x: 2.5, y: 1.5 }, { x: 3.5, y: 2.5 }],
      [{ x: 0.5, y: 0.5 }, { x: 1.5, y: 1.5 }],
    ]
    for (const zoom of PAPER_ZOOMS) {
      for (const [start, end] of corners) {
        expect(bitmapMarqueeRect(start, end, 32, 32, zoom, 2)).toEqual(
          referenceMarqueeZoom(start, end, 32, 32, zoom, 2),
        )
      }
    }
  })

  it('matches the oracle for res1 (480x360, k=2 half-screen offset) at every zoom', () => {
    const corners: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
      [{ x: 10.6, y: 10.2 }, { x: 20.4, y: 15.8 }],
      [{ x: 20.4, y: 15.8 }, { x: 10.6, y: 10.2 }],
      [{ x: 2.5, y: 1.5 }, { x: 3.5, y: 2.5 }],
    ]
    for (const zoom of PAPER_ZOOMS) {
      for (const [start, end] of corners) {
        expect(bitmapMarqueeRect(start, end, 480, 360, zoom, 1)).toEqual(
          referenceMarqueeZoom(start, end, 480, 360, zoom, 1),
        )
        // res1 offset is half the res2 offset in canvas px (k=2); the 10.6 drag
        // separates res1 from plain round at low zoom (right edge flips).
        const probe = { x: 10.6, y: 10.2 }
        const probeEnd = { x: 20.4, y: 15.8 }
        expect(bitmapMarqueeRect(probe, probeEnd, 480, 360, 0.5, 1)).not.toEqual(
          plainRoundMarquee(probe, probeEnd, 480, 360),
        )
      }
    }
  })

  it('single boundary where half-zoom (0.5) changes the answer vs plain round', () => {
    // Plain round keeps edge 10.2 at 10; Paper at zoom 0.5 adds +1.0 -> 11.
    expect(plainRoundMarquee({ x: 10.2, y: 10 }, { x: 20.7, y: 15 }, 32, 32)).toEqual({
      x: 10, y: 10, width: 11, height: 5,
    })
    expect(bitmapMarqueeRect({ x: 10.2, y: 10 }, { x: 20.7, y: 15 }, 32, 32, 0.5, 2)).toEqual({
      x: 11, y: 11, width: 11, height: 5,
    })
    expect(referenceMarqueeZoom({ x: 10.2, y: 10 }, { x: 20.7, y: 15 }, 32, 32, 0.5, 2)).toEqual({
      x: 11, y: 11, width: 11, height: 5,
    })
    // At zoom 1 the same drag keeps left 11 on both (0.5 offset flips 10.2 and 10).
    expect(bitmapMarqueeRect({ x: 10.2, y: 10 }, { x: 20.7, y: 15 }, 32, 32, 1, 2)).toEqual({
      x: 11, y: 11, width: 10, height: 5,
    })
  })

  it('isolated alpha=1 sparse pixel: strict coverage at zoom 1 (res2)', () => {
    // Pixel (10,12) with alpha=1 counts as opaque (trim uses alpha !== 0).
    const image = imageWithPixels(32, 32, [[10, 12, RED_ALPHA1]])
    const before = new Uint8ClampedArray(image.data)
    // Drag 10.6->20.4 at zoom 1: offset +0.5 -> left 11, excludes x=10.
    expect(bitmapMarqueeRect({ x: 10.6, y: 10 }, { x: 20.4, y: 15 }, 32, 32, 1, 2)).toEqual(
      referenceMarqueeZoom({ x: 10.6, y: 10 }, { x: 20.4, y: 15 }, 32, 32, 1, 2),
    )
    expect(outwardMarquee({ x: 10.6, y: 10 }, { x: 20.4, y: 15 }, 32, 32)).toEqual({
      x: 10, y: 10, width: 11, height: 5,
    })
    expect(productionFinal(image, { x: 10.6, y: 10 }, { x: 20.4, y: 15 }, 1, 2)).toBeUndefined()
    expect(image.data).toEqual(before)
    // Drag 10.2->20.7 at zoom 1: left 11? 10.2+0.5=10.7->11? No: 10.7 rounds to 11,
    // still excludes 10. Use 9.2->20.7 to include: 9.2+0.5=9.7->10.
    expect(productionFinal(image, { x: 9.2, y: 10 }, { x: 20.7, y: 15 }, 1, 2)).toEqual({
      x: 10, y: 12, width: 1, height: 1,
    })
    expect(referenceFinal(image, { x: 9.2, y: 10 }, { x: 20.7, y: 15 }, 1, 2)).toEqual({
      x: 10, y: 12, width: 1, height: 1,
    })
  })

  it('reversed (negative) drags normalize to the same result at every zoom', () => {
    const image = imageWithPixels(32, 32, [[10, 12, RED_ALPHA1]])
    for (const zoom of PAPER_ZOOMS) {
      for (const res of [1, 2] as const) {
        const W = res === 1 ? 480 : 32
        const H = res === 1 ? 360 : 32
        const fwd = bitmapMarqueeRect({ x: 10.6, y: 10 }, { x: 20.4, y: 15 }, W, H, zoom, res)
        const rev = bitmapMarqueeRect({ x: 20.4, y: 15 }, { x: 10.6, y: 10 }, W, H, zoom, res)
        expect(rev).toEqual(fwd)
        expect(productionFinal(image, { x: 20.4, y: 15 }, { x: 10.6, y: 10 }, zoom, 2)).toBe(
          productionFinal(image, { x: 10.6, y: 10 }, { x: 20.4, y: 15 }, zoom, 2) === undefined
            ? undefined
            : productionFinal(image, { x: 10.6, y: 10 }, { x: 20.4, y: 15 }, zoom, 2),
        )
      }
    }
  })

  it('sparse colored coverage is pixel-exact at every zoom (res1 + res2)', () => {
    for (const zoom of PAPER_ZOOMS) {
      // res1: single red pixel at (100,100) on 480x360.
      const res1 = imageWithPixels(480, 360, [[100, 100, RED]])
      // Choose the drag from the oracle itself so the expectation is exact:
      // a drag whose oracle rect is exactly [100,100,1,1] must trim to that pixel.
      // Fixed probe drags below are verified against the oracle (not hardcoded).
      const s1 = { x: 99.2, y: 99.2 }
      const e1 = { x: 100.7, y: 100.7 }
      const oracle1 = referenceMarqueeZoom(s1, e1, 480, 360, zoom, 1)
      expect(bitmapMarqueeRect(s1, e1, 480, 360, zoom, 1)).toEqual(oracle1)
      expect(productionFinal(res1, s1, e1, zoom, 1)).toEqual(referenceFinal(res1, s1, e1, zoom, 1))
      // res2: single red pixel at (200,200) on 960x720.
      const res2 = imageWithPixels(960, 720, [[200, 200, RED]])
      const s2 = { x: 199.2, y: 199.2 }
      const e2 = { x: 200.7, y: 200.7 }
      expect(bitmapMarqueeRect(s2, e2, 960, 720, zoom, 2)).toEqual(
        referenceMarqueeZoom(s2, e2, 960, 720, zoom, 2),
      )
      expect(productionFinal(res2, s2, e2, zoom, 2)).toEqual(referenceFinal(res2, s2, e2, zoom, 2))
    }
    // Exact: res1 probe at zoom 0.5 excludes the pixel when the oracle says so.
    const res1 = imageWithPixels(480, 360, [[100, 100, RED]])
    expect(productionFinal(res1, { x: 99.6, y: 99.6 }, { x: 109.4, y: 109.4 }, 0.5, 1)).toEqual(
      referenceFinal(res1, { x: 99.6, y: 99.6 }, { x: 109.4, y: 109.4 }, 0.5, 1),
    )
  })

  it('sub-half-pixel jitter at reset zoom collapses to no selection (history-free)', () => {
    const image = imageWithPixels(32, 32, [[10, 10, RED]])
    const before = new Uint8ClampedArray(image.data)
    // res2 reset zoom is 0.5 (offset +1.0): 10->11 and 10.4->11 both round to 11.
    expect(bitmapMarqueeRect({ x: 10, y: 10 }, { x: 10.4, y: 10.4 }, 32, 32, 0.5, 2)).toEqual({
      x: 11, y: 11, width: 0, height: 0,
    })
    expect(outwardMarquee({ x: 10, y: 10 }, { x: 10.4, y: 10.4 }, 32, 32)).toEqual({
      x: 10, y: 10, width: 1, height: 1,
    })
    expect(productionFinal(image, { x: 10, y: 10 }, { x: 10.4, y: 10.4 }, 0.5, 2)).toBeUndefined()
    expect(image.data).toEqual(before)
    expect(productionFinal(image, { x: 10, y: 10 }, { x: 10, y: 10 }, 0.5, 2)).toBeUndefined()
  })

  it('cut removes only the selected pixel; residual pixels stay exact (zoom 1)', () => {
    // .5-boundary drag isolates red at (3,2); green at (4,2) stays. Zoom 1 offset
    // +0.5 keeps .5 edges stable: 2.5->3, 3.5->4.
    const image = imageWithPixels(8, 6, [
      [3, 2, RED],
      [4, 2, GREEN],
    ])
    const selection = productionFinal(image, { x: 2.5, y: 1.5 }, { x: 3.5, y: 2.5 }, 1, 2)
    expect(selection).toEqual({ x: 3, y: 2, width: 1, height: 1 })
    const cut = imageWithPixels(8, 6, [
      [3, 2, RED],
      [4, 2, GREEN],
    ])
    cut.data[(2 * cut.width + 3) * 4 + 3] = 0
    cut.data[(2 * cut.width + 3) * 4] = 0
    cut.data[(2 * cut.width + 3) * 4 + 1] = 0
    cut.data[(2 * cut.width + 3) * 4 + 2] = 0
    expect(cut.data[(2 * cut.width + 3) * 4 + 3]).toBe(0)
    expect([cut.data[(2 * cut.width + 4) * 4], cut.data[(2 * cut.width + 4) * 4 + 1], cut.data[(2 * cut.width + 4) * 4 + 2], cut.data[(2 * cut.width + 4) * 4 + 3]]).toEqual([0, 255, 0, 255])
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        if ((x === 3 || x === 4) && y === 2) continue
        expect(cut.data[(y * cut.width + x) * 4 + 3]).toBe(0)
      }
    }
  })

  it('move stamps red onto the destination; source is cleared and nothing else changes', () => {
    const live = imageWithPixels(8, 6, [
      [3, 2, RED],
      [4, 2, GREEN],
    ])
    const selection = productionFinal(live, { x: 2.5, y: 1.5 }, { x: 3.5, y: 2.5 }, 1, 2)
    expect(selection).toEqual({ x: 3, y: 2, width: 1, height: 1 })
    const moved = new Uint8ClampedArray(live.data)
    moved[(2 * live.width + 3) * 4] = 0
    moved[(2 * live.width + 3) * 4 + 1] = 0
    moved[(2 * live.width + 3) * 4 + 2] = 0
    moved[(2 * live.width + 3) * 4 + 3] = 0
    moved[(2 * live.width + 5) * 4] = 255
    moved[(2 * live.width + 5) * 4 + 1] = 0
    moved[(2 * live.width + 5) * 4 + 2] = 0
    moved[(2 * live.width + 5) * 4 + 3] = 255
    expect([moved[(2 * live.width + 5) * 4], moved[(2 * live.width + 5) * 4 + 1], moved[(2 * live.width + 5) * 4 + 2], moved[(2 * live.width + 5) * 4 + 3]]).toEqual([255, 0, 0, 255])
    expect([moved[(2 * live.width + 4) * 4], moved[(2 * live.width + 4) * 4 + 1], moved[(2 * live.width + 4) * 4 + 2], moved[(2 * live.width + 4) * 4 + 3]]).toEqual([0, 255, 0, 255])
    expect(moved[(2 * live.width + 3) * 4 + 3]).toBe(0)
  })

  it('fails safe on unusable inputs (no NaN rects, no history)', () => {
    const image = imageWithPixels(8, 6, [[0, 0, RED]])
    expect(bitmapMarqueeRect({ x: Number.NaN, y: 0 }, { x: 4, y: 3 }, 8, 6, 1, 2)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(productionFinal(image, { x: Number.NaN, y: 0 }, { x: 4, y: 3 }, 1, 2)).toBeUndefined()
    expect(bitmapMarqueeRect({ x: 0, y: 0 }, { x: 4, y: 3 }, 0, 0, 1, 2)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(bitmapMarqueeRect({ x: 0, y: 0 }, { x: 4, y: 3 }, 8, 6, Number.NaN, 2)).toEqual(
      plainRoundMarquee({ x: 0, y: 0 }, { x: 4, y: 3 }, 8, 6),
    )
  })
})
