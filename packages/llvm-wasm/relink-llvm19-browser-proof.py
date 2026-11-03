#!/usr/bin/env python3
"""Relink the existing LLVM 19 llc objects/archives without modifying its build tree."""
import os, pathlib, shlex, subprocess
root = pathlib.Path(__file__).resolve().parents[2]
build = root / 'packages/xyo-cpp-wasm/.work/llvm19-proof/wasm'
out = root / 'packages/llvm-wasm/.work/llvm19-browser-proof'
out.mkdir(parents=True, exist_ok=True)
ninja = root / 'packages/xyo-cpp-wasm/.work/tools/bin/ninja'
lines = subprocess.check_output([str(ninja), '-C', str(build), '-t', 'commands', 'llc'], text=True).splitlines()
words = shlex.split(lines[-1])
assert words[:1] == [':'] and words[-2:] == ['&&', ':']
words = words[2:-2]
args = []
skip = False
for arg in words:
    if skip:
        skip = False
        continue
    if arg == '-o':
        skip = True
        continue
    if arg in ('-sNODERAWFS=1', '-sENVIRONMENT=node'):
        continue
    if arg.startswith(('tools/', 'lib/')):
        arg = str(build / arg)
    args.append(arg)
args += ['-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker', '-sFORCE_FILESYSTEM=1', '-sEXPORTED_RUNTIME_METHODS=FS,callMain', '-sINVOKE_RUN=0', '-o', str(out / 'llc-browser.mjs')]
env = dict(os.environ, EMCC_FROZEN_CACHE='1', TMPDIR=str(out))
print(shlex.join(args), flush=True)
subprocess.run(args, cwd=out, env=env, check=True)
