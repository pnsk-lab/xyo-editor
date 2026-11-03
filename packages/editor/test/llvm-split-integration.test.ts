import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { admitSb3Project, splitProjectForLlvm } from '@hikkaku/llvm-wasm'
import { ScratchVM } from '@hikkaku/vm'
import { hasMetadataCompiler } from './artifacts'

// Seeded integration fuzz for general projects: random multi-hat, multi-target
// projects go through split; every admitted synthesis must pass the whole-project
// admission gate AND compile in the real metadata compiler, and the remainder
// must load and step in the real built-in VM without throwing. No execution of
// generated code here; execution is covered by the browser suites.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Json = Record<string, unknown>

function makeProject(rng: () => number): unknown {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)] as T
  const bodyOpcode = (): string => {
    const r = rng()
    if (r < 0.35) return 'data_setvariableto'
    if (r < 0.55) return 'data_changevariableby'
    if (r < 0.65) return 'control_wait'
    if (r < 0.8) return 'motion_movesteps'
    return 'data_variable'
  }
  const valueInput = (): unknown => {
    const r = rng()
    if (r < 0.6) return [1, [4, String(Math.floor(rng() * 100))]]
    if (r < 0.7) return [2, [4, '3']]
    if (r < 0.78) return [3, 'lit', [4, '5']]
    if (r < 0.85) return 'lit'
    return [1, [5, '9']]
  }
  const targets: Json[] = []
  const targetCount = 1 + Math.floor(rng() * 2)
  for (let ti = 0; ti < targetCount; ti++) {
    const blocks: Record<string, Json> = {}
    const hats = Math.floor(rng() * 3)
    for (let h = 0; h < hats; h++) {
      const hid = `hat${ti}_${h}`,
        bid = `set${ti}_${h}`
      const body: Json = {
        opcode: bodyOpcode(),
        next: null,
        parent: hid,
        inputs: { VALUE: valueInput() },
        fields: { VARIABLE: ['v', 'v'] },
        topLevel: false,
      }
      if (rng() < 0.08) body.mutation = { tagName: 'm' }
      if (rng() < 0.12) body.next = `tail${ti}_${h}`
      blocks[hid] = {
        opcode: rng() < 0.75 ? 'event_whenflagclicked' : 'event_whenkeypressed',
        next: bid,
        parent: null,
        inputs: {},
        fields: {},
        topLevel: true,
        x: 0,
        y: 0,
      }
      if (rng() < 0.08) blocks[hid]!.next = null
      blocks[bid] = body
      if (rng() < 0.15) {
        blocks.lit = {
          opcode: 'math_number',
          next: null,
          parent: bid,
          inputs: {},
          fields: { NUM: ['7'] },
          shadow: rng() < 0.8,
        }
      }
    }
    targets.push({
      isStage: ti === 0,
      name: ti === 0 ? 'Stage' : `S${ti}`,
      variables: { v: ['v', 0] },
      lists: {},
      broadcasts: {},
      blocks,
      costumes: [],
      sounds: [],
      currentCostume: 0,
      volume: 100,
      layerOrder: 0,
    })
  }
  return { targets, monitors: [], extensions: [], meta: { semver: '3.0.0' } }
}

const compilerDir = join(import.meta.dir, '..', '..', 'llvm-wasm', '.work', 'metadata-build')
let compiler: any = null
let compilerMemory: { buffer: ArrayBuffer } | undefined
async function getCompiler() {
  if (compiler) return compiler
  const { createRequire } = await import('node:module')
  const factory = createRequire(import.meta.url)(join(compilerDir, 'xyo_browser_ir.cjs'))
  const wasm = readFileSync(join(compilerDir, 'xyo_browser_ir.wasm'))
  compiler = await factory({
    instantiateWasm(imports: Record<string, unknown>, ready: (e: unknown) => void) {
      const instance = new WebAssembly.Instance(
        new WebAssembly.Module(wasm),
        imports as WebAssembly.Imports,
      )
      compilerMemory = {
        buffer: (
          Object.values(instance.exports).find(
            (v) => v instanceof WebAssembly.Memory,
          ) as WebAssembly.Memory
        ).buffer as ArrayBuffer,
      }
      ready(instance)
      return instance.exports
    },
  })
  if (!compilerMemory) throw new Error('compiler did not export memory')
  return compiler
}

(hasMetadataCompiler() ? describe : describe.skip)('split integration fuzz (seeded, real compiler + real VM, no execution)', () => {
  test('admitted syntheses compile; remainders load and step', async () => {
    const c = await getCompiler()
    const read = (p: number): string => {
      const b = new Uint8Array(compilerMemory!.buffer)
      let n = p
      while (b[n]) n++
      return new TextDecoder().decode(b.subarray(p, n))
    }
    // NOTE: the compiler consumes SB3 zip bytes; build a minimal stored zip.
    const buildZip = (projectJson: string): Uint8Array => {
      const enc = new TextEncoder()
      const name = enc.encode('project.json'),
        data = enc.encode(projectJson)
      const le16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
      const le32 = (v: number): number[] => [
        v & 0xff,
        (v >> 8) & 0xff,
        (v >> 16) & 0xff,
        (v >> 24) & 0xff,
      ]
      const local: number[] = [
        0x50,
        0x4b,
        0x03,
        0x04,
        20,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...le32(0),
        ...le32(data.length),
        ...le32(data.length),
        ...le16(name.length),
        0,
        0,
      ]
      const central: number[] = [
        0x50,
        0x4b,
        0x01,
        0x02,
        20,
        0,
        20,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...le32(0),
        ...le32(data.length),
        ...le32(data.length),
        ...le16(name.length),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...le32(0),
        ...le32(0),
      ]
      const cdStart = local.length + name.length + data.length
      const cdLen = central.length + name.length
      const end: number[] = [
        0x50,
        0x4b,
        0x05,
        0x06,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        ...le32(cdLen),
        ...le32(cdStart),
        0,
        0,
      ]
      return new Uint8Array([...local, ...name, ...data, ...central, ...name, ...end])
    }
    const compileZip = (zip: Uint8Array): { ok: boolean; error: string } => {
      const mem = compilerMemory as unknown as { buffer: ArrayBuffer }
      const ptr = c._malloc(zip.length)
      new Uint8Array(mem.buffer).set(zip, ptr)
      const r = c._xyo_browser_ir_compile(ptr, zip.length)
      c._free(ptr)
      try {
        return { ok: !!c._xyo_browser_ir_ok(r), error: read(c._xyo_browser_ir_error(r)) }
      } finally {
        c._xyo_browser_ir_destroy(r)
      }
    }
    const N = Number(process.env.FUZZ_N ?? 100)
    const rng = mulberry32(0x5eed)
    let admitted = 0
    let compiled = 0
    for (let i = 0; i < N; i++) {
      const project = makeProject(rng)
      const split = splitProjectForLlvm(project)
      expect(split.ok).toBe(true)
      if (!split.ok) continue
      for (const a of split.admitted) {
        admitted++
        // The synthesis must satisfy the whole-project gate on its own.
        expect(admitSb3Project(a.project).route).toBe('llvm')
        // ... and the real compiler must accept it.
        const out = compileZip(buildZip(JSON.stringify(a.project)))
        expect(out.ok).toBe(true)
        if (out.ok) compiled++
      }
      // The remainder must load and run in the built-in VM without throwing.
      const vm = new ScratchVM()
      await vm.loadProject(split.rest)
      vm.greenFlag()
      for (let s = 0; s < 5; s++) vm.step()
    }
    // The generator must actually exercise the LLVM path, or the fuzz is vacuous.
    expect(admitted).toBeGreaterThan(0)
    expect(compiled).toBe(admitted)
  }, 300000)
})
