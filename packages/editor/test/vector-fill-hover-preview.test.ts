// Tests for the non-destructive fill-hover preview resolver.
//
// Integration notes for the runtime hover preview (report, not code --
// `Editor.svelte` / `BitmapEditor.svelte` / `paper-vector.ts` are untouched):
// - Wire `pointermove` (not `mouseover`/`out`) on the vector stage surface:
//   `mouseover`/`out` bubble per child node and miss moves inside one shape,
//   while a single `pointermove` + `pointerleave` pair tracks the pointer
//   continuously. Convert the client point to document space with the same
//   mapping clicks use, then call `resolveFillHoverPreview` with the live
//   zoom-aware tolerance (`resolveVectorHitTolerance()` passthrough).
// - Async race: Paper imports are async, so a slow earlier move can resolve
//   after a newer one. Guard with `createFillHoverPreviewTracker`: `issue()`
//   per move, `await` the resolver, then drop the result when
//   `isStale(id)`. Never apply a stale preview, and always restore via
//   `planFillPreviewTransition` / `restoreFillPreviewToElement` (side-scoped).
// - Preview writes stay ephemeral: `applyFillPreviewToElement` on the hit
//   side only, `markHoleFillOverlay` + `pointer-events:none` for hole
//   overlays (so the next pass excludes them via `noHover`), `mouseleave` /
//   tool-switch / selection-change restores the previous paint. Commits stay
//   in `fillVectorObjectAtPoint`; the resolver never writes history/VM/DOM.

import { describe, expect, it } from 'bun:test';
import {
  createFillHoverPreviewTracker,
  hasLocalVisibleStroke,
  isClipBlockedUnit,
  resolveFillHoverPreview,
  resolveFillHoverPreviewTolerance,
  type FillHoverPreviewHoleProbe,
  type FillHoverPreviewBodyTarget,
} from '../src/features/costumes/vector-fill-hover-preview';

type StubParent = {
  tagName: string;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  parentElement: StubParent | null;
};

function stubUnit(
  attrs: Record<string, string> = {},
  tag = 'path',
  parent: StubParent | null = null,
): Element {
  const upper = tag.toUpperCase();
  const node = {
    tagName: tag,
    nodeName: upper,
    parentElement: parent,
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

const solidVisible = { gradientType: 'solid', fillTransparent: false, fillInvisible: false };
const solidTransparent = { gradientType: 'solid', fillTransparent: true, fillInvisible: true };

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

describe('fill hover preview tolerance (zoom)', () => {
  it('passes explicit editor tolerance through, derives 2/zoom otherwise', () => {
    expect(resolveFillHoverPreviewTolerance({ tolerance: 0.4 })).toBeCloseTo(0.4, 10);
    expect(resolveFillHoverPreviewTolerance({ zoom: 1 })).toBeCloseTo(2, 10);
    expect(resolveFillHoverPreviewTolerance({ zoom: 0.25 })).toBeCloseTo(8, 10);
    expect(resolveFillHoverPreviewTolerance({ zoom: 0 })).toBe(2);
    expect(resolveFillHoverPreviewTolerance({})).toBe(2);
  });
});

describe('fill hover preview target judgment', () => {
  it('previews the hit side for closed/filled bodies', async () => {
    const units = [stubUnit({ fill: 'red', stroke: 'black' })];
    let seenTolerance = -1;
    const result = await resolveFillHoverPreview({
      units,
      point: { x: 10, y: 10 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async (_units, _point, tolerance) => {
          seenTolerance = tolerance;
          return bodyStub({ index: 0, hitType: 'fill' });
        },
        resolveHoleProbe: async () => ({ kind: 'none' }),
      },
    });
    expect(seenTolerance).toBeCloseTo(1, 10);
    expect(result.kind).toBe('body');
    if (result.kind === 'body') {
      expect(result.index).toBe(0);
      expect(result.property).toBe('fill');
      expect(result.targetKey).toEqual({ index: 0, property: 'fill', isHoleOverlay: false });
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

  it('excludes selected / guide / helper / locked / clip-mask units', async () => {
    const target = bodyStub({});
    const base = {
      units: [stubUnit({})],
      point: { x: 0, y: 0 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => target,
        resolveHoleProbe: async () => ({ kind: 'none' }) as FillHoverPreviewHoleProbe,
      },
    } as const;
    expect((await resolveFillHoverPreview({ ...base, selectedIndices: [0] })).kind).toBe('none');
    expect((await resolveFillHoverPreview({ ...base, getCandidateFlags: () => ({ guide: true }) })).kind).toBe('none');
    expect((await resolveFillHoverPreview({ ...base, getCandidateFlags: () => ({ noHover: true }) })).kind).toBe('none');
    expect((await resolveFillHoverPreview({ ...base, getCandidateFlags: () => ({ isHelperItem: true }) })).kind).toBe('none');
    expect((await resolveFillHoverPreview({ ...base, getCandidateFlags: () => ({ locked: true }) })).kind).toBe('none');
    expect((await resolveFillHoverPreview({ ...base, getCandidateFlags: () => ({ isClipMask: true }) })).kind).toBe('none');
    expect(isClipBlockedUnit(stubUnit({ 'clip-path': 'url(#c)' }))).toBe(true);
    const clipped = await resolveFillHoverPreview({
      ...base,
      units: [stubUnit({ 'clip-path': 'url(#c)' })],
    });
    expect(clipped.kind).toBe('none');
  });

  it('gates invisible outlines by transparent paint (zoom/ancestor-safe)', async () => {
    // Stock Paper can report a stroke hit where no outline is painted; visible
    // paint must ignore it, transparent-solid alone may preview it.
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
    expect(hasLocalVisibleStroke(stubUnit({ stroke: 'none' }))).toBe(false);
    expect(hasLocalVisibleStroke(stubUnit({ stroke: '#000', 'stroke-width': '2' }))).toBe(true);
  });

  it('routes compound holes to overlays, transparent holes to no-ops', async () => {
    const holeTarget = {
      parentIndex: 0,
      holePathData: 'M10 10H20V20H10Z',
      holeDocumentBounds: { x: 10, y: 10, width: 10, height: 10 },
      parentTransform: '',
      parentFillRule: 'evenodd',
    };
    const holeBody = bodyStub({ hitType: 'fill', parentIsCompoundPath: true, childArea: -100 });
    const colored = await resolveFillHoverPreview({
      units: [stubUnit({ fill: 'red' })],
      point: { x: 15, y: 15 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => null,
        resolveHoleProbe: async () => ({ kind: 'hole', target: holeTarget }),
      },
    });
    expect(colored.kind).toBe('hole-overlay');
    if (colored.kind === 'hole-overlay') {
      expect(colored.targetKey).toEqual({ index: 0, property: 'fill', isHoleOverlay: true });
    }
    const transparent = await resolveFillHoverPreview({
      units: [stubUnit({ fill: 'red' })],
      point: { x: 15, y: 15 },
      tolerance: 1,
      paint: solidTransparent,
      resolvers: {
        resolveBodyTarget: async () => null,
        resolveHoleProbe: async () => ({ kind: 'hole', target: holeTarget }),
      },
    });
    expect(transparent.kind).toBe('noop-transparent-hole');
    // Negative-area child hit on fill goes through the same overlay path.
    const inPlace = await resolveFillHoverPreview({
      units: [stubUnit({ fill: 'red' })],
      point: { x: 15, y: 15 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => holeBody,
        resolveHoleProbe: async () => ({ kind: 'hole', target: holeTarget }),
      },
    });
    expect(inPlace.kind).toBe('hole-overlay');
  });

  it('honors document order and fail-closed hole states', async () => {
    const holeTarget = {
      parentIndex: 1,
      holePathData: 'M0 0H10V10H0Z',
      holeDocumentBounds: { x: 0, y: 0, width: 10, height: 10 },
      parentTransform: '',
      parentFillRule: 'evenodd',
    };
    // Body below a hole candidate: the overlap is a no-op, never a recolor.
    const covered = await resolveFillHoverPreview({
      units: [stubUnit({}), stubUnit({})],
      point: { x: 1, y: 1 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => bodyStub({ index: 0 }),
        resolveHoleProbe: async () => ({ kind: 'hole', target: holeTarget }),
      },
    });
    expect(covered.kind).toBe('none');
    const ambiguous = await resolveFillHoverPreview({
      units: [stubUnit({})],
      point: { x: 1, y: 1 },
      tolerance: 1,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async () => bodyStub({}),
        resolveHoleProbe: async () => ({ kind: 'ambiguous', reason: 'overlap (fail-closed)' }),
      },
    });
    expect(ambiguous.kind).toBe('ambiguous');
  });

  it('never writes DOM / history: inputs unchanged, no setters called', async () => {
    const guarded = writeGuardedUnit({ fill: 'red', stroke: 'black' });
    const before = (guarded.element.getAttribute('fill') ?? '') + '|' + (guarded.element.getAttribute('stroke') ?? '');
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
    expect((guarded.element.getAttribute('fill') ?? '') + '|' + (guarded.element.getAttribute('stroke') ?? '')).toBe(before);
  });

  it('forwards the document point and tolerance untouched (ancestors stay baked in resolvers)', async () => {
    let seenPoint = { x: -1, y: -1 };
    let seenTolerance = -1;
    await resolveFillHoverPreview({
      units: [stubUnit({ transform: 'translate(100 50)' })],
      point: { x: 120, y: 70 },
      zoom: 2,
      paint: solidVisible,
      resolvers: {
        resolveBodyTarget: async (_units, point, tolerance) => {
          seenPoint = { ...point };
          seenTolerance = tolerance;
          return null;
        },
        resolveHoleProbe: async () => ({ kind: 'none' }),
      },
    });
    // Document space is forwarded as-is; ancestor transforms ride the shared
    // baked import inside the injected Paper resolvers (never remapped here).
    expect(seenPoint).toEqual({ x: 120, y: 70 });
    expect(seenTolerance).toBeCloseTo(1, 10);
  });
});

describe('fill hover preview request tracker (pointermove race)', () => {
  it('drops stale async responses', () => {
    const tracker = createFillHoverPreviewTracker();
    const first = tracker.issue();
    const second = tracker.issue();
    expect(tracker.isStale(first)).toBe(true);
    expect(tracker.isStale(second)).toBe(false);
    expect(tracker.current()).toBe(second);
  });
});
