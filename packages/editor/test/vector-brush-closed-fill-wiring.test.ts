import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildVectorBrushFillPathData, vectorBrushFillMarkup } from '../src/features/costumes/vector-brush-fill'

const root = join(import.meta.dir, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

// Wiring-only guards for the closed-fill vector brush connection.
// These assert the Editor integration shape (fill color + brush size +
// single Undo + fail-closed merge) without driving a browser, so they run
// under `bun test`. Real Paper.js/DOM behavior stays in
// vector-brush-fill-merge-independent.browser.test.ts and the new
// vector-brush-closed-fill.browser.test.ts.
describe('vector brush closed-fill wiring (static + helper parity)', () => {
  it('preview renders the same closed fill the commit builds (no centerline stroke)', () => {
    const preview = read('src/features/CostumeEditor/VectorBrushPreview.svelte')
    expect(preview).toContain('buildVectorBrushFillPathData')
    expect(preview).toContain('stroke="none"')
    expect(preview).not.toContain('<polyline')
    expect(preview).not.toContain('stroke={color}')
    // Single dots stay circles with the shared max(1, width)/2 radius.
    expect(preview).toContain('<circle')

    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    const width = 20
    // The preview derives this exact `d` from the same helper the commit
    // uses, so spine coverage and capsule parity proven in the independent
    // browser suite apply to both surfaces.
    const d = buildVectorBrushFillPathData(points, width)
    expect(d.endsWith('Z')).toBe(true)
    const markup = vectorBrushFillMarkup({ pathData: d, fill: '#ff0000', opacity: 100 })
    expect(markup).toContain(`d="${d}"`)
    expect(markup).toContain('fill="#ff0000"')
    expect(markup).toContain('stroke="none"')
  })

  it('BitmapEditor previews the solid fill color and skips transparent strokes', () => {
    const editor = read('src/features/CostumeEditor/BitmapEditor.svelte')
    // Live + pending previews use the solid fill (paintColor), never the
    // stroke color, and hide for transparent fill.
    expect(editor).toContain('color={paintColor}')
    expect(editor).not.toContain('<VectorBrushPreview points={vectorBrushPoints} color={previewStrokeColor}')
    expect(editor).toContain("fillTransparent ? 'none' : paintColor")
    expect(editor).toContain('!(fillTransparent)')
  })

  it('Editor commits closed fills with one history entry and fail-closed merge', () => {
    const editor = read('src/Editor.svelte')
    expect(editor).toContain('buildVectorBrushFillPathData')
    expect(editor).toContain('vectorBrushFillMarkup')
    expect(editor).toContain('mergeBrushElementWithSiblings')
    // Solid fill only; stroke color / gradient defs must not leak into the brush.
    expect(editor).toContain("fillTransparent ? 'none' : paintColor")
    // Transparent and degenerate inputs return before any history peek/CAS,
    // so one stroke is at most one Undo entry (zero for no-ops). History is
    // peek -> successful CAS -> commit (never immediate capture), so no-op /
    // conflict never pollutes the stack; normal Undo/Redo stays intact.
    const save = editor.slice(editor.indexOf('async function saveVectorBrushStroke'))
    const nextFn = save.indexOf('\n  async function ', 1)
    const body = nextFn > 0 ? save.slice(0, nextFn) : save
    expect(body).toContain('if (!selectedTarget || points.length === 0) return')
    expect(body.indexOf("trim().toLowerCase() === 'none'")).toBeGreaterThan(-1)
    expect(body.indexOf('if (!pathData) return')).toBeGreaterThan(-1)
    // No immediate capture in the brush path: history enters only via peek.
    expect(body).not.toContain('captureCostumeHistory')
    // Single peek before the DOM change, versioned CAS, then the applied-path
    // history commit (loaded + fallback branches share the same peeked entry,
    // so one executed branch == at most one Undo entry).
    expect(body.match(/await peekCostumeHistory/g)?.length).toBe(1)
    expect(body.indexOf('await peekCostumeHistory')).toBeGreaterThan(body.indexOf('if (!pathData) return'))
    expect(body).toContain('await updateVectorCostumeFromEditor')
    expect(body.indexOf('await updateVectorCostumeFromEditor')).toBeGreaterThan(body.indexOf('await peekCostumeHistory'))
    expect(body.match(/if \(pendingHistory\) commitPaintHistory\(pendingHistory\)/g)?.length).toBe(2)
    // Commits only on the applied path: conflict / superseded returns early
    // without touching history (fail-closed, external kept, residue dropped).
    expect(body).toContain("if (commit.kind !== 'applied')")
    expect(body.indexOf('if (pendingHistory) commitPaintHistory')).toBeGreaterThan(body.indexOf("if (commit.kind !== 'applied')"))
    expect(body).toContain('refreshVectorPreviewFromLive')
    expect(body).toContain('reportVectorExternalConflict')
    // Merge failures never drop the fresh stroke; stale reshape points are cleared
    // (single + multi selection alike, via the shared clear helper).
    expect(body).toContain('mergeBrushElementWithSiblings')
    expect(body).toContain('clearReshapeSelection()')
    // No centerline stroke markup remains on the brush path.
    expect(body).not.toContain('vectorBrushMarkup')
    expect(body).not.toContain('vectorBrushPathData')
  })
})
