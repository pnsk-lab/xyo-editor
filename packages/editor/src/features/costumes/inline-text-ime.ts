/**
 * Inline-text IME guard helpers (both bitmap and vector share the overlay).
 *
 * Real Japanese IME behavior cannot be driven from headless CI (no OS IME in
 * the container), so the overlay defers to the IME whenever *any* composition
 * signal is present:
 * - `KeyboardEvent.isComposing` (Chromium sets it on the confirming Escape /
 *   Enter keydown),
 * - the `compositionstart`/`compositionend` window tracked by the textarea,
 * - legacy `keyCode`/`which === 229` (IME-processed key on Chrome/Edge/Safari).
 *
 * While deferred, the key keeps its native IME meaning: no commit, no blur,
 * no `preventDefault`, and no shortcut handling. Plain Escape still commits,
 * plain Enter still inserts a newline, outside click still commits, and
 * Undo/Redo stay untouched.
 */

export type InlineTextImeKeyState = {
  isComposing?: boolean
  keyCode?: number
  which?: number
}

/**
 * True when the keydown belongs to an active IME composition and must be
 * passed through to the IME instead of committing or running shortcuts.
 */
export function shouldDeferInlineTextKeyToIme(
  event: InlineTextImeKeyState,
  composing: boolean,
): boolean {
  if (event.isComposing) return true
  if (composing) return true
  const code = event.keyCode ?? event.which ?? 0
  if (code === 229) return true
  return false
}
