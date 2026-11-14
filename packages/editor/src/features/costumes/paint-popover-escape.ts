/**
 * Paint popover Escape ordering (compact toolbar parity).
 *
 * Product bug fixed here: while a Fill/Outline popover is open, a single
 * plain Escape with focus on the swatch trigger (a `button`, not a typing
 * target) used to run the Editor window-capture deselect *before* the
 * popover bubble-close, destroying the selection. The same key with focus in
 * a popover `input` only closed the dialog (the Editor typing-target guard
 * returned early), so the behavior was inconsistent and destructive.
 *
 * Fixed ordering: one plain Escape always closes the active popover first
 * and retains the selection; the *next* Escape runs the normal deselect.
 *
 * Priority for a plain Escape inside the costume editor scope:
 * 1. IME composition defers (the key belongs to the IME, no close/deselect).
 * 2. An open inline-text draft owns the key (commit, no popover/deselect).
 * 3. An armed eyedropper cancels (already one-key: dialog + overlay together).
 * 4. An open Fill/Outline popover closes (retain selection, stop the key).
 * 5. Otherwise the normal deselect path runs.
 *
 * All DOM checks are scoped to a per-editor root node so two simultaneous
 * Editor instances never cross-cancel each other. Callers pass the root that
 * owns their state; helpers never query `document` globally.
 */

export type PopoverEscapeKey = {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
};

export type StylePopoverKind = 'fill' | 'stroke';

/** Plain Escape only: modifiers (Ctrl/Cmd/Alt) never trigger popover/deselect. */
export function isPlainEscapeKey(event: PopoverEscapeKey): boolean {
  if (!event || event.key !== 'Escape') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return true;
}

/**
 * True while an IME owns the keystroke: `isComposing`, the tracked
 * composition window, or legacy `keyCode/which === 229`. While true the key
 * keeps its native IME meaning (no popover close, no deselect, no commit).
 */
export function shouldDeferPopoverEscapeToIme(
  event: PopoverEscapeKey,
  composing: boolean,
): boolean {
  if (!event) return false;
  if (event.isComposing) return true;
  if (composing) return true;
  const code = event.keyCode ?? event.which ?? 0;
  if (code === 229) return true;
  return false;
}

function asElement(target: unknown): Element | null {
  if (!target || typeof target !== 'object') return null;
  if (typeof (target as Element).closest === 'function') return target as Element;
  return null;
}

/** True when the event target lives inside the inline-text draft overlay. */
export function isPopoverEscapeInTextDraft(target: unknown): boolean {
  const element = asElement(target);
  if (!element) return false;
  try {
    return Boolean(element.closest?.('[data-inline-text-editor]'));
  } catch {
    return false;
  }
}

/**
 * Closest per-editor root for a node (`[data-editor-root]` set by
 * `Editor.svelte`). Returns null outside any editor (body focus, etc.).
 */
export function editorRootFor(node: unknown): Element | null {
  const element = asElement(node);
  if (!element) return null;
  try {
    if (typeof element.closest !== 'function') return null;
    return element.closest('[data-editor-root]');
  } catch {
    return null;
  }
}

/** True when `target` is inside `root` (same editor instance). */
export function isEventInEditorScope(root: Element | null | undefined, target: unknown): boolean {
  if (!root || !target) return false;
  try {
    return root.contains(target as Node);
  } catch {
    return false;
  }
}

/**
 * True when this editor scope holds an open inline-text draft. Scoped to
 * `root` so a draft in editor A never blocks editor B.
 */
export function hasTextDraftInScope(root: Element | ParentNode | null | undefined): boolean {
  if (!root) return false;
  try {
    return Boolean((root as ParentNode).querySelector?.('[data-inline-text-editor]'));
  } catch {
    return false;
  }
}

/**
 * True when this editor scope holds an open Fill/Outline popover. Prefers
 * the explicit component state (`openKind !== null`); the DOM hook
 * (`[data-paint-popover-open="true"]`) covers the window-capture path where
 * only the node is handy. Scoped query only — never `document`.
 */
export function hasOpenPopoverInScope(
  root: Element | ParentNode | null | undefined,
  openKind: StylePopoverKind | null | undefined,
): boolean {
  if (openKind === 'fill' || openKind === 'stroke') return true;
  if (!root) return false;
  try {
    return Boolean((root as ParentNode).querySelector?.('[data-paint-popover-open="true"]'));
  } catch {
    return false;
  }
}

/**
 * Should this plain Escape close the popover first (retain selection)?
 * All guards are scope-aware: cross-editor keys (target outside `root`),
 * IME composition, and an open text draft all defer.
 */
export function shouldClosePopoverOnEscape(
  root: Element | ParentNode | null | undefined,
  target: unknown,
  event: PopoverEscapeKey,
  openKind: StylePopoverKind | null | undefined,
  options?: { composing?: boolean },
): boolean {
  if (!isPlainEscapeKey(event)) return false;
  if (shouldDeferPopoverEscapeToIme(event, options?.composing === true)) return false;
  if (isPopoverEscapeInTextDraft(target)) return false;
  const scope = root as Element | null | undefined;
  if (scope && target && !isEventInEditorScope(scope, target)) return false;
  if (hasTextDraftInScope(scope)) return false;
  return hasOpenPopoverInScope(scope, openKind);
}
