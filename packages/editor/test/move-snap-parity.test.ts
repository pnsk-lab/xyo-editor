// Move/select parity pins (pure, no DOM / Editor).
//
// Every formula here is re-derived in our own words from OBSERVED reference
// numbers (art board 960x720, center 480,360, snap 4px, fade 10px, 45-degree
// Shift step, box closeness, action-bounds rules, 0.75 crosshair opacity).
// No third-party source is copied, quoted, or imported. Real Paper.js (the
// MIT `paper` npm package, already a dependency) is used only as a geometry
// oracle: Point arithmetic, Rectangle unite/center/expand prove that the pure
// math in `move-snap-parity.ts` matches actual Paper behavior.

import { describe, expect, it } from 'bun:test'
import {
  bitmapActionBounds,
  bitmapFadeDistanceCanvasPx,
  bitmapSnapThresholdCanvasPx,
  clampMovePaperZoom,
  clampMoveViewportScale,
  crosshairOpacityForBounds,
  fixedSvgToleranceToScreenPx,
  guideStrokePaperUnits,
  isBoxClose,
  isMoveNoop,
  marqueeDashPaperUnits,
  MOVE_ART_CENTER,
  MOVE_CROSSHAIR_FULL_OPACITY,
  MOVE_FADE_SCREEN_PX,
  MOVE_MAX_WORKSPACE,
  MOVE_SNAP_SCREEN_PX,
  MOVE_SNAP_STEP_RADIANS,
  projectDeltaToStep,
  rectCenter,
  resolveCenterSnap,
  resolveItemDisplacement,
  resolveShiftConstrainedDelta,
  selectTolerancePaperUnits,
  shouldDuplicateOnPress,
  snapThresholdPaperUnits,
  fadeDistancePaperUnits,
  uniteSelectionBounds,
  vectorActionBounds,
  vectorFadeDistanceSvgUnits,
  vectorSnapThresholdSvgUnits,
  clampPointerIntoBounds,
} from '../src/features/costumes/move-snap-parity'

describe('move snap pix coefficients (screen px / zoom)', () => {
  it('divides the 4px snap and 10px fade budgets by the live zoom', () => {
    expect(snapThresholdPaperUnits(0.5)).toBeCloseTo(8, 12)
    expect(snapThresholdPaperUnits(1)).toBeCloseTo(4, 12)
    expect(snapThresholdPaperUnits(2)).toBeCloseTo(2, 12)
    expect(snapThresholdPaperUnits(4)).toBeCloseTo(1, 12)
    expect(fadeDistancePaperUnits(0.5)).toBeCloseTo(20, 12)
    expect(fadeDistancePaperUnits(1)).toBeCloseTo(10, 12)
    expect(fadeDistancePaperUnits(4)).toBeCloseTo(2.5, 12)
    // Guide/hit budgets follow the same screen-constant rule.
    expect(guideStrokePaperUnits(2)).toBeCloseTo(0.5, 12)
    expect(selectTolerancePaperUnits(0.5)).toBeCloseTo(4, 12)
    expect(marqueeDashPaperUnits(1)).toBeCloseTo(3, 12)
    expect(MOVE_SNAP_SCREEN_PX).toBe(4)
    expect(MOVE_FADE_SCREEN_PX).toBe(10)
    expect(MOVE_SNAP_STEP_RADIANS).toBeCloseTo(Math.PI / 4, 12)
  })

  it('floors non-finite zoom to the reset/floor instead of NaN', () => {
    expect(clampMovePaperZoom(Number.NaN)).toBe(0.5)
    expect(clampMovePaperZoom(0)).toBe(0.333)
    expect(clampMovePaperZoom(-2)).toBe(0.333)
    expect(snapThresholdPaperUnits(Number.NaN)).toBeCloseTo(8, 12)
    expect(clampMoveViewportScale(Number.NaN)).toBe(1)
  })

  it('derives the same threshold from real Paper zoom arithmetic', async () => {
    const paper = (await import('paper')).default
    // Real Paper points: subtract/add round-trips prove the drag-vector basis
    // the helper assumes (movedCenter = selectionCenter + dragVector).
    const center = new paper.Point(480, 360)
    const drag = new paper.Point(3, -2)
    const moved = center.add(drag)
    expect(moved.x).toBeCloseTo(483, 12)
    expect(moved.y).toBeCloseTo(358, 12)
    expect(moved.subtract(center).x).toBeCloseTo(3, 12)
    // At zoom 1 the 4px window is 4 Paper units; at zoom 0.5 it is 8.
    expect(snapThresholdPaperUnits(1)).toBeCloseTo(4 / 1, 12)
    expect(snapThresholdPaperUnits(0.5)).toBeCloseTo(4 / 0.5, 12)
  })

  it('proves Rectangle unite/center match the pure selection-bounds math', async () => {
    const paper = (await import('paper')).default
    const a = new paper.Rectangle(10, 20, 100, 80)
    const b = new paper.Rectangle(50, 60, 100, 80)
    const united = a.unite(b)
    const pure = uniteSelectionBounds([
      { left: 10, top: 20, right: 110, bottom: 100 },
      { left: 50, top: 60, right: 150, bottom: 140 },
    ])
    expect(pure).toEqual({ left: 10, top: 20, right: 150, bottom: 140 })
    expect(united.left).toBeCloseTo(pure!.left, 10)
    expect(united.top).toBeCloseTo(pure!.top, 10)
    expect(united.right).toBeCloseTo(pure!.right, 10)
    expect(united.bottom).toBeCloseTo(pure!.bottom, 10)
    // Center is the rect midpoint on both sides.
    expect(rectCenter(pure!)).toEqual({ x: 80, y: 80 })
    expect(united.center.x).toBeCloseTo(80, 10)
    expect(united.center.y).toBeCloseTo(80, 10)
    // expand(50) adds +50 total per extent (+25 per side): the same Paper
    // proof pattern the viewport parity suite uses, re-checked here because
    // the bitmap marquee path relies on the same primitive.
    const expanded = new paper.Rectangle(10, 20, 100, 80).expand(50)
    expect(expanded.width).toBeCloseTo(150, 10)
    expect(expanded.height).toBeCloseTo(130, 10)
  })
})

describe('center snap (box closeness, Shift/reshape exclusion)', () => {
  it('snaps exactly when the moved center lands inside the box window', () => {
    const snap = resolveCenterSnap({
      selectionCenter: { x: 100, y: 100 },
      dragVector: { x: 378, y: 258 },
      thresholdPaper: 4,
    })
    // Moved center (478, 358) is within 4 on both axes of (480, 360).
    expect(snap.snapped).toBe(true)
    expect(snap.snapVector).toEqual({ x: 380, y: 260 })
  })

  it('uses a box window, not a radial distance', () => {
    // dx=3.9, dy=3.9: radial ~5.5 > 4 but box says close.
    expect(isBoxClose({ x: 483.9, y: 363.9 }, MOVE_ART_CENTER, 4)).toBe(true)
    // dx=4.1 fails even though dy=0 (strict < on each axis).
    expect(isBoxClose({ x: 484.1, y: 360 }, MOVE_ART_CENTER, 4)).toBe(false)
    expect(isBoxClose({ x: 480, y: 364.1 }, MOVE_ART_CENTER, 4)).toBe(false)
    // Boundary is exclusive: exactly 4 is not close.
    expect(isBoxClose({ x: 484, y: 360 }, MOVE_ART_CENTER, 4)).toBe(false)
  })

  it('skips snap under Shift or reshape, and wins over Shift when it applies', () => {
    const base = { selectionCenter: { x: 100, y: 100 }, dragVector: { x: 378, y: 258 }, thresholdPaper: 4 } as const
    expect(resolveCenterSnap({ ...base, shiftKey: true }).snapped).toBe(false)
    expect(resolveCenterSnap({ ...base, isReshape: true }).snapped).toBe(false)
    const snapped = resolveCenterSnap(base)
    // Snap vector replaces the Shift-projected delta entirely.
    expect(resolveItemDisplacement(base.dragVector, snapped, true)).toEqual({ x: 380, y: 260 })
    // Without snap, Shift projects; without Shift the raw delta passes.
    expect(resolveItemDisplacement({ x: 10, y: 1 }, { snapped: false, snapVector: undefined }, true).x).toBeGreaterThan(9)
    expect(resolveItemDisplacement({ x: 10, y: 1 }, { snapped: false, snapVector: undefined }, false)).toEqual({ x: 10, y: 1 })
  })

  it('treats clicks as no-ops so they stay off the undo stack', () => {
    expect(isMoveNoop({ x: 0, y: 0 })).toBe(true)
    expect(isMoveNoop({ x: 1e-10, y: -1e-10 })).toBe(true)
    expect(isMoveNoop({ x: 0.5, y: 0 })).toBe(false)
  })
})

describe('Shift 45-degree projection', () => {
  it('projects onto the nearest axis/diagonal preserving length', () => {
    // Mostly-horizontal stays horizontal with the same x extent.
    expect(projectDeltaToStep({ x: 10, y: 1 })).toEqual({ x: expect.closeTo(10, 6), y: expect.closeTo(0, 6) })
    // Diagonal input stays diagonal.
    const diag = projectDeltaToStep({ x: 10, y: 10 })
    expect(diag.x).toBeCloseTo(diag.y, 10)
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(Math.hypot(10, 10), 8)
    // Straight up snaps to vertical.
    const up = projectDeltaToStep({ x: 1, y: -10 })
    expect(up.x).toBeCloseTo(0, 8)
    // Zero / bad input maps to zero (click-safe).
    expect(projectDeltaToStep({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
    expect(projectDeltaToStep({ x: Number.NaN, y: 1 })).toEqual({ x: 0, y: 0 })
  })

  it('matches real Paper polar math on the same inputs', async () => {
    const paper = (await import('paper')).default
    const raw = { x: 7, y: 3 }
    const ours = projectDeltaToStep(raw)
    // Independent oracle with Paper points: same atan2/round/project idea,
    // written inline here (not imported from any product or reference file).
    const angle = Math.atan2(raw.y, raw.x)
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4)
    const dir = new paper.Point(Math.cos(snapped), Math.sin(snapped))
    const rawPt = new paper.Point(raw.x, raw.y)
    const length = dir.x * rawPt.x + dir.y * rawPt.y
    expect(ours.x).toBeCloseTo(dir.x * length, 10)
    expect(ours.y).toBeCloseTo(dir.y * length, 10)
    expect(resolveShiftConstrainedDelta(raw, false)).toEqual(raw)
  })
})

describe('Alt duplication gate', () => {
  it('duplicates only on press-time Alt outside text editing', () => {
    expect(shouldDuplicateOnPress(true, false)).toBe(true)
    expect(shouldDuplicateOnPress(true, true)).toBe(false)
    expect(shouldDuplicateOnPress(false, false)).toBe(false)
  })
})

describe('action bounds (bitmap vs vector)', () => {
  it('clamps bitmap pointers to exactly the art board', () => {
    expect(bitmapActionBounds()).toEqual({ left: 0, top: 0, right: 960, bottom: 720 })
    expect(clampPointerIntoBounds({ x: -50, y: 800 }, bitmapActionBounds())).toEqual({ x: 0, y: 720 })
    expect(clampPointerIntoBounds({ x: 480, y: 360 }, bitmapActionBounds())).toEqual({ x: 480, y: 360 })
  })

  it('lets vector pointers roam to the workspace via unite+intersect', () => {
    // Viewport already covering the board: bounds stay the board.
    expect(vectorActionBounds({ left: 0, top: 0, right: 960, bottom: 720 })).toEqual({
      left: 0, top: 0, right: 960, bottom: 720,
    })
    // Panned view extends the roam area but the max workspace caps it.
    const roam = vectorActionBounds({ left: -500, top: -400, right: 200, bottom: 100 })
    expect(roam).toEqual({ left: -240, top: -180, right: 960, bottom: 720 })
    expect(MOVE_MAX_WORKSPACE).toEqual({ left: -240, top: -180, right: 1200, bottom: 900 })
    // Far-outside viewports still clamp into the workspace, never NaN.
    const far = vectorActionBounds({ left: -5000, top: -5000, right: 5000, bottom: 5000 })
    expect(far).toEqual(MOVE_MAX_WORKSPACE)
  })

  it('unites selection bounds like Paper (multi-select shared center)', () => {
    expect(uniteSelectionBounds([])).toBeUndefined()
    const united = uniteSelectionBounds([
      { left: 0, top: 0, right: 100, bottom: 50 },
      { left: 80, top: 30, right: 200, bottom: 90 },
    ])
    expect(united).toEqual({ left: 0, top: 0, right: 200, bottom: 90 })
    expect(rectCenter(united!)).toEqual({ x: 100, y: 45 })
  })
})

describe('guide display (drag crosshair fade)', () => {
  it('stays full inside the moved bounds and fades outside over 10px/zoom', () => {
    const bounds = { left: 400, top: 300, right: 560, bottom: 420 }
    // Center (480, 360) sits inside: full opacity.
    expect(crosshairOpacityForBounds(bounds, { x: 480, y: 360 })).toBeCloseTo(MOVE_CROSSHAIR_FULL_OPACITY, 12)
    // Far corner: radial gap well past the 10-unit fade at zoom 1 => 0.
    const far = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(crosshairOpacityForBounds(far, { x: 50, y: 50 }, MOVE_ART_CENTER, 10)).toBeCloseTo(0, 12)
    // Halfway out above the box: the art center sits 10 units above the top
    // edge; with a 20-unit fade (zoom 0.5) that is half faded.
    const above = { left: 400, top: 370, right: 560, bottom: 490 }
    const half = crosshairOpacityForBounds(above, { x: 480, y: 430 }, MOVE_ART_CENTER, 20)
    expect(half).toBeCloseTo(MOVE_CROSSHAIR_FULL_OPACITY * 0.5, 8)
  })

  it('proves the fade window scales with zoom (same 10 screen px)', () => {
    // At zoom 4 the Paper fade window is 2.5 units: a 10-unit gap is fully out.
    expect(fadeDistancePaperUnits(4)).toBeCloseTo(2.5, 12)
    const above = { left: 400, top: 370, right: 560, bottom: 490 }
    const out = crosshairOpacityForBounds(above, { x: 480, y: 430 }, MOVE_ART_CENTER, fadeDistancePaperUnits(4))
    expect(out).toBeCloseTo(0, 12)
    // Same geometry at zoom 0.5 (fade 20 units) is half visible.
    const near = crosshairOpacityForBounds(above, { x: 480, y: 430 }, MOVE_ART_CENTER, fadeDistancePaperUnits(0.5))
    expect(near).toBeCloseTo(MOVE_CROSSHAIR_FULL_OPACITY * 0.5, 8)
  })
})

describe('current-viewport pix mapping (zoom linkage)', () => {
  it('converts the 4/10px budgets into SVG units and canvas px', () => {
    // Vector: svg = screenPx / (5 * scale). Bitmap: px = screenPx / scale.
    expect(vectorSnapThresholdSvgUnits(1)).toBeCloseTo(0.8, 12)
    expect(vectorFadeDistanceSvgUnits(1)).toBeCloseTo(2, 12)
    expect(bitmapSnapThresholdCanvasPx(1)).toBeCloseTo(4, 12)
    expect(bitmapFadeDistanceCanvasPx(1)).toBeCloseTo(10, 12)
    // 25%: budgets widen 4x in document units; 500%: they shrink 5x.
    expect(vectorSnapThresholdSvgUnits(0.25)).toBeCloseTo(3.2, 12)
    expect(vectorSnapThresholdSvgUnits(5)).toBeCloseTo(0.16, 12)
    expect(bitmapSnapThresholdCanvasPx(0.25)).toBeCloseTo(16, 12)
    expect(bitmapSnapThresholdCanvasPx(5)).toBeCloseTo(0.8, 12)
  })

  it('shows why a fixed 0.5 SVG-unit budget drifts with zoom', () => {
    // 0.5 SVG units is 2.5 screen px at 100%, 0.625 at 25%, 12.5 at 500%.
    expect(fixedSvgToleranceToScreenPx(0.5, 1)).toBeCloseTo(2.5, 12)
    expect(fixedSvgToleranceToScreenPx(0.5, 0.25)).toBeCloseTo(0.625, 12)
    expect(fixedSvgToleranceToScreenPx(0.5, 5)).toBeCloseTo(12.5, 12)
  })
})
