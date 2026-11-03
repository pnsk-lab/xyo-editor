/** Experimental opt-in Vite entry. Build xyo-cpp-wasm before bundling this worker. */
// Generated locally, deliberately absent from source control and ordinary editor builds.
// @ts-ignore -- optional generated artifact is absent until the WASM build runs.
import moduleUrl from '../../../xyo-cpp-wasm/.work/build-wasm/xyo-browser-esm.mjs?url'
// @ts-ignore -- optional generated artifact is absent until the WASM build runs.
import wasmUrl from '../../../xyo-cpp-wasm/.work/build-wasm/xyo-browser-esm.wasm?url'
import { XyoHeadlessRuntime, type XyoModule } from '../../../xyo-cpp-wasm/src/index'
import { createXyoWorkerHost } from './xyo-worker-host'
import { XyoAudioAbiAdapter } from './xyo-audio-abi-adapter'
import type { XyoWorkerRequest, XyoWorkerResponse } from './xyo-worker-protocol'

// The explicit surface avoids mixing DOM and WebWorker global types in the editor.
const scope = globalThis as unknown as {
  postMessage(response: XyoWorkerResponse): void
  addEventListener(type: 'message', listener: (event: MessageEvent<XyoWorkerRequest>) => void): void
}
const handle = createXyoWorkerHost(async () => {
  // Treat Emscripten JS as an opaque asset: TypeScript must not check generated code.
  // Vite emits the asset, while this runtime import preserves its module semantics.
  const { default: createXyoBrowser } = await import(/* @vite-ignore */ moduleUrl) as {
    default: (options: { locateFile: (path: string) => string }) => Promise<XyoModule>
  }
  const module = await createXyoBrowser({ locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path })
  const runtime = new XyoHeadlessRuntime(module)
  const audioBridge = runtime.createAudioBridge()
  return audioBridge ? Object.assign(runtime, { audio: new XyoAudioAbiAdapter(audioBridge, 300) }) : runtime
}, response => scope.postMessage(response))
scope.addEventListener('message', event => handle(event.data))
