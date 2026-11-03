import { assetUrl } from './asset-url'
import type { RuntimeBackendRegistry } from './runtime-backends'
// Static import so bundlers inline the backend with the registration; the
// heavy artifacts are still fetched lazily by load().
import { createUnifiedBackend } from './xyo-unified-backend'
import type { AudioHostContext } from '../../../xyo-cpp-wasm/src/web-audio-host'

export const XYO_BACKEND_ID = 'xyo-cpp'

const ARTIFACT_BASE = assetUrl('llvm-artifacts')

/** Experimental backend over the unified xyo-cpp Wasm runtime: the interpreter
 * covers xyo-cpp's full feature set and LLVM executes the admitted scripts
 * against that same Runtime. Artifacts come from public/llvm-artifacts (see
 * scripts/pack-llvm-artifacts.mjs); without them load() rejects and the editor
 * falls back to the built-in VM. The previous xyo-cpp Wasm compiler path is
 * never started. */
export function registerXyoBackend(registry: RuntimeBackendRegistry): void {
  registry.register({
    id: XYO_BACKEND_ID,
    label: 'xyo-cpp / LLVM（実験的）',
    load: async () => {
      const artifactUrls = {
        worker: `${ARTIFACT_BASE}/llvm-runner.worker.js`,
        compilerJs: `${ARTIFACT_BASE}/xyo_browser_ir.js`,
        compilerWasm: `${ARTIFACT_BASE}/xyo_browser_ir.wasm`,
        pipelineIndex: `${ARTIFACT_BASE}/pipeline-index.mjs`,
        pipelineWorker: `${ARTIFACT_BASE}/pipeline-worker.mjs`,
        llcWorker: `${ARTIFACT_BASE}/llc-browser.mjs`,
        lldWorker: `${ARTIFACT_BASE}/lld-browser.mjs`,
        hostJs: `${ARTIFACT_BASE}/real_host.js`,
        hostWasm: `${ARTIFACT_BASE}/real_host.wasm`,
      }
      const probe = await fetch(`${ARTIFACT_BASE}/xyo_browser_ir.wasm`, { method: 'HEAD' }).catch(() => null)
      if (!probe || !probe.ok) {
        throw new Error('LLVM アーティファクトが見つかりません。pnpm --filter xyo-editor run pack:llvm を実行してください。')
      }
      return () => createUnifiedBackend({
        module: `${ARTIFACT_BASE}/unified_runtime_esm.mjs`,
        wasm: `${ARTIFACT_BASE}/unified_runtime_esm.wasm`,
        runner: artifactUrls,
        // Sound is optional: without Web Audio the runtime stays silent and
        // every other feature is unaffected.
        audioContext: typeof globalThis.AudioContext === 'function'
          ? new globalThis.AudioContext() as unknown as AudioHostContext
          : undefined,
      })
    },
  })
}
