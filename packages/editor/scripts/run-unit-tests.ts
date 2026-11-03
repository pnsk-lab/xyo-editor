import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

/**
 * Run the tests that do not need a browser.
 *
 * Browser suites (`*.browser.test.ts`, `turbowarp-engine.test.ts`) launch
 * Chromium and are exercised separately by `test:browser`; `editor-conformance`
 * also requires a production build.
 */
const skip = /\.browser\.test\.ts$|^turbowarp-engine\.test\.ts$|^editor-conformance\.test\.ts$/
const files = readdirSync('test')
  .filter(name => name.endsWith('.test.ts') && !skip.test(name))
  .sort()
  .map(name => `test/${name}`)

if (files.length === 0) {
  console.error('No unit test files found')
  process.exit(1)
}

const result = spawnSync('bun', ['test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
