# scratch-paint ツールバー対応表（UI-1 / UI-2）

> この表は修正前の調査記録です。ベクターブラシの独立サイズ、ビットマップブラシと線幅の上限100、モード別の色コントロール無効化は調査後に実装済みです。最新の残差は [差分一覧](scratch-paint-gap-matrix.md) を参照してください。

`scratch-paint-gap-matrix.md` の UI-1 / UI-2（「未確認」）を埋めるための、
ツールバー限定の対応表。ツールごとの fill / stroke / opacity / brush /
eraser / shape modes / font / selection / group / order / resize コントロールについて、
表示条件・disabled 条件・初期値・数値 min/max/step・キーボード・狭幅対応を
コードの証拠付きで比較する。

## 調査ルール（厳格な再現／未確認の分け）

- **再現（コード）**: 参照側と現行側の両方のソースを行単位で読んだ差。具体値は両ファイルのパスと行番号で示す。
- **再現（実 DOM）**: 実 Editor をブラウザで開き、描画・保存を一切行わず
  （ツールボタンのクリックと DOM 属性の読み取りのみ）確認した差。
  実施日 2026-11-12、vite dev（`packages/editor`、127.0.0.1:4219）、
  Chrome 156（`CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome`）、
  viewport 1280x800（狭幅のみ 800x800）。
- **未確認**: 選択状態や描画物が必要で、読み取り専用の範囲では触れなかったもの。
  コードとは一致していても DOM 未検証なら「未確認」と書く。
- 製品 src は編集していない（本ファイルの新規作成のみ。検証スクリプトは `/tmp` に置き、保存・履歴・VM への書き込みは行っていない）。
- 参照コードの転載はしない。振る舞いの要約と、ファイルパス＋行番号・具体値（初期値・min/max 等の事実値）のみ記す。
- `git stash/checkout/reset/restore/clean` は使用していない。

## 参照側の全体構造（再現・コード）

- `paint-editor.jsx`（`.tmp/scratch-editor/packages/scratch-paint/src/components/paint-editor/paint-editor.jsx`）:
  vector 時は fill＋stroke＋stroke-width の 3 連＋`ModeTools`（L80-L108）、
  bitmap 時は fill のみ＋`ModeTools`（L109-L130）。
  vector モードボタンは Select/Reshape/Brush/Eraser/Fill/Text/Line/Oval/Rect（L136-L167）、
  bitmap は BitBrush/BitLine/BitOval/BitRect/Text/BitFill/BitEraser/BitSelect（L169-L198）。
- `mode-tools.jsx`（同 `components/mode-tools/mode-tools.jsx`）の mode 別分岐が
  サイズ・フォント・図形・選択系の表示条件の正本（L110-L305）。

## T-1. ブラシサイズ（vector brush / bitmap brush+line）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| 表示条件 | BRUSH・BIT_BRUSH・BIT_LINE でサイズスライダを表示（`mode-tools.jsx` L111-L143）。BIT_LINE は見出しが「Thickness」に変わる（L121） | bitmap 時のみ「Size」スライダを表示（`BitmapEditor.svelte` L3053-L3061）。vector 時にブラシサイズ UI は存在しない | **vector ブラシ太さの専用 UI がない**。現行 vector ブラシ幅は stroke 幅を流用（`Editor.svelte` L5106-L5108 付近の `brushWidth = strokeWidth`） | 再現（実 DOM） |
| 初期値 | vector brush `10`（`reducers/brush-mode.js` L4）、bit brush `10`（`reducers/bit-brush-size.js` L8） | `brushSize = 7`（`Editor.svelte` L994、`BitmapEditor.svelte` L128）。bitmap/bit 両用の一本化 | 初期太さが異なる（10 vs 7）。同一操作の再現性に影響 | 再現（コード） |
| min/max/step | `min="1"`、`max={MAX_STROKE_WIDTH}`（`mode-tools.jsx` L133-L140）。`MAX_STROKE_WIDTH = 100`（`reducers/stroke-width.js` L6）。reducer は `Math.max(1, …)` で下限のみ（`bit-brush-size.js` L18、NaN 警告 L14-L17）。入力側 `LiveInput` が min/max で clamp（`forms/live-input-hoc.jsx` L32-L46）。step 指定なし（既定 1） | bitmap スライダ `min="1" max="24"`（`BitmapEditor.svelte` L3060）。step 指定なし | **現行 bitmap で 25〜100 がスライダから指定不可**。参照は 100 まで可。実害あり（太ブラシの再現不可） | 再現（実 DOM: `Brush size` range `min=1 max=24` を確認） |
| disabled 条件 | なし（常時編集可） | なし（bitmap  brush/line/rect/oval/text いずれでも表示。rect/oval outlined の輪郭太さもこのスライダ） | 条件差なし。用途は一致（rect/oval outlined＝共有ブラシサイズ：参照 `bit-brush-size.js` L5 コメント、現行 L3053-L3057 コメント） | 再現（コード） |
| 実 DOM | — | vector 既定・vector brush 選択時のいずれも `Brush size` 要素なし。bitmap では range `min=1 max=24` あり | 上表の通り | 再現（実 DOM） |

## T-2. 消しゴムサイズ（vector eraser / bitmap eraser）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| 表示条件 | ERASER・BIT_ERASER でサイズスライダ（`mode-tools.jsx` L144-L172） | eraser 選択時に消しゴム UI に置換（両 mode）。それ以外のツール時は fill/stroke 行（`BitmapEditor.svelte` L2864-L2875）。すなわち eraser 選択中は fill/stroke が隠れる | 置換方式は一致方向。非 eraser 時の fill/stroke 表示は T-4 参照 | 再現（コード。実 DOM は既存 `eraser-size.browser.test.ts` が両 mode の同期・カーソル・消去を検証済みのため本表では再掲のみ） |
| 初期値 | vector `40`（`reducers/eraser-mode.js` L4）、bitmap `40`（`reducers/bit-eraser-size.js` L4） | bitmap `40`（`BITMAP_ERASER_DEFAULT_SIZE`）、vector `40`（`VECTOR_ERASER_DEFAULT_SIZE`）（`Editor.svelte` L995-L996、`BitmapEditor.svelte` L129-L130、定数 `features/costumes/bitmap-eraser.ts` L7-L8・`vector-eraser.ts` L8） | 一致 | 再現（コード） |
| min/max/step | `min="1"` `max={MAX_STROKE_WIDTH=100}`（`mode-tools.jsx` L161-L169）。reducer は `Math.max(1, …)`（両 reducer L14-L18／L10-L14） | 両 mode とも slider `min="1" max="100"`＋number `min="1" max="100"`、切捨て clamp（`BitmapEditor.svelte` L2868-L2873） | 一致 | 再現（コード＋既存ブラウザ試験） |
| disabled 条件 | なし | なし | 差なし | 再現（コード） |

## T-3. 線幅（stroke width、vector のみ）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| 表示条件 | vector 行に常時表示（`paint-editor.jsx` L99） | 常時表示（eraser 選択時を除く、`BitmapEditor.svelte` L3018）。bitmap brush/line/fill/text でも表示される | 参照は bitmap 時に線幅 UI 自体がない（L109-L130）。現行は bitmap でも表示（rect/oval では disabled）。余分な表示だが、rect/oval では disabled で無害化 | 再現（実 DOM: bitmap brush で enabled、bitmap rect で `disabled=true` を確認） |
| disabled 条件 | BRUSH・TEXT・FILL 選択中は disabled（`containers/stroke-width-indicator.jsx` L67-L70） | eraser 選択中のみ非表示。brush/text/fill/line 選択中も enabled | **不一致**。現行は brush 選択中に線幅を変えると vector ブラシ幅に直結する（T-1）。参照は brush 幅と線幅が独立 | 再現（実 DOM: vector brush 選択中に `Stroke width` enabled を確認） |
| 初期値 | `4`（`reducers/stroke-width.js` L7） | `4`（`Editor.svelte` L509、`BitmapEditor.svelte` L141）。実 DOM 初期値も `"4"` | 一致 | 再現（実 DOM） |
| min/max/step | `min="0"` `max={MAX_STROKE_WIDTH=100}`（`stroke-width-indicator.jsx` L13-L24）。reducer は 0〜100 に clamp（`stroke-width.js` L17） | `min="0" max="48"`（`BitmapEditor.svelte` L3018、可視ツールバー。隠れ legacy パネル `Editor.svelte` L17097 も `max="48"`） | **上限不一致（100 vs 48）**。49〜100 はスピナーで指定不可。typed 値の扱いはハンドラ（`updateVectorObjectStrokeWidth`）未読のため上限突破可否は未確認 | 上限表示は再現（実 DOM: `max="48"`）。typed 値の最終 clamp は未確認 |
| 0 の意味 | 0 で stroke 色が null 化（`reducers/stroke-style.js` L26-L33） | `Math.max(0, …)` で 0 許容（`Editor.svelte` L8316 付近）。null 連動の有無は要確認 | 0 扱いの一致は未確認 | 未確認 |

## T-4. fill / stroke（塗り・輪郭。グラデ・透明・交換を含む）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| 表示条件 | fill は vector/bitmap 両行に常時（`paint-editor.jsx` L90-L122）。stroke は vector のみ（bitmap 行に stroke なし、L109-L130） | fill・stroke とも両 mode で常時表示（eraser 時を除く、`BitmapEditor.svelte` L2876-L3017）。bitmap でも stroke 色・stroke グラデ選択が表示される | **bitmap に stroke 系が表示される**。bitmap 描画は fill 側のみ参照（`Editor.svelte` の bitmap paint 解決は fill/secondary/gradient のみ）のため、stroke 変更は bitmap 描画に無害のはずだが、利用者の混乱要因。無害性の全経路確認は未了 | 表示差は再現（実 DOM）。無害性は未確認 |
| disabled 条件 | fill は LINE 選択中に disabled（`containers/fill-color-indicator.jsx` L27）。stroke は BRUSH・TEXT・FILL 選択中に disabled（`containers/stroke-color-indicator.jsx` L27-L29） | disabled 条件なし（常時 enabled） | **不一致**。実害例：vector LINE 選択中に fill を変えると、参照は不可だが現行は受付。直線の見た目への反映有無は要確認 | 条件差は再現（実 DOM: vector line 選択中に fill/stroke/width すべて enabled）。反映有無は未確認 |
| 初期値 | fill `#9966FF`（`reducers/fill-style.js` L7）、stroke `#000000`（`reducers/stroke-style.js` L7）、gradient `SOLID`（`make-color-style-reducer.js` L39-L43）、colorIndex `0`（`reducers/color-index.js` L6）、fill-mode gradient `null`（`reducers/fill-mode-gradient-type.js` L7） | fill `#ffab19`（`Editor.svelte` L493）、stroke `#0f172a`（同 L502）、stroke 副 `#ffffff`（同 L506）、gradient 両 `solid`（L495/L508）、副 fill `#ffffff`（`BitmapEditor.svelte` L132 既定） | **既定色が異なる**（fill/stroke とも）。新規図形の既定色に直接影響 | 再現（コード） |
| グラデ UI | カラーピッカーのポップオーバー内で選択。`shouldShowGradientTools` は FILL/SELECT/RESHAPE/OVAL/RECT/LINE＋BIT_OVAL/BIT_RECT/BIT_SELECT/BIT_FILL のみ真（`lib/modes.js` L29-L41、`containers/color-indicator.jsx` L82-L96） | トップレベル select（fill `Bitmap paint style`／`Vector paint style`、stroke `Vector stroke style`＋副色＋透明トグル＋交換：L3078-L3210）。ツールによらず常時表示 | 現行は独自拡張（MIXED 表示・HSV・透明・交換を含む）。不足ではなく過剰。参照の「ツール限定」条件はない | 再現（コード＋実 DOM: bitmap/vector の paint style select を確認） |
| 交換・透明 | 選択あり：`swapColorsInSelection`、選択なし：hex 交換（`containers/color-indicator.jsx` L117-L133）。透明は `null` 色 | `swap-fill-colors`／`swap-stroke-colors`（L2992-L3017、透明フラグごと交換）。透明トグルは hex 温存（L2913-L2923、L2966-L2976） | 方式は一致方向（透明温存は現行の独自改善）。選択連動の一致は未確認 | 再現（コード）。選択連動は未確認 |

## T-5. 図形モード（rect / oval / line。bitmap filled/outlined を含む）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| vector rect/oval/line の mode-tools | 空 div（対応なし、`mode-tools.jsx` L300-L304）。線幅・グラデは上部行で操作 | 上部行の fill/stroke/width/gradient がそのまま使われる。図形専用行なし | 不足なし（参照も図形専用行なし） | 再現（コード） |
| bitmap rect/oval filled/outlined | `Filled`／`Outlined` 排他＋outlined 時のみ thickness（`bitBrushSize`）表示（`mode-tools.jsx` L258-L299）。既定 `true`（filled、`reducers/fill-bitmap-shapes.js` L5） | `Filled`／`Outlined` 排他（`BitmapEditor.svelte` L3028-L3051）。既定 `filled`（`Editor.svelte` L927）。outlined 時の太さは共通 Size スライダ（L3053-L3061 コメント） | 方式一致。既定一致（実 DOM で `bitmap-shape-mode-filled` の `aria-pressed=true` を確認） | 再現（実 DOM＋コード） |
| bitmap line の太さ | thickness＝`bitBrushSize`（`mode-tools.jsx` L115-L121 の BIT_LINE 分岐） | 共通 Size スライダ（T-1 と同じ `brushSize`） | 方式一致方向（値域差は T-1 の max 24 問題に帰着） | 再現（コード。値域は T-1 参照） |

## T-6. フォント（text / bit-text）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| 表示条件 | TEXT・BIT_TEXT 選択中に `FontDropdown` のみ（`mode-tools.jsx` L246-L257）。サイズ入力なし | bitmap text 選択中に `Font size`（8-200）＋フォント select（`BitmapEditor.svelte` L3062-L3075）。vector は `vectorShape === 'text'` のときフォント select＋サイズ（8-144）＋文言入力（L3107-L3118） | 現行はサイズ・文言入力の独自追加。vector の表示条件が `vectorShape`（図形選択状態）基準のため、text ツール選択直後にフォント UI が出るかは要確認 | 条件差は再現（コード）。text ツール直後の表示は未確認（実 DOM では text ツール未選択のため `Vector font` なしを確認） |
| 一覧 | 9 書体（Sans Serif／Serif／Handwriting／Marker／Curly／Pixel／Chinese／Japanese／Korean、`lib/fonts.js` L1-L11）。既定 Sans Serif（`reducers/font.js` L4） | 5 汎用スタック（Sans Serif=Arial／Serif=Georgia／Monospace／Rounded／Condensed、`features/costumes/vector-text.ts` L142-L148）。既定 `Arial, sans-serif`（同 L129）。未知書体は保持（`isUnknownVectorTextFont` 枝、L3071-L3073・L3112-L3114） | **一覧不一致**。参照プロジェクトの Marker/Curly/Pixel/中日韓フォント指定を開いた際の見た目・再編集時の扱いに影響しうる。未知保持はあるが描画フォントの実一致は未確認 | 一覧差は再現（コード）。描画一致は未確認 |
| サイズ範囲 | ツールバーにサイズ UI なし（text-tool 側の扱い。本表では未読のため言及のみ） | bitmap 8-200（L3065）、vector 8-144（L3116）。clamp（`vector-text.ts` L150-L153、MIN 8・MAX 144・500 字・30 行：L130-L133）。bitmap text 既定は `brushSize*4`（`Editor.svelte` L13123 付近。精査未了のため参考値） | 参照のサイズ仕様との対応は未確認 | 未確認 |
| フォント確定操作 | hover で切替＋外側クリックで取消（`containers/font-dropdown.jsx` L121-L139）。選択で undo 記録（L115-L120） | 単純 bind（選択即反映）。取消なし | 操作差あり。誤選択の取消不可は軽微な実害 | 再現（コード） |

## T-7. 選択・削除・複写（select 系。copy/paste/delete/flip）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| copy/paste/delete の表示 | SELECT・BIT_SELECT で copy／paste／delete／flip 群（`mode-tools.jsx` L202-L245）。copy 常時 enabled、paste は `clipboardItems.length > 0` のみ enabled（L214-L220）、delete 常時 enabled（L223-L228、空選択時は全選択して削除：`containers/mode-tools.jsx` L198-L211） | 固定行に常時表示（`BitmapEditor.svelte` L2794-L2828）。copy disabled 条件＝スポイト／テキスト編集中／（vector：対象 0／bitmap：未確定）（L1690-L1695）。paste disabled＝スポイト／テキスト編集中／浮動ドラッグ中／両クリップボード空／（bitmap：未確定）（L1696-L1703）。delete disabled＝vector 無選択／bitmap 無選択・未確定（L2818） | paste の「空で disabled」は一致（実 DOM で空時 disabled を確認）。copy は現行が厳しい（参照は空でも enabled で全件 fallback：`selection-shortcuts.ts` L132-L146 の parity コメント通り現行も fallback 実装）。delete は参照の「空選択→全選択して削除」に対し現行は disabled。**誤全消しの危険が減る方向の差** | paste 空 disabled・delete 無選択 disabled は再現（実 DOM）。copy 空時の fallback 実動は未確認 |
| flip | flip 水平・垂直（選択中。無選択＋bitmap は全体反転：`containers/mode-tools.jsx` L175-L192） | bitmap は全体反転・vector は選択反転（L2824-L2825）。bitmap は未確定時 disabled、vector は無選択時 disabled | 方式一致 | 再現（コード） |
| rotate | mode-tools になし（固定ツールにもなし） | bitmap のみ rotate 左右（`Rotate left/right`、vector では disabled：L2826-L2827。既存 `bitmap-toolbar.test.ts` L96-L101 で固定） | 現行の独自追加。不足なし | 再現（コード） |

## T-8. グループ・重なり順（group/order）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| group/ungroup 条件 | vector のみ。Group：ルート選択 2 件以上（`helper/group.js` L137-L140）。Ungroup：選択中に子を持つ非テキスト Group あり（同 L142-L151） | vector のみ。Group：`selectedVectorObjectIndices.length < 2` で disabled（L2805＝2 件以上で enabled、一致）。Ungroup：`selectedVectorObjectIndex < 0` で disabled（L2806＝何か選択で enabled） | Group 条件は一致。**Ungroup は現行が緩い**（非グループ選択でも enabled）。押下時の実害（noop／空履歴／誤動作）は要検証のため未確認扱い | Group 一致・Ungroup 条件差は再現（コード＋実 DOM の無選択 disabled）。押下結果は未確認 |
| order 条件 | vector のみ。BringForward：選択あり＋末尾に次兄弟あり（`helper/order.js` L55-L61）。SendBackward：選択あり＋先頭に前兄弟あり（同 L47-L53）。Front は BringForward 条件、Back は SendBackward 条件で disabled（`fixed-tools.jsx` L186-L200・L204-L220） | vector のみ＋選択＋コールバックあり（L2812-L2815）。兄弟有無の判定なし | **現行は端（最前面・最背面）でも enabled**。押下が noop 履歴を積むかは要検証のため未確認扱い | 条件差は再現（コード＋実 DOM の無選択 disabled）。押下結果は未確認 |
| resize ハンドル | （本表の対象外。paper 選択枠のハンドル。UI-1/UI-2 の「resize controls」は現行の 8 ハンドル：`BitmapEditor.svelte` L451-L471 ほかを指す。対応表は `scratch-paint-gap-matrix.md` X-2/X-3 を参照） | 単一・複数とも 8 ハンドル＋回転ハンドル（L17398-L17409 付近の props 群。DOM は選択が必要なため未検証） | — | 未確認（実 DOM） |

## T-9. リシェイプ点スタイル（curved / pointed）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| 表示・disabled | RESHAPE 時に Curved／Pointed＋Delete（`mode-tools.jsx` L173-L201）。Curved は未曲線点ありのみ enabled、Pointed は有ハンドル点ありのみ enabled（`containers/mode-tools.jsx` L74-L81、props L214-L216） | RESHAPE 時に Curved／Pointed（`BitmapEditor.svelte` L2832-L2862）。`reshapePointStyle.hasUncurved／hasUnpointed` で disabled（L2845・L2857）。Delete ボタンはなし（Delete キー・固定行の削除で代替） | 条件一致方向。Delete ボタンの有無のみ差（代替手段あり） | 再現（コード）。点選択時の enabled 切替の実 DOM は未確認（選択が必要なため） |

## T-10. 不透明度（opacity）

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| UI の有無 | opacity reducer・UI なし（reducers 一覧に opacity 系なし） | vector のみ slider 0-100（`BitmapEditor.svelte` L3102-L3106）＋ legacy 数値 0-100（`Editor.svelte` L17098）。既定 100（`Editor.svelte` L510） | 現行の独自追加。不足なし。MIXED 表示あり（L3105） | 再現（コード＋実 DOM: `Vector opacity` range 0-100 を確認） |

## T-11. キーボード

| 操作 | 参照（`hocs/keyboard-shortcuts-hoc.jsx`） | 現行（`Editor.svelte` L15677-L15820＋`features/costumes/selection-shortcuts.ts`） | 差・実害 | 状態 |
|---|---|---|---|---|
| Esc | 選択解除（L37-L39） | 選択解除。ただし reshape/leaf ドラッグ中はドラッグ取消優先（L15751-L15767） | 現行が拡張（取消優先）。不足なし | 再現（コード） |
| Delete/Backspace | 削除（L40-L44） | 削除（L15768-L15772）。Ctrl/Cmd 併用時は対象外（単語削除の保護、`selection-shortcuts.ts` L79-L83 コメント） | 一致方向（現行が保護追加） | 再現（コード） |
| Undo/Redo | Ctrl/Cmd+Z／+Shift+Z（L46-L49） | 同左＋Ctrl/Cmd+Y でも redo（`selection-shortcuts.ts` L91-L93） | 現行が拡張。不足なし | 再現（コード） |
| Group/Ungroup | Ctrl/Cmd+G／+Shift+G（`shouldShow`  guard 付き、L51-L59） | 同左。vector 以外では swallow（L15795-L15803） | 一致 | 再現（コード） |
| Copy/Cut/Paste/全選択 | C／X／V／A。V・A は先に select 系へ遷移（`changeToASelectMode` L81-L89：bitmap→BIT_SELECT、vector は SELECT/RESHAPE 以外→SELECT）。X は非空選択時のみ（L65-L73）。A は bitmap 全選択／RESHAPE 全点／他 全項目（L90-L99） | 同一マッピング（`selection-shortcuts.ts` L84-L102）。ただし V・A の遷移は bitmap のみ select へ（L15773-L15793 に bitmap→select のみ。vector paste はツール不変） | **vector paste 時に select へ遷移しない**。brush/fill 選択中の paste で選択物の扱いが参照と異なる可能性。実害の有無は選択物が必要なため未確認 | 遷移差は再現（コード）。実害は未確認 |
| 入力中抑止 | `event.target instanceof HTMLInputElement`（L30-L33）または `textEditing`（textEditTarget≠null、L35）で全抑止 | `isShortcutTypingTarget`（input/textarea/select/contenteditable/role=textbox：`selection-shortcuts.ts` L27-L68）。スポイト中は Undo/Redo 以外 swallow（L15694-L15723） | 現行が広い（select・contenteditable 追加）＋スポイト中保護。不足なし | 再現（コード） |
| 矢印キー | （本表の対象外。`nudge-tool` との対応は `scratch-paint-gap-matrix.md` K-3 を参照） | ズーム連動・Shift 15 倍・keyup 確定（L15805-L15820） | — | 本表では未確認 |

## T-12. 狭幅・RTL・ラベル

| 観点 | 参照 | 現行 | 差・実害 | 状態 |
|---|---|---|---|---|
| 狭幅（<1274） | `fullSizeEditorMinWidth = 1274`（`lib/layout-constants.js` L1-L3）。コスチューム名ラベル非表示（`fixed-tools.jsx` L96-L114 の MediaQuery 分岐）。Front/Back は `More` ドロップダウンへ移動（L203-L293） | ブレークポイントなし。ツールバー行は `overflow-x-auto` で横スクロール（`BitmapEditor.svelte` L2781）。Front/Back は常時表示 | **More 集約なし**。800px 幅でも `Bring to front` が可視（実 DOM 確認）。横スクロールで到達可能なためデータ実害なし。操作性差のみ | 再現（実 DOM: `overflow-x-auto` あり・front 可視を確認） |
| ラベル言語 | `hideLabel(locale)` で ja 等はアイコンのみ＋title（`lib/hide-label.js` L1-L31、ja 含む L13） | アイコンのみ＋aria-label/title が常時（ロケール分岐なし）。固定行の見出しは日本語混在（`コスチューム` L2783、`塗りつぶし` L2877、`枠線` L2939 等） | 方式差。翻訳網羅は `scratch-paint-gap-matrix.md` UI-3 の範囲のため本表では指摘のみ | 再現（コード） |
| RTL | `rtl` で `dir` 切替（`paint-editor.jsx` L61-L64、`layout` reducer） | `resolveTextBaseDirection` 等のテキスト方向対応はあるが、ツールバー全体の `dir` 切替はなし（本表の読取範囲） | 差の実害は未確認 | 未確認 |

## 実 DOM 検証の記録（読み取り専用）

- 方法：`packages/editor` で vite dev を起動し、Chrome（CHROME_BIN 指定、playwright-core 経由）で
  `main-tab-costumes`→`costume-paint-surface` 可視化後、ツールボタンのクリックと
  `aria-label`/`data-testid`/`min`/`max`/`disabled`/`aria-pressed` の読取のみ実施。
  描画ストローク・保存・履歴操作は行っていない（検証スクリプトは `/tmp/toolbar-probe.mjs` に置き、製品 src に残していない）。
- 確認した事実：
  1. vector 既定・vector brush 選択時：`Brush size` 要素なし。`Stroke width` は `min=0 max=48 value=4` で enabled。`Paint color` enabled。
  2. vector line 選択時：fill・stroke・width すべて enabled（参照は fill disabled）。
  3. bitmap brush 時：`Brush size` range `min=1 max=24`。`Stroke width` number `min=0 max=48` で enabled。`Bitmap paint style` select あり。
  4. bitmap rect 選択時：`Stroke width` disabled、`Brush size` enabled、`bitmap-shape-mode-filled` の `aria-pressed=true`。
  5. bitmap text 選択時：`Text font size`（8-200）あり。
  6. 無選択時：Group／Ungroup／Bring to front／Bring forward／Send backward／Send to back すべて disabled。空クリップボードで paste disabled。
  7. 幅 800px：`.overflow-x-auto` あり、`Bring to front` 可視（More 集約なし）。
- やらなかったこと（未確認に残す）：選択物・描画物を要する押下結果
  （Ungroup 緩条件・order 端条件・reshape 有効切替・vector paste 遷移・cut 空時・fill/stroke 変更の描画反映・フォント実描画一致・typed 49-100 の clamp）。
  図形モード agent が同時実装中のため、描画・保存を伴う検証は本表に含めない。

## 未確認に残す項目（再試験の入口）

- U-1：Ungroup 緩条件押下の結果（noop／空履歴／誤 ungroup）。対象：`BitmapEditor.svelte` L2806、`Editor.svelte` の `editVectorObject('ungroup')`。
- U-2：order 端条件押下の結果（noop 履歴の有無）。対象：同 L2812-L2815。
- U-3：vector paste 時のツール遷移差の実害（brush 選択中の paste）。対象：`Editor.svelte` L15789-L15794。
- U-4：LINE 選択中の fill 変更・BRUSH 選択中の stroke/width 変更の描画反映。対象：T-3・T-4。
- U-5：typed 49-100 の stroke 幅の最終 clamp（`updateVectorObjectStrokeWidth` の読取が必要）。
- U-6：reshape Curved/Pointed の enabled 切替の実 DOM（点選択が必要）。
- U-7：フォント 9→5 削減の描画一致・既存 SVG 再編集時の扱い（`vector-text.ts` の未知保持は確認済み、描画比較は未了）。
- U-8：RTL ツールバー全体の `dir` 切替の有無（読取範囲外のため未確認）。
