/**
 * xlink namespace normalization — node invariants (no DOM, no network).
 *
 * The browser suite (`svg-xlink-namespace.browser.test.ts`) proves the
 * runtime behavior with real DOMParser/XMLSerializer, real network taps and
 * real Paper.js. This node suite pins the helper-only contract that makes it
 * possible without needing a browser:
 * - the fragment wrapper declares `xmlns:xlink` (bare `xlink:href`
 *   fragments stay parse-safe);
 * - the display sanitizer normalizes a missing root `xmlns:xlink` instead of
 *   dropping the fragment (existing declarations untouched);
 * - the bitmap -> vector markup helper stays self-contained with its own
 *   `xmlns:xlink` declaration;
 * - fail-closed behavior (non-string / oversize) is unchanged in node.
 */
import { describe, expect, it } from 'bun:test'
import { buildVectorImageMarkup } from '../src/features/costumes/clipboard-cross-format'
import { sanitizeSvgForDisplay, sanitizeSvgForPaperImport, SVG_PLACEHOLDER } from '../src/features/costumes/svg-sanitize'

describe('svg xlink namespace node invariants', () => {
  it('fragment wrapper declares xmlns:xlink so bare xlink:href stays parse-safe', async () => {
    const source = await Bun.file(new URL('../src/features/costumes/svg-sanitize.ts', import.meta.url)).text()
    expect(source).toContain('http://www.w3.org/1999/xlink')
    // Wrapper prefix itself carries both namespaces (via interpolated constants).
    expect(source).toMatch(/SVG_FRAGMENT_WRAPPER_PREFIX.*xmlns:xlink/s)
    expect(source).toMatch(/SVG_FRAGMENT_WRAPPER_PREFIX.*XLINK_NAMESPACE/s)
  })

  it('normalizer is wired into the display path without touching existing declarations', async () => {
    const source = await Bun.file(new URL('../src/features/costumes/svg-sanitize.ts', import.meta.url)).text()
    expect(source).toContain('ensureXlinkNamespaceDeclared')
    // Existing xmlns:xlink must not be duplicated or stripped.
    expect(source).toContain('/xmlns:xlink\\s*=/i.test(markup)')
  })

  it('bitmap -> vector markup stays self-contained with xmlns:xlink', () => {
    const href = 'data:image/png;base64,iVBORw0KGgo='
    const markup = buildVectorImageMarkup(href, { x: 1, y: 2, width: 4, height: 4 })
    expect(markup).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"')
    expect(markup).toContain('xlink:href')
    expect(markup).toContain('data:image/png;base64,')
  })

  it('node without DOM still fails closed (no throw, placeholder preserved)', () => {
    // In bun there is no window/DOMParser: every sanitizer returns the shared
    // placeholder instead of raw input. This guards the node import path.
    expect(sanitizeSvgForDisplay('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBe(SVG_PLACEHOLDER)
    expect(sanitizeSvgForPaperImport('<image xlink:href="#r"/>')).toBe(SVG_PLACEHOLDER)
    expect(sanitizeSvgForDisplay(undefined)).toBe(SVG_PLACEHOLDER)
    expect(sanitizeSvgForDisplay('')).toBe(SVG_PLACEHOLDER)
  })
})
