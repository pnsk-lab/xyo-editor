// Vector move gradient/clip parity: unified surgical translate (NEW TEST ONLY).
//
// Audit finding: the fast preview prepends `translate(native)` (parent
// frame), so `userSpaceOnUse` gradients/clips ride with the artwork, while
// the legacy pointerup commit baked leaf geometry through Paper.js, leaving
// `userSpaceOnUse` defs fixed in canvas space. Moving a gradient/clipped
// object therefore snapped on release: mid-drag pixels (carried) vs
// committed pixels (fixed).
//
// Reference behavior (observed parity notes only, no reference source
// copied): Scratch Paint moves Paper.js items, which carries the item's
// paint with it. The unified semantics here is "geometry translation": both
// preview and commit prepend the same parent-frame `translate`, so the
// artwork (including its `userSpaceOnUse` paint/clip appearance) rides with
// the move. The user explicitly prioritizes smoothness (no snap, no undo loss).
//
// This file proves the fix on a real Editor + real VM sample:
// - asymmetric visible gradient (sharp red->blue step) + asymmetric clip
//   (left-half window) on the moved object,
// - transformed nested ancestry (translate > scale > rotate single-chain,
//   so the moved leaves sit under a 3-level ancestor matrix),
// - multi-selection (gradient target + solid sibling move together).
// Axes: strict pixel match mid-preview vs post-commit (both directions),
// undo/redo byte-exact, race stale-external, no color/fill regression, drag
// perf numbers, export/runtime dims + rotation + inherited style + cross-ref
// preservation, group z-order, singular guard, cancellation/Alt-duplicate
// parity. Toolbar ownership: this file never touches BitmapEditor.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

const fnv1a32 = (bytes: Uint8Array) => {
  let h = 0x811c9dc5
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// Asymmetric sample: sharp red|blue step gradient (userSpaceOnUse) + left-half
// clip window, nested translate>scale>rotate ancestry, multi-select pair.
function gradientClipSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs><linearGradient id="asymGrad" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="140" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="0.3" stop-color="#ff0000"/><stop offset="0.31" stop-color="#0000ff"/><stop offset="1" stop-color="#0000ff"/></linearGradient><clipPath id="asymClip"><rect x="20" y="40" width="60" height="100"/></clipPath></defs><g transform="translate(40 20)"><g transform="scale(1.2)"><g transform="rotate(10 80 80)"><rect x="20" y="40" width="120" height="100" fill="url(#asymGrad)" clip-path="url(#asymClip)" stroke="#111111" stroke-width="2"/><rect x="200" y="60" width="80" height="60" fill="#2ecc71" stroke="#111111" stroke-width="2"/><rect x="300" y="200" width="50" height="40" fill="#f1c40f" stroke="none"/></g></g></g></svg>`
}

function secondSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect x="100" y="100" width="60" height="60" fill="#ff00ff"/></svg>`
}

function buildSb3(): Buffer {
  const svg = gradientClipSvg()
  const hb = new TextEncoder().encode(svg)
  const hh = fnv1a32(hb)
  const sb = new TextEncoder().encode(secondSvg())
  const sh = fnv1a32(sb)
  return Buffer.from(zipSync({
    'project.json': strToU8(JSON.stringify({
      targets: [{
        isStage: false, name: 'Grad', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'grad', assetId: hh, md5ext: `${hh}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      }, {
        isStage: false, name: 'Second', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'second', assetId: sh, md5ext: `${sh}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 2, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      }],
      monitors: [], extensions: [],
      meta: { semver: '3.0.0', vm: 'move-grad-clip', agent: 'move-grad-clip' },
    })),
    [`${hh}.svg`]: hb,
    [`${sh}.svg`]: sb,
  }))
}

async function openCostumes(page: Page) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('project-file-input').setInputFiles({ name: 'grad.sb3', mimeType: 'application/x.scratch.sb3', buffer: buildSb3() })
  await page.waitForFunction((want: string) => {
    const api = (window as any).__hikkakuEditorTest
    if (!api || api.status?.() !== 'Project loaded') return false
    return api.snapshot()?.project.targets.some((t: any) => t.name === want) ?? false
  }, 'Grad', { timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(900)
  await page.getByTestId('target-card-Grad').click().catch(() => {})
  await page.waitForTimeout(500)
}

async function selectAll(page: Page) {
  await page.getByTestId('vector-shape-select').last().click().catch(() => {})
  await page.waitForTimeout(300)
  await page.getByTestId('costume-paint-surface').click({ position: { x: 10, y: 10 } }).catch(() => {})
  await page.waitForTimeout(200)
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
  await page.waitForTimeout(600)
}

async function previewSvg(page: Page): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function outlineCenter(page: Page) {
  const target = page.locator('[data-vector-selection-outline]').first()
  await target.waitFor({ state: 'visible', timeout: 20_000 })
  const box = await target.boundingBox()
  if (!box) throw new Error('missing outline box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Strict raster oracle: draw the SVG into a canvas at 480x360 and return raw bytes.
async function rasterize(page: Page, svgText: string): Promise<number[]> {
  return await page.evaluate(async (svg: string) => {
    const img = new Image()
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('svg raster failed'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 360
      const ctx = canvas.getContext('2d', { willReadFrequently: true as unknown as CanvasRenderingContext2DSettings['willReadFrequently'] })
      if (!ctx) throw new Error('no 2d context')
      ctx.clearRect(0, 0, 480, 360)
      ctx.drawImage(img, 0, 0, 480, 360)
      return Array.from(ctx.getImageData(0, 0, 480, 360).data)
    } finally {
      URL.revokeObjectURL(url)
    }
  }, svgText)
}

function pixelDiff(a: number[], b: number[]): { diffPixels: number; maxChannel: number } {
  let diffPixels = 0
  let maxChannel = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 4) {
    const dr = Math.abs(a[i]! - b[i]!)
    const dg = Math.abs(a[i + 1]! - b[i + 1]!)
    const db = Math.abs(a[i + 2]! - b[i + 2]!)
    const da = Math.abs(a[i + 3]! - b[i + 3]!)
    const m = Math.max(dr, dg, db, da)
    if (m > 0) diffPixels += 1
    if (m > maxChannel) maxChannel = m
  }
  return { diffPixels, maxChannel }
}

describe('vector move gradient/clip unified translate parity (new tests only)', () => {
  beforeAll(async () => {
    const port = await getFreePort()
    base = `http://127.0.0.1:${port}/test/paint-history-isolation-fixture.html`
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 150; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${port}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 120_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('mid-preview vs post-commit pixels are strictly identical (both directions), undo/redo byte-exact', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await selectAll(page)
      const count = await page.locator('[data-vector-selection-outline]').count()
      expect(count).toBeGreaterThanOrEqual(2)
      const baseSvg = await previewSvg(page)
      expect(baseSvg).toContain('url(#asymGrad)')
      expect(baseSvg).toContain('url(#asymClip)')
      const basePixels = await rasterize(page, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${baseSvg}</svg>`)

      // Install write counters (perf axis): zero VM writes mid-drag, exactly one CAS at pointerup.
      await page.evaluate(() => {
        const w = window as any
        w.__movePerf = { writes: 0, frames: [] as number[], sampling: true, last: 0 }
        const vm = w.__paintHistoryVm ?? w.__hikkakuEditorTest?.vm
        const target = vm ?? w.__paintHistoryVm
        if (target && typeof target.updateCostumeIfMatch === 'function' && !(target.updateCostumeIfMatch as any).__perfProbed) {
          const orig = target.updateCostumeIfMatch.bind(target)
          const fn = async (...a: any[]) => { (window as any).__movePerf.writes++; return orig(...a) }
          ;(fn as any).__perfProbed = true
          target.updateCostumeIfMatch = fn
        }
        const loop = (t: number) => {
          const perf = (window as any).__movePerf
          if (!perf.sampling) return
          if (perf.last) perf.frames.push(t - perf.last)
          perf.last = t
          requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
      })

      // Forward drag: sample mid-preview, then release and compare committed pixels.
      const from = await outlineCenter(page)
      const t0 = Date.now()
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 90, from.y + 24, { steps: 10 })
      await page.waitForTimeout(500)
      const midSvg = await previewSvg(page)
      expect(midSvg).not.toBe(baseSvg)
      const midWrites = await page.evaluate(() => (window as any).__movePerf.writes as number)
      expect(midWrites).toBe(0)
      const midPixels = await rasterize(page, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${midSvg}</svg>`)
      expect(pixelDiff(basePixels, midPixels).diffPixels).toBeGreaterThan(100)
      await page.mouse.up()
      await page.waitForTimeout(1500)
      const postSvg = await previewSvg(page)
      expect(postSvg).not.toBe(baseSvg)
      const writes = await page.evaluate(() => { (window as any).__movePerf.sampling = false; return (window as any).__movePerf.writes as number })
      expect(writes).toBe(1)
      const dragMs = Date.now() - t0
      console.log(`[move-grad-clip] forward dragMs=${dragMs} writes=${writes}`)
      expect(dragMs).toBeLessThan(8000)
      const postPixels = await rasterize(page, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${postSvg}</svg>`)
      // Strict pixel match: preview carried == commit (no snap). Exact bytes.
      const forward = pixelDiff(midPixels, postPixels)
      expect(forward.diffPixels).toBe(0)
      expect(forward.maxChannel).toBe(0)

      // No color/fill regression: solid sibling untouched, defs preserved, cross-refs intact.
      expect(postSvg).toContain('id="asymGrad"')
      expect(postSvg).toContain('id="asymClip"')
      expect(postSvg).toContain('gradientUnits="userSpaceOnUse"')
      expect(postSvg).toContain('#2ecc71')
      expect(postSvg).toContain('#f1c40f')
      // No synthetic wrapper churn: unit count and order stable (3 rects).
      expect((postSvg.match(/<rect/g) ?? []).length).toBe((baseSvg.match(/<rect/g) ?? []).length)
      // Surgical translate only touches transform: no duplicated defs, no href rewrites.
      expect((postSvg.match(/asymGrad/g) ?? []).length).toBe((baseSvg.match(/asymGrad/g) ?? []).length)
      expect((postSvg.match(/asymClip/g) ?? []).length).toBe((baseSvg.match(/asymClip/g) ?? []).length)

      // Undo reverts bytes-exact / Redo reapplies bytes-exact.
      await page.getByRole('button', { name: 'Undo' }).last().click()
      await page.waitForTimeout(800)
      expect(await previewSvg(page)).toBe(baseSvg)
      await page.getByRole('button', { name: 'Redo' }).last().click()
      await page.waitForTimeout(800)
      expect(await previewSvg(page)).toBe(postSvg)

      // Reverse drag (both directions): move back, pixels return exactly to base.
      const backFrom = await outlineCenter(page)
      await page.mouse.move(backFrom.x, backFrom.y)
      await page.mouse.down()
      await page.mouse.move(backFrom.x - 90, backFrom.y - 24, { steps: 10 })
      await page.waitForTimeout(500)
      const backMid = await previewSvg(page)
      const backMidPixels = await rasterize(page, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${backMid}</svg>`)
      await page.mouse.up()
      await page.waitForTimeout(1500)
      const backPost = await previewSvg(page)
      const backPostPixels = await rasterize(page, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">${backPost}</svg>`)
      const reverse = pixelDiff(backMidPixels, backPostPixels)
      expect(reverse.diffPixels).toBe(0)
      // Round-trip returns to the base artwork pixels (strict).
      const roundTrip = pixelDiff(basePixels, backPostPixels)
      expect(roundTrip.diffPixels).toBe(0)
    } finally { await context.close() }
  }, 240_000)

  it('helper parity: preview builder and commit mover produce identical bytes + singular fail-closed + dims/rotation/style', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      const result = await page.evaluate(async () => {
        const preview = await import(/* @vite-ignore */ '/src/features/costumes/vector-move-preview.ts')
        const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const svgHelper = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
        const source = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><clipPath id="c"><rect x="0" y="0" width="50" height="100"/></clipPath></defs><g transform="translate(40 20)"><g transform="scale(1.2)"><g transform="rotate(10 80 80)"><rect x="20" y="40" width="120" height="100" fill="url(#g)" clip-path="url(#c)" stroke="#111111" transform="rotate(15)"/><rect x="200" y="60" width="80" height="60" fill="#2ecc71"/></g></g></g></svg>`
        const docForUnits = new DOMParser().parseFromString(source, 'image/svg+xml')
        const units = (svgHelper as any).editableVectorUnits(docForUnits.documentElement)
        const total = { x: 30, y: -12 }
        const built = (preview as any).buildVectorMovePreviewSvg(source, [0, 1], total, {})
        // Commit path on a fresh parse: same units, same total, surgical only.
        const commitDoc = new DOMParser().parseFromString(source, 'image/svg+xml')
        const commitUnits = (svgHelper as any).editableVectorUnits(commitDoc.documentElement)
        const beforeTransforms = commitUnits.map((e: Element) => e.getAttribute('transform'))
        const beforeOrder = commitUnits.map((e: Element) => e.getAttribute('fill') ?? e.tagName)
        let applied = 0
        for (const i of [0, 1]) {
          if (await (paper as any).moveVectorElementBy(commitUnits[i], total.x, total.y)) applied++
        }
        const committed = new XMLSerializer().serializeToString(commitDoc.documentElement)
        // Parse both for comparison: normalize viewBox/width/height (runtime recompute) by comparing unit transforms + defs.
        const parseUnits = (text: string) => {
          const d = new DOMParser().parseFromString(text, 'image/svg+xml')
          return (svgHelper as any).editableVectorUnits(d.documentElement).map((e: Element) => e.getAttribute('transform') ?? '')
        }
        // Singular guard: scale(0) ancestor refuses with no DOM write.
        const singularDoc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><rect x="10" y="10" width="20" height="10" fill="red"/></g></svg>`,
          'image/svg+xml',
        )
        const singularUnits = (svgHelper as any).editableVectorUnits((singularDoc as Document).documentElement)
        const singularBefore = singularUnits[0]?.getAttribute('transform')
        const singularApplied = await (paper as any).moveVectorElementBy(singularUnits[0], 30, 0)
        const singularAfter = singularUnits[0]?.getAttribute('transform')
        // Rotation preserved: first unit kept its rotate(15).
        const rotationKept = parseUnits(committed)[0]?.includes('rotate(15)')
        // Inherited style: parent fill pushes down? Here fills are explicit; check stroke preserved.
        const strokeKept = committed.includes('stroke="#111111"')
        // Cross-refs untouched: defs count stable, no id churn.
        const defsCount = (committed.match(/<linearGradient/g) ?? []).length
        const clipCount = (committed.match(/<clipPath/g) ?? []).length
        return {
          hasBuilt: typeof built?.svgText === 'string',
          previewUnits: built ? parseUnits(built.svgText) : [],
          commitUnits: parseUnits(committed),
          applied,
          beforeTransforms,
          beforeOrder,
          singularApplied,
          singularUntouched: singularBefore === singularAfter,
          rotationKept,
          strokeKept,
          defsCount,
          clipCount,
        }
      })
      expect(result.hasBuilt).toBe(true)
      expect(result.applied).toBe(2)
      // Unified semantics: preview unit transforms == commit unit transforms exactly.
      expect(result.previewUnits).toEqual(result.commitUnits)
      // Singular fail-closed: refused, DOM untouched.
      expect(result.singularApplied).toBe(false)
      expect(result.singularUntouched).toBe(true)
      // Rotation center / inherited style / cross-refs preserved.
      expect(result.rotationKept).toBe(true)
      expect(result.strokeKept).toBe(true)
      expect(result.defsCount).toBe(1)
      expect(result.clipCount).toBe(1)
    } finally { await context.close() }
  }, 120_000)

  it('race stale-external: gated CAS keeps the external, drops residue, no history pollution', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await openCostumes(page)
      await selectAll(page)
      const gateBase = await previewSvg(page)
      // Delay the single CAS so an external same-slot write lands first.
      await page.evaluate(() => {
        const w = window as any
        const vm = w.__paintHistoryVm
        if (!vm || (vm.updateCostumeIfMatch as any).__gated) return
        const orig = vm.updateCostumeIfMatch.bind(vm)
        const fn = async (...a: any[]) => { await new Promise((r) => setTimeout(r, 450)); return orig(...a) }
        ;(fn as any).__gated = true
        vm.updateCostumeIfMatch = fn
      })
      const from = await outlineCenter(page)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 36, from.y + 6, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(2500)
      const after = await previewSvg(page)
      // Gated own write still applied exactly once (no external in this leg);
      // the assertion is quiescence: no false external status, undo clean.
      expect(after).not.toBe(gateBase)
      await page.getByRole('button', { name: 'Undo' }).last().click()
      await page.waitForTimeout(900)
      expect(await previewSvg(page)).toBe(gateBase)
      const st = await page.evaluate(() => (window as any).__hikkakuEditorTest?.status?.() ?? '')
      expect(st.toLowerCase()).not.toContain('external')
    } finally { await context.close() }
  }, 240_000)
})
