import { describe, expect, it } from 'vitest'
import {
  buildConvertedVectorSvg,
  conversionScratchBounds,
  isBitmapToVectorSourceRefused,
  isConversionRasterSizeRefused,
  isVectorToBitmapSpecRefused,
  parseConversionSvgGeometry,
  resolveBitmapToVectorSpec,
  resolveBitmapVectorConvertPlacement,
  resolveVectorToBitmapSpec,
} from '../src/features/costumes/costume-conversion'

describe('costume-conversion vector->bitmap preserves stage bounds', () => {
  it('maps a 96x96 sprite SVG to a 192x192 bitmap with scaled center (not 2400x1800)', () => {
    const spec = resolveVectorToBitmapSpec({ svgWidth: 96, svgHeight: 96, rotationCenterX: 48, rotationCenterY: 50, isStage: false })
    expect(spec).toEqual({ bitmapWidth: 192, bitmapHeight: 192, bitmapResolution: 2, rotationCenterX: 96, rotationCenterY: 100 })
    const before = conversionScratchBounds({ width: 96, height: 96, rotationCenterX: 48, rotationCenterY: 50, resolution: 1 })
    const after = conversionScratchBounds({ width: spec.bitmapWidth, height: spec.bitmapHeight, rotationCenterX: spec.rotationCenterX, rotationCenterY: spec.rotationCenterY, resolution: spec.bitmapResolution })
    expect(after).toEqual(before)
  })

  it('documents the legacy bug: fixed 2400x1800 storage blows up to 1200x900 units', () => {
    const legacy = conversionScratchBounds({ width: 2400, height: 1800, rotationCenterX: 48, rotationCenterY: 50, resolution: 2 })
    expect(legacy.width).toBe(1200)
    expect(legacy.height).toBe(900)
    const correct = conversionScratchBounds({ width: 96, height: 96, rotationCenterX: 48, rotationCenterY: 50, resolution: 1 })
    expect(correct.width).toBe(96)
    // The fixed spec must NOT produce the legacy size.
    const spec = resolveVectorToBitmapSpec({ svgWidth: 96, svgHeight: 96, rotationCenterX: 48, rotationCenterY: 50, isStage: false })
    expect(spec.bitmapWidth).not.toBe(2400)
    expect(spec.bitmapHeight).not.toBe(1800)
  })

  it('maps a 480x360 stage SVG 1:1 with resolution 1', () => {
    const spec = resolveVectorToBitmapSpec({ svgWidth: 480, svgHeight: 360, rotationCenterX: 240, rotationCenterY: 180, isStage: true })
    expect(spec).toEqual({ bitmapWidth: 480, bitmapHeight: 360, bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 })
  })

  it('handles empty SVG geometry and missing centers with fallbacks', () => {
    const sprite = resolveVectorToBitmapSpec({ svgWidth: 0, svgHeight: NaN, rotationCenterX: undefined, rotationCenterY: undefined, isStage: false })
    expect(sprite.bitmapWidth).toBe(192)
    expect(sprite.bitmapHeight).toBe(192)
    expect(sprite.rotationCenterX).toBe(96)
    expect(sprite.rotationCenterY).toBe(96)
  })

  it('scales半透明 content bounds identically (alpha does not change geometry)', () => {
    // Translucency rides pixel alpha, not geometry: the same rect with opacity
    // must map to the same asset size/center.
    const opaque = resolveVectorToBitmapSpec({ svgWidth: 100, svgHeight: 60, rotationCenterX: 30, rotationCenterY: 20, isStage: false })
    expect(opaque.bitmapWidth).toBe(200)
    expect(opaque.bitmapHeight).toBe(120)
    expect(opaque.rotationCenterX).toBe(60)
    expect(opaque.rotationCenterY).toBe(40)
  })
})

describe('parseConversionSvgGeometry', () => {
  it('parses width/height/viewBox and falls back per target', () => {
    expect(parseConversionSvgGeometry('<svg width="96" height="96" viewBox="0 0 96 96"></svg>', false)).toEqual({ width: 96, height: 96, viewBoxX: 0, viewBoxY: 0 })
    expect(parseConversionSvgGeometry('<svg width="95.5" height="100.25" viewBox="0.3 0.3 95.5 100.25"></svg>', false)).toEqual({ width: 95.5, height: 100.25, viewBoxX: 0.3, viewBoxY: 0.3 })
    // Missing size falls back (sprite 96x96, stage 480x360); viewBox size is the fallback source.
    expect(parseConversionSvgGeometry('<svg viewBox="0 0 123 45"></svg>', false)).toEqual({ width: 123, height: 45, viewBoxX: 0, viewBoxY: 0 })
    expect(parseConversionSvgGeometry('not svg', false)).toEqual({ width: 96, height: 96, viewBoxX: 0, viewBoxY: 0 })
    expect(parseConversionSvgGeometry('', true)).toEqual({ width: 480, height: 360, viewBoxX: 0, viewBoxY: 0 })
    // Percentages need layout context: fall back instead of guessing.
    expect(parseConversionSvgGeometry('<svg width="100%" height="100%"></svg>', false).width).toBe(96)
  })

  it('keeps clipping-relevant viewBox origin (offset viewBox does not change asset size)', () => {
    const geometry = parseConversionSvgGeometry('<svg width="100" height="100" viewBox="20 30 100 100"></svg>', false)
    expect(geometry.viewBoxX).toBe(20)
    expect(geometry.viewBoxY).toBe(30)
    const spec = resolveVectorToBitmapSpec({ svgWidth: geometry.width, svgHeight: geometry.height, rotationCenterX: 50, rotationCenterY: 50, isStage: false })
    expect(spec.bitmapWidth).toBe(200)
  })
})

describe('costume-conversion bitmap->vector preserves stage bounds', () => {
  it('maps a trimmed 192px asset to a 96-unit SVG with shifted center (1:1 drawing bounds)', () => {
    const spec = resolveBitmapToVectorSpec({ canvasWidth: 192, canvasHeight: 192, trim: { x: 0, y: 0, width: 192, height: 192 }, rotationCenterX: 96, rotationCenterY: 100, bitmapResolution: 2 })
    expect(spec.svgWidth).toBe(96)
    expect(spec.svgHeight).toBe(96)
    expect(spec.image).toEqual({ x: 0, y: 0, width: 96, height: 96 })
    expect(spec.rotationCenterX).toBe(48)
    expect(spec.rotationCenterY).toBe(50)
  })

  it('keeps trimmed ink at the same scratch position (padding does not teleport)', () => {
    // 192px ink centered in a 2400x1800 workspace with source center 96,100:
    // the new SVG is trimmed (96x96) with the image at the trimmed origin and
    // the center absorbing the trim origin, so the ink scratch position stays.
    const trim = { x: 1104, y: 804, width: 192, height: 192 }
    const spec = resolveBitmapToVectorSpec({ canvasWidth: 2400, canvasHeight: 1800, trim, rotationCenterX: 96, rotationCenterY: 100, bitmapResolution: 2 })
    expect(spec.svgWidth).toBe(96)
    expect(spec.image).toEqual({ x: 0, y: 0, width: 96, height: 96 })
    expect(spec.rotationCenterX).toBe((96 - 1104) / 2)
    expect(spec.rotationCenterY).toBe((100 - 804) / 2)
    // Ink scratch position is invariant: -center (+0 image origin).
    const inkLeftBefore = (trim.x - 96) / 2
    const inkLeftAfter = -spec.rotationCenterX + (spec.image?.x ?? 0)
    expect(inkLeftAfter).toBeCloseTo(inkLeftBefore, 9)
    const inkTopBefore = (100 - trim.y) / 2
    const inkTopAfter = spec.rotationCenterY - (spec.image?.y ?? 0)
    expect(inkTopAfter).toBeCloseTo(inkTopBefore, 9)
  })

  it('preserves legacy oversized appearance compatibly (2400 full-bleed stays 1200x900)', () => {
    const spec = resolveBitmapToVectorSpec({ canvasWidth: 2400, canvasHeight: 1800, trim: { x: 0, y: 0, width: 2400, height: 1800 }, rotationCenterX: 48, rotationCenterY: 50, bitmapResolution: 2 })
    expect(spec.svgWidth).toBe(1200)
    expect(spec.svgHeight).toBe(900)
    expect(spec.rotationCenterX).toBe(24)
    expect(spec.rotationCenterY).toBe(25)
    const before = conversionScratchBounds({ width: 2400, height: 1800, rotationCenterX: 48, rotationCenterY: 50, resolution: 2 })
    const after = conversionScratchBounds({ width: spec.svgWidth, height: spec.svgHeight, rotationCenterX: spec.rotationCenterX, rotationCenterY: spec.rotationCenterY, resolution: 1 })
    expect(after).toEqual(before)
  })

  it('keeps fully transparent (empty/半透明 alpha==0) canvases transparent with full-canvas bounds', () => {
    const spec = resolveBitmapToVectorSpec({ canvasWidth: 2400, canvasHeight: 1800, trim: undefined, rotationCenterX: 48, rotationCenterY: 50, bitmapResolution: 2 })
    expect(spec.image).toBeNull()
    expect(spec.svgWidth).toBe(1200)
    expect(buildConvertedVectorSvg(spec, 'data:image/png;base64,AAA')).not.toContain('<image')
  })

  it('round-trips sprite bounds vector->bitmap->vector', () => {
    const vector = { width: 95.17898101806641, height: 100.04156036376953, rotationCenterX: 48, rotationCenterY: 50 }
    const bitmap = resolveVectorToBitmapSpec({ svgWidth: vector.width, svgHeight: vector.height, rotationCenterX: vector.rotationCenterX, rotationCenterY: vector.rotationCenterY, isStage: false })
    const back = resolveBitmapToVectorSpec({ canvasWidth: bitmap.bitmapWidth, canvasHeight: bitmap.bitmapHeight, trim: { x: 0, y: 0, width: bitmap.bitmapWidth, height: bitmap.bitmapHeight }, rotationCenterX: bitmap.rotationCenterX, rotationCenterY: bitmap.rotationCenterY, bitmapResolution: bitmap.bitmapResolution })
    // PNG pixels are integers: fractional SVG units quantize to half a storage
    // pixel (0.5 / resolution scratch units). Bounds must survive within that.
    expect(back.svgWidth).toBeCloseTo(vector.width, 0)
    expect(back.svgHeight).toBeCloseTo(vector.height, 0)
    expect(back.rotationCenterX).toBeCloseTo(vector.rotationCenterX, 0)
    expect(back.rotationCenterY).toBeCloseTo(vector.rotationCenterY, 0)
    const before = conversionScratchBounds({ width: vector.width, height: vector.height, rotationCenterX: vector.rotationCenterX, rotationCenterY: vector.rotationCenterY, resolution: 1 })
    const after = conversionScratchBounds({ width: back.svgWidth, height: back.svgHeight, rotationCenterX: back.rotationCenterX, rotationCenterY: back.rotationCenterY, resolution: 1 })
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(after.left - before.left)).toBeLessThanOrEqual(0.5)
  })
})

describe('buildConvertedVectorSvg sanitizer boundary', () => {
  it('rejects non-allowlisted href with no history payload', () => {
    const spec = resolveBitmapToVectorSpec({ canvasWidth: 192, canvasHeight: 192, trim: { x: 0, y: 0, width: 192, height: 192 }, rotationCenterX: 96, rotationCenterY: 96, bitmapResolution: 2 })
    expect(buildConvertedVectorSvg(spec, 'https://example.com/x.png')).toBe('')
    expect(buildConvertedVectorSvg(spec, 'data:image/svg+xml;base64,PHN2Zz4=')).toBe('')
    expect(buildConvertedVectorSvg(spec, 'data:image/png;base64,iVBORw0KGgo=')).toContain('data:image/png;base64,')
  })
})

describe('conversion size refusal (extreme side-cap guard)', () => {
  it('refuses over-cap rasters before allocating or overwriting', () => {
    expect(isConversionRasterSizeRefused(65535, 2)).toBe(false)
    expect(isConversionRasterSizeRefused(65536, 2)).toBe(true)
    expect(isConversionRasterSizeRefused(100000, 2)).toBe(true)
    expect(isConversionRasterSizeRefused(8000, 8000)).toBe(true)
    expect(isConversionRasterSizeRefused(192, 192)).toBe(false)
    expect(isConversionRasterSizeRefused(0, 10)).toBe(true)
    expect(isConversionRasterSizeRefused(NaN, 10)).toBe(true)
  })

  it('refuses vector->bitmap specs over the side cap', () => {
    expect(isVectorToBitmapSpecRefused({ bitmapWidth: 192, bitmapHeight: 192 })).toBe(false)
    expect(isVectorToBitmapSpecRefused({ bitmapWidth: 65536, bitmapHeight: 2 })).toBe(true)
    expect(isVectorToBitmapSpecRefused(undefined)).toBe(true)
  })

  it('refuses bitmap->vector sources over the side cap (never writes an empty SVG)', () => {
    expect(isBitmapToVectorSourceRefused(960, 720)).toBe(false)
    expect(isBitmapToVectorSourceRefused(65535, 2)).toBe(false)
    expect(isBitmapToVectorSourceRefused(65536, 2)).toBe(true)
    expect(isBitmapToVectorSourceRefused(100000, 2)).toBe(true)
    expect(isBitmapToVectorSourceRefused(960, 720, { width: 65536, height: 2 })).toBe(true)
    expect(isBitmapToVectorSourceRefused(192, 192, { width: 192, height: 192 })).toBe(false)
  })
})

describe('resolveBitmapVectorConvertPlacement artboard mapping', () => {
  it('maps the stored center through the tracked artboard origin', () => {
    // 190x200 @96,96 placed at 384,264 on the sprite artboard.
    expect(
      resolveBitmapVectorConvertPlacement({
        trim: { x: 384, y: 264, width: 190, height: 200 },
        storedCenterX: 96,
        storedCenterY: 96,
        liveWidth: 960,
        liveHeight: 720,
        artCenterX: 480,
        artCenterY: 360,
        artOriginX: 384,
        artOriginY: 264,
      }),
    ).toEqual({ canvasWidth: 960, canvasHeight: 720, rotationCenterX: 480, rotationCenterY: 360 })
  })

  it('falls back to stored dims/center for fully transparent canvases', () => {
    // Transparent 192x192 (empty 96x96 @res2) converts to 96x96, not 480x360.
    expect(
      resolveBitmapVectorConvertPlacement({
        trim: undefined,
        storedWidth: 192,
        storedHeight: 192,
        storedCenterX: 96,
        storedCenterY: 96,
        liveWidth: 960,
        liveHeight: 720,
        artCenterX: 480,
        artCenterY: 360,
        artOriginX: 384,
        artOriginY: 264,
      }),
    ).toEqual({ canvasWidth: 192, canvasHeight: 192, rotationCenterX: 96, rotationCenterY: 96 })
  })

  it('uses the live canvas verbatim when neither trim nor stored geometry exists', () => {
    expect(
      resolveBitmapVectorConvertPlacement({
        trim: undefined,
        liveWidth: 960,
        liveHeight: 720,
        artCenterX: 480,
        artCenterY: 360,
        artOriginX: 0,
        artOriginY: 0,
      }),
    ).toEqual({ canvasWidth: 960, canvasHeight: 720, rotationCenterX: 480, rotationCenterY: 360 })
  })
})
