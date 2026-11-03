# プラグイン

エディタは JavaScript 製のプラグインを読み込み、タブ（ビュー）とランタイムを追加できます。
プラグインは通常の JavaScript としてページと同じ権限で動くため、**信頼できる提供元のものだけ**を追加してください。

## プラグインの形

プラグインは `manifest` と `activate(context)` を持つオブジェクトです。既定エクスポートでも
`export const plugin = ...` でも読み込めます。

```js
export default {
  manifest: {
    id: 'hello',            // 必須。英数字と . _ - のみ
    name: 'Hello',          // 必須
    version: '1.0.0',
    author: 'example',
    description: '設定に表示される説明',
  },
  activate(context) {
    // ここでタブやランタイムを登録する
  },
}
```

`activate` が返した関数、`context.onDispose(...)` で登録した関数、および `tabs` / `runtimes`
への登録は、プラグインを無効化すると自動的に解除されます（逆順で実行）。

## タブとビュー

```js
export default {
  manifest: { id: 'stage-info', name: 'ステージ情報' },
  activate(context) {
    context.tabs.add({
      id: 'info',
      label: 'ステージ情報',
      order: 100, // 小さいほど左。既定は 100（組み込みタブの後）
      icon: (() => {
        const span = document.createElement('span')
        span.textContent = 'ℹ'
        return span
      })(), // 省略時はパズルアイコン
      mount(container, view) {
        const output = document.createElement('pre')
        container.append(output)
        const render = (state) => {
          output.textContent = [
            `テーマ: ${state.theme}`,
            `実行中: ${state.running}`,
            `FPS: ${state.fps}`,
            `スプライト: ${state.snapshot.project.targets.length}`,
            `選択中: ${state.selectedTargetId}`,
          ].join('\n')
        }
        render(view.getState())
        // 戻り値はタブが隠れたとき（別タブへの移動・無効化）に呼ばれる。
        return view.onStateChange(render)
      },
    })
  },
}
```

`mount` はタブが表示されたときに空の `container` を受け取ります。DOM を自由に構築できます
（Svelte などを使う場合はプラグイン側でビルドし、`mount()` を公開してください）。
返した関数はタブが隠れたとき・削除されたときに呼ばれます。

## ランタイムの追加

```js
export default {
  manifest: { id: 'my-runtime', name: 'My Runtime' },
  activate(context) {
    // activate の同期部分で登録すること。起動時に保存済みランタイムを解決するため。
    context.runtimes.register({
      id: 'my-runtime', // 英小文字で始まる [a-z0-9-]
      label: 'My Runtime',
      async load() {
        const { MyVM } = await import('https://example.com/my-vm.js')
        return () => ({ vm: new MyVM(), renderer: /* RendererFacade */ })
      },
    })
  },
}
```

登録したランタイムは「設定 → ランタイム」に表示され、次回起動時に選択できます。
`load()` は選択されたときだけ呼ばれ、返したファクトリがエディタごとの VM/レンダラの組を作ります。
レンダラには組み込みの `ScratchCanvasRenderer` などを利用できます。

## 状態・VM・テーマ

`context` から次にアクセスできます。

| API | 内容 |
| --- | --- |
| `context.vm` | 編集中の VM（`ScratchVM`）。エディタが初回マウントするまでアクセスすると例外。 |
| `context.whenReady()` | エディタが VM を接続したら解決する Promise。 |
| `context.getState()` | 下記の読み取り専用スナップショット。 |
| `context.subscribeState(fn)` | 状態変更の購読。戻り値で解除。 |
| `context.onVmEvent(event, fn)` | VM イベント購読。戻り値で解除。 |
| `context.ui.theme` / `subscribeTheme` | `'light'` / `'dark'`。 |
| `context.ui.setTheme(theme)` / `toggleTheme()` | テーマ変更。 |
| `context.ui.notify(message, kind)` | トースト通知。`kind` は `info` / `success` / `warning` / `error`。 |
| `context.storage.get/set/remove` | `hikkaku.plugin.<id>.<key>` に JSON 保存。 |

`getState()` の形:

```ts
{
  projectTitle: string
  theme: 'light' | 'dark'
  status: string
  fps: number
  running: boolean
  selectedTargetId: string
  stage: { width: number; height: number; fullscreen: boolean }
  snapshot: RuntimeSnapshot // project / targets / threads / monitors ...
}
```

ビュー側では `view.getState()`、`view.onStateChange()`、`view.onThemeChange()`、`view.notify()`
も使えます。テーマは `<html data-theme="...">` と CSS 変数 `--app-surface` / `--app-text` などに
反映されるので、プラグイン UI もそれに追従できます。

## 読み込み方法

- **内蔵**: `main.ts` で `initializeBuiltinPlugins()` を呼び、`src/lib/plugins/index.ts` の `builtinPlugins` を登録。
  現在は `turbowarp`（TurboWarp ランタイムを登録）が内蔵。
- **設定から**: 「設定 → プラグイン → URL からプラグインを追加」で http(s) の ES モジュールを読み込み。
  追加したプラグインは次回起動時にも自動で読み込まれ、設定から無効化・削除できます。

プラグインの有効/無効は `localStorage` の `hikkaku.plugins.disabled`、URL は
`hikkaku.plugins.urls` に保存されます。

## ライブラリとして使う場合

`xyo-editor` をライブラリとして組み込む場合は、プラグインホストを明示的に渡します。

```ts
import { createEditorContext, pluginHost, initializeBuiltinPlugins, renderEditor } from 'xyo-editor'

initializeBuiltinPlugins()
renderEditor(document.getElementById('app')!, createEditorContext({ plugins: pluginHost }))
```

プラグインを自分で登録する場合:

```ts
import { PluginHost, runtimeBackends, createEditorContext, renderEditor } from 'xyo-editor'

const host = new PluginHost({ runtimes: runtimeBackends })
host.install(myPlugin, { source: 'external' })
host.activateAll()
renderEditor(target, createEditorContext({ plugins: host }))
```

1 ページにつき 1 つのエディタと 1 つのホストを想定しています。
