import { describe, expect, it } from 'bun:test'
import {
  isBitmapBrushSizeVisible,
  isBitmapStrokeControlsVisible,
  type BitmapToolbarTool,
} from '../src/features/costumes/paint-toolbar-sizes'

// UI-1: bitmap toolbar visibility truth table (reference `paint-editor.jsx`
// bitmap branch + `mode-tools.jsx` per-tool branches, no code copied).
// - bitmap never shows stroke/outline controls (vector-only);
// - the shared brush/thickness slider shows for brush/line always and for
//   rect/oval only while outlined (filled hides it). Select/fill/text/eraser
//   never show it (eraser has its own size control).
describe('bitmap toolbar visibility (UI-1)', () => {
  it('hides stroke controls in bitmap mode, shows them in vector mode', () => {
    expect(isBitmapStrokeControlsVisible('bitmap')).toBe(false)
    expect(isBitmapStrokeControlsVisible('vector')).toBe(true)
  })

  it('shows the brush size slider for brush and line regardless of shape mode', () => {
    for (const tool of ['brush', 'line'] as const) {
      expect(isBitmapBrushSizeVisible(tool, 'filled')).toBe(true)
      expect(isBitmapBrushSizeVisible(tool, 'outlined')).toBe(true)
    }
  })

  it('shows the brush size slider for rect/oval only while outlined', () => {
    for (const tool of ['rect', 'oval'] as const) {
      expect(isBitmapBrushSizeVisible(tool, 'filled')).toBe(false)
      expect(isBitmapBrushSizeVisible(tool, 'outlined')).toBe(true)
    }
  })

  it('hides the brush size slider for select/fill/text/eraser', () => {
    for (const tool of ['select', 'fill', 'text', 'eraser'] as BitmapToolbarTool[]) {
      expect(isBitmapBrushSizeVisible(tool, 'filled')).toBe(false)
      expect(isBitmapBrushSizeVisible(tool, 'outlined')).toBe(false)
    }
  })
})
