#!/usr/bin/env bash
# Run against an already-built *isolated* package copy, not the product build.
# Emscripten 6.0.12 and Node must be on PATH. The copy's source is patched
# temporarily to match its safe runtime library and restored on exit.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
isolated="${1:?pass the absolute path of an independently built package copy}"
isolated="$(cd "$isolated" && pwd)"
if [ "$root" = "$isolated" ]; then echo 'Refusing to modify the product checkout' >&2; exit 1; fi
src="$isolated/.work/xyo-cpp"
lib="$isolated/.work/build-browser-safe/libxyo.a"
if [ -n "$(git -C "$src" status --porcelain --untracked-files=all)" ]; then
  echo "Isolated source checkout is not clean: $src" >&2; exit 1
fi
patches=( "$root/patches/safe-wasm-runtime.patch" "$root/patches/wait-bubble-target-lifetime.patch" "$root/patches/question-id.patch" "$root/patches/wait-generation-production.patch" )
applied=0
cleanup() { for ((n=applied-1; n>=0; --n)); do git -C "$src" apply --reverse "${patches[n]}" || return 1; done; }
trap cleanup EXIT
for p in "${patches[@]}"; do
  git -C "$src" apply --check "$p"
  git -C "$src" apply "$p"
  ((applied+=1))
done
em++ -std=c++20 -O1 -fno-exceptions -fno-rtti -DXYO_SAFE_WASM_RUNTIME=1 -DXYO_WAIT_GENERATIONS=1 \
  -I"$src/src" -I"$root/src" -I"$root" \
  "$root/tests/browser_async_sound_abi_test.cpp" "$root/browser.cpp" "$root/src/renderer_bridge.cpp" \
  "$root/src/browser_async_sound.cpp" "$root/src/async_sound_bank.cpp" "$lib" \
  -sUSE_ZLIB=1 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=5242880 -o "$isolated/.work/browser-async-sound-abi-test.cjs"
node "$isolated/.work/browser-async-sound-abi-test.cjs"
node "$root/scripts/test-question-id.cjs" "$isolated/.work/build-wasm/xyo-browser.js"
node "$root/scripts/test-async-exports.cjs" "$isolated/.work/build-wasm/xyo-browser.js"
