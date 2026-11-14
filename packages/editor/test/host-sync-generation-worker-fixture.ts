import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import { RuntimeWorkerController } from '../src/lib/runtime-worker'

/**
 * Real-Worker host-sync generation cross-round-trip fixture.
 *
 * Real code on both ends: a real ScratchVM host, the real
 * RuntimeWorkerController and the real runtime.worker.ts Worker. The
 * host-side frame application mirrors Editor.svelte
 * `applyWorkerRuntimeSnapshot` exactly (runtime-only merge, host selection
 * wins except on WORKER_READY/WORKER_SYNC).
 *
 * Covers the generation repair: incoming host generations tracked as
 * `appliedHostGeneration` on the worker, same-generation structural merges
 * bumping only the worker-local `projectGeneration`, worker frames back
 * never feeding the worker generation into host identity, and reloads with
 * reused ids still resetting via `appliedHostGeneration` even when the
 * worker-local generation already numerically equals the new host one.
 */

type GenProbe = {
  event: string
  at: number
  workerGen: number
  selectedTargetId: string
  running: boolean
  threads: number
  topBlocks: string[]
  x?: number
  flagVar?: string
  clones: number
  cloneBlocksEqualOwner?: boolean
  costumeMd5?: string
  blockKeys: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function probeOf(snapshot: Record<string, unknown>, event: string, tid: string): GenProbe {
  const project = (snapshot.project ?? {}) as {
    targets?: Array<{
      id?: string
      isClone?: boolean
      cloneOf?: string
      x?: number
      variables?: Record<string, [string, string]>
      costumes?: Array<{ md5ext?: string }>
      blocks?: Record<string, { opcode?: string } | unknown>
    }>
  }
  const targets = project.targets ?? []
  const owner = targets.find((t) => !t.isClone && t.id === tid)
  const clones = targets.filter((t) => t.isClone)
  const threads = (Array.isArray(snapshot.threads) ? snapshot.threads : []) as Array<{ topBlockId?: string }>
  const ownerBlocks = owner?.blocks
  const varEntry = owner?.variables
    ? Object.entries(owner.variables).find(([, record]) => record[0] === 'flag-var')
    : undefined
  return {
    event,
    at: Date.now(),
    workerGen: typeof snapshot.projectGeneration === 'number' ? snapshot.projectGeneration : -1,
    selectedTargetId: String((snapshot as { selectedTargetId?: unknown }).selectedTargetId ?? ''),
    running: Boolean(snapshot.running),
    threads: threads.length,
    topBlocks: threads.map((t) => String(t.topBlockId ?? '')),
    x: typeof owner?.x === 'number' ? owner.x : undefined,
    flagVar: varEntry ? String(varEntry[1][1]) : undefined,
    clones: clones.length,
    cloneBlocksEqualOwner:
      clones.length > 0 && ownerBlocks
        ? clones.every((c) => JSON.stringify((c as { blocks?: unknown }).blocks ?? {}) === JSON.stringify(ownerBlocks))
        : undefined,
    costumeMd5: owner?.costumes?.[0] ? String(owner.costumes[0].md5ext ?? '') : undefined,
    blockKeys: ownerBlocks ? Object.keys(ownerBlocks).sort() : [],
  }
}

async function waitForFrom(
  log: GenProbe[],
  fromIndex: number,
  predicate: (probe: GenProbe) => boolean,
  timeoutMs: number,
): Promise<GenProbe | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = log.slice(fromIndex).find(predicate)
    if (hit) return hit
    if (Date.now() > deadline) return undefined
    await sleep(50)
  }
}

const enc = new TextEncoder()
const svgDoc = (label: string, color: string) =>
  enc.encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${color}"/><text>${label}</text></svg>`,
  )

function moverBlocks(variableId: string): Record<string, unknown> {
  return {
    flag: { opcode: 'event_whenflagclicked', next: 'loop', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
    loop: { opcode: 'control_forever', next: null, parent: 'flag', inputs: { SUBSTACK: [2, 'move'] }, fields: {}, shadow: false, topLevel: false },
    move: { opcode: 'motion_changexby', next: 'bump', parent: 'loop', inputs: { DX: [1, [4, '3']] }, fields: {}, shadow: false, topLevel: false },
    bump: { opcode: 'data_changevariableby', next: null, parent: 'move', inputs: { VALUE: [1, [4, '1']] }, fields: { VARIABLE: ['flag-var', variableId] }, shadow: false, topLevel: false },
  }
}

function oneShotBlocks(variableId: string, value: string): Record<string, unknown> {
  return {
    flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
    set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, value]] }, fields: { VARIABLE: ['flag-var', variableId] }, shadow: false, topLevel: false },
  }
}

function timerBlocks(variableId: string): Record<string, unknown> {
  return {
    flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
    set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [3, 'tmr'] }, fields: { VARIABLE: ['flag-var', variableId] }, shadow: false, topLevel: false },
    tmr: { opcode: 'sensing_timer', next: null, parent: null, inputs: {}, fields: {}, shadow: true, topLevel: false },
  }
}

;(window as unknown as { runHostSyncGenerationAudit?: () => Promise<Record<string, unknown>> }).runHostSyncGenerationAudit = async () => {
  const report: Record<string, unknown> = { phases: {} }
  const phases = report.phases as Record<string, unknown>
  const workerLog: GenProbe[] = []
  const errors: unknown[] = []
  const host = new ScratchVM()
  host.loadProject(createDefaultProject())
  const tid = host.getSprites()[0]!.id as string
  const hostGen1 = host.getProjectGeneration()
  // Motion + counter script: x and the flag-var advance monotonically while
  // the worker runs, so stale-frame rewinds are observable.
  host.getTarget(tid)!.variables = { 'v-flag': ['flag-var', '0'] }
  host.getTarget(tid)!.blocks = moverBlocks('v-flag') as never

  const canvas = document.querySelector('#stage') as HTMLCanvasElement
  let hostSnapshot = host.snapshot()
  const applyWorkerRuntimeSnapshot = (next: Record<string, unknown>, event = '') => {
    const merged =
      event === 'WORKER_READY' || event === 'WORKER_SYNC'
        ? next
        : { ...next, selectedTargetId: (hostSnapshot as unknown as { selectedTargetId: string }).selectedTargetId }
    host.applyRuntimeSnapshot(merged as never, { cloneProject: false })
    hostSnapshot = host.snapshot()
  }
  const controller = new RuntimeWorkerController(
    host as never,
    (next, event) => {
      workerLog.push(probeOf(next as unknown as Record<string, unknown>, event, tid))
      if (workerLog.length > 800) workerLog.splice(0, workerLog.length - 800)
      applyWorkerRuntimeSnapshot(next as unknown as Record<string, unknown>, event)
    },
    (message) => {
      errors.push(message)
    },
  )
  try {
    // --- G0: first host sync (attach) records the host generation ---------
    const attached = controller.attachCanvas(canvas as never, host.snapshot() as never)
    const ready = await waitForFrom(workerLog, 0, (p) => p.event === 'WORKER_READY', 15000)
    const workerGenAtReady = ready?.workerGen
    phases.firstSync = {
      attached,
      hostGen1,
      hostGenAfterReady: host.getProjectGeneration(),
      workerGenAtReady,
      readySelected: ready?.selectedTargetId,
      hostSelected: host.snapshot().selectedTargetId,
    }

    // Worker frame back must not adopt the worker generation as host identity.
    phases.feedbackGuard = {
      hostGenStill: host.getProjectGeneration(),
      hostGenEquals1: host.getProjectGeneration() === hostGen1,
    }

    // --- G1: same-generation structural edit bumps worker-local only ------
    host.getTarget(tid)!.blocks = {
      ...moverBlocks('v-flag'),
      extra: { opcode: 'control_wait', next: null, parent: null, inputs: { DURATION: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: true, x: 90, y: 90 },
    } as never
    const g1Mark = workerLog.length
    await controller.sync(host.snapshot() as never)
    const g1Synced = await waitForFrom(workerLog, g1Mark, (p) => p.event === 'WORKER_SYNC' && p.blockKeys.includes('extra'), 15000)
    phases.structuralBump = {
      ok: Boolean(g1Synced),
      workerGenBefore: workerGenAtReady,
      workerGenAfter: g1Synced?.workerGen,
      bumpedOnce: g1Synced && workerGenAtReady !== undefined ? g1Synced.workerGen === workerGenAtReady + 1 : false,
      hostGenStill1: host.getProjectGeneration() === hostGen1,
    }

    // --- G2: greenFlag runs the new code exactly once (no duplicate hats) --
    controller.greenFlag()
    const ran = await waitForFrom(workerLog, workerLog.length, (p) => p.running && p.threads > 0, 15000)
    await sleep(1200)
    const afterRun = workerLog[workerLog.length - 1]!
    const hatThreads = afterRun.topBlocks.filter((id) => id === 'flag').length
    const varAfterRun = afterRun.flagVar
    // A further selection-only sync must not re-run the hat.
    const g2Mark = workerLog.length
    await controller.sync(host.snapshot() as never)
    const g2Synced = await waitForFrom(workerLog, g2Mark, (p) => p.event === 'WORKER_SYNC', 15000)
    await sleep(600)
    const afterResync = workerLog[workerLog.length - 1]!
    phases.greenFlagOnce = {
      ran: Boolean(ran),
      hatThreads,
      singleHat: hatThreads === 1,
      varAfterRun,
      workerGenUnchangedByResync: g2Synced?.workerGen === afterRun.workerGen,
      threadsAfterResync: afterResync.threads,
      singleHatAfterResync: afterResync.threads === 1,
      varMonotonicByResync:
        varAfterRun !== undefined && afterResync.flagVar !== undefined
          ? Number(afterResync.flagVar) >= Number(varAfterRun)
          : false,
      hostGenStill1: host.getProjectGeneration() === hostGen1,
    }

    // --- G3: stale selection-only frame never rewinds x (monotonic) --------
    const staleSnap = host.snapshot()
    const staleX = (staleSnap.project.targets.find((t) => t.id === tid) as { x?: number } | undefined)?.x ?? 0
    await sleep(1200)
    const preStale = workerLog[workerLog.length - 1]!
    const staleMark = workerLog.length
    await controller.sync(staleSnap as never)
    const staleSynced = await waitForFrom(workerLog, staleMark, (p) => p.event === 'WORKER_SYNC', 15000)
    phases.staleSelectionOnly = {
      ok: Boolean(staleSynced),
      staleHostX: staleX,
      workerXBefore: preStale.x,
      workerXAtSync: staleSynced?.x,
      monotonic: staleSynced && preStale.x !== undefined && staleSynced.x !== undefined ? staleSynced.x >= preStale.x : false,
      running: staleSynced?.running,
      threads: staleSynced?.threads,
      workerGenUnchanged: staleSynced?.workerGen === preStale.workerGen,
      hostGenStill1: host.getProjectGeneration() === hostGen1,
    }

    // --- G4: worker frame back still leaves host identity alone ------------
    const hostGenBeforeFrame = host.getProjectGeneration()
    await sleep(400)
    phases.feedbackAfterRun = {
      hostGen: host.getProjectGeneration(),
      unchanged: host.getProjectGeneration() === hostGenBeforeFrame,
      workerGenSeen: workerLog[workerLog.length - 1]?.workerGen,
    }
    // ... and the next host sync does not feedback-reset.
    const g4Mark = workerLog.length
    const g4Before = workerLog[workerLog.length - 1]!
    await controller.sync(host.snapshot() as never)
    const g4Synced = await waitForFrom(workerLog, g4Mark, (p) => p.event === 'WORKER_SYNC', 15000)
    phases.noFeedbackReset = {
      ok: Boolean(g4Synced),
      workerGenUnchanged: g4Synced?.workerGen === g4Before.workerGen,
      running: g4Synced?.running,
      threads: g4Synced?.threads,
    }

    // --- G5: user bytes reach the worker ------------------------------------
    const userBytes = svgDoc('user-art', '#16a34a')
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, userBytes)
    const userMd5 = host.getTarget(tid)!.costumes[0]!.md5ext as string
    const g5Mark = workerLog.length
    await controller.sync(host.snapshot() as never)
    const g5Synced = await waitForFrom(workerLog, g5Mark, (p) => p.event === 'WORKER_SYNC' && p.costumeMd5 === userMd5, 15000)
    phases.userBytes = { ok: Boolean(g5Synced), expectedMd5: userMd5, workerMd5: g5Synced?.costumeMd5 }

    // --- G6: two commits of the same snapshot bump the worker gen once -----
    // Introduce one structural change first so the first commit is structural
    // (+1) and the identical second commit is a selection-only fast path (+0).
    host.getTarget(tid)!.blocks = {
      ...(host.getTarget(tid)!.blocks as Record<string, unknown>),
      extraDbl: { opcode: 'control_wait', next: null, parent: null, inputs: { DURATION: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: true, x: 92, y: 92 },
    } as never
    const sameSnap = host.snapshot()
    const g6GenBase = workerLog[workerLog.length - 1]!.workerGen
    const g6a = workerLog.length
    await controller.sync(sameSnap as never)
    const g6First = await waitForFrom(workerLog, g6a, (p) => p.event === 'WORKER_SYNC', 15000)
    const g6b = workerLog.length
    await controller.sync(sameSnap as never)
    const g6Second = await waitForFrom(workerLog, g6b, (p) => p.event === 'WORKER_SYNC', 15000)
    phases.doubleCommit = {
      ok: Boolean(g6First && g6Second),
      genBase: g6GenBase,
      genFirst: g6First?.workerGen,
      genSecond: g6Second?.workerGen,
      bumpedOnceTotal: g6First && g6Second ? g6Second.workerGen === g6GenBase + 1 : false,
    }

    // --- G7: clone code re-points after a structural edit -------------------
    host.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'clone', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      clone: { opcode: 'control_create_clone_of', next: null, parent: 'flag', inputs: {}, fields: { CLONE_OPTION: ['_myself_', '_myself_'] }, shadow: false, topLevel: false },
    } as never
    await controller.sync(host.snapshot() as never)
    controller.greenFlag()
    const cloned = await waitForFrom(workerLog, workerLog.length, (p) => p.clones === 1, 15000)
    host.getTarget(tid)!.blocks = {
      ...(host.getTarget(tid)!.blocks as Record<string, unknown>),
      extra2: { opcode: 'control_wait', next: null, parent: null, inputs: { DURATION: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: true, x: 91, y: 91 },
    } as never
    const g7Mark = workerLog.length
    await controller.sync(host.snapshot() as never)
    await sleep(800)
    const g7Latest = workerLog[workerLog.length - 1]!
    phases.cloneRepoint = {
      cloned: Boolean(cloned),
      cloneCount: g7Latest.clones,
      cloneBlocksEqualOwner: g7Latest.cloneBlocksEqualOwner,
      blockKeys: g7Latest.blockKeys,
    }

    // --- G8: broadcast-and-wait parent settles after child removal ---------
    host.getTarget(tid)!.variables = { 'v-flag': ['flag-var', '0'] }
    host.getTarget(tid)!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'bwait', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
      bwait: { opcode: 'event_broadcastandwait', next: 'set', parent: 'flag', inputs: { BROADCAST_INPUT: [1, [10, 'go']] }, fields: {}, shadow: false, topLevel: false },
      set: { opcode: 'data_setvariableto', next: null, parent: 'bwait', inputs: { VALUE: [1, [10, 'parent-done']] }, fields: { VARIABLE: ['flag-var', 'v-flag'] }, shadow: false, topLevel: false },
      recv: { opcode: 'event_whenbroadcastreceived', next: 'cwait', parent: null, inputs: {}, fields: { BROADCAST_OPTION: ['go', 'recv'] }, shadow: false, topLevel: true, x: 60, y: 10 },
      cwait: { opcode: 'control_wait', next: null, parent: 'recv', inputs: { DURATION: [1, [4, '3600']] }, fields: {}, shadow: false, topLevel: false },
    } as never
    await controller.sync(host.snapshot() as never)
    controller.greenFlag()
    const bStarted = await waitForFrom(workerLog, workerLog.length, (p) => p.running && p.threads >= 2, 15000)
    const live = host.getTarget(tid)!
    delete (live.blocks as Record<string, unknown>).recv
    delete (live.blocks as Record<string, unknown>).cwait
    const g8Mark = workerLog.length
    await controller.sync(host.snapshot() as never)
    const bSettled = await waitForFrom(
      workerLog,
      g8Mark,
      (p) => !p.running && p.threads === 0 && p.flagVar === 'parent-done',
      15000,
    )
    phases.broadcastWait = { started: Boolean(bStarted), settled: Boolean(bSettled) }

    // --- G9: timer baseline on the old generation --------------------------
    host.getTarget(tid)!.blocks = timerBlocks('v-flag') as never
    await controller.sync(host.snapshot() as never)
    controller.greenFlag()
    const timerOld = await waitForFrom(workerLog, workerLog.length, (p) => p.flagVar !== undefined && p.flagVar !== '0' && p.flagVar !== 'parent-done', 15000)
    const timerOldValue = timerOld ? Number(timerOld.flagVar) : Number.NaN

    // --- G10: host reload, same ids, new generation -> full reset ----------
    const workerGenBeforeReload = workerLog[workerLog.length - 1]!.workerGen
    const reloadArt = svgDoc('reload-art', '#7c3aed')
    await host.updateCostume(tid, 0, { dataFormat: 'svg' }, reloadArt)
    host.getTarget(tid)!.variables = { 'v-flag': ['flag-var', '0'] }
    host.getTarget(tid)!.blocks = oneShotBlocks('v-flag', 'RELOADED') as never
    await host.loadProject(host.exportProject() as never)
    const hostGen2 = host.getProjectGeneration()
    const reloadMd5 = host.getTarget(tid)!.costumes[0]!.md5ext as string
    const g10Mark = workerLog.length
    await controller.sync(host.snapshot() as never)
    const g10Synced = await waitForFrom(
      workerLog,
      g10Mark,
      (p) => p.event === 'WORKER_SYNC' && p.costumeMd5 === reloadMd5,
      15000,
    )
    controller.greenFlag()
    const reloadedRan = await waitForFrom(workerLog, g10Mark, (p) => p.flagVar === 'RELOADED', 15000)
    // Fresh timer on the new generation: strictly less than the old reading.
    host.getTarget(tid)!.blocks = timerBlocks('v-flag') as never
    await controller.sync(host.snapshot() as never)
    controller.greenFlag()
    const timerNew = await waitForFrom(workerLog, workerLog.length, (p) => p.flagVar !== undefined && p.flagVar !== '0' && p.flagVar !== 'RELOADED' && p.flagVar !== 'parent-done', 15000)
    const timerNewValue = timerNew ? Number(timerNew.flagVar) : Number.NaN
    phases.replacementReset = {
      hostGen1,
      hostGen2,
      advanced: hostGen2 !== hostGen1,
      ok: Boolean(g10Synced),
      workerGenBeforeReload,
      workerGenAfter: g10Synced?.workerGen,
      workerRunningAfter: g10Synced?.running,
      workerThreadsAfter: g10Synced?.threads,
      adoptedMd5: g10Synced?.costumeMd5 === reloadMd5,
      reloadedRan: Boolean(reloadedRan),
      timerOld: timerOldValue,
      timerNew: timerNewValue,
      timerReset: Number.isFinite(timerOldValue) && Number.isFinite(timerNewValue) ? timerNewValue < timerOldValue : false,
    }

    // --- G11: stale out-of-order syncId frames never rewind the worker -----
    // Post a stale sync (syncId 1, oldest project) straight at the worker:
    // the worker's syncId guard must drop it before it reaches the VM.
    const workerHandle = (controller as unknown as { worker?: Worker }).worker
    const staleProjectSnap = host.snapshot()
    const g11Mark = workerLog.length
    workerHandle?.postMessage({
      type: 'sync',
      snapshot: { ...staleProjectSnap, project: (staleProjectSnap as unknown as { project: unknown }).project },
      assets: {},
      images: [],
      keepKeys: [],
      syncId: 1,
    })
    await sleep(1200)
    const g11Latest = workerLog[workerLog.length - 1]!
    phases.staleSyncIdDrop = {
      posted: Boolean(workerHandle),
      workerMd5StillReload: g11Latest.costumeMd5 === reloadMd5,
      workerGenUnchanged: g11Latest.workerGen === workerLog[g11Mark - 1]?.workerGen,
      noCrash: errors.length === 0,
    }

    // --- G12: stale greenFlag payload runs without rewinding the project ---
    workerHandle?.postMessage({ type: 'greenFlag', syncId: 1 })
    await sleep(1200)
    const g12Latest = workerLog[workerLog.length - 1]!
    phases.staleFlagDrop = {
      posted: Boolean(workerHandle),
      workerMd5StillReload: g12Latest.costumeMd5 === reloadMd5,
      noCrash: errors.length === 0,
    }
  } finally {
    try {
      controller.dispose()
    } catch {
      // best effort
    }
  }
  const trail = workerLog.slice(-60).map((p) => ({
    e: p.event,
    gen: p.workerGen,
    run: p.running ? 1 : 0,
    th: p.threads,
    x: p.x,
    v: p.flagVar,
    md5: p.costumeMd5,
  }))
  return { ...report, errors, trail }
}
