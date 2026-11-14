import {
  BITMAP_TEXT_MAX_CHARS,
  BITMAP_TEXT_MAX_FONT_SIZE,
  BITMAP_TEXT_MIN_FONT_SIZE,
  clampBitmapTextFontSize,
} from './bitmap-text'
import {
  VECTOR_TEXT_FONT_OPTIONS,
  VECTOR_TEXT_MAX_CHARS,
  VECTOR_TEXT_MAX_FONT_SIZE,
  VECTOR_TEXT_MAX_LINES,
  VECTOR_TEXT_MIN_FONT_SIZE,
  clampVectorTextFontSize,
  isKnownVectorTextFontFamily,
  normalizeVectorTextFontFamily,
  splitVectorTextLines,
} from './vector-text'

/**
 * T-3 Scratch paint font listing vs the current xyo-editor unified toolbar.
 *
 * Facts only (no font files, no AGPL text):
 * - Scratch values/labels come from `.tmp/scratch-editor/packages/scratch-paint`
 *   `src/lib/fonts.js` (9 keys), `src/containers/font-dropdown.jsx`
 *   `getFontName` (CJK display labels), and
 *   `src/components/font-dropdown/font-dropdown.css` (preview stacks).
 * - Scratch rendering resolves the literal families through its own font
 *   loading (`scratch-render-fonts` is a `peerDependency: 1.0.258` of
 *   `@scratch/scratch-paint@15.3.0`, `AGPL-3.0-only`); xyo-editor vendors no
 *   font assets (verified: no woff/woff2/ttf/otf under `public/`; only CC
 *   BY-SA SVG media under `public/assets-scratch/`).
 *
 * xyo-editor now shows the 9 Scratch literals plus its 5 pre-existing system
 * stacks as one unified toolbar (`VECTOR_TEXT_FONT_OPTIONS`, 14 entries).
 * This module only *describes* the Scratch list and validates against those
 * unified xyo limits. No webfont is fetched or embedded: decorative Scratch
 * families (`Handwriting`/`Marker`/`Curly`/`Pixel`) resolve through normal
 * CSS fallback to whatever the OS/browser has installed.
 *
 * Binary/license limitation (unsupported): the Scratch decorative families
 * are distributed via the separate `scratch-render-fonts` package whose
 * redistribution terms are unconfirmed here. xyo-editor therefore ships no
 * font binaries, performs no runtime font download, and keeps every stack as
 * a plain `font-family` string so missing families degrade to system
 * fallback instead of breaking the document.
 */

export type ScratchPaintFontKind = 'bundled-webfont' | 'system-literal' | 'locale-stack'

export type ScratchPaintFontEntry = {
  /** Stable key matching `fonts.js` (e.g. `SANS_SERIF`). */
  id: string
  /** User-visible label (`getFontName`: CJK rows are localized). */
  label: string
  /** Literal `font-family` value stored in SVG / Paper `PointText.font`. */
  value: string
  kind: ScratchPaintFontKind
  /** Availability note (no vendored asset in this repo). */
  availability: string
}

/**
 * The 9 Scratch paint fonts in dropdown order.
 * Values are literal strings (facts), not font binaries.
 */
export const SCRATCH_PAINT_FONTS: readonly ScratchPaintFontEntry[] = [
  {
    id: 'SANS_SERIF',
    label: 'Sans Serif',
    value: 'Sans Serif',
    kind: 'system-literal',
    availability: 'Literal family resolved by Scratch font loading with system fallback; no asset vendored here.',
  },
  {
    id: 'SERIF',
    label: 'Serif',
    value: 'Serif',
    kind: 'system-literal',
    availability: 'Literal family resolved by Scratch font loading with system fallback; no asset vendored here.',
  },
  {
    id: 'HANDWRITING',
    label: 'Handwriting',
    value: 'Handwriting',
    kind: 'bundled-webfont',
    availability: 'Scratch peer font (scratch-render-fonts); not bundled in xyo-editor, falls back to system fonts here.',
  },
  {
    id: 'MARKER',
    label: 'Marker',
    value: 'Marker',
    kind: 'bundled-webfont',
    availability: 'Scratch peer font (scratch-render-fonts); not bundled in xyo-editor, falls back to system fonts here.',
  },
  {
    id: 'CURLY',
    label: 'Curly',
    value: 'Curly',
    kind: 'bundled-webfont',
    availability: 'Scratch peer font (scratch-render-fonts); not bundled in xyo-editor, falls back to system fonts here.',
  },
  {
    id: 'PIXEL',
    label: 'Pixel',
    value: 'Pixel',
    kind: 'bundled-webfont',
    availability: 'Scratch peer font (scratch-render-fonts); not bundled in xyo-editor, falls back to system fonts here.',
  },
  {
    id: 'CHINESE',
    label: '中文',
    value: '"Microsoft YaHei", "微软雅黑", STXihei, "华文细黑"',
    kind: 'locale-stack',
    availability: 'OS CJK stack (Windows/macOS Han fonts); system-dependent fallback, no asset vendored here.',
  },
  {
    id: 'JAPANESE',
    label: '日本語',
    value: '"ヒラギノ角ゴ Pro W3", "Hiragino Kaku Gothic Pro", Osaka, "メイリオ", Meiryo, "ＭＳ Ｐゴシック", "MS PGothic"',
    kind: 'locale-stack',
    availability: 'OS CJK stack (Hiragino/Meiryo/MS PGothic); system-dependent fallback, no asset vendored here.',
  },
  {
    id: 'KOREAN',
    label: '한국어',
    value: 'Malgun Gothic',
    kind: 'locale-stack',
    availability: 'OS CJK stack (Malgun Gothic); system-dependent fallback, no asset vendored here.',
  },
]

/** Lookup by literal SVG `font-family` value. */
export function scratchPaintFontForValue(value: string): ScratchPaintFontEntry | undefined {
  return SCRATCH_PAINT_FONTS.find((entry) => entry.value === value)
}

/** True for any of the 9 literal Scratch values (not the xyo toolbar shortlist). */
export function isScratchPaintFontValue(value: string): boolean {
  return scratchPaintFontForValue(value) !== undefined
}

/** Display label for a Scratch value (`中文`/`日本語`/`한국어` for CJK rows). */
export function scratchPaintFontLabelForValue(value: string): string {
  return scratchPaintFontForValue(value)?.label ?? value
}

/**
 * Line-spacing facts (ratios, not assets):
 * - Scratch `text-tool.js` creates `PointText({ fontSize: 40, leading: 46.15 }`
 *   and sets the edit textarea to `lineHeight = leading / fontSize`.
 * - xyo vector multiline uses the same `46.15 / 40` tspan offset, and xyo
 *   bitmap raster now uses the same `46.15 / 40` row advance so committed
 *   rows match the reference raster (`rasterize(72, ..., drawnBounds)` of
 *   that same leading; Paper `_draw` advances each row by `leading`).
 */
export const SCRATCH_TEXT_LEADING_AT_DEFAULT = 46.15
export const SCRATCH_TEXT_DEFAULT_FONT_SIZE = 40
export const SCRATCH_TEXT_LEADING_RATIO = SCRATCH_TEXT_LEADING_AT_DEFAULT / SCRATCH_TEXT_DEFAULT_FONT_SIZE
export const XYO_VECTOR_TEXT_LINE_HEIGHT_RATIO = 46.15 / 40
export const XYO_BITMAP_TEXT_LINE_HEIGHT_RATIO = 46.15 / 40

/**
 * Size/limit facts (xyo's own safety bounds; Scratch paint has no numeric
 * font-size input — size changes via selection handles — and no 500/30 caps
 * in `text-tool.js`):
 * - vector toolbar input `min=8 max=144`, commit clamps to 8–144;
 * - bitmap toolbar input `min=8 max=200`, commit clamps to 8–200;
 * - drafts cap at 500 chars/line and 30 lines (`splitVectorTextLines`).
 */
export const XYO_VECTOR_TEXT_SIZE_RANGE = {
  min: VECTOR_TEXT_MIN_FONT_SIZE,
  max: VECTOR_TEXT_MAX_FONT_SIZE,
} as const
export const XYO_BITMAP_TEXT_SIZE_RANGE = {
  min: BITMAP_TEXT_MIN_FONT_SIZE,
  max: BITMAP_TEXT_MAX_FONT_SIZE,
} as const
export const XYO_TEXT_DRAFT_LIMITS = {
  maxCharsPerLine: VECTOR_TEXT_MAX_CHARS,
  maxLines: VECTOR_TEXT_MAX_LINES,
  bitmapMaxCharsPerLine: BITMAP_TEXT_MAX_CHARS,
} as const

export function clampXyoVectorTextFontSize(value: number): number {
  return clampVectorTextFontSize(value)
}

export function clampXyoBitmapTextFontSize(value: number): number {
  return clampBitmapTextFontSize(value)
}

/**
 * Unsupported-font limitation record (binary/license): decorative Scratch
 * families have no vendored binary in this repo and no runtime download is
 * performed (unconfirmed redistribution terms). The document keeps the
 * literal stack verbatim; rendering falls back to installed system fonts.
 */
export const SCRATCH_FONT_BINARY_LIMITATION =
  'Scratch decorative webfonts (Handwriting/Marker/Curly/Pixel) are not bundled ' +
  'and are never fetched at runtime (license unconfirmed); literal font-family ' +
  'strings are preserved and fall back to system fonts when unavailable.'

export type XyoTextDraftValidation = {
  lines: string[]
  lineCount: number
  truncatedLines: boolean
  truncatedChars: boolean
}

/** Validate a draft against the xyo 500 chars × 30 lines bound (pure). */
export function validateXyoTextDraft(text: string): XyoTextDraftValidation {
  const lines = splitVectorTextLines(text)
  const rawLineCount = text.replace(/\r\n?/g, '\n').split('\n').length
  const rawMaxLen = text.replace(/\r\n?/g, '\n').split('\n').reduce((m, l) => Math.max(m, l.length), 0)
  return {
    lines,
    lineCount: lines.length,
    truncatedLines: rawLineCount > VECTOR_TEXT_MAX_LINES,
    truncatedChars: rawMaxLen > VECTOR_TEXT_MAX_CHARS,
  }
}

export type ScratchCoverageNote = {
  scratchId: string
  scratchLabel: string
  scratchValue: string
  /** How xyo treats this value today: toolbar-known vs verbatim-preserved unknown. */
  xyoHandling: 'toolbar-known' | 'verbatim-unknown-preserved'
  note: string
}

/**
 * Coverage of each Scratch font against the unified xyo toolbar.
 * All 9 Scratch literals are now toolbar-known (selected verbatim, committed
 * only on explicit change). The 5 xyo system stacks (incl. Monospace/Rounded/
 * Condensed and the `(System)`-suffixed Sans/Serif aliases) are extra
 * user-visible choices with no Scratch counterpart and must NOT be removed:
 * they are strict additions, not replacements.
 */
export function describeScratchFontCoverage(): ScratchCoverageNote[] {
  return SCRATCH_PAINT_FONTS.map((entry) => {
    const known = isKnownVectorTextFontFamily(entry.value)
    return {
      scratchId: entry.id,
      scratchLabel: entry.label,
      scratchValue: entry.value,
      xyoHandling: known ? 'toolbar-known' : 'verbatim-unknown-preserved',
      note: known
        ? 'Matches the unified toolbar; edits rewrite it only when explicitly changed.'
        : 'Unknown to the toolbar; shown verbatim and preserved on characters-only edits.',
    }
  })
}

/** xyo toolbar stacks that have no Scratch counterpart (must keep; additions). */
export function xyoToolbarSupersetStacks(): { label: string; value: string }[] {
  const scratchValues = new Set(SCRATCH_PAINT_FONTS.map((entry) => entry.value))
  return VECTOR_TEXT_FONT_OPTIONS.filter((option) => !scratchValues.has(option.value)).map((option) => ({
    label: option.label,
    value: normalizeVectorTextFontFamily(option.value),
  }))
}
