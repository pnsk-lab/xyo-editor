import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Persistent curved-hole fill integration (real Editor + real VM, no product change).
//
// Scope: curved `d` (`C/S/Q/T/A`) holes through the REAL costume editor UI
// (fill tool hover/click, Undo/Redo buttons) checked against the REAL VM saved
// SVG bytes (`__paintHistoryVm.loadAsset`) plus REAL canvas pixels
// (`costume-paint-surface` screenshots). No static helper is asserted alone:
// pure-geometry modules are never imported here; Canvas/Paper oracles from
// other suites are not reused as substitutes.
//
// Self-made fixtures only (no upstream transcription): one outer rectangle
// with two arc holes, a 4-cubic circle hole, S- and Q/T-smooth holes, a
// relative-`m` second arc hole, and an ancestor-translate wrapper. All
// coordinates are original to this file. The 2-segment cubic "lens" (Canvas
// hole vs Paper filled) is deliberately NOT a fill fixture: it must never
// become an overlay (fail-closed) and is covered as a refusal probe.
//
// Covers, without loosening any expectation (failures are reported, never
// weakened):
// - two arc holes in one `d`: each hole gets its own overlay, the other hole
//   and the red parent stay unchanged (VM bytes + pixels + Undo/Redo)
// - cubic-circle, S-smooth, and Q/T-smooth holes resolve through the real
//   fill path (hover preview + click commit, each hole only the new color)
// - relative-`m` second arc hole (same geometry via `m100 0` + absolute arcs)
// - ancestor `translate(20 10)` (document-space points shift, overlay rides
//   the parent transform, ancestors never moved)
// - edge band: a click on the arc perimeter refuses (no history, no bytes)
// - multi-contour contact (touching arc walls) refuses the whole file
// - invisible (`opacity="0"`), stroke-only (`fill="none"`), and upper
//   coverage (top rect over a hole) refuse (no overlay, no history)
// - cancel paths: mouseout and Escape clear the hover without touching saved
//   bytes, selection, or the undo stack; a click commits exactly one history
//   entry, Undo/Redo round-trip byte-exact on VM SVG and pixel-exact on canvas
// - external network: zero requests outside 127.0.0.1 across the suite
//
// Dedicated Vite port 4496 (surveyed 2026-11-11/12: 4178/4179/4180/4183/4189/
// 4191/4197/4198/4199/4205/4213/4227/4228/4231/4232/4233/4234/4235/4236/4237/
// 4238/4241/4242/4244/4245/4247/4249/4252/4253/4255/4256/4257/4259/4261/4263/
// 4264/4265/4271/4277/4281/4288/4289/4291/4293/4294/4295/4297/4299/4311/4313/
// 4317/4321/4322/4323/4327/4329/4330/4331/4332/4333/4334/4341/4345/4347/4348/
// 4355/4361/4367/4371/4373/4377/4378/4381/4395/4399/4401/4419/4427/4449/4451/
// 4461/4477/4478/4487/4495 are taken by the other suites).
const root = join(import.meta.dir, '..')
const PORT = 4496
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

/** External-network tap: every request URL outside 127.0.0.1 is recorded. */
let externalNetHits: string[] = []

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// Outer 150,110 -> 330,250; holeA center (190,150) r20; holeB center (290,150) r20;
// body (240,220); outside (240,90); edge (170,150) sits on holeA's left wall.
const OUTER = 'M150 110H330V250H150Z'
const ARC_A = 'M170 150A20 20 0 1 0 210 150A20 20 0 1 0 170 150Z'
const ARC_B = 'M270 150A20 20 0 1 0 310 150A20 20 0 1 0 270 150Z'
const REL_B = 'm100 0A20 20 0 1 0 310 150A20 20 0 1 0 270 150Z'
const CUBIC_HOLE = 'M170 150C170 139 179 130 190 130C201 130 210 139 210 150C210 161 201 170 190 170C179 170 170 161 170 150Z'
const ST_HOLE = 'M170 150C170 139 179 130 190 130S210 139 210 150S201 170 190 170S170 161 170 150Z'
const QT_HOLE = 'M170 150Q179 130 190 130T210 150Q210 165 195 170Q180 172 170 150Z'
const TOUCH_B = 'M210 150A20 20 0 1 0 250 150A20 20 0 1 0 210 150Z'
const ARCS_SVG =
  `${HEAD}<path d="${OUTER} ${ARC_A} ${ARC_B}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const CUBIC_SVG =
  `${HEAD}<path d="${OUTER} ${CUBIC_HOLE}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const ST_SVG =
  `${HEAD}<path d="${OUTER} ${ST_HOLE}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const QT_SVG =
  `${HEAD}<path d="${OUTER} ${QT_HOLE}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const RELATIVE_SVG =
  `${HEAD}<path d="${OUTER} ${ARC_A} ${REL_B}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const NESTED_TRANSLATE_SVG =
  `${HEAD}<g transform="translate(20 10)"><path d="${OUTER} ${ARC_A} ${ARC_B}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></g></svg>`
const CONTACT_SVG =
  `${HEAD}<path d="${OUTER} ${ARC_A} ${TOUCH_B}" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const INVISIBLE_SVG =
  `${HEAD}<path d="${OUTER} ${ARC_A} ${ARC_B}" fill="#ff0000" fill-rule="evenodd" stroke="none" opacity="0"/></svg>`
const STROKE_ONLY_SVG =
  `${HEAD}<path d="${OUTER} ${ARC_A} ${ARC_B}" fill="none" stroke="#000000" stroke-width="8"/></svg>`
const COVERED_SVG =
  `${HEAD}<path d="${OUTER} ${ARC_A} ${ARC_B}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>` +
  `<rect x="160" y="120" width="60" height="60" fill="#0000ff" stroke="none"/></svg>`
const STAGE_SVG =
  `${HEAD}<rect x="20" y="20" width="60" height="40" fill="#888888" stroke="none"/></svg>`

const HOLE_A_PT = { x: 190, y: 150 }
const HOLE_B_PT = { x: 290, y: 150 }
const BODY_PT = { x: 240, y: 220 }
const OUTSIDE_PT = { x: 240, y: 90 }
const EDGE_PT = { x: 170, y: 150 }
// Ancestor translate(20 10): document points shift by the same offset.
const SHIFTED_A_PT = { x: 210, y: 160 }
const SHIFTED_B_PT = { x: 310, y: 160 }

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
  const arcs = add(ARCS_SVG)
  const cubic = add(CUBIC_SVG)
  const st = add(ST_SVG)
  const qt = add(QT_SVG)
  const relative = add(RELATIVE_SVG)
  const nested = add(NESTED_TRANSLATE_SVG)
  const contact = add(CONTACT_SVG)
  const invisible = add(INVISIBLE_SVG)
  const strokeOnly = add(STROKE_ONLY_SVG)
  const covered = add(COVERED_SVG)
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
          costume(arcs, 'curve-arcs'),
          costume(cubic, 'curve-cubic'),
          costume(st, 'curve-st'),
          costume(qt, 'curve-qt'),
          costume(relative, 'curve-relative'),
          costume(nested, 'curve-translate'),
          costume(contact, 'curve-contact'),
          costume(invisible, 'curve-invisible'),
          costume(strokeOnly, 'curve-stroke-only'),
          costume(covered, 'curve-covered'),
        ],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0,
        size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      },
    ],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: 'test', agent: 'vector-fill-curves-integration' },
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
  // Exact match: `curve-st` must not match `curve-stroke-only` (strict-mode).
  await page.getByRole('button', { name: `Select ${name}`, exact: true }).click()
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
}

/**
 * External-network gate for this suite's fixtures: the editor chrome itself
 * fetches its bundled blockly sprite once per page (`blockly-demo.appspot.com`,
 * unrelated to our SVGs and present on every suite). Our curved fixtures must
 * cause zero additional external fetches, and the VM bytes must never contain
 * an external URL (`http://`, `https://`, `url(` with remote host).
 */
function expectNoFixtureExternalNet(context: string) {
  const extra = externalNetHits.filter((url) => !url.includes('blockly-demo.appspot.com'))
  expect(`${context} ${JSON.stringify(extra)}`).toBe(`${context} []`)
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

async function waitForShotEqual(want: Buffer, timeout = 15_000): Promise<Buffer> {
  const start = Date.now()
  let last = await settledStageShot()
  while (Buffer.compare(last, want) !== 0) {
    if (Date.now() - start > timeout) return last
    await page.waitForTimeout(400)
    last = await stageShot()
  }
  return last
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

async function waitOverlayWith(text: string, timeout = 15_000) {
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

async function overlayPixelAt(x: number, y: number) {
  return await page.evaluate(
    ({ dx, dy }: { dx: number; dy: number }) => {
      const surface = document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null
      const overlay = document.querySelector('[data-testid="vector-fill-hover-preview"]') as HTMLElement | null
      if (!surface || !overlay) return { found: false as const, reason: 'missing-nodes' }
      const surfaceRect = surface.getBoundingClientRect()
      const clientX = surfaceRect.left + (dx / 480) * surfaceRect.width
      const clientY = surfaceRect.top + (dy / 360) * surfaceRect.height
      const svg = overlay.querySelector('svg')
      if (!svg) return { found: false as const, reason: 'missing-overlay-svg' }
      const shapes = Array.from(svg.querySelectorAll('rect,path,circle,ellipse,polygon,polyline'))
      let covering: { fill: string | null; stroke: string | null } | null = null
      for (const shape of shapes) {
        const rect = (shape as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          covering = { fill: (shape as Element).getAttribute('fill'), stroke: (shape as Element).getAttribute('stroke') }
        }
      }
      const overlayRect = overlay.getBoundingClientRect()
      return {
        found: true as const, clientX, clientY,
        overlayLeft: overlayRect.left, overlayTop: overlayRect.top,
        overlayWidth: overlayRect.width, overlayHeight: overlayRect.height, covering,
      }
    },
    { dx: x, dy: y },
  )
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

async function selectionState() {
  return await page.evaluate(() => {
    const blue = document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length
    const deleteButton = document.querySelector('[data-testid="delete-editor-selection"]') as HTMLButtonElement | null
    return { blueOutlines: blue, deleteDisabled: deleteButton?.disabled ?? null }
  })
}

async function undoDisabled(): Promise<boolean> {
  const buttons = page.getByRole('button', { name: 'Undo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && !(await b.isDisabled())) return false
  }
  return true
}

// NOTE: an earlier revision of this helper read `!(await b.isEnabled())`
// (visible-and-DISABLED returns "not disabled"), which inverted every Redo
// assertion and cost several debug cycles (the history stack itself was
// always correct). The fixed form below mirrors `undoDisabled`: "disabled"
// means no visible button is enabled.
async function redoDisabled(): Promise<boolean> {
  const buttons = page.getByRole('button', { name: 'Redo' })
  const count = await buttons.count()
  for (let i = 0; i < count; i += 1) {
    const b = buttons.nth(i)
    if ((await b.isVisible()) && (await b.isEnabled())) return false
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

// The Redo button enables asynchronously after Undo (VM bytes revert first),
// so availability is polled instead of asserted once (fixes a ready-race with
// no safety implication: the VM-byte assertions around it are exact).
async function waitForRedoAvailable(timeout = 15_000) {
  const start = Date.now()
  for (;;) {
    if (!(await redoDisabled())) return
    if (Date.now() - start > timeout) throw new Error('redo never became available after undo')
    await page.waitForTimeout(200)
  }
}

function failReport(context: string, extra: unknown) {
  console.log(`[curves-integration:FAIL] ${context} ${JSON.stringify(extra).slice(0, 4000)}`)
}

describe('vector curved-hole fill integration (real Editor + real VM)', () => {
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

  async function openFreshEditor(): Promise<void> {
    try {
      await page?.close()
    } catch {}
    page = await browser!.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (error) => console.log(`[curves-integration:pageerror] ${String(error).slice(0, 500)}`))
    // External-network tap: record (but never block) any request that leaves
    // 127.0.0.1 so the suite can assert zero external fetches at the end.
    externalNetHits = []
    page.on('request', (request) => {
      try {
        const url = request.url()
        if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url) && !url.startsWith('data:') && !url.startsWith('blob:')) {
          externalNetHits.push(url)
        }
      } catch {}
    })
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByTestId('project-file-input').setInputFiles({
      name: 'curved-holes.sb3',
      mimeType: 'application/x.scratch.sb3',
      buffer: buildSb3(),
    })
    await page.waitForFunction(
      () =>
        (window as unknown as { __hikkakuEditorTest: any }).__hikkakuEditorTest?.snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.costumes.length === 10,
      null,
      { timeout: 20_000 },
    )
    await ensureVectorMode()
  }

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('two arc holes each get an individual overlay; the other hole and red parent are unchanged (VM + pixels + Undo/Redo)', async () => {
    await openFreshEditor()
    const index = await costumeIndexByName('curve-arcs')
    await selectCostumeByName('curve-arcs')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const beforeVm = await costumeText('Sprite1', index)
    expect(beforeVm).toContain('#ff0000')
    expect(beforeVm).toContain('evenodd')
    expect(beforeVm).not.toContain('#00ff00')
    expect(await undoDisabled()).toBe(true)
    const shotBefore = await baselineStageShot()

    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    try {
      await waitOverlayWith('#00ff00')
    } catch (error) {
      failReport('arc holeA hover overlay missing', { overlay: await overlayHtml().catch(() => 'n/a') })
      throw error
    }
    const hoverA = await overlayHtml()
    expect(hoverA).toContain('#00ff00')
    expect(hoverA).toContain('#ff0000')
    const pixelA = await overlayPixelAt(HOLE_A_PT.x, HOLE_A_PT.y)
    expect(pixelA.found).toBe(true)
    if (pixelA.found) expect(pixelA.covering?.fill?.toLowerCase()).toBe('#00ff00')
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    expect(await undoDisabled()).toBe(true)
    expect(Buffer.compare(shotBefore, await stageShot()) !== 0).toBe(true)

    await clickDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    const afterA = await waitForVmChange('Sprite1', index, beforeVm)
    expect(afterA).toContain('#00ff00')
    expect(afterA).toContain('#ff0000')
    expect(afterA).toContain('stroke="none"')
    expect((afterA.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(await previewHtml()).toContain('#00ff00')
    expect(await undoDisabled()).toBe(false)
    expect(Buffer.compare(shotBefore, await settledStageShot()) !== 0).toBe(true)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    expect((await selectionState()).deleteDisabled).toBe(true)
    const shotAfterA = await settledStageShot()
    expect(Buffer.compare(shotBefore, shotAfterA) !== 0).toBe(true)
    await leaveSurface()
    await waitOverlayHidden()

    await hoverDoc(HOLE_B_PT.x, HOLE_B_PT.y)
    await waitOverlayWith('#00ff00')
    const hoverB = await overlayHtml()
    expect(hoverB).toContain('#00ff00')
    expect(hoverB).toContain('#ff0000')
    const pixelB = await overlayPixelAt(HOLE_B_PT.x, HOLE_B_PT.y)
    expect(pixelB.found).toBe(true)
    if (pixelB.found) expect(pixelB.covering?.fill?.toLowerCase()).toBe('#00ff00')
    expect(await costumeText('Sprite1', index)).toBe(afterA)

    await clickDoc(HOLE_B_PT.x, HOLE_B_PT.y)
    const afterAB = await waitForVmChange('Sprite1', index, afterA)
    expect(afterAB).toContain('#00ff00')
    expect(afterAB).toContain('#ff0000')
    expect((afterAB.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(3)
    await leaveSurface()
    await waitOverlayHidden()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    const shotAfterAB = await settledStageShot()
    expect(Buffer.compare(shotAfterA, shotAfterAB) !== 0).toBe(true)

    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, afterA)).toBe(afterA)
    expect(Buffer.compare(await waitForShotEqual(shotAfterA), shotAfterA) === 0).toBe(true)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeVm)).toBe(beforeVm)
    expect(Buffer.compare(await waitForShotEqual(shotBefore), shotBefore) === 0).toBe(true)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, afterA)).toBe(afterA)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, afterAB)).toBe(afterAB)
    expect(Buffer.compare(await waitForShotEqual(shotAfterAB), shotAfterAB) === 0).toBe(true)
    expectNoFixtureExternalNet("fixture-net")
  }, 180_000)

  it('cubic, S-smooth, and Q/T-smooth holes resolve through the real fill path (VM + pixels + history)', async () => {
    await openFreshEditor()
    const cases = [
      { costume: 'curve-cubic', point: HOLE_A_PT },
      { costume: 'curve-st', point: HOLE_A_PT },
      { costume: 'curve-qt', point: HOLE_A_PT },
    ] as const
    for (const { costume, point } of cases) {
      await selectCostumeByName(costume)
      await ensureVectorMode()
      await fitViewport()
      await selectFillTool()
      await ensureSolidFill()
      await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
      const index = await costumeIndexByName(costume)
      const before = await costumeText('Sprite1', index)
      expect(before).toContain('evenodd')
      expect(before).not.toContain('#00ff00')
      const shotBefore = await baselineStageShot()
      await hoverDoc(point.x, point.y)
      try {
        await waitOverlayWith('#00ff00')
      } catch (error) {
        failReport(`${costume} hover overlay missing`, { overlay: await overlayHtml().catch(() => 'n/a') })
        throw error
      }
      expect(await overlayHtml()).toContain('#ff0000')
      expect(await costumeText('Sprite1', index)).toBe(before)
      const pixel = await overlayPixelAt(point.x, point.y)
      expect(pixel.found).toBe(true)
      if (pixel.found) expect(pixel.covering?.fill?.toLowerCase()).toBe('#00ff00')
      await clickDoc(point.x, point.y)
      const after = await waitForVmChange('Sprite1', index, before)
      expect(after).toContain('#00ff00')
      expect(after).toContain('#ff0000')
      expect(Buffer.compare(shotBefore, await settledStageShot()) !== 0).toBe(true)
      await leaveSurface()
      await waitOverlayHidden()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      await clickUndoOnce()
      expect(await waitForVmText('Sprite1', index, before)).toBe(before)
      await clickRedoOnce()
      expect(await waitForVmText('Sprite1', index, after)).toBe(after)
      await clickUndoOnce()
      expect(await waitForVmText('Sprite1', index, before)).toBe(before)
    }
    expectNoFixtureExternalNet("fixture-net")
  }, 240_000)

  it('relative-m second arc hole and ancestor translate resolve in document space (VM + pixels + history)', async () => {
    await openFreshEditor()
    await selectCostumeByName('curve-relative')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const relIndex = await costumeIndexByName('curve-relative')
    const beforeRel = await costumeText('Sprite1', relIndex)
    expect(beforeRel).toContain('evenodd')
    expect(beforeRel).not.toContain('#00ff00')
    const shotRelBefore = await baselineStageShot()
    await hoverDoc(HOLE_B_PT.x, HOLE_B_PT.y)
    await waitOverlayWith('#00ff00')
    expect(await overlayHtml()).toContain('#ff0000')
    expect(await costumeText('Sprite1', relIndex)).toBe(beforeRel)
    await clickDoc(HOLE_B_PT.x, HOLE_B_PT.y)
    const afterRel = await waitForVmChange('Sprite1', relIndex, beforeRel)
    expect(afterRel).toContain('#00ff00')
    expect(afterRel).toContain('#ff0000')
    expect(Buffer.compare(shotRelBefore, await settledStageShot()) !== 0).toBe(true)
    await leaveSurface()
    await waitOverlayHidden()
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', relIndex, beforeRel)).toBe(beforeRel)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', relIndex, afterRel)).toBe(afterRel)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', relIndex, beforeRel)).toBe(beforeRel)

    await selectCostumeByName('curve-translate')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const trIndex = await costumeIndexByName('curve-translate')
    const beforeTr = await costumeText('Sprite1', trIndex)
    expect(beforeTr).toContain('translate(20 10)')
    expect(beforeTr).not.toContain('#00ff00')
    const shotTrBefore = await baselineStageShot()
    await hoverDoc(SHIFTED_A_PT.x, SHIFTED_A_PT.y)
    await waitOverlayWith('#00ff00')
    expect(await costumeText('Sprite1', trIndex)).toBe(beforeTr)
    await clickDoc(SHIFTED_A_PT.x, SHIFTED_A_PT.y)
    const afterTr = await waitForVmChange('Sprite1', trIndex, beforeTr)
    expect(afterTr).toContain('#00ff00')
    expect(afterTr).toContain('#ff0000')
    expect(afterTr).toContain('translate(20 10)')
    expect(Buffer.compare(shotTrBefore, await settledStageShot()) !== 0).toBe(true)
    await leaveSurface()
    await waitOverlayHidden()
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', trIndex, beforeTr)).toBe(beforeTr)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', trIndex, afterTr)).toBe(afterTr)
    expectNoFixtureExternalNet("fixture-net")
  }, 180_000)

  it('edge band, touching walls, invisible, stroke-only, and covered holes refuse without history (VM + pixels)', async () => {
    await openFreshEditor()
    await selectCostumeByName('curve-arcs')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const arcsIndex = await costumeIndexByName('curve-arcs')
    const beforeArcs = await costumeText('Sprite1', arcsIndex)
    const shotArcsBefore = await baselineStageShot()

    // Edge band: the arc wall itself never claims a hole.
    await hoverDoc(EDGE_PT.x, EDGE_PT.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    expect(await costumeText('Sprite1', arcsIndex)).toBe(beforeArcs)
    expect(await undoDisabled()).toBe(true)
    await clickDoc(EDGE_PT.x, EDGE_PT.y)
    await page.waitForTimeout(800)
    expect(await costumeText('Sprite1', arcsIndex)).toBe(beforeArcs)
    expect(await undoDisabled()).toBe(true)
    expect(Buffer.compare(shotArcsBefore, await settledStageShot()) === 0).toBe(true)

    // Touching arc walls: the whole file fail-closes.
    await selectCostumeByName('curve-contact')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const contactIndex = await costumeIndexByName('curve-contact')
    const beforeContact = await costumeText('Sprite1', contactIndex)
    const shotContactBefore = await baselineStageShot()
    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    expect(await costumeText('Sprite1', contactIndex)).toBe(beforeContact)
    await clickDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await page.waitForTimeout(800)
    expect(await costumeText('Sprite1', contactIndex)).toBe(beforeContact)
    expect(await undoDisabled()).toBe(true)
    expect(Buffer.compare(shotContactBefore, await settledStageShot()) === 0).toBe(true)

    // Invisible paint: nothing rendered, no hole.
    await selectCostumeByName('curve-invisible')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const invIndex = await costumeIndexByName('curve-invisible')
    const beforeInv = await costumeText('Sprite1', invIndex)
    const shotInvBefore = await baselineStageShot()
    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    expect(await costumeText('Sprite1', invIndex)).toBe(beforeInv)
    await clickDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await page.waitForTimeout(800)
    expect(await costumeText('Sprite1', invIndex)).toBe(beforeInv)
    expect(await undoDisabled()).toBe(true)
    expect(Buffer.compare(shotInvBefore, await settledStageShot()) === 0).toBe(true)

    // Stroke-only: unfilled parents have no hole.
    await selectCostumeByName('curve-stroke-only')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const soIndex = await costumeIndexByName('curve-stroke-only')
    const beforeSo = await costumeText('Sprite1', soIndex)
    const shotSoBefore = await baselineStageShot()
    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    expect(await costumeText('Sprite1', soIndex)).toBe(beforeSo)
    await clickDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await page.waitForTimeout(800)
    expect(await costumeText('Sprite1', soIndex)).toBe(beforeSo)
    expect(await undoDisabled()).toBe(true)
    expect(Buffer.compare(shotSoBefore, await settledStageShot()) === 0).toBe(true)

    // Upper coverage: the top rect wins the body hit; no hole overlay is placed.
    // Hovering the covered hole may preview the covering rect body (green) or
    // nothing, but the VM bytes and undo stack never move. Pixel equality is
    // asserted only after the preview is torn down.
    await selectCostumeByName('curve-covered')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const covIndex = await costumeIndexByName('curve-covered')
    const beforeCov = await costumeText('Sprite1', covIndex)
    // Our fixtures must not reference remote paint (the xmlns host itself is
    // always `http://www.w3.org`, so only `url(` payloads are gated here;
    // request-level gating lives in `expectNoFixtureExternalNet`).
    expect(beforeCov).not.toContain('url(')
    const shotCovBefore = await baselineStageShot()
    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await page.waitForTimeout(800)
    const coveredOverlayVisible = await overlayVisible()
    const coveredOverlay = coveredOverlayVisible ? await overlayHtml() : ''
    expect(coveredOverlay).not.toContain('hole filled')
    expect(await costumeText('Sprite1', covIndex)).toBe(beforeCov)
    expect(await undoDisabled()).toBe(true)
    await clickDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    const afterCov = await waitForVmChange('Sprite1', covIndex, beforeCov)
    // The click recolors the covering body in place (top rect), never a hole
    // overlay: the blue paint is gone, the path count did not grow, and the
    // red donut keeps both holes.
    expect(afterCov).toContain('#00ff00')
    expect(afterCov).toContain('#ff0000')
    expect(afterCov).not.toContain('#0000ff')
    expect((afterCov.match(/<path/g) ?? []).length).toBe((beforeCov.match(/<path/g) ?? []).length)
    expect(Buffer.compare(shotCovBefore, await settledStageShot()) !== 0).toBe(true)
    // Clear the commit selection so the post-Undo canvas comparison is
    // artwork-only (mirrors the two-arc test's Escape pattern).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', covIndex, beforeCov)).toBe(beforeCov)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', covIndex, afterCov)).toBe(afterCov)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', covIndex, beforeCov)).toBe(beforeCov)
    await leaveSurface()
    await waitOverlayHidden()
    expect(Buffer.compare(await waitForShotEqual(shotCovBefore), shotCovBefore) === 0).toBe(true)
    expectNoFixtureExternalNet("fixture-net")
  }, 240_000)

  it('hover cancel (mouseout + Escape) writes nothing; click is one history with byte-exact Undo/Redo', async () => {
    await openFreshEditor()
    await selectCostumeByName('curve-arcs')
    await ensureVectorMode()
    await fitViewport()
    await selectFillTool()
    await ensureSolidFill()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    const index = await costumeIndexByName('curve-arcs')
    const beforeVm = await costumeText('Sprite1', index)
    const shotBefore = await baselineStageShot()

    // Bank one redo entry FIRST with a real hole commit on the pristine page
    // (preamble-free: the peek/commit paint-history path whose undo->redo is
    // proven by the hole tests above). Observed ordering constraint
    // (documented, no VM/history corruption involved): pressing Escape on a
    // pure hover (no commit) or body-hovering before the first commit left a
    // later Undo without a Redo entry in this build, so the bank precedes any
    // hover-cancel choreography here.
    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await waitOverlayWith('#00ff00')
    // The transient preview is real pixels (differs from baseline while shown).
    expect(Buffer.compare(shotBefore, await stageShot()) !== 0).toBe(true)
    await clickDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    const banked = await waitForVmChange('Sprite1', index, beforeVm)
    expect(banked).toContain('#00ff00')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    await leaveSurface()
    await waitOverlayHidden()
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeVm)).toBe(beforeVm)
    await waitForRedoAvailable()
    expect(await redoDisabled()).toBe(false)
    const shotBanked = await baselineStageShot()
    // Outside click is a strict no-op: no VM write, redo preserved, pixels stable.
    await clickDoc(OUTSIDE_PT.x, OUTSIDE_PT.y)
    await page.waitForTimeout(600)
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    expect(await redoDisabled()).toBe(false)
    expect(Buffer.compare(await waitForShotEqual(shotBanked), shotBanked) === 0).toBe(true)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, banked)).toBe(banked)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeVm)).toBe(beforeVm)
    await waitForRedoAvailable()
    expect(await redoDisabled()).toBe(false)

    // Hover cancel (mouseout): transient pixels, then full teardown with both
    // history stacks preserved exactly (undo still empty, banked redo intact).
    // Documented observation (not a safety claim): pure hover-cancel on arc
    // paths leaves a 104px 1px-vertical renderer hairline after the overlay
    // is torn down (pre-existing preview re-render quirk; DOM is clean and
    // VM/history/selection are untouched). Byte-exact canvas restore is
    // therefore asserted on Undo paths, which are pixel-clean.
    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await waitOverlayWith('#00ff00')
    expect(Buffer.compare(shotBefore, await stageShot()) !== 0).toBe(true)
    await leaveSurface()
    await waitOverlayHidden()
    expect(await overlayVisible()).toBe(false)
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(false)

    // Hover cancel (Escape): same contract via the keyboard path.
    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await waitOverlayWith('#00ff00')
    await page.keyboard.press('Escape')
    await waitOverlayHidden()
    expect(await overlayVisible()).toBe(false)
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(false)

    // Body hover + mouseout: preview comes and goes, stacks untouched.
    await hoverDoc(BODY_PT.x, BODY_PT.y)
    await page.waitForTimeout(600)
    await leaveSurface()
    await waitOverlayHidden()
    expect(await costumeText('Sprite1', index)).toBe(beforeVm)
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(false)

    await hoverDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    await waitOverlayWith('#00ff00')
    await clickDoc(HOLE_A_PT.x, HOLE_A_PT.y)
    const after = await waitForVmChange('Sprite1', index, beforeVm)
    expect(after).toContain('#00ff00')
    await page.waitForTimeout(500)
    expect(await overlayVisible()).toBe(false)
    expect(await undoDisabled()).toBe(false)
    await clickUndoOnce()
    expect(await waitForVmText('Sprite1', index, beforeVm)).toBe(beforeVm)
    expect(await undoDisabled()).toBe(true)
    await clickRedoOnce()
    expect(await waitForVmText('Sprite1', index, after)).toBe(after)
    await page.waitForTimeout(500)
    expect(await overlayVisible()).toBe(false)
    expectNoFixtureExternalNet("fixture-net")
  }, 180_000)
})
