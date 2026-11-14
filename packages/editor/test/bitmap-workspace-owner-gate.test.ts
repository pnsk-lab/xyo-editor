import { describe, expect, it } from 'bun:test'

/**
 * Bitmap workspace owner gate (stale-canvas cross-asset contamination guard).
 *
 * The live bitmap canvas belongs to exactly one asset at a time:
 * stable target id + costume index + asset key at load time, drawn by exactly
 * one load epoch (`bitmapCanvasReloadSerial`) and one canvas generation.
 * While a decode is in flight (`bitmapWorkspacePending`) the canvas is
 * unsettled and still shows the previous asset: every bitmap mutation, save,
 * paste, nudge, conversion, rotation, and async commit must refuse or safely
 * cancel instead of reading stale pixels as the newly selected asset.
 *
 * This test pins the gate statically (no browser): each bitmap entry point
 * must validate the owner token at entry and re-validate after every await
 * (decode/toBlob/loadAsset/peek/tick), with no write and no history entry on
 * mismatch. Source-only assertions (like asset-undo-scope-cap.test.ts):
 * no product behaviour change, only gate presence.
 */

const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()

function bodyOf(source: string, fn: string, length = 6000): string {
  let start = source.indexOf(fn)
  if (start < 0) {
    // Async-aware fallback: `function X` also matches `async function X` and vice versa.
    const alt = fn.startsWith('async ') ? fn.replace(/^async\s+/, '') : `async ${fn}`
    start = source.indexOf(alt)
  }
  if (start < 0) throw new Error(`Missing ${fn}`)
  // Non-function pins keep the narrow fixed window (block-local isolation).
  if (!fn.includes('function')) return source.slice(start, start + length)
  const rest = source.slice(start)
  // Next-function bounded slice: survive prepended pending-gate blocks that
  // push guards beyond stale fixed windows (e.g. 2500/3000). The length hint
  // is kept for compatibility but never truncates the own function body, so
  // toContain pins stay stable while not.toContain still sees only this function.
  const next = rest.slice(100).search(/\n\s*(?:async\s+)?function\s/)
  if (next < 0) return rest
  return rest.slice(0, 100 + next)
}

describe('bitmap workspace owner gate (static)', () => {
  it('defines an explicit owner token (targetId + costume identity + load epoch + generation)', () => {
    expect(editorSource).toContain('bitmapWorkspaceOwner')
    expect(editorSource).toContain('bitmapWorkspacePending')
    expect(editorSource).toContain('bitmapWorkspaceGeneration')
    expect(editorSource).toContain('bitmapCanvasReloadSerial')
    expect(editorSource).toContain('isBitmapWorkspaceSettledFor')
    expect(editorSource).toContain('refuseStaleBitmapWorkspace')
    // Owner key binds the stable target id and the costume slot.
    expect(editorSource).toContain('targetId: stableTargetId')
  })

  it('target/costume switch invalidates the canvas: load tracks pending and commits owner only on settled draw', () => {
    const load = bodyOf(editorSource, 'async function loadCostumeIntoBitmapCanvas', 9000)
    expect(load).toContain('bitmapWorkspacePending')
    expect(load).toContain('bitmapWorkspaceOwner')
    // Only the latest decode draws; stale decodes abort before drawing.
    expect(load).toContain('reloadSerial !== bitmapCanvasReloadSerial')
    // In-progress strokes are cancelled by a new load.
    expect(load).toContain('bitmapStrokeOwner = undefined')
  })

  it('brush entry/paint/commit validates the stroke owner (switch mid-stroke cancels)', () => {
    const begin = bodyOf(editorSource, 'function beginBitmapPaint', 2500)
    expect(begin).toContain('isBitmapWorkspaceSettledFor')
    expect(begin).toContain('bitmapStrokeOwner')
    const paint = bodyOf(editorSource, 'function paintBitmap', 3000)
    expect(paint).toContain('bitmapStrokeOwner')
    expect(paint).toContain('refuseStaleBitmapWorkspace')
    const end = bodyOf(editorSource, 'async function endBitmapPaint', 9000)
    expect(end).toContain('bitmapStrokeOwner')
    expect(end).toContain('refuseStaleBitmapWorkspace')
  })

  it('floating selection (move/scale/rotate) refuses on unsettled canvas and re-validates before commit', () => {
    for (const fn of [
      'function beginBitmapFloatingScale',
      'function beginBitmapFloatingRotate',
      'async function endBitmapFloatingScale',
      'async function endBitmapFloatingRotate',
    ] as const) {
      const body = bodyOf(editorSource, fn, 2500)
      expect(body).toContain('isBitmapWorkspaceSettledFor')
    }
  })

  it('save path captures the token and re-validates after every await (cancel/rotate/toBlob/noop/peek/write)', () => {
    const save = bodyOf(editorSource, 'async function saveBitmapCostume', 9000)
    expect(save).toContain('isBitmapWorkspaceSettledFor')
    expect(save).toContain('entrySerial')
    expect(save).toContain('entryRevision')
    expect(save).toContain('entryScopeKey')
    // Wait windows that must re-validate: rotate-cancel, toBlob build, noop probe, history peek.
    expect(save).toContain('vectorRotateCancelPromise')
    expect(save).toContain('buildCroppedBitmapSave')
    expect(save).toContain('storedBitmapHasOpaque')
    expect(save).toContain('peekCostumeHistory')
    expect(save).toContain('commitPaintHistory')
    // Stale saves never write without history.
    expect(save).toContain('refuseStaleBitmapWorkspace')
    const build = bodyOf(editorSource, 'async function buildCroppedBitmapSave', 6000)
    expect(build).toContain('BITMAP_SAVE_STALE')
    // PNG encode rides the fail-closed helper (null/throwing toBlob never
    // throws and empty encodes refuse instead of writing transparent bytes).
    expect(build).toContain('encodeCanvasToPngBlob')
    const write = bodyOf(editorSource, 'async function writeCroppedBitmapSave', 2500)
    expect(write).toContain('isBitmapWorkspaceSettledFor')
  })

  it('toBlob encode windows abort on switch/load (no stale bytes into the new asset)', () => {
    const build = bodyOf(editorSource, 'async function buildCroppedBitmapSave', 6000)
    // Pre-read gate + post-encode gate around the async PNG encode.
    expect(build).toContain('isBitmapWorkspaceSettledFor')
    expect(build).toContain('BITMAP_SAVE_STALE')
    const toBitmap = bodyOf(editorSource, 'async function convertCurrentCostumeToBitmap', 8000)
    // PNG encode rides the fail-closed helper; the stale-write guards after
    // the encode window (scope + selection re-validation) stay pinned.
    expect(toBitmap).toContain('encodeCanvasToPngBlob')
    expect(toBitmap).toContain('paintScopeKey')
  })

  it('copy refuses on stale canvas (clipboard source stays clean); paste requires a settled destination', () => {
    const copy = bodyOf(editorSource, 'async function copyBitmapSelection', 2500)
    expect(copy).toContain('isBitmapWorkspaceSettledFor')
    const paste = bodyOf(editorSource, 'async function pasteBitmapSelection', 2500)
    expect(paste).toContain('isBitmapWorkspaceSettledFor')
    const pasteCross = bodyOf(editorSource, 'async function pasteVectorClipboardAsBitmap', 9000)
    expect(pasteCross).toContain('isBitmapWorkspaceSettledFor')
  })

  it('nudge validates the pending asset before moving ink and refuses new sessions while unsettled', () => {
    const preview = bodyOf(editorSource, 'async function previewBitmapNudge', 4000)
    expect(preview).toContain('isBitmapWorkspaceSettledFor')
    const arrow = bodyOf(editorSource, 'async function handleArrowNudge', 6000)
    expect(arrow).toContain('isBitmapWorkspaceSettledFor')
  })

  it('SVG conversion reads only a settled canvas and re-validates after async decode/encode', () => {
    const toVector = bodyOf(editorSource, 'async function convertCurrentCostumeToVector', 8000)
    expect(toVector).toContain('isBitmapWorkspaceSettledFor')
    expect(toVector).toContain('storedBitmapDimensions')
    expect(toVector).toContain('bitmapTrimmedDataUrl')
    expect(toVector).toContain('paintScopeKey')
  })

  it('rotation (selection + whole canvas + center) never applies across assets', () => {
    const flip = bodyOf(editorSource, 'async function flipBitmap', 1500)
    expect(flip).toContain('isBitmapWorkspaceSettledFor')
    const rotate = bodyOf(editorSource, 'async function rotateBitmap', 1500)
    expect(rotate).toContain('isBitmapWorkspaceSettledFor')
    const centerEnd = bodyOf(editorSource, 'async function endRotationCenterDrag', 2500)
    expect(centerEnd).toContain('drag.targetId')
    expect(centerEnd).toContain('refuseStaleBitmapWorkspace')
  })

  it('undo/redo drops cross-switch completions (no pop, no redo pollution, no restore into the new asset)', () => {
    const undo = bodyOf(editorSource, 'async function undoHistorySide', 6000)
    expect(undo).toContain('entryScopeBefore')
    expect(undo).toContain('liveTop !== entry')
    expect(undo).toContain('historyGuardOf')
    const redo = bodyOf(editorSource, 'async function redoHistorySide', 6000)
    expect(redo).toContain('entryScopeBefore')
    expect(redo).toContain('liveTop !== entry')
    const restore = bodyOf(editorSource, 'async function restoreHistoryEntry', 2500)
    expect(restore).toContain(`return 'scope changed'`)
  })

  it('pending bitmap destination disables destructive UI with explicit loading (no enabled Paste that safe-refuses)', async () => {
    const bitmapEditorSource = await Bun.file(new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url)).text()
    // Editor mirrors the owner gate for disabled/loading display only.
    expect(editorSource).toContain('bitmapDestinationBusy')
    expect(editorSource).toContain('bitmapDestinationLocked')
    // Loading vs stale/error branches stay distinct for status/accessibility.
    expect(editorSource).toContain(`status = 'Loading bitmap…'`)
    // Toolbar + legacy paste stay disabled while the bitmap destination is
    // unsettled; vector mode and clipboard emptiness stay independent branches.
    expect(bitmapEditorSource).toContain('bitmapDestructiveDisabled')
    expect(bitmapEditorSource).toContain('bitmapWorkspaceBusy')
    expect(bitmapEditorSource).toContain('bitmapToolbarLocked')
    expect(bitmapEditorSource).toContain('pasteSelectionDisabled')
    expect(bitmapEditorSource).toContain(`costumeEditMode === 'bitmap' && bitmapDestructiveDisabled`)
    // Explicit loading display is accessible (role=status + test ids).
    expect(bitmapEditorSource).toContain('bitmap-workspace-loading')
    expect(bitmapEditorSource).toContain('role="status"')
    expect(bitmapEditorSource).toContain('Loading bitmap…')
    // Save/convert/delete/flip/rotate join paste in the bitmap lock (vector
    // clipboard buttons never lock on the bitmap workspace).
    expect(bitmapEditorSource).toContain('save-bitmap-costume')
    expect(bitmapEditorSource).toContain('disabled={bitmapToolbarLocked}')
    // Legacy panel mirrors the toolbar gating.
    expect(editorSource).toContain('legacy-paste-costume-selection')
    expect(editorSource).toContain('bitmapDestinationLocked')
  })
})
