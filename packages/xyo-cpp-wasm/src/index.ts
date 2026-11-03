import { createRendererCallbackTable, type RendererCallbacksOptions, type RendererWasmModule } from './renderer_callbacks'
import { AudioBridge, type AudioBridgeModule } from './audio-bridge'
import { PenBridge, type PenAbiModule } from './pen-bridge'
export type { RendererCallbacksOptions, RendererScene, RendererTargetMapping } from './renderer_callbacks'
export { overlayXyoSnapshot } from './snapshot'
export type { XyoSnapshot, XyoTarget } from './snapshot'
export { FlagCompileController } from './flag-controller'
export type { CompiledHeadlessRuntime, FlagResult } from './flag-controller'

export interface XyoModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(ptr: number): void
  UTF8ToString(ptr: number): string
  _xyo_browser_create(): number
  _xyo_browser_destroy(handle: number): number
  _xyo_browser_load_sb3(handle: number, ptr: number, size: number): number
  _xyo_browser_green_flag(handle: number): number
  _xyo_browser_stop(handle: number): number
  _xyo_browser_step(handle: number): number
  _xyo_browser_key(handle: number, ptr: number, size: number, down: number, keyCode: number): number
  _xyo_browser_mouse(handle: number, x: number, y: number, width: number, height: number, down: number, button: number, dragged: number): number
  _xyo_browser_wheel(handle: number, dx: number, dy: number): number
  _xyo_browser_answer(handle: number, ptr: number, size: number): number
  _xyo_browser_answer_if_question(handle: number, idPtr: number, idSize: number, ptr: number, size: number): number
  _xyo_browser_renderer_attach(handle: number, table: number, size: number): number
  _xyo_browser_renderer_detach(handle: number): number
  /** Present on the ESM build; the legacy CJS build does not export these. */
  addFunction?: RendererWasmModule['addFunction']
  removeFunction?: RendererWasmModule['removeFunction']
  _xyo_browser_snapshot(handle: number): number
  _xyo_browser_error(handle: number): number
  _xyo_browser_capabilities(): number
  _xyo_browser_set_compiled(handle: number, enabled: number): number
  _xyo_browser_compiled_enabled(handle: number): number
  _xyo_browser_compile_attempts(): number
  _xyo_browser_compile_successes(): number
  _xyo_browser_compiled_executions(): number
  _xyo_browser_compile_fallbacks(): number
  _xyo_browser_compiled_live_modules(): number
}

/** Headless by default. Renderer and audio bridges are opt-in; target/asset
 * synchronization and pixel-perfect Scratch collision semantics are incomplete. */
export class XyoHeadlessRuntime {
  private handle: number
  private renderer: ReturnType<typeof createRendererCallbackTable> | undefined
  constructor(private readonly module: XyoModule) {
    this.handle = module._xyo_browser_create()
    if (!this.handle) throw new Error('Could not create xyo-cpp runtime')
  }
  get supportsCompiledExecution(): boolean { return !!(this.module._xyo_browser_capabilities() & 2) }
  /** Optional experimental poll-only audio ABI; older modules return undefined. */
  createAudioBridge(): AudioBridge | undefined {
    const candidate = this.module as XyoModule & Partial<AudioBridgeModule>
    if (typeof candidate._xyo_browser_audio_open !== 'function') return undefined
    return new AudioBridge(candidate as XyoModule & AudioBridgeModule, this.current())
  }
  /** Isolated opt-in prototype only. Never called by the production worker. */
  createPenBridge(): PenBridge | undefined {
    const candidate = this.module as XyoModule & Partial<PenAbiModule>
    const names = ['_xyo_browser_pen_enable', '_xyo_browser_pen_count', '_xyo_browser_pen_kind', '_xyo_browser_pen_value', '_xyo_browser_pen_consume'] as const
    if (!names.every(name => typeof candidate[name] === 'function')) return undefined
    return new PenBridge(candidate as XyoModule & PenAbiModule, this.current())
  }
  private current(): number {
    if (!this.handle) throw new Error('xyo-cpp runtime is disposed')
    return this.handle
  }
  private checked(result: number): void {
    if (result) return
    const ptr = this.module._xyo_browser_error(this.current())
    throw new Error(ptr ? this.module.UTF8ToString(ptr) : 'xyo-cpp runtime error')
  }
  loadSb3(bytes: Uint8Array): void {
    const handle = this.current()
    if (!bytes.length) throw new Error('SB3 data is empty')
    // The source may itself be a view of the WASM heap. malloc can grow memory
    // and detach that view, so retain a private copy before allocating.
    const copy = new Uint8Array(bytes)
    const ptr = this.module._malloc(copy.length)
    if (!ptr) throw new Error('xyo-cpp allocation failed')
    try {
      // malloc can grow memory: acquire the heap view only after allocation.
      this.module.HEAPU8.set(copy, ptr)
      this.checked(this.module._xyo_browser_load_sb3(handle, ptr, copy.length))
    } finally { this.module._free(ptr) }
  }
  /** Counters are module-wide, cumulative, and shared by all runtime instances. */
  get compileStats() {
    return { attempts: this.module._xyo_browser_compile_attempts(), successes: this.module._xyo_browser_compile_successes(),
      executions: this.module._xyo_browser_compiled_executions(), fallbacks: this.module._xyo_browser_compile_fallbacks(),
      liveModules: this.module._xyo_browser_compiled_live_modules() }
  }
  get compiledEnabled(): boolean {
    const enabled = this.module._xyo_browser_compiled_enabled(this.current())
    if (enabled < 0) throw new Error('Could not read xyo-cpp compiled mode')
    return enabled !== 0
  }
  /** Select mode before green flag. Unsupported scripts fall back to interpreter. */
  setCompiled(enabled: boolean): void { this.checked(this.module._xyo_browser_set_compiled(this.current(), Number(enabled))) }
  greenFlagInterpreter(): void { this.setCompiled(false); this.checked(this.module._xyo_browser_green_flag(this.current())) }
  greenFlagCompiled(): void { this.setCompiled(true); this.checked(this.module._xyo_browser_green_flag(this.current())) }
  stop(): void { this.checked(this.module._xyo_browser_stop(this.current())) }
  step(): void { this.checked(this.module._xyo_browser_step(this.current())) }
  private withUtf8(text: string, fn: (ptr: number, size: number) => number): void {
    this.current()
    const bytes = new TextEncoder().encode(text)
    // Allocate even for an empty string, so the pointer is always valid.
    const ptr = this.module._malloc(Math.max(1, bytes.length))
    if (!ptr) throw new Error('xyo-cpp allocation failed')
    try {
      this.module.HEAPU8.set(bytes, ptr)
      this.checked(fn(ptr, bytes.length))
    } finally { this.module._free(ptr) }
  }
  /** DOM KeyboardEvent.key; keyCode is optional and defaults to unavailable. */
  key(key: string, down: boolean, keyCode = -1): void {
    if (!Number.isInteger(keyCode) || keyCode < -1 || keyCode > 2147483647) throw new Error('Invalid key code')
    this.withUtf8(key, (ptr, size) => this.module._xyo_browser_key(this.current(), ptr, size, Number(down), keyCode))
  }
  /** Canvas-local CSS pixel coordinates; headless hit testing selects the stage. */
  mouse(x: number, y: number, width: number, height: number, down: boolean, button = 0, dragged = false): void {
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || !Number.isInteger(button) || button < 0 || button > 4) throw new Error('Invalid mouse input')
    this.checked(this.module._xyo_browser_mouse(this.current(), x, y, width, height, Number(down), button, Number(dragged)))
  }
  wheel(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Invalid wheel input')
    this.checked(this.module._xyo_browser_wheel(this.current(), dx, dy))
  }
  answer(text: string): void {
    this.withUtf8(text, (ptr, size) => this.module._xyo_browser_answer(this.current(), ptr, size))
  }
  /** Answer only the exact current question. False means it was replaced or cancelled. */
  answerIfQuestion(questionId: string, text: string): boolean {
    let result = 0
    this.withUtf8(questionId, (id, idSize) => {
      this.withUtf8(text, (ptr, size) => {
        result = this.module._xyo_browser_answer_if_question(this.current(), id, idSize, ptr, size)
        return result === -1 ? 1 : result
      })
      return 1
    })
    return result === 1
  }
  /** Install a Canvas callback bridge; callers keep scene mappings current and
   * must not reenter this runtime from callbacks. A failed replacement leaves the
   * old renderer attached. The runtime exclusively owns the new callback table. */
  attachRenderer(options: RendererCallbacksOptions): void {
    const handle = this.current()
    if (typeof this.module.addFunction !== 'function' || typeof this.module.removeFunction !== 'function') {
      throw new Error('Renderer callbacks require the ESM WASM build')
    }
    const next = createRendererCallbackTable(this.module as RendererWasmModule, options)
    try {
      // wasm32 RendererCallbacks: ctx + 21 function pointers, 4 bytes each.
      this.checked(this.module._xyo_browser_renderer_attach(handle, next.table, 22 * 4))
    } catch (error) {
      next.dispose()
      throw error
    }
    const previous = this.renderer
    this.renderer = next
    // Native replacement has returned, so it no longer references previous.
    previous?.dispose()
  }
  /** Native detachment must succeed before callback table entries are released. */
  detachRenderer(): void {
    const handle = this.current()
    if (!this.renderer) return
    this.checked(this.module._xyo_browser_renderer_detach(handle))
    const previous = this.renderer
    this.renderer = undefined
    previous.dispose()
  }
  snapshot(): unknown {
    const ptr = this.module._xyo_browser_snapshot(this.current())
    if (!ptr) throw new Error('Could not read xyo-cpp snapshot')
    return JSON.parse(this.module.UTF8ToString(ptr)) as unknown
  }
  dispose(): void {
    if (!this.handle) return
    const handle = this.handle
    // Keep handle and callback table intact if native destruction fails.
    if (!this.module._xyo_browser_destroy(handle)) throw new Error('Could not destroy xyo-cpp runtime')
    this.handle = 0
    const previous = this.renderer
    this.renderer = undefined
    previous?.dispose()
  }
}
