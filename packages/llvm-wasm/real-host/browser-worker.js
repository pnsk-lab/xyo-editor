// Worker-only single-fixture experiment. Served by browser-test.mjs, not product code.
importScripts('/real_host.js','/compiler.js');
onmessage=async()=>{ try {
  const eq=(a,b,msg)=>{if(a!==b) throw Error(`${msg}: ${a} != ${b}`);};
  const get=async p=>{const r=await fetch(p);if(!r.ok)throw Error(p);return new Uint8Array(await r.arrayBuffer());};
  const [wasm,sb3,reference,compilerWasm,fixtureDigest]=await Promise.all(['/real_host.wasm','/fixture.sb3','/reference.wasm','/compiler.wasm','/fixture.sha256'].map(get));
  let compilerMemory;
  const compiler=await createXyoBrowserIr({instantiateWasm(imports,ready){const i=new WebAssembly.Instance(new WebAssembly.Module(compilerWasm),imports);compilerMemory=Object.values(i.exports).find(x=>x instanceof WebAssembly.Memory);ready(i);return i.exports;}});
  const cp=compiler._malloc(sb3.length);new Uint8Array(compilerMemory.buffer).set(sb3,cp);const result=compiler._xyo_browser_ir_compile(cp,sb3.length);compiler._free(cp);
  const readCompiler=p=>{const a=new Uint8Array(compilerMemory.buffer);let n=p;while(a[n])n++;return new TextDecoder().decode(a.subarray(p,n));};
  if(!compiler._xyo_browser_ir_ok(result))throw Error(readCompiler(compiler._xyo_browser_ir_error(result)));
  const irText=readCompiler(compiler._xyo_browser_ir_text(result)),meta=JSON.parse(readCompiler(compiler._xyo_browser_ir_metadata(result)));compiler._xyo_browser_ir_destroy(result);
  const {createLLVMWorkerClient,LLVMPipeline}=await import('/pipeline-index.mjs');
  const client=createLLVMWorkerClient('/pipeline-worker.mjs','/llc-browser.mjs','/lld-browser.mjs'),pipeline=new LLVMPipeline(client);
  const imports=[{module:'env',name:'memory',kind:'memory'},{module:'env',name:'__memory_base',kind:'global'},{module:'env',name:'__table_base',kind:'global'},{module:'env',name:'xyo_varslot_init',kind:'function'},{module:'GOT.mem',name:'xyo_aot_slot_0',kind:'global'},{module:'GOT.mem',name:'xyo_aot_slot_1',kind:'global'}];
  let compiled;try{compiled=await pipeline.compile({ir:irText,exports:['xyo_browser_script','xyo_aot_slot_0','xyo_aot_slot_1'],sideModule:{imports}});}finally{pipeline.stop();}
  const side=new Uint8Array(compiled.binary),ir=new TextEncoder().encode(irText);
  // Ignore only the non-semantic custom "name" section; output paths differ.
  function withoutName(b){let i=8,out=[...b.subarray(0,8)];function leb(){let v=0,s=0,c;do{c=b[i++];v|=(c&127)<<s;s+=7;}while(c&128);return v;}while(i<b.length){let start=i,id=b[i++],size=leb(),payload=i,end=i+size;if(end>b.length)throw Error('bad wasm');let keep=true;if(id===0){let n=leb();let name=new TextDecoder().decode(b.subarray(i,i+n));keep=name!=='name';}if(keep)out.push(...b.subarray(start,end));i=end;}return Uint8Array.from(out);}
  const hex=b=>[...b].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(hex(withoutName(side))!==hex(withoutName(reference)))throw Error('side differs from reviewed reference');
  const sha=async b=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)));
  eq(await sha(sb3),new TextDecoder().decode(fixtureDigest),'SB3 differs from node-validated fixture');
  eq(JSON.stringify(meta.slots),JSON.stringify([{kind:3,global:'xyo_aot_slot_0',keyHex:'34003200'},{kind:0,global:'xyo_aot_slot_1',keyHex:'76'}]),'metadata slots');
  eq(await sha(ir),'8e67d9f394e6382994dc6c244cc254baa559c49e1711346fdef32f6e5e764f75','IR hash');
  eq(await sha(reference),'baa20b3672d88e894d568bc2edc12fa566ac65310d29e9dfcdabc4227b228e09','reference hash');
  const m=await createXyoRealHost({wasmBinary:wasm});
  const alloc=b=>{let p=m._malloc(b.length||1);m.HEAPU8.set(b,p);return p;};
  const str=s=>alloc(new TextEncoder().encode(s+'\0'));
  const read=p=>{let n=p;while(m.HEAPU8[n])n++;return new TextDecoder().decode(m.HEAPU8.subarray(p,n));};
  eq(read(m._rh_abi_descriptor()),meta.abiDescriptor,'ABI');
  const data=alloc(sb3),h=m._rh_create(data,sb3.length);m._free(data);eq(read(m._rh_error(h)),'','load');
  m.FS.writeFile('/fixture-side.wasm',side);let p=str('/fixture-side.wasm');const handle=m._rh_dlopen_for(h,p);m._free(p);if(!handle)throw Error('dlopen');
  const sym=s=>{const q=str(s),v=m._rh_dlsym(handle,q);m._free(q);if(!v)throw Error('dlsym '+s);return v;};
  let id,lit;const entry=sym('xyo_browser_script');
  eq(m._rh_expect_slots(h,meta.slots.length),1,'expect slots');
  for(const s of meta.slots){if(s.kind!==0&&s.kind!==3)throw Error('slot kind');const key=Uint8Array.from(s.keyHex.match(/../g)||[],b=>parseInt(b,16));const addr=sym(s.global),q=alloc(key);eq(m._rh_bind_slot(h,addr,s.kind,q,key.length),1,'bind');m._free(q);if(s.kind===0)id=key;else lit={addr,key};}
  eq(m._rh_is_sealed(h),1,'sealed');
  if(!id||!lit||meta.slots.length!==2)throw Error('slot count');
  const id0=new Uint8Array(id.length+1);id0.set(id);p=alloc(id0);const v=m._rh_variable(h,p);if(!v)throw Error('variable');eq(m._rh_variable_bits(v),0n,'initial');
  m._rh_collect();const literal=m._rh_slot_value(lit.addr);if(!literal)throw Error('literal');m._rh_invoke(entry,h);eq(m._rh_var_slot(h,0),v,'slot');
  const expected=0x7ff9000000000000n|BigInt(literal);eq(m._rh_variable_bits(v),expected,'value');m._rh_collect();eq(m._rh_variable_bits(v),expected,'value after GC');
  eq(m._rh_variable_string_length(v),lit.key.length/2,'length');for(let i=0;i<lit.key.length/2;i++)eq(m._rh_variable_string_unit(v,i),lit.key[2*i]|lit.key[2*i+1]<<8,'unit');
  m._rh_destroy(h);eq(m._rh_dlclose(handle),0,'dlclose');m._free(p);
  postMessage({ok:true,variable:v,literal,value:'0x'+expected.toString(16),scope:'one exact fixture; real xyo runtime and GC'});
}catch(e){postMessage({ok:false,error:String(e),stack:e.stack});}};
