import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { type Browser } from 'playwright-core'
import { hasXyoEsm, optIn } from './artifacts'
import { launchBrowser } from './browser-launcher'

// Opt-in: XYO_WORKER_BROWSER=1 CHROME_BIN=/path/to/chromium bun test test/xyo-worker-browser.test.ts
// Requires the ESM/WASM artifacts produced by packages/xyo-cpp-wasm/scripts/build.sh.
const enabled = optIn('XYO_WORKER_BROWSER', hasXyoEsm)
const root = join(import.meta.dir, '..')
const artifact = join(root, '../xyo-cpp-wasm/.work/build-wasm')
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''

async function freePort(): Promise<number> {
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
  return port
}

const project = {
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: { v: ['v', 7] },
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
        },
        a: {
          opcode: 'data_changevariableby',
          next: 'b',
          parent: 'hat',
          inputs: { VALUE: [1, [4, '3']] },
          fields: { VARIABLE: ['v', 'v'] },
        },
        b: {
          opcode: 'data_changevariableby',
          next: null,
          parent: 'a',
          inputs: { VALUE: [1, [4, '2']] },
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
  monitors: [],
  extensions: [],
  meta: { semver: '3.0.0' },
}

;(enabled ? describe : describe.skip)('xyo ESM worker in Chromium', () => {
  beforeAll(async () => {
    for (const name of ['xyo-browser-esm.mjs', 'xyo-browser-esm.wasm']) {
      if (!existsSync(join(artifact, name)))
        throw new Error(`Missing ${name}; run xyo-cpp-wasm/scripts/build.sh first`)
    }
    const port = await freePort()
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
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 30000)
  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })
  test('loads WASM, compiles and executes, forwards inputs, and terminates', async () => {
    const page = await browser!.newPage()
    try {
      await page.goto(`${base}/test/xyo-worker-browser.html`)
      const bytes = Array.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))
      const result = (await page.evaluate(async (bytes) => {
        const mod = await import('/test/xyo-worker-browser.ts')
        return await mod.exercise(bytes)
      }, bytes)) as any
      expect(result.snapshot.targets[0].variables.v.value).toBe(12)
      expect(result.stats.supportsCompiledExecution).toBe(true)
      expect(result.stats.compileStats.attempts).toBeGreaterThan(0)
      expect(result.stats.compileStats.successes).toBeGreaterThan(0)
      expect(result.stats.compileStats.executions).toBeGreaterThan(0)
      expect(result.snapshot.io.lastKey).toBe('left arrow')
      expect([
        result.snapshot.io.mouseX,
        result.snapshot.io.mouseY,
        result.snapshot.io.mouseDown,
      ]).toEqual([-120, 90, true])
      expect([result.snapshot.io.scrollX, result.snapshot.io.scrollY]).toEqual([-2, 3])
      expect(result.snapshot.io.answer).toBe('はい😀')
      expect(result.terminated).toContain('Worker terminated')
    } finally {
      await page.close()
    }
  }, 30000)
})
