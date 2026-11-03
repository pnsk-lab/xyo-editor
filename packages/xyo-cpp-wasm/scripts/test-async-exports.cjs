// Verify the independently built distribution exposes the actual audio ABI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.resolve(process.argv[2]);
(async () => {
  const m = await require(modulePath)({ wasmBinary: fs.readFileSync(modulePath.replace(/\.js$/, '.wasm')) });
  for (const name of 'open session_generation close detach tick failed kind generation id_lo id_hi bytes bytes_size format target volume pop complete stop_ack close_ack'.split(' ')) {
    assert.equal(typeof m[`_xyo_browser_audio_${name}`], 'function', name);
  }
  const h = m._xyo_browser_create(); assert.ok(h);
  assert.equal(m._xyo_browser_audio_session_generation(h), 0);
  assert.equal(m._xyo_browser_audio_open(h, 10), 0);
  assert.equal(m._xyo_browser_destroy(h), 1);
  console.log('async sound distribution exports passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
