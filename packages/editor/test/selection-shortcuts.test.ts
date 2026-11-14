import { describe, expect, it } from 'bun:test'
import {
  isShortcutTypingTarget,
  isShortcutWithCtrlOrMeta,
  nextPasteOffset,
  pasteOffsetDelta,
  resolveBitmapCopyRect,
  resolveBitmapPasteRect,
  resolveCostumeShortcut,
  resolveSelectAllBitmap,
  resolveVectorCopyIndices,
  SELECTION_PASTE_STEP,
} from '../src/features/costumes/selection-shortcuts'

function opaqueImage(width: number, height: number, opaque: Array<[number, number]> = []) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y] of opaque) {
    const offset = (y * width + x) * 4 + 3
    data[offset] = 255
  }
  return { data, width, height }
}

describe('resolveCostumeShortcut', () => {
  it('mirrors scratch-paint deselect and delete keys', () => {
    expect(resolveCostumeShortcut({ key: 'Escape', ctrlOrMeta: false, shift: false })).toBe('deselect')
    expect(resolveCostumeShortcut({ key: 'Delete', ctrlOrMeta: false, shift: false })).toBe('delete')
    expect(resolveCostumeShortcut({ key: 'Backspace', ctrlOrMeta: false, shift: false })).toBe('delete')
  })

  it('maps undo/redo and group shortcuts with shift', () => {
    expect(resolveCostumeShortcut({ key: 'z', ctrlOrMeta: true, shift: false })).toBe('undo')
    expect(resolveCostumeShortcut({ key: 'Z', ctrlOrMeta: true, shift: true })).toBe('redo')
    expect(resolveCostumeShortcut({ key: 'g', ctrlOrMeta: true, shift: false })).toBe('group')
    expect(resolveCostumeShortcut({ key: 'G', ctrlOrMeta: true, shift: true })).toBe('ungroup')
  })

  it('redoes with Ctrl+Y like native Windows bindings', () => {
    expect(resolveCostumeShortcut({ key: 'y', ctrlOrMeta: true, shift: false })).toBe('redo')
    expect(resolveCostumeShortcut({ key: 'Y', ctrlOrMeta: true, shift: true })).toBe('redo')
    expect(resolveCostumeShortcut({ key: 'y', ctrlOrMeta: false, shift: false })).toBeUndefined()
  })

  it('ignores clipboard/select-all when Shift is held', () => {
    expect(resolveCostumeShortcut({ key: 'c', ctrlOrMeta: true, shift: true })).toBeUndefined()
    expect(resolveCostumeShortcut({ key: 'v', ctrlOrMeta: true, shift: true })).toBeUndefined()
    expect(resolveCostumeShortcut({ key: 'x', ctrlOrMeta: true, shift: true })).toBeUndefined()
    expect(resolveCostumeShortcut({ key: 'a', ctrlOrMeta: true, shift: true })).toBeUndefined()
  })

  it('ignores Delete/Backspace/Escape while Ctrl/Cmd is held', () => {
    expect(resolveCostumeShortcut({ key: 'Delete', ctrlOrMeta: true, shift: false })).toBeUndefined()
    expect(resolveCostumeShortcut({ key: 'Backspace', ctrlOrMeta: true, shift: false })).toBeUndefined()
    expect(resolveCostumeShortcut({ key: 'Escape', ctrlOrMeta: true, shift: false })).toBeUndefined()
  })

  it('flags Ctrl/Cmd letters that must never reach the stage runtime', () => {
    for (const key of ['z', 'y', 'g', 'c', 'x', 'v', 'a', 'Z', 'A']) {
      expect(isShortcutWithCtrlOrMeta(key)).toBe(true)
    }
    expect(isShortcutWithCtrlOrMeta('Enter')).toBe(false)
    expect(isShortcutWithCtrlOrMeta(' ')).toBe(false)
  })

  it('maps clipboard and select-all shortcuts', () => {
    expect(resolveCostumeShortcut({ key: 'c', ctrlOrMeta: true, shift: false })).toBe('copy')
    expect(resolveCostumeShortcut({ key: 'v', ctrlOrMeta: true, shift: false })).toBe('paste')
    expect(resolveCostumeShortcut({ key: 'x', ctrlOrMeta: true, shift: false })).toBe('cut')
    expect(resolveCostumeShortcut({ key: 'a', ctrlOrMeta: true, shift: false })).toBe('select-all')
  })

  it('ignores non-shortcut keys without modifiers', () => {
    expect(resolveCostumeShortcut({ key: 'c', ctrlOrMeta: false, shift: false })).toBeUndefined()
    expect(resolveCostumeShortcut({ key: 'a', ctrlOrMeta: false, shift: false })).toBeUndefined()
    expect(resolveCostumeShortcut({ key: 'Enter', ctrlOrMeta: false, shift: false })).toBeUndefined()
  })
})

describe('isShortcutTypingTarget', () => {
  it('blocks inputs, selects, textareas, and editable hosts', () => {
    expect(isShortcutTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isShortcutTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isShortcutTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isShortcutTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(
      isShortcutTypingTarget({
        tagName: 'DIV',
        isContentEditable: false,
        closest: () => ({}),
        getAttribute: () => null,
      }),
    ).toBe(true)
    expect(
      isShortcutTypingTarget({
        tagName: 'DIV',
        isContentEditable: false,
        closest: () => null,
        getAttribute: (name: string) => (name === 'role' ? 'textbox' : null),
      }),
    ).toBe(true)
  })

  it('blocks every contenteditable spelling, not just true/empty', () => {
    for (const value of ['true', 'TRUE', '', 'plaintext-only', 'PlainText-Only']) {
      expect(
        isShortcutTypingTarget({
          tagName: 'DIV',
          isContentEditable: false,
          closest: () => null,
          getAttribute: (name: string) => (name === 'contenteditable' ? value : null),
        }),
      ).toBe(true)
    }
    // Explicitly non-editable hosts stay shortcut-active.
    for (const value of ['false', 'inherit', null]) {
      expect(
        isShortcutTypingTarget({
          tagName: 'DIV',
          isContentEditable: false,
          closest: () => null,
          getAttribute: (name: string) => (name === 'contenteditable' ? value : null),
        }),
      ).toBe(false)
    }
  })

  it('allows canvas and button targets', () => {
    expect(
      isShortcutTypingTarget({
        tagName: 'CANVAS',
        isContentEditable: false,
        closest: () => null,
        getAttribute: () => null,
      }),
    ).toBe(false)
    expect(isShortcutTypingTarget(null)).toBe(false)
    expect(isShortcutTypingTarget(undefined)).toBe(false)
  })
})

describe('paste offset', () => {
  it('uses the scratch-style 10px step per paste', () => {
    expect(SELECTION_PASTE_STEP).toBe(10)
    expect(pasteOffsetDelta(1)).toEqual({ dx: 10, dy: 10 })
    expect(pasteOffsetDelta(2)).toEqual({ dx: 20, dy: 20 })
    expect(nextPasteOffset(1)).toBe(2)
  })

  it('keeps bitmap pastes inside the canvas', () => {
    expect(
      resolveBitmapPasteRect({ width: 100, height: 80 }, { width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }, 1),
    ).toEqual({ x: 15, y: 15, width: 10, height: 10 })
    expect(
      resolveBitmapPasteRect({ width: 100, height: 80 }, { width: 10, height: 10 }, { x: 95, y: 75, width: 10, height: 10 }, 2),
    ).toEqual({ x: 90, y: 70, width: 10, height: 10 })
  })

  it('anchors an oversized clipboard at the origin', () => {
    expect(
      resolveBitmapPasteRect({ width: 100, height: 80 }, { width: 200, height: 200 }, undefined, 1),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200 })
    expect(
      resolveBitmapPasteRect({ width: 100, height: 80 }, { width: 200, height: 10 }, { x: 50, y: 50, width: 200, height: 10 }, 3),
    ).toEqual({ x: 0, y: 70, width: 200, height: 10 })
  })
})

describe('resolveSelectAllBitmap', () => {
  it('trims to the opaque bounds like scratch-paint', () => {
    const image = opaqueImage(8, 8, [[2, 2], [3, 3]])
    expect(resolveSelectAllBitmap(image, { x: 0, y: 0, width: 8, height: 8 })).toEqual({
      x: 2,
      y: 2,
      width: 2,
      height: 2,
    })
  })

  it('leaves an empty canvas without a selection', () => {
    const image = opaqueImage(4, 4)
    expect(resolveSelectAllBitmap(image, { x: 0, y: 0, width: 4, height: 4 })).toBeUndefined()
  })
})

describe('empty-selection copy fallback (scratch-paint copy-paste-hoc)', () => {
  it('copies every vector object when nothing is selected', () => {
    expect(resolveVectorCopyIndices([], 3)).toEqual([0, 1, 2])
    // Out-of-range or invalid entries never count as a selection.
    expect(resolveVectorCopyIndices([-1, 99], 2)).toEqual([0, 1])
    expect(resolveVectorCopyIndices([], 0)).toEqual([])
  })

  it('keeps an explicit vector selection instead of copying everything', () => {
    expect(resolveVectorCopyIndices([2, 0, 2], 3)).toEqual([0, 2])
    expect(resolveVectorCopyIndices([1], 3)).toEqual([1])
  })

  it('copies the trimmed opaque bitmap when nothing is selected', () => {
    const image = opaqueImage(8, 8, [[2, 2], [5, 4]])
    expect(resolveBitmapCopyRect(undefined, image, { x: 0, y: 0, width: 8, height: 8 })).toEqual({
      x: 2,
      y: 2,
      width: 4,
      height: 3,
    })
  })

  it('copies nothing on an empty canvas so the clipboard stays untouched', () => {
    const image = opaqueImage(4, 4)
    expect(resolveBitmapCopyRect(undefined, image, { x: 0, y: 0, width: 4, height: 4 })).toBeUndefined()
  })

  it('prefers an explicit bitmap selection over the whole-canvas fallback', () => {
    const image = opaqueImage(8, 8, [[0, 0]])
    const selection = { x: 1, y: 1, width: 2, height: 2 }
    expect(resolveBitmapCopyRect(selection, image, { x: 0, y: 0, width: 8, height: 8 })).toBe(selection)
    // A degenerate selection falls back exactly like no selection.
    expect(
      resolveBitmapCopyRect({ x: 1, y: 1, width: 0, height: 2 }, image, { x: 0, y: 0, width: 8, height: 8 }),
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})
