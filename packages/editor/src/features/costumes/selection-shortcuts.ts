import { trimBitmapRectToOpaque } from './bitmap-selection'

export type CostumeShortcutAction =
  | 'deselect'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'paste'
  | 'cut'
  | 'select-all'
  | 'group'
  | 'ungroup'

export type CostumeShortcutKey = {
  key: string
  ctrlOrMeta: boolean
  shift: boolean
}

/**
 * Scratch-paint (`keyboard-shortcuts-hoc.jsx`) ignores shortcuts while a text
 * input has focus and while a text tool is being edited. The current editor
 * keeps vector text in a plain `<input>`, so blocking input-like targets (and
 * contenteditable hosts) prevents accidental selection/clipboard changes.
 */
export function isShortcutTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as {
    tagName?: unknown
    nodeName?: unknown
    isContentEditable?: unknown
    closest?: unknown
    getAttribute?: unknown
  }
  const tag = typeof element.tagName === 'string'
    ? element.tagName.toLowerCase()
    : typeof element.nodeName === 'string'
      ? element.nodeName.toLowerCase()
      : ''
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (element.isContentEditable === true) return true
  if (typeof element.closest === 'function') {
    try {
      if ((element.closest as (selector: string) => unknown).call(element, 'input,textarea,select,[contenteditable="true"],[contenteditable=""]')) return true
    } catch {
      // Ignore selector errors from test doubles.
    }
  }
  if (typeof element.getAttribute === 'function') {
    try {
      const role = (element.getAttribute as (name: string) => unknown).call(element, 'role')
      const contentEditable = (element.getAttribute as (name: string) => unknown).call(element, 'contenteditable')
      if (role === 'textbox') return true
      // contenteditable="" / "true" / "plaintext-only" (any case) all make
      // the host editable; only "false"/"inherit" (or missing) keep it plain.
      // Scratch-paint blocks shortcuts while any text is being edited, so be
      // permissive here rather than enumerating spellings.
      if (typeof contentEditable === 'string') {
        const value = contentEditable.toLowerCase()
        if (value !== 'false' && value !== 'inherit') return true
      }
    } catch {
      // Ignore accessor errors from test doubles.
    }
  }
  return false
}

/**
 * Map a key event to a costume shortcut action, mirroring
 * `keyboard-shortcuts-hoc.jsx` in scratch-paint:
 * Escape deselects, Delete removes, Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and
 * Ctrl/Cmd+Y redo, Ctrl/Cmd+G groups (Shift splits), Ctrl/Cmd+C/X/V handle
 * the clipboard, and Ctrl/Cmd+A selects all. Returns undefined when the key
 * is not a costume shortcut. Callers must still check the active tab/mode
 * before applying the action.
 *
 * Plain Delete/Backspace/Escape only apply without Ctrl/Cmd so word-wise
 * edits (e.g. Ctrl+Backspace) never wipe the canvas selection. Clipboard and
 * select-all shortcuts require no Shift so Ctrl+Shift+C (and friends) stay
 * free for future bindings instead of clobbering the clipboard.
 */
export function resolveCostumeShortcut(event: CostumeShortcutKey): CostumeShortcutAction | undefined {
  if (!event.ctrlOrMeta) {
    if (event.key === 'Escape') return 'deselect'
    if (event.key === 'Delete' || event.key === 'Backspace') return 'delete'
    return undefined
  }
  const lower = event.key.toLowerCase()
  if (lower === 'z') return event.shift ? 'redo' : 'undo'
  // Windows-style redo: Ctrl+Y (with or without Shift).
  if (lower === 'y') return 'redo'
  if (lower === 'g') return event.shift ? 'ungroup' : 'group'
  // Clipboard/select-all are exact Ctrl/Cmd+key matches (no Shift).
  if (event.shift) return undefined
  if (lower === 'c') return 'copy'
  if (lower === 'v') return 'paste'
  if (lower === 'x') return 'cut'
  if (lower === 'a') return 'select-all'
  return undefined
}

/**
 * Keys that must never leak to the stage runtime while Ctrl/Cmd is held.
 * Typing targets are checked before this; for any other focus, pressing one
 * of these is an app shortcut (or a no-op swallow), not a game key press.
 */
export function isShortcutWithCtrlOrMeta(key: string): boolean {
  const lower = key.toLowerCase()
  return lower === 'z' || lower === 'y' || lower === 'g' || lower === 'c' || lower === 'x' || lower === 'v' || lower === 'a'
}

export const SELECTION_PASTE_STEP = 10

export function pasteOffsetDelta(offset: number): { dx: number; dy: number } {
  return { dx: SELECTION_PASTE_STEP * offset, dy: SELECTION_PASTE_STEP * offset }
}

export function nextPasteOffset(offset: number): number {
  return offset + 1
}

export type BitmapImageLike = {
  data: Uint8ClampedArray
  width: number
  height: number
}

export type BitmapRect = { x: number; y: number; width: number; height: number }

/**
 * Scratch-paint's copy falls back to everything when nothing is selected
 * (`copy-paste-hoc.jsx`): bitmap copies the trimmed opaque raster, vector
 * copies every root item. Cut never uses this fallback — an empty cut is a
 * no-op that leaves the clipboard untouched (`keyboard-shortcuts-hoc.jsx`
 * only cuts when `getSelectedRootItems()` is non-empty).
 */
export function resolveVectorCopyIndices(selected: readonly number[], unitCount: number): number[] {
  const valid = [...new Set(selected)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < unitCount)
    .sort((a, b) => a - b)
  if (valid.length > 0) return valid
  const count = Number.isFinite(unitCount) ? Math.max(0, Math.floor(unitCount)) : 0
  return Array.from({ length: count }, (_, index) => index)
}

/**
 * Resolve the rect a bitmap copy reads: the explicit selection when one
 * exists, otherwise the whole canvas trimmed to its opaque bounds (or
 * undefined for an empty canvas, so callers keep the previous clipboard).
 */
export function resolveBitmapCopyRect(
  selection: BitmapRect | undefined,
  image: BitmapImageLike,
  full: BitmapRect,
): BitmapRect | undefined {
  if (selection && selection.width > 0 && selection.height > 0) return selection
  return trimBitmapRectToOpaque(image, full) ?? undefined
}

/**
 * Scratch-paint's bitmap select-all trims the whole raster to its opaque
 * bounds (`selectAllBitmap`). Return the trimmed rect, or undefined for an
 * empty canvas so callers can leave the selection cleared.
 */
export function resolveSelectAllBitmap(image: BitmapImageLike, full: BitmapRect): BitmapRect | undefined {
  return trimBitmapRectToOpaque(image, full) ?? undefined
}

/**
 * Clamp a pasted bitmap rect so it stays inside the canvas, keeping the
 * clipboard size and applying the shared paste offset. A clipboard larger
 * than the canvas cannot be staggered, so it anchors at the origin instead
 * of producing a negative offset.
 */
export function resolveBitmapPasteRect(
  canvas: { width: number; height: number },
  clipboard: { width: number; height: number },
  anchor: BitmapRect | undefined,
  offset: number,
): BitmapRect {
  const delta = pasteOffsetDelta(offset)
  const maxX = canvas.width - clipboard.width
  const maxY = canvas.height - clipboard.height
  const anchorX = Number.isFinite(anchor?.x) ? (anchor?.x ?? 0) : 0
  const anchorY = Number.isFinite(anchor?.y) ? (anchor?.y ?? 0) : 0
  const x = maxX <= 0 ? 0 : Math.max(0, Math.min(maxX, Math.round(anchorX + delta.dx)))
  const y = maxY <= 0 ? 0 : Math.max(0, Math.min(maxY, Math.round(anchorY + delta.dy)))
  return { x, y, width: clipboard.width, height: clipboard.height }
}
