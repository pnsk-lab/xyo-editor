import { describe, expect, it } from 'bun:test'
import {
  createPendingBitmapShape,
  movePendingBitmapShape,
  resolvePendingBitmapShapeAction,
  restylePendingBitmapShape,
  retargetPendingBitmapShape,
  takePendingBitmapShape,
  type PendingBitmapShapeSlot,
} from '../src/features/costumes/bitmap-pending-shape'

const STYLE = {
  fill: '#ff0000',
  secondary: '#ffffff',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 10,
}

describe('pending bitmap rect/oval shape (retention parity)', () => {
  it('restyle with identical values keeps the same object (skip re-render, no history)', () => {
    const pending = createPendingBitmapShape('rect', { x: 1, y: 2, width: 30, height: 20 }, 'filled', STYLE)
    const { pending: same, changed } = restylePendingBitmapShape(pending, { fill: '#ff0000' }, 'filled')
    expect(changed).toBe(false)
    expect(same).toBe(pending)
  })

  it('restyle color / filled->outlined / thickness reports changed with a new object', () => {
    const pending = createPendingBitmapShape('rect', { x: 1, y: 2, width: 30, height: 20 }, 'filled', STYLE)
    const color = restylePendingBitmapShape(pending, { fill: '#0000ff' })
    expect(color.changed).toBe(true)
    expect(color.pending.style.fill).toBe('#0000ff')
    expect(color.pending).not.toBe(pending)
    // The pre-restyle object is untouched (base + old params still renderable).
    expect(pending.style.fill).toBe('#ff0000')

    const mode = restylePendingBitmapShape(pending, {}, 'outlined')
    expect(mode.changed).toBe(true)
    expect(mode.pending.mode).toBe('outlined')

    const width = restylePendingBitmapShape(pending, { brushSize: 22 })
    expect(width.changed).toBe(true)
    expect(width.pending.style.brushSize).toBe(22)

    const transparent = restylePendingBitmapShape(pending, { fillTransparent: true })
    expect(transparent.changed).toBe(true)
  })

  it('move translates the box and clamps it inside the canvas', () => {
    const pending = createPendingBitmapShape('rect', { x: 10, y: 10, width: 30, height: 20 }, 'filled', STYLE)
    const moved = movePendingBitmapShape(pending, 5, -3, { width: 960, height: 720 })
    expect(moved.box).toEqual({ x: 15, y: 7, width: 30, height: 20 })
    // The source object is untouched (pure box math, raster untouched).
    expect(pending.box).toEqual({ x: 10, y: 10, width: 30, height: 20 })

    const clamped = movePendingBitmapShape(pending, -500, -500, { width: 960, height: 720 })
    expect(clamped.box.x).toBe(-30)
    expect(clamped.box.y).toBe(-20)

    const noop = movePendingBitmapShape(pending, 0, 0, { width: 960, height: 720 })
    expect(noop).toBe(pending)
  })

  it('retarget normalizes the scale box and reports no-op moves', () => {
    const pending = createPendingBitmapShape('oval', { x: 10, y: 10, width: 30, height: 20 }, 'outlined', STYLE)
    const same = retargetPendingBitmapShape(pending, { x: 10, y: 10, width: 30, height: 20 }, { width: 960, height: 720 })
    expect(same.changed).toBe(false)
    expect(same.pending).toBe(pending)

    const scaled = retargetPendingBitmapShape(pending, { x: 5, y: 5, width: 60, height: 40 }, { width: 960, height: 720 })
    expect(scaled.changed).toBe(true)
    expect(scaled.pending.box).toEqual({ x: 5, y: 5, width: 60, height: 40 })

    const oversize = retargetPendingBitmapShape(
      pending,
      { x: 0, y: 0, width: 5000, height: 5000 },
      { width: 960, height: 720 },
    )
    expect(oversize.changed).toBe(true)
    expect(oversize.pending.box.width).toBe(960)
    expect(oversize.pending.box.height).toBe(720)
  })

  it('commit-trigger matrix matches the reference deselect semantics', () => {
    for (const trigger of [
      'blank-press',
      'tool-switch',
      'mode-switch',
      'target-switch',
      'costume-switch',
      'project-switch',
      'escape',
    ] as const) {
      expect(resolvePendingBitmapShapeAction(trigger)).toBe('commit')
    }
    // Delete removes the pending shape with no raster change; Undo drops back
    // to the pre-drag raster (the mouseUp snapshot held the pending shape).
    expect(resolvePendingBitmapShapeAction('delete')).toBe('discard')
    expect(resolvePendingBitmapShapeAction('undo')).toBe('discard')
    // A save keeps the shape pending; pointercancel never meets a pending
    // shape (a blank press commits first).
    expect(resolvePendingBitmapShapeAction('save')).toBe('ignore')
    expect(resolvePendingBitmapShapeAction('pointercancel')).toBe('ignore')
  })

  it('take clears the slot synchronously: a second commit is a no-op (no double composition)', () => {
    const pending = createPendingBitmapShape('rect', { x: 1, y: 2, width: 30, height: 20 }, 'filled', STYLE)
    const slot: PendingBitmapShapeSlot = { shape: pending, base: undefined }
    const first = takePendingBitmapShape(slot)
    expect(first?.shape).toBe(pending)
    expect(slot.shape).toBeUndefined()
    expect(slot.base).toBeUndefined()
    // Racing Escape + tool-switch: the second take sees an empty slot.
    expect(takePendingBitmapShape(slot)).toBeUndefined()
  })
})
