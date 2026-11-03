import type { RuntimeSnapshot, ScratchTarget, ScratchValue } from '../../vm/src/index'

/** JSON emitted by browser.cpp. This is a visual/data view, not resumable VM state. */
export interface XyoSnapshot {
  targets: XyoTarget[]
  threadCount: number
  stepSerial: number
  io?: { answer?: string; question?: string | null; questionId?: string | null }
}
export interface XyoTarget {
  id: string
  name: string
  isStage: boolean
  isOriginal: boolean
  x: number
  y: number
  direction: number
  size: number
  volume?: number
  visible: boolean
  currentCostume: number
  layerOrder: number
  bubbleText: string
  bubbleType: string
  variables: Record<string, { name: string; type: string; value: ScratchValue | ScratchValue[] }>
}

const fail = (reason: string): never => { throw new Error(`Cannot overlay xyo snapshot: ${reason}`) }
const scalar = (v: unknown): v is ScratchValue => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/**
 * Overlay the fields actually exposed by the headless bridge onto a detached editor
 * snapshot. Original targets are matched by stage or unique sprite name, not xyo's
 * regenerated IDs. Variable IDs are matched first, then by unique name and type.
 * Ambiguous, missing or conflicting identities throw rather than guess. Clones use
 * xyo IDs and the matched original's editor ID as cloneOf. Selected target, blocks,
 * assets, monitor metadata, execution flags and threads remain model state. Data
 * monitor values are refreshed from matched originals; other reporters are not
 * evaluated. threadCount cannot reconstruct execution or establish compatibility.
 */
export function overlayXyoSnapshot(model: RuntimeSnapshot, input: XyoSnapshot): RuntimeSnapshot {
  const out = structuredClone(model)
  if (!input || !Array.isArray(input.targets)) fail('invalid targets')
  const originals = out.project.targets.filter(t => !t.isClone)
  const runtimeOriginals = input.targets.filter(t => t && t.isOriginal === true)
  const stage = originals.filter(t => t.isStage)
  if (stage.length !== 1 || runtimeOriginals.filter(t => t.isStage).length !== 1) fail('stage is not unique')
  const cloneBases = new Map(originals.map(t => [t, structuredClone(t)]))
  const used = new Set<ScratchTarget>()
  const idSet = new Set<string>()
  const modelIds = new Set(originals.map(t => t.id ?? t.name))
  if (modelIds.size !== originals.length) fail('duplicate model target IDs')
  const mapping = new Map<XyoTarget, ScratchTarget>()
  for (const t of runtimeOriginals) {
    const matches = t.isStage ? stage : originals.filter(m => !m.isStage && m.name === t.name)
    if (matches.length !== 1 || used.has(matches[0])) fail(`ambiguous original ${t.name}`)
    used.add(matches[0]); mapping.set(t, matches[0])
  }
  if (used.size !== originals.length) fail('missing original target')
  const result: ScratchTarget[] = []
  for (const t of input.targets) {
    if (!t || typeof t.id !== 'string' || !t.id || typeof t.name !== 'string' || typeof t.isStage !== 'boolean' || typeof t.isOriginal !== 'boolean' || idSet.has(t.id)) fail('invalid or duplicate runtime target ID')
    idSet.add(t.id)
    let target = mapping.get(t)
    if (!target) {
      if (t.isOriginal || t.isStage) fail('invalid clone')
      const matches = originals.filter(m => !m.isStage && m.name === t.name)
      if (matches.length !== 1 || modelIds.has(t.id)) fail(`ambiguous clone ${t.name}`)
      target = structuredClone(cloneBases.get(matches[0])!)
      target.id = t.id; target.isClone = true; target.cloneOf = matches[0].id ?? matches[0].name
    }
    for (const key of ['x', 'y', 'direction', 'size', 'currentCostume', 'layerOrder'] as const) {
      if (typeof t[key] !== 'number' || !Number.isFinite(t[key])) fail(`invalid ${key}`)
      target[key] = t[key]
    }
    if (t.volume !== undefined) {
      if (typeof t.volume !== 'number' || !Number.isFinite(t.volume)) fail('invalid volume')
      target.volume = t.volume
    }
    if (typeof t.visible !== 'boolean') fail('invalid visibility')
    target.visible = t.visible
    if (typeof t.bubbleText !== 'string' || typeof t.bubbleType !== 'string') fail('invalid speech bubble')
    if (!t.bubbleText) delete target.speechBubble
    else {
      if (t.bubbleType !== 'say' && t.bubbleType !== 'think') fail('invalid speech bubble type')
      target.speechBubble = { type: t.bubbleType as 'say' | 'think', text: t.bubbleText }
    }
    if (!t.variables || typeof t.variables !== 'object' || Array.isArray(t.variables)) fail('invalid variables')
    const assigned = new Set<string>()
    for (const [id, v] of Object.entries(t.variables)) {
      if (!v || typeof v.name !== 'string' || typeof v.type !== 'string') fail('invalid variable')
      if (v.type === 'broadcast_msg') continue
      if (v.type !== '' && v.type !== 'list') fail(`unknown variable type ${v.type}`)
      const records = v.type === 'list' ? target.lists : target.variables
      const byId = Object.prototype.hasOwnProperty.call(records, id) ? id : undefined
      if (byId && records[byId][0] !== v.name) fail(`conflicting variable ID ${id}`)
      const matches = Object.keys(records).filter(k => records[k][0] === v.name)
      const dest = byId ?? (matches.length === 1 ? matches[0] : undefined) ?? fail(`ambiguous variable ${v.name}`)
      if (assigned.has(`${v.type}:${dest}`)) fail(`ambiguous variable ${v.name}`)
      assigned.add(`${v.type}:${dest}`)
      if (v.type === 'list') {
        if (!Array.isArray(v.value) || !v.value.every(scalar)) fail(`invalid list ${v.name}`)
        target.lists[dest] = [target.lists[dest][0], [...v.value as ScratchValue[]]]
      } else {
        if (!scalar(v.value)) fail(`invalid variable value ${v.name}`)
        target.variables[dest][1] = v.value as ScratchValue
      }
    }
    result.push(target)
  }
  out.project.targets = result
  refreshMonitors(out, input.io)
  return out
}

/** Refresh available monitor values without rewriting monitor metadata. */
function refreshMonitors(snapshot: RuntimeSnapshot, io?: XyoSnapshot['io']): void {
  const originals = snapshot.project.targets.filter(t => !t.isClone)
  const stage = originals.find(t => t.isStage)!
  for (const monitor of snapshot.project.monitors) {
    if (monitor.opcode === 'sensing_answer') {
      if (typeof io?.answer === 'string') monitor.value = io.answer
      continue
    }
    if (['motion_xposition', 'motion_yposition', 'motion_direction', 'looks_size', 'looks_costumenumbername', 'looks_backdropnumbername', 'sound_volume'].includes(monitor.opcode)) {
      const split = monitor.id.lastIndexOf(':')
      const prefix = split < 0 ? '' : monitor.id.slice(0, split)
      const named = monitor.spriteName ? originals.filter(t => !t.isStage && t.name === monitor.spriteName) : []
      const prefixed = prefix ? originals.filter(t => (t.id ?? t.name) === prefix || t.name === prefix) : []
      if ((monitor.spriteName && named.length !== 1) || prefixed.length > 1) fail(`ambiguous monitor sprite ${monitor.spriteName ?? prefix}`)
      if (named.length && prefixed.length && named[0] !== prefixed[0]) fail(`conflicting monitor target ${monitor.id}`)
      const target = monitor.opcode === 'looks_backdropnumbername' ? stage : named[0] ?? prefixed[0] ?? stage
      if (monitor.opcode === 'looks_costumenumbername' || monitor.opcode === 'looks_backdropnumbername') {
        const index = target.currentCostume
        if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
          monitor.value = monitor.params.NUMBER_NAME === 'name' ? target.costumes[index]?.name ?? '' : index + 1
        }
      } else {
        const value = monitor.opcode === 'motion_xposition' ? target.x
          : monitor.opcode === 'motion_yposition' ? target.y
            : monitor.opcode === 'motion_direction' ? target.direction
              : monitor.opcode === 'sound_volume' ? target.volume : target.size
        if (typeof value === 'number' && Number.isFinite(value)) monitor.value = value
      }
      continue
    }
    if (monitor.opcode !== 'data_variable' && monitor.opcode !== 'data_listcontents') continue
    const isList = monitor.opcode === 'data_listcontents'
    const param = monitor.params[isList ? 'LIST' : 'VARIABLE']
    const name = typeof param === 'string' ? param : ''
    const split = monitor.id.lastIndexOf(':')
    const prefix = split < 0 ? '' : monitor.id.slice(0, split)
    const prefixedTargets = prefix ? originals.filter(t => (t.id ?? t.name) === prefix || t.name === prefix) : []
    if (prefixedTargets.length > 1) fail(`ambiguous monitor target ${prefix}`)
    const namedTargets = monitor.spriteName ? originals.filter(t => !t.isStage && t.name === monitor.spriteName) : []
    if (monitor.spriteName && namedTargets.length !== 1) fail(`ambiguous monitor sprite ${monitor.spriteName}`)
    if (namedTargets.length && prefixedTargets.length && namedTargets[0] !== prefixedTargets[0]) fail(`conflicting monitor target ${monitor.id}`)
    const target = namedTargets[0] ?? prefixedTargets[0] ?? stage
    const scopes = target === stage ? [stage] : [target, stage]
    const records = (t: ScratchTarget) => isList ? t.lists : t.variables
    // A full ID can itself contain colons. Only then try the VM's target:id tail.
    const ids = [monitor.id, ...(split >= 0 ? [monitor.id.slice(split + 1)] : [])]
    let entry: (typeof target.variables)[string] | (typeof target.lists)[string] | undefined
    for (const id of ids) {
      const found = scopes.flatMap(t => Object.prototype.hasOwnProperty.call(records(t), id) ? [records(t)[id]] : [])
      if (found.length > 1) fail(`ambiguous monitor ID ${id}`)
      if (found.length) { entry = found[0]; break }
    }
    if (entry && name && entry[0] !== name) fail(`conflicting monitor ID ${monitor.id}`)
    if (!entry && name) {
      // Local names shadow stage names, as in VM variableRecord/listRecord.
      for (const scope of scopes) {
        const found = Object.values(records(scope)).filter(record => record[0] === name)
        if (found.length > 1) fail(`ambiguous monitor name ${name}`)
        if (found.length) { entry = found[0]; break }
      }
    }
    if (entry) monitor.value = Array.isArray(entry[1]) ? [...entry[1]] : entry[1]
  }
}
