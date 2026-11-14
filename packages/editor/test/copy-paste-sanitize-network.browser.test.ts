/**
 * Copy/paste + rasterize sanitizer network regression (browser route).
 *
 * Covers the two hardened Editor.svelte boundaries (see
 * copy-paste-hoc-parity.test.ts source-level pins):
 * - `svgWithCrispRendering`: sanitized bytes -> blob URL + `<img>` -> canvas
 *   bitmap draw (vector -> bitmap conversion path).
 * - `pasteVectorSelection`: clipboard `outerHTML` -> `sanitizeSvgForPaperImport`
 *   -> parse/import/append (vector paste path).
 *
 * Safety: external "network" URLs use the reserved `.invalid` TLD plus a
 * `page.route` tap that aborts without leaving the browser. Payloads can only
 * trigger a (blocked) resource fetch or assign a plain string to
 * `window.__xyoPasteNetProbe`; no script executes and nothing is exfiltrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const MARK = '__xyoPasteNetProbe'
const NET = 'regress-paste.invalid'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4244'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

/** URLs the page tried to fetch that contain our canary host. */
let netHits: string[] = []

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">${inner}</svg>`
}

const RASTER_ATTACKS: Array<[string, string]> = [
  ['image-href', svgWrap(`<image href="https://${NET}/raster.png" x="1" y="2" width="10" height="10"/>`)],
  ['image-xlink', svgWrap(`<image xlink:href="https://${NET}/raster-xlink.png" x="1" y="2" width="10" height="10"/>`)],
  ['fill-url', svgWrap(`<rect width="20" height="20" fill="url(https://${NET}/raster-fill)"/>`)],
  ['style-imageset', svgWrap(`<rect width="20" height="20" style="background-image:image-set('https://${NET}/raster-is.png' 1x)"/>`)],
  ['style-url', svgWrap(`<rect width="20" height="20" style="background-image:url(https://${NET}/raster-bg.png)"/>`)],
  ['script-handler', svgWrap(`<rect width="20" height="20" onload="window.${MARK}='raster-onload'"/>`)],
]

const PASTE_ATTACKS: Array<[string, string]> = [
  ['onload-fragment', `<rect x="1" y="2" width="20" height="20" fill="red" onload="window.${MARK}='paste-onload'"/>`],
  ['onerror-fragment', `<image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4" onerror="window.${MARK}='paste-onerror'"/>`],
  ['external-href', `<image href="https://${NET}/paste.png" x="1" y="2" width="10" height="10"/>`],
  ['external-fill', `<rect width="20" height="20" fill="url(https://${NET}/paste-fill)"/>`],
  ['style-imageset', `<rect width="20" height="20" style="background-image:image-set('https://${NET}/paste-is.png' 1x)"/>`],
  ['full-doc-onload', svgWrap(`<rect width="20" height="20" fill="red" onload="window.${MARK}='paste-doc'"/><image href="https://${NET}/paste-doc.png" width="4" height="4"/>`)],
]

describe('copy/paste + rasterize network regression (harmless canary only)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4244', '--strictPort'], {
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

  it('rasterize boundary (sanitize -> crispEdges -> blob img -> canvas) makes zero external requests', async () => {
    const failures: string[] = []
    for (const [name, raw] of RASTER_ATTACKS) {
      netHits = []
      const result = await page.evaluate(
        async ({ input, mark }: { input: string; mark: string }) => {
          const w = window as unknown as Record<string, unknown>
          w[mark] = null
          const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
          // Mirror Editor.svelte svgWithCrispRendering (hardened): sanitize
          // first, then apply the trusted crispEdges write.
          const clean = sanitizeSvgForDisplay(input) as string
          const doc = new DOMParser().parseFromString(clean, 'image/svg+xml')
          const svg = doc.documentElement
          if (svg.nodeName.toLowerCase() === 'svg' && doc.getElementsByTagName('parsererror').length === 0) {
            svg.setAttribute('shape-rendering', 'crispEdges')
          }
          const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(svg))
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }))
          try {
            const image = new Image()
            await new Promise<void>((resolve, reject) => {
              image.onload = () => resolve()
              image.onerror = () => reject(new Error('img-error'))
              image.src = url
            })
            const canvas = document.createElement('canvas')
            canvas.width = 96
            canvas.height = 96
            const context = canvas.getContext('2d')!
            context.drawImage(image, 0, 0, 96, 96)
          } catch {
            // Broken/blank placeholders reject the <img> load: still a safe
            // (network-free) outcome; the conversion path keeps a blank canvas.
          } finally {
            URL.revokeObjectURL(url)
          }
          await new Promise((resolve) => setTimeout(resolve, 300))
          return { clean, fired: w[mark] }
        },
        { input: raw, mark: MARK },
      )
      if (result.clean.includes(NET)) failures.push(`${name}: canary survived rasterize sanitize :: ${result.clean.slice(0, 200)}`)
      if (result.fired !== null) failures.push(`${name}: marker fired ${JSON.stringify(result.fired)}`)
      await new Promise((r) => setTimeout(r, 150))
      if (netHits.length > 0) failures.push(`${name}: external request ${JSON.stringify(netHits)}`)
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('rasterize keeps legitimate paint: local gradient, embedded PNG, size, crispEdges', async () => {
    netHits = []
    const result = await page.evaluate(async () => {
      const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      const raw =
        `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
        `<defs><linearGradient id="keep-g"><stop offset="0" stop-color="red"/></linearGradient></defs>` +
        `<rect x="10" y="12" width="20" height="22" fill="url(#keep-g)" stroke="black"/>` +
        `<image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/>` +
        `</svg>`
      const clean = sanitizeSvgForDisplay(raw) as string
      const doc = new DOMParser().parseFromString(clean, 'image/svg+xml')
      const svg = doc.documentElement
      svg.setAttribute('shape-rendering', 'crispEdges')
      const out = new XMLSerializer().serializeToString(svg)
      const url = URL.createObjectURL(new Blob([new TextEncoder().encode(out)], { type: 'image/svg+xml' }))
      let drew = false
      try {
        const image = new Image()
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = reject
          image.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = 96
        canvas.height = 96
        canvas.getContext('2d')!.drawImage(image, 0, 0, 96, 96)
        drew = image.width > 0
      } finally {
        URL.revokeObjectURL(url)
      }
      return { clean: out, drew }
    })
    expect(result.clean).toContain('url(#keep-g)')
    expect(result.clean).toContain('data:image/png;base64')
    expect(result.clean).toContain('shape-rendering="crispEdges"')
    expect(result.clean).toContain('width="96"')
    expect(result.drew).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(netHits).toEqual([])
  }, 60_000)

  it('paste boundary (sanitize fragment -> import/append) stays silent with zero requests', async () => {
    const failures: string[] = []
    for (const [name, markup] of PASTE_ATTACKS) {
      netHits = []
      const result = await page.evaluate(
        async ({ entry, mark }: { entry: string; mark: string }) => {
          const w = window as unknown as Record<string, unknown>
          w[mark] = null
          const { sanitizeSvgForPaperImport } = await import(
            /* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts'
          )
          const { SVG_PLACEHOLDER } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
          const doc = new DOMParser().parseFromString(
            `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs><linearGradient id="live-g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect x="4" y="5" width="10" height="10" fill="url(#live-g)"/></svg>`,
            'image/svg+xml',
          )
          const svg = doc.documentElement
          const clean = sanitizeSvgForPaperImport(entry) as string
          if (!clean || clean === (SVG_PLACEHOLDER as string)) return { skipped: true, fired: w[mark], html: '' }
          const cleanDoc = new DOMParser().parseFromString(clean, 'image/svg+xml')
          const root = cleanDoc.documentElement
          if (root.nodeName.toLowerCase() !== 'svg') return { skipped: true, fired: w[mark], html: '' }
          for (const payload of Array.from(root.children)) {
            const tag = (payload as Element).tagName.toLowerCase()
            if (tag === 'defs' || tag === 'metadata' || tag === 'title' || tag === 'desc') continue
            const imported = doc.importNode(payload, true) as unknown as Element
            const transform = imported.getAttribute('transform') ?? ''
            imported.setAttribute('transform', `${transform} translate(10 10)`.trim())
            svg.appendChild(imported)
          }
          const html = new XMLSerializer().serializeToString(doc)
          const host = document.createElement('div')
          document.body.appendChild(host)
          host.innerHTML = html
          await new Promise((resolve) => setTimeout(resolve, 300))
          const fired = w[mark]
          host.remove()
          w[mark] = null
          return { skipped: false, fired, html }
        },
        { entry: markup, mark: MARK },
      )
      if (!result.skipped) {
        if ((result.html ?? '').includes(NET)) failures.push(`${name}: canary pasted :: ${result.html.slice(0, 200)}`)
        if (/(onload|onerror)\s*=/i.test(result.html ?? '')) failures.push(`${name}: handler pasted :: ${result.html.slice(0, 200)}`)
        if (result.fired !== null) failures.push(`${name}: marker fired ${JSON.stringify(result.fired)}`)
      }
      await new Promise((r) => setTimeout(r, 150))
      if (netHits.length > 0) failures.push(`${name}: external request ${JSON.stringify(netHits)}`)
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('paste keeps working: local gradient ref, embedded PNG, stagger offset, existing defs intact', async () => {
    netHits = []
    const result = await page.evaluate(async ({ mark }: { mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      const { sanitizeSvgForPaperImport } = await import(
        /* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts'
      )
      // Live doc with an existing gradient def (copy keeps defs references).
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs><linearGradient id="live-g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect x="4" y="5" width="10" height="10" fill="url(#live-g)" transform="translate(5 7)"/></svg>`,
        'image/svg+xml',
      )
      const svg = doc.documentElement
      // Simulate copyVectorSelection: outerHTML of the selectable unit.
      const unit = Array.from(svg.children).find((node) => (node as Element).tagName.toLowerCase() === 'rect') as unknown as Element
      const clipboard = [unit.outerHTML]
      // Simulate hardened pasteVectorSelection (sanitize -> import children).
      let pastedCount = 0
      for (const markup of clipboard) {
        const clean = sanitizeSvgForPaperImport(markup) as string
        const cleanDoc = new DOMParser().parseFromString(clean, 'image/svg+xml')
        for (const payload of Array.from(cleanDoc.documentElement.children)) {
          const imported = doc.importNode(payload, true) as unknown as Element
          const transform = imported.getAttribute('transform') ?? ''
          imported.setAttribute('transform', `${transform} translate(10 10)`.trim())
          svg.appendChild(imported)
          pastedCount += 1
        }
      }
      // Embedded-PNG fragment still pastes.
      const pngClean = sanitizeSvgForPaperImport(
        `<image href="data:image/png;base64,iVBORw0KGgo=" x="1" y="2" width="4" height="4"/>`,
      ) as string
      const pngRoot = new DOMParser().parseFromString(pngClean, 'image/svg+xml').documentElement
      for (const payload of Array.from(pngRoot.children)) {
        svg.appendChild(doc.importNode(payload, true))
        pastedCount += 1
      }
      const html = new XMLSerializer().serializeToString(doc)
      const rects = Array.from(doc.getElementsByTagName('rect'))
      const last = rects.at(-1)!
      const defsCount = doc.getElementsByTagName('defs').length
      const gradKept = doc.getElementsByTagName('linearGradient').length
      const host = document.createElement('div')
      document.body.appendChild(host)
      host.innerHTML = html
      await new Promise((resolve) => setTimeout(resolve, 300))
      const fired = w[mark]
      host.remove()
      w[mark] = null
      return {
        pastedCount,
        rectCount: rects.length,
        lastFill: last.getAttribute('fill'),
        lastTransform: last.getAttribute('transform'),
        defsCount,
        gradKept,
        hasPng: html.includes('data:image/png;base64'),
        fired,
      }
    }, { mark: MARK })
    // Original + pasted rect + pasted png image.
    expect(result.pastedCount).toBe(2)
    expect(result.rectCount).toBe(2)
    // Existing defs reference is not broken: still points at the live gradient.
    expect(result.lastFill).toBe('url(#live-g)')
    // Stagger composes with the existing transform instead of overwriting it.
    expect(result.lastTransform).toContain('translate(5 7)')
    expect(result.lastTransform).toContain('translate(10 10)')
    expect(result.defsCount).toBe(1)
    expect(result.gradKept).toBe(1)
    expect(result.hasPng).toBe(true)
    expect(result.fired).toBeNull()
    await new Promise((r) => setTimeout(r, 200))
    expect(netHits).toEqual([])
  }, 60_000)
})
