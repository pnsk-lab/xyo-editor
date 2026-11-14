import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Opt-in sequential runner for the Scratch Paint real-screen regression suites.
 *
 * Background: `test:browser` only covers `editor-conformance` + `plugin`.
 * Each paint browser test owns a fixed Vite port and heavy assets, so they
 * must run sequentially in isolated Bun processes (never in one `bun test`
 * invocation). This runner does exactly that:
 *
 * - one `bun test <file>` child process per target, strictly sequential,
 * - child's stdout/stderr pass through (`stdio: 'inherit'`),
 * - `CHROME_BIN` (and the whole environment) is inherited by every child,
 * - the accurately aggregated exit code: 0 = all pass, 1 = test failure,
 *   2 = environment/usage error (missing Chrome, missing file/fixture,
 *   occupied fixed port, unknown selection),
 * - no leaked children: SIGINT/SIGTERM is forwarded to the running child,
 * - preflight fails fast with an actionable message for fixed-port
 *   conflicts (stale Vite/HMR servers using `--strictPort` ports),
 *   missing fixtures, and Chrome-less CI.
 *
 * Usage:
 *   bun scripts/run-paint-browser-tests.ts [--list] [--help]
 *   bun scripts/run-paint-browser-tests.ts --select smoke
 *   bun scripts/run-paint-browser-tests.ts --files test/a.browser.test.ts test/b.test.ts
 */

export const EDITOR_ROOT = join(import.meta.dir, '..')

/** Resolve a target to a filesystem path (absolute targets pass through). */
export function resolveTargetPath(file: string): string {
  return isAbsolute(file) ? file : join(EDITOR_ROOT, file)
}

/**
 * Default paint regression targets. Each entry is relative to packages/editor
 * and covers one high-value paint dimension:
 *
 * - bit drawing ............ transparent-brush (real canvas pixels)
 * - vector drawing ......... vector-eraser (erase path through the UI)
 * - clipboard both ways .... clipboard-independent-verify (bitmap <-> vector)
 * - cancel ................. bitmap-pointercancel (pointercancel restores pixels)
 * - owner gate ............. bitmap-workspace-owner-gate (static, no browser)
 * - SVG network ............ svg-sanitize-network (zero external requests)
 * - center snap ............ center-snap-vector-drag-real (Scratch CENTER parity)
 * - text styles ............ text-font-preserve (font stack preservation)
 * - history ................ paint-history-isolation (paint/sound stacks)
 * - mode conversion ........ costume-conversion (bitmap <-> vector round-trip)
 * - stage pixels ........... stage-png-import-audit (stage RGBA + resolution)
 * - drag race .............. vector-drag-race-gate (drag vs cancel/Escape/stale gated write)
 * - write gate diag ........ vector-write-gate-diag (resize/delete/reorder forensics)
 * - write gate indep ........ vector-write-gate-independent (deferred gated writes)
 * - group leaf ............. vector-group-leaf-translate-integration (group leaf drag)
 * - multi-hole fill ........ vector-fill-multi-hole-integration (multi-hole fill)
 */
export const DEFAULT_PAINT_TESTS: readonly string[] = [
  'test/transparent-brush.browser.test.ts',
  'test/vector-eraser.browser.test.ts',
  'test/clipboard-independent-verify.browser.test.ts',
  'test/bitmap-pointercancel.browser.test.ts',
  'test/bitmap-workspace-owner-gate.test.ts',
  'test/svg-sanitize-network.browser.test.ts',
  'test/center-snap-vector-drag-real.browser.test.ts',
  'test/text-font-preserve.browser.test.ts',
  'test/paint-history-isolation.browser.test.ts',
  'test/costume-conversion.browser.test.ts',
  'test/stage-png-import-audit.browser.test.ts',
  'test/vector-drag-race-gate.browser.test.ts',
  'test/vector-write-gate-diag.browser.test.ts',
  'test/vector-write-gate-independent.browser.test.ts',
  'test/vector-group-leaf-translate-integration.browser.test.ts',
  'test/vector-fill-multi-hole-integration.browser.test.ts',
]

/** Lightweight named selections for quick verification (--select <name>). */
export const SELECTIONS: Record<string, readonly string[]> = {
  smoke: ['test/transparent-brush.browser.test.ts', 'test/svg-sanitize-network.browser.test.ts'],
}

export const EXIT_PASS = 0
export const EXIT_TEST_FAILURE = 1
export const EXIT_ENV_ERROR = 2

export interface ParsedArgs {
  mode: 'defaults' | 'select' | 'files' | 'list' | 'help'
  selection: string
  files: string[]
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { mode: 'defaults', selection: '', files: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      parsed.mode = 'help'
      return parsed
    }
    if (arg === '--list') {
      parsed.mode = 'list'
      return parsed
    }
    if (arg === '--select') {
      const name = argv[index + 1]
      if (!name || name.startsWith('--')) throw new Error('--select requires a selection name')
      parsed.mode = 'select'
      parsed.selection = name
      index += 1
      continue
    }
    if (arg.startsWith('--select=')) {
      parsed.mode = 'select'
      parsed.selection = arg.slice('--select='.length)
      if (!parsed.selection) throw new Error('--select requires a selection name')
      continue
    }
    if (arg === '--files') {
      parsed.mode = 'files'
      continue
    }
    if (arg.startsWith('--files=')) {
      parsed.mode = 'files'
      const value = arg.slice('--files='.length)
      parsed.files.push(...value.split(',').map((entry) => entry.trim()).filter(Boolean))
      continue
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`)
    if (parsed.mode === 'files') {
      parsed.files.push(arg)
      continue
    }
    throw new Error(`Unexpected argument: ${arg} (use --files <paths...> for explicit files)`)
  }
  return parsed
}

export function resolveTargets(args: ParsedArgs): { targets: string[] } | { error: string } {
  if (args.mode === 'select') {
    const selection = SELECTIONS[args.selection]
    if (!selection) {
      const known = Object.keys(SELECTIONS).sort().join(', ') || '(none)'
      return { error: `Unknown selection: ${args.selection} (known: ${known})` }
    }
    return { targets: [...selection] }
  }
  if (args.mode === 'files') {
    if (args.files.length === 0) return { error: '--files requires at least one test file' }
    return { targets: [...args.files] }
  }
  return { targets: [...DEFAULT_PAINT_TESTS] }
}

/** Strip line/block comments so port scans ignore surveyed-port notes. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

function uniqueSorted(numbers: number[]): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b)
}

/** Fixed loopback ports a browser test file claims (vite `--port` / base URL). */
export function extractPorts(source: string): number[] {
  const clean = stripComments(source)
  const ports: number[] = []
  for (const match of clean.matchAll(/--port['"`\s,]+(\d{4,5})/g)) ports.push(Number(match[1]))
  for (const match of clean.matchAll(/127\.0\.0\.1:(\d{4,5})/g)) ports.push(Number(match[1]))
  return uniqueSorted(ports.filter((port) => port >= 1024 && port <= 65535))
}

/** `test/*.html` fixtures a browser test navigates to. */
export function extractFixtures(source: string): string[] {
  const clean = stripComments(source)
  const fixtures: string[] = []
  for (const match of clean.matchAll(/test\/([\w][\w.-]*\.html)/g)) fixtures.push(`test/${match[1]}`)
  return [...new Set(fixtures)].sort()
}

export interface ChromeCheck {
  ok: boolean
  detail: string
}

/**
 * Resolve the Chrome/Chromium executable for the children.
 *
 * `browser-launcher` only honors CHROME_BIN/BROWSER (or Playwright channels
 * in standard install locations, not PATH), so an explicit variable wins;
 * otherwise the runner promotes a PATH binary to CHROME_BIN so every child
 * inherits a working launcher. Returns null when nothing is available.
 */
export function resolveChromeBin(
  env: NodeJS.ProcessEnv,
  isExecutableFileFn: (path: string) => boolean,
  lookupOnPathFn: (name: string) => string | null,
): string | null {
  const explicit = env.CHROME_BIN ?? env.BROWSER
  if (explicit && explicit.trim() !== '' && isExecutableFileFn(explicit)) return explicit
  for (const name of ['google-chrome', 'chrome', 'chromium', 'chromium-browser']) {
    const found = lookupOnPathFn(name)
    if (found) return found
  }
  return null
}

export function checkChrome(
  env: NodeJS.ProcessEnv,
  isExecutableFile: (path: string) => boolean,
  lookupOnPath: (name: string) => string | null,
): ChromeCheck {
  const explicit = env.CHROME_BIN ?? env.BROWSER
  if (explicit && explicit.trim() !== '') {
    if (isExecutableFile(explicit)) return { ok: true, detail: `CHROME_BIN=${explicit}` }
    return {
      ok: false,
      detail:
        `CHROME_BIN points to a missing/non-executable file: ${explicit}\n` +
        'CHROME_BIN に指定された Chrome/Chromium が見つかりません。パスを見直してください。',
    }
  }
  for (const name of ['google-chrome', 'chrome', 'chromium', 'chromium-browser']) {
    const found = lookupOnPath(name)
    if (found) return { ok: true, detail: `found ${name} at ${found}` }
  }
  const ci = env.CI !== undefined && env.CI !== ''
  return {
    ok: false,
    detail:
      'Could not find Chrome/Chromium for the paint browser tests. ' +
      'Set CHROME_BIN (or BROWSER) to a Chrome/Chromium executable.\n' +
      'paint browser テスト用の Chrome/Chromium が見つかりません。' +
      'CHROME_BIN に実行ファイルのパスを設定してください。' +
      (ci ? ' (CI ではブラウザが未導入のためこのままでは実行できません)' : ''),
  }
}

export function lookupOnPath(env: NodeJS.ProcessEnv, name: string): string | null {
  const pathValue = env.PATH ?? ''
  if (!pathValue) return null
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // not executable here; keep searching
    }
  }
  return null
}

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface PreflightIssue {
  kind: 'missing-test' | 'missing-fixture' | 'port-conflict' | 'port-duplicate' | 'chrome'
  message: string
}

function defaultReadSource(file: string): string | null {
  try {
    return readFileSync(resolveTargetPath(file), 'utf8')
  } catch {
    return null
  }
}

export async function preflight(
  targets: readonly string[],
  deps: {
    fileExists: (file: string) => boolean
    readSource: (file: string) => string | null
    chrome: ChromeCheck
    probePort: (port: number) => Promise<boolean>
  },
): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = []
  if (!deps.chrome.ok) issues.push({ kind: 'chrome', message: deps.chrome.detail })
  const seenPorts = new Map<number, string>()
  for (const file of targets) {
    if (!deps.fileExists(file)) {
      issues.push({ kind: 'missing-test', message: `Test file not found: ${file}` })
      continue
    }
    const source = deps.readSource(file)
    if (source === null) continue
    for (const fixture of extractFixtures(source)) {
      if (!deps.fileExists(fixture)) {
        issues.push({ kind: 'missing-fixture', message: `${file} needs missing fixture: ${fixture}` })
      }
    }
    for (const port of extractPorts(source)) {
      const owner = seenPorts.get(port)
      if (owner !== undefined && owner !== file) {
        issues.push({ kind: 'port-duplicate', message: `Fixed port ${port} is claimed by both ${owner} and ${file}` })
      } else {
        seenPorts.set(port, file)
      }
    }
  }
  for (const [port, owner] of [...seenPorts.entries()].sort((a, b) => a[0] - b[0])) {
    if (await deps.probePort(port)) {
      issues.push({
        kind: 'port-conflict',
        message:
          `Fixed port ${port} (used by ${owner}) is already in use. ` +
          'Stop the stale `vite --strictPort` / HMR server holding it, then retry. ' +
          `固定 port ${port} は使用中です。占有している Vite/HMR サーバを停止して再実行してください。`,
      })
    }
  }
  return issues
}

export function probePortInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (inUse: boolean): void => {
      socket.destroy()
      resolve(inUse)
    }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs)
  })
}

export interface TestResult {
  file: string
  code: number | null
  signal: string | null
  ms: number
}

export function summarize(results: readonly TestResult[]): { text: string; failed: string[]; exitCode: number } {
  const passed = results.filter((result) => result.code === 0)
  const failed = results.filter((result) => result.code !== 0).map((result) => result.file)
  const lines = results.map((result) => {
    const status = result.code === 0 ? 'PASS' : `FAIL(code=${result.code ?? 'null'}${result.signal ? `,signal=${result.signal}` : ''})`
    return `  ${status} ${(result.ms / 1000).toFixed(1)}s ${result.file}`
  })
  const text = [
    '',
    'paint browser results:',
    ...lines,
    `${passed.length} passed, ${failed.length} failed (${results.length} total)`,
    ...(failed.length > 0 ? ['failed:', ...failed.map((file) => `  - ${file}`)] : []),
  ].join('\n')
  return { text, failed, exitCode: failed.length > 0 ? EXIT_TEST_FAILURE : EXIT_PASS }
}

function runOne(file: string, current: { child: ChildProcess | undefined }): Promise<TestResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    console.log(`\n=== paint: ${file} ===`)
    const child = spawn('bun', ['test', file], { cwd: EDITOR_ROOT, stdio: 'inherit', env: { ...process.env } })
    current.child = child
    child.once('error', (error) => {
      current.child = undefined
      console.error(`paint runner: failed to spawn 'bun test ${file}': ${String(error)}`)
      resolve({ file, code: 1, signal: null, ms: Date.now() - started })
    })
    child.once('exit', (code, signal) => {
      current.child = undefined
      resolve({ file, code, signal, ms: Date.now() - started })
    })
  })
}

function printHelp(): void {
  console.log(
    [
      'Usage: bun scripts/run-paint-browser-tests.ts [options] [--files <test...> ]',
      '',
      'Opt-in sequential runner for the Scratch Paint real-screen regression suites.',
      'Each target runs in its own `bun test <file>` process, one at a time.',
      '',
      'Options:',
      '  (no args)            run all default paint targets (see DEFAULT_PAINT_TESTS)',
      '  --select <name>      run a named lightweight selection (known: ' +
        `${Object.keys(SELECTIONS).sort().join(', ') || '(none)'})`,
      '  --files <paths...>   run explicit test files (relative to packages/editor)',
      '  --list               print the default targets and exit',
      '  --help               print this help and exit',
      '',
      'Exit codes: 0 all pass, 1 test failure, 2 environment/usage error.',
      'CHROME_BIN (or BROWSER) is inherited by every child process.',
    ].join('\n'),
  )
}

async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(`paint runner: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_ENV_ERROR
  }
  if (args.mode === 'help') {
    printHelp()
    return EXIT_PASS
  }
  if (args.mode === 'list') {
    console.log([...DEFAULT_PAINT_TESTS].join('\n'))
    return EXIT_PASS
  }
  const resolved = resolveTargets(args)
  if ('error' in resolved) {
    console.error(`paint runner: ${resolved.error}`)
    return EXIT_ENV_ERROR
  }
  const targets = resolved.targets
  console.log(`paint runner: ${targets.length} target(s), sequential, each in its own \`bun test\` process`)

  // Inherit CHROME_BIN when set; otherwise promote a PATH binary so the
  // channel-only fallback in browser-launcher still finds a real browser.
  if (!process.env.CHROME_BIN && !process.env.BROWSER) {
    const found = resolveChromeBin(process.env, isExecutableFile, (name) => lookupOnPath(process.env, name))
    if (found) {
      process.env.CHROME_BIN = found
      console.log(`paint runner: CHROME_BIN was unset; exporting CHROME_BIN=${found} for all children`)
    }
  }
  const chrome = checkChrome(process.env, isExecutableFile, (name) => lookupOnPath(process.env, name))
  const issues = await preflight(targets, {
    fileExists: (file) => existsSync(resolveTargetPath(file)),
    readSource: defaultReadSource,
    chrome,
    probePort: probePortInUse,
  })
  if (issues.length > 0) {
    for (const issue of issues) console.error(`paint runner [${issue.kind}]: ${issue.message}`)
    console.error('paint runner: preflight failed, no tests were started.')
    return EXIT_ENV_ERROR
  }

  const current: { child: ChildProcess | undefined } = { child: undefined }
  let aborted = false
  const abort = (signal: NodeJS.Signals): void => {
    aborted = true
    if (current.child && current.child.exitCode === null) {
      try {
        current.child.kill(signal)
      } catch {
        // the child already went away; nothing to forward
      }
    }
  }
  process.once('SIGINT', () => abort('SIGINT'))
  process.once('SIGTERM', () => abort('SIGTERM'))

  const results: TestResult[] = []
  for (const file of targets) {
    if (aborted) {
      results.push({ file, code: null, signal: 'aborted', ms: 0 })
      continue
    }
    results.push(await runOne(file, current))
  }
  const summary = summarize(results)
  console.log(summary.text)
  return summary.exitCode
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
