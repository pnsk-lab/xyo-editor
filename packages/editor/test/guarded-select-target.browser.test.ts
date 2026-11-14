import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Independent audit: guardedSelectTarget's eager `runtimeWorker.sync(vm.snapshot())`
// fence + pre-swap cancel/drain vs worker-bridge host-authority semantics.
//
// Two real-code harnesses (no mocks for the bridge):
//  A. bridge fixture: real ScratchVM (host) + real RuntimeWorkerController +
//     real runtime.worker.ts Worker, replicating Editor.svelte's
//     applyWorkerRuntimeSnapshot + the exact fence line
//     (`vm.selectTarget(name)` then `runtimeWorker.sync(vm.snapshot())`).
//     The fixture records RAW worker snapshots per event, so worker-side
//     selection / running / threads / positions / clones are observed.
//  B. editor fixture: the real App/Editor; sprite cards drive the REAL
//     guardedSelectTarget (pre-swap cancel/drain + fence); a test plugin
//     performs external (plugin-style) VM writes.
//
// Expected behaviors pinned here (genuine regressions fail loudly):
//  - selection swap is honored by the worker and never reverted by stale
//    in-flight WORKER_SYNC/RUNTIME_STEP frames;
//  - running execution is preserved across selection-only syncs (no lost
//    runtime progression: positions/variables keep advancing, threads kept);
//  - rapid A->B->A ends on the last request (no stuck selection);
//  - cancels are independent per entry target (no cross-target clobbering);
//  - host pending block edits and external asset writes reach the worker;
//  - project reload with reused ids works; sync with no worker never throws
//    out of the guarded path (selection still swaps).
const root = join(import.meta.dir, '..')
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

function svgBytes(width: number, height: number, color: string): Uint8Array {
  return strToU8(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${color}"/></svg>`,
  )
}

async function freePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate test port')
  const port = address.port
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())))
  return port
}

function editorProject(variant: 'v1' | 'v2') {
  const costumeA = svgBytes(120, 90, '#e11d48')
  const costumeB = svgBytes(40, 30, '#2563eb')
  const md5A = `${md5(costumeA)}.svg`
  const md5B = `${md5(costumeB)}.svg`
  const blocksA =
    variant === 'v1'
      ? {
          flag: { opcode: 'event_whenflagclicked', next: 'clone', parent: null, inputs: {}, fields: {}, topLevel: true, x: 10, y: 10 },
          clone: { opcode: 'control_create_clone_of', next: 'loop', parent: 'flag', inputs: { CLONE_OPTION: [1, [10, '_myself_']] }, fields: {} },
          loop: { opcode: 'control_forever', next: null, parent: 'clone', inputs: { SUBSTACK: [2, 'move'] }, fields: {} },
          move: { opcode: 'motion_changexby', next: 'bump', parent: 'loop', inputs: { DX: [1, [4, '2']] }, fields: {} },
          bump: { opcode: 'data_changevariableby', next: null, parent: 'move', inputs: { VALUE: [1, [4, '1']] }, fields: { VARIABLE: ['score', 'var-score'] } },
          hat: { opcode: 'control_start_as_clone', next: 'cmove', parent: null, inputs: {}, fields: {}, topLevel: true, x: 200, y: 30 },
          cmove: { opcode: 'motion_changexby', next: null, parent: 'hat', inputs: { DX: [1, [4, '1']] }, fields: {} },
        }
      : {
          flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, topLevel: true, x: 10, y: 10 },
          set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, 'RELOADED']] }, fields: { VARIABLE: ['score', 'var-score'] } },
        }
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        costumes: [
          {
            name: 'backdrop',
            dataFormat: 'svg',
            assetId: md5A,
            md5ext: md5A,
            rotationCenterX: 240,
            rotationCenterY: 180,
          },
        ],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
      {
        isStage: false,
        name: 'MoverA',
        variables: { 'var-score': ['score', '0'] },
        lists: {},
        broadcasts: {},
        blocks: blocksA,
        costumes: [
          {
            name: 'costumeA',
            dataFormat: 'svg',
            assetId: md5A,
            md5ext: md5A,
            rotationCenterX: 60,
            rotationCenterY: 45,
          },
        ],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 1,
        x: 0,
        y: 0,
      },
      {
        isStage: false,
        name: 'MoverB',
        variables: { 'var-other': ['other', '0'] },
        lists: {},
        broadcasts: {},
        blocks: {
          flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, topLevel: true, x: 10, y: 10 },
          set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, 'B-RAN']] }, fields: { VARIABLE: ['other', 'var-other'] } },
        },
        costumes: [
          {
            name: 'costumeB',
            dataFormat: 'svg',
            dataFormat2: undefined,
            assetId: md5B,
            md5ext: md5B,
            rotationCenterX: 20,
            rotationCenterY: 15,
          },
        ],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 2,
        x: 0,
        y: 0,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
  const files: Record<string, Uint8Array> = { [md5A]: costumeA, [md5B]: costumeB }
  return { archive: Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files })), md5A, md5B }
}

async function snapshotOf(page: Page) {
  return (await page.evaluate(() => (window as unknown as { __hikkakuEditorTest: { snapshot: () => never } }).__hikkakuEditorTest.snapshot())) as unknown as {
    project: {
      targets: Array<{
        id?: string
        name: string
        isStage?: boolean
        isClone?: boolean
        x?: number
        variables?: Record<string, [string, string]>
        costumes?: Array<{ name: string; md5ext?: string; dataFormat?: string }>
        currentCostume?: number
      }>
    }
    selectedTargetId: string
    running: boolean
    threads: Array<{ status: string }>
  }
}

async function selectedName(page: Page): Promise<string> {
  const snap = await snapshotOf(page)
  const hit = snap.project.targets.find((target) => (target.id ?? target.name) === snap.selectedTargetId)
  return hit?.name ?? ''
}

async function varOf(page: Page, targetName: string, varName: string): Promise<string> {
  const snap = await snapshotOf(page)
  const target = snap.project.targets.find((t) => t.name === targetName && !t.isClone)
  const entry = target?.variables ? Object.entries(target.variables).find(([, record]) => record[0] === varName) : undefined
  return entry ? String(entry[1][1]) : ''
}

async function xOf(page: Page, targetName: string): Promise<number | undefined> {
  const snap = await snapshotOf(page)
  return snap.project.targets.find((t) => t.name === targetName && !t.isClone)?.x
}

describe('guardedSelectTarget worker-bridge audit (real browser, real worker+VM)', () => {
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
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('bridge: selection fence keeps worker selection, running, threads, clones and progression', async () => {
    const context = await browser!.newContext()
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      )
      const page = await context.newPage()
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      await page.goto(`${base}/test/guarded-select-target-fixture.html`)
      await page.waitForFunction(() => Boolean((window as unknown as { runGuardedSelectAudit?: unknown }).runGuardedSelectAudit), null, { timeout: 30_000 })
      const report = (await page.evaluate(async () => await (window as unknown as { runGuardedSelectAudit: () => Promise<never> }).runGuardedSelectAudit())) as unknown as { phases: Record<string, Record<string, unknown>>; errors: unknown[] }
      const phases = report.phases
      console.log(`[guarded-select] bridge report ${JSON.stringify(phases).slice(0, 8000)}`)
      console.log(`[guarded-select] bridge trail ${JSON.stringify((report as unknown as { trail: unknown }).trail)}`)
      expect(report.errors).toEqual([])
      const setup = phases.setup as unknown as { idA: string; idB: string }
      expect(phases.attached).toEqual({ workerMode: true })

      const steady = phases.steadyRun as unknown as { ok: boolean; workerThreads: number; workerClones: string[]; boundsBaselineA: unknown; boundsBaselineB: unknown }
      expect(steady.ok).toBe(true)
      expect(steady.workerThreads).toBeGreaterThan(0)

      const flagRace = phases.flagRace as unknown as Array<{ runningStarted: boolean; workerSelected: string; wantId: string; workerThreads: number }>
      expect(flagRace.length).toBe(3)
      for (const round of flagRace) {
        expect(round.runningStarted).toBe(true)
        expect(round.workerSelected).toBe(round.wantId)
        expect(round.workerThreads).toBeGreaterThan(0)
      }

      const fence = phases.fenceSync as unknown as {
        ok: boolean
        workerSelected: string
        workerRunning: boolean
        threadsPreserved: boolean
        rewound: boolean
        rewindDelta: number
        clonesLost: string[]
        varRewound: boolean
        hostSelectedStable: boolean
        progressionAfterFence: Array<number | undefined>
        latestX: number
        xAtSync: number
      }
      expect(fence.ok).toBe(true)
      expect(fence.workerSelected).toBe(setup.idB)
      expect(fence.workerRunning).toBe(true)
      expect(fence.threadsPreserved).toBe(true)
      expect(fence.hostSelectedStable).toBe(true)
      // No lost runtime progression across the fence: worker-side motion and
      // variable values must not move backwards through the selection sync,
      // and the program must keep advancing afterwards.
      expect(fence.rewound).toBe(false)
      expect(fence.varRewound).toBe(false)
      expect(fence.clonesLost).toEqual([])
      const advanced = fence.progressionAfterFence.filter((x): x is number => typeof x === 'number')
      expect(advanced.length).toBeGreaterThan(0)
      expect(Math.max(...advanced)).toBeGreaterThan(fence.xAtSync)

      const stale = phases.staleFence as unknown as { ok: boolean; running: boolean }
      expect(stale.ok).toBe(true)
      expect(stale.running).toBe(true)

      const pending = phases.pendingEdit as unknown as { ok: boolean; workerSelectedKept: boolean; progressionSurvived: boolean; threadsAfterEdit: number }
      expect(pending.ok).toBe(true)
      expect(pending.workerSelectedKept).toBe(true)
      expect(pending.progressionSurvived).toBe(true)

      const asset = phases.externalAssetWrite as unknown as { ok: boolean; boundsB: { width: number; height: number } | null; workerSelectedKept: boolean; progressionSurvived: boolean }
      expect(asset.ok).toBe(true)
      expect(asset.workerSelectedKept).toBe(true)
      expect(asset.progressionSurvived).toBe(true)
      expect(asset.boundsB).not.toBeNull()
      expect(Math.abs((asset.boundsB?.width ?? 0) - 200)).toBeLessThan(2)
      expect(Math.abs((asset.boundsB?.height ?? 0) - 40)).toBeLessThan(2)

      const reload = phases.reloadReusedIds as unknown as { ok: boolean; workerSelected: string; reloadedVar: string }
      expect(reload.ok).toBe(true)
      expect(reload.workerSelected).toBe(setup.idA)
      expect(reload.reloadedVar).toBe('RELOADED')

      const dispose = phases.syncAfterDispose as unknown as { threw: string | null; ok: boolean }
      expect(dispose.threw).toBeNull()
      expect(dispose.ok).toBe(true)
      await page.close()
    } finally {
      await context.close()
    }
  }, 120_000)

  it('editor: real guardedSelectTarget keeps selection, running and progression', async () => {
    const context = await browser!.newContext()
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      )
      const page = await context.newPage()
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      await page.goto(`${base}/test/guarded-select-target-editor-fixture.html`)
      await page.getByTestId('stage-canvas').waitFor({ timeout: 30_000 })
      await page.getByTestId('main-tab-plugin:select-audit-probe/audit-probe').click()
      await page.getByTestId('audit-probe-ready').waitFor({ state: 'attached', timeout: 30_000 })

      const { archive } = editorProject('v1')
      await page.getByTestId('project-file-input').setInputFiles({ name: 'select-audit.sb3', mimeType: 'application/x.scratch.sb3', buffer: archive })
      await page.waitForFunction(
        () => (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ name: string }> } } } }).__hikkakuEditorTest?.snapshot()?.project.targets.some((t) => t.name === 'MoverA'),
        null,
        { timeout: 30_000 },
      )
      expect(await selectedName(page)).toBe('MoverA')

      // Green flag must run on the worker (host threads stay empty there).
      await page.getByRole('button', { name: 'Green flag' }).click()
      await page.waitForFunction(() => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status() === 'Running', null, { timeout: 30_000 })
      const workerMode = await page.evaluate(() => {
        const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { running: boolean; threads: unknown[] } } }).__hikkakuEditorTest.snapshot()
        return snap.running === true && snap.threads.length === 0
      })
      expect(workerMode).toBe(true)

      // Let the program progress, then switch selection via the real UI path.
      await page.waitForFunction(
        () => {
          const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ name: string; x?: number }> } } } }).__hikkakuEditorTest.snapshot()
          return (snap.project.targets.find((t) => t.name === 'MoverA')?.x ?? 0) > 30
        },
        null,
        { timeout: 30_000 },
      )
      const xBefore = (await xOf(page, 'MoverA')) ?? 0
      const varBefore = Number(await varOf(page, 'MoverA', 'score'))
      await page.getByTestId('target-card-MoverB').click()
      await page.waitForFunction(
        () => {
          const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { selectedTargetId: string; project: { targets: Array<{ id?: string; name: string }> } } } }).__hikkakuEditorTest.snapshot()
          return snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId)?.name === 'MoverB'
        },
        null,
        { timeout: 30_000 },
      )
      // Quiescence: WORKER_SYNC round trip + stray in-flight frames.
      await page.waitForTimeout(1500)
      expect(await selectedName(page)).toBe('MoverB')
      const statusAfter = await page.evaluate(() => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status())
      expect(statusAfter).toBe('Running')
      // No lost runtime progression: MoverA keeps moving and counting while
      // MoverB is selected.
      const xAfter = (await xOf(page, 'MoverA')) ?? 0
      const varAfter = Number(await varOf(page, 'MoverA', 'score'))
      expect(xAfter).toBeGreaterThan(xBefore)
      expect(varAfter).toBeGreaterThan(varBefore)
      const cloneCount = (await snapshotOf(page)).project.targets.filter((t) => t.isClone).length
      expect(cloneCount).toBeGreaterThan(0)

      // Stale-sync fence under a pending structural sync: rename a costume
      // (structural change -> host sync in flight), then immediately switch.
      // The older in-flight WORKER_SYNC must not revert the new selection.
      await page.evaluate(() => {
        const probe = (window as unknown as { __auditProbe: { view: { vm: { renameCostume: (t: string, i: number, n: string) => void } } } }).__auditProbe
        probe.view.vm.renameCostume('MoverA', 0, 'renamedA')
      })
      await page.getByTestId('target-card-MoverA').click()
      await page.waitForFunction(
        () => {
          const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { selectedTargetId: string; project: { targets: Array<{ id?: string; name: string }> } } } }).__hikkakuEditorTest.snapshot()
          return snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId)?.name === 'MoverA'
        },
        null,
        { timeout: 30_000 },
      )
      await page.waitForTimeout(1500)
      expect(await selectedName(page)).toBe('MoverA')

      // Rapid sequential switches: last request wins, no stuck selection.
      await page.getByTestId('target-card-MoverB').click()
      await page.getByTestId('target-card-MoverA').click()
      await page.getByTestId('target-card-MoverB').click()
      await page.waitForTimeout(1200)
      expect(await selectedName(page)).toBe('MoverB')

      // Same-task double dispatch: two guarded switches without an
      // interleaving task. Both capture the same entry target; the last
      // request must still win.
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="target-card-MoverB"]') as HTMLElement
        const a = document.querySelector('[data-testid="target-card-MoverA"]') as HTMLElement
        b.click()
        a.click()
      })
      await page.waitForTimeout(1200)
      expect(await selectedName(page)).toBe('MoverA')
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="target-card-MoverB"]') as HTMLElement
        const a = document.querySelector('[data-testid="target-card-MoverA"]') as HTMLElement
        a.click()
        b.click()
      })
      await page.waitForTimeout(1200)
      expect(await selectedName(page)).toBe('MoverB')

      // External plugin-style asset write on the non-selected target, then
      // switch to it: the worker must adopt the new bytes for the selection.
      const greenSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><rect width="200" height="40" fill="#16a34a"/></svg>`
      const md5After = await page.evaluate(async (svg: string) => {
        const probe = (window as unknown as { __auditProbe: { view: { vm: { updateCostume: (t: string, i: number, p: unknown, d: Uint8Array) => Promise<void> } } } }).__auditProbe
        await probe.view.vm.updateCostume('MoverA', 0, {}, new TextEncoder().encode(svg))
        const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ name: string; costumes: Array<{ md5ext?: string }> }> } } } }).__hikkakuEditorTest.snapshot()
        return snap.project.targets.find((t) => t.name === 'MoverA')?.costumes[0]?.md5ext ?? null
      }, greenSvg)
      expect(md5After).not.toBeNull()
      await page.getByTestId('target-card-MoverA').click()
      await page.waitForTimeout(1500)
      expect(await selectedName(page)).toBe('MoverA')
      const md5Selected = await page.evaluate(() => {
        const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ name: string; costumes: Array<{ md5ext?: string }>; currentCostume?: number }> }; selectedTargetId: string } } }).__hikkakuEditorTest.snapshot()
        const target = snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId)
        return target?.costumes[target?.currentCostume ?? 0]?.md5ext ?? null
      })
      expect(md5Selected).toBe(md5After)

      // Same-name alias probe (last: duplicate names may confuse the UI).
      // Stable-id selection must still resolve the exact target.
      // VM semantics: public `renameSprite`/`addSprite`/`importSprite` never
      // create duplicate display names (`renameSprite` returns false,
      // adds dedupe via `uniqueSpriteName`). Duplicates only arise from
      // loaded SB3 data (`normalizeProject` preserves them) or direct
      // live-target mutation outside the guarded API scope. The probe below
      // asserts the guard first, then simulates an SB3-loaded duplicate via
      // direct mutation and keeps the strict stable-id assertions.
      const renameRejected = await page.evaluate(() => {
        const probe = (window as unknown as { __auditProbe: { view: { vm: { renameSprite: (a: string, b: string) => boolean } } } }).__auditProbe
        return probe.view.vm.renameSprite('MoverB', 'MoverA')
      })
      expect(renameRejected).toBe(false)
      const dupes = await page.evaluate(() => {
        const probe = (window as unknown as { __auditProbe: { view: { vm: { getTarget: (id: string) => { name: string } | undefined } } } }).__auditProbe
        const snapOf = () => (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ id?: string; name: string; isClone?: boolean }> } } } }).__hikkakuEditorTest.snapshot()
        const before = snapOf()
        const targetA = before.project.targets.find((t) => t.name === 'MoverA' && !t.isClone)
        const targetB = before.project.targets.find((t) => t.name === 'MoverB' && !t.isClone)
        if (targetA && targetB) {
          const liveB = probe.view.vm.getTarget(targetB.id ?? targetB.name)
          if (liveB) liveB.name = targetA.name
        }
        return snapOf().project.targets.filter((t) => t.name === 'MoverA' && !t.isClone).map((t) => t.id ?? t.name)
      })
      expect(dupes.length).toBe(2)
      await page.evaluate((id: string) => {
        const probe = (window as unknown as { __auditProbe: { view: { vm: { selectTarget: (v: string) => void } } } }).__auditProbe
        probe.view.vm.selectTarget(id)
      }, dupes[1] as string)
      await page.waitForTimeout(500)
      const selectedAfterAlias = (await snapshotOf(page)).selectedTargetId
      expect(selectedAfterAlias).toBe(dupes[1])

      expect(pageErrors).toEqual([])
      await page.close()

      // Reload with reused ids: fresh page, v2 project, new behavior runs.
      const page2 = await context.newPage()
      const page2Errors: string[] = []
      page2.on('pageerror', (error) => page2Errors.push(String(error)))
      await page2.goto(`${base}/test/guarded-select-target-editor-fixture.html`)
      await page2.getByTestId('stage-canvas').waitFor({ timeout: 30_000 })
      const v2 = editorProject('v2')
      await page2.getByTestId('project-file-input').setInputFiles({ name: 'select-audit-v2.sb3', mimeType: 'application/x.scratch.sb3', buffer: v2.archive })
      await page2.waitForFunction(
        () => (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ name: string }> } } } }).__hikkakuEditorTest?.snapshot()?.project.targets.some((t) => t.name === 'MoverA'),
        null,
        { timeout: 30_000 },
      )
      await page2.getByRole('button', { name: 'Green flag' }).click()
      await page2.waitForFunction(
        () => {
          const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ name: string; variables?: Record<string, [string, string]> }> } } } }).__hikkakuEditorTest.snapshot()
          const target = snap.project.targets.find((t) => t.name === 'MoverA')
          return target?.variables ? Object.values(target.variables).some((record) => record[1] === 'RELOADED') : false
        },
        null,
        { timeout: 30_000 },
      )
      await page2.getByTestId('target-card-MoverB').click()
      await page2.waitForTimeout(800)
      const selectedV2 = await page2.evaluate(() => {
        const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => { selectedTargetId: string; project: { targets: Array<{ id?: string; name: string }> } } } }).__hikkakuEditorTest.snapshot()
        return snap.project.targets.find((t) => (t.id ?? t.name) === snap.selectedTargetId)?.name ?? ''
      })
      expect(selectedV2).toBe('MoverB')
      expect(page2Errors).toEqual([])
      await page2.close()
    } finally {
      await context.close()
    }
  }, 180_000)
})
