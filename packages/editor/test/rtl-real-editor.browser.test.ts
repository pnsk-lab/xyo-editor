import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor RTL E2E (product code untouched):
// document dir=rtl + Arabic/Hebrew + digit mixes, created through the REAL
// costume editor overlay in BOTH vector and bitmap modes:
//  - overlay right-edge anchor at the click point (wrapper dir=rtl,
//    -translate-x-full) vs the LTR centered box, measured in ARTWORK space
//    (workspace px). Screen-space comparison is invalid here: focusing the
//    overlay textarea auto-scrolls the paint surface (overflow scroll
//    container; measured scrollLeft goes 0 -> -311/-251/-1298 under doc
//    dir=rtl), so screen rects shift after the click while the artwork
//    anchor stays exact. Both the click point and the overlay edge are
//    therefore mapped back to shared workspace coordinates.
//  - multiline: every line's right edge lands on the click (vector tspan
//    geometry, bitmap ink diff)
//  - saved artwork pixels (vector SVG bbox, bitmap canvas ink diff)
//  - re-edit round-trip, Undo/Redo, LTR/CJK regression
//  - edit cancel (no history / no artwork) and the IME guard on an RTL draft
//
// OS-level Japanese IME on real hardware is UNCONFIRMED in CI (no OS IME in
// the container): the IME test drives the REAL overlay textarea with
// synthetic CompositionEvents + synthetic IME-flagged keydowns plus TRUSTED
// Escape/Enter while the composition window is open, exactly like the
// existing inline-text-ime-editor suite.
//
// Dedicated Vite port 4461 (surveyed: 4178/4179/4180/4183/4189/4191/4197/
// 4198/4199/4205/4213/4227/4231/4232/4234/4235/4236/4237/4238/4241/4242/4244/
// 4245/4247/4249/4252/4253/4255/4256/4259/4261/4263/4264/4265/4271/4277/4281/
// 4288/4289/4291/4293/4294/4295/4297/4299/4311/4317/4321/4322/4323/4327/4329/
// 4330/4331/4334/4345/4347/4348/4361/4371/4377/4381/4395/4399/4401/4427/4449/
// 4451 are taken by the other browser suites).
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4461'
const CHROME_PATH =
  process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  const surface = page.getByTestId('costume-paint-surface')
  await surface.waitFor({ state: 'visible' })
  return surface
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
}

async function ensureBitmapMode() {
  if (!(await page.getByTestId('bitmap-editor-canvas').isVisible())) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

async function setDocumentDir(dir: 'rtl' | 'ltr' | null) {
  await page.evaluate((value: 'rtl' | 'ltr' | null) => {
    if (value === null) document.documentElement.removeAttribute('dir')
    else document.documentElement.setAttribute('dir', value)
  }, dir as unknown as undefined)
}

async function canvasShot(): Promise<string> {
  return await page.evaluate(
    () =>
      document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.toDataURL(),
  )
}

/** Live bitmap canvas size (artboard: 960x720 sprite, 480x360 stage). */
async function bitmapCanvasSize() {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

/** Stage (edit-surface) rect in screen px: maps screen <-> workspace (2400x1800). */
async function stageRect() {
  return await page.evaluate(() => {
    const surfaceEl = document.querySelector('[data-testid="costume-paint-surface"]')!
    const stage = surfaceEl.firstElementChild!
    const rect = stage.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}

/** Overlay + stage rects plus overlay direction state, captured together. */
async function overlayAnchor() {
  return await page.evaluate(() => {
    const surfaceEl = document.querySelector('[data-testid="costume-paint-surface"]')!
    const stage = surfaceEl.firstElementChild!
    const stageRect = stage.getBoundingClientRect()
    const editor = document.querySelector('[data-inline-text-editor]') as HTMLElement
    const area = editor.querySelector('textarea') as HTMLTextAreaElement
    const rect = editor.getBoundingClientRect()
    return {
      wrapperDir: editor.getAttribute('dir'),
      wrapperClass: editor.className,
      areaDirAttr: area.getAttribute('dir'),
      areaComputedDirection: getComputedStyle(area).direction,
      areaTextAlign: getComputedStyle(area).textAlign,
      areaRows: area.rows,
      overlayLeft: rect.left,
      overlayRight: rect.right,
      overlayWidth: rect.width,
      stageLeft: stageRect.left,
      stageWidth: stageRect.width,
      scrollLeft: surfaceEl.scrollLeft,
      scrollTop: surfaceEl.scrollTop,
    }
  })
}

/** Surface scroll offsets (documents the focus auto-scroll). */
async function surfaceScroll() {
  return await page.evaluate(() => {
    const surfaceEl = document.querySelector('[data-testid="costume-paint-surface"]')!
    return { scrollLeft: surfaceEl.scrollLeft, scrollTop: surfaceEl.scrollTop }
  })
}

/** SVG screen point for an artwork-space (SVG unit) point via the live stage rect. */
async function svgPointToScreen(svgX: number, svgY: number) {
  return await page.evaluate(
    ({ x, y }: { x: number; y: number }) => {
      const surfaceEl = document.querySelector('[data-testid="costume-paint-surface"]')!
      const stage = surfaceEl.firstElementChild!
      const rect = stage.getBoundingClientRect()
      const k = rect.width / 2400
      // Vector art origin sits at workspace 0 here (480-wide canvas).
      return { x: rect.left + x * 5 * k, y: rect.top + y * 5 * k }
    },
    { x: svgX, y: svgY } as unknown as undefined,
  )
}

describe('RTL on the real costume editor (document dir=rtl, mixed scripts)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4461', '--strictPort'], {
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
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('vector: Hebrew/Arabic + digits multiline right-anchors overlay and saved geometry', async () => {
    const surface = await gotoCostumes()
    await ensureVectorMode()
    await setDocumentDir('rtl')
    const marker = `rtlvec${Date.now().toString(36)}`
    // Mix Hebrew + digits on line 1, Arabic + digits on line 2, plus a marker
    // so this commit is isolated from any other <text> in the costume.
    const line1 = `שלום 123 ${marker}`
    const line2 = `مرحبا 456`

    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const clickX = box.x + box.width / 2
    const clickY = box.y + box.height / 2
    const scrollBefore = await surfaceScroll()
    const preStage = await stageRect()
    // Screen -> workspace (2400x1800) with the pre-click layout.
    const clickWsX = ((clickX - preStage.left) / preStage.width) * 2400
    await page.mouse.click(clickX, clickY)

    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )

    // Empty draft under document dir=rtl already resolves RTL (no strong char
    // yet, document wins).
    const emptyDir = await overlay.getAttribute('dir')
    expect(emptyDir).toBe('rtl')

    await page.keyboard.type(line1)
    await page.keyboard.press('Enter')
    await page.keyboard.type(line2)
    expect(await textarea.inputValue()).toBe(`${line1}\n${line2}`)

    // Overlay right anchor in ARTWORK space: wrapper dir=rtl grows left from
    // the click, so its border-box right edge in workspace px lands on the
    // click workspace x (4 workspace-px tolerance; 1 workspace px = 1 screen
    // px at 100% zoom, glyph-independent). LTR would center instead.
    const anchor = await overlayAnchor()
    const overlayRightWs = ((anchor.overlayRight - anchor.stageLeft) / anchor.stageWidth) * 2400
    console.log(
      `[rtl-vector] anchor=${JSON.stringify(anchor)} clickWsX=${clickWsX} overlayRightWs=${overlayRightWs} scrollBefore=${JSON.stringify(scrollBefore)}`,
    )
    expect(anchor.wrapperDir).toBe('rtl')
    expect(anchor.wrapperClass).toContain('-translate-x-full')
    expect(anchor.areaDirAttr).toBe('auto')
    expect(anchor.areaComputedDirection).toBe('rtl')
    // text-align:start under RTL == right-aligned text inside the textarea.
    expect(anchor.areaTextAlign).toBe('start')
    expect(Math.abs(overlayRightWs - clickWsX)).toBeLessThanOrEqual(4)

    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })

    const preview = page.locator('.vector-preview')
    await preview.waitFor({ state: 'visible' })
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false,
      marker as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await preview.textContent()).toContain('שלום')
    expect(await preview.textContent()).toContain('123')
    expect(await preview.textContent()).toContain('مرحبا')

    // Saved vector geometry: the committed <text> keeps text-anchor=start
    // with direction=rtl, every tspan row shares the same x, and every
    // row's right edge (bbox) lands on the click SVG x. The VM persistence
    // allowlist keeps both attributes, verified via the serialized markup.
    const geometry = await page.evaluate((want: string) => {
      const texts = Array.from(document.querySelectorAll('.vector-preview svg text'))
      const target = texts.find((element) => element.textContent?.includes(want))
      if (!target) return { found: false as const }
      const element = target as unknown as SVGGraphicsElement & {
        getAttribute(name: string): string | null
      }
      const box = element.getBBox()
      const tspans = Array.from(target.querySelectorAll('tspan'))
      const rows = tspans.map((span) => {
        const rowBox = (span as unknown as SVGGraphicsElement).getBBox()
        return {
          x: span.getAttribute('x'),
          text: span.textContent,
          left: rowBox.x,
          right: rowBox.x + rowBox.width,
          width: rowBox.width,
        }
      })
      const svg = target.ownerSVGElement
      const html = svg?.outerHTML ?? ''
      return {
        found: true as const,
        anchor: target.getAttribute('text-anchor'),
        direction: target.getAttribute('direction'),
        x: target.getAttribute('x'),
        bboxLeft: box.x,
        bboxRight: box.x + box.width,
        rows,
        serializedHasRtl: html.includes('direction="rtl"'),
      }
    }, marker as unknown as undefined)
    console.log(`[rtl-vector] geometry=${JSON.stringify(geometry)}`)
    if (!geometry.found) throw new Error('Committed RTL <text> not found in preview')
    expect(geometry.anchor).toBe('start')
    expect(geometry.rows).toHaveLength(2)
    const clickSvgX = Number(geometry.x)
    // Every row's right edge lands on the click x (SVG units, 3-unit tolerance).
    for (const row of geometry.rows ?? []) {
      expect(Math.abs((row.right ?? 0) - clickSvgX)).toBeLessThanOrEqual(3)
    }
    // Both rows share one x (right edges co-linear by construction).
    expect(new Set((geometry.rows ?? []).map((row) => row.x)).size).toBe(1)
    expect(Math.abs((geometry.bboxRight ?? 0) - clickSvgX)).toBeLessThanOrEqual(3)
    await setDocumentDir(null)
  }, 120_000)

  it('vector: clicking visible RTL glyphs reopens the existing text', async () => {
    const surface = await gotoCostumes()
    await ensureVectorMode()
    await setDocumentDir('rtl')
    const marker = `rtlhit${Date.now().toString(36)}`
    const line1 = `שלום 123 ${marker}`
    const line2 = `مرحبا 456`

    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    await page.keyboard.type(line1)
    await page.keyboard.press('Enter')
    await page.keyboard.type(line2)
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false,
      marker as unknown as undefined,
      { timeout: 10_000 },
    )

    // Compare the editor's corrected object bounds with the browser-rendered
    // box, which extends left from the RTL anchor.
    const boxes = await page.evaluate((want: string) => {
      const svgEl = document.querySelector('.vector-preview svg')!
      const target = Array.from(svgEl.querySelectorAll('text')).find((element) =>
        element.textContent?.includes(want),
      )!
      const rendered = (target as unknown as SVGGraphicsElement).getBBox()
      return {
        x: target.getAttribute('x'),
        anchor: target.getAttribute('text-anchor'),
        direction: target.getAttribute('direction'),
        rendered: { left: rendered.x, right: rendered.x + rendered.width },
      }
    }, marker as unknown as undefined)
    const paper = await page.evaluate(async (want: string) => {
      const paperVector = await import('/src/features/costumes/paper-vector.ts')
      const svgEl = document.querySelector('.vector-preview svg')!
      const svgText = new XMLSerializer().serializeToString(svgEl)
      const list = await paperVector.paperVectorObjectList(svgText)
      const entry = list.find((object) => object.tag === 'text' && (object.text ?? '').includes(want))
      return entry
        ? { boundsX: entry.boundsX, boundsWidth: entry.boundsWidth, x: entry.x, text: entry.text }
        : undefined
    }, marker as unknown as undefined)
    console.log(`[rtl-vector-hit] boxes=${JSON.stringify(boxes)} paper=${JSON.stringify(paper)}`)

    // Click a point that is visually ON the first line's ink: x=200 sits
    // inside the rendered span (about -60..240) a few units above its
    // baseline, i.e. squarely on visible glyphs.
    const visualPoint = await svgPointToScreen(200, 185)
    await textTool.click()
    await page.mouse.click(visualPoint.x, visualPoint.y)
    await overlay.waitFor({ state: 'visible' })
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    const draft = await textarea.inputValue()
    console.log(`[rtl-vector-hit] visual-click draft=${JSON.stringify(draft)}`)
    // Correct behavior (Scratch parity: clicking existing text re-opens it):
    // the draft must round-trip the committed two lines. Paper hit/bounds
    // honor `direction="rtl"` (right edge at x), so the visual click lands
    // on the glyphs instead of opening a BLANK new session.
    expect(draft).toBe(`${line1}\n${line2}`)
    await setDocumentDir(null)
  }, 120_000)

  it('vector: re-edit and Undo/Redo retain RTL geometry in LTR UI', async () => {
    const surface = await gotoCostumes()
    await ensureVectorMode()
    await setDocumentDir('rtl')
    const marker = `rtledit${Date.now().toString(36)}`
    const line1 = `שלום 123 ${marker}`
    const line2 = `مرحبا 456`

    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    await page.keyboard.type(line1)
    await page.keyboard.press('Enter')
    await page.keyboard.type(line2)
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    const preview = page.locator('.vector-preview')
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false,
      marker as unknown as undefined,
      { timeout: 10_000 },
    )

    // Re-open through the visible glyphs: Paper hit/bounds now mirror the
    // display SVG (`direction="rtl"` honored, right edge at x), so the same
    // visual point as the hit-box test re-opens the node. The focus
    // auto-scroll can leave the glyphs clipped outside the visible surface,
    // so scroll the view back first (view-only, no artwork/history impact).
    await page.evaluate(() => {
      const surfaceEl = document.querySelector('[data-testid="costume-paint-surface"]')!
      surfaceEl.scrollTo({ left: 0, top: 0 })
    })
    await page.waitForTimeout(300)
    const paperPoint = await svgPointToScreen(200, 185)
    console.log(`[rtl-vector-edit] visual click=${JSON.stringify(paperPoint)}`)
    await textTool.click()
    await page.mouse.click(paperPoint.x, paperPoint.y)
    await overlay.waitFor({ state: 'visible' })
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    const draft = await textarea.inputValue()
    expect(draft).toBe(`${line1}\n${line2}`)
    // End appends to the very end of the draft (line 2), so the update
    // marker is the line-2 suffix, not a line-1 suffix.
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false,
      `${line2}!` as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await preview.textContent()).toContain(`${line2}!`)

    // Undo removes the "!" update (one history entry per confirmed edit),
    // Redo restores it. Both hold whether Undo lands on the pre-update or
    // the pre-insert artwork, since neither contains the "!" suffix.
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await undoButton.click()
    await page.waitForFunction(
      (want) => !(document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false),
      `${line2}!` as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await preview.textContent()).not.toContain(`${line2}!`)
    await redoButton.click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false,
      `${line2}!` as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await preview.textContent()).toContain(`${line2}!`)

    // Persistence impact: back in an LTR document the SAME saved element must
    // keep its right edge on the click x. The save path (VM persistence
    // allowlist) keeps both `text-anchor="start"` and `direction="rtl"`, so
    // the element stays right-anchored even when the inherited document
    // direction flips back to LTR. A failure here measures the flip.
    await setDocumentDir(null)
    await page.waitForTimeout(300)
    const flipped = await page.evaluate((want: string) => {
      const target = Array.from(document.querySelectorAll('.vector-preview svg text')).find(
        (element) => element.textContent?.includes(want),
      )
      if (!target) return { found: false as const }
      const rect = (target as unknown as SVGGraphicsElement).getBBox()
      return {
        found: true as const,
        x: target.getAttribute('x'),
        left: rect.x,
        right: rect.x + rect.width,
        anchor: target.getAttribute('text-anchor'),
        direction: target.getAttribute('direction'),
      }
    }, `${line2}!` as unknown as undefined)
    console.log(`[rtl-vector] after-doc-ltr=${JSON.stringify(flipped)}`)
    if (!flipped.found) throw new Error('Committed RTL text vanished after doc-ltr switch')
    // Correct behavior: right edge stays on the click x even in LTR context.
    expect(Math.abs((flipped.right ?? 0) - Number(flipped.x))).toBeLessThanOrEqual(3)
  }, 120_000)

  it('bitmap: Arabic + digits multiline inks right of the click, Undo/Redo', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    await setDocumentDir('rtl')
    const canvas = page.getByTestId('bitmap-editor-canvas')
    await canvas.waitFor({ state: 'visible' })
    const preCommit = await canvasShot()

    const textTool = page.getByTestId('bitmap-tool-text')
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas bounds')
    // Canvas center click == bitmap center (480, 360 of the 960x720 sprite
    // artboard) exactly, independent of scroll/zoom, so the ink expectation
    // needs no rect math.
    const clickX = box.x + box.width / 2
    const clickY = box.y + box.height / 2
    const scrollBefore = await surfaceScroll()
    const preStage = await stageRect()
    const liveSize = await bitmapCanvasSize()
    // Screen -> live-canvas px with the pre-click layout.
    const clickWsX = ((clickX - preStage.left) / preStage.width) * liveSize.width
    // Snapshot the canvas region BEFORE the click: the default costume (the
    // cat) already carries ink, so an absolute ink scan would measure the
    // cat, not the committed text. The commit is the only writer between the
    // two snapshots, so the pixel DIFF is exactly the committed text ink.
    // Region is centered on the live canvas center (the click point).
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>(
        '[data-testid="bitmap-editor-canvas"]',
      )!
      const context = target.getContext('2d')!
      const sx = Math.max(0, Math.floor(target.width / 2 - 320))
      const sy = Math.max(0, Math.floor(target.height / 2 - 120))
      const sw = Math.min(640, target.width - sx)
      const sh = Math.min(240, target.height - sy)
      ;(window as unknown as { __rtlPre?: ImageData }).__rtlPre = context.getImageData(sx, sy, sw, sh)
      ;(window as unknown as { __rtlRegion?: { sx: number; sy: number; sw: number; sh: number } }).__rtlRegion = { sx, sy, sw, sh }
    })
    await page.mouse.click(clickX, clickY)

    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )

    const line1 = 'مرحبا 789'
    const line2 = 'שלום 12'
    await page.keyboard.type(line1)
    await page.keyboard.press('Enter')
    await page.keyboard.type(line2)
    expect(await textarea.inputValue()).toBe(`${line1}\n${line2}`)

    const anchor = await overlayAnchor()
    const overlayRightWs = ((anchor.overlayRight - anchor.stageLeft) / anchor.stageWidth) * liveSize.width
    console.log(
      `[rtl-bitmap] anchor=${JSON.stringify(anchor)} clickWsX=${clickWsX} overlayRightWs=${overlayRightWs} scrollBefore=${JSON.stringify(scrollBefore)}`,
    )
    expect(anchor.wrapperDir).toBe('rtl')
    expect(anchor.wrapperClass).toContain('-translate-x-full')
    expect(anchor.areaComputedDirection).toBe('rtl')
    // Textarea grows with newlines (2 rows) and stays right-anchored.
    expect(anchor.areaRows).toBe(2)
    expect(Math.abs(overlayRightWs - clickWsX)).toBeLessThanOrEqual(4)

    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForTimeout(800)
    const postCommit = await canvasShot()
    expect(postCommit).not.toBe(preCommit)

    // Saved raster pixels: DIFF the canvas region against the pre-click
    // snapshot (the default cat already carries ink there). The commit is
    // the only writer between the snapshots, so changed pixels are exactly
    // the committed text ink. The longest RTL line's inked right edge must
    // land on the click bitmap x (canvas center, 12px tolerance for glyph
    // side bearings); each row's right edge is measured separately so a
    // centered fallback (short rows floating left of the click) cannot hide.
    const ink = await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>(
        '[data-testid="bitmap-editor-canvas"]',
      )!
      const clickBx = target.width / 2
      const clickBy = target.height / 2
      const context = target.getContext('2d')!
      const region = (window as unknown as { __rtlRegion?: { sx: number; sy: number; sw: number; sh: number } }).__rtlRegion
      const sx = region?.sx ?? Math.max(0, Math.floor(target.width / 2 - 320))
      const sy = region?.sy ?? Math.max(0, Math.floor(target.height / 2 - 120))
      const sw = region?.sw ?? 640
      const sh = region?.sh ?? 240
      const pre = (window as unknown as { __rtlPre?: ImageData }).__rtlPre
      const post = context.getImageData(sx, sy, sw, sh)
      if (!pre || pre.width !== sw || pre.height !== sh) {
        return { inked: false as const, clickBx, clickBy, reason: 'missing-pre-snapshot' }
      }
      const changedAt = (x: number, y: number) => {
        const i = (y * sw + x) * 4
        return (
          pre.data[i] !== post.data[i] ||
          pre.data[i + 1] !== post.data[i + 1] ||
          pre.data[i + 2] !== post.data[i + 2] ||
          pre.data[i + 3] !== post.data[i + 3]
        )
      }
      let top = -1
      let bottom = -1
      let left = sw
      let right = -1
      for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 4) {
          if (changedAt(x, y)) {
            if (top < 0) top = y
            bottom = y
            break
          }
        }
      }
      if (top < 0) return { inked: false as const, clickBx, clickBy, reason: 'no-changed-pixels' }
      for (let y = top; y <= bottom; y += 1) {
        for (let x = 0; x < sw; x += 1) {
          if (changedAt(x, y)) {
            if (x < left) left = x
            if (x > right) right = x
          }
        }
      }
      // Split the changed band into upper/lower line halves by the emptiest row.
      const rowHasChange: boolean[] = []
      for (let y = top; y <= bottom; y += 1) {
        let changed = false
        for (let x = 0; x < sw; x += 4) {
          if (changedAt(x, y)) {
            changed = true
            break
          }
        }
        rowHasChange.push(changed)
      }
      let bestStart = 0
      let bestRun = 0
      let runStart = -1
      rowHasChange.forEach((changed, index) => {
        if (!changed) {
          if (runStart < 0) runStart = index
        } else if (runStart >= 0) {
          const run = index - runStart
          if (run > bestRun) {
            bestRun = run
            bestStart = runStart
          }
          runStart = -1
        }
      })
      if (runStart >= 0) {
        const run = rowHasChange.length - runStart
        if (run > bestRun) {
          bestRun = run
          bestStart = runStart
        }
      }
      const rightOf = (y0: number, y1: number) => {
        let found = -1
        for (let x = sw - 1; x >= 0; x -= 1) {
          for (let y = y0; y <= y1; y += 1) {
            if (changedAt(x, y)) {
              found = sx + x
              break
            }
          }
          if (found >= 0) break
        }
        return found
      }
      const leftOf = (y0: number, y1: number) => {
        let found = -1
        for (let x = 0; x < sw; x += 1) {
          for (let y = y0; y <= y1; y += 1) {
            if (changedAt(x, y)) {
              found = sx + x
              break
            }
          }
          if (found >= 0) break
        }
        return found
      }
      const gapTop = top + bestStart
      const split = gapTop + Math.floor(bestRun / 2)
      const hasGap = bestRun >= 3
      const upperRight = rightOf(top, hasGap ? split : bottom)
      const lowerRight = hasGap ? rightOf(split + 1, bottom) : upperRight
      const upperLeft = leftOf(top, hasGap ? split : bottom)
      const lowerLeft = hasGap ? leftOf(split + 1, bottom) : upperLeft
      return {
        inked: true as const,
        clickBx,
        clickBy,
        overallLeft: sx + left,
        overallRight: sx + right,
        upperRight,
        lowerRight,
        upperLeft,
        lowerLeft,
        top: sy + top,
        bottom: sy + bottom,
        canvasWidth: target.width,
      }
    })
    console.log(`[rtl-bitmap] ink=${JSON.stringify(ink)}`)
    if (!ink.inked) throw new Error(`No changed bitmap pixels after RTL commit (${(ink as { reason?: string }).reason ?? 'unknown'})`)
    // Longest line pins the click: overall inked right edge on the click x.
    expect(Math.abs((ink.overallRight ?? 0) - (ink.clickBx ?? 0))).toBeLessThanOrEqual(12)
    // Each line's right edge lands on the click x (strict right alignment):
    // the raster commit draws every RTL row with `textAlign="right"` at the
    // shared right edge, so both the longest and the shorter row pin the
    // click x (12px tolerance covers glyph side bearings only).
    expect(Math.abs((ink.upperRight ?? 0) - (ink.clickBx ?? 0))).toBeLessThanOrEqual(12)
    expect(Math.abs((ink.lowerRight ?? 0) - (ink.clickBx ?? 0))).toBeLessThanOrEqual(12)

    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await undoButton.click()
    await page.waitForTimeout(500)
    expect(await canvasShot()).toBe(preCommit)
    await redoButton.click()
    await page.waitForTimeout(500)
    expect(await canvasShot()).toBe(postCommit)
    await setDocumentDir(null)
  }, 120_000)

  it('document dir=rtl forces RTL even for LTR content (saved anchor + direction)', async () => {
    const surface = await gotoCostumes()
    await ensureVectorMode()

    // RTL document + plain LTR content still resolves RTL (document wins).
    await setDocumentDir('rtl')
    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const rtlClickX = box.x + box.width * 0.3
    const rtlClickY = box.y + box.height * 0.3
    const preStage = await stageRect()
    const rtlClickWsX = ((rtlClickX - preStage.left) / preStage.width) * 2400
    await page.mouse.click(rtlClickX, rtlClickY)
    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    await page.keyboard.type('hello')
    const forced = await overlayAnchor()
    const forcedRightWs = ((forced.overlayRight - forced.stageLeft) / forced.stageWidth) * 2400
    console.log(
      `[rtl-doc-force] anchor=${JSON.stringify(forced)} clickWsX=${rtlClickWsX} rightWs=${forcedRightWs}`,
    )
    expect(forced.wrapperDir).toBe('rtl')
    expect(Math.abs(forcedRightWs - rtlClickWsX)).toBeLessThanOrEqual(4)
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    const forcedGeometry = await page.evaluate(() => {
      const texts = Array.from(document.querySelectorAll('.vector-preview svg text'))
      const last = texts.at(-1)
      return last
        ? { anchor: last.getAttribute('text-anchor'), direction: last.getAttribute('direction') }
        : undefined
    })
    console.log(`[rtl-doc-force] saved=${JSON.stringify(forcedGeometry)}`)
    // The save path (VM persistence allowlist) keeps both text-anchor and
    // `direction="rtl"`, so the block stays right-anchored.
    expect(forcedGeometry?.anchor).toBe('start')
    expect(forcedGeometry?.direction).toBe('rtl')
    await setDocumentDir(null)
  }, 120_000)

  it('LTR and CJK stay centered with no RTL markers (regression)', async () => {
    const surface = await gotoCostumes()
    await ensureVectorMode()
    await setDocumentDir(null)
    expect(
      await page.evaluate(() => document.documentElement.getAttribute('dir')),
    ).toBeNull()
    for (const sample of ['hello', '日本語テスト']) {
      const textTool = page.getByTestId('vector-shape-text').last()
      await textTool.click()
      const box = await surface.boundingBox()
      if (!box) throw new Error('Missing paint surface bounds')
      const x = box.x + box.width * 0.7
      const y = box.y + box.height * 0.3
      const pre = await stageRect()
      const clickWsX = ((x - pre.left) / pre.width) * 2400
      await page.mouse.click(x, y)
      const overlay = page.locator('[data-inline-text-editor]')
      await overlay.waitFor({ state: 'visible' })
      const textarea = overlay.locator('textarea')
      await textarea.waitFor({ state: 'visible' })
      await page.waitForFunction(
        () => document.activeElement?.tagName === 'TEXTAREA',
        undefined,
        { timeout: 10_000 },
      )
      await page.keyboard.type(sample)
      const state = await overlayAnchor()
      const centerWs = (((state.overlayLeft + state.overlayWidth / 2) - state.stageLeft) / state.stageWidth) * 2400
      console.log(
        `[ltr-regress] sample=${sample} anchor=${JSON.stringify(state)} clickWsX=${clickWsX} centerWs=${centerWs}`,
      )
      expect(state.wrapperDir).toBe('ltr')
      expect(state.wrapperClass).toContain('-translate-x-1/2')
      expect(state.areaComputedDirection).toBe('ltr')
      expect(Math.abs(centerWs - clickWsX)).toBeLessThanOrEqual(4)
      await page.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden' })
      await page.waitForFunction(
        (want) => document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false,
        sample as unknown as undefined,
        { timeout: 10_000 },
      )
      const saved = await page.evaluate(() => {
        const texts = Array.from(document.querySelectorAll('.vector-preview svg text'))
        const last = texts.at(-1)
        return last
          ? { anchor: last.getAttribute('text-anchor'), direction: last.getAttribute('direction') }
          : undefined
      })
      expect(saved?.anchor).toBe('middle')
      expect(saved?.direction).toBeNull()
    }
  }, 120_000)

  it('cancel discards the RTL draft without history or artwork (both modes)', async () => {
    // Vector cancel.
    let surface = await gotoCostumes()
    await ensureVectorMode()
    await setDocumentDir('rtl')
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const marker = `cancelrtl${Date.now().toString(36)}`
    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    let box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    let overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    let textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    const undoBeforeVector = await undoButton.isDisabled()
    await page.keyboard.type(marker)
    await overlay.getByRole('button', { name: 'Cancel text editing' }).click()
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForTimeout(400)
    expect(await page.locator('.vector-preview').textContent()).not.toContain(marker)
    expect(await undoButton.isDisabled()).toBe(undoBeforeVector)

    // Bitmap cancel: canvas bytes identical, no save message.
    surface = await gotoCostumes()
    await ensureBitmapMode()
    await setDocumentDir('rtl')
    const canvas = page.getByTestId('bitmap-editor-canvas')
    await canvas.waitFor({ state: 'visible' })
    const preCancel = await canvasShot()
    const bitmapTextTool = page.getByTestId('bitmap-tool-text')
    await bitmapTextTool.waitFor({ state: 'visible' })
    await bitmapTextTool.click()
    const canvasBox = await canvas.boundingBox()
    if (!canvasBox) throw new Error('Missing bitmap canvas bounds')
    await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
    overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    expect(await overlay.getAttribute('dir')).toBe('rtl')
    await page.keyboard.type('ביטול')
    await overlay.getByRole('button', { name: 'Cancel text editing' }).click()
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForTimeout(400)
    expect(await canvasShot()).toBe(preCancel)
    await setDocumentDir(null)
  }, 120_000)

  it('IME guard holds on an RTL draft: no commit while composing, one commit after', async () => {
    const surface = await gotoCostumes()
    await ensureVectorMode()
    await setDocumentDir('rtl')
    const marker = ` RTL${Date.now().toString(36)}`
    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    // Trusted Hebrew input first: the RTL draft is real text, not a value set.
    await page.keyboard.type('שלום')
    expect(await textarea.inputValue()).toBe('שלום')
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const preview = page.locator('.vector-preview')
    const undoDisabledBefore = await undoButton.isDisabled()

    // Synthetic composition window (no OS IME in CI: real IME stays UNCONFIRMED).
    await textarea.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }))
    })
    const imeDispatch = await textarea.evaluate((node) => {
      const fire = (init: KeyboardEventInit, keyCode?: number) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        if (keyCode !== undefined) {
          Object.defineProperty(event, 'keyCode', { value: keyCode })
          Object.defineProperty(event, 'which', { value: keyCode })
        }
        if ((init as { isComposing?: boolean }).isComposing !== undefined) {
          Object.defineProperty(event, 'isComposing', {
            value: (init as { isComposing?: boolean }).isComposing,
          })
        }
        node.dispatchEvent(event)
        return event.defaultPrevented
      }
      return {
        isComposingEscape: fire({ key: 'Escape', isComposing: true }),
        isComposingEnter: fire({ key: 'Enter', isComposing: true }),
        keyCode229: fire({ key: 'Escape' }, 229),
      }
    })
    expect(imeDispatch).toEqual({ isComposingEscape: false, isComposingEnter: false, keyCode229: false })
    expect(await overlay.isVisible()).toBe(true)

    // TRUSTED Escape/Enter while the composition window is open: no commit.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    expect(await overlay.isVisible()).toBe(true)
    expect((await preview.textContent()) ?? '').not.toContain(marker.trim())
    expect(await undoButton.isDisabled()).toBe(undoDisabledBefore)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    expect(await overlay.isVisible()).toBe(true)
    expect(await undoButton.isDisabled()).toBe(undoDisabledBefore)

    await textarea.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(300)
    expect(await overlay.isVisible()).toBe(true)

    // Plain Escape after compositionend commits the RTL draft (one history entry).
    expect(await textarea.inputValue()).toContain('שלום')
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.textContent?.includes('שלום') ?? false,
      undefined,
      { timeout: 10_000 },
    )
    expect(await preview.textContent()).toContain('שלום')
    await undoButton.click()
    await page.waitForFunction(
      () => !(document.querySelector('.vector-preview')?.textContent?.includes('שלום') ?? false),
      undefined,
      { timeout: 10_000 },
    )
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await redoButton.click()
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.textContent?.includes('שלום') ?? false,
      undefined,
      { timeout: 10_000 },
    )
    await setDocumentDir(null)
  }, 120_000)
})
