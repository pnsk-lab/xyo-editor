import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-Editor regression test for the font-fallback audit fix.
//
// Bug: re-editing an existing SVG `<text>` rewrote `font-family`/`font-size`
// from the toolbar defaults (Arial/24) even when the font UI was untouched,
// so external stacks were lost and unknown fonts showed a blank select.
// Fix: characters-only commits pass no font options (effective inheritance /
// inline style / tspan / weight / direction / transform preserved); only an
// explicit session-owned font/size change rewrites its attribute; unknown
// stacks render as a real dropdown option with their actual value.
//
// Drives the REAL Editor bundle (paint-history-isolation fixture: real
// Editor.svelte + real VM as `__paintHistoryVm`) in Chromium via Vite, with
// assertions against REAL VM asset bytes and the REAL Undo/Redo buttons.
// Port 4291 is unused by the other browser suites.
// Scratch font files are never bundled/copied/fetched here: only system font
// *names* already present in the repo shortlist plus a nonexistent placeholder
// stack are referenced as strings.
const root = join(import.meta.dir, '..')
const PORT = 4291
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH =
  process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

// NOTE: the paint surface shows a fixed 480x360 slice of the 5x workspace at
// the default zoom/pan (1400x900 viewport, same as the other real-Editor
// suites): SVG x in [182,297], y in [125,235]. All text units below sit
// inside that band so canvas clicks hit real glyph geometry; click points are
// still derived at runtime from the measured preview box.
const FOREIGN_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360" font-family="NonexistentFontXYZ, sans-serif">` +
  `<text x="240" y="160" font-size="30" font-weight="700" transform="rotate(5 240 160)" text-anchor="middle">hello</text>` +
  `<text x="240" y="205" font-size="24" font-family="Georgia, serif" onclick="alert(1)">second</text>` +
  `<text x="240" y="225" font-size="20" font-family="Arial, sans-serif"><tspan x="240" dy="0">one</tspan><tspan x="240" dy="24" fill="#ff0000" font-weight="900">two</tspan></text></svg>`
const PLAIN_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect x="40" y="60" width="120" height="80" fill="#ff0000"/>` +
  `<text x="240" y="180" font-size="24" font-family="Georgia, serif">plain</text></svg>`
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
  const foreign = add(FOREIGN_SVG)
  const plain = add(PLAIN_SVG)
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
        costumes: [{ ...costume(plain, 'stage-plain'), rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(foreign, 'foreign-text'), costume(plain, 'plain-compare'), costume(blank, 'rtl-blank')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'text-font-preserve' },
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

async function waitForTextChange(target: string, index: number, beforeText: string, timeout = 15_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const got = await costumeText(target, index)
    if (got !== beforeText) return got
    if (Date.now() - start > timeout) throw new Error(`text change timeout ${target}[${index}]`)
    await new Promise((r) => setTimeout(r, 150))
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
  if (
    clientX < surface.x || clientX > surface.x + surface.width
    || clientY < surface.y || clientY > surface.y + surface.height
  ) {
    throw new Error(`SVG point (${x},${y}) maps outside the visible surface: client=(${clientX},${clientY}) surface=${JSON.stringify(surface)} preview=${JSON.stringify(box)}`)
  }
  await page.mouse.click(clientX, clientY)
}

// Visible SVG rect in artwork units, measured at runtime: the viewport pan
// differs per costume (per-costume viewport state), so tests that switch
// costumes must derive click points from this instead of fixed coordinates.
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

async function openTextAt(x: number, y: number): Promise<string> {
  await clickSvgPoint(x, y)
  const overlay = page.locator('[data-inline-text-editor]')
  await overlay.waitFor({ state: 'visible', timeout: 10_000 })
  const textarea = overlay.locator('textarea')
  await textarea.waitFor({ state: 'visible', timeout: 10_000 })
  // The overlay autofocuses asynchronously (rAF + a 50ms fallback focus in
  // BitmapEditor focusInlineText). Typing/Escape sent before the caret lands
  // go to <body> instead: typing is lost and Escape is swallowed as a global
  // deselect, leaving the overlay stuck until the hidden-timeout. Wait for
  // the real caret target before returning to the caller.
  await page.waitForFunction(
    () => document.activeElement === document.querySelector('[data-inline-text-editor] textarea'),
    null,
    { timeout: 10_000 },
  )
  return await textarea.inputValue()
}

// Visible-ink click for existing text units (test-only geometry fix).
//
// Scratch parity note: scratch-paint `TextTool` hits text via
// `paper.project.hitTestAll(point, { class: PointText, fill/stroke/curves/
// segments, tolerance: 2 / paper.view.zoom })` (`TextTool.TOLERANCE = 2`
// screen px, `getTextEditHitOptions`/`handleMouseDown`). The product keeps
// the same budget (`vectorSelectToleranceFromSurfaceScale` = 2 screen px).
// At the Fit viewport here the surface scale is ~3.64 px per SVG unit, so
// the budget is ~0.55 SVG units. A fixed SVG `x=240` sits exactly on the
// `text-anchor="start"` edge for `second`/`one`/`two`; the drawn ink starts
// at the left side bearing (>0.5 units inside), so the Paper hit cleanly
// misses (`hit=-1`) and the suite fails twice in a row. Instead derive the
// click from the rendered preview DOM bbox (tspan-first, smallest-area wins
// so multiline rows resolve to their own line ink) and map its client center
// back through the same preview box `clickSvgPoint` uses. No product code,
// fixture bytes, or font/history/RTL assertions change here.
async function svgPointForTextContent(
  needle: string,
  fallback: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  try {
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
        const cx = r.x + r.width * 0.5
        const cy = r.y + r.height * 0.5
        const svgX = ((cx - previewRect.x) / previewRect.width) * 480
        const svgY = ((cy - previewRect.y) / previewRect.height) * 360
        if (!Number.isFinite(svgX) || !Number.isFinite(svgY)) return null
        return { svgX, svgY }
      } catch {
        return null
      }
    }, needle)
    if (!found || !Number.isFinite(found.svgX) || !Number.isFinite(found.svgY)) return fallback
    const x = Math.max(0, Math.min(480, found.svgX))
    const y = Math.max(0, Math.min(360, found.svgY))
    try {
      const vr = await visibleSvgRect()
      if (x < vr.x + 2 || x > vr.x + vr.width - 2 || y < vr.y + 2 || y > vr.y + vr.height - 2) {
        return fallback
      }
    } catch {
      // Ignore the visibility guard; clickSvgPoint re-checks the surface.
    }
    return { x, y }
  } catch {
    return fallback
  }
}

async function openTextByContent(needle: string, fallback: { x: number; y: number }): Promise<string> {
  const pt = await svgPointForTextContent(needle, fallback)
  return await openTextAt(pt.x, pt.y)
}

async function commitWithEscape(): Promise<void> {
  const overlay = page.locator('[data-inline-text-editor]')
  if (!(await overlay.isVisible())) return
  // Escape only commits from the overlay textarea: sent anywhere else it is
  // a global deselect that leaves the draft open (stuck overlay). Font/size
  // edits move focus to the toolbar, so refocus the textarea and wait for
  // the real caret target before sending Escape.
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

async function fontToolbarState() {
  return await page.evaluate(() => {
    const select = document.querySelector('select[aria-label="Vector font"]') as HTMLSelectElement | null
    const size = document.querySelector('input[aria-label="Vector font size"]') as HTMLInputElement | null
    if (!select || !size) throw new Error('Vector font controls not visible')
    return {
      value: select.value,
      selectedIndex: select.selectedIndex,
      shown: select.options[select.selectedIndex]?.text ?? null,
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

async function undoDisabled(): Promise<boolean> {
  return await page.evaluate(() => {
    const visible = (label: string) =>
      Array.from(document.querySelectorAll(`button[aria-label="${label}"]`)).filter(
        (b) => (b as HTMLElement).offsetParent !== null,
      ) as HTMLButtonElement[]
    const u = visible('Undo')[0]
    if (!u) throw new Error('Undo button not visible')
    return u.disabled
  })
}

describe('text font preservation on the real Editor UI', () => {
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
      name: 'font-preserve.sb3',
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
    await selectCostumeByName('foreign-text')
    await ensureVectorMode()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('shows the unknown inherited stack (not blank) and preserves it on a characters-only edit, with Undo/Redo', async () => {
    expect(await undoDisabled()).toBe(true)
    const original = await costumeText('Sprite1', 0)
    expect(original).toContain('NonexistentFontXYZ')
    await clickTextTool()
    // Unit 0 inherits the unknown stack from the svg root; the dropdown must
    // show the real value instead of a blank select.
    const draft = await openTextByContent('hello', { x: 240, y: 150 })
    expect(draft).toBe('hello')
    const toolbar = await fontToolbarState()
    expect(toolbar.value).toContain('NonexistentFontXYZ')
    expect(toolbar.selectedIndex).toBeGreaterThanOrEqual(0)
    expect(toolbar.shown).toContain('NonexistentFontXYZ')
    expect(toolbar.size).toBe('30')
    // Characters only: no font UI touched.
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await commitWithEscape()
    const edited = await waitForTextChange('Sprite1', 0, original)
    expect(edited).toContain('hello!')
    // The inherited stack, size, weight, and transform survive. Unit 0 keeps
    // NO own font-family (inheritance from the svg root stays intact) and no
    // Arial veil is added (the only Arial in the file belongs to unit 2).
    const unit0 = edited.match(/<text[^>]*>hello!<\/text>/)?.[0] ?? ''
    expect(unit0).not.toBe('')
    expect(unit0).not.toContain('font-family')
    expect(unit0).toContain('font-size="30"')
    expect(unit0).toContain('font-weight="700"')
    expect(unit0).toContain('rotate(5 240 160)')
    expect(edited).toContain('NonexistentFontXYZ')
    // The rendered preview stays SVG-safe (event handler never reaches the DOM).
    const preview = await page.locator('.vector-preview').innerHTML()
    expect(preview).not.toContain('onclick')
    expect(preview).toContain('second')
    // Exactly one Undo step restores the original bytes; Redo restores the edit.
    await clickUndoOnce()
    expect(await waitForTextChange('Sprite1', 0, edited)).toBe(original)
    await clickRedoOnce()
    expect(await waitForTextChange('Sprite1', 0, original)).toBe(edited)
  }, 90_000)

  it('treats reopen-without-changes as a no-op (one Undo still restores the pre-edit bytes)', async () => {
    const before = await costumeText('Sprite1', 0)
    await clickTextTool()
    const draft = await openTextByContent('hello', { x: 240, y: 150 })
    expect(draft).toBe('hello!')
    await commitWithEscape()
    await page.waitForTimeout(800)
    // No DOM write and no history entry: a single Undo must reach past this
    // no-op to the previous real edit (the original upload bytes).
    expect(await costumeText('Sprite1', 0)).toBe(before)
    await clickUndoOnce()
    const undone = await waitForTextChange('Sprite1', 0, before)
    expect(undone).toContain('hello</text>')
    expect(undone).not.toContain('hello!')
    await clickRedoOnce()
    expect(await waitForTextChange('Sprite1', 0, undone)).toBe(before)
  }, 90_000)

  it('keeps each selection on its own stack (unit1 Georgia/28, rich tspan paint)', async () => {
    await clickTextTool()
    // Unit 1 owns Georgia/28: opening it must show its own stack, never the
    // previously edited unit's foreign stack or the toolbar default.
    const draft1 = await openTextByContent('second', { x: 240, y: 197 })
    expect(draft1).toBe('second')
    const toolbar1 = await fontToolbarState()
    expect(toolbar1.value).toBe('Georgia, serif')
    // System stack label is intentionally distinct from the Scratch literal
    // `Serif` (value `Serif`): `Georgia, serif` shows as `Serif (System)`.
    expect(toolbar1.shown).toBe('Serif (System)')
    expect(toolbar1.size).toBe('24')
    await page.keyboard.press('End')
    await page.keyboard.type('?')
    const before1 = await costumeText('Sprite1', 0)
    await commitWithEscape()
    const after1 = await waitForTextChange('Sprite1', 0, before1)
    expect(after1).toContain('second?')
    const unit1 = after1.match(/<text[^>]*>second\?<\/text>/)?.[0] ?? ''
    expect(unit1).not.toBe('')
    expect(unit1).toContain('font-family="Georgia, serif"')
    expect(unit1).toContain('font-size="24"')
    // Unit 0 (foreign stack) is untouched by unit 1's commit.
    expect(after1).toContain('NonexistentFontXYZ')
    expect(after1).toContain('hello!')
    // Rich multiline unit: per-row tspan paint survives a line edit.
    const draft2 = await openTextByContent('one', { x: 240, y: 218 })
    expect(draft2).toBe('one\ntwo')
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    const before2 = await costumeText('Sprite1', 0)
    await commitWithEscape()
    const after2 = await waitForTextChange('Sprite1', 0, before2)
    expect(after2).toContain('two!')
    expect(after2).toContain('fill="#ff0000"')
    expect(after2).toContain('font-weight="900"')
  }, 120_000)

  it('applies an explicit font/size change only, then undoes/redoes it', async () => {
    await clickTextTool()
    const draft = await openTextByContent('hello', { x: 240, y: 150 })
    expect(draft).toContain('hello!')
    // Explicit user change: Serif + 40. Refocus the textarea afterwards:
// Escape only commits from the textarea (focus is in the size input after
// fill, and global shortcuts must never commit a draft).
    await page.locator('select[aria-label="Vector font"]').selectOption('Georgia, serif')
    await page.locator('input[aria-label="Vector font size"]').fill('40')
    await page.locator('[data-inline-text-editor] textarea').click()
    const before = await costumeText('Sprite1', 0)
    await commitWithEscape()
    const changed = await waitForTextChange('Sprite1', 0, before)
    const changedUnit0 = changed.match(/<text[^>]*>hello!<\/text>/)?.[0] ?? ''
    expect(changedUnit0).not.toBe('')
    expect(changedUnit0).toContain('font-family="Georgia, serif"')
    expect(changedUnit0).toContain('font-size="40"')
    expect(changedUnit0).toContain('font-weight="700"')
    expect(changedUnit0).toContain('rotate(5 240 160)')
    await clickUndoOnce()
    const undone = await waitForTextChange('Sprite1', 0, changed)
    expect(undone).toContain('NonexistentFontXYZ')
    expect(undone).toContain('font-size="30"')
    await clickRedoOnce()
    expect(await waitForTextChange('Sprite1', 0, undone)).toBe(changed)
  }, 90_000)

  it('round-trips RTL direction and defers Escape to the IME in the real overlay', async () => {
    // Dedicated costume so the pristine plain-compare bytes stay untouched.
    await selectCostumeByName('rtl-blank')
    await ensureVectorMode()
    await clickTextTool()
    await page.locator('input[aria-label="Vector font size"]').fill('24')
    // Adaptive insert point: center of the currently visible band (this
    // costume has its own viewport pan), kept clear of the left-side rect.
    const vr = await visibleSvgRect()
    let ix = vr.x + vr.width * 0.55
    let iy = vr.y + vr.height * 0.5
    if (ix < 140) ix = Math.min(vr.x + vr.width - 30, 220)
    if (ix > vr.x + vr.width - 15 || iy > vr.y + vr.height - 15) {
      throw new Error(`No free insert point in visible rect ${JSON.stringify(vr)}`)
    }
    // Center is free here (only a left-side rect): a new session opens.
    await clickSvgPoint(ix, iy)
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible', timeout: 10_000 })
    const newDraft = await page.locator('[data-inline-text-editor] textarea').inputValue()
    expect(newDraft).toBe('')
    // IME owns Escape mid-composition: no commit, no overlay close.
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-inline-text-editor] textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('overlay textarea missing')
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }))
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    expect(await page.locator('[data-inline-text-editor]').isVisible()).toBe(true)
    const rtlIndex = 2
    const beforeRtl = await costumeText('Sprite1', rtlIndex)
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-inline-text-editor] textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('overlay textarea missing')
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true }))
    })
    // New RTL text anchors at its right edge.
    await page.keyboard.type('שלום')
    await commitWithEscape()
    const rtl = await waitForTextChange('Sprite1', rtlIndex, beforeRtl)
    expect(rtl).toContain('שלום')
    expect(rtl).toContain('direction="rtl"')
    expect(rtl).toContain('text-anchor="start"')
    // Editing the RTL block back to LTR drops the marker and restores middle.
    // The block extends left from the insert edge (~53 units at size 24).
    const rx = ix - 25
    const ry = iy + 3
    const vr2 = await visibleSvgRect()
    if (rx < vr2.x || rx > vr2.x + vr2.width || ry < vr2.y || ry > vr2.y + vr2.height) {
      throw new Error(`RTL reopen point (${rx},${ry}) outside visible rect ${JSON.stringify(vr2)}`)
    }
    const redraft = await openTextByContent('שלום', { x: rx, y: ry })
    expect(redraft).toBe('שלום')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('hi')
    const beforeLtr = await costumeText('Sprite1', rtlIndex)
    await commitWithEscape()
    const ltr = await waitForTextChange('Sprite1', rtlIndex, beforeLtr)
    expect(ltr).toContain('>hi</text>')
    expect(ltr).not.toContain('direction=')
    expect(ltr).toContain('text-anchor="middle"')
  }, 120_000)

  it('isolates scopes: the other costume stays byte-identical', async () => {
    const plainBefore = await costumeText('Sprite1', 1)
    expect(plainBefore).toContain('plain')
    await selectCostumeByName('plain-compare')
    await ensureVectorMode()
    expect(await costumeText('Sprite1', 1)).toBe(plainBefore)
    await selectCostumeByName('foreign-text')
    await ensureVectorMode()
    expect(await costumeText('Sprite1', 1)).toBe(plainBefore)
  }, 60_000)
})
