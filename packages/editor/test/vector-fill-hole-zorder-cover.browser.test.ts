import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Durable real-oracle repro for the fallback Z-order bug.
//
// Background evenodd donut + foreground nonzero overlap, click (75,75):
// - Canvas 2D (nonzero) paints the foreground overlap opaque,
// - Paper `contains` agrees it is filled,
// - so `geometryFallbackHoleProbe` must be `none` (opaque cover), never the
//   background hole. Transparent / fill=none / hidden foreground stays
//   transmissive (hole), evenodd unfilled overlap stays `ambiguous`,
//   edge/clip/mask/class stay fail-closed.
const root = join(import.meta.dir, '..');
const PORT = 4498;
const base = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('fallback z-order cover (real Canvas/Paper)', () => {
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

  it('opaque nonzero foreground overlap covers the background hole', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const BACKGROUND = 'M0 0H200V200H0Z M60 60H90V90H60Z';
      const FOREGROUND = 'M0 0H100V100H0Z M50 50H150V150H50Z';
      const pt = { x: 75, y: 75 };
      // Canvas oracle: foreground overlap alone paints opaque under nonzero.
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#0000ff';
      ctx.fill(new Path2D(FOREGROUND), 'nonzero');
      const fgAlpha = ctx.getImageData(75, 75, 1, 1).data[3]!;
      ctx.clearRect(0, 0, 200, 200);
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(FOREGROUND), 'evenodd');
      const fgEvenoddAlpha = ctx.getImageData(75, 75, 1, 1).data[3]!;
      // Pure helper: overlap is `ambiguous`, but the point is filled nonzero.
      const contours = helper.parseStraightContours(FOREGROUND)!;
      const filledNonzero = helper.isPointFilled(contours as never, pt as never, 'nonzero' as never);
      const filledEvenodd = helper.isPointFilled(contours as never, pt as never, 'evenodd' as never);
      // Paper oracle: nonzero foreground contains the point.
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const fgItem = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path d="${FOREGROUND}" fill="#0000ff"/></svg>`,
      ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
      const paperContains = fgItem.contains(new scope.Point(75, 75));
      fgItem.remove();
      scope.project.clear();
      const build = (fgExtra: string) => {
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/><path d="${FOREGROUND}" ${fgExtra}/></svg>`,
          'image/svg+xml',
        );
        return Array.from((doc.documentElement as unknown as Element).children) as Element[];
      };
      const opaque = paperModule.geometryFallbackHoleProbe(build('fill="#0000ff"'), pt, 0.5);
      const transparent = paperModule.geometryFallbackHoleProbe(build('fill="none"'), pt, 0.5);
      const hidden = paperModule.geometryFallbackHoleProbe(build('fill="#0000ff" display="none"'), pt, 0.5);
      const evenoddUnfilled = paperModule.geometryFallbackHoleProbe(build('fill="#0000ff" fill-rule="evenodd"'), pt, 0.5);
      return { fgAlpha, fgEvenoddAlpha, filledNonzero, filledEvenodd, paperContains, opaque, transparent, hidden, evenoddUnfilled };
    });
    expect(result.fgAlpha).toBeGreaterThan(200);
    expect(result.fgEvenoddAlpha).toBe(0);
    expect(result.filledNonzero).toBe(true);
    expect(result.filledEvenodd).toBe(false);
    expect(result.paperContains).toBe(true);
    // Opaque cover: no hole.
    expect(result.opaque.kind).toBe('none');
    // Transparent / hidden: background hole shines through.
    expect(result.transparent.kind).toBe('hole');
    expect(result.hidden.kind).toBe('hole');
    // Evenodd unfilled overlap: fail-closed.
    expect(result.evenoddUnfilled.kind).toBe('ambiguous');
  }, 30_000);
});
