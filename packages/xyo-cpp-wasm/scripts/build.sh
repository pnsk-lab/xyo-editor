#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
revision=93c80a4bcc007284cdede0b927ec310145eaa0b5
repository=https://github.com/pnsk-lab/xyo-cpp.git
source_dir="$root/.work/xyo-cpp"
build_dir="$root/.work/build-wasm"

for tool in git emcc emcmake cmake; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing $tool; activate Emscripten 6.0.12 and install CMake >= 3.24." >&2
    exit 1
  fi
done
if ! emcc --version | head -n 1 | grep -Eq '(^|[^0-9])6\.0\.12([^0-9]|$)'; then
  echo 'Expected Emscripten 6.0.12; activate the pinned SDK before building.' >&2
  exit 1
fi
mkdir -p "$root/.work"
if [ ! -e "$source_dir" ]; then
  git clone --no-checkout "$repository" "$source_dir"
  git -C "$source_dir" checkout --detach "$revision"
fi
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ] ||
   [ -n "$(git -C "$source_dir" status --porcelain --untracked-files=all)" ]; then
  echo "Source checkout must be clean and at $revision: $source_dir" >&2
  exit 1
fi
emcmake cmake -S "$source_dir" -B "$build_dir" \
  -DCMAKE_TOOLCHAIN_FILE="$source_dir/cmake/emscripten.cmake" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-sUSE_ZLIB=1 \
  -DXYO_JIT=OFF -DXYO_WASM_JIT=OFF -DXYO_SAFE_WASM_DIR= \
  -DXYO_SDL2=OFF -DXYO_BUILD_TESTS=OFF -DXYO_BUILD_SHELL=ON
cmake --build "$build_dir" --target xyo-cli
# The CLI above remains an upstream interpreter. The embedded runtime also
# clears timed-bubble references when a clone is deleted and identifies queued
# questions. Apply all patches atomically and reverse them on exit, including errors.
patch="$root/patches/safe-wasm-runtime.patch"
lifetime_patch="$root/patches/wait-bubble-target-lifetime.patch"
question_patch="$root/patches/question-id.patch"
wait_patch="$root/patches/wait-generation-production.patch"
patches=( "$patch" "$lifetime_patch" "$question_patch" "$wait_patch" )
applied=0
cleanup_patch() {
  local n
  for ((n=applied-1; n>=0; --n)); do
    if ! git -C "$source_dir" apply --reverse "${patches[n]}"; then
      echo "Could not reverse ${patches[n]}; inspect $source_dir manually." >&2
      return 1
    fi
  done
}
trap cleanup_patch EXIT
for p in "${patches[@]}"; do
  git -C "$source_dir" apply --check "$p"
  git -C "$source_dir" apply "$p"
  ((applied+=1))
done
safe_build_dir="$root/.work/build-browser-safe"
safe_cxx_flags='-sUSE_ZLIB=1 -DXYO_WAIT_GENERATIONS=1'
loop_flag=()
loop_export=''
if [ "${XYO_WASM_LOOP_EXPERIMENT:-0}" = 1 ]; then
  safe_cxx_flags+=' -DXYO_SAFE_WASM_LOOP_EXPERIMENT=1'
  loop_flag=(-DXYO_SAFE_WASM_LOOP_EXPERIMENT=1)
  loop_export=',_xyo_safe_jit_loop_experiment'
fi
emcmake cmake -S "$source_dir" -B "$safe_build_dir" \
  -DCMAKE_TOOLCHAIN_FILE="$source_dir/cmake/emscripten.cmake" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="$safe_cxx_flags" \
  -DXYO_JIT=OFF -DXYO_WASM_JIT=OFF -DXYO_SAFE_WASM_DIR="$root/src" \
  -DXYO_SAFE_WASM_TESTING=OFF -DXYO_SDL2=OFF -DXYO_BUILD_TESTS=OFF -DXYO_BUILD_SHELL=OFF
cmake --build "$safe_build_dir" --target xyo
# browser.cpp includes Runtime/Thread types: match xyo's PUBLIC ABI definition.
common=( -std=c++20 -O3 -fno-exceptions -fno-rtti -DXYO_SAFE_WASM_RUNTIME=1 -DXYO_WAIT_GENERATIONS=1 "${loop_flag[@]}"
  -I"$source_dir/src" -I"$root/src" "$root/browser.cpp" "$root/src/renderer_bridge.cpp" "$root/src/async_sound_bank.cpp" "$root/src/browser_async_sound.cpp" "$safe_build_dir/libxyo.a"
  -sUSE_ZLIB=1 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=5242880
  -sMODULARIZE=1 -sEXPORT_NAME=createXyoBrowser
  -sEXPORTED_FUNCTIONS=_malloc,_free,_xyo_browser_create,_xyo_browser_destroy,_xyo_browser_load_sb3,_xyo_browser_green_flag,_xyo_browser_stop,_xyo_browser_step,_xyo_browser_key,_xyo_browser_mouse,_xyo_browser_wheel,_xyo_browser_answer,_xyo_browser_answer_if_question,_xyo_browser_audio_open,_xyo_browser_audio_session_generation,_xyo_browser_audio_close,_xyo_browser_audio_detach,_xyo_browser_audio_tick,_xyo_browser_audio_failed,_xyo_browser_audio_kind,_xyo_browser_audio_generation,_xyo_browser_audio_id_lo,_xyo_browser_audio_id_hi,_xyo_browser_audio_bytes,_xyo_browser_audio_bytes_size,_xyo_browser_audio_format,_xyo_browser_audio_target,_xyo_browser_audio_volume,_xyo_browser_audio_pitch,_xyo_browser_audio_pan,_xyo_browser_audio_pop,_xyo_browser_audio_complete,_xyo_browser_audio_stop_ack,_xyo_browser_audio_close_ack,_xyo_browser_renderer_attach,_xyo_browser_renderer_detach,_xyo_browser_snapshot,_xyo_browser_error,_xyo_browser_capabilities,_xyo_browser_set_compiled,_xyo_browser_compiled_enabled,_xyo_browser_compile_attempts,_xyo_browser_compile_successes,_xyo_browser_compiled_executions,_xyo_browser_compile_fallbacks,_xyo_browser_compiled_live_modules${loop_export} )
# Retain the existing CommonJS/browser-global distribution and its WASM name.
em++ "${common[@]}" -sENVIRONMENT=web,node \
  -sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8 -o "$build_dir/xyo-browser.js"
# Vite consumes a separate ESM factory and a separately emitted WASM asset.
# The table must be growable for renderer callback registration via addFunction.
em++ "${common[@]}" -sENVIRONMENT=web,worker,node -sEXPORT_ES6=1 \
  -sALLOW_TABLE_GROWTH=1 -sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8,addFunction,removeFunction \
  -o "$build_dir/xyo-browser-esm.mjs"
# Emscripten emits CommonJS, while the enclosing repository uses ES modules.
printf '{"type":"commonjs"}\n' > "$build_dir/package.json"
