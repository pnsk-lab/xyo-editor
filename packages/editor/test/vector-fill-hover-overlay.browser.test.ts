// Real-DOM coverage for the fill hover overlay snapshot builder
// (`vector-fill-hover-overlay.ts`): the preview rewrites exactly one side of
// the detached clone, inserts hole siblings like the commit path, preserves
// ancestor transforms, and never mutates the input string. Runs in Chromium
// with a real DOMParser/XMLSerializer (unavailable under `bun test`).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

const root = join(import.meta.dir, '..');
const base = 'http://127.0.0.1:4228';
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

describe('fill hover overlay snapshot with a real DOM', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4228', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
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
    await page.goto(base);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  it('recolors only the hit side of the detached clone (fill)', async () => {
    const result = await page.evaluate(async () => {
      const { buildFillHoverBodySnapshot } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-fill-hover-overlay.ts'
      );
      const baseSvgText =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<rect x="10" y="10" width="100" height="80" fill="#ff0000" stroke="#000000" stroke-width="2"/>' +
        '<circle cx="300" cy="100" r="40" fill="#0000ff"/>' +
        '</svg>';
      const snapshot = buildFillHoverBodySnapshot({
        baseSvgText,
        index: 0,
        property: 'fill',
        point: { x: 20, y: 20 },
        paint: {
          paintColor: '#00ff00',
          secondaryPaintColor: '#ffffff',
          paintGradient: 'solid',
          fillTransparent: false,
          secondaryTransparent: false,
          strokeColor: '#000000',
          strokeSecondaryColor: '#ffffff',
          strokeGradient: 'solid',
          strokeTransparent: false,
          secondaryStrokeTransparent: false,
          strokeWidth: 4,
          vectorOpacity: 100,
        },
      });
      if (!snapshot) throw new Error('expected a snapshot');
      const doc = new DOMParser().parseFromString(snapshot, 'image/svg+xml');
      const rect = doc.querySelector('rect');
      const circle = doc.querySelector('circle');
      return {
        baseUnchanged: baseSvgText.includes('fill="#ff0000"') && baseSvgText.includes('fill="#0000ff"'),
        rectFill: rect?.getAttribute('fill'),
        rectStroke: rect?.getAttribute('stroke'),
        rectStrokeWidth: rect?.getAttribute('stroke-width'),
        circleFill: circle?.getAttribute('fill'),
        snapshotHasGreen: snapshot.includes('#00ff00'),
      };
    });
    expect(result.baseUnchanged).toBe(true);
    expect(result.rectFill).toBe('#00ff00');
    expect(result.rectStroke).toBe('#000000');
    expect(result.rectStrokeWidth).toBe('2');
    expect(result.circleFill).toBe('#0000ff');
    expect(result.snapshotHasGreen).toBe(true);
  });

  it('recolors only the outline on stroke hits (fill untouched)', async () => {
    const result = await page.evaluate(async () => {
      const { buildFillHoverBodySnapshot } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-fill-hover-overlay.ts'
      );
      const baseSvgText =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<rect x="10" y="10" width="100" height="80" fill="#ff0000" stroke="#000000" stroke-width="2"/>' +
        '</svg>';
      const snapshot = buildFillHoverBodySnapshot({
        baseSvgText,
        index: 0,
        property: 'stroke',
        point: { x: 10, y: 10 },
        paint: {
          paintColor: '#ff0000',
          secondaryPaintColor: '#ffffff',
          paintGradient: 'solid',
          fillTransparent: false,
          secondaryTransparent: false,
          strokeColor: '#00ff00',
          strokeSecondaryColor: '#ffffff',
          strokeGradient: 'solid',
          strokeTransparent: false,
          secondaryStrokeTransparent: false,
          strokeWidth: 4,
          vectorOpacity: 100,
        },
      });
      if (!snapshot) throw new Error('expected a snapshot');
      const doc = new DOMParser().parseFromString(snapshot, 'image/svg+xml');
      const rect = doc.querySelector('rect');
      return { fill: rect?.getAttribute('fill'), stroke: rect?.getAttribute('stroke') };
    });
    expect(result.fill).toBe('#ff0000');
    expect(result.stroke).toBe('#00ff00');
  });

  it('inserts a fill-only hole sibling without touching the parent', async () => {
    const result = await page.evaluate(async () => {
      const { buildFillHoverHoleSnapshot } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-fill-hover-overlay.ts'
      );
      const baseSvgText =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<path d="M10 10H110V110H10Z M30 30H90V90H30Z" fill="#ff0000" fill-rule="evenodd"/>' +
        '</svg>';
      const snapshot = buildFillHoverHoleSnapshot({
        baseSvgText,
        parentIndex: 0,
        hole: {
          holePathData: 'M30 30H90V90H30Z',
          parentTransform: '',
          holeDocumentBounds: { x: 30, y: 30, width: 60, height: 60 },
        },
        point: { x: 60, y: 60 },
        paint: {
          paintColor: '#00ff00',
          secondaryPaintColor: '#ffffff',
          paintGradient: 'solid',
          fillTransparent: false,
          secondaryTransparent: false,
          strokeColor: '#000000',
          strokeSecondaryColor: '#ffffff',
          strokeGradient: 'solid',
          strokeTransparent: false,
          secondaryStrokeTransparent: false,
          strokeWidth: 4,
          vectorOpacity: 100,
        },
      });
      if (!snapshot) throw new Error('expected a snapshot');
      const doc = new DOMParser().parseFromString(snapshot, 'image/svg+xml');
      const paths = Array.from(doc.querySelectorAll('path'));
      const overlay = paths.find((p) => p.getAttribute('d') === 'M30 30H90V90H30Z');
      return {
        pathCount: paths.length,
        parentFill: paths[0]?.getAttribute('fill'),
        overlayFill: overlay?.getAttribute('fill'),
        overlayStroke: overlay?.getAttribute('stroke'),
        overlayPointerEvents: overlay?.getAttribute('pointer-events'),
      };
    });
    expect(result.pathCount).toBe(2);
    expect(result.parentFill).toBe('#ff0000');
    expect(result.overlayFill).toBe('#00ff00');
    expect(result.overlayStroke).toBe('none');
    expect(result.overlayPointerEvents).toBe('none');
  });

  it('preserves ancestor transforms and honors zoom-scale positioning', async () => {
    const result = await page.evaluate(async () => {
      const { buildFillHoverBodySnapshot } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-fill-hover-overlay.ts'
      );
      const baseSvgText =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<g transform="translate(100 50)"><rect x="0" y="0" width="50" height="50" fill="#ff0000"/></g>' +
        '</svg>';
      const snapshot = buildFillHoverBodySnapshot({
        baseSvgText,
        index: 0,
        property: 'fill',
        point: { x: 120, y: 70 },
        paint: {
          paintColor: '#00ff00',
          secondaryPaintColor: '#ffffff',
          paintGradient: 'solid',
          fillTransparent: false,
          secondaryTransparent: false,
          strokeColor: '#000000',
          strokeSecondaryColor: '#ffffff',
          strokeGradient: 'solid',
          strokeTransparent: false,
          secondaryStrokeTransparent: false,
          strokeWidth: 4,
          vectorOpacity: 100,
        },
      });
      if (!snapshot) throw new Error('expected a snapshot');
      const doc = new DOMParser().parseFromString(snapshot, 'image/svg+xml');
      const group = doc.querySelector('g');
      const rect = doc.querySelector('rect');
      return {
        groupTransform: group?.getAttribute('transform'),
        rectFill: rect?.getAttribute('fill'),
        rectStillInGroup: rect?.parentElement?.tagName.toLowerCase(),
      };
    });
    expect(result.groupTransform).toBe('translate(100 50)');
    expect(result.rectFill).toBe('#00ff00');
    expect(result.rectStillInGroup).toBe('g');
  });

  it('stays fail-closed for transparent, unsafe, and unknown holes', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-fill-hover-overlay.ts'
      );
      const paint = {
        paintColor: '#00ff00',
        secondaryPaintColor: '#ffffff',
        paintGradient: 'solid' as const,
        fillTransparent: false,
        secondaryTransparent: false,
        strokeColor: '#000000',
        strokeSecondaryColor: '#ffffff',
        strokeGradient: 'solid' as const,
        strokeTransparent: false,
        secondaryStrokeTransparent: false,
        strokeWidth: 4,
        vectorOpacity: 100,
      };
      const transparent = { ...paint, fillTransparent: true };
      const baseSvgText =
        '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H10V10H0Z" fill="red"/></svg>';
      const hole = {
        holePathData: 'M2 2H8V8H2Z',
        parentTransform: '',
        holeDocumentBounds: { x: 2, y: 2, width: 6, height: 6 },
      };
      return {
        transparentHole: mod.buildFillHoverHoleSnapshot({ baseSvgText, parentIndex: 0, hole, point: { x: 5, y: 5 }, paint: transparent }),
        unsafeHole: mod.buildFillHoverHoleSnapshot({ baseSvgText, parentIndex: 0, hole: { ...hole, holePathData: 'M2 2 <g>' }, point: { x: 5, y: 5 }, paint: paint }),
        routingNone: mod.buildFillHoverPreviewSnapshot({ baseSvgText, result: { kind: 'none', reason: 'no shape', tolerance: 1, targetKey: null }, point: { x: 0, y: 0 }, paint }),
        routingAmbiguous: mod.buildFillHoverPreviewSnapshot({ baseSvgText, result: { kind: 'ambiguous', reason: 'overlap', tolerance: 1, targetKey: null }, point: { x: 0, y: 0 }, paint }),
        routingUnsupported: mod.buildFillHoverPreviewSnapshot({ baseSvgText, result: { kind: 'unsupported', reason: 'nested', tolerance: 1, targetKey: null }, point: { x: 0, y: 0 }, paint }),
        routingNoop: mod.buildFillHoverPreviewSnapshot({ baseSvgText, result: { kind: 'noop-transparent-hole', tolerance: 1, targetKey: null, reason: 'transparent' }, point: { x: 0, y: 0 }, paint }),
      };
    });
    expect(result.transparentHole).toBe(null);
    expect(result.unsafeHole).toBe(null);
    expect(result.routingNone).toBe(null);
    expect(result.routingAmbiguous).toBe(null);
    expect(result.routingUnsupported).toBe(null);
    expect(result.routingNoop).toBe(null);
  });
});
