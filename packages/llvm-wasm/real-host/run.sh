#!/usr/bin/env bash
# Run from any directory. All generated fixture/build outputs stay in real-host/build.
set -euo pipefail
cd "$(dirname "$0")/../../.."
source packages/xyo-cpp-wasm/.work/emsdk/emsdk_env.sh >/dev/null 2>&1
export PATH="$PWD/packages/xyo-cpp-wasm/.work/tools/bin:$PATH"
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
out="$PWD/packages/llvm-wasm/real-host/build"
node="$PWD/packages/xyo-cpp-wasm/.work/emsdk/node/24.19.0_64bit/bin/node"
bin="$PWD/packages/xyo-cpp-wasm/.work/llvm19-proof/wasm/bin"
compiler="$PWD/packages/llvm-wasm/.work/metadata-build"
emcmake cmake -G Ninja -S packages/llvm-wasm/real-host -B "$out" -DXYO_SOURCE="$PWD/packages/xyo-cpp-wasm/.work/xyo-cpp"
cmake --build "$out"
cp "$out/real_host.js" "$out/real_host.cjs"
cp "$compiler/xyo_browser_ir.js" "$out/metadata_compiler.cjs"
cp "$compiler/xyo_browser_ir.wasm" "$out/metadata_compiler.wasm"
python3 packages/llvm-wasm/prototype/smoke-fixture.py "$out/fixtures"
bun build packages/llvm-wasm/src/index.ts --target=browser --outfile "$out/pipeline-index.mjs"
bun build packages/llvm-wasm/src/worker.ts --target=browser --outfile "$out/pipeline-worker.mjs"
sha256sum "$out/real_host.js" "$out/real_host.wasm" "$out/metadata_compiler.cjs" "$out/metadata_compiler.wasm"
"$node" packages/llvm-wasm/real-host/smoke.cjs "$out/real_host.cjs" "$out/real_host.wasm" "$out/fixtures"
"$node" packages/llvm-wasm/real-host/side-test.cjs "$out/real_host.cjs" "$out/real_host.wasm" "$out/fixtures/valid.sb3" "$out/metadata_compiler.cjs" "$out/metadata_compiler.wasm" "$bin/llc.js" "$bin/lld.js" string
cp "$out/parent.wasm" "$out/reference.wasm"
"$node" packages/llvm-wasm/real-host/side-test.cjs "$out/real_host.cjs" "$out/real_host.wasm" "$out/fixtures/change.sb3" "$out/metadata_compiler.cjs" "$out/metadata_compiler.wasm" "$bin/llc.js" "$bin/lld.js" number:0x4045000000000000 d6a576161c49544b2da4ed33ffcdfe337eea81f83716093afb7b9f7f21a85b3d 465c7e09505fbdf220ad0fd67825a78485dfe66b27dda5c56e31d683529a50ca b785ed248aa8711076f02054e3bcb2eff28f3a9293c5171f473682fe85813fc2 "$out/fixture-change.sha256"
"$node" packages/llvm-wasm/real-host/side-test.cjs "$out/real_host.cjs" "$out/real_host.wasm" "$out/fixtures/chain.sb3" "$out/metadata_compiler.cjs" "$out/metadata_compiler.wasm" "$bin/llc.js" "$bin/lld.js" chain:0x4036000000000000 6f325737eab2cd68746228f09272496b63f3719f69034326f9845340b9c3feab e9e0cca00923e713046495cf2a33d916dc5d22d57599fb841efba0d4f35b9ebc 64d489d9ecc6daaa6110d5518870080fbb0bbedb1b62a13ecfae0792fd261e24 "$out/fixture-chain.sha256"
"$node" packages/llvm-wasm/real-host/side-test.cjs "$out/real_host.cjs" "$out/real_host.wasm" "$out/fixtures/twovars.sb3" "$out/metadata_compiler.cjs" "$out/metadata_compiler.wasm" "$bin/llc.js" "$bin/lld.js" 'multivar:{"76":{"str":[49,48]},"77":{"str":[50,48]}}' d71040146a23ba34ffa142e7461035c8833a2b8eab4cea84c5a65d5899155254 5a4606f78e9f3680c39d5b352e0e8de509e0cf4f6b96d37262010fbab3f3b137 97808105cb8af625512d801367b0636794ed9f451be74f26d22192f8a964aa49 "$out/fixture-twovars.sha256"
"$node" packages/llvm-wasm/real-host/side-stress.cjs "$out/real_host.cjs" "$out/real_host.wasm" "$out/fixtures/valid.sb3" "$out/reference.wasm"
"$node" packages/llvm-wasm/real-host/browser-test.cjs
