import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Measures the real zoom-button geometry and viewport transitions of the
// current costume editor UI (read-only probe: clicks real buttons, records
// rects/labels, asserts nothing about artwork).
//
// Baseline (Paper reset 0.5, per-mode density 1.0 for bitmap res2):
// - the toolbar label is UI-only per-mode percent
//   (`viewportUiPercentForDensity`: reset always "100%");
// - the real computed scale comes from the live canvas rect
//   (`rect.width / canvas.width`): res2 reset 0.5 renders the 960 canvas at
//   480 CSS px, floor 0.333 renders ~320 CSS px ("67%"), one Zoom in step is
//   +0.5 CSS (+0.5 Paper units at density 1.0).
// - legacy `scale == label/100` (100% == scale 1) does NOT hold in res2 mode.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/zoom-parity-audit.browser.test.ts
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4313'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function zoomLabel(): Promise<string> {
  return (await page.evaluate(
    () => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
  )) as string
}

async function waitZoomLabel(text: string, timeout = 10_000) {
  // Strict UI-label equality: '67%' must not match a future '167%'.
  await page.waitForFunction(
    (want) => (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim() === (want as string),
    text as unknown as undefined,
    { timeout },
  )
}

async function settleAfterOpen() {
  await page.waitForFunction(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

describe('zoom parity audit on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4313', '--strictPort'], {
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

  it('measures zoom button geometry and button-driven viewport transitions', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    await settleAfterOpen()
    // Reset to the deterministic {0,0,1} state first.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))

    const geometry = await page.evaluate(() => {
      const pick = (label: string) => {
        const button = document.querySelector(`[aria-label="${label}"]`)!
        const rect = button.getBoundingClientRect()
        const svg = button.querySelector('svg')
        const icon = svg?.getBoundingClientRect()
        return {
          w: rect.width,
          h: rect.height,
          iconW: icon?.width ?? 0,
          iconH: icon?.height ?? 0,
        }
      }
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return {
        out: pick('Zoom out'),
        reset: pick('Reset zoom'),
        in: pick('Zoom in'),
        canvas100: { w: rect.width, h: rect.height },
      }
    })
    console.log(`BUTTON_GEOMETRY ${JSON.stringify(geometry)}`)

    // Zoom in: res2 0.5 -> 1.0 Paper-parity (+0.5 CSS at density 1.0),
    // label 100% -> 200%, canvas rect scales with the real CSS scale (2x).
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('200%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const zoomed = (await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return { w: rect.width, h: rect.height, scale: rect.width / canvas.width }
    })) as { w: number; h: number; scale: number }
    console.log(`CANVAS_200 ${JSON.stringify(zoomed)}`)
    expect(zoomed.scale).toBeCloseTo(1, 1)
    expect(zoomed.w / geometry.canvas100.w).toBeCloseTo(2, 1)
    expect(zoomed.h / geometry.canvas100.h).toBeCloseTo(2, 1)

    // Zoom out from 1.0: 1.0 - 0.5 = 0.5 -> label back to 100%.
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Minimum special step (per-mode Paper band res2 0.333..5): zoom out to
    // the 0.333 floor (label "67%"), then zooming in lands on the reset 0.5
    // (label "100%"), mirroring the audited 0.333 -> 0.5 floor-exit pattern.
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await waitZoomLabel('67%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const floorRect = (await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return { w: rect.width, h: rect.height, scale: rect.width / canvas.width }
    })) as { w: number; h: number; scale: number }
    console.log(`CANVAS_FLOOR ${JSON.stringify(floorRect)}`)
    expect(floorRect.scale).toBeCloseTo(0.333, 1)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Reset: back to 100% with the artwork recentered.
    await page.getByRole('button', { name: 'Reset zoom' }).click()
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const resetRect = (await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return { w: rect.width, h: rect.height }
    })) as { w: number; h: number }
    console.log(`CANVAS_RESET ${JSON.stringify(resetRect)}`)
    expect(resetRect.w).toBeCloseTo(geometry.canvas100.w, 0)
    expect(resetRect.h).toBeCloseTo(geometry.canvas100.h, 0)

    // Sanity: button geometry matches the h-9/w-10/w-12 Tailwind sizing
    // (36px tall; 40px / 48px wide) and the 17px Lucide icons.
    expect(geometry.out.h).toBeCloseTo(36, 0)
    expect(geometry.in.h).toBeCloseTo(36, 0)
    expect(geometry.reset.h).toBeCloseTo(36, 0)
    expect(geometry.out.w).toBeCloseTo(40, 0)
    expect(geometry.in.w).toBeCloseTo(40, 0)
    expect(geometry.reset.w).toBeCloseTo(48, 0)
    expect(await zoomLabel()).toContain('100%')
  }, 120_000)
})
