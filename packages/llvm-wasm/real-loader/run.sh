#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
src=packages/llvm-wasm/real-loader
out=packages/llvm-wasm/.work/real-loader
mkdir -p "$out"
sdk=packages/xyo-cpp-wasm/.work/emsdk
node="$sdk/node/24.19.0_64bit/bin/node"
llvm=packages/xyo-cpp-wasm/.work/llvm19-proof/wasm/bin
export EM_CACHE="$PWD/$out/cache"
# The caller should restrict CPU affinity, for example taskset -c 0-3 bash .../run.sh.
"$node" "$llvm/llc.js" -mtriple=wasm32-unknown-emscripten -relocation-model=pic -filetype=obj "$src/side.ll" -o "$out/side.o"
"$node" "$llvm/lld.js" -flavor wasm --shared --allow-undefined --export=side_run --export=side_get_callback "$out/side.o" -o "$out/side.wasm"
"$node" "$llvm/llc.js" -mtriple=wasm32-unknown-emscripten -relocation-model=pic -filetype=obj "$src/unresolved.ll" -o "$out/unresolved.o"
"$node" "$llvm/lld.js" -flavor wasm --shared --allow-undefined --export=broken_entry "$out/unresolved.o" -o "$out/unresolved.wasm"
"$sdk/upstream/emscripten/em++" "$src/main.cpp" -O0 -sMAIN_MODULE=2 -sENVIRONMENT=node -sEXIT_RUNTIME=1 --embed-file "$out/side.wasm@/side.wasm" --embed-file "$out/unresolved.wasm@/unresolved.wasm" -o "$out/main.cjs"
"$node" --expose-gc "$out/main.cjs"
set +e
"$node" --expose-gc "$out/main.cjs" unresolved > "$out/unresolved.log" 2>&1
status=$?
set -e
if [ "$status" -eq 0 ]; then
  if ! grep -Fq 'PASS: unresolved module rejected at dlopen' "$out/unresolved.log"; then echo 'FAIL: unexpected unresolved test output'; exit 1; fi
elif grep -Fq 'intentionally_missing_host_symbol' "$out/unresolved.log" && grep -Fq 'INFO: unresolved import deferred until call' "$out/unresolved.log"; then
  echo 'PASS: unresolved import fails on call (not at RTLD_NOW dlopen)'
else
  echo 'FAIL: unexpected unresolved test failure'; sed -n '1,80p' "$out/unresolved.log"; exit 1
fi
