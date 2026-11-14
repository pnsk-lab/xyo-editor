import { describe, expect, it } from 'bun:test'
import { vectorShapeInRectMarkup } from '../src/features/costumes/vector-shapes'
import { resolveVectorLinearUserSpace, resolveVectorRadialUserSpace } from '../src/features/costumes/paint-colors'

// Locks the contract that the drag preview in VectorShapePreview.svelte
// matches the committed markup from vectorShapeInRectMarkup: rectangles are
// sharp-cornered on both sides, and both sides use identical `userSpaceOnUse`
// gradient geometry (never the legacy `objectBoundingBox` / `70%`). The
// preview component itself needs a browser to render, so geometry is covered
// by source-level assertions below plus the real-editor pixel suite
// `vector-shape-preview-commit-parity.browser.test.ts`.
describe('vector rect preview matches committed markup', () => {
  it('emits sharp-cornered rect markup for drag rectangles', () => {
    const markup = vectorShapeInRectMarkup({
      shape: 'rect',
      rect: { x: 10, y: 20, width: 30, height: 40 },
      paint: { defs: '', fill: '#ff0000' },
      strokeColor: '#000000',
      strokeWidth: 2,
      opacity: 100,
    })
    expect(markup).toContain('<rect')
    expect(markup).not.toContain('rx=')
  })

  it('renders the preview rect without rounded corners', async () => {
    const source = await Bun.file(
      new URL('../src/features/CostumeEditor/VectorShapePreview.svelte', import.meta.url),
    ).text()
    const rectLine = source.split('\n').find((line) => line.includes('<rect'))
    expect(rectLine).toBeDefined()
    expect(rectLine).not.toContain('rx=')
  })

  it('uses userSpaceOnUse gradients matching the commit helpers', async () => {
    const source = await Bun.file(
      new URL('../src/features/CostumeEditor/VectorShapePreview.svelte', import.meta.url),
    ).text()
    expect(source).toContain('gradientUnits="userSpaceOnUse"')
    expect(source).not.toContain('gradientUnits="objectBoundingBox"')
    expect(source).not.toContain('r="70%"')
    // The preview resolves the same normalized drag bounds through the shared
    // helpers, so degenerate orthogonal line ramps stay non-degenerate.
    expect(source).toContain('resolveVectorLinearUserSpace')
    expect(source).toContain('resolveVectorRadialUserSpace')
  })

  it('keeps orthogonal linear ramps non-degenerate with the 0.01 minimum', () => {
    // Horizontal line (zero height) with a vertical ramp, and vertical line
    // (zero width) with a horizontal ramp: both must span 0.01, never equal
    // endpoints (which would render as a solid last-stop in SVG).
    const verticalOnFlat = resolveVectorLinearUserSpace({ x: 10, y: 20, width: 100, height: 0 }, 'vertical')
    expect(verticalOnFlat.x1).toBe(verticalOnFlat.x2)
    expect(Math.abs(verticalOnFlat.y2 - verticalOnFlat.y1)).toBeGreaterThan(0.005)
    const horizontalOnThin = resolveVectorLinearUserSpace({ x: 10, y: 20, width: 0, height: 100 }, 'horizontal')
    expect(horizontalOnThin.y1).toBe(horizontalOnThin.y2)
    expect(Math.abs(horizontalOnThin.x2 - horizontalOnThin.x1)).toBeGreaterThan(0.005)
    // Radial stays a valid circle even for degenerate bounds.
    const radial = resolveVectorRadialUserSpace({ x: 10, y: 20, width: 0, height: 0 }, undefined)
    expect(radial.r).toBeGreaterThan(0)
  })
})
