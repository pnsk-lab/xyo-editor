import { describe, expect, it } from 'bun:test'
import { floodFillAllBitmap, floodFillAllMaskBitmap, floodFillBitmap, floodFillMaskBitmap, type BitmapFillImage } from '../src/features/costumes/bitmap-fill'
import { hexToRgb } from '../src/lib/editor-utils'

// Locks the contract that Editor.svelte's bitmap fill wiring relies on:
// solid opaque paint, plain click = connected region, Shift = same-color
// replacement everywhere, and `changed: false` no-ops that must skip
// save/history. The actual canvas glue lives in Editor.svelte
// (applyBitmapFill) and is covered by a source-level assertion below,
// since the component itself needs a browser canvas to run.

function solidImage(width: number, height: number, color: [number, number, number, number]): BitmapFillImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0]
    data[i + 1] = color[1]
    data[i + 2] = color[2]
    data[i + 3] = color[3]
  }
  return { width, height, data }
}

function paint(image: BitmapFillImage, x: number, y: number, color: [number, number, number, number]) {
  const index = (y * image.width + x) * 4
  image.data[index] = color[0]
  image.data[index + 1] = color[1]
  image.data[index + 2] = color[2]
  image.data[index + 3] = color[3]
}

describe('bitmap fill editor wiring', () => {
  it('derives a solid opaque fill from the hex paint color', () => {
    const rgb = hexToRgb('#ffab19')
    expect(rgb).toEqual({ r: 255, g: 171, b: 25 })
    const image = solidImage(2, 1, [255, 255, 255, 255])
    const result = floodFillBitmap(image, 0, 0, [rgb!.r, rgb!.g, rgb!.b, 255])
    expect(result.changed).toBe(true)
    expect([...result.image.data.slice(0, 4)]).toEqual([255, 171, 25, 255])
  })

  it('dispatches plain click to connected fill and shift-click to global replacement', () => {
    // Two white chambers split by a black wall: connected fill paints one
    // side, the shift path paints both.
    const build = () => {
      const image = solidImage(5, 3, [255, 255, 255, 255])
      for (let y = 0; y < 3; y += 1) paint(image, 2, y, [0, 0, 0, 255])
      return image
    }
    const red: [number, number, number, number] = [255, 0, 0, 255]
    const oneSide = floodFillBitmap(build(), 0, 1, red)
    const bothSides = floodFillAllBitmap(build(), 0, 1, red)
    expect(oneSide.filledCount).toBe(6)
    expect(bothSides.filledCount).toBe(12)
  })

  it('dispatches gradient fills through the same connected/global masks', () => {
    const build = () => {
      const image = solidImage(5, 3, [255, 255, 255, 255])
      for (let y = 0; y < 3; y += 1) paint(image, 2, y, [0, 0, 0, 255])
      return image
    }
    const oneSide = floodFillMaskBitmap(build(), 0, 1)
    const bothSides = floodFillAllMaskBitmap(build(), 0, 1)
    expect(oneSide.filledCount).toBe(6)
    expect(bothSides.filledCount).toBe(12)
    // Mask bounds size the gradient like the shape/text gradient geometry.
    expect(oneSide.bounds).toEqual({ x: 0, y: 0, width: 2, height: 3 })
    expect(bothSides.bounds).toEqual({ x: 0, y: 0, width: 5, height: 3 })
  })

  it('reports no-ops so the editor can skip save/history', () => {
    const red = solidImage(2, 2, [255, 0, 0, 255])
    expect(floodFillBitmap(red, 0, 0, [255, 0, 0, 255]).changed).toBe(false)
    expect(floodFillAllBitmap(red, 0, 0, [255, 0, 0, 255]).changed).toBe(false)
    const white = solidImage(2, 2, [255, 255, 255, 255])
    expect(floodFillBitmap(white, 9, 9, [255, 0, 0, 255]).changed).toBe(false)
    expect(floodFillAllBitmap(white, -1, 0, [255, 0, 0, 255]).changed).toBe(false)
  })

  it('wires Editor.svelte to the strict helpers with a no-op guard', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    expect(source).toContain('bitmap-fill')
    expect(source).toContain('floodFillAllBitmap')
    // Shift dispatches to the global replacement path.
    expect(source).toMatch(/event\.shiftKey[\s\S]*floodFillAllBitmap/)
    // No-op fills must not reach save/history.
    expect(source).toMatch(/if\s*\(\s*!result\.changed\s*\)\s*return false/)
    expect(source).toMatch(/if\s*\(\s*filled\s*\)[^;]*saveBitmapCostume/)
    // The old tolerance fill must stay out of the fill path.
    expect(source).not.toContain('colorDistance')
  })

  it('wires gradient fills through masks and canvas compositing', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    // Gradient mode reuses the same connected/global regions as masks.
    expect(source).toContain('floodFillMaskBitmap')
    expect(source).toContain('floodFillAllMaskBitmap')
    expect(source).toMatch(/event\.shiftKey[\s\S]*floodFillAllMaskBitmap/)
    // The selected gradient geometry sizes to the mask bounds, then the
    // gradient layer is clipped to the mask and drawn back.
    expect(source).toMatch(/bitmapPaintStyle\([\s\S]*bounds/)
    // Radial highlight follows the click seed (Shift-global keeps its own
    // mask bounds but the same seed): geometry helper + seed wiring.
    expect(source).toContain('resolveBitmapFillRadialGeometry')
    expect(source).toMatch(/bitmapPaintStyle\([\s\S]*\{\s*x,\s*y\s*\}/)
    expect(source).toContain('destination-in')
    expect(source).toContain('drawImage(maskLayer')
    expect(source).toContain('drawImage(gradientLayer')
  })

  it('wires transparent fills through alpha-0 solid fills and transparent-aware gradient stops', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    // Independent toggle state: the hex picker is never cleared by transparency.
    expect(source).toContain('fillTransparent')
    expect(source).toContain('secondaryTransparent')
    expect(source).toContain('strokeTransparent')
    // Solid transparent flood fill paints alpha 0 (erase), not opaque black.
    expect(source).toContain('resolveBitmapSolidFill')
    // Gradient stops keep alpha (rgba) so a transparent end fades opacity.
    expect(source).toContain('resolveBitmapGradientStops')
    // The masked gradient replaces the region (erase first), so transparent
    // stops actually erase instead of blending over the old pixels.
    expect(source).toContain('destination-out')
    // The eyedropper maps fully transparent pixels to transparent.
    expect(source).toContain('resolveEyedropperPixel')
    // Gestures that would paint nothing skip history/save.
    expect(source).toContain('isBitmapPaintNoop')
  })
})
