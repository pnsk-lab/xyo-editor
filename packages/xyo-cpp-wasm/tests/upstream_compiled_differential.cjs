// Run after scripts/build.sh, from any directory:
// node packages/xyo-cpp-wasm/tests/upstream_compiled_differential.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const build = path.join(root, '.work/build-wasm');
const upstream = path.join(root, '.work/xyo-cpp/tests');
const create = require(path.join(build, 'xyo-browser.js'));

// These fixtures have no random, timer, input or wall-clock-dependent blocks.
// They cover strings/motion, lists/NaN indices, and repeat/variables/strings.
// Report actual compiler counters independently of the state comparison.
// Do not equate a compilation attempt or module creation with execution.
const fixtures = [
  'fixtures/basic.sb3',
  'differential/repro/nan_index_insert.sb3',
  'differential/repro/var_id_name_mismatch.sb3',
];
(async () => {
  const m = await create({ wasmBinary: fs.readFileSync(path.join(build, 'xyo-browser.wasm')) });
  const stats = () => ({ attempts: m._xyo_browser_compile_attempts(), successes: m._xyo_browser_compile_successes(), executions: m._xyo_browser_compiled_executions(), fallbacks: m._xyo_browser_compile_fallbacks() });
  const snap = h => JSON.parse(m.UTF8ToString(m._xyo_browser_snapshot(h)));
  const observable = h => snap(h).targets.map(t => ({ name: t.name, isStage: t.isStage, variables: t.variables, lists: t.lists, x: t.x, y: t.y, direction: t.direction, bubbleText: t.bubbleText, bubbleType: t.bubbleType }));
  const load = (h, bytes) => { const p = m._malloc(bytes.length); m.HEAPU8.set(bytes, p); try { assert.equal(m._xyo_browser_load_sb3(h, p, bytes.length), 1, m.UTF8ToString(m._xyo_browser_error(h))); } finally { m._free(p); } };
  for (const fixture of fixtures) {
    const bytes = fs.readFileSync(path.join(upstream, fixture));
    const a = m._xyo_browser_create(), b = m._xyo_browser_create();
    assert.ok(a && b);
    try {
      load(a, bytes); load(b, bytes);
      assert.equal(m._xyo_browser_set_compiled(b, 1), 1);
      assert.equal(m._xyo_browser_compiled_enabled(a), 0);
      assert.equal(m._xyo_browser_compiled_enabled(b), 1);
      const before = stats();
      for (let flag = 0; flag < 2; flag++) {
        const beforeInterpreterFlag = stats();
        assert.equal(m._xyo_browser_green_flag(a), 1);
        assert.deepEqual(stats(), beforeInterpreterFlag, 'interpreter must not compile');
        assert.equal(m._xyo_browser_green_flag(b), 1);
        for (let frame = 0; frame < 20; frame++) {
          assert.equal(m._xyo_browser_step(a), 1);
          assert.equal(m._xyo_browser_step(b), 1);
          assert.deepEqual(observable(b), observable(a), `${fixture}: flag ${flag + 1}, frame ${frame + 1}`);
        }
        assert.equal(snap(a).threadCount, 0, `${fixture}: incomplete interpreter scripts`);
        assert.equal(snap(b).threadCount, 0, `${fixture}: incomplete compiled-mode scripts`);
        const state = observable(a);
        if (fixture.endsWith('/basic.sb3')) {
          assert.equal(state.find(t => t.name === 'Sprite1').x, 10 * (flag + 1));
          assert.equal(state[0].variables.hv.value, 'none');
        } else if (fixture.endsWith('/nan_index_insert.sb3')) {
          assert.deepEqual(state[0].variables.vout.value, Array(flag + 1).fill('a'));
          assert.deepEqual(state[1].variables.vL.value, ['a', 'b', 'c']);
        } else {
          const out = state[0].variables.vout.value;
          assert.equal(out.length, 8 * (flag + 1));
          assert.deepEqual(out.slice(0, 4), ['S=1', 'L=20', 'S=1', 'L=1']);
          assert.equal(state[1].variables.vl.value, '1');
        }
      }
      const after = stats();
      const delta = Object.fromEntries(Object.keys(before).map(k => [k, after[k] - before[k]]));
      console.log(fixture, delta, delta.successes === 0 && delta.executions === 0 ? '(no compiled success or execution)' : '');
      assert.ok(after.attempts > before.attempts, `${fixture}: no compilation attempt`);
      if (fixture === 'fixtures/basic.sb3') {
        assert.equal(delta.successes, 2, 'both green flags compile');
        assert.equal(delta.executions, 1, 'fresh basic.sb3 executes WASM once');
        assert.equal(delta.fallbacks, 1, 'the second flag falls back due to the interpreter cache');
      }
    } finally { m._xyo_browser_destroy(a); m._xyo_browser_destroy(b); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
