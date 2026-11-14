import { describe, expect, it } from 'bun:test'
import {
  prepareCroppedBitmapSave,
  type BitmapCroppedSaveTrack,
} from '../src/features/costumes/bitmap-cropped-save'

/**
 * Strict short-raster gate (`bitmap-cropped-save.ts`).
 *
 * Regression: the helper used to delegate short `rgba` arrays straight to
 * `opaqueTrimFromRgba`, which returns `undefined` when
 * `data.length < width*height*4`. The helper then reported `transparent`,
 * so a malformed readback (truncated bytes, empty buffer, dim mismatch)
 * would look like "user erased everything" and the caller could overwrite
 * stored ink with a 1x1 transparent asset (or drop unsaved ink) under a
 * success status. The helper must refuse these as `unreadable` instead.
 * The real editor always passes `ImageData.data` (exact length), so this
 * gate only changes malformed inputs — never the live save path.
 */

const TRACK_SPRITE: BitmapCroppedSaveTrack = {
  canvasCenterX: 480,
  canvasCenterY: 360,
  originX: 384,
  originY: 264,
  isStage: false,
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    rgba: new Uint8ClampedArray(4 * 4 * 4),
    imageWidth: 4,
    imageHeight: 4,
    isStage: false,
    storedResolution: 2,
    track: { ...TRACK_SPRITE },
    storedCenterX: 96,
    storedCenterY: 96,
    centerOffset: { x: 0, y: 0 },
    placementCenter: { x: 96, y: 96 },
    ...overrides,
  }
}

function opaqueFull(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 255
    data[i * 4 + 3] = 255
  }
  return data
}

describe('bitmap-cropped-save short-rgba gate (strict, fail closed)', () => {
  it('short by one byte refuses even with leading opaque ink (never transparent, never 1x1 save)', () => {
    const full = opaqueFull(4, 4)
    const short = full.slice(0, full.length - 1)
    expect(short.length).toBe(4 * 4 * 4 - 1)
    const prepared = prepareCroppedBitmapSave(baseInput({ rgba: short }))
    expect(prepared).toEqual({ kind: 'refused', reason: 'unreadable' })
  })

  it('single opaque pixel in a short buffer refuses (missing tail is unobservable, not empty)', () => {
    const short = new Uint8ClampedArray([255, 0, 0, 255])
    const prepared = prepareCroppedBitmapSave(baseInput({ rgba: short }))
    expect(prepared).toEqual({ kind: 'refused', reason: 'unreadable' })
  })

  it('half-length zero prefix refuses (opaque ink may hide in the missing tail)', () => {
    const shortZero = new Uint8ClampedArray((4 * 4 * 4) / 2)
    const prepared = prepareCroppedBitmapSave(baseInput({ rgba: shortZero }))
    expect(prepared).toEqual({ kind: 'refused', reason: 'unreadable' })
  })

  it('empty buffer refuses for a nonzero raster (never transparent)', () => {
    expect(prepareCroppedBitmapSave(baseInput({ rgba: new Uint8Array(0) }))).toEqual({
      kind: 'refused',
      reason: 'unreadable',
    })
    expect(prepareCroppedBitmapSave(baseInput({ rgba: new Uint8ClampedArray(0) }))).toEqual({
      kind: 'refused',
      reason: 'unreadable',
    })
  })

  it('dimension mismatch refuses (4x4 bytes claimed as 5x5, never transparent)', () => {
    const bytes = opaqueFull(4, 4)
    const prepared = prepareCroppedBitmapSave(baseInput({ rgba: bytes, imageWidth: 5, imageHeight: 5 }))
    expect(prepared).toEqual({ kind: 'refused', reason: 'unreadable' })
  })

  it('fractional dimensions with an int-sized buffer refuse fail-closed', () => {
    const bytes = opaqueFull(4, 4)
    const prepared = prepareCroppedBitmapSave(baseInput({ rgba: bytes, imageWidth: 4.5, imageHeight: 4 }))
    expect(prepared).toEqual({ kind: 'refused', reason: 'source-size' })
    const padded = prepareCroppedBitmapSave(baseInput({ rgba: new Uint8Array(80), imageWidth: 4.5, imageHeight: 4 }))
    expect(padded).toEqual({ kind: 'refused', reason: 'source-size' })
  })

  it('exact-length rasters are unaffected (opaque saves, transparent stays transparent)', () => {
    const save = prepareCroppedBitmapSave(baseInput({ rgba: opaqueFull(4, 4) }))
    expect(save.kind).toBe('save')
    if (save.kind !== 'save') throw new Error('Expected save')
    expect(save.trim).toEqual({ x: 0, y: 0, width: 4, height: 4 })

    const clear = prepareCroppedBitmapSave(baseInput({ rgba: new Uint8ClampedArray(4 * 4 * 4) }))
    expect(clear).toEqual({ kind: 'transparent' })
  })

  it('longer-than-needed buffer is tolerated (reads the leading bytes verbatim)', () => {
    const full = opaqueFull(4, 4)
    const long = new Uint8ClampedArray(full.length + 8)
    long.set(full, 0)
    const prepared = prepareCroppedBitmapSave(baseInput({ rgba: long }))
    expect(prepared.kind).toBe('save')
  })

  it('Uint8Array short buffers refuse exactly like Uint8ClampedArray', () => {
    const short = new Uint8Array([255, 0, 0, 255])
    expect(prepareCroppedBitmapSave(baseInput({ rgba: short }))).toEqual({
      kind: 'refused',
      reason: 'unreadable',
    })
    const exact = new Uint8Array(opaqueFull(2, 2))
    const ok = prepareCroppedBitmapSave(
      baseInput({ rgba: exact, imageWidth: 2, imageHeight: 2 }),
    )
    expect(ok.kind).toBe('save')
  })
})
