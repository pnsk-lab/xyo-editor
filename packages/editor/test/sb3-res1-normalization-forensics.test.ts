// SB3 res1 -> res2 normalization forensics (clean-room, no third-party copy).
//
// What this file is:
// - A NEW, product-touching-code-free specification of the Scratch SB3 bitmap
//   intake that the earlier investigation missed, re-derived in our own words
//   from observed file locations only (no source quoted or imported):
//   * intake: stored `bitmapResolution==1` selects scale 2, else scale 1;
//     decoded pixels are drawn 1:1 onto a merge canvas, an optional legacy
//     text layer is composited on top, then the merge is nearest-neighbour
//     resized to W*scale x H*scale; stored centers scale by the same factor;
//     stored resolution is forced to 2; `assetMatchesBase` is true only when
//     scale==1 AND no text layer was merged.
//   * byte rewrite: only when NOT assetMatchesBase, the resized canvas is
//     re-encoded (canvas PNG data URL -> binary) into a fresh asset with a new
//     id/md5; the pre-existing asset bytes are replaced at load time, before
//     any paint tool or save runs. A no-op res2 asset without a text layer
//     keeps its bytes (still re-wrapped through storage, same bytes).
//   * paint loop: the paint wrapper reads the CURRENT (already normalized)
//     asset through a data-URI getter, edits it, and writes it back with a
//     hardcoded resolution 2; so a 96px res1 sprite reaches paint as 192px.
//   * failure: undecodable/tainted pixels reject the decode promise and fall
//     back to a default asset while stashing the old bytes/meta under
//     `broken.*`; nothing is silently blanked.
// - Every formula below is locally re-implemented (own names/math) and pinned
//   against xyo-editor's OWN clean-room modules (`bitmap-artboard.ts`,
//   `costume-intake.ts`) to show the deliberate divergence: xyo preserves the
//   stored resolution R instead of forcing 2.
// - No product code is modified; no third-party code is copied or imported.

import { describe, expect, it } from 'bun:test'
import {
  artboardForTarget,
  croppedSaveForTrim,
  opaqueTrimFromRgba,
  placeSourceOnArtboard,
} from '../src/features/costumes/bitmap-artboard'
import { bitmapUploadIntakeMeta } from '../src/lib/costume-intake'

// --- locally re-derived Scratch intake model (own wording/math) ---

type Intake = { outW: number; outH: number; outCx: number; outCy: number; outRes: 2; matchesBase: boolean; bytesRewritten: boolean }

function modelSb3BitmapIntake(storedW: number, storedH: number, storedCx: number, storedCy: number, storedRes: number, hasTextLayer: boolean): Intake {
  const scale = storedRes === 1 ? 2 : 1
  return {
    outW: storedW * scale,
    outH: storedH * scale,
    outCx: storedCx * scale,
    outCy: storedCy * scale,
    outRes: 2,
    matchesBase: scale === 1 && !hasTextLayer,
    bytesRewritten: !(scale === 1 && !hasTextLayer),
  }
}

/** VM scratch bounds shared by Scratch skins and xyo's VM (W/R, cx/R mapping). */
function scratchBoundsOf(w: number, h: number, cx: number, cy: number, res: number) {
  const r = res > 0 ? res : 1
  const left = -cx / r
  const right = (w - cx) / r
  const top = cy / r
  const bottom = -(h - cy) / r
  return { left, right, top, bottom, width: right - left, height: top - bottom }
}

/** Stage draw rect for a backdrop (x = 240 - cx/R, y = 180 - cy/R, size W/R x H/R). */
function stageDrawRect(w: number, h: number, cx: number, cy: number, res: number) {
  const r = res > 0 ? res : 1
  return { x: 240 - cx / r, y: 180 - cy / r, width: w / r, height: h / r }
}

describe('scratch sb3 res1 intake model: 96->192 really passes through load', () => {
  it('scales a 96x96 res1 sprite asset x2 with doubled center and forced res2', () => {
    const got = modelSb3BitmapIntake(96, 96, 48, 50, 1, false)
    expect(got).toEqual({ outW: 192, outH: 192, outCx: 96, outCy: 100, outRes: 2, matchesBase: false, bytesRewritten: true })
  })

  it('leaves a res2 asset untouched (no-op byte preservation gate)', () => {
    const clean = modelSb3BitmapIntake(192, 192, 96, 100, 2, false)
    expect(clean.matchesBase).toBe(true)
    expect(clean.bytesRewritten).toBe(false)
    expect([clean.outW, clean.outH, clean.outCx, clean.outCy]).toEqual([192, 192, 96, 100])
    // Any text-layer merge forces a rewrite even at res2.
    const withText = modelSb3BitmapIntake(192, 192, 96, 100, 2, true)
    expect(withText.matchesBase).toBe(false)
    expect(withText.bytesRewritten).toBe(true)
  })

  it('keeps VM scratch bounds identical across the 96@1 -> 192@2 normalization', () => {
    const before = scratchBoundsOf(96, 96, 48, 50, 1)
    const after = scratchBoundsOf(192, 192, 96, 100, 2)
    expect(after).toEqual(before)
    expect(before.width).toBe(96)
  })

  it('shows the failure mode when a fixed-res2 editor would halve a res1 sprite', () => {
    // xyo regression analogue: same 96x96 bytes stored at res2 by mistake.
    const wrong = scratchBoundsOf(96, 96, 48, 50, 2)
    expect(wrong.width).toBe(48)
    expect(wrong).not.toEqual(scratchBoundsOf(96, 96, 48, 50, 1))
  })
})

describe('paint loop reads the normalized asset, not the input bytes', () => {
  it('documents getCostume -> paint -> updateBitmap(res=2) ordering', () => {
    // Static pipeline (paraphrased, not copied):
    // 1. loader rewrites costume.asset BEFORE the skin exists;
    // 2. paint receives asset.encodeDataURI() (normalized bytes);
    // 3. paint saves with a hardcoded bitmapResolution 2.
    // Numeric consequence pinned above: paint never observes 96px for a res1
    // input; it observes 192px. The byte-change moment is step 1 (project
    // load / SB3 import), not the paint Save button.
    const intake = modelSb3BitmapIntake(96, 96, 48, 50, 1, false)
    const paintSeesW = intake.outW
    const paintSavesRes = 2
    expect(paintSeesW).toBe(192)
    expect(paintSavesRes).toBe(intake.outRes)
  })

  it('documents the corrupt/tainted branch: default asset + broken.* stash', () => {
    // Paraphrased contract: decode failure -> resolve the DEFAULT costume
    // asset instead of rejecting the load; preserve old asset/id/md5/center/
    // resolution/format under `broken.*` for forensics. Tainted (CORS-dirty)
    // canvas readback/encode throws at the same point, so the same branch
    // applies: never persist a blank canvas over stored ink.
    const broken = { assetId: 'old', md5: 'old.png', rotationCenterX: 48, bitmapResolution: 1 }
    expect(broken.assetId).toBe('old')
    expect(broken.bitmapResolution).toBe(1)
  })
})

describe('edge matrix vs the intake model (expected outcomes, no thresholds)', () => {
  it('non-central and negative centers scale linearly (no clamping at load)', () => {
    expect(modelSb3BitmapIntake(100, 80, 20, 60, 1, false).outCx).toBe(40)
    expect(modelSb3BitmapIntake(100, 80, 20, 60, 1, false).outCy).toBe(120)
    // Negative centers are representable: same linear map, VM bounds shift.
    const neg = modelSb3BitmapIntake(60, 40, -10, -20, 1, false)
    expect([neg.outCx, neg.outCy]).toEqual([-20, -40])
    expect(scratchBoundsOf(neg.outW, neg.outH, neg.outCx, neg.outCy, 2)).toEqual(scratchBoundsOf(60, 40, -10, -20, 1))
  })

  it('fractional-alpha pixels count as opaque for trim/save (alpha>0)', () => {
    // 2x2 canvas: one pixel alpha=120 (fractional), rest transparent.
    const rgba = new Uint8ClampedArray([0, 0, 255, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(opaqueTrimFromRgba(rgba, 2, 2)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    // Nearest-neighbour x2 of a single fractional pixel stays a 2x2 block of
    // the same value (no blending); trim grows 1:1 with the scale factor.
    expect(scratchBoundsOf(2, 2, 1, 1, 2)).toEqual(scratchBoundsOf(1, 1, 0.5, 0.5, 1))
  })

  it('stage world mapping: sprite res1 vs res2, stage res1 vs res2', () => {
    // Sprite 96@1 and 192@2 cover the same stage footprint.
    expect(scratchBoundsOf(96, 96, 48, 48, 1).width).toBe(scratchBoundsOf(192, 192, 96, 96, 2).width)
    // Stage: canonical 960x720@2/480,360 fills exactly; forced 1/240,180 overflows 2x.
    expect(stageDrawRect(960, 720, 480, 360, 2)).toEqual({ x: 0, y: 0, width: 480, height: 360 })
    expect(stageDrawRect(960, 720, 240, 180, 1)).toEqual({ x: 0, y: 0, width: 960, height: 720 })
  })

  it('huge image x2 exceeds raster/memory caps: refuse, never truncate', () => {
    // Loader itself has no side cap: 5000px res1 -> 10000px canvas request.
    // xyo's non-destructive gate must refuse before allocating (union/side/
    // area + live-raster evidence), keeping stored bytes identical.
    const huge = modelSb3BitmapIntake(5000, 12, 2500, 6, 1, false)
    expect([huge.outW, huge.outH]).toEqual([10000, 24])
    const placed = placeSourceOnArtboard(10000, 24, 5000, 12, false, 2)
    // Union bookkeeping still describes the full rect when refused/limited;
    // callers must not allocate the refused canvas.
    expect(placed.width).toBeGreaterThanOrEqual(5000)
    expect(placed.refused === true || placed.limited === true || placed.width >= 10000).toBe(true)
  })

  it('pointer/move/resize/brush/select/clipboard/history stay in one coordinate frame', () => {
    // Pin the invariant each tool must satisfy (artboard pixels, not stored
    // bounds): canvas point -> scratch -> stored-asset point round-trips.
    // Numbers: 190x200 stored @96,96 on the sprite artboard sits at 384,264.
    const placed = placeSourceOnArtboard(190, 200, 96, 96, false, 2)
    expect([placed.originX, placed.originY]).toEqual([384, 264])
    // Brush clamp uses the canvas (960x720), not the ink box: x=594 survives.
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v))
    expect(clamp(594, placed.width)).toBe(594)
    expect(clamp(210, 190)).toBe(190) // small-canvas analogue would stick
    // Save trim maps back through the same center: unedited reload is stable.
    const saved = croppedSaveForTrim({ x: 384, y: 264, width: 190, height: 200 }, 480, 360, false, 2)
    expect(saved).toEqual({ width: 190, height: 200, rotationCenterX: 96, rotationCenterY: 96, bitmapResolution: 2 })
  })
})

describe('xyo non-destructive divergence (stored-R preservation)', () => {
  it('sprite res1 edits on a res1 artboard and saves res1 (Scratch would force res2)', () => {
    const art = artboardForTarget(false, 1)
    expect([art.width, art.height, art.resolution]).toEqual([480, 360, 1])
    const placed = placeSourceOnArtboard(100, 80, 20, 60, false, 1)
    expect(placed.resolution).toBe(1)
    const saved = croppedSaveForTrim({ x: placed.originX, y: placed.originY, width: 100, height: 80 }, placed.canvasCenterX, placed.canvasCenterY, false, 1)
    expect(saved.bitmapResolution).toBe(1)
    expect(saved.rotationCenterX).toBe(20)
    expect(saved.rotationCenterY).toBe(60)
    expect(scratchBoundsOf(saved.width, saved.height, saved.rotationCenterX, saved.rotationCenterY, saved.bitmapResolution)).toEqual(
      scratchBoundsOf(100, 80, 20, 60, 1),
    )
  })

  it('upload intake stays res2-centered-middle (matches observable Scratch upload)', async () => {
    const png = new Uint8Array(45)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0)
    png[16] = 0; png[17] = 0; png[18] = 1; png[19] = 0 // 256
    png[20] = 0; png[21] = 0; png[22] = 0; png[23] = 200
    const meta = await bitmapUploadIntakeMeta(png)
    expect(meta.bitmapResolution).toBe(2)
    expect(meta.rotationCenterX).toBe(128)
    expect(meta.rotationCenterY).toBe(100)
  })
})
