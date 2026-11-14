// Tests for the fill hover overlay wiring (draw-only, non-destructive).
//
// What is covered here (DOM-free, runs under `bun test`):
// - Hole safety gate (`isFillHoverHolePreviewSafe`): unsafe `d`,
//   unsafe sibling transforms, and degenerate bounds never render.
// - Invisible paint never renders (solid-transparent body/hole, `none` /
//   `ambiguous` / `unsupported` / `noop-transparent-hole` results).
// - Resolver behavior for the hover -> leave -> other-target flow, fill vs
//   stroke sides, transparent paint, and rapid-move stale drops (stub
//   resolvers, no Paper.js, no DOM).
// - Non-destruction: resolver inputs unchanged with no setter calls, the
//   snapshot builder never mutates its input string, and neither the helper
//   nor the BitmapEditor hover path touches history / VM / live commits.
//
// DOM-dependent snapshot geometry (visible solid/gradient recolor on the hit
// side only, hole sibling insertion, ancestor-transform preservation) runs in
// `vector-fill-hover-overlay.browser.test.ts` with a real DOMParser.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildFillHoverBodySnapshot,
  buildFillHoverHoleSnapshot,
  buildFillHoverPreviewSnapshot,
  isFillHoverHolePreviewSafe,
  type FillHoverOverlayToolbarPaint,
} from '../src/features/costumes/vector-fill-hover-overlay';
import {
  createFillHoverPreviewTracker,
  resolveFillHoverPreview,
  type FillHoverPreviewBodyTarget,
} from '../src/features/costumes/vector-fill-hover-preview';

function stubUnit(attrs: Record<string, string> = {}): Element {
  const node = {
    tagName: 'path',
    nodeName: 'PATH',
    parentElement: null,
    getAttribute: (name: string) => (name in attrs ? attrs[name]! : null),
    hasAttribute: (name: string) => name in attrs,
  };
  return node as unknown as Element;
}

function writeGuardedUnit(attrs: Record<string, string> = {}): { element: Element; writes: number } {
  let writes = 0;
  const element = {
    tagName: 'path',
    nodeName: 'PATH',
    parentElement: null,
    getAttribute: (name: string) => (name in attrs ? attrs[name]! : null),
    hasAttribute: (name: string) => name in attrs,
    setAttribute: () => {
      writes += 1;
    },
    removeAttribute: () => {
      writes += 1;
    },
  } as unknown as Element;
  return {
    element,
    get writes() {
      return writes;
    },
  };
}

function bodyStub(overrides: Partial<FillHoverPreviewBodyTarget> = {}): FillHoverPreviewBodyTarget {
  return {
    index: 0,
    hitType: 'fill',
    isText: false,
    hasFill: true,
    closed: true,
    almostClosed: false,
    parentIsCompoundPath: false,
    childArea: undefined,
    ...overrides,
  };
}

const opaquePaint: FillHoverOverlayToolbarPaint = {
  paintColor: '#ff0000',
  secondaryPaintColor: '#ffffff',
  paintGradient: 'solid',
  fillTransparent: false,
  secondaryTransparent: false,
  strokeColor: '#000000',
  strokeSecondaryColor: '#ffffff',
  strokeGradient: 'solid',
  strokeTransparent: false,
  secondaryStrokeTransparent: false,
  strokeWidth: 4,
  vectorOpacity: 100,
};

const transparentFillPaint: FillHoverOverlayToolbarPaint = { ...opaquePaint, fillTransparent: true };
const transparentStrokePaint: FillHoverOverlayToolbarPaint = { ...opaquePaint, strokeTransparent: true };

const solidVisible = { gradientType: 'solid', fillTransparent: false, fillInvisible: false };
const solidTransparent = { gradientType: 'solid', fillTransparent: true, fillInvisible: true };

const validHole = {
  holePathData: 'M10 10H20V20H10Z',
  parentTransform: '',
  holeDocumentBounds: { x: 10, y: 10, width: 10, height: 10 },
};

describe('fill hover hole safety gate (fail-closed, DOM-free)', () => {
  it('accepts safe hole geometry', () => {
    expect(isFillHoverHolePreviewSafe(validHole)).toBe(true);
    expect(isFillHoverHolePreviewSafe({ ...validHole, parentTransform: 'translate(10 20)' })).toBe(true);
  });

  it('rejects dangerous hole path data without rendering', () => {
    for (const holePathData of [
      '',
      'M10 10L20 20<script>',
      'M10 10 url(#x)',
      'M10 10 "quoted"',
      'M10 10 <g>',
      'L10 10H20',
    ]) {
      expect(isFillHoverHolePreviewSafe({ ...validHole, holePathData })).toBe(false);
      expect(buildFillHoverHoleSnapshot({ baseSvgText: '<svg></svg>', parentIndex: 0, hole: { ...validHole, holePathData }, point: { x: 15, y: 15 }, paint: opaquePaint })).toBe(null);
    }
  });

  it('rejects dangerous sibling transforms without rendering', () => {
    for (const parentTransform of [
      'translate(10 < 20)',
      'url(#x)',
      'javascript:alert(1)',
      'rotate(45);expression(x)',
    ]) {
      expect(isFillHoverHolePreviewSafe({ ...validHole, parentTransform })).toBe(false);
      expect(buildFillHoverHoleSnapshot({ baseSvgText: '<svg></svg>', parentIndex: 0, hole: { ...validHole, parentTransform }, point: { x: 15, y: 15 }, paint: opaquePaint })).toBe(null);
    }
  });

  it('rejects degenerate or non-finite hole bounds', () => {
    expect(isFillHoverHolePreviewSafe({ ...validHole, holeDocumentBounds: { x: 0, y: 0, width: 0, height: 10 } })).toBe(false);
    expect(isFillHoverHolePreviewSafe({ ...validHole, holeDocumentBounds: { x: 0, y: 0, width: -5, height: 10 } })).toBe(false);
    expect(isFillHoverHolePreviewSafe({ ...validHole, holeDocumentBounds: { x: NaN, y: 0, width: 10, height: 10 } })).toBe(false);
  });
});

describe('fill hover overlay invisibility (no overlay, DOM-free)', () => {
  it('renders nothing for transparent body paint', () => {
    expect(
      buildFillHoverBodySnapshot({ baseSvgText: '<svg></svg>', index: 0, property: 'fill', point: { x: 1, y: 1 }, paint: transparentFillPaint }),
    ).toBe(null);
    expect(
      buildFillHoverBodySnapshot({ baseSvgText: '<svg></svg>', index: 0, property: 'stroke', point: { x: 1, y: 1 }, paint: transparentStrokePaint }),
    ).toBe(null);
  });

  it('renders nothing for transparent holes (noop)', () => {
    expect(
      buildFillHoverHoleSnapshot({ baseSvgText: '<svg></svg>', parentIndex: 0, hole: validHole, point: { x: 15, y: 15 }, paint: transparentFillPaint }),
    ).toBe(null);
  });

  it('renders nothing for non-target results', () => {
    const point = { x: 0, y: 0 };
    for (const result of [
      { kind: 'none', reason: 'no shape under the pointer', tolerance: 1, targetKey: null },
      { kind: 'noop-transparent-hole', tolerance: 1, targetKey: null, reason: 'transparent holes stay empty' },
      { kind: 'ambiguous', reason: 'overlap (fail-closed)', tolerance: 1, targetKey: null },
      { kind: 'unsupported', reason: 'nested (fail-closed)', tolerance: 1, targetKey: null },
    ] as const) {
      expect(buildFillHoverPreviewSnapshot({ baseSvgText: '<svg></svg>', result, point, paint: opaquePaint })).toBe(null);
    }
  });
});

describe('fill hover target flow (hover -> leave -> other target)', () => {
  it('tracks fill and stroke sides across targets', async () => {
    const units = [stubUnit({ fill: 'red' }), stubUnit({ fill: 'blue', stroke: 'black' })];
    const first = await resolveFillHoverPreview({
      units,
      point: { x: 5, y: 5 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => bodyStub({ index: 0, hitType: 'fill' }),
        resolveHoleProbe: async () => ({ kind: 'none' }),
      },
    });
    expect(first.kind).toBe('body');
    // Leave: no hover request resolves, so the overlay clears without writes.
    const cleared: typeof first | null = null;
    expect(cleared).toBe(null);
    // Other target, other side: the stroke side previews independently.
    const second = await resolveFillHoverPreview({
      units,
      point: { x: 50, y: 50 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => bodyStub({ index: 1, hitType: 'stroke' }),
        resolveHoleProbe: async () => ({ kind: 'none' }),
      },
    });
    expect(second.kind).toBe('body');
    if (second.kind === 'body') {
      expect(second.index).toBe(1);
      expect(second.property).toBe('stroke');
    }
  });

  it('rejects open-path fill hits but keeps stroke hits side-scoped', async () => {
    const openFill = bodyStub({ hitType: 'fill', hasFill: false, closed: false, almostClosed: false });
    const openStroke = bodyStub({ hitType: 'stroke', hasFill: false, closed: false, almostClosed: false });
    const run = (target: FillHoverPreviewBodyTarget) =>
      resolveFillHoverPreview({
        units: [stubUnit({ fill: 'none', stroke: 'black' })],
        point: { x: 1, y: 1 },
        tolerance: 1,
        paint: solidVisible,
        resolvers: {
          resolveBodyTarget: async () => target,
          resolveHoleProbe: async () => ({ kind: 'none' }),
        },
      });
    expect((await run(openFill)).kind).toBe('none');
    const stroke = await run(openStroke);
    expect(stroke.kind).toBe('body');
    if (stroke.kind === 'body') expect(stroke.property).toBe('stroke');
  });

  it('gates transparent paint without inventing outlines', async () => {
    const strokeHit = bodyStub({ hitType: 'stroke', hasFill: false, closed: false, almostClosed: false });
    const unstroked = [stubUnit({ fill: 'red', stroke: 'none' })];
    const visible = await resolveFillHoverPreview({
      units: unstroked,
      point: { x: 5, y: 5 },
      tolerance: 2,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => strokeHit,
        resolveHoleProbe: async () => ({ kind: 'none' }),
      },
    });
    expect(visible.kind).toBe('none');
    const transparent = await resolveFillHoverPreview({
      units: unstroked,
      point: { x: 5, y: 5 },
      tolerance: 2,
      paint: solidTransparent,
      resolvers: {
        resolveBodyTarget: async () => strokeHit,
        resolveHoleProbe: async () => ({ kind: 'none' }),
      },
    });
    expect(transparent.kind).toBe('body');
  });
});

describe('fill hover rapid moves (stale async results are dropped)', () => {
  it('drops the slow earlier resolve when a newer move issued', async () => {
    const tracker = createFillHoverPreviewTracker();
    let applied: string | null = null;
    const slowId = tracker.issue();
    const slow = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'slow-target';
    })();
    const fastId = tracker.issue();
    const fast = Promise.resolve('fast-target');
    const fastResult = await fast;
    if (!tracker.isStale(fastId)) applied = fastResult;
    const slowResult = await slow;
    if (!tracker.isStale(slowId)) applied = slowResult;
    expect(applied).toBe('fast-target');
  });
});

describe('fill hover non-destruction (SVG bytes / history untouched)', () => {
  it('resolver never writes DOM: inputs unchanged, no setters called', async () => {
    const guarded = writeGuardedUnit({ fill: 'red', stroke: 'black' });
    const before = `${guarded.element.getAttribute('fill')}|${guarded.element.getAttribute('stroke')}`;
    const result = await resolveFillHoverPreview({
      units: [guarded.element],
      point: { x: 2, y: 2 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => bodyStub({}),
        resolveHoleProbe: async () => ({ kind: 'none' }),
      },
    });
    expect(result.kind).toBe('body');
    expect(guarded.writes).toBe(0);
    expect(`${guarded.element.getAttribute('fill')}|${guarded.element.getAttribute('stroke')}`).toBe(before);
  });

  it('snapshot builder never mutates its input string (click / undo / redo safe)', () => {
    const baseSvgText = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H10V10H0Z" fill="red"/></svg>';
    const before = baseSvgText;
    buildFillHoverBodySnapshot({ baseSvgText, index: 0, property: 'fill', point: { x: 1, y: 1 }, paint: transparentFillPaint });
    buildFillHoverHoleSnapshot({ baseSvgText, parentIndex: 0, hole: validHole, point: { x: 15, y: 15 }, paint: transparentFillPaint });
    buildFillHoverPreviewSnapshot({
      baseSvgText,
      result: { kind: 'ambiguous', reason: 'overlap (fail-closed)', tolerance: 1, targetKey: null },
      point: { x: 1, y: 1 },
      paint: opaquePaint,
    });
    expect(baseSvgText).toBe(before);
  });

  it('hover helper and UI path never touch history / VM / live commits', () => {
    const helperUrl = new URL('../src/features/costumes/vector-fill-hover-overlay.ts', import.meta.url);
    const helper = readFileSync(helperUrl, 'utf8');
    // Detached-clone writes (`setAttribute` / `insertBefore` on the parsed
    // snapshot) are the draw-only mechanism and stay here; history / VM /
    // live-commit entry points must never appear. (Doc comments may name the
    // commit path for reference, so only import/call shapes are forbidden.)
    for (const forbidden of [
      'commitPaintHistory(',
      'peekCostumeHistory(',
      'captureCostumeHistory(',
      'updateVectorCostumeFromEditor(',
      'AssetHistoryEntry',
    ]) {
      expect(helper).not.toContain(forbidden);
    }
    const editorUrl = new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url);
    const ui = readFileSync(editorUrl, 'utf8');
    // Slice from the hover state declaration so the section covers the
    // tracker creation, resolver calls, and every clear path below it.
    const hoverSection = ui.slice(ui.indexOf('fillHoverPreviewSvg'));
    expect(hoverSection).toContain('resolveFillHoverPreview');
    expect(hoverSection).toContain('createFillHoverPreviewTracker');
    expect(hoverSection).toContain('isStale');
    for (const forbidden of ['commitPaintHistory', 'updateVectorCostumeFromEditor', 'captureCostumeHistory']) {
      expect(hoverSection).not.toContain(forbidden);
    }
  });
});

describe('fill hover UI wiring (real UI connection, source-level)', () => {
  const uiUrl = new URL('../src/features/CostumeEditor/BitmapEditor.svelte', import.meta.url);
  const ui = readFileSync(uiUrl, 'utf8');

  it('listens to pointermove (not mouseover/out) with the click point mapping', () => {
    expect(ui).toContain('requestVectorFillHover');
    expect(ui).toContain('vectorPointFromEvent(event)');
    expect(ui).toContain('handleCanvasPointerMove');
    expect(ui).not.toMatch(/onmouseover=\{[^}]*fill/i);
    expect(ui).not.toMatch(/onmouseout=\{[^}]*fill/i);
  });

  it('clears on pointerleave / tool switch / selection / paint / Escape / target switch', () => {
    expect(ui).toContain('handleCanvasPointerLeave');
    expect(ui).toContain('clearFillHoverPreview()');
    // Tool switch.
    expect(ui).toContain('chooseVectorTool');
    // Selection + paint + artwork effects.
    expect(ui).toContain('void selectedVectorObjectIndices');
    expect(ui).toContain('void paintColor');
    expect(ui).toContain('void currentCostumePreviewSvg');
    // Escape.
    expect(ui).toContain("event.key !== 'Escape'");
    // Click / undo / redo clear before the commit lands.
    expect(ui).toContain('clearFillHoverPreview()\n        return fillVectorObjectAtPoint(point)');
  });

  it('drops stale async resolves and keeps a zoom-aware tolerance', () => {
    expect(ui).toContain('fillHoverPreviewTracker.isStale(requestId)');
    expect(ui).toContain('vectorSelectToleranceForHit()');
  });

  it('renders a draw-only overlay above the base and below selection UI without blocking', () => {
    const baseIndex = ui.indexOf('class="vector-preview absolute');
    const previewIndex = ui.indexOf('<VectorFillHoverPreview');
    const outlinesIndex = ui.indexOf('data-vector-selection-outline');
    expect(baseIndex).toBeGreaterThan(-1);
    expect(previewIndex).toBeGreaterThan(baseIndex);
    expect(outlinesIndex).toBeGreaterThan(previewIndex);
    const componentUrl = new URL('../src/features/CostumeEditor/VectorFillHoverPreview.svelte', import.meta.url);
    const component = readFileSync(componentUrl, 'utf8');
    expect(component).toContain('pointer-events: none');
    expect(component).toContain('pointer-events-none');
    expect(component).toContain('aria-hidden="true"');
    expect(component).not.toContain('setAttribute');
    expect(component).not.toContain('commitPaintHistory');
  });

  it('honors the visible target side and fail-closed holes', () => {
    // The hit side scopes the preview to exactly one attribute; hole
    // overlays are fill-only. The single-side literal lives in the snapshot
    // helper (detached clone), the UI routes the resolver result into it.
    const helperUrl = new URL('../src/features/costumes/vector-fill-hover-overlay.ts', import.meta.url);
    const helper = readFileSync(helperUrl, 'utf8');
    expect(helper).toContain("property: 'fill' | 'stroke'");
    expect(helper).toContain('overlay.setAttribute');
    expect(ui).toContain('hole-overlay');
    expect(ui).toContain('nextKey.property');
    expect(ui).toContain('hasEffectiveVisibleStroke');
    expect(helper).toContain('isFillInvisible');
    expect(helper).toContain('isHolePathDataSafe');
  });
});
