#!/usr/bin/env bun
// Pack the prebuilt LLVM-in-Wasm artifacts plus editor-owned bundles into
// packages/editor/public/llvm-artifacts (gitignored). Vite serves public/ in
// dev and copies it to dist/ on build, so the experimental backend can fetch
// everything from /llvm-artifacts/* in both modes. Re-run after rebuilding
// llvm-wasm (metadata compiler, browser relink, real-host) or editing the
// bundled editor sources.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'llvm-artifacts');
const llvmWasm = resolve(root, '..', 'llvm-wasm');
const need = {
  'xyo_browser_ir.js': join(llvmWasm, '.work', 'metadata-build', 'xyo_browser_ir.js'),
  'xyo_browser_ir.wasm': join(llvmWasm, '.work', 'metadata-build', 'xyo_browser_ir.wasm'),
  'llc-browser.mjs': join(llvmWasm, '.work', 'llvm19-browser-proof', 'llc-browser.mjs'),
  'llc-browser.wasm': join(llvmWasm, '.work', 'llvm19-browser-proof', 'llc-browser.wasm'),
  'lld-browser.mjs': join(llvmWasm, '.work', 'llvm19-lld-browser-proof', 'lld-browser.mjs'),
  'lld-browser.wasm': join(llvmWasm, '.work', 'llvm19-lld-browser-proof', 'lld-browser.wasm'),
  'real_host.js': join(llvmWasm, 'real-host', 'build', 'real_host.js'),
  'real_host.wasm': join(llvmWasm, 'real-host', 'build', 'real_host.wasm'),
  'unified_runtime_esm.mjs': join(llvmWasm, '.work', 'unified-build', 'unified_runtime_esm.mjs'),
  'unified_runtime_esm.wasm': join(llvmWasm, '.work', 'unified-build', 'unified_runtime_esm.wasm'),
};
const missing = Object.entries(need).filter(([, p]) => !existsSync(p)).map(([n]) => n);
if (missing.length > 0) {
  console.error(`llvm-wasm artifacts missing: ${missing.join(', ')}\nBuild the metadata compiler, browser relink outputs, and real-host first.`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
const { readFile, copyFile } = await import('node:fs/promises');
await Promise.all(Object.entries(need).map(async ([name, src]) => {
  await copyFile(src, join(outDir, name));
  console.log(`copied ${name}`);
}));
async function bundle(entry, outfile, format) {
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format });
  if (!built.success) throw new Error(`bun build ${entry} failed: ${built.logs}`);
  await writeFile(outfile, await built.outputs[0].text());
  console.log(`bundled ${outfile.split('/').pop()}`);
}
await bundle(join(llvmWasm, 'src', 'index.ts'), join(outDir, 'pipeline-index.mjs'), 'esm');
await bundle(join(llvmWasm, 'src', 'worker.ts'), join(outDir, 'pipeline-worker.mjs'), 'esm');
await bundle(join(root, 'src/lib', 'llvm-runner.worker.ts'), join(outDir, 'llvm-runner.worker.js'), 'iife');
console.log(`packed ${Object.keys(need).length + 3} files into public/llvm-artifacts`);
