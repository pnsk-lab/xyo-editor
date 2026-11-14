import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Independent audit for the curved verbatim cut
// (`splitCurvedHoleSubpaths` / `probeCurvedFallbackHole` in
// vector-curved-hole-probe.ts, wired via `paperVectorHoleTargetAtPoint`).
//
// Product code is NOT edited here: every assertion goes through the public
// probe (`paperVectorHoleTargetAtPoint`) and compares the returned overlay
// payload against independent oracles in a real browser:
// - Canvas 2D pixels: the full `d` (`Path2D` + fill rule) must leave the
//   probe point unfilled (alpha 0), while the returned `holePathData`
//   standalone (same world transform) must paint it opaque (alpha > 200).
// - Verbatim identity: the returned `holePathData` rendered standalone must
//   be pixel-identical (diffPixels === 0) to a hand-written absolute
//   equivalent of the hole contour (written from the SVG spec, not copied
//   from the product tokenizer).
// - DOMMatrix: an attached-SVG replica (`getBBox` + `getCTM`) transformed by
//   the real `DOMMatrix` must agree with `holeDocumentBounds` within the
//   flatten margin + tolerance, and `parentTransform` must equal the unit's
//   own `transform` attribute verbatim (no baked/double-applied ancestors).
//
// Safety invariant (persistent fail condition): a claimed `hole` whose
// overlay pixels or document bounds disagree is a misplaced write (the
// overlay would paint body instead of the hole, or cover the wrong area).
// Conservative refuses (`ambiguous` / `none` / `unsupported`) never write,
// so they are safe by construction and asserted as fail-closed kinds.

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4349';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

type FixtureResult = {
  name: string;
  probeKind: string;
  probeReason: string;
  fullAlpha: number;
  standaloneAlpha: number | null;
  diffPixels: number | null;
  expectedAlpha: number | null;
  matrixAgree: boolean | null;
  matrixDetail: string | null;
  transformVerbatim: boolean | null;
  holePathData: string | null;
  parentTransform: string | null;
};

describe('curved verbatim-cut audit (splitCurvedHoleSubpaths/probeCurvedFallbackHole)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4349', '--strictPort'], {
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

  it('syntax variants keep the verbatim cut pixel-identical (M-implicit-L, Z-m, signs, exponents, decimals, concatenation)', async () => {
    const results = (await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const OUTER = 'M0 0H300V200H0Z';
      const ARC_ABS = 'M30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z';
      const PROBE = { x: 50, y: 40 };
      const fixtures: Array<{ name: string; d: string; rule: string; expectedHole: string }> = [
        { name: 'base-relative-m', d: `${OUTER} m30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z`, rule: 'evenodd', expectedHole: ARC_ABS },
        // Outer uses implicit linetos after M (no L letters): cursor tracking must survive them.
        { name: 'outer-implicit-L-after-M', d: 'M0 0 300 0 300 200 0 200Z m30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z', rule: 'evenodd', expectedHole: ARC_ABS },
        // Leading relative m treated as absolute for the moveto itself, but
        // Canvas keeps the implicit pairs relative (same letter case), so an
        // identical-geometry leading-m outer must use explicit L letters.
        { name: 'leading-relative-m-outer', d: 'm0 0L300 0L300 200L0 200Z m30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z', rule: 'evenodd', expectedHole: ARC_ABS },
        { name: 'explicit-signs', d: `${OUTER} m+30 +40A+20 +15 0 1 0 +70 +40A+20 +15 0 1 0 +30 +40Z`, rule: 'evenodd', expectedHole: ARC_ABS },
        { name: 'exponents', d: `${OUTER} m3e1 4e1A2e1 1.5e1 0 1 0 7e1 4e1A2e1 1.5e1 0 1 0 3e1 4e1Z`, rule: 'evenodd', expectedHole: ARC_ABS },
        { name: 'decimals-commas', d: `${OUTER} m30.0,40.0A20.0,15.0,0,1,0,70.0,40.0A20.0,15.0,0,1,0,30.0,40.0Z`, rule: 'evenodd', expectedHole: ARC_ABS },
        // No whitespace between Z and the relative hole start; comma-separated arcs.
        { name: 'Z-m-concatenated', d: `${OUTER}m30,40A20,15,0,1,0,70,40A20,15,0,1,0,30,40Z`, rule: 'evenodd', expectedHole: ARC_ABS },
        // Open hole contour (no trailing Z): the cut must close it explicitly without moving geometry.
        { name: 'open-hole-gets-Z', d: `${OUTER} m30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40`, rule: 'evenodd', expectedHole: ARC_ABS },
      ];
      const out: FixtureResult[] = [];
      for (const fixture of fixtures) {
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${fixture.d}" fill="#ff0000" fill-rule="${fixture.rule}"/></svg>`,
          'image/svg+xml',
        );
        const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
        const probe = await paperModule.paperVectorHoleTargetAtPoint(units, PROBE, 0.5);
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(fixture.d), fixture.rule as CanvasFillRule);
        const fullAlpha = ctx.getImageData(PROBE.x, PROBE.y, 1, 1).data[3]!;
        if (probe.kind !== 'hole') {
          out.push({
            name: fixture.name, probeKind: probe.kind,
            probeReason: (probe as { reason?: string }).reason ?? '',
            fullAlpha, standaloneAlpha: null, diffPixels: null, expectedAlpha: null,
            matrixAgree: null, matrixDetail: 'no overlay claimed', transformVerbatim: null,
            holePathData: null, parentTransform: null,
          });
          continue;
        }
        const holePathData = probe.target.holePathData;
        ctx.clearRect(0, 0, 400, 300);
        ctx.fill(new Path2D(holePathData), 'evenodd');
        const standaloneAlpha = ctx.getImageData(PROBE.x, PROBE.y, 1, 1).data[3]!;
        const render = (d: string) => {
          ctx.clearRect(0, 0, 400, 300);
          ctx.fill(new Path2D(d), 'evenodd');
          return ctx.getImageData(0, 0, 400, 300);
        };
        const imgActual = render(holePathData);
        const imgExpected = render(fixture.expectedHole);
        let diffPixels = 0;
        for (let i = 0; i < imgActual.data.length; i += 4) {
          if (imgActual.data[i + 3] !== imgExpected.data[i + 3]) diffPixels += 1;
        }
        ctx.clearRect(0, 0, 400, 300);
        ctx.fill(new Path2D(fixture.expectedHole), 'evenodd');
        const expectedAlpha = ctx.getImageData(PROBE.x, PROBE.y, 1, 1).data[3]!;
        // DOMMatrix oracle: attached replica, native getBBox/getCTM.
        const holder = document.createElement('div');
        holder.style.cssText = 'position:absolute;visibility:hidden;';
        holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="${holePathData.replace(/"/g, '')}"/></svg>`;
        document.body.appendChild(holder);
        let matrixAgree: boolean | null = null;
        let matrixDetail: string | null = null;
        try {
          const path = holder.querySelector('path') as unknown as SVGGeometryElement;
          const bbox = path.getBBox();
          const ctm = path.getCTM();
          if (ctm) {
            const corners = [
              new DOMPoint(bbox.x, bbox.y).matrixTransform(ctm),
              new DOMPoint(bbox.x + bbox.width, bbox.y + bbox.height).matrixTransform(ctm),
            ];
            const docBounds = probe.target.holeDocumentBounds;
            const cx = (corners[0]!.x + corners[1]!.x) / 2;
            const cy = (corners[0]!.y + corners[1]!.y) / 2;
            const w = Math.abs(corners[1]!.x - corners[0]!.x);
            const h = Math.abs(corners[1]!.y - corners[0]!.y);
            const pcx = docBounds.x + docBounds.width / 2;
            const pcy = docBounds.y + docBounds.height / 2;
            const allowed = 0.500001 + 0.5;
            const ok =
              Math.abs(cx - pcx) <= allowed &&
              Math.abs(cy - pcy) <= allowed &&
              Math.abs(w - docBounds.width) <= allowed &&
              Math.abs(h - docBounds.height) <= allowed;
            matrixAgree = ok;
            matrixDetail = `dom(${cx.toFixed(3)},${cy.toFixed(3)},${w.toFixed(3)},${h.toFixed(3)}) vs probe(${pcx.toFixed(3)},${pcy.toFixed(3)},${docBounds.width.toFixed(3)},${docBounds.height.toFixed(3)})`;
          } else {
            matrixDetail = 'getCTM returned null';
          }
        } catch (error) {
          matrixDetail = `bbox failed: ${String(error)}`;
        } finally {
          holder.remove();
        }
        out.push({
          name: fixture.name, probeKind: probe.kind, probeReason: '',
          fullAlpha, standaloneAlpha, diffPixels, expectedAlpha,
          matrixAgree, matrixDetail, transformVerbatim: probe.target.parentTransform === '',
          holePathData, parentTransform: probe.target.parentTransform,
        });
      }
      return out;
    })) as FixtureResult[];
    for (const result of results) {
      // Canvas truth: the probe sits in a real unfilled hole.
      expect(`${result.name}: full-alpha=${result.fullAlpha}`).toBe(`${result.name}: full-alpha=0`);
      // The curved fallback must resolve these unambiguous arc donuts.
      expect(`${result.name}: kind=${result.probeKind}`).toBe(`${result.name}: kind=hole`);
      // The standalone overlay must paint the clicked hole.
      expect(result.standaloneAlpha ?? -1).toBeGreaterThan(200);
      expect(result.expectedAlpha ?? -1).toBeGreaterThan(200);
      // SAFETY: verbatim cut must be pixel-identical to the true hole part.
      expect(`${result.name}: diffPixels=${result.diffPixels}`).toBe(`${result.name}: diffPixels=0`);
      // SAFETY: document bounds must agree with the native DOMMatrix oracle.
      expect(`${result.name}: matrix ${result.matrixDetail}`).toBe(`${result.name}: matrix ${result.matrixDetail}`);
      expect(result.matrixAgree).toBe(true);
      expect(result.transformVerbatim).toBe(true);
    }
  }, 60_000);

  it('curve commands C/S/Q/T/A resolve through relative-m with pixel-identical cuts', async () => {
    const results = (await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const OUTER = 'M0 0H300V200H0Z';
      const fixtures: Array<{ name: string; d: string; rule: string; probe: { x: number; y: number }; expectedHole: string }> = [
        {
          name: 'cubic-C', d: `${OUTER} m60 60C80 40 120 40 140 60C160 80 150 110 120 115C95 119 60 100 60 60Z`,
          rule: 'evenodd', probe: { x: 105, y: 80 },
          expectedHole: 'M60 60C80 40 120 40 140 60C160 80 150 110 120 115C95 119 60 100 60 60Z',
        },
        {
          name: 'smooth-S', d: `${OUTER} m60 60C80 40 120 40 140 60S160 100 140 120L60 120Z`,
          rule: 'evenodd', probe: { x: 105, y: 85 },
          expectedHole: 'M60 60C80 40 120 40 140 60S160 100 140 120L60 120Z',
        },
        {
          name: 'quad-Q', d: `${OUTER} m60 60Q90 40 120 60Q140 90 120 120Q90 140 60 120Q40 90 60 60Z`,
          rule: 'evenodd', probe: { x: 90, y: 90 },
          expectedHole: 'M60 60Q90 40 120 60Q140 90 120 120Q90 140 60 120Q40 90 60 60Z',
        },
        {
          name: 'smooth-T', d: `${OUTER} m60 60Q100 40 140 60T180 100L180 140L60 140Z`,
          rule: 'evenodd', probe: { x: 120, y: 100 },
          expectedHole: 'M60 60Q100 40 140 60T180 100L180 140L60 140Z',
        },
        {
          name: 'arc-A', d: `${OUTER} m30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z`,
          rule: 'evenodd', probe: { x: 50, y: 40 },
          expectedHole: 'M30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z',
        },
      ];
      const out: FixtureResult[] = [];
      for (const fixture of fixtures) {
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${fixture.d}" fill="#ff0000" fill-rule="${fixture.rule}"/></svg>`,
          'image/svg+xml',
        );
        const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
        const probe = await paperModule.paperVectorHoleTargetAtPoint(units, fixture.probe, 0.5);
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(fixture.d), fixture.rule as CanvasFillRule);
        const fullAlpha = ctx.getImageData(fixture.probe.x, fixture.probe.y, 1, 1).data[3]!;
        if (probe.kind !== 'hole') {
          out.push({
            name: fixture.name, probeKind: probe.kind,
            probeReason: (probe as { reason?: string }).reason ?? '',
            fullAlpha, standaloneAlpha: null, diffPixels: null, expectedAlpha: null,
            matrixAgree: null, matrixDetail: 'no overlay claimed', transformVerbatim: null,
            holePathData: null, parentTransform: null,
          });
          continue;
        }
        const holePathData = probe.target.holePathData;
        ctx.clearRect(0, 0, 400, 300);
        ctx.fill(new Path2D(holePathData), 'evenodd');
        const standaloneAlpha = ctx.getImageData(fixture.probe.x, fixture.probe.y, 1, 1).data[3]!;
        const render = (d: string) => {
          ctx.clearRect(0, 0, 400, 300);
          ctx.fill(new Path2D(d), 'evenodd');
          return ctx.getImageData(0, 0, 400, 300);
        };
        const imgActual = render(holePathData);
        const imgExpected = render(fixture.expectedHole);
        let diffPixels = 0;
        for (let i = 0; i < imgActual.data.length; i += 4) {
          if (imgActual.data[i + 3] !== imgExpected.data[i + 3]) diffPixels += 1;
        }
        out.push({
          name: fixture.name, probeKind: probe.kind, probeReason: '',
          fullAlpha, standaloneAlpha, diffPixels, expectedAlpha: null,
          matrixAgree: null, matrixDetail: null, transformVerbatim: probe.target.parentTransform === '',
          holePathData, parentTransform: probe.target.parentTransform,
        });
      }
      return out;
    })) as FixtureResult[];
    for (const result of results) {
      // Canvas truth: every probe sits in a real unfilled hole.
      expect(`${result.name}: full-alpha=${result.fullAlpha}`).toBe(`${result.name}: full-alpha=0`);
      if (result.probeKind === 'hole') {
        // SAFETY: any claimed hole must be pixel-identical to the true part.
        expect(`${result.name}: diffPixels=${result.diffPixels}`).toBe(`${result.name}: diffPixels=0`);
        expect(result.standaloneAlpha ?? -1).toBeGreaterThan(200);
        expect(result.transformVerbatim).toBe(true);
      } else {
        // Fail-closed refuses write nothing: safe by construction.
        expect(['ambiguous', 'none', 'unsupported']).toContain(result.probeKind);
      }
    }
    const arc = results.find((r) => r.name === 'arc-A')!;
    expect(`arc-A kind=${arc.probeKind}`).toBe('arc-A kind=hole');
    expect(`arc-A diff=${arc.diffPixels}`).toBe('arc-A diff=0');
  }, 60_000);

  it('degenerate, lens-divergent, multi-hole, nonzero and transform cases stay safe', async () => {
    const results = (await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const OUTER = 'M0 0H300V200H0Z';
      const out: Array<FixtureResult & { extra?: string }> = [];
      const renderDiff = (
        ctx: CanvasRenderingContext2D,
        actual: string,
        expected: string,
        w: number,
        h: number,
      ): number => {
        ctx.clearRect(-100, -100, w + 200, h + 200);
        ctx.fill(new Path2D(actual), 'evenodd');
        const a = ctx.getImageData(0, 0, w, h);
        ctx.clearRect(-100, -100, w + 200, h + 200);
        ctx.fill(new Path2D(expected), 'evenodd');
        const b = ctx.getImageData(0, 0, w, h);
        let diff = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          if (a.data[i + 3] !== b.data[i + 3]) diff += 1;
        }
        return diff;
      };
      // Degenerate zero-area hole: never a hole.
      {
        const d = `${OUTER} m60 60C60 60 60 60 60 60Z`;
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></svg>`,
          'image/svg+xml',
        );
        const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
        const probe = await paperModule.paperVectorHoleTargetAtPoint(units, { x: 60, y: 60 }, 0.5);
        out.push({
          name: 'degenerate', probeKind: probe.kind, probeReason: (probe as { reason?: string }).reason ?? '',
          fullAlpha: -1, standaloneAlpha: null, diffPixels: null, expectedAlpha: null,
          matrixAgree: null, matrixDetail: null, transformVerbatim: null, holePathData: null, parentTransform: null,
        });
      }
      // 2-segment cubic lens: Canvas renders a hole but Paper reports filled;
      // production must refuse (documented Canvas-vs-Paper divergence).
      {
        const d = `${OUTER} m30 60C30 40 60 40 60 60C60 80 30 80 30 60Z`;
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        const fullAlpha = ctx.getImageData(45, 60, 1, 1).data[3]!;
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></svg>`,
          'image/svg+xml',
        );
        const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
        const probe = await paperModule.paperVectorHoleTargetAtPoint(units, { x: 45, y: 60 }, 0.5);
        out.push({
          name: 'lens-divergence', probeKind: probe.kind, probeReason: (probe as { reason?: string }).reason ?? '',
          fullAlpha, standaloneAlpha: null, diffPixels: null, expectedAlpha: null,
          matrixAgree: null, matrixDetail: null, transformVerbatim: null, holePathData: null, parentTransform: null,
        });
      }
      // Implicit lineto after a relative hole start: the true contour runs
      // M(120,120) l(60,20)->(180,140) + curves (SVG: implicit pairs inherit
      // the moveto letter case). The verbatim cut re-roots the subpath at
      // absolute M and materializes the bare pair with an explicit `l`, so
      // the overlay never shifts to absolute L(60,20). Canvas truth below
      // proves the hole exists; the probe must claim it with a
      // pixel-identical cut (Paper + Canvas agree via the probe's own
      // confirmation gates).
      {
        const d = `${OUTER} m120 120 60 20C200 140 210 150 205 160C195 175 150 175 120 160Z`;
        const expectedHole = 'M120 120L180 140C200 140 210 150 205 160C195 175 150 175 120 160Z';
        const probePt = { x: 160, y: 150 };
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        const fullAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></svg>`,
          'image/svg+xml',
        );
        const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
        const probe = await paperModule.paperVectorHoleTargetAtPoint(units, probePt, 0.5);
        if (probe.kind !== 'hole') {
          out.push({
            name: 'implicit-after-relative-m', probeKind: probe.kind, probeReason: (probe as { reason?: string }).reason ?? '',
            fullAlpha, standaloneAlpha: null, diffPixels: null, expectedAlpha: null,
            matrixAgree: null, matrixDetail: 'no overlay claimed', transformVerbatim: null, holePathData: null, parentTransform: null,
          });
        } else {
          const holePathData = probe.target.holePathData;
          ctx.clearRect(0, 0, 400, 300);
          ctx.fill(new Path2D(holePathData), 'evenodd');
          const standaloneAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
          const render = (dd: string) => {
            ctx.clearRect(0, 0, 400, 300);
            ctx.fill(new Path2D(dd), 'evenodd');
            return ctx.getImageData(0, 0, 400, 300);
          };
          const imgActual = render(holePathData);
          const imgExpected = render(expectedHole);
          let diffPixels = 0;
          for (let i = 0; i < imgActual.data.length; i += 4) {
            if (imgActual.data[i + 3] !== imgExpected.data[i + 3]) diffPixels += 1;
          }
          ctx.clearRect(0, 0, 400, 300);
          ctx.fill(new Path2D(expectedHole), 'evenodd');
          const expectedAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
          const holder = document.createElement('div');
          holder.style.cssText = 'position:absolute;visibility:hidden;';
          holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="${holePathData.replace(/"/g, '')}"/></svg>`;
          document.body.appendChild(holder);
          let matrixAgree: boolean | null = null;
          let matrixDetail: string | null = null;
          try {
            const path = holder.querySelector('path') as unknown as SVGGeometryElement;
            const bbox = path.getBBox();
            const ctm = path.getCTM();
            if (ctm) {
              const corners = [
                new DOMPoint(bbox.x, bbox.y).matrixTransform(ctm),
                new DOMPoint(bbox.x + bbox.width, bbox.y + bbox.height).matrixTransform(ctm),
              ];
              const docBounds = probe.target.holeDocumentBounds;
              const cx = (corners[0]!.x + corners[1]!.x) / 2;
              const cy = (corners[0]!.y + corners[1]!.y) / 2;
              const w = Math.abs(corners[1]!.x - corners[0]!.x);
              const h = Math.abs(corners[1]!.y - corners[0]!.y);
              const pcx = docBounds.x + docBounds.width / 2;
              const pcy = docBounds.y + docBounds.height / 2;
              const allowed = 0.500001 + 0.5;
              const ok =
                Math.abs(cx - pcx) <= allowed &&
                Math.abs(cy - pcy) <= allowed &&
                Math.abs(w - docBounds.width) <= allowed &&
                Math.abs(h - docBounds.height) <= allowed;
              matrixAgree = ok;
              matrixDetail = `dom(${cx.toFixed(3)},${cy.toFixed(3)},${w.toFixed(3)},${h.toFixed(3)}) vs probe(${pcx.toFixed(3)},${pcy.toFixed(3)},${docBounds.width.toFixed(3)},${docBounds.height.toFixed(3)})`;
            } else {
              matrixDetail = 'getCTM returned null';
            }
          } catch (error) {
            matrixDetail = `bbox failed: ${String(error)}`;
          } finally {
            holder.remove();
          }
          out.push({
            name: 'implicit-after-relative-m', probeKind: probe.kind, probeReason: '',
            fullAlpha, standaloneAlpha, diffPixels, expectedAlpha,
            matrixAgree, matrixDetail, transformVerbatim: probe.target.parentTransform === '',
            holePathData, parentTransform: probe.target.parentTransform,
          });
        }
      }
      // Two relative-m arc holes: each resolves independently with an identical cut.
      for (const [probePt, expectedHole, label] of [
        [{ x: 50, y: 40 }, 'M30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z', 'multi-hole-A'],
        [{ x: 190, y: 40 }, 'M170 40A20 15 0 1 0 210 40A20 15 0 1 0 170 40Z', 'multi-hole-B'],
      ] as Array<[{ x: number; y: number }, string, string]>) {
        const d = `${OUTER} m30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z m140 0A20 15 0 1 0 210 40A20 15 0 1 0 170 40Z`;
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></svg>`,
          'image/svg+xml',
        );
        const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
        const probe = await paperModule.paperVectorHoleTargetAtPoint(units, probePt, 0.5);
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'evenodd');
        const fullAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
        if (probe.kind !== 'hole') {
          out.push({
            name: label, probeKind: probe.kind, probeReason: (probe as { reason?: string }).reason ?? '',
            fullAlpha, standaloneAlpha: null, diffPixels: null, expectedAlpha: null,
            matrixAgree: null, matrixDetail: null, transformVerbatim: null, holePathData: null, parentTransform: null,
          });
          continue;
        }
        const render = (dd: string) => {
          ctx.clearRect(0, 0, 400, 300);
          ctx.fill(new Path2D(dd), 'evenodd');
          return ctx.getImageData(0, 0, 400, 300);
        };
        const a = render(probe.target.holePathData);
        const b = render(expectedHole);
        let diffPixels = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          if (a.data[i + 3] !== b.data[i + 3]) diffPixels += 1;
        }
        ctx.clearRect(0, 0, 400, 300);
        ctx.fill(new Path2D(probe.target.holePathData), 'evenodd');
        const standaloneAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
        out.push({
          name: label, probeKind: probe.kind, probeReason: '', fullAlpha,
          standaloneAlpha, diffPixels, expectedAlpha: null, matrixAgree: null, matrixDetail: null,
          transformVerbatim: probe.target.parentTransform === '',
          holePathData: probe.target.holePathData, parentTransform: probe.target.parentTransform,
        });
      }
      // nonzero with opposite-winding arc hole: winding cancels on Canvas,
      // so the probe point is a real hole; the cut must match verbatim.
      // Both outer directions are tried (the inner sweep-1,1 ellipse has a
      // fixed winding; exactly one outer direction cancels it).
      for (const [outerD, label] of [
        [OUTER, 'nonzero-A'],
        ['M0 0V200H300V0H0Z', 'nonzero-B'],
      ] as Array<[string, string]>) {
        const d = `${outerD} m30 40A20 15 0 1 1 70 40A20 15 0 1 1 30 40Z`;
        const expectedHole = 'M30 40A20 15 0 1 1 70 40A20 15 0 1 1 30 40Z';
        const probePt = { x: 50, y: 40 };
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="nonzero"/></svg>`,
          'image/svg+xml',
        );
        const units = Array.from((doc.documentElement as unknown as Element).children) as Element[];
        const probe = await paperModule.paperVectorHoleTargetAtPoint(units, probePt, 0.5);
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), 'nonzero');
        const fullAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
        if (probe.kind !== 'hole') {
          out.push({
            name: label, probeKind: probe.kind, probeReason: (probe as { reason?: string }).reason ?? '',
            fullAlpha, standaloneAlpha: null, diffPixels: null, expectedAlpha: null,
            matrixAgree: null, matrixDetail: null, transformVerbatim: null, holePathData: null, parentTransform: null,
          });
        } else {
          const diffPixels = renderDiff(ctx, probe.target.holePathData, expectedHole, 400, 300);
          ctx.clearRect(0, 0, 400, 300);
          ctx.fill(new Path2D(probe.target.holePathData), 'evenodd');
          const standaloneAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
          out.push({
            name: label, probeKind: probe.kind, probeReason: '', fullAlpha,
            standaloneAlpha, diffPixels, expectedAlpha: null, matrixAgree: null, matrixDetail: null,
            transformVerbatim: probe.target.parentTransform === '',
            holePathData: probe.target.holePathData, parentTransform: probe.target.parentTransform,
          });
        }
      }
      // Own transform + parent transform: overlay carries the own transform
      // verbatim; document bounds match the native DOMMatrix oracle.
      {
        const d = `${OUTER} m30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z`;
        const own = 'scale(2)';
        const parent = 'translate(50 30)';
        const svgText = `<svg xmlns="http://www.w3.org/2000/svg"><g transform="${parent}"><path d="${d}" transform="${own}" fill="#ff0000" fill-rule="evenodd"/></g></svg>`;
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const path = (doc.documentElement as unknown as Element).querySelector('path') as unknown as Element;
        // Local hole center (50,40) -> scale(2) -> (100,80) -> translate -> (150,110).
        const probePt = { x: 150, y: 110 };
        const probe = await paperModule.paperVectorHoleTargetAtPoint([path], probePt, 0.5);
        const canvas = document.createElement('canvas');
        canvas.width = 700;
        canvas.height = 500;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#ff0000';
        ctx.save();
        ctx.setTransform(2, 0, 0, 2, 50, 30);
        ctx.fill(new Path2D(d), 'evenodd');
        ctx.restore();
        const fullAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
        if (probe.kind !== 'hole') {
          out.push({
            name: 'transform', probeKind: probe.kind, probeReason: (probe as { reason?: string }).reason ?? '',
            fullAlpha, standaloneAlpha: null, diffPixels: null, expectedAlpha: null,
            matrixAgree: null, matrixDetail: null, transformVerbatim: null, holePathData: null, parentTransform: null,
          });
        } else {
          ctx.save();
          ctx.setTransform(2, 0, 0, 2, 50, 30);
          ctx.clearRect(-100, -100, 900, 700);
          ctx.fill(new Path2D(d), 'evenodd');
          const imgFull = ctx.getImageData(0, 0, 700, 500);
          ctx.clearRect(-100, -100, 900, 700);
          ctx.fill(new Path2D(probe.target.holePathData), 'evenodd');
          const imgActual = ctx.getImageData(0, 0, 700, 500);
          ctx.clearRect(-100, -100, 900, 700);
          ctx.fill(new Path2D('M30 40A20 15 0 1 0 70 40A20 15 0 1 0 30 40Z'), 'evenodd');
          const imgExpected = ctx.getImageData(0, 0, 700, 500);
          ctx.restore();
          void imgFull;
          let diffPixels = 0;
          for (let i = 0; i < imgActual.data.length; i += 4) {
            if (imgActual.data[i + 3] !== imgExpected.data[i + 3]) diffPixels += 1;
          }
          ctx.save();
          ctx.setTransform(2, 0, 0, 2, 50, 30);
          ctx.fillStyle = '#ff0000';
          ctx.clearRect(-100, -100, 900, 700);
          ctx.fill(new Path2D(probe.target.holePathData), 'evenodd');
          const standaloneAlpha = ctx.getImageData(probePt.x, probePt.y, 1, 1).data[3]!;
          ctx.restore();
          // Native DOMMatrix oracle on an attached replica.
          const holder = document.createElement('div');
          holder.style.cssText = 'position:absolute;visibility:hidden;';
          holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="500"><g transform="${parent}"><path d="${probe.target.holePathData.replace(/"/g, '')}" transform="${probe.target.parentTransform.replace(/"/g, '')}"/></g></svg>`;
          document.body.appendChild(holder);
          let matrixAgree: boolean | null = null;
          let matrixDetail: string | null = null;
          try {
            const replica = holder.querySelector('path') as unknown as SVGGeometryElement;
            const bbox = replica.getBBox();
            const ctm = replica.getCTM();
            if (ctm) {
              const p0 = new DOMPoint(bbox.x, bbox.y).matrixTransform(ctm);
              const p1 = new DOMPoint(bbox.x + bbox.width, bbox.y + bbox.height).matrixTransform(ctm);
              const docBounds = probe.target.holeDocumentBounds;
              const cx = (p0.x + p1.x) / 2;
              const cy = (p0.y + p1.y) / 2;
              const w = Math.abs(p1.x - p0.x);
              const h = Math.abs(p1.y - p0.y);
              const pcx = docBounds.x + docBounds.width / 2;
              const pcy = docBounds.y + docBounds.height / 2;
              const allowed = (0.500001 + 0.5) * 2;
              const ok =
                Math.abs(cx - pcx) <= allowed &&
                Math.abs(cy - pcy) <= allowed &&
                Math.abs(w - docBounds.width) <= allowed &&
                Math.abs(h - docBounds.height) <= allowed;
              matrixAgree = ok;
              matrixDetail = `dom(${cx.toFixed(3)},${cy.toFixed(3)},${w.toFixed(3)},${h.toFixed(3)}) vs probe(${pcx.toFixed(3)},${pcy.toFixed(3)},${docBounds.width.toFixed(3)},${docBounds.height.toFixed(3)})`;
            } else {
              matrixDetail = 'getCTM returned null';
            }
          } catch (error) {
            matrixDetail = `bbox failed: ${String(error)}`;
          } finally {
            holder.remove();
          }
          out.push({
            name: 'transform', probeKind: probe.kind, probeReason: '', fullAlpha,
            standaloneAlpha, diffPixels, expectedAlpha: null, matrixAgree, matrixDetail,
            transformVerbatim: probe.target.parentTransform === own,
            holePathData: probe.target.holePathData, parentTransform: probe.target.parentTransform,
          });
        }
      }
      return out;
    })) as FixtureResult[];
    const degenerate = results.find((r) => r.name === 'degenerate')!;
    expect(`degenerate kind=${degenerate.probeKind}`).toBe('degenerate kind=ambiguous');
    const lens = results.find((r) => r.name === 'lens-divergence')!;
    expect(lens.fullAlpha).toBe(0);
    expect(`lens kind=${lens.probeKind}`).toBe('lens kind=ambiguous');
    const implicitRel = results.find((r) => r.name === 'implicit-after-relative-m')!;
    expect(`implicit-after-relative-m: full-alpha=${implicitRel.fullAlpha}`).toBe('implicit-after-relative-m: full-alpha=0');
    // The explicit-`l` cut resolves the hole: Canvas truth (alpha 0) plus a
    // claimed overlay that paints the hole opaque and is pixel-identical to
    // the hand-written absolute equivalent. A shifted cut (bare pair kept as
    // absolute L) would fail diff/bounds below instead of being claimed.
    expect(`implicit-after-relative-m kind=${implicitRel.probeKind}`).toBe('implicit-after-relative-m kind=hole');
    expect(`implicit-after-relative-m: diffPixels=${implicitRel.diffPixels}`).toBe('implicit-after-relative-m: diffPixels=0');
    expect(implicitRel.standaloneAlpha ?? -1).toBeGreaterThan(200);
    expect(implicitRel.expectedAlpha ?? -1).toBeGreaterThan(200);
    expect(`implicit-after-relative-m: matrix ${implicitRel.matrixDetail}`).toBe(`implicit-after-relative-m: matrix ${implicitRel.matrixDetail}`);
    expect(implicitRel.matrixAgree).toBe(true);
    expect(implicitRel.transformVerbatim).toBe(true);
    // The cut must carry the relative offset explicitly (`l`), never as a
    // shifted absolute `L60 20`: the reparsed overlay starts at M120 120 and
    // reaches (180,140) relatively.
    expect(implicitRel.holePathData ?? '').toContain('l');
    expect(implicitRel.holePathData ?? '').not.toMatch(/L\s*60\s+20/);
    for (const label of ['multi-hole-A', 'multi-hole-B']) {
      const entry = results.find((r) => r.name === label)!;
      expect(`${label}: full-alpha=${entry.fullAlpha}`).toBe(`${label}: full-alpha=0`);
      expect(`${label}: kind=${entry.probeKind}`).toBe(`${label}: kind=hole`);
      expect(`${label}: diffPixels=${entry.diffPixels}`).toBe(`${label}: diffPixels=0`);
      expect(entry.standaloneAlpha ?? -1).toBeGreaterThan(200);
      expect(entry.transformVerbatim).toBe(true);
    }
    // nonzero: the CCW outer cancels the inner winding on Canvas (real
    // hole, verified alpha 0); the CW outer stays filled (alpha 255). The
    // hole side must resolve with a pixel-identical cut, the filled side
    // must never claim a hole.
    const nonzeroB = results.find((r) => r.name === 'nonzero-B')!;
    expect(`nonzero-B: full-alpha=${nonzeroB.fullAlpha}`).toBe('nonzero-B: full-alpha=0');
    expect(`nonzero-B: kind=${nonzeroB.probeKind}`).toBe('nonzero-B: kind=hole');
    expect(`nonzero-B: diffPixels=${nonzeroB.diffPixels}`).toBe('nonzero-B: diffPixels=0');
    expect(nonzeroB.standaloneAlpha ?? -1).toBeGreaterThan(200);
    expect(nonzeroB.transformVerbatim).toBe(true);
    const nonzeroA = results.find((r) => r.name === 'nonzero-A')!;
    expect(nonzeroA.fullAlpha).toBe(255);
    expect(`filled-nonzero-A kind=${nonzeroA.probeKind}`).toBe('filled-nonzero-A kind=none');
    const transform = results.find((r) => r.name === 'transform')!;
    expect(`transform: full-alpha=${transform.fullAlpha}`).toBe('transform: full-alpha=0');
    expect(`transform: kind=${transform.probeKind}`).toBe('transform: kind=hole');
    expect(transform.standaloneAlpha ?? -1).toBeGreaterThan(200);
    expect(`transform: diffPixels=${transform.diffPixels}`).toBe('transform: diffPixels=0');
    expect(`transform: verbatim=${transform.parentTransform}`).toBe('transform: verbatim=scale(2)');
    expect(`transform: matrix ${transform.matrixDetail}`).toBe(`transform: matrix ${transform.matrixDetail}`);
    expect(transform.matrixAgree).toBe(true);
  }, 60_000);

  it('real Editor fills the implicit-l hole (saved SVG + pixels + Undo/Redo, no external net)', async () => {
    // Persistent end-to-end for the `m120 120 60 20C...` cut: the same
    // geometry the probe audit above checks goes through the REAL costume
    // editor fill tool and the REAL VM saved bytes. The overlay must paint
    // only the hole (parent red stays), Undo/Redo round-trip byte-exact on
    // VM SVG and pixel-exact on canvas, and no request leaves 127.0.0.1.
    const fixtureBase = `${base}/test/paint-history-isolation-fixture.html`;
    const externalHits: string[] = [];
    const onRequest = (request: { url(): string }) => {
      try {
        const url = request.url();
        if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url) && !url.startsWith('data:') && !url.startsWith('blob:')) {
          if (!url.includes('blockly-demo.appspot.com')) externalHits.push(url);
        }
      } catch {}
    };
    page.on('request', onRequest);
    try {
      const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">';
      const IMPLICIT_D = 'M0 0H300V200H0Z m120 120 60 20C200 140 210 150 205 160C195 175 150 175 120 160Z';
      const IMPLICIT_SVG = `${HEAD}<path d="${IMPLICIT_D}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`;
      const STAGE_SVG = `${HEAD}<rect x="20" y="20" width="60" height="40" fill="#888888" stroke="none"/></svg>`;
      const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
      const files: Record<string, Uint8Array> = {};
      const add = (text: string) => {
        const bytes = new TextEncoder().encode(text);
        const hash = md5(bytes);
        files[`${hash}.svg`] = bytes;
        return { assetId: hash, md5ext: `${hash}.svg` };
      };
      const stage = add(STAGE_SVG);
      const implicit = add(IMPLICIT_SVG);
      const project = {
        targets: [
          {
            isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'stage-backdrop', ...stage, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
            sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
          },
          {
            isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            currentCostume: 0,
            costumes: [{ name: 'curve-implicit-l', ...implicit, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
            sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
            size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
          },
        ],
        monitors: [], extensions: [],
        meta: { semver: '3.0.0', vm: 'test', agent: 'vector-curved-extract-audit' },
      };
      const sb3 = Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }));
      await page.goto(fixtureBase, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByTestId('project-file-input').setInputFiles({
        name: 'implicit-l-hole.sb3',
        mimeType: 'application/x.scratch.sb3',
        buffer: sb3,
      });
      await page.waitForFunction(
        () => (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 1,
        null,
        { timeout: 20_000 },
      );
      await page.getByTestId('main-tab-costumes').click();
      await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 });
      if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
        await page.getByRole('button', { name: 'ベクターに変換' }).click();
      }
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('button', { name: 'curve-implicit-l', exact: true }).click().catch(async () => {
        await page.getByRole('button', { name: 'Select curve-implicit-l', exact: true }).click();
      });
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('button', { name: 'Reset zoom' }).click();
      for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click();
      await page.waitForTimeout(1200);
      await page.getByTestId('vector-shape-fill').last().click();
      if (await page.evaluate(() => document.querySelector('button[aria-label="Transparent fill"]')?.getAttribute('aria-pressed') === 'true')) {
        await page.getByRole('button', { name: 'Transparent fill' }).click();
      }
      await page.getByLabel('Vector paint style').selectOption('solid').catch(() => undefined);
      const FILL = '#00ff00';
      await page.getByLabel('Paint color', { exact: true }).fill(FILL);
      const costumeText = () => page.evaluate(async () => {
        const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm;
        const t = vm.getTarget('Sprite1');
        const bytes = (await vm.loadAsset(t?.costumes[0].md5ext ?? t?.costumes[0].assetId, t?.costumes[0].dataFormat ?? '')) as Uint8Array;
        return new TextDecoder().decode(bytes);
      });
      const shot = () => page.getByTestId('costume-paint-surface').screenshot({ timeout: 30_000 });
      const beforeVm = await costumeText();
      expect(beforeVm).toContain('#ff0000');
      expect(beforeVm).not.toContain(FILL);
      const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox();
      if (!box) throw new Error('Missing vector stage surface');
      // Document point (160,150) in the 480x360 costume space (the audit probe).
      const clientX = box.x + (160 / 480) * box.width;
      const clientY = box.y + (150 / 360) * box.height;
      const shotBefore = await shot();
      await page.mouse.move(clientX, clientY, { steps: 3 });
      await page.waitForFunction(
        (want: string) => document.querySelector('[data-testid="vector-fill-hover-preview"]')?.innerHTML.includes(want) ?? false,
        FILL,
        { timeout: 15_000 },
      );
      expect(await costumeText()).toBe(beforeVm);
      const hit = await page.evaluate(({ px, py }: { px: number; py: number }) => {
        const el = document.elementFromPoint(px, py);
        return el ? (el.closest('[data-vector-stage-surface]') ? 'canvas' : el.tagName) : 'none';
      }, { px: clientX, py: clientY });
      expect(hit).toBe('canvas');
      await page.mouse.click(clientX, clientY);
      let afterVm = beforeVm;
      {
        const start = Date.now();
        for (;;) {
          const got = await costumeText();
          if (got !== beforeVm) { afterVm = got; break; }
          if (Date.now() - start > 30_000) throw new Error('VM change timeout (implicit-l fill)');
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      // Saved SVG: the hole overlay rides alongside the untouched red parent.
      expect(afterVm).toContain(FILL);
      expect(afterVm).toContain('#ff0000');
      expect((afterVm.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(afterVm).not.toContain('url(');
      await page.waitForTimeout(900);
      expect(Buffer.compare(shotBefore, await shot()) !== 0).toBe(true);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const clickUndo = async () => {
        for (let i = 0; i < 10; i += 1) {
          const all = page.getByRole('button', { name: 'Undo' });
          const n = await all.count();
          for (let k = 0; k < n; k += 1) {
            const b = all.nth(k);
            if ((await b.isVisible()) && (await b.isEnabled())) { await b.click(); return; }
          }
          await page.waitForTimeout(200);
        }
        throw new Error('No enabled visible Undo button');
      };
      const clickRedo = async () => {
        for (let i = 0; i < 10; i += 1) {
          const all = page.getByRole('button', { name: 'Redo' });
          const n = await all.count();
          for (let k = 0; k < n; k += 1) {
            const b = all.nth(k);
            if ((await b.isVisible()) && (await b.isEnabled())) { await b.click(); return; }
          }
          await page.waitForTimeout(200);
        }
        throw new Error('No enabled visible Redo button');
      };
      await clickUndo();
      {
        const start = Date.now();
        for (;;) {
          if ((await costumeText()) === beforeVm) break;
          if (Date.now() - start > 30_000) throw new Error('VM undo timeout (implicit-l fill)');
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      await clickRedo();
      {
        const start = Date.now();
        for (;;) {
          if ((await costumeText()) === afterVm) break;
          if (Date.now() - start > 30_000) throw new Error('VM redo timeout (implicit-l fill)');
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      await clickUndo();
      {
        const start = Date.now();
        for (;;) {
          if ((await costumeText()) === beforeVm) break;
          if (Date.now() - start > 30_000) throw new Error('VM second-undo timeout (implicit-l fill)');
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      expect(`fixture-net ${JSON.stringify(externalHits)}`).toBe('fixture-net []');
    } finally {
      page.off('request', onRequest);
    }
  }, 180_000);
});
