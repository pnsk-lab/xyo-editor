import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

/**
 * Run the tests that do not need a browser.
 *
 * Browser suites (`*.browser.test.ts`, `turbowarp-engine.test.ts`) launch
 * Chromium and are exercised separately by `test:browser`; `editor-conformance`
 * also requires a production build.
 *
 * Optional upstream reference oracle: some `*.test.ts` suites assert against
 * the upstream AGPL paint reference checked out at `<repo-root>/.tmp/scratch-editor`
 * (git-ignored, local-only, never vendored). Clean clones — including Draft-PR
 * checkouts and CI — do not have it. Those source-dependent assertions skip
 * explicitly (`it.skipIf` / `describe.skipIf`, visible as `(skip)` entries)
 * while every independent product check in the same file keeps running; no
 * reference source is copied and nothing is hardcoded as a substitute
 * (see `test/scratch-reference.ts` for the shared probe and the rules).
 * To run the full oracle locally, clone the upstream paint repo to
 * `.tmp/scratch-editor` and re-run this command — skipped oracle tests
 * re-activate with no code changes.
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
