import { readFile } from 'node:fs/promises';

const [objectPath, modulePath] = process.argv.slice(2);
if (!objectPath || !modulePath) throw new Error('usage: node verify-object.mjs <relocatable.o> <linked.wasm>');
const object = await readFile(objectPath);
if (!object.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error('output is not a Wasm binary');
const module = await WebAssembly.instantiate(await readFile(modulePath));
if (module.instance.exports.add(20, 22) !== 42) throw new Error('add(20,22) != 42');
console.log(`Wasm object ${object.length} bytes; linked add(20,22) = 42`);
