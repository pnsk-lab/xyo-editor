# xyo-cpp WASM ビルド基盤（旧実験）

**方針変更:** このディレクトリの独自 WASM emitter／インタープリター経路は、現在エディタから使用しません。エディタで `xyo-cpp` を選ぶと LLVM の WebAssembly バックエンドが未完成であることを通知し、標準 VM にフォールバックします。以下は比較・検証のため残している旧実験の説明であり、LLVM の WASM 化や LLVM によるコンパイルを意味しません。新しい方式の調査は [LLVM-EMSCRIPTEN-RESEARCH.md](LLVM-EMSCRIPTEN-RESEARCH.md) を参照してください。

このディレクトリは [xyo-cpp](https://github.com/pnsk-lab/xyo-cpp) のソースを固定し、Node CLI とブラウザ埋め込み向けの WebAssembly をビルドするためのものです。ソース revision は `93c80a4bcc007284cdede0b927ec310145eaa0b5` です。生成物やソースは `.work/` 以下に置き、Git には含めません。

## 前提とビルド

Git、CMake 3.24 以上、ビルドツール（make 等）、Node.js、および Emscripten SDK **6.0.12** が必要です。Emscripten ports の zlib 取得にはネットワークが必要です。SDK をまだ持っていない場合の例:

```sh
git clone https://github.com/emscripten-core/emsdk.git "$HOME/emsdk"
cd "$HOME/emsdk"
./emsdk install 6.0.12
./emsdk activate 6.0.12
source ./emsdk_env.sh
```

リポジトリルートから実行します:

```sh
bash packages/xyo-cpp-wasm/scripts/build.sh
node packages/xyo-cpp-wasm/.work/build-wasm/xyo.js dump /path/to/project.sb3
node packages/xyo-cpp-wasm/.work/build-wasm/xyo.js run /path/to/project.sb3 --frames 120
node packages/xyo-cpp-wasm/tests/upstream_compiled_differential.cjs
node packages/xyo-cpp-wasm/scripts/test-question-id.cjs packages/xyo-cpp-wasm/.work/build-wasm/xyo-browser.js
```

丸め演算の実 WASM 差分試験は `bash packages/xyo-cpp-wasm/scripts/test-safe-round.sh` で実行できます。この試験は固定 revision の独立 checkout とビルドを `.work/` に作成し、検査用に残します。

スクリプトは指定 upstream の固定 commit を checkout し、既存 checkout がその commit でクリーンでない場合は停止します。インタープリター版 CLI と、パッケージ内の限定 WASM コンパイラー、クローンの待機中バブル参照対策、および質問 ID 対策を適用した埋め込み版を別々にビルドし、終了時にパッチを checkout から戻します。生成物は `.work/build-wasm/` に置きます。SDK と upstream を固定しますが、ホストのビルドツール等までは固定していないため、バイト単位の再現性は保証しません。

## 現状と制約

旧実験の埋め込み版は実行状態をスナップショットで表示し、ブラウザがデコードできる音声を WebAudio で再生します。再生中の音量・ピッチ・左右パンの変更に対応します。音声はまずブラウザの `decodeAudioData` を使い、失敗時は Scratch 旧形式のモノラル IMA ADPCM WAV を限定的にデコードします。PCM WAV と ADPCM の再生経路は実 Chrome で検証済みです。その他の形式はブラウザ依存で、不正または未対応の部分ブロックや上限を超える音声は再生できません。WebAudio や StereoPanner が使用できない場合、自動再生が拒否された場合、またはデコードに失敗した場合は再生できません。衝突判定、スプライトのヒットテストは未対応です。

ビルドはヘッドレス用 C ABI を持つ `xyo-browser.js` と `xyo-browser.wasm` も生成し、`node packages/xyo-cpp-wasm/scripts/test-browser.cjs` で SB3 読み込み・旗・ステップ・停止を検証できます。TypeScript の `XyoHeadlessRuntime` はインタープリター実行に加え、明示的にコンパイルモードを選べます。

コンパイルモードは、緑旗時に**一部の直線的な数値処理**を WASM モジュールへ変換して生成します。スクリプト全体が対応範囲の場合に加え、直線的なスクリプト内の対応する数値処理をコンパイルし、前後をインタープリターへ引き継ぐ場合があります。後続部分は旗の時点で生成し、同じステップ中に到達した場合のみ実行します。数値リテラルを使う単一の移動文も、ヘッドレスかつ移動コールバックがないなどの条件下でコンパイルします。ループ、描画、音声、文字列など未対応の処理やコンパイルに失敗したものはインタープリターで実行します。実行前には数値結果を検査し、NaN や無限大が生じる場合も安全のためインタープリターに戻します。共有ブロック、既存の実行キャッシュ、非常に大きなブロックグラフなども安全側にフォールバックします。同一 Runtime で繰り返し旗を押すとキャッシュによりフォールバックする場合があります（エディタでは旗ごとに Worker を再作成します）。この事前検査は演算を重複して行うため、高速化を保証しません。コンパイル件数などの `compileStats` は各インスタンス別ではなくモジュール全体の累積値です。これは全 Scratch プロジェクトをコンパイルする機能ではありません。描画・入力・音声のエディタ接続は未完成です。LLVM ネイティブ JIT も無効です。

## 非 warp repeat の実験的 opt-in

通常ビルドにはこの機能を含めず、エディタの既定動作も変わりません。限定試験用に `XYO_WASM_LOOP_EXPERIMENT=1 bash packages/xyo-cpp-wasm/scripts/build.sh` として別途ビルドすると、生成モジュールが `module._xyo_safe_jit_loop_experiment(1)` を公開します（`module` は Emscripten factory が返したインスタンス）。このビルドは通常と同じ `.work/build-wasm/` を上書きします。**ビルドするだけでは無効**で、この関数による実行時 opt-in が別途必要です。既定構成に戻すには環境変数を外して再ビルドし、Vite を再起動してください。TypeScript の公開 API やエディタからは現在切り替えません。設定は Runtime 単位ではなく、同じ生成 WASM モジュールインスタンスを共有する全 Runtime に作用します。変更は新しい緑旗スクリプトを準備する前に行ってください。

対象は緑旗直下の非 warp `repeat` が終端の単一 `change variable by math_number` を持つ場合に限り、**最初の1反復だけ**を生成 WASM で実行します。ループ制御と2反復目以降はインタープリターです。既存 cache、編集、共有入力、数値条件、CSP 等で拒否した場合もインタープリターへ戻ります。現状の `compileStats` はモジュール全体の累積であり、ループ経路の fallback を完全には数えないため評価指標として不完全です。高速化は未検証で、保証しません。分離ビルドと実 SB3・実 Chromium CSP の試験は `bash packages/xyo-cpp-wasm/scripts/test-loop-feature.sh` で実行できます。

## ライセンス

xyo-cpp 本体は MIT License、Copyright (c) 2026 kicky1618 です。全文と upstream が列挙する第三者コンポーネントに関する注意は [LICENSE.upstream](LICENSE.upstream) を参照してください。upstream にはそれぞれ独自ライセンスの第三者コードが含まれるため、成果物を再配布する際は固定 revision の各ライセンスと Emscripten ports の条件も確認してください。
