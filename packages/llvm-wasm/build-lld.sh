#!/usr/bin/env bash
# Invoke from repository root with external affinity/parallelism limits, after build-cross.sh.
set -euo pipefail
ROOT="$PWD"
W="$ROOT/packages/xyo-cpp-wasm/.work/llvm19-proof"
export PATH="$ROOT/packages/xyo-cpp-wasm/.work/tools/bin:$PATH"
set +u
source "$ROOT/packages/xyo-cpp-wasm/.work/emsdk/emsdk_env.sh"
set -u
cmake -S "$W/llvm-project-19.1.7.src/llvm" -B "$W/wasm" -DLLVM_ENABLE_PROJECTS=lld
cmake --build "$W/wasm" --target lld
[[ -e "$W/wasm/bin/package.json" ]] || printf '%s\n' '{"type":"commonjs"}' > "$W/wasm/bin/package.json"
node "$W/wasm/bin/llc.js" -mtriple=wasm32-unknown-unknown -filetype=obj packages/llvm-wasm/add.ll -o "$W/add.o"
node "$W/wasm/bin/lld.js" -flavor wasm --no-entry --export=add "$W/add.o" -o "$W/add-wasm-lld.wasm"
node packages/llvm-wasm/verify-object.mjs "$W/add.o" "$W/add-wasm-lld.wasm"
node "$W/wasm/bin/llc.js" -mtriple=wasm32-unknown-unknown -filetype=obj packages/llvm-wasm/memory.ll -o "$W/memory.o"
node "$W/wasm/bin/lld.js" -flavor wasm --no-entry --import-memory --export=increment "$W/memory.o" -o "$W/memory.wasm"
node packages/llvm-wasm/verify-memory.mjs "$W/memory.wasm"
