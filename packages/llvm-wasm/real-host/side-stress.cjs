// Lifecycle/GC stress for the single exact fixture: N sequential full
// lifecycles (create, bind, invoke, collect, destroy, dlclose) with per
// iteration value assertions. Exercises loader churn, slot ownership release,
// GC rooting across collects, and double-teardown safety. Not a general
// loader proof; product integration remains disabled.
const fs=require('node:fs'), assert=require('node:assert/strict');
const [hostJS,hostWasm,sb3Path,sidePath] = process.argv.slice(2);
const N = Number(process.env.STRESS_N || 50);
(async()=>{
  const m=await require(hostJS)({wasmBinary:fs.readFileSync(hostWasm)});
  const alloc=b=>{const p=m._malloc(b.length||1); m.HEAPU8.set(b,p); return p;};
  const cstr=s=>alloc(Buffer.from(s+'\0')); const readstr=p=>{let e=p;while(m.HEAPU8[e])e++;return Buffer.from(m.HEAPU8.subarray(p,e)).toString();};
  const bytes=fs.readFileSync(sb3Path), side=fs.readFileSync(sidePath);
  assert.equal(new DataView(side.buffer,side.byteOffset,4).getUint32(0,true),0x6d736100,'not a wasm module');
  m.FS.writeFile('/stress-side.wasm',side);
  const varId=Buffer.from([0x76]), litKey=Buffer.from([0x34,0x00,0x32,0x00]);
  let invokes=0;
  for(let i=0;i<N;i++) {
    const bp=alloc(bytes), h=m._rh_create(bp,bytes.length); m._free(bp);
    assert.equal(readstr(m._rh_error(h)),'',`iter ${i} load`);
    assert.ok(m._rh_context(h),`iter ${i} context`);
    assert.equal(m._rh_expect_slots(h,2),1,`iter ${i} expect`);
    const p=cstr('/stress-side.wasm'), handle=m._rh_dlopen_for(h,p); m._free(p); assert.ok(handle,`iter ${i} dlopen`);
    const sym=s=>{const q=cstr(s);const r=m._rh_dlsym(handle,q);m._free(q);assert.ok(r,`iter ${i} dlsym ${s}`);return r;};
    const entry=sym('xyo_browser_script');
    const addr0=sym('xyo_aot_slot_0'), addr1=sym('xyo_aot_slot_1');
    const q0=alloc(litKey), q1=alloc(varId);
    assert.equal(m._rh_bind_slot(h,addr0,3,q0,litKey.length),1,`iter ${i} bind lit`);
    assert.equal(m._rh_bind_slot(h,addr1,0,q1,varId.length),1,`iter ${i} bind varid`);
    m._free(q0); m._free(q1);
    assert.equal(m._rh_is_sealed(h),1,`iter ${i} sealed`);
    const id=alloc(Buffer.concat([varId,Buffer.from([0])])), v=m._rh_variable(h,id);
    assert.ok(v,`iter ${i} variable`); assert.equal(m._rh_variable_bits(v),0n,`iter ${i} initial`);
    m._rh_invoke(entry,h); invokes++;
    assert.equal(m._rh_var_slot(h,0),v,`iter ${i} slot`);
    const bits=m._rh_variable_bits(v);
    assert.equal(bits>>48n,0x7ff9n,`iter ${i} tag`);
    assert.notEqual(bits&0xffffffffn,0n,`iter ${i} pointer`);
    assert.equal(m._rh_variable_string_length(v),2,`iter ${i} length`);
    assert.equal(m._rh_variable_string_unit(v,0),0x34,`iter ${i} unit0`);
    assert.equal(m._rh_variable_string_unit(v,1),0x32,`iter ${i} unit1`);
    m._rh_collect(); m._rh_collect();
    assert.equal(m._rh_variable_bits(v),bits,`iter ${i} stable across GC`);
    assert.equal(m._rh_variable_string_length(v),2,`iter ${i} length after GC`);
    m._free(id);
    m._rh_destroy(h);
    assert.equal(m._rh_dlclose(handle),0,`iter ${i} dlclose`);
  }
  console.log(JSON.stringify({ok:true,iterations:N,invokes,scope:'single fixture sequential lifecycle stress'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
