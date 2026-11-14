// Group-leaf translate pending-queue + release-ownership regression
// (real Editor + real VM, gated).
//
// Two defects, one visible in final state:
// - `applyLiveVectorLeafTranslateDrag` cleared `pendingClientX/Y` and then
//   read the cleared state, so a move queued while a frame was in flight was
//   silently dropped instead of running once after the old frame (move/resize
//   queue parity: read-before-clear, run the latest frame at most once). The
//   end handler's drain + idempotent re-apply masks this for the release
//   point itself, but intermediate chained frames were lost.
// - worse and final-state-visible: `pointerup` starts an async commit while
//   the browser queues the implicit `lostpointercapture` auto-loss right
//   after it, and the overlay routes that to the cancel path. While the
//   commit was still in flight the drag stayed armed, so the trailing
//   auto-loss cancelled (snapshot restore, history dropped) the drag the
//   user had just released. The end handler now claims the pointer
//   synchronously (`committing`) and the cancel path ignores the trailing
//   auto-loss for a claimed pointer; a genuine mid-drag capture loss still
//   cancels. Verified: with the claim disabled this suite's burst leg fails
//   (Undo never enabled).
//
// The async snapshot (`vm.loadAsset`) and VM write (`vm.updateCostume`) are
// deferred through test-only gates so the in-flight window is deterministically
// wide; then this suite drives, through the REAL costume UI:
// - burst moves followed by an immediate pointerup land on the LATEST
//   coordinates (burst result is child-markup-identical to a clean drag to the
//   same final point), with exactly one Undo/Redo entry;
// - mid-drag Escape restores the snapshot with no history entry;
// - a target switch mid-drag restores the OLD asset only and never touches
//   the newly selected asset (cancel scope + history guards).
//
// No `src/` helper is imported here: every claim is asserted on REAL VM bytes
// (`__paintHistoryVm.loadAsset`), the REAL live preview, and the REAL
// Undo/Redo buttons. Dedicated Vite port 4542 (surveyed 2026-11-12: sibling
// suites use 4251/4291/4387/4389/4473/4483/4487/4490/4492/4496/4497/4527/
// 4531/4533/4535/4540; 4542 is free).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4542
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let page: Page
const diagnostics: string[] = []

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const LEAF_MIXED_SVG =
  `${HEAD}` +
  '<metadata>leaf-queue-meta-v1</metadata>' +
  '<g transform="translate(20 10)">' +
  '<rect x="240" y="100" width="90" height="60" fill="#2ecc71" stroke="none"/>' +
  '<g transform="scale(1.25) rotate(5 100 100)">' +
  '<text x="60" y="120" font-family="Arial, sans-serif" font-size="28" fill="#d6336c" opacity="0.9">Hello<tspan fill="#0033cc">World</tspan></text>' +
  `<image href="${PNG_1PX}" x="186" y="88" width="26" height="26" opacity="0.85"/>` +
  '</g></g>' +
  '<rect x="400" y="300" width="40" height="30" fill="#95a5a6" stroke="none"/>' +
  '</svg>'

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
  const targetB = add(TARGET_B_SVG)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
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
        costumes: [costume(mixed, 'leaf-mixed')],
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
    meta: { semver: '3.0.0', vm: 'test', agent: 'vector-leaf-translate-queue' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function costumeText(target: string, index: number): Promise<string> {
  return await page.evaluate(async ({ target, index }: { target: string; index: number }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { target, index })
}

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

async function leafTextTransform(target: string, index: number): Promise<string | null> {
  return await page.evaluate(async ({ target, index: atIndex }: { target: string; index: number }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[atIndex]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
    return (doc.querySelector('g text') as unknown as Element | null)?.getAttribute('transform')
  }, { target, index })
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

async function waitForChildMarkupEqual(target: string, index: number, want: string, timeout = 30_000): Promise<void> {
  // Cancel / switch restores re-save the snapshot through the runtime
  // normalization (root width/viewBox may be rewritten), so only the `<svg>`
  // children are byte-compared — the same oracle the integration suite uses
  // for its cancel legs.
  const start = Date.now()
  for (;;) {
    const got = await childMarkup(target, index)
    if (got === want) return
    if (Date.now() - start > timeout) throw new Error(`child markup equal timeout ${target}[${index}]`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForUndoEnabled(timeout = 30_000): Promise<void> {
  // The Undo entry is committed at the END of the async end handler (after
  // the quiescence drain + idempotent re-apply), while VM bytes land earlier
  // inside the live frames. Poll so a gated (slow) end never loses the race
  // against the assertion.
  const start = Date.now()
  for (;;) {
    if (await undoEnabled()) return
    if (Date.now() - start > timeout) throw new Error('Undo never became enabled')
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForPreviewChange(before: string, timeout = 30_000): Promise<string> {
  await page.waitForFunction((svg: string) => document.querySelector('.vector-preview')?.innerHTML !== svg, before, { timeout })
  return await previewHtml()
}

async function waitForPreviewEqual(want: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction((svg: string) => document.querySelector('.vector-preview')?.innerHTML === svg, want, { timeout })
}

async function fitViewport() {
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.waitForTimeout(1200)
}

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
    diagnostics.push(`[leaf-queue:FAIL] ${label} is off-canvas ${JSON.stringify({ point: p, hit })}`)
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
  for (let i = 0; i < (await buttons.count()); i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) return true
  }
  return false
}

async function redoEnabled(): Promise<boolean> {
  const buttons = page.getByRole('button', { name: 'Redo' })
  for (let i = 0; i < (await buttons.count()); i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) return true
  }
  return false
}

async function clickUndoOnce() {
  const buttons = page.getByRole('button', { name: 'Undo' })
  for (let i = 0; i < (await buttons.count()); i += 1) {
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
  for (let i = 0; i < (await buttons.count()); i += 1) {
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
    name: 'leaf-queue.sb3',
    mimeType: 'application/x.scratch.sb3',
    buffer: buildSb3(),
  })
  await page.waitForFunction(
    () =>
      (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
        .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 1,
    null,
    { timeout: 20_000 },
  )
  await ensureVectorMode()
}

async function selectMixedCostume() {
  await page.getByRole('button', { name: 'Select leaf-mixed' }).click()
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
  await fitViewport()
}

async function textLeafCenter(): Promise<{ x: number; y: number }> {
  const rect = await page.evaluate(() => {
    const text = document.querySelector('.vector-preview svg g text')
    if (!text) return null
    const r = (text as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })
  if (!rect) throw new Error('No text leaf rect in preview')
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

async function selectGroupViaText(): Promise<void> {
  await page.getByTestId('vector-shape-select').last().click()
  const at = await textLeafCenter()
  await guardCanvasPoint(at, 'text press point')
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.waitForTimeout(900)
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.locator('[data-reshape-curve-layer]').waitFor({ state: 'attached', timeout: 30_000 })
}

// Deferred gates (test-only, installed via page.evaluate AFTER the costume is
// selected and the reshape layer is attached): `vm.loadAsset` backs both the
// pre-drag snapshot (`currentSvgDocument`) and the deferred history peek, and
// `vm.updateCostume` backs every live VM write. Delaying both widens the
// in-flight window so burst moves deterministically arrive mid-apply. Gates
// are removed (flag off) before verification so assertions observe settled
// state, and every `it` installs them on its own fresh page.
async function installLeafQueueGates(loadMs: number, updateMs: number) {
  await page.evaluate(({ loadDelay, updateDelay }: { loadDelay: number; updateDelay: number }) => {
    const w = window as any
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for leaf-queue gates')
    if (w.__leafQueueGateInstalled) {
      w.__leafQueueLoadMs = loadDelay
      w.__leafQueueUpdateMs = updateDelay
      w.__leafQueueGateOn = true
      return
    }
    w.__leafQueueGateInstalled = true
    w.__leafQueueLoadMs = loadDelay
    w.__leafQueueUpdateMs = updateDelay
    w.__leafQueueGateOn = true
    const origLoad = vm.loadAsset.bind(vm)
    vm.loadAsset = async (...args: any[]) => {
      if (w.__leafQueueGateOn) await new Promise((resolve) => setTimeout(resolve, w.__leafQueueLoadMs))
      return origLoad(...args)
    }
    const origUpdate = vm.updateCostume.bind(vm)
    vm.updateCostume = async (...args: any[]) => {
      if (w.__leafQueueGateOn) await new Promise((resolve) => setTimeout(resolve, w.__leafQueueUpdateMs))
      return origUpdate(...args)
    }
  }, { loadDelay: loadMs, updateDelay: updateMs } as unknown as undefined)
}

async function setLeafQueueGate(on: boolean) {
  await page.evaluate((v: boolean) => { (window as any).__leafQueueGateOn = v }, on as unknown as undefined)
}

function failReport(context: string, extra: unknown) {
  diagnostics.push(`[leaf-queue:FAIL] ${context} ${JSON.stringify(extra).slice(0, 2000)}`)
}

describe('group-leaf translate pending queue (real Editor + real VM, gated)', () => {
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

  it('burst moves then immediate up land on the latest coordinates with a single Undo/Redo entry', async () => {
    await openFreshEditor()
    await selectMixedCostume()
    await ensureVectorMode()
    const beforeVm = await costumeText('Sprite1', 0)
    expect(await leafTextTransform('Sprite1', 0)).toBe(null)
    expect(await undoEnabled()).toBe(false)
    await selectGroupViaText()
    const from = await textLeafCenter()
    await guardCanvasPoint(from, 'burst drag start')

    // Widen the in-flight window BEFORE the press: begin's snapshot load,
    // the deferred history peek, and every live VM write all stall ~400ms,
    // so the burst below deterministically arrives mid-apply.
    await installLeafQueueGates(400, 400)
    const previewBefore = await previewHtml()

    // Burst: hold the press until begin resolves (first preview or 2.5s),
    // then fire three moves back-to-back with no settle wait and release
    // immediately at the FINAL point. The middle moves may coalesce; the
    // release point must survive (old code dropped it).
    const FINAL = { dx: 72, dy: 20 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    try {
      const start = Date.now()
      let begun = false
      for (let i = 0; i < 12 && !begun; i += 1) {
        await page.mouse.move(from.x + (FINAL.dx / 3) * ((i + 1) / 12), from.y + (FINAL.dy / 3) * ((i + 1) / 12), { steps: 1 })
        await page.waitForTimeout(250)
        begun = (await previewHtml()) !== previewBefore
        if (!begun && Date.now() - start > 30_000) break
      }
      if (!begun) {
        failReport('burst drag never applied a preview', { from })
        throw new Error('burst drag never applied a preview (begin blocked or hit missed)')
      }
      // No settle waits from here: two queued moves, then up AT the final
      // point with no delay (continuous move -> immediate up).
      await page.mouse.move(from.x + 48, from.y + 13, { steps: 1 })
      await page.mouse.move(from.x + FINAL.dx, from.y + FINAL.dy, { steps: 1 })
    } finally {
      await page.mouse.up()
    }
    await setLeafQueueGate(false)

    // The first VM change lands inside a live frame; the COMMITTED final
    // state is only stable once the end handler finishes (drain + idempotent
    // re-apply + single history commit). Gate the "final" capture on Undo
    // becoming enabled so intermediate frames are never mistaken for the
    // release-point result.
    await waitForVmChange('Sprite1', 0, beforeVm)
    await waitForUndoEnabled()
    const burstVm = await costumeText('Sprite1', 0)
    expect(burstVm).not.toBe(beforeVm)
    const burstMarkup = await childMarkup('Sprite1', 0)
    const burstTransform = await leafTextTransform('Sprite1', 0)
    expect(burstTransform).not.toBe(null)
    expect(burstTransform).toContain('translate(')
    expect(await waitForPreviewChange(previewBefore)).not.toBe(previewBefore)

    // Exactly one history entry for the whole burst: one Undo restores the
    // pre-drag bytes, a second Undo is a no-op; one Redo re-applies, a second
    // Redo no-ops.
    expect(await undoEnabled()).toBe(true)
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', 0, beforeVm)
    expect(await leafTextTransform('Sprite1', 0)).toBe(null)
    await clickUndoOnce().catch(() => undefined)
    expect(await costumeText('Sprite1', 0)).toBe(beforeVm)
    expect(await redoEnabled()).toBe(true)
    await clickRedoOnce()
    await waitForVmEqual('Sprite1', 0, burstVm)
    expect(await leafTextTransform('Sprite1', 0)).toBe(burstTransform)
    await clickRedoOnce().catch(() => undefined)
    expect(await costumeText('Sprite1', 0)).toBe(burstVm)

    // Latest-wins proof: undo back to base, then a clean settled drag to the
    // SAME final point must produce child-markup-identical bytes (absolute
    // deltas from the immutable snapshot make the path irrelevant).
    await clickUndoOnce()
    await waitForVmEqual('Sprite1', 0, beforeVm)
    const cleanFrom = await textLeafCenter()
    await guardCanvasPoint(cleanFrom, 'clean drag start')
    const cleanPreview = await previewHtml()
    await page.mouse.move(cleanFrom.x, cleanFrom.y)
    await page.mouse.down()
    try {
      const start = Date.now()
      let applied = false
      for (let step = 1; step <= 12 && !applied; step += 1) {
        const f = Math.min(1, step / 6)
        await page.mouse.move(cleanFrom.x + FINAL.dx * f, cleanFrom.y + FINAL.dy * f, { steps: 3 })
        await page.waitForTimeout(300)
        applied = (await previewHtml()) !== cleanPreview
        if (!applied && Date.now() - start > 30_000) break
      }
      if (!applied) throw new Error('clean drag never applied a preview')
      await page.mouse.move(cleanFrom.x + FINAL.dx, cleanFrom.y + FINAL.dy, { steps: 3 })
      await page.waitForTimeout(300)
    } finally {
      await page.mouse.up()
    }
    // Same quiescence rule as the burst leg: the committed final state is
    // only stable once the end handler's commit lands (Undo enabled).
    await waitForVmChange('Sprite1', 0, beforeVm)
    await waitForUndoEnabled()
    const cleanVm = await costumeText('Sprite1', 0)
    expect(cleanVm).not.toBe(beforeVm)
    if ((await childMarkup('Sprite1', 0)) !== burstMarkup) {
      failReport('burst vs clean markup mismatch', {
        burst: burstMarkup.slice(0, 600),
        clean: (await childMarkup('Sprite1', 0)).slice(0, 600),
      })
    }
    expect(await childMarkup('Sprite1', 0)).toBe(burstMarkup)
    expect(await leafTextTransform('Sprite1', 0)).toBe(burstTransform)
  }, 180_000)

  it('Escape mid-flight restores the snapshot with no history entry', async () => {
    await openFreshEditor()
    await selectMixedCostume()
    await ensureVectorMode()
    const markupBefore = await childMarkup('Sprite1', 0)
    const previewBefore = await previewHtml()
    await selectGroupViaText()
    const from = await textLeafCenter()
    await guardCanvasPoint(from, 'escape drag start')
    await installLeafQueueGates(400, 400)

    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    try {
      let applied = false
      for (let i = 1; i <= 12 && !applied; i += 1) {
        await page.mouse.move(from.x + (60 * i) / 12, from.y + (16 * i) / 12, { steps: 2 })
        await page.waitForTimeout(300)
        applied = (await previewHtml()) !== previewBefore
      }
      if (!applied) throw new Error('escape-leg drag never applied a preview')
      await page.keyboard.press('Escape')
    } finally {
      await page.mouse.up()
    }
    await setLeafQueueGate(false)
    // Gated cancel restore is async: wait for the preview to rewind, then
    // the VM children must be exactly the pre-drag markup with no Undo entry.
    await waitForPreviewEqual(previewBefore)
    expect(await previewHtml()).toBe(previewBefore)
    await waitForChildMarkupEqual('Sprite1', 0, markupBefore)
    expect(await childMarkup('Sprite1', 0)).toBe(markupBefore)
    expect(await undoEnabled()).toBe(false)
  }, 180_000)

  it('target switch mid-flight restores the old asset and never touches the new one', async () => {
    await openFreshEditor()
    await selectMixedCostume()
    await ensureVectorMode()
    const sprite2Before = await costumeText('Sprite2', 0)
    const markupBefore = await childMarkup('Sprite1', 0)
    await selectGroupViaText()
    const from = await textLeafCenter()
    await guardCanvasPoint(from, 'switch drag start')
    await installLeafQueueGates(400, 400)
    const previewBefore = await previewHtml()

    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    try {
      let applied = false
      for (let i = 1; i <= 12 && !applied; i += 1) {
        await page.mouse.move(from.x + (56 * i) / 12, from.y + (14 * i) / 12, { steps: 2 })
        await page.waitForTimeout(300)
        applied = (await previewHtml()) !== previewBefore
      }
      if (!applied) throw new Error('switch-leg drag never applied a preview')
      // Switch WITHOUT releasing the pointer (no pointerup first): the editor
      // must cancel the drag, restore the OLD asset's snapshot to the OLD
      // costume only, and leave the newly selected asset byte-exact.
      await page.evaluate(() => {
        const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
        vm.selectTarget('Sprite2')
      })
      await page.waitForTimeout(800)
    } finally {
      await page.mouse.up()
    }
    await setLeafQueueGate(false)
    await page.waitForTimeout(1500)

    expect(await costumeText('Sprite2', 0)).toBe(sprite2Before)
    await waitForChildMarkupEqual('Sprite1', 0, markupBefore)
    expect(await childMarkup('Sprite1', 0)).toBe(markupBefore)
    // The switch clears the paint scope: no phantom entry may survive, and
    // the new target must not inherit the old drag's selection side effects.
    expect(await undoEnabled()).toBe(false)
  }, 180_000)
})
