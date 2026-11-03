#!/usr/bin/env bash
# Invoke from repository root with external affinity/parallelism limits.
set -euo pipefail
ROOT="$PWD"
W="$ROOT/packages/xyo-cpp-wasm/.work/llvm19-proof"
A="$W/llvm-project-19.1.7.src.tar.xz"
SRC="$W/llvm-project-19.1.7.src"
mkdir -p "$W"
if [[ ! -f "$A" ]]; then
  curl -fL --retry 2 -o "$A" https://github.com/llvm/llvm-project/releases/download/llvmorg-19.1.7/llvm-project-19.1.7.src.tar.xz
fi
# Matches FreeBSD Ports; official signature is not verified here.
printf '%s  %s\n' '82401fea7b79d0078043f7598b835284d6650a75b93e64b6f761ea7b63097501' "$A" | sha256sum -c -
if [[ ! -d "$SRC" ]]; then tar -xJf "$A" -C "$W"; fi
export PATH="$ROOT/packages/xyo-cpp-wasm/.work/tools/bin:$PATH"
cmake -G Ninja -S "$SRC/llvm" -B "$W/host" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF
cmake --build "$W/host" --target llvm-tblgen
