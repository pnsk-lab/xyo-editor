// center-snap VECTOR real-drag verification (NEW TEST ONLY, no product source change).
//
// Covers the gap in center-snap-real-editor-verify.browser.test.ts, whose
// vector section is static-pin only: this file drives REAL pointer drags in
// the REAL Editor against the REAL VM for a visible square and a
// multi-select union whose center is the fixed SVG anchor (240,180).
// For each Paper UI 67%/100%/500% (CSS 0.333/2.5, 0.5/2.5=0.2, 1.0;
// Paper zooms 0.333/0.5/2.5) it verifies with real mouse:
// - +2.5 screen px toward/away from (240,180) snaps EXACTLY (bounds unchanged),
// - +5.0 screen px does NOT snap (bounds move by 5/surfaceScale SVG units,
//   where surfaceScale = 5*realCssScale from the live stage-surface rect;
//   the Reset label is UI percent only, never the scale),
// - Shift-held +2.5px does NOT snap and hides the guide,
// - screen-constant guide diameter ~=16px mid-drag and zero residual after
//   pointerup / Undo / Redo / Escape,
// - SVG bounds (paperVectorObjectList on the live .vector-preview) together
//   with VM snapshot asset/stage position (target x/y, stage, rotationCenter),
// - Undo reverts / Redo reapplies the 5px move, Escape mid-drag hides guide.
// Off-screen points are panned into view with REAL wheel gestures before the
// exact drag; no synthetic PointerEvent dispatch, no mocked helpers, no
// widened expectations. Dedicated free loopback port per run, real Chrome via
// CHROME_BIN fallback.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}
function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}
function log(label: string, value: unknown) {
  console.log(`[center-snap-vector-drag] ${label} ${JSON.stringify(value).slice(0, 6000)}`)
}

function singleSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect x="220" y="160" width="40" height="40" fill="#ff0000"/></svg>`
}
function multiSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect x="228" y="168" width="20" height="20" fill="#ff0000"/><rect x="232" y="172" width="20" height="20" fill="#00ff00"/></svg>`
}
function emptySvgBytes(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>')
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
}
async function importSb3(page: Page, bytes: Buffer, expectName: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'center-snap-vector.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as any).__hikkakuEditorTest?.snapshot()
      return snap?.project.targets.some((t: any) => t.costumes.some((c: any) => c.name === want)) ?? false
    },
    expectName,
    { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)
}
async function previewSvg(page: Page): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}
type SvgBounds = { x: number; y: number; width: number; height: number }
async function boundsList(page: Page, svg: string): Promise<SvgBounds[]> {
  return await page.evaluate(async (text: string) => {
    const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const list = await (mod as any).paperVectorObjectList(text)
    return (list as any[]).map((o: any) => ({ x: o.boundsX, y: o.boundsY, width: o.boundsWidth, height: o.boundsHeight }))
  }, svg)
}
function unionOf(boxes: SvgBounds[]): SvgBounds {
  const l = Math.min(...boxes.map((b) => b.x))
  const t = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.width))
  const b = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: l, y: t, width: r - l, height: b - t }
}
async function zoomUiPercent(page: Page): Promise<number> {
  // UI label only: vector reset 0.2 reads "100%", floor 0.1332 reads "67%".
  // Never use label/100 as the CSS scale (Paper reset basis).
  const btn = page.locator('[data-testid="costume-paint-surface"] button[aria-label="Reset zoom"]')
  const label = (await btn.first().textContent()) ?? ''
  const parsed = Number.parseFloat(label.replace('%', ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100
}
async function realVectorCssScale(page: Page): Promise<number> {
  // Real computed CSS scale from the live stage surface rect (Paper basis):
  // style width 2400px * viewportScale = rect.width, so scale = rect/2400.
  // Vector reset renders 480 CSS px (2400*0.2) at UI "100%".
  const w = await page.evaluate(() => {
    const el = document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null
    return el ? el.getBoundingClientRect().width : 0
  })
  return w && w > 0 ? w / 2400 : 0.2
}
async function realSurfacePxPerSvg(page: Page): Promise<number> {
  return (await realVectorCssScale(page)) * 5
}
async function setZoomUi(page: Page, targetUi: number) {
  // Paper reset is exact via Reset (UI "100%" = CSS 0.2); vector button steps
  // are +0.2 CSS (+0.5 Paper via density 2.5), floor-exit 67%->100% in one step.
  if (targetUi === 100) {
    await page.locator('[data-testid="costume-paint-surface"] button[aria-label="Reset zoom"]').first().click()
    await page.waitForTimeout(500)
    return await zoomUiPercent(page)
  }
  for (let i = 0; i < 30; i += 1) {
    const cur = await zoomUiPercent(page)
    if (Math.abs(cur - targetUi) < 0.5) return cur
    if (cur < targetUi) await page.locator('[data-testid="costume-paint-surface"] button[aria-label="Zoom in"]').first().click()
    else await page.locator('[data-testid="costume-paint-surface"] button[aria-label="Zoom out"]').first().click()
    await page.waitForTimeout(180)
  }
  return await zoomUiPercent(page)
}
async function guideState(page: Page) {
  return await page.evaluate(() => {
    const h = [...document.querySelectorAll('[data-testid="move-center-crosshair"]')].filter(
      (e) => (e as HTMLElement).dataset.guideMode === 'vector',
    ) as HTMLElement[]
    const v = [...document.querySelectorAll('[data-testid="move-center-crosshair-vertical"]')].filter(
      (e) => (e as HTMLElement).dataset.guideMode === 'vector',
    ) as HTMLElement[]
    const parse = (s: string) => {
      const o: Record<string, number> = {}
      for (const part of s.split(';')) {
        const m = part.match(/(left|top|width|height|opacity):\s*([\d.\-eE+]+)(px|%)?/)
        if (m) o[m[1]!] = Number.parseFloat(m[2]!)
      }
      return o
    }
    const rectOf = (el: HTMLElement | undefined) => (el ? el.getBoundingClientRect().toJSON() : null)
    return {
      count: h.length + v.length,
      h: h[0] ? { style: h[0].getAttribute('style'), parsed: parse(h[0].getAttribute('style') ?? ''), rect: rectOf(h[0]) } : null,
      v: v[0] ? { style: v[0].getAttribute('style'), parsed: parse(v[0].getAttribute('style') ?? ''), rect: rectOf(v[0]) } : null,
    }
  })
}
async function outlineCenter(page: Page, which: 'first' | 'last' = 'last') {
  const loc = which === 'last' ? page.locator('[data-vector-selection-outline]').last() : page.locator('[data-vector-selection-outline]').first()
  await loc.waitFor({ state: 'visible', timeout: 15_000 })
  const box = await loc.boundingBox()
  if (!box) throw new Error('missing vector outline box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}
async function outlineCount(page: Page): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}
async function snapshotTargets(page: Page) {
  return await page.evaluate(() => {
    const snap = (window as any).__hikkakuEditorTest?.snapshot()
    return {
      status: (window as any).__hikkakuEditorTest?.status?.() ?? '',
      targets: (snap?.project.targets ?? []).map((t: any) => ({
        name: t.name, isStage: t.isStage, x: t.x, y: t.y,
        currentCostume: t.currentCostume,
        costumes: (t.costumes ?? []).map((c: any) => ({ name: c.name, dataFormat: c.dataFormat, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY })),
      })),
    }
  })
}
async function ensurePointVisible(page: Page, pt: { x: number; y: number }, margin = 30) {
  for (let i = 0; i < 5; i += 1) {
    const cont = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!cont) return
    const inside = pt.x > cont.x + margin && pt.x < cont.x + cont.width - margin && pt.y > cont.y + margin && pt.y < cont.y + cont.height - margin
    if (inside) return
    const cx = cont.x + cont.width / 2
    const cy = cont.y + cont.height / 2
    const dx = pt.x - cx
    const dy = pt.y - cy
    log('pan-to-visible', { pt, cont, dx, dy, attempt: i })
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(450)
  }
}
async function ensureCenterVisible(page: Page) {
  const c = await outlineCenter(page, 'last')
  await ensurePointVisible(page, c)
  return await outlineCenter(page, 'last')
}

describe('center-snap vector real drag at SVG (240,180) (new tests only)', () => {
  beforeAll(async () => {
    const port = await getFreePort()
    base = `http://127.0.0.1:${port}`
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 150; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${port}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 90_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('single square: real drag 2.5px snaps exact, 5px moves, Shift excludes, at UI 67/100/500% (Paper 0.333/0.5/2.5)', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      const single = singleSvg()
      const sFile = `${md5(new TextEncoder().encode(single))}.svg`
      const empty = emptySvgBytes(); const emptyHash = md5(empty)
      const project = {
        targets: [
          { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'b', assetId: emptyHash, md5ext: `${emptyHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
          { isStage: false, name: 'VecSingle', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'single', assetId: md5(new TextEncoder().encode(single)), md5ext: sFile, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
        ], monitors: [], extensions: [], meta: { semver: '3.0.0', vm: 'center-snap-vector-drag', agent: 'center-snap-vector-drag' },
      }
      await openCostumes(page)
      await importSb3(page, Buffer.from(buildSb3(project, { [sFile]: new TextEncoder().encode(single), [`${emptyHash}.svg`]: empty })), 'single')
      await page.getByTestId('target-card-VecSingle').click().catch(() => {})
      await page.waitForTimeout(500)
      await page.locator('[data-testid="vector-shape-select"]').first().click().catch(() => {})
      await page.waitForTimeout(300)
      expect(await outlineCount(page)).toBeGreaterThanOrEqual(1)

      for (const ui of [67, 100, 500]) {
        const gotUi = await setZoomUi(page, ui)
        const css = await realVectorCssScale(page)
        const surf = css * 5
        // Paper basis: UI 67% => CSS 0.333/2.5, 100% => 0.5/2.5=0.2, 500% => 1.0.
        // Label is UI only; all SVG math uses the real computed CSS/surface scale.
        const expectCss = ui === 67 ? 0.333 / 2.5 : ui === 100 ? 0.5 / 2.5 : 1.0
        log('zoom-set', { wantUi: ui, gotUi, css, surf, expectCss })
        expect(Math.abs(gotUi - ui)).toBeLessThanOrEqual(1.5)
        expect(Math.abs(css - expectCss) / expectCss).toBeLessThan(0.08)
        await page.waitForTimeout(500)
        // Baseline: single rect must sit exactly on (240,180).
        let svg = await previewSvg(page)
        let boxes = await boundsList(page, svg)
        expect(boxes.length).toBeGreaterThanOrEqual(1)
        let u = unionOf(boxes)
        log(`ui${ui}-baseline`, { u, boxes: boxes.slice(0, 3), css, surf })
        expect(Math.abs((u.x + u.width / 2) - 240)).toBeLessThanOrEqual(0.6)
        expect(Math.abs((u.y + u.height / 2) - 180)).toBeLessThanOrEqual(0.6)
        const baseSvg = svg
        const baseUnion = { ...u }
        const snap0 = await snapshotTargets(page)
        const vec0 = snap0.targets.find((t: any) => t.name === 'VecSingle')
        expect(vec0?.x).toBe(0); expect(vec0?.y).toBe(0)

        // --- 2.5px exact snap: drag center +2.5 screen px, must return exactly ---
        let start = await ensureCenterVisible(page)
        await ensurePointVisible(page, { x: start.x + 2.5, y: start.y })
        start = await outlineCenter(page, 'last')
        log(`ui${ui}-snap-start`, { start })
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(start.x + 2.5, start.y, { steps: 3 })
        await page.waitForTimeout(450)
        const gMid = await guideState(page)
        const svgMid = await previewSvg(page)
        log(`ui${ui}-2.5-mid`, { gMid, changed: svgMid !== baseSvg })
        await page.mouse.up()
        await page.waitForTimeout(650)
        const gAfterSnap = await guideState(page)
        svg = await previewSvg(page)
        boxes = await boundsList(page, svg)
        u = unionOf(boxes)
        log(`ui${ui}-2.5-after`, { u, gAfterSnap })
        // Exact: union center back at (240,180); svg-unit tolerance is tight
        // (snap returns zero displacement, no float accumulation). A
        // zero-displacement snap shows no guide by design (guide needs an
        // effective move), so mid-drag guide must also be hidden here.
        expect(Math.abs((u.x + u.width / 2) - 240)).toBeLessThanOrEqual(0.12)
        expect(Math.abs((u.y + u.height / 2) - 180)).toBeLessThanOrEqual(0.12)
        expect(Math.abs(u.x - baseUnion.x)).toBeLessThanOrEqual(0.12)
        expect(Math.abs(u.y - baseUnion.y)).toBeLessThanOrEqual(0.12)
        expect(gMid.count).toBe(0)
        expect(gAfterSnap.count).toBe(0)
        // VM/stage untouched by the snapped (noop) drag.
        const snapAfter = await snapshotTargets(page)
        const vecAfter = snapAfter.targets.find((t: any) => t.name === 'VecSingle')
        expect(vecAfter?.x).toBe(0); expect(vecAfter?.y).toBe(0)
        expect(snapAfter.targets.some((t: any) => t.isStage)).toBe(true)
        expect(await page.getByTestId('stage-canvas').isVisible()).toBe(true)

        // --- 5px must NOT snap: moves by exactly 5/(5*z) svg units ---
        start = await ensureCenterVisible(page)
        await ensurePointVisible(page, { x: start.x + 5, y: start.y })
        start = await outlineCenter(page, 'last')
        const before5 = await previewSvg(page)
        const beforeBoxes = await boundsList(page, before5)
        const beforeU = unionOf(beforeBoxes)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(start.x + 5, start.y, { steps: 3 })
        await page.waitForTimeout(450)
        const gMid5 = await guideState(page)
        await page.mouse.up()
        await page.waitForTimeout(650)
        const gAfter5 = await guideState(page)
        svg = await previewSvg(page)
        boxes = await boundsList(page, svg)
        u = unionOf(boxes)
        const expectedDx = 5 / surf
        log(`ui${ui}-5-after`, { u, beforeU, expectedDx, gMid5, gAfter5 })
        expect(Math.abs((u.x - beforeU.x) - expectedDx)).toBeLessThanOrEqual(0.16)
        expect(Math.abs(u.y - beforeU.y)).toBeLessThanOrEqual(0.12)
        // Proves non-snap: moved at least half the expected distance.
        expect(Math.abs(u.x - beforeU.x)).toBeGreaterThan(Math.abs(expectedDx) * 0.5)
        // Non-snap drag has an effective move, so the 16px guide is visible mid-drag.
        expect(gMid5.count).toBeGreaterThan(0)
        expect(Number(gMid5.h?.parsed.opacity ?? 0)).toBeGreaterThan(0)
        if (gMid5.h?.rect && gMid5.v?.rect) {
          expect(Math.abs(gMid5.h.rect.width - 16)).toBeLessThanOrEqual(2.5)
          expect(Math.abs(gMid5.v.rect.height - 16)).toBeLessThanOrEqual(2.5)
        }
        expect(gAfter5.count).toBe(0)
        // Offset snap-back with movement: from +5px offset, drag -2.5px screen
        // lands 2.5px from center and must snap EXACTLY with a visible guide.
        {
          const offStart = await ensureCenterVisible(page)
          await ensurePointVisible(page, { x: offStart.x - 2.5, y: offStart.y })
          const s2 = await outlineCenter(page, 'last')
          await page.mouse.move(s2.x, s2.y)
          await page.mouse.down()
          await page.mouse.move(s2.x - 2.5, s2.y, { steps: 3 })
          await page.waitForTimeout(450)
          const gOffMid = await guideState(page)
          await page.mouse.up()
          await page.waitForTimeout(650)
          const uOff = unionOf(await boundsList(page, await previewSvg(page)))
          log(`ui${ui}-offset-snap-after`, { uOff, gOffMid })
          expect(Math.abs((uOff.x + uOff.width / 2) - 240)).toBeLessThanOrEqual(0.12)
          expect(Math.abs((uOff.y + uOff.height / 2) - 180)).toBeLessThanOrEqual(0.12)
          expect(gOffMid.count).toBeGreaterThan(0)
          if (gOffMid.h?.rect && gOffMid.v?.rect) {
            expect(Math.abs(gOffMid.h.rect.width - 16)).toBeLessThanOrEqual(2.5)
            expect(Math.abs(gOffMid.v.rect.height - 16)).toBeLessThanOrEqual(2.5)
          }
          expect((await guideState(page)).count).toBe(0)
        }
        // Undo/Redo across both entries (real buttons): Undo the snap-back to
        // the +5px offset, Redo to center, then Undo twice to the baseline.
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(700)
        const svgUndo = await previewSvg(page)
        const uUndo = unionOf(await boundsList(page, svgUndo))
        log(`ui${ui}-5-undo`, { uUndo })
        expect(Math.abs(uUndo.x - u.x)).toBeLessThanOrEqual(0.16)
        expect(Math.abs(uUndo.y - u.y)).toBeLessThanOrEqual(0.12)
        expect((await guideState(page)).count).toBe(0)
        await page.getByRole('button', { name: 'Redo' }).last().click()
        await page.waitForTimeout(700)
        const svgRedo = await previewSvg(page)
        const uRedo = unionOf(await boundsList(page, svgRedo))
        log(`ui${ui}-5-redo`, { uRedo })
        expect(Math.abs((uRedo.x + uRedo.width / 2) - 240)).toBeLessThanOrEqual(0.16)
        expect((await guideState(page)).count).toBe(0)
        // Restore centered baseline with two Undos for the next subtest.
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(700)
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(700)
        const svgRestored = await previewSvg(page)
        const uRestored = unionOf(await boundsList(page, svgRestored))
        expect(Math.abs((uRestored.x + uRestored.width / 2) - 240)).toBeLessThanOrEqual(0.16)

        // --- Shift excludes snap: press Shift AFTER mouse.down so the press
        // does not toggle the selection (Shift+press is append); the live
        // Shift during the move still projects and excludes center snap ---
        start = await ensureCenterVisible(page)
        await ensurePointVisible(page, { x: start.x + 2.5, y: start.y })
        start = await outlineCenter(page, 'last')
        const beforeShift = unionOf(await boundsList(page, await previewSvg(page)))
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.keyboard.down('Shift')
        await page.mouse.move(start.x + 2.5, start.y, { steps: 3 })
        await page.waitForTimeout(450)
        const gShift = await guideState(page)
        await page.mouse.up()
        await page.keyboard.up('Shift')
        await page.waitForTimeout(650)
        svg = await previewSvg(page)
        boxes = await boundsList(page, svg)
        u = unionOf(boxes)
        log(`ui${ui}-shift-after`, { u, beforeShift, gShift })
        const shiftExpected = 2.5 / surf
        expect(Math.abs((u.x - beforeShift.x) - shiftExpected)).toBeLessThanOrEqual(0.2)
        expect(Math.abs(u.x - beforeShift.x)).toBeGreaterThan(Math.abs(shiftExpected) * 0.5)
        expect(Math.abs(u.y - beforeShift.y)).toBeLessThanOrEqual(0.12)
        expect((gShift.count as number)).toBe(0)
        expect(Number(gShift.h?.parsed.opacity ?? 0)).toBe(0)
        expect((await guideState(page)).count).toBe(0)
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(700)

        // --- Escape mid-drag hides guide without residual ---
        start = await ensureCenterVisible(page)
        await ensurePointVisible(page, { x: start.x + 30, y: start.y })
        start = await outlineCenter(page, 'last')
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(start.x + 30, start.y, { steps: 5 })
        await page.waitForTimeout(450)
        const gEscMid = await guideState(page)
        log(`ui${ui}-esc-mid`, { gEscMid })
        await page.keyboard.press('Escape')
        await page.waitForTimeout(450)
        const gEsc = await guideState(page)
        try { await page.mouse.up() } catch {}
        await page.waitForTimeout(650)
        const gEscAfter = await guideState(page)
        log(`ui${ui}-esc-after`, { gEsc, gEscAfter })
        expect((gEsc.count as number)).toBe(0)
        expect((gEscAfter.count as number)).toBe(0)
        // Restore whatever the interrupted drag applied.
        for (let k = 0; k < 3; k += 1) {
          const curU = unionOf(await boundsList(page, await previewSvg(page)))
          if (Math.abs((curU.x + curU.width / 2) - 240) <= 0.2 && Math.abs((curU.y + curU.height / 2) - 180) <= 0.2) break
          await page.getByRole('button', { name: 'Undo' }).last().click()
          await page.waitForTimeout(600)
        }
        const uFinal = unionOf(await boundsList(page, await previewSvg(page)))
        log(`ui${ui}-final`, { uFinal })
        expect(Math.abs((uFinal.x + uFinal.width / 2) - 240)).toBeLessThanOrEqual(0.3)
      }
    } finally { await context.close() }
  }, 240_000)

  it('multi-select union: real drag 2.5px snaps exact, 5px moves, Shift excludes, at UI 67/100/500% (Paper 0.333/0.5/2.5)', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      const multi = multiSvg()
      const mFile = `${md5(new TextEncoder().encode(multi))}.svg`
      const empty = emptySvgBytes(); const emptyHash = md5(empty)
      const project = {
        targets: [
          { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'b', assetId: emptyHash, md5ext: `${emptyHash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on' },
          { isStage: false, name: 'VecMulti', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0, costumes: [{ name: 'multi', assetId: md5(new TextEncoder().encode(multi)), md5ext: mFile, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
        ], monitors: [], extensions: [], meta: { semver: '3.0.0', vm: 'center-snap-vector-drag', agent: 'center-snap-vector-drag' },
      }
      await openCostumes(page)
      await importSb3(page, Buffer.from(buildSb3(project, { [mFile]: new TextEncoder().encode(multi), [`${emptyHash}.svg`]: empty })), 'multi')
      await page.getByTestId('target-card-VecMulti').click().catch(() => {})
      await page.waitForTimeout(500)
      await page.locator('[data-testid="vector-shape-select"]').first().click().catch(() => {})
      await page.waitForTimeout(300)
      // Real multi-select: focus the surface, then Ctrl+A (real shortcut).
      await page.getByTestId('costume-paint-surface').click({ position: { x: 10, y: 10 } }).catch(() => {})
      await page.waitForTimeout(300)
      await page.keyboard.down('Control')
      await page.keyboard.press('a')
      await page.keyboard.up('Control')
      await page.waitForTimeout(600)
      let n = await outlineCount(page)
      log('multi-initial-count', { n })
      if (n < 2) {
        // Fallback real gesture: Shift-click the second outline (still real pointer).
        const first = await outlineCenter(page, 'first')
        await ensurePointVisible(page, first)
        await page.keyboard.down('Shift')
        const second = await outlineCenter(page, 'last')
        await ensurePointVisible(page, second)
        await page.mouse.move(second.x, second.y)
        await page.mouse.down(); await page.mouse.up()
        await page.keyboard.up('Shift')
        await page.waitForTimeout(600)
        n = await outlineCount(page)
        log('multi-after-shift-click', { n })
      }
      expect(n).toBeGreaterThanOrEqual(2)

      for (const ui of [67, 100, 500]) {
        const gotUi = await setZoomUi(page, ui)
        const css = await realVectorCssScale(page)
        const surf = css * 5
        const expectCss = ui === 67 ? 0.333 / 2.5 : ui === 100 ? 0.5 / 2.5 : 1.0
        log('multi-zoom-set', { wantUi: ui, gotUi, css, surf, expectCss })
        expect(Math.abs(gotUi - ui)).toBeLessThanOrEqual(1.5)
        expect(Math.abs(css - expectCss) / expectCss).toBeLessThan(0.08)
        await page.waitForTimeout(500)
        // Re-assert multi selection after zoom (zoom never clears selection).
        expect(await outlineCount(page)).toBeGreaterThanOrEqual(2)
        let svg = await previewSvg(page)
        let boxes = await boundsList(page, svg)
        expect(boxes.length).toBeGreaterThanOrEqual(2)
        let u = unionOf(boxes)
        log(`multi-ui${ui}-baseline`, { u })
        expect(Math.abs((u.x + u.width / 2) - 240)).toBeLessThanOrEqual(0.6)
        expect(Math.abs((u.y + u.height / 2) - 180)).toBeLessThanOrEqual(0.6)
        const beforeAllU = { ...u }

        // 2.5px exact snap on the union center.
        let start = await ensureCenterVisible(page)
        await ensurePointVisible(page, { x: start.x + 2.5, y: start.y })
        start = await outlineCenter(page, 'last')
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(start.x + 2.5, start.y, { steps: 3 })
        await page.waitForTimeout(450)
        const gMid = await guideState(page)
        await page.mouse.up()
        await page.waitForTimeout(650)
        const gAfter = await guideState(page)
        svg = await previewSvg(page)
        u = unionOf(await boundsList(page, svg))
        log(`multi-ui${ui}-2.5-after`, { u, gMid, gAfter })
        expect(Math.abs((u.x + u.width / 2) - 240)).toBeLessThanOrEqual(0.12)
        expect(Math.abs((u.y + u.height / 2) - 180)).toBeLessThanOrEqual(0.12)
        expect(Math.abs(u.x - beforeAllU.x)).toBeLessThanOrEqual(0.12)
        // Zero-displacement snap shows no guide by design.
        expect(gMid.count).toBe(0)
        expect(gAfter.count).toBe(0)

        // 5px moves the whole union together (both rects share the delta).
        start = await ensureCenterVisible(page)
        await ensurePointVisible(page, { x: start.x + 5, y: start.y })
        start = await outlineCenter(page, 'last')
        const before5 = unionOf(await boundsList(page, await previewSvg(page)))
        const beforeBoxes = await boundsList(page, await previewSvg(page))
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(start.x + 5, start.y, { steps: 3 })
        await page.waitForTimeout(450)
        const gMid5 = await guideState(page)
        await page.mouse.up()
        await page.waitForTimeout(650)
        svg = await previewSvg(page)
        boxes = await boundsList(page, svg)
        u = unionOf(boxes)
        const expectedDx = 5 / surf
        log(`multi-ui${ui}-5-after`, { u, before5, expectedDx, perRect: boxes, gMid5 })
        expect(Math.abs((u.x - before5.x) - expectedDx)).toBeLessThanOrEqual(0.16)
        // Every rect moved together: each rect dx matches the union dx.
        for (let i = 0; i < boxes.length; i += 1) {
          expect(Math.abs((boxes[i]!.x - beforeBoxes[i]!.x) - expectedDx)).toBeLessThanOrEqual(0.2)
          expect(Math.abs(boxes[i]!.y - beforeBoxes[i]!.y)).toBeLessThanOrEqual(0.12)
        }
        expect(gMid5.count).toBeGreaterThan(0)
        if (gMid5.h?.rect && gMid5.v?.rect) {
          expect(Math.abs(gMid5.h.rect.width - 16)).toBeLessThanOrEqual(2.5)
          expect(Math.abs(gMid5.v.rect.height - 16)).toBeLessThanOrEqual(2.5)
        }
        expect((await guideState(page)).count).toBe(0)
        // Offset union snap-back with movement: -2.5px lands 2.5px out, snaps exact.
        {
          const s2 = await ensureCenterVisible(page)
          await ensurePointVisible(page, { x: s2.x - 2.5, y: s2.y })
          const ss = await outlineCenter(page, 'last')
          await page.mouse.move(ss.x, ss.y)
          await page.mouse.down()
          await page.mouse.move(ss.x - 2.5, ss.y, { steps: 3 })
          await page.waitForTimeout(450)
          const gOffMid = await guideState(page)
          await page.mouse.up()
          await page.waitForTimeout(650)
          const uOff = unionOf(await boundsList(page, await previewSvg(page)))
          log(`multi-ui${ui}-offset-snap`, { uOff, gOffMid })
          expect(Math.abs((uOff.x + uOff.width / 2) - 240)).toBeLessThanOrEqual(0.12)
          expect(gOffMid.count).toBeGreaterThan(0)
          if (gOffMid.h?.rect && gOffMid.v?.rect) {
            expect(Math.abs(gOffMid.h.rect.width - 16)).toBeLessThanOrEqual(2.5)
            expect(Math.abs(gOffMid.v.rect.height - 16)).toBeLessThanOrEqual(2.5)
          }
          expect((await guideState(page)).count).toBe(0)
        }
        // Undo both entries (snap-back then +5px), Redo the snap-back path.
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(700)
        const uUndo = unionOf(await boundsList(page, await previewSvg(page)))
        expect(Math.abs(uUndo.x - u.x)).toBeLessThanOrEqual(0.16)
        await page.getByRole('button', { name: 'Redo' }).last().click()
        await page.waitForTimeout(700)
        const uRedo = unionOf(await boundsList(page, await previewSvg(page)))
        expect(Math.abs((uRedo.x + uRedo.width / 2) - 240)).toBeLessThanOrEqual(0.16)
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(700)
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(700)

        // Shift excludes snap for the union as well (re-select all: undos keep artwork but may drop selection).
        await page.getByTestId('costume-paint-surface').click({ position: { x: 10, y: 10 } }).catch(() => {})
        await page.waitForTimeout(200)
        await page.keyboard.down('Control')
        await page.keyboard.press('a')
        await page.keyboard.up('Control')
        await page.waitForTimeout(500)
        expect(await outlineCount(page)).toBeGreaterThanOrEqual(2)
        start = await ensureCenterVisible(page)
        await ensurePointVisible(page, { x: start.x + 2.5, y: start.y })
        start = await outlineCenter(page, 'last')
        const beforeShiftSvg = await previewSvg(page)
        const beforeShiftBoxes = await boundsList(page, beforeShiftSvg)
        const beforeShift = unionOf(beforeShiftBoxes)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.keyboard.down('Shift')
        await page.mouse.move(start.x + 2.5, start.y, { steps: 3 })
        await page.waitForTimeout(450)
        const gShift = await guideState(page)
        await page.mouse.up()
        await page.keyboard.up('Shift')
        await page.waitForTimeout(650)
        svg = await previewSvg(page)
        boxes = await boundsList(page, svg)
        u = unionOf(boxes)
        const shiftExpected = 2.5 / surf
        log(`multi-ui${ui}-shift-after`, { u, beforeShift, beforeShiftBoxes, afterBoxes: boxes, gShift, shiftExpected })
        expect(Math.abs((u.x - beforeShift.x) - shiftExpected)).toBeLessThanOrEqual(0.22)
        expect(Math.abs(u.x - beforeShift.x)).toBeGreaterThan(Math.abs(shiftExpected) * 0.5)
        for (let i = 0; i < boxes.length; i += 1) {
          expect(Math.abs((boxes[i]!.x - beforeShiftBoxes[i]!.x) - shiftExpected)).toBeLessThanOrEqual(0.25)
        }
        expect((gShift.count as number)).toBe(0)
        expect((await guideState(page)).count).toBe(0)
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(700)

        // VM/stage position stays exact through union drags.
        const snap = await snapshotTargets(page)
        const vec = snap.targets.find((t: any) => t.name === 'VecMulti')
        expect(vec?.x).toBe(0); expect(vec?.y).toBe(0)
        expect(vec?.costumes[0]?.rotationCenterX).toBe(240)
        expect(vec?.costumes[0]?.rotationCenterY).toBe(180)
        expect(await page.getByTestId('stage-canvas').isVisible()).toBe(true)
      }
    } finally { await context.close() }
  }, 240_000)
})
