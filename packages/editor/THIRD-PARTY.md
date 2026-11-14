# Third-party notices

The editor bundles or loads the following third-party components.

## Bundled in `dist`

| Component | License | Notes |
| --- | --- | --- |
| `@hikkaku/vm` | MIT (this repository) | A TypeScript port of the Scratch VM. The original Scratch VM and Scratch GUI are published by the Scratch Foundation under their own licenses; see <https://github.com/scratchfoundation/scratch-vm>. |
| `blockly` | Apache-2.0 | <https://github.com/google/blockly> |
| `paper` | BSD-3-Clause | <https://github.com/paperjs/paper.js> |
| `svelte` | MIT | <https://github.com/sveltejs/svelte> |
| `lucide-svelte` | ISC | <https://github.com/lucide-icons/lucide> |
| `fflate` | MIT | <https://github.com/101arrowz/fflate> |
| `dompurify` | MPL-2.0 OR Apache-2.0 | Used for SVG sanitization (`src/features/costumes/svg-sanitize.ts`). The installed `dompurify@3.4.17` package declares `(MPL-2.0 OR Apache-2.0)` and ships `LICENSE` (Apache-2.0 text) plus `LICENSE-MPL` (MPL-2.0 text): <https://github.com/cure53/DOMPurify> |
| `htmlparser2` (via `@hikkaku/vm`) | MIT | Used for SVG parsing in `@hikkaku/vm`. Its installed `package.json` declares `MIT`: <https://github.com/fb55/htmlparser2>. Transitive dependencies observed in `pnpm-lock.yaml` are `domelementtype` / `domhandler` / `domutils` / `entities` (installed `package.json` files declare `BSD-2-Clause`) and `dom-serializer` (installed `package.json` declares `MIT`). |
| `xyo-cpp` (via `@hikkaku/xyo-cpp-wasm`) | MIT | Copyright (c) 2026 kicky1618. See `packages/xyo-cpp-wasm/LICENSE.upstream`. The upstream project lists additional third-party components. |

## Loaded at runtime (not distributed)

| Component | License | Notes |
| --- | --- | --- |
| TurboWarp Packager Scaffolding | MPL-2.0 | Fetched from jsDelivr only when the TurboWarp runtime is selected: <https://github.com/TurboWarp/packager>. No source is bundled with this package. |

## Media assets

`public/assets-scratch/` contains Scratch media assets used under CC BY-SA 2.0.
See `public/assets-scratch/LICENSE` for the source revision and attribution.

## Experimental LLVM backend (not distributed)

The experimental `xyo-cpp / LLVM` backend expects artifacts generated locally
(see `packages/llvm-wasm`). Those artifacts are not part of this package. If you
redistribute them, include the notices required by LLVM (Apache-2.0 WITH
LLVM-exception), Emscripten, and the upstream `xyo-cpp` licenses.
