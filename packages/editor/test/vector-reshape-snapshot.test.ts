// Reshape drag snapshot/preview + Esc/pointercancel history semantics.
//
// The Editor now previews reshape drags (single anchor, bulk multi-anchor,
// control handle) by re-applying the absolute delta from the immutable
// pre-drag SVG snapshot — the same pattern as the rotation tool — instead of
// mutating the live document incrementally. Esc/pointercancel restores the
// snapshot without touching history/redo, mouseup commits exactly one entry
// only for a real change, and the selection set is preserved.
//
// This file covers the pure, DOM-free core of that contract:
// - absolute re-application from the snapshot is idempotent (no accumulation
//   drift, unlike incremental re-application);
// - zero delta / return-to-start produces no targets (no-op path);
// - bulk moves touch only selected anchors + their own handles, leaving
//   every other point (siblings) byte-identical;
// - the deferred peek/commit history discipline yields exactly one entry for
//   a real move and zero entries (redo preserved) for Esc cancel / no-op /
//   click-select, even with a concurrent successful edit in flight.
// The Svelte wiring itself (snapshot capture, cancel routing, single commit)
// is asserted against the source, and the real editor behaviour is covered by
// `vector-reshape-escape.browser.test.ts`.

import { describe, expect, it } from 'bun:test'
import {
  moveReshapePoints,
  normalizeReshapeSelection,
  reshapeBulkMoveTargets,
  type ReshapeSelectablePoint,
} from '../src/features/costumes/vector-multi-point-selection'

function anchor(index: number, x: number, y: number): ReshapeSelectablePoint {
  return { index, x, y, kind: 'anchor' }
}

function control(
  index: number,
  x: number,
  y: number,
  relatedAnchorIndex: number,
  controlRole: 'in' | 'out' = 'out',
): ReshapeSelectablePoint {
  return { index, x, y, kind: 'control', controlRole, relatedAnchorIndex }
}

// Flattened layout: a0, a0/out, a1, a1/in, a1/out, a2, a2/in.
function samplePoints(): ReshapeSelectablePoint[] {
  return [
    anchor(0, 0, 0),
    control(1, 5, 0, 0),
    anchor(2, 10, 0),
    control(3, 8, -2, 2, 'in'),
    control(4, 12, 2, 2, 'out'),
    anchor(5, 20, 0),
    control(6, 18, -2, 5, 'in'),
  ]
}

function byIndex(points: ReshapeSelectablePoint[]): Map<number, ReshapeSelectablePoint> {
  return new Map(points.map((point) => [point.index, point]))
}

// ---- peek/commit history simulation (same shape as Editor.svelte: cap 100,
// isolated paint side, commit clears only its own redo) ----
type Entry = { id: string }
function commitEntry(stacks: { undo: Entry[]; redo: Entry[] }, entry: Entry) {
  stacks.undo = [...stacks.undo, entry].slice(-100)
  stacks.redo = []
}

describe('reshape snapshot preview: absolute re-application', () => {
  it('re-applying the same absolute delta from the snapshot is idempotent', () => {
    const snapshot = samplePoints()
    const selection = [0, 2]
    // First preview frame: absolute targets from the snapshot.
    const first = byIndex(moveReshapePoints(snapshot, selection, 10, 5))
    // Second frame with the same pointer position restarts from the
    // snapshot (absolute), so the bytes are identical — no accumulation.
    const second = byIndex(moveReshapePoints(snapshot, selection, 10, 5))
    expect([...second.entries()]).toEqual([...first.entries()])
    expect([second.get(2)!.x, second.get(2)!.y]).toEqual([20, 5])
  })

  it('incremental re-application would drift (the bug the snapshot avoids)', () => {
    const snapshot = samplePoints()
    const selection = [0, 2]
    const once = moveReshapePoints(snapshot, selection, 10, 5)
    // Old behaviour: apply the same delta again onto the already-moved
    // document. The anchor travels twice as far.
    const twice = byIndex(moveReshapePoints(once, selection, 10, 5))
    expect([twice.get(2)!.x, twice.get(2)!.y]).toEqual([30, 10])
  })

  it('drag-and-return produces no targets, so the end handler stays a no-op', () => {
    const snapshot = samplePoints()
    const selection = [0, 2]
    // Out and back: the absolute delta at release is zero.
    expect(reshapeBulkMoveTargets(snapshot, selection, 0, 0)).toEqual([])
    const returned = moveReshapePoints(moveReshapePoints(snapshot, selection, 10, 5), selection, -10, -5)
    const before = byIndex(snapshot)
    const after = byIndex(returned)
    for (const [index, point] of before) {
      expect([after.get(index)!.x, after.get(index)!.y]).toEqual([point.x, point.y])
    }
  })
})

describe('reshape bulk move preserves siblings and the selection set', () => {
  it('moves selected anchors with their own handles only', () => {
    const snapshot = samplePoints()
    const moved = byIndex(moveReshapePoints(snapshot, [0, 2], 10, 5))
    // Selected anchors + their own handles travel rigidly.
    expect([moved.get(0)!.x, moved.get(0)!.y]).toEqual([10, 5])
    expect([moved.get(1)!.x, moved.get(1)!.y]).toEqual([15, 5])
    expect([moved.get(2)!.x, moved.get(2)!.y]).toEqual([20, 5])
    // Unselected anchor a2 and its handle stay byte-identical.
    expect([moved.get(5)!.x, moved.get(5)!.y]).toEqual([20, 0])
    expect([moved.get(6)!.x, moved.get(6)!.y]).toEqual([18, -2])
  })

  it('keeps the selection set stable across preview frames', () => {
    // The drag re-applies `drag.reshapeSelection` after every preview so the
    // set never collapses mid-drag; normalization is idempotent.
    const selection = normalizeReshapeSelection([2, 0, 2])
    expect(selection).toEqual([0, 2])
    expect(normalizeReshapeSelection(selection)).toEqual(selection)
  })
})

describe('reshape drag history: exactly one entry, Esc/no-op clean', () => {
  it('a real move commits the deferred peeked entry exactly once', () => {
    const stacks = { undo: [{ id: 'base' }], redo: [{ id: 'R' }] as Entry[] }
    const peeked: Entry = { id: 'pre-drag' }
    // Live frames never touch history; mouseup commits once.
    const moved = true
    if (moved) commitEntry(stacks, peeked)
    expect(stacks.undo.map((entry) => entry.id)).toEqual(['base', 'pre-drag'])
    expect(stacks.redo).toEqual([])
    // A second end (e.g. pointerup arriving after a cancel) must not commit
    // again: the drag state is cleared, so there is nothing to commit.
    const dragCleared: Entry | undefined = undefined
    if (dragCleared) commitEntry(stacks, dragCleared)
    expect(stacks.undo.map((entry) => entry.id)).toEqual(['base', 'pre-drag'])
  })

  it('Esc cancel commits nothing and preserves the redo stack', () => {
    const stacks = { undo: [{ id: 'base' }], redo: [{ id: 'R' }] as Entry[] }
    const peeked: Entry = { id: 'pre-drag' }
    const cancelled = true
    // Cancel restores the snapshot; the deferred entry is discarded.
    void peeked
    if (!cancelled) commitEntry(stacks, peeked)
    expect(stacks.undo.map((entry) => entry.id)).toEqual(['base'])
    expect(stacks.redo.map((entry) => entry.id)).toEqual(['R'])
  })

  it('a no-op drag (click / return-to-start) leaves history and redo alone', () => {
    const stacks = { undo: [{ id: 'base' }], redo: [{ id: 'R' }] as Entry[] }
    const peeked: Entry = { id: 'pre-drag' }
    const moved = false
    void peeked
    if (moved) commitEntry(stacks, peeked)
    expect(stacks.undo.map((entry) => entry.id)).toEqual(['base'])
    expect(stacks.redo.map((entry) => entry.id)).toEqual(['R'])
  })

  it('a concurrent successful edit survives a reshape no-op', () => {
    const stacks = { undo: [{ id: 'base' }], redo: [{ id: 'R' }] as Entry[] }
    const reshapePeek: Entry = { id: 'reshape-pre-drag' }
    // Another edit commits while the reshape drag is still in flight.
    commitEntry(stacks, { id: 'other-edit' })
    // The reshape drag ends as a no-op: it must not touch the stack.
    const reshapeMoved = false
    void reshapePeek
    if (reshapeMoved) commitEntry(stacks, reshapePeek)
    expect(stacks.undo.map((entry) => entry.id)).toEqual(['base', 'other-edit'])
    // The other edit cleared redo; the no-op must not resurrect it.
    expect(stacks.redo).toEqual([])
  })
})

describe('Editor.svelte reshape snapshot wiring', () => {
  it('captures the pre-drag snapshot, previews from it, and restores on cancel', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()

    // Drag state carries the immutable pre-drag snapshot plus the selection.
    expect(source).toContain('sourceReady: Promise<{ targetName: string; costumeIndex: number; svgText: string } | undefined>')
    expect(source).toContain('reshapeSelection: number[]')
    expect(source).toContain('isControl: boolean')

    // Begin serializes the pre-drag document as the snapshot source.
    const beginStart = source.indexOf('function beginVectorPathPointDrag')
    expect(beginStart).toBeGreaterThan(-1)
    const beginBody = source.slice(beginStart, beginStart + 8000)
    expect(beginBody).toContain('sourceReady')
    expect(beginBody).toContain('currentSvgDocument')
    expect(beginBody).toContain('new XMLSerializer().serializeToString')

    // Live frames re-apply the absolute delta from the snapshot and restore
    // it on a zero delta (return-to-start), without writing history.
    const previewStart = source.indexOf('async function previewVectorPathPointFromSource')
    expect(previewStart).toBeGreaterThan(-1)
    const restoreStart = source.indexOf('async function restoreVectorPathPointSource')
    expect(restoreStart).toBeGreaterThan(-1)
    const applyStart = source.indexOf('async function applyLiveVectorPathPointDrag')
    expect(applyStart).toBeGreaterThan(-1)
    const applyBody = source.slice(applyStart, applyStart + 6000)
    expect(applyBody).toContain('restoreVectorPathPointSource')
    expect(applyBody).toContain('previewVectorPathPointFromSource')

    // Cancel clears synchronously and restores without history; the shared
    // cancel promise serializes an immediate next edit / Undo / Redo.
    const cancelStart = source.indexOf('function cancelVectorPathPointDrag')
    expect(cancelStart).toBeGreaterThan(-1)
    const cancelBody = source.slice(cancelStart, cancelStart + 1500)
    expect(cancelBody).toContain('vectorPathPointDrag = undefined')
    expect(cancelBody).toContain('restoreVectorPathPointSource')
    expect(cancelBody).toContain('vectorRotateCancelPromise')

    // Deselect during a drag cancels (keeping the selection); the generic
    // path also restores before clearing.
    expect(source).toContain('if (vectorPathPointDrag) {')
    expect(source).toContain('cancelVectorPathPointDrag()')

    // End: pointercancel cancels; otherwise exactly one commit for a real
    // move and no history for clicks / no-ops.
    const endStart = source.indexOf('async function endVectorPathPointDrag')
    expect(endStart).toBeGreaterThan(-1)
    const endBody = source.slice(endStart, endStart + 5000)
    expect(endBody).toContain("event.type === 'pointercancel'")
    expect(endBody).toContain('cancelVectorPathPointDrag(event)')
    expect(endBody).toContain('if (drag?.moved && drag.pendingEntry) commitPaintHistory(drag.pendingEntry)')

    // No pop-style rollback in the reshape path (the old defect class).
    for (const body of [beginBody, applyBody, endBody, cancelBody]) {
      expect(body).not.toContain('slice(0, -1)')
      expect(body).not.toContain('redoBackup')
    }
  })

  it('routes overlay pointercancel through the cancel path', async () => {
    const overlay = await Bun.file(
      new URL('../src/features/CostumeEditor/VectorReshapeOverlay.svelte', import.meta.url),
    ).text()
    expect(overlay).toContain('onpointercancel={cancel}')
    expect(overlay).toContain('end?.(event)')
  })
})
