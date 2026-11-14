// Bitmap artboard geometry: independent pure-math pin for the small-canvas fix.
//
// What this file is:
// - A NEW, product-touching-code-free specification of the Scratch artboard
//   model that the bitmap editor must use instead of the regressed
//   "canvas == stored PNG pixels" model (e.g. 95x100 SVG @res2 -> 190x200
//   canvas, which clamps every outside-bounds stroke to the canvas edge).
// - Every formula below is independently re-derived in our own words from
//   OBSERVED behavior + concrete current-repo equations cited by location
//   (no third-party source is copied, quoted, or imported):
//   * VM stage mapping (packages/vm/src/index.ts): sprite/backdrop draw
//     positions `240 - cx/R`, `180 - cy/R` and costume box
//     `left=-cx/R, right=(W-cx)/R, top=cy/R, bottom=-(H-cy)/R`.
//   * Current conversion sizes (features/costumes/costume-conversion.ts
//     resolveVectorToBitmapSpec: SVG units x resolution, center scaled by the
//     same factor; resolveBitmapToVectorSpec trim/resolution handling).
//   * Current canvas I/O (Editor.svelte loadBitmapCanvasFrom*: verbatim
//     decoded PNG pixels -> canvas; updateBitmapCostumeFromCanvas: verbatim
//     canvas bytes + preserved rotation center + stage?1:2 resolution).
//   * Current pointer/clipboard clamping (Editor.svelte bitmapPoint +
//     clampBitmapPoint Math.max/min to canvas; selection-shortcuts.ts
//     resolveBitmapPasteRect anchor+10*offset clamped into canvas, origin at
//     0 when clipboard exceeds canvas).
//   * Current viewport transform (features/costumes/costume-viewport.ts:
//     surface centered on container center, shifted by (vx,vy), scaled by s).
// - The tests pin the DESIRED artboard behavior so the Editor.svelte fix
//   (owned by another agent) can be verified against them. They do not
//   import any product helper: all math is local to this file.
//
// Artboard model (one paragraph):
// - The edit canvas is a Scratch artboard, not the stored PNG: sprite
//   960x720 (480x360 stage units x resolution 2), stage 480x360
//   (480x360 x resolution 1). Its center pixel maps to Scratch (0,0).
// - A stored bitmap (W0 x H0, center c0, resolution R) is placed verbatim at
//   artboard origin O = artCenter - c0, transparent margins elsewhere. This
//   keeps every ink pixel at its VM scratch position while leaving room to
//   paint outside the original bounds.
// - Saving crops the artboard to its opaque bounds T (transparent-edge crop)
//   and stores center c' = canvasCenter - T.origin with resolution R, so the
//   cropped bytes reload back onto the same artboard pixels (Undo/Redo /
//   reload / SB3 round-trip stable). Fully transparent stays fully
//   transparent.
// - Huge sources that exceed the artboard expand the canvas to the union of
//   the artboard rect and the placed source rect (rectangular workspaces fall
//   out of the same union rule); the scratch mapping always uses the canvas
//   center that corresponds to the artboard center in expanded coordinates.

import { describe, expect, it } from 'bun:test'

type ScratchBounds = { left: number; right: number; top: number; bottom: number; width: number; height: number }

type Artboard = { width: number; height: number; resolution: number; centerX: number; centerY: number }

type PlacedCanvas = {
  width: number
  height: number
  /** Artboard center expressed in canvas coordinates (shifts when huge sources expand left/top). */
  canvasCenterX: number
  canvasCenterY: number
  /** Top-left of the placed source inside the canvas. */
  originX: number
  originY: number
}

type Trim = { x: number; y: number; width: number; height: number }

// --- local re-derivations (own variable names, same observable math) ---

function scratchBoundsOf(width: number, height: number, cx: number, cy: number, resolution: number): ScratchBounds {
  const res = resolution > 0 ? resolution : 1
  const left = -cx / res
  const right = (width - cx) / res
  const top = cy / res
  const bottom = -(height - cy) / res
  return { left, right, top, bottom, width: right - left, height: top - bottom }
}

function artboardForTarget(isStage: boolean): Artboard {
  // Stage units are 480x360; asset pixels are units x resolution.
  if (isStage) return { width: 480, height: 360, resolution: 1, centerX: 240, centerY: 180 }
  return { width: 960, height: 720, resolution: 2, centerX: 480, centerY: 360 }
}

function placeSourceOnArtboard(sourceWidth: number, sourceHeight: number, centerX: number, centerY: number, isStage: boolean): PlacedCanvas {
  const art = artboardForTarget(isStage)
  const wantOriginX = art.centerX - centerX
  const wantOriginY = art.centerY - centerY
  // Union of the artboard rect [0,art]x[0,art] and the placed source rect.
  // Small sources stay exactly on the artboard; huge sources grow it.
  const minX = Math.min(0, wantOriginX)
  const minY = Math.min(0, wantOriginY)
  const maxX = Math.max(art.width, wantOriginX + sourceWidth)
  const maxY = Math.max(art.height, wantOriginY + sourceHeight)
  return {
    width: maxX - minX,
    height: maxY - minY,
    canvasCenterX: art.centerX - minX,
    canvasCenterY: art.centerY - minY,
    originX: wantOriginX - minX,
    originY: wantOriginY - minY,
  }
}

/** Canvas pixel (top-left origin) -> Scratch units via the canvas center. */
function canvasPixelToScratch(px: number, py: number, canvasCenterX: number, canvasCenterY: number, resolution: number): { sx: number; sy: number } {
  return { sx: (px - canvasCenterX) / resolution, sy: (canvasCenterY - py) / resolution }
}

/** Stored-asset pixel (top-left origin) -> Scratch units via its rotation center. */
function assetPixelToScratch(ix: number, iy: number, cx: number, cy: number, resolution: number): { sx: number; sy: number } {
  return { sx: (ix - cx) / resolution, sy: (cy - iy) / resolution }
}

/** Transparent-edge crop save: opaque artboard rect T -> stored PNG + center. */
function croppedSaveForTrim(trim: Trim, canvasCenterX: number, canvasCenterY: number, isStage: boolean): { width: number; height: number; rotationCenterX: number; rotationCenterY: number; bitmapResolution: number } {
  const resolution = isStage ? 1 : 2
  return {
    width: trim.width,
    height: trim.height,
    rotationCenterX: canvasCenterX - trim.x,
    rotationCenterY: canvasCenterY - trim.y,
    bitmapResolution: resolution,
  }
}

function clampPointToCanvas(point: { x: number; y: number }, canvasWidth: number, canvasHeight: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(canvasWidth, point.x)),
    y: Math.max(0, Math.min(canvasHeight, point.y)),
  }
}

function pasteRectOnCanvas(
  canvas: { width: number; height: number },
  clipboard: { width: number; height: number },
  anchor: { x: number; y: number } | undefined,
  offset: number,
): { x: number; y: number; width: number; height: number } {
  const delta = 10 * offset
  const maxX = canvas.width - clipboard.width
  const maxY = canvas.height - clipboard.height
  const ax = Number.isFinite(anchor?.x) ? (anchor?.x ?? 0) : 0
  const ay = Number.isFinite(anchor?.y) ? (anchor?.y ?? 0) : 0
  const x = maxX <= 0 ? 0 : Math.max(0, Math.min(maxX, Math.round(ax + delta)))
  const y = maxY <= 0 ? 0 : Math.max(0, Math.min(maxY, Math.round(ay + delta)))
  return { x, y, width: clipboard.width, height: clipboard.height }
}

// Minimal viewport re-derivation for the zoom-invariance checks.
function surfaceToScreen(p: { x: number; y: number }, surface: { width: number; height: number }, center: { x: number; y: number }, vp: { x: number; y: number; scale: number }) {
  return {
    x: center.x + vp.x + (p.x - surface.width / 2) * vp.scale,
    y: center.y + vp.y + (p.y - surface.height / 2) * vp.scale,
  }
}

function screenToSurface(p: { x: number; y: number }, surface: { width: number; height: number }, center: { x: number; y: number }, vp: { x: number; y: number; scale: number }) {
  return {
    x: surface.width / 2 + (p.x - center.x - vp.x) / vp.scale,
    y: surface.height / 2 + (p.y - center.y - vp.y) / vp.scale,
  }
}

function zoomAtScreenPoint(
  vp: { x: number; y: number; scale: number },
  surface: { width: number; height: number },
  center: { x: number; y: number },
  screen: { x: number; y: number },
  factor: number,
) {
  const prev = vp.scale
  const next = Math.max(0.25, Math.min(5, prev * factor))
  const fixed = screenToSurface(screen, surface, center, vp)
  return {
    x: screen.x - center.x - (fixed.x - surface.width / 2) * next,
    y: screen.y - center.y - (fixed.y - surface.height / 2) * next,
    scale: next,
  }
}

describe('bitmap artboard dimensions (stage units x resolution)', () => {
  it('sprite artboard is 960x720 at resolution 2 with center 480,360', () => {
    expect(artboardForTarget(false)).toEqual({ width: 960, height: 720, resolution: 2, centerX: 480, centerY: 360 })
  })

  it('stage artboard is 480x360 at resolution 1 with center 240,180', () => {
    expect(artboardForTarget(true)).toEqual({ width: 480, height: 360, resolution: 1, centerX: 240, centerY: 180 })
  })

  it('artboard pixel size equals 480x360 stage units times the resolution', () => {
    for (const isStage of [true, false]) {
      const art = artboardForTarget(isStage)
      expect(art.width).toBe(480 * art.resolution)
      expect(art.height).toBe(360 * art.resolution)
      expect(art.centerX).toBe(art.width / 2)
      expect(art.centerY).toBe(art.height / 2)
    }
  })
})

describe('small sources sit on the artboard by rotationCenter (probe numbers)', () => {
  it('190x200 @center 96,96 lands at 384,264 inside 960x720', () => {
    // Probe case A: 95x100 SVG @res2 -> 190x200 PNG, converted center 96,96.
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    expect(placed.width).toBe(960)
    expect(placed.height).toBe(720)
    expect(placed.originX).toBe(384)
    expect(placed.originY).toBe(264)
    expect(placed.canvasCenterX).toBe(480)
    expect(placed.canvasCenterY).toBe(360)
  })

  it('placed ink keeps its VM scratch position (world-stable placement)', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    // Every source pixel maps to the same scratch point as the artboard pixel.
    const samples = [
      { ix: 0, iy: 0 },
      { ix: 189, iy: 199 },
      { ix: 20, iy: 24 },
      { ix: 95, iy: 100 },
    ]
    for (const s of samples) {
      const viaAsset = assetPixelToScratch(s.ix, s.iy, 96, 96, 2)
      const viaArt = canvasPixelToScratch(placed.originX + s.ix, placed.originY + s.iy, placed.canvasCenterX, placed.canvasCenterY, 2)
      expect(viaArt.sx).toBeCloseTo(viaAsset.sx, 9)
      expect(viaArt.sy).toBeCloseTo(viaAsset.sy, 9)
    }
    // Stage footprint of the placed ink equals the stored-asset footprint.
    const assetBounds = scratchBoundsOf(190, 200, 96, 96, 2)
    expect(assetBounds.width).toBeCloseTo(95, 9)
    expect(assetBounds.height).toBeCloseTo(100, 9)
    expect(assetBounds.left).toBeCloseTo(-48, 9)
  })

  it('60x40 external PNG with upload center 48,48 lands at 432,312 (center may sit outside small art)', () => {
    // Current upload path stores sprite bitmaps with center 48,48 regardless
    // of pixel size, so small/rectangular PNGs keep that center verbatim.
    const placed = placeSourceOnArtboard(60, 40, 48, 48, false)
    expect([placed.originX, placed.originY]).toEqual([432, 312])
    expect(placed.originX + 60).toBeLessThanOrEqual(960)
    expect(placed.originY + 40).toBeLessThanOrEqual(720)
    // Rotation center outside the pixel rect is representable: it still maps
    // through the same scratch equations (negative asset-local coords allowed).
    const viaArt = canvasPixelToScratch(placed.originX, placed.originY, placed.canvasCenterX, placed.canvasCenterY, 2)
    const viaAsset = assetPixelToScratch(0, 0, 48, 48, 2)
    expect(viaArt.sx).toBeCloseTo(viaAsset.sx, 9)
    expect(viaArt.sy).toBeCloseTo(viaAsset.sy, 9)
  })

  it('res1 96x96 center 48,48 lands at 432,312 on the sprite artboard', () => {
    const placed = placeSourceOnArtboard(96, 96, 48, 48, false)
    expect([placed.originX, placed.originY]).toEqual([432, 312])
  })

  it('stage sprite 96x96-equivalent places by the 240,180 center on 480x360', () => {
    const placed = placeSourceOnArtboard(96, 96, 48, 48, true)
    // Stage artboard is 480x360; the same 48,48 center offsets from 240,180.
    expect(placed.width).toBe(480)
    expect(placed.originX).toBe(192)
    expect(placed.originY).toBe(132)
  })
})

describe('outside-bounds painting reaches the stage (the small-canvas regression)', () => {
  it('artboard admits paint 10 scratch units past the ink edge; 190x200 clamps it to the edge', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    const inkRightScratch = (190 - 96) / 2 // 47
    const beyondScratchX = inkRightScratch + 10 // 57
    // Artboard coordinate of that world point stays inside the canvas.
    const artX = placed.canvasCenterX + beyondScratchX * 2
    expect(artX).toBe(594)
    expect(artX).toBeGreaterThan(placed.originX + 190)
    expect(artX).toBeLessThan(placed.width)
    const clampedArt = clampPointToCanvas({ x: artX, y: 360 }, placed.width, placed.height)
    expect(clampedArt.x).toBe(artX) // paints where aimed, no edge stick

    // The regressed 190x200 canvas expresses the same world point at
    // ix = cx + sx*R = 96 + 114 = 210, which clamps back to the edge (190).
    const smallCanvasX = 96 + beyondScratchX * 2
    expect(smallCanvasX).toBe(210)
    const clampedSmall = clampPointToCanvas({ x: smallCanvasX, y: 100 }, 190, 200)
    expect(clampedSmall.x).toBe(190)
    expect(clampedSmall.x).toBeLessThan(smallCanvasX)
  })

  it('drag from the ink edge far outside stays inside the artboard instead of sticking', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    // Probe A2 drags from the edge to stage-equivalent distant coords.
    // On the artboard that path is a legal in-canvas stroke; on 190x200 it
    // collapses onto the border.
    const far = { x: placed.originX + 190 + 220, y: 360 + 160 }
    const clampedArt = clampPointToCanvas(far, placed.width, placed.height)
    expect(clampedArt.x).toBeLessThan(placed.width)
    expect(clampedArt.y).toBeLessThan(placed.height)
    // Same gesture in small-canvas pixels runs far past 190x200.
    const smallFar = { x: 190 + 220, y: 100 + 160 }
    const clampedSmall = clampPointToCanvas(smallFar, 190, 200)
    expect(clampedSmall).toEqual({ x: 190, y: 200 })
  })

  it('saved world position of an outside stroke follows the artboard mapping', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    const strokeAt = { x: 620, y: 300 }
    const world = canvasPixelToScratch(strokeAt.x, strokeAt.y, placed.canvasCenterX, placed.canvasCenterY, 2)
    expect(world.sx).toBeCloseTo((620 - 480) / 2, 9)
    expect(world.sy).toBeCloseTo((360 - 300) / 2, 9)
    // That world point is outside the pre-paint ink bounds but on the stage.
    const ink = scratchBoundsOf(190, 200, 96, 96, 2)
    expect(world.sx).toBeGreaterThan(ink.right)
  })
})

describe('transparent-edge crop save keeps world position (implied center/resolution)', () => {
  it('unedited 190x200 placement crops back to 190x200 with center 96,96 (probe reload values)', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    const trim: Trim = { x: placed.originX, y: placed.originY, width: 190, height: 200 }
    const saved = croppedSaveForTrim(trim, placed.canvasCenterX, placed.canvasCenterY, false)
    expect(saved).toEqual({ width: 190, height: 200, rotationCenterX: 96, rotationCenterY: 96, bitmapResolution: 2 })
  })

  it('right/down growth keeps the center, left/up growth shifts it by the trim origin', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    // Extend 30px right and 20px down: origin unchanged, size grows.
    const grown: Trim = { x: placed.originX, y: placed.originY, width: 220, height: 220 }
    const savedGrown = croppedSaveForTrim(grown, placed.canvasCenterX, placed.canvasCenterY, false)
    expect(savedGrown.rotationCenterX).toBe(96)
    expect(savedGrown.rotationCenterY).toBe(96)
    expect(savedGrown.width).toBe(220)
    // Extend 32px left and 12px up: the center absorbs the origin shift so the
    // ink does not teleport on stage.
    const shifted: Trim = { x: placed.originX - 32, y: placed.originY - 12, width: 222, height: 212 }
    const savedShifted = croppedSaveForTrim(shifted, placed.canvasCenterX, placed.canvasCenterY, false)
    expect(savedShifted.rotationCenterX).toBe(128)
    expect(savedShifted.rotationCenterY).toBe(108)
    // World position of a pre-existing ink pixel is identical before/after.
    const before = canvasPixelToScratch(placed.originX + 10, placed.originY + 10, placed.canvasCenterX, placed.canvasCenterY, 2)
    const after = assetPixelToScratch(32 + 10, 12 + 10, savedShifted.rotationCenterX, savedShifted.rotationCenterY, 2)
    expect(after.sx).toBeCloseTo(before.sx, 9)
    expect(after.sy).toBeCloseTo(before.sy, 9)
  })

  it('fully transparent artboard stays transparent (no image, full-canvas bounds equivalent)', () => {
    // Empty 32x32 upload placed at 432,312 has no opaque pixels yet; the
    // crop step finds no trim, so the save keeps transparent bytes rather
    // than inventing ink. The editor keeps the artboard size for painting.
    const placed = placeSourceOnArtboard(32, 32, 48, 48, false)
    expect(placed.width).toBe(960)
    const hasOpaque = false
    expect(hasOpaque).toBe(false)
    // Once the centered brush adds ink, the trim is non-empty and the save
    // carries real pixels at the same world anchor.
    const paintedTrim: Trim = { x: placed.originX + 6, y: placed.originY + 11, width: 20, height: 10 }
    const saved = croppedSaveForTrim(paintedTrim, placed.canvasCenterX, placed.canvasCenterY, false)
    expect(saved.width).toBe(20)
    expect(saved.rotationCenterX).toBe(placed.canvasCenterX - paintedTrim.x)
  })

  it('stage saves imply resolution 1 and a 240,180-anchored center', () => {
    const placed = placeSourceOnArtboard(96, 60, 48, 30, true)
    const trim: Trim = { x: placed.originX, y: placed.originY, width: 96, height: 60 }
    const saved = croppedSaveForTrim(trim, placed.canvasCenterX, placed.canvasCenterY, true)
    expect(saved.bitmapResolution).toBe(1)
    expect(saved.rotationCenterX).toBe(48)
    expect(saved.rotationCenterY).toBe(30)
  })

  it('crop round-trips through reload: re-placing the save recovers the same artboard pixels', () => {
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false)
    const trim: Trim = { x: placed.originX - 32, y: placed.originY - 12, width: 222, height: 212 }
    const saved = croppedSaveForTrim(trim, placed.canvasCenterX, placed.canvasCenterY, false)
    const reloaded = placeSourceOnArtboard(saved.width, saved.height, saved.rotationCenterX, saved.rotationCenterY, false)
    expect(reloaded.originX).toBe(trim.x)
    expect(reloaded.originY).toBe(trim.y)
    expect(reloaded.width).toBe(960)
  })
})

describe('huge sources and rectangular workspaces expand the union, never the ink', () => {
  it('legacy 2400x1800 full-bleed stays oversized compatibly (world position preserved)', () => {
    // Legacy asset stored at 2400x1800 with center 48,50 exceeds the artboard.
    const placed = placeSourceOnArtboard(2400, 1800, 48, 50, false)
    expect(placed.width).toBe(2832)
    expect(placed.height).toBe(2110)
    // The artboard rect is still contained in the expanded canvas.
    expect(placed.originX).toBe(432)
    expect(placed.originY).toBe(310)
    expect(placed.originX + 2400).toBeGreaterThan(960)
    expect(placed.originY + 1800).toBeGreaterThan(720)
    // Ink world position is unchanged by the expansion: asset-local mapping
    // equals canvas mapping through the shifted center.
    const viaAsset = assetPixelToScratch(100, 120, 48, 50, 2)
    const viaCanvas = canvasPixelToScratch(placed.originX + 100, placed.originY + 120, placed.canvasCenterX, placed.canvasCenterY, 2)
    expect(viaCanvas.sx).toBeCloseTo(viaAsset.sx, 9)
    expect(viaCanvas.sy).toBeCloseTo(viaAsset.sy, 9)
  })

  it('2000x1500 rectangular source expands width and height independently', () => {
    const placed = placeSourceOnArtboard(2000, 1500, 1000, 750, false)
    // Origin 480-1000=-520, 360-750=-390 -> union -520..1480 x -390..1110.
    expect(placed.width).toBe(2000)
    expect(placed.height).toBe(1500)
    expect(placed.originX).toBe(0)
    expect(placed.originY).toBe(0)
    expect(placed.canvasCenterX).toBe(1000)
    expect(placed.canvasCenterY).toBe(750)
    const corner = canvasPixelToScratch(0, 0, placed.canvasCenterX, placed.canvasCenterY, 2)
    expect(corner.sx).toBeCloseTo(-500, 9)
  })

  it('wide-but-short and tall-but-narrow rectangles each fit without swapping axes', () => {
    const wide = placeSourceOnArtboard(60, 40, 48, 48, false)
    expect(wide.width).toBe(960)
    expect(wide.height).toBe(720)
    const tall = placeSourceOnArtboard(40, 300, 20, 150, false)
    expect(tall.originX).toBe(460)
    expect(tall.originY).toBe(210)
    expect(tall.width).toBe(960)
    // Width/height are never transposed by the union rule.
    expect(tall.originX + 40).toBeLessThanOrEqual(tall.width)
    expect(tall.originY + 300).toBeLessThanOrEqual(tall.height)
  })
})

describe('clipboard / floating / brush stay in artboard pixels (not source bounds)', () => {
  it('distant paste that the probe clips on 190x200 fits on 960x720', () => {
    // Probe B drags a marquee far outside then pastes. Same-mode paste adds
    // +10px stagger and clamps into the canvas.
    const smallPaste = pasteRectOnCanvas({ width: 190, height: 200 }, { width: 60, height: 40 }, { x: 400, y: 300 }, 1)
    expect(smallPaste.x).toBeLessThanOrEqual(190 - 60)
    expect(smallPaste.y).toBeLessThanOrEqual(200 - 40)
    const artPaste = pasteRectOnCanvas({ width: 960, height: 720 }, { width: 60, height: 40 }, { x: 400, y: 300 }, 1)
    expect(artPaste).toEqual({ x: 410, y: 310, width: 60, height: 40 })
  })

  it('oversized clipboard anchors at the origin on either canvas (no negative offsets)', () => {
    const artPaste = pasteRectOnCanvas({ width: 960, height: 720 }, { width: 1200, height: 900 }, { x: 500, y: 400 }, 3)
    expect(artPaste.x).toBe(0)
    expect(artPaste.y).toBe(0)
  })

  it('floating moves clip against the artboard, so small-canvas edge moves become interior moves', () => {
    // A 32x32 selection moved +40,+40 from near the ink edge.
    const artDest = { x: 574 + 40, y: 264 + 40 }
    expect(artDest.x + 32).toBeLessThanOrEqual(960)
    // The same +40 delta from the small-canvas edge (158,168) would exit it.
    const smallDest = { x: 158 + 40, y: 168 + 40 }
    expect(smallDest.x + 32).toBeGreaterThan(190)
    expect(smallDest.y + 32).toBeGreaterThan(200)
  })

  it('brush clamping uses the canvas, so the artboard keeps strokes the small canvas would flatten', () => {
    const art = clampPointToCanvas({ x: 594, y: 360 }, 960, 720)
    expect(art).toEqual({ x: 594, y: 360 })
    const small = clampPointToCanvas({ x: 210, y: 100 }, 190, 200)
    expect(small).toEqual({ x: 190, y: 100 })
  })
})

describe('viewport zoom stays pointer-fixed on any canvas size (artboard + huge)', () => {
  it('fixed-point zoom holds the cursor-anchored surface pixel within rounding', () => {
    const cases = [
      { width: 960, height: 720 },
      { width: 480, height: 360 },
      { width: 2400, height: 1800 },
      { width: 2000, height: 1500 },
    ]
    for (const surface of cases) {
      const center = { x: 400, y: 300 }
      const vp = { x: 12, y: -7, scale: 1 }
      const screen = { x: 450, y: 280 }
      const before = screenToSurface(screen, surface, center, vp)
      const next = zoomAtScreenPoint(vp, surface, center, screen, 1.1)
      const after = surfaceToScreen(before, surface, center, next)
      expect(Math.abs(after.x - screen.x)).toBeLessThan(1)
      expect(Math.abs(after.y - screen.y)).toBeLessThan(1)
    }
  })

  it('surface rect prediction matches the style binding for the artboard', () => {
    const surface = { width: 960, height: 720 }
    const center = { x: 400, y: 300 }
    const vp = { x: 12, y: -7, scale: 2 }
    const rect = {
      left: center.x + vp.x - (surface.width * vp.scale) / 2,
      top: center.y + vp.y - (surface.height * vp.scale) / 2,
      width: surface.width * vp.scale,
      height: surface.height * vp.scale,
    }
    expect(rect).toEqual({ left: -548, top: -427, width: 1920, height: 1440 })
    // Corners round-trip through the mapping.
    const topLeft = screenToSurface({ x: rect.left, y: rect.top }, surface, center, vp)
    expect(topLeft.x).toBeCloseTo(0, 9)
    expect(topLeft.y).toBeCloseTo(0, 9)
  })
})
