import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

// Wiring-only guards for the vector fill-tool integration (Scratch
// `fill-tool.js` behavior, reimplemented from behavior notes without copying
// upstream source). These assert the Editor integration shape without driving
// a browser, so they run under `bun test`. Real Paper.js/DOM behavior stays
// in vector-fill-hover.browser.test.ts.
describe('vector fill-tool wiring (static + helper parity)', () => {
  it('fill clicks resolve a side-scoped Paper target, never a bbox fallback', () => {
    const editor = read('src/Editor.svelte')
    const fill = editor.slice(editor.indexOf('async function fillVectorObjectAtPoint'))
    const nextFn = fill.indexOf('\n  async function fillVectorHoleOverlayAtPoint', 1)
    const body = nextFn > 0 ? fill.slice(0, nextFn) : fill
    // Fill + stroke hit with zoom-aware tolerance (no segments/curves).
    expect(body).toContain('paperVectorFillTargetAtPoint')
    expect(body).toContain('paperVectorHoleTargetAtPoint')
    expect(body).toContain('resolveVectorHitTolerance()')
    // Reference `match` gate: open-path fill hits stay untouched.
    expect(body).toContain('shouldAcceptFillHoverHit')
    expect(body).toContain('open paths take only outline color')
    // Compound-path holes never recolor the parent: transparent is a no-op,
    // colored holes become a fill-only overlay via the geometric hole probe.
    expect(body).toContain('isHoleFillHit')
    expect(body).toContain('decideFillHoverTarget')
    expect(body).toContain('fillVectorHoleOverlayAtPoint')
    expect(body).toContain('transparent holes stay empty')
    expect(body).toContain('hole overlaps another shape, left unchanged')
    expect(body).toContain('hole geometry is unavailable, left unchanged')
    // The body commit is scoped to the hit side (fill vs outline).
    expect(body).toContain("editVectorObject('style', point, decision.property)")
    // Misses return before any selection change or history capture, so
    // outside clicks leave undo/redo and selection alone. Hole no-ops also
    // report honestly without touching history.
    expect(body).toContain('no shape under the pointer')
    const missReturn = body.indexOf('no shape under the pointer')
    expect(body.indexOf('selectedVectorObjectIndex = target.index')).toBeGreaterThan(missReturn)
    expect(body).not.toContain('vectorObjectIndexAtPoint')
    expect(body).not.toContain('captureCostumeHistory')
    // History for holes lives in the overlay helper (peek/commit only on
    // success); the click path itself never captures up-front.
    expect(body).not.toContain('peekCostumeHistory')
    expect(body).not.toContain('commitPaintHistory')
  })

  it('hole overlays add a fill-only sibling with guarded history/selection', () => {
    const editor = read('src/Editor.svelte')
    const start = editor.indexOf('async function fillVectorHoleOverlayAtPoint')
    const rest = editor.slice(start)
    const nextFn = rest.indexOf('\n  async function ', 1)
    const overlay = nextFn > 0 ? rest.slice(0, nextFn) : rest.slice(0, 8000)
    expect(overlay).toContain('isHolePathDataSafe')
    expect(overlay).toContain('isFillInvisible')
    expect(overlay).toContain("overlay.setAttribute('d', hole.holePathData)")
    expect(overlay).toContain("overlay.setAttribute('stroke', 'none')")
    expect(overlay).toContain('appendVectorPaintDefs')
    expect(overlay).toContain('peekCostumeHistory')
    expect(overlay).toContain('commitPaintHistory')
    expect(overlay).toContain('hole filled')
    // No bbox fallback, no parent recolor, no untrusted paint interpolation.
    expect(overlay).not.toContain('vectorObjectIndexAtPoint')
    expect(overlay).not.toContain('captureCostumeHistory')
  })

  it('style commits backfill only the hit side for fill-tool clicks', () => {
    const editor = read('src/Editor.svelte')
    expect(editor).toContain("fillClickPoint?: { x: number; y: number }, fillSide?: 'fill' | 'stroke'")
    const style = editor.slice(editor.indexOf("} else if (action === 'style')"))
    expect(style).toContain("fill: fillSide === 'stroke' ? undefined")
    expect(style).toContain("stroke: fillSide === 'fill' ? undefined")
    // Width/opacity stay dirty-gated even for fill clicks (no unrelated writes).
    expect(style).toContain('strokeWidth: basePatch.strokeWidth')
    expect(style).toContain('opacity: basePatch.opacity')
  })

  it('the fill resolver hits fill + stroke only and reports match metadata', () => {
    const helper = read('src/features/costumes/paper-vector.ts')
    expect(helper).toContain('paperVectorFillTargetAtPoint')
    const resolver = helper.slice(helper.indexOf('export async function paperVectorFillTargetAtPoint'))
    const nextExport = resolver.indexOf('\n}\n')
    const body = nextExport > 0 ? resolver.slice(0, nextExport) : resolver
    expect(body).toContain('fill: true, stroke: true')
    expect(body).not.toContain('segments: true')
    expect(body).not.toContain('curves: true')
    expect(body).toContain('hitType')
    expect(body).toContain('almostClosed')
    expect(body).toContain('parentIsCompoundPath')
    expect(body).toContain('childArea')
    expect(body).toContain('isText')
  })

  it('the hole probe uses real compound children with fail-closed overlap handling', () => {
    const helper = read('src/features/costumes/paper-vector.ts')
    expect(helper).toContain('paperVectorHoleTargetAtPoint')
    expect(helper).toContain('isHolePathDataSafe')
    expect(helper).toContain('CompoundPath')
    expect(helper).toContain('fill-rule')
    expect(helper).toContain('clip')
    expect(helper).toContain('overlapping holes')
    expect(helper).toContain('hole overlaps')
    expect(helper).not.toContain('vectorObjectIndexAtPoint')
  })

  it('the relative-m fallback never overrides a safe Paper verdict', () => {
    const helper = read('src/features/costumes/paper-vector.ts')
    // Pure helper is the only new geometry source (no renderer guessing).
    expect(helper).toContain('geometryFallbackHoleProbe')
    expect(helper).toContain('classifyHolePoint')
    expect(helper).toContain('parseStraightContours')
    expect(helper).toContain('isPathDataSafeForHoleGeometry')
    expect(helper).toContain('isUnitEligibleForHoleGeometry')
    // Fallback runs only after the Paper probe reports none: safe Paper
    // holes and ambiguous/unsupported verdicts return before it.
    const probe = helper.slice(helper.indexOf('export async function paperVectorHoleTargetAtPoint'))
    const fallbackCall = probe.indexOf('geometryFallbackHoleProbe(elements, point, tolerance)')
    expect(fallbackCall).toBeGreaterThan(-1)
    expect(probe.indexOf("if (probe.kind === 'hole')")).toBeLessThan(fallbackCall)
    expect(probe.indexOf("else if (probe.kind === 'ambiguous')")).toBeLessThan(fallbackCall)
    expect(probe.indexOf("else if (probe.kind === 'unsupported')")).toBeLessThan(fallbackCall)
    expect(probe.indexOf('if (nestedHoleReason)')).toBeLessThan(fallbackCall)
    // Only the clicked hole contour becomes an overlay sibling (never the
    // whole `d`); cross-unit holes stay ambiguous for Z-order.
    const fallback = helper.slice(helper.indexOf('export function geometryFallbackHoleProbe'))
    expect(fallback).toContain('holeContourToPathData')
    expect(fallback).toContain('holeDocumentBounds')
    expect(fallback).toContain('parentTransform')
    expect(fallback).toContain('overlapping holes at units')
    // Distant overlap never poisons outside clicks (bounds gate).
    expect(fallback).toContain('if (!near) continue')
  })

  it('the curved fallback runs last, only for curves, and never overrides safe verdicts', () => {
    const helper = read('src/features/costumes/paper-vector.ts')
    // Curve helper is wired conservatively at the end of the existing fallback.
    expect(helper).toContain('probeCurvedFallbackHole')
    const probe = helper.slice(helper.indexOf('export async function paperVectorHoleTargetAtPoint'))
    const straightCall = probe.indexOf('geometryFallbackHoleProbe(elements, point, tolerance)')
    const curvedCall = probe.indexOf('probeCurvedFallbackHole(')
    expect(straightCall).toBeGreaterThan(-1)
    expect(curvedCall).toBeGreaterThan(straightCall)
    // Straight fallback verdicts are never overridden: the curved probe runs
    // only when the straight fallback reports none.
    expect(probe.indexOf("if (fallback.kind === 'hole'")).toBeLessThan(curvedCall)
    expect(probe.indexOf("fallback.kind === 'ambiguous'")).toBeLessThan(curvedCall)
    expect(probe.indexOf("fallback.kind === 'unsupported'")).toBeLessThan(curvedCall)
    // Implementation lives in its own module (split out of paper-vector.ts
    // without behavior change); only the file moved.
    expect(helper).toContain("from './vector-curved-hole-probe'")
    const curved = read('src/features/costumes/vector-curved-hole-probe.ts')
    expect(curved).toContain('classifyCurvedHolePoint')
    expect(curved).toContain('curvedHoleDataHasCurves')
    expect(curved).toContain('isPathDataSafeForCurvedHoleGeometry')
    expect(curved).toContain('splitCurvedHoleSubpaths')
    // Only curve-containing paths reach the curve helper.
    const body = curved.slice(curved.indexOf('export async function probeCurvedFallbackHole'))
    expect(body).toContain('curvedHoleDataHasCurves(data)')
    // Canvas-vs-Paper conflicts never become holes (2-segment lens safe-fail).
    expect(curved).toContain('Canvas and Paper disagree')
    // Helper holes require independent Paper-outline confirmation.
    expect(curved).toContain('safePaperContains(item, target)')
    expect(curved).toContain('safePaperIntersectionsCount(hole, outer)')
    // The overlay outline is the original curved subpath, never the
    // flattened polyline, with an explicit close.
    expect(curved).toContain('splitCurvedHoleSubpaths(data)')
    expect(curved).not.toContain('holeContourToPathData')
    // Coordinate-error / paint safety refuses instead of placing a shifted overlay.
    expect(curved).toContain('hole geometry failed validation')
    expect(curved).toContain('isSafeCurvedHoleSiblingTransform')
    // Mirror / non-uniform / skew stay fail-closed via the similarity gate.
    expect(curved).toContain('gateCurvedWorldMatrix')
    // Distant curves never poison outside clicks (widened bounds gate).
    expect(curved).toContain('if (!near) continue')
    // Cross-unit curved holes stay ambiguous for Z-order.
    expect(curved).toContain('overlapping holes at units')
  })
})
