/**
 * Segment compilation: pick out the maximal runs of blocks that can be
 * compiled and run to completion *inside* a script the interpreter drives.
 *
 * The interpreter yields at loop tails and wait blocks, and a compiled Wasm
 * function cannot be suspended (there is no stack switching), so compiling a
 * whole script is only possible when it has no yield point at all. Compiling
 * the yield-free runs between those points keeps the interpreter as the driver
 * — the runtime calls one function and then skips the blocks it consumed —
 * while still replacing the per-block dispatch with compiled code.
 *
 * Only blocks this project's compiler actually supports are eligible: a
 * straight-line run of variable set/change with a numeric shadow. Control
 * blocks, substacks, reporters and any other opcode end a run.
 */

const PLAIN_OPCODES = new Set(['data_setvariableto', 'data_changevariableby'])

export interface LlvmSegment {
  /** Index into `project.targets`. */
  target: number
  /** First block of the run; the runtime calls the function when a thread reaches it. */
  head: string
  /** Block ids in execution order, head first. */
  blocks: string[]
  /** Single-script project the existing compiler accepts unchanged. */
  project: unknown
}

export interface SegmentResult {
  ok: boolean
  error?: string
  segments: LlvmSegment[]
  skipped: number
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Synthetic hat so the compiler sees an ordinary flag script. */
const SYNTHETIC_HAT = '__xyo_segment_hat'

function readTargets(project: unknown): Json[] | null {
  if (!isObject(project)) return null
  const targets = project.targets
  return Array.isArray(targets) ? (targets.filter(isObject) as Json[]) : null
}

/** True when the block can be compiled and leaves the thread stack untouched. */
function isPlain(block: Json): boolean {
  if (typeof block.opcode !== 'string' || !PLAIN_OPCODES.has(block.opcode)) return false
  if (block.mutation !== undefined) return false
  if (!isObject(block.fields) || !isObject(block.inputs)) return false
  // Scratch fields are [name, id] pairs (arrays), not objects.
  const variable = block.fields.VARIABLE
  if (!Array.isArray(variable) || variable.length < 2) return false
  const names = Object.keys(block.inputs)
  return names.length === 1 && names[0] === 'VALUE'
}

export function findSegments(project: unknown, minLength = 2): SegmentResult {
  const targets = readTargets(project)
  if (!targets) return { ok: false, error: 'not a project object', segments: [], skipped: 0 }
  const segments: LlvmSegment[] = []
  let skipped = 0
  for (let ti = 0; ti < targets.length; ti++) {
    const target = targets[ti]!
    const blocks = isObject(target.blocks) ? (target.blocks as Json) : null
    if (!blocks) continue
    for (const hat of Object.values(blocks)) {
      if (!isObject(hat) || hat.topLevel !== true || typeof hat.next !== 'string' || !hat.next) continue
      let run: string[] = []
      const flush = () => {
        if (run.length >= minLength) {
          const segment = synthesize(ti, target, blocks, run)
          if (segment) segments.push(segment)
          else skipped += run.length
        } else if (run.length) {
          skipped += run.length
        }
        run = []
      }
      const seen = new Set<string>()
      // Walks `next` chains and descends into substacks (input form [2, id]);
      // any non-plain block ends the current run.
      const walk = (start: string | undefined): void => {
        let current = start
        while (current && !seen.has(current)) {
          seen.add(current)
          const block = blocks[current]
          if (!isObject(block)) break
          if (isPlain(block)) {
            run.push(current)
            current = typeof block.next === 'string' && block.next ? block.next : undefined
            continue
          }
          flush()
          if (isObject(block.inputs)) {
            for (const input of Object.values(block.inputs)) {
              if (!Array.isArray(input) || input.length < 2) continue
              if (input[0] !== 2 || typeof input[1] !== 'string') continue
              walk(input[1])
            }
          }
          current = typeof block.next === 'string' && block.next ? block.next : undefined
        }
        flush()
      }
      walk(hat.next)
    }
  }
  return { ok: true, segments, skipped }
}

/** Copies the target with a synthetic hat wrapped around exactly this run. */
function synthesize(index: number, target: Json, blocks: Json, run: string[]): LlvmSegment | null {
  const subset: Json = {}
  for (const id of run) {
    const block = blocks[id]
    if (!isObject(block)) return null
    subset[id] = JSON.parse(JSON.stringify(block))
  }
  // The last block must end the script so the compiler stops at the segment.
  const tail = subset[run[run.length - 1]!] as Json
  tail.next = null
  const head = run[0]!
  ;(subset[head] as Json).parent = SYNTHETIC_HAT
  subset[SYNTHETIC_HAT] = {
    opcode: 'event_whenflagclicked', next: head, parent: null, inputs: {}, fields: {},
    topLevel: true, x: 0, y: 0,
  }
  const single: Json = { ...(JSON.parse(JSON.stringify(target)) as Json), blocks: subset }
  return {
    target: index,
    head,
    blocks: [...run],
    project: { targets: [single], monitors: [], extensions: [], meta: { semver: '3.0.0' } },
  }
}
