import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { XyoHeadlessRuntime, type XyoModule } from '../src/index'

const test = process.env.XYO_WASM_TEST === '1' ? it : it.skip
const root = join(import.meta.dir, '..')

describe('headless host against real xyo-cpp WASM', () => {
  test('loads and steps an SB3 through the C ABI', async () => {
    const require = createRequire(import.meta.url)
    const createModule = require(join(root, '.work/build-wasm/xyo-browser.js')) as (options: { wasmBinary: Uint8Array }) => Promise<XyoModule>
    const wasmBinary = await readFile(join(root, '.work/build-wasm/xyo-browser.wasm'))
    const module = await createModule({ wasmBinary })
    const runtime = new XyoHeadlessRuntime(module)
    try {
      const bytes = await readFile(join(root, '.work/xyo-cpp/tests/fixtures/basic.sb3'))
      runtime.loadSb3(bytes)
      const before = runtime.snapshot() as { targets: unknown[] }
      expect(before.targets.length).toBeGreaterThan(0)
      expect(runtime.supportsCompiledExecution).toBe(true)
      runtime.greenFlagInterpreter()
      runtime.step()
      expect((runtime.snapshot() as { stepSerial: number }).stepSerial).toBeGreaterThan(0)
      runtime.stop()
    } finally { runtime.dispose() }
  }, 30000)
})
