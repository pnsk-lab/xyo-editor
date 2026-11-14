import { describe, expect, it } from 'bun:test'

// Vector rotate interruption cancel wiring (static, DOM-free).
//
// The drag-race gate observed `pointercancel` on the rotate handle as a
// no-op with the subsequent pointerup committing the mid-rotation: Scratch
// events / touch (pointercancel), and this repo's bitmap / point / leaf
// paths all treat pointercancel/lostpointercapture as cancel (exact
// snapshot+metadata restore, history/redo untouched). The rotate handle is
// the outlier and must match that parity; a normal pointerup's implicit
// lostpointercapture auto-loss must still commit (committing guard), and
// target switch / structure barrier / exception must not undo a normal
// commit.

const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
const bitmapEditorSource = await Bun.file(
  new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url),
).text()

function bodyOf(source: string, fn: string, length = 6000): string {
  const start = source.indexOf(fn)
  if (start < 0) throw new Error(`Missing ${fn}`)
  return source.slice(start, start + length)
}

describe('vector rotate interruption cancel (static)', () => {
  it('endVectorObjectRotate routes pointercancel/lostpointercapture to cancel, not commit', () => {
    const body = bodyOf(editorSource, 'async function endVectorObjectRotate', 2500)
    expect(body).toContain('pointercancel')
    expect(body).toContain('lostpointercapture')
    expect(body).toContain('cancelVectorRotateDrag')
    // Cancel path returns before claiming the commit.
    const cancelAt = body.indexOf('cancelVectorRotateDrag')
    const claimAt = body.indexOf('vectorRotateDrag.committing = true')
    expect(cancelAt).toBeGreaterThanOrEqual(0)
    expect(claimAt).toBeGreaterThan(cancelAt)
  })

  it('cancelVectorRotateDrag guards the pointerup commit and restores exact bytes+metadata', () => {
    const body = bodyOf(editorSource, 'function cancelVectorRotateDrag', 2500)
    // Wrong-pointer events never cancel a live drag.
    expect(body).toContain('pointerId')
    // A pointerup-claimed commit owns the gesture: trailing auto-loss refuses.
    expect(body).toContain('committing')
    // Synchronous retire so late previews skip.
    expect(body).toContain('vectorRotateDrag = undefined')
    expect(body).toContain('cancelVectorWriteGesture')
    // Barrier restore as the final write of the gesture.
    expect(body).toContain('restoreVectorRotateSource')
    expect(body).toContain('vectorRotateCancelPromise')
    // Cancel itself never writes history (redo must survive).
    expect(body).not.toContain('commitPaintHistory')
  })

  it('rotate restore goes through the exact snapshot path (bytes + metadata identical)', () => {
    const body = bodyOf(editorSource, 'async function restoreVectorRotateSource', 3000)
    expect(body).toContain('await drag.sourceReady')
    expect(body).toContain('await restoreVectorSnapshotExact(target, source.costumeIndex, source.svgText, drag)')
    const exact = bodyOf(editorSource, 'async function restoreVectorSnapshotExact', 8000)
    // Exact path prefers the raw peeked history entry (bytes + meta).
    expect(exact).toContain('pendingEntry')
    expect(exact).toContain('historyReady')
    expect(exact).toContain('new Uint8Array(bytes')
    // Barrier restore (versioned CAS, writeSeq included).
    expect(exact).toMatch(/'restore'|"restore"|kind.*restore/i)
    expect(exact).toMatch(/writeSeq|vectorCasExpectedOf/)
  })

  it('both rotate handles route interruption to the Editor end (no noop)', () => {
    for (const testId of ['vector-rotate-handle', 'vector-rotate-handle-multi'] as const) {
      const at = bitmapEditorSource.indexOf(`data-testid="${testId}"`)
      if (at < 0) throw new Error(`Missing ${testId}`)
      const body = bitmapEditorSource.slice(at, at + 2500)
      expect(body).toContain('onpointercancel')
      expect(body).toContain('onlostpointercapture')
      expect(body).toContain('endVectorObjectRotate')
      expect(body).not.toContain('onpointercancel={() => undefined}')
    }
  })

  it('normal pointerup still claims committing before the first await (auto-loss noop)', () => {
    const body = bodyOf(editorSource, 'async function endVectorObjectRotate', 6000)
    // Claim is synchronous: the browser queues the implicit auto-loss right
    // after this pointerup task while the commit still awaits.
    expect(body).toContain('vectorRotateDrag.committing = true')
    expect(body).toContain('await applyLiveVectorRotate')
    const claimAt = body.indexOf('vectorRotateDrag.committing = true')
    const awaitAt = body.indexOf('await applyLiveVectorRotate')
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(awaitAt).toBeGreaterThan(claimAt)
    // Only a real final delta commits history (no empty Undo, redo kept).
    expect(body).toContain('commitPaintHistory')
    expect(body).toContain('isRotationNoop')
  })

  it('target/costume switch restores the old rotate snapshot to the old slot only (no new-asset write)', () => {
    const start = editorSource.indexOf('async function restoreVectorRotateSourceForSelectionSwitch')
    if (start < 0) throw new Error('Missing restoreVectorRotateSourceForSelectionSwitch')
    const rest = editorSource.slice(start)
    const nextFn = rest.slice(100).search(/\n\s*(?:async )?function\s/)
    const body = nextFn < 0 ? rest : rest.slice(0, 100 + nextFn)
    expect(body).toContain('vectorWriteTargetById(drag.targetId, source.targetName)')
    expect(body).toContain('await restoreVectorSnapshotExact(target, source.costumeIndex, source.svgText, drag)')
    for (const forbidden of [
      'vectorObjects =',
      'commitPaintHistory',
      'refreshCostumePreview',
    ]) {
      expect(body).not.toContain(forbidden)
    }
  })
})
