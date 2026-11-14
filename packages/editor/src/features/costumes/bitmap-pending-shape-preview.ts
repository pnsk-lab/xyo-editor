// Isolated parametric pending rect/oval preview renderer (bitmap `rect` / `oval`).
//
// This module is the DRAW side of the pending-shape pair. The PARAMETRIC side
// lives in `bitmap-pending-shape.ts` (box / mode / style snapshot, commit
// matrix, single-shot slot); the OWNER / history / VM side stays in
// `Editor.svelte`. Nothing here touches the Editor, the BitmapEditor, the VM,
// history, or the DOM canvas element: every export is a pure function of an
// immutable base raster plus one exact selected shape box, except the two
// explicitly canvas-bound wrappers (`restore…` / `composite…`), which take
// their context as an argument and never reach for globals.
//
// Single-pass contract:
// - Each render starts from the SAME pre-stroke base (`putImageData(base)`)
//   and paints the shape EXACTLY ONCE, so repeated re-renders, restyles and
//   retargets can never alpha-accumulate, damage non-selected pixels, or bake
//   semi-transparent pixels twice. The input base is never mutated: the
//   module copies its bytes first and hands back a fresh raster.
// - The draw itself reuses the shared exclusive painter
//   (`paintBitmapRectOvalExclusive` from `bitmap-shape-mode.ts`): filled
//   paints the interior only, outlined strokes the contour only with the FILL
//   style and the shared brush size. No rect/ellipse path code is duplicated
//   here; the strict-equality browser test pins this wrapper byte-identical
//   to that painter.
// - Style geometry mirrors `Editor.svelte#bitmapPaintStyle` exactly: solid is
//   the hex (or transparent `rgba(0,0,0,0)`), linear gradients span the shape
//   box, radial gradients center on the box center with radius
//   `max(1, max(w,h)/2)`. Stops reuse `resolveBitmapGradientStops`, so a
//   transparent end fades opacity through the surviving end's RGB (never
//   through black), matching the editor and the reference behavior.
//
// Resolution / zoom / modifier notes (stated limits, no unproven claims):
// - All inputs are canvas px (floats). Bitmap res1 vs res2 changes ONLY the
//   commit gate (`shouldCommitBitmapShapeDrag` k-factor: 1 canvas px = 2 Paper
//   units at res1, 1 at res2); the preview stroke width is always the shared
//   brush size in canvas px. Viewport zoom maps CSS px to canvas px BEFORE
//   the box reaches this module, so zoom needs no handling here.
// - Shift (square/circle) and Alt (centered) are resolved BEFORE this module
//   via `resolveShapeRect`; this module clamps the resolved box to the canvas
//   address range (partial overflow still clips naturally at draw time, like
//   the reference matrix path). Oversized boxes can never allocate: drawing
//   clips, and the canvas-size gate refuses before any copy.
// - Geometry parity limit: the in-repo exclusive painter (Canvas2D ellipse,
//   bezier-approximated) is the pinned reference. An INDEPENDENT Paper.js
//   pixel comparison is NOT claimed here: Paper.js rasterizes vectors through
//   its own pipeline and its antialiasing need not match Canvas2D stroke
//   coverage pixel-for-pixel. What IS proven (browser test): this renderer
//   adds zero passes and zero blends over the shared painter (strict byte
//   equality), repeated renders from the same base are byte-identical (no
//   accumulation), and restores are exact (2x restore === base).
//
// Failure policy (mirrors `bitmap-cropped-save.ts`): never throws. Tainted or
// unreadable canvases are modelled by `undefined` inputs / throwing contexts
// and fail closed to `undefined` / `false` — never a half-painted canvas: a
// failed paint restores the base before returning. (Taint itself cannot arise
// here: the module only ever `putImageData`s and paints gradients/shapes,
// never `drawImage`s an untrusted source — still guarded by try/catch.)

import {
  isBitmapShapeMode,
  normalizeBitmapShapeMode,
  paintBitmapRectOvalExclusive,
  resolveBitmapShapePaint,
  type BitmapShapeKind,
  type BitmapShapeMode,
} from './bitmap-shape-mode'
import type { PendingBitmapShape } from './bitmap-pending-shape'
import { normalizePendingRotationDegrees } from './bitmap-pending-shape'
import { PENDING_AFFINE_IDENTITY, isValidAffineMatrix, type PendingAffine2x3 } from './bitmap-pending-affine'
import { isBitmapSourceSizeRefused } from './bitmap-artboard'
import { parseHexPaintRgba } from './paint-colors'
import { isFillInvisible, resolveBitmapGradientStops } from './transparent-paint'

/** Structural base raster. `ImageData` satisfies this shape structurally. */
export type PendingShapePreviewBase = {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/** Canvas size the preview renders into (integer canvas px). */
export type PendingShapePreviewCanvasSize = {
  width: number
  height: number
}

/** Clamped, drawable shape (output of the pure resolver). */
export type PendingShapePreviewDraw = {
  kind: BitmapShapeKind
  box: { x: number; y: number; width: number; height: number }
  mode: BitmapShapeMode
  fill: string
  secondary: string
  gradient: 'solid' | 'horizontal' | 'vertical' | 'radial'
  fillTransparent: boolean
  secondaryTransparent: boolean
  /** Outlined contour width in canvas px (shared brush size, >= 0). */
  brushSize: number
  /**
   * Clockwise rotation about the box center in degrees (normalized to
   * (-180, 180], 0 = axis-aligned). The box stays the UNROTATED local
   * extents; the paint wraps it in `translate(center) + rotate + draw
   * centered` and resolves gradients in that local frame, so linear ramps
   * travel with the shape exactly like a true vector rotation.
   */
  rotation: number
  /**
   * Exact bounded screen transform (Canvas `setTransform` parity, identity
   * for legacy shapes). The final screen point is `affine * R(center) *
   * local`: a world-axis scale after rotation is an exact `S * R` skew,
   * never a box rewrite. Gradients resolve AFTER the full transform, so
   * ramps travel with the skewed shape; the contour keeps the local brush
   * width and the CTM scales it (effective stroke scaling).
   */
  affine: PendingAffine2x3
}

export type PendingShapePreviewNoopReason = 'invisible-fill' | 'zero-brush' | 'empty-box'

export type PendingShapePreviewRefusedReason =
  | 'bad-input'
  | 'empty-canvas'
  | 'oversized'
  | 'base-mismatch'

export type PendingShapePreviewResolution =
  | { kind: 'draw'; draw: PendingShapePreviewDraw }
  | { kind: 'noop'; reason: PendingShapePreviewNoopReason }
  | { kind: 'refused'; reason: PendingShapePreviewRefusedReason }

/** Resolved canvas paint for one draw (mirrors `bitmapPaintStyle`). */
export type PendingShapePreviewStyle = {
  paint: string | CanvasGradient
  lineWidth: number
}

function isFiniteRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function isGradientKind(value: unknown): value is PendingShapePreviewDraw['gradient'] {
  return value === 'solid' || value === 'horizontal' || value === 'vertical' || value === 'radial'
}

/**
 * Cross-realm byte-view check (no `instanceof`: an `ImageData` minted in a
 * foreign realm carries a foreign `Uint8ClampedArray` whose prototype differs
 * from ours, yet it is still a 1-byte view). Accepts any 1-byte typed array
 * view (`Uint8ClampedArray` / `Uint8Array`, any realm); rejects `DataView`
 * and multi-byte views (`Uint16Array`, …) via the byteLength/length ratio.
 */
function byteViewLength(data: unknown): number | undefined {
  try {
    if (typeof ArrayBuffer === 'undefined' || !ArrayBuffer.isView(data)) return undefined
    const view = data as unknown as {
      length?: unknown
      byteLength?: unknown
      subarray?: unknown
      set?: unknown
    }
    if (typeof view.length !== 'number' || !Number.isFinite(view.length)) return undefined
    if (typeof view.subarray !== 'function' || typeof view.set !== 'function') return undefined
    if (typeof view.byteLength === 'number' && view.length > 0) {
      const ratio = (view.byteLength as number) / (view.length as number)
      if (ratio !== 1) return undefined
    }
    return view.length as number
  } catch {
    return undefined
  }
}

/**
 * Isolate one paint pass from the caller's 2d state without clobbering it.
 * `putImageData` ignores transform/clip/alpha/composite/filter, but every
 * fill/stroke path honors them, so a dirty caller context (zoom transform,
 * offscreen clip, `globalAlpha < 1`, exotic composite, blur filter, shadow,
 * dash) would otherwise draw at the wrong coordinates with the wrong look.
 * `save` + explicit default reset + `restore` keeps the caller's stack byte
 * identical while the paint itself always runs in identity canvas-px space.
 * NOTE: an outer clip active BEFORE this `save` still clips (clip can only be
 * shed by unwinding to before `clip()`); the single-pass `composite…`
 * therefore paints on a detached canvas and only `putImageData`s the result,
 * which is clip/transform-independent.
 */
function withIsolatedPaintState(context: CanvasRenderingContext2D, paint: () => void): void {
  const canSave =
    typeof (context as unknown as { save?: unknown }).save === 'function' &&
    typeof (context as unknown as { restore?: unknown }).restore === 'function'
  if (!canSave) {
    // Unit-test mocks without a state stack: paint directly (best effort).
    paint()
    return
  }
  context.save()
  try {
    try {
      context.setTransform(1, 0, 0, 1, 0, 0)
    } catch {
      // Ignore: mocked contexts without setTransform keep their matrix.
    }
    try {
      context.globalAlpha = 1
    } catch {
      // Ignore: read-only mocks stay as-is.
    }
    try {
      context.globalCompositeOperation = 'source-over'
    } catch {
      // Ignore.
    }
    try {
      ;(context as unknown as { filter?: unknown }).filter = 'none'
    } catch {
      // Ignore: contexts without filter support.
    }
    try {
      const shadowed = context as unknown as {
        shadowColor?: unknown
        shadowBlur?: unknown
        shadowOffsetX?: unknown
        shadowOffsetY?: unknown
      }
      shadowed.shadowColor = 'rgba(0, 0, 0, 0)'
      shadowed.shadowBlur = 0
      shadowed.shadowOffsetX = 0
      shadowed.shadowOffsetY = 0
    } catch {
      // Ignore.
    }
    try {
      if (typeof context.setLineDash === 'function') context.setLineDash([])
    } catch {
      // Ignore.
    }
    paint()
  } finally {
    try {
      context.restore()
    } catch {
      // The context is already unusable; nothing more to restore.
    }
  }
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && parseHexPaintRgba(value) !== undefined
}

/**
 * Pure resolver: validate the parametric shape + canvas size and compute the
 * exact clamped draw box (or the noop/refused verdict). DOM-free so unit
 * tests run in Bun. Never throws.
 */
export function resolvePendingBitmapShapePreview(
  shape: PendingBitmapShape | undefined | null,
  canvasSize: PendingShapePreviewCanvasSize | undefined | null,
): PendingShapePreviewResolution {
  try {
    if (!isFiniteRecord(canvasSize)) return { kind: 'refused', reason: 'bad-input' }
    const canvasWidth = (canvasSize as Record<string, unknown>).width
    const canvasHeight = (canvasSize as Record<string, unknown>).height
    if (typeof canvasWidth !== 'number' || typeof canvasHeight !== 'number') {
      return { kind: 'refused', reason: 'bad-input' }
    }
    if (!Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight)) {
      return { kind: 'refused', reason: 'bad-input' }
    }
    if (canvasWidth <= 0 || canvasHeight <= 0) return { kind: 'refused', reason: 'empty-canvas' }
    if (isBitmapSourceSizeRefused(canvasWidth, canvasHeight)) return { kind: 'refused', reason: 'oversized' }

    if (!isFiniteRecord(shape)) return { kind: 'refused', reason: 'bad-input' }
    const record = shape as Record<string, unknown>
    const kind = record.kind
    if (kind !== 'rect' && kind !== 'oval') return { kind: 'refused', reason: 'bad-input' }
    const rawMode = record.mode
    if (!isBitmapShapeMode(rawMode)) return { kind: 'refused', reason: 'bad-input' }
    const mode = normalizeBitmapShapeMode(rawMode)
    if (!isFiniteRecord(record.box)) return { kind: 'refused', reason: 'bad-input' }
    const boxRecord = record.box as Record<string, unknown>
    const x = finiteOrUndefined(boxRecord.x)
    const y = finiteOrUndefined(boxRecord.y)
    const width = finiteOrUndefined(boxRecord.width)
    const height = finiteOrUndefined(boxRecord.height)
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      return { kind: 'refused', reason: 'bad-input' }
    }
    if (width <= 0 || height <= 0) return { kind: 'noop', reason: 'empty-box' }
    if (!isFiniteRecord(record.style)) return { kind: 'refused', reason: 'bad-input' }
    const styleRecord = record.style as Record<string, unknown>
    if (!isHexColor(styleRecord.fill) || !isHexColor(styleRecord.secondary)) {
      // Fail closed: the editor would paint invalid hex as opaque black;
      // the isolated preview refuses instead of inventing pixels.
      return { kind: 'refused', reason: 'bad-input' }
    }
    if (!isGradientKind(styleRecord.gradient)) return { kind: 'refused', reason: 'bad-input' }
    if (typeof styleRecord.fillTransparent !== 'boolean' || typeof styleRecord.secondaryTransparent !== 'boolean') {
      return { kind: 'refused', reason: 'bad-input' }
    }
    const brushRaw = finiteOrUndefined(styleRecord.brushSize)
    if (brushRaw === undefined) return { kind: 'refused', reason: 'bad-input' }
    const brushSize = Math.max(0, brushRaw)
    // Rotation: pre-rotation shapes omit the field (backward compatible, 0).
    // An explicitly corrupt angle fails CLOSED (never silently paints
    // axis-aligned over staged ink): the session keeps the shape and the
    // overlay is untouched.
    const rotationRecord = record as Record<string, unknown>
    const rotationRaw = rotationRecord.rotation
    let rotation = 0
    if (rotationRaw !== undefined) {
      if (typeof rotationRaw !== 'number' || !Number.isFinite(rotationRaw)) {
        return { kind: 'refused', reason: 'bad-input' }
      }
      rotation = normalizePendingRotationDegrees(rotationRaw)
    }
    const gradient = styleRecord.gradient
    const fillTransparent = styleRecord.fillTransparent
    const secondaryTransparent = styleRecord.secondaryTransparent
    // Exact screen transform: legacy shapes omit the field (identity). An
    // explicitly corrupt matrix fails CLOSED (never silently paints
    // axis-aligned over staged skewed ink).
    const affineRaw = (record as Record<string, unknown>).affine
    let affine: PendingAffine2x3 = { ...PENDING_AFFINE_IDENTITY }
    if (affineRaw !== undefined) {
      if (!isValidAffineMatrix(affineRaw)) return { kind: 'refused', reason: 'bad-input' }
      // Singular screen maps collapse ink to a line/point: refuse instead of
      // painting an invisible shape that the session would then commit.
      const det = affineRaw.a * affineRaw.d - affineRaw.b * affineRaw.c
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { kind: 'refused', reason: 'bad-input' }
      affine = { ...affineRaw }
    }

    const plan = resolveBitmapShapePaint(
      mode,
      { fillTransparent, secondaryTransparent, strokeTransparent: true },
      gradient,
      brushSize,
    )
    if (plan.noop) {
      // The exclusive painter would change no pixels: skip the draw (and the
      // history/save the commit path would otherwise write).
      if (mode === 'outlined' && !isFillInvisible(fillTransparent, secondaryTransparent, gradient)) {
        return { kind: 'noop', reason: 'zero-brush' }
      }
      return { kind: 'noop', reason: 'invisible-fill' }
    }

    // Clamp to the canvas address range (mirrors `retargetPendingBitmapShape`).
    // Partial overflow still clips naturally at draw time; the visible output
    // never changes, only out-of-range addresses are tamed. Rotation never
    // moves the box: the local extents clamp exactly like an axis-aligned
    // shape and the rotated pixels clip naturally at draw time.
    const clampedWidth = Math.max(0, Math.min(canvasWidth, width))
    const clampedHeight = Math.max(0, Math.min(canvasHeight, height))
    const clampedX = clampNumber(x, -clampedWidth, canvasWidth)
    const clampedY = clampNumber(y, -clampedHeight, canvasHeight)
    // A rotated shape whose local extents collapsed to zero under clamping is
    // still a noop (same as the axis-aligned empty-box rule).
    if (clampedWidth <= 0 || clampedHeight <= 0) return { kind: 'noop', reason: 'empty-box' }
    return {
      kind: 'draw',
      draw: {
        kind,
        box: { x: clampedX, y: clampedY, width: clampedWidth, height: clampedHeight },
        mode,
        fill: styleRecord.fill,
        secondary: styleRecord.secondary,
        gradient,
        fillTransparent,
        secondaryTransparent,
        brushSize,
        rotation,
        affine,
      },
    }
  } catch {
    return { kind: 'refused', reason: 'bad-input' }
  }
}

/**
 * Immutable base copy: fresh byte buffer, input never mutated. Accepts any
 * structural raster (`ImageData` included). Returns `undefined` (never
 * throws) on malformed / short / oversized inputs.
 */
export function copyPendingShapePreviewBase(
  base: PendingShapePreviewBase | ImageData | undefined | null,
): { width: number; height: number; data: Uint8ClampedArray } | undefined {
  try {
    if (!isFiniteRecord(base)) return undefined
    const record = base as Record<string, unknown>
    const width = record.width
    const height = record.height
    const data = record.data
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined
    const w = width as number
    const h = height as number
    if (!(w > 0 && h > 0)) return undefined
    if (isBitmapSourceSizeRefused(w, h)) return undefined
    const length = byteViewLength(data)
    if (length === undefined) return undefined
    const need = w * h * 4
    if (!Number.isFinite(need)) return undefined
    if (length < need) return undefined
    const copy = new Uint8ClampedArray(need)
    try {
      const view = data as unknown as { subarray: (begin: number, end: number) => ArrayLike<number> }
      copy.set(view.subarray(0, need) as unknown as Uint8ClampedArray, 0)
    } catch {
      return undefined
    }
    return { width: w, height: h, data: copy }
  } catch {
    return undefined
  }
}

/**
 * Resolve the canvas paint for one draw, mirroring
 * `Editor.svelte#bitmapPaintStyle` geometry byte-for-byte (solid hex or
 * transparent; linear spans the box; radial centers on the box with radius
 * `max(1, max(w,h)/2)`). Returns `undefined` (never throws) when the context
 * cannot mint the gradient. The caller passes the result straight into the
 * shared exclusive painter.
 *
 * Rotation note: rotated draws resolve against a CENTERED local box
 * (`-w/2, -h/2`, see the paint function) AFTER the rotation transform is
 * applied, so the same box geometry yields a ramp that travels with the
 * shape. Negative local origins are valid inputs here.
 */
export function resolvePendingShapePreviewStyle(
  context: CanvasRenderingContext2D | undefined | null,
  draw: PendingShapePreviewDraw | undefined | null,
): PendingShapePreviewStyle | undefined {
  try {
    if (!context || typeof (context as CanvasRenderingContext2D).createLinearGradient !== 'function') {
      return undefined
    }
    if (!isFiniteRecord(draw)) return undefined
    const record = draw as unknown as Record<string, unknown>
    if (!isFiniteRecord(record.box)) return undefined
    const box = record.box as Record<string, unknown>
    const x = finiteOrUndefined(box.x)
    const y = finiteOrUndefined(box.y)
    const width = finiteOrUndefined(box.width)
    const height = finiteOrUndefined(box.height)
    if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
    if (!(width > 0 && height > 0)) return undefined
    if (!isHexColor(record.fill) || !isHexColor(record.secondary)) return undefined
    if (!isGradientKind(record.gradient)) return undefined
    if (typeof record.fillTransparent !== 'boolean' || typeof record.secondaryTransparent !== 'boolean') {
      return undefined
    }
    const brushRaw = finiteOrUndefined(record.brushSize)
    if (brushRaw === undefined) return undefined
    const gradient = record.gradient as PendingShapePreviewDraw['gradient']
    if (gradient === 'solid') {
      return {
        paint: (record.fillTransparent as boolean) ? 'rgba(0, 0, 0, 0)' : (record.fill as string),
        lineWidth: Math.max(0, brushRaw),
      }
    }
    const [from, to] = resolveBitmapGradientStops(
      record.fillTransparent as boolean,
      record.fill as string,
      record.secondaryTransparent as boolean,
      record.secondary as string,
    )
    if (gradient === 'radial') {
      if (typeof context.createRadialGradient !== 'function') return undefined
      const centerX = x + width / 2
      const centerY = y + height / 2
      const radius = Math.max(1, Math.max(width, height) / 2)
      const created = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius)
      created.addColorStop(0, from.css)
      created.addColorStop(1, to.css)
      return { paint: created, lineWidth: Math.max(0, brushRaw) }
    }
    const created =
      gradient === 'vertical'
        ? context.createLinearGradient(x, y, x, y + height)
        : context.createLinearGradient(x, y, x + width, y)
    created.addColorStop(0, from.css)
    created.addColorStop(1, to.css)
    return { paint: created, lineWidth: Math.max(0, brushRaw) }
  } catch {
    return undefined
  }
}

/**
 * Paint ONE exclusive pass for a resolved draw via the shared
 * `paintBitmapRectOvalExclusive` (no duplicated rect/ellipse code). Returns
 * `true` on success, `false` (never throws) when the style cannot resolve or
 * the context fails. The caller owns restore-before-draw; this function
 * never reads back pixels.
 *
 * Rotation: a non-zero `draw.rotation` wraps the SAME exclusive painter in
 * `translate(center) + rotate(angle)` and paints the box CENTERED at the
 * origin (`-w/2, -h/2`), with the style resolved against that local box
 * AFTER the transform is applied. Canvas gradients resolve in the transform
 * in effect at paint time, so linear ramps rotate WITH the shape exactly
 * like a true vector rotation (no stop/color rewriting, no second painter).
 * The outlined contour keeps the shared brush width (rotation-invariant).
 */
export function paintPendingBitmapShapePreview(
  context: CanvasRenderingContext2D | undefined | null,
  draw: PendingShapePreviewDraw | undefined | null,
): boolean {
  try {
    if (!context || !draw) return false
    if (!isFiniteRecord(draw)) return false
    const rotationRaw = (draw as unknown as Record<string, unknown>).rotation
    let rotation = 0
    if (rotationRaw !== undefined) {
      if (typeof rotationRaw !== 'number' || !Number.isFinite(rotationRaw)) return false
      rotation = normalizePendingRotationDegrees(rotationRaw)
    }
    const affineRaw = (draw as unknown as Record<string, unknown>).affine
    let affine: PendingAffine2x3 = { ...PENDING_AFFINE_IDENTITY }
    if (affineRaw !== undefined) {
      if (!isValidAffineMatrix(affineRaw as PendingAffine2x3)) return false
      const det = (affineRaw as PendingAffine2x3).a * (affineRaw as PendingAffine2x3).d - (affineRaw as PendingAffine2x3).b * (affineRaw as PendingAffine2x3).c
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return false
      affine = { ...(affineRaw as PendingAffine2x3) }
    }
    const affineIdentity =
      affine.a === 1 && affine.b === 0 && affine.c === 0 && affine.d === 1 && affine.e === 0 && affine.f === 0
    if (Math.abs(rotation) < 1e-9 && affineIdentity) {
      const style = resolvePendingShapePreviewStyle(context, draw)
      if (!style) return false
      // Outlined with no width is a noop (mirrors the resolver verdict): fail
      // closed BEFORE touching the context so a stale `lineWidth` can never
      // paint a contour that should not exist.
      if (draw.mode === 'outlined' && !(style.lineWidth > 0)) return false
      try {
        withIsolatedPaintState(context, () => {
          if (draw.mode === 'outlined') {
            context.strokeStyle = style.paint
            if (Number.isFinite(style.lineWidth) && style.lineWidth > 0) context.lineWidth = style.lineWidth
          } else {
            context.fillStyle = style.paint
          }
          paintBitmapRectOvalExclusive(context, draw.kind, draw.box.x, draw.box.y, draw.box.width, draw.box.height, draw.mode, {
            fillStyle: style.paint,
            strokeStyle: style.paint as string,
            lineWidth: style.lineWidth,
          })
        })
      } catch {
        return false
      }
      return true
    }
    // Rotated and/or affine path: validate the local extents first (fail
    // closed before any transform), then paint centered in the
    // `affine * R` frame. The style resolves AFTER the full transform, so
    // gradients travel with the skewed shape exactly like a true vector
    // scale (`S * R`); the contour keeps the local brush width and the CTM
    // scales it (effective stroke scaling, no pre-scaling).
    const boxRecord = (draw as unknown as Record<string, unknown>).box
    if (!isFiniteRecord(boxRecord)) return false
    const box = boxRecord as unknown as Record<string, unknown>
    const x = finiteOrUndefined(box.x)
    const y = finiteOrUndefined(box.y)
    const width = finiteOrUndefined(box.width)
    const height = finiteOrUndefined(box.height)
    if (x === undefined || y === undefined || width === undefined || height === undefined) return false
    if (!(width > 0 && height > 0)) return false
    const centerX = x + width / 2
    const centerY = y + height / 2
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return false
    const local: PendingShapePreviewDraw = {
      ...draw,
      box: { x: -width / 2, y: -height / 2, width, height },
    }
    try {
      withIsolatedPaintState(context, () => {
        if (typeof context.translate !== 'function' || typeof context.rotate !== 'function') {
          throw new Error('rotation needs a transforming context')
        }
        if (typeof (context as CanvasRenderingContext2D).transform !== 'function' && !affineIdentity) {
          throw new Error('affine needs a transforming context')
        }
        if (!affineIdentity) {
          ;(context as CanvasRenderingContext2D).transform(affine.a, affine.b, affine.c, affine.d, affine.e, affine.f)
        }
        context.translate(centerX, centerY)
        if (Math.abs(rotation) >= 1e-9) context.rotate((rotation * Math.PI) / 180)
        // Resolve AFTER the transform: gradient coordinates are honored in
        // the transform in effect at paint time, so the ramp rotates with
        // the shape instead of staying screen-locked.
        const style = resolvePendingShapePreviewStyle(context, local)
        if (!style) throw new Error('rotated style unresolved')
        if (draw.mode === 'outlined' && !(style.lineWidth > 0)) throw new Error('zero brush')
        if (draw.mode === 'outlined') {
          context.strokeStyle = style.paint
          if (Number.isFinite(style.lineWidth) && style.lineWidth > 0) context.lineWidth = style.lineWidth
        } else {
          context.fillStyle = style.paint
        }
        paintBitmapRectOvalExclusive(context, draw.kind, -width / 2, -height / 2, width, height, draw.mode, {
          fillStyle: style.paint,
          strokeStyle: style.paint as string,
          lineWidth: style.lineWidth,
        })
      })
    } catch {
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Exact base restore (`putImageData` of the pre-stroke frame). Idempotent:
 * restoring twice yields the base byte-for-byte (pinned by the browser
 * test). Returns `false` (never throws) on a missing/failed context.
 */
export function restorePendingShapePreviewBase(
  context: CanvasRenderingContext2D | undefined | null,
  frame: ImageData | undefined | null,
): boolean {
  try {
    if (!context || !frame) return false
    context.putImageData(frame, 0, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Mint a detached same-size 2d context for the single-pass paint. Painting
 * offscreen (instead of on the visible context) is what makes the composite
 * immune to caller state: `putImageData` ignores transform/clip/alpha/
 * composite/filter, but every fill/stroke path honors them, so painting
 * directly on a dirty visible context would draw at the wrong coordinates
 * (zoom transform), with the wrong look (`globalAlpha`, `filter`, shadow,
 * dash, exotic composite), or nothing at all (a huge offscreen `clip()`).
 * The visible canvas is only ever touched by `putImageData` (state-free and
 * atomic), so an invalid input never mutates it and a partial failure leaves
 * either the untouched canvas or the exact base — never a half pass.
 */
function makeDetachedPaintContext(
  width: number,
  height: number,
): CanvasRenderingContext2D | undefined {
  try {
    const doc = (globalThis as { document?: unknown }).document as
      | { createElement?: (tag: string) => { width: number; height: number; getContext?: (kind: string) => unknown } }
      | undefined
    if (doc && typeof doc.createElement === 'function') {
      const canvas = doc.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext?.('2d') as CanvasRenderingContext2D | null | undefined
      if (ctx) return ctx
    }
  } catch {
    // Fall through to OffscreenCanvas / undefined.
  }
  try {
    const Offscreen = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas as
      | (new (width: number, height: number) => { getContext?: (kind: string) => unknown })
      | undefined
    if (typeof Offscreen === 'function') {
      const canvas = new Offscreen(width, height)
      const ctx = canvas.getContext?.('2d') as CanvasRenderingContext2D | null | undefined
      if (ctx) return ctx
    }
  } catch {
    // No detached canvas available (e.g. Bun unit mocks).
  }
  return undefined
}

/**
 * Single-pass composite: restore the immutable base, then paint the pending
 * shape exactly once, then read back a FRESH `ImageData` (the input base is
 * never mutated, so repeated renders from the same base can never
 * alpha-accumulate). Returns `undefined` (never throws) on refused shapes,
 * base/canvas mismatches, unreadable bases, oversized rasters, tainted or
 * throwing contexts — a failed paint restores the base before returning, so
 * the canvas never holds a half pass.
 *
 * State isolation: the paint runs on a detached canvas (clean identity
 * state, no caller transform/clip/alpha/composite/filter/shadow/dash); the
 * visible context is only ever touched by `putImageData` (which ignores all
 * of that state). Invalid inputs return BEFORE any visible `putImageData`,
 * so the visible canvas is bit-identical; a `createGradient`/paint/readback
 * failure restores the base before returning, so no half-pixel state leaks.
 *
 * Browser-only (`ImageData` construction + 2d context); the pure
 * resolve/copy/paint pieces above are DOM-free and unit-tested in Bun.
 */
export function compositePendingBitmapShapePreview(
  context: CanvasRenderingContext2D | undefined | null,
  base: PendingShapePreviewBase | ImageData | undefined | null,
  shape: PendingBitmapShape | undefined | null,
): ImageData | undefined {
  try {
    if (!context) return undefined
    const canvas = (context as CanvasRenderingContext2D).canvas as { width?: unknown; height?: unknown } | undefined
    const canvasWidth = canvas?.width
    const canvasHeight = canvas?.height
    if (!Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight)) return undefined
    const width = canvasWidth as number
    const height = canvasHeight as number
    const resolution = resolvePendingBitmapShapePreview(shape, { width, height })
    if (resolution.kind === 'refused') return undefined
    if (!isFiniteRecord(base)) return undefined
    const baseRecord = base as Record<string, unknown>
    if (baseRecord.width !== width || baseRecord.height !== height) return undefined
    const copy = copyPendingShapePreviewBase(base as PendingShapePreviewBase)
    if (!copy) return undefined
    const ImageDataCtor = (globalThis as { ImageData?: unknown }).ImageData
    if (typeof ImageDataCtor !== 'function') return undefined
    let frame: ImageData
    try {
      frame = new (ImageDataCtor as new (data: Uint8ClampedArray, width: number, height?: number) => ImageData)(
        copy.data,
        copy.width,
        copy.height,
      )
    } catch {
      return undefined
    }

    // Detached single-pass paint: the visible canvas stays untouched until
    // the final state-free `putImageData`. No detached canvas (Bun mocks) ->
    // fall back to the legacy direct path with the same restore guarantee.
    const detached = makeDetachedPaintContext(width, height)
    if (detached) {
      try {
        detached.putImageData(frame, 0, 0)
      } catch {
        return undefined
      }
      if (resolution.kind === 'draw') {
        let painted = false
        try {
          painted = paintPendingBitmapShapePreview(detached, resolution.draw)
        } catch {
          painted = false
        }
        if (!painted) return undefined
      }
      let result: ImageData
      try {
        result = detached.getImageData(0, 0, width, height)
      } catch {
        return undefined
      }
      try {
        context.putImageData(result, 0, 0)
      } catch {
        return undefined
      }
      try {
        return context.getImageData(0, 0, width, height)
      } catch {
        try {
          context.putImageData(frame, 0, 0)
        } catch {
          // Best effort only; the readback itself already failed.
        }
        return undefined
      }
    }

    try {
      context.putImageData(frame, 0, 0)
    } catch {
      return undefined
    }
    if (resolution.kind === 'draw') {
      let painted = false
      try {
        painted = paintPendingBitmapShapePreview(context, resolution.draw)
      } catch {
        painted = false
      }
      if (!painted) {
        // Fail closed: never leave a half pass behind.
        try {
          context.putImageData(frame, 0, 0)
        } catch {
          // The canvas is already unusable; nothing more to restore.
        }
        return undefined
      }
    }
    try {
      return context.getImageData(0, 0, width, height)
    } catch {
      try {
        context.putImageData(frame, 0, 0)
      } catch {
        // Best effort only; the readback itself already failed.
      }
      return undefined
    }
  } catch {
    return undefined
  }
}
