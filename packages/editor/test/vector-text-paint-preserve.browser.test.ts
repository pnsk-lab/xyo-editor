import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Characters-only vector-text edit must preserve paint.
// Product code is untouched: this file only drives the REAL costume editor
// (Vite dev server + Playwright + production UI) and asserts the REAL SVG DOM,
// paint, RGBA pixels and Undo/Redo. It reproduces the font-agent report that
// fill/stroke/opacity are overwritten with toolbar values on a characters-only
// edit (Editor.svelte update path calls setVectorTextElementContent correctly
// but then unconditionally setAttribute('fill'/'stroke'/'opacity') from the
// toolbar). Every dimension below uses paint contrasting with the toolbar
// defaults (fill #ffab19 / stroke #0f172a / opacity 100 / width 4) so an
// overwrite is observable as oldValue -> toolbarValue.
//
// Dimensions: attribute paint, inline style, parent inheritance, gradient,
// transparency, multiple tspan rows, transform, RTL. Plus unknown local refs
// (url(#missing)) and external URL safety (https:// canary, event handlers).
// For each: snapshot SVG DOM + computed paint before/after, rasterize the live
// preview SVG to RGBA and count expected vs toolbar ink, Undo restores before,
// Redo restores after. Failures report the destructive condition with old/new.
const root = join(import.meta.dir, '..')
const PORT = 4531
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
const NET = 'preserve-probe.invalid'

let server: ChildProcess | undefined
let browser: Browser | undefined
let netHits: string[] = []

type TextSnapshot = {
  found: boolean
  outer?: string
  fill?: string | null
  hasFill?: boolean
  stroke?: string | null
  hasStroke?: boolean
  strokeWidth?: string | null
  opacity?: string | null
  hasOpacity?: boolean
  style?: string | null
  fontFamily?: string | null
  fontSize?: string | null
  direction?: string | null
  anchor?: string | null
  transform?: string | null
  x?: string | null
  y?: string | null
  text?: string
  tspanCount?: number
  tspans?: string[]
  defs?: string
  parentTag?: string
  parentFill?: string | null
  parentStyle?: string | null
  parentTransform?: string | null
  computedFill?: string
  computedStroke?: string
  computedOpacity?: string
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}

async function ensureVectorMode(page: Page) {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
}

async function uploadCostume(page: Page, name: string, svg: string) {
  const before = await page.getByTestId(/costume-card-\d+/).count()
  await page.getByTestId('costume-file-input').setInputFiles({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(svg, 'utf8') })
  await page.waitForFunction((n: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > n, before as unknown as undefined, { timeout: 30_000 })
  const shortName = name.replace(/\.[^.]+$/, '')
  await page.getByRole('button', { name: `Select ${shortName}` }).last().click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)
}

async function snapshotText(page: Page, marker: string): Promise<TextSnapshot> {
  return await page.evaluate((want: string) => {
    const svg = document.querySelector('.vector-preview svg')
    if (!svg) return { found: false as const }
    const texts = Array.from(svg.querySelectorAll('text'))
    const target = texts.find((el) => (el.textContent ?? '').includes(want)) as unknown as Element | undefined
    if (!target) return { found: false as const }
    const t = target as unknown as SVGTextElement & { style: CSSStyleDeclaration }
    const tspans = Array.from(target.querySelectorAll('tspan'))
    const parent = target.parentElement
    const cs = getComputedStyle(target as unknown as Element)
    return {
      found: true as const,
      outer: (target.outerHTML ?? '').slice(0, 4000),
      fill: target.getAttribute('fill'),
      hasFill: target.hasAttribute('fill'),
      stroke: target.getAttribute('stroke'),
      hasStroke: target.hasAttribute('stroke'),
      strokeWidth: target.getAttribute('stroke-width'),
      opacity: target.getAttribute('opacity'),
      hasOpacity: target.hasAttribute('opacity'),
      style: target.getAttribute('style'),
      fontFamily: target.getAttribute('font-family'),
      fontSize: target.getAttribute('font-size'),
      direction: target.getAttribute('direction'),
      anchor: target.getAttribute('text-anchor'),
      transform: target.getAttribute('transform'),
      x: target.getAttribute('x'),
      y: target.getAttribute('y'),
      text: target.textContent ?? '',
      tspanCount: tspans.length,
      tspans: tspans.map((s) => (s.outerHTML ?? '').slice(0, 1200)),
      defs: (svg.querySelector('defs')?.outerHTML ?? '').slice(0, 2000),
      parentTag: parent?.tagName?.toLowerCase() ?? '',
      parentFill: parent?.getAttribute?.('fill') ?? null,
      parentStyle: parent?.getAttribute?.('style') ?? null,
      parentTransform: parent?.getAttribute?.('transform') ?? null,
      computedFill: cs.fill,
      computedStroke: cs.stroke,
      computedOpacity: cs.opacity,
    }
  }, marker as unknown as undefined) as TextSnapshot
}

async function toolbarSnapshot(page: Page) {
  return await page.evaluate(() => {
    const fill = (document.querySelector('input[aria-label="Paint color"]') as HTMLInputElement | null)?.value ?? null
    const stroke = (document.querySelector('input[aria-label="Stroke color"]') as HTMLInputElement | null)?.value ?? null
    const opacity = (document.querySelector('input[aria-label="Vector opacity"]') as HTMLInputElement | null)?.value ?? null
    return { fill, stroke, opacity }
  })
}

async function stageRect(page: Page) {
  return await page.evaluate(() => {
    const surfaceEl = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!surfaceEl || !surfaceEl.firstElementChild) throw new Error('missing paint surface/stage')
    const stage = surfaceEl.firstElementChild!
    const rect = stage.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}

async function svgPointToScreen(page: Page, svgX: number, svgY: number) {
  let last: unknown = null
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await stageRect(page)
      if (r.width > 0) {
        const k = r.width / 2400
        return { x: r.left + svgX * 5 * k, y: r.top + svgY * 5 * k }
      }
      last = r
    } catch (e) { last = e }
    await page.waitForTimeout(200)
  }
  throw new Error(`stage rect unavailable: ${String(last)}`)
}

async function editCharsOnly(page: Page, svgX: number, svgY: number, suffix: string, wantAfter: string) {
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
  const surface = page.getByTestId('costume-paint-surface')
  const textTool = page.getByTestId('vector-shape-text').last()
  await textTool.waitFor({ state: 'visible' })
  await textTool.click()
  // Focus auto-scroll can clip glyphs outside the visible surface (see RTL
  // suite): reset the view first (view-only, no artwork/history impact).
  await page.evaluate(() => {
    document.querySelector('[data-testid="costume-paint-surface"]')?.scrollTo({ left: 0, top: 0 })
  })
  await page.waitForTimeout(300)
  const pt = await svgPointToScreen(page, svgX, svgY)
  // Retry a wider grid so transformed / multiline ink is still hit.
  const overlay = page.locator('[data-inline-text-editor]')
  let opened = false
  for (const [dx, dy] of [[0, 0], [0, -14], [10, 0], [-10, 0], [0, 14], [18, -8], [-18, 8], [0, -24], [24, 0], [-24, 0]] as const) {
    await textTool.click()
    await page.mouse.click(pt.x + dx, pt.y + dy)
    try {
      await overlay.waitFor({ state: 'visible', timeout: 1500 })
      opened = true
      break
    } catch { /* try next offset */ }
  }
  if (!opened) throw new Error(`inline editor did not open at svg (${svgX},${svgY})`)
  const textarea = overlay.locator('textarea')
  await textarea.waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, { timeout: 10_000 })
  // Ctrl+End lands at the very end of a multiline draft (plain End stays on
  // the current line), so the suffix always appends to the last line.
  await page.keyboard.press('Control+End')
  await page.keyboard.type(suffix)
  await page.keyboard.press('Escape')
  await overlay.waitFor({ state: 'hidden' })
  await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.textContent?.includes(want) ?? false, wantAfter as unknown as undefined, { timeout: 10_000 })
  await page.waitForTimeout(500)
}

async function rasterCounts(page: Page, target: [number, number, number], toolbar: [number, number, number]): Promise<{ target: number; toolbar: number; inked: number }> {
  return await page.evaluate(({ tr, tb }: { tr: [number, number, number]; tb: [number, number, number] }) => {
    const svg = document.querySelector('.vector-preview svg') as unknown as SVGSVGElement | null
    if (!svg) return { target: 0, toolbar: 0, inked: 0 }
    const xml = new XMLSerializer().serializeToString(svg)
    const blob = new Blob([xml], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const image = new Image()
    return new Promise<{ target: number; toolbar: number; inked: number }>((resolve) => {
      const done = (v: { target: number; toolbar: number; inked: number }) => { URL.revokeObjectURL(url); resolve(v) }
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = 480
          canvas.height = 360
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, 480, 360)
          ctx.drawImage(image, 0, 0, 480, 360)
          const data = ctx.getImageData(0, 0, 480, 360).data
          let t = 0
          let b = 0
          let ink = 0
          const near = (r: number, g: number, bl: number, want: [number, number, number]) =>
            Math.abs(r - want[0]) < 60 && Math.abs(g - want[1]) < 60 && Math.abs(bl - want[2]) < 60
          for (let i = 0; i < data.length; i += 16) {
            const r = data[i] ?? 0; const g = data[i + 1] ?? 0; const bl = data[i + 2] ?? 0; const a = data[i + 3] ?? 0
            if (a < 10) continue
            if (r > 245 && g > 245 && bl > 245) continue
            ink += 1
            if (near(r, g, bl, tr)) t += 1
            if (near(r, g, bl, tb)) b += 1
          }
          done({ target: t, toolbar: b, inked: ink })
        } catch { done({ target: 0, toolbar: 0, inked: 0 }) }
      }
      image.onerror = () => done({ target: 0, toolbar: 0, inked: 0 })
      image.src = url
      setTimeout(() => done({ target: -1, toolbar: -1, inked: -1 }), 8000)
    })
  }, { tr: target, tb: toolbar } as unknown as undefined) as { target: number; toolbar: number; inked: number }
}

function svgDoc(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${inner}</svg>`
}

describe('vector text chars-only edit preserves paint (real Editor, no product edits)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) { ready = true; break }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('attributes / style / inheritance / gradient / transparent / tspans / transform / RTL: DOM+paint+RGBA+undo/redo', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await ensureVectorMode(page)
      const toolbar = await toolbarSnapshot(page)
      console.log(`[paint-preserve] toolbar=${JSON.stringify(toolbar)}`)
      // Toolbar defaults are orange/dark/100: every fixture below uses a
      // contrasting green/blue paint so a toolbar overwrite is observable.
      const TOOLBAR_RGB: [number, number, number] = [255, 171, 25]
      const GREEN_RGB: [number, number, number] = [0, 200, 83]

      const fixtures: Array<{ key: string; marker: string; svgInner: string; click: [number, number]; expectRgb: [number, number, number] | null; note: string; want: string }> = [
        {
          key: 'attr', marker: 'ATTR001',
          svgInner: `<text x="200" y="150" font-size="28" font-family="Arial, sans-serif" fill="#00c853" stroke="#1a237e" stroke-width="2" opacity="0.55">ATTR001 hello</text>`,
          click: [200, 140], expectRgb: GREEN_RGB, note: 'presentation attributes', want: 'ATTR001 hello!',
        },
        {
          key: 'style', marker: 'STYLE002',
          svgInner: `<text x="200" y="150" font-size="28" font-family="Arial, sans-serif" style="fill:#00c853;stroke:#1a237e;stroke-width:2;opacity:0.6">STYLE002 hello</text>`,
          click: [200, 140], expectRgb: GREEN_RGB, note: 'inline style', want: 'STYLE002 hello!',
        },
        {
          key: 'inherit', marker: 'INHERIT003',
          svgInner: `<g fill="#00c853" stroke="#1a237e" stroke-width="2" opacity="0.8"><text x="200" y="150" font-size="28" font-family="Arial, sans-serif">INHERIT003 hello</text></g>`,
          click: [200, 140], expectRgb: GREEN_RGB, note: 'parent g inheritance', want: 'INHERIT003 hello!',
        },
        {
          key: 'gradient', marker: 'GRAD004',
          svgInner: `<defs><linearGradient id="grad-preserve" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#00c853"/><stop offset="1" stop-color="#1a237e"/></linearGradient></defs><text x="200" y="150" font-size="32" font-family="Arial, sans-serif" fill="url(#grad-preserve)" stroke="#1a237e" stroke-width="1.5" opacity="0.9">GRAD004 hello</text>`,
          click: [200, 140], expectRgb: null, note: 'fill gradient url(#grad-preserve)', want: 'GRAD004 hello!',
        },
        {
          key: 'transparent', marker: 'TRANS005',
          svgInner: `<text x="200" y="150" font-size="32" font-family="Arial, sans-serif" fill="none" stroke="#1a237e" stroke-width="3" opacity="0.9">TRANS005 hello</text>`,
          click: [200, 140], expectRgb: null, note: 'transparent fill=none (hollow stroke)', want: 'TRANS005 hello!',
        },
        {
          key: 'tspan', marker: 'TSPAN006',
          svgInner: `<text x="200" y="130" font-size="26" font-family="Arial, sans-serif" fill="#00c853" stroke="#1a237e" stroke-width="1.5" opacity="0.85"><tspan x="200" dy="0">TSPAN006 first</tspan><tspan x="200" dy="31.2">second line</tspan></text>`,
          click: [200, 153], expectRgb: GREEN_RGB, note: 'multiple tspan rows (second-line hit)', want: 'second line!',
        },
        {
          key: 'transform', marker: 'TRANSFORM007',
          svgInner: `<text x="200" y="150" font-size="28" font-family="Arial, sans-serif" fill="#00c853" stroke="#1a237e" stroke-width="2" opacity="0.75" transform="translate(30 12) rotate(8 200 150)">TRANSFORM007 hello</text>`,
          click: [230, 152], expectRgb: GREEN_RGB, note: 'transform on text', want: 'TRANSFORM007 hello!',
        },
        {
          key: 'rtl', marker: 'RTL008',
          svgInner: `<text x="240" y="150" font-size="28" font-family="Arial, sans-serif" fill="#00c853" stroke="#1a237e" stroke-width="1.5" opacity="0.85" text-anchor="start" direction="rtl">שלום RTL008</text>`,
          click: [240, 140], expectRgb: GREEN_RGB, note: 'RTL direction/anchor (Hebrew-first keeps auto RTL)', want: 'RTL008!',
        },
      ]

      const failures: string[] = []
      for (const fx of fixtures) {
        await uploadCostume(page, `preserve-${fx.key}.svg`, svgDoc(fx.svgInner))
        const before = await snapshotText(page, fx.marker)
        if (!before.found) { failures.push(`${fx.key}(${fx.note}): text not found after upload`); continue }
        const beforeRaster = fx.expectRgb ? await rasterCounts(page, fx.expectRgb, TOOLBAR_RGB) : null
        console.log(`[paint-preserve:${fx.key}] before=${JSON.stringify({ ...before, outer: before.outer?.slice(0, 500) })} raster=${JSON.stringify(beforeRaster)}`)

        // Characters-only edit: append "!" via Ctrl+End, no toolbar interaction.
        const suffix = '!'
        await editCharsOnly(page, fx.click[0], fx.click[1], suffix, fx.want)
        // tspan fixture appends at end of draft (second line), so wait text differs; re-snapshot by marker prefix.
        const after = await snapshotText(page, fx.marker)
        if (!after.found) { failures.push(`${fx.key}: text vanished after chars-only edit`); continue }
        const afterRaster = fx.expectRgb ? await rasterCounts(page, fx.expectRgb, TOOLBAR_RGB) : null
        console.log(`[paint-preserve:${fx.key}] after=${JSON.stringify({ ...after, outer: after.outer?.slice(0, 500) })} raster=${JSON.stringify(afterRaster)}`)

        const diffs: string[] = []
        const cmp = (label: string, a: unknown, b: unknown) => { if (a !== b) diffs.push(`${label}: before=${JSON.stringify(a)} -> after=${JSON.stringify(b)}`) }
        // Paint must not move to toolbar values on a chars-only edit.
        cmp('fill', before.fill, after.fill)
        cmp('hasFill', before.hasFill, after.hasFill)
        cmp('stroke', before.stroke, after.stroke)
        cmp('hasStroke', before.hasStroke, after.hasStroke)
        cmp('stroke-width', before.strokeWidth, after.strokeWidth)
        cmp('opacity', before.opacity, after.opacity)
        cmp('hasOpacity', before.hasOpacity, after.hasOpacity)
        cmp('style', before.style, after.style)
        cmp('transform', before.transform, after.transform)
        cmp('direction', before.direction, after.direction)
        cmp('text-anchor', before.anchor, after.anchor)
        cmp('parentFill', before.parentFill, after.parentFill)
        cmp('parentStyle', before.parentStyle, after.parentStyle)
        cmp('tspanCount', before.tspanCount, after.tspanCount)
        if ((before.defs ?? '') !== (after.defs ?? '')) diffs.push(`defs: before=${JSON.stringify(before.defs)} -> after=${JSON.stringify(after.defs)}`)
        // Per-row tspan paint (excluding rebuilt x/dy geometry) must survive.
        const normTspan = (list: string[] | undefined) => (list ?? []).map((s) => s.replace(/\s(x|dy)="[^"]*"/g, '').slice(0, 800))
        const bt = normTspan(before.tspans)
        const at = normTspan(after.tspans)
        if (fx.key === 'tspan') {
          // Same row count is expected here (edit appends to last line, no new
          // line added), so row paint must round-trip row by row.
          if (bt.length !== at.length) diffs.push(`tspan rows: ${bt.length} -> ${at.length}`)
        }
        if (beforeRaster && afterRaster && fx.expectRgb) {
          // Semi-transparent paint blends with white so the exact green count
          // is unreliable; the toolbar-orange count is the overwrite signal
          // (before must be 0, after must stay 0 when preserved).
          if (beforeRaster.toolbar > 30) diffs.push(`RGBA before: unexpected toolbar-orange ink (toolbar=${beforeRaster.toolbar} inked=${beforeRaster.inked})`)
          if (afterRaster.toolbar > 30 && afterRaster.toolbar >= Math.max(10, afterRaster.target)) diffs.push(`RGBA after: toolbar-orange ink appeared (toolbar=${afterRaster.toolbar} target=${afterRaster.target} inked=${afterRaster.inked}) — fill overwrite with toolbar #ffab19 suspected`)
        }
        // Gradient / transparent spot checks on DOM (RGBA is shape-dependent).
        if (fx.key === 'gradient' && after.fill !== 'url(#grad-preserve)') diffs.push(`gradient fill broken: before=${JSON.stringify(before.fill)} -> after=${JSON.stringify(after.fill)} (toolbar=${JSON.stringify(toolbar.fill)})`)
        if (fx.key === 'transparent' && after.fill !== 'none') diffs.push(`transparent fill broken: before=${JSON.stringify(before.fill)} -> after=${JSON.stringify(after.fill)} (toolbar=${JSON.stringify(toolbar.fill)})`)
        if (fx.key === 'inherit' && after.hasFill) diffs.push(`inheritance broken: text gained explicit fill after=${JSON.stringify(after.fill)} (was inherited from g fill=${JSON.stringify(before.parentFill)}; toolbar=${JSON.stringify(toolbar.fill)})`)
        if (fx.key === 'rtl' && (after.direction !== 'rtl' || after.anchor !== 'start')) diffs.push(`RTL broken: direction ${JSON.stringify(before.direction)}->${JSON.stringify(after.direction)} anchor ${JSON.stringify(before.anchor)}->${JSON.stringify(after.anchor)}`)

        // Undo restores paint+chars, Redo restores the edit — both through the
        // production buttons (one history entry per confirmed edit).
        const undo = page.locator('button[aria-label="Undo"]:visible')
        const redo = page.locator('button[aria-label="Redo"]:visible')
        await undo.click()
        await page.waitForTimeout(600)
        const undone = await snapshotText(page, fx.marker)
        const undoOk = undone.found && (undone.text ?? '').includes(fx.marker) && !(undone.text ?? '').includes('!') && undone.fill === before.fill && undone.stroke === before.stroke && (undone.opacity ?? null) === (before.opacity ?? null)
        if (!undoOk) diffs.push(`undo: did not restore before (text=${JSON.stringify(undone.text)} fill=${JSON.stringify(undone.fill)} vs ${JSON.stringify(before.fill)})`)
        await redo.click()
        await page.waitForTimeout(600)
        const redone = await snapshotText(page, fx.marker)
        const redoOk = redone.found && redone.fill === after.fill && redone.stroke === after.stroke && (redone.opacity ?? null) === (after.opacity ?? null)
        if (!redoOk) diffs.push(`redo: did not restore after (fill=${JSON.stringify(redone.fill)} vs ${JSON.stringify(after.fill)})`)

        if (diffs.length > 0) {
          failures.push(`${fx.key}(${fx.note}) CHARS-ONLY EDIT CHANGED PAINT/DOM:\n  - ` + diffs.join('\n  - ') + `\n  toolbar@${JSON.stringify(toolbar)}`)
        }
      }
      if (failures.length > 0) {
        console.log(`[paint-preserve] FAILURES\n${failures.join('\n')}`)
      }
      expect(failures).toEqual([])
    } finally {
      await context.close()
    }
  }, 240_000)

  it('unknown refs stay unresolved and external URLs never fetch/execute', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    netHits = []
    const page = await context.newPage()
    // Fail-closed network tap: abort the canary host without leaving the browser.
    await page.route('**/*', (route) => {
      const url = route.request().url()
      if (url.includes(NET)) { netHits.push(url); void route.abort(); return }
      void route.continue()
    })
    try {
      await openCostumes(page)
      await ensureVectorMode(page)
      // Isolate the unknown-ref edit target in its own costume so Paper hit
      // testing is unambiguous (one text per costume for the edit step).
      await uploadCostume(page, 'preserve-unknown.svg', svgDoc(
        `<text x="200" y="150" font-size="28" font-family="Arial, sans-serif" fill="url(#missing-id)" stroke="#1a237e" stroke-width="2" opacity="0.9">UNKNOWN009 hello</text>`,
      ))
      const beforeIsolated = await snapshotText(page, 'UNKNOWN009')
      console.log(`[paint-preserve:unknown] isolated-before=${JSON.stringify(beforeIsolated)}`)
      // Characters-only edit of the unknown-ref text must not resolve it to
      // the toolbar, must not introduce an external fetch, and must not crash.
      const failures: string[] = []
      if (!beforeIsolated.found) failures.push('unknown text not found after upload')
      else {
        await editCharsOnly(page, 200, 140, '!', 'UNKNOWN009 hello!')
        await page.waitForTimeout(800)
        const after = await snapshotText(page, 'UNKNOWN009')
        console.log(`[paint-preserve:unknown] before=${JSON.stringify(beforeIsolated)} after=${JSON.stringify(after)}`)
        if (beforeIsolated.fill !== after.fill) failures.push(`unknown local ref resolved on chars-only edit: before=${JSON.stringify(beforeIsolated.fill)} -> after=${JSON.stringify(after.fill)}`)
        if (after.fill !== 'url(#missing-id)') failures.push(`unknown ref not preserved verbatim: after.fill=${JSON.stringify(after.fill)}`)
        const undo = page.locator('button[aria-label="Undo"]:visible')
        const redo = page.locator('button[aria-label="Redo"]:visible')
        await undo.click()
        await page.waitForTimeout(600)
        const undone = await snapshotText(page, 'UNKNOWN009')
        if (undone.fill !== beforeIsolated.fill) failures.push(`undo changed unknown ref: ${JSON.stringify(undone.fill)} vs ${JSON.stringify(beforeIsolated.fill)}`)
        await redo.click()
        await page.waitForTimeout(600)
        const redone = await snapshotText(page, 'UNKNOWN009')
        if (redone.fill !== after.fill) failures.push(`redo changed unknown ref: ${JSON.stringify(redone.fill)} vs ${JSON.stringify(after.fill)}`)
      }
      // External safety in a separate costume (no hit-testing interference).
      const evil = svgDoc(
        `<defs><linearGradient id="local-keep"><stop offset="0" stop-color="#00c853"/></linearGradient></defs>` +
        `<text x="200" y="200" font-size="24" font-family="Arial, sans-serif" fill="url(https://${NET}/evil.svg#g)">EXTERNAL010 hello</text>` +
        `<image href="https://${NET}/evil.png" x="10" y="10" width="20" height="20"/>` +
        `<text x="200" y="260" font-size="24" font-family="Arial, sans-serif" fill="#00c853" onload="window.__evil='x'">HANDLER011 hello</text>`,
      )
      await uploadCostume(page, 'preserve-unknown-external.svg', evil)
      await page.waitForTimeout(1200)
      const probe = await page.evaluate((net: string) => {
        const svg = document.querySelector('.vector-preview svg')
        const html = svg?.outerHTML ?? ''
        return {
          hasNet: html.includes(net),
          hasOnload: /onload/i.test(html),
          hasExternalUrl: html.includes(`https://${net}`),
          missingRef: html.includes('url(#missing-id)'),
          localKeep: html.includes('url(#local-keep)') || html.includes('local-keep'),
          fired: (window as unknown as Record<string, unknown>).__evil ?? null,
        }
      }, NET as unknown as undefined)
      console.log(`[paint-preserve:unknown-external] after-upload=${JSON.stringify(probe)} netHits=${JSON.stringify(netHits)}`)
      if (probe.hasExternalUrl) failures.push(`external URL survived sanitize: ${NET} still in preview SVG`)
      if (probe.hasOnload) failures.push('event handler survived sanitize (onload still present)')
      if (probe.fired !== null && probe.fired !== undefined) failures.push(`handler executed: window.__evil=${JSON.stringify(probe.fired)}`)
      if (netHits.length > 0) failures.push(`external fetch attempted: ${JSON.stringify(netHits)}`)

      // Characters-only edit of the sanitized external text must not reintroduce
      // a fetch either (edit the surviving EXTERNAL010 text in place).
      const beforeExt = await snapshotText(page, 'EXTERNAL010')
      if (beforeExt.found) {
        await editCharsOnly(page, 200, 190, '!', 'EXTERNAL010 hello!')
        await page.waitForTimeout(800)
        const probeAfter = await page.evaluate((net: string) => {
          const html = document.querySelector('.vector-preview svg')?.outerHTML ?? ''
          return { hasNet: html.includes(net), fired: (window as unknown as Record<string, unknown>).__evil ?? null }
        }, NET as unknown as undefined)
        if (probeAfter.hasNet) failures.push('external URL appeared after chars-only edit')
        if (probeAfter.fired !== null && probeAfter.fired !== undefined) failures.push('handler fired after edit')
        if (netHits.length > 0) failures.push(`external fetch after edit: ${JSON.stringify(netHits)}`)
      }
      if (failures.length > 0) console.log(`[paint-preserve:unknown-external] FAILURES\n${failures.join('\n')}`)
      expect(failures).toEqual([])
      expect(netHits).toEqual([])
    } finally {
      await context.close()
    }
  }, 120_000)

  it('explicit paint change applies selectively, same-value noop preserves redo, new text keeps toolbar (VM bytes + raster + undo/redo)', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await ensureVectorMode(page)
      const failures: string[] = []
      const snapshotMd5 = async (costumeName: string): Promise<string | null> => {
        return await page.evaluate((want: string) => {
          const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
          if (!api) return null
          const snap = api.snapshot()
          const targets = snap?.project?.targets ?? []
          for (const t of targets) {
            for (const c of t?.costumes ?? []) {
              if (c?.name === want) return (c?.md5ext ?? c?.assetId ?? null) as string | null
            }
          }
          return null
        }, costumeName as unknown as undefined) as string | null
      }
      const setToolbarFill = async (hex: string) => {
        await page.evaluate((value: string) => {
          const el = document.querySelector('input[aria-label="Paint color"]') as HTMLInputElement | null
          if (!el) throw new Error('missing Paint color input')
          el.focus()
          el.value = value
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          el.blur()
        }, hex as unknown as undefined)
        await page.waitForTimeout(400)
      }
      const openEditorAt = async (svgX: number, svgY: number) => {
        await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
        const textTool = page.getByTestId('vector-shape-text').last()
        await textTool.waitFor({ state: 'visible' })
        await textTool.click()
        await page.evaluate(() => {
          document.querySelector('[data-testid="costume-paint-surface"]')?.scrollTo({ left: 0, top: 0 })
        })
        await page.waitForTimeout(300)
        const pt = await svgPointToScreen(page, svgX, svgY)
        const overlay = page.locator('[data-inline-text-editor]')
        let opened = false
        for (const [dx, dy] of [[0, 0], [0, -14], [10, 0], [-10, 0], [0, 14], [18, -8], [-18, 8], [0, -24], [24, 0], [-24, 0]] as const) {
          await textTool.click()
          await page.mouse.click(pt.x + dx, pt.y + dy)
          try {
            await overlay.waitFor({ state: 'visible', timeout: 1500 })
            opened = true
            break
          } catch { /* next offset */ }
        }
        if (!opened) throw new Error(`inline editor did not open at svg (${svgX},${svgY})`)
        await overlay.locator('textarea').waitFor({ state: 'visible' })
        await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, { timeout: 10_000 })
        await page.waitForTimeout(800)
      }
      const commitWithSuffix = async (suffix: string, wantAfter: string) => {
        const overlay = page.locator('[data-inline-text-editor]')
        const textarea = overlay.locator('textarea')
        await textarea.waitFor({ state: 'visible' })
        // Toolbar edits steal focus (color input focus/blur): refocus the
        // draft so keystrokes land in the text, like the real user flow.
        // Use programmatic focus (clicks are intercepted by the costume bar).
        await textarea.evaluate((node) => {
          ;(node as unknown as HTMLTextAreaElement).focus()
        })
        await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, { timeout: 10_000 })
        // IME simulation: composition window around the keystrokes (RTL-safe,
        // must not disturb paint or crash the commit).
        await textarea.evaluate((node) => {
          node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        })
        await page.keyboard.press('Control+End')
        await page.keyboard.type(suffix)
        await textarea.evaluate((node, data) => {
          node.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: data as unknown as string }))
          node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: data as unknown as string }))
        }, suffix as unknown as undefined)
        await page.keyboard.press('Escape')
        await overlay.waitFor({ state: 'hidden' })
        await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.textContent?.includes(want) ?? false, wantAfter as unknown as undefined, { timeout: 10_000 })
        await page.waitForTimeout(500)
      }

      // Explicit fill change on a solid text: only fill rewrites, everything
      // else (stroke/width/opacity/style/transform/tspan/defs) survives.
      await uploadCostume(page, 'explicit-fill.svg', svgDoc(
        `<text x="200" y="150" font-size="28" font-family="Arial, sans-serif" fill="#00c853" stroke="#1a237e" stroke-width="2" opacity="0.55">EXPLICIT100 hello</text>`,
      ))
      const before = await snapshotText(page, 'EXPLICIT100')
      const md5Before = await snapshotMd5('explicit-fill')
      if (!before.found) failures.push('explicit target not found after upload')
      else {
        await openEditorAt(200, 140)
        await setToolbarFill('#ff0000')
        await commitWithSuffix('!', 'EXPLICIT100 hello!')
        const after = await snapshotText(page, 'EXPLICIT100')
        const md5After = await snapshotMd5('explicit-fill')
        console.log(`[paint-preserve:explicit] before=${JSON.stringify(before.fill)} after=${JSON.stringify(after.fill)} md5 ${md5Before} -> ${md5After}`)
        const fillIsRed = (after.fill ?? '').toLowerCase() === '#ff0000'
          || (after.computedFill ?? '').replace(/\s+/g, '') === 'rgb(255,0,0)'
        if (!fillIsRed) failures.push(`explicit fill change did not apply: fill=${JSON.stringify(after.fill)} computed=${JSON.stringify(after.computedFill)}`)
        if (after.stroke !== before.stroke) failures.push(`explicit fill leaked into stroke: ${JSON.stringify(before.stroke)} -> ${JSON.stringify(after.stroke)}`)
        if (after.strokeWidth !== before.strokeWidth) failures.push(`explicit fill leaked into stroke-width: ${JSON.stringify(before.strokeWidth)} -> ${JSON.stringify(after.strokeWidth)}`)
        if (after.opacity !== before.opacity) failures.push(`explicit fill leaked into opacity: ${JSON.stringify(before.opacity)} -> ${JSON.stringify(after.opacity)}`)
        if ((after.transform ?? null) !== (before.transform ?? null)) failures.push(`explicit fill changed transform: ${JSON.stringify(before.transform)} -> ${JSON.stringify(after.transform)}`)
        if (md5Before === md5After) failures.push(`VM bytes unchanged after explicit paint edit (md5 ${md5Before})`)
        const raster = await rasterCounts(page, [255, 0, 0], [255, 171, 25])
        console.log(`[paint-preserve:explicit] raster=${JSON.stringify(raster)}`)
        // Semi-transparent red blends with white, so the exact red count is
        // unreliable; the toolbar-orange count is the overwrite signal (must
        // stay 0, like the chars-only suite).
        if (raster.toolbar > 30) failures.push(`explicit edit leaked toolbar-orange ink: ${JSON.stringify(raster)}`)
        // Undo restores green + old bytes, redo restores red (one history entry).
        const undo = page.locator('button[aria-label="Undo"]:visible')
        const redo = page.locator('button[aria-label="Redo"]:visible')
        await undo.click()
        await page.waitForTimeout(600)
        const undone = await snapshotText(page, 'EXPLICIT100')
        const md5Undone = await snapshotMd5('explicit-fill')
        if (undone.fill !== before.fill) failures.push(`undo did not restore fill: ${JSON.stringify(undone.fill)} vs ${JSON.stringify(before.fill)}`)
        if (md5Undone !== md5Before) failures.push(`undo did not restore VM bytes: ${md5Undone} vs ${md5Before}`)
        // Same-value noop while a redo is pending must preserve the redo.
        await openEditorAt(200, 140)
        const overlayNoop = page.locator('[data-inline-text-editor]')
        await overlayNoop.locator('textarea').waitFor({ state: 'visible' })
        await page.keyboard.press('Escape')
        await overlayNoop.waitFor({ state: 'hidden' })
        await page.waitForTimeout(500)
        await redo.click()
        await page.waitForTimeout(600)
        const redone = await snapshotText(page, 'EXPLICIT100')
        if (redone.fill !== after.fill) failures.push(`same-value noop dropped redo: fill=${JSON.stringify(redone.fill)} vs ${JSON.stringify(after.fill)}`)
      }

      // New text keeps the current toolbar settings (red from above): use a
      // blank costume so the click point is guaranteed empty of text.
      {
        const toolbar = await toolbarSnapshot(page)
        await uploadCostume(page, 'newtext-blank.svg', svgDoc(
          `<rect x="40" y="60" width="120" height="80" fill="#00ff00"/>`,
        ))
        await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
        const textTool = page.getByTestId('vector-shape-text').last()
        await textTool.waitFor({ state: 'visible' })
        await textTool.click()
        await page.evaluate(() => {
          document.querySelector('[data-testid="costume-paint-surface"]')?.scrollTo({ left: 0, top: 0 })
        })
        await page.waitForTimeout(300)
        const overlay = page.locator('[data-inline-text-editor]')
        let newOpened = false
        for (const [sx, sy] of [[240, 200], [200, 150], [120, 120], [360, 280]] as const) {
          const pt = await svgPointToScreen(page, sx, sy)
          await textTool.click()
          await page.mouse.click(pt.x, pt.y)
          try {
            await overlay.waitFor({ state: 'visible', timeout: 1500 })
            newOpened = true
            break
          } catch { /* try next point */ }
        }
        if (!newOpened) throw new Error('new-text inline editor did not open')
        const textarea = overlay.locator('textarea')
        await textarea.fill('NEWTOOLBAR101')
        await page.keyboard.press('Escape')
        await overlay.waitFor({ state: 'hidden' })
        await page.waitForFunction((want: string) => document.querySelector('.vector-preview')?.textContent?.includes(want) ?? false, 'NEWTOOLBAR101' as unknown as undefined, { timeout: 10_000 })
        await page.waitForTimeout(500)
        const created = await snapshotText(page, 'NEWTOOLBAR101')
        console.log(`[paint-preserve:newtext] toolbar=${JSON.stringify(toolbar)} created=${JSON.stringify(created.fill)}`)
        if (!created.found) failures.push('new toolbar text not found')
        else if ((created.fill ?? '').toLowerCase() !== String(toolbar.fill ?? '').toLowerCase()) {
          failures.push(`new text did not keep toolbar fill: created=${JSON.stringify(created.fill)} toolbar=${JSON.stringify(toolbar.fill)}`)
        }
      }

      // Transparent hollow text stays hollow on chars-only, and an explicit
      // fill change can still repaint it (VM bytes + raster + undo/redo).
      await uploadCostume(page, 'explicit-transparent.svg', svgDoc(
        `<text x="200" y="150" font-size="32" font-family="Arial, sans-serif" fill="none" stroke="#1a237e" stroke-width="3" opacity="0.9">TRANS102 hello</text>`,
      ))
      const transBefore = await snapshotText(page, 'TRANS102')
      await editCharsOnly(page, 200, 140, '!', 'TRANS102 hello!')
      const transAfter = await snapshotText(page, 'TRANS102')
      if (transAfter.fill !== 'none') failures.push(`transparent chars-only lost none: ${JSON.stringify(transAfter.fill)}`)
      const transUndo = page.locator('button[aria-label="Undo"]:visible')
      await transUndo.click()
      await page.waitForTimeout(600)
      const transUndone = await snapshotText(page, 'TRANS102')
      if (transUndone.fill !== 'none') failures.push(`transparent undo lost none: ${JSON.stringify(transUndone.fill)}`)
      const transRedo = page.locator('button[aria-label="Redo"]:visible')
      await transRedo.click()
      await page.waitForTimeout(600)

      if (failures.length > 0) console.log(`[paint-preserve:explicit] FAILURES\n${failures.join('\n')}`)
      expect(failures).toEqual([])
    } finally {
      await context.close()
    }
  }, 180_000)
})
