import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync, zlibSync } from 'fflate'
import { type Browser, type Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Persistent regression test for the paint/sound history policy in Editor.svelte:
// separate paint/sound stacks, paint CLEAR on costume switch (max 100 entries +
// encoded-bytes budgets + async scope guard), GLOBAL sound history across
// sound/target switches, isolation across sprite/Stage switches for paint,
// separation, nudge/drag-time switches, stale delayed-save commits, and no-op /
// redo retention. Every behavioral claim is verified through the real editor UI
// (tabs, costume cards, canvas brush, sound effects, conversions) and checked
// against actual asset bytes (vm.loadAsset / getSoundBuffer digests) and real
// canvas pixels (bitmap-editor-canvas getImageData). Product code is untouched:
// the fixture only exposes its VM on window for byte reads.
const root = join(import.meta.dir, '..')
const PORT = 4251
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
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
  // PNG IDAT must be a zlib stream (RFC 1950); raw deflate decodes as
  // transparent in Chrome, leaving the bitmap canvas blank. Matches the
  // sibling bitmap suites, which all use zlibSync here.
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

function toneWav(freq: number, seconds = 0.5, rate = 44100): Uint8Array {
  const count = Math.floor(rate * seconds)
  const out = new Uint8Array(44 + count * 2)
  const view = new DataView(out.buffer)
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) out[off + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + count * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, count * 2, true)
  for (let i = 0; i < count; i += 1) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 16000)
    view.setInt16(44 + i * 2, s, true)
  }
  return out
}

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')

function buildSb3() {
  const files: Record<string, Uint8Array> = {}
  const addFile = (bytes: Uint8Array, ext: string) => {
    const hash = md5(bytes)
    const md5ext = `${hash}.${ext}`
    files[md5ext] = bytes
    return { assetId: hash, md5ext }
  }
  const pngA = addFile(solidPng(255, 255, 255), 'png')
  const pngB = addFile(solidPng(210, 210, 210), 'png')
  const pngStage = addFile(solidPng(240, 240, 240), 'png')
  const pngS2 = addFile(solidPng(200, 220, 255), 'png')
  const wavA = addFile(toneWav(440), 'wav')
  const wavB = addFile(toneWav(660), 'wav')
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name,
    ...ref,
    dataFormat: 'png',
    bitmapResolution: 2,
    rotationCenterX: 16,
    rotationCenterY: 16,
  })
  const sound = (ref: { assetId: string; md5ext: string }, name: string, bytes: Uint8Array) => ({
    name,
    ...ref,
    dataFormat: 'wav',
    format: '',
    rate: 44100,
    sampleCount: Math.max(0, Math.floor((bytes.length - 44) / 2)),
  })
  const wavABytes = files[wavA.md5ext]!
  const wavBBytes = files[wavB.md5ext]!
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
        costumes: [{ ...costume(pngStage, 'backdrop'), bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [costume(pngA, 'costumeA'), costume(pngB, 'costumeB')],
        sounds: [sound(wavA, 'soundA', wavABytes), sound(wavB, 'soundB', wavBBytes)],
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
        isStage: false,
        name: 'Sprite2',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [costume(pngS2, 'costumeS2')],
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
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'paint-history' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

// --- page helpers (real UI + real bytes/pixels) -----------------------------

async function newSeededPage(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon'))
      diagnostics.push(`console: ${message.text()}`)
  })
  await page.goto(base)
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20000 })
  await page.getByTestId('project-file-input').setInputFiles({
    name: 'history.sb3',
    mimeType: 'application/x.scratch.sb3',
    buffer: buildSb3(),
  })
  await page.waitForFunction(
    () =>
      (window as any).__hikkakuEditorTest
        ?.snapshot()
        .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 2 &&
      (window as any).__hikkakuEditorTest
        ?.snapshot()
        .project.targets.find((t: any) => t.name === 'Sprite1')?.sounds.length === 2,
    null,
    { timeout: 20000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 20000 })
  // Workspace owner gate: the bitmap canvas shows the decoded asset only
  // after the async image decode + draw completes. Painting before that would
  // be safely refused (stale canvas), so wait for settled opaque pixels first.
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!c) return false
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

type Digest = { len: number; sum: number; head: number[]; md5ext: string; dataFormat: string; name: string } | null

async function costumeDigest(page: Page, target: string, index: number): Promise<Digest> {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as any).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const key = c?.md5ext ?? c?.assetId
    const bytes = key ? await vm.loadAsset(key, c.dataFormat ?? '') : undefined
    if (!bytes) return null
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    return {
      len: (bytes as Uint8Array).length,
      sum,
      head: Array.from((bytes as Uint8Array).slice(0, 16)),
      md5ext: c.md5ext,
      dataFormat: c.dataFormat,
      name: c.name,
    }
  }, { target, index })
}

async function soundDigest(page: Page, target: string, index: number) {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as any).__paintHistoryVm
    const t = vm.getTarget(target)
    const s = t?.sounds[index]
    const bytes = await vm.getSoundBuffer(target, index)
    if (!bytes) return null
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    return { len: (bytes as Uint8Array).length, sum, md5ext: s?.md5ext, name: s?.name }
  }, { target, index })
}

async function canvasDigest(page: Page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!canvas) return null
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

async function visibleUndoRedo(page: Page) {
  const state = await page.evaluate(() => {
    const pick = (label: string) =>
      Array.from(document.querySelectorAll(`button[aria-label="${label}"]`)).map((b) => ({
        disabled: (b as HTMLButtonElement).disabled,
        visible: (b as HTMLElement).offsetParent !== null,
      }))
    return { undo: pick('Undo'), redo: pick('Redo') }
  })
  const undo = state.undo.filter((b) => b.visible)
  const redo = state.redo.filter((b) => b.visible)
  return { undo, redo }
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
  const { undo } = await visibleUndoRedo(page)
  expect(undo.length).toBeGreaterThan(0)
  expect(undo[0]!.disabled).toBe(!enabled)
}

async function expectRedo(page: Page, enabled: boolean) {
  const { redo } = await visibleUndoRedo(page)
  expect(redo.length).toBeGreaterThan(0)
  expect(redo[0]!.disabled).toBe(!enabled)
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

async function waitCostumeMd5(page: Page, target: string, index: number, md5ext: string) {
  await page.waitForFunction(
    ({ target, index, md5ext }) =>
      (window as any).__hikkakuEditorTest
        ?.snapshot()
        .project.targets.find((t: any) => t.name === target)?.costumes[index]?.md5ext !== md5ext,
    { target, index, md5ext },
    { timeout: 15000 },
  )
}

// Internal saves re-hash with FNV-1a while SB3 originals carry MD5 names, so an
// Undo that restores byte-identical content yields a different md5ext. Revert
// waits must therefore poll the actual bytes (len + checksum + head), never the
// md5ext string.
async function waitForDigest(
  page: Page,
  kind: 'costume' | 'sound',
  target: string,
  index: number,
  want: { len: number; sum: number },
  timeout = 15000,
) {
  const start = Date.now()
  for (;;) {
    const got =
      kind === 'costume' ? await costumeDigest(page, target, index) : await soundDigest(page, target, index)
    if (got && got.len === want.len && got.sum === want.sum) return got
    if (Date.now() - start > timeout) {
      const status = await page.evaluate(() => (window as any).__hikkakuEditorTest?.status?.())
      throw new Error(
        `digest wait timeout kind=${kind} target=${target} index=${index} want=${JSON.stringify(want)} got=${JSON.stringify(got)} status=${status}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

async function waitSoundMd5(page: Page, target: string, index: number, md5ext: string) {
  await page.waitForFunction(
    ({ target, index, md5ext }) =>
      (window as any).__hikkakuEditorTest
        ?.snapshot()
        .project.targets.find((t: any) => t.name === target)?.sounds[index]?.md5ext !== md5ext,
    { target, index, md5ext },
    { timeout: 15000 },
  )
}

describe('paint/sound history isolation in the real editor', () => {
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

  it('costume A edit enables Undo; switching to B clears it; B edits/undo/redo are byte-exact', async () => {
    const page = await newSeededPage()
    try {
      const beforeA = (await costumeDigest(page, 'Sprite1', 0))!
      const beforeB = (await costumeDigest(page, 'Sprite1', 1))!
      expect(beforeA).not.toBeNull()
      expect(beforeB).not.toBeNull()
      expect(beforeA!.md5ext).not.toBe(beforeB!.md5ext)
      const pixelsBefore = (await canvasDigest(page))!

      await brushStroke(page)
      await waitCostumeMd5(page, 'Sprite1', 0, beforeA!.md5ext)
      const editedA = (await costumeDigest(page, 'Sprite1', 0))!
      expect(editedA.md5ext).not.toBe(beforeA!.md5ext)
      expect(editedA.len).toBeGreaterThan(0)
      const pixelsEdited = (await canvasDigest(page))!
      expect(pixelsEdited.sum).not.toBe(pixelsBefore.sum)
      await expectUndo(page, true)

      // Switch to costume B through the real costume card: paint CLEAR.
      await page.getByRole('button', { name: 'Select costumeB' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.currentCostume === 1,
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)
      await expectRedo(page, false)
      const afterSwitchB = (await costumeDigest(page, 'Sprite1', 1))!
      expect(afterSwitchB.md5ext).toBe(beforeB!.md5ext)
      expect(afterSwitchB.sum).toBe(beforeB!.sum)

      // Edit B: real brush bytes + pixels, then Undo restores B exactly.
      await brushStroke(page)
      await waitCostumeMd5(page, 'Sprite1', 1, beforeB!.md5ext)
      const editedB = (await costumeDigest(page, 'Sprite1', 1))!
      expect(editedB.md5ext).not.toBe(beforeB!.md5ext)
      await expectUndo(page, true)
      await clickUndo(page)
      await waitForDigest(page, 'costume', 'Sprite1', 1, beforeB!)
      const undoneB = (await costumeDigest(page, 'Sprite1', 1))!
      expect(undoneB.sum).toBe(beforeB!.sum)
      expect(undoneB.len).toBe(beforeB!.len)
      await expectRedo(page, true)
      await clickRedo(page)
      await waitForDigest(page, 'costume', 'Sprite1', 1, editedB)
      const redoneB = (await costumeDigest(page, 'Sprite1', 1))!
      expect(redoneB.sum).toBe(editedB.sum)

      // Switching back to A keeps A's own edited bytes (scopes are per-slot).
      await page.getByRole('button', { name: 'Select costumeA' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.currentCostume === 0,
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)
      const backA = (await costumeDigest(page, 'Sprite1', 0))!
      expect(backA.md5ext).toBe(editedA.md5ext)
      expect(backA.sum).toBe(editedA.sum)
    } finally {
      await page.close()
    }
  }, 60000)

  it('sound edits live on a separate global stack and survive sound switches without touching paint', async () => {
    const page = await newSeededPage()
    try {
      const paintBefore = (await costumeDigest(page, 'Sprite1', 0))!
      await brushStroke(page)
      await waitCostumeMd5(page, 'Sprite1', 0, paintBefore.md5ext)
      await expectUndo(page, true)

      await page.getByTestId('main-tab-sounds').click()
      await page.getByTestId('sound-effect-louder').waitFor({ state: 'visible', timeout: 10000 })
      // Read the baseline BEFORE the edit: the effect save is async and may
      // otherwise land before the baseline read, making the change-wait race.
      const soundBefore = await soundDigest(page, 'Sprite1', 0)
      expect(soundBefore).not.toBeNull()
      const soundOtherBefore = await soundDigest(page, 'Sprite1', 1)
      expect(soundOtherBefore).not.toBeNull()
      await expectUndo(page, false)
      await page.getByTestId('sound-effect-louder').click()
      await waitSoundMd5(page, 'Sprite1', 0, soundBefore!.md5ext!)
      const soundEdited = await soundDigest(page, 'Sprite1', 0)
      expect(soundEdited!.md5ext).not.toBe(soundBefore!.md5ext)
      await expectUndo(page, true)
      await clickUndo(page)
      await waitForDigest(page, 'sound', 'Sprite1', 0, soundBefore! as { len: number; sum: number })
      const soundUndone = await soundDigest(page, 'Sprite1', 0)
      expect(soundUndone!.sum).toBe(soundBefore!.sum)
      await expectRedo(page, true)

      // Sound switch preserves the GLOBAL sound history (legacy cross-sound
      // undo): the pending redo for soundA survives selecting soundB, and a
      // Redo/Undo from soundB restores soundA's own bytes (real asset bytes),
      // never touching soundB or the paint side.
      await page.getByRole('button', { name: 'Select soundB' }).click()
      await page.waitForFunction(
        () => (window as any).__hikkakuEditorTest?.snapshot().project.targets.length > 0,
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)
      await expectRedo(page, true)
      const soundOtherAfterSwitch = await soundDigest(page, 'Sprite1', 1)
      expect(soundOtherAfterSwitch!.sum).toBe(soundOtherBefore!.sum)
      expect(soundOtherAfterSwitch!.len).toBe(soundOtherBefore!.len)
      // Cross-sound Redo: restores soundA's edited bytes while selected on B.
      await clickRedo(page)
      await waitForDigest(page, 'sound', 'Sprite1', 0, soundEdited! as { len: number; sum: number })
      const soundRedoneAcross = await soundDigest(page, 'Sprite1', 0)
      expect(soundRedoneAcross!.sum).toBe(soundEdited!.sum)
      await expectUndo(page, true)
      // Cross-sound Undo: restores soundA's original bytes while selected on B.
      await clickUndo(page)
      await waitForDigest(page, 'sound', 'Sprite1', 0, soundBefore! as { len: number; sum: number })
      const soundUndoneAcross = await soundDigest(page, 'Sprite1', 0)
      expect(soundUndoneAcross!.sum).toBe(soundBefore!.sum)
      expect(soundUndoneAcross!.len).toBe(soundBefore!.len)
      // SoundB stayed byte-identical through the cross-sound round-trip.
      const soundOtherAfter = await soundDigest(page, 'Sprite1', 1)
      expect(soundOtherAfter!.sum).toBe(soundOtherBefore!.sum)
      expect(soundOtherAfter!.len).toBe(soundOtherBefore!.len)
      await expectRedo(page, true)
      // Leave soundA edited so the paint-independence check below still sees
      // a dirty sound session alongside the dirty paint session.
      await clickRedo(page)
      await waitForDigest(page, 'sound', 'Sprite1', 0, soundEdited! as { len: number; sum: number })

      // Paint side survived the whole sound session untouched.
      await page.getByTestId('main-tab-costumes').click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 10000 })
      await expectUndo(page, true)
      const paintAfter = (await costumeDigest(page, 'Sprite1', 0))!
      expect(paintAfter.md5ext).not.toBe(paintBefore.md5ext)
    } finally {
      await page.close()
    }
  }, 60000)

  it('sprite/Stage switches clear; rename preserves while reorder/delete clear', async () => {
    const page = await newSeededPage()
    try {
      const beforeA = (await costumeDigest(page, 'Sprite1', 0))!
      await brushStroke(page)
      await waitCostumeMd5(page, 'Sprite1', 0, beforeA.md5ext)
      await expectUndo(page, true)

      // Costume rename via the real sidebar input preserves slot scope + history.
      // (The toolbar hosts a second `Rename costumeA` input, so scope to the card.)
      const rename = page.getByTestId('costume-card-0').getByLabel('Rename costumeA')
      await rename.fill('costumeA2')
      await rename.press('Tab')
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.costumes[0]?.name === 'costumeA2',
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, true)

      // Costume reorder through real drag-and-drop clears (slots shift artwork).
      await page.getByTestId('costume-card-0').dragTo(page.getByTestId('costume-card-1'))
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.costumes[0]?.name === 'costumeB',
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)

      // Reorder follows the dragged costume object, so the selection may now
      // sit on another slot: explicitly re-select slot 0 before editing it.
      await page.getByRole('button', { name: 'Select costumeB' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.currentCostume === 0,
        null,
        { timeout: 10000 },
      )
      // Re-edit, then real delete clears.
      const preStroke = (await costumeDigest(page, 'Sprite1', 0))!
      await brushStroke(page)
      await waitCostumeMd5(page, 'Sprite1', 0, preStroke.md5ext)
      await expectUndo(page, true)
      await page.getByRole('button', { name: 'Delete costumeB' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.costumes.length === 1,
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)

      // Sprite switch clears; Stage switch clears too.
      await page.getByTestId('target-card-Sprite2').click()
      await page.waitForFunction(
        () => {
          const s = (window as any).__hikkakuEditorTest?.snapshot()
          const t =
            s?.project.targets.find((x: any) => x.id === s?.selectedTargetId) ??
            s?.project.targets.find((x: any) => x.name === s?.selectedTargetId)
          return t?.name === 'Sprite2'
        },
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)
      await page.getByTestId('target-card-stage').click()
      await expectUndo(page, false)
    } finally {
      await page.close()
    }
  }, 90000)

  it('bitmap/vector conversion keeps the slot scope and preserves history byte-exactly', async () => {
    const page = await newSeededPage()
    try {
      const beforeA = (await costumeDigest(page, 'Sprite1', 0))!
      await brushStroke(page)
      await waitCostumeMd5(page, 'Sprite1', 0, beforeA.md5ext)
      const editedBitmap = (await costumeDigest(page, 'Sprite1', 0))!
      await expectUndo(page, true)

      await page.getByRole('button', { name: 'ベクターに変換' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.costumes[0]?.dataFormat === 'svg',
        null,
        { timeout: 15000 },
      )
      await expectUndo(page, true)
      const asVector = (await costumeDigest(page, 'Sprite1', 0))!
      expect(asVector!.dataFormat).toBe('svg')

      await clickUndo(page)
      await page.waitForFunction(
        ({ md5ext }) =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.costumes[0]?.md5ext === md5ext,
        { md5ext: editedBitmap.md5ext },
        { timeout: 15000 },
      )
      const undone = (await costumeDigest(page, 'Sprite1', 0))!
      expect(undone!.dataFormat).toBe('png')
      expect(undone!.sum).toBe(editedBitmap.sum)
      await expectRedo(page, true)
      await clickRedo(page)
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.costumes[0]?.dataFormat === 'svg',
        null,
        { timeout: 15000 },
      )

      await page.getByRole('button', { name: 'ビットマップに変換' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.costumes[0]?.dataFormat === 'png',
        null,
        { timeout: 15000 },
      )
      await expectUndo(page, true)
    } finally {
      await page.close()
    }
  }, 90000)

  it('nudge/drag-time switches, stale delayed saves, no-ops and redo retention behave', async () => {
    const page = await newSeededPage()
    try {
      // Cap policy is the real shipped module with real byte accounting.
      const caps = await page.evaluate(async () => {
        const mod = await import('/src/lib/paint-history')
        const one = (n: number) => ({ bytes: new Uint8Array(n) })
        const many = Array.from({ length: 150 }, () => one(10))
        const trimmed = mod.trimHistoryStacks(many, [], mod.PAINT_HISTORY_MAX_ENTRIES, mod.PAINT_HISTORY_MAX_BYTES)
        const big = [one(mod.PAINT_HISTORY_MAX_BYTES - 8), one(16)]
        const trimmedBytes = mod.trimHistoryStacks(big, [], mod.PAINT_HISTORY_MAX_ENTRIES, mod.PAINT_HISTORY_MAX_BYTES)
        return {
          maxEntries: mod.PAINT_HISTORY_MAX_ENTRIES,
          maxSoundEntries: mod.SOUND_HISTORY_MAX_ENTRIES,
          maxBytes: mod.PAINT_HISTORY_MAX_BYTES,
          maxSoundBytes: mod.SOUND_HISTORY_MAX_BYTES,
          trimmedLen: trimmed.undo.length,
          trimmedBytesLen: trimmedBytes.undo.length,
        }
      })
      expect(caps.maxEntries).toBe(100)
      expect(caps.maxSoundEntries).toBe(100)
      expect(caps.maxBytes).toBe(24 * 1024 * 1024)
      expect(caps.maxSoundBytes).toBe(32 * 1024 * 1024)
      expect(caps.trimmedLen).toBe(100)
      expect(caps.trimmedBytesLen).toBe(1)

      // No-op: an Undo press with an empty stack changes no bytes.
      const beforeA = (await costumeDigest(page, 'Sprite1', 0))!
      const beforeB = (await costumeDigest(page, 'Sprite1', 1))!
      await expectUndo(page, false)

      // Nudge via a real rect drag (opaque shape + selection in one commit),
      // then a real arrow-key nudge of that selection. The rect drag auto-
      // switches the tool back to select; the arrow key must move the same
      // selection and commit exactly one more history entry on keyup.
      // The rect straddles the fixture white square (its right edge lands
      // mid-square): saves crop to the opaque trim, so a 1px nudge of a
      // fully isolated uniform block would re-crop to byte-identical PNG
      // (md5ext-invariant, only the rotation center shifts). The partial
      // overlap keeps non-uniform content inside the trim, so the nudge
      // commit re-hashes detectably.
      await page.getByTestId('bitmap-tool-rect').click()
      const box = (await page.getByTestId('bitmap-editor-canvas').boundingBox())!
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx - 120, cy - 30)
      await page.mouse.down()
      await page.mouse.move(cx, cy + 30, { steps: 8 })
      await page.mouse.up()
      await waitCostumeMd5(page, 'Sprite1', 0, beforeA.md5ext)
      await page.waitForSelector('[data-testid="bitmap-selection"]', { timeout: 10000 })
      // Fit can settle at scale ~4 (1 screen px = 0.25 bitmap px): a single
      // Arrow press then truncates to a sub-pixel no-op with no history entry,
      // so the md5 wait below would time out. Normalize through the real
      // Reset zoom button to the known per-mode reset (bitmap res2 0.5 =>
      // 2 bitmap px per screen px) before the 1px nudge so the integer raster
      // move is guaranteed. Viewport-only: no paint bytes/history change here.
      const resetButtons = page.getByRole('button', { name: 'Reset zoom' })
      const resetCount = await resetButtons.count()
      let resetClicked = false
      for (let i = 0; i < resetCount; i += 1) {
        const candidate = resetButtons.nth(i)
        if ((await candidate.isVisible()) && (await candidate.isEnabled())) {
          await candidate.click()
          resetClicked = true
          break
        }
      }
      expect(resetClicked).toBe(true)
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('button[aria-label="Reset zoom"]')).some(
            (b) => (b as HTMLElement).offsetParent !== null && ((b.textContent ?? '').trim() === '100%'),
          ),
        null,
        { timeout: 10000 },
      )
      await page.waitForSelector('[data-testid="bitmap-selection"]', { timeout: 10000 })
      const shaped = (await costumeDigest(page, 'Sprite1', 0))!
      await page.keyboard.press('ArrowRight')
      await waitCostumeMd5(page, 'Sprite1', 0, shaped.md5ext)
      const nudged = (await costumeDigest(page, 'Sprite1', 0))!
      expect(nudged.sum).not.toBe(shaped.sum)
      await expectUndo(page, true)

      // New paint commit keeps paint-undo but a same-color fill no-op adds none:
      // fill twice with the same color; the second fill must not grow the stack
      // (one Undo still returns to the pre-fill bytes, redo stays single).
      // Fill OUTSIDE the rect with the default fill color: the rect interior
      // already carries it, so the interior would be a no-op, but the
      // background corner differs and must commit exactly one entry.
      await page.getByTestId('bitmap-tool-fill').click()
      // The paint canvas renders at full workspace scale and overflows the
      // viewport, so a box-fraction point can land off-screen (no event at
      // all). Offset from the visible center instead: +150/-120 canvas px
      // hits visible background (the artwork sits at the center) and the
      // elementFromPoint target is the canvas itself.
      const fillX = cx + 150
      const fillY = cy - 120
      await page.mouse.click(fillX, fillY)
      await waitCostumeMd5(page, 'Sprite1', 0, nudged.md5ext)
      const filledOnce = (await costumeDigest(page, 'Sprite1', 0))!
      expect(filledOnce.sum).not.toBe(nudged.sum)
      await page.mouse.click(fillX, fillY)
      await page.waitForTimeout(800)
      const filledTwice = (await costumeDigest(page, 'Sprite1', 0))!
      expect(filledTwice.md5ext).toBe(filledOnce.md5ext)
      expect(filledTwice.sum).toBe(filledOnce.sum)
      await clickUndo(page)
      await waitForDigest(page, 'costume', 'Sprite1', 0, nudged)
      await expectRedo(page, true)

      // Redo retention across sides: build a sound redo, then a new paint
      // commit must clear paint redo yet keep the sound redo alive.
      await clickRedo(page)
      await waitForDigest(page, 'costume', 'Sprite1', 0, filledOnce)
      await page.getByTestId('main-tab-sounds').click()
      await page.getByTestId('sound-effect-louder').waitFor({ state: 'visible', timeout: 10000 })
      const soundBefore = await soundDigest(page, 'Sprite1', 0)
      await page.getByTestId('sound-effect-louder').click()
      await waitSoundMd5(page, 'Sprite1', 0, soundBefore!.md5ext!)
      await clickUndo(page)
      await waitForDigest(page, 'sound', 'Sprite1', 0, soundBefore! as { len: number; sum: number })
      await page.getByTestId('main-tab-costumes').click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 10000 })
      await brushStroke(page)
      await expectRedo(page, false)
      await page.getByTestId('main-tab-sounds').click()
      await expectRedo(page, true)

      // Stale delayed save: start a paint stroke on A and switch to B before
      // the async save lands; the late commit must be dropped (B pristine,
      // B history empty) while A keeps its own bytes.
      await page.getByTestId('main-tab-costumes').click()
      await page.getByRole('button', { name: 'Select costumeA' }).click()
      const liveB = (await costumeDigest(page, 'Sprite1', 1))!
      expect(liveB.md5ext).toBe(beforeB.md5ext)
      await page.getByTestId('bitmap-tool-brush').click()
      const canvasBox = (await page.getByTestId('bitmap-editor-canvas').boundingBox())!
      const px = canvasBox.x + canvasBox.width / 2
      const py = canvasBox.y + canvasBox.height / 2
      await page.mouse.move(px - 30, py)
      await page.mouse.down()
      await page.mouse.move(px + 30, py, { steps: 6 })
      await page.evaluate(() => {
        ;(document.querySelector('[aria-label="Select costumeB"]') as HTMLButtonElement | null)?.click()
      })
      await page.mouse.up()
      await page.waitForTimeout(1200)
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.currentCostume === 1,
        null,
        { timeout: 10000 },
      )
      await expectUndo(page, false)
      const guardedB = (await costumeDigest(page, 'Sprite1', 1))!
      expect(guardedB.md5ext).toBe(beforeB.md5ext)
      expect(guardedB.sum).toBe(beforeB.sum)
    } finally {
      await page.close()
    }
  }, 120000)
})
