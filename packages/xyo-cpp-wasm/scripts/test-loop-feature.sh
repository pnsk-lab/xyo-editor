#!/usr/bin/env bash
# Isolated production-code loop feature test; never changes the product build.
# Requires Emscripten 6.0.12, CMake, Node, Python and local playwright-core.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
revision=93c80a4bcc007284cdede0b927ec310145eaa0b5
repo="$root/.work/xyo-cpp"
for tool in git em++ emcmake cmake node python3; do
  command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }
done
git -C "$repo" cat-file -e "$revision^{commit}"
work="$(mktemp -d "$root/.work/loop-feature.XXXXXXXX")"
echo "Isolated test directory: $work"
git clone -q --no-hardlinks --no-checkout "$repo" "$work/source"
git -C "$work/source" checkout -q --detach "$revision"
git -C "$work/source" apply --check "$root/patches/safe-wasm-runtime.patch"
git -C "$work/source" apply "$root/patches/safe-wasm-runtime.patch"
emcmake cmake -S "$work/source" -B "$work/build" \
  -DCMAKE_BUILD_TYPE=Release \
  '-DCMAKE_CXX_FLAGS=-sUSE_ZLIB=1 -DXYO_SAFE_WASM_LOOP_EXPERIMENT=1' \
  -DXYO_JIT=OFF -DXYO_SDL2=OFF -DXYO_BUILD_TESTS=OFF -DXYO_BUILD_SHELL=OFF \
  -DXYO_SAFE_WASM_TESTING=OFF -DXYO_SAFE_WASM_DIR="$root/src"
cmake --build "$work/build" --target xyo
python3 - "$root/tests/loop_fixture_project.json" "$work/loop.sb3" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write(sys.argv[1], 'project.json')
PY
common=(-std=c++20 -O1 -DXYO_SAFE_WASM_RUNTIME=1 -DXYO_SAFE_WASM_LOOP_EXPERIMENT=1
  -sUSE_ZLIB=1 -I"$work/source/src" -I"$root/src"
  "$root/tests/loop_nontest_wasm_test.cpp" "$work/build/libxyo.a"
  --embed-file "$work/loop.sb3@/loop.sb3")
em++ "${common[@]}" -o "$work/nontest.cjs"
node "$work/nontest.cjs"
em++ "${common[@]}" -sMODULARIZE=1 -sEXPORT_NAME=createLoopTest \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 '-sEXPORTED_RUNTIME_METHODS=["callMain"]' \
  -sENVIRONMENT=web -o "$work/browser-loop.js"
# Run from the workspace root so the locally installed playwright-core resolves.
workspace="$(cd "$root/../.." && pwd)"
(cd "$workspace" && node "$root/tests/loop_csp_browser_test.cjs" "$work")
