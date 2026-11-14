import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Per-project viewport generation on the real Editor.
//
// Covers the Editor.svelte wiring (BitmapEditor itself untouched):
// - same target/index + same costume asset bytes/name/id reimported as a new
//   project starts from a FRESH fit (strong fixture: content-only keys would
//   collide, the project generation separates them),
// - the original project's user zoom does not leak into the imported project,
// - failed loads and cancelled picks never bump the generation (viewport kept),
// - same-project save/undo/redo/rename/reorder/target-switch preserve the
//   viewport (generation untouched, same-slot inheritance),
// - bitmap/vector mode conversion keeps each mode's own viewport.
// Bitmap `bitmapFitState.assetKey` fallback + async fit gating stay intact
// (all fits still wait for the settled owner; no direct unit of the fallback
// is duplicated here).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/project-viewport-generation.browser.test.ts
const root = join(import.meta.dir, '..')
const PORT = 4571
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

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

function buildSolidPng(width: number, height: number, r: number, g: number, b: number): Uint8Array {
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

function buildPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (1 + width * 4) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
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
  const total = parts.reduce((n, part) => n + part.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const part of parts) {
    out.set(part, o)
    o += part.length
  }
  return out
}

function buildSb3(): Buffer {
  // Asymmetric red (blue bar on the left) so a horizontal flip actually
  // changes pixels and records history; a solid square would flip to itself
  // and stay a history-free no-op.
  const redPng = buildPng(100, 100, (x) => (x < 20 ? [0, 0, 255, 255] : [255, 0, 0, 255]))
  const bluePng = buildSolidPng(80, 80, 0, 0, 255)
  const stagePng = buildSolidPng(480, 360, 255, 255, 255)
  const files: Record<string, Uint8Array> = {}
  const put = (bytes: Uint8Array, ext: string) => {
    const h = md5(bytes)
    files[`${h}.${ext}`] = bytes
    return { assetId: h, md5ext: `${h}.${ext}` }
  }
  const redFile = put(redPng, 'png')
  const blueFile = put(bluePng, 'png')
  const stageFile = put(stagePng, 'png')
  const project = {
    targets: [
      {
        isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'white-stage', ...stageFile, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [
          { name: 'red', ...redFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 50, rotationCenterY: 50 },
          { name: 'blue', ...blueFile, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 40, rotationCenterY: 40 },
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'project-viewport-gen', agent: 'project-viewport-gen' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

async function openCostumes(): Promise<void> {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function importSb3(bytes: Buffer): Promise<void> {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'viewport-gen.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
  await page.waitForFunction(
    () => {
      const hook = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { project: { targets: Array<{ costumes: Array<{ name: string }> }> } } } }).__hikkakuEditorTest
      const targets = hook?.snapshot()?.project.targets ?? []
      return targets.some((t) => t.costumes.some((c) => c.name === 'red'))
    },
    null,
    { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await new Promise((resolve) => setTimeout(resolve, 800))
}

async function selectCostumeCard(index: number): Promise<void> {
  await page.evaluate((i: number) => {
    const cards = document.querySelectorAll('[data-testid^="costume-card-"]')
    const card = cards[i] as HTMLElement | undefined
    const button = card?.querySelector('button[aria-label^="Select"]') as HTMLButtonElement | undefined
    button?.click()
  }, index as unknown as undefined)
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
  await new Promise((resolve) => setTimeout(resolve, 400))
}

async function waitForViewportSettled(timeout = 12_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const surface =
        (document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null) ??
        (document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement | null)
      if (!surface) return false
      const w = surface.getBoundingClientRect().width
      const key = '__viewportGenSettleProbe'
      const store = window as unknown as Record<string, { last: number; stable: number }>
      const prev = store[key]
      if (!prev || Math.abs(prev.last - w) > 1) {
        store[key] = { last: w, stable: 0 }
        return false
      }
      prev.stable += 1
      return prev.stable >= 3
    },
    null,
    { timeout },
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
}

type ViewportMeasurement = {
  surface: { left: number; top: number; width: number; height: number; cx: number; cy: number }
  label: string
  mode: 'vector' | 'bitmap'
  undoEnabled: boolean
  redoEnabled: boolean
}

async function measureViewport(): Promise<ViewportMeasurement> {
  return await page.evaluate(() => {
    const vectorSurface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')
    const bitmapCanvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    const surfaceEl = (vectorSurface ?? bitmapCanvas)! as HTMLElement
    const r = surfaceEl.getBoundingClientRect()
    return {
      surface: { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 },
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      mode: vectorSurface ? ('vector' as const) : ('bitmap' as const),
      undoEnabled: document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled === false,
      redoEnabled: document.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.disabled === false,
    }
  })
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status() ?? '')
}

describe('project viewport generation on the real editor', () => {
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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('fresh-fits same-byte reimports, keeps user zoom on failure/cancel, preserves same-project ops and mode sides', async () => {
    const sb3 = buildSb3()
    await openCostumes()
    await importSb3(sb3)
    // Sprite1 holds the red/blue costumes; ensure Sprite1 is selected.
    await page.getByTestId('target-card-Sprite1').click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await selectCostumeCard(0)
    await waitForViewportSettled()
    const fitA = await measureViewport()
    console.log(`VIEWPORT_GEN_FIT_A ${JSON.stringify(fitA)}`)
    expect(fitA.mode).toBe('bitmap')

    // User zoom on the original project.
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const userZoomA = await measureViewport()
    console.log(`VIEWPORT_GEN_USER_A ${JSON.stringify(userZoomA)}`)
    expect(userZoomA.surface.width - fitA.surface.width).toBeGreaterThan(5)

    // Same bytes/name/id reimported as a NEW project => fresh fit, not inherited zoom.
    await importSb3(sb3)
    await selectCostumeCard(0)
    await waitForViewportSettled()
    const fitA2 = await measureViewport()
    console.log(`VIEWPORT_GEN_FIT_A2 ${JSON.stringify(fitA2)}`)
    expect(fitA2.mode).toBe('bitmap')
    expect(Math.abs(fitA2.surface.width - fitA.surface.width)).toBeLessThan(3)
    expect(Math.abs(fitA2.surface.width - userZoomA.surface.width)).toBeGreaterThan(5)

    // Zoom again, then a failed project load must keep the zoom (no generation bump).
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const userZoomA2 = await measureViewport()
    await page.getByTestId('project-file-input').setInputFiles({ name: 'bad.sb3', mimeType: 'application/x.scratch.sb3', buffer: Buffer.from('not a project') })
    await new Promise((resolve) => setTimeout(resolve, 800))
    const afterFailure = await measureViewport()
    console.log(`VIEWPORT_GEN_AFTER_FAILURE ${JSON.stringify(afterFailure)}`)
    expect(Math.abs(afterFailure.surface.width - userZoomA2.surface.width)).toBeLessThan(2)
    expect(Math.hypot(afterFailure.surface.cx - userZoomA2.surface.cx, afterFailure.surface.cy - userZoomA2.surface.cy)).toBeLessThan(2)

    // Cancelled pick (change event with no file) also keeps the zoom.
    await page.evaluate(() => {
      document.querySelector<HTMLInputElement>('[data-testid="project-file-input"]')?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const afterCancel = await measureViewport()
    expect(Math.abs(afterCancel.surface.width - userZoomA2.surface.width)).toBeLessThan(2)

    // The failed import ran `resetProjectUiState` (revision bump) before throwing,
    // so the bitmap workspace gate stays unsettled until the next committed load.
    // Reselecting the same costume recommits the owner: the viewport must still be
    // the preserved user zoom (same generation, same settled key), and editing
    // works again.
    await selectCostumeCard(0)
    await waitForViewportSettled()
    const afterReselect = await measureViewport()
    console.log(`VIEWPORT_GEN_AFTER_RESELECT ${JSON.stringify(afterReselect)}`)
    expect(Math.abs(afterReselect.surface.width - userZoomA2.surface.width)).toBeLessThan(2)

    // Same-project rename via the costume name input preserves the viewport.
    const renameInput = page.locator('[aria-label^="Rename red"], [aria-label^="Rename blue"]').first()
    // The paint-surface header input renames the current costume.
    const headerRename = page.locator('[aria-label^="Rename "]').first()
    void renameInput
    await headerRename.fill('red-renamed')
    await headerRename.dispatchEvent('change')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const afterRename = await measureViewport()
    console.log(`VIEWPORT_GEN_AFTER_RENAME ${JSON.stringify(afterRename)}`)
    expect(Math.abs(afterRename.surface.width - userZoomA2.surface.width)).toBeLessThan(2)

    // Same-project flip preserves the viewport and records one undo entry.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="flip-bitmap-horizontal"]') as HTMLButtonElement | null
      if (!el) throw new Error('missing flip button')
      if (el.disabled) throw new Error('flip button disabled')
      el.click()
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    console.log(`VIEWPORT_GEN_FLIP_STATUS ${await editorStatus()}`)
    const afterFlip = await measureViewport()
    console.log(`VIEWPORT_GEN_AFTER_FLIP ${JSON.stringify(afterFlip)}`)
    expect(Math.abs(afterFlip.surface.width - userZoomA2.surface.width)).toBeLessThan(3)
    expect(afterFlip.undoEnabled).toBe(true)

    // Undo/redo preserve the viewport.
    await page.getByRole('button', { name: 'Undo' }).click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const afterUndo = await measureViewport()
    expect(Math.abs(afterUndo.surface.width - userZoomA2.surface.width)).toBeLessThan(3)
    await page.getByRole('button', { name: 'Redo' }).click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const afterRedo = await measureViewport()
    expect(Math.abs(afterRedo.surface.width - userZoomA2.surface.width)).toBeLessThan(3)

    // Same-project save preserves the viewport (new md5ext, same-slot inheritance).
    await page.getByTestId('save-bitmap-costume').click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await waitForViewportSettled()
    const afterSave = await measureViewport()
    console.log(`VIEWPORT_GEN_AFTER_SAVE ${JSON.stringify(afterSave)}`)
    expect(Math.abs(afterSave.surface.width - userZoomA2.surface.width)).toBeLessThan(3)

    // Reorder round-trip (card 1 -> card 0, then back) restores the mapping, so
    // the originally zoomed red artwork at index 0 keeps its settled viewport.
    // A generation bump on reorder would have forked every key (fresh fit).
    const swapCards = async () => {
      await page.evaluate(() => {
        const cards = document.querySelectorAll('[data-testid^="costume-card-"]')
        const from = cards[1] as HTMLElement | undefined
        const to = cards[0] as HTMLElement | undefined
        if (!from || !to) throw new Error('missing costume cards for reorder')
        const data = new DataTransfer()
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }))
      })
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    await swapCards()
    await swapCards()
    await selectCostumeCard(0)
    await waitForViewportSettled()
    const afterReorder = await measureViewport()
    console.log(`VIEWPORT_GEN_AFTER_REORDER ${JSON.stringify(afterReorder)}`)
    expect(Math.abs(afterReorder.surface.width - userZoomA2.surface.width)).toBeLessThan(4)

    // Mode conversion keeps each side's own viewport: vector fits independently,
    // converting back restores the bitmap zoom.
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await waitForViewportSettled()
    const vectorSide = await measureViewport()
    console.log(`VIEWPORT_GEN_VECTOR ${JSON.stringify(vectorSide)}`)
    expect(vectorSide.mode).toBe('vector')
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await waitForViewportSettled()
    const bitmapBack = await measureViewport()
    console.log(`VIEWPORT_GEN_BITMAP_BACK ${JSON.stringify(bitmapBack)}`)
    expect(bitmapBack.mode).toBe('bitmap')
    expect(Math.abs(bitmapBack.surface.width - afterReorder.surface.width)).toBeLessThan(4)
    expect(await editorStatus()).not.toContain('Could not load project')
  }, 240_000)
})
