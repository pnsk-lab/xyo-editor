import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-Worker host-sync generation cross-round-trip.
//
// Real code on both ends: a real ScratchVM host, the real
// RuntimeWorkerController and the real runtime.worker.ts Worker, with the
// host-side frame application mirroring Editor.svelte
// `applyWorkerRuntimeSnapshot` exactly (runtime-only merge, host selection
// wins except on WORKER_READY/WORKER_SYNC).
//
// Pins the generation repair across the full round trip:
// - first host sync records the host generation without a reset;
// - same-generation structural edits bump only the worker-local generation;
// - worker frames back never feed the worker generation into host identity
//   and cause no feedback reset on the next sync;
// - a host reload with reused ids still resets via `appliedHostGeneration`
//   even when the worker-local generation already numerically equals the new
//   host generation;
// - greenFlag runs new code exactly once (no duplicate hats), x stays
//   monotonic under stale selection-only frames, user bytes win;
// - selection-only / structural / replacement stay distinguished;
// - stale out-of-order syncId frames and stale flag payloads are dropped;
// - clones re-point, broadcast-and-wait settles, the timer restarts.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/host-sync-generation-cross-roundtrip.browser.test.ts

const root = join(import.meta.dir, '..')
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''

async function freePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate test port')
  const port = address.port
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())))
  return port
}

type AuditReport = {
  phases: Record<string, Record<string, unknown>>
  errors: unknown[]
  trail: unknown
}

async function runAudit(page: Page): Promise<AuditReport> {
  await page.goto(`${base}/test/host-sync-generation-worker-fixture.html`)
  await page.waitForFunction(
    () => Boolean((window as unknown as { runHostSyncGenerationAudit?: unknown }).runHostSyncGenerationAudit),
    null,
    { timeout: 30_000 },
  )
  return (await page.evaluate(
    async () => await (window as unknown as { runHostSyncGenerationAudit: () => Promise<AuditReport> }).runHostSyncGenerationAudit(),
  )) as AuditReport
}

describe('host-sync generation real-Worker cross-round-trip', () => {
  beforeAll(async () => {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root,
      stdio: 'ignore',
    })
    for (let attempt = 0; ; attempt++) {
      if (server.exitCode !== null) throw new Error(`Vite exited: ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) break
      } catch {
        /* waiting for Vite */
      }
      if (attempt === 100) throw new Error('Vite did not start')
      await Bun.sleep(100)
    }
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('tracks host generations across the real Worker round trip without feedback resets', async () => {
    const context: BrowserContext = await browser!.newContext()
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      )
      const page = await context.newPage()
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      const report = await runAudit(page)
      const phases = report.phases
      console.log(`[host-sync-gen] phases ${JSON.stringify(phases).slice(0, 12000)}`)
      expect(report.errors).toEqual([])
      expect(pageErrors).toEqual([])

      const first = phases.firstSync as { attached: boolean; hostGenAfterReady: number; workerGenAtReady: number }
      expect(first.attached).toBe(true)
      expect(first.hostGenAfterReady).toBe((phases.replacementReset as { hostGen1: number }).hostGen1)

      const feedback = phases.feedbackGuard as { hostGenEquals1: boolean }
      expect(feedback.hostGenEquals1).toBe(true)

      const bump = phases.structuralBump as { ok: boolean; bumpedOnce: boolean; hostGenStill1: boolean }
      expect(bump.ok).toBe(true)
      expect(bump.bumpedOnce).toBe(true)
      expect(bump.hostGenStill1).toBe(true)

      const flag = phases.greenFlagOnce as {
        ran: boolean
        singleHat: boolean
        singleHatAfterResync: boolean
        workerGenUnchangedByResync: boolean
        varMonotonicByResync: boolean
        hostGenStill1: boolean
      }
      expect(flag.ran).toBe(true)
      expect(flag.singleHat).toBe(true)
      expect(flag.singleHatAfterResync).toBe(true)
      expect(flag.workerGenUnchangedByResync).toBe(true)
      expect(flag.varMonotonicByResync).toBe(true)
      expect(flag.hostGenStill1).toBe(true)

      const stale = phases.staleSelectionOnly as {
        ok: boolean
        monotonic: boolean
        running: boolean
        workerGenUnchanged: boolean
        hostGenStill1: boolean
      }
      expect(stale.ok).toBe(true)
      expect(stale.monotonic).toBe(true)
      expect(stale.running).toBe(true)
      expect(stale.workerGenUnchanged).toBe(true)
      expect(stale.hostGenStill1).toBe(true)

      const noReset = phases.noFeedbackReset as { ok: boolean; workerGenUnchanged: boolean; running: boolean }
      expect(noReset.ok).toBe(true)
      expect(noReset.workerGenUnchanged).toBe(true)
      expect(noReset.running).toBe(true)

      const bytes = phases.userBytes as { ok: boolean }
      expect(bytes.ok).toBe(true)

      const dup = phases.doubleCommit as { ok: boolean; bumpedOnceTotal: boolean }
      expect(dup.ok).toBe(true)
      expect(dup.bumpedOnceTotal).toBe(true)

      const clone = phases.cloneRepoint as { cloned: boolean; cloneCount: number; cloneBlocksEqualOwner: boolean }
      expect(clone.cloned).toBe(true)
      expect(clone.cloneCount).toBe(1)
      expect(clone.cloneBlocksEqualOwner).toBe(true)

      const bwait = phases.broadcastWait as { started: boolean; settled: boolean }
      expect(bwait.started).toBe(true)
      expect(bwait.settled).toBe(true)

      const reload = phases.replacementReset as {
        advanced: boolean
        ok: boolean
        workerRunningAfter: boolean
        workerThreadsAfter: number
        adoptedMd5: boolean
        reloadedRan: boolean
        timerReset: boolean
      }
      expect(reload.advanced).toBe(true)
      expect(reload.ok).toBe(true)
      expect(reload.workerRunningAfter).toBe(false)
      expect(reload.workerThreadsAfter).toBe(0)
      expect(reload.adoptedMd5).toBe(true)
      expect(reload.reloadedRan).toBe(true)
      expect(reload.timerReset).toBe(true)

      const staleDrop = phases.staleSyncIdDrop as {
        posted: boolean
        workerMd5StillReload: boolean
        workerGenUnchanged: boolean
        noCrash: boolean
      }
      expect(staleDrop.posted).toBe(true)
      expect(staleDrop.workerMd5StillReload).toBe(true)
      expect(staleDrop.workerGenUnchanged).toBe(true)
      expect(staleDrop.noCrash).toBe(true)

      const staleFlag = phases.staleFlagDrop as { posted: boolean; workerMd5StillReload: boolean; noCrash: boolean }
      expect(staleFlag.posted).toBe(true)
      expect(staleFlag.workerMd5StillReload).toBe(true)
      expect(staleFlag.noCrash).toBe(true)
      await page.close()
    } finally {
      await context.close()
    }
  }, 240_000)
})
