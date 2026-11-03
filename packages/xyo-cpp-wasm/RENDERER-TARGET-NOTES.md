# Experimental Target state payload — not integrated

`src/target_state.h` and `src/target_state.cpp` provide only a synchronous,
borrowed payload for a live upstream `Target`. The callback receives the state
and current costume bytes directly, so it need not and must not call
`runtime.snapshot` or any other runtime ABI from inside a callback. Copy anything
needed after return. The host must never dereference the target identity; it is
valid only while that particular Target lives. No exported browser function
registers this helper, and it does not allocate, synchronize or destroy any
drawable. In particular, building this file alone does **not** make the renderer
bridge functional. It is not part of the current distribution/build script.

## Upstream findings (pinned revision)

* Loading populates targets without creating drawable IDs. `makeClone` copies
  state before `onTargetCreated`, but before the caller adds it to `targets`.
* `Target::setSize` invokes the visual-change hook before assigning `size`;
  other hooks are gated on `visible` (including hide and hidden effects), so
  `RendererAPI::emitVisualChange` is not a reliable synchronization hook.
  Setters must notify after assignment and also when hidden; this includes
  costume/effects/rotation/position, and direct state writes must be audited.
* `stopAll` invokes `onTargetRemoved` before `dispose`; `disposeTarget` does
  the reverse. `dispose` already calls `renderer->destroyDrawable`. Runtime
  destruction directly deletes remaining targets without `dispose`. A correct
  integration must clean up once across all three paths, replacement, detach,
  failed load, and destruction, and reset IDs before exposing another bridge.
* Existing browser load is transactional and attaches the existing renderer to
  the candidate only after load. Initial attachment and successful replacement
  therefore need explicit initialization in layer order; a failed load must
  leave the old renderer/targets untouched. Clone initialization must occur
  before any synchronous collision/fence/pen calls which require drawable IDs.
* `safe-wasm-runtime.patch` modifies `runtime.cpp` and other core files. A
  future renderer patch must be checked both with and without it and compiled
  with compatible feature definitions; the unmodified build script requires a
  clean upstream checkout and applies only the safe patch.

`patches/experimental-target-lifecycle.patch` adds a separate, opt-in C++
observer for initialized clone creation and Target destruction. This is an
observation hook, **not a renderer integration**: it does not create or destroy
drawables, emit state updates, enumerate original targets on attach, or manage
bridge lifetime. Creation is sent after clone fields are copied, before the
existing `onTargetCreated` and clone hats. Deletion is sent by the destructor;
for `disposeTarget`/`stopAll`, existing `dispose()` may already have called
`destroyDrawable`. Destruction can also be reported for targets that did not
produce a creation event (e.g. originals). The observer/context must outlive the
Runtime or be unregistered first. Callbacks must not reenter or mutate runtime
APIs. Do not destroy a drawable unconditionally from the deletion observer.

A complete renderer lifecycle implementation was not supplied: introducing one
without covering all ordering, ownership and mutation cases would falsely
suggest the existing bridge was ready. Asset decoding, skin construction, layer
semantics, callback failure and attach/replacement ownership remain to be
implemented and tested end-to-end before enabling renderer-backed UI.

## Narrow tests

`tests/target_state_test.cpp` uses minimal upstream construction/costume stubs
and checks payload values, missing costume, asset bytes, and invalid arguments.
It is not an upstream runtime or browser integration test. The helper also
compiles as an Emscripten object; this test does not validate attachment or clone
lifecycle. `tests/target_lifecycle_test.cpp` exercises the experimental patch
with an actual native Runtime, including clone disposal, stopAll, and Runtime
destruction. It does not verify drawable resources or browser integration.
