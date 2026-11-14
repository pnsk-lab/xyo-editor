// Z-order cover repro for `geometryFallbackHoleProbe` (audit case).
//
// Background: evenodd donut 0,0,200x200 with hole 60,60,30x30.
// Foreground (top): nonzero overlapping rects 0,0,100x100 + 50,50,100x100.
// Click (75,75) sits in the foreground overlap (Canvas nonzero => opaque
// filled) and inside the background hole. The fallback must NOT return the
// background hole: the opaque foreground covers it (`none`). Transparent /
// fill=none / hidden foreground stays transmissive (background hole), evenodd
// unfilled overlap stays `ambiguous`, edge/clip/mask/class stay fail-closed.

import { describe, expect, it } from 'bun:test';
import { geometryFallbackHoleProbe } from '../src/features/costumes/paper-vector';

type StubNode = {
  tagName: string;
  nodeName: string;
  parentElement: StubNode | null;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): StubNode | null;
};

function makeNode(tag: string, attrs: Record<string, string> = {}, parent: StubNode | null = null): StubNode {
  const node: StubNode = {
    tagName: tag,
    nodeName: tag.toUpperCase(),
    parentElement: parent,
    attrs,
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
  return node;
}

function svgRoot(): StubNode {
  return makeNode('svg', { xmlns: 'http://www.w3.org/2000/svg' }, null);
}

function pathUnit(d: string, extra: Record<string, string> = {}, parent: StubNode | null = null): Element {
  const svg = parent ?? svgRoot();
  const node = makeNode('path', { d, ...extra }, svg);
  return node as unknown as Element;
}

const BACKGROUND = 'M0 0H200V200H0Z M60 60H90V90H60Z';
const FOREGROUND_OVERLAP = 'M0 0H100V100H0Z M50 50H150V150H50Z';
const PT = { x: 75, y: 75 };

describe('fallback z-order cover (audit repro)', () => {
  it('opaque filled foreground overlap covers the background hole (none, never background hole)', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff' }),
    ];
    const probe = geometryFallbackHoleProbe(units, PT, 0.5);
    // Foreground at (75,75) is Canvas-nonzero opaque filled, so the lower hole is hidden.
    expect(probe.kind).toBe('none');
  });

  it('transparent foreground stays transmissive (background hole survives)', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: 'none' }),
    ];
    expect(geometryFallbackHoleProbe(units, PT, 0.5).kind).toBe('hole');
  });

  it('fill=none style foreground stays transmissive', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', style: 'fill:none' }),
    ];
    expect(geometryFallbackHoleProbe(units, PT, 0.5).kind).toBe('hole');
  });

  it('hidden foreground stays transmissive', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', display: 'none' }),
    ];
    expect(geometryFallbackHoleProbe(units, PT, 0.5).kind).toBe('hole');
  });

  it('evenodd unfilled overlap foreground stays ambiguous (fail-closed)', () => {
    const units = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', 'fill-rule': 'evenodd' }),
    ];
    // At (75,75) the evenodd foreground overlap is unfilled (parity 2 => empty),
    // so neither a cover nor a lower hole is safe.
    expect(geometryFallbackHoleProbe(units, PT, 0.5).kind).toBe('ambiguous');
  });

  it('semitransparent / gradient / invalid foreground never becomes a hole and never darkens to none', () => {
    const semi = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: '#0000ff', opacity: '0.5' }),
    ];
    expect(['ambiguous', 'unsupported']).toContain(geometryFallbackHoleProbe(semi, PT, 0.5).kind);
    const gradient = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: 'url(#g)', 'fill-rule': 'evenodd' }),
    ];
    expect(geometryFallbackHoleProbe(gradient, PT, 0.5).kind).toBe('unsupported');
    const invalid = [
      pathUnit(BACKGROUND, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(FOREGROUND_OVERLAP, { fill: 'bogus!!!' }),
    ];
    // Invalid paint must not darken to `none` (body recolor) and must not leak the lower hole.
    expect(['ambiguous', 'unsupported']).toContain(geometryFallbackHoleProbe(invalid, PT, 0.5).kind);
  });
});
