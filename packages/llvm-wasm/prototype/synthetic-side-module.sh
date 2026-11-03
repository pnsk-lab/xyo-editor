#!/usr/bin/env bash
# Run from repository root; this is a synthetic-host experiment, not a runtime loader.
set -euo pipefail
cd "$(dirname "$0")/../../.."
out=packages/llvm-wasm/.work/synthetic-side
node=packages/xyo-cpp-wasm/.work/emsdk/node/24.19.0_64bit/bin/node
bin=packages/xyo-cpp-wasm/.work/llvm19-proof/wasm/bin
ir=packages/llvm-wasm/.work/smoke-fixtures/valid.ll
mkdir -p "$out"
# Regenerate the fixture and IR so an old or unrelated file cannot be mistaken
# for this experiment's SB3-derived input. Affinity is inherited from the caller.
bash packages/llvm-wasm/prototype/run-smoke.sh
"$node" "$bin/llc.js" -mtriple=wasm32-unknown-emscripten -relocation-model=pic -filetype=obj "$ir" -o "$out/parent.o"
"$node" "$bin/lld.js" -flavor wasm --shared --allow-undefined --export=xyo_browser_script "$out/parent.o" -o "$out/parent.wasm"
"$node" packages/llvm-wasm/prototype/synthetic-side-module.cjs "$out/parent.wasm"
