import { describe, expect, it } from 'bun:test';
import {
  FILL_HOVER_OVERLAY_MARKER,
  applyFillPreviewToElement,
  captureFillPreviewOriginal,
  decideFillHoverTarget,
  fillGapDistance,
  fillToolToleranceForZoom,
  hitUnstrokedPathsForFillPaint,
  holeOverlayHoverFlags,
  isAlmostClosedFillPath,
  isHoleFillHit,
  isHoleFillOverlay,
  isHoverableFillCandidate,
  markHoleFillOverlay,
  planFillPreviewTransition,
  restoreFillPreviewToElement,
  shouldAcceptFillHoverHit,
  type FillPreviewElement,
} from '../src/features/costumes/vector-fill-hover';
import { isHolePathDataSafe } from '../src/features/costumes/paper-vector';

class StubElement implements FillPreviewElement {
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

describe('fill-tool tolerance and almost-closed rule', () => {
  it('keeps a constant 2 screen-px budget (2 / zoom)', () => {
    expect(fillToolToleranceForZoom(1)).toBeCloseTo(2, 10);
    expect(fillToolToleranceForZoom(2)).toBeCloseTo(1, 10);
    expect(fillToolToleranceForZoom(0.5)).toBeCloseTo(4, 10);
    // Fail-closed fallbacks never divide by zero.
    expect(fillToolToleranceForZoom(0)).toBe(2);
    expect(fillToolToleranceForZoom(Number.NaN)).toBe(2);
  });

  it('detects almost-closed open paths (gap < 8, segments > 2)', () => {
    expect(fillGapDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 10);
    expect(isAlmostClosedFillPath(3, { x: 0, y: 0 }, { x: 7.9, y: 0 })).toBe(true);
    expect(isAlmostClosedFillPath(3, { x: 0, y: 0 }, { x: 8, y: 0 })).toBe(false);
    expect(isAlmostClosedFillPath(2, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false);
  });
});

describe('hover target judgment (closed/open/stroke-vs-fill)', () => {
  it('rejects fill hits on open paths without fill, accepts stroke hits', () => {
    expect(
      shouldAcceptFillHoverHit({ kind: 'path', hasFill: false, closed: false, almostClosed: false, hitType: 'fill' }),
    ).toBe(false);
    expect(
      shouldAcceptFillHoverHit({ kind: 'path', hasFill: false, closed: false, almostClosed: false, hitType: 'stroke' }),
    ).toBe(true);
  });

  it('accepts fill hits on closed / filled / almost-closed paths', () => {
    expect(
      shouldAcceptFillHoverHit({ kind: 'path', hasFill: false, closed: true, almostClosed: false, hitType: 'fill' }),
    ).toBe(true);
    expect(
      shouldAcceptFillHoverHit({ kind: 'path', hasFill: true, closed: false, almostClosed: false, hitType: 'fill' }),
    ).toBe(true);
    expect(
      shouldAcceptFillHoverHit({ kind: 'path', hasFill: false, closed: false, almostClosed: true, hitType: 'fill' }),
    ).toBe(true);
  });

  it('always accepts text and never accepts non-path/non-text leaves', () => {
    expect(
      shouldAcceptFillHoverHit({ kind: 'text', hasFill: false, closed: false, almostClosed: false, hitType: 'fill' }),
    ).toBe(true);
    expect(
      shouldAcceptFillHoverHit({ kind: 'other', hasFill: true, closed: true, almostClosed: true, hitType: 'fill' }),
    ).toBe(false);
  });

  it('only hits invisible outlines for transparent solid paint', () => {
    expect(hitUnstrokedPathsForFillPaint({ gradientType: 'solid', fillTransparent: true })).toBe(true);
    expect(hitUnstrokedPathsForFillPaint({ gradientType: 'solid', fillTransparent: false })).toBe(false);
    expect(hitUnstrokedPathsForFillPaint({ gradientType: 'horizontal', fillTransparent: true })).toBe(false);
  });
});

describe('CompoundPath holes', () => {
  it('detects negative-area compound children hit on fill', () => {
    expect(isHoleFillHit({ parentIsCompoundPath: true, childArea: -100, hitType: 'fill' })).toBe(true);
    expect(isHoleFillHit({ parentIsCompoundPath: true, childArea: -100, hitType: 'stroke' })).toBe(false);
    expect(isHoleFillHit({ parentIsCompoundPath: true, childArea: 100, hitType: 'fill' })).toBe(false);
    expect(isHoleFillHit({ parentIsCompoundPath: false, childArea: -100, hitType: 'fill' })).toBe(false);
  });

  it('makes transparent hole fills a no-op and routes opaque holes to an overlay', () => {
    expect(
      decideFillHoverTarget({ accepted: true, isHole: true, parentIsCompoundPath: true, hitType: 'fill', fillTransparent: true }),
    ).toEqual({ action: 'noop-transparent-hole' });
    expect(
      decideFillHoverTarget({ accepted: true, isHole: true, parentIsCompoundPath: true, hitType: 'fill', fillTransparent: false }),
    ).toEqual({ action: 'preview-hole-overlay', property: 'fill' });
  });

  it('recolors the parent for non-hole compound children, scoped to the hit side', () => {
    expect(
      decideFillHoverTarget({ accepted: true, isHole: false, parentIsCompoundPath: true, hitType: 'fill', fillTransparent: false }),
    ).toEqual({ action: 'preview-parent', property: 'fill' });
    expect(
      decideFillHoverTarget({ accepted: true, isHole: false, parentIsCompoundPath: true, hitType: 'stroke', fillTransparent: false }),
    ).toEqual({ action: 'preview-parent', property: 'stroke' });
    expect(
      decideFillHoverTarget({ accepted: false, isHole: false, parentIsCompoundPath: false, hitType: 'fill', fillTransparent: false }),
    ).toEqual({ action: 'ignore' });
  });
});

describe('selection handles and helper exclusion', () => {
  it('excludes helpers, guides, selected, locked, and clip masks', () => {
    expect(isHoverableFillCandidate({})).toBe(true);
    expect(isHoverableFillCandidate({ noHover: true })).toBe(false);
    expect(isHoverableFillCandidate({ selected: true })).toBe(false);
    expect(isHoverableFillCandidate({ guide: true })).toBe(false);
    expect(isHoverableFillCandidate({ isHelperItem: true })).toBe(false);
    expect(isHoverableFillCandidate({ locked: true })).toBe(false);
    expect(isHoverableFillCandidate({ isClipMask: true })).toBe(false);
  });

  it('marks hole overlays so later hover passes exclude them', () => {
    const overlay = new StubElement({ fill: '#ff0000' });
    markHoleFillOverlay(overlay);
    expect(overlay.getAttribute(FILL_HOVER_OVERLAY_MARKER)).toBe('true');
    expect(overlay.getAttribute('pointer-events')).toBe('none');
    expect(isHoleFillOverlay(overlay)).toBe(true);
    expect(isHoverableFillCandidate(holeOverlayHoverFlags())).toBe(false);
    expect(isHoleFillOverlay(new StubElement({ fill: '#ff0000' }))).toBe(false);
  });
});

describe('hole overlay path-data guard (fail-closed)', () => {
  it('accepts Paper-exported hole outlines and rejects untrusted payloads', () => {
    expect(isHolePathDataSafe('M210 150H270V210H210Z')).toBe(true);
    expect(isHolePathDataSafe('M0 0L10 0L10 10Z')).toBe(true);
    expect(isHolePathDataSafe('')).toBe(false);
    expect(isHolePathDataSafe('L10 10')).toBe(false);
    expect(isHolePathDataSafe('M0 0L10 0"><script>alert(1)</script>')).toBe(false);
    expect(isHolePathDataSafe('M0 0 url(#x)')).toBe(false);
    expect(isHolePathDataSafe('M0 0; fill:red')).toBe(false);
  });
});

describe('preview state machine and side-scoped writes', () => {
  it('stays quiet on the same target, recenters radial, switches on side/index/hole change', () => {
    const target = { index: 0, property: 'fill' as const, isHoleOverlay: false };
    expect(planFillPreviewTransition(target, target, 'solid')).toEqual({ action: 'none' });
    expect(planFillPreviewTransition(target, target, 'radial')).toEqual({ action: 'update-radial-center' });
    expect(planFillPreviewTransition(target, { ...target, property: 'stroke' }, 'solid')).toEqual({ action: 'switch-target' });
    expect(planFillPreviewTransition(target, { ...target, index: 1 }, 'solid')).toEqual({ action: 'switch-target' });
    expect(planFillPreviewTransition(target, { ...target, isHoleOverlay: true }, 'solid')).toEqual({
      action: 'switch-target',
    });
    expect(planFillPreviewTransition(target, null, 'solid')).toEqual({ action: 'switch-target' });
    expect(planFillPreviewTransition(null, null, 'solid')).toEqual({ action: 'none' });
  });

  it('previews exactly one side and restores the exact original', () => {
    const element = new StubElement({ fill: '#ff0000', stroke: '#000000', transform: 'translate(1 2)' });
    const originalFill = captureFillPreviewOriginal(element, 'fill');
    applyFillPreviewToElement(element, 'fill', '#00ff00');
    expect(element.snapshot()).toEqual({
      fill: '#00ff00',
      stroke: '#000000',
      transform: 'translate(1 2)',
    });
    restoreFillPreviewToElement(element, 'fill', originalFill);
    expect(element.getAttribute('fill')).toBe('#ff0000');

    // Missing attributes remove on restore (never leave a preview behind).
    const bare = new StubElement({ stroke: '#000000' });
    const missing = captureFillPreviewOriginal(bare, 'fill');
    expect(missing).toBe(null);
    applyFillPreviewToElement(bare, 'fill', 'none');
    expect(bare.getAttribute('fill')).toBe('none');
    restoreFillPreviewToElement(bare, 'fill', missing);
    expect(bare.getAttribute('fill')).toBe(null);
    expect(bare.getAttribute('stroke')).toBe('#000000');
  });
});
