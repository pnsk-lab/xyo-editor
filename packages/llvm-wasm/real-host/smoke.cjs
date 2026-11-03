// Real Runtime/helper/GC test only; this does not load or execute a side module.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [js, wasm, fixturesDir] = process.argv.slice(2);
const P = f => require('node:path').join(fixturesDir, f);
const valid = P('valid.sb3'), wait = P('wait.sb3'), two = P('two-hats.sb3');
const nulId = P('nul-id.sb3'), nulName = P('nul-name.sb3'), bomb = P('zip-bomb.sb3');
(async () => {
  const create = require(js);
  const m = await create({wasmBinary: fs.readFileSync(wasm)});
  function alloc(bytes) { const p=m._malloc(bytes.length || 1); m.HEAPU8.set(bytes,p); return p; }
  function load(path) { const a=fs.readFileSync(path), p=alloc(a); const h=m._rh_create(p,a.length); m._free(p); return h; }
  const missing=alloc(Buffer.from('/missing.wasm\0')); assert.equal(m._rh_dlopen(missing),0); m._free(missing);
  const h=load(valid); assert.equal(m.HEAPU8[m._rh_error(h)], 0);
  assert.deepEqual([0,2,3,4].map(n=>m._rh_layout(n)),[4,68,40,8]);
  const id=alloc(Buffer.from('v\0')), name=alloc(Uint8Array.from([118,0,0,0]));
  const v=m._rh_variable(h,id), ctx=m._rh_context(h); assert.ok(v && ctx && m._rh_target(h));
  assert.equal(m._rh_variable_bits(v), 0n);
  m._xyo_varslot_init(ctx,0n,id,name,0); assert.equal(m._rh_var_slot(h,0),v);
  const slot=m._malloc(4); new DataView(m.HEAPU8.buffer).setUint32(slot,0,true);
  const text=alloc(Uint8Array.from([52,0,50,0]));
  assert.equal(m._rh_bind_slot(h,slot,6,text,4),0);
  assert.equal(m._rh_bind_slot(h,slot,3,text,3),0);
  assert.equal(m._rh_bind_slot(h,slot,3,text,4),1); const lit=m._rh_slot_value(slot); assert.ok(lit);
  m._rh_collect(); assert.equal(m._rh_slot_value(slot),lit);
  const d=new DataView(m.HEAPU8.buffer); assert.equal(d.getUint32(lit,true),2);
  assert.equal(d.getUint16(lit+m._rh_layout(5),true),52);
  m._rh_destroy(h); assert.equal(new DataView(m.HEAPU8.buffer).getUint32(slot,true),0);
  for (const path of [wait,two]) { const bad=load(path); assert.equal(m._rh_context(bad),0); m._rh_destroy(bad); }
  { const ch=load(P('change.sb3')); assert.ok(m._rh_context(ch),'change body must load'); m._rh_destroy(ch); }
  { const ch=load(P('chain.sb3')); assert.ok(m._rh_context(ch),'3-block chain must load'); m._rh_destroy(ch); }
  { const tv=load(P('twovars.sb3')); assert.ok(m._rh_context(tv),'two-variable script must load'); m._rh_destroy(tv); }
  const readErr = h => { const p = m._rh_error(h); let e = p; while (m.HEAPU8[e]) e++; return Buffer.from(m.HEAPU8.subarray(p, e)).toString(); };
  { const overlong=load(P('chain9.sb3')); assert.equal(m._rh_context(overlong),0); assert.match(readErr(overlong),/script chain too long/); m._rh_destroy(overlong); }
  for (const [path, needle] of [[nulId, 'VARIABLE id'], [nulName, 'VARIABLE name'], [bomb, 'zip preflight']]) {
    const bad = load(path);
    assert.equal(m._rh_context(bad), 0, path);
    assert.match(readErr(bad), new RegExp(needle), path);
    m._rh_destroy(bad);
  }
  [id,name,slot,text].forEach(p=>m._free(p));
  console.log(JSON.stringify({ok:true, layout:[0,1,2,3,4,5,6,7,8].map(n=>m._rh_layout(n)), variable:v, literal:lit, scope:'real helper and rooted literal only; no side-module execution'}));
})().catch(e=>{console.error(e);process.exitCode=1});
