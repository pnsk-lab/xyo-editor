#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
src=packages/llvm-wasm/real-loader
out=packages/llvm-wasm/.work/real-loader
mkdir -p "$out"
sdk=packages/xyo-cpp-wasm/.work/emsdk
node="$sdk/node/24.19.0_64bit/bin/node"
export EM_CACHE="$PWD/$out/cache"
# First run run.sh to build both side modules with the Wasm LLVM tools.
"$sdk/upstream/emscripten/em++" "$src/main.cpp" -O0 -sMAIN_MODULE=2 -sENVIRONMENT=worker -sEXIT_RUNTIME=1 --embed-file "$out/side.wasm@/side.wasm" --embed-file "$out/unresolved.wasm@/unresolved.wasm" -o "$out/browser.js"
"$node" "$src/browser-test.mjs"
