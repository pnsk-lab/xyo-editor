/**
 * xlink namespace normalization — browser regression (harmless canary only).
 *
 * Reported failure: bare fragments carrying `xlink:href` (the exact shape of
 * same-mode `outerHTML` clipboard snapshots, which keep the prefix but lose
 * the in-fragment `xmlns:xlink` declaration) failed closed to the blank
 * placeholder because `sanitizeSvgFragmentForPaperImport` wrapped them in a
 * plain `<svg>` root without `xmlns:xlink`, so the XML parse raised
 * `parsererror`. Harmless embedded PNG `data:` and local `#` refs were lost.
 *
 * This suite pins the minimal helper-only fix in
 * `src/features/costumes/svg-sanitize.ts` (wrapper declares `xmlns:xlink`;
 * full documents missing the declaration are normalized on the root):
 * - bare `xlink:href` fragments (PNG + local `#`) survive the fragment and
 *   Paper-import sanitizers and import through real Paper.js;
 * - the same-mode paste shape (HTML-serialized `outerHTML` without an
 *   in-fragment declaration) survives the `sanitizeSvgForPaperImport`
 *   boundary with geometry intact;
 * - full documents missing `xmlns:xlink` are normalized without breaking
 *   documents that already declare it;
 * - external `xlink:href` / bare `href` / `image-set()` still fail closed
 *   with zero canary requests (real `page.route` tap on reserved `.invalid`);
 * - `<script>` is still removed while valid local defs/PNG survive.
 *
 * Safety: canary hosts use reserved `.invalid` plus a route abort; payloads
 * can only trigger a blocked fetch or assign a plain string to
 * `window.__xyoXlinkProbe`. No exfiltration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const MARK = '__xyoXlinkProbe'
const NET = 'regress-xlink.invalid'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADULeqVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4271'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page
let netHits: string[] = []

async function sanitizeFrag(svg: string): Promise<string> {
  return page.evaluate(async (input: string) => {
    const { sanitizeSvgFragmentForPaperImport } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
    return sanitizeSvgFragmentForPaperImport(input) as string
  }, svg)
}

async function sanitizePaper(svg: string): Promise<string> {
  return page.evaluate(async (input: string) => {
    const { sanitizeSvgForPaperImport } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
    return sanitizeSvgForPaperImport(input) as string
  }, svg)
}

async function sanitizeDisplay(svg: string): Promise<string> {
  return page.evaluate(async (input: string) => {
    const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
    return sanitizeSvgForDisplay(input) as string
  }, svg)
}

async function firesViaInnerHTML(payload: string, waitMs = 400): Promise<unknown> {
  return page.evaluate(async ({ svg, mark, wait }: { svg: string; mark: string; wait: number }) => {
    const w = window as unknown as Record<string, unknown>
    w[mark] = null
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'svg-xlink-namespace')
    document.body.appendChild(host)
    host.innerHTML = svg
    await new Promise((resolve) => setTimeout(resolve, wait))
    const fired = w[mark]
    host.remove()
    w[mark] = null
    return fired
  }, { svg: payload, mark: MARK, wait: waitMs })
}

describe('svg xlink namespace normalization (browser; real net + real Paper)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4271', '--strictPort'], {
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

  it('bare xlink:href fragments keep harmless PNG / local href through fragment + Paper-import sanitizers', async () => {
    const bareXlinkPng = `<image xlink:href="data:image/png;base64,${PNG}" x="1" y="2" width="4" height="4"/>`
    for (const clean of [await sanitizeFrag(bareXlinkPng), await sanitizePaper(bareXlinkPng)]) {
      expect(clean).toContain('data:image/png;base64,')
      expect(clean).toContain('xlink:href')
      expect(clean.toLowerCase()).not.toContain('width="1" height="1"')
    }
    const bareBoth = `<image href="data:image/png;base64,${PNG}" xlink:href="data:image/png;base64,${PNG}" x="1" y="2" width="4" height="4"/>`
    for (const clean of [await sanitizeFrag(bareBoth), await sanitizePaper(bareBoth)]) {
      expect(clean).toContain('data:image/png;base64,')
    }
    const bareUse = `<use xlink:href="#keep-r"/>`
    for (const clean of [await sanitizeFrag(bareUse), await sanitizePaper(bareUse)]) {
      expect(clean).toContain('#keep-r')
      expect(clean.toLowerCase()).not.toContain('width="1" height="1"')
    }
  }, 30_000)

  it('same-mode paste shape (HTML outerHTML without xmlns:xlink) survives the Paper-import boundary', async () => {
    const result = await page.evaluate(async ({ png }: { png: string }) => {
      const { sanitizeSvgForPaperImport } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      // Live-document HTML serialization: prefix kept, declaration dropped —
      // the exact `vectorClipboard` entry shape for same-mode paste.
      const div = document.createElement('div')
      div.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<image href="data:image/png;base64,${png}" xlink:href="data:image/png;base64,${png}" x="7" y="8" width="9" height="10"></image></svg>`
      const outer = div.querySelector('image')?.outerHTML ?? ''
      const clean = sanitizeSvgForPaperImport(outer) as string
      const doc = new DOMParser().parseFromString(clean, 'image/svg+xml')
      const payload = doc.documentElement.firstElementChild
      return {
        outer,
        clean: clean.slice(0, 600),
        tag: payload?.tagName.toLowerCase() ?? null,
        href: payload?.getAttribute('href') ?? null,
        x: payload?.getAttribute('x'),
        y: payload?.getAttribute('y'),
        parserError: doc.getElementsByTagName('parsererror').length > 0,
      }
    }, { png: PNG })
    expect(result.outer).toContain('xlink:href')
    expect(result.parserError).toBe(false)
    expect(result.tag).toBe('image')
    expect(result.href).toContain('data:image/png;base64,')
    expect(result.x).toBe('7')
    expect(result.y).toBe('8')
  }, 30_000)

  it('full documents missing xmlns:xlink are normalized; existing declarations are untouched', async () => {
    const missing =
      `<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="xlink-r1" width="10" height="10"/></defs><use xlink:href="#xlink-r1"/></svg>`
    const cleanMissing = await sanitizeDisplay(missing)
    expect(cleanMissing).toContain('#xlink-r1')
    expect(cleanMissing).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"')

    const existing =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><rect id="xlink-r2" width="10" height="10"/></defs><use xlink:href="#xlink-r2"/></svg>`
    const cleanExisting = await sanitizeDisplay(existing)
    expect(cleanExisting).toContain('#xlink-r2')
    // Single declaration preserved (no duplication on the root).
    const rootDecls = (cleanExisting.match(/xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/g) ?? []).length
    expect(rootDecls).toBe(1)
  }, 30_000)

  it('external xlink:href / href and image-set() fail closed with zero canary requests', async () => {
    const attacks = [
      `<image xlink:href="https://${NET}/xlink.png" width="10" height="10"/>`,
      `<image href="https://${NET}/href.png" xlink:href="https://${NET}/xlink2.png" width="10" height="10"/>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://${NET}/doc.png" width="10" height="10"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" style="background-image:image-set('https://${NET}/is.png' 1x)"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" fill="image-set('https://${NET}/fill.png' 1x)"/></svg>`,
    ]
    const failures: string[] = []
    for (const raw of attacks) {
      const clean = await sanitizePaper(raw)
      if (clean.includes(NET)) failures.push(`canary retained :: ${clean.slice(0, 200)}`)
      netHits = []
      const fired = await firesViaInnerHTML(clean)
      if (fired !== null) failures.push(`marker fired ${JSON.stringify(fired)}`)
      await new Promise((r) => setTimeout(r, 200))
      if (netHits.length > 0) failures.push(`network hit ${JSON.stringify(netHits)}`)
    }
    expect(failures).toEqual([])
  }, 60_000)

  it('script is removed while valid local defs / PNG survive and stay silent', async () => {
    const scriptDoc =
      `<svg xmlns="http://www.w3.org/2000/svg"><script>window.${MARK}='xlink-script'</script><rect width="10" height="10"/></svg>`
    const cleanScript = await sanitizeDisplay(scriptDoc)
    expect(cleanScript.toLowerCase()).not.toContain('<script')
    expect(cleanScript).toContain('<rect')
    expect(await firesViaInnerHTML(cleanScript)).toBeNull()

    const legit =
      `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="xlink-g"><stop offset="0" stop-color="red"/></linearGradient></defs>` +
      `<rect width="10" height="10" fill="url(#xlink-g)"/><image href="data:image/png;base64,${PNG}" x="1" y="2" width="4" height="4"/></svg>`
    const cleanLegit = await sanitizeDisplay(legit)
    expect(cleanLegit).toContain('url(#xlink-g)')
    expect(cleanLegit).toContain('data:image/png;base64,')
    expect(await firesViaInnerHTML(cleanLegit)).toBeNull()
    netHits = []
    await firesViaInnerHTML(cleanLegit)
    await new Promise((r) => setTimeout(r, 200))
    expect(netHits).toEqual([])
  }, 60_000)

  it('real Paper.js imports the normalized bare-xlink fragment (no throw, geometry kept)', async () => {
    const result = await page.evaluate(async ({ png, mark, net }: { png: string; mark: string; net: string }) => {
      const w = window as unknown as Record<string, unknown>
      const { sanitizeSvgForPaperImport } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      const { ensureVectorPaperScope } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const frag = `<image xlink:href="data:image/png;base64,${png}" x="3" y="4" width="12" height="14"/>`
      const clean = sanitizeSvgForPaperImport(frag) as string
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      w[mark] = null
      let imported = false
      let exported = ''
      let threw = ''
      try {
        const item = scope.project.importSVG(clean, { insert: false }) as unknown as {
          exportSVG: (o: unknown) => string
          remove: () => void
        } | null
        if (item) {
          imported = true
          exported = item.exportSVG({ asString: true }) as string
          item.remove()
        }
      } catch (error) {
        threw = String(error).slice(0, 200)
      }
      scope.project.clear()
      const atImport = w[mark]
      w[mark] = null
      // External control: the same fragment with an external xlink target must
      // not carry the canary into Paper or fire.
      const evilFrag = `<image xlink:href="https://${net}/evil.png" width="10" height="10"/>`
      const evilClean = sanitizeSvgForPaperImport(evilFrag) as string
      return { clean: clean.slice(0, 400), imported, exported: exported.slice(0, 400), threw, atImport, evilClean: evilClean.slice(0, 400) }
    }, { png: PNG, mark: MARK, net: NET })
    expect(result.clean).toContain('data:image/png;base64,')
    expect(result.imported).toBe(true)
    expect(result.threw).toBe('')
    expect(result.atImport).toBeNull()
    expect(result.evilClean).not.toContain(NET)
    expect(result.evilClean.toLowerCase()).not.toContain('onerror')
  }, 30_000)
})
