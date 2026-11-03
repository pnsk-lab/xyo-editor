// Run with the independent WASM module path as argv[2].
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.resolve(process.argv[2]);
const create = require(modulePath);
function zip(project) {
  const name = Buffer.from('project.json'), data = Buffer.from(JSON.stringify(project));
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
function project(question = '') {
  const blocks = {
    flag: { opcode: 'event_whenflagclicked', next: 'a', parent: null, inputs: {}, fields: {}, topLevel: true },
    a: { opcode: 'sensing_askandwait', next: 'b', parent: 'flag', inputs: { QUESTION: [1, [10, question]] }, fields: {} },
    b: { opcode: 'sensing_askandwait', next: null, parent: 'a', inputs: { QUESTION: [1, [10, question]] }, fields: {} },
    flag2: { opcode: 'event_whenflagclicked', next: 'c', parent: null, inputs: {}, fields: {}, topLevel: true },
    c: { opcode: 'sensing_askandwait', next: null, parent: 'flag2', inputs: { QUESTION: [1, [10, question]] }, fields: {} },
  };
  return zip({ targets: [{ isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks, costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: 0 }], monitors: [], extensions: [], meta: { semver: '3.0.0' } });
}
function stopTargetProject() {
  const question = 'Same question?';
  const ask = parent => ({ opcode: 'sensing_askandwait', next: 'save', parent, inputs: { QUESTION: [1, [10, question]] }, fields: {} });
  const save = value => ({ opcode: 'data_setvariableto', next: null, parent: 'ask', inputs: { VALUE: [1, [10, value]] }, fields: { VARIABLE: ['result', 'v'] } });
  const stageBlocks = {
    flag: { opcode: 'event_whenflagclicked', next: 'ask', parent: null, inputs: {}, fields: {}, topLevel: true },
    ask: ask('flag'), save: save('B resumed'),
  };
  const spriteBlocks = {
    flag: { opcode: 'event_whenflagclicked', next: 'ask', parent: null, inputs: {}, fields: {}, topLevel: true },
    ask: ask('flag'), save: save('A resumed'),
    key: { opcode: 'event_whenkeypressed', next: 'stop', parent: null, inputs: {}, fields: { KEY_OPTION: ['space', null] }, topLevel: true },
    stop: { opcode: 'control_stop', next: null, parent: 'key', inputs: {}, fields: { STOP_OPTION: ['other scripts in sprite', null] } },
  };
  const target = (isStage, blocks) => ({ isStage, name: isStage ? 'Stage' : 'Sprite', variables: isStage ? { v: ['result', ''] } : {}, lists: {}, broadcasts: {}, blocks, costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: isStage ? 0 : 1, visible: false, x: 0, y: 0, size: 100, direction: 90 });
  return zip({ targets: [target(true, stageBlocks), target(false, spriteBlocks)], monitors: [], extensions: [], meta: { semver: '3.0.0' } });
}
(async () => {
  const m = await create({ wasmBinary: fs.readFileSync(modulePath.replace(/\.js$/, '.wasm')) });
  const h = m._xyo_browser_create();
  const input = (buf, fn) => { const p = m._malloc(Math.max(1, buf.length)); m.HEAPU8.set(buf, p); try { return fn(p, buf.length); } finally { m._free(p); } };
  const load = data => input(data, (p, n) => m._xyo_browser_load_sb3(h, p, n));
  const answer = (id, text) => input(Buffer.from(id), (ip, il) => input(Buffer.from(text), (p, n) => m._xyo_browser_answer_if_question(h, ip, il, p, n)));
  const snap = () => JSON.parse(m.UTF8ToString(m._xyo_browser_snapshot(h))).io;
  const step = () => assert.equal(m._xyo_browser_step(h), 1);
  const flag = () => assert.equal(m._xyo_browser_green_flag(h), 1);
  const data = project(); assert.equal(load(data), 1); flag(); step();
  const a = snap(); assert.equal(a.question, ''); assert.match(a.questionId, /^[1-9]\d*$/);
  // Re-trigger flag cancels the old queue and enqueues same-text questions.
  flag(); step(); const b = snap(); assert.notEqual(b.questionId, a.questionId);
  assert.equal(answer(a.questionId, 'stale'), -1); assert.deepEqual(snap(), b);
  assert.equal(answer(b.questionId, 'first'), 1); const c = snap();
  assert.equal(c.question, ''); assert.notEqual(c.questionId, b.questionId);
  assert.equal(answer(b.questionId, 'duplicate'), -1); assert.equal(snap().answer, 'first');
  assert.equal(answer(c.questionId, 'second'), 1); step(); const d = snap();
  assert.equal(d.question, ''); assert.notEqual(d.questionId, a.questionId);
  assert.notEqual(d.questionId, b.questionId); assert.notEqual(d.questionId, c.questionId);
  assert.equal(m._xyo_browser_stop(h), 1); assert.equal(answer(d.questionId, 'stale'), -1);
  assert.equal(load(data), 1); flag(); step(); const e = snap();
  assert.ok(BigInt(e.questionId) > BigInt(d.questionId)); assert.equal(answer(d.questionId, 'old'), -1);
  assert.equal(answer(e.questionId, ''), 1); assert.equal(snap().answer, '');
  // A is queued by the sprite, B by the stage. A key-triggered script
  // on the sprite cancels A during step without cancelling B.
  assert.equal(load(stopTargetProject()), 1); flag(); step();
  const old = snap(); assert.equal(old.question, 'Same question?');
  assert.match(old.questionId, /^[1-9]\d*$/);
  assert.equal(input(Buffer.from(' '), (p, n) => m._xyo_browser_key(h, p, n, 1, 32)), 1);
  step(); const replacement = snap();
  assert.equal(replacement.question, old.question);
  assert.notEqual(replacement.questionId, old.questionId);
  assert.equal(answer(old.questionId, 'stale'), -1);
  assert.deepEqual(snap(), replacement);
  assert.equal(answer(replacement.questionId, 'accepted'), 1);
  assert.equal(snap().answer, 'accepted'); step();
  const full = JSON.parse(m.UTF8ToString(m._xyo_browser_snapshot(h)));
  assert.equal(full.targets.find(t => t.isStage).variables.v.value, 'B resumed');
  assert.equal(m._xyo_browser_destroy(h), 1);
  console.log('question ID ABI race tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
