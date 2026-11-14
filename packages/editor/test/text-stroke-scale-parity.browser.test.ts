import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Text stroke-width parity: new no-transform text stores `UI/2` (visual
// `UI/2` like Scratch PointText `UI` verbatim + `scale(0.5)` geometry);
// scaled/complex text protects to verbatim (Scratch Paper-local parity, so
// `<text stroke-width="4" transform="scale(0.5)">` reads UI `4`, not `8`).
//
// Real Chromium (CHROME_BIN), real Editor+VM, real DOMParser. Covers:
// pure math + `isSimpleTextScale`, selection reads (simple/scale/rotate/
// translate/style-transform/tspan inheritance/group/mixed), new-text
// create/preview/selection/UI/paint-preserve/stage-px/UndoRedo, import
// bytes untouched + same-value no-op + explicit edits with transform
// preservation.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4479'
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByRole('application', { name: 'Costume paint canvas' }).waitFor({ state: 'visible' })
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible' })
}

async function vectorObjectCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-vector-selection-outline]').length)
}

async function blankVectorCanvas() {
  await page.getByRole('button', { name: 'Select', exact: true }).first().click()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const surface = page.getByRole('application', { name: 'Costume paint canvas' })
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box.x + 20, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const del = page.getByRole('button', { name: 'Delete selection' }).first()
    if (await del.isEnabled().catch(() => false)) {
      await del.click()
      await page.waitForTimeout(600)
    }
    if ((await vectorObjectCount()) === 0) break
  }
  expect(await vectorObjectCount()).toBe(0)
}

async function previewInner(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function lastTextStrokeWidth(): Promise<number> {
  return await page.evaluate(() => {
    const svg = document.querySelector('.vector-preview svg')
    if (!svg) throw new Error('Missing vector preview svg')
    const texts = Array.from(svg.querySelectorAll('text'))
    if (texts.length === 0) throw new Error('No text element')
    const last = texts[texts.length - 1]!
    return parseFloat(last.getAttribute('stroke-width') ?? 'NaN')
  })
}

async function setStrokeWidth(value: string) {
  const input = page.getByLabel('Stroke width', { exact: true }).first()
  await input.fill(value)
  await input.press('Tab')
}

describe('text stroke-width scale parity in real Chromium', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4479', '--strictPort'], {
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
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('pure converters halve/double and gate only on provable scale-1', async () => {
    const result = await page.evaluate(async () => {
      const scale = await import(/* @vite-ignore */ '/src/features/costumes/vector-stroke-scale.ts')
      const probe = (transform: string | null, parentTransform: string | null, style?: string | null) => {
        const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml')
        const svg = doc.documentElement
        let parent: Element | null = null
        if (parentTransform !== null) {
          parent = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
          parent.setAttribute('transform', parentTransform)
          svg.appendChild(parent)
        }
        const text = doc.createElementNS('http://www.w3.org/2000/svg', 'text')
        if (transform !== null) text.setAttribute('transform', transform)
        if (style !== undefined && style !== null) text.setAttribute('style', style)
        ;(parent ?? svg).appendChild(text)
        return scale.isSimpleTextScale(text)
      }
      return {
        halve4: scale.vectorTextSvgForUi(4),
        halve10: scale.vectorTextSvgForUi(10),
        double4: scale.vectorTextUiForSvg(4),
        double5: scale.vectorTextUiForSvg(5),
        elemSimple: scale.vectorTextUiForSvgElement(4),
        none: probe(null, null),
        translate: probe('translate(30 12)', null),
        rotate: probe('rotate(8 200 150)', null),
        both: probe('translate(30 12) rotate(8 200 150)', null),
        scale1: probe('scale(1)', null),
        scaleHalf: probe('scale(0.5)', null),
        scale2: probe('scale(2)', null),
        matrix: probe('matrix(1 0 0 1 10 20)', null),
        skew: probe('skewX(10)', null),
        styleTransform: probe(null, null, 'transform: translate(10px, 20px)'),
        ancestorScale: probe(null, 'scale(0.5)'),
        ancestorTranslate: probe(null, 'translate(10 20)'),
        readSimple: scale.vectorTextUiForSvgElement(4, (() => {
          const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml')
          const text = doc.createElementNS('http://www.w3.org/2000/svg', 'text')
          doc.documentElement.appendChild(text)
          return text
        })()),
        readScaled: scale.vectorTextUiForSvgElement(4, (() => {
          const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml')
          const text = doc.createElementNS('http://www.w3.org/2000/svg', 'text')
          text.setAttribute('transform', 'scale(0.5)')
          doc.documentElement.appendChild(text)
          return text
        })()),
        writeSimple: scale.vectorTextSvgForUiElement(4, (() => {
          const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml')
          return doc.createElementNS('http://www.w3.org/2000/svg', 'text')
        })()),
        writeScaled: scale.vectorTextSvgForUiElement(8, (() => {
          const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml')
          const text = doc.createElementNS('http://www.w3.org/2000/svg', 'text')
          text.setAttribute('transform', 'scale(0.5)')
          return text
        })()),
      }
    })
    // Pure converters: /2 and *2 (UI 4 -> SVG 2, SVG 5 -> UI 10).
    expect(result.halve4).toBeCloseTo(2, 9)
    expect(result.halve10).toBeCloseTo(5, 9)
    expect(result.double4).toBeCloseTo(8, 9)
    expect(result.double5).toBeCloseTo(10, 9)
    expect(result.elemSimple).toBeCloseTo(8, 9)
    // Only provable scale-1 passes.
    expect(result.none).toBe(true)
    expect(result.translate).toBe(true)
    expect(result.rotate).toBe(true)
    expect(result.both).toBe(true)
    expect(result.scale1).toBe(true)
    expect(result.scaleHalf).toBe(false)
    expect(result.scale2).toBe(false)
    expect(result.matrix).toBe(false)
    expect(result.skew).toBe(false)
    expect(result.styleTransform).toBe(false)
    expect(result.ancestorScale).toBe(false)
    expect(result.ancestorTranslate).toBe(true)
    // Element-aware wrappers: simple *2, scaled verbatim (no forced 8).
    expect(result.readSimple).toBeCloseTo(8, 9)
    expect(result.readScaled).toBeCloseTo(4, 9)
    expect(result.writeSimple).toBeCloseTo(2, 9)
    expect(result.writeScaled).toBeCloseTo(8, 9)
  }, 60_000)

  it('selection reads: simple *2, scale(.5) verbatim, tspan/group/mixed protection', async () => {
    const result = await page.evaluate(async () => {
      const style = await import(/* @vite-ignore */ '/src/features/costumes/vector-selection-style.ts')
      const read = (svgInner: string, selector = 'text') => {
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg">${svgInner}</svg>`,
          'image/svg+xml',
        )
        const element = doc.querySelector(selector) as unknown as Parameters<typeof style.readEffectiveStrokeWidth>[0]
        if (!element) throw new Error(`missing ${selector}`)
        return style.readEffectiveStrokeWidth(element)
      }
      const MIXED = 'xyo-mixed-sentinel'
      const normalize = (value: unknown) => (value === (style as unknown as { PAINT_MIXED: unknown }).PAINT_MIXED ? MIXED : value)
      return {
        simple: normalize(read(`<text stroke-width="4">hi</text>`)),
        scaled: normalize(read(`<text stroke-width="4" transform="scale(0.5)">hi</text>`)),
        rotate: normalize(read(`<text stroke-width="2" transform="translate(30 12) rotate(8 200 150)">hi</text>`)),
        styleTransform: normalize(read(`<text stroke-width="4" style="transform: translate(10px, 10px)">hi</text>`)),
        tspanInherit: normalize(read(
          `<g stroke-width="3"><text>hi<tspan>row</tspan></text></g>`,
          'text',
        )),
        tspanChildIgnored: normalize(read(
          `<text stroke-width="2">hi<tspan stroke-width="9">row</tspan></text>`,
        )),
        groupConsensus: normalize(read(
          `<g><text stroke-width="2">a</text><text stroke-width="2">b</text></g>`,
          'g',
        )),
        groupMixed: normalize(read(
          `<g><text stroke-width="2">a</text><text stroke-width="4">b</text></g>`,
          'g',
        )),
        groupScaled: normalize(read(
          `<g transform="scale(0.5)"><text stroke-width="4">hi</text></g>`,
          'text',
        )),
        groupTranslate: normalize(read(
          `<g transform="translate(10 20)"><text stroke-width="4">hi</text></g>`,
          'text',
        )),
      }
    })
    // Simple chain doubles; translate/rotate-only doubles too.
    expect(result.simple).toBeCloseTo(8, 9)
    expect(result.rotate).toBeCloseTo(4, 9)
    expect(result.groupTranslate).toBeCloseTo(8, 9)
    // Scratch `scale(0.5)` bytes protect to verbatim (UI 4, never forced 8).
    expect(result.scaled).toBeCloseTo(4, 9)
    expect(result.styleTransform).toBeCloseTo(4, 9)
    expect(result.groupScaled).toBeCloseTo(4, 9)
    // tspan rows inherit the text width; a tspan child's own width never leaks up.
    expect(result.tspanInherit).toBeCloseTo(6, 9)
    expect(result.tspanChildIgnored).toBeCloseTo(4, 9)
    // Groups: consensus doubles per-child, disagreement is MIXED.
    expect(result.groupConsensus).toBeCloseTo(4, 9)
    expect(result.groupMixed).toBe('xyo-mixed-sentinel')
  }, 60_000)

  it('real Editor: new text UI4 stores SVG2, selects UI4, stage ~2px, Undo/Redo + paint preserve', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    await blankVectorCanvas()
    await page.getByLabel('Paint color', { exact: true }).first().fill('#ff0000')
    // TEXT tool disables the stroke input by reference parity (brush/text/fill
    // use their own size), so stage UI 4 while Select is active, then open text.
    await setStrokeWidth('4')
    await page.getByTestId('vector-shape-text').last().click()
    const baseline = await vectorObjectCount()
    const surface = page.getByRole('application', { name: 'Costume paint canvas' })
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.keyboard.type('hello')
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-vector-selection-outline]').length > count,
      baseline as unknown as undefined,
      { timeout: 15_000 },
    )
    // Commit stores UI/2 with no transform on the text itself (visual parity:
    // 2 stage px). Wrapper <g transform> from the Paper import is unrelated.
    expect(await lastTextStrokeWidth()).toBeCloseTo(2, 9)
    const textOuter = await page.evaluate(() => document.querySelector('.vector-preview svg text')?.outerHTML ?? '')
    expect(textOuter).not.toContain('transform=')
    // Selecting the new text shows UI 4 (round-trip).
    await page.getByRole('button', { name: 'Select', exact: true }).first().click()
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(500)
    expect(Number(await page.getByLabel('Stroke width', { exact: true }).first().inputValue())).toBeCloseTo(4, 9)
    // Stage raster: 1 SVG unit = 1 stage px, so the outline is ~2px.
    const px = await page.evaluate(async () => {
      const svg = document.querySelector('.vector-preview svg')
      if (!svg) throw new Error('Missing vector preview svg')
      const text = svg.querySelector('text')
      if (!text) throw new Error('No text')
      const isolated = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${text.outerHTML}</svg>`
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(isolated)}`
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(null)
        img.onerror = () => reject(new Error('svg img load failed'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 360
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, 480, 360).data
      let min = -1
      let max = -1
      for (let y = 0; y < 360; y += 1) {
        for (let x = 0; x < 480; x += 1) {
          if (data[(y * 480 + x) * 4 + 3]! > 127) {
            if (min < 0) min = y
            max = y
            break
          }
        }
      }
      return max >= 0 ? max - min + 1 : 0
    })
    expect(px).toBeGreaterThan(0)
    // Undo/Redo round-trips the parity bytes.
    const committed = await vectorObjectCount()
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-vector-selection-outline]').length === count,
      baseline as unknown as undefined,
      { timeout: 15_000 },
    )
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-vector-selection-outline]').length === count,
      committed as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await lastTextStrokeWidth()).toBeCloseTo(2, 9)
  }, 180_000)

  it('real Editor: scale(.5) import stays byte-identical, selects UI4, same-value no-op, explicit edit preserved', async () => {
    const IMPORT_SVG =
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
      `<text x="200" y="150" font-size="28" font-family="Arial, sans-serif" fill="#00c853" stroke="#1a237e" stroke-width="4" opacity="0.9" transform="scale(0.5)">SCALE009 hello</text></svg>`
    await gotoCostumes()
    await ensureVectorMode()
    await blankVectorCanvas()
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'text-scale-half.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(IMPORT_SVG, 'utf8'),
    })
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
      beforeCards as unknown as undefined,
      { timeout: 30_000 },
    )
    await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    // Untouched import bytes: attr + transform survive.
    const html = await previewInner()
    expect(html).toContain('stroke-width="4"')
    expect(html).toContain('scale(0.5)')
    expect(html).toContain('SCALE009 hello')
    // Scratch parity: scaled text selects as UI 4 (never forced to 8).
    await page.getByRole('button', { name: 'Select', exact: true }).first().click()
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(500)
    expect(Number(await page.getByLabel('Stroke width', { exact: true }).first().inputValue())).toBeCloseTo(4, 9)
    // Same-value edit stays a byte-identical no-op.
    await setStrokeWidth('4')
    await page.waitForTimeout(800)
    const sameHtml = await previewInner()
    expect(sameHtml).toContain('stroke-width="4"')
    expect(sameHtml).toContain('scale(0.5)')
    // Explicit UI 8 stores verbatim 8 (visual 8*0.5 = 4 = UI/2) with transform kept.
    await setStrokeWidth('8')
    await page.waitForTimeout(800)
    expect(await previewInner()).toContain('stroke-width="8"')
    expect(await previewInner()).toContain('scale(0.5)')
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await page.waitForTimeout(800)
    expect(await previewInner()).toContain('stroke-width="4"')
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await page.waitForTimeout(800)
    expect(await previewInner()).toContain('stroke-width="8"')
  }, 180_000)

  it('real Editor: rotate/translate text doubles, explicit edit halves, transform kept', async () => {
    const IMPORT_SVG =
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
      `<text x="200" y="150" font-size="28" font-family="Arial, sans-serif" fill="#00c853" stroke="#1a237e" stroke-width="2" opacity="0.9" transform="translate(30 12) rotate(8 200 150)">ROTATE010 hello</text></svg>`
    await gotoCostumes()
    await ensureVectorMode()
    await blankVectorCanvas()
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'text-rotate.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(IMPORT_SVG, 'utf8'),
    })
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
      beforeCards as unknown as undefined,
      { timeout: 30_000 },
    )
    await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    expect(await previewInner()).toContain('stroke-width="2"')
    await page.getByRole('button', { name: 'Select', exact: true }).first().click()
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(500)
    // Rotate/translate-only provably preserves scale, so *2 is certain: UI 4.
    expect(Number(await page.getByLabel('Stroke width', { exact: true }).first().inputValue())).toBeCloseTo(4, 9)
    // Explicit UI 8 stores UI/2 = 4 with the transform byte-identical otherwise.
    await setStrokeWidth('8')
    await page.waitForTimeout(800)
    expect(await previewInner()).toContain('stroke-width="4"')
    expect(await previewInner()).toContain('translate(30 12)')
    expect(await previewInner()).toContain('rotate(8 200 150)')
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await page.waitForTimeout(800)
    expect(await previewInner()).toContain('stroke-width="2"')
  }, 180_000)
})
