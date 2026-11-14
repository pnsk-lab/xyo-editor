import { describe, expect, it } from 'bun:test'
import {
  isCroppedBitmapSaveUnchanged,
  prepareCroppedBitmapSave,
  type BitmapCroppedSaveTrack,
} from '../src/features/costumes/bitmap-cropped-save'

/**
 * Pure lower-bitmap-save preparation (`bitmap-cropped-save.ts`).
 *
 * Narrow safe extraction from `Editor.svelte::buildCroppedBitmapSave` /
 * `isBitmapSaveNoop`: the same synchronous validation + crop geometry without
 * DOM, VM, history, status, timers, or async owner races. No UI change, no
 * event-timing change, no VM API mutation. Future pending-shape CAS
 * integration reuses this as the non-recursive lower preparation.
 */

const TRACK_SPRITE: BitmapCroppedSaveTrack = {
  canvasCenterX: 480,
  canvasCenterY: 360,
  originX: 384,
  originY: 264,
  isStage: false,
}

function rgbaOf(width: number, height: number, alpha: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4
      data[o] = 255
      data[o + 1] = 0
      data[o + 2] = 0
      data[o + 3] = alpha(x, y)
    }
  }
  return data
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    rgba: rgbaOf(4, 4, () => 255),
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

describe('bitmap-cropped-save preparation (pure, no side effects)', () => {
  it('fail: over-cap / non-positive / non-finite dimensions refuse before reading (source-size)', () => {
    for (const dims of [
      { imageWidth: 0, imageHeight: 4 },
      { imageWidth: -3, imageHeight: 4 },
      { imageWidth: Number.NaN, imageHeight: 4 },
      { imageWidth: 65536, imageHeight: 2 },
      { imageWidth: 5000, imageHeight: 5000 },
    ]) {
      const prepared = prepareCroppedBitmapSave(baseInput({ ...dims, rgba: rgbaOf(2, 2, () => 255) }))
      expect(prepared).toEqual({ kind: 'refused', reason: 'source-size' })
    }
  })

  it('exception: null context / unreadable raster refuses (never transparent)', () => {
    for (const rgba of [undefined, null, 'not-bytes' as unknown as Uint8Array, new Uint8Array(0)]) {
      const prepared = prepareCroppedBitmapSave(baseInput({ rgba }))
      // Every entry here models `getContext() === null` / `getImageData`
      // throw / a malformed readback: all must refuse, never a transparent
      // no-op. `new Uint8Array(0)` is a typed array but carries no pixels for
      // the claimed 4x4 raster (needs 64 bytes); mapping it to transparent
      // would let the caller blank stored ink, so it refuses as unreadable.
      expect(prepared).toEqual({ kind: 'refused', reason: 'unreadable' })
    }
    // Never throws, even on garbage input.
    expect(() => prepareCroppedBitmapSave(undefined as unknown as Parameters<typeof prepareCroppedBitmapSave>[0])).not.toThrow()
    expect(() => prepareCroppedBitmapSave(null as unknown as Parameters<typeof prepareCroppedBitmapSave>[0])).not.toThrow()
  })

  it('null: fully transparent raster is transparent (caller decides noop vs delete)', () => {
    const prepared = prepareCroppedBitmapSave(
      baseInput({ rgba: rgbaOf(4, 4, () => 0), imageWidth: 4, imageHeight: 4 }),
    )
    expect(prepared).toEqual({ kind: 'transparent' })
  })

  it('zero alpha: only alpha !== 0 counts (incl. semitransparent alpha=1)', () => {
    const single = prepareCroppedBitmapSave(
      baseInput({ rgba: rgbaOf(4, 4, (x, y) => (x === 2 && y === 1 ? 1 : 0)), imageWidth: 4, imageHeight: 4 }),
    )
    expect(single.kind).toBe('save')
    if (single.kind !== 'save') throw new Error('Expected save')
    expect(single.trim).toEqual({ x: 2, y: 1, width: 1, height: 1 })
    expect(single.width).toBe(1)
    expect(single.height).toBe(1)
  })

  it('trims to opaque bounds with the artboard-center math (world-stable)', () => {
    // 4x4 canvas, only the bottom-right 2x2 is opaque. Track center 480,360.
    const prepared = prepareCroppedBitmapSave(
      baseInput({ rgba: rgbaOf(4, 4, (x, y) => (x >= 2 && y >= 2 ? 255 : 0)), imageWidth: 4, imageHeight: 4 }),
    )
    expect(prepared.kind).toBe('save')
    if (prepared.kind !== 'save') throw new Error('Expected save')
    expect(prepared.trim).toEqual({ x: 2, y: 2, width: 2, height: 2 })
    expect(prepared.rotationCenterX).toBe(480 - 2)
    expect(prepared.rotationCenterY).toBe(360 - 2)
    expect(prepared.bitmapResolution).toBe(2)
  })

  it('res1/res2: stored resolution is preserved verbatim (never re-derived)', () => {
    const sprite = prepareCroppedBitmapSave(baseInput({ isStage: false, storedResolution: 2 }))
    expect(sprite.kind).toBe('save')
    if (sprite.kind !== 'save') throw new Error('Expected save')
    expect(sprite.bitmapResolution).toBe(2)
    const stage = prepareCroppedBitmapSave(
      baseInput({
        isStage: true,
        storedResolution: 1,
        track: { canvasCenterX: 240, canvasCenterY: 180, originX: 192, originY: 132, isStage: true },
        storedCenterX: 48,
        storedCenterY: 30,
        placementCenter: { x: 48, y: 30 },
      }),
    )
    expect(stage.kind).toBe('save')
    if (stage.kind !== 'save') throw new Error('Expected save')
    expect(stage.bitmapResolution).toBe(1)
    // Custom stored resolution (e.g. res1 sprite) survives the crop.
    const res1sprite = prepareCroppedBitmapSave(baseInput({ isStage: false, storedResolution: 1 }))
    expect(res1sprite.kind).toBe('save')
    if (res1sprite.kind !== 'save') throw new Error('Expected save')
    expect(res1sprite.bitmapResolution).toBe(1)
  })

  it('stage-mismatched track falls back to the resolution-matched artboard center', () => {
    const prepared = prepareCroppedBitmapSave(
      baseInput({
        isStage: true,
        storedResolution: 1,
        track: { ...TRACK_SPRITE },
        storedCenterX: undefined,
        storedCenterY: undefined,
        placementCenter: { x: 0, y: 0 },
        centerOffset: { x: 0, y: 0 },
      }),
    )
    expect(prepared.kind).toBe('save')
    if (prepared.kind !== 'save') throw new Error('Expected save')
    // Fallback artboard for stage res1 is 480x360 center 240,180; stored
    // center falls back to cc - 0, offset carries it verbatim.
    expect(prepared.rotationCenterX).toBe(240 + 240)
    expect(prepared.rotationCenterY).toBe(180 + 180)
  })

  it('rotation-center drag delta folds into the center without stacking', () => {
    // Stored center moved +5,+7 since the last persisted placement: the save
    // carries exactly that delta (world-shift preserved).
    const dragged = prepareCroppedBitmapSave(
      baseInput({ storedCenterX: 101, storedCenterY: 103, placementCenter: { x: 96, y: 96 } }),
    )
    expect(dragged.kind).toBe('save')
    if (dragged.kind !== 'save') throw new Error('Expected save')
    expect(dragged.centerOffsetX).toBe(5)
    expect(dragged.centerOffsetY).toBe(7)
    // Pure re-save with the persisted center measures zero delta.
    const resave = prepareCroppedBitmapSave(
      baseInput({
        storedCenterX: dragged.rotationCenterX,
        storedCenterY: dragged.rotationCenterY,
        placementCenter: { x: dragged.rotationCenterX, y: dragged.rotationCenterY },
        centerOffset: { x: dragged.centerOffsetX, y: dragged.centerOffsetY },
      }),
    )
    expect(resave.kind).toBe('save')
    if (resave.kind !== 'save') throw new Error('Expected save')
    expect(resave.rotationCenterX).toBe(dragged.rotationCenterX)
    expect(resave.rotationCenterY).toBe(dragged.rotationCenterY)
  })

  it('unchanged: same bytes+center+resolution is a noop; meta drift is not', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const pending = { bytes, rotationCenterX: 96, rotationCenterY: 96, bitmapResolution: 2 }
    expect(
      isCroppedBitmapSaveUnchanged(
        { bytes: new Uint8Array([1, 2, 3]), rotationCenterX: 96, rotationCenterY: 96, bitmapResolution: 2 },
        pending,
      ),
    ).toBe(true)
    // Legacy asset without a stored center is still a noop on equal bytes.
    expect(isCroppedBitmapSaveUnchanged({ bytes: new Uint8Array([1, 2, 3]) }, pending)).toBe(true)
    // Same pixels but a center/resolution race is a real meta change.
    expect(
      isCroppedBitmapSaveUnchanged(
        { bytes: new Uint8Array([1, 2, 3]), rotationCenterX: 97, rotationCenterY: 96, bitmapResolution: 2 },
        pending,
      ),
    ).toBe(false)
    expect(
      isCroppedBitmapSaveUnchanged(
        { bytes: new Uint8Array([1, 2, 3]), rotationCenterX: 96, rotationCenterY: 96, bitmapResolution: 1 },
        pending,
      ),
    ).toBe(false)
    // Different bytes are never a noop, even with equal meta.
    expect(
      isCroppedBitmapSaveUnchanged(
        { bytes: new Uint8Array([9, 9, 9]), rotationCenterX: 96, rotationCenterY: 96, bitmapResolution: 2 },
        pending,
      ),
    ).toBe(false)
    // Missing stored bytes fail closed to "changed" (caller re-reads).
    expect(isCroppedBitmapSaveUnchanged({}, pending)).toBe(false)
    expect(isCroppedBitmapSaveUnchanged(undefined, pending)).toBe(false)
    // Never throws.
    expect(() => isCroppedBitmapSaveUnchanged(undefined, undefined)).not.toThrow()
  })

  it('no spurious history: helper is pure (no input mutation, deterministic, no VM/history/status)', async () => {
    const rgba = rgbaOf(4, 4, () => 255)
    const before = Array.from(rgba)
    const input = baseInput({ rgba })
    const first = prepareCroppedBitmapSave(input)
    const second = prepareCroppedBitmapSave(input)
    expect(first).toEqual(second)
    expect(Array.from(rgba)).toEqual(before)
    expect(input.centerOffset).toEqual({ x: 0, y: 0 })
    expect(input.placementCenter).toEqual({ x: 96, y: 96 })
    const helperSource = await Bun.file(new URL('../src/features/costumes/bitmap-cropped-save.ts', import.meta.url)).text()
    // Strip line/block comments: the doc header may name the editor-side
    // concepts (encode/context/VM/history) the helper deliberately avoids.
    // The executable code itself must not reference them.
    const codeOnly = helperSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const banned of ['vm.', 'commitPaintHistory', 'peekCostumeHistory', 'status =', 'document.', 'toBlob', 'getContext', 'requestAnimationFrame', 'updateCostume', 'loadAsset']) {
      expect(codeOnly).not.toContain(banned)
    }
  })

  it('editor wiring keeps existing semantics byte-for-byte (static gate pin)', async () => {
    const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    // Narrow extraction is wired (no duplicated inline math).
    expect(editorSource).toContain('prepareCroppedBitmapSave')
    expect(editorSource).toContain('isCroppedBitmapSaveUnchanged')
    // Async owner race + history/status/noop paths stay with the caller.
    const buildStart = editorSource.indexOf('async function buildCroppedBitmapSave')
    expect(buildStart).toBeGreaterThan(-1)
    const build = editorSource.slice(buildStart, buildStart + 8000)
    expect(build).toContain('isBitmapWorkspaceSettledFor')
    expect(build).toContain('BITMAP_SAVE_STALE')
    expect(build).toContain('BITMAP_SAVE_REFUSED')
    expect(build).toContain('encodeCanvasToPngBlob')
    const saveStart = editorSource.indexOf('async function saveBitmapCostume')
    expect(saveStart).toBeGreaterThan(-1)
    const save = editorSource.slice(saveStart, saveStart + 14000)
    expect(save).toContain('bitmapSaveEntryValid')
    expect(save).toContain('peekCostumeHistory')
    expect(save).toContain('commitPaintHistory')
    expect(save).toContain('writeCroppedBitmapSave')
    expect(save).toContain('isBitmapSaveNoop')
    expect(save).toContain('storedBitmapHasOpaque')
  })
})
