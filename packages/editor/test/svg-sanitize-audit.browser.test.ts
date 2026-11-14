/**
 * INDEPENDENT AUDIT — SVG sanitizer + DOM/Paper sinks (survey only, no product-code changes).
 *
 * Scope: `src/features/costumes/svg-sanitize.ts` and every sink that can
 * consume SVG bytes/markup:
 *  - `{@html sanitizeSvgForDisplay(...)}` preview sink (BitmapEditor.svelte)
 *  - `{@html outline}` reshape-overlay sink (VectorReshapeOverlay.svelte, double-sanitized)
 *  - Paper.js `importSVG` sinks (paper-vector.ts sanitized; vector-path-points.ts
 *    + vector-eraser.ts import bare live Elements)
 *  - Blob-URL `<img>` / canvas raster sinks (Editor.svelte loadCostumeIntoBitmapCanvas,
 *    rasterizeCostumeToCanvas, svgWithCrispRendering; costume-thumbnails.ts)
 *
 * Safety: every payload can only assign a plain string to
 * `window.__xyoAuditProbe`. External "network" URLs use the reserved
 * `.invalid` TLD plus a `page.route` tap that records without letting the
 * request leave the browser; nothing is exfiltrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const MARK = '__xyoAuditProbe'
const NET = 'probe-xyo.invalid'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4234'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

/** URLs the page tried to fetch that contain our canary host. */
let netHits: string[] = []

async function sanitize(svg: string): Promise<string> {
  return page.evaluate(async (input: string) => {
    const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
    return sanitizeSvgForDisplay(input) as string
  }, svg)
}

async function firesViaInnerHTML(payload: string, waitMs = 350): Promise<unknown> {
  return page.evaluate(async ({ svg, mark, wait }: { svg: string; mark: string; wait: number }) => {
    const w = window as unknown as Record<string, unknown>
    w[mark] = null
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'svg-audit')
    document.body.appendChild(host)
    host.innerHTML = svg
    await new Promise((resolve) => setTimeout(resolve, wait))
    const fired = w[mark]
    host.remove()
    w[mark] = null
    return fired
  }, { svg: payload, mark: MARK, wait: waitMs })
}

/** Insert sanitized markup inline and report (a) marker fires, (b) canary net requests. */
async function inlineSink(svg: string): Promise<{ fired: unknown; net: string[] }> {
  netHits = []
  const fired = await firesViaInnerHTML(svg, 500)
  await new Promise((r) => setTimeout(r, 200))
  return { fired, net: [...netHits] }
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
}

// ---------------------------------------------------------------------------
// Payload corpus (all inert except for setting window[MARK] on success)
// ---------------------------------------------------------------------------
const EXEC_PAYLOADS: Array<[string, string]> = [
  ['script-tag', svgWrap(`<script>window.${MARK}='script-tag'</script><rect width="10" height="10"/>`)],
  ['svg-onload', `<svg xmlns="http://www.w3.org/2000/svg" onload="window.${MARK}='svg-onload'"><rect width="10" height="10"/></svg>`],
  ['nested-svg-onload', svgWrap(`<svg onload="window.${MARK}='nested-svg-onload'"><rect width="5" height="5"/></svg>`)],
  ['g-onload', svgWrap(`<g onload="window.${MARK}='g-onload'"><rect width="10" height="10"/></g>`)],
  ['image-onerror', svgWrap(`<image href="invalid-probe" onerror="window.${MARK}='image-onerror'"/>`)],
  ['slash-image-onerror', svgWrap(`<image href="invalid-probe"/onerror="window.${MARK}='slash-image-onerror'"/>`)],
  ['slash-animate-onbegin', svgWrap(`<rect width="10" height="10"><animate attributeName="opacity" from="1" to="0" dur="0.01s"/onbegin="window.${MARK}='slash-animate-onbegin'"/></rect>`)],
  ['entity-href-slash-onerror', svgWrap(`<image href="&#105;nvalid-probe"/onerror="window.${MARK}='entity-href-slash-onerror'"/>`)],
  ['unclosed-foreign-img', `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img/src="invalid-probe"/onerror="window.${MARK}='ufo-img'"></div>`],
  ['iframe-srcdoc', svgWrap(`<iframe srcdoc="<script>window.${MARK}='iframe-srcdoc'</script>"></iframe>`)],
  ['object-data', svgWrap(`<object data="data:text/html,<script>window.${MARK}='object-data'</script>"></object>`)],
  ['embed-src', svgWrap(`<embed src="data:text/html,<script>window.${MARK}='embed-src'</script>"/>`)],
  ['a-js-href', svgWrap(`<a href="javascript:window.${MARK}='a-js'"><text x="10" y="20">click</text></a>`)],
  ['a-js-href-mixedcase-ws', svgWrap(`<a href="  JaVaScRiPt:window.${MARK}='a-js-ws'"><text x="10" y="20">click</text></a>`)],
  ['a-js-href-tab', svgWrap(`<a href="&#9;javascript:window.${MARK}='a-js-tab'"><text x="10" y="20">click</text></a>`)],
  ['use-js-href', svgWrap(`<use href="javascript:window.${MARK}='use-js'"/>`)],
  ['image-data-html', svgWrap(`<image href="data:text/html,<script>window.${MARK}='data-html'</script>"/>`)],
  ['image-data-svg', svgWrap(`<image href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' onload=&quot;window.${MARK}='data-svg'&quot;/>"/>`)],
  ['handler-uppercase', svgWrap(`<image href="invalid-probe" ONERROR="window.${MARK}='upper-onerror'"/>`)],
  ['handler-newline', svgWrap("<image href=\"invalid-probe\"\nonerror=\"window." + MARK + "='nl-onerror'\"/>")],
  ['handler-tab', svgWrap("<image href=\"invalid-probe\"\tonerror=\"window." + MARK + "='tab-onerror'\"/>")],
  ['svg-onfocusin', `<svg xmlns="http://www.w3.org/2000/svg" onfocusin="window.${MARK}='svg-focusin'"><rect width="10" height="10"/></svg>`],
  ['body-onload-ns', `<svg xmlns="http://www.w3.org/2000/svg"><body xmlns="http://www.w3.org/1999/xhtml" onload="window.${MARK}='ns-body'"></body></svg>`],
  ['math-mi-js', `<svg xmlns="http://www.w3.org/2000/svg"><math xmlns="http://www.w3.org/1998/Math"><mi href="javascript:window.${MARK}='math-mi'">x</mi></math></svg>`],
  ['set-onbegin', svgWrap(`<rect width="10" height="10"><set attributeName="opacity" to="0"/onbegin="window.${MARK}='set-onbegin'"/></rect>`)],
  ['animatetransform-onbegin', svgWrap(`<rect width="10" height="10"><animateTransform attributeName="transform" type="rotate" from="0" to="10" dur="0.01s"/onbegin="window.${MARK}='at-onbegin'"/></rect>`)],
  ['cursor-href', svgWrap(`<cursor href="invalid-probe" onerror="window.${MARK}='cursor'"/>`)],
  ['font-color-script', svgWrap(`<font color="red"><script>window.${MARK}='font-script'</script></font>`)],
  ['form-formaction', svgWrap(`<form><button formaction="javascript:window.${MARK}='formaction'">x</button></form>`)],
  ['video-poster-onerror', svgWrap(`<video poster="invalid-probe" onerror="window.${MARK}='video'"/>`)],
  ['audio-src-onerror', svgWrap(`<audio src="invalid-probe" onerror="window.${MARK}='audio'"/>`)],
  ['style-el-import', svgWrap(`<style>@import url('https://${NET}/style-import.css');</style><rect width="10" height="10"/>`)],
  ['mpath-href', svgWrap(`<text><textPath href="#x">t</textPath></text><path id="x" d="M0 0h10"><animateMotion dur="0.01s"><mpath href="javascript:window.${MARK}='mpath'"/></animateMotion></path>`)],
]

const NET_PAYLOADS: Array<[string, string]> = [
  ['css-fill-url', svgWrap(`<rect width="20" height="20" fill="url(https://${NET}/fill-payload)"/>`)],
  ['css-style-bg-url', svgWrap(`<rect width="20" height="20" style="background-image:url(https://${NET}/style-bg)"/>`)],
  ['css-style-fill-url', svgWrap(`<rect width="20" height="20" style="fill:url(https://${NET}/style-fill)"/>`)],
  ['filter-url', svgWrap(`<defs><filter id="f1"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="20" height="20" filter="url(https://${NET}/filter-x)"/>`)],
  ['clip-url', svgWrap(`<clipPath id="c1"><rect width="5" height="5"/></clipPath><rect width="20" height="20" clip-path="url(https://${NET}/clip-x)"/>`)],
  ['mask-url', svgWrap(`<mask id="m1"><rect width="5" height="5" fill="white"/></mask><rect width="20" height="20" mask="url(https://${NET}/mask-x)"/>`)],
  ['image-http-href', svgWrap(`<image href="https://${NET}/img.png" width="10" height="10"/>`)],
  ['image-http-xlink', svgWrap(`<image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://${NET}/img2.png" width="10" height="10"/>`)],
  ['use-http-href', svgWrap(`<use href="https://${NET}/use.svg#r"/>`)],
  ['gradient-http-href', svgWrap(`<defs><linearGradient id="g1" href="https://${NET}/grad.svg"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g1)"/>`)],
  ['script-src-http', svgWrap(`<script href="https://${NET}/s.js"></script>`)],
  ['audio-src-http', svgWrap(`<audio src="https://${NET}/a.mp3"/>`)],
  ['video-src-http', svgWrap(`<video src="https://${NET}/v.mp4"/>`)],
  ['link-stylesheet', svgWrap(`<link xmlns="http://www.w3.org/1999/xhtml" rel="stylesheet" href="https://${NET}/link.css"/>`)],
  ['style-tag-url', svgWrap(`<style>.a{background:url('https://${NET}/style-tag')}</style><rect class="a" width="10" height="10"/>`)],
]

const BENIGN: Array<[string, string, string]> = [
  ['png', svgWrap(`<image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/>`), 'data:image/png;base64'],
  ['gradient', svgWrap(`<defs><linearGradient id="audit-g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#audit-g)" width="10" height="10"/>`), 'lineargradient'],
  ['use', svgWrap(`<defs><rect id="audit-r" width="10" height="10"/></defs><use href="#audit-r"/>`), '#audit-r'],
  ['text', svgWrap(`<text x="10" y="24" font-size="24">hello-audit</text>`), 'hello-audit'],
  ['shapes', svgWrap(`<rect x="2" y="2" width="20" height="20" fill="red" stroke="black"/><circle cx="40" cy="40" r="8" fill="blue"/><path d="M0 0 L30 30" stroke="black"/>`), '<path'],
]

describe('independent sanitizer + sink audit (harmless markers only)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4234', '--strictPort'], {
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
    // Record (and sink) any request to the canary host; let everything else through.
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

  it('A: known script-execution payloads stay silent through sanitize -> innerHTML', async () => {
    const failures: string[] = []
    for (const [name, raw] of EXEC_PAYLOADS) {
      const clean = await sanitize(raw)
      const { fired } = await inlineSink(clean)
      if (fired !== null) failures.push(`${name} FIRED marker=${JSON.stringify(fired)} clean=${clean.slice(0, 220)}`)
    }
    expect(failures).toEqual([])
  }, 90_000)

  it('A2: raw (unsanitized) controls prove the sink is live where expected', async () => {
    // Only resource-error handlers are valid liveness controls for an
    // innerHTML sink: <script> inserted via innerHTML never executes and
    // <svg onload> does not fire there either (verified in isolation), so a
    // silent script/onload result would mean a dead probe, not a defense.
    // Image-error handlers DO fire raw — assert that, then test A is meaningful.
    const liveControls = [
      EXEC_PAYLOADS.find(([n]) => n === 'image-onerror')![1],
      EXEC_PAYLOADS.find(([n]) => n === 'slash-image-onerror')![1],
      EXEC_PAYLOADS.find(([n]) => n === 'handler-uppercase')![1],
      EXEC_PAYLOADS.find(([n]) => n === 'unclosed-foreign-img')![1],
    ]
    const liveDetail: string[] = []
    for (const raw of liveControls) {
      let fired = await firesViaInnerHTML(raw, 900)
      if (fired === null) fired = await firesViaInnerHTML(raw, 900)
      liveDetail.push(`${String(raw).slice(0, 60)} => ${JSON.stringify(fired)}`)
      // eslint-disable-next-line no-console
      console.log(`\n[liveness] ${liveDetail.join(' | ')}\n`)
      expect(fired).not.toBeNull()
    }
  }, 60_000)

  it('B: external/data-URI references — what survives sanitize, and does it phone home?', async () => {
    const report: string[] = []
    for (const [name, raw] of NET_PAYLOADS) {
      const clean = await sanitize(raw)
      const retained = clean.includes(NET)
      const { fired, net } = await inlineSink(clean)
      report.push(`${name}: retained=${retained} fired=${JSON.stringify(fired)} net=${JSON.stringify(net)}`)
    }
    // eslint-disable-next-line no-console
    console.log(`\n[external-ref report]\n${report.join('\n')}\n`)
    // Script execution must never happen even if a URL is retained.
    for (const [name, raw] of NET_PAYLOADS) {
      const { fired } = await inlineSink(await sanitize(raw))
      expect({ name, fired }).toEqual({ name, fired: null })
    }
  }, 120_000)

  it('C: data: URI policy (svg/html blocked, raster allowed)', async () => {
    const cases: Array<[string, string, boolean]> = [
      ['data-html', svgWrap(`<image href="data:text/html,<b>x</b>" width="4" height="4"/>`), false],
      ['data-html-upper', svgWrap(`<image href="DATA:TEXT/HTML,<b>x</b>" width="4" height="4"/>`), false],
      ['data-svg', svgWrap(`<image href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" width="4" height="4"/>`), false],
      ['data-svg-upper', svgWrap(`<image href="DATA:IMAGE/SVG+XML;base64,PHN2Zz48L3N2Zz4=" width="4" height="4"/>`), false],
      ['data-js', svgWrap(`<a href="data:text/javascript,window.${MARK}='djs'"><text x="1" y="2">x</text></a>`), false],
      ['data-png', svgWrap(`<image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/>`), true],
      ['data-jpeg', svgWrap(`<image href="data:image/jpeg;base64,/9j/4AAQ" width="4" height="4"/>`), true],
      ['data-gif', svgWrap(`<image href="data:image/gif;base64,R0lGODdh" width="4" height="4"/>`), true],
      ['data-webp', svgWrap(`<image href="data:image/webp;base64,UklGRg==" width="4" height="4"/>`), true],
      ['data-ws-prefix', svgWrap("<image href=\"  \t data:text/html,<b>x</b>\" width=\"4\" height=\"4\"/>"), false],
    ]
    const failures: string[] = []
    for (const [name, raw, allowed] of cases) {
      const clean = await sanitize(raw)
      const keptData = clean.includes('data:')
      if (allowed && !keptData) failures.push(`${name}: raster data: URI was stripped (functionality loss)`)
      if (!allowed && keptData) failures.push(`${name}: dangerous data: URI retained: ${clean.slice(0, 200)}`)
      const { fired } = await inlineSink(clean)
      if (fired !== null) failures.push(`${name}: FIRED ${JSON.stringify(fired)}`)
    }
    expect(failures).toEqual([])
  }, 60_000)

  it('D: namespace / XML-vs-HTML re-parse differentials', async () => {
    const cases: Array<[string, string]> = [
      ['xhtml-script-in-svg', svgWrap(`<script xmlns="http://www.w3.org/1999/xhtml">window.${MARK}='xhtml-script'</script>`)],
      ['svg-in-html-ns', `<div xmlns="http://www.w3.org/1999/xhtml"><svg xmlns="http://www.w3.org/2000/svg" onload="window.${MARK}='ns-svg-onload'"></svg></div>`],
      ['entity-handler', svgWrap(`<image href="x" &#111;nerror="window.${MARK}='entity-handler'"/>`)],
      ['entity-scheme', svgWrap(`<a href="&#106;avascript:window.${MARK}='entity-scheme'"><text x="1" y="2">x</text></a>`)],
      ['hex-entity-scheme', svgWrap(`<a href="&#x6A;avascript:window.${MARK}='hex-scheme'"><text x="1" y="2">x</text></a>`)],
      ['newline-in-scheme', svgWrap("<a href=\"java\nscript:window." + MARK + "='nl-scheme'\"><text x=\"1\" y=\"2\">x</text></a>")],
      ['null-in-handler', svgWrap("<image href=\"x\" on&#0;error=\"window." + MARK + "='nul-handler'\"/>")],
      ['xlink-js', svgWrap(`<a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="javascript:window.${MARK}='xlink-js'"><text x="1" y="2">x</text></a>`)],
      ['src-attr', svgWrap(`<image src="https://${NET}/src-attr.png" width="4" height="4"/>`)],
      ['formaction-input', svgWrap(`<input formaction="javascript:window.${MARK}='input-fa'"/>`)],
      ['desc-script', svgWrap(`<desc><script>window.${MARK}='desc-script'</script></desc>`)],
      ['title-onload', svgWrap(`<title onload="window.${MARK}='title-onload'">t</title>`)],
      ['text-onload', svgWrap(`<text x="1" y="2" onload="window.${MARK}='text-onload'">t</text>`)],
      ['tspan-onclick', svgWrap(`<text x="1" y="2"><tspan onclick="window.${MARK}='tspan-click'">t</tspan></text>`)],
    ]
    const failures: string[] = []
    for (const [name, raw] of cases) {
      const clean = await sanitize(raw)
      const { fired, net } = await inlineSink(clean)
      if (fired !== null) failures.push(`${name}: FIRED ${JSON.stringify(fired)} :: ${clean.slice(0, 200)}`)
      if (net.length > 0) failures.push(`${name}: NET ${JSON.stringify(net)} :: ${clean.slice(0, 200)}`)
    }
    // Log retained-canary detail even on success for the report.
    const detail = []
    for (const [name, raw] of cases) {
      const clean = await sanitize(raw)
      if (clean.includes(NET) || /on\w+=/i.test(clean) || /javascript:/i.test(clean)) detail.push(`${name}: SUSPICIOUS-RETAIN :: ${clean.slice(0, 200)}`)
    }
    // eslint-disable-next-line no-console
    console.log(`\n[reparse-differential detail]\n${detail.length ? detail.join('\n') : '(no suspicious retention)'}\n`)
    expect(failures).toEqual([])
  }, 90_000)

  it('E: oversize / entity-expansion / deep-nesting inputs fail closed', async () => {
    // 1. Over the char cap -> placeholder.
    const over = await sanitize(`<svg xmlns="http://www.w3.org/2000/svg">${'A'.repeat(2_000_010)}</svg>`)
    expect(over).toContain('<svg')
    expect(over.length).toBeLessThan(1000)

    // 2. Billion-laughs style internal entities -> must not hang, must not fire, must stay small-ish.
    const laughs = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "1234567890"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="2">&b;</text><image href="x" onerror="window.${MARK}='laughs'"/></svg>`
    const t0 = Date.now()
    const cleanLaughs = await sanitize(laughs)
    const dt = Date.now() - t0
    expect(dt).toBeLessThan(10_000)
    expect(await firesViaInnerHTML(cleanLaughs)).toBeNull()

    // 3. Deep nesting (10k groups) -> terminates and stays silent.
    let deep = `<svg xmlns="http://www.w3.org/2000/svg">`
    for (let i = 0; i < 10_000; i++) deep += '<g>'
    deep += `<image href="x" onerror="window.${MARK}='deep'"/>`
    for (let i = 0; i < 10_000; i++) deep += '</g>'
    deep += '</svg>'
    const t1 = Date.now()
    const cleanDeep = await sanitize(deep)
    expect(Date.now() - t1).toBeLessThan(15_000)
    expect(await firesViaInnerHTML(cleanDeep)).toBeNull()

    // 4. Non-string / empty inputs -> placeholder, never throw.
    for (const bad of [undefined, null, 42, {}, []]) {
      const out = await page.evaluate(async (input: unknown) => {
        const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
        return sanitizeSvgForDisplay(input) as string
      }, bad as never)
      expect(out).toContain('<svg')
    }
  }, 90_000)

  it('F: legitimate SVG + editing round-trips keep working and stay silent', async () => {
    for (const [name, raw, needle] of BENIGN) {
      const clean = await sanitize(raw)
      expect({ name, kept: clean.toLowerCase().includes(needle.toLowerCase()) }).toEqual({ name, kept: true })
      expect(await firesViaInnerHTML(clean)).toBeNull()
    }
    const edit = await sanitize(svgWrap(`<rect x="10" y="10" width="20" height="20" fill="red" stroke="black"/>`))
    const result = await page.evaluate(async ({ svg, mark }: { svg: string; mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      const { paperVectorObjectList, moveVectorElementBy, resizeVectorElementBy } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      w[mark] = null
      const objects = (await paperVectorObjectList(svg)) as Array<{ tag: string }>
      // Simulate an edit round-trip through the live-DOM path.
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const el = doc.documentElement.firstElementChild
      let moved = 'skipped'
      let resized: unknown = 'skipped'
      if (el) {
        await moveVectorElementBy(el as unknown as Element, 5, 7)
        moved = (el as unknown as Element).outerHTML.slice(0, 120)
        resized = await resizeVectorElementBy(el as unknown as Element, 'bottom-right', 10, 10)
      }
      const reserialized = new XMLSerializer().serializeToString(doc)
      const reclean = sanitizeSvgForDisplay(reserialized) as string
      return { count: objects.length, tag: objects[0]?.tag, moved, resized, reclean, atEdit: w[mark] }
    }, { svg: edit, mark: MARK })
    expect(result.atEdit).toBeNull()
    expect(result.count).toBeGreaterThan(0)
    expect(result.tag).toBe('rect')
    expect(await firesViaInnerHTML(result.reclean)).toBeNull()
  }, 60_000)

  it('G: Paper import sink — sanitized output carries no live handlers into exportSVG', async () => {
    const failures: string[] = []
    for (const [name, raw] of [...EXEC_PAYLOADS.slice(0, 12), ...NET_PAYLOADS.slice(0, 6)]) {
      const r = await page.evaluate(async ({ input, mark }: { input: string; mark: string }) => {
        const w = window as unknown as Record<string, unknown>
        const { sanitizeSvgForPaperImport } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
        const { ensureVectorPaperScope } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const clean = sanitizeSvgForPaperImport(input) as string
        const scope = await ensureVectorPaperScope()
        scope.project.clear()
        w[mark] = null
        let exported = ''
        try {
          const item = scope.project.importSVG(clean, { insert: false }) as unknown as {
            exportSVG: (o: unknown) => string
            remove: () => void
          } | null
          if (item) {
            exported = item.exportSVG({ asString: true }) as string
            item.remove()
          }
        } catch { exported = '' }
        scope.project.clear()
        return { atImport: w[mark], exported }
      }, { input: raw, mark: MARK })
      if (r.atImport !== null) failures.push(`${name}: fired at import`)
      if (/on\w+\s*=/i.test(r.exported)) failures.push(`${name}: handler in export :: ${r.exported.slice(0, 160)}`)
      if (r.exported.includes(NET)) failures.push(`${name}: canary in export :: ${r.exported.slice(0, 160)}`)
      if (r.exported && (await firesViaInnerHTML(r.exported)) !== null) failures.push(`${name}: export fires`)
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('H: blob-URL <img> + canvas raster path cannot execute script (raw bytes)', async () => {
    // Raw malicious SVG through the thumbnail/raster pattern: <img src=blob>.
    // Scripts must not run in this context by browser design; assert it, and
    // record whether the canary host is contacted from inside <img> SVG.
    netHits = []
    const fired = await page.evaluate(async ({ mark, host }: { mark: string; host: string }) => {
      const w = window as unknown as Record<string, unknown>
      w[mark] = null
      const raw = `<svg xmlns="http://www.w3.org/2000/svg"><script>window.${mark}='img-script'</script><image href="https://${host}/img-track" width="10" height="10"/><rect width="10" height="10" onload="window.${mark}='img-onload'"/></svg>`
      const url = URL.createObjectURL(new Blob([raw], { type: 'image/svg+xml' }))
      const img = new Image()
      await new Promise<void>((resolve) => {
        img.onload = () => resolve()
        img.onerror = () => resolve()
        img.src = url
        setTimeout(() => resolve(), 1500)
      })
      const canvas = document.createElement('canvas')
      canvas.width = 20
      canvas.height = 20
      try {
        canvas.getContext('2d')?.drawImage(img, 0, 0)
      } catch { /* tainted/failed decode is fine */ }
      URL.revokeObjectURL(url)
      await new Promise((r) => setTimeout(r, 400))
      const out = w[mark]
      w[mark] = null
      return out
    }, { mark: MARK, host: NET })
    await new Promise((r) => setTimeout(r, 300))
    // eslint-disable-next-line no-console
    console.log(`\n[img-raster] fired=${JSON.stringify(fired)} net=${JSON.stringify(netHits)}\n`)
    expect(fired).toBeNull()
  }, 30_000)

  it('I: live-DOM append path (clipboard/paste pattern) cannot smuggle handlers', async () => {
    // The vector clipboard uses outerHTML + DOMParser + importNode/appendChild
    // (not innerHTML). Prove whether a handler riding that path would go live:
    // parse RAW attacker markup as the paste path does, import it, append it.
    const fired = await page.evaluate(async ({ mark }: { mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      w[mark] = null
      const raw = `<image xmlns="http://www.w3.org/2000/svg" href="invalid-probe" onerror="window.${mark}='paste-append'"/>`
      const parsed = new DOMParser().parseFromString(raw, 'image/svg+xml').documentElement
      const hostSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      document.body.appendChild(hostSvg)
      hostSvg.appendChild(document.importNode(parsed, true))
      await new Promise((r) => setTimeout(r, 400))
      const out = w[mark]
      hostSvg.remove()
      w[mark] = null
      return out
    }, { mark: MARK })
    // eslint-disable-next-line no-console
    console.log(`\n[paste-append-path] raw-handler-via-appendChild fired=${JSON.stringify(fired)}\n`)
    // And the sanitized equivalent must always be silent.
    const cleanFired = await page.evaluate(async ({ mark }: { mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      w[mark] = null
      const raw = `<image xmlns="http://www.w3.org/2000/svg" href="invalid-probe" onerror="window.${mark}='paste-clean'"/>`
      const clean = sanitizeSvgForDisplay(`<svg xmlns="http://www.w3.org/2000/svg">${raw}</svg>`) as string
      const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml').documentElement
      const hostSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      document.body.appendChild(hostSvg)
      hostSvg.appendChild(document.importNode(parsed.firstElementChild ?? parsed, true))
      await new Promise((r) => setTimeout(r, 400))
      const out = w[mark]
      hostSvg.remove()
      w[mark] = null
      return out
    }, { mark: MARK })
    expect(cleanFired).toBeNull()
  }, 30_000)
})
