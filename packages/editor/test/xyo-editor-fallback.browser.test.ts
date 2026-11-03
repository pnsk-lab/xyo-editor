import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { type Browser } from 'playwright-core'
import { hasPackedLlvmArtifacts, optIn } from './artifacts'
import { launchBrowser } from './browser-launcher'

// Build the editor first, then opt in: XYO_FALLBACK_BROWSER=1 bun test test/xyo-editor-fallback.browser.test.ts
// CHROME_BIN can point at Chrome or Brave; each test uses a fresh browser context.
const enabled = optIn('XYO_FALLBACK_BROWSER', hasPackedLlvmArtifacts)
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''

;(enabled ? describe : describe.skip)('experimental LLVM editor backend', () => {
  beforeAll(async () => {
    const socket = createServer()
    await new Promise<void>((resolve, reject) =>
      socket.once('error', reject).listen(0, '127.0.0.1', resolve),
    )
    const address = socket.address()
    if (!address || typeof address === 'string') throw new Error('No available port')
    const port = address.port
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    )
    base = `http://127.0.0.1:${port}`
    server = spawn(
      process.execPath,
      ['x', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: join(import.meta.dir, '..'), stdio: 'ignore' },
    )
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('Vite preview exited')
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {
        /* starting */
      }
      await Bun.sleep(100)
    }
    if (!ready) throw new Error('Vite preview did not start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 30000)
  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  test('saved xyo selection loads the experimental LLVM backend and runs the green flag', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    page.on('dialog', (dialog) => void dialog.accept())
    await page.addInitScript(() => {
      const Original = window.Worker
      ;(window as any).__workers = []
      ;(window as any).__workerOperations = []
      window.Worker = class extends Original {
        constructor(url: string | URL, options?: WorkerOptions) {
          ;(window as any).__workers.push(String(url))
          super(url, options)
        }
        postMessage(message: any, ...rest: any[]) {
          if (message?.operation) (window as any).__workerOperations.push(message.operation)
          return super.postMessage(message, ...(rest as []))
        }
      }
    })
    try {
      await page.goto(base)
      await page.getByTestId('stage-canvas').waitFor()
      await page.getByRole('button', { name: '設定', exact: true }).click()
      await page.getByLabel('ランタイムの選択').selectOption('xyo-cpp')
      expect(await page.evaluate(() => localStorage.getItem('hikkaku.runtime-backend'))).toBe(
        'xyo-cpp',
      )
      await page.reload()
      await page.getByTestId('stage-canvas').waitFor()
      await page.getByRole('button', { name: '設定', exact: true }).click()
      expect(await page.getByLabel('ランタイムの選択').inputValue()).toBe('xyo-cpp')
      await page.getByRole('button', { name: '設定を閉じる' }).click()
      const project = {
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: { v: ['counter', 7] },
            lists: {},
            broadcasts: {},
            blocks: {
              hat: {
                opcode: 'event_whenflagclicked',
                next: 'change',
                parent: null,
                inputs: {},
                fields: {},
                topLevel: true,
                x: 10,
                y: 10,
              },
              change: {
                opcode: 'data_changevariableby',
                next: null,
                parent: 'hat',
                inputs: { VALUE: [1, [4, '3']] },
                fields: { VARIABLE: ['counter', 'v'] },
              },
            },
            costumes: [],
            sounds: [],
            currentCostume: 0,
            volume: 100,
            layerOrder: 0,
          },
        ],
        monitors: [
          {
            id: 'v',
            mode: 'default',
            opcode: 'data_variable',
            params: { VARIABLE: 'counter' },
            spriteName: null,
            value: 7,
            width: 0,
            height: 0,
            x: 5,
            y: 5,
            visible: true,
          },
        ],
        extensions: [],
        meta: { semver: '3.0.0' },
      }
      const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
      await page.getByTestId('project-file-input').setInputFiles({
        name: 'fallback.sb3',
        mimeType: 'application/zip',
        buffer: Buffer.from(bytes),
      })
      await page
        .getByRole('button', { name: 'counter monitor' })
        .getByText('7', { exact: true })
        .waitFor()
      await page.getByRole('button', { name: 'Green flag' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables?.v?.[1] ===
          10,
        null,
        { timeout: 120000 },
      )
      await page
        .getByRole('button', { name: 'counter monitor' })
        .getByText('10', { exact: true })
        .waitFor()
      // The stage shows the LLVM compile summary next to the FPS counter.
      const stats = page.getByTestId('stage-llvm-stats')
      await stats.waitFor()
      expect((await stats.textContent())?.trim()).toMatch(
        /^compiled in \d+(\.\d+)?ms \((passed \d+\/\d+|nothing to compile)\)$/,
      )
      // Reflag accumulates from live state (10 + 3), proving per-flag seeding.
      await page.getByRole('button', { name: 'Green flag' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables?.v?.[1] ===
          13,
        null,
        { timeout: 120000 },
      )
      const workers = await page.evaluate(() => ({
        urls: (window as any).__workers as string[],
        operations: (window as any).__workerOperations,
      }))
      // The built-in renderer/runtime worker is allowed, as are the LLVM
      // pipeline workers; no legacy xyo operation protocol may be sent.
      expect(workers.urls.length).toBeGreaterThan(0)
      expect(
        workers.urls.every((url) =>
          /runtime\.worker|pipeline-worker|llc-browser|lld-browser|llvm-runner\.worker/i.test(url),
        ),
      ).toBe(true)
      expect(
        workers.urls.some((url) => /pipeline-worker|llc-browser|llvm-runner\.worker/i.test(url)),
      ).toBe(true)
      expect(workers.operations).toEqual([])
      expect(requests.filter((url) => /xyo-worker|xyo-cpp.*\.(?:wasm|js)/i.test(url))).toEqual([])
      expect(requests.some((url) => /llvm-artifacts\/xyo_browser_ir\.wasm/i.test(url))).toBe(true)
      // The unified xyo-cpp runtime itself must be what executes the project.
      expect(requests.some((url) => /llvm-artifacts\/unified_runtime_esm\.wasm/i.test(url))).toBe(
        true,
      )
      // xyo-cpp's interpreter worker/runtime is gone: only the LLVM pipeline runs off-thread.
      expect(workers.urls.some((url) => /pipeline-worker|llvm-runner\.worker/i.test(url))).toBe(
        true,
      )
    } finally {
      await context.close()
    }
  }, 300000)

  // KNOWN GAP: with costume assets the app-level touching condition never
  // became true. The bridge itself is verified against the real runtime in
  // xyo-unified-renderer.test.ts (host answer drives the branch), so the open
  // question is costume/skin resolution inside the app, not the callbacks.
  test('resolves a touching condition through the host renderer', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    page.on('dialog', (dialog) => void dialog.accept())
    await page.addInitScript(() => {
      localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp')
    })
    try {
      await page.goto(base)
      await page.getByTestId('stage-canvas').waitFor()
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#e01a1a"/></svg>'
      const asset = createHash('md5').update(svg).digest('hex')
      const costume = {
        name: 'square',
        assetId: asset,
        dataFormat: 'svg',
        md5ext: `${asset}.svg`,
        rotationCenterX: 50,
        rotationCenterY: 50,
      }
      const target = (extra: Record<string, unknown>) => ({
        isStage: false,
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        costumes: [costume],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 1,
        x: 0,
        y: 0,
        direction: 90,
        size: 100,
        visible: true,
        ...extra,
      })
      const project = {
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: { v: ['v', 0] },
            lists: {},
            broadcasts: {},
            blocks: {},
            costumes: [costume],
            sounds: [],
            currentCostume: 0,
            volume: 100,
            layerOrder: 0,
          },
          target({
            name: 'Sprite1',
            blocks: {
              h: {
                opcode: 'event_whenflagclicked',
                next: 'if',
                parent: null,
                inputs: {},
                fields: {},
                topLevel: true,
                x: 0,
                y: 0,
              },
              if: {
                opcode: 'control_if',
                next: null,
                parent: 'h',
                inputs: { CONDITION: [2, 'touch'], SUBSTACK: [2, 'setv'] },
                fields: {},
              },
              touch: {
                opcode: 'sensing_touchingobject',
                next: null,
                parent: 'if',
                inputs: { TOUCHINGOBJECTMENU: [1, [10, 'Sprite2']] },
                fields: {},
              },
              setv: {
                opcode: 'data_setvariableto',
                next: null,
                parent: 'if',
                inputs: { VALUE: [1, [4, '1']] },
                fields: { VARIABLE: ['v', 'v'] },
              },
            },
          }),
          target({ name: 'Sprite2', layerOrder: 2 }),
        ],
        monitors: [
          {
            id: 'v',
            mode: 'default',
            opcode: 'data_variable',
            params: { VARIABLE: 'v' },
            spriteName: null,
            value: 0,
            width: 0,
            height: 0,
            x: 5,
            y: 5,
            visible: true,
          },
        ],
        extensions: [],
        meta: { semver: '3.0.0' },
      }
      const bytes = zipSync({
        'project.json': strToU8(JSON.stringify(project)),
        [`${asset}.svg`]: strToU8(svg),
      })
      await page.getByTestId('project-file-input').setInputFiles({
        name: 'touch.sb3',
        mimeType: 'application/zip',
        buffer: Buffer.from(bytes),
      })
      await page.getByRole('button', { name: 'Green flag' }).click()
      // Both sprites sit at the origin with 100x100 squares, so they overlap.
      // `set` stores a tagged string, so the value is "1" rather than 1.
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest
            ?.snapshot()
            .project.targets.find((t: any) => t.name === 'Stage')?.variables?.v?.[1] === '1',
        null,
        { timeout: 120000 },
      )
    } finally {
      await context.close()
    }
  }, 300000)

  test('delivers keyboard input to the xyo-cpp runtime', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    page.on('dialog', (dialog) => void dialog.accept())
    await page.addInitScript(() => {
      localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp')
    })
    try {
      await page.goto(base)
      await page.getByTestId('stage-canvas').waitFor()
      const project = {
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: { v: ['v', 0] },
            lists: {},
            broadcasts: {},
            blocks: {
              h: {
                opcode: 'event_whenkeypressed',
                next: 'set',
                parent: null,
                inputs: {},
                fields: { KEY_OPTION: ['space', null] },
                topLevel: true,
                x: 0,
                y: 0,
              },
              set: {
                opcode: 'data_setvariableto',
                next: null,
                parent: 'h',
                inputs: { VALUE: [1, [4, '1']] },
                fields: { VARIABLE: ['v', 'v'] },
              },
            },
            costumes: [],
            sounds: [],
            currentCostume: 0,
            volume: 100,
            layerOrder: 0,
          },
        ],
        monitors: [
          {
            id: 'v',
            mode: 'default',
            opcode: 'data_variable',
            params: { VARIABLE: 'v' },
            spriteName: null,
            value: 0,
            width: 0,
            height: 0,
            x: 5,
            y: 5,
            visible: true,
          },
        ],
        extensions: [],
        meta: { semver: '3.0.0' },
      }
      const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
      await page
        .getByTestId('project-file-input')
        .setInputFiles({ name: 'key.sb3', mimeType: 'application/zip', buffer: Buffer.from(bytes) })
      await page.getByTestId('stage-canvas').click()
      await page.getByRole('button', { name: 'Green flag' }).click()
      await page.waitForTimeout(500)
      await page.keyboard.press('Space')
      // `set` stores a tagged string.
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables?.v?.[1] ===
          '1',
        null,
        { timeout: 120000 },
      )
    } finally {
      await context.close()
    }
  }, 300000)

  test('pen blocks draw onto the stage canvas', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    page.on('dialog', (dialog) => void dialog.accept())
    await page.addInitScript(() => {
      localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp')
    })
    try {
      await page.goto(base)
      await page.getByTestId('stage-canvas').waitFor()
      const project = {
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {},
            costumes: [],
            sounds: [],
            currentCostume: 0,
            volume: 100,
            layerOrder: 0,
          },
          {
            isStage: false,
            name: 'Sprite1',
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {
              h: {
                opcode: 'event_whenflagclicked',
                next: 'clear',
                parent: null,
                inputs: {},
                fields: {},
                topLevel: true,
                x: 0,
                y: 0,
              },
              clear: { opcode: 'pen_clear', next: 'down', parent: 'h', inputs: {}, fields: {} },
              down: {
                opcode: 'pen_penDown',
                next: 'loop',
                parent: 'clear',
                inputs: {},
                fields: {},
              },
              loop: {
                opcode: 'control_repeat',
                next: 'up',
                parent: 'down',
                inputs: { TIMES: [1, [6, '20']], SUBSTACK: [2, 'move'] },
                fields: {},
              },
              move: {
                opcode: 'motion_movesteps',
                next: null,
                parent: 'loop',
                inputs: { STEPS: [1, [4, '8']] },
                fields: {},
              },
              up: { opcode: 'pen_penUp', next: null, parent: 'loop', inputs: {}, fields: {} },
            },
            costumes: [],
            sounds: [],
            currentCostume: 0,
            volume: 100,
            layerOrder: 1,
            x: -150,
            y: 0,
            direction: 90,
            size: 100,
            visible: true,
          },
        ],
        monitors: [],
        extensions: ['pen'],
        meta: { semver: '3.0.0' },
      }
      const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
      await page
        .getByTestId('project-file-input')
        .setInputFiles({ name: 'pen.sb3', mimeType: 'application/zip', buffer: Buffer.from(bytes) })
      await page.getByRole('button', { name: 'Green flag' }).click()
      // Wait until the sprite has travelled, then count non-background pixels.
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector(
            '[data-testid="stage-canvas"]',
          ) as HTMLCanvasElement | null
          const sprite = (window as any).__hikkakuEditorTest
            ?.snapshot()
            .project.targets.find((t: any) => t.name === 'Sprite1')
          return !!canvas && typeof sprite?.x === 'number' && sprite.x > -80
        },
        null,
        { timeout: 120000 },
      )
      // The stage canvas is WebGL (configureWebGL runs before the 2D fallback),
      // so read the drawing buffer directly.
      const painted = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="stage-canvas"]') as HTMLCanvasElement
        const gl = canvas.getContext('webgl') as WebGLRenderingContext | null
        if (!gl) return -1
        const width = gl.drawingBufferWidth,
          height = gl.drawingBufferHeight
        const pixels = new Uint8Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let count = 0
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 0 && !(pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240))
            count++
        }
        return count
      })
      expect(painted).toBeGreaterThan(100)
    } finally {
      await context.close()
    }
  }, 300000)

  test('runs a non-admitted loop project on the xyo-cpp interpreter inside the app', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    page.on('dialog', (dialog) => void dialog.accept())
    await page.addInitScript(() => {
      localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp')
    })
    try {
      await page.goto(base)
      await page.getByTestId('stage-canvas').waitFor()
      const project = {
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: { v: ['counter', 0] },
            lists: {},
            broadcasts: {},
            blocks: {
              hat: {
                opcode: 'event_whenflagclicked',
                next: 'loop',
                parent: null,
                inputs: {},
                fields: {},
                topLevel: true,
                x: 10,
                y: 10,
              },
              loop: {
                opcode: 'control_repeat',
                next: null,
                parent: 'hat',
                inputs: { TIMES: [1, [6, '4']], SUBSTACK: [2, 'inc'] },
                fields: {},
              },
              inc: {
                opcode: 'data_changevariableby',
                next: null,
                parent: 'loop',
                inputs: { VALUE: [1, [4, '5']] },
                fields: { VARIABLE: ['counter', 'v'] },
              },
            },
            costumes: [],
            sounds: [],
            currentCostume: 0,
            volume: 100,
            layerOrder: 0,
          },
        ],
        monitors: [
          {
            id: 'v',
            mode: 'default',
            opcode: 'data_variable',
            params: { VARIABLE: 'counter' },
            spriteName: null,
            value: 0,
            width: 0,
            height: 0,
            x: 5,
            y: 5,
            visible: true,
          },
        ],
        extensions: [],
        meta: { semver: '3.0.0' },
      }
      const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
      await page.getByTestId('project-file-input').setInputFiles({
        name: 'loop.sb3',
        mimeType: 'application/zip',
        buffer: Buffer.from(bytes),
      })
      await page.getByRole('button', { name: 'Green flag' }).click()
      // 4 iterations x 5: control_repeat + nested change on the xyo-cpp interpreter.
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables?.v?.[1] ===
          20,
        null,
        { timeout: 120000 },
      )
      expect(requests.some((url) => /llvm-artifacts\/unified_runtime_esm\.wasm/i.test(url))).toBe(
        true,
      )
    } finally {
      await context.close()
    }
  }, 300000)
})
