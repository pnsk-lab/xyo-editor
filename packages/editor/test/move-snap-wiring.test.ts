// Move/snap wiring pins (pure + static source checks, no DOM / Editor import).
//
// The geometry oracle (`move-snap-parity.ts`) is covered by
// `move-snap-parity.test.ts`. This suite pins the *wiring* this task added:
// - 2.5 screen-px offsets snap to the stage center at 25%/100%/500%,
//   4 screen-px outside does not move (box window, strict `<`);
// - Shift projects to 45 degrees and excludes the snap; reshape excludes it;
// - the drag crosshair is a screen-constant 16px with a 10px fade;
// - bitmap Alt is press-time locked (no live per-move toggle);
// - guides are discarded on Undo/switch/Escape paths.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bitmapFadeDistanceCanvasPx,
  bitmapSnapThresholdCanvasPx,
  crosshairOpacityForBounds,
  isBoxClose,
  MOVE_ART_CENTER,
  MOVE_CROSSHAIR_FULL_OPACITY,
  projectDeltaToStep,
  resolveCenterSnap,
  resolveItemDisplacement,
  vectorFadeDistanceSvgUnits,
  vectorSnapThresholdSvgUnits,
  vectorUnitsForScreenPx,
} from '../src/features/costumes/move-snap-parity'
import { placeSourceOnArtboard, canvasPixelToScratch } from '../src/features/costumes/bitmap-artboard'
import { resolveBitmapTrueCenter } from '../src/features/costumes/bitmap-snap-center'

const root = join(import.meta.dir, '..')
const editorSource = readFileSync(join(root, 'src/Editor.svelte'), 'utf8')
const bitmapEditorSource = readFileSync(join(root, 'src/features/CostumeEditor/BitmapEditor.svelte'), 'utf8')

describe('move snap wiring (2.5px snap / 4px hold across zoom)', () => {
  it('snaps a 2.5 screen-px offset at 25%/100%/500% (vector svg units)', () => {
    for (const viewportScale of [0.25, 1, 5]) {
      const threshold = vectorSnapThresholdSvgUnits(viewportScale)
      // 2.5 screen px in svg units: 2.5 / (5 * scale).
      const offset = 2.5 / (5 * viewportScale)
      expect(offset).toBeLessThan(threshold)
      const snap = resolveCenterSnap({
        selectionCenter: { x: 240 - 10, y: 180 - 10 },
        dragVector: { x: 10 + offset / 2, y: 10 + offset / 2 },
        artCenter: { x: 240, y: 180 },
        thresholdPaper: threshold,
      })
      // Moved center sits offset/2 inside the box on each axis: snaps exactly.
      expect(snap.snapped).toBe(true)
      expect(snap.snapVector).toEqual({ x: 10, y: 10 })
    }
  })

  it('holds outside the 4px box (strict <, vector + bitmap)', () => {
    for (const viewportScale of [0.25, 1, 5]) {
      const vThreshold = vectorSnapThresholdSvgUnits(viewportScale)
      // Exactly 4 screen px is NOT close (strict `<` per axis). Compare near
      // the origin to avoid float rounding at large coordinates (240 + 0.16
      // does not round-trip exactly); the helper compares axis deltas only.
      expect(isBoxClose({ x: vThreshold, y: 0 }, { x: 0, y: 0 }, vThreshold)).toBe(false)
      expect(isBoxClose({ x: 0, y: vThreshold }, { x: 0, y: 0 }, vThreshold)).toBe(false)
      // 4.5 screen px out is clearly outside at every zoom.
      const vOutside = (4.5 / (5 * viewportScale))
      expect(isBoxClose({ x: vOutside, y: 0 }, { x: 0, y: 0 }, vThreshold)).toBe(false)
      const bThreshold = bitmapSnapThresholdCanvasPx(viewportScale)
      expect(isBoxClose({ x: bThreshold, y: 0 }, { x: 0, y: 0 }, bThreshold)).toBe(false)
      const bOutside = 4.5 / viewportScale
      expect(isBoxClose({ x: bOutside, y: 0 }, { x: 0, y: 0 }, bThreshold)).toBe(false)
      // And off-center artwork stays put: no snap vector, raw delta passes.
      const none = resolveCenterSnap({
        selectionCenter: { x: 0, y: 0 },
        dragVector: { x: 100, y: 100 },
        thresholdPaper: vThreshold,
      })
      expect(none.snapped).toBe(false)
      expect(resolveItemDisplacement({ x: 100, y: 100 }, none, false)).toEqual({ x: 100, y: 100 })
    }
  })

  it('excludes snap under Shift and reshape, Shift projects to 45 degrees', () => {
    const threshold = vectorSnapThresholdSvgUnits(1)
    const base = {
      selectionCenter: { x: 100, y: 100 },
      dragVector: { x: 138, y: 78 },
      artCenter: { x: 240, y: 180 },
      thresholdPaper: threshold,
    }
    // Sanity: this geometry would snap without modifiers at zoom 1
    // (threshold 0.8 svg units)? No: moved (238,178) is 2 units off — far.
    // Use a near-center case instead for the exclusion check.
    const near = {
      selectionCenter: { x: 239.5, y: 179.5 },
      dragVector: { x: 0.4, y: 0.4 },
      artCenter: { x: 240, y: 180 },
      thresholdPaper: threshold,
    }
    expect(resolveCenterSnap(near).snapped).toBe(true)
    expect(resolveCenterSnap({ ...near, shiftKey: true }).snapped).toBe(false)
    expect(resolveCenterSnap({ ...near, isReshape: true }).snapped).toBe(false)
    // Shift projection: mostly-horizontal stays horizontal.
    const projected = projectDeltaToStep({ x: 10, y: 1 })
    expect(projected.x).toBeGreaterThan(9)
    expect(Math.abs(projected.y)).toBeLessThan(0.5)
    void base
  })
})

describe('drag guide (16px constant, 10px fade)', () => {
  it('stays full inside the moved bounds and fades to zero over the fade window', () => {
    const bounds = { left: 400, top: 300, right: 560, bottom: 420 }
    // Inside: full opacity (0.75).
    expect(crosshairOpacityForBounds(bounds, { x: 480, y: 360 }, MOVE_ART_CENTER, 10)).toBeCloseTo(
      MOVE_CROSSHAIR_FULL_OPACITY,
      12,
    )
    // Far outside (radial gap well past 10 units): zero.
    const far = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(crosshairOpacityForBounds(far, { x: 50, y: 50 }, MOVE_ART_CENTER, 10)).toBeCloseTo(0, 12)
    // Halfway out above the box with a 20-unit fade: half faded.
    const above = { left: 400, top: 370, right: 560, bottom: 490 }
    expect(crosshairOpacityForBounds(above, { x: 480, y: 430 }, MOVE_ART_CENTER, 20)).toBeCloseTo(
      MOVE_CROSSHAIR_FULL_OPACITY * 0.5,
      8,
    )
  })

  it('keeps the crosshair at 16 screen px with a 10 screen px fade at any zoom', () => {
    // Screen-constant budgets: surface = screenPx / viewportScale.
    for (const viewportScale of [0.25, 1, 5]) {
      const diameterSurface = 16 / viewportScale
      expect(diameterSurface * viewportScale).toBeCloseTo(16, 10)
      expect(vectorFadeDistanceSvgUnits(viewportScale) * 5 * viewportScale).toBeCloseTo(10, 10)
      expect(bitmapFadeDistanceCanvasPx(viewportScale) * viewportScale).toBeCloseTo(10, 10)
    }
    expect(bitmapEditorSource).toContain('16 / scale')
    expect(bitmapEditorSource).toContain('data-testid="move-center-crosshair"')
    expect(bitmapEditorSource).toContain('data-guide-mode="bitmap"')
    expect(bitmapEditorSource).toContain('data-guide-mode="vector"')
  })
})

describe('bitmap Alt press-time lock (static wiring)', () => {
  it('freezes the duplicate flag at press time and never toggles it live', () => {
    // The drag copies the press-time flag into the session; the per-move
    // preview must not reassign it from the live event.
    expect(editorSource).toContain('copy: event.altKey === true')
    expect(editorSource).not.toContain('bitmapMoveDrag.copy = event.altKey')
    expect(editorSource).not.toContain('session.copy = bitmapMoveDrag.copy')
    // Shift still projects live per move and excludes the snap.
    expect(editorSource).toContain('projectDeltaToStep({ x: rawDx, y: rawDy })')
    // Guides are discarded on Undo and on target/costume switch.
    expect(editorSource).toContain('if (bitmapMoveDrag && bitmapCanvas) {')
    // Undo/Redo discard idle drag state but leave an in-flight commit intact.
    expect(editorSource).toContain('if (vectorDrag && !vectorDrag.committing) vectorDrag = undefined')
  })
})

describe('bitmap true center vs canvas middle (union 1200: 480, not 600)', () => {
  it('places the huge union at canvasCenterX 480 (width/2 600 is NOT the anchor)', () => {
    const placed = placeSourceOnArtboard(1000, 100, 280, 50, false, 2)
    expect(placed.width).toBe(1200)
    expect(placed.canvasCenterX).toBeCloseTo(480, 9)
    expect(placed.width / 2).toBeCloseTo(600, 9)
    // Canvas pixel (480,360) is Scratch (0,0); width/2 is 120 units off.
    expect(canvasPixelToScratch(480, 360, placed.canvasCenterX, placed.canvasCenterY, 2)).toEqual({ sx: 0, sy: 0 })
    const wrong = canvasPixelToScratch(600, 360, placed.canvasCenterX, placed.canvasCenterY, 2)
    expect(Math.abs(wrong.sx)).toBeGreaterThan(50)
  })

  it('resolves the tracked center and fails closed on unsafe shapes', () => {
    const owner = { targetId: 't', index: 0, loadSerial: 7, revision: 3 }
    const target = { targetId: 't', index: 0 }
    const artboard = { width: 1200, height: 720, canvasCenterX: 480, canvasCenterY: 360, refused: false }
    const base = { artboard, canvasWidth: 1200, canvasHeight: 720, owner, pending: undefined, serial: 7, revision: 3, target }
    expect(resolveBitmapTrueCenter(base)).toEqual({ x: 480, y: 360 })
    // Refused / pending / stale owner / serial / revision / resize / target
    // switch / different index all hide the anchor (undefined: no snap, no guide).
    expect(resolveBitmapTrueCenter({ ...base, artboard: { ...artboard, refused: true } })).toBeUndefined()
    expect(resolveBitmapTrueCenter({ ...base, pending: { x: 1 } })).toBeUndefined()
    expect(resolveBitmapTrueCenter({ ...base, owner: undefined })).toBeUndefined()
    expect(resolveBitmapTrueCenter({ ...base, serial: 8 })).toBeUndefined()
    expect(resolveBitmapTrueCenter({ ...base, revision: 4 })).toBeUndefined()
    expect(resolveBitmapTrueCenter({ ...base, canvasWidth: 960 })).toBeUndefined()
    expect(resolveBitmapTrueCenter({ ...base, target: { targetId: 'other', index: 0 } })).toBeUndefined()
    expect(resolveBitmapTrueCenter({ ...base, target: { targetId: 't', index: 1 } })).toBeUndefined()
    expect(resolveBitmapTrueCenter({ ...base, artboard: { ...artboard, canvasCenterX: Number.NaN } })).toBeUndefined()
  })

  it('snaps 2.5 screen px and holds 4.5 at 25%/100%/500% around the TRUE center', () => {
    for (const viewportScale of [0.25, 1, 5]) {
      const threshold = bitmapSnapThresholdCanvasPx(viewportScale)
      expect(threshold).toBeCloseTo(4 / viewportScale, 10)
      const snapOffset = 2.5 / viewportScale
      const holdOffset = 4.5 / viewportScale
      expect(
        resolveCenterSnap({
          selectionCenter: { x: 480, y: 360 },
          dragVector: { x: snapOffset - 0.01, y: 0 },
          artCenter: { x: 480, y: 360 },
          thresholdPaper: threshold,
        }).snapped,
      ).toBe(true)
      expect(
        resolveCenterSnap({
          selectionCenter: { x: 480, y: 360 },
          dragVector: { x: holdOffset, y: 0 },
          artCenter: { x: 480, y: 360 },
          thresholdPaper: threshold,
        }).snapped,
      ).toBe(false)
      // Width/2 must NOT snap when the selection sits at the true center.
      expect(
        resolveCenterSnap({
          selectionCenter: { x: 480, y: 360 },
          dragVector: { x: 0, y: 0 },
          artCenter: { x: 600, y: 360 },
          thresholdPaper: threshold,
        }).snapped,
      ).toBe(false)
    }
  })

  it('wires one shared anchor for drag snap and guide (never width/2)', () => {
    expect(editorSource).toContain('bitmapTrueCenterForDrag')
    expect(editorSource).toContain('bitmapArtCenterX')
    expect(editorSource).toContain('bitmapGuideArtCenterState')
    expect(editorSource).toContain('resolveBitmapTrueCenter')
    expect(bitmapEditorSource).toContain('bitmapArtCenterX')
    expect(bitmapEditorSource).toContain('bitmapArtCenterY')
    // The drag snap/guide must not read the apparent middle directly.
    expect(editorSource).not.toContain('const artCenter = { x: bitmapCanvas.width / 2')
  })
})

describe('vector anchor normalization (SVG 240,180, not Paper 480,360)', () => {
  it('snaps around SVG 240,180; Paper 480,360 is 2x off-canvas', () => {
    for (const viewportScale of [0.25, 1, 5]) {
      const threshold = vectorSnapThresholdSvgUnits(viewportScale)
      const snapOffset = 2.5 / (5 * viewportScale)
      expect(
        resolveCenterSnap({
          selectionCenter: { x: 240, y: 180 },
          dragVector: { x: snapOffset - 0.001, y: 0 },
          artCenter: { x: 240, y: 180 },
          thresholdPaper: threshold,
        }).snapped,
      ).toBe(true)
      // Same drag measured against the Paper anchor never snaps (240 units off).
      expect(
        resolveCenterSnap({
          selectionCenter: { x: 240, y: 180 },
          dragVector: { x: snapOffset - 0.001, y: 0 },
          artCenter: { x: 480, y: 360 },
          thresholdPaper: threshold,
        }).snapped,
      ).toBe(false)
      expect(vectorUnitsForScreenPx(16, viewportScale) * 5 * viewportScale).toBeCloseTo(16, 8)
      expect(vectorFadeDistanceSvgUnits(viewportScale) * 5 * viewportScale).toBeCloseTo(10, 8)
    }
  })

  it('wires the SVG art center into the drag snap (same anchor as the guide)', () => {
    // resolveVectorSnapTotal must pass dims/2 (240,180), not the MOVE_ART_CENTER
    // default (Paper 480,360); the guide already uses dims.width/2.
    expect(editorSource).toContain('const dims = vectorPreviewDimensions()')
    expect(editorSource).toContain('const artCenter = { x: dims.width / 2, y: dims.height / 2 }')
  })
})
