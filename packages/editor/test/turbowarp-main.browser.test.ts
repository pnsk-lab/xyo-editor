import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser } from 'playwright-core'
import { launchBrowser } from './browser-launcher'
import { strToU8, zipSync } from 'fflate'

// Opt-in: this test deliberately uses the live, pinned official CDN and WebGL.
const suite = process.env.TURBOWARP_CDN_TEST === '1' ? describe : describe.skip
const root = join(import.meta.dir, '..')
const url = 'http://127.0.0.1:4183/'
const cdn =
  'https://cdn.jsdelivr.net/npm/@turbowarp/packager@3.14.0/dist/scaffolding/scaffolding-full.js'
let server: ChildProcess | undefined
let browser: Browser | undefined
let output: string | undefined

suite('production main entry with real TurboWarp', () => {
  beforeAll(async () => {
    output = mkdtempSync(join(tmpdir(), 'xyo-main-e2e-'))
    const build = spawnSync('bun', ['x', 'vite', 'build', '--outDir', output], {
      cwd: root,
      encoding: 'utf8',
    })
    if (build.status !== 0)
      throw new Error(`Production build failed: ${build.stderr}\n${build.stdout}`)
    server = spawn(
      'bun',
      [
        'x',
        'vite',
        'preview',
        '--outDir',
        output,
        '--host',
        '127.0.0.1',
        '--port',
        '4183',
        '--strictPort',
      ],
      { cwd: root, stdio: 'ignore' },
    )
    for (let i = 0; ; i++) {
      if (server.exitCode !== null) throw new Error(`Preview exited: ${server.exitCode}`)
      try {
        if ((await fetch(url)).ok) break
      } catch {
        /* wait for server */
      }
      if (i === 100) throw new Error('Preview did not start')
      await Bun.sleep(100)
    }
    browser = await launchBrowser({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
    })
  }, 120000)
  afterAll(async () => {
    await browser?.close()
    server?.kill()
    if (output) rmSync(output, { recursive: true, force: true })
  })

  it('falls back to the default VM with a visible error when the official CDN fails', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    let requests = 0
    try {
      await context.route(cdn, (route) => {
        requests++
        return route.abort('failed')
      })
      await page.addInitScript(() => localStorage.setItem('hikkaku.runtime-backend', 'turbowarp'))
      await page.goto(url)
      await page.getByRole('alert').waitFor({ state: 'visible', timeout: 30000 })
      expect(await page.getByRole('alert').textContent()).toContain(
        '現行 VM を使用します',
      )
      await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30000 })
      expect(requests).toBe(1)
      expect(await page.evaluate(() => localStorage.getItem('hikkaku.runtime-backend'))).toBe(
        'turbowarp',
      )
      await page.getByLabel('Green flag').click()
      expect(await page.getByTestId('stage-canvas').isVisible()).toBe(true)
    } finally {
      await context.close()
    }
  }, 60000)

  for (const failure of ['webgl', 'audio'] as const) {
    it(`falls back safely when ${failure} initialization fails`, async () => {
      const context = await browser!.newContext()
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.stack || error.message))
      try {
        if (failure === 'audio') {
          await context.route(cdn, async (route) => {
            const response = await route.fetch()
            const body = await response.text()
            await route.fulfill({
              response,
              body: `${body}\nwindow.Scaffolding = {...window.Scaffolding, AudioEngine: class { constructor() { throw new Error('simulated audio initialization failure') } }};`,
            })
          })
        }
        await page.addInitScript((kind) => {
          localStorage.setItem('hikkaku.runtime-backend', 'turbowarp')
          if (kind === 'webgl') {
            const original = HTMLCanvasElement.prototype.getContext
            HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
              if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')
                return null
              return (original as Function).call(this, type, ...args)
            } as typeof HTMLCanvasElement.prototype.getContext
          }
        }, failure)
        await page.goto(url)
        await page.getByRole('alert').waitFor({ state: 'visible', timeout: 30000 })
        expect(await page.getByRole('alert').textContent()).toContain('現行 VM を使用します')
        await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30000 })
        await page.getByLabel('Green flag').click()
        expect(await page.evaluate(() => localStorage.getItem('hikkaku.runtime-backend'))).toBe(
          'turbowarp',
        )
        expect(errors).toEqual([])
      } finally {
        await context.close()
      }
    }, 60000)
  }

  it('preserves the current project on selection, then loads and runs the real backend after reload', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const requests: string[] = []
    const failures: string[] = []
    let navigations = 0
    page.on('request', (request) => {
      if (request.url().includes('turbowarp')) requests.push(request.url())
    })
    page.on('requestfailed', (request) => {
      if (request.url() === cdn)
        failures.push(request.failure()?.errorText || 'unknown network failure')
    })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations++
    })
    try {
      await page.goto(url)
      await page.getByTestId('stage-canvas').waitFor()
      const costume = {
        name: 'red',
        assetId: '12345678901234567890123456789012',
        md5ext: '12345678901234567890123456789012.svg',
        dataFormat: 'svg',
        rotationCenterX: 25,
        rotationCenterY: 25,
      }
      const common = {
        variables: {},
        lists: {},
        broadcasts: {},
        comments: {},
        currentCostume: 0,
        costumes: [costume],
        sounds: [],
        volume: 100,
      }
      const blocks = {
        flag: {
          opcode: 'event_whenflagclicked',
          next: 'move',
          parent: null,
          inputs: {},
          fields: {},
          shadow: false,
          topLevel: true,
          x: 32,
          y: 32,
        },
        move: {
          opcode: 'motion_changexby',
          next: null,
          parent: 'flag',
          inputs: { DX: [1, [4, '25']] },
          fields: {},
          shadow: false,
          topLevel: false,
        },
      }
      const project = {
        targets: [
          {
            ...common,
            isStage: true,
            name: 'Stage',
            blocks: {},
            layerOrder: 0,
            tempo: 60,
            videoTransparency: 50,
            videoState: 'on',
          },
          {
            ...common,
            isStage: false,
            name: 'Sprite1',
            blocks,
            layerOrder: 1,
            visible: true,
            x: 40,
            y: 0,
            size: 100,
            direction: 90,
            draggable: false,
            rotationStyle: 'all around',
          },
        ],
        monitors: [],
        extensions: [],
        meta: { semver: '3.0.0', vm: '0.2.0', agent: 'test' },
      }
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>'
      const archive = Buffer.from(
        zipSync({
          'project.json': strToU8(JSON.stringify(project)),
          [costume.md5ext]: strToU8(svg),
        }),
      )
      await page
        .getByTestId('project-file-input')
        .setInputFiles({ name: 'test.sb3', mimeType: 'application/x.scratch.sb3', buffer: archive })
      await page.waitForFunction(
        () => (window as any).__hikkakuEditorTest?.workspaceBlocks?.().flag,
      )
      const before = await page.evaluate(
        () => (window as any).__hikkakuEditorTest.snapshot().project,
      )
      expect(requests).toEqual([])
      await page.getByRole('button', { name: '設定', exact: true }).click()
      const select = page.getByRole('dialog', { name: '設定' }).getByLabel('ランタイムの選択')
      page.once('dialog', (dialog) => dialog.accept())
      await select.selectOption('turbowarp')
      expect(await page.evaluate(() => localStorage.getItem('hikkaku.runtime-backend'))).toBe(
        'turbowarp',
      )
      expect(navigations).toBe(1)
      expect(
        await page.evaluate(() => (window as any).__hikkakuEditorTest.snapshot().project),
      ).toEqual(before)
      expect(requests).toEqual([])
      const response = page
        .waitForResponse((response) => response.url() === cdn, { timeout: 30000 })
        .catch(() => null)
      await page.reload()
      const cdnResponse = await response
      if (!cdnResponse?.ok())
        throw new Error(
          `Official TurboWarp CDN unavailable: ${failures.join(', ') || `HTTP ${cdnResponse?.status() ?? 'no response'}`}`,
        )
      await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30000 })
      expect(requests.filter((request) => request === cdn).length).toBe(1)
      expect(await page.getByRole('alert').count()).toBe(0)
      expect(
        await page
          .getByTestId('stage-canvas')
          .evaluate(
            (el) =>
              !!(
                (el as HTMLCanvasElement).getContext('webgl2') ||
                (el as HTMLCanvasElement).getContext('webgl')
              ),
          ),
      ).toBe(true)
      await page
        .getByTestId('project-file-input')
        .setInputFiles({ name: 'test.sb3', mimeType: 'application/x.scratch.sb3', buffer: archive })
      await page.waitForFunction(
        () => (window as any).__hikkakuEditorTest?.workspaceBlocks?.().flag,
      )
      await page.getByLabel('Green flag').click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest
            .snapshot()
            .project.targets.find((t: any) => t.name === 'Sprite1')?.x === 65,
        null,
        { timeout: 10000 },
      )
    } finally {
      await context.close()
    }
  }, 90000)
})
