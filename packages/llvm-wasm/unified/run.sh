#!/usr/bin/env bash
# Build the unified xyo-cpp runtime (interpreter + LLVM host) and smoke it.
# Reviewable from any directory; all outputs stay in llvm-wasm/.work.
set -euo pipefail
cd "$(dirname "$0")/../../.."
source packages/xyo-cpp-wasm/.work/emsdk/emsdk_env.sh >/dev/null 2>&1
export PATH="$PWD/packages/xyo-cpp-wasm/.work/tools/bin:$PATH"
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
src="$PWD/packages/llvm-wasm/.work/unified-src"
build="$PWD/packages/llvm-wasm/.work/unified-build"
pinned=93c80a4bcc007284cdede0b927ec310145eaa0b5

# browser.cpp and the audio bridge depend on the reviewed xyo-cpp patches, so
# the unified runtime builds from a disposable patched copy of the pinned tree.
if [ ! -d "$src/.git" ]; then
  cp -a packages/xyo-cpp-wasm/.work/xyo-cpp "$src"
fi
if [ "$(git -C "$src" rev-parse HEAD)" != "$pinned" ]; then
  echo "unified source is not the pinned commit: $src" >&2
  exit 1
fi
if [ ! -f "$src/.unified-patched" ]; then
  for p in safe-wasm-runtime wait-bubble-target-lifetime question-id wait-generation-production clone-start-hats segment-table segment-step-hook; do
    git -C "$src" apply "packages/xyo-cpp-wasm/patches/$p.patch"
  done
  touch "$src/.unified-patched"
fi

emcmake cmake -G Ninja -S packages/llvm-wasm/unified -B "$build" \
  -DXYO_SOURCE="$src" -DXYO_BROWSER_SRC="$PWD/packages/xyo-cpp-wasm" \
  -DXYO_ALLOW_PATCHES=ON
taskset -c 0-3,8-11 cmake --build "$build"
sha256sum "$build/unified_runtime.js" "$build/unified_runtime.wasm"
taskset -c 0-3,8-11 node packages/llvm-wasm/unified/smoke.mjs
