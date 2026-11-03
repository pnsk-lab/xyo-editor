// Run after the real prototype links: node smoke.cjs /path/to/xyo_browser_ir.js fixture-dir
const fs = require('node:fs');
const path = require('node:path');
const factory = require(path.resolve(process.argv[2]));
const dir = process.argv[3];
(async () => {
  let memory;
  const wasm = fs.readFileSync(path.join(path.dirname(path.resolve(process.argv[2])), 'xyo_browser_ir.wasm'));
  const mod = await factory({ instantiateWasm(imports, ready) {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports);
    memory = Object.values(instance.exports).find(value => value instanceof WebAssembly.Memory);
    ready(instance);
    return instance.exports;
  }});
  if (!memory) throw Error('module did not export memory');
  const read = p => { const heap = new Uint8Array(memory.buffer); let n = p; while (heap[n]) ++n; return new TextDecoder().decode(heap.subarray(p, n)); };
  for (const [name, expected] of [['valid', true], ['wait', false], ['two-hats', false]]) {
    const input = fs.readFileSync(path.join(dir, name + '.sb3'));
    const ptr = mod._malloc(input.length);
    if (!ptr) throw Error('input allocation failed');
    new Uint8Array(memory.buffer).set(input, ptr);
    const result = mod._xyo_browser_ir_compile(ptr, input.length);
    mod._free(ptr);
    if (!result) throw Error('null result');
    try {
      const ok = !!mod._xyo_browser_ir_ok(result);
      const detail = read(ok ? mod._xyo_browser_ir_text(result) : mod._xyo_browser_ir_error(result));
      if (ok !== expected) throw Error(`${name}: unexpected ${ok}, ${detail}`);
      if (ok) {
        const expect = [
          /target triple = "wasm32-unknown-emscripten"/,
          /target datalayout = "[^"]*p:32:32/,
          /define void @xyo_browser_script\(ptr %0\)/,
          /@xyo_aot_slot_0 = global ptr null/,
          /@xyo_aot_slot_1 = global ptr null/,
          /load ptr, ptr @xyo_aot_slot_0/,
          /load ptr, ptr @xyo_aot_slot_1/,
          /call void @xyo_varslot_init\(ptr %0, i64 0, ptr %\d+, ptr @u16, i32 0\)/,
          /declare void @xyo_varslot_init\(ptr, i64, ptr, ptr, i32\)/,
        ];
        for (const pattern of expect) if (!pattern.test(detail)) throw Error(`missing IR invariant: ${pattern}`);
        const calls = [...detail.matchAll(/^\s*(?:%\d+ = )?call\s+[^@\n]*@([^ (]+)\(/gm)].map(m => m[1]);
        if (calls.length !== 1 || calls[0] !== 'xyo_varslot_init' || (detail.match(/\bcall\b/g) || []).length !== 1 || /\b(?:invoke|callbr)\b/.test(detail))
          throw Error(`unexpected call graph: ${calls}`);
      }
      if (ok && process.env.XYO_IR_OUT) fs.writeFileSync(process.env.XYO_IR_OUT, detail);
      console.log(`${name}: ${ok ? 'IR produced' : 'rejected: ' + detail}`);
    } finally { mod._xyo_browser_ir_destroy(result); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
