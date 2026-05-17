import type paperCore from 'paper/dist/paper-core'
import type { VectorObjectInfo, VectorPathPointInfo, VectorResizeHandle } from '../../lib/editor-types'
import { editableSvgChildren, moveVectorEditablePoint as moveVectorEditablePointFallback, vectorObjectBounds, vectorObjectList } from './vector-svg'

type VectorBounds = { x: number; y: number; width: number; height: number }

let paperModule: typeof paperCore | undefined
let paperScope: paper.PaperScope | undefined

export async function ensureVectorPaperScope() {
  if (!paperModule) {
    const imported = await import('paper/dist/paper-core')
    paperModule = ('default' in imported ? imported.default : imported) as typeof paperCore
  }
  if (!paperScope) {
    paperScope = new paperModule.PaperScope()
    const canvas = document.createElement('canvas')
    canvas.width = 480
    canvas.height = 360
    paperScope.setup(canvas)
  }
  return paperScope
}

export function disposeVectorPaperScope() {
  paperScope?.project?.remove()
  paperScope = undefined
}

export async function paperVectorObjectList(svgText: string) {
  const fallback = vectorObjectList(svgText)
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  if (svg.nodeName.toLowerCase() !== 'svg') return fallback
  try {
    const scope = await ensureVectorPaperScope()
    return editableSvgChildren(svg).map((element, index) => {
      const base = fallback[index]
      const bounds = paperBoundsForElement(scope, element)
      const points = paperEditablePointsForElement(scope, element)
      return {
        ...(base ?? {
          index,
          tag: element.tagName.toLowerCase(),
          label: `${index + 1}. ${element.tagName.toLowerCase()}`,
        }),
        boundsX: bounds?.x ?? base?.boundsX ?? base?.x ?? 0,
        boundsY: bounds?.y ?? base?.boundsY ?? base?.y ?? 0,
        boundsWidth: bounds?.width ?? base?.boundsWidth ?? base?.width ?? 0,
        boundsHeight: bounds?.height ?? base?.boundsHeight ?? base?.height ?? 0,
        points: points.length > 0 ? points : base?.points,
      }
    }) as VectorObjectInfo[]
  } catch {
    return fallback
  }
}

function paperEditablePointsForElement(scope: paper.PaperScope, element: Element) {
  const item = importPaperItem(scope, element)
  if (!item) return []
  try {
    const points: VectorPathPointInfo[] = []
    for (const path of paperPathItems(item)) {
      appendPaperPathPoints(path, points)
    }
    return points
  } finally {
    item.remove()
  }
}

function paperPathItems(item: paper.Item): paper.Path[] {
  const maybePath = item as paper.Path
  if (Array.isArray(maybePath.segments)) return [maybePath]
  const children = (item as paper.Group).children
  if (!children) return []
  return Array.from(children).flatMap((child) => paperPathItems(child))
}

function appendPaperPathPoints(path: paper.Path, points: VectorPathPointInfo[]) {
  for (const segment of path.segments) {
    const anchorIndex = points.length
    const anchor = projectPoint(path, segment.point)
    points.push({ index: anchorIndex, x: anchor.x, y: anchor.y, kind: 'anchor' })
    if (!isZeroPaperPoint(segment.handleIn)) {
      const handle = projectPoint(path, segment.point.add(segment.handleIn))
      points.push({ index: points.length, x: handle.x, y: handle.y, kind: 'control', controlRole: 'in', relatedAnchorIndex: anchorIndex })
    }
    if (!isZeroPaperPoint(segment.handleOut)) {
      const handle = projectPoint(path, segment.point.add(segment.handleOut))
      points.push({ index: points.length, x: handle.x, y: handle.y, kind: 'control', controlRole: 'out', relatedAnchorIndex: anchorIndex })
    }
  }
}

function projectPoint(path: paper.Path, point: paper.Point) {
  const converter = path as unknown as { localToProject?: (point: paper.Point) => paper.Point }
  return converter.localToProject ? converter.localToProject(point) : point
}

function localPoint(path: paper.Path, point: paper.Point) {
  const converter = path as unknown as { projectToLocal?: (point: paper.Point) => paper.Point }
  return converter.projectToLocal ? converter.projectToLocal(point) : point
}

function isZeroPaperPoint(point: paper.Point) {
  return Math.abs(point.x) < 0.001 && Math.abs(point.y) < 0.001
}

function paperBoundsForElement(scope: paper.PaperScope, element: Element) {
  const item = importPaperItem(scope, element)
  if (!item) return undefined
  try {
    const bounds = item.bounds
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  } finally {
    item.remove()
  }
}

function importPaperItem(scope: paper.PaperScope, element: Element) {
  try {
    const svg = new XMLSerializer().serializeToString(element)
    return (scope.project as unknown as { importSVG: (svg: string, options?: { insert?: boolean }) => paper.Item }).importSVG(svg, { insert: false })
  } catch {
    return undefined
  }
}

function replaceElementWithPaperItem(element: Element, item: paper.Item) {
  const exported = item.exportSVG({ asString: false }) as Element
  const nextElement = element.ownerDocument.importNode(exported, true) as Element
  element.replaceWith(nextElement)
  return nextElement
}

async function updateElementWithPaper(element: Element, mutator: (item: paper.Item, scope: paper.PaperScope) => void) {
  const scope = await ensureVectorPaperScope()
  const item = importPaperItem(scope, element)
  if (!item) return element
  try {
    mutator(item, scope)
    return replaceElementWithPaperItem(element, item)
  } finally {
    item.remove()
  }
}

export async function vectorBrushPathData(points: Array<{ x: number; y: number }>, strokeColor: string, strokeWidth: number) {
  const scope = await ensureVectorPaperScope()
  scope.project.clear()
  const path = new scope.Path()
  path.strokeColor = new scope.Color(strokeColor)
  path.strokeWidth = Math.max(1, strokeWidth)
  path.strokeCap = 'round'
  path.strokeJoin = 'round'
  for (const point of points) path.add(new scope.Point(point.x, point.y))
  if (path.segments.length > 2) {
    path.simplify(Math.max(0.5, strokeWidth * 0.45))
    path.smooth({ type: 'continuous' })
  }
  const exported = path.exportSVG({ asString: false }) as SVGPathElement
  const data = exported.getAttribute('d') ?? points.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`).join(' ')
  path.remove()
  return data
}

function formatSvgNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(3))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

export async function alignVectorElements(elements: Element[], action: string) {
  if (elements.length < 2) return
  const scope = await ensureVectorPaperScope()
  const bounds = elements.map((element) => paperBoundsForElement(scope, element) ?? vectorObjectBounds(element))
  const left = Math.min(...bounds.map((bound) => bound.x))
  const right = Math.max(...bounds.map((bound) => bound.x + bound.width))
  const top = Math.min(...bounds.map((bound) => bound.y))
  const bottom = Math.max(...bounds.map((bound) => bound.y + bound.height))
  const centerX = left + (right - left) / 2
  const centerY = top + (bottom - top) / 2
  await Promise.all(elements.map(async (element, index) => {
    const bound = bounds[index]
    if (!bound) return
    if (action === 'align-left') await moveVectorElementBy(element, left - bound.x, 0)
    else if (action === 'align-center') await moveVectorElementBy(element, centerX - (bound.x + bound.width / 2), 0)
    else if (action === 'align-right') await moveVectorElementBy(element, right - (bound.x + bound.width), 0)
    else if (action === 'align-top') await moveVectorElementBy(element, 0, top - bound.y)
    else if (action === 'align-middle') await moveVectorElementBy(element, 0, centerY - (bound.y + bound.height / 2))
    else if (action === 'align-bottom') await moveVectorElementBy(element, 0, bottom - (bound.y + bound.height))
  }))
}

export async function moveVectorElementBy(element: Element, dx: number, dy: number) {
  if (!dx && !dy) return
  await updateElementWithPaper(element, (item, scope) => item.translate(new scope.Point(dx, dy)))
}

export async function moveVectorEditablePoint(element: Element, pointIndex: number, x: number, y: number, splitHandles = false) {
  if (!hasPaperEditablePath(element)) {
    moveVectorEditablePointFallback(element, pointIndex, x, y)
    return
  }
  await updateElementWithPaper(element, (item, scope) => {
    const target = new scope.Point(x, y)
    const editable = paperEditablePathPoint(item, pointIndex)
    if (!editable) return
    const localTarget = localPoint(editable.path, target)
    if (editable.kind === 'anchor') {
      editable.segment.point = localTarget
      return
    }
    const nextHandle = localTarget.subtract(editable.segment.point)
    if (editable.controlRole === 'in') {
      const mirror = shouldMirrorHandles(editable.segment.handleIn, editable.segment.handleOut, splitHandles)
      const oppositeLength = editable.segment.handleOut.length
      editable.segment.handleIn = nextHandle
      if (mirror) editable.segment.handleOut = mirroredHandle(nextHandle, oppositeLength)
    } else {
      const mirror = shouldMirrorHandles(editable.segment.handleOut, editable.segment.handleIn, splitHandles)
      const oppositeLength = editable.segment.handleIn.length
      editable.segment.handleOut = nextHandle
      if (mirror) editable.segment.handleIn = mirroredHandle(nextHandle, oppositeLength)
    }
  })
}

function hasPaperEditablePath(element: Element) {
  const tag = element.tagName.toLowerCase()
  return tag === 'path' || tag === 'g'
}

function paperEditablePathPoint(item: paper.Item, pointIndex: number) {
  let index = 0
  for (const path of paperPathItems(item)) {
    for (const segment of path.segments) {
      if (index === pointIndex) return { path, segment, kind: 'anchor' as const }
      index += 1
      if (!isZeroPaperPoint(segment.handleIn)) {
        if (index === pointIndex) return { path, segment, kind: 'control' as const, controlRole: 'in' as const }
        index += 1
      }
      if (!isZeroPaperPoint(segment.handleOut)) {
        if (index === pointIndex) return { path, segment, kind: 'control' as const, controlRole: 'out' as const }
        index += 1
      }
    }
  }
  return undefined
}

function shouldMirrorHandles(moved: paper.Point, opposite: paper.Point, splitHandles: boolean) {
  if (splitHandles || isZeroPaperPoint(moved) || isZeroPaperPoint(opposite)) return false
  return areColinear(moved, opposite)
}

function areColinear(left: paper.Point, right: paper.Point) {
  const cross = left.x * right.y - left.y * right.x
  return Math.abs(cross) <= Math.max(0.001, left.length * right.length * 0.001)
}

function mirroredHandle(handle: paper.Point, length: number) {
  if (isZeroPaperPoint(handle) || length <= 0) return handle.multiply(0)
  return handle.normalize(length).multiply(-1)
}

function resizeHandlePoint(handle: VectorResizeHandle, bounds: VectorBounds) {
  return new PointLike(
    handle.includes('w') ? bounds.x : handle.includes('e') ? bounds.x + bounds.width : bounds.x + bounds.width / 2,
    handle.includes('n') ? bounds.y : handle.includes('s') ? bounds.y + bounds.height : bounds.y + bounds.height / 2,
  )
}

function fixedResizePoint(handle: VectorResizeHandle, bounds: VectorBounds) {
  return new PointLike(
    handle.includes('w') ? bounds.x + bounds.width : handle.includes('e') ? bounds.x : bounds.x + bounds.width / 2,
    handle.includes('n') ? bounds.y + bounds.height : handle.includes('s') ? bounds.y : bounds.y + bounds.height / 2,
  )
}

function draggedResizePoint(handle: VectorResizeHandle, bounds: VectorBounds, dx: number, dy: number) {
  const point = resizeHandlePoint(handle, bounds)
  return new PointLike(point.x + (handle.includes('w') || handle.includes('e') ? dx : 0), point.y + (handle.includes('n') || handle.includes('s') ? dy : 0))
}

function resizeScaleForHandle(handle: VectorResizeHandle, bounds: VectorBounds, dx: number, dy: number) {
  const fixed = fixedResizePoint(handle, bounds)
  const handlePoint = resizeHandlePoint(handle, bounds)
  const dragged = draggedResizePoint(handle, bounds, dx, dy)
  const sx = handle.includes('w') || handle.includes('e')
    ? nonZeroScale((dragged.x - fixed.x) / (handlePoint.x - fixed.x))
    : 1
  const sy = handle.includes('n') || handle.includes('s')
    ? nonZeroScale((dragged.y - fixed.y) / (handlePoint.y - fixed.y))
    : 1
  return { fixed, sx, sy }
}

function nonZeroScale(value: number) {
  if (!Number.isFinite(value)) return 1
  if (Math.abs(value) >= 0.001) return value
  return value < 0 ? -0.001 : 0.001
}

class PointLike {
  constructor(public x: number, public y: number) {}
}

export async function resizeVectorElementBy(element: Element, handle: VectorResizeHandle, dx: number, dy: number) {
  await updateElementWithPaper(element, (item, scope) => {
    const bounds = item.bounds
    const { fixed, sx, sy } = resizeScaleForHandle(handle, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }, dx, dy)
    item.scale(sx, sy, new scope.Point(fixed.x, fixed.y))
  })
}

export async function applyPaperScale(element: Element, factor: number) {
  await updateElementWithPaper(element, (item) => item.scale(Math.max(0.05, factor)))
}

export async function applyPaperRotation(element: Element, degrees: number) {
  await updateElementWithPaper(element, (item) => item.rotate(degrees))
}

export async function applyPaperFlip(element: Element, horizontal: boolean) {
  await updateElementWithPaper(element, (item) => item.scale(horizontal ? -1 : 1, horizontal ? 1 : -1))
}
