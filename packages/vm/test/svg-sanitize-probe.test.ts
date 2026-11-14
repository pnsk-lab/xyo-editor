/**
 * SVG sanitize boundary tests — product behavior (parser-based, not regex-only).
 *
 * Background:
 * - `sanitizeSvgText` in packages/vm/src/index.ts was regex-based and let
 *   well-known bypasses through to persistence/export.
 * - Every SVG ingress (costumeUpload / storeAsset via updateCostume /
 *   sb3-archive load) funnels through it, and the editor preview renders the
 *   stored bytes with Svelte `{@html}` (no further neutralization), while
 *   Paper.js `importSVG` round-trips raw DOM nodes — so this is the storage
 *   trust boundary.
 * - The sanitizer is now built on the mature htmlparser2 tokenizer (the same
 *   parser family that powers `sanitize-html`/cheerio) in XML mode with a
 *   strict SVG allowlist. `sanitize-html` itself was evaluated but is
 *   HTML-oriented (tag lowercasing breaks case-sensitive `linearGradient` /
 *   `clipPath` / `viewBox`) and pulls an unneeded CSS pipeline; using its
 *   underlying tokenizer directly preserves embedded PNG / internal `#`
 *   refs / gradients / text while staying synchronous in Node / Bun /
 *   browsers / Workers with no DOM globals.
 *
 * Safety: every payload below only ever sets a harmless `window.__xyo*`
 * marker string (or nothing at all). No network, no navigation, no exfil.
 */
import { describe, expect, it } from 'bun:test'
import { ScratchStorage, ScratchVM, costumeUpload, sanitizeSvgByteStream, sanitizeSvgText } from '../src/index'

// ---------------------------------------------------------------------------
// Corpus: dangerous payloads
// ---------------------------------------------------------------------------

const SLASH_IMAGE_ONERROR =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="invalid-example"/onerror="window.__xyoSvgProbe='slash-image-onerror'"/></svg>`

const SLASH_ANIMATE_ONBEGIN =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"><animate attributeName="opacity" from="1" to="0" dur="0.01s"/onbegin="window.__xyoSvgProbe='slash-animate-onbegin'"/></rect></svg>`

const ENTITY_HREF_SLASH_ONERROR =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="&#105;nvalid-example"/onerror="window.__xyoSvgProbe='entity-href-slash-onerror'"/></svg>`

const UNQUOTED_JS_HREF =
  `<svg xmlns="http://www.w3.org/2000/svg"><a href=javascript:window.__xyoSvgProbe><text>x</text></a></svg>`

const ENTITY_JS_HREF =
  `<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:window.__xyoSvgProbe"><text>x</text></a></svg>`

const STYLE_ATTR_JS_URL =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect style="background:url(javascript:window.__xyoSvgProbe)" width="10" height="10"/></svg>`

const STYLE_ELEMENT_JS_URL =
  `<svg xmlns="http://www.w3.org/2000/svg"><style>*{background:url(javascript:window.__xyoSvgProbe)}</style><rect width="10" height="10"/></svg>`

const SELF_CLOSING_SCRIPT =
  `<svg xmlns="http://www.w3.org/2000/svg"><script href="https://evil.example/x.js" /><rect width="10" height="10"/></svg>`

const HANDLER_TAG = `<svg xmlns="http://www.w3.org/2000/svg"><handler>window.__xyoSvgProbe</handler></svg>`
const IFRAME_TAG = `<svg xmlns="http://www.w3.org/2000/svg"><iframe src="https://evil.example"></iframe></svg>`
const EMBED_OBJECT_TAGS = `<svg xmlns="http://www.w3.org/2000/svg"><embed src="https://evil.example" /><object data="https://evil.example"></object></svg>`

const UNQUOTED_DATA_TEXT_HTML =
  `<svg xmlns="http://www.w3.org/2000/svg"><a href=data:text/html;base64,PHNjcmlwdD4=><text>x</text></a></svg>`

const UNCLOSED_SCRIPT =
  `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__xyoSvgProbe='unclosed-script'`

const UNCLOSED_FOREIGN_SLASH_IMG =
  `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img/src="invalid-example"/onerror="window.__xyoSvgProbe='ufo-img'"></div>`

const EXTERNAL_FILL_URL =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/x.svg)" width="10" height="10"/></svg>`

const DATA_TEXT_HTML_IMAGE =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/html;base64,PHNjcmlwdD4="/></svg>`

const REPORTED_STYLE_IMAGESET_STRING =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:image-set('http://127.0.0.1/evil.png' 1x)"/></svg>`

const STYLE_IMAGESET_DOUBLE_QUOTE =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style='background-image:image-set("http://127.0.0.1/evil-b.png" 1x, "http://127.0.0.1/evil-b2.png" 2x)'/></svg>`

const STYLE_IMAGESET_URL_FORM =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:image-set(url(http://127.0.0.1/evil-c.png) 1x)"/></svg>`

const STYLE_WEBKIT_IMAGESET =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:-webkit-image-set('http://127.0.0.1/evil-d.png' 1x)"/></svg>`

const STYLE_IMAGESET_UPPER_WS =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="BACKGROUND-IMAGE : IMAGE-SET ( 'http://127.0.0.1/evil-e.png' 1x )"/></svg>`

const STYLE_IMAGESET_CSS_HEX_ESCAPE =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:imag\\65 -set('http://127.0.0.1/evil-f.png' 1x)"/></svg>`

const STYLE_IMAGESET_CSS_CHAR_ESCAPE =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:image\\-set('http://127.0.0.1/evil-g.png' 1x)"/></svg>`

const STYLE_IMAGESET_ENTITY =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:image-set(&#39;http://127.0.0.1/evil-h.png&#39; 1x)"/></svg>`

const STYLE_IMAGESET_COMMENT =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:image-set/**/('http://127.0.0.1/evil-i.png' 1x)"/></svg>`

const STYLE_IMAGE_FN =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:image('http://127.0.0.1/evil-j.png')"/></svg>`

const STYLE_CROSSFADE_NESTED =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:cross-fade(image-set('http://127.0.0.1/evil-k.png' 1x), red, 50%)"/></svg>`

const STYLE_VAR_IMAGESET =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="--a:'http://127.0.0.1/evil-m.png';background-image:image-set(var(--a) 1x)"/></svg>`

const STYLE_VAR_FALLBACK_URL =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:var(--x, url(http://127.0.0.1/evil-n.png))"/></svg>`

const STYLE_VAR_FALLBACK_IMAGESET =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:var(--x, image-set('http://127.0.0.1/evil-o.png' 1x))"/></svg>`

const STYLE_VAR_BARE =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="--a:'http://127.0.0.1/evil-p.png';background-image:var(--a)"/></svg>`

const ATTR_FILL_IMAGESET =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" fill="image-set('http://127.0.0.1/evil-q.png' 1x)"/></svg>`

const ATTR_FILL_WEBKIT_IMAGESET =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" fill="-webkit-image-set('http://127.0.0.1/evil-r.png' 1x)"/></svg>`

const HREF_JS_INNER_WHITESPACE =
  `<svg xmlns="http://www.w3.org/2000/svg"><a href="java\tscript:window.__xyoSvgProbe"><text>x</text></a></svg>`

// ---------------------------------------------------------------------------
// Corpus: legitimate content that MUST be preserved
// ---------------------------------------------------------------------------

const BENIGN_PNG =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/></svg>`

const BENIGN_XLINK_PNG =
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/></svg>`

const BENIGN_GRADIENT =
  `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="10" y2="0"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><radialGradient id="r"><stop offset="0" stop-color="white"/></radialGradient></defs><rect fill="url(#g)" stroke="url(#r)" width="10" height="10"/></svg>`

const BENIGN_USE_REF =
  `<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="r" width="10" height="10"/></defs><use href="#r" x="2" y="3"/></svg>`

const BENIGN_STYLE_ATTR = `<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:red;stroke:black" width="10" height="10"/></svg>`

const BENIGN_TEXT =
  `<svg xmlns="http://www.w3.org/2000/svg"><text x="5" y="5" font-size="12">hello</text></svg>`

const DANGEROUS_CASES: Array<[string, string]> = [
  ['slash image onerror', SLASH_IMAGE_ONERROR],
  ['slash animate onbegin', SLASH_ANIMATE_ONBEGIN],
  ['entity href + slash onerror', ENTITY_HREF_SLASH_ONERROR],
  ['unquoted javascript: href', UNQUOTED_JS_HREF],
  ['entity-encoded javascript: scheme', ENTITY_JS_HREF],
  ['style attribute javascript: url', STYLE_ATTR_JS_URL],
  ['style element javascript: url', STYLE_ELEMENT_JS_URL],
  ['self-closing script', SELF_CLOSING_SCRIPT],
  ['handler tag', HANDLER_TAG],
  ['iframe tag', IFRAME_TAG],
  ['embed/object tags', EMBED_OBJECT_TAGS],
  ['unquoted data:text/html href', UNQUOTED_DATA_TEXT_HTML],
  ['unclosed script', UNCLOSED_SCRIPT],
  ['unclosed foreignObject + slash onerror', UNCLOSED_FOREIGN_SLASH_IMG],
  ['external fill url()', EXTERNAL_FILL_URL],
  ['data:text/html image href', DATA_TEXT_HTML_IMAGE],
  ['reported style image-set string url', REPORTED_STYLE_IMAGESET_STRING],
  ['style image-set double-quote', STYLE_IMAGESET_DOUBLE_QUOTE],
  ['style image-set url() form', STYLE_IMAGESET_URL_FORM],
  ['style -webkit-image-set', STYLE_WEBKIT_IMAGESET],
  ['style image-set upper + ws', STYLE_IMAGESET_UPPER_WS],
  ['style image-set css hex escape', STYLE_IMAGESET_CSS_HEX_ESCAPE],
  ['style image-set css char escape', STYLE_IMAGESET_CSS_CHAR_ESCAPE],
  ['style image-set entity', STYLE_IMAGESET_ENTITY],
  ['style image-set comment', STYLE_IMAGESET_COMMENT],
  ['style image() fn', STYLE_IMAGE_FN],
  ['style cross-fade nested', STYLE_CROSSFADE_NESTED],
  ['style var() + image-set', STYLE_VAR_IMAGESET],
  ['style var() fallback url()', STYLE_VAR_FALLBACK_URL],
  ['style var() fallback image-set', STYLE_VAR_FALLBACK_IMAGESET],
  ['style bare var()', STYLE_VAR_BARE],
  ['attr fill image-set', ATTR_FILL_IMAGESET],
  ['attr fill -webkit-image-set', ATTR_FILL_WEBKIT_IMAGESET],
  ['href javascript inner whitespace', HREF_JS_INNER_WHITESPACE],
]

function expectNeutralized(out: string): void {
  const lower = out.toLowerCase()
  expect(out.startsWith('<svg')).toBe(true)
  expect(lower).not.toContain('onerror')
  expect(lower).not.toContain('onbegin')
  expect(lower).not.toContain('javascript:')
  expect(lower).not.toContain('data:text/html')
  expect(lower).not.toContain('<script')
  expect(lower).not.toContain('foreignobject')
  expect(lower).not.toContain('<handler')
  expect(lower).not.toContain('<iframe')
  expect(lower).not.toContain('<embed')
  expect(lower).not.toContain('<object')
  expect(lower).not.toContain('__xyoprobe')
  expect(out).not.toContain('__xyoSvgProbe')
  expect(out).not.toContain('127.0.0.1')
  expect(lower).not.toContain('image-set')
  expect(lower).not.toContain('cross-fade')
}

// ---------------------------------------------------------------------------
// Product behavior: previously covered cases stay covered
// ---------------------------------------------------------------------------

describe('product sanitizer: baseline stays blocked', () => {
  it('strips paired <script> elements', () => {
    const out = sanitizeSvgText(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>`)
    expect(out.toLowerCase()).not.toContain('<script')
  })

  it('strips quoted event-handler attributes', () => {
    const out = sanitizeSvgText(
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="invalid-example" onerror="window.__xyoSvgProbe='x'"/></svg>`,
    )
    expect(out).not.toContain('onerror')
  })

  it('strips quoted javascript: href', () => {
    const out = sanitizeSvgText(`<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>`)
    expect(out.toLowerCase()).not.toContain('javascript:')
  })

  it('strips paired <foreignObject> subtrees', () => {
    const out = sanitizeSvgText(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject></svg>`,
    )
    expect(out.toLowerCase()).not.toContain('foreignobject')
    expect(out).not.toContain('onerror')
  })
})

// ---------------------------------------------------------------------------
// Product behavior: former regex bypasses are now neutralized
// ---------------------------------------------------------------------------

describe('product sanitizer: blocks the former bypasses', () => {
  for (const [name, svg] of DANGEROUS_CASES) {
    it(`neutralizes: ${name}`, () => {
      expectNeutralized(sanitizeSvgText(svg))
    })
  }

  it('drops the whole style element but keeps sibling shapes', () => {
    const out = sanitizeSvgText(STYLE_ELEMENT_JS_URL)
    expect(out.toLowerCase()).not.toContain('<style')
    expect(out).toContain('<rect')
  })

  it('drops the reported image-set string-url style but keeps the shape', () => {
    const out = sanitizeSvgText(REPORTED_STYLE_IMAGESET_STRING)
    expect(out).not.toContain('127.0.0.1')
    expect(out.toLowerCase()).not.toContain('image-set')
    expect(out).toContain('<rect')
  })

  it('byte-stream entry point is equally protected', () => {
    const bytes = new TextEncoder().encode(SLASH_IMAGE_ONERROR)
    expectNeutralized(new TextDecoder().decode(sanitizeSvgByteStream(bytes)))
  })

  it('byte-stream entry point drops image-set string urls', () => {
    const bytes = new TextEncoder().encode(REPORTED_STYLE_IMAGESET_STRING)
    expectNeutralized(new TextDecoder().decode(sanitizeSvgByteStream(bytes)))
  })
})

describe('product sanitizer: preserves legitimate content', () => {
  it('keeps embedded PNG data URIs (href and xlink:href)', () => {
    expect(sanitizeSvgText(BENIGN_PNG)).toContain('data:image/png;base64,iVBORw0KGgo=')
    expect(sanitizeSvgText(BENIGN_XLINK_PNG)).toContain('data:image/png;base64,iVBORw0KGgo=')
  })

  it('keeps gradients and url(#id) paint references', () => {
    const out = sanitizeSvgText(BENIGN_GRADIENT)
    expect(out).toContain('linearGradient')
    expect(out).toContain('radialGradient')
    expect(out).toContain('url(#g)')
    expect(out).toContain('stop-color')
  })

  it('keeps internal <use href="#id"> references', () => {
    expect(sanitizeSvgText(BENIGN_USE_REF)).toContain('href="#r"')
  })

  it('keeps benign style attributes', () => {
    expect(sanitizeSvgText(BENIGN_STYLE_ATTR)).toContain('fill:red')
  })

  it('keeps text elements and their content', () => {
    const out = sanitizeSvgText(BENIGN_TEXT)
    expect(out).toContain('<text')
    expect(out).toContain('hello')
  })

  it('keeps camelCase-sensitive attributes intact (viewBox)', () => {
    const out = sanitizeSvgText(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360"><rect width="1" height="1"/></svg>`)
    expect(out).toContain('viewBox="0 0 480 360"')
  })

  it('is idempotent', () => {
    for (const svg of [SLASH_IMAGE_ONERROR, BENIGN_PNG, BENIGN_GRADIENT, BENIGN_USE_REF]) {
      const once = sanitizeSvgText(svg)
      expect(sanitizeSvgText(once)).toBe(once)
    }
  })
})

describe('product sanitizer: fail-closed + environment compatibility', () => {
  it('is parser-based, not regex-only, and uses no DOM globals (Node / Bun / worker safe)', () => {
    const source = sanitizeSvgText.toString()
    expect(source).toMatch(/Parser|htmlparser2/i)
    expect(source).not.toMatch(/DOMParser|XMLSerializer|document|window|HTMLElement|navigator/)
  })

  it('round-trips through Uint8Array with TextDecoder/TextEncoder only', () => {
    const bytes = new TextEncoder().encode(SLASH_IMAGE_ONERROR)
    const out = new TextDecoder().decode(sanitizeSvgByteStream(bytes))
    expect(out.toLowerCase()).not.toContain('onerror')
    const benign = new TextDecoder().decode(sanitizeSvgByteStream(new TextEncoder().encode(BENIGN_PNG)))
    expect(benign).toContain('data:image/png;base64,iVBORw0KGgo=')
  })

  it('never throws and always returns an <svg> for degenerate input', () => {
    const placeholder = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
    expect(sanitizeSvgText('')).toBe(placeholder)
    expect(sanitizeSvgText('hello')).toBe(placeholder)
    expect(sanitizeSvgText('<svg')).toContain('<svg')
    expect(sanitizeSvgText('<svg><g><image href="x"/onerror="y"')).toContain('<svg')
    expect(sanitizeSvgText('<svg><g><image href="x"/onerror="y"').toLowerCase()).not.toContain('onerror')
  })

  it('TextDecoder/TextEncoder exist in this runtime (Bun; same in Node/workers)', () => {
    expect(typeof TextDecoder).toBe('function')
    expect(typeof TextEncoder).toBe('function')
  })
})

describe('product sanitizer: storage boundary stays sanitized', () => {
  it('storeAsset persists sanitized bytes (no handler survives)', async () => {
    const vm = new ScratchVM()
    const { md5ext } = await vm.storeAsset(new TextEncoder().encode(SLASH_IMAGE_ONERROR), 'svg')
    const stored = new TextDecoder().decode((await vm.loadAsset(md5ext, 'svg'))!)
    expectNeutralized(stored)
  })

  it('costumeUpload entry point emits sanitized SVG', async () => {
    const storage = new ScratchStorage()
    const result = await new Promise<{ costumes: Array<{ asset: unknown }> }>((resolve, reject) => {
      costumeUpload(
        new TextEncoder().encode(UNQUOTED_JS_HREF),
        'image/svg+xml',
        storage,
        (costumes) => resolve({ costumes: costumes as Array<{ asset: unknown }> }),
        reject,
      )
    })
    const asset = (result.costumes[0] as { asset: { decodeText(): string } }).asset
    expectNeutralized(asset.decodeText())
  })

  it('exported sb3 archives carry sanitized SVG assets', async () => {
    const vm = new ScratchVM()
    const stored = await vm.storeAsset(new TextEncoder().encode(SLASH_ANIMATE_ONBEGIN), 'svg')
    vm.addCostume('Sprite1', {
      name: 'probe',
      dataFormat: 'svg',
      assetId: stored.assetId,
      md5ext: stored.md5ext,
    })
    const { unzipSync } = await import('fflate')
    const { strFromU8 } = await import('fflate')
    const files = unzipSync(await vm.saveProjectSb3())
    expectNeutralized(strFromU8(files[stored.md5ext]!))
  })
})
