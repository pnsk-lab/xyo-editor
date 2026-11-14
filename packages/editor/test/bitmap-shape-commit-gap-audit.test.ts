import { describe, expect, it } from 'bun:test'
import {
  bitmapShapePaperZoom,
  resolveShapeRect,
  shouldCommitBitmapShapeDrag,
} from '../src/features/costumes/shape-drag'

// Bitmap rect/oval commit-gate verification against the production helper.
//
// Context:
// - Vector tiny rect/oval already uses the reference rule
//   `|width * height| < 2 / paperZoom` (see `shouldCommitShapeDrag` +
//   `vectorShapePaperZoom`, SVG->Paper x2 per axis).
// - The bitmap path (`Editor.svelte` endBitmapPaint/drawBitmapDraft) now gates
//   rect/oval on `shouldCommitBitmapShapeDrag` (Shift squared first via
//   `resolveShapeRect`, Paper area `|w*k * h*k|` with `k = res1 ? 2 : 1`
//   against the strict budget `2 / bitmapShapePaperZoom`). Bitmap line keeps
//   the legacy `isShapeDrag` gate and is NOT covered here.
// - This file states the reference rule in our own words (no third-party
//   source copied) and strict-checks the PRODUCTION helper against it on
//   every row, so the oracle is not weakened: the same rows that used to
//   expose the `isShapeDrag` gap must now all agree with the reference.
//
// Reference behavior re-stated (rect-tool.js / oval-tool.js, bit-tools):
// - TOLERANCE = 2 for both rect and oval.
// - mouseUp discards while `|size.width * size.height| < TOLERANCE / zoom`.
// - `size` is in Paper project coordinates; `zoom` is `paper.view.zoom`
//   (screen px per Paper unit, floor 0.333, reset 0.5).
// - Shift squares first (longer side wins, zero axis counts as positive via
//   getSquareDimensions), Alt keeps the drag dimensions and centers on the
//   press point. The squared/centered box is what the area test measures.
// - Discard: shape removed, no selection change, no history entry
//   (onUpdateImage fires but pixels are unchanged). Commit: shape selected
//   (`selected = true` + setSelectedItems), tool stays armed (bounding-box
//   move within the same tool).
//
// Product coordinate facts (read from costume-viewport / paper parity):
// - Reference artboard is 960x720 Paper units. Product bitmap canvas is the
//   artboard: res2 960x720 (1 canvas px = 1 Paper unit, k=1, density 1.0),
//   res1 480x360 (1 canvas px = 2 Paper units, k=2, density 0.5, because the
//   reference loader doubles stored res1 before paint while this repo keeps
//   stored res1 non-destructively). Unknown resolution falls back to
//   density 1 (k=1) on the live path.
// - Live Paper zoom = viewportScale * density, floored at 0.333
//   (`bitmapShapePaperZoom`). E.g. res2 reset scale 0.5 -> zoom 0.5;
//   res1 reset scale 1.0 -> zoom 0.5; vector reset 0.2 -> zoom 0.5.
// - Product drag inputs (`bitmapStart`, `bitmapPoint`) are bitmap canvas px
//   (floats via clientRect mapping, clamped into the canvas). The production
//   helper takes those floats directly with no integer quantization, so the
//   reference test in canvas px is:
//     Paper area = |w_c * k * h_c * k|, threshold = 2 / zoom,
//     discard while Paper area < threshold.
// - Tool-reset note (recorded, not asserted): after a bitmap commit the
//   product writes `bitmapSelection` and switches `bitmapTool` to 'select';
//   the reference selects the shape in place and keeps the shape tool armed.
//   Presence (selection/history pixels) follows the gate rows below.
//
// Shift/Alt/no-op/selection/history (read-only):
// - Shift: reference squares BEFORE the area test, so a straight 0xN drag
//   commits as NxN. The production helper squares via `resolveShapeRect`
//   first, so Shift 0x2 commits (Case G below).
// - Alt: reference keeps dimensions (center only), so Alt never changes the
//   commit decision vs the same drag without Alt. The helper also ignores Alt
//   in the gate (centering itself is correct via `resolveShapeRect`).
// - No-op (transparent paint): product additionally suppresses history via
//   `resolveBitmapShapePaint(...).noop`; reference skips the raster draw
//   when the canvas color is null. Both stay history-free, so no-op is not
//   part of this gate (verified by code reading, not by this test).
// - Selection/history presence follows the gate: commit selects + saves one
//   Undo entry, discard keeps pixels/history/selection. Every row below is
//   therefore also a selection + history row.
// - Integer quantization (node check): the gate compares float deltas on
//   both sides, so floor/ceil in `bitmapRect` (selection box, min 1x1) does
//   not move the gate. Quantization only affects the painted pixels AFTER
//   a commit decision, hence it cannot rescue the rows.

type Modifiers = { shift?: boolean; alt?: boolean }

function referenceBitmapCommits(
  dxCanvas: number,
  dyCanvas: number,
  storedResolution: number | undefined,
  viewportScale: number,
  modifiers: Modifiers = {},
): { commits: boolean; paperArea: number; zoom: number; threshold: number } {
  const k = storedResolution === 1 ? 2 : 1
  const rect = resolveShapeRect({ x: 0, y: 0 }, { x: dxCanvas, y: dyCanvas }, modifiers)
  const paperArea = Math.abs(rect.width * k * (rect.height * k))
  const zoom = bitmapShapePaperZoom(viewportScale, storedResolution)
  const threshold = 2 / zoom
  return { commits: !(paperArea < threshold), paperArea, zoom, threshold }
}

function productBitmapCommits(
  dxCanvas: number,
  dyCanvas: number,
  storedResolution: number | undefined,
  viewportScale: number,
  modifiers: Modifiers = {},
): boolean {
  return shouldCommitBitmapShapeDrag(
    { x: 0, y: 0 },
    { x: dxCanvas, y: dyCanvas },
    modifiers,
    storedResolution,
    viewportScale,
  )
}

const ROWS: Array<{
  name: string
  dx: number
  dy: number
  res: number | undefined
  scale: number
  modifiers: Modifiers
}> = [
  // Over-commit direction under the old gate; the production helper must
  // discard all of these like the reference (zero area / under budget).
  { name: 'thin horizontal 10x0 res2 s=1 (width-zero area)', dx: 10, dy: 0, res: 2, scale: 1, modifiers: {} },
  { name: 'thin vertical 0x10 res2 s=1 (height-zero area)', dx: 0, dy: 10, res: 2, scale: 1, modifiers: {} },
  { name: 'zoom-out 3x1 res2 s=0.5 (area 3 < thr 4)', dx: 3, dy: 1, res: 2, scale: 0.5, modifiers: {} },
  { name: 'thin horizontal 10x0 res1 s=1 (Paper 20x0 area 0)', dx: 10, dy: 0, res: 1, scale: 1, modifiers: {} },
  // Under-commit direction under the old gate; the production helper must
  // commit all of these like the reference (strict `<` boundary included).
  { name: 'boundary 2x2 res2 s=1 (area 4 >= thr 2, strict >2 misses)', dx: 2, dy: 2, res: 2, scale: 1, modifiers: {} },
  { name: 'shift squares 0x2 res2 s=1 (squared 2x2 area 4)', dx: 0, dy: 2, res: 2, scale: 1, modifiers: { shift: true } },
  { name: 'res1 1x1 s=1 reset (Paper 2x2 area 4 >= thr 4)', dx: 1, dy: 1, res: 1, scale: 1, modifiers: {} },
]

describe('bitmap rect/oval commit-gate gap audit (reference vs production helper)', () => {
  it('documents the live mapping used by the comparison', () => {
    // res2 reset: scale 0.5 * density 1.0 = zoom 0.5.
    expect(bitmapShapePaperZoom(0.5, 2)).toBeCloseTo(0.5, 9)
    // res1 reset: scale 1.0 * density 0.5 = zoom 0.5 (1 canvas px = 2 Paper).
    expect(bitmapShapePaperZoom(1, 1)).toBeCloseTo(0.5, 9)
    // res2 @ scale 1: zoom 1, so the reference canvas-area budget is 2.
    expect(bitmapShapePaperZoom(1, 2)).toBeCloseTo(1, 9)
  })

  it('STRICT: production helper equals the reference area gate on every row', () => {
    const mismatches: string[] = []
    for (const row of ROWS) {
      const ref = referenceBitmapCommits(row.dx, row.dy, row.res, row.scale, row.modifiers)
      const prod = productBitmapCommits(row.dx, row.dy, row.res, row.scale, row.modifiers)
      const status = `ref=${ref.commits} (paperArea=${ref.paperArea.toFixed(3)} thr=${ref.threshold.toFixed(3)} zoom=${ref.zoom.toFixed(4)}) prod=${prod}`
      if (ref.commits !== prod) mismatches.push(`${row.name}: ${status}`)
    }
    // Any entry below is a production/reference divergence (extra history +
    // wrong selection presence, or a lost shape). The live Editor gates both
    // preview (`drawBitmapDraft`) and commit (`endBitmapPaint`) on
    // `shouldCommitBitmapShapeDrag` for rect/oval only; bitmap line keeps the
    // legacy drag gate untouched.
    expect(mismatches).toEqual([])
  })
})
