import type { GreenFlagVariable } from '@hikkaku/llvm-wasm'
import type { LlvmScriptBuild, LlvmScriptRunner } from './llvm-backend'

/** Artifact URLs the runner worker fetches; the test harness serves built
 * outputs, the app will serve its bundled copies from the same shapes. */
export interface LlvmRunnerUrls {
  worker: string
  compilerJs: string
  compilerWasm: string
  pipelineIndex: string
  pipelineWorker: string
  llcWorker: string
  lldWorker: string
  hostJs: string
  hostWasm: string
}

function callWorker(workerUrl: string, artifactUrls: Omit<LlvmRunnerUrls, 'worker'>, message: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(workerUrl)
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error('LLVM run timed out'))
    }, timeoutMs)
    worker.onmessage = (event: MessageEvent) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(event.data)
    }
    worker.onerror = (event: Event) => {
      clearTimeout(timer)
      worker.terminate()
      reject(new Error((event as ErrorEvent).message || 'runner worker error'))
    }
    worker.postMessage({ ...message, urls: artifactUrls })
  })
}

export function createWorkerRunner(urls: LlvmRunnerUrls, options: { timeoutMs?: number } = {}): LlvmScriptRunner {
  const { worker: workerUrl, ...artifactUrls } = urls
  const timeoutMs = options.timeoutMs ?? 120000
  return {
    buildAdmitted: async ({ project, sb3 }) => {
      const data = await callWorker(workerUrl, artifactUrls, { op: 'build', project, sb3 }, timeoutMs) as
        | { ok: true; build: LlvmScriptBuild }
        | { ok: false; error: string }
      if (!data || typeof data !== 'object' || !('ok' in data)) throw new Error('malformed runner response')
      if (!data.ok) return { ok: false as const, error: data.error }
      return { ok: true as const, build: data.build }
    },
    runBuilt: async ({ build, sb3 }) => {
      const data = await callWorker(workerUrl, artifactUrls, { op: 'run', build, sb3 }, timeoutMs) as
        | { ok: true; variables: GreenFlagVariable[] }
        | { ok: false; error: string }
      if (!data || typeof data !== 'object' || !('ok' in data)) throw new Error('malformed runner response')
      if (!data.ok) return { ok: false as const, error: data.error }
      return { ok: true as const, variables: data.variables }
    },
  }
}
