#!/usr/bin/env bash
# Standalone integration test; requires Emscripten 6.0.12, CMake and Node.
# Each invocation owns its source and build directories; it never patches the
# checkout or build trees used by build.sh. The directory is retained for audit.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
revision=93c80a4bcc007284cdede0b927ec310145eaa0b5
repository=https://github.com/pnsk-lab/xyo-cpp.git
for tool in git emcc em++ emcmake cmake node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing $tool" >&2; exit 1; }
done
if ! emcc --version | head -n 1 | grep -Eq '(^|[^0-9])6\.0\.12([^0-9]|$)'; then
  echo 'Expected Emscripten 6.0.12.' >&2; exit 1
fi
mkdir -p "$root/.work"
work="$(mktemp -d "$root/.work/safe-round.XXXXXXXX")"
echo "Isolated test directory: $work"
# A local clone copies committed objects only, never the source working tree.
# Fall back to the canonical repository if the local clone is unavailable.
if git -C "$root/.work/xyo-cpp" cat-file -e "$revision^{commit}" 2>/dev/null; then
  repository="$root/.work/xyo-cpp"
fi
git clone --no-hardlinks --no-checkout "$repository" "$work/source"
git -C "$work/source" checkout --detach "$revision"
test "$(git -C "$work/source" rev-parse HEAD)" = "$revision"
test -z "$(git -C "$work/source" status --porcelain --untracked-files=all)"
git -C "$work/source" apply --check "$root/patches/safe-wasm-runtime.patch"
git -C "$work/source" apply "$root/patches/safe-wasm-runtime.patch"
export CMAKE_BUILD_PARALLEL_LEVEL=4
emcmake cmake -S "$work/source" -B "$work/build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-sUSE_ZLIB=1 \
  -DXYO_JIT=OFF -DXYO_SDL2=OFF -DXYO_BUILD_TESTS=OFF -DXYO_BUILD_SHELL=OFF \
  -DXYO_SAFE_WASM_TESTING=ON -DXYO_SAFE_WASM_DIR="$root/src"
cmake --build "$work/build" --target xyo
em++ -std=c++20 -O1 -DXYO_SAFE_WASM_RUNTIME=1 -sUSE_ZLIB=1 \
  -I"$work/source/src" -I"$root/src" "$root/tests/safe_round_test.cpp" \
  "$work/build/libxyo.a" -o "$work/safe-round-test.cjs"
node "$work/safe-round-test.cjs"
# Exercise sequencing, rollback and loop fallback against the same clean build.
em++ -std=c++20 -O1 -DXYO_SAFE_WASM_RUNTIME=1 -sUSE_ZLIB=1 \
  -I"$work/source/src" -I"$root/src" "$root/tests/safe_runtime_test.cpp" \
  "$work/build/libxyo.a" -o "$work/safe-runtime-test.cjs"
node "$work/safe-runtime-test.cjs"
# Capture interpreter loop boundaries for future non-warp compiler integration.
em++ -std=c++20 -O1 -DXYO_SAFE_WASM_RUNTIME=1 -sUSE_ZLIB=1 \
  -I"$work/source/src" -I"$root/src" "$root/tests/loop_checkpoint_probe.cpp" \
  "$work/build/libxyo.a" -o "$work/loop-checkpoint-probe.cjs"
node "$work/loop-checkpoint-probe.cjs"
# Repeated direct hat restarts must release superseded compiled modules.
em++ -std=c++20 -O1 -DXYO_SAFE_WASM_RUNTIME=1 -sUSE_ZLIB=1 \
  -I"$work/source/src" -I"$root/src" "$root/tests/restart_handle_test.cpp" \
  "$work/build/libxyo.a" -o "$work/restart-handle-test.cjs"
node "$work/restart-handle-test.cjs"
