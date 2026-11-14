import { describe, expect, it } from 'bun:test'
import {
  checkChrome,
  DEFAULT_PAINT_TESTS,
  EXIT_ENV_ERROR,
  EXIT_PASS,
  EXIT_TEST_FAILURE,
  extractFixtures,
  extractPorts,
  parseArgs,
  preflight,
  resolveChromeBin,
  resolveTargetPath,
  resolveTargets,
  SELECTIONS,
  stripComments,
  summarize,
} from '../scripts/run-paint-browser-tests.ts'

/**
 * Unit tests for the opt-in `test:paint` runner.
 *
 * Pure-helper coverage only (arg parsing, target resolution, port/fixture
 * extraction, summary exit codes, Chrome/port preflight with injected
 * dependencies). No browser, no Vite server, no production build.
 */

describe('paint runner args', () => {
  it('defaults to the full paint target list', () => {
    const resolved = resolveTargets(parseArgs([]))
    if ('error' in resolved) throw new Error(resolved.error)
    expect(resolved.targets).toEqual([...DEFAULT_PAINT_TESTS])
    expect(resolved.targets.length).toBeGreaterThan(0)
  })

  it('default list covers every required paint dimension', () => {
    const joined = DEFAULT_PAINT_TESTS.join('\n')
    for (const marker of [
      'transparent-brush', // bit drawing
      'vector-eraser', // vector drawing
      'clipboard-independent-verify', // clipboard both directions
      'bitmap-pointercancel', // cancel
      'bitmap-workspace-owner-gate', // owner gate
      'svg-sanitize-network', // SVG network
      'center-snap-vector-drag-real', // center snap
      'text-font-preserve', // text styles
      'paint-history-isolation', // history
      'costume-conversion', // mode conversion
      'stage-png-import-audit', // stage pixels
      'vector-drag-race-gate', // drag race
      'vector-write-gate-diag', // write gate diag
      'vector-write-gate-independent', // write gate independent
      'vector-group-leaf-translate-integration', // group leaf
      'vector-fill-multi-hole-integration', // multi-hole fill
    ]) {
      expect(joined).toContain(marker)
    }
  })

  it('supports the lightweight smoke selection', () => {
    expect(Object.keys(SELECTIONS)).toContain('smoke')
    expect(SELECTIONS.smoke.length).toBe(2)
    const resolved = resolveTargets(parseArgs(['--select', 'smoke']))
    if ('error' in resolved) throw new Error(resolved.error)
    expect(resolved.targets).toEqual([...SELECTIONS.smoke])
  })

  it('rejects an unknown selection with the known names', () => {
    const resolved = resolveTargets(parseArgs(['--select', 'nope']))
    if (!('error' in resolved)) throw new Error('expected an error')
    expect(resolved.error).toContain('nope')
    expect(resolved.error).toContain('smoke')
  })

  it('accepts explicit files and rejects an empty --files', () => {
    const resolved = resolveTargets(parseArgs(['--files', 'test/a.browser.test.ts', 'test/b.test.ts']))
    if ('error' in resolved) throw new Error(resolved.error)
    expect(resolved.targets).toEqual(['test/a.browser.test.ts', 'test/b.test.ts'])
    const empty = resolveTargets(parseArgs(['--files']))
    if (!('error' in empty)) throw new Error('expected an error')
  })

  it('rejects unknown options and bare paths', () => {
    expect(() => parseArgs(['--bogus'])).toThrow()
    expect(() => parseArgs(['test/a.browser.test.ts'])).toThrow()
    expect(() => parseArgs(['--select'])).toThrow()
  })
})

describe('paint runner port/fixture extraction', () => {
  it('ignores surveyed-port notes inside comments', () => {
    const source = [
      '// surveyed 2026-11: 4173/4178/4179/4180 are taken',
      '/* block: 127.0.0.1:4999 and --port 4998 */',
      "server = spawn('bun', ['x', 'vite', '--port', '4236', '--strictPort'])",
      "const base = 'http://127.0.0.1:4236'",
    ].join('\n')
    expect(stripComments(source)).not.toContain('4173')
    expect(stripComments(source)).not.toContain('4999')
    expect(extractPorts(source)).toEqual([4236])
  })

  it('finds no fixed port for dynamic-port suites', () => {
    const source = [
      'const s = createServer()',
      "s.listen(0, '127.0.0.1', () => {})",
      "spawn('bun', ['x', 'vite', '--port', String(port), '--strictPort'])",
    ].join('\n')
    expect(extractPorts(source)).toEqual([])
  })

  it('extracts html fixtures', () => {
    const source = "await page.goto(`${base}/test/paint-history-isolation-fixture.html`)"
    expect(extractFixtures(source)).toEqual(['test/paint-history-isolation-fixture.html'])
  })
})

describe('paint runner summary', () => {
  it('exits 0 when every target passes', () => {
    const summary = summarize([
      { file: 'test/a.browser.test.ts', code: 0, signal: null, ms: 12 },
      { file: 'test/b.test.ts', code: 0, signal: null, ms: 34 },
    ])
    expect(summary.exitCode).toBe(EXIT_PASS)
    expect(summary.failed).toEqual([])
    expect(summary.text).toContain('2 passed, 0 failed')
  })

  it('exits 1 and lists every failure accurately', () => {
    const summary = summarize([
      { file: 'test/a.browser.test.ts', code: 0, signal: null, ms: 12 },
      { file: 'test/b.browser.test.ts', code: 1, signal: null, ms: 34 },
      { file: 'test/c.browser.test.ts', code: null, signal: 'SIGTERM', ms: 5 },
    ])
    expect(summary.exitCode).toBe(EXIT_TEST_FAILURE)
    expect(summary.failed).toEqual(['test/b.browser.test.ts', 'test/c.browser.test.ts'])
    expect(summary.text).toContain('1 passed, 2 failed')
  })

  it('keeps environment errors distinct from test failures', () => {
    expect(EXIT_ENV_ERROR).not.toBe(EXIT_TEST_FAILURE)
  })
})

describe('paint runner preflight', () => {
  const okChrome = { ok: true, detail: 'test-chrome' }

  it('accepts CHROME_BIN when it is executable and inherits it via env', () => {
    const check = checkChrome(
      { CHROME_BIN: '/opt/chrome-for-test' },
      (path) => path === '/opt/chrome-for-test',
      () => null,
    )
    expect(check.ok).toBe(true)
  })

  it('fails clearly when CHROME_BIN points nowhere', () => {
    const check = checkChrome({ CHROME_BIN: '/missing/chrome' }, () => false, () => null)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('/missing/chrome')
  })

  it('fails clearly when no browser exists, mentioning CI', () => {
    const check = checkChrome({ CI: 'true' }, () => false, () => null)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('CHROME_BIN')
  })

  it('finds a PATH browser without CHROME_BIN', () => {
    const check = checkChrome({}, () => false, (name) => (name === 'chromium' ? '/usr/bin/chromium' : null))
    expect(check.ok).toBe(true)
    expect(check.detail).toContain('/usr/bin/chromium')
  })

  it('resolveTargetPath passes absolute paths through', () => {
    expect(resolveTargetPath('/tmp/x.test.ts')).toBe('/tmp/x.test.ts')
    expect(resolveTargetPath('test/a.browser.test.ts').endsWith('test/a.browser.test.ts')).toBe(true)
  })
  it('resolveChromeBin prefers an executable CHROME_BIN, else a PATH binary, else null', () => {
    expect(resolveChromeBin({ CHROME_BIN: '/opt/chrome' }, (p) => p === '/opt/chrome', () => null)).toBe('/opt/chrome')
    expect(resolveChromeBin({ CHROME_BIN: '/missing' }, () => false, (n) => (n === 'google-chrome' ? '/bin/gc' : null))).toBe(
      '/bin/gc',
    )
    expect(resolveChromeBin({}, () => false, () => null)).toBeNull()
  })

  it('reports missing tests, duplicate ports, and occupied ports', async () => {
    const files = new Map([
      ['test/a.browser.test.ts', "spawn('bun', ['x', 'vite', '--port', '4236', '--strictPort'])"],
      ['test/b.browser.test.ts', "const base = 'http://127.0.0.1:4236'"],
    ])
    const issues = await preflight(['test/a.browser.test.ts', 'test/b.browser.test.ts', 'test/gone.browser.test.ts'], {
      fileExists: (file) => files.has(file),
      readSource: (file) => files.get(file) ?? null,
      chrome: okChrome,
      probePort: async (port) => port === 4236,
    })
    const kinds = issues.map((issue) => issue.kind).sort()
    expect(kinds).toEqual(['missing-test', 'port-conflict', 'port-duplicate'])
  })

  it('passes a clean selection', async () => {
    const issues = await preflight(['test/a.browser.test.ts'], {
      fileExists: () => true,
      readSource: () => 'const base = 1',
      chrome: okChrome,
      probePort: async () => false,
    })
    expect(issues).toEqual([])
  })
})
