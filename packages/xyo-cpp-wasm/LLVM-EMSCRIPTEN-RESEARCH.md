# LLVM 自体を Emscripten Wasm で動かす調査

## 現状（調査時点）

- workspace 内 `.work/emsdk/upstream/emscripten/emcc --version`: Emscripten 6.0.12。`upstream/bin/clang --version`: LLVM 24.0.0git `55ea1f4ebea23d0355d5cdb075f1e12f28ab82d0`、`wasm-ld --version`: LLD 24.0.0 同 revision。`clang --print-targets`: wasm32, wasm64, x86, x86-64。これらは **native host ツール**、LLVM の Wasm artifact ではない。
- `.work/tools/bin/cmake --version`: 4.4.4、同 `ninja --version`: 1.13.2.git.kitware.jobserver-pipe-1。Node 24.22.2。SDK 自体 1.7 GiB。
- workspace の `llvm-project/**/CMakeLists.txt`、`.work/**/llvm/CMakeLists.txt`、`llvm-tblgen`、`llc.wasm`、`llvm-as.wasm` の探索では見つからなかった。workspace 外はサンドボックスの制約で網羅できない。
- `/` の残り容量約 31 GiB、memory available 約 10 GiB、swap 残約 2 GiB（変動する）。LLVM 全体の巨大ビルドは行っていない。必要容量や成功は未測定。

## 設計・実現可能性

1. 小さく始めるなら LLVM IR generator → LLVM `llc` を Wasm 化し LLVM WebAssembly backend で relocatable object → Wasm 化した `wasm-ld` で実行可能 wasm → `WebAssembly.instantiate`。最終成果物に libc 等を使うなら、それらはコンパイラ自身の Emscripten sysroot と別に、生成対象 ABI に一致する sysroot が必要。WASI 対象ならブラウザ側に WASI 実装が必要。stdlib 不使用なら `--no-entry --export=...` の最小モジュールを先に検証する。
2. 最終的には `llc` CLI ではなく LLVM C++ API の IRBuilder/Pass/TargetMachine と LLD library を薄い Emscripten API に組み込めばプロセスや仮想 FS の往復を避けられるが、エクスポート・エラー処理・サイズ・API 同期は追加実装。既存の xyo-cpp Wasm emitter/JIT は使わない。
3. `LLVM_TARGETS_TO_BUILD=WebAssembly` は **生成先 backend の選択**であり、LLVM 自身の実行環境 wasm とは別。最初は LLVM core/IR/optimizer + WebAssembly codegen と LLD Wasm のみ。Clang は IR 入力では不要、C/C++ frontend が必要なとき別段階で `LLVM_ENABLE_PROJECTS=clang;lld` と native `clang-tblgen` を用意する。full clang driver は子プロセス・仮想 FS・resource headers 等の問題があり、単に build 成功では使用可能とならない。LLVM ORC/native JIT を wasm host 上で直接実行できると仮定せず、生成 wasm を JS の WebAssembly engine で実行する。
4. 公開先例 [llvm-wasm](https://github.com/soedirgo/llvm-wasm) は Emscripten 3.1.40 + LLVM 16.0.4 の `llc` と `lld` を Wasm 化し WASI object、libc、browser WASI runtime を接続している。README 冒頭に LLVM 14 との矛盾があり、実際の shell commands は 16.0.4。旧環境の成功事例であり現 SDK 6.0.12 での成功保証ではない。
5. [microbit-clang-wasm package metadata](https://registry.npmjs.org/microbit-clang-wasm/latest) は LLVM 21.1.1 ベースの Clang/LLD/LLVM ツールを Wasm 化した先例だが Cortex-M4 専用、WASI component + Node bundle で Emscripten ではなく、wasm 生成 backend の有無も未確認。ダウンロード・実行検証未実施、採用不可否は不明。

## 段階的な構築レシピ（未実行、要調整）

前提: workspace 内に対応版 llvm-project のソースを別途配置し、ディスクとメモリの余裕を再確認。以下の `$SRC` はその checkout、`$WORK` は新規専用ディレクトリの絶対パス。ネイティブの C/C++ compiler が必要。SDK clang は wasm と x86 を提供するが native Linux headers/linker が sandbox で利用可能か未検証。`emcmake` の source 環境と `.work/tools/bin` は workspace の既存 SDK を使う。バージョンは source と native tblgen を必ず同一 revision にし、SDK との組み合わせは固定して記録する。LLVM source の入手・native toolchain の手当ては未実施。

```sh
# SDK 環境をロードし CMake と Ninja を PATH に追加する。
source "$PWD/packages/xyo-cpp-wasm/.work/emsdk/emsdk_env.sh"
export PATH="$PWD/packages/xyo-cpp-wasm/.work/tools/bin:$PATH"
# SRC と WORK は別途設定。既存ファイルを変更しない専用作業領域を使用。
: "${SRC:?llvm-project checkout required}" "${WORK:?dedicated work directory required}"

# ネイティブ TableGen のみ、フル LLVM ビルドはしない。
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 \
  cmake -G Ninja -S "$SRC/llvm" -B "$WORK/host" \
  -DCMAKE_BUILD_TYPE=Release -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF
 taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 \
  cmake --build "$WORK/host" --target llvm-tblgen

# llc/lld はコマンドごとに独立した JS+Wasm として試す。
# LLVM_TARGET_ARCH および追加フラグは source revision の CMake と照合する。
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 \
  emcmake cmake -G Ninja -S "$SRC/llvm" -B "$WORK/wasm" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_TARGET_ARCH=WebAssembly \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_ENABLE_PROJECTS=lld -DLLVM_TABLEGEN="$WORK/host/bin/llvm-tblgen" \
  -DLLVM_ENABLE_THREADS=OFF -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_PARALLEL_LINK_JOBS=1 \
  '-DCMAKE_EXE_LINKER_FLAGS=-sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1'
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 \
  cmake --build "$WORK/wasm" --target llc lld
```

上記は仮説レシピであって成功実績ではない。先例は `LLVM_TARGET_ARCH=wasm32-emscripten` とし `wait4` workaround、FS/`callMain`、`NO_INVOKE_RUN`、ES module 化、WASI sysroot の preload を追加しており、現行版で必要か検証すること。CMake 構成が `LLVM_TARGET_ARCH` を拒否する等の互換問題が起きれば修正が必要。CLI の再利用・browser 版には実行時設定と Emscripten FS 実装が必要。LLD のバイナリ名 / mode は build 結果を確認し `wasm-ld` として呼ぶか `lld -flavor wasm` を試す。

検証順序: (1) Node で `llc --version` と LLD version (2) 単純 LLVM IR を `llc -mtriple=wasm32-unknown-unknown -filetype=obj` (3) LLD の `--no-entry --export=add` でリンク (4) Node とブラウザで instantiate し add(20,22)=42 (5) virtual FS/API と反復処理・エラーを検証。Wasm compiler 本体・出力サイズ・初期化/コンパイル時間・ピークメモリ・build 容量を測定。先に互換を確認するまで大きな追加 target は作らない。

## 公式資料

- [LLVM CMake: project/target 選択、native TableGen、link 並列制御](https://llvm.org/docs/CMake.html)
- [Emscripten Building Projects: emcmake と build-time generator を host で別ビルド](https://emscripten.org/docs/compiling/Building-Projects.html)
- [LLVM LLD WebAssembly port](https://lld.llvm.org/WebAssembly.html)
- [Emscripten の WebAssembly backend](https://emscripten.org/docs/compiling/WebAssembly.html)
