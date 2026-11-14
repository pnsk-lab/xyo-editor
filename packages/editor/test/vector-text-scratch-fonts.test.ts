import { describe, expect, it } from 'bun:test'
import {
  buildVectorTextMarkup,
  clampVectorTextFontSize,
  isKnownVectorTextFontFamily,
  normalizeVectorTextFontFamily,
  readVectorTextElementContent,
  resolveEffectiveVectorTextFontFamily,
  resolveTextBaseDirection,
  resolveVectorTextCommit,
  setVectorTextElementContent,
  splitVectorTextLines,
  vectorTextFontNeedsUpdate,
  VECTOR_TEXT_DEFAULT_FONT_FAMILY,
  VECTOR_TEXT_FONT_OPTIONS,
  VECTOR_TEXT_MAX_CHARS,
  VECTOR_TEXT_MAX_LINES,
  VECTOR_TEXT_MIN_FONT_SIZE,
} from '../src/features/costumes/vector-text'
import { clampBitmapTextFontSize, splitBitmapTextLines } from '../src/features/costumes/bitmap-text'
import { shouldDeferInlineTextKeyToIme } from '../src/features/costumes/inline-text-ime'
import {
  SCRATCH_FONT_BINARY_LIMITATION,
  SCRATCH_PAINT_FONTS,
  SCRATCH_TEXT_DEFAULT_FONT_SIZE,
  SCRATCH_TEXT_LEADING_AT_DEFAULT,
  SCRATCH_TEXT_LEADING_RATIO,
  XYO_BITMAP_TEXT_LINE_HEIGHT_RATIO,
  XYO_BITMAP_TEXT_SIZE_RANGE,
  XYO_TEXT_DRAFT_LIMITS,
  XYO_VECTOR_TEXT_LINE_HEIGHT_RATIO,
  XYO_VECTOR_TEXT_SIZE_RANGE,
  clampXyoBitmapTextFontSize,
  clampXyoVectorTextFontSize,
  describeScratchFontCoverage,
  isScratchPaintFontValue,
  scratchPaintFontForValue,
  scratchPaintFontLabelForValue,
  validateXyoTextDraft,
  xyoToolbarSupersetStacks,
} from '../src/features/costumes/vector-text-scratch-fonts'

function fakeTextElement(attrs: Record<string, string> = {}) {
  const map = new Map(Object.entries(attrs))
  return {
    tagName: 'TEXT',
    getAttribute: (name: string) => map.get(name) ?? null,
    setAttribute: (name: string, value: string) => void map.set(name, value),
    removeAttribute: (name: string) => void map.delete(name),
    parentElement: null,
    parentNode: null,
  } as unknown as Element
}

describe('T-3 scratch font listing vs xyo system list', () => {
  it('lists all 9 Scratch paint fonts with factual stacks and CJK labels', () => {
    expect(SCRATCH_PAINT_FONTS.length).toBe(9)
    const byId = new Map(SCRATCH_PAINT_FONTS.map((e) => [e.id, e]))
    expect(byId.get('SANS_SERIF')).toMatchObject({ label: 'Sans Serif', value: 'Sans Serif' })
    expect(byId.get('SERIF')).toMatchObject({ label: 'Serif', value: 'Serif' })
    expect(byId.get('HANDWRITING')?.value).toBe('Handwriting')
    expect(byId.get('MARKER')?.value).toBe('Marker')
    expect(byId.get('CURLY')?.value).toBe('Curly')
    expect(byId.get('PIXEL')?.value).toBe('Pixel')
    // Labels follow getFontName: CJK rows are localized, others echo the value.
    expect(byId.get('CHINESE')).toMatchObject({
      label: '中文',
      value: '"Microsoft YaHei", "微软雅黑", STXihei, "华文细黑"',
    })
    expect(byId.get('JAPANESE')).toMatchObject({
      label: '日本語',
      value: '"ヒラギノ角ゴ Pro W3", "Hiragino Kaku Gothic Pro", Osaka, "メイリオ", Meiryo, "ＭＳ Ｐゴシック", "MS PGothic"',
    })
    expect(byId.get('KOREAN')).toMatchObject({ label: '한국어', value: 'Malgun Gothic' })
    for (const entry of SCRATCH_PAINT_FONTS) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.value.length).toBeGreaterThan(0)
      expect(entry.availability.length).toBeGreaterThan(0)
    }
  })

  it('resolves labels and lookups without copying assets', () => {
    expect(scratchPaintFontLabelForValue('Sans Serif')).toBe('Sans Serif')
    expect(scratchPaintFontLabelForValue('"Microsoft YaHei", "微软雅黑", STXihei, "华文细黑"')).toBe('中文')
    expect(scratchPaintFontForValue('Marker')?.id).toBe('MARKER')
    expect(isScratchPaintFontValue('Pixel')).toBe(true)
    expect(isScratchPaintFontValue('Arial, sans-serif')).toBe(false)
    expect(isScratchPaintFontValue('NonexistentFontXYZ, sans-serif')).toBe(false)
  })

  it('documents availability: no vendored font binaries, peer/system fallback only', () => {
    // The 4 decorative Scratch literals are peer-loaded webfonts, never bundled here.
    for (const id of ['HANDWRITING', 'MARKER', 'CURLY', 'PIXEL']) {
      const entry = SCRATCH_PAINT_FONTS.find((e) => e.id === id)!
      expect(entry.kind).toBe('bundled-webfont')
      expect(entry.availability).toContain('not bundled')
    }
    for (const id of ['CHINESE', 'JAPANESE', 'KOREAN']) {
      expect(SCRATCH_PAINT_FONTS.find((e) => e.id === id)?.kind).toBe('locale-stack')
    }
    expect(SCRATCH_FONT_BINARY_LIMITATION).toContain('never fetched')
  })

  it('documents line spacing, sizes, and draft limits as facts', () => {
    // Scratch PointText default: leading 46.15 at 40px.
    expect(SCRATCH_TEXT_LEADING_AT_DEFAULT).toBe(46.15)
    expect(SCRATCH_TEXT_DEFAULT_FONT_SIZE).toBe(40)
    expect(SCRATCH_TEXT_LEADING_RATIO).toBeCloseTo(46.15 / 40, 12)
    expect(XYO_VECTOR_TEXT_LINE_HEIGHT_RATIO).toBeCloseTo(46.15 / 40, 12)
    expect(XYO_BITMAP_TEXT_LINE_HEIGHT_RATIO).toBeCloseTo(46.15 / 40, 12)
    // Size bounds.
    expect(XYO_VECTOR_TEXT_SIZE_RANGE).toEqual({ min: 8, max: 144 })
    expect(XYO_BITMAP_TEXT_SIZE_RANGE).toEqual({ min: 8, max: 200 })
    expect(clampXyoVectorTextFontSize(1000)).toBe(144)
    expect(clampXyoVectorTextFontSize(1)).toBe(8)
    expect(clampXyoVectorTextFontSize(Number.NaN)).toBe(40)
    expect(clampXyoBitmapTextFontSize(1000)).toBe(200)
    expect(clampXyoBitmapTextFontSize(1)).toBe(8)
    expect(clampXyoBitmapTextFontSize(Number.NaN)).toBe(40)
    // Draft caps.
    expect(XYO_TEXT_DRAFT_LIMITS).toMatchObject({ maxCharsPerLine: 500, maxLines: 30 })
    expect(VECTOR_TEXT_MAX_CHARS).toBe(500)
    expect(VECTOR_TEXT_MAX_LINES).toBe(30)
  })

  it('keeps every existing xyo toolbar option as a strict addition (no removal)', () => {
    // Unified toolbar: 9 reference literals + 5 pre-existing system stacks.
    expect(VECTOR_TEXT_FONT_OPTIONS.length).toBe(14)
    const superset = xyoToolbarSupersetStacks()
    // The 5 system stacks have no Scratch literal equivalent.
    expect(superset.length).toBe(5)
    expect(superset.map((s) => s.value)).toEqual([
      'Arial, sans-serif',
      'Georgia, serif',
      '"Courier New", monospace',
      '"Comic Sans MS", "Chalkboard SE", sans-serif',
      '"Arial Narrow", Arial, sans-serif',
    ])
    for (const option of VECTOR_TEXT_FONT_OPTIONS) {
      expect(isKnownVectorTextFontFamily(option.value)).toBe(true)
    }
    // Reference labels are shown verbatim (CJK rows localized).
    const labels = VECTOR_TEXT_FONT_OPTIONS.map((o) => o.label)
    for (const label of ['Handwriting', 'Marker', 'Curly', 'Pixel', '中文', '日本語', '한국어']) {
      expect(labels).toContain(label)
    }
  })

  it('routes every Scratch literal through the toolbar-known path', () => {
    const coverage = describeScratchFontCoverage()
    expect(coverage.length).toBe(9)
    for (const row of coverage) {
      // Unified toolbar knows all 9 Scratch literals verbatim.
      expect(row.xyoHandling).toBe('toolbar-known')
      expect(isKnownVectorTextFontFamily(row.scratchValue)).toBe(true)
      expect(normalizeVectorTextFontFamily(row.scratchValue)).toBe(row.scratchValue.slice(0, 120))
    }
  })

  it('validates drafts at 500 chars and 30 lines', () => {
    const long = `${'a'.repeat(600)}\n${Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')}`
    const v = validateXyoTextDraft(long)
    expect(v.truncatedChars).toBe(true)
    expect(v.truncatedLines).toBe(true)
    expect(v.lineCount).toBe(30)
    expect(v.lines[0]?.length).toBe(500)
    expect(validateXyoTextDraft('ok').truncatedChars).toBe(false)
    expect(splitVectorTextLines('a\r\nb\rc')).toEqual(['a', 'b', 'c'])
    expect(splitBitmapTextLines('x'.repeat(600)).join('').length).toBeLessThanOrEqual(500)
  })

  it('preserves Scratch stacks through inheritance, style, and shorthand', () => {
    const node = (attrs: Record<string, string>, parent?: unknown) =>
      ({ tagName: 'TEXT', getAttribute: (n: string) => attrs[n] ?? null, parentElement: parent ?? null, parentNode: parent ?? null }) as unknown as Element
    const inherited = node({}, node({ 'font-family': 'Marker' }))
    expect(resolveEffectiveVectorTextFontFamily(inherited)).toBe('Marker')
    const styled = node({ style: 'font-family: "ヒラギノ角ゴ Pro W3", "Hiragino Kaku Gothic Pro", Osaka' })
    expect(resolveEffectiveVectorTextFontFamily(styled)).toContain('Hiragino')
    // Unified toolbar knows the Scratch literals and normalizes them verbatim.
    expect(isKnownVectorTextFontFamily('Marker')).toBe(true)
    expect(normalizeVectorTextFontFamily('Marker')).toBe('Marker')
    // Truly foreign stacks stay unknown but are still preserved verbatim.
    expect(isKnownVectorTextFontFamily('NonexistentFontXYZ, sans-serif')).toBe(false)
    expect(normalizeVectorTextFontFamily('NonexistentFontXYZ, sans-serif')).toBe('NonexistentFontXYZ, sans-serif')
  })

  it('treats same-value Scratch intent as no-op (selection-mode safe)', () => {
    // SELECT_MODE hit: opening an existing unit must not rewrite its stack.
    const el = fakeTextElement({ 'font-family': 'Marker', 'font-size': '40' })
    expect(vectorTextFontNeedsUpdate(el, { fontFamily: 'Marker', fontSize: 40 })).toEqual({ size: false, family: false })
    expect(vectorTextFontNeedsUpdate(el, { fontFamily: 'Curly' }).family).toBe(true)
    expect(vectorTextFontNeedsUpdate(el, { fontSize: 24 }).size).toBe(true)
    // TEXT_EDIT_MODE commit decisions: empty/noop, insert, update, delete.
    expect(resolveVectorTextCommit(undefined, '')).toBe('noop')
    expect(resolveVectorTextCommit(undefined, 'hi')).toBe('insert')
    expect(resolveVectorTextCommit('same', 'same')).toBe('noop')
    expect(resolveVectorTextCommit('same', 'same', true)).toBe('update')
    expect(resolveVectorTextCommit('hi', '   ')).toBe('delete')
  })

  it('defers Escape/Enter to an active IME (Japanese composition)', () => {
    expect(shouldDeferInlineTextKeyToIme({ isComposing: true }, false)).toBe(true)
    expect(shouldDeferInlineTextKeyToIme({ keyCode: 229 }, false)).toBe(true)
    expect(shouldDeferInlineTextKeyToIme({ which: 229 }, true)).toBe(true)
    expect(shouldDeferInlineTextKeyToIme({}, true)).toBe(true)
    expect(shouldDeferInlineTextKeyToIme({}, false)).toBe(false)
  })

  it('handles Unicode, surrogate pairs, and multiline round-trips', () => {
    // Surrogate pair (emoji) + CJK + combining mark survive splitting.
    const text = 'a\u{1F600}b\n日本語テスト\n\u00e9\u0301'
    const lines = splitVectorTextLines(text)
    expect(lines).toEqual(['a\u{1F600}b', '日本語テスト', '\u00e9\u0301'])
    expect(resolveTextBaseDirection('日本語')).toBe('ltr')
    expect(resolveTextBaseDirection('שלום')).toBe('rtl')
    expect(clampVectorTextFontSize(7.6)).toBe(8)
    expect(clampBitmapTextFontSize(7.6)).toBe(8)
    // Multiline content helper keeps line count for history tests.
    expect(lines.length).toBe(3)
    // New-text defaults match the reference (Sans Serif at 40).
    expect(VECTOR_TEXT_DEFAULT_FONT_FAMILY).toBe('Sans Serif')
    expect(VECTOR_TEXT_MIN_FONT_SIZE).toBe(8)
    expect(clampVectorTextFontSize(Number.NaN)).toBe(40)
    expect(clampBitmapTextFontSize(Number.NaN)).toBe(40)
  })

  it('keeps tspan-unaware doubles compatible with readVectorTextElementContent', () => {
    const rect = { tagName: 'RECT', textContent: 'x' } as unknown as Element
    expect(readVectorTextElementContent(rect)).toBe(undefined)
    const empty = fakeTextElement()
    void empty
    // setVectorTextElementContent refuses non-text nodes (selection safety).
    expect(setVectorTextElementContent(rect, 'hi')).toBe(false)
  })

  it('insert markup keeps every Scratch stack byte-verbatim (CJK quotes survive)', () => {
    // Regression: sanitizeFontFamily used to rewrite `"` to `'`, so a fresh
    // CJK insert no longer matched VECTOR_TEXT_FONT_OPTIONS on reload.
    // Bun unit tests run without DOMParser, so extract the attribute from our
    // own markup and unescape exactly like the XML parser would.
    const unescape = (value: string) =>
      value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    const paint = { defs: '', fill: '#000000' }
    for (const entry of SCRATCH_PAINT_FONTS) {
      const markup = buildVectorTextMarkup({
        x: 240,
        y: 180,
        text: `T3-${entry.id}`,
        paint,
        strokeColor: 'none',
        strokeWidth: 0,
        opacity: 100,
        fontSize: 40,
        fontFamily: entry.value,
      })
      // The literal stack reaches the attribute escaped-but-verbatim.
      expect(markup).toContain('font-size="40"')
      const raw = /font-family="((?:[^"\\]|\\.)*)"/.exec(markup)?.[1]
      expect(raw).not.toBeUndefined()
      const saved = unescape(raw!)
      expect(saved).toBe(entry.value)
      // …so the saved node still resolves toolbar-known (no unknown fallback).
      expect(isKnownVectorTextFontFamily(saved)).toBe(true)
      expect(normalizeVectorTextFontFamily(saved)).toBe(entry.value)
    }
  })
})
