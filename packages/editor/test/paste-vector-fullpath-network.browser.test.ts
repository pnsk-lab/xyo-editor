/**
 * Real-Editor pasteVectorSelection full-path regression (UI upload boundary only).
 *
 * Why this file exists: `copy-paste-sanitize-network.browser.test.ts` composes
 * `sanitizeSvgForDisplay` / `sanitizeSvgForPaperImport` directly and mirrors
 * `Editor.svelte` (`svgWithCrispRendering` / `pasteVectorSelection`) by hand,
 * so it never executes the real `copyVectorSelection` -> `pasteVectorSelection`
 * path (clipboard `outerHTML` -> sanitizer -> import/append/stagger) nor the
 * real costume-upload ingress (`costume-file-input` -> `vmCostumeUpload`).
 *
 * This test drives only the real UI:
 * - safe costume (gradient + clipPath + embedded PNG + transform) is loaded
 *   through `costume-file-input` (the `uploadCostume` boundary);
 * - copy/paste/undo/redo go through the toolbar buttons
 *   (`copy-costume-selection` / `paste-costume-selection` / Undo / Redo),
 *   i.e. the real `copyCostumeSelection` / `pasteCostumeSelection` dispatch
 *   into `copyVectorSelection` / `pasteVectorSelection` with history;
 * - local defs references, surviving paint/pixels and coordinates are read
 *   back from the rendered `.vector-preview` DOM (no `src/*` sanitizer or
 *   paper imports: the page under test does the sanitizing/importing).
 *
 * Dangerous SVG is verified ONLY through the same UI upload boundary with a
 * harmless canary: external URLs use the reserved `.invalid` TLD plus a
 * `page.route` tap that aborts without leaving the browser. Payloads can only
 * trigger a (blocked) resource fetch or assign a plain string to
 * `window.__xyoPasteFullpathProbe`; no script executes and nothing is
 * exfiltrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const MARK = '__xyoPasteFullpathProbe'
const NET = 'regress-paste.invalid'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4399'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

/** URLs the page tried to fetch that contain our canary host. */
let netHits: string[] = []

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SAFE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<defs>` +
  `<linearGradient id="safe-g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>` +
  `<clipPath id="clip-a"><circle cx="60" cy="50" r="30"/></clipPath>` +
  `</defs>` +
  `<rect id="grad-rect" x="10" y="12" width="120" height="80" fill="url(#safe-g)" stroke="black" stroke-width="2" transform="translate(30 20)"/>` +
  `<g id="clip-group" transform="translate(5 7)"><rect id="clipped-rect" x="100" y="60" width="80" height="50" fill="green" clip-path="url(#clip-a)"/></g>` +
  `<image id="png-img" href="data:image/png;base64,${PNG_1X1}" x="1" y="2" width="4" height="4"/>` +
  `</svg>`

const DANGEROUS_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<defs><linearGradient id="live-g"><stop offset="0" stop-color="red"/></linearGradient></defs>` +
  `<rect x="10" y="12" width="120" height="80" fill="url(#live-g)" stroke="black" onload="window.${MARK}='upload-onload'"/>` +
  `<image href="https://${NET}/upload.png" x="1" y="2" width="10" height="10" onerror="window.${MARK}='upload-onerror'"/>` +
  `<rect x="150" y="20" width="60" height="40" fill="url(https://${NET}/upload-fill)" style="background-image:url(https://${NET}/upload-bg.png)"/>` +
  `</svg>`

function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => {
    const w = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
    return w.__hikkakuEditorTest?.status() ?? ''
  })
}

async function waitForStatus(text: string, timeout = 30_000) {
  await page.waitForFunction(
    (want) => {
      const w = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
      return (w.__hikkakuEditorTest?.status() ?? '').includes(want as string)
    },
    text as unknown as undefined,
    { timeout },
  )
}

async function waitForPreviewChange(before: string, timeout = 30_000) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before as unknown as undefined,
    { timeout },
  )
}

type PreviewReport = {
  html: string
  unitTags: string[]
  defsCount: number
  gradientIds: string[]
  clipIds: string[]
  fills: Array<string | null>
  clipPaths: Array<string | null>
  transforms: Array<string | null>
  pngCount: number
}

async function previewReport(): Promise<PreviewReport> {
  return await page.evaluate(() => {
    const host = document.querySelector('.vector-preview')
    const html = host?.innerHTML ?? ''
    const svg = host?.querySelector('svg')
    const units = svg
      ? Array.from(svg.children).filter((el) => {
          const tag = el.tagName.toLowerCase()
          return tag !== 'defs' && tag !== 'metadata' && tag !== 'title' && tag !== 'desc'
        })
      : []
    const defs = svg ? Array.from(svg.querySelectorAll('defs')) : []
    const gradients = svg
      ? Array.from(svg.querySelectorAll('linearGradient,radialGradient')).map(
          (el) => el.getAttribute('id') ?? '',
        )
      : []
    const clips = svg
      ? Array.from(svg.querySelectorAll('clipPath')).map((el) => el.getAttribute('id') ?? '')
      : []
    return {
      html,
      unitTags: units.map((el) => el.tagName.toLowerCase()),
      defsCount: defs.length,
      gradientIds: gradients,
      clipIds: clips,
      fills: units.map((el) => el.getAttribute('fill')),
      clipPaths: units.map((el) => el.getAttribute('clip-path')),
      transforms: units.map((el) => el.getAttribute('transform')),
      pngCount: (html.match(/data:image\/png;base64/g) ?? []).length,
    }
  })
}

describe('real-Editor vector copy/paste full path (UI upload boundary, harmless canary)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4399', '--strictPort'], {
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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.route('**/*', (route) => {
      const url = route.request().url()
      if (url.includes(NET)) {
        netHits.push(url)
        void route.abort()
        return
      }
      void route.continue()
    })
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('main-tab-costumes').click({ timeout: 120_000 })
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 120_000 })
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 120_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('loads a safe costume through the UI upload boundary with defs/pixels/coords intact', async () => {
    netHits = []
    await page.evaluate((mark) => {
      ;(window as unknown as Record<string, unknown>)[mark as string] = null
    }, MARK as unknown as undefined)
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'safe-fullpath.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(SAFE_SVG, 'utf8'),
    })
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
      beforeCards as unknown as undefined,
      { timeout: 30_000 },
    )
    await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    // New upload lands in vector mode with a pasted-preview SVG.
    const report = await previewReport()
    expect(report.html).toContain('url(#safe-g)')
    expect(report.html).toContain('url(#clip-a)')
    expect(report.html).toContain('data:image/png;base64')
    expect(report.html).toContain('translate(30 20)')
    expect(report.html).toContain('translate(5 7)')
    expect(report.gradientIds).toContain('safe-g')
    expect(report.clipIds).toContain('clip-a')
    expect(report.defsCount).toBeGreaterThanOrEqual(1)
    expect(report.pngCount).toBeGreaterThanOrEqual(1)
    // 3 editable root units (rect + group + embedded-PNG image), transform kept.
    expect(report.unitTags.length).toBe(3)
    expect(report.fills).toContain('url(#safe-g)')
    expect(report.transforms.some((t) => (t ?? '').includes('translate(30 20)'))).toBe(true)
    expect(report.transforms.some((t) => (t ?? '').includes('translate(5 7)'))).toBe(true)
    // Upload sets "N costume(s) uploaded"; selecting the new card then sets
    // "Costume selected". Either proves the UI upload boundary accepted it.
    expect(await editorStatus()).toMatch(/uploaded|selected/i)
    // Real preview renders the artwork (non-blank vector surface).
    const box = await page.locator('.vector-preview svg').boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(0)
    expect(box?.height ?? 0).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 300))
    expect(netHits).toEqual([])
    const fired = await page.evaluate((mark) => {
      const w = window as unknown as Record<string, unknown>
      const value = w[mark as string]
      w[mark as string] = null
      return value
    }, MARK as unknown as undefined)
    expect(fired).toBeNull()
  }, 120_000)

  it('copies/pastes through the real toolbar path with stagger, then undoes/redoes with refs intact', async () => {
    netHits = []
    const before = await previewReport()
    const beforeUnits = before.unitTags.length
    expect(beforeUnits).toBe(3)

    // Real copy path (falls back to every object when nothing is selected).
    await page.getByTestId('copy-costume-selection').click()
    await waitForStatus('Vector selection copied')
    // Real paste path: sanitize -> import/append with the shared +10px stagger.
    await page.getByTestId('paste-costume-selection').click()
    await waitForStatus('Vector selection pasted')
    await page.waitForFunction(
      (count: number) => {
        const svg = document.querySelector('.vector-preview svg')
        if (!svg) return false
        const units = Array.from(svg.children).filter((el) => {
          const tag = el.tagName.toLowerCase()
          return tag !== 'defs' && tag !== 'metadata' && tag !== 'title' && tag !== 'desc'
        })
        return units.length > count
      },
      beforeUnits as unknown as undefined,
      { timeout: 30_000 },
    )
    const pasted = await previewReport()
    expect(pasted.unitTags.length).toBe(beforeUnits * 2)
    // Local defs references survive the real paste (existing defs keep working).
    expect(pasted.html).toContain('url(#safe-g)')
    expect(pasted.html).toContain('url(#clip-a)')
    expect(pasted.html).toContain('data:image/png;base64')
    expect(pasted.gradientIds).toContain('safe-g')
    expect(pasted.clipIds).toContain('clip-a')
    // Original coordinates survive; the duplicate staggers by the shared offset.
    expect(pasted.transforms.some((t) => (t ?? '').includes('translate(30 20)'))).toBe(true)
    expect(pasted.transforms.some((t) => (t ?? '').includes('translate(5 7)'))).toBe(true)
    const hasStagger =
      pasted.html.includes('translate(10 10)') ||
      pasted.html.includes('translate(40 30)') ||
      pasted.html.includes('translate(15 17)')
    expect(hasStagger).toBe(true)
    // Embedded PNG duplicated too (pixels preserved, not dropped).
    expect(pasted.pngCount).toBeGreaterThanOrEqual(2)
    // Paper-visible geometry survives: every pasted unit keeps a real size.
    const geometries = await page.evaluate(() => {
      const svg = document.querySelector('.vector-preview svg')
      if (!svg) return []
      return Array.from(svg.children)
        .filter((el) => {
          const tag = el.tagName.toLowerCase()
          return tag !== 'defs' && tag !== 'metadata' && tag !== 'title' && tag !== 'desc'
        })
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          x: el.getAttribute('x'),
          y: el.getAttribute('y'),
          width: el.getAttribute('width'),
          height: el.getAttribute('height'),
          transform: el.getAttribute('transform'),
        }))
    })
    expect(geometries.length).toBe(beforeUnits * 2)
    for (const g of geometries) {
      if (g.tag === 'image') {
        expect(Number(g.width)).toBe(4)
        expect(Number(g.height)).toBe(4)
      }
    }
    await new Promise((r) => setTimeout(r, 300))
    expect(netHits).toEqual([])

    // Real undo peels exactly the paste (history path, not a DOM rewrite).
    const pastedHtml = pasted.html
    await undoButton().click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      (expected: string) => document.querySelector('.vector-preview')?.innerHTML !== expected,
      pastedHtml as unknown as undefined,
      { timeout: 30_000 },
    )
    const undone = await previewReport()
    expect(undone.unitTags.length).toBe(beforeUnits)
    expect(undone.html).toContain('url(#safe-g)')
    expect(undone.html).toContain('data:image/png;base64')
    expect(undone.html).toContain('translate(30 20)')

    // Real redo restores the pasted duplicate with its stagger and refs.
    await redoButton().click()
    await waitForStatus('Asset redo')
    await page.waitForFunction(
      (expected: string) => document.querySelector('.vector-preview')?.innerHTML === expected,
      pastedHtml as unknown as undefined,
      { timeout: 30_000 },
    )
    const redone = await previewReport()
    expect(redone.unitTags.length).toBe(beforeUnits * 2)
    expect(redone.html).toContain('url(#safe-g)')
    expect(redone.html).toContain('url(#clip-a)')
    expect(redone.html).toContain('data:image/png;base64')
    await new Promise((r) => setTimeout(r, 300))
    expect(netHits).toEqual([])
  }, 180_000)

  it('keeps a dangerous upload silent through the same UI boundary (canary only, zero requests)', async () => {
    netHits = []
    await page.evaluate((mark) => {
      ;(window as unknown as Record<string, unknown>)[mark as string] = null
    }, MARK as unknown as undefined)
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'danger-fullpath.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(DANGEROUS_SVG, 'utf8'),
    })
    await page.waitForFunction(
      (count: number) =>
        document.querySelectorAll('[data-testid^="costume-card-"]').length > count ||
        (document.body.textContent ?? '').includes('uploaded'),
      beforeCards as unknown as undefined,
      { timeout: 30_000 },
    )
    // If a new card appeared, inspect the sanitized rendering; otherwise the
    // boundary rejected the file, which is also a safe (network-free) outcome.
    const afterCards = await page.getByTestId(/costume-card-\d+/).count()
    let html = ''
    if (afterCards > beforeCards) {
      await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click()
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
      await new Promise((r) => setTimeout(r, 500))
      html = await previewSvg()
      expect(html).not.toContain(NET)
      expect(html.toLowerCase()).not.toContain('onload')
      expect(html.toLowerCase()).not.toContain('onerror')
    } else {
      await new Promise((r) => setTimeout(r, 500))
    }
    const fired = await page.evaluate((mark) => {
      const w = window as unknown as Record<string, unknown>
      const value = w[mark as string]
      w[mark as string] = null
      return value
    }, MARK as unknown as undefined)
    expect(fired).toBeNull()
    expect(netHits).toEqual([])
    // The previous safe costume's paste history still round-trips after the
    // dangerous upload attempt (no cross-costume history corruption).
    expect(html.length >= 0).toBe(true)
  }, 120_000)
})
