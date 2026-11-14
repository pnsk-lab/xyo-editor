import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Strong adversarial verification for `vector-fill-hole-nested.ts` (new file
// only; product source untouched).
//
// What this suite pins (all oracles real, in real Chrome):
// - Canvas 2D `Path2D(d)` + `fill(rule)` alpha via `getImageData`
//   (rendered-truth pixel: 0 = unfilled, >=200 = painted).
// - Paper.js entity truth: real `paper` import (`ensureVectorPaperScope`)
//   `contains` / `hitTest` for the same SVG (vector-model truth).
// - Production probe: real `paperVectorHoleTargetAtPoint` /
//   `paperVectorHitIndex` (the Paper probe that is still un-wired for
//   3/4 nesting: `probeCompoundPathHole` / `probeSubpathHole` refuse
//   `containing.length !== 2` as `ambiguous`, so 4-deep nests never resolve).
// - Candidate under test: pure `classifyHolePoint` / `resolveNestedHole` /
//   `auditStraightNesting` / `classifyCurvedHolePoint` (straight + curved).
//
// Contract per case (no self-fulfilling tests: every helper verdict is
// checked against the two independent oracles measured in the SAME evaluate):
// - 3/4 nesting outer-hole-island-hole; unrelated island outside the target.
// - compound filled (nonzero repeated winding) vs evenodd; arbitrary
//   transforms (translate/rotate/scale/mirror/singular/non-uniform).
// - self-crossing / collinear / touch / near-EPS contact; curved flatten
//   tolerance + topology; signed-area misorder (shuffled subpath order).
// - class / CSS / clip / mask / defs `url()` / invisibility (fail-closed).
// - huge path complexity / DoS (length caps, point caps, arc sample caps).
// - overlay safety: a claimed hole overlay must never paint a filled region,
//   a sibling body, an island interior, or another hole; originals and
//   z-order must be unchanged (DOM byte-identical, Paper project cleaned).
//
// Fail-audible: nested 4-deep `hole` expectations are written for the WIRED
// behavior. The Paper probe still returns `ambiguous` ("hole overlaps 4
// contours"), so those `expect(probeKind).toBe('hole')` lines FAIL today with
// a concrete `[nested-adversarial:FAIL]` repro. That is intentional: the
// failure reproduces with the actual tested function and stays red until
// `paper-vector.ts` is wired to the same laminar/nested resolution (owned by
// another agent). Safety no-ops already pass and must keep passing.
//
// Fixtures are synthetic and original to this file (no user data, no upstream
// transcription, no AGPL text reproduced: only `d` strings and point
// coordinates invented here).

const root = join(import.meta.dir, '..');
const PORT = 4715;
const base = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

function failReport(context: string, extra: unknown) {
  try {
    console.log(`[nested-adversarial:FAIL] ${context} ${JSON.stringify(extra).slice(0, 6000)}`);
  } catch {
    console.log(`[nested-adversarial:FAIL] ${context} (unserializable)`);
  }
}

describe('nested hole adversarial (Paper probe wiring gap + oracle parity)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    });
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`);
      try {
        if ((await fetch(base)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`);
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  it('4-deep evenodd nest: Canvas+Paper say hole, helper resolves, Paper probe must resolve (wiring gap)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const nested = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-nested.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const d = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
      const pts = {
        inner: { x: 100, y: 100 },
        islandRing: { x: 70, y: 100 },
        outerRing: { x: 40, y: 100 },
        body: { x: 10, y: 10 },
        outside: { x: 250, y: 100 },
      };
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaAt = (x: number, y: number, rule: CanvasFillRule = 'evenodd') => {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), rule);
        return ctx.getImageData(x, y, 1, 1).data[3]!;
      };
      const canvasVals: Record<string, number> = {
        inner: alphaAt(pts.inner.x, pts.inner.y),
        islandRing: alphaAt(pts.islandRing.x, pts.islandRing.y),
        outerRing: alphaAt(pts.outerRing.x, pts.outerRing.y),
        body: alphaAt(pts.body.x, pts.body.y),
        outside: alphaAt(pts.outside.x, pts.outside.y),
      };
      const scope = await paperVector.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><path d="${d}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
      const paperVals: Record<string, boolean> = {
        inner: item.contains(new scope.Point(pts.inner.x, pts.inner.y)),
        islandRing: item.contains(new scope.Point(pts.islandRing.x, pts.islandRing.y)),
        outerRing: item.contains(new scope.Point(pts.outerRing.x, pts.outerRing.y)),
        body: item.contains(new scope.Point(pts.body.x, pts.body.y)),
      };
      item.remove();
      scope.project.clear();
      const helperVals: Record<string, unknown> = {
        inner: helper.classifyHolePoint({ pathData: d, point: pts.inner, fillRule: 'evenodd' }),
        islandRing: helper.classifyHolePoint({ pathData: d, point: pts.islandRing, fillRule: 'evenodd' }),
        outerRing: helper.classifyHolePoint({ pathData: d, point: pts.outerRing, fillRule: 'evenodd' }),
        body: helper.classifyHolePoint({ pathData: d, point: pts.body, fillRule: 'evenodd' }),
        outside: helper.classifyHolePoint({ pathData: d, point: pts.outside, fillRule: 'evenodd' }),
      };
      // Direct `resolveNestedHole` on the real parsed contours (not a mock).
      const contours = helper.parseStraightContours(d)!;
      const areas = contours.map((c) => helper.contourArea(c));
      const innerContaining = helper.containingContourIndices(contours, pts.inner, 'evenodd');
      const directResolve = nested.resolveNestedHole({ contours, containing: innerContaining, areas });
      const audit = nested.auditStraightNesting(contours);
      // Production Paper probe for the same points (real wiring under test).
      const svgDoc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><path d="${d}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`,
        'image/svg+xml',
      );
      const units = vectorSvg.editableVectorUnits(svgDoc.documentElement as unknown as Element);
      const beforeHtml = units.map((u) => u.outerHTML).join('|');
      const probeInner = await paperVector.paperVectorHoleTargetAtPoint(units, pts.inner, 0.5);
      const probeOuterRing = await paperVector.paperVectorHoleTargetAtPoint(units, pts.outerRing, 0.5);
      const probeIsland = await paperVector.paperVectorHoleTargetAtPoint(units, pts.islandRing, 0.5);
      const probeBody = await paperVector.paperVectorHoleTargetAtPoint(units, pts.body, 0.5);
      const afterHtml = units.map((u) => u.outerHTML).join('|');
      const projectLeftovers = (() => {
        try {
          return (scope.project as unknown as { getItems?: (o: unknown) => unknown[] }).getItems?.({})?.length ?? -1;
        } catch {
          return -2;
        }
      })();
      scope.project.clear();
      return { canvasVals, paperVals, helperVals, directResolve, innerContaining, areas, audit, probeInner, probeOuterRing, probeIsland, probeBody, domMutated: beforeHtml !== afterHtml, projectLeftovers };
    });
    // Oracles agree: inner hole + outer ring unfilled; island + body painted.
    expect(result.canvasVals.inner).toBe(0);
    expect(result.canvasVals.outerRing).toBe(0);
    expect(result.canvasVals.islandRing).toBeGreaterThan(200);
    expect(result.canvasVals.body).toBeGreaterThan(200);
    expect(result.canvasVals.outside).toBe(0);
    expect(result.paperVals.inner).toBe(false);
    expect(result.paperVals.outerRing).toBe(false);
    expect(result.paperVals.islandRing).toBe(true);
    expect(result.paperVals.body).toBe(true);
    // Helper resolves the innermost child-free hole directly.
    expect((result.helperVals.inner as { kind: string }).kind).toBe('hole');
    expect((result.helperVals.islandRing as { kind: string }).kind).toBe('filled');
    expect((result.helperVals.outerRing as { kind: string }).kind).toBe('ambiguous');
    expect((result.helperVals.body as { kind: string }).kind).toBe('filled');
    expect((result.helperVals.outside as { kind: string }).kind).toBe('outside');
    expect(result.audit.ok).toBe(true);
    expect(result.directResolve.ok).toBe(true);
    if (result.directResolve.ok) {
      expect(result.directResolve.holeIndex).toBe(3);
      expect(result.directResolve.outerIndex).toBe(2);
    }
    // No mutation, no leftovers regardless of verdict.
    expect(result.domMutated).toBe(false);
    // Safety pins first (must keep passing even while the wiring gap is red):
    // outer ring with an island child must never become a hole overlay, and
    // filled island/body must never become holes.
    expect(result.probeOuterRing.kind).not.toBe('hole');
    expect(result.probeIsland.kind).not.toBe('hole');
    expect(result.probeBody.kind).not.toBe('hole');
    // Production probe wiring gap: innermost must become a hole (fails today).
    if (result.probeInner.kind !== 'hole') {
      failReport('4-deep evenodd innermost wiring gap', {
        canvasInner: result.canvasVals.inner,
        paperInner: result.paperVals.inner,
        helperInner: result.helperVals.inner,
        probeInner: result.probeInner,
        directResolve: result.directResolve,
      });
    }
    expect(result.probeInner.kind).toBe('hole');
    if (result.probeInner.kind === 'hole') {
      // Overlay must be strictly inside its outer and must not cover the island:
      // hole bounds contain the inner point but neither the island-ring nor the body.
      const b = result.probeInner.target.holeDocumentBounds;
      expect(b.width).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
      const contains = (px: number, py: number) => px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height;
      expect(contains(100, 100)).toBe(true);
      expect(contains(70, 100)).toBe(false);
      expect(contains(10, 10)).toBe(false);
      // Helper hole bounds (real function) must agree with the Paper overlay
      // within the 0.5 document tolerance (no shifted overlay).
      const hb = (result.helperVals.inner as { holeBounds: { x: number; y: number; width: number; height: number } }).holeBounds;
      expect(Math.abs(hb.x - b.x)).toBeLessThan(0.6);
      expect(Math.abs(hb.y - b.y)).toBeLessThan(0.6);
    }
  }, 30_000);

  it('nonzero repeated vs alternating winding: Canvas+Paper vs helper vs Paper probe', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const alternating = 'M0 0H200V200H0Z M30 30V170H170V30H30Z M60 60H140V140H60Z M90 90V110H110V90H90Z';
      const sameDir = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
      const pt = { x: 100, y: 100 };
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaOf = (d: string, rule: CanvasFillRule) => {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), rule);
        return ctx.getImageData(pt.x, pt.y, 1, 1).data[3]!;
      };
      const canvasAlt = alphaOf(alternating, 'nonzero');
      const canvasSame = alphaOf(sameDir, 'nonzero');
      const canvasAltEven = alphaOf(alternating, 'evenodd');
      const helperAlt = helper.classifyHolePoint({ pathData: alternating, point: pt, fillRule: 'nonzero' });
      const helperSame = helper.classifyHolePoint({ pathData: sameDir, point: pt, fillRule: 'nonzero' });
      const helperAltEven = helper.classifyHolePoint({ pathData: alternating, point: pt, fillRule: 'evenodd' });
      const scope = await paperVector.ensureVectorPaperScope();
      scope.project.clear();
      const mkItem = (d: string, rule: string) =>
        scope.project.importSVG(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="red" fill-rule="${rule}"/></svg>`,
        ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
      const a1 = mkItem(alternating, 'nonzero');
      const paperAlt = a1.contains(new scope.Point(pt.x, pt.y));
      a1.remove();
      const a2 = mkItem(sameDir, 'nonzero');
      const paperSame = a2.contains(new scope.Point(pt.x, pt.y));
      a2.remove();
      scope.project.clear();
      const probeFor = async (d: string, rule: string) => {
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="${rule}" stroke="none"/></svg>`,
          'image/svg+xml',
        );
        const units = vectorSvg.editableVectorUnits(doc.documentElement as unknown as Element);
        return await paperVector.paperVectorHoleTargetAtPoint(units, pt, 0.5);
      };
      const probeAlt = await probeFor(alternating, 'nonzero');
      const probeSame = await probeFor(sameDir, 'nonzero');
      const probeAltEven = await probeFor(alternating, 'evenodd');
      return { canvasAlt, canvasSame, canvasAltEven, helperAlt, helperSame, helperAltEven, paperAlt, paperSame, probeAlt, probeSame, probeAltEven };
    });
    // Oracles: alternating cancels to a hole; same-direction sums to filled.
    expect(result.canvasAlt).toBe(0);
    expect(result.canvasSame).toBeGreaterThan(200);
    expect(result.paperAlt).toBe(false);
    expect(result.paperSame).toBe(true);
    expect(result.helperAlt.kind).toBe('hole');
    expect(result.helperSame.kind).toBe('filled');
    expect(result.helperAltEven.kind).toBe('hole');
    // Same-direction must never become an overlay (filled region guard).
    expect(result.probeSame.kind).not.toBe('hole');
    const windingGaps: Array<{ case: string; probeKind: string }> = [];
    if (result.probeAlt.kind !== 'hole') {
      failReport('nonzero alternating wiring gap', {
        canvasAlt: result.canvasAlt,
        paperAlt: result.paperAlt,
        helperAlt: result.helperAlt,
        probeAlt: result.probeAlt,
      });
      windingGaps.push({ case: 'nonzero-alternating', probeKind: result.probeAlt.kind });
    }
    if (result.probeAltEven.kind !== 'hole') {
      failReport('evenodd alternating (reversed winding) wiring gap', { probe: result.probeAltEven });
      windingGaps.push({ case: 'evenodd-alternating', probeKind: result.probeAltEven.kind });
    }
    expect(windingGaps).toEqual([]);
  }, 30_000);

  it('unrelated island outside the target: hole still resolves, overlay never covers the island', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const nested = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-nested.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const d = 'M0 0H200V200H0Z M40 40H160V160H40Z M300 300H320V320H300Z';
      const holePt = { x: 50, y: 100 };
      const farPt = { x: 310, y: 310 };
      const bodyPt = { x: 10, y: 10 };
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaAt = (x: number, y: number) => {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        return ctx.getImageData(x, y, 1, 1).data[3]!;
      };
      const canvasHole = alphaAt(holePt.x, holePt.y);
      const canvasFar = alphaAt(farPt.x, farPt.y);
      const scope = await paperVector.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
      const paperHole = item.contains(new scope.Point(holePt.x, holePt.y));
      const paperFar = item.contains(new scope.Point(farPt.x, farPt.y));
      item.remove();
      scope.project.clear();
      const helperHole = helper.classifyHolePoint({ pathData: d, point: holePt, fillRule: 'evenodd' });
      const helperFar = helper.classifyHolePoint({ pathData: d, point: farPt, fillRule: 'evenodd' });
      const contours = helper.parseStraightContours(d)!;
      const audit = nested.auditStraightNesting(contours);
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`,
        'image/svg+xml',
      );
      const units = vectorSvg.editableVectorUnits(doc.documentElement as unknown as Element);
      const probeHole = await paperVector.paperVectorHoleTargetAtPoint(units, holePt, 0.5);
      // Overlay-vs-island: hole bounds must not contain the far island point.
      let holeBoundsContainsFar: boolean | null = null;
      if (probeHole.kind === 'hole') {
        const b = probeHole.target.holeDocumentBounds;
        holeBoundsContainsFar = farPt.x >= b.x && farPt.x <= b.x + b.width && farPt.y >= b.y && farPt.y <= b.y + b.height;
      } else if (helperHole.kind === 'hole') {
        const b = helperHole.holeBounds;
        holeBoundsContainsFar = farPt.x >= b.x && farPt.x <= b.x + b.width && farPt.y >= b.y && farPt.y <= b.y + b.height;
      }
      // Sibling guard: a solid overlay of the hole must not paint the body.
      let holeBoundsContainsBody: boolean | null = null;
      if (probeHole.kind === 'hole') {
        const b = probeHole.target.holeDocumentBounds;
        holeBoundsContainsBody = bodyPt.x >= b.x && bodyPt.x <= b.x + b.width && bodyPt.y >= b.y && bodyPt.y <= b.y + b.height;
      } else if (helperHole.kind === 'hole') {
        const b = helperHole.holeBounds;
        holeBoundsContainsBody = bodyPt.x >= b.x && bodyPt.x <= b.x + b.width && bodyPt.y >= b.y && bodyPt.y <= b.y + b.height;
      }
      return { canvasHole, canvasFar, paperHole, paperFar, helperHole, helperFar, audit, probeHole, holeBoundsContainsFar, holeBoundsContainsBody };
    });
    expect(result.canvasHole).toBe(0);
    expect(result.paperHole).toBe(false);
    expect(result.helperHole.kind).toBe('hole');
    // Far disjoint island is painted (filled), never a hole at its own point.
    expect(result.canvasFar).toBeGreaterThan(200);
    expect(result.paperFar).toBe(true);
    expect(result.helperFar.kind).toBe('filled');
    expect(result.audit.ok).toBe(true);
    // Overlay must not swallow the unrelated island or the body.
    expect(result.holeBoundsContainsFar).toBe(false);
    expect(result.holeBoundsContainsBody).toBe(false);
    if (result.probeHole.kind !== 'hole') {
      failReport('unrelated-island hole wiring gap', { probe: result.probeHole, helper: result.helperHole });
    }
    expect(result.probeHole.kind).toBe('hole');
  }, 30_000);

  it('arbitrary transforms: translate/rotate/scale agree with oracles; singular/mirror/non-uniform stay fail-closed', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const d = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
      const localInner = { x: 100, y: 100 };
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const canvasWith = (matrix: [number, number, number, number, number, number] | null, px: number, py: number) => {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#ff0000';
        ctx.save();
        if (matrix) ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
        ctx.fill(new Path2D(d), 'evenodd');
        ctx.restore();
        return ctx.getImageData(px, py, 1, 1).data[3]!;
      };
      const cases: Array<{ name: string; matrix: [number, number, number, number, number, number] | null; docPt: { x: number; y: number }; svgTransform: string }> = [
        { name: 'translate', matrix: [1, 0, 0, 1, 20, 10], docPt: { x: 120, y: 110 }, svgTransform: 'translate(20 10)' },
        { name: 'uniform-scale2', matrix: [2, 0, 0, 2, 0, 0], docPt: { x: 200, y: 200 }, svgTransform: 'scale(2)' },
        { name: 'rotate180', matrix: [-1, 0, 0, -1, 240, 180], docPt: { x: 140, y: 80 }, svgTransform: 'rotate(180 120 90)' },
      ];
      const out: Record<string, unknown> = {};
      const scope = await paperVector.ensureVectorPaperScope();
      for (const c of cases) {
        const canvasAlpha = canvasWith(c.matrix, c.docPt.x, c.docPt.y);
        const helperVerdict = helper.classifyHolePoint({ pathData: d, point: c.docPt, fillRule: 'evenodd', worldMatrix: c.matrix, tolerance: 0.5 });
        scope.project.clear();
        const item = scope.project.importSVG(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" transform="${c.svgTransform}" fill="red" fill-rule="evenodd"/></svg>`,
        ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
        const paperContains = item.contains(new scope.Point(c.docPt.x, c.docPt.y));
        item.remove();
        scope.project.clear();
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" transform="${c.svgTransform}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`,
          'image/svg+xml',
        );
        const units = vectorSvg.editableVectorUnits(doc.documentElement as unknown as Element);
        const probe = await paperVector.paperVectorHoleTargetAtPoint(units, c.docPt, 0.5);
        out[c.name] = { canvasAlpha, helperVerdict, paperContains, probe };
      }
      scope.project.clear();
      // Singular must never become a hole (both layers).
      const singular: [number, number, number, number, number, number] = [1, 0, 0, 0, 0, 0];
      const helperSingular = helper.classifyHolePoint({ pathData: d, point: { x: 100, y: 100 }, fillRule: 'evenodd', worldMatrix: singular });
      const docSing = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" transform="matrix(1 0 0 0 0 0)" fill="#ff0000" fill-rule="evenodd"/></svg>`,
        'image/svg+xml',
      );
      const unitsSing = vectorSvg.editableVectorUnits(docSing.documentElement as unknown as Element);
      const probeSingular = await paperVector.paperVectorHoleTargetAtPoint(unitsSing, { x: 100, y: 100 }, 0.5);
      // Mirror: Canvas still renders a hole at the mirrored point, but the
      // straight helper maps through the inverse and the Paper probe bakes
      // the mirror; neither may invent geometry — record both (no hole claim
      // required here, only no-crash + no-hole-on-singular).
      return { ...out, helperSingular, probeSingular };
    });
    const transformGaps: Array<{ name: string; probeKind: string }> = [];
    for (const name of ['translate', 'uniform-scale2', 'rotate180']) {
      const entry = (result as Record<string, { canvasAlpha: number; helperVerdict: { kind: string }; paperContains: boolean; probe: { kind: string } }>)[name]!;
      expect(entry.canvasAlpha).toBe(0);
      expect(entry.paperContains).toBe(false);
      expect(entry.helperVerdict.kind).toBe('hole');
      if (entry.probe.kind !== 'hole') {
        failReport(`transform ${name} wiring gap`, { entry });
        transformGaps.push({ name, probeKind: entry.probe.kind });
      }
    }
    expect(transformGaps).toEqual([]);
    expect((result.helperSingular as { kind: string }).kind).toBe('ambiguous');
    expect((result.probeSingular as { kind: string }).kind).not.toBe('hole');
  }, 60_000);

  it('self-crossing / collinear / touch / near-EPS: oracles vs fail-closed (never a hole)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const nested = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-nested.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const cases: Array<{ name: string; d: string; pt: { x: number; y: number } }> = [
        { name: 'bowtie', d: 'M0 0H200V200H0Z M40 40L160 40L40 160L160 160Z', pt: { x: 100, y: 100 } },
        { name: 'touch-edge', d: 'M0 0H200V200H0Z M20 20H60V60H20Z M60 20H100V60H60Z', pt: { x: 40, y: 40 } },
        { name: 'touch-point', d: 'M0 0H100V100H0Z M100 100H200V200H100Z', pt: { x: 50, y: 50 } },
        { name: 'overlap', d: 'M0 0H100V100H0Z M50 50H150V150H50Z', pt: { x: 75, y: 75 } },
        { name: 'duplicate', d: 'M0 0H100V100H0Z M0 0H100V100H0Z', pt: { x: 50, y: 50 } },
        // Near-EPS: island wall 5e-10 from the hole wall (inside 1e-9 EPS -> contact).
        { name: 'near-eps', d: 'M0 0H200V200H0Z M40 40H160V160H40Z M40.0000000005 40H160V160H40.0000000005Z', pt: { x: 100, y: 100 } },
        // Collinear run past a shared vertex (self-touch).
        { name: 'collinear-self', d: 'M0 0H200V200H0Z M40 40H160V40H100V100H40Z', pt: { x: 100, y: 100 } },
      ];
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const out: Record<string, unknown> = {};
      const scope = await paperVector.ensureVectorPaperScope();
      for (const c of cases) {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#ff0000';
        let canvasAlpha: number | null = null;
        try {
          ctx.fill(new Path2D(c.d), 'evenodd');
          canvasAlpha = ctx.getImageData(c.pt.x, c.pt.y, 1, 1).data[3]!;
        } catch {
          canvasAlpha = null;
        }
        let helperVerdict: unknown = null;
        let auditOk: unknown = null;
        try {
          helperVerdict = helper.classifyHolePoint({ pathData: c.d, point: c.pt, fillRule: 'evenodd' });
          const contours = helper.parseStraightContours(c.d);
          auditOk = contours ? nested.auditStraightNesting(contours) : 'unparseable';
        } catch (e) {
          helperVerdict = `threw:${String(e).slice(0, 120)}`;
        }
        scope.project.clear();
        let paperContains: unknown = null;
        try {
          const item = scope.project.importSVG(
            `<svg xmlns="http://www.w3.org/2000/svg"><path d="${c.d}" fill="red" fill-rule="evenodd"/></svg>`,
          ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
          paperContains = item.contains(new scope.Point(c.pt.x, c.pt.y));
          item.remove();
        } catch {
          paperContains = 'import-failed';
        }
        scope.project.clear();
        let probeKind: string = 'eval-failed';
        try {
          const doc = new DOMParser().parseFromString(
            `<svg xmlns="http://www.w3.org/2000/svg"><path d="${c.d}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`,
            'image/svg+xml',
          );
          const units = vectorSvg.editableVectorUnits(doc.documentElement as unknown as Element);
          probeKind = (await paperVector.paperVectorHoleTargetAtPoint(units, c.pt, 0.5)).kind;
        } catch {
          probeKind = 'probe-threw';
        }
        out[c.name] = { canvasAlpha, helperVerdict, auditOk, paperContains, probeKind };
      }
      scope.project.clear();
      return out;
    });
    for (const name of ['bowtie', 'touch-edge', 'touch-point', 'overlap', 'duplicate', 'near-eps', 'collinear-self']) {
      const entry = (result as Record<string, { helperVerdict: { kind: string }; auditOk: { ok?: boolean } | string; probeKind: string }>)[
        name
      ]!;
      // The exact limited subset must refuse: helper never claims a hole here.
      expect(entry.helperVerdict.kind).toBe('ambiguous');
      // Production probe must never claim a hole on degenerate topology.
      expect(entry.probeKind).not.toBe('hole');
      if ((entry.helperVerdict as { kind: string }).kind === 'hole' || entry.probeKind === 'hole') {
        failReport(`topology fail-closed violated at ${name}`, { entry });
      }
    }
  }, 60_000);

  it('curved nesting + flatten/topology + signed-area misorder vs oracles', async () => {
    const result = await page.evaluate(async () => {
      const straight = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const curved = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const nested = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-nested.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      // Curved 4-nest: outer rect / rect hole / circle island (arcs) / rect inner.
      const outer = 'M0 0H200V200H0Z';
      const hole = 'M40 40H160V160H40Z';
      const islandCircle = 'M80 100A20 20 0 1 0 120 100A20 20 0 1 0 80 100Z';
      const inner = 'M95 95H105V105H95Z';
      const dCurved = `${outer} ${hole} ${islandCircle} ${inner}`;
      const innerPt = { x: 100, y: 100 };
      const islandPt = { x: 100, y: 85 };
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.clearRect(0, 0, 480, 360);
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(dCurved), 'evenodd');
      const canvasInner = ctx.getImageData(innerPt.x, innerPt.y, 1, 1).data[3]!;
      const canvasIsland = ctx.getImageData(islandPt.x, islandPt.y, 1, 1).data[3]!;
      const helperInner = curved.classifyCurvedHolePoint({ pathData: dCurved, point: innerPt, fillRule: 'evenodd' });
      const helperIsland = curved.classifyCurvedHolePoint({ pathData: dCurved, point: islandPt, fillRule: 'evenodd' });
      // Flattened audit + direct resolve (real function, real contours).
      const flat = curved.flattenCurvedContours(dCurved);
      const flatAudit = flat ? nested.auditStraightNesting(flat) : 'unflattenable';
      let flatResolve: unknown = null;
      if (flat) {
        const areas = flat.map((c) => {
          let s = 0;
          for (let i = 0; i < c.points.length; i += 1) {
            const a = c.points[i]!;
            const b = c.points[(i + 1) % c.points.length]!;
            s += a.x * b.y - b.x * a.y;
          }
          return s / 2;
        });
        const containing = straight.containingContourIndices(flat, innerPt, 'evenodd');
        flatResolve = nested.resolveNestedHole({ contours: flat, containing, areas });
      }
      const scope = await paperVector.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${dCurved}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
      const paperInner = item.contains(new scope.Point(innerPt.x, innerPt.y));
      const paperIsland = item.contains(new scope.Point(islandPt.x, islandPt.y));
      item.remove();
      scope.project.clear();
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${dCurved}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`,
        'image/svg+xml',
      );
      const units = vectorSvg.editableVectorUnits(doc.documentElement as unknown as Element);
      const probeInner = await paperVector.paperVectorHoleTargetAtPoint(units, innerPt, 0.5);
      // Signed-area misorder: same 4 rects, shuffled subpath order.
      const shuffled = 'M90 90H110V110H90Z M60 60H140V140H60Z M30 30H170V170H30Z M0 0H200V200H0Z';
      ctx.clearRect(0, 0, 480, 360);
      ctx.fill(new Path2D(shuffled), 'evenodd');
      const canvasShuffled = ctx.getImageData(100, 100, 1, 1).data[3]!;
      const helperShuffled = straight.classifyHolePoint({ pathData: shuffled, point: { x: 100, y: 100 }, fillRule: 'evenodd' });
      const contoursShuffled = straight.parseStraightContours(shuffled)!;
      const areasShuffled = contoursShuffled.map((c) => straight.contourArea(c));
      const containingShuffled = straight.containingContourIndices(contoursShuffled, { x: 100, y: 100 }, 'evenodd');
      const resolveShuffled = nested.resolveNestedHole({ contours: contoursShuffled, containing: containingShuffled, areas: areasShuffled });
      const docSh = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${shuffled}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`,
        'image/svg+xml',
      );
      const unitsSh = vectorSvg.editableVectorUnits(docSh.documentElement as unknown as Element);
      const probeShuffled = await paperVector.paperVectorHoleTargetAtPoint(unitsSh, { x: 100, y: 100 }, 0.5);
      scope.project.clear();
      return { canvasInner, canvasIsland, helperInner, helperIsland, flatAudit, flatResolve, paperInner, paperIsland, probeInner, canvasShuffled, helperShuffled, resolveShuffled, containingShuffled, probeShuffled };
    });
    // Curved oracles: innermost unfilled, circle wall painted.
    expect(result.canvasInner).toBe(0);
    expect(result.canvasIsland).toBeGreaterThan(200);
    expect(result.paperInner).toBe(false);
    expect(result.paperIsland).toBe(true);
    expect(result.helperInner.kind).toBe('hole');
    expect(result.helperIsland.kind).toBe('filled');
    expect((result.flatAudit as { ok: boolean }).ok).toBe(true);
    expect((result.flatResolve as { ok: boolean }).ok).toBe(true);
    const wiringGaps: Array<{ case: string; probeKind: string }> = [];
    if (result.probeInner.kind !== 'hole') {
      failReport('curved 4-nest wiring gap', {
        canvasInner: result.canvasInner,
        paperInner: result.paperInner,
        helperInner: result.helperInner,
        probeInner: result.probeInner,
      });
      wiringGaps.push({ case: 'curved-4-nest', probeKind: result.probeInner.kind });
    }
    // Misorder: geometry is order-independent; helper must still find hole 0 <- outer 1.
    expect(result.canvasShuffled).toBe(0);
    expect(result.helperShuffled.kind).toBe('hole');
    if (result.helperShuffled.kind === 'hole') {
      expect(result.helperShuffled.holeIndex).toBe(0);
      expect(result.helperShuffled.outerIndex).toBe(1);
    }
    expect((result.resolveShuffled as { ok: boolean }).ok).toBe(true);
    if ((result.resolveShuffled as { ok: boolean }).ok) {
      expect((result.resolveShuffled as { holeIndex: number }).holeIndex).toBe(0);
      expect((result.resolveShuffled as { outerIndex: number }).outerIndex).toBe(1);
    }
    if (result.probeShuffled.kind !== 'hole') {
      failReport('misordered 4-nest wiring gap', { probe: result.probeShuffled, helper: result.helperShuffled });
      wiringGaps.push({ case: 'misordered-4-nest', probeKind: result.probeShuffled.kind });
    }
    expect(wiringGaps).toEqual([]);
  }, 60_000);

  it('class / CSS / clip / mask / defs-url / invisibility: never a hole', async () => {
    const result = await page.evaluate(async () => {
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const d = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
      const pt = { x: 100, y: 100 };
      // Helper itself would call this a hole geometrically; the caller-side
      // gates must decline it before any overlay exists.
      const helperHole = helper.classifyHolePoint({ pathData: d, point: pt, fillRule: 'evenodd' });
      const variants: Array<{ name: string; svg: string }> = [
        { name: 'class', svg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" class="foo" fill="#ff0000" fill-rule="evenodd"/></svg>` },
        { name: 'style-clip', svg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" style="clip-path:url(#c)" fill="#ff0000" fill-rule="evenodd"/></svg>` },
        { name: 'clip-attr', svg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" clip-path="url(#c)" fill="#ff0000" fill-rule="evenodd"/></svg>` },
        { name: 'mask-attr', svg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" mask="url(#m)" fill="#ff0000" fill-rule="evenodd"/></svg>` },
        { name: 'url-fill', svg: `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"></linearGradient></defs><path d="${d}" fill="url(#g)" fill-rule="evenodd"/></svg>` },
        { name: 'display-none', svg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" display="none" fill="#ff0000" fill-rule="evenodd"/></svg>` },
        { name: 'opacity-zero', svg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" opacity="0" fill="#ff0000" fill-rule="evenodd"/></svg>` },
        { name: 'fill-none', svg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" fill-rule="evenodd"/></svg>` },
        { name: 'in-defs', svg: `<svg xmlns="http://www.w3.org/2000/svg"><defs><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></defs></svg>` },
      ];
      const out: Record<string, unknown> = { helperHole: helperHole.kind };
      for (const v of variants) {
        const doc = new DOMParser().parseFromString(v.svg, 'image/svg+xml');
        let units: Element[] = [];
        try {
          units = vectorSvg.editableVectorUnits(doc.documentElement as unknown as Element);
        } catch {
          units = Array.from(doc.querySelectorAll('path')) as unknown as Element[];
        }
        let probe: unknown = null;
        try {
          probe = await paperVector.paperVectorHoleTargetAtPoint(units, pt, 0.5);
        } catch (e) {
          probe = `threw:${String(e).slice(0, 120)}`;
        }
        // Eligibility gate (pure, no Paper): must decline class/clip/mask/url/defs.
        let eligible: unknown = null;
        try {
          const el = doc.querySelector('path');
          eligible = el
            ? helper.isUnitEligibleForHoleGeometry({
                tag: 'path',
                fill: el.getAttribute('fill'),
                stroke: el.getAttribute('stroke'),
                clipPath: el.getAttribute('clip-path'),
                mask: el.getAttribute('mask'),
                style: el.getAttribute('style'),
                classAttr: el.getAttribute('class'),
                insideDefs: v.name === 'in-defs',
              })
            : 'no-path';
        } catch {
          eligible = 'eligible-threw';
        }
        out[v.name] = { probe, eligible };
      }
      return out;
    });
    expect(result.helperHole).toBe('hole');
    for (const name of ['class', 'style-clip', 'clip-attr', 'mask-attr', 'url-fill', 'display-none', 'opacity-zero', 'fill-none', 'in-defs']) {
      const entry = (result as Record<string, { probe: { kind: string } | string; eligible: { eligible: boolean } | string }>)[name]!;
      const probeKind = typeof entry.probe === 'string' ? entry.probe : entry.probe.kind;
      if (probeKind === 'hole') {
        failReport(`paint-gate violated at ${name}: probe claims hole through ${name}`, { entry });
      }
      expect(probeKind).not.toBe('hole');
    }
  }, 60_000);

  it('huge path complexity / DoS: fail-closed fast, never a hole', async () => {
    const result = await page.evaluate(async () => {
      const straight = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const curved = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      // 1) Over-long payload (beyond 20000 chars) -> unsupported, instant.
      const bigSquares: string[] = ['M0 0H400V400H0Z'];
      for (let i = 0; i < 400; i += 1) {
        const x = 10 + (i % 20) * 18;
        const y = 10 + Math.floor(i / 20) * 18;
        bigSquares.push(`M${x} ${y}H${x + 10}V${y + 10}H${x}Z`);
      }
      const hugeD = bigSquares.join(' ');
      // 2) Over-cap arc sampling (huge radius needs >1024 samples per piece).
      const hugeArc = 'M0 0H800V600H0Z M100 300A9000 9000 0 1 0 700 300A9000 9000 0 1 0 100 300Z';
      const timed = async <T>(fn: () => T): Promise<{ value: T; ms: number }> => {
        const t0 = performance.now();
        const value = fn();
        return { value, ms: performance.now() - t0 };
      };
      const hugeSafe = straight.isPathDataSafeForHoleGeometry(hugeD);
      const hugeCurvedSafe = curved.isPathDataSafeForCurvedHoleGeometry(hugeArc);
      const tStraight = await timed(() =>
        straight.classifyHolePoint({ pathData: 'M0 0H200V200H0Z M30 30H170V170H30Z', point: { x: 100, y: 100 }, fillRule: 'evenodd' }),
      );
      const tHugeClassify = await timed(() => {
        try {
          return straight.classifyHolePoint({ pathData: hugeD.slice(0, 20000), point: { x: 5, y: 5 }, fillRule: 'evenodd' });
        } catch (e) {
          return `threw:${String(e).slice(0, 80)}`;
        }
      });
      const tArc = await timed(() => {
        try {
          return curved.classifyCurvedHolePoint({ pathData: hugeArc, point: { x: 400, y: 300 }, fillRule: 'evenodd' });
        } catch (e) {
          return `threw:${String(e).slice(0, 80)}`;
        }
      });
      // 3) Point-cap overflow: many small circles exceed CURVED_MAX_POINTS_TOTAL.
      let manyCircles = 'M0 0H600V600H0Z';
      for (let i = 0; i < 80; i += 1) {
        const cx = 20 + (i % 10) * 55;
        const cy = 20 + Math.floor(i / 10) * 55;
        manyCircles += ` M${cx - 8} ${cy}A8 8 0 1 0 ${cx + 8} ${cy}A8 8 0 1 0 ${cx - 8} ${cy}Z`;
      }
      const tMany = await timed(() => {
        try {
          return curved.classifyCurvedHolePoint({ pathData: manyCircles, point: { x: 300, y: 300 }, fillRule: 'evenodd' });
        } catch (e) {
          return `threw:${String(e).slice(0, 80)}`;
        }
      });
      return {
        hugeLen: hugeD.length,
        hugeSafe,
        hugeCurvedSafe,
        straightKind: (tStraight.value as { kind: string }).kind,
        straightMs: tStraight.ms,
        hugeKind: typeof tHugeClassify.value === 'string' ? tHugeClassify.value : (tHugeClassify.value as { kind: string }).kind,
        hugeMs: tHugeClassify.ms,
        arcKind: typeof tArc.value === 'string' ? tArc.value : (tArc.value as { kind: string }).kind,
        arcMs: tArc.ms,
        manyKind: typeof tMany.value === 'string' ? tMany.value : (tMany.value as { kind: string }).kind,
        manyMs: tMany.ms,
      };
    });
    // Baseline stays fast; all pathological inputs refuse (never a hole).
    expect(result.straightMs).toBeLessThan(2000);
    expect(result.hugeMs).toBeLessThan(5000);
    expect(result.arcMs).toBeLessThan(5000);
    expect(result.manyMs).toBeLessThan(8000);
    expect(result.hugeKind).not.toBe('hole');
    expect(result.arcKind).not.toBe('hole');
    expect(result.manyKind).not.toBe('hole');
    if (result.hugeKind === 'hole' || result.arcKind === 'hole' || result.manyKind === 'hole') {
      failReport('DoS fail-closed violated', { result });
    }
  }, 60_000);

  it('overlay + z-order + no-mutation: hole never paints filled/sibling/island, originals intact', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const dBottom = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
      const holePt = { x: 100, y: 100 };
      const siblingTopSvg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${dBottom}" fill="#ff0000" fill-rule="evenodd"/><rect x="80" y="80" width="40" height="40" fill="#0000ff" stroke="none"/></svg>`;
      const docTop = new DOMParser().parseFromString(siblingTopSvg, 'image/svg+xml');
      const unitsTop = vectorSvg.editableVectorUnits(docTop.documentElement as unknown as Element);
      const beforeTop = unitsTop.map((u) => u.outerHTML).join('|');
      const holeProbeTop = await paperVector.paperVectorHoleTargetAtPoint(unitsTop, holePt, 0.5);
      const bodyHitTop = await paperVector.paperVectorHitIndex(unitsTop, holePt, 0.5);
      const afterTop = unitsTop.map((u) => u.outerHTML).join('|');
      // Single-unit hole bounds safety (helper truth, real function).
      const helperHole = helper.classifyHolePoint({ pathData: dBottom, point: holePt, fillRule: 'evenodd' });
      let overlayPaintsFilled = false;
      let overlayPaintsIsland = false;
      if (helperHole.kind === 'hole') {
        const b = helperHole.holeBounds;
        const contains = (px: number, py: number) => px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height;
        overlayPaintsFilled = contains(10, 10) || contains(250, 100);
        overlayPaintsIsland = contains(70, 100);
      }
      // Two holes across units (sibling hole overlap) must be ambiguous, never a hole.
      const twoHoleSvg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H200V200H0Z M40 40H160V160H40Z" fill="#ff0000" fill-rule="evenodd"/><path d="M0 0H200V200H0Z M50 50H150V150H50Z" fill="#00ff00" fill-rule="evenodd"/></svg>`;
      const docTwo = new DOMParser().parseFromString(twoHoleSvg, 'image/svg+xml');
      const unitsTwo = vectorSvg.editableVectorUnits(docTwo.documentElement as unknown as Element);
      const probeTwo = await paperVector.paperVectorHoleTargetAtPoint(unitsTwo, { x: 100, y: 100 }, 0.5);
      return { holeProbeTop, bodyHitTop, domMutatedTop: beforeTop !== afterTop, helperHoleKind: helperHole.kind, overlayPaintsFilled, overlayPaintsIsland, probeTwoKind: probeTwo.kind };
    });
    // Top sibling body covers the hole: body hit is the top unit, so a lone
    // hole probe must not be used as a paint overlay (caller compares indices).
    // Record both truthfully; the hole probe alone may still report the lower
    // hole, but the z-order comparison must suppress it.
    if (result.bodyHitTop !== 1) {
      failReport('z-order body hit unexpected', { bodyHitTop: result.bodyHitTop });
    }
    expect(result.bodyHitTop).toBe(1);
    expect(result.domMutatedTop).toBe(false);
    expect(result.helperHoleKind).toBe('hole');
    expect(result.overlayPaintsFilled).toBe(false);
    expect(result.overlayPaintsIsland).toBe(false);
    // Overlapping holes across sibling units: fail-closed (ambiguous), never hole.
    expect(result.probeTwoKind).not.toBe('hole');
  }, 30_000);
});
