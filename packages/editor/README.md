# Hikkaku Scratch Editor

Clean-room Scratch-compatible editor package for the implementation workspace.

The editor is built with Svelte, Vite, Tailwind CSS v4, Blockly, and the local
`@hikkaku/vm` package. It owns the browser UI: stage controls, sprite and
costume selectors, block workspace integration, paint editing, sound editing,
asset import, and VM event binding.

## Runtime selection

In the standalone editor, open Settings → ランタイム and choose the runtime.
The selection is saved for the next launch; save the project before reloading.
TurboWarp is loaded on demand from the version-pinned official TurboWarp Packager
Scaffolding distribution on jsDelivr. It requires network access and WebGL.
If the distribution cannot be loaded at startup, the editor falls back to the
built-in VM. The TurboWarp adapter is experimental: editing a project while it is
running stops its scripts and reloads the edited project, clearing clones, pen drawings,
and extension runtime state. Some VM facade methods
and synchronous reporter return values are not fully compatible; reporter results
are delivered as events. SB2 bitmap conversion and video input are not configured.

The xyo-cpp / LLVM backend is under development and cannot currently be selected
for execution. The former xyo-cpp Wasm emitter/interpreter backend is intentionally
not loaded. A saved `xyo-cpp` selection reports that LLVM is not ready and falls
back to the built-in VM; it must not be mistaken for LLVM compilation.

Hosts can register additional VM/renderer pairs with `RuntimeBackendRegistry` and
pass a pair to `createEditorContext({ backend })`. Backends declare whether they
own their execution loop; only the built-in backend supports the existing worker.

## Plugins

Plugins are plain JavaScript modules that can add tabs with arbitrary views and
register runtimes. The TurboWarp integration is a built-in plugin; its runtime is
registered through the same API that third-party plugins use. Open
Settings → プラグイン to enable/disable plugins or install one from a URL.

See [PLUGINS.md](./PLUGINS.md) for the API and examples.

## Development

```sh
pnpm dev
pnpm check
pnpm build
pnpm test:browser
```

The primary application shell lives in `src/App.svelte`.

### Browser tests

Browser tests drive a real Chromium through `playwright-core`, which does not
ship a browser. Point `CHROME_BIN` at a Chrome/Chromium executable (or install
one for Playwright); without it the launcher falls back to the `chrome` and
`chromium` channels.

Tests for the experimental runtimes are opt-in and additionally skip themselves
when the artifacts they need are missing:

| Environment variable | Requires |
| --- | --- |
| `XYO_CPP_WASM_BROWSER_TEST=1` | `packages/xyo-cpp-wasm/.work/build-wasm` |
| `XYO_WASM_TEST=1` | `packages/xyo-cpp-wasm/.work/build-wasm` |
| `XYO_WORKER_BROWSER=1` | `packages/xyo-cpp-wasm/.work/build-wasm` |
| `XYO_PEN_ISOLATED_BROWSER=1` | `packages/xyo-cpp-wasm/.work/pen-validation-latest` |
| `XYO_LLVM_COMPILER_BROWSER=1` | `pnpm run pack:llvm` output |
| `XYO_FALLBACK_BROWSER=1` | `pnpm run pack:llvm` output |
| `TURBOWARP_CDN_TEST=1` | network access and WebGL |

`pnpm run pack:llvm` copies locally built LLVM-in-Wasm artifacts into
`public/llvm-artifacts` (gitignored) for the experimental backend.

### GitHub Pages

`pnpm build` honours `--base`, so the site can be served from a subpath:

```sh
pnpm exec vite build --base=/xyo-editor/
```

The public asset URLs (`assets-scratch`, `llvm-artifacts`) go through
`src/lib/asset-url.ts` for that reason.
