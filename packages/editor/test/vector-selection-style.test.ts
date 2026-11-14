import { describe, expect, it } from 'bun:test';
import {
  extractPaintGradientId,
  isEmptyVectorStylePatch,
  isMixedSelectionValue,
  mergeDetailedPaintWithPatch,
  mergeElementPaintWithPatch,
  PAINT_MIXED,
  parsePaintWithFallback,
  parseSolidPaintAttribute,
  readVectorElementPaint,
  readVectorElementPaintDetailed,
  summarizeDetailedVectorElementPaints,
  summarizeVectorElementPaints,
  type SelectionGradientDef,
  type SelectionStyleElement,
  type VectorElementPaint,
} from '../src/features/costumes/vector-selection-style';

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

function stubElement(attrs: Record<string, string | null>): SelectionStyleElement {
  return {
    getAttribute: (name: string) => (name in attrs ? (attrs[name] as string | null) : null),
  };
}

function gradientDef(kind: 'linear' | 'radial', stops: SelectionGradientDef['stops']): SelectionGradientDef {
  return {
    tag: kind === 'radial' ? 'radialGradient' : 'linearGradient',
    x1: kind === 'linear' ? '0' : null,
    y1: kind === 'linear' ? '0' : null,
    x2: kind === 'linear' ? '480' : null,
    y2: kind === 'linear' ? '0' : null,
    stops,
  };
}

describe('parseSolidPaintAttribute', () => {
  it('maps none/transparent to transparent and url() to gradient', () => {
    expect(parseSolidPaintAttribute('none')).toEqual({ kind: 'color', color: null });
    expect(parseSolidPaintAttribute('transparent')).toEqual({ kind: 'color', color: null });
    expect(parseSolidPaintAttribute('#ff0000')).toEqual({ kind: 'color', color: RED });
    expect(parseSolidPaintAttribute('url(#g1)')).toEqual({ kind: 'gradient', id: 'g1' });
    expect(parseSolidPaintAttribute('red')).toEqual({ kind: 'unknown' });
  });
});

describe('readVectorElementPaint', () => {
  it('reads solid colors, transparent, width gate, and opacity', () => {
    const solid = readVectorElementPaint(
      stubElement({ fill: '#ff0000', stroke: '#0000ff', 'stroke-width': '4', opacity: '0.6' }),
      () => undefined,
    );
    expect(solid).toEqual({
      fill: RED,
      fillSecondary: null,
      fillGradient: 'solid',
      stroke: BLUE,
      strokeSecondary: null,
      strokeGradient: 'solid',
      // Scratch parity: stored SVG 4 selects as UI 8 (`SVG*2`).
      strokeWidth: 8,
      opacity: 60,
    });

    const gated = readVectorElementPaint(
      stubElement({ fill: '#ff0000', stroke: '#0000ff', 'stroke-width': '0', opacity: '1' }),
      () => undefined,
    );
    expect(gated).toEqual({
      fill: RED,
      fillSecondary: null,
      fillGradient: 'solid',
      stroke: null,
      strokeSecondary: null,
      strokeGradient: 'solid',
      strokeWidth: 0,
      opacity: 100,
    });
  });

  it('reads gradients and maps transparent ends to null without black swing', () => {
    const paint = readVectorElementPaint(
      stubElement({ fill: 'url(#fg)', stroke: 'url(#sg)', 'stroke-width': '3' }),
      (id) => {
        if (id === 'fg') {
          return gradientDef('linear', [
            { color: '#ff0000', opacity: '1' },
            { color: '#ff0000', opacity: '0' },
          ]);
        }
        return gradientDef('linear', [
          { color: '#0000ff', opacity: '1' },
          { color: '#00ff00', opacity: '1' },
        ]);
      },
    );
    expect(paint).toEqual({
      fill: RED,
      fillSecondary: null,
      fillGradient: 'horizontal',
      stroke: BLUE,
      strokeSecondary: { r: 0, g: 255, b: 0, a: 255 },
      strokeGradient: 'horizontal',
      // Stored SVG 3 selects as UI 6.
      strokeWidth: 6,
      opacity: 100,
    });
  });

  it('fails closed to MIXED for missing gradients and exotic colors', () => {
    expect(readVectorElementPaint(stubElement({ fill: 'url(#missing)', stroke: '#000' }), () => undefined)).toBe(
      PAINT_MIXED,
    );
    expect(readVectorElementPaint(stubElement({ fill: 'red', stroke: '#000' }), () => undefined)).toBe(PAINT_MIXED);
  });
});

describe('summarizeVectorElementPaints', () => {
  const base: VectorElementPaint = {
    fill: RED,
    fillSecondary: null,
    fillGradient: 'solid',
    stroke: BLUE,
    strokeSecondary: null,
    strokeGradient: 'solid',
    strokeWidth: 4,
    opacity: 100,
  };

  it('returns the shared paint for identical items', () => {
    expect(summarizeVectorElementPaints([base, { ...base }])).toEqual({
      fill: RED,
      fillSecondary: null,
      fillGradient: 'solid',
      stroke: BLUE,
      strokeSecondary: null,
      strokeGradient: 'solid',
      strokeWidth: 4,
      opacity: 100,
    });
  });

  it('collapses disagreements to MIXED per field', () => {
    const other: VectorElementPaint = { ...base, fill: BLUE, strokeWidth: 8, opacity: 50 };
    const summary = summarizeVectorElementPaints([base, other]);
    expect(summary.fill).toBe(PAINT_MIXED);
    expect(summary.stroke).toEqual(BLUE);
    expect(summary.strokeWidth).toBe(PAINT_MIXED);
    expect(summary.opacity).toBe(PAINT_MIXED);
    expect(isMixedSelectionValue(summary.fill)).toBe(true);
  });

  it('poisons colors when gradient kinds disagree', () => {
    const ramp: VectorElementPaint = {
      ...base,
      fillSecondary: BLUE,
      fillGradient: 'horizontal',
    };
    const summary = summarizeVectorElementPaints([base, ramp]);
    expect(summary.fillGradient).toBe(PAINT_MIXED);
    expect(summary.fill).toBe(PAINT_MIXED);
    expect(summary.fillSecondary).toBe(PAINT_MIXED);
  });

  it('returns all MIXED for empty or poisoned input', () => {
    expect(summarizeVectorElementPaints([]).fill).toBe(PAINT_MIXED);
    expect(summarizeVectorElementPaints([base, PAINT_MIXED]).strokeWidth).toBe(PAINT_MIXED);
  });
});

describe('mergeElementPaintWithPatch', () => {
  const current: VectorElementPaint = {
    fill: RED,
    fillSecondary: BLUE,
    fillGradient: 'horizontal',
    stroke: RED,
    strokeSecondary: null,
    strokeGradient: 'solid',
    strokeWidth: 4,
    opacity: 100,
  };

  it('keeps untouched fields byte-for-byte', () => {
    expect(mergeElementPaintWithPatch(current, { strokeWidth: 8 })).toEqual({ ...current, strokeWidth: 8 });
    expect(isEmptyVectorStylePatch({})).toBe(true);
    expect(isEmptyVectorStylePatch({ strokeWidth: 8 })).toBe(false);
  });

  it('preserves the element gradient kind on color-only changes', () => {
    const next = mergeElementPaintWithPatch(current, { fill: BLUE });
    expect(next.fill).toEqual(BLUE);
    expect(next.fillGradient).toBe('horizontal');
    expect(next.fillSecondary).toEqual(BLUE);
  });

  it('flattens to solid on gradient-kind change and gates width 0', () => {
    const solid = mergeElementPaintWithPatch(current, { fillGradient: 'solid' });
    expect(solid.fillGradient).toBe('solid');
    expect(solid.fillSecondary).toBe(null);
    const gated = mergeElementPaintWithPatch(current, { strokeWidth: 0 });
    expect(gated.stroke).toBe(null);
    expect(gated.strokeGradient).toBe('solid');
    expect(gated.strokeWidth).toBe(0);
  });
});

describe('anchored paint url parsing', () => {
  it('rejects partial matches and keeps fallback text', () => {
    expect(extractPaintGradientId('myurl(#g)')).toBe(undefined);
    expect(extractPaintGradientId('url(http://example.com/#g)')).toBe(undefined);
    expect(extractPaintGradientId('url(#g1)')).toBe('g1');
    expect(parsePaintWithFallback('url(#g) #00ff00')).toEqual({ kind: 'gradient', id: 'g', fallback: '#00ff00' });
    expect(parsePaintWithFallback('myurl(#g)')).toEqual({ kind: 'unknown' });
    expect(parsePaintWithFallback('url(http://example.com/#g)')).toEqual({ kind: 'unknown' });
  });

  it('uses the fallback solid when the gradient is missing', () => {
    const paint = readVectorElementPaintDetailed(
      stubElement({ fill: 'url(#missing) #00ff00', stroke: 'none' }),
      () => undefined,
    );
    expect(paint.fill).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(paint.fillGradient).toBe('solid');
    // No fallback stays fail-closed.
    const missing = readVectorElementPaintDetailed(stubElement({ fill: 'url(#missing)', stroke: 'none' }), () => undefined);
    expect(missing.fill).toBe(PAINT_MIXED);
  });

  it('reads per-object objectBoundingBox percentages (new editor output)', () => {
    const horizontal = readVectorElementPaintDetailed(stubElement({ fill: 'url(#h)', stroke: 'none' }), (id) =>
      id === 'h'
        ? { tag: 'linearGradient', x1: '0%', y1: '0%', x2: '100%', y2: '0%', stops: [{ color: '#ff0000', opacity: '1' }, { color: '#00ff00', opacity: '1' }] }
        : undefined,
    );
    expect(horizontal.fillGradient).toBe('horizontal');
    const vertical = readVectorElementPaintDetailed(stubElement({ fill: 'url(#v)', stroke: 'none' }), (id) =>
      id === 'v'
        ? { tag: 'linearGradient', x1: '0%', y1: '0%', x2: '0%', y2: '100%', stops: [{ color: '#ff0000', opacity: '1' }, { color: '#00ff00', opacity: '1' }] }
        : undefined,
    );
    expect(vertical.fillGradient).toBe('vertical');
    // Legacy userSpaceOnUse numbers and unit fractions still resolve.
    const legacy = readVectorElementPaintDetailed(stubElement({ fill: 'url(#l)', stroke: 'none' }), (id) =>
      id === 'l'
        ? { tag: 'linearGradient', x1: '0', y1: '0', x2: '480', y2: '0', stops: [{ color: '#ff0000', opacity: '1' }, { color: '#00ff00', opacity: '1' }] }
        : undefined,
    );
    expect(legacy.fillGradient).toBe('horizontal');
  });
});

describe('effective paint resolution (style, inheritance, opacity)', () => {
  function chainElement(attrs: Record<string, string | null>, parent?: SelectionStyleElement): SelectionStyleElement {
    return {
      getAttribute: (name: string) => (name in attrs ? (attrs[name] as string | null) : null),
      parentElement: parent ?? null,
    };
  }

  it('prefers inline style over presentation attributes', () => {
    const paint = readVectorElementPaintDetailed(
      stubElement({ fill: '#ff0000', style: 'fill: #0000ff; stroke-width: 7' }),
      () => undefined,
    );
    expect(paint.fill).toEqual(BLUE);
    // Inline `stroke-width: 7` (SVG) selects as UI 14.
    expect(paint.strokeWidth).toBe(14);
  });

  it('inherits missing paint from ancestors instead of defaulting', () => {
    const parent = chainElement({ fill: '#00ff00', stroke: '#ff0000', 'stroke-width': '2' });
    const child = chainElement({}, parent);
    const paint = readVectorElementPaintDetailed(child, () => undefined);
    expect(paint.fill).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(paint.stroke).toEqual(RED);
    // Inherited SVG 2 selects as UI 4.
    expect(paint.strokeWidth).toBe(4);
    // No ancestor at all still uses SVG defaults (black fill, no stroke).
    const orphan = readVectorElementPaintDetailed(stubElement({}), () => undefined);
    expect(orphan.fill).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(orphan.stroke).toBe(null);
  });

  it('folds fill-opacity/stroke-opacity and chained opacity into the paint', () => {
    const parent = chainElement({ opacity: '0.5' });
    const child = chainElement({ fill: '#ff0000', 'fill-opacity': '0.5', opacity: '0.5', stroke: 'none' }, parent);
    const paint = readVectorElementPaintDetailed(child, () => undefined);
    expect(paint.fill).toEqual({ r: 255, g: 0, b: 0, a: 128 });
    // 0.5 (self) * 0.5 (parent) = 0.25 -> 25.
    expect(paint.opacity).toBe(25);
    const strokeChild = chainElement({ fill: '#ff0000', stroke: '#0000ff', 'stroke-opacity': '0' }, undefined);
    const strokePaint = readVectorElementPaintDetailed(strokeChild, () => undefined);
    expect(strokePaint.stroke).toBe(null);
  });

  it('fails closed on class-controlled and unparsable values', () => {
    expect(readVectorElementPaintDetailed(stubElement({ fill: '#ff0000', class: 'painted' }), () => undefined).fill).toBe(
      PAINT_MIXED,
    );
    const parent = chainElement({ class: 'themed' });
    expect(readVectorElementPaintDetailed(chainElement({}, parent), () => undefined).fill).toBe(PAINT_MIXED);
    expect(readVectorElementPaintDetailed(stubElement({ fill: '#ff0000', 'stroke-width': 'abc' }), () => undefined).strokeWidth).toBe(
      PAINT_MIXED,
    );
    expect(readVectorElementPaintDetailed(stubElement({ fill: '#ff0000', opacity: 'banana' }), () => undefined).opacity).toBe(
      PAINT_MIXED,
    );
    // A second url() as "fallback" is not a usable solid color: the side
    // stays MIXED (fail-closed) instead of adopting the first id's paint.
    expect(extractPaintGradientId('url(#a) url(#b)')).toBe('a');
    expect(
      readVectorElementPaintDetailed(stubElement({ fill: 'url(#a) url(#b)', stroke: 'none' }), () => undefined).fill,
    ).toBe(PAINT_MIXED);
  });
});

describe('detailed selective merge', () => {
  const RED_SOLID = {
    fill: RED,
    fillSecondary: null as null,
    fillGradient: 'solid' as const,
    stroke: BLUE,
    strokeSecondary: null as null,
    strokeGradient: 'solid' as const,
    strokeWidth: 4,
    opacity: 100,
  };

  it('keeps known sides editable while unknown sides are skipped', () => {
    // `red` is a named color the parser cannot resolve: fill side is MIXED.
    const paint = readVectorElementPaintDetailed(stubElement({ fill: 'red', stroke: '#0000ff', 'stroke-width': '4' }), () => undefined);
    expect(paint.fill).toBe(PAINT_MIXED);
    expect(paint.stroke).toEqual(BLUE);
    const strokeOnly = mergeDetailedPaintWithPatch(paint, { strokeWidth: 9 });
    expect(strokeOnly.strokeWidth).toBe(9);
    expect(strokeOnly.fill).toBe(null);
    expect(strokeOnly.skipped.fill).toBe(false);
    const fillEdit = mergeDetailedPaintWithPatch(paint, { fill: BLUE });
    expect(fillEdit.fill).toBe(null);
    expect(fillEdit.skipped.fill).toBe(true);
    const strokeEdit = mergeDetailedPaintWithPatch(paint, { stroke: RED });
    expect(strokeEdit.stroke?.primary).toEqual(RED);
    expect(strokeEdit.skipped.stroke).toBe(false);
  });

  it('preserves the element gradient kind on same-side color changes', () => {
    const paint = readVectorElementPaintDetailed(
      stubElement({ fill: '#ff0000', style: 'fill: #ff0000', stroke: 'none' }),
      () => undefined,
    );
    const next = mergeDetailedPaintWithPatch(paint, { fillGradient: 'horizontal' }, { fill: BLUE });
    expect(next.fill?.gradient).toBe('horizontal');
    expect(next.fill?.primary).toEqual(RED);
    expect(next.fill?.secondary).toEqual(BLUE);
    expect(next.skipped.fill).toBe(false);
  });

  it('summarizes per field so unknown fills do not poison known strokes', () => {
    const known = readVectorElementPaintDetailed(stubElement({ fill: '#ff0000', stroke: '#0000ff' }), () => undefined);
    const unknownFill = readVectorElementPaintDetailed(stubElement({ fill: 'red', stroke: '#0000ff' }), () => undefined);
    const summary = summarizeDetailedVectorElementPaints([known, unknownFill]);
    expect(summary.fill).toBe(PAINT_MIXED);
    expect(summary.stroke).toEqual(BLUE);
  });
});
