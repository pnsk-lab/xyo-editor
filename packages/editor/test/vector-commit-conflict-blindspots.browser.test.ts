// Vector commit conflict blind-spots (product code fixed, premise updated).
//
// Premise (verified at runtime against the ON-DISK Editor.svelte source):
// `updateVectorCostumeFromEditor` returns
// `Promise<VectorEditorCommitResult>` (`{kind:'applied'|'conflict'|'skipped', svgText}`)
// and every discrete call site consumes `commit.kind`: only `applied` rebuilds
// `vectorObjects`, touches selection/history and reports success; `conflict`
// keeps the VM bytes and reports `External costume change kept — ...` without
// touching selection/history; `superseded` (target/costume switch mid-save)
// stays fully silent. Scope is captured before the first await and re-checked
// after every await; history uses peek/commit (never capture-then-write).
//
// Verdict policy: assertions describe CORRECT behaviour. Every leg below
// reproduces a concrete false-success / data-corruption against the REAL
// Editor + REAL VM (paint-history-isolation fixture, unmodified production
// Editor). A reproduced product bug FAILS loudly (left failing + reported,
// never silenced with a weak assert). Impossible setups report INVALID.
//
// Coverage (multiple dynamic cases, real UI ops):
//   1. brush stroke  + external same-slot write -> false `Vector brush stroke saved`
//   2. fill click    + external same-slot write -> false `Vector fill: ...`
//   3. color Apply   + external same-slot write -> false `Vector object edited`
//   4. reorder front + external same-slot write -> false `Vector objects updated`
//   5. flip/rotation + external same-slot write -> false `Vector objects updated`
//   6. text insert   + external same-slot write -> false `Vector text saved`
//   7. target switch during a gated reorder save -> stale completion repaints
//      the NEW target's `vectorObjects`/selection/status (cross-asset corruption)
//   (reshape point drag shares the same blind `updateVectorPathPoint`/
//   `updateVectorReshapePoints` pattern; legs 1-6 prove the shared commit
//   helper is ignored, leg 7 proves the stale-completion half.)
//
// Method (test-only page patches, no product edit):
// - A deferred gate wraps BOTH `vm.updateCostume` and `vm.updateCostumeIfMatch`
//   on the REAL fixture VM: `delayOnce(ms)` holds the NEXT gated write inside
//   its slot run so an external bypass + a UI commit overlap deterministically.
// - The external same-slot write bypasses the per-slot FIFO on purpose
//   (direct `storeAsset` + costume ref swap + monotonic `costumeWriteSeq` bump
//   through the VM's own `costumeSlotKey` helper): it lands WHILE the gated UI
//   write is held, so the UI write's versioned CAS (`wantSeq=N` vs live `N+1`,
//   including metadata-only / same-bytes externals) MUST lose. The VM keeps
//   the external (correct); the blind Editor caller must report
//   `External costume change kept — ...` + leave selection/history alone, but
//   instead reports success + mutates selection/history (reproduced below).
// - Target-switch leg uses the same gate without any external: the old-slot
//   write is held, the test switches to VecB, the stale write then succeeds
//   on the OLD slot yet the blind caller repaints the NEW selection.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4597
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const BLANK_VEC = `${HEAD}</svg>`
const rectSvg = (x: number, y: number, w: number, h: number, fill: string) =>
  `${HEAD}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#111111" stroke-width="2"/></svg>`
const RECT_A2 = rectSvg(150, 120, 140, 110, '#e74c3c')
const RECT_B = rectSvg(200, 140, 100, 80, '#2980b9')
const TWO_RECTS =
  `${HEAD}<rect x="80" y="100" width="120" height="90" fill="#e74c3c" stroke="#111111" stroke-width="2"/>` +
  `<rect x="240" y="150" width="120" height="90" fill="#2980b9" stroke="#111111" stroke-width="2"/></svg>`

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    files[`${hash}.svg`] = bytes
    return { assetId: hash, md5ext: `${hash}.svg` }
  }
  const blank = add(BLANK_VEC)
  const a2 = add(RECT_A2)
  const two = add(TWO_RECTS)
  const b = add(RECT_B)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
  })
  const project = {
    targets: [
      {
        isStage: false, name: 'VecA', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(blank, 'vec-blank'), costume(a2, 'vec-a2'), costume(two, 'vec-two')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
      {
        isStage: false, name: 'VecB', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0, costumes: [costume(b, 'vec-b')],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 80, y: 40, size: 100,
        direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'commit-blindspots', agent: 'commit-blindspots' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

function log(label: string, value: unknown) {
  console.log(`[blindspots] ${label} ${JSON.stringify(value).slice(0, 3000)}`)
}

async function snapshot(): Promise<any> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest')
    return api.snapshot()
  })
}
async function editorStatus(): Promise<string> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest
    return api?.status() ?? ''
  })
}
async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}
async function waitForPreviewChange(before: string, timeout = 20_000) {
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, before, { timeout })
}
async function svgBytesOf(targetName: string, index: number): Promise<string> {
  return await page.evaluate(async ({ t, i }: { t: string; i: number }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm')
    const tgt = vm.getTarget(t)
    if (!tgt) throw new Error(`Missing target ${t}`)
    const c = tgt.costumes[i]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { t: targetName, i: index })
}
async function costumeMd5Of(targetName: string, index: number): Promise<string | null> {
  const snap = await snapshot()
  const target = snap.project.targets.find((t: any) => t.name === targetName)
  return (target?.costumes[index]?.md5ext as string | undefined) ?? null
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
async function selectionOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}
// Selected outlines only (blue): total counts EVERY object (one div per
// object regardless of selection), so a leak assertion must use blue.
// VecB legitimately owns 1 object => total==1 with blue==0 is correct.
async function selectedOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline].border-blue-500').count()
}
async function pointHandles(): Promise<Array<{ index: number; x: number; y: number; control: boolean }>> {
  return await page.evaluate(() => {
    const out: Array<{ index: number; x: number; y: number; control: boolean }> = []
    for (const el of Array.from(document.querySelectorAll('[data-vector-path-point]'))) {
      const r = (el as HTMLElement).getBoundingClientRect()
      const label = el.getAttribute('aria-label') ?? ''
      out.push({
        index: Number((el as HTMLElement).dataset.pointIndex),
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        control: label.startsWith('Move control point'),
      })
    }
    return out
  })
}

// Deferred gate on BOTH entry points of the REAL VM (test-only page patch).
// `delayOnce(ms)` holds the NEXT gated slot write inside its run; the bypass
// external below lands during the hold so the UI CAS must lose.
async function installVmGate() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    const vm = w.__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm for gate install')
    if (w.__blindGate) return
    const gate = (w.__blindGate = { delayOnceMs: 0, delayed: 0, calls: [] as Array<{ fn: string; target: string; index: number }> })
    const wrap = (fn: string) => {
      const orig = vm[fn].bind(vm)
      vm[fn] = async (...args: any[]) => {
        gate.calls.push({ fn, target: String(args[0]), index: Number(args[1]) })
        if (gate.delayOnceMs > 0) {
          const ms = gate.delayOnceMs
          gate.delayOnceMs = 0
          gate.delayed += 1
          await new Promise((r) => setTimeout(r, ms))
        }
        return orig(...args)
      }
    }
    wrap('updateCostume')
    if (typeof vm.updateCostumeIfMatch === 'function') wrap('updateCostumeIfMatch')
  })
}
async function delayOnce(ms = 700) {
  await page.evaluate((delay: number) => {
    const w = window as unknown as Record<string, any>
    if (!w.__blindGate) throw new Error('Gate not installed')
    w.__blindGate.delayOnceMs = delay
  }, ms)
}
async function clearGateCalls() {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__blindGate) w.__blindGate.calls = []
  })
}
// Wait until the deferred gate has taken at least `count` VM writes, so a
// follow-up external/switch lands strictly inside the save window (after
// capture, before commit) instead of racing the harness. Fixed sleeps
// cannot guarantee this: the commit has awaits (loadAsset/peek) before the
// gated VM call.
async function waitForGateCalls(count: number, timeout = 10_000) {
  await page.waitForFunction(
    (want: number) => ((window as unknown as Record<string, any>).__blindGate?.calls?.length ?? 0) >= want,
    count,
    { timeout },
  )
}

// External same-slot write that BYPASSES the per-slot FIFO (direct store +
// costume ref swap + monotonic seq bump via the VM's own helpers), so it
// lands WHILE a gated UI write is held. Uses a visibly different fill so a
// cross-asset write is attributable. Returns the external svg text.
async function injectExternalSameSlotBypass(targetName: string, index: number, fill: string): Promise<string> {
  return await page.evaluate(async ({ t, i, f }: { t: string; i: number; f: string }) => {
    const vm = (window as unknown as { __paintHistoryVm?: any }).__paintHistoryVm
    if (!vm) throw new Error('Missing __paintHistoryVm')
    const tgt = vm.getTarget(t)
    if (!tgt) throw new Error(`Missing target ${t}`)
    const before = tgt.costumes[i]
    const beforeBytes = (await vm.loadAsset(before.md5ext ?? before.assetId, before.dataFormat ?? 'svg')) as Uint8Array
    const beforeText = new TextDecoder().decode(beforeBytes)
    // Keep geometry, swap every fill to the external color (attributable).
    const externalText = beforeText.replace(/fill="[^"]*"/g, `fill="${f}"`)
    const bytes = new TextEncoder().encode(externalText)
    const stored = await vm.storeAsset(bytes, 'svg')
    tgt.costumes[i].assetId = (stored as any).assetId ?? (stored as any).assetId
    tgt.costumes[i].md5ext = (stored as any).md5ext ?? (stored as any).md5ext
    tgt.costumes[i].dataFormat = 'svg'
    try {
      const keyOf = (vm as any).costumeSlotKey
        ? (vm as any).costumeSlotKey((tgt.id ?? t), i)
        : `${tgt.id ?? t}:${i}`
      const map = (vm as any).costumeWriteSeq as Map<string, number> | undefined
      if (map && typeof keyOf === 'string') map.set(keyOf, (map.get(keyOf) ?? 0) + 1)
      else if (map) {
        for (const k of [...map.keys()]) {
          if (k.endsWith(`:${i}`)) map.set(k, (map.get(k) ?? 0) + 1)
        }
      }
    } catch {}
    try {
      ;(vm as any).emit?.('TARGETS_UPDATE', (vm as any).snapshot?.() ?? undefined)
    } catch {}
    return externalText
  }, { t: targetName, i: index, f: fill })
}

async function importSb3(bytes: Buffer, fileName: string, expectTarget: string) {
  await page.getByTestId('project-file-input').setInputFiles({ name: fileName, mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    (want: string) => {
      const snap = (window as any).__hikkakuEditorTest?.snapshot()
      return snap?.project.targets.some((t: any) => t.name === want) ?? false
    },
    expectTarget,
    { timeout: 30_000 },
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
async function selectCostumeCard(costumeIndex: number) {
  await page.locator(`[data-testid="costume-card-${costumeIndex}"] button[aria-label^="Select "]`).first().click()
  await page.waitForTimeout(900)
}
async function drawRectBaseline(): Promise<{ baseSvg: string }> {
  await page.getByTestId('vector-shape-rect').last().click()
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('INVALID: missing paint surface bounds')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const before = await previewSvg()
  await page.mouse.move(cx - 110, cy - 60)
  await page.mouse.down()
  await page.mouse.move(cx + 110, cy + 60, { steps: 12 })
  await page.mouse.up()
  await waitForPreviewChange(before)
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(500)
  return { baseSvg: await previewSvg() }
}
async function settle(timeout = 25_000) {
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, any>
    const calls = (w.__blindGate?.calls?.length ?? 0) as number
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const prev = w.__settlePrev as { calls?: number; html?: string; stableSince?: number } | undefined
    const now = Date.now()
    if (!prev || prev.calls !== calls || prev.html !== html) {
      w.__settlePrev = { calls, html, stableSince: now }
      return false
    }
    return now - (prev.stableSince ?? now) > 900
  }, undefined, { timeout })
  await page.waitForTimeout(400)
}

describe('vector commit conflict blind-spots (new, no product change)', () => {
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
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 300)))
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await installVmGate()
    // Read-only premise audit on the ON-DISK product source (HMR-stable
    // check: the new `{kind,svgText}` shape must be live, otherwise INVALID).
    // Served-bundle fetch is transform-shaped, so audit the file directly.
    const source = readFileSync(join(root, 'src', 'Editor.svelte'), 'utf8')
    const commitSigs = (source.match(/updateVectorCostumeFromEditor\(/g) ?? []).length
    const blind = (source.match(/updateVectorCostumeFromEditor\([\s\S]*?\)\)\.svgText/g) ?? []).length
    const kindChecks = (source.match(/commit\.kind|\.kind !== 'applied'|\.kind === 'applied'|isVectorCommitApplied/g) ?? []).length
    const audit = { commitSigs, blind, kindChecks, hasNewShape: source.includes('Promise<VectorEditorCommitResult>') }
    log('commit-shape audit', audit)
    expect(audit.hasNewShape).toBe(true)
    expect(audit.commitSigs).toBeGreaterThanOrEqual(22)
    // Fixed state: no discrete call site may ignore `commit.kind` (blind
    // `(...)).svgText` with unconditional success writes). Gesture/preview
    // paths consume the result through `isVectorGestureConflicted`, so the
    // raw blind pattern must be gone entirely.
    expect(audit.blind).toBe(0)
    expect(audit.kindChecks).toBeGreaterThanOrEqual(20)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('brush stroke + external same-slot write must not report success', async () => {
    await importSb3(buildSb3(), 'blind-brush.sb3', 'VecA')
    await ensureVectorMode()
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeCard(1)
    await drawRectBaseline()
    const pairBefore = await undoRedoEnabled()
    const outlinesBefore = await selectionOutlineCount()
    const blueBefore = await selectedOutlineCount()
    const previewBefore = await previewSvg()
    const md5Before = await costumeMd5Of('VecA', 1)
    // Brush commits on mouse UP (`saveVectorBrushStroke` captures its
    // discrete expected synchronously at UP, then awaits load/peek before the
    // gated VM write). Injecting BEFORE UP is read into the draft (no
    // conflict, success is CORRECT). A true conflict needs the external to
    // land AFTER capture but BEFORE the CAS: full stroke + UP first, wait for
    // the gated write to enter (queue entry observed via the gate counter,
    // never wall-clock), then inject the bypass external during the hold.
    // Previous revision injected mid-stroke (before capture) so the brush
    // built on the external and correctly reported success — fixture timing,
    // not a product false-success (verified: live==draft+brush, no conflict).
    await clearGateCalls()
    await delayOnce(800)
    await page.getByTestId('vector-shape-brush').last().click()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('INVALID: missing paint surface for brush')
    const sx = box.x + box.width / 2 - 60
    const sy = box.y + box.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx + 90, sy + 20, { steps: 10 })
    await page.mouse.move(sx + 120, sy - 10, { steps: 6 })
    await page.mouse.up()
    await waitForGateCalls(1)
    const externalSvg = await injectExternalSameSlotBypass('VecA', 1, '#00e676')
    log('brush external', { externalFillPresent: externalSvg.includes('#00e676') })
    await settle()
    const status = await editorStatus()
    const liveSvg = await svgBytesOf('VecA', 1)
    const previewAfter = await previewSvg()
    const md5After = await costumeMd5Of('VecA', 1)
    const blueAfter = await selectedOutlineCount()
    const outlinesAfter = await selectionOutlineCount()
    const pairAfter = await undoRedoEnabled()
    log('brush conflict', { status, pairBefore, pairAfter, outlinesBefore, outlinesAfter, blueBefore, blueAfter, liveIsExternal: liveSvg === externalSvg, liveHasExternal: liveSvg.includes('#00e676') })
    // CORRECT: the VM kept the external (CAS mismatch on versioned seq);
    // the Editor must say so (conflict), must not claim a brush save, must
    // not grow Undo for a dropped edit, must leave selection/object-list
    // alone, and must refresh the preview from live (external visible).
    // Strict: dropped brush => live bytes are EXACTLY the external.
    expect(liveSvg).toBe(externalSvg)
    expect(liveSvg).toContain('#00e676')
    expect(status).toContain('External costume change kept')
    expect(status).not.toContain('Vector brush stroke saved')
    expect(pairAfter).toEqual(pairBefore)
    expect(blueAfter).toBe(blueBefore)
    expect(outlinesAfter).toBe(outlinesBefore)
    expect(previewAfter).toContain('#00e676')
    expect(previewAfter).not.toBe(previewBefore)
    expect(md5After).not.toBe(md5Before)
  }, 180_000)

  it('fill click + external same-slot write must not report success', async () => {
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeCard(1)
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForTimeout(500)
    const pairBefore = await undoRedoEnabled()
    await clearGateCalls()
    await delayOnce(800)
    await page.getByTestId('vector-shape-fill').last().click()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('INVALID: missing paint surface for fill')
    // Click the rect interior via the selection outline center.
    const outline = page.locator('[data-vector-selection-outline]').last()
    await outline.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined)
    let at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    try {
      const ob = await outline.boundingBox({ timeout: 5_000 })
      if (ob) at = { x: ob.x + ob.width / 2, y: ob.y + ob.height / 2 }
    } catch {}
    // Start the fill press, inject the external mid-hold, then release.
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.waitForTimeout(150)
    const externalSvg = await injectExternalSameSlotBypass('VecA', 1, '#ff6d01')
    log('fill external', { externalFillPresent: externalSvg.includes('#ff6d01') })
    await page.mouse.up()
    await settle()
    const status = await editorStatus()
    const liveSvg = await svgBytesOf('VecA', 1)
    const pairAfter = await undoRedoEnabled()
    log('fill conflict', { status, pairBefore, pairAfter, liveHasExternal: liveSvg.includes('#ff6d01') })
    expect(liveSvg).toContain('#ff6d01')
    expect(status).toContain('External costume change kept')
    expect(status).not.toContain('Vector fill')
    expect(status).not.toContain('Vector object edited')
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('color Apply + external same-slot write must not report success', async () => {
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeCard(2)
    // Select the first of the two rects through the real outline.
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('INVALID: missing paint surface for color')
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(box.x + box.width / 2 - 80, box.y + box.height / 2)
    await page.waitForTimeout(600)
    if ((await selectionOutlineCount()) === 0) throw new Error('INVALID: color leg could not select a vector object')
    const pairBefore = await undoRedoEnabled()
    // Make the fill dirty through the REAL color picker (never JS state).
    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="Paint color"]') as HTMLInputElement | null
      if (!input) throw new Error('INVALID: missing Paint color input')
      input.value = '#00b0ff'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForTimeout(300)
    await clearGateCalls()
    await delayOnce(800)
    const apply = page.getByTestId('apply-vector-style')
    await apply.scrollIntoViewIfNeeded().catch(() => undefined)
    await apply.click()
    await page.waitForTimeout(150)
    await injectExternalSameSlotBypass('VecA', 2, '#ff1744')
    await settle()
    const status = await editorStatus()
    const liveSvg = await svgBytesOf('VecA', 2)
    const pairAfter = await undoRedoEnabled()
    log('color conflict', { status, pairBefore, pairAfter, liveHasExternal: liveSvg.includes('#ff1744') })
    expect(liveSvg).toContain('#ff1744')
    expect(status).toContain('External costume change kept')
    expect(status).not.toContain('Vector object edited')
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('reorder (bring to front) + external must not report success', async () => {
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeCard(2)
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('INVALID: missing paint surface for reorder')
    await page.getByTestId('vector-shape-select').last().click()
    // Select the BACK rect (first unit) so front-move is effective.
    await page.mouse.click(box.x + box.width / 2 - 90, box.y + box.height / 2 - 20)
    await page.waitForTimeout(600)
    if ((await selectionOutlineCount()) === 0) throw new Error('INVALID: reorder leg could not select a vector object')
    const pairBefore = await undoRedoEnabled()
    await clearGateCalls()
    await delayOnce(800)
    await page.getByTestId('layer-order-front').click()
    await page.waitForTimeout(150)
    const externalSvg = await injectExternalSameSlotBypass('VecA', 2, '#76ff03')
    log('reorder external', { externalFillPresent: externalSvg.includes('#76ff03') })
    await settle()
    const status = await editorStatus()
    const liveSvg = await svgBytesOf('VecA', 2)
    const pairAfter = await undoRedoEnabled()
    log('reorder conflict', { status, pairBefore, pairAfter, liveHasExternal: liveSvg.includes('#76ff03') })
    expect(liveSvg).toContain('#76ff03')
    expect(status).toContain('External costume change kept')
    expect(status).not.toContain('Vector objects updated')
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('rotation (flip horizontal) + external must not report success', async () => {
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeCard(2)
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('INVALID: missing paint surface for flip')
    await page.getByTestId('vector-shape-select').last().click()
    // Click the LEFT rect interior (center is the gap between the two rects).
    await page.mouse.click(box.x + box.width / 2 - 90, box.y + box.height / 2 - 20)
    await page.waitForTimeout(600)
    if ((await selectionOutlineCount()) === 0) throw new Error('INVALID: flip leg could not select a vector object')
    const pairBefore = await undoRedoEnabled()
    await clearGateCalls()
    await delayOnce(800)
    await page.getByTestId('flip-bitmap-horizontal').click()
    await page.waitForTimeout(150)
    await injectExternalSameSlotBypass('VecA', 2, '#d500f9')
    await settle()
    const status = await editorStatus()
    const liveSvg = await svgBytesOf('VecA', 2)
    const pairAfter = await undoRedoEnabled()
    log('flip conflict', { status, pairBefore, pairAfter, liveHasExternal: liveSvg.includes('#d500f9') })
    expect(liveSvg).toContain('#d500f9')
    expect(status).toContain('External costume change kept')
    expect(status).not.toContain('Vector objects updated')
    expect(status).not.toContain('Vector object edited')
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('text insert + external must not report success', async () => {
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeCard(1)
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForTimeout(400)
    const pairBefore = await undoRedoEnabled()
    await clearGateCalls()
    await delayOnce(900)
    await page.getByTestId('vector-shape-text').last().click()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('INVALID: missing paint surface for text')
    await page.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40)
    const overlay = page.locator('[data-inline-text-editor]')
    try {
      await overlay.waitFor({ state: 'visible', timeout: 8_000 })
      await overlay.locator('textarea').fill('blindtext')
    } catch {
      throw new Error('INVALID: inline text overlay never opened for text leg')
    }
    await page.waitForTimeout(150)
    // Commit through the REAL overlay (Escape), whose save is the blind 8674 path.
    // Inject AFTER the commit's load (Escape starts load+enqueue; the gate
    // holds the write) so the versioned CAS must lose. Injecting before
    // Escape would be read into the draft (no conflict) and prove nothing.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await injectExternalSameSlotBypass('VecA', 1, '#00e5ff')
    await settle()
    const status = await editorStatus()
    const liveSvg = await svgBytesOf('VecA', 1)
    const pairAfter = await undoRedoEnabled()
    log('text conflict', { status, pairBefore, pairAfter, liveHasExternal: liveSvg.includes('#00e5ff'), liveHasBlind: liveSvg.includes('blindtext') })
    expect(liveSvg).toContain('#00e5ff')
    expect(liveSvg).not.toContain('blindtext')
    expect(status).toContain('External costume change kept')
    expect(status).not.toContain('Vector text saved')
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('reshape style (curve) + external must not report success', async () => {
    // Self-sufficient when run filtered: ensure the blind-spots project exists.
    try {
      const hasVecA = await page.getByTestId('target-card-VecA').count()
      if (hasVecA === 0) {
        await importSb3(buildSb3(), 'blind-reshape.sb3', 'VecA')
        await ensureVectorMode()
      }
    } catch {
      await importSb3(buildSb3(), 'blind-reshape.sb3', 'VecA')
      await ensureVectorMode()
    }
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeCard(1)
    await page.getByTestId('vector-shape-select').last().click()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('INVALID: missing paint surface for reshape')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(400)
    await page.getByTestId('vector-shape-reshape').last().click()
    try {
      await page.waitForSelector('[data-vector-path-point]', { timeout: 20_000 })
    } catch {
      throw new Error('INVALID: reshape handles never appeared for reshape leg')
    }
    await page.waitForTimeout(400)
    const pairBefore = await undoRedoEnabled()
    const handles = (await pointHandles()).filter((h) => !h.control).sort((a, b) => a.x - b.x)
    if (handles.length === 0) throw new Error('INVALID: no anchor handles for reshape leg')
    // Select one anchor through the real handle (blind style path needs a
    // non-empty reshape selection; drag itself is gesture-safe so use curve).
    const h = handles[0]!
    await page.mouse.click(h.x, h.y)
    await page.waitForTimeout(500)
    await clearGateCalls()
    await delayOnce(800)
    // `styleVectorReshapePoint('curved')` is a blind 11262 caller: must lose
    // to the external, not claim `Reshape point curved`.
    await page.getByTestId('reshape-curve-point').click()
    await page.waitForTimeout(150)
    await injectExternalSameSlotBypass('VecA', 1, '#ff8f00')
    await settle()
    const status = await editorStatus()
    const liveSvg = await svgBytesOf('VecA', 1)
    const pairAfter = await undoRedoEnabled()
    log('reshape conflict', { status, pairBefore, pairAfter, liveHasExternal: liveSvg.includes('#ff8f00') })
    expect(liveSvg).toContain('#ff8f00')
    expect(status).toContain('External costume change kept')
    expect(status).not.toContain('Reshape point curved')
    expect(status).not.toContain('Reshape points curved')
    expect(pairAfter).toEqual(pairBefore)
  }, 180_000)

  it('target switch during a gated save must not repaint the new target', async () => {
    await page.getByTestId('target-card-VecA').click()
    await page.waitForTimeout(600)
    await selectCostumeCard(2)
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('INVALID: missing paint surface for switch leg')
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(box.x + box.width / 2 - 90, box.y + box.height / 2 - 20)
    await page.waitForTimeout(600)
    const vecABefore = await svgBytesOf('VecA', 2)
    const vecBBefore = await svgBytesOf('VecB', 0)
    const vecBMd5Before = await costumeMd5Of('VecB', 0)
    const blueBeforeSwitch = await selectedOutlineCount()
    // Hold the old-slot reorder write, fire it, then switch mid-hold.
    // The gate entry is observed via the counter (never a fixed sleep): the
    // switch below then lands strictly inside the save window (after capture,
    // before commit). A fixed 250ms sleep cannot guarantee the commit entered
    // the gate — a leftover write from a prior leg can consume `delayOnce`,
    // letting the reorder run ungated pre-switch (flaky vecA landing).
    await clearGateCalls()
    await delayOnce(1200)
    await page.getByTestId('layer-order-front').click()
    await waitForGateCalls(1)
    await page.getByTestId('target-card-VecB').click()
    await page.waitForFunction(() => {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
      const snap = api?.snapshot()
      if (!snap) return false
      const sel = snap.selectedTargetId as string | undefined
      if (!sel) return false
      if (sel === 'VecB') return true
      return snap.project.targets.find((t: any) => t.id === sel)?.name === 'VecB'
    }, undefined, { timeout: 20_000 })
    const vecBPreviewAtSwitch = await previewSvg()
    await settle()
    const vecAAfter = await svgBytesOf('VecA', 2)
    const vecBAfter = await svgBytesOf('VecB', 0)
    const vecBMd5After = await costumeMd5Of('VecB', 0)
    const vecBPreviewAfter = await previewSvg()
    const status = await editorStatus()
    const pairAfter = await undoRedoEnabled()
    log('target-switch', {
      status,
      vecBUntouched: vecBAfter === vecBBefore,
      vecBPreviewStable: vecBPreviewAfter === vecBPreviewAtSwitch,
      vecBPreviewAtSwitch: vecBPreviewAtSwitch.slice(0, 120),
      vecBPreviewAfter: vecBPreviewAfter.slice(0, 120),
      pairAfter,
    })
    // CORRECT: the stale discrete save is SUPERSEDED (fail-closed, no bytes
    // anywhere): the Editor scope (`selectedTargetId/index` moved) and the VM
    // explicit discrete selection precondition (stable id + index + project
    // generation + monotonic selection epoch, checked at enqueue, at queue
    // start, and after `storeAsset` before the atomic mutation) both abort the
    // bytes themselves, not just the post-commit UI. This matches the
    // discrete-save-race T1/T2 abort semantics (in-flight stamp dropped, no
    // steering into the new asset). The old "may land on VecA" premise
    // predates the VM selection guard; asserting a landing would enshrine the
    // old blind behavior. VecB bytes/meta/preview stay byte-identical, no
    // success status leaks onto the new selection, and no history appears.
    // Any `Vector object*` success here is the stale completion repainting
    // the new selection.
    // Selection vs object-list discipline: `[data-vector-selection-outline]`
    // renders ONE div per object regardless of selection (blue iff selected),
    // so total==1 is VecB's own single rect (object list correct, not a
    // leak) and blue==0 proves the old VecA selection was cancelled, not
    // applied to the new asset. total==0 would require VecB to own no art.
    const totalAfterSwitch = await selectionOutlineCount()
    const blueAfterSwitch = await selectedOutlineCount()
    log('target-switch outlines', { totalAfterSwitch, blueAfterSwitch, blueBeforeSwitch })
    expect(vecBAfter).toBe(vecBBefore)
    expect(vecBMd5After).toBe(vecBMd5Before)
    expect(vecBPreviewAfter).toBe(vecBPreviewAtSwitch)
    expect(vecBPreviewAfter).not.toContain(vecAAfter.slice(vecAAfter.indexOf('<rect'), vecAAfter.indexOf('<rect') + 80))
    expect(status).not.toContain('Vector object edited')
    expect(status).not.toContain('Vector objects updated')
    expect(blueAfterSwitch).toBe(0)
    expect(totalAfterSwitch).toBe(1)
    expect(pairAfter).toEqual({ undo: false, redo: false })
    expect(vecAAfter).toBe(vecABefore)
  }, 180_000)
})
