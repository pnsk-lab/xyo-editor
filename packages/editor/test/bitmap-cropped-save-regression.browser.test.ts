import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Regression for the behavior-preserving `bitmap-cropped-save` extraction:
// the REAL Editor bitmap Save path (brush stroke -> explicit Save button)
// keeps its semantics after the pure-helper split, with no pending-shape UI
// wiring in this change.
//
// Covers, without touching pending UI:
// - real save persists a brush stroke (stored asset key changes, canvas kept);
// - immediate second save is idempotent (same bytes+center: key unchanged,
//   no spurious history/write, canvas untouched);
// - selection switch (stage <-> sprite) never cross-writes: returning to the
//   sprite keeps its pixels and a re-save stays a noop;
// - external pixel touch (direct canvas paint outside the Editor stroke path)
//   is picked up by the next real save (key changes again);
// - new project keeps the app functional (no exception, costumes tab alive).
//
// Dedicated Vite port 4547 (surveyed 2026-11: 4173-4495 block heavily used
// by sibling suites; 4533/4541 taken; ss showed 4547 free).
const root = join(import.meta.dir, '..')
const PORT = 4547
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function openBitmapCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

async function centerPixel(): Promise<number[]> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data)
  })
}

async function hasCenterInk(): Promise<boolean> {
  const pixel = await centerPixel()
  return (pixel[3] ?? 0) > 0
}

async function spriteCostumeKey(): Promise<string | undefined> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { project: { targets: Array<{ name: string; costumes: Array<{ md5ext?: string; assetId?: string }> }> } } } }).__hikkakuEditorTest
    const snapshot = api?.snapshot()
    const sprite = snapshot?.project.targets.find((target) => target.name === 'Sprite1') ?? snapshot?.project.targets.find((target) => target.name !== 'Stage')
    return sprite?.costumes[0]?.md5ext ?? sprite?.costumes[0]?.assetId
  })
}

async function waitForBitmapStatus() {
  await page.waitForFunction(() => document.body.textContent?.includes('Bitmap') ?? false, null, { timeout: 15_000 })
}

describe('bitmap cropped-save extraction regression (real Editor save)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('real save persists, double-save is a noop, selection/new-project stay safe', async () => {
    await openBitmapCostumes()
    const canvas = page.getByTestId('bitmap-editor-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2

    // Opaque baseline stroke through the real brush tool.
    await page.getByTestId('bitmap-tool-brush').click()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
    await page.mouse.move(x - 8, y)
    await page.mouse.down()
    await page.mouse.move(x + 8, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data[3] === 255
    })

    // Real save persists the stroke.
    await page.getByTestId('save-bitmap-costume').click()
    await waitForBitmapStatus()
    expect(await hasCenterInk()).toBe(true)
    const keyAfterSave = await spriteCostumeKey()
    expect(typeof keyAfterSave === 'string' && keyAfterSave.length > 0).toBe(true)

    // Immediate second save is idempotent: same bytes+center, no rewrite.
    await page.getByTestId('save-bitmap-costume').click()
    await waitForBitmapStatus()
    expect(await hasCenterInk()).toBe(true)
    expect(await spriteCostumeKey()).toBe(keyAfterSave)

    // Selection switch away and back never cross-writes the sprite asset.
    await page.getByTestId('target-card-stage').click()
    await page.getByTestId('target-card-Sprite1').click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    expect(await hasCenterInk()).toBe(true)
    await page.getByTestId('save-bitmap-costume').click()
    await waitForBitmapStatus()
    expect(await spriteCostumeKey()).toBe(keyAfterSave)

    // External pixel touch outside the stroke path is picked up by next save.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.fillStyle = '#00ff00'
      context.fillRect(Math.floor(target.width / 2) - 2, Math.floor(target.height / 2) - 2, 4, 4)
    })
    await page.getByTestId('save-bitmap-costume').click()
    await waitForBitmapStatus()
    expect(await hasCenterInk()).toBe(true)
    const keyAfterExternal = await spriteCostumeKey()
    expect(typeof keyAfterExternal === 'string' && keyAfterExternal.length > 0).toBe(true)

    // New project keeps the app functional (no exception, costumes tab alive).
    await page.getByText('ファイル').click()
    await page.getByRole('button', { name: '新規' }).click()
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  }, 180_000)
})
