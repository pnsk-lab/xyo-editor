// vector-point-style の unit テスト (Paper.js の実形状を使用、DOM 不要)。
// 既存 `vector-path-points.test.ts` と同じ実行形態 (bun:test + paper)。

import { describe, expect, it } from 'bun:test'
import paper from 'paper'
import {
  canCurvePaperPoint,
  canPointPaperPoint,
  classifyPaperPointStyle,
  curvePaperPoints,
  curveVectorPointStyle,
  pointPaperPoints,
  pointVectorPointStyle,
} from '../src/features/costumes/vector-point-style'

function makeScope() {
  const scope = new paper.PaperScope()
  scope.setup(new scope.Size(480, 360))
  return scope
}

function straightLine(scope: paper.PaperScope, points: Array<[number, number]> = [[0, 0], [50, 0], [100, 0]]) {
  const path = new scope.Path()
  for (const [x, y] of points) path.add(new scope.Point(x, y))
  return path as paper.Path
}

function smoothBump(scope: paper.PaperScope) {
  const path = new scope.Path('M0 0 C30 -40 70 -40 100 0 C130 40 170 40 200 0') as paper.Path
  return path
}

function anchorPositions(path: paper.Path): Array<[number, number]> {
  return path.segments.map((segment) => [segment.point.x, segment.point.y] as [number, number])
}

function handleLengths(path: paper.Path): Array<[number, number]> {
  return path.segments.map((segment) => [
    Math.hypot(segment.handleIn.x, segment.handleIn.y),
    Math.hypot(segment.handleOut.x, segment.handleOut.y),
  ] as [number, number])
}

function stubElement(tag: string) {
  return { tagName: tag } as unknown as Element
}

describe('classifyPaperPointStyle', () => {
  it('直線中間点は pointed、曲線中間点は curved', () => {
    const scope = makeScope()
    try {
      const line = straightLine(scope)
      expect(classifyPaperPointStyle(line as paper.Item, 1)).toBe('pointed')
      const bump = smoothBump(scope)
      // 滑らかな 3 点ベジェの中間点は対称ハンドルを持つ。
      expect(classifyPaperPointStyle(bump as paper.Item, 2)).toBe('curved')
      // 制御枠・範囲外は undefined。
      expect(classifyPaperPointStyle(bump as paper.Item, 3)).toBeUndefined()
      expect(classifyPaperPointStyle(bump as paper.Item, 99)).toBeUndefined()
    } finally {
      scope.remove()
    }
  })

  it('開パス端点は接続側のみで判定する', () => {
    const scope = makeScope()
    try {
      const line = straightLine(scope, [[0, 0], [100, 0]])
      expect(classifyPaperPointStyle(line as paper.Item, 0)).toBe('pointed')
      expect(classifyPaperPointStyle(line as paper.Item, 1)).toBe('pointed')
    } finally {
      scope.remove()
    }
  })

  it('同じ向きに重なったハンドルは curved とみなさない', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope)
      const middle = path.segments[1]!
      middle.handleIn = new scope.Point(10, 0)
      middle.handleOut = new scope.Point(10, 0)
      expect(classifyPaperPointStyle(path as paper.Item, 1)).toBe('pointed')
      expect(canCurvePaperPoint(path as paper.Item, 1).ok).toBe(true)
    } finally {
      scope.remove()
    }
  })
})

describe('curvePaperPoints', () => {
  it('直線中間点を曲線化しても形状・点数・座標は不変', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope)
      const beforeLength = path.length
      const result = curvePaperPoints(path as paper.Item, [1])
      expect(result.changedIndices).toEqual([1])
      expect(result.skipped).toEqual([])
      expect(path.segments.length).toBe(3)
      expect(anchorPositions(path)).toEqual([[0, 0], [50, 0], [100, 0]])
      expect(path.length).toBeCloseTo(beforeLength, 6)
      // 弦方向の対称ハンドルが付く。
      const middle = path.segments[1]!
      expect(Math.hypot(middle.handleIn.x, middle.handleIn.y)).toBeGreaterThan(0)
      expect(middle.handleOut.x).toBeCloseTo(-middle.handleIn.x, 9)
      expect(middle.handleOut.y).toBeCloseTo(-middle.handleIn.y, 9)
      expect(classifyPaperPointStyle(path as paper.Item, 1)).toBe('curved')
    } finally {
      scope.remove()
    }
  })

  it('既に滑らかな点は already-styled で skip する', () => {
    const scope = makeScope()
    try {
      const bump = smoothBump(scope)
      const before = handleLengths(bump)
      const result = curvePaperPoints(bump as paper.Item, [2])
      expect(result.changedIndices).toEqual([])
      expect(result.skipped).toEqual([{ index: 2, reason: 'already-styled' }])
      expect(handleLengths(bump)).toEqual(before)
    } finally {
      scope.remove()
    }
  })

  it('片側ハンドルのみ残る角は反転複写で対称化する', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope)
      const middle = path.segments[1]!
      middle.handleIn = new scope.Point(-12, 0)
      const result = curvePaperPoints(path as paper.Item, [1])
      expect(result.changedIndices).toEqual([1])
      expect(middle.handleOut.x).toBeCloseTo(12, 9)
      expect(middle.handleOut.y).toBeCloseTo(0, 9)
    } finally {
      scope.remove()
    }
  })

  it('開パス端点は接続側だけに単片ハンドルを作る', () => {
    const scope = makeScope()
    try {
      const path = straightLine(scope, [[0, 0], [100, 0]])
      const start = curvePaperPoints(path as paper.Item, [0])
      expect(start.changedIndices).toEqual([0])
      expect(isFinite(path.segments[0]!.handleOut.x)).toBe(true)
      expect(Math.hypot(path.segments[0]!.handleOut.x, path.segments[0]!.handleOut.y)).toBeGreaterThan(0)
      expect(path.segments[0]!.handleIn.x).toBe(0)
      expect(path.segments[0]!.handleIn.y).toBe(0)
      // 始点の曲線化で後にハンドル枠が増えるため、終点は変異後の index 2 で指定する。
      const end = curvePaperPoints(path as paper.Item, [2])
      expect(end.changedIndices).toEqual([2])
      expect(Math.hypot(path.segments[1]!.handleIn.x, path.segments[1]!.handleIn.y)).toBeGreaterThan(0)
      expect(path.segments[1]!.handleOut.x).toBe(0)
      expect(path.segments[1]!.handleOut.y).toBe(0)
      // アンカー座標は動かない。
      expect(anchorPositions(path)).toEqual([[0, 0], [100, 0]])
    } finally {
      scope.remove()
    }
  })

  it('閉パスは wrap して両隣を参照する', () => {
    const scope = makeScope()
    try {
      const triangle = new scope.Path({ closed: true }) as paper.Path
      triangle.add(new scope.Point(0, 0))
      triangle.add(new scope.Point(100, 0))
      triangle.add(new scope.Point(50, 80))
      const result = curvePaperPoints(triangle as paper.Item, [0, 1, 2])
      // 各アンカーの後に in/out 枠が増えるため、変異後の anchor index は 0,3,6。
      expect(result.changedIndices).toEqual([0, 3, 6])
      for (const segment of triangle.segments) {
        expect(Math.hypot(segment.handleIn.x, segment.handleIn.y)).toBeGreaterThan(0)
        expect(Math.hypot(segment.handleOut.x, segment.handleOut.y)).toBeGreaterThan(0)
      }
      expect(triangle.closed).toBe(true)
      expect(anchorPositions(triangle)).toEqual([[0, 0], [100, 0], [50, 80]])
    } finally {
      scope.remove()
    }
  })

  it('制御枠・範囲外・重複指定を安全に skip する', () => {
    const scope = makeScope()
    try {
      const bump = smoothBump(scope)
      const result = curvePaperPoints(bump as paper.Item, [2, 2, 3, 99])
      expect(result.changedIndices).toEqual([])
      const reasons = Object.fromEntries(result.skipped.map((item) => [item.index, item.reason]))
      expect(reasons[2]).toBe('already-styled')
      expect(reasons[3]).toBe('control-point')
      expect(reasons[99]).toBe('not-found')
    } finally {
      scope.remove()
    }
  })

  it('非対象セグメントのハンドルに触れない', () => {
    const scope = makeScope()
    try {
      const first = straightLine(scope)
      const second = straightLine(scope, [[0, 100], [50, 100], [100, 100]])
      const group = new scope.Group([first, second])
      const before = handleLengths(second)
      // flattened: 前半 0-2、後半 3-5。中間点 4 のみ曲線化する。
      const result = curvePaperPoints(group as paper.Item, [4])
      expect(result.changedIndices).toEqual([4])
      expect(handleLengths(first)).toEqual([[0, 0], [0, 0], [0, 0]])
      expect(second.segments[0]!.point.x).toBe(0)
      expect(second.segments[2]!.point.x).toBe(100)
      expect(handleLengths(second)[0]).toEqual(before[0])
      expect(handleLengths(second)[2]).toEqual(before[2])
    } finally {
      scope.remove()
    }
  })
})

describe('pointPaperPoints', () => {
  it('滑らかな点を直線化し、アンカーと点数は保持する', () => {
    const scope = makeScope()
    try {
      const bump = smoothBump(scope)
      const before = anchorPositions(bump)
      const result = pointPaperPoints(bump as paper.Item, [2])
      expect(result.changedIndices).toEqual([2])
      expect(anchorPositions(bump)).toEqual(before)
      expect(bump.segments.length).toBe(3)
      const middle = bump.segments[1]!
      expect(middle.handleIn.x).toBe(0)
      expect(middle.handleIn.y).toBe(0)
      expect(middle.handleOut.x).toBe(0)
      expect(middle.handleOut.y).toBe(0)
      expect(classifyPaperPointStyle(bump as paper.Item, 2)).toBe('pointed')
    } finally {
      scope.remove()
    }
  })

  it('既に直線の点・制御枠は変更しない', () => {
    const scope = makeScope()
    try {
      const line = straightLine(scope)
      expect(pointPaperPoints(line as paper.Item, [1])).toEqual({
        changedIndices: [],
        skipped: [{ index: 1, reason: 'already-styled' }],
      })
      expect(canPointPaperPoint(line as paper.Item, 3)).toEqual({ ok: false, reason: 'not-found' })
      const bump = smoothBump(scope)
      // 中間点の in ハンドル枠 (flattened 3) は制御枠として拒否される。
      expect(canPointPaperPoint(bump as paper.Item, 3)).toEqual({ ok: false, reason: 'control-point' })
    } finally {
      scope.remove()
    }
  })

  it('複数点を一括で直線化する', () => {
    const scope = makeScope()
    try {
      const triangle = new scope.Path({ closed: true }) as paper.Path
      triangle.add(new scope.Point(0, 0))
      triangle.add(new scope.Point(100, 0))
      triangle.add(new scope.Point(50, 80))
      expect(curvePaperPoints(triangle as paper.Item, [0, 1, 2]).changedIndices).toEqual([0, 3, 6])
      // 曲線化後は anchor が 0,3,6 にずれるため、両端の指定も変異後の値を使う。
      // 直線化で枠が減り、変異後の anchor index は 0,4 になる。
      expect(pointPaperPoints(triangle as paper.Item, [0, 6]).changedIndices).toEqual([0, 4])
      expect(classifyPaperPointStyle(triangle as paper.Item, 0)).toBe('pointed')
      expect(classifyPaperPointStyle(triangle as paper.Item, 1)).toBe('curved')
      expect(classifyPaperPointStyle(triangle as paper.Item, 4)).toBe('pointed')
    } finally {
      scope.remove()
    }
  })
})

describe('DOM wrapper guards', () => {
  it('非編集要素は Paper・DOM に触れずに拒否する', async () => {
    await expect(curveVectorPointStyle(stubElement('text'), [0])).resolves.toEqual({
      changed: false,
      changedIndices: [],
      skipped: [],
      reason: 'not-editable',
    })
    await expect(pointVectorPointStyle(stubElement('image'), [1])).resolves.toEqual({
      changed: false,
      changedIndices: [],
      skipped: [],
      reason: 'not-editable',
    })
  })
})
