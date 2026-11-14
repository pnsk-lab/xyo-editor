/**
 * 回転ジェスチャの DOM / Paper 非依存な純粋幾何ヘルパー。
 *
 * 観測される Scratch Paint の振る舞いとの対応 (独立実装。AGPL ソースの
 * 複製ではない):
 *
 * - 任意角ハンドル: 選択の中心を支点に、pointerdown 位置と現在の
 *   pointer 位置が中心となす角度の差をそのまま回転量にする。
 *   角度は画面座標系 (y 下向き) の `atan2(dy, dx)` で測るため、
 *   視覚上の時計回りが正になる。これは本リポジトリの
 *   `bitmap-floating.ts` (`rotateFloatingPatch` の時計回り degree) や
 *   SVG `rotate(deg)` の正方向と一致する。
 * - Shift 45 度スナップ: 上の差分を 45 度刻み (`0, ±45, ±90, ...`) へ
 *   最近傍丸めする。押していない通常ドラッグは丸めない。
 * - キャンバス (ビットマップ) / ベクター (SVG) 共有: どちらも
 *   「同一座標系での `{ 中心, 開始点, 現時点 }`」に帰着できるので、
 *   本モジュールは座標系を持たず「度」だけを返す。呼び出し側が
 *   client px → world/SVG 単位へのズーム換算 (`toWorldPoint` 参照) と
 *   DOM / Paper への適用・履歴管理を担当する。
 *
 * 本モジュールは DOM (`Element`) も Paper.js も import しない。
 *
 * 角度の約束:
 * - 単位は度。時計回り (画面 y 下向き) が正。
 * - `normalizeRotationDegrees` は (-180, 180] に正規化する
 *   (`-180` は `180` へ寄せる)。
 * - 連続角 (unwrap) は `unwrapRotationDegrees` / `accumulateRotationStep`
 *   で扱う。±180 境界の瞬断を `±360` 補正で吸収し、複数回転の累積や
 *   巻き戻し (逆方向ドラッグで累積が減少) を正しく保つ。
 * - ズームは角度を変えない (等方スケール)。呼び出し側が本モジュールへ
 *   渡す前に client 差分を zoom で割ること。検証用に純粋な
 *   `toWorldPoint` / `toWorldDelta` を同梱する。
 */

/** 2D 点。呼び出し側が同一座標系 (world / SVG 単位) に揃えること。 */
export type RotationPoint = {
  x: number
  y: number
}

/** 修飾キー。`shiftKey` のみ回転量に影響する。 */
export type RotationModifiers = {
  /** true で 45 度スナップする。 */
  shiftKey?: boolean
}

/** Shift スナップ刻み。ベクター移動 (`vector-move-drag.ts`) と同じ 45 度。 */
export const ROTATION_SNAP_STEP_DEGREES = 45

/** スナップ刻み (ラジアン)。 */
export const ROTATION_SNAP_STEP_RADIANS = Math.PI / 4

/** 中心と一致とみなす距離の二乗。これ未満は角度不定 (ゼロ距離)。 */
const ROTATION_ZERO_DISTANCE_SQUARED = 1e-24

/** no-op 判定の既定しきい値 (度)。丸めゴミを履歴に積まないため。 */
export const ROTATION_NOOP_EPSILON_DEGREES = 1e-9

function isFinitePoint(point: RotationPoint): boolean {
  return (
    Boolean(point) &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  )
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI
}

/** 度 → ラジアン。Paper.js などのラジアン系 API へ渡すための便宜関数。 */
export function rotationDegreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** ラジアン → 度。 */
export function rotationRadiansToDegrees(radians: number): number {
  return toDegrees(radians)
}

/**
 * 中心から見た点の偏角 (度, 画面 y 下向き = 時計回り正)。
 * 中心と一致 (ゼロ距離)・非有限入力では `undefined`。
 */
export function rotationAngleOfPoint(
  center: RotationPoint,
  point: RotationPoint,
): number | undefined {
  if (!isFinitePoint(center) || !isFinitePoint(point)) return undefined
  const dx = point.x - center.x
  const dy = point.y - center.y
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return undefined
  if (dx * dx + dy * dy < ROTATION_ZERO_DISTANCE_SQUARED) return undefined
  return toDegrees(Math.atan2(dy, dx))
}

/**
 * 角度を (-180, 180] に正規化する。`-180` は `180` へ寄せる。
 * 非有限入力は `0`。
 */
export function normalizeRotationDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180
  // `%` の符号対策: `-180` ちょうどは `180` 側へ倒す。
  if (wrapped <= -180) return 180
  // `Object.is(-0)` 対策。
  return wrapped === 0 ? 0 : wrapped
}

/**
 * `from` → `to` の最短回転差分 (度, (-180, 180])。
 * 非有限入力は `0`。
 */
export function shortestRotationDeltaDegrees(fromDegrees: number, toDegreesValue: number): number {
  if (!Number.isFinite(fromDegrees) || !Number.isFinite(toDegreesValue)) return 0
  return normalizeRotationDegrees(toDegreesValue - fromDegrees)
}

/**
 * 生角度 `rawDegrees` を直前の連続角 `previousUnwrappedDegrees` に最も近い
 * 等価角 (`±360*k` 補正) へ寄せる。pointermove 列の瞬断 (±180 境界での
 * -179 ↔ 179 のような跳躍) を吸収するための純粋 unwrap。
 * いずれかが非有限なら `previousUnwrappedDegrees` (非有限なら `0`) を返す。
 */
export function unwrapRotationDegrees(
  previousUnwrappedDegrees: number,
  rawDegrees: number,
): number {
  const previous = Number.isFinite(previousUnwrappedDegrees) ? previousUnwrappedDegrees : 0
  if (!Number.isFinite(rawDegrees)) return previous
  return previous + shortestRotationDeltaDegrees(previous, rawDegrees)
}

/**
 * 角度を 45 度刻みへ最近傍丸めする。`snap` が falsy なら素通し。
 * 累積角 (複数回転で ±180 を超える値) の連続性を保つため正規化しない
 * (`370 → 360` のように 180 外の等価値も取り得る)。表示用には
 * `normalizeRotationDegrees` を別途適用すること。非有限入力は `0`。
 */
export function snapRotationDegrees(degrees: number, snap: boolean): number {
  if (!Number.isFinite(degrees)) return 0
  if (!snap) return degrees
  return Math.round(degrees / ROTATION_SNAP_STEP_DEGREES) * ROTATION_SNAP_STEP_DEGREES
}

export type RotationDeltaResolution = {
  /** 開始点の偏角 (度)。ゼロ距離では `undefined`。 */
  startAngleDegrees: number | undefined
  /** 現時点の偏角 (度)。ゼロ距離では `undefined`。 */
  currentAngleDegrees: number | undefined
  /** 最短差分 (`current - start`, 度)。不定時は `0`。 */
  deltaDegrees: number
  /** 両端点とも角度確定したか。 */
  valid: boolean
}

/**
 * 開始点→現時点の回転差分を求める。どちらかが中心と一致すれば
 * `valid: false, deltaDegrees: 0` (クリック・中心上押下は no-op)。
 */
export function resolveRotationDelta(
  center: RotationPoint,
  start: RotationPoint,
  current: RotationPoint,
): RotationDeltaResolution {
  const startAngle = rotationAngleOfPoint(center, start)
  const currentAngle = rotationAngleOfPoint(center, current)
  if (startAngle === undefined || currentAngle === undefined) {
    return {
      startAngleDegrees: startAngle,
      currentAngleDegrees: currentAngle,
      deltaDegrees: 0,
      valid: false,
    }
  }
  return {
    startAngleDegrees: startAngle,
    currentAngleDegrees: currentAngle,
    deltaDegrees: shortestRotationDeltaDegrees(startAngle, currentAngle),
    valid: true,
  }
}

export type RotationGestureResolution = RotationDeltaResolution & {
  /** Shift 適用後のスナップ済み差分 (度)。非 Shift 時は `deltaDegrees` と等しい。 */
  snappedDeltaDegrees: number
  /** 実際に適用すべき差分 = スナップ済み差分 (度)。 */
  appliedDeltaDegrees: number
  /** Shift スナップが適用されたか。 */
  snapped: boolean
  /** 履歴・DOM に触る必要がない (不定・微小) か。 */
  noop: boolean
}

/**
 * 1 ジェスチャ分の回転量を解決する。`rawDelta` (最短差分) に対して
 * Shift 時のみ 45 度スナップし、微小・不定は `noop: true` とする。
 * `baseDegrees` (操作開始時の既存回転角) には触らない。呼び出し側が
 * `baseDegrees + appliedDeltaDegrees` を要素へ適用すること (絶対角への
 * スナップではなく差分へのスナップである点に注意)。
 */
export function resolveRotationGesture(
  center: RotationPoint,
  start: RotationPoint,
  current: RotationPoint,
  modifiers: RotationModifiers = {},
): RotationGestureResolution {
  const base = resolveRotationDelta(center, start, current)
  const snap = modifiers.shiftKey === true
  const snappedDelta = snap ? snapRotationDegrees(base.deltaDegrees, true) : base.deltaDegrees
  const noop = !base.valid || !Number.isFinite(snappedDelta) || Math.abs(snappedDelta) < ROTATION_NOOP_EPSILON_DEGREES
  return {
    ...base,
    snappedDeltaDegrees: snappedDelta,
    appliedDeltaDegrees: snappedDelta,
    snapped: snap,
    noop,
  }
}

/** `appliedDeltaDegrees` が履歴に積む価値のない微小量か。 */
export function isRotationNoop(deltaDegrees: number, epsilon = ROTATION_NOOP_EPSILON_DEGREES): boolean {
  if (!Number.isFinite(deltaDegrees)) return true
  return Math.abs(deltaDegrees) < epsilon
}

export type RotationStepAccumulation = {
  /** 更新後の累積角 (度。複数回転で ±180 を超え得る)。 */
  cumulativeDegrees: number
  /** 今回ステップの最短差分 (度)。不定時は `0`。 */
  stepDeltaDegrees: number
  /** 両端点とも角度確定したか。不定時は累積を据え置く。 */
  valid: boolean
}

/**
 * pointermove 列の 1 ステップ分を累積へ加算する純粋 unwrap。
 * `previousPoint → currentPoint` の最短差分を足すだけなので、±180 境界の
 * 跳躍は吸収され、多回転は `±360` を超えて蓄積し、巻き戻し (逆方向) は
 * 減算になる。どちらかがゼロ距離・非有限なら据え置き
 * (`valid: false, stepDeltaDegrees: 0`)。
 */
export function accumulateRotationStep(
  previousCumulativeDegrees: number,
  center: RotationPoint,
  previousPoint: RotationPoint,
  currentPoint: RotationPoint,
): RotationStepAccumulation {
  const previous = Number.isFinite(previousCumulativeDegrees) ? previousCumulativeDegrees : 0
  const from = rotationAngleOfPoint(center, previousPoint)
  const to = rotationAngleOfPoint(center, currentPoint)
  if (from === undefined || to === undefined) {
    return { cumulativeDegrees: previous, stepDeltaDegrees: 0, valid: false }
  }
  const step = shortestRotationDeltaDegrees(from, to)
  return { cumulativeDegrees: previous + step, stepDeltaDegrees: step, valid: true }
}

export type RotationPathAccumulation = {
  /** 全ステップ適用後の累積角 (度)。 */
  cumulativeDegrees: number
  /** 各ステップの最短差分列 (度)。不定ステップは `0`。 */
  stepDeltas: number[]
  /** 全ステップ有効だったか。 */
  valid: boolean
}

/**
 * 点列全体の累積角を求める (`accumulateRotationStep` の畳み込み)。
 * 空列・単点は `0`。不定ステップは飛ばして据え置き、`valid` は false。
 */
export function accumulateRotationPath(
  center: RotationPoint,
  points: readonly RotationPoint[],
  initialCumulativeDegrees = 0,
): RotationPathAccumulation {
  let cumulative = Number.isFinite(initialCumulativeDegrees) ? initialCumulativeDegrees : 0
  const stepDeltas: number[] = []
  let valid = true
  for (let index = 1; index < points.length; index++) {
    const step = accumulateRotationStep(cumulative, center, points[index - 1]!, points[index]!)
    cumulative = step.cumulativeDegrees
    stepDeltas.push(step.stepDeltaDegrees)
    if (!step.valid) valid = false
  }
  return { cumulativeDegrees: cumulative, stepDeltas, valid }
}

/**
 * client (画面 px) 座標をワールド/SVG 単位へ換算する。ズームは等方
 * スケールとみなし角度計算の前に割る。`zoom` が非有限・0 なら `1` 扱い。
 * 回転角自体はズーム不変なので、本モジュールの角度関数は換算後の点を
 * 受け取ること。
 */
export function toWorldPoint(
  client: RotationPoint,
  viewportOrigin: RotationPoint,
  zoom: number,
): RotationPoint {
  const safeZoom = Number.isFinite(zoom) && zoom !== 0 ? zoom : 1
  const originX = Number.isFinite(viewportOrigin.x) ? viewportOrigin.x : 0
  const originY = Number.isFinite(viewportOrigin.y) ? viewportOrigin.y : 0
  const clientX = Number.isFinite(client.x) ? client.x : 0
  const clientY = Number.isFinite(client.y) ? client.y : 0
  return {
    x: (clientX - originX) / safeZoom,
    y: (clientY - originY) / safeZoom,
  }
}

/** client 差分 (px) をワールド差分へ換算する (`zoom` 扱いは `toWorldPoint` と同じ)。 */
export function toWorldDelta(delta: RotationPoint, zoom: number): RotationPoint {
  const safeZoom = Number.isFinite(zoom) && zoom !== 0 ? zoom : 1
  const dx = Number.isFinite(delta.x) ? delta.x : 0
  const dy = Number.isFinite(delta.y) ? delta.y : 0
  return { x: dx / safeZoom, y: dy / safeZoom }
}
