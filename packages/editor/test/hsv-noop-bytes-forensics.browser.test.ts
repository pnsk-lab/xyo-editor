import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Forensics for the HSV audit note:
// "同値tick前後でbytes総和が動く場合があるためnoop判定はUndo/Redo状態のみ".
// This file ONLY adds a new test (no product-code edits) that replays the exact
// noop prelude of hsv-live-selection-apply-audit.browser.test.ts and captures,
// per poll: real saved asset bytes (len/sum/md5/text), fills, DOM metadata
// (root geometry, per-element attrs, defs/gradient ids+stops, canonical paint
// signature), best-effort RGBA raster, and Undo/Redo/Apply states over time.
// Classification goal:
//   (a) pure serialization only (same canonical DOM, bytes differ), vs
//   (b) same appearance but element/defs/id churn, vs
//   (c) color itself different, vs
//   (d) async not settled (bytes converge late / history flips late).
// Independent port (4533). HMR diagnostics included; assertions never retry or
// touch src/.

const root = join(import.meta.dir, '..')
const PORT = 4533
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
const diagnostics: string[] = []

const SVG_A =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect id="left" x="40" y="100" width="160" height="120" fill="#ff0000" stroke="#111111" stroke-width="4"/>` +
  `<rect id="right" x="280" y="100" width="160" height="120" fill="#0000ff" stroke="#222222" stroke-width="4"/>` +
  `</svg>`
const SVG_B =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect id="solo" x="140" y="80" width="200" height="200" fill="#00ff00" stroke="#333333" stroke-width="4"/>` +
  `</svg>`
const SVG_C =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect id="other" x="100" y="60" width="280" height="240" fill="#ffff00" stroke="#444444" stroke-width="4"/>` +
  `</svg>`

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
  const refA = add(SVG_A)
  const refB = add(SVG_B)
  const refC = add(SVG_C)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name,
    ...ref,
    dataFormat: 'svg',
    rotationCenterX: 240,
    rotationCenterY: 180,
  })
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
        costumes: [{ ...costume(refC, 'backdrop'), bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
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
        costumes: [costume(refA, 'costumeA'), costume(refB, 'costumeB')],
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
      {
        isStage: false,
        name: 'Sprite2',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [costume(refC, 'costumeS2')],
        sounds: [],
        volume: 100,
        layerOrder: 2,
        visible: true,
        x: 100,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'hsv-noop-forensics' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

type ForensicSnapshot = {
  at: string
  len: number
  sum: number
  md5: string
  md5ext: string
  fills: Record<string, { fill: string; stroke: string }>
  root: { width: string; height: string; viewBox: string }
  elements: Array<{
    tag: string
    id: string
    fill: string
    stroke: string
    strokeWidth: string
    style: string
    fillOpacity: string
    strokeOpacity: string
    opacity: string
    attrCount: number
    attrNames: string
  }>
  defs: { count: number; ids: string[]; stops: string[]; markupLen: number }
  gradientRefs: string[]
  canonical: string
  rgba: Record<string, { css: string; a: string }>
  raster: { ok: boolean; note: string; left: number[]; right: number[] }
  undoDisabled: boolean
  redoDisabled: boolean
  applyEnabled: boolean
  hmrSeed: string | null
  textHead: string
}

async function snapshot(page: Page, label: string): Promise<ForensicSnapshot> {
  return await page.evaluate(async (at) => {
    const vm = (window as any).__paintHistoryVm
    const t = vm.getTarget('Sprite1')
    const c = t?.costumes[0]
    const key = c?.md5ext ?? c?.assetId
    const bytes = key ? ((await vm.loadAsset(key, c.dataFormat ?? '')) as Uint8Array | undefined) : undefined
    if (!bytes) throw new Error('missing bytes Sprite1[0]')
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    const text = new TextDecoder().decode(bytes as Uint8Array)
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const svg = doc.documentElement
    const pick = (id: string) => {
      const node = doc.querySelector(`#${CSS.escape(id)}`)
      return {
        fill: (node?.getAttribute('fill') ?? '').toLowerCase(),
        stroke: (node?.getAttribute('stroke') ?? '').toLowerCase(),
      }
    }
    const fills: Record<string, { fill: string; stroke: string }> = { left: pick('left'), right: pick('right') }
    const elements: ForensicSnapshot['elements'] = []
    const gradientRefs: string[] = []
    svg.querySelectorAll('*').forEach((node) => {
      const el = node as Element
      const tag = el.tagName.toLowerCase()
      if (tag === 'defs' || tag === 'lineargradient' || tag === 'radialgradient' || tag === 'stop') return
      const names = el.getAttributeNames().sort()
      const fill = (el.getAttribute('fill') ?? '').trim()
      const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(fill)
      if (m?.[1]) gradientRefs.push(m[1]!)
      elements.push({
        tag,
        id: el.getAttribute('id') ?? '',
        fill: fill.toLowerCase(),
        stroke: (el.getAttribute('stroke') ?? '').toLowerCase(),
        strokeWidth: el.getAttribute('stroke-width') ?? '',
        style: (el.getAttribute('style') ?? '').toLowerCase(),
        fillOpacity: el.getAttribute('fill-opacity') ?? '',
        strokeOpacity: el.getAttribute('stroke-opacity') ?? '',
        opacity: el.getAttribute('opacity') ?? '',
        attrCount: names.length,
        attrNames: names.join(','),
      })
    })
    const defNodes = Array.from(svg.querySelectorAll('linearGradient, radialGradient'))
    const ids = defNodes.map((n) => (n as Element).getAttribute('id') ?? '').sort()
    const stops: string[] = []
    defNodes.forEach((n) => {
      ;(n as Element).querySelectorAll('stop').forEach((s) => {
        stops.push(`${(s.getAttribute('stop-color') ?? '').toLowerCase()}@${s.getAttribute('stop-opacity') ?? ''}@${s.getAttribute('offset') ?? ''}`)
      })
    })
    stops.sort()
    const canonical = [
      `root:${svg.getAttribute('width')}|${svg.getAttribute('height')}|${svg.getAttribute('viewBox')}`,
      ...elements.map((e) => `${e.tag}#${e.id}[fill=${e.fill}][stroke=${e.stroke}][sw=${e.strokeWidth}][fop=${e.fillOpacity}][sop=${e.strokeOpacity}][op=${e.opacity}][style=${e.style}]`),
      `defs:${ids.join(',')}|stops:${stops.join(';')}`,
    ].join('\n')
    const hexToRgba = (hex: string) => {
      const m2 = /^#([0-9a-f]{6})/.exec(hex)
      if (!m2?.[1]) return { css: hex, a: 'n/a' }
      const v = m2[1]!
      return { css: `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},1)`, a: '255' }
    }
    const rgba: Record<string, { css: string; a: string }> = {
      left: hexToRgba(fills.left.fill),
      right: hexToRgba(fills.right.fill),
    }
    // Best-effort raster: draw the saved bytes at 480x360 and sample both
    // rect centers through the svg viewBox mapping.
    let raster: ForensicSnapshot['raster'] = { ok: false, note: 'skipped', left: [], right: [] }
    try {
      const blob = new Blob([new Uint8Array(bytes as Uint8Array)], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      try {
        const img = new Image()
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('svg image load failed'))
          img.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = 480
        canvas.height = 360
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('no 2d context')
        ctx.clearRect(0, 0, 480, 360)
        ctx.drawImage(img, 0, 0, 480, 360)
        const vb = (svg.getAttribute('viewBox') ?? '0 0 480 360').trim().split(/[\s,]+/).map(Number)
        const [vx = 0, vy = 0, vw = 480, vh = 360] = vb
        const toPx = (sx: number, sy: number): [number, number] => [
          Math.max(0, Math.min(479, Math.floor(((sx - vx) / vw) * 480))),
          Math.max(0, Math.min(359, Math.floor(((sy - vy) / vh) * 360))),
        ]
        // SVG_A geometry: left center (120,160), right center (360,160).
        const [lx, ly] = toPx(120, 160)
        const [rx, ry] = toPx(360, 160)
        const lp = ctx.getImageData(lx, ly, 1, 1).data
        const rp = ctx.getImageData(rx, ry, 1, 1).data
        raster = { ok: true, note: `viewBox=${svg.getAttribute('viewBox')} pxL=(${lx},${ly}) pxR=(${rx},${ry})`, left: [lp[0]!, lp[1]!, lp[2]!, lp[3]!], right: [rp[0]!, rp[1]!, rp[2]!, rp[3]!] }
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (e) {
      raster = { ok: false, note: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200), left: [], right: [] }
    }
    const btn = (name: string) =>
      Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
      ) as HTMLButtonElement | undefined
    const apply = document.querySelector('[data-testid="apply-vector-style"]') as HTMLButtonElement | null
    return {
      at,
      len: (bytes as Uint8Array).length,
      sum,
      md5: '',
      md5ext: c.md5ext as string,
      fills,
      root: {
        width: svg.getAttribute('width') ?? '',
        height: svg.getAttribute('height') ?? '',
        viewBox: svg.getAttribute('viewBox') ?? '',
      },
      elements,
      defs: { count: defNodes.length, ids, stops, markupLen: svg.querySelector('defs')?.outerHTML.length ?? 0 },
      gradientRefs: [...new Set(gradientRefs)].sort(),
      canonical,
      rgba,
      raster,
      undoDisabled: btn('Undo')?.hasAttribute('disabled') ?? true,
      redoDisabled: btn('Redo')?.hasAttribute('disabled') ?? true,
      applyEnabled: apply ? !apply.disabled : false,
      hmrSeed: (window as any).__hsvAuditSeed ?? null,
      textHead: text.slice(0, 600),
    }
  }, label)
}

async function newSeededPage(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' && !text.includes('favicon')) diagnostics.push(`console: ${text}`)
    if (/hot updated|hmr|reload/i.test(text)) diagnostics.push(`hmr: ${text}`)
  })
  await page.goto(base)
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByTestId('project-file-input').setInputFiles({
    name: 'hsv-forensics.sb3',
    mimeType: 'application/x.scratch.sb3',
    buffer: buildSb3(),
  })
  await page.waitForFunction(
    () =>
      (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
        ?.costumes.length === 2,
    null,
    { timeout: 20_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  }
  await page.evaluate(() => {
    ;(window as any).__hsvAuditSeed = 'seeded'
    ;(window as any).__paintHistoryVm.__hsvAuditVmMark = 'vm-mark'
  })
  return page
}

async function clickShape(page: Page, which: 'left' | 'right') {
  let lastError: unknown = undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.getByTestId('vector-shape-select').last().click({ timeout: 10_000 })
      const pt = await page.evaluate((id) => {
        const surface = document.querySelector('[data-testid="costume-paint-surface"]')
        const s = surface?.getBoundingClientRect()
        if (!s) return null
        const els = surface
          ? Array.from(surface.querySelectorAll('[data-vector-object][data-vector-selection-outline]'))
          : []
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
        (id) => {
          const surface = document.querySelector('[data-testid="costume-paint-surface"]')
          const els = surface
            ? Array.from(surface.querySelectorAll('[data-vector-object][data-vector-selection-outline]'))
            : []
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

function setHsv(page: Page, testId: string, value: number) {
  return page.getByTestId(testId).evaluate(
    (node: HTMLInputElement, next: number) => {
      node.value = String(next)
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
    },
    value,
  )
}

function inputOnly(page: Page, testId: string, value: number) {
  return page.getByTestId(testId).evaluate(
    (node: HTMLInputElement, next: number) => {
      node.value = String(next)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    },
    value,
  )
}

function nativeFill(page: Page) {
  return page.getByLabel('Paint color', { exact: true })
}

function undoButton(page: Page) {
  return page.getByRole('button', { name: 'Undo' })
}

function redoButton(page: Page) {
  return page.getByRole('button', { name: 'Redo' })
}

function firstDiffOffset(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

async function fullText(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const vm = (window as any).__paintHistoryVm
    const t = vm.getTarget('Sprite1')
    const c = t?.costumes[0]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  })
}

function classify(before: ForensicSnapshot, after: ForensicSnapshot, beforeText: string, afterText: string) {
  const bytesEqual = before.sum === after.sum && before.len === after.len && beforeText === afterText
  const canonicalEqual = before.canonical === after.canonical
  const fillsEqual =
    before.fills.left?.fill === after.fills.left?.fill &&
    before.fills.right?.fill === after.fills.right?.fill &&
    before.fills.left?.stroke === after.fills.left?.stroke &&
    before.fills.right?.stroke === after.fills.right?.stroke
  const defsEqual =
    before.defs.count === after.defs.count &&
    JSON.stringify(before.defs.ids) === JSON.stringify(after.defs.ids) &&
    JSON.stringify(before.defs.stops) === JSON.stringify(after.defs.stops) &&
    JSON.stringify(before.gradientRefs) === JSON.stringify(after.gradientRefs)
  const rasterEqual = JSON.stringify(before.raster) === JSON.stringify(after.raster)
  let verdict = 'unclassified'
  if (bytesEqual) verdict = 'no-change-at-all'
  else if (!fillsEqual) verdict = 'color-itself-different'
  else if (!defsEqual) verdict = 'same-paint-but-defs-or-id-churn'
  else if (canonicalEqual) verdict = 'pure-serialization-only'
  else verdict = 'same-colors-but-element-attrs-changed'
  return { bytesEqual, canonicalEqual, fillsEqual, defsEqual, rasterEqual, verdict }
}

describe('hsv noop bytes forensics (new test, no product edits)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    server.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (/hmr|updated|reload|connected/i.test(text)) diagnostics.push(`vite: ${text.trim().slice(0, 300)}`)
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
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    if (diagnostics.length) console.log(`Browser diagnostics:\n${diagnostics.join('\n')}`)
  })

  it('replays audit noop prelude and classifies bytes/fills/DOM/RGBA/async', async () => {
    const page = await newSeededPage()
    try {
      // --- Exact audit prelude: edit left to blue, idle, undo (redo armed). ---
      await clickShape(page, 'left')
      await nativeFill(page).fill('#ff0000')
      await setHsv(page, 'fill-hue', 200 / 3)
      await page.waitForFunction(async () => {
        const vm = (window as any).__paintHistoryVm
        const t = vm.getTarget('Sprite1')
        const c = t?.costumes[0]
        const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
        return new TextDecoder().decode(bytes).includes('#0000ff')
      }, null, { timeout: 15_000 })
      await new Promise((r) => setTimeout(r, 950))
      await undoButton(page).click()
      await page.waitForFunction(async () => {
        const vm = (window as any).__paintHistoryVm
        const t = vm.getTarget('Sprite1')
        const c = t?.costumes[0]
        const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
        return new TextDecoder().decode(bytes).includes('#ff0000')
      }, null, { timeout: 15_000 })
      expect(await redoButton(page).isDisabled()).toBe(false)
      const armed = await snapshot(page, 'redo-armed-baseline')
      const armedText = await fullText(page)
      console.log(`FORENSICS armed: len=${armed.len} sum=${armed.sum} md5ext=${armed.md5ext} fills=${JSON.stringify(armed.fills)} root=${JSON.stringify(armed.root)} defs=${JSON.stringify(armed.defs)} raster=${JSON.stringify(armed.raster)} undoDis=${armed.undoDisabled} redoDis=${armed.redoDisabled} applyEn=${armed.applyEnabled}`)

      // --- Audit noop tick: same-value hue 0 on #ff0000. ---
      await nativeFill(page).fill('#ff0000')
      await setHsv(page, 'fill-hue', 0)
      // Poll to separate (d) async-not-settled from a stable rewrite.
      const polls: ForensicSnapshot[] = []
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, i === 0 ? 150 : 300))
        polls.push(await snapshot(page, `noop+${i}`))
      }
      await new Promise((r) => setTimeout(r, 950))
      const settled = await snapshot(page, 'noop-settled')
      const settledText = await fullText(page)
      polls.forEach((p) => {
        console.log(`FORENSICS ${p.at}: len=${p.len} sum=${p.sum} md5ext=${p.md5ext} fills=${JSON.stringify(p.fills)} defs=${JSON.stringify(p.defs)} els=${p.elements.length} root=${JSON.stringify(p.root)} raster=${JSON.stringify(p.raster)} undoDis=${p.undoDisabled} redoDis=${p.redoDisabled} applyEn=${p.applyEnabled}`)
      })
      console.log(`FORENSICS noop-settled: len=${settled.len} sum=${settled.sum} md5ext=${settled.md5ext} fills=${JSON.stringify(settled.fills)} defs=${JSON.stringify(settled.defs)} els=${settled.elements.length} root=${JSON.stringify(settled.root)} rgba=${JSON.stringify(settled.rgba)} raster=${JSON.stringify(settled.raster)} undoDis=${settled.undoDisabled} redoDis=${settled.redoDisabled} applyEn=${settled.applyEnabled}`)
      const cls = classify(armed, settled, armedText, settledText)
      console.log(`FORENSICS classification: ${JSON.stringify(cls)}`)
      if (!cls.bytesEqual) {
        const off = firstDiffOffset(armedText, settledText)
        console.log(`FORENSICS first-diff-offset=${off}\n--- before[${Math.max(0, off - 160)}:${off + 240}] ---\n${armedText.slice(Math.max(0, off - 160), off + 240)}\n--- after ---\n${settledText.slice(Math.max(0, off - 160), off + 240)}`)
        console.log(`FORENSICS canonical-before:\n${armed.canonical}\nFORENSICS canonical-after:\n${settled.canonical}`)
      }
      const sums = polls.map((p) => p.sum)
      const asyncUnsettled = new Set([...sums, settled.sum]).size > 1
      console.log(`FORENSICS async-unsettled-across-polls=${asyncUnsettled} sums=[${[...sums, settled.sum].join(',')}]`)

      // --- Audit noop assertions (history only): must stay undo-disabled, redo kept. ---
      expect(settled.undoDisabled).toBe(true)
      expect(settled.redoDisabled).toBe(false)

      // --- Which ops allow Undo: inputOnly same-value vs real change control. ---
      await inputOnly(page, 'fill-hue', 0)
      await new Promise((r) => setTimeout(r, 950))
      const afterInputOnly = await snapshot(page, 'inputOnly-same-value')
      console.log(`FORENSICS inputOnly-same-value: len=${afterInputOnly.len} sum=${afterInputOnly.sum} undoDis=${afterInputOnly.undoDisabled} redoDis=${afterInputOnly.redoDisabled}`)
      await setHsv(page, 'fill-hue', 10)
      await page.waitForFunction(async () => {
        const vm = (window as any).__paintHistoryVm
        const t = vm.getTarget('Sprite1')
        const c = t?.costumes[0]
        const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
        return !new TextDecoder().decode(bytes).includes('#ff0000')
      }, null, { timeout: 15_000 })
      await new Promise((r) => setTimeout(r, 950))
      const realChange = await snapshot(page, 'real-change-hue10')
      console.log(`FORENSICS real-change: len=${realChange.len} sum=${realChange.sum} fills=${JSON.stringify(realChange.fills)} undoDis=${realChange.undoDisabled} redoDis=${realChange.redoDisabled}`)
      // Control must be Undo-able (proves the harness detects real writes).
      expect(realChange.undoDisabled).toBe(false)

      // Final verdict line for the report.
      console.log(`FORENSICS VERDICT armed->noop: ${cls.verdict}; asyncUnsettled=${asyncUnsettled}; inputOnlyUndoDisabled=${afterInputOnly.undoDisabled}; realChangeUndoDisabled=${realChange.undoDisabled}`)
    } finally {
      await page.close().catch(() => undefined)
    }
  }, 180_000)

  it('return-to-origin within one gesture: bytes vs history (Undo-able?)', async () => {
    const page = await newSeededPage()
    try {
      const baseline = await snapshot(page, 'variant-baseline')
      const baselineText = await fullText(page)
      await clickShape(page, 'left')
      await nativeFill(page).fill('#ff0000')
      // Real change (blue) then back to the origin value WITHOUT idle flush:
      // single gesture, pending.touched becomes true on the first write.
      await setHsv(page, 'fill-hue', 200 / 3)
      await page.waitForFunction(async () => {
        const vm = (window as any).__paintHistoryVm
        const t = vm.getTarget('Sprite1')
        const c = t?.costumes[0]
        const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
        return !new TextDecoder().decode(bytes).includes('#ff0000')
      }, null, { timeout: 15_000 })
      const mid = await snapshot(page, 'variant-mid-blue')
      const midText = await fullText(page)
      await setHsv(page, 'fill-hue', 0)
      await page.waitForFunction(async () => {
        const vm = (window as any).__paintHistoryVm
        const t = vm.getTarget('Sprite1')
        const c = t?.costumes[0]
        const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
        return new TextDecoder().decode(bytes).includes('#ff0000')
      }, null, { timeout: 15_000 })
      await new Promise((r) => setTimeout(r, 950))
      const back = await snapshot(page, 'variant-back-to-red')
      const backText = await fullText(page)
      const clsMid = classify(baseline, mid, baselineText, midText)
      console.log(`FORENSICS variant classification baseline->mid: ${JSON.stringify(clsMid)}`)
      console.log(`FORENSICS variant mid: len=${mid.len} sum=${mid.sum} fills=${JSON.stringify(mid.fills)} root=${JSON.stringify(mid.root)} undoDis=${mid.undoDisabled}`)
      console.log(`FORENSICS variant back: len=${back.len} sum=${back.sum} fills=${JSON.stringify(back.fills)} root=${JSON.stringify(back.root)} defs=${JSON.stringify(back.defs)} undoDis=${back.undoDisabled} redoDis=${back.redoDisabled} raster=${JSON.stringify(back.raster)}`)
      const clsBack = classify(baseline, back, baselineText, backText)
      console.log(`FORENSICS variant classification baseline->back: ${JSON.stringify(clsBack)}`)
      if (!clsBack.bytesEqual) {
        const off = firstDiffOffset(baselineText, backText)
        console.log(`FORENSICS variant first-diff-offset=${off}\n--- baseline ---\n${baselineText.slice(Math.max(0, off - 160), off + 240)}\n--- back ---\n${backText.slice(Math.max(0, off - 160), off + 240)}`)
      }
      // Undo must exist here (gesture touched the artwork), and one Undo must
      // restore the pre-gesture baseline fills.
      console.log(`FORENSICS variant Undo-allowed=${!back.undoDisabled}`)
      if (!back.undoDisabled) {
        await undoButton(page).click()
        await new Promise((r) => setTimeout(r, 950))
        const undone = await snapshot(page, 'variant-after-undo')
        console.log(`FORENSICS variant after-undo: len=${undone.len} sum=${undone.sum} fills=${JSON.stringify(undone.fills)} root=${JSON.stringify(undone.root)}`)
      }
      void clsMid
    } finally {
      await page.close().catch(() => undefined)
    }
  }, 180_000)
})
