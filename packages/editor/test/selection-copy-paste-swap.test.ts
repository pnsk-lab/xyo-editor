import { describe, expect, it } from 'bun:test'
import { swapFillPaintState } from '../src/features/costumes/paint-colors'

// Unit + source-wiring tests for the selection-mode Copy/Paste buttons, the
// Bring-to-front button, and the first/second fill-color swap.
// The component needs a browser canvas to mount, so toolbar wiring is locked
// at the source level (the pattern bitmap-toolbar.test.ts uses) while the
// swap itself is a pure helper exercised directly here.

const bitmapEditorUrl = new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url)
const editorUrl = new URL('../src/Editor.svelte', import.meta.url)

async function bitmapEditorSource(): Promise<string> {
  return Bun.file(bitmapEditorUrl).text()
}

async function editorSource(): Promise<string> {
  return Bun.file(editorUrl).text()
}

function ariaBlock(source: string, label: string, radius = 8): string {
  const lines = source.split('\n')
  const index = lines.findIndex((candidate) => candidate.includes(`aria-label="${label}"`))
  if (index < 0) throw new Error(`Missing button: ${label}`)
  return lines.slice(Math.max(0, index - 2), index + radius + 1).join('\n')
}

// Overflow-aware lookup for actions that flow through `toolbarOverflowActions`
// (measured More menu, no duplication). Keeps the same guards/handlers, only
// the syntax moved from inline `aria-label=`/`data-testid=`/`disabled=`/
// `onclick` to the data entry (`label:`/`testId:`/`disabled:`/`onClick:`).
function overflowActionBlock(source: string, id: string): string {
  const lines = source.split('\n')
  const index = lines.findIndex((candidate) => candidate.includes(`id: '${id}'`))
  if (index < 0) throw new Error(`Missing toolbar overflow action: ${id}`)
  return lines.slice(Math.max(0, index - 1), index + 12).join('\n')
}

describe('swapFillPaintState exchanges colors with their transparent flags', () => {
  it('swaps hex values and transparent flags together', () => {
    expect(
      swapFillPaintState({
        primary: '#ff0000',
        primaryTransparent: true,
        secondary: '#0000ff',
        secondaryTransparent: false,
      }),
    ).toEqual({
      primary: '#0000ff',
      primaryTransparent: false,
      secondary: '#ff0000',
      secondaryTransparent: true,
    })
  })

  it('is an exact involution, including both-transparent and identical colors', () => {
    const bothTransparent = {
      primary: '#ffab19',
      primaryTransparent: true,
      secondary: '#ffffff',
      secondaryTransparent: true,
    }
    expect(swapFillPaintState(swapFillPaintState(bothTransparent))).toEqual(bothTransparent)
    const identical = {
      primary: '#123456',
      primaryTransparent: false,
      secondary: '#123456',
      secondaryTransparent: false,
    }
    expect(swapFillPaintState(swapFillPaintState(identical))).toEqual(identical)
    const mixed = {
      primary: '#111111',
      primaryTransparent: false,
      secondary: '#222222',
      secondaryTransparent: true,
    }
    expect(swapFillPaintState(swapFillPaintState(mixed))).toEqual(mixed)
  })
})

describe('BitmapEditor selection clipboard + front + swap wiring', () => {
  it('declares the mode-dispatching clipboard props and the front callback', async () => {
    const source = await bitmapEditorSource()
    expect(source).toContain('copyCostumeSelection?: () => void | Promise<void>')
    expect(source).toContain('pasteCostumeSelection?: () => void | Promise<void>')
    expect(source).toContain('bitmapFloatingActive?: boolean')
    expect(source).toContain('vectorClipboard?: string[]')
    expect(source).toContain('bringVectorSelectionToFront?: () => void | Promise<void>')
  })

  it('renders Copy/Paste selection buttons with test ids and conflict guards', async () => {
    const source = await bitmapEditorSource()
    // Copy/Paste/Delete lead the measured More menu as priority actions
    // (inline while they fit, in the menu when narrow): same guards,
    // handlers, and test ids, only the syntax moved from inline
    // `aria-label=`/`data-testid=`/`disabled=`/`onclick` to the data entry
    // (`label:`/`testId:`/`disabled:`/`onClick:`).
    const copy = overflowActionBlock(source, 'copy')
    expect(copy).toContain("label: 'Copy selection'")
    expect(copy).toContain("testId: 'copy-costume-selection'")
    expect(copy).toContain('copyCostumeSelection')
    expect(copy).toContain('disabled: copySelectionDisabled')
    expect(copy.includes('onClick')).toBe(true)

    const paste = overflowActionBlock(source, 'paste')
    expect(paste).toContain("label: 'Paste selection'")
    expect(paste).toContain("testId: 'paste-costume-selection'")
    expect(paste).toContain('pasteCostumeSelection')
    expect(paste).toContain('disabled: pasteSelectionDisabled')
    expect(paste.includes('onClick')).toBe(true)

    const del = ariaBlock(source, 'Delete selection')
    expect(del).toContain('data-testid="delete-editor-selection"')
    expect(del).toContain('deleteEditorSelection')
    expect(del.includes('onclick')).toBe(true)

    // Enablement lives in the derived guards so the template stays readable:
    // vector copy needs an object (bitmap copy falls back to the trimmed
    // raster), paste needs a clipboard entry for the active mode, the
    // eyedropper overlay and open text drafts win over both, and paste (not
    // read-only copy) stays disabled mid floating-drag.
    const guardStart = source.indexOf('let copySelectionDisabled')
    const guardEnd = source.indexOf('!pasteCostumeSelection', guardStart) + '!pasteCostumeSelection'.length
    const guards = source.slice(guardStart, guardEnd)
    expect(guards).toContain("costumeEditMode === 'vector'")
    expect(guards).toContain('vectorObjects.length')
    expect(guards).toContain('vectorClipboard')
    expect(guards).toContain('bitmapClipboard')
    expect(guards).toContain('eyedropperActive')
    expect(guards).toContain('inlineText')
    expect(guards).toContain('bitmapFloatingActive')
  })

  it('renders Bring to front with the same vector-selection guard as the other layer buttons', async () => {
    const source = await bitmapEditorSource()
    const front = overflowActionBlock(source, 'front')
    expect(front).toContain("label: 'Bring to front'")
    expect(front).toContain("testId: 'layer-order-front'")
    expect(front).toContain('bringVectorSelectionToFront')
    expect(front).toContain("costumeEditMode !== 'vector'")
    expect(front).toContain('selectedVectorObjectIndex')
    expect(front).toContain('selectedVectorObjectIndices')
    expect(front.includes('onClick')).toBe(true)
  })

  it('renders a swap button that exchanges colors with transparency', async () => {
    const source = await bitmapEditorSource()
    const swap = ariaBlock(source, 'Swap fill colors')
    expect(swap).toContain('data-testid="swap-fill-colors"')
    expect(swap).toContain('swapFillPaint')
    expect(source).toContain('swapFillPaintState')
    // Both the hex values and the transparent flags move together.
    expect(source).toContain('secondaryTransparent = next.secondaryTransparent')
    expect(source).toContain('fillTransparent = next.primaryTransparent')
  })
})

describe('Editor.svelte forwards the new paint UI', () => {
  it('defines a swap that moves transparency with the colors', async () => {
    const source = await editorSource()
    expect(source).toContain('function swapFillPaint()')
    expect(source).toContain('swapFillPaintState')
    expect(source).toContain('secondaryTransparent = next.secondaryTransparent')
  })

  it('passes the dispatching callbacks and clipboard state to BitmapEditor', async () => {
    const source = await editorSource()
    expect(source).toContain('{copyCostumeSelection}')
    expect(source).toContain('{pasteCostumeSelection}')
    expect(source).toContain('vectorClipboard={vectorClipboard}')
    // Pending transform drags (staged rect/oval move/scale) also own the
    // canvas preview: paste stays disabled until the drag settles, same as
    // the legacy floating drags.
    expect(source).toContain('bitmapFloatingActive={Boolean(bitmapMoveDrag) || Boolean(bitmapScaleDrag) || Boolean(bitmapRotateDrag) || bitmapPendingTransformDragActive()}')
    expect(source).toContain("bringVectorSelectionToFront={() => editVectorObject('front')}")
  })

  it('exposes legacy copy/paste/swap controls with labels and enablement', async () => {
    const source = await editorSource()
    const copy = ariaBlock(source, 'Copy selection to clipboard')
    expect(copy).toContain('copyCostumeSelection()')
    expect(copy).toContain('vectorObjects.length')
    expect(copy).toContain('eyedropperActive')
    const paste = ariaBlock(source, 'Paste selection from clipboard')
    expect(paste).toContain('pasteCostumeSelection()')
    expect(paste).toContain('vectorClipboard.length')
    expect(paste).toContain('bitmapClipboard')
    expect(paste).toContain('bitmapFloatingDragActive()')
    const swap = ariaBlock(source, 'Swap fill colors')
    expect(swap).toContain('swapFillPaint')
    const front = ariaBlock(source, 'Bring to front')
    expect(front).toContain("editVectorObject('front')")
  })
})
