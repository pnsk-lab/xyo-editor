/** Classic worker: runs one admitted script through the real LLVM chain.
 *
 * All artifact URLs arrive in the message so the same file serves the test
 * harness and (later) the app. The import/export ceiling is fixed for the
 * admitted subset: at most 8 blocks, each contributing at most one VarId and
 * one StrLit slot, so 16 GOT globals cover every shape; the pipeline rejects
 * anything outside this closed vocabulary.
 */
importScripts();
onmessage = async (e: MessageEvent) => {
  try {
    const { op, project, sb3, build, urls } = e.data as {
      op: 'build' | 'run';
      project?: unknown;
      sb3: Uint8Array;
      build?: { side: Uint8Array; metadata: { abiDescriptor: string; slots: Array<{ global: string; kind: number; keyHex: string }> } };
      urls: Record<string, string>;
    };
    (globalThis as unknown as { importScripts: (...urls: string[]) => void }).importScripts(urls.compilerJs, urls.hostJs);
    const { createLLVMWorkerClient, LLVMPipeline } = await import(urls.pipelineIndex);
    const wasmBin = new Uint8Array(await (await fetch(urls.compilerWasm)).arrayBuffer());
    let compilerMemory: ArrayBuffer | undefined;
    const compiler = await (globalThis as unknown as Record<string, (opts: unknown) => Promise<unknown>>).createXyoBrowserIr({
      instantiateWasm(imports: unknown, ready: (exports: unknown) => void) {
        const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBin), imports as WebAssembly.Imports);
        compilerMemory = (Object.values(instance.exports).find(v => v instanceof WebAssembly.Memory) as WebAssembly.Memory | undefined)?.buffer as ArrayBuffer | undefined;
        ready(instance);
        return instance.exports;
      },
    }) as {
      _malloc(n: number): number; _free(p: number): void;
      _xyo_browser_ir_compile(p: number, n: number): number;
      _xyo_browser_ir_ok(r: number): number; _xyo_browser_ir_error(r: number): number;
      _xyo_browser_ir_text(r: number): number; _xyo_browser_ir_metadata(r: number): number;
      _xyo_browser_ir_destroy(r: number): void;
    };
    const readCompiler = (p: number) => {
      const b = new Uint8Array(compilerMemory as ArrayBuffer);
      let n = p;
      while (b[n]) n++;
      return new TextDecoder().decode(b.subarray(p, n));
    };
    const hostWasm = new Uint8Array(await (await fetch(urls.hostWasm)).arrayBuffer());
    const m = await (globalThis as unknown as Record<string, (opts: unknown) => Promise<HostModule>>).createXyoRealHost({ wasmBinary: hostWasm });
    const alloc = (b: Uint8Array) => { const p = m._malloc(b.length || 1); m.HEAPU8.set(b, p); return p; };
    const str = (s: string) => alloc(new TextEncoder().encode(s + '\0'));
    const read = (p: number) => { let n = p; while (m.HEAPU8[n]) n++; return new TextDecoder().decode(m.HEAPU8.subarray(p, n)); };
    const gotGlobals = Array.from({ length: 16 }, (_, i) => `xyo_aot_slot_${i}`);
    const exports = ['xyo_browser_script', ...gotGlobals];
    const doCompile = async (input: Uint8Array) => {
      const cp = compiler._malloc(input.length);
      new Uint8Array(compilerMemory as ArrayBuffer).set(input, cp);
      const cr = compiler._xyo_browser_ir_compile(cp, input.length);
      compiler._free(cp);
      if (!cr) throw new Error('null compile result');
      try {
        if (!compiler._xyo_browser_ir_ok(cr)) throw new Error(readCompiler(compiler._xyo_browser_ir_error(cr)));
        return { ir: readCompiler(compiler._xyo_browser_ir_text(cr)), metadata: JSON.parse(readCompiler(compiler._xyo_browser_ir_metadata(cr))) };
      } finally { compiler._xyo_browser_ir_destroy(cr); }
    };
    const doLink = async (ir: string) => {
      const client = createLLVMWorkerClient(urls.pipelineWorker, urls.llcWorker, urls.lldWorker);
      const pipeline = new LLVMPipeline(client);
      try {
        return new Uint8Array((await pipeline.compile({ ir, exports, sideModule: true })).binary);
      } finally { pipeline.stop(); }
    };
    if (op === 'build') {
      const { ir, metadata } = await doCompile(sb3);
      const side = await doLink(ir);
      (postMessage as (value: unknown) => void)({ ok: true, build: { side, metadata } });
      return;
    }
    if (op === 'run') {
      if (!build) throw new Error('missing build');
      const { variables } = await doExecute({ sb3, side: build.side, abiDescriptor: build.metadata.abiDescriptor, slots: build.metadata.slots });
      (postMessage as (value: unknown) => void)({ ok: true, variables });
      return;
    }
    throw new Error(`unknown op ${String(op)}`);
    async function doExecute({ sb3: bytes, side, abiDescriptor, slots }: { sb3: Uint8Array; side: Uint8Array; abiDescriptor: string; slots: Array<{ global: string; kind: number; keyHex: string }> }) {
        if (read(m._rh_abi_descriptor()) !== abiDescriptor) throw new Error('ABI descriptor mismatch');
        const data = alloc(bytes), h = m._rh_create(data, bytes.length); m._free(data);
        if (read(m._rh_error(h)) !== '') throw new Error('host load: ' + read(m._rh_error(h)));
        m.FS.writeFile('/fixture-side.wasm', side);
        const hp = str('/fixture-side.wasm'), handle = m._rh_dlopen_for(h, hp); m._free(hp);
        if (!handle) throw new Error('dlopen failed');
        const sym = (s: string) => { const q = str(s), v = m._rh_dlsym(handle, q); m._free(q); if (!v) throw new Error('dlsym ' + s); return v; };
        const entry = sym('xyo_browser_script');
        if (m._rh_expect_slots(h, slots.length) !== 1) throw new Error('expect slots');
        const bound: Array<{ global: string; kind: number; key: Uint8Array }> = [];
        for (const s of slots as Array<{ global: string; kind: number; keyHex: string }>) {
          if (s.kind !== 0 && s.kind !== 3) throw new Error('slot kind');
          const key = Uint8Array.from(s.keyHex.match(/../g) || [], b => parseInt(b, 16));
          const addr = sym(s.global), q = alloc(key);
          if (m._rh_bind_slot(h, addr, s.kind, q, key.length) !== 1) throw new Error('bind ' + s.global);
          m._free(q); bound.push({ global: s.global, kind: s.kind, key });
        }
        if (!m._rh_is_sealed(h)) throw new Error('binding incomplete');
        const lookups: Array<{ id: string; p: number; v: number }> = [];
        for (const s of bound) {
          if (s.kind !== 0) continue;
          const id0 = new Uint8Array(s.key.length + 1); id0.set(s.key);
          const p = alloc(id0), v = m._rh_variable(h, p);
          // No zero-initial assumption: the backend seeds live values, so
          // reflag executions legitimately start from nonzero state.
          if (!v) throw new Error('variable missing');
          lookups.push({ id: new TextDecoder().decode(s.key), p, v });
        }
        m._rh_invoke(entry, h);
        const variables: Array<{ id: string; valueHex: string; units: number[] | null }> = [];
        let vi = 0;
        for (const L of lookups) {
          if (m._rh_var_slot(h, vi) !== L.v) throw new Error('slot mismatch');
          const bits = m._rh_variable_bits(L.v);
          const len = m._rh_variable_string_length(L.v);
          const units = len >= 0 ? Array.from({ length: len }, (_, i) => m._rh_variable_string_unit(L.v, i)) : null;
          m._rh_collect();
          if (m._rh_variable_bits(L.v) !== bits) throw new Error('value did not survive GC');
          variables.push({ id: L.id, valueHex: '0x' + bits.toString(16), units });
          vi++;
        }
        m._rh_destroy(h);
        if (m._rh_dlclose(handle) !== 0) throw new Error('dlclose failed');
        for (const L of lookups) m._free(L.p);
        return { variables };
    }
  } catch (err) {
    (postMessage as (value: unknown) => void)({ ok: false, error: String((err && (err as Error).stack) || err) });
  }
};

interface HostModule {
  HEAPU8: Uint8Array;
  FS: { writeFile(path: string, data: Uint8Array): void };
  _malloc(n: number): number;
  _free(p: number): void;
  _rh_abi_descriptor(): number;
  _rh_create(p: number, n: number): number;
  _rh_error(h: number): number;
  _rh_context(h: number): number;
  _rh_dlopen_for(h: number, p: number): number;
  _rh_dlsym(handle: number, p: number): number;
  _rh_expect_slots(h: number, n: number): number;
  _rh_bind_slot(h: number, addr: number, kind: number, p: number, n: number): number;
  _rh_is_sealed(h: number): number;
  _rh_variable(h: number, p: number): number;
  _rh_variable_bits(v: number): bigint;
  _rh_var_slot(h: number, i: number): number;
  _rh_variable_string_length(v: number): number;
  _rh_variable_string_unit(v: number, i: number): number;
  _rh_slot_value(addr: number): number;
  _rh_invoke(entry: number, h: number): void;
  _rh_collect(): void;
  _rh_destroy(h: number): void;
  _rh_dlclose(handle: number): number;
}
