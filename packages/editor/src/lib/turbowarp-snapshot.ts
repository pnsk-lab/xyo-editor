import { normalizeProject, type RuntimeSnapshot, type ScratchValue } from '@hikkaku/vm'

/**
 * Best-effort, detached view of a live TurboWarp Scaffolding VM, not a resumable VM state.
 * Sources: TurboWarp scratch-vm develop: sprites/rendered-target.js, engine/runtime.js,
 * engine/thread.js, engine/tw-monitor-state.js, engine/monitor-record.js and
 * serialization/sb3.js (https://github.com/TurboWarp/scratch-vm/tree/develop/src).
 * Compiled threads do not expose their current block reliably; layer order falls back to
 * executableTargets order without a renderer. Compatibility mode is inferred from FPS.
 * Extension state, pen/bubbles, asset bytes and executable thread stacks are not captured.
 */
type Dict = Record<string, any>
const obj = (value: unknown): Dict => value && typeof value === 'object' ? value as Dict : {}
const scalar = (value: unknown): ScratchValue => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : String(value ?? '')
const plain = (value: any): any => value && typeof value.toJS === 'function' ? value.toJS() : value

function blocksOf(target: Dict): Dict {
  const result: Dict = {}
  for (const [id, raw] of Object.entries(obj(obj(target.blocks)._blocks))) {
    const b = obj(raw)
    const fields: Dict = {}
    const inputs: Dict = {}
    for (const [key, field] of Object.entries(obj(b.fields))) {
      const f = obj(field)
      fields[key] = f.id == null ? [String(f.value ?? '')] : [String(f.value ?? ''), String(f.id)]
    }
    for (const [key, input] of Object.entries(obj(b.inputs))) {
      const i = obj(input)
      inputs[key] = i.block === i.shadow ? [1, i.block ?? null] : i.shadow == null ? [2, i.block ?? null] : [3, i.block ?? null, i.shadow]
    }
    result[id] = { opcode: b.opcode, next: b.next ?? null, parent: b.parent ?? null, fields, inputs, shadow: !!b.shadow, topLevel: !!b.topLevel, ...(b.x == null ? {} : { x: b.x }), ...(b.y == null ? {} : { y: b.y }), ...(b.comment ? { comment: b.comment } : {}), ...(b.mutation ? { mutation: structuredClone(b.mutation) } : {}) }
  }
  return result
}

function assets(input: unknown): Dict[] {
  return (Array.isArray(input) ? input : []).map((item: unknown) => {
    const asset = obj(item)
    const source = obj(asset.broken || asset)
    return Object.fromEntries(['name', 'assetId', 'dataFormat', 'bitmapResolution', 'rotationCenterX', 'rotationCenterY', 'format', 'rate', 'sampleCount'].flatMap(key => (key === 'name' ? asset[key] : source[key]) == null ? [] : [[key, key === 'name' ? asset[key] : source[key]]]).concat(source.md5 || source.md5ext ? [['md5ext', source.md5 || source.md5ext]] : []))
  })
}

/** Convert vm.runtime (or a Scaffolding instance's vm.runtime) to a RuntimeSnapshot. */
export function turboWarpSnapshot(vm: unknown): RuntimeSnapshot {
  const root = obj(vm)
  const machine = root.runtime ? root : obj(root.vm)
  const runtime = obj(machine.runtime)
  if (!Array.isArray(runtime.targets)) throw new TypeError('Expected a TurboWarp VM or Scaffolding instance with vm.runtime.targets')
  const originals = new Map<unknown, string>()
  for (const target of runtime.targets) if (target.isOriginal !== false && typeof target.id === 'string') originals.set(target.sprite, target.id)
  const targets = runtime.targets.map((target: Dict, index: number) => {
    const sprite = obj(target.sprite)
    const variables: Dict = {}, lists: Dict = {}, broadcasts: Dict = {}
    for (const [id, raw] of Object.entries(obj(target.variables))) {
      const variable = obj(raw)
      if (variable.type === 'broadcast_msg') broadcasts[id] = String(variable.value ?? variable.name ?? '')
      else if (variable.type === 'list') lists[id] = [String(variable.name ?? ''), (Array.isArray(variable.value) ? variable.value : []).map(scalar)]
      else variables[id] = variable.isCloud ? [String(variable.name ?? ''), scalar(variable.value), true] : [String(variable.name ?? ''), scalar(variable.value)]
    }
    const layer = typeof target.getLayerOrder === 'function' ? target.getLayerOrder() : null
    const order = Array.isArray(runtime.executableTargets) ? runtime.executableTargets.indexOf(target) : -1
    return {
      id: target.id, isStage: !!target.isStage, name: sprite.name ?? (target.isStage ? 'Stage' : `Sprite${index}`), variables, lists, broadcasts,
      blocks: blocksOf(target), comments: structuredClone(obj(target.comments)), costumes: assets(sprite.costumes), sounds: assets(sprite.sounds),
      currentCostume: target.currentCostume, volume: target.volume, layerOrder: typeof layer === 'number' ? layer : order >= 0 ? order : index,
      tempo: target.tempo, videoTransparency: target.videoTransparency, videoState: target.videoState, textToSpeechLanguage: target.textToSpeechLanguage,
      visible: target.visible, drawableId: target.drawableID, x: target.x, y: target.y, direction: target.direction, size: target.size,
      draggable: target.draggable, rotationStyle: target.rotationStyle, effects: { ...obj(target.effects) },
      isClone: target.isOriginal === false, cloneOf: target.isOriginal === false ? originals.get(target.sprite) : undefined,
    }
  })
  const state = obj(runtime._monitorState)
  const values = typeof state.valueSeq === 'function' ? state.valueSeq() : state.map instanceof Map ? [...state.map.values()] : []
  const monitors = Array.from(values as Iterable<unknown>, value => {
    const m = obj(plain(value))
    const params = Object.fromEntries(Object.entries(obj(plain(m.params))).map(([key, val]) => [key, scalar(val)]))
    const v = plain(m.value)
    return { ...m, params, value: Array.isArray(v) ? v.map(scalar) : v == null ? undefined : scalar(v) }
  })
  const project = normalizeProject({ targets, monitors, extensions: [], meta: { origin: runtime.origin } })
  // normalizeProject inserts a default sprite when a stage-only project is loaded and
  // clamps positions. Runtime snapshots must reflect the actual live targets instead.
  project.targets = project.targets.slice(0, targets.length)
  for (let i = 0; i < targets.length; i++) {
    const source = targets[i], destination = project.targets[i]
    if (!destination) continue
    if (!source.isStage) for (const key of ['x', 'y', 'size', 'direction'] as const) if (typeof source[key] === 'number') destination[key] = source[key]
  }
  const threads = (Array.isArray(runtime.threads) ? runtime.threads : []).filter((t: Dict) => !t.updateMonitor).map((t: Dict) => ({
    targetName: obj(t.target?.sprite).name ?? '', topBlockId: String(t.topBlock ?? ''),
    currentBlockId: t.isCompiled ? null : Array.isArray(t.stack) ? t.stack.at(-1) ?? null : null,
    status: t.isKilled || t.status === 4 ? 'done' as const : t.status === 1 || t.status === 2 || t.status === 3 ? 'waiting' as const : 'running' as const,
  }))
  const editing = machine.editingTarget ?? runtime._editingTarget
  const selectedTargetId = project.targets.some(t => t.id === editing?.id) ? editing.id : project.targets.find(t => !t.isClone && !t.isStage)?.id ?? project.targets[0]?.id ?? ''
  const fps = obj(runtime.frameLoop).framerate
  return { project, selectedTargetId, origin: typeof runtime.origin === 'string' ? runtime.origin : null, running: threads.some((t: { status: string }) => t.status !== 'done'), turboMode: !!runtime.turboMode, compatibilityMode: fps === 30, threads }
}
