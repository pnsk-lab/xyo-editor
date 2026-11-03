import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { type Browser } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Historical tests for the retired editor-to-xyo-cpp Wasm worker integration.
// The editor now reserves xyo-cpp for the unfinished LLVM backend and falls back
// to the built-in VM; neither the worker nor the missing-WASM path is reachable.
// Kept as legacy reference only, even when XYO_EDITOR_BROWSER=1. See
// xyo-editor-fallback.browser.test.ts for the current editor behavior.
const missing = process.env.XYO_EDITOR_MISSING === '1'
const root = join(import.meta.dir, '..')
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''
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
          next: 'a',
          parent: null,
          inputs: {},
          fields: {},
          topLevel: true,
          x: 10,
          y: 10,
        },
        a: {
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
    {
      isStage: false,
      name: 'Box',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {
        hat2: {
          opcode: 'event_whenflagclicked',
          next: 'move',
          parent: null,
          inputs: {},
          fields: {},
          topLevel: true,
          x: 10,
          y: 10,
        },
        move: {
          opcode: 'motion_changexby',
          next: null,
          parent: 'hat2',
          inputs: { DX: [1, [4, '100']] },
          fields: {},
        },
      },
      costumes: [
        {
          name: 'box',
          assetId: 'box',
          md5ext: 'box.svg',
          dataFormat: 'svg',
          rotationCenterX: 25,
          rotationCenterY: 25,
        },
      ],
      sounds: [],
      currentCostume: 0,
      volume: 100,
      layerOrder: 1,
      x: 0,
      y: 0,
      direction: 90,
      size: 100,
      visible: true,
      draggable: false,
      rotationStyle: 'all around',
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

describe.skip('legacy retired xyo-cpp editor worker integration', () => {
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
      { cwd: root, stdio: 'ignore' },
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
  ;(missing ? test.skip : test)(
    'settings selection survives reload and flag executes through compiled worker',
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
      try {
        await page.addInitScript(() => {
          const Original = window.Worker
          ;(window as any).__xyoOps = []
          ;(window as any).__xyoTerminations = 0
          window.Worker = class extends Original {
            terminate() {
              ;(window as any).__xyoTerminations++
              return super.terminate()
            }
            postMessage(message: any, ...rest: any[]) {
              if (message?.operation) (window as any).__xyoOps.push(message.operation)
              return super.postMessage(message, ...(rest as []))
            }
          }
        })
        page.on('dialog', (dialog) => void dialog.accept())
        await page.goto(base)
        await page.getByTestId('stage-canvas').waitFor()
        await page.getByRole('button', { name: '設定', exact: true }).click()
        await page.getByLabel('ランタイムの選択').selectOption('xyo-cpp')
        expect(await page.evaluate(() => localStorage.getItem('hikkaku.runtime-backend'))).toBe(
          'xyo-cpp',
        )
        await page.reload()
        await page.getByTestId('stage-canvas').waitFor()
        const bytes = zipSync({
          'project.json': strToU8(JSON.stringify(project)),
          'box.svg': strToU8(
            '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="#ff0000"/></svg>',
          ),
        })
        await page.getByTestId('project-file-input').setInputFiles({
          name: 'xyo-test.sb3',
          mimeType: 'application/zip',
          buffer: Buffer.from(bytes),
        })
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables
              ?.v?.[1] === 7,
        )
        const monitor = page.getByRole('button', { name: 'counter monitor' })
        await monitor.getByText('7', { exact: true }).waitFor()
        // The stage uses WebGL, so inspect pixels from a real canvas screenshot.
        const redCenter = async () => {
          const png = await page.getByTestId('stage-canvas').screenshot()
          return page.evaluate(async (base64) => {
            const image = new Image()
            image.src = `data:image/png;base64,${base64}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(image, 0, 0)
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
            let count = 0,
              sum = 0
            for (let i = 0; i < data.length; i += 4) {
              if (data[i] > 240 && data[i + 1] < 20 && data[i + 2] < 20 && data[i + 3] > 200) {
                count++
                sum += (i / 4) % canvas.width
              }
            }
            return count > 100 ? sum / count : 0
          }, png.toString('base64'))
        }
        let before = await redCenter()
        for (let i = 0; i < 100 && !before; i++) {
          await page.waitForTimeout(50)
          before = await redCenter()
        }
        expect(before).toBeGreaterThan(0)
        await page.getByRole('button', { name: 'Green flag' }).click()
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables
              ?.v?.[1] === 10,
          null,
          { timeout: 15000 },
        )
        await monitor.getByText('10', { exact: true }).waitFor({ timeout: 15000 })
        let after = await redCenter()
        for (let i = 0; i < 100 && after < before + 30; i++) {
          await page.waitForTimeout(50)
          after = await redCenter()
        }
        expect(after).toBeGreaterThan(before + 30)
        const operations = await page.evaluate(() => (window as any).__xyoOps)
        expect(operations.some((op: any) => op.type === 'flag' && op.compiled === true)).toBe(true)
        expect(operations.some((op: any) => op.type === 'step')).toBe(true)
        expect(operations.some((op: any) => op.type === 'stats')).toBe(true)
        expect(await page.getByTestId('stage-canvas').isVisible()).toBe(true)
        await page.getByRole('button', { name: 'Stop all' }).click()
        await page.waitForFunction(() => (window as any).__xyoTerminations > 0)
        await page.getByRole('button', { name: 'Green flag' }).click()
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables
              ?.v?.[1] === 13,
          null,
          { timeout: 15000 },
        )
        await monitor.getByText('13', { exact: true }).waitFor({ timeout: 15000 })
        const flags = await page.evaluate(
          () =>
            (window as any).__xyoOps.filter((op: any) => op.type === 'flag' && op.compiled).length,
        )
        expect(flags).toBe(2)
      } finally {
        await page.close()
      }
    },
    30000,
  )
  ;(missing ? test.skip : test)(
    'stop interrupts a stalled worker request and the next flag runs in a new worker',
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
      try {
        await page.addInitScript(() => {
          localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp')
          const Original = window.Worker
          ;(window as any).__flagCount = 0
          ;(window as any).__terminations = 0
          window.Worker = class extends Original {
            terminate() {
              ;(window as any).__terminations++
              return super.terminate()
            }
            postMessage(message: any, ...rest: any[]) {
              if (message?.operation?.type === 'flag' && ++(window as any).__flagCount === 1) return
              return super.postMessage(message, ...(rest as []))
            }
          }
        })
        await page.goto(base)
        await page.getByTestId('stage-canvas').waitFor()
        const bytes = zipSync({
          'project.json': strToU8(JSON.stringify(project)),
          'box.svg': strToU8(
            '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>',
          ),
        })
        await page.getByTestId('project-file-input').setInputFiles({
          name: 'xyo-test.sb3',
          mimeType: 'application/zip',
          buffer: Buffer.from(bytes),
        })
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables
              ?.v?.[1] === 7,
        )
        await page.getByRole('button', { name: 'Green flag' }).click()
        await page.waitForFunction(() => (window as any).__flagCount === 1)
        await page.getByRole('button', { name: 'Stop all' }).click()
        expect(await page.evaluate(() => (window as any).__terminations)).toBeGreaterThan(0)
        await page.getByRole('button', { name: 'Green flag' }).click()
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables
              ?.v?.[1] === 10,
          null,
          { timeout: 15000 },
        )
        expect(await page.evaluate(() => (window as any).__flagCount)).toBe(2)
      } finally {
        await page.close()
      }
    },
    30000,
  )
  for (const type of ['say', 'think'] as const) {
    ;(missing ? test.skip : test)(
      `real WASM ${type} bubble reaches the snapshot and stage canvas`,
      async () => {
        const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
        try {
          await page.addInitScript(() => localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp'))
          await page.goto(base)
          const canvas = page.getByTestId('stage-canvas')
          await canvas.waitFor()
          const fixture = structuredClone(project)
          fixture.targets[0].blocks = {} as (typeof fixture.targets)[0]['blocks']
          fixture.targets[1].blocks = {
            hat2: {
              opcode: 'event_whenflagclicked',
              next: 'bubble',
              parent: null,
              inputs: {},
              fields: {},
              topLevel: true,
              x: 10,
              y: 10,
            },
            bubble: {
              opcode: `looks_${type}`,
              next: null,
              parent: 'hat2',
              inputs: { MESSAGE: [1, [10, 'Hello bubble']] },
              fields: {},
            },
          } as (typeof fixture.targets)[1]['blocks']
          const bytes = zipSync({
            'project.json': strToU8(JSON.stringify(fixture)),
            'box.svg': strToU8(
              '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="#ff0000"/></svg>',
            ),
          })
          await page.getByTestId('project-file-input').setInputFiles({
            name: 'bubble.sb3',
            mimeType: 'application/zip',
            buffer: Buffer.from(bytes),
          })
          await page.waitForFunction(() =>
            (window as any).__hikkakuEditorTest
              ?.snapshot()
              .project.targets.some((t: any) => t.name === 'Box'),
          )
          await page.waitForTimeout(500) // Let the SVG costume decode and the stage settle.
          const before = (await canvas.screenshot()).toString('base64')
          await page.getByRole('button', { name: 'Green flag' }).click()
          await page.waitForFunction(
            ({ type }) => {
              const bubble = (window as any).__hikkakuEditorTest
                ?.snapshot()
                .project.targets.find((t: any) => t.name === 'Box')?.speechBubble
              return bubble?.type === type && bubble.text === 'Hello bubble'
            },
            { type },
            { timeout: 15000 },
          )
          expect(
            await page.evaluate(
              () =>
                (window as any).__hikkakuEditorTest
                  .snapshot()
                  .project.targets.find((t: any) => t.name === 'Box').speechBubble,
            ),
          ).toEqual({ type, text: 'Hello bubble' })
          let changedPixels = 0
          for (let i = 0; i < 40 && changedPixels < 100; i++) {
            const after = (await canvas.screenshot()).toString('base64')
            changedPixels = await page.evaluate(
              async ([before, after]) => {
                const images = await Promise.all(
                  [before, after].map(async (data) => {
                    const image = new Image()
                    image.src = `data:image/png;base64,${data}`
                    await image.decode()
                    return image
                  }),
                )
                const read = (image: HTMLImageElement) => {
                  const c = document.createElement('canvas')
                  c.width = image.width
                  c.height = image.height
                  const ctx = c.getContext('2d')!
                  ctx.drawImage(image, 0, 0)
                  return ctx.getImageData(0, 0, c.width, c.height).data
                }
                const a = read(images[0]),
                  b = read(images[1])
                let count = 0
                for (let i = 0; i < a.length; i += 4)
                  if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++
                return count
              },
              [before, after],
            )
            if (changedPixels < 100) await page.waitForTimeout(50)
          }
          expect(changedPixels).toBeGreaterThan(100)
        } finally {
          await page.close()
        }
      },
      30000,
    )
  }
  ;(missing ? test.skip : test)(
    'sprite property monitors display updated xyo-cpp snapshot values',
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
      try {
        await page.addInitScript(() => localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp'))
        await page.goto(base)
        await page.getByTestId('stage-canvas').waitFor()
        const fixture = structuredClone(project)
        fixture.targets[0].blocks = {} as (typeof fixture.targets)[0]['blocks']
        fixture.targets[1].blocks = {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'x',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 10,
            y: 10,
          },
          x: {
            opcode: 'motion_setx',
            next: 'y',
            parent: 'hat',
            inputs: { X: [1, [4, '42']] },
            fields: {},
          },
          y: {
            opcode: 'motion_sety',
            next: 'direction',
            parent: 'x',
            inputs: { Y: [1, [4, '-35']] },
            fields: {},
          },
          direction: {
            opcode: 'motion_pointindirection',
            next: 'size',
            parent: 'y',
            inputs: { DIRECTION: [1, [4, '135']] },
            fields: {},
          },
          size: {
            opcode: 'looks_setsizeto',
            next: null,
            parent: 'direction',
            inputs: { SIZE: [1, [4, '75']] },
            fields: {},
          },
        } as (typeof fixture.targets)[1]['blocks']
        const monitors = [
          { id: 'mx', opcode: 'motion_xposition', label: 'x position', initial: 0, expected: 42 },
          { id: 'my', opcode: 'motion_yposition', label: 'y position', initial: 0, expected: -35 },
          { id: 'md', opcode: 'motion_direction', label: 'direction', initial: 90, expected: 135 },
          { id: 'ms', opcode: 'looks_size', label: 'size', initial: 100, expected: 75 },
        ]
        fixture.monitors = monitors.map((monitor, index) => ({
          id: monitor.id,
          mode: 'default',
          opcode: monitor.opcode,
          params: {} as { VARIABLE: string },
          spriteName: 'Box',
          value: monitor.initial,
          width: 0,
          height: 0,
          x: 5,
          y: 5 + index * 35,
          visible: true,
        }))
        const bytes = zipSync({
          'project.json': strToU8(JSON.stringify(fixture)),
          'box.svg': strToU8(
            '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>',
          ),
        })
        await page.getByTestId('project-file-input').setInputFiles({
          name: 'property-monitors.sb3',
          mimeType: 'application/zip',
          buffer: Buffer.from(bytes),
        })
        for (const monitor of monitors) {
          await page
            .getByRole('button', { name: `${monitor.label} monitor` })
            .getByText(String(monitor.initial), { exact: true })
            .waitFor()
        }
        await page.getByRole('button', { name: 'Green flag' }).click()
        await page.waitForFunction(
          (expected) => {
            const snapshot = (window as any).__hikkakuEditorTest?.snapshot()
            return expected.every(
              ({ id, value }) =>
                snapshot?.project.monitors.find((m: any) => m.id === id)?.value === value,
            )
          },
          monitors.map((monitor) => ({ id: monitor.id, value: monitor.expected })),
          { timeout: 15000 },
        )
        for (const monitor of monitors) {
          await page
            .getByRole('button', { name: `${monitor.label} monitor` })
            .getByText(String(monitor.expected), { exact: true })
            .waitFor({ timeout: 15000 })
        }
      } finally {
        await page.close()
      }
    },
    30000,
  )
  ;(missing ? test.skip : test)(
    'sprite can be dragged before the first flag',
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        await page.addInitScript(() => localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp'))
        await page.goto(base)
        const canvas = page.getByTestId('stage-canvas')
        await canvas.waitFor()
        const bytes = zipSync({
          'project.json': strToU8(JSON.stringify(project)),
          'box.svg': strToU8(
            '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>',
          ),
        })
        await page.getByTestId('project-file-input').setInputFiles({
          name: 'xyo-test.sb3',
          mimeType: 'application/zip',
          buffer: Buffer.from(bytes),
        })
        await page.waitForFunction(() =>
          (window as any).__hikkakuEditorTest
            ?.snapshot()
            .project.targets.some((t: any) => t.name === 'Box'),
        )
        await page.waitForTimeout(500) // Allow the renderer to decode the costume for hit testing.
        const rect = await canvas.boundingBox()
        if (!rect) throw new Error('Stage has no bounding box')
        const x = rect.x + rect.width / 2,
          y = rect.y + rect.height / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 65, y, { steps: 5 })
        await page.mouse.up()
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest
              ?.snapshot()
              .project.targets.find((t: any) => t.name === 'Box')?.x > 30,
        )
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    },
    30000,
  )
  ;(missing ? test.skip : test)(
    'worker failure preserves the last published runtime state',
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
      try {
        await page.addInitScript(() => {
          localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp')
          const Original = window.Worker
          window.Worker = class extends Original {
            constructor(...args: ConstructorParameters<typeof Worker>) {
              super(...args)
              ;(window as any).__xyoWorker = this
            }
            postMessage(message: any, ...rest: any[]) {
              if (message?.operation?.type === 'key') {
                ;(window as any).__keyBlocked = true
                return
              }
              return super.postMessage(message, ...(rest as []))
            }
          }
        })
        await page.goto(base)
        await page.getByTestId('stage-canvas').waitFor()
        const bytes = zipSync({
          'project.json': strToU8(JSON.stringify(project)),
          'box.svg': strToU8(
            '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>',
          ),
        })
        await page.getByTestId('project-file-input').setInputFiles({
          name: 'xyo-test.sb3',
          mimeType: 'application/zip',
          buffer: Buffer.from(bytes),
        })
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables
              ?.v?.[1] === 7,
        )
        await page.getByRole('button', { name: 'Green flag' }).click()
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest?.snapshot().project.targets[0]?.variables
              ?.v?.[1] === 10,
          null,
          { timeout: 15000 },
        )
        await page.keyboard.down('a')
        await page.waitForFunction(() => (window as any).__keyBlocked)
        await page.evaluate(() =>
          (window as any).__xyoWorker.dispatchEvent(
            new ErrorEvent('error', { message: 'synthetic worker failure' }),
          ),
        )
        await page.waitForFunction(() =>
          (window as any).__hikkakuEditorTest?.status().includes('synthetic worker failure'),
        )
        expect(
          await page.evaluate(
            () => (window as any).__hikkakuEditorTest.snapshot().project.targets[0].variables.v[1],
          ),
        ).toBe(10)
        await page
          .getByRole('button', { name: 'counter monitor' })
          .getByText('10', { exact: true })
          .waitFor()
      } finally {
        await page.close()
      }
    },
    30000,
  )
  ;(missing ? test : test.skip)(
    'missing WASM is visible after selecting, reloading and pressing flag',
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
      try {
        page.on('dialog', (dialog) => void dialog.accept())
        await page.goto(base)
        await page.getByTestId('stage-canvas').waitFor()
        await page.getByRole('button', { name: '設定', exact: true }).click()
        const select = page.getByLabel('ランタイムの選択')
        await select.selectOption('xyo-cpp')
        await page.reload()
        await page.getByTestId('stage-canvas').waitFor()
        await page.getByRole('button', { name: '設定', exact: true }).click()
        expect(await page.getByLabel('ランタイムの選択').inputValue()).toBe('xyo-cpp')
        await page.getByRole('button', { name: '設定を閉じる' }).click()
        await page.getByRole('dialog', { name: '設定' }).waitFor({ state: 'detached' })
        await page.getByRole('button', { name: 'Green flag' }).click()
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest?.status().includes('WASM artifacts are missing'),
          null,
          { timeout: 15000 },
        )
        expect(await page.getByText(/WASM artifacts are missing/).isVisible()).toBe(true)
      } finally {
        await page.close()
      }
    },
    30000,
  )
})
