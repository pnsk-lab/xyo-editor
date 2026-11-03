// Run after build.sh: node packages/xyo-cpp-wasm/scripts/test-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '../.work/build-wasm');
const create = require(path.join(dir, 'xyo-browser.js'));
// Minimal single-file stored ZIP fixture, exercising actual event scripts.
function projectZip(project) {
  const name = Buffer.from('project.json'), data = Buffer.from(JSON.stringify(project));
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
function inputProject() {
  const blocks = {
    flag: { opcode: 'event_whenflagclicked', next: 'ask', parent: null, inputs: {}, fields: {}, topLevel: true },
    ask: { opcode: 'sensing_askandwait', next: 'save', parent: 'flag', inputs: { QUESTION: [1, [10, 'Question?']] }, fields: {} },
    save: { opcode: 'data_setvariableto', next: null, parent: 'ask', inputs: { VALUE: [2, 'answer'] }, fields: { VARIABLE: ['result', 'v'] } },
    answer: { opcode: 'sensing_answer', next: null, parent: 'save', inputs: {}, fields: {} },
    hat: { opcode: 'event_whenkeypressed', next: 'setkey', parent: null, inputs: {}, fields: { KEY_OPTION: ['space', null] }, topLevel: true },
    setkey: { opcode: 'data_setvariableto', next: null, parent: 'hat', inputs: { VALUE: [1, [10, 'pressed']] }, fields: { VARIABLE: ['key', 'k'] } },
  };
  return { targets: [{ isStage: true, name: 'Stage', variables: { v: ['result', ''], k: ['key', ''] }, lists: {}, broadcasts: {}, blocks, costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: 0 }], monitors: [], extensions: [], meta: { semver: '3.0.0' } };
}
function arithmeticProject(unsupported = false) {
  const project = inputProject(), stage = project.targets[0];
  stage.variables = { v: ['v', 7] };
  stage.blocks = {
    hat: { opcode: 'event_whenflagclicked', next: unsupported ? 'say' : 'a', parent: null, inputs: {}, fields: {}, topLevel: true },
    a: { opcode: 'data_changevariableby', next: 'b', parent: unsupported ? 'say' : 'hat', inputs: { VALUE: [1, [4, '3']] }, fields: { VARIABLE: ['v', 'v'] } },
    b: { opcode: 'data_changevariableby', next: null, parent: 'a', inputs: { VALUE: [1, [4, '2']] }, fields: { VARIABLE: ['v', 'v'] } },
  };
  if (unsupported) stage.blocks.say = { opcode: 'looks_say', next: 'a', parent: 'hat', inputs: { MESSAGE: [1, [10, 'hello']] }, fields: {} };
  return project;
}
(async () => {
  const m = await create({ wasmBinary: fs.readFileSync(path.join(dir, 'xyo-browser.wasm')) });
  const bytes = fs.readFileSync(path.join(__dirname, '../.work/xyo-cpp/tests/fixtures/basic.sb3'));
  const load = (h, data) => { const p = m._malloc(data.length); m.HEAPU8.set(data, p); try { return m._xyo_browser_load_sb3(h, p, data.length); } finally { m._free(p); } };
  const snapshot = h => JSON.parse(m.UTF8ToString(m._xyo_browser_snapshot(h)));
  assert.equal(m._xyo_browser_capabilities(), 3);
  const h = m._xyo_browser_create(), other = m._xyo_browser_create();
  assert.ok(h && other && h !== other);
  assert.equal(m._xyo_browser_step(h), 0);
  assert.match(m.UTF8ToString(m._xyo_browser_error(h)), /No project/);
  assert.equal(load(h, bytes), 1);
  assert.equal(load(other, bytes), 1);
  let s = snapshot(h);
  assert.equal(s.targets.length, 2);
  const originalX = s.targets.find(t => !t.isStage).x;
  assert.equal(load(h, Buffer.from('invalid zip')), 0);
  assert.ok(m.UTF8ToString(m._xyo_browser_error(h)));
  assert.equal(snapshot(h).targets.length, 2); // failed load preserves prior project
  assert.equal(m._xyo_browser_green_flag(h), 1);
  assert.equal(m._xyo_browser_step(h), 1);
  s = snapshot(h);
  assert.notEqual(s.targets.find(t => !t.isStage).x, originalX);
  assert.equal(snapshot(other).targets.find(t => !t.isStage).x, originalX);
  const textCall = (fn, h, text, ...args) => {
    const data = Buffer.from(text), p = m._malloc(Math.max(1, data.length));
    m.HEAPU8.set(data, p);
    try { return fn(h, p, data.length, ...args); } finally { m._free(p); }
  };
  assert.equal(textCall(m._xyo_browser_key, h, 'ArrowLeft', 1, 37), 1);
  assert.equal(snapshot(h).io.lastKey, 'left arrow');
  assert.equal(textCall(m._xyo_browser_key, h, 'ArrowLeft', 0, 37), 1);
  assert.equal(m._xyo_browser_mouse(h, 120, 90, 480, 360, 1, 0, 0), 1);
  assert.deepEqual([snapshot(h).io.mouseX, snapshot(h).io.mouseY, snapshot(h).io.mouseDown], [-120, 90, true]);
  assert.equal(m._xyo_browser_mouse(h, 120, 90, 480, 360, 0, 0, 0), 1);
  assert.equal(snapshot(h).io.mouseDown, false);
  assert.equal(m._xyo_browser_wheel(h, 2, -3), 1);
  assert.deepEqual([snapshot(h).io.scrollX, snapshot(h).io.scrollY], [-2, 3]);
  assert.equal(textCall(m._xyo_browser_answer, h, 'はい😀'), 1);
  assert.equal(snapshot(h).io.answer, 'はい😀');
  assert.equal(snapshot(other).io.answer, '');
  assert.equal(m._xyo_browser_mouse(h, 0, 0, 0, 360, 1, 0, 0), 0);
  assert.equal(m._xyo_browser_wheel(h, Infinity, 0), 0);
  assert.equal(m._xyo_browser_key(h, 0, 0, 1, 37), 0);
  assert.equal(m._xyo_browser_stop(h), 1);
  assert.equal(snapshot(h).threadCount, 0);
  assert.equal(load(h, projectZip(inputProject())), 1);
  assert.equal(m._xyo_browser_green_flag(h), 1);
  assert.equal(m._xyo_browser_step(h), 1);
  assert.equal(snapshot(h).io.question, 'Question?');
  assert.equal(textCall(m._xyo_browser_key, h, ' ', 1, 32), 1);
  assert.equal(m._xyo_browser_step(h), 1);
  assert.equal(snapshot(h).targets[0].variables.k.value, 'pressed');
  assert.equal(textCall(m._xyo_browser_key, h, ' ', 0, 32), 1);
  assert.equal(textCall(m._xyo_browser_answer, h, '回答😀'), 1);
  for (let n = 0; n < 3; n++) assert.equal(m._xyo_browser_step(h), 1);
  assert.equal(snapshot(h).targets[0].variables.v.value, '回答😀');
  assert.equal(snapshot(h).io.question, null);
  // Metrics are module-wide. With mode disabled, no attempt occurs.
  const stats = () => [m._xyo_browser_compile_attempts(), m._xyo_browser_compile_successes(), m._xyo_browser_compiled_executions(), m._xyo_browser_compile_fallbacks(), m._xyo_browser_compiled_live_modules()];
  const initial = stats();
  assert.equal(load(h, projectZip(arithmeticProject())), 1);
  assert.equal(load(other, projectZip(arithmeticProject())), 1);
  assert.equal(m._xyo_browser_green_flag(other), 1);
  assert.deepEqual(stats(), initial);
  assert.equal(m._xyo_browser_compiled_enabled(h), 0);
  assert.equal(m._xyo_browser_set_compiled(h, 1), 1);
  assert.equal(m._xyo_browser_compiled_enabled(h), 1);
  assert.equal(m._xyo_browser_compiled_enabled(other), 0);
  assert.equal(m._xyo_browser_green_flag(h), 1);
  assert.deepEqual(stats(), [initial[0] + 1, initial[1] + 1, initial[2], initial[3], 1]);
  assert.equal(snapshot(h).targets[0].variables.v.value, 7); // compile does not execute
  assert.equal(m._xyo_browser_step(other), 1); // another handle must not disable pending JIT
  assert.equal(snapshot(other).targets[0].variables.v.value, 12);
  assert.equal(m._xyo_browser_step(h), 1);
  assert.equal(snapshot(h).targets[0].variables.v.value, 12);
  assert.deepEqual(stats(), [initial[0] + 1, initial[1] + 1, initial[2] + 1, initial[3], 0]);
  assert.equal(load(h, projectZip(arithmeticProject(true))), 1);
  assert.equal(m._xyo_browser_green_flag(h), 1);
  assert.equal(m._xyo_browser_step(h), 1);
  assert.equal(snapshot(h).targets[0].variables.v.value, 12);
  // The unsupported say prefix runs in the interpreter; its arithmetic suffix
  // is compiled on the subsequent chunk boundary.
  const afterMixed = stats();
  assert.deepEqual(afterMixed, [initial[0] + 2, initial[1] + 2, initial[2] + 2, initial[3], 0]);
  const unsupported = arithmeticProject(true);
  unsupported.targets[0].blocks.say.next = null; // no compilable suffix
  assert.equal(load(h, projectZip(unsupported)), 1);
  assert.equal(m._xyo_browser_green_flag(h), 1);
  assert.equal(m._xyo_browser_step(h), 1);
  assert.equal(snapshot(h).targets[0].variables.v.value, 7);
  const afterUnsupported = stats();
  assert.ok(afterUnsupported[0] > afterMixed[0], 'unsupported script attempted compilation');
  assert.equal(afterUnsupported[1], afterMixed[1]);
  assert.equal(afterUnsupported[2], afterMixed[2]);
  assert.ok(afterUnsupported[3] > afterMixed[3], 'unsupported script fell back');
  assert.equal(afterUnsupported[4], 0);
  assert.equal(load(h, projectZip(arithmeticProject())), 1);
  const originalModule = WebAssembly.Module;
  try {
    WebAssembly.Module = function () { throw new WebAssembly.CompileError('CSP'); };
    assert.equal(m._xyo_browser_green_flag(h), 1);
  } finally { WebAssembly.Module = originalModule; }
  assert.equal(m._xyo_browser_step(h), 1);
  assert.equal(snapshot(h).targets[0].variables.v.value, 12);
  const afterCsp = stats();
  assert.ok(afterCsp[0] > afterUnsupported[0], 'CSP test attempted compilation');
  assert.equal(afterCsp[1], afterUnsupported[1], 'CSP rejected all new compilations');
  assert.equal(afterCsp[2], afterUnsupported[2], 'CSP cannot execute new modules');
  assert.ok(afterCsp[3] > afterUnsupported[3], 'CSP falls back to interpreter');
  assert.equal(afterCsp[4], 0);
  assert.equal(load(h, projectZip(arithmeticProject())), 1);
  assert.equal(m._xyo_browser_green_flag(h), 1);
  assert.equal(stats()[4], 1);
  assert.equal(m._xyo_browser_stop(h), 1);
  assert.equal(stats()[4], 0); // abandoned prepared module released
  assert.equal(m._xyo_browser_green_flag(h), 1);
  assert.equal(stats()[4], 1);
  assert.equal(m._xyo_browser_destroy(h), 1);
  assert.equal(stats()[4], 0); // destruction also releases prepared code
  assert.equal(m._xyo_browser_destroy(h), 0);
  assert.equal(m._xyo_browser_step(h), 0);
  assert.equal(m._xyo_browser_destroy(other), 1);
  console.log('browser C ABI smoke test passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
