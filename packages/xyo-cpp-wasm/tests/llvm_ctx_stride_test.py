#!/usr/bin/env python3
"""Limited LLVM GEP ABI regression; this does not execute xyo's codegen.

Apply patches/llvm-context-pointer-stride.patch to a disposable upstream checkout,
then run with CLANG, WASM_LD and CC pointing to LLVM clang, wasm-ld and a native
C compiler. SOURCE is that checkout. The test checks the real ctxPtr expression,
then executes equivalent LLVM IR on the native and wasm32 targets. It does not
validate xyo's other host-layout assumptions or compile LLVM to WebAssembly.
"""
import ctypes
import os
from pathlib import Path
import re
import subprocess
import tempfile


def run(*args):
    subprocess.run([str(a) for a in args], check=True)

source = Path(os.environ['SOURCE'])
clang = os.environ.get('CLANG', 'clang')
wasm_ld = os.environ.get('WASM_LD', 'wasm-ld')
cc = os.environ.get('CC', 'cc')
node = os.environ.get('NODE', 'node')
code = (source / 'src/jit/codegen.cpp').read_text()
match = re.search(r'llvm::Value\* ctxPtr\(int idx\)\s*\{\s*return b\.CreateLoad\(ptrt, b\.CreateConstGEP1_32\((\w+), ctxArg, idx\)\);\s*\}', code)
if not match or match.group(1) != 'ptrt':
    raise SystemExit('ctxPtr must load via a pointer-element GEP')
# The following is the same load(GEP(ptr, ctx, idx)) IR operation, not
# an invocation of jitEmitScript or a complete xyo-generated module.
ir = '''
define ptr @target(ptr %ctx) {
  %p = getelementptr ptr, ptr %ctx, i32 1
  %v = load ptr, ptr %p
  ret ptr %v
}
define ptr @runtime(ptr %ctx) {
  %p = getelementptr ptr, ptr %ctx, i32 2
  %v = load ptr, ptr %p
  ret ptr %v
}
'''
with tempfile.TemporaryDirectory(prefix='xyo-llvm-ctx-') as d:
    d = Path(d)
    ll = d / 'test.ll'
    ll.write_text(ir)
    obj = d / 'native.o'
    run(clang, '-Wno-override-module', '-fPIC', '-x', 'ir', '-c', ll, '-o', obj)
    lib = d / 'test.so'
    run(cc, '-shared', obj, '-o', lib)
    native = ctypes.CDLL(str(lib))
    array = (ctypes.c_void_p * 5)(0x1110, 0x2220, 0x3330, 0x4440, 0x5550)
    for name, expected in [('target', 0x2220), ('runtime', 0x3330)]:
        f = getattr(native, name)
        f.argtypes = [ctypes.c_void_p]
        f.restype = ctypes.c_void_p
        assert f(ctypes.addressof(array)) == expected, name
    wasm_obj = d / 'test-wasm.o'
    run(clang, '--target=wasm32-unknown-unknown', '-Wno-override-module',
        '-x', 'ir', '-c', ll, '-o', wasm_obj)
    wasm = d / 'test.wasm'
    run(wasm_ld, '--no-entry', '--export=target', '--export=runtime',
        '--export-memory', wasm_obj, '-o', wasm)
    js = '''const fs = require('fs');
const m = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(process.argv[1])));
const e = m.exports, a = new Uint32Array(e.memory.buffer, 1024, 5);
a.set([0x1110,0x2220,0x3330,0x4440,0x5550]);
if (e.target(1024) !== 0x2220 || e.runtime(1024) !== 0x3330) process.exit(1);
'''
    run(node, '-e', js, wasm)
    # Negative control: the old i64-element GEP reads the wrong wasm32 slots.
    old_ll = d / 'old.ll'
    old_ll.write_text(ir.replace('getelementptr ptr,', 'getelementptr i64,'))
    old_obj = d / 'old-wasm.o'
    run(clang, '--target=wasm32-unknown-unknown', '-Wno-override-module',
        '-x', 'ir', '-c', old_ll, '-o', old_obj)
    old_wasm = d / 'old.wasm'
    run(wasm_ld, '--no-entry', '--export=target', '--export=runtime',
        '--export-memory', old_obj, '-o', old_wasm)
    negative = '''const fs = require('fs');
const m = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(process.argv[1])));
const e = m.exports, a = new Uint32Array(e.memory.buffer, 1024, 5);
a.set([0x1110,0x2220,0x3330,0x4440,0x5550]);
if (e.target(1024) !== 0x3330 || e.runtime(1024) !== 0x5550) process.exit(1);
'''
    run(node, '-e', negative, old_wasm)
print('PASS: pointer GEP native/wasm32; old i64 GEP misreads wasm32 (negative control)')
