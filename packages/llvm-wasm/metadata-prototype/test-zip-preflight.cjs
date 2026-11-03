// ZIP preflight battery: every fuzz/*.sb3 except stored-valid.sb3 must be
// rejected before any large allocation or codegen. No generated code runs.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const factory = require(path.resolve(process.argv[2])), dir = process.argv[3];
const fuzz = path.join(dir, 'fuzz');
(async () => {
  let memory;
  const wasm = fs.readFileSync(path.join(path.dirname(path.resolve(process.argv[2])), 'xyo_browser_ir.wasm'));
  const compiler = await factory({ instantiateWasm(imports, ready) {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports);
    memory = Object.values(instance.exports).find(x => x instanceof WebAssembly.Memory);
    ready(instance); return instance.exports;
  }});
  assert(memory);
  const read = p => { const b = new Uint8Array(memory.buffer); let n = p; while (b[n]) n++; return new TextDecoder().decode(b.subarray(p, n)); };
  const compile = file => {
    const bytes = fs.readFileSync(file);
    const ptr = compiler._malloc(bytes.length); assert(ptr);
    new Uint8Array(memory.buffer).set(bytes, ptr);
    const r = compiler._xyo_browser_ir_compile(ptr, bytes.length); compiler._free(ptr); assert(r);
    try {
      return { ok: !!compiler._xyo_browser_ir_ok(r), ir: read(compiler._xyo_browser_ir_text(r)),
               metadata: read(compiler._xyo_browser_ir_metadata(r)), error: read(compiler._xyo_browser_ir_error(r)) };
    } finally { compiler._xyo_browser_ir_destroy(r); }
  };
  const ref = compile(path.join(dir, 'simple.sb3'));
  assert.equal(ref.ok, true, ref.error);
  const names = fs.readdirSync(fuzz).filter(f => f.endsWith('.sb3')).sort();
  assert(names.length > 10, 'fuzz battery missing');
  for (const name of names) {
    const r = compile(path.join(fuzz, name));
    if (name === 'stored-valid.sb3') {
      assert.equal(r.ok, true, `${name}: ${r.error}`);
      assert.equal(r.ir, ref.ir, `${name} IR differs`);
      assert.equal(r.metadata, ref.metadata, `${name} metadata differs`);
      console.log(`${name}: accepted with identical IR/metadata`);
      continue;
    }
    assert.equal(r.ok, false, `${name} unexpectedly accepted`);
    assert.equal(r.ir, '', `${name} leaked IR`);
    assert.equal(r.metadata, '', `${name} leaked metadata`);
    const size = fs.statSync(path.join(fuzz, name)).size;
    if (size === 0) assert.equal(r.error, 'invalid input size', `${name}: ${r.error}`);
    else assert.match(r.error, /^zip preflight rejected: /, `${name}: ${r.error}`);
    console.log(`${name}: rejected: ${r.error}`);
  }
  console.log(`PASS: zip preflight battery (${names.length} fixtures), fail-closed, no execution`);
})().catch(e => { console.error(e); process.exitCode = 1; });
