import { escapeXml } from '../../lib/editor-utils'
import { vectorTextSvgForUi } from './vector-stroke-scale'

/**
 * Inline vector-text helpers for the costume editor.
 *
 * Scratch-paint edits text on the canvas: the text tool opens a focused
 * editor at the click point, Enter commits, Escape cancels, and clicking an
 * existing text item re-opens it. The implementation here is original code
 * written against that observable behavior (no scratch-paint source is
 * copied): pure helpers for markup, parsing, and commit decisions so the
 * Svelte components stay thin and history handling stays in one place.
 */

export type VectorTextPaint = { defs: string; fill: string }

/** Independent stroke paint for vector text outlines (`stroke="url(#id)"` gradients or solid/`none`). */
export type VectorTextStrokePaint = { defs: string; stroke: string }

export type VectorTextMarkupOptions = {
  x: number
  y: number
  text: string
  paint: VectorTextPaint
  strokeColor: string
  /** When given, wins over `strokeColor`; defs are prepended after fill defs without touching them. */
  strokePaint?: VectorTextStrokePaint
  strokeWidth: number
  opacity: number
  fontSize: number
  fontFamily: string
  fontWeight?: number | string
  /**
   * Base direction of the text block. `'auto'` (default) resolves from the
   * text content and the document direction via
   * {@link resolveTextBaseDirection}, so LTR/CJK drafts keep the historical
   * centered shape byte-for-byte while RTL drafts anchor right.
   */
  direction?: TextBaseDirection | 'auto'
  /**
   * Document direction override (`'rtl'` / `'ltr'` / null). When omitted, the
   * live `document` direction is read at call time (safe no-op outside a DOM).
   */
  documentDir?: unknown
}

/**
 * Base writing direction of a text block: `'ltr'` keeps the historical
 * centered rendering, `'rtl'` anchors the block at its right edge.
 */
export type TextBaseDirection = 'ltr' | 'rtl'

/**
 * Strong RTL characters: Hebrew, the Arabic-family blocks (Arabic,
 * Supplement, Thaana, NKo, Syriac rows, Extended-A/B) and the Arabic/Hebrew
 * presentation forms, plus the explicit right-to-left mark. Written as
 * explicit ranges so the check runs identically in every engine under test.
 * Tested before the LTR class so RTL always wins per character; the first
 * strong character in the string decides.
 */
const RTL_BMP_RE = /[\u0590-\u05FF\u0600-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE]/u
const RTL_MARK_RE = /\u200F/u
/** Supplementary-plane RTL scripts (Adlam, Hanifi Rohingya, Old Aramaic rows). */
const RTL_SUPPLEMENTARY_RE = /[\u{1E900}-\u{1E95F}\u{10D00}-\u{10D4F}\u{10840}-\u{108AF}\u{10900}-\u{1093F}]/u
const LTR_STRONG_RE = /\p{L}/u

function isRtlStrongChar(char: string) {
  return RTL_BMP_RE.test(char)
    || RTL_MARK_RE.test(char)
    || RTL_SUPPLEMENTARY_RE.test(char)
}

/**
 * First strong directional character in the string, if any. Weak characters
 * (digits, spaces, punctuation, marks) are skipped, mirroring `dir="auto"`.
 */
export function firstStrongTextDirection(text: string): TextBaseDirection | undefined {
  for (const char of text) {
    if (isRtlStrongChar(char)) return 'rtl'
    if (LTR_STRONG_RE.test(char)) return 'ltr'
  }
  return undefined
}

type DirAttributeSource = {
  documentElement?: { getAttribute?: (name: string) => string | null } | null
  body?: { getAttribute?: (name: string) => string | null } | null
}

/**
 * Live document direction (`dir` on `<html>`, falling back to `<body>`).
 * Returns undefined outside a DOM or when no `dir` is set.
 */
export function readDocumentTextDirection(): string | undefined {
  try {
    const source = (globalThis as unknown as { document?: DirAttributeSource }).document
    if (!source) return undefined
    return source.documentElement?.getAttribute?.('dir')
      ?? source.body?.getAttribute?.('dir')
      ?? undefined
  } catch {
    return undefined
  }
}

export function normalizeDocumentDirection(value: unknown): TextBaseDirection | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'rtl') return 'rtl'
  if (normalized === 'ltr') return 'ltr'
  return undefined
}

/**
 * Resolve the base direction of a text block. RTL wins from either side
 * (content first-strong like `dir="auto"`, or an explicit RTL document such
 * as the Hebrew UI, mirroring the reference locale-based justification), so
 * plain LTR/CJK/number drafts in LTR documents always stay `'ltr'`.
 */
export function resolveTextBaseDirection(text: string, documentDir?: unknown): TextBaseDirection {
  if (firstStrongTextDirection(text) === 'rtl') return 'rtl'
  const doc = normalizeDocumentDirection(documentDir ?? readDocumentTextDirection())
  if (doc === 'rtl') return 'rtl'
  return 'ltr'
}

export type VectorTextCommitKind = 'noop' | 'insert' | 'update' | 'delete'

export const VECTOR_TEXT_DEFAULT_FONT_SIZE = 40
export const VECTOR_TEXT_DEFAULT_FONT_FAMILY = 'Sans Serif'
export const VECTOR_TEXT_MIN_FONT_SIZE = 8
export const VECTOR_TEXT_MAX_FONT_SIZE = 144
export const VECTOR_TEXT_MAX_CHARS = 500
export const VECTOR_TEXT_MAX_LINES = 30

/**
 * Reference line height for new text: scratch-paint `text-tool.js` creates
 * `PointText({ fontSize: 40, leading: 46.15 })` and sets the edit textarea to
 * `lineHeight = leading / fontSize`. Verified by reading the vendored source
 * (no code copied). The same ratio drives the SVG/Paper `<text>` multiline
 * `dy` below so saved text matches the reference leading.
 */
export const VECTOR_TEXT_LINE_HEIGHT_RATIO = 46.15 / 40

export type VectorTextFontOption = { label: string; value: string }

/**
 * Unified toolbar shortlist: the 9 reference fonts in dropdown order
 * (`fonts.js` keys + `font-dropdown.jsx` `getFontName` CJK labels +
 * `font-dropdown.css` preview stacks; literal strings only, no font files),
 * followed by the 5 pre-existing xyo system stacks as strict additions (kept
 * so existing artwork never regresses). Reference display names are kept
 * verbatim; no webfont is loaded — decorative reference families fall back
 * to locally installed system fonts (see `vector-text-scratch-fonts.ts`).
 */
export const VECTOR_TEXT_FONT_OPTIONS: VectorTextFontOption[] = [
  { label: 'Sans Serif', value: 'Sans Serif' },
  { label: 'Serif', value: 'Serif' },
  { label: 'Handwriting', value: 'Handwriting' },
  { label: 'Marker', value: 'Marker' },
  { label: 'Curly', value: 'Curly' },
  { label: 'Pixel', value: 'Pixel' },
  { label: '中文', value: '"Microsoft YaHei", "微软雅黑", STXihei, "华文细黑"' },
  { label: '日本語', value: '"ヒラギノ角ゴ Pro W3", "Hiragino Kaku Gothic Pro", Osaka, "メイリオ", Meiryo, "ＭＳ Ｐゴシック", "MS PGothic"' },
  { label: '한국어', value: 'Malgun Gothic' },
  { label: 'Sans Serif (System)', value: 'Arial, sans-serif' },
  { label: 'Serif (System)', value: 'Georgia, serif' },
  { label: 'Monospace', value: '"Courier New", monospace' },
  { label: 'Rounded', value: '"Comic Sans MS", "Chalkboard SE", sans-serif' },
  { label: 'Condensed', value: '"Arial Narrow", Arial, sans-serif' },
]

export function clampVectorTextFontSize(value: number) {
  if (!Number.isFinite(value)) return VECTOR_TEXT_DEFAULT_FONT_SIZE
  return Math.min(VECTOR_TEXT_MAX_FONT_SIZE, Math.max(VECTOR_TEXT_MIN_FONT_SIZE, Math.round(value)))
}

export function normalizeVectorTextFontFamily(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return VECTOR_TEXT_DEFAULT_FONT_FAMILY
  if (VECTOR_TEXT_FONT_OPTIONS.some((option) => option.value === trimmed)) return trimmed
  // Allow arbitrary stacks but cap length so SVG attributes stay sane.
  return trimmed.slice(0, 120)
}

/** True when the stack is one of the toolbar shortlist entries. */
export function isKnownVectorTextFontFamily(value: string) {
  return VECTOR_TEXT_FONT_OPTIONS.some((option) => option.value === value)
}

type VectorTextFontNode = {
  getAttribute?: (name: string) => string | null
  parentElement?: unknown
  parentNode?: unknown
  tagName?: string
  nodeName?: string
}

function vectorTextFontParentOf(node: VectorTextFontNode): VectorTextFontNode | null {
  try {
    const candidate = (node.parentElement ?? node.parentNode ?? null) as unknown
    if (!candidate || typeof (candidate as VectorTextFontNode).getAttribute !== 'function') return null
    return candidate as VectorTextFontNode
  } catch {
    return null
  }
}

function parseVectorTextStyleDeclarations(style: string | null | undefined): Map<string, string> {
  const declarations = new Map<string, string>()
  if (typeof style !== 'string' || !style) return declarations
  try {
    for (const part of style.split(';')) {
      const colon = part.indexOf(':')
      if (colon < 0) continue
      const property = part.slice(0, colon).trim().toLowerCase()
      if (!property) continue
      let value = part.slice(colon + 1).trim().replace(/\s*!important\s*$/i, '').trim()
      if (!value) continue
      declarations.set(property, value)
    }
  } catch {
    // Fail-closed: keep what parsed so far.
  }
  return declarations
}

function isInheritFontKeyword(value: string) {
  return value.trim().toLowerCase() === 'inherit'
}

/**
 * Effective `font-family` of a `<text>` element: inline `style` beats the
 * presentation attribute on the same node, the nearest definition walking
 * self → ancestors wins (so `<g font-family="...">` inheritance and
 * `style="font-family:..."` both resolve), `inherit` continues the walk.
 * Document/class CSS cannot exist in sanitized costumes (`<style>` is
 * stripped), so no MIXED concept is needed here. Returns the toolbar default
 * when nothing defines it. Never throws; caps length at 120.
 */
export function resolveEffectiveVectorTextFontFamily(element: Element): string {
  try {
    let node: VectorTextFontNode | null = element as unknown as VectorTextFontNode
    const seen = new Set<unknown>()
    let depth = 0
    while (node && depth < 32 && !seen.has(node)) {
      const current: VectorTextFontNode = node
      seen.add(current)
      depth += 1
      try {
        const styleValue = parseVectorTextStyleDeclarations(
          current.getAttribute?.('style') ?? null,
        ).get('font-family')
        if (styleValue !== undefined && styleValue !== '') {
          if (!isInheritFontKeyword(styleValue)) return styleValue.slice(0, 120)
          node = vectorTextFontParentOf(current)
          continue
        }
      } catch {
        // Read the attribute path below.
      }
      let attribute: string | null = null
      try {
        attribute = current.getAttribute?.('font-family') ?? null
      } catch {
        attribute = null
      }
      if (attribute !== null && attribute.trim() !== '') {
        if (!isInheritFontKeyword(attribute)) return attribute.trim().slice(0, 120)
        node = vectorTextFontParentOf(current)
        continue
      }
      // `font` shorthand may carry the family (`font: italic bold 24px X`):
      // take the trailing family only when a size token is present, so bare
      // keywords (`font: menu`) never invent a stack.
      try {
        const shorthand = parseVectorTextStyleDeclarations(current.getAttribute?.('style') ?? null).get('font')
        if (shorthand) {
          const family = parseVectorTextFontShorthandFamily(shorthand)
          if (family) return family.slice(0, 120)
        } else {
          const attrShorthand = current.getAttribute?.('font') ?? null
          if (attrShorthand) {
            const family = parseVectorTextFontShorthandFamily(attrShorthand)
            if (family) return family.slice(0, 120)
          }
        }
      } catch {
        // Ignore shorthand; keep walking.
      }
      node = vectorTextFontParentOf(current)
    }
  } catch {
    // Fall through to the default.
  }
  return VECTOR_TEXT_DEFAULT_FONT_FAMILY
}

function parseVectorTextFontShorthandFamily(shorthand: string): string | undefined {
  // `font` shorthand grammar (simplified): optional style/variant/weight
  // keywords, a size token (`12px`, `12pt`, `100%`, `medium`, ...), optional
  // `/line-height`, then the family list. Only accept when a size-like token
  // is seen so `font: menu`-style system keywords stay unresolved.
  const tokens = shorthand.split(',')[0]?.trim()
  if (!tokens) return undefined
  const sizePattern = /\d+(?:\.\d+)?\s*(?:px|pt|pc|mm|cm|in|q|%|em|ex|rem)?|\b(?:xx-small|x-small|small|medium|large|x-large|xx-large|larger|smaller)\b/i
  const match = sizePattern.exec(shorthand)
  if (!match || match.index === undefined) return undefined
  let rest = shorthand.slice(match.index + match[0].length).trim()
  if (rest.startsWith('/')) {
    const lineEnd = /^\/\s*\S+/.exec(rest)
    if (lineEnd) rest = rest.slice(lineEnd[0].length).trim()
  }
  rest = rest.trim().replace(/^,/, '').trim()
  if (!rest) return undefined
  return rest
}

function parseVectorTextFontSizeValue(raw: string): number | undefined {
  const match = /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|q|%|em|ex|rem)?\s*$/i.exec(raw)
  if (!match) return undefined
  const num = Number(match[1])
  if (!Number.isFinite(num) || num <= 0) return undefined
  const unit = (match[2] ?? '').toLowerCase()
  if (!unit || unit === 'px') return num
  // Absolute physical units map to px at 96dpi. Relative units (em/ex/rem/%)
  // depend on context the parser cannot see: fail closed to the ancestor.
  switch (unit) {
    case 'pt': return (num * 96) / 72
    case 'pc': return num * 16
    case 'mm': return (num * 96) / 25.4
    case 'cm': return (num * 96) / 2.54
    case 'in': return num * 96
    case 'q': return (num * 96) / 101.6
    default: return undefined
  }
}

/**
 * Effective `font-size` of a `<text>` element in SVG user units: same
 * self → ancestor walk as the family resolver (inline style beats the
 * attribute, `inherit` continues). Physical units map to px at 96dpi;
 * relative units fail closed to the ancestor. Returns undefined when nothing
 * defines a usable size so callers can fall back to the toolbar default.
 */
export function resolveEffectiveVectorTextFontSize(element: Element): number | undefined {
  try {
    let node: VectorTextFontNode | null = element as unknown as VectorTextFontNode
    const seen = new Set<unknown>()
    let depth = 0
    while (node && depth < 32 && !seen.has(node)) {
      const current: VectorTextFontNode = node
      seen.add(current)
      depth += 1
      try {
        const styleValue = parseVectorTextStyleDeclarations(
          current.getAttribute?.('style') ?? null,
        ).get('font-size')
        if (styleValue !== undefined && styleValue !== '') {
          if (!isInheritFontKeyword(styleValue)) {
            const parsed = parseVectorTextFontSizeValue(styleValue)
            if (parsed !== undefined) return parsed
          } else {
            node = vectorTextFontParentOf(current)
            continue
          }
        }
      } catch {
        // Read the attribute path below.
      }
      let attribute: string | null = null
      try {
        attribute = current.getAttribute?.('font-size') ?? null
      } catch {
        attribute = null
      }
      if (attribute !== null && attribute.trim() !== '') {
        if (!isInheritFontKeyword(attribute)) {
          const parsed = parseVectorTextFontSizeValue(attribute)
          if (parsed !== undefined) return parsed
        } else {
          node = vectorTextFontParentOf(current)
          continue
        }
      }
      node = vectorTextFontParentOf(current)
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * True when applying `patch` would visibly change the element's font
 * attributes (same-value writes are skipped so repeat commits stay
 * history-clean). Size compares clamped (toolbar semantics); family compares
 * normalized.
 */
export function vectorTextFontNeedsUpdate(
  element: Element,
  patch: { fontSize?: number; fontFamily?: string },
): { size: boolean; family: boolean } {
  let size = false
  let family = false
  try {
    if (patch.fontSize !== undefined && Number.isFinite(patch.fontSize)) {
      const next = clampVectorTextFontSize(patch.fontSize)
      const current = resolveEffectiveVectorTextFontSize(element)
      const currentClamped = current === undefined ? VECTOR_TEXT_DEFAULT_FONT_SIZE : clampVectorTextFontSize(current)
      size = next !== currentClamped
    }
    if (patch.fontFamily !== undefined) {
      const next = normalizeVectorTextFontFamily(patch.fontFamily)
      family = next !== resolveEffectiveVectorTextFontFamily(element)
    }
  } catch {
    // Fail-open to "needs update" only for fields the caller supplied.
    if (patch.fontSize !== undefined) size = true
    if (patch.fontFamily !== undefined) family = true
  }
  return { size, family }
}

/** Split pasted/typed text into lines, normalizing CRLF and capping size. */
export function splitVectorTextLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').slice(0, VECTOR_TEXT_MAX_LINES)
  return lines.map((line) => line.slice(0, VECTOR_TEXT_MAX_CHARS))
}

/** True when there is nothing worth committing (whitespace/newlines only). */
export function isVectorTextEmpty(text: string) {
  return splitVectorTextLines(text).join('').trim().length === 0
}

export function vectorTextLineHeight(fontSize: number) {
  return clampVectorTextFontSize(fontSize) * VECTOR_TEXT_LINE_HEIGHT_RATIO
}

function opacityValue(opacity: number) {
  return Math.max(0, Math.min(1, opacity / 100))
}

function formatSvgNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(3))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

function sanitizeFontFamily(value: string) {
  // Font stacks end up inside a double-quoted XML attribute; `escapeXml` at
  // the write site already encodes `"`, `<`, `>`, `&` (and `'`), so the value
  // must be preserved verbatim here. An earlier revision replaced `"` with
  // `'` which silently rewrote the CJK reference stacks (e.g. `"Microsoft
  // YaHei", ...` became `'Microsoft YaHei', ...`): the saved bytes no longer
  // matched `VECTOR_TEXT_FONT_OPTIONS`, so freshly inserted CJK text showed as
  // unknown on reload. Only cap length; never mutate quotes.
  return normalizeVectorTextFontFamily(value).slice(0, 120)
}

/**
 * Build a `<text>` element string at SVG point (x, y). The first line sits on
 * the baseline at y; extra lines become `<tspan>` rows with a 1.2em offset so
 * multiline text survives a save/reload round-trip. Single-line output keeps
 * the historical plain-text shape (`<text>x</text>`) for compatibility.
 *
 * LTR output is byte-identical to the historical shape (`text-anchor="middle"`
 * with no direction attribute). RTL output anchors the block at its right
 * edge (`text-anchor="start" direction="rtl"` with the same x: inline-start
 * is the right edge under RTL direction, while `end` would pin the left
 * edge), so the click point stays the right edge in both the canvas editor
 * and the saved SVG.
 */
export function buildVectorTextMarkup(options: VectorTextMarkupOptions) {
  const fontSize = clampVectorTextFontSize(options.fontSize)
  const family = sanitizeFontFamily(options.fontFamily)
  const weight = options.fontWeight ?? 700
  const baseDir = options.direction && options.direction !== 'auto'
    ? options.direction
    : resolveTextBaseDirection(options.text, options.documentDir)
  const anchor = baseDir === 'rtl' ? 'start' : 'middle'
  const dirAttr = baseDir === 'rtl' ? ' direction="rtl"' : ''
  const lines = splitVectorTextLines(options.text).map((line) => (line.length === 0 ? ' ' : line))
  const x = formatSvgNumber(options.x)
  const y = formatSvgNumber(options.y + 8)
  const dy = formatSvgNumber(vectorTextLineHeight(fontSize))
  const stroke = options.strokePaint?.stroke ?? options.strokeColor
  const combinedDefs = `${options.paint.defs}${options.strokePaint?.defs ?? ''}`
  const attrs = `x="${x}" y="${y}" text-anchor="${anchor}"${dirAttr} font-family="${escapeXml(family)}" font-size="${fontSize}" font-weight="${weight}" fill="${options.paint.fill}" stroke="${escapeXml(stroke)}" stroke-width="${formatSvgNumber(vectorTextSvgForUi(options.strokeWidth))}" opacity="${opacityValue(options.opacity)}"`
  if (lines.length <= 1) return `${combinedDefs}<text ${attrs}>${escapeXml(lines[0] ?? '')}</text>`
  const spans = lines
    .map((line, index) => (index === 0
      ? `<tspan x="${x}" dy="0">${escapeXml(line)}</tspan>`
      : `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`))
    .join('')
  return `${combinedDefs}<text ${attrs}>${spans}</text>`
}

/** Read editable text back from a `<text>` element (tspan-aware). */
export function readVectorTextElementContent(element: Element) {
  const tag = element.tagName.toLowerCase()
  if (tag !== 'text') return undefined
  const lines = readVectorTextSpanLines(element)
  // Single-line shape (no top-level `<tspan>` rows): plain text, kept as-is
  // so legacy `<text>hello</text>` artwork round-trips byte-for-byte.
  if (lines === undefined) return element.textContent ?? ''
  return lines.join('\n').replace(/ +\n/g, '\n')
}

type VectorTextChildNode = {
  nodeType?: number
  data?: string
  textContent?: string | null
  tagName?: string
}

type VectorTextParentLink = {
  parentNode?: unknown
  parentElement?: unknown
}

function vectorTextParentOf(span: Element): unknown {
  const link = span as unknown as VectorTextParentLink
  return link.parentNode ?? link.parentElement
}

/**
 * Split a `<text>` element into per-line strings following SVG `<tspan>`
 * semantics: each top-level `<tspan>` row is one line, so multiline artwork
 * committed as `<tspan>` rows round-trips back with its `\n` separators.
 * Returns undefined when the element has no top-level `<tspan>` (the
 * historical single-line shape).
 *
 * Nested `<tspan>` nodes are styling spans *within* a line (their text is
 * already part of the parent row's `textContent`), so only direct `<tspan>`
 * children open a new line. Stray direct text (e.g. pretty-print whitespace
 * between rows) is ignored unless it carries non-whitespace content, in
 * which case it becomes its own line in document order so no content is
 * silently dropped.
 */
function readVectorTextSpanLines(element: Element): string[] | undefined {
  const childNodes = (element as unknown as { childNodes?: ArrayLike<VectorTextChildNode> }).childNodes
  if (childNodes && typeof childNodes.length === 'number') {
    const lines: string[] = []
    let direct = ''
    let sawTspan = false
    const flushDirect = () => {
      if (direct.trim() !== '') lines.push(direct)
      direct = ''
    }
    for (const node of Array.from(childNodes)) {
      if (node.nodeType === 3) {
        direct += node.data ?? node.textContent ?? ''
      } else if (node.nodeType === 1 && (node.tagName ?? '').toLowerCase() === 'tspan') {
        sawTspan = true
        flushDirect()
        lines.push((node as unknown as Element).textContent ?? '')
      } else if (node.nodeType === 1) {
        // Non-tspan child elements are unexpected inside `<text>`; keep any
        // text they carry so content is never silently dropped.
        flushDirect()
        const text = (node as unknown as Element).textContent ?? ''
        if (text.trim() !== '') lines.push(text)
      }
      // Other node types (comments, processing instructions) are ignored.
    }
    flushDirect()
    if (!sawTspan) return undefined
    return lines
  }
  // Fallback for lightweight test doubles without `childNodes`: keep only
  // spans parented directly to the `<text>` node so nested styling tspans
  // don't become extra lines. Doubles without any parent links can't express
  // nesting, so they keep the historical all-spans behavior.
  const all = Array.from(element.getElementsByTagName('tspan'))
  if (all.length === 0) return undefined
  const hasParentInfo = all.some((span) => vectorTextParentOf(span) !== undefined && vectorTextParentOf(span) !== null)
  const rows = hasParentInfo ? all.filter((span) => vectorTextParentOf(span) === (element as unknown)) : all
  if (rows.length === 0) return undefined
  return rows.map((span) => span.textContent ?? '')
}

/**
 * Replace the content/position/style of an existing `<text>` element in
 * place. Returns false when the element is not a `<text>` node.
 *
 * Only the fields present in `options` are touched: omitting `fontSize` /
 * `fontFamily` keeps the element's own attributes AND any ancestor
 * inheritance / inline `style` exactly as they were, so editing only the
 * characters never flattens an external SVG's font stack to the toolbar
 * defaults. Supplied font values that equal the effective value are skipped
 * (same-value no-op, inheritance preserved).
 *
 * Direction follows the new text: RTL drafts gain `direction="rtl"` with a
 * right anchor, LTR drafts drop a previously set RTL marker and restore the
 * centered anchor. Elements without any RTL marker are left untouched apart
 * from the requested updates, and `transform` is never modified so scaled or
 * rotated text keeps its matrix. `font-weight` is never touched.
 *
 * Rich `<tspan>` rows keep their per-row presentation attributes (everything
 * except the rebuilt `x`/`dy` geometry): row `i` of the new content reuses
 * row `i`'s old attributes, and appended rows clone the first row's. Nested
 * styling tspans inside a row are replaced with the new plain line text
 * (their styling cannot survive a content swap); element-level attributes
 * always survive.
 */
export function setVectorTextElementContent(
  element: Element,
  text: string,
  options?: { x?: number; y?: number; fontSize?: number; fontFamily?: string; direction?: TextBaseDirection | 'auto'; documentDir?: unknown },
) {
  if (element.tagName.toLowerCase() !== 'text') return false
  const lines = splitVectorTextLines(text)
  // Snapshot per-row tspan presentation attributes BEFORE clearing, so rich
  // external artwork (per-line fill/weight/style/...) survives a re-edit.
  const rowExtras = snapshotVectorTextRowAttributes(element)
  if (options?.x !== undefined && Number.isFinite(options.x)) element.setAttribute('x', formatSvgNumber(options.x))
  if (options?.y !== undefined && Number.isFinite(options.y)) element.setAttribute('y', formatSvgNumber(options.y + 8))
  if (options?.fontSize !== undefined && Number.isFinite(options.fontSize)) {
    if (vectorTextFontNeedsUpdate(element, { fontSize: options.fontSize }).size) {
      element.setAttribute('font-size', String(clampVectorTextFontSize(options.fontSize)))
    }
  }
  if (options?.fontFamily !== undefined) {
    if (vectorTextFontNeedsUpdate(element, { fontFamily: options.fontFamily }).family) {
      element.setAttribute('font-family', normalizeVectorTextFontFamily(options.fontFamily))
    }
  }
  const baseDir = options?.direction && options.direction !== 'auto'
    ? options.direction
    : resolveTextBaseDirection(text, options?.documentDir)
  if (baseDir === 'rtl') {
    // Inline-start is the right edge under RTL direction, so this pins the
    // block's right edge at x. (`end` would pin the left edge instead.)
    element.setAttribute('text-anchor', 'start')
    element.setAttribute('direction', 'rtl')
  } else if (element.getAttribute('direction') !== null) {
    element.setAttribute('text-anchor', 'middle')
    const removable = element as unknown as { removeAttribute?: (name: string) => void }
    if (typeof removable.removeAttribute === 'function') removable.removeAttribute('direction')
  }
  while (element.firstChild) element.removeChild(element.firstChild)
  const doc = element.ownerDocument
  if (lines.length <= 1) {
    element.textContent = lines[0] ?? ''
    return true
  }
  const x = element.getAttribute('x') ?? '0'
  const effectiveSize = options?.fontSize !== undefined && Number.isFinite(options.fontSize)
    ? clampVectorTextFontSize(options.fontSize)
    : (resolveEffectiveVectorTextFontSize(element) ?? VECTOR_TEXT_DEFAULT_FONT_SIZE)
  const dy = formatSvgNumber(vectorTextLineHeight(effectiveSize))
  lines.forEach((line, index) => {
    const span = doc.createElementNS('http://www.w3.org/2000/svg', 'tspan')
    span.setAttribute('x', x)
    span.setAttribute('dy', index === 0 ? '0' : dy)
    for (const extra of rowExtras[index] ?? rowExtras[0] ?? []) {
      try {
        if (extra.name === 'x' || extra.name === 'dy') continue
        span.setAttribute(extra.name, extra.value)
      } catch {
        // Best effort: one bad attribute never blocks the content write.
      }
    }
    span.textContent = line.length === 0 ? ' ' : line
    element.appendChild(span)
  })
  return true
}

type VectorTextRowAttribute = { name: string; value: string }

function snapshotVectorTextRowAttributes(element: Element): VectorTextRowAttribute[][] {
  try {
    const rows: VectorTextRowAttribute[][] = []
    const children = (element as unknown as { children?: ArrayLike<Element> }).children
    if (!children || typeof children.length !== 'number') return rows
    for (const child of Array.from(children)) {
      try {
        if ((child.tagName ?? '').toLowerCase() !== 'tspan') continue
        const extras: VectorTextRowAttribute[] = []
        const names: readonly string[] = typeof (child as unknown as { getAttributeNames?: () => string[] }).getAttributeNames === 'function'
          ? (child as unknown as { getAttributeNames: () => string[] }).getAttributeNames()
          : Array.from((child as unknown as { attributes?: ArrayLike<{ name: string; value: string }> }).attributes ?? []).map((attr) => attr.name)
        for (const name of names) {
          if (name === 'x' || name === 'dy') continue
          let value: string | null = null
          try {
            value = child.getAttribute(name)
          } catch {
            value = null
          }
          if (value !== null) extras.push({ name, value })
        }
        rows.push(extras)
      } catch {
        rows.push([])
      }
    }
    return rows
  } catch {
    return []
  }
}

/**
 * Decide what a commit should do before touching history. Pure so it can be
 * unit-tested: empty drafts never write history; clearing an existing item
 * deletes it; unchanged text is a no-op; otherwise insert or update.
 * `fontChanged` covers font-only edits (same characters, explicit font/size
 * change): they commit as `update` so the typeface change is not silently
 * dropped, while same-value font intent stays `noop`.
 */
export function resolveVectorTextCommit(existingText: string | undefined, draftText: string, fontChanged = false, paintChanged = false): VectorTextCommitKind {
  const draftEmpty = isVectorTextEmpty(draftText)
  if (existingText === undefined) return draftEmpty ? 'noop' : 'insert'
  if (draftEmpty) return isVectorTextEmpty(existingText) ? 'noop' : 'delete'
  if (draftText !== existingText) return 'update'
  return fontChanged || paintChanged ? 'update' : 'noop'
}

/**
 * Toolbar paint snapshot for a vector-text inline session. Mirrors the font
 * session baseline pattern (`vectorTextFontSessionBaseline`): the open-time
 * toolbar paint is recorded with its owner (stable target id + costume index
 * + unit index) so `commitVectorInlineText` can tell an explicit toolbar
 * change made while THIS unit's session is open from a stale preset.
 *
 * The toolbar itself is never rewritten here (unlike the font display sync):
 * paint keeps its global preset values + MIXED badges, and a characters-only
 * edit must leave every paint attribute untouched.
 */
export type VectorTextPaintToolbarSnapshot = {
  fillTransparent: boolean
  fillHex: string
  secondaryTransparent: boolean
  secondaryHex: string
  paintGradient: string
  strokeTransparent: boolean
  strokeHex: string
  secondaryStrokeTransparent: boolean
  secondaryStrokeHex: string
  strokeGradient: string
  strokeWidth: number
  vectorOpacity: number
}

export type VectorTextPaintSessionBaseline = {
  targetId: string
  costumeIndex: number
  targetIndex: number
  paint: VectorTextPaintToolbarSnapshot
}

export type VectorTextPaintField =
  | 'fill'
  | 'fillSecondary'
  | 'fillGradient'
  | 'stroke'
  | 'strokeSecondary'
  | 'strokeGradient'
  | 'strokeWidth'
  | 'opacity'

function normalizeVectorTextHex(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Explicit toolbar paint fields changed during a text session
 * (`current` vs open-time `baseline`). Pure so it can be unit-tested.
 *
 * Secondary ends are only reported when the CURRENT gradient kind needs them
 * (solid never reads a secondary, mirroring `buildVectorStylePatchFromDirty`),
 * so toggling an unused secondary stays a no-op and never flattens paint.
 */
export function vectorTextPaintChangedFields(
  baseline: VectorTextPaintToolbarSnapshot,
  current: VectorTextPaintToolbarSnapshot,
): VectorTextPaintField[] {
  const changed: VectorTextPaintField[] = []
  const fillHexChanged = normalizeVectorTextHex(baseline.fillHex) !== normalizeVectorTextHex(current.fillHex)
  if (Boolean(baseline.fillTransparent) !== Boolean(current.fillTransparent) || fillHexChanged) {
    changed.push('fill')
  }
  const fillSecondaryRelevant = current.paintGradient !== 'solid'
  if (fillSecondaryRelevant) {
    const secondaryHexChanged = normalizeVectorTextHex(baseline.secondaryHex) !== normalizeVectorTextHex(current.secondaryHex)
    if (Boolean(baseline.secondaryTransparent) !== Boolean(current.secondaryTransparent) || secondaryHexChanged) {
      changed.push('fillSecondary')
    }
  }
  if (String(baseline.paintGradient) !== String(current.paintGradient)) {
    changed.push('fillGradient')
  }
  const strokeHexChanged = normalizeVectorTextHex(baseline.strokeHex) !== normalizeVectorTextHex(current.strokeHex)
  if (Boolean(baseline.strokeTransparent) !== Boolean(current.strokeTransparent) || strokeHexChanged) {
    changed.push('stroke')
  }
  const strokeSecondaryRelevant = current.strokeGradient !== 'solid'
  if (strokeSecondaryRelevant) {
    const secondaryHexChanged = normalizeVectorTextHex(baseline.secondaryStrokeHex) !== normalizeVectorTextHex(current.secondaryStrokeHex)
    if (Boolean(baseline.secondaryStrokeTransparent) !== Boolean(current.secondaryStrokeTransparent) || secondaryHexChanged) {
      changed.push('strokeSecondary')
    }
  }
  if (String(baseline.strokeGradient) !== String(current.strokeGradient)) {
    changed.push('strokeGradient')
  }
  const baselineWidth = Number(baseline.strokeWidth)
  const currentWidth = Number(current.strokeWidth)
  if (!(baselineWidth === currentWidth) && !(Number.isNaN(baselineWidth) && Number.isNaN(currentWidth))) {
    changed.push('strokeWidth')
  }
  const baselineOpacity = Number(baseline.vectorOpacity)
  const currentOpacity = Number(current.vectorOpacity)
  if (!(baselineOpacity === currentOpacity) && !(Number.isNaN(baselineOpacity) && Number.isNaN(currentOpacity))) {
    changed.push('opacity')
  }
  return changed
}

/** Clamp a click point into the 480x360 vector canvas. */
export function clampVectorTextPoint(point: { x: number; y: number }) {
  return {
    x: Math.max(0, Math.min(480, point.x)),
    y: Math.max(0, Math.min(360, point.y)),
  }
}
