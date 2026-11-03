#!/usr/bin/env bash
# Run from repository root; metadata artifact is separate from the original IR proof.
# CPU affinity and parallelism are inherited from caller.
set -euo pipefail
build=packages/llvm-wasm/.work/metadata-build
fixtures=packages/llvm-wasm/.work/metadata-fixtures
node=packages/xyo-cpp-wasm/.work/emsdk/node/24.19.0_64bit/bin/node
python3 packages/llvm-wasm/metadata-prototype/make-fixtures.py "$fixtures"
python3 packages/llvm-wasm/metadata-prototype/make-zip-fuzz.py "$fixtures"
cp "$build/xyo_browser_ir.js" "$build/xyo_browser_ir.cjs"
"$node" packages/llvm-wasm/metadata-prototype/test-metadata.cjs "$build/xyo_browser_ir.cjs" "$fixtures"
"$node" packages/llvm-wasm/metadata-prototype/test-zip-preflight.cjs "$build/xyo_browser_ir.cjs" "$fixtures"
