import { describe, expect, it } from 'bun:test'
import {
  nextPasteOffset,
  pasteOffsetDelta,
  resolveBitmapCopyRect,
  resolveBitmapPasteRect,
  resolveSelectAllBitmap,
  resolveVectorCopyIndices,
  SELECTION_PASTE_STEP,
} from '../src/features/costumes/selection-shortcuts'
import { trimBitmapRectToOpaque } from '../src/features/costumes/bitmap-selection'
import { addTranslate, combineSvgTransforms } from '../src/features/costumes/vector-svg'
import { hasScratchReference } from './scratch-reference'

// Optional upstream oracle: reference `*.jsx`/`*.js` reads below skip when
// the git-ignored `.tmp/scratch-editor` checkout is absent on clean clones;
// every independent product check keeps running. See
// `test/scratch-reference.ts` (no reference source is copied; nothing is
// hardcoded as a substitute).
const HAS_SCRATCH_REFERENCE = hasScratchReference()

// Static parity for scratch-paint `copy-paste-hoc.jsx` (+ `bitmap.js`
// convert/clear paths, `clipboard.js`, `undo.js`, `update-image-hoc.jsx`,
// `keyboard-shortcuts-hoc.jsx`) against the current Editor +
// `selection-shortcuts.ts` clipboard implementation.
//
// Goals of this file:
// - pin the *safe* conversion procedure (quality / dimensions / origin),
// - pin transparent-area handling and center/offset/zoom behavior,
// - pin Undo/Redo boundaries,
// - pin the remote/external-SVG trust boundary: display, rasterize-blob, and
//   vector-paste entries all sanitize fail-closed (see also the real-network
//   regression in copy-paste-sanitize-network.browser.test.ts).
//
// Product sources are not edited here: pure helpers run directly, and
// Editor/reference wiring is asserted at the source level (the same pattern
// `selection-copy-paste-swap.test.ts` uses). Line numbers move, so assertions
// match stable substrings, each quoted in the test name.

const editorUrl = new URL('../src/Editor.svelte', import.meta.url)
const shortcutsUrl = new URL('../src/features/costumes/selection-shortcuts.ts', import.meta.url)
const sanitizeUrl = new URL('../src/features/costumes/svg-sanitize.ts', import.meta.url)
const vectorSvgUrl = new URL('../src/features/costumes/vector-svg.ts', import.meta.url)
const copyPasteHocUrl = new URL(
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/hocs/copy-paste-hoc.jsx',
  import.meta.url,
)
const keyboardHocUrl = new URL(
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/hocs/keyboard-shortcuts-hoc.jsx',
  import.meta.url,
)
const clipboardReducerUrl = new URL(
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/reducers/clipboard.js',
  import.meta.url,
)
const undoReducerUrl = new URL(
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/reducers/undo.js',
  import.meta.url,
)
const bitmapHelperUrl = new URL(
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/bitmap.js',
  import.meta.url,
)
const updateImageHocUrl = new URL(
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/hocs/update-image-hoc.jsx',
  import.meta.url,
)
const viewHelperUrl = new URL(
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/view.js',
  import.meta.url,
)
const vmIndexUrl = new URL('../../vm/src/index.ts', import.meta.url)

async function read(url: URL): Promise<string> {
  return Bun.file(url).text()
}

function opaqueImage(width: number, height: number, opaque: Array<[number, number, number?]>) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y, alpha = 255] of opaque) {
    data[(y * width + x) * 4 + 3] = alpha
  }
  return { data, width, height }
}

function fakeSvgElement(attrs: Record<string, string> = {}): Element {
  const store = new Map(Object.entries(attrs))
  return {
    getAttribute: (name: string) => (store.has(name) ? store.get(name)! : null),
    setAttribute: (name: string, value: string) => {
      store.set(name, value)
    },
  } as unknown as Element
}

describe('paste offset parity (copy-paste-hoc.jsx L83-86 vs selection-shortcuts.ts)', () => {
  it('keeps the shared 10px stagger per paste', () => {
    expect(SELECTION_PASTE_STEP).toBe(10)
    expect(pasteOffsetDelta(1)).toEqual({ dx: 10, dy: 10 })
    expect(pasteOffsetDelta(2)).toEqual({ dx: 20, dy: 20 })
    expect(nextPasteOffset(1)).toBe(2)
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference staggers Paper positions by 10 * pasteOffset and bumps the offset',
    async () => {
      const source = await read(copyPasteHocUrl)
      expect(source).toContain('position.x += 10 * this.props.pasteOffset')
      expect(source).toContain('position.y += 10 * this.props.pasteOffset')
      expect(source).toContain('this.props.incrementPasteOffset()')
      const reducer = await read(clipboardReducerUrl)
      expect(reducer).toContain('pasteOffset: 1')
      expect(reducer).toContain('pasteOffset: state.pasteOffset + 1')
    },
  )

  it('current vector paste staggers via addTranslate and bumps the offset', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('addTranslate(imported, delta.dx, delta.dy)')
    expect(source).toContain('pasteOffset = nextPasteOffset(pasteOffset)')
    expect(source).toContain('vectorClipboard = sources.map((element) => element.outerHTML)')
  })

  it('current bitmap paste clamps inside the canvas and anchors oversized art at the origin', () => {
    expect(
      resolveBitmapPasteRect({ width: 100, height: 80 }, { width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }, 1),
    ).toEqual({ x: 15, y: 15, width: 10, height: 10 })
    expect(
      resolveBitmapPasteRect({ width: 100, height: 80 }, { width: 10, height: 10 }, { x: 95, y: 75, width: 10, height: 10 }, 2),
    ).toEqual({ x: 90, y: 70, width: 10, height: 10 })
    expect(
      resolveBitmapPasteRect({ width: 100, height: 80 }, { width: 200, height: 200 }, undefined, 1),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200 })
  })
})

describe('empty-selection copy fallback (copy-paste-hoc.jsx L45-53)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference falls back to trimmed raster (bitmap) or every root item (vector)',
    async () => {
      const source = await read(copyPasteHocUrl)
      expect(source).toContain('getTrimmedRaster(false /* shouldInsert */)')
      expect(source).toContain('selectedItems = getAllRootItems()')
      expect(source).toContain('exportJSON({asString: false})')
    },
  )

  it('vector copy copies every unit when nothing is selected', () => {
    expect(resolveVectorCopyIndices([], 3)).toEqual([0, 1, 2])
    expect(resolveVectorCopyIndices([-1, 99], 2)).toEqual([0, 1])
    expect(resolveVectorCopyIndices([], 0)).toEqual([])
    expect(resolveVectorCopyIndices([2, 0, 2], 3)).toEqual([0, 2])
  })

  it('bitmap copy copies the trimmed opaque raster when nothing is selected', () => {
    const image = opaqueImage(8, 8, [[2, 2], [5, 4]])
    expect(resolveBitmapCopyRect(undefined, image, { x: 0, y: 0, width: 8, height: 8 })).toEqual({
      x: 2,
      y: 2,
      width: 4,
      height: 3,
    })
  })

  it('empty canvas copies nothing so the clipboard stays untouched', () => {
    const image = opaqueImage(4, 4, [])
    expect(resolveBitmapCopyRect(undefined, image, { x: 0, y: 0, width: 4, height: 4 })).toBeUndefined()
    expect(resolveSelectAllBitmap(image, { x: 0, y: 0, width: 4, height: 4 })).toBeUndefined()
  })

  it('current cut never uses the fallback (independent product check)', async () => {
    const source = await read(editorUrl)
    // Bitmap cut with no selection returns before touching the clipboard.
    expect(source).toContain('if (cut) return')
    // Vector cut returns early on an empty selection instead of copying all.
    expect(source).toContain('never falls back to every object')
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference cut guards empty selections (keyboard-shortcuts-hoc.jsx L66-72 parity)',
    async () => {
      const keyboard = await read(keyboardHocUrl)
      expect(keyboard).toContain('const selectedItems = getSelectedRootItems();')
      expect(keyboard).toContain('if (selectedItems.length > 0) {')
    },
  )
})

describe('transparent-area handling (bitmap.js getHitBounds vs trimBitmapRectToOpaque)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference treats any alpha !== 0 as opaque (rowBlank_/columnBlank_ check +3 !== 0)',
    async () => {
      const source = await read(bitmapHelperUrl)
      expect(source).toContain('+ 3] !== 0')
    },
  )

  it('current trim matches: alpha 0 is transparent, alpha 1 still counts as opaque', () => {
    const semi = opaqueImage(4, 4, [[1, 1, 1]])
    expect(trimBitmapRectToOpaque(semi, { x: 0, y: 0, width: 4, height: 4 })).toEqual({
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    })
    const transparent: Array<[number, number, number?]> = []
    const empty = opaqueImage(4, 4, transparent)
    expect(trimBitmapRectToOpaque(empty, { x: 0, y: 0, width: 4, height: 4 })).toBeUndefined()
  })

  it('trims transparent margins and keeps the tight opaque box (repro: 8x6 with 3 edge pixels)', () => {
    const image = opaqueImage(8, 6, [[3, 2], [4, 2], [3, 3]])
    expect(trimBitmapRectToOpaque(image, { x: 0, y: 0, width: 8, height: 6 })).toEqual({
      x: 3,
      y: 2,
      width: 2,
      height: 2,
    })
  })

  it('current paste is source-over so transparent clipboard pixels preserve the artwork', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('compositeFloatingPatch')
    expect(source).toContain('Source-over paste (not verbatim putImageData)')
    // Repro: fully-transparent or fully-offscreen paste draws the outline only,
    // writes no pixels, and records no history entry.
    expect(source).toContain('if (!stamped.changed) {')
  })
})

describe('mode-specific clipboard dispatch (keyboard-shortcuts-hoc.jsx changeToASelectMode)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference forces a select mode before paste/select-all',
    async () => {
      const source = await read(keyboardHocUrl)
      expect(source).toContain('changeToASelectMode')
      expect(source).toContain('Modes.BIT_SELECT')
      expect(source).toContain('Modes.SELECT')
      expect(source).toContain('Modes.RESHAPE')
      expect(source).toContain('selectAllBitmap')
    },
  )

  it('current forces bitmap select mode before select-all/paste and after bitmap paste', async () => {
    const source = await read(editorUrl)
    expect(source).toContain("if (costumeEditMode === 'bitmap' && bitmapTool !== 'select') bitmapTool = 'select'")
    expect(source).toContain("bitmapTool = 'select'")
    expect(source).toContain('async function pasteCostumeSelection()')
    expect(source).toContain("if (costumeEditMode === 'vector')")
  })

  it('mode dispatch is explicit: vector clipboard is outerHTML strings, bitmap is ImageData', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('vectorClipboard = sources.map((element) => element.outerHTML)')
    expect(source).toContain('bitmapClipboard = context.getImageData(rect.x, rect.y, rect.width, rect.height)')
    expect(source).toContain('if (!selectedTarget || vectorClipboard.length === 0) return')
    expect(source).toContain('if (!context || !bitmapCanvas || !bitmapClipboard) return')
  })
})

describe('safe conversion procedure: vector -> bitmap (bitmap.js convertToBitmap)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference exports drawnBounds translated to the origin with crispEdges then draws at floor(topLeft)',
    async () => {
      const source = await read(bitmapHelperUrl)
      expect(source).toContain('drawnBounds')
      expect(source).toContain('translate(-bounds.x, -bounds.y)')
      expect(source).toContain("setAttribute('shape-rendering', 'crispEdges')")
      expect(source).toContain('Math.floor(bounds.topLeft.x)')
      expect(source).toContain('Formats.BITMAP')
    },
  )

  it('current captures history after a successful 1:1 raster, keeps smoothing on, and scales the rotation center', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('async function convertCurrentCostumeToBitmap()')
    expect(source).toContain('await captureCostumeHistory(selectedTarget, index)')
    expect(source).toContain('resolveVectorToBitmapSpec')
    expect(source).toContain('parseConversionSvgGeometry')
    expect(source).toContain('rasterizeSvgToBitmapSize')
    expect(source).toContain("setAttribute('shape-rendering', 'crispEdges')")
    expect(source).toContain('bitmapResolution: spec.bitmapResolution')
    expect(source).toContain('rotationCenterX: spec.rotationCenterX')
  })

  it('quality/dimension note: current draws 1:1 at SVG units x resolution (repro: 96x96 sprite -> 192x192, not 2400x1800)', async () => {
    const source = await read(editorUrl)
    // Reference draws the exported SVG at its Paper topLeft; the fixed
    // conversion sizes the bitmap to SVG units x resolution (sprite 2x) with
    // the center scaled by the same factor, so W/R and cx/R are invariant.
    // The previous fixed-workspace stretch is gone.
    expect(source).not.toContain('const artLeft = (width - BITMAP_STANDARD_WIDTH) / 2')
    expect(source).toContain('context.imageSmoothingEnabled = true')
    expect(source).toContain('resolveVectorToBitmapSpec')
  })
})

describe('safe conversion procedure: bitmap -> vector (bitmap.js convertToVector)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference inserts the trimmed raster, clears the raster layer, and flips format to VECTOR',
    async () => {
      const source = await read(bitmapHelperUrl)
      expect(source).toContain('getTrimmedRaster(true /* shouldInsert */)')
      expect(source).toContain('clearRaster()')
      expect(source).toContain('Formats.VECTOR')
    },
  )

  it('current keeps the trace-free embedding: trimmed PNG data URL in a 1:1 drawing-bounds SVG', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('async function convertCurrentCostumeToVector()')
    expect(source).toContain('await captureCostumeHistory(selectedTarget, index)')
    expect(source).toContain('trimmedBitmapBounds(bitmapCanvas)')
    expect(source).toContain('data:image/png;base64,')
    expect(source).toContain('resolveBitmapToVectorSpec')
    expect(source).toContain('buildConvertedVectorSvg')
    expect(source).toContain("dataFormat: 'svg'")
    expect(source).toContain('rotationCenterX: spec.rotationCenterX')
  })

  it('empty bitmap converts to an imageless SVG instead of a broken <image> (repro: fully transparent canvas)', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('bitmapTrimmedDataUrl(bitmapCanvas, trim!)')
    expect(source).toContain('buildConvertedVectorSvg(spec, href)')
  })
})

describe('center / origin handling (view.js CENTER vs vectorRuntimeCostume)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference centers on the 960x720 art board and derives rotation center from content bounds',
    async () => {
      const view = await read(viewHelperUrl)
      expect(view).toContain('ART_BOARD_WIDTH = SVG_ART_BOARD_WIDTH * 2')
      expect(view).toContain('CENTER = new paper.Point(ART_BOARD_WIDTH / 2, ART_BOARD_HEIGHT / 2)')
      const update = await read(updateImageHocUrl)
      expect(update).toContain('(ART_BOARD_WIDTH / 2) - rect.x')
      expect(update).toContain('(SVG_ART_BOARD_WIDTH / 2) - bounds.x')
    },
  )

  it('current keeps stage costumes at 240,180 and derives sprite centers from content bounds minus stage center', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('rotationCenterX: 240')
    expect(source).toContain('rotationCenterY: 180')
    expect(source).toContain('const rotationCenterX = stageCenterX - left')
    expect(source).toContain('const rotationCenterY = stageCenterY - top')
  })

  it('paste stagger composes with existing transforms instead of overwriting them', () => {
    const element = fakeSvgElement({ transform: 'translate(5 7)' })
    addTranslate(element, 10, 10)
    expect((element as unknown as { getAttribute: (name: string) => string }).getAttribute('transform')).toContain(
      'translate(15 17)',
    )
    const plain = fakeSvgElement({})
    addTranslate(plain, 10, 10)
    expect((plain as unknown as { getAttribute: (name: string) => string }).getAttribute('transform')).toBe(
      'translate(10 10)',
    )
    expect(combineSvgTransforms('translate(1 2)', 'scale(3)')).toBe('translate(1 2) scale(3)')
  })
})

describe('Undo/Redo boundaries (undo.js MAX 100 Paper JSON vs paint/sound split cap 100)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reference snapshots Paper JSON (cap 100) and re-enters with SKIP_CONVERT so undo never reconverts',
    async () => {
      const reducer = await read(undoReducerUrl)
      expect(reducer).toContain('MAX_STACK_SIZE = 100')
      expect(reducer).toContain('stack.slice(0, state.pointer + 1).concat(action.snapshot)')
      const helper = new URL(
        '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/undo.js',
        import.meta.url,
      )
      const helperSource = await read(helper)
      expect(helperSource).toContain('exportJSON({asString: false})')
      expect(helperSource).toContain('Formats.VECTOR_SKIP_CONVERT')
      expect(helperSource).toContain('Formats.BITMAP_SKIP_CONVERT')
    },
  )

  it('current snapshots asset bytes+meta (cap 100, paint/sound on separate stacks)', async () => {
    const source = await read(editorUrl)
    // Paint and sound histories are separated (no shared assetUndoStack) and
    // each side is capped at 100 entries with an encoded-bytes budget.
    expect(source).not.toContain('let assetUndoStack')
    expect(source).toContain('let paintUndoStack')
    expect(source).toContain('let soundUndoStack')
    expect(source).toContain('PAINT_HISTORY_MAX_ENTRIES')
    expect(source).toContain('SOUND_HISTORY_MAX_ENTRIES')
    expect(source).toContain("kind: 'costume'")
    expect(source).toContain("kind: 'sound'")
  })

  it('current records before destructive clipboard/convert work and skips no-op entries', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('await captureCostumeHistory(selectedTarget, index)')
    // No-op guards that must not push history: transparent/offscreen paste and
    // invisible vector shapes.
    expect(source).toContain('if (!stamped.changed) {')
    expect(source).toContain('isNewVectorShapeNoop')
  })
})

describe('remote / external SVG security (display, import, persistence, rasterize, paste)', () => {
  it('display boundary sanitizes before parse and fails closed to a blank SVG', async () => {
    const source = await read(editorUrl)
    expect(source).toContain('const clean = sanitizeSvgForDisplay(svgText)')
    expect(source).toContain('return blankVectorEditorSvg()')
    expect(source).toContain('svgTextForVectorEditor(new TextDecoder().decode(bytes), target, costume)')
  })

  it('strict post-pass blocks remote vectors: external href, url(), image-set, fetch attrs, paper-data', async () => {
    const source = await read(sanitizeUrl)
    expect(source).toContain("FORBID_TAGS = [")
    expect(source).toContain("'script'")
    expect(source).toContain('isAllowedHref')
    expect(source).toContain('ALLOWED_IMAGE_DATA_PREFIXES')
    expect(source).toContain('containsExternalUrl')
    expect(source).toContain('containsExternalCssImageFunction')
    expect(source).toContain('image-set')
    expect(source).toContain('URL_BEARING_DENY_ATTRS')
    expect(source).toContain('data-paper-data')
  })

  it('VM persistence funnels through a parser-based sanitizer (not regex)', async () => {
    const source = await read(vmIndexUrl)
    expect(source).toContain('sanitizeSvgText')
    expect(source).toContain('sanitizeSvgByteStream')
  })

  it('rasterize path sanitizes before the blob <img> bitmap step', async () => {
    const source = await read(editorUrl)
    const start = source.indexOf('function svgWithCrispRendering')
    const end = source.indexOf('function trimmedBitmapBounds', start)
    const fn = source.slice(start, end === -1 ? undefined : end)
    expect(fn).toContain("setAttribute('shape-rendering', 'crispEdges')")
    // Hardened: upload `<svg><image href="https://evil.example/x.png"/></svg>`,
    // switch to bitmap: bytes are allowlisted via sanitizeSvgForDisplay before
    // the blob URL + <img> step, so remote vectors never reach the bitmap
    // loader even if a future draw path (or a non-<img> loader) would fetch.
    // SVG-as-image isolation alone is not the trust boundary here.
    expect(fn).toContain('sanitizeSvgForDisplay')
    // Fail-closed parse: sanitized markup that no longer parses as <svg>
    // encodes the clean string instead of falling back to raw bytes.
    expect(fn).toContain('SVG_PLACEHOLDER')
  })

  it('vector paste sanitizes clipboard markup before import', async () => {
    const source = await read(editorUrl)
    const start = source.indexOf('async function pasteVectorSelection()')
    const end = source.indexOf('async function copyCostumeSelection()', start)
    const fn = source.slice(start, end === -1 ? undefined : end)
    expect(fn).toContain('doc.importNode')
    // Hardened (defense-in-depth): the clipboard is only written from own
    // outerHTML today, but future OS-clipboard / drag-drop / extension input
    // could place `<svg onload=...>` or `<image href="https://...">` here.
    // Every entry is routed through the fragment-safe Paper-import sanitizer
    // before parsing: local `#` refs / transforms / embedded PNG survive so
    // existing defs references keep working, remote vectors fail closed.
    expect(fn).toContain('sanitizeSvgForPaperImport')
    expect(fn).toContain('SVG_PLACEHOLDER')
    // Full-document clipboard input is unwrapped to its inner units (no nested
    // `<svg>`), and `<defs>` companions fold into the live `<defs>`.
    expect(fn).toContain("tag === 'defs'")
  })
})
