/** Minimal TurboWarp runtime surface used for editor block clicks. */
export interface TurboWarpClickTarget {
  id: string
  blocks: { getBlock(id: string): unknown }
}

export interface TurboWarpClickRuntime {
  targets: unknown[]
  toggleScript(blockId: string, options: { target: TurboWarpClickTarget; stackClick: true }): void
  setEditingTarget(target: TurboWarpClickTarget): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * Bridge editor clicks to a synchronized TurboWarp runtime. The host must make
 * isCurrent false during loading, after invalidation, and after disposal.
 * Reporter results arrive via VISUAL_REPORT, potentially asynchronously; this
 * is deliberately not compatible with reportBlockValue's synchronous result.
 * TurboWarp emits reports only for its editing target, which this bridge sets.
 */
export function createTurboWarpBlockExecution(options: {
  runtime: TurboWarpClickRuntime
  runtimeTargetId(modelTargetId: string): string | undefined
  isCurrent(): boolean
  report(payload: { id: string; value: string }): void
}) {
  const { runtime } = options
  let disposed = false
  const listener = (payload: unknown) => {
    if (disposed || !options.isCurrent() || !payload || typeof payload !== 'object') return
    const value = payload as { id?: unknown; value?: unknown }
    if (typeof value.id !== 'string' || typeof value.value !== 'string') return
    options.report({ id: value.id, value: value.value })
  }
  runtime.on('VISUAL_REPORT', listener)

  function click(blockId: string, modelTargetId: string): void {
    if (disposed) throw new Error('TurboWarp block execution is disposed')
    if (!options.isCurrent()) throw new Error('TurboWarp project is not synchronized')
    if (!blockId || !modelTargetId) throw new Error('TurboWarp block and target IDs are required')
    const runtimeId = options.runtimeTargetId(modelTargetId)
    if (!runtimeId) throw new Error(`TurboWarp target could not be mapped: ${modelTargetId}`)
    const matches = runtime.targets.filter((target): target is TurboWarpClickTarget =>
      !!target && typeof target === 'object' && (target as { id?: unknown }).id === runtimeId)
    if (matches.length !== 1) throw new Error(`TurboWarp target is missing or ambiguous: ${runtimeId}`)
    const target = matches[0]
    if (!target.blocks || typeof target.blocks.getBlock !== 'function' || !target.blocks.getBlock(blockId)) {
      throw new Error(`TurboWarp block not found on target: ${blockId}`)
    }
    runtime.setEditingTarget(target)
    runtime.toggleScript(blockId, { target, stackClick: true })
  }

  return {
    /** Pass the root block for commands, but the clicked block itself for reporters. */
    click,
    dispose() {
      if (disposed) return
      disposed = true
      runtime.removeListener('VISUAL_REPORT', listener)
    },
  }
}
