#!/usr/bin/env python3
"""Relink existing LLVM19 objects only; run with caller-controlled CPU limits."""
from pathlib import Path
import os
import shlex
import subprocess

root = Path(__file__).resolve().parents[2]
build = root / 'packages/xyo-cpp-wasm/.work/llvm19-proof/wasm'
out = root / 'packages/llvm-wasm/.work/llvm19-lld-browser-proof'
out.mkdir(parents=True, exist_ok=True)
ninja = root / 'packages/xyo-cpp-wasm/.work/tools/bin/ninja'
commands = subprocess.check_output([str(ninja), '-C', str(build), '-t', 'commands', 'lld'], text=True)
line = next(x for x in reversed(commands.splitlines()) if ' -o bin/lld.js ' in x)
command = line.split('&&', 2)[1].strip()
args = shlex.split(command)
args = [x for x in args if x not in ('-sNODERAWFS=1', '-sENVIRONMENT=node')]
idx = args.index('-o')
assert args[idx + 1] == 'bin/lld.js'
args[idx + 1] = str(out / 'lld-browser.mjs')
args = [str(build / x) if x.startswith(('tools/', 'lib/')) else x for x in args]
args.extend(['-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker',
             '-sEXIT_RUNTIME=1', '-sINVOKE_RUN=0', '-sEXPORTED_RUNTIME_METHODS=FS,callMain'])
env = dict(os.environ, EMCC_FROZEN_CACHE='1', TMPDIR=str(out))
print(shlex.join(args), flush=True)
subprocess.run(args, cwd=out, env=env, check=True)
