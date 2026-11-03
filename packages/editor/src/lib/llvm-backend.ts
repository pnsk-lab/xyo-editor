import { strToU8, unzipSync, zipSync } from 'fflate'
import { ScratchCanvasRenderer, ScratchVM } from '@hikkaku/vm'
import { commitFlowValues, splitProjectForLlvm, type GreenFlagVariable } from '@hikkaku/llvm-wasm'
import type { RuntimeBackend, RuntimeVM } from './runtime-backends'

function isTargetLike(value: unknown): value is { name?: unknown; variables: Record<string, unknown> } {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (value as { variables?: unknown }).variables !== undefined &&
    typeof (value as { variables?: unknown }).variables === 'object';
}

/** Two-phase runner: build once at load (compile+link, the slow part), then
 * execute per green flag against live-seeded inputs (instantiate+invoke).
 * The real worker-based runner lands with artifact serving; tests inject fakes.
 */
export interface LlvmScriptBuild {
  side: Uint8Array;
  metadata: {
    abiDescriptor: string;
    slots: Array<{ global: string; kind: number; keyHex: string }>;
  };
}
export interface LlvmScriptRunner {
  buildAdmitted(input: { project: unknown; sb3: Uint8Array }): Promise<
    | { ok: true; build: LlvmScriptBuild }
    | { ok: false; error: string }
  >;
  runBuilt(input: { build: LlvmScriptBuild; sb3: Uint8Array }): Promise<
    | { ok: true; variables: GreenFlagVariable[] }
    | { ok: false; error: string }
  >;
}

export interface LlvmBackendOptions {
  onError?: (error: unknown) => void
}

interface AdmittedScript {
  project: unknown
  build: LlvmScriptBuild
}

/** Patch a single-script project's initial variable values with live scalars
 * so each green-flag execution starts from current runtime state (reflag
 * accumulates exactly like the built-in VM). Pure; fails closed. */
export function seedLiveValues(
  project: unknown,
  live: Array<{ target: string; id: string; value: string | number | boolean }>,
): { ok: true; project: unknown } | { ok: false; error: string } {
  let patched: unknown
  try {
    patched = JSON.parse(JSON.stringify(project))
  } catch {
    return { ok: false, error: 'project is not JSON-serializable' }
  }
  const targets = (patched as { targets?: unknown }).targets
  if (!Array.isArray(targets) || targets.length !== 1 || !isTargetLike(targets[0])) {
    return { ok: false, error: 'admitted project lost its single target' }
  }
  const only = targets[0]
  const targetName = typeof only.name === 'string' && only.name ? only.name : 'Stage'
  for (const { target, id, value } of live) {
    if (target !== targetName) return { ok: false, error: `variable ${id} targets ${target}, expected ${targetName}` }
    const record = (only.variables as Record<string, unknown>)[id]
    if (!Array.isArray(record) || record.length < 2 || typeof record[0] !== 'string') {
      return { ok: false, error: `malformed variable record ${id}` }
    }
    record[1] = value
  }
  return { ok: true, project: patched }
}

function decodeProjectInput(data: unknown): unknown {
  try {
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      // SB3 first, plain JSON bytes as fallback.
      try {
        const files = unzipSync(bytes) as Record<string, Uint8Array>
        const json = files['project.json']
        if (json) return JSON.parse(new TextDecoder().decode(json))
      } catch { /* fall through to raw JSON attempt */ }
      return JSON.parse(new TextDecoder().decode(bytes))
    }
    if (typeof data === 'string') return JSON.parse(data)
    return data
  } catch {
    return data
  }
}

function encodeSb3(project: unknown): Uint8Array | null {
  try {
    return zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
  } catch {
    return null
  }
}

/** Green-flag backend: admitted straight-line scripts run on the LLVM chain,
 * everything else runs in the wrapped built-in VM unchanged. Experimental. */
export function createLlvmBackend(runner: LlvmScriptRunner, options: LlvmBackendOptions = {}): RuntimeBackend & {
  settled: () => Promise<void>
  lastError: () => unknown
} {
  const inner = new ScratchVM()
  const renderer = new ScratchCanvasRenderer()
  let admitted: AdmittedScript[] = []
  let pending = 0
  let resolveDrained: (() => void) | null = null
  let lastErrorValue: unknown = null
  let disposed = false
  // A green flag that lands while a load is still compiling must wait for it;
  // otherwise admitted scripts would be silently skipped. The ticket is set
  // synchronously on load entry (so even an immediately following green flag
  // sees it) and cleared when that load settles. Each load also gets an epoch
  // so a stale build can never overwrite a newer admission set.
  let loadTicket: Promise<void> | null = null
  let loadEpoch = 0
  const reportError = (error: unknown) => {
    lastErrorValue = error
    try { options.onError?.(error) } catch { /* observer must not break the runtime */ }
  }
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending++
    const done = () => {
      pending--
      if (pending === 0 && resolveDrained) { resolveDrained(); resolveDrained = null }
    }
    void work.then(done, done)
    return work
  }

  function readLive(project: unknown): { ok: true; values: Array<{ target: string; id: string; value: string | number | boolean }> } | { ok: false; error: string } {
    const targets = (project as { targets?: unknown }).targets
    if (!Array.isArray(targets) || targets.length !== 1 || !isTargetLike(targets[0])) {
      return { ok: false, error: 'admitted project lost its single target' }
    }
    const only = targets[0]
    const targetName = typeof only.name === 'string' && only.name ? only.name : 'Stage'
    const values: Array<{ target: string; id: string; value: string | number | boolean }> = []
    for (const id of Object.keys(only.variables)) {
      const value = inner.getVariableValue(targetName, id)
      if (value === undefined) return { ok: false, error: `live variable missing: ${id}` }
      values.push({ target: targetName, id, value })
    }
    return { ok: true, values }
  }

  async function runOne(script: AdmittedScript): Promise<void> {
    if (disposed) return
    const live = readLive(script.project)
    if (!live.ok) { reportError(new Error(live.error)); return }
    const seeded = seedLiveValues(script.project, live.values)
    if (!seeded.ok) { reportError(new Error(seeded.error)); return }
    const sb3 = encodeSb3(seeded.project)
    if (!sb3) { reportError(new Error('could not encode seeded project')); return }
    let outcome: Awaited<ReturnType<LlvmScriptRunner['runBuilt']>>
    try {
      outcome = await runner.runBuilt({ build: script.build, sb3 })
    } catch (error) {
      reportError(error)
      return
    }
    if (disposed) return
    if (!outcome.ok) { reportError(new Error(outcome.error)); return }
    const committed = commitFlowValues(script.project, outcome.variables)
    if (!committed.ok) { reportError(new Error(committed.error)); return }
    const targets = (committed.project as { targets?: unknown }).targets
    if (!Array.isArray(targets) || targets.length !== 1 || !isTargetLike(targets[0])) {
      reportError(new Error('admitted project lost its single target'))
      return
    }
    const only = targets[0]
    const targetName = typeof only.name === 'string' && only.name ? only.name : 'Stage'
    for (const [id, record] of Object.entries(only.variables)) {
      if (!Array.isArray(record) || record.length < 2) continue
      try {
        inner.setVariableValue(targetName, id, record[1] as string | number | boolean)
      } catch (error) {
        reportError(error)
        return
      }
    }
  }

  const vm = new Proxy(inner, {
    get(target, key) {
      if (key === 'loadProject') {
        return async (data: unknown) => {
          const epoch = ++loadEpoch
          admitted = []
          let resolveTicket!: () => void
          const ticket: Promise<void> = new Promise(r => { resolveTicket = r })
          loadTicket = ticket
          try {
            const decoded = decodeProjectInput(data)
            const split = splitProjectForLlvm(decoded)
            if (!split.ok) return target.loadProject(data)
            const loaded = await target.loadProject(split.rest)
            // Compile once here (load is async); green flags only instantiate.
            const scripts: AdmittedScript[] = []
            for (const a of split.admitted) {
              const sb3 = encodeSb3(a.project)
              if (!sb3) { reportError(new Error('could not encode admitted script')); continue }
              let built: Awaited<ReturnType<LlvmScriptRunner['buildAdmitted']>>
              try {
                built = await track(runner.buildAdmitted({ project: a.project, sb3 }))
              } catch (error) {
                reportError(error)
                continue
              }
              if (!built.ok) { reportError(new Error(built.error)); continue }
              scripts.push({ project: a.project, build: built.build })
            }
            if (epoch === loadEpoch) admitted = scripts
            return loaded
          } finally {
            if (loadTicket === ticket) loadTicket = null
            resolveTicket()
          }
        }
      }
      if (key === 'greenFlag') {
        const runAll = () => {
          target.greenFlag()
          for (const script of admitted) void track(runOne(script))
        }
        return () => {
          const ticket = loadTicket
          if (!ticket) {
            runAll()
            return
          }
          void track((async () => {
            try { await ticket } catch { /* run against whatever is loaded */ }
            if (disposed) return
            runAll()
          })())
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as RuntimeVM

  return {
    vm,
    renderer,
    // Deliberately no worker flag: the app must drive greenFlag/step through
    // this wrapper (admission split + LLVM commit). With worker:'scratch' the
    // app would route execution to its own runtime worker instead, silently
    // bypassing the wrapper while it holds the split project.
    settled: () => (pending === 0 ? Promise.resolve() : new Promise<void>(resolve => { resolveDrained = resolve })),
    lastError: () => lastErrorValue,
    dispose: () => { disposed = true },
  }
}
