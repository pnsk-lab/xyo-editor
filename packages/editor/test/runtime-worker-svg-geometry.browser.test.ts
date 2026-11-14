import { describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4257'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('runtime worker SVG geometry (real worker)', () => {
  it('keeps explicit 300x150, viewBox-only 93x41, PNG and switch/update/load sizes', async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4257', '--strictPort'], {
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
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] })
    page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.stack || error.message))
    await page.goto(`${base}/test/runtime-worker-svg-fixture.html`)
    await page.waitForFunction(() => typeof (window as any).runWorkerSvgFixture === 'function')
    const outcome = await page.evaluate(() => (window as any).runWorkerSvgFixture())
    expect(errors).toEqual([])
    expect(outcome.summary).toEqual({
      explicit: true,
      arbitraryCenter: true,
      viewBoxOnly: true,
      png: true,
      switchBack: true,
      update: true,
      load: true,
    })
    expect(outcome.pass).toBe(true)
    // Spot-check the exact worker-reported boxes (rotationCenter stays an offset).
    expect(outcome.results.explicit).toMatchObject({ width: 300, height: 150, left: -75, top: 37.5 })
    expect(outcome.results.arbitraryCenter).toMatchObject({ width: 300, height: 150, left: -10, top: 10 })
    expect(outcome.results.viewBoxOnly).toMatchObject({ width: 93, height: 41 })
    expect(outcome.results.png).toMatchObject({ width: 300, height: 150 })
    expect(outcome.results.switchBack).toMatchObject({ width: 300, height: 150 })
    await browser?.close()
    browser = undefined
    server?.kill()
    server = undefined
  }, 120_000)
})
