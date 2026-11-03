'use strict';
// A closed-world fixture check, NOT a dynamic linker or xyo runtime.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const bytes = fs.readFileSync(process.argv[2]);
const module_ = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module_);
const exports_ = WebAssembly.Module.exports(module_);
const sort = x => x.map(o => JSON.stringify(o)).sort();
assert.deepEqual(sort(imports), sort([
  {module:'env', name:'memory', kind:'memory'},
  {module:'env', name:'__memory_base', kind:'global'},
  {module:'env', name:'__table_base', kind:'global'},
  {module:'env', name:'xyo_varslot_init', kind:'function'},
  {module:'GOT.mem', name:'xyo_aot_slot_0', kind:'global'},
  {module:'GOT.mem', name:'xyo_aot_slot_1', kind:'global'},
]));
assert.deepEqual(sort(exports_), sort([
  {name:'__wasm_call_ctors', kind:'function'},
  {name:'__wasm_apply_data_relocs', kind:'function'},
  {name:'xyo_browser_script', kind:'function'},
  {name:'xyo_aot_slot_0', kind:'global'},
  {name:'xyo_aot_slot_1', kind:'global'},
]));
// Reject metadata we do not understand: exact dylink.0 memory-info subsection,
// including no needed libraries, export/import-info, or extra subsections.
const dylinks = WebAssembly.Module.customSections(module_, 'dylink.0');
assert.equal(dylinks.length, 1);
assert.deepEqual([...new Uint8Array(dylinks[0])], [1, 4, 12, 2, 0, 0]);
assert.equal(WebAssembly.Module.customSections(module_, 'dylink').length, 0);
const memorySize = 12, memoryAlign = 2 ** 2, tableSize = 0;
const base = 0x1000, tableBase = 0, ctx = 0x2000, slots = 0x2100, slot = 0x2200;
const literalPointer = 0x3450, variableIdPointer = 0x4560;
assert.equal(base % memoryAlign, 0);
assert.equal(slot % 8, 0);
assert.equal(tableSize, 0);
assert.ok(base + memorySize <= ctx && ctx + 72 <= slots && slots + 4 <= slot && slot + 48 <= 65536);
const memory = new WebAssembly.Memory({initial:1});
const view = new DataView(memory.buffer);
const global = (value, mutable = false) => new WebAssembly.Global({value:'i32', mutable}, value);
const got0 = global(0, true), got1 = global(0, true);
let calls = 0;
const instance = new WebAssembly.Instance(module_, {
  env: {memory, __memory_base:global(base), __table_base:global(tableBase),
    xyo_varslot_init(context, index, variableId, name, flags) {
      calls++;
      assert.equal(context, ctx); assert.equal(index, 0n);
      assert.equal(variableId, variableIdPointer);
      assert.equal(name, base); assert.equal(view.getUint16(name, true), 118);
      assert.equal(view.getUint16(name + 2, true), 0); assert.equal(flags, 0);
    }},
  'GOT.mem': {xyo_aot_slot_0:got0, xyo_aot_slot_1:got1},
});
const e = instance.exports;
// LLD exports data-symbol offsets relative to __memory_base, not absolute addresses.
assert.equal(e.xyo_aot_slot_0.value, 4);
assert.equal(e.xyo_aot_slot_1.value, 8);
assert.ok(e.xyo_aot_slot_0.value + 4 <= memorySize);
assert.ok(e.xyo_aot_slot_1.value + 4 <= memorySize);
assert.ok(e.xyo_aot_slot_0.value + 4 <= e.xyo_aot_slot_1.value);
got0.value = base + e.xyo_aot_slot_0.value; got1.value = base + e.xyo_aot_slot_1.value;
assert.equal(got0.value % 4, 0); assert.equal(got1.value % 4, 0);
e.__wasm_apply_data_relocs(); e.__wasm_call_ctors();
view.setUint32(got0.value, literalPointer, true);
view.setUint32(got1.value, variableIdPointer, true);
view.setUint32(ctx + 68, slots, true);
view.setUint32(slots, slot, true);
view.setBigUint64(slot + 40, 0n, true);
e.xyo_browser_script(ctx);
const bits = view.getBigUint64(slot + 40, true);
const expected = 9221401712017801216n | BigInt(literalPointer);
assert.equal(calls, 1); assert.equal(bits, expected);
console.log(JSON.stringify({imports, exports:exports_, dylink:{memorySize,memoryAlign,tableSize,tableAlign:1}, base, got:{slot0:got0.value,slot1:got1.value}, helperCalls:calls, bits:'0x'+bits.toString(16)}, null, 2));
console.log('PASS: synthetic fixture only; no claim about real xyo memory, GC, ABI or safe execution');
