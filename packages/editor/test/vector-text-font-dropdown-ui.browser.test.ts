import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-Editor UI coverage for the unified text font dropdown (9 Scratch paint
// fonts + 5 pre-existing xyo system stacks, 14 entries).
//
// Unlike `vector-text-scratch-fonts.browser.test.ts` and
// `vector-text-font-toolbar.browser.test.ts` (which import the product modules
// directly in `page.evaluate`, i.e. a module harness), this suite drives the
// REAL Svelte UI on the fixture page: real toolbar `<select>`s (located by
// `data-testid`), real canvas clicks, the real inline overlay textarea, real
// Escape commits, and the real Undo/Redo buttons — with assertions against
// REAL VM asset bytes and REAL DOM text metrics (`getBBox`, canvas
// `measureText`). No font binaries are bundled/copied/fetched: only literal
// `font-family` name strings are asserted as attributes, and unavailable
// decorative webfonts fall back to system fonts (no `@font-face` added).
//
// Port 4374 is unused by the other browser suites.
const root = join(import.meta.dir, '..')
const PORT = 4374
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH =
  process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const SCRATCH_FONTS: Array<{ id: string; label: string; value: string }> = [
  { id: 'SANS_SERIF', label: 'Sans Serif', value: 'Sans Serif' },
  { id: 'SERIF', label: 'Serif', value: 'Serif' },
  { id: 'HANDWRITING', label: 'Handwriting', value: 'Handwriting' },
  { id: 'MARKER', label: 'Marker', value: 'Marker' },
  { id: 'CURLY', label: 'Curly', value: 'Curly' },
  { id: 'PIXEL', label: 'Pixel', value: 'Pixel' },
  { id: 'CHINESE', label: '中文', value: '"Microsoft YaHei", "微软雅黑", STXihei, "华文细黑"' },
  {
    id: 'JAPANESE',
    label: '日本語',
    value: '"ヒラギノ角ゴ Pro W3", "Hiragino Kaku Gothic Pro", Osaka, "メイリオ", Meiryo, "ＭＳ Ｐゴシック", "MS PGothic"',
  },
  { id: 'KOREAN', label: '한국어', value: 'Malgun Gothic' },
]
const SYSTEM_STACKS: Array<{ label: string; value: string }> = [
  { label: 'Sans Serif (System)', value: 'Arial, sans-serif' },
  { label: 'Serif (System)', value: 'Georgia, serif' },
  { label: 'Monospace', value: '"Courier New", monospace' },
  { label: 'Rounded', value: '"Comic Sans MS", "Chalkboard SE", sans-serif' },
  { label: 'Condensed', value: '"Arial Narrow", Arial, sans-serif' },
]

const PALETTE = ['#123456', '#654321', '#0a7d2c', '#8a1010', '#104a8a', '#6a1b9a', '#00695c', '#5d4037', '#37474f']

function fontsNineSvg(): string {
  // Single center column (x=240): immune to preview letterboxing, and the
  // seeded rows never overlap each other's glyphs.
  const units = SCRATCH_FONTS.map((entry, i) => {
    const y = 30 + i * 37
    const fill = PALETTE[i % PALETTE.length]
    // Unit 0 carries extra attributes so the "only font-family/size change"
    // assertion has something to protect (weight + transform must survive).
    const extra = i === 0 ? ' font-weight="900" transform="rotate(-8 240 30)"' : ` font-weight="700"`
    return `<text x="240" y="${y}" text-anchor="middle" font-family="${entry.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" font-size="22" fill="${fill}"${extra}>font-${entry.id}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${units}</svg>`
}

const UNKNOWN_STACK = 'NonexistentFontXYZ, sans-serif'
const QUOTE_STACK = 'Evil "Quote" Family, sans-serif'

function unknownTrickySvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360" font-family="${UNKNOWN_STACK}">` +
    `<text x="240" y="80" text-anchor="middle" font-size="30" font-weight="700" transform="rotate(5 240 80)">inherit-unknown</text>` +
    `<text x="240" y="140" text-anchor="middle" font-size="28" font-family="Evil &quot;Quote&quot; Family, sans-serif">tricky-quotes</text>` +
    `<text x="240" y="195" text-anchor="middle" font-size="26" style="font-family: 'Style Stack', serif">style-stack</text>` +
    `<text x="240" y="250" text-anchor="middle" style="font: italic bold 24px CustomShorthand, serif">shorthand-stack</text>` +
    `<text x="240" y="305" text-anchor="middle" font-size="24" font-family="x;y}body{color:red">injection-stack</text></svg>`
}

const BLANK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="20" y="60" width="80" height="60" fill="#00ff00"/></svg>`

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    const md5ext = `${hash}.svg`
    files[md5ext] = bytes
    return { assetId: hash, md5ext }
  }
  const nine = add(fontsNineSvg())
  const tricky = add(unknownTrickySvg())
  const blank = add(BLANK_SVG)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name,
    ...ref,
    dataFormat: 'svg',
    bitmapResolution: 1,
    rotationCenterX: 240,
    rotationCenterY: 180,
  })
  const project = {
    targets: [
      {
        isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ ...costume(blank, 'stage-blank'), rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(nine, 'fonts-9'), costume(tricky, 'unknown-tricky'), costume(blank, 'blank')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'font-dropdown-ui' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

type Digest = { len: number; sum: number }

async function costumeDigest(target: string, index: number): Promise<Digest> {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    return { len: (bytes as Uint8Array).length, sum }
  }, { target, index })
}

async function costumeText(target: string, index: number): Promise<string> {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { target, index })
}

async function waitForTextChange(target: string, index: number, beforeText: string, timeout = 20_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const got = await costumeText(target, index)
    if (got !== beforeText) return got
    if (Date.now() - start > timeout) throw new Error(`text change timeout ${target}[${index}]`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForDigestChange(target: string, index: number, before: Digest, timeout = 20_000): Promise<Digest> {
  const start = Date.now()
  for (;;) {
    const got = await costumeDigest(target, index)
    if (got.len !== before.len || got.sum !== before.sum) return got
    if (Date.now() - start > timeout) throw new Error(`digest change timeout ${target}[${index}]`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function selectCostumeByName(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).click()
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 15_000 })
}

async function waitForPreviewText(needle: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    (want: string) => document.querySelector('.vector-preview')?.textContent?.includes(want) ?? false,
    needle,
    { timeout },
  )
}

// Visible SVG rect in artwork units, measured at runtime: the viewport pan
// differs per costume (per-costume viewport state), so click points must be
// derived from this instead of fixed coordinates.
async function visibleSvgRect(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('.vector-preview').boundingBox()
  const surface = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box || !surface) throw new Error('Missing preview/surface bounds')
  const left = Math.max(surface.x, box.x)
  const top = Math.max(surface.y, box.y)
  const right = Math.min(surface.x + surface.width, box.x + box.width)
  const bottom = Math.min(surface.y + surface.height, box.y + box.height)
  if (right <= left || bottom <= top) throw new Error('Preview and surface do not overlap')
  return {
    x: ((left - box.x) / box.width) * 480,
    y: ((top - box.y) / box.height) * 360,
    width: ((right - left) / box.width) * 480,
    height: ((bottom - top) / box.height) * 360,
  }
}

// Zoom out until every seeded text's ink center is inside the visible
// surface slice (the default pan/zoom shows only part of the 480x360
// artboard). Client-space comparison: no SVG mapping, no letterbox math.
async function ensureSeedsVisible(needles: string[]): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    const allInside = await page.evaluate((wants: string[]) => {
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')
      const preview = document.querySelector('.vector-preview')
      const svg = preview?.querySelector('svg')
      if (!surface || !preview || !svg) return false
      const s = surface.getBoundingClientRect()
      if (!(s.width > 0 && s.height > 0)) return false
      return wants.every((want) => {
        const el = Array.from(svg.querySelectorAll('tspan, text')).find((node) => (node.textContent ?? '').includes(want))
        if (!el) return false
        try {
          const r = (el as unknown as SVGElement).getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) return false
          const cx = r.x + r.width * 0.5
          const cy = r.y + r.height * 0.5
          return cx >= s.x + 2 && cx <= s.x + s.width - 2 && cy >= s.y + 2 && cy <= s.y + s.height - 2
        } catch {
          return false
        }
      })
    }, needles).catch(() => false)
    if (allInside) return
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await page.waitForTimeout(400)
  }
  throw new Error('Seed texts did not become visible after zooming out')
}

async function ensureVectorMode() {
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 })
}

async function clickTextTool() {
  await page.getByTestId('vector-shape-text').click()
  await page.getByTestId('vector-text-font').waitFor({ state: 'visible', timeout: 10_000 })
}

async function clickSvgPoint(x: number, y: number) {
  const box = await page.locator('.vector-preview').boundingBox()
  if (!box) throw new Error('Missing vector preview bounds')
  const surface = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!surface) throw new Error('Missing paint surface bounds')
  const clientX = box.x + (x / 480) * box.width
  const clientY = box.y + (y / 360) * box.height
  if (clientX < surface.x || clientX > surface.x + surface.width || clientY < surface.y || clientY > surface.y + surface.height) {
    throw new Error(`SVG point (${x},${y}) maps outside the visible surface`)
  }
  await page.mouse.click(clientX, clientY)
}

async function svgPointForTextContent(needle: string): Promise<{ x: number; y: number }> {
  const found = await page.evaluate((wanted: string) => {
    const preview = document.querySelector('.vector-preview') as HTMLElement | null
    if (!preview) return null
    const svg = preview.querySelector('svg')
    if (!svg) return null
    const previewRect = preview.getBoundingClientRect()
    if (!(previewRect.width > 0 && previewRect.height > 0)) return null
    const candidates = Array.from(svg.querySelectorAll('tspan, text'))
    const matches = candidates.filter((el) => (el.textContent ?? '').includes(wanted))
    if (matches.length === 0) return null
    let best: Element | null = null
    let bestArea = Infinity
    for (const el of matches) {
      try {
        const r = (el as unknown as SVGElement).getBoundingClientRect()
        if (!(r.width > 0 && r.height > 0)) continue
        const area = r.width * r.height
        if (area < bestArea) {
          bestArea = area
          best = el
        }
      } catch {
        continue
      }
    }
    const target = (best ?? matches[0] ?? null) as unknown as SVGElement | null
    if (!target) return null
    try {
      const r = target.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) return null
      // Map the live client point back through the svg's own CTM so
      // preserveAspectRatio letterboxing never skews the click.
      const ctm = (svg as unknown as SVGSVGElement).getScreenCTM()
      if (!ctm) return null
      const inverse = ctm.inverse()
      const cx = r.x + r.width * 0.5
      const cy = r.y + r.height * 0.5
      const svgX = inverse.a * cx + inverse.c * cy + inverse.e
      const svgY = inverse.b * cx + inverse.d * cy + inverse.f
      if (!Number.isFinite(svgX) || !Number.isFinite(svgY)) return null
      return { svgX, svgY }
    } catch {
      return null
    }
  }, needle)
  if (!found || !Number.isFinite(found.svgX) || !Number.isFinite(found.svgY)) {
    throw new Error(`No rendered text found for ${needle}`)
  }
  return {
    x: Math.max(0, Math.min(480, found.svgX)),
    y: Math.max(0, Math.min(360, found.svgY)),
  }
}

async function openTextByContent(needle: string): Promise<string> {
  const pt = await svgPointForTextContent(needle)
  await clickSvgPoint(pt.x, pt.y)
  const overlay = page.locator('[data-inline-text-editor]')
  await overlay.waitFor({ state: 'visible', timeout: 10_000 })
  const textarea = overlay.locator('textarea')
  await textarea.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(
    () => document.activeElement === document.querySelector('[data-inline-text-editor] textarea'),
    null,
    { timeout: 10_000 },
  )
  return await textarea.inputValue()
}

async function commitWithEscape(): Promise<void> {
  const overlay = page.locator('[data-inline-text-editor]')
  if (!(await overlay.isVisible())) return
  const textarea = overlay.locator('textarea')
  await textarea.waitFor({ state: 'visible', timeout: 10_000 })
  const focused = await page.evaluate(
    () => document.activeElement === document.querySelector('[data-inline-text-editor] textarea'),
  )
  if (!focused) {
    await page.evaluate(() => {
      const node = document.querySelector('[data-inline-text-editor] textarea') as HTMLTextAreaElement | null
      node?.focus()
    })
  }
  await page.waitForFunction(
    () => document.activeElement === document.querySelector('[data-inline-text-editor] textarea'),
    null,
    { timeout: 10_000 },
  )
  await page.keyboard.press('Escape')
  await page.locator('[data-inline-text-editor]').waitFor({ state: 'hidden', timeout: 10_000 })
}

// The font-resolve in `prepareVectorInlineTextFont` is async: wait until the
// toolbar actually displays the seeded stack before driving a font change,
// otherwise an early change can predate the session baseline.
async function waitForVectorFontToolbar(value: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    (want: string) => (document.querySelector('[data-testid="vector-text-font"]') as HTMLSelectElement | null)?.value === want,
    value,
    { timeout },
  )
}

async function vectorFontToolbarState() {
  return await page.evaluate(() => {
    const select = document.querySelector('[data-testid="vector-text-font"]') as HTMLSelectElement | null
    const size = document.querySelector('[data-testid="vector-text-font-size"]') as HTMLInputElement | null
    if (!select || !size) throw new Error('Vector font controls not visible')
    return {
      value: select.value,
      selectedIndex: select.selectedIndex,
      shown: select.options[select.selectedIndex]?.text ?? null,
      count: select.options.length,
      size: size.value,
    }
  })
}

async function clickUndoOnce() {
  const buttons = page.getByRole('button', { name: 'Undo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) {
      await b.click()
      return
    }
  }
  throw new Error('No enabled visible Undo button')
}

async function clickRedoOnce() {
  const buttons = page.getByRole('button', { name: 'Redo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) {
      await b.click()
      return
    }
  }
  throw new Error('No enabled visible Redo button')
}

function stripFontAttrs(unit: string): string {
  return unit.replace(/\sfont-family="[^"]*"/, '').replace(/\sfont-size="[^"]*"/, '')
}

// The vector save path normalizes the root `<svg>` viewport to the content
// bbox on write (pre-existing behavior, unrelated to fonts): characters-only
// preservation is therefore compared with the root open tag stripped.
function withoutSvgRoot(svg: string): string {
  return svg.replace(/<svg[^>]*>/, '<svg>')
}

function unitFor(svg: string, text: string): string {
  const match = svg.match(new RegExp(`<text[^>]*>${text}<\\/text>`))?.[0] ?? ''
  if (!match) throw new Error(`Unit with text ${text} not found`)
  return match
}

describe('font dropdown on the real Editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
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
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByTestId('project-file-input').setInputFiles({
      name: 'font-dropdown-ui.sb3',
      mimeType: 'application/x.scratch.sb3',
      buffer: buildSb3(),
    })
    await page.waitForFunction(
      () =>
        (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 3,
      null,
      { timeout: 20_000 },
    )
    await ensureVectorMode()
    await selectCostumeByName('fonts-9')
    await ensureVectorMode()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('exposes all 14 options with verbatim values/labels and 40px defaults', async () => {
    await clickTextTool()
    const state = await vectorFontToolbarState()
    expect(state.count).toBe(14)
    expect(state.size).toBe('40')
    const options = await page.evaluate(() => {
      const select = document.querySelector('[data-testid="vector-text-font"]') as HTMLSelectElement | null
      if (!select) throw new Error('vector font select missing')
      return Array.from(select.options).map((o) => ({ label: o.text, value: o.value }))
    })
    // First 9 are the Scratch reference fonts in dropdown order, byte-exact.
    for (let i = 0; i < SCRATCH_FONTS.length; i += 1) {
      expect(options[i]).toEqual({ label: SCRATCH_FONTS[i]!.label, value: SCRATCH_FONTS[i]!.value })
    }
    // Then the 5 pre-existing system additions (strict additions, kept).
    for (let i = 0; i < SYSTEM_STACKS.length; i += 1) {
      expect(options[9 + i]).toEqual({ label: SYSTEM_STACKS[i]!.label, value: SYSTEM_STACKS[i]!.value })
    }
    // CJK rows render their localized labels.
    expect(options.map((o) => o.label)).toEqual(expect.arrayContaining(['中文', '日本語', '한국어']))
    // Bitmap toolbar mirrors the same list with a 40px default over 8..200.
    // NOTE: use the blank costume for the mode round-trip: converting to
    // bitmap rasterizes vector text, which would destroy the fonts-9 seeds.
    await selectCostumeByName('blank')
    await ensureVectorMode()
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-tool-text').waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByTestId('bitmap-tool-text').click()
    await page.getByTestId('bitmap-text-font').waitFor({ state: 'visible', timeout: 15_000 })
    const bitmap = await page.evaluate(() => {
      const select = document.querySelector('[data-testid="bitmap-text-font"]') as HTMLSelectElement | null
      const size = document.querySelector('[data-testid="bitmap-text-font-size"]') as HTMLInputElement | null
      if (!select || !size) throw new Error('bitmap font controls missing')
      return {
        count: select.options.length,
        first: select.options[0]?.value ?? null,
        cjk: (select.options[6] as HTMLOptionElement | undefined)?.value ?? null,
        last: (select.options[13] as HTMLOptionElement | undefined)?.value ?? null,
        size: size.value,
        min: size.min,
        max: size.max,
      }
    })
    expect(bitmap.count).toBe(14)
    expect(bitmap.first).toBe('Sans Serif')
    expect(bitmap.cjk).toBe('"Microsoft YaHei", "微软雅黑", STXihei, "华文细黑"')
    expect(bitmap.last).toBe('"Arial Narrow", Arial, sans-serif')
    expect(bitmap.size).toBe('40')
    expect(bitmap.min).toBe('8')
    expect(bitmap.max).toBe('200')
    // Back to vector for the remaining suites (fonts-9 stays pristine: the
    // bitmap round-trip above ran on the blank costume).
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 })
    await selectCostumeByName('fonts-9')
    await ensureVectorMode()
  }, 90_000)

  it('persists every one of the 9 reference fonts byte-exact (font+size only), with Undo/Redo', async () => {
    await selectCostumeByName('fonts-9')
    await ensureVectorMode()
    await waitForPreviewText('font-SANS_SERIF')
    await clickTextTool()
    await ensureSeedsVisible(SCRATCH_FONTS.map((e) => `font-${e.id}`))
    const expected = SCRATCH_FONTS.map((e) => e.value)
    for (let i = 0; i < SCRATCH_FONTS.length; i += 1) {
      const entry = SCRATCH_FONTS[i]!
      const next = SCRATCH_FONTS[(i + 1) % SCRATCH_FONTS.length]!
      const needle = `font-${entry.id}`
      const draft = await openTextByContent(needle)
      expect(draft).toBe(needle)
      // The toolbar syncs the seeded stack verbatim (display only).
      await waitForVectorFontToolbar(entry.value)
      const shown = await vectorFontToolbarState()
      expect(shown.value).toBe(entry.value)
      expect(shown.shown).toBe(entry.label)
      // Explicit user change: next reference font + a distinct size.
      const newSize = String(30 + i)
      await page.getByTestId('vector-text-font').selectOption(next.value)
      await page.getByTestId('vector-text-font-size').fill(newSize)
      await page.locator('[data-inline-text-editor] textarea').click()
      const before = await costumeText('Sprite1', 0)
      await commitWithEscape()
      const after = await waitForTextChange('Sprite1', 0, before)
      const unit = unitFor(after, needle)
      // Raw bytes carry XML-escaped quotes (`&quot;`); the DOM parses them
      // back to the verbatim stack (asserted toolbar-known on reopen above).
      const escapedFamily = next.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      expect(unit).toContain(`font-family="${escapedFamily}"`)
      expect(unit).toContain(`font-size="${newSize}"`)
      // Only the font attributes changed: fill/weight/transform survive.
      expect(stripFontAttrs(unit)).toBe(stripFontAttrs(unitFor(before, needle)))
      expect(unit).toContain(`fill="${PALETTE[i % PALETTE.length]}"`)
      if (i === 0) {
        expect(unit).toContain('font-weight="900"')
        expect(unit).toContain('rotate(-8 240 30)')
      }
      expected[i] = next.value
      // One Undo restores the pre-edit bytes; one Redo restores the change.
      await clickUndoOnce()
      expect(await waitForTextChange('Sprite1', 0, after)).toBe(before)
      await clickRedoOnce()
      expect(await waitForTextChange('Sprite1', 0, before)).toBe(after)
    }
    // All nine edits landed; the file still holds nine text units.
    const final = await costumeText('Sprite1', 0)
    expect((final.match(/<text[\s>]/g) ?? []).length).toBe(9)
    for (const value of expected) {
      expect(final).toContain(`font-family="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    }
  }, 420_000)

  it('keeps unknown/tricky stacks byte-identical on characters-only edits, overlay stays safe', async () => {
    await selectCostumeByName('unknown-tricky')
    await ensureVectorMode()
    await waitForPreviewText('inherit-unknown')
    await clickTextTool()
    await ensureSeedsVisible(['inherit-unknown', 'tricky-quotes', 'style-stack', 'shorthand-stack', 'injection-stack'])
    // Inherited unknown stack: shown verbatim, never blank.
    const draft = await openTextByContent('inherit-unknown')
    expect(draft).toBe('inherit-unknown')
    await waitForVectorFontToolbar(UNKNOWN_STACK)
    const toolbar = await vectorFontToolbarState()
    expect(toolbar.value).toBe(UNKNOWN_STACK)
    expect(toolbar.shown).toBe(UNKNOWN_STACK)
    expect(toolbar.selectedIndex).toBeGreaterThanOrEqual(0)
    // Characters only: no font UI touched.
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    const before = await costumeText('Sprite1', 1)
    await commitWithEscape()
    const edited = await waitForTextChange('Sprite1', 1, before)
    expect(edited).toContain('inherit-unknown!')
    // The only byte change is the added character: inheritance, size,
    // weight and transform survive untouched (root viewport aside: the
    // save path normalizes it to the content bbox, pre-existing behavior).
    expect(withoutSvgRoot(edited).replace('inherit-unknown!', 'inherit-unknown')).toBe(withoutSvgRoot(before))
    // Quoted unknown stack resolves through the style path verbatim.
    const draftQuotes = await openTextByContent('tricky-quotes')
    expect(draftQuotes).toBe('tricky-quotes')
    await waitForVectorFontToolbar(QUOTE_STACK)
    const quotesToolbar = await vectorFontToolbarState()
    expect(quotesToolbar.value).toBe(QUOTE_STACK)
    await page.keyboard.press('End')
    await page.keyboard.type('?')
    const beforeQuotes = await costumeText('Sprite1', 1)
    await commitWithEscape()
    const afterQuotes = await waitForTextChange('Sprite1', 1, beforeQuotes)
    expect(afterQuotes).toContain('tricky-quotes?')
    expect(withoutSvgRoot(afterQuotes).replace('tricky-quotes?', 'tricky-quotes')).toBe(withoutSvgRoot(beforeQuotes))
    // Injection-shaped stack: the overlay opens, the preview style cannot be
    // hijacked into extra declarations, and the commit preserves bytes.
    const draftInjection = await openTextByContent('injection-stack')
    expect(draftInjection).toBe('injection-stack')
    const overlaySafe = await page.evaluate(() => {
      const overlay = document.querySelector('[data-inline-text-editor]') as HTMLElement | null
      if (!overlay) throw new Error('overlay missing')
      // A smuggled `color:red` must not parse as a real declaration.
      const color = (overlay as unknown as { style: CSSStyleDeclaration }).style.color
      return { color, hasOverlay: true }
    })
    expect(overlaySafe.color).toBe('')
    await page.keyboard.press('End')
    await page.keyboard.type('.')
    const beforeInjection = await costumeText('Sprite1', 1)
    await commitWithEscape()
    const afterInjection = await waitForTextChange('Sprite1', 1, beforeInjection)
    expect(withoutSvgRoot(afterInjection).replace('injection-stack.', 'injection-stack')).toBe(withoutSvgRoot(beforeInjection))
    // style-attribute and font-shorthand families resolve + preserve.
    const draftStyle = await openTextByContent('style-stack')
    expect(draftStyle).toBe('style-stack')
    await waitForVectorFontToolbar(`'Style Stack', serif`)
    const beforeStyle = await costumeText('Sprite1', 1)
    await commitWithEscape()
    // Reopen-without-changes is a no-op (no bytes, no history entry).
    await page.waitForTimeout(800)
    expect(await costumeText('Sprite1', 1)).toBe(beforeStyle)
    const draftShorthand = await openTextByContent('shorthand-stack')
    expect(draftShorthand).toBe('shorthand-stack')
    await waitForVectorFontToolbar('CustomShorthand, serif')
    await commitWithEscape()
    await page.waitForTimeout(800)
    expect(await costumeText('Sprite1', 1)).toBe(beforeStyle)
    // One Undo reaches past the no-ops to the injection edit.
    await clickUndoOnce()
    expect(await waitForTextChange('Sprite1', 1, beforeStyle)).toBe(beforeInjection)
    await clickRedoOnce()
    expect(await waitForTextChange('Sprite1', 1, beforeInjection)).toBe(beforeStyle)
  }, 300_000)

  it('inserts with toolbar font + 40 default + 46.15 leading, measures real text, defers IME', async () => {
    await selectCostumeByName('blank')
    await ensureVectorMode()
    await clickTextTool()
    // New-text geometry matches the reference (40px); set explicitly since
    // earlier suites leave the shared toolbar at their own sizes.
    await page.getByTestId('vector-text-font-size').fill('40')
    await page.getByTestId('vector-text-font').selectOption('Pixel')
    // Free point inside the currently visible band (per-costume pan/zoom):
    // center-right of the band, clear of the left-side green rect.
    const vr = await visibleSvgRect()
    const ix = vr.x + vr.width * 0.62
    const iy = vr.y + vr.height * 0.55
    await clickSvgPoint(ix, iy)
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
    const emptyDraft = await page.locator('[data-inline-text-editor] textarea').inputValue()
    expect(emptyDraft).toBe('')
    await page.keyboard.type('hello')
    await page.keyboard.press('Enter')
    await page.keyboard.type('world')
    const before = await costumeText('Sprite1', 2)
    await commitWithEscape()
    const inserted = await waitForTextChange('Sprite1', 2, before)
    expect(inserted).toContain('font-family="Pixel"')
    expect(inserted).toContain('font-size="40"')
    // Reference leading: 46.15 at 40px lands on the second tspan row.
    expect(inserted).toContain('dy="46.15"')
    // Real DOM metrics: the committed rows have a genuine ink box.
    const metrics = await page.evaluate(() => {
      const preview = document.querySelector('.vector-preview') as HTMLElement | null
      const svg = preview?.querySelector('svg')
      if (!svg) throw new Error('preview svg missing')
      const rows = Array.from(svg.querySelectorAll('tspan'))
      const boxes = rows.map((el) => {
        const r = (el as unknown as SVGElement).getBoundingClientRect()
        return { width: r.width, height: r.height }
      })
      // CJK stack measures on canvas with the literal stack (fallback ok).
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      ctx.font = '40px "Microsoft YaHei", "微软雅黑", STXihei, "华文细黑"'
      const cjk = ctx.measureText('日本語テスト中文한국어').width
      return { rows: boxes.length, widths: boxes.map((b) => b.width), heights: boxes.map((b) => b.height), cjk }
    })
    expect(metrics.rows).toBe(2)
    for (const w of metrics.widths) expect(w).toBeGreaterThan(0)
    for (const h of metrics.heights) expect(h).toBeGreaterThan(0)
    expect(metrics.cjk).toBeGreaterThan(0)
    // IME owns Escape mid-composition: no commit, no overlay close.
    const redraft = await openTextByContent('hello')
    expect(redraft).toContain('hello')
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-inline-text-editor] textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('overlay textarea missing')
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }))
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    expect(await page.locator('[data-inline-text-editor]').isVisible()).toBe(true)
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-inline-text-editor] textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('overlay textarea missing')
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true }))
    })
    await commitWithEscape()
    // RTL insert anchors at its right edge: replace the whole draft so the
    // first-strong character is RTL (appending to LTR text stays LTR).
    await clickTextTool()
    await page.getByTestId('vector-text-font-size').fill('24')
    const vr2 = await visibleSvgRect()
    await clickSvgPoint(vr2.x + vr2.width * 0.8, vr2.y + vr2.height * 0.8)
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
    await page.keyboard.press('ControlOrMeta+a')
    const rtlBefore = await costumeText('Sprite1', 2)
    await page.keyboard.type('שלום')
    await commitWithEscape()
    const rtl = await waitForTextChange('Sprite1', 2, rtlBefore)
    expect(rtl).toContain('שלום')
    expect(rtl).toContain('direction="rtl"')
    expect(rtl).toContain('text-anchor="start"')
  }, 300_000)

  it('commits bitmap text through the real overlay and restores it with Undo', async () => {
    await selectCostumeByName('blank')
    await ensureVectorMode()
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    // The font section only renders while the bitmap text tool is active
    // (default tool is brush): activate it first so the test is independent
    // of suite order.
    await page.getByTestId('bitmap-tool-text').waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByTestId('bitmap-tool-text').click()
    await page.getByTestId('bitmap-text-font').waitFor({ state: 'visible', timeout: 15_000 })
    // Shared toolbar state persists across suites (the insert suite leaves
    // size 24): user input sets it back; the 40px default itself is asserted
    // on fresh load in the first suite.
    await page.getByTestId('bitmap-text-font-size').fill('40')
    const size = await page.getByTestId('bitmap-text-font-size').inputValue()
    expect(size).toBe('40')
    await page.getByTestId('bitmap-text-font').selectOption('Marker')
    const selected = await page.getByTestId('bitmap-text-font').inputValue()
    expect(selected).toBe('Marker')
    // Click the bitmap surface: the inline overlay opens for the draft.
    const surface = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!surface) throw new Error('Missing paint surface bounds')
    await page.mouse.click(surface.x + surface.width * 0.6, surface.y + surface.height * 0.5)
    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible', timeout: 10_000 })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible', timeout: 10_000 })
    // The overlay focuses asynchronously (rAF + 50ms fallback): typing
    // before the caret lands is lost to <body> and commits an empty draft.
    await page.waitForFunction(
      () => document.activeElement === document.querySelector('[data-inline-text-editor] textarea'),
      null,
      { timeout: 10_000 },
    )
    await page.keyboard.type('bmp-あいう')
    expect(await textarea.inputValue()).toBe('bmp-あいう')
    const before = await costumeDigest('Sprite1', 2)
    await commitWithEscape()
    const after = await waitForDigestChange('Sprite1', 2, before)
    expect(after).not.toEqual(before)
    // Real raster ink landed on the bitmap canvas.
    const inked = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
      if (!canvas) throw new Error('bitmap canvas missing')
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2d context missing')
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i] ?? 255
        const g = data[i + 1] ?? 255
        const b = data[i + 2] ?? 255
        const a = data[i + 3] ?? 0
        if (a > 8 && (r < 245 || g < 245 || b < 245)) ink += 1
      }
      return ink
    })
    expect(inked).toBeGreaterThan(0)
    await clickUndoOnce()
    expect(await waitForDigestChange('Sprite1', 2, after)).toEqual(before)
    await clickRedoOnce()
    expect(await waitForDigestChange('Sprite1', 2, before)).toEqual(after)
  }, 180_000)
})
