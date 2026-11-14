import type { VectorResizeHandle } from '../../lib/editor-types'
import {
  MIN_VECTOR_SCALE_FACTOR,
  resolveVectorScale,
  type VectorScaleModifiers,
  type VectorScaleResult,
} from './vector-scale-modifiers'

/**
 * 複数選択の一括拡縮のための DOM / Paper 非依存の純粋幾何ヘルパー。
 *
 * 単体リサイズ (`vector-scale-modifiers.ts` + `paper-vector.ts`) と同じ操作意味を
 * 選択全体の共通バウンズ (union) へ拡張する:
 *
 * - 通常時は対角の固定点、Alt 押下時は共通バウンズ中心を基準にする。
 * - 角ハンドルは通常等比・Shift で自由比、辺ハンドルは常に片軸 (Shift 非依存)。
 * - 固定点の超過は符号を保ったまま負倍率 (反転) として返す。
 * - `dx`/`dy` は開始時からの総移動量 (ワールド単位) を受け、開始時スナップ
 *   ショットへ一発適用する絶対倍率を返す。
 *
 * 本モジュールは DOM (`Element`) も Paper.js も import しない。DOM への適用・
 * 履歴管理・Paper 適用は呼び出し側が担当する。
 *
 * 座標系の約束:
 * - バウンズ・`dx`/`dy`・ピボットは同一ワールド座標系。呼び出し側は単体
 *   バウンズの union (祖先 transform 込み) を渡す。
 * - 要素ローカル行列は祖先行列 `A` から `L = A^-1 * W * A` で求め、既存
 *   transform の前に付加 (`matrix(...) <existing>`) する。Paper の要素ごとの
 *   `item.scale(sx, sy, pivot)` は不可 (自バウンズ基準では配置が崩れる)。
 */

export type VectorMatrix6 = [number, number, number, number, number, number]

export type VectorMultiScaleBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type VectorMultiScaleModifiers = VectorScaleModifiers

export type VectorMultiScaleResult = VectorScaleResult & {
  /** ワールド座標系での一括拡縮行列 (`T(pivot) * S * T(-pivot)` と等価)。 */
  world: VectorMatrix6
  /** 等倍 (`scaleX === 1 && scaleY === 1`)。DOM に触らず履歴も積まないこと。 */
  noop: boolean
}

export { MIN_VECTOR_SCALE_FACTOR }

const IDENTITY_MATRIX: VectorMatrix6 = [1, 0, 0, 1, 0, 0]

function isFiniteMatrix(matrix: VectorMatrix6): boolean {
  return matrix.every((value) => Number.isFinite(value))
}

/** 行列積 `left * right` (SVG の `matrix(a b c d e f)` 順序)。 */
export function multiplyVectorMatrix6(left: VectorMatrix6, right: VectorMatrix6): VectorMatrix6 {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

/** 逆行列。特異行列では `vector-svg.ts` と同じく単位行列へフォールバックする。 */
export function invertVectorMatrix6(matrix: VectorMatrix6): VectorMatrix6 {
  const inverted = tryInvertVectorMatrix6(matrix)
  if (!inverted) return [...IDENTITY_MATRIX] as VectorMatrix6
  return inverted
}

/**
 * 明示的な fail-closed 逆行列 (DOM 書込用)。安全に可逆な場合のみ逆行列を
 * 返し、特異 (det==0)・非有限エントリ/行列式・オーバーフロー逆行列では
 * `null` を返す。呼出側は `null` を「DOM/履歴無変更で拒否」として扱い、
 * 単位行列フォールバックで写像してはならない。可逆な微小スケール
 * (`scale(1e-12)` 等) は有限逆行列を返す (増幅は設計判断として許容)。
 */
export function tryInvertVectorMatrix6(matrix: VectorMatrix6 | undefined | null): VectorMatrix6 | null {
  try {
    if (!matrix || matrix.length < 6) return null
    for (let index = 0; index < 6; index++) {
      if (!Number.isFinite(matrix[index])) return null
    }
    const determinant = matrix[0]! * matrix[3]! - matrix[1]! * matrix[2]!
    if (!determinant || !Number.isFinite(determinant)) return null
    const inverse: VectorMatrix6 = [
      matrix[3]! / determinant,
      -matrix[1]! / determinant,
      -matrix[2]! / determinant,
      matrix[0]! / determinant,
      (matrix[2]! * matrix[5]! - matrix[3]! * matrix[4]!) / determinant,
      (matrix[1]! * matrix[4]! - matrix[0]! * matrix[5]!) / determinant,
    ]
    for (let index = 0; index < 6; index++) {
      if (!Number.isFinite(inverse[index])) return null
    }
    return inverse
  } catch {
    return null
  }
}

/** 点へ行列を適用する (`paper-vector.ts` の `item.scale` と同じアフィン変換)。 */
export function transformVectorPoint6(
  matrix: VectorMatrix6,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
  }
}

/**
 * 基準点まわりの拡縮をワールド行列化する。
 * `T(pivot) * S(sx, sy) * T(-pivot)` の合成であり、負倍率は反転として含む。
 */
export function worldScaleMatrix6(
  pivot: { x: number; y: number },
  scaleX: number,
  scaleY: number,
): VectorMatrix6 {
  const px = Number.isFinite(pivot.x) ? pivot.x : 0
  const py = Number.isFinite(pivot.y) ? pivot.y : 0
  const sx = Number.isFinite(scaleX) ? scaleX : 1
  const sy = Number.isFinite(scaleY) ? scaleY : 1
  return [sx, 0, 0, sy, px - sx * px, py - sy * py]
}

/**
 * ワールド行列を祖先行列で共役化し、要素ローカルな付加行列へ変換する。
 * 祖先なし (`undefined`) はワールド行列をそのまま返す。
 * 特異・非有限な祖先/ワールド行列では `null` を返し、呼出側は DOM/履歴に
 * 触れず拒否すること (単位行列フォールバックの `W*A` 書込は不可)。
 */
export function conjugateWorldMatrix6(
  ancestor: VectorMatrix6 | undefined,
  world: VectorMatrix6,
): VectorMatrix6 | null {
  if (!ancestor) return [...world] as VectorMatrix6
  if (!isFiniteMatrix(ancestor) || !isFiniteMatrix(world)) return null
  const inverse = tryInvertVectorMatrix6(ancestor)
  if (!inverse) return null
  const local = multiplyVectorMatrix6(multiplyVectorMatrix6(inverse, world), ancestor)
  if (!isFiniteMatrix(local)) return null
  return local
}

/**
 * 共通バウンズに対する絶対倍率とワールド行列を求める。
 * 倍率の意味は `resolveVectorScale` と同一 (等比/自由比・Alt 中心・負倍率反転・
 * 微小値クランプ)。`noop` が true のとき呼び出し側は DOM に触らないこと
 * (空 Undo を積まない契約。単体の `resizeVectorElementBy` と同等)。
 */
export function resolveCommonVectorScale(
  handle: VectorResizeHandle,
  commonBounds: VectorMultiScaleBounds,
  dx: number,
  dy: number,
  modifiers: VectorMultiScaleModifiers = {},
): VectorMultiScaleResult {
  const base = resolveVectorScale(
    handle,
    { x: commonBounds.x, y: commonBounds.y, width: commonBounds.width, height: commonBounds.height },
    dx,
    dy,
    modifiers,
  )
  const world = worldScaleMatrix6(base.pivot, base.scaleX, base.scaleY)
  const noop = base.scaleX === 1 && base.scaleY === 1
  return { ...base, world, noop }
}

/**
 * 1 要素分の付加ローカル行列を求める。`ancestor` はその要素の
 * `ancestorWorldMatrix(element)` 相当 (要素自身の transform を含まない)。
 * 祖先が異なる選択でも各要素がこの行列を既存 transform の前に付加すれば、
 * 全体が 1 つの `world` 通りに拡縮される。特異・非有限では `null` を返し、
 * 呼出側は書込を拒否すること。
 */
export function localScaleMatrixForAncestor(
  ancestor: VectorMatrix6 | undefined,
  world: VectorMatrix6,
): VectorMatrix6 | null {
  return conjugateWorldMatrix6(ancestor, world)
}

/** 共通バウンズ操作 1 回分のワールド行列から各要素のローカル行列を一括生成する。 */
export function localScaleMatricesForSelection(
  ancestors: Array<VectorMatrix6 | undefined>,
  world: VectorMatrix6,
): Array<VectorMatrix6 | null> {
  return ancestors.map((ancestor) => conjugateWorldMatrix6(ancestor, world))
}

/** バウンズの和集合 (共通バウンズ)。空・非有限のみの入力では `undefined`。 */
export function unionVectorScaleBounds(
  boundsList: VectorMultiScaleBounds[],
): VectorMultiScaleBounds | undefined {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const bounds of boundsList) {
    if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) continue
    if (bounds.width <= 0 && bounds.height <= 0) continue
    left = Math.min(left, bounds.x)
    top = Math.min(top, bounds.y)
    right = Math.max(right, bounds.x + bounds.width)
    bottom = Math.max(bottom, bounds.y + bounds.height)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return undefined
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

function formatMatrixNumber6(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(4))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

/** `transform` 属性に前置できる `matrix(a b c d e f)` 文字列へ変換する。 */
export function formatVectorMatrix6Attribute(matrix: VectorMatrix6): string {
  return `matrix(${matrix.map(formatMatrixNumber6).join(' ')})`
}

/**
 * 既存 `transform` の前にローカル行列を付加した属性値を返す。
 * 適用順序 (`L * existing`) と文書順序 (重なり順) を変えないための純粋版。
 * DOM への書き込み自体は呼び出し側が行う。
 */
export function prependVectorMatrix6Attribute(existing: string, local: VectorMatrix6): string {
  const head = formatVectorMatrix6Attribute(local)
  const body = (existing ?? '').trim()
  return body ? `${head} ${body}` : head
}

/** 等倍なら DOM 更新不要 (履歴を積まない)。 */
export function isNoopVectorScale(scaleX: number, scaleY: number): boolean {
  return scaleX === 1 && scaleY === 1
}
