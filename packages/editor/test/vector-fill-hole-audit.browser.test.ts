import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Independent-audit regression coverage for the multi-hole fallback.
//
// Every claim is checked against three oracles in a real browser:
// - Canvas 2D pixels (`Path2D` + `fill(rule)` alpha via `getImageData`),
// - Paper.js entity (`importSVG` + `contains` / `hitTest`),
// - the pure helper + `geometryFallbackHoleProbe` / `paperVector*` probes.
//
// Fail-closed contract: any computed-semantics mismatch (default rule,
// root/style/class/inheritance, `url()`, invisibility, non-uniform screen
// tolerance, upper cover) is `ambiguous` / `unsupported` / `none` — never a
// hole overlay (never a parent recolor). Existing safe SVG (explicit
// `evenodd`, no class, no clip) keeps resolving.

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4492';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('multi-hole fallback audit (Canvas/Paper/computed semantics)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4492', '--strictPort'], {
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

  it('default nonzero same-direction double is filled (parent repaint only, no hole overlay)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      // Same-direction double: outer + identical inner winding.
      const d = 'M0 0H100V100H0Z M10 10H90V90H10Z';
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      // No explicit fill-rule -> SVG default nonzero -> filled.
      ctx.fill(new Path2D(d), 'nonzero');
      const centerAlpha = ctx.getImageData(50, 50, 1, 1).data[3]!;
      const helperMissing = helper.classifyHolePoint({ pathData: d, point: { x: 50, y: 50 } });
      const helperNonzero = helper.classifyHolePoint({ pathData: d, point: { x: 50, y: 50 }, fillRule: 'nonzero' });
      const helperEvenodd = helper.classifyHolePoint({ pathData: d, point: { x: 50, y: 50 }, fillRule: 'evenodd' });
      // Fallback with no fill-rule attr (default nonzero): no hole.
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000"/></svg>`,
        'image/svg+xml',
      );
      const svg = doc.documentElement as unknown as Element;
      const units = Array.from(svg.children) as Element[];
      const fallback = paperModule.geometryFallbackHoleProbe(units, { x: 50, y: 50 }, 0.5);
      // Paper entity with default (no fill-rule attr) also filled.
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const item = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path d="${d}" fill="red"/></svg>`,
      ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
      const paperContains = item.contains(new scope.Point(50, 50));
      item.remove();
      scope.project.clear();
      return { centerAlpha, helperMissing, helperNonzero, helperEvenodd, fallback, paperContains };
    });
    // Canvas nonzero renders the double-nested interior opaque.
    expect(result.centerAlpha).toBeGreaterThan(200);
    // Helper defaults to nonzero: filled, never a hole.
    expect(result.helperMissing.kind).toBe('filled');
    expect(result.helperNonzero.kind).toBe('filled');
    // Explicit evenodd would be a hole (parity) — the audit distinction.
    expect(result.helperEvenodd.kind).toBe('hole');
    // Fallback claims no hole: the click is a parent repaint, no overlay.
    expect(result.fallback.kind).toBe('none');
    // Paper agrees it is filled.
    expect(result.paperContains).toBe(true);
  }, 30_000);

  it('svg-root fill-rule inherits (root evenodd -> hole, root missing -> nonzero filled)', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M0 0H100V100H0Z M10 10H90V90H10Z';
      const docEvenodd = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" fill-rule="evenodd"><path d="${d}" fill="#ff0000"/></svg>`,
        'image/svg+xml',
      );
      const unitsEvenodd = Array.from((docEvenodd.documentElement as unknown as Element).children) as Element[];
      const holeEvenodd = paperModule.geometryFallbackHoleProbe(unitsEvenodd, { x: 50, y: 50 }, 0.5);
      const docRootStyle = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd"><path d="${d}" fill="#ff0000"/></svg>`,
        'image/svg+xml',
      );
      const unitsRootStyle = Array.from((docRootStyle.documentElement as unknown as Element).children) as Element[];
      const holeRootStyle = paperModule.geometryFallbackHoleProbe(unitsRootStyle, { x: 50, y: 50 }, 0.5);
      const docMissing = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000"/></svg>`,
        'image/svg+xml',
      );
      const unitsMissing = Array.from((docMissing.documentElement as unknown as Element).children) as Element[];
      const holeMissing = paperModule.geometryFallbackHoleProbe(unitsMissing, { x: 50, y: 50 }, 0.5);
      return { holeEvenodd, holeRootStyle, holeMissing };
    });
    expect(result.holeEvenodd.kind).toBe('hole');
    expect(result.holeRootStyle.kind).toBe('hole');
    expect(result.holeMissing.kind).toBe('none');
  }, 30_000);

  it('inline style beats presentation attributes (style red vs attr none, style none vs attr red)', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M150 90H330V270H150Z M210 150H270V210H210Z';
      const pt = { x: 240, y: 180 };
      const docStyleRed = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" style="fill:#ff0000" fill-rule="evenodd"/></svg>`,
        'image/svg+xml',
      );
      const unitsStyleRed = Array.from((docStyleRed.documentElement as unknown as Element).children) as Element[];
      const styleRed = paperModule.geometryFallbackHoleProbe(unitsStyleRed, pt, 0.5);
      const docStyleNone = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" style="fill:none" fill-rule="evenodd"/></svg>`,
        'image/svg+xml',
      );
      const unitsStyleNone = Array.from((docStyleNone.documentElement as unknown as Element).children) as Element[];
      const styleNone = paperModule.geometryFallbackHoleProbe(unitsStyleNone, pt, 0.5);
      // fill-rule via style also wins over the attribute.
      const docRuleStyle = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="nonzero" style="fill-rule:evenodd"/></svg>`,
        'image/svg+xml',
      );
      const unitsRuleStyle = Array.from((docRuleStyle.documentElement as unknown as Element).children) as Element[];
      const ruleStyle = paperModule.geometryFallbackHoleProbe(unitsRuleStyle, pt, 0.5);
      // Canvas oracle: style red paints (hole transparent), style none is empty.
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.fill(new Path2D(d), 'evenodd');
      const holeAlpha = ctx.getImageData(240, 180, 1, 1).data[3]!;
      return { styleRed, styleNone, ruleStyle, holeAlpha };
    });
    expect(result.holeAlpha).toBe(0);
    // style="fill:red" over attr none -> painted parent -> hole overlay.
    expect(result.styleRed.kind).toBe('hole');
    // style="fill:none" over attr red -> unfilled parent -> no hole.
    expect(result.styleNone.kind).toBe('none');
    // style fill-rule evenodd over attr nonzero -> hole.
    expect(result.ruleStyle.kind).toBe('hole');
  }, 30_000);

  it('class-driven paint is fail-closed (hole -> unsupported), style-only stays resolving', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M150 90H330V270H150Z M210 150H270V210H210Z';
      const pt = { x: 240, y: 180 };
      const docClass = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><style>.painted{fill:#ff0000}</style><path d="${d}" fill="#ff0000" fill-rule="evenodd" class="painted"/></svg>`,
        'image/svg+xml',
      );
      const unitsClass = Array.from((docClass.documentElement as unknown as Element).children).filter(
        (el) => (el as Element).tagName.toLowerCase() === 'path',
      ) as Element[];
      const classed = paperModule.geometryFallbackHoleProbe(unitsClass, pt, 0.5);
      const docStyle = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" style="fill:#ff0000"/></svg>`,
        'image/svg+xml',
      );
      const unitsStyle = Array.from((docStyle.documentElement as unknown as Element).children) as Element[];
      const styled = paperModule.geometryFallbackHoleProbe(unitsStyle, pt, 0.5);
      return { classed, styled };
    });
    // Stylesheet could repaint via the class: detached DOM cannot compute it.
    expect(result.classed.kind).toBe('unsupported');
    // Pure inline style with no class still resolves.
    expect(result.styled.kind).toBe('hole');
  }, 30_000);

  it('inherited url() paint is unsupported (group gradient covers the hole)', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M150 90H330V270H150Z M210 150H270V210H210Z';
      const pt = { x: 240, y: 180 };
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><g fill="url(#g)"><path d="${d}" fill-rule="evenodd"/></g></svg>`,
        'image/svg+xml',
      );
      const svg = doc.documentElement as unknown as Element;
      const g = svg.children[1] as Element;
      const path = g.children[0] as Element;
      const inherited = paperModule.geometryFallbackHoleProbe([path], pt, 0.5);
      return { inherited };
    });
    expect(result.inherited.kind).toBe('unsupported');
  }, 30_000);

  it('invisible units never claim holes (display/visibility/opacity/fill-opacity)', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const d = 'M150 90H330V270H150Z M210 150H270V210H210Z';
      const pt = { x: 240, y: 180 };
      const cases: Record<string, string> = {
        displayAttr: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" display="none"/></svg>`,
        displayStyle: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" style="display:none"/></svg>`,
        visibilityAttr: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" visibility="hidden"/></svg>`,
        visibilityStyle: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" style="visibility:hidden"/></svg>`,
        opacityAttr: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" opacity="0"/></svg>`,
        opacityStyle: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" style="opacity:0"/></svg>`,
        fillOpacity: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" fill-opacity="0"/></svg>`,
        groupDisplay: `<svg xmlns="http://www.w3.org/2000/svg"><g display="none"><path d="${d}" fill="#ff0000" fill-rule="evenodd"/></g></svg>`,
      };
      const out: Record<string, string> = {};
      for (const [key, text] of Object.entries(cases)) {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const svg = doc.documentElement as unknown as Element;
        const path = (
          key === 'groupDisplay'
            ? (svg.children[0] as Element).children[0] as Element
            : (svg.children[0] as Element)
        );
        out[key] = paperModule.geometryFallbackHoleProbe([path], pt, 0.5).kind;
      }
      // Paper body probe also skips hidden units (no stolen hits).
      const hiddenDoc = new DOMParser().parseFromString(cases.displayAttr!, 'image/svg+xml');
      const hiddenUnits = Array.from((hiddenDoc.documentElement as unknown as Element).children) as Element[];
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const bodyHidden = await paperModule.paperVectorFillTargetAtPoint(hiddenUnits, pt, 0.5);
      const holeHidden = await paperModule.paperVectorHoleTargetAtPoint(hiddenUnits, pt, 0.5);
      scope.project.clear();
      return { out, bodyHidden, holeHidden };
    });
    for (const [key, kind] of Object.entries(result.out)) {
      expect(kind).toBe('none');
    }
    expect(result.bodyHidden).toBeNull();
    expect(result.holeHidden.kind).toBe('none');
  }, 30_000);

  it('scale(4 1) keeps document-space tolerance fail-closed (center hole, edge ambiguous)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      // Outer 0,0,100x100 with 20,20,40x40 hole; non-uniform world scale(4 1).
      const d = 'M0 0H100V100H0Z M20 20H60V60H20Z';
      const world = helper.parseSvgTransformList('scale(4 1)')!;
      // Hole center local (40,40) -> document (160,40).
      const center = helper.classifyHolePoint({ pathData: d, point: { x: 160, y: 40 }, fillRule: 'evenodd', worldMatrix: world, tolerance: 0.5 });
      // Near-edge local: 0.4 left of the hole edge (x=19.6 local, doc 78.4).
      // Document distance 1.6 would look interior under a uniform rule, but
      // the local 0.4 sits inside the exclusion zone -> ambiguous.
      const edge = helper.classifyHolePoint({ pathData: d, point: { x: 78.4, y: 40 }, fillRule: 'evenodd', worldMatrix: world, tolerance: 0.5 });
      const localTol = helper.localToleranceForHoleMatrix(world, 0.5);
      // Canvas oracle draws the scaled shape and reads the same document pixels.
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 200;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ff0000';
      ctx.save();
      ctx.scale(4, 1);
      ctx.fill(new Path2D(d), 'evenodd');
      ctx.restore();
      const centerAlpha = ctx.getImageData(160, 40, 1, 1).data[3]!;
      return { center, edge, localTol, centerAlpha };
    });
    expect(result.centerAlpha).toBe(0);
    expect(result.center.kind).toBe('hole');
    // Widened local exclusion (tolerance / sMin = 0.5) refuses the edge.
    expect(result.localTol).toBeCloseTo(0.5, 6);
    expect(result.edge.kind).toBe('ambiguous');
  }, 30_000);

  it('upper opaque cover wins (hole+body -> no overlay), upper transparent keeps the hole', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const outer = 'M150 110H330V250H150Z';
      const holeA = 'M170 130H210V170H170Z';
      const holeB = 'M270 130H310V170H270Z';
      const d = `${outer} ${holeA} ${holeB}`;
      const ptA = { x: 190, y: 150 };
      // Opaque blue rect on top covering hole A.
      const coverDoc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" stroke="none"/><rect x="160" y="120" width="60" height="60" fill="#0000ff" stroke="none"/></svg>`,
        'image/svg+xml',
      );
      const coverUnits = Array.from((coverDoc.documentElement as unknown as Element).children) as Element[];
      const coverBody = await paperModule.paperVectorFillTargetAtPoint(coverUnits, ptA, 0.5);
      const coverHole = await paperModule.paperVectorHoleTargetAtPoint(coverUnits, ptA, 0.5);
      // Editor.svelte ordering: the topmost body wins. Hole parentIndex 0 sits
      // below body index 1, so the click recolors the opaque cover (no hole
      // overlay). A hole above a body would be the overlap no-op instead.
      const coverBlocked = coverHole.kind === 'hole' && coverBody !== null && coverBody.index === 1 && coverHole.target.parentIndex === 0
        ? 'body-recolor-upper-wins'
        : `${coverHole.kind}/${coverBody?.index ?? 'nobody'}`;
      // Transparent rect on top (fill none): hole stays fillable.
      const clearDoc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#ff0000" fill-rule="evenodd" stroke="none"/><rect x="160" y="120" width="60" height="60" fill="none" stroke="none"/></svg>`,
        'image/svg+xml',
      );
      const clearUnits = Array.from((clearDoc.documentElement as unknown as Element).children) as Element[];
      const clearBody = await paperModule.paperVectorFillTargetAtPoint(clearUnits, ptA, 0.5);
      const clearHole = await paperModule.paperVectorHoleTargetAtPoint(clearUnits, ptA, 0.5);
      const clearDecision = clearHole.kind === 'hole' && clearBody === null ? 'hole-overlay' : `${clearHole.kind}/${clearBody?.index ?? 'nobody'}`;
      return { coverBody, coverHole, coverBlocked, clearBody, clearHole, clearDecision };
    });
    // Opaque cover: body wins on top; the hole below must not overlay.
    expect(result.coverBody?.index).toBe(1);
    expect(result.coverBlocked).toBe('body-recolor-upper-wins');
    // Transparent cover paints nothing: body misses, the hole overlays.
    expect(result.clearBody).toBeNull();
    expect(result.clearHole.kind).toBe('hole');
    expect(result.clearDecision).toBe('hole-overlay');
  }, 30_000);
});
