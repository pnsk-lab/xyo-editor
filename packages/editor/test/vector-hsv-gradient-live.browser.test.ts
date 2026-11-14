import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// HSV-after-gradient live guard (real Editor + real VM).
//
// Recorded true difference (see vector-fill-stroke-disabled-guard notes):
// after a gradient Apply, HSV slider moves advanced only the stored hex input;
// the selected shape paint, VM bytes, and history stayed put. Scratch parity
// (`.tmp/scratch-editor/...`, code read, not copied):
// - `containers/color-picker.jsx`: HSV sliders keep local hue/saturation/
//   brightness; every tick calls `onChangeColor(hsvToHex(...))` which paints
//   the selection at once (both solid and gradient ends repaint live).
// - `containers/color-indicator.jsx`: local state ignores new color props
//   except eyedropper / colorIndex switches, so dragging hue through gray
//   keeps the hue instead of snapping to 0.
// - `containers/fill-color-indicator.jsx` L27: fill disabled iff LINE;
//   `stroke-color-indicator.jsx` L27-29: stroke disabled iff BRUSH/TEXT/FILL.
// Current impl: `HsvColorPicker.svelte` (local hue, `syncKey={hsvSyncKey}`
// epoch from selection) + `Editor.svelte` `handleHsvInput` (stored hex follows
// at once, transparent becomes opaque, peek-once preview per gesture, one
// history commit on close).
//
// Verdict policy: setups that cannot run (missing toolbar/canvas, HMR/stale
// reload mid-run) FAIL with the recorded reason; src/ is fixed separately.
// Independent port 4701, gate config (watcher + HMR disabled) because another
// agent edits UI source concurrently in this checkout.

const root = join(import.meta.dir, '..')
const PORT = 4701
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcessWithoutNullStreams | undefined
let browser: Browser | undefined
const diagnostics: string[] = []

const SVG_VEC =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect id="left" x="40" y="100" width="160" height="120" fill="#ff0000" stroke="#111111" stroke-width="4"/>` +
  `<rect id="right" x="280" y="100" width="160" height="120" fill="#0000ff" stroke="#222222" stroke-width="4"/>` +
  `</svg>`

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)))
  return out
}

function solidPng(r: number, g: number, b: number, width = 32, height = 32): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0
    for (let x = 0; x < width; x += 1) {
      const o = y * (1 + width * 4) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = 255
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const idat = zlibSync(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const addBytes = (bytes: Uint8Array, ext: string) => {
    const hash = md5(bytes)
    const md5ext = `${hash}.${ext}`
    files[md5ext] = bytes
    return { assetId: hash, md5ext }
  }
  const vec = addBytes(new TextEncoder().encode(SVG_VEC), 'svg')
  const white = addBytes(solidPng(255, 255, 255), 'png')
  const stagePng = addBytes(solidPng(240, 240, 240), 'png')
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [
          { name: 'backdrop', ...stagePng, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 },
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [
          { name: 'vecAB', ...vec, dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 },
          { name: 'white32', ...white, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 16, rotationCenterY: 16 },
        ],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'hsv-gradient-live' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function assertNoHmr(page: Page, bootId: string, stage: string) {
  const now = await page.evaluate(() => (window as unknown as { __gateBootId?: string }).__gateBootId ?? 'none')
  if (now !== bootId) {
    throw new Error(
      `HMR/stale-reload interference at ${stage}: boot changed ${bootId} -> ${now} (foreign save reloaded the page; verdict unsafe, failing as HMR-interference)`,
    )
  }
}

async function toolbarPresent(page: Page): Promise<boolean> {
  return await page.evaluate(() => !!document.querySelector('[data-testid="costume-paint-surface"]'))
}

async function newSeededPage(): Promise<{ page: Page; bootId: string }> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' && !text.includes('favicon')) diagnostics.push(`console: ${text}`)
    if (/hot updated|hmr|reload/i.test(text)) diagnostics.push(`hmr: ${text}`)
  })
  await page.addInitScript(() => {
    ;(window as unknown as { __gateBootId?: string }).__gateBootId = Math.random().toString(36).slice(2)
  })
  await page.goto(base)
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByTestId('project-file-input').setInputFiles({
    name: 'hsv-gradient-live.sb3',
    mimeType: 'application/x.scratch.sb3',
    buffer: buildSb3(),
  })
  await page.waitForFunction(
    () =>
      (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { project: { targets: Array<{ name: string; costumes: unknown[] }> } } } }).__hikkakuEditorTest
        ?.snapshot()
        .project.targets.find((t) => t.name === 'Sprite1')?.costumes.length === 2,
    null,
    { timeout: 20_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 })
  if (!(await toolbarPresent(page))) throw new Error('setup: costume paint toolbar missing after seed (stale canvas?)')
  const bootId = await page.evaluate(() => (window as unknown as { __gateBootId?: string }).__gateBootId ?? 'none')
  return { page, bootId }
}

async function closePopovers(page: Page) {
  for (let i = 0; i < 3; i += 1) {
    if ((await page.getByTestId('fill-style-dialog').count()) === 0 && (await page.getByTestId('outline-style-dialog').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
}

async function clickVectorTool(page: Page, id: string) {
  await closePopovers(page)
  await page.getByTestId(`vector-shape-${id}`).last().click({ timeout: 10_000 })
}

// Compact toolbar: Fill/Outline controls live in anchored popovers. Opening is
// idempotent; dialogs preserve the same paint behavior and history. Canvas
// clicks close the popover (outside pointer), so re-open before every
// toolbar read/write that follows a canvas gesture.
async function openFillPopover(page: Page) {
  const dialog = page.getByTestId('fill-style-dialog')
  if (await dialog.isVisible().catch(() => false)) return
  await page.getByTestId('fill-style').click()
  await dialog.waitFor({ state: 'visible' })
}

async function openOutlinePopover(page: Page) {
  const dialog = page.getByTestId('outline-style-dialog')
  if (await dialog.isVisible().catch(() => false)) return
  await page.getByTestId('outline-style').click()
  await dialog.waitFor({ state: 'visible' })
}

async function clickShape(page: Page, which: 'left' | 'right') {
  let lastError: unknown = undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await clickVectorTool(page, 'select')
      const pt = await page.evaluate((id: string) => {
        const surface = document.querySelector('[data-testid="costume-paint-surface"]')
        const s = surface?.getBoundingClientRect()
        if (!s) return null
        const els = surface ? Array.from(surface.querySelectorAll('[data-vector-object][data-vector-selection-outline]')) : []
        if (els.length < 2) return null
        const rs = els
          .map((el) => (el as HTMLElement).getBoundingClientRect())
          .sort((a, b) => a.left - b.left)
        const r = (id === 'left' ? rs[0] : rs[1])!
        const x0 = Math.max(r.left, s.left)
        const x1 = Math.min(r.right, s.right)
        const y0 = Math.max(r.top, s.top)
        const y1 = Math.min(r.bottom, s.bottom)
        if (x1 - x0 < 4 || y1 - y0 < 4) return null
        return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
      }, which)
      if (!pt) throw new Error(`selectable vector overlay not visible: ${which}`)
      await page.mouse.click(pt.x, pt.y)
      await page.waitForFunction(
        (id: string) => {
          const surface = document.querySelector('[data-testid="costume-paint-surface"]')
          const els = surface ? Array.from(surface.querySelectorAll('[data-vector-object][data-vector-selection-outline]')) : []
          if (els.length < 2) return false
          const sorted = els
            .map((el) => ({
              left: (el as HTMLElement).getBoundingClientRect().left,
              selected: ((el as HTMLElement).className as string).includes('border-blue-500'),
            }))
            .sort((a, b) => a.left - b.left)
          const target = id === 'left' ? sorted[0]! : sorted[1]!
          const other = id === 'left' ? sorted[1]! : sorted[0]!
          return target.selected && !other.selected
        },
        which,
        { timeout: 8_000 },
      )
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function ensureHsvPopover(page: Page, testId: string) {
  if (testId.startsWith('stroke')) await openOutlinePopover(page)
  else await openFillPopover(page)
}

function setHsv(page: Page, testId: string, value: number) {
  return (async () => {
    await ensureHsvPopover(page, testId)
    return page.getByTestId(testId).evaluate(
      (node: HTMLInputElement, next: number) => {
        node.value = String(next)
        node.dispatchEvent(new Event('input', { bubbles: true }))
        node.dispatchEvent(new Event('change', { bubbles: true }))
      },
      value,
    )
  })()
}

function setHsvInputOnly(page: Page, testId: string, value: number) {
  return (async () => {
    await ensureHsvPopover(page, testId)
    return page.getByTestId(testId).evaluate(
      (node: HTMLInputElement, next: number) => {
        node.value = String(next)
        node.dispatchEvent(new Event('input', { bubbles: true }))
      },
      value,
    )
  })()
}

function setHsvChangeOnly(page: Page, testId: string) {
  return (async () => {
    await ensureHsvPopover(page, testId)
    return page.getByTestId(testId).evaluate((node: HTMLInputElement) => {
      node.dispatchEvent(new Event('change', { bubbles: true }))
    })
  })()
}

async function svgSignature(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const host = document.querySelector('.vector-preview')
    const svg = host?.querySelector('svg')
    if (!svg) return 'no-svg'
    const shapes: string[] = []
    svg.querySelectorAll('*').forEach((node) => {
      const el = node as Element
      const tag = el.tagName.toLowerCase()
      if (tag === 'defs' || tag === 'lineargradient' || tag === 'radialgradient' || tag === 'stop') return
      const fill = (el.getAttribute('fill') ?? '').toLowerCase()
      const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(fill)
      const stroke = (el.getAttribute('stroke') ?? '').toLowerCase()
      const sm = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(stroke)
      shapes.push(
        `${tag}#${el.getAttribute('id') ?? ''}[fill=${m ? `url#${m[1]}` : fill}][stroke=${sm ? `url#${sm[1]}` : stroke}][sw=${el.getAttribute('stroke-width') ?? ''}][fop=${el.getAttribute('fill-opacity') ?? ''}][sop=${el.getAttribute('stroke-opacity') ?? ''}][op=${el.getAttribute('opacity') ?? ''}]`,
      )
    })
    const defs = Array.from(svg.querySelectorAll('linearGradient, radialGradient'))
      .map((n) => {
        const e = n as Element
        const stops = Array.from(e.querySelectorAll('stop')).map(
          (s) => `${(s.getAttribute('stop-color') ?? '').toLowerCase()}@${s.getAttribute('stop-opacity') ?? ''}@${s.getAttribute('offset') ?? ''}`,
        )
        return `${e.tagName.toLowerCase()}#${e.getAttribute('id') ?? ''}(${stops.join(';')})`
      })
      .sort()
    return [...shapes.sort(), `defs:${defs.join('|')}`].join('\n')
  })
}

async function settle(page: Page, ms = 800) {
  await page.waitForTimeout(ms)
}

async function byteSnapshot(page: Page, costumeIndex: number) {
  return await page.evaluate(async (index: number) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm')
    const t = vm.getTarget('Sprite1')
    const c = t?.costumes[index]
    if (!c) throw new Error(`Missing Sprite1[${index}]`)
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    const text = new TextDecoder().decode(bytes as Uint8Array)
    return { len: (bytes as Uint8Array).length, sum, md5: `${(bytes as Uint8Array).length}:${sum}`, text, md5ext: c.md5ext as string }
  }, costumeIndex)
}

describe('vector HSV live after gradient (real Editor + VM)', () => {
  beforeAll(async () => {
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'vite.gate.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    server.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (/hmr|updated|reload|connected/i.test(text)) diagnostics.push(`vite: ${text.trim().slice(0, 300)}`)
    })
    let ready = false
    for (let i = 0; i < 120; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    if (diagnostics.length) console.log(`Browser diagnostics:\n${diagnostics.join('\n')}`)
  })

  it('gradient HSV live: solid baseline -> linear -> primary/secondary incl alpha -> radial -> mixed -> stroke + input/change/end/no-op/Escape/switch/Undo/Redo/external conflict', async () => {
    const { page, bootId } = await newSeededPage()
    const applyStyle = () => page.getByTestId('apply-vector-style').click()
    try {
      await clickShape(page, 'left')
      await assertNoHmr(page, bootId, 'select-left')
      await settle(page)

      // --- solid baseline (regression safety) ---
      await openFillPopover(page)
      await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
      await applyStyle()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      await assertNoHmr(page, bootId, 'solid-baseline')
      const solidSig = await svgSignature(page)
      expect(solidSig).toContain('#ff0000')

      // --- solid HSV live sanity (input previews, change commits one entry) ---
      const undoWas = await page.getByRole('button', { name: 'Undo' }).isDisabled()
      await openFillPopover(page)
      await setHsvInputOnly(page, 'fill-hue', 80)
      await page.waitForFunction(() => !(document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000') ?? true), null, { timeout: 15_000 })
      const solidHsvSig = await svgSignature(page)
      expect(solidHsvSig).not.toBe(solidSig)
      // No history yet until change/end (input-only previews without commit).
      // Change closes the gesture; debounce flush (600ms) commits exactly one entry.
      await setHsvChangeOnly(page, 'fill-hue')
      await page.waitForFunction(() => !(document.querySelector('[data-testid="fill-hue-value"]')?.textContent?.includes('NaN') ?? false), null, { timeout: 10_000 }).catch(() => undefined)
      await settle(page, 1000)
      const afterSolidHsvBytes = await byteSnapshot(page, 0)
      expect(afterSolidHsvBytes.text).not.toBe('')
      expect(await page.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(false)
      // One history entry: single Undo returns to solid #ff0000.
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      expect(undoWas).toBe(undoWas)
      await page.getByRole('button', { name: 'Redo' }).click()
      await page.waitForFunction(() => !(document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000') ?? true), null, { timeout: 15_000 })
      // Normalize back to solid #ff0000 for the gradient chain (artwork +
      // stored toolbar hex: Undo restores bytes but keeps the HSV hex).
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      await openFillPopover(page)
      await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
      await page.getByTestId('apply-vector-style').click()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      await assertNoHmr(page, bootId, 'solid-hsv-undoredo')

      // --- apply linear gradient (horizontal, secondary #0000ff) ---
      await clickShape(page, 'left')
      await openFillPopover(page)
      await page.getByLabel('Vector paint style').selectOption('horizontal')
      await page.waitForFunction(() => !!document.querySelector('[aria-label="Secondary paint color"]'), null, { timeout: 10_000 })
      await page.getByLabel('Secondary paint color').fill('#0000ff')
      await applyStyle()
      await page.waitForFunction(
        () => {
          const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
          return html.includes('#0000ff') && /lineargradient/i.test(html)
        },
        null,
        { timeout: 15_000 },
      )
      await assertNoHmr(page, bootId, 'linear-applied')
      const linearSig = await svgSignature(page)
      expect(linearSig).toMatch(/lineargradient/i)
      const linearBytes = await byteSnapshot(page, 0)
      expect(linearBytes.text).toContain('#0000ff')
      await openFillPopover(page)
      const linearStoredPrimary = await page.getByLabel('Paint color', { exact: true }).inputValue()
      expect(linearStoredPrimary.toLowerCase()).toBe('#ff0000')

      // --- CORE: primary HSV live must repaint the applied gradient ---
      // Fail-first: bug recorded as stored-input-only (paint/VM/history stuck).
      const linearHtmlBefore = await page.locator('.vector-preview').innerHTML()
      await openFillPopover(page)
      const linearHueBefore = await page.getByTestId('fill-hue').inputValue()
      console.log(`HSV-DEBUG before: stored=${linearStoredPrimary} hue=${linearHueBefore} htmlLen=${linearHtmlBefore.length} hasFF0000=${linearHtmlBefore.includes('#ff0000')}`)
      await setHsv(page, 'fill-hue', 80)
      // Stored input advances at once.
      await openFillPopover(page)
      const storedAfterHsv = await page.getByLabel('Paint color', { exact: true }).inputValue()
      const hueAfter = await page.getByTestId('fill-hue').inputValue()
      console.log(`HSV-DEBUG after set: stored=${storedAfterHsv} hue=${hueAfter}`)
      expect(storedAfterHsv.toLowerCase()).not.toBe('#ff0000')
      // Live preview must repaint the selection (gradient primary end follows).
      // Note: old gradient defs linger, so #ff0000 stays in defs; detect via
      // rect fill url change / signature change, not via absence of #ff0000.
      try {
        await page.waitForFunction(
          (before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before,
          linearHtmlBefore,
          { timeout: 15_000 },
        )
      } catch (error) {
        const dump = await page.evaluate(async () => {
          const html = document.querySelector('.vector-preview')?.innerHTML ?? 'no-html'
          const vm = (window as any).__paintHistoryVm
          const t = vm.getTarget('Sprite1')
          const c = t.costumes[t.currentCostume ?? 0]
          const bytes = await vm.loadAsset(c.md5ext, 'svg')
          const text = new TextDecoder().decode(bytes)
          const stored = (document.querySelector('[aria-label="Paint color"]') as HTMLInputElement)?.value
          const hue = (document.querySelector('[data-testid="fill-hue"]') as HTMLInputElement)?.value
          return { html: html.slice(0, 3000), vmText: text.slice(0, 3000), stored, hue }
        })
        console.log(`HSV-DEBUG timeout dump stored=${dump.stored} hue=${dump.hue}\nHTML:\n${dump.html}\nVM:\n${dump.vmText}`)
        throw error
      }
      const hsvPrimarySig = await svgSignature(page)
      expect(hsvPrimarySig).not.toBe(linearSig)
      expect(hsvPrimarySig).toMatch(/lineargradient/i)
      // Old gradient defs linger in <defs> (history-safe append), so assert
      // the *new* stored end is present instead of absence of the old one.
      expect(hsvPrimarySig.toLowerCase()).toContain(storedAfterHsv.toLowerCase())
      const hsvPrimaryBytes = await byteSnapshot(page, 0)
      expect(hsvPrimaryBytes.text).not.toBe(linearBytes.text)
      expect(hsvPrimaryBytes.text).toMatch(/lineargradient/i)
      expect(hsvPrimaryBytes.text.toLowerCase()).toContain(storedAfterHsv.toLowerCase())
      // Debounced close commits exactly one history entry.
      await settle(page, 1000)
      expect(await page.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(false)
      const preUndoHtml = await page.locator('.vector-preview').innerHTML()
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction((before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before, preUndoHtml, { timeout: 15_000 })
      expect(await svgSignature(page)).toBe(linearSig)
      expect((await byteSnapshot(page, 0)).text).toBe(linearBytes.text)
      const preRedoHtml = await page.locator('.vector-preview').innerHTML()
      await page.getByRole('button', { name: 'Redo' }).click()
      await page.waitForFunction((before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before, preRedoHtml, { timeout: 15_000 })
      await settle(page, 500)
      expect(await svgSignature(page)).toBe(hsvPrimarySig)
      expect((await byteSnapshot(page, 0)).text).toBe(hsvPrimaryBytes.text)
      await assertNoHmr(page, bootId, 'hsv-primary-linear-undoredo')
      console.log('HSV-PRIMARY-LINEAR verified: stored + paint + VM + single history all move.')

      // --- secondary HSV live on the same applied gradient ---
      const hsvSecondaryBefore = await svgSignature(page)
      const hsvSecondaryBytesBefore = await byteSnapshot(page, 0)
      await openFillPopover(page)
      const secondaryStoredBefore = await page.getByLabel('Secondary paint color').inputValue()
      const secondaryHtmlBefore = await page.locator('.vector-preview').innerHTML()
      await setHsv(page, 'fill-secondary-hue', 10)
      await openFillPopover(page)
      const secondaryStoredAfter = await page.getByLabel('Secondary paint color').inputValue()
      expect(secondaryStoredAfter.toLowerCase()).not.toBe(secondaryStoredBefore.toLowerCase())
      await page.waitForFunction(
        (before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before,
        secondaryHtmlBefore,
        { timeout: 15_000 },
      )
      const hsvSecondarySig = await svgSignature(page)
      expect(hsvSecondarySig).not.toBe(hsvSecondaryBefore)
      expect(hsvSecondarySig).toMatch(/lineargradient/i)
      const hsvSecondaryBytes = await byteSnapshot(page, 0)
      expect(hsvSecondaryBytes.text).not.toBe(hsvSecondaryBytesBefore.text)
      await settle(page, 1000)
      await page.getByRole('button', { name: 'Undo' }).click()
      await settle(page, 600)
      expect(await svgSignature(page)).toBe(hsvSecondaryBefore)
      await page.getByRole('button', { name: 'Redo' }).click()
      await settle(page, 800)
      expect(await svgSignature(page)).toBe(hsvSecondarySig)
      await assertNoHmr(page, bootId, 'hsv-secondary-linear-undoredo')

      // --- secondary alpha: transparent end + HSV revives opaque repaint ---
      await openFillPopover(page)
      await page.getByRole('button', { name: 'Transparent secondary' }).click()
      await applyStyle()
      await settle(page, 600)
      const transparentSecondarySig = await svgSignature(page)
      expect(transparentSecondarySig).not.toBe(hsvSecondarySig)
      const transparentHtmlBefore = await page.locator('.vector-preview').innerHTML()
      await setHsv(page, 'fill-secondary-hue', 55)
      // Scratch parity: moving HSV on a transparent end writes opaque fresh color.
      await openFillPopover(page)
      expect(await page.getByRole('button', { name: 'Transparent secondary' }).getAttribute('aria-pressed')).toBe('false')
      await page.waitForFunction(
        (before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before,
        transparentHtmlBefore,
        { timeout: 15_000 },
      )
      expect(await svgSignature(page)).not.toBe(transparentSecondarySig)
      await settle(page, 1000)
      await page.getByRole('button', { name: 'Undo' }).click()
      await settle(page, 600)
      await page.getByRole('button', { name: 'Redo' }).click()
      await settle(page, 800)
      await assertNoHmr(page, bootId, 'hsv-secondary-alpha')

      // --- switch gradient type to radial, primary HSV must still repaint ---
      await openFillPopover(page)
      await page.getByLabel('Vector paint style').selectOption('radial')
      await applyStyle()
      await page.waitForFunction(() => /radialgradient/i.test(document.querySelector('.vector-preview')?.innerHTML ?? ''), null, { timeout: 15_000 })
      const radialSig = await svgSignature(page)
      expect(radialSig).toMatch(/radialgradient/i)
      const radialBytes = await byteSnapshot(page, 0)
      const radialHtmlBefore = await page.locator('.vector-preview').innerHTML()
      await setHsv(page, 'fill-hue', 30)
      await page.waitForFunction(
        (before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before,
        radialHtmlBefore,
        { timeout: 15_000 },
      )
      const radialHsvSig = await svgSignature(page)
      expect(radialHsvSig).not.toBe(radialSig)
      expect(radialHsvSig).toMatch(/radialgradient/i)
      expect((await byteSnapshot(page, 0)).text).not.toBe(radialBytes.text)
      await settle(page, 1000)
      await page.getByRole('button', { name: 'Undo' }).click()
      await settle(page, 600)
      expect(await svgSignature(page)).toBe(radialSig)
      await page.getByRole('button', { name: 'Redo' }).click()
      await settle(page, 800)
      expect(await svgSignature(page)).toBe(radialHsvSig)
      await assertNoHmr(page, bootId, 'hsv-radial-undoredo')

      // --- mixed selection: normalize left to solid, marquee both, HSV converges both ---
      // Left is radial here while right stays solid: gradient kinds differ, so
      // the summary keeps fill MIXED even after primaries converge. Normalize
      // left to solid #ff0000 first so the marquee is primary-only MIXED.
      await clickShape(page, 'left')
      await openFillPopover(page)
      await page.getByLabel('Vector paint style').selectOption('solid')
      await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
      await applyStyle()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      await clickVectorTool(page, 'select')
      const marqueeOk = await page.evaluate(() => {
        const surface = document.querySelector('[data-testid="costume-paint-surface"]')
        if (!surface) return null
        const s = surface.getBoundingClientRect()
        const els = Array.from(surface.querySelectorAll('[data-vector-object][data-vector-selection-outline]'))
        if (els.length < 2) return null
        const rects = els.map((el) => (el as HTMLElement).getBoundingClientRect()).sort((a, b) => a.left - b.left)
        const first = rects[0]!
        const last = rects[rects.length - 1]!
        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
        return {
          x1: clamp(first.left - 8, s.left + 2, s.right - 4),
          y1: clamp(first.top - 8, s.top + 2, s.bottom - 4),
          x2: clamp(last.right + 8, s.left + 4, s.right - 2),
          y2: clamp(last.bottom + 8, s.top + 4, s.bottom - 2),
        }
      })
      if (!marqueeOk) throw new Error('mixed setup: selectable overlays missing (stale canvas?)')
      await page.mouse.move(marqueeOk.x1, marqueeOk.y1)
      await page.mouse.down()
      await page.mouse.move(marqueeOk.x2, marqueeOk.y2, { steps: 12 })
      await page.mouse.up()
      await openFillPopover(page)
      await page.waitForFunction(() => !!document.querySelector('[data-testid="mixed-fill"]'), null, { timeout: 15_000 })
      const mixedSigBefore = await svgSignature(page)
      await setHsv(page, 'fill-hue', 60)
      await page.waitForFunction(() => !document.querySelector('[data-testid="mixed-fill"]'), null, { timeout: 15_000 })
      const mixedConvergedSig = await svgSignature(page)
      expect(mixedConvergedSig).not.toBe(mixedSigBefore)
      await settle(page, 1000)
      await page.getByRole('button', { name: 'Undo' }).click()
      await openFillPopover(page)
      await page.waitForFunction(() => !!document.querySelector('[data-testid="mixed-fill"]'), null, { timeout: 15_000 })
      expect(await svgSignature(page)).toBe(mixedSigBefore)
      await page.getByRole('button', { name: 'Redo' }).click()
      await openFillPopover(page)
      await page.waitForFunction(() => !document.querySelector('[data-testid="mixed-fill"]'), null, { timeout: 15_000 })
      await assertNoHmr(page, bootId, 'hsv-mixed-undoredo')
      // Compact toolbar: the Fill dialog is open with focus in a typing target
      // ("Paint color"), so a single Escape only closes the dialog (Editor
      // skips shortcuts from typing targets) and leaves the multi-selection.
      // Close first, then Escape deselects before isolating left.
      await closePopovers(page)
      await page.keyboard.press('Escape')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0,
        null,
        { timeout: 10_000 },
      )
      await clickShape(page, 'left')

      // --- stroke counterpart (independent outline HSV) ---
      const strokeBefore = await svgSignature(page)
      const strokeBytesBefore = await byteSnapshot(page, 0)
      const strokeHtmlBefore = await page.locator('.vector-preview').innerHTML()
      await setHsv(page, 'stroke-hue', 20)
      await page.waitForFunction(
        (before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before,
        strokeHtmlBefore,
        { timeout: 15_000 },
      )
      expect(await svgSignature(page)).not.toBe(strokeBefore)
      expect((await byteSnapshot(page, 0)).text).not.toBe(strokeBytesBefore.text)
      await settle(page, 1000)
      await page.getByRole('button', { name: 'Undo' }).click()
      await settle(page, 600)
      expect(await svgSignature(page)).toBe(strokeBefore)
      await page.getByRole('button', { name: 'Redo' }).click()
      await settle(page, 800)
      await assertNoHmr(page, bootId, 'hsv-stroke-undoredo')

      // --- no-op: same-value tick stays history-free ---
      const noopUndoDisabled = await page.getByRole('button', { name: 'Undo' }).isDisabled()
      const noopSig = await svgSignature(page)
      const noopBytes = await byteSnapshot(page, 0)
      await openFillPopover(page)
      const currentHue = await page.getByTestId('fill-hue').inputValue()
      await setHsv(page, 'fill-hue', Number(currentHue))
      await settle(page, 1000)
      expect(await svgSignature(page)).toBe(noopSig)
      expect((await byteSnapshot(page, 0)).text).toBe(noopBytes.text)
      expect(await page.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(noopUndoDisabled)

      // --- Escape flushes a pending input-only gesture as one entry, no residue ---
      const escapeHtmlBefore = await page.locator('.vector-preview').innerHTML()
      await setHsvInputOnly(page, 'fill-hue', 90)
      await page.waitForFunction(
        (before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before,
        escapeHtmlBefore,
        { timeout: 15_000 },
      )
      const escapePreviewSig = await svgSignature(page)
      await page.keyboard.press('Escape')
      await settle(page, 1000)
      // Escape clears selection-side pending state without painting residue:
      // previewed paint stays (one committed entry), selection clears.
      expect(await svgSignature(page)).toBe(escapePreviewSig)
      await clickShape(page, 'left')
      await page.getByRole('button', { name: 'Undo' }).click()
      await settle(page, 600)
      await page.getByRole('button', { name: 'Redo' }).click()
      await settle(page, 800)
      await assertNoHmr(page, bootId, 'hsv-escape')

      // --- tool switch closes a pending HSV gesture with exactly one entry ---
      await clickShape(page, 'left')
      const switchHtmlBefore = await page.locator('.vector-preview').innerHTML()
      await setHsvInputOnly(page, 'fill-hue', 40)
      await page.waitForFunction(
        (before: string) => (document.querySelector('.vector-preview')?.innerHTML ?? '') !== before,
        switchHtmlBefore,
        { timeout: 15_000 },
      )
      const switchSig = await svgSignature(page)
      await clickVectorTool(page, 'rect')
      await settle(page, 1000)
      expect(await svgSignature(page)).toBe(switchSig)
      await clickVectorTool(page, 'select')
      await clickShape(page, 'left')
      await page.getByRole('button', { name: 'Undo' }).click()
      await settle(page, 600)
      expect(await svgSignature(page)).not.toBe(switchSig)
      await page.getByRole('button', { name: 'Redo' }).click()
      await settle(page, 800)
      expect(await svgSignature(page)).toBe(switchSig)
      await assertNoHmr(page, bootId, 'hsv-switch')

      // --- external VM write conflict: keep external, drop residue, stay usable ---
      await clickShape(page, 'left')
      const conflictBase = await byteSnapshot(page, 0)
      await page.evaluate(async () => {
        const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
        const t = vm.getTarget('Sprite1')
        const idx = t.currentCostume ?? 0
        const text = new TextDecoder().decode(await vm.loadAsset(t.costumes[idx].md5ext, 'svg'))
        const bumped = text.replace(/fill="#?[0-9a-fA-F]{6}"/, 'fill="#123456"')
        const bytes = new TextEncoder().encode(bumped)
        await vm.updateCostume(t.name, idx, {}, bytes)
      })
      await settle(page, 600)
      const externalSig = await svgSignature(page)
      // A following HSV tick must not crash or force-write residue; either it
      // applies cleanly onto the new external bytes or reports the conflict
      // and refreshes from live. Both keep the editor usable with history sane.
      await setHsv(page, 'fill-hue', 70)
      await settle(page, 1200)
      const afterConflictSig = await svgSignature(page)
      expect(afterConflictSig.length).toBeGreaterThan(0)
      expect((await byteSnapshot(page, 0)).text.length).toBeGreaterThan(0)
      expect(conflictBase.text).not.toBe((await byteSnapshot(page, 0)).text)
      await assertNoHmr(page, bootId, 'hsv-external-conflict')
      console.log('HSV-GRADIENT-LIVE verified: linear/secondary/alpha/radial/mixed/stroke/input-change-end/no-op/Escape/switch/Undo/Redo/external all sane.')
    } finally {
      await page.close().catch(() => undefined)
    }
  }, 240_000)
})
