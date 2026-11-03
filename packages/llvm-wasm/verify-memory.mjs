import { readFile } from 'node:fs/promises';
const path = process.argv[2];
if (!path) throw new Error('usage: node verify-memory.mjs <linked.wasm>');
const memory = new WebAssembly.Memory({ initial: 2 });
const cell = new DataView(memory.buffer);
cell.setInt32(0, 41, true);
const { instance } = await WebAssembly.instantiate(await readFile(path), { env: { memory } });
if (instance.exports.increment(0) !== 42 || cell.getInt32(0, true) !== 42) {
  throw new Error('imported memory was not updated to 42');
}
console.log('imported memory increment(0) = 42; caller memory = 42');
