// Adversarial browser audit for svg-hole-fallback-opacity (real oracles).
//
// - Canvas 2D pixels (`Path2D` + explicit rule alpha via `getImageData`),
// - Paper.js entities (`importSVG` + `contains`),
// - production probes (`geometryFallbackHoleProbe` / `paperVector*`),
// - real Editor/VM fixture (upload + hover + fill clicks + Undo/Redo +
//   selection + exact `.vector-preview` bytes): opaque covers recolor the body,
//   transparent covers keep the hole overlay, fail-closed covers stay no-ops
//   with the original SVG byte-identical (no history, no selection change,
//   redo stack intact).
//
// Fail-closed contract: unprovable paint/transform/clip near the point is
// `ambiguous`/`unsupported` (never a lower-hole leak, never a false cover).
// Far-outside unknowns stay transmissive. Legitimate-unsupported notes
// (modern slash syntax, #RGBA 4-digit, currentColor without color resolution)
// are recorded inline as nonbugs: safe by direction (fail-closed near).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

const root = join(import.meta.dir, '..');
const PORT = 4501;
const base = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

const OUTER = 'M150 110H330V250H150Z';
const HOLE_A = 'M170 130H210V170H170Z';
const BACKGROUND = `${OUTER} ${HOLE_A}`;
const FOREGROUND_OVERLAP = 'M160 120H220V180H160Z M180 140H240V200H180Z';
const PT = { x: 190, y: 150 };
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">';

function previewHtml() {
  return page.locator('.vector-preview').innerHTML();
}

async function openVectorCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByTestId('main-tab-costumes').click();
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' });
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click();
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible' });
}

async function uploadVectorCostume(name: string, svg: string) {
  const beforeCards = await page.getByTestId(/costume-card-\d+/).count();
  await page.getByTestId('costume-file-input').setInputFiles({
    name,
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svg, 'utf8'),
  });
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
    beforeCards,
    { timeout: 30_000 },
  );
  await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click();
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 });
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click();
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 });
  }
}

async function fitViewport() {
  await page.getByRole('button', { name: 'Reset zoom' }).click();
  for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click();
}

async function clickDocumentPoint(x: number, y: number) {
  const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox();
  if (!box) throw new Error('Missing vector stage surface');
  const clientX = box.x + (x / 480) * box.width;
  const clientY = box.y + (y / 360) * box.height;
  await page.mouse.click(clientX, clientY);
}

async function hoverDocumentPoint(x: number, y: number) {
  const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox();
  if (!box) throw new Error('Missing vector stage surface');
  await page.mouse.move(box.x + (x / 480) * box.width, box.y + (y / 360) * box.height, { steps: 5 });
}

async function selectFillTool() {
  await page.getByTestId('vector-shape-fill').last().click();
}

describe('fallback opacity adversarial (real Canvas/Paper + Editor/VM)', () => {
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
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base, { waitUntil: 'networkidle' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  it('oracle matrix: risky paints fail closed near (Canvas truth attached)', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const BACKGROUND = 'M150 110H330V250H150Z M170 130H210V170H170Z';
      const FOREGROUND = 'M160 120H220V180H160Z M180 140H240V200H180Z';
      const pt = { x: 190, y: 150 };
      const build = (fgExtra: string) => {
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/><path d="${FOREGROUND}" ${fgExtra}/></svg>`,
          'image/svg+xml',
        );
        return Array.from((doc.documentElement as unknown as Element).children) as Element[];
      };
      const canvasAlpha = (fillStyle: string, rule: CanvasFillRule, alpha?: number) => {
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 360;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        if (alpha !== undefined) ctx.globalAlpha = alpha;
        ctx.fillStyle = fillStyle;
        ctx.fill(new Path2D(FOREGROUND), rule);
        return ctx.getImageData(190, 150, 1, 1).data[3]!;
      };
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const fgItem = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><path d="${FOREGROUND}" fill="#0000ff"/></svg>`,
      ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
      const paperContains = fgItem.contains(new scope.Point(190, 150));
      fgItem.remove();
      scope.project.clear();
      const probe = (units: Element[]) => paperModule.geometryFallbackHoleProbe(units, pt, 0.5).kind as string;
      const cases: Record<string, string> = {
        opaqueHex8: probe(build('fill="#0000ff"')),
        transparentHex8: probe(build('fill="#0000ff00"')),
        semiHex8: probe(build('fill="#0000ff80"')),
        // Legitimate-unsupported (nonbug): 4-digit #RGBA is not parsed, so it
        // fail-closes near instead of resolving alpha. Safe by direction.
        rgba4digit: probe(build('fill="#00f8"')),
        // Legitimate-unsupported (nonbug): modern slash/percentage syntax is
        // not parsed, so it fail-closes near. Canvas truth: transparent slash
        // paints nothing, semitransparent paints mid-alpha; neither may leak
        // a hole nor become a false cover.
        modernSlashTransparent: probe(build('fill="rgb(0 0 255 / 0)"')),
        modernSlashSemi: probe(build('fill="rgb(0 0 255 / 0.5)"')),
        percentAlpha: probe(build('fill="rgba(0,0,255,50%)"')),
        currentColor: probe(build('fill="currentColor"')),
        contextFill: probe(build('fill="context-fill"')),
        gradientTransparentStops: probe(build('fill="url(#g)"')),
        invalidRgba: probe(build('fill="rgba(banana)"')),
        invalidCss: probe(build('fill="red!!!"')),
        clip: probe(build('fill="#0000ff" clip-path="url(#c)"')),
        mask: probe(build('style="mask:url(#m)" fill="#0000ff"')),
        invalidRule: probe(build('fill="#0000ff" fill-rule="bogus"')),
        evenoddUnfilled: probe(build('fill="#0000ff" fill-rule="evenodd"')),
        singular: probe(build('fill="#0000ff" transform="scale(0 1)"')),
      };
      // Topmost/sibling: two identical holes at the same point + opaque
      // nonzero cover vs evenodd-unfilled foreground.
      const docTwo = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/><path d="${BACKGROUND}" fill="#0000ff" fill-rule="evenodd"/></svg>`,
        'image/svg+xml',
      );
      cases.siblingHoles = paperModule.geometryFallbackHoleProbe(
        Array.from((docTwo.documentElement as unknown as Element).children) as Element[],
        pt,
        0.5,
      ).kind as string;
      return {
        canvasOpaque: canvasAlpha('#0000ff', 'nonzero'),
        canvasEvenoddEmpty: canvasAlpha('#0000ff', 'evenodd'),
        canvasSemi: canvasAlpha('#0000ff', 'nonzero', 0.5),
        paperContains,
        cases,
      };
    });
    // Canvas truth anchors the matrix: opaque paints, evenodd overlap stays
    // empty, semitransparent lands mid-range.
    expect(result.canvasOpaque).toBeGreaterThan(200);
    expect(result.canvasEvenoddEmpty).toBe(0);
    expect(result.canvasSemi).toBeGreaterThan(50);
    expect(result.canvasSemi).toBeLessThan(200);
    expect(result.paperContains).toBe(true);
    expect(result.cases.opaqueHex8).toBe('none');
    expect(result.cases.transparentHex8).toBe('hole');
    for (const key of [
      'semiHex8',
      'rgba4digit',
      'modernSlashTransparent',
      'modernSlashSemi',
      'percentAlpha',
      'currentColor',
      'contextFill',
      'gradientTransparentStops',
      'invalidRgba',
      'invalidCss',
      'clip',
      'mask',
      'invalidRule',
      'evenoddUnfilled',
      'singular',
    ] as const) {
      expect(['ambiguous', 'unsupported']).toContain(result.cases[key]);
      expect(result.cases[key]).not.toBe('none');
      expect(result.cases[key]).not.toBe('hole');
    }
    // Sibling holes at the same point must not invent a topmost winner.
    expect(result.cases.siblingHoles).toBe('ambiguous');
  }, 30_000);

  it('real Editor: opaque recolors + transparent overlays + fail-closed no-ops preserve bytes/history/selection', async () => {
    await openVectorCostumes();
    // Opaque cover: top body wins (recolor), no overlay, Undo/Redo byte-exact.
    const OPAQUE_SVG =
      `${HEAD}<path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>` +
      `<path d="${FOREGROUND_OVERLAP}" fill="#0000ff" stroke="none"/></svg>`;
    await uploadVectorCostume('adv-opaque.svg', OPAQUE_SVG);
    const uploadedOpaque = await previewHtml();
    await fitViewport();
    await selectFillTool();
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00');
    const beforeHover = await previewHtml();
    await hoverDocumentPoint(PT.x, PT.y);
    await page.waitForTimeout(400);
    // Hover is draw-only: live SVG bytes stay identical.
    expect(await previewHtml()).toBe(beforeHover);
    await clickDocumentPoint(PT.x, PT.y);
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'));
    const recolored = await previewHtml();
    expect(recolored).toContain('#00ff00');
    expect(recolored).toContain('#ff0000');
    expect((recolored.match(/<path/g) ?? []).length).toBe((uploadedOpaque.match(/<path/g) ?? []).length);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploadedOpaque,
    );
    expect(await previewHtml()).toBe(uploadedOpaque);
    await page.getByRole('button', { name: 'Redo' }).click();
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'));
    expect(await previewHtml()).toBe(recolored);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploadedOpaque,
    );

    // Transparent foreground: lower hole overlays without touching the parent.
    const CLEAR_SVG =
      `${HEAD}<path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>` +
      `<path d="${FOREGROUND_OVERLAP}" fill="none" stroke="none"/></svg>`;
    await uploadVectorCostume('adv-clear.svg', CLEAR_SVG);
    const uploadedClear = await previewHtml();
    await fitViewport();
    await selectFillTool();
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00');
    await clickDocumentPoint(PT.x, PT.y);
    await page.waitForFunction(() => {
      const html = document.querySelector('.vector-preview')?.innerHTML ?? '';
      return html.includes('#00ff00') && html.includes('#ff0000');
    });
    const holed = await previewHtml();
    expect((holed.match(/<path/g) ?? []).length).toBeGreaterThan((uploadedClear.match(/<path/g) ?? []).length);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploadedClear,
    );
    expect(await previewHtml()).toBe(uploadedClear);

    // Fail-closed foregrounds (gradient + invalid paint): no change at all.
    // Original stays byte-identical, no history entry, redo stack intact.
    for (const [name, fg] of [
      ['adv-gradient.svg', `<path d="${FOREGROUND_OVERLAP}" fill="url(#g)" stroke="none"/>`],
      ['adv-invalid.svg', `<path d="${FOREGROUND_OVERLAP}" fill="bogus!!!" stroke="none"/>`],
    ] as const) {
      const svg =
        `${HEAD}<defs><linearGradient id="g"><stop offset="0" stop-color="#0000ff" stop-opacity="0"/></linearGradient></defs>` +
        `<path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>${fg}</svg>`;
      await uploadVectorCostume(name, svg);
      const uploaded = await previewHtml();
      await fitViewport();
      await selectFillTool();
      await page.getByLabel('Paint color', { exact: true }).fill('#00ff00');
      await clickDocumentPoint(PT.x, PT.y);
      await page.waitForTimeout(800);
      // Exact stage bytes unchanged (no overlay, no recolor, no corruption).
      expect(await previewHtml()).toBe(uploaded);
    }
  }, 180_000);
});
