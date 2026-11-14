// Group-leaf whole-translate integration (real Editor + real VM, persistent).
//
// Scope: the planner-only suites (`vector-group-leaf-translate.test.ts` and
// `vector-group-leaf-translate.browser.test.ts`) never drive the costume UI:
// the former is pure stubs, the latter asserts detached-clone math against
// `DOMMatrix`/Paper oracles. The temporary real-UI verification done during
// integration was deleted. THIS file is the only persistent coverage that
// drags group leaves with the real reshape tool on the real canvas.
//
// Every claim below is exercised through the REAL costume editor UI
// (select/reshape/fill tools, real mouse drags, Undo/Redo buttons, costume
// and target switches) and checked against the REAL VM saved SVG bytes
// (`__paintHistoryVm.loadAsset`) plus REAL live layout (`getBoundingClientRect`
// on the preview) and canvas screenshots. No `src/` helper is imported here:
// planner/geometry modules are never a substitute oracle in this file.
//
// Self-made fixtures only (no upstream transcription). Dedicated Vite port
// 4497 (surveyed 2026-11-11: every port used by the sibling suites avoids it).
//
// Covers, without loosening any expectation (failures are reported, never
// weakened):
// - mixed group (`translate` + nested `scale`/`rotate` wrapper) with a
//   text leaf (font-family/size, tspan, opacity), an image leaf (href/size,
//   opacity) and a geometry sibling: reshape-tool drag moves exactly the
//   pressed leaf (topmost hit wins on overlaps), the sibling/defs/metadata/
//   child order survive, Undo/Redo round-trip as exactly one history entry;
// - image-leaf drag and geometry-leaf drag (hit in every direction);
// - mid-drag Escape and synthetic pointercancel restore the preview with no
//   history entry, and click-select without a move writes no history;
// - singular-ancestor, clipped-leaf and `use`-leaf groups are fail-closed
//   through the real UI (VM bytes byte-exact, Undo stays disabled);
// - RTL text (`direction="rtl"`) drags from its visible (left-of-anchor) side
//   and keeps direction/anchor/content;
// - stale selection discipline (Undo, then re-drag uses a fresh source) and
//   async-race discipline (burst moves coalesce to one entry, an immediate
//   Undo never tears);
// - costume/target switches and child order are non-destructive;
// - the multi-hole fill feature still works on its own costume (no cross
//   -feature regression from the translate wiring).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4497
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let page: Page
const diagnostics: string[] = []

// --- self-made fixtures (original coordinates) ------------------------------

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// Unit under test: one `<g>` with a nested transformed wrapper holding a text
// leaf and an image leaf, plus a direct-child geometry sibling. The wrapper
// forces the ancestor-frame conversion (`translate(20 10)` outside,
// `scale(1.25) rotate(5 100 100)` inside). Document order is [geometry,
// wrapper(text, image)] so text/image paint on top of the geometry.
const LEAF_MIXED_SVG =
  `${HEAD}` +
  '<defs><linearGradient id="leafGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>' +
  '<metadata>leaf-mixed-meta-v1</metadata>' +
  '<g transform="translate(20 10)">' +
  '<rect x="240" y="100" width="90" height="60" fill="#2ecc71" stroke="none"/>' +
  '<g transform="scale(1.25) rotate(5 100 100)">' +
  '<text x="60" y="120" font-family="Arial, sans-serif" font-size="28" fill="#d6336c" opacity="0.9">Hello<tspan fill="#0033cc">World</tspan></text>' +
  `<image href="${PNG_1PX}" x="186" y="88" width="26" height="26" opacity="0.85"/>` +
  '</g></g>' +
  '<rect x="400" y="300" width="40" height="30" fill="url(#leafGrad)" stroke="none"/>' +
  '</svg>'

const LEAF_SINGULAR_SVG =
  `${HEAD}` +
  '<g transform="translate(30 40) scale(0)"><rect x="0" y="0" width="60" height="40" fill="#e74c3c" stroke="none"/><text x="5" y="25" font-family="Arial, sans-serif" font-size="20" fill="#222222">flat</text></g>' +
  '<rect x="400" y="300" width="40" height="30" fill="#95a5a6" stroke="none"/>' +
  '</svg>'

const LEAF_CLIPPED_SVG =
  `${HEAD}` +
  '<defs><clipPath id="clipA"><rect x="0" y="0" width="30" height="30"/></clipPath></defs>' +
  '<g transform="translate(40 50)"><rect x="0" y="0" width="120" height="70" fill="#9b59b6" stroke="none" clip-path="url(#clipA)"/><rect x="140" y="0" width="60" height="60" fill="#f1c40f" stroke="none"/></g>' +
  '</svg>'

const LEAF_USE_SVG =
  `${HEAD}` +
  '<defs><rect id="shapeA" x="0" y="0" width="50" height="50" fill="#16a085"/></defs>' +
  '<g transform="translate(40 60)"><use href="#shapeA"/><rect x="80" y="0" width="60" height="60" fill="#e67e22" stroke="none"/></g>' +
  '</svg>'

const LEAF_RTL_SVG =
  `${HEAD}` +
  '<metadata>leaf-rtl-meta-v1</metadata>' +
  '<g transform="translate(20 10)"><rect x="40" y="200" width="90" height="50" fill="#3498db" stroke="none"/><text x="300" y="240" font-family="Arial, sans-serif" font-size="30" fill="#8e44ad" direction="rtl" text-anchor="start">שלום</text></g>' +
  '<rect x="400" y="300" width="40" height="30" fill="#95a5a6" stroke="none"/>' +
  '</svg>'

const FILL_HOLE_SVG =
  `${HEAD}<path d="M150 110H330V250H150Z M170 130H210V170H170Z" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`

const STAGE_SVG = `${HEAD}<rect x="20" y="20" width="60" height="40" fill="#888888" stroke="none"/></svg>`
const TARGET_B_SVG = `${HEAD}<circle cx="240" cy="180" r="40" fill="#1abc9c" stroke="none"/></svg>`

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const stage = add(STAGE_SVG)
  const mixed = add(LEAF_MIXED_SVG)
  const singular = add(LEAF_SINGULAR_SVG)
  const clipped = add(LEAF_CLIPPED_SVG)
  const use = add(LEAF_USE_SVG)
  const rtl = add(LEAF_RTL_SVG)
  const hole = add(FILL_HOLE_SVG)
  const targetB = add(TARGET_B_SVG)
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
        costumes: [{ ...costume(stage, 'backdrop'), rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [
          costume(mixed, 'leaf-mixed'),
          costume(singular, 'leaf-singular'),
          costume(clipped, 'leaf-clipped'),
          costume(use, 'leaf-use'),
          costume(rtl, 'leaf-rtl'),
          costume(hole, 'fill-hole'),
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
      {
        isStage: false, name: 'Sprite2', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(targetB, 'target-b')],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 100, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'vector-group-leaf-translate-integration' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

// --- page helpers (real UI + real VM bytes, no src imports) ------------------

async function costumeText(target: string, index: number): Promise<string> {
  return await page.evaluate(async ({ target, index }: { target: string; index: number }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { target, index })
}

async function costumeIndexByName(name: string): Promise<number> {
  return await page.evaluate(async (want: string) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget('Sprite1')
    const names = (t?.costumes ?? []).map((c: any) => c?.name)
    const at = names.indexOf(want)
    if (at < 0) throw new Error(`missing costume ${want}: ${JSON.stringify(names)}`)
    return at
  }, name)
}

async function waitForVmChange(target: string, index: number, before: string, timeout = 30_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const got = await costumeText(target, index)
    if (got !== before) return got
    if (Date.now() - start > timeout) throw new Error(`VM change timeout ${target}[${index}]`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForVmEqual(target: string, index: number, want: string, timeout = 30_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    const got = await costumeText(target, index)
    if (got === want) return
    if (Date.now() - start > timeout) throw new Error(`VM equal timeout ${target}[${index}]`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function previewHtml(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewChange(before: string, timeout = 30_000): Promise<string> {
  await page.waitForFunction((svg: string) => document.querySelector('.vector-preview')?.innerHTML !== svg, before, { timeout })
  return await previewHtml()
}

async function waitForPreviewEqual(want: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction((svg: string) => document.querySelector('.vector-preview')?.innerHTML === svg, want, { timeout })
}

// Artwork-level VM comparison: serializes only the `<svg>` children, ignoring
// root `width`/`height`/`viewBox` recomputation on save. A leaf translate
// drag must change exactly the moved leaf's `transform`; cancel/restore paths
// must change no child at all.
async function childMarkup(target: string, index: number): Promise<string> {
  return await page.evaluate(async ({ target, index }: { target: string; index: number }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
    return Array.from((doc.documentElement as unknown as Element).children)
      .map((kid) => new XMLSerializer().serializeToString(kid as unknown as Element))
      .join('')
  }, { target, index })
}

async function selectCostumeByName(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).click()
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
  await fitViewport()
}

async function fitViewport() {
  // Normalize the viewport like the fill suites: default zoom is ~5x and
  // panned, which puts leaf-bbox centers off-canvas (e.g. over the toolbar).
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.waitForTimeout(1200)
}

// Fail fast when a computed press point is off-canvas (toolbar/sidebar):
// clicking there would silently test nothing.
async function guardCanvasPoint(p: { x: number; y: number }, label: string): Promise<void> {
  const hit = await page.evaluate(
    ({ px, py }: { px: number; py: number }) => {
      const element = document.elementFromPoint(px, py)
      if (!element) return 'none'
      if (element.closest('[data-vector-stage-surface]')) return `canvas:${element.tagName}`
      const button = element.closest('button')
      if (button) return `button:${button.getAttribute('data-testid') ?? button.getAttribute('aria-label') ?? button.textContent?.slice(0, 30)}`
      return element.tagName
    },
    { px: p.x, py: p.y },
  )
  if (!hit.startsWith('canvas:')) {
    failReport(`${label} is off-canvas`, { point: p, hit })
    throw new Error(`${label} is off-canvas (hits ${hit}); refusing a misdirected press`)
  }
}

async function ensureVectorMode() {
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 })
}

async function undoEnabled(): Promise<boolean> {
  const buttons = page.getByRole('button', { name: 'Undo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) return true
  }
  return false
}

async function redoEnabled(): Promise<boolean> {
  const buttons = page.getByRole('button', { name: 'Redo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) return true
  }
  return false
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

async function openFreshEditor(): Promise<void> {
  try {
    await page?.close()
  } catch {}
  page = (await browser!.newPage({ viewport: { width: 1400, height: 900 } })) as unknown as Page
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${String(error).slice(0, 300)}`))
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByTestId('project-file-input').setInputFiles({
    name: 'leaf-translate.sb3',
    mimeType: 'application/x.scratch.sb3',
    buffer: buildSb3(),
  })
  await page.waitForFunction(
    () =>
      (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
        .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 6,
    null,
    { timeout: 20_000 },
  )
  await ensureVectorMode()
}

// Live client rects of the mixed-costume preview leaves (coordinate discovery
// only; every behavioural claim is asserted on VM bytes/pixels/history).
type LeafRects = {
  text: { x: number; y: number; width: number; height: number } | null
  image: { x: number; y: number; width: number; height: number } | null
  groupRect: { x: number; y: number; width: number; height: number } | null
  bgRect: { x: number; y: number; width: number; height: number } | null
}

async function mixedLeafRects(): Promise<LeafRects> {
  return await page.evaluate(() => {
    const pick = (el: Element | null) => {
      if (!el) return null
      const r = (el as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    const svg = document.querySelector('.vector-preview svg')
    if (!svg) return { text: null, image: null, groupRect: null, bgRect: null }
    const unit = Array.from(svg.children).find((kid) => (kid as Element).tagName.toLowerCase() === 'g') as Element | undefined
    const text = unit?.querySelector('text') ?? null
    const image = unit?.querySelector('image') ?? null
    const groupRect = (() => {
      if (!unit) return null
      for (const kid of Array.from(unit.children)) {
        if ((kid as Element).tagName.toLowerCase() === 'rect') return kid as Element
      }
      return null
    })()
    const svgRects = Array.from(svg.querySelectorAll('rect'))
    const bgRect = svgRects.find((r) => !unit?.contains(r)) ?? null
    return { text: pick(text), image: pick(image), groupRect: pick(groupRect), bgRect: pick(bgRect ?? null) }
  })
}

// Structured facts about the mixed costume parsed from the REAL VM bytes.
type MixedFacts = {
  childTags: string
  unitTransform: string | null
  wrapperTransform: string | null
  textTransform: string | null
  textAttrs: Record<string, string>
  textContent: string
  tspanHtml: string | null
  imageAttrs: Record<string, string>
  groupRectHtml: string
  bgRectHtml: string
  defsHtml: string
  metadataHtml: string | null
}

// Live preview leaf transform (rendered artwork, not saved bytes): parsed
// from the current `.vector-preview` markup. Used to observe pre-release
// preview convergence during rapid drags.
// Parse `translate(ax ay)` into numbers for tolerance comparison. Strict
// string equality is too brittle across legs: identical integer client deltas
// always serialize identically (commit path), but live-center recomputation
// and float association across synthetic/real event paths jitter at ~1e-5,
// five orders below a genuinely dropped 2px step (~1.3 doc units).
function translateXY(value: string | null): [number, number] | null {
  if (!value) return null
  const match = /translate\(\s*([^\s,)]+)[\s,]+([^)]+)\)/.exec(value)
  if (!match) return null
  const x = Number(match[1])
  const y = Number(match[2])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return [x, y]
}

function expectTranslateCloseTo(actual: string | null, expected: string | null, tolerance = 1e-2) {
  const a = translateXY(actual)
  const e = translateXY(expected)
  expect(a).not.toBe(null)
  expect(e).not.toBe(null)
  expect(Math.abs(a![0] - e![0])).toBeLessThan(tolerance)
  expect(Math.abs(a![1] - e![1])).toBeLessThan(tolerance)
}

async function previewTextTransform(): Promise<string | null> {
  return await page.evaluate(() => {
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    if (!html) return null
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
    const text = doc.querySelector('g text')
    return (text as unknown as Element | null)?.getAttribute('transform')
  })
}

async function mixedFacts(target: string, index: number): Promise<MixedFacts> {
  return await page.evaluate(async ({ target, index }: { target: string; index: number }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
    const svg = doc.documentElement as unknown as Element
    const kids = Array.from(svg.children) as Element[]
    const unit = kids.find((kid) => kid.tagName.toLowerCase() === 'g') as Element
    const direct = Array.from(unit.children) as Element[]
    const groupRect = direct.find((kid) => kid.tagName.toLowerCase() === 'rect') as Element
    const wrapper = direct.find((kid) => kid.tagName.toLowerCase() === 'g') as Element
    const text = wrapper.querySelector('text') as unknown as Element
    const image = wrapper.querySelector('image') as unknown as Element
    const attrsOf = (el: Element) => {
      const out: Record<string, string> = {}
      for (const attr of Array.from(el.attributes)) out[attr.name] = attr.value
      return out
    }
    return {
      childTags: kids.map((kid) => kid.tagName.toLowerCase()).join(','),
      unitTransform: unit.getAttribute('transform'),
      wrapperTransform: wrapper.getAttribute('transform'),
      textTransform: text.getAttribute('transform'),
      textAttrs: attrsOf(text),
      textContent: text.textContent ?? '',
      tspanHtml: (() => {
        const tspan = text.querySelector('tspan')
        return tspan ? new XMLSerializer().serializeToString(tspan) : null
      })(),
      imageAttrs: attrsOf(image),
      groupRectHtml: new XMLSerializer().serializeToString(groupRect),
      bgRectHtml: (() => {
        const bg = (svg.querySelectorAll('rect') ? Array.from(svg.querySelectorAll('rect')) : []).find((r) => !unit.contains(r as unknown as Node))
        return bg ? new XMLSerializer().serializeToString(bg as unknown as Element) : ''
      })(),
      defsHtml: (() => {
        const defs = svg.querySelector('defs')
        return defs ? new XMLSerializer().serializeToString(defs) : ''
      })(),
      metadataHtml: (() => {
        const metadata = svg.querySelector('metadata')
        return metadata ? new XMLSerializer().serializeToString(metadata) : null
      })(),
    }
  }, { target, index })
}

const centerOf = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

async function selectGroupViaText(): Promise<void> {
  await page.getByTestId('vector-shape-select').last().click()
  const rects = await mixedLeafRects()
  if (!rects.text) throw new Error('No text leaf rect in preview (group not rendered?)')
  const at = centerOf(rects.text)
  await guardCanvasPoint(at, 'text press point')
  await pressAt(at)
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.locator('[data-reshape-curve-layer]').waitFor({ state: 'attached', timeout: 30_000 })
}

// Press without moving: the leaf-translate begin is async (document load +
// Paper hit), so a synthetic instant click (down+up within milliseconds)
// can complete the pointerup before begin resolves, stranding an armed drag
// that blocks the NEXT gesture. Real users never click that fast; hold the
// press until begin has resolved, then release for a clean no-move select.
async function pressAt(p: { x: number; y: number }, holdMs = 900): Promise<void> {
  await guardCanvasPoint(p, 'press')
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.waitForTimeout(holdMs)
  await page.mouse.up()
  await page.waitForTimeout(300)
}

// Real drag that survives the async begin: early pointermoves may be dropped
// while begin is in flight, so stream moves until the first preview lands,
// settle at the full delta, then release to commit.
async function dragUntilApplied(from: { x: number; y: number }, dx: number, dy: number, timeout = 30_000): Promise<void> {
  await guardCanvasPoint(from, 'drag start')
  const before = await previewHtml()
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  try {
    const start = Date.now()
    let applied = false
    for (let step = 1; step <= 12 && !applied; step += 1) {
      const f = Math.min(1, step / 6)
      await page.mouse.move(from.x + dx * f, from.y + dy * f, { steps: 3 })
      await page.waitForTimeout(300)
      applied = (await previewHtml()) !== before
      if (!applied && Date.now() - start > timeout) break
    }
    if (!applied) throw new Error('leaf drag never applied a preview (begin blocked or hit missed)')
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 3 })
    await page.waitForTimeout(300)
  } finally {
    await page.mouse.up()
  }
}

async function dragBy(from: { x: number; y: number }, dx: number, dy: number) {
  await guardCanvasPoint(from, 'drag start')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 })
  await page.mouse.up()
}

async function docToClient(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox()
  if (!box) throw new Error('Missing vector stage surface')
  return { x: box.x + (x / 480) * box.width, y: box.y + (y / 360) * box.height }
}

function failReport(context: string, extra: unknown) {
  diagnostics.push(`[leaf-translate-integration:FAIL] ${context} ${JSON.stringify(extra).slice(0, 2000)}`)
}

describe('group-leaf translate integration (real Editor + real VM)', () => {
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
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 180_000)

  afterAll(async () => {
    if (diagnostics.length > 0) console.log(diagnostics.join('\n'))
    await browser?.close()
    server?.kill()
  })

  it('text leaf drag: topmost hit, sibling/paint/order/metadata preserved, single Undo/Redo entry', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('leaf-mixed')
    await selectCostumeByName('leaf-mixed')
    await ensureVectorMode()
    const beforeVm = await costumeText('Sprite1', index)
    const beforeFacts = await mixedFacts('Sprite1', index)
    expect(beforeFacts.textContent).toContain('Hello')
    expect(beforeFacts.textContent).toContain('World')
    expect(beforeFacts.textTransform).toBe(null)
    expect(await undoEnabled()).toBe(false)
    const shotBefore = await page.getByTestId('costume-paint-surface').screenshot().catch(() => null)

    // Select the group through the real select tool, then enter reshape.
    await selectGroupViaText()

    // Hit: the text leaf paints over empty canvas (left of the geometry
    // sibling), so its own center must resolve to the text leaf.
    const rects = await mixedLeafRects()
    if (!rects.text || !rects.groupRect || !rects.image) throw new Error('Missing preview leaf rects')
    const textAt = centerOf(rects.text)
    // Defensive attribution: the text press point must be clear of the other
    // leaves, otherwise a move could be misattributed.
    const clearOf = (p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }, margin: number) =>
      p.x < r.x - margin || p.x > r.x + r.width + margin || p.y < r.y - margin || p.y > r.y + r.height + margin
    if (!clearOf(textAt, rects.groupRect, 8) || !clearOf(textAt, rects.image, 8)) {
      failReport('text press point not isolated', { textAt, rects })
      throw new Error('Text press point overlaps another leaf; refusing a misattributed drag')
    }

    const previewBefore = await previewHtml()
    const textBoxBefore = rects.text
    const siblingBoxBefore = rects.groupRect
    await dragUntilApplied(textAt, 72, 20)
    const afterVm = await waitForVmChange('Sprite1', index, beforeVm)
    expect(afterVm).not.toBe(beforeVm)

    // Visible side: the text ink travelled with the pointer; the geometry
    // sibling did not move (same canvas scale applies to both, so zero stays
    // zero while the drag is clearly visible).
    const moved = await mixedLeafRects()
    if (!moved.text || !moved.groupRect || !moved.bgRect) throw new Error('Missing preview leaf rects after drag')
    const textDelta = { x: centerOf(moved.text).x - centerOf(textBoxBefore).x, y: centerOf(moved.text).y - centerOf(textBoxBefore).y }
    expect(Math.hypot(textDelta.x, textDelta.y)).toBeGreaterThan(12)
    expect(textDelta.x).toBeGreaterThan(8)
    expect(textDelta.y).toBeGreaterThan(0)
    expect(Math.abs(centerOf(moved.groupRect).x - centerOf(siblingBoxBefore).x)).toBeLessThan(2.5)
    expect(Math.abs(centerOf(moved.groupRect).y - centerOf(siblingBoxBefore).y)).toBeLessThan(2.5)
    const shotAfter = await page.getByTestId('costume-paint-surface').screenshot().catch(() => null)
    if (shotBefore && shotAfter) expect(Buffer.compare(shotBefore, shotAfter) !== 0).toBe(true)

    // VM bytes: exactly the text leaf gained a translate; everything else is
    // structurally identical (sibling/defs/metadata/child order/unit and
    // wrapper transforms byte-exact; text keeps every attribute but transform).
    const afterFacts = await mixedFacts('Sprite1', index)
    expect(afterFacts.childTags).toBe(beforeFacts.childTags)
    expect(afterFacts.unitTransform).toBe(beforeFacts.unitTransform)
    expect(afterFacts.wrapperTransform).toBe(beforeFacts.wrapperTransform)
    expect(afterFacts.groupRectHtml).toBe(beforeFacts.groupRectHtml)
    expect(afterFacts.bgRectHtml).toBe(beforeFacts.bgRectHtml)
    expect(afterFacts.defsHtml).toBe(beforeFacts.defsHtml)
    expect(afterFacts.metadataHtml).toBe(beforeFacts.metadataHtml)
    expect(afterFacts.textTransform).not.toBe(null)
    expect(afterFacts.textTransform).toContain('translate(')
    const { transform: _movedTransform, ...afterTextRest } = afterFacts.textAttrs
    const { transform: _beforeTransform, ...beforeTextRest } = beforeFacts.textAttrs
    expect(afterTextRest).toEqual(beforeTextRest)
    expect(afterTextRest['font-family']).toContain('Arial')
    expect(afterTextRest['font-size']).toBe('28')
    expect(afterTextRest['opacity']).toBe('0.9')
    expect(afterFacts.textContent).toBe(beforeFacts.textContent)
    expect(afterFacts.tspanHtml).toBe(beforeFacts.tspanHtml)
    expect(afterFacts.tspanHtml).toContain('#0033cc')
    expect(afterFacts.imageAttrs).toEqual(beforeFacts.imageAttrs)
    expect(await waitForPreviewChange(previewBefore)).not.toBe(previewBefore)

    // Exactly one history entry: one Undo restores the pre-drag raw bytes
    // (history entries capture raw VM bytes), a second Undo is a disabled
    // no-op; one Redo re-applies the committed bytes, a second Redo no-ops.
    expect(await undoEnabled()).toBe(true)
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, beforeVm)
    await waitForPreviewEqual(previewBefore)
    expect(await previewHtml()).toBe(previewBefore)
    const undoneFacts = await mixedFacts('Sprite1', index)
    expect(undoneFacts.textTransform).toBe(null)
    expect(undoneFacts.groupRectHtml).toBe(beforeFacts.groupRectHtml)
    expect(undoneFacts.textContent).toBe(beforeFacts.textContent)
    expect(undoneFacts.tspanHtml).toBe(beforeFacts.tspanHtml)
    // A second consecutive Undo must change nothing (single entry proof).
    await clickUndoOnce().catch(() => undefined)
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    expect(await redoEnabled()).toBe(true)
    await clickRedoOnce()
    await waitForVmEqual('Sprite1', index, afterVm)
    const redoneFacts = await mixedFacts('Sprite1', index)
    expect(redoneFacts.textTransform).toBe(afterFacts.textTransform)
    expect(redoneFacts.groupRectHtml).toBe(beforeFacts.groupRectHtml)
    await clickRedoOnce().catch(() => undefined)
    expect(await costumeText('Sprite1', index)).toBe(afterVm)
    expect(await undoEnabled()).toBe(true)
  }, 180_000)

  it('image-over-geometry overlap goes to the image; geometry-only press moves the sibling', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('leaf-mixed')
    await selectCostumeByName('leaf-mixed')
    await ensureVectorMode()
    const beforeVm = await costumeText('Sprite1', index)
    const beforeFacts = await mixedFacts('Sprite1', index)
    await selectGroupViaText()

    // Topmost hit: intersect the live image and geometry rects; the overlap
    // must resolve to the image leaf (later in document order), not the rect.
    const overlap = await page.evaluate(() => {
      const pick = (el: Element | null) => {
        if (!el) return null
        const r = (el as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
        return { x: r.left, y: r.top, width: r.width, height: r.height }
      }
      const svg = document.querySelector('.vector-preview svg')
      if (!svg) return null
      const unit = Array.from(svg.children).find((kid) => (kid as Element).tagName.toLowerCase() === 'g') as Element | undefined
      if (!unit) return null
      let groupRect: Element | null = null
      for (const kid of Array.from(unit.children)) {
        if ((kid as Element).tagName.toLowerCase() === 'rect') groupRect = kid as Element
      }
      const image = unit.querySelector('image')
      const a = pick(image)
      const b = pick(groupRect)
      if (!a || !b) return null
      const left = Math.max(a.x, b.x)
      const top = Math.max(a.y, b.y)
      const right = Math.min(a.x + a.width, b.x + b.width)
      const bottom = Math.min(a.y + a.height, b.y + b.height)
      return { left, top, right, bottom, area: Math.max(0, right - left) * Math.max(0, bottom - top) }
    })
    if (!overlap || overlap.area < 100) {
      failReport('no usable image/geometry overlap', { overlap })
      throw new Error('Image/geometry overlap too small for a topmost-hit drag')
    }
    const overlapAt = { x: (overlap.left + overlap.right) / 2, y: (overlap.top + overlap.bottom) / 2 }
    await guardCanvasPoint(overlapAt, 'overlap press point')
    await dragUntilApplied(overlapAt, 64, 12)
    const imageMovedVm = await waitForVmChange('Sprite1', index, beforeVm)
    expect(imageMovedVm).not.toBe(beforeVm)
    const imageMoved = await mixedFacts('Sprite1', index)
    // The image leaf moved (bounds hit, exact for rasters); the text leaf
    // and the geometry sibling are untouched.
    expect(imageMoved.imageAttrs['transform']).toContain('translate(')
    for (const name of ['href', 'x', 'y', 'width', 'height', 'opacity']) {
      expect(imageMoved.imageAttrs[name]).toBe(beforeFacts.imageAttrs[name])
    }
    expect(imageMoved.textTransform).toBe(null)
    expect(imageMoved.groupRectHtml).toBe(beforeFacts.groupRectHtml)
    expect(imageMoved.tspanHtml).toBe(beforeFacts.tspanHtml)

    // Geometry-only press: top-right corner of the rect, verified clear of
    // the text and image boxes, must move the geometry sibling alone.
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, beforeVm)
    const restored = await costumeText('Sprite1', index)
    const restoredFacts = await mixedFacts('Sprite1', index)
    expect(restoredFacts.textTransform).toBe(null)
    expect(restoredFacts.imageAttrs['transform'] ?? null).toBe(null)
    const rects = await mixedLeafRects()
    if (!rects.groupRect || !rects.text || !rects.image) throw new Error('Missing preview leaf rects')
    const rectOnly = { x: rects.groupRect.x + rects.groupRect.width - 18, y: rects.groupRect.y + 18 }
    const clearOf = (p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }, margin: number) =>
      p.x < r.x - margin || p.x > r.x + r.width + margin || p.y < r.y - margin || p.y > r.y + r.height + margin
    if (!clearOf(rectOnly, rects.text, 8) || !clearOf(rectOnly, rects.image, 8)) {
      failReport('rect-only press point not isolated', { rectOnly, rects })
      throw new Error('Rect-only press point overlaps another leaf')
    }
    await guardCanvasPoint(rectOnly, 'rect-only press point')
    // Reselect the group (undo may have dropped the object selection), then
    // drag the geometry-only point.
    await selectGroupViaText()
    await dragUntilApplied(rectOnly, -56, 10)
    const rectMovedVm = await waitForVmChange('Sprite1', index, restored)
    expect(rectMovedVm).not.toBe(restored)
    const rectMoved = await mixedFacts('Sprite1', index)
    expect(rectMoved.groupRectHtml).not.toBe(beforeFacts.groupRectHtml)
    expect(rectMoved.groupRectHtml).toContain('translate(')
    expect(rectMoved.groupRectHtml).toContain('#2ecc71')
    expect(rectMoved.textTransform).toBe(null)
    expect(rectMoved.imageAttrs['transform'] ?? null).toBe(null)
    expect(rectMoved.childTags).toBe(beforeFacts.childTags)
    expect(await undoEnabled()).toBe(true)
  }, 180_000)

  it('Escape and pointercancel restore the preview with no history; click-select writes no history', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('leaf-mixed')
    await selectCostumeByName('leaf-mixed')
    await ensureVectorMode()
    const beforeVm = await costumeText('Sprite1', index)
    await selectGroupViaText()

    // Click-select (no move) must write no history entry.
    const rects = await mixedLeafRects()
    if (!rects.text) throw new Error('Missing text leaf rect')
    const textAt = centerOf(rects.text)
    await guardCanvasPoint(textAt, 'click-select press point')
    await pressAt(textAt)
    expect(await previewHtml()).not.toBe('')
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    expect(await undoEnabled()).toBe(false)

    // Mid-drag Escape: stream moves until a preview applies, then cancel
    // mid-drag; the preview rewinds with no history.
    const previewBefore = await previewHtml()
    const markupBefore = await childMarkup('Sprite1', index)
    await page.mouse.move(textAt.x, textAt.y)
    await page.mouse.down()
    try {
      let applied = false
      for (let i = 1; i <= 10 && !applied; i += 1) {
        await page.mouse.move(textAt.x + (60 * i) / 10, textAt.y + (16 * i) / 10, { steps: 2 })
        await page.waitForTimeout(300)
        applied = (await previewHtml()) !== previewBefore
      }
      if (!applied) throw new Error('escape-leg drag never applied a preview')
      await page.keyboard.press('Escape')
    } finally {
      await page.mouse.up()
    }
    await waitForPreviewEqual(previewBefore)
    expect(await undoEnabled()).toBe(false)
    // Cancel paths restore artwork without touching children (root save
    // normalization may rewrite width/viewBox, so compare child markup).
    expect(await childMarkup('Sprite1', index)).toBe(markupBefore)
    // The drag is over: a fresh drag must still commit singly afterwards.
    const reselect = await mixedLeafRects()
    if (!reselect.text) throw new Error('Missing text leaf rect after Escape')
    const vmPreSecond = await costumeText('Sprite1', index)
    await dragUntilApplied(centerOf(reselect.text), 48, 8)
    const movedVm = await waitForVmChange('Sprite1', index, vmPreSecond)
    expect(movedVm).not.toBe(vmPreSecond)
    expect(await undoEnabled()).toBe(true)
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, vmPreSecond)

    // Mid-drag pointercancel (synthetic event, real cancel path): the editor
    // tracks by pointer id, so fan out over the plausible ids; only the live
    // drag id acts, the rest are ignored.
    const rects2 = await mixedLeafRects()
    if (!rects2.text) throw new Error('Missing text leaf rect for pointercancel leg')
    const at2 = centerOf(rects2.text)
    const previewBeforeCancel = await previewHtml()
    const markupBeforeCancel = await childMarkup('Sprite1', index)
    await page.mouse.move(at2.x, at2.y)
    await page.mouse.down()
    try {
      let appliedCancel = false
      for (let i = 1; i <= 10 && !appliedCancel; i += 1) {
        await page.mouse.move(at2.x + (56 * i) / 10, at2.y + (14 * i) / 10, { steps: 2 })
        await page.waitForTimeout(300)
        appliedCancel = (await previewHtml()) !== previewBeforeCancel
      }
      if (!appliedCancel) throw new Error('pointercancel-leg drag never applied a preview')
      await page.evaluate(() => {
        const layer = document.querySelector('[data-reshape-curve-layer]')
        if (!layer) throw new Error('Missing reshape curve layer for pointercancel')
        for (const pointerId of [0, 1, 2, 3, 4, 5]) {
          layer.dispatchEvent(new PointerEvent('pointercancel', { pointerId, bubbles: true, cancelable: true }))
          layer.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId, bubbles: true, cancelable: true }))
        }
      })
    } finally {
      await page.mouse.up()
    }
    await waitForPreviewEqual(previewBeforeCancel)
    expect(await previewHtml()).toBe(previewBeforeCancel)
    expect(await childMarkup('Sprite1', index)).toBe(markupBeforeCancel)
    expect(await undoEnabled()).toBe(false)
  }, 180_000)

  it('singular, clipped and use groups fail closed through the real UI', async () => {
    await openFreshEditor()
    await ensureVectorMode()

    // Document-space press points on visible artwork per costume: the
    // singular group collapses to (30,40); the clipped costume's unclipped
    // yellow sibling centers on (210,80); the use costume's orange sibling
    // centers on (150,90).
    const cases = [
      { name: 'leaf-singular', doc: { x: 30, y: 40 }, expectOverlay: false },
      { name: 'leaf-clipped', doc: { x: 210, y: 80 }, expectOverlay: true },
      { name: 'leaf-use', doc: { x: 150, y: 90 }, expectOverlay: true },
    ] as const
    for (const { name, doc, expectOverlay } of cases) {
      const index = await costumeIndexByName(name)
      await selectCostumeByName(name)
      await ensureVectorMode()
      const beforeVm = await costumeText('Sprite1', index)
      expect(await undoEnabled()).toBe(false)
      const previewBefore = await previewHtml()

      // Select through the real select tool on visible artwork, then attempt
      // a reshape drag. Fail-closed means: VM bytes byte-exact, preview
      // identical, Undo stays disabled. The overlay assertion proves the
      // group really was selected (the drag went through the translate path
      // and was refused, not trivially missed).
      await page.getByTestId('vector-shape-select').last().click()
      const at = await docToClient(doc.x, doc.y)
      await guardCanvasPoint(at, `${name} press point`)
      await pressAt(at)
      await page.getByTestId('vector-shape-reshape').last().click()
      await page.waitForTimeout(1200)
      const layerCount = await page.locator('[data-reshape-curve-layer]').count()
      if (expectOverlay) expect(layerCount).toBeGreaterThan(0)
      // The reshape tool shifts the edit-surface layout (measured +48px Y
      // on 1400x900: surface top 456.6 -> 504.6), so a client point derived
      // before the shift is stale and can fall off-canvas (singular doc
      // (30,40) sits near the top edge and lands on the outer DIV). Re-derive
      // the SAME document point from the live surface rect so the drag starts
      // on-canvas; doc coords, drag delta, and fail-closed expectations stay
      // exactly as before.
      const dragAt = await docToClient(doc.x, doc.y)
      await guardCanvasPoint(dragAt, `${name} drag point`)
      await dragBy(dragAt, 64, 16)
      // Clear any half-armed drag state (Escape is a no-op when idle) so one
      // costume's probe can never pollute the next.
      await page.keyboard.press('Escape').catch(() => undefined)
      await page.waitForTimeout(800)
      const afterVm = await costumeText('Sprite1', index)
      if (afterVm !== beforeVm) {
        failReport(`${name} wrote VM bytes through a fail-closed drag`, { before: beforeVm.slice(0, 500), after: afterVm.slice(0, 500) })
      }
      expect(afterVm).toBe(beforeVm)
      expect(await previewHtml()).toBe(previewBefore)
      expect(await undoEnabled()).toBe(false)
    }
  }, 180_000)

  it('RTL text drags from its visible side and keeps direction/anchor/content', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('leaf-rtl')
    await selectCostumeByName('leaf-rtl')
    await ensureVectorMode()
    const beforeVm = await costumeText('Sprite1', index)
    expect(beforeVm).toContain('direction="rtl"')
    expect(beforeVm).toContain('שלום')
    expect(await undoEnabled()).toBe(false)

    // Select the group through its geometry sibling: object-level select
    // does not mirror group hits for RTL text (leaf-level translate hit
    // does), so the visible RTL ink itself is not a group-select point.
    // Selecting via the sibling is the honest real-UI path; the RTL
    // visible-side claim under test is the leaf drag below.
    await page.getByTestId('vector-shape-select').last().click()
    const siblingBox = await page.evaluate(() => {
      const rect = document.querySelector('.vector-preview svg g rect')
      if (!rect) return null
      const r = (rect as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    })
    if (!siblingBox || siblingBox.width < 4 || siblingBox.height < 4) throw new Error('RTL sibling rect has no visible box')
    await pressAt({ x: siblingBox.x + siblingBox.width / 2, y: siblingBox.y + siblingBox.height / 2 })
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.locator('[data-reshape-curve-layer]').waitFor({ state: 'attached', timeout: 30_000 })

    const inkBox = await page.evaluate(() => {
      const text = document.querySelector('.vector-preview svg g text')
      if (!text) return null
      const r = (text as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    })
    if (!inkBox || inkBox.width < 4 || inkBox.height < 4) throw new Error('RTL text has no visible ink box')
    const inkCenter = { x: inkBox.x + inkBox.width / 2, y: inkBox.y + inkBox.height / 2 }
    await guardCanvasPoint(inkCenter, 'RTL ink press point')

    // Best-effort visible side: RTL ink extends LEFT from the x anchor, so
    // drag from the live ink center (whatever side the engine shows).
    const at = inkCenter
    const previewBefore = await previewHtml()
    await dragUntilApplied(at, 60, 12)
    const afterVm = await waitForVmChange('Sprite1', index, beforeVm)
    expect(afterVm).not.toBe(beforeVm)
    expect(await waitForPreviewChange(previewBefore)).not.toBe(previewBefore)
    // Preservation: direction/anchor/content/font survive the move; only a
    // translate is prepended on the text leaf.
    for (const needle of ['direction="rtl"', 'text-anchor="start"', 'שלום', 'font-size="30"', 'font-family="Arial, sans-serif"', '#8e44ad']) {
      expect(afterVm).toContain(needle)
    }
    const movedTextTransform = await page.evaluate(async ({ target, index: atIndex }: { target: string; index: number }) => {
      const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
      const t = vm.getTarget(target)
      const c = t?.costumes[atIndex]
      const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
      return (doc.querySelector('g text') as unknown as Element | null)?.getAttribute('transform')
    }, { target: 'Sprite1', index })
    expect(movedTextTransform).not.toBe(null)
    expect(movedTextTransform).toContain('translate(')
    expect(await undoEnabled()).toBe(true)
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, beforeVm)
    const undone = await costumeText('Sprite1', index)
    const undoneHasTranslate = await page.evaluate(async ({ target, index: atIndex }: { target: string; index: number }) => {
      const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
      const t = vm.getTarget(target)
      const c = t?.costumes[atIndex]
      const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
      return (doc.querySelector('g text') as unknown as Element | null)?.getAttribute('transform')
    }, { target: 'Sprite1', index })
    expect(undoneHasTranslate).toBe(null)
    expect(undone).toContain('שלום')
  }, 180_000)

  it('stale selection and async races: undo-then-redrag is fresh, bursts commit singly, immediate undo never tears', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('leaf-mixed')
    await selectCostumeByName('leaf-mixed')
    await ensureVectorMode()
    const beforeVm = await costumeText('Sprite1', index)
    const beforeFacts = await mixedFacts('Sprite1', index)
    await selectGroupViaText()

    // Commit move A on the text leaf.
    const rects = await mixedLeafRects()
    if (!rects.text) throw new Error('Missing text leaf rect')
    await dragUntilApplied(centerOf(rects.text), 64, 0)
    const vmA = await waitForVmChange('Sprite1', index, beforeVm)
    const factsA = await mixedFacts('Sprite1', index)
    expect(factsA.textTransform).toContain('translate(')
    expect(await undoEnabled()).toBe(true)

    // Stale guard: Undo (selection is re-derived fail-closed), reselect the
    // leaf, drag again. The second drag must start from the restored source,
    // not from the stale pre-undo revision.
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, beforeVm)
    const undoneFacts = await mixedFacts('Sprite1', index)
    expect(undoneFacts.textTransform).toBe(null)
    const rectsB = await mixedLeafRects()
    if (!rectsB.text) throw new Error('Missing text leaf rect after undo')
    await pressAt(centerOf(rectsB.text))
    const vmPreSecond = await costumeText('Sprite1', index)
    await dragUntilApplied(centerOf((await mixedLeafRects()).text!), 32, 8)
    const vmB = await waitForVmChange('Sprite1', index, vmPreSecond)
    expect(vmB).not.toBe(beforeVm)
    const factsB = await mixedFacts('Sprite1', index)
    expect(factsB.textTransform).toContain('translate(')
    // The stale first-move transform must not leak into the second drag: the
    // committed ancestor delta differs from move A (fresh source, not stale).
    expect(factsB.textTransform).not.toBe(factsA.textTransform)
    expect(factsB.groupRectHtml).toBe(beforeFacts.groupRectHtml)
    expect(factsB.childTags).toBe(beforeFacts.childTags)

    // Async race: burst several moves without settling, then release once.
    // The coalescing path must still mint exactly one history entry.
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, vmPreSecond)
    const burstBase = await costumeText('Sprite1', index)
    expect(burstBase).toBe(vmPreSecond)
    const rectsC = await mixedLeafRects()
    if (!rectsC.text) throw new Error('Missing text leaf rect for burst leg')
    const from = centerOf(rectsC.text)
    const burstPreview = await previewHtml()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    try {
      // First let the async begin resolve and land a preview; then burst the
      // remaining moves without settling to exercise the coalescing path.
      const start = Date.now()
      let applied = false
      for (let i = 1; i <= 10 && !applied; i += 1) {
        await page.mouse.move(from.x + (20 * i) / 10, from.y + (4 * i) / 10, { steps: 2 })
        await page.waitForTimeout(250)
        applied = (await previewHtml()) !== burstPreview
        if (!applied && Date.now() - start > 30_000) break
      }
      if (!applied) throw new Error('burst-leg drag never applied a preview')
      await page.mouse.move(from.x + 44, from.y + 10, { steps: 3 })
      await page.mouse.move(from.x + 70, from.y + 14, { steps: 3 })
    } finally {
      await page.mouse.up()
    }
    const vmBurst = await waitForVmChange('Sprite1', index, burstBase)
    expect(vmBurst).not.toBe(burstBase)
    // Immediate Undo with no settle wait: the bytes must converge to exactly
    // one of the two stable revisions (never a torn mix), then Redo restores.
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, burstBase, 30_000)
    expect(await costumeText('Sprite1', index)).toBe(burstBase)
    expect(await redoEnabled()).toBe(true)
    await clickRedoOnce()
    await waitForVmEqual('Sprite1', index, vmBurst, 30_000)
    // Single entry again: a further Undo lands on the base and sticks.
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, burstBase, 30_000)
    await clickUndoOnce().catch(() => undefined)
    expect(await costumeText('Sprite1', index)).toBe(burstBase)
  }, 180_000)

  it('rapid moves with a pre-release hold: the final position is not dropped', async () => {
    // History: `applyLiveVectorLeafTranslateDrag` once cleared
    // `pendingClientX/Y` immediately before reading them, so the chained
    // re-apply of a move that arrived mid-apply never fired (compare the
    // read-before-clear move/resize/rotate/anchor siblings). The pointerup
    // rescue masked it at commit, but a hold-still with no further events
    // stranded a stale preview. The product has since been fixed to
    // read-before-clear with an explicit comment; this test locks the
    // intended behavior through the real UI: a settled reference drag, then
    // rapid deterministic bursts (in-page, zero inter-move delay, forcing
    // mid-apply coalescing) with an intentional pre-release hold, comparing
    // the burst-end/held previews against the committed result and the
    // settled reference. Any divergence is reported, not hidden.
    await openFreshEditor()
    const index = await costumeIndexByName('leaf-mixed')
    await selectCostumeByName('leaf-mixed')
    await ensureVectorMode()
    const beforeVm = await costumeText('Sprite1', index)
    await selectGroupViaText()

    // Reference leg: settled moves to a fixed client delta, released to commit.
    const DX = 80
    const DY = 16
    const refRects = await mixedLeafRects()
    if (!refRects.text) throw new Error('Missing text leaf rect for reference leg')
    await dragUntilApplied(centerOf(refRects.text), DX, DY)
    const refVm = await waitForVmChange('Sprite1', index, beforeVm)
    expect(refVm).not.toBe(beforeVm)
    const refTransform = (await mixedFacts('Sprite1', index)).textTransform
    expect(refTransform).toContain('translate(')
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, beforeVm)

    // Burst legs: the same client delta, but rapid-fire moves with an
    // intentional pre-release hold (button down, no events) so a move landing
    // mid-apply must survive without the release rescue. The burst is
    // dispatched in-page with zero inter-move delay (fanned out over the
    // plausible pointer ids; only the live drag id acts): every move after
    // the first deterministically lands inside the first apply, forcing the
    // pending-coalescing path. A lucky idle-gap pass is impossible here, so
    // convergence (or its absence) is decisive, not timing luck.
    const divergences: Array<{ round: number; heldPreview: string | null; burstTransform: string | null }> = []
    for (let round = 0; round < 3; round += 1) {
      const burstRects = await mixedLeafRects()
      if (!burstRects.text) throw new Error(`Missing text leaf rect for burst round ${round}`)
      const from = centerOf(burstRects.text)
      const currentVm = await costumeText('Sprite1', index)
      const burstBase = await previewHtml()
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      let heldPreview: string | null = null
      let burstDelivery: unknown = null
      let postBurstPreview: string | null = null
      try {
        // Arm the drag with real moves: stream the first quarter until a
        // preview lands (async begin resolved, an apply completed).
        const start = Date.now()
        let applied = false
        for (let i = 1; i <= 10 && !applied; i += 1) {
          await page.mouse.move(from.x + ((DX / 4) * i) / 10, from.y + ((DY / 4) * i) / 10, { steps: 2 })
          await page.waitForTimeout(250)
          applied = (await previewHtml()) !== burstBase
          if (!applied && Date.now() - start > 30_000) break
        }
        if (!applied) throw new Error(`rapid-hold drag never applied a preview (round ${round})`)
        // Deterministic burst: 30 moves for the remaining three quarters in
        // one in-page task. The first matching move starts an apply; the
        // other 29 land mid-apply and must coalesce through pending.
        // A capture-phase counter proves the synthetic moves reached the
        // layer (delivery) separately from whether the drag applied them.
        burstDelivery = await page.evaluate(
          ({ fromX, fromY, dx, dy }: { fromX: number; fromY: number; dx: number; dy: number }) => {
            const layer = document.querySelector('[data-reshape-curve-layer]')
            if (!layer) throw new Error('Missing reshape curve layer for synthetic burst')
            const seen: Array<{ id: number; trusted: boolean; x: number }> = []
            const counter = (e: Event) => {
              const p = e as PointerEvent
              seen.push({ id: p.pointerId, trusted: p.isTrusted, x: p.clientX })
            }
            layer.addEventListener('pointermove', counter, true)
            try {
              const N = 30
              for (let i = 1; i <= N; i += 1) {
                const cx = fromX + dx / 4 + ((dx * 3 * i) / 4 / N)
                const cy = fromY + dy / 4 + ((dy * 3 * i) / 4 / N)
                for (const pointerId of [0, 1, 2, 3, 4, 5]) {
                  layer.dispatchEvent(
                    new PointerEvent('pointermove', { pointerId, clientX: cx, clientY: cy, bubbles: true, cancelable: true, buttons: 1 }),
                  )
                }
              }
            } finally {
              layer.removeEventListener('pointermove', counter, true)
            }
            const matched = seen.filter((s) => s.id === 1)
            return { total: seen.length, matched: matched.length, firstX: seen[0]?.x ?? null, lastX: seen[seen.length - 1]?.x ?? null }
          },
          { fromX: from.x, fromY: from.y, dx: DX, dy: DY },
        )
        postBurstPreview = await previewTextTransform()
        // Intentional hold: no events, button still down. A dropped pending
        // move strands the preview here instead of converging.
        await page.waitForTimeout(1500)
        heldPreview = await previewTextTransform()
        // Reunite the real pointer with the burst endpoint before release:
        // synthetic moves never move the OS cursor, and the release rescue
        // legitimately applies the real pointer position. Without this the
        // release would honestly overwrite the preview with the stale real
        // position (a test artifact, not product behavior).
        await page.mouse.move(from.x + DX, from.y + DY, { steps: 3 })
        await page.waitForTimeout(300)
      } finally {
        await page.mouse.up()
      }
      const burstVm = await waitForVmChange('Sprite1', index, currentVm)
      expect(burstVm).not.toBe(currentVm)
      const burstTransform = (await mixedFacts('Sprite1', index)).textTransform
      // Commit correctness per round: the release must land exactly on the
      // settled reference (no data loss at commit regardless of path).
      // Integer client deltas serialize deterministically, so this stays
      // byte-exact.
      if (burstTransform !== refTransform) {
        failReport('rapid-move commit divergence', { round, burstTransform, refTransform })
      }
      expect(burstTransform).toBe(refTransform)
      // Pre-release convergence per round (numeric tolerance): the burst-end
      // and held previews must show the final position, proving pending moves
      // are re-applied rather than dropped. A dropped final 2px step would
      // miss by ~1.3 doc units, far above the 1e-2 tolerance (live-center
      // recomputation and float association jitter at ~1e-5).
      for (const [label, value] of [['postBurst', postBurstPreview], ['held', heldPreview]] as const) {
        const a = translateXY(value)
        const e = translateXY(burstTransform)
        const drift = a && e ? Math.hypot(a[0] - e[0], a[1] - e[1]) : null
        if (drift === null || drift > 1e-2) {
          divergences.push({ round, heldPreview: value, burstTransform })
          failReport('rapid-move pre-release preview strand', { round, label, drift, value, burstTransform, delivery: burstDelivery })
        }
      }
      await clickUndoOnce()
      await waitForVmEqual('Sprite1', index, beforeVm)
    }
    if (divergences.length > 0) {
      failReport('rapid-move pre-release preview strand (pending dropped)', { divergences, refTransform })
    }
    // Pre-release convergence in every round: held previews must already show
    // the final position (pending moves are re-applied, not dropped).
    expect(divergences).toEqual([])
  }, 180_000)

  it('costume/target switches and child order are non-destructive', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('leaf-mixed')
    await selectCostumeByName('leaf-mixed')
    await ensureVectorMode()
    const beforeVm = await costumeText('Sprite1', index)
    const beforeFacts = await mixedFacts('Sprite1', index)
    await selectGroupViaText()
    const rects = await mixedLeafRects()
    if (!rects.text) throw new Error('Missing text leaf rect')
    await dragUntilApplied(centerOf(rects.text), 56, 12)
    const movedVm = await waitForVmChange('Sprite1', index, beforeVm)
    expect(movedVm).not.toBe(beforeVm)
    const movedFacts = await mixedFacts('Sprite1', index)

    // Costume switch away and back: bytes and child order byte-preserved.
    await selectCostumeByName('fill-hole')
    await selectCostumeByName('leaf-mixed')
    await ensureVectorMode()
    expect(await costumeText('Sprite1', index)).toBe(movedVm)
    expect((await mixedFacts('Sprite1', index)).childTags).toBe(movedFacts.childTags)
    expect((await mixedFacts('Sprite1', index)).groupRectHtml).toBe(movedFacts.groupRectHtml)

    // Costume list order is unchanged (the drag never reorders slots).
    const orderBefore = await page.evaluate(() => {
      const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
      return (vm.getTarget('Sprite1')?.costumes ?? []).map((c: any) => c?.name)
    })
    expect(orderBefore).toEqual(['leaf-mixed', 'leaf-singular', 'leaf-clipped', 'leaf-use', 'leaf-rtl', 'fill-hole'])

    // Target switch away and back: the moved bytes survive, and the group is
    // still editable afterwards (non-destructive to future edits).
    await page.getByTestId('target-card-Sprite2').click()
    await page.waitForTimeout(1000)
    await page.getByTestId('target-card-Sprite1').click()
    await ensureVectorMode()
    await selectCostumeByName('leaf-mixed')
    await ensureVectorMode()
    expect(await costumeText('Sprite1', index)).toBe(movedVm)
    // Still editable: one more drag commits on top cleanly.
    await selectGroupViaText()
    const rects2 = await mixedLeafRects()
    if (!rects2.image) throw new Error('Missing image leaf rect after target switch')
    await dragUntilApplied(centerOf(rects2.image), 40, 8)
    const movedAgain = await waitForVmChange('Sprite1', index, movedVm)
    expect(movedAgain).not.toBe(movedVm)
    const againFacts = await mixedFacts('Sprite1', index)
    expect(againFacts.imageAttrs['transform']).toContain('translate(')
    expect(againFacts.textTransform).toBe(movedFacts.textTransform)
    expect(againFacts.childTags).toBe(beforeFacts.childTags)
  }, 180_000)

  it('multi-hole fill still works on its own costume (no cross-feature regression)', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('fill-hole')
    await selectCostumeByName('fill-hole')
    await ensureVectorMode()
    await page.getByTestId('vector-shape-fill').last().click()
    // Solid green paint (toolbar state persists across suites in theory; each
    // `it` here is a fresh page, but set it explicitly anyway).
    const transparentPressed = await page.evaluate(() => {
      const button = document.querySelector('button[aria-label="Transparent fill"]')
      return button?.getAttribute('aria-pressed') === 'true'
    })
    if (transparentPressed) await page.getByRole('button', { name: 'Transparent fill' }).click()
    await page.getByLabel('Vector paint style').selectOption('solid').catch(() => undefined)
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const beforeVm = await costumeText('Sprite1', index)
    expect(beforeVm).toContain('#ff0000')
    expect(beforeVm).not.toContain('#00ff00')
    expect(await undoEnabled()).toBe(false)

    // Hover the hole: real overlay preview, no VM/history write.
    const at = await page.evaluate(() => {
      const surface = document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null
      if (!surface) return null
      const r = surface.getBoundingClientRect()
      return { x: r.left + (190 / 480) * r.width, y: r.top + (150 / 360) * r.height }
    })
    if (!at) throw new Error('Missing vector stage surface')
    await page.mouse.move(at.x, at.y, { steps: 3 })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="vector-fill-hover-preview"]')?.innerHTML.includes('#00ff00') ?? false,
      null,
      { timeout: 30_000 },
    )
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    expect(await undoEnabled()).toBe(false)
    // Commit the hole, then Undo restores byte-exactly.
    await page.mouse.click(at.x, at.y)
    const filled = await waitForVmChange('Sprite1', index, beforeVm)
    expect(filled).toContain('#00ff00')
    expect(filled).toContain('#ff0000')
    expect(await undoEnabled()).toBe(true)
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', index, beforeVm, 30_000)
  }, 180_000)
})
