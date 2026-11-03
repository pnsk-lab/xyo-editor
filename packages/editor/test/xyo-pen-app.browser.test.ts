import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { type Browser } from 'playwright-core'
import { hasXyoPen, optIn } from './artifacts'
import { launchBrowser } from './browser-launcher'
import { strToU8, zipSync } from 'fflate'

const enabled = optIn('XYO_PEN_ISOLATED_BROWSER', hasXyoPen)
const root = import.meta.dir.replace(/\/test$/, '')
let server: ChildProcess | undefined,
  browser: Browser | undefined,
  base = ''
const blocks = {
  hat: {
    opcode: 'event_whenflagclicked',
    next: 'size',
    parent: null,
    inputs: {},
    fields: {},
    topLevel: true,
  },
  size: {
    opcode: 'pen_setPenSizeTo',
    next: 'down',
    parent: 'hat',
    inputs: { SIZE: [1, [4, '8']] },
    fields: {},
  },
  down: { opcode: 'pen_penDown', next: 'move', parent: 'size', inputs: {}, fields: {} },
  move: {
    opcode: 'motion_movesteps',
    next: 'up',
    parent: 'down',
    inputs: { STEPS: [1, [4, '100']] },
    fields: {},
  },
  up: { opcode: 'pen_penUp', next: null, parent: 'move', inputs: {}, fields: {} },
  key: {
    opcode: 'event_whenkeypressed',
    next: 'clear',
    parent: null,
    topLevel: true,
    inputs: {},
    fields: { KEY_OPTION: ['space', null] },
  },
  clear: { opcode: 'pen_clear', next: null, parent: 'key', inputs: {}, fields: {} },
}
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
      name: 'Pen',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks,
      costumes: [],
      sounds: [],
      currentCostume: 0,
      volume: 100,
      layerOrder: 1,
      x: -100,
      y: 0,
      direction: 90,
      size: 100,
      visible: false,
      draggable: false,
      rotationStyle: 'all around',
    },
  ],
  monitors: [],
  extensions: ['pen'],
  meta: { semver: '3.0.0' },
}

;(enabled ? describe : describe.skip)('isolated pen editor and WASM worker', () => {
  beforeAll(async () => {
    const socket = createServer()
    await new Promise<void>((resolve, reject) =>
      socket.once('error', reject).listen(0, '127.0.0.1', resolve),
    )
    const address = socket.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    const port = address.port
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    )
    base = `http://127.0.0.1:${port}`
    server = spawn(
      process.execPath,
      ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: root, stdio: 'ignore' },
    )
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('Vite exited')
      try {
        if ((await fetch(`${base}/test/xyo-pen-app-fixture.html`)).ok) break
      } catch {
        /* start */
      }
      if (i === 99) throw new Error('Vite unavailable')
      await Bun.sleep(100)
    }
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 30000)
  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })
  test('shows a line, preserves it across stop, and clears it from a key hat', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.addInitScript(() => {
        localStorage.setItem('hikkaku.runtime-backend', 'pen-isolated')
        const OriginalWorker = window.Worker
        ;(window as any).__penFallbacks = []
        window.Worker = class extends OriginalWorker {
          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args)
            this.addEventListener('message', (event) => {
              const count = event.data?.value?.compileStats?.fallbacks
              if (typeof count === 'number') (window as any).__penFallbacks.push(count)
            })
          }
        }
      })
      await page.goto(`${base}/test/xyo-pen-app-fixture.html`)
      const canvas = page.getByTestId('stage-canvas')
      await canvas.waitFor()
      const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
      await page
        .getByTestId('project-file-input')
        .setInputFiles({ name: 'pen.sb3', mimeType: 'application/zip', buffer: Buffer.from(bytes) })
      await page.waitForFunction(() =>
        (window as any).__hikkakuEditorTest
          ?.snapshot()
          .project.targets.some((t: any) => t.name === 'Pen'),
      )
      await page.waitForTimeout(300)
      const capture = async () => (await canvas.screenshot()).toString('base64')
      const before = await capture()
      await page.getByRole('button', { name: 'Green flag' }).click()
      try {
        await page.waitForFunction(
          () =>
            (window as any).__hikkakuEditorTest
              ?.snapshot()
              .project.targets.some((t: any) => t.name === 'Pen' && Math.abs(t.x) < 0.01),
          null,
          { timeout: 15000 },
        )
      } catch (error) {
        console.error('pen E2E diagnostics', {
          errors,
          body: (await page.locator('body').innerText()).slice(-3000),
          snapshot: await page.evaluate(() => (window as any).__hikkakuEditorTest?.snapshot()),
        })
        throw error
      }
      await page.waitForTimeout(300)
      const drawn = await capture()
      const changedAlongStroke = await page.evaluate(
        async ([original, current]) => {
          const decode = async (base64: string) => {
            const image = new Image()
            image.src = `data:image/png;base64,${base64}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const context = canvas.getContext('2d')!
            context.drawImage(image, 0, 0)
            return {
              data: context.getImageData(0, 0, canvas.width, canvas.height).data,
              width: canvas.width,
              height: canvas.height,
            }
          }
          const a = await decode(original),
            b = await decode(current)
          let count = 0
          for (let y = Math.floor(a.height * 0.47); y < a.height * 0.53; ++y)
            for (let x = Math.floor(a.width * 0.3); x < a.width * 0.5; ++x) {
              const i = (y * a.width + x) * 4
              if (
                a.data[i] !== b.data[i] ||
                a.data[i + 1] !== b.data[i + 1] ||
                a.data[i + 2] !== b.data[i + 2]
              )
                count++
            }
          return count
        },
        [before, drawn],
      )
      expect(changedAlongStroke).toBeGreaterThan(30)
      expect(
        await page.evaluate(() => (window as any).__penFallbacks.some((n: number) => n > 0)),
      ).toBe(true)
      await page.getByRole('button', { name: 'Stop all' }).click()
      await page.waitForTimeout(200)
      expect(await capture()).toBe(drawn)
      // Start a fresh worker, then key-hat clear exercises the new epoch.
      await page.getByRole('button', { name: 'Green flag' }).click()
      await page.waitForTimeout(1000)
      await page.keyboard.press('Space')
      await page.waitForTimeout(500)
      expect(await capture()).toBe(before)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 30000)
  test('loading a replacement project clears old ink after stop', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await page.addInitScript(() =>
        localStorage.setItem('hikkaku.runtime-backend', 'pen-isolated'),
      )
      await page.goto(`${base}/test/xyo-pen-app-fixture.html`)
      const canvas = page.getByTestId('stage-canvas')
      await canvas.waitFor()
      const upload = async (value: typeof project) => {
        const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(value)) })
        await page.getByTestId('project-file-input').setInputFiles({
          name: 'project.sb3',
          mimeType: 'application/zip',
          buffer: Buffer.from(bytes),
        })
      }
      await upload(project)
      await page.waitForFunction(() =>
        (window as any).__hikkakuEditorTest
          ?.snapshot()
          .project.targets.some((t: any) => t.name === 'Pen'),
      )
      await page.waitForTimeout(300)
      const before = (await canvas.screenshot()).toString('base64')
      await page.getByRole('button', { name: 'Green flag' }).click()
      await page.waitForFunction(
        () =>
          (window as any).__hikkakuEditorTest
            ?.snapshot()
            .project.targets.some((t: any) => t.name === 'Pen' && Math.abs(t.x) < 0.01),
        null,
        { timeout: 15000 },
      )
      await page.waitForTimeout(300)
      expect((await canvas.screenshot()).toString('base64')).not.toBe(before)
      await page.getByRole('button', { name: 'Stop all' }).click()
      const replacement = structuredClone(project)
      replacement.targets[1].name = 'Replacement'
      await upload(replacement)
      await page.waitForFunction(() =>
        (window as any).__hikkakuEditorTest
          ?.snapshot()
          .project.targets.some((t: any) => t.name === 'Replacement'),
      )
      await page.waitForTimeout(300)
      expect((await canvas.screenshot()).toString('base64')).toBe(before)
    } finally {
      await page.close()
    }
  }, 30000)
  test('real worker preserves clone strokes and fails a 4097-event overflow', async () => {
    const page = await browser!.newPage()
    try {
      await page.goto(`${base}/test/xyo-pen-app-fixture.html`)
      const clone = structuredClone(project)
      const sprite = clone.targets[1] as any
      sprite.x = 0
      sprite.blocks = {
        hat: {
          opcode: 'event_whenflagclicked',
          topLevel: true,
          next: 'down',
          inputs: {},
          fields: {},
        },
        down: { opcode: 'pen_penDown', next: 'clone', inputs: {}, fields: {} },
        clone: {
          opcode: 'control_create_clone_of',
          next: 'up',
          inputs: { CLONE_OPTION: [1, [10, '_myself_']] },
          fields: {},
        },
        up: { opcode: 'pen_penUp', next: null, inputs: {}, fields: {} },
        clonehat: {
          opcode: 'control_start_as_clone',
          topLevel: true,
          next: 'move',
          inputs: {},
          fields: {},
        },
        move: {
          opcode: 'motion_movesteps',
          next: 'delete',
          inputs: { STEPS: [1, [4, '20']] },
          fields: {},
        },
        delete: { opcode: 'control_delete_this_clone', next: null, inputs: {}, fields: {} },
      }
      const run = async (data: unknown, steps: number) => {
        const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(data)) })
        return page.evaluate(
          async ({ bytes, steps }) => {
            // @ts-ignore -- served as an isolated Vite fixture.
            const fixture = await import('/test/xyo-pen-worker-fixture.ts')
            return fixture.runPenWorker(bytes, steps)
          },
          { bytes: Array.from(bytes), steps },
        )
      }
      const result = await run(clone, 3)
      expect(result.error).toBeNull()
      const frames = result.frames as any[]
      expect(
        frames
          .flatMap((frame) => frame.penEvents)
          .some((event: any) => event.type === 'line' && Math.abs(event.x1 - 20) < 1e-8),
      ).toBe(true)
      expect(frames.at(-1).targets.every((target: any) => target.isOriginal)).toBe(true)
      const overflow = structuredClone(project)
      const os = overflow.targets[1] as any
      os.blocks = {
        hat: {
          opcode: 'event_whenflagclicked',
          topLevel: true,
          next: 'p0',
          inputs: {},
          fields: {},
        },
      }
      for (let i = 0; i < 4097; i++)
        os.blocks[`p${i}`] = {
          opcode: 'pen_penDown',
          next: i === 4096 ? null : `p${i + 1}`,
          inputs: {},
          fields: {},
        }
      const failed = await run(overflow, 1)
      expect(failed.error).toContain('overflow')
      expect(failed.frames).toEqual([])
    } finally {
      await page.close()
    }
  }, 30000)
  test('pen, Web Audio playback and ask coexist in the real editor', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await page.addInitScript(() => {
        localStorage.setItem('hikkaku.runtime-backend', 'pen-isolated')
        ;(window as any).__audioStarts = 0
        const start = AudioBufferSourceNode.prototype.start
        AudioBufferSourceNode.prototype.start = function (...args) {
          ;(window as any).__audioStarts++
          return start.apply(this, args)
        }
      })
      await page.goto(`${base}/test/xyo-pen-app-fixture.html`)
      const canvas = page.getByTestId('stage-canvas')
      await canvas.waitFor()
      const combined = structuredClone(project)
      const sprite = combined.targets[1] as any
      sprite.blocks.up.next = 'play'
      sprite.blocks.play = {
        opcode: 'sound_play',
        next: 'ask',
        parent: 'up',
        inputs: { SOUND_MENU: [1, [10, 'tone']] },
        fields: {},
      }
      sprite.blocks.ask = {
        opcode: 'sensing_askandwait',
        next: null,
        parent: 'play',
        inputs: { QUESTION: [1, [10, 'Pen question?']] },
        fields: {},
      }
      const samples = 8000,
        wav = Buffer.alloc(44 + samples * 2)
      wav.write('RIFF', 0)
      wav.writeUInt32LE(wav.length - 8, 4)
      wav.write('WAVEfmt ', 8)
      wav.writeUInt32LE(16, 16)
      wav.writeUInt16LE(1, 20)
      wav.writeUInt16LE(1, 22)
      wav.writeUInt32LE(8000, 24)
      wav.writeUInt32LE(16000, 28)
      wav.writeUInt16LE(2, 32)
      wav.writeUInt16LE(16, 34)
      wav.write('data', 36)
      wav.writeUInt32LE(samples * 2, 40)
      sprite.sounds = [
        {
          name: 'tone',
          assetId: 'tone',
          md5ext: 'tone.wav',
          dataFormat: 'wav',
          rate: 8000,
          sampleCount: samples,
        },
      ]
      const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(combined)), 'tone.wav': wav })
      await page.getByTestId('project-file-input').setInputFiles({
        name: 'combined.sb3',
        mimeType: 'application/zip',
        buffer: Buffer.from(bytes),
      })
      await page.waitForFunction(() =>
        (window as any).__hikkakuEditorTest
          ?.snapshot()
          .project.targets.some((t: any) => t.name === 'Pen'),
      )
      await page.waitForTimeout(300)
      const before = (await canvas.screenshot()).toString('base64')
      await page.getByRole('button', { name: 'Green flag' }).click()
      await page.getByText('Pen question?', { exact: true }).waitFor({ timeout: 15000 })
      await page.waitForFunction(() => (window as any).__audioStarts > 0, null, { timeout: 15000 })
      expect((await canvas.screenshot()).toString('base64')).not.toBe(before)
      await page.getByTestId('stage-answer-input').fill('answer')
      await page.getByTestId('stage-answer-input').press('Enter')
      await page.getByTestId('stage-answer-input').waitFor({ state: 'detached', timeout: 15000 })
      expect(await page.evaluate(() => (window as any).__audioStarts)).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  }, 30000)
  test('a mid-batch real canvas exception leaves the old layer and pending strokes intact', async () => {
    const page = await browser!.newPage()
    try {
      await page.goto(`${base}/test/xyo-pen-app-fixture.html`)
      const result = await page.evaluate(async () => {
        // @ts-ignore -- served as an isolated Vite fixture.
        const fixture = await import('/test/xyo-pen-atomic-fixture.ts')
        return fixture.exerciseAtomicPenFailure()
      })
      expect(result).toEqual({
        message: 'injected stroke failure',
        strokes: 2,
        preserved: true,
        committed: true,
        dimensions: [480, 360],
        stageDimensions: [240, 180],
        discardSucceeded: true,
      })
    } finally {
      await page.close()
    }
  }, 30000)
  test('unsupported stamp fails the whole batch without painting a partial line', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await page.addInitScript(() =>
        localStorage.setItem('hikkaku.runtime-backend', 'pen-isolated'),
      )
      await page.goto(`${base}/test/xyo-pen-app-fixture.html`)
      const canvas = page.getByTestId('stage-canvas')
      await canvas.waitFor()
      const bad = structuredClone(project)
      ;(bad.targets[1].blocks as any).up.next = 'stamp'
      ;(bad.targets[1].blocks as any).stamp = {
        opcode: 'pen_stamp',
        next: null,
        parent: 'up',
        inputs: {},
        fields: {},
      }
      const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(bad)) })
      await page.getByTestId('project-file-input').setInputFiles({
        name: 'stamp.sb3',
        mimeType: 'application/zip',
        buffer: Buffer.from(bytes),
      })
      await page.waitForFunction(() =>
        (window as any).__hikkakuEditorTest
          ?.snapshot()
          .project.targets.some((t: any) => t.name === 'Pen'),
      )
      await page.waitForTimeout(300)
      const before = (await canvas.screenshot()).toString('base64')
      await page.getByRole('button', { name: 'Green flag' }).click()
      await page.getByText('Pen stamp is unsupported', { exact: false }).waitFor({ timeout: 15000 })
      await page.waitForTimeout(300)
      expect((await canvas.screenshot()).toString('base64')).toBe(before)
    } finally {
      await page.close()
    }
  }, 30000)
})
