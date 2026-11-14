// Zoom unit-scale parity: Scratch Paper zoom vs current CSS viewportScale.
//
// QUESTION (from the review request): the recent zoom integration copied the
// Scratch Paper button step (`zoom += 0.5`) 1:1 onto the CSS viewport scale
// (`viewportScale += 0.5`). `paper-viewport-parity.ts` derives
//   screenPx / PaperUnit = (surfaceWidth / 960) * cssScale,
// whose W/960 coefficient differs per bitmap resolution and vector mode, so
// the numeric copy may mix units.
//
// METHOD: define the Scratch side from the vendored scratch-paint source
// (ESTABLISHED, file/line cited), define the current side from this repo's
// product source (ESTABLISHED, file/line cited), and normalize both to the
// same observable: "the same 480 scratch units render at how many screen px".
// Live-camera measurement of the current side lives in
// `zoom-unit-scale-parity.browser.test.ts`; this file pins the source-derived
// expected values and the parity verdicts.
//
// LEGEND (仮定と確定の区別):
// - [ESTABLISHED] directly read from the cited source lines.
// - [ASSUMPTION] a mapping this test introduces; verdicts built on one are
//   labelled with their assumption id. An assumption failing does NOT prove a
//   product malfunction -- it only bounds what the numbers mean.
//
// ASSUMPTIONS:
// - A1: current bitmap canvas px <-> Paper unit 1:1 (res2: 960 canvas px for
//   the 960-unit board; res1: 480 canvas px for the 480-unit half board).
//   Justification: Scratch draws res2 content pixel-verbatim onto the 960x720
//   raster (`paper-canvas.jsx` drawImage at ART_BOARD/2 - rotationCenter) and
//   this repo places stored sources verbatim (`bitmap-artboard.ts`
//   `placeSourceOnArtboard`). The res1 half-board reading is the ambiguous
//   point (see the RES1 section).
// - A3: current vector 1 SVG unit = 1 scratch unit (480-unit SVG board =
//   480-unit stage) and 1 SVG unit = 2 Paper units (Scratch imports SVG at
//   2x: `paper-canvas.jsx:305 scaleWithStrokes(item, 2, ...)`), so the 2400px
//   surface (480 svg * 5) stands for 960 Paper units.
// - A-ANCHOR-VEC: vector selection-center equivalence additionally needs the
//   import translation; marked unverified (no live Scratch instance here).
//
// PRODUCT CODE: `costume-viewport.ts` provides the explicit-density pure
// helpers (`buttonZoomStepForPaperDensity` / `wheelZoomForPaperDensity` +
// `cssScaleStepForPaperStep` / `paperStepForCssScaleStep`, read-only here)
// plus `resolveWheelViewportForPaperDensity` and the vector density
// (`VECTOR_PAPER_TO_CSS_DENSITY` 2.5); the live `BitmapEditor.svelte` wiring
// uses them on the vector path (buttons + ctrl-wheel, selection-center /
// pointer-fixed). The bitmap path intentionally keeps the legacy direct-copy
// helpers unchanged (res1/res2 UNVERIFIED, no coefficient hard-coded).
//
// RESOLUTION: the two `Paper-density parity` verdicts at the bottom assert
// true Scratch-equivalence of the per-Paper-unit zoom gain through the
// explicit-density helpers. They PASS. The legacy direct-copy gains
// (vector 1.25 / 0.25, 2.5x the Scratch gain under every source-grounded
// mapping) stay pinned alongside as the regression record of the recent
// integration, which ignored the 2400->960 coefficient 2.5. Expectations
// are NOT weakened (precision 12 throughout).
import { describe, expect, it } from 'bun:test'
import {
  COSTUME_VIEWPORT_BUTTON_STEP,
  COSTUME_VIEWPORT_DEFAULT_SCALE,
  COSTUME_VIEWPORT_MAX_SCALE,
  COSTUME_VIEWPORT_MIN_SCALE,
  COSTUME_VIEWPORT_MIN_STEP_TARGET,
  COSTUME_VIEWPORT_WHEEL_DIVISOR,
  buttonZoomStepAdditive,
  buttonZoomStepForPaperDensity,
  paperStepForCssScaleStep,
  wheelZoomAdditiveScale,
  wheelZoomForPaperDensity,
} from '../src/features/costumes/costume-viewport'
import {
  PAPER_ART_BOARD,
  cssPxPerPaperUnit,
  paperZoomForCssScale,
} from '../src/features/costumes/paper-viewport-parity'

// ---------------------------------------------------------------------------
// [ESTABLISHED] Scratch side, read from
// `.tmp/scratch-editor/packages/scratch-paint` (no vendor code copied).
// ---------------------------------------------------------------------------
const SCRATCH = {
  // helper/view.js:12-16: SVG board 480x360, Paper board 960x720 (2x),
  // CENTER = (480, 360).
  svgBoard: { width: 480, height: 360 },
  paperBoard: { width: 960, height: 720 },
  center: { x: 480, y: 360 },
  // helper/view.js:21 + paint-editor.jsx:215-216: floor 0.333; zooming in
  // from exactly the floor uses delta 0.5 - 0.333 instead of the full step.
  outermostZoomLevel: 0.333,
  // helper/view.js:144-145 + paint-editor.jsx:72-74 + :211-226: reset zoom
  // 0.5; buttons add/subtract ZOOM_INCREMENT = 0.5 Paper units about the
  // selection center (zoomOnSelection, view.js:125-142) or the view center.
  resetZoom: 0.5,
  zoomIncrement: 0.5,
  // containers/scrollable-canvas.jsx:97,108: ctrl-wheel deltaZoom =
  // -deltaY / 1000 (line mode x15), pinned at the cursor project point
  // (zoomOnFixedPoint, view.js:108-122: newZoom = max(0.333, zoom + delta));
  // pan divides by view.zoom (:115,119-120: dx/zoom world units).
  wheelDeltaDivisor: 1000,
  lineDeltaMultiplier: 15,
} as const

// ---------------------------------------------------------------------------
// [ESTABLISHED] Current side, read from this repo's product source.
// ---------------------------------------------------------------------------
const CURRENT = {
  // costume-viewport.ts:70-72: closed band 0.25..5, reset 1.
  minScale: COSTUME_VIEWPORT_MIN_SCALE, // 0.25
  maxScale: COSTUME_VIEWPORT_MAX_SCALE, // 5
  resetScale: COSTUME_VIEWPORT_DEFAULT_SCALE, // 1
  // costume-viewport.ts:93-100: additive button step 0.5 CSS units with the
  // 0.25 -> 0.5 floor-exit special (mirrors the 0.333 -> 0.5 pattern).
  buttonStep: COSTUME_VIEWPORT_BUTTON_STEP, // 0.5
  minStepTarget: COSTUME_VIEWPORT_MIN_STEP_TARGET, // 0.5
  // costume-viewport.ts:103 + :205-213: ctrl-wheel gain -deltaY/1000 CSS
  // units, pinned at the surface point under the cursor.
  wheelDivisor: COSTUME_VIEWPORT_WHEEL_DIVISOR, // 1000
  // BitmapEditor.svelte:94-104,992-998: bitmap surface = live canvas
  // (sprite res2 960x720, res1 480x360); vector surface = fixed 2400x1800
  // (480x360 stage x5). Editor.svelte:12896-12897 passes
  // vectorCanvasWidth/Height = 480x360, so the default art box is
  // 480*5 = 2400 wide and fills the surface.
  bitmapRes2Surface: { width: 960, height: 720 },
  bitmapRes1Surface: { width: 480, height: 360 },
  vectorSurface: { width: 2400, height: 1800 },
  vectorArtUnits: { width: 480, height: 360 }, // SVG units [A3]
} as const

// --- Normalization ---------------------------------------------------------
// Screen px for the SAME 480-scratch-unit span (full stage width).
//
// Scratch [ESTABLISHED]: content pixels are resolution-dependent. A res2
// asset carries 960 canvas px for the 480-unit span (drawn verbatim onto the
// 960 raster); a res1 asset carries 480 canvas px, drawn at
// (ART_BOARD/2 - rotationCenter) so full-stage res1 content spans Paper
// x in [240,720), i.e. 480 Paper px. Screen px = paperPx * zoom.
const scratchRes2ScreenPxFor480Units = (zoom: number): number => 960 * zoom
const scratchRes1ScreenPxFor480Units = (zoom: number): number => 480 * zoom

// Current [ESTABLISHED geometry] x [ASSUMPTION mapping A1/A3]: the bitmap
// canvas fills its surface 1:1, so a res2 canvas shows the 480-unit span in
// 960 surface px and a res1 canvas in 480 surface px; the vector art box
// shows it in 480*5 = 2400 surface px. Screen px = surfacePx * scale.
const currentBitmapRes2ScreenPxFor480Units = (scale: number): number => 960 * scale
const currentBitmapRes1ScreenPxFor480Units = (scale: number): number => 480 * scale
const currentVectorScreenPxFor480Units = (scale: number): number => 2400 * scale

describe('zoom unit-scale parity: source definitions', () => {
  it('pins the Scratch Paper zoom frame (source-read, no product import)', () => {
    expect(SCRATCH.paperBoard).toEqual({ width: 960, height: 720 })
    expect(SCRATCH.svgBoard).toEqual({ width: 480, height: 360 })
    expect(SCRATCH.center).toEqual({ x: 480, y: 360 })
    expect(SCRATCH.outermostZoomLevel).toBe(0.333)
    expect(SCRATCH.resetZoom).toBe(0.5)
    expect(SCRATCH.zoomIncrement).toBe(0.5)
    expect(SCRATCH.wheelDeltaDivisor).toBe(1000)
    expect(SCRATCH.lineDeltaMultiplier).toBe(15)
    // resetZoom (0.5) renders the full 480-unit span at:
    expect(scratchRes2ScreenPxFor480Units(0.5)).toBe(480) // res2: 960*0.5
    expect(scratchRes1ScreenPxFor480Units(0.5)).toBe(240) // res1: 480*0.5
  })

  it('pins the current CSS camera frame (product constants, read-only)', () => {
    expect(CURRENT.minScale).toBe(0.25)
    expect(CURRENT.maxScale).toBe(5)
    expect(CURRENT.resetScale).toBe(1)
    expect(CURRENT.buttonStep).toBe(0.5)
    expect(CURRENT.minStepTarget).toBe(0.5)
    expect(CURRENT.wheelDivisor).toBe(1000)
    // Label is Math.round(scale*100)% (BitmapEditor.svelte:2869): reset reads
    // "100%" while the Scratch-equivalent reset zoom 0.5 has no percent
    // mapping in this UI (paper-viewport-parity PAPER_ZOOM_PERCENT_MAPPING).
    expect(Math.round(CURRENT.resetScale * 100)).toBe(100)
    // Reset renders the same 480-unit span at (surface px * 1):
    expect(currentBitmapRes2ScreenPxFor480Units(1)).toBe(960)
    expect(currentBitmapRes1ScreenPxFor480Units(1)).toBe(480)
    expect(currentVectorScreenPxFor480Units(1)).toBe(2400)
  })
})

describe('zoom unit-scale parity: expected values per gesture', () => {
  it('+/- buttons from the defaults (additive steps, selection-anchored)', () => {
    // Scratch [ESTABLISHED]: 0.5 +/- 0.5 about the selection center.
    expect(SCRATCH.resetZoom + SCRATCH.zoomIncrement).toBe(1.0)
    expect(scratchRes2ScreenPxFor480Units(1.0)).toBe(960) // 480 -> 960 (2x)
    expect(scratchRes1ScreenPxFor480Units(1.0)).toBe(480) // 240 -> 480 (2x)
    // Current [ESTABLISHED]: 1 +/- 0.5 via buttonZoomStepAdditive.
    expect(buttonZoomStepAdditive(1, 1)).toBeCloseTo(1.5, 12)
    expect(buttonZoomStepAdditive(1, -1)).toBeCloseTo(0.5, 12)
    expect(currentBitmapRes2ScreenPxFor480Units(1.5)).toBe(1440) // 960 -> 1440 (1.5x)
    expect(currentBitmapRes1ScreenPxFor480Units(1.5)).toBe(720) // 480 -> 720 (1.5x)
    expect(currentVectorScreenPxFor480Units(1.5)).toBe(3600) // 2400 -> 3600 (1.5x)
    // Absolute increment for the same content span: bitmap matches Scratch
    // (res2: +480 vs +480; res1: +240 vs +240) while vector adds +1200 vs
    // Scratch's +480 -- the first quantitative trace of the unit gap [A3].
    expect(1440 - 960).toBe(960 - 480)
    expect(720 - 480).toBe(480 - 240)
    expect(3600 - 2400).not.toBe(960 - 480)
  })

  it('outermost floor and the floor-exit special step', () => {
    // Scratch [ESTABLISHED]: zoom-out clamps at 0.333 (no lower band edge);
    // zooming in from exactly 0.333 uses delta 0.5-0.333 = 0.167.
    expect(SCRATCH.resetZoom - SCRATCH.outermostZoomLevel).toBeCloseTo(0.167, 12)
    expect(scratchRes2ScreenPxFor480Units(0.333)).toBeCloseTo(319.68, 10)
    expect(scratchRes1ScreenPxFor480Units(0.333)).toBeCloseTo(159.84, 10)
    // Current [ESTABLISHED]: closed band; 0.25 floor, zoom-in from 0.25
    // lands on 0.5 (delta 0.25, not a full 0.5 step).
    expect(buttonZoomStepAdditive(0.25, 1)).toBeCloseTo(0.5, 12)
    expect(buttonZoomStepAdditive(0.25, -1)).toBe(CURRENT.minScale)
    expect(buttonZoomStepAdditive(0.5, -1)).toBeCloseTo(0.25, 12) // 0.5-0.5 clamps
    expect(currentBitmapRes2ScreenPxFor480Units(0.25)).toBe(240)
    expect(currentBitmapRes1ScreenPxFor480Units(0.25)).toBe(120)
    expect(currentVectorScreenPxFor480Units(0.25)).toBe(600)
  })

  it('ctrl-wheel -100 tick (additive gain, pointer-anchored)', () => {
    // Scratch [ESTABLISHED]: -deltaY/1000 = +0.1 Paper units at the cursor.
    expect(-(-100) / SCRATCH.wheelDeltaDivisor).toBeCloseTo(0.1, 12)
    expect(scratchRes2ScreenPxFor480Units(0.6)).toBe(576) // 480 + 96
    expect(scratchRes1ScreenPxFor480Units(0.6)).toBe(288) // 240 + 48
    // Current [ESTABLISHED]: same divisor in CSS units (+0.1 scale).
    expect(wheelZoomAdditiveScale(1, -100)).toBeCloseTo(1.1, 12)
    expect(currentBitmapRes2ScreenPxFor480Units(1.1)).toBe(1056) // 960 + 96
    expect(currentBitmapRes1ScreenPxFor480Units(1.1)).toBe(528) // 480 + 48
    expect(currentVectorScreenPxFor480Units(1.1)).toBe(2640) // 2400 + 240
    // Same absolute deltas as Scratch for bitmap (+96/+48), 2.5x for vector
    // (+240 vs +96) [A3].
    expect(1056 - 960).toBe(576 - 480)
    expect(2640 - 2400).not.toBe(576 - 480)
  })

  it('selection anchor geometry coincides for bitmap under A1', () => {
    // Fixture from the live audit (paper-viewport-parity.browser.test.ts):
    // 190x200 source placed at (384,264) on the res2 canvas.
    const selection = { x: 384, y: 264, width: 190, height: 200 }
    const scratchAnchorPaper = {
      // zoomOnSelection anchors the union item.bounds center (Paper units).
      x: selection.x + selection.width / 2, // 479
      y: selection.y + selection.height / 2, // 364
    }
    const currentAnchorSurface = {
      // selectionSurfacePoint anchors the selection center (canvas px).
      x: selection.x + selection.width / 2, // 479
      y: selection.y + selection.height / 2, // 364
    }
    expect(scratchAnchorPaper).toEqual({ x: 479, y: 364 })
    // Numerically identical frame under A1 (1 canvas px = 1 Paper unit);
    // with no selection both sides fall back to the artwork center
    // (Scratch: view center ~ (480,360); current: surface center
    // (W/2,H/2) = (480,360) canvas px for res2, (240,180) for res1).
    expect(currentAnchorSurface).toEqual(scratchAnchorPaper)
    expect({ x: 960 / 2, y: 720 / 2 }).toEqual({ x: 480, y: 360 })
    expect({ x: 480 / 2, y: 360 / 2 }).toEqual({ x: 240, y: 180 })
  })

  it('vector selection anchor mapping is assumption-tagged [A3/A-ANCHOR-VEC]', () => {
    // Current [ESTABLISHED] (BitmapEditor.svelte selectionSurfacePoint):
    // surface anchor = artLeft + svgCenter * 5, with
    // artLeft = ((480 - vectorCanvasWidth)/2) * 5.
    const vectorCanvasWidth = 480 // Editor.svelte:12896
    const artLeft = ((480 - vectorCanvasWidth) / 2) * 5 // 0
    const svgCenter = { x: 100, y: 80 }
    const currentAnchor = { x: artLeft + svgCenter.x * 5, y: 0 + svgCenter.y * 5 }
    expect(currentAnchor).toEqual({ x: 500, y: 400 })
    // Scratch-side equivalent (2x import + CENTER translation) depends on the
    // import translation, which this test does NOT establish live
    // [A-ANCHOR-VEC]: recorded here as an explicit unverified mapping, not
    // as an equality verdict.
    const scratchAnchorIfCenteredImport = {
      x: SCRATCH.center.x + (svgCenter.x - 240) * 2,
      y: SCRATCH.center.y + (svgCenter.y - 180) * 2,
    }
    expect(scratchAnchorIfCenteredImport).toEqual({ x: 200, y: 160 })
    // (500,400) surface px at scale 1 vs (200,160) Paper px at zoom 0.5:
    // only equal on screen (500 vs 200*... ) -- no verdict asserted; the
    // browser test measures the current side live instead.
  })
})

describe('zoom unit-scale parity: res1 coefficient ambiguity (no verdict, both readings pinned)', () => {
  it('shows the two source-grounded readings of the res1 gain', () => {
    // Reading R-board (paper-viewport-parity.ts default: Pw = 960 always):
    // cssPxPerPaperUnit(480, 960, s) = 0.5*s, so a +0.5 CSS step adds 0.25
    // screen px per Paper unit -- half the Scratch gain of 0.5.
    expect(cssPxPerPaperUnit(480, 960, 1)).toBeCloseTo(0.5, 12)
    expect(cssPxPerPaperUnit(480, 960, 1.5) - cssPxPerPaperUnit(480, 960, 1)).toBeCloseTo(0.25, 12)
    // Reading R-own (each surface stands for its own pixel count in Paper
    // units, i.e. Pw = W under A1): cssPxPerPaperUnit(480, 480, s) = s, so a
    // +0.5 step adds 0.5 -- exactly the Scratch gain.
    expect(cssPxPerPaperUnit(480, 480, 1)).toBeCloseTo(1, 12)
    expect(cssPxPerPaperUnit(480, 480, 1.5) - cssPxPerPaperUnit(480, 480, 1)).toBeCloseTo(0.5, 12)
    // The repo's own forward conversion exposes the fork: CSS 1 with a
    // res1 surface is Paper 0.5 under R-board but Paper 1.0 under R-own.
    expect(paperZoomForCssScale(1, 480, 960)).toBeCloseTo(0.5, 12)
    expect(paperZoomForCssScale(1, 480, 480)).toBeCloseTo(1.0, 12)
    // No equality verdict: which Pw is "the" Paper extent for a res1 canvas
    // is the open unit question, so both numbers stay pinned, neither wins.
  })
})

describe('Paper-density parity: per-Paper-unit zoom gain vs Scratch (explicit-density helpers)', () => {
  // Gain = added screen px per Paper unit for one +0.5-button gesture.
  // Scratch [ESTABLISHED]: +0.5 zoom by definition (+0.5 screen px/PaperUnit).
  // Legacy integration (direct 0.5-CSS copy, still live in the UI wiring):
  // vector +0.5 scale x (2400 surface px / 960 Paper units) = +1.25 -- 2.5x
  // the Scratch gain. This factor is assumption-robust: any source-grounded
  // Pw in {480, 960} gives a gain in {2.5, 1.25}, never 0.5 (that would need
  // Pw = 2400, i.e. 1 SVG unit = 5 Paper units, contradicting the 2x import).
  // The density-aware helpers divide the CSS step by the explicit density so
  // the Paper gain matches Scratch exactly; bitmap res1/res2 densities are
  // derived per assumption below, never assumed.
  const vectorSurfacePxPerPaperUnit = 2400 / PAPER_ART_BOARD.width // 2.5 [A3]
  const scratchButtonGain = 0.5
  const legacyVectorButtonGain = CURRENT.buttonStep * vectorSurfacePxPerPaperUnit // 1.25

  it('vector button-step gain equals the Scratch Paper gain via the density helper', () => {
    expect(vectorSurfacePxPerPaperUnit).toBeCloseTo(2.5, 12)
    // Regression pin: the legacy direct copy really was 2.5x (not weakened).
    expect(legacyVectorButtonGain).toBeCloseTo(1.25, 12)
    expect(legacyVectorButtonGain).not.toBeCloseTo(scratchButtonGain, 12)
    // Parity path: explicit density 2.5 converts the +0.5 Paper step into a
    // +0.2 CSS step, whose Paper gain is exactly +0.5.
    const nextCss = buttonZoomStepForPaperDensity(1, 1, vectorSurfacePxPerPaperUnit)
    expect(nextCss).toBeCloseTo(1.2, 12)
    const paperGain = paperStepForCssScaleStep(nextCss - 1, vectorSurfacePxPerPaperUnit)
    expect(paperGain).toBeCloseTo(0.5, 12)
    expect(paperGain).toBeCloseTo(scratchButtonGain, 12)
    // Bitmap res2 under A1 R-own (density 960/960 = 1) keeps parity through
    // the same helper and coincides with the legacy copy there.
    const res2Density = 960 / 960 // 1 [A1 R-own]
    const res2Next = buttonZoomStepForPaperDensity(1, 1, res2Density)
    expect(res2Next).toBeCloseTo(buttonZoomStepAdditive(1, 1), 12)
    expect(paperStepForCssScaleStep(res2Next - 1, res2Density)).toBeCloseTo(scratchButtonGain, 12)
  })

  it('vector wheel-step gain equals the Scratch Paper gain via the density helper', () => {
    // One ctrl-wheel -100 tick: Scratch +0.1 zoom; legacy current +0.1 scale.
    const scratchWheelGain = 0.1
    const legacyVectorWheelGain = 0.1 * vectorSurfacePxPerPaperUnit // 0.25
    // Regression pin: the legacy direct copy really was 2.5x (not weakened).
    expect(legacyVectorWheelGain).toBeCloseTo(0.25, 12)
    expect(legacyVectorWheelGain).not.toBeCloseTo(scratchWheelGain, 12)
    // Parity path: explicit density 2.5 converts the +0.1 Paper gain into a
    // +0.04 CSS step.
    const nextCss = wheelZoomForPaperDensity(1, -100, vectorSurfacePxPerPaperUnit)
    expect(nextCss).toBeCloseTo(1.04, 12)
    const paperGain = paperStepForCssScaleStep(nextCss - 1, vectorSurfacePxPerPaperUnit)
    expect(paperGain).toBeCloseTo(0.1, 12)
    expect(paperGain).toBeCloseTo(scratchWheelGain, 12)
    // Bitmap res1 stays assumption-separated (no verdict): R-board density
    // 0.5 gives CSS +0.2 for the -100 tick, R-own density 1.0 gives +0.1.
    // Both numbers pinned; neither is claimed as the true conversion.
    expect(wheelZoomForPaperDensity(1, -100, 480 / 960)).toBeCloseTo(1.2, 12)
    expect(wheelZoomForPaperDensity(1, -100, 480 / 480)).toBeCloseTo(1.1, 12)
  })
})
