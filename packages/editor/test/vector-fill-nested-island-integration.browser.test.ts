import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Nested-island fill integration (real Editor + real VM, fail-first for V-5).
//
// Scope: straight-only laminar nests (outer -> hole -> island -> inner hole),
// evenodd + nonzero (reversed winding), through the REAL costume editor UI
// (fill tool clicks, hover previews, Undo / Redo buttons) checked against the
// REAL VM saved SVG bytes (`__paintHistoryVm.loadAsset`) plus REAL canvas
// pixels (`costume-paint-surface` screenshots). Pure-geometry modules are
// never asserted alone here; Canvas/Paper-oracle agreement for the same
// fixtures is covered by `vector-fill-hole-nested.browser.test.ts`.
//
// Self-made fixtures only (no upstream transcription): one outer rectangle
// with H/V straight subpaths per level. All coordinates are original.
//
// Fail-first status (2026-11-12, measured via page.evaluate Paper probe):
// - the pure helper (`classifyHolePoint`) already resolves the innermost
//   child-free hole (`hole` / `filled` / `outside` per depth) while outer
//   rings containing an island stay `ambiguous` (solid-overlay safety);
// - the Paper entity probe (`paperVectorHoleTargetAtPoint`) still reports
//   `ambiguous` ("hole overlaps 4 contours") for the innermost point, so the
//   editor commit path early-returns with a no-op status and never reaches the
//   overlay. Wiring the Paper probe to the same laminar/nested resolution
//   (paper-vector.ts, owned by another agent) flips the three `nested fill`
//   tests below from red to green without touching their expectations.
// - Every safety no-op below (outer ring, transparent, outside, overlap,
//   history/redo preservation, selection) already passes and must keep
//   passing: they pin the fail-closed contract.
//
// Dedicated Vite port 4494 (surveyed 2026-11-12: 4487/4490/4491/4492/4496/
// 4497/4499 and the 4527-4701 browser-test ports are taken).
const root = join(import.meta.dir, '..')
const PORT = 4494
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// Outer 150,110 -> 330,250; hole 170,130 -> 310,190; island 200,140 -> 280,180;
// inner 225,150 -> 255,170. Sample points: inner (240,160); island ring
// (210,160); outer ring (180,160); body (160,240); outside (240,90).
const OUTER = 'M150 110H330V250H150Z'
const HOLE = 'M170 130H310V190H170Z'
const ISLAND = 'M200 140H280V180H200Z'
const INNER = 'M225 150H255V170H225Z'
const HOLE_REV = 'M170 130V190H310V130H170Z'
const INNER_REV = 'M225 150V170H255V150H225Z'
const NESTED_EVENODD_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE} ${ISLAND} ${INNER}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const NESTED_NONZERO_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE_REV} ${ISLAND} ${INNER_REV}" fill="#ff0000" fill-rule="nonzero" stroke="none"/></svg>`
const NESTED_NOOP_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE} ${ISLAND} ${INNER}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const OVERLAP_NEST_SVG =
  `${HEAD}<path d="M150 110H330V250H150Z M200 160H350V260H200Z" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const Z_HIDE_NEST_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE} ${ISLAND} ${INNER}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>` +
  `<rect x="215" y="140" width="50" height="40" fill="#0000ff" stroke="none"/></svg>`
const STAGE_SVG =
  `${HEAD}<rect x="20" y="20" width="60" height="40" fill="#888888" stroke="none"/></svg>`

const INNER_PT = { x: 240, y: 160 }
const ISLAND_RING_PT = { x: 210, y: 160 }
const OUTER_RING_PT = { x: 180, y: 160 }
const BODY_PT = { x: 160, y: 240 }
const OUTSIDE_PT = { x: 240, y: 90 }

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
  const nestedEvenodd = add(NESTED_EVENODD_SVG)
  const nestedNonzero = add(NESTED_NONZERO_SVG)
  const nestedNoop = add(NESTED_NOOP_SVG)
  const overlapNest = add(OVERLAP_NEST_SVG)
  const zHideNest = add(Z_HIDE_NEST_SVG)
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
        costumes: [{ ...costume(stage, 'stage-backdrop'), rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [
          costume(nestedEvenodd, 'nested-evenodd'),
          costume(nestedNonzero, 'nested-nonzero'),
          costume(nestedNoop, 'nested-noop'),
          costume(overlapNest, 'overlap-nest'),
          costume(zHideNest, 'z-hide-nest'),
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'vector-fill-nested-integration' },
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

async function costumeIndexByName(name: string): Promise<number> {
  return await page.evaluate(async (want: string) => {
    const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
    const t = vm.getTarget('Sprite1')
    const names = (t?.costumes ?? []).map((c: any) => c?.name)
    const at = names.indexOf(want)
    if (at < 0) throw new Error(`missing costume ${want}: ${JSON.stringify(names)}`)
    return at
  }, name)
}

async function waitForVmText(target: string, index: number, want: string, timeout = 30_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const got = await costumeText(target, index)
    if (got === want) return got
    if (Date.now() - start > timeout) throw new Error(`VM text timeout ${target}[${index}] len=${got.length} wantLen=${want.length}`)
    await new Promise((r) => setTimeout(r, 150))
  }
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

async function previewHtml(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function selectCostumeByName(name: string) {
  await page.getByRole('button', { name: `Select ${name}` }).click()
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
}

async function ensureVectorMode() {
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 20_000 })
}

async function fitViewport() {
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.waitForTimeout(1200)
}

async function selectFillTool() {
  await page.getByTestId('vector-shape-fill').last().click()
}

async function ensureSolidFill() {
  const pressed = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Transparent fill"]')
    return button?.getAttribute('aria-pressed') === 'true'
  })
  if (pressed) await page.getByRole('button', { name: 'Transparent fill' }).click()
  await page.getByLabel('Vector paint style').selectOption('solid').catch(() => undefined)
}

async function docToClient(x: number, y: number) {
  const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox()
  if (!box) throw new Error('Missing vector stage surface')
  return { clientX: box.x + (x / 480) * box.width, clientY: box.y + (y / 360) * box.height }
}

async function hoverDoc(x: number, y: number) {
  const { clientX, clientY } = await docToClient(x, y)
  await page.mouse.move(clientX, clientY, { steps: 3 })
}

async function clickDoc(x: number, y: number) {
  const { clientX, clientY } = await docToClient(x, y)
  const hit = await page.evaluate(
    ({ px, py }: { px: number; py: number }) => {
      const element = document.elementFromPoint(px, py)
      if (!element) return 'none'
      return element.closest('[data-vector-stage-surface]') ? 'canvas' : element.tagName
    },
    { px: clientX, py: clientY },
  )
  if (hit !== 'canvas') throw new Error(`Document point (${x}, ${y}) is off-canvas (hits ${hit})`)
  await page.mouse.click(clientX, clientY)
}

async function leaveSurface() {
  await page.mouse.move(8, 8, { steps: 3 })
  await page.waitForTimeout(500)
}

async function overlayHtml(): Promise<string> {
  return await page.locator('[data-testid="vector-fill-hover-preview"]').innerHTML()
}

async function overlayVisible(): Promise<boolean> {
  return await page.locator('[data-testid="vector-fill-hover-preview"]').isVisible()
}

async function waitOverlayWith(text: string, timeout = 8_000) {
  await page.waitForFunction(
    (want: string) => document.querySelector('[data-testid="vector-fill-hover-preview"]')?.innerHTML.includes(want) ?? false,
    text,
    { timeout },
  )
}

async function waitOverlayHidden(timeout = 15_000) {
  await page.waitForFunction(
    () => {
      const overlay = document.querySelector('[data-testid="vector-fill-hover-preview"]')
      if (!overlay) return true
      const rect = (overlay as HTMLElement).getBoundingClientRect()
      return rect.width === 0 && rect.height === 0 ? true : !overlay.isConnected ? true : false
    },
    undefined,
    { timeout },
  ).catch(async () => {
    const visible = await overlayVisible().catch(() => false)
    if (visible) throw new Error('fill hover overlay still visible after wait')
  })
}

async function stageShot(): Promise<Buffer> {
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
  return await page.getByTestId('costume-paint-surface').screenshot({ timeout: 30_000 })
}

async function settledStageShot(): Promise<Buffer> {
  await page.waitForTimeout(900)
  return await stageShot()
}

async function baselineStageShot(): Promise<Buffer> {
  await page.waitForTimeout(600)
  await stageShot().catch(() => undefined)
  await page.waitForTimeout(900)
  return await stageShot()
}

function decodePngToRgba(buffer: Buffer): { width: number; height: number; data: Buffer } {
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    pos += 8 + length + 4
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`)
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0
  if (channels === 0) throw new Error(`unsupported PNG color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let p = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p]!
    p += 1
    const cur = raw.subarray(p, p + stride)
    p += stride
    const recon = Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? recon[i - channels]! : 0
      const b = prev[i]!
      const c = i >= channels ? prev[i - channels]! : 0
      let v: number
      if (filter === 0) v = cur[i]!
      else if (filter === 1) v = (cur[i]! + a) & 255
      else if (filter === 2) v = (cur[i]! + b) & 255
      else if (filter === 3) v = (cur[i]! + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        v = (cur[i]! + pr) & 255
      } else throw new Error(`unsupported PNG filter ${filter} at row ${y}`)
      recon[i] = v
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4
      if (channels === 3) {
        rgba[o] = recon[x * 3]!
        rgba[o + 1] = recon[x * 3 + 1]!
        rgba[o + 2] = recon[x * 3 + 2]!
        rgba[o + 3] = 255
      } else if (channels === 4) {
        rgba[o] = recon[x * 4]!
        rgba[o + 1] = recon[x * 4 + 1]!
        rgba[o + 2] = recon[x * 4 + 2]!
        rgba[o + 3] = recon[x * 4 + 3]!
      } else {
        rgba[o] = recon[x]!
        rgba[o + 1] = recon[x]!
        rgba[o + 2] = recon[x]!
        rgba[o + 3] = 255
      }
    }
    prev = recon
  }
  return { width, height, data: rgba }
}

function surfacePixelAt(
  decoded: { width: number; height: number; data: Buffer },
  docX: number,
  docY: number,
): number[] {
  const px = Math.min(decoded.width - 1, Math.max(0, Math.round((docX / 480) * decoded.width)))
  const py = Math.min(decoded.height - 1, Math.max(0, Math.round((docY / 360) * decoded.height)))
  const o = (py * decoded.width + px) * 4
  return [decoded.data[o]!, decoded.data[o + 1]!, decoded.data[o + 2]!, decoded.data[o + 3]!]
}

async function selectionState() {
  return await page.evaluate(() => {
    const blue = document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length
    const deleteButton = document.querySelector('[data-testid="delete-editor-selection"]') as HTMLButtonElement | null
    return { blueOutlines: blue, deleteDisabled: deleteButton?.disabled ?? null }
  })
}

async function redoDisabled(): Promise<boolean> {
  const buttons = page.getByRole('button', { name: 'Redo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && !(await b.isDisabled())) return false
  }
  return true
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

function failReport(context: string, extra: unknown) {
  console.log(`[nested-integration:FAIL] ${context} ${JSON.stringify(extra).slice(0, 4000)}`)
}

describe('vector nested-island fill integration (real Editor + real VM, fail-first)', () => {
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
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 180_000)

  async function openFreshEditor(): Promise<void> {
    try {
      await page?.close()
    } catch {}
    page = await browser!.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (error) => console.log(`[nested-integration:pageerror] ${String(error).slice(0, 500)}`))
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByTestId('project-file-input').setInputFiles({
      name: 'nested-island.sb3',
      mimeType: 'application/x.scratch.sb3',
      buffer: buildSb3(),
    })
    await page.waitForFunction(
      () =>
        (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 5,
      null,
      { timeout: 20_000 },
    )
    await ensureVectorMode()
  }

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('helper vs Paper runtime: helper resolves the innermost hole, Paper still fail-closes (gap record)', async () => {
    await openFreshEditor()
    const gap = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-geometry.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const d = 'M150 110H330V250H150Z M170 130H310V190H170Z M200 140H280V180H200Z M225 150H255V170H225Z';
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><path d="${d}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`;
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const units = vectorSvg.editableVectorUnits(doc.documentElement);
      const probe = await paperVector.paperVectorHoleTargetAtPoint(units, { x: 240, y: 160 }, 0.5);
      const helperVerdict = helper.classifyHolePoint({ pathData: d, point: { x: 240, y: 160 }, fillRule: 'evenodd' });
      return { probeKind: probe.kind, helperKind: helperVerdict.kind };
    })
    // The pure helper implements the exact limited subset already.
    expect(gap.helperKind).toBe('hole')
    // Fail-first: the Paper entity probe has not been wired to the same
    // nested resolution yet (paper-vector.ts, another agent). When that
    // landing flips this to `hole`, delete the line below and keep the rest.
    expect(gap.probeKind).toBe('hole')
  }, 180_000)

  it('evenodd nested inner hole fills green with history + selection (fail-first)', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('nested-evenodd')
    await selectCostumeByName('nested-evenodd')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const beforeVm = await costumeText('Sprite1', index)
    expect(beforeVm).toContain('#ff0000')
    expect(beforeVm).toContain('evenodd')
    expect(beforeVm).not.toContain('#00ff00')
    const shotBefore = await baselineStageShot()
    await hoverDoc(INNER_PT.x, INNER_PT.y)
    try {
      await waitOverlayWith('#00ff00')
    } catch (error) {
      failReport('nested evenodd inner-hole hover overlay missing (Paper probe not wired yet)', { overlay: await overlayHtml().catch(() => 'n/a') })
      throw error
    }
    expect(await overlayHtml()).toContain('#00ff00')
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    await clickDoc(INNER_PT.x, INNER_PT.y)
    const after = await waitForVmChange('Sprite1', index, beforeVm)
    expect(after).toContain('#00ff00')
    expect(after).toContain('#ff0000')
    expect((after.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(await previewHtml()).toContain('#00ff00')
    // Reference parity: successful fills never select (no blue box).
    expect(await selectionState()).toEqual({ blueOutlines: 0, deleteDisabled: true })
    expect(Buffer.compare(shotBefore, await settledStageShot()) !== 0).toBe(true)
    const surfaceAfter = decodePngToRgba(await page.locator('[data-vector-stage-surface="true"]').screenshot({ timeout: 30_000 }))
    const innerPixel = surfacePixelAt(surfaceAfter, INNER_PT.x, INNER_PT.y)
    const isGreen = innerPixel[1]! >= 200 && innerPixel[1]! - innerPixel[0]! >= 80 && innerPixel[1]! - innerPixel[2]! >= 80
    if (!isGreen) failReport('nested inner hole lost its committed green fill', { point: INNER_PT, pixel: innerPixel })
    expect(isGreen).toBe(true)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    await leaveSurface()
    await waitOverlayHidden()
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeVm)).toBe(beforeVm)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, after)).toBe(after)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeVm)).toBe(beforeVm)
  }, 180_000)

  it('nonzero reversed-winding nested inner hole fills green (fail-first)', async () => {
    await openFreshEditor()
    await selectCostumeByName('nested-nonzero')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const index = await costumeIndexByName('nested-nonzero')
    const beforeNz = await costumeText('Sprite1', index)
    expect(beforeNz).toContain('nonzero')
    expect(beforeNz).not.toContain('#00ff00')
    await hoverDoc(INNER_PT.x, INNER_PT.y)
    try {
      await waitOverlayWith('#00ff00')
    } catch (error) {
      failReport('nested nonzero inner-hole hover overlay missing (Paper probe not wired yet)', { overlay: await overlayHtml().catch(() => 'n/a') })
      throw error
    }
    expect(await costumeText('Sprite1', index)).toBe(beforeNz)
    await clickDoc(INNER_PT.x, INNER_PT.y)
    const afterNz = await waitForVmChange('Sprite1', index, beforeNz)
    expect(afterNz).toContain('#00ff00')
    expect(afterNz).toContain('#ff0000')
    await leaveSurface()
    await waitOverlayHidden()
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeNz)).toBe(beforeNz)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, afterNz)).toBe(afterNz)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeNz)).toBe(beforeNz)
  }, 180_000)

  it('nested safety no-ops: outer ring / transparent / outside / overlap preserve history, selection, pixels', async () => {
    await openFreshEditor()
    await selectCostumeByName('nested-noop')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const index = await costumeIndexByName('nested-noop')
    const uploaded = await costumeText('Sprite1', index)
    // Bank a redo entry with a real island-ring body commit (island is
    // painted: clicking it recolors the parent, exactly like the reference).
    await clickDoc(ISLAND_RING_PT.x, ISLAND_RING_PT.y)
    const banked = await waitForVmChange('Sprite1', index, uploaded)
    expect(banked).toContain('#00ff00')
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, uploaded)).toBe(uploaded)
    expect(await redoDisabled()).toBe(false)
    // The banked body commit leaves selection cleared (reference parity);
    // Escape below is a no-op kept so the no-op pixels are artwork-only
    // (mirrors the multi-hole suite).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    expect(await selectionState()).toEqual({ blueOutlines: 0, deleteDisabled: true })
    const shotBanked = await baselineStageShot()

    // Outer ring contains the island: fail-closed no-op (no overlay content
    // change, no VM write, redo survives, pixels stay).
    await hoverDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await page.waitForTimeout(800)
    expect(await costumeText('Sprite1', index)).toBe(uploaded)
    await clickDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', index)).toBe(uploaded)
    expect(await redoDisabled()).toBe(false)
    expect(Buffer.compare(await settledStageShot(), shotBanked) === 0).toBe(true)
    expect(await selectionState()).toEqual({ blueOutlines: 0, deleteDisabled: true })

    // Transparent inner hole: no overlay, no VM write, redo survives.
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    await hoverDoc(INNER_PT.x, INNER_PT.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    await clickDoc(INNER_PT.x, INNER_PT.y)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', index)).toBe(uploaded)
    expect(await redoDisabled()).toBe(false)
    expect(Buffer.compare(await settledStageShot(), shotBanked) === 0).toBe(true)
    await page.getByRole('button', { name: 'Transparent fill' }).click()

    // Outside click: no-op without history, redo still replays the recolor.
    await clickDoc(OUTSIDE_PT.x, OUTSIDE_PT.y)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', index)).toBe(uploaded)
    expect(await redoDisabled()).toBe(false)
    expect(Buffer.compare(await settledStageShot(), shotBanked) === 0).toBe(true)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, banked)).toBe(banked)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, uploaded)).toBe(uploaded)

    // Overlapping contours: fail-closed no-op, redo preserved.
    await selectCostumeByName('overlap-nest')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#ffff00')
    const overlapIndex = await costumeIndexByName('overlap-nest')
    const beforeOverlap = await costumeText('Sprite1', overlapIndex)
    // Bank a redo entry with a real body commit outside the overlap zone:
    // (160,120) sits inside the first rect only (150,110 180x140) and outside
    // the second (200,160 150x100).
    await clickDoc(160, 120)
    const bankedOverlap = await waitForVmChange('Sprite1', overlapIndex, beforeOverlap)
    expect(bankedOverlap).not.toBe(beforeOverlap)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', overlapIndex, beforeOverlap)).toBe(beforeOverlap)
    expect(await redoDisabled()).toBe(false)
    const shotOverlapBefore = await baselineStageShot()
    // (240,200) sits inside BOTH rects: renderer-dependent overlap, no-op.
    await clickDoc(240, 200)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', overlapIndex)).toBe(beforeOverlap)
    expect(await redoDisabled()).toBe(false)
    expect(Buffer.compare(await settledStageShot(), shotOverlapBefore) === 0).toBe(true)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', overlapIndex, bankedOverlap)).toBe(bankedOverlap)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', overlapIndex, beforeOverlap)).toBe(beforeOverlap)
  }, 240_000)
})
