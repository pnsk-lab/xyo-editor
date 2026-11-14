// Real-Editor history guard for singular vector artwork (peek/commit).
//
// Drives the REAL Editor bundle (paint-history-isolation fixture: real
// Editor.svelte + real VM exposed as `__paintHistoryVm`) in Chromium via Vite.
// The previous vector-singular-editor-history.browser.test.ts only reproduced
// the peek->commit rule through helper imports (paper-vector.ts /
// vector-path-points.ts) with a hand-rolled mock stack. This file instead:
//  - uploads a REAL project (sb3 via the real project-file-input) containing
//    a singular SVG costume (`<g transform="scale(0)">` rect + path) and a
//    normal SVG costume (2 rects + path),
//  - performs each vector action through REAL UI handlers (units-list
//    selection, Ctrl+A, arrow-key nudge, sidebar Left/Right/Grow/Rotate/Flip/
//    Align/Group/Ungroup/Duplicate/Front buttons, reshape-tool anchor drag,
//    se resize-handle drag),
//  - asserts against REAL VM asset bytes (`vm.loadAsset` len+sum+text) and the
//    REAL Undo/Redo buttons (visible + disabled), plus the rendered
//    `.vector-preview` SVG.
// Singular costume: every Paper-backed transform op (keyboard nudge, move
// buttons, Grow/Shrink resize, Rotate +/-15, Flip H/V, Align, reshape drag,
// handle drag, selection itself) must leave VM bytes byte-identical and
// Undo/Redo disabled state untouched (peek discarded, never committed).
// Normal costume: the same ops must each apply (bytes + preview change) and
// restore/exchange in exactly ONE Undo/Redo step. Group/ungroup/align/
// duplicate/order are additionally verified on the normal costume.
// Honestly-documented reachability gaps (no product-code guessing):
//  - DOM-regroup ops (group/duplicate/order) do NOT go through the Paper
//    singular check, so they are intentionally NOT asserted on the singular
//    costume (out of fail-closed scope); they are covered on normal artwork.
//  - se-handle / reshape-anchor pointer drags under scale(0) may have no
//    visible handle (collapsed geometry). When the handle is absent the step
//    is recorded as unreachable (bytes/Undo invariant still asserted) instead
//    of failing on geometry that cannot be grabbed.
//  - rotation-center drag, curve/point style buttons, inline text editing,
//    marquee/bulk-point paths and style Apply are not part of this matrix and
//    are listed as out-of-scope (see REACHABILITY_NOTES).
// Product code is untouched. Independent port 4387. CHROME_BIN is respected
// via launchBrowser (no hardcoded binary).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4387
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const REACHABILITY_NOTES = [
  'singular scale(0): every Paper path (keyboard nudge, move buttons, single-unit Grow/Shrink/Rotate/Flip via applyPaperScale/Rotation/Flip, multi Rotate/Flip arrangement, Align, reshape-anchor drag, se resize-handle drag) is fail-closed: DOM/VM/selection/Undo/Redo all untouched with no history entry.',
  'singular DOM-regroup ops (Group/Duplicate/Front/Back/order) bypass the Paper singular check by design: NOT asserted on singular (covered on normal).',
  'singular handle drags are gated on hittability, not mere visibility: collapsed scale(0) geometry can report a layout box that is clipped outside the panned surface viewport (Playwright "visible" misses clipping), leaving no pointer path; then the step is reported unreachable with bytes/Undo invariant still asserted.',
  'normal reshape uses a freshly drawn center rect (uploaded-path anchors can sit outside the harness pan viewport); the drag then exercises the real moveVectorReshapePoints peek->commit path.',
  'out-of-scope (not driven here): rotation-center drag, curve/point style buttons, inline text editing, marquee/bulk-point selection, style Apply, bitmap tools, single-unit overlay handle drags (no proven mouse-driven precedent in this harness; union-handle drag covers resize).',
]

const SINGULAR_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<g transform="scale(0)"><rect x="10" y="10" width="20" height="20" fill="#ff0000"/>` +
  `<path d="M 60 10 L 100 10 L 100 50 L 60 50 Z" fill="#0000ff"/></g></svg>`
const NORMAL_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect id="n-rect" x="40" y="60" width="120" height="80" fill="#ff0000"/>` +
  `<rect id="n-rect2" x="220" y="60" width="120" height="80" fill="#0000ff"/>` +
  `<path id="n-path" d="M 60 200 L 140 200 L 140 280 L 60 280 Z" fill="#00ff00"/></svg>`

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const add = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    const hash = md5(bytes)
    const md5ext = `${hash}.svg`
    files[md5ext] = bytes
    return { assetId: hash, md5ext }
  }
  const singular = add(SINGULAR_SVG)
  const normal = add(NORMAL_SVG)
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
        costumes: [{ ...costume(singular, 'stage-backdrop'), rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [costume(singular, 'singular-scale0'), costume(normal, 'normal-compare')],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'vector-singular-real-editor' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

// --- real-UI + real-bytes helpers -------------------------------------------

type Digest = { len: number; sum: number; md5ext: string }

async function costumeDigest(target: string, index: number): Promise<Digest> {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const key = c?.md5ext ?? c?.assetId
    const bytes = (await vm.loadAsset(key, c.dataFormat ?? '')) as Uint8Array
    if (!bytes) throw new Error(`missing bytes ${target}[${index}]`)
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    return { len: (bytes as Uint8Array).length, sum, md5ext: c.md5ext as string }
  }, { target, index })
}

async function costumeText(target: string, index: number): Promise<string> {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const bytes = (await vm.loadAsset(c.md5ext ?? c.assetId, c.dataFormat ?? '')) as Uint8Array
    return new TextDecoder().decode(bytes)
  }, { target, index })
}

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function expectBytesSameAs(target: string, index: number, want: Digest) {
  // Compare len+sum only: internal saves re-hash with FNV-1a while SB3
  // originals carry MD5 names, so an Undo restoring byte-identical content
  // yields a different md5ext (paint-history-isolation documents this).
  const got = await costumeDigest(target, index)
  expect({ len: got.len, sum: got.sum }).toEqual({ len: want.len, sum: want.sum })
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(
    () => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status(),
  )
}

// A handle can have a layout box yet be clipped outside the visible paint
// viewport (the 480x360 workspace renders at 5x with its own pan: the preview
// div here measured 2400x1800 at (-635,-275) inside a 575x455 window, so
// collapsed scale(0) handles report boxes that hit-test to layout DIVs).
// Playwright "visible" does not catch clipping, so check hittability: the
// topmost element at the handle center must be the handle itself. Otherwise
// no pointer path exists and the step is honestly unreachable.
async function hittableHandleCenter(selector: string): Promise<{ x: number; y: number } | null> {
  const found = await page.evaluate((sel: string) => {
    const btn = document.querySelector(sel) as HTMLElement | null
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    const top = document.elementFromPoint(cx, cy)
    if (top === btn || (btn.contains(top) && top !== null)) return { x: cx, y: cy }
    return null
  }, selector)
  return found
}

async function undoRedoDisabled(): Promise<{ undoDisabled: boolean; redoDisabled: boolean }> {
  return await page.evaluate(() => {
    const visible = (label: string) =>
      Array.from(document.querySelectorAll(`button[aria-label="${label}"]`)).filter(
        (b) => (b as HTMLElement).offsetParent !== null,
      ) as HTMLButtonElement[]
    const u = visible('Undo')[0]
    const r = visible('Redo')[0]
    if (!u || !r) throw new Error('Undo/Redo buttons not visible')
    return { undoDisabled: u.disabled, redoDisabled: r.disabled }
  })
}

async function expectUndoEnabled(enabled: boolean) {
  await page.waitForFunction(
    (want) => {
      const visible = (label: string) =>
        Array.from(document.querySelectorAll(`button[aria-label="${label}"]`)).filter(
          (b) => (b as HTMLElement).offsetParent !== null,
        ) as HTMLButtonElement[]
      const u = visible('Undo')[0]
      return u ? u.disabled === !want : false
    },
    enabled,
    { timeout: 10_000 },
  )
  expect((await undoRedoDisabled()).undoDisabled).toBe(!enabled)
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

async function waitForDigest(target: string, index: number, want: Digest, timeout = 15_000): Promise<Digest> {
  const start = Date.now()
  for (;;) {
    const got = await costumeDigest(target, index)
    if (got.len === want.len && got.sum === want.sum) return got
    if (Date.now() - start > timeout) {
      throw new Error(`digest wait timeout ${target}[${index}] want=${JSON.stringify(want)} got=${JSON.stringify(got)}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForDigestChange(target: string, index: number, before: Digest, timeout = 15_000): Promise<Digest> {
  const start = Date.now()
  for (;;) {
    const got = await costumeDigest(target, index)
    if (got.len !== before.len || got.sum !== before.sum) return got
    if (Date.now() - start > timeout) {
      throw new Error(`digest change timeout ${target}[${index}] before=${JSON.stringify(before)} got=${JSON.stringify(got)}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForTextChange(target: string, index: number, beforeText: string, timeout = 15_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const got = await costumeText(target, index)
    if (got !== beforeText) return got
    if (Date.now() - start > timeout) {
      throw new Error(`text change timeout ${target}[${index}] len=${beforeText.length}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForText(target: string, index: number, wantText: string, timeout = 15_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const got = await costumeText(target, index)
    if (got === wantText) return got
    if (Date.now() - start > timeout) {
      throw new Error(`text wait timeout ${target}[${index}] wantLen=${wantText.length} gotLen=${got.length}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function waitForPreview(expected: string, timeout = 10_000) {
  await page.waitForFunction((exp) => document.querySelector('.vector-preview')?.innerHTML === exp, expected, { timeout })
}

async function waitForPreviewChange(before: string, timeout = 15_000) {
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, before, { timeout })
}

async function selectCostumeByName(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).click()
  await page.waitForFunction(
    (n) => (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
      .project.targets.find((t: any) => t.name === 'Sprite1')
      ?.costumes.find((c: any) => c.name === n) !== undefined,
    name,
    { timeout: 10_000 },
  )
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 15_000 })
}

async function ensureVectorMode() {
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 })
}

async function selectSingleUnitByIndex(i: number) {
  await page.evaluate((idx: number) => {
    const buttons = Array.from(document.querySelectorAll('div.max-h-32 > button'))
    const btn = buttons[idx] as HTMLElement | undefined
    if (!btn) throw new Error(`unit button ${idx} missing (found ${buttons.length})`)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  }, i)
}

async function forceSelectCostume(name: string) {
  // Selecting the already-active costume does not switch slots, so a dirty
  // paint history would survive. Bounce through the other costume first so
  // every `it` starts from a cleared paint history (production CLEAR rule).
  const other = name === 'singular-scale0' ? 'normal-compare' : 'singular-scale0'
  await selectCostumeByName(other)
  await selectCostumeByName(name)
  await ensureVectorMode()
}

function paintSurfaceSeHandle() {
  // Two `Resize selected vector object se` buttons exist (legacy sidebar +
  // canvas overlay). The canvas overlay is the real pointer path: scope to
  // the paint surface like the overlay geometry does.
  return page.getByTestId('costume-paint-surface').locator('button[aria-label="Resize selected vector object se"]')
}

async function selectedOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline].border-blue-500').count()
}

async function outlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}

// The legacy sidebar hosts the vector action buttons below the fold
// (overflow layout, no native scroll in this harness), so a Playwright
// visibility click times out even though the handler is live. Dispatch the
// real click via evaluate like vector-multi-rotate-flip does: it still runs
// the production onclick path (peek->commit) without depending on scroll.
async function jsClickTitle(title: string) {
  await page.evaluate((t: string) => {
    const el = document.querySelector(`button[title="${t}"]`) as HTMLElement | null
    if (!el) throw new Error(`missing button title=${t}`)
    el.click()
  }, title)
}

async function jsClickAria(label: string) {
  await page.evaluate((l: string) => {
    const el = document.querySelector(`button[aria-label="${l}"]`) as HTMLElement | null
    if (!el) throw new Error(`missing button aria-label=${l}`)
    el.click()
  }, label)
}

async function isTitleEnabled(title: string): Promise<boolean> {
  return await page.evaluate((t: string) => {
    const el = document.querySelector(`button[title="${t}"]`) as HTMLButtonElement | null
    if (!el) throw new Error(`missing button title=${t}`)
    return !el.disabled
  }, title)
}

describe('singular vector history guard on the real Editor UI (peek/commit)', () => {
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
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
    // Real upload path: project sb3 through the real file input.
    await page.getByTestId('project-file-input').setInputFiles({
      name: 'singular-history.sb3',
      mimeType: 'application/x.scratch.sb3',
      buffer: buildSb3(),
    })
    await page.waitForFunction(
      () =>
        (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 2,
      null,
      { timeout: 20_000 },
    )
    await ensureVectorMode()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('singular costume: selection/move/keyboard/rotate/flip/align/grow leave VM bytes and Undo/Redo untouched (single-unit Paper paths fail closed)', async () => {
    await forceSelectCostume('singular-scale0')
    // Costume switch clears paint history: both stacks start disabled.
    await expectUndoEnabled(false)
    expect((await undoRedoDisabled()).redoDisabled).toBe(true)
    const text = await costumeText('Sprite1', 0)
    expect(text).toContain('scale(0)')
    const base = await costumeDigest('Sprite1', 0)
    const basePreview = await previewSvg()
    const baseFlags = await undoRedoDisabled()

    // selection via units list (production onclick path): no artwork rewrite.
    await selectSingleUnitByIndex(0)
    await page.waitForTimeout(500)
    expect(await costumeDigest('Sprite1', 0)).toEqual(base)
    expect(await previewSvg()).toBe(basePreview)
    expect(await undoRedoDisabled()).toEqual(baseFlags)

    // Ctrl+A multi-select: selection only, never a history entry.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(500)
    expect(await outlineCount()).toBeGreaterThanOrEqual(2)
    expect(await costumeDigest('Sprite1', 0)).toEqual(base)
    expect(await previewSvg()).toBe(basePreview)
    expect(await undoRedoDisabled()).toEqual(baseFlags)

    // keyboard nudge (peer of drag: moveVectorElementBy per unit, 4px step).
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(900)
    expect(await costumeDigest('Sprite1', 0)).toEqual(base)
    expect(await previewSvg()).toBe(basePreview)
    expect(await undoRedoDisabled()).toEqual(baseFlags)

    // sidebar move buttons (editVectorObject left/right/up/down).
    await jsClickTitle('Move the selection right')
    await page.waitForTimeout(900)
    expect(await costumeDigest('Sprite1', 0)).toEqual(base)
    expect(await previewSvg()).toBe(basePreview)
    expect(await undoRedoDisabled()).toEqual(baseFlags)

    // Rotate +15 on the multi-selection (arrangement path:
    // rotateVectorElementsAroundCenter refuses per unit under scale(0)).
    await jsClickTitle('Rotate the selection +15 degrees')
    await page.waitForTimeout(900)
    expect(await costumeDigest('Sprite1', 0)).toEqual(base)
    expect(await previewSvg()).toBe(basePreview)
    expect(await undoRedoDisabled()).toEqual(baseFlags)

    // Flip H on the multi-selection (arrangement path:
    // flipVectorElementsAroundCenter refuses per unit under scale(0)).
    await jsClickTitle('Flip the selection horizontally')
    await page.waitForTimeout(900)
    expect(await costumeDigest('Sprite1', 0)).toEqual(base)
    expect(await previewSvg()).toBe(basePreview)
    expect(await undoRedoDisabled()).toEqual(baseFlags)

    // Align L (multi Paper path: refused per unit under scale(0)).
    if (await isTitleEnabled('Align left edges')) {
      await jsClickTitle('Align left edges')
      await page.waitForTimeout(900)
      expect(await costumeDigest('Sprite1', 0)).toEqual(base)
      expect(await previewSvg()).toBe(basePreview)
      expect(await undoRedoDisabled()).toEqual(baseFlags)
    }

    // Single-unit Paper paths (scaleSelectedVectorObject ->
    // updateVectorObject -> applyPaperScale/Rotation/Flip): the ancestor,
    // world, and in-unit tryInvert guards refuse with no DOM/VM/selection/
    // history change. Exercise every button on a true single selection and
    // assert the full invariant (bytes + preview + Undo/Redo + selection).
    await selectSingleUnitByIndex(0)
    await page.waitForTimeout(500)
    const singleOutlines = await outlineCount()
    const singleTitles = [
      'Scale the selection up by 10%',
      'Scale the selection down by 10%',
      'Rotate the selection +15 degrees',
      'Rotate the selection -15 degrees',
      'Flip the selection horizontally',
      'Flip the selection vertically',
    ]
    for (const title of singleTitles) {
      await jsClickTitle(title)
      await page.waitForTimeout(900)
      expect(await costumeDigest('Sprite1', 0)).toEqual(base)
      expect(await previewSvg()).toBe(basePreview)
      expect(await undoRedoDisabled()).toEqual(baseFlags)
      expect(await outlineCount()).toBe(singleOutlines)
    }

    await page.keyboard.press('Escape')
  }, 120_000)

  it('singular costume: reshape-anchor and se-handle drags stay history-free (honest reachability)', async () => {
    await forceSelectCostume('singular-scale0')
    await expectUndoEnabled(false)
    const base = await costumeDigest('Sprite1', 0)
    const basePreview = await previewSvg()
    const baseFlags = await undoRedoDisabled()
    const reachability: Record<string, string> = {}

    // Reshape anchor drag on the path unit (document-order path index).
    const pathIndex = await page.evaluate(async () => {
      const { editableVectorUnits } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
      )
      const preview = document.querySelector('.vector-preview')?.innerHTML ?? ''
      const doc = new DOMParser().parseFromString(preview, 'image/svg+xml')
      const units = editableVectorUnits(doc.documentElement)
      return units.findIndex((el: Element) => el.tagName.toLowerCase() === 'path')
    })
    if (pathIndex >= 0) {
      await selectSingleUnitByIndex(pathIndex)
      await page.getByTestId('vector-shape-reshape').last().click()
      try {
        await page.locator('[data-vector-path-point]').first().waitFor({ state: 'visible', timeout: 5_000 })
      } catch {
        // No handles at all: unreachable, invariant below still holds.
      }
      // Hittability, not mere visibility: collapsed scale(0) geometry can
      // report a layout box that is clipped outside the panned surface
      // viewport (Playwright "visible" misses clipping), leaving no pointer
      // path to the handler.
      const hit = await hittableHandleCenter('[data-vector-path-point]')
      if (hit) {
        reachability['reshape-drag'] = 'verified: handle hittable, dragged, handler ran (status names reshape), still no history'
        const before = await previewSvg()
        await page.mouse.move(hit.x, hit.y)
        await page.mouse.down()
        await page.mouse.move(hit.x + 40, hit.y + 30, { steps: 10 })
        await page.mouse.up()
        await page.waitForTimeout(900)
        // Non-vacuous: the drag reached the Editor handler (status names the
        // reshape op) yet VM bytes are identical and Undo/Redo are untouched.
        expect(await editorStatus()).toMatch(/reshape/i)
        expect(await costumeDigest('Sprite1', 0)).toEqual(base)
        expect(await previewSvg()).toBe(before)
        expect(await undoRedoDisabled()).toEqual(baseFlags)
      } else {
        reachability['reshape-drag'] = 'unreachable: reshape handle not hittable under scale(0) (collapsed geometry renders it off the panned surface viewport; no pointer path exists); bytes/Undo invariant still holds'
        expect(await costumeDigest('Sprite1', 0)).toEqual(base)
        expect(await previewSvg()).toBe(basePreview)
        expect(await undoRedoDisabled()).toEqual(baseFlags)
      }
      await page.getByTestId('vector-shape-select').last().click()
      await page.keyboard.press('Escape')
    } else {
      reachability['reshape-drag'] = 'unreachable: no path unit in singular preview; bytes/Undo invariant still holds'
      expect(await costumeDigest('Sprite1', 0)).toEqual(base)
    }

    // Single se resize-handle drag (pointer path: begin/drag/end resize).
    await selectSingleUnitByIndex(0)
    await page.getByTestId('vector-shape-select').last().click()
    try {
      await paintSurfaceSeHandle().waitFor({ state: 'visible', timeout: 5_000 })
    } catch {
      // No handle at all: unreachable, invariant below still holds.
    }
    const seHit = await hittableHandleCenter('[data-testid="costume-paint-surface"] button[aria-label="Resize selected vector object se"]')
    if (seHit) {
      reachability['se-handle-drag'] = 'verified: se handle hittable, dragged, handler ran (status names resize), still no history'
      const before = await previewSvg()
      await page.mouse.move(seHit.x, seHit.y)
      await page.mouse.down()
      await page.mouse.move(seHit.x + 40, seHit.y + 30, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(900)
      // Non-vacuous: the drag reached the resize handler (status names the
      // resize op with no change) yet VM bytes/history are untouched.
      expect(await editorStatus()).toMatch(/resize/i)
      expect(await costumeDigest('Sprite1', 0)).toEqual(base)
      expect(await previewSvg()).toBe(before)
      expect(await undoRedoDisabled()).toEqual(baseFlags)
    } else {
      reachability['se-handle-drag'] = 'unreachable: se handle not hittable under scale(0) (collapsed geometry renders it off the panned surface viewport; no pointer path exists); bytes/Undo invariant still holds'
      expect(await costumeDigest('Sprite1', 0)).toEqual(base)
      expect(await undoRedoDisabled()).toEqual(baseFlags)
    }
    await page.keyboard.press('Escape')
    console.log(`SINGULAR reachability: ${JSON.stringify(reachability)} | notes: ${REACHABILITY_NOTES.join(' / ')}`)
    expect(Object.keys(reachability).length).toBe(2)
  }, 120_000)

  it('normal costume: each op applies and restores/exchanges in exactly one Undo/Redo step', async () => {
    await forceSelectCostume('normal-compare')
    await expectUndoEnabled(false)
    const applied: string[] = []

    async function roundTrip(label: string, act: () => Promise<void>) {
      // Text-exact: pure order ops (front/back/forward/backward) reorder
      // children, keeping the byte multiset (len+sum) identical while the
      // artwork really changed, so change/restore must compare full text.
      const beforeText = await costumeText('Sprite1', 1)
      const beforePreview = await previewSvg()
      await act()
      const afterText = await waitForTextChange('Sprite1', 1, beforeText)
      await waitForPreviewChange(beforePreview)
      expect(afterText).not.toBe(beforeText)
      expect(await previewSvg()).not.toBe(beforePreview)
      await expectUndoEnabled(true)
      applied.push(label)
      // Exactly one Undo restores the pre-op bytes AND preview.
      await clickUndoOnce()
      await waitForText('Sprite1', 1, beforeText)
      await waitForPreview(beforePreview)
      expect((await undoRedoDisabled()).redoDisabled).toBe(false)
      // Exactly one Redo reapplies the post-op bytes AND preview.
      const afterPreview = (await (async () => {
        await clickRedoOnce()
        const redone = await waitForText('Sprite1', 1, afterText)
        expect(redone).toBe(afterText)
        const preview = await previewSvg()
        return preview
      })())
      expect(afterPreview).not.toBe(beforePreview)
      await expectUndoEnabled(true)
    }

    // selection alone is a no-op (baseline for every op below).
    {
      const before = await costumeDigest('Sprite1', 1)
      const beforePreview = await previewSvg()
      await selectSingleUnitByIndex(0)
      await page.waitForTimeout(400)
      expect(await costumeDigest('Sprite1', 1)).toEqual(before)
      expect(await previewSvg()).toBe(beforePreview)
      await expectUndoEnabled(false)
    }

    // keyboard nudge (arrow key parity path).
    await selectSingleUnitByIndex(0)
    await page.getByTestId('vector-shape-select').last().click()
    await roundTrip('keyboard-nudge', async () => {
      await page.keyboard.press('ArrowRight')
    })

    // sidebar move button.
    await selectSingleUnitByIndex(0)
    await roundTrip('move-button', async () => {
      await jsClickTitle('Move the selection right')
    })

    // Grow resize (deterministic resize path).
    await selectSingleUnitByIndex(0)
    await roundTrip('resize-grow', async () => {
      await jsClickTitle('Scale the selection up by 10%')
    })

    // se resize-handle pointer drag through the shared-bounds union handle
    // (the proven real-UI handle path from vector-multi-scale-editor:
    // multi-select -> union `Resize vector selection se` -> 70,40 drag).
    // The single-unit overlay handle has no proven mouse-driven precedent in
    // this harness, so the union handle carries the required resize round-trip.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    {
      const unionSe = page
        .getByTestId('costume-paint-surface')
        .locator('button[aria-label="Resize vector selection se"]')
      await unionSe.waitFor({ state: 'visible', timeout: 10_000 })
      const box = await unionSe.boundingBox()
      if (!box) throw new Error('union se handle has no box on normal artwork')
      const before = await costumeDigest('Sprite1', 1)
      const beforePreview = await previewSvg()
      // Handles may render below the fold of the 1400x900 viewport (the
      // paint surface is taller than the window): scroll the handle on-screen
      // first, otherwise the mouse events land on <html> and no drag starts.
      await unionSe.scrollIntoViewIfNeeded()
      const onScreen = await unionSe.boundingBox()
      if (!onScreen) throw new Error('union se handle lost after scroll')
      const hx = onScreen.x + onScreen.width / 2
      const hy = onScreen.y + onScreen.height / 2
      await page.mouse.move(hx, hy)
      await page.mouse.down()
      await page.mouse.move(hx + 70, hy + 40, { steps: 12 })
      await page.mouse.up()
      const after = await waitForDigestChange('Sprite1', 1, before)
      await waitForPreviewChange(beforePreview)
      await expectUndoEnabled(true)
      applied.push('resize-handle-drag')
      await clickUndoOnce()
      await waitForDigest('Sprite1', 1, before)
      await waitForPreview(beforePreview)
      await clickRedoOnce()
      await waitForDigest('Sprite1', 1, after)
    }

    // Rotate +15.
    await selectSingleUnitByIndex(0)
    await roundTrip('rotate', async () => {
      await jsClickTitle('Rotate the selection +15 degrees')
    })

    // Flip H.
    await selectSingleUnitByIndex(0)
    await roundTrip('flip', async () => {
      await jsClickTitle('Flip the selection horizontally')
    })

    // Reshape anchor drag on a freshly drawn rect (real reshape-tool drag).
    // The uploaded path's anchors can sit outside the panned surface viewport
    // (harness pan state), so draw at the surface center like
    // vector-reshape-points does: the new rect is top-level (no singular
    // ancestor), its anchors are on-screen, and the drag exercises the real
    // moveVectorReshapePoints peek->commit path with 1-step Undo/Redo.
    {
      await page.getByTestId('vector-shape-rect').last().click()
      const surfaceBox = await page.getByTestId('costume-paint-surface').boundingBox()
      if (!surfaceBox) throw new Error('Missing paint surface bounds')
      const scx = surfaceBox.x + surfaceBox.width / 2
      const scy = surfaceBox.y + surfaceBox.height / 2
      const drawnBefore = await previewSvg()
      await page.mouse.move(scx - 110, scy - 60)
      await page.mouse.down()
      await page.mouse.move(scx + 110, scy + 60, { steps: 12 })
      await page.mouse.up()
      await waitForPreviewChange(drawnBefore)
      await page.getByTestId('vector-shape-reshape').last().click()
      const handles = page.locator('[data-vector-path-point]')
      await handles.first().waitFor({ state: 'visible', timeout: 10_000 })
      const hit = await hittableHandleCenter('[data-vector-path-point]')
      if (!hit) throw new Error('drawn rect reshape handle not hittable (surface layout changed?)')
      const before = await costumeDigest('Sprite1', 1)
      const beforePreview = await previewSvg()
      await page.mouse.move(hit.x, hit.y)
      await page.mouse.down()
      await page.mouse.move(hit.x + 40, hit.y + 30, { steps: 10 })
      await page.mouse.up()
      const after = await waitForDigestChange('Sprite1', 1, before)
      await waitForPreviewChange(beforePreview)
      await expectUndoEnabled(true)
      applied.push('reshape-drag')
      await clickUndoOnce()
      await waitForDigest('Sprite1', 1, before)
      await waitForPreview(beforePreview)
      await clickRedoOnce()
      await waitForDigest('Sprite1', 1, after)
      await page.getByTestId('vector-shape-select').last().click()
      await page.keyboard.press('Escape')
    }

    // Group (multi-select) + Ungroup + Align + Duplicate + order.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
      null,
      { timeout: 10_000 },
    )
    await roundTrip('group', async () => {
      await jsClickTitle('Group the selected objects')
    })
    await roundTrip('ungroup', async () => {
      await jsClickTitle('Ungroup the selected group')
    })
    // Align needs a spread selection; the fixture rects start at x=40/220.
    await page.keyboard.press('Control+a')
    await roundTrip('align-left', async () => {
      await jsClickTitle('Align left edges')
    })
    // Duplicate the first unit, then bring it to front (order).
    await selectSingleUnitByIndex(0)
    await roundTrip('duplicate', async () => {
      await jsClickAria('Duplicate selection')
    })
    await selectSingleUnitByIndex(0)
    await roundTrip('order-front', async () => {
      await jsClickAria('Bring to front')
    })

    console.log(`NORMAL applied with 1-step Undo/Redo: ${applied.join(',')}`)
    expect(applied).toEqual([
      'keyboard-nudge',
      'move-button',
      'resize-grow',
      'resize-handle-drag',
      'rotate',
      'flip',
      'reshape-drag',
      'group',
      'ungroup',
      'align-left',
      'duplicate',
      'order-front',
    ])
    await page.keyboard.press('Escape')
  }, 180_000)
})
