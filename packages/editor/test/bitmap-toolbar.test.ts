import { describe, expect, it } from 'bun:test'

// Regression tests for the BitmapEditor toolbar and per-tool options row.
// The component must never render a visibly enabled button that does nothing:
// every toolbar button needs either an onclick handler or a disabled state,
// and bitmap-only operations must be disabled (not silently misapplied) in
// vector mode. Assertions are source-level because the component needs a
// browser canvas to mount; they lock the wiring that the browser tests
// exercise through roles and test ids.

const sourceUrl = new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url)
const editorUrl = new URL('../src/Editor.svelte', import.meta.url)

async function toolbarSource(): Promise<string> {
  return Bun.file(sourceUrl).text()
}

async function editorSource(): Promise<string> {
  return Bun.file(editorUrl).text()
}

function buttonLine(source: string, label: string): string {
  const line = source.split('\n').find((candidate) => candidate.includes(`aria-label="${label}"`))
  if (!line) throw new Error(`Missing toolbar button: ${label}`)
  return line
}

// Overflow-aware wiring lookup: toolbar actions now flow through the measured
// More (⋯) menu via `toolbarOverflowActions` in BitmapEditor.svelte (single
// source, rendered either inline or in the menu, never both). Each entry keeps
// its original testId/aria/title/disabled/handler. The brittle inline
// `aria-label="…"` search above still covers pinned buttons (Undo/Redo,
// transparent toggles, HSV); this helper covers the overflowed actions
// without relaxing any guard.
function overflowActionBlock(source: string, id: string): string {
  const lines = source.split('\n')
  const index = lines.findIndex((candidate) => candidate.includes(`id: '${id}'`))
  if (index < 0) throw new Error(`Missing toolbar overflow action: ${id}`)
  return lines.slice(Math.max(0, index - 1), index + 12).join('\n')
}

async function overflowSource(): Promise<string> {
  return Bun.file(new URL('../src/features/CostumeEditor/PaintToolbarOverflow.svelte', import.meta.url)).text()
}

describe('bitmap editor toolbar has no dead buttons', () => {
  it('gives every toolbar-icon button a handler or a disabled state', async () => {
    const source = await toolbarSource()
    const overflow = await overflowSource()
    // Copy/Paste/Delete flow through the measured More menu as priority
    // actions (inline while they fit), so no inline `toolbar-icon` cluster
    // remains; when pinned buttons exist each line carries handler+disabled.
    const pinnedButtons = source.split('\n').filter((line) => line.includes('<button') && line.includes('toolbar-icon'))
    for (const button of pinnedButtons) {
      expect(button.includes('onclick') || button.includes('disabled')).toBe(true)
    }
    // The generic overflow renderer (single runtime button shape) carries both.
    expect(overflow).toContain('toolbar-icon')
    expect(overflow).toContain('onclick={action.onClick}')
    expect(overflow).toContain('disabled={action.disabled}')
    // Every overflow entry wires a handler (no dead buttons when moved).
    // Delete stays pinned (pressed directly at any width); Copy/Paste lead
    // the overflow list as priority actions.
    for (const id of ['copy', 'paste', 'duplicate', 'group', 'ungroup', 'front', 'forward', 'backward', 'back', 'flip-h', 'flip-v', 'rotate-left', 'rotate-right']) {
      const block = overflowActionBlock(source, id)
      expect(block.includes('onClick')).toBe(true)
    }
  })

  it('wires layer ordering to the parent vector callbacks with a selection guard', async () => {
    const source = await toolbarSource()
    // Props declared on BitmapEditor and forwarded from Editor.svelte.
    expect(source).toContain('bringVectorSelectionForward')
    expect(source).toContain('sendVectorSelectionBackward')
    expect(source).toContain('sendVectorSelectionToBack')
    for (const [id, label] of [['front', 'Bring to front'], ['forward', 'Bring forward'], ['backward', 'Send backward'], ['back', 'Send to back']] as const) {
      const button = overflowActionBlock(source, id)
      // Enabled only in vector mode with a vector selection and a callback.
      expect(button).toContain(`label: '${label}'`)
      expect(button).toContain("costumeEditMode !== 'vector'")
      expect(button).toContain('selectedVectorObjectIndex')
      expect(button).toContain('selectedVectorObjectIndices')
      expect(button.includes('onClick')).toBe(true)
    }
    const forward = overflowActionBlock(source, 'forward')
    expect(forward).toContain('bringVectorSelectionForward')
    const backward = overflowActionBlock(source, 'backward')
    expect(backward).toContain('sendVectorSelectionBackward')
    const toBack = overflowActionBlock(source, 'back')
    expect(toBack).toContain('sendVectorSelectionToBack')

    const editor = await editorSource()
    expect(editor).toContain("bringVectorSelectionForward={() => editVectorObject('forward')}")
    expect(editor).toContain("sendVectorSelectionBackward={() => editVectorObject('backward')}")
    expect(editor).toContain("sendVectorSelectionToBack={() => editVectorObject('back')}")
  })

  it('wires vector flip to the existing flipSelectedVectorObject prop', async () => {
    const source = await toolbarSource()
    expect(source).toContain('flipVectorSelection')
    const horizontal = overflowActionBlock(source, 'flip-h')
    const vertical = overflowActionBlock(source, 'flip-v')
    // Bitmap mode keeps flipping the bitmap canvas; vector mode flips the selection.
    expect(horizontal).toContain('flipBitmap(true)')
    expect(horizontal).toContain('flipVectorSelection?.(true)')
    expect(vertical).toContain('flipBitmap(false)')
    expect(vertical).toContain('flipVectorSelection?.(false)')
    // Vector mode requires a selection; bitmap mode stays always enabled.
    expect(horizontal).toContain("costumeEditMode === 'bitmap'")
    expect(horizontal).toContain('selectedVectorObjectIndex')
    expect(vertical).toContain("costumeEditMode === 'bitmap'")

    const editor = await editorSource()
    expect(editor).toContain('flipVectorSelection={(horizontal) => flipSelectedVectorObject(horizontal)}')
  })

  it('wires rotate buttons to the existing rotateBitmap prop', async () => {
    const source = await toolbarSource()
    expect(source).toContain('rotateBitmap: (clockwise: boolean)')
    const left = overflowActionBlock(source, 'rotate-left')
    const right = overflowActionBlock(source, 'rotate-right')
    expect(left).toContain('rotateBitmap(false)')
    expect(right).toContain('rotateBitmap(true)')
    // The rotate icons flow through the overflow entries (single renderer in
    // the split component renders each icon, no duplication).
    expect(source).toContain('icon: RotateCcw')
    expect(source).toContain('icon: RotateCw')
    const overflow = await overflowSource()
    expect(overflow).toContain('toolbar-icon')
  })

  it('limits rotate to bitmap mode', async () => {
    const source = await toolbarSource()
    for (const id of ['rotate-left', 'rotate-right']) {
      expect(overflowActionBlock(source, id)).toContain("disabled: costumeEditMode !== 'bitmap' || bitmapToolbarLocked")
    }
  })

  it('disables delete when nothing is selected', async () => {
    const source = await toolbarSource()
    // Delete stays pinned next to Undo/Redo (always visible, never overflow).
    const button = buttonLine(source, 'Delete selection')
    expect(button).toContain('bitmapSelection')
    expect(button).toContain('selectedVectorObjectIndex')
  })
})

describe('bitmap editor per-tool options match scratch-paint behavior', () => {
  it('exposes the gradient picker in bitmap mode too', async () => {
    const source = await toolbarSource()
    expect(source).toContain('aria-label="Bitmap paint style"')
    expect(source).toContain('aria-label="Vector paint style"')
  })

  it('shows the secondary color only for non-solid gradients', async () => {
    const source = await toolbarSource()
    const secondary = buttonLine(source, 'Secondary paint color')
    expect(secondary.includes('sr-only')).toBe(false)
    expect(source).toContain("{#if paintGradient !== 'solid'}")
  })
})

describe('hsv fill/stroke pickers (scratch parity, native kept)', () => {
  it('keeps the native pickers and adds one HSV picker per paint', async () => {
    const source = await toolbarSource()
    // Native inputs stay exactly where they were (opaque hex + restore model).
    expect(source).toContain('bind:value={paintColor} aria-label="Paint color"')
    expect(source).toContain('bind:value={strokeColor} aria-label="Stroke color"')
    expect(source).toContain('aria-label="Secondary paint color"')
    expect(source).toContain('aria-label="Secondary stroke color"')
    // One independent HSV picker per paint: fill, stroke, and both gradient
    // ends. Each writes only its own hex and marks only its own field.
    for (const prefix of ['idPrefix="fill"', 'idPrefix="stroke"', 'idPrefix="fill-secondary"', 'idPrefix="stroke-secondary"']) {
      if (!source.includes(prefix)) throw new Error(`Missing HSV picker: ${prefix}`)
    }
    expect(source).toContain('import HsvColorPicker')
    expect(source).toContain('paintColor = hex')
    expect(source).toContain('strokeColor = hex')
    expect(source).toContain('secondaryPaintColor = hex')
    expect(source).toContain('strokeSecondaryColor = hex')
  })

  it('threads mixed/transparent state into the HSV pickers without touching swap', async () => {
    const source = await toolbarSource()
    expect(source).toContain('mixed={mixedFill}')
    expect(source).toContain('transparent={fillTransparent}')
    expect(source).toContain('mixed={mixedStroke}')
    expect(source).toContain('transparent={strokeTransparent}')
    expect(source).toContain('mixed={mixedFillSecondary}')
    expect(source).toContain('mixed={mixedStrokeSecondary}')
    expect(source).toContain("markVectorStyleDirty?.('fill')")
    expect(source).toContain("markVectorStyleDirty?.('stroke')")
    expect(source).toContain("markVectorStyleDirty?.('fillSecondary')")
    expect(source).toContain("markVectorStyleDirty?.('strokeSecondary')")
    // Swap still exchanges the stored hexes + flags directly (HSV is a second
    // view on the same hex, never a third copy).
    expect(source).toContain('data-testid="swap-fill-colors"')
    expect(source).toContain('data-testid="swap-stroke-colors"')
  })

  it('gives every HSV slider an accessible name, readout, and resync epoch', async () => {
    const component = await Bun.file(
      new URL('../src/components/HsvColorPicker.svelte', import.meta.url),
    ).text()
    for (const label of ['aria-label={hueLabel}', 'aria-label={saturationLabel}', 'aria-label={brightnessLabel}']) {
      if (!component.includes(label)) throw new Error(`Missing HSV slider name: ${label}`)
    }
    // Native ranges: keyboard arrows + touch drag for free; readouts echo the
    // rounded 0-100 values next to each slider.
    expect(component).toContain('type="range"')
    expect(component).toContain('-hue-value')
    expect(component).toContain('-saturation-value')
    expect(component).toContain('-brightness-value')
    // Local slider state resyncs from external hex/epoch/flag changes only, so
    // continuous drags and MIXED selections never write on their own.
    expect(component).toContain('lastEmitted')
    expect(component).toContain('syncKey')
    expect(component).toContain('onHexInput')
    expect(component).toContain('onHexCommit')
    const source = await toolbarSource()
    expect(source).toContain('hsvSyncKey')
    expect(source).toContain('syncKey={hsvSyncKey}')
  })
})

describe('transparent fill/stroke toggles', () => {
  it('exposes independent transparent toggles that preserve the hex pickers', async () => {
    const source = await toolbarSource()
    for (const label of ['Transparent fill', 'Transparent stroke', 'Transparent secondary']) {
      const line = source.split('\n').find((candidate) => candidate.includes(`aria-label="${label}"`))
      if (!line) throw new Error(`Missing transparent toggle: ${label}`)
    }
    // Toggles report their state for enable/disable checks and never clear
    // the hex inputs (restore works by untoggling).
    expect(source).toContain('aria-pressed={fillTransparent}')
    expect(source).toContain('aria-pressed={strokeTransparent}')
    expect(source).toContain('aria-pressed={secondaryTransparent}')
    // The color inputs stay bound to the hex state, not to transparent.
    expect(source).toContain('bind:value={paintColor} aria-label="Paint color"')
    expect(source).toContain('bind:value={strokeColor} aria-label="Stroke color"')
  })

  it('shows the secondary toggle only for non-solid gradients', async () => {
    const source = await toolbarSource()
    const block = source.slice(source.indexOf("{#if paintGradient !== 'solid'}"))
    expect(block).toContain('aria-label="Secondary paint color"')
    expect(block).toContain('aria-label="Transparent secondary"')
  })

  it('threads the toggle state between Editor.svelte and BitmapEditor', async () => {
    const source = await toolbarSource()
    expect(source).toContain('fillTransparent = $bindable(false)')
    expect(source).toContain('secondaryTransparent = $bindable(false)')
    expect(source).toContain('strokeTransparent = $bindable(false)')
    const editor = await editorSource()
    expect(editor).toContain('bind:fillTransparent')
    expect(editor).toContain('bind:secondaryTransparent')
    expect(editor).toContain('bind:strokeTransparent')
    // Vector fills serialize transparent as SVG none via the shared helper.
    expect(editor).toContain('resolveVectorFillPaint')
    expect(editor).toContain("fillTransparent ? 'none' : paintColor")
  })

  it('renders transparent-aware live previews without touching VectorShapePreview', async () => {
    const source = await toolbarSource()
    expect(source).toContain('previewFillColor')
    expect(source).toContain('previewStrokeColor')
    expect(source).toContain('previewGradientEndCss')
  })
})
