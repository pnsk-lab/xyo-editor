#!/usr/bin/env bash
# Run from repository root. Requires the isolated checkout, LLVM 19.1.7 source
# and configured Wasm headers. This is NOT a link or runtime test.
set -euo pipefail
root="$PWD"
xyo="$root/packages/llvm-wasm/.work/xyo-ir-prototype"
llvm="$root/packages/xyo-cpp-wasm/.work/llvm19-proof"
patch="$root/packages/llvm-wasm/prototype/llvm19-compat.patch"
# The patch is already applied in this disposable checkout. Check it reverses
# cleanly against that exact tree, without mutating the checkout.
git -C "$xyo" apply --reverse --check "$patch"
"$root/packages/xyo-cpp-wasm/.work/emsdk/upstream/emscripten/em++" \
  -std=c++20 -fsyntax-only -I"$llvm/wasm/include" \
  -I"$llvm/llvm-project-19.1.7.src/llvm/include" \
  "$xyo/src/jit/browser_ir_api.cpp" "$xyo/src/jit/codegen.cpp"
printf '%s\n' 'PASS: LLVM 19.1.7 wrapper + upstream codegen syntax only; not linked or run'
