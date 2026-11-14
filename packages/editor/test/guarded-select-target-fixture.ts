import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import { RuntimeWorkerController } from '../src/lib/runtime-worker'

type WorkerProbe = {
  event: string
  at: number
  selectedTargetId: string
  running: boolean
  threads: number
  threadStatuses: string[]
  xOfA?: number
  varOfA?: string
  clones: string[]
  costumeMd5s: string[]
  blockKeysA: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function moverBlocks(variableId: string): Record<string, unknown> {
  return {
    flag: { opcode: 'event_whenflagclicked', next: 'clone', parent: null, inputs: {}, fields: {}, topLevel: true, x: 10, y: 10 },
    clone: { opcode: 'control_create_clone_of', next: 'loop', parent: 'flag', inputs: { CLONE_OPTION: [1, [10, '_myself_']] }, fields: {} },
    loop: { opcode: 'control_forever', next: null, parent: 'clone', inputs: { SUBSTACK: [2, 'move'] }, fields: {} },
    move: { opcode: 'motion_changexby', next: 'bump', parent: 'loop', inputs: { DX: [1, [4, '2']] }, fields: {} },
    bump: { opcode: 'data_changevariableby', next: null, parent: 'move', inputs: { VALUE: [1, [4, '1']] }, fields: { VARIABLE: ['score', variableId] } },
    hat: { opcode: 'control_start_as_clone', next: 'cmove', parent: null, inputs: {}, fields: {}, topLevel: true, x: 200, y: 30 },
    cmove: { opcode: 'motion_changexby', next: null, parent: 'hat', inputs: { DX: [1, [4, '1']] }, fields: {} },
  }
}

async function buildProject(vm: ScratchVM) {
  const svgA = new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90"><rect width="120" height="90" fill="#e11d48"/></svg>`,
  )
  const svgB = new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30"><rect width="40" height="30" fill="#2563eb"/></svg>`,
  )
  const assetA = await vm.storeAsset(svgA, 'svg')
  const assetB = await vm.storeAsset(svgB, 'svg')
  const project = createDefaultProject()
  const stage = project.targets.find((target) => target.isStage)!
  stage.blocks = {
    flag: { opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, topLevel: true, x: 10, y: 10 },
  }
  const spriteA = project.targets.find((target) => !target.isStage)!
  spriteA.id = 'sprite-A-id'
  spriteA.name = 'MoverA'
  spriteA.x = 0
  spriteA.variables = { 'var-score': ['score', '0'] }
  spriteA.costumes = [
    { name: 'costumeA', assetId: assetA.assetId, md5ext: assetA.md5ext, dataFormat: 'svg', rotationCenterX: 60, rotationCenterY: 45 } as never,
  ]
  spriteA.currentCostume = 0
  spriteA.blocks = moverBlocks('var-score') as never
  const spriteB = structuredClone(spriteA) as typeof spriteA
  spriteB.id = 'sprite-B-id'
  spriteB.name = 'MoverB'
  spriteB.x = 0
  spriteB.variables = { 'var-other': ['other', '0'] }
  spriteB.costumes = [
    { name: 'costumeB', assetId: assetB.assetId, md5ext: assetB.md5ext, dataFormat: 'svg', rotationCenterX: 20, rotationCenterY: 15 } as never,
  ]
  ;(spriteB.blocks as Record<string, unknown>) = {
    flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, topLevel: true, x: 10, y: 10 },
    set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, 'B-RAN']] }, fields: { VARIABLE: ['other', 'var-other'] } },
  }
  project.targets = [stage, spriteA, spriteB]
  return { project, assetA, assetB }
}

function probeOf(snapshot: { threads?: Array<{ status?: string }>; project?: { targets?: Array<{ id?: string; name?: string; isClone?: boolean; x?: number; variables?: Record<string, [string, string]>; costumes?: Array<{ md5ext?: string }> }> } } & Record<string, unknown>, event: string): WorkerProbe {
  const targets = snapshot.project?.targets ?? []
  const a = targets.find((target) => target.id === 'sprite-A-id')
  const varEntry = a?.variables ? Object.entries(a.variables).find(([, record]) => record[0] === 'score') : undefined
  const threads = Array.isArray(snapshot.threads) ? snapshot.threads : []
  return {
    event,
    at: Date.now(),
    selectedTargetId: String((snapshot as { selectedTargetId?: unknown }).selectedTargetId ?? ''),
    running: Boolean((snapshot as { running?: unknown }).running),
    threads: threads.length,
    threadStatuses: threads.map((thread) => String(thread?.status ?? '?')),
    xOfA: typeof a?.x === 'number' ? a.x : undefined,
    varOfA: varEntry ? String(varEntry[1][1]) : undefined,
    clones: targets.filter((target) => target.isClone).map((target) => String(target.id ?? target.name)),
    costumeMd5s: targets.filter((target) => !target.isClone).map((target) => String(target.costumes?.[target.currentCostume as never as number]?.md5ext ?? target.costumes?.[0]?.md5ext ?? '')),
    blockKeysA: Object.keys((targets.find((target) => target.id === 'sprite-A-id') as { blocks?: Record<string, unknown> } | undefined)?.blocks ?? {}),
  }
}

async function waitFor(log: WorkerProbe[], predicate: (probe: WorkerProbe) => boolean, timeoutMs: number, pollMs = 50): Promise<WorkerProbe | undefined> {
  return waitForFrom(log, 0, predicate, timeoutMs, pollMs)
}

async function waitForFrom(log: WorkerProbe[], fromIndex: number, predicate: (probe: WorkerProbe) => boolean, timeoutMs: number, pollMs = 50): Promise<WorkerProbe | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = log.slice(fromIndex).find(predicate)
    if (hit) return hit
    if (Date.now() > deadline) return undefined
    await sleep(pollMs)
  }
}

;(window as unknown as { runGuardedSelectAudit?: () => Promise<Record<string, unknown>> }).runGuardedSelectAudit = async () => {
  const report: Record<string, unknown> = { phases: {} }
  const phases = report.phases as Record<string, unknown>
  const workerLog: WorkerProbe[] = []
  const errors: unknown[] = []
  const host = new ScratchVM()
  const { project, assetA, assetB } = await buildProject(host)
  await host.loadProject(project)
  const idA = host.getTarget('MoverA')!.id as string
  const idB = host.getTarget('MoverB')!.id as string
  phases.setup = { idA, idB, assetA: assetA.md5ext, assetB: assetB.md5ext }

  const canvas = document.querySelector('#stage') as HTMLCanvasElement
  let hostSnapshot = host.snapshot()
  let applyingWorkerSnapshot = false
  const applyWorkerRuntimeSnapshot = (next: Parameters<Parameters<typeof RuntimeWorkerController>[1]>[0], event = '') => {
    // Exact replica of Editor.svelte applyWorkerRuntimeSnapshot: worker ->
    // host frames stay runtime-only; host selection wins for every event
    // except the host-authoritative project syncs (WORKER_READY/WORKER_SYNC).
    const merged = event === 'WORKER_READY' || event === 'WORKER_SYNC' ? next : { ...next, selectedTargetId: hostSnapshot.selectedTargetId }
    applyingWorkerSnapshot = true
    host.applyRuntimeSnapshot(merged as never, { cloneProject: false })
    applyingWorkerSnapshot = false
    hostSnapshot = host.snapshot()
    void applyingWorkerSnapshot
  }
  const controller = new RuntimeWorkerController(
    host as never,
    (next, event) => {
      workerLog.push(probeOf(next as never, event))
      if (workerLog.length > 500) workerLog.splice(0, workerLog.length - 500)
      applyWorkerRuntimeSnapshot(next as never, event)
    },
    (message) => {
      errors.push(message)
    },
  )
  const attached = controller.attachCanvas(canvas as never, host.snapshot() as never)
  phases.attached = { workerMode: attached }
  try {
    // --- S0: green flag, let runtime progress -----------------------------
    controller.greenFlag()
    const running = await waitFor(workerLog, (probe) => probe.running && probe.threads > 0, 8000)
    if (!running) {
      phases.greenFlag = { ok: false, logTail: workerLog.slice(-5) }
      return { ...report, workerLog: workerLog.slice(-40), errors }
    }
    await sleep(1500)
    const pre = [...workerLog].reverse().find((probe) => probe.running) ?? running
    const hostPre = host.snapshot()
    const boundsBaselineA = await controller.probeBounds('MoverA').catch((error) => `probe failed: ${error instanceof Error ? error.message : String(error)}`)
    const boundsBaselineB = await controller.probeBounds('MoverB').catch((error) => `probe failed: ${error instanceof Error ? error.message : String(error)}`)
    const series = (ms: number): Promise<Array<number | undefined>> => {
      const out: Array<number | undefined> = []
      const rounds = Math.max(1, Math.round(ms / 200))
      const tick = async (): Promise<void> => {
        out.push(workerLog.length > 0 ? workerLog[workerLog.length - 1]!.xOfA : undefined)
        if (out.length < rounds) {
          await sleep(200)
          await tick()
        }
      }
      return tick().then(() => out)
    }
    phases.steadyRun = {
      ok: true,
      workerX: pre.xOfA,
      workerVar: pre.varOfA,
      workerClones: pre.clones,
      workerThreads: pre.threads,
      threadStatuses: pre.threadStatuses,
      hostSelected: hostPre.selectedTargetId,
      boundsBaselineA,
      boundsBaselineB,
    }

    // --- S0b: greenFlag immediately followed by a selection fence ---------
    // The flag snapshot (pre-switch) and the fence sync (post-switch) race
    // on the worker; the flag must never be dropped by the fence sync.
    const flagRace: Array<Record<string, unknown>> = []
    for (let round = 0; round < 3; round++) {
      const wantId = round % 2 === 0 ? idB : idA
      controller.stopAll()
      await waitForFrom(workerLog, workerLog.length, (probe) => probe.event === 'PROJECT_RUN_STOP' && !probe.running, 8000)
      const mark = workerLog.length
      controller.greenFlag()
      host.selectTarget(wantId)
      await controller.sync(host.snapshot() as never)
      const started = await waitForFrom(workerLog, mark, (probe) => probe.running && probe.threads > 0, 8000)
      await sleep(400)
      const latest = workerLog[workerLog.length - 1]!
      flagRace.push({
        round,
        wantId,
        runningStarted: Boolean(started),
        workerSelected: latest.selectedTargetId,
        workerThreads: latest.threads,
        workerX: latest.xOfA,
        hostSelected: host.snapshot().selectedTargetId,
      })
    }
    phases.flagRace = flagRace

    // --- S1: guarded fence replica (vm.selectTarget + eager sync) ---------
    host.selectTarget(idB)
    const fenceLogIndex = workerLog.length
    const fenceAt = Date.now()
    const fenceMark = workerLog.length
    await controller.sync(host.snapshot() as never)
    const synced = await waitForFrom(workerLog, fenceMark, (probe) => probe.event === 'WORKER_SYNC' && probe.selectedTargetId === idB, 8000)
    const progressionAfterFence = await series(1200)
    const latestWorker = workerLog[workerLog.length - 1]!
    const hostPost = host.snapshot()
    const afterFence = workerLog.slice(fenceLogIndex).filter((probe) => probe.xOfA !== undefined)
    const minXAfterFence = afterFence.length > 0 ? Math.min(...afterFence.map((probe) => probe.xOfA as number)) : undefined
    phases.fenceSync = {
      ok: Boolean(synced),
      fenceMs: Date.now() - fenceAt,
      workerSelected: synced?.selectedTargetId,
      workerRunning: synced?.running,
      workerThreads: synced?.threads,
      threadStatusesAtSync: synced?.threadStatuses,
      threadsPreserved: synced ? synced.threads >= pre.threads : false,
      xBefore: pre.xOfA,
      xAtSync: synced?.xOfA,
      rewound: synced && pre.xOfA !== undefined && synced.xOfA !== undefined ? synced.xOfA < pre.xOfA : false,
      rewindDelta: synced && pre.xOfA !== undefined && synced.xOfA !== undefined ? pre.xOfA - synced.xOfA : 0,
      clonesBefore: pre.clones,
      clonesAtSync: synced?.clones,
      clonesLost: pre.clones.filter((id) => !(synced?.clones ?? []).includes(id)),
      varBefore: pre.varOfA,
      varAtSync: synced?.varOfA,
      varRewound: synced && pre.varOfA !== undefined && synced.varOfA !== undefined ? Number(synced.varOfA) < Number(pre.varOfA) : false,
      hostSelected: hostPost.selectedTargetId,
      hostSelectedStable: hostPost.selectedTargetId === idB,
      latestWorkerEvent: latestWorker.event,
      progressionAfterFence,
      latestThreadStatuses: latestWorker.threadStatuses,
      latestX: latestWorker.xOfA,
      latestVar: latestWorker.varOfA,
    }

    // --- S2: stale in-flight frames must not revert host selection --------
    await sleep(800)
    const hostQuiesced = host.snapshot()
    phases.staleFence = {
      hostSelected: hostQuiesced.selectedTargetId,
      ok: hostQuiesced.selectedTargetId === idB,
      running: hostQuiesced.running,
    }

    // --- S3: host pending edit carried by the next sync -------------------
    const targetA = host.getTarget(idA)!
    targetA.blocks = {
      ...targetA.blocks,
      extra: { opcode: 'data_changevariableby', next: null, parent: 'flag', inputs: { VALUE: [1, [4, '100']] }, fields: { VARIABLE: ['score', 'var-score'] } },
    } as never
    const editIndex = workerLog.length
    await controller.sync(host.snapshot() as never)
    const editSynced = await waitForFrom(
      workerLog,
      editIndex,
      (probe) => probe.event === 'WORKER_SYNC' && probe.blockKeysA.includes('extra'),
      8000,
    )
    // Structural edit while running: execution must survive (no zombie
    // Running-with-no-threads state, no lost progression).
    await sleep(900)
    const afterEdit = workerLog[workerLog.length - 1]!
    phases.pendingEdit = {
      ok: Boolean(editSynced),
      workerSelectedKept: editSynced?.selectedTargetId === idB,
      hostSelected: host.snapshot().selectedTargetId,
      threadsAfterEdit: afterEdit.threads,
      runningAfterEdit: afterEdit.running,
      xAfterEdit: afterEdit.xOfA,
      progressionSurvived: afterEdit.running && afterEdit.threads > 0,
    }

    // --- S4: external asset write (plugin-style direct vm write) ----------
    const svgC = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40" viewBox="0 0 200 40"><rect width="200" height="40" fill="#16a34a"/></svg>`,
    )
    await host.updateCostume('MoverB', 0, {}, svgC)
    const newMd5 = (host.getTarget(idB)!.costumes[0] as { md5ext?: string }).md5ext
    const assetIndex = workerLog.length
    await controller.sync(host.snapshot() as never)
    const assetSynced = await waitForFrom(workerLog, assetIndex, (probe) => probe.event === 'WORKER_SYNC' && probe.costumeMd5s.some((md5) => md5 === newMd5), 8000)
    let boundsB: unknown = null
    try {
      boundsB = await controller.probeBounds('MoverB')
    } catch (error) {
      boundsB = `probe failed: ${error instanceof Error ? error.message : String(error)}`
    }
    await sleep(900)
    const afterAsset = workerLog[workerLog.length - 1]!
    phases.externalAssetWrite = {
      ok: Boolean(assetSynced),
      newMd5,
      boundsB,
      workerSelectedKept: assetSynced?.selectedTargetId === idB,
      threadsAfterAsset: afterAsset.threads,
      runningAfterAsset: afterAsset.running,
      progressionSurvived: afterAsset.running && afterAsset.threads > 0,
    }

    // --- S5: project reload with reused ids -------------------------------
    const reloaded = structuredClone(project)
    const reA = reloaded.targets.find((target) => !target.isStage && target.name === 'MoverA')!
    reA.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, topLevel: true, x: 5, y: 5 },
      set: { opcode: 'data_setvariableto', next: null, parent: 'flag', inputs: { VALUE: [1, [10, 'RELOADED']] }, fields: { VARIABLE: ['score', 'var-score'] } },
    } as never
    await host.loadProject(reloaded as never)
    host.selectTarget(idA)
    const reloadIndex = workerLog.length
    await controller.sync(host.snapshot() as never)
    const reloadSynced = await waitForFrom(workerLog, reloadIndex, (probe) => probe.event === 'WORKER_SYNC' && probe.selectedTargetId === idA, 8000)
    controller.greenFlag()
    const reloadedRan = await waitForFrom(workerLog, reloadIndex, (probe) => probe.varOfA === 'RELOADED', 8000)
    phases.reloadReusedIds = {
      ok: Boolean(reloadSynced && reloadedRan),
      workerSelected: reloadSynced?.selectedTargetId,
      reloadedVar: reloadedRan?.varOfA,
    }

    // --- S6: sync with no worker (disposed) must not break selection ------
    controller.dispose()
    host.selectTarget(idB)
    let threw: string | null = null
    try {
      await controller.sync(host.snapshot() as never)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    phases.syncAfterDispose = { threw, hostSelected: host.snapshot().selectedTargetId, ok: host.snapshot().selectedTargetId === idB }
  } finally {
    try {
      controller.dispose()
    } catch {
      // best effort
    }
  }
  const trail = workerLog.slice(-120).map((probe) => ({
    t: probe.at,
    e: probe.event,
    run: probe.running ? 1 : 0,
    th: probe.threads,
    st: probe.threadStatuses.join(','),
    x: probe.xOfA,
    v: probe.varOfA,
    sel: probe.selectedTargetId,
    cl: probe.clones.length,
  }))
  return { ...report, errors, trail }
}
