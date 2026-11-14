import { describe, expect, it } from 'bun:test'
import {
  EYEDROPPER_LOUPE_CANVAS_SIZE,
  EYEDROPPER_LOUPE_RADIUS,
  EYEDROPPER_LOUPE_ZOOM,
  EYEDROPPER_VECTOR_RASTER_SCALE,
  eyedropperCss,
  eyedropperPixelFromClient,
  loupeSourceRect,
  padLoupePixels,
  rasterizeVectorPreview,
  resolveEyedropperCommitTarget,
  sampleCanvasPixel,
} from '../src/features/costumes/eyedropper'

// Pure-geometry coverage for the dedicated eyedropper overlay: client mapping
// stays zoom-aware (rect already includes the viewport transform), the loupe
// clamps at artwork edges with stable transparent padding, Shift+click
// picks the opposite target for one commit only.
describe('eyedropper geometry and commit targets', () => {
  it('matches the reference loupe geometry (radius 20, zoom 3, canvas 120)', () => {
    expect(EYEDROPPER_LOUPE_RADIUS).toBe(20)
    expect(EYEDROPPER_LOUPE_ZOOM).toBe(3)
    expect(EYEDROPPER_LOUPE_CANVAS_SIZE).toBe(120)
    expect(EYEDROPPER_VECTOR_RASTER_SCALE).toBe(3)
  })

  it('maps client points through the zoomed rect and rejects the outside', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 }
    expect(eyedropperPixelFromClient(100, 50, rect, 480, 360)).toEqual({ x: 0, y: 0, inside: true })
    expect(eyedropperPixelFromClient(300, 150, rect, 480, 360)).toEqual({ x: 480, y: 360, inside: false })
    expect(eyedropperPixelFromClient(200, 100, rect, 480, 360)).toEqual({ x: 240, y: 180, inside: true })
    expect(eyedropperPixelFromClient(99, 100, rect, 480, 360).inside).toBe(false)
    expect(eyedropperPixelFromClient(200, 100, { ...rect, width: 0 }, 480, 360).inside).toBe(false)
  })

  it('resolves the same artwork pixel through a zoomed rect', () => {
    const base = { left: 0, top: 0, width: 480, height: 360 }
    const zoomed = { left: 0, top: 0, width: 960, height: 720 }
    expect(eyedropperPixelFromClient(120, 90, base, 480, 360)).toEqual({ x: 120, y: 90, inside: true })
    expect(eyedropperPixelFromClient(240, 180, zoomed, 480, 360)).toEqual({ x: 120, y: 90, inside: true })
  })

  it('clamps the loupe neighborhood at artwork edges', () => {
    expect(loupeSourceRect(0, 0, EYEDROPPER_LOUPE_RADIUS, 480, 360)).toEqual({
      sx: 0,
      sy: 0,
      sw: EYEDROPPER_LOUPE_RADIUS,
      sh: EYEDROPPER_LOUPE_RADIUS,
    })
    expect(loupeSourceRect(240, 180, EYEDROPPER_LOUPE_RADIUS, 480, 360)).toEqual({
      sx: 240 - EYEDROPPER_LOUPE_RADIUS,
      sy: 180 - EYEDROPPER_LOUPE_RADIUS,
      sw: EYEDROPPER_LOUPE_RADIUS * 2,
      sh: EYEDROPPER_LOUPE_RADIUS * 2,
    })
  })

  it('clamps the far edge to a partial block for transparent padding', () => {
    const source = loupeSourceRect(479, 359, EYEDROPPER_LOUPE_RADIUS, 480, 360)
    expect(source.sx).toBe(479 - EYEDROPPER_LOUPE_RADIUS)
    expect(source.sy).toBe(359 - EYEDROPPER_LOUPE_RADIUS)
    expect(source.sw).toBeLessThan(EYEDROPPER_LOUPE_RADIUS * 2)
    expect(source.sh).toBeLessThan(EYEDROPPER_LOUPE_RADIUS * 2)
    // The clamped block never escapes the artwork.
    expect(source.sx + source.sw).toBeLessThanOrEqual(480)
    expect(source.sy + source.sh).toBeLessThanOrEqual(360)
  })

  it('pads edge neighborhoods to a stable loupe size with transparent alpha outside', () => {
    const radius = 2
    const source = loupeSourceRect(0, 1, radius, 10, 10)
    // 2x4 clamped block at the left edge.
    expect(source).toEqual({ sx: 0, sy: 0, sw: 2, sh: 3 })
    const rows = new Uint8ClampedArray(source.sw * source.sh * 4).fill(255)
    const padded = padLoupePixels(rows, source, 0, 1, radius)
    expect(padded.size).toBe(radius * 2)
    expect(padded.data.length).toBe(radius * 2 * radius * 2 * 4)
    // Top-left output cell is out-of-artwork padding (transparent).
    expect(padded.data[3]).toBe(0)
    // A cell mapped from the clamped block is opaque.
    const diameter = radius * 2
    const centerOffset = ((2 * diameter + 2) * 4)
    expect(padded.data[centerOffset + 3]).toBe(255)
  })

  it('keeps the full reference-size loupe stable at the artwork corner', () => {
    const source = loupeSourceRect(0, 0, EYEDROPPER_LOUPE_RADIUS, 480, 360)
    const rows = new Uint8ClampedArray(source.sw * source.sh * 4).fill(255)
    const padded = padLoupePixels(rows, source, 0, 0, EYEDROPPER_LOUPE_RADIUS)
    expect(padded.size).toBe(EYEDROPPER_LOUPE_RADIUS * 2)
    expect(padded.data.length).toBe(EYEDROPPER_LOUPE_RADIUS * 2 * EYEDROPPER_LOUPE_RADIUS * 2 * 4)
    // Out-of-artwork corner padding stays transparent.
    expect(padded.data[3]).toBe(0)
    // The clamped artwork corner lands opaque inside the padded block.
    const diameter = EYEDROPPER_LOUPE_RADIUS * 2
    const inner = ((EYEDROPPER_LOUPE_RADIUS * diameter + EYEDROPPER_LOUPE_RADIUS) * 4)
    expect(padded.data[inner + 3]).toBe(255)
  })

  it('formats loupe colors with alpha preserved', () => {
    expect(eyedropperCss({ r: 255, g: 0, b: 0, a: 255 })).toBe('rgb(255, 0, 0)')
    expect(eyedropperCss({ r: 255, g: 0, b: 0, a: 0 })).toBe('rgba(255, 0, 0, 0)')
    expect(eyedropperCss({ r: 17, g: 34, b: 51, a: 128 })).toBe('rgba(17, 34, 51, 0.502)')
  })

  it('resolves Shift+click to the opposite target for one commit', () => {
    expect(resolveEyedropperCommitTarget('fill', false)).toBe('fill')
    expect(resolveEyedropperCommitTarget('fill', true)).toBe('stroke')
    expect(resolveEyedropperCommitTarget('stroke', true)).toBe('fill')
    expect(resolveEyedropperCommitTarget('stroke', false)).toBe('stroke')
  })

  it('reports outside canvas pixels instead of sampling them', () => {
    const canvas = {
      width: 4,
      height: 4,
      getContext: () => ({
        getImageData: () => {
          throw new Error('must not sample outside pixels')
        },
      }),
    } as unknown as HTMLCanvasElement
    expect(sampleCanvasPixel(canvas, -1, 0).inside).toBe(false)
    expect(sampleCanvasPixel(canvas, 0, -1).inside).toBe(false)
    expect(sampleCanvasPixel(canvas, 4, 0).inside).toBe(false)
    expect(sampleCanvasPixel(canvas, 0, 4).inside).toBe(false)
  })

  it('returns the sampled pixel with alpha when inside', () => {
    const canvas = {
      width: 4,
      height: 4,
      getContext: () => ({
        getImageData: (_x: number, _y: number, _w: number, _h: number) => ({
          data: Uint8ClampedArray.from([10, 20, 30, 128]),
        }),
      }),
    } as unknown as HTMLCanvasElement
    expect(sampleCanvasPixel(canvas, 1, 1)).toEqual({ pixel: { r: 10, g: 20, b: 30, a: 128 }, inside: true })
  })

  it('never throws on a tainted (cross-origin) canvas read', () => {
    const canvas = {
      width: 4,
      height: 4,
      getContext: () => ({
        getImageData: () => {
          const error = new Error('tainted canvas')
          error.name = 'SecurityError'
          throw error
        },
      }),
    } as unknown as HTMLCanvasElement
    expect(() => sampleCanvasPixel(canvas, 1, 1)).not.toThrow()
    expect(sampleCanvasPixel(canvas, 1, 1)).toEqual({ pixel: { r: 0, g: 0, b: 0, a: 0 }, inside: false })
  })

  it('skips vector rasterization for empty markup without touching the DOM', async () => {
    await expect(rasterizeVectorPreview('', 480, 360)).resolves.toBeUndefined()
    await expect(rasterizeVectorPreview('plain text', 480, 360)).resolves.toBeUndefined()
  })
})
