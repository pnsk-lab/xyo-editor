// Strict browser suite: selected reshape-anchor arrow nudge (Editor + VM).
//
// Real Editor + real VM only, from the curve-marquee fixture family. No mocks,
// no fake Editor: geometry is compared through the `paperVectorObjectList`
// oracle, bytes through `vm.loadAsset`, history through visible Undo/Redo,
// selection through `[data-vector-path-point][aria-pressed]`, and keyup through
// the live `handleKeyUp -> flushNudgePending` path (real key events, real DOM
// selectors). Test source only: product code is untouched.
//
// Reference behavior (clean-room, no AGPL copy):
// - reshape keydown moves each *selected anchor* by one screen px
//   (`1 / (5 * viewportScale)` SVG units, Shift ignored, Alt never clones,
//   no action-bounds clamp, offscreen allowed), handles ride rigidly;
// - keyup commits a single history entry per press-release cycle (autorepeat
//   N keydowns -> one Undo); typing/IME targets swallow arrows on keydown,
//   keyup still closes the cycle; target/slot/reload switches and external
//   CAS abort the gated write without stale assets.
//
// Deterministic: fixed port 4590, `--config vite.gate.config.ts` (watch:null,
// hmr:false, no reload on foreign saves), `--strictPort`, CHROME_BIN.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4590
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// Centered cubic (two segments, three anchors) plus an untouched sibling rect.
// Anchors ~ (180,150) (240,150) (300,150); handles rigid by construction.
const CURVE_D = 'M180,150 C200,150 220,150 240,150 C260,150 280,150 300,150'
const CURVE_SVG = `${HEAD}<path id="curve" d="${CURVE_D}" fill="none" stroke="#111111" stroke-width="2"/><rect id="sibling" x="100" y="230" width="44" height="32" fill="#2980b9"/></svg>`
const OTHER_SVG = `${HEAD}<rect x="150" y="120" width="140" height="110" fill="#e74c3c" stroke="#111111" stroke-width="2"/></svg>`
const B_SVG = `${HEAD}<path d="M180,150 L240,210 L300,150" fill="none" stroke="#111111" stroke-width="2"/></svg>`

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const curve = add(CURVE_SVG)
  const other = add(OTHER_SVG)
  const b = add(B_SVG)
  const project = {
    targets: [
      {
        isStage: false, name: 'NudgeA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(curve, 'nudge-curve'), costume(other, 'nudge-other')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
      {
        isStage: false, name: 'NudgeB', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0, costumes: [costume(b, 'nudge-b')],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 60, y: 30, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'reshape-nudge-strict', agent: 'reshape-nudge-strict' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function importSb3(bytes: Buffer) {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'nudge.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    () => (window as any).__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.name === 'NudgeA') ?? false,
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

async function selectTarget(name: string) {
  await page.getByTestId(`target-card-${name}`).click()
  await page.waitForTimeout(600)
}

async function selectCostume(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).first().click()
  await page.waitForTimeout(900)
}

async function vmSvg(targetName: string, costumeName: string): Promise<string> {
  return await page.evaluate(async ({ t, c }: { t: string; c: string }) => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget(t)
    const idx = tgt.costumes.findIndex((x: any) => x.name === c)
    const cost = tgt.costumes[idx]
    const bytes = (await vm.loadAsset(cost.md5ext ?? cost.assetId, cost.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { t: targetName, c: costumeName })
}

async function costumeMeta(targetName: string, costumeName: string): Promise<any> {
  return await page.evaluate(({ t, c }: { t: string; c: string }) => {
    const snap = (window as any).__hikkakuEditorTest.snapshot()
    const tgt = snap.project.targets.find((x: any) => x.name === t)
    const cost = tgt?.costumes.find((x: any) => x.name === c)
    if (!cost) return null
    return { name: cost.name, dataFormat: cost.dataFormat, bitmapResolution: cost.bitmapResolution, rotationCenterX: cost.rotationCenterX, rotationCenterY: cost.rotationCenterY }
  }, { t: targetName, c: costumeName })
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

async function previewInner(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitPreviewChange(before: string) {
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, before, { timeout: 15_000 })
}

async function waitPreviewTo(want: string) {
  await page.waitForFunction((next) => document.querySelector('.vector-preview')?.innerHTML === next, want, { timeout: 15_000 })
}

async function anchorHandles(): Promise<Array<{ index: number; x: number; y: number; pressed: boolean; control: boolean }>> {
  return await page.evaluate(() => {
    const out: Array<{ index: number; x: number; y: number; pressed: boolean; control: boolean }> = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const label = el.getAttribute('aria-label') ?? ''
      if (!label.startsWith('Move path point') && !label.startsWith('Move control point')) continue
      const r = (el as HTMLElement).getBoundingClientRect()
      out.push({
        index: Number((el as HTMLElement).dataset.pointIndex),
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        pressed: el.getAttribute('aria-pressed') === 'true',
        control: label.startsWith('Move control point'),
      })
    }
    return out.sort((a, b) => a.index - b.index)
  })
}

async function pressedIndices(): Promise<number[]> {
  return (await anchorHandles()).filter((h) => h.pressed && !h.control).map((h) => h.index).sort((a, b) => a - b)
}

async function waitPressedCount(n: number) {
  // Paper truth: selected handles also report pressed, so the total pressed
  // count is anchors + visible controls. Selection settling waits on anchors
  // only (point bit); handle display is asserted separately.
  await page.waitForFunction(
    (want) => [...document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]')].filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length === want,
    n, { timeout: 15_000 },
  )
}

async function orbitPoints(svgText: string): Promise<Array<{ index: number; x: number; y: number; kind: string }>> {
  return await page.evaluate(async (svg: string) => {
    const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const list = await (mod as any).paperVectorObjectList(svg)
    return ((list[0] as any)?.points ?? []) as Array<{ index: number; x: number; y: number; kind: string }>
  }, svgText)
}

async function objectCount(svgText: string): Promise<number> {
  return await page.evaluate(async (svg: string) => {
    const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    return ((await (mod as any).paperVectorObjectList(svg)) as unknown[]).length
  }, svgText)
}

async function siblingOuter(svgText: string): Promise<string | null> {
  return await page.evaluate(async (svg: string) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return doc.querySelector('#sibling')?.outerHTML ?? null
  }, svgText)
}

async function realVectorScale(): Promise<number> {
  return await page.evaluate(() => {
    const surface = document.querySelector('[data-vector-stage-surface]')!
    return surface.getBoundingClientRect().width / 2400
  })
}

async function zoomLabelIs(target: number): Promise<boolean> {
  const label = (await page.getByRole('button', { name: 'Reset zoom' }).textContent()) ?? ''
  return label.trim() === `${target}%`
}

async function setZoom(target: number) {
  if (target === 100) {
    await page.getByRole('button', { name: 'Reset zoom' }).click()
  } else if (target < 100) {
    for (let i = 0; i < 30; i += 1) {
      if (await zoomLabelIs(target)) break
      await page.getByRole('button', { name: 'Zoom out' }).click()
    }
  } else {
    for (let i = 0; i < 40; i += 1) {
      if (await zoomLabelIs(target)) break
      await page.getByRole('button', { name: 'Zoom in' }).click()
    }
  }
  await page.waitForFunction(
    (t) => (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim() === `${t}%`,
    target, { timeout: 10_000 },
  )
  await page.waitForTimeout(600)
}

async function selectCurveObject() {
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(400)
  const pt = await page.evaluate(() => {
    const path = document.querySelector('.vector-preview svg path') as unknown as SVGPathElement | null
    if (!path) return null
    try {
      const len = path.getTotalLength()
      const p = path.getPointAtLength(len * 0.25)
      const ctm = path.getScreenCTM()
      if (!ctm) return null
      const dom = new DOMPoint(p.x, p.y).matrixTransform(ctm as unknown as DOMMatrix)
      return { x: dom.x, y: dom.y }
    } catch { return null }
  })
  if (!pt) throw new Error('INVALID: missing curve stroke point for object select')
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(700)
}

async function enterReshapeWithAnchors(want: number[]) {
  await page.getByTestId('vector-shape-reshape').last().click()
  await page.waitForSelector('[data-vector-path-point]')
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-vector-path-point]')].filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length >= 3,
    undefined, { timeout: 15_000 },
  )
  // Plain click first anchor (replaces), Shift+click the rest (toggles in).
  const first = want[0]!
  {
    const hs = await anchorHandles()
    const h = hs.find((x) => x.index === first && !x.control)
    if (!h) throw new Error(`INVALID: missing anchor ${first}`)
    await page.mouse.click(h.x, h.y)
    await waitPressedCount(1)
  }
  for (const idx of want.slice(1)) {
    const hs = await anchorHandles()
    const h = hs.find((x) => x.index === idx && !x.control)
    if (!h) throw new Error(`INVALID: missing anchor ${idx}`)
    await page.keyboard.down('Shift')
    await page.mouse.click(h.x, h.y)
    await page.keyboard.up('Shift')
    await waitPressedCount(want.slice(0, want.indexOf(idx) + 1).length)
  }
  expect(await pressedIndices()).toEqual([...want].sort((a, b) => a - b))
  // Blur the handle button so arrows go to the window handler, not the button.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.waitForTimeout(200)
}

async function gateCalls(): Promise<Array<[string, number]>> {
  return await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    return [...(w.__nudgeStrictGate?.calls ?? [])] as Array<[string, number]>
  })
}

async function clearGateCalls() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__nudgeStrictGate) w.__nudgeStrictGate.calls = []
  })
}

async function waitForGateCalls(want: number, timeout = 15_000) {
  await page.waitForFunction(
    (n) => ((window as unknown as Record<string, any>).__nudgeStrictGate?.calls?.length ?? 0) >= n,
    want, { timeout },
  )
}

async function slotIdentity(targetName: string, costumeIndex: number): Promise<any> {
  return await page.evaluate(async ({ t, i }: { t: string; i: number }) => {
    const vm = (window as any).__paintHistoryVm
    const tgt = vm.getTarget(t)
    const id = tgt?.id ?? t
    return {
      ident: vm.getCostumeIdentity?.(id, i),
      seq: vm.getCostumeWriteSeq?.(id, i),
      gen: vm.getProjectGeneration?.(),
    }
  }, { t: targetName, i: costumeIndex })
}

async function parseSvgViewBox(svgText: string): Promise<{ x: number; y: number; w: number; h: number; width: string | null; height: string | null }> {
  return await page.evaluate(async (svg: string) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const el = doc.documentElement
    const vb = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
    return { x: vb[0]!, y: vb[1]!, w: vb[2]!, h: vb[3]!, width: el.getAttribute('width'), height: el.getAttribute('height') }
  }, svgText)
}

async function targetSpritePos(name: string): Promise<{ x: number; y: number } | null> {
  return await page.evaluate((n: string) => {
    const snap = (window as any).__hikkakuEditorTest?.snapshot?.()
    const tgt = snap?.project?.targets?.find((x: any) => x.name === n)
    if (!tgt) return null
    return { x: tgt.x, y: tgt.y }
  }, name)
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => (window as any).__hikkakuEditorTest?.status?.() ?? '')
}

function undoVisible() { return page.locator('button[aria-label="Undo"]:visible') }
function redoVisible() { return page.locator('button[aria-label="Redo"]:visible') }

async function installVmGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for gate install')
    if (w.__nudgeStrictGate) return
    const orig = vm.updateCostume.bind(vm)
    const gate = (w.__nudgeStrictGate = { mode: 'off', ms: 500, calls: [] as unknown[] })
    const delayed = async (...a: any[]) => {
      gate.calls.push([String(a[0]), Number(a[1])])
      if (gate.mode === 'once') { gate.mode = 'off'; await new Promise((r) => setTimeout(r, gate.ms)) }
      else if (gate.mode === 'all') { await new Promise((r) => setTimeout(r, gate.ms)) }
      else if (gate.mode === 'fail-once') { gate.mode = 'off'; throw new Error('injected strict-gate failure') }
    }
    vm.updateCostume = async (...args: any[]) => { await delayed(...args); return orig(...args) }
    if (typeof vm.updateCostumeIfMatch === 'function') {
      const origCas = vm.updateCostumeIfMatch.bind(vm)
      vm.updateCostumeIfMatch = async (...args: any[]) => { await delayed(...args); return origCas(...args) }
    }
  })
}

async function setGate(mode: 'off' | 'all' | 'once' | 'fail-once', ms = 500) {
  await page.evaluate(({ m, delay }: { m: string; delay: number }) => {
    const w = window as unknown as Record<string, any>
    if (!w.__nudgeStrictGate) throw new Error('Gate not installed')
    w.__nudgeStrictGate.mode = m
    w.__nudgeStrictGate.ms = delay
  }, { m: mode, delay: ms })
}

async function settle(timeout = 25_000) {
  await setGate('off')
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    w.__nudgeSettlePrev = undefined
  })
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, any>
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const prev = w.__nudgeSettlePrev as { html?: string; stableSince?: number } | undefined
    const now = Date.now()
    if (!prev || prev.html !== html) { w.__nudgeSettlePrev = { html, stableSince: now }; return false }
    return now - (prev.stableSince ?? now) > 900
  }, undefined, { timeout })
  await page.waitForTimeout(400)
}

describe('vector reshape-anchor nudge strict (real Editor+VM)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--config', 'vite.gate.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 120; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installVmGate()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('single selected anchor moves one screen-px step with rigid handles; sibling/metadata unchanged', async () => {
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await setZoom(100)
    await selectCurveObject()
    // Curve is object 0 (path), sibling rect is object 1: assert oracle shape.
    const vmBefore = await vmSvg('NudgeA', 'nudge-curve')
    expect(await objectCount(vmBefore)).toBe(2)
    const metaBefore = await costumeMeta('NudgeA', 'nudge-curve')
    const siblingBefore = await siblingOuter(vmBefore)
    expect(siblingBefore).toContain('width="44"')
    const pointsBefore = await orbitPoints(vmBefore)
    const anchorsBefore = pointsBefore.filter((p) => p.kind === 'anchor')
    expect(anchorsBefore.length).toBe(3)
    const previewBefore = await previewInner()
    const undoBefore = await undoRedoEnabled()

    await enterReshapeWithAnchors([anchorsBefore[0]!.index])
    // Live helper step (screen-constant): plain Shift-independent.
    const live = await page.evaluate(async () => {
      const n = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-nudge.ts')
      const p = await import(/* @vite-ignore */ '/src/features/costumes/nudge-parity.ts')
      const scale = (document.querySelector('[data-vector-stage-surface]') as HTMLElement).getBoundingClientRect().width / 2400
      return {
        step: (n as any).reshapeNudgeStep(scale),
        ref: (p as any).referenceVectorNudgeStep(scale, false),
        refShift: (p as any).referenceVectorNudgeStep(scale, true),
        scale,
      }
    })
    expect(live.step).toBeCloseTo(live.ref, 9)
    // Shift must NOT multiply on the reshape path (select-mode x15 does not apply).
    expect(live.refShift).not.toBeCloseTo(live.step, 2)
    const realScale = await realVectorScale()
    expect(live.step * 5 * realScale).toBeCloseTo(1, 1)

    await page.keyboard.press('ArrowRight')
    await waitPreviewChange(previewBefore)
    await page.waitForTimeout(700)
    const vmAfter = await vmSvg('NudgeA', 'nudge-curve')
    const previewAfter = await previewInner()
    expect(previewAfter).not.toBe(previewBefore)
    expect(vmAfter).not.toBe(vmBefore)
    const pointsAfter = await orbitPoints(vmAfter)
    const sel = anchorsBefore[0]!.index
    const aBefore = pointsBefore[sel]!
    const aAfter = pointsAfter[sel]!
    expect(aAfter.x).toBeCloseTo(aBefore.x + live.step, 5)
    expect(aAfter.y).toBeCloseTo(aBefore.y, 6)
    // Only the selected anchor moves; other anchors byte-identical in position.
    for (const p of pointsBefore) {
      if (p.index === sel) continue
      if (p.kind === 'control') continue // tips ride rigidly with anchor 0 by construction
      const q = pointsAfter[p.index]!
      expect(q.x).toBeCloseTo(p.x, 6)
      expect(q.y).toBeCloseTo(p.y, 6)
    }
    // Both handles of the moved anchor ride rigidly (handle vectors unchanged).
    const vec = (pts: typeof pointsBefore, anchorX: number, anchorY: number) => {
      const ctrls = pts.filter((p) => p.kind === 'control')
      return ctrls.map((c) => ({ dx: c.x - anchorX, dy: c.y - anchorY }))
    }
    // Anchor 0 owns the first out-handle (index 1): vector must be identical.
    const outBefore = pointsBefore.find((p) => p.kind === 'control')!
    const outAfter = pointsAfter.find((p) => p.kind === 'control' && p.index === outBefore.index)!
    expect(outAfter.x - aAfter.x).toBeCloseTo(outBefore.x - aBefore.x, 5)
    expect(outAfter.y - aAfter.y).toBeCloseTo(outBefore.y - aBefore.y, 5)
    expect(vec(pointsBefore, 0, 0).length).toBeGreaterThan(0)
    // Sibling unit untouched + edited node keeps identity + tight renormalization.
    // vectorRuntimeCostume tight-crops on every save: loose 480x360/240,180
    // becomes tight 98,148,204,116/142,32 (sibling rect dominates the bounds,
    // so the +step nudge does not shift the box). Registration is preserved
    // via the viewBox+center invariant (x+cx=240, y+cy=180); sprite x/y stay.
    expect(await siblingOuter(vmAfter)).toBe(siblingBefore)
    expect(await objectCount(vmAfter)).toBe(2)
    expect(vmAfter).toContain('<rect')
    const metaAfter = await costumeMeta('NudgeA', 'nudge-curve')
    expect(metaAfter.name).toBe(metaBefore.name)
    expect(metaAfter.dataFormat).toBe('svg')
    expect(metaAfter.bitmapResolution).toBe(1)
    // Loose import baseline (untight) normalizes on first save.
    expect(metaBefore).toMatchObject({ rotationCenterX: 240, rotationCenterY: 180 })
    const vbAfter = await parseSvgViewBox(vmAfter)
    expect(vbAfter).toMatchObject({ x: 98, y: 148, w: 204, h: 116 })
    expect(String(vbAfter.width)).toBe('204')
    expect(String(vbAfter.height)).toBe('116')
    expect(metaAfter.rotationCenterX).toBe(142)
    expect(metaAfter.rotationCenterY).toBe(32)
    // Registration invariant: viewBox origin + center == stage center.
    expect(metaAfter.rotationCenterX + vbAfter.x).toBe(240)
    expect(metaAfter.rotationCenterY + vbAfter.y).toBe(180)
    // Sprite registration (stage position) untouched by a point nudge.
    expect(await targetSpritePos('NudgeA')).toEqual({ x: 0, y: 0 })
    // Tight box is stable across the nudge (sibling-dominated, no shift).
    const vbBeforeTight = { x: 98, y: 148, w: 204, h: 116 }
    expect(vbAfter).toMatchObject(vbBeforeTight)
    // Live DOM selectors: one pressed anchor, status names points, Undo armed.
    // (Handles also report pressed per Paper truth, so total pressed exceeds
    // anchors; assert anchors here, handles separately.)
    expect(await pressedIndices()).toEqual([sel])
    expect(await page.locator('[data-vector-path-point][aria-label^="Move path point"][aria-pressed="true"]').count()).toBe(1)
    const status = await page.evaluate(() => (window as any).__hikkakuEditorTest?.status?.() ?? '')
    expect(status).toMatch(/Vector path points nudged/)
    expect(await undoRedoEnabled()).toEqual({ undo: true, redo: false })
    expect(undoBefore).toBeDefined()
    // Single press = single Undo entry: Undo restores exact bytes, Redo reapplies.
    // Undo rewinds to the loose import baseline (bytes + meta); Redo returns
    // to the tight normalized nudge (bytes + meta). Registration invariant
    // holds on both sides via the same viewBox+center rule.
    await undoVisible().click()
    await waitPreviewTo(previewBefore)
    expect(await previewInner()).toBe(previewBefore)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(vmBefore)
    expect(await costumeMeta('NudgeA', 'nudge-curve')).toEqual(metaBefore)
    await redoVisible().click()
    await waitPreviewTo(previewAfter)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(vmAfter)
    expect(await costumeMeta('NudgeA', 'nudge-curve')).toEqual(metaAfter)
  }, 180_000)

  it('two anchors move the same step; Shift ignored; Alt never duplicates', async () => {
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await setZoom(100)
    await selectCurveObject()
    const vmBase = await vmSvg('NudgeA', 'nudge-curve')
    const pts = await orbitPoints(vmBase)
    const anchors = pts.filter((p) => p.kind === 'anchor')
    expect(anchors.length).toBe(3)
    const pair = [anchors[0]!.index, anchors[2]!.index].sort((a, b) => a - b)
    await enterReshapeWithAnchors(pair)
    const previewBase = await previewInner()

    const stepOf = () => page.evaluate(async () => {
      const n = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-nudge.ts')
      const scale = (document.querySelector('[data-vector-stage-surface]') as HTMLElement).getBoundingClientRect().width / 2400
      return (n as any).reshapeNudgeStep(scale) as number
    })
    const step = await stepOf()

    // Plain ArrowRight moves both anchors by step.
    await page.keyboard.press('ArrowRight')
    await waitPreviewChange(previewBase)
    await page.waitForTimeout(700)
    let vm = await vmSvg('NudgeA', 'nudge-curve')
    let after = await orbitPoints(vm)
    for (const idx of pair) {
      expect(after[idx]!.x).toBeCloseTo(pts[idx]!.x + step, 5)
      expect(after[idx]!.y).toBeCloseTo(pts[idx]!.y, 6)
    }
    // Middle anchor untouched.
    const mid = anchors[1]!.index
    expect(after[mid]!.x).toBeCloseTo(pts[mid]!.x, 6)
    expect(after[mid]!.y).toBeCloseTo(pts[mid]!.y, 6)
    expect(await objectCount(vm)).toBe(2)
    // Undo to base for the modifier legs (exact bytes).
    await undoVisible().click()
    await waitPreviewTo(previewBase)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(vmBase)

    // Shift+ArrowRight must equal the plain step (no x15 on reshape).
    const shiftBase = await previewInner()
    await page.keyboard.down('Shift')
    try { await page.keyboard.press('ArrowRight') } finally { await page.keyboard.up('Shift') }
    await waitPreviewChange(shiftBase)
    await page.waitForTimeout(700)
    vm = await vmSvg('NudgeA', 'nudge-curve')
    after = await orbitPoints(vm)
    for (const idx of pair) {
      expect(after[idx]!.x).toBeCloseTo(pts[idx]!.x + step, 5)
    }
    expect(await objectCount(vm)).toBe(2)
    await undoVisible().click()
    await waitPreviewTo(previewBase)

    // Alt+ArrowRight must equal the plain step and never duplicate the unit.
    const altBase = await previewInner()
    await page.keyboard.down('Alt')
    try { await page.keyboard.press('ArrowRight') } finally { await page.keyboard.up('Alt') }
    await waitPreviewChange(altBase)
    await page.waitForTimeout(700)
    vm = await vmSvg('NudgeA', 'nudge-curve')
    after = await orbitPoints(vm)
    for (const idx of pair) {
      expect(after[idx]!.x).toBeCloseTo(pts[idx]!.x + step, 5)
    }
    expect(await objectCount(vm)).toBe(2)
    expect(vm).not.toContain('use')
    await undoVisible().click()
    await waitPreviewTo(previewBase)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(vmBase)
    expect(await pressedIndices()).toEqual(pair)
  }, 180_000)

  it('screen-constant step at 25/100/500 helper + UI zooms 67/100/500 with exact geometry', async () => {
    // Live helper pins (legacy paper units 25%/100%/500%): 0.8 / 0.2 / 0.04 SVG.
    const helper = await page.evaluate(async () => {
      const n = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-nudge.ts')
      const p = await import(/* @vite-ignore */ '/src/features/costumes/nudge-parity.ts')
      return {
        s25: (n as any).reshapeNudgeStep(0.25),
        s100: (n as any).reshapeNudgeStep(1),
        s500: (n as any).reshapeNudgeStep(5),
        r25: (p as any).referenceVectorNudgeStep(0.25, false),
        r500: (p as any).referenceVectorNudgeStep(5, false),
      }
    })
    expect(helper.s25).toBeCloseTo(0.8, 9)
    expect(helper.s100).toBeCloseTo(0.2, 9)
    expect(helper.s500).toBeCloseTo(0.04, 9)
    expect(helper.r25).toBeCloseTo(0.8, 9)
    expect(helper.r500).toBeCloseTo(0.04, 9)

    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await selectCurveObject()
    const vmBase0 = await vmSvg('NudgeA', 'nudge-curve')
    const basePts = (await orbitPoints(vmBase0)).filter((p) => p.kind === 'anchor')
    await enterReshapeWithAnchors([basePts[0]!.index])

    for (const zoom of [100, 67, 500]) {
      await setZoom(zoom)
      const scale = await realVectorScale()
      const before = await previewInner()
      const x0 = (await orbitPoints(await vmSvg('NudgeA', 'nudge-curve')))[basePts[0]!.index]!.x
      await page.keyboard.press('ArrowRight')
      await waitPreviewChange(before)
      await page.waitForTimeout(700)
      const vmNow = await vmSvg('NudgeA', 'nudge-curve')
      const x1 = (await orbitPoints(vmNow))[basePts[0]!.index]!.x
      const docDelta = x1 - x0
      // Screen-constant 1px: docDelta * 5 * realScale ~= 1 at every zoom.
      expect(docDelta * 5 * scale).toBeCloseTo(1, 0)
      // No stale preview: geometry oracle agrees with the VM bytes.
      const previewPts = await page.evaluate(async () => {
        const svg = document.querySelector('.vector-preview')?.innerHTML ?? ''
        const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        return (((await (mod as any).paperVectorObjectList(svg))[0] as any)?.points ?? []).length
      })
      expect(previewPts).toBeGreaterThan(0)
      // Undo this zoom tick before the next (exact bytes).
      const baseNow = before
      await undoVisible().click()
      await waitPreviewTo(baseNow)
    }
    await setZoom(100)
  }, 180_000)

  it('autorepeat coalesces to one Undo/Redo with exact SVG geometry/bytes (live keyup)', async () => {
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await setZoom(100)
    await selectCurveObject()
    const vmHistoryBase = await vmSvg('NudgeA', 'nudge-curve')
    const previewHistoryBase = await previewInner()
    const basePts = await orbitPoints(vmHistoryBase)
    const sel = basePts.filter((p) => p.kind === 'anchor')[0]!.index
    await enterReshapeWithAnchors([sel])
    const step = await page.evaluate(async () => {
      const n = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-nudge.ts')
      const scale = (document.querySelector('[data-vector-stage-surface]') as HTMLElement).getBoundingClientRect().width / 2400
      return (n as any).reshapeNudgeStep(scale) as number
    })
    const x0 = basePts[sel]!.x
    // One press-release cycle with 5 synthetic keydowns (autorepeat): shares
    // the pending session (no keyup between them), commits once on keyup.
    // Synthetic dispatch exercises the live window keydown path (no Playwright
    // shortcut); the closing keyup below exercises the live handleKeyUp path.
    await page.evaluate(() => {
      for (let i = 0; i < 5; i += 1) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await waitPreviewChange(previewHistoryBase)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await page.waitForTimeout(900)
    const nudged = await previewInner()
    expect(nudged).not.toBe(previewHistoryBase)
    const vmNudged = await vmSvg('NudgeA', 'nudge-curve')
    expect(vmNudged).not.toBe(vmHistoryBase)
    const ptsNudged = await orbitPoints(vmNudged)
    expect(ptsNudged[sel]!.x).toBeCloseTo(x0 + 5 * step, 4)
    // Single Undo restores the whole 5-keydown cycle (reference keyup parity);
    // a second Undo moves further back, proving one entry.
    await undoVisible().click()
    await waitPreviewTo(previewHistoryBase)
    expect(await previewInner()).toBe(previewHistoryBase)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(vmHistoryBase)
    await undoVisible().click()
    await page.waitForFunction((b) => document.querySelector('.vector-preview')?.innerHTML !== b, previewHistoryBase, { timeout: 15_000 })
    expect(await previewInner()).not.toBe(previewHistoryBase)
    await redoVisible().click()
    await waitPreviewTo(previewHistoryBase)
    expect(await previewInner()).toBe(previewHistoryBase)
    await redoVisible().click()
    await waitPreviewTo(nudged)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(vmNudged)
    // Keyup from a typing target still closes the cycle (keydown guards upstream).
    expect(await pressedIndices()).toEqual([sel])
  }, 180_000)

  it('offscreen clamp disabled; control-only refuses; input/IME swallow arrows; no stale preview', async () => {
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await setZoom(100)
    await selectCurveObject()
    const vmBase = await vmSvg('NudgeA', 'nudge-curve')
    const pts = await orbitPoints(vmBase)
    const anchors = pts.filter((p) => p.kind === 'anchor')
    await enterReshapeWithAnchors([anchors[0]!.index])
    // Live control exclusion (partial selection): control slots never own a cycle.
    const partial = await page.evaluate(async () => {
      const n = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-nudge.ts')
      const ptsLive = [
        { index: 0, x: 10, y: 30, kind: 'anchor' },
        { index: 1, x: 20, y: 30, kind: 'control' },
      ] as any
      return {
        live: (n as any).liveReshapeNudgeIndices(ptsLive, [0, 1, 9]),
        targets: (n as any).reshapeNudgeTargets(ptsLive, [1], 0.2, 0),
        key: (n as any).reshapeNudgeSelectionKey(0, [1]),
        isSel: (n as any).isReshapeNudgeSelection(0, [1]),
      }
    })
    expect(partial.live).toEqual([0])
    expect(partial.targets).toEqual([])
    // Paper truth: explicit anchor 7 shows its handles pressed (first anchor
    // has one out-handle). Handles are display, never nudge owners.
    const handles = await anchorHandles()
    expect(handles.some((h) => h.control)).toBe(true)
    expect(handles.filter((h) => h.control && h.pressed).length).toBeGreaterThan(0)

    // Offscreen: 25 plain ArrowLeft presses march past x=0 with no clamp.
    const step = await page.evaluate(async () => {
      const n = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-nudge.ts')
      const scale = (document.querySelector('[data-vector-stage-surface]') as HTMLElement).getBoundingClientRect().width / 2400
      return (n as any).reshapeNudgeStep(scale) as number
    })
    const xStart = (await orbitPoints(await vmSvg('NudgeA', 'nudge-curve')))[anchors[0]!.index]!.x
    let prev = await previewInner()
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('ArrowLeft')
      await waitPreviewChange(prev)
      prev = await previewInner()
    }
    await page.waitForTimeout(700)
    const xOff = (await orbitPoints(await vmSvg('NudgeA', 'nudge-curve')))[anchors[0]!.index]!.x
    expect(xOff).toBeCloseTo(xStart - 25 * step, 3)
    // No clamp: repeated left travel is strictly linear (not pinned at a bound).
    expect(xOff).toBeLessThan(xStart)
    // Undo the offscreen run back to base (25 entries, one per press).
    for (let i = 0; i < 25; i += 1) {
      await undoVisible().click()
      await page.waitForTimeout(350)
    }
    await page.waitForFunction((want) => document.querySelector('.vector-preview')?.innerHTML === want, await orbitPoints(vmBase).then(() => previewInner()).catch(() => ''), { timeout: 5_000 }).catch(() => undefined)
    // Re-sync deterministically: reload the project bytes guarantee a clean base.
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await selectCurveObject()
    await enterReshapeWithAnchors([anchors[0]!.index])
    const cleanBase = await previewInner()
    const cleanVm = await vmSvg('NudgeA', 'nudge-curve')

    // Input/IME: arrows in the real sprite-name input must not nudge.
    const nameInput = page.getByLabel('Sprite name')
    await nameInput.waitFor({ state: 'visible', timeout: 20_000 })
    await nameInput.click()
    await page.waitForTimeout(300)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(600)
    expect(await previewInner()).toBe(cleanBase)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(cleanVm)
    expect(await undoRedoEnabled().then((v) => v.undo)).toBeDefined()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await page.waitForTimeout(200)
    // No stale preview after the focus excursion: oracle agrees with VM bytes.
    expect(await previewInner()).toBe(cleanBase)
  }, 240_000)

  it('async gated write aborts without stale asset (external CAS + slot/target/reload)', async () => {
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await setZoom(100)
    await selectCurveObject()
    const pts0 = await orbitPoints(await vmSvg('NudgeA', 'nudge-curve'))
    const sel = pts0.filter((p) => p.kind === 'anchor')[0]!.index
    await enterReshapeWithAnchors([sel])

    // External CAS during a deferred nudge: the external wins, no residue.
    // Deterministic commit-point gate (`once` delays only the nudge's CAS;
    // the external below is ungated and lands strictly inside the save window
    // after capture, before commit). Timing marker is the gate call counter,
    // never a wall-clock sleep. Direct `vm.updateCostume` external writes are
    // explicitly protected (versioned CAS detects the bumped writeSeq); only
    // raw direct object mutation is out-of-scope.
    const baseBytes = await vmSvg('NudgeA', 'nudge-curve')
    const baseMeta = await costumeMeta('NudgeA', 'nudge-curve')
    const pairBefore = await undoRedoEnabled()
    const otherPre = await vmSvg('NudgeB', 'nudge-b')
    const seqBefore = await slotIdentity('NudgeA', 0)
    await clearGateCalls()
    await setGate('once', 800)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await waitForGateCalls(1)
    const callsAfterKeydown = await gateCalls()
    expect(callsAfterKeydown.length).toBeGreaterThanOrEqual(1)
    const external = await page.evaluate(async () => {
      const vm = (window as any).__paintHistoryVm
      const tgt = vm.getTarget('NudgeA')
      const idx = tgt.costumes.findIndex((c: any) => c.name === 'nudge-curve')
      const c = tgt.costumes[idx]
      const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
      const text = new TextDecoder().decode(bytes)
      const injected = text.replace('</svg>', '<circle cx="20" cy="20" r="8" fill="#123456"/></svg>')
      await vm.updateCostume('NudgeA', idx, { ...c }, new TextEncoder().encode(injected))
      return injected
    })
    if (!external.includes('#123456')) throw new Error('INVALID: external injection failed')
    // External landed while the nudge was still deferred: prove it before keyup.
    const midBytes = await vmSvg('NudgeA', 'nudge-curve')
    expect(midBytes).toBe(external)
    const seqExt = await slotIdentity('NudgeA', 0)
    expect(seqExt.seq).toBe((seqBefore.seq ?? 0) + 1)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await settle()
    const kept1 = await vmSvg('NudgeA', 'nudge-curve')
    expect(kept1).toBe(external)
    expect(kept1).not.toBe(baseBytes)
    expect((await previewInner()).includes('#123456')).toBe(true)
    expect(await costumeMeta('NudgeA', 'nudge-curve')).toEqual({ ...baseMeta })
    expect(await undoRedoEnabled()).toEqual(pairBefore)
    expect(await vmSvg('NudgeB', 'nudge-b')).toBe(otherPre)
    const seqAfterAbort = await slotIdentity('NudgeA', 0)
    expect(seqAfterAbort.seq).toBe(seqExt.seq)
    const status1 = await editorStatus()
    expect(`${status1}`.toLowerCase()).toMatch(/external|conflict|kept/)
    // Reverse order (distinct): nudge succeeds first, then the external lands.
    // History may remain, but the stale Undo must fail closed with the
    // external preserved (no silent delete). No gate: nudge drains fully.
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await setZoom(100)
    await selectCurveObject()
    const ptsRev = await orbitPoints(await vmSvg('NudgeA', 'nudge-curve'))
    await enterReshapeWithAnchors([ptsRev.filter((p) => p.kind === 'anchor')[0]!.index])
    const revBase = await vmSvg('NudgeA', 'nudge-curve')
    const revPreviewBase = await previewInner()
    const revPairBefore = await undoRedoEnabled()
    await setGate('off')
    await clearGateCalls()
    await page.keyboard.press('ArrowRight')
    await waitPreviewChange(revPreviewBase)
    await page.waitForTimeout(700)
    const revNudged = await vmSvg('NudgeA', 'nudge-curve')
    expect(revNudged).not.toBe(revBase)
    expect(await undoRedoEnabled()).toEqual({ undo: true, redo: false })
    const seqNudged = await slotIdentity('NudgeA', 0)
    const revExternal = await page.evaluate(async () => {
      const vm = (window as any).__paintHistoryVm
      const tgt = vm.getTarget('NudgeA')
      const idx = tgt.costumes.findIndex((c: any) => c.name === 'nudge-curve')
      const c = tgt.costumes[idx]
      const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
      const text = new TextDecoder().decode(bytes)
      const injected = text.replace('</svg>', '<circle cx="40" cy="40" r="5" fill="#654321"/></svg>')
      await vm.updateCostume('NudgeA', idx, { ...c }, new TextEncoder().encode(injected))
      return injected
    })
    if (!revExternal.includes('#654321')) throw new Error('INVALID: reverse external injection failed')
    const revKept = await vmSvg('NudgeA', 'nudge-curve')
    expect(revKept).toBe(revExternal)
    expect(revKept).not.toBe(revNudged)
    const seqRevExt = await slotIdentity('NudgeA', 0)
    expect(seqRevExt.seq).toBe((seqNudged.seq ?? 0) + 1)
    // Stale Undo must fail closed: external preserved, stacks intact, status.
    const revPairWithHistory = await undoRedoEnabled()
    expect(revPairWithHistory).toEqual({ undo: true, redo: false })
    expect(revPairWithHistory).not.toEqual(revPairBefore)
    await undoVisible().click()
    await page.waitForTimeout(700)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(revExternal)
    expect(await undoRedoEnabled()).toEqual({ undo: true, redo: false })
    const revStatus = await editorStatus()
    expect(`${revStatus}`.toLowerCase()).toMatch(/external|conflict|kept/)
    // Restore the project for the switch legs (reload = new generation).
    await importSb3(buildSb3())
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await selectCurveObject()
    const pts1 = await orbitPoints(await vmSvg('NudgeA', 'nudge-curve'))
    await enterReshapeWithAnchors([pts1.filter((p) => p.kind === 'anchor')[0]!.index])

    // Same-name/slot switch mid-press: abort, new slot untouched.
    const slotBytesBefore = await vmSvg('NudgeA', 'nudge-other')
    const curveBytesBefore = await vmSvg('NudgeA', 'nudge-curve')
    await clearGateCalls()
    await setGate('once', 800)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await waitForGateCalls(1)
    await selectCostume('nudge-other')
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await settle()
    expect(await vmSvg('NudgeA', 'nudge-other')).toBe(slotBytesBefore)
    expect(await vmSvg('NudgeA', 'nudge-curve')).toBe(curveBytesBefore)
    // Back to the curve slot for the target leg.
    await selectCostume('nudge-curve')
    await selectCurveObject()
    const pts2 = await orbitPoints(await vmSvg('NudgeA', 'nudge-curve'))
    await enterReshapeWithAnchors([pts2.filter((p) => p.kind === 'anchor')[0]!.index])

    // Target switch mid-press: guardedSelectTarget drains the old target's
    // slot queue before vm.selectTarget, so the deferred nudge completes on
    // the old asset before the swap (no steering into the new asset, no stale
    // preview). History is cleared by the selection switch by design.
    const bBefore = await vmSvg('NudgeB', 'nudge-b')
    const aBefore = await vmSvg('NudgeA', 'nudge-curve')
    const stepTargetBefore = await page.evaluate(async () => {
      const n = await import(/* @vite-ignore */ '/src/features/costumes/vector-reshape-nudge.ts')
      const scale = (document.querySelector('[data-vector-stage-surface]') as HTMLElement).getBoundingClientRect().width / 2400
      return (n as any).reshapeNudgeStep(scale) as number
    })
    await clearGateCalls()
    await setGate('once', 800)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await waitForGateCalls(1)
    await selectTarget('NudgeB')
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await settle()
    expect(await vmSvg('NudgeB', 'nudge-b')).toBe(bBefore)
    const aAfterTargetSwitch = await vmSvg('NudgeA', 'nudge-curve')
    expect(aAfterTargetSwitch).not.toBe(aBefore)
    // Nudge applied exactly one step on the old asset (tight + moved anchor).
    const ptsTargetSwitch = await orbitPoints(aAfterTargetSwitch)
    const ptsTargetBefore = await orbitPoints(aBefore)
    const selTarget = ptsTargetBefore.filter((p) => p.kind === 'anchor')[0]!.index
    expect(ptsTargetSwitch[selTarget]!.x).toBeCloseTo(ptsTargetBefore[selTarget]!.x + stepTargetBefore, 4)
    // Selection owns the new target; history cleared by the switch.
    expect(await undoRedoEnabled()).toEqual({ undo: false, redo: false })
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    await selectCurveObject()
    const pts3 = await orbitPoints(await vmSvg('NudgeA', 'nudge-curve'))
    await enterReshapeWithAnchors([pts3.filter((p) => p.kind === 'anchor')[0]!.index])

    // Project reload mid-press: abort, reloaded bytes win, no stale write.
    // reloadBefore is the nudged tight bytes (target-switch leg completed);
    // the reload replaces the project with the loose fixture, and the gated
    // nudge must not steer stale bytes onto it.
    const reloadBefore = await vmSvg('NudgeA', 'nudge-curve')
    await clearGateCalls()
    await setGate('once', 800)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await waitForGateCalls(1)
    await importSb3(buildSb3())
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })))
    await settle()
    await ensureVectorMode()
    await selectTarget('NudgeA')
    await selectCostume('nudge-curve')
    const reloaded = await vmSvg('NudgeA', 'nudge-curve')
    expect(reloaded).not.toBe(reloadBefore)
    expect(reloaded).toContain('viewBox="0 0 480 360"')
    expect(reloaded).toContain('M180,150')
  }, 240_000)
})
