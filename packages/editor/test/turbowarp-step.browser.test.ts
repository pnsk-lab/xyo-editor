import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Opt in: real CDN and Chromium/WebGL are required.
const test = process.env.TURBOWARP_CDN_TEST === '1' ? it : it.skip
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4180'

describe('TurboWarp editor step', () => {
  test('advances exactly one real frame while preserving a stopped loop', async () => {
    const server = spawn(
      'bun',
      ['x', 'vite', '--host', '127.0.0.1', '--port', '4180', '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
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
      browser = await launchBrowser({
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
      })
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.stack || error.message))
      await page.goto(`${base}/test/turbowarp-step-fixture.html`)
      await page.waitForFunction(() => typeof (window as any).runStepFixture === 'function')
      const result = await page.evaluate(() => (window as any).runStepFixture())
      expect(result.before).toEqual({ x: 0, running: false, threads: 1, topBlock: 'flag' })
      expect(result.after.x).toBe(25)
      expect(result.after.snapshotX).toBe(25)
      expect(result.after.running).toBe(false)
      expect(result.after.calls).toBe(1)
      expect(result.after.nestedError).toMatch(/already in progress/)
      expect(result.later).toEqual({ x: 25, running: false, calls: 1 })
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      server.kill()
    }
  }, 60_000)

  test('steps a synchronized real backend without unhandled page errors', async () => {
    const server = spawn(
      'bun',
      ['x', 'vite', '--host', '127.0.0.1', '--port', '4180', '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
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
      browser = await launchBrowser({
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
      })
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.stack || error.message))
      await page.addInitScript(() => localStorage.setItem('hikkaku.runtime-backend', 'tw'))
      await page.goto(`${base}/test/turbowarp-editor-fixture.html`)
      await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20000 })
      expect(await page.evaluate(() => !!(window as any).__twBackend)).toBe(true)
      expect(await page.getByRole('alert').count()).toBe(0)
      // Wait for the backend's real synchronization event, not merely canvas mount.
      await page.evaluate(() => {
        ;(window as any).__stepSynced = false
        ;(window as any).__twBackend.vm.on('TURBOWARP_PROJECT_SYNCED', () => {
          ;(window as any).__stepSynced = true
        })
      })
      await page.getByLabel('Green flag').click()
      await page.waitForFunction(() => (window as any).__stepSynced === true, null, {
        timeout: 10000,
      })
      await page.getByLabel('Pause', { exact: true }).click()
      await page.waitForTimeout(200)
      const status = await page.evaluate(() => (window as any).__hikkakuEditorTest.status())
      expect(status).not.toMatch(/not synchronized|does not support|error|disposed/i)
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      server.kill()
    }
  }, 45000)
})
