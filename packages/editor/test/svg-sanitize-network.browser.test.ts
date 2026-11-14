/**
 * SVG sanitizer network regression — browser route (harmless window marker only).
 *
 * Scope (editor trust boundary ONLY):
 * - `sanitizeSvgForDisplay` / `sanitizeSvgFragmentForPaperImport` /
 *   `sanitizeSvgForPaperImport` in `src/features/costumes/svg-sanitize.ts`
 * - Sinks asserted here: `{@html}` preview/outline insertion and Paper.js
 *   `importSVG` via the sanitized string.
 *
 * Explicitly NOT asserted safe (do not misread this suite as covering them):
 * - Unmodified VM persistence (`packages/vm` `sanitizeSvgText` /
 *   `sanitizeSvgByteStream` / `storeAsset` / `updateCostume`) and raw SVG
 *   export bytes (`serializeSvgToString` / `exportSVG` without re-sanitizing).
 *   Those paths are out of scope; only the editor sanitizer output above is
 *   asserted to make zero external requests below.
 *
 * Safety: every payload can only assign a plain string to
 * `window.__xyoSvgNetProbe`. External "network" URLs use the reserved
 * `.invalid` TLD plus a `page.route` tap that aborts without leaving the
 * browser; nothing is exfiltrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const MARK = '__xyoSvgNetProbe'
const NET = 'regress-xyo.invalid'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4236'
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

async function firesViaInnerHTML(payload: string, waitMs = 350): Promise<unknown> {
  return page.evaluate(async ({ svg, mark, wait }: { svg: string; mark: string; wait: number }) => {
    const w = window as unknown as Record<string, unknown>
    w[mark] = null
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'svg-net-regression')
    document.body.appendChild(host)
    host.innerHTML = svg
    await new Promise((resolve) => setTimeout(resolve, wait))
    const fired = w[mark]
    host.remove()
    w[mark] = null
    return fired
  }, { svg: payload, mark: MARK, wait: waitMs })
}

/** Insert sanitized markup inline and report marker fires + canary net requests. */
async function inlineSink(svg: string): Promise<{ fired: unknown; net: string[] }> {
  netHits = []
  const fired = await firesViaInnerHTML(svg, 500)
  await new Promise((r) => setTimeout(r, 200))
  return { fired, net: [...netHits] }
}

const FILL_CLIP_MASK_STYLE_ATTACKS: Array<[string, string]> = [
  ['fill-basic', svgWrap(`<rect width="20" height="20" fill="url(https://${NET}/fill-payload)"/>`)],
  ['fill-single-quote', svgWrap(`<rect width="20" height="20" fill="url('https://${NET}/fill-sq')"/>`)],
  ['fill-double-quote', svgWrap(`<rect width="20" height="20" fill='url("https://${NET}/fill-dq")'/>`)],
  ['fill-uppercase', svgWrap(`<rect width="20" height="20" FILL="URL(HTTPS://${NET}/fill-upper)"/>`)],
  ['fill-whitespace', svgWrap(`<rect width="20" height="20" fill="url(  https://${NET}/fill-ws  )"/>`)],
  ['fill-space-before-paren', svgWrap(`<rect width="20" height="20" fill="url (https://${NET}/fill-ws2)"/>`)],
  ['fill-tab-newline', svgWrap(`<rect width="20" height="20" fill="url(\thttps://${NET}/fill-ws3\n)"/>`)],
  ['fill-entity', svgWrap(`<rect width="20" height="20" fill="url(&#104;ttps://${NET}/fill-entity)"/>`)],
  ['fill-hex-entity', svgWrap(`<rect width="20" height="20" fill="url(&#x68;ttps://${NET}/fill-hex-entity)"/>`)],
  // CSS hex escape: \75 == 'u', so `\75rl(...)` decodes to `url(...)`.
  ['fill-css-hex-escape', svgWrap(`<rect width="20" height="20" fill="\\75rl(https://${NET}/fill-hex)"/>`)],
  ['fill-css-char-escape', svgWrap(`<rect width="20" height="20" fill="u\\72l(https://${NET}/fill-escape)"/>`)],
  ['fill-multiple-urls', svgWrap(`<defs><linearGradient id="net-local"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="20" height="20" fill="url(#net-local) url(https://${NET}/fill-multi)"/>`)],
  ['stroke-url', svgWrap(`<rect width="20" height="20" fill="none" stroke="url(https://${NET}/stroke-x)"/>`)],
  ['filter-url', svgWrap(`<defs><filter id="net-f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="20" height="20" filter="url(https://${NET}/filter-x)"/>`)],
  ['clip-url', svgWrap(`<clipPath id="net-c"><rect width="5" height="5"/></clipPath><rect width="20" height="20" clip-path="url(https://${NET}/clip-x)"/>`)],
  ['mask-url', svgWrap(`<mask id="net-m"><rect width="5" height="5" fill="white"/></mask><rect width="20" height="20" mask="url(https://${NET}/mask-x)"/>`)],
  ['style-background-image', svgWrap(`<rect width="20" height="20" style="background-image:url(https://${NET}/style-bg)"/>`)],
  ['style-background-quoted-upper-ws', svgWrap(`<rect width="20" height="20" style="BACKGROUND-IMAGE : URL( 'https://${NET}/style-bg2' )"/>`)],
  ['style-fill-url', svgWrap(`<rect width="20" height="20" style="fill:url(https://${NET}/style-fill)"/>`)],
  ['style-entity', svgWrap(`<rect width="20" height="20" style="background:url(&#104;ttps://${NET}/style-entity)"/>`)],
  ['style-css-hex-escape', svgWrap(`<rect width="20" height="20" style="background-image:\\75rl(https://${NET}/style-hex)"/>`)],
  ['style-multiple-urls', svgWrap(`<rect width="20" height="20" style="fill:url(#net-local);background-image:url(https://${NET}/style-multi)"/>`)],
  ['image-href', svgWrap(`<image href="https://${NET}/img.png" width="10" height="10"/>`)],
  ['image-src-attr', svgWrap(`<image src="https://${NET}/src-attr.png" width="10" height="10"/>`)],
  ['use-href', svgWrap(`<use href="https://${NET}/use.svg#r"/>`)],
  ['gradient-href', svgWrap(`<defs><linearGradient id="net-g" href="https://${NET}/grad.svg"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#net-g)"/>`)],
]

const LEGITIMATE: Array<[string, string, string]> = [
  ['local-fill', svgWrap(`<defs><linearGradient id="keep-g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#keep-g)"/>`), 'url(#keep-g)'],
  ['local-filter', svgWrap(`<defs><filter id="keep-f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="10" height="10" filter="url(#keep-f)"/>`), 'url(#keep-f)'],
  ['local-clip', svgWrap(`<clipPath id="keep-c"><rect width="5" height="5"/></clipPath><rect width="10" height="10" clip-path="url(#keep-c)"/>`), 'url(#keep-c)'],
  ['local-mask', svgWrap(`<mask id="keep-m"><rect width="5" height="5" fill="white"/></mask><rect width="10" height="10" mask="url(#keep-m)"/>`), 'url(#keep-m)'],
  ['paint', svgWrap(`<rect x="2" y="2" width="20" height="20" fill="red" stroke="black" stroke-width="2"/>`), 'fill="red"'],
  ['font-transform', svgWrap(`<g transform="translate(5 7) rotate(10)"><text x="10" y="24" font-family="sans-serif" font-size="24">hello-net</text></g>`), 'hello-net'],
  ['benign-style', svgWrap(`<rect width="10" height="10" style="fill:red;stroke:black;stroke-width:2"/>`), 'fill:red'],
  ['style-local-url', svgWrap(`<defs><linearGradient id="keep-s"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" style="fill:url(#keep-s)"/>`), 'url(#keep-s)'],
  ['png', svgWrap(`<image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/>`), 'data:image/png;base64'],
  ['use-local', svgWrap(`<defs><rect id="keep-r" width="10" height="10"/></defs><use href="#keep-r"/>`), '#keep-r'],
]

describe('svg sanitizer network regression (browser route; editor boundary only)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4236', '--strictPort'], {
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

  it('presentation attributes and style urls make zero external requests', async () => {
    const failures: string[] = []
    for (const [name, raw] of FILL_CLIP_MASK_STYLE_ATTACKS) {
      const clean = await sanitize(raw)
      if (clean.includes(NET)) failures.push(`${name}: canary retained :: ${clean.slice(0, 220)}`)
      const { fired, net } = await inlineSink(clean)
      if (fired !== null) failures.push(`${name}: marker fired ${JSON.stringify(fired)}`)
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
      const { fired, net } = await inlineSink(clean)
      if (fired !== null) failures.push(`${name}: marker fired ${JSON.stringify(fired)}`)
      if (net.length > 0) failures.push(`${name}: unexpected request ${JSON.stringify(net)}`)
    }
    expect(failures).toEqual([])
  }, 90_000)

  it('fragment wrapper and existing SVG operations keep working without requests', async () => {
    // Fragment (no <svg> root) with an external paint url must fail closed on
    // the attribute but keep the element shell for the Paper import path.
    const hostileFragment = `<rect x="1" y="2" width="20" height="20" fill="url(https://${NET}/frag-fill)" stroke="black"/>`
    const cleanFrag = await page.evaluate(async (input: string) => {
      const { sanitizeSvgFragmentForPaperImport } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      return sanitizeSvgFragmentForPaperImport(input) as string
    }, hostileFragment)
    expect(cleanFrag.includes(NET)).toBe(false)
    expect(cleanFrag.toLowerCase()).toContain('<rect')

    const benignFragment = `<g transform="translate(5 7)"><rect x="1" y="2" width="20" height="20" fill="red" stroke="black"/></g>`
    const cleanBenignFrag = await page.evaluate(async (input: string) => {
      const { sanitizeSvgFragmentForPaperImport } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      return sanitizeSvgFragmentForPaperImport(input) as string
    }, benignFragment)
    expect(cleanBenignFrag).toContain('translate(5 7)')
    expect(cleanBenignFrag).toContain('fill="red"')

    // Existing editing round-trip (object list + move + resize + re-sanitize).
    netHits = []
    const editSvg = await sanitize(
      svgWrap(`<defs><linearGradient id="op-g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect x="10" y="10" width="20" height="20" fill="url(#op-g)" stroke="black"/>`),
    )
    expect(editSvg).toContain('url(#op-g)')
    const result = await page.evaluate(async ({ svg, mark }: { svg: string; mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      const { paperVectorObjectList, moveVectorElementBy, resizeVectorElementBy } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      w[mark] = null
      const objects = (await paperVectorObjectList(svg)) as Array<{ tag: string }>
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const el = doc.documentElement.firstElementChild
      let moved = 'skipped'
      let resized: unknown = 'skipped'
      if (el) {
        await moveVectorElementBy(el as unknown as Element, 5, 7)
        moved = (el as unknown as Element).outerHTML.slice(0, 160)
        resized = await resizeVectorElementBy(el as unknown as Element, 'bottom-right', 10, 10)
      }
      const reserialized = new XMLSerializer().serializeToString(doc)
      const reclean = sanitizeSvgForDisplay(reserialized) as string
      return { count: objects.length, tag: objects[0]?.tag, moved, resized, reclean, atEdit: w[mark] }
    }, { svg: editSvg, mark: MARK })
    expect(result.atEdit).toBeNull()
    expect(result.count).toBeGreaterThan(0)
    expect(result.reclean.includes(NET)).toBe(false)
    expect(await firesViaInnerHTML(result.reclean)).toBeNull()
    await new Promise((r) => setTimeout(r, 200))
    expect(netHits).toEqual([])

    // Paper import sink carries no live handlers / canary into exportSVG.
    const paperFailures: string[] = []
    for (const [name, raw] of FILL_CLIP_MASK_STYLE_ATTACKS.slice(0, 8)) {
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
        return { atImport: w[mark], exported, clean }
      }, { input: raw, mark: MARK })
      if (r.atImport !== null) paperFailures.push(`${name}: fired at import`)
      if (r.clean.includes(NET)) paperFailures.push(`${name}: canary in sanitized import :: ${r.clean.slice(0, 160)}`)
      if (r.exported.includes(NET)) paperFailures.push(`${name}: canary in export :: ${r.exported.slice(0, 160)}`)
      if (/on\w+\s*=/i.test(r.exported)) paperFailures.push(`${name}: handler in export :: ${r.exported.slice(0, 160)}`)
    }
    expect(paperFailures).toEqual([])
  }, 120_000)
})
