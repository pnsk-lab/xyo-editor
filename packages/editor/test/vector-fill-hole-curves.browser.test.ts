import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Pixel-oracle comparison for the curved hole-geometry prototype
// (`vector-fill-hole-curves.ts`, new files only; existing Editor /
// BitmapEditor / paper-vector untouched).
//
// Oracles (all real, in a real browser):
// - Canvas 2D: `Path2D(d)` filled with `evenodd`/`nonzero`, alpha via
//   `getImageData` (the rendered-truth pixel).
// - Paper.js entity: the real `paper` project import + `contains`
//   for the same SVG (the vector-model truth).
// - Helper: pure `classifyCurvedHolePoint` verdicts (candidate under test).
//
// Interior points (>= tolerance + flatten margin away from edges) must agree
// across all three; curve perimeters / contour bands / near touches may
// disagree via anti-aliasing + flattening and must be refused (`ambiguous`).
// Mirror / skew / non-uniform / singular / complex-overlap cases must refuse
// even when the oracles render a hole — safe fail, never a hole claim.

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4331';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('curved hole pixel oracle (Canvas + Paper vs helper)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4331', '--strictPort'], {
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

  it('curved double-hole interiors agree across Canvas, Paper, and helper (evenodd)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      // Two ellipse holes via arcs (Paper CompoundPath agrees with Canvas here;
      // 2-segment cubic "lens" holes diverge in Paper and are covered as a
      // safe-fail case below, so the agreement fixture uses arcs).
      const d = 'M0 0H300V200H0Z M30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z M170 40A20 15 0 1 0 210 40A20 15 0 1 0 170 40Z';
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'evenodd');
      const alphaAt = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3]!;
      const canvasHoleA = alphaAt(50, 40);
      const canvasHoleB = alphaAt(190, 40);
      const canvasBody = alphaAt(150, 150);
      const canvasOutside = alphaAt(350, 250);
      const helperHoleA = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 50, y: 40 }, fillRule: 'evenodd' });
      const helperHoleB = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 190, y: 40 }, fillRule: 'evenodd' });
      const helperBody = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 150, y: 150 }, fillRule: 'evenodd' });
      const helperOutside = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 350, y: 250 }, fillRule: 'evenodd' });
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="${d}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (point: unknown) => boolean; remove: () => void };
      const paperHoleA = item.contains(new scope.Point(50, 40));
      const paperHoleB = item.contains(new scope.Point(190, 40));
      const paperBody = item.contains(new scope.Point(150, 150));
      item.remove();
      scope.project.clear();
      return { canvasHoleA, canvasHoleB, canvasBody, canvasOutside, helperHoleA, helperHoleB, helperBody, helperOutside, paperHoleA, paperHoleB, paperBody };
    });
    expect(result.canvasHoleA).toBe(0);
    expect(result.canvasHoleB).toBe(0);
    expect(result.canvasBody).toBeGreaterThan(200);
    expect(result.canvasOutside).toBe(0);
    expect(result.paperHoleA).toBe(false);
    expect(result.paperHoleB).toBe(false);
    expect(result.paperBody).toBe(true);
    expect(result.helperHoleA.kind).toBe('hole');
    expect(result.helperHoleB.kind).toBe('hole');
    if (result.helperHoleA.kind === 'hole' && result.helperHoleB.kind === 'hole') {
      expect(result.helperHoleA.holeIndex).toBe(1);
      expect(result.helperHoleB.holeIndex).toBe(2);
    }
    expect(result.helperBody.kind).toBe('filled');
    expect(result.helperOutside.kind).toBe('outside');
  }, 30_000);

  it('arc ellipse + relative-m + quad interiors agree; edge band is refused', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const arc = 'M0 0H300V200H0Z M60 100A30 20 0 1 0 120 100A30 20 0 1 0 60 100Z';
      const relative = 'M0 0H300V200H0Z m30 60C30 40 60 40 60 60C60 80 30 80 30 60Z';
      const quad = 'M0 0H200V200H0Z M60 60Q90 40 120 60Q140 90 120 120Q90 140 60 120Q40 90 60 60Z';
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaOf = (d: string, x: number, y: number) => {
        ctx.clearRect(0, 0, 400, 300);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        return ctx.getImageData(x, y, 1, 1).data[3]!;
      };
      const arcHole = alphaOf(arc, 90, 100);
      const arcBody = alphaOf(arc, 20, 20);
      const relHole = alphaOf(relative, 45, 60);
      const quadHole = alphaOf(quad, 90, 90);
      const helperArcHole = helper.classifyCurvedHolePoint({ pathData: arc, point: { x: 90, y: 100 }, fillRule: 'evenodd' });
      const helperArcBody = helper.classifyCurvedHolePoint({ pathData: arc, point: { x: 20, y: 20 }, fillRule: 'evenodd' });
      const helperRelHole = helper.classifyCurvedHolePoint({ pathData: relative, point: { x: 45, y: 60 }, fillRule: 'evenodd' });
      const helperQuadHole = helper.classifyCurvedHolePoint({ pathData: quad, point: { x: 90, y: 90 }, fillRule: 'evenodd' });
      // Edge band: point on the arc perimeter must not claim a hole.
      const helperEdge = helper.classifyCurvedHolePoint({ pathData: arc, point: { x: 60, y: 100 }, fillRule: 'evenodd', tolerance: 2 });
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="${arc}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (point: unknown) => boolean; remove: () => void };
      const paperArcHole = item.contains(new scope.Point(90, 100));
      const paperArcBody = item.contains(new scope.Point(20, 20));
      item.remove();
      scope.project.clear();
      return { arcHole, arcBody, relHole, quadHole, helperArcHole, helperArcBody, helperRelHole, helperQuadHole, helperEdge, paperArcHole, paperArcBody };
    });
    expect(result.arcHole).toBe(0);
    expect(result.arcBody).toBeGreaterThan(200);
    expect(result.relHole).toBe(0);
    expect(result.quadHole).toBe(0);
    expect(result.paperArcHole).toBe(false);
    expect(result.paperArcBody).toBe(true);
    expect(result.helperArcHole.kind).toBe('hole');
    expect(result.helperArcBody.kind).toBe('filled');
    expect(result.helperRelHole.kind).toBe('hole');
    expect(result.helperQuadHole.kind).toBe('hole');
    expect(result.helperEdge.kind).toBe('ambiguous');
  }, 30_000);

  it('smooth S/T reflection matches explicit control points (Canvas pixel identity + helper)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const outer = 'M0 0H300V200H0Z';
      const pairs: Array<{ name: string; smooth: string; explicit: string; probe: { x: number; y: number } }> = [
        {
          name: 'C->S',
          smooth: `${outer} M60 60C80 40 120 40 140 60S160 100 140 120Z`,
          explicit: `${outer} M60 60C80 40 120 40 140 60C160 80 160 100 140 120Z`,
          probe: { x: 115, y: 80 },
        },
        {
          name: 'S fallback after L',
          smooth: `${outer} M60 60C80 40 120 40 140 60L150 70S170 90 160 110Z`,
          explicit: `${outer} M60 60C80 40 120 40 140 60L150 70C150 70 170 90 160 110Z`,
          probe: { x: 140, y: 85 },
        },
        {
          name: 'Q->T',
          smooth: `${outer} M60 60Q100 40 140 60T180 100Z`,
          explicit: `${outer} M60 60Q100 40 140 60Q180 80 180 100Z`,
          probe: { x: 130, y: 75 },
        },
        {
          name: 'T fallback after L',
          smooth: `${outer} M60 60Q100 40 140 60L150 70T190 110Z`,
          explicit: `${outer} M60 60Q100 40 140 60L150 70Q150 70 190 110Z`,
          probe: { x: 145, y: 85 },
        },
        {
          name: 'arc breaks S',
          smooth: `${outer} M60 60C80 40 120 40 140 60A10 10 0 0 1 160 60S180 80 170 100Z`,
          explicit: `${outer} M60 60C80 40 120 40 140 60A10 10 0 0 1 160 60C160 60 180 80 170 100Z`,
          probe: { x: 110, y: 80 },
        },
      ];
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 200;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const renderAlpha = (d: string) => {
        ctx.clearRect(0, 0, 300, 200);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        return ctx.getImageData(0, 0, 300, 200);
      };
      const alphaAt = (img: ImageData, x: number, y: number) => img.data[(y * 300 + x) * 4 + 3]!;
      const report = pairs.map((pair) => {
        const imgSmooth = renderAlpha(pair.smooth);
        const imgExplicit = renderAlpha(pair.explicit);
        let diffPixels = 0;
        for (let i = 0; i < imgSmooth.data.length; i += 4) {
          if (imgSmooth.data[i + 3] !== imgExplicit.data[i + 3]) diffPixels += 1;
        }
        const canvasSmoothProbe = alphaAt(imgSmooth, pair.probe.x, pair.probe.y);
        const canvasExplicitProbe = alphaAt(imgExplicit, pair.probe.x, pair.probe.y);
        const helperSmooth = helper.classifyCurvedHolePoint({
          pathData: pair.smooth,
          point: pair.probe,
          fillRule: 'evenodd',
        });
        const helperExplicit = helper.classifyCurvedHolePoint({
          pathData: pair.explicit,
          point: pair.probe,
          fillRule: 'evenodd',
        });
        return {
          name: pair.name,
          diffPixels,
          canvasSmoothProbe,
          canvasExplicitProbe,
          helperSmoothKind: helperSmooth.kind,
          helperExplicitKind: helperExplicit.kind,
        };
      });
      // Negative control: S-after-L must NOT match the reflection-wrong
      // explicit curve (c1 mirrored across L cursor), proving the oracle is
      // sensitive to fallback-vs-reflection confusion.
      const wrongSmooth = `${outer} M60 60C80 40 120 40 140 60L150 70S170 90 160 110Z`;
      const wrongExplicit = `${outer} M60 60C80 40 120 40 140 60L150 70C180 100 170 90 160 110Z`;
      const imgWrongSmooth = renderAlpha(wrongSmooth);
      const imgWrongExplicit = renderAlpha(wrongExplicit);
      let wrongDiff = 0;
      for (let i = 0; i < imgWrongSmooth.data.length; i += 4) {
        if (imgWrongSmooth.data[i + 3] !== imgWrongExplicit.data[i + 3]) wrongDiff += 1;
      }
      return { report, wrongDiff };
    });
    for (const entry of result.report) {
      // Identical bezier geometry must rasterize identically on Canvas.
      expect(entry.diffPixels).toBe(0);
      expect(entry.canvasSmoothProbe).toBe(entry.canvasExplicitProbe);
      // Helper must follow the same geometry for both spellings.
      expect(entry.helperSmoothKind).toBe(entry.helperExplicitKind);
    }
    // The L-break distinction is observable: fallback vs reflection-wrong differ.
    expect(result.wrongDiff).toBeGreaterThan(0);
  }, 30_000);

  it('nonzero winding agrees with Canvas; separate island stays filled', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      // Opposite-direction outer pair cancels under nonzero (unfilled center).
      const d = 'M0 0H200V200H0Z M0 200H200V0H0Z';
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'nonzero');
      const centerAlpha = ctx.getImageData(100, 100, 1, 1).data[3]!;
      const helperCenter = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 100, y: 100 }, fillRule: 'nonzero' });
      // Separate island outside a curved donut is painted on Canvas and filled.
      const island = 'M0 0H200V200H0Z M60 60Q90 40 120 60Q140 90 120 120Q90 140 60 120Q40 90 60 60Z M250 50H290V90H250Z';
      ctx.clearRect(0, 0, 300, 300);
      ctx.fill(new Path2D(island), 'evenodd');
      const islandAlpha = ctx.getImageData(270, 70, 1, 1).data[3]!;
      const islandHelper = helper.classifyCurvedHolePoint({ pathData: island, point: { x: 270, y: 70 }, fillRule: 'evenodd' });
      return { centerAlpha, helperCenter, islandAlpha, islandHelper };
    });
    expect(result.centerAlpha).toBe(0);
    expect(['outside', 'ambiguous']).toContain(result.helperCenter.kind);
    expect(result.islandAlpha).toBeGreaterThan(200);
    expect(result.islandHelper.kind).toBe('filled');
  }, 30_000);

  it('mirror / skew / non-uniform / singular / overlap refuse even when Canvas shows a hole', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const d = 'M0 0H300V200H0Z M30 60C30 40 60 40 60 60C60 80 30 80 30 60Z';
      const canvas = document.createElement('canvas');
      canvas.width = 500;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      // Mirrored oracle: Canvas renders the mirrored hole at (455,60).
      ctx.clearRect(0, 0, 500, 300);
      ctx.fillStyle = '#ff0000';
      ctx.save();
      ctx.translate(500, 0);
      ctx.scale(-1, 1);
      ctx.fill(new Path2D(d), 'evenodd');
      ctx.restore();
      const mirrorAlpha = ctx.getImageData(455, 60, 1, 1).data[3]!;
      // Skewed / non-uniform oracles render holes too.
      ctx.clearRect(0, 0, 500, 300);
      ctx.save();
      ctx.transform(1, 0, 0.5, 1, 0, 0);
      ctx.fill(new Path2D(d), 'evenodd');
      ctx.restore();
      const skewAlpha = ctx.getImageData(75, 60, 1, 1).data[3];
      const mirror = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 455, y: 60 },
        fillRule: 'evenodd',
        worldMatrix: [-1, 0, 0, 1, 500, 0],
      });
      const skew = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 75, y: 60 },
        fillRule: 'evenodd',
        worldMatrix: [1, 0, 0.5, 1, 0, 0],
      });
      const nonUniform = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 90, y: 60 },
        fillRule: 'evenodd',
        worldMatrix: [2, 0, 0, 1, 0, 0],
      });
      const singular = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 45, y: 60 },
        fillRule: 'evenodd',
        worldMatrix: [0, 0, 0, 1, 0, 0],
      });
      const overlap = helper.classifyCurvedHolePoint({
        pathData: 'M0 0H200V200H0Z M60 60C60 20 140 20 140 60C140 100 60 100 60 60Z M100 100H260V260H100Z',
        point: { x: 120, y: 120 },
        fillRule: 'evenodd',
      });
      const eligibility = helper.isUnitEligibleForHoleGeometry({ tag: 'path', clipPath: 'url(#c)' });
      return { mirrorAlpha, skewAlpha, mirror, skew, nonUniform, singular, overlap, eligibility, unsupported: helper.CURVED_HOLE_UNSUPPORTED_CASES };
    });
    // Oracles do render holes under mirror/skew — the helper must still refuse.
    expect(result.mirrorAlpha).toBe(0);
    expect(result.mirror.kind).toBe('ambiguous');
    expect(result.skew.kind).toBe('ambiguous');
    expect(result.nonUniform.kind).toBe('ambiguous');
    expect(result.singular.kind).toBe('ambiguous');
    expect(result.overlap.kind).toBe('ambiguous');
    expect(result.eligibility.eligible).toBe(false);
    expect(result.unsupported.length).toBeGreaterThanOrEqual(8);
    expect(result.unsupported.join('\n')).toContain('Paper entity probe');
  }, 30_000);

  it('2-segment lens holes diverge (Canvas hole vs Paper filled): production probe must not claim a hole', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      // Two cubics sharing both endpoints: Canvas evenodd renders a hole,
      // but Paper.js CompoundPath.contains reports filled (renderer quirk).
      const d = 'M0 0H300V200H0Z M30 60C30 40 60 40 60 60C60 80 30 80 30 60Z';
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'evenodd');
      const canvasHole = ctx.getImageData(45, 60, 1, 1).data[3]!;
      const helperVerdict = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 45, y: 60 }, fillRule: 'evenodd' });
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="${d}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (point: unknown) => boolean; remove: () => void };
      const paperContains = item.contains(new scope.Point(45, 60));
      item.remove();
      scope.project.clear();
      // Production hole probe over real DOM units (top-level, no ancestors).
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></svg>`,
        'image/svg+xml',
      );
      const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
      const probe = await paperModule.paperVectorHoleTargetAtPoint(units, { x: 45, y: 60 }, 0.5);
      return { canvasHole, helperVerdict, paperContains, probe };
    });
    // Canvas says hole, helper follows Canvas geometry, Paper entity says filled.
    expect(result.canvasHole).toBe(0);
    expect(result.helperVerdict.kind).toBe('hole');
    expect(result.paperContains).toBe(true);
    // The production probe must never claim this divergent shape as a hole
    // overlay target: ambiguous/none/unsupported only (safe fail).
    expect(result.probe.kind).not.toBe('hole');
  }, 30_000);
});
