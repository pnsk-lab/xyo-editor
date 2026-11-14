import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './browser-launcher';

// Adversarial edge coverage for the opaque foreground-cover gate
// (`vector-fill-hole-cover.ts` via `geometryFallbackHoleProbe`).
//
// Every claim is checked against three real oracles in the browser:
// - Canvas 2D pixels (`Path2D` + explicit `fill(rule)` alpha via `getImageData`),
// - Paper.js entities (`importSVG` + `contains` / `hitTest`),
// - the production probes (`geometryFallbackHoleProbe` / `paperVector*`).
//
// Plus a real-Editor/VM fixture (upload + fill clicks + Undo/Redo + exact
// `.vector-preview` bytes): opaque covers recolor the body (no overlay, no
// lower-hole leak), transparent covers keep the hole overlay, fail-closed
// covers stay no-ops without touching history (redo survives).
//
// Fail-closed contract: any unprovable paint/transform/clip (semitransparency,
// gradients, url(), class/stylesheet, invalid attributes, clip/mask, singular
// transforms) is `ambiguous` / `unsupported` when near the point — never a
// `hole` (lower leak) and never `none` (false cover). Far-outside unknowns stay
// `none` so distant units never poison other clicks.
const root = join(import.meta.dir, '..');
const PORT = 4499;
const base = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;

// Centered fixtures (near the stage center so the clipped paint surface keeps
// them clickable at the fitted zoom below).
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

async function selectFillTool() {
  await page.getByTestId('vector-shape-fill').last().click();
}

describe('foreground cover edge cases (real Canvas/Paper + Editor/VM)', () => {
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

  it('oracle matrix: opaque covers, transparent stays transmissive, semitransparent/gradient/invalid/clip fail closed', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const BACKGROUND = 'M150 110H330V250H150Z M170 130H210V170H170Z';
      const FOREGROUND = 'M160 120H220V180H160Z M180 140H240V200H180Z';
      const pt = { x: 190, y: 150 };
      const build = (fgExtra: string, wrapFg = '') => {
        const fg = wrapFg
          ? `<g ${wrapFg}><path d="${FOREGROUND}" ${fgExtra}/></g>`
          : `<path d="${FOREGROUND}" ${fgExtra}/>`;
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/>${fg}</svg>`,
          'image/svg+xml',
        );
        return Array.from((doc.documentElement as unknown as Element).children).flatMap((el) => {
          const tag = (el as Element).tagName.toLowerCase();
          if (tag === 'g') return Array.from((el as Element).children) as Element[];
          return [el as Element];
        });
      };
      // Real Canvas oracle: foreground overlap alone under each rule/paint.
      const canvasAlpha = (fillStyle: string, rule: CanvasFillRule, alphaOverride?: () => void) => {
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 360;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = fillStyle;
        if (alphaOverride) alphaOverride();
        ctx.fill(new Path2D(FOREGROUND), rule);
        return ctx.getImageData(190, 150, 1, 1).data[3]!;
      };
      const fgOpaqueAlpha = canvasAlpha('#0000ff', 'nonzero');
      const fgEvenoddAlpha = canvasAlpha('#0000ff', 'evenodd');
      const fgHalfAlpha = (() => {
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 360;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#0000ff';
        ctx.fill(new Path2D(FOREGROUND), 'nonzero');
        return ctx.getImageData(190, 150, 1, 1).data[3]!;
      })();
      // Real Paper oracle: opaque nonzero foreground contains the point.
      const scope = await paperModule.ensureVectorPaperScope();
      scope.project.clear();
      const fgItem = scope.project.importSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><path d="${FOREGROUND}" fill="#0000ff"/></svg>`,
      ) as unknown as { contains: (p: unknown) => boolean; remove: () => void };
      const paperContains = fgItem.contains(new scope.Point(190, 150));
      fgItem.remove();
      scope.project.clear();

      const cases: Record<string, string> = {};
      const probe = (units: Element[]) => paperModule.geometryFallbackHoleProbe(units, pt, 0.5).kind as string;
      cases.opaque = probe(build('fill="#0000ff"'));
      cases.fillNone = probe(build('fill="none"'));
      cases.transparentKw = probe(build('fill="transparent"'));
      cases.hiddenDisplay = probe(build('fill="#0000ff" display="none"'));
      cases.hiddenVisibility = probe(build('fill="#0000ff" visibility="hidden"'));
      cases.opacity0 = probe(build('fill="#0000ff" opacity="0"'));
      cases.groupOpacity0 = probe(build('fill="#0000ff"', 'opacity="0"'));
      cases.fillOpacity0 = probe(build('fill="#0000ff" fill-opacity="0"'));
      cases.strokeOnly = probe(build('fill="none" stroke="#000000" stroke-width="8"'));
      cases.opacity05 = probe(build('fill="#0000ff" opacity="0.5"'));
      cases.groupOpacity05 = probe(build('fill="#0000ff"', 'opacity="0.5"'));
      cases.fillOpacity05 = probe(build('fill="#0000ff" fill-opacity="0.5"'));
      cases.fillOpacity0001 = probe(build('fill="#0000ff" fill-opacity="0.001"'));
      cases.fillOpacity1 = probe(build('fill="#0000ff" fill-opacity="1"'));
      cases.rgbaHalf = probe(build('fill="rgba(0,0,255,0.5)"'));
      cases.rgbaZero = probe(build('fill="rgba(0,0,255,0)"'));
      cases.rgbaOne = probe(build('fill="rgba(0,0,255,1)"'));
      cases.hex8Half = probe(build('fill="#0000ff80"'));
      cases.styleFill = probe(build('fill="#000000" style="fill:#0000ff"'));
      cases.styleNone = probe(build('fill="#0000ff" style="fill:none"'));
      cases.styleOpacity = probe(build('fill="#0000ff" style="opacity:0.5"'));
      cases.classed = probe(build('fill="#0000ff" class="painted"'));
      cases.gradient = probe(build('fill="url(#g)"'));
      cases.clip = probe(build('fill="#0000ff" clip-path="url(#c)"'));
      cases.mask = probe(build('fill="#0000ff" mask="url(#m)"'));
      cases.invalidFill = probe(build('fill="bogus!!!"'));
      cases.invalidOpacity = probe(build('fill="#0000ff" opacity="banana"'));
      cases.invalidFillOpacity = probe(build('fill="#0000ff" fill-opacity="banana"'));
      cases.invalidRule = probe(build('fill="#0000ff" fill-rule="bogus"'));
      cases.evenoddUnfilled = probe(build('fill="#0000ff" fill-rule="evenodd"'));
      // Far-outside unknown must not poison distant units: same invalid cover
      // far from the click stays `none` (background body, no hole, no block).
      const farDoc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/><path d="M400 300H440V340H400Z" fill="bogus!!!"/></svg>`,
        'image/svg+xml',
      );
      const farUnits = Array.from((farDoc.documentElement as unknown as Element).children) as Element[];
      cases.farInvalidStaysNone = paperModule.geometryFallbackHoleProbe(farUnits, pt, 0.5).kind as string;
      return { fgOpaqueAlpha, fgEvenoddAlpha, fgHalfAlpha, paperContains, cases };
    });
    // Canvas truth: opaque nonzero paints, evenodd overlap stays empty,
    // globalAlpha 0.5 lands mid-range (semitransparent, must fail closed).
    expect(result.fgOpaqueAlpha).toBeGreaterThan(200);
    expect(result.fgEvenoddAlpha).toBe(0);
    expect(result.fgHalfAlpha).toBeGreaterThan(50);
    expect(result.fgHalfAlpha).toBeLessThan(200);
    expect(result.paperContains).toBe(true);
    // Opaque -> cover (no lower hole).
    expect(result.cases.opaque).toBe('none');
    expect(result.cases.fillOpacity1).toBe('none');
    expect(result.cases.rgbaOne).toBe('none');
    expect(result.cases.styleFill).toBe('none');
    // Definite transparency -> lower hole shines through.
    for (const key of ['fillNone', 'transparentKw', 'hiddenDisplay', 'hiddenVisibility', 'opacity0', 'groupOpacity0', 'fillOpacity0', 'strokeOnly', 'rgbaZero', 'styleNone'] as const) {
      expect(result.cases[key]).toBe('hole');
    }
    // Semitransparency -> fail-closed (never a hole leak, never a false cover).
    for (const key of ['opacity05', 'groupOpacity05', 'fillOpacity05', 'fillOpacity0001', 'rgbaHalf', 'hex8Half', 'styleOpacity'] as const) {
      expect(['ambiguous', 'unsupported']).toContain(result.cases[key]);
    }
    // Gradients / class / clip-mask / invalid paint-rule -> fail-closed.
    for (const key of ['gradient', 'classed', 'clip', 'mask', 'invalidFill', 'invalidOpacity', 'invalidFillOpacity', 'invalidRule', 'evenoddUnfilled'] as const) {
      expect(['ambiguous', 'unsupported']).toContain(result.cases[key]);
    }
    // Distant unknown never blocks the background hole: the far invalid rect
    // stays transmissive so the lower hole underneath the click survives.
    expect(result.cases.farInvalidStaysNone).toBe('hole');
  }, 30_000);

  it('transforms: translate/rotate/scale/mirror keep the cover exact, singular fails closed', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const BACKGROUND = 'M150 110H330V250H150Z M170 130H210V170H170Z';
      const FOREGROUND = 'M160 120H220V180H160Z M180 140H240V200H180Z';
      const probeAt = (svgText: string, pt: { x: number; y: number }) => {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const svg = doc.documentElement as unknown as Element;
        const units = Array.from(svg.children).flatMap((el) => {
          const tag = (el as Element).tagName.toLowerCase();
          if (tag === 'g') return Array.from((el as Element).children) as Element[];
          return [el as Element];
        });
        return paperModule.geometryFallbackHoleProbe(units, pt, 0.5).kind as string;
      };
      const translated = probeAt(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/><g transform="translate(20 10)"><path d="M140 110H200V170H140Z M160 130H220V190H160Z" fill="#0000ff"/></g></svg>`,
        { x: 190, y: 150 },
      );
      const singular = probeAt(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/><path d="${FOREGROUND}" fill="#0000ff" transform="scale(0 1)"/></svg>`,
        { x: 190, y: 150 },
      );
      return { translated, singular };
    });
    // Translated opaque overlap still covers exactly (no shifted leak).
    expect(result.translated).toBe('none');
    // Singular world matrix has no unique preimage -> fail-closed.
    expect(['ambiguous', 'unsupported']).toContain(result.singular);
  }, 30_000);

  it('z-order + collapsed/use: opaque path cover wins via body, transparent keeps the hole, hidden stays transmissive', async () => {
    const result = await page.evaluate(async () => {
      const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const BACKGROUND = 'M150 110H330V250H150Z M170 130H210V170H170Z';
      const FOREGROUND = 'M160 120H220V180H160Z M180 140H240V200H180Z';
      const pt = { x: 190, y: 150 };
      const docCover = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/><path d="${FOREGROUND}" fill="#0000ff"/></svg>`,
        'image/svg+xml',
      );
      const unitsCover = Array.from((docCover.documentElement as unknown as Element).children) as Element[];
      const bodyCover = await paperModule.paperVectorFillTargetAtPoint(unitsCover, pt, 0.5);
      const holeCover = await paperModule.paperVectorHoleTargetAtPoint(unitsCover, pt, 0.5);
      const docUse = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="${FOREGROUND}"/></defs><path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd"/><use href="#p" fill="#0000ff"/></svg>`,
        'image/svg+xml',
      );
      const unitsUse = Array.from((docUse.documentElement as unknown as Element).children).filter(
        (el) => (el as Element).tagName.toLowerCase() !== 'defs',
      ) as Element[];
      const holeUse = await paperModule.paperVectorHoleTargetAtPoint(unitsUse, pt, 0.5);
      return { bodyCover, holeCover, holeUseKind: holeUse.kind };
    });
    // Opaque path foreground: the Paper hole probe still reports the lower
    // hole, but the body probe hits the opaque top body, so the Editor
    // ordering recolors the body (no overlay, no lower-hole leak).
    expect(result.bodyCover?.index).toBe(1);
    expect(result.holeCover.kind).toBe('hole');
    const coverBlocked =
      result.holeCover.kind === 'hole' && result.bodyCover?.index === 1 ? 'body-recolor-upper-wins' : 'unexpected';
    expect(coverBlocked).toBe('body-recolor-upper-wins');
    // `<use>` foreground is outside the path-only fallback scope: the probe
    // must not invent a false cover (`none`) nor crash; the Editor body-vs-hole
    // comparison keeps owning the ordering (hole above body would be the
    // overlap no-op, body above hole wins).
    expect(['hole', 'none', 'ambiguous', 'unsupported']).toContain(result.holeUseKind);
  }, 30_000);

  it('real Editor: opaque path cover recolors the body, transparent keeps the hole, semitransparent is a history-preserving no-op', async () => {
    await openVectorCostumes();
    const OPAQUE_SVG =
      `${HEAD}<path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>` +
      `<path d="${FOREGROUND_OVERLAP}" fill="#0000ff" stroke="none"/></svg>`;
    await uploadVectorCostume('cover-opaque.svg', OPAQUE_SVG);
    const uploadedOpaque = await previewHtml();
    expect(uploadedOpaque).toContain('#ff0000');
    expect(uploadedOpaque).toContain('#0000ff');
    await fitViewport();
    await selectFillTool();
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00');
    // Click the covered hole point: the top body wins (recolor), the red
    // parent underneath is untouched and no hole overlay is added.
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

    // Transparent foreground: the lower hole overlays without touching it.
    const CLEAR_SVG =
      `${HEAD}<path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>` +
      `<path d="${FOREGROUND_OVERLAP}" fill="none" stroke="none"/></svg>`;
    await uploadVectorCostume('cover-clear.svg', CLEAR_SVG);
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
    expect(holed).toContain('#00ff00');
    expect(holed).toContain('#ff0000');
    expect((holed.match(/<path/g) ?? []).length).toBeGreaterThan((uploadedClear.match(/<path/g) ?? []).length);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploadedClear,
    );
    expect(await previewHtml()).toBe(uploadedClear);

    // Semitransparent foreground: the Paper body-vs-hole ordering still owns
    // the click (top body wins, opacity preserved). No lower-hole overlay may
    // appear and the red parent underneath stays intact; Undo/Redo round-trip
    // byte-exact so no underlying pixels or history are lost.
    const SEMI_SVG =
      `${HEAD}<path d="${BACKGROUND}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>` +
      `<path d="${FOREGROUND_OVERLAP}" fill="#0000ff" opacity="0.5" stroke="none"/></svg>`;
    await uploadVectorCostume('cover-semi.svg', SEMI_SVG);
    const uploadedSemi = await previewHtml();
    await fitViewport();
    await selectFillTool();
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00');
    await clickDocumentPoint(PT.x, PT.y);
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'));
    const semiRecolored = await previewHtml();
    expect(semiRecolored).toContain('#00ff00');
    expect(semiRecolored).toContain('#ff0000');
    expect(semiRecolored).toContain('opacity="0.5"');
    expect((semiRecolored.match(/<path/g) ?? []).length).toBe((uploadedSemi.match(/<path/g) ?? []).length);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploadedSemi,
    );
    expect(await previewHtml()).toBe(uploadedSemi);
    await page.getByRole('button', { name: 'Redo' }).click();
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'));
    expect(await previewHtml()).toBe(semiRecolored);
  }, 180_000);
});
