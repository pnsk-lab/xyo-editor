#!/usr/bin/env bash
# Requires activated Emscripten, CMake, Node and the pinned local xyo-cpp clone.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "$root/.work/axis-motion.XXXXXXXX")"
git clone -q --local "$root/.work/xyo-cpp" "$work/source"
git -C "$work/source" apply "$root/patches/safe-wasm-runtime.patch"
emcmake cmake -S "$work/source" -B "$work/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS=-sUSE_ZLIB=1 -DXYO_JIT=OFF -DXYO_SDL2=OFF \
  -DXYO_BUILD_TESTS=OFF -DXYO_BUILD_SHELL=OFF \
  -DXYO_SAFE_WASM_TESTING=ON -DXYO_SAFE_WASM_DIR="$root/src"
cmake --build "$work/build" --target xyo
em++ -std=c++20 -O1 -DXYO_SAFE_WASM_RUNTIME=1 -sUSE_ZLIB=1 \
  -I"$work/source/src" -I"$root/src" "$root/tests/axis_motion_test.cpp" \
  "$work/build/libxyo.a" --embed-file "$work/source/tests/fixtures/basic.sb3@/basic.sb3" \
  -o "$work/axis-motion.cjs"
node "$work/axis-motion.cjs"
printf 'Artifacts: %s\n' "$work"
