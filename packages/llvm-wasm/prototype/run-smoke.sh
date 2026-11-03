#!/usr/bin/env bash
# Run from repository root after building the isolated prototype.
# CPU affinity and build parallel limits are inherited from the caller.
set -euo pipefail
out=packages/llvm-wasm/.work/smoke-fixtures
build=packages/llvm-wasm/.work/prototype-build
node=packages/xyo-cpp-wasm/.work/emsdk/node/24.19.0_64bit/bin/node
python3 packages/llvm-wasm/prototype/smoke-fixture.py "$out"
# The workspace declares JS ESM; Emscripten emits CommonJS for this build.
cp "$build/xyo_browser_ir.js" "$build/xyo_browser_ir.cjs"
XYO_IR_OUT="$out/valid.ll" "$node" packages/llvm-wasm/prototype/smoke.cjs "$build/xyo_browser_ir.cjs" "$out"
# This llc is LLVM compiled to Wasm. readobj below is native inspection only.
"$node" packages/xyo-cpp-wasm/.work/llvm19-proof/wasm/bin/llc.js \
  -mtriple=wasm32-unknown-emscripten -relocation-model=pic -filetype=obj \
  "$out/valid.ll" -o "$out/valid.o"
python3 packages/llvm-wasm/prototype/verify-object.py \
  packages/xyo-cpp-wasm/.work/emsdk/upstream/bin/llvm-readobj "$out/valid.o"
