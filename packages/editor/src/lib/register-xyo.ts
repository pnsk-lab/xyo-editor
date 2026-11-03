import { assetUrl } from './asset-url'
import type { RuntimeBackendRegistry } from './runtime-backends'
// Static import so bundlers inline the backend with the registration; the
// heavy artifacts are still fetched lazily by load().
import { createUnifiedBackend } from './xyo-unified-backend'
import type { AudioHostContext } from '../../../xyo-cpp-wasm/src/web-audio-host'

export const XYO_BACKEND_ID = 'xyo-cpp'

const ARTIFACT_BASE = assetUrl('llvm-artifacts')

/** Cheap same-origin probe used to hide the backend when the build has no artifacts. */
async function probeArtifacts(): Promise<void> {
  const response = await fetch(`${ARTIFACT_BASE}/xyo_browser_ir.wasm`, { method: 'HEAD' })
  if (!response.ok) throw new Error(`LLVM artifacts are not served (HTTP ${response.status})`)
}

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
    probe: probeArtifacts,
    unavailableReason: 'このビルドには LLVM アーティファクトが同梱されていません',
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
      await probeArtifacts().catch((error: unknown) => {
        if (import.meta.env.DEV) console.warn('xyo-cpp / LLVM を読み込めません。`pnpm --filter xyo-editor run pack:llvm` でアーティファクトを生成してください。', error)
        throw new Error('このビルドには LLVM アーティファクトが同梱されていないため、xyo-cpp 実行環境を利用できません。')
      })
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
