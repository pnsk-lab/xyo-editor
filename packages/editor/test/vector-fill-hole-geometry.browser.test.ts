import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Pixel-oracle comparison for the independent hole-geometry helper
// (`vector-fill-hole-geometry.ts`, new files only; existing Editor /
// BitmapEditor / paper-vector untouched).
//
// Oracles (all real, in a real browser):
// - Canvas 2D: `Path2D(d)` filled with `evenodd`/`nonzero`, alpha read via
//   `getImageData` (the rendered-truth pixel).
// - Paper.js entity: the real `paper` project import + `contains` / `hitTest`
//   for the same SVG (the vector-model truth).
// - Helper: pure `classifyHolePoint` verdicts (the candidate under test).
//
// Interior points (>= tolerance away from edges) must agree across all three;
// edge-adjacent pixels may disagree via anti-aliasing and must be refused by
// the helper (`ambiguous`). Z-order, clip/mask, defs `url(#...)`, curves, and
// singular transforms are enumerated as unsupported (fail-closed, no guessing).

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4329';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('hole geometry pixel oracle (Canvas + Paper vs helper)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4329', '--strictPort'], {
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
    if (!ready) throw new Error('Vite failed to start');
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  it('donut interiors agree across Canvas, Paper, and helper (evenodd)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M150 90H330V270H150Z M210 150H270V210H210Z';
      // Canvas oracle.
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const path = new Path2D(d);
      ctx.fillStyle = '#ff0000';
      ctx.fill(path, 'evenodd');
      const alphaAt = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3]!;
      const canvasBody = alphaAt(160, 100);
      const canvasHole = alphaAt(240, 180);
      const canvasOutside = alphaAt(10, 10);
      // Helper verdicts.
      const helperBody = helper.classifyHolePoint({ pathData: d, point: { x: 160, y: 100 }, fillRule: 'evenodd' });
      const helperHole = helper.classifyHolePoint({ pathData: d, point: { x: 240, y: 180 }, fillRule: 'evenodd' });
      const helperOutside = helper.classifyHolePoint({ pathData: d, point: { x: 10, y: 10 }, fillRule: 'evenodd' });
      // Paper entity.
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><path d="${d}" fill="red" fill-rule="evenodd"/></svg>`;
      const item = scope.project.importSVG(svg) as unknown as {
        contains: (point: unknown) => boolean;
        hitTest: (point: unknown, options?: unknown) => unknown;
        remove: () => void;
      };
      const paperBody = item.contains(new scope.Point(160, 100));
      const paperHole = item.contains(new scope.Point(240, 180));
      const paperBodyHit = Boolean(item.hitTest(new scope.Point(160, 100), { fill: true, stroke: true, tolerance: 0.5 }));
      const paperHoleHit = Boolean(item.hitTest(new scope.Point(240, 180), { fill: true, stroke: true, tolerance: 0.5 }));
      item.remove();
      scope.project.clear();
      return { canvasBody, canvasHole, canvasOutside, helperBody, helperHole, helperOutside, paperBody, paperHole, paperBodyHit, paperHoleHit };
    });
    // Canvas truth: body opaque, hole + outside transparent.
    expect(result.canvasBody).toBeGreaterThan(200);
    expect(result.canvasHole).toBe(0);
    expect(result.canvasOutside).toBe(0);
    // Paper truth matches Canvas for interiors.
    expect(result.paperBody).toBe(true);
    expect(result.paperHole).toBe(false);
    expect(result.paperBodyHit).toBe(true);
    expect(result.paperHoleHit).toBe(false);
    // Helper matches both oracles.
    expect(result.helperBody.kind).toBe('filled');
    expect(result.helperHole.kind).toBe('hole');
    expect(result.helperOutside.kind).toBe('outside');
  }, 30_000);

  it('multi-hole + relative-m + island interiors agree; edge pixels are refused', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const absolute = 'M100 100H400V300H100Z M140 140H200V200H140Z M280 140H340V200H280Z';
      // Relative-m twin of the first hole: cursor after `Z` is the moveto
      // (100,100), so `m40 40` restarts at (140,140) = same geometry.
      const relative = 'M100 100H400V300H100Z m40 40H200V200H140Z M280 140H340V200H280Z';
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaOf = (d: string, x: number, y: number) => {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        return ctx.getImageData(x, y, 1, 1).data[3]!;
      };
      const points = { holeA: [170, 170], holeB: [310, 170], body: [240, 250], edge: [100, 150] } as const;
      const canvasAbs = {
        holeA: alphaOf(absolute, points.holeA[0], points.holeA[1]),
        holeB: alphaOf(absolute, points.holeB[0], points.holeB[1]),
        body: alphaOf(absolute, points.body[0], points.body[1]),
      };
      const canvasRel = {
        holeA: alphaOf(relative, points.holeA[0], points.holeA[1]),
        holeB: alphaOf(relative, points.holeB[0], points.holeB[1]),
        body: alphaOf(relative, points.body[0], points.body[1]),
      };
      const helperAbsA = helper.classifyHolePoint({ pathData: absolute, point: { x: points.holeA[0], y: points.holeA[1] }, fillRule: 'evenodd' });
      const helperAbsB = helper.classifyHolePoint({ pathData: absolute, point: { x: points.holeB[0], y: points.holeB[1] }, fillRule: 'evenodd' });
      const helperRelA = helper.classifyHolePoint({ pathData: relative, point: { x: points.holeA[0], y: points.holeA[1] }, fillRule: 'evenodd' });
      const helperRelB = helper.classifyHolePoint({ pathData: relative, point: { x: points.holeB[0], y: points.holeB[1] }, fillRule: 'evenodd' });
      const helperBody = helper.classifyHolePoint({ pathData: absolute, point: { x: points.body[0], y: points.body[1] }, fillRule: 'evenodd' });
      const helperEdge = helper.classifyHolePoint({ pathData: absolute, point: { x: points.edge[0], y: points.edge[1] }, fillRule: 'evenodd', tolerance: 2 });
      // Island fixture: separate filled island outside the donut.
      const islandD = 'M100 100H220V220H100Z M130 130H160V160H130Z M300 240H360V300H300Z';
      const islandCanvas = alphaOf(islandD, 330, 270);
      const islandHelper = helper.classifyHolePoint({ pathData: islandD, point: { x: 330, y: 270 }, fillRule: 'evenodd' });
      const islandHoleHelper = helper.classifyHolePoint({ pathData: islandD, point: { x: 145, y: 145 }, fillRule: 'evenodd' });
      // Paper entity for the absolute fixture.
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><path d="${absolute}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (point: unknown) => boolean; remove: () => void };
      const paperHoleA = item.contains(new scope.Point(points.holeA[0], points.holeA[1]));
      const paperHoleB = item.contains(new scope.Point(points.holeB[0], points.holeB[1]));
      const paperBody = item.contains(new scope.Point(points.body[0], points.body[1]));
      item.remove();
      scope.project.clear();
      return { canvasAbs, canvasRel, helperAbsA, helperAbsB, helperRelA, helperRelB, helperBody, helperEdge, islandCanvas, islandHelper, islandHoleHelper, paperHoleA, paperHoleB, paperBody };
    });
    // Both holes transparent on Canvas under absolute and relative-m data.
    expect(result.canvasAbs.holeA).toBe(0);
    expect(result.canvasAbs.holeB).toBe(0);
    expect(result.canvasRel.holeA).toBe(0);
    expect(result.canvasRel.holeB).toBe(0);
    expect(result.canvasAbs.body).toBeGreaterThan(200);
    // Paper agrees on interiors.
    expect(result.paperHoleA).toBe(false);
    expect(result.paperHoleB).toBe(false);
    expect(result.paperBody).toBe(true);
    // Helper resolves each hole independently, relative-m included.
    expect(result.helperAbsA.kind).toBe('hole');
    expect(result.helperAbsB.kind).toBe('hole');
    expect(result.helperRelA.kind).toBe('hole');
    expect(result.helperRelB.kind).toBe('hole');
    if (result.helperAbsA.kind === 'hole' && result.helperAbsB.kind === 'hole') {
      expect(result.helperAbsA.holeIndex).toBe(1);
      expect(result.helperAbsB.holeIndex).toBe(2);
    }
    expect(result.helperBody.kind).toBe('filled');
    // Separate island: painted on Canvas, filled for the helper.
    expect(result.islandCanvas).toBeGreaterThan(200);
    expect(result.islandHelper.kind).toBe('filled');
    expect(result.islandHoleHelper.kind).toBe('hole');
    // Edge-adjacent sample is refused (anti-alias zone), never a hole claim.
    expect(result.helperEdge.kind).toBe('ambiguous');
  }, 30_000);

  it('ancestor transforms agree with translated Canvas pixels; singular refuses', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const d = 'M150 90H330V270H150Z M210 150H270V210H210Z';
      const world = helper.composeHoleMatrices('translate(20 10)', '')!;
      // Canvas oracle draws the translated shape.
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.save();
      ctx.translate(20, 10);
      ctx.fill(new Path2D(d), 'evenodd');
      ctx.restore();
      const translatedHole = ctx.getImageData(260, 190, 1, 1).data[3]!;
      const translatedBody = ctx.getImageData(180, 110, 1, 1).data[3]!;
      const helperHole = helper.classifyHolePoint({ pathData: d, point: { x: 260, y: 190 }, fillRule: 'evenodd', worldMatrix: world });
      const helperBody = helper.classifyHolePoint({ pathData: d, point: { x: 180, y: 110 }, fillRule: 'evenodd', worldMatrix: world });
      const singular = helper.classifyHolePoint({
        pathData: d,
        point: { x: 260, y: 190 },
        fillRule: 'evenodd',
        worldMatrix: helper.parseSvgTransformList('scale(0 1)') ?? null,
      });
      return { translatedHole, translatedBody, helperHole, helperBody, singular };
    });
    expect(result.translatedHole).toBe(0);
    expect(result.translatedBody).toBeGreaterThan(200);
    expect(result.helperHole.kind).toBe('hole');
    expect(result.helperBody.kind).toBe('filled');
    // Singular ancestor transform never falls back to identity: fail-closed.
    expect(result.singular.kind).toBe('ambiguous');
  }, 30_000);

  it('nonzero winding agrees with Canvas; overlaps stay fail-closed and unsupported cases are enumerated', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const sanitize = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts');
      // Opposite-direction inner cancels the outer under nonzero.
      const d = 'M100 100H300V300H100Z M100 300H300V100H100Z';
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'nonzero');
      const centerAlpha = ctx.getImageData(200, 200, 1, 1).data[3]!;
      const helperVerdict = helper.classifyHolePoint({ pathData: d, point: { x: 200, y: 200 }, fillRule: 'nonzero' });
      // Overlapping contours: renderer-dependent, helper must refuse.
      const overlapD = 'M0 0H100V100H0Z M50 50H150V150H50Z';
      const overlapVerdict = helper.classifyHolePoint({ pathData: overlapD, point: { x: 75, y: 75 }, fillRule: 'evenodd' });
      // Curves route to the Paper probe, never guessed here.
      const curveVerdict = helper.classifyHolePoint({
        pathData: 'M100 100C150 100 150 200 100 200Z M120 130H140V170H120Z',
        point: { x: 130, y: 150 },
      });
      // Sanitizer still strips scripts before any Paper import.
      const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0H10V10H0Z"/></svg>';
      const clean = sanitize.sanitizeSvgForPaperImport(dirty);
      return {
        centerAlpha,
        helperVerdict,
        overlapVerdict,
        curveVerdict,
        scriptStripped: !clean.includes('<script'),
        unsupported: helper.HOLE_GEOMETRY_UNSUPPORTED_CASES,
        clipDeclined: helper.isUnitEligibleForHoleGeometry({ tag: 'path', clipPath: 'url(#c)' }),
      };
    });
    // Nonzero cancellation renders unfilled on Canvas; the helper reports the
    // same unfilled interior (outside-style, not a hole claim).
    expect(result.centerAlpha).toBe(0);
    expect(['outside', 'ambiguous']).toContain(result.helperVerdict.kind);
    // Overlap is fail-closed, curves are unsupported, sanitizer holds.
    expect(result.overlapVerdict.kind).toBe('ambiguous');
    expect(result.curveVerdict.kind).toBe('unsupported');
    expect(result.scriptStripped).toBe(true);
    expect(result.clipDeclined.eligible).toBe(false);
    // Unsupported enumeration is the honest status surface (Z-order owned by
    // the caller iterating units top-down; defs/clip/nested-group/curves and
    // the anti-alias zone are never guessed).
    expect(result.unsupported.length).toBeGreaterThanOrEqual(8);
    expect(result.unsupported.join('\n')).toContain('Z-order');
  }, 30_000);
});
