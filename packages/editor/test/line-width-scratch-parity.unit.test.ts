import { describe, expect, it } from 'bun:test'
import {
  vectorShapeInRectMarkup,
  vectorShapeMarkup,
  vectorBrushMarkup,
} from '../src/features/costumes/vector-shapes'
import {
  VECTOR_STROKE_PARITY_WIDTHS,
  vectorLineSvgForUi,
  vectorStrokeSvgToUi,
  vectorStrokeUiToSvg,
} from '../src/features/costumes/vector-stroke-scale'

// Fail-first Scratch-parity probe for the contradictory line-width audits.
//
// Reference (`.tmp/scratch-editor`, `.tmp/line-width-probe/result.json`):
//   stored `stroke-width = UI / 2` for every width in [1, 4, 10, 25, 100]
//   (`scratchSvgPerUi = 0.5`), re-imported Paper `= SVG * 2`, so an imported
//   `stroke-width="5"` selects as UI `10` and typing UI `10` stores `5`.
//
// Current editor (unreviewed 2x -> 1x): `vector-shapes.ts` and
// `VectorShapePreview.svelte` use `stroke-width = UI` verbatim
// (`editorSvgPerUi = 1`). These tests assert the reference scale, so they
// FAIL against the current 1x code with exactly a 2x numeric gap. That is
// the honest signal: do NOT "fix" them with a one-line `* 0.5` in
// `vector-shapes.ts` alone — rect/oval/brush/selection/text/erase/gradients
// and the `Editor.svelte` toolbar wiring (owned by a concurrent agent) must
// move together (see the summary test at the bottom).
const paint = { defs: '', fill: '#ff0000' }
const rect = (w: number) => ({ x: 10, y: 20, width: 120, height: 60 })

function attr(markup: string): number {
  const m = /stroke-width="([^"]*)"/.exec(markup)
  if (!m) throw new Error(`missing stroke-width in ${markup}`)
  return Number(m[1])
}

describe('line-width Scratch parity (fail-first, UI 1/4/10/25/100)', () => {
  for (const ui of VECTOR_STROKE_PARITY_WIDTHS) {
    it(`line drag stores UI/2 for UI=${ui}`, () => {
      const markup = vectorShapeInRectMarkup({
        shape: 'line',
        rect: { x: 0, y: 0, width: 200, height: 0 },
        paint,
        strokeColor: '#000000',
        strokeWidth: ui,
        opacity: 100,
      })
      expect(attr(markup)).toBeCloseTo(vectorLineSvgForUi(ui), 9)
    })

    it(`rect drag stores UI/2 for UI=${ui}`, () => {
      const markup = vectorShapeInRectMarkup({
        shape: 'rect',
        rect: rect(ui),
        paint,
        strokeColor: '#000000',
        strokeWidth: ui,
        opacity: 100,
      })
      expect(attr(markup)).toBeCloseTo(vectorStrokeUiToSvg(ui), 9)
    })

    it(`oval drag stores UI/2 for UI=${ui}`, () => {
      const markup = vectorShapeInRectMarkup({
        shape: 'oval',
        rect: rect(ui),
        paint,
        strokeColor: '#000000',
        strokeWidth: ui,
        opacity: 100,
      })
      expect(attr(markup)).toBeCloseTo(vectorStrokeUiToSvg(ui), 9)
    })

    it(`line click stamp stores UI/2 for UI=${ui}`, () => {
      const markup = vectorShapeMarkup({
        shape: 'line',
        width: 480,
        height: 360,
        paint,
        strokeColor: '#000000',
        strokeWidth: ui,
        opacity: 100,
        text: '',
      })
      expect(attr(markup)).toBeCloseTo(vectorLineSvgForUi(ui), 9)
    })
  }

  it('imported stroke-width="5" selects as UI 10 (inverse conversion)', async () => {
    // The selection reader today returns the attribute verbatim (5); parity
    // requires the `* 2` inverse. This locks the converter both directions.
    expect(vectorStrokeSvgToUi(5)).toBe(10)
    expect(vectorStrokeUiToSvg(10)).toBe(5)
    // And the current reader path has no such conversion (documents the gap):
    // `readVectorElementPaintDetailed` resolves `stroke-width` verbatim.
    // If this ever passes without the selection patch, the patch landed.
    const { readVectorElementPaintDetailed } = await import('../src/features/costumes/vector-selection-style')
    const element = {
      getAttribute: (name: string) => (name === 'stroke-width' ? '5' : name === 'stroke' ? '#000000' : null),
      hasAttribute: () => false,
    }
    const detailed = readVectorElementPaintDetailed(
      element as unknown as Parameters<typeof readVectorElementPaintDetailed>[0],
      () => undefined,
    )
    expect(detailed.strokeWidth as number).toBeCloseTo(10, 9)
  })

  it('preview geometry uses UI/2 like the commit (same widths)', async () => {
    const source = await Bun.file(
      new URL('../src/features/CostumeEditor/VectorShapePreview.svelte', import.meta.url),
    ).text()
    // Preview must apply the same scale as the commit; today both are 1x.
    // Extract the stroke-width attribute expressions only (geometry `/ 2`
    // in cx/rx must not count).
    const strokeExprs = [...source.matchAll(/stroke-width=\{([^}]*)\}/g)].map((m) => m[1] ?? '')
    expect(strokeExprs.length).toBeGreaterThan(0)
    expect(strokeExprs.some((expr) => /(\*\s*0\.5|\/\s*2|UiToSvg|uiToSvg)/.test(expr))).toBe(true)
  })

  it('legacy stroke brush + text stay consistent (no silent one-shape fix)', () => {
    // A line-only `* 0.5` would leave these behind: brush stroke is 1x today,
    // text outline is UI/4 (probe-visible special case). Either the migration
    // covers them explicitly or it must not land.
    for (const ui of VECTOR_STROKE_PARITY_WIDTHS) {
      const brush = vectorBrushMarkup({ path: 'M0 0 L10 0', strokeColor: '#000000', strokeWidth: ui, opacity: 100 })
      expect(attr(brush)).toBeCloseTo(vectorStrokeUiToSvg(ui), 9)
    }
    const text = vectorShapeMarkup({
      shape: 'text',
      width: 480,
      height: 360,
      paint,
      strokeColor: '#000000',
      strokeWidth: 4,
      opacity: 100,
      text: 'hi',
    })
    // Parity for text is UNDECIDED (reference halves text too, editor uses
    // /4): this assertion documents the open question instead of guessing.
    // Scratch-parity text would store 2 for UI 4; the editor stores 1.
    expect(attr(text)).toBeCloseTo(2, 9)
  })

  it('summary: honest 1x state and 2x error (read this on failure)', () => {
    // If any test above fails, the state is: current 1x is internally
    // consistent (line == rect == oval == preview == selection) but stores
    // 2x Scratch bytes (UI 10 -> SVG 10, reference SVG 5; stage px 2x).
    // Safe migration = one coordinated change across vector-shapes.ts (all
    // shapes + brush + text decision), VectorShapePreview.svelte,
    // selection read (*2) + write (/2) + same-value guards, Editor.svelte
    // toolbar wiring (CONCURRENT OWNER — proposal only), import display of
    // pre-existing 1x artwork, undo/redo + history, SVG format/scale/
    // translation/rotationCenter preservation, bitmap tools untouched, and
    // bitmap/vector conversions. A line-only `* 0.5` is explicitly UNSAFE.
    expect(true).toBe(true)
  })
})
