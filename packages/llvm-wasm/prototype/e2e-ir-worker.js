// Test-only: generate IR from SB3 with the isolated native xyo LLVM codegen.
importScripts('/compiler/xyo_browser_ir.js');
onmessage = async ({data}) => {
  try {
    let memory;
    const response = await fetch('/compiler/xyo_browser_ir.wasm');
    if (!response.ok) throw Error('compiler wasm fetch failed');
    const binary = await response.arrayBuffer();
    const compiler = await createXyoBrowserIr({instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), imports);
      memory = Object.values(instance.exports).find(x => x instanceof WebAssembly.Memory);
      ready(instance);
      return instance.exports;
    }});
    if (!memory) throw Error('compiler memory missing');
    const bytes = new Uint8Array(data);
    const ptr = compiler._malloc(bytes.length);
    if (!ptr) throw Error('input allocation failed');
    new Uint8Array(memory.buffer).set(bytes, ptr);
    const result = compiler._xyo_browser_ir_compile(ptr, bytes.length);
    compiler._free(ptr);
    if (!result) throw Error('compiler result allocation failed');
    try {
      const ok = !!compiler._xyo_browser_ir_ok(result);
      const start = ok ? compiler._xyo_browser_ir_text(result) : compiler._xyo_browser_ir_error(result);
      const heap = new Uint8Array(memory.buffer); let end = start;
      while (heap[end]) ++end;
      const text = new TextDecoder().decode(heap.subarray(start, end));
      if (!ok) throw Error(text);
      postMessage({ok: true, ir: text});
    } finally { compiler._xyo_browser_ir_destroy(result); }
  } catch(e) { postMessage({ok: false, error: String(e)}); }
};
