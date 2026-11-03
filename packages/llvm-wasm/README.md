# LLVM Wasm llc proof

実験対象は LLVM 19.1.7 と Emscripten 6.0.12。

## 検証結果と範囲

- **Node proof:** NODERAWFS の Wasm 版 llc → 182-byte object → Wasm 版 LLD → 最終 Wasm → `add(20,22)=42`。native linker はこの二段 proof に不使用。別 IR では `--import-memory` で Node 側の `WebAssembly.Memory` を 41→42 に更新した。先行する llc 単体確認では native SDK wasm-ld を補助使用した。
- **Brave Worker proof:** llc Wasm の IR→object 2種、relocation、version stdout と error status を確認。加えて単一 Worker 内で、別 instance の llc と LLD を MEMFS 経由で接続し、182-byte object → 189-byte 最終 module → `add(20,22)=42` を確認。native linker は不使用。
- **未検証:** 実 xyo runtime との接続、共有 memory を含む実 ABI・GC、安全な反復再入、任意エラー出力の完全性、ネイティブ xyo JIT との API 統合。Node の単純な memory テストはそれらの証明ではない。

LLVM [公式 release archive](https://github.com/llvm/llvm-project/releases/tag/llvmorg-19.1.7) のサイズは 141249332 bytes、実測 SHA-256 は `82401fea7b79d0078043f7598b835284d6650a75b93e64b6f761ea7b63097501`。[FreeBSD Ports](https://www.freshports.org/devel/llvm19/) 等の第三者 checksum とは一致。公式 GitHub release API は digest が null で、公式署名の検証は行っていない。SDK Emscripten 6.0.12 (5488e0871d46d19a3209988190fa6a653126256f)、host clang 24.0.0git 55ea1f4ebea23d0355d5cdb075f1e12f28ab82d0、CMake 4.4.4、Ninja 1.13.2。

作業領域は `packages/xyo-cpp-wasm/.work/llvm19-proof`。大規模な build は実行プロセス全体を `taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4` 以下で実行する。コード・検証は [add.ll](add.ll) と [verify-object.mjs](verify-object.mjs)。再現は既存 SDK と native C/C++ compiler を用い repository root で次を順に実行する。容量・既存作業環境を確認し、必要に応じ affinity は環境に合わせる。現行 build 使用量は archive/source 含め約 2.4 GiB。

```sh
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 bash packages/llvm-wasm/prepare-host.sh
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 bash packages/llvm-wasm/build-cross.sh
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 bash packages/llvm-wasm/build-lld.sh
```

Node proof の JS は CommonJS、親 package は ESM のため build output に新規 `package.json` (`type: commonjs`) を作る。`llc --version` は現構成で stdout が空、exit code は0（原因未確定）。存在しない IR の診断は stderr と exit code 1 が確認されている。browser 用は `MEMFS` / `callMain` を使い、コンパイラとリンカは別 instance。各 instance の反復再入や xyo 側の統合、任意エラーの出力 flush は別途検証が必要。

## Brave Worker 二段 proof

上記 Node 用ビルドを先に済ませ、Brave と Node を用意して repository root で実行する。各 relink は Wasm 版の既存 archive を読み、別の出力先に生成する。`BROWSER` 環境変数で Brave 実行ファイルを変更できる。

```sh
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 python3 packages/llvm-wasm/relink-llvm19-browser-proof.py
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 python3 packages/llvm-wasm/relink-lld-browser.py
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 node packages/llvm-wasm/test-full-browser-worker.mjs
```

`relink-lld-browser.py` は既存 Ninja build graph の lld リンク行を取得し、出力先と Emscripten 設定のみ変更する。compiler/linker artifact を browser の独立 MEMFS にロードし、`-flavor wasm` で LLD を実行する。**現行スクリプトは固定出力先に JS と Wasm を個別に書くため、稼働中の consumer と同時に relink してはならない**。完成を待ってから試験すること。本番配布では immutable な version directory と原子的な manifest 切替等により両ファイルの組を公開する必要がある。
