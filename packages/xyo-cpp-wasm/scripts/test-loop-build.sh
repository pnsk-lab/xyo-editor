#!/usr/bin/env bash
# Isolated OFF -> ON -> OFF build.sh and artifact smoke test.
# Requires an activated Emscripten SDK, CMake, Node, Python, and Playwright.
# The checkout/build/artifacts below are private; no product .work is patched.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$(cd "$root/../.." && pwd)"
revision=93c80a4bcc007284cdede0b927ec310145eaa0b5
repo="$root/.work/xyo-cpp"
git -C "$repo" cat-file -e "$revision^{commit}"
work="$(mktemp -d "$root/.work/loop-build-test.XXXXXXXX")"
echo "Isolated test directory: $work"
mkdir -p "$work/scripts" "$work/.work"
cp "$root/scripts/build.sh" "$work/scripts/build.sh"
cp -a "$root/src" "$root/patches" "$work/"
cp "$root/browser.cpp" "$root/browser.h" "$work/"
printf '{"type":"commonjs"}\n' > "$work/package.json"
git clone -q --no-hardlinks --no-checkout "$repo" "$work/.work/xyo-cpp"
git -C "$work/.work/xyo-cpp" checkout -q --detach "$revision"
python3 - "$root/tests/loop_fixture_project.json" "$work/loop.sb3" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write(sys.argv[1], 'project.json')
PY
check_clean() {
  test -z "$(git -C "$work/.work/xyo-cpp" status --porcelain --untracked-files=all)"
}
XYO_WASM_LOOP_EXPERIMENT=0 bash "$work/scripts/build.sh"
check_clean
cp "$work/.work/build-wasm/xyo-browser.js" "$work/default-browser.js"
cp "$work/.work/build-wasm/xyo-browser.wasm" "$work/default-browser.wasm"
XYO_WASM_LOOP_EXPERIMENT=1 bash "$work/scripts/build.sh"
check_clean
(cd "$workspace" && node "$root/tests/loop_browser_artifact_test.cjs" "$work" "$work/loop.sb3")
XYO_WASM_LOOP_EXPERIMENT=0 bash "$work/scripts/build.sh"
check_clean
(cd "$workspace" && node "$root/tests/loop_browser_artifact_test.cjs" "$work" "$work/loop.sb3" off-only)
echo 'isolated OFF ON OFF and rollback: PASS'
