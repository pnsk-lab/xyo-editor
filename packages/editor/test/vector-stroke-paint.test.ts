// Tests for the independent stroke-paint helper (`vector-stroke-paint.ts`).
// Pure string/stub-element coverage only (no DOMParser, no Paper.js, no
// Svelte): solid/transparent/no-stroke output, transparent gradient ends,
// fill/stroke non-interference, same-ID two-document replacement, and
// existing-stop/attribute protection.

import { describe, expect, it } from 'bun:test';
import {
  applyStrokePaintToElement,
  collectGradientIds,
  extractStrokeGradientId,
  insertStrokeDefsIntoSvg,
  isGradientIdReferenced,
  isStrokeInvisible,
  pruneUnreferencedStrokeGradient,
  rekeyStrokeGradientDefs,
  rekeyStrokePaintReference,
  removeGradientDefsById,
  resolveStrokePaintForReplace,
  resolveVectorStrokePaint,
  strokePrimaryInput,
  strokeSecondaryInput,
  swapStrokePaintState,
  svgStrokePaint,
  uniqueStrokeGradientId,
  type StrokePaintElement,
} from '../src/features/costumes/vector-stroke-paint';

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

class StubElement implements StrokePaintElement {
  private attrs = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.attrs);
  }
}

describe('svgStrokePaint core output', () => {
  it('emits solid colors and none for transparent', () => {
    expect(svgStrokePaint({ id: 's', gradient: 'solid', primary: RED, secondary: BLUE, strokeWidth: 4, width: 100, height: 100 })).toEqual({
      defs: '',
      stroke: '#ff0000',
      id: '',
    });
    expect(svgStrokePaint({ id: 's', gradient: 'solid', primary: null, secondary: BLUE, strokeWidth: 4, width: 100, height: 100 })).toEqual({
      defs: '',
      stroke: 'none',
      id: '',
    });
    // Translucent solids keep rgba form (alpha must survive serialization).
    expect(
      svgStrokePaint({ id: 's', gradient: 'solid', primary: { r: 255, g: 0, b: 0, a: 128 }, secondary: null, strokeWidth: 4, width: 100, height: 100 }).stroke,
    ).toContain('rgba(255, 0, 0,');
  });

  it('treats width 0 / negative / non-finite as no stroke even with a gradient', () => {
    for (const strokeWidth of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const paint = svgStrokePaint({ id: 'g', gradient: 'horizontal', primary: RED, secondary: BLUE, strokeWidth, width: 480, height: 360 });
      expect(paint).toEqual({ defs: '', stroke: 'none', id: '' });
    }
  });

  it('emits linear and radial gradients with split stop opacity', () => {
    const horizontal = svgStrokePaint({ id: 'sh', gradient: 'horizontal', primary: RED, secondary: BLUE, strokeWidth: 3, width: 480, height: 360 });
    expect(horizontal.stroke).toBe('url(#sh)');
    expect(horizontal.id).toBe('sh');
    expect(horizontal.defs).toContain('<linearGradient');
    // Per-object ramp (matches the live preview): spans the element bbox,
    // not a fixed 480x360 canvas slice, so position/size never shift colors.
    expect(horizontal.defs).toContain('gradientUnits="objectBoundingBox"');
    expect(horizontal.defs).toContain('x2="100%"');
    expect(horizontal.defs).not.toContain('x2="480"');
    const vertical = svgStrokePaint({ id: 'sv', gradient: 'vertical', primary: RED, secondary: BLUE, strokeWidth: 3, width: 480, height: 360 });
    expect(vertical.defs).toContain('y2="100%"');
    expect(vertical.defs).not.toContain('y2="360"');
    const radial = svgStrokePaint({ id: 'sr', gradient: 'radial', primary: RED, secondary: BLUE, strokeWidth: 3, width: 100, height: 100 });
    expect(radial.stroke).toBe('url(#sr)');
    expect(radial.defs).toContain('<radialGradient');
    expect(radial.defs).toContain('stop-color="#ff0000"');
    expect(radial.defs).toContain('stop-color="#0000ff"');
  });

  it('is deterministic for the same id and state (no Date.now/random)', () => {
    const options = { id: 'stable', gradient: 'horizontal' as const, primary: RED, secondary: BLUE, strokeWidth: 2, width: 480, height: 360 };
    expect(svgStrokePaint(options)).toEqual(svgStrokePaint({ ...options }));
  });
});

describe('stroke transparent endpoints (no black swing)', () => {
  it('reuses the surviving end RGB with alpha 0 in both directions', () => {
    const toTransparent = svgStrokePaint({ id: 'g1', gradient: 'horizontal', primary: RED, secondary: null, strokeWidth: 2, width: 480, height: 360 });
    expect(toTransparent.stroke).toBe('url(#g1)');
    expect(toTransparent.defs).toContain('stop-color="#ff0000"');
    expect(toTransparent.defs).toContain('stop-opacity="0"');
    expect(toTransparent.defs).not.toContain('#000000');

    const fromTransparent = svgStrokePaint({ id: 'g2', gradient: 'vertical', primary: null, secondary: BLUE, strokeWidth: 2, width: 480, height: 360 });
    expect(fromTransparent.defs).toContain('stop-color="#0000ff"');
    expect(fromTransparent.defs).toContain('stop-opacity="0"');
    expect(fromTransparent.defs).not.toContain('#000000');
  });

  it('keeps both-transparent gradients fully transparent', () => {
    const paint = svgStrokePaint({ id: 'g3', gradient: 'radial', primary: null, secondary: null, strokeWidth: 2, width: 100, height: 100 });
    expect(paint.stroke).toBe('url(#g3)');
    expect(paint.defs).toContain('stop-opacity="0"');
  });

  it('maps toggle state without losing the stored hex', () => {
    expect(strokePrimaryInput(false, '#ffab19')).toEqual({ r: 255, g: 171, b: 25, a: 255 });
    expect(strokePrimaryInput(true, '#ffab19')).toBe(null);
    expect(strokeSecondaryInput(false, '#ffffff')).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(strokeSecondaryInput(true, '#ffffff')).toBe(null);

    const paint = resolveVectorStrokePaint({
      id: 't',
      strokeTransparent: true,
      strokeHex: '#123456',
      secondaryTransparent: false,
      secondaryHex: '#ffffff',
      gradient: 'solid',
      strokeWidth: 4,
      width: 480,
      height: 360,
    });
    expect(paint).toEqual({ defs: '', stroke: 'none', id: '' });
    const restored = resolveVectorStrokePaint({
      id: 't',
      strokeTransparent: false,
      strokeHex: '#123456',
      secondaryTransparent: false,
      secondaryHex: '#ffffff',
      gradient: 'solid',
      strokeWidth: 4,
      width: 480,
      height: 360,
    });
    expect(restored).toEqual({ defs: '', stroke: '#123456', id: '' });
  });
});

describe('stroke visibility and swap', () => {
  it('detects invisible strokes (width gate + transparent paint)', () => {
    expect(isStrokeInvisible(RED, BLUE, 'solid', 4)).toBe(false);
    expect(isStrokeInvisible(null, BLUE, 'solid', 4)).toBe(true);
    expect(isStrokeInvisible(RED, null, 'horizontal', 4)).toBe(false);
    expect(isStrokeInvisible(null, null, 'horizontal', 4)).toBe(true);
    expect(isStrokeInvisible(RED, BLUE, 'horizontal', 0)).toBe(true);
    expect(isStrokeInvisible(RED, BLUE, 'radial', -1)).toBe(true);
    expect(isStrokeInvisible(RED, BLUE, 'solid', Number.NaN)).toBe(true);
  });

  it('swaps first/second stroke colors as an exact involution', () => {
    const state = { primary: '#ff0000', primaryTransparent: false, secondary: '#0000ff', secondaryTransparent: true };
    const swapped = swapStrokePaintState(state);
    expect(swapped).toEqual({ primary: '#0000ff', primaryTransparent: true, secondary: '#ff0000', secondaryTransparent: false });
    expect(swapStrokePaintState(swapped)).toEqual(state);
  });
});

describe('applyStrokePaintToElement (fill/stops protection)', () => {
  it('sets stroke only and preserves fill, stops-related, and geometry attributes', () => {
    const element = new StubElement({
      fill: 'url(#fill-g1)',
      'fill-opacity': '0.8',
      stroke: '#000000',
      'stroke-width': '4',
      'stroke-linecap': 'round',
      transform: 'translate(10 20)',
      d: 'M0 0 L10 10',
    });
    applyStrokePaintToElement(element, { stroke: 'url(#stroke-g9)', strokeWidth: 6 });
    expect(element.snapshot()).toEqual({
      fill: 'url(#fill-g1)',
      'fill-opacity': '0.8',
      stroke: 'url(#stroke-g9)',
      'stroke-width': '6',
      'stroke-linecap': 'round',
      transform: 'translate(10 20)',
      d: 'M0 0 L10 10',
    });
  });

  it('sets stroke="none" without touching stroke-width when no width is given', () => {
    const element = new StubElement({ fill: '#ff0000', stroke: '#000000', 'stroke-width': '4' });
    applyStrokePaintToElement(element, { stroke: 'none' });
    expect(element.getAttribute('stroke')).toBe('none');
    expect(element.getAttribute('stroke-width')).toBe('4');
    expect(element.getAttribute('fill')).toBe('#ff0000');
  });

  it('leaves stroke-width untouched for non-finite widths', () => {
    const element = new StubElement({ stroke: '#000', 'stroke-width': '4' });
    applyStrokePaintToElement(element, { stroke: '#ff0000', strokeWidth: Number.NaN });
    expect(element.getAttribute('stroke-width')).toBe('4');
  });
});

describe('ID collision avoidance', () => {
  it('collects ids and mints collision-free stroke ids deterministically', () => {
    const ids = collectGradientIds('<svg><defs><linearGradient id="g1"></linearGradient></defs><rect id="r1"/></svg>');
    expect(ids.has('g1')).toBe(true);
    expect(ids.has('r1')).toBe(true);
    expect(uniqueStrokeGradientId('stroke-g2', ids)).toBe('stroke-g2');
    expect(uniqueStrokeGradientId('g1', ids)).toBe('g1-stroke');
    const crowded = new Set(['g1', 'g1-stroke', 'g1-stroke-2']);
    expect(uniqueStrokeGradientId('g1', crowded)).toBe('g1-stroke-3');
    expect(uniqueStrokeGradientId('   ', ids)).toBe('stroke-paint');
  });

  it('parses url(#id) references with quotes and whitespace', () => {
    expect(extractStrokeGradientId('url(#g1)')).toBe('g1');
    expect(extractStrokeGradientId('url( #g1 )')).toBe('g1');
    expect(extractStrokeGradientId("url('#g1')")).toBe('g1');
    expect(extractStrokeGradientId('url("#g1")')).toBe('g1');
    expect(extractStrokeGradientId('#ff0000')).toBe(undefined);
    expect(extractStrokeGradientId('none')).toBe(undefined);
    expect(extractStrokeGradientId(null)).toBe(undefined);
  });

  it('rekeys exact ids only (g1 never touches g10)', () => {
    const defs = '<defs><linearGradient id="g1"><stop offset="0"/></linearGradient></defs>';
    expect(rekeyStrokeGradientDefs(defs, 'g1', 'g1-stroke')).toContain('id="g1-stroke"');
    const prefixed = '<defs><linearGradient id="g10"></linearGradient></defs>';
    expect(rekeyStrokeGradientDefs(prefixed, 'g1', 'g1-stroke')).toBe(prefixed);
    expect(rekeyStrokePaintReference('url(#g1)', 'g1', 'g1-stroke')).toBe('url(#g1-stroke)');
    expect(rekeyStrokePaintReference('url(#g10)', 'g1', 'g1-stroke')).toBe('url(#g10)');
    expect(rekeyStrokePaintReference('#ff0000', 'g1', 'g1-stroke')).toBe('#ff0000');
  });

  it('keeps two SVGs with the same id independent on replace', () => {
    // svgB already defines g1 (fill). Merging stroke markup that wants g1
    // must pick a fresh id so B's fill gradient keeps its own stops.
    const svgB =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="g1"><stop offset="0" stop-color="#00ff00" stop-opacity="1"/></linearGradient></defs>' +
      '<rect fill="url(#g1)" stroke="#000000"/></svg>';
    const existing = collectGradientIds(svgB);
    const paint = resolveStrokePaintForReplace({
      preferredId: 'g1',
      existingIds: existing,
      gradient: 'horizontal',
      primary: RED,
      secondary: BLUE,
      strokeWidth: 3,
      width: 480,
      height: 360,
    });
    expect(paint.id).toBe('g1-stroke');
    expect(paint.stroke).toBe('url(#g1-stroke)');
    const merged = insertStrokeDefsIntoSvg(svgB, paint.defs);
    // Both gradients coexist; the fill reference still resolves to green.
    expect(merged).toContain('stop-color="#00ff00"');
    expect(merged).toContain('id="g1-stroke"');
    expect(merged).toContain('fill="url(#g1)"');
    expect(isGradientIdReferenced(merged, 'g1')).toBe(true);
    // The new defs block alone is not a reference; once the element adopts
    // the new stroke value it becomes referenced.
    expect(isGradientIdReferenced(merged, 'g1-stroke')).toBe(false);
    const applied = merged.replace('stroke="#000000"', `stroke="${paint.stroke}"`);
    expect(isGradientIdReferenced(applied, 'g1-stroke')).toBe(true);
    expect(isGradientIdReferenced(applied, 'g1')).toBe(true);
  });
});

describe('defs document helpers (existing stops protection)', () => {
  const doc =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="fill-g1"><stop offset="0" stop-color="#00ff00" stop-opacity="1"/><stop offset="1" stop-color="#0000ff" stop-opacity="1"/></linearGradient>' +
    '<linearGradient id="stroke-old"><stop offset="0" stop-color="#ff0000" stop-opacity="1"/><stop offset="1" stop-color="#0000ff" stop-opacity="1"/></linearGradient></defs>' +
    '<rect fill="url(#fill-g1)" stroke="url(#stroke-old)"/></svg>';

  it('inserts defs after the svg open tag and no-ops on empty/non-svg input', () => {
    const paint = svgStrokePaint({ id: 'stroke-new', gradient: 'horizontal', primary: RED, secondary: BLUE, strokeWidth: 2, width: 100, height: 100 });
    const merged = insertStrokeDefsIntoSvg(doc, paint.defs);
    expect(merged.indexOf('<svg')).toBe(0);
    expect(merged.indexOf(paint.defs)).toBeGreaterThan(merged.indexOf('<svg'));
    expect(merged).toContain('fill="url(#fill-g1)"');
    expect(insertStrokeDefsIntoSvg(doc, '')).toBe(doc);
    expect(insertStrokeDefsIntoSvg('not svg', paint.defs)).toBe('not svg');
  });

  it('removes only the targeted gradient and collapses emptied defs', () => {
    const removed = removeGradientDefsById(doc, 'stroke-old');
    expect(removed).not.toContain('id="stroke-old"');
    // Fill gradient (and its green stop) survives byte-identical.
    expect(removed).toContain('id="fill-g1"');
    expect(removed).toContain('stop-color="#00ff00"');
    // Prefix-sharing ids are not collateral: g1 vs g10.
    const prefixed =
      '<svg><defs><linearGradient id="g1"><stop offset="0"/></linearGradient>' +
      '<linearGradient id="g10"><stop offset="0"/></linearGradient></defs></svg>';
    const pruned = removeGradientDefsById(prefixed, 'g1');
    expect(pruned).not.toContain('id="g1"');
    expect(pruned).toContain('id="g10"');

    const solo = '<svg><defs><linearGradient id="only"><stop offset="0"/></linearGradient></defs><rect/></svg>';
    expect(removeGradientDefsById(solo, 'only')).toBe('<svg><rect/></svg>');
    expect(removeGradientDefsById(doc, '')).toBe(doc);
    expect(removeGradientDefsById(doc, 'missing')).toBe(doc);
  });

  it('prunes the old stroke gradient only when nothing references it', () => {
    // Still referenced by the rect -> keep the stops.
    expect(pruneUnreferencedStrokeGradient(doc, 'stroke-old')).toBe(doc);
    const unreferenced = doc.replace('stroke="url(#stroke-old)"', 'stroke="url(#stroke-new)"');
    const pruned = pruneUnreferencedStrokeGradient(unreferenced, 'stroke-old');
    expect(pruned).not.toContain('id="stroke-old"');
    expect(pruned).toContain('id="fill-g1"');
    expect(pruneUnreferencedStrokeGradient(doc, '')).toBe(doc);
  });
});
