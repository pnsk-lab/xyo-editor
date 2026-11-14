import { describe, expect, it } from 'bun:test'
import {
  resolveInitialFitViewport,
  unionFitRects,
  VECTOR_PAPER_TO_CSS_DENSITY,
  BITMAP_RES2_PAPER_TO_CSS_DENSITY,
  densityForBitmapStoredResolution,
  viewportResetScaleForDensity,
} from '../src/features/costumes/costume-viewport'
import { resolvePaperFitZoom } from '../src/features/costumes/paper-viewport-parity'

// First-visit fit: reference `zoomToFit` basis, per-costume+mode viewport state
// is owned by the caller (BitmapEditor saved-state map) and never touched here.
// This suite pins the pure geometry: trim/artboard offset baked into surface
// bounds, stage/sprite via surface size, empty/singular/large-thin fail-closed,
// async/race/target-switch handled by the caller gating (not here), viewport
// resize via explicit container size, mode conversion via explicit density,
// undo/redo never calls this (first-visit gate), drawing/history untouched
// (pure: no VM/history import, deterministic re-execution).

describe('initial fit viewport (reference zoomToFit basis)', () => {
  it('centers a small centered vector artwork at the fitted scale', () => {
    // SVG 100x100 centered on the 480x360 art ((190,130,100,100) -> center 240,180).
    // Surface x5 at art offset 0,0: (950,650,500,500), center == surface center.
    const result = resolveInitialFitViewport({
      contentBoundsSurface: { x: 950, y: 650, width: 500, height: 500 },
      surfaceSize: { width: 2400, height: 1800 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    expect(result.fitted).toBe(true)
    expect(result.reason).toBe('fit: centered on content bounds')
    // Paper 200x200, padded 300x300, ratio 0.5*max(300/800,300/600)=0.25 -> z=2.0.
    expect(result.paperZoom).toBeCloseTo(2.0, 12)
    // CSS s = z/2.5 = 0.8, centered content -> no pan.
    expect(result.viewport).not.toBeNull()
    expect(result.viewport!.scale).toBeCloseTo(0.8, 12)
    expect(result.viewport!.x).toBeCloseTo(0, 12)
    expect(result.viewport!.y).toBeCloseTo(0, 12)
    expect(result.paperZoom).toBeCloseTo(
      resolvePaperFitZoom({ width: 200, height: 200 }, { width: 800, height: 600 }, false),
      12,
    )
  })

  it('pans an off-center vector artwork onto the container center', () => {
    // SVG 100x100 at the top-left ((0,0,100,100) -> surface (0,0,500,500)).
    const result = resolveInitialFitViewport({
      contentBoundsSurface: { x: 0, y: 0, width: 500, height: 500 },
      surfaceSize: { width: 2400, height: 1800 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    expect(result.fitted).toBe(true)
    expect(result.paperZoom).toBeCloseTo(2.0, 12)
    expect(result.viewport!.scale).toBeCloseTo(0.8, 12)
    // Center (250,250): vx = -(250-1200)*0.8 = 760, vy = -(250-900)*0.8 = 520.
    expect(result.viewport!.x).toBeCloseTo(760, 9)
    expect(result.viewport!.y).toBeCloseTo(520, 9)
  })

  it('fits a small centered bitmap res2 trim with the bitmap buffer', () => {
    // Canvas 960x720, trim 100x100 centered ((430,310,100,100) -> center 480,360).
    const result = resolveInitialFitViewport({
      contentBoundsSurface: { x: 430, y: 310, width: 100, height: 100 },
      surfaceSize: { width: 960, height: 720 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: BITMAP_RES2_PAPER_TO_CSS_DENSITY,
      isBitmap: true,
    })
    expect(result.fitted).toBe(true)
    // Paper 100x100 +50 buffer, padded 225x225, ratio 0.5*0.375=0.1875 -> z=5.333? No:
    // max(225/800=0.28125, 225/600=0.375) -> 0.5*0.375=0.1875 -> z=0.5/0.1875=2.6667.
    expect(result.paperZoom).toBeCloseTo(2.6666666667, 9)
    expect(result.viewport!.scale).toBeCloseTo(2.6666666667, 9)
    expect(result.viewport!.x).toBeCloseTo(0, 12)
    expect(result.viewport!.y).toBeCloseTo(0, 12)
    expect(result.paperZoom).toBeCloseTo(
      resolvePaperFitZoom({ width: 100, height: 100 }, { width: 800, height: 600 }, true),
      12,
    )
  })

  it('fails closed to the base on empty / singular / zero-area (no centering)', () => {
    const surface = { width: 2400, height: 1800 }
    const container = { width: 800, height: 600 }
    for (const bounds of [null, undefined] as const) {
      const result = resolveInitialFitViewport({
        contentBoundsSurface: bounds,
        surfaceSize: surface,
        containerSize: container,
        paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
        isBitmap: false,
      })
      expect(result.fitted).toBe(false)
      expect(result.paperZoom).toBe(0.5)
      expect(result.viewport).toEqual({ x: 0, y: 0, scale: 0.2 })
      expect(result.reason).toMatch(/^empty:/)
    }
    for (const bounds of [
      { x: 100, y: 100, width: 0, height: 50 },
      { x: 100, y: 100, width: 50, height: 0 },
      { x: 100, y: 100, width: 0, height: 0 },
    ]) {
      const result = resolveInitialFitViewport({
        contentBoundsSurface: bounds,
        surfaceSize: surface,
        containerSize: container,
        paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
        isBitmap: false,
      })
      expect(result.fitted).toBe(false)
      expect(result.paperZoom).toBe(0.5)
      expect(result.viewport).toEqual({ x: 0, y: 0, scale: 0.2 })
      expect(result.reason).toMatch(/^singular:/)
    }
  })

  it('stays at the base without recentering when content fills or exceeds the viewport', () => {
    // Huge vector: 5000x5000 surface px -> 2000x2000 Paper, padded 3000x3000.
    const huge = resolveInitialFitViewport({
      contentBoundsSurface: { x: 0, y: 0, width: 5000, height: 5000 },
      surfaceSize: { width: 5000, height: 5000 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    expect(huge.fitted).toBe(false)
    expect(huge.paperZoom).toBe(0.5)
    expect(huge.viewport).toEqual({ x: 0, y: 0, scale: 0.2 })
    expect(huge.reason).toMatch(/^fills-or-exceeds:/)
    // Large & thin bitmap: 5000x12 canvas, padded (5050*1.5, 62*1.5), ratio > 1.
    const thin = resolveInitialFitViewport({
      contentBoundsSurface: { x: 0, y: 0, width: 5000, height: 12 },
      surfaceSize: { width: 5000, height: 12 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: BITMAP_RES2_PAPER_TO_CSS_DENSITY,
      isBitmap: true,
    })
    expect(thin.fitted).toBe(false)
    expect(thin.paperZoom).toBe(0.5)
    expect(thin.viewport).toEqual({ x: 0, y: 0, scale: 0.5 })
  })

  it('scales with the explicit container size (resize dimensions flow through)', () => {
    const bounds = { x: 950, y: 650, width: 500, height: 500 }
    const surface = { width: 2400, height: 1800 }
    const wide = resolveInitialFitViewport({
      contentBoundsSurface: bounds,
      surfaceSize: surface,
      containerSize: { width: 1600, height: 1200 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    const narrow = resolveInitialFitViewport({
      contentBoundsSurface: bounds,
      surfaceSize: surface,
      containerSize: { width: 400, height: 300 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    expect(wide.fitted).toBe(true)
    expect(narrow.fitted).toBe(true)
    // Larger container -> smaller ratio -> larger zoom (fills the bigger view).
    expect(wide.paperZoom!).toBeGreaterThan(narrow.paperZoom!)
    expect(wide.paperZoom).toBeCloseTo(
      resolvePaperFitZoom({ width: 200, height: 200 }, { width: 1600, height: 1200 }, false),
      12,
    )
    expect(narrow.paperZoom).toBeCloseTo(
      resolvePaperFitZoom({ width: 200, height: 200 }, { width: 400, height: 300 }, false),
      12,
    )
  })

  it('separates bitmap and vector paths via the expand buffer (mode conversion)', () => {
    // Same 400x300 Paper content in the same 800x600 container.
    const vector = resolveInitialFitViewport({
      // 400x300 Paper * 2.5 = 1000x750 surface.
      contentBoundsSurface: { x: 700, y: 525, width: 1000, height: 750 },
      surfaceSize: { width: 2400, height: 1800 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    const bitmap = resolveInitialFitViewport({
      // 400x300 Paper * 1.0 = 400x300 surface.
      contentBoundsSurface: { x: 280, y: 210, width: 400, height: 300 },
      surfaceSize: { width: 960, height: 720 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: BITMAP_RES2_PAPER_TO_CSS_DENSITY,
      isBitmap: true,
    })
    expect(vector.fitted).toBe(true)
    expect(bitmap.fitted).toBe(true)
    // Bitmap pads the +50 buffer, so the same Paper content fits less.
    expect(bitmap.paperZoom!).toBeLessThan(vector.paperZoom!)
    expect(vector.paperZoom).toBeCloseTo(
      resolvePaperFitZoom({ width: 400, height: 300 }, { width: 800, height: 600 }, false),
      12,
    )
    expect(bitmap.paperZoom).toBeCloseTo(
      resolvePaperFitZoom({ width: 400, height: 300 }, { width: 800, height: 600 }, true),
      12,
    )
  })

  it('fits res1 on the decided 0.5 density and keeps unknown legacy', () => {
    // Stored-resolution mapping: 2 -> 1.0, 1 -> 0.5 (decided), else undefined.
    expect(densityForBitmapStoredResolution(2)).toBe(BITMAP_RES2_PAPER_TO_CSS_DENSITY)
    expect(densityForBitmapStoredResolution(1)).toBeCloseTo(0.5, 12)
    expect(densityForBitmapStoredResolution(undefined)).toBeUndefined()
    // Unknown density: no fit, legacy reset scale 1, explicit reason.
    const unknown = resolveInitialFitViewport({
      contentBoundsSurface: { x: 190, y: 130, width: 100, height: 100 },
      surfaceSize: { width: 480, height: 360 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: undefined,
      isBitmap: true,
    })
    expect(unknown.fitted).toBe(false)
    expect(unknown.paperZoom).toBeNull()
    expect(unknown.viewport).toEqual({ x: 0, y: 0, scale: viewportResetScaleForDensity(undefined) })
    expect(unknown.viewport!.scale).toBe(1)
    expect(unknown.reason).toMatch(/unknown-density/)
    // Res1 (decided 0.5): 100x100 canvas -> 200x200 Paper, padded 375x375,
    // ratio 0.5*max(375/800,375/600)=0.3125 -> zoom 1.6, CSS 3.2, centered
    // (bounds center 240,180 == surface center).
    const res1 = resolveInitialFitViewport({
      contentBoundsSurface: { x: 190, y: 130, width: 100, height: 100 },
      surfaceSize: { width: 480, height: 360 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: densityForBitmapStoredResolution(1),
      isBitmap: true,
    })
    expect(res1.fitted).toBe(true)
    expect(res1.reason).toBe('fit: centered on content bounds')
    expect(res1.paperZoom).toBeCloseTo(1.6, 9)
    expect(res1.paperZoom).toBeCloseTo(
      resolvePaperFitZoom({ width: 200, height: 200 }, { width: 800, height: 600 }, true),
      12,
    )
    expect(res1.viewport!.scale).toBeCloseTo(3.2, 9)
    expect(res1.viewport!.x).toBeCloseTo(0, 12)
    expect(res1.viewport!.y).toBeCloseTo(0, 12)
  })

  it('returns not-ready (no save) for unlaid-out container/surface', () => {
    const readyBounds = { x: 950, y: 650, width: 500, height: 500 }
    const badContainer = resolveInitialFitViewport({
      contentBoundsSurface: readyBounds,
      surfaceSize: { width: 2400, height: 1800 },
      containerSize: { width: 0, height: 600 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    expect(badContainer.viewport).toBeNull()
    expect(badContainer.reason).toMatch(/not-ready/)
    const badSurface = resolveInitialFitViewport({
      contentBoundsSurface: readyBounds,
      surfaceSize: { width: 0, height: 1800 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    expect(badSurface.viewport).toBeNull()
  })

  it('unions surface rects including zero-area members (bare lines stay singular)', () => {
    expect(
      unionFitRects([
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 50, y: 25, width: 100, height: 50 },
        null,
        undefined,
      ]),
    ).toEqual({ x: 0, y: 0, width: 150, height: 75 })
    expect(unionFitRects([])).toBeNull()
    expect(unionFitRects([null, undefined])).toBeNull()
    // Bare line: zero height is kept in the union, the fit gate then fails
    // closed to the base (reference `bounds.width && bounds.height`).
    const line = unionFitRects([{ x: 10, y: 20, width: 100, height: 0 }])
    expect(line).toEqual({ x: 10, y: 20, width: 100, height: 0 })
    const lineFit = resolveInitialFitViewport({
      contentBoundsSurface: line,
      surfaceSize: { width: 2400, height: 1800 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    })
    expect(lineFit.fitted).toBe(false)
    expect(lineFit.reason).toMatch(/^singular:/)
  })

  it('is pure and deterministic (no drawing data or history side effects)', () => {
    const input = {
      contentBoundsSurface: { x: 0, y: 0, width: 500, height: 500 },
      surfaceSize: { width: 2400, height: 1800 },
      containerSize: { width: 800, height: 600 },
      paperToCssDensity: VECTOR_PAPER_TO_CSS_DENSITY,
      isBitmap: false,
    } as const
    const first = resolveInitialFitViewport({ ...input })
    const second = resolveInitialFitViewport({ ...input })
    expect(second).toEqual(first)
    // The input object is never mutated.
    expect(input.contentBoundsSurface).toEqual({ x: 0, y: 0, width: 500, height: 500 })
  })
})
