import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

/**
 * Text font selection / size / line-height / dropdown / CJK fallback audit.
 *
 * NEW-ONLY audit: no product code is touched. Everything below runs in real
 * Chromium (CHROME_BIN) so dropdown display, SVG round-trip, sanitizer
 * preservation, and glyph geometry are measured, not inferred.
 *
 * Copyright guard: Scratch-specific font *files* are never bundled, copied,
 * or fetched here. Only system font *names* already present in this repo
 * (`vector-text.ts` shortlist) plus generic OS CJK family names (no download,
 * no redistribution) are referenced as strings for measurement. The
 * `scratch-render-fonts` npm metadata carries no license field and individual
 * redistributions are unconfirmed, so this audit proposes OS-fallback suffixes
 * only.
 *
 * Port 4281 is unused by the other browser suites
 * (4173/4178/4179/4180/4183/4189/4197/4198/4213/4227/4231/4237/4265).
 */
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4281'
const CHROME_PATH =
  process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('text font selection and CJK fallback audit (real Chromium)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4281', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage()
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('locks the current shortlist, defaults, ranges, and line heights', async () => {
    const snap = await page.evaluate(async () => {
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-text.ts')
      const bitmap = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-text.ts')
      return {
        options: vector.VECTOR_TEXT_FONT_OPTIONS as Array<{ label: string; value: string }>,
        defaultSize: vector.VECTOR_TEXT_DEFAULT_FONT_SIZE,
        defaultFamily: vector.VECTOR_TEXT_DEFAULT_FONT_FAMILY,
        minSize: vector.VECTOR_TEXT_MIN_FONT_SIZE,
        maxSize: vector.VECTOR_TEXT_MAX_FONT_SIZE,
        maxChars: vector.VECTOR_TEXT_MAX_CHARS,
        maxLines: vector.VECTOR_TEXT_MAX_LINES,
        lineHeight24: vector.vectorTextLineHeight(24),
        lineHeight20: vector.vectorTextLineHeight(20),
        clampLow: vector.clampVectorTextFontSize(2),
        clampHigh: vector.clampVectorTextFontSize(999),
        clampNaN: vector.clampVectorTextFontSize(Number.NaN),
        bitmapMin: bitmap.BITMAP_TEXT_MIN_FONT_SIZE,
        bitmapMax: bitmap.BITMAP_TEXT_MAX_FONT_SIZE,
        bitmapLineFactor: bitmap.BITMAP_TEXT_LINE_HEIGHT,
        bitmapLine24: bitmap.bitmapTextLineHeight(24),
        bitmapClampHigh: bitmap.clampBitmapTextFontSize(999),
        bitmapClampNaN: bitmap.clampBitmapTextFontSize(Number.NaN),
        vectorRangeForShared180: vector.clampVectorTextFontSize(180),
        bitmapRangeForShared180: bitmap.clampBitmapTextFontSize(180),
        bitmapFont: bitmap.resolveBitmapTextFont(24, 'Arial, sans-serif'),
      }
    })
    // Unified toolbar: 9 reference literals + 5 kept system stacks (14 total).
    expect(snap.options).toHaveLength(14)
    expect(snap.options.slice(0, 9).map((o) => o.label)).toEqual([
      'Sans Serif',
      'Serif',
      'Handwriting',
      'Marker',
      'Curly',
      'Pixel',
      '中文',
      '日本語',
      '한국어',
    ])
    expect(snap.options.slice(9).map((o) => o.value)).toEqual([
      'Arial, sans-serif',
      'Georgia, serif',
      '"Courier New", monospace',
      '"Comic Sans MS", "Chalkboard SE", sans-serif',
      '"Arial Narrow", Arial, sans-serif',
    ])
    expect(snap.defaultSize).toBe(40)
    expect(snap.defaultFamily).toBe('Sans Serif')
    expect(snap.minSize).toBe(8)
    expect(snap.maxSize).toBe(144)
    expect(snap.maxChars).toBe(500)
    expect(snap.maxLines).toBe(30)
    // Line-height: vector and bitmap both match the reference 46.15/40 ratio
    // (text-tool.js PointText leading 46.15 at 40px for both modes; Paper
    // _draw advances each raster row by `leading`).
    expect(snap.lineHeight24).toBeCloseTo(24 * (46.15 / 40), 10)
    expect(snap.lineHeight20).toBeCloseTo(20 * (46.15 / 40), 10)
    expect(snap.bitmapLineFactor).toBeCloseTo(46.15 / 40, 12)
    expect(snap.bitmapLine24).toBeCloseTo(24 * (46.15 / 40), 10)
    // Clamp fallbacks on the shared toolbar value (both default to 40).
    expect(snap.clampLow).toBe(8)
    expect(snap.clampHigh).toBe(144)
    expect(snap.clampNaN).toBe(40)
    expect(snap.bitmapMin).toBe(8)
    expect(snap.bitmapMax).toBe(200)
    expect(snap.bitmapClampHigh).toBe(200)
    expect(snap.bitmapClampNaN).toBe(40)
    // Same toolbar input 180 commits as 144 (vector) vs 180 (bitmap).
    expect(snap.vectorRangeForShared180).toBe(144)
    expect(snap.bitmapRangeForShared180).toBe(180)
    expect(snap.bitmapFont).toBe('24px Arial, sans-serif')
  })

  it('shows both dropdowns bind the same shortlist (selection/display parity)', async () => {
    const snap = await page.evaluate(async () => {
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-text.ts')
      const buildSelect = (aria: string) => {
        const select = document.createElement('select')
        select.setAttribute('aria-label', aria)
        for (const option of vector.VECTOR_TEXT_FONT_OPTIONS) {
          const el = document.createElement('option')
          el.value = option.value
          el.textContent = option.label
          select.append(el)
        }
        // Product default: toolbar starts at the default family.
        select.value = vector.VECTOR_TEXT_DEFAULT_FONT_FAMILY
        document.body.append(select)
        return select
      }
      const textFont = buildSelect('Text font')
      const vectorFont = buildSelect('Vector font')
      const count = {
        textOptions: textFont.querySelectorAll('option').length,
        vectorOptions: vectorFont.querySelectorAll('option').length,
        textDefault: textFont.value,
        vectorDefault: vectorFont.value,
      }
      // Known-list value selects normally.
      vectorFont.value = '"Courier New", monospace'
      const knownIndex = vectorFont.selectedIndex
      const knownShown = vectorFont.options[vectorFont.selectedIndex]?.text ?? null
      // Foreign existing-SVG font (not in the shortlist): the select cannot
      // display it — selectedIndex drops to -1 and the visible label is empty.
      const foreign = 'NonexistentFontXYZ, "Some Other", sans-serif'
      const normalized = vector.normalizeVectorTextFontFamily(foreign)
      vectorFont.value = foreign
      const foreignOutcome = {
        normalizedKept: normalized,
        selectedIndex: vectorFont.selectedIndex,
        shownText: vectorFont.options[vectorFont.selectedIndex]?.text ?? null,
        displayedValue: vectorFont.value,
      }
      textFont.remove()
      vectorFont.remove()
      return { count, knownIndex, knownShown, foreignOutcome }
    })
    // Both toolbar dropdowns expose the same 14 options and default.
    expect(snap.count.textOptions).toBe(14)
    expect(snap.count.vectorOptions).toBe(14)
    expect(snap.count.textDefault).toBe('Sans Serif')
    expect(snap.count.vectorDefault).toBe('Sans Serif')
    // Known option: visible label matches.
    expect(snap.knownIndex).toBeGreaterThanOrEqual(0)
    expect(snap.knownShown).toBe('Monospace')
    // Foreign font: helper keeps it (compat read), but the dropdown cannot
    // show it — this is the existing-SVG display gap the report covers.
    expect(snap.foreignOutcome.normalizedKept).toBe('NonexistentFontXYZ, "Some Other", sans-serif')
    expect(snap.foreignOutcome.selectedIndex).toBe(-1)
    expect(snap.foreignOutcome.shownText).toBeNull()
  })

  it('keeps foreign font-family through normalize/sanitize/markup round-trip', async () => {
    const result = await page.evaluate(async () => {
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-text.ts')
      const sanitize = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      const cases = [
        'NonexistentFontXYZ, sans-serif',
        '"Some Future Font", sans-serif',
        '  Arial, sans-serif  ',
        'Hiragino Kaku Gothic ProN, Yu Gothic, Meiryo, sans-serif',
      ]
      const normalized = cases.map((c) => vector.normalizeVectorTextFontFamily(c))
      const empty = vector.normalizeVectorTextFontFamily('   ')
      const long = vector.normalizeVectorTextFontFamily(`A, ${'x'.repeat(500)}`)
      // Markup round-trip with a foreign stack: attribute survives escaping,
      // content survives, and the DOM read-back keeps the text.
      const foreign = 'NonexistentFontXYZ, sans-serif'
      const markup = vector.buildVectorTextMarkup({
        x: 10,
        y: 20,
        text: 'hello\n世界',
        paint: { defs: '', fill: '#111111' },
        strokeColor: '#000000',
        strokeWidth: 0,
        opacity: 100,
        fontSize: 24,
        fontFamily: foreign,
      })
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
        'image/svg+xml',
      )
      const element = doc.getElementsByTagName('text')[0]!
      const familyAttr = element.getAttribute('font-family')
      const content = vector.readVectorTextElementContent(element)
      // Sanitizer preservation: foreign font-family survives, event handlers do not.
      const dirty =
        `<svg xmlns="http://www.w3.org/2000/svg">` +
        `<text x="10" y="20" font-size="24" font-family="NonexistentFontXYZ, sans-serif" onclick="alert(1)">hi 世界</text></svg>`
      const cleaned = sanitize.sanitizeSvgForDisplay(dirty)
      const cleanedDoc = new DOMParser().parseFromString(cleaned, 'image/svg+xml')
      const cleanedText = cleanedDoc.getElementsByTagName('text')[0]
      return {
        normalized,
        empty,
        longLength: long.length,
        familyAttr,
        content,
        cleanedFamily: cleanedText?.getAttribute('font-family') ?? null,
        cleanedHasOnclick: (cleanedText?.getAttribute('onclick') ?? null) !== null,
        cleanedText: cleanedText?.textContent ?? null,
      }
    })
    expect(result.normalized[0]).toBe('NonexistentFontXYZ, sans-serif')
    expect(result.normalized[1]).toBe('"Some Future Font", sans-serif')
    // Leading/trailing whitespace is trimmed (compat read).
    expect(result.normalized[2]).toBe('Arial, sans-serif')
    expect(result.normalized[3]).toBe('Hiragino Kaku Gothic ProN, Yu Gothic, Meiryo, sans-serif')
    expect(result.empty).toBe('Sans Serif')
    expect(result.longLength).toBeLessThanOrEqual(120)
    // Markup keeps the foreign stack verbatim (modulo XML escaping) and the
    // multiline content round-trips including CJK.
    expect(result.familyAttr).toContain('NonexistentFontXYZ')
    expect(result.content).toBe('hello\n世界')
    // Sanitizer keeps font-family and text, drops the handler.
    expect(result.cleanedFamily).toContain('NonexistentFontXYZ')
    expect(result.cleanedHasOnclick).toBe(false)
    expect(result.cleanedText).toContain('世界')
  })

  it('measures CJK glyph fallback: no tofu, dropdown-independent widths', async () => {
    const result = await page.evaluate(async () => {
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-text.ts')
      const sample = '日本語テストあいうえお漢字'
      const latin = 'Hello World'
      const stacks = vector.VECTOR_TEXT_FONT_OPTIONS.map((o) => o.value)
      // Canvas widths per shortlist stack (same size, same sample).
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      const cjkWidths = stacks.map((stack) => {
        ctx.font = `24px ${stack}`
        return ctx.measureText(sample).width
      })
      const latinWidths = stacks.map((stack) => {
        ctx.font = `24px ${stack}`
        return ctx.measureText(latin).width
      })
      const cjkAllPositive = cjkWidths.every((w) => w > 0)
      const cjkMax = Math.max(...cjkWidths)
      const cjkMin = Math.min(...cjkWidths)
      const latinMax = Math.max(...latinWidths)
      const latinMin = Math.min(...latinWidths)
      // SVG live geometry: CJK renders a real box (no zero-area tofu box).
      const host = document.createElement('div')
      host.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">` +
        `<text x="240" y="100" text-anchor="middle" font-family="Arial, sans-serif" font-size="24">日本語テスト</text></svg>`
      document.body.append(host)
      const text = host.querySelector('text') as unknown as SVGGraphicsElement
      const box = text.getBBox()
      const len = (text as unknown as SVGTextContentElement).getComputedTextLength?.() ?? 0
      // Safe OS-fallback proposal (string only, no download): appending widely
      // available CJK families must not change Latin metrics when the primary
      // Latin face exists, and must keep CJK measurable.
      const proposed = `Arial, "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif`
      ctx.font = `24px ${proposed}`
      const proposedCjk = ctx.measureText(sample).width
      ctx.font = `24px Arial, sans-serif`
      const baselineCjk = ctx.measureText(sample).width
      ctx.font = `24px ${proposed}`
      const proposedLatin = ctx.measureText(latin).width
      ctx.font = `24px Arial, sans-serif`
      const baselineLatin = ctx.measureText(latin).width
      host.remove()
      return {
        cjkWidths,
        latinWidths,
        cjkAllPositive,
        cjkSpread: cjkMax - cjkMin,
        cjkMax,
        latinSpread: latinMax - latinMin,
        boxWidth: box.width,
        boxHeight: box.height,
        computedLength: len,
        proposedCjk,
        baselineCjk,
        proposedLatin,
        baselineLatin,
      }
    })
    // CJK is renderable through OS fallback on every shortlist entry.
    expect(result.cjkAllPositive).toBe(true)
    expect(result.boxWidth).toBeGreaterThan(0)
    expect(result.boxHeight).toBeGreaterThan(0)
    expect(result.computedLength).toBeGreaterThan(0)
    // Dropdown choice barely moves CJK advances (all miss CJK glyphs and fall
    // back to the same system font), while Latin moves — the UX gap: the font
    // menu looks like it changes CJK but glyphs stay identical.
    expect(result.cjkSpread).toBeLessThan(result.latinSpread)
    // The safe suffix proposal keeps both scripts measurable and does not
    // disturb Latin when Arial is present.
    expect(result.proposedCjk).toBeGreaterThan(0)
    expect(result.baselineCjk).toBeGreaterThan(0)
    expect(result.proposedLatin).toBeCloseTo(result.baselineLatin, 0)
  })

  it('audits vector vs bitmap glyph placement for the same draft', async () => {
    const result = await page.evaluate(async () => {
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-text.ts')
      const bitmap = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-text.ts')
      const base = {
        x: 240,
        y: 100,
        paint: { defs: '', fill: '#000000' },
        strokeColor: '#000000',
        strokeWidth: 0,
        opacity: 100,
        fontSize: 24,
        fontFamily: 'Arial, sans-serif',
      }
      // Vector: baseline sits at y+8; first-line baseline is the anchor.
      const single = vector.buildVectorTextMarkup({ ...base, text: 'Hi' })
      const host = document.createElement('div')
      host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">${single}</svg>`
      document.body.append(host)
      const text = host.querySelector('text') as unknown as SVGGraphicsElement
      const vbox = text.getBBox()
      const multi = vector.buildVectorTextMarkup({ ...base, text: 'one\ntwo\nthree' })
      const dyMatch = multi.match(/dy="([^"]+)"/g) ?? []
      // Bitmap: centered block, textBaseline middle, first row centered on click.
      const lineHeight = bitmap.bitmapTextLineHeight(24)
      const bounds = bitmap.bitmapTextBlockBounds(240, 100, 'one\ntwo\nthree', 24)
      const firstRowCenterY = 100 - ((3 - 1) * lineHeight) / 2
      // Ink scan for the bitmap LTR draw (real canvas, real fallback font).
      const raster = document.createElement('canvas')
      raster.width = 480
      raster.height = 360
      const context = raster.getContext('2d')!
      context.font = bitmap.resolveBitmapTextFont(24, 'Arial, sans-serif')
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillStyle = '#000000'
      const lines = ['one', 'two', 'three']
      lines.forEach((line, i) => context.fillText(line, 240, firstRowCenterY + i * lineHeight))
      const pixels = context.getImageData(0, 0, raster.width, raster.height).data
      let top = raster.height
      let bottom = -1
      for (let y = 0; y < raster.height; y += 1) {
        for (let x = 0; x < raster.width; x += 1) {
          if ((pixels[(y * raster.width + x) * 4 + 3] ?? 0) > 0) {
            if (y < top) top = y
            if (y > bottom) bottom = y
          }
        }
      }
      host.remove()
      return {
        singleMarkupY: single.match(/y="([^"]+)"/)?.[1] ?? null,
        vboxTop: vbox.y,
        vboxHeight: vbox.height,
        tspanDyValues: dyMatch,
        vectorLineHeight: vector.vectorTextLineHeight(24),
        bitmapLineHeight: lineHeight,
        bounds,
        firstRowCenterY,
        inkTop: top,
        inkBottom: bottom,
      }
    })
    // Vector baseline offset is baked (+8) and documented in markup.
    expect(result.singleMarkupY).toBe('108')
    // Vector multiline leading uses 46.15/40, bitmap rows use the same.
    expect(result.vectorLineHeight).toBeCloseTo(24 * (46.15 / 40), 10)
    expect(result.bitmapLineHeight).toBeCloseTo(24 * (46.15 / 40), 10)
    expect(result.tspanDyValues.length).toBeGreaterThan(0)
    expect(result.tspanDyValues[result.tspanDyValues.length - 1]).toContain(String(24 * (46.15 / 40)))
    // Bitmap block is centered on the click; first row sits one reference
    // leading above center for 3 lines (≈72.3 at 24px), ink spans
    // symmetrically around the click.
    expect(result.firstRowCenterY).toBeCloseTo(100 - 24 * (46.15 / 40), 10)
    expect(result.bounds.x).toBeLessThan(240)
    expect(result.inkTop).toBeLessThan(100)
    expect(result.inkBottom).toBeGreaterThan(100)
    // Vector box top is above the click (baseline model), bitmap ink is
    // centered (middle model) — the documented cross-mode placement gap.
    expect(result.vboxTop).toBeLessThan(100)
  })
})
