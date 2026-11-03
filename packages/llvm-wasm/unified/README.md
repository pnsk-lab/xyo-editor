# Unified xyo-cpp runtime (interpreter + LLVM in one Wasm module)

Goal: xyo-cpp's **whole feature set** — interpreter, all engines (motion, pen,
audio, renderer bridge), clones, scheduler — runs as WebAssembly, and
LLVM-compiled scripts run **inside the same runtime instance** instead of being
emulated by another VM.

## Why one module

The previous experimental backend ran admitted scripts through LLVM but fell
back to the editor's TypeScript `ScratchVM`. That is not xyo-cpp: motion, pen,
audio, clones and scheduler semantics came from a different implementation, so
a project mixing compiled and interpreted scripts could disagree between paths.

Running both paths against a single `xyo::Runtime` removes that class of bug:

* variables, sprites, clones and lists are one set of objects
* an LLVM script reads and writes the very same variables the interpreter sees
  (`xyo_llvm_prepare` binds a `JitCtx` to the loaded `Runtime`), so no
  commit-back translation step exists or is needed
* `xyo_browser_snapshot` reports merged state for the editor

## Composition

Built from the pinned xyo checkout plus `packages/xyo-cpp-wasm`'s browser layer:

| Part | Source | Role |
| --- | --- | --- |
| `xyo` static lib | upstream, `XYO_JIT=OFF`, full engines | interpreter + all features |
| real helpers | upstream `src/jit/rt.cpp` | `xyo_varslot_init` / `xyo_to_num` for compiled code |
| browser ABI | `browser.cpp` + bridges (+ `safe_runtime.cpp`) | create/load/green_flag/step/key/mouse/snapshot/renderer/audio |
| LLVM host ABI | `llvm_host_abi.cpp` | dlopen side modules, bind slots, sealed invoke |

The build uses a **disposable patched copy** of the pinned checkout
(`.work/unified-src`): `browser.cpp` and the audio bridge depend on the
reviewed xyo-cpp patches (question ids, wait generations, wait-bubble lifetime,
safe-wasm-runtime hooks). The safe-wasm runtime is compiled in because the
patched engine calls it, but its compiled mode stays **disabled** — the editor
never calls `xyo_browser_set_compiled`, and LLVM is the only compiler path used.

`-sMAIN_MODULE=2` provides `dlopen`/`dlsym`/`dlclose`. The pipeline no longer
inspects a side module's imports: the IR and the linker input are produced by
this project's own toolchain, so an allowlist only duplicated the export list
and forced a manual edit for every new helper. Modules are still validated with
`WebAssembly.validate` before compilation, and bad modules fail closed.

## Execution model

1. The editor splits a project: admitted scripts are removed from what the
   interpreter loads (`splitProjectForLlvm`), so nothing runs twice.
2. `xyo_browser_load_sb3` loads the remainder; the interpreter owns it.
3. `xyo_llvm_prepare(handle, hatId)` creates the session for one admitted hat.
4. `xyo_llvm_expect_slots` → `xyo_llvm_bind_slot` × N → sealed.
5. Green flag: `xyo_browser_green_flag` runs interpreted threads; the editor
   then calls `xyo_llvm_invoke(handle, entry)` for the compiled script.
6. Both mutate the same `Runtime`; the editor reads the merged snapshot.

## Reentrancy

LLVM entry points share `browser.cpp`'s `browserActive` guard through
`xyo_browser_internal_enter/leave`, so neither ABI can re-enter the other
mid-call. Compiled code has no callback path back into these entry points.

## Boundaries

* Admission for compilation is still structural (straight-line set/change
  chains); everything else is interpreted by this same module, not by another VM.
* Side-module unload is refused while its session is alive; sessions release on
  reload/destroy.
* This is not a sandbox: the caller validates bytes, imports and slot metadata.

## Verified (round 1)

`unified/run.sh` builds the module and runs `unified/smoke.mjs` in Node:

| Check | Result |
| --- | --- |
| Interpreter with real control flow (`control_repeat` + nested `change` → 15) | PASS |
| LLVM side module `dlopen` + slot bind + sealed invoke on the same `Runtime` | PASS |
| Same variable visible to the browser snapshot after the compiled write | PASS (`"42"`) |

Artifacts for the run above: `unified_runtime.js`
`1a83d016cfe1faa4d74f41f35c9de65e1f147c168e669dc522d23b91936eeb21`,
`unified_runtime.wasm`
`141164ab50d54e02b1cfae1a46babd0cafe1afc0ba5663299e8a39b0b3708469`.
These identify this build only; they are not a trusted or reproducible-build
guarantee. Existing `llvm-wasm` and editor suites still pass unchanged.

## Verified in the product (round 3)

* `packages/editor/src/lib/xyo-unified-engine.ts` drives this module directly;
  `xyo-unified-backend.ts` adapts it to the editor backend contract and
  `register-xyo.ts` registers it as `xyo-cpp`.
* App e2e (real build, real browser): the admitted `change` script runs on LLVM
  (7→10→13 across two green flags) while the project executes on this runtime,
  and a non-admitted `control_repeat` × 4 × `change 5` project reaches 20 purely
  on the interpreter.
* Harness registry e2e: LLVM script writes `v = 42` while the interpreter moves
  `Sprite1` to `x = 10` in the same snapshot.
* `value` reads in tests must use the live runtime snapshot: the adapter commits
  to the editor model only when the run stops, so `getVariableValue` lags.

## Feature coverage audit (round 4)

`packages/editor/test/xyo-unified-coverage.test.ts` runs the real module:

| Check | Result |
| --- | --- |
| Hand-built case: `data_addtolist` + `data_setvariableto` | variable `"5"` and list `["7"]` both exposed |
| Hand-built case: `looks_say` + `operator_join`/`operator_round` | bubble `hello 3` |
| Corpus: upstream `tests/fixtures/*.sb3` + editor `test-artifacts/*.sb3` (13 files) | all load, green-flag and step 20 frames without error |
| Scheduler: `control_wait 1` between two variable writes | value stays `1` for ~60 frames, becomes `2` afterwards |
| Scheduler: `stop all` during a `forever` loop | the variable stops changing |
| Input: `sensing_mousedown` inside `forever` | becomes true only after a `mouse` call |
| Clones: `control_create_clone_of` with `_myself_` | a clone target appears **and** its `control_start_as_clone` hat writes a global |
| Sound through the engine: `createUnifiedEngine({ audio: true })` | `drain()` yields `open` then `start` with the full 4454-byte WAV |

That corpus covers procedures, clones, broadcasts, pen blocks and non-trivial
assets, so the interpreter path is exercised on real projects rather than only
on synthesised JSON. Lists need no extra plumbing: `browser.cpp` emits them in
the same map tagged `type: "list"`, and `overlayXyoSnapshot` routes them to
`ScratchTarget.lists` (already covered by that module's own tests).

Known gaps found by the audit:

* Collision sensing now works through the host renderer. The remaining piece was
  that the runtime passes `Target::drawableID` into collision callbacks and only
  the SDL renderer ever set it, so every query arrived as `-1`. The module now
  exposes `xyo_browser_set_target_drawable`, and
  `packages/editor/src/lib/xyo-unified-renderer.ts` writes back the id of the
  drawable it created, re-reading the live scene on **every** callback so
  queries see mid-step geometry. Verified: a `touching` block reaches the host
  renderer and its answer drives the script's branch in both directions.
  Pen drawing is wired through the same table but still needs an opt-in pen-sink
  build; geometry is declared `approximate` (no GPU fence, so the stage rectangle
  stands in for `getFenceRect`).
  The adapter now reports capability from the engine (`collision:
  'approximate' | 'none'`), so a project with the bridge attached no longer gets
  the old "collision sensing is not supported" notice.
  App-level verification: two sprites carrying real SVG costumes overlap at the
  origin in the built editor, and `sensing_touchingobject` becomes true through
  the host renderer (`xyo-editor-fallback.browser.test.ts`). An earlier attempt
  looked like a failure but was a test bug: `data_setvariableto` stores a tagged
  string, so the observable value is `"1"`, not `1`.

### Dev-server loading (fixed)

A plain `import('/llvm-artifacts/unified_runtime_esm.mjs')` is rewritten by the
Vite dev server, which refuses to transform `/public` files, so the backend
failed to load in `vite dev` and the editor silently fell back to the built-in
VM. `@vite-ignore` does not suppress that case. The glue is now fetched and
evaluated as a blob module, which bypasses the transform in dev and behaves the
same in a production build; the Wasm binary is always passed explicitly, so the
glue never resolves its own URL. Verified against a real `vite dev` server
(green flag reaches the LLVM value with no fallback notice).

### Segment compilation

The interpreter yields at loop tails and at wait blocks, and a compiled Wasm
function cannot be suspended, so a whole script can only be compiled when it has
no yield point. Segment compilation compiles the yield-free **runs between those
points** and lets the interpreter drive:

* `packages/llvm-wasm/src/segments.ts` finds the maximal runs of plain
  set/change blocks (walking into substacks), and synthesises a single-script
  project for each so the existing compiler accepts it unchanged.
* The runtime keeps a `blocks: blockId -> {entry, blocks}` map
  (`segment-table.patch`) and, in the sequencer, calls the compiled function when
  a thread reaches a run head, then advances by the run length
  (`segment-step-hook.patch`). The function receives the **thread's** `JitCtx`,
  so `xyo_varslot_init` resolves the live variables on every call.
* The engine compiles each run through the normal runner, binds its slots with a
  segment-specific binding (no Thread needed) and registers it.

Verified: a `repeat 3 { set v 1; change v by 1 }` project registers one segment,
the runtime invokes the compiled function (`segmentHits > 0`), and the value the
stub module wrote proves the interpreter did not execute those two blocks.

### Handling xyo-cpp's limits (fixed)

The IR emitter is xyo-cpp's (`src/jit/codegen.cpp`); this project only wraps it
with gates and a toolchain. That means the wrapper must decide what happens when
the emitter, the linker or the host cannot take a script. It used to decide
badly: a compile failure left the split project loaded with an inert hat, so the
script silently never ran — neither compiled nor interpreted.

Compilation now happens before the runtime is touched. If any admitted script
fails to compile, or a slot binding fails, the editor loads the **whole** project
and the interpreter runs it, so a script is never dropped. Verified by a test
that forces compilation to fail: the project still produces its value.

Gates in `metadata-prototype/browser_ir_api.cpp` decide what may be compiled at
all: straight-line `set`/`change`, no `mayYield`, no procedures, `VarId`/`StrLit`
slots only. Everything else stays with the interpreter, which supports the full
block set.

### Input and idle threads (fixed)

Two input bugs surfaced once the editor was driven for real:

* `answerIfQuestion` was missing from the engine, so answering a `sensing_askandwait`
  question threw. It now calls `xyo_browser_answer_if_question` and returns
  whether the answer applied.
* Threads started by a keyboard/mouse hat were never stepped: the backend's tick
  loop stopped as soon as `isRunning()` went false and only restarted on
  `PROJECT_RUN_START`, which the runtime emits for flag starts. It now polls at
  100 ms while idle so hat-started threads are picked up. Verified: pressing
  Space in the built editor runs `when key pressed` and writes the variable.

## Remaining for the whole feature set

1. Attach the renderer bridge (`xyo_browser_renderer_attach`) so collision
   sensing (`touching`) and pen use xyo-cpp's own renderer instead of the
   snapshot-only canvas the editor draws today.
2. Pen works through the renderer bridge (`createPenSkin`/`penClear`/`penLine`)
   and draws real pixels on the app's WebGL stage canvas. The opt-in pen-sink
   build (`XYO_EXPERIMENTAL_PEN_SINK`) is only needed for hosts that consume the
   queued `xyo_browser_pen_*` event stream instead of a renderer.
3. Clone-heavy and scheduler-heavy projects need their own differential checks.
4. Audible playback itself is verified only up to "commands reach Web Audio"
   (decode + buffer source creation); no automated test listens to output.
