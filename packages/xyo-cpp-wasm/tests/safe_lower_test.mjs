// Run after building .work/safe-lower-test.cjs with scripts/test-safe-lower.sh.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../.work/safe-lower-test.cjs', import.meta.url));
const hex = execFileSync(process.execPath, [executable], { encoding: 'utf8' }).trim();
const bytes = Buffer.from(hex, 'hex');
assert(bytes.length > 8);
const memory = new WebAssembly.Memory({ initial: 256 });
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
const slots = new DataView(memory.buffer);
slots.setFloat64(0, 7, true);
assert.equal(instance.exports.f(0), 0);
assert.equal(slots.getFloat64(0, true), 10);
slots.setBigUint64(0, 0x7ff8000000000001n, true); // tagged boolean: bail
assert.equal(instance.exports.f(0), 1);
assert.equal(slots.getBigUint64(0, true), 0x7ff8000000000001n);
console.log(`safe lowering: real ${bytes.length}-byte WebAssembly module executed; result 10, tagged value bailed`);
