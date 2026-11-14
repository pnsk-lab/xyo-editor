import { describe, expect, it } from 'bun:test'

/**
 * Bitmap pointercancel / lostpointercapture / Escape cancel parity.
 *
 * Vector gestures discard the local draft on interruption (no history, no
 * artwork write); bitmap used to commit the partial stroke through the
 * normal end path. This test pins the cancel path statically (source-only,
 * like bitmap-workspace-owner-gate.test.ts): no product behaviour change
 * beyond the guarded cancel, only gate presence.
 */

const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
const bitmapEditorSource = await Bun.file(
  new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url),
).text()

function bodyOf(source: string, fn: string, length = 6000): string {
  let start = source.indexOf(fn)
  if (start < 0) {
    // Async-aware fallback: `function X` also matches `async function X` and vice versa
    // (e.g. `clearCostumeSelection` grew `async` for the pending commit await).
    const alt = fn.startsWith('async ') ? fn.replace(/^async\s+/, '') : `async ${fn}`
    start = source.indexOf(alt)
  }
  if (start < 0) throw new Error(`Missing ${fn}`)
  // Non-function pins keep the narrow fixed window (block-local isolation).
  if (!fn.includes('function')) return source.slice(start, start + length)
  const rest = source.slice(start)
  // Next-function bounded slice: survive prepended pending-gate blocks that
  // push `cancelBitmapStroke`/`isBitmapPainting` beyond the stale 2500 window.
  const next = rest.slice(100).search(/\n\s*(?:async\s+)?function\s/)
  if (next < 0) return rest
  return rest.slice(0, 100 + next)
}

describe('bitmap interruption cancel (static)', () => {
  it('defines a snapshot cancel that restores without history and preserves the owner token', () => {
    expect(editorSource).toContain('function cancelBitmapStroke')
    const body = bodyOf(editorSource, 'function cancelBitmapStroke', 4000)
    expect(body).toContain('restoreBitmapPreviewBase')
    expect(body).toContain('bitmapStrokeOwner')
    expect(body).toContain('Bitmap edit cancelled')
    // Cancel never writes history or the VM.
    expect(body).not.toContain('saveBitmapCostume')
    expect(body).not.toContain('commitPaintHistory')
  })

  it('endBitmapPaint treats pointercancel/lostpointercapture as cancel, not commit', () => {
    const end = bodyOf(editorSource, 'async function endBitmapPaint', 2500)
    expect(end).toContain('pointercancel')
    expect(end).toContain('lostpointercapture')
    expect(end).toContain('cancelBitmapStroke')
  })

  it('floating scale/rotate ends cancel on interruption without history', () => {
    for (const fn of ['async function endBitmapFloatingScale', 'async function endBitmapFloatingRotate'] as const) {
      const body = bodyOf(editorSource, fn, 2500)
      expect(body).toContain('pointercancel')
      expect(body).toContain('lostpointercapture')
      expect(body).toContain('cancelBitmapFloatingDrag')
    }
    const helper = bodyOf(editorSource, 'function cancelBitmapFloatingDrag', 2500)
    expect(helper).toContain('isBitmapWorkspaceSettledFor')
    expect(helper).toContain('refuseStaleBitmapWorkspace')
    expect(helper).not.toContain('saveBitmapCostume')
  })

  it('Escape (deselect) cancels an active bitmap stroke and preserves the selection', () => {
    const clear = bodyOf(editorSource, 'function clearCostumeSelection', 2500)
    expect(clear).toContain('cancelBitmapStroke')
    expect(clear).toContain('isBitmapPainting')
  })

  it('target/costume switch drops every bitmap stroke token (no stale restore)', () => {
    const reset = bodyOf(editorSource, 'function resetCostumeEditorSelection', 6000)
    expect(reset).toContain('bitmapRotateDrag')
    expect(reset).toContain('bitmapStrokeOwner')
    expect(reset).toContain('bitmapShapePreviewDrawn')
    expect(reset).toContain('isBitmapPainting = false')
  })

  it('canvas interruption routes bitmap through the Editor cancel, not the commit path', () => {
    const up = bodyOf(bitmapEditorSource, 'function handleCanvasPointerUp', 5000)
    expect(up).toContain('pointercancel')
    expect(up).toContain('lostpointercapture')
    expect(up).toContain('discardCancelledVectorGesture')
    expect(up).toContain('handleCanvasMouseUp')
  })

  it('interrupted eyedropper picks never commit (pressed reset, no color write)', () => {
    const mouseUp = bodyOf(bitmapEditorSource, 'async function handleCanvasMouseUp', 2500)
    expect(mouseUp).toContain('pointercancel')
    expect(mouseUp).toContain('eyedropperPressed = false')
  })
})
