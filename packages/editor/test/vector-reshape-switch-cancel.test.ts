// Reshape mid-drag costume/sprite switch cancel wiring.
//
// Independent audit finding: `resetCostumeEditorSelection` (the reactive
// target/costume switch path covering mouse, keyboard and programmatic
// switches) never cancelled `vectorPathPointDrag`. The drag state survived
// the switch, the generic restore then mismatched the new target and
// returned false, and a stranded drag could keep previewing/committing
// against the wrong asset.
//
// Contract covered here (DOM-free source wiring):
// - the switch reset explicitly cancels the drag: clears state
//   synchronously, restores the OLD snapshot to the OLD asset only, never
//   touches the new selection/preview, terminates the pending peeked entry
//   without committing (history/redo untouched), tracks the async restore on
//   the shared cancel promise so a subsequent edit (or Undo/Redo) awaits it,
//   and no-ops safely when the old target/costume is gone;
// - live preview frames abort once the drag is gone (or the costume index
//   moved on) and re-check immediately before writing, so a switch-cancel
//   restore stays the last writer of the old asset and the new artwork is
//   never overwritten;
// - `selectCostume` (programmatic/mouse/keyboard entry) awaits the cancel
//   promise before refreshing the new preview.
import { describe, expect, it } from 'bun:test'

const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()

function bodyOf(fn: string, length = 3000): string {
  let start = source.indexOf(fn)
  if (start < 0) {
    // Async-aware fallback: tolerate callers pinning with/without `async`.
    const alt = fn.startsWith('async ') ? fn.replace(/^async\s+/, '') : `async ${fn}`
    start = source.indexOf(alt)
  }
  if (start < 0) throw new Error(`Missing ${fn}`)
  // Non-function pins keep the narrow fixed window (block-local isolation).
  if (!fn.includes('function')) return source.slice(start, start + length)
  const rest = source.slice(start)
  // Next-function bounded slice: survive prepended pending commit-first blocks
  // that push `await waitForVectorRotateCancel()` beyond the stale 800 window.
  const next = rest.slice(100).search(/\n\s*(?:async\s+)?function\s/)
  if (next < 0) return rest
  return rest.slice(0, 100 + next)
}

describe('reshape switch-cancel wiring', () => {
  it('resetCostumeEditorSelection explicitly cancels an active reshape drag', () => {
    const body = bodyOf('function resetCostumeEditorSelection()', 4500)
    expect(body).toContain('if (vectorPathPointDrag)')
    expect(body).toContain('vectorPathPointDrag = undefined')
    expect(body).toContain('restoreVectorPathPointSourceForSelectionSwitch(drag)')
    expect(body).toContain('vectorRotateCancelPromise')
    // Terminate the pending point selection with the old artwork.
    expect(body).toContain('clearReshapeSelection()')
    // No history commit on a switch cancel (redo must survive).
    expect(body).not.toContain('commitPaintHistory')
  })

  it('switch restore writes the old snapshot to the old asset only', async () => {
    // restoreVectorSnapshotExact 経由で旧 asset の旧 slot へ exact 復元する。
    // updateVectorCostumeFromEditor 直書きは viewBox/rotationCenter を再計算
    // して別バイト化するため使わない (leaf md5 drift 防止)。
    const start = source.indexOf('async function restoreVectorPathPointSourceForSelectionSwitch')
    if (start < 0) throw new Error('Missing restoreVectorPathPointSourceForSelectionSwitch')
    const rest = source.slice(start)
    const nextFn = rest.slice(100).search(/\n\s*(?:async )?function\s/)
    const body = nextFn < 0 ? rest : rest.slice(0, 100 + nextFn)
    // Old bytes back to the old target/costume (ID-scoped, stale別slot防止).
    expect(body).toContain('await drag.sourceReady')
    expect(body).toContain('vectorWriteTargetById(drag.targetId, source.targetName)')
    expect(body).toContain('stableTargetId(target) !== drag.targetId')
    expect(body).toContain('target.costumes[source.costumeIndex]')
    expect(body).toContain('await restoreVectorSnapshotExact(target, source.costumeIndex, source.svgText, drag)')
    // Deleted target/costume (or missing snapshot) is a safe no-op (gesture cleared).
    expect(body).toMatch(/if \(!source\)/)
    expect(body).toContain('return false')
    expect(body).toContain('if (!costume)')
    expect(body).toContain('clearVectorGestureIdentity')
    // Never overwrite the newly selected artwork or selection.
    for (const forbidden of [
      'vectorObjects =',
      'selectedVectorObjectIndex =',
      'selectedVectorObjectIndices =',
      'setReshapeSelection(',
      'refreshCostumePreview',
      'commitPaintHistory',
    ]) {
      expect(body).not.toContain(forbidden)
    }
    // No selectedTarget fallback: a gone target must not redirect the write.
    expect(body).not.toContain('?? selectedTarget')
    // Exact path keeps raw peek bytes+meta (byte-identical cancel).
    expect(source).toContain('async function restoreVectorSnapshotExact')
  })

  it('live preview aborts after a switch and never writes the new selection', () => {
    const body = bodyOf('async function previewVectorPathPointFromSource', 6000)
    // Stops as soon as the switch cleared the drag state.
    expect(body).toContain('vectorPathPointDrag.pointerId !== drag.pointerId')
    // Same-target costume switch guard.
    expect(body).toContain('(selectedTarget.currentCostume ?? 0) !== source.costumeIndex')
    // Old snapshot belongs to the old target only.
    expect(body).toContain('source.targetName !== drag.targetName')
    // Versioned CAS preview (writeSeq included), re-checked immediately
    // before the write so the switch restore wins.
    const writeAt = body.indexOf('await updateVectorPreviewCostumeCAS(')
    expect(writeAt).toBeGreaterThan(-1)
    const guardAt = body.lastIndexOf('vectorPathPointDrag.pointerId !== drag.pointerId', writeAt)
    expect(guardAt).toBeGreaterThan(-1)
  })

  it('selectCostume awaits the switch-cancel restore before refreshing', () => {
    const body = bodyOf('async function selectCostume(', 800)
    expect(body).toContain('await waitForVectorRotateCancel()')
  })

  it('subsequent edits still serialize behind the shared cancel promise', () => {
    // peek/current/undo/redo all await the same promise the switch cancel tracks.
    for (const fn of [
      'async function peekCostumeHistory',
      'async function currentSvgDocument',
      'async function undoAssetEdit',
      'async function redoAssetEdit',
    ]) {
      expect(bodyOf(fn, 1200)).toContain('vectorRotateCancelPromise')
    }
  })
})
