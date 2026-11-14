import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Permanent safety-cert pixel oracle for `vector-fill-hole-curves.ts`.
// No Editor wiring.
//
// Oracle triplet (all real, in a real Chrome via CHROME_BIN):
// - Canvas 2D `Path2D(d)` + `fill(rule)` alpha via `getImageData`
//   (rendered truth; 0 = hole, 255 = painted, partial = anti-aliased edge).
// - Helper `classifyCurvedHolePoint` (candidate under test).
// - Flattened polyline relations (`flattenCurvedContours`,
//   `distanceToContours`, `contoursOverlap`) for the separation proof.
//
// Sampling is viewport-accurate: document point (px,py) is mapped to canvas
// pixel center (60.5,60.5) with `setTransform(1,0,0,1,60.5-px,60.5-py)` so
// 1px assertions are not blurred by half-pixel bias (see the large-radius
// oracle). World-matrix cases compose T*M explicitly.
//
// What is asserted (strict, fail-closed):
// - open contour implicit closing edge is included in distance/overlap and
//   edge-band points refuse (`ambiguous`) while Canvas shows partial coverage.
// - near-touching arc holes with gap (0.3) below the summed flatten error
//   (0.5): separation is uncertified, so deep centers refuse (`ambiguous`).
// - polygon-collinear shared wall: coincidence counts as overlap and holes
//   adjacent to it refuse.
// - huge-R circle stays decidable; borderline 1.02x non-uniform frame
//   refuses (similarity only) in one real-Chrome run.
// - strict grid scan: any helper-`hole` + Canvas-fully-painted (>=250)
//   point outside the widened band is a true filled->hole false positive
//   and fails with the minimal repro.
//
// If any `it` fails, the phase-swap / edge-zone safety certification does
// NOT hold for all subpath relations.

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4387';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('safety-cert curved-hole pixel oracle (Canvas vs helper, real Chrome)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4387', '--strictPort'], {
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

  it('open contour: implicit closing wall is visible and edge-band refuses', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const geom = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      // Inner hole is open (no Z): true wall (60,140)->(60,60) exists for
      // SVG fill and must be included in distance/overlap.
      const d = 'M0 0H200V200H0Z M60 60H140V140H60';
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaAtDoc = (px: number, py: number) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 120, 120);
        ctx.setTransform(1, 0, 0, 1, 60.5 - px, 60.5 - py);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        return ctx.getImageData(60, 60, 1, 1).data[3]!;
      };
      const px = 60.4;
      const py = 100;
      const alpha = alphaAtDoc(px, py);
      const verdict = helper.classifyCurvedHolePoint({ pathData: d, point: { x: px, y: py }, fillRule: 'evenodd' });
      const contours = helper.flattenCurvedContours(d)!;
      const polyDist = geom.distanceToContours(contours, { x: px, y: py });
      return {
        alpha,
        kind: verdict.kind,
        polyDist,
        closed: contours.map((c: { closed: boolean }) => c.closed),
        margin: helper.curvedLocalMarginFor(helper.CURVED_FLATTEN_TOLERANCE),
      };
    });
    // True wall is 0.4 away; Canvas straddles it (partial, neither 0 nor 255).
    expect(result.closed).toEqual([true, false]);
    expect(result.polyDist).toBeLessThan(1);
    expect(result.alpha).toBeGreaterThan(0);
    expect(result.alpha).toBeLessThan(250);
    // Edge-band contract: must refuse, never claim a hole here.
    expect(result.kind).toBe('ambiguous');
  }, 30_000);

  it('near-touching arcs (gap 0.3 < error sum 0.5): uncertified separation refuses', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const geom = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const d =
        'M0 0H400V200H0Z M60 80A30 30 0 1 0 120 80A30 30 0 1 0 60 80Z M120.3 80A30 30 0 1 0 180.3 80A30 30 0 1 0 120.3 80Z';
      const contours = helper.flattenCurvedContours(d)!;
      let best = Number.POSITIVE_INFINITY;
      for (const a of contours[1]!.points) {
        for (const b of contours[2]!.points) {
          const dd = Math.hypot(a.x - b.x, a.y - b.y);
          if (dd < best) best = dd;
        }
      }
      const overlap = geom.contoursOverlap(contours);
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaAtDoc = (px: number, py: number) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 120, 120);
        ctx.setTransform(1, 0, 0, 1, 60.5 - px, 60.5 - py);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        return ctx.getImageData(60, 60, 1, 1).data[3]!;
      };
      const probes = [
        { x: 90, y: 80 },
        { x: 150.15, y: 80 },
      ].map((p) => ({
        ...p,
        alpha: alphaAtDoc(p.x, p.y),
        kind: helper.classifyCurvedHolePoint({ pathData: d, point: p, fillRule: 'evenodd' }).kind,
      }));
      return { best, overlap, probes, errorSum: 2 * helper.CURVED_FLATTEN_TOLERANCE };
    });
    // Separation (0.3) is below the summed flatten error (0.5): the truth may
    // intersect while the polyline shows a gap. Documented, not certified.
    expect(result.best).toBeLessThan(result.errorSum);
    expect(result.overlap).toBe(false);
    for (const p of result.probes) expect(p.alpha).toBe(0);
    // Safe cert would refuse both deep centers until separation is proven.
    // FAILS today (both are `hole`).
    for (const p of result.probes) expect(p.kind).toBe('ambiguous');
  }, 30_000);

  it('polygon-collinear shared wall + huge-R + non-uniform frames fail closed with a relation proof', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const geom = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
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
      // Collinear: two holes share wall x=150 exactly.
      const shared = 'M0 0H300V200H0Z M30 60H150V140H30Z M150 60H270V140H150Z';
      const sharedContours = helper.flattenCurvedContours(shared)!;
      const sharedOverlap = geom.contoursOverlap(sharedContours);
      const sharedA = helper.classifyCurvedHolePoint({ pathData: shared, point: { x: 90, y: 100 }, fillRule: 'evenodd' });
      const sharedAlphaA = alphaAtDoc(shared, 'evenodd', 90, 100);
      // Huge R: R=10000 circle, worst-angle 1px probes (true-circle sampling).
      const R = 10000;
      const worst = (22.90127568371984 * Math.PI) / 180;
      const huge =
        `M${-R - 100} ${-R - 100}H${R + 100}V${R + 100}H${-R - 100}Z M${-R} 0A${R} ${R} 0 1 0 ${R} 0A${R} ${R} 0 1 0 ${-R} 0Z`;
      const ox1 = (R + 1) * Math.cos(worst);
      const oy1 = (R + 1) * Math.sin(worst);
      const hugeOutsideAlpha = alphaAtDoc(huge, 'evenodd', ox1, oy1);
      const hugeOutsideKind = helper.classifyCurvedHolePoint({ pathData: huge, point: { x: ox1, y: oy1 }, fillRule: 'evenodd' }).kind;
      const hugeCenterKind = helper.classifyCurvedHolePoint({ pathData: huge, point: { x: 0, y: 0 }, fillRule: 'evenodd' }).kind;
      // Borderline non-uniform similarity frame (ratio 1.02, accepted).
      const d = 'M0 0H300V200H0Z M30 60C30 40 60 40 60 60C60 80 30 80 30 60Z';
      const gate = helper.gateCurvedWorldMatrix([1.02, 0, 0, 1, 0, 0]);
      const wmKind = helper.classifyCurvedHolePoint({
        pathData: d,
        point: { x: 57, y: 60 },
        fillRule: 'evenodd',
        worldMatrix: [1.02, 0, 0, 1, 0, 0],
      }).kind;
      return { sharedOverlap, sharedKind: sharedA.kind, sharedAlphaA, hugeOutsideAlpha, hugeOutsideKind, hugeCenterKind, gateOk: gate.ok, wmKind };
    });
    // Shared-wall coincidence counts as overlap and fail-closes; huge-R
    // deep holes stay decidable under exact similarity; 1.02x refuses.
    expect(result.sharedAlphaA).toBe(0);
    expect(result.sharedKind).toBe('ambiguous');
    expect(result.hugeOutsideAlpha).toBeGreaterThan(200);
    expect(['filled', 'ambiguous']).toContain(result.hugeOutsideKind);
    expect(result.hugeCenterKind).toBe('hole');
    expect(result.gateOk).toBe(false);
    expect(result.wmKind).toBe('ambiguous');
    // Coincidence must count as overlap.
    expect(result.sharedOverlap).toBe(true);
  }, 60_000);

  it('strict grid scan: no helper-hole + Canvas-painted (>=250) mismatch outside the band', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-curves.ts');
      const geom = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const cases: Array<{ d: string; x0: number; y0: number; x1: number; y1: number; step: number }> = [
        // Close cubic walls facing each other (gap 0.1..0.49, amp 0.2..0.5).
        {
          d: 'M0 0H400V300H0Z M60 100H140C140.2 115 140.2 135 140 150H60Z M140.1 100H220.1C219.9 115 219.9 135 220.1 150H140.1Z',
          x0: 50, y0: 90, x1: 230, y1: 160, step: 5,
        },
        // Open-contour missing-wall neighbourhood.
        { d: 'M0 0H200V200H0Z M60 60H140V140H60', x0: 55, y0: 60, x1: 145, y1: 145, step: 5 },
        // Shared-wall neighbourhood.
        {
          d: 'M0 0H300V200H0Z M30 60H150V140H30Z M150 60H270V140H150Z',
          x0: 20, y0: 50, x1: 280, y1: 150, step: 5,
        },
      ];
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaAtDoc = (d: string, px: number, py: number) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 120, 120);
        ctx.setTransform(1, 0, 0, 1, 60.5 - px, 60.5 - py);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        return ctx.getImageData(60, 60, 1, 1).data[3]!;
      };
      const fps: Array<{ d: string; x: number; y: number; alpha: number; dist: number }> = [];
      for (const c of cases) {
        const contours = helper.flattenCurvedContours(c.d)!;
        for (let y = c.y0; y <= c.y1; y += c.step) {
          for (let x = c.x0; x <= c.x1; x += c.step) {
            const v = helper.classifyCurvedHolePoint({ pathData: c.d, point: { x, y }, fillRule: 'evenodd' });
            if (v.kind !== 'hole') continue;
            const dist = geom.distanceToContours(contours, { x, y });
            if (!(dist > 1.2)) continue; // inside the widened band: oracle indecisive
            const alpha = alphaAtDoc(c.d, x, y);
            if (alpha >= 250) fps.push({ d: c.d.slice(0, 40), x, y, alpha, dist });
          }
        }
      }
      return { fps: fps.slice(0, 5), count: fps.length };
    });
    // Minimal repro (if any) is reported verbatim and stays failing.
    expect(`${result.count} ${JSON.stringify(result.fps)}`).toBe('0 []');
  }, 60_000);
});
