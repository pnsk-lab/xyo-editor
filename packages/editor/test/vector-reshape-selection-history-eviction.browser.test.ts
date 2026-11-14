// Eviction parity in the REAL Editor: 65+ distinct ~64KiB SVG states through
// REAL UI handlers (marquee {4,3} selection, ArrowRight nudge, 65x Rotate +15
// commits), then Undo all the way back. Pre-fix the 4MiB LRU tracker evicted
// the oldest exact bytes and Undo silently lost the selection; post-fix every
// entry stays usable (per-entry retention sharing `entry.bytes`) and Undo
// restores the exact nudged bytes + {4,3} selection with no extra stale redo.
// Port 4614 (4606 delete-selection-history taken).
//
// Fixture: the Leg-B wave (same anchors as the delete-selection suite, so the
// same marquee bands select {4,3}) painted over a static bulk path that keeps
// every stored state near the 64KiB exact cap. Bulk is static; states stay
// distinct through real nudge commits. Undo/redo go through the real
// costumes-tab shortcuts (Ctrl+Z / Ctrl+Shift+Z); the vector panel exposes no
// aria-labelled Undo buttons in the current Editor.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4614
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g id="bulk">'
const W_D =
  'M120,150 C150,150 150,190 180,190 C210,190 210,230 240,230 C270,260 270,270 300,270'

function bulkPath(count: number): string {
  // Bulk as ONE path object (single units-list entry, like production
  // artwork): thousands of rectangular subpaths keep every stored state near
  // the 64KiB exact cap while the wave stays the only other object.
  // Confined to the bottom-right corner AWAY from the wave and the marquee
  // bands: a marquee must start over empty canvas (mousedown on artwork
  // starts an object drag instead), exactly like the bulk-free oracle suite.
  let d = ''
  for (let k = 0; k < count; k += 1) {
    const x = 360 + ((k * 37) % 112)
    const y = 300 + ((k * 53) % 52)
    d += `M${x} ${y}h3v4h-3Z`
  }
  return `<path d="${d}" fill="#808080"/>`
}

const WAVE_WITH_BULK =
  `${HEAD}${bulkPath(4060)}<path d="${W_D}" fill="none" stroke="#111111" stroke-width="2"/></g></svg>`

function buildSb3(): Buffer {
  const bytes = new TextEncoder().encode(WAVE_WITH_BULK)
  const hash = md5(bytes)
  const project = {
    targets: [
      {
        isStage: false, name: 'EvictV7', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [
          { name: 'w-bulk', assetId: hash, md5ext: `${hash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 },
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'eviction-parity', agent: 'eviction-parity' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), [`${hash}.svg`]: bytes }))
}

async function importSb3(bytes: Buffer) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'w.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'EvictV7') ?? false,
    undefined, { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(900)
}

async function ensureVectorMode() {
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
}

async function pressedCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length)
}
async function waitPressedCount(n: number) {
  await page.waitForFunction((want) => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length === want, n, { timeout: 15_000 })
}
async function vmSvg(): Promise<string> {
  return await page.evaluate(async () => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget('EvictV7')
    const cost = tgt.costumes[0]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  })
}
async function vmSvgLen(): Promise<number> {
  return await page.evaluate(async () => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget('EvictV7')
    const cost = tgt.costumes[0]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return bytes.length
  })
}
async function selectObjectAtStroke() {
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(400)
  const pt = await page.evaluate(() => {
    // The wave is the LAST path (bulk path first, wave on top).
    const paths = document.querySelectorAll('.vector-preview svg path')
    const path = paths[paths.length - 1] as unknown as SVGPathElement | null
    if (!path) return null
    try {
      const len = path.getTotalLength()
      const p = path.getPointAtLength(len * 0.3)
      const ctm = path.getScreenCTM()
      if (!ctm) return null
      const dom = new DOMPoint(p.x, p.y).matrixTransform(ctm as unknown as DOMMatrix)
      return { x: dom.x, y: dom.y }
    } catch { return null }
  })
  if (!pt) throw new Error('INVALID: missing stroke point')
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(700)
}
async function enterReshape() {
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.waitForSelector('[data-vector-path-point]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-vector-path-point]')].filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length >= 4, undefined, { timeout: 15_000 })
}
async function hitLayerRect() {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-reshape-curve-layer]') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  })
}
async function surfaceRect() {
  return await page.evaluate(() => {
    const s = document.querySelector('[data-testid="costume-paint-surface"]') as HTMLElement | null
    if (!s) throw new Error('INVALID: no paint surface')
    const r = s.getBoundingClientRect()
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }
  })
}
async function marqueeSelect(x0: number, y0: number, x1: number, y1: number) {
  const [hit, surf] = await Promise.all([hitLayerRect(), surfaceRect()])
  let sx = x0
  let sy = y0
  if (hit && sx >= hit.left - 2 && sx <= hit.right + 2 && sy >= hit.top - 2 && sy <= hit.bottom + 2) sx = hit.left - 12
  sx = Math.max(surf.x + 3, Math.min(sx, surf.right - 3))
  sy = Math.max(surf.y + 3, Math.min(sy, surf.bottom - 3))
  const ex = Math.max(surf.x + 3, Math.min(x1, surf.right - 3))
  const ey = Math.max(surf.y + 3, Math.min(y1, surf.bottom - 3))
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(ex, ey, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(500)
}
async function curveBandBetweenAnchors(sortedA: number, sortedB: number) {
  const anchors = (await page.evaluate(() => {
    const out: Array<{ x: number; y: number; pressed: boolean; control: boolean; index: number }> = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const label = el.getAttribute('aria-label') ?? ''
      const r = (el as HTMLElement).getBoundingClientRect()
      out.push({ index: Number((el as HTMLElement).dataset.pointIndex), x: r.left + r.width / 2, y: r.top + r.height / 2, pressed: el.getAttribute('aria-pressed') === 'true', control: label.startsWith('Move control point') })
    }
    return out.sort((a, b) => a.index - b.index)
  })).filter((h) => !h.control).sort((a, b) => a.y - b.y)
  const top = anchors[Math.min(sortedA, sortedB)]!
  const mid = anchors[Math.max(sortedA, sortedB)]!
  const x0 = Math.min(...anchors.map((h) => h.x)) - 60
  const x1 = Math.max(...anchors.map((h) => h.x)) + 60
  const y0 = top.y + 18
  const y1 = mid.y - 18
  return { x0, x1, y0, y1 }
}
async function selectLatent43() {
  const bandC1 = await curveBandBetweenAnchors(1, 2)
  await marqueeSelect(bandC1.x0, bandC1.y0, bandC1.x1, bandC1.y1)
  await waitPressedCount(4)
  const bandC2 = await curveBandBetweenAnchors(2, 3)
  await page.keyboard.down('Shift')
  await marqueeSelect(bandC2.x0, bandC2.y0, bandC2.x1, bandC2.y1)
  await page.keyboard.up('Shift')
  await waitPressedCount(7)
  await page.keyboard.down('Shift')
  await marqueeSelect(bandC1.x0, bandC1.y0, bandC1.x1, bandC1.y1)
  await page.keyboard.up('Shift')
  await waitPressedCount(3)
}
async function waitVmSvgDiffer(prev: string, what: string, timeout = 20_000): Promise<string> {
  return await page.evaluate(async ({ want, what: label, timeoutMs }) => {
    const vm = (window as any).__paintHistoryVm
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const tgt = vm.getTarget('EvictV7')
      const cost = tgt.costumes[0]
      const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
      const text = new TextDecoder().decode(bytes)
      if (text !== want) return text
      if (Date.now() > deadline) throw new Error(`INVALID: ${label} never landed`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }, { want: prev, what, timeoutMs: timeout })
}

describe('vector reshape eviction parity (real editor, 65+ x ~64KiB)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  }, 120_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('65 rotates + nudge undo back to the evicted oldest: bytes + {4,3}, no stale redo', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    await selectLatent43()
    // Regime check: every stored state must sit near the 64KiB exact cap
    // (otherwise the test proves nothing about per-entry retention).
    const storedLen = await vmSvgLen()
    expect(storedLen).toBeGreaterThan(60000)
    expect(storedLen).toBeLessThanOrEqual(65536)
    const before = await vmSvg()
    // Nudge records the {4,3} snapshot (one history entry).
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1000)
    const nudged = await vmSvg()
    expect(nudged).not.toBe(before)
    await waitPressedCount(3)

    // 65 real ArrowRight nudge commits (one history entry per press-release
    // cycle): 66 entries total (> 64-entry LRU that evicted the oldest
    // pre-fix). Poll the real VM bytes per step. Nudges are the
    // reshape-mode-native commit path (the inspector Rotate buttons hide
    // while reshape is active).
    let prev = nudged
    for (let i = 0; i < 65; i += 1) {
      await page.keyboard.press('ArrowRight')
      const next = await waitVmSvgDiffer(prev, `nudge ${i}`)
      expect(next).not.toBe(prev)
      prev = next
      if (i === 32) await waitPressedCount(3)
    }
    await waitPressedCount(3)
    // Still in-cap after 65 commits (bulk preserved, transforms distinct).
    const liveLen = await vmSvgLen()
    expect(liveLen).toBeGreaterThan(60000)
    expect(liveLen).toBeLessThanOrEqual(65536)

    // Undo ALL the way back through the real shortcut: 66 entries.
    for (let i = 0; i < 66; i += 1) {
      const cur = await vmSvg()
      await page.keyboard.press('Control+z')
      await waitVmSvgDiffer(cur, `undo ${i}`)
    }
    // Final state: exact pre-nudge bytes with the {4,3} selection restored
    // (the nudge entry's own snapshot), no silent selection loss.
    expect(await vmSvg()).toBe(before)
    await waitPressedCount(3)
    // Redo once re-applies the nudge bytes exactly (no extra stale redo).
    await page.keyboard.press('Control+Shift+z')
    await waitVmSvgDiffer(before, 'redo')
    expect(await vmSvg()).toBe(nudged)
    await waitPressedCount(3)
  }, 600_000)
})
