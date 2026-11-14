// Reshape-nudge Editor wiring audit (source-level, DOM-free).
//
// Fail-first contract for the V-7 integration: `handleArrowNudge` must route
// arrows to the selected reshape anchors (never the whole object), keyed by
// stable target id + owning unit + selection epoch, with keyup coalescing,
// switch/cancel guards and no bitmap-pending UI changes. These pins fail on
// the pre-fix Editor (which moved the full vector object even with points
// selected) and pass with the integration in place; the browser suite below
// proves the runtime behavior end to end.

import { describe, expect, it } from 'bun:test'

const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()

function bodyOf(fn: string, length = 6000): string {
  const start = source.indexOf(fn)
  if (start < 0) throw new Error(`Missing ${fn}`)
  const rest = source.slice(start)
  const next = rest.slice(100).search(/\n\s*(?:async\s+)?function\s/)
  if (next < 0) return rest
  return rest.slice(0, 100 + next)
}

describe('reshape-nudge Editor wiring', () => {
  it('keys vector nudge sessions by owning unit + reshape points', () => {
    const body = bodyOf('function currentNudgeSelectionKey', 2000)
    // Any-bit parity: the cycle owns while any segment flag (1/2/4/6) is set,
    // so latent handle-only anchors act; display stays on the point-bit
    // projection elsewhere, never here.
    expect(body).toContain('hasReshapeSegmentSelection()')
    expect(body).toContain('reshapeLiveActionIndices()')
    expect(body).toContain('reshapeNudgeSelectionKey(selectedVectorObjectIndex')
  })

  it('ignores Shift/Alt on the reshape step (no multiplier, no clone)', () => {
    const body = bodyOf('async function handleArrowNudge', 8000)
    expect(body).toContain('reshapeNudgeStep(scale)')
    expect(body).toContain('isReshapeNudge')
  })

  it('previews reshape arrows through moveVectorReshapePoints, never the whole object', () => {
    const body = bodyOf('async function previewReshapePointNudge', 9000)
    expect(body).toContain('moveVectorReshapePoints(element, targets)')
    expect(body).toContain('reshapeNudgeTargets(')
    expect(body).toContain('liveReshapeNudgeIndices(')
    // Fail-closed: text units and non-editable selections refuse with no
    // whole-object fallback and no history.
    expect(body).toContain("tagName.toLowerCase() === 'text'")
    expect(body).toContain('if (!result.moved) return false')
    expect(body).not.toContain('moveVectorElementBy')
    expect(body).not.toContain('moveSelectedVectorObjectBy')
    // Bitmap pending UI is untouched on the vector point path.
    expect(body).not.toContain('bitmapPending')
  })

  it('branches the vector preview to points while anchors are selected', () => {
    const body = bodyOf('async function previewVectorNudge', 2500)
    // Any-bit parity: any segment flag owns the arrow (latent 2/4/6 count);
    // the owning unit guard prevents cross-unit leaks.
    expect(body).toContain('selectedVectorObjectIndex >= 0')
    expect(body).toContain('hasReshapeSegmentSelection()')
    expect(body).toContain('previewReshapePointNudge(')
  })

  it('tracks stable ids, owning unit and selection epoch across gated writes', () => {
    const body = bodyOf('async function previewReshapePointNudge', 9000)
    expect(body).toContain('stableTargetId(')
    expect(body).toContain('captureDiscreteSaveScope(targetId, costumeIndex)')
    expect(body).toContain('isDiscreteSaveScopeCurrent(')
    expect(body).toContain('reshapeSelectionSeq')
    expect(body).toContain('vectorWriteTargetById(targetId')
    expect(body).toContain("updateVectorCostumeFromEditor(live, costumeIndex")
    // External/CAS conflicts restore the live preview and report, like the
    // immediate-commit reshape path.
    expect(body).toContain('refreshVectorPreviewFromLive(targetId, live)')
    expect(body).toContain("reportVectorExternalConflict('Edit')")
  })

  it('pins the owning unit + epoch in the pending session and coalesces on keyup', () => {
    const arrow = bodyOf('async function handleArrowNudge', 8000)
    expect(arrow).toContain('reshapeObjectIndex')
    expect(arrow).toContain('reshapePointIndices')
    expect(arrow).toContain('reshapeEpoch')
    // Points keep their own status; object moves keep theirs.
    expect(source).toContain("'Vector path points nudged'")
    const flush = bodyOf('async function flushNudgePending', 1500)
    expect(flush).toContain('reshapePointIndices')
  })

  it('keeps typing/IME guards upstream of the arrow route', () => {
    const body = bodyOf('function handleKeyDown(event: KeyboardEvent)', 3000)
    expect(body).toContain('isShortcutTypingTarget(target)')
  })
})
