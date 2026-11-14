// V-7 selection snapshot gap: other vector edits do not refresh the committed
// reshape prior (only nudge/delete/style/add do). Durable real-editor
// regression proving the concrete mismatch.
//
// Fixture: same 4-anchor / 3-cubic open wave as
// `vector-delete-selection-history.browser.test.ts` (masks 4/3 via real
// marquee: select C1+C2, Shift C1 off). Flow per leg:
//   select 4/3 -> ArrowRight nudge (establishes committed snapshot) ->
//   select-only clear (Escape + empty click, no history) ->
//   OTHER vector edit (rect shape draw | brush stroke, each its own tool) ->
//   reselect wave 4/3 (selection-only) -> delete -> Undo.
// Reference (installed `paper` 0.12.18 timing oracle, scratch-exact: snapshot
// on import/update, selection pushes nothing, delete snapshots post-delete,
// undo restores stack[pointer-1]): Undo must restore the snapshot AFTER the
// other edit (post-other bytes + its selection/objects snapshot). The product
// keeps the stale nudged prior (hash mismatch -> fail-closed to
// selection-lost), so the restored selection/objects snapshot mismatches.
// Same-name second costume + external-write fail-closed legs included.
// Verifies actual SVG bytes before/after, UI pressed, same-name asset,
// external byte update. Port 4609 (4603/4604/4605/4606/4607/4608 taken).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4609
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
    meta: { semver: '3.0.0', vm: 'delete-selection-gap', agent: 'delete-selection-gap' },
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
async function vmSvg(costumeIndex = 0): Promise<string> {
  return await page.evaluate(async (idx: number) => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget('MaskV7')
    const cost = tgt.costumes[idx]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, costumeIndex)
}
async function objectCount(): Promise<number> {
  return await page.evaluate(async () => {
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const list = await mod.paperVectorObjectList(html)
    return (list as unknown[]).length
  })
}
async function outlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}
async function selectedOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline].border-blue-500').count()
}
async function selectedOutlineBoxes(): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  const all = page.locator('[data-vector-selection-outline].border-blue-500')
  const n = await all.count()
  const out: Array<{ x: number; y: number; width: number; height: number }> = []
  for (let i = 0; i < n; i += 1) {
    const box = await all.nth(i).boundingBox()
    if (box) out.push({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) })
  }
  return out.sort((a, b) => a.x - b.x || a.y - b.y)
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
async function selectOnlyClear() {
  // Selection-only: Escape + empty-corner click with the select tool.
  // Neither pushes history; bytes must stay identical (asserted by callers).
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(300)
  const surf = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!surf) throw new Error('INVALID: missing paint surface bounds')
  await page.mouse.click(surf.x + 18, surf.y + 18)
  await page.waitForTimeout(500)
}
async function drawRectOtherEdit() {
  await page.getByTestId('vector-shape-rect').last().click()
  await page.waitForTimeout(400)
  const surf = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!surf) throw new Error('INVALID: missing paint surface bounds')
  // Top-left corner, away from the central wave (wave spans center).
  const x0 = surf.x + 28
  const y0 = surf.y + 26
  const x1 = surf.x + 128
  const y1 = surf.y + 86
  const before = await previewInner()
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y1, { steps: 12 })
  await page.mouse.up()
  await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML !== want, before, { timeout: 20_000 })
  await page.waitForTimeout(900)
}
async function drawBrushOtherEdit() {
  await page.getByTestId('vector-shape-brush').last().click()
  await page.waitForTimeout(400)
  const surf = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!surf) throw new Error('INVALID: missing paint surface bounds')
  // Lower-left corner band, distinct from the rect leg's corner.
  const sx = surf.x + 30
  const sy = surf.y + surf.height - 110
  const before = await previewInner()
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 70, sy + 18, { steps: 10 })
  await page.mouse.move(sx + 100, sy - 8, { steps: 6 })
  await page.mouse.up()
  await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML !== want, before, { timeout: 20_000 })
  await page.waitForTimeout(900)
}

describe('vector delete selection history gap: other edits (real editor)', () => {
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

  it('Paper timing oracle: other-edit snapshot (not stale nudge) is the delete->Undo reference', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    const report = await page.evaluate(async () => {
      const paperNs = (window as any).paper ?? await (async () => {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script')
          script.src = '/node_modules/paper/dist/paper-full.js'
          script.onload = () => resolve()
          script.onerror = () => reject(new Error('paper load failed'))
          document.head.appendChild(script)
        })
        return (window as any).paper
      })()
      const buildS = (scope: any): any => {
        scope.activate()
        return new paperNs.Path({
          segments: [
            [[40, 180], null, [60, -70]],
            [[140, 110], [-60, 70], [60, -70]],
            [[240, 40], [-60, 70], [60, -70]],
            [[340, 110], [-60, 70], null],
          ],
        })
      }
      const masksOf = (scope: any): number[] => {
        const found: any[] = []
        const collect = (items: any[]): void => {
          for (const item of items) {
            if (item.segments) found.push(item)
            if (item.children) collect(Array.from(item.children))
          }
        }
        collect(scope.project.layers.flatMap((l: any) => Array.from(l.children)))
        return found.length === 0 ? [] : found[0].segments.map((s: any) => s.selection)
      }
      const leafCount = (scope: any): number =>
        scope.project.selectedItems.filter((i: any) => !(i instanceof paperNs.Layer) && !(i instanceof paperNs.Group)).length
      const makeUndo = () => ({
        stack: [] as any[], pointer: -1,
        snapshot(json: any) { this.stack = this.stack.slice(0, this.pointer + 1).concat([{ json }]); this.pointer += 1 },
        undo(scope: any) {
          if (this.pointer <= 0) return false
          scope.project.clear()
          scope.project.importJSON(this.stack[this.pointer - 1].json)
          this.pointer -= 1
          return true
        },
      })
      const deleteSelected = (scope: any): boolean => {
        const items = scope.project.selectedItems.filter((i: any) => !(i instanceof paperNs.Layer) && !(i instanceof paperNs.Group))
        const doomed: any[] = []
        for (const item of items) {
          if (!item.segments) continue
          for (const seg of item.segments) if (seg.selected) doomed.push(seg)
        }
        for (const seg of doomed) seg.remove()
        return doomed.length > 0
      }
      const scope = new paperNs.PaperScope()
      const canvas = document.createElement('canvas')
      canvas.width = 480; canvas.height = 360
      scope.setup(canvas)
      const undo = makeUndo()
      const path0 = buildS(scope)
      undo.snapshot(scope.project.exportJSON({ asString: false })) // import
      const curves = path0.getCurves()
      curves[0].selected = true; curves[1].selected = true; curves[0].selected = false // 4/3, selection-only
      const lenAfterSelect = undo.stack.length // must stay 1
      // Nudge = post-selection edit snapshot (records 4/3 + moved x).
      const live0: any = scope.project.layers.flatMap((l: any) => Array.from(l.children))[0]
      live0.segments[3].point = live0.segments[3].point.add(new paperNs.Point(6, 0))
      undo.snapshot(scope.project.exportJSON({ asString: false })) // nudge edit
      const masksAtNudge = masksOf(scope)
      const afterNudge = { len: undo.stack.length, pointer: undo.pointer }
      // Select-only clear pushes nothing.
      for (const seg of (scope.project.layers.flatMap((l: any) => Array.from(l.children))[0] as any).segments) seg.selected = false
      const lenAfterClear = undo.stack.length
      // OTHER edit (unrelated tool): add a rect + select ONLY the rect,
      // snapshot post-state (bytes + rect selection, wave unselected).
      const rect = new paperNs.Path.Rectangle(new paperNs.Point(30, 280), new paperNs.Size(90, 50))
      scope.project.getActiveLayer().addChild(rect)
      for (const item of scope.project.layers.flatMap((l: any) => Array.from(l.children))) item.selected = false
      rect.selected = true
      undo.snapshot(scope.project.exportJSON({ asString: false })) // other edit
      const masksAtOther: number[] = (() => {
        const found: any[] = []
        const collect = (items: any[]): void => {
          for (const item of items) {
            if (item.segments) found.push(item)
            if (item.children) collect(Array.from(item.children))
          }
        }
        collect(scope.project.layers.flatMap((l: any) => Array.from(l.children)))
        return found.flatMap((p) => p.segments.map((s: any) => s.selection))
      })()
      const otherBytesHasRect = JSON.stringify(undo.stack[undo.pointer].json).includes('Rectangle')
        || (scope.project.layers.flatMap((l: any) => Array.from(l.children)).length === 2)
      const afterOther = { len: undo.stack.length, pointer: undo.pointer, items: scope.project.layers.flatMap((l: any) => Array.from(l.children)).length }
      // Reselect wave 4/3 (selection-only, no snapshot), delete, undo.
      const wave: any = scope.project.layers.flatMap((l: any) => Array.from(l.children)).find((i: any) => i.segments && i.segments.length === 4)
      for (const item of scope.project.layers.flatMap((l: any) => Array.from(l.children))) item.selected = false
      const wc = wave.getCurves()
      wc[0].selected = true; wc[1].selected = true; wc[0].selected = false
      const lenAfterReselect = undo.stack.length
      // Delete the 2 latent anchors of the wave (4 anchors -> 2 remain).
      const doomed: any[] = []
      for (const seg of wave.segments) if (seg.selected) doomed.push(seg)
      for (const seg of doomed) seg.remove()
      const deletedSegs = masksOf(scope).length
      undo.snapshot(scope.project.exportJSON({ asString: false })) // delete
      undo.undo(scope)
      const itemsAfterUndo: any[] = scope.project.layers.flatMap((l: any) => Array.from(l.children))
      const waveAfter: any = itemsAfterUndo.find((i: any) => i.segments && i.segments.length === 4)
      const rectAfter: any = itemsAfterUndo.find((i: any) => i !== waveAfter)
      const result = {
        paperVersion: paperNs.version,
        lenAfterSelect, masksAtNudge, afterNudge, lenAfterClear,
        masksAtOther, otherBytesHasRect, afterOther, lenAfterReselect, deletedSegs,
        undoItems: itemsAfterUndo.length,
        undoWaveSegs: waveAfter ? waveAfter.segments.length : -1,
        undoMasks: waveAfter ? waveAfter.segments.map((s: any) => s.selection) : [],
        undoLeaf: leafCount(scope),
        undoRectSelected: rectAfter ? rectAfter.selected : false,
        undoWaveSelected: waveAfter ? waveAfter.selected : false,
      }
      scope.remove()
      return result
    })
    expect(report.paperVersion).toBe('0.12.18')
    // Scratch-exact timing: selection-only steps push nothing.
    expect(report.lenAfterSelect).toBe(1)
    expect(report.masksAtNudge).toEqual([0, 4, 3, 0])
    expect(report.afterNudge).toEqual({ len: 2, pointer: 1 })
    expect(report.lenAfterClear).toBe(2)
    // Other edit snapshots its own post-state (rect present, wave cleared).
    expect(report.otherBytesHasRect).toBe(true)
    expect(report.afterOther).toEqual({ len: 3, pointer: 2, items: 2 })
    expect(report.lenAfterReselect).toBe(3)
    expect(report.deletedSegs).toBe(2)
    // Undo restores the OTHER-edit snapshot: rect + wave intact, rect
    // selected (the other edit's objects/selection snapshot), wave 4/3 lost
    // to the reselect (selection-only after the snapshot).
    expect(report.undoItems).toBe(2)
    expect(report.undoWaveSegs).toBe(4)
    expect(report.undoRectSelected).toBe(true)
    expect(report.undoWaveSelected).toBe(false)
    expect(report.undoLeaf).toBe(1)
  }, 60_000)

  it('Gap leg 1 (rect shape): nudge -> clear -> rect -> reselect 4/3 -> delete -> Undo must restore post-rect snapshot', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    const before = await vmSvg(0)
    const altBefore = await vmSvg(1)
    const previewBefore = await previewInner()
    // Latent 4/3 via real marquee (selection-only, bytes unchanged).
    await selectLatent43()
    expect(await vmSvg(0)).toBe(before)
    // Nudge establishes the committed snapshot.
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1000)
    const nudged = await vmSvg(0)
    expect(nudged).not.toBe(before)
    await waitPressedCount(3)
    expect((await pressedAnchors()).length).toBe(1)
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    const previewNudged = await previewInner()
    // Select-only clear: no history, bytes stay nudged.
    await selectOnlyClear()
    await waitPressedCount(0)
    expect(await vmSvg(0)).toBe(nudged)
    // OTHER vector edit, unrelated tool 1: rect shape draw.
    await drawRectOtherEdit()
    const postOther = await vmSvg(0)
    expect(postOther).not.toBe(nudged)
    expect(postOther).not.toBe(before)
    // Normalize to the select tool so the objects/selection snapshot is
    // comparable (rect tool hides outlines; select shows the new rect).
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForTimeout(600)
    const postOtherPreview = await previewInner()
    const postOtherObjects = await objectCount()
    expect(postOtherObjects).toBe(2)
    const postOtherPressed = await pressedCount()
    const postOtherOutlines = await outlineCount()
    const postOtherBlue = await selectedOutlineCount()
    const postOtherBlueBoxes = await selectedOutlineBoxes()
    expect(postOtherBlue).toBe(1)
    // Same-name second costume untouched by the vector edit.
    expect(await vmSvg(1)).toBe(altBefore)
    // Reselect the wave curve (selection-only, bytes unchanged).
    await selectObjectAtStroke()
    await enterReshape()
    await selectLatent43()
    expect(await vmSvg(0)).toBe(postOther)
    await waitPressedCount(3)
    expect((await pressedAnchors()).length).toBe(1)
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    // Delete the 2 latent anchors.
    await page.getByTestId('delete-reshape-point').click()
    await page.waitForTimeout(900)
    const deleted = await vmSvg(0)
    expect(deleted).not.toBe(postOther)
    // Undo must restore the post-other snapshot (reference): exact bytes,
    // exact preview, post-other pressed/outlines/objects, slot stable.
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, postOtherPreview, { timeout: 15_000 })
    expect(await vmSvg(0)).toBe(postOther)
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForTimeout(600)
    // Reference selection/objects snapshot at the other edit (rect selected,
    // reshape cleared): these are the FAILING gap assertions (do not weaken).
    expect(await pressedCount()).toBe(postOtherPressed)
    expect(await outlineCount()).toBe(postOtherOutlines)
    expect(await selectedOutlineCount()).toBe(postOtherBlue)
    expect(await selectedOutlineBoxes()).toEqual(postOtherBlueBoxes)
    expect(await objectCount()).toBe(postOtherObjects)
    expect(await previewInner()).toBe(postOtherPreview)
    // Same-name asset still stable; external write stays fail-closed.
    expect(await vmSvg(1)).toBe(altBefore)
    await page.evaluate(async () => {
      const vm = (window as any).__paintHistoryVm
      const tgt = vm.getTarget('MaskV7')
      const beforeBytes = (await vm.loadAsset(tgt.costumes[0].md5ext, 'svg')) as Uint8Array
      const text = new TextDecoder().decode(beforeBytes).replace('stroke="#111111"', 'stroke="#222222"')
      await vm.updateCostume(tgt.name, 0, {}, new TextEncoder().encode(text))
    })
    expect(await vmSvg(0)).toContain('#222222')
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForTimeout(900)
    expect(await vmSvg(0)).toContain('#222222')
    expect(previewNudged).not.toBe(previewBefore)
  }, 240_000)

  it('Gap leg 2 (brush stroke): nudge -> clear -> brush -> reselect 4/3 -> delete -> Undo must restore post-brush snapshot', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectObjectAtStroke()
    await enterReshape()
    expect(await pressedCount()).toBe(0)
    const before = await vmSvg(0)
    const altBefore = await vmSvg(1)
    await selectLatent43()
    expect(await vmSvg(0)).toBe(before)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1000)
    const nudged = await vmSvg(0)
    expect(nudged).not.toBe(before)
    await waitPressedCount(3)
    await selectOnlyClear()
    await waitPressedCount(0)
    expect(await vmSvg(0)).toBe(nudged)
    // OTHER vector edit, unrelated tool 2: brush stroke (distinct code path
    // `saveVectorBrushStroke`, not the rect `saveVectorShapeInRect`).
    await drawBrushOtherEdit()
    const postOther = await vmSvg(0)
    expect(postOther).not.toBe(nudged)
    expect(postOther).not.toBe(before)
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForTimeout(600)
    const postOtherPreview = await previewInner()
    const postOtherObjects = await objectCount()
    expect(postOtherObjects).toBe(2)
    const postOtherPressed = await pressedCount()
    const postOtherOutlines = await outlineCount()
    const postOtherBlue = await selectedOutlineCount()
    const postOtherBlueBoxes = await selectedOutlineBoxes()
    expect(postOtherBlue).toBe(1)
    expect(await vmSvg(1)).toBe(altBefore)
    await selectObjectAtStroke()
    await enterReshape()
    await selectLatent43()
    expect(await vmSvg(0)).toBe(postOther)
    await waitPressedCount(3)
    expect(await page.getByTestId('delete-reshape-point').getAttribute('aria-label')).toMatch(/2 selected points/)
    await page.getByTestId('delete-reshape-point').click()
    await page.waitForTimeout(900)
    const deleted = await vmSvg(0)
    expect(deleted).not.toBe(postOther)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, postOtherPreview, { timeout: 15_000 })
    expect(await vmSvg(0)).toBe(postOther)
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForTimeout(600)
    // Reference post-brush snapshot (do not weaken: currently mismatches).
    expect(await pressedCount()).toBe(postOtherPressed)
    expect(await outlineCount()).toBe(postOtherOutlines)
    expect(await selectedOutlineCount()).toBe(postOtherBlue)
    expect(await selectedOutlineBoxes()).toEqual(postOtherBlueBoxes)
    expect(await objectCount()).toBe(postOtherObjects)
    expect(await previewInner()).toBe(postOtherPreview)
    expect(await vmSvg(1)).toBe(altBefore)
    await page.evaluate(async () => {
      const vm = (window as any).__paintHistoryVm
      const tgt = vm.getTarget('MaskV7')
      const beforeBytes = (await vm.loadAsset(tgt.costumes[0].md5ext, 'svg')) as Uint8Array
      const text = new TextDecoder().decode(beforeBytes).replace('stroke="#111111"', 'stroke="#222222"')
      await vm.updateCostume(tgt.name, 0, {}, new TextEncoder().encode(text))
    })
    expect(await vmSvg(0)).toContain('#222222')
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForTimeout(900)
    expect(await vmSvg(0)).toContain('#222222')
  }, 240_000)
})
