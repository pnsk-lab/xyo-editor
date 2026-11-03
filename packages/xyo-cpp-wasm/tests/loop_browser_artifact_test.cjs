// Test actual build.sh CommonJS artifacts (not the synthetic test harness).
// Usage: node ... <isolated-package> <loop.sb3>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = path.resolve(process.argv[2]), sb3 = fs.readFileSync(process.argv[3]);
async function instance(js, wasm) {
 const create = require(js);
 return create({locateFile: name => name.endsWith('.wasm') ? wasm : name});
}
function setup(m) {
 const h = m._xyo_browser_create(); assert.ok(h);
 const p = m._malloc(sb3.length); m.HEAPU8.set(sb3, p);
 try { assert.equal(m._xyo_browser_load_sb3(h, p, sb3.length), 1); }
 finally { m._free(p); }
 assert.equal(m._xyo_browser_set_compiled(h, 1), 1);
 return h;
}
function run(m, h) { assert.equal(m._xyo_browser_green_flag(h), 1); assert.equal(m._xyo_browser_step(h), 1); }
(async () => {
 if (process.argv[4] === 'off-only') {
  const d = path.join(pkg, '.work/build-wasm');
  const m = await instance(path.join(d, 'xyo-browser.js'), path.join(d, 'xyo-browser.wasm'));
  assert.equal(typeof m._xyo_safe_jit_loop_experiment, 'undefined');
  const h = setup(m), before = m._xyo_browser_compiled_executions();
  run(m, h); assert.equal(m._xyo_browser_compiled_executions(), before);
  m._xyo_browser_destroy(h); console.log('off-after-on actual SB3: PASS'); return;
 }
 const off = await instance(path.join(pkg, 'default-browser.js'), path.join(pkg, 'default-browser.wasm'));
 assert.equal(typeof off._xyo_safe_jit_loop_experiment, 'undefined');
 const offHandle = setup(off), offRuns = off._xyo_browser_compiled_executions();
 run(off, offHandle); assert.equal(off._xyo_browser_compiled_executions(), offRuns);
 off._xyo_browser_destroy(offHandle);
 const dir = path.join(pkg, '.work/build-wasm');
 const on = await instance(path.join(dir, 'xyo-browser.js'), path.join(dir, 'xyo-browser.wasm'));
 assert.equal(typeof on._xyo_safe_jit_loop_experiment, 'function');
 const first = setup(on), before = on._xyo_browser_compiled_executions();
 run(on, first); assert.equal(on._xyo_browser_compiled_executions(), before); // compiled in, default off
 on._xyo_browser_destroy(first);
 on._xyo_safe_jit_loop_experiment(1);
 const a = setup(on), b = setup(on);
 run(on, a); run(on, b);
 assert.equal(on._xyo_browser_compiled_executions(), before + 2); // same module global, one per Runtime
 on._xyo_browser_destroy(a); on._xyo_browser_destroy(b);
 on._xyo_safe_jit_loop_experiment(0);
 console.log('build.sh artifacts: default/off/opt-in/global PASS');
 require('node:child_process').execFileSync(process.execPath,
  [path.resolve('packages/xyo-cpp-wasm/tests/loop_artifact_csp_test.cjs'), pkg, process.argv[3]], {stdio:'inherit'});
})().catch(e => { console.error(e); process.exitCode = 1; });
