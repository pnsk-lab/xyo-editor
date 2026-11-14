// reshape の選択アンカーに対する曲線化 (Curved) / 直線化 (Pointed) ヘルパー。
//
// 位置づけ: `vector-path-points.ts` が点の追加・削除を担うのに対し、この
// モジュールは既存アンカーのハンドル形状だけを切り替える。Paper.js の
// Segment / Curve に対して作用し、アンカー座標・点数・パスの開閉は変えない。
//
// 座標と保存の契約 (既存ヘルパーと共有):
// - flattened index は `vector-path-points.ts` の Paper 方式
//   (アンカー枠、次に非ゼロの in ハンドル枠、out ハンドル枠) と同一であり、
//   解決には同モジュールの `resolvePaperPoint` / `collectEditablePaths` を
//   そのまま使う。独自の順序付けは持たない。
// - DOM ラッパーは要素単体で Paper に取り込み (要素自身の transform は保持、
//   祖先は保持されない)、`ancestorWorldMatrix` の逆写像で文書座標に戻す。
//   書戻しは編集されたパスの `d` (または形状→パス置換) だけに触れ、ラッパーの
//   transform・継承ペイント・兄弟要素・スタイルは原文のまま残す。
//
// 安全契約:
// - 閉パス: 添字 wrap で両隣を参照し、端点扱いにしない。
// - 開パスの端点: 接続側だけに単片ハンドルを作る。非接続側は作らない・消さない。
// - ゼロハンドル: 長さ 0 のベクトルを正規化しない。縮退時はその点を skip する。
// - transform: アンカー座標自体を動かさないため順方向の写像は不要。書戻し時は
//   ユニット内行列の逆行列を分離クローンに適用し、実アイテムの添字対応を保つ。
// - 近隣曲線: 対象セグメントの handleIn / handleOut 以外に触れない。点の追加・
//   削除・座標移動は行わないため、対象外のカーブ形状は不変である。
//
// 注意: scratch-paint 由来の実装は参照していない (AGPL コードの複写を避ける
// ため、振る舞いのみを文書化して独自に実装した)。数値や判定式の一致は
// 数学的事実の範囲に留め、コードの転写は行わない。

import { ensureVectorPaperScope } from './paper-vector'
import {
  collectEditablePaths,
  expandShapesToPaths,
  isPathPointEditableElement,
  resolvePaperPoint,
} from './vector-path-points'
import { SVG_PLACEHOLDER, cleanSvgElementAttributes, sanitizeSvgFragmentForPaperImport } from './svg-sanitize'
import {
  ancestorWorldMatrix,
  tryInvertVectorMatrix,
  worldTransformMatrix,
} from './vector-svg'

/** ハンドル長とみなさない微小長のしきい値。既存表示系 (0.001) と一致させる。 */
const STYLE_ZERO_EPS = 0.001

/**
 * 付与ハンドルの長さ係数 (接続カーブ長に対する比)。
 * 丸みが過大にならず、直線上の点では見た目を変えない程度の経験値。
 */
const STYLE_HANDLE_RATIO = 0.39

export type VectorPointStyleIssue =
  | 'not-found'
  | 'control-point'
  | 'isolated'
  | 'degenerate'
  | 'already-styled'

export type VectorPointStyleSkipped = {
  index: number
  reason: VectorPointStyleIssue
}

export type VectorPointStyleBulkResult = {
  changedIndices: number[]
  skipped: VectorPointStyleSkipped[]
}

export type VectorPointStyleDomReason = 'not-editable' | 'import-failed' | 'no-path'

export type VectorPointStyleDomResult = {
  changed: boolean
  changedIndices: number[]
  skipped: VectorPointStyleSkipped[]
  reason?: VectorPointStyleDomReason | VectorPointStyleIssue
}

function isZeroStyleVector(point: paper.Point): boolean {
  return Math.abs(point.x) < STYLE_ZERO_EPS && Math.abs(point.y) < STYLE_ZERO_EPS
}

function styleVectorLength(point: paper.Point): number {
  const length = (point as unknown as { length?: unknown }).length
  return typeof length === 'number' && Number.isFinite(length) ? length : Math.hypot(point.x, point.y)
}

/** 2 本のハンドルが逆向きに一直線 (スムーズ) かを判定する。 */
function areSmoothHandles(handleIn: paper.Point, handleOut: paper.Point): boolean {
  if (isZeroStyleVector(handleIn) || isZeroStyleVector(handleOut)) return false
  const inLength = styleVectorLength(handleIn)
  const outLength = styleVectorLength(handleOut)
  if (!Number.isFinite(inLength) || !Number.isFinite(outLength) || inLength <= 0 || outLength <= 0) return false
  const cross = handleIn.x * handleOut.y - handleIn.y * handleOut.x
  const tolerance = Math.max(0.001, inLength * outLength * 0.001)
  if (Math.abs(cross) > tolerance) return false
  // 同じ向きに重なった cusp はスムーズとみなさない (参照実装より厳密化)。
  return handleIn.x * handleOut.x + handleIn.y * handleOut.y < 0
}

type StyleNeighbors = {
  previous: paper.Segment | undefined
  next: paper.Segment | undefined
  incoming: paper.Curve | undefined
  outgoing: paper.Curve | undefined
}

/** 開閉を考慮して両隣セグメントと接続カーブを求める。添字演算のみで行う。 */
function styleNeighbors(path: paper.Path, segmentIndex: number): StyleNeighbors {
  const segments = path.segments
  const curves = path.curves ?? []
  if (path.closed) {
    const count = segments.length
    if (count === 0) return { previous: undefined, next: undefined, incoming: undefined, outgoing: undefined }
    return {
      previous: segments[(segmentIndex - 1 + count) % count],
      next: segments[(segmentIndex + 1) % count],
      incoming: curves[(segmentIndex - 1 + curves.length) % Math.max(1, curves.length)],
      outgoing: curves[segmentIndex % Math.max(1, curves.length)],
    }
  }
  return {
    previous: segmentIndex > 0 ? segments[segmentIndex - 1] : undefined,
    next: segmentIndex < segments.length - 1 ? segments[segmentIndex + 1] : undefined,
    incoming: segmentIndex > 0 ? curves[segmentIndex - 1] : undefined,
    outgoing: segmentIndex < curves.length ? curves[segmentIndex] : undefined,
  }
}

function styleCurveLength(curve: paper.Curve | undefined): number | undefined {
  if (!curve) return undefined
  const length = (curve as unknown as { length?: unknown }).length
  return typeof length === 'number' && Number.isFinite(length) && length > STYLE_ZERO_EPS ? length : undefined
}

function safeCurveNormal(curve: paper.Curve | undefined, time: 0 | 1): paper.Point | undefined {
  if (!curve) return undefined
  try {
    const getNormal = (curve as unknown as { getNormalAtTime?: (time: number) => paper.Point }).getNormalAtTime
    if (typeof getNormal !== 'function') return undefined
    const normal = getNormal.call(curve, time)
    if (!normal || !Number.isFinite(normal.x) || !Number.isFinite(normal.y)) return undefined
    return isZeroStyleVector(normal) ? undefined : normal
  } catch {
    return undefined
  }
}

function safeCurveConvexity(curve: paper.Curve | undefined): 1 | -1 {
  if (!curve) return 1
  try {
    const getCurvature = (curve as unknown as { getCurvatureAtTime?: (time: number) => number }).getCurvatureAtTime
    if (typeof getCurvature !== 'function') return 1
    const value = getCurvature.call(curve, 0.5)
    if (!Number.isFinite(value)) return 1
    return value < 0 ? -1 : 1
  } catch {
    return 1
  }
}

// アンカーの表示スタイルを分類する。制御ハンドル枠・範囲外は undefined。
// 孤立点 (接続カーブなし) はどちらにも属さないため undefined を返す。
export function classifyPaperPointStyle(
  item: paper.Item,
  pointIndex: number,
): 'curved' | 'pointed' | undefined {
  const resolved = resolvePaperPoint(item, pointIndex)
  if (!resolved || resolved.kind !== 'anchor') return undefined
  const neighbors = styleNeighbors(resolved.path, resolved.segmentIndex)
  const hasPrev = Boolean(neighbors.previous)
  const hasNext = Boolean(neighbors.next)
  if (!hasPrev && !hasNext) return undefined
  const handleIn = resolved.segment.handleIn
  const handleOut = resolved.segment.handleOut
  if (hasPrev && hasNext) return areSmoothHandles(handleIn, handleOut) ? 'curved' : 'pointed'
  if (hasPrev) return !isZeroStyleVector(handleIn) ? 'curved' : 'pointed'
  return !isZeroStyleVector(handleOut) ? 'curved' : 'pointed'
}

export function canCurvePaperPoint(
  item: paper.Item,
  pointIndex: number,
): { ok: boolean; reason?: VectorPointStyleIssue } {
  const resolved = resolvePaperPoint(item, pointIndex)
  if (!resolved) return { ok: false, reason: 'not-found' }
  if (resolved.kind !== 'anchor') return { ok: false, reason: 'control-point' }
  const neighbors = styleNeighbors(resolved.path, resolved.segmentIndex)
  if (!neighbors.previous && !neighbors.next) return { ok: false, reason: 'isolated' }
  if (classifyPaperPointStyle(item, pointIndex) === 'curved') return { ok: false, reason: 'already-styled' }
  return { ok: true }
}

export function canPointPaperPoint(
  item: paper.Item,
  pointIndex: number,
): { ok: boolean; reason?: VectorPointStyleIssue } {
  const resolved = resolvePaperPoint(item, pointIndex)
  if (!resolved) return { ok: false, reason: 'not-found' }
  if (resolved.kind !== 'anchor') return { ok: false, reason: 'control-point' }
  const segment = resolved.segment
  if (isZeroStyleVector(segment.handleIn) && isZeroStyleVector(segment.handleOut)) {
    // ハンドルを持たない孤立点・端点は直線化の対象外 (変更なし)。
    const neighbors = styleNeighbors(resolved.path, resolved.segmentIndex)
    if (!neighbors.previous && !neighbors.next) return { ok: false, reason: 'isolated' }
    return { ok: false, reason: 'already-styled' }
  }
  return { ok: true }
}

/** 中間点 (両隣あり) の対称ハンドルを作る。直線上の点では弦方向のため形状不変。 */
function buildMiddleHandles(
  segment: paper.Segment,
  neighbors: StyleNeighbors,
): { handleIn: paper.Point; handleOut: paper.Point } | undefined {
  const previous = neighbors.previous
  const next = neighbors.next
  if (!previous || !next) return undefined
  const existingIn = segment.handleIn
  const existingOut = segment.handleOut
  const hasIn = !isZeroStyleVector(existingIn)
  const hasOut = !isZeroStyleVector(existingOut)
  // 片側だけ残っている場合はそれを反転複写し、方向・長さを継承する。
  if (hasIn && !hasOut) {
    return { handleIn: existingIn, handleOut: existingIn.multiply(-1) }
  }
  if (hasOut && !hasIn) {
    return { handleIn: existingOut.multiply(-1), handleOut: existingOut }
  }
  if (hasIn && hasOut) {
    // 両側ありの非スムーズは in 側を正として対称化する。
    return { handleIn: existingIn, handleOut: existingIn.multiply(-1) }
  }
  const chord = previous.point.subtract(next.point)
  if (isZeroStyleVector(chord as paper.Point)) return undefined
  const baseLength = styleCurveLength(neighbors.incoming) ?? styleCurveLength(neighbors.outgoing)
  if (baseLength === undefined) return undefined
  const direction = chord.normalize()
  if (!Number.isFinite(direction.x) || !Number.isFinite(direction.y)) return undefined
  if (isZeroStyleVector(direction as paper.Point)) return undefined
  const handleIn = direction.multiply(baseLength * STYLE_HANDLE_RATIO)
  return { handleIn, handleOut: handleIn.multiply(-1) }
}

/** 開パス端点の単片ハンドルを作る。法線平均で持ち上げ、縮退時は弦方向に退避する。 */
function buildEndpointHandle(
  segment: paper.Segment,
  curve: paper.Curve | undefined,
  neighborPoint: paper.Point,
  side: 'in' | 'out',
  time: 0 | 1,
): paper.Point | undefined {
  const existing = side === 'in' ? segment.handleIn : segment.handleOut
  if (!isZeroStyleVector(existing)) return undefined
  const baseLength = styleCurveLength(curve)
  if (baseLength === undefined) return undefined
  const chord = neighborPoint.subtract(segment.point)
  const chordDirection = isZeroStyleVector(chord as paper.Point) ? undefined : chord.normalize()
  const normal = safeCurveNormal(curve, time)
  const convexity = safeCurveConvexity(curve)
  let direction: paper.Point | undefined
  if (normal && chordDirection && !isZeroStyleVector(chordDirection as paper.Point)) {
    const blended = normal.multiply(convexity).add(chordDirection)
    direction = isZeroStyleVector(blended as paper.Point) ? chordDirection : blended.normalize()
  } else {
    direction = normal ?? chordDirection
    if (direction && !isZeroStyleVector(direction as paper.Point)) {
      const normalized = direction.normalize()
      direction = Number.isFinite(normalized.x) && Number.isFinite(normalized.y) ? normalized : undefined
    } else {
      direction = undefined
    }
  }
  if (!direction || isZeroStyleVector(direction as paper.Point)) return undefined
  if (!Number.isFinite(direction.x) || !Number.isFinite(direction.y)) return undefined
  return direction.multiply(baseLength * STYLE_HANDLE_RATIO)
}

function flattenedAnchorIndexOf(item: paper.Item, target: paper.Segment): number | undefined {
  let index = 0
  for (const path of collectEditablePaths(item)) {
    for (const segment of path.segments) {
      if (segment === (target as paper.Segment)) return index
      index += 1
      if (!isZeroStyleVector(segment.handleIn)) index += 1
      if (!isZeroStyleVector(segment.handleOut)) index += 1
    }
  }
  return undefined
}

type StyleTarget = {
  inputIndex: number
  path: paper.Path
  segment: paper.Segment
  segmentIndex: number
  neighbors: StyleNeighbors
}

// 一括指定の解決は変異前に一括で行う。ハンドルの増減で flattened index が
// 前方へずれるため、逐次解決では後続指定が別枠を指してしまう。
function resolveStyleTargets(
  item: paper.Item,
  pointIndices: number[],
  gate: (item: paper.Item, pointIndex: number) => { ok: boolean; reason?: VectorPointStyleIssue },
): { targets: StyleTarget[]; skipped: VectorPointStyleSkipped[] } {
  const targets: StyleTarget[] = []
  const skipped: VectorPointStyleSkipped[] = []
  for (const pointIndex of Array.from(new Set(pointIndices))) {
    const check = gate(item, pointIndex)
    if (!check.ok) {
      skipped.push({ index: pointIndex, reason: check.reason ?? 'not-found' })
      continue
    }
    const resolved = resolvePaperPoint(item, pointIndex)
    if (!resolved || resolved.kind !== 'anchor') {
      skipped.push({ index: pointIndex, reason: 'not-found' })
      continue
    }
    targets.push({
      inputIndex: pointIndex,
      path: resolved.path,
      segment: resolved.segment,
      segmentIndex: resolved.segmentIndex,
      neighbors: styleNeighbors(resolved.path, resolved.segmentIndex),
    })
  }
  return { targets, skipped }
}

// 変異後の flattened anchor index を求める。選択同期にそのまま使える。
function postStyleIndices(item: paper.Item, targets: StyleTarget[]): number[] {
  const out: number[] = []
  for (const target of targets) {
    const index = flattenedAnchorIndexOf(item, target.segment)
    if (index !== undefined) out.push(index)
  }
  return out
}

// 選択アンカー群を曲線化する。対象セグメントのハンドルのみを書き換え、
// 座標・点数・開閉・非対象ハンドルには触れない。
// changedIndices は変異後の flattened anchor index (再選択にそのまま使える)。
export function curvePaperPoints(item: paper.Item, pointIndices: number[]): VectorPointStyleBulkResult {
  const { targets, skipped: initialSkipped } = resolveStyleTargets(item, pointIndices, canCurvePaperPoint)
  const skipped = [...initialSkipped]
  const applied: StyleTarget[] = []
  for (const target of targets) {
    const neighbors = target.neighbors
    try {
      if (neighbors.previous && neighbors.next) {
        const handles = buildMiddleHandles(target.segment, neighbors)
        if (!handles) {
          skipped.push({ index: target.inputIndex, reason: 'degenerate' })
          continue
        }
        target.segment.handleIn = handles.handleIn
        target.segment.handleOut = handles.handleOut
        applied.push(target)
      } else if (neighbors.previous) {
        const handle = buildEndpointHandle(target.segment, neighbors.incoming, neighbors.previous.point, 'in', 1)
        if (!handle) {
          skipped.push({ index: target.inputIndex, reason: 'degenerate' })
          continue
        }
        target.segment.handleIn = handle
        applied.push(target)
      } else if (neighbors.next) {
        const handle = buildEndpointHandle(target.segment, neighbors.outgoing, neighbors.next.point, 'out', 0)
        if (!handle) {
          skipped.push({ index: target.inputIndex, reason: 'degenerate' })
          continue
        }
        target.segment.handleOut = handle
        applied.push(target)
      } else {
        skipped.push({ index: target.inputIndex, reason: 'isolated' })
      }
    } catch {
      skipped.push({ index: target.inputIndex, reason: 'degenerate' })
    }
  }
  return { changedIndices: postStyleIndices(item, applied), skipped }
}

// 選択アンカー群を直線化する。対象のハンドルのみを消去し、他には触れない。
// changedIndices は変異後の flattened anchor index (再選択にそのまま使える)。
export function pointPaperPoints(item: paper.Item, pointIndices: number[]): VectorPointStyleBulkResult {
  const { targets, skipped: initialSkipped } = resolveStyleTargets(item, pointIndices, canPointPaperPoint)
  const skipped = [...initialSkipped]
  const applied: StyleTarget[] = []
  for (const target of targets) {
    try {
      target.segment.clearHandles()
      applied.push(target)
    } catch {
      skipped.push({ index: target.inputIndex, reason: 'degenerate' })
    }
  }
  return { changedIndices: postStyleIndices(item, applied), skipped }
}

function importStylePaperItem(scope: paper.PaperScope, element: Element): paper.Item | undefined {
  try {
    // 信頼境界: 実体シリアライズは SVG 断片であり、Paper.js へ渡す前に
    // 断片用サニタイズを通す。復元不能な断片は拒否する。
    const raw = new XMLSerializer().serializeToString(element)
    const svg = sanitizeSvgFragmentForPaperImport(raw)
    if (!svg || svg === SVG_PLACEHOLDER) return undefined
    return (
      scope.project as unknown as {
        importSVG: (svg: string, options?: { insert?: boolean }) => paper.Item
      }
    ).importSVG(svg, { insert: false })
  } catch {
    return undefined
  }
}

function replaceStyleWholeElement(element: Element, item: paper.Item): void {
  const exported = item.exportSVG({ asString: false }) as Element
  const nextElement = element.ownerDocument.importNode(exported, true) as Element
  cleanSvgElementAttributes(nextElement)
  element.replaceWith(nextElement)
}

// `vector-path-points.ts` の DOM 対応付けと同じ文書順: 単体は自身、
// グループは深さ優先の葉形状列。Paper 側の走査順と一致させるための写像。
function styleDomLeafTargets(element: Element): Element[] {
  const tag = element.tagName.toLowerCase()
  if (tag !== 'g') return [element]
  const out: Element[] = []
  const visit = (node: Element): void => {
    const childTag = node.tagName.toLowerCase()
    if (childTag === 'g') {
      for (const child of Array.from(node.children)) visit(child as Element)
      return
    }
    if (
      childTag === 'path' ||
      childTag === 'rect' ||
      childTag === 'ellipse' ||
      childTag === 'circle' ||
      childTag === 'line' ||
      childTag === 'polyline' ||
      childTag === 'polygon'
    ) {
      out.push(node)
    }
  }
  for (const child of Array.from(element.children)) visit(child as Element)
  return out
}

const STYLE_SHAPE_GEOMETRY_ATTRIBUTES = new Set([
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'd',
])

// Paper 側の焼付け済み形状を DOM 葉の局所座標に戻して `d` 化する。
// ユニット内 transform がなければ直読、あれば分離クローンに逆行列を適用する。
// 特異・非有限なユニット内行列では undefined を返し、呼出側は拒否する
// (全体置換 fallback なし)。
function styleLeafLocalPathData(
  scope: paper.PaperScope,
  unit: Element,
  leaf: Element,
  path: paper.Path,
): string | undefined {
  const direct = (path as unknown as { pathData?: unknown }).pathData
  if (typeof direct !== 'string' || !direct) return undefined
  const stopAt = unit.parentElement as Element | null
  const matrix = worldTransformMatrix(leaf, stopAt)
  if (!matrix) return direct
  let clone: paper.Path | undefined
  try {
    const inverse = tryInvertVectorMatrix(matrix)
    if (!inverse) return undefined
    const paperMatrix = new scope.Matrix(inverse[0], inverse[1], inverse[2], inverse[3], inverse[4], inverse[5])
    const raw = (path as unknown as { clone?: (options?: { insert?: boolean }) => paper.Path }).clone?.({ insert: false })
    if (!raw) return undefined
    clone = raw
    clone.transform(paperMatrix)
    const data = (clone as unknown as { pathData?: unknown }).pathData
    return typeof data === 'string' && data ? data : undefined
  } catch {
    return undefined
  } finally {
    try {
      clone?.remove()
    } catch {
      // 分離クローンの後始末のみ。
    }
  }
}

function patchStyleDomLeaf(
  scope: paper.PaperScope,
  unit: Element,
  leaf: Element,
  path: paper.Path,
): boolean {
  try {
    const data = styleLeafLocalPathData(scope, unit, leaf, path)
    if (!data) return false
    if (leaf.tagName.toLowerCase() === 'path') {
      leaf.setAttribute('d', data)
      // 実体由来の属性が残るため、取込時と同じ後処理で清掃する。
      cleanSvgElementAttributes(leaf)
      return true
    }
    const doc = leaf.ownerDocument
    const namespace = leaf.namespaceURI ?? 'http://www.w3.org/2000/svg'
    const next = doc.createElementNS(namespace, 'path')
    for (const name of leaf.getAttributeNames()) {
      if (STYLE_SHAPE_GEOMETRY_ATTRIBUTES.has(name)) continue
      const value = leaf.getAttribute(name)
      if (value !== null) next.setAttribute(name, value)
    }
    next.setAttribute('d', data)
    cleanSvgElementAttributes(next)
    leaf.replaceWith(next)
    return true
  } catch {
    return false
  }
}

// 編集された Paper パスだけを対応する DOM 葉へ書戻す。対応崩れ・特異パッチ
// は false で拒否し、DOM 無変更 (全体置換 fallback なし)。
function writeBackStyledPaths(
  scope: paper.PaperScope,
  unit: Element,
  root: paper.Item,
  edited: Set<paper.Path>,
): boolean {
  const paperPaths = collectEditablePaths(root)
  const targets = styleDomLeafTargets(unit)
  if (paperPaths.length !== targets.length) {
    return false
  }
  for (const path of edited) {
    const order = paperPaths.indexOf(path)
    const target = order >= 0 ? targets[order] : undefined
    if (!target || !patchStyleDomLeaf(scope, unit, target, path)) {
      return false
    }
  }
  return true
}

async function applyVectorPointStyle(
  element: Element,
  pointIndices: number[],
  mode: 'curved' | 'pointed',
): Promise<VectorPointStyleDomResult> {
  if (!isPathPointEditableElement(element)) {
    return { changed: false, changedIndices: [], skipped: [], reason: 'not-editable' }
  }
  // 外側祖先が特異・非有限の場合は不可視編集になるため拒否 (DOM 無変更)。
  const outer = ancestorWorldMatrix(element)
  if (outer && !tryInvertVectorMatrix(outer)) {
    return { changed: false, changedIndices: [], skipped: [], reason: 'not-editable' }
  }
  const scope = await ensureVectorPaperScope()
  const imported = importStylePaperItem(scope, element)
  if (!imported) return { changed: false, changedIndices: [], skipped: [], reason: 'import-failed' }
  let root: paper.Item = imported
  try {
    root = expandShapesToPaths(imported)
    if (collectEditablePaths(root).length === 0) {
      return { changed: false, changedIndices: [], skipped: [], reason: 'no-path' }
    }
    const result =
      mode === 'curved' ? curvePaperPoints(root, pointIndices) : pointPaperPoints(root, pointIndices)
    if (result.changedIndices.length === 0) {
      const first = result.skipped[0]
      return { changed: false, changedIndices: [], skipped: result.skipped, reason: first?.reason ?? 'already-styled' }
    }
    const edited = new Set<paper.Path>()
    for (const index of result.changedIndices) {
      const resolved = resolvePaperPoint(root, index)
      if (resolved && resolved.kind === 'anchor') edited.add(resolved.path)
    }
    if (edited.size === 0) {
      return { changed: false, changedIndices: [], skipped: result.skipped, reason: 'not-editable' }
    }
    if (!writeBackStyledPaths(scope, element, root, edited)) {
      return { changed: false, changedIndices: [], skipped: result.skipped, reason: 'not-editable' }
    }
    return { changed: true, changedIndices: result.changedIndices, skipped: result.skipped }
  } finally {
    try {
      root.remove()
    } catch {
      // export 済みの分離物のみ。
    }
  }
}

// 選択アンカー群を曲線化して SVG に保存する。成功時のみ DOM を変更する。
export async function curveVectorPointStyle(
  element: Element,
  pointIndices: number[],
): Promise<VectorPointStyleDomResult> {
  return applyVectorPointStyle(element, pointIndices, 'curved')
}

// 選択アンカー群を直線化して SVG に保存する。成功時のみ DOM を変更する。
export async function pointVectorPointStyle(
  element: Element,
  pointIndices: number[],
): Promise<VectorPointStyleDomResult> {
  return applyVectorPointStyle(element, pointIndices, 'pointed')
}
