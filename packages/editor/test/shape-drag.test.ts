import { describe, expect, it } from 'bun:test'
import {
  bitmapPaperPerCanvasPx,
  bitmapShapePaperZoom,
  constrainShapeEnd,
  isShapeDrag,
  isTinyShapeBox,
  readShapeModifiers,
  resolveShapePaperZoom,
  resolveShapeRect,
  shouldCommitBitmapShapeDrag,
  shouldCommitShapeDrag,
  vectorShapePaperZoom,
} from '../src/features/costumes/shape-drag'

describe('shape drag threshold', () => {
  it('ignores a click and small movement', () => {
    expect(isShapeDrag({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false)
    expect(isShapeDrag({ x: 10, y: 10 }, { x: 12, y: 8 })).toBe(false)
  })

  it('accepts horizontal, vertical, and reverse drags', () => {
    expect(isShapeDrag({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(true)
    expect(isShapeDrag({ x: 10, y: 10 }, { x: 10, y: 13 })).toBe(true)
    expect(isShapeDrag({ x: 10, y: 10 }, { x: 7, y: 10 })).toBe(true)
  })
})

describe('resolveShapeRect', () => {
  it('spans start to current without modifiers', () => {
    expect(resolveShapeRect({ x: 10, y: 20 }, { x: 30, y: 50 }, {})).toEqual({
      x: 10,
      y: 20,
      width: 20,
      height: 30,
    })
  })

  it('normalizes reverse drags', () => {
    expect(resolveShapeRect({ x: 30, y: 50 }, { x: 10, y: 20 }, {})).toEqual({
      x: 10,
      y: 20,
      width: 20,
      height: 30,
    })
  })

  it('keeps an empty box for a click without modifiers', () => {
    expect(resolveShapeRect({ x: 5, y: 5 }, { x: 5, y: 5 }, {})).toEqual({ x: 5, y: 5, width: 0, height: 0 })
  })

  it('constrains to a square with Shift using the longer side', () => {
    expect(resolveShapeRect({ x: 10, y: 10 }, { x: 30, y: 20 }, { shift: true })).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    })
    expect(resolveShapeRect({ x: 10, y: 10 }, { x: 20, y: 40 }, { shift: true })).toEqual({
      x: 10,
      y: 10,
      width: 30,
      height: 30,
    })
  })

  it('keeps the drag direction when squaring into any quadrant', () => {
    expect(resolveShapeRect({ x: 30, y: 30 }, { x: 10, y: 20 }, { shift: true })).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    })
    expect(resolveShapeRect({ x: 30, y: 30 }, { x: 40, y: 10 }, { shift: true })).toEqual({
      x: 30,
      y: 10,
      width: 20,
      height: 20,
    })
  })

  it('matches getSquareDimensions for a straight vertical drag', () => {
    expect(resolveShapeRect({ x: 10, y: 10 }, { x: 10, y: 25 }, { shift: true })).toEqual({
      x: 10,
      y: 10,
      width: 15,
      height: 15,
    })
  })

  it('draws from the center with Alt without changing the drag dimensions', () => {
    expect(resolveShapeRect({ x: 10, y: 10 }, { x: 30, y: 20 }, { alt: true })).toEqual({
      x: 0,
      y: 5,
      width: 20,
      height: 10,
    })
  })

  it('mirrors reverse drags around the center with Alt', () => {
    expect(resolveShapeRect({ x: 30, y: 30 }, { x: 10, y: 20 }, { alt: true })).toEqual({
      x: 20,
      y: 25,
      width: 20,
      height: 10,
    })
  })

  it('combines Shift and Alt into a centered square', () => {
    expect(resolveShapeRect({ x: 10, y: 10 }, { x: 30, y: 20 }, { shift: true, alt: true })).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    })
  })
})

describe('constrainShapeEnd', () => {
  it('passes the point through without Shift', () => {
    expect(constrainShapeEnd({ x: 1, y: 2 }, { x: 5, y: 9 }, {})).toEqual({ x: 5, y: 9 })
  })

  it('extends the shorter axis to the longer side while keeping direction', () => {
    expect(constrainShapeEnd({ x: 10, y: 10 }, { x: 30, y: 20 }, { shift: true })).toEqual({ x: 30, y: 30 })
    expect(constrainShapeEnd({ x: 30, y: 30 }, { x: 10, y: 20 }, { shift: true })).toEqual({ x: 10, y: 10 })
  })

  it('matches getSquareDimensions when one axis has no movement', () => {
    expect(constrainShapeEnd({ x: 10, y: 10 }, { x: 10, y: 25 }, { shift: true })).toEqual({ x: 25, y: 25 })
  })
})

describe('readShapeModifiers', () => {
  it('reads shift/alt flags from an event-like object', () => {
    expect(readShapeModifiers({ shiftKey: true, altKey: false })).toEqual({ shift: true, alt: false })
    expect(readShapeModifiers({ shiftKey: false, altKey: true })).toEqual({ shift: false, alt: true })
    expect(readShapeModifiers({})).toEqual({ shift: false, alt: false })
  })
})

describe('shape commit gate (reference tiny-shape parity)', () => {
  it('discards clicks and sub-pixel jitter in document units', () => {
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 10, y: 10 }, {}, 1)).toBe(false)
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 10.4, y: 10.4 }, {}, 1)).toBe(false)
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 12, y: 12 }, {}, 1)).toBe(true)
  })

  it('discards axis-zero drags without Shift (zero area)', () => {
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 15, y: 10 }, {}, 1)).toBe(false)
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 10, y: 15 }, {}, 1)).toBe(false)
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 10, y: 15 }, {}, 0.5)).toBe(false)
  })

  it('commits normal horizontal and vertical drags', () => {
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 30, y: 20 }, {}, 1)).toBe(true)
    expect(shouldCommitShapeDrag({ x: 30, y: 50 }, { x: 10, y: 20 }, {}, 1)).toBe(true)
  })

  it('squares a straight axis drag with Shift so it commits', () => {
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 10, y: 25 }, { shift: true }, 1)).toBe(true)
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 25, y: 10 }, { shift: true }, 1)).toBe(true)
  })

  it('keeps Alt centering without changing the commit area', () => {
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 30, y: 20 }, { alt: true }, 1)).toBe(true)
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 11, y: 10 }, { alt: true }, 1)).toBe(false)
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 30, y: 20 }, { shift: true, alt: true }, 1)).toBe(true)
  })

  it('scales the budget with the Paper zoom', () => {
    // Threshold is 2 / zoom with a strict `<`: a 1x2 box (area 2) commits
    // at zoom 1 (2 < 2 is false) but discards at zoom 0.5 (2 < 4).
    // NOTE: `isTinyShapeBox` takes Paper units. Vector callers pass SVG
    // document units converted x2 per axis (see `shouldCommitShapeDrag`).
    expect(isTinyShapeBox(1, 2, 1)).toBe(false)
    expect(isTinyShapeBox(1, 2, 0.5)).toBe(true)
    // At zoom 2 the budget halves: a 0.9x1 box discards, 1x1 commits.
    expect(isTinyShapeBox(0.9, 1, 2)).toBe(true)
    expect(isTinyShapeBox(1, 1, 2)).toBe(false)
  })

  it('converts SVG document units to Paper units (Paper = svg * 2 per axis)', () => {
    // shouldCommit inputs are SVG units (0..480 domain). Paper area is 4x:
    // SVG 0.5x0.5 -> Paper 1x1 (area 1 < 2 discards at zoom 1),
    // SVG 1x1 -> Paper 2x2 (area 4 >= 2 commits at zoom 1).
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 10.5, y: 10.5 }, {}, 1)).toBe(false)
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 11, y: 11 }, {}, 1)).toBe(true)
    // Axis-zero stays zero after the x2 conversion (no false commit).
    expect(shouldCommitShapeDrag({ x: 10, y: 10 }, { x: 11, y: 10 }, {}, 1)).toBe(false)
    // Live vector scale cross-check: viewportScale 0.608381 * 2.5 = 1.52095
    // Paper zoom; SVG 1x1 (Paper 4) commits, SVG 0.4x0.4 (Paper 0.64) discards.
    expect(shouldCommitShapeDrag({ x: 0, y: 0 }, { x: 1, y: 1 }, {}, 1.52095)).toBe(true)
    expect(shouldCommitShapeDrag({ x: 0, y: 0 }, { x: 0.4, y: 0.4 }, {}, 1.52095)).toBe(false)
  })
})

describe('bitmap shape commit gate (canvas px -> Paper area)', () => {
  it('maps canvas px to Paper units from the stored resolution', () => {
    expect(bitmapPaperPerCanvasPx(1)).toBe(2)
    expect(bitmapPaperPerCanvasPx(2)).toBe(1)
    expect(bitmapPaperPerCanvasPx(undefined)).toBe(1)
  })

  it('discards clicks and axis-zero drags without Shift (strict < budget)', () => {
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 0, y: 0 }, {}, 2, 1)).toBe(false)
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 10, y: 0 }, {}, 2, 1)).toBe(false)
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 0, y: 10 }, {}, 2, 1)).toBe(false)
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 10, y: 0 }, {}, 1, 1)).toBe(false)
  })

  it('commits the strict 2x2 / res1 1x1 boundary (area < threshold discards)', () => {
    // res2 s=1: zoom 1, threshold 2. 2x2 canvas = Paper 4 commits; 1x1 = 1 discards.
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 2, y: 2 }, {}, 2, 1)).toBe(true)
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 1, y: 1 }, {}, 2, 1)).toBe(false)
    // res1 s=1 reset: zoom 0.5, threshold 4. 1x1 canvas = Paper 2x2 = 4 commits (strict).
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 1, y: 1 }, {}, 1, 1)).toBe(true)
  })

  it('squares a straight axis drag with Shift and keeps Alt dimension-neutral', () => {
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 0, y: 2 }, { shift: true }, 2, 1)).toBe(true)
    expect(shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 3, y: 1 }, {}, 2, 0.5)).toBe(false)
    expect(
      shouldCommitBitmapShapeDrag({ x: 0, y: 0 }, { x: 3, y: 1 }, { alt: true }, 2, 0.5),
    ).toBe(false)
  })
})

describe('shape Paper zoom from the viewport scale', () => {
  it('maps the vector density (2.5 surface px per Paper unit)', () => {
    expect(vectorShapePaperZoom(1)).toBeCloseTo(2.5, 9)
    expect(vectorShapePaperZoom(0.2)).toBeCloseTo(0.5, 9)
  })

  it('maps bitmap densities from the stored resolution', () => {
    expect(bitmapShapePaperZoom(1, 2)).toBeCloseTo(1, 9)
    expect(bitmapShapePaperZoom(1, 1)).toBeCloseTo(0.5, 9)
    expect(resolveShapePaperZoom(0.5, 1)).toBeCloseTo(0.5, 9)
  })

  it('floors at the reference outermost zoom and rejects bad input', () => {
    expect(resolveShapePaperZoom(0.01, 2.5)).toBe(0.333)
    // A non-finite viewport scale falls back to the default scale 1.
    expect(resolveShapePaperZoom(Number.NaN, 1)).toBe(1)
  })
})
