import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Real Paper.js / DOM comparison for the vector fill-tool hover gap.
//
// Reference behavior (reimplemented from behavior notes, no upstream source
// copied): a fill hit on a plain open path without fill is rejected (stroke
// hits still accepted), closed/filled/almost-closed paths and text accept,
// transparent-solid paint alone hits invisible outlines, compound holes use
// an overlay (transparent hole fill is a no-op), and helpers/selected/guides
// are never targets with a zoom-aware 2/zoom tolerance.
//
// Verified against real Paper.js in this repo (stock `paper` 0.12.18, see
// assertions below):
// - Stock Paper has no `hitUnfilledPaths` / `hitUnstrokedPaths` options (they
//   are @scratch/paper fork extensions and silently no-op here): an open
//   path interior never reports a fill hit, while the reference relies on the
//   fork to surface such hits and then gates them via `match`.
// - Stock `hitTestAll` never returns compound-hole children: the hole
//   interior yields no hit at all, the outer area yields the CompoundPath
//   itself (net area). The reference hole branch (negative-area child whose
//   parent is a CompoundPath) therefore has no stock-Paper counterpart; the
//   new helper keeps the branch as pure metadata mapping so a future
//   fork-parity hit pipeline can feed it.
// - Current `paperVectorHitIndex` (`paper-vector.ts`) uses a fixed 0.5
//   tolerance with fill+stroke+curves+segments and no match gate, returning
//   only an index (no fill-vs-stroke side, no hole metadata, no
//   selected/noHover/guide exclusion beyond unit filtering). There is no
//   hover preview; clicks fall back to a bounding-box hit when Paper misses,
//   so a hole click still targets the whole unit.
// New files only: no existing UI is touched here.
const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4311';
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('vector fill-tool hover target in real Paper.js', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4311', '--strictPort'], {
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
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  it('open path: reference gates fill hits, stock Paper never surfaces them, current index carries no side', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const hover = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hover.ts');
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const open = new scope.Path({
        segments: [
          [20, 20],
          [120, 20],
          [120, 120],
        ],
        closed: false,
        strokeColor: 'black',
        strokeWidth: 4,
      });
      (open as unknown as { fillColor: unknown }).fillColor = null;
      const interior = new scope.Point(70, 70);
      const onStroke = new scope.Point(70, 20);
      // The fork option is silently ignored by stock Paper: even with it, the
      // open interior reports no fill hit.
      const forkOptionIgnored = open.hitTest(interior, {
        fill: true,
        stroke: true,
        tolerance: 2,
        hitUnfilledPaths: true,
      } as unknown as { fill: boolean }) === null;
      const strokeHit = open.hitTest(onStroke, { fill: true, stroke: true, tolerance: 2 });
      const strokeHitType = strokeHit?.type ?? null;
      // Reference `match` evaluated against the real item state.
      const gap = open.firstSegment.point.getDistance(open.lastSegment.point);
      const referenceForFill = hover.shouldAcceptFillHoverHit({
        kind: 'path',
        hasFill: open.hasFill(),
        closed: open.closed,
        almostClosed: hover.isAlmostClosedFillPath(open.segments.length, { x: 20, y: 20 }, { x: 120, y: 120 }),
        hitType: 'fill',
      });
      const referenceForStroke = hover.shouldAcceptFillHoverHit({
        kind: 'path',
        hasFill: open.hasFill(),
        closed: open.closed,
        almostClosed: false,
        hitType: 'stroke',
      });
      open.remove();
      scope.project.clear();
      // Current implementation path: one SVG unit, fixed 0.5 tolerance, no gate.
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path d="M20 20 L120 20 L120 120" fill="none" stroke="black" stroke-width="4"/></svg>';
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const units = Array.from(doc.documentElement.children) as Element[];
      const currentOnStroke = await paperModule.paperVectorHitIndex(units, { x: 70, y: 20 }, 0.5);
      const currentInterior = await paperModule.paperVectorHitIndex(units, { x: 70, y: 70 }, 0.5);
      return {
        forkOptionIgnored,
        strokeHitType,
        gap,
        referenceForFill,
        referenceForStroke,
        currentOnStroke,
        currentInterior,
      };
    });
    // Stock Paper ignores the fork-only `hitUnfilledPaths` option.
    expect(result.forkOptionIgnored).toBe(true);
    // The outline hit is a stroke hit, which the reference accepts...
    expect(result.strokeHitType).toBe('stroke');
    expect(result.referenceForStroke).toBe(true);
    // ...while a fill hit on this open, unfilled, far-from-closed path is rejected.
    expect(result.gap).toBeGreaterThan(8);
    expect(result.referenceForFill).toBe(false);
    // The current index hits the outline but reports no side (just an index),
    // and likewise misses the interior — matching the reference outcome here
    // by accident of stock Paper, without enforcing the rule.
    expect(result.currentOnStroke).toBe(0);
    expect(result.currentInterior).toBe(-1);
  }, 30_000);

  it('compound hole: stock Paper yields no target while the helper maps hole vs transparent-hole', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const hover = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hover.ts');
      const units = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path d="M20 20H220V160H20Z M80 60H140V120H80Z" fill="red" fill-rule="evenodd"/></svg>';
      const item = scope.project.importSVG(svg) as unknown as {
        className: string;
        hitTest: (point: unknown, options?: unknown) => {
          type: string;
          item: { className: string; area: number; parent?: { className?: string } };
        } | null;
        remove: () => void;
      };
      const inner = new scope.Point(110, 90);
      const outerPt = new scope.Point(30, 30);
      const outerHit = item.hitTest(outerPt, { fill: true, stroke: true, tolerance: 2 });
      const innerHits = scope.project.hitTestAll(inner, { fill: true, stroke: true, tolerance: 2 });
      const outerHits = scope.project.hitTestAll(outerPt, { fill: true, stroke: true, tolerance: 2 });
      const outerHitSummary = outerHit
        ? { type: outerHit.type, class: outerHit.item.className, area: outerHit.item.area }
        : null;
      item.remove();
      scope.project.clear();
      // The reference hole branch as pure metadata mapping (negative-area
      // child of a CompoundPath hit on fill): opaque paint overlays the hole,
      // transparent paint is a no-op. Stock Paper never produces this hit, so
      // the mapping is locked here for a future fork-parity hit pipeline.
      const holeMapping = hover.isHoleFillHit({ parentIsCompoundPath: true, childArea: -3600, hitType: 'fill' });
      const opaqueDecision = hover.decideFillHoverTarget({
        accepted: true,
        isHole: true,
        parentIsCompoundPath: true,
        hitType: 'fill',
        fillTransparent: false,
      });
      const transparentDecision = hover.decideFillHoverTarget({
        accepted: true,
        isHole: true,
        parentIsCompoundPath: true,
        hitType: 'fill',
        fillTransparent: true,
      });
      // Current unit pipeline on the same SVG: outer hits index 0, hole misses.
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const svgUnits = Array.from(doc.documentElement.children) as Element[];
      const currentOuter = await paperModule.paperVectorHitIndex(svgUnits, { x: 30, y: 30 }, 0.5);
      const currentInner = await paperModule.paperVectorHitIndex(svgUnits, { x: 110, y: 90 }, 0.5);
      // ...but the hole point still sits inside the unit bounding box, which is
      // what the editor click path falls back to (whole-unit fill).
      const bounds = units.vectorObjectBounds(svgUnits[0]!);
      const bboxContainsHole =
        110 >= bounds.x && 110 <= bounds.x + bounds.width && 90 >= bounds.y && 90 <= bounds.y + bounds.height;
      return {
        outerHitSummary,
        innerHitCount: innerHits.length,
        outerHitClasses: outerHits.map((hit) => hit.item.className),
        holeMapping,
        opaqueDecision,
        transparentDecision,
        currentOuter,
        currentInner,
        bboxContainsHole,
      };
    });
    // Outer area hits the CompoundPath itself (net area), never a child.
    expect(result.outerHitSummary?.type).toBe('fill');
    expect(result.outerHitSummary?.class).toBe('CompoundPath');
    // Hole interior: stock Paper reports no target at all.
    expect(result.innerHitCount).toBe(0);
    expect(result.outerHitClasses).toContain('CompoundPath');
    // Helper keeps the reference hole mapping as pure logic.
    expect(result.holeMapping).toBe(true);
    expect(result.opaqueDecision).toEqual({ action: 'preview-hole-overlay', property: 'fill' });
    expect(result.transparentDecision).toEqual({ action: 'noop-transparent-hole' });
    // Current pipeline: outer hits, hole misses at the Paper layer...
    expect(result.currentOuter).toBe(0);
    expect(result.currentInner).toBe(-1);
    // ...yet the bbox fallback still contains the hole point, so a current
    // click fills the whole unit where the reference would overlay / no-op.
    expect(result.bboxContainsHole).toBe(true);
  }, 30_000);

  it('keeps zoom-aware tolerance, selected/helper exclusion, and sanitized ancestor hits', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const hover = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hover.ts');
      const sanitize = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts');
      const units = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const toleranceAtQuarterZoom = hover.fillToolToleranceForZoom(0.25);
      const selectedExcluded = hover.isHoverableFillCandidate({ selected: true });
      const helperExcluded = hover.isHoverableFillCandidate({ noHover: true, isHelperItem: true });
      const guideExcluded = hover.isHoverableFillCandidate({ guide: true });
      // Ancestor transform: the rect lives at (0,0,40,40) inside a translated group.
      const raw =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<script>window.__fillProbeXss = true;</script>' +
        '<g transform="translate(100 50)"><rect x="0" y="0" width="40" height="40" fill="red" stroke="none"/></g></svg>';
      const clean = sanitize.sanitizeSvgForPaperImport(raw);
      const scriptStripped = !clean.includes('<script');
      const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
      const svg = doc.documentElement;
      const selectable = units.editableVectorUnits(svg);
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const baked = units.bakedUnitClone(svg, selectable[0]!);
      const serialized = new XMLSerializer().serializeToString(baked!);
      const fragment = sanitize.sanitizeSvgFragmentForPaperImport(serialized);
      const item = scope.project.importSVG(fragment, { insert: false }) as unknown as {
        hitTest: (point: unknown, options?: unknown) => unknown;
        remove: () => void;
      };
      // Document-space center of the translated rect.
      const centerHit = Boolean(item.hitTest(new scope.Point(120, 70), { fill: true, tolerance: 2 }));
      const farMiss = Boolean(item.hitTest(new scope.Point(10, 10), { fill: true, tolerance: 2 }));
      item.remove();
      scope.project.clear();
      return {
        toleranceAtQuarterZoom,
        selectedExcluded,
        helperExcluded,
        guideExcluded,
        scriptStripped,
        centerHit,
        farMiss,
      };
    });
    // 2 / 0.25 = 8 document units; the legacy fixed 0.5 would be 16x tighter here.
    expect(result.toleranceAtQuarterZoom).toBeCloseTo(8, 10);
    expect(result.selectedExcluded).toBe(false);
    expect(result.helperExcluded).toBe(false);
    expect(result.guideExcluded).toBe(false);
    // Untrusted payloads never reach Paper.js: the script is stripped before import.
    expect(result.scriptStripped).toBe(true);
    // Ancestor transforms are honored through the baked clone.
    expect(result.centerHit).toBe(true);
    expect(result.farMiss).toBe(false);
  }, 30_000);

  it('fill resolver reports side + match metadata and misses holes/open interiors', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const hover = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hover.ts');
      const unitsOf = (svg: string) => {
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        return Array.from(doc.documentElement.children) as Element[];
      };
      const head = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">';
      const donutUnits = unitsOf(
        `${head}<path d="M20 20H220V160H20Z M80 60H140V120H80Z" fill="red" fill-rule="evenodd"/></svg>`,
      );
      const outer = await paperModule.paperVectorFillTargetAtPoint(donutUnits, { x: 30, y: 30 }, 2);
      const hole = await paperModule.paperVectorFillTargetAtPoint(donutUnits, { x: 110, y: 90 }, 2);
      const openUnits = unitsOf(
        `${head}<path d="M20 20 L120 20 L120 120" fill="none" stroke="black" stroke-width="4"/></svg>`,
      );
      const openInterior = await paperModule.paperVectorFillTargetAtPoint(openUnits, { x: 70, y: 70 }, 2);
      const openStroke = await paperModule.paperVectorFillTargetAtPoint(openUnits, { x: 70, y: 20 }, 2);
      const rectUnits = unitsOf(`${head}<rect x="20" y="20" width="100" height="80" fill="blue"/></svg>`);
      const rectFill = await paperModule.paperVectorFillTargetAtPoint(rectUnits, { x: 70, y: 60 }, 2);
      const outside = await paperModule.paperVectorFillTargetAtPoint(rectUnits, { x: 400, y: 300 }, 2);
      const gate = (target: { hasFill: boolean; closed: boolean; almostClosed: boolean; hitType: 'fill' | 'stroke' } | null) =>
        target
          ? hover.shouldAcceptFillHoverHit({
              kind: 'path',
              hasFill: target.hasFill,
              closed: target.closed,
              almostClosed: target.almostClosed,
              hitType: target.hitType,
            })
          : null;
      return {
        outer: outer
          ? { index: outer.index, hitType: outer.hitType, hasFill: outer.hasFill, closed: outer.closed, gate: gate(outer) }
          : null,
        hole,
        openInterior,
        openStroke: openStroke
          ? {
              index: openStroke.index,
              hitType: openStroke.hitType,
              hasFill: openStroke.hasFill,
              closed: openStroke.closed,
              almostClosed: openStroke.almostClosed,
              gate: gate(openStroke),
            }
          : null,
        rectFill: rectFill
          ? { index: rectFill.index, hitType: rectFill.hitType, gate: gate(rectFill) }
          : null,
        outside,
      };
    });
    // Donut body: fill side, accepted by the match gate.
    expect(result.outer?.index).toBe(0);
    expect(result.outer?.hitType).toBe('fill');
    expect(result.outer?.gate).toBe(true);
    // Donut hole: stock Paper reports no target, so the editor click path
    // stays a no-op instead of recoloring the whole parent via bbox.
    expect(result.hole).toBe(null);
    // Open path: interior misses (rejected fill), the outline hits as stroke.
    expect(result.openInterior).toBe(null);
    expect(result.openStroke?.hitType).toBe('stroke');
    expect(result.openStroke?.hasFill).toBe(false);
    expect(result.openStroke?.closed).toBe(false);
    expect(result.openStroke?.almostClosed).toBe(false);
    expect(result.openStroke?.gate).toBe(true);
    // Closed rect interior: fill side, accepted.
    expect(result.rectFill?.index).toBe(0);
    expect(result.rectFill?.hitType).toBe('fill');
    expect(result.rectFill?.gate).toBe(true);
    // Outside everything: no target.
    expect(result.outside).toBe(null);
  }, 30_000);
});
