# Experimental headless pen sink design

Status: isolated prototype, production disabled. `patches/pen-sink.patch`, `src/pen_sink.hpp`, and `src/pen_event_queue.hpp` provide the native sink and bounded queue; `scripts/test-pen-event-queue.sh` exercises the queue. The browser ABI is compiled only under `XYO_EXPERIMENTAL_PEN_SINK`; the production worker does not enable it. A separate checkout rebuilt using the four production patches current at the start of this round plus the pen patch passed six real-browser tests: line pixels, stop/reflag/clear, project replacement, clone and overflow in the real worker, audio plus ask UI, transactional canvas fault injection, and unsupported stamp. This is an isolated build, not a product build. Native ABI and TypeScript tests also passed. Independent safety review and the product integration decision remain outstanding; do not enable the prototype in production without them.

## Why a separate sink

The existing headless snapshot exposes target state, not pen commands. Comparing target coordinates between snapshots cannot reconstruct pen-down dots, multiple movements within one step, command ordering around clear, or marks made by a clone that has since been deleted.

The existing `RendererBridge` callback table is not a safe substitute. Its callbacks are synchronous, and the current TypeScript callback implementation requests a synchronized scene for each callback. The browser ABI's `BrowserCallGuard` forbids reentering WASM while a runtime operation is active, and a worker cannot synchronously query the main-thread renderer. Furthermore, setting `Runtime::renderer` non-null changes non-pen behavior: for example, target size follows the renderer-dependent skin-size and fencing path. Attaching a stub renderer would therefore alter headless semantics.

## Proposed upstream patch and native queue

Use a separate patch, not `patches/safe-wasm-runtime.patch`, to introduce an optional pen-only sink on `Runtime`; leave the graphics renderer null. Integrate it in the shared pen core in upstream `src/blocks/pen.cpp`:

- `penDownCore`: emit a point after synchronizing the pen color.
- `penOnTargetMoved`: emit a line with old and new Scratch coordinates; preserve the existing forced-movement suppression.
- `penClearCore`: emit a clear command.
- `penStampCore`: mark the current operation unsupported and fail explicitly until a correct same-time drawable/costume capture exists. Do not silently pretend stamp succeeded.

Each command copies its RGBA values, size, and coordinates immediately; never retain a `Target*` or a transient native pointer. Existing clone code copies pen state and the movement hook, so capturing each command at emission preserves marks even after clone deletion. Keep existing renderer behavior unchanged for other embeddings, and explicitly reject or define simultaneous renderer and sink attachment to avoid duplicate output.

The sink is a native bounded FIFO with a sticky error. Append only in native code: no JS callback, host reentry, blocking wait, or main-thread synchronization during execution. Validate numeric values and skin-independent command fields. Queue overflow, malformed/non-finite output, or an unsupported stamp fails the whole operation; discard its batch rather than publishing a partial drawing. This must be surfaced as an error and invalidate the generation, not silently drop commands. The bound also limits per-operation memory use; choose and document the exact limit and test it.

## Browser ABI and worker transport

Have the browser instance own the sink and connect it to each newly loaded candidate runtime, with lifetime extending beyond the runtime. Expose a bounded, checked drain ABI, for example a fixed-layout batch-copy API or count/kind/value/pop accessors. Copy any borrowed memory before another ABI call can invalidate it. Clear stale queues on runtime replacement and teardown. Every relevant operation checks the sticky error immediately after returning from the runtime; failed operations return an explicit error with no partial command batch.

Drain only after WASM has returned. The worker should combine the ordered commands and corresponding snapshot in one response for each flag, step, or input operation that can produce commands. Do not post from within a WASM callback or wait synchronously for the main thread. Associate each batch with the worker/request generation; reject invalid or stale batches and terminate the failed generation. On the main thread validate the entire batch and question identity, successfully overlay the corresponding snapshot, and recheck generation before applying the batch in order via `ScratchCanvasRenderer.penBatchAtomic`, followed by `requestDraw`. The batch method draws on a private canvas and swaps the layer only when all operations succeed; the stage is still painted asynchronously. The `discardPenLayer` replacement-project operation drops the old layer and pending commands synchronously without drawing or allocating a canvas; the following normal stage redraw publishes it. A failure of that later redraw has the same display limitations as any other failed stage redraw.

The command stream is a shared pen layer, not per-target state. A point can be represented as a zero-length line if canvas rendering is verified to match. Explicitly define numeric ranges, color/alpha conversion, queue bounds, ABI versioning, validation, and what happens if delivery or overlay fails before committing any drawing.

## Lifecycle and limitations

- Stop and green flag do not themselves clear already displayed pen marks; only a clear command does. Invalidate and discard undelivered commands from old generations. The main-thread pen layer must outlive a worker restart if marks are to persist.
- A genuine project replacement discards the layer and pending pen data; the implementation distinguishes replacement from a repeated `PROJECT_LOADED` notification by project identity, while preserving ordinary runtime snapshot commits. Backend disposal destroys its renderer. Editing and runtime failure retain already committed ink; further review of failure and commit policy remains necessary.
- In the isolated pen path, a post-commit event-listener or renderer notification exception is fail-stop: the already committed ink and live snapshot are retained, the generation is invalidated, the worker is interrupted, and the operation rejects. This avoids leaving an undelivered question waiting indefinitely; ERROR reporting and question clearing are best effort if their own listeners also throw. A failed committed-state merge keeps the last live snapshot for recovery. A later stage redraw can still fail independently.
- `XyoRuntimeVM` currently commits and restarts with a new worker and SB3 on green flag. SB3 does not itself preserve live pen state: pen-down and attributes do not survive reflag in this prototype even though pixels do. This incompatibility must be resolved or explicitly presented before any production opt-in; do not infer that persistent pixels imply persistent pen state.
- Stamp, collision sensing, picking, and graphics semantics remain unsupported unless separately implemented and validated. Do not imply that the native sink implements them.
- The current safe lowering source has no pen opcode. Interpreter fallback is therefore expected for pen scripts unless compiler support is independently added. Detect and report fallback; do not claim compiled pen execution based solely on selecting compiled mode. The safe compiler and `patches/safe-wasm-runtime.patch` are reserved for another agent and must not be edited as part of this work.

## Validation plan

1. Native tests: point → line → clear and clear → line; repeated movement in one step; RGBA and coordinate value copying; forced movement; clone creation/deletion; stop and flag; renderer/sink exclusivity; instance isolation; unsupported stamp. Exercise the bounded queue limit and verify sticky failure with no partial batch published.
2. Worker/adapter tests: exact FIFO ordering and matching snapshot; invalid payload; stale generation; delayed responses after stop, reflag, editing, replacement, or termination; operation/overlay failure; no WASM-to-host reentry; and no painting from failed or stale batches.
3. Real-editor browser E2E, using the actual worker and built WASM: run flag → pen down → motion → pen up → wait, assert canvas pixels, then clear and verify the pixels are removed. Add clone deletion and reflag/stop cases, including late old-generation messages. Assert fallback telemetry separately from drawing behavior.
4. Compare movement and size behavior with the existing renderer-null headless runtime when no pen commands are emitted. Check pen layer ordering and asynchronous canvas redraw behavior, not merely snapshots or mocked renderer calls.

Use `taskset -c 0-3,8-11` and `CMAKE_BUILD_PARALLEL_LEVEL=4` for CPU work as requested. Give advance notice before a product build.
