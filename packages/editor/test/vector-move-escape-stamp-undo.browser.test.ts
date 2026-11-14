// Durable regression for move Escape -> deferred stamp -> Undo false-external.
// Covers the deterministic failure where move commit seq1->2 and stamp seq2->3
// left `known` at 2 while live was 3 (deferred move/shapeMove previews cleared
// their gesture identity before landing, so `noteVectorPreviewApplied` no-oped
// and history was dropped), causing Undo to report
// "External costume change kept" with no VM write and unchanged preview.
// Asserts the correct behavior: applied moves kept, stamp lands, Undo/Redo
// round-trip bytes-exact with `Asset undo`/`Asset redo`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4572
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let context: BrowserContext | undefined
let page!: Page

const fnv1a32 = (bytes: Uint8Array) => {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const BLANK_VEC = `${HEAD}</svg>`
const rectSvg = (x: number, y: number, w: number, h: number, fill: string) =>
  `${HEAD}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#111111" stroke-width="2"/></svg>`
const RECT_A2 = rectSvg(150, 120, 140, 110, '#e74c3c')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = fnv1a32(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const blank = add(BLANK_VEC)
  const a2 = add(RECT_A2)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  return Buffer.from(zipSync({
    'project.json': strToU8(JSON.stringify({
      targets: [{
        isStage: false, name: 'VecA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(blank, 'vec-blank'), costume(a2, 'vec-a2')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      }],
      monitors: [], extensions: [],
      meta: { semver: '3.0.0', vm: 'move-escape-stamp-undo', agent: 'move-escape-stamp-undo' },
    })),
    ...files,
  }))
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}
async function waitForPreviewSvg(expected: string, timeout = 20_000) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML === svg, expected, { timeout })
}
async function waitForPreviewSvgChange(previous: string, timeout = 20_000) {
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, previous, { timeout })
}
async function status(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status?.() ?? '')
}
async function svgBytes(): Promise<string> {
  return await page.evaluate(async () => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    const tgt = vm.getTarget('VecA')
    const c = tgt.costumes[0]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  })
}
async function writeSeq(): Promise<number> {
  return await page.evaluate(() => {
    const vm = (window as unknown as any).__paintHistoryVm
    const tid = String(vm.getTarget('VecA')?.id ?? 'VecA')
    return Number(vm.getCostumeWriteSeq?.(tid, 0) ?? -1)
  })
}
async function undoRedoEnabled(): Promise<{ undo: boolean; redo: boolean }> {
  return await page.evaluate(() => {
    const vis = (el: Element | null) => {
      if (!(el instanceof HTMLElement)) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    let undo = false
    let redo = false
    for (const b of Array.from(document.querySelectorAll('button[aria-label="Undo"]'))) {
      if (vis(b) && !(b as HTMLButtonElement).disabled) undo = true
    }
    for (const b of Array.from(document.querySelectorAll('button[aria-label="Redo"]'))) {
      if (vis(b) && !(b as HTMLButtonElement).disabled) redo = true
    }
    return { undo, redo }
  })
}
async function clickUndoVisible() {
  const buttons = page.getByRole('button', { name: 'Undo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if (await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) { await b.click(); return }
  }
  throw new Error('No enabled visible Undo button')
}
async function clickRedoVisible() {
  const buttons = page.getByRole('button', { name: 'Redo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if (await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) { await b.click(); return }
  }
  throw new Error('No enabled visible Redo button')
}
async function installVmGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for gate install')
    if (w.__dragRaceGate) return
    const orig = vm.updateCostume.bind(vm)
    const gate = (w.__dragRaceGate = { mode: 'off', ms: 400, calls: [] as Array<{ target: string; index: number }>, delayed: 0 })
    const delayedGate = async (target: string, index: number) => {
      gate.calls.push({ target: String(target), index: Number(index) })
      if (gate.mode === 'all') { gate.delayed += 1; await new Promise((r) => setTimeout(r, gate.ms)) }
      else if (gate.mode === 'once') { gate.mode = 'off'; gate.delayed += 1; await new Promise((r) => setTimeout(r, gate.ms)) }
    }
    vm.updateCostume = async (...args: any[]) => { await delayedGate(String(args[0]), Number(args[1])); return orig(...args) }
    if (typeof vm.updateCostumeIfMatch === 'function') {
      const origCas = vm.updateCostumeIfMatch.bind(vm)
      vm.updateCostumeIfMatch = async (...args: any[]) => { await delayedGate(String(args[0]), Number(args[1])); return origCas(...args) }
    }
  })
}
async function setGate(mode: 'off' | 'all' | 'once', ms = 400) {
  await page.evaluate(({ m, delay }: { m: string; delay: number }) => {
    const w = window as unknown as Record<string, any>
    w.__dragRaceGate.mode = m; w.__dragRaceGate.ms = delay
  }, { m: mode, delay: ms })
}
async function settle(timeout = 25_000) {
  await setGate('off')
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, any>
    const calls = w.__dragRaceGate?.calls?.length ?? 0
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const prev = w.__settlePrev as { calls?: number; html?: string; stableSince?: number } | undefined
    const now = Date.now()
    if (!prev || prev.calls !== calls || prev.html !== html) { w.__settlePrev = { calls, html, stableSince: now }; return false }
    return now - (prev.stableSince ?? now) > 900
  }, undefined, { timeout })
  await page.waitForTimeout(400)
}
async function outlineCenter(): Promise<{ x: number; y: number }> {
  const target = page.locator('[data-vector-selection-outline]').last()
  await target.waitFor({ state: 'visible', timeout: 20_000 })
  const box = await target.boundingBox()
  if (!box) throw new Error('Missing vector object outline bounds')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

describe('vector move Escape stamp Undo regression', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 120_000)
  beforeEach(async () => {
    if (!browser) throw new Error('Browser not started')
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await context.newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installVmGate()
  })
  afterEach(async () => {
    try { await page?.close() } catch {}
    try { await context?.close() } catch {}
    context = undefined
  })
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('move Escape keeps move, stamp lands, Undo/Redo round-trip bytes-exact', async () => {
    await setGate('off')
    await page.getByTestId('project-file-input').setInputFiles({ name: 'move-esc.sb3', mimeType: 'application/x.scratch.sb3', buffer: buildSb3() })
    await page.waitForFunction((want: string) => {
      const api = (window as any).__hikkakuEditorTest
      if (!api || api.status?.() !== 'Project loaded') return false
      return api.snapshot()?.project.targets.some((t: any) => t.name === want) ?? false
    }, 'VecA', { timeout: 30_000 })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(900)
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    // Baseline rect (first vector write).
    const emptySvg = await previewSvg()
    await page.getByTestId('vector-shape-rect').last().click()
    const box0 = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box0) throw new Error('Missing paint surface bounds')
    await page.mouse.move(box0.x + box0.width / 2 - 110, box0.y + box0.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(box0.x + box0.width / 2 + 110, box0.y + box0.height / 2 + 60, { steps: 12 })
    await page.mouse.up()
    await waitForPreviewSvgChange(emptySvg)
    const seqAfterBaseline = await writeSeq()
    // Back to the rect costume for object move.
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(900)
    await page.getByTestId('vector-shape-select').last().click()
    const box = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(600)
    const baseSvg = await previewSvg()
    const baseSeq = await writeSeq()
    // Move with deferred gate + Escape (applied moves kept, no restore).
    const from = await outlineCenter()
    await setGate('all', 350)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 60, from.y + 10, { steps: 10 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    // Deferred move must land before the stamp fixture is captured.
    // Local-preview moves paint instantly with zero VM writes, so a preview
    // change alone no longer implies the write landed: wait for the seq bump
    // (the single pointerup/Escape CAS commit) as well.
    await waitForPreviewSvgChange(baseSvg)
    await page.waitForFunction((want: number) => {
      const vm = (window as unknown as any).__paintHistoryVm
      if (!vm) return false
      const tid = String(vm.getTarget('VecA')?.id ?? 'VecA')
      return Number(vm.getCostumeWriteSeq?.(tid, 0) ?? -1) === want
    }, baseSeq + 1, { timeout: 20_000 })
    const moveSvg = await previewSvg()
    const moveBytes = await svgBytes()
    const moveSeq = await writeSeq()
    expect(moveSvg).not.toBe(baseSvg)
    expect(moveSeq).toBe(baseSeq + 1)
    expect(moveSeq).toBe(seqAfterBaseline + 1)
    // New operation with the stamp write still deferred by the gate (same as
    // the independent review leg): rect-tool drag at the center. When it hits
    // the live selection it runs as a shapeMove, otherwise as a discrete
    // stamp — either path must land exactly once per effective preview batch,
    // advance writeSeq monotonically, commit history, and keep `known` in sync
    // via its own `result.current` so the next Undo stays fail-open.
    await page.getByTestId('vector-shape-rect').last().click()
    const stampBox = await page.getByTestId('costume-paint-surface').boundingBox()
    if (!stampBox) throw new Error('Missing paint surface bounds')
    const stampBeforeSvg = await previewSvg()
    const stampBeforeBytes = await svgBytes()
    expect(stampBeforeSvg).toBe(moveSvg)
    expect(stampBeforeBytes).toBe(moveBytes)
    await page.mouse.move(stampBox.x + stampBox.width / 2 - 40, stampBox.y + stampBox.height / 2 - 30)
    await page.mouse.down()
    await page.mouse.move(stampBox.x + stampBox.width / 2 + 40, stampBox.y + stampBox.height / 2 + 30, { steps: 8 })
    await page.mouse.up()
    await settle()
    const movedSvg = await previewSvg()
    const movedBytes = await svgBytes()
    const movedSeq = await writeSeq()
    expect(movedSvg).not.toBe(stampBeforeSvg)
    expect(movedBytes).not.toBe(stampBeforeBytes)
    // Monotonic advance (shapeMove may coalesce to more than one gated
    // preview; discrete stamps advance by exactly one — either way forward).
    expect(movedSeq).toBeGreaterThan(moveSeq)
    expect((await undoRedoEnabled()).undo).toBe(true)
    // Undo must return bytes-exact to the move-final (stampBefore), not fail
    // with "External costume change kept".
    await clickUndoVisible()
    await waitForPreviewSvg(stampBeforeSvg)
    expect(await previewSvg()).toBe(stampBeforeSvg)
    expect(await svgBytes()).toBe(stampBeforeBytes)
    expect(await status()).toMatch(/Asset undo/)
    expect((await status()).toLowerCase()).not.toContain('external')
    // Redo returns bytes-exact to the stamped state.
    await clickRedoVisible()
    await waitForPreviewSvg(movedSvg)
    expect(await previewSvg()).toBe(movedSvg)
    expect(await svgBytes()).toBe(movedBytes)
    expect(await status()).toMatch(/Asset redo/)
  }, 240_000)
})
