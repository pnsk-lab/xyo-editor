/**
 * Real-Editor bitmap <-> vector cross-format copy/paste regression.
 *
 * Drives only the real UI (no `src/*` sanitizer/paper imports from the test):
 * - vector -> bitmap: copy a vector costume (opaque + semitransparent +
 *   gradient + embedded PNG + transform), switch to a blank bitmap costume
 *   (target switch), paste through `paste-costume-selection` (the real
 *   `pasteVectorClipboardAsBitmap` path: sanitize -> tight raster -> stagger
 *   -> source-over stamp), then verify pixels, stagger, and single-history
 *   undo/redo;
 * - bitmap -> vector: copy the bitmap art back (trimmed-raster fallback),
 *   convert the same costume to vector (mode switch), paste through the real
 *   `pasteBitmapClipboardAsVector` path (`origin / bitmapResolution +
 *   stagger`), then verify the second `<image>` lands +10/+10 with an
 *   allowlisted `data:` href and single-history undo/redo;
 * - malicious SVG stays silent through the vector -> bitmap cross path
 *   (same UI upload boundary, harmless canary: reserved `.invalid` TLD plus
 *   a `page.route` tap that aborts; payloads can only trigger a blocked
 *   resource fetch or assign a plain string to `window.__xyoCrossProbe`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const MARK = '__xyoCrossProbe'
const NET = 'regress-cross.invalid'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4401'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

let netHits: string[] = []

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const BLANK_PNG_BASE64 = PNG_1X1

const SAFE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<defs>` +
  `<linearGradient id="cross-g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>` +
  `</defs>` +
  `<rect id="cross-red" x="10" y="12" width="120" height="80" fill="#ff0000" stroke="black" stroke-width="2" transform="translate(30 20)"/>` +
  `<rect id="cross-green" x="200" y="150" width="60" height="40" fill="rgba(0,255,0,0.5)"/>` +
  `<rect id="cross-grad" x="300" y="40" width="70" height="50" fill="url(#cross-g)"/>` +
  `<image id="cross-png" href="data:image/png;base64,${PNG_1X1}" x="1" y="2" width="4" height="4"/>` +
  `</svg>`

const DANGEROUS_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<defs><linearGradient id="live-g"><stop offset="0" stop-color="red"/></linearGradient></defs>` +
  `<rect x="10" y="12" width="120" height="80" fill="url(#live-g)" stroke="black" onload="window.${MARK}='upload-onload'"/>` +
  `<image href="https://${NET}/cross-upload.png" x="1" y="2" width="10" height="10" onerror="window.${MARK}='upload-onerror'"/>` +
  `<rect x="150" y="20" width="60" height="40" fill="url(https://${NET}/cross-fill)" style="background-image:image-set(url(https://${NET}/cross-bg.png) 1x)"/>` +
  `</svg>`

function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

function copyButton() {
  return page.getByTestId('copy-costume-selection')
}

function pasteButton() {
  return page.getByTestId('paste-costume-selection')
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

/** Bitmap destination settle wait (UI or workspace token, no sleep). The live
 * canvas is unsettled while a decode/raster/verify load is in flight
 * (Fit + full-pixel verify stretches the settle window): the toolbar Paste
 * stays `disabled` with an explicit loading display until the pending owner
 * clears. Every bitmap-destination paste below waits for this (canvas visible
 * alone is not enough: the canvas element appears ~40ms after the target
 * switch while the workspace still carries `pending!=none` for ~140ms)
 * without loosening pixel/position/history asserts. */
async function bitmapWorkspaceToken(): Promise<string> {
  return await page.evaluate(() => {
    const w = window as unknown as { __hikkakuEditorTest?: { bitmapWorkspaceToken: () => string } }
    return w.__hikkakuEditorTest?.bitmapWorkspaceToken() ?? ''
  })
}
async function waitForBitmapSettled(timeout = 30_000) {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __hikkakuEditorTest?: { bitmapWorkspaceToken: () => string } }
      const token = w.__hikkakuEditorTest?.bitmapWorkspaceToken() ?? ''
      return token.includes('pending=none')
    },
    undefined,
    { timeout },
  )
  await page.getByTestId('bitmap-workspace-loading-overlay').waitFor({ state: 'hidden', timeout }).catch(() => undefined)
}
async function waitForBitmapPasteReady(timeout = 30_000) {
  await waitForBitmapSettled(timeout)
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="paste-costume-selection"]') as HTMLButtonElement | null
      return button !== null && !button.disabled
    },
    undefined,
    { timeout },
  )
}

async function uploadCostume(name: string, mimeType: string, buffer: Buffer) {
  const before = await page.getByTestId(/costume-card-\d+/).count()
  await page.getByTestId('costume-file-input').setInputFiles({ name, mimeType, buffer })
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
    before as unknown as undefined,
    { timeout: 30_000 },
  )
}

async function selectLastCostumeCard() {
  await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click()
}

type BitmapProbe = {
  width: number
  height: number
  opaque: number
  redOpaque: number
  greenSemi: number
  blueOpaque: number
}

async function probeBitmapCanvas(): Promise<BitmapProbe> {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) throw new Error('bitmap canvas missing')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2d context missing')
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const data = image.data
    let opaque = 0
    let redOpaque = 0
    let greenSemi = 0
    let blueOpaque = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      const a = data[i + 3] ?? 0
      if (a !== 0) opaque += 1
      if (r > 200 && g < 60 && b < 60 && a > 200) redOpaque += 1
      if (g > 150 && r < 150 && a >= 80 && a <= 170) greenSemi += 1
      if (b > 150 && r < 150 && g < 150 && a > 100) blueOpaque += 1
    }
    return { width: canvas.width, height: canvas.height, opaque, redOpaque, greenSemi, blueOpaque }
  })
}

async function bitmapSelectionLeftPercent(): Promise<number | undefined> {
  return await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
    if (!overlay) return undefined
    const left = overlay.style.left
    if (!left) return undefined
    const value = Number.parseFloat(left.replace('%', ''))
    return Number.isFinite(value) ? value : undefined
  })
}

/** Live-canvas opaque bounds (any alpha !== 0 counts): the copy fallback rect. */
async function canvasOpaqueTrim(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) throw new Error('bitmap canvas missing')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2d context missing')
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let left = canvas.width
    let top = canvas.height
    let right = -1
    let bottom = -1
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if ((data[(y * canvas.width + x) * 4 + 3] ?? 0) === 0) continue
        if (x < left) left = x
        if (y < top) top = y
        if (x > right) right = x
        if (y > bottom) bottom = y
      }
    }
    if (right < left) return null
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
  })
}

type VectorImageReport = {
  count: number
  units: number
  images: Array<{ x: number | null; y: number | null; width: number | null; height: number | null; href: string | null }>
  html: string
}

async function vectorImageReport(): Promise<VectorImageReport> {
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
    const images = (svg ? Array.from(svg.querySelectorAll('image')) : []).map((el) => ({
      x: el.getAttribute('x') === null ? null : Number(el.getAttribute('x')),
      y: el.getAttribute('y') === null ? null : Number(el.getAttribute('y')),
      width: el.getAttribute('width') === null ? null : Number(el.getAttribute('width')),
      height: el.getAttribute('height') === null ? null : Number(el.getAttribute('height')),
      href: el.getAttribute('href') ?? el.getAttribute('xlink:href'),
    }))
    return { count: images.length, units: units.length, images, html }
  })
}

describe('real-Editor bitmap <-> vector cross-format copy/paste (harmless canary)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4401', '--strictPort'], {
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
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('vector -> bitmap: copies vector art, switches target, pastes raster with stagger and one history entry', async () => {
    netHits = []
    await page.evaluate((mark) => {
      ;(window as unknown as Record<string, unknown>)[mark as string] = null
    }, MARK as unknown as undefined)
    // Safe vector source (opaque + semitransparent + gradient + PNG + transform).
    await uploadCostume('cross-safe.svg', 'image/svg+xml', Buffer.from(SAFE_SVG, 'utf8'))
    await selectLastCostumeCard()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    const before = await vectorImageReport()
    expect(before.units).toBeGreaterThanOrEqual(3)

    // Copy in vector mode (falls back to every object when nothing is selected).
    await copyButton().click()
    await waitForStatus('Vector selection copied')

    // Target switch: blank bitmap costume, then paste across formats.
    await uploadCostume('cross-blank.png', 'image/png', Buffer.from(BLANK_PNG_BASE64, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    // True await condition: the canvas element alone is not enough (it
    // appears while `bitmapWorkspacePending` is still set and Paste stays
    // `disabled` with `Loading bitmap…`). Wait for the workspace settle.
    await waitForBitmapSettled()
    const blank = await probeBitmapCanvas()
    expect(blank.width).toBe(960)
    expect(blank.height).toBe(720)
    expect(blank.opaque).toBeLessThanOrEqual(1)

    // Cross clipboard is present even though the bitmap clipboard is empty.
    // Paste stays disabled until the bitmap destination settles (see above).
    await waitForBitmapPasteReady()
    expect(await pasteButton().isEnabled()).toBe(true)
    await pasteButton().click()
    await waitForStatus('Bitmap selection pasted')
    const pasted = await probeBitmapCanvas()
    // Opaque red + semitransparent green + the local-gradient companion
    // (blue tail of `url(#cross-g)`) survive the vector raster with alpha.
    expect(pasted.redOpaque).toBeGreaterThan(1000)
    expect(pasted.greenSemi).toBeGreaterThan(500)
    expect(pasted.blueOpaque).toBeGreaterThan(500)
    expect(pasted.opaque).toBeGreaterThan(blank.opaque)
    const left1 = await bitmapSelectionLeftPercent()
    expect(left1).toBeDefined()

    // Stagger: a second paste lands +10px right (same shared pasteOffset).
    // NOTE: status already reads 'Bitmap selection pasted', so barrier on the
    // overlay position instead of the status text.
    await pasteButton().click()
    await page.waitForFunction(
      (prev: number | undefined) => {
        const overlay = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
        if (!overlay || !overlay.style.left) return false
        const value = Number.parseFloat(overlay.style.left.replace('%', ''))
        return Number.isFinite(value) && value !== prev
      },
      left1 as unknown as undefined,
      { timeout: 30_000 },
    )
    const left2 = await bitmapSelectionLeftPercent()
    expect(left2).toBeDefined()
    const expectedStep = (10 / pasted.width) * 100
    expect(Math.abs((left2 ?? 0) - (left1 ?? 0) - expectedStep)).toBeLessThan(0.05)

    // Exactly one history entry per paste: undo peels paste2 back to paste1.
    const afterTwo = await probeBitmapCanvas()
    await undoButton().click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      (count: number) => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return false
        const context = canvas.getContext('2d')
        if (!context) return false
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data
        let opaque = 0
        for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) !== 0) opaque += 1
        return opaque !== count
      },
      afterTwo.opaque as unknown as undefined,
      { timeout: 30_000 },
    )
    const undone = await probeBitmapCanvas()
    expect(undone.opaque).toBe(pasted.opaque)
    expect(undone.redOpaque).toBe(pasted.redOpaque)

    // Redo restores exactly paste2.
    await redoButton().click()
    await waitForStatus('Asset redo')
    await page.waitForFunction(
      (count: number) => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return false
        const context = canvas.getContext('2d')
        if (!context) return false
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data
        let opaque = 0
        for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) !== 0) opaque += 1
        return opaque === count
      },
      afterTwo.opaque as unknown as undefined,
      { timeout: 30_000 },
    )

    // Peel back to paste1 and leave it for the bitmap -> vector leg.
    await undoButton().click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      (count: number) => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!canvas) return false
        const context = canvas.getContext('2d')
        if (!context) return false
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data
        let opaque = 0
        for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) !== 0) opaque += 1
        return opaque === count
      },
      pasted.opaque as unknown as undefined,
      { timeout: 30_000 },
    )
    expect(await editorStatus()).toMatch(/Asset undo/)
    await new Promise((r) => setTimeout(r, 300))
    expect(netHits).toEqual([])
    const fired = await page.evaluate((mark) => {
      const w = window as unknown as Record<string, unknown>
      const value = w[mark as string]
      w[mark as string] = null
      return value
    }, MARK as unknown as undefined)
    expect(fired).toBeNull()
  }, 180_000)

  it('bitmap -> vector: copies bitmap art, converts mode, pastes an <image> with +10 stagger and one history entry', async () => {
    netHits = []
    // Still on the blank-bitmap-turned-art costume. Undo/redo reloads the
    // bitmap canvas from bytes and drops the marquee (pre-existing
    // `clearBitmapCanvasPreview` behavior), so copy takes the trimmed-raster
    // fallback (whole art) here, preserving its position.
    expect(await page.getByTestId('bitmap-selection').isVisible().catch(() => false)).toBe(false)
    await copyButton().click()
    await waitForStatus('Bitmap selection copied')
    // The fallback copy rect is the live-canvas opaque trim: record it so the
    // vector paste position below is pinned against the copied position
    // (origin / resolution + stagger), not against the converted base image
    // (which always sits at the trimmed origin 0,0 by construction).
    const copyTrim = await canvasOpaqueTrim()
    expect(copyTrim).toBeTruthy()

    // Mode switch via the real conversion button (same costume, new format).
    await page.getByRole('button', { name: /ベクターに変換/ }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    const converted = await vectorImageReport()
    expect(converted.count).toBeGreaterThanOrEqual(1)
    for (const image of converted.images) {
      expect(image.href?.startsWith('data:image/png;base64,')).toBe(true)
      expect(Number.isFinite(image.x)).toBe(true)
      expect(Number.isFinite(image.y)).toBe(true)
      expect((image.width ?? 0) > 0).toBe(true)
      expect((image.height ?? 0) > 0).toBe(true)
    }
    expect(converted.html).not.toContain(NET)

    // Cross paste appends exactly one staggered `<image>` (origin / 2 + 10).
    expect(await pasteButton().isEnabled()).toBe(true)
    const beforePaste = converted
    await pasteButton().click()
    await waitForStatus('Vector selection pasted')
    await page.waitForFunction(
      (count: number) => {
        const svg = document.querySelector('.vector-preview svg')
        return svg ? svg.querySelectorAll('image').length > count : false
      },
      beforePaste.count as unknown as undefined,
      { timeout: 30_000 },
    )
    const pasted = await vectorImageReport()
    expect(pasted.count).toBe(beforePaste.count + 1)
    const first = pasted.images.at(-2)
    const second = pasted.images.at(-1)
    expect(first && second).toBeTruthy()
    // Same clipboard size re-anchored at its copied position, staggered once:
    // sprite resolution halves canvas px into SVG units, then +10 stagger.
    expect(Math.abs((second!.x ?? 0) - (copyTrim!.x / 2 + 10))).toBeLessThan(1)
    expect(Math.abs((second!.y ?? 0) - (copyTrim!.y / 2 + 10))).toBeLessThan(1)
    expect(second!.width).toBe(first!.width)
    expect(second!.height).toBe(first!.height)
    expect(second!.href?.startsWith('data:image/png;base64,')).toBe(true)
    expect(pasted.html).not.toContain(NET)
    expect(pasted.html.toLowerCase()).not.toContain('onload')

    // Exactly one history entry: undo peels only the pasted `<image>`.
    const pastedHtml = pasted.html
    await undoButton().click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      (expected: string) => document.querySelector('.vector-preview')?.innerHTML !== expected,
      pastedHtml as unknown as undefined,
      { timeout: 30_000 },
    )
    const undone = await vectorImageReport()
    expect(undone.count).toBe(beforePaste.count)

    await redoButton().click()
    await waitForStatus('Asset redo')
    await page.waitForFunction(
      (expected: string) => document.querySelector('.vector-preview')?.innerHTML === expected,
      pastedHtml as unknown as undefined,
      { timeout: 30_000 },
    )
    const redone = await vectorImageReport()
    expect(redone.count).toBe(beforePaste.count + 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(netHits).toEqual([])
  }, 180_000)

  it('keeps a malicious vector silent through the vector -> bitmap cross path (canary only, zero requests)', async () => {
    netHits = []
    await page.evaluate((mark) => {
      ;(window as unknown as Record<string, unknown>)[mark as string] = null
    }, MARK as unknown as undefined)
    await uploadCostume('cross-danger.svg', 'image/svg+xml', Buffer.from(DANGEROUS_SVG, 'utf8'))
    await selectLastCostumeCard()
    await new Promise((r) => setTimeout(r, 800))
    // The upload boundary either rejects the file or selects a sanitized
    // vector costume; either outcome must stay network-free.
    const vectorVisible = await page.locator('.vector-preview').isVisible().catch(() => false)
    if (vectorVisible) {
      const report = await vectorImageReport()
      expect(report.html).not.toContain(NET)
      expect(report.html.toLowerCase()).not.toContain('onload')
      expect(report.html.toLowerCase()).not.toContain('onerror')
      // Copy the (sanitized) vector clipboard, then switch back to the bitmap
      // art costume and paste across: the raster path re-sanitizes and must
      // not fetch.
      await copyButton().click()
      await waitForStatus('Vector selection copied').catch(() => undefined)
    }
    // Fresh blank bitmap target (the earlier art costume was converted to
    // vector in the previous leg): paste the dangerous vector clipboard
    // across formats and prove the raster path stays network-free.
    await uploadCostume('cross-blank2.png', 'image/png', Buffer.from(BLANK_PNG_BASE64, 'base64'))
    await selectLastCostumeCard()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    // Same settle gate: a paste click while `pending` is set would only hit
    // the disabled button (or the `Loading bitmap…` safe-refuse path).
    await waitForBitmapSettled()
    const statusBefore = await editorStatus()
    if (statusBefore.includes('Vector selection copied')) {
      await pasteButton().click()
      await waitForStatus('Bitmap selection pasted')
    }
    await new Promise((r) => setTimeout(r, 500))
    const fired = await page.evaluate((mark) => {
      const w = window as unknown as Record<string, unknown>
      const value = w[mark as string]
      w[mark as string] = null
      return value
    }, MARK as unknown as undefined)
    expect(fired).toBeNull()
    expect(netHits).toEqual([])
  }, 120_000)
})
