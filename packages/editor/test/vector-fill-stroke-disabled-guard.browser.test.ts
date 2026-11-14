import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Vector fill/stroke disabled-guard audit on the real Editor + real VM.
//
// Product guards under test (read-only here, never edited):
// - `isVectorFillDisabled`: vector LINE disables the entire fill side.
// - `isVectorStrokeDisabled`: vector BRUSH/TEXT/FILL disable the entire stroke side.
// - Every fill control (primary/secondary hex, both HSV groups, both gradients,
//   both transparent toggles, both swaps, both eyedroppers, stroke width) carries
//   the same native `disabled`, and every commit path guards the same flags.
// - `chooseVectorTool` cancels an eyedropper whose target just became disabled.
//
// Honke照合 (`.tmp/scratch-editor/packages/scratch-paint`, code read, not copied):
// - fill disabled iff mode === LINE (`fill-color-indicator.jsx` L27);
//   stroke (+ width) disabled iff BRUSH/TEXT/FILL (`stroke-color-indicator.jsx`
//   L27-29, `stroke-width-indicator.jsx` L67-70).
// - Honke DOM: ancestor `InputGroup` div gets `.disabled` (opacity 0.3 +
//   `pointer-events: none`); NO native `disabled` attr, NO `aria-disabled` — the
//   inner button/popover stays focusable, mouse-unreachable.
// - Honke popover contents (inside the disabled group, so all unreachable while
//   disabled): HSV sliders, transparent toggle, eyedropper, gradient kind icons,
//   primary/secondary swatches + swap (`color-picker.jsx`, `color-indicator.jsx`).
// - Current impl difference (documented in BitmapEditor.svelte): native `disabled`
//   on each split top-level control instead of one CSS group — unfocusable via
//   Tab and announced dimmed/disabled. This suite asserts the current native
//   behavior AND logs the honke delta; a real parity break FAILS loudly.
// - Eyedropper: honke lives inside the popover and `handleCloseColor` refuses to
//   close while eyedropping; current impl is an overlay with the same
//   disabled-target guard. Tool-switch close is asserted only for the
//   newly-disabled target (current documented behavior).
//
// Verdict policy: setups that cannot run (missing toolbar/canvas, HMR/stale
// reload mid-run) FAIL with the recorded reason. src/ is never touched.
// Independent port 4699, gate config (watcher + HMR disabled) because another
// agent edits UI source concurrently in this checkout.

const root = join(import.meta.dir, '..')
const PORT = 4699
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
    meta: { semver: '3.0.0', vm: 'test', agent: 'fill-stroke-disabled-guard' },
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
    name: 'fill-stroke-guard.sb3',
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
  // Vector costume first (index 0 is svg).
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 })
  if (!(await toolbarPresent(page))) throw new Error('setup: costume paint toolbar missing after seed (stale canvas?)')
  const bootId = await page.evaluate(() => (window as unknown as { __gateBootId?: string }).__gateBootId ?? 'none')
  return { page, bootId }
}

async function clickVectorTool(page: Page, id: string) {
  await closePopovers(page)
  await page.getByTestId(`vector-shape-${id}`).last().click({ timeout: 10_000 })
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

function setStrokeWidth(page: Page, value: number) {
  // The width field is a one-way `value=` + `onchange` number input (like the
  // HSV sliders, Playwright fill() alone does not reach the Svelte change
  // handler here), so drive it the same trusted way as setHsv: set the value
  // then dispatch input+change. UI 12 stores SVG 6 (Scratch parity /2).
  return page.getByLabel('Stroke width').evaluate(
    (node: HTMLInputElement, next: number) => {
      node.value = String(next)
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
    },
    value,
  )
}

// Compact toolbar: Fill/Outline controls live in anchored popovers. Opening is
// idempotent; canvas/toolbar-outside clicks close (outside pointer), so
// re-open before every toolbar read/write that follows such a click.
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

async function closePopovers(page: Page) {
  for (let i = 0; i < 3; i += 1) {
    if ((await page.getByTestId('fill-style-dialog').count()) === 0 && (await page.getByTestId('outline-style-dialog').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
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

type DomSnapshot = {
  paintColor: string | null
  secondaryPaintColor: string | null
  paintGradient: string | null
  secondaryVisible: boolean
  strokeColor: string | null
  secondaryStrokeColor: string | null
  strokeGradient: string | null
  strokeSecondaryVisible: boolean
  fillTransparentPressed: boolean | null
  secondaryTransparentPressed: boolean | null
  strokeTransparentPressed: boolean | null
  secondaryStrokeTransparentPressed: boolean | null
  strokeWidth: string | null
  fillHsv: number[] | null
  strokeHsv: number[] | null
  fillEyedropperPressed: boolean | null
  strokeEyedropperPressed: boolean | null
  eyedropperHint: boolean
  svg: string | null
  undoDisabled: boolean
  redoDisabled: boolean
  boot: string
}

type ByteSnapshot = { len: number; sum: number; md5: string; text: string; md5ext: string }

async function svgSignature(page: Page): Promise<string> {
  // Semantic paint signature (honke style-path view): per-shape identity +
  // paints + gradient refs + defs. Ignores paper-normalization attr churn
  // (attribute order, extra paper attrs, x-rounding) that can land in the
  // preview DOM asynchronously without any VM/history change.
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

async function domSnapshot(page: Page): Promise<DomSnapshot> {
  return await page.evaluate(() => {
    const val = (sel: string): string | null => {
      const el = document.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null
      return el ? (el as HTMLInputElement).value ?? null : null
    }
    const pressed = (sel: string): boolean | null => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) return null
      return el.getAttribute('aria-pressed') === 'true'
    }
    const byLabel = (name: string): string | null => {
      const el = document.querySelector(`[aria-label="${name}"]`) as HTMLInputElement | HTMLSelectElement | null
      return el ? (el as HTMLInputElement).value ?? null : null
    }
    const svg = document.querySelector('.vector-preview')?.innerHTML ?? null
    const btn = (name: string) =>
      Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
      ) as HTMLButtonElement | undefined
    return {
      paintColor: byLabel('Paint color'),
      secondaryPaintColor: byLabel('Secondary paint color'),
      paintGradient: byLabel('Vector paint style'),
      secondaryVisible: !!document.querySelector('[aria-label="Secondary paint color"]'),
      strokeColor: byLabel('Stroke color'),
      secondaryStrokeColor: byLabel('Secondary stroke color'),
      strokeGradient: document.querySelector('[data-testid="vector-stroke-gradient"]')
        ? ((document.querySelector('[data-testid="vector-stroke-gradient"]') as HTMLSelectElement).value ?? null)
        : null,
      strokeSecondaryVisible: !!document.querySelector('[aria-label="Secondary stroke color"]'),
      fillTransparentPressed: pressed('[aria-label="Transparent fill"]'),
      secondaryTransparentPressed: pressed('[aria-label="Transparent secondary"]'),
      strokeTransparentPressed: pressed('[aria-label="Transparent stroke"]'),
      secondaryStrokeTransparentPressed: pressed('[aria-label="Transparent secondary stroke"]'),
      strokeWidth: byLabel('Stroke width'),
      fillHsv: ['fill-hue', 'fill-saturation', 'fill-brightness'].map(
        (id) => Number((document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement)?.value ?? NaN),
      ),
      strokeHsv: [
        Number((document.querySelector('[data-testid="stroke-hue"]') as HTMLInputElement)?.value ?? NaN),
        Number((document.querySelector('[data-testid="stroke-saturation"]') as HTMLInputElement)?.value ?? NaN),
        Number((document.querySelector('[data-testid="stroke-brightness"]') as HTMLInputElement)?.value ?? NaN),
      ],
      fillEyedropperPressed: pressed('[data-testid="eyedropper-fill"]'),
      strokeEyedropperPressed: pressed('[data-testid="eyedropper-stroke"]'),
      eyedropperHint: !!document.querySelector('[data-testid="eyedropper-hint"]'),
      svg,
      undoDisabled: btn('Undo')?.hasAttribute('disabled') ?? true,
      redoDisabled: btn('Redo')?.hasAttribute('disabled') ?? true,
      boot: (window as unknown as { __gateBootId?: string }).__gateBootId ?? 'none',
    } as DomSnapshot
  })
}

async function byteSnapshot(page: Page, costumeIndex: number): Promise<ByteSnapshot> {
  return await page.evaluate(async (index: number) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
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

describe('vector fill/stroke disabled guards (real Editor + VM)', () => {
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

  it('fill side disabled only on LINE, stroke side only on BRUSH/TEXT/FILL (DOM/focus/aria honke照合)', async () => {
    const { page, bootId } = await newSeededPage()
    try {
      await clickShape(page, 'left')
      await assertNoHmr(page, bootId, 'select-left')
      // Keep both gradients non-solid so secondary controls stay mounted.
      // Compact toolbar: gradient selects live in the Fill/Outline popovers.
      await openFillPopover(page)
      await page.getByLabel('Vector paint style').selectOption('horizontal')
      await openOutlinePopover(page)
      await page.getByTestId('vector-stroke-gradient').selectOption('horizontal')
      await openFillPopover(page)
      await page.waitForFunction(
        () =>
          !!document.querySelector('[aria-label="Secondary paint color"]') &&
          !!document.querySelector('[data-testid="fill-style-dialog"]'),
        null,
        { timeout: 10_000 },
      )
      await openOutlinePopover(page)
      await page.waitForFunction(
        () =>
          !!document.querySelector('[aria-label="Secondary stroke color"]') &&
          !!document.querySelector('[data-testid="outline-style-dialog"]'),
        null,
        { timeout: 10_000 },
      )
      await closePopovers(page)

      const fillIds = [
        'Paint color',
        'Secondary paint color',
        'Transparent fill',
        'Transparent secondary',
        'Vector paint style',
        'fill-hue',
        'fill-saturation',
        'fill-brightness',
        'fill-secondary-hue',
        'fill-secondary-saturation',
        'fill-secondary-brightness',
      ]
      const strokeDialogIds = [
        'Stroke color',
        'Secondary stroke color',
        'Transparent stroke',
        'Transparent secondary stroke',
        'vector-stroke-gradient',
        'stroke-hue',
        'stroke-saturation',
        'stroke-brightness',
        'stroke-secondary-hue',
        'stroke-secondary-saturation',
        'stroke-secondary-brightness',
      ]
      const tools = ['select', 'brush', 'eraser', 'fill', 'text', 'line', 'oval', 'rect', 'reshape'] as const
      const report: string[] = []
      for (const tool of tools) {
        await closePopovers(page)
        await clickVectorTool(page, tool)
        await page.waitForTimeout(200)
        await assertNoHmr(page, bootId, `tool-${tool}`)
        if (!(await toolbarPresent(page))) throw new Error(`stale toolbar after switching to ${tool}`)
        const wantFill = tool === 'line'
        const wantStroke = tool === 'brush' || tool === 'text' || tool === 'fill'
        if (tool === 'eraser') {
          // Known UI difference (out of guard scope, recorded): the eraser
          // tool replaces the whole paint row with eraser-size controls, so
          // fill/stroke controls are unmounted (honke keeps its indicators
          // mounted and enabled). Assert the current mounted behavior.
          // Compact toolbar: both swatches unmounted too.
          const gone = await page.getByLabel('Paint color', { exact: true }).count()
          if (gone !== 0) throw new Error(`eraser tool: Paint color mounted (count=${gone}), want unmounted`)
          expect(await page.getByTestId('fill-style').count()).toBe(0)
          expect(await page.getByTestId('outline-style').count()).toBe(0)
          expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
          expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
          report.push(`tool=${tool} paint-row=unmounted (honke keeps indicators mounted; recorded difference)`)
          continue
        }
        // Compact toolbar triggers: disabled side keeps its swatch disabled and
        // its dialog unreachable (reference `pointer-events: none` parity).
        expect(await page.getByTestId('fill-style').count()).toBe(1)
        expect(await page.getByTestId('fill-style').isDisabled()).toBe(wantFill)
        expect(await page.getByTestId('outline-style').count()).toBe(1)
        expect(await page.getByTestId('outline-style').isDisabled()).toBe(wantStroke)
        expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
        expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
        if (!wantFill) {
          await openFillPopover(page)
          for (const id of fillIds) {
            const loc =
              id === 'Vector paint style'
                ? page.getByLabel('Vector paint style', { exact: true })
                : id.endsWith('-hue') || id.endsWith('-saturation') || id.endsWith('-brightness')
                  ? page.getByTestId(id)
                  : id === 'Transparent fill' || id === 'Transparent secondary'
                    ? page.getByRole('button', { name: id, exact: true })
                    : page.getByLabel(id, { exact: true })
            const fillCount = await loc.count()
            if (fillCount !== 1) throw new Error(`fill control "${id}" count=${fillCount} on tool=${tool}, want 1`)
            const disabled = await loc.evaluate((el) => (el as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled === true)
            if (disabled !== false) {
              throw new Error(`fill control "${id}" disabled=${disabled} on tool=${tool}, want false`)
            }
            const aria = await loc.evaluate((el) => el.getAttribute('aria-disabled'))
            if (aria !== null) throw new Error(`fill control "${id}" sets aria-disabled="${aria}" (honke/current: none)`)
          }
          for (const [testid, swap] of [['swap-fill-colors', 'fill']] as const) {
            const loc = page.getByTestId(testid)
            const swapCount = await loc.count()
            if (swapCount !== 1) throw new Error(`swap "${testid}" count=${swapCount} on tool=${tool}, want 1`)
            const disabled = await loc.evaluate((el) => (el as HTMLButtonElement).disabled === true)
            if (disabled !== false) throw new Error(`swap "${testid}" disabled=${disabled} on tool=${tool}, want false`)
          }
          {
            const loc = page.getByTestId('eyedropper-fill')
            const dropCount = await loc.count()
            if (dropCount !== 1) throw new Error(`eyedropper "eyedropper-fill" count=${dropCount} on tool=${tool}, want 1`)
            const disabled = await loc.evaluate((el) => (el as HTMLButtonElement).disabled === true)
            if (disabled !== false) throw new Error(`eyedropper "eyedropper-fill" disabled=${disabled} on tool=${tool}, want false`)
          }
          await closePopovers(page)
        } else {
          // Disabled fill: dialog unreachable.
          expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
          expect(await page.getByTestId('swap-fill-colors').count()).toBe(0)
          expect(await page.getByTestId('eyedropper-fill').count()).toBe(0)
        }
        // Stroke width stays inline (outside the Outline popover) in the
        // compact toolbar; it carries the same disabled gating.
        {
          const loc = page.getByLabel('Stroke width', { exact: true })
          expect(await loc.count()).toBe(1)
          const disabled = await loc.evaluate((el) => (el as HTMLInputElement).disabled === true)
          if (disabled !== wantStroke) throw new Error(`stroke control "Stroke width" disabled=${disabled} on tool=${tool}, want ${wantStroke}`)
          const aria = await loc.evaluate((el) => el.getAttribute('aria-disabled'))
          if (aria !== null) throw new Error(`stroke control "Stroke width" sets aria-disabled="${aria}" (honke/current: none)`)
        }
        if (!wantStroke) {
          await openOutlinePopover(page)
          for (const id of strokeDialogIds) {
            const loc =
              id === 'vector-stroke-gradient'
                ? page.getByTestId('vector-stroke-gradient')
                : id.endsWith('-hue') || id.endsWith('-saturation') || id.endsWith('-brightness')
                  ? page.getByTestId(id)
                  : id === 'Transparent stroke' || id === 'Transparent secondary stroke'
                    ? page.getByRole('button', { name: id, exact: true })
                    : page.getByLabel(id, { exact: true })
            const strokeCount = await loc.count()
            if (strokeCount !== 1) throw new Error(`stroke control "${id}" count=${strokeCount} on tool=${tool}, want 1`)
            const disabled = await loc.evaluate((el) => (el as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled === true)
            if (disabled !== false) {
              throw new Error(`stroke control "${id}" disabled=${disabled} on tool=${tool}, want false`)
            }
            const aria = await loc.evaluate((el) => el.getAttribute('aria-disabled'))
            if (aria !== null) throw new Error(`stroke control "${id}" sets aria-disabled="${aria}" (honke/current: none)`)
          }
          for (const [testid, swap] of [['swap-stroke-colors', 'stroke']] as const) {
            const loc = page.getByTestId(testid)
            const swapCount = await loc.count()
            if (swapCount !== 1) throw new Error(`swap "${testid}" count=${swapCount} on tool=${tool}, want 1`)
            const disabled = await loc.evaluate((el) => (el as HTMLButtonElement).disabled === true)
            if (disabled !== false) throw new Error(`swap "${testid}" disabled=${disabled} on tool=${tool}, want false`)
          }
          {
            const loc = page.getByTestId('eyedropper-stroke')
            const dropCount = await loc.count()
            if (dropCount !== 1) throw new Error(`eyedropper "eyedropper-stroke" count=${dropCount} on tool=${tool}, want 1`)
            const disabled = await loc.evaluate((el) => (el as HTMLButtonElement).disabled === true)
            if (disabled !== false) throw new Error(`eyedropper "eyedropper-stroke" disabled=${disabled} on tool=${tool}, want false`)
          }
          await closePopovers(page)
        } else {
          // Disabled stroke: dialog unreachable (Stroke width checked inline above).
          expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
          expect(await page.getByTestId('swap-stroke-colors').count()).toBe(0)
          expect(await page.getByTestId('eyedropper-stroke').count()).toBe(0)
        }
        // Focus parity: native `disabled` is unfocusable (honke CSS group stays
        // focusable; current impl intentionally uses native disabled per comment).
        // Enabled side: open its dialog and focus the inner color; disabled
        // side: trigger disabled and inner unmounted (both unfocusable).
        if (!wantFill) await openFillPopover(page)
        if (!wantStroke && wantFill) await openOutlinePopover(page)
        // When both sides enabled (select/oval/rect/reshape), only one dialog
        // can be open at a time: check fill focus while Fill open, then switch
        // to Outline for the stroke focus below.
        const focusProbe = await page.evaluate(
          ({ wantF, wantS }: { wantF: boolean; wantS: boolean }) => {
            const out: Record<string, boolean | null> = {}
            const tryFocus = (sel: string) => {
              const el = document.querySelector(sel) as HTMLElement | null
              if (!el) return null
              el.focus()
              return document.activeElement === el
            }
            // Fill inner only exists while its dialog is open; if disabled the
            // dialog is absent so this is null (unfocusable).
            const fillEl = document.querySelector('[aria-label="Paint color"]') as HTMLElement | null
            const strokeEl = document.querySelector('[aria-label="Stroke color"]') as HTMLElement | null
            out.fill = fillEl ? tryFocus('[aria-label="Paint color"]') : (wantF ? false : false)
            // When both enabled, stroke dialog is closed while fill open; treat
            // null as "check separately below", not failure.
            out.stroke = strokeEl ? tryFocus('[aria-label="Stroke color"]') : null
            return { out, wantF, wantS }
          },
          { wantF: wantFill, wantS: wantStroke },
        )
        if (!wantFill && focusProbe.out.fill !== true) {
          throw new Error(`focus: Paint color focusable=${focusProbe.out.fill} on tool=${tool}, want true`)
        }
        if (wantFill) {
          const fillTriggerFocusable = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="fill-style"]') as HTMLElement | null
            if (!el) return null
            el.focus()
            return document.activeElement === el
          })
          if (fillTriggerFocusable !== false) throw new Error(`focus: Fill trigger focusable=${fillTriggerFocusable} on tool=${tool}, want false (disabled)`)
        }
        await closePopovers(page)
        if (!wantStroke) await openOutlinePopover(page)
        const strokeFocusable = await page.evaluate(() => {
          const el = document.querySelector('[aria-label="Stroke color"]') as HTMLElement | null
          if (!el) return null
          el.focus()
          return document.activeElement === el
        })
        if (!wantStroke && strokeFocusable !== true) {
          throw new Error(`focus: Stroke color focusable=${strokeFocusable} on tool=${tool}, want true`)
        }
        if (wantStroke) {
          if (strokeFocusable !== null) throw new Error(`focus: Stroke color present while disabled on tool=${tool}`)
          const strokeTriggerFocusable = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="outline-style"]') as HTMLElement | null
            if (!el) return null
            el.focus()
            return document.activeElement === el
          })
          if (strokeTriggerFocusable !== false) throw new Error(`focus: Outline trigger focusable=${strokeTriggerFocusable} on tool=${tool}, want false (disabled)`)
        }
        await closePopovers(page)
        report.push(`tool=${tool} fillDisabled=${wantFill} strokeDisabled=${wantStroke}`)
      }
      console.log(`DISABLED-GUARD DOM report:\n${report.join('\n')}`)
      console.log(
        'HONKE-COMPARISON fill=LINE-only stroke=BRUSH/TEXT/FILL-only: match; ' +
          'DOM: honke=ancestor .disabled div (opacity .3, pointer-events none, focusable, no disabled attr) vs current=native disabled per control (unfocusable, announced dimmed); ' +
          'aria-disabled: neither sets it on these controls (match); ' +
          'popover contents (HSV/transparent/eyedropper/gradient/swap) all gated by the same side flag (match by construction above).',
      )

      // Bitmap mode: fill stays enabled via its popover (documented current
      // behavior; the reference bitmap row shows fill only, no outline).
      await page.getByTestId(/costume-card-\d+/).nth(1).getByRole('button', { name: /Select / }).click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 20_000 })
      expect(await page.getByTestId('fill-style').isDisabled()).toBe(false)
      expect(await page.getByTestId('outline-style').count()).toBe(0)
      expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
      await openFillPopover(page)
      {
        const loc = page.getByLabel('Paint color', { exact: true })
        const disabled = await loc.evaluate((el) => (el as HTMLInputElement).disabled === true)
        if (disabled !== false) throw new Error(`bitmap mode: "Paint color" disabled=${disabled}, want false`)
      }
      await closePopovers(page)
      await assertNoHmr(page, bootId, 'bitmap-both-enabled')
    } finally {
      await page.close().catch(() => undefined)
    }
  }, 180_000)

  it('tool switch closes newly-disabled eyedropper; disabled keyboard/mouse changes nothing', async () => {
    const { page, bootId } = await newSeededPage()
    try {
      await clickShape(page, 'left')
      await assertNoHmr(page, bootId, 'select-left')
      // NOTE: gradients stay solid here on purpose. Staging a non-solid
      // gradient would mark style-dirty flags whose async settle could land
      // mid-window and pollute the no-op byte comparison; secondary-side
      // disabled states are already covered exhaustively in the first test.
      await settle(page)

      // --- fill eyedropper auto-close on LINE switch ---
      // Compact toolbar: the eyedropper target lives in the Fill popover.
      await openFillPopover(page)
      const paintBeforeHex = await page.getByLabel('Paint color', { exact: true }).inputValue()
      await page.getByTestId('eyedropper-fill').click()
      await page.waitForFunction(() => !!document.querySelector('[data-testid="eyedropper-hint"]'), null, { timeout: 10_000 })
      await settle(page)
      const beforeFill = await domSnapshot(page)
      const beforeFillSig = await svgSignature(page)
      const beforeFillBytes = await byteSnapshot(page, 0)
      await clickVectorTool(page, 'line')
      await page.waitForFunction(() => !document.querySelector('[data-testid="eyedropper-hint"]'), null, { timeout: 10_000 })
      // Compact toolbar: the disabled Fill side keeps its swatch disabled and
      // its dialog (with eyedropper/swap) unmounted.
      expect(await page.getByTestId('fill-style').isDisabled()).toBe(true)
      expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
      expect(await page.getByTestId('eyedropper-fill').count()).toBe(0)
      expect(await page.getByTestId('swap-fill-colors').count()).toBe(0)
      await assertNoHmr(page, bootId, 'line-closes-fill-eyedropper')
      await settle(page)
      const afterSwitchFill = await domSnapshot(page)
      const afterSwitchFillSig = await svgSignature(page)
      const afterSwitchFillBytes = await byteSnapshot(page, 0)
      expect(afterSwitchFillSig).toBe(beforeFillSig)
      expect(afterSwitchFillBytes.text).toBe(beforeFillBytes.text)
      expect(afterSwitchFill.undoDisabled).toBe(beforeFill.undoDisabled)
      expect(afterSwitchFill.redoDisabled).toBe(beforeFill.redoDisabled)
      // Compact toolbar: the disabled Fill dialog is unmounted, so its inputs
      // read as null; the stored hex is preserved (checked via paintBeforeHex
      // after re-enabling below) while VM/history stay untouched here.
      // Eyedropper activation itself closes the Fill dialog (product
      // toggleEyedropper sets openStylePopover=null for the loupe overlay),
      // so beforeFill is also null-dialog (stored hex lives in paintBeforeHex).
      expect(afterSwitchFill.paintColor).toBe(null)
      expect(beforeFill.paintColor).toBe(null)

      // --- disabled fill-side real keyboard/mouse attempts change nothing ---
      // Compact toolbar: disabled Fill controls are unmounted (dialog absent,
      // trigger disabled), so there is no box to click and no input to fill.
      const paintBefore = paintBeforeHex
      expect(await page.getByTestId('fill-style').isDisabled()).toBe(true)
      expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
      for (const testid of ['eyedropper-fill', 'swap-fill-colors'] as const) {
        expect(await page.getByTestId(testid).count()).toBe(0)
      }
      expect(await page.getByRole('button', { name: 'Transparent fill' }).count()).toBe(0)
      // Playwright actionability: fill() on a missing input must block.
      let fillBlocked = false
      try {
        await page.getByLabel('Paint color', { exact: true }).fill('#00ff00', { timeout: 2_000 })
      } catch {
        fillBlocked = true
      }
      expect(fillBlocked).toBe(true)
      // Keyboard: the enabled stroke control (inside its popover) is focusable
      // while disabled fill controls are absent. NOTE: bare arrow keys are
      // global canvas nudge shortcuts (they move the selection and write
      // history), so keyboard coverage here is Tab traversal only: a disabled
      // control must never receive focus, hence Space/Enter can never
      // activate it.
      await openOutlinePopover(page)
      await page.getByLabel('Stroke color', { exact: true }).evaluate((el) => (el as HTMLElement).focus())
      expect(
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')),
      ).toBe('Stroke color')
      const fillFocusBlocked = await page.evaluate(() => {
        const el = document.querySelector('[aria-label="Paint color"]') as HTMLElement | null
        if (!el) return false
        el?.focus()
        return document.activeElement === el
      })
      expect(fillFocusBlocked).toBe(false)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
      // Real Tab walk starting inside the paint row (Stroke color is enabled
      // under LINE): the browser itself must skip every disabled fill stop.
      // The Fill dialog is absent, so no fill label can ever be focused.
      await page.getByLabel('Stroke color', { exact: true }).evaluate((el) => (el as HTMLElement).focus())
      const tabbedFillLabels: string[] = []
      for (let i = 0; i < 16; i += 1) {
        await page.keyboard.press('Tab')
        const label = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null
          if (!active || active === document.body) return ''
          return active.getAttribute('aria-label') ?? active.getAttribute('data-testid') ?? active.tagName
        })
        if (label) tabbedFillLabels.push(label)
      }
      const distinctFillStops = [...new Set(tabbedFillLabels)]
      console.log(`TAB walk from Stroke color (LINE tool): ${distinctFillStops.join(' | ')}`)
      for (const forbidden of ['Paint color', 'Secondary paint color', 'Transparent fill', 'Transparent secondary', 'Pick fill color', 'Swap fill colors', 'Vector paint style', 'Fill hue', 'Fill saturation', 'Fill brightness']) {
        if (distinctFillStops.includes(forbidden)) {
          throw new Error(`Tab walk landed on disabled fill control "${forbidden}" (tool=line)`)
        }
      }
      // Sanity: the walk really crossed the enabled stroke side of the row.
      // Compact toolbar: the Outline dialog holds the stroke side; the inline
      // Stroke width is the other enabled stop.
      const strokeStopsHit = distinctFillStops.filter((s) => /stroke|Stroke|width|outline-style|Vector stroke/i.test(s))
      if (strokeStopsHit.length < 1) throw new Error(`Tab walk never crossed the enabled stroke row (stops: ${distinctFillStops.join(', ')})`)
      await page.waitForTimeout(400)
      await assertNoHmr(page, bootId, 'disabled-fill-attempts')
      await settle(page)
      await closePopovers(page)
      const afterFillAttempts = await domSnapshot(page)
      const afterFillAttemptsSig = await svgSignature(page)
      const afterFillAttemptBytes = await byteSnapshot(page, 0)
      expect(afterFillAttemptsSig).toBe(afterSwitchFillSig)
      expect(afterFillAttemptBytes.text).toBe(afterSwitchFillBytes.text)
      expect(afterFillAttempts.paintColor).toBe(null)
      expect(afterFillAttempts.undoDisabled).toBe(afterSwitchFill.undoDisabled)
      expect(afterFillAttempts.redoDisabled).toBe(afterSwitchFill.redoDisabled)
      expect(afterFillAttempts.fillEyedropperPressed).toBe(null)
      expect(afterFillAttempts.eyedropperHint).toBe(false)
      // HSV sliders on the disabled side are unmounted with the dialog.
      expect(await page.getByTestId('fill-hue').count()).toBe(0)
      // Stored hex survives the disabled window: re-enable and read back.
      await clickVectorTool(page, 'select')
      await clickShape(page, 'left')
      await openFillPopover(page)
      expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe(paintBefore)

      // --- stroke eyedropper auto-close on FILL switch + disabled stroke no-op ---
      await clickVectorTool(page, 'select')
      await clickShape(page, 'left')
      await openOutlinePopover(page)
      const strokeBeforeHex = await page.getByLabel('Stroke color', { exact: true }).inputValue()
      await page.getByTestId('eyedropper-stroke').click()
      await page.waitForFunction(() => !!document.querySelector('[data-testid="eyedropper-hint"]'), null, { timeout: 10_000 })
      await settle(page)
      const beforeStroke = await domSnapshot(page)
      const beforeStrokeSig = await svgSignature(page)
      const beforeStrokeBytes = await byteSnapshot(page, 0)
      await clickVectorTool(page, 'fill')
      await page.waitForFunction(() => !document.querySelector('[data-testid="eyedropper-hint"]'), null, { timeout: 10_000 })
      // Compact toolbar: the disabled Outline side keeps its trigger disabled
      // and its dialog (with eyedropper/swap) unmounted.
      expect(await page.getByTestId('outline-style').isDisabled()).toBe(true)
      expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
      expect(await page.getByTestId('eyedropper-stroke').count()).toBe(0)
      expect(await page.getByTestId('swap-stroke-colors').count()).toBe(0)
      await assertNoHmr(page, bootId, 'fill-closes-stroke-eyedropper')
      await settle(page)
      const afterSwitchStroke = await domSnapshot(page)
      const afterSwitchStrokeSig = await svgSignature(page)
      const afterSwitchStrokeBytes = await byteSnapshot(page, 0)
      expect(afterSwitchStrokeSig).toBe(beforeStrokeSig)
      expect(afterSwitchStrokeBytes.text).toBe(beforeStrokeBytes.text)
      expect(afterSwitchStroke.undoDisabled).toBe(beforeStroke.undoDisabled)
      expect(afterSwitchStroke.redoDisabled).toBe(beforeStroke.redoDisabled)
      // Compact toolbar: disabled Outline dialog unmounted (null), stored hex
      // preserved (checked via strokeBeforeHex after re-enabling below).
      // Eyedropper activation itself closes the Outline dialog, so beforeStroke
      // is also null-dialog (stored hex lives in strokeBeforeHex).
      expect(afterSwitchStroke.strokeColor).toBe(null)
      expect(beforeStroke.strokeColor).toBe(null)

      const strokeBefore = strokeBeforeHex
      // Compact toolbar: disabled stroke controls are unmounted (no boxes).
      expect(await page.getByTestId('outline-style').isDisabled()).toBe(true)
      expect(await page.getByTestId('outline-style-dialog').count()).toBe(0)
      for (const testid of ['eyedropper-stroke', 'swap-stroke-colors'] as const) {
        expect(await page.getByTestId(testid).count()).toBe(0)
      }
      expect(await page.getByRole('button', { name: 'Transparent stroke' }).count()).toBe(0)
      let strokeFillBlocked = false
      try {
        await page.getByLabel('Stroke color', { exact: true }).fill('#00ff00', { timeout: 2_000 })
      } catch {
        strokeFillBlocked = true
      }
      expect(strokeFillBlocked).toBe(true)
      // Stroke width is the inline exception: it stays mounted but disabled
      // while FILL is active (reference parity), so it must block input.
      expect(await page.getByLabel('Stroke width', { exact: true }).isDisabled()).toBe(true)
      await openFillPopover(page)
      await page.getByLabel('Paint color', { exact: true }).evaluate((el) => (el as HTMLElement).focus())
      expect(
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')),
      ).toBe('Paint color')
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
      const strokeFocusBlocked = await page.evaluate(() => {
        const el = document.querySelector('[aria-label="Stroke color"]') as HTMLElement | null
        el?.focus()
        return document.activeElement === el
      })
      expect(strokeFocusBlocked).toBe(false)
      await page.getByLabel('Paint color', { exact: true }).evaluate((el) => (el as HTMLElement).focus())
      const tabbedStrokeLabels: string[] = []
      for (let i = 0; i < 16; i += 1) {
        await page.keyboard.press('Tab')
        const label = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null
          if (!active || active === document.body) return ''
          return active.getAttribute('aria-label') ?? active.getAttribute('data-testid') ?? active.tagName
        })
        if (label) tabbedStrokeLabels.push(label)
      }
      const distinctStrokeStops = [...new Set(tabbedStrokeLabels)]
      console.log(`TAB walk from Paint color (FILL tool): ${distinctStrokeStops.join(' | ')}`)
      for (const forbidden of ['Stroke color', 'Secondary stroke color', 'Transparent stroke', 'Transparent secondary stroke', 'Pick stroke color', 'Swap stroke colors', 'Vector stroke style', 'Stroke hue', 'Stroke saturation', 'Stroke brightness']) {
        if (distinctStrokeStops.includes(forbidden)) {
          throw new Error(`Tab walk landed on disabled stroke control "${forbidden}" (tool=fill)`)
        }
      }
      // Compact toolbar: Stroke width stays mounted but disabled while FILL is
      // active, so the walk must never land on it either.
      if (distinctStrokeStops.includes('Stroke width')) {
        throw new Error('Tab walk landed on disabled Stroke width (tool=fill)')
      }
      const fillStopsHit = distinctStrokeStops.filter((s) => /^(Paint|Transparent fill|Pick fill|Swap fill|Vector paint|Fill |Secondary paint|fill-style|outline-style)/i.test(s))
      if (fillStopsHit.length < 1) throw new Error(`Tab walk never crossed the enabled fill row (stops: ${distinctStrokeStops.join(', ')})`)
      await page.waitForTimeout(400)
      await assertNoHmr(page, bootId, 'disabled-stroke-attempts')
      await settle(page)
      await closePopovers(page)
      const afterStrokeAttempts = await domSnapshot(page)
      const afterStrokeAttemptsSig = await svgSignature(page)
      const afterStrokeAttemptBytes = await byteSnapshot(page, 0)
      expect(afterStrokeAttemptsSig).toBe(afterSwitchStrokeSig)
      expect(afterStrokeAttemptBytes.text).toBe(afterSwitchStrokeBytes.text)
      expect(afterStrokeAttempts.strokeColor).toBe(null)
      expect(afterStrokeAttempts.undoDisabled).toBe(afterSwitchStroke.undoDisabled)
      expect(afterStrokeAttempts.redoDisabled).toBe(afterSwitchStroke.redoDisabled)
      expect(afterStrokeAttempts.strokeEyedropperPressed).toBe(null)
      expect(await page.getByTestId('stroke-hue').count()).toBe(0)
      // Stored stroke hex survives: re-enable and read back.
      await clickVectorTool(page, 'select')
      await clickShape(page, 'left')
      await openOutlinePopover(page)
      expect(await page.getByLabel('Stroke color', { exact: true }).inputValue()).toBe(strokeBefore)
      console.log('DISABLED-NOOP verified: switch+auto-close and disabled keyboard/mouse left settings/svg/VM-bytes/history unchanged on both sides.')
    } finally {
      await page.close().catch(() => undefined)
    }
  }, 180_000)

  it('enabled sides edit selection/transparent/gradient/mixed with Undo/Redo (vector + bitmap)', async () => {
    const { page, bootId } = await newSeededPage()
    const applyStyle = () => page.getByTestId('apply-vector-style').click()
    try {
      await clickShape(page, 'left')
      await assertNoHmr(page, bootId, 'select-left')
      await settle(page)

      // --- enabled fill color edits the visible selection with Undo/Redo ---
      // Toolbar edits only stage values; Apply commits one history entry.
      // Compact toolbar: color lives in the Fill popover (Apply is inline and
      // closes the popover as an outside click, so re-open each time).
      await openFillPopover(page)
      await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
      await applyStyle()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'), null, { timeout: 15_000 })
      const filledBytes = await byteSnapshot(page, 0)
      expect(filledBytes.text).toContain('#00ff00')
      expect(await page.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(false)
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      expect((await byteSnapshot(page, 0)).text).toContain('#ff0000')
      await page.getByRole('button', { name: 'Redo' }).click()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'), null, { timeout: 15_000 })
      await assertNoHmr(page, bootId, 'fill-color-undoredo')

      // --- enabled transparent fill toggle with Undo/Redo ---
      await openFillPopover(page)
      await page.getByRole('button', { name: 'Transparent fill' }).click()
      await applyStyle()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return !html.includes('#00ff00')
      }, null, { timeout: 15_000 })
      const transparentSig = await svgSignature(page)
      expect(transparentSig).not.toContain('#00ff00')
      expect(await page.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(false)
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'), null, { timeout: 15_000 })
      await page.getByRole('button', { name: 'Redo' }).click()
      await settle(page)
      expect(await svgSignature(page)).toBe(transparentSig)
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'), null, { timeout: 15_000 })
      // Restore the opaque stored flag Apply may have left behind: untoggle if
      // pressed, then Apply so later steps start opaque.
      await openFillPopover(page)
      if ((await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')) === 'true') {
        await page.getByRole('button', { name: 'Transparent fill' }).click()
        await applyStyle()
        await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'), null, { timeout: 15_000 })
      }
      await assertNoHmr(page, bootId, 'transparent-fill-undoredo')

      // --- enabled HSV slider live-edits with Undo/Redo (solid fill) ---
      // This case exercises solid-fill HSV. Gradient HSV is checked separately
      // in vector-hsv-gradient-live.browser.test.ts; differing selection and
      // asynchronous timing conditions should not be inferred from this case.
      await openFillPopover(page)
      await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
      await applyStyle()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      await setHsv(page, 'fill-hue', 80)
      await page.waitForFunction(() => !document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      const hsvSig = await svgSignature(page)
      expect(hsvSig).not.toContain('#ff0000')
      expect(await page.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(false)
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'), null, { timeout: 15_000 })
      await page.getByRole('button', { name: 'Redo' }).click()
      await settle(page)
      expect(await svgSignature(page)).toBe(hsvSig)
      await assertNoHmr(page, bootId, 'hsv-undoredo')

      // --- enabled gradient + secondary with Undo/Redo ---
      await openFillPopover(page)
      await page.getByLabel('Vector paint style').selectOption('horizontal')
      await page.waitForFunction(() => !!document.querySelector('[aria-label="Secondary paint color"]'), null, { timeout: 10_000 })
      await page.getByLabel('Secondary paint color').fill('#0000ff')
      await applyStyle()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return html.includes('#0000ff') && /lineargradient|radialgradient/i.test(html)
      }, null, { timeout: 15_000 })
      const gradientBytes = await byteSnapshot(page, 0)
      expect(gradientBytes.text).toContain('#0000ff')
      expect(gradientBytes.text).toMatch(/lineargradient/i)
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return !/lineargradient/i.test(html)
      }, null, { timeout: 15_000 })
      const afterGradientUndo = await byteSnapshot(page, 0)
      // NOTE: the right rect keeps its original #0000ff fill, so the assertion
      // targets the gradient defs (present only while the ramp is applied).
      expect(afterGradientUndo.text).not.toMatch(/lineargradient/i)
      await page.getByRole('button', { name: 'Redo' }).click()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return html.includes('#0000ff')
      }, null, { timeout: 15_000 })
      await assertNoHmr(page, bootId, 'gradient-secondary-undoredo')

      // --- enabled swap exchanges stored colors without artwork/history ---
      // Compact toolbar: swap lives in the Fill popover; snapshots need the
      // dialog open to read the stored hexes.
      await openFillPopover(page)
      const swapBefore = await domSnapshot(page)
      const swapBeforeSig = await svgSignature(page)
      const swapBeforeBytes = await byteSnapshot(page, 0)
      await page.getByTestId('swap-fill-colors').click()
      await page.waitForTimeout(400)
      const swapAfter = await domSnapshot(page)
      const swapAfterBytes = await byteSnapshot(page, 0)
      expect(swapAfter.paintColor).toBe(swapBefore.secondaryPaintColor)
      expect(swapAfter.secondaryPaintColor).toBe(swapBefore.paintColor)
      expect(await svgSignature(page)).toBe(swapBeforeSig)
      expect(swapAfterBytes.text).toBe(swapBeforeBytes.text)
      expect(swapAfter.undoDisabled).toBe(swapBefore.undoDisabled)
      expect(swapAfter.redoDisabled).toBe(swapBefore.redoDisabled)
      // Swap back for the mixed-normalization step below.
      await page.getByTestId('swap-fill-colors').click()
      await page.waitForTimeout(400)
      await assertNoHmr(page, bootId, 'swap-noop')

      // --- enabled MIXED selection edits both, Undo restores mixed ---
      // Normalize the left rect to solid #ff0000 first (right stays #0000ff).
      await openFillPopover(page)
      await page.getByLabel('Vector paint style').selectOption('solid')
      await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
      await applyStyle()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return html.includes('#ff0000')
      }, null, { timeout: 15_000 })
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
      await page.getByLabel('Paint color', { exact: true }).fill('#00ffff')
      await applyStyle()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return html.includes('#00ffff') && !document.querySelector('[data-testid="mixed-fill"]')
      }, null, { timeout: 15_000 })
      const mixedBytes = await byteSnapshot(page, 0)
      expect(mixedBytes.text).toContain('#00ffff')
      await page.getByRole('button', { name: 'Undo' }).click()
      await openFillPopover(page)
      await page.waitForFunction(() => !!document.querySelector('[data-testid="mixed-fill"]'), null, { timeout: 15_000 })
      const mixedRestored = await page.locator('.vector-preview').innerHTML()
      expect(mixedRestored).toContain('#ff0000')
      await page.getByRole('button', { name: 'Redo' }).click()
      await openFillPopover(page)
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return html.includes('#00ffff') && !document.querySelector('[data-testid="mixed-fill"]')
      }, null, { timeout: 15_000 })
      await assertNoHmr(page, bootId, 'mixed-undoredo')

      // --- enabled stroke color + width with Undo/Redo (single Apply entry) ---
      // The mixed step leaves a multi-selection; Escape clears it (selection
      // only, no artwork/history), then re-select the left rect alone.
      // Compact toolbar: the Fill dialog is open here with focus in a typing
      // target, so a single Escape only closes the dialog (Editor skips
      // shortcuts from typing targets). Close first, then Escape deselects.
      await closePopovers(page)
      await page.keyboard.press('Escape')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-vector-object][data-vector-selection-outline].border-blue-500').length === 0,
        null,
        { timeout: 10_000 },
      )
      await clickShape(page, 'left')
      // Width writes through immediately on change (own entry); the color
      // commits via Apply (own entry). Verified as two single-step entries.
      await setStrokeWidth(page, 12)
      await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('stroke-width="6"'), null, { timeout: 15_000 })
      await openOutlinePopover(page)
      await page.getByLabel('Stroke color', { exact: true }).fill('#ff00ff')
      await applyStyle()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return html.includes('#ff00ff') && html.includes('stroke-width="6"')
      }, null, { timeout: 15_000 })
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return !html.includes('#ff00ff') && html.includes('stroke-width="6"')
      }, null, { timeout: 15_000 })
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return !html.includes('#ff00ff') && !html.includes('stroke-width="6"')
      }, null, { timeout: 15_000 })
      await page.getByRole('button', { name: 'Redo' }).click()
      await page.getByRole('button', { name: 'Redo' }).click()
      await page.waitForFunction(() => {
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        return html.includes('#ff00ff') && html.includes('stroke-width="6"')
      }, null, { timeout: 15_000 })
      await assertNoHmr(page, bootId, 'stroke-undoredo')

      // --- bitmap transparent brush erases with Undo/Redo + VM bytes move ---
      await page.getByTestId(/costume-card-\d+/).nth(1).getByRole('button', { name: /Select / }).click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForFunction(() => {
        const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
        if (!c) return false
        try {
          const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
          for (let i = 3; i < img.data.length; i += 4) if ((img.data[i] ?? 0) !== 0) return true
          return false
        } catch { return false }
      }, undefined, { timeout: 20_000 })
      const canvas = page.getByTestId('bitmap-editor-canvas')
      const box = await canvas.boundingBox()
      if (!box) throw new Error('bitmap canvas missing (stale layout?)')
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.getByTestId('bitmap-tool-brush').click()
      await openFillPopover(page)
      await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
      await page.mouse.move(x - 8, y)
      await page.mouse.down()
      await page.mouse.move(x + 8, y, { steps: 8 })
      await page.mouse.up()
      await page.waitForFunction(() => {
        const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = t.getContext('2d')!.getImageData(Math.floor(t.width / 2), Math.floor(t.height / 2), 1, 1).data
        return r > 200 && g < 40 && b < 40 && a === 255
      }, null, { timeout: 15_000 })
      const opaqueBytes = await byteSnapshot(page, 1)
      await openFillPopover(page)
      await page.getByRole('button', { name: 'Transparent fill' }).click()
      expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe('#ff0000')
      await page.mouse.move(x - 8, y)
      await page.mouse.down()
      await page.mouse.move(x + 8, y, { steps: 8 })
      await page.mouse.up()
      await page.waitForFunction(() => {
        const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return t.getContext('2d')!.getImageData(Math.floor(t.width / 2), Math.floor(t.height / 2), 1, 1).data[3] === 0
      }, null, { timeout: 15_000 })
      const erasedBytes = await byteSnapshot(page, 1)
      expect(erasedBytes.md5).not.toBe(opaqueBytes.md5)
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => {
        const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = t.getContext('2d')!.getImageData(Math.floor(t.width / 2), Math.floor(t.height / 2), 1, 1).data
        return r > 200 && g < 40 && b < 40 && a === 255
      }, null, { timeout: 15_000 })
      await page.getByRole('button', { name: 'Redo' }).click()
      await page.waitForFunction(() => {
        const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return t.getContext('2d')!.getImageData(Math.floor(t.width / 2), Math.floor(t.height / 2), 1, 1).data[3] === 0
      }, null, { timeout: 15_000 })
      await assertNoHmr(page, bootId, 'bitmap-transparent-undoredo')
      console.log('ENABLED-EDIT verified: visible selection fill/transparent/gradient/secondary/swap/HSV/mixed + stroke color/width + bitmap transparent all change with Undo/Redo.')
    } finally {
      await page.close().catch(() => undefined)
    }
  }, 240_000)
})
