import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { type Browser } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Opt in: XYO_AUDIO_BROWSER=1 CHROME_BIN=/path/to/chrome bun test test/web-audio-host.browser.test.ts
// Tests Web Audio API behavior, not audibility or physical device volume.
const suite = process.env.XYO_AUDIO_BROWSER === '1' ? describe : describe.skip
const root = join(import.meta.dir, '..')
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''

suite('experimental WebAudioHost with Chrome AudioContext', () => {
  beforeAll(async () => {
    const socket = createServer()
    await new Promise<void>((resolve, reject) =>
      socket.once('error', reject).listen(0, '127.0.0.1', resolve),
    )
    const address = socket.address()
    if (!address || typeof address === 'string') throw new Error('Could not allocate test port')
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
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('Vite exited before becoming ready')
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

  test('applies real WebAudio pitch and pan during decode and playback', async () => {
    const page = await browser!.newPage()
    try {
      await page.goto(base)
      const result = await page.evaluate(async () =>
        (await import('/test/web-audio-host-fixture.ts')).exerciseEffects(),
      )
      expect(result.started).toBe(true)
      expect(result.decoded).toEqual([0.5, 0.5])
      expect(result.updated).toBe(true)
      expect(result.active).toEqual([8, 1])
      expect(result.stopped).toBe(true)
      expect(result.reports).toEqual(['stopped'])
    } finally {
      await page.close()
    }
  }, 15000)

  test('decodes PCM WAV, reports real ended, cancels decode, and invalidates old routing', async () => {
    const page = await browser!.newPage()
    try {
      await page.goto(base)
      const result = await page.evaluate(async () => {
        const fixture = await import('/test/web-audio-host-fixture.ts')
        return fixture.exercise()
      })
      expect(result.state).toBe('running')
      expect(result.duration).toBeCloseTo(0.08, 2)
      expect(result.started).toBe(true)
      expect(result.stopped).toBe(true)
      expect(result.duplicate).toBe(false)
      expect(result.sourcesAfterStop).toBe(0)
      expect(result.obsoleteStarted).toBe(true)
      expect(result.invalidated).toBe(true)
      expect(result.oldStart).toBe(false)
      expect(result.oldStop).toBe(false)
      expect(result.sourcesAfterInvalidation).toBe(0)
      expect(result.wrongGeneration).toBe(false)
      expect(result.currentStarted).toBe(true)
      expect(result.reports).toEqual([
        [1, '1', 'stopped'],
        [2, '2', 'ended'],
      ])
    } finally {
      await page.close()
    }
  }, 15000)
})
