#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/.work/xyo-cpp"
: "${EMXX:=em++}"
"$EMXX" -std=c++20 -O1 -sUSE_ZLIB=1 -I"$src/src" -I"$root/src" \
  "$root/tests/safe_lower_test.cpp" "$root/src/safe_lower.cpp" \
  "$src/src/wasm/wasm_compile.cpp" "$root/.work/build-wasm/libxyo.a" \
  -o "$root/.work/safe-lower-test.cjs"
node "$root/tests/safe_lower_test.mjs"
