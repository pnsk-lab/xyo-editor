import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Independent adversarial pixel-oracle review for the curved hole-geometry
// prototype (`vector-fill-hole-curves.ts`, new file only; existing Editor /
// BitmapEditor / paper-vector untouched).
//
// Oracles (all real, in a real Chrome with CHROME_BIN):
// - Canvas 2D: `Path2D(d)` filled with `evenodd`, alpha via `getImageData`
//   (the rendered-truth pixel; alpha 0 = hole, >=200 = painted).
// - Paper.js: the real `paper` project import + `contains` for the same SVG,
//   plus the production `paperVectorHoleTargetAtPoint` probe (must never
//   claim a hole where Canvas is painted).
// - Helper: pure `classifyCurvedHolePoint` verdicts (candidate under test).
//
// Interior points (away from edges) must agree across all three; curve
// perimeters and near-touch bands may disagree via anti-aliasing and must be
// refused (`ambiguous`). Mirror / skew / non-uniform / singular inputs must
// refuse even when the oracles render a hole (safe fail, never a hole).
//
// False-positive contract: if the scan finds helper==hole where Canvas is
// painted (or helper==filled/outside where Canvas is a clear hole), the test
// fails with the minimal repro and stays failing (no product-code edits in
// this review).

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4335';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('adversarial curved-hole pixel oracle (Canvas + Paper vs helper)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4335', '--strictPort'], {
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

  it('uniform magnification (1x vs 4x world scale) agrees with Canvas device pixels', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      // Arc-circle hole (Paper.js agrees with Canvas on arcs; the 2-segment
      // cubic "lens" shape is a known Canvas-vs-Paper divergent case and is
      // covered as a safe-fail by the existing curves oracle suite).
      const d = 'M100 100H400V300H100Z M150 150A30 30 0 1 0 210 150A30 30 0 1 0 150 150Z';
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 1200;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      // 1x oracle.
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'evenodd');
      const hole1x = ctx.getImageData(180, 150, 1, 1).data[3]!;
      const body1x = ctx.getImageData(110, 110, 1, 1).data[3]!;
      // 4x oracle: same local path under a uniform device scale.
      ctx.clearRect(0, 0, 1600, 1200);
      ctx.save();
      ctx.setTransform(4, 0, 0, 4, 0, 0);
      ctx.fill(new Path2D(d), 'evenodd');
      ctx.restore();
      const hole4x = ctx.getImageData(720, 600, 1, 1).data[3]!;
      const body4x = ctx.getImageData(440, 440, 1, 1).data[3]!;
      const world4: [number, number, number, number, number, number] = [4, 0, 0, 4, 0, 0];
      const helperHole4 = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 720, y: 600 },
        fillRule: 'evenodd',
        worldMatrix: world4,
      });
      const helperBody4 = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 440, y: 440 },
        fillRule: 'evenodd',
        worldMatrix: world4,
      });
      const helperHole1 = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 180, y: 150 }, fillRule: 'evenodd' });
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="${d}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (point: unknown) => boolean; remove: () => void };
      const paperHole = item.contains(new scope.Point(180, 150));
      const paperBody = item.contains(new scope.Point(110, 110));
      item.remove();
      scope.project.clear();
      return { hole1x, body1x, hole4x, body4x, helperHole4, helperBody4, helperHole1, paperHole, paperBody };
    });
    expect(result.hole1x).toBe(0);
    expect(result.body1x).toBeGreaterThan(200);
    expect(result.hole4x).toBe(0);
    expect(result.body4x).toBeGreaterThan(200);
    expect(result.paperHole).toBe(false);
    expect(result.paperBody).toBe(true);
    expect(result.helperHole1.kind).toBe('hole');
    expect(result.helperHole4.kind).toBe('hole');
    expect(result.helperBody4.kind).toBe('filled');
  }, 30_000);

  it('large rotated ellipse hole agrees; inflated-arc and tip cases refuse', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const d = 'M0 0H800V600H0Z M100 300A400 200 30 1 0 700 300A400 200 30 1 0 100 300Z';
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'evenodd');
      const centerAlpha = ctx.getImageData(400, 300, 1, 1).data[3]!;
      const helperCenter = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 400, y: 300 }, fillRule: 'evenodd' });
      // Chord longer than the rotated radii inflates per SVG F.6.5 (lambda>1)
      // and bursts out of the outer rect: Canvas still renders the center as
      // a hole (it stays inside the inflated ellipse), but the helper must
      // refuse via the overlap gate instead of claiming it (safe fail).
      const inflated = 'M0 0H800V600H0Z M100 300A300 60 30 1 0 700 300A300 60 30 1 0 100 300Z';
      ctx.clearRect(0, 0, 800, 600);
      ctx.fill(new Path2D(inflated), 'evenodd');
      const inflatedAlpha = ctx.getImageData(400, 300, 1, 1).data[3]!;
      const helperInflated = helper.classifyCurvedHolePoint({
        pathData: inflated,
        point: { x: 400, y: 300 },
        fillRule: 'evenodd',
      });
      return { centerAlpha, helperCenter, inflatedAlpha, helperInflated };
    });
    expect(result.centerAlpha).toBe(0);
    expect(result.helperCenter.kind).toBe('hole');
    // Inflated ellipse still leaves the center unfilled on Canvas; the helper
    // refuses (overlap with the outer wall) instead of claiming it.
    expect(result.inflatedAlpha).toBe(0);
    expect(result.helperInflated.kind).toBe('ambiguous');
  }, 30_000);

  it('skew / non-uniform world frames refuse while Canvas still shows a hole', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const d = 'M0 0H300V200H0Z M30 60C30 40 60 40 60 60C60 80 30 80 30 60Z';
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.save();
      ctx.transform(1, 0, 0.5, 1, 0, 0);
      ctx.fill(new Path2D(d), 'evenodd');
      ctx.restore();
      const skewAlpha = ctx.getImageData(75, 60, 1, 1).data[3]!;
      ctx.clearRect(0, 0, 600, 300);
      ctx.save();
      ctx.transform(3, 0, 0, 1, 0, 0);
      ctx.fill(new Path2D(d), 'evenodd');
      ctx.restore();
      const nonUniformAlpha = ctx.getImageData(135, 60, 1, 1).data[3]!;
      const skew = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 75, y: 60 },
        fillRule: 'evenodd',
        worldMatrix: [1, 0, 0.5, 1, 0, 0],
      });
      const nonUniform = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 135, y: 60 },
        fillRule: 'evenodd',
        worldMatrix: [3, 0, 0, 1, 0, 0],
      });
      return { skewAlpha, nonUniformAlpha, skew, nonUniform };
    });
    // Oracles render holes under anisotropy; the helper must still refuse.
    expect(result.skewAlpha).toBe(0);
    expect(result.skew.kind).toBe('ambiguous');
    expect(result.nonUniformAlpha).toBe(0);
    expect(result.nonUniform.kind).toBe('ambiguous');
  }, 30_000);

  it('thin crescent band agrees with Canvas; production probe stays safe', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M0 0H400V300H0Z M100 200A80 60 0 0 1 260 200L260 210A70 50 0 0 0 100 210Z';
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'evenodd');
      const bandAlpha = ctx.getImageData(180, 146, 1, 1).data[3]!;
      const bodyAlpha = ctx.getImageData(50, 50, 1, 1).data[3]!;
      const helperBand = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 180, y: 146 }, fillRule: 'evenodd' });
      const helperBody = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 50, y: 50 }, fillRule: 'evenodd' });
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="${d}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (point: unknown) => boolean; remove: () => void };
      const paperBand = item.contains(new scope.Point(180, 146));
      item.remove();
      scope.project.clear();
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></svg>`,
        'image/svg+xml',
      );
      const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
      const probeBand = await paperModule.paperVectorHoleTargetAtPoint(units, { x: 180, y: 146 }, 0.5);
      const probeBody = await paperModule.paperVectorHoleTargetAtPoint(units, { x: 50, y: 50 }, 0.5);
      return { bandAlpha, bodyAlpha, helperBand, helperBody, paperBand, probeBand, probeBody };
    });
    expect(result.bandAlpha).toBe(0);
    expect(result.bodyAlpha).toBeGreaterThan(200);
    expect(result.helperBand.kind).toBe('hole');
    expect(result.helperBody.kind).toBe('filled');
    expect(result.paperBand).toBe(false);
    if (result.bandAlpha === 0) expect(result.probeBand.kind).not.toBe('none');
    expect(result.probeBody.kind).not.toBe('hole');
  }, 30_000);

  it('subpixel micro-holes: visible ones agree, sub-margin ones refuse', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const visible = 'M0 0H100V100H0Z M48.5 50.25A2 2 0 1 0 52.5 50.25A2 2 0 1 0 48.5 50.25Z';
      const micro = 'M0 0H100V100H0Z M50 50.5A0.5 0.5 0 1 0 51 50.5A0.5 0.5 0 1 0 50 50.5Z';
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(visible), 'evenodd');
      const visibleAlpha = ctx.getImageData(50, 50, 1, 1).data[3]!;
      ctx.clearRect(0, 0, 100, 100);
      ctx.fill(new Path2D(micro), 'evenodd');
      const microAlpha = ctx.getImageData(50, 50, 1, 1).data[3]!;
      const helperVisible = helper.classifyCurvedHolePoint({
        pathData: visible,
        point: { x: 50.5, y: 50.25 },
        fillRule: 'evenodd',
      });
      const helperMicro = helper.classifyCurvedHolePoint({
        pathData: micro,
        point: { x: 50.5, y: 50.5 },
        fillRule: 'evenodd',
      });
      return { visibleAlpha, microAlpha, helperVisible, helperMicro };
    });
    // r=2 hole covers its center pixel on Canvas; helper must agree.
    expect(result.visibleAlpha).toBe(0);
    expect(result.helperVisible.kind).toBe('hole');
    // r=0.5 hole is swallowed by the edge zone: helper refuses either way.
    expect(result.helperMicro.kind).toBe('ambiguous');
  }, 30_000);

  it('S-after-arc lobe grid scan: no helper/Canvas disagreement outside the edge band', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      // Inner hole wall runs through an arc-then-S joint: the exact case
      // where a wrong smooth-tangent reflection would displace the wall.
      const lobe = 'M0 0H400V300H0Z M60 200A60 40 0 0 1 180 200S260 200 260 120Z';
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(lobe), 'evenodd');
      const alphaAt = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3]!;
      const mismatches: Array<{ x: number; y: number; kind: string; alpha: number }> = [];
      let edgeSkipped = 0;
      // Scan the S-lobe bbox on a 2px grid.
      for (let y = 110; y <= 210; y += 2) {
        for (let x = 50; x <= 270; x += 2) {
          const alpha = alphaAt(x, y);
          const verdict = helper.classifyCurvedHolePoint({ pathData: lobe, point: { x, y }, fillRule: 'evenodd' });
          if (alpha > 0 && alpha < 200) {
            edgeSkipped += 1;
            continue; // Anti-aliased perimeter: oracle indecisive, skip.
          }
          if (verdict.kind === 'hole' && alpha > 200) mismatches.push({ x, y, kind: verdict.kind, alpha });
          else if ((verdict.kind === 'filled' || verdict.kind === 'outside') && alpha === 0) {
            mismatches.push({ x, y, kind: verdict.kind, alpha });
          }
        }
      }
      return { mismatches: mismatches.slice(0, 5), mismatchCount: mismatches.length, edgeSkipped };
    });
    // Minimal repro (if any) is reported verbatim and stays failing.
    expect(`${result.mismatchCount} ${JSON.stringify(result.mismatches)}`).toBe('0 []');
  }, 60_000);

  it('self-crossing figure-8: crossing refuses, painted lobes stay safe for the probe', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M0 0H300V300H0Z M100 150C150 50 150 250 200 150C150 200 150 100 100 150Z';
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 300;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'evenodd');
      const crossAlpha = ctx.getImageData(150, 150, 1, 1).data[3]!;
      const helperCross = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 150, y: 150 },
        fillRule: 'evenodd',
        tolerance: 0.5,
      });
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></svg>`,
        'image/svg+xml',
      );
      const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
      const probeCross = await paperModule.paperVectorHoleTargetAtPoint(units, { x: 150, y: 150 }, 0.5);
      return { crossAlpha, helperCross, probeCross };
    });
    // Crossing sits on a painted edge: helper refuses; production probe never claims it.
    expect(result.helperCross.kind).toBe('ambiguous');
    expect(result.probeCross.kind).not.toBe('hole');
  }, 30_000);
});
