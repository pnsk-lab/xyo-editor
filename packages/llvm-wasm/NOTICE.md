# Third-party notices for `@hikkaku/llvm-wasm`

This package contains only original source code and build scripts. It does not
distribute LLVM or Emscripten binaries: everything the scripts download or
build lives under `.work/` and is ignored by Git.

Building the experimental backend downloads and links:

| Component | Version used | License |
| --- | --- | --- |
| LLVM / LLD | 19.1.7 | Apache-2.0 WITH LLVM-exception (<https://llvm.org/LICENSE.txt>) |
| Emscripten SDK | 6.0.12 | MIT / UIUC (<https://github.com/emscripten-core/emscripten/blob/main/LICENSE>) |
| `xyo-cpp` | pinned revision, see `packages/xyo-cpp-wasm/README.md` | MIT, plus the third-party components listed by upstream |

If you redistribute the generated `llc-browser.wasm` / `lld-browser.wasm` or any
other LLVM-derived artifact, include a copy of the LLVM license and the LLVM
NOTICE file, and keep the Emscripten and `xyo-cpp` notices alongside it.
