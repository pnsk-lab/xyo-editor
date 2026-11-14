// V-7 selection snapshot history: real-Editor oracle legs.
//
// Fixture: 4-anchor / 3-cubic open wave (same as latent-style).
// Leg A (oracle Scenario A): select {middle:4, far:3} via real marquee, delete
// immediately (no intermediate edit snapshot), Undo restores bytes exactly
// with selection LOST (0 pressed) — the post-selection UI was never snapshotted.
// Leg B (oracle Scenario B): reselect {4,3}, ArrowRight nudge (one history
// entry), delete, Undo restores the nudged bytes + {4,3} selection; Redo
// re-applies the delete bytes exactly. Same-name second costume + external
// write legs prove stable-id/CAS fail-closed and no cross-slot retarget.
// Port 4606 (4603 adversarial, 4604 latent-nudge, 4605 latent-style taken).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4606
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const W_D = 'M120,150 C150,150 150,190 180,190 C210,190 210,230 240,230 C270,260 270,270 300,270'
const wSvg = (inner: string) => `${HEAD}${inner}</svg>`
const W_OPEN = wSvg(`<path d="${W_D}" fill="none" stroke="#111111" stroke-width="2"/>`)
const ALT_OPEN = wSvg(`<rect x="60" y="60" width="80" height="50" fill="none" stroke="#111111" stroke-width="2"/>`)

function buildSb3(): Buffer {
  const bytes = new TextEncoder().encode(W_OPEN)
  const hash = md5(bytes)
  const altBytes = new TextEncoder().encode(ALT_OPEN)
  const altHash = md5(altBytes)
  const project = {
    targets: [
      {
        isStage: false, name: 'MaskV7', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [
          { name: 'w-open', assetId: hash, md5ext: `${hash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 },
          { name: 'w-open', assetId: altHash, md5ext: `${altHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 },
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'delete-selection-history', agent: 'delete-selection-history' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), [`${hash}.svg`]: bytes, [`${altHash}.svg`]: altBytes }))
}

async function importSb3(bytes: Buffer) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'w.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'MaskV7') ?? false,
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
async function pressedAnchors(): Promise<number[]> {
  return await page.evaluate(() => {
    const out: number[] = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const label = el.getAttribute('aria-label') ?? ''
      if (!label.startsWith('Move control point') && el.getAttribute('aria-pressed') === 'true') out.push(Number((el as HTMLElement).dataset.pointIndex))
    }
    return out.sort((a, b) => a - b)
  })
}
async function previewInner(): Promise<string> { return await page.locator('.vector-preview').innerHTML() }
async function vmSvg(): Promise<string> {
  return await page.evaluate(async () => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget('MaskV7')
    const cost = tgt.costumes[0]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  })
}
async function selectObjectAtStroke() {
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(400)
  const pt = await page.evaluate(() => {
    const path = document.querySelector('.vector-preview svg path') as unknown as SVGPathElement | null
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

describe('vector delete selection snapshot history (real editor)', () => {
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

  it('oracle: neighboring deselect leaves middle 4 / far 3 with exact JSON flags', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    const report = await page.evaluate(async () => {
      const paperNs = (window as any).paper ?? (await (async () => {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script')
          script.src = '/node_modules/paper/dist/paper-full.js'
          script.onload = () => resolve()
          script.onerror = () => reject(new Error('paper load failed'))
          document.head.appendChild(script)
        })
        return (window as any).paper
      })())
      const scope = new paperNs.PaperScope()
      const canvas = document.createElement('canvas')
      canvas.width = 480; canvas.height = 360
      scope.setup(canvas); scope.activate()
      try {
        const path = new paperNs.Path({
          segments: [[[40, 180], null, [60, -70]], [[140, 110], [-60, 70], [60, -70]], [[240, 40], [-60, 70], [60, -70]], [[340, 110], [-60, 70], null]],
        })
        const curves = path.getCurves()
        curves[0].selected = true; curves[1].selected = true; curves[0].selected = false
        const masks = path.segments.map((s: any) => s.selection)
        const json: any = scope.project.exportJSON({ asString: false })
        const found: number[] = []
        const walk = (node: any): void => {
          if (Array.isArray(node)) { for (const v of node) walk(v); return }
          if (node && typeof node === 'object') {
            if (Array.isArray(node.segments)) for (const entry of node.segments) {
              if (Array.isArray(entry) && entry.length === 4 && Number.isInteger(entry[3])) found.push(entry[3])
            }
            for (const k of Object.keys(node)) walk(node[k])
          }
        }
        walk(json)
        scope.project.clear()
        scope.project.importJSON(json)
        const restored: any = scope.project.layers.flatMap((l: any) => Array.from(l.children)).flatMap((item: any) => (item.segments ? [item] : item.children ? Array.from(item.children) : [])).find((item: any) => item.segments)
        return { version: paperNs.version, masks, flags: found, restored: restored.segments.map((s: any) => s.selection) }
      } finally { scope.remove() }
    })
    expect(report.version).toBe('0.12.18')
    expect(report.masks).toEqual([0, 4, 3, 0])
    expect(report.flags).toEqual([4, 3])
    expect(report.restored).toEqual([0, 4, 3, 0])
  }, 60_000)

  it('Leg A: selection-only -> delete -> undo restores bytes, selection lost', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    const before = await vmSvg()
    const previewBefore = await previewInner()
    await selectLatent43()
    expect(await vmSvg()).toBe(before)
    await page.getByTestId('delete-reshape-point').click()
    await page.waitForTimeout(900)
    const deleted = await vmSvg()
    expect(deleted).not.toBe(before)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, previewBefore, { timeout: 15_000 })
    expect(await vmSvg()).toBe(before)
    // Oracle Scenario A: post-selection UI was never snapshotted, so undo
    // restores no selection.
    await waitPressedCount(0)
    expect(await pressedAnchors()).toEqual([])
  }, 180_000)

  it('Leg B: selection -> nudge -> delete -> undo restores nudged bytes + 4/3, redo exact', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectObjectAtStroke()
    await enterReshape()
    const before = await vmSvg()
    const previewBefore = await previewInner()
    await selectLatent43()
    // Nudge records the 4,3 snapshot: ArrowRight moves both latent anchors.
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1000)
    const nudged = await vmSvg()
    expect(nudged).not.toBe(before)
    await waitPressedCount(3)
    const previewNudged = await previewInner()
    await page.getByTestId('delete-reshape-point').click()
    await page.waitForTimeout(900)
    const deleted = await vmSvg()
    expect(deleted).not.toBe(nudged)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, previewNudged, { timeout: 15_000 })
    expect(await vmSvg()).toBe(nudged)
    await waitPressedCount(3)
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    // Redo re-applies the delete bytes exactly; same-name costume untouched.
    await page.locator('button[aria-label="Redo"]:visible').click()
    await page.waitForTimeout(900)
    expect(await vmSvg()).toBe(deleted)
    // External write fail-closed: direct VM write bumps writeSeq, next undo keeps it.
    await page.evaluate(async () => {
      const vm = (window as any).__paintHistoryVm
      const tgt = vm.getTarget('MaskV7')
      const before = await vm.loadAsset(tgt.costumes[0].md5ext, 'svg')
      const text = new TextDecoder().decode(before as Uint8Array).replace('stroke="#111111"', 'stroke="#222222"')
      await vm.updateCostume(tgt.name, 0, {}, new TextEncoder().encode(text))
    })
    const externallyChanged = await vmSvg()
    expect(externallyChanged).toContain('#222222')
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForTimeout(900)
    // External kept (fail-closed), not rewound to the delete snapshot.
    expect(await vmSvg()).toContain('#222222')
  }, 240_000)
})
