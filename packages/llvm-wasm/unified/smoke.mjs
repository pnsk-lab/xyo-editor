// Smoke test for the unified runtime: one Wasm module must (a) interpret a real
// project with full xyo-cpp features (loops, multiple steps) and (b) execute a
// reviewed LLVM side module against the *same* Runtime, sharing variables.
// Node only; the browser path is covered by the editor-owned suites.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = new URL('../../..', import.meta.url).pathname;
const build = join(root, 'packages/llvm-wasm/.work/unified-build');
const require = createRequire(import.meta.url);
// Emscripten emits CommonJS; the enclosing package is ESM, so scope the
// generated glue as CommonJS (same trick the xyo-cpp build script uses).
writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}\n');
const loaded = require(join(build, 'unified_runtime.js'));
const factory = typeof loaded === 'function' ? loaded : loaded.default;
if (typeof factory !== 'function') throw new Error('unified runtime factory missing');
const wasm = readFileSync(join(build, 'unified_runtime.wasm'));

let moduleMemory;
const compiledModule = new WebAssembly.Module(wasm);
const m = await factory({
  wasmBinary: wasm,
  instantiateWasm(imports, ready) {
    const instance = new WebAssembly.Instance(compiledModule, imports);
    moduleMemory = Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory);
    // Main-module builds read dylink metadata from the Module, so pass both.
    ready(instance, compiledModule);
    return instance.exports;
  },
});
if (!moduleMemory) throw new Error('unified runtime did not export memory');
const HEAP = () => new Uint8Array(moduleMemory.buffer);
const readCString = (p) => {
  const b = HEAP();
  let n = p;
  while (b[n]) n++;
  return new TextDecoder().decode(b.subarray(p, n));
};
const alloc = (bytes) => {
  const p = m._malloc(bytes.length || 1);
  HEAP().set(bytes, p);
  return p;
};
const cstr = (s) => alloc(new TextEncoder().encode(s + '\0'));

function sb3(project) {
  return Buffer.from(
    (() => {
      // Stored-entry ZIP: matches what the compiler/host accept.
      const enc = new TextEncoder();
      const name = enc.encode('project.json');
      const data = enc.encode(JSON.stringify(project));
      const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
      const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
      const local = [0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(name.length), 0, 0];
      const central = [0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(name.length),
        0, 0, 0, 0, 0, 0, 0, 0, ...le32(0), ...le32(0)];
      const cdStart = local.length + name.length + data.length;
      const cdLen = central.length + name.length;
      const end = [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0, ...le32(cdLen), ...le32(cdStart), 0, 0];
      return new Uint8Array([...local, ...name, ...data, ...central, ...name, ...end]);
    })(),
  );
}

const hatch = (next) => ({ opcode: 'event_whenflagclicked', next, parent: null, inputs: {}, fields: {}, topLevel: true, x: 0, y: 0 });
const stage = (blocks, variables = { v: ['v', 0] }) => ({
  isStage: true, name: 'Stage', variables, lists: {}, broadcasts: {}, blocks,
  costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: 0,
});
const project = (target, monitors = []) => ({ targets: [target], monitors, extensions: [], meta: { semver: '3.0.0' } });

function load(handle, projectJson) {
  const bytes = sb3(projectJson);
  const p = alloc(bytes);
  const ok = m._xyo_browser_load_sb3(handle, p, bytes.length);
  m._free(p);
  if (!ok) throw new Error('load failed: ' + readCString(m._xyo_browser_error(handle)));
}

// (a) Full-feature interpreter: repeat 3 { change v by 5 } then set 100 once.
{
  const handle = m._xyo_browser_create();
  if (!handle) throw new Error('create failed');
  const blocks = {
    hat: hatch('loop'),
    loop: {
      opcode: 'control_repeat', next: null, parent: 'hat',
      inputs: { TIMES: [1, [6, '3']], SUBSTACK: [2, 'body'] }, fields: {},
    },
    body: {
      opcode: 'data_changevariableby', next: null, parent: 'loop',
      inputs: { VALUE: [1, [4, '5']] }, fields: { VARIABLE: ['v', 'v'] },
    },
  };
  load(handle, project(stage(blocks)));
  if (!m._xyo_browser_green_flag(handle)) throw new Error('green flag failed');
  for (let i = 0; i < 40; i++) m._xyo_browser_step(handle);
  const snap = JSON.parse(readCString(m._xyo_browser_snapshot(handle)));
  const value = snap.targets[0].variables.v.value;
  if (value !== 15) throw new Error(`interpreter loop expected 15, got ${JSON.stringify(value)}`);
  m._xyo_browser_destroy(handle);
  console.log(JSON.stringify({ ok: true, case: 'interpreter-loop', value }));
}

// (b) LLVM side module inside the same Runtime instance.
{
  const handle = m._xyo_browser_create();
  load(handle, project(stage({
    hat: hatch('set'),
    set: {
      opcode: 'data_setvariableto', next: null, parent: 'hat',
      inputs: { VALUE: [1, [4, '42']] }, fields: { VARIABLE: ['v', 'v'] },
    },
  })));
  if (!m._xyo_llvm_prepare(handle, cstr('hat'))) {
    throw new Error('llvm prepare failed');
  }
  const sidePath = join(root, 'packages/llvm-wasm/real-host/build/reference.wasm');
  const sideBytes = readFileSync(sidePath);
  m.FS.writeFile('/unified-side.wasm', sideBytes);
  const pathPtr = cstr('/unified-side.wasm');
  const opened = m._xyo_llvm_dlopen(handle, pathPtr);
  m._free(pathPtr);
  if (!opened) throw new Error('dlopen failed');
  const sym = (name) => {
    const p = cstr(name);
    const v = m._xyo_llvm_dlsym(opened, p);
    m._free(p);
    if (!v) throw new Error('dlsym ' + name);
    return v;
  };
  const entry = sym('xyo_browser_script');
  const slot0 = sym('xyo_aot_slot_0');
  const slot1 = sym('xyo_aot_slot_1');
  if (!m._xyo_llvm_expect_slots(handle, 2)) throw new Error('expect slots failed');
  const litKey = Buffer.from('34003200', 'hex'); // UTF-16 "42"
  const varKey = Buffer.from('76', 'hex');       // "v"
  for (const [addr, kind, key] of [[slot0, 3, litKey], [slot1, 0, varKey]]) {
    const p = alloc(Uint8Array.from(key));
    if (m._xyo_llvm_bind_slot(handle, addr, kind, p, key.length) !== 1) throw new Error('bind failed');
    m._free(p);
  }
  if (!m._xyo_llvm_is_sealed(handle)) throw new Error('not sealed');
  m._xyo_llvm_invoke(handle, entry);
  const idPtr = cstr('v');
  const variable = m._xyo_llvm_variable(handle, idPtr);
  m._free(idPtr);
  if (!variable) throw new Error('variable missing after invoke');
  const bits = m._xyo_llvm_variable_bits(variable);
  if (bits >> 48n !== 0x7ff9n) throw new Error('expected NaN-boxed string, got 0x' + bits.toString(16));
  // Same Runtime the interpreter would read: the snapshot must show it too.
  const snap = JSON.parse(readCString(m._xyo_browser_snapshot(handle)));
  const snapValue = snap.targets[0].variables.v.value;
  if (snapValue !== '42') throw new Error(`snapshot expected "42", got ${JSON.stringify(snapValue)}`);
  m._xyo_browser_destroy(handle);
  console.log(JSON.stringify({ ok: true, case: 'llvm-side-module', valueHex: '0x' + bits.toString(16), snapshot: snapValue }));
}
console.log('PASS: unified runtime interprets full features and runs LLVM side modules on one Runtime');
