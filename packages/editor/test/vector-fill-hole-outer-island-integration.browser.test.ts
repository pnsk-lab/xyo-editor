import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Outer-hole-with-island fill integration (real Editor + real VM + real pixels).
//
// Safe subset (V-5): exactly 3 straight laminar contours (outer -> hole ->
// island), evenodd or alternating-nonzero, translated/rotated (similarity),
// no CSS clip/mask/class/defs-url. The overlay is the reference-solid hole
// subpath only (single contour, sibling directly above the parent), so the
// fill paints the outer ring with the toolbar paint while the island
// underneath is covered per reference (reversible: source untouched, Undo
// removes the sibling and restores the island). The commit path
// (`fillVectorHoleOverlayAtPoint` in Editor.svelte) is untouched: it copies
// the probe `d` verbatim as a sibling, so hover and commit agree byte-for-byte
// by construction. Independent oracles (Chromium Canvas2D solid alpha 255 at
// ring+island, Paper hole-child contains island with 0 intersections) prove
// the covering.
//
// Self-made fixtures only (no upstream transcription, no AGPL copy).
const root = join(import.meta.dir, '..')
const PORT = 4495
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const OUTER = 'M150 110H330V250H150Z'
const HOLE = 'M170 130H310V190H170Z'
const ISLAND = 'M200 140H280V180H200Z'
const HOLE_REV = 'M170 130V190H310V130H170Z'
const SIBLING = '<rect x="40" y="40" width="60" height="40" fill="#0000ff" stroke="none"/>'
const EVENODD_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE} ${ISLAND}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>${SIBLING}</svg>`
const NONZERO_ALT_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE_REV} ${ISLAND}" fill="#ff0000" fill-rule="nonzero" stroke="none"/>${SIBLING}</svg>`
// Wrong winding: hole runs the same direction as outer, so under nonzero the
// outer ring is painted (no hole). The probe must not yield a hole overlay.
const NONZERO_WRONG_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE} ${ISLAND}" fill="#ff0000" fill-rule="nonzero" stroke="none"/>${SIBLING}</svg>`
const TRANSLATED_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE} ${ISLAND}" fill="#ff0000" fill-rule="evenodd" stroke="none" transform="translate(30 20)"/>${SIBLING}</svg>`
const CLIP_SVG =
  `${HEAD}<path d="${OUTER} ${HOLE} ${ISLAND}" fill="#ff0000" fill-rule="evenodd" stroke="none" clip-path="url(#c)"/><clipPath id="c"><rect x="0" y="0" width="10" height="10"/></clipPath>${SIBLING}</svg>`
const OVERLAP_SVG =
  `${HEAD}<path d="M150 110H330V250H150Z M200 160H350V260H200Z" fill="#ff0000" fill-rule="evenodd" stroke="none"/>${SIBLING}</svg>`
const STAGE_SVG =
  `${HEAD}<rect x="20" y="20" width="60" height="40" fill="#888888" stroke="none"/></svg>`

// Local (untransformed) sample points for the 3-nest.
const OUTER_RING_PT = { x: 180, y: 160 }
const ISLAND_PT = { x: 240, y: 160 }
const BODY_PT = { x: 160, y: 240 }
const SIBLING_PT = { x: 70, y: 60 }
const OUTSIDE_PT = { x: 240, y: 90 }
// translate(30 20) maps local (x,y) -> (x+30, y+20).
const TRANSLATED_RING_PT = { x: OUTER_RING_PT.x + 30, y: OUTER_RING_PT.y + 20 }
const TRANSLATED_ISLAND_PT = { x: ISLAND_PT.x + 30, y: ISLAND_PT.y + 20 }

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
  const evenodd = add(EVENODD_SVG)
  const nonzeroAlt = add(NONZERO_ALT_SVG)
  const nonzeroWrong = add(NONZERO_WRONG_SVG)
  const translated = add(TRANSLATED_SVG)
  const clip = add(CLIP_SVG)
  const overlap = add(OVERLAP_SVG)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name, ...ref, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180,
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
          costume(evenodd, 'outer-evenodd'),
          costume(nonzeroAlt, 'outer-nonzero-alt'),
          costume(nonzeroWrong, 'outer-nonzero-wrong'),
          costume(translated, 'outer-translated'),
          costume(clip, 'outer-clip'),
          costume(overlap, 'outer-overlap'),
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'vector-fill-outer-island-integration' },
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
    if (Date.now() - start > timeout) throw new Error(`VM text timeout ${target}[${index}]`)
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

async function hoverOverlayPathD(): Promise<string | null> {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-testid="vector-fill-hover-preview"]')
    const paths = Array.from(host?.querySelectorAll('path') ?? [])
    // The overlay is the appended sibling: prefer a green-filled path, else the last path.
    const green = paths.find((p) => (p.getAttribute('fill') ?? '').toLowerCase().includes('00ff00'))
      ?? paths.find((p) => (p.getAttribute('fill') ?? '').includes('url('))
      ?? paths[paths.length - 1]
    return green?.getAttribute('d') ?? null
  })
}

async function stageShot(): Promise<Buffer> {
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
  return await page.getByTestId('costume-paint-surface').screenshot({ timeout: 30_000 })
}

async function stageSurfaceShot(): Promise<Buffer> {
  await page.locator('[data-vector-stage-surface="true"]').waitFor({ state: 'visible', timeout: 15_000 })
  return await page.locator('[data-vector-stage-surface="true"]').screenshot({ timeout: 30_000 })
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

function isGreen(p: number[]) {
  return p[1]! >= 150 && p[1]! - p[0]! >= 60 && p[1]! - p[2]! >= 60
}
function isRed(p: number[]) {
  return p[0]! >= 150 && p[0]! - p[1]! >= 60 && p[0]! - p[2]! >= 60
}
function isBlue(p: number[]) {
  return p[2]! >= 150 && p[2]! - p[0]! >= 60 && p[2]! - p[1]! >= 60
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

function committedOverlayD(vmText: string): string | null {
  const docMatch = vmText.match(/<path[^>]*d="([^"]+)"[^>]*fill="#00ff00"[^>]*\/>/)
    ?? vmText.match(/<path[^>]*fill="#00ff00"[^>]*d="([^"]+)"[^>]*\/>/)
  return docMatch?.[1] ?? null
}

describe('vector outer-island fill integration (real Editor + real VM + pixels)', () => {
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
    page.on('pageerror', (error) => console.log(`[outer-island:pageerror] ${String(error).slice(0, 500)}`))
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByTestId('project-file-input').setInputFiles({
      name: 'outer-island.sb3',
      mimeType: 'application/x.scratch.sb3',
      buffer: buildSb3(),
    })
    await page.waitForFunction(
      () =>
        (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 6,
      null,
      { timeout: 20_000 },
    )
    await ensureVectorMode()
  }

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('Paper + Canvas oracles agree the outer ring is unfilled and the probe yields the reference-solid hole', async () => {
    await openFreshEditor()
    const result = await page.evaluate(async () => {
      const outerHelper = await import(/* @vite-ignore */ '/src/features/costumes/vector-fill-hole-outer-island.ts');
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const d = 'M150 110H330V250H150Z M170 130H310V190H170Z M200 140H280V180H200Z';
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><path d="${d}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`;
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const alphaAt = (x: number, y: number, rule: CanvasFillRule) => {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#ff0000';
        ctx.fill(new Path2D(d), rule);
        return ctx.getImageData(x, y, 1, 1).data[3]!;
      };
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const units = vectorSvg.editableVectorUnits(doc.documentElement);
      const probe = await paperVector.paperVectorHoleTargetAtPoint(units, { x: 180, y: 160 }, 0.5);
      const pure = outerHelper.classifyOuterIslandHolePoint({ pathData: d, point: { x: 180, y: 160 }, fillRule: 'evenodd' });
      // The committed solid covers the island under both rules (reference parity).
      let overlayEvenodd = -1;
      let overlayNonzero = -1;
      if (pure.kind === 'hole') {
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#00ff00';
        ctx.fill(new Path2D(pure.overlayPathData), 'evenodd');
        overlayEvenodd = ctx.getImageData(240, 160, 1, 1).data[3]!;
        ctx.clearRect(0, 0, 480, 360);
        ctx.fillStyle = '#00ff00';
        ctx.fill(new Path2D(pure.overlayPathData), 'nonzero');
        overlayNonzero = ctx.getImageData(240, 160, 1, 1).data[3]!;
      }
      return {
        canvasRing: alphaAt(180, 160, 'evenodd'),
        canvasIsland: alphaAt(240, 160, 'evenodd'),
        canvasBody: alphaAt(160, 240, 'evenodd'),
        pureKind: pure.kind,
        overlayD: pure.kind === 'hole' ? pure.overlayPathData : null,
        overlayEvenodd,
        overlayNonzero,
        probeKind: probe.kind,
        probeD: probe.kind === 'hole' ? probe.target.holePathData : null,
      };
    })
    // Canvas truth: outer ring empty, island + body painted.
    expect(result.canvasRing).toBe(0)
    expect(result.canvasIsland).toBeGreaterThan(200)
    expect(result.canvasBody).toBeGreaterThan(200)
    // Pure gate resolves the reference-solid hole (single contour).
    expect(result.pureKind).toBe('hole')
    expect(result.overlayD?.match(/M/g)?.length).toBe(1)
    // The solid covers the island under both rules (reference parity).
    expect(result.overlayEvenodd).toBeGreaterThan(200)
    expect(result.overlayNonzero).toBeGreaterThan(200)
    // The Paper entity probe agrees (independent oracle, not the pure module).
    expect(result.probeKind).toBe('hole')
    expect(result.probeD?.match(/M/g)?.length).toBe(1)
  }, 180_000)

  it('evenodd outer hole fills green with island covered, exact Undo/Redo, hover equals commit', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('outer-evenodd')
    await selectCostumeByName('outer-evenodd')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const beforeVm = await costumeText('Sprite1', index)
    expect(beforeVm).toContain('#ff0000')
    expect(beforeVm).not.toContain('#00ff00')
    const shotBefore = await baselineStageShot()
    const beforeDecoded = decodePngToRgba(await stageSurfaceShot())
    const siblingBefore = surfacePixelAt(beforeDecoded, SIBLING_PT.x, SIBLING_PT.y)

    // Hover previews the reference-solid hole in green; nothing is written.
    await hoverDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await waitOverlayWith('#00ff00')
    const hoverD = await hoverOverlayPathD()
    expect(hoverD?.match(/M/g)?.length).toBe(1)
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)

    // Commit: one sibling overlay, parent kept, island covered per reference.
    await clickDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    const after = await waitForVmChange('Sprite1', index, beforeVm)
    expect(after).toContain('#00ff00')
    expect(after).toContain('#ff0000')
    expect(after).toContain('#0000ff')
    expect((after.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2)
    const overlayD = committedOverlayD(after)
    expect(overlayD?.match(/M/g)?.length).toBe(1)
    // Hover equals commit: the previewed `d` is the committed `d`.
    expect(overlayD?.replace(/\s+/g, ' ').trim()).toBe(hoverD?.replace(/\s+/g, ' ').trim())
    expect(await selectionState()).toEqual({ blueOutlines: 0, deleteDisabled: true })

    // Pixels: outer ring green, island covered green (reference parity),
    // body stays red, sibling stays blue.
    const surfaceAfter = decodePngToRgba(await page.locator('[data-vector-stage-surface="true"]').screenshot({ timeout: 30_000 }))
    expect(isGreen(surfacePixelAt(surfaceAfter, OUTER_RING_PT.x, OUTER_RING_PT.y))).toBe(true)
    expect(isGreen(surfacePixelAt(surfaceAfter, ISLAND_PT.x, ISLAND_PT.y))).toBe(true)
    expect(isRed(surfacePixelAt(surfaceAfter, BODY_PT.x, BODY_PT.y))).toBe(true)
    expect(isBlue(surfacePixelAt(surfaceAfter, SIBLING_PT.x, SIBLING_PT.y))).toBe(true)
    expect(isBlue(siblingBefore)).toBe(true)
    expect(Buffer.compare(shotBefore, await settledStageShot()) !== 0).toBe(true)

    // Undo/Redo are byte-exact.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    await leaveSurface()
    await waitOverlayHidden()
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeVm)).toBe(beforeVm)
    // Undo restores the ring + island pixels exactly.
    const surfaceUndo = decodePngToRgba(await page.locator('[data-vector-stage-surface="true"]').screenshot({ timeout: 30_000 }))
    expect(isRed(surfacePixelAt(surfaceUndo, ISLAND_PT.x, ISLAND_PT.y))).toBe(true)
    expect(isBlue(surfacePixelAt(surfaceUndo, SIBLING_PT.x, SIBLING_PT.y))).toBe(true)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, after)).toBe(after)
    const surfaceRedo = decodePngToRgba(await page.locator('[data-vector-stage-surface="true"]').screenshot({ timeout: 30_000 }))
    expect(isGreen(surfacePixelAt(surfaceRedo, OUTER_RING_PT.x, OUTER_RING_PT.y))).toBe(true)
    expect(isGreen(surfacePixelAt(surfaceRedo, ISLAND_PT.x, ISLAND_PT.y))).toBe(true)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeVm)).toBe(beforeVm)
  }, 180_000)

  it('nonzero alternating winding fills; translated twin fills at its document point', async () => {
    await openFreshEditor()
    // Alternating nonzero.
    await selectCostumeByName('outer-nonzero-alt')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const altIndex = await costumeIndexByName('outer-nonzero-alt')
    const beforeAlt = await costumeText('Sprite1', altIndex)
    expect(beforeAlt).toContain('nonzero')
    await hoverDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await waitOverlayWith('#00ff00')
    await clickDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    const afterAlt = await waitForVmChange('Sprite1', altIndex, beforeAlt)
    expect(afterAlt).toContain('#00ff00')
    const surfaceAlt = decodePngToRgba(await page.locator('[data-vector-stage-surface="true"]').screenshot({ timeout: 30_000 }))
    expect(isGreen(surfacePixelAt(surfaceAlt, OUTER_RING_PT.x, OUTER_RING_PT.y))).toBe(true)
    expect(isGreen(surfacePixelAt(surfaceAlt, ISLAND_PT.x, ISLAND_PT.y))).toBe(true)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', altIndex, beforeAlt)).toBe(beforeAlt)

    // Translated twin: same local ring, shifted document point.
    await selectCostumeByName('outer-translated')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const trIndex = await costumeIndexByName('outer-translated')
    const beforeTr = await costumeText('Sprite1', trIndex)
    await hoverDoc(TRANSLATED_RING_PT.x, TRANSLATED_RING_PT.y)
    await waitOverlayWith('#00ff00')
    await clickDoc(TRANSLATED_RING_PT.x, TRANSLATED_RING_PT.y)
    const afterTr = await waitForVmChange('Sprite1', trIndex, beforeTr)
    expect(afterTr).toContain('#00ff00')
    const surfaceTr = decodePngToRgba(await page.locator('[data-vector-stage-surface="true"]').screenshot({ timeout: 30_000 }))
    expect(isGreen(surfacePixelAt(surfaceTr, TRANSLATED_RING_PT.x, TRANSLATED_RING_PT.y))).toBe(true)
    expect(isGreen(surfacePixelAt(surfaceTr, TRANSLATED_ISLAND_PT.x, TRANSLATED_ISLAND_PT.y))).toBe(true)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', trIndex, beforeTr)).toBe(beforeTr)
  }, 240_000)

  it('transparent + both-transparent gradient stay empty; opaque gradient fills with island covered', async () => {
    await openFreshEditor()
    await selectCostumeByName('outer-evenodd')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const index = await costumeIndexByName('outer-evenodd')
    const uploaded = await costumeText('Sprite1', index)
    // Bank a redo entry with a real outer-ring commit.
    await clickDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    const banked = await waitForVmChange('Sprite1', index, uploaded)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, uploaded)).toBe(uploaded)
    expect(await redoDisabled()).toBe(false)
    const shotBanked = await baselineStageShot()

    // Solid transparent: no overlay, no VM write, redo survives, pixels stay.
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    await hoverDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    await clickDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', index)).toBe(uploaded)
    expect(await redoDisabled()).toBe(false)
    expect(Buffer.compare(await settledStageShot(), shotBanked) === 0).toBe(true)
    await page.getByRole('button', { name: 'Transparent fill' }).click()

    // Opaque horizontal gradient: overlay carries gradient defs, island covered per reference.
    await page.getByLabel('Vector paint style').selectOption('horizontal')
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    await hoverDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await page.waitForFunction(
      () => {
        const html = document.querySelector('[data-testid="vector-fill-hover-preview"]')?.innerHTML ?? ''
        return html.includes('linearGradient') && html.includes('url(')
      },
      undefined,
      { timeout: 15_000 },
    )
    const gradientHoverD = await hoverOverlayPathD()
    expect(gradientHoverD?.match(/M/g)?.length).toBe(1)
    await clickDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    const afterGradient = await waitForVmChange('Sprite1', index, uploaded)
    expect(afterGradient).toContain('linearGradient')
    expect(afterGradient).toContain('url(')
    expect(afterGradient).toContain('#ff0000')
    const surfaceGradient = decodePngToRgba(await page.locator('[data-vector-stage-surface="true"]').screenshot({ timeout: 30_000 }))
    // Reference-solid gradient covers the island, so it is no longer pure red;
    // the opaque sibling underneath stays blue (layering preserved).
    expect(isRed(surfacePixelAt(surfaceGradient, ISLAND_PT.x, ISLAND_PT.y))).toBe(false)
    expect(isBlue(surfacePixelAt(surfaceGradient, SIBLING_PT.x, SIBLING_PT.y))).toBe(true)
    // The gradient overlay paints the ring (pixels change) and covers the island.
    const ringPix = surfacePixelAt(surfaceGradient, OUTER_RING_PT.x, OUTER_RING_PT.y)
    expect(ringPix[1]! >= 80).toBe(true)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, uploaded)).toBe(uploaded)
    await page.getByLabel('Vector paint style').selectOption('solid').catch(() => undefined)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, afterGradient)).toBe(afterGradient)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, uploaded)).toBe(uploaded)
  }, 240_000)

  it('wrong winding + clip + overlap stay fail-closed with history and pixels preserved', async () => {
    await openFreshEditor()
    await selectCostumeByName('outer-nonzero-wrong')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
    const wrongIndex = await costumeIndexByName('outer-nonzero-wrong')
    const beforeWrong = await costumeText('Sprite1', wrongIndex)
    const probeWrong = await page.evaluate(async () => {
      const paperVector = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts');
      const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts');
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><path d="M150 110H330V250H150Z M170 130H310V190H170Z M200 140H280V180H200Z" fill="#ff0000" fill-rule="nonzero" stroke="none"/></svg>`;
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const units = vectorSvg.editableVectorUnits(doc.documentElement);
      return (await paperVector.paperVectorHoleTargetAtPoint(units, { x: 180, y: 160 }, 0.5)).kind;
    })
    // Same-direction nonzero paints the ring: no hole overlay may be claimed.
    expect(probeWrong).not.toBe('hole')
    const shotWrongBefore = await baselineStageShot()
    await clickDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await page.waitForTimeout(600)
    // Same-color body recolor (if any) adds no sibling overlay path: the
    // <path> count must be unchanged (the base 3-subpath path stays alone).
    const afterWrong = await costumeText('Sprite1', wrongIndex)
    const pathsBeforeWrong = (beforeWrong.match(/<path/g) ?? []).length
    const pathsAfterWrong = (afterWrong.match(/<path/g) ?? []).length
    expect(pathsAfterWrong).toBe(pathsBeforeWrong)
    expect(Buffer.compare(await settledStageShot(), shotWrongBefore) === 0).toBe(true)
    expect(await selectionState()).toEqual({ blueOutlines: 0, deleteDisabled: true })
    void beforeWrong

    // Clip-path unit: fail-closed unsupported, no write.
    await selectCostumeByName('outer-clip')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const clipIndex = await costumeIndexByName('outer-clip')
    const beforeClip = await costumeText('Sprite1', clipIndex)
    await clickDoc(OUTER_RING_PT.x, OUTER_RING_PT.y)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', clipIndex)).toBe(beforeClip)

    // Overlapping contours: fail-closed, redo preserved.
    await selectCostumeByName('outer-overlap')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#ffff00')
    const overlapIndex = await costumeIndexByName('outer-overlap')
    const beforeOverlap = await costumeText('Sprite1', overlapIndex)
    await clickDoc(160, 120)
    const bankedOverlap = await waitForVmChange('Sprite1', overlapIndex, beforeOverlap)
    expect(bankedOverlap).not.toBe(beforeOverlap)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', overlapIndex, beforeOverlap)).toBe(beforeOverlap)
    expect(await redoDisabled()).toBe(false)
    const shotOverlapBefore = await baselineStageShot()
    await clickDoc(240, 200)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', overlapIndex)).toBe(beforeOverlap)
    expect(await redoDisabled()).toBe(false)
    expect(Buffer.compare(await settledStageShot(), shotOverlapBefore) === 0).toBe(true)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', overlapIndex, bankedOverlap)).toBe(bankedOverlap)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', overlapIndex, beforeOverlap)).toBe(beforeOverlap)

    // Outside click: no-op.
    await selectCostumeByName('outer-evenodd')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const evenIndex = await costumeIndexByName('outer-evenodd')
    const beforeEven = await costumeText('Sprite1', evenIndex)
    await clickDoc(OUTSIDE_PT.x, OUTSIDE_PT.y)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', evenIndex)).toBe(beforeEven)
  }, 240_000)
})
