import type { BitmapShapeKind, BitmapShapeMode } from './bitmap-shape-mode'
import { normalizeRotationDegrees } from './rotation-gesture'
import type { PendingAffine2x3 } from './bitmap-pending-affine'
import { cloneAffineMatrix, isValidAffineMatrix, PENDING_AFFINE_IDENTITY, pendingAffineDeterminant, translatePendingAffine } from './bitmap-pending-affine'

/**
 * Uncommitted bitmap rect/oval shape (scratch-paint `bit-tools/rect-tool.js` /
 * `oval-tool.js` parity).
 *
 * Reference behavior: mouseUp does NOT rasterize. The new Paper Shape stays
 * selected under the armed shape tool; `setFilled` / `setThickness` /
 * `setColor` restyle it in place, the bounding-box tool moves / scales /
 * rotates it, and only a deselect (blank press, Escape, tool / mode / target /
 * costume / project switch, deactivate) commits it to the raster via
 * `commitRectToBitmap` / `commitOvalToBitmap`. Delete removes the pending
 * vector shape without touching the raster.
 *
 * Product mapping (canvas-2d, no Paper layer):
 * - `base` (kept by the Editor, never in this helper) is the pre-stroke raster
 *   snapshot. The overlay is always rendered as `base + shape`, never
 *   `live + shape`, so re-renders, restyles and transforms can never
 *   double-compose pixels, damage non-selected raster, or bake
 *   semi-transparent pixels twice.
 * - This helper owns the PARAMETRIC side only (box / mode / style snapshot /
 *   commit-trigger matrix / single-shot consume). Canvas IO (putImageData,
 *   gradient resolution, history save) stays in `Editor.svelte`, which already
 *   owns the owner-token / workspace-settled gates.
 * - Geometry is canvas px (floats). Resolution notes: res2 1 canvas px =
 *   1 Paper unit, res1 1 canvas px = 2 Paper units (kept non-destructively);
 *   the commit gate already accounts for this via
 *   `shouldCommitBitmapShapeDrag`. Rotation-center / stage anchoring never
 *   shifts the box: transforms are pure box math, and the Editor reuses the
 *   existing true-center snap anchor for moves.
 */
export type PendingBitmapShapeStyle = {
  /** Fill hex (solid) or first gradient stop. */
  fill: string
  /** Second gradient stop (ignored for solid). */
  secondary: string
  /** Gradient kind driving the fill style. */
  gradient: 'solid' | 'horizontal' | 'vertical' | 'radial'
  /** Transparent toggles for the fill paint. */
  fillTransparent: boolean
  secondaryTransparent: boolean
  /** Shared bitmap brush size: the outlined contour width (reference `bitBrushSize`). */
  brushSize: number
}

export type PendingBitmapShape = {
  kind: BitmapShapeKind
  /** Resolved canvas-px box (Shift-squared / Alt-centered already applied). */
  box: { x: number; y: number; width: number; height: number }
  mode: BitmapShapeMode
  style: PendingBitmapShapeStyle
  /**
   * Clockwise rotation about the shape's OWN center in degrees (screen
   * y-down positive, matching `rotation-gesture` / the reference rotate
   * handle). `0` is the axis-aligned legacy box. The box stays the UNROTATED
   * local extents; the overlay paints it rotated and the selection outline
   * reports the tight rotated bounding box, so restyle / move / retarget /
   * commit never bake pixels before commit and gradients travel with the
   * shape (resolved in the local frame at draw time).
   */
  rotation: number
  /**
   * Exact bounded screen transform (`bitmap-pending-affine.ts`, Canvas
   * `setTransform(a, b, c, d, e, f)` parity: `x' = a*x + c*y + e`,
   * `y' = b*x + d*y + f`). `undefined` (legacy) is identity. The final
   * screen point is `affine * R(center) * local`, so a world-axis scale
   * after rotation (`S * R` skew) is represented exactly instead of being
   * rounded into the local box. Screen drags left-compose into this matrix;
   * the local `box`, scalar `rotation`, and `style` stay verbatim (restyle
   * never touches geometry; move/nudge compose a translation; 90-degree
   * rotates compose a screen turn about the selection center).
   */
  affine?: PendingAffine2x3
}

export type PendingBitmapShapeTrigger =
  | 'blank-press'
  | 'tool-switch'
  | 'mode-switch'
  | 'target-switch'
  | 'costume-switch'
  | 'project-switch'
  | 'escape'
  | 'delete'
  | 'pointercancel'
  | 'undo'
  | 'save'

export type PendingBitmapShapeAction = 'commit' | 'discard' | 'ignore'

/**
 * Commit-trigger matrix (reference `rect-tool.js` / `oval-tool.js` +
 * `keyboard-shortcuts-hoc.jsx`):
 * - `commit`: the pending shape rasterizes exactly once, then one history
 *   entry is written (blank press commits the old shape before the new drag;
 *   tool / mode / target / costume / project switch commits via
 *   `deactivateTool`; Escape commits via `clearSelection` -> `onSelectionChanged`).
 * - `discard`: Delete removes the pending vector shape with no raster change
 *   and no raster history; Undo drops back to the pre-drag raster (the mouseUp
 *   snapshot held the pending shape, so undo removes it entirely).
 * - `ignore`: pointercancel during a shape draft never meets a pending shape
 *   (a blank press commits first), and an explicit save keeps it pending.
 */
export function resolvePendingBitmapShapeAction(trigger: PendingBitmapShapeTrigger): PendingBitmapShapeAction {
  switch (trigger) {
    case 'blank-press':
    case 'tool-switch':
    case 'mode-switch':
    case 'target-switch':
    case 'costume-switch':
    case 'project-switch':
    case 'escape':
      return 'commit'
    case 'delete':
    case 'undo':
      return 'discard'
    case 'pointercancel':
    case 'save':
      return 'ignore'
  }
}

/**
 * Normalize a pending rotation to (-180, 180] degrees clockwise, with tiny
 * angles snapped to exactly 0. Non-finite / non-number input normalizes to 0
 * (creation-time convenience); the preview resolver and the rotate helpers
 * still fail CLOSED on explicitly invalid input instead of silently painting
 * axis-aligned, so a corrupt staged value can never rasterize.
 */
export function normalizePendingRotationDegrees(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const normalized = normalizeRotationDegrees(value)
  if (!Number.isFinite(normalized)) return 0
  if (Math.abs(normalized) < 1e-9) return 0
  return normalized
}

export function createPendingBitmapShape(
  kind: BitmapShapeKind,
  box: { x: number; y: number; width: number; height: number },
  mode: BitmapShapeMode,
  style: PendingBitmapShapeStyle,
  rotation?: number,
  affine?: PendingAffine2x3,
): PendingBitmapShape {
  const shape: PendingBitmapShape = {
    kind,
    box: normalizePendingBox(box),
    mode,
    style: { ...style },
    rotation: normalizePendingRotationDegrees(rotation ?? 0),
  }
  if (affine !== undefined) {
    if (isValidAffineMatrix(affine)) shape.affine = cloneAffineMatrix(affine)
  }
  return shape
}

function normalizePendingBox(box: { x: number; y: number; width: number; height: number }): {
  x: number
  y: number
  width: number
  height: number
} {
  const width = Number.isFinite(box.width) ? Math.max(0, box.width) : 0
  const height = Number.isFinite(box.height) ? Math.max(0, box.height) : 0
  const x = Number.isFinite(box.x) ? box.x : 0
  const y = Number.isFinite(box.y) ? box.y : 0
  return { x, y, width, height }
}

/**
 * Restyle the pending shape in place (reference `setFilled` / `setThickness` /
 * `setColor`: no raster write, no commit). Returns the SAME object when
 * nothing visible changed so the Editor can skip the overlay re-render (and
 * must write no history either way).
 */
export function restylePendingBitmapShape(
  pending: PendingBitmapShape,
  style: Partial<PendingBitmapShapeStyle>,
  mode?: BitmapShapeMode,
): { pending: PendingBitmapShape; changed: boolean } {
  const nextMode = mode ?? pending.mode
  const nextStyle: PendingBitmapShapeStyle = { ...pending.style, ...style }
  const changed =
    nextMode !== pending.mode ||
    nextStyle.fill !== pending.style.fill ||
    nextStyle.secondary !== pending.style.secondary ||
    nextStyle.gradient !== pending.style.gradient ||
    nextStyle.fillTransparent !== pending.style.fillTransparent ||
    nextStyle.secondaryTransparent !== pending.style.secondaryTransparent ||
    nextStyle.brushSize !== pending.style.brushSize
  if (!changed) return { pending, changed: false }
  return { pending: { ...pending, mode: nextMode, style: nextStyle }, changed: true }
}

/**
 * Translate the pending shape (reference bounding-box move / nudge). Pure
 * math: the raster is untouched until commit. The box is clamped so it can
 * never be pushed fully off-canvas (partial overflow still clips naturally at
 * commit, like the reference matrix path).
 *
 * Affine note: when `affine` is present (exact screen transform, see
 * `bitmap-pending-affine.ts`) the LOCAL box stays verbatim and the screen
 * translation left-composes into the matrix (`M' = T(dx, dy) * M`), so a
 * move/nudge after a rotated scale preserves the `S * R` skew instead of
 * collapsing it into the box. Legacy shapes (`affine === undefined`) keep
 * the historical box-translate path byte-for-byte.
 */
export function movePendingBitmapShape(
  pending: PendingBitmapShape,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
): PendingBitmapShape {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return pending
  if (pending.affine !== undefined) {
    if (!isValidAffineMatrix(pending.affine)) return pending
    if (dx === 0 && dy === 0) return pending
    const moved = translatePendingAffine(pending.affine, dx, dy)
    if (!moved) return pending
    if (
      moved.a === pending.affine.a &&
      moved.b === pending.affine.b &&
      moved.c === pending.affine.c &&
      moved.d === pending.affine.d &&
      moved.e === pending.affine.e &&
      moved.f === pending.affine.f
    ) {
      return pending
    }
    return { ...pending, affine: moved }
  }
  const width = Math.max(0, Math.min(bounds.width, pending.box.width))
  const height = Math.max(0, Math.min(bounds.height, pending.box.height))
  const x = clampNumber(pending.box.x + dx, -width, Math.max(0, bounds.width))
  const y = clampNumber(pending.box.y + dy, -height, Math.max(0, bounds.height))
  if (x === pending.box.x && y === pending.box.y && width === pending.box.width && height === pending.box.height) {
    return pending
  }
  return { ...pending, box: { x, y, width, height } }
}

/**
 * Retarget the pending box (reference bounding-box scale: 8 handles, Alt pins
 * the center, Shift frees a corner). The Editor resolves the handle math and
 * passes the normalized box; this clamps it to the canvas. Returns the SAME
 * object when the box is unchanged so no-op moves skip re-render.
 *
 * Rotation note: the box is the UNROTATED local extents and `rotation` is
 * preserved verbatim. For a rotated shape the Editor maps the screen-space
 * handle pointer into the local frame (inverse rotation about the shape
 * center, see `bitmap-pending-transform.ts`) BEFORE resolving, so the same
 * uniform / Alt-center / mirror rules apply in local axes and a corner resize
 * after rotation never shears or drifts. Passing an already-rotated bounding
 * box here directly would be a model mismatch — use the local-frame mapping.
 */
export function retargetPendingBitmapShape(
  pending: PendingBitmapShape,
  box: { x: number; y: number; width: number; height: number },
  bounds: { width: number; height: number },
): { pending: PendingBitmapShape; changed: boolean } {
  const normalized = normalizePendingBox(box)
  const width = Math.max(0, Math.min(bounds.width, normalized.width))
  const height = Math.max(0, Math.min(bounds.height, normalized.height))
  const x = clampNumber(normalized.x, -width, Math.max(0, bounds.width))
  const y = clampNumber(normalized.y, -height, Math.max(0, bounds.height))
  const changed = x !== pending.box.x || y !== pending.box.y || width !== pending.box.width || height !== pending.box.height
  if (!changed) return { pending, changed: false }
  return { pending: { ...pending, box: { x, y, width, height } }, changed: true }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Read the screen transform of a pending shape (`undefined` legacy reads as
 * identity). Returns a clone so callers can never mutate the staged shape.
 */
export function getPendingAffineOrIdentity(pending: PendingBitmapShape): PendingAffine2x3 {
  const affine = (pending as { affine?: unknown }).affine
  if (affine === undefined) return { ...PENDING_AFFINE_IDENTITY }
  if (!isValidAffineMatrix(affine)) return { ...PENDING_AFFINE_IDENTITY }
  return cloneAffineMatrix(affine)
}

/**
 * Stage a screen matrix on a pending shape. The local `box`, scalar
 * `rotation`, mode, and style stay verbatim — only `M` changes — so restyle
 * after a transformed shape applies local fill while preserving geometry,
 * and the shape never rasterizes before commit. Invalid matrices fail
 * closed to the SAME object. Staging identity drops the field (legacy
 * bytes back) and reports `changed` only when the field actually differs.
 */
export function withPendingAffine(
  pending: PendingBitmapShape,
  affine: PendingAffine2x3 | undefined,
): { pending: PendingBitmapShape; changed: boolean } {
  try {
    const current = (pending as { affine?: unknown }).affine
    if (affine === undefined) {
      if (current === undefined) return { pending, changed: false }
      const next: PendingBitmapShape = { ...pending }
      delete next.affine
      return { pending: next, changed: true }
    }
    if (!isValidAffineMatrix(affine)) return { pending, changed: false }
    const det = pendingAffineDeterminant(affine)
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { pending, changed: false }
    // Identity is the legacy encoding (`undefined`): staging it drops the
    // field instead of adding a no-op matrix, so a zero-delta scale replay
    // stays exactly `unchanged` (no repaint, no renderRev, no VM, no history).
    const isIdentity =
      affine.a === 1 && affine.b === 0 && affine.c === 0 && affine.d === 1 && affine.e === 0 && affine.f === 0
    if (isIdentity) {
      if (current === undefined) return { pending, changed: false }
      const next: PendingBitmapShape = { ...pending }
      delete next.affine
      return { pending: next, changed: true }
    }
    if (
      current !== undefined &&
      isValidAffineMatrix(current) &&
      current.a === affine.a &&
      current.b === affine.b &&
      current.c === affine.c &&
      current.d === affine.d &&
      current.e === affine.e &&
      current.f === affine.f
    ) {
      return { pending, changed: false }
    }
    return { pending: { ...pending, affine: cloneAffineMatrix(affine) }, changed: true }
  } catch {
    return { pending, changed: false }
  }
}

/**
 * Editor-side slot pairing the parametric shape with its pre-stroke raster
 * base. The overlay is always rendered as `base + shape` and the commit
 * rasterizes from `base` exactly once.
 *
 * Single-shot consume guard: the commit path takes the slot EXACTLY once via
 * `takePendingBitmapShape` (shape + base cleared synchronously BEFORE the
 * async history save). Any second commit attempt (re-entrant trigger, racing
 * Escape + tool-switch) sees an empty slot and becomes a no-op — never a
 * second rasterization (no double composition), never a second history entry.
 */
export type PendingBitmapShapeSlot = {
  shape: PendingBitmapShape | undefined
  base: ImageData | undefined
}

export function takePendingBitmapShape(slot: PendingBitmapShapeSlot): {
  shape: PendingBitmapShape
  base: ImageData | undefined
} | undefined {
  const shape = slot.shape
  const base = slot.base
  slot.shape = undefined
  slot.base = undefined
  if (!shape) return undefined
  return { shape, base }
}
