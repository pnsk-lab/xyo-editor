/**
 * SVG sanitizer image-set regression — browser route (harmless canary only).
 *
 * Scope (editor trust boundary ONLY):
 * - `sanitizeSvgForDisplay` in `src/features/costumes/svg-sanitize.ts`
 * - Sink asserted here: `{@html}` preview insertion of the sanitized string.
 *
 * Background: the sanitizer blocked external `url(...)` in presentation
 * attributes / `style`, but CSS fetch functions that take a bare string
 * (`image-set("https://...")`, `-webkit-image-set(...)`, `image("...")`,
 * `cross-fade(image-set("..."), ...)`) carry no `url(` literal and slipped
 * through, as can `var()` / custom-property indirection around them.
 *
 * Safety: every payload points only at the reserved `.invalid` TLD plus a
 * `page.route` tap that aborts without leaving the browser. Payloads can only
 * trigger a (blocked) resource fetch; none executes script and nothing is
 * exfiltrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const NET = 'regress-imageset.invalid'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4238'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

/** URLs the page tried to fetch that contain our canary host. */
let netHits: string[] = []

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
}

async function sanitize(svg: string): Promise<string> {
  return page.evaluate(async (input: string) => {
    const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
    return sanitizeSvgForDisplay(input) as string
  }, svg)
}

async function netViaInnerHTML(payload: string, waitMs = 500): Promise<string[]> {
  netHits = []
  await page.evaluate(async ({ svg, wait }: { svg: string; wait: number }) => {
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'svg-imageset-regression')
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

/** url()-free CSS fetch payloads: every one must be stripped (fail-closed). */
const IMAGESET_ATTACKS: Array<[string, string]> = [
  ['style-imageset-string', svgWrap(`<rect width="20" height="20" style="background-image:image-set('https://${NET}/a.png' 1x)"/>`)],
  ['style-imageset-dq-type', svgWrap(`<rect width="20" height="20" style='background-image:image-set("https://${NET}/b.png" 1x, "https://${NET}/b2.png" 2x)'/>`)],
  ['style-imageset-url-form', svgWrap(`<rect width="20" height="20" style="background-image:image-set(url(https://${NET}/c.png) 1x)"/>`)],
  ['style-webkit-imageset', svgWrap(`<rect width="20" height="20" style="background-image:-webkit-image-set('https://${NET}/d.png' 1x)"/>`)],
  ['style-imageset-upper-ws', svgWrap(`<rect width="20" height="20" style="BACKGROUND-IMAGE : IMAGE-SET ( 'https://${NET}/e.png' 1x )"/>`)],
  // CSS hex escape: \65 == 'e', so `imag\65 -set(...)` decodes to `image-set(...)`.
  ['style-imageset-css-hex-escape', svgWrap(`<rect width="20" height="20" style="background-image:imag\\65 -set('https://${NET}/f.png' 1x)"/>`)],
  // CSS char escape: `\-` decodes to `-`.
  ['style-imageset-css-char-escape', svgWrap(`<rect width="20" height="20" style="background-image:image\\-set('https://${NET}/g.png' 1x)"/>`)],
  ['style-imageset-entity', svgWrap(`<rect width="20" height="20" style="background-image:image-set(&#39;https://${NET}/h.png&#39; 1x)"/>`)],
  ['style-imageset-comment', svgWrap(`<rect width="20" height="20" style="background-image:image-set/**/('https://${NET}/i.png' 1x)"/>`)],
  ['style-image-fn', svgWrap(`<rect width="20" height="20" style="background-image:image('https://${NET}/j.png')"/>`)],
  ['style-crossfade-nested', svgWrap(`<rect width="20" height="20" style="background-image:cross-fade(image-set('https://${NET}/k.png' 1x), red, 50%)"/>`)],
  ['style-webkit-crossfade', svgWrap(`<rect width="20" height="20" style="background-image:-webkit-cross-fade(url(https://${NET}/l.png), url(https://${NET}/l2.png), 50%)"/>`)],
  // Custom-property / var() indirection around a string fetch.
  ['style-var-imageset', svgWrap(`<rect width="20" height="20" style="--a:'https://${NET}/m.png';background-image:image-set(var(--a) 1x)"/>`)],
  ['style-var-fallback-url', svgWrap(`<rect width="20" height="20" style="background-image:var(--x, url(https://${NET}/n.png))"/>`)],
  ['style-var-fallback-imageset', svgWrap(`<rect width="20" height="20" style="background-image:var(--x, image-set('https://${NET}/o.png' 1x))"/>`)],
  // Presentation attribute carrying a string fetch (invalid paint, but must still fail closed).
  ['attr-fill-imageset', svgWrap(`<rect width="20" height="20" fill="image-set('https://${NET}/p.png' 1x)"/>`)],
  ['attr-fill-webkit-imageset', svgWrap(`<rect width="20" height="20" fill="-webkit-image-set('https://${NET}/q.png' 1x)"/>`)],
]

/** Must keep working (and stay silent) after the fail-closed fix. */
const LEGITIMATE: Array<[string, string, string]> = [
  ['local-fill', svgWrap(`<defs><linearGradient id="is-keep-g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#is-keep-g)"/>`), 'url(#is-keep-g)'],
  ['local-filter', svgWrap(`<defs><filter id="is-keep-f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="10" height="10" filter="url(#is-keep-f)"/>`), 'url(#is-keep-f)'],
  ['local-clip', svgWrap(`<clipPath id="is-keep-c"><rect width="5" height="5"/></clipPath><rect width="10" height="10" clip-path="url(#is-keep-c)"/>`), 'url(#is-keep-c)'],
  ['local-mask', svgWrap(`<mask id="is-keep-m"><rect width="5" height="5" fill="white"/></mask><rect width="10" height="10" mask="url(#is-keep-m)"/>`), 'url(#is-keep-m)'],
  ['paint', svgWrap(`<rect x="2" y="2" width="20" height="20" fill="red" stroke="black" stroke-width="2"/>`), 'fill="red"'],
  ['font-transform', svgWrap(`<g transform="translate(5 7) rotate(10)"><text x="10" y="24" font-family="sans-serif" font-size="24">hello-imageset</text></g>`), 'hello-imageset'],
  ['benign-style', svgWrap(`<rect width="10" height="10" style="fill:red;stroke:black;stroke-width:2"/>`), 'fill:red'],
  ['style-local-url', svgWrap(`<defs><linearGradient id="is-keep-s"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" style="fill:url(#is-keep-s)"/>`), 'url(#is-keep-s)'],
  ['png', svgWrap(`<image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/>`), 'data:image/png;base64'],
  ['use-local', svgWrap(`<defs><rect id="is-keep-r" width="10" height="10"/></defs><use href="#is-keep-r"/>`), '#is-keep-r'],
]

describe('svg sanitizer image-set regression (browser route; editor boundary only)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4238', '--strictPort'], {
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
      if (url.includes(NET)) {
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

  it('url()-free CSS fetch functions make zero external requests', async () => {
    const failures: string[] = []
    for (const [name, raw] of IMAGESET_ATTACKS) {
      const clean = await sanitize(raw)
      if (clean.includes(NET)) failures.push(`${name}: canary retained :: ${clean.slice(0, 220)}`)
      const net = await netViaInnerHTML(clean)
      if (net.length > 0) failures.push(`${name}: external request ${JSON.stringify(net)}`)
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('legitimate paint / refs survive and stay silent with zero requests', async () => {
    const failures: string[] = []
    for (const [name, raw, needle] of LEGITIMATE) {
      const clean = await sanitize(raw)
      if (!clean.toLowerCase().includes(needle.toLowerCase())) {
        failures.push(`${name}: legitimate reference lost (needle ${needle}) :: ${clean.slice(0, 220)}`)
        continue
      }
      const net = await netViaInnerHTML(clean)
      if (net.length > 0) failures.push(`${name}: unexpected request ${JSON.stringify(net)}`)
    }
    expect(failures).toEqual([])
  }, 90_000)
})
