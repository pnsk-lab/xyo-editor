// Differential fuzz: every project the admission router sends toward LLVM
// must be accepted by the real metadata compiler. Run explicitly (not part of
// `bun test`): `bun packages/llvm-wasm/tests/admission-fuzz.ts` from the repo
// root with the metadata compiler already built. Seeded and deterministic.
import { admitSb3Project } from '../src/admission';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = Record<string, unknown>;

function makeProject(rng: () => number): unknown {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)] as T;
  const maybeNul = (s: string): string => (rng() < 0.12 ? s + '\0x' : s);
  const numLit = (): unknown => {
    const r = rng();
    if (r < 0.6) return [4, String(Math.floor(rng() * 100))];
    if (r < 0.7) return [5, '42'];
    if (r < 0.8) return [4];
    return [12, 'v', 'v'];
  };
  const valueInput = (): unknown => {
    const r = rng();
    if (r < 0.55) return [1, numLit()];
    if (r < 0.65) return [2, numLit()];
    if (r < 0.75) return [3, 'lit', numLit()];
    if (r < 0.82) return [3, '', numLit()];
    if (r < 0.88) return 'lit';
    if (r < 0.93) return 'missing';
    return [];
  };
  const fields = (): Record<string, unknown> => {
    const r = rng();
    const id = maybeNul('v');
    const name = rng() < 0.12 ? maybeNul('v') : 'v';
    if (r < 0.8) return { VARIABLE: [name, id] };
    if (r < 0.85) return { VARIABLE: [name] };
    if (r < 0.9) return {};
    if (r < 0.95) return { VARIABLE: ['v', 'v'], EXTRA: ['x'] };
    return { VARIABLE: 'v' };
  };
  const bodyOpcode = (): string => {
    const r = rng();
    if (r < 0.4) return 'data_setvariableto';
    if (r < 0.6) return 'data_changevariableby';
    if (r < 0.7) return 'control_wait';
    if (r < 0.8) return 'motion_movesteps';
    return 'data_variable';
  };
  const targets: Json[] = [];
  const targetCount = 1 + Math.floor(rng() * 2);
  for (let ti = 0; ti < targetCount; ti++) {
    const blocks: Record<string, Json> = {};
    const hats = 1 + Math.floor(rng() * 2);
    for (let h = 0; h < hats; h++) {
      const hid = `hat${ti}_${h}`;
      const bid = `set${ti}_${h}`;
      const hatOp = rng() < 0.7 ? 'event_whenflagclicked' : 'event_whenkeypressed';
      const body: Json = { opcode: bodyOpcode(), next: null, parent: hid, inputs: { VALUE: valueInput() }, fields: fields(), topLevel: false };
      if (rng() < 0.1) body.mutation = { tagName: 'm' };
      if (rng() < 0.1) body.next = 'tail';
      if (rng() < 0.06) (body.inputs as Record<string, unknown>).DURATION = [1, [4, '1']];
      blocks[hid] = { opcode: hatOp, next: 'set', parent: null, inputs: {}, fields: {}, topLevel: true, x: 0, y: 0 };
      blocks[hid]!.next = rng() < 0.9 ? bid : null;
      blocks[bid] = body;
      // Sometimes extend the body into a straight-line chain (valid head,
      // valid/invalid tail, overlong, dangling or cyclic).
      if (body.next === null && rng() < 0.3) {
        let prev = bid;
        const n = 1 + Math.floor(rng() * 9);
        for (let i = 0; i < n; i++) {
          const id = `c${ti}_${h}_${i}`;
          const r = rng();
          blocks[id] = {
            opcode: r < 0.7 ? (rng() < 0.5 ? 'data_setvariableto' : 'data_changevariableby') : 'motion_movesteps',
            next: null, parent: prev,
            inputs: { VALUE: [1, [4, String(1 + Math.floor(rng() * 9))]] },
            fields: { VARIABLE: ['v', 'v'] }, topLevel: false,
          };
          (blocks[prev] as Json).next = id;
          prev = id;
          if (rng() < 0.12) break;
        }
        if (rng() < 0.08) (blocks[prev] as Json).next = 'set' in blocks ? 'set' : bid;
      }
      if (rng() < 0.15) {
        blocks.lit = { opcode: 'math_number', next: null, parent: bid, inputs: {}, fields: { NUM: ['7'] }, shadow: rng() < 0.8 };
      }
    }
    targets.push({
      isStage: ti === 0, name: ti === 0 ? 'Stage' : `S${ti}`, variables: { v: ['v', 0] }, lists: {}, broadcasts: {},
      blocks, costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: 0,
    });
  }
  if (rng() < 0.05) return { targets: 'nope' };
  if (rng() < 0.05) return null;
  return { targets, monitors: [], extensions: [], meta: { semver: '3.0.0' } };
}

async function main(): Promise<void> {
  const root = new URL('../../../', import.meta.url);
  const factoryPath = new URL('packages/llvm-wasm/.work/metadata-build/xyo_browser_ir.cjs', root);
  const wasmPath = new URL('packages/llvm-wasm/.work/metadata-build/xyo_browser_ir.wasm', root);
  const require = createRequire(import.meta.url);
  const factory = require(factoryPath.href.replace('file://', ''));
  const wasm: Uint8Array<ArrayBuffer> = new Uint8Array(readFileSync(wasmPath));
  let memory: Uint8Array | undefined;
  const compiler = await factory({
    instantiateWasm(imports: Record<string, unknown>, ready: (e: unknown) => void) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports as WebAssembly.Imports);
      memory = Object.values(instance.exports).find(v => v instanceof WebAssembly.Memory) as unknown as Uint8Array | undefined;
      ready(instance);
      return instance.exports;
    },
  });
  if (!memory) throw new Error('compiler did not export memory');
  const mem = memory as unknown as { buffer: ArrayBuffer };
  const read = (p: number): string => {
    const b = new Uint8Array(mem.buffer);
    let n = p;
    while (b[n]) n++;
    return new TextDecoder().decode(b.subarray(p, n));
  };
  // Minimal stored-entry zip writer (single file, no compression, no comment).
  function buildStoredZip(projectJson: string): Uint8Array {
    const name = new TextEncoder().encode('project.json');
    const data = new TextEncoder().encode(projectJson);
    const le16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
    const le32 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
    const local: number[] = [0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(name.length), 0, 0];
    const central: number[] = [0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, ...le32(0), ...le32(0)];
    const cdStart = local.length + name.length + data.length;
    const cdLen = central.length + name.length;
    const end: number[] = [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0, ...le32(cdLen), ...le32(cdStart), 0, 0];
    return new Uint8Array([...local, ...name, ...data, ...central, ...name, ...end]);
  }

  let lastError = '';
  const compileZip = (zip: Uint8Array): boolean => {
    const ptr = compiler._malloc(zip.length);
    new Uint8Array(mem.buffer).set(zip, ptr);
    const r = compiler._xyo_browser_ir_compile(ptr, zip.length);
    compiler._free(ptr);
    try {
      lastError = read(compiler._xyo_browser_ir_error(r));
      return !!compiler._xyo_browser_ir_ok(r);
    } finally {
      compiler._xyo_browser_ir_destroy(r);
    }
  };

  const N = Number(process.env.FUZZ_N ?? 300);
  const rng = mulberry32(0xC10C);
  let routed = 0;
  let mismatch = 0;
  const reasons = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const project = makeProject(rng);
    const verdict = admitSb3Project(project);
    if (verdict.route === 'llvm') {
      routed++;
      // Rebuild the exact admitted JSON the router saw (no mutation involved).
      const zip = buildStoredZip(JSON.stringify(project));
      if (!compileZip(zip)) {
        mismatch++;
        console.log(`OVER-APPROXIMATION case ${i}: router=llvm compiler=rejected: ${lastError}`);
        if (process.env.FUZZ_DEBUG) console.log(JSON.stringify(project));
      }
    } else {
      reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
    }
  }
  console.log(`cases=${N} routedLlvm=${routed} overApproximations=${mismatch}`);
  console.log('fallback reasons:', [...reasons.entries()].map(([k, v]) => `${k}:${v}`).join(' | '));
  if (routed < 5) throw new Error('fuzz battery admitted nothing; generator is vacuous');
  if (mismatch > 0) throw new Error(`${mismatch} router-llvm cases rejected by the compiler`);
  console.log('PASS: no over-approximation; every llvm-routed project compiles');
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
