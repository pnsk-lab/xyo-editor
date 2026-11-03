# ブラウザ内 LLVM と xyo native codegen の統合設計（未検証）

## 範囲と結論

対象 upstream は `packages/xyo-cpp-wasm/.work/xyo-cpp` commit `93c80a4bcc007284cdede0b927ec310145eaa0b5`。この文書はソース読解に基づく提案であり、xyo + LLVM の Emscripten リンク、project→IR/object、ブラウザでの実行はいずれも未検証。既存 `src/wasm` や独自 safe emitter を使わず、LLVM 自体を Wasm 化し `src/jit/codegen.cpp` の `jitEmitScript` を使う。native ORC をブラウザで動かす設計ではない。Wasm linear memory に native 機械語を書いて実行することもできない。

現実的な最初の縦断は **制約付き project→LLVM IR→relocatable Wasm object のブラウザ内生成と検査**。実行まで含めるには別途 Wasm リンカ、共有メモリ・table・helper 解決・slot 初期化・スケジューラ統合の証明が必要で、object は `WebAssembly.instantiate` 可能な完成モジュールではない。以下の実行段階も設計するが完了扱いにしない。

## upstream の具体的な経路

- `src/load/sb3.hpp` の `loadSb3File(Runtime&, const uint8_t*, size_t)` が sb3 からモデルをロード。`src/aot/aot.cpp:194-255` は `Runtime::targets` の original target と `Blocks::getScripts()` を列挙し、`AotEmit::targetIndex` を設定、各 top id に `jitEmitScript(Module&, LLVMContext&, Runtime&, Target*, Blocks*, const string& top, const string& entry, CompiledScript&, JitPinned&, vector<string>& pending, map<string,string>& procs, AotEmit*)` を呼ぶ。
- `codegen.cpp:3779-3888` は hat を除く body を `scanChain`、`void entry(JitCtx*)` と procedures を IR に生成し、未対応は false、`CompiledScript::mayYield` / `mainThread` と proc 名を返す。`AotEmit*` 非 null が必須。失敗時も module が部分変更され得るので **script ごとに別 Module と別 AotEmit を所有し、失敗・yield・verify エラーは丸ごと破棄**。upstream `compileProject` の失敗時 `continue` を安全な rollback とみなさない。
- AOT 実装は process triple と host CPU、`InitializeNativeTarget` を使うためそのまま cross target に使えない。`TargetRegistry::lookupTarget`→WebAssembly `TargetMachine`→`Module::setTargetTriple`/`setDataLayout(tm->createDataLayout())`→`verifyModule`→任意の `PassBuilder` O2→`legacy::PassManager` と `addPassesToEmitFile(... ObjectFile)` を専用 wrapper で再構成する。IR テキストは `Module::print`、object は `raw_svector_ostream` から所有バイト列として返す。診断・拒否理由も返す。最初は O0 で ABI を検証し O2 はその後。
- metadata は AOT の `buildMeta` が `hash`, script top/ti/entry/mayYield/mainThread/procs、slot kind/global/key を記録。関数は匿名 namespace なので抽出・共通化または互換シリアライズが必要。hash は同実装の FNV-1a（認証用途ではない）。script 毎生成なら symbol 命名衝突と module ごとの slot 番号スコープを必ず分離。

## wasm32 ABI: 実装前の阻止条件

LLVM コンパイラ自身の実行 ABI と生成対象 ABI は別物。xyo compiler と runtime は **同じ Emscripten SDK・設定・wasm32 ABI** でビルドし、生成 target triple は runtime に合わせて `wasm32-unknown-emscripten` を候補として明示、CPU/features、PIC、例外、atomics/shared-memory、function-table、SIMD を一貫させる。`wasm32-unknown-unknown` を現在の llc proof が使うことは Emscripten runtime ABI 互換の証拠ではない。実際の TargetMachine DataLayout と emcc が出す IR の triple/layout を比較する。32 bit pointer と 64 bit `Value` は別物。

`codegen.cpp:435-436` は `ctxPtr` で i64 GEP を使い JitCtx の先頭ポインタ列を 8 bytes stride と仮定する。wasm32 では誤読する。別途用意された `packages/xyo-cpp-wasm/patches/llvm-context-pointer-stride.patch` は pointer 型 GEP を提案し、`packages/xyo-cpp-wasm/tests/llvm_ctx_stride_test.py` は等価 IR の native/wasm32 正例と旧 i64 GEP の wasm32 負例を検査する（親エージェント報告）。これは **実際の jitEmitScript、LLVM Wasm、他の ABI を検証しない**。この patch は upstream 自体への編集ではなく、将来の disposable checkout への適用候補。

さらに `offsetof(JitCtx, ...)`, `offsetof(Variable, value/list)`, `sizeof/offsetof(SStr)`, `offsetof(SList, ...)` と `Codegen::ly()` の実 object からの member offset は **compiler をビルドした C++ ABI の値**。compiler/runtime が別ビルドなら設定差で静かに破壊される。対象 wasm32 compiler で算出し runtime と同一構成に固定、sizeof/alignof/offset と feature/version の ABI fingerprint を両側で出し、異なる場合は実行拒否。各 GEP、pointer 整数化、アラインメント、呼出規約・i64 JS 境界も監査する。native 側で IR を作り target DataLayout のみ変える方式は使わない。`Value` は i64 NaN box、文字列は下位 48 bit pointer payload（`core/value.hpp`）；wasm32 の i32 pointer 拡張/切詰め、タグ mask、null と GC を検証する。DataLayout を合わせるだけでは `offsetof` や C++ ABI は直らない。

## AOT slots、メモリ、GC、relocation

`jit/aot_emit.hpp` の `AotEmit::slot` は (kind,key) を dedup し `xyo_aot_slot_N` を生成。`codegen.cpp:455-500` は pointer を slot global の load、文字列は slot pointer の i64 化と tag OR に変える。種類は VarId、Name、BlockCached（target index + `\x01` + block id）、StrLit（UTF-16 raw bytes）、AsciiCache、MovedHook、GpuProgram。AOT 時は GPU/par-for の扱いをコード実体で確認し、slice は GPU・parallel・MovedHook を禁止して明示エラー、または組込み Scratch VM へ実行前に切り替える。旧 xyo Wasm 実験経路への fallback はしない。slot にすることと絶対アドレスが一切残らないことは同義ではない。`cptr`、inttoptr、関数 pointer、inline cache、external globals と emitted IR/object の全 relocation を監査し、許可外は拒否する。

native `JitEngine::loadAot` は ORC `addObjectFile` と symbol lookup によりメタ・slot・entry を解決し、`Gc::addRootProvider` を slot の充填前に登録して `StrLit` の `SStr::create` 中にも GC 安全にする。VarId/Name の文字列保持、BlockCached の target ごとの再解決、AsciiCache、hook、procs、hash チェックと寿命が必要。これをブラウザでそのまま呼ぶのではなく意味論を再実装/共通化する。root は module instance・参照 script より長く保持し、実行中の無効化は禁止、終了後に cache/slot/root を順序よく解放。失敗時にも部分登録を rollback する。

実行候補は Emscripten dynamic linking 互換の side module をブラウザ内 Wasm 化 LLD で作り、runtime の **同一 WebAssembly.Memory と適切な table** を共有して loader が data/table relocation、未定義 helper、slot address と entry を解決する方式。実際の SIDE_MODULE/MAIN_MODULE と dlopen 互換性、動的 table 増加、対象 feature、async instantiate、JS CSP、メモリ grow 後の view 更新は未検証。別 Memory では `JitCtx*`、SStr/Variable/slot は相互参照できない。Wasm の関数 pointer は linear memory 上のコードアドレスではなく table index/型付き間接呼出であり、native `void*` と扱いを同一視しない。entry を native `ScriptFn` に cast できると仮定せず Emscripten loader/table ABI を証明する。`xyo_*` helper（`jit.cpp` の `kRtSymbols`、`rt.cpp`/`rt_blocks.cpp` 等）と `xyo_list_limit` 等の data symbol を exact signature で export/resolve し、未解決は拒否。単純な `--no-entry --export=...` は relocation や実行時シンボル解決を提供しない。sandbox はメモリ安全性の証明でもない。

## no-yield の安全な slice と実装順

1. **環境固定**: LLVM 19.1.7/Emscripten 6.0.12 は現 proof の候補であり xyo 互換未証明。native `llvm-tblgen` を用いた cross build を固定し、compiler と runtime を同設定にする。高負荷コマンドは必ず `taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 ...`。`packages/llvm-wasm/build-cross.sh` は Node 用 llc と native wasm-ld の proof であり browser linker の証拠ではない。
2. **ビルド分離**: upstream CMake は `XYO_JIT=ON` で `src/jit/*.cpp` と `aot.cpp` を丸ごと入れ `core orcjit native passes`、`OFF` は `nojit_stub.cpp` を使う。Emscripten で ON にするだけでは ORC、native target、fiber 等を巻き込む。別 adapter target で `codegen.cpp` と必要な xyo core/model/load/engine/rt、`parfor`/GPU・pen の参照依存を実際の未解決シンボルから整理し、`nojit_stub` と重複定義させない。`find_package(LLVM CONFIG)` は必ず Wasm 向け LLVM build の config/imported archive を指す（host llvm-config の system libs 探索を禁止）。LLVM components 候補は `core`, `support`, `analysis`, `transformutils`, `passes`, `target`, `mc`, `codegen`, `asmprinter`, `webassemblycodegen`, `webassemblydesc`, `webassemblyinfo`、必要なら `webassemblyasmparser`、`object`, `bitwriter`。`llvm_map_components_to_libnames` で transitive dependencies を解決し、実際の LLVM version で component 名・リンク順・必要性を確認する。ORC/native は対象外。ターゲット登録は `LLVMInitializeWebAssemblyTargetInfo/Target/TargetMC/AsmPrinter` を明示（バージョン別宣言確認）。Emscripten zlib port、C++ runtime、RTTI/exceptions 設定・LLVM ABI を整合。
3. **compiler wrapper**: sb3 bytes を `loadSb3File`、対象一 script だけ AOT mode で emit、`cs.mayYield == false` に加えて最初は **静的 allowlist**（緑旗 hat + 有限の直線的な数値定数の変数 set/change、算術のみ）を再帰的に検査。手続き、ループ、compat/reporter、wait、音/描画、GPU、未知 opcode は事前拒否。`helperMayYield` の一覧漏れ・間接 helper を mayYield false だけでは証明できない。emit 後にも reachable call graph を閉世界 allowlist 検証し、外部 helper の型・副作用・yield 非到達を監査、拒否時は実行前にエラーを返すか組込み Scratch VM を選択し、旧 xyo Wasm 経路には戻さない。未対応 block を途中実行後に fallback しない。IR 検証と wasm object 出力を行い、script/target/hash/layout/slot metadata と byte 列を worker に返す。
4. **object 証明**: IR が意図した wasm32 layout、expected `void(ptr)`、slot globals と helper declarations を持つことを検査。object の linking/reloc sections、undefined symbols、feature、pointer relocation を確認。文字列・複数 target 同一 block id・部分 emit 失敗・malformed sb3・無限大/NaN・ABI 不一致の拒否テスト。CPU 制限下で再現可能なログを残す。
5. **実行は次のゲート**: Wasm LLD と dynamic loader の組合せで共有 memory/table、relocation、helper と slot 解決、GC stress、実行停止時の保持を個別に検証後にのみ実施。`Sequencer::jitStepThread` は `mayYield=false` なら fiber=null、`cs->entry(c)` を同期実行し DONE にするが、既存の native function pointer/cache と Wasm instance bridge をどう接続するかは未実装。instance 呼出成功・処理結果を組込み Scratch VM と比較してから将来の独立 runtime の scheduler cache へ原子的に公開する。旧 xyo Wasm emitter/runtime を流用しない。project 更新・対象編集・キャンセルで compile 中の stale 結果を捨て、稼働中 instance は安全に退役させる。
6. **負例と運用**: yield 可能な loops/wait/再帰、unknown helper、slot 不一致、hash/ABI 不一致、link/instantiate failure は実行前にエラーとするか組込み Scratch VM を選択する。静的に有限でも巨大な直線 script は実行時間を保証しないためサイズ/入力制限と Worker 隔離を設け、停止は worker 終了による runtime ごとの破棄として扱う（部分副作用の巻き戻しはできない）。no-yield は応答性や安全な無限ループ中断を意味しない。

## 未解決・検証状況

この文書作成時にビルド・ブラウザ実行・実 sb3 の LLVM emit を行っていない。LLVM Wasm 本体/LLD の容量、Emscripten target machine の PIC/reloc feature、shared memory/table でのロード可能性、全 helper C ABI、GC root と cache の寿命、CMake archive の完全な依存集合、wasm32 の全 offset/Value 操作、no-yield 解析の網羅性は検証必須。実行方式が成立しなければ object 出力のみで止め、native ORC や独自 emitter にすり替えない。
