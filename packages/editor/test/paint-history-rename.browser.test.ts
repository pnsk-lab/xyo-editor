import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync, zlibSync } from 'fflate'
import { type Browser, type Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real Editor + real VM rename x paint-history regression (NEW, product untouched).
//
// Covers the direct agent change (Editor.svelte + paint-history-rename.ts):
// rename strips `name` from history restore patches, and a user UI rename
// adopts the post-rename identity/gesture only when no unseen drift landed
// before it. Verified through the real UI (brush/rect drags, costume-card
// rename inputs, Undo/Redo buttons, target/costume switches, project reload)
// against real asset bytes (vm.loadAsset digests), real canvas pixels, real
// preview SVG, rotationCenter, names, and selection.
//
// API-only external simulation (no direct plain-object mutation bypass):
// every "external" write goes through vm.updateCostume /
// vm.updateCostumeIfMatch / vm.renameCostume / file-input reload. Direct
// `target.costumes[i].x = ...` mutation is never used.
//
// Verdict policy: assertions describe CORRECT behaviour. A reproduced product
// bug FAILS loudly (left failing + reported, never silenced). Setups that
// cannot run report the reason as a failure with context.
const root = join(import.meta.dir, '..')
const PORT = 4262
const base = `http://127.0.0.1:${PORT}/test/paint-history-rename-fixture.html`
let server: ChildProcessWithoutNullStreams | undefined
let browser: Browser | undefined
const diagnostics: string[] = []

// --- deterministic asset builders (no product imports) ---------------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)))
  return out
}

function solidPng(r: number, g: number, b: number, width = 32, height = 32): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0
    for (let x = 0; x < width; x += 1) {
      const o = y * (1 + width * 4) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = 255
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const idat = zlibSync(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const rectSvg = (x: number, y: number, w: number, h: number, fill: string) =>
  `${HEAD}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#111111" stroke-width="2"/></svg>`
const VEC_V = `${HEAD}<rect x="150" y="120" width="140" height="110" fill="#2ecc71" stroke="#111111" stroke-width="2"/></svg>`
const TWIN_RED = rectSvg(120, 100, 120, 90, '#e74c3c')
const TWIN_BLUE = rectSvg(220, 150, 100, 70, '#2980b9')

function buildSb3(): Buffer {
  const files: Record<string, Uint8Array> = {}
  const addBytes = (bytes: Uint8Array, ext: string) => {
    const hash = md5(bytes)
    const md5ext = `${hash}.${ext}`
    files[md5ext] = bytes
    return { assetId: hash, md5ext }
  }
  const addText = (text: string) => addBytes(new TextEncoder().encode(text), 'svg')
  const pngA = addBytes(solidPng(255, 255, 255), 'png')
  const pngS2 = addBytes(solidPng(200, 220, 255), 'png')
  const pngStage = addBytes(solidPng(240, 240, 240), 'png')
  const vecV = addText(VEC_V)
  const twinRed = addText(TWIN_RED)
  const twinBlue = addText(TWIN_BLUE)
  const costume = (ref: { assetId: string; md5ext: string }, name: string, extra: Record<string, unknown>) => ({
    name,
    ...ref,
    ...extra,
  })
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [
          costume(pngStage, 'backdrop', { dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }),
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
      },
      {
        id: 'sprite1',
        isStage: false,
        name: 'Sprite1',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [
          costume(pngA, 'costumeA', { dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 16, rotationCenterY: 16 }),
          costume(vecV, 'costumeV', { dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }),
        ],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
      },
      {
        id: 'sprite2',
        isStage: false,
        name: 'Sprite2',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [
          costume(pngS2, 'costumeS2', { dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 16, rotationCenterY: 16 }),
        ],
        sounds: [],
        volume: 100,
        layerOrder: 2,
        visible: true,
        x: 100,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
      },
      {
        id: 'twinA',
        isStage: false,
        name: 'Twin',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [costume(twinRed, 'twin-red', { dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 })],
        sounds: [],
        volume: 100,
        layerOrder: 3,
        visible: true,
        x: -80,
        y: 20,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
      },
      {
        id: 'twinB',
        isStage: false,
        name: 'Twin',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [costume(twinBlue, 'twin-blue', { dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 })],
        sounds: [],
        volume: 100,
        layerOrder: 4,
        visible: true,
        x: 80,
        y: -20,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: 'paint-rename', agent: 'paint-rename' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

// --- page helpers (real UI + real bytes/pixels) -----------------------------

async function newSeededPage(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) diagnostics.push(`console: ${message.text()}`)
  })
  await page.goto(base)
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20000 })
  await page.getByTestId('project-file-input').setInputFiles({
    name: 'rename.sb3',
    mimeType: 'application/x.scratch.sb3',
    buffer: buildSb3(),
  })
  await page.waitForFunction(
    () =>
      (window as any).__hikkakuEditorTest
        ?.snapshot()
        .project.targets.find((t: any) => t.id === 'sprite1')?.costumes.length === 2 &&
      (window as any).__hikkakuEditorTest?.snapshot().project.targets.filter((t: any) => t.name === 'Twin').length === 2,
    null,
    { timeout: 20000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!c || c.offsetParent === null) return true
    try {
      const ctx = c.getContext('2d')
      if (!ctx) return false
      const img = ctx.getImageData(0, 0, c.width, c.height)
      for (let i = 3; i < img.data.length; i += 4) if ((img.data[i] ?? 0) !== 0) return true
      return false
    } catch { return false }
  }, undefined, { timeout: 20000 })
  return page
}

type Digest = { len: number; sum: number; md5ext: string; dataFormat: string; name: string; rcx: number; rcy: number; res?: number } | null

async function costumeDigest(page: Page, targetId: string, index: number): Promise<Digest> {
  return await page.evaluate(async ({ targetId, index }) => {
    const vm = (window as any).__paintHistoryRenameVm ?? (window as any).__paintHistoryVm
    const t = vm.getTarget(targetId)
    const c = t?.costumes[index]
    const key = c?.md5ext ?? c?.assetId
    const bytes = key ? await vm.loadAsset(key, c.dataFormat ?? '') : undefined
    if (!bytes) return null
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    return {
      len: (bytes as Uint8Array).length,
      sum,
      md5ext: c.md5ext,
      dataFormat: c.dataFormat,
      name: c.name,
      rcx: c.rotationCenterX,
      rcy: c.rotationCenterY,
      res: c.bitmapResolution,
    }
  }, { targetId, index })
}

async function slotIdentity(page: Page, targetId: string, index: number) {
  return await page.evaluate(async ({ targetId, index }) => {
    const vm = (window as any).__paintHistoryRenameVm ?? (window as any).__paintHistoryVm
    return vm.getCostumeIdentity ? vm.getCostumeIdentity(targetId, index) : { writeSeq: vm.getCostumeWriteSeq?.(targetId, index) ?? 0 }
  }, { targetId, index })
}

async function snapshotOf(page: Page): Promise<any> {
  return await page.evaluate(() => (window as any).__hikkakuEditorTest?.snapshot())
}

async function selectedOf(page: Page): Promise<{ targetId: string; index: number }> {
  const snap = await snapshotOf(page)
  const target = snap.project.targets.find((t: any) => t.id === snap.selectedTargetId || t.name === snap.selectedTargetId)
  return { targetId: target?.id ?? snap.selectedTargetId, index: target?.currentCostume ?? 0 }
}

async function canvasDigest(page: Page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas || canvas.offsetParent === null) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const w = Math.min(200, canvas.width)
    const h = Math.min(200, canvas.height)
    const x = Math.floor((canvas.width - w) / 2)
    const y = Math.floor((canvas.height - h) / 2)
    const d = ctx.getImageData(x, y, w, h).data
    let sum = 0
    let opaque = 0
    for (let i = 0; i < d.length; i += 4) {
      sum = (sum + d[i]! + d[i + 1]! + d[i + 2]! + d[i + 3]!) >>> 0
      if (d[i + 3]! > 10) opaque += 1
    }
    return { sum, opaque, w, h }
  })
}

async function previewSvg(page: Page): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function statusOf(page: Page): Promise<string> {
  return await page.evaluate(() => (window as any).__hikkakuEditorTest?.status?.() ?? '')
}

async function undoRedoEnabled(page: Page): Promise<{ undo: boolean; redo: boolean }> {
  return await page.evaluate(() => {
    const visible = (label: string) =>
      Array.from(document.querySelectorAll(`button[aria-label="${label}"]`)).filter(
        (b) => (b as HTMLElement).offsetParent !== null,
      ) as HTMLButtonElement[]
    return { undo: visible('Undo').some((b) => !b.disabled), redo: visible('Redo').some((b) => !b.disabled) }
  })
}

async function expectUndo(page: Page, enabled: boolean) {
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
    { timeout: 10000 },
  )
  const state = await undoRedoEnabled(page)
  expect(state.undo).toBe(enabled)
}

async function clickUndo(page: Page) {
  await page.waitForFunction(
    () =>
      (Array.from(document.querySelectorAll('button[aria-label="Undo"]')) as HTMLButtonElement[]).some(
        (b) => (b as HTMLElement).offsetParent !== null && !(b as HTMLButtonElement).disabled,
      ),
    null,
    { timeout: 10000 },
  )
  const buttons = page.getByRole('button', { name: 'Undo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) {
      await b.click()
      await page.waitForFunction(
        () => ((window as any).__hikkakuEditorTest?.status?.() || '').toLowerCase().includes('undo'),
        null,
        { timeout: 10000 },
      )
      return
    }
  }
  throw new Error('No enabled visible Undo button')
}

async function clickRedo(page: Page) {
  await page.waitForFunction(
    () =>
      (Array.from(document.querySelectorAll('button[aria-label="Redo"]')) as HTMLButtonElement[]).some(
        (b) => (b as HTMLElement).offsetParent !== null && !(b as HTMLButtonElement).disabled,
      ),
    null,
    { timeout: 10000 },
  )
  const buttons = page.getByRole('button', { name: 'Redo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) {
      await b.click()
      await page.waitForFunction(
        () => ((window as any).__hikkakuEditorTest?.status?.() || '').toLowerCase().includes('redo'),
        null,
        { timeout: 10000 },
      )
      return
    }
  }
  throw new Error('No enabled visible Redo button')
}

async function brushStroke(page: Page) {
  await page.getByTestId('bitmap-tool-brush').click()
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing paint canvas bounds')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx - 50, cy - 20)
  await page.mouse.down()
  await page.mouse.move(cx + 50, cy - 20, { steps: 12 })
  await page.mouse.move(cx + 50, cy + 40, { steps: 6 })
  await page.mouse.up()
}

async function vectorRectDraw(page: Page) {
  await page.getByTestId('main-tab-costumes').click()
  const before = await previewSvg(page).catch(() => '')
  await page.getByTestId('vector-shape-rect').last().click()
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing vector paint surface bounds')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx - 110, cy - 60)
  await page.mouse.down()
  await page.mouse.move(cx + 110, cy + 60, { steps: 12 })
  await page.mouse.up()
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, before, { timeout: 20000 })
  await page.getByTestId('vector-shape-select').last().click()
  await page.waitForTimeout(500)
}

async function renameViaUICard(page: Page, cardIndex: number, newName: string, oldName?: string) {
  const card = page.getByTestId(`costume-card-${cardIndex}`)
  const input = card.locator('input').first()
  await input.waitFor({ state: 'visible', timeout: 10000 })
  if (oldName) expect(await input.getAttribute('aria-label')).toBe(`Rename ${oldName}`)
  await input.fill(newName)
  await input.press('Tab')
  await page.waitForFunction(
    ({ idx, want }) =>
      (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.id === 'sprite1')
        ?.costumes[idx]?.name === want,
    { idx: cardIndex, want: newName },
    { timeout: 10000 },
  )
}

async function waitCostumeMd5(page: Page, targetId: string, index: number, md5ext: string) {
  await page.waitForFunction(
    ({ targetId, index, md5ext }) => {
      const snap = (window as any).__hikkakuEditorTest?.snapshot()
      const t = snap?.project.targets.find((x: any) => x.id === targetId || x.name === targetId)
      return t?.costumes[index]?.md5ext !== md5ext
    },
    { targetId, index, md5ext },
    { timeout: 15000 },
  )
}

async function waitForDigest(page: Page, targetId: string, index: number, want: { len: number; sum: number }, timeout = 15000) {
  const start = Date.now()
  for (;;) {
    const got = await costumeDigest(page, targetId, index)
    if (got && got.len === want.len && got.sum === want.sum) return got
    if (Date.now() - start > timeout) {
      const status = await statusOf(page)
      throw new Error(`digest wait timeout target=${targetId} index=${index} want=${JSON.stringify(want)} got=${JSON.stringify(got)} status=${status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

async function selectCostumeCard(page: Page, index: number, name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).click()
  await page.waitForFunction(
    (want) =>
      (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.id === 'sprite1')
        ?.currentCostume === want,
    index,
    { timeout: 10000 },
  )
  await page.waitForTimeout(600)
}

// External writes: VM public API only (queue + writeSeq), never direct mutation.
async function apiUpdateCostume(page: Page, targetId: string, index: number, patch: Record<string, unknown>, bytes?: { text?: string; colorSwap?: { from: string; to: string } }) {
  return await page.evaluate(async ({ targetId, index, patch, bytes }) => {
    const vm = (window as any).__paintHistoryRenameVm ?? (window as any).__paintHistoryVm
    const t = vm.getTarget(targetId)
    const c = t?.costumes[index]
    let data: Uint8Array | undefined
    if (bytes?.text) data = new TextEncoder().encode(bytes.text)
    else if (bytes?.colorSwap) {
      const cur = c
      const key = cur?.md5ext ?? cur?.assetId
      const curBytes = (await vm.loadAsset(key, cur?.dataFormat ?? '')) as Uint8Array
      const curText = new TextDecoder().decode(curBytes)
      data = new TextEncoder().encode(curText.replaceAll(bytes.colorSwap.from, bytes.colorSwap.to))
    }
    await vm.updateCostume(targetId, index, patch, data)
    return true
  }, { targetId, index, patch, bytes })
}

async function apiRename(page: Page, targetId: string, index: number, name: string) {
  return await page.evaluate(async ({ targetId, index, name }) => {
    const vm = (window as any).__paintHistoryRenameVm ?? (window as any).__paintHistoryVm
    return vm.renameCostume(targetId, index, name)
  }, { targetId, index, name })
}

describe('paint history rename in the real editor', () => {
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
  }, 30000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    if (diagnostics.length) console.log(`Browser diagnostics:\n${diagnostics.join('\n')}`)
  })

  it('bitmap draw -> UI rename -> Undo -> Redo keeps the new name and rewinds bytes/pixels/center/selection', async () => {
    const page = await newSeededPage()
    try {
      const before = (await costumeDigest(page, 'sprite1', 0))!
      expect(before).not.toBeNull()
      expect(before!.name).toBe('costumeA')
      expect(before!.rcx).toBe(16)
      expect(before!.rcy).toBe(16)
      const pixelsBefore = (await canvasDigest(page))!
      const selBefore = await selectedOf(page)
      expect(selBefore.targetId).toBe('sprite1')
      expect(selBefore.index).toBe(0)

      await brushStroke(page)
      await waitCostumeMd5(page, 'sprite1', 0, before!.md5ext)
      const edited = (await costumeDigest(page, 'sprite1', 0))!
      const pixelsEdited = (await canvasDigest(page))!
      expect(edited.sum).not.toBe(before!.sum)
      expect(pixelsEdited!.sum).not.toBe(pixelsBefore!.sum)
      await expectUndo(page, true)

      // Real UI rename (sidebar input, not prompt / not VM-direct).
      await renameViaUICard(page, 0, 'costumeA-renamed', 'costumeA')
      const renamed = (await costumeDigest(page, 'sprite1', 0))!
      expect(renamed.name).toBe('costumeA-renamed')
      expect(renamed.sum).toBe(edited.sum)
      expect(renamed.len).toBe(edited.len)
      // Paint saves re-trim the artboard, so the rotation center follows the
      // edited artwork (not the pre-stroke value); the rename must not touch it.
      expect(renamed.rcx).toBe(edited.rcx)
      expect(renamed.rcy).toBe(edited.rcy)
      await expectUndo(page, true)

      await clickUndo(page)
      const undone = await waitForDigest(page, 'sprite1', 0, before!)
      expect(undone.name).toBe('costumeA-renamed')
      expect(undone.rcx).toBe(before!.rcx)
      expect(undone.rcy).toBe(before!.rcy)
      const selAfterUndo = await selectedOf(page)
      expect(selAfterUndo).toEqual({ targetId: 'sprite1', index: 0 })
      const stateAfterUndo = await undoRedoEnabled(page)
      expect(stateAfterUndo.redo).toBe(true)

      await clickRedo(page)
      const redone = await waitForDigest(page, 'sprite1', 0, edited)
      expect(redone.name).toBe('costumeA-renamed')
      expect(redone.rcx).toBe(edited.rcx)
      expect(redone.rcy).toBe(edited.rcy)
      const selAfterRedo = await selectedOf(page)
      expect(selAfterRedo).toEqual({ targetId: 'sprite1', index: 0 })
      const pixelsRedone = (await canvasDigest(page))!
      expect(pixelsRedone!.sum).toBe(pixelsEdited!.sum)
    } finally {
      await page.close()
    }
  }, 90000)

  it('vector draw -> UI rename -> Undo -> Redo keeps the new name and rewinds bytes/svg/center/selection', async () => {
    const page = await newSeededPage()
    try {
      await selectCostumeCard(page, 1, 'costumeV')
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20000 })
      const before = (await costumeDigest(page, 'sprite1', 1))!
      expect(before!.name).toBe('costumeV')
      expect(before!.dataFormat).toBe('svg')
      const svgBefore = await previewSvg(page)
      const selBefore = await selectedOf(page)
      expect(selBefore).toEqual({ targetId: 'sprite1', index: 1 })

      await vectorRectDraw(page)
      await waitCostumeMd5(page, 'sprite1', 1, before!.md5ext)
      const edited = (await costumeDigest(page, 'sprite1', 1))!
      const svgEdited = await previewSvg(page)
      expect(svgEdited).not.toBe(svgBefore)
      expect(edited.sum).not.toBe(before!.sum)
      await expectUndo(page, true)

      await renameViaUICard(page, 1, 'costumeV-renamed', 'costumeV')
      const renamed = (await costumeDigest(page, 'sprite1', 1))!
      expect(renamed.name).toBe('costumeV-renamed')
      expect(renamed.sum).toBe(edited.sum)
      // Vector saves re-derive rotationCenter/viewBox from the artwork; the
      // rename must preserve the edited geometry, not the pre-draw value.
      expect(renamed.rcx).toBe(edited.rcx)
      expect(renamed.rcy).toBe(edited.rcy)
      await expectUndo(page, true)

      await clickUndo(page)
      const undone = await waitForDigest(page, 'sprite1', 1, before!)
      expect(undone.name).toBe('costumeV-renamed')
      expect(undone.rcx).toBe(before!.rcx)
      expect(undone.rcy).toBe(before!.rcy)
      const svgUndone = await previewSvg(page)
      expect(svgUndone).toBe(svgBefore)
      expect(await selectedOf(page)).toEqual({ targetId: 'sprite1', index: 1 })

      await clickRedo(page)
      const redone = await waitForDigest(page, 'sprite1', 1, edited)
      expect(redone.name).toBe('costumeV-renamed')
      expect(await previewSvg(page)).toBe(svgEdited)
      expect(await selectedOf(page)).toEqual({ targetId: 'sprite1', index: 1 })
    } finally {
      await page.close()
    }
  }, 90000)

  it('external metadata-only center write before UI rename stays fail-closed on Undo', async () => {
    const page = await newSeededPage()
    try {
      const before = (await costumeDigest(page, 'sprite1', 0))!
      await brushStroke(page)
      await waitCostumeMd5(page, 'sprite1', 0, before!.md5ext)
      const edited = (await costumeDigest(page, 'sprite1', 0))!
      await expectUndo(page, true)

      // External metadata-only drift via the public VM queue (same bytes hash
      // family, new rotation center, bumped writeSeq).
      await apiUpdateCostume(page, 'sprite1', 0, { rotationCenterX: 111, rotationCenterY: 222 })
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.id === 'sprite1')
            ?.costumes[0]?.rotationCenterX === 111,
        null,
        { timeout: 10000 },
      )
      const external = (await costumeDigest(page, 'sprite1', 0))!
      expect(external.rcx).toBe(111)
      expect(external.rcy).toBe(222)

      // User rename after unseen drift: adoption must refuse (fail-closed).
      await renameViaUICard(page, 0, 'costumeA-after-external', 'costumeA')
      const renamedExternal = (await costumeDigest(page, 'sprite1', 0))!
      expect(renamedExternal.name).toBe('costumeA-after-external')
      expect(renamedExternal.rcx).toBe(111)

      await clickUndo(page)
      // Fail-closed: external bytes/center kept, new name kept, stacks intact.
      await page.waitForFunction(
        () => ((window as any).__hikkakuEditorTest?.status?.() || '').includes('External costume change kept'),
        null,
        { timeout: 10000 },
      )
      const kept = (await costumeDigest(page, 'sprite1', 0))!
      expect(kept.sum).toBe(renamedExternal.sum)
      expect(kept.len).toBe(renamedExternal.len)
      expect(kept.name).toBe('costumeA-after-external')
      expect(kept.rcx).toBe(111)
      expect(kept.rcy).toBe(222)
      // Stacks intact: Undo still offered (refuses again), Redo untouched.
      await expectUndo(page, true)
      const status = await statusOf(page)
      expect(status).toContain('External costume change kept')
    } finally {
      await page.close()
    }
  }, 90000)

  it('external API rename during gated Undo fails closed and keeps the external name', async () => {
    const page = await newSeededPage()
    try {
      const before = (await costumeDigest(page, 'sprite1', 0))!
      await brushStroke(page)
      await waitCostumeMd5(page, 'sprite1', 0, before!.md5ext)
      const edited = (await costumeDigest(page, 'sprite1', 0))!
      await expectUndo(page, true)
      await renameViaUICard(page, 0, 'costumeA-user', 'costumeA')

      // Concurrent external rename through the VM API (bumps writeSeq without
      // Editor adoption): the gated Undo must keep it instead of clobbering.
      await apiRename(page, 'sprite1', 0, 'costumeA-external')
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.id === 'sprite1')
            ?.costumes[0]?.name === 'costumeA-external',
        null,
        { timeout: 10000 },
      )

      await clickUndo(page)
      await page.waitForFunction(
        () => ((window as any).__hikkakuEditorTest?.status?.() || '').includes('External costume change kept'),
        null,
        { timeout: 10000 },
      )
      const kept = (await costumeDigest(page, 'sprite1', 0))!
      expect(kept.name).toBe('costumeA-external')
      expect(kept.sum).toBe(edited.sum)
      // Redo path is gated by the same pre-check: it must also refuse.
      const state = await undoRedoEnabled(page)
      expect(state.undo).toBe(true)
    } finally {
      await page.close()
    }
  }, 90000)

  it('gated vector drag: mid-drag and in-flight UI renames commit once with the new name; history cancel keeps it', async () => {
    const page = await newSeededPage()
    try {
      await selectCostumeCard(page, 1, 'costumeV')
      await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20000 })
      const before = (await costumeDigest(page, 'sprite1', 1))!
      const svgBefore = await previewSvg(page)

      // Commit leg: start a rect drag, rename mid-gesture through the real
      // sidebar input, then finish the drag. The rename and the paint commute
      // (disjoint fields), so the commit must land once with the new name.
      await page.getByTestId('vector-shape-rect').last().click()
      const box = (await page.getByTestId('costume-paint-surface').boundingBox())!
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx - 110, cy - 60)
      await page.mouse.down()
      await page.mouse.move(cx, cy, { steps: 6 })
      await renameViaUICard(page, 1, 'costumeV-middrag', 'costumeV')
      await page.mouse.move(cx + 110, cy + 60, { steps: 6 })
      await page.mouse.up()
      await waitCostumeMd5(page, 'sprite1', 1, before!.md5ext)
      const committed = (await costumeDigest(page, 'sprite1', 1))!
      expect(committed.name).toBe('costumeV-middrag')
      expect(committed.sum).not.toBe(before!.sum)
      await expectUndo(page, true)
      // Exactly one history entry: a single Undo returns to pre-drag bytes
      // while keeping the mid-drag name.
      await clickUndo(page)
      const undone = await waitForDigest(page, 'sprite1', 1, before!)
      expect(undone.name).toBe('costumeV-middrag')
      // Redo restores the committed drag bytes, still under the renamed name.
      await clickRedo(page)
      const redone = await waitForDigest(page, 'sprite1', 1, committed)
      expect(redone.name).toBe('costumeV-middrag')

      // Gated leg: rename inside the async commit window (pointerup fired,
      // save still draining through the slot gate). Both must survive: the
      // bytes commit once and the renamed name is kept.
      await page.getByTestId('vector-shape-rect').last().click()
      await page.mouse.move(cx - 100, cy - 55)
      await page.mouse.down()
      await page.mouse.move(cx + 100, cy + 55, { steps: 10 })
      await page.mouse.up()
      // No wait: rename synchronously inside the save window via the real UI.
      await renameViaUICard(page, 1, 'costumeV-gated', 'costumeV-middrag')
      // The gated save lands after the rename: md5 must move off the redone
      // bytes exactly once.
      await waitCostumeMd5(page, 'sprite1', 1, redone.md5ext)
      const gated = (await costumeDigest(page, 'sprite1', 1))!
      expect(gated).not.toBeNull()
      expect(gated!.name).toBe('costumeV-gated')
      expect(gated!.sum).not.toBe(redone.sum)
      // The gated commit is exactly one more history entry: Undo rewinds its
      // bytes while the gated name survives (history cancel keeps rename).
      await expectUndo(page, true)
      await clickUndo(page)
      const gatedUndone = await waitForDigest(page, 'sprite1', 1, { len: redone.len, sum: redone.sum })
      expect(gatedUndone.name).toBe('costumeV-gated')
      // Redo re-applies the gated bytes under the same name.
      await clickRedo(page)
      const gatedRedone = await waitForDigest(page, 'sprite1', 1, { len: gated!.len, sum: gated!.sum })
      expect(gatedRedone.name).toBe('costumeV-gated')
      expect(await previewSvg(page)).not.toBe(svgBefore)
    } finally {
      await page.close()
    }
  }, 120000)

  it('selection changes, reload, store failure, same-name and other-slot renames isolate correctly', async () => {
    const page = await newSeededPage()
    try {
      // Baseline draw + UI rename on sprite1 slot 0.
      const before = (await costumeDigest(page, 'sprite1', 0))!
      await brushStroke(page)
      await waitCostumeMd5(page, 'sprite1', 0, before!.md5ext)
      const edited = (await costumeDigest(page, 'sprite1', 0))!
      await renameViaUICard(page, 0, 'costumeA-scoped', 'costumeA')

      // Other-slot rename (same target, slot 1) via API must not disturb slot 0.
      await apiRename(page, 'sprite1', 1, 'costumeV-other')
      const slot1 = (await costumeDigest(page, 'sprite1', 1))!
      expect(slot1.name).toBe('costumeV-other')
      const slot0 = (await costumeDigest(page, 'sprite1', 0))!
      expect(slot0.name).toBe('costumeA-scoped')
      expect(slot0.sum).toBe(edited.sum)
      await expectUndo(page, true)
      await clickUndo(page)
      const undone = await waitForDigest(page, 'sprite1', 0, before!)
      expect(undone.name).toBe('costumeA-scoped')
      await clickRedo(page)
      await waitForDigest(page, 'sprite1', 0, edited)

      // Same display name, different stable id: renaming twinB must not steer
      // twinA history or bytes (stable-id only, never the name alias).
      const twinABefore = (await costumeDigest(page, 'twinA', 0))!
      const twinBBefore = (await costumeDigest(page, 'twinB', 0))!
      expect(twinABefore).not.toBeNull()
      expect(twinBBefore).not.toBeNull()
      expect(twinABefore!.sum).not.toBe(twinBBefore!.sum)
      await apiRename(page, 'twinB', 0, 'Twin-renamed-B')
      const twinBAfter = (await costumeDigest(page, 'twinB', 0))!
      const twinAAfter = (await costumeDigest(page, 'twinA', 0))!
      expect(twinBAfter.name).toBe('Twin-renamed-B')
      expect(twinBAfter.sum).toBe(twinBBefore!.sum)
      expect(twinAAfter.name).toBe('twin-red')
      expect(twinAAfter.sum).toBe(twinABefore!.sum)
      // Original slot still undoes under its own renamed name.
      await page.getByTestId('main-tab-costumes').click()
      await expectUndo(page, true)

      // Costume switch clears the paint scope: Undo disabled, renamed bytes stay.
      await selectCostumeCard(page, 1, 'costumeV-other')
      await expectUndo(page, false)
      const afterSwitch = (await costumeDigest(page, 'sprite1', 1))!
      expect(afterSwitch.name).toBe('costumeV-other')

      // Target switch also clears: select Sprite2 via the real sprite pane.
      await page.getByTestId('target-card-Sprite2').click()
      await page.waitForFunction(
        () => {
          const s = (window as any).__hikkakuEditorTest?.snapshot()
          const t = s?.project.targets.find((x: any) => x.id === s?.selectedTargetId || x.name === s?.selectedTargetId)
          return t?.name === 'Sprite2'
        },
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)

      // Back on sprite1 slot 0: renamed bytes persist, history stays cleared.
      await page.getByTestId('target-card-Sprite1').click()
      await page.waitForFunction(
        () => {
          const s = (window as any).__hikkakuEditorTest?.snapshot()
          const t = s?.project.targets.find((x: any) => x.id === s?.selectedTargetId || x.name === s?.selectedTargetId)
          return t?.name === 'Sprite1'
        },
        null,
        { timeout: 10000 },
      )
      await page.getByTestId('main-tab-costumes').click()
      await selectCostumeCard(page, 0, 'costumeA-scoped')
      const back = (await costumeDigest(page, 'sprite1', 0))!
      expect(back.name).toBe('costumeA-scoped')
      expect(back.sum).toBe(edited.sum)
      await expectUndo(page, false)

      // Store failure: patch storeAsset to reject once, attempt a new stroke.
      // Bytes and history must be unchanged (no partial commit, no new entry).
      await page.evaluate(() => {
        const vm = (window as any).__paintHistoryRenameVm ?? (window as any).__paintHistoryVm
        const w = window as unknown as Record<string, unknown>
        if (!w.__renameStoreBackup) w.__renameStoreBackup = vm.storeAsset.bind(vm)
        let failed = false
        vm.storeAsset = async (...args: unknown[]) => {
          if (!failed) {
            failed = true
            throw new Error('injected store failure')
          }
          return (w.__renameStoreBackup as (...a: unknown[]) => Promise<unknown>)(...args)
        }
      })
      const preFail = (await costumeDigest(page, 'sprite1', 0))!
      await brushStroke(page).catch(() => undefined)
      await page.waitForTimeout(1500)
      const postFail = (await costumeDigest(page, 'sprite1', 0))!
      expect(postFail.sum).toBe(preFail.sum)
      expect(postFail.name).toBe('costumeA-scoped')
      await expectUndo(page, false)
      await page.evaluate(() => {
        const vm = (window as any).__paintHistoryRenameVm ?? (window as any).__paintHistoryVm
        const w = window as unknown as Record<string, unknown>
        if (w.__renameStoreBackup) vm.storeAsset = w.__renameStoreBackup as unknown
      })

      // Project reload clears histories and restores original names.
      await page.getByTestId('project-file-input').setInputFiles({
        name: 'rename.sb3',
        mimeType: 'application/x.scratch.sb3',
        buffer: buildSb3(),
      })
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.id === 'sprite1')
            ?.costumes[0]?.name === 'costumeA',
        null,
        { timeout: 20000 },
      )
      await page.getByTestId('main-tab-costumes').click()
      await expectUndo(page, false)
      const reloaded = (await costumeDigest(page, 'sprite1', 0))!
      expect(reloaded.name).toBe('costumeA')
    } finally {
      await page.close()
    }
  }, 150000)

  it('stale cross-target commit is dropped by the scope guard with history intact', async () => {
    const page = await newSeededPage()
    try {
      const beforeA = (await costumeDigest(page, 'sprite1', 0))!
      const beforeB = (await costumeDigest(page, 'sprite2', 0))!
      await brushStroke(page)
      await waitCostumeMd5(page, 'sprite1', 0, beforeA!.md5ext)
      const editedA = (await costumeDigest(page, 'sprite1', 0))!
      await renameViaUICard(page, 0, 'costumeA-guard', 'costumeA')
      await expectUndo(page, true)

      // Start a real brush stroke on A, then switch to Sprite2 before the
      // async save lands: the late commit must be dropped (B pristine) while
      // the pre-stroke entry stays undoable with the renamed name.
      await page.getByTestId('bitmap-tool-brush').click()
      const canvasBox = (await page.getByTestId('bitmap-editor-canvas').boundingBox())!
      const px = canvasBox.x + canvasBox.width / 2
      const py = canvasBox.y + canvasBox.height / 2
      await page.mouse.move(px - 30, py)
      await page.mouse.down()
      await page.mouse.move(px + 30, py, { steps: 6 })
      await page.evaluate(() => {
        ;(document.querySelector('[data-testid="target-card-Sprite2"]') as HTMLButtonElement | null)?.click()
      })
      await page.mouse.up().catch(() => undefined)
      await page.waitForTimeout(1500)
      await page.waitForFunction(
        () => {
          const s = (window as any).__hikkakuEditorTest?.snapshot()
          const t = s?.project.targets.find((x: any) => x.id === s?.selectedTargetId || x.name === s?.selectedTargetId)
          return t?.name === 'Sprite2'
        },
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)
      const guardedB = (await costumeDigest(page, 'sprite2', 0))!
      expect(guardedB.sum).toBe(beforeB!.sum)
      expect(guardedB.len).toBe(beforeB!.len)

      // Back on the original costume: renamed name + pre-stroke bytes kept,
      // and the kept entry still undoes to the original bytes (renamed).
      await page.getByTestId('target-card-Sprite1').click()
      await page.getByTestId('main-tab-costumes').click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 20000 })
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.id === 'sprite1')
            ?.costumes[0]?.name === 'costumeA-guard',
        null,
        { timeout: 10000 },
      )
      const backA = (await costumeDigest(page, 'sprite1', 0))!
      expect(backA.name).toBe('costumeA-guard')
      expect(backA.sum).toBe(editedA.sum)
      await expectUndo(page, false)
    } finally {
      await page.close()
    }
  }, 120000)
})
