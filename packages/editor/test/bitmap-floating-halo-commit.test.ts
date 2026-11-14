import { describe, expect, it } from 'bun:test'
import {
  cancelFloatingPreview,
  clearFloatingRectForMove,
  compositeFloatingPatch,
  extractFloatingPatch,
  rotateFloatingPatch,
  rotateFloatingPatchWithHalo,
  type BitmapFloatingHalo,
  type BitmapFloatingImage,
} from '../src/features/costumes/bitmap-floating'
import {
  beginBitmapFloatingSession,
  centeredBitmapFloatingDest,
  renderBitmapFloatingSession,
  rotateBitmapFloatingSessionArbitrary,
  rotateBitmapFloatingSessionArbitraryWithHalo,
} from '../src/features/costumes/bitmap-floating-session'

// Halo commit semantics (safe: halo neighbours outside the selection are
// masked to transparent; no wiring change here).
//
// Independent judgement: the reference select-tool keeps an expanded
// rectangle around the trimmed selection, but the expanded store is committed
// through a shape mask sized to the original selection, so pixels outside the
// selection never become stamped pixels. The safe `rotateFloatingPatchWithHalo`
// enforces the same rule numerically: halo texels outside the selection rect
// are treated as alpha=0 and only selection-interior pixels are used, so the
// result is byte-identical to patch-only rotation (`rotateFloatingPatch`).
//
// This file proves that with pure-helper numeric reproduction only:
// - transparent-padding halo == patch-only rotation byte-exact (safe);
// - opaque-neighbour halo is masked: no outside blue enters the rotated patch;
// - the full commit (punch + recenter + source-over stamp) therefore matches
//   the formal patch-only commit exactly (no duplication of outside blue);
// - Alt-duplicate, Undo/Redo, partial-offboard and hole preservation are
//   pinned against the formal (patch-only) commit image.

type RGBA = [number, number, number, number]
const RED: RGBA = [255, 0, 0, 255]
const BLUE: RGBA = [0, 0, 255, 255]
const WHITE: RGBA = [255, 255, 255, 255]
const SEMI: RGBA = [10, 20, 30, 128]
const TRANSPARENT: RGBA = [0, 0, 0, 0]

function makeImage(width: number, height: number, base: RGBA): BitmapFloatingImage {
  const data = new Uint8ClampedArray(width * height * 4)
  const image = { width, height, data }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) paint(image, x, y, base)
  }
  return image
}

function paint(image: BitmapFloatingImage, x: number, y: number, color: RGBA) {
  const index = (y * image.width + x) * 4
  image.data[index] = color[0]
  image.data[index + 1] = color[1]
  image.data[index + 2] = color[2]
  image.data[index + 3] = color[3]
}

function colorAt(image: BitmapFloatingImage, x: number, y: number): RGBA {
  const index = (y * image.width + x) * 4
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!, image.data[index + 3]!]
}

function countWhere(image: BitmapFloatingImage, pred: (c: RGBA) => boolean): number {
  let n = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (pred(colorAt(image, x, y))) n += 1
    }
  }
  return n
}

const isBlue = (c: RGBA) => c[0] === 0 && c[1] === 0 && c[2] === 255 && c[3] === 255
const isRed = (c: RGBA) => c[0] === 255 && c[1] === 0 && c[2] === 0 && c[3] === 255
const isTransparent = (c: RGBA) => c[3] === 0

// 16x16 transparent-background scene:
// - red 6x6 selection at (5,5);
// - 2x2 transparent interior hole at (7,7);
// - one semi-transparent interior pixel at (9,5);
// - blue ring directly outside the selection (one pixel thick).
function makeScene(): BitmapFloatingImage {
  const canvas = makeImage(16, 16, TRANSPARENT)
  for (let y = 5; y < 11; y += 1) {
    for (let x = 5; x < 11; x += 1) paint(canvas, x, y, RED)
  }
  for (let y = 7; y < 9; y += 1) {
    for (let x = 7; x < 9; x += 1) paint(canvas, x, y, TRANSPARENT)
  }
  paint(canvas, 9, 5, SEMI)
  // Directly-adjacent different colour: full 1px ring around the 6x6.
  for (let x = 4; x <= 11; x += 1) {
    paint(canvas, x, 4, BLUE)
    paint(canvas, x, 11, BLUE)
  }
  for (let y = 4; y <= 11; y += 1) {
    paint(canvas, 4, y, BLUE)
    paint(canvas, 11, y, BLUE)
  }
  return canvas
}

const SELECT = { x: 5, y: 5, width: 6, height: 6 }

// Crop a halo image around the selection from the live canvas (2px margin).
function cropHalo(canvas: BitmapFloatingImage, margin: number): BitmapFloatingHalo {
  const haloImage = makeImage(SELECT.width + margin * 2, SELECT.height + margin * 2, TRANSPARENT)
  for (let y = 0; y < haloImage.height; y += 1) {
    for (let x = 0; x < haloImage.width; x += 1) {
      const sx = SELECT.x - margin + x
      const sy = SELECT.y - margin + y
      if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) continue
      paint(haloImage, x, y, colorAt(canvas, sx, sy))
    }
  }
  return { image: haloImage, offsetX: margin, offsetY: margin }
}

// Transparent-padding halo: same geometry, outside-selection area forced clear.
function cropPaddingHalo(canvas: BitmapFloatingImage, margin: number): BitmapFloatingHalo {
  const halo = cropHalo(canvas, margin)
  const patch = extractFloatingPatch(canvas, SELECT)!
  for (let y = 0; y < halo.image.height; y += 1) {
    for (let x = 0; x < halo.image.width; x += 1) {
      const inside =
        x >= margin && y >= margin && x < margin + patch.patch.width && y < margin + patch.patch.height
      if (!inside) paint(halo.image, x, y, TRANSPARENT)
    }
  }
  return halo
}

// Formal commit image: punch selection, rotate patch-only, recenter, stamp.
function formalCommit(canvas: BitmapFloatingImage, degrees: number, copy: boolean) {
  const extracted = extractFloatingPatch(canvas, SELECT)!
  const rotated = rotateFloatingPatch(extracted.patch, degrees)
  if (!rotated.changed) throw new Error('expected rotation to change')
  const dest = centeredBitmapFloatingDest(extracted.rect, rotated.patch.width, rotated.patch.height)
  const base = copy
    ? { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(canvas.data) }
    : clearFloatingRectForMove(canvas, extracted.rect).image
  const stamped = compositeFloatingPatch(base, rotated.patch, dest.x, dest.y)
  return { extracted, rotated, dest, stamped }
}

describe('halo commit semantics: padding keeps the boundary, neighbours stay masked', () => {
  it('transparent-padding halo is byte-identical to patch-only rotation (safe halo)', () => {
    const canvas = makeScene()
    const patch = extractFloatingPatch(canvas, SELECT)!.patch
    const plain = rotateFloatingPatch(patch, 30)
    const padded = rotateFloatingPatchWithHalo(patch, cropPaddingHalo(canvas, 2), 30)
    expect(padded.changed).toBe(true)
    expect(padded.patch.width).toBe(plain.patch.width)
    expect(padded.patch.height).toBe(plain.patch.height)
    expect(padded.patch.data).toEqual(plain.patch.data)
  })

  it('opaque-neighbour halo is masked: no outside blue enters the rotated patch', () => {
    const canvas = makeScene()
    const patch = extractFloatingPatch(canvas, SELECT)!.patch
    const plain = rotateFloatingPatch(patch, 30)
    const haloed = rotateFloatingPatchWithHalo(patch, cropHalo(canvas, 2), 30)
    expect(haloed.changed).toBe(true)
    expect([haloed.patch.width, haloed.patch.height]).toEqual([plain.patch.width, plain.patch.height])
    const plainBlue = countWhere(plain.patch, isBlue)
    const haloBlue = countWhere(haloed.patch, isBlue)
    // Safe halo: outside-selection neighbours are alpha=0, so neither the
    // patch-only nor the halo rotation carries any ring blue.
    expect(plainBlue).toBe(0)
    expect(haloBlue).toBe(0)
    expect(haloed.patch.data).toEqual(plain.patch.data)
  })

  it('full move commit with a neighbour halo matches the formal commit (no duplication)', () => {
    const canvas = makeScene()
    const degrees = 30
    const formal = formalCommit(canvas, degrees, false)
    expect(formal.stamped.changed).toBe(true)
    const haloPatch = rotateFloatingPatchWithHalo(
      formal.extracted.patch,
      cropHalo(canvas, 2),
      degrees,
    ).patch
    const haloBase = clearFloatingRectForMove(canvas, formal.extracted.rect).image
    const haloStamped = compositeFloatingPatch(haloBase, haloPatch, formal.dest.x, formal.dest.y)
    expect(haloStamped.changed).toBe(true)

    // Safe halo: the halo stamp is byte-identical to the formal stamp.
    // The ring stays where it was except where the recentered stamp
    // legitimately covers it; no extra blue is added on top.
    const formalBlue = countWhere(formal.stamped.image, isBlue)
    const haloBlue = countWhere(haloStamped.image, isBlue)
    const beforeBlue = countWhere(canvas, isBlue)
    expect(formalBlue).toBeLessThanOrEqual(beforeBlue)
    expect(haloBlue).toBe(formalBlue)
    expect(haloStamped.image.data).toEqual(formal.stamped.image.data)
    // Background transparency outside the commit is preserved in both paths
    // (opaque blue never lands on transparent pixels via the halo).
    const corner: RGBA = colorAt(formal.stamped.image, 0, 0)
    expect(isTransparent(corner)).toBe(true)
    // No halo-only blue exists anywhere: every blue pixel in the halo commit
    // is also blue in the formal commit.
    let haloOnlyBlue = 0
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (isBlue(colorAt(haloStamped.image, x, y)) && !isBlue(colorAt(formal.stamped.image, x, y))) {
          haloOnlyBlue += 1
        }
      }
    }
    expect(haloOnlyBlue).toBe(0)
    // Inputs never mutate.
    expect(canvas.data).toEqual(makeScene().data)
  })

  it('preserves transparent holes and semi pixels; halo adds no ring blue', () => {
    const canvas = makeScene()
    const degrees = 30
    const formal = formalCommit(canvas, degrees, false)
    const haloPatch = rotateFloatingPatchWithHalo(
      formal.extracted.patch,
      cropHalo(canvas, 2),
      degrees,
    ).patch
    // Source-over commit keeps verbatim RGBA inside the rotated patch: only
    // red / semi / transparent may appear (no blue) in either path.
    const allowed = new Set(['255,0,0,255', '10,20,30,128', '0,0,0,0'])
    for (let i = 0; i < formal.rotated.patch.data.length; i += 4) {
      const key = `${formal.rotated.patch.data[i]},${formal.rotated.patch.data[i + 1]},${formal.rotated.patch.data[i + 2]},${formal.rotated.patch.data[i + 3]}`
      expect(allowed.has(key)).toBe(true)
    }
    for (let i = 0; i < haloPatch.data.length; i += 4) {
      const key = `${haloPatch.data[i]},${haloPatch.data[i + 1]},${haloPatch.data[i + 2]},${haloPatch.data[i + 3]}`
      expect(allowed.has(key)).toBe(true)
    }
    // Safe halo is byte-identical to the formal patch.
    expect(haloPatch.data).toEqual(formal.rotated.patch.data)
    // Both paths keep some transparency (interior hole + corners survive).
    expect(countWhere(formal.rotated.patch, isTransparent)).toBeGreaterThan(0)
    expect(countWhere(haloPatch, isTransparent)).toBeGreaterThan(0)
    // Formal destination carries red; the safe halo destination carries the
    // same red with no ring blue.
    expect(countWhere(formal.stamped.image, isRed)).toBeGreaterThan(0)
    expect(countWhere(haloPatch, isBlue)).toBe(0)
  })

  it('Alt-duplicate with a neighbour halo keeps the source without copying the ring', () => {
    const canvas = makeScene()
    const degrees = 30
    const formal = formalCommit(canvas, degrees, true)
    expect(formal.stamped.changed).toBe(true)
    // Copy keeps the source selection intact.
    expect(colorAt(formal.stamped.image, 5, 5)).toEqual([...RED])
    const haloPatch = rotateFloatingPatchWithHalo(
      formal.extracted.patch,
      cropHalo(canvas, 2),
      degrees,
    ).patch
    const copyBase = {
      width: canvas.width,
      height: canvas.height,
      data: new Uint8ClampedArray(canvas.data),
    }
    const haloDup = compositeFloatingPatch(copyBase, haloPatch, formal.dest.x, formal.dest.y)
    expect(haloDup.changed).toBe(true)
    // Safe halo: duplicate matches the formal duplicate exactly (no extra blue).
    expect(countWhere(haloDup.image, isBlue)).toBe(countWhere(formal.stamped.image, isBlue))
    expect(haloDup.image.data).toEqual(formal.stamped.image.data)
    // Source ring pixel itself is untouched in both modes (no duplication).
    expect(colorAt(haloDup.image, 4, 4)).toEqual([...BLUE])
  })

  it('rotate then Undo/Redo restarts from the frozen original and never mutates committed', () => {
    const canvas = makeScene()
    const session = beginBitmapFloatingSession(canvas, SELECT)!
    const committedBefore = new Uint8ClampedArray(session.committed.data)
    const original = {
      width: session.patch.width,
      height: session.patch.height,
      data: new Uint8ClampedArray(session.patch.data),
    }
    const halo = cropHalo(canvas, 2)
    const first = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, halo, 30)
    expect(first.changed).toBe(true)
    const second = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, halo, 60)
    expect(second.changed).toBe(true)
    // Redoing 30deg from the frozen original reproduces the first preview.
    const replay = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, halo, 30)
    expect(replay.patch.data).toEqual(first.patch.data)
    // Safe halo path matches the formal patch-only image: no ring blue leaks
    // in either path, and both previews are byte-identical.
    const formalReplay = rotateBitmapFloatingSessionArbitrary(
      { ...session, patch: { ...original, data: new Uint8ClampedArray(original.data) } },
      { ...original, data: new Uint8ClampedArray(original.data) },
      30,
    )
    expect(countWhere(replay.patch, isBlue)).toBe(0)
    expect(countWhere(formalReplay.patch, isBlue)).toBe(0)
    expect(replay.patch.data).toEqual(formalReplay.patch.data)
    expect(session.committed.data).toEqual(committedBefore)
    // Undo == reset to 0deg: fresh copy of the original, no history.
    const reset = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, halo, 0)
    expect(reset.changed).toBe(false)
    expect(reset.patch.data).toEqual(original.data)
    expect(reset.patch.data).not.toBe(original.data)
    // Cancelling keeps the original reference.
    expect(cancelFloatingPreview(canvas)).toBe(canvas)
  })

  it('partial offboard rotate destinations clip source-over without throwing', () => {
    const canvas = makeScene()
    const session = beginBitmapFloatingSession(canvas, SELECT)!
    // Destination partially negative: only the on-canvas part stamps.
    const clipped = renderBitmapFloatingSession(session, -2, -2)
    expect(clipped.changed).toBe(true)
    expect(clipped.placedRect).toEqual({ x: 0, y: 0, width: 4, height: 4 })
    // Fully outside Alt-duplicate stays a no-op on the committed reference.
    const outsideCopy = renderBitmapFloatingSession(session, 100, 100, { copy: true })
    expect(outsideCopy.changed).toBe(false)
    expect(outsideCopy.image).toBe(session.committed)
    // Fully outside plain move keeps the punched hole.
    const outsideMove = renderBitmapFloatingSession(session, 100, 100)
    expect(outsideMove.changed).toBe(true)
    expect(outsideMove.placedRect).toBeUndefined()
    expect(colorAt(outsideMove.image, 5, 5)).toEqual([...TRANSPARENT])
    // White-background variant keeps far corners untouched after a real move.
    const white = makeImage(16, 16, WHITE)
    for (let y = 5; y < 11; y += 1) {
      for (let x = 5; x < 11; x += 1) paint(white, x, y, RED)
    }
    const moved = compositeFloatingPatch(
      clearFloatingRectForMove(white, SELECT).image,
      extractFloatingPatch(white, SELECT)!.patch,
      8,
      8,
    )
    expect(moved.changed).toBe(true)
    expect(colorAt(moved.image, 0, 0)).toEqual([...WHITE])
    expect(colorAt(moved.image, 8, 8)).toEqual([...RED])
  })
})
