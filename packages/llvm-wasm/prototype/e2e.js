// Test-only: real SB3 → xyo/LLVM-in-Wasm → production LLVMPipeline → side module.
// Strict synthetic host for this exact fixture only; NOT an xyo runtime, loader, or GC.
import {createLLVMWorkerClient, LLVMPipeline} from '/pipeline-index.mjs';
const imports = [
  {module:'env', name:'memory', kind:'memory'},
  {module:'env', name:'__memory_base', kind:'global'},
  {module:'env', name:'__table_base', kind:'global'},
  {module:'env', name:'xyo_varslot_init', kind:'function'},
  {module:'GOT.mem', name:'xyo_aot_slot_0', kind:'global'},
  {module:'GOT.mem', name:'xyo_aot_slot_1', kind:'global'},
];
const out = document.querySelector('#result');
const assert = (v, text) => { if (!v) throw Error(text); };
let worker, pipeline;
try {
  const response = await fetch('/fixture.sb3');
  assert(response.ok, 'fixture fetch failed');
  const bytes = await response.arrayBuffer();
  worker = new Worker('/e2e-ir-worker.js');
  const generated = await new Promise((resolve,reject) => {
    worker.onmessage = e => resolve(e.data);
    worker.onerror = e => reject(Error(e.message));
    worker.postMessage(bytes,[bytes]);
  });
  worker.terminate(); worker = undefined;
  assert(generated.ok, 'xyo IR: ' + generated.error);
  const ir = generated.ir;
  for (const re of [/target triple = "wasm32-unknown-emscripten"/, /target datalayout = "[^"]*p:32:32/, /define void @xyo_browser_script\(ptr %0\)/, /@xyo_aot_slot_0 = global ptr null/, /@xyo_aot_slot_1 = global ptr null/, /call void @xyo_varslot_init\(ptr %0/]) assert(re.test(ir), 'missing generated IR pattern ' + re);
  const client = createLLVMWorkerClient('/pipeline-worker.mjs','/llc-browser.mjs','/lld-browser.mjs');
  pipeline = new LLVMPipeline(client);
  const result = await pipeline.compile({ir, exports:['xyo_browser_script','xyo_aot_slot_0','xyo_aot_slot_1'], sideModule:{imports}});
  assert(result.diagnostics.llc && result.diagnostics.linker, 'missing stage diagnostics');
  const module = await WebAssembly.compile(result.binary);
  const dylinks = WebAssembly.Module.customSections(module, 'dylink.0');
  assert(dylinks.length === 1 && [...new Uint8Array(dylinks[0])].join(',') === '1,4,12,2,0,0', 'unexpected dylink.0');
  assert(WebAssembly.Module.customSections(module,'dylink').length === 0, 'unexpected legacy dylink');
  const actualExports = WebAssembly.Module.exports(module);
  const expectedExports = [
    {name:'__wasm_call_ctors',kind:'function'}, {name:'__wasm_apply_data_relocs',kind:'function'},
    {name:'xyo_browser_script',kind:'function'}, {name:'xyo_aot_slot_0',kind:'global'}, {name:'xyo_aot_slot_1',kind:'global'},
  ];
  const keys = list => list.map(x => JSON.stringify(x)).sort().join('|');
  assert(keys(actualExports) === keys(expectedExports), 'unexpected export set');
  // This hand-built memory layout is only valid for the one checked fixture.
  const base=0x1000, ctx=0x2000, slots=0x2100, slot=0x2200, lit=0x3450, id=0x4560;
  assert(base % 4 === 0 && slot % 8 === 0 && base+12 <= ctx && ctx+72 <= slots && slots+4 <= slot && slot+48 <= 65536, 'layout bounds');
  const memory = new WebAssembly.Memory({initial:1});
  const view = new DataView(memory.buffer);
  const global = (value, mutable=false) => new WebAssembly.Global({value:'i32',mutable},value);
  const got0=global(0,true), got1=global(0,true); let calls=0;
  const instance = new WebAssembly.Instance(module,{env:{memory,__memory_base:global(base),__table_base:global(0),
    xyo_varslot_init(context,index,varId,name,flags) {
      calls++;
      assert(context===ctx && index===0n && varId===id && name===base && flags===0, 'helper ABI mismatch');
      assert(view.getUint16(name,true)===118 && view.getUint16(name+2,true)===0, 'variable name mismatch');
    }}, 'GOT.mem':{xyo_aot_slot_0:got0,xyo_aot_slot_1:got1}});
  const e=instance.exports;
  assert(e.xyo_aot_slot_0.value===4 && e.xyo_aot_slot_1.value===8, 'unexpected slot offsets');
  got0.value=base+e.xyo_aot_slot_0.value; got1.value=base+e.xyo_aot_slot_1.value;
  e.__wasm_apply_data_relocs(); e.__wasm_call_ctors();
  view.setUint32(got0.value,lit,true); view.setUint32(got1.value,id,true);
  view.setUint32(ctx+68,slots,true); view.setUint32(slots,slot,true); view.setBigUint64(slot+40,0n,true);
  e.xyo_browser_script(ctx);
  const bits=view.getBigUint64(slot+40,true);
  assert(calls===1 && bits===(9221401712017801216n|BigInt(lit)), 'synthetic slot bits mismatch');
  out.textContent = JSON.stringify({ok:true, irBytes:new TextEncoder().encode(ir).length, sideBytes:result.binary.length, imports:WebAssembly.Module.imports(module), exports:actualExports, diagnostics:result.diagnostics, helperCalls:calls, bits:'0x'+bits.toString(16), execution:'synthetic test-only host, not xyo runtime or GC'});
} catch(e) {
  out.textContent = JSON.stringify({ok:false, error:String(e), stage:e.stage, diagnostics:e.diagnostics});
} finally { worker?.terminate(); pipeline?.stop(); }
