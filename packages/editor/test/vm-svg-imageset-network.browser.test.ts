/**
 * VM SVG sanitizer image-set regression — browser route (harmless canary only).
 *
 * Scope (VM trust boundary ONLY):
 * - `sanitizeSvgText` / `sanitizeSvgByteStream` / `storeAsset` in
 *   `packages/vm/src/index.ts` (the persistence boundary: every SVG ingress is
 *   sanitized before it is stored/exported).
 * - Sink asserted here: the sanitized/stored bytes inserted through a live
 *   `innerHTML` sink (the same shape as the costume preview), with style
 *   resolution forced so `background-image` candidates actually load.
 *
 * Background: `style="background-image:image-set('http://127.0.0.1/evil.png' 1x)"`
 * carried a bare string URL with no `url(` literal, so the `url(...)`-only
 * check let the style attribute through to persistence, and rendering the
 * stored bytes issued a real network request. The fix detects `image-set()` /
 * `-webkit-image-set()` / `image()` / `cross-fade()` (nested and
 * `var()`-wrapped forms, incl. CSS escapes / entities / comments) and drops
 * the whole attribute fail-closed, since costumes never need these functions.
 * `svgIsAllowedHref` was hardened the same way (full entity+CSS-escape
 * decoding, inner-whitespace-tolerant scheme check, comment rejection).
 *
 * Safety: canary hosts are `127.0.0.1` loopback paths under `/evil-vm-*`
 * (matching the reported shape) plus the reserved `.invalid` TLD. A
 * `page.route` tap aborts anything carrying a canary marker before it leaves
 * the browser; nothing is exfiltrated and no payload executes script.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { sanitizeSvgByteStream, sanitizeSvgText, ScratchVM } from '@hikkaku/vm'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const LOOPBACK_EVIL_PREFIX = 'http://127.0.0.1/evil-vm-'
const NET = 'regress-vm-imageset.invalid'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4241'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

/** URLs the page tried to fetch that carry a canary marker. */
let netHits: string[] = []

function isCanary(url: string): boolean {
  return url.includes('/evil-vm-') || url.includes(NET)
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
}

/** Render markup through a live innerHTML sink and force style resolution. */
async function netViaInnerHTML(payload: string, waitMs = 500): Promise<string[]> {
  netHits = []
  await page.evaluate(async ({ svg, wait }: { svg: string; wait: number }) => {
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'vm-svg-imageset-regression')
    document.body.appendChild(host)
    host.innerHTML = svg
    // Force style resolution so image-set() candidates actually load.
    void host.offsetHeight
    await new Promise((resolve) => setTimeout(resolve, wait))
    host.remove()
  }, { svg: payload, wait: waitMs })
  await new Promise((r) => setTimeout(r, 200))
  return [...netHits]
}

/** url()-free CSS fetch payloads over the VM sanitizer: every one must fail closed. */
const IMAGESET_ATTACKS: Array<[string, string]> = [
  // Exact reported shape: string URL persisted, real request on display.
  ['reported-imageset-string', svgWrap(`<rect width="20" height="20" style="background-image:image-set('${LOOPBACK_EVIL_PREFIX}a.png' 1x)"/>`)],
  ['imageset-double-quote', svgWrap(`<rect width="20" height="20" style='background-image:image-set("https://${NET}/b.png" 1x, "https://${NET}/b2.png" 2x)'/>`)],
  ['imageset-url-form', svgWrap(`<rect width="20" height="20" style="background-image:image-set(url(${LOOPBACK_EVIL_PREFIX}c.png) 1x)"/>`)],
  ['webkit-imageset', svgWrap(`<rect width="20" height="20" style="background-image:-webkit-image-set('${LOOPBACK_EVIL_PREFIX}d.png' 1x)"/>`)],
  ['imageset-upper-ws', svgWrap(`<rect width="20" height="20" style="BACKGROUND-IMAGE : IMAGE-SET ( 'https://${NET}/e.png' 1x )"/>`)],
  // CSS hex escape: \65 == 'e', so `imag\65 -set(...)` decodes to `image-set(...)`.
  ['imageset-css-hex-escape', svgWrap(`<rect width="20" height="20" style="background-image:imag\\65 -set('https://${NET}/f.png' 1x)"/>`)],
  // CSS char escape: `\-` decodes to `-`.
  ['imageset-css-char-escape', svgWrap(`<rect width="20" height="20" style="background-image:image\\-set('https://${NET}/g.png' 1x)"/>`)],
  ['imageset-entity', svgWrap(`<rect width="20" height="20" style="background-image:image-set(&#39;https://${NET}/h.png&#39; 1x)"/>`)],
  ['imageset-comment', svgWrap(`<rect width="20" height="20" style="background-image:image-set/**/('https://${NET}/i.png' 1x)"/>`)],
  ['image-fn', svgWrap(`<rect width="20" height="20" style="background-image:image('https://${NET}/j.png')"/>`)],
  ['crossfade-nested', svgWrap(`<rect width="20" height="20" style="background-image:cross-fade(image-set('https://${NET}/k.png' 1x), red, 50%)"/>`)],
  ['webkit-crossfade', svgWrap(`<rect width="20" height="20" style="background-image:-webkit-cross-fade(url(https://${NET}/l.png), url(https://${NET}/l2.png), 50%)"/>`)],
  // Custom-property / var() indirection around a string fetch.
  ['var-imageset', svgWrap(`<rect width="20" height="20" style="--a:'https://${NET}/m.png';background-image:image-set(var(--a) 1x)"/>`)],
  ['var-fallback-url', svgWrap(`<rect width="20" height="20" style="background-image:var(--x, url(https://${NET}/n.png))"/>`)],
  ['var-fallback-imageset', svgWrap(`<rect width="20" height="20" style="background-image:var(--x, image-set('https://${NET}/o.png' 1x))"/>`)],
  ['var-bare', svgWrap(`<rect width="20" height="20" style="--a:'https://${NET}/p.png';background-image:var(--a)"/>`)],
  // Presentation attribute carrying a string fetch (invalid paint, but must still fail closed).
  ['attr-fill-imageset', svgWrap(`<rect width="20" height="20" fill="image-set('https://${NET}/q.png' 1x)"/>`)],
  ['attr-fill-webkit-imageset', svgWrap(`<rect width="20" height="20" fill="-webkit-image-set('https://${NET}/r.png' 1x)"/>`)],
]

/** Must keep working (and stay silent) after the fail-closed fix. */
const LEGITIMATE: Array<[string, string, string]> = [
  ['local-fill', svgWrap(`<defs><linearGradient id="vm-keep-g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#vm-keep-g)"/>`), 'url(#vm-keep-g)'],
  ['local-filter', svgWrap(`<defs><filter id="vm-keep-f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="10" height="10" filter="url(#vm-keep-f)"/>`), 'url(#vm-keep-f)'],
  ['local-clip', svgWrap(`<clipPath id="vm-keep-c"><rect width="5" height="5"/></clipPath><rect width="10" height="10" clip-path="url(#vm-keep-c)"/>`), 'url(#vm-keep-c)'],
  ['local-mask', svgWrap(`<mask id="vm-keep-m"><rect width="5" height="5" fill="white"/></mask><rect width="10" height="10" mask="url(#vm-keep-m)"/>`), 'url(#vm-keep-m)'],
  ['paint', svgWrap(`<rect x="2" y="2" width="20" height="20" fill="red" stroke="black" stroke-width="2"/>`), 'fill="red"'],
  ['font-transform', svgWrap(`<g transform="translate(5 7) rotate(10)"><text x="10" y="24" font-family="sans-serif" font-size="24">hello-vm-imageset</text></g>`), 'hello-vm-imageset'],
  ['benign-style', svgWrap(`<rect width="10" height="10" style="fill:red;stroke:black;stroke-width:2"/>`), 'fill:red'],
  ['style-local-url', svgWrap(`<defs><linearGradient id="vm-keep-s"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" style="fill:url(#vm-keep-s)"/>`), 'url(#vm-keep-s)'],
  ['png', svgWrap(`<image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/>`), 'data:image/png;base64'],
  ['use-local', svgWrap(`<defs><rect id="vm-keep-r" width="10" height="10"/></defs><use href="#vm-keep-r"/>`), '#vm-keep-r'],
]

describe('vm sanitizer image-set regression (browser route; VM boundary only)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4241', '--strictPort'], {
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
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    await page.route('**/*', (route) => {
      const url = route.request().url()
      if (isCanary(url)) {
        netHits.push(url)
        void route.abort()
        return
      }
      void route.continue()
    })
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('route tap is live (positive control)', async () => {
    const net = await netViaInnerHTML(`<img src="${LOOPBACK_EVIL_PREFIX}control.png"/>`)
    expect(net.length).toBeGreaterThan(0)
  }, 30_000)

  it('sanitized image-set/var/cross-fade payloads make zero external requests', async () => {
    const failures: string[] = []
    for (const [name, raw] of IMAGESET_ATTACKS) {
      const clean = sanitizeSvgText(raw)
      if (isCanary(clean)) failures.push(`${name}: canary retained :: ${clean.slice(0, 220)}`)
      const lowered = clean.toLowerCase()
      if (lowered.includes('image-set') || lowered.includes('cross-fade')) {
        failures.push(`${name}: fetch function retained :: ${clean.slice(0, 220)}`)
      }
      const net = await netViaInnerHTML(clean)
      if (net.length > 0) failures.push(`${name}: external request ${JSON.stringify(net)}`)
    }
    expect(failures).toEqual([])
  }, 180_000)

  it('stored bytes (byte-stream + storeAsset) stay silent with zero requests', async () => {
    const failures: string[] = []
    const vm = new ScratchVM()
    for (const [name, raw] of IMAGESET_ATTACKS) {
      const stored = new TextDecoder().decode(sanitizeSvgByteStream(new TextEncoder().encode(raw)))
      if (isCanary(stored)) {
        failures.push(`${name}: canary in byte stream :: ${stored.slice(0, 220)}`)
        continue
      }
      const { md5ext } = await vm.storeAsset(new TextEncoder().encode(raw), 'svg')
      const persisted = new TextDecoder().decode((await vm.loadAsset(md5ext, 'svg'))!)
      if (isCanary(persisted)) {
        failures.push(`${name}: canary persisted :: ${persisted.slice(0, 220)}`)
        continue
      }
      const net = await netViaInnerHTML(persisted)
      if (net.length > 0) failures.push(`${name}: persisted render requested ${JSON.stringify(net)}`)
    }
    expect(failures).toEqual([])
  }, 180_000)

  it('legitimate paint / refs survive and stay silent with zero requests', async () => {
    const failures: string[] = []
    for (const [name, raw, needle] of LEGITIMATE) {
      const clean = sanitizeSvgText(raw)
      if (!clean.toLowerCase().includes(needle.toLowerCase())) {
        failures.push(`${name}: legitimate reference lost (needle ${needle}) :: ${clean.slice(0, 220)}`)
        continue
      }
      const net = await netViaInnerHTML(clean)
      if (net.length > 0) failures.push(`${name}: unexpected request ${JSON.stringify(net)}`)
    }
    expect(failures).toEqual([])
  }, 120_000)
})
