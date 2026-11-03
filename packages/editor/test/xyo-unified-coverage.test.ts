import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { createUnifiedEngine, type UnifiedModule } from '../src/lib/xyo-unified-engine'
import type { LlvmScriptRunner } from '../src/lib/llvm-backend'

// Feature coverage over the real unified runtime: hand-checked value cases plus
// a corpus pass over real projects (upstream fixtures and editor artifacts) so
// procedures, clones, broadcasts and pen at least load and step without error.
const build = join(import.meta.dir, '..', '..', 'llvm-wasm', '.work', 'unified-build')
const available = existsSync(join(build, 'unified_runtime.wasm'))
const upstream = join(
  import.meta.dir,
  '..',
  '..',
  'xyo-cpp-wasm',
  '.work',
  'xyo-cpp',
  'tests',
  'fixtures',
)
const artifacts = join(import.meta.dir, '..', 'test-artifacts')

async function loadModule(): Promise<UnifiedModule> {
  const require = createRequire(import.meta.url)
  writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}\n')
  const loaded = require(join(build, 'unified_runtime.js'))
  const factory = typeof loaded === 'function' ? loaded : loaded.default
  const wasm = readFileSync(join(build, 'unified_runtime.wasm'))
  const compiled = new WebAssembly.Module(wasm)
  return (await factory({
    wasmBinary: wasm,
    instantiateWasm(imports: Record<string, unknown>, ready: (i: unknown, m: unknown) => void) {
      const instance = new WebAssembly.Instance(compiled, imports as WebAssembly.Imports)
      ready(instance, compiled)
      return instance.exports
    },
  })) as UnifiedModule
}

type Snapshot = {
  threadCount: number
  stepSerial: number
  targets: Array<{
    name: string
    isOriginal: boolean
    x: number
    y: number
    bubbleText?: string
    variables: Record<string, { value: unknown }>
    lists?: Record<string, { value: unknown[] }>
  }>
}

function withHandle<T>(m: UnifiedModule, bytes: Uint8Array, fn: (handle: number) => T): T {
  const handle = m._xyo_browser_create()
  const p = m._malloc(bytes.length)
  m.HEAPU8.set(bytes, p)
  const loaded = m._xyo_browser_load_sb3(handle, p, bytes.length)
  m._free(p)
  try {
    if (!loaded) {
      let end = m._xyo_browser_error(handle)
      let n = end
      while (m.HEAPU8[n]) n++
      throw new Error('load failed: ' + new TextDecoder().decode(m.HEAPU8.subarray(end, n)))
    }
    return fn(handle)
  } finally {
    m._xyo_browser_destroy(handle)
  }
}

function readSnapshot(m: UnifiedModule, handle: number): Snapshot {
  const ptr = m._xyo_browser_snapshot(handle)
  let n = ptr
  while (m.HEAPU8[n]) n++
  return JSON.parse(new TextDecoder().decode(m.HEAPU8.subarray(ptr, n))) as Snapshot
}

function run(m: UnifiedModule, project: unknown, steps = 30): Snapshot {
  const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
  return withHandle(m, bytes, (handle) => {
    if (!m._xyo_browser_green_flag(handle)) throw new Error('green flag failed')
    for (let i = 0; i < steps; i++) m._xyo_browser_step(handle)
    return readSnapshot(m, handle)
  })
}

const hat = (next: string) => ({
  opcode: 'event_whenflagclicked',
  next,
  parent: null,
  inputs: {},
  fields: {},
  topLevel: true,
  x: 0,
  y: 0,
})
const stage = (
  blocks: Record<string, unknown>,
  variables: Record<string, unknown> = {},
  lists: Record<string, unknown> = {},
) => ({
  isStage: true,
  name: 'Stage',
  variables,
  lists,
  broadcasts: {},
  blocks,
  costumes: [],
  sounds: [],
  currentCostume: 0,
  volume: 100,
  layerOrder: 0,
})
const unusedRunner = {
  buildAdmitted: async () => ({ ok: false as const, error: 'unused' }),
  runBuilt: async () => ({ ok: false as const, error: 'unused' }),
} satisfies LlvmScriptRunner
const project = (targets: unknown[]) => ({
  targets,
  monitors: [],
  extensions: [],
  meta: { semver: '3.0.0' },
})
const num = (n: number) => [1, [4, String(n)]]

describe.skipIf(!available)('unified runtime feature coverage', () => {
  test('variables and lists execute and are both exposed', async () => {
    const m = await loadModule()
    const snap = run(
      m,
      project([
        stage(
          {
            h: hat('add'),
            add: {
              opcode: 'data_addtolist',
              next: 'set',
              parent: 'h',
              inputs: { ITEM: num(7) },
              fields: { LIST: ['l', 'l'] },
            },
            set: {
              opcode: 'data_setvariableto',
              next: null,
              parent: 'add',
              inputs: { VALUE: num(5) },
              fields: { VARIABLE: ['v', 'v'] },
            },
          },
          { v: ['v', 0] },
          { l: ['l', []] },
        ),
      ]),
    )
    const t = snap.targets[0]!
    expect(t.variables.v!.value).toBe('5')
    // Lists travel in the same map, tagged type "list" with an array value;
    // overlayXyoSnapshot routes them to ScratchTarget.lists.
    expect(t.variables.l).toMatchObject({ name: 'l', type: 'list', value: ['7'] })
  }, 60000)

  test('looks and operators (say bubble)', async () => {
    const m = await loadModule()
    const snap = run(
      m,
      project([
        stage({
          h: hat('say'),
          say: {
            opcode: 'looks_say',
            next: null,
            parent: 'h',
            inputs: { MESSAGE: [3, 'join', [4, 'x']] },
            fields: {},
          },
          join: {
            opcode: 'operator_join',
            next: null,
            parent: 'say',
            inputs: { STRING1: [3, [10, 'hello '], [4, 'a']], STRING2: [3, 'round', [4, 'b']] },
            fields: {},
          },
          round: {
            opcode: 'operator_round',
            next: null,
            parent: 'join',
            inputs: { NUM: num(2.6) },
            fields: {},
          },
        }),
      ]),
    )
    expect(snap.targets[0]!.bubbleText).toBe('hello 3')
  }, 60000)

  test('audio session opens, ticks and detaches through the C ABI', async () => {
    const m = await loadModule()
    const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(project([stage({})]))) })
    const handle = m._xyo_browser_create()
    const p = m._malloc(bytes.length)
    m.HEAPU8.set(bytes, p)
    expect(m._xyo_browser_load_sb3(handle, p, bytes.length)).toBe(1)
    m._free(p)
    // Contract: green flag first, then open the audio session before stepping.
    expect(m._xyo_browser_green_flag(handle)).toBe(1)
    expect(
      (
        m as unknown as { _xyo_browser_audio_open(h: number, t: number): number }
      )._xyo_browser_audio_open(handle, 300),
    ).toBe(1)
    const generationOf = (
      m as unknown as { _xyo_browser_audio_session_generation(h: number): number }
    )._xyo_browser_audio_session_generation
    expect(generationOf(handle)).toBeGreaterThan(0)
    expect(
      (m as unknown as { _xyo_browser_audio_tick(h: number): number })._xyo_browser_audio_tick(
        handle,
      ),
    ).toBe(1)
    m._xyo_browser_step(handle)
    expect(m._xyo_browser_stop(handle)).toBe(1)
    expect(
      (m as unknown as { _xyo_browser_audio_close(h: number): number })._xyo_browser_audio_close(
        handle,
      ),
    ).toBe(1)
    const audio = m as unknown as {
      _xyo_browser_audio_kind(h: number): number
      _xyo_browser_audio_pop(h: number): number
      _xyo_browser_audio_close_ack(h: number, g: number, ok: number): number
      _xyo_browser_audio_detach(h: number): number
    }
    // Detach is refused until queued cancellation is drained and ACKed.
    for (let guard = 0; guard < 16 && audio._xyo_browser_audio_kind(handle) !== 0; guard++) {
      audio._xyo_browser_audio_pop(handle)
    }
    audio._xyo_browser_audio_close_ack(handle, generationOf(handle), 1)
    expect(audio._xyo_browser_audio_detach(handle)).toBe(1)
    expect(generationOf(handle)).toBe(0)
    m._xyo_browser_destroy(handle)
  }, 60000)

  test('a sound block emits playable WAV bytes through the audio queue', async () => {
    const m = await loadModule()
    // Minimal 0.1s 440 Hz mono 16-bit WAV so the runtime has a real asset.
    const rate = 22050,
      samples = 2205
    const wav = Buffer.alloc(44 + samples * 2)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + samples * 2, 4)
    wav.write('WAVE', 8)
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(rate, 24)
    wav.writeUInt32LE(rate * 2, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(samples * 2, 40)
    for (let i = 0; i < samples; i++)
      wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2)
    const md5 = createHash('md5').update(wav).digest('hex')
    const soundProject = {
      targets: [
        stage({}),
        {
          isStage: false,
          name: 'Sprite1',
          variables: {},
          lists: {},
          broadcasts: {},
          costumes: [],
          currentCostume: 0,
          volume: 100,
          layerOrder: 1,
          x: 0,
          y: 0,
          sounds: [
            {
              name: 'beep',
              assetId: md5,
              dataFormat: 'wav',
              rate,
              sampleCount: samples,
              md5ext: md5 + '.wav',
            },
          ],
          blocks: {
            h: hat('play'),
            play: {
              opcode: 'sound_play',
              next: null,
              parent: 'h',
              inputs: { SOUND_MENU: [1, [10, 'beep']] },
              fields: {},
            },
          },
        },
      ],
      monitors: [],
      extensions: [],
      meta: { semver: '3.0.0' },
    }
    const bytes = zipSync({
      'project.json': strToU8(JSON.stringify(soundProject)),
      [md5 + '.wav']: new Uint8Array(wav),
    })
    const handle = m._xyo_browser_create()
    const p = m._malloc(bytes.length)
    m.HEAPU8.set(bytes, p)
    expect(m._xyo_browser_load_sb3(handle, p, bytes.length)).toBe(1)
    m._free(p)
    const audio = m as unknown as {
      _xyo_browser_audio_open(h: number, t: number): number
      _xyo_browser_audio_kind(h: number): number
      _xyo_browser_audio_bytes_size(h: number): number
      _xyo_browser_audio_format(h: number): number
      _xyo_browser_audio_volume(h: number): number
    }
    expect(m._xyo_browser_green_flag(handle)).toBe(1)
    expect(audio._xyo_browser_audio_open(handle, 300)).toBe(1)
    m._xyo_browser_step(handle)
    expect(audio._xyo_browser_audio_kind(handle)).toBe(1) // play command
    expect(audio._xyo_browser_audio_bytes_size(handle)).toBe(44 + samples * 2)
    const formatPointer = audio._xyo_browser_audio_format(handle)
    let end = formatPointer
    while (m.HEAPU8[end]) end++
    expect(new TextDecoder().decode(m.HEAPU8.subarray(formatPointer, end))).toBe('wav')
    expect(audio._xyo_browser_audio_volume(handle)).toBe(100)
    m._xyo_browser_destroy(handle)
  }, 60000)

  test('engine audio session surfaces open and start commands to the host', async () => {
    const m = await loadModule()
    const engine = createUnifiedEngine(m, unusedRunner, { audio: true })
    try {
      expect(engine.supportsAudio).toBe(true)
      const rate = 22050,
        samples = 2205
      const wav = Buffer.alloc(44 + samples * 2)
      wav.write('RIFF', 0)
      wav.writeUInt32LE(36 + samples * 2, 4)
      wav.write('WAVE', 8)
      wav.write('fmt ', 12)
      wav.writeUInt32LE(16, 16)
      wav.writeUInt16LE(1, 20)
      wav.writeUInt16LE(1, 22)
      wav.writeUInt32LE(rate, 24)
      wav.writeUInt32LE(rate * 2, 28)
      wav.writeUInt16LE(2, 32)
      wav.writeUInt16LE(16, 34)
      wav.write('data', 36)
      wav.writeUInt32LE(samples * 2, 40)
      for (let i = 0; i < samples; i++)
        wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2)
      const md5 = createHash('md5').update(wav).digest('hex')
      const soundProject = {
        targets: [
          stage({}),
          {
            isStage: false,
            name: 'Sprite1',
            variables: {},
            lists: {},
            broadcasts: {},
            costumes: [],
            currentCostume: 0,
            volume: 100,
            layerOrder: 1,
            x: 0,
            y: 0,
            sounds: [
              {
                name: 'beep',
                assetId: md5,
                dataFormat: 'wav',
                rate,
                sampleCount: samples,
                md5ext: md5 + '.wav',
              },
            ],
            blocks: {
              h: hat('play'),
              play: {
                opcode: 'sound_play',
                next: null,
                parent: 'h',
                inputs: { SOUND_MENU: [1, [10, 'beep']] },
                fields: {},
              },
            },
          },
        ],
        monitors: [],
        extensions: [],
        meta: { semver: '3.0.0' },
      }
      const bytes = zipSync({
        'project.json': strToU8(JSON.stringify(soundProject)),
        [md5 + '.wav']: new Uint8Array(wav),
      })
      await engine.loadSb3(Buffer.from(bytes))
      engine.greenFlagCompiled()
      engine.step()
      const commands = engine.audio!.drain()
      expect(commands[0]).toMatchObject({ type: 'open' })
      const start = commands.find((c) => c.type === 'start') as
        | { bytes: ArrayBuffer; format?: string; volume: number }
        | undefined
      expect(start).toBeDefined()
      expect(start!.bytes.byteLength).toBe(44 + samples * 2)
      expect(start!.format).toBe('wav')
      // The transport normalises Scratch volume 100 to a 0..1 Web Audio gain.
      expect(start!.volume).toBe(1)
    } finally {
      engine.dispose()
    }
  }, 60000)

  test('scheduler honours control_wait timing across frames', async () => {
    const m = await loadModule()
    const steps = (count: number): unknown[] => {
      const bytes = zipSync({
        'project.json': strToU8(
          JSON.stringify(
            project([
              stage(
                {
                  h: hat('set1'),
                  set1: {
                    opcode: 'data_setvariableto',
                    next: 'wait',
                    parent: 'h',
                    inputs: { VALUE: num(1) },
                    fields: { VARIABLE: ['v', 'v'] },
                  },
                  wait: {
                    opcode: 'control_wait',
                    next: 'set2',
                    parent: 'set1',
                    inputs: { DURATION: num(1) },
                    fields: {},
                  },
                  set2: {
                    opcode: 'data_setvariableto',
                    next: null,
                    parent: 'wait',
                    inputs: { VALUE: num(2) },
                    fields: { VARIABLE: ['v', 'v'] },
                  },
                },
                { v: ['v', 0] },
              ),
            ]),
          ),
        ),
      })
      return withHandle(m, bytes, (handle) => {
        m._xyo_browser_green_flag(handle)
        const seen: unknown[] = []
        for (let i = 0; i < count; i++) {
          m._xyo_browser_step(handle)
          seen.push(readSnapshot(m, handle).targets[0]!.variables.v!.value)
        }
        return seen
      })
    }
    // The runtime ticks per frame, so one second of wait spans ~60 frames.
    const short = steps(10)
    expect(short.every((v) => v === '1')).toBe(true)
    const long = steps(70)
    expect(long[long.length - 1]).toBe('2')
    expect(long.slice(0, 10).every((v) => v === '1')).toBe(true)
  }, 120000)

  test('exposes stable native target identities for a renderer bridge', async () => {
    const m = await loadModule()
    const bytes = zipSync({
      'project.json': strToU8(
        JSON.stringify(project([stage({}), { ...stage({}), isStage: false, name: 'Sprite1' }])),
      ),
    })
    withHandle(m, bytes, (handle) => {
      const bridge = m as unknown as {
        _xyo_browser_target_count(h: number): number
        _xyo_browser_target_at(h: number, i: number): number
      }
      expect(bridge._xyo_browser_target_count(handle)).toBe(2)
      const pointers = [0, 1].map((i) => bridge._xyo_browser_target_at(handle, i))
      expect(pointers[0]).toBeGreaterThan(0)
      expect(pointers[1]).toBeGreaterThan(0)
      expect(new Set(pointers).size).toBe(2)
      // Stable across calls: the mapping must survive repeated syncs.
      expect([0, 1].map((i) => bridge._xyo_browser_target_at(handle, i))).toEqual(pointers)
      expect(bridge._xyo_browser_target_at(handle, 2)).toBe(0)
    })
  }, 60000)

  test('mouse input reaches the runtime', async () => {
    const m = await loadModule()
    const engine = createUnifiedEngine(m, unusedRunner)
    try {
      const bytes = zipSync({
        'project.json': strToU8(
          JSON.stringify(
            project([
              stage(
                {
                  h: hat('forever'),
                  forever: {
                    opcode: 'control_forever',
                    next: null,
                    parent: 'h',
                    inputs: { SUBSTACK: [2, 'if'] },
                    fields: {},
                  },
                  if: {
                    opcode: 'control_if',
                    next: null,
                    parent: 'forever',
                    inputs: { CONDITION: [2, 'down'], SUBSTACK: [2, 'setv'] },
                    fields: {},
                  },
                  down: {
                    opcode: 'sensing_mousedown',
                    next: null,
                    parent: 'if',
                    inputs: {},
                    fields: {},
                  },
                  setv: {
                    opcode: 'data_setvariableto',
                    next: null,
                    parent: 'if',
                    inputs: { VALUE: num(1) },
                    fields: { VARIABLE: ['v', 'v'] },
                  },
                },
                { v: ['v', 0] },
              ),
            ]),
          ),
        ),
      })
      await engine.loadSb3(Buffer.from(bytes))
      engine.greenFlagCompiled()
      for (let i = 0; i < 2; i++) engine.step()
      const before = (
        engine.snapshot() as { targets: Array<{ variables: Record<string, { value: unknown }> }> }
      ).targets[0]!.variables.v!.value
      engine.mouse(0, 0, 480, 360, true)
      for (let i = 0; i < 3; i++) engine.step()
      const after = (
        engine.snapshot() as { targets: Array<{ variables: Record<string, { value: unknown }> }> }
      ).targets[0]!.variables.v!.value
      expect(before).toBe(0)
      expect(after).toBe('1')
    } finally {
      engine.dispose()
    }
  }, 60000)

  test('stop all halts a forever loop', async () => {
    const m = await loadModule()
    const engine = createUnifiedEngine(m, unusedRunner)
    try {
      const bytes = zipSync({
        'project.json': strToU8(
          JSON.stringify(
            project([
              stage(
                {
                  h: hat('forever'),
                  forever: {
                    opcode: 'control_forever',
                    next: null,
                    parent: 'h',
                    inputs: { SUBSTACK: [2, 'inc'] },
                    fields: {},
                  },
                  inc: {
                    opcode: 'data_changevariableby',
                    next: null,
                    parent: 'forever',
                    inputs: { VALUE: num(1) },
                    fields: { VARIABLE: ['v', 'v'] },
                  },
                },
                { v: ['v', 0] },
              ),
            ]),
          ),
        ),
      })
      await engine.loadSb3(Buffer.from(bytes))
      engine.greenFlagCompiled()
      for (let i = 0; i < 5; i++) engine.step()
      const running = (
        engine.snapshot() as { targets: Array<{ variables: Record<string, { value: unknown }> }> }
      ).targets[0]!.variables.v!.value as number
      expect(running).toBeGreaterThan(0)
      engine.stop()
      for (let i = 0; i < 3; i++) engine.step()
      const halted = (
        engine.snapshot() as { targets: Array<{ variables: Record<string, { value: unknown }> }> }
      ).targets[0]!.variables.v!.value as number
      expect(halted).toBe(running)
    } finally {
      engine.dispose()
    }
  }, 60000)

  test('creates a clone and runs its start-as-clone hat', async () => {
    const m = await loadModule()
    const engine = createUnifiedEngine(m, unusedRunner)
    try {
      const bytes = zipSync({
        'project.json': strToU8(
          JSON.stringify(
            project([
              // A clone copies sprite-local variables, so use a global one to observe it.
              stage({}, { v: ['v', 0] }),
              {
                isStage: false,
                name: 'Sprite1',
                variables: {},
                lists: {},
                broadcasts: {},
                costumes: [],
                sounds: [],
                currentCostume: 0,
                volume: 100,
                layerOrder: 1,
                x: 0,
                y: 0,
                blocks: {
                  h: {
                    opcode: 'event_whenflagclicked',
                    next: 'setxy',
                    parent: null,
                    inputs: {},
                    fields: {},
                    topLevel: true,
                    x: 0,
                    y: 0,
                  },
                  setxy: {
                    opcode: 'motion_gotoxy',
                    next: 'clone',
                    parent: 'h',
                    inputs: { X: num(10), Y: num(20) },
                    fields: {},
                  },
                  clone: {
                    opcode: 'control_create_clone_of',
                    next: null,
                    parent: 'setxy',
                    inputs: { CLONE_OPTION: [1, [9, '_myself_']] },
                    fields: {},
                  },
                  ch: {
                    opcode: 'control_start_as_clone',
                    next: 'cxy',
                    parent: null,
                    inputs: {},
                    fields: {},
                    topLevel: true,
                    x: 0,
                    y: 200,
                  },
                  cxy: {
                    opcode: 'motion_gotoxy',
                    next: 'inc',
                    parent: 'ch',
                    inputs: { X: num(30), Y: num(40) },
                    fields: {},
                  },
                  inc: {
                    opcode: 'data_changevariableby',
                    next: null,
                    parent: 'cxy',
                    inputs: { VALUE: num(1) },
                    fields: { VARIABLE: ['v', 'v'] },
                  },
                },
              },
            ]),
          ),
        ),
      })
      await engine.loadSb3(Buffer.from(bytes))
      engine.greenFlagCompiled()
      for (let i = 0; i < 60; i++) engine.step()
      const snapshot = engine.snapshot() as {
        targets: Array<{
          name: string
          isOriginal: boolean
          variables: Record<string, { value: unknown }>
        }>
      }
      const originals = snapshot.targets.filter((target) => target.isOriginal)
      const clones = snapshot.targets.filter((target) => !target.isOriginal)
      expect(originals).toHaveLength(2) // Stage + Sprite1
      expect(clones).toHaveLength(1)
      // The clone's `when I start as a clone` hat ran and wrote the global.
      const stageTarget = snapshot.targets.find((target) => target.name === 'Stage')!
      expect(stageTarget.variables.v!.value).toBe(1)
    } finally {
      engine.dispose()
    }
  }, 60000)

  test('real project corpus loads, green-flags and steps', async () => {
    const m = await loadModule()
    const files: string[] = []
    if (existsSync(upstream)) {
      for (const name of readdirSync(upstream))
        if (name.endsWith('.sb3')) files.push(join(upstream, name))
    }
    if (existsSync(artifacts)) {
      for (const name of readdirSync(artifacts))
        if (name.endsWith('.sb3')) files.push(join(artifacts, name))
    }
    expect(files.length).toBeGreaterThan(5)
    const failures: string[] = []
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(file))
      try {
        const snap = withHandle(m, bytes, (handle) => {
          m._xyo_browser_green_flag(handle)
          for (let i = 0; i < 20; i++) m._xyo_browser_step(handle)
          return readSnapshot(m, handle)
        })
        expect(Number.isInteger(snap.stepSerial)).toBe(true)
        expect(snap.targets.length).toBeGreaterThan(0)
      } catch (error) {
        failures.push(
          `${file.split('/').pop()}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    expect(failures).toEqual([])
  }, 300000)
})
