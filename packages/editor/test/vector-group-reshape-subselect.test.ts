// Group-leaf reshape subselect wiring audit (DOM-free source checks).
//
// Scratch parity: reshape subselects one leaf (child shape) inside a `<g>`
// unit via a real Paper.js hitTest (topmost wins, never a bbox guess);
// returning to the select tool normalizes back to the compound root. The
// surgical move path, single-history rule, Escape restore, and drag-target
// guards are shared with the anchor drag. Unsupported units (text/raster/
// clip/compound/ambiguous identity) fail closed with an explicit status and
// no history or selection change.
//
// This file audits the wiring without a browser: the behavioral proof lives
// in `vector-group-reshape-subselect.browser.test.ts`.
import { describe, expect, it } from 'bun:test'

const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
const bitmapSource = await Bun.file(
  new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url),
).text()
const overlaySource = await Bun.file(
  new URL('../src/features/CostumeEditor/VectorReshapeOverlay.svelte', import.meta.url),
).text()
const paperSource = await Bun.file(
  new URL('../src/features/costumes/paper-vector.ts', import.meta.url),
).text()
const helperSource = await Bun.file(
  new URL('../src/features/costumes/vector-group-reshape.ts', import.meta.url),
).text()

function bodyOf(source: string, fn: string, length = 3000): string {
  const start = source.indexOf(fn)
  if (start < 0) throw new Error(`Missing ${fn}`)
  return source.slice(start, start + length)
}

describe('group-leaf reshape subselect wiring', () => {
  it('Editor keeps per-leaf selection normalized to the compound root', () => {
    expect(editorSource).toContain('vectorReshapeLeafIndices')
    expect(editorSource).toContain('function setReshapeLeafSelection')
    expect(editorSource).toContain('function clearReshapeLeafSelection')
    // clearReshapeSelection drops leaves wherever points are dropped, so a
    // stale leaf can never leak across units.
    const clearBody = bodyOf(editorSource, 'function clearReshapeSelection()', 400)
    expect(clearBody).toContain('vectorReshapeLeafIndices = []')
    // Select-return normalization collapses leaves to the root unit.
    expect(editorSource).toContain('function normalizeReshapeLeafToSelectRoot')
    const normalizeBody = bodyOf(editorSource, 'function normalizeReshapeLeafToSelectRoot()', 800)
    expect(normalizeBody).toContain('normalizeLeafSelectionToRoot')
    expect(normalizeBody).toContain('clearReshapeSelection()')
  })

  it('leaf click resolves through the real Paper hitTest with fail-closed guards', () => {
    const selectBody = bodyOf(editorSource, 'async function selectVectorReshapeLeafAtPoint', 6000)
    expect(selectBody).toContain('paperGroupLeafHitAtPoint')
    expect(selectBody).toContain('classifyGroupUnitForLeafReshape')
    expect(selectBody).toContain('paperFlatAnchorIndicesForGroupLeaves')
    // Whole-leaf translate fallback for safe text/image groups (use stays
    // fail-closed); geometry path unchanged.
    expect(selectBody).toContain('selectVectorTranslateLeafAtPoint')
    expect(editorSource).toContain('paperGroupTranslateLeafHitAtPoint')
    expect(editorSource).toContain('classifyGroupUnitForLeafTranslate')
    // Fail-closed: explicit status, no history, no selection change.
    expect(selectBody).toContain('fail-closed')
    expect(selectBody).not.toContain('commitPaintHistory')
    expect(selectBody).not.toContain('captureCostumeHistory')
    // Drag-safety: refused mid-drag (anchor + whole-leaf) and re-checked after every await.
    expect(selectBody).toContain('vectorPathPointDrag')
    expect(selectBody).toContain('vectorLeafTranslateDrag')
    expect(selectBody).toContain("selectedTarget.name !== targetName")
    expect(selectBody).toContain('selectedVectorObjectIndex !== objectIndex')
    // Shift toggles leaves in/out (multi).
    expect(selectBody).toContain('current.includes(hit.leafIndex)')
    // Curve/stroke click on the already solely-selected leaf falls through
    // to point-add instead of re-selecting.
    expect(selectBody).toContain("hit.hitType === 'curve'")
  })

  it('anchor drags carry the leaf set through preview, Escape, and switch-cancel', () => {
    // Snapshot carries leaves alongside the point selection.
    expect(editorSource).toContain('reshapeLeaves: [...vectorReshapeLeafIndices]')
    // preview/restore は末尾で leaf を再適用するため固定長 slice では届か
    // ない。次関数までの本体で判定する。
    const preciseBody = (name: string) => {
      const start = editorSource.indexOf(name)
      if (start < 0) throw new Error(`Missing ${name}`)
      const rest = editorSource.slice(start)
      const nextFn = rest.slice(100).search(/\n\s*(?:async )?function\s/)
      return nextFn < 0 ? rest : rest.slice(0, 100 + nextFn)
    }
    const previewBody = preciseBody('async function previewVectorPathPointFromSource')
    expect(previewBody).toContain('setReshapeLeafSelection(drag.reshapeLeaves')
    const restoreBody = preciseBody('async function restoreVectorPathPointSource')
    expect(restoreBody).toContain('setReshapeLeafSelection(drag.reshapeLeaves')
    // Escape/pointercancel 復元は exact バイト復元経由で履歴に触れない。
    expect(restoreBody).toContain('restoreVectorSnapshotExact')
    expect(restoreBody).not.toContain('commitPaintHistory')
    // Escape/pointercancel restores via the same path without history.
    const cancelBody = preciseBody('function cancelVectorPathPointDrag')
    expect(cancelBody).toContain('restoreVectorPathPointSource(drag, true)')
    expect(cancelBody).not.toContain('commitPaintHistory')
  })

  it('anchor add/delete/style and marquee re-sync leaves fail-closed', () => {
    expect(editorSource).toContain('function syncReshapeLeavesToPoints')
    const syncBody = bodyOf(editorSource, 'async function syncReshapeLeavesToPoints', 2500)
    expect(syncBody).toContain('paperLeafIndexForFlatAnchor')
    expect(syncBody).toContain('clearReshapeLeafSelection()')
    expect(syncBody).not.toContain('commitPaintHistory')
    // Marquee re-syncs leaves after every point-set write; the function grew
    // stale-guard boilerplate, so a fixed-length slice no longer reaches the
    // tail call — bound the body at the next function instead (same approach
    // as preciseBody above), covering the whole body and nothing more.
    const marqueeStart = editorSource.indexOf('function selectVectorReshapePointsInRect')
    if (marqueeStart < 0) throw new Error('Missing function selectVectorReshapePointsInRect')
    const marqueeRest = editorSource.slice(marqueeStart)
    const marqueeNext = marqueeRest.slice(100).search(/\n\s*(?:async )?function\s/)
    const marqueeBody = marqueeNext < 0 ? marqueeRest : marqueeRest.slice(0, 100 + marqueeNext)
    expect(marqueeBody).toContain('syncReshapeLeavesToPoints')
    const toggleBody = bodyOf(editorSource, 'function toggleVectorReshapePoint', 600)
    expect(toggleBody).toContain('syncReshapeLeavesToPoints')
  })

  it('BitmapEditor maps client points to leaf hits and normalizes on tool switch', () => {
    expect(bitmapSource).toContain('selectVectorReshapeLeafAtPoint')
    expect(bitmapSource).toContain('function reshapeLeafAtClient')
    expect(bitmapSource).toContain('selectLeafAtClient')
    // Leaving reshape normalizes to the root (leaves + points clear).
    const toolStart = bitmapSource.indexOf('function chooseVectorTool')
    const toolEnd = bitmapSource.indexOf('\n  function selectedVectorObject', toolStart)
    expect(toolStart).toBeGreaterThanOrEqual(0)
    expect(toolEnd).toBeGreaterThan(toolStart)
    const toolBody = bitmapSource.slice(toolStart, toolEnd)
    expect(toolBody).toContain('normalizeReshapeLeafToSelectRoot')
    expect(toolBody).toContain('vectorReshapeLeafIndices')
    // Blank clicks clear leaves alongside points.
    expect(bitmapSource).toContain('selectVectorReshapeLeaves?.([])')
  })

  it('overlay tries the leaf hit before point-add on group curve clicks', () => {
    expect(overlaySource).toContain('selectLeafAtClient')
    expect(overlaySource).toContain('beginLeafTranslateAtClient')
    const curveBody = bodyOf(overlaySource, 'function handleCurvePointerDown', 2800)
    expect(curveBody).toContain('beginLeafTranslateAtClient')
    expect(curveBody).toContain('selectLeafAtClient')
    expect(curveBody).toContain("object.tag === 'g'")
    // A leaf hit consumes the click; misses fall through to point-add.
    expect(curveBody).toContain('if (handled === true) return')
    expect(curveBody).toContain('if (hit === true) return')
    expect(curveBody).toContain('addAtClient?.(event.clientX, event.clientY)')
  })

  it('paper-vector exposes fail-closed leaf hit and anchor mapping', () => {
    expect(paperSource).toContain('export async function paperGroupLeafHitAtPoint')
    expect(paperSource).toContain('export async function paperFlatAnchorIndicesForGroupLeaves')
    expect(paperSource).toContain('export async function paperLeafIndexForFlatAnchor')
    const hitBody = bodyOf(paperSource, 'export async function paperGroupLeafHitAtPoint', 2000)
    expect(hitBody).toContain('fail-closed')
    expect(hitBody).toContain('hitTest')
    expect(hitBody).toContain('unsupported')
    // No bounding-box fallback for child resolution.
    expect(hitBody).not.toContain('getBoundingClientRect')
    expect(hitBody).not.toContain('bounds.contains')
  })

  it('vector-group-reshape classifies unsupported units fail-closed', () => {
    expect(helperSource).toContain('export function classifyGroupUnitForLeafReshape')
    const classifyBody = bodyOf(helperSource, 'export function classifyGroupUnitForLeafReshape', 2500)
    expect(classifyBody).toContain('fail-closed')
    const lowered = helperSource.toLowerCase()
    for (const blocked of ['text', 'image', 'use', 'clippath', 'clip-path']) {
      expect(lowered).toContain(blocked)
    }
  })
})
