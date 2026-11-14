import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import { RuntimeWorkerController } from '../src/lib/runtime-worker'

const enc = new TextEncoder()
const dec = new TextDecoder()
const svg = (n: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text>${n}</text></svg>`
const svgBytes = (n: string) => enc.encode(svg(n))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Probe = {
  event: string
  running: boolean
  threads: number
  selectedTargetId: string
  varDone?: string
  costumeMd5?: string
  blockKeys?: string[]
  cloneCount: number
  cloneBlocksEqualOwner?: boolean
  cloneX?: number
}

function probeOf(snapshot: never, event: string): Probe {
  const s = snapshot as unknown as {
    running: boolean
    selectedTargetId: string
    threads: Array<{ status: string }>
    project: {
      targets: Array<{
        id?: string
        isClone?: boolean
        cloneOf?: string
        variables?: Record<string, [string, string]>
        costumes?: Array<{ md5ext?: string }>
        blocks?: Record<string, unknown>
        x?: number
      }>
    }
  }
  const targets = s.project?.targets ?? []
  const owner = targets.find((t) => !t.isClone && (t.id ?? '') !== '')
  const firstOwner = targets.find((t) => !t.isClone)
  const costumeMd5 = firstOwner?.costumes?.[0] ? String((firstOwner.costumes[0] as { md5ext?: string }).md5ext ?? '') : undefined
  const varDoneEntry = (() => {
    for (const t of targets) {
      if (t.isClone) continue
      const vars = t.variables ?? {}
      for (const [, record] of Object.entries(vars)) {
        if (record[0] === 'done') return String(record[1])
      }
    }
    return undefined
  })()
  const clones = targets.filter((t) => t.isClone)
  const ownerBlocks = firstOwner?.blocks as Record<string, unknown> | undefined
  const cloneBlocksEqualOwner = clones.length > 0 && ownerBlocks
    ? clones.every((c) => JSON.stringify((c.blocks as Record<string, unknown>) ?? {}) === JSON.stringify(ownerBlocks))
    : undefined
  return {
    event,
    running: Boolean(s.running),
    threads: Array.isArray(s.threads) ? s.threads.length : 0,
    selectedTargetId: String(s.selectedTargetId ?? ''),
    varDone: varDoneEntry,
    costumeMd5,
    blockKeys: ownerBlocks ? Object.keys(ownerBlocks).sort() : [],
    cloneCount: clones.length,
    cloneBlocksEqualOwner: cloneBlocksEqualOwner as boolean | undefined,
    cloneX: clones[0]?.x,
  }
}

async function waitFor(log: Probe[], from: number, pred: (p: Probe) => boolean, timeoutMs: number): Promise<Probe | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = log.slice(from).find(pred)
    if (hit) return hit
    if (Date.now() > deadline) return undefined
    await sleep(50)
  }
}

async function bytesOfHost(vm: ScratchVM, tid: string): Promise<string | undefined> {
  const c = vm.getTarget(tid)?.costumes[0]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  const b = await vm.loadAsset(key, c?.dataFormat ?? 'svg')
  return b ? dec.decode(b) : undefined
}

;(window as unknown as { runHostReplacementAudit?: () => Promise<Record<string, unknown>> }).runHostReplacementAudit = async () => {
  const report: Record<string, unknown> = {}
  const errors: unknown[] = []
  try {
    // --- R1: reload during pending gated write (real Worker) ---
    {
      const host = new ScratchVM()
      host.loadProject(createDefaultProject())
      const tid = host.getSprites()[0]!.id as string
      await host.updateCostume(tid, 0, { dataFormat: 'svg' }, svgBytes('base'))
      const canvas = document.querySelector('#stage') as HTMLCanvasElement
      const workerLog: Probe[] = []
      const controller = new RuntimeWorkerController(
        host as never,
        (next, event) => {
          workerLog.push(probeOf(next as never, event))
        },
        (m) => errors.push(m),
      )
      controller.attachCanvas(canvas as never, host.snapshot() as never)
      // Gated stale write on the host (paint in flight).
      const origStore = host.storeAsset.bind(host)
      let release!: () => void
      const blocked = new Promise<void>((r) => { release = r })
      let enteredResolve!: () => void
      const entered = new Promise<void>((r) => { enteredResolve = r })
      let fired = false
      host.storeAsset = (async (d: Uint8Array, f: string) => {
        if (!fired) {
          fired = true
          enteredResolve()
        }
        await blocked
        return origStore(d, f)
      }) as never
      const pending = host.updateCostumeIfMatch(tid, 0, undefined, { dataFormat: 'svg' }, svgBytes('stale-old'))
      await entered
      // Reload with reused target id + exact replacement bytes.
      const stored = await origStore(svgBytes('replacement-exact'), 'svg')
      const reloaded = structuredClone(host.exportProject())
      const rt = reloaded.targets.find((t) => t.id === tid)!
      rt.costumes[0] = { ...rt.costumes[0]!, assetId: stored.assetId, md5ext: stored.md5ext, dataFormat: 'svg' }
      rt.blocks = { fresh: { opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 } } as never
      host.importAssetBytes({ [stored.assetId]: svgBytes('replacement-exact'), [stored.md5ext]: svgBytes('replacement-exact') })
      await host.loadProject(reloaded as never)
      release()
      const res = await pending
      host.storeAsset = origStore
      const hostBytes = await bytesOfHost(host, tid)
      // Sync reload to the real worker; worker must adopt exact bytes.
      const mark = workerLog.length
      await controller.sync(host.snapshot() as never)
      const synced = await waitFor(workerLog, mark, (p) => p.event === 'WORKER_SYNC' && p.costumeMd5 === stored.md5ext, 8000)
      report.reloadDuringGatedWrite = {
        applied: res.applied,
        hostBytesHasExact: hostBytes?.includes('replacement-exact'),
        workerSynced: Boolean(synced),
        workerMd5: synced?.costumeMd5,
        expectedMd5: stored.md5ext,
        hostGeneration: host.getProjectGeneration(),
      }
      controller.dispose()
    }

    // --- R2: mid-broadcast structural edit (real Worker) ---
    {
      const host = new ScratchVM()
      host.loadProject(createDefaultProject())
      const tid = host.getSprites()[0]!.id as string
      const target = host.getTarget(tid)!
      target.variables = { v: ['done', '0'] }
      target.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'bwait', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
        bwait: { opcode: 'event_broadcastandwait', next: 'set', parent: 'flag', inputs: { BROADCAST_INPUT: [1, [10, 'go']] }, fields: {}, shadow: false, topLevel: false },
        set: { opcode: 'data_setvariableto', next: null, parent: 'bwait', inputs: { VALUE: [1, [10, 'parent-done']] }, fields: { VARIABLE: ['done', 'v'] }, shadow: false, topLevel: false },
        recv: { opcode: 'event_whenbroadcastreceived', next: 'cwait', parent: null, inputs: {}, fields: { BROADCAST_OPTION: ['go', 'recv'] }, shadow: false, topLevel: true, x: 60, y: 10 },
        cwait: { opcode: 'control_wait', next: null, parent: 'recv', inputs: { DURATION: [1, [4, '3600']] }, fields: {}, shadow: false, topLevel: false },
      } as never
      const canvas = document.querySelector('#stage') as HTMLCanvasElement
      const workerLog: Probe[] = []
      const controller = new RuntimeWorkerController(host as never, (next, event) => void workerLog.push(probeOf(next as never, event)), (m) => void errors.push(m))
      controller.attachCanvas(canvas as never, host.snapshot() as never)
      controller.greenFlag()
      const started = await waitFor(workerLog, 0, (p) => p.running && p.threads >= 2, 8000)
      // Host removes the receiver hat mid-wait (same-generation structural edit).
      const live = host.getTarget(tid)!
      delete (live.blocks as Record<string, unknown>).recv
      delete (live.blocks as Record<string, unknown>).cwait
      const mark = workerLog.length
      await controller.sync(host.snapshot() as never)
      const settled = await waitFor(workerLog, mark, (p) => !p.running && p.threads === 0 && p.varDone === 'parent-done', 10000)
      const latest = workerLog[workerLog.length - 1]
      report.midBroadcastEdit = {
        started: Boolean(started),
        settled: Boolean(settled),
        latestThreads: latest?.threads,
        latestRunning: latest?.running,
        varDone: latest?.varDone,
      }
      controller.dispose()
    }

    // --- R3: live clone re-point (real Worker) ---
    {
      const host = new ScratchVM()
      host.loadProject(createDefaultProject())
      const tid = host.getSprites()[0]!.id as string
      const target = host.getTarget(tid)!
      target.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'clone', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10 },
        clone: { opcode: 'control_create_clone_of', next: null, parent: 'flag', inputs: {}, fields: { CLONE_OPTION: ['_myself_', '_myself_'] }, shadow: false, topLevel: false },
      } as never
      const canvas = document.querySelector('#stage') as HTMLCanvasElement
      const workerLog: Probe[] = []
      const controller = new RuntimeWorkerController(host as never, (next, event) => void workerLog.push(probeOf(next as never, event)), (m) => void errors.push(m))
      controller.attachCanvas(canvas as never, host.snapshot() as never)
      controller.greenFlag()
      const cloned = await waitFor(workerLog, 0, (p) => p.cloneCount === 1, 10000)
      const live = host.getTarget(tid)!
      ;(live.blocks as Record<string, unknown>).extra = { opcode: 'control_wait', next: null, parent: null, inputs: { DURATION: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: true, x: 90, y: 90 }
      const mark = workerLog.length
      await controller.sync(host.snapshot() as never)
      await sleep(800)
      const latest = workerLog[workerLog.length - 1]
      report.liveCloneRepoint = {
        cloned: Boolean(cloned),
        cloneCount: latest?.cloneCount,
        cloneBlocksEqualOwner: latest?.cloneBlocksEqualOwner,
        blockKeys: latest?.blockKeys,
      }
      controller.dispose()
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }
  return { ...report, errors }
}
