/**
 * An adapter for a headless runtime. greenFlag must actually request compiled
 * execution: the existing interpreter-only greenFlagInterpreter is not a
 * substitute. Adapters may proxy these methods to a worker.
 */
export interface CompiledHeadlessRuntime {
  loadSb3(bytes: Uint8Array): void | Promise<void>
  greenFlag(): void | Promise<void>
  step(): void | Promise<void>
  stop(): void | Promise<void>
  dispose(): void | Promise<void>
}

export type FlagResult = 'applied' | 'stale'

/**
 * Serializes capture -> load -> compiled green flag and subsequent steps.
 * Call edited() for every project edit before accepting another step. Capture
 * must produce an SB3 snapshot of the project at the time it is invoked.
 *
 * Invalidation discards obsolete completions; it does not interrupt an in-flight
 * operation. In particular, a worker cannot process stop messages during a
 * synchronous WASM compile. Immediate interruption requires terminating that
 * worker externally and creating a new runtime/controller. This class does not
 * own or terminate a worker and cannot undo effects already performed by it.
 */
export class FlagCompileController {
  private generation = 0
  private disposed = false
  private ready = false
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly runtime: CompiledHeadlessRuntime,
    private readonly capture: () => Promise<Uint8Array>,
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private valid(generation: number): boolean {
    return !this.disposed && this.generation === generation
  }

  /** A new flag invalidates previous requests immediately, even while capturing. */
  flag(): Promise<FlagResult> {
    if (this.disposed) return Promise.reject(new Error('Controller is disposed'))
    const generation = ++this.generation
    this.ready = false
    return this.enqueue(async () => {
      if (!this.valid(generation)) return 'stale'
      try {
        const bytes = await this.capture()
        if (!this.valid(generation)) return 'stale'
        await this.runtime.loadSb3(bytes)
        if (!this.valid(generation)) return 'stale'
        await this.runtime.greenFlag()
        if (!this.valid(generation)) return 'stale'
        this.ready = true
        return 'applied'
      } catch (error) {
        if (!this.valid(generation)) return 'stale'
        throw error
      }
    })
  }

  /** Only a successful, still-current flag can be stepped. */
  step(): Promise<FlagResult> {
    if (this.disposed) return Promise.reject(new Error('Controller is disposed'))
    const generation = this.generation
    return this.enqueue(async () => {
      if (!this.valid(generation) || !this.ready) return 'stale'
      try {
        await this.runtime.step()
        return this.valid(generation) ? 'applied' : 'stale'
      } catch (error) {
        if (!this.valid(generation)) return 'stale'
        throw error
      }
    })
  }

  /** Invalidate on edit and stop the previous runtime once outstanding work finishes. */
  edited(): Promise<void> { return this.stop() }

  stop(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Controller is disposed'))
    ++this.generation
    this.ready = false
    return this.enqueue(async () => { await this.runtime.stop() })
  }

  /** Dispose once queued work has settled; repeated disposal shares the same promise. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    ++this.generation
    this.ready = false
    this.disposal = this.enqueue(async () => { await this.runtime.dispose() })
    return this.disposal
  }
  private disposal?: Promise<void>
}
