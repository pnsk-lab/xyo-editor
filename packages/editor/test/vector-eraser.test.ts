import { describe, expect, it } from 'bun:test'
import paper from 'paper'
import { eraseFromItem, separateCompoundPath } from '../src/features/costumes/vector-eraser'

// Minimal stand-ins for paper.Item/Path/CompoundPath covering only the
// members the vector eraser touches, with honest parent/children bookkeeping
// (remove() detaches like paper.js does).
class FakeItem {
  className = 'Path'
  parent: FakeItem | undefined
  children: FakeItem[] | undefined
  removed = false
  clockwise = true
  area = 0
  closed = true
  segments: Array<Record<string, never>> | undefined = [{}, {}]
  fillColor: unknown = { alpha: 1 }
  strokeColor: unknown = undefined
  strokeWidth: unknown = 1
  firstSegment = { point: { x: 0, y: 0 } }
  length = 10

  hitTestResult = false
  touchedByEraser = false
  containsResult = false
  subtractResult: FakeItem | undefined

  copyAttributes(_source: unknown, _strip?: boolean) {}
  reverse() {
    this.clockwise = !this.clockwise
  }

  appendChild(child: FakeItem) {
    if (!this.children) this.children = []
    child.detach()
    child.parent = this
    this.children.push(child)
    return child
  }

  private detach() {
    if (!this.parent) return
    const siblings = this.parent.children
    if (siblings) {
      const index = siblings.indexOf(this)
      if (index >= 0) siblings.splice(index, 1)
    }
    this.parent = undefined
  }

  insertAbove(ref: FakeItem) {
    this.detach()
    const parent = ref.parent
    if (parent?.children) {
      const index = parent.children.indexOf(ref)
      parent.children.splice(index + 1, 0, this)
      this.parent = parent
    }
  }

  insertBelow(ref: FakeItem) {
    this.detach()
    const parent = ref.parent
    if (parent?.children) {
      const index = parent.children.indexOf(ref)
      parent.children.splice(index, 0, this)
      this.parent = parent
    }
  }

  remove() {
    this.detach()
    this.removed = true
  }

  hitTest(_point: unknown) {
    return this.hitTestResult ? {} : null
  }

  intersects(other: unknown) {
    return (other as FakeItem).touchedByEraser
  }

  contains(_point: unknown) {
    return this.containsResult
  }

  getIntersections(_other: unknown): unknown[] {
    return []
  }

  getLocationAt(_offset: number) {
    return { point: { x: 0, y: 0 } }
  }

  clone() {
    const clone = new FakeItem()
    clone.closed = this.closed
    clone.fillColor = this.fillColor
    return clone
  }

  subtract(_other: unknown) {
    if (!this.subtractResult) throw new Error('no subtract result stubbed')
    return this.subtractResult
  }
}

const asItem = (fake: FakeItem) => fake as unknown as paper.Item
const asEraser = (fake: FakeItem) => fake as unknown as paper.PathItem

function makeSolidPath(area: number, enclosesHoles: boolean): FakeItem {
  const path = new FakeItem()
  path.className = 'Path'
  path.children = undefined
  path.area = area
  path.hitTestResult = enclosesHoles
  return path
}

function makeHole(area: number): FakeItem {
  const hole = new FakeItem()
  hole.className = 'Path'
  hole.children = undefined
  hole.clockwise = false
  hole.area = area
  return hole
}

describe('vector eraser with Paper geometry', () => {
  it('preserves unfilled closed outlines when the eraser crosses them', () => {
    const scope = new paper.PaperScope()
    scope.setup(new scope.Size(200, 200))
    const rectangle = new scope.Path.Rectangle({ point: [20, 20], size: [100, 100], strokeColor: 'black' })
    const eraser = new scope.Path.Circle({ center: [20, 70], radius: 10 })

    const result = eraseFromItem(rectangle, eraser)

    expect(result.touched).toBe(true)
    expect(result.survivors.length).toBeGreaterThan(0)
    expect(result.survivors.every(item => !(item as paper.Path).closed)).toBe(true)
    expect(result.survivors.reduce((sum, item) => sum + (item as paper.Path).length, 0)).toBeCloseTo(380, 0)
    scope.remove()
  })

  it('erases nested paths while preserving the group and siblings', () => {
    const scope = new paper.PaperScope()
    scope.setup(new scope.Size(200, 200))
    const rect = new scope.Path.Rectangle({ point: [0, 0], size: [100, 100], fillColor: 'red' })
    const other = new scope.Path.Rectangle({ point: [150, 150], size: [20, 20], fillColor: 'blue' })
    const inner = new scope.Group([rect, other])
    const outer = new scope.Group([inner])
    const eraser = new scope.Path.Circle({ center: [50, 50], radius: 10 })

    const result = eraseFromItem(outer, eraser)

    expect(result.touched).toBe(true)
    expect(result.survivors).toEqual([outer])
    expect(outer.children[0]).toBe(inner)
    expect(inner.children).toContain(other)
    expect(inner.children.some(item => item !== other && !(item as paper.Path).contains(new scope.Point(50, 50)))).toBe(true)
    scope.remove()
  })
})

describe('vector eraser path handling', () => {
  it('splits a closed unfilled stroke rather than subtracting its interior', () => {
    const stroke = makeSolidPath(100, false)
    stroke.fillColor = null
    stroke.touchedByEraser = true
    stroke.subtractResult = makeSolidPath(50, false)
    const eraser = new FakeItem()

    const result = eraseFromItem(asItem(stroke), asEraser(eraser))

    expect(result.touched).toBe(true)
    expect(result.survivors).toEqual([asItem(stroke)])
    expect(stroke.removed).toBe(false)
  })

  it('retains open filled path fragments outside the subtraction result', () => {
    const path = makeSolidPath(100, false)
    path.closed = false
    path.touchedByEraser = true
    const remainder = makeSolidPath(50, false)
    path.subtractResult = remainder

    const result = eraseFromItem(asItem(path), asEraser(new FakeItem()))

    expect(result.survivors).toHaveLength(2)
    expect(result.survivors).toContain(asItem(remainder))
    expect(result.survivors.every(item => !(item as unknown as FakeItem).removed)).toBe(true)
  })

  it('erases within nested groups without flattening their hierarchy', () => {
    const group = new FakeItem()
    group.className = 'Group'
    group.segments = undefined
    group.children = []
    const nested = new FakeItem()
    nested.className = 'Group'
    nested.segments = undefined
    nested.children = []
    const path = makeSolidPath(100, false)
    path.touchedByEraser = true
    const remainder = makeSolidPath(50, false)
    path.subtractResult = remainder
    group.appendChild(nested)
    nested.appendChild(path)

    const result = eraseFromItem(asItem(group), asEraser(new FakeItem()))

    expect(result.touched).toBe(true)
    expect(result.survivors).toEqual([asItem(group)])
    expect(group.children).toEqual([nested])
    expect(nested.children).toEqual([remainder])
  })
})

describe('vector eraser CompoundPath handling', () => {
  it('keeps the split pieces when erasing a hole into a shape', () => {
    // Erasing the middle of a filled rect yields a compound (outer + hole);
    // the surviving ring must be kept, not dropped.
    const target = makeSolidPath(10000, false)
    target.touchedByEraser = true
    const outer = makeSolidPath(10000, true)
    const hole = makeHole(100)
    const carved = makeSolidPath(9900, false)
    const compound = new FakeItem()
    compound.className = 'CompoundPath'
    compound.children = []
    compound.segments = undefined
    compound.appendChild(outer)
    compound.appendChild(hole)
    outer.subtractResult = carved
    target.subtractResult = compound
    const eraser = new FakeItem()

    const { touched, survivors } = eraseFromItem(asItem(target), asEraser(eraser))

    expect(touched).toBe(true)
    expect(survivors).toHaveLength(1)
    expect(survivors[0]).toBe(asItem(carved))
    expect((survivors[0] as unknown as FakeItem).removed).toBe(false)
  })

  it('erases a lone CompoundPath instead of skipping it', () => {
    // A donut-shaped top-level path used to yield zero targets, so the
    // eraser never touched it.
    const donut = new FakeItem()
    donut.className = 'CompoundPath'
    donut.segments = undefined
    donut.children = []
    donut.appendChild(makeSolidPath(10000, true))
    donut.appendChild(makeHole(100))
    donut.touchedByEraser = true
    const remainder = makeSolidPath(8000, false)
    remainder.children = undefined
    donut.subtractResult = remainder
    const eraser = new FakeItem()

    const { touched, survivors } = eraseFromItem(asItem(donut), asEraser(eraser))

    expect(touched).toBe(true)
    expect(survivors).toHaveLength(1)
    expect(survivors[0]).toBe(asItem(remainder))
  })

  it('preserves untouched siblings when only one shape is erased', () => {
    const group = new FakeItem()
    group.className = 'Group'
    group.segments = undefined
    group.children = []
    const first = makeSolidPath(10000, false)
    first.touchedByEraser = true
    const second = makeSolidPath(5000, false)
    second.touchedByEraser = false
    group.appendChild(first)
    group.appendChild(second)
    const firstRemainder = makeSolidPath(7000, false)
    firstRemainder.children = undefined
    first.subtractResult = firstRemainder
    const eraser = new FakeItem()

    const { touched, survivors } = eraseFromItem(asItem(group), asEraser(eraser))

    expect(touched).toBe(true)
    expect(survivors).toEqual([asItem(group)])
    expect(group.children).toEqual([firstRemainder, second])
  })

  it('keeps orphan holes instead of dropping them with the container', () => {
    const compound = new FakeItem()
    compound.className = 'CompoundPath'
    compound.segments = undefined
    compound.children = []
    const solid = makeSolidPath(10000, false)
    const orphan = makeHole(100)
    compound.appendChild(solid)
    compound.appendChild(orphan)

    const pieces = separateCompoundPath(compound as unknown as paper.CompoundPath)

    expect(pieces).toHaveLength(2)
    expect(pieces).toContain(solid as unknown as paper.Item)
    expect(pieces).toContain(orphan as unknown as paper.Item)
    expect(compound.removed).toBe(true)
  })
})
