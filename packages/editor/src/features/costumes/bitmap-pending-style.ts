import { normalizeBitmapShapeMode, resolveBitmapShapeSelectionPadding, type BitmapShapeKind, type BitmapShapeMode } from './bitmap-shape-mode'
import { normalizePendingRotationDegrees, type PendingBitmapShape, type PendingBitmapShapeStyle } from './bitmap-pending-shape'
import { rotatedPendingBoxBoundingBox } from './bitmap-pending-transform'
import { isValidAffineMatrix, pendingAffineSelectionAABB } from './bitmap-pending-affine'
import type { PaintGradientKind } from './paint-colors'

/**
 * Editor paint-state -> pending-shape style adapter (B-3 UI wiring).
 *
 * Focused feature helper (AGENTS split): maps the live `Editor.svelte`
 * bitmap paint controls to the parametric `PendingBitmapShapeStyle` the
 * isolated `bitmap-pending-session` consumes. No VM, no DOM, no history.
 */

export type BitmapPendingEditorStyleSource = {
  paintColor: string
  secondaryPaintColor: string
  paintGradient: PaintGradientKind | string
  fillTransparent: boolean
  secondaryTransparent: boolean
  brushSize: number
}

function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase()
  return fallback
}

function normalizeGradient(value: unknown): PaintGradientKind {
  return value === 'horizontal' || value === 'vertical' || value === 'radial' ? value : 'solid'
}

function normalizeBrush(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 10
  return Math.max(0, n)
}

/** Build the session style snapshot from the current Editor paint controls. */
export function pendingStyleFromEditor(source: BitmapPendingEditorStyleSource): PendingBitmapShapeStyle {
  return {
    fill: normalizeHex(source.paintColor, '#000000'),
    secondary: normalizeHex(source.secondaryPaintColor, '#ffffff'),
    gradient: normalizeGradient(source.paintGradient),
    fillTransparent: source.fillTransparent === true,
    secondaryTransparent: source.secondaryTransparent === true,
    brushSize: normalizeBrush(source.brushSize),
  }
}

/** Normalize the shape mode toggle from the Editor toolbar. */
export function pendingModeFromEditor(value: unknown): BitmapShapeMode {
  return normalizeBitmapShapeMode(value)
}

/** Normalize the shape kind from the Editor tool. */
export function pendingKindFromTool(tool: unknown): BitmapShapeKind | undefined {
  if (tool === 'rect' || tool === 'oval') return tool
  return undefined
}

/** Selection outline for a staged pending shape (exclusive-mode padding). */
export function pendingSelectionForShape(shape: PendingBitmapShape | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (!shape) return undefined
  const box = shape.box
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height)) return undefined
  const padding = resolveBitmapShapeSelectionPadding(shape.mode, shape.style.brushSize)
  // Inflate the LOCAL extents first (the outlined contour extends past the
  // local box on every side), then report the tight screen bounding box so
  // the handles track the visible ink. Legacy rotation reduces to the
  // rotated-box helper; an exact screen transform (`affine`) maps the four
  // inflated corners through `M * R` (the `S * R` skew included). A 0-degree
  // identity rotation reduces exactly to the legacy inflated box. Corrupt
  // angles/matrices fail closed to `undefined` (no outline) instead of a
  // misleading box — the staged shape itself is kept.
  const inflated = {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  }
  const rotationRaw = (shape as { rotation?: unknown }).rotation
  // Corrupt angles fail closed to `undefined` (no outline) instead of a
  // misleading box — the staged shape itself is retained untouched.
  if (rotationRaw !== undefined && (typeof rotationRaw !== 'number' || !Number.isFinite(rotationRaw))) {
    return undefined
  }
  const rotation = normalizePendingRotationDegrees(rotationRaw ?? 0)
  const affineRaw = (shape as { affine?: unknown }).affine
  if (affineRaw !== undefined) {
    if (!isValidAffineMatrix(affineRaw)) return undefined
    return pendingAffineSelectionAABB(inflated, rotation, affineRaw) ?? undefined
  }
  if (Math.abs(rotation) < 1e-9) return inflated
  return rotatedPendingBoxBoundingBox(inflated, rotation) ?? undefined
}
