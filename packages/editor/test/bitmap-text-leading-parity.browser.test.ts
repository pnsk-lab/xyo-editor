import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// T-3 bitmap leading parity: 46.15/40 (reference) vs the former 1.25.
//
// Oracle (facts, no AGPL copy):
// - `.tmp/scratch-editor/.../helper/tools/text-tool.js` creates
//   `PointText({ fontSize: 40, leading: 46.15 })` for BOTH vector and bitmap
//   and sets the textarea to `lineHeight = leading / fontSize`.
// - Paper `PointText._draw` advances each raster row by `leading`
//   (`ctx.translate(0, leading)`) and `_getBounds` reports
//   `height = numLines * leading`; the bitmap commit rasterizes that item
//   (`rasterize(72, false, drawnBounds)`), so committed rows advance by
//   `46.15/40 em = 1.15375`, not 1.25.
// - The former xyo bitmap path used `fontSize * 1.25` for the canvas
//   `fillText` row offsets, the gradient block, and the helper. This suite
//   locks the corrected `46.15/40` geometry in the real engine (Chromium via
//   CHROME_BIN) with the same installed Sans on both sides, so no false
//   pixel parity is asserted: only row-band positions, RTL anchoring,
//   trailing-blank advance, IME deferral, font-control preservation, and
//   exact VM Undo/Redo bytes.
//
// Port 4392 is unused by the other browser suites.
const root = join(import.meta.dir, '..')
const PORT = 4392
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH =
  process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

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
        costumes: [costume(stamp, 'leading-blank')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'bitmap-leading-parity' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
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

describe('bitmap text leading parity 46.15/40 (real Canvas + VM)', () => {
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
      name: 'bitmap-leading-parity.sb3',
      mimeType: 'application/x.scratch.sb3',
      buffer: buildSb3(),
    })
    await page.waitForFunction(
      () =>
        (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 1,
      null,
      { timeout: 20_000 },
    )
    await ensureVectorMode()
    await selectCostumeByName('leading-blank')
    await ensureVectorMode()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('locks reference row geometry with an independent canvas oracle (2-3 lines, same Sans)', async () => {
    // Same installed Sans on both sides (no font assets vendored): the
    // product helper and this independent oracle share the engine fallback,
    // so only geometry is asserted, never exact pixel parity.
    const result = await page.evaluate(async () => {
      const bitmap = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-text.ts')
      const fontSize = 40
      const fontFamily = 'Arial, sans-serif'
      const referenceRatio = 46.15 / 40
      const expected = fontSize * referenceRatio
      const productLine = bitmap.bitmapTextLineHeight(fontSize)
      const productFactor = bitmap.BITMAP_TEXT_LINE_HEIGHT
      // Explicit 3-line positions, exactly as the raster painter computes:
      // firstY centered on the click, then firstY + i * lineHeight.
      const click = { x: 240, y: 180 }
      const lines = ['one', 'two', 'three']
      const firstY = click.y - ((lines.length - 1) * productLine) / 2
      const lineYs = lines.map((_, i) => firstY + i * productLine)
      // Single-line exact: one row stays on the click regardless of leading.
      const singleFirstY = click.y - ((1 - 1) * productLine) / 2
      // Independent oracle: separate canvas, same font string, center/middle,
      // real browser measureText for the widest row.
      const measure = document.createElement('canvas').getContext('2d')!
      measure.font = bitmap.resolveBitmapTextFont(fontSize, fontFamily)
      const measuredWidths = lines.map((line) => measure.measureText(line).width)
      const widestHelper = bitmap.measureBitmapTextWidestLine('one\ntwo\nthree', fontSize, fontFamily, (line, font) => {
        const c = document.createElement('canvas').getContext('2d')!
        c.font = font
        return c.measureText(line).width
      })
      const widestDirect = Math.max(...measuredWidths)
      // Independent ink scan: draw at the product positions on a fresh canvas
      // and locate each row band by alpha rows (no pixel-equality claim).
      const raster = document.createElement('canvas')
      raster.width = 480
      raster.height = 360
      const ctx = raster.getContext('2d')!
      ctx.font = bitmap.resolveBitmapTextFont(fontSize, fontFamily)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#000000'
      lines.forEach((line, i) => ctx.fillText(line, click.x, lineYs[i]!))
      const alpha = ctx.getImageData(0, 0, raster.width, raster.height).data
      const rowHasInk = (yCenter: number) => {
        // Glyph ink for a 40px middle-baseline row lives within +/-14px.
        let ink = 0
        for (let y = Math.max(0, Math.floor(yCenter - 14)); y <= Math.min(raster.height - 1, Math.ceil(yCenter + 14)); y += 1) {
          for (let x = 0; x < raster.width; x += 4) {
            if ((alpha[(y * raster.width + x) * 4 + 3] ?? 0) > 8) ink += 1
          }
        }
        return ink
      }
      const bandInk = lineYs.map((y) => rowHasInk(y))
      // Gap bands halfway between rows should be weaker than the row bands
      // for this 46.15px advance at 40px (taller 50px advance would push rows
      // further apart; this distinguishes the two without pixel parity).
      const midGaps = [ (lineYs[0]! + lineYs[1]!) / 2, (lineYs[1]! + lineYs[2]!) / 2 ].map((y) => rowHasInk(y))
      // Former 1.25 geometry for contrast (what the bug produced).
      const oldLine = fontSize * 1.25
      const oldFirstY = click.y - ((lines.length - 1) * oldLine) / 2
      return {
        expected,
        productLine,
        productFactor,
        firstY,
        lineYs,
        singleFirstY,
        measuredWidths,
        widestHelper,
        widestDirect,
        bandInk,
        midGaps,
        oldLine,
        oldFirstY,
        fontString: bitmap.resolveBitmapTextFont(fontSize, fontFamily),
      }
    })
    // Reference ratio drives the product helper (not the former 1.25).
    expect(result.productFactor).toBeCloseTo(46.15 / 40, 12)
    expect(result.productLine).toBeCloseTo(result.expected, 10)
    expect(result.productLine).toBeCloseTo(46.15, 10)
    expect(result.oldLine).toBeCloseTo(50, 10)
    // 3-line block: rows 46.15 apart centered on 180 -> 133.85 / 180 / 226.15.
    expect(result.firstY).toBeCloseTo(180 - 46.15, 10)
    expect(result.lineYs[1]).toBeCloseTo(180, 10)
    expect(result.lineYs[2]! - result.lineYs[1]!).toBeCloseTo(46.15, 10)
    // Former geometry would have been 130 / 180 / 230 (4px off per outer row).
    expect(result.oldFirstY).toBeCloseTo(130, 10)
    expect(Math.abs(result.firstY - result.oldFirstY)).toBeCloseTo(3.85, 1)
    // Single line stays exactly on the click (leading-independent).
    expect(result.singleFirstY).toBeCloseTo(180, 12)
    // Real browser measurement agrees with the helper's widest row.
    expect(result.widestHelper).toBeCloseTo(result.widestDirect, 6)
    expect(result.measuredWidths.every((w) => w > 0)).toBe(true)
    // Independent canvas shows ink at every product row band.
    for (const ink of result.bandInk) expect(ink).toBeGreaterThan(0)
    expect(result.fontString).toBe('40px Arial, sans-serif')
  })

  it('anchors RTL right edges, advances trailing blanks, defers IME, keeps font controls', async () => {
    const result = await page.evaluate(async () => {
      const bitmap = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-text.ts')
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-text.ts')
      const ime = await import(/* @vite-ignore */ '/src/features/costumes/inline-text-ime.ts')
      const fontSize = 32
      const fontFamily = 'Arial, sans-serif'
      const click = { x: 200, y: 120 }
      // RTL: content first-strong Hebrew resolves right; the commit point
      // shifts left by half the canvas-measured widest line, and every row
      // redrawn right-aligned at commitX + widest/2 restores the click as the
      // shared right edge (short rows included).
      const rtlText = 'שלום\nעולם!'
      const measure = (line: string, font: string) => {
        const c = document.createElement('canvas').getContext('2d')!
        c.font = font
        return c.measureText(line).width
      }
      const adjusted = bitmap.resolveBitmapTextCommitPoint(click, rtlText, fontSize, fontFamily, undefined, measure)
      const drawX = bitmap.resolveBitmapTextRtlDrawX(adjusted.x, rtlText, fontSize, fontFamily, measure)
      // Scan the right-aligned RTL oracle draw for the shared right edge.
      const raster = document.createElement('canvas')
      raster.width = 480
      raster.height = 360
      const ctx = raster.getContext('2d')!
      ctx.font = bitmap.resolveBitmapTextFont(fontSize, fontFamily)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#000000'
      const lh = bitmap.bitmapTextLineHeight(fontSize)
      const firstY = click.y - ((2 - 1) * lh) / 2
      ctx.fillText('שלום', drawX, firstY)
      ctx.fillText('עולם!', drawX, firstY + lh)
      const data = ctx.getImageData(0, 0, raster.width, raster.height).data
      let right = -1
      for (let x = 0; x < raster.width; x += 1) {
        for (let y = 0; y < raster.height; y += 1) {
          if ((data[(y * raster.width + x) * 4 + 3] ?? 0) > 0) right = x
        }
      }
      // Trailing blank: "ab\n" keeps 2 rows; the empty row advances by one
      // leading (block height covers it) even though it paints no ink.
      const trailing = bitmap.splitBitmapTextLines('ab\n')
      const blockTwo = bitmap.bitmapTextBlockBounds(click.x, click.y, 'ab\n', fontSize)
      const blockOne = bitmap.bitmapTextBlockBounds(click.x, click.y, 'ab', fontSize)
      // IME: composition owns Escape/Enter (no commit path).
      const deferComposing = (ime.shouldDeferInlineTextKeyToIme as (e: unknown, c: boolean) => boolean)({ isComposing: true }, false)
      const defer229 = (ime.shouldDeferInlineTextKeyToIme as (e: unknown, c: boolean) => boolean)({ keyCode: 229 }, false)
      const deferWindow = (ime.shouldDeferInlineTextKeyToIme as (e: unknown, c: boolean) => boolean)({}, true)
      const plainPasses = (ime.shouldDeferInlineTextKeyToIme as (e: unknown, c: boolean) => boolean)({}, false)
      return {
        alignRtl: bitmap.resolveBitmapTextAlign(rtlText),
        alignLtr: bitmap.resolveBitmapTextAlign('hello'),
        adjustedX: adjusted.x,
        drawX,
        inkRight: right,
        lineHeight32: lh,
        trailing,
        blockTwoHeight: blockTwo.height,
        blockOneHeight: blockOne.height,
        deferComposing,
        defer229,
        deferWindow,
        plainPasses,
        toolbarLen: (vector.VECTOR_TEXT_FONT_OPTIONS as unknown[]).length,
        defaultFont: vector.VECTOR_TEXT_DEFAULT_FONT_FAMILY,
        singleRowCentered: bitmap.bitmapTextBlockBounds(100, 100, 'x', 24),
      }
    })
    expect(result.alignRtl).toBe('right')
    expect(result.alignLtr).toBe('center')
    expect(result.adjustedX).toBeLessThan(200)
    // Shared right edge lands on the click: the advance right edge is exact
    // (drawX), while the ink right edge sits within the glyph side bearing
    // (Hebrew 32px Arial measures ~2px bearing in this Chromium).
    expect(result.drawX).toBeCloseTo(200, 0)
    expect(result.inkRight).toBeGreaterThanOrEqual(195)
    expect(result.inkRight).toBeLessThanOrEqual(201)
    expect(result.lineHeight32).toBeCloseTo(32 * (46.15 / 40), 10)
    // Trailing "\n" is a real second row: split keeps it, block grows by one
    // reference leading.
    expect(result.trailing).toEqual(['ab', ''])
    expect(result.blockTwoHeight - result.blockOneHeight).toBeCloseTo(32 * (46.15 / 40), 10)
    // IME guard defers; plain keys still commit.
    expect(result.deferComposing).toBe(true)
    expect(result.defer229).toBe(true)
    expect(result.deferWindow).toBe(true)
    expect(result.plainPasses).toBe(false)
    // Font controls preserved: unified 14-option toolbar, Sans Serif default.
    expect(result.toolbarLen).toBe(14)
    expect(result.defaultFont).toBe('Sans Serif')
    // Single-row block stays centered on the click.
    expect(result.singleRowCentered.x + result.singleRowCentered.width / 2).toBeCloseTo(100, 10)
    expect(result.singleRowCentered.y + result.singleRowCentered.height / 2).toBeCloseTo(100, 10)
  })

  it('commits 3-line bitmap text through the real overlay with exact VM undo/redo', async () => {
    await selectCostumeByName('leading-blank')
    await ensureVectorMode()
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 20_000 })
    const before = await costumeDigest('Sprite1', 0)
    // Configured font via the preserved toolbar controls (same Sans on both
    // sides; decorative webfonts are unavailable so Arial Sans is used for
    // deterministic fallback, not pixel parity).
    await page.getByTestId('bitmap-tool-text').click()
    await page.getByTestId('bitmap-text-font').waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByTestId('bitmap-text-font').selectOption('Arial, sans-serif')
    await page.getByTestId('bitmap-text-font-size').fill('32')
    expect(await page.getByTestId('bitmap-text-font').inputValue()).toBe('Arial, sans-serif')
    expect(await page.getByTestId('bitmap-text-font-size').inputValue()).toBe('32')
    await page.getByTestId('bitmap-editor-canvas').click()
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
    await waitForTextareaFocus()
    // 3 lines via trusted keys (Enter inserts newlines on the real overlay).
    await page.keyboard.type('one')
    await page.keyboard.press('Enter')
    await page.keyboard.type('two')
    await page.keyboard.press('Enter')
    await page.keyboard.type('three')
    expect(await page.locator('[data-inline-text-editor] textarea').inputValue()).toBe('one\ntwo\nthree')
    await commitWithEscape()
    const after = await waitForDigestChange('Sprite1', 0, before)
    expect(after).not.toBe(before)
    // Real raster ink on the bitmap canvas (toolbar font actually resolved).
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
    // Exact history: one Undo restores the pre-commit bytes, one Redo
    // reapplies the committed bytes byte-identically.
    await clickUndoOnce()
    expect(await waitForDigestChange('Sprite1', 0, after)).toBe(before)
    await clickRedoOnce()
    expect(await waitForDigestChange('Sprite1', 0, before)).toBe(after)
  }, 120_000)
})
