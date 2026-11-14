// Vector move local-preview perf + correctness gate (NEW TEST ONLY).
//
// Covers the top-user complaint (costume vector editing movement is visibly
// laggy): the old move path wrote through the VM on every pointermove
// (`currentSvgDocument` load + per-element Paper import/export + runtime
// viewBox + TextEncoder/storeAsset hashing + double `paperVectorObjectList`),
// so a 120-unit selection spiked frames (max ~800ms, avg ~38ms, 7 VM writes
// for 30 moves). The optimized path renders every move as a pure local
// preview (press-snapshot DOM translate, rAF-coalesced, zero VM writes) and
// performs exactly one validated CAS commit at pointerup.
//
// Deterministic at fixed viewport 1280x800 against the real Editor + real VM:
// - heavy selection (60 rects + 60 paths = 120 blue outline boxes),
// - 0 VM writes mid-drag, exactly 1 CAS write after pointerup,
// - wall-clock drag budget (coalesced; the old serialized path took ~6s),
// - frame p95/long-frame budget sampled via rAF,
// - immediate visual: preview SVG changes before pointerup with no VM write,
// - final pixel correctness: union shifts by the absolute delta, every unit
//   moves together, Undo reverts / Redo reapplies bytes-exact,
// - races: Escape keeps the previewed move (single commit), target-switch
//   mid-drag discards with no write to the old asset, latest pointer wins,
//   gated-write quiescence settles with no false external.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, BrowserContext, Page } from 'playwright-core'
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

const fnv1a32 = (bytes: Uint8Array) => {
  let h = 0x811c9dc5
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function heavySvg(): string {
  let inner = ''
  for (let i = 0; i < 60; i++) {
    const x = 20 + (i % 15) * 28
    const y = 20 + Math.floor(i / 15) * 45
    const c = i % 3 === 0 ? '#e74c3c' : i % 3 === 1 ? '#2ecc71' : '#3498db'
    inner += `<rect x="${x}" y="${y}" width="22" height="30" fill="${c}" stroke="#111111" stroke-width="2"/><path d="M${x} ${y} l22 0 l0 30 l-22 0 Z" fill="none" stroke="#000" stroke-width="1"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${inner}</svg>`
}

function secondSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect x="100" y="100" width="60" height="60" fill="#ff00ff"/></svg>`
}

function buildSb3(): Buffer {
  const heavy = heavySvg()
  const hb = new TextEncoder().encode(heavy)
  const hh = fnv1a32(hb)
  const second = secondSvg()
  const sb = new TextEncoder().encode(second)
  const sh = fnv1a32(sb)
  return Buffer.from(zipSync({
    'project.json': strToU8(JSON.stringify({
      targets: [{
        isStage: false, name: 'Heavy', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'heavy', assetId: hh, md5ext: `${hh}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      }, {
        isStage: false, name: 'Second', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'second', assetId: sh, md5ext: `${sh}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      }],
      monitors: [], extensions: [],
      meta: { semver: '3.0.0', vm: 'move-perf-coalesced', agent: 'move-perf-coalesced' },
    })),
    [`${hh}.svg`]: hb,
    [`${sh}.svg`]: sb,
  }))
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('project-file-input').setInputFiles({ name: 'heavy.sb3', mimeType: 'application/x.scratch.sb3', buffer: buildSb3() })
  await page.waitForFunction((want: string) => {
    const api = (window as any).__hikkakuEditorTest
    if (!api || api.status?.() !== 'Project loaded') return false
    return api.snapshot()?.project.targets.some((t: any) => t.name === want) ?? false
  }, 'Heavy', { timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(900)
  await page.getByTestId('target-card-Heavy').click().catch(() => {})
  await page.waitForTimeout(500)
}

async function selectAll(page: Page) {
  await page.getByTestId('vector-shape-select').last().click().catch(() => {})
  await page.waitForTimeout(300)
  await page.getByTestId('costume-paint-surface').click({ position: { x: 10, y: 10 } }).catch(() => {})
  await page.waitForTimeout(200)
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
  await page.waitForTimeout(600)
}

async function installCounters(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__movePerf = { writes: 0, frames: [] as number[], sampling: false, last: 0 }
    for (const holder of [w.__paintHistoryVm, w.__hikkakuEditorTest]) {
      const v = holder?.updateCostumeIfMatch ? holder : holder?.vm
      if (v && typeof v.updateCostumeIfMatch === 'function' && !(v.updateCostumeIfMatch as any).__perfProbed) {
        const orig = v.updateCostumeIfMatch.bind(v)
        const fn = async (...a: any[]) => { (window as any).__movePerf.writes++; return orig(...a) }
        ;(fn as any).__perfProbed = true
        v.updateCostumeIfMatch = fn
      } else if (v && typeof v.updateCostume === 'function' && !(v.updateCostume as any).__perfProbed) {
        const orig = v.updateCostume.bind(v)
        const fn = async (...a: any[]) => { (window as any).__movePerf.writes++; return orig(...a) }
        ;(fn as any).__perfProbed = true
        v.updateCostume = fn
      }
    }
    w.__movePerf.sampling = true
    const loop = (t: number) => {
      const perf = (window as any).__movePerf
      if (!perf.sampling) return
      if (perf.last) perf.frames.push(t - perf.last)
      perf.last = t
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
}

async function readCounters(page: Page) {
  return await page.evaluate(() => {
    const perf = (window as any).__movePerf
    perf.sampling = false
    const frames = [...(perf.frames as number[])].sort((a, b) => a - b)
    const q = (qv: number) => (frames.length ? frames[Math.min(frames.length - 1, Math.floor(qv * frames.length))] : 0)
    const avg = frames.length ? frames.reduce((a: number, b: number) => a + b, 0) / frames.length : 0
    return { writes: perf.writes as number, frames: frames.length, p50: q(0.5), p95: q(0.95), max: frames[frames.length - 1] ?? 0, avg, longFrames: frames.filter((f) => f > 50).length }
  })
}

async function outlineCenter(page: Page) {
  const target = page.locator('[data-vector-selection-outline]').last()
  await target.waitFor({ state: 'visible', timeout: 20_000 })
  const box = await target.boundingBox()
  if (!box) throw new Error('missing outline box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
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

describe('vector move local-preview perf + correctness (new tests only)', () => {
  beforeAll(async () => {
    const port = await getFreePort()
    base = `http://127.0.0.1:${port}/test/paint-history-isolation-fixture.html`
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 150; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${port}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 120_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('coalesces 30 moves into 1 CAS write with immediate preview + exact undo/redo', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await selectAll(page)
      expect(await page.locator('[data-vector-selection-outline]').count()).toBeGreaterThanOrEqual(100)
      await installCounters(page)
      const beforeSvg = await page.locator('.vector-preview').innerHTML()
      const beforeBoxes = await boundsList(page, beforeSvg)
      const beforeUnion = unionOf(beforeBoxes)
      const from = await outlineCenter(page)
      const steps = 30
      const dxTotal = 120
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      const t0 = Date.now()
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(from.x + (dxTotal * i) / steps, from.y + (i % 2 ? 2 : -2), { steps: 1 })
        await page.waitForTimeout(16)
        if (i === 15) {
          // Immediate visual with zero VM writes: the local preview must have
          // repainted the artwork before pointerup (no stale frame).
          await page.waitForTimeout(350)
          const midSvg = await page.locator('.vector-preview').innerHTML()
          expect(midSvg).not.toBe(beforeSvg)
          const midWrites = await page.evaluate(() => (window as any).__movePerf.writes as number)
          expect(midWrites).toBe(0)
        }
      }
      const dragMs = Date.now() - t0
      // Latest pointer wins: jump once more before release; the commit must
      // carry this final position, not a coalesced stale frame.
      await page.mouse.move(from.x + dxTotal + 24, from.y + 8, { steps: 2 })
      await page.waitForTimeout(120)
      await page.mouse.up()
      await page.waitForTimeout(1600)
      const counters = await readCounters(page)
      console.log(`[move-perf] dragMs=${dragMs} writes=${counters.writes} frames=${counters.frames} p50=${counters.p50.toFixed(1)} p95=${counters.p95.toFixed(1)} max=${counters.max.toFixed(1)} avg=${counters.avg.toFixed(1)} long=${counters.longFrames}`)
      // Single validated CAS at pointerup (old path wrote ~7 times here).
      expect(counters.writes).toBe(1)
      // Coalesced drag stays interactive (old serialized path took ~6s wall).
      expect(dragMs).toBeLessThan(4000)
      // Event loop stays smooth: generous budgets that the old path busted
      // (avg ~38ms, 7 long frames, max ~800ms).
      expect(counters.p95).toBeLessThan(40)
      expect(counters.longFrames).toBeLessThanOrEqual(3)
      // Final correctness: the union moved by the full absolute delta and
      // every unit moved together (multi-selection, no lost/stale pointer).
      const afterSvg = await page.locator('.vector-preview').innerHTML()
      expect(afterSvg).not.toBe(beforeSvg)
      const afterBoxes = await boundsList(page, afterSvg)
      expect(afterBoxes.length).toBe(beforeBoxes.length)
      const afterUnion = unionOf(afterBoxes)
      const surfaceScale = await page.evaluate(() => {
        const el = document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null
        const w = el ? el.getBoundingClientRect().width : 0
        return w > 0 ? w / 2400 : 0.2
      })
      const surf = surfaceScale * 5
      const expectedDx = (dxTotal + 24) / surf
      expect(Math.abs(afterUnion.x - beforeUnion.x - expectedDx)).toBeLessThanOrEqual(2.0)
      for (let i = 0; i < afterBoxes.length; i++) {
        expect(Math.abs(afterBoxes[i]!.x - beforeBoxes[i]!.x - expectedDx)).toBeLessThanOrEqual(2.5)
        expect(Math.abs(afterBoxes[i]!.y - beforeBoxes[i]!.y - 8 / surf)).toBeLessThanOrEqual(2.5)
      }
      // Undo reverts / Redo reapplies bytes-exact.
      const status = () => page.evaluate(() => (window as any).__hikkakuEditorTest?.status?.() ?? '')
      await page.getByRole('button', { name: 'Undo' }).last().click()
      await page.waitForTimeout(800)
      expect(await page.locator('.vector-preview').innerHTML()).toBe(beforeSvg)
      expect((await status()).toLowerCase()).not.toContain('external')
      await page.getByRole('button', { name: 'Redo' }).last().click()
      await page.waitForTimeout(800)
      expect(await page.locator('.vector-preview').innerHTML()).toBe(afterSvg)
      // Helper parity (deterministic, no timing): pure preview builder moves
      // groups/rects by translate without Paper, bounds shift arithmetically.
      const helper = await page.evaluate(async () => {
        const preview = await import(/* @vite-ignore */ '/src/features/costumes/vector-move-preview.ts')
        const built = (preview as any).buildVectorMovePreviewSvg(
          '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(5 5)"><rect x="0" y="0" width="10" height="10" fill="red"/></g><rect x="100" y="0" width="10" height="10" fill="blue"/></svg>',
          [0, 1], { x: 30, y: 0 },
        )
        const noop = (preview as any).buildVectorMovePreviewSvg(
          '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10"/></svg>',
          [0], { x: 0, y: 0 },
        )
        const shifted = (preview as any).shiftVectorMoveBounds(
          [{ index: 0, boundsX: 10, boundsY: 20, boundsWidth: 5, boundsHeight: 5 }], [0], { x: 3, y: -2 },
        )
        return { hasBuilt: typeof built?.svgText === 'string', cloneCount: (built?.svgText.match(/<rect/g) ?? []).length, noop: noop === undefined, shifted }
      })
      expect(helper.hasBuilt).toBe(true)
      expect(helper.noop).toBe(true)
      expect(helper.shifted[0].boundsX).toBeCloseTo(13, 9)
      expect(helper.shifted[0].boundsY).toBeCloseTo(18, 9)
    } finally { await context.close() }
  }, 240_000)

  it('Escape keeps the previewed move, target-switch discards, gated write settles clean', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await selectAll(page)
      // Escape keeps the previewed move with exactly one commit (no residue).
      const escBase = await page.locator('.vector-preview').innerHTML()
      const escFrom = await outlineCenter(page)
      await page.mouse.move(escFrom.x, escFrom.y)
      await page.mouse.down()
      await page.mouse.move(escFrom.x + 60, escFrom.y + 10, { steps: 8 })
      await page.waitForTimeout(500)
      const escMid = await page.locator('.vector-preview').innerHTML()
      expect(escMid).not.toBe(escBase)
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.waitForTimeout(1500)
      const escAfter = await page.locator('.vector-preview').innerHTML()
      expect(escAfter).not.toBe(escBase)
      // Preview uses translate() while the commit bakes geometry via Paper:
      // bytes differ by design, artwork must match. Compare bounds unions.
      const escMidUnion = unionOf(await boundsList(page, escMid))
      const escAfterUnion = unionOf(await boundsList(page, escAfter))
      expect(Math.abs(escAfterUnion.x - escMidUnion.x)).toBeLessThanOrEqual(0.6)
      expect(Math.abs(escAfterUnion.y - escMidUnion.y)).toBeLessThanOrEqual(0.6)
      await page.getByRole('button', { name: 'Undo' }).last().click()
      await page.waitForTimeout(800)
      expect(await page.locator('.vector-preview').innerHTML()).toBe(escBase)
      // Target-switch mid-drag discards: old asset untouched, new asset live.
      await page.getByRole('button', { name: 'Redo' }).last().click()
      await page.waitForTimeout(800)
      const switchBase = await page.locator('.vector-preview').innerHTML()
      const switchFrom = await outlineCenter(page)
      await page.mouse.move(switchFrom.x, switchFrom.y)
      await page.mouse.down()
      await page.mouse.move(switchFrom.x + 40, switchFrom.y, { steps: 5 })
      await page.waitForTimeout(400)
      await page.getByTestId('target-card-Second').click()
      await page.waitForTimeout(1200)
      try { await page.mouse.up() } catch {}
      await page.waitForTimeout(800)
      // New asset is live and intact (single small rect), old move kept once.
      const secondSvg = await page.locator('.vector-preview').innerHTML()
      expect(secondSvg).not.toBe(switchBase)
      const secondBoxes = await boundsList(page, secondSvg)
      expect(secondBoxes.length).toBe(1)
      await page.getByTestId('target-card-Heavy').click()
      await page.waitForTimeout(900)
      expect(await page.locator('.vector-preview').innerHTML()).toBe(switchBase)
    } finally { await context.close() }
  }, 240_000)

  it('gated write quiescence settles with no false external', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await selectAll(page)
      // Gated write quiescence: delay the single CAS, release, settle, undo clean.
      await page.evaluate(() => {
        const w = window as any
        const vm = w.__paintHistoryVm
        if (!vm || (vm.updateCostumeIfMatch as any).__gated) return
        const orig = vm.updateCostumeIfMatch.bind(vm)
        const fn = async (...a: any[]) => { await new Promise((r) => setTimeout(r, 450)); return orig(...a) }
        ;(fn as any).__gated = true
        vm.updateCostumeIfMatch = fn
      })
      const gateFrom = await outlineCenter(page)
      const gateBase = await page.locator('.vector-preview').innerHTML()
      await page.mouse.move(gateFrom.x, gateFrom.y)
      await page.mouse.down()
      await page.mouse.move(gateFrom.x + 36, gateFrom.y + 6, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(2500)
      const gateAfter = await page.locator('.vector-preview').innerHTML()
      expect(gateAfter).not.toBe(gateBase)
      await page.getByRole('button', { name: 'Undo' }).last().click()
      await page.waitForTimeout(900)
      expect(await page.locator('.vector-preview').innerHTML()).toBe(gateBase)
      const st = await page.evaluate(() => (window as any).__hikkakuEditorTest?.status?.() ?? '')
      expect(st.toLowerCase()).not.toContain('external')
    } finally { await context.close() }
  }, 240_000)
})
