import { describe, expect, it } from 'bun:test'
import { vectorShapeInRectMarkup, vectorShapeMarkup } from '../src/features/costumes/vector-shapes'

const paint = { defs: '', fill: '#ff0000' }

describe('vector rect without rounded corners', () => {
  it('emits a sharp-cornered rect for click stamps', () => {
    const markup = vectorShapeMarkup({
      shape: 'rect',
      width: 200,
      height: 200,
      paint,
      strokeColor: '#000000',
      strokeWidth: 2,
      opacity: 100,
      text: '',
    })
    expect(markup).toContain('<rect')
    expect(markup).not.toContain('rx=')
    expect(markup).toContain('x="64"')
    expect(markup).toContain('y="64"')
    expect(markup).toContain('width="72"')
    expect(markup).toContain('height="72"')
  })

  it('emits a sharp-cornered rect for drag rectangles', () => {
    const markup = vectorShapeInRectMarkup({
      shape: 'rect',
      rect: { x: 10, y: 20, width: 30, height: 40 },
      paint,
      strokeColor: '#000000',
      strokeWidth: 2,
      opacity: 100,
    })
    expect(markup).toContain('<rect')
    expect(markup).not.toContain('rx=')
    expect(markup).toContain('x="10"')
    expect(markup).toContain('y="20"')
    expect(markup).toContain('width="30"')
    expect(markup).toContain('height="40"')
  })

  it('keeps oval and line markup unchanged', () => {
    const oval = vectorShapeMarkup({
      shape: 'oval',
      width: 200,
      height: 200,
      paint,
      strokeColor: '#000000',
      strokeWidth: 2,
      opacity: 100,
      text: '',
    })
    expect(oval).toContain('<ellipse')
    expect(oval).toContain('rx="38"')

    const line = vectorShapeMarkup({
      shape: 'line',
      width: 200,
      height: 200,
      paint,
      strokeColor: '#000000',
      strokeWidth: 2,
      opacity: 100,
      text: '',
    })
    expect(line).toContain('<path')
    expect(line).not.toContain('<rect')
  })
})

describe('independent stroke gradient paint', () => {
  const gradientStroke = {
    defs: '<defs><linearGradient id="stroke-g1"><stop offset="0" stop-color="#ff0000" stop-opacity="1"/><stop offset="1" stop-color="#0000ff" stop-opacity="0"/></linearGradient></defs>',
    stroke: 'url(#stroke-g1)',
  }
  const fillWithDefs = {
    defs: '<defs><linearGradient id="fill-g1"><stop offset="0" stop-color="#00ff00" stop-opacity="1"/><stop offset="1" stop-color="#0000ff" stop-opacity="1"/></linearGradient></defs>',
    fill: 'url(#fill-g1)',
  }

  it('emits both fill and stroke defs without touching fill markup', () => {
    const markup = vectorShapeMarkup({
      shape: 'rect',
      width: 200,
      height: 200,
      paint: fillWithDefs,
      strokeColor: '#000000',
      strokePaint: gradientStroke,
      strokeWidth: 2,
      opacity: 100,
      text: '',
    })
    // Fill defs survive byte-identical; stroke wins over the legacy color.
    expect(markup).toContain(fillWithDefs.defs)
    expect(markup).toContain(gradientStroke.defs)
    expect(markup.indexOf(fillWithDefs.defs)).toBeLessThan(markup.indexOf('<rect'))
    expect(markup).toContain('fill="url(#fill-g1)"')
    expect(markup).toContain('stroke="url(#stroke-g1)"')
    expect(markup).not.toContain('stroke="#000000"')
  })

  it('paints drag lines with the stroke gradient and keeps fill none', () => {
    const markup = vectorShapeInRectMarkup({
      shape: 'line',
      rect: { x: 10, y: 20, width: 30, height: 40 },
      paint,
      strokeColor: '#000000',
      strokePaint: gradientStroke,
      strokeWidth: 2,
      opacity: 100,
    })
    expect(markup).toContain('fill="none"')
    expect(markup).toContain('stroke="url(#stroke-g1)"')
    expect(markup).toContain(gradientStroke.defs)
  })

  it('paints text with both gradients and the thin outline width', () => {
    const markup = vectorShapeMarkup({
      shape: 'text',
      width: 200,
      height: 200,
      paint: fillWithDefs,
      strokeColor: '#000000',
      strokePaint: gradientStroke,
      strokeWidth: 4,
      opacity: 100,
      text: 'hi',
    })
    expect(markup).toContain(fillWithDefs.defs)
    expect(markup).toContain(gradientStroke.defs)
    expect(markup).toContain('fill="url(#fill-g1)"')
    expect(markup).toContain('stroke="url(#stroke-g1)"')
    // Visual parity: new no-transform text stores UI/2 (UI 4 -> SVG 2).
    expect(markup).toContain('stroke-width="2"')
  })
})
