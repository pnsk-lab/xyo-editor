export interface TurboWarpFrameLoop {
  running: boolean
  stop(): void
  start(): void
  stepCallback(): void
}

export interface TurboWarpStepHost {
  runtime: { frameLoop: TurboWarpFrameLoop }
  /** Must reflect the host lifecycle, including changes made during callbacks. */
  isDisposed(): boolean
  isLoading(): boolean
}

// A lock per loop, rather than per helper: two helpers cannot recursively step it.
const stepping = new WeakSet<TurboWarpFrameLoop>()
const stopRevisions = new WeakMap<TurboWarpFrameLoop, number>()

/**
 * Single-frame control for TurboWarp's self-scheduling frame loop.
 * The owner must call requestStop() when it requests a stop during step(), even
 * if it also calls frameLoop.stop(): the loop is already temporarily stopped and
 * its running flag alone cannot distinguish that request from our pause.
 * Lifecycle changes must be visible through the host predicates. This helper
 * neither owns the loop nor changes project/thread running state.
 */
export function createTurboWarpStep(host: TurboWarpStepHost) {
  return {
    requestStop(): void {
      const loop = host.runtime.frameLoop
      stopRevisions.set(loop, (stopRevisions.get(loop) ?? 0) + 1)
    },
    step(): void {
      if (host.isDisposed()) throw new Error('TurboWarp runtime is disposed')
      if (host.isLoading()) throw new Error('TurboWarp project is loading')
      const loop = host.runtime.frameLoop
      if (stepping.has(loop)) throw new Error('TurboWarp step is already in progress')
      stepping.add(loop)
      const revision = stopRevisions.get(loop) ?? 0
      let wasRunning = false
      let stopped = false
      let failed = false
      let failure: unknown
      try {
        wasRunning = loop.running
        if (wasRunning) {
          loop.stop()
          stopped = true
        }
        // stop() may synchronously invoke host code or throw.
        if (host.isDisposed()) throw new Error('TurboWarp runtime is disposed')
        if (host.isLoading()) throw new Error('TurboWarp project is loading')
        loop.stepCallback()
      } catch (error) {
        failed = true
        failure = error
      } finally {
        try {
          if (wasRunning && stopped && revision === (stopRevisions.get(loop) ?? 0) && host.runtime.frameLoop === loop && !host.isDisposed() && !host.isLoading() && !loop.running) loop.start()
        } catch (error) {
          // Preserve both failures if restoring the loop also fails.
          if (failed) failure = new AggregateError([failure, error], 'TurboWarp step and loop restoration failed')
          else { failed = true; failure = error }
        } finally {
          stepping.delete(loop)
        }
      }
      if (failed) throw failure
    },
  }
}
