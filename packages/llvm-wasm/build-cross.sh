#!/usr/bin/env bash
# Invoke from the repository root; resource limits are inherited from the caller.
set -euo pipefail
ROOT="$PWD"
W="$ROOT/packages/xyo-cpp-wasm/.work/llvm19-proof"
SRC="$W/llvm-project-19.1.7.src/llvm"
export PATH="$ROOT/packages/xyo-cpp-wasm/.work/tools/bin:$PATH"
# The existing SDK's environment script isn't compatible with nounset.
set +u
source "$ROOT/packages/xyo-cpp-wasm/.work/emsdk/emsdk_env.sh"
set -u
[[ -x "$W/host/bin/llvm-tblgen" ]] || { echo 'native llvm-tblgen missing' >&2; exit 1; }
df -h "$W"
du -sh "$W"
emcmake cmake -G Ninja -S "$SRC" -B "$W/wasm" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_TARGET_ARCH=wasm32-unknown-emscripten -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_TABLEGEN="$W/host/bin/llvm-tblgen" \
  -DLLVM_ENABLE_THREADS=OFF -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_PARALLEL_LINK_JOBS=1 \
  '-DCMAKE_EXE_LINKER_FLAGS=-sALLOW_MEMORY_GROWTH=1 -sNODERAWFS=1 -sENVIRONMENT=node'
cmake --build "$W/wasm" --target llc
du -sh "$W"
# Parent package is type:module, but the node-only Emscripten output is CommonJS.
[[ -e "$W/wasm/bin/package.json" ]] || printf '%s\n' '{"type":"commonjs"}' > "$W/wasm/bin/package.json"
node "$W/wasm/bin/llc.js" -mtriple=wasm32-unknown-unknown -filetype=obj \
  "$ROOT/packages/llvm-wasm/add.ll" -o "$W/add.o"
# Native linker is only used after the Wasm-hosted LLVM has generated add.o.
"$ROOT/packages/xyo-cpp-wasm/.work/emsdk/upstream/bin/wasm-ld" \
  --no-entry --export=add "$W/add.o" -o "$W/add.wasm"
node "$ROOT/packages/llvm-wasm/verify-object.mjs" "$W/add.o" "$W/add.wasm"
