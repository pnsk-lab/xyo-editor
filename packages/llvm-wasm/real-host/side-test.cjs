// Node-only integration gate for the single exact IR fixture. Takes metadata
// emitted by the compiler, never invented slot contents. Not a general loader.
const fs=require('node:fs'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const path=require('node:path'), {execFileSync}=require('node:child_process');
const [hostJS,hostWasm,sb3,compilerJS,compilerWasm,llc,lld,expectMode,expectProject,expectIr,expectSide,shaOut]=process.argv.slice(2);
// expectMode: "string" (NaN-boxed SStr result, string asserts),
// "number:<hexbits>" (plain double result, e.g. changevariableby),
// "chain:<hexbits>" (multi-block straight-line chain; same numeric asserts,
// dead StrLit slots may drop out of the linked imports), or
// "multivar:<json>" mapping VarId keyHex to an expected value spec: either a
// double bit pattern as a hex string, or {"str":[u16,...]} for a NaN-boxed
// string (pointers vary per run, so only tag/length/units are asserted).
// e.g. 'multivar:{"76":{"str":[49,48]},"77":{"str":[50,48]}}'.
const isChain = !!expectMode && expectMode.startsWith('chain:');
const isMultivar = !!expectMode && expectMode.startsWith('multivar:');
const expectedNumber = (expectMode && (expectMode.startsWith('number:') || isChain)) ? BigInt(expectMode.slice(expectMode.indexOf(':') + 1)) : null;
const expectedVars = isMultivar ? Object.fromEntries(Object.entries(JSON.parse(expectMode.slice('multivar:'.length))).map(([k, v]) => [k, typeof v === 'string' ? BigInt(v) : v])) : null;
if (expectMode && expectedNumber === null && !expectedVars && expectMode !== 'string') throw new Error('bad expect mode: ' + expectMode);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function symbols(a) { return a.map(x=>`${x.module||''}:${x.name}:${x.kind}`).sort(); }
(async()=>{
  const bytes=fs.readFileSync(sb3);
  const projectHash=b=>execFileSync('python3',['-c',"import io,zipfile,hashlib,sys; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.namelist()==['project.json']; print(hashlib.sha256(z.read('project.json')).hexdigest())"],{input:b,encoding:'utf8'}).trim();
  const expectedProject=expectProject || '474887048515a6670d9048e9b6ef5552f3e4c086bb89a1dbe19129af4e434836';
  assert.equal(projectHash(bytes),expectedProject,'project JSON mismatch');
  fs.writeFileSync(shaOut || path.join(path.dirname(hostJS),'fixture.sha256'),hash(bytes));
  const mutate=(before,after)=>execFileSync('python3',['-c',"import io,zipfile,sys; a,b=sys.argv[1:]; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); data=z.read('project.json'); assert a.encode() in data; data=data.replace(a.encode(),b.encode(),1); o=io.BytesIO(); w=zipfile.ZipFile(o,'w'); w.writestr('project.json',data); w.close(); sys.stdout.buffer.write(o.getvalue())",before,after],{input:bytes});
  const firstLiteral = (isChain || isMultivar) ? '"10"' : '"42"';
  const changedLiteral=mutate(firstLiteral,'"41"'), changedId=mutate('"variables":{"v"','"variables":{"w"');
  const literalHash=projectHash(changedLiteral), idHash=projectHash(changedId);
  assert.throws(()=>assert.equal(literalHash,expectedProject),'modified literal must fail');
  assert.throws(()=>assert.equal(idHash,expectedProject),'modified variable ID must fail');
  let compilerMemory;
  const compiler=await require(compilerJS)({instantiateWasm(imports, ready) {
    const i=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(compilerWasm)),imports);
    compilerMemory=Object.values(i.exports).find(x=>x instanceof WebAssembly.Memory); ready(i); return i.exports;
  }});
  assert.ok(compilerMemory);
  const readCompiler=p=>{const b=new Uint8Array(compilerMemory.buffer);let e=p;while(b[e])e++;return new TextDecoder().decode(b.subarray(p,e));};
  const input=compiler._malloc(bytes.length);new Uint8Array(compilerMemory.buffer).set(bytes,input);
  const result=compiler._xyo_browser_ir_compile(input,bytes.length);compiler._free(input);assert.ok(result);
  assert.ok(compiler._xyo_browser_ir_ok(result),readCompiler(compiler._xyo_browser_ir_error(result)));
  const ir=Buffer.from(readCompiler(compiler._xyo_browser_ir_text(result)));
  const meta=JSON.parse(readCompiler(compiler._xyo_browser_ir_metadata(result)));
  compiler._xyo_browser_ir_destroy(result);
  assert.equal(hash(ir),expectIr || '8e67d9f394e6382994dc6c244cc254baa559c49e1711346fdef32f6e5e764f75','IR not the one validated fixture');
  const out=path.dirname(hostJS), irFile=path.join(out,'fixture.ll'), objFile=path.join(out,'parent.o'), wasmFile=path.join(out,'parent.wasm');
  fs.writeFileSync(irFile,ir);
  execFileSync(process.execPath,[llc,'-mtriple=wasm32-unknown-emscripten','-relocation-model=pic','-filetype=obj',irFile,'-o',objFile],{stdio:'inherit'});
  execFileSync(process.execPath,[lld,'-flavor','wasm','--shared','--allow-undefined','--export=xyo_browser_script',objFile,'-o',wasmFile],{stdio:'inherit'});
  const side=fs.readFileSync(wasmFile);
  assert.equal(hash(side),expectSide || 'baa20b3672d88e894d568bc2edc12fa566ac65310d29e9dfcdabc4227b228e09','side module not the reviewed fixture');
  assert.equal(meta.version,1); assert.equal(meta.targetIndex,0); assert.equal(meta.targetTriple,'wasm32-unknown-emscripten');
  assert.match(meta.dataLayout,/p:32:32/);
  const expectedSlots = isMultivar ? [
    {kind:3,global:'xyo_aot_slot_0',keyHex:'31003000'},
    {kind:0,global:'xyo_aot_slot_1',keyHex:'76'},
    {kind:3,global:'xyo_aot_slot_2',keyHex:'32003000'},
    {kind:0,global:'xyo_aot_slot_3',keyHex:'77'}]
  : isChain ? [
    {kind:3,global:'xyo_aot_slot_0',keyHex:'31003000'},
    {kind:0,global:'xyo_aot_slot_1',keyHex:'76'},
    {kind:3,global:'xyo_aot_slot_2',keyHex:'3500'},
    {kind:3,global:'xyo_aot_slot_3',keyHex:'3700'}] : [
    {kind:3,global:'xyo_aot_slot_0',keyHex:'34003200'},{kind:0,global:'xyo_aot_slot_1',keyHex:'76'}];
  assert.equal(meta.slots.length,expectedSlots.length);
  const checkSlots=slots=>assert.deepEqual(slots,expectedSlots,'slot metadata differs from fixed fixture');
  checkSlots(meta.slots);
  const badLiteral=structuredClone(meta.slots); badLiteral[0].keyHex='3100'; assert.throws(()=>checkSlots(badLiteral));
  const badId=structuredClone(meta.slots); badId[1].keyHex='77'; assert.throws(()=>checkSlots(badId));
  for(const s of meta.slots) assert.match(s.keyHex,/^(?:[0-9a-f]{2})*$/);
  const mod=new WebAssembly.Module(side);
  // The change fixture's StrLit slot is dead after llc -O2 DCE (the constant is
  // folded to a double), so the linked module imports only the VarId slot.
  // The linked imports are pinned per shape: set/change-only fixtures DCE their
  // StrLit loads, while the chain keeps the set literal live.
  // The two-variable fixture keeps every slot live (both sets store their
  // tagged literal directly), so no helper beyond varslot_init is needed.
  const expectedImports=symbols(expectedNumber === null && !isMultivar ? [
    {module:'env',name:'memory',kind:'memory'}, {module:'env',name:'__memory_base',kind:'global'},
    {module:'env',name:'__table_base',kind:'global'}, {module:'env',name:'xyo_varslot_init',kind:'function'},
    {module:'GOT.mem',name:'xyo_aot_slot_0',kind:'global'}, {module:'GOT.mem',name:'xyo_aot_slot_1',kind:'global'}]
  : isMultivar ? [
    {module:'env',name:'memory',kind:'memory'}, {module:'env',name:'__memory_base',kind:'global'},
    {module:'env',name:'__table_base',kind:'global'}, {module:'env',name:'xyo_varslot_init',kind:'function'},
    {module:'GOT.mem',name:'xyo_aot_slot_0',kind:'global'}, {module:'GOT.mem',name:'xyo_aot_slot_1',kind:'global'},
    {module:'GOT.mem',name:'xyo_aot_slot_2',kind:'global'}, {module:'GOT.mem',name:'xyo_aot_slot_3',kind:'global'}]
  : isChain ? [
    {module:'env',name:'memory',kind:'memory'}, {module:'env',name:'__memory_base',kind:'global'},
    {module:'env',name:'__table_base',kind:'global'}, {module:'env',name:'xyo_varslot_init',kind:'function'},
    {module:'env',name:'xyo_to_num',kind:'function'},
    {module:'GOT.mem',name:'xyo_aot_slot_0',kind:'global'}, {module:'GOT.mem',name:'xyo_aot_slot_1',kind:'global'}] : [
    {module:'env',name:'memory',kind:'memory'}, {module:'env',name:'__memory_base',kind:'global'},
    {module:'env',name:'__table_base',kind:'global'}, {module:'env',name:'xyo_varslot_init',kind:'function'},
    {module:'env',name:'xyo_to_num',kind:'function'},
    {module:'GOT.mem',name:'xyo_aot_slot_1',kind:'global'}]);
  const checkImports=b=>assert.deepEqual(symbols(WebAssembly.Module.imports(new WebAssembly.Module(b))),expectedImports);
  checkImports(side);
  const unknown=Buffer.from(side), pos=unknown.indexOf('xyo_varslot_init'); assert.ok(pos>=0);
  unknown[pos]=0x79; assert.throws(()=>checkImports(unknown),'unknown helper must fail preflight');
  assert.throws(()=>assert.equal(hash(unknown),expectSide || 'baa20b3672d88e894d568bc2edc12fa566ac65310d29e9dfcdabc4227b228e09'),'modified side must fail hash');
  assert.deepEqual(symbols(WebAssembly.Module.exports(mod)),symbols([
    {name:'__wasm_call_ctors',kind:'function'}, {name:'__wasm_apply_data_relocs',kind:'function'},
    {name:'xyo_browser_script',kind:'function'}, {name:'xyo_aot_slot_0',kind:'global'}, {name:'xyo_aot_slot_1',kind:'global'},
    ...((isChain || isMultivar) ? [{name:'xyo_aot_slot_2',kind:'global'}, {name:'xyo_aot_slot_3',kind:'global'}] : [])]));
  const sections=WebAssembly.Module.customSections(mod,'dylink.0');
  // Static data grows with slot count: 12 bytes for the 2-slot fixtures, 20
  // for the 4-slot chain (4 slot words stay; only the set literal's rodata
  // survives DCE, the change deltas fold to f64 constants), 24 for the
  // two-variable fixture (both set rodata survive).
  assert.equal(sections.length,1);
  assert.deepEqual([...new Uint8Array(sections[0])],[1,4,isMultivar?24:isChain?20:12,2,0,0]);
  const m=await require(hostJS)({wasmBinary:fs.readFileSync(hostWasm)});
  const alloc=b=>{const p=m._malloc(b.length||1); m.HEAPU8.set(b,p); return p;};
  const cstr=s=>alloc(Buffer.from(s+'\0')); const readstr=p=>{let e=p;while(m.HEAPU8[e])e++;return Buffer.from(m.HEAPU8.subarray(p,e)).toString();};
  assert.deepEqual([0,1,2,3,4,5,6,7,8].map(n=>m._rh_layout(n)),[4,80,68,40,8,32,0,4,8]);
  const hostAbi=readstr(m._rh_abi_descriptor());
  assert.throws(()=>assert.equal(hostAbi,meta.abiDescriptor+';mismatch'),'ABI mismatch must fail preflight');
  assert.equal(hostAbi,meta.abiDescriptor,'compiler/runtime ABI descriptor mismatch');
  assert.match(meta.abiDescriptor,/tag_str=7ff9000000000000/,'Value tags missing from descriptor');
  assert.match(meta.abiDescriptor,/helper_xyo_varslot_init=void\(ptr,i64,ptr,ptr,i32\)/,'helper signature missing from descriptor');
  assert.match(meta.abiDescriptor,/helper_xyo_to_num=double\(i64\)/,'to_num helper missing from descriptor');
  const bp=alloc(bytes), h=m._rh_create(bp,bytes.length); m._free(bp);
  assert.equal(readstr(m._rh_error(h)),''); assert.ok(m._rh_context(h));
  m.FS.writeFile('/fixture-side.wasm',side);
  const pathPtr=cstr('/fixture-side.wasm'), handle=m._rh_dlopen_for(h,pathPtr); m._free(pathPtr); assert.ok(handle,'dlopen failed');
  const sym=s=>{const p=cstr(s);const r=m._rh_dlsym(handle,p);m._free(p);return r;};
  const entry=sym('xyo_browser_script'); assert.ok(entry);
  let varid,lit;
  assert.equal(m._rh_expect_slots(h,meta.slots.length),1);
  assert.equal(m._rh_is_sealed(h),0);
  for(const slot of meta.slots) {
    const addr=sym(slot.global), key=Buffer.from(slot.keyHex,'hex'), p=alloc(key); assert.ok(addr);
    assert.equal(m._rh_bind_slot(h,addr,slot.kind,p,key.length),1); m._free(p);
    if(slot.kind===0) varid=key; else lit={addr,key};
  }
  assert.equal(m._rh_is_sealed(h),1);
  let v = 0, literal = 0, id = 0;
  if (isMultivar) {
    // Every VarId slot resolves, starts at 0, and ends at its expected value.
    // Var slot indices follow first-initialization order in the IR.
    const lookups=meta.slots.filter(s=>s.kind===0).map(s=>{
      const key=Buffer.from(s.keyHex,'hex'), id=alloc(Buffer.concat([key,Buffer.from([0])]));
      const v=m._rh_variable(h,id); assert.ok(v,`variable ${s.keyHex}`);
      assert.equal(m._rh_variable_bits(v),0n,`initial ${s.keyHex}`);
      return {id,v,hex:s.keyHex};
    });
    m._rh_collect();
    m._rh_invoke(entry,h);
    const checkVar=(L,k)=>{
      assert.equal(m._rh_var_slot(h,k),L.v,`var slot ${k}->${L.hex}`);
      const want=expectedVars[L.hex]; assert.notEqual(want,undefined,`no expectation for ${L.hex}`);
      if (typeof want === 'bigint') {
        assert.equal(m._rh_variable_bits(L.v),want,`value ${L.hex}`);
        assert.equal(m._rh_variable_string_length(L.v),-1,`numeric ${L.hex} is not a string`);
      } else {
        assert.equal(m._rh_variable_bits(L.v)>>48n,0x7ff9n,`tag ${L.hex}`);
        assert.equal(m._rh_variable_string_length(L.v),want.str.length,`length ${L.hex}`);
        want.str.forEach((u,i)=>assert.equal(m._rh_variable_string_unit(L.v,i),u,`unit ${L.hex}[${i}]`));
      }
    };
    for (const [k,L] of lookups.entries()) checkVar(L,k);
    m._rh_collect();
    for (const L of lookups) {
      const want=expectedVars[L.hex];
      if (typeof want === 'bigint') assert.equal(m._rh_variable_bits(L.v),want,`stable ${L.hex}`);
      else want.str.forEach((u,i)=>assert.equal(m._rh_variable_string_unit(L.v,i),u,`stable ${L.hex}[${i}]`));
    }
    m._rh_destroy(h); assert.equal(m._rh_dlclose(handle),0);
    for (const L of lookups) m._free(L.id);
    varid=Buffer.from(meta.slots.find(s=>s.kind===0).keyHex,'hex'); lit=null;
    v=lookups[0].v;
  } else {
  const id=alloc(Buffer.concat([varid,Buffer.from([0])])); v=m._rh_variable(h,id); assert.ok(v); assert.equal(m._rh_variable_bits(v),0n);
  m._rh_collect(); literal=m._rh_slot_value(lit.addr); assert.ok(literal);
  m._rh_invoke(entry,h); assert.equal(m._rh_var_slot(h,0),v);
  if (expectedNumber === null) {
    assert.equal(m._rh_variable_bits(v),0x7ff9000000000000n|BigInt(literal));
    assert.equal(m._rh_variable_string_length(v),lit.key.length/2);
    for(let i=0;i<lit.key.length/2;i++) assert.equal(m._rh_variable_string_unit(v,i),lit.key.readUInt16LE(i*2));
    m._rh_collect(); assert.equal(m._rh_variable_bits(v),0x7ff9000000000000n|BigInt(literal));
    for(let i=0;i<lit.key.length/2;i++) assert.equal(m._rh_variable_string_unit(v,i),lit.key.readUInt16LE(i*2));
  } else {
    assert.equal(m._rh_variable_bits(v),expectedNumber);
    assert.equal(m._rh_variable_string_length(v),-1,'numeric result is not a string');
    m._rh_collect(); assert.equal(m._rh_variable_bits(v),expectedNumber);
  }
  m._rh_destroy(h); assert.equal(m._rh_dlclose(handle),0); m._free(id);
  }
  // Ownership: invoke requires a sealed binding; live slots are host-exclusive.
  const bp2=alloc(bytes), h2=m._rh_create(bp2,bytes.length); m._free(bp2);
  assert.equal(readstr(m._rh_error(h2)),'');
  m.FS.writeFile('/fixture-side2.wasm',side);
  const p2=cstr('/fixture-side2.wasm'), handle2=m._rh_dlopen_for(h2,p2); m._free(p2); assert.ok(handle2);
  const sym2=s=>{const p=cstr(s);const r=m._rh_dlsym(handle2,p);m._free(p);return r;};
  const entry2=sym2('xyo_browser_script'); assert.ok(entry2);
  assert.equal(m._rh_is_sealed(h2),0);
  m._rh_invoke(entry2,h2);
  const idProbe=alloc(Buffer.concat([varid,Buffer.from([0])])), vProbe=m._rh_variable(h2,idProbe);
  assert.equal(m._rh_variable_bits(vProbe),0n,'unsealed invoke must not execute');
  assert.equal(m._rh_expect_slots(h2,meta.slots.length),1);
  assert.equal(m._rh_expect_slots(h2,meta.slots.length),0,'expect set twice');
  assert.equal(m._rh_expect_slots(h2,0),0,'expect zero');
  const addr0=sym2(meta.slots[0].global), key0=Buffer.from(meta.slots[0].keyHex,'hex');
  const q0=alloc(key0);
  assert.equal(m._rh_bind_slot(h2,addr0,meta.slots[0].kind,q0,key0.length),1);
  const bp3=alloc(bytes), h3=m._rh_create(bp3,bytes.length); m._free(bp3);
  const q0c=alloc(key0);
  assert.equal(m._rh_bind_slot(h3,addr0,meta.slots[0].kind,q0c,key0.length),0,'slot owned by live host');
  m._free(q0c);
  assert.equal(m._rh_is_sealed(h2),0,'partial binding is not sealed');
  m._rh_destroy(h2);
  const q0d=alloc(key0);
  assert.equal(m._rh_bind_slot(h3,addr0,meta.slots[0].kind,q0d,key0.length),1,'rebind after release');
  m._free(q0d); m._free(q0);
  m._rh_destroy(h3);
  assert.equal(m._rh_dlclose(handle2),0);
  // Unload ordering: closing while the owning host is alive is refused;
  // after the host is destroyed the close succeeds exactly once.
  const bp4=alloc(bytes), h4=m._rh_create(bp4,bytes.length); m._free(bp4);
  assert.equal(readstr(m._rh_error(h4)),'');
  m.FS.writeFile('/fixture-side4.wasm',side);
  const p4=cstr('/fixture-side4.wasm'), handle4=m._rh_dlopen_for(h4,p4); m._free(p4); assert.ok(handle4);
  assert.equal(m._rh_dlclose(handle4),-1,'unload while host alive');
  m._rh_destroy(h4);
  assert.equal(m._rh_dlclose(handle4),0);
  // Handle values are recycled by the loader, so a second close cannot be
  // distinguished from closing a recycled value: Emscripten reports success
  // without aborting. The enforced property is unload-while-alive refusal
  // above, not the double-close code.
  assert.equal(typeof m._rh_dlclose(handle4),'number','double close must not trap');
  m._free(idProbe);
  console.log(JSON.stringify({ok:true,irSha256:hash(ir),sideSha256:hash(side),metadata:meta,variable:v,literal,scope:'single fixture only'}));
})().catch(e=>{console.error(e);process.exitCode=1});
