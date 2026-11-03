#!/usr/bin/env bash
# Requires the pinned checkout with patches/safe-wasm-runtime.patch applied,
# and an activated Emscripten 6.0.12 toolchain and CMake.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/.work/xyo-cpp"
build="$root/.work/build-safe"
emcmake cmake -S "$src" -B "$build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS=-sUSE_ZLIB=1 -DXYO_JIT=OFF -DXYO_SDL2=OFF \
  -DXYO_BUILD_TESTS=OFF -DXYO_BUILD_SHELL=OFF \
  -DXYO_SAFE_WASM_TESTING=ON -DXYO_SAFE_WASM_DIR="$root/src"
cmake --build "$build" --target xyo -j4
em++ -std=c++20 -O1 -DXYO_SAFE_WASM_RUNTIME=1 -sUSE_ZLIB=1 -I"$src/src" -I"$root/src" \
  "$root/tests/safe_runtime_test.cpp" "$build/libxyo.a" \
  -o "$root/.work/safe-runtime-test.cjs"
node "$root/.work/safe-runtime-test.cjs"
