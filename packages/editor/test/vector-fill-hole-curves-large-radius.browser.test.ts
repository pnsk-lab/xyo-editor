import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Large-radius / anisotropic-scale pixel-oracle for the curved hole-geometry
// helper (`vector-fill-hole-curves.ts`, new file only; existing Editor /
// BitmapEditor / paper-vector untouched, and this helper stays unwired from
// the Editor).
//
// Regression: the old arc path expanded arcs to <=90-degree cubics whose
// radius-proportional error (~0.00027 * R per quarter) exceeded the fixed
// 0.35 margin for R >= ~2000, and at R=10000 a real-Canvas-filled pixel 1px
// outside the true circle was classified `hole`. The helper now samples arcs
// directly from the true ellipse with a proven chord bound
// (`maxR * h^2 / 8 <= tol`) plus a dynamic `2 * tol + 1e-6` margin, so no
// fixed 0.35 constant is used for arbitrary radii.
//
// Oracles (all real, in a real browser):
// - Canvas 2D: `Path2D(d)` filled with `evenodd`, alpha via `getImageData`
//   (rendered truth; alpha 0 = hole, >=200 = painted). Huge coordinates are
//   probed through a small viewport canvas with a translate so no giant
//   canvas is needed: pixel (60,60) always shows document point (px,py).
// - Helper: pure `classifyCurvedHolePoint` verdicts (candidate under test).
// - Paper.js: only for the small-radius sanity case (Paper's own flattening
//   is not part of this regression contract at R=10000).
//
// Contract enforced here:
// - radii 300/1000/2000/4000/7000/10000: center is a Canvas hole AND a helper
//   hole (deep holes stay decidable); the 1px-outside pixel at the old worst
//   angle (~22.9deg) is Canvas-filled and helper NEVER `hole`
//   (filled/ambiguous only); the 1px-inside pixel is Canvas-hole and helper
//   NEVER `filled`/`outside` (hole/ambiguous only).
// - unequal + rotated ellipses: same three-way agreement.
// - world scales 0.01/1/100: uniform similarity frames agree; the tiny-scale
//   frame fail-closes (ambiguous) instead of claiming a hole.
// - headline: R=10000 1px-outside real-filled pixel is asserted verbatim.

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4339';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('large-radius curved-hole pixel oracle (Canvas vs helper)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4339', '--strictPort'], {
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

  it('circle radii 300..10000 agree with Canvas; R=10000 1px-outside filled pixel is never a hole', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      // Viewport probe: map document point (px,py) onto the CENTER of canvas
      // pixel (60,60) (device pixel centers sit at +.5, so the translate uses
      // 60.5; a bare 60 would bias every probe by half a pixel and blur the
      // 1px assertions below into anti-aliased partial coverage).
      const alphaAtDoc = (d: string, rule: CanvasFillRule, px: number, py: number) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 120, 120);
        ctx.setTransform(1, 0, 0, 1, 60.5 - px, 60.5 - py);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), rule);
        return ctx.getImageData(60, 60, 1, 1).data[3]!;
      };
      const radii = [300, 1000, 2000, 4000, 7000, 10000];
      // Old cubic-approximation worst angle for a 0..90deg quarter (~t=0.25).
      const worstAng = (22.90127568371984 * Math.PI) / 180;
      const rows = radii.map((R) => {
        const d = `M${-R - 100} ${-R - 100}H${R + 100}V${R + 100}H${-R - 100}Z M${-R} 0A${R} ${R} 0 1 0 ${R} 0A${R} ${R} 0 1 0 ${-R} 0Z`;
        // Headline probe: exactly 1px outside the true wall (real filled).
        const ox1 = (R + 1) * Math.cos(worstAng);
        const oy1 = (R + 1) * Math.sin(worstAng);
        // Clean probes outside the anti-aliased band (pixel half-diagonal
        // 0.707 < 2 keeps the whole pixel painted / unfilled).
        const ox2 = (R + 2) * Math.cos(worstAng);
        const oy2 = (R + 2) * Math.sin(worstAng);
        const ix3 = (R - 3) * Math.cos(worstAng);
        const iy3 = (R - 3) * Math.sin(worstAng);
        // Band probe 1px inside the wall (oracle may be partial: the helper
        // must still never report painted/outside).
        const ix1 = (R - 1) * Math.cos(worstAng);
        const iy1 = (R - 1) * Math.sin(worstAng);
        const canvasCenter = alphaAtDoc(d, 'evenodd', 0, 0);
        const canvasOutside1 = alphaAtDoc(d, 'evenodd', ox1, oy1);
        const canvasOutside2 = alphaAtDoc(d, 'evenodd', ox2, oy2);
        const canvasInside3 = alphaAtDoc(d, 'evenodd', ix3, iy3);
        const helperCenter = helper.classifyCurvedHolePoint({ pathData: d, point: { x: 0, y: 0 }, fillRule: 'evenodd' });
        const helperOutside1 = helper.classifyCurvedHolePoint({ pathData: d, point: { x: ox1, y: oy1 }, fillRule: 'evenodd' });
        const helperOutside2 = helper.classifyCurvedHolePoint({ pathData: d, point: { x: ox2, y: oy2 }, fillRule: 'evenodd' });
        const helperInside3 = helper.classifyCurvedHolePoint({ pathData: d, point: { x: ix3, y: iy3 }, fillRule: 'evenodd' });
        const helperInside1 = helper.classifyCurvedHolePoint({ pathData: d, point: { x: ix1, y: iy1 }, fillRule: 'evenodd' });
        return {
          R,
          canvasCenter,
          canvasOutside1,
          canvasOutside2,
          canvasInside3,
          helperCenterKind: helperCenter.kind,
          helperOutside1Kind: helperOutside1.kind,
          helperOutside2Kind: helperOutside2.kind,
          helperInside3Kind: helperInside3.kind,
          helperInside1Kind: helperInside1.kind,
        };
      });
      return { rows };
    });
    for (const row of result.rows) {
      // Deep center: Canvas renders a hole and the helper must confirm it.
      expect(row.canvasCenter).toBe(0);
      expect(row.helperCenterKind).toBe('hole');
      // Headline regression: 1px outside the true wall at R=10000 is
      // real-Canvas-filled; the helper must never claim a hole there (the
      // old cubic path returned `hole` here).
      expect(row.canvasOutside1).toBeGreaterThan(200);
      expect(['filled', 'ambiguous']).toContain(row.helperOutside1Kind);
      // Clean 2px-outside probe: fully painted pixel, helper agrees or
      // fail-closes in the band (never a hole).
      expect(row.canvasOutside2).toBeGreaterThan(200);
      expect(['filled', 'ambiguous']).toContain(row.helperOutside2Kind);
      // Clean 3px-inside probe: clear Canvas hole, helper confirms or
      // fail-closes (never painted/outside).
      expect(row.canvasInside3).toBe(0);
      expect(['hole', 'ambiguous']).toContain(row.helperInside3Kind);
      // 1px-inside band probe: oracle may straddle the wall, so only the
      // fail-closed direction is asserted (never painted/outside).
      expect(['hole', 'ambiguous']).toContain(row.helperInside1Kind);
    }
  }, 60_000);

  it('unequal and rotated ellipses agree with Canvas (no fixed-margin drift)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaAtDoc = (d: string, rule: CanvasFillRule, px: number, py: number) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 120, 120);
        ctx.setTransform(1, 0, 0, 1, 60.5 - px, 60.5 - py);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), rule);
        return ctx.getImageData(60, 60, 1, 1).data[3]!;
      };
      // Unequal ellipse hole (rx=4000, ry=800) centered at origin; outer rect
      // leaves a >=100 margin on every side.
      const flat = 'M-4200 -1000H4200V1000H-4200Z M-4000 0A4000 800 0 1 0 4000 0A4000 800 0 1 0 -4000 0Z';
      // Rotated ellipse (rx=2000, ry=500, 30deg) centered at origin. Diameter
      // endpoints along the major axis: +/-(rx*cos30, rx*sin30).
      const tipX = 2000 * Math.cos(Math.PI / 6);
      const tipY = 2000 * Math.sin(Math.PI / 6);
      const rotated = `M-3000 -3000H3000V3000H-3000Z M${-tipX} ${-tipY}A2000 500 30 1 0 ${tipX} ${tipY}A2000 500 30 1 0 ${-tipX} ${-tipY}Z`;
      const axisX = Math.cos(Math.PI / 6);
      const axisY = Math.sin(Math.PI / 6);
      const cases = [
        {
          name: 'flat',
          d: flat,
          center: { x: 0, y: 0 },
          // 2px outside the east tip (true wall at x=4000): body paint.
          outside: { x: 4002, y: 0 },
          // 5px inside the east tip: clear hole (outside the widened band).
          inside: { x: 3995, y: 0 },
        },
        {
          name: 'rotated-center',
          d: rotated,
          center: { x: 0, y: 0 },
          // 2px outside the rotated tip along the major axis: body paint.
          outside: { x: tipX + 2 * axisX, y: tipY + 2 * axisY },
          // 5px inside the rotated tip along the axis: clear hole.
          inside: { x: tipX - 5 * axisX, y: tipY - 5 * axisY },
        },
      ];
      return cases.map((c) => ({
        name: c.name,
        canvasCenter: alphaAtDoc(c.d, 'evenodd', c.center.x, c.center.y),
        canvasOutside: alphaAtDoc(c.d, 'evenodd', c.outside.x, c.outside.y),
        canvasInside: alphaAtDoc(c.d, 'evenodd', c.inside.x, c.inside.y),
        helperCenter: helper.classifyCurvedHolePoint({ pathData: c.d, point: c.center, fillRule: 'evenodd' }).kind,
        helperOutside: helper.classifyCurvedHolePoint({ pathData: c.d, point: c.outside, fillRule: 'evenodd' }).kind,
        helperInside: helper.classifyCurvedHolePoint({ pathData: c.d, point: c.inside, fillRule: 'evenodd' }).kind,
      }));
    });
    for (const c of result) {
      expect(c.canvasCenter).toBe(0);
      expect(c.helperCenter).toBe('hole');
      expect(c.canvasOutside).toBeGreaterThan(200);
      expect(['filled', 'ambiguous']).toContain(c.helperOutside);
      expect(c.canvasInside).toBe(0);
      expect(['hole', 'ambiguous']).toContain(c.helperInside);
    }
  }, 60_000);

  it('world scales 0.01/1/100 map correctly; tiny scale fail-closes', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      // Local donut: rect 100..400 x 100..300, cubic hole around (180,150).
      const d = 'M100 100H400V300H100Z M170 150C170 130 190 130 190 150C190 170 170 170 170 150Z';
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      // Render local path under uniform device scale s, probing document
      // point (dx,dy) = s * local + t at canvas pixel (60,60).
      const alphaAtScaled = (scale: number, lx: number, ly: number) => {
        const dx = scale * lx;
        const dy = scale * ly;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 120, 120);
        ctx.setTransform(scale, 0, 0, scale, 60 - dx, 60 - dy);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        return { alpha: ctx.getImageData(60, 60, 1, 1).data[3]!, dx, dy };
      };
      const report: Array<Record<string, string | number>> = [];
      // s=1 and s=100: deep local center (180,150) stays a hole.
      for (const s of [1, 100]) {
        const m: [number, number, number, number, number, number] = [s, 0, 0, s, 0, 0];
        const probe = alphaAtScaled(s, 180, 150);
        const helperCenter = helper.classifyCurvedHolePoint({
          pathData: d,
          point: { x: probe.dx, y: probe.dy },
          fillRule: 'evenodd',
          worldMatrix: m,
        });
        // Local body point (110,110) under the same frame.
        const body = alphaAtScaled(s, 110, 110);
        const helperBody = helper.classifyCurvedHolePoint({
          pathData: d,
          point: { x: body.dx, y: body.dy },
          fillRule: 'evenodd',
          worldMatrix: m,
        });
        report.push({ s, canvasCenter: probe.alpha, helperCenter: helperCenter.kind, canvasBody: body.alpha, helperBody: helperBody.kind });
      }
      // s=0.01: the same local hole (r~10 local) is swallowed by the
      // local exclusion radius (0.5/0.01 + margin): helper must refuse.
      {
        const s = 0.01;
        const m: [number, number, number, number, number, number] = [s, 0, 0, s, 0, 0];
        const probe = alphaAtScaled(s, 180, 150);
        const helperCenter = helper.classifyCurvedHolePoint({
          pathData: d,
          point: { x: probe.dx, y: probe.dy },
          fillRule: 'evenodd',
          worldMatrix: m,
        });
        report.push({ s, canvasCenter: probe.alpha, helperCenter: helperCenter.kind, canvasBody: -1, helperBody: 'n/a' });
      }
      return { report };
    });
    const byScale = new Map(result.report.map((r) => [r.s, r]));
    for (const s of [1, 100]) {
      const r = byScale.get(s)!;
      expect(r.canvasCenter).toBe(0);
      expect(r.helperCenter).toBe('hole');
      expect(r.canvasBody as number).toBeGreaterThan(200);
      expect(r.helperBody).toBe('filled');
    }
    // Tiny frame: fail-closed (ambiguous), never a hole claim, even if the
    // device pixel happens to read unfilled.
    expect(byScale.get(0.01)!.helperCenter).toBe('ambiguous');
  }, 60_000);
});
