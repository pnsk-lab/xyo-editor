import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Font audit for the legacy click-stamp paths in Editor.svelte.
//
// Call-path verdict (verified by reading Editor.svelte + BitmapEditor.svelte):
// - Bitmap canvas clicks with the text tool NEVER reach `drawBitmapText`
//   (BitmapEditor `handleCanvasMouseDown` opens the inline overlay and returns
//   before `beginBitmapPaint`). `drawBitmapText` (brushSize-derived size,
//   fixed Arial) is a dead legacy path: documented in code, intentionally left
//   unmodified. The modern bitmap inline commit (`commitBitmapInlineText`)
//   already uses the toolbar font/size.
// - Vector canvas clicks with the text tool NEVER reach `saveVectorCostume`
//   (the inline editor opens instead). But `saveVectorCostume` IS reachable
//   with `vectorShape === 'text'` through the visible `Save vector` button
//   (`data-testid="save-vector-costume"`) after picking the Text tool, and it
//   stamped `font-family="Sans Serif" font-size="40"` with size-24 gradient
//   bounds regardless of the toolbar. That reachable path is fixed in
//   Editor.svelte and covered below against REAL VM bytes.
//
// Coverage: Japanese + Marker stacks, sizes 40/32, rasterized text pixels,
// gradient bounds + transparent-end alpha, IME deferral, double-stamp guard
// while the inline editor is open, and exact Undo/Redo with no stale bytes.
// Port 4388 is unused by the other browser suites.
const root = join(import.meta.dir, '..')
const PORT = 4388
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH =
  process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const JAPANESE_STACK =
  '"ヒラギノ角ゴ Pro W3", "Hiragino Kaku Gothic Pro", Osaka, "メイリオ", Meiryo, "ＭＳ Ｐゴシック", "MS PGothic"'

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
  const stamp = add(BLANK_SVG)
  const guard = add(BLANK_SVG)
  const bitmap = add(BLANK_SVG)
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
        costumes: [{ ...costume(stamp, 'stage-stamp'), rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(stamp, 'stamp-blank'), costume(guard, 'guard-blank'), costume(bitmap, 'bitmap-blank')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'text-stamp-audit' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
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

async function costumeDigest(target: string, index: number): Promise<string> {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    return `${(bytes as Uint8Array).length}:${sum}`
  }, { target, index })
}

async function waitForTextChange(target: string, index: number, before: string, timeout = 15_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const got = await costumeText(target, index)
    if (got !== before) return got
    if (Date.now() - start > timeout) throw new Error(`text change timeout ${target}[${index}]`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForDigestChange(target: string, index: number, before: string, timeout = 20_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const got = await costumeDigest(target, index)
    if (got !== before) return got
    if (Date.now() - start > timeout) throw new Error(`digest change timeout ${target}[${index}]`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function selectCostumeByName(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).click()
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 15_000 })
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
  await page.locator('select[aria-label="Vector font"]').waitFor({ state: 'visible', timeout: 10_000 })
}

async function clickSvgPoint(x: number, y: number) {
  const box = await page.locator('.vector-preview').boundingBox()
  if (!box) throw new Error('Missing vector preview bounds')
  const surface = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!surface) throw new Error('Missing paint surface bounds')
  const clientX = box.x + (x / 480) * box.width
  const clientY = box.y + (y / 360) * box.height
  await page.mouse.click(clientX, clientY)
}

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

async function waitForTextareaFocus(timeout = 10_000) {
  await page.waitForFunction(
    () => document.activeElement === document.querySelector('[data-inline-text-editor] textarea'),
    null,
    { timeout },
  )
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
  await waitForTextareaFocus()
  await page.keyboard.press('Escape')
  await page.locator('[data-inline-text-editor]').waitFor({ state: 'hidden', timeout: 10_000 })
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

async function costumeLastTextFont(target: string, index: number): Promise<{ family: string | null; size: string | null; body: string | null }> {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
    const texts = doc.getElementsByTagName('text')
    const last = texts[texts.length - 1]
    return {
      family: last?.getAttribute('font-family'),
      size: last?.getAttribute('font-size'),
      body: last?.textContent ?? null,
    }
  }, { target, index })
}

async function rasterInkCount(svgText: string): Promise<number> {
  return await page.evaluate(async (xml: string) => {
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }))
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('raster load failed'))
        img.src = url
        setTimeout(() => reject(new Error('raster timeout')), 8000)
      })
      const c = document.createElement('canvas')
      c.width = 480
      c.height = 360
      const g = c.getContext('2d')!
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, 480, 360)
      g.drawImage(img, 0, 0, 480, 360)
      const data = g.getImageData(0, 0, 480, 360).data
      let inked = 0
      for (let k = 0; k < data.length; k += 16) {
        if (!((data[k] ?? 255) > 245 && (data[k + 1] ?? 255) > 245 && (data[k + 2] ?? 255) > 245)) inked += 1
      }
      return inked
    } finally {
      URL.revokeObjectURL(url)
    }
  }, svgText)
}

describe('vector text stamp font audit (real Editor + VM)', () => {
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
      name: 'text-stamp-audit.sb3',
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
    await selectCostumeByName('stamp-blank')
    await ensureVectorMode()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('stamps Marker/40 through the Save button with toolbar font and real pixels', async () => {
    const before = await costumeText('Sprite1', 0)
    expect(before).not.toContain('<text')
    await clickTextTool()
    await page.locator('select[aria-label="Vector font"]').selectOption('Marker')
    await page.locator('input[aria-label="Vector font size"]').fill('40')
    await page.locator('input[aria-label="Vector text"][title]').fill('MarkerTest')
    await page.getByTestId('save-vector-costume').click()
    const after = await waitForTextChange('Sprite1', 0, before)
    // Toolbar font wins over the legacy hardcoded Sans Serif/40.
    expect(after).toContain('font-family="Marker"')
    expect(after).toContain('font-size="40"')
    expect(after).toContain('>MarkerTest</text>')
    // Real rasterized pixels (not just markup strings).
    expect(await rasterInkCount(after)).toBeGreaterThan(0)
    // Exact Undo/Redo: one step each way, bytes byte-identical.
    await clickUndoOnce()
    expect(await waitForTextChange('Sprite1', 0, after)).toBe(before)
    await clickRedoOnce()
    expect(await waitForTextChange('Sprite1', 0, before)).toBe(after)
  }, 90_000)

  it('stamps Japanese/32 with size-derived gradient bounds and transparent-end alpha', async () => {
    const before = await costumeText('Sprite1', 0)
    expect(before).toContain('MarkerTest')
    await clickTextTool()
    await page.locator('select[aria-label="Vector font"]').selectOption(JAPANESE_STACK)
    await page.locator('input[aria-label="Vector font size"]').fill('32')
    await page.locator('input[aria-label="Vector text"][title]').fill('日本語テスト')
    await page.locator('select[aria-label="Vector paint style"]').selectOption('horizontal')
    await page.getByRole('button', { name: 'Transparent secondary' }).click()
    await page.getByTestId('save-vector-costume').click()
    const after = await waitForTextChange('Sprite1', 0, before)
    // Decoded attribute comparison: the serializer entity-escapes the CJK
    // stack's double quotes (`&quot;`), so compare through the DOM.
    const font = await costumeLastTextFont('Sprite1', 0)
    expect(font.family).toBe(JAPANESE_STACK)
    expect(font.size).toBe('32')
    expect(font.body).toBe('日本語テスト')
    // userSpaceOnUse ramp over the size-32 text bounds: 6 chars at 32px,
    // width 105.6 from x=192 (center 240), not the legacy size-24 box
    // (x1=204 / x2=283.2).
    expect(after).toContain('gradientUnits="userSpaceOnUse"')
    expect(after).toContain('x1="192"')
    expect(after).toContain('x2="297.6"')
    // Transparent end keeps RGB with alpha 0 (opacity-only fade).
    expect(after).toContain('stop-opacity="0"')
    expect(await rasterInkCount(after)).toBeGreaterThan(0)
    await clickUndoOnce()
    expect(await waitForTextChange('Sprite1', 0, after)).toBe(before)
    await clickRedoOnce()
    expect(await waitForTextChange('Sprite1', 0, before)).toBe(after)
  }, 120_000)

  it('never double-stamps while the inline editor is open and defers Escape to the IME', async () => {
    await selectCostumeByName('guard-blank')
    await ensureVectorMode()
    const pristine = await costumeText('Sprite1', 1)
    expect(pristine).not.toContain('<text')
    await clickTextTool()
    await page.locator('input[aria-label="Vector text"][title]').fill('StampWhileOpen')
    const vr = await visibleSvgRect()
    const ix = vr.x + vr.width * 0.55
    const iy = vr.y + vr.height * 0.5
    await clickSvgPoint(ix, iy)
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
    await waitForTextareaFocus()
    expect(await page.locator('[data-inline-text-editor] textarea').inputValue()).toBe('')
    // IME owns Escape mid-composition: no commit, overlay stays open.
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
    // Save while the draft is open must not stamp a second text node, and the
    // open draft must survive (focus may move to the button, so refocus the
    // textarea before typing — a click inside the overlay never commits).
    await page.getByTestId('save-vector-costume').click()
    await page.waitForTimeout(800)
    expect(await page.locator('[data-inline-text-editor]').isVisible()).toBe(true)
    await page.locator('[data-inline-text-editor] textarea').click()
    await waitForTextareaFocus()
    await page.keyboard.type('Guarded')
    await commitWithEscape()
    const after = await waitForTextChange('Sprite1', 1, pristine)
    expect(after).toContain('Guarded')
    expect(after).not.toContain('StampWhileOpen')
    expect(after.split('<text').length - 1).toBe(1)
    // Exactly one Undo entry for the single committed text.
    await clickUndoOnce()
    expect(await waitForTextChange('Sprite1', 1, after)).toBe(pristine)
    await clickRedoOnce()
    expect(await waitForTextChange('Sprite1', 1, pristine)).toBe(after)
  }, 120_000)

  it('commits bitmap inline text with toolbar font pixels and exact undo/redo', async () => {
    await selectCostumeByName('bitmap-blank')
    await ensureVectorMode()
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 20_000 })
    const before = await costumeDigest('Sprite1', 2)
    await page.getByTestId('bitmap-tool-text').click()
    await page.locator('select[aria-label="Text font"]').selectOption(JAPANESE_STACK)
    await page.locator('input[aria-label="Text font size"]').fill('40')
    await page.getByTestId('bitmap-editor-canvas').click()
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
    await waitForTextareaFocus()
    await page.keyboard.type('日本語あ')
    await commitWithEscape()
    const after = await waitForDigestChange('Sprite1', 2, before)
    expect(after).not.toBe(before)
    // Real raster ink on the bitmap canvas (font actually resolved).
    const inked = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
      if (!canvas) throw new Error('bitmap canvas missing')
      const g = canvas.getContext('2d')
      if (!g) throw new Error('no 2d context')
      const data = g.getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let k = 0; k < data.length; k += 32) {
        if ((data[k + 3] ?? 0) > 8) ink += 1
      }
      return ink
    })
    expect(inked).toBeGreaterThan(0)
    await clickUndoOnce()
    expect(await waitForDigestChange('Sprite1', 2, after)).toBe(before)
    await clickRedoOnce()
    expect(await waitForDigestChange('Sprite1', 2, before)).toBe(after)
  }, 120_000)
})
