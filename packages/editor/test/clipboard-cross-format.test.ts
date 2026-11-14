import { describe, expect, it } from 'bun:test'
import {
  bitmapRectToVectorRect,
  buildVectorImageMarkup,
  buildVectorPasteRasterDocument,
  createBitmapClipboardSourceSnapshot,
  CROSS_FORMAT_PASTE_STEP,
  isFullyTransparentImage,
  resolveBitmapToVectorSourceResolution,
  unionVectorBounds,
  vectorBoundsToBitmapAnchor,
  vectorToBitmapScaleForTarget,
  VECTOR_TO_BITMAP_SCALE,
} from '../src/features/costumes/clipboard-cross-format'
import { nextPasteOffset, pasteOffsetDelta, resolveBitmapPasteRect } from '../src/features/costumes/selection-shortcuts'

function opaqueImage(width: number, height: number, opaque: Array<[number, number, number?]>) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y, alpha = 255] of opaque) {
    data[(y * width + x) * 4 + 3] = alpha
  }
  return { data, width, height }
}

describe('clipboard-cross-format coordinate mapping', () => {
  it('shares the 10px stagger step with copy-paste-hoc', () => {
    expect(CROSS_FORMAT_PASTE_STEP).toBe(10)
    expect(pasteOffsetDelta(1)).toEqual({ dx: 10, dy: 10 })
    expect(nextPasteOffset(1)).toBe(2)
  })

  it('maps bitmap canvas px to SVG units through bitmapResolution with destination stagger', () => {
    // Sprite resolution 2: 100x60 at (20,30) + offset 1 -> (20,25) 50x30 SVG.
    expect(bitmapRectToVectorRect({ x: 20, y: 30, width: 100, height: 60 }, 2, 1)).toEqual({
      x: 20,
      y: 25,
      width: 50,
      height: 30,
    })
    // Stage resolution 1 keeps pixels 1:1 before stagger.
    expect(bitmapRectToVectorRect({ x: 0, y: 0, width: 40, height: 40 }, 1, 2)).toEqual({
      x: 20,
      y: 20,
      width: 40,
      height: 40,
    })
  })

  it('keeps distinct copy positions distinct after mapping', () => {
    const a = bitmapRectToVectorRect({ x: 10, y: 10, width: 20, height: 20 }, 2, 1)!
    const b = bitmapRectToVectorRect({ x: 100, y: 80, width: 20, height: 20 }, 2, 1)!
    expect(a.x).not.toBe(b.x)
    expect(a.y).not.toBe(b.y)
    expect(a.width).toBe(b.width)
  })

  it('rejects empty/non-finite rects fail-closed', () => {
    expect(bitmapRectToVectorRect({ x: 0, y: 0, width: 0, height: 10 }, 2, 1)).toBeUndefined()
    expect(bitmapRectToVectorRect({ x: NaN, y: 0, width: 10, height: 10 }, 2, 1)).toBeUndefined()
  })

  it('maps vector SVG bounds to a bitmap anchor at 5 canvas px per unit', () => {
    expect(VECTOR_TO_BITMAP_SCALE).toBe(5)
    expect(vectorBoundsToBitmapAnchor({ x: 10, y: 12, width: 120, height: 80 })).toEqual({
      x: 50,
      y: 60,
      width: 600,
      height: 400,
    })
  })

  it('scales vector -> bitmap paste by the destination asset resolution (artboard mapping)', () => {
    // Sprite canvas px = 2 x unit, stage canvas px = 1 x unit, so pasted ink
    // keeps its VM world position and the cropped save round-trips it.
    expect(vectorToBitmapScaleForTarget(false)).toBe(2)
    expect(vectorToBitmapScaleForTarget(true)).toBe(1)
    expect(vectorBoundsToBitmapAnchor({ x: 45, y: 38, width: 60, height: 45 }, vectorToBitmapScaleForTarget(false))).toEqual({
      x: 90,
      y: 76,
      width: 120,
      height: 90,
    })
    expect(vectorBoundsToBitmapAnchor({ x: 20, y: 30, width: 100, height: 60 }, vectorToBitmapScaleForTarget(true))).toEqual({
      x: 20,
      y: 30,
      width: 100,
      height: 60,
    })
  })

  it('anchors then staggers/clamps through the shared bitmap paste path', () => {
    const anchor = vectorBoundsToBitmapAnchor({ x: 10, y: 12, width: 24, height: 16 })!
    const dest = resolveBitmapPasteRect(
      { width: 2400, height: 1800 },
      { width: anchor.width, height: anchor.height },
      anchor,
      1,
    )
    expect(dest).toEqual({ x: 60, y: 70, width: 120, height: 80 })
  })

  it('unions vector bounds preserving relative layout', () => {
    expect(
      unionVectorBounds([
        { x: 10, y: 12, width: 120, height: 80 },
        { x: 100, y: 60, width: 80, height: 50 },
      ]),
    ).toEqual({ x: 10, y: 12, width: 170, height: 98 })
    expect(unionVectorBounds([])).toBeUndefined()
    expect(unionVectorBounds([{ x: 0, y: 0, width: 0, height: 0 }])).toBeUndefined()
  })
})

describe('clipboard-cross-format transparency', () => {
  it('treats alpha 1 as opaque (holes only when every alpha is 0)', () => {
    expect(isFullyTransparentImage(opaqueImage(4, 4, [[1, 1, 1]]))).toBe(false)
    expect(isFullyTransparentImage(opaqueImage(4, 4, []))).toBe(true)
    expect(isFullyTransparentImage(opaqueImage(4, 4, [[0, 0, 128]]))).toBe(false)
  })

  it('rejects malformed buffers fail-closed', () => {
    expect(isFullyTransparentImage(undefined)).toBe(true)
    expect(isFullyTransparentImage({ width: 2, height: 2, data: new Uint8ClampedArray(3) })).toBe(true)
  })
})

describe('clipboard-cross-format markup trust boundary', () => {
  it('embeds only allowlisted raster data URLs with geometry', () => {
    const href = 'data:image/png;base64,iVBORw0KGgo='
    const markup = buildVectorImageMarkup(href, { x: 15, y: 25, width: 50, height: 30 })
    expect(markup).toContain('data:image/png;base64,')
    expect(markup).toContain('x="15"')
    expect(markup).toContain('width="50"')
    expect(markup).toContain('xlink:href')
    // Self-contained xlink namespace: the fragment sanitizer wraps bare
    // elements in a plain `<svg>` root, so an undeclared prefix would be a
    // fail-closed parse error (real-Editor bitmap -> vector regression pins
    // the end-to-end parse; bun has no DOMParser for a unit-level check).
    expect(markup).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"')
  })

  it('refuses external URLs fail-closed', () => {
    expect(buildVectorImageMarkup('https://example.com/x.png', { x: 0, y: 0, width: 10, height: 10 })).toBe('')
    expect(buildVectorImageMarkup('data:text/html;base64,PGI+', { x: 0, y: 0, width: 10, height: 10 })).toBe('')
    expect(buildVectorImageMarkup('data:image/svg+xml;base64,PHN2Zz4=', { x: 0, y: 0, width: 10, height: 10 })).toBe('')
    expect(buildVectorImageMarkup('', { x: 0, y: 0, width: 10, height: 10 })).toBe('')
  })

  it('builds a tight raster document keeping relative layout', () => {
    const doc = buildVectorPasteRasterDocument(
      ['<rect x="10" y="12" width="120" height="80"/>', '<rect x="100" y="60" width="80" height="50"/>'],
      { x: 10, y: 12, width: 170, height: 98 },
      '<linearGradient id="g"></linearGradient>',
    )
    expect(doc).toContain('viewBox="10 12 170 98"')
    expect(doc).toContain('<linearGradient id="g"')
    expect(doc).toContain('x="100"')
  })

  it('refuses empty raster documents', () => {
    expect(buildVectorPasteRasterDocument([], { x: 0, y: 0, width: 10, height: 10 })).toBe('')
    expect(buildVectorPasteRasterDocument(['<rect/>'], { x: 0, y: 0, width: 0, height: 0 })).toBe('')
  })
})

describe('clipboard-cross-format Editor wiring pins', () => {
  it('Editor keeps position, resolution, sanitizer, stagger, and single-history cross paths', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    // Position-preserving bitmap origin for the bitmap -> vector path.
    expect(source).toContain('bitmapClipboardRect')
    expect(source).toContain('bitmapRectToVectorRect')
    // Destination resolution mapping (sprite 2 / stage 1).
    expect(source).toContain('selectedTarget.isStage ? 1 : 2')
    // Vector -> bitmap raster scale (destination asset resolution).
    expect(source).toContain('vectorToBitmapScaleForTarget')
    expect(source).toContain('resolveBitmapPasteRect')
    // Sanitizer-gated entries on both cross paths, fail-closed.
    expect(source).toContain('sanitizeSvgForPaperImport')
    expect(source).toContain('sanitizeSvgForDisplay')
    expect(source).toContain('SVG_PLACEHOLDER')
    expect(source).toContain('pasteBitmapClipboardAsVector')
    expect(source).toContain('pasteVectorClipboardAsBitmap')
    // Transparent no-op guards never touch history.
    expect(source).toContain('isFullyTransparentImage')
    // Shared stagger bumped exactly once per paste path.
    expect(source).toContain('pasteOffset = nextPasteOffset(pasteOffset)')
    // Single-clipboard dispatch: the most recent copy wins across modes, the
    // other clipboard converts across as fallback.
    expect(source).toContain("clipboardRecency: 'bitmap' | 'vector' | undefined")
    expect(source).toContain("clipboardRecency = 'vector'")
    expect(source).toContain("clipboardRecency = 'bitmap'")
    const start = source.indexOf('async function pasteCostumeSelection()')
    expect(start).toBeGreaterThan(-1)
    // Function-boundary slice (not a fixed char count): the dispatch-level
    // pending-commit guard ahead of the vector dispatch grew this function
    // past the old 1400-char window, which truncated before
    // `costumeEditMode === 'vector'`. Slice to the next sibling function so
    // leading-guard growth never truncates the dispatch pins again.
    const siblingCandidates = [
      source.indexOf('\n  async function ', start + 1),
      source.indexOf('\n  function ', start + 1),
    ].filter((i) => i > start)
    const end = siblingCandidates.length > 0 ? Math.min(...siblingCandidates) : source.length
    expect(end).toBeGreaterThan(start)
    const fn = source.slice(start, end)
    // Gate: the full dispatch body is in view (leading guard through the
    // trailing cross-format fallback), so truncation fails here, not on a
    // downstream pin.
    expect(fn).toContain('guardBitmapPendingCommitFirst')
    expect(fn).toContain('await pasteVectorClipboardAsBitmap()')
    expect(fn).toContain("costumeEditMode === 'vector'")
    expect(fn).toContain("clipboardRecency === 'bitmap'")
    expect(fn).toContain("clipboardRecency === 'vector'")
    expect(fn).toContain('pasteVectorSelection')
    expect(fn).toContain('pasteBitmapClipboardAsVector')
    expect(fn).toContain('pasteBitmapSelection')
    expect(fn).toContain('pasteVectorClipboardAsBitmap')
    // Vector copies snapshot their defs companions for the standalone raster.
    expect(source).toContain('vectorClipboardDefs')
    expect(source).toContain('url(#')
    // Reshape -> select parity before vector paste.
    expect(source).toContain('clearReshapeSelection()')
    // Single history entry per cross paste via peek -> successful CAS -> commit
    // (never immediate capture): bitmap->vector peeks once and commits once on
    // the applied path, so transparent / sanitizer-refused / conflict no-ops
    // never pollute history; normal Undo/Redo and conversion are preserved.
    const crossStart = source.indexOf('async function pasteBitmapClipboardAsVector()')
    const crossFn = source.slice(crossStart, source.indexOf('async function pasteVectorClipboardAsBitmap()', crossStart))
    expect(crossFn).not.toContain('captureCostumeHistory')
    expect(crossFn.match(/await peekCostumeHistory/g)?.length).toBe(1)
    expect(crossFn).toContain('await updateVectorCostumeFromEditor')
    expect(crossFn.match(/commitPaintHistory/g)?.length).toBe(1)
    expect(crossFn).toContain('if (bitmapPastePendingHistory) commitPaintHistory(bitmapPastePendingHistory)')
    expect(crossFn.indexOf('commitPaintHistory')).toBeGreaterThan(crossFn.indexOf('await updateVectorCostumeFromEditor'))
    expect(crossFn).toContain("if (bitmapPasteCommit.kind !== 'applied')")
    expect(crossFn.indexOf('commitPaintHistory')).toBeGreaterThan(crossFn.indexOf("if (bitmapPasteCommit.kind !== 'applied')"))
  })

  it('Editor bundles the copy-time source frame and divides through it', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    // Copy-time snapshot: source resolution + world origin / canvas-center /
    // rotation-center + stagger base bundled with the pixels.
    expect(source).toContain('bitmapClipboardSource')
    expect(source).toContain('createBitmapClipboardSourceSnapshot')
    expect(source).toContain('resolveBitmapToVectorSourceResolution')
    // Paste divides through the source snapshot, falling back to the
    // destination resolution only for old clipboard state.
    const crossStart = source.indexOf('async function pasteBitmapClipboardAsVector()')
    const crossFn = source.slice(crossStart, source.indexOf('async function pasteVectorClipboardAsBitmap()', crossStart))
    expect(crossFn).toContain('resolveBitmapToVectorSourceResolution')
    expect(crossFn).toContain('bitmapClipboardSource?.resolution')
    const copyStart = source.indexOf('async function copyBitmapSelection(')
    const copyFn = source.slice(copyStart, source.indexOf('async function pasteBitmapSelection()', copyStart))
    expect(copyFn).toContain('bitmapClipboardSource = createBitmapClipboardSourceSnapshot')
    expect(copyFn).toContain('liveBitmapArtboard()')
  })
})

describe('clipboard-cross-format source-resolution matrix', () => {
  it('prefers the copy-time source resolution over the destination', () => {
    // Sprite res2 copy pasted after vector conversion (dest res1): stays px/2.
    expect(resolveBitmapToVectorSourceResolution(2, 1)).toBe(2)
    // Stage res1 copy pasted onto a sprite-res2 destination: stays px/1.
    expect(resolveBitmapToVectorSourceResolution(1, 2)).toBe(1)
    // Old clipboard state without a snapshot falls back to destination.
    expect(resolveBitmapToVectorSourceResolution(undefined, 1)).toBe(1)
    expect(resolveBitmapToVectorSourceResolution(undefined, 2)).toBe(2)
    expect(resolveBitmapToVectorSourceResolution(0, 2)).toBe(2)
    expect(resolveBitmapToVectorSourceResolution(NaN, 2)).toBe(2)
  })

  it('keeps real size/position across target and resolution switches', () => {
    // Sprite copy (100,70,590,460 canvas px, res2) -> vector dest res1:
    // must halve through the SOURCE, then +10 stagger (not double via dest).
    const spriteCopy = { x: 100, y: 70, width: 590, height: 460 }
    const spritePlaced = bitmapRectToVectorRect(spriteCopy, resolveBitmapToVectorSourceResolution(2, 1), 1)!
    expect(spritePlaced).toEqual({ x: 60, y: 45, width: 295, height: 230 })
    // Stage copy (30,40,100,60 canvas px, res1) -> sprite dest res2:
    // must stay 1:1 through the SOURCE, then +10 stagger (not halve via dest).
    const stageCopy = { x: 30, y: 40, width: 100, height: 60 }
    const stagePlaced = bitmapRectToVectorRect(stageCopy, resolveBitmapToVectorSourceResolution(1, 2), 1)!
    expect(stagePlaced).toEqual({ x: 40, y: 50, width: 100, height: 60 })
    // Sibling relative offset survives: same-size copies at distinct origins
    // stay distinct with identical sizes after the source-resolution mapping.
    const a = bitmapRectToVectorRect({ x: 10, y: 10, width: 20, height: 20 }, resolveBitmapToVectorSourceResolution(2, 1), 1)!
    const b = bitmapRectToVectorRect({ x: 100, y: 80, width: 20, height: 20 }, resolveBitmapToVectorSourceResolution(2, 1), 1)!
    expect(a.width).toBe(b.width)
    expect(a.height).toBe(b.height)
    expect(a.x).not.toBe(b.x)
    expect(a.y).not.toBe(b.y)
    expect(Math.abs(b.x - a.x - 45)).toBeLessThan(0.001)
    expect(Math.abs(b.y - a.y - 35)).toBeLessThan(0.001)
    // Continuous paste offset steps +10 per paste in destination SVG units.
    const first = bitmapRectToVectorRect(spriteCopy, resolveBitmapToVectorSourceResolution(2, 1), 1)!
    const second = bitmapRectToVectorRect(spriteCopy, resolveBitmapToVectorSourceResolution(2, 1), 2)!
    expect(second.x - first.x).toBe(10)
    expect(second.y - first.y).toBe(10)
    expect(second.width).toBe(first.width)
  })

  it('snapshots the copy-time world frame with safe fallbacks', () => {
    const snap = createBitmapClipboardSourceSnapshot({
      resolution: 2,
      destFallbackResolution: 1,
      originX: 0,
      originY: 0,
      canvasCenterX: 480,
      canvasCenterY: 360,
      rotationCenterX: 380,
      rotationCenterY: 290,
      isStage: false,
      copyPasteOffset: 1,
    })
    expect(snap.resolution).toBe(2)
    expect(snap.canvasCenterX).toBe(480)
    expect(snap.rotationCenterX).toBe(380)
    expect(snap.copyPasteOffset).toBe(1)
    // Invalid source resolution falls back to the destination (old-asset path).
    expect(
      createBitmapClipboardSourceSnapshot({
        resolution: 0,
        destFallbackResolution: 2,
        originX: NaN,
        originY: undefined,
        canvasCenterX: undefined,
        canvasCenterY: undefined,
        rotationCenterX: undefined,
        rotationCenterY: undefined,
        isStage: true,
        copyPasteOffset: undefined,
      }).resolution,
    ).toBe(2)
  })
})
