import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { commitFlowValues } from '@hikkaku/llvm-wasm'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { type Browser } from 'playwright-core'
import { hasPackedLlvmArtifacts, optIn } from './artifacts'
import { launchBrowser } from './browser-launcher'

// Opt in: XYO_LLVM_COMPILER_BROWSER=1 bun test test/llvm-compiler-worker.browser.test.ts
// Prerequisites: the isolated metadata compiler must already be built
// (packages/llvm-wasm/.work/metadata-build/xyo_browser_ir.{js,wasm}).
// Test-only integration: drives the real LLVM-in-Wasm metadata compiler from
// the editor's own test harness in a real browser Worker. It compiles SB3
// bytes to LLVM IR plus slot metadata; it never executes generated code and
// never touches the editor runtime or product backend selection.
const enabled = optIn('XYO_LLVM_COMPILER_BROWSER', hasPackedLlvmArtifacts)
const root = join(import.meta.dir, '..')
const compilerDir = join(root, '..', 'llvm-wasm', '.work', 'metadata-build')
const llvmDir = join(root, '..', 'llvm-wasm')
const llvmProofDir = join(root, '..', 'llvm-wasm', '.work')
const realHostDir = join(root, '..', 'llvm-wasm', 'real-host', 'build')

function project(variableId: string, literal: string, opcode = 'data_setvariableto') {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { [variableId]: ['v', 0] },
        lists: {},
        broadcasts: {},
        blocks: {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'set',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 10,
            y: 10,
          },
          set: {
            opcode,
            next: null,
            parent: 'hat',
            inputs: { VALUE: [1, [4, literal]] },
            fields: { VARIABLE: ['v', variableId] },
            topLevel: false,
          },
        },
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
}

function changeProject() {
  return project('v', '42', 'data_changevariableby')
}

function twovarsProject() {
  const blocks: Record<string, unknown> = {
    hat: {
      opcode: 'event_whenflagclicked',
      next: 'b0',
      parent: null,
      inputs: {},
      fields: {},
      topLevel: true,
      x: 10,
      y: 10,
    },
  }
  const ids = ['v', 'w']
  const literals = ['10', '20']
  let prev: string = 'hat'
  for (let i = 0; i < 2; i++) {
    const id = `b${i}`
    blocks[id] = {
      opcode: 'data_setvariableto',
      next: null,
      parent: prev,
      inputs: { VALUE: [1, [4, literals[i]]] },
      fields: { VARIABLE: [ids[i], ids[i]] },
      topLevel: false,
    }
    ;(blocks[prev] as Record<string, unknown>).next = id
    prev = id
  }
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { v: ['v', 0], w: ['w', 0] },
        lists: {},
        broadcasts: {},
        blocks,
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
}

function mixedBackendProject() {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { v: ['v', 0] },
        lists: {},
        broadcasts: {},
        blocks: {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'chg',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 10,
            y: 10,
          },
          chg: {
            opcode: 'data_changevariableby',
            next: null,
            parent: 'hat',
            inputs: { VALUE: [1, [4, '42']] },
            fields: { VARIABLE: ['v', 'v'] },
            topLevel: false,
          },
        },
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
      {
        isStage: false,
        name: 'Sprite1',
        x: 0,
        y: 0,
        direction: 90,
        size: 100,
        visible: true,
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {
          hat2: {
            opcode: 'event_whenflagclicked',
            next: 'move',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 10,
            y: 10,
          },
          move: {
            opcode: 'motion_movesteps',
            next: null,
            parent: 'hat2',
            inputs: { STEPS: [1, [4, '10']] },
            fields: {},
          },
        },
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 1,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
}

function waitProject() {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'wait',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 10,
            y: 10,
          },
          wait: {
            opcode: 'control_wait',
            next: null,
            parent: 'hat',
            inputs: { DURATION: [1, [4, '1']] },
            fields: {},
            topLevel: false,
          },
        },
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
}

// Product backend end-to-end (test-only): drive the real createLlvmBackend
// with the real worker runner in a real browser page. Mixed project: an
// admitted change on Stage runs on LLVM exactly once, unadmitted motion runs
// inside the wrapped VM.
const backendPageSource = `<!doctype html><meta charset="utf-8"><pre id="result">RUNNING</pre><script type="module">
(async () => {
  const done = v => { document.querySelector('#result').textContent = JSON.stringify(v); };
  try {
    const [{ createLlvmBackend }, { createWorkerRunner }] = await Promise.all([import('/llvm-backend.mjs'), import('/llvm-runner.mjs')]);
    const backend = createLlvmBackend(createWorkerRunner({
      worker: '/llvm-runner.worker.js', compilerJs: '/compiler.js', compilerWasm: '/compiler.wasm',
      pipelineIndex: '/pipeline-index.mjs', pipelineWorker: '/pipeline-worker.mjs',
      llcWorker: '/llc-browser.mjs', lldWorker: '/lld-browser.mjs',
      hostJs: '/real_host.js', hostWasm: '/real_host.wasm',
    }));
    const sb3 = new Uint8Array(await (await fetch('/mixed-backend.sb3')).arrayBuffer());
    await backend.vm.loadProject(sb3);
    backend.vm.greenFlag();
    await backend.settled();
    for (let i = 0; i < 10; i++) backend.vm.step();
    // The adapter queues work, so wait again before reading the snapshot.
    await backend.settled();
    const first = { v: backend.vm.getVariableValue('Stage', 'v'), x: backend.vm.getTarget('Sprite1')?.x };
    // Reflag: the change script must accumulate from live state, not restart.
    backend.vm.greenFlag();
    await backend.settled();
    for (let i = 0; i < 10; i++) backend.vm.step();
    // The adapter queues work, so wait again before reading the snapshot.
    await backend.settled();
    done({ ok: true, first, v: backend.vm.getVariableValue('Stage', 'v'), x: backend.vm.getTarget('Sprite1')?.x, lastError: String(backend.lastError()) });
  } catch (e) { done({ ok: false, error: String((e && e.stack) || e) }); }
})();
</script>`

// Registry-path end to end (test-only): the same flow the app will use —
// registerXyoBackend on a fresh registry, create('xyo-cpp'), green flag —
// against the packed /llvm-artifacts layout the app serves from public/.
const registerPageSource = `<!doctype html><meta charset="utf-8"><pre id="result">RUNNING</pre><script type="module">
(async () => {
  const done = v => { document.querySelector('#result').textContent = JSON.stringify(v); };
  try {
    const [{ registerXyoBackend }, { RuntimeBackendRegistry }] = await Promise.all([import('/register-xyo.mjs'), import('/runtime-backends.mjs')]);
    const registry = new RuntimeBackendRegistry();
    registerXyoBackend(registry);
    const listed = registry.list().find(e => e.id === 'xyo-cpp');
    const backend = await registry.create('xyo-cpp');
    const sb3 = new Uint8Array(await (await fetch('/mixed-backend.sb3')).arrayBuffer());
    await backend.vm.loadProject(sb3);
    backend.vm.greenFlag();
    await backend.settled();
    for (let i = 0; i < 10; i++) backend.vm.step();
    // The adapter queues work, so wait again before reading the snapshot.
    await backend.settled();
    // Read the live runtime snapshot: getVariableValue would read the editor
    // model, which only receives committed values when the run stops.
    const live = backend.vm.snapshot().project.targets;
    done({ ok: true, label: listed?.label, v: live.find(t => t.name === 'Stage')?.variables?.v?.[1], x: backend.vm.getTarget('Sprite1')?.x });
  } catch (e) { done({ ok: false, error: String((e && e.stack) || e) }); }
})();
</script>`

// Green-flag flow (test-only): thin worker shell around the shared
// runGreenFlagFlow orchestration; artifact wiring lives here, the
// admit/compile/link/execute decision loop lives in @hikkaku/llvm-wasm.
const flowWorkerSource = `importScripts('/real_host.js', '/compiler.js');
onmessage = async e => {
  try {
    const { runGreenFlagFlow, createLLVMWorkerClient, LLVMPipeline } = await import('/pipeline-index.mjs');
    const wasmBin = new Uint8Array(await (await fetch('/compiler.wasm')).arrayBuffer());
    let compilerMemory;
    const compiler = await createXyoBrowserIr({ instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBin), imports);
      compilerMemory = Object.values(instance.exports).find(x => x instanceof WebAssembly.Memory);
      ready(instance); return instance.exports;
    }});
    const readCompiler = p => { const b = new Uint8Array(compilerMemory.buffer); let n = p; while (b[n]) n++; return new TextDecoder().decode(b.subarray(p, n)); };
    const hostWasm = new Uint8Array(await (await fetch('/real_host.wasm')).arrayBuffer());
    const m = await createXyoRealHost({ wasmBinary: hostWasm });
    const alloc = b => { const p = m._malloc(b.length || 1); m.HEAPU8.set(b, p); return p; };
    const str = s => alloc(new TextEncoder().encode(s + '\\0'));
    const read = p => { let n = p; while (m.HEAPU8[n]) n++; return new TextDecoder().decode(m.HEAPU8.subarray(p, n)); };
    const stages = {
      compile: async sb3 => {
        const cp = compiler._malloc(sb3.length);
        new Uint8Array(compilerMemory.buffer).set(sb3, cp);
        const cr = compiler._xyo_browser_ir_compile(cp, sb3.length);
        compiler._free(cp);
        if (!cr) throw new Error('null compile result');
        try {
          if (!compiler._xyo_browser_ir_ok(cr)) throw new Error(readCompiler(compiler._xyo_browser_ir_error(cr)));
          return { ir: readCompiler(compiler._xyo_browser_ir_text(cr)), metadata: JSON.parse(readCompiler(compiler._xyo_browser_ir_metadata(cr))) };
        } finally { compiler._xyo_browser_ir_destroy(cr); }
      },
      link: async (ir, exports) => {
        const client = createLLVMWorkerClient('/pipeline-worker.mjs', '/llc-browser.mjs', '/lld-browser.mjs');
        const pipeline = new LLVMPipeline(client);
        try {
          return new Uint8Array((await pipeline.compile({ ir, exports, sideModule: true })).binary);
        } finally { pipeline.stop(); }
      },
      execute: async ({ sb3, side, abiDescriptor, slots }) => {
        if (read(m._rh_abi_descriptor()) !== abiDescriptor) throw new Error('ABI descriptor mismatch');
        const data = alloc(sb3), h = m._rh_create(data, sb3.length); m._free(data);
        if (read(m._rh_error(h)) !== '') throw new Error('host load: ' + read(m._rh_error(h)));
        m.FS.writeFile('/fixture-side.wasm', side);
        const hp = str('/fixture-side.wasm'), handle = m._rh_dlopen_for(h, hp); m._free(hp);
        if (!handle) throw new Error('dlopen failed');
        const sym = s => { const q = str(s), v = m._rh_dlsym(handle, q); m._free(q); if (!v) throw new Error('dlsym ' + s); return v; };
        const entry = sym('xyo_browser_script');
        if (m._rh_expect_slots(h, slots.length) !== 1) throw new Error('expect slots');
        const bound = [];
        for (const s of slots) {
          if (s.kind !== 0 && s.kind !== 3) throw new Error('slot kind');
          const key = Uint8Array.from(s.keyHex.match(/../g) || [], b => parseInt(b, 16));
          const addr = sym(s.global), q = alloc(key);
          if (m._rh_bind_slot(h, addr, s.kind, q, key.length) !== 1) throw new Error('bind ' + s.global);
          m._free(q); bound.push({ ...s, key });
        }
        if (!m._rh_is_sealed(h)) throw new Error('binding incomplete');
        const lookups = [];
        for (const s of bound) {
          if (s.kind !== 0) continue;
          const id0 = new Uint8Array(s.key.length + 1); id0.set(s.key);
          const p = alloc(id0), v = m._rh_variable(h, p);
          if (!v || m._rh_variable_bits(v) !== 0n) throw new Error('variable not initial');
          lookups.push({ s, p, v });
        }
        m._rh_invoke(entry, h);
        const variables = [];
        let vi = 0;
        for (const L of lookups) {
          if (m._rh_var_slot(h, vi) !== L.v) throw new Error('slot mismatch');
          const bits = m._rh_variable_bits(L.v);
          const len = m._rh_variable_string_length(L.v);
          const units = len >= 0 ? Array.from({ length: len }, (_, i) => m._rh_variable_string_unit(L.v, i)) : null;
          m._rh_collect();
          if (m._rh_variable_bits(L.v) !== bits) throw new Error('value did not survive GC');
          variables.push({ id: new TextDecoder().decode(L.s.key), valueHex: '0x' + bits.toString(16), units });
          vi++;
        }
        m._rh_destroy(h);
        if (m._rh_dlclose(handle) !== 0) throw new Error('dlclose failed');
        for (const L of lookups) m._free(L.p);
        return { variables };
      },
    };
    const sb3 = new Uint8Array(await (await fetch(e.data.url)).arrayBuffer());
    postMessage(await runGreenFlagFlow({ name: e.data.name, project: e.data.project, compileInput: sb3, exports: e.data.exports }, stages));
  } catch (err) { postMessage({ ok: false, error: String((err && err.stack) || err) }); }
};`

const flowPageSource = `<!doctype html><meta charset="utf-8"><pre id="result">RUNNING</pre><script>
(async () => {
  const done = v => { document.querySelector('#result').textContent = JSON.stringify(v); };
  try {
    const results = [];
    for (const fixture of (window.__flowFixtures || [])) {
      const w = new Worker('/flow-worker.js');
      const result = await new Promise((resolve, reject) => { w.onmessage = e => { resolve(e.data); w.terminate(); }; w.onerror = e => { reject(new Error(e.message)); w.terminate(); }; w.postMessage(fixture); });
      results.push({ name: fixture.name, result });
      if (!result.ok) break;
    }
    done({ ok: results.every(r => r.result.ok), cases: results });
  } catch (e) { done({ ok: false, error: String((e && e.stack) || e) }); }
})();
</script>`

function chainProject() {
  const blocks: Record<string, unknown> = {
    hat: {
      opcode: 'event_whenflagclicked',
      next: 'b0',
      parent: null,
      inputs: {},
      fields: {},
      topLevel: true,
      x: 10,
      y: 10,
    },
  }
  let prev: string = 'hat'
  for (const [i, [opcode, literal]] of [
    ['data_setvariableto', '10'],
    ['data_changevariableby', '5'],
    ['data_changevariableby', '7'],
  ].entries()) {
    const id = `b${i}`
    blocks[id] = {
      opcode,
      next: null,
      parent: prev,
      inputs: { VALUE: [1, [4, literal]] },
      fields: { VARIABLE: ['v', 'v'] },
      topLevel: false,
    }
    ;(blocks[prev] as Record<string, unknown>).next = id
    prev = id
  }
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { v: ['v', 0] },
        lists: {},
        broadcasts: {},
        blocks,
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
}

const workerSource = `importScripts('/compiler.js');
onmessage = async () => {
  const out = [];
  try {
    const wasmBin = new Uint8Array(await (await fetch('/compiler.wasm')).arrayBuffer());
    let compilerMemory;
    const compiler = await createXyoBrowserIr({ instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBin), imports);
      compilerMemory = Object.values(instance.exports).find(x => x instanceof WebAssembly.Memory);
      ready(instance); return instance.exports;
    }});
    if (!compilerMemory) throw new Error('compiler did not export memory');
    const read = p => { const b = new Uint8Array(compilerMemory.buffer); let n = p; while (b[n]) n++; return new TextDecoder().decode(b.subarray(p, n)); };
    const compile = bytes => {
      const ptr = compiler._malloc(bytes.length);
      if (!ptr) throw new Error('malloc failed');
      new Uint8Array(compilerMemory.buffer).set(bytes, ptr);
      const r = compiler._xyo_browser_ir_compile(ptr, bytes.length);
      compiler._free(ptr);
      if (!r) throw new Error('null result');
      try {
        return { ok: !!compiler._xyo_browser_ir_ok(r), text: read(compiler._xyo_browser_ir_text(r)), metadata: read(compiler._xyo_browser_ir_metadata(r)), error: read(compiler._xyo_browser_ir_error(r)) };
      } finally { compiler._xyo_browser_ir_destroy(r); }
    };
    for (const [name, url] of [['valid', '/valid.sb3'], ['nul-id', '/nul.sb3'], ['change', '/change.sb3'], ['chain', '/chain.sb3']]) {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const r = compile(bytes);
      out.push({ name, ok: r.ok, text: r.ok ? r.text : undefined, metadata: r.ok ? JSON.parse(r.metadata) : undefined, error: r.ok ? undefined : r.error });
    }
    const bad = compile(new Uint8Array([0, 1, 2, 3, 4, 5]));
    out.push({ name: 'garbage', ok: bad.ok, error: bad.error });
    postMessage({ ok: true, cases: out });
  } catch (e) { postMessage({ ok: false, error: String((e && e.stack) || e) }); }
};`

const pageSource = `<!doctype html><meta charset="utf-8"><pre id="result">RUNNING</pre><script>
const w = new Worker('/worker.js');
w.onmessage = e => { document.querySelector('#result').textContent = JSON.stringify(e.data); w.terminate(); };
w.onerror = e => { document.querySelector('#result').textContent = JSON.stringify({ ok: false, error: e.message }); w.terminate(); };
w.postMessage(0);
</script>`

// Second stage of the chain (test-only): IR -> PIC object -> shared side
// module through the real browser llc/LLD workers. No linking against a host,
// no execution, no product involvement.
const chainCompilerSource = `importScripts('/compiler.js');
onmessage = async () => {
  try {
    const wasmBin = new Uint8Array(await (await fetch('/compiler.wasm')).arrayBuffer());
    let compilerMemory;
    const compiler = await createXyoBrowserIr({ instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBin), imports);
      compilerMemory = Object.values(instance.exports).find(x => x instanceof WebAssembly.Memory);
      ready(instance); return instance.exports;
    }});
    const read = p => { const b = new Uint8Array(compilerMemory.buffer); let n = p; while (b[n]) n++; return new TextDecoder().decode(b.subarray(p, n)); };
    const bytes = new Uint8Array(await (await fetch('/valid.sb3')).arrayBuffer());
    const ptr = compiler._malloc(bytes.length);
    new Uint8Array(compilerMemory.buffer).set(bytes, ptr);
    const r = compiler._xyo_browser_ir_compile(ptr, bytes.length);
    compiler._free(ptr);
    if (!r) throw new Error('null result');
    try {
      if (!compiler._xyo_browser_ir_ok(r)) throw new Error(read(compiler._xyo_browser_ir_error(r)));
      postMessage({ ok: true, ir: read(compiler._xyo_browser_ir_text(r)), metadata: JSON.parse(read(compiler._xyo_browser_ir_metadata(r))) });
    } finally { compiler._xyo_browser_ir_destroy(r); }
  } catch (e) { postMessage({ ok: false, error: String((e && e.stack) || e) }); }
};`

const chainWorkerSource = `import { createLLVMWorkerClient, LLVMPipeline } from '/pipeline-index.mjs';
onmessage = async e => {
  try {
    const client = createLLVMWorkerClient('/pipeline-worker.mjs', '/llc-browser.mjs', '/lld-browser.mjs');
    const pipeline = new LLVMPipeline(client);
    const imports = [
      { module: 'env', name: 'memory', kind: 'memory' },
      { module: 'env', name: '__memory_base', kind: 'global' },
      { module: 'env', name: '__table_base', kind: 'global' },
      { module: 'env', name: 'xyo_varslot_init', kind: 'function' },
      { module: 'GOT.mem', name: 'xyo_aot_slot_0', kind: 'global' },
      { module: 'GOT.mem', name: 'xyo_aot_slot_1', kind: 'global' },
    ];
    let result;
    try {
      result = await pipeline.compile({ ir: e.data.ir, exports: ['xyo_browser_script', 'xyo_aot_slot_0', 'xyo_aot_slot_1'], sideModule: true });
    } finally { pipeline.stop(); }
    const bytes = new Uint8Array(result.binary);
    const module = new WebAssembly.Module(bytes);
    postMessage({ ok: true, sideBytes: bytes.length, imports: WebAssembly.Module.imports(module), exports: WebAssembly.Module.exports(module), diagnostics: !!result.diagnostics.llc && !!result.diagnostics.linker });
  } catch (err) { postMessage({ ok: false, error: String((err && err.stack) || err) }); }
};`

const chainPageSource = `<!doctype html><meta charset="utf-8"><pre id="result">RUNNING</pre><script>
(async () => {
  const done = v => { document.querySelector('#result').textContent = JSON.stringify(v); };
  try {
    const cw = new Worker('/chain-compiler-worker.js');
    const generated = await new Promise((resolve, reject) => { cw.onmessage = e => { resolve(e.data); cw.terminate(); }; cw.onerror = e => { reject(new Error(e.message)); cw.terminate(); }; cw.postMessage(0); });
    if (!generated.ok) { done({ ok: false, error: 'compile: ' + generated.error }); return; }
    const pw = new Worker('/chain-worker.js', { type: 'module' });
    const linked = await new Promise((resolve, reject) => { pw.onmessage = e => { resolve(e.data); pw.terminate(); }; pw.onerror = e => { reject(new Error(e.message)); pw.terminate(); }; pw.postMessage({ ir: generated.ir }); });
    done({ ok: !!linked.ok, side: linked, metadata: generated.metadata });
  } catch (e) { done({ ok: false, error: String((e && e.stack) || e) }); }
})();
</script>`

// Third stage of the chain (test-only): execute the linked side module in the
// real xyo runtime hosted in the same browser Worker: dlopen the side module,
// bind metadata slots, invoke the green-flag entry, and read the variable back
// after an explicit GC. Mirrors the isolated real-host proof; no product code.
const execWorkerSource = `importScripts('/real_host.js', '/compiler.js');
onmessage = async () => {
  try {
    const wasmBin = new Uint8Array(await (await fetch('/compiler.wasm')).arrayBuffer());
    let compilerMemory;
    const compiler = await createXyoBrowserIr({ instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBin), imports);
      compilerMemory = Object.values(instance.exports).find(x => x instanceof WebAssembly.Memory);
      ready(instance); return instance.exports;
    }});
    const readCompiler = p => { const b = new Uint8Array(compilerMemory.buffer); let n = p; while (b[n]) n++; return new TextDecoder().decode(b.subarray(p, n)); };
    const sb3 = new Uint8Array(await (await fetch('/valid.sb3')).arrayBuffer());
    const cp = compiler._malloc(sb3.length);
    new Uint8Array(compilerMemory.buffer).set(sb3, cp);
    const cr = compiler._xyo_browser_ir_compile(cp, sb3.length);
    compiler._free(cp);
    if (!cr) throw new Error('null compile result');
    let ir, metadata;
    try {
      if (!compiler._xyo_browser_ir_ok(cr)) throw new Error(readCompiler(compiler._xyo_browser_ir_error(cr)));
      ir = readCompiler(compiler._xyo_browser_ir_text(cr));
      metadata = JSON.parse(readCompiler(compiler._xyo_browser_ir_metadata(cr)));
    } finally { compiler._xyo_browser_ir_destroy(cr); }
    const { createLLVMWorkerClient, LLVMPipeline } = await import('/pipeline-index.mjs');
    const client = createLLVMWorkerClient('/pipeline-worker.mjs', '/llc-browser.mjs', '/lld-browser.mjs');
    const pipeline = new LLVMPipeline(client);
    const imports = [
      { module: 'env', name: 'memory', kind: 'memory' },
      { module: 'env', name: '__memory_base', kind: 'global' },
      { module: 'env', name: '__table_base', kind: 'global' },
      { module: 'env', name: 'xyo_varslot_init', kind: 'function' },
      { module: 'GOT.mem', name: 'xyo_aot_slot_0', kind: 'global' },
      { module: 'GOT.mem', name: 'xyo_aot_slot_1', kind: 'global' },
    ];
    let side;
    try {
      const compiled = await pipeline.compile({ ir, exports: ['xyo_browser_script', 'xyo_aot_slot_0', 'xyo_aot_slot_1'], sideModule: true });
      side = new Uint8Array(compiled.binary);
    } finally { pipeline.stop(); }
    const hostWasm = new Uint8Array(await (await fetch('/real_host.wasm')).arrayBuffer());
    const m = await createXyoRealHost({ wasmBinary: hostWasm });
    const alloc = b => { const p = m._malloc(b.length || 1); m.HEAPU8.set(b, p); return p; };
    const str = s => alloc(new TextEncoder().encode(s + '\\0'));
    const read = p => { let n = p; while (m.HEAPU8[n]) n++; return new TextDecoder().decode(m.HEAPU8.subarray(p, n)); };
    if (read(m._rh_abi_descriptor()) !== metadata.abiDescriptor) throw new Error('ABI descriptor mismatch');
    const data = alloc(sb3), h = m._rh_create(data, sb3.length); m._free(data);
    if (read(m._rh_error(h)) !== '') throw new Error('host load: ' + read(m._rh_error(h)));
    m.FS.writeFile('/fixture-side.wasm', side);
    const hp = str('/fixture-side.wasm'), handle = m._rh_dlopen_for(h, hp); m._free(hp);
    if (!handle) throw new Error('dlopen failed');
    const sym = s => { const q = str(s), v = m._rh_dlsym(handle, q); m._free(q); if (!v) throw new Error('dlsym ' + s); return v; };
    const entry = sym('xyo_browser_script');
    if (m._rh_expect_slots(h, metadata.slots.length) !== 1) throw new Error('expect slots');
    let id, lit;
    for (const s of metadata.slots) {
      if (s.kind !== 0 && s.kind !== 3) throw new Error('slot kind');
      const key = Uint8Array.from(s.keyHex.match(/../g) || [], b => parseInt(b, 16));
      const addr = sym(s.global), q = alloc(key);
      if (m._rh_bind_slot(h, addr, s.kind, q, key.length) !== 1) throw new Error('bind ' + s.global);
      m._free(q); if (s.kind === 0) id = key; else lit = { addr, key };
    }
    if (!id || !lit || !m._rh_is_sealed(h)) throw new Error('binding incomplete');
    const id0 = new Uint8Array(id.length + 1); id0.set(id);
    const p = alloc(id0), v = m._rh_variable(h, p);
    if (!v || m._rh_variable_bits(v) !== 0n) throw new Error('variable not initial');
    m._rh_collect();
    const literal = m._rh_slot_value(lit.addr);
    if (!literal) throw new Error('missing literal slot');
    m._rh_invoke(entry, h);
    if (m._rh_var_slot(h, 0) !== v) throw new Error('slot mismatch');
    const bits = m._rh_variable_bits(v);
    const units = [];
    for (let i = 0; i < lit.key.length / 2; i++) units.push(m._rh_variable_string_unit(v, i));
    m._rh_collect();
    if (m._rh_variable_bits(v) !== bits) throw new Error('value did not survive GC');
    m._rh_destroy(h);
    if (m._rh_dlclose(handle) !== 0) throw new Error('dlclose failed');
    m._free(p);
    postMessage({ ok: true, metadata, valueHex: '0x' + bits.toString(16), units, variable: !!v });
  } catch (e) { postMessage({ ok: false, error: String((e && e.stack) || e) }); }
};`

// Reflag equivalence: the Green flag contract is run -> teardown -> run again
// with a fresh worker and no cross-contamination. Each run gets a brand-new
// Worker (fresh Wasm memories), mirroring one green-flag execution each.
const execPageSource = `<!doctype html><meta charset="utf-8"><pre id="result">RUNNING</pre><script>
(async () => {
  const done = v => { document.querySelector('#result').textContent = JSON.stringify(v); };
  try {
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const w = new Worker('/exec-worker.js');
      const result = await new Promise((resolve, reject) => { w.onmessage = e => { resolve(e.data); w.terminate(); }; w.onerror = e => { reject(new Error(e.message)); w.terminate(); }; w.postMessage(0); });
      runs.push(result);
      if (!result.ok) break;
    }
    done({ ok: runs.length === 2 && runs.every(r => r.ok), runs });
  } catch (e) { done({ ok: false, error: String((e && e.stack) || e) }); }
})();
</script>`

;(enabled ? describe : describe.skip)(
  'LLVM metadata compiler in a real browser Worker (editor-owned, test-only)',
  () => {
    let server: Server | undefined
    let browser: Browser | undefined
    let base = ''

    beforeAll(async () => {
      const valid = Buffer.from(
        zipSync({ 'project.json': strToU8(JSON.stringify(project('v', '42'))) }),
      )
      const nul = Buffer.from(
        zipSync({ 'project.json': strToU8(JSON.stringify(project('v\0x', '42'))) }),
      )
      const change = Buffer.from(
        zipSync({ 'project.json': strToU8(JSON.stringify(changeProject())) }),
      )
      const chain = Buffer.from(
        zipSync({ 'project.json': strToU8(JSON.stringify(chainProject())) }),
      )
      const wait = Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(waitProject())) }))
      const twovars = Buffer.from(
        zipSync({ 'project.json': strToU8(JSON.stringify(twovarsProject())) }),
      )
      const compilerJs = await readFile(join(compilerDir, 'xyo_browser_ir.js')).catch(() => {
        throw new Error('metadata compiler not built; run the llvm-wasm prototype build first')
      })
      const compilerWasm = await readFile(join(compilerDir, 'xyo_browser_ir.wasm')).catch(() => {
        throw new Error('metadata compiler not built; run the llvm-wasm prototype build first')
      })
      const need = [
        'llvm19-browser-proof/llc-browser.mjs',
        'llvm19-browser-proof/llc-browser.wasm',
        'llvm19-lld-browser-proof/lld-browser.mjs',
        'llvm19-lld-browser-proof/lld-browser.wasm',
      ]
      const [llcJs, llcWasm, lldJs, lldWasm] = await Promise.all(
        need.map(async (f) => {
          try {
            return await readFile(join(llvmProofDir, f))
          } catch {
            throw new Error(`${f} missing; run the llvm-wasm browser relink first`)
          }
        }),
      )
      const bundle = async (entry: string) => {
        const built = await Bun.build({
          entrypoints: [join(llvmDir, 'src', entry)],
          target: 'browser',
          format: 'esm',
        })
        if (!built.success) throw new Error(`bun build ${entry} failed: ${built.logs}`)
        return Buffer.from(await built.outputs[0]!.text())
      }
      const [pipelineIndex, pipelineWorker] = await Promise.all([
        bundle('index.ts'),
        bundle('worker.ts'),
      ])
      const bundleEditor = async (entry: string) => {
        const built = await Bun.build({
          entrypoints: [join(root, 'src/lib', entry)],
          target: 'browser',
          format: 'esm',
        })
        if (!built.success) throw new Error(`bun build ${entry} failed: ${built.logs}`)
        return Buffer.from(await built.outputs[0]!.text())
      }
      const [llvmBackend, llvmRunner] = await Promise.all([
        bundleEditor('llvm-backend.ts'),
        bundleEditor('llvm-runner.ts'),
      ])
      const [registerXyo, runtimeBackends] = await Promise.all([
        bundleEditor('register-xyo.ts'),
        bundleEditor('runtime-backends.ts'),
      ])
      const packedDir = join(root, 'public', 'llvm-artifacts')
      const packedNames = [
        'xyo_browser_ir.js',
        'xyo_browser_ir.wasm',
        'pipeline-index.mjs',
        'pipeline-worker.mjs',
        'llc-browser.mjs',
        'llc-browser.wasm',
        'lld-browser.mjs',
        'lld-browser.wasm',
        'real_host.js',
        'real_host.wasm',
        'llvm-runner.worker.js',
        'unified_runtime_esm.mjs',
        'unified_runtime_esm.wasm',
      ] as const
      const packed: Record<string, Buffer> = {}
      for (const name of packedNames) {
        try {
          packed[name] = await readFile(join(packedDir, name))
        } catch {
          throw new Error(`${name} missing; run bun scripts/pack-llvm-artifacts.mjs first`)
        }
      }
      const bundleWorker = async () => {
        const built = await Bun.build({
          entrypoints: [join(root, 'src/lib/llvm-runner.worker.ts')],
          target: 'browser',
          format: 'iife',
        })
        if (!built.success) throw new Error(`bun build llvm-runner.worker failed: ${built.logs}`)
        return Buffer.from(await built.outputs[0]!.text())
      }
      const llvmRunnerWorker = await bundleWorker()
      const mixed = Buffer.from(
        zipSync({ 'project.json': strToU8(JSON.stringify(mixedBackendProject())) }),
      )
      const [realHostJs, realHostWasm] = await Promise.all(
        ['real_host.js', 'real_host.wasm'].map(async (f) => {
          try {
            return await readFile(join(realHostDir, f))
          } catch {
            throw new Error(`${f} missing; run the llvm-wasm real-host build first`)
          }
        }),
      )
      const routes = new Map<string, { body: Buffer; type: string }>([
        ['/', { body: Buffer.from(pageSource), type: 'text/html' }],
        ['/worker.js', { body: Buffer.from(workerSource), type: 'text/javascript' }],
        ['/compiler.js', { body: compilerJs, type: 'text/javascript' }],
        ['/compiler.wasm', { body: compilerWasm, type: 'application/wasm' }],
        ['/valid.sb3', { body: valid, type: 'application/octet-stream' }],
        ['/nul.sb3', { body: nul, type: 'application/octet-stream' }],
        ['/change.sb3', { body: change, type: 'application/octet-stream' }],
        ['/chain.sb3', { body: chain, type: 'application/octet-stream' }],
        ['/twovars.sb3', { body: twovars, type: 'application/octet-stream' }],
        ['/chain.sb3', { body: chain, type: 'application/octet-stream' }],
        ['/chain.html', { body: Buffer.from(chainPageSource), type: 'text/html' }],
        [
          '/chain-compiler-worker.js',
          { body: Buffer.from(chainCompilerSource), type: 'text/javascript' },
        ],
        ['/chain-worker.js', { body: Buffer.from(chainWorkerSource), type: 'text/javascript' }],
        ['/pipeline-index.mjs', { body: pipelineIndex, type: 'text/javascript' }],
        ['/pipeline-worker.mjs', { body: pipelineWorker, type: 'text/javascript' }],
        ['/llc-browser.mjs', { body: llcJs, type: 'text/javascript' }],
        ['/llc-browser.wasm', { body: llcWasm, type: 'application/wasm' }],
        ['/lld-browser.mjs', { body: lldJs, type: 'text/javascript' }],
        ['/lld-browser.wasm', { body: lldWasm, type: 'application/wasm' }],
        ['/exec.html', { body: Buffer.from(execPageSource), type: 'text/html' }],
        ['/exec-worker.js', { body: Buffer.from(execWorkerSource), type: 'text/javascript' }],
        ['/flow.html', { body: Buffer.from(flowPageSource), type: 'text/html' }],
        ['/flow-worker.js', { body: Buffer.from(flowWorkerSource), type: 'text/javascript' }],
        ['/wait.sb3', { body: wait, type: 'application/octet-stream' }],
        ['/mixed-backend.sb3', { body: mixed, type: 'application/octet-stream' }],
        ['/backend.html', { body: Buffer.from(backendPageSource), type: 'text/html' }],
        ['/llvm-backend.mjs', { body: llvmBackend, type: 'text/javascript' }],
        ['/llvm-runner.mjs', { body: llvmRunner, type: 'text/javascript' }],
        ['/llvm-runner.worker.js', { body: llvmRunnerWorker, type: 'text/javascript' }],
        ['/register.html', { body: Buffer.from(registerPageSource), type: 'text/html' }],
        ['/register-xyo.mjs', { body: registerXyo, type: 'text/javascript' }],
        ['/runtime-backends.mjs', { body: runtimeBackends, type: 'text/javascript' }],
        ...packedNames.map(
          (name) =>
            [
              `/llvm-artifacts/${name}`,
              {
                body: packed[name]!,
                type: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
              },
            ] as const,
        ),
        ['/real_host.js', { body: realHostJs, type: 'text/javascript' }],
        ['/real_host.wasm', { body: realHostWasm, type: 'application/wasm' }],
      ])
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        const route = req.method === 'GET' || req.method === 'HEAD' ? routes.get(path) : undefined
        if (!route) {
          res.writeHead(404).end()
          return
        }
        res
          .writeHead(200, { 'Content-Type': route.type })
          .end(req.method === 'HEAD' ? undefined : route.body)
      })
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server!.address()
      if (!address || typeof address === 'string') throw new Error('No available port')
      base = `http://127.0.0.1:${address.port}`
      browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    }, 60000)
    afterAll(async () => {
      try {
        await browser?.close()
      } finally {
        await new Promise<void>((resolve) => server?.close(() => resolve()))
      }
    })

    test('compiles a real SB3 to LLVM IR plus slot metadata, rejects NUL ids and garbage', async () => {
      const page = await browser!.newPage()
      try {
        page.on('pageerror', (error) => {
          throw error
        })
        await page.goto(base, { waitUntil: 'load' })
        await page.waitForFunction(
          () => document.querySelector('#result')?.textContent !== 'RUNNING',
          null,
          { timeout: 120000 },
        )
        const result = JSON.parse(await page.locator('#result').textContent()) as {
          ok: boolean
          error?: string
          cases?: Array<{
            name: string
            ok: boolean
            text?: string
            metadata?: { slots: unknown; abiFingerprintFNV1a64: string }
            error?: string
          }>
        }
        expect(result.ok).toBe(true)
        const cases = Object.fromEntries((result.cases ?? []).map((c) => [c.name, c]))
        expect(cases.valid?.ok).toBe(true)
        expect(cases.valid?.metadata?.slots).toEqual([
          { kind: 3, global: 'xyo_aot_slot_0', keyHex: '34003200' },
          { kind: 0, global: 'xyo_aot_slot_1', keyHex: '76' },
        ])
        expect(cases.valid?.metadata?.abiFingerprintFNV1a64).toMatch(/^[0-9a-f]{16}$/)
        expect(cases.valid?.text).toContain('define void @xyo_browser_script')
        expect(cases.valid?.text).toContain('wasm32-unknown-emscripten')
        expect(cases['nul-id']?.ok).toBe(false)
        expect(cases['nul-id']?.error).toContain('VARIABLE id')
        expect(cases.garbage?.ok).toBe(false)
        expect(cases.change?.ok).toBe(true)
        expect(cases.change?.metadata?.slots).toEqual([
          { kind: 3, global: 'xyo_aot_slot_0', keyHex: '34003200' },
          { kind: 0, global: 'xyo_aot_slot_1', keyHex: '76' },
        ])
        expect(cases.change?.text).toContain('define void @xyo_browser_script')
        expect(cases.chain?.ok).toBe(true)
        expect(cases.chain?.metadata?.slots).toEqual([
          { kind: 3, global: 'xyo_aot_slot_0', keyHex: '31003000' },
          { kind: 0, global: 'xyo_aot_slot_1', keyHex: '76' },
          { kind: 3, global: 'xyo_aot_slot_2', keyHex: '3500' },
          { kind: 3, global: 'xyo_aot_slot_3', keyHex: '3700' },
        ])
        expect(cases.chain?.text).toContain('define void @xyo_browser_script')
        expect(cases.chain?.ok).toBe(true)
        expect(cases.chain?.metadata?.slots).toEqual([
          { kind: 3, global: 'xyo_aot_slot_0', keyHex: '31003000' },
          { kind: 0, global: 'xyo_aot_slot_1', keyHex: '76' },
          { kind: 3, global: 'xyo_aot_slot_2', keyHex: '3500' },
          { kind: 3, global: 'xyo_aot_slot_3', keyHex: '3700' },
        ])
        expect(cases.chain?.text).toContain('define void @xyo_browser_script')
      } finally {
        await page.close()
      }
    }, 180000)

    test('links the generated IR to a shared side module through real browser llc/LLD', async () => {
      const page = await browser!.newPage()
      try {
        page.on('pageerror', (error) => {
          throw error
        })
        await page.goto(`${base}/chain.html`, { waitUntil: 'load' })
        await page.waitForFunction(
          () => document.querySelector('#result')?.textContent !== 'RUNNING',
          null,
          { timeout: 170000 },
        )
        const result = JSON.parse(await page.locator('#result').textContent()) as {
          ok: boolean
          error?: string
          side?: {
            ok: boolean
            error?: string
            sideBytes?: number
            imports?: Array<{ module: string; name: string; kind: string }>
            exports?: Array<{ name: string; kind: string }>
            diagnostics?: boolean
          }
          metadata?: { slots: unknown }
        }
        expect(result.ok).toBe(true)
        expect(result.side?.ok).toBe(true)
        expect(result.side?.sideBytes).toBeGreaterThan(0)
        expect(result.side?.diagnostics).toBe(true)
        const byKey = (list: Array<{ module: string; name: string; kind: string }>) =>
          list.map((x) => JSON.stringify(x)).sort()
        expect(byKey(result.side?.imports ?? [])).toEqual(
          byKey([
            { module: 'env', name: 'memory', kind: 'memory' },
            { module: 'env', name: '__memory_base', kind: 'global' },
            { module: 'env', name: '__table_base', kind: 'global' },
            { module: 'env', name: 'xyo_varslot_init', kind: 'function' },
            { module: 'GOT.mem', name: 'xyo_aot_slot_0', kind: 'global' },
            { module: 'GOT.mem', name: 'xyo_aot_slot_1', kind: 'global' },
          ]),
        )
        expect(result.side?.exports).toContainEqual({
          name: 'xyo_browser_script',
          kind: 'function',
        })
        expect(result.metadata?.slots).toEqual([
          { kind: 3, global: 'xyo_aot_slot_0', keyHex: '34003200' },
          { kind: 0, global: 'xyo_aot_slot_1', keyHex: '76' },
        ])
      } finally {
        await page.close()
      }
    }, 180000)

    test('green-flag flow: admit first, then LLVM-compile+execute or fall back', async () => {
      const envImports = (
        extra: Array<{ module: string; name: string; kind: string }>,
        slots: string[],
      ) => [
        { module: 'env', name: 'memory', kind: 'memory' },
        { module: 'env', name: '__memory_base', kind: 'global' },
        { module: 'env', name: '__table_base', kind: 'global' },
        ...extra,
        ...slots.map((name) => ({ module: 'GOT.mem', name, kind: 'global' })),
      ]
      const slotExports = (slots: string[]) => [
        '__wasm_call_ctors',
        '__wasm_apply_data_relocs',
        'xyo_browser_script',
        ...slots,
      ]
      const noHelper = [{ module: 'env', name: 'xyo_varslot_init', kind: 'function' }]
      const withToNum = [...noHelper, { module: 'env', name: 'xyo_to_num', kind: 'function' }]
      const fixtures = [
        {
          name: 'valid',
          url: '/valid.sb3',
          project: project('v', '42') as unknown as Record<string, unknown>,
          imports: envImports(noHelper, ['xyo_aot_slot_0', 'xyo_aot_slot_1']),
          exports: slotExports(['xyo_aot_slot_0', 'xyo_aot_slot_1']),
        },
        {
          name: 'change',
          url: '/change.sb3',
          project: changeProject() as unknown as Record<string, unknown>,
          imports: envImports(withToNum, ['xyo_aot_slot_1']),
          exports: slotExports(['xyo_aot_slot_0', 'xyo_aot_slot_1']),
        },
        {
          name: 'chain',
          url: '/chain.sb3',
          project: chainProject() as unknown as Record<string, unknown>,
          imports: envImports(withToNum, ['xyo_aot_slot_0', 'xyo_aot_slot_1']),
          exports: slotExports([
            'xyo_aot_slot_0',
            'xyo_aot_slot_1',
            'xyo_aot_slot_2',
            'xyo_aot_slot_3',
          ]),
        },
        {
          name: 'twovars',
          url: '/twovars.sb3',
          project: twovarsProject() as unknown as Record<string, unknown>,
          imports: envImports(noHelper, [
            'xyo_aot_slot_0',
            'xyo_aot_slot_1',
            'xyo_aot_slot_2',
            'xyo_aot_slot_3',
          ]),
          exports: slotExports([
            'xyo_aot_slot_0',
            'xyo_aot_slot_1',
            'xyo_aot_slot_2',
            'xyo_aot_slot_3',
          ]),
        },
        {
          name: 'wait',
          url: '/wait.sb3',
          project: waitProject() as unknown as Record<string, unknown>,
          imports: [],
          exports: [],
        },
      ]
      const page = await browser!.newPage()
      try {
        page.on('pageerror', (error) => {
          throw error
        })
        await page.addInitScript(
          (fixturesJson) => {
            ;(window as unknown as { __flowFixtures: unknown }).__flowFixtures = JSON.parse(
              fixturesJson as string,
            )
          },
          JSON.stringify(
            fixtures.map((f) => ({
              name: f.name,
              url: f.url,
              project: f.project,
              imports: f.imports,
              exports: f.exports,
            })),
          ),
        )
        await page.goto(`${base}/flow.html`, { waitUntil: 'load' })
        await page.waitForFunction(
          () => document.querySelector('#result')?.textContent !== 'RUNNING',
          null,
          { timeout: 170000 },
        )
        const result = JSON.parse(await page.locator('#result').textContent()) as {
          ok: boolean
          error?: string
          cases?: Array<{
            name: string
            result: {
              ok: boolean
              error?: string
              route?: string
              reason?: string
              variables?: Array<{ id: string; valueHex: string; units: number[] | null }>
              metadata?: { slots: unknown }
            }
          }>
        }
        expect(result.ok).toBe(true)
        const byName = Object.fromEntries((result.cases ?? []).map((c) => [c.name, c.result]))
        const varsById = (r: {
          variables?: Array<{ id: string; valueHex: string; units: number[] | null }>
        }) => Object.fromEntries((r.variables ?? []).map((v) => [v.id, v]))
        expect(byName.valid?.route).toBe('llvm')
        expect(varsById(byName.valid!).v?.units).toEqual([0x34, 0x32])
        expect(BigInt(varsById(byName.valid!).v?.valueHex ?? '0x0') >> 48n).toBe(0x7ff9n)
        expect(byName.change?.route).toBe('llvm')
        expect(BigInt(varsById(byName.change!).v?.valueHex ?? '0x0')).toBe(0x4045000000000000n)
        expect(byName.chain?.route).toBe('llvm')
        expect(BigInt(varsById(byName.chain!).v?.valueHex ?? '0x0')).toBe(0x4036000000000000n)
        expect(byName.twovars?.route).toBe('llvm')
        expect(varsById(byName.twovars!).v?.units).toEqual([0x31, 0x30])
        expect(varsById(byName.twovars!).w?.units).toEqual([0x32, 0x30])
        expect(byName.wait?.route).toBe('fallback')
        expect(byName.wait?.ok).toBe(true)
        // Commit-back: executed values patch into loadable project JSON.
        const committed = (proj: unknown, name: string) => {
          const c = commitFlowValues(proj, byName[name]?.variables ?? [])
          expect(c.ok).toBe(true)
          if (!c.ok) throw new Error('commit failed for ' + name)
          return (c.project as { targets: Array<{ variables: Record<string, [string, unknown]> }> })
            .targets[0]!.variables
        }
        expect(committed(project('v', '42'), 'valid').v).toEqual(['v', '42'])
        expect(committed(changeProject(), 'change').v).toEqual(['v', 42])
        expect(committed(chainProject(), 'chain').v).toEqual(['v', 22])
        const two = committed(twovarsProject(), 'twovars')
        expect(two.v).toEqual(['v', '10'])
        expect(two.w).toEqual(['w', '20'])
      } finally {
        await page.close()
      }
    }, 300000)

    test('product backend: admitted change runs on LLVM and accumulates across flags', async () => {
      const page = await browser!.newPage()
      try {
        page.on('pageerror', (error) => {
          throw error
        })
        await page.goto(`${base}/backend.html`, { waitUntil: 'load' })
        await page.waitForFunction(
          () => document.querySelector('#result')?.textContent !== 'RUNNING',
          null,
          { timeout: 240000 },
        )
        const result = JSON.parse(await page.locator('#result').textContent()) as {
          ok: boolean
          error?: string
          first?: { v?: unknown; x?: unknown }
          v?: unknown
          x?: unknown
          lastError?: string
        }
        expect(result.ok).toBe(true)
        // First flag: change-by-42 on LLVM, motion once inside.
        expect(result.first?.v).toBe(42)
        expect(result.first?.x).toBe(10)
        // Reflag accumulates from live state (42 + 42), motion runs again.
        expect(result.v).toBe(84)
        expect(result.x).toBe(20)
        expect(result.lastError).toBe('null')
      } finally {
        await page.close()
      }
    }, 300000)

    test('registry path: register, create xyo-cpp, green flag runs LLVM + built-in side by side', async () => {
      const page = await browser!.newPage()
      try {
        page.on('pageerror', (error) => {
          throw error
        })
        await page.goto(`${base}/register.html`, { waitUntil: 'load' })
        await page.waitForFunction(
          () => document.querySelector('#result')?.textContent !== 'RUNNING',
          null,
          { timeout: 240000 },
        )
        const result = JSON.parse(await page.locator('#result').textContent()) as {
          ok: boolean
          error?: string
          label?: string
          v?: unknown
          x?: unknown
          lastError?: string
        }
        expect(result.ok).toBe(true)
        expect(result.label).toContain('実験的')
        expect(result.v).toBe(42)
        expect(result.x).toBe(10)
      } finally {
        await page.close()
      }
    }, 300000)

    test('executes the linked side module in the real xyo runtime and reads the variable back', async () => {
      const page = await browser!.newPage()
      try {
        page.on('pageerror', (error) => {
          throw error
        })
        await page.goto(`${base}/exec.html`, { waitUntil: 'load' })
        await page.waitForFunction(
          () => document.querySelector('#result')?.textContent !== 'RUNNING',
          null,
          { timeout: 170000 },
        )
        const result = JSON.parse(await page.locator('#result').textContent()) as {
          ok: boolean
          error?: string
          runs?: Array<{
            ok: boolean
            error?: string
            valueHex?: string
            units?: number[]
            variable?: boolean
            metadata?: { slots: unknown }
          }>
        }
        expect(result.ok).toBe(true)
        expect(result.runs).toHaveLength(2)
        for (const run of result.runs ?? []) {
          expect(run.ok).toBe(true)
          expect(run.variable).toBe(true)
          // NaN-boxed string tag with a live heap pointer; exact pointer varies per run.
          expect(BigInt(run.valueHex ?? '0x0') >> 48n).toBe(0x7ff9n)
          // UTF-16 "42" survived the invoke and an explicit GC on both sides.
          expect(run.units).toEqual([0x34, 0x32])
          expect(run.metadata?.slots).toEqual([
            { kind: 3, global: 'xyo_aot_slot_0', keyHex: '34003200' },
            { kind: 0, global: 'xyo_aot_slot_1', keyHex: '76' },
          ])
        }
      } finally {
        await page.close()
      }
    }, 180000)
  },
)
