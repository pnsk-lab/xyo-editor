import { describe, expect, it } from 'bun:test'

/**
 * Locks the inline-text wiring contract without a browser:
 * - BitmapEditor owns the focused overlay (commit/cancel, font controls) and
 *   routes text-tool clicks to it instead of stamping immediately.
 * - Editor.svelte owns history + SVG/canvas writes via the commit callbacks.
 */
describe('inline text wiring', () => {
  it('BitmapEditor renders a focused inline editor with commit and cancel', async () => {
    const source = await Bun.file(
      new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url),
    ).text()
    expect(source).toContain('data-inline-text-editor')
    expect(source).toContain('aria-label="Commit text"')
    // The explicit cancel button stays; Escape commits per Scratch parity.
    expect(source).toContain('aria-label="Cancel text editing"')
    // Scratch TEXT_EDIT_MODE parity: Escape ends editing and commits, Enter
    // keeps its native textarea newline (no Enter-to-commit binding).
    const handlerStart = source.indexOf('function handleInlineTextKeydown')
    expect(handlerStart).toBeGreaterThan(-1)
    const handlerBody = source.slice(handlerStart, handlerStart + 1200)
    expect(handlerBody).toContain("event.key === 'Escape'")
    expect(handlerBody).toContain('commitInlineText')
    expect(handlerBody).not.toContain('cancelInlineText')
    expect(handlerBody).not.toContain("event.key === 'Enter'")
    // IME guard: mid-composition Escape/Enter defer to the IME (no commit).
    expect(handlerBody).toContain('shouldDeferInlineTextKeyToIme')
    expect(source).toContain('oncompositionstart')
    expect(source).toContain('oncompositionend')
    expect(source).toContain('inlineTextComposing')
    // Keystrokes must not leak into global costume shortcuts.
    expect(source).toContain('stopPropagation')
    // Font controls for both bitmap and vector text tools.
    expect(source).toContain('VECTOR_TEXT_FONT_OPTIONS')
    expect(source).toContain('aria-label="Text font size"')
    expect(source).toContain('aria-label="Vector font size"')
    // Unknown-stack display: an out-of-shortlist toolbar value renders as a
    // real option with its actual value (never a blank select).
    expect(source).toContain('isUnknownVectorTextFont')
    // Re-open sync: clicking an existing text item syncs the toolbar to its
    // effective font (display-only baseline) before the session opens.
    expect(source).toContain('prepareVectorInlineTextFont')
  })

  it('BitmapEditor routes text-tool clicks to the overlay, not immediate stamps', async () => {
    const source = await Bun.file(
      new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url),
    ).text()
    expect(source).toContain('openBitmapInlineText')
    expect(source).toContain('openVectorInlineText')
    // Vector text must re-open the clicked text item when there is one.
    expect(source).toContain('findVectorTextIndexAtPoint')
    // Pending drafts resolve before the next gesture so one click never
    // writes two history entries.
    expect(source).toContain('if (inlineText) {')
    // Clicking outside the overlay commits (Scratch: clicking away ends text
    // editing); clicks inside the overlay stay in the textarea.
    const pointerStart = source.indexOf('function handleCanvasPointerDown')
    expect(pointerStart).toBeGreaterThan(-1)
    const pointerBody = source.slice(pointerStart, pointerStart + 900)
    expect(pointerBody).toContain('data-inline-text-editor')
    expect(pointerBody).toContain('commitInlineText')
  })

  it('Editor.svelte commits inline text with exactly one history capture per confirm', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    expect(source).toContain('findVectorTextIndexAtPoint')
    expect(source).toContain('commitVectorInlineText')
    expect(source).toContain('commitBitmapInlineText')
    expect(source).toContain('resolveVectorTextCommit')
    // Bitmap commit funnels through the single-history save path. The RTL
    // per-line right-aligned draw adds branches, so the window covers the
    // whole commit body.
    const commitStart = source.indexOf('async function commitBitmapInlineText')
    expect(commitStart).toBeGreaterThan(-1)
    const commitBody = source.slice(commitStart, commitStart + 4500)
    expect(commitBody).toContain("await saveBitmapCostume('Bitmap text saved')")
    expect(commitBody).not.toContain('captureCostumeHistory')
    // History uses peek-then-commit (not capture-then-write): the pre-edit
    // entry is peeked once per vector commit, scope re-guarded, and committed
    // only on a live scope, so stale cross-target completions drop with no
    // DOM write and redo preserved.
    const vectorStart = source.indexOf('async function commitVectorInlineText')
    expect(vectorStart).toBeGreaterThan(-1)
    const vectorBody = source.slice(vectorStart, source.indexOf('async function commitBitmapInlineText'))
    const peeks = vectorBody.match(/await peekCostumeHistory\(selectedTarget, index\)/g) ?? []
    expect(peeks.length).toBe(1)
    expect(vectorBody).not.toContain('await captureCostumeHistory(selectedTarget, index)')
    expect(vectorBody.indexOf("if (kind === 'noop')")).toBeLessThan(vectorBody.indexOf('await peekCostumeHistory'))
    // Font-fallback guard: re-edits pass font options only for an explicit
    // session-owned change. The update path must not forward the raw toolbar
    // values unconditionally.
    expect(source).toContain('async function prepareVectorInlineTextFont')
    expect(source).toContain('vectorTextFontSessionBaseline')
    expect(vectorBody).toContain('fontSizeToApply')
    expect(vectorBody).toContain('fontFamilyToApply')
    expect(vectorBody).not.toContain('setVectorTextElementContent(target, session.text, { fontSize, fontFamily })')
  })

  it('Editor.svelte passes the text callbacks and font state to BitmapEditor', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    expect(source).toContain('{findVectorTextIndexAtPoint}')
    expect(source).toContain('{commitVectorInlineText}')
    expect(source).toContain('{commitBitmapInlineText}')
    expect(source).toContain('{prepareVectorInlineTextFont}')
    expect(source).toContain('bind:vectorTextFontSize')
    expect(source).toContain('bind:vectorTextFontFamily')
  })
})
