# scratch-paint 差分マトリクス

利用者向けの機能別差分表。参照動作（scratch-paint）・現行動作・具体的な差・状態・根拠を示す。
詳細な経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md) を参照。本表はコードと既存レポートの静的比較であり、動作試験をしていない項目は「未確認」とする。断定的な判断は避け、根拠不明は「未確認」と記す。

> 注意: 作業ツリーには多数の未コミット変更がある（`git status` で `packages/editor/src/features/costumes/*` の新規・変更を確認）。以下に挙げる現行の行番号は作成時点のもので、進行中の作業により変動しうる。

凡例 — 状態: `実装` / `部分` / `未実装` / `未確認`。

## 1. 選択 (Selection)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| S-1 | ガイド除外・ハンドル優先・ホバー | 選択はガイドを除外し、ハンドル優先判定・ホバー表示・ズーム連動許容差を使う | Paperヒットテストでガイドを除外し、実表示倍率から選択・点追加の許容差を変換する | ハンドル優先順位・ホバー表示の一致は未検証 | 部分 | 参照: [selection.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/selection.js)、現行: [paper-vector.ts](packages/editor/src/features/costumes/paper-vector.ts#L1076-L1092) |
| S-2 | マーキー選択（オブジェクト単位） | パス交差・グループ再帰・リシェイプ点選択・テキスト除外などを扱う | パスの点・輪郭と変形された図形境界を判定。リシェイプでは交差した曲線の端点も選択する | Shift切替、入れ子変形、曲線選択後の移動・Undo／Redoを検証。複雑なクリップとフォールバックには差や安全側の拒否が残る | 部分 | 現行: [paper-vector.ts](packages/editor/src/features/costumes/paper-vector.ts)、検証: [vector-reshape-curve-marquee.browser.test.ts](packages/editor/test/vector-reshape-curve-marquee.browser.test.ts) |
| S-3 | グループ内部分選択 | グループ内の子選択、選択ルートと葉の区別を持つ | 対応する子図形に加え、条件を満たす文字・画像の子単位移動を実装 | 文字・画像の安全条件と実操作の網羅は未検証。use・クリップ・複合パス等は対象外 | 部分 | 現行: [vector-group-reshape.ts](packages/editor/src/features/costumes/vector-group-reshape.ts)、[paper-vector.ts](packages/editor/src/features/costumes/paper-vector.ts) |
| S-4 | ビットマップ選択の切り詰め | ドラッグ範囲を丸めて不透明境界へ詰める | ズーム・解像度に応じた端点の丸め後、alphaが0でない画素へ切り詰める | 小数座標・逆向き・alpha 1・複数倍率を検証。実画面では標準倍率の選択・コピー・Undo／Redo等を確認し、全環境は未検証 | 部分 | 現行: [bitmap-selection.ts](packages/editor/src/features/costumes/bitmap-selection.ts)、検証: [bitmap-marquee-zoom-parity.browser.test.ts](packages/editor/test/bitmap-marquee-zoom-parity.browser.test.ts) |
| S-5 | コピー/貼付オフセット | Paperアイテムと貼付オフセットを扱う | 貼付ごとにずらし、両モード間の貼付にも対応 | 異なる解像度や回転中心での完全一致は未確認 | 部分 | 現行: [selection-shortcuts.ts](packages/editor/src/features/costumes/selection-shortcuts.ts#L114-L122)。参照: [copy-paste-hoc.jsx](.tmp/scratch-editor/packages/scratch-paint/src/hocs/copy-paste-hoc.jsx) |

## 2. ベクター描画 (Vector)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| V-1 | ブラシ生成方式 | サイズ・ズームに応じたストローク生成、固定距離補間、同色図形との結合、カーソループレビュー | ポインタ列から閉塗り形状を生成し条件付き結合する。実画面で作画・結合・履歴を検証 | 太さ/ズーム切替・補間距離・Z順維持の一致は未確認 | 部分 | 現行: [vector-brush-fill.ts](packages/editor/src/features/costumes/vector-brush-fill.ts#L42-L164)、[vector-brush-merge.ts](packages/editor/src/features/costumes/vector-brush-merge.ts#L159-L235) |
| V-2 | ブラシ結合 | 同色図形と結合する | 単色・同一親・接触・Z順安全などの条件でエディターが統合を試みる | 色名正規化や複雑な重なり順は参照と完全一致しない可能性がある | 部分 | 現行: [vector-brush-merge.ts](packages/editor/src/features/costumes/vector-brush-merge.ts#L67-L93)、[vector-brush-merge.ts](packages/editor/src/features/costumes/vector-brush-merge.ts#L357-L411) |
| V-3 | 矩形・楕円の修飾 | Shiftで正方形/正円、Altで中心基準、微小図形破棄、作成後選択 | Shift/Alt、Paper単位の微小図形破棄、作成後の図形ツール維持を実装 | ビットマップの一部ズーム境界は実画面でも検証済み。選択中のスタイル変更など全条件は未確認 | 部分 | 現行: [shape-drag.ts](packages/editor/src/features/costumes/shape-drag.ts)、検証: [shape-mode-retention.browser.test.ts](packages/editor/test/shape-mode-retention.browser.test.ts) |
| V-4 | 直線ツール | 専用ツール、Paper単位の線幅とSVG書出し倍率 | 逆方向ドラッグを保持し、線幅をSVG座標へ換算 | 標準の線幅1〜100についてプレビュー・保存・編集・Undo／Redoを検証。複雑な変換を含む全SVGは未確認 | 部分 | 現行: [vector-shapes.ts](packages/editor/src/features/costumes/vector-shapes.ts)、検証: [line-width-scratch-parity.browser.test.ts](packages/editor/test/line-width-scratch-parity.browser.test.ts) |
| V-5 | 塗り（既存図形） | ホバープレビュー、輪郭/塗り判定、複合パス穴、グラデ位置を扱う | 直線・一部曲線の複数穴と、安全条件を満たす入れ子輪郭の最内穴を塗れる | 3輪郭の単純な入れ子では島を含む外側の穴を塗れる。参照と同様、穴上に重ねた塗りは島も覆う。参照は穴の境界をわずかに拡張するが、現行は元の輪郭を使うため境界画素が異なりうる。曲線を含む島や4輪郭以上、接触・交差、クリップ、複雑なCSSなどは安全側に拒否し、全SVGには対応しない | 部分 | 参照: [fill-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/tools/fill-tool.js)、実画面: [vector-fill-nested-island-integration.browser.test.ts](packages/editor/test/vector-fill-nested-island-integration.browser.test.ts) |
| V-6 | 消しゴム | パス分割・結合を扱う | 複合パス・基本図形対応を修正済み。Paper実体で周辺保持を確認した範囲あり | 全図形種・境界条件の網羅は未確認 | 部分 | 現行: [vector-eraser.ts](packages/editor/src/features/costumes/vector-eraser.ts#L231-L329)。経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L57) |
| V-7 | リシェイプ: 点追加/削除 | 点追加・削除、点／曲線の範囲選択、ハンドル編集 | 複数点・曲線端点と対応するハンドルの選択、選択点の矢印移動、削除後の隣接ハンドル補正を実装 | 隣接曲線の選択、潜在選択点の移動・種類変更、選択後の編集／削除に対するUndo・Redoを検証。選択だけでは履歴を増やさず、直前の編集時に記録された選択を復元する。矩形・ブラシを挟む履歴も検証済み。その他の描画ツールを挟む履歴や一部の変換・退化形状は未検証 | 部分 | 現行: [vector-path-points.ts](packages/editor/src/features/costumes/vector-path-points.ts)、検証: [vector-reshape-mask-adversarial.browser.test.ts](packages/editor/test/vector-reshape-mask-adversarial.browser.test.ts) |

## 3. ビットマップ描画 (Bitmap)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| B-1 | ブラシ補間・スタンプ | 整数座標をBresenham補間。サイズ5以下は四角、以上は楕円スタンプ | Bresenham相当の整数補間＋事前描画スタンプに変更済み。小径=四角・大径=円 | 直径1〜100のスタンプ画素は参照と一致。その他の全描画条件は未確認 | 部分 | 現行: [bitmap-brush.ts](packages/editor/src/features/costumes/bitmap-brush.ts#L1-L50)。参照: [brush-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/brush-tool.js)。経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L21) |
| B-2 | 直線 | ブラシマークを整数座標上に並べる | ブラシと共通のピクセルスタンプ方式に変更済み | 共通スタンプの直径1〜100は一致。直線全体のあらゆる条件は未確認 | 部分 | 現行: [bitmap-line.ts](packages/editor/src/features/costumes/bitmap-line.ts#L1-L77)。参照: [line-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/line-tool.js) |
| B-3 | 矩形・楕円 | 塗り/輪郭切替、Shift/Alt修飾、微小面積の破棄、変形中選択、ラスタ確定 | Canvas直接描画、Filled/Outlined排他。Shift/AltとPaper単位・ズームに基づく微小面積の破棄に対応 | 作成後の図形ツール維持は実装済み。参照は未確定図形を後から再スタイルするが、現行はラスタ確定するため挙動が異なる。ライブ編集の試作では移動・拡縮・90度回転と競合時の退避を追加し、直接VM切替・更新・プロジェクト破棄の一部を実画面で検証。未確定中のUI対象切替は拒否する。連続作成・選択・遅延保存と同スロット外部更新の実画面試験を追加したが、全境界の安全性は未確認のため既定無効 | 部分 | 現行: [shape-drag.ts](packages/editor/src/features/costumes/shape-drag.ts)、[bitmap-shape-mode.ts](packages/editor/src/features/costumes/bitmap-shape-mode.ts)。参照: [rect-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/rect-tool.js)、実画面: [rect-oval-tiny-discard-real-editor.browser.test.ts](packages/editor/test/rect-oval-tiny-discard-real-editor.browser.test.ts) |
| B-4 | 塗りつぶし（連結） | RGBA完全一致の連結塗り。Shiftで同色全画素置換。透明色・グラデ用マスク対応 | RGBA厳密一致・Shift全置換・透明端とクリック位置を中心とする放射塗りに対応 | 放射塗りの実画面検証済みだが全境界条件は未確認 | 部分 | 現行: [bitmap-fill.ts](packages/editor/src/features/costumes/bitmap-fill.ts#L136-L179)、[bitmap-fill.ts](packages/editor/src/features/costumes/bitmap-fill.ts#L229-L372)。参照: [fill-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/fill-tool.js) |
| B-5 | 消しゴム | ブラシの消しゴムモードでスタンプを `destination-out` 合成 | Bresenham沿いに消しゴムスタンプを配置する実装（移植明記あり） | 直径1〜100、水平・斜め・逆方向・画面外・タップ、複数の透明度とズーム座標で参照実体との画素一致を確認。全UI操作・範囲外入力は未検証 | 部分 | 現行: [bitmap-eraser.ts](packages/editor/src/features/costumes/bitmap-eraser.ts#L1-L40)、参照: [brush-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/brush-tool.js)、検証: [bitmap-eraser-stroke-parity.browser.test.ts](packages/editor/test/bitmap-eraser-stroke-parity.browser.test.ts)。ライセンス注意は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L50) |
| B-6 | 浮動選択の拡縮・回転 | 浮動ラスタを移動・拡縮・回転後に確定 | 浮動選択の移動・複製、8ハンドル拡縮、回転ハンドルを接続 | 任意角回転の半透明画素など全境界条件は未検証 | 部分 | 現行: [bitmap-floating.ts](packages/editor/src/features/costumes/bitmap-floating.ts#L390-L434)、[bitmap-floating.ts](packages/editor/src/features/costumes/bitmap-floating.ts#L470-L552) |

## 4. 色 (Color)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| C-1 | 色モデル | HSV、2色、入替、透過、スポイト、4種塗り | HSVスライダーとネイティブ色入力、グラデ選択、不透明度入力、透明切替、MIXED表示・色入替 | 選択色の連続変更とUndoは検証済み。スポイト外観・タッチなどの厳密一致は未確認 | 部分 | 現行: [paint-colors.ts](packages/editor/src/features/costumes/paint-colors.ts#L1-L27)（差の自己申告コメント）。参照: [fill-style.js](.tmp/scratch-editor/packages/scratch-paint/src/reducers/fill-style.js)、[stroke-style.js](.tmp/scratch-editor/packages/scratch-paint/src/reducers/stroke-style.js) |
| C-2 | MIXED表示 | 選択図形の色不一致でMIXED | `MIXED` センチネルと判定関数を持つ | UI表示連動の一致は未確認 | 部分 | 現行: [paint-colors.ts](packages/editor/src/features/costumes/paint-colors.ts#L50-L55)、[paint-colors.ts](packages/editor/src/features/costumes/paint-colors.ts#L104-L122) |
| C-3 | 透明色・透明ストップ | 透明色と透明ストップ補間あり | 透明=`null`、片端透明は対岸RGB＋alpha 0、両端透明は透明黒で保持 | グラデ中心位置・スポイト表示細部は未確認 | 部分 | 現行: [paint-colors.ts](packages/editor/src/features/costumes/paint-colors.ts#L261-L312)、[transparent-paint.ts](packages/editor/src/features/costumes/transparent-paint.ts#L1-L35) |
| C-4 | スポイト（透過・拡大鏡） | 専用ツールと拡大鏡、透明色対応 | ビットマップ/ベクター専用スポイト、ルーペ、塗り/枠線と透明取得あり | 半径20・倍率3と外観を合わせ、通常操作を検証。全倍率・画面端・タッチ実機の一致は未確認 | 部分 | 現行: [eyedropper.ts](packages/editor/src/features/costumes/eyedropper.ts)、[EyedropperLoupe.svelte](packages/editor/src/features/CostumeEditor/EyedropperLoupe.svelte)。参照: [eye-dropper.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/tools/eye-dropper.js) |
| C-5 | 第2色・グラデ・交換 | 塗り/輪郭の独立設定、第2色編集、交換 | 塗りと輪郭それぞれにグラデ種類・第2色・透明端・色交換を追加 | MIXED表示・項目単位の適用を追加。未知の色は保護するが、勾配の幾何学的な完全一致は未確認 | 部分 | 現行: [paint-colors.ts](packages/editor/src/features/costumes/paint-colors.ts#L1-L27)。経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L42) |

## 5. 文字 (Text)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| T-1 | ベクター文字編集 | キャンバス上テキスト編集・フォント選択 | キャンバス上作成・既存再編集・フォント/サイズ選択を追加。既存の継承フォント・塗り・枠線を未操作時に保持 | Scratch固有フォント・変形・複数行細部は未確認 | 部分 | 現行: [vector-text.ts](packages/editor/src/features/costumes/vector-text.ts#L128-L148)、[vector-text.ts](packages/editor/src/features/costumes/vector-text.ts#L99-L157)。参照: [text-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/tools/text-tool.js) |
| T-2 | ビットマップ文字 | 共通テキストツールで編集後ラスタ化 | インライン編集・フォント/サイズ選択を追加済み。ラスタ化ヘルパーあり | ラスタ化後再編集・選択挙動の一致は未確認 | 部分 | 現行: [bitmap-text.ts](packages/editor/src/features/costumes/bitmap-text.ts#L12-L49)。経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L25) |
| T-3 | フォント一覧・制限 | 9種のフォント、標準サイズ40・行間46.15。専用フォントを別パッケージで提供 | 参照の9種と既存のシステムフォント5種を選択可能。ベクター標準サイズ・行間を合わせ、未知の指定は保持 | ビットマップ行間も46.15/40に合わせ、複数行・RTL・Undo／Redoを検証。専用フォントのバイナリは未同梱で表示は代替フォントに依存し、サイズUI・入力上限も異なる | 部分 | 参照: [fonts.js](.tmp/scratch-editor/packages/scratch-paint/src/lib/fonts.js)、実画面: [vector-text-font-dropdown-ui.browser.test.ts](packages/editor/test/vector-text-font-dropdown-ui.browser.test.ts) |

## 6. 履歴 (History)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| H-1 | 上限・保存形式 | PaperのJSONスナップショット、最大100件 | アセットのバイト列＋メタデータ、最大100件・容量上限あり | 保存単位と容量上限により、必ず100件保持するわけではない | 部分 | 参照: [undo.js](.tmp/scratch-editor/packages/scratch-paint/src/reducers/undo.js#L7-L51)。現行: [Editor.svelte](packages/editor/src/Editor.svelte) |
| H-2 | 記録タイミング | 変更発生時に更新（移動等） | 変更成立時に記録する方式へ改めた（移動/リサイズ開始時取得をやめ、成立時記録） | 描画履歴の切替時クリアと音声分離を追加。並行操作や全境界条件の一致は要検証 | 部分 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L86)。参照: [move-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/selection-tools/move-tool.js)、[undo.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/undo.js)。現行: [Editor.svelte](packages/editor/src/Editor.svelte) 付近の保留エントリ方式（行番号は変動しうるため未検証扱い） |
| H-3 | 切替時の履歴・選択復元 | コスチューム切替時に描画履歴をクリア | 同じく描画履歴をクリアし、音声履歴と分離する | 対象切替時の実操作は検証済み。すべての非同期条件は未網羅 | 部分 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L93)、検証は [paint-history-isolation.browser.test.ts](packages/editor/test/paint-history-isolation.browser.test.ts) |

## 7. 入出力 (I/O)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| IO-1 | SVGサニタイズ・取込 | 取込時サニタイズ、スケール/回転中心調整、書出時境界算出 | DOMPurify＋独自後段で表示/取込を防御。`data-paper-data` 除去、外部`url()`・`image-set` 系遮断 | 同梱785件を240×180で描画したRGBAは処理前後で完全一致（未知SVGや他サイズを保証しない） | 部分 | 現行: [svg-sanitize.ts](packages/editor/src/features/costumes/svg-sanitize.ts#L1-L27)、[svg-sanitize.ts](packages/editor/src/features/costumes/svg-sanitize.ts#L432-L504)。参照: [paper-canvas.jsx](.tmp/scratch-editor/packages/scratch-paint/src/containers/paper-canvas.jsx)。経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L92) |
| IO-2 | ビットマップ→ベクター | ラスタ挿入（トレースではない） | 埋込み画像を使う | その点自体は差分ではない | 実装 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L9)（差分ではない旨の記載。個別行証拠は未検証のため状態は経緯準拠） |
| IO-3 | モード切替・画像埋込・解像度 | 描画境界・座標/倍率/回転中心・空画像・PNG解像度・埋込を扱う | 変換後も解像度・回転中心・ステージ上の位置を維持し、描画領域と保存画像を分離 | 実画面で複数サイズ・解像度・半透明・Undo／Redoを検証。全画像と極端な寸法の一致は未確認 | 部分 | 現行: [costume-conversion.ts](packages/editor/src/features/costumes/costume-conversion.ts)、[bitmap-artboard.ts](packages/editor/src/features/costumes/bitmap-artboard.ts)、検証: [costume-conversion-real-editor-verify.browser.test.ts](packages/editor/test/costume-conversion-real-editor-verify.browser.test.ts) |

## 8. UI (User Interface)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| UI-1 | ツール別UI | 独立ブラシ/消しゴムサイズ、塗り/輪郭、フォント、曲線/直線点など | ベクターの独立ブラシサイズと、ビットマップのツール別サイズ表示・輪郭欄の非表示を実装 | グラデーション設定やテキストサイズなど、参照にはない追加操作を維持している | 部分 | 修正前の調査経緯: [ツールバー対応表](scratch-paint-toolbar-matrix.md)、実画面: [bitmap-stroke-parity.browser.test.ts](packages/editor/test/bitmap-stroke-parity.browser.test.ts) |
| UI-2 | モード別コントロール・上限・有効条件 | サイズ初期値/上限、グループ化・重なり順有効条件、狭幅対応あり | ブラシ・線幅の上限100と色操作のモード別無効条件を実装 | 選択依存の有効条件と狭幅表示には未検証・未対応項目が残る | 部分 | 修正前の調査経緯は [ツールバー対応表](scratch-paint-toolbar-matrix.md)、現行検証は [vector-fill-stroke-disabled-guard.browser.test.ts](packages/editor/test/vector-fill-stroke-disabled-guard.browser.test.ts) |
| UI-3 | 翻訳・RTL・フォーカス | 翻訳とRTL考慮 | 日英の固定文字列混在 | 差あり（利用者影響の程度は未確認） | 部分 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L46)（個別文字列の洗い出しは未検証） |
| UI-4 | 独自機能の扱い | 該当なし（参照外） | SVG数値編集・整列・明示保存・クリック定型図形・独自回転中心編集など | 互換化で一律削除せず用途検討が必要 | 実装 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L66)（現行固有機能の列挙。個別UI行は未検証） |

## 9. ズーム / パン (Zoom & Pan)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| Z-1 | ズーム基準・増分・境界 | Paperビューとスクロール領域、基準点・増分・ホイール修飾・境界・ガイド表示あり | CSS変換・独自ビューポート。ベクターと解像度1・2のビットマップの初回Fit、リセット・最小倍率・増分・パン境界をPaper座標へ換算し、実画面で検証 | 拡大上限、スクロールバー、および初回Fit・パン境界の全条件の一致は未対応または未確認。解像度1の保存データは非破壊で保持するため、参照の読込時2倍正規化と形式が異なる | 部分 | 現行: [BitmapEditor.svelte](packages/editor/src/features/CostumeEditor/BitmapEditor.svelte)、[BitmapEditor.svelte](packages/editor/src/features/CostumeEditor/BitmapEditor.svelte)。参照: [zoom-levels.js](.tmp/scratch-editor/packages/scratch-paint/src/reducers/zoom-levels.js#L1-L41)（行検証済み） |
| Z-2 | ズーム連動の描画・判定 | ズーム連動のヒット許容差・ハンドル・描画太さ | 選択・リシェイプの許容差を表示倍率に応じて変換 | 一部倍率で実画面検証済み。描画太さなど全条件の厳密一致は未確認 | 部分 | 現行: [vector-hit-tolerance.ts](packages/editor/src/features/costumes/vector-hit-tolerance.ts)、検証は [vector-hit-tolerance.browser.test.ts](packages/editor/test/vector-hit-tolerance.browser.test.ts) |
| Z-3 | スポイトのルーペ倍率 | 半径20画素を3倍に拡大、中央セルと色付き外周を表示 | 同じ倍率・寸法でカーソル中央に表示。画布外では非表示 | 標準表示とズーム変更・透明色・取消を実画面で検証。全倍率と画面端での配置は未網羅 | 部分 | 現行: [eyedropper.ts](packages/editor/src/features/costumes/eyedropper.ts)、検証: [eyedropper-loupe.browser.test.ts](packages/editor/test/eyedropper-loupe.browser.test.ts) |

## 10. キーボード (Keyboard)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| K-1 | 基本ショートカット | Esc、削除、Undo/Redo、グループ化、コピー/カット/貼付、全選択、矢印移動 | 選択解除・全選択・コピー/カット/貼付・グループ化・矢印キーを追加済み。マッピング関数あり | 選択点の矢印移動・複数倍率・Undo／Redoを実画面で検証。モード横断貼付は実装済みだが、全入力機器と環境は未確認 | 部分 | 現行: [selection-shortcuts.ts](packages/editor/src/features/costumes/selection-shortcuts.ts#L70-L102)。参照: [keyboard-shortcuts-hoc.jsx](.tmp/scratch-editor/packages/scratch-paint/src/hocs/keyboard-shortcuts-hoc.jsx#L1-L60)（Shift+z/g周辺のみ検証、全体は未検証） |
| K-2 | テキスト編集中の抑止 | 編集中ショートカット抑止あり | タイピング中判定があり、Escapeで編集確定する | 一覧の一致は未確認 | 未確認 | 現行: [vector-move-drag.ts](packages/editor/src/features/costumes/vector-move-drag.ts#L60-L61)（`typing` 判定の存在のみ）、[BitmapEditor.svelte](packages/editor/src/features/CostumeEditor/BitmapEditor.svelte#L1502) 付近コメント（行変動のため未検証） |
| K-3 | 矢印キー移動量 | ズーム連動の移動量 | 表示倍率連動・Shift 15倍・長押しの履歴まとめを追加 | ビットマップ高倍率では整数画素制約により小数移動を累積 | 部分 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L44)。参照: [nudge-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/selection-tools/nudge-tool.js)（未読のため詳細未確認） |

## 11. 変形 (Transform)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| X-1 | 移動 | Shift角度スナップ、特定操作の中心スナップ、Alt複製、ズーム連動矢印移動 | Shift角度制約・Alt複製・中央スナップとガイドを追加。単一・複数選択と複数倍率で実画面検証 | 移動可能範囲の参照との厳密一致やすべての入力条件は未確認 | 部分 | 現行: [vector-move-drag.ts](packages/editor/src/features/costumes/vector-move-drag.ts#L26-L61)。参照: [move-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/selection-tools/move-tool.js)（未読のため詳細未確認） |
| X-2 | 拡縮（単一） | Alt中心、角は通常等比・Shift自由比 | 角は通常等比・Shift自由比、Alt中心基準に対応済み | 重なり順・テキストサイズ反映の一致は未確認 | 部分 | 現行: [vector-scale-modifiers.ts](packages/editor/src/features/costumes/vector-scale-modifiers.ts#L103-L154) |
| X-3 | 拡縮（複数） | 複数選択の一括スケール（共有中心） | 複数選択の共有境界による拡縮・回転・反転を実装済み | 端のハンドル表示や枠線幅・全変換条件の一致は未確認 | 部分 | 現行: [vector-multi-scale.ts](packages/editor/src/features/costumes/vector-multi-scale.ts#L17-L18)（共有中心の前提コメント）。経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L34) |
| X-4 | 回転・反転 | ドラッグハンドル＋Shift角度スナップ、共有中心 | ビットマップ・ベクターに回転ハンドルとShiftスナップを追加。複数選択は共通中心で回転/反転 | 画素補間・キーボード操作などの一致は未確認 | 部分 | 現行: [rotation-gesture.ts](packages/editor/src/features/costumes/rotation-gesture.ts)、[paper-vector.ts](packages/editor/src/features/costumes/paper-vector.ts)。参照: [rotate-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/selection-tools/rotate-tool.js)（未読のため詳細未確認） |
| X-5 | ビットマップ変形 | 選択ラスタを浮動化し移動/拡縮/回転後に確定 | 浮動画像の移動・複製、8ハンドル拡縮と回転ハンドルを実装 | 半透明の全境界条件と実操作の完全一致は未確認 | 部分 | 現行: [bitmap-floating.ts](packages/editor/src/features/costumes/bitmap-floating.ts#L1-L58)。参照: [select-tool.js](.tmp/scratch-editor/packages/scratch-paint/src/helper/bit-tools/select-tool.js)（未読のため詳細未確認） |

## 12. セキュリティ (Security)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| SEC-1 | SVG防御（表示/取込） | サニタイズと分離処理 | DOMPurify＋厳格後段。外部`url()`・CSS画像関数（`image-set`等）遮断、`data-paper-data` 除去 | VM保存時にパーサーベース防御も追加。未知入力の網羅保証なし | 部分 | 現行: [svg-sanitize.ts](packages/editor/src/features/costumes/svg-sanitize.ts#L185-L264)、[svg-sanitize.ts](packages/editor/src/features/costumes/svg-sanitize.ts#L344-L504)。経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L92) |
| SEC-2 | 運用注意 | — | 出所不明のSVG/プロジェクトを開かない注意 | 参照: [paper-canvas.jsx](.tmp/scratch-editor/packages/scratch-paint/src/containers/paper-canvas.jsx) の分離処理との対比は未検証 | 未確認 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L92) |

## 13. 独自機能・ライセンス (Proprietary & License)

| No | 項目 | 参照動作 | 現行動作 | 具体的な差 | 状態 | 根拠 |
|---|---|---|---|---|---|---|
| L-1 | ライセンス表示 | AGPL-3.0-only（参照側申告） | 現行パッケージはMIT申告 | 直接コピー/移植には確認が必要。ここで法的結論は出さない | 未確認 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L3)、[scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L50) |
| L-2 | 移植明記箇所 | — | [bitmap-stamp.ts](packages/editor/src/features/costumes/bitmap-stamp.ts)、[bitmap-eraser.ts](packages/editor/src/features/costumes/bitmap-eraser.ts)、[bitmap-fill.ts](packages/editor/src/features/costumes/bitmap-fill.ts#L1-L36) 付近、[vector-eraser.ts](packages/editor/src/features/costumes/vector-eraser.ts#L147-L231) 付近に参照由来の明記・近似構造あり | 個別の人のレビューが必要（特に楕円描画・パス分割・走査線塗り） | 未確認 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L50)（該当行の全文照合は未検証） |
| L-3 | THIRD-PARTY記載 | — | 調査時点で scratch-paint の記載なし | 要確認（配布前に由来と条件を確認） | 未確認 | 現行: [THIRD-PARTY.md](packages/editor/THIRD-PARTY.md#L9-L17)（scratch-paint非記載を確認、AGPL記載なし） |
| L-4 | 独自機能の温存 | — | SVG数値編集・整列・明示保存・定型図形クリック配置・独自回転中心など | 互換化で一律削除せず検討が必要 | 実装 | 経緯は [scratch-paint-gap-analysis.md](scratch-paint-gap-analysis.md#L66) |

## 検証状況の報告

- 検証済み（実在・行番号を目視確認）:
  - 参照: [undo.js](.tmp/scratch-editor/packages/scratch-paint/src/reducers/undo.js#L7-L51)（上限100）、[zoom-levels.js](.tmp/scratch-editor/packages/scratch-paint/src/reducers/zoom-levels.js#L1-L41)（存在のみ）、[keyboard-shortcuts-hoc.jsx](.tmp/scratch-editor/packages/scratch-paint/src/hocs/keyboard-shortcuts-hoc.jsx) のShift+z/g周辺、`paint-editor.jsx`・`paper-canvas.jsx`・`copy-paste-hoc.jsx`・各bit/vector toolの存在。
  - 現行: [Editor.svelte](packages/editor/src/Editor.svelte)（上限100・容量制限あり）、[paper-vector.ts](packages/editor/src/features/costumes/paper-vector.ts#L1076-L1092)（許容差/ヒット条件）、[shape-drag.ts](packages/editor/src/features/costumes/shape-drag.ts#L9-L52)（Shift/Alt）、[vector-scale-modifiers.ts](packages/editor/src/features/costumes/vector-scale-modifiers.ts#L103-L154)（等比/中心）、[selection-shortcuts.ts](packages/editor/src/features/costumes/selection-shortcuts.ts#L70-L122)（対応表/貼付オフセット）、[paint-colors.ts](packages/editor/src/features/costumes/paint-colors.ts#L50-L55)（MIXED等）、[eyedropper.ts](packages/editor/src/features/costumes/eyedropper.ts#L23-L31)（ルーペ定数）、[svg-sanitize.ts](packages/editor/src/features/costumes/svg-sanitize.ts#L432-L504)（防御本体）、[bitmap-brush.ts](packages/editor/src/features/costumes/bitmap-brush.ts#L1-L50)（Bresenham等）、[bitmap-fill.ts](packages/editor/src/features/costumes/bitmap-fill.ts#L136-L179)（連結塗り）、[vector-text.ts](packages/editor/src/features/costumes/vector-text.ts#L128-L148)（制限値）、[THIRD-PARTY.md](packages/editor/THIRD-PARTY.md#L9-L17)（scratch-paint非記載）、[BitmapEditor.svelte](packages/editor/src/features/CostumeEditor/BitmapEditor.svelte)（ズーム/ビューポート）。
- 未検証として残したもの:
  - 参照側の `selection-tools`（move/scale/rotate/nudge/reshape/select/selection-box）、`bit-tools/select-tool.js`、`eye-dropper.js`、`fill-tool.js`（vector/bit双方）の本文、`paper-canvas.jsx` の分離処理本文、`paint-editor.jsx` のUI本文、`undo.js`（helper）の本文は、存在確認のみで内容の行単位照合をしていない。
  - 現行側の [Editor.svelte](packages/editor/src/Editor.svelte) 内の履歴保留・ビットマップ描画・スポイト確定などの広範な本文（7000行超のため全行照合はしていない。引用行以外は経緯レポート準拠とし「未確認/部分」とした）。
  - 動作試験（実ブラウザー操作・画素比較・タッチ実機・翻訳/RTL・フォーカス・性能・印刷・保存往復の網羅）は本表の作成では実施していない。既存レポートの「確認済み」とある項目も再試験していない。
  - ライセンスの法的判断（AGPL/MITの両立可否、移植該当性）は未確認。配布前に人のレビューが必要。
- 禁止事項の遵守: コードと既存レポートは変更していない。新規作成のみ。`git stash/checkout/reset/restore/clean` は使用していない。
