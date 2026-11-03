import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { type Browser, type Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Legacy reference: these tests select the retired xyo-cpp Wasm editor backend.
// The current editor instead falls back to the built-in VM, so executing these
// tests would incorrectly attribute built-in audio behavior to xyo-cpp. Keep
// them skipped even with XYO_AUDIO_APP_BROWSER=1 until a real backend returns.
// They observe Web Audio nodes, not physical-device audibility.
const suite = describe.skip
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''
const errors = new WeakMap<Page, string[]>()

// WAVE_FORMAT_DVI_ADPCM, mono: 16 independent 256-byte IMA blocks.
// Each block starts at predictor 0, index 10, then low nibble 1 / high nibble 9.
// The standard IMA step table gives initial signed samples [0, 6, 0].
function imaWav() {
  const rate = 8000,
    blockSize = 256,
    samplesPerBlock = 505,
    blocks = 16
  const samples = samplesPerBlock * blocks
  const wav = Buffer.alloc(60 + blockSize * blocks)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(20, 16)
  wav.writeUInt16LE(0x11, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(Math.floor((rate * blockSize) / samplesPerBlock), 28)
  wav.writeUInt16LE(blockSize, 32)
  wav.writeUInt16LE(4, 34)
  wav.writeUInt16LE(2, 36)
  wav.writeUInt16LE(samplesPerBlock, 38)
  wav.write('fact', 40)
  wav.writeUInt32LE(4, 44)
  wav.writeUInt32LE(samples, 48)
  wav.write('data', 52)
  wav.writeUInt32LE(blockSize * blocks, 56)
  for (let i = 0; i < blocks; i++) {
    const offset = 60 + i * blockSize
    wav.writeInt16LE(0, offset)
    wav[offset + 2] = 10
    wav[offset + 3] = 0
    wav.fill(0x91, offset + 4, offset + blockSize)
  }
  return { wav, rate, samples }
}

function project(stopScript = false, volumeScript = false, effectScript = false, adpcm = false) {
  const rate = 8000,
    samples = adpcm ? 16 * 504 + 1 : rate * (volumeScript || effectScript ? 3 : 1)
  let wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 500), 44 + i * 2)
  if (adpcm) wav = imaWav().wav
  const blocks: Record<string, unknown> = {
    hat: {
      opcode: 'event_whenflagclicked',
      next: 'play',
      parent: null,
      inputs: {},
      fields: {},
      topLevel: true,
      x: 0,
      y: 0,
    },
    play: {
      opcode: 'sound_playuntildone',
      next: 'change',
      parent: 'hat',
      inputs: { SOUND_MENU: [1, [10, 'tone']] },
      fields: {},
    },
    change: {
      opcode: 'data_changevariableby',
      next: null,
      parent: 'play',
      inputs: { VALUE: [1, [4, '1']] },
      fields: { VARIABLE: ['result', 'v'] },
    },
  }
  if (stopScript)
    Object.assign(blocks, {
      hat2: {
        opcode: 'event_whenflagclicked',
        next: 'wait',
        parent: null,
        inputs: {},
        fields: {},
        topLevel: true,
        x: 200,
        y: 0,
      },
      wait: {
        opcode: 'control_wait',
        next: 'stop',
        parent: 'hat2',
        inputs: { DURATION: [1, [4, '0.3']] },
        fields: {},
      },
      stop: {
        opcode: 'control_stop',
        next: null,
        parent: 'wait',
        inputs: {},
        fields: { STOP_OPTION: ['all', null] },
        mutation: { tagName: 'mutation', children: [], hasnext: 'false' },
      },
    })
  if (volumeScript)
    Object.assign(blocks, {
      volumeHat: {
        opcode: 'event_whenflagclicked',
        next: 'volumeWait',
        parent: null,
        inputs: {},
        fields: {},
        topLevel: true,
        x: 400,
        y: 0,
      },
      volumeWait: {
        opcode: 'control_wait',
        next: 'setVolume',
        parent: 'volumeHat',
        inputs: { DURATION: [1, [4, '0.5']] },
        fields: {},
      },
      setVolume: {
        opcode: 'sound_setvolumeto',
        next: null,
        parent: 'volumeWait',
        inputs: { VOLUME: [1, [4, '25']] },
        fields: {},
      },
    })
  if (effectScript)
    Object.assign(blocks, {
      effectHat: {
        opcode: 'event_whenflagclicked',
        next: 'effectWait',
        parent: null,
        inputs: {},
        fields: {},
        topLevel: true,
      },
      effectWait: {
        opcode: 'control_wait',
        next: 'pitch',
        parent: 'effectHat',
        inputs: { DURATION: [1, [4, '0.5']] },
        fields: {},
      },
      pitch: {
        opcode: 'sound_seteffectto',
        next: 'pan',
        parent: 'effectWait',
        inputs: { VALUE: [1, [4, '120']] },
        fields: { EFFECT: ['PITCH', null] },
      },
      pan: {
        opcode: 'sound_seteffectto',
        next: null,
        parent: 'pitch',
        inputs: { VALUE: [1, [4, '-100']] },
        fields: { EFFECT: ['PAN', null] },
      },
    })
  const monitors = volumeScript
    ? [
        {
          id: 'volume',
          opcode: 'sound_volume',
          spriteName: null,
          params: {},
          mode: 'default',
          visible: true,
          value: 100,
          x: 0,
          y: 0,
        },
      ]
    : []
  const data = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { v: ['result', 0] },
        lists: {},
        broadcasts: {},
        blocks,
        costumes: [],
        sounds: [
          {
            name: 'tone',
            assetId: 'tone',
            md5ext: 'tone.wav',
            dataFormat: 'wav',
            rate,
            sampleCount: samples,
          },
        ],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
    ],
    monitors,
    extensions: [],
    meta: { semver: '3.0.0' },
  }
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(data)), 'tone.wav': wav }))
}

async function open(stopScript = false, volumeScript = false, effectScript = false, adpcm = false) {
  const context = await browser!.newContext()
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') return route.abort()
    const isolated = process.env.XYO_AUDIO_WASM_DIR
    if (isolated && /\/xyo-browser-esm\.(mjs|wasm)$/.test(url.pathname)) {
      const name = url.pathname.endsWith('.wasm') ? 'xyo-browser-esm.wasm' : 'xyo-browser-esm.mjs'
      return route.fulfill({
        path: join(isolated, name),
        contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      })
    }
    return route.continue()
  })
  await context.addInitScript((rejectAdpcm) => {
    const nativeDecode = AudioContext.prototype.decodeAudioData
    const nativeCreateBuffer = AudioContext.prototype.createBuffer
    const decodedBuffers: AudioBuffer[] = []
    ;(window as any).__createdAudioBuffers = decodedBuffers
    ;(window as any).__rejectedAdpcmNativeDecodes = 0
    AudioContext.prototype.createBuffer = function (...args) {
      const buffer = nativeCreateBuffer.apply(this, args)
      decodedBuffers.push(buffer)
      return buffer
    }
    AudioContext.prototype.decodeAudioData = function (data, ...callbacks) {
      const view = new DataView(data)
      if (
        rejectAdpcm &&
        view.byteLength === 4156 &&
        view.getUint32(0, false) === 0x52494646 &&
        view.getUint16(20, true) === 0x11
      ) {
        ;(window as any).__rejectedAdpcmNativeDecodes++
        const error = new DOMException(
          'Intentional test rejection for ADPCM fixture',
          'EncodingError',
        )
        callbacks[1]?.(error)
        return Promise.reject(error)
      }
      return nativeDecode.call(this, data, ...callbacks)
    }
    localStorage.setItem('hikkaku.runtime-backend', 'xyo-cpp')
    const events: Array<{ kind: string; id: number; time: number; state?: string }> = []
    ;(window as any).__audioEvents = events
    const contexts: AudioContext[] = []
    ;(window as any).__audioContexts = contexts
    const sources: AudioBufferSourceNode[] = [],
      panners: StereoPannerNode[] = []
    ;(window as any).__audioSources = sources
    ;(window as any).__audioPanners = panners
    const createPanner = AudioContext.prototype.createStereoPanner
    AudioContext.prototype.createStereoPanner = function () {
      const panner = createPanner.call(this)
      panners.push(panner)
      return panner
    }
    const gains: GainNode[] = []
    ;(window as any).__audioGains = gains
    const routes: Array<{ id: number; gain: GainNode }> = []
    ;(window as any).__audioRoutes = routes
    const createGain = AudioContext.prototype.createGain
    AudioContext.prototype.createGain = function () {
      const gain = createGain.call(this)
      gains.push(gain)
      return gain
    }
    let id = 0
    const create = AudioContext.prototype.createBufferSource
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this),
        current = ++id,
        ctx = this
      sources.push(source)
      if (!contexts.includes(ctx)) contexts.push(ctx)
      const start = source.start,
        stop = source.stop,
        connect = source.connect
      source.connect = function (...args: any[]) {
        if (args[0] instanceof GainNode) routes.push({ id: current, gain: args[0] })
        return (connect as any).apply(this, args)
      } as typeof source.connect
      source.start = function (...args) {
        events.push({ kind: 'start', id: current, time: performance.now(), state: ctx.state })
        source.addEventListener(
          'ended',
          () => {
            const snapshot = (window as any).__hikkakuEditorTest?.snapshot()
            ;(window as any).__valueAtAudioEnd = snapshot?.project.targets.find(
              (t: any) => t.variables.v,
            )?.variables.v[1]
            events.push({ kind: 'ended', id: current, time: performance.now() })
          },
          { once: true },
        )
        return start.apply(this, args)
      }
      source.stop = function (...args) {
        events.push({ kind: 'stop', id: current, time: performance.now() })
        return stop.apply(this, args)
      }
      return source
    }
  }, adpcm)
  const page = await context.newPage()
  const pageErrors: string[] = []
  errors.set(page, pageErrors)
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.stack || error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`)
  })
  await page.goto(base)
  await page.getByTestId('stage-canvas').waitFor()
  await page.getByTestId('project-file-input').setInputFiles({
    name: 'audio.sb3',
    mimeType: 'application/octet-stream',
    buffer: project(stopScript, volumeScript, effectScript, adpcm),
  })
  await page.waitForFunction(
    () =>
      (window as any).__hikkakuEditorTest
        ?.snapshot()
        .project.targets.some((t: any) => t.variables.v?.[0] === 'result'),
    null,
    { timeout: 15000 },
  )
  return { context, page }
}
async function diagnostics(page: Page, error: unknown): Promise<never> {
  let state: unknown
  try {
    state = await page.evaluate(() => ({
      events: (window as any).__audioEvents,
      contexts: ((window as any).__audioContexts || []).map((c: AudioContext) => ({
        state: c.state,
        currentTime: c.currentTime,
      })),
      gains: ((window as any).__audioGains || []).map((g: GainNode) => g.gain.value),
      snapshot: (window as any).__hikkakuEditorTest?.snapshot(),
      alerts: Array.from(document.querySelectorAll('[role="alert"]'), (el) => el.textContent),
    }))
  } catch (e) {
    state = `diagnostics failed: ${String(e)}`
  }
  console.error(
    'Audio E2E failure diagnostics:',
    JSON.stringify({ state, errors: errors.get(page) }, null, 2),
  )
  throw error
}
async function events(page: Page) {
  return page.evaluate(
    () =>
      (window as any).__audioEvents as Array<{
        kind: string
        id: number
        time: number
        state?: string
      }>,
  )
}
async function waitEvent(page: Page, kind: string, count: number) {
  await page.waitForFunction(
    ({ kind, count }) =>
      (window as any).__audioEvents.filter((e: any) => e.kind === kind).length >= count,
    { kind, count },
    { timeout: 10000 },
  )
}
async function value(page: Page) {
  return page.evaluate(
    () =>
      (window as any).__hikkakuEditorTest.snapshot().project.targets.find((t: any) => t.variables.v)
        ?.variables.v[1],
  )
}
async function waitValue(page: Page, expected: number) {
  await page.waitForFunction(
    (expected) =>
      Number(
        (window as any).__hikkakuEditorTest
          .snapshot()
          .project.targets.find((t: any) => t.variables.v)?.variables.v[1],
      ) === expected,
    expected,
    { timeout: 10000 },
  )
}

suite('legacy retired App xyo-cpp WebAudio integration', () => {
  beforeAll(async () => {
    const socket = createServer()
    await new Promise<void>((resolve, reject) =>
      socket.once('error', reject).listen(0, '127.0.0.1', resolve),
    )
    const address = socket.address()
    if (!address || typeof address === 'string') throw new Error('Could not allocate port')
    const port = address.port
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    )
    base = `http://127.0.0.1:${port}`
    server = spawn(
      process.execPath,
      ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: join(import.meta.dir, '..'), stdio: 'ignore' },
    )
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited: ${server.exitCode}`)
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
    if (!ready) throw new Error('Vite did not start')
    browser = await launchBrowser({
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
  }, 30000)
  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      server?.kill()
    }
  })

  test('waits for natural completion before resuming the script', async () => {
    const { context, page } = await open()
    try {
      await page.getByRole('button', { name: 'Green flag' }).click()
      await waitEvent(page, 'start', 1)
      expect(Number(await value(page))).toBe(0)
      const start = (await events(page)).find((e) => e.kind === 'start')!
      expect(start.state).toBe('running')
      await waitEvent(page, 'ended', 1)
      expect(Number(await page.evaluate(() => (window as any).__valueAtAudioEnd))).toBe(0)
      await waitValue(page, 1)
      const all = await events(page)
      expect(all.filter((e) => e.kind === 'start')).toHaveLength(1)
      expect(all.filter((e) => e.kind === 'stop')).toHaveLength(0)
      expect(all.find((e) => e.kind === 'ended')!.time - start.time).toBeGreaterThan(500)
    } catch (error) {
      await diagnostics(page, error)
    } finally {
      await context.close()
    }
  }, 30000)

  test('Scratch IMA ADPCM WAV uses the independent decoder and waits for playback', async () => {
    const { context, page } = await open(false, false, false, true)
    try {
      await page.getByRole('button', { name: 'Green flag' }).click()
      await waitEvent(page, 'start', 1)
      const audio = await page.evaluate(() => {
        const source: AudioBufferSourceNode = (window as any).__audioSources[0]
        const buffer = source.buffer!
        return {
          customBuffer: (window as any).__createdAudioBuffers.includes(buffer),
          channels: buffer.numberOfChannels,
          rate: buffer.sampleRate,
          length: buffer.length,
          samples: Array.from(buffer.getChannelData(0).slice(0, 3)),
          rejected: (window as any).__rejectedAdpcmNativeDecodes,
        }
      })
      expect(audio.customBuffer).toBe(true)
      expect(audio.channels).toBe(1)
      expect(audio.rate).toBe(8000)
      // Scratch's decoder emits N * (samplesPerBlock - 1) + 1 samples,
      // independently of this WAV's deliberately different fact chunk.
      expect(audio.length).toBe(16 * 504 + 1)
      expect(audio.samples[0]).toBeCloseTo(0, 6)
      expect(audio.samples[1]).toBeCloseTo(6 / 32768, 6)
      expect(audio.samples[2]).toBeCloseTo(0, 6)
      // Native decode is attempted first and rejected only for this fixture;
      // the observed createBuffer above must therefore come from the fallback.
      expect(audio.rejected).toBe(1)
      expect(Number(await value(page))).toBe(0)
      await waitEvent(page, 'ended', 1)
      expect(Number(await page.evaluate(() => (window as any).__valueAtAudioEnd))).toBe(0)
      await waitValue(page, 1)
      expect((await events(page)).filter((e) => e.kind === 'stop')).toHaveLength(0)
    } catch (error) {
      await diagnostics(page, error)
    } finally {
      await context.close()
    }
  }, 30000)

  test('reflag stops the previous voice and only the new generation resumes', async () => {
    const { context, page } = await open()
    try {
      const flag = page.getByRole('button', { name: 'Green flag' })
      await flag.click()
      await waitEvent(page, 'start', 1)
      await flag.click()
      await waitEvent(page, 'start', 2)
      await waitEvent(page, 'stop', 1)
      const all = await events(page),
        starts = all.filter((e) => e.kind === 'start')
      expect(all.some((e) => e.kind === 'stop' && e.id === starts[0].id)).toBe(true)
      expect(Number(await value(page))).toBe(0)
      await waitValue(page, 1)
      await page.waitForTimeout(1200)
      expect(Number(await value(page))).toBe(1)
      expect((await events(page)).filter((e) => e.kind === 'start')).toHaveLength(2)
    } catch (error) {
      await diagnostics(page, error)
    } finally {
      await context.close()
    }
  }, 30000)

  test('live pitch and pan effects update actual WebAudio nodes', async () => {
    const { context, page } = await open(false, false, true)
    try {
      await page.getByRole('button', { name: 'Green flag' }).click()
      await waitEvent(page, 'start', 1)
      await page.waitForFunction(
        () =>
          (window as any).__audioSources[0]?.playbackRate.value === 2 &&
          (window as any).__audioPanners[0]?.pan.value === -1,
        null,
        { timeout: 10000 },
      )
      expect(
        (await events(page)).filter((e) => e.kind === 'ended' || e.kind === 'stop'),
      ).toHaveLength(0)
      expect(Number(await value(page))).toBe(0)
      await waitEvent(page, 'ended', 1)
      await waitValue(page, 1)
    } catch (error) {
      await diagnostics(page, error)
    } finally {
      await context.close()
    }
  }, 30000)

  for (const stopAfterChange of [false, true])
    test(`live volume update ${stopAfterChange ? 'then stop' : 'then natural completion'}`, async () => {
      const { context, page } = await open(false, true)
      try {
        await page.getByRole('button', { name: 'Green flag' }).click()
        await waitEvent(page, 'start', 1)
        const id = (await events(page)).find((e) => e.kind === 'start')!.id
        await page.waitForFunction(
          (id) => {
            const route = (window as any).__audioRoutes.find((r: any) => r.id === id)
            const monitor = (window as any).__hikkakuEditorTest
              ?.snapshot()
              .project.monitors.find((m: any) => m.opcode === 'sound_volume')
            return (
              route &&
              Math.abs(route.gain.gain.value - 0.25) < 0.001 &&
              Number(monitor?.value) === 25
            )
          },
          id,
          { timeout: 10000 },
        )
        const observed = await page.evaluate(
          (id) => ({
            gain: (window as any).__audioRoutes.find((r: any) => r.id === id)?.gain.gain.value,
            monitor: (window as any).__hikkakuEditorTest
              .snapshot()
              .project.monitors.find((m: any) => m.opcode === 'sound_volume')?.value,
          }),
          id,
        )
        expect(observed.gain).toBeCloseTo(0.25, 3)
        expect(Number(observed.monitor)).toBe(25)
        expect(
          (await events(page)).filter((e) => e.kind === 'ended' || e.kind === 'stop'),
        ).toHaveLength(0)
        expect(Number(await value(page))).toBe(0)
        if (stopAfterChange) {
          await page.getByRole('button', { name: 'Stop all' }).click()
          await waitEvent(page, 'stop', 1)
          expect((await events(page)).find((e) => e.kind === 'stop')?.id).toBe(id)
          await page.waitForTimeout(3200)
          expect(Number(await value(page))).toBe(0)
        } else {
          await waitEvent(page, 'ended', 1)
          expect(Number(await page.evaluate(() => (window as any).__valueAtAudioEnd))).toBe(0)
          await waitValue(page, 1)
        }
      } catch (error) {
        await diagnostics(page, error)
      } finally {
        await context.close()
      }
    }, 30000)

  for (const mode of ['button', 'script'] as const)
    test(`${mode} stop all cancels playback and prevents continuation`, async () => {
      const { context, page } = await open(mode === 'script')
      try {
        await page.getByRole('button', { name: 'Green flag' }).click()
        await waitEvent(page, 'start', 1)
        if (mode === 'button') await page.getByRole('button', { name: 'Stop all' }).click()
        await waitEvent(page, 'stop', 1)
        const all = await events(page)
        expect(all.find((e) => e.kind === 'stop')!.id).toBe(all.find((e) => e.kind === 'start')!.id)
        await page.waitForTimeout(1400)
        expect(Number(await value(page))).toBe(0)
        expect((await events(page)).filter((e) => e.kind === 'start')).toHaveLength(1)
      } catch (error) {
        await diagnostics(page, error)
      } finally {
        await context.close()
      }
    }, 30000)
})
