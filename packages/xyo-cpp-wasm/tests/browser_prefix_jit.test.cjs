// Product integration test (no rebuild):
// node --test packages/xyo-cpp-wasm/tests/browser_prefix_jit.test.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const build = path.resolve(__dirname, '../.work/build-wasm');
const create = require(path.join(build, 'xyo-browser.js'));

// A genuine stored ZIP with project.json, without a dependency on a ZIP tool.
function sb3(project) {
  const name = Buffer.from('project.json'), data = Buffer.from(JSON.stringify(project));
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
const project = {
  targets: [
    { isStage: true, name: 'Stage', variables: { v: ['v', 7] }, lists: {}, broadcasts: {}, blocks: {}, costumes: [], sounds: [], currentCostume: 0 },
    { isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, costumes: [], sounds: [], currentCostume: 0, x: 0, y: 0, direction: 90, size: 100, visible: true,
      blocks: {
        hat: { opcode: 'event_whenflagclicked', topLevel: true, next: 'change', inputs: {}, fields: {} },
        change: { opcode: 'data_changevariableby', next: 'say', inputs: { VALUE: [1, [4, '3']] }, fields: { VARIABLE: ['v', 'v'] } },
        say: { opcode: 'looks_say', next: 'wait', inputs: { MESSAGE: [1, [10, 'hello']] }, fields: {} },
        wait: { opcode: 'control_wait', next: 'move', inputs: { DURATION: [1, [4, '0']] }, fields: {} },
        move: { opcode: 'motion_movesteps', next: null, inputs: { STEPS: [1, [4, '10']] }, fields: {} },
      } },
  ], monitors: [], extensions: [], meta: {},
};

test('product prefix JIT executes mixed SB3 identically to interpreter', async () => {
  const m = await create({ wasmBinary: fs.readFileSync(path.join(build, 'xyo-browser.wasm')) });
  const stats = () => ({ attempts: m._xyo_browser_compile_attempts(), successes: m._xyo_browser_compile_successes(), executions: m._xyo_browser_compiled_executions(), fallbacks: m._xyo_browser_compile_fallbacks(), live: m._xyo_browser_compiled_live_modules() });
  const snapshot = h => JSON.parse(m.UTF8ToString(m._xyo_browser_snapshot(h)));
  const observable = h => snapshot(h).targets.map(({ name, variables, bubbleText, bubbleType, x, y, direction }) => ({ name, variables, bubbleText, bubbleType, x, y, direction }));
  const bytes = sb3(project);
  const load = h => {
    const p = m._malloc(bytes.length); m.HEAPU8.set(bytes, p);
    try { assert.equal(m._xyo_browser_load_sb3(h, p, bytes.length), 1, m.UTF8ToString(m._xyo_browser_error(h))); }
    finally { m._free(p); }
  };
  const a = m._xyo_browser_create(), b = m._xyo_browser_create();
  assert.ok(a && b);
  try {
    load(a); load(b);
    assert.equal(m._xyo_browser_set_compiled(b, 1), 1);
    assert.equal(m._xyo_browser_compiled_enabled(a), 0);
    assert.equal(m._xyo_browser_compiled_enabled(b), 1);
    for (let flag = 1; flag <= 2; flag++) {
      const before = stats();
      assert.equal(m._xyo_browser_green_flag(a), 1);
      assert.deepEqual(stats(), before, 'interpreter flag must not compile');
      assert.equal(m._xyo_browser_green_flag(b), 1);
      const flagged = stats();
      if (flag === 1) {
        assert.ok(flagged.successes > before.successes, 'first flag must compile');
        assert.ok(flagged.live > before.live, 'compiled module must be live immediately after flag');
      }
      for (let frame = 1; frame <= 5; frame++) {
        assert.equal(m._xyo_browser_step(a), 1);
        assert.equal(m._xyo_browser_step(b), 1);
        assert.deepEqual(observable(b), observable(a), `flag ${flag}, frame ${frame}`);
      }
      const after = stats(), state = observable(a);
      if (flag === 1) {
        assert.ok(after.executions > before.executions, 'compiled prefix must execute');
        assert.equal(after.fallbacks, before.fallbacks);
      } else {
        // Same Runtime and block container: the first run populated the execute
        // cache. The second flag compiles again, but the cache guard falls back;
        // this is not evidence of a second successful JIT execution.
        assert.ok(flagged.successes > before.successes, 'second flag recompiles');
        assert.ok(flagged.live > before.live, 'second module is initially live');
        assert.equal(after.executions, before.executions, 'second flag did not execute compiled code');
        assert.equal(after.fallbacks, before.fallbacks + 1, 'second flag falls back');
      }
      assert.equal(after.live, before.live, 'completed thread releases its module');
      assert.equal(state[0].variables.v.value, 7 + 3 * flag);
      assert.equal(state[1].bubbleText, 'hello');
      assert.equal(state[1].x, 10 * flag);
      assert.equal(state[1].y, 0);
      assert.equal(snapshot(a).threadCount, 0);
      assert.equal(snapshot(b).threadCount, 0);
      console.log(`flag ${flag}`, { before, flagged, after });
    }
  } finally { m._xyo_browser_destroy(a); m._xyo_browser_destroy(b); }
});

test('axis motion blocks compile at flag and match the interpreter', async () => {
  const m = await create({ wasmBinary: fs.readFileSync(path.join(build, 'xyo-browser.wasm')) });
  for (const [opcode, key] of [['motion_changexby', 'DX'], ['motion_setx', 'X'], ['motion_changeyby', 'DY'], ['motion_sety', 'Y']]) {
    const fixture = structuredClone(project);
    fixture.targets[1].blocks = {
      hat: { opcode: 'event_whenflagclicked', topLevel: true, next: 'axis', inputs: {}, fields: {} },
      axis: { opcode, next: null, inputs: { [key]: [1, [4, '-3.5']] }, fields: {} },
    };
    const bytes = sb3(fixture), a = m._xyo_browser_create(), b = m._xyo_browser_create();
    try {
      for (const h of [a, b]) {
        const p = m._malloc(bytes.length); m.HEAPU8.set(bytes, p);
        try { assert.equal(m._xyo_browser_load_sb3(h, p, bytes.length), 1); } finally { m._free(p); }
      }
      assert.equal(m._xyo_browser_set_compiled(b, 1), 1);
      const before = [m._xyo_browser_compile_successes(), m._xyo_browser_compiled_executions()];
      assert.equal(m._xyo_browser_green_flag(a), 1); assert.equal(m._xyo_browser_green_flag(b), 1);
      assert.equal(m._xyo_browser_compile_successes(), before[0] + 1, `${opcode}: flag-time compilation`);
      assert.equal(m._xyo_browser_step(a), 1); assert.equal(m._xyo_browser_step(b), 1);
      assert.equal(m._xyo_browser_compiled_executions(), before[1] + 1, `${opcode}: WASM execution`);
      const state = h => JSON.parse(m.UTF8ToString(m._xyo_browser_snapshot(h))).targets.find(t => t.name === 'Sprite1');
      assert.deepEqual([state(b).x, state(b).y], [state(a).x, state(a).y]);
    } finally { m._xyo_browser_destroy(a); m._xyo_browser_destroy(b); }
  }
});

test('numeric-string assignment followed by change compiles without altering the result', async () => {
  const m = await create({ wasmBinary: fs.readFileSync(path.join(build, 'xyo-browser.wasm')) });
  const fixture = structuredClone(project);
  fixture.targets[1].blocks = {
    hat: { opcode: 'event_whenflagclicked', topLevel: true, next: 'set', inputs: {}, fields: {} },
    set: { opcode: 'data_setvariableto', next: 'change', inputs: { VALUE: [1, [4, '0']] }, fields: { VARIABLE: ['v', 'v'] } },
    change: { opcode: 'data_changevariableby', next: null, inputs: { VALUE: [1, [4, '3']] }, fields: { VARIABLE: ['v', 'v'] } },
  };
  const bytes = sb3(fixture), a = m._xyo_browser_create(), b = m._xyo_browser_create();
  try {
    for (const h of [a, b]) {
      const p = m._malloc(bytes.length); m.HEAPU8.set(bytes, p);
      try { assert.equal(m._xyo_browser_load_sb3(h, p, bytes.length), 1); } finally { m._free(p); }
    }
    assert.equal(m._xyo_browser_set_compiled(b, 1), 1);
    const before = [m._xyo_browser_compile_successes(), m._xyo_browser_compiled_executions()];
    assert.equal(m._xyo_browser_green_flag(a), 1); assert.equal(m._xyo_browser_green_flag(b), 1);
    assert.equal(m._xyo_browser_compile_successes(), before[0] + 1, 'compile occurs on green flag');
    assert.equal(m._xyo_browser_step(a), 1); assert.equal(m._xyo_browser_step(b), 1);
    assert.equal(m._xyo_browser_compiled_executions(), before[1] + 1);
    const value = h => JSON.parse(m.UTF8ToString(m._xyo_browser_snapshot(h))).targets[0].variables.v.value;
    assert.equal(value(a), 3); assert.equal(value(b), value(a));
  } finally { m._xyo_browser_destroy(a); m._xyo_browser_destroy(b); }
});
