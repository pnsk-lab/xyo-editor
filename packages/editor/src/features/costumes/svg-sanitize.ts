import DOMPurify from 'dompurify'

/**
 * Browser-side SVG trust boundary for costume previews and Paper.js imports.
 *
 * Untrusted SVG bytes (uploads, sb3/sprite3 assets, library fetches) must
 * never reach Svelte `{@html}` or `paper.importSVG` without passing through
 * {@link sanitizeSvgForDisplay}. DOMPurify does the heavy lifting (DOM-based,
 * not regex); a strict post-pass then allowlists `href` values, strips any
 * external `url(...)` from presentation attributes / `style` (local `#`
 * fragments and embedded raster `data:` only, fail-closed on escapes, quotes,
 * case/whitespace, entities or multiple urls), drops any `url()`-free CSS
 * fetch function (`image-set()` / `-webkit-image-set()` / `image()` /
 * `cross-fade()` incl. `-webkit-` prefixes, nested and `var()`-wrapped forms —
 * all fail-closed regardless of argument, since costumes never need them) and
 * drops any event-handler-like attributes that survived odd encodings.
 * `data-paper-data` (which Paper.js `JSON.parse`s at import time, aborting the
 * whole import on malformed values) is always stripped: retention has no
 * functional use (the editor never reads `item._data`, the VM boundary drops
 * it too) and only keeps the crash / prototype-pollution surface.
 *
 * Original code for this repository (no copied sanitizer logic).
 */

export const SVG_SANITIZE_MAX_CHARS = 2_000_000

export const SVG_PLACEHOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
// Fragment wrapper always declares xlink: bare `<image xlink:href="..."/>`
// / `<use xlink:href="#..."/>` fragments (e.g. `outerHTML` snapshots taken
// from a live document, which carry the prefix without an in-fragment
// declaration) are otherwise a fail-closed XML parse error once wrapped in a
// plain `<svg>` root. Declaring it on the wrapper keeps those harmless
// embedded-PNG / local-ref fragments parse-safe; fragments that already
// declare it on an inner element simply redeclare the same URI (valid).
const SVG_FRAGMENT_WRAPPER_PREFIX = `<svg xmlns="${SVG_NAMESPACE}" xmlns:xlink="${XLINK_NAMESPACE}">`
const SVG_FRAGMENT_WRAPPER_SUFFIX = '</svg>'

/**
 * Inject a missing `xmlns:xlink` declaration on the first `<svg>` root when
 * the markup uses the `xlink:` prefix. Full documents parsed as XML require
 * every prefix to be bound; HTML-serialized clipboard snapshots (`outerHTML`)
 * and hand-written SVGs often carry bare `xlink:href` without the root
 * declaration, which would otherwise fail closed to the placeholder and drop
 * harmless embedded PNG / local `#` refs. No-op when no `xlink:` usage is
 * present or any `xmlns:xlink` is already declared (existing declarations,
 * including inner-element ones like `buildVectorImageMarkup`, are left
 * untouched). Never throws.
 */
function ensureXlinkNamespaceDeclared(markup: string): string {
  try {
    if (!markup.includes('xlink:')) return markup
    if (/xmlns:xlink\s*=/i.test(markup)) return markup
    const match = /<svg\b[^>]*>/i.exec(markup)
    if (!match || !match[0]) return markup
    const tag = match[0]
    if (/xmlns:xlink\s*=/i.test(tag)) return markup
    const patched = tag.endsWith('/>') ? `${tag.slice(0, -2)} xmlns:xlink="${XLINK_NAMESPACE}"/>` : `${tag.slice(0, -1)} xmlns:xlink="${XLINK_NAMESPACE}">`
    return `${markup.slice(0, match.index)}${patched}${markup.slice(match.index + tag.length)}`
  } catch {
    return markup
  }
}

/**
 * True when the markup already presents as a full SVG document (optional XML
 * declaration / comments / doctype followed by `<svg`). Used to avoid nesting
 * a document inside the fragment wrapper.
 */
function looksLikeFullSvgDocument(dirty: string): boolean {
  const stripped = dirty
    .replace(/^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)?(?:<!DOCTYPE[^>]*>\s*)*/i, '')
    .trimStart()
  return stripped.toLowerCase().startsWith('<svg')
}

const FORBID_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'foreignObject',
  'foreignobject',
  'animate',
  'animateColor',
  'animateMotion',
  'animateTransform',
  'set',
  'discard',
  'cursor',
  'a',
  'font',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'applet',
  'frame',
  'frameset',
  'mpath',
  'handler',
  'listener',
]

const FORBID_TAG_SET = new Set(FORBID_TAGS.map((tag) => tag.toLowerCase()))

const FORBID_ATTR = [
  'srcdoc',
  'srcset',
  'formaction',
  'action',
  'background',
  'poster',
  'cite',
  'code',
  'codebase',
  'content',
  'http-equiv',
  'lowsrc',
  'dynsrc',
]

const ALLOWED_IMAGE_DATA_PREFIXES = [
  'data:image/png;base64,',
  'data:image/jpeg;base64,',
  'data:image/jpg;base64,',
  'data:image/gif;base64,',
  'data:image/webp;base64,',
]

function decodeHtmlEntitiesOnce(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]{1,6});?/g, (_whole, hex: string) => {
      const code = Number.parseInt(hex, 16)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '\uFFFD'
      try {
        return String.fromCodePoint(code)
      } catch {
        return '\uFFFD'
      }
    })
    .replace(/&#(\d{1,7});?/g, (_whole, dec: string) => {
      const code = Number.parseInt(dec, 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '\uFFFD'
      try {
        return String.fromCodePoint(code)
      } catch {
        return '\uFFFD'
      }
    })
    .replace(/&(lt|gt|amp|quot|apos|colon|tab|newline);/gi, (_whole, name: string) => {
      const table: Record<string, string> = {
        lt: '<',
        gt: '>',
        amp: '&',
        quot: '"',
        apos: "'",
        colon: ':',
        tab: '\t',
        newline: '\n',
      }
      return table[name.toLowerCase()] ?? _whole
    })
}

function decodeCssEscapesOnce(value: string): string {
  // CSS escape: backslash + 1-6 hex digits + optional single whitespace,
  // or backslash + any single char (line continuation collapses to nothing).
  const hexDecoded = value.replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[\r\n\f ])?/g, (_whole, hex: string) => {
    const code = Number.parseInt(hex, 16)
    if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return '\uFFFD'
    try {
      return String.fromCodePoint(code)
    } catch {
      return '\uFFFD'
    }
  })
  return hexDecoded
    .replace(/\\\r\n/g, '')
    .replace(/\\([\r\n\f])/g, '')
    .replace(/\\([\s\S])/g, (_whole, ch: string) => ch)
}

function decodeAttrValue(value: string): string {
  // Entities are decoded by the DOM parser already; decoding again here closes
  // double-encoded smuggling (`&amp;#106;avascript:`). CSS escapes close
  // `u\72 l(...)` style bypasses in presentation attributes / style.
  return decodeCssEscapesOnce(decodeHtmlEntitiesOnce(decodeHtmlEntitiesOnce(value)))
}

/** Strict same-document fragment: `#id` with no URL metacharacters. */
function isLocalFragmentTarget(target: string): boolean {
  if (!target.startsWith('#') || target.length < 2) return false
  if (/[\u0000-\u0020"'`<>()\\]/.test(target)) return false
  if (target.includes('://')) return false
  return /^#[^\s"'`<>()\\]*$/.test(target)
}

function isAllowedDataTarget(target: string): boolean {
  const compact = target.trim().toLowerCase()
  return ALLOWED_IMAGE_DATA_PREFIXES.some((prefix) => compact.startsWith(prefix))
}

/**
 * True when the value carries an external `url(...)` reference or cannot be
 * proven local. Fail-closed: unbalanced parens, nested parens, empty targets
 * and unknown schemes all return true so the caller drops the attribute.
 */
function containsExternalUrl(rawValue: string): boolean {
  const decoded = decodeAttrValue(rawValue)
  const withoutComments = decoded.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const opener = /url\s*\(/gi
  let match: RegExpExecArray | null
  while ((match = opener.exec(withoutComments)) !== null) {
    let i = match.index + match[0].length
    const n = withoutComments.length
    while (i < n && /\s/.test(withoutComments[i]!)) i += 1
    let quote = ''
    if (withoutComments[i] === '"' || withoutComments[i] === "'") {
      quote = withoutComments[i]!
      i += 1
    }
    let inner = ''
    let closed = false
    if (quote !== '') {
      const endQuote = withoutComments.indexOf(quote, i)
      if (endQuote === -1) return true
      inner = withoutComments.slice(i, endQuote)
      let j = endQuote + 1
      while (j < n && /\s/.test(withoutComments[j]!)) j += 1
      if (withoutComments[j] !== ')') return true
      opener.lastIndex = j + 1
      closed = true
    } else {
      const endParen = withoutComments.indexOf(')', i)
      if (endParen === -1) return true
      inner = withoutComments.slice(i, endParen)
      opener.lastIndex = endParen + 1
      closed = true
    }
    if (!closed) return true
    if (inner.includes('(')) return true
    let target = inner.trim()
    if (
      (target.startsWith('"') && target.endsWith('"') && target.length >= 2) ||
      (target.startsWith("'") && target.endsWith("'") && target.length >= 2)
    ) {
      target = target.slice(1, -1).trim()
    }
    if (target === '') return true
    if (target.startsWith('#')) {
      if (!isLocalFragmentTarget(target)) return true
      continue
    }
    if (target.trim().toLowerCase().startsWith('data:')) {
      if (!isAllowedDataTarget(target)) return true
      continue
    }
    return true
  }
  return false
}

/**
 * True when the value carries a `url()`-free CSS image function that can still
 * trigger a fetch from a `style` / presentation attribute: `image-set(...)`,
 * `-webkit-image-set(...)`, `image(...)`, `cross-fade(...)` (and `-webkit-`
 * prefixed forms), including nested (`cross-fade(image-set(...), ...)`) and
 * `var()`-wrapped / fallback forms. These accept bare `"https://..."` strings
 * with no `url(` literal, so {@link containsExternalUrl} cannot see them.
 *
 * Fail-closed: any occurrence drops the whole attribute, regardless of the
 * argument (local `#`, `data:` or external). Costume paint never legitimately
 * needs these functions — internal refs stay as `url(#id)` and embedded
 * raster stays on `href` — so dropping is safe for the editing round-trip.
 * Runs on the decoded value (HTML entities + CSS escapes unfolded, comments
 * stripped), case-insensitive, allowing whitespace between the name and `(`.
 */
function containsExternalCssImageFunction(rawValue: string): boolean {
  const decoded = decodeAttrValue(rawValue)
  const withoutComments = decoded.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const probe = withoutComments.toLowerCase()
  return (
    /(^|[^a-z0-9_-])(-webkit-)?image-set\s*\(/.test(probe) ||
    /(^|[^a-z0-9_-])(-webkit-)?image\s*\(/.test(probe) ||
    /(^|[^a-z0-9_-])(-webkit-)?cross-fade\s*\(/.test(probe)
  )
}

function containsDangerousCss(rawValue: string): boolean {
  const decoded = decodeAttrValue(rawValue)
  const compact = decoded.replace(/[\s\u0000-\u0020]+/g, '').toLowerCase()
  return (
    compact.includes('javascript:') ||
    compact.includes('vbscript:') ||
    compact.includes('data:text/html') ||
    compact.includes('data:image/svg') ||
    compact.includes('expression(') ||
    compact.includes('-moz-binding') ||
    compact.includes('behavior') ||
    compact.includes('@import')
  )
}

/** Attributes whose mere presence can trigger a fetch; always drop. */
const URL_BEARING_DENY_ATTRS = new Set([
  'src',
  'srcset',
  'background',
  'poster',
  'cite',
  'data',
  'action',
  'formaction',
  'longdesc',
  'profile',
  'usemap',
  'codebase',
  'classid',
  'archive',
  'code',
  'lowsrc',
  'dynsrc',
  'content',
  'imagesrcset',
  'ping',
  'xml:base',
])

function isAllowedHref(raw: string | null): boolean {
  if (raw === null) return true
  const decoded = decodeHtmlEntitiesOnce(raw)
  const value = decoded.trim()
  if (value === '') return true
  if (value.startsWith('#')) {
    if (!isLocalFragmentTarget(value)) return false
    return true
  }
  const lower = value.toLowerCase()
  // Block control-char / whitespace smuggling before the scheme.
  const compact = lower.replace(/^[\u0000-\u0020]+/, '')
  if (
    compact.startsWith('javascript:') ||
    compact.startsWith('vbscript:') ||
    compact.startsWith('data:text/html') ||
    compact.startsWith('data:image/svg')
  ) {
    return false
  }
  if (compact.startsWith('data:')) {
    return ALLOWED_IMAGE_DATA_PREFIXES.some((prefix) => compact.startsWith(prefix))
  }
  // Relative asset paths and http(s) are not needed for costumes; keep the
  // allowlist tight: same-document refs and embedded raster images only.
  return false
}

function looksLikeEventHandler(name: string): boolean {
  const stripped = name.toLowerCase().replace(/^[^a-z0-9]+/, '')
  return stripped.startsWith('on')
}

/**
 * `data-paper-data` handling: Paper.js runs `JSON.parse` on this attribute at
 * import time and lets the exception escape, so one malformed value aborts the
 * whole `importSVG` (and, worse, leaves Paper's global `insertItems` /
 * `applyMatrix` settings unrestored — see the import-path tests). Valid values
 * are stored as `item._data`, where `__proto__` / `constructor` / `prototype`
 * keys are a prototype-pollution vector for any consumer that merges them.
 *
 * Full removal was considered and chosen over keep-valid-JSON: the editor
 * never reads `item._data`, the VM persistence boundary already drops every
 * `data-paper-data`, benign Paper round-trips emit none (Paper only writes it
 * for non-empty `_data`), and the DOMPurify first pass (`SAFE_FOR_TEMPLATES`)
 * already drops all `data-*` — so retention has no functional benefit and only
 * keeps the crash/pollution surface. Always strip, fail-closed.
 */
function isPaperDataAttribute(name: string): boolean {
  return name.toLowerCase() === 'data-paper-data'
}

/**
 * Apply the strict attribute post-pass to a single live element, in place.
 * Same rules as the document sanitizer's per-element loop (event handlers,
 * disallowed `href`, fetch-bearing attributes, external `url(...)` / CSS
 * image functions / dangerous CSS, any `data-paper-data`), but without
 * requiring an `<svg>` document root so the point/eraser edit paths can clean
 * the exact DOM nodes they write.
 *
 * Used after a Paper.js write-back: the import ran on sanitized markup, but
 * geometry-only patches (`d`) land on the original live leaf, which may carry
 * attacker attributes that rode in on the live Element. Never throws.
 */
export function cleanSvgElementAttributes(element: Element): void {
  try {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name
      const lower = name.toLowerCase()
      if (looksLikeEventHandler(name)) {
        element.removeAttribute(name)
        continue
      }
      if (lower === 'href' || lower === 'xlink:href') {
        if (!isAllowedHref(attr.value)) element.removeAttribute(name)
        continue
      }
      if (URL_BEARING_DENY_ATTRS.has(lower)) {
        element.removeAttribute(name)
        continue
      }
      if (lower === 'xmlns' || lower.startsWith('xmlns:')) continue
      if (isPaperDataAttribute(name)) {
        element.removeAttribute(name)
        continue
      }
      if (lower.startsWith('data-')) continue
      if (lower === 'style') {
        if (containsExternalUrl(attr.value) || containsExternalCssImageFunction(attr.value) || containsDangerousCss(attr.value)) {
          element.removeAttribute(name)
        }
        continue
      }
      if (containsExternalUrl(attr.value) || containsExternalCssImageFunction(attr.value) || containsDangerousCss(attr.value)) {
        element.removeAttribute(name)
      }
    }
  } catch {
    // Best-effort hardening; callers keep their geometry write-back.
  }
}

function postProcessDocument(doc: Document): boolean {
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg') return false
  const elements = [root, ...Array.from(doc.getElementsByTagName('*'))]
  for (const element of elements) {
    const tag = element.tagName.toLowerCase()
    if (FORBID_TAG_SET.has(tag)) {
      element.remove()
      continue
    }
    cleanSvgElementAttributes(element)
  }
  return doc.documentElement.nodeName.toLowerCase() === 'svg'
}

/**
 * Sanitize untrusted SVG markup for insertion into the live DOM (`{@html}`)
 * and for Paper.js `importSVG`. Always returns a string that is safe to
 * insert; never throws; fails closed to a blank SVG placeholder.
 */
export function sanitizeSvgForDisplay(dirty: unknown): string {
  if (typeof dirty !== 'string') return SVG_PLACEHOLDER
  if (dirty.length === 0 || dirty.length > SVG_SANITIZE_MAX_CHARS) return SVG_PLACEHOLDER
  try {
    if (typeof window === 'undefined' || typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
      return SVG_PLACEHOLDER
    }
    const normalizedDirty = ensureXlinkNamespaceDeclared(dirty)
    const firstPass = DOMPurify.sanitize(normalizedDirty, {
      USE_PROFILES: { svg: true },
      FORBID_TAGS,
      FORBID_ATTR,
      ADD_TAGS: ['use'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      SAFE_FOR_TEMPLATES: true,
      ALLOW_DATA_ATTR: true,
      ALLOW_ARIA_ATTR: false,
      SANITIZE_DOM: true,
      KEEP_CONTENT: true,
    })
    if (typeof firstPass !== 'string' || firstPass.length === 0) return SVG_PLACEHOLDER
    const doc = new DOMParser().parseFromString(ensureXlinkNamespaceDeclared(firstPass), 'image/svg+xml')
    if (doc.getElementsByTagName('parsererror').length > 0) return SVG_PLACEHOLDER
    if (!postProcessDocument(doc)) return SVG_PLACEHOLDER
    const serialized = new XMLSerializer().serializeToString(doc.documentElement)
    if (!/<svg[\s>]/i.test(serialized)) return SVG_PLACEHOLDER
    return serialized
  } catch {
    return SVG_PLACEHOLDER
  }
}

/**
 * Sanitize a single SVG element/fragment (`<rect>`, `<g>`, `<path>`, …) for
 * the Paper.js import path by wrapping it in a fresh `<svg>` root and running
 * the full document sanitizer. Fragment markup is never inserted raw into the
 * live DOM; the wrapper goes through the same DOMPurify + strict post-pass as
 * documents, so breakout tags/handlers are stripped while group structure,
 * `transform`, presentation/style attributes and same-document (`#`) internal
 * references survive for faithful Paper.js imports.
 * Fails closed to the blank placeholder; never throws.
 */
export function sanitizeSvgFragmentForPaperImport(dirty: unknown): string {
  if (typeof dirty !== 'string') return SVG_PLACEHOLDER
  if (dirty.length === 0 || dirty.length > SVG_SANITIZE_MAX_CHARS) return SVG_PLACEHOLDER
  // Already a full document: keep the document path (preserves viewBox/size,
  // avoids nested <svg> roots).
  if (looksLikeFullSvgDocument(dirty)) return sanitizeSvgForDisplay(dirty)
  try {
    if (typeof window === 'undefined' || typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
      return SVG_PLACEHOLDER
    }
    const wrapped = `${SVG_FRAGMENT_WRAPPER_PREFIX}${dirty}${SVG_FRAGMENT_WRAPPER_SUFFIX}`
    if (wrapped.length > SVG_SANITIZE_MAX_CHARS + 1024) return SVG_PLACEHOLDER
    return sanitizeSvgForDisplay(wrapped)
  } catch {
    return SVG_PLACEHOLDER
  }
}

/**
 * Same boundary for the Paper.js import path. Accepts both full SVG documents
 * and single-element fragments (the form `paper-vector.ts` serializes via
 * `XMLSerializer` for per-unit imports). Documents go straight through the
 * strict display sanitizer; fragments are safely wrapped first. Never returns
 * raw input; fails closed to the blank placeholder.
 */
export function sanitizeSvgForPaperImport(dirty: unknown): string {
  if (typeof dirty !== 'string') return SVG_PLACEHOLDER
  if (dirty.length === 0 || dirty.length > SVG_SANITIZE_MAX_CHARS) return SVG_PLACEHOLDER
  const asDocument = sanitizeSvgForDisplay(dirty)
  if (asDocument !== SVG_PLACEHOLDER) return asDocument
  if (looksLikeFullSvgDocument(dirty)) return SVG_PLACEHOLDER
  return sanitizeSvgFragmentForPaperImport(dirty)
}
