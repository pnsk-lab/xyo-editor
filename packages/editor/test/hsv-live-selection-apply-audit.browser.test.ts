import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Independent audit of the recent "HSV live selection apply" change.
//
// Scope (behavior notes only, no upstream source copied):
// - HsvColorPicker sliders rewrite one stored hex per tick; Editor.svelte
//   `handleHsvInput` immediately repaints ONLY that color side on the current
//   vector selection (transparent becomes opaque), peeks history once per
//   gesture, persists every preview at once, and commits the peeked entry when
//   the gesture closes (600ms idle flush, or immediately on selection / target
//   / costume / tool / eyedropper / text / Undo / Redo switches, or Escape).
// - Continuous ticks on one selection coalesce to exactly one Undo entry;
//   same-value / fully-skipped ticks stay history-free with redo preserved;
//   stale async completions (slow loadAsset/VM) are dropped by serial + scope +
//   selection checks without touching the newly selected asset.
//
// This file ONLY drives the real Editor UI on its own port (no product-code
// edits) and verifies every claim against real saved asset SVG bytes
// (vm.loadAsset via the shared paint-history fixture VM). A failing assertion
// is reported as-is; nothing here is "fixed" by retrying or by touching src/.
// The Editor is concurrently edited by another agent: this suite uses a unique
// port (4527) and a fresh seeded page per test; pageerror/console diagnostics
// are printed so an HMR-induced flake can be told apart from a real failure.

const root = join(import.meta.dir, '..')
const PORT = 4527
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
const diagnostics: string[] = []

// ---------------------------------------------------------------------------
// Deterministic vector project: Sprite1 has a two-shape costume (the audit
// target) plus an untouched costume; Sprite2 is a fully untouched asset.
// ---------------------------------------------------------------------------

const SVG_A =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect id="left" x="40" y="100" width="160" height="120" fill="#ff0000" stroke="#111111" stroke-width="4"/>` +
  `<rect id="right" x="280" y="100" width="160" height="120" fill="#0000ff" stroke="#222222" stroke-width="4"/>` +
  `</svg>`
const SVG_B =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect id="solo" x="140" y="80" width="200" height="200" fill="#00ff00" stroke="#333333" stroke-width="4"/>` +
  `</svg>`
const SVG_C =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<rect id="other" x="100" y="60" width="280" height="240" fill="#ffff00" stroke="#444444" stroke-width="4"/>` +
  `</svg>`

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
  const refA = add(SVG_A)
  const refB = add(SVG_B)
  const refC = add(SVG_C)
  const costume = (ref: { assetId: string; md5ext: string }, name: string) => ({
    name,
    ...ref,
    dataFormat: 'svg',
    rotationCenterX: 240,
    rotationCenterY: 180,
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
        costumes: [{ ...costume(refC, 'backdrop'), bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
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
        costumes: [costume(refA, 'costumeA'), costume(refB, 'costumeB')],
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
        isStage: false,
        name: 'Sprite2',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [costume(refC, 'costumeS2')],
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
    meta: { semver: '3.0.0', vm: 'test', agent: 'hsv-live-audit' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

type SvgDigest = { len: number; sum: number; md5ext: string; text: string }

async function svgBytes(page: Page, target: string, index: number): Promise<SvgDigest> {
  return await page.evaluate(async ({ target, index }) => {
    const vm = (window as any).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const key = c?.md5ext ?? c?.assetId
    const bytes = key ? ((await vm.loadAsset(key, c.dataFormat ?? '')) as Uint8Array | undefined) : undefined
    if (!bytes) throw new Error(`missing bytes ${target}[${index}]`)
    let sum = 0
    for (const b of bytes as Uint8Array) sum = (sum + (b as number)) >>> 0
    return {
      len: (bytes as Uint8Array).length,
      sum,
      md5ext: c.md5ext as string,
      text: new TextDecoder().decode(bytes as Uint8Array),
    }
  }, { target, index })
}

async function fillsById(page: Page, target: string, index: number, ids: string[]): Promise<Record<string, { fill: string; stroke: string }>> {
  return await page.evaluate(async ({ target, index, ids }) => {
    const vm = (window as any).__paintHistoryVm
    const t = vm.getTarget(target)
    const c = t?.costumes[index]
    const key = c?.md5ext ?? c?.assetId
    const bytes = key ? ((await vm.loadAsset(key, c.dataFormat ?? '')) as Uint8Array | undefined) : undefined
    if (!bytes) throw new Error('missing bytes')
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes as Uint8Array), 'image/svg+xml')
    const out: Record<string, { fill: string; stroke: string }> = {}
    for (const id of ids as string[]) {
      const node = doc.querySelector(`#${CSS.escape(id)}`)
      out[id] = {
        fill: (node?.getAttribute('fill') ?? '').toLowerCase(),
        stroke: (node?.getAttribute('stroke') ?? '').toLowerCase(),
      }
    }
    return out
  }, { target, index, ids })
}

async function waitSvg(page: Page, target: string, index: number, pred: (text: string) => boolean, timeout = 15_000): Promise<string> {
  const start = Date.now()
  let last = ''
  for (;;) {
    const got = await svgBytes(page, target, index)
    last = got.text
    if (pred(last)) return last
    if (Date.now() - start > timeout) throw new Error(`waitSvg timeout ${target}[${index}] last=${last.slice(0, 400)}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

async function newSeededPage(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' && !text.includes('favicon')) diagnostics.push(`console: ${text}`)
    // HMR切り分け: 別agent作業中のdevサーバがホット更新を流したら記録する。
    if (/hot updated|hmr|reload/i.test(text)) diagnostics.push(`hmr: ${text}`)
  })
  await page.goto(base)
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByTestId('project-file-input').setInputFiles({
    name: 'hsv-audit.sb3',
    mimeType: 'application/x.scratch.sb3',
    buffer: buildSb3(),
  })
  await page.waitForFunction(
    () =>
      (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
        ?.costumes.length === 2,
    null,
    { timeout: 20_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  // Uploaded costumes are SVG already; keep the guard for HMR/dev variance.
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 20_000 })
  }
  // HMR切り分け用マーカー: window側とVM側の両方に刻む。フルリロードでは両方
  // 消え、SvelteリマウントではVM側だけ消える(VMが作り直されるため)。
  await page.evaluate(() => {
    ;(window as any).__hsvAuditSeed = 'seeded'
    ;(window as any).__paintHistoryVm.__hsvAuditVmMark = 'vm-mark'
  })
  return page
}

async function assertNoHmr(page: Page, phase: string) {
  const marks = await page.evaluate(() => ({
    seed: (window as any).__hsvAuditSeed ?? null,
    vmMark: (window as any).__paintHistoryVm?.__hsvAuditVmMark ?? null,
    hasSelectTool: document.querySelector('[data-testid="vector-shape-select"]') ? true : false,
  }))
  if (marks.seed !== 'seeded' || marks.vmMark !== 'vm-mark') {
    throw new Error(
      `HMR-INTERFERENCE at ${phase}: page state was reset by an external edit/reload ` +
        `(seed=${marks.seed} vmMark=${marks.vmMark} selectTool=${marks.hasSelectTool}). ` +
        `別agentの編集中ファイルがdevサーバを更新した可能性。製品コードは無改変のため再実行で切分け。`,
    )
  }
}

async function clickShape(page: Page, which: 'left' | 'right') {
  // Select tool + visible overlay intersection. Preview refreshes recreate the
  // overlays, so re-read rects on every attempt (max 3). A remount/reload by
  // an external edit surfaces as HMR-INTERFERENCE instead of a mute timeout.
  let lastError: unknown = undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.getByTestId('vector-shape-select').last().click({ timeout: 10_000 })
      const pt = await page.evaluate((id) => {
        const surface = document.querySelector('[data-testid="costume-paint-surface"]')
        const s = surface?.getBoundingClientRect()
        if (!s) return null
        // NOTE: `data-vector-object` alone also matches the 16px resize/rotate
        // handles; restrict to the per-unit selection outlines (one per unit,
        // pointer-events-none so the click passes through to the shape).
        const els = surface
          ? Array.from(surface.querySelectorAll('[data-vector-object][data-vector-selection-outline]'))
          : []
        if (els.length < 2) return null
        const rs = els
          .map((el) => (el as HTMLElement).getBoundingClientRect())
          .sort((a, b) => a.left - b.left)
        const r = (id === 'left' ? rs[0] : rs[1])!
        const x0 = Math.max(r.left, s.left)
        const x1 = Math.min(r.right, s.right)
        const y0 = Math.max(r.top, s.top)
        const y1 = Math.min(r.bottom, s.bottom)
        if (x1 - x0 < 4 || y1 - y0 < 4) return null
        return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
      }, which)
      if (!pt) throw new Error(`selectable vector overlay not visible: ${which}`)
      await page.mouse.click(pt.x, pt.y)
      // Apply有効だけでは選択の切替を保証しないため、選択アウトライン自体
      // (border-blue-500) で対象が選ばれたことを確認する。
      await page.waitForFunction(
        (id) => {
          const surface = document.querySelector('[data-testid="costume-paint-surface"]')
          const els = surface
            ? Array.from(surface.querySelectorAll('[data-vector-object][data-vector-selection-outline]'))
            : []
          if (els.length < 2) return false
          const sorted = els
            .map((el) => ({
              left: (el as HTMLElement).getBoundingClientRect().left,
              selected: ((el as HTMLElement).className as string).includes('border-blue-500'),
            }))
            .sort((a, b) => a.left - b.left)
          const target = id === 'left' ? sorted[0]! : sorted[1]!
          const other = id === 'left' ? sorted[1]! : sorted[0]!
          return target.selected && !other.selected
        },
        which,
        { timeout: 8_000 },
      )
      return
    } catch (error) {
      lastError = error
    }
  }
  await assertNoHmr(page, `clickShape(${which})`).catch((hmr) => {
    throw hmr
  })
  throw lastError
}

function setHsv(page: Page, testId: string, value: number) {
  return page.getByTestId(testId).evaluate(
    (node: HTMLInputElement, next: number) => {
      node.value = String(next)
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
    },
    value,
  )
}

function inputOnly(page: Page, testId: string, value: number) {
  // Mid-drag tick: `input` without `change` (commit timer still pending).
  return page.getByTestId(testId).evaluate(
    (node: HTMLInputElement, next: number) => {
      node.value = String(next)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    },
    value,
  )
}

async function slowVm(page: Page, ms: number) {
  await page.evaluate((delay) => {
    const vm = (window as any).__paintHistoryVm
    if (vm.__hsvAuditOrigLoad) return
    vm.__hsvAuditOrigLoad = vm.loadAsset.bind(vm)
    vm.loadAsset = async (...args: any[]) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return vm.__hsvAuditOrigLoad(...args)
    }
  }, ms)
}

async function restoreVm(page: Page) {
  await page.evaluate(() => {
    const vm = (window as any).__paintHistoryVm
    if (vm.__hsvAuditOrigLoad) {
      vm.loadAsset = vm.__hsvAuditOrigLoad
      delete vm.__hsvAuditOrigLoad
    }
    if (vm.__gateRelease) {
      vm.__gateRelease()
      delete vm.__gateRelease
    }
  })
}

async function gateVm(page: Page) {
  // Hold every loadAsset behind a manual gate: reproduces a stalled low-speed
  // VM/image read deterministically. The next gesture's peek/doc-load parks
  // until `releaseVmGate` runs, so a switch in between must drop the stale
  // completion (last intent wins, new asset untouched).
  await page.evaluate(() => {
    const vm = (window as any).__paintHistoryVm
    if (vm.__gateRelease) return
    const orig = vm.loadAsset.bind(vm)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vm.__gateRelease = () => {
      vm.loadAsset = orig
      delete vm.__gateRelease
      release()
    }
    vm.loadAsset = async (...args: any[]) => {
      await gate
      return orig(...args)
    }
  })
}

async function releaseVmGate(page: Page) {
  await page.evaluate(() => (window as any).__paintHistoryVm.__gateRelease?.())
}

async function waitFills(
  page: Page,
  target: string,
  index: number,
  want: Record<string, string>,
  timeout = 15_000,
): Promise<Record<string, { fill: string; stroke: string }>> {
  const start = Date.now()
  let last: Record<string, { fill: string; stroke: string }> = {}
  for (;;) {
    last = await fillsById(page, target, index, Object.keys(want))
    if (Object.entries(want).every(([id, fill]) => last[id]?.fill === fill)) return last
    if (Date.now() - start > timeout) throw new Error(`waitFills timeout want=${JSON.stringify(want)} got=${JSON.stringify(last)}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

async function waitUndoDisabled(page: Page, timeout = 10_000) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Undo' || b.getAttribute('aria-label') === 'Undo',
      )?.hasAttribute('disabled') ?? false,
    null,
    { timeout },
  )
}
function nativeFill(page: Page) {
  return page.getByLabel('Paint color', { exact: true })
}

async function primeFill(page: Page, hex: string) {
  // Establish the picker's S/V baseline (existing suites always set the
  // native hex first): HSV ticks then derive exact endpoint colors.
  await nativeFill(page).fill(hex)
}

function undoButton(page: Page) {
  return page.getByRole('button', { name: 'Undo' })
}

function redoButton(page: Page) {
  return page.getByRole('button', { name: 'Redo' })
}

async function waitIdle(ms = 950) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('hsv live selection apply audit (real asset SVG bytes)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    // HMR切り分け: devサーバの更新ログを残す(別agentの保存で更新が流れたか)。
    server.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (/hmr|updated|reload|connected/i.test(text)) diagnostics.push(`vite: ${text.trim().slice(0, 300)}`)
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
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
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    if (diagnostics.length) console.log(`Browser diagnostics:\n${diagnostics.join('\n')}`)
  })

  it('rapid selection alternation under slow VM: last intent wins, other asset/field intact', async () => {
    const page = await newSeededPage()
    try {
      const baselineA = await svgBytes(page, 'Sprite1', 0)
      const baselineB = await svgBytes(page, 'Sprite1', 1)
      const baselineC = await svgBytes(page, 'Sprite2', 0)
      expect(baselineA.text).toContain('#ff0000')
      expect(baselineA.text).toContain('#0000ff')

      await slowVm(page, 250)
      // 保存待ち(600msコミット保留中)の高速切替: 各意図の適用を待ってから
      // 即座に切替える。各選択への最後の入力が1エントリずつ確定すること。
      // (適用前に切替えた未着手タスクはstaleとして破棄される設計 — 別itの
      // gate試験で新旧asset無改変を検証)
      await clickShape(page, 'left')
      await primeFill(page, '#ff0000')
      await inputOnly(page, 'fill-hue', 100 / 3)
      await waitFills(page, 'Sprite1', 0, { left: '#00ff00' })
      await clickShape(page, 'right')
      await primeFill(page, '#0000ff')
      await setHsv(page, 'fill-hue', 0)
      await waitFills(page, 'Sprite1', 0, { right: '#ff0000' })
      await clickShape(page, 'left')
      await primeFill(page, '#00ff00')
      await setHsv(page, 'fill-hue', 200 / 3)
      await waitFills(page, 'Sprite1', 0, { left: '#0000ff' })
      await restoreVm(page)

      // 最終意図: leftは青、rightは赤(各選択への最後の入力が勝つ)。
      await waitSvg(page, 'Sprite1', 0, (text) => text.includes('#0000ff'))
      await waitIdle()
      const paints = await fillsById(page, 'Sprite1', 0, ['left', 'right'])
      expect(paints['left']!.fill).toBe('#0000ff')
      expect(paints['right']!.fill).toBe('#ff0000')
      // 他field不変: strokeは両方とも元のまま。
      expect(paints['left']!.stroke).toBe('#111111')
      expect(paints['right']!.stroke).toBe('#222222')
      // 他asset不変: 実バイト総和で比較。
      expect((await svgBytes(page, 'Sprite1', 1)).sum).toBe(baselineB.sum)
      expect((await svgBytes(page, 'Sprite1', 1)).len).toBe(baselineB.len)
      expect((await svgBytes(page, 'Sprite2', 0)).sum).toBe(baselineC.sum)
      expect((await svgBytes(page, 'Sprite2', 0)).len).toBe(baselineC.len)

      // 切替で前エントリが先に閉じられる: UndoはLIFOでleft青→right赤→left緑の順に戻る。
      await undoButton(page).click()
      const afterFirstUndo = await waitFills(page, 'Sprite1', 0, { left: '#00ff00', right: '#ff0000' })
      expect(afterFirstUndo['left']!.fill).toBe('#00ff00')
      expect(afterFirstUndo['right']!.fill).toBe('#ff0000')
      await undoButton(page).click()
      const undone = await waitFills(page, 'Sprite1', 0, { left: '#00ff00', right: '#0000ff' })
      expect(undone['left']!.fill).toBe('#00ff00')
      expect(undone['right']!.fill).toBe('#0000ff')
      await undoButton(page).click()
      const backToBaseline = await waitFills(page, 'Sprite1', 0, { left: '#ff0000', right: '#0000ff' })
      expect(backToBaseline['left']!.fill).toBe('#ff0000')
      // Redoで全復帰(ユーザーの最後の意図どおり)。
      await redoButton(page).click()
      await redoButton(page).click()
      await redoButton(page).click()
      const redone = await waitFills(page, 'Sprite1', 0, { left: '#0000ff', right: '#ff0000' })
      expect(redone['left']!.fill).toBe('#0000ff')
      expect(redone['right']!.fill).toBe('#ff0000')
      // Sprite切替でも他assetは無傷のまま。
      await page.getByTestId('target-card-Sprite2').click()
      await page.getByRole('button', { name: 'Select costumeS2' }).waitFor({ state: 'visible', timeout: 10_000 })
      expect((await svgBytes(page, 'Sprite2', 0)).sum).toBe(baselineC.sum)
    } finally {
      await restoreVm(page).catch(() => undefined)
      await page.close().catch(() => undefined)
    }
  }, 180_000)

  it('continuous color ops coalesce to one history; noop preserves redo', async () => {
    const page = await newSeededPage()
    try {
      const baseline = await svgBytes(page, 'Sprite1', 0)

      // Redoを武装: 編集→Undoでredo有効化。
      await clickShape(page, 'left')
      await primeFill(page, '#ff0000')
      await setHsv(page, 'fill-hue', 200 / 3)
      await waitSvg(page, 'Sprite1', 0, (text) => !text.includes('#ff0000'))
      await waitIdle()
      await undoButton(page).click()
      await waitSvg(page, 'Sprite1', 0, (text) => text.includes('#ff0000'))
      expect(await redoButton(page).isDisabled()).toBe(false)

      // noop: 現在値と同値のtickは履歴を作らずredoを温存する。
      // (同値tickは見た目の書換えを起こし得るため、履歴スタックで判定する)
      await primeFill(page, '#ff0000')
      await setHsv(page, 'fill-hue', 0)
      await waitIdle()
      expect(await undoButton(page).isDisabled()).toBe(true)
      expect(await redoButton(page).isDisabled()).toBe(false)

      // 連続色操作は1履歴: 高速3連tick→idle→Undo1回でbaselineへ。
      await setHsv(page, 'fill-hue', 10)
      await inputOnly(page, 'fill-hue', 30)
      await setHsv(page, 'fill-hue', 200 / 3)
      await waitSvg(page, 'Sprite1', 0, (text) => !text.includes('#ff0000'))
      await waitIdle()
      const edited = await fillsById(page, 'Sprite1', 0, ['left', 'right'])
      expect(edited['left']!.fill).toBe('#0000ff')
      expect(edited['right']!.fill).toBe('#0000ff')
      await undoButton(page).click()
      const reverted = await waitSvg(page, 'Sprite1', 0, (text) => text.includes('#ff0000'))
      expect(reverted).toContain('#0000ff')
      const back = await svgBytes(page, 'Sprite1', 0)
      expect(back.sum).toBe(baseline.sum)
      expect(back.len).toBe(baseline.len)
      // ちょうど1エントリ: これ以上Undoは無い(当該asset分)。
      await waitUndoDisabled(page)
      // Redoで最終意図が復帰。
      await redoButton(page).click()
      await waitSvg(page, 'Sprite1', 0, (text) => !text.includes('#ff0000'))
      const redone = await fillsById(page, 'Sprite1', 0, ['left'])
      expect(redone['left']!.fill).toBe('#0000ff')
    } finally {
      await restoreVm(page).catch(() => undefined)
      await page.close().catch(() => undefined)
    }
  }, 180_000)

  it('field isolation: fill/stroke/gradient ends, gradient-kind and tool switches stay clean', async () => {
    const page = await newSeededPage()
    try {
      const baseline = await svgBytes(page, 'Sprite1', 0)
      const baselineC = await svgBytes(page, 'Sprite2', 0)
      await clickShape(page, 'left')
      await primeFill(page, '#ff0000')

      // solid→horizontalへApply(gradient化の基準エントリ)。
      await page.getByLabel('Vector paint style').selectOption('horizontal')
      await page.getByLabel('Secondary paint color', { exact: true }).fill('#00ff00')
      await page.getByTestId('apply-vector-style').click()
      await page.waitForFunction(() => document.querySelectorAll('.vector-preview [fill^="url("]').length > 0, null, {
        timeout: 10_000,
      })
      await waitIdle()
      // HMR remount (別agent作業中) はツールバー状態を巻き戻し得る: 前提を明示確認。
      const gradientKind = await page.getByLabel('Vector paint style').inputValue()
      expect(gradientKind).toBe('horizontal')
      const afterGradient = await svgBytes(page, 'Sprite1', 0)

      // 別色(secondary end)のlive: primary側と他図形・strokeは不変。
      const fillsBefore = await fillsById(page, 'Sprite1', 0, ['right'])
      await setHsv(page, 'fill-secondary-hue', 0)
      await page.waitForFunction(() => {
        const preview = document.querySelector('.vector-preview')
        if (!preview) return false
        const ids = new Set<string>()
        preview.querySelectorAll('[fill]').forEach((node) => {
          const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec((node.getAttribute('fill') ?? '').trim())
          if (m && m[1]) ids.add(m[1]!)
        })
        if (ids.size === 0) return false
        const colors: string[] = []
        ids.forEach((id) => {
          try {
            preview.querySelector(`#${CSS.escape(id)}`)?.querySelectorAll('stop').forEach((s) => {
              const c = (s.getAttribute('stop-color') ?? '').toLowerCase()
              if (c) colors.push(c)
            })
          } catch {}
        })
        return colors.length > 0 && colors.includes('#ff0000') && !colors.includes('#00ff00')
      }, null, { timeout: 10_000 })
      await waitIdle()
      const afterSecondary = await svgBytes(page, 'Sprite1', 0)
      expect(afterSecondary.sum).not.toBe(afterGradient.sum)
      // right図形はsolid青のまま(stroke含め不変)。
      const rightAfter = await fillsById(page, 'Sprite1', 0, ['right'])
      expect(rightAfter['right']!.fill).toBe(fillsBefore['right']!.fill)
      expect(rightAfter['right']!.stroke).toBe('#222222')

      // tool切替はflushのみ: secondary変更が1エントリで確定し、余計な履歴を足さない。
      await page.getByTestId('vector-shape-brush').last().click()
      await page.getByTestId('vector-shape-select').last().click()
      await waitIdle()
      expect((await svgBytes(page, 'Sprite1', 0)).sum).toBe(afterSecondary.sum)
      await undoButton(page).click()
      const undoneSecondary = await svgBytes(page, 'Sprite1', 0)
      expect(undoneSecondary.sum).toBe(afterGradient.sum)
      await redoButton(page).click()
      expect((await svgBytes(page, 'Sprite1', 0)).sum).toBe(afterSecondary.sum)

      // stroke live: fill側(gradient参照)は不変でoutlineだけ変わる。
      await clickShape(page, 'right')
      await primeFill(page, '#0000ff')
      const rightFillsBefore = await fillsById(page, 'Sprite1', 0, ['right'])
      await setHsv(page, 'stroke-hue', 0)
      await page.waitForFunction(
        (before) => {
          const strokes = Array.from(document.querySelectorAll('.vector-preview [stroke]')).map((node) =>
            (node.getAttribute('stroke') ?? '').toLowerCase(),
          )
          return strokes.length > 0 && !strokes.includes(before)
        },
        rightFillsBefore['right']!.stroke,
        { timeout: 10_000 },
      )
      await waitIdle()
      const rightAfterStroke = await fillsById(page, 'Sprite1', 0, ['right'])
      expect(rightAfterStroke['right']!.stroke).not.toBe(rightFillsBefore['right']!.stroke)
      expect(rightAfterStroke['right']!.fill).toBe(rightFillsBefore['right']!.fill)
      await undoButton(page).click()
      const rightStrokeBack = await fillsById(page, 'Sprite1', 0, ['right'])
      expect(rightStrokeBack['right']!.stroke).toBe(rightFillsBefore['right']!.stroke)
      expect(rightStrokeBack['right']!.fill).toBe(rightFillsBefore['right']!.fill)
      // 他assetは全行程で無傷。
      const afterAllStages = await svgBytes(page, 'Sprite2', 0)
      expect(afterAllStages.sum).toBe(baselineC.sum)
      expect(afterAllStages.len).toBe(baselineC.len)
    } finally {
      await restoreVm(page).catch(() => undefined)
      await page.close().catch(() => undefined)
    }
  }, 180_000)

  it('Escape/pointercancel/costume-switch-close flush as one entry; gated save-wait drops stale writes', async () => {
    const page = await newSeededPage()
    try {
      const baseline = await svgBytes(page, 'Sprite1', 0)
      const baselineB = await svgBytes(page, 'Sprite1', 1)

      // Escape: 適用済みpendingを1エントリで確定し、選択を外す。
      await clickShape(page, 'left')
      await primeFill(page, '#ff0000')
      await setHsv(page, 'fill-hue', 200 / 3)
      await waitSvg(page, 'Sprite1', 0, (text) => !text.includes('#ff0000'))
      // 直前のfill()がカラー入力にフォーカスを残すため、ショートカット対象
      // 判定に弾かれないようフォーカスを外してからEscapeする。
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
      await page.keyboard.press('Escape')
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(await page.getByTestId('apply-vector-style').isEnabled()).toBe(false)
      expect((await fillsById(page, 'Sprite1', 0, ['left']))['left']!.fill).toBe('#0000ff')
      await undoButton(page).click()
      await waitSvg(page, 'Sprite1', 0, (text) => text.includes('#ff0000'))
      await redoButton(page).click()
      await waitSvg(page, 'Sprite1', 0, (text) => !text.includes('#ff0000'))

      // pointercancel: sliderとsurfaceへのcancelでも最終意図が1エントリで残る。
      // (直前は青確定なので、最終意図は緑にしてnoop化を避ける)
      await clickShape(page, 'left')
      await primeFill(page, '#0000ff')
      await inputOnly(page, 'fill-hue', 10)
      await page.getByTestId('fill-hue').evaluate((node: HTMLElement) => {
        node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true }))
      })
      await page.getByTestId('costume-paint-surface').evaluate((node: HTMLElement) => {
        node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true }))
      })
      await setHsv(page, 'fill-hue', 100 / 3)
      await waitFills(page, 'Sprite1', 0, { left: '#00ff00' })
      await waitIdle()
      expect((await fillsById(page, 'Sprite1', 0, ['left', 'right']))['left']!.fill).toBe('#00ff00')
      // 直前(Escape確定の青)からの差分は1エントリ: UndoでEscape確定状態へ。
      await undoButton(page).click()
      const onlyOneBack = await waitFills(page, 'Sprite1', 0, { left: '#0000ff' })
      expect(onlyOneBack['left']!.fill).toBe('#0000ff')
      await redoButton(page).click()
      await waitFills(page, 'Sprite1', 0, { left: '#00ff00' })

      // close相当(costume切替)を保存待ちの最中に実行: gateでVMを停め、
      // input→即切替→解放。旧assetにも新assetにもstale書込みが無いこと。
      // (選択自体はgate前に済ませる: gate中のクリック到達性は本監査の対象外)
      await clickShape(page, 'right')
      await primeFill(page, '#0000ff')
      await gateVm(page)
      await inputOnly(page, 'fill-hue', 10)
      await page.getByRole('button', { name: 'Select costumeB' }).click()
      await releaseVmGate(page)
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets.find((t: any) => t.name === 'Sprite1')
            ?.currentCostume === 1,
        null,
        { timeout: 10_000 },
      )
      await waitIdle(1200)
      const gatedA = await svgBytes(page, 'Sprite1', 0)
      const gatedB = await svgBytes(page, 'Sprite1', 1)
      // rightへのstale(橙)は旧assetに漏れない: left/rightとも切替前の確定値のまま。
      const gatedPaints = await fillsById(page, 'Sprite1', 0, ['left', 'right'])
      expect(gatedPaints['left']!.fill).toBe('#00ff00')
      expect(gatedPaints['right']!.fill).toBe('#0000ff')
      expect(gatedB.sum).toBe(baselineB.sum)
      expect(gatedB.len).toBe(baselineB.len)
      void gatedA
    } finally {
      await restoreVm(page).catch(() => undefined)
      await page.close().catch(() => undefined)
    }
  }, 180_000)

  it('history memory budgets and timer disarm are wired (code read, no product change)', async () => {
    const editorSrc = readFileSync(join(root, 'src', 'Editor.svelte'), 'utf8')
    const paintSrc = readFileSync(join(root, 'src', 'lib', 'paint-history.ts'), 'utf8')
    const pickerSrc = readFileSync(join(root, 'src', 'components', 'HsvColorPicker.svelte'), 'utf8')
    // 保存単位はencoded bytes(デコード済みピクセルを溜めない)。
    expect(paintSrc).toContain('PAINT_HISTORY_MAX_ENTRIES')
    expect(paintSrc).toContain('PAINT_HISTORY_MAX_BYTES')
    expect(paintSrc).toContain('100')
    // 600msデバウンスの単一タイマ: commit/flush/切替/unmountの全経路で解除される。
    expect(editorSrc).toContain('hsvLiveCommitTimer')
    expect(editorSrc).toContain('600')
    const clears = editorSrc.split('clearTimeout(hsvLiveCommitTimer)').length - 1
    expect(clears).toBeGreaterThanOrEqual(4)
    // unmount時にも解除(リークなし)。
    expect(editorSrc).toContain('if (hsvLiveCommitTimer) clearTimeout(hsvLiveCommitTimer)')
    // pickerは単一hexをonHexInputでのみ送り、履歴は親gesture側に集約。
    expect(pickerSrc).toContain('onHexInput(out)')
    expect(pickerSrc).toContain('onHexCommit')
  }, 30_000)
})
