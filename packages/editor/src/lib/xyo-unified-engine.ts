import { strToU8, unzipSync, zipSync } from 'fflate'
import { findSegments, splitProjectForLlvm, type LlvmSegment } from '@hikkaku/llvm-wasm'
import { AudioBridge, type AudioBridgeModule } from '../../../xyo-cpp-wasm/src/audio-bridge'
import { XyoAudioAbiAdapter } from './xyo-audio-abi-adapter'
import { createUnifiedRendererBridge, type RendererHostModule, type UnifiedRendererOptions } from './xyo-unified-renderer'
import type { XyoRuntimeEngine } from './xyo-runtime-vm'
import type { LlvmScriptBuild, LlvmScriptRunner } from './llvm-backend'

/** The subset of the unified Wasm module this engine drives. */
export interface UnifiedModule {
  HEAPU8: Uint8Array
  FS: { writeFile(path: string, data: Uint8Array): void }
  _malloc(size: number): number
  _free(pointer: number): void
  _xyo_browser_create(): number
  _xyo_browser_destroy(handle: number): number
  _xyo_browser_load_sb3(handle: number, bytes: number, size: number): number
  _xyo_browser_green_flag(handle: number): number
  _xyo_browser_stop(handle: number): number
  _xyo_browser_step(handle: number): number
  _xyo_browser_key(handle: number, key: number, size: number, down: number, keyCode: number): number
  _xyo_browser_mouse(handle: number, x: number, y: number, w: number, h: number, down: number, button: number, dragged: number): number
  _xyo_browser_wheel(handle: number, dx: number, dy: number): number
  _xyo_browser_answer(handle: number, text: number, size: number): number
  _xyo_browser_answer_if_question(handle: number, questionId: number, idSize: number, text: number, size: number): number
  _xyo_browser_snapshot(handle: number): number
  _xyo_browser_error(handle: number): number
  _xyo_llvm_prepare(handle: number, hatId: number): number
  _xyo_llvm_expect_slots(handle: number, count: number): number
  _xyo_llvm_bind_slot(handle: number, slot: number, kind: number, key: number, size: number): number
  _xyo_llvm_is_sealed(handle: number): number
  _xyo_llvm_dlopen(handle: number, path: number): number
  _xyo_llvm_dlsym(handle: number, name: number): number
  _xyo_llvm_invoke(handle: number, entry: number): void
  _xyo_llvm_segment_open(handle: number): number
  _xyo_llvm_segment_expect(handle: number, count: number): number
  _xyo_llvm_segment_bind(handle: number, slot: number, kind: number, key: number, size: number): number
  _xyo_llvm_segment_sealed(handle: number): number
  _xyo_llvm_segment_dlopen(handle: number, path: number): number
  _xyo_llvm_segment_dlsym(opened: number, name: number): number
  _xyo_browser_register_segment(handle: number, blockId: number, entry: number, blocks: number): number
  _xyo_browser_clear_segments(handle: number): void
  _xyo_browser_segment_hits(handle: number): number
  _xyo_llvm_release(handle: number): void
}

interface PreparedScript {
  entry: number
}

function decodeProject(bytes: Uint8Array): { project: unknown; assets: Record<string, Uint8Array> } | undefined {
  try {
    const files = unzipSync(bytes) as Record<string, Uint8Array>
    const json = files['project.json']
    if (!json) return undefined
    // Assets (costumes, sounds, fonts) must travel with the re-zipped project or
    // the runtime loses every skin and sound when the splitter rewrites it.
    const assets: Record<string, Uint8Array> = {}
    for (const [name, data] of Object.entries(files)) {
      if (name !== 'project.json' && !name.endsWith('/')) assets[name] = data
    }
    return { project: JSON.parse(new TextDecoder().decode(json)), assets }
  } catch {
    return undefined
  }
}

/**
 * Drives the unified xyo-cpp Wasm runtime: the interpreter owns the whole
 * project (all features), and LLVM side modules run against the *same* Runtime
 * for the scripts the splitter extracted. Values therefore need no commit-back
 * step: both paths mutate one set of variables.
 */
export interface UnifiedEngineOptions {
  /** Open the runtime audio session on green flag; requires a real host transport. */
  audio?: boolean
  /** Attach xyo-cpp's renderer callbacks so collision/pen reach the editor renderer. */
  renderer?: UnifiedRendererOptions
}

export function createUnifiedEngine(m: UnifiedModule, runner: LlvmScriptRunner, options: UnifiedEngineOptions = {}): XyoRuntimeEngine & { readonly fallbacks: number; readonly segments: number; readonly segmentHits: number; readonly llvmStats?: { ms: number; passed: number; total: number }; readonly audio?: XyoAudioAbiAdapter } {
  const handle = m._xyo_browser_create()
  if (!handle) throw new Error('unified runtime: create failed')
  let prepared: PreparedScript[] = []
  let segmentsRegistered = 0
  let llvmStats: { ms: number; passed: number; total: number } | undefined
  let compileTotal = 0
  let compilePassed = 0
  let compileStarted = 0
  let fallbacks = 0
  // The runtime refuses green flag while an audio session is attached, so the
  // session opens after it and closes before the next flag or on teardown.
  const audio = options.audio
    ? new XyoAudioAbiAdapter(new AudioBridge(m as unknown as AudioBridgeModule, handle), 300)
    : undefined
  let audioOpen = false
  let rendererBridge: ReturnType<typeof createUnifiedRendererBridge> | undefined
  // The runtime refuses a new green flag while a session is attached, so every
  // run closes and ACKs the previous session first (documented ABI order).
  const closeAudio = () => {
    if (!audio || !audioOpen) return
    audioOpen = false
    try { audio.close() } catch { return }
    try {
      for (const command of audio.drain()) {
        if (command.type === 'cancel') audio.reply({ type: 'cancelAck', generation: command.generation, ok: true })
      }
    } catch { /* the host tears down the epoch on failure */ }
  }
  let disposed = false
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const withBytes = <T>(bytes: Uint8Array, fn: (pointer: number) => T): T => {
    const pointer = m._malloc(bytes.length || 1)
    m.HEAPU8.set(bytes, pointer)
    try {
      return fn(pointer)
    } finally {
      m._free(pointer)
    }
  }
  const withCString = <T>(text: string, fn: (pointer: number) => T): T => {
    const bytes = encoder.encode(text + '\0')
    return withBytes(bytes, fn)
  }
  const readCString = (pointer: number): string => {
    let end = pointer
    while (m.HEAPU8[end]) end++
    return decoder.decode(m.HEAPU8.subarray(pointer, end))
  }
  const lastError = (): string => {
    const pointer = m._xyo_browser_error(handle)
    return pointer ? readCString(pointer) : ''
  }
  const bindSide = (build: LlvmScriptBuild, hat: string): PreparedScript | null => {
    if (!withCString(hat, (p) => m._xyo_llvm_prepare(handle, p))) return null
    if (!m._xyo_llvm_expect_slots(handle, build.metadata.slots.length)) return null
    m.FS.writeFile('/unified-side.wasm', build.side)
    const opened = withCString('/unified-side.wasm', (p) => m._xyo_llvm_dlopen(handle, p))
    if (!opened) return null
    const symbol = (name: string): number => withCString(name, (p) => m._xyo_llvm_dlsym(opened, p))
    for (const slot of build.metadata.slots) {
      const key = Uint8Array.from(slot.keyHex.match(/../g) ?? [], (b) => parseInt(b, 16))
      const address = symbol(slot.global)
      if (!address) return null
      const bound = withBytes(key, (p) => m._xyo_llvm_bind_slot(handle, address, slot.kind, p, key.length))
      if (bound !== 1) return null
    }
    if (!m._xyo_llvm_is_sealed(handle)) return null
    const entry = symbol('xyo_browser_script')
    return entry ? { entry } : null
  }

  // A segment needs its own binding (strings + slot globals) but no Thread: the
  // runtime supplies the executing thread's JitCtx when it calls the function.
  const registerSegment = (build: LlvmScriptBuild, segment: LlvmSegment): boolean => {
    if (!m._xyo_llvm_segment_open(handle)) return false
    if (!m._xyo_llvm_segment_expect(handle, build.metadata.slots.length)) return false
    m.FS.writeFile('/xyo-segment.wasm', build.side)
    const opened = withCString('/xyo-segment.wasm', (p) => m._xyo_llvm_segment_dlopen(handle, p))
    if (!opened) return false
    const symbol = (name: string): number => withCString(name, (p) => m._xyo_llvm_segment_dlsym(opened, p))
    for (const slot of build.metadata.slots) {
      const key = Uint8Array.from(slot.keyHex.match(/../g) ?? [], (b) => parseInt(b, 16))
      const address = symbol(slot.global)
      if (!address) return false
      const bound = withBytes(key, (p) => m._xyo_llvm_segment_bind(handle, address, slot.kind, p, key.length))
      if (bound !== 1) return false
    }
    if (!m._xyo_llvm_segment_sealed(handle)) return false
    const entry = symbol('xyo_browser_script')
    if (!entry) return false
    return withCString(segment.head, (p) => m._xyo_browser_register_segment(handle, p, entry, segment.blocks.length)) === 1
  }
  const finishCompile = (): void => {
    const elapsed = (globalThis.performance ?? Date).now() - compileStarted
    llvmStats = { ms: Math.round(elapsed * 10) / 10, passed: compilePassed, total: compileTotal }
  }
  const compileSegments = async (source: unknown): Promise<void> => {
    m._xyo_browser_clear_segments(handle)
    const found = findSegments(source)
    if (!found.ok) return
    for (const segment of found.segments) {
      const sb3 = zipSync({ 'project.json': strToU8(JSON.stringify(segment.project)) })
      const built = await runner.buildAdmitted({ project: segment.project, sb3 })
      if (!built.ok) continue
      // A segment that cannot bind simply stays interpreted; it must never be
      // half-registered, because the runtime would call a broken function.
      if (!registerSegment(built.build, segment)) continue
      segmentsRegistered++
      compilePassed++
    }
  }
  return {
    get fallbacks() { return fallbacks },
    get segments() { return segmentsRegistered },
    get segmentHits() { return m._xyo_browser_segment_hits(handle) },
    get llvmStats() { return llvmStats },
    get audio() { return audio },
    get supportsAudio() { return audio !== undefined },
    // Only claim collision support once the renderer bridge is actually attached.
    get collision() { return rendererBridge?.attached ? 'approximate' as const : 'none' as const },
    async loadSb3(bytes) {
      compileStarted = (globalThis.performance ?? Date).now()
      compileTotal = 0
      compilePassed = 0
      llvmStats = undefined
      prepared = []
      fallbacks = 0
      segmentsRegistered = 0
      m._xyo_browser_clear_segments(handle)
      const decoded = decodeProject(bytes)
      const project = decoded?.project
      if (decoded === undefined) {
        // Not a decodable SB3: hand the bytes straight to the interpreter.
        withBytes(bytes, (p) => {
          if (!m._xyo_browser_load_sb3(handle, p, bytes.length)) throw new Error('unified load failed: ' + lastError())
        })
        finishCompile()
        return
      }
      const split = splitProjectForLlvm(project)
      if (!split.ok) {
        withBytes(bytes, (p) => {
          if (!m._xyo_browser_load_sb3(handle, p, bytes.length)) throw new Error('unified load failed: ' + lastError())
        })
        finishCompile()
        return
      }
      // Compile everything before touching the runtime: if any admitted script
      // fails, the project must load whole so the interpreter runs it. Loading
      // the split remainder first would drop that script silently, because its
      // hat is inert there.
      const builds: Array<{ hat: string; build: LlvmScriptBuild }> = []
      let compiled = true
      compileTotal += split.admitted.length
      for (const admitted of split.admitted) {
        const source = zipSync({ 'project.json': strToU8(JSON.stringify(admitted.project)) })
        const built = await runner.buildAdmitted({ project: admitted.project, sb3: source })
        if (!built.ok) { compiled = false; break }
        builds.push({ hat: admitted.hat, build: built.build })
        compilePassed++
      }
      if (!compiled) {
        fallbacks = split.admitted.length
        withBytes(bytes, (p) => {
          if (!m._xyo_browser_load_sb3(handle, p, bytes.length)) throw new Error('unified load failed: ' + lastError())
        })
        if (options.renderer) {
          try { rendererBridge?.dispose() } catch { /* replaced below */ }
          rendererBridge = createUnifiedRendererBridge(m as unknown as RendererHostModule, handle, options.renderer)
        }
        // Segments of the whole project can still run compiled.
        await compileSegments(project)
        finishCompile()
        return
      }
      // The remainder keeps inert hats, so the interpreter starts nothing for
      // compiled scripts while the runtime still knows the hat ids.
      const restBytes = zipSync({ ...decoded.assets, 'project.json': strToU8(JSON.stringify(split.rest)) })
      withBytes(restBytes, (p) => {
        if (!m._xyo_browser_load_sb3(handle, p, restBytes.length)) throw new Error('unified load failed: ' + lastError())
      })
      if (options.renderer) {
        try { rendererBridge?.dispose() } catch { /* replaced below */ }
        rendererBridge = createUnifiedRendererBridge(m as unknown as RendererHostModule, handle, options.renderer)
      }
      for (const { hat, build } of builds) {
        const session = bindSide(build, hat)
        if (session) { prepared.push(session); continue }
        // A bind failure means the split project cannot host the compiled
        // script either; fall back to the whole project so nothing is lost.
        fallbacks++
        prepared = []
        m._xyo_llvm_release(handle)
        withBytes(bytes, (p) => {
          if (!m._xyo_browser_load_sb3(handle, p, bytes.length)) throw new Error('unified load failed: ' + lastError())
        })
        if (options.renderer) {
          try { rendererBridge?.dispose() } catch { /* replaced below */ }
          rendererBridge = createUnifiedRendererBridge(m as unknown as RendererHostModule, handle, options.renderer)
        }
        await compileSegments(project)
        finishCompile()
        return
      }
      await compileSegments(split.rest)
      finishCompile()
    },
    greenFlagCompiled() {
      closeAudio()
      if (!m._xyo_browser_green_flag(handle)) throw new Error('unified green flag failed: ' + lastError())
      for (const session of prepared) m._xyo_llvm_invoke(handle, session.entry)
      if (audio && !audioOpen) { audio.open(); audioOpen = true }
    },
    step() {
      if (!m._xyo_browser_step(handle)) throw new Error('unified step failed: ' + lastError())
    },
    stop() { closeAudio(); m._xyo_browser_stop(handle) },
    snapshot() {
      const pointer = m._xyo_browser_snapshot(handle)
      return pointer ? JSON.parse(readCString(pointer)) : undefined
    },
    key(key, down, keyCode) {
      const bytes = encoder.encode(key)
      withBytes(bytes, (p) => m._xyo_browser_key(handle, p, bytes.length, down ? 1 : 0, keyCode ?? -1))
    },
    mouse(x, y, width, height, down, button, dragged) {
      m._xyo_browser_mouse(handle, x, y, width, height, down ? 1 : 0, button ?? 0, dragged ? 1 : 0)
    },
    wheel(dx, dy) { m._xyo_browser_wheel(handle, dx, dy) },
    answer(text) {
      const bytes = encoder.encode(text)
      withBytes(bytes, (p) => m._xyo_browser_answer(handle, p, bytes.length))
    },
    answerIfQuestion(questionId, text) {
      const idBytes = encoder.encode(questionId)
      const bytes = encoder.encode(text)
      const idPointer = m._malloc(idBytes.length || 1)
      m.HEAPU8.set(idBytes, idPointer)
      const pointer = m._malloc(bytes.length || 1)
      m.HEAPU8.set(bytes, pointer)
      try {
        // 1 applied, -1 stale/absent (no side effects), 0 on error.
        return m._xyo_browser_answer_if_question(handle, idPointer, idBytes.length, pointer, bytes.length) === 1
      } finally {
        m._free(pointer)
        m._free(idPointer)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      try { rendererBridge?.dispose() } catch { /* the runtime is going away anyway */ }
      rendererBridge = undefined
      closeAudio()
      m._xyo_llvm_release(handle)
      m._xyo_browser_destroy(handle)
    },
  }
}
