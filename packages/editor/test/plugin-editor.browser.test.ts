import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4180'
let server: ChildProcessWithoutNullStreams | undefined
let browser: Browser | undefined
let page: Page | undefined
const diagnostics: string[] = []

describe('plugin editor integration', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4180', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
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
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
        diagnostics.push(`console: ${message.text()}`)
      }
    })
    await page.goto(`${base}/test/plugin-editor-fixture.html`)
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible' })
  }, 60000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    server?.kill()
  })

  it('adds a tab with a live view and follows the editor theme', async () => {
    const tab = page!.getByTestId('main-tab-plugin:demo-panel/panel')
    await tab.click()
    const view = page!.getByTestId('plugin-view')
    await view.waitFor({ state: 'visible' })
    expect(await view.textContent()).toContain('theme=light')

    await page!.getByRole('button', { name: 'ダークモードに切り替え' }).click()
    await page!.waitForFunction(
      () => document.querySelector('[data-testid="plugin-view"]')?.textContent?.includes('theme=dark'),
    )
    await page!.getByRole('button', { name: 'ライトモードに切り替え' }).click()
  })

  it('disables and re-enables the plugin from settings', async () => {
    await page!.getByRole('button', { name: '設定', exact: true }).click()
    const dialog = page!.getByRole('dialog', { name: '設定' })
    await dialog.getByRole('button', { name: 'プラグイン', exact: true }).click()
    const item = dialog.getByTestId('plugin-demo-panel')
    await item.waitFor({ state: 'visible' })
    expect(await item.textContent()).toContain('Demo panel')

    await item.getByRole('switch', { name: 'Demo panelを無効にする' }).click()
    await page!.getByTestId('main-tab-plugin:demo-panel/panel').waitFor({ state: 'detached' })
    await page!.getByTestId('main-tab-code').waitFor({ state: 'visible' })

    await item.getByRole('switch', { name: 'Demo panelを有効にする' }).click()
    await page!.getByTestId('main-tab-plugin:demo-panel/panel').waitFor({ state: 'visible' })
    expect(diagnostics).toEqual([])
  })
})
