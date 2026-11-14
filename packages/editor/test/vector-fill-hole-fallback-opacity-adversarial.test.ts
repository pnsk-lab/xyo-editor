// Independent adversarial audit for svg-hole-fallback-opacity.
// Covers: paper-vector.ts / vector-hole-probe-shared.ts / vector-fill-hole-cover.ts
// (alpha0 handling, unknown-paint near failclose, clip/mask, fill-rule validation).
//
// SOURCE IS NOT MODIFIED: this file only drives exported probes with stub
// Elements (no Paper.js, no DOMParser, no Canvas). Fail-closed-first oracles:
// provable transparency stays transmissive (lower `hole` survives), provable
// opaque cover stays `none`, anything unprovable near the point must be
// `ambiguous`/`unsupported` (never a lower-hole leak, never a false `none`).
// Far-outside unknowns stay transmissive so distant units never poison clicks.
//
// Fixtures: BACKGROUND = evenodd donut 0,0,200x200 hole 60,60,30x30;
// FOREGROUND_OVERLAP = nonzero rects 0,0,100x100 + 50,50,100x100;
// PT=(75,75) sits in the foreground overlap AND the background hole, so
// `hole` = transmissive (lower shines through), `none` = opaque cover.

import { describe, expect, it } from 'bun:test';
import { geometryFallbackHoleProbe, isHolePathDataSafe } from '../src/features/costumes/paper-vector';
import {
  classifyHoleEffectiveFill,
  hasHoleBlockingClipOrMask,
  resolveEffectiveHoleFillRule,
  resolveEffectiveHoleOpacityFactor,
  resolveHoleVisibility,
  resolveInheritedHoleProperty,
} from '../src/features/costumes/vector-hole-probe-shared';
import { classifyStraightForegroundCover } from '../src/features/costumes/vector-fill-hole-cover';
import { editableVectorUnits } from '../src/features/costumes/vector-svg';

type StubNode = {
  tagName: string;
  nodeName: string;
  parentElement: StubNode | null;
  children: StubNode[];
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): StubNode | null;
};

function makeNode(
  tag: string,
  attrs: Record<string, string> = {},
  parent: StubNode | null = null,
): StubNode {
  const node: StubNode = {
    tagName: tag,
    nodeName: tag.toUpperCase(),
    parentElement: parent,
    children: [],
    attrs: { ...attrs },
    getAttribute(name: string) {
      return name in this.attrs ? this.attrs[name]! : null;
    },
    hasAttribute(name: string) {
      return name in this.attrs;
    },
    closest(selector: string) {
      const want = selector.trim().toLowerCase();
      let current: StubNode | null = this as StubNode;
      while (current) {
        if (current.tagName.toLowerCase() === want) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  if (parent) parent.children.push(node);
  // Minimal DOM list surface used by editableVectorUnits (Array.from over
  // `.children` works on real arrays; expose parentNode/childNodes aliases).
  (node as unknown as Record<string, unknown>).parentNode = parent;
  (node as unknown as Record<string, unknown>).childNodes = node.children;
  return node;
}

function svgRoot(attrs: Record<string, string> = {}): StubNode {
  return makeNode('svg', { xmlns: 'http://www.w3.org/2000/svg', ...attrs }, null);
}

function pathUnit(
  d: string,
  extra: Record<string, string> = {},
  parent: StubNode | null = null,
): Element {
  const svg = parent ?? svgRoot();
  const node = makeNode('path', { d, ...extra }, svg);
  return node as unknown as Element;
}

/** Wrap a path in nested <g> ancestors (outermost first). */
function nestedPath(
  d: string,
  pathAttrs: Record<string, string>,
  groupAttrsOuterFirst: Array<Record<string, string>>,
): { svg: StubNode; path: Element } {
  const svg = svgRoot();
  let parent: StubNode = svg;
  for (const attrs of groupAttrsOuterFirst) {
    parent = makeNode('g', attrs, parent);
  }
  const node = makeNode('path', { d, ...pathAttrs }, parent);
  return { svg, path: node as unknown as Element };
}

const BACKGROUND = 'M0 0H200V200H0Z M60 60H90V90H60Z';
const FOREGROUND_OVERLAP = 'M0 0H100V100H0Z M50 50H150V150H50Z';
const PT = { x: 75, y: 75 };
const FAR_PT = { x: 195, y: 195 };

function probeKind(units: Element[], pt = PT): string {
  return geometryFallbackHoleProbe(units, pt, 0.5).kind;
}

function coverKind(element: Element, fillRule = '', data = FOREGROUND_OVERLAP): string {
  return (
    classifyStraightForegroundCover({
      element,
      index: 1,
      point: PT,
      world: undefined,
      safeTolerance: 0.5,
      fillRule,
      data,
    }).kind
  );
}

describe('adversarial: CSS named / transparent keyword', () => {
  it('fill=transparent and fill=none stay transmissive (lower hole survives)', () => {
    for (const fill of ['transparent', 'TRANSPARENT', 'none', 'NONE']) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill }),
      ];
      expect(probeKind(units)).toBe('hole');
      expect(classifyHoleEffectiveFill(units[1]!).kind).toBe('none');
    }
  });
  it('opaque CSS named colors cover (never leak the lower hole)', () => {
    for (const fill of ['red', 'ReD', 'rebeccapurple', 'lightgoldenrodyellow']) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill }),
      ];
      expect(probeKind(units)).toBe('none');
    }
  });
  it('unknown alphabetic paint never darkens to a cover (fail-closed near, transmissive far)', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: 'notacolor' }),
    ];
    expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
    const farUnits = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit('M400 300H440V340H400Z', { fill: 'notacolor' }),
    ];
    expect(probeKind(farUnits)).toBe('hole');
  });
});

describe('adversarial: hex alpha (#RGB/#RGBA/#RRGGBB/#RRGGBBAA)', () => {
  it('#RGB and #RRGGBB opaque cover', () => {
    for (const fill of ['#00f', '#0000FF', '#AbC']) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill }),
      ];
      expect(probeKind(units)).toBe('none');
    }
  });
  it('#RRGGBBAA alpha=00 is transparent (hole survives)', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff00' }),
    ];
    expect(probeKind(units)).toBe('hole');
    expect(classifyHoleEffectiveFill(units[1]!).kind).toBe('none');
  });
  it('#RRGGBBAA semitransparent fail-closes (never cover, never leak)', () => {
    for (const fill of ['#0000ff80', '#0000FF7F', '#ff000080']) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill }),
      ];
      expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
      expect(coverKind(units[1]!)).not.toBe('cover');
      expect(coverKind(units[1]!)).not.toBe('transparent');
    }
  });
  it('#RGBA 4-digit is legitimate unsupported near (conservative, not a leak/cover) and transmissive far', () => {
    // NOTE (nonbug, documented): 4-digit #RGBA is NOT parsed by the current
    // alpha gate, so near points fail closed instead of resolving alpha.
    // That is safe (no hole leak, no false cover) but conservative.
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#00f8' }),
    ];
    expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
    const farUnits = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit('M400 300H440V340H400Z', { fill: '#00f8' }),
    ];
    expect(probeKind(farUnits)).toBe('hole');
  });
  it('malformed hex never becomes a cover', () => {
    for (const fill of ['#12', '#12345', '#gggggg', '#0000fg', '#']) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill }),
      ];
      expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
    }
  });
});

describe('adversarial: rgba/hsla commas vs modern slash/percentage', () => {
  it('comma rgba alpha 0 transparent / 1 opaque / 0.5 fail-closed', () => {
    expect(
      probeKind([
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill: 'rgba(0,0,255,0)' }),
      ]),
    ).toBe('hole');
    expect(
      probeKind([
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill: 'rgba(0,0,255,1)' }),
      ]),
    ).toBe('none');
    expect(
      ['ambiguous', 'unsupported'],
    ).toContain(
      probeKind([
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill: 'rgba(0,0,255,0.5)' }),
      ]),
    );
  });
  it('comma hsla alpha 0 transparent / 0.5 fail-closed', () => {
    expect(
      probeKind([
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill: 'hsla(240,100%,50%,0)' }),
      ]),
    ).toBe('hole');
    expect(
      ['ambiguous', 'unsupported'],
    ).toContain(
      probeKind([
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill: 'hsla(240,100%,50%,0.5)' }),
      ]),
    );
  });
  it('modern space/slash and percentage-alpha paints are legitimate unsupported near (no leak, no cover)', () => {
    // NOTE (nonbug, documented): the alpha gate only parses comma syntax, so
    // modern CSS (`rgb(0 0 255 / 0.5)`, `rgba(0,0,255,50%)`, `hsl(... / ...)`
    // with slashes) fail closed near instead of resolving. Safe by direction.
    const modern = [
      'rgb(0 0 255 / 0.5)',
      'rgb(0 0 255 / 0)',
      'rgba(0 0 255 / 0.5)',
      'rgba(0,0,255,50%)',
      'hsla(240 100% 50% / 0.5)',
      'hsl(240 100% 50% / 50%)',
      'rgb(255 0 0)',
    ];
    for (const fill of modern) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill }),
      ];
      expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
      // Never a false cover and never a lower-hole leak.
      expect(probeKind(units)).not.toBe('none');
      const farUnits = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit('M400 300H440V340H400Z', { fill }),
      ];
      expect(probeKind(farUnits, FAR_PT)).toBe('none');
    }
  });
  it('rgba() with 3 args is a valid rgb() alias (opaque cover, not invalid)', () => {
    // CSS Color 4: rgba() is an alias of rgb(); the 4th comma arg is optional.
    // So rgba(0,0,255) paints opaque and must cover like rgb(0,0,255).
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: 'rgba(0,0,255)' }),
    ];
    expect(probeKind(units)).toBe('none');
  });
  it('invalid rgba/css never darkens and never leaks', () => {
    for (const fill of [
      'rgba(0,0,255,2)',
      'rgba(banana)',
      'rgb()',
      'hsla(,,,) ',
      'red!!!',
      'url (#g)',
    ]) {
      if (fill.includes('url(')) continue; // url() has its own fail-closed path below
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill }),
      ];
      const kind = probeKind(units);
      // rgba alpha 2 normalizes to semitransparent (ambiguous); the rest are
      // unparsable -> unsupported. Neither may be `none` (cover) nor `hole`.
      expect(['ambiguous', 'unsupported']).toContain(kind);
    }
  });
});

describe('adversarial: currentColor/inherit/context-fill and color inheritance', () => {
  it('currentColor / context-fill / context-stroke fail closed near (need color resolution)', () => {
    for (const fill of ['currentColor', 'CURRENTCOLOR', 'context-fill', 'context-stroke']) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill }),
      ];
      expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
      expect(probeKind(units)).not.toBe('none');
      expect(probeKind(units)).not.toBe('hole');
    }
  });
  it('fill=currentColor stays unknown even when a color ancestor exists (legitimate unsupported)', () => {
    // NOTE (nonbug): the probe does not resolve the CSS `color` property, so
    // `currentColor` can never prove opacity. Fail-closed is the safe answer.
    const { path } = nestedPath(
      FOREGROUND_OVERLAP,
      { fill: 'currentColor' },
      [{ color: 'red' }],
    );
    const svg = path.parentElement?.parentElement as unknown as Element;
    void svg;
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      path as unknown as Element,
    ];
    expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
  });
  it('fill=inherit follows the ancestor chain', () => {
    const { path } = nestedPath(FOREGROUND_OVERLAP, { fill: 'inherit' }, [{ fill: '#0000ff' }]);
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg, path as unknown as Element])).toBe('none');
    const { path: nonePath } = nestedPath(FOREGROUND_OVERLAP, { fill: 'inherit' }, [{ fill: 'none' }]);
    const bg2 = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg2, nonePath as unknown as Element])).toBe('hole');
  });
  it('presentation attribute inherit through two group levels resolves', () => {
    const { path } = nestedPath(FOREGROUND_OVERLAP, {}, [{ fill: 'inherit' }, { fill: 'inherit' }]);
    // Chain: path(missing) -> g(fill=inherit) -> g(fill=inherit) -> svg(missing)
    // resolves to missing, which is opaque-black default -> cover.
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg, path as unknown as Element])).toBe('none');
  });
});

describe('adversarial: opacity across ancestors + inline-style precedence', () => {
  it('opacity multiplies across ancestors (0.5 * 0.5 fail-closes)', () => {
    const { path } = nestedPath(FOREGROUND_OVERLAP, { fill: '#0000ff', opacity: '0.5' }, [{ opacity: '0.5' }]);
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    const factor = resolveEffectiveHoleOpacityFactor(path as unknown as Element);
    expect(factor.status).toBe('value');
    if (factor.status === 'value') expect(factor.factor).toBeCloseTo(0.25, 9);
    expect(['ambiguous', 'unsupported']).toContain(probeKind([bg, path as unknown as Element]));
  });
  it('inline style beats the presentation attribute on the same node', () => {
    const styleWins = pathUnit(FOREGROUND_OVERLAP, {
      fill: '#0000ff',
      opacity: '1',
      style: 'opacity: 0',
    });
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg, styleWins])).toBe('hole');
    const attrWins = pathUnit(FOREGROUND_OVERLAP, {
      fill: '#0000ff',
      opacity: '0',
      style: 'opacity: 1',
    });
    const bg2 = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg2, attrWins])).toBe('none');
  });
  it('style opacity with !important and case-insensitive property wins', () => {
    const styled = pathUnit(FOREGROUND_OVERLAP, {
      fill: '#0000ff',
      style: 'OPACITY: 0 !important',
    });
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg, styled])).toBe('hole');
  });
  it('opacity:0 anywhere in the chain hides via visibility gate', () => {
    const { path } = nestedPath(FOREGROUND_OVERLAP, { fill: '#0000ff' }, [{ opacity: '0' }]);
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg, path as unknown as Element])).toBe('hole');
  });
  it('unparsable opacity fail-closes near and stays transmissive far', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', opacity: 'banana' }),
    ];
    expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
    const farUnits = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit('M400 300H440V340H400Z', { fill: '#0000ff', opacity: 'banana' }),
    ];
    expect(probeKind(farUnits, FAR_PT)).toBe('none');
  });
  it('fill-opacity percentage and style forms behave (0 transmissive, 50% fail-closed)', () => {
    const zero = pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', 'fill-opacity': '0%' });
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg, zero])).toBe('hole');
    const half = pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', 'fill-opacity': '50%' });
    const bg2 = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(['ambiguous', 'unsupported']).toContain(probeKind([bg2, half]));
    const styleHalf = pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', style: 'fill-opacity: 0.5' });
    const bg3 = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(['ambiguous', 'unsupported']).toContain(probeKind([bg3, styleHalf]));
  });
});

describe('adversarial: visibility re-enable vs display:none', () => {
  it('visibility:hidden ancestor re-shown by child visibility:visible is visible', () => {
    const { path } = nestedPath(
      FOREGROUND_OVERLAP,
      { fill: '#0000ff', visibility: 'visible' },
      [{ visibility: 'hidden' }],
    );
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(resolveHoleVisibility(path as unknown as Element).hidden).toBe(false);
    expect(probeKind([bg, path as unknown as Element])).toBe('none');
  });
  it('visibility:hidden without re-show hides (transmissive)', () => {
    const { path } = nestedPath(FOREGROUND_OVERLAP, { fill: '#0000ff' }, [{ visibility: 'hidden' }]);
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(resolveHoleVisibility(path as unknown as Element).hidden).toBe(true);
    expect(probeKind([bg, path as unknown as Element])).toBe('hole');
  });
  it('display:none on any ancestor hides and cannot be re-shown by a descendant', () => {
    const { path } = nestedPath(
      FOREGROUND_OVERLAP,
      { fill: '#0000ff', style: 'display: block' },
      [{ display: 'none' }],
    );
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(resolveHoleVisibility(path as unknown as Element).hidden).toBe(true);
    expect(probeKind([bg, path as unknown as Element])).toBe('hole');
    const selfHidden = pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', display: 'none' });
    const bg2 = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg2, selfHidden])).toBe('hole');
  });
  it('class-driven display/visibility fail-closes (unknown, never guessed visible)', () => {
    const classed = pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', class: 'hidden-by-css' });
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(['ambiguous', 'unsupported']).toContain(probeKind([bg, classed]));
  });
});

describe('adversarial: gradients (incl. transparent stops), clip/mask', () => {
  it('url() fill fail-closes near (even with transparent stops) and stays transmissive far', () => {
    for (const fill of ['url(#g)', 'url( #g )', 'fill:url(#g)']) {
      const style = fill.startsWith('fill:') ? fill : undefined;
      const attrs = style ? { style } : { fill };
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, attrs),
      ];
      expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
      expect(probeKind(units)).not.toBe('none');
      expect(probeKind(units)).not.toBe('hole');
    }
    const farUnits = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit('M400 300H440V340H400Z', { fill: 'url(#g)' }),
    ];
    expect(probeKind(farUnits, FAR_PT)).toBe('none');
  });
  it('clip-path / mask on self, ancestor, or style fail-closes near', () => {
    const variants: Array<Record<string, string>> = [
      { 'clip-path': 'url(#c)' },
      { mask: 'url(#m)' },
      { style: 'clip-path:url(#c)' },
      { style: 'mask:url(#m)' },
    ];
    for (const extra of variants) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', ...extra }),
      ];
      expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
    }
    const { path } = nestedPath(
      FOREGROUND_OVERLAP,
      { fill: '#0000ff' },
      [{ 'clip-path': 'url(#c)' }],
    );
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(hasHoleBlockingClipOrMask(path as unknown as Element)).toBe(true);
    expect(['ambiguous', 'unsupported']).toContain(probeKind([bg, path as unknown as Element]));
  });
  it('class on self or ancestor blocks (stylesheet could clip/paint)', () => {
    const { path } = nestedPath(FOREGROUND_OVERLAP, { fill: '#0000ff' }, [{ class: 'clip-via-css' }]);
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(['ambiguous', 'unsupported']).toContain(probeKind([bg, path as unknown as Element]));
    const inert = nestedPath(FOREGROUND_OVERLAP, { fill: '#0000ff' }, [{ class: 'xyo-vector-explicit-group' }]);
    const bg2 = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    expect(probeKind([bg2, inert.path as unknown as Element])).toBe('none');
  });
});

describe('adversarial: fill-rule validation and topmost/sibling ordering', () => {
  it('invalid fill-rule never becomes a cover', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', 'fill-rule': 'bogus' }),
    ];
    expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
    expect(coverKind(units[1]!, 'bogus')).not.toBe('cover');
  });
  it('fill-rule inherits style-first from ancestors and root', () => {
    const { path } = nestedPath(FOREGROUND_OVERLAP, {}, [{ style: 'fill-rule: evenodd' }]);
    expect(resolveEffectiveHoleFillRule(path as unknown as Element)).toEqual({
      kind: 'value',
      value: 'evenodd',
    });
    const rootRuled = (() => {
      const svg = svgRoot({ 'fill-rule': 'evenodd' });
      const node = makeNode('path', { d: FOREGROUND_OVERLAP, fill: '#0000ff' }, svg);
      return node as unknown as Element;
    })();
    expect(resolveInheritedHoleProperty(rootRuled, 'fill-rule').status).toBe('value');
  });
  it('evenodd-unfilled foreground overlap stays ambiguous (never cover, never leak)', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', 'fill-rule': 'evenodd' }),
    ];
    expect(probeKind(units)).toBe('ambiguous');
  });
  it('two sibling holes at the same point are ambiguous (no topmost invention)', () => {
    const holeA = 'M0 0H200V200H0Z M60 60H90V90H60Z';
    const holeB = 'M0 0H200V200H0Z M60 60H90V90H60Z';
    const units = [
      pathUnit(holeA, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(holeB, { fill: '#0000ff', 'fill-rule': 'evenodd' }),
    ];
    expect(probeKind(units)).toBe('ambiguous');
  });
  it('opaque topmost nonzero overlap hides the lower hole (none, never background hole)', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff' }),
    ];
    expect(probeKind(units)).toBe('none');
  });
});

describe('adversarial: transforms incl. noninvertible', () => {
  it('translate keeps the opaque cover exact', () => {
    const { path } = nestedPath(
      'M140 110H200V170H140Z M160 130H220V190H160Z',
      { fill: '#0000ff' },
      [{ transform: 'translate(20 10)' }],
    );
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    // Shifted unit still covers the click after world-matrix inversion.
    expect(probeKind([bg, path as unknown as Element], { x: 190, y: 150 })).toBe('none');
  });
  it('singular scale(0 1) fail-closes (no unique preimage)', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', transform: 'scale(0 1)' }),
    ];
    expect(['ambiguous', 'unsupported']).toContain(probeKind(units));
  });
  it('malformed transform text never crashes and never invents a hole', () => {
    for (const transform of ['banana', 'translate(', 'matrix(1 0 0)', 'scale(NaN 1)']) {
      const units = [
        pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
        pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', transform }),
      ];
      const kind = probeKind(units);
      expect(['hole', 'none', 'ambiguous', 'unsupported']).toContain(kind);
      // Malformed transforms are skipped operation-wise, so the opaque
      // foreground still covers (none) or at worst fail-closes.
      expect(['none', 'ambiguous', 'unsupported']).toContain(kind);
    }
  });
});

describe('adversarial: DOM-helper out-of-bounds safety + bounded loops', () => {
  it('empty units, NaN points, and non-path units never throw (none)', () => {
    expect(geometryFallbackHoleProbe([], PT, 0.5).kind).toBe('none');
    expect(geometryFallbackHoleProbe([], { x: NaN, y: NaN }, 0.5).kind).toBe('none');
    const svg = svgRoot();
    const rect = makeNode('rect', { x: '60', y: '60', width: '30', height: '30', fill: '#0000ff' }, svg);
    expect(probeKind([rect as unknown as Element])).toBe('none');
  });
  it('throwing attribute accessors fail closed without crashing', () => {
    const evil = {
      tagName: 'path',
      parentElement: null,
      getAttribute(_name: string): string | null {
        throw new Error('boom');
      },
      hasAttribute(_name: string): boolean {
        throw new Error('boom');
      },
      closest(_selector: string): null {
        throw new Error('boom');
      },
    } as unknown as Element;
    let kind = 'crashed';
    try {
      kind = geometryFallbackHoleProbe([evil], PT, 0.5).kind;
    } catch {
      kind = 'crashed';
    }
    expect(kind).not.toBe('crashed');
  });
  it('missing d / empty d never throws and never invents a hole', () => {
    const nod = (() => {
      const svg = svgRoot();
      const node = makeNode('path', { fill: '#0000ff' }, svg);
      return node as unknown as Element;
    })();
    expect(probeKind([nod])).toBe('none');
    const empty = pathUnit('', { fill: '#0000ff' });
    expect(probeKind([empty])).toBe('none');
  });
  it('oversize pathData is rejected by the safe-subset gate (no hang, no invented hole)', () => {
    const huge = `M0 0${'H1'.repeat(15000)}Z M60 60H90V90H60Z`;
    expect(isHolePathDataSafe(huge)).toBe(false);
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(huge, { fill: '#0000ff' }),
    ];
    const started = Date.now();
    const kind = probeKind(units);
    expect(Date.now() - started).toBeLessThan(5000);
    // The oversize foreground is a degenerate line at y=0, far from PT, so it
    // stays transmissive and the background hole correctly shines through.
    // The gate matters: the oversize unit itself must never become a `hole`.
    expect(kind).toBe('hole');
    const coveringHuge = `M0 0H200V200H0Z${'H100'.repeat(8000)} M60 60H90V90H60Z`;
    expect(isHolePathDataSafe(coveringHuge)).toBe(false);
    const units2 = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(coveringHuge, { fill: '#0000ff' }),
    ];
    const kind2 = probeKind(units2);
    // Oversize cover data cannot prove a cover: never `none` from the huge
    // unit itself (falls through to background hole or fail-closed).
    expect(['hole', 'ambiguous', 'unsupported']).toContain(kind2);
  });
  it('deep ancestor chains stay bounded (no infinite loop, completes fast)', () => {
    const svg = svgRoot();
    let parent: StubNode = svg;
    for (let i = 0; i < 2000; i += 1) {
      parent = makeNode('g', { opacity: '1' }, parent);
    }
    const leaf = makeNode('path', { d: FOREGROUND_OVERLAP, fill: '#0000ff' }, parent);
    const bg = pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' });
    const started = Date.now();
    const kind = probeKind([bg, leaf as unknown as Element]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(kind).toBe('none');
  });
  it('editableVectorUnits out-of-range index access is safe (no crash on empty svg)', () => {
    const svg = svgRoot();
    const units = editableVectorUnits(svg as unknown as Element);
    expect(units.length).toBe(0);
    expect((units[0] as Element | undefined) ?? null).toBe(null);
    expect((units[99] as Element | undefined) ?? null).toBe(null);
  });
});
