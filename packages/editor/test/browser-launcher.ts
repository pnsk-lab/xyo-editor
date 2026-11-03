import { chromium, type Browser, type LaunchOptions } from 'playwright-core'

/**
 * Candidate launch configurations, most explicit first.
 *
 * `playwright-core` ships no browser, so a bare `chromium.launch()` only works
 * when a browser was installed through Playwright. Prefer an explicit binary
 * (CHROME_BIN/BROWSER) and fall back to a locally installed Chrome/Chromium.
 */
function candidates(): LaunchOptions[] {
  const explicit = process.env.CHROME_BIN ?? process.env.BROWSER
  if (explicit) return [{ executablePath: explicit }]
  return [{ channel: 'chrome' }, { channel: 'chromium' }, {}]
}

function describeCandidate(options: LaunchOptions): string {
  return options.executablePath ?? options.channel ?? 'playwright default'
}

/** Launch Chromium for browser tests without baking a machine-specific path into the repo. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const failures: string[] = []
  for (const candidate of candidates()) {
    try {
      return await chromium.launch({ ...candidate, ...options })
    } catch (error) {
      const message =
        error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
      failures.push(`${describeCandidate(candidate)}: ${message}`)
    }
  }
  throw new Error(
    [
      'Could not launch a browser for the browser tests.',
      'Set CHROME_BIN (or BROWSER) to a Chrome/Chromium executable, or install one for Playwright.',
      ...failures.map((failure) => `  - ${failure}`),
    ].join('\n'),
  )
}
