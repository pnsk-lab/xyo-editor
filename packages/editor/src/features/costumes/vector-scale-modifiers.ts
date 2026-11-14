import type { VectorResizeHandle } from '../../lib/editor-types'

/**
 * ベクトルリサイズの倍率計算を行う純粋モジュール (`paper` 非依存)。
 * `paper-vector.ts` の `resizeScaleForHandle` から呼ばれ、
 * `resizeVectorElementBy` 経由でドラッグ操作に適用される。
 *
 * - 角ハンドル (`nw`/`ne`/`se`/`sw`) は通常等比、Shift 押下で自由比。
 *   辺ハンドル (`n`/`e`/`s`/`w`) は常に自由比。
 * - 通常時の基準点 (pivot) は対角の固定点。Alt 押下ではバウンズ中心にし、
 *   中心からの距離変化を 2 倍換算する (両側へ広がる中心拡大と等価)。
 * - 固定点超過は符号を保ったまま負倍率 (反転) として返し、
 *   微小・非有限値は `clampVectorScaleFactor` で丸める。
 * - `dx`/`dy` は開始時からの総移動量 (SVG 単位。座標変換は呼び出し側) を受け、
 *   開始時スナップショットへ一発適用する絶対倍率 `{ pivot, scaleX, scaleY }` を返す。
 */

export const MIN_VECTOR_SCALE_FACTOR = 0.001

export type VectorScaleBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type VectorScaleModifiers = {
  /** true で角ハンドルを自由比にする (辺ハンドルは常に自由比)。 */
  shiftKey?: boolean
  /** true で基準点をバウンズ中心にする。 */
  altKey?: boolean
}

export type VectorScalePivot = {
  x: number
  y: number
}

export type VectorScaleResult = {
  /** `item.scale(scaleX, scaleY, pivot)` の基準点 (SVG 単位)。 */
  pivot: VectorScalePivot
  /** X 軸の絶対倍率。負値は左右反転を表す。 */
  scaleX: number
  /** Y 軸の絶対倍率。負値は上下反転を表す。 */
  scaleY: number
  /** 等比統一が適用されたかどうか。 */
  isUniform: boolean
  /** 中心基準 (Alt) が適用されたかどうか。 */
  isCentered: boolean
  /** `scaleX < 0` と同値。反転表示などの判定用。 */
  flippedX: boolean
  /** `scaleY < 0` と同値。反転表示などの判定用。 */
  flippedY: boolean
}

/** 角ハンドル (`nw`/`ne`/`se`/`sw`) なら true。 */
export function isCornerResizeHandle(handle: VectorResizeHandle): boolean {
  return handle.length === 2
}

function boundsCenter(bounds: VectorScaleBounds): VectorScalePivot {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

/** ドラッグ中のハンドル初期位置。辺と無関係な軸は中心線上で固定される。 */
function grabbedPoint(handle: VectorResizeHandle, bounds: VectorScaleBounds): VectorScalePivot {
  const center = boundsCenter(bounds)
  return {
    x: handle.includes('w') ? bounds.x : handle.includes('e') ? bounds.x + bounds.width : center.x,
    y: handle.includes('n') ? bounds.y : handle.includes('s') ? bounds.y + bounds.height : center.y,
  }
}

/** 通常時の固定点 = ドラッグ中ハンドルの対角。Alt 時は呼び出し側で中心に置き換える。 */
function opposingPoint(handle: VectorResizeHandle, bounds: VectorScaleBounds): VectorScalePivot {
  const center = boundsCenter(bounds)
  return {
    x: handle.includes('w') ? bounds.x + bounds.width : handle.includes('e') ? bounds.x : center.x,
    y: handle.includes('n') ? bounds.y + bounds.height : handle.includes('s') ? bounds.y : center.y,
  }
}

function axisHasSize(value: number): boolean {
  return Math.abs(value) > 1e-7
}

/** 符号を保ったまま微小倍率を下限へ丸める。非有限は等倍扱い。 */
export function clampVectorScaleFactor(value: number): number {
  if (!Number.isFinite(value)) return 1
  if (Math.abs(value) >= MIN_VECTOR_SCALE_FACTOR) return value
  return value < 0 ? -MIN_VECTOR_SCALE_FACTOR : MIN_VECTOR_SCALE_FACTOR
}

/**
 * ハンドル操作に対する絶対倍率と基準点を求める。
 *
 * @param handle リサイズハンドル (`VectorResizeHandle`)。
 * @param bounds リサイズ対象のバウンズ (Paper の `item.bounds` 相当)。
 * @param dx ハンドルの X 移動量 (SVG 単位・開始時からの総量)。
 * @param dy ハンドルの Y 移動量 (SVG 単位・開始時からの総量)。
 * @param modifiers 修飾キー。`shiftKey` で自由比、`altKey` で中心基準。
 */
export function resolveVectorScale(
  handle: VectorResizeHandle,
  bounds: VectorScaleBounds,
  dx: number,
  dy: number,
  modifiers: VectorScaleModifiers = {},
): VectorScaleResult {
  const center = boundsCenter(bounds)
  const grabbed = grabbedPoint(handle, bounds)
  const opposing = opposingPoint(handle, bounds)
  const spanX = grabbed.x - opposing.x
  const spanY = grabbed.y - opposing.y

  const movedX = grabbed.x + (handle.includes('w') || handle.includes('e') ? dx : 0)
  const movedY = grabbed.y + (handle.includes('n') || handle.includes('s') ? dy : 0)

  // 中心基準では「中心からの距離の変化」を両側分として 2 倍にする。
  // 分母は対角基準の元サイズのままなので、通常時と同一スケール定義になる。
  const currentX = modifiers.altKey ? (movedX - center.x) * 2 : movedX - opposing.x
  const currentY = modifiers.altKey ? (movedY - center.y) * 2 : movedY - opposing.y

  let scaleX = handle.includes('w') || handle.includes('e')
    ? axisHasSize(spanX)
      ? currentX / spanX
      : 1
    : 1
  let scaleY = handle.includes('n') || handle.includes('s')
    ? axisHasSize(spanY)
      ? currentY / spanY
      : 1
    : 1

  let isUniform = false
  if (isCornerResizeHandle(handle) && !modifiers.shiftKey) {
    const magnitude = Math.max(Math.abs(scaleX), Math.abs(scaleY))
    scaleX = (scaleX < 0 ? -1 : 1) * magnitude
    scaleY = (scaleY < 0 ? -1 : 1) * magnitude
    isUniform = true
  }

  scaleX = clampVectorScaleFactor(scaleX)
  scaleY = clampVectorScaleFactor(scaleY)

  // 等比判定はクランプ後も維持する (微小値へ丸められても統一済みであるため)。
  // 自由比・辺ハンドルでは false のまま。

  return {
    pivot: modifiers.altKey ? { ...center } : { ...opposing },
    scaleX,
    scaleY,
    isUniform,
    isCentered: Boolean(modifiers.altKey),
    flippedX: scaleX < 0,
    flippedY: scaleY < 0,
  }
}

/**
 * 基準点まわりの倍率を 1 点へ適用する。反転 (負倍率) を含む座標検証用。
 *
 * `item.scale(sx, sy, pivot)` と同じアフィン変換の純粋版。
 */
export function applyVectorScaleToPoint(
  point: VectorScalePivot,
  pivot: VectorScalePivot,
  scaleX: number,
  scaleY: number,
): VectorScalePivot {
  return {
    x: pivot.x + (point.x - pivot.x) * scaleX,
    y: pivot.y + (point.y - pivot.y) * scaleY,
  }
}
