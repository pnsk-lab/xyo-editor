/**
 * SVG sanitizer regression — browser boundary (harmless window marker only).
 *
 * Covers the fixed trust boundary:
 * - Untrusted upload bytes -> `sanitizeSvgForDisplay` -> `{@html}` preview sink
 * - Same sanitized markup -> reshape-outline `{@html}` sink (second sink)
 * - Same sanitized markup -> Paper.js `importSVG` (editing sink)
 *
 * Every payload can only ever assign a plain string to
 * `window.__xyoSvgSanitizeProbe`. No network, navigation, or exfiltration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const MARK = '__xyoSvgSanitizeProbe'

const RAW_IMAGE_ONERROR =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="invalid-probe" onerror="window.${MARK}='raw-image-onerror'"/></svg>`
const SLASH_IMAGE_ONERROR =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="invalid-probe"/onerror="window.${MARK}='slash-image-onerror'"/></svg>`
const SLASH_ANIMATE_ONBEGIN =
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"><animate attributeName="opacity" from="1" to="0" dur="0.01s"/onbegin="window.${MARK}='slash-animate-onbegin'"/></rect></svg>`
const ENTITY_HREF_SLASH_ONERROR =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="&#105;nvalid-probe"/onerror="window.${MARK}='entity-href-slash-onerror'"/></svg>`
const UNCLOSED_FOREIGN_SLASH_IMG =
  `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img/src="invalid-probe"/onerror="window.${MARK}='ufo-img'"></div>`
const SVG_ONLOAD =
  `<svg xmlns="http://www.w3.org/2000/svg" onload="window.${MARK}='svg-onload'"><rect width="10" height="10"/></svg>`
const SCRIPT_TAG =
  `<svg xmlns="http://www.w3.org/2000/svg"><script>window.${MARK}='script-tag'</script><rect width="10" height="10"/></svg>`
const JAVASCRIPT_HREF =
  `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:window.${MARK}='js-href'"><text x="10" y="20">click</text></a></svg>`
const DATA_HTML_HREF =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/html,<script>window.${MARK}='data-html'</script>"/></svg>`

const MALICIOUS = [
  RAW_IMAGE_ONERROR,
  SLASH_IMAGE_ONERROR,
  SLASH_ANIMATE_ONBEGIN,
  ENTITY_HREF_SLASH_ONERROR,
  UNCLOSED_FOREIGN_SLASH_IMG,
  SVG_ONLOAD,
  SCRIPT_TAG,
  JAVASCRIPT_HREF,
  DATA_HTML_HREF,
] as const

const BENIGN_PNG =
  `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/></svg>`
const BENIGN_GRADIENT =
  `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="probe-g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#probe-g)" width="10" height="10"/></svg>`
const BENIGN_USE =
  `<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="probe-r" width="10" height="10"/></defs><use href="#probe-r"/></svg>`
const BENIGN_TEXT =
  `<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="24" font-size="24">hello-edit</text></svg>`
const BENIGN_EDIT =
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect x="10" y="10" width="20" height="20" fill="red" stroke="black"/></svg>`

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4232'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function sanitize(svg: string): Promise<string> {
  return page.evaluate(async (input: string) => {
    const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
    return sanitizeSvgForDisplay(input) as string
  }, svg)
}

async function firesViaInnerHTML(payload: string): Promise<unknown> {
  return page.evaluate(async ({ svg, mark }: { svg: string; mark: string }) => {
    const w = window as unknown as Record<string, unknown>
    w[mark] = null
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'svg-sanitize')
    document.body.appendChild(host)
    host.innerHTML = svg
    await new Promise((resolve) => setTimeout(resolve, 350))
    const fired = w[mark]
    host.remove()
    w[mark] = null
    return fired
  }, { svg: payload, mark: MARK })
}

describe('svg sanitizer boundary (harmless window marker only)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4232', '--strictPort'], {
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
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('sanitized malicious SVG never fires in the preview ({@html}) sink', async () => {
    for (const raw of MALICIOUS) {
      const clean = await sanitize(raw)
      const lower = clean.toLowerCase()
      expect(lower).not.toContain('onerror')
      expect(lower).not.toContain('onbegin')
      expect(lower).not.toContain('onload')
      expect(lower).not.toContain('<script')
      expect(lower).not.toContain('foreignobject')
      expect(lower).not.toContain('javascript:')
      const fired = await firesViaInnerHTML(clean)
      expect(fired).toBeNull()
    }
  }, 60_000)

  it('sanitized malicious SVG never fires in the reshape-outline (second {@html}) sink', async () => {
    for (const raw of MALICIOUS) {
      const clean = await sanitize(raw)
      // Reshape overlay re-sanitizes its built outline; model that double sink.
      const twice = await sanitize(clean)
      const fired = await page.evaluate(async ({ svg, mark }: { svg: string; mark: string }) => {
        const w = window as unknown as Record<string, unknown>
        w[mark] = null
        const host = document.createElement('div')
        document.body.appendChild(host)
        host.innerHTML = svg
        await new Promise((resolve) => setTimeout(resolve, 250))
        const fired = w[mark]
        host.remove()
        w[mark] = null
        return fired
      }, { svg: twice, mark: MARK })
      expect(fired).toBeNull()
    }
  }, 60_000)

  it('sanitized malicious SVG stays silent through the Paper import sink', async () => {
    for (const raw of MALICIOUS) {
      const result = await page.evaluate(async ({ input, mark }: { input: string; mark: string }) => {
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
            exportSVG: (options: unknown) => string
            remove: () => void
          } | null
          if (item) {
            exported = item.exportSVG({ asString: true }) as string
            item.remove()
          }
        } catch {
          exported = ''
        }
        scope.project.clear()
        const atImport = w[mark]
        w[mark] = null
        return { clean, exported, atImport }
      }, { input: raw, mark: MARK })
      expect(result.atImport).toBeNull()
      expect(result.exported.toLowerCase()).not.toContain('onerror')
      expect(result.exported.toLowerCase()).not.toContain('onbegin')
      const fired = await firesViaInnerHTML(result.exported || '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
      expect(fired).toBeNull()
    }
  }, 60_000)

  it('upload bytes -> preview path fails closed instead of passing raw through', async () => {
    const clean = await page.evaluate(async (input: string) => {
      const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      const bytes = new TextEncoder().encode(input)
      return sanitizeSvgForDisplay(new TextDecoder().decode(bytes)) as string
    }, SLASH_IMAGE_ONERROR)
    expect(clean).toContain('<svg')
    expect(clean).not.toContain('onerror')
    expect(await firesViaInnerHTML(clean)).toBeNull()

    const garbage = await sanitize('not svg at all <img src="x" onerror="alert(1)">')
    expect(garbage).toContain('<svg')
    expect(garbage.toLowerCase()).not.toContain('onerror')
    expect(await firesViaInnerHTML(garbage)).toBeNull()
  }, 30_000)

  it('legitimate PNG / gradient / use / text / edit content survives and stays silent', async () => {
    const png = await sanitize(BENIGN_PNG)
    expect(png).toContain('data:image/png;base64')
    expect(await firesViaInnerHTML(png)).toBeNull()

    const gradient = await sanitize(BENIGN_GRADIENT)
    expect(gradient.toLowerCase()).toContain('lineargradient')
    expect(await firesViaInnerHTML(gradient)).toBeNull()

    const use = await sanitize(BENIGN_USE)
    expect(use).toContain('#probe-r')
    expect(await firesViaInnerHTML(use)).toBeNull()

    const text = await sanitize(BENIGN_TEXT)
    expect(text).toContain('hello-edit')
    expect(await firesViaInnerHTML(text)).toBeNull()

    const edit = await sanitize(BENIGN_EDIT)
    const objects = await page.evaluate(async (svg: string) => {
      const { paperVectorObjectList } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      return (await paperVectorObjectList(svg)) as Array<{ tag: string }>
    }, edit)
    expect(objects.length).toBeGreaterThan(0)
    expect(await firesViaInnerHTML(edit)).toBeNull()
  }, 60_000)
})
