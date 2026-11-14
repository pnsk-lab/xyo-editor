// Conservative geometry-fallback coverage for the fill-tool hole probe.
//
// The Paper entity probe declines relative-`m` hole starts; the pure helper
// resolves them. This fallback runs only when Paper reports `none`, so these
// tests drive the exported `geometryFallbackHoleProbe` directly with stub
// Elements (no Paper.js, no DOMParser): multi-hole / relative-m / outer-hole
// with a single island resolve to the clicked hole only (reference-solid
// single-contour `d` that covers the island, reversible via Undo), while
// curves / overlaps / clip-mask / defs-url paint stay fail-closed and
// far-outside points stay `none` (no global `ambiguous` pollution, no parent
// recolor).

import { describe, expect, it } from 'bun:test';
import { geometryFallbackHoleProbe } from '../src/features/costumes/paper-vector';
import { isHolePathDataSafe } from '../src/features/costumes/paper-vector';

type StubNode = {
  tagName: string;
  nodeName: string;
  parentElement: StubNode | null;
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

const TWO_HOLES = 'M0 0H200V100H0Z M20 20H60V60H20Z M120 20H160V60H120Z';
const RELATIVE_M = 'M0 0H200V100H0Z m20 20H60V60H20Z';
const ISLAND_RING = 'M0 0H200V200H0Z M40 40H160V160H40Z M80 80H120V120H80Z';
const OVERLAP = 'M0 0H100V100H0Z M50 50H150V150H50Z';
const DONUT = 'M150 90H330V270H150Z M210 150H270V210H210Z';

describe('geometry fallback hole probe (Paper-none only)', () => {
  it('resolves each hole of a 2-hole path independently, body/outside stay none', () => {
    const units = [pathUnit(TWO_HOLES, { fill: '#ff0000', 'fill-rule': 'evenodd' })];
    const first = geometryFallbackHoleProbe(units, { x: 40, y: 40 }, 0.5);
    const second = geometryFallbackHoleProbe(units, { x: 140, y: 40 }, 0.5);
    expect(first.kind).toBe('hole');
    expect(second.kind).toBe('hole');
    if (first.kind === 'hole' && second.kind === 'hole') {
      expect(first.target.parentIndex).toBe(0);
      expect(second.target.parentIndex).toBe(0);
      // Clicked hole only: different outlines, both safe subsets.
      expect(first.target.holePathData).not.toBe(second.target.holePathData);
      expect(isHolePathDataSafe(first.target.holePathData)).toBe(true);
      expect(isHolePathDataSafe(second.target.holePathData)).toBe(true);
      expect(first.target.holeDocumentBounds.width).toBeGreaterThan(0);
      expect(second.target.holeDocumentBounds.width).toBeGreaterThan(0);
      expect(first.target.parentTransform).toBe('');
    }
    // Between the holes is painted body: no hole claim.
    expect(geometryFallbackHoleProbe(units, { x: 90, y: 40 }, 0.5).kind).toBe('none');
    // Far outside stays none (never a hole, never ambiguous).
    expect(geometryFallbackHoleProbe(units, { x: 190, y: 90 }, 0.5).kind).toBe('none');
  });

  it('resolves a relative-m hole start to the same absolute outline', () => {
    const units = [pathUnit(RELATIVE_M, { fill: '#ff0000', 'fill-rule': 'evenodd' })];
    const hole = geometryFallbackHoleProbe(units, { x: 40, y: 40 }, 0.5);
    expect(hole.kind).toBe('hole');
    if (hole.kind === 'hole') {
      expect(isHolePathDataSafe(hole.target.holePathData)).toBe(true);
      // Absolute twin of the relative hole.
      expect(hole.target.holePathData).toContain('M20 20');
    }
  });

  it('fills outer-hole rings with a reference-solid overlay that covers the island', () => {
    const units = [pathUnit(ISLAND_RING, { fill: '#ff0000', 'fill-rule': 'evenodd' })];
    // Ring between outer and middle: reference clones the hole as a solid
    // sibling above the parent, so the island underneath is covered
    // (reversible: source untouched, Undo removes the sibling). Independent
    // oracles prove this: Canvas2D solid paints island alpha 255, Paper hole
    // child contains the island point with laminar 0-intersection nesting.
    const hole = geometryFallbackHoleProbe(units, { x: 50, y: 100 }, 0.5);
    expect(hole.kind).toBe('hole');
    if (hole.kind === 'hole') {
      expect(isHolePathDataSafe(hole.target.holePathData)).toBe(true);
      // Reference-solid: single hole contour (not a hole+island compound).
      expect(hole.target.holePathData.match(/M/g)?.length).toBe(1);
      expect(hole.target.holePathData).toContain('M40 40');
      expect(hole.target.holeDocumentBounds.width).toBeGreaterThan(0);
    }
    // Island interior itself is painted: no hole claim.
    expect(geometryFallbackHoleProbe(units, { x: 100, y: 100 }, 0.5).kind).toBe('none');
  });

  it('fail-closes overlaps inside, stays none far outside', () => {
    const units = [pathUnit(OVERLAP, { fill: '#ff0000', 'fill-rule': 'evenodd' })];
    expect(geometryFallbackHoleProbe(units, { x: 75, y: 75 }, 0.5).kind).toBe('ambiguous');
    expect(geometryFallbackHoleProbe(units, { x: 190, y: 190 }, 0.5).kind).toBe('none');
  });

  it('declines curves, clip/mask, url paint, non-path, and fill=none without hole claims', () => {
    const curve = [pathUnit('M0 0C10 10 20 20 30 30 M40 40H50V50H40Z', { fill: '#ff0000' })];
    expect(geometryFallbackHoleProbe(curve, { x: 45, y: 45 }, 0.5).kind).toBe('none');
    const clipped = [pathUnit(DONUT, { fill: '#ff0000', 'fill-rule': 'evenodd', 'clip-path': 'url(#c)' })];
    expect(geometryFallbackHoleProbe(clipped, { x: 240, y: 180 }, 0.5).kind).toBe('unsupported');
    const masked = [pathUnit(DONUT, { fill: '#ff0000', 'fill-rule': 'evenodd', style: 'mask:url(#m)' })];
    expect(geometryFallbackHoleProbe(masked, { x: 240, y: 180 }, 0.5).kind).toBe('unsupported');
    const gradient = [pathUnit(DONUT, { fill: 'url(#g)', 'fill-rule': 'evenodd' })];
    expect(geometryFallbackHoleProbe(gradient, { x: 240, y: 180 }, 0.5).kind).toBe('unsupported');
    const svg = svgRoot();
    const rect = makeNode('rect', { x: '0', y: '0', width: '10', height: '10' }, svg) as unknown as Element;
    expect(geometryFallbackHoleProbe([rect], { x: 5, y: 5 }, 0.5).kind).toBe('none');
    const unfilled = [pathUnit(DONUT, { fill: 'none' })];
    expect(geometryFallbackHoleProbe(unfilled, { x: 240, y: 180 }, 0.5).kind).toBe('none');
  });

  it('honors ancestor transforms and mirrors without flipping the verdict', () => {
    const svg = svgRoot();
    const group = makeNode('g', { transform: 'translate(20 10)' }, svg);
    const nested = makeNode('path', { d: DONUT, fill: '#ff0000', 'fill-rule': 'evenodd' }, group) as unknown as Element;
    // Local hole (240,180) appears at document (260,190).
    const hole = geometryFallbackHoleProbe([nested], { x: 260, y: 190 }, 0.5);
    expect(hole.kind).toBe('hole');
    if (hole.kind === 'hole') {
      // Sibling overlay copies only the own transform (ancestors ride the parent).
      expect(hole.target.parentTransform).toBe('');
      expect(hole.target.holeDocumentBounds.x).toBeCloseTo(230, 0);
      expect(hole.target.holeDocumentBounds.y).toBeCloseTo(160, 0);
    }
    // Same body without the ancestor offset is outside once translated.
    expect(geometryFallbackHoleProbe([nested], { x: 160, y: 100 }, 0.5).kind).toBe('none');
    const mirrorSvg = svgRoot();
    const mirrorGroup = makeNode('g', { transform: 'translate(200 0) scale(-1 1)' }, mirrorSvg);
    const mirrored = makeNode('path', { d: DONUT, fill: '#ff0000', 'fill-rule': 'evenodd' }, mirrorGroup) as unknown as Element;
    expect(geometryFallbackHoleProbe([mirrored], { x: -60, y: 180 }, 0.5).kind).toBe('hole');
  });

  it('treats edge-adjacent points as ambiguous and cross-unit holes as ambiguous', () => {
    const units = [pathUnit(DONUT, { fill: '#ff0000', 'fill-rule': 'evenodd' })];
    expect(geometryFallbackHoleProbe(units, { x: 150.2, y: 100 }, 0.5).kind).toBe('ambiguous');
    const twoDonuts = [
      pathUnit(DONUT, { fill: '#ff0000', 'fill-rule': 'evenodd' }),
      pathUnit(DONUT, { fill: '#00ff00', 'fill-rule': 'evenodd' }),
    ];
    // Same hole interior in two stacked units: overlapping holes across units.
    expect(geometryFallbackHoleProbe(twoDonuts, { x: 240, y: 180 }, 0.5).kind).toBe('ambiguous');
  });
});
