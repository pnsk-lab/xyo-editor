import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Disabled-pending preservation proof (real Editor + real VM).
//
// The pending rect/oval path is OFF by default (`BITMAP_PENDING_UI_ENABLED =
// false`): external reloads bypass it via `destroy()`, move/scale are
// unconnected, and many ops bypass commit. With the path disabled the legacy
// immediate-raster behavior must hold unchanged:
// - a rectangle drag saves immediately with exactly one Undo entry,
// - tool / same-costume (same-id reload) / target / project round-trips
//   preserve the committed raster exactly as before,
// - no pending recovery controls are ever visible.
//
// NOTE: `bitmap-pending-restyle.browser.test.ts` intentionally keeps 2
// failing assertions (the restyle/commit-on-deselect gap is real and still
// open). This file does not weaken or delete that coverage: it pins the
// disabled-path legacy behavior only.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-disabled.browser.test.ts
const root = join(import.meta.dir, '..')
const PORT = 4381
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const BOX = { x1: 280, y1: 260, x2: 480, y2: 360 }
const CENTER = { x: 380, y: 310 }

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function canvasRectLive(): Promise<{ left: number; top: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const rect = target.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const rect = await canvasRectLive()
  const size = await canvasSize()
  return { x: rect.left + (x / size.width) * rect.width, y: rect.top + (y / size.height) * rect.height }
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
  }, [x, y] as unknown as undefined)
}

async function canvasDigest(): Promise<string> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data).join(',')
  })
}

async function waitForStatus(text: string, timeout = 15_000) {
  await page.waitForFunction((want) => document.body.textContent?.includes(want as string) ?? false, text as unknown as undefined, {
    timeout,
  })
}

async function waitForStableDigest(tries = 10): Promise<string> {
  let last = await canvasDigest()
  for (let i = 0; i < tries; i += 1) {
    await page.waitForTimeout(400)
    const next = await canvasDigest()
    if (next === last) return next
    last = next
  }
  return last
}

async function pendingRecoveryCount(): Promise<{ status: number; exp: number; dis: number; ack: number }> {
  return await page.evaluate(() => ({
    status: document.querySelectorAll('[data-testid="bitmap-pending-status"]').length,
    exp: document.querySelectorAll('[data-testid="bitmap-pending-export"]').length,
    dis: document.querySelectorAll('[data-testid="bitmap-pending-discard"]').length,
    ack: document.querySelectorAll('[data-testid="bitmap-pending-acknowledge-gap"]').length,
  }))
}

async function assertNoPendingUi(): Promise<void> {
  const counts = await pendingRecoveryCount()
  expect(counts).toEqual({ status: 0, exp: 0, dis: 0, ack: 0 })
  const text = await page.evaluate(() => document.body.textContent ?? '')
  expect(text).not.toContain('quarantined')
  expect(text).not.toContain('history-gap')
  expect(text).not.toContain('Pending shape')
}

async function openBitmap() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
  } catch {
    // Already in bitmap mode.
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 })
  } catch {
    // Best effort only.
  }
  await page.waitForTimeout(800)
  const size = await canvasSize()
  if (size.width !== 960 || size.height !== 720) {
    throw new Error(`Expected bitmap res2 960x720 backing, got ${size.width}x${size.height}`)
  }
}

async function useSolidFill(fill: string) {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
}

async function drawRedRect() {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  await useSolidFill('#ff0000')
  const a = await toScreen(BOX.x1, BOX.y1)
  const b = await toScreen(BOX.x2, BOX.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

describe('bitmap pending disabled: legacy immediate save preserved', () => {
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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('rectangle saves immediately with exactly one undo and no recovery controls', async () => {
    await openBitmap()
    const beforeCenter = await pixel(CENTER.x, CENTER.y)
    await drawRedRect()
    await waitForStatus('Bitmap edit saved')
    // Immediate raster: the committed pixels are on the canvas at once.
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Disabled path: no pending recovery UI may appear.
    await assertNoPendingUi()
    // Exactly one Undo entry: a single Undo restores the pre-drag raster.
    await page.locator('button[aria-label="Undo"]').first().click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, beforeCenter] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    // Redo repaints the committed rect: the entry round-trips exactly once.
    await page.locator('button[aria-label="Redo"]').first().click()
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 255 && g === 0 && b === 0 && a === 255
      },
      [CENTER.x, CENTER.y] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await assertNoPendingUi()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }, 180_000)

  it('tool / same-costume reload / target / project round-trips preserve the committed raster', async () => {
    await openBitmap()
    // Ensure a committed rect exists (idempotent: draw only if missing).
    if ((await pixel(CENTER.x, CENTER.y)).join(',') !== '255,0,0,255') {
      await drawRedRect()
      await waitForStatus('Bitmap edit saved')
    }
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const committed = await waitForStableDigest()
    await assertNoPendingUi()

    // Tool switch preserves the committed raster.
    await page.getByTestId('bitmap-tool-select').click()
    await page.waitForTimeout(500)
    expect(await canvasDigest()).toBe(committed)
    await page.getByTestId('bitmap-tool-rect').click()
    await page.waitForTimeout(500)
    expect(await canvasDigest()).toBe(committed)
    await assertNoPendingUi()

    // Same-costume reselect (same-id reload path) preserves the raster.
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select"]').click()
    await waitForStableDigest()
    expect(await canvasDigest()).toBe(committed)
    await assertNoPendingUi()

    // Target switch away and back preserves each target's raster.
    const cards: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    if (cards.length > 1) {
      const other = cards.find((c) => c !== cards[0])!
      const current = cards[0]!
      await page.evaluate((id: string) => {
        ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
      }, other as unknown as undefined)
      await page.waitForTimeout(1200)
      await page.evaluate((id: string) => {
        ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
      }, current as unknown as undefined)
      await waitForStableDigest()
      await page.getByTestId('main-tab-costumes').click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
      await waitForStableDigest()
      expect(await canvasDigest()).toBe(committed)
      await assertNoPendingUi()
    }

    // Project export -> re-import round-trip preserves the committed work.
    // (The ファイル menu is a <details>/<summary>, not a button.)
    // Record the identity we committed on: a fresh import may land the
    // selection elsewhere, so reselect it before comparing pixels.
    const committedIdentity = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
      const selected = cards.find((el) => {
        const cls = el.getAttribute('class') ?? ''
        return cls.includes('shadow-[0_0_0_3px_#bda6ef]') || cls.includes('ring-2')
      })
      const testid = selected?.getAttribute('data-testid') ?? ''
      const snap = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { project?: { targets?: Array<{ name?: string; isStage?: boolean; currentCostume?: number }> } } } }).__hikkakuEditorTest?.snapshot()
      const targets = snap?.project?.targets ?? []
      const target = testid === 'target-card-stage'
        ? targets.find((t) => t.isStage)
        : targets.find((t) => t.name === testid.replace(/^target-card-/, ''))
      return { testid, costumeIndex: target?.currentCostume ?? 0 }
    })
    await page.locator('details.menu summary', { hasText: 'ファイル' }).click()
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByRole('button', { name: 'Export project' }).click(),
    ])
    const suggested = download.suggestedFilename() || 'project.json'
    const stream = await download.createReadStream()
    const chunks: Uint8Array[] = []
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const buffer = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      buffer.set(c, offset)
      offset += c.length
    }
    // The hidden file input never becomes visible, so inject the downloaded
    // project in-page (same `change` event the real picker fires).
    const roundtripName = suggested.endsWith('.json') ? suggested : 'roundtrip.json'
    const roundtripText = Buffer.from(buffer).toString('utf8')
    await page.evaluate(
      ({ name, text }) => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="project-file-input"]')!
        const file = new File([text as string], name as string, { type: 'application/json' })
        const transfer = new DataTransfer()
        transfer.items.add(file)
        input.files = transfer.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      },
      { name: roundtripName, text: roundtripText } as unknown as undefined,
    )
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    // Reselect the committed identity (import may land elsewhere).
    if (committedIdentity.testid) {
      await page.evaluate((id: string) => {
        ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
      }, committedIdentity.testid as unknown as undefined)
      await page.waitForTimeout(800)
    }
    await page.evaluate((index: number) => {
      ;(document.querySelector(`[data-testid="costume-card-${index}"] button[aria-label^="Select"]`) as HTMLButtonElement | null)?.click()
    }, committedIdentity.costumeIndex as unknown as undefined)
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    const restored = await waitForStableDigest()
    expect(restored).toBe(committed)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await assertNoPendingUi()
  }, 240_000)
})
