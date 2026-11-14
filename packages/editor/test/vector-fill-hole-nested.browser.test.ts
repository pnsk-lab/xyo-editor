import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Nested-island pixel-oracle comparison (straight laminar subset only).
//
// Oracles (all real, in a real browser):
// - Canvas 2D: `Path2D(d)` filled with `evenodd`/`nonzero`, alpha via
//   `getImageData` (rendered-truth pixel).
// - Paper.js entity: the real `paper` project import + `contains` / `hitTest`
//   for the same SVG (vector-model truth).
// - Helper: pure `classifyHolePoint` verdicts (candidate under test).
//
// Contract:
// - Innermost hole interiors, island interiors, bodies, and outsides agree
//   across all three (away from edges by >= tolerance).
// - Outer rings that contain an island are INTENTIONAL disagreements: Canvas
//   and Paper report unfilled, the helper reports `ambiguous` (fail-closed)
//   because a solid single-path overlay would cover the island.
// - Edge-adjacent pixels, overlaps, contact, and self-intersections refuse.
// - Unknown CSS/clip/mask mixing is enumerated as unsupported (fail-closed).
// - Sanitizer gates hold (no script passthrough before any Paper import).

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4339';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('nested island pixel oracle (Canvas + Paper vs helper)', () => {
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

  it('4-level evenodd nest agrees on hole/island/body/outside; outer ring safely refuses', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
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
      const canvasInner = alphaAt(100, 100);
      const canvasIsland = alphaAt(70, 100);
      const canvasOuterRing = alphaAt(40, 100);
      const canvasBody = alphaAt(10, 10);
      const canvasOutside = alphaAt(250, 100);
      const helperInner = helper.classifyHolePoint({ pathData: d, point: { x: 100, y: 100 }, fillRule: 'evenodd' });
      const helperIsland = helper.classifyHolePoint({ pathData: d, point: { x: 70, y: 100 }, fillRule: 'evenodd' });
      const helperOuterRing = helper.classifyHolePoint({ pathData: d, point: { x: 40, y: 100 }, fillRule: 'evenodd' });
      const helperBody = helper.classifyHolePoint({ pathData: d, point: { x: 10, y: 10 }, fillRule: 'evenodd' });
      const helperOutside = helper.classifyHolePoint({ pathData: d, point: { x: 250, y: 100 }, fillRule: 'evenodd' });
      const scope = await paperVector.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><path d="${d}" fill="red" fill-rule="evenodd"/></svg>`,
      ) as unknown as { contains: (point: unknown) => boolean; remove: () => void };
      const paperInner = item.contains(new scope.Point(100, 100));
      const paperIsland = item.contains(new scope.Point(70, 100));
      const paperOuterRing = item.contains(new scope.Point(40, 100));
      const paperBody = item.contains(new scope.Point(10, 10));
      item.remove();
      scope.project.clear();
      return {
        canvasInner, canvasIsland, canvasOuterRing, canvasBody, canvasOutside,
        helperInner, helperIsland, helperOuterRing, helperBody, helperOutside,
        paperInner, paperIsland, paperOuterRing, paperBody,
      };
    });
    // Canvas truth: inner hole + outer ring transparent; island + body opaque.
    expect(result.canvasInner).toBe(0);
    expect(result.canvasOuterRing).toBe(0);
    expect(result.canvasIsland).toBeGreaterThan(200);
    expect(result.canvasBody).toBeGreaterThan(200);
    expect(result.canvasOutside).toBe(0);
    // Paper agrees on paint state.
    expect(result.paperInner).toBe(false);
    expect(result.paperOuterRing).toBe(false);
    expect(result.paperIsland).toBe(true);
    expect(result.paperBody).toBe(true);
    // Helper: innermost hole resolves, island/body/outside match, outer ring
    // intentionally refuses (solid overlay would cover the island).
    expect(result.helperInner.kind).toBe('hole');
    if (result.helperInner.kind === 'hole') {
      expect(result.helperInner.holeIndex).toBe(3);
      expect(result.helperInner.outerIndex).toBe(2);
    }
    expect(result.helperIsland.kind).toBe('filled');
    expect(result.helperBody.kind).toBe('filled');
    expect(result.helperOutside.kind).toBe('outside');
    expect(result.helperOuterRing.kind).toBe('ambiguous');
  }, 30_000);

  it('nonzero reversed winding cancels to a hole; same direction stays filled', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const alternating = 'M0 0H200V200H0Z M30 30V170H170V30H30Z M60 60H140V140H60Z M90 90V110H110V90H90Z';
      const sameDir = 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z';
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaOf = (d: string, rule: CanvasFillRule) => {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), rule);
        return ctx.getImageData(100, 100, 1, 1).data[3]!;
      };
      const canvasAlt = alphaOf(alternating, 'nonzero');
      const canvasSame = alphaOf(sameDir, 'nonzero');
      const helperAlt = helper.classifyHolePoint({ pathData: alternating, point: { x: 100, y: 100 }, fillRule: 'nonzero' });
      const helperSame = helper.classifyHolePoint({ pathData: sameDir, point: { x: 100, y: 100 }, fillRule: 'nonzero' });
      const helperAltEven = helper.classifyHolePoint({ pathData: alternating, point: { x: 100, y: 100 }, fillRule: 'evenodd' });
      return { canvasAlt, canvasSame, helperAlt, helperSame, helperAltEven };
    });
    expect(result.canvasAlt).toBe(0);
    expect(result.canvasSame).toBeGreaterThan(200);
    expect(result.helperAlt.kind).toBe('hole');
    expect(result.helperSame.kind).toBe('filled');
    expect(result.helperAltEven.kind).toBe('hole');
  }, 30_000);

  it('overlap / contact / self-intersection / edge refuse; sanitize holds', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const sanitize = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts');
      const overlap = helper.classifyHolePoint({ pathData: 'M0 0H100V100H0Z M50 50H150V150H50Z', point: { x: 75, y: 75 }, fillRule: 'evenodd' });
      const touch = helper.classifyHolePoint({ pathData: 'M0 0H200V200H0Z M20 20H60V60H20Z M60 20H100V60H60Z', point: { x: 40, y: 40 }, fillRule: 'evenodd' });
      const bowtie = helper.classifyHolePoint({ pathData: 'M0 0H200V200H0Z M40 40L160 40L40 160L160 160Z', point: { x: 100, y: 100 }, fillRule: 'evenodd' });
      const edge = helper.classifyHolePoint({ pathData: 'M0 0H200V200H0Z M30 30H170V170H30Z M60 60H140V140H60Z M90 90H110V110H90Z', point: { x: 90.2, y: 100 }, fillRule: 'evenodd', tolerance: 0.5 });
      const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0H10V10H0Z"/></svg>';
      const clean = sanitize.sanitizeSvgForPaperImport(dirty);
      return {
        overlap, touch, bowtie, edge,
        scriptStripped: !clean.includes('<script'),
        clipDeclined: helper.isUnitEligibleForHoleGeometry({ tag: 'path', clipPath: 'url(#c)' }),
        nestedCases: (helper as unknown as { NESTED_HOLE_UNSUPPORTED_CASES?: readonly string[] }).NESTED_HOLE_UNSUPPORTED_CASES,
        holeCases: helper.HOLE_GEOMETRY_UNSUPPORTED_CASES,
      };
    });
    expect(result.overlap.kind).toBe('ambiguous');
    expect(result.touch.kind).toBe('ambiguous');
    expect(result.bowtie.kind).toBe('ambiguous');
    expect(result.edge.kind).toBe('ambiguous');
    expect(result.scriptStripped).toBe(true);
    expect(result.clipDeclined.eligible).toBe(false);
    expect(result.holeCases.join('\n')).toContain('innermost');
  }, 30_000);
});
