// Real xyo LLVM Wasm compiler, separate metadata artifact; no code execution.
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const factory=require(path.resolve(process.argv[2])), dir=process.argv[3];
(async()=>{
  let memory;
  const wasm=fs.readFileSync(path.join(path.dirname(path.resolve(process.argv[2])),'xyo_browser_ir.wasm'));
  const compiler=await factory({instantiateWasm(imports,ready){
    const instance=new WebAssembly.Instance(new WebAssembly.Module(wasm),imports);
    memory=Object.values(instance.exports).find(x=>x instanceof WebAssembly.Memory);
    ready(instance); return instance.exports;
  }});
  assert(memory);
  const read=p=>{const b=new Uint8Array(memory.buffer);let n=p;while(b[n])n++;return new TextDecoder().decode(b.subarray(p,n));};
  const compile=bytes=>{
    const ptr=compiler._malloc(bytes.length); assert(ptr);
    new Uint8Array(memory.buffer).set(bytes,ptr);
    const r=compiler._xyo_browser_ir_compile(ptr,bytes.length); compiler._free(ptr); assert(r);
    try { const ok=!!compiler._xyo_browser_ir_ok(r); const ir=read(compiler._xyo_browser_ir_text(r));
      const metadata=read(compiler._xyo_browser_ir_metadata(r));
      const error=read(compiler._xyo_browser_ir_error(r));
      return {ok,ir,metadata,error};
    } finally {compiler._xyo_browser_ir_destroy(r);}
  };
  const expected=[['simple','76','34003200',0],['binary','76e99baa','41000000e90034d81edd',1],['change','76','34003200',0]];
  { // Straight-line chain: set 10, change by 5, change by 7.
    const r=compile(fs.readFileSync(path.join(dir,'chain.sb3'))); assert.equal(r.ok,true,r.error);
    const m=JSON.parse(r.metadata);
    assert.equal(m.version,1); assert.equal(m.targetIndex,0);
    assert.deepEqual(m.slots,[
      {kind:3,global:'xyo_aot_slot_0',keyHex:'31003000'},
      {kind:0,global:'xyo_aot_slot_1',keyHex:'76'},
      {kind:3,global:'xyo_aot_slot_2',keyHex:'3500'},
      {kind:3,global:'xyo_aot_slot_3',keyHex:'3700'}]);
    for(const s of m.slots) assert(r.ir.includes('@'+s.global+' = global ptr null'));
    assert.match(m.abiDescriptor,/tag_str=7ff9000000000000/);
    assert.match(m.abiDescriptor,/helper_xyo_to_num=double\(i64\)/);
    let h=14695981039346656037n; for(const c of new TextEncoder().encode(m.abiDescriptor)) h=BigInt.asUintN(64,(h^BigInt(c))*1099511628211n);
    assert.equal(m.abiFingerprintFNV1a64,h.toString(16).padStart(16,'0'));
    console.log(JSON.stringify({fixture:'chain',slots:m.slots,abiFingerprint:m.abiFingerprintFNV1a64}));
  }
  { // Two variables: set v 10, set w 20.
    const r=compile(fs.readFileSync(path.join(dir,'twovars.sb3'))); assert.equal(r.ok,true,r.error);
    const m=JSON.parse(r.metadata);
    assert.equal(m.version,1); assert.equal(m.targetIndex,0);
    assert.deepEqual(m.slots,[
      {kind:3,global:'xyo_aot_slot_0',keyHex:'31003000'},
      {kind:0,global:'xyo_aot_slot_1',keyHex:'76'},
      {kind:3,global:'xyo_aot_slot_2',keyHex:'32003000'},
      {kind:0,global:'xyo_aot_slot_3',keyHex:'77'}]);
    for(const s of m.slots) assert(r.ir.includes('@'+s.global+' = global ptr null'));
    console.log(JSON.stringify({fixture:'twovars',slots:m.slots,abiFingerprint:m.abiFingerprintFNV1a64}));
  }
  for(const [name,varHex,strHex,targetIndex] of expected){
    const r=compile(fs.readFileSync(path.join(dir,name+'.sb3'))); assert.equal(r.ok,true,r.error);
    const m=JSON.parse(r.metadata);
    assert.equal(m.version,1); assert.equal(m.targetIndex,targetIndex);
    assert.equal(m.targetTriple,'wasm32-unknown-emscripten');
    assert.match(m.dataLayout, /p:32:32/);
    assert(r.ir.includes('target datalayout = "'+m.dataLayout+'"'));
    assert.deepEqual(m.slots,[{kind:3,global:'xyo_aot_slot_0',keyHex:strHex},{kind:0,global:'xyo_aot_slot_1',keyHex:varHex}]);
    for(const s of m.slots) assert(r.ir.includes('@'+s.global+' = global ptr null'));
    assert(m.abiDescriptor.includes('triple='+m.targetTriple));
    assert(m.abiDescriptor.includes('layout='+m.dataLayout));
    assert(m.abiDescriptor.includes('ptr_size=4')); assert(m.abiDescriptor.includes('ctx_var_slots=68'));
    assert(m.abiDescriptor.includes('variable_value=40'));
    assert.match(m.abiDescriptor, /tag_str=7ff9000000000000/);
    assert.match(m.abiDescriptor, /tag_nan=7ff8000000000000/);
    assert(m.abiDescriptor.includes('helper_xyo_varslot_init=void(ptr,i64,ptr,ptr,i32)'));
    let h=14695981039346656037n; for(const c of new TextEncoder().encode(m.abiDescriptor)) h=BigInt.asUintN(64,(h^BigInt(c))*1099511628211n);
    assert.equal(m.abiFingerprintFNV1a64,h.toString(16).padStart(16,'0'));
    console.log(JSON.stringify({fixture:name,slots:m.slots,abiFingerprint:m.abiFingerprintFNV1a64}));
  }
  const bad=compile(Buffer.from('not an sb3')); assert.equal(bad.ok,false); assert.equal(bad.ir,''); assert.equal(bad.metadata,''); assert(bad.error);
  { const r = compile(fs.readFileSync(path.join(dir,'chain9.sb3'))); assert.equal(r.ok,false); assert.equal(r.ir,''); assert.equal(r.metadata,'');
    assert.match(r.error,/script chain too long/); console.log('chain9: rejected: '+r.error); }
  for (const name of ['nul-id','nul-name','zip-bomb']) {
    const r=compile(fs.readFileSync(path.join(dir,name+'.sb3'))); assert.equal(r.ok,false,name); assert.equal(r.ir,''); assert.equal(r.metadata,'');
    console.log(`${name}: rejected: ${r.error}`);
  }
  console.log('PASS: real SB3 metadata, binary keys, lifetime, failure gate; no runtime execution');
})().catch(e=>{console.error(e);process.exitCode=1;});
