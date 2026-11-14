import { describe, expect, it } from 'bun:test'
import { combineSvgTransforms, editableVectorUnits, ungroupVectorElements } from '../src/features/costumes/vector-svg'

class FakeElement {
  tagName: string
  children: FakeElement[] = []
  parentNode: FakeElement | null = null
  private attrs = new Map<string, string>()

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value)
  }

  getAttribute(name: string) {
    return this.attrs.has(name) ? this.attrs.get(name)! : null
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value))
  }

  removeAttribute(name: string) {
    this.attrs.delete(name)
  }

  hasAttribute(name: string) {
    return this.attrs.has(name)
  }

  appendChild(child: FakeElement) {
    child.remove()
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child: FakeElement, ref: FakeElement | null) {
    child.remove()
    child.parentNode = this
    const index = ref ? this.children.indexOf(ref) : -1
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  remove() {
    if (!this.parentNode) return
    const index = this.parentNode.children.indexOf(this)
    if (index >= 0) this.parentNode.children.splice(index, 1)
    this.parentNode = null
  }
}

const asElement = (node: FakeElement) => node as unknown as Element
const tags = (svg: FakeElement) => svg.children.map((child) => child.tagName)

describe('combineSvgTransforms', () => {
  it('keeps nesting order (outer then inner)', () => {
    expect(combineSvgTransforms('translate(10 20)', 'scale(2)')).toBe('translate(10 20) scale(2)')
    expect(combineSvgTransforms('', 'scale(2)')).toBe('scale(2)')
    expect(combineSvgTransforms('translate(10 20)', '')).toBe('translate(10 20)')
  })
})

describe('ungroupVectorElements', () => {
  it('moves children out in place and bakes the group transform', () => {
    const svg = new FakeElement('svg')
    const before = new FakeElement('rect')
    const group = new FakeElement('g', { transform: 'translate(10 20)' })
    const first = new FakeElement('rect')
    const second = new FakeElement('rect', { transform: 'scale(2)' })
    const after = new FakeElement('rect')
    svg.appendChild(before)
    svg.appendChild(group)
    svg.appendChild(after)
    group.appendChild(first)
    group.appendChild(second)

    const ungrouped = ungroupVectorElements(asElement(svg), [1])

    expect(tags(svg)).toEqual(['rect', 'rect', 'rect', 'rect'])
    expect(first.getAttribute('transform')).toBe('translate(10 20)')
    expect(second.getAttribute('transform')).toBe('translate(10 20) scale(2)')
    expect(ungrouped).toEqual([asElement(first), asElement(second)])
  })

  it('reduces single-child subgroups like scratch-paint', () => {
    const svg = new FakeElement('svg')
    const group = new FakeElement('g', { transform: 'translate(10 0)' })
    const middle = new FakeElement('g', { transform: 'translate(0 20)' })
    const sub = new FakeElement('g', { transform: 'scale(2)' })
    const leaf = new FakeElement('rect')
    const other = new FakeElement('rect')
    svg.appendChild(group)
    group.appendChild(middle)
    group.appendChild(other)
    middle.appendChild(sub)
    sub.appendChild(leaf)

    // The wrapper group is transparent unit-wise, so [0] addresses middle.
    ungroupVectorElements(asElement(svg), [0])

    expect(tags(svg)).toEqual(['g'])
    const top = svg.children[0]!
    expect(top.children.map((child) => child.tagName)).toEqual(['rect', 'rect'])
    expect(top.children[0]!.getAttribute('transform')).toBe('translate(0 20) scale(2)')
  })

  it('keeps multi-child subgroups grouped with a composed transform', () => {
    const svg = new FakeElement('svg')
    const unit = new FakeElement('g', { transform: 'translate(10 0)' })
    const other = new FakeElement('rect')
    const sub = new FakeElement('g', { transform: 'scale(2)' })
    const moved = new FakeElement('rect')
    svg.appendChild(unit)
    svg.appendChild(other)
    unit.appendChild(sub)
    unit.appendChild(moved)
    sub.appendChild(new FakeElement('rect'))
    sub.appendChild(new FakeElement('rect'))

    ungroupVectorElements(asElement(svg), [0])

    expect(tags(svg)).toEqual(['g', 'rect', 'rect'])
    expect(svg.children[0]!.getAttribute('transform')).toBe('translate(10 0) scale(2)')
    expect(svg.children[1]!.getAttribute('transform')).toBe('translate(10 0)')
  })

  it('removes empty groups and skips text-tool groups', () => {
    const svg = new FakeElement('svg')
    const empty = new FakeElement('g')
    const textGroup = new FakeElement('g', { 'data-is-pg-text-item': 'true' })
    textGroup.appendChild(new FakeElement('rect'))
    const keep = new FakeElement('rect')
    svg.appendChild(empty)
    svg.appendChild(textGroup)
    svg.appendChild(keep)

    // Empty wrappers are filtered from selection (ghost-outline guard): only
    // the text group and the rect are addressable units, DOM preserved.
    expect(editableVectorUnits(asElement(svg)).length).toBe(2)
    // [0] addresses the text-tool group (skipped), [1] the rect (not a group).
    const ungrouped = ungroupVectorElements(asElement(svg), [0, 1])

    expect(tags(svg)).toEqual(['g', 'g', 'rect'])
    expect(ungrouped).toEqual([])
  })
})
