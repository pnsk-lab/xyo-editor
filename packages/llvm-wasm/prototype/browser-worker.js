// Standalone test only. No product integration or generated-code execution.
importScripts('/packages/llvm-wasm/.work/prototype-build/xyo_browser_ir.js');
onmessage = async ({data}) => {
  try {
    let memory;
    const binary = await (await fetch('/packages/llvm-wasm/.work/prototype-build/xyo_browser_ir.wasm')).arrayBuffer();
    const compiler = await createXyoBrowserIr({instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), imports);
      memory = Object.values(instance.exports).find(x => x instanceof WebAssembly.Memory);
      ready(instance);
      return instance.exports;
    }});
    if (!memory) throw Error('missing Wasm memory');
    const results = [];
    for (const [name, expected] of [['valid', true], ['wait', false], ['two-hats', false]]) {
      const bytes = new Uint8Array(await (await fetch(`/packages/llvm-wasm/.work/smoke-fixtures/${name}.sb3`)).arrayBuffer());
      const p = compiler._malloc(bytes.length);
      if (!p) throw Error('malloc failed');
      new Uint8Array(memory.buffer).set(bytes, p);
      const r = compiler._xyo_browser_ir_compile(p, bytes.length);
      compiler._free(p);
      if (!r) throw Error('null result');
      const ok = !!compiler._xyo_browser_ir_ok(r);
      const offset = ok ? compiler._xyo_browser_ir_text(r) : compiler._xyo_browser_ir_error(r);
      const heap = new Uint8Array(memory.buffer); let end = offset;
      while (heap[end]) ++end;
      const text = new TextDecoder().decode(heap.subarray(offset, end));
      compiler._xyo_browser_ir_destroy(r);
      if (ok !== expected) throw Error(`${name}: ${text}`);
      if (ok && (!/target triple = "wasm32-unknown-emscripten"/.test(text) ||
          !/define void @xyo_browser_script\(ptr %0\)/.test(text) ||
          !/@xyo_aot_slot_0 = global ptr null/.test(text) ||
          !/@xyo_aot_slot_1 = global ptr null/.test(text) ||
          !/call void @xyo_varslot_init\(ptr %0/.test(text))) throw Error('IR invariant mismatch');
      results.push(`${name}: ${ok ? 'IR produced' : 'rejected'}`);
    }
    postMessage({ok: true, results});
  } catch (e) { postMessage({ok: false, error: String(e)}); }
};
