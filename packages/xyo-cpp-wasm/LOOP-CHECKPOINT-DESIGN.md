# 非 warp loop の WASM 化: 同期点の設計案

2026-11 実験: 次の広い案のうち、旗直下の `repeat` が終端の単一 `change variable by math_number` を持つ場合の **最初の1反復だけ**を実装した。`XYO_SAFE_WASM_LOOP_EXPERIMENT` でビルドし、既定 off の `xyo_safe_jit_loop_experiment(1)` を明示的に呼んだ場合のみ動作する。`XYO_SAFE_JIT_TESTING` は不要。通常製品ビルドには組み込まず、無効のまま。初回 step の終了時に module を破棄するため、2反復目以降は必ず interpreter。loop 制御・残回数判定も常に interpreter。以降は広い将来案を含み、一般の直鎖・複数反復の実装済みを意味しない。

## 根拠と対象

upstream `src/engine/sequencer.cpp` の `stepThreadBound` は `execute` 直後に `blockGlowInFrame` を更新し、次ブロックへ進め、空の子を pop した後、親 `isLoop` が非 warp なら **status RUNNING のまま return** する。次の呼び出しは残った親 loop を再実行する。`src/blocks/core.cpp` の `ctlRepeat` は毎回 TIMES を評価した上で親 `ExecContext` の `hasLoopCounter/loopCounter` を初期化・減算し branch を開始する。したがって親フレームも反復間の意味論であり、回数を WASM 内でまとめて消費してはならない。`stepThreads` は時間予算・redraw と他スレッドの順序を管理するため、境界は描画フレームそのものではなく scheduler pass の実行機会である。

第一段階は **非 warp の repeat 本体が有限・直鎖・非空の既存 safe 数値部分集合のみ**、nest/procedure/yield/副作用・可変 reporter は拒否。ループ条件・counter の処理は interpreter に任せる。空 branch、loop 完了・0 回・複雑な本体は従来どおり。繰り返し入力は再評価されるので、条件を一度だけ算出する実装は禁止。

## upstream hook 案

`stepThreadBound` 内で `execute` が loop の `startBranch` により子フレームを積み、その子が本体先頭であることを確認した直後、通常の status 処理と stack unwind と整合させてオプトイン hook を試みる。これは設計案であり、実装時には loop `execute` の後の glow 設定と status 分岐の**順序を実コードに合わせる**こと。`minDepth != 0`、warp、stackClick/updateMonitor、reporter 中断、想定外 frame/target/container は拒否。既存のスレッド先頭専用 `tryRunSafeFlag` を呼ぶだけでは stack depth == 1 等の前提に反するため再利用できない。

hook は非空の直鎖本体の **一反復のみ**を staging slots 上で実行、成功したら変数を commit し interpreter 相当の各 block cache/glow とフレーム遷移を再現、子を終端の空 ID に進める。共通 unwind が子を pop して親 loop で return する構造が望ましい。親の `isLoop` と `executionContext` を維持し、親の `goToNextBlock`/reset をしない。最終 body block ID が `blockGlowInFrame`、`requestScriptGlowInFrame` は `forceNoGlow` に従う。`justReported`、`trashFrames`、`reuseStackForNextBlock` は実 interpreter の各段階と同一にする必要があり、最後の一括 reset が同値とは未証明。完了時はそのまま interpreter が次の loop 判定を行う。

commit 前の CSP 拒否、trap、数値/tag/finite/エイリアス/validation 不成立は **実変数と thread を変更せず** body 先頭から interpreter で実行。先に cache を生成すると失敗が観測可能な状態を書き換えるため、検証を先に行い、cache 構築の部分失敗を含むトランザクション境界を明示・試験する。成功 commit 後にフォールバックして同反復を再実行しない。次パスで他スレッドが変数を変更し得るため slots は毎回読み直す。stop/restart/編集時の module 解放と stale graph、primitive replacement、execute/input cache、reporter alias の再検証は既存 safe runtime 相当以上を要求する。

## 実証と未検証

テスト用マクロなしで feature を含む隔離 WASM をビルドし、`tests/loop_nontest_wasm_test.cpp` で実 SB3 の逐 step 差分（独立 peer による初回前の書換、負数・非正規数、既存 cache、編集、再旗・停止）を確認。Brave/Chromium ではホスト WASM 初期化後に CSP を適用して、動的 WASM 生成の許可・拒否双方を試験した。拒否時は生成失敗から interpreter へ復帰する。これは当該狭い形の検証であり、一般のループや未知の外部状態を証明しない。

`tests/loop_checkpoint_probe.cpp` は safe compiler 無効の実 upstream interpreter を直接 step し、repeat 2 回の各 return で stack=loop、status RUNNING、counter 1→0、body glow、変数 1→2、次 step で after 実行と DONE を確認する。例: `scripts/test-safe-round.sh` が作る isolated source/build を使い、同スクリプトの em++ リンク方法でこのファイルを指定して Node 実行。これは **同期点の oracle のみ**で、提案 hook や WASM との同値性を証明しない。

実装前に必要: 複数スレッドの各 pass ごとの可視値と順序、空 body、0/負/非有限回、動的 TIMES、nested loop、glow on/off、待機/停止、変更された graph/primitive/cache、trap と commit 直前失敗、各境界の stack/frame/reporters と値ビット完全比較。失敗注入後の重複実行防止と stop/restart の handle lifetime も要検証。すべて通るまでこの新経路は無効のまま。
