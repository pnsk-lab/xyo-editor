import type { VectorObjectInfo, VectorPathPointInfo } from '../../lib/editor-types'

export type VectorNumericField = 'x' | 'y' | 'width' | 'height'

export function vectorObjectList(svgText: string): VectorObjectInfo[] {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  if (svg.nodeName.toLowerCase() !== 'svg') return []
  return editableSvgChildren(svg).map((element, index) => {
    const bounds = vectorObjectBounds(element)
    return {
      index,
      tag: element.tagName.toLowerCase(),
      label: vectorObjectLabel(element, index),
      fill: element.getAttribute('fill') ?? undefined,
      stroke: element.getAttribute('stroke') ?? undefined,
      strokeWidth: optionalSvgNumber(element.getAttribute('stroke-width')),
      opacity: optionalSvgNumber(element.getAttribute('opacity')) ?? 1,
      rotation: vectorObjectRotation(element),
      ...vectorObjectGeometry(element),
      boundsX: bounds.x,
      boundsY: bounds.y,
      boundsWidth: bounds.width,
      boundsHeight: bounds.height,
      points: vectorEditablePoints(element),
      text: element.tagName.toLowerCase() === 'text' ? (element.textContent ?? '') : undefined,
    }
  })
}

export function editableSvgChildren(svg: Element) {
  return Array.from(svg.children).filter((element) => !['defs', 'metadata', 'title', 'desc'].includes(element.tagName.toLowerCase()))
}

export function addTranslate(element: Element, dx: number, dy: number) {
  const transform = element.getAttribute('transform') ?? ''
  const match = /translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(transform)
  if (match) {
    const x = Number(match[1]) + dx
    const y = Number(match[2]) + dy
    element.setAttribute('transform', transform.replace(match[0], `translate(${x} ${y})`))
  } else {
    element.setAttribute('transform', `${transform} translate(${dx} ${dy})`.trim())
  }
}

export function vectorObjectRotation(element: Element) {
  const match = /rotate\(([-\d.]+)/.exec(element.getAttribute('transform') ?? '')
  const degrees = match ? Number(match[1]) : 0
  return Number.isFinite(degrees) ? degrees : 0
}

export function setVectorRotation(element: Element, degrees: number) {
  const transform = element.getAttribute('transform') ?? ''
  const next = /rotate\([^)]+\)/.test(transform)
    ? transform.replace(/rotate\([^)]+\)/, `rotate(${degrees})`)
    : `${transform} rotate(${degrees})`.trim()
  element.setAttribute('transform', next)
}

export function addVectorFlip(element: Element, horizontal: boolean) {
  const center = vectorObjectCenter(element)
  const transform = element.getAttribute('transform') ?? ''
  const flip = horizontal
    ? `translate(${center.x * 2} 0) scale(-1 1)`
    : `translate(0 ${center.y * 2}) scale(1 -1)`
  element.setAttribute('transform', `${flip} ${transform}`.trim())
}

export function vectorObjectBounds(element: Element) {
  return applyElementTransform(element, rawVectorObjectBounds(element))
}

function rawVectorObjectBounds(element: Element) {
  const tag = element.tagName.toLowerCase()
  const number = (name: string) => optionalSvgNumber(element.getAttribute(name)) ?? 0
  if (tag === 'rect' || tag === 'image') {
    return { x: number('x'), y: number('y'), width: number('width'), height: number('height') }
  }
  if (tag === 'ellipse') {
    const rx = number('rx')
    const ry = number('ry')
    return { x: number('cx') - rx, y: number('cy') - ry, width: rx * 2, height: ry * 2 }
  }
  if (tag === 'circle') {
    const r = number('r')
    return { x: number('cx') - r, y: number('cy') - r, width: r * 2, height: r * 2 }
  }
  if (tag === 'text') {
    const fontSize = optionalSvgNumber(element.getAttribute('font-size')) ?? 24
    const text = element.textContent ?? ''
    return { x: number('x') - text.length * fontSize * 0.25, y: number('y') - fontSize, width: Math.max(fontSize, text.length * fontSize * 0.55), height: fontSize * 1.25 }
  }
  if (tag === 'path' || tag === 'polygon' || tag === 'polyline') {
    const points = tag === 'path'
      ? pathEditablePoints(element.getAttribute('d') ?? '')
      : coordinatePairs(element.getAttribute('points') ?? '')
    if (points.length > 0) {
      const left = Math.min(...points.map((point) => point.x))
      const top = Math.min(...points.map((point) => point.y))
      const right = Math.max(...points.map((point) => point.x))
      const bottom = Math.max(...points.map((point) => point.y))
      return { x: left, y: top, width: right - left, height: bottom - top }
    }
  }
  const childBounds = Array.from(element.children).map(vectorObjectBounds).filter((bound) => bound.width || bound.height)
  if (childBounds.length > 0) {
    const left = Math.min(...childBounds.map((bound) => bound.x))
    const top = Math.min(...childBounds.map((bound) => bound.y))
    const right = Math.max(...childBounds.map((bound) => bound.x + bound.width))
    const bottom = Math.max(...childBounds.map((bound) => bound.y + bound.height))
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  return { x: 0, y: 0, width: 0, height: 0 }
}

type VectorBounds = { x: number; y: number; width: number; height: number }
type Matrix = [number, number, number, number, number, number]

function applyElementTransform(element: Element, bounds: VectorBounds): VectorBounds {
  const matrix = transformMatrix(element.getAttribute('transform') ?? '')
  if (!matrix) return bounds
  const corners = [
    transformPoint(matrix, bounds.x, bounds.y),
    transformPoint(matrix, bounds.x + bounds.width, bounds.y),
    transformPoint(matrix, bounds.x + bounds.width, bounds.y + bounds.height),
    transformPoint(matrix, bounds.x, bounds.y + bounds.height),
  ]
  const left = Math.min(...corners.map((point) => point.x))
  const top = Math.min(...corners.map((point) => point.y))
  const right = Math.max(...corners.map((point) => point.x))
  const bottom = Math.max(...corners.map((point) => point.y))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function transformMatrix(transform: string): Matrix | undefined {
  const operations = [...transform.matchAll(/(matrix|translate|scale|rotate)\(([^)]*)\)/g)]
  if (operations.length === 0) return undefined
  return operations.reduce<Matrix>((matrix, operation) => {
    const type = operation[1]
    const values = operation[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (type === 'matrix' && values.length >= 6) return multiplyMatrix(matrix, values.slice(0, 6) as Matrix)
    if (type === 'translate') return multiplyMatrix(matrix, [1, 0, 0, 1, values[0] ?? 0, values[1] ?? 0])
    if (type === 'scale') {
      const sx = values[0] ?? 1
      const sy = values[1] ?? sx
      return multiplyMatrix(matrix, [sx, 0, 0, sy, 0, 0])
    }
    if (type === 'rotate') {
      const radians = ((values[0] ?? 0) * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      const rotation: Matrix = [cos, sin, -sin, cos, 0, 0]
      if (values.length >= 3) {
        const cx = values[1] ?? 0
        const cy = values[2] ?? 0
        return multiplyMatrix(matrix, multiplyMatrix([1, 0, 0, 1, cx, cy], multiplyMatrix(rotation, [1, 0, 0, 1, -cx, -cy])))
      }
      return multiplyMatrix(matrix, rotation)
    }
    return matrix
  }, [1, 0, 0, 1, 0, 0])
}

function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function invertMatrix(matrix: Matrix): Matrix {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2]
  if (!determinant) return [1, 0, 0, 1, 0, 0]
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant,
  ]
}

function transformPoint(matrix: Matrix, x: number, y: number) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  }
}

export function optionalSvgNumber(value: string | null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const svgNumberPattern = /[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi

export function vectorEditablePoints(element: Element): VectorPathPointInfo[] {
  const matrix = transformMatrix(element.getAttribute('transform') ?? '')
  const points = rawVectorEditablePoints(element)
  if (!matrix) return points
  return points.map((point) => ({ ...point, ...transformPoint(matrix, point.x, point.y) }))
}

function rawVectorEditablePoints(element: Element): VectorPathPointInfo[] {
  const tag = element.tagName.toLowerCase()
  if (tag === 'rect' || tag === 'image') {
    const x = optionalSvgNumber(element.getAttribute('x')) ?? 0
    const y = optionalSvgNumber(element.getAttribute('y')) ?? 0
    const width = optionalSvgNumber(element.getAttribute('width')) ?? 0
    const height = optionalSvgNumber(element.getAttribute('height')) ?? 0
    return [
      { index: 0, x, y, kind: 'anchor' },
      { index: 1, x: x + width, y, kind: 'anchor' },
      { index: 2, x: x + width, y: y + height, kind: 'anchor' },
      { index: 3, x, y: y + height, kind: 'anchor' },
    ]
  }
  if (tag === 'ellipse' || tag === 'circle') {
    const cx = optionalSvgNumber(element.getAttribute('cx')) ?? 0
    const cy = optionalSvgNumber(element.getAttribute('cy')) ?? 0
    const rx = tag === 'circle' ? optionalSvgNumber(element.getAttribute('r')) ?? 0 : optionalSvgNumber(element.getAttribute('rx')) ?? 0
    const ry = tag === 'circle' ? optionalSvgNumber(element.getAttribute('r')) ?? 0 : optionalSvgNumber(element.getAttribute('ry')) ?? 0
    return [
      { index: 0, x: cx - rx, y: cy, kind: 'anchor' },
      { index: 1, x: cx, y: cy - ry, kind: 'anchor' },
      { index: 2, x: cx + rx, y: cy, kind: 'anchor' },
      { index: 3, x: cx, y: cy + ry, kind: 'anchor' },
    ]
  }
  if (tag === 'line') {
    const x1 = optionalSvgNumber(element.getAttribute('x1'))
    const y1 = optionalSvgNumber(element.getAttribute('y1'))
    const x2 = optionalSvgNumber(element.getAttribute('x2'))
    const y2 = optionalSvgNumber(element.getAttribute('y2'))
    return [x1 !== undefined && y1 !== undefined ? { index: 0, x: x1, y: y1 } : undefined, x2 !== undefined && y2 !== undefined ? { index: 1, x: x2, y: y2 } : undefined].filter((point): point is VectorPathPointInfo => Boolean(point))
  }
  if (tag === 'polyline' || tag === 'polygon') return coordinatePairs(element.getAttribute('points') ?? '')
  if (tag !== 'path') return []
  return pathEditablePoints(element.getAttribute('d') ?? '')
}

export function moveVectorEditablePoint(element: Element, pointIndex: number, x: number, y: number) {
  const matrix = transformMatrix(element.getAttribute('transform') ?? '')
  if (matrix) {
    const local = transformPoint(invertMatrix(matrix), x, y)
    x = local.x
    y = local.y
  }
  const tag = element.tagName.toLowerCase()
  if (tag === 'rect' || tag === 'image') {
    moveRectEditablePoint(element, pointIndex, x, y)
    return
  }
  if (tag === 'ellipse' || tag === 'circle') {
    moveEllipseEditablePoint(element, pointIndex, x, y)
    return
  }
  if (tag === 'line') {
    if (pointIndex === 0) {
      element.setAttribute('x1', String(x))
      element.setAttribute('y1', String(y))
    } else if (pointIndex === 1) {
      element.setAttribute('x2', String(x))
      element.setAttribute('y2', String(y))
    }
    return
  }
  if (tag === 'polyline' || tag === 'polygon') {
    const value = element.getAttribute('points') ?? ''
    const next = replaceCoordinatePair(value, pointIndex, x, y)
    element.setAttribute('points', next)
    return
  }
  if (tag === 'path') {
    const value = element.getAttribute('d') ?? ''
    element.setAttribute('d', replacePathEditablePoint(value, pointIndex, x, y))
  }
}

function moveRectEditablePoint(element: Element, pointIndex: number, x: number, y: number) {
  const currentX = optionalSvgNumber(element.getAttribute('x')) ?? 0
  const currentY = optionalSvgNumber(element.getAttribute('y')) ?? 0
  const currentWidth = optionalSvgNumber(element.getAttribute('width')) ?? 0
  const currentHeight = optionalSvgNumber(element.getAttribute('height')) ?? 0
  const left = currentX
  const top = currentY
  const right = currentX + currentWidth
  const bottom = currentY + currentHeight
  const nextLeft = pointIndex === 0 || pointIndex === 3 ? x : left
  const nextRight = pointIndex === 1 || pointIndex === 2 ? x : right
  const nextTop = pointIndex === 0 || pointIndex === 1 ? y : top
  const nextBottom = pointIndex === 2 || pointIndex === 3 ? y : bottom
  const normalizedLeft = Math.min(nextLeft, nextRight)
  const normalizedTop = Math.min(nextTop, nextBottom)
  element.setAttribute('x', formatSvgNumber(normalizedLeft))
  element.setAttribute('y', formatSvgNumber(normalizedTop))
  element.setAttribute('width', formatSvgNumber(Math.max(1, Math.abs(nextRight - nextLeft))))
  element.setAttribute('height', formatSvgNumber(Math.max(1, Math.abs(nextBottom - nextTop))))
}

function moveEllipseEditablePoint(element: Element, pointIndex: number, x: number, y: number) {
  const tag = element.tagName.toLowerCase()
  const cx = optionalSvgNumber(element.getAttribute('cx')) ?? 0
  const cy = optionalSvgNumber(element.getAttribute('cy')) ?? 0
  const rx = tag === 'circle' ? optionalSvgNumber(element.getAttribute('r')) ?? 0 : optionalSvgNumber(element.getAttribute('rx')) ?? 0
  const ry = tag === 'circle' ? optionalSvgNumber(element.getAttribute('r')) ?? 0 : optionalSvgNumber(element.getAttribute('ry')) ?? 0
  const left = cx - rx
  const right = cx + rx
  const top = cy - ry
  const bottom = cy + ry
  const nextLeft = pointIndex === 0 ? x : left
  const nextRight = pointIndex === 2 ? x : right
  const nextTop = pointIndex === 1 ? y : top
  const nextBottom = pointIndex === 3 ? y : bottom
  const nextCx = (nextLeft + nextRight) / 2
  const nextCy = (nextTop + nextBottom) / 2
  const nextRx = Math.max(1, Math.abs(nextRight - nextLeft) / 2)
  const nextRy = Math.max(1, Math.abs(nextBottom - nextTop) / 2)
  element.setAttribute('cx', formatSvgNumber(nextCx))
  element.setAttribute('cy', formatSvgNumber(nextCy))
  if (tag === 'circle') {
    element.setAttribute('r', formatSvgNumber(Math.max(nextRx, nextRy)))
  } else {
    element.setAttribute('rx', formatSvgNumber(nextRx))
    element.setAttribute('ry', formatSvgNumber(nextRy))
  }
}

function coordinatePairs(value: string): VectorPathPointInfo[] {
  const values = [...value.matchAll(svgNumberPattern)].map((match) => Number(match[0])).filter(Number.isFinite)
  const points: VectorPathPointInfo[] = []
  for (let index = 0; index < values.length - 1; index += 2) {
    points.push({ index: index / 2, x: values[index]!, y: values[index + 1]! })
  }
  return points
}

function replaceCoordinatePair(value: string, pointIndex: number, x: number, y: number) {
  const matches = [...value.matchAll(svgNumberPattern)].map((match) => ({ index: match.index ?? 0, text: match[0] }))
  const xMatch = matches[pointIndex * 2]
  const yMatch = matches[pointIndex * 2 + 1]
  if (!xMatch || !yMatch) return value
  const replacements = [
    { start: xMatch.index, end: xMatch.index + xMatch.text.length, value: String(x) },
    { start: yMatch.index, end: yMatch.index + yMatch.text.length, value: String(y) },
  ].sort((left, right) => right.start - left.start)
  let next = value
  for (const replacement of replacements) next = `${next.slice(0, replacement.start)}${replacement.value}${next.slice(replacement.end)}`
  return next
}

type PathNumberToken = { start: number; end: number; value: number }
type PathCommandToken = { command: string; start: number; end: number; numbers: PathNumberToken[] }
type PathPointToken = VectorPathPointInfo & { xToken?: PathNumberToken; yToken?: PathNumberToken; relative?: boolean }

function pathEditablePoints(value: string): VectorPathPointInfo[] {
  return pathPointTokens(value).map(({ xToken, yToken, relative, ...point }) => point)
}

function replacePathEditablePoint(value: string, pointIndex: number, x: number, y: number) {
  const point = pathPointTokens(value).find((item) => item.index === pointIndex)
  if (!point || (!point.xToken && !point.yToken)) return value
  const dx = x - point.x
  const dy = y - point.y
  const replacements = []
  if (point.xToken) {
    const nextX = point.relative ? point.xToken.value + dx : x
    replacements.push({ start: point.xToken.start, end: point.xToken.end, value: formatSvgNumber(nextX) })
  }
  if (point.yToken) {
    const nextY = point.relative ? point.yToken.value + dy : y
    replacements.push({ start: point.yToken.start, end: point.yToken.end, value: formatSvgNumber(nextY) })
  }
  replacements.sort((left, right) => right.start - left.start)
  let next = value
  for (const replacement of replacements) next = `${next.slice(0, replacement.start)}${replacement.value}${next.slice(replacement.end)}`
  return next
}

function pathPointTokens(value: string): PathPointToken[] {
  const commands = pathCommandTokens(value)
  const points: PathPointToken[] = []
  let current = { x: 0, y: 0 }
  let subpathStart = { x: 0, y: 0 }
  let pointIndex = 0
  for (const token of commands) {
    const command = token.command
    const lower = command.toLowerCase()
    const relative = command === lower
    const numbers = token.numbers
    if (lower === 'z') {
      current = { ...subpathStart }
      continue
    }
    const stride = pathCommandStride(lower)
    if (!stride) continue
    for (let offset = 0; offset + stride - 1 < numbers.length; offset += stride) {
      const commandForSegment = lower === 'm' && offset > 0 ? (relative ? 'l' : 'L') : command
      const lowerForSegment = commandForSegment.toLowerCase()
      const segment = numbers.slice(offset, offset + stride)
      const pointForPair = (pairOffset: number, kind: 'anchor' | 'control', relatedAnchorIndex?: number) => {
        const xToken = segment[pairOffset]
        const yToken = segment[pairOffset + 1]
        if (!xToken || !yToken) return undefined
        const point = {
          index: pointIndex++,
          x: relative ? current.x + xToken.value : xToken.value,
          y: relative ? current.y + yToken.value : yToken.value,
          kind,
          pairIndex: pairOffset / 2,
          command: commandForSegment,
          relatedAnchorIndex,
          xToken,
          yToken,
          relative,
        } satisfies PathPointToken
        points.push(point)
        return point
      }
      if (lowerForSegment === 'h') {
        const xToken = segment[0]
        if (xToken) {
          const next = { x: relative ? current.x + xToken.value : xToken.value, y: current.y }
          points.push({ index: pointIndex++, x: next.x, y: next.y, kind: 'anchor', pairIndex: 0, command: commandForSegment, xToken, relative })
          current = next
        }
        continue
      }
      if (lowerForSegment === 'v') {
        const yToken = segment[0]
        if (yToken) {
          const next = { x: current.x, y: relative ? current.y + yToken.value : yToken.value }
          points.push({ index: pointIndex++, x: next.x, y: next.y, kind: 'anchor', pairIndex: 0, command: commandForSegment, yToken, relative })
          current = next
        }
        continue
      }
      if (lowerForSegment === 'c') {
        const anchorIndex = pointIndex + 2
        pointForPair(0, 'control', anchorIndex)
        pointForPair(2, 'control', anchorIndex)
        const anchor = pointForPair(4, 'anchor')
        if (anchor) current = { x: anchor.x, y: anchor.y }
      } else if (lowerForSegment === 's' || lowerForSegment === 'q') {
        const anchorIndex = pointIndex + 1
        pointForPair(0, 'control', anchorIndex)
        const anchor = pointForPair(2, 'anchor')
        if (anchor) current = { x: anchor.x, y: anchor.y }
      } else if (lowerForSegment === 't' || lowerForSegment === 'm' || lowerForSegment === 'l') {
        const anchor = pointForPair(0, 'anchor')
        if (anchor) {
          current = { x: anchor.x, y: anchor.y }
          if (lowerForSegment === 'm') subpathStart = { ...current }
        }
      } else if (lowerForSegment === 'a') {
        const xToken = segment[5]
        const yToken = segment[6]
        if (xToken && yToken) {
          const next = { x: relative ? current.x + xToken.value : xToken.value, y: relative ? current.y + yToken.value : yToken.value }
          points.push({ index: pointIndex++, x: next.x, y: next.y, kind: 'anchor', pairIndex: 2, command: commandForSegment, xToken, yToken, relative })
          current = next
        }
      }
    }
  }
  return points
}

function pathCommandTokens(value: string): PathCommandToken[] {
  const commandMatches = [...value.matchAll(/[a-zA-Z]/g)].map((match) => ({ command: match[0], start: match.index ?? 0 }))
  return commandMatches.map((match, index) => {
    const end = commandMatches[index + 1]?.start ?? value.length
    const body = value.slice(match.start + 1, end)
    const numbers = [...body.matchAll(svgNumberPattern)].map((numberMatch) => {
      const text = numberMatch[0]
      const start = match.start + 1 + (numberMatch.index ?? 0)
      return { start, end: start + text.length, value: Number(text) }
    }).filter((number) => Number.isFinite(number.value))
    return { command: match.command, start: match.start, end, numbers }
  })
}

function pathCommandStride(command: string) {
  if (command === 'm' || command === 'l' || command === 't') return 2
  if (command === 'h' || command === 'v') return 1
  if (command === 's' || command === 'q') return 4
  if (command === 'c') return 6
  if (command === 'a') return 7
  return 0
}

function formatSvgNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(3))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

export function setVectorNumericAttribute(element: Element, field: VectorNumericField, value: number) {
  const tag = element.tagName.toLowerCase()
  if (tag === 'rect' || tag === 'image') element.setAttribute(field, String(value))
  else if (tag === 'text') {
    if (field === 'x' || field === 'y') element.setAttribute(field, String(value))
  } else if (tag === 'ellipse') {
    if (field === 'x') element.setAttribute('cx', String(value))
    else if (field === 'y') element.setAttribute('cy', String(value))
    else if (field === 'width') element.setAttribute('rx', String(Math.max(1, value / 2)))
    else element.setAttribute('ry', String(Math.max(1, value / 2)))
  } else if (tag === 'circle') {
    if (field === 'x') element.setAttribute('cx', String(value))
    else if (field === 'y') element.setAttribute('cy', String(value))
    else if (field === 'width' || field === 'height') element.setAttribute('r', String(Math.max(1, value / 2)))
  } else {
    if (field === 'x' || field === 'y') addTranslate(element, field === 'x' ? value : 0, field === 'y' ? value : 0)
    else addScale(element, field === 'width' ? value / 100 : value / 100)
  }
}

export function addScale(element: Element, factor: number) {
  const transform = element.getAttribute('transform') ?? ''
  const match = /scale\(([-\d.]+)\)/.exec(transform)
  if (match) {
    const next = Math.max(0.05, Number(match[1]) * factor)
    element.setAttribute('transform', transform.replace(match[0], `scale(${next})`))
  } else {
    element.setAttribute('transform', `${transform} scale(${factor})`.trim())
  }
}

function vectorObjectLabel(element: Element, index: number) {
  const tag = element.tagName.toLowerCase()
  const text = tag === 'text' ? (element.textContent ?? '').trim() : ''
  return text ? `${index + 1}. ${tag}: ${text.slice(0, 18)}` : `${index + 1}. ${tag}`
}

function vectorObjectCenter(element: Element) {
  const bounds = vectorObjectBounds(element)
  if (bounds.width || bounds.height) return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const tag = element.tagName.toLowerCase()
  const number = (name: string) => optionalSvgNumber(element.getAttribute(name)) ?? 0
  if (tag === 'rect' || tag === 'image') return { x: number('x') + number('width') / 2, y: number('y') + number('height') / 2 }
  if (tag === 'ellipse' || tag === 'circle') return { x: number('cx'), y: number('cy') }
  if (tag === 'text') return { x: number('x'), y: number('y') }
  return { x: 48, y: 48 }
}

export function vectorObjectGeometry(element: Element) {
  const tag = element.tagName.toLowerCase()
  const number = (name: string) => optionalSvgNumber(element.getAttribute(name))
  if (tag === 'rect' || tag === 'image') return { x: number('x'), y: number('y'), width: number('width'), height: number('height') }
  if (tag === 'text') return { x: number('x'), y: number('y') }
  if (tag === 'ellipse') {
    const rx = number('rx')
    const ry = number('ry')
    return { x: number('cx'), y: number('cy'), width: rx === undefined ? undefined : rx * 2, height: ry === undefined ? undefined : ry * 2 }
  }
  if (tag === 'circle') {
    const r = number('r')
    return { x: number('cx'), y: number('cy'), width: r === undefined ? undefined : r * 2, height: r === undefined ? undefined : r * 2 }
  }
  if (tag === 'g' || tag === 'svg') return vectorObjectBounds(element)
  return {}
}
