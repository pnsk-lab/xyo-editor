# Disconnected collision-question experiment

Status: **degraded, not integrated**. `src/collision_question_gate.ts` implements
only identity/predecode admission checks and always returns a degraded result,
never a collision boolean. It is not imported by a worker, browser ABI, or build.
`ScratchCanvasRenderer` is not an exact collision backend: it has bounds
fallbacks, sampled pixel tests and other differences. Decoded assets alone do
not make it correct. Do not map degraded to `false` or enable this in the editor.

`src/experimental_pixel_collision.ts` separately tests a mathematical integer-grid
alpha-mask intersection model. It copies already-decoded bytes, uses only the
positions supplied at question time, and explicitly rejects malformed or missing
inputs. Its `ok` result is exact **only for that model**: it cannot establish
Scratch coordinate/raster semantics, detect omitted live targets or stale scenes,
perform decoding, or validate lifecycle/epoch ownership. It is not connected to
the gate, WASM, picking, or the editor; its results must not be used as Scratch
collision answers. Its `unsupported` result must not be converted to `false`.

## Proposed boundary (not implemented)

A native collision question must synchronously send a self-contained view of
all live targets at the exact point of the query, including the subject and
candidate identity, complete costume, transforms, visibility, effects and
relevant scene/layer/pen state. Copy borrowed pointers while the callback is
active. The callback runs on the WASM worker stack; it must not call snapshot,
allocate via an exported runtime ABI, send a message and wait for a response,
or otherwise reenter the runtime. A JavaScript callback returning a Promise is
not a synchronous answer. Predecode every potential costume (including future
costume switches and clone costumes) before entering execution; failed decode,
cache eviction, mismatched content keys, unsupported SVG/effects or rendering
state must prevent an exact answer. Decode completion cannot be awaited from
inside the callback.

A future native adapter must explicitly enumerate originals at attach and issue
unique never-reused serials for clone creation before any query, and remove
exactly once on destruction. Pair serials with an attachment epoch; do not use
Target pointers, names or project IDs as persistent clone IDs. A successful
transactional replacement invalidates the old epoch; failed load must preserve
it. Detach and runtime destruction must clear all identities and caches. The
existing lifecycle patch alone is not sufficient: it lacks attachment ownership,
original enumeration and state synchronization. The gate can only check the
identities it has been told about: it cannot detect a missed lifecycle event or
prove that the native question actually includes every live target.

A future integration additionally needs a proven exact synchronous collision
implementation, a complete state/asset/lifecycle audit, explicit error
propagation that stops or suspends execution rather than fabricating a boolean,
and actual WASM/browser differential tests against Scratch semantics (including
transparent pixels, transformations, ghost effects, hidden targets, clones,
asset loading, project replacement and synchronous motion-then-query). The
current renderer bridge's `sync()` cannot safely call a runtime snapshot ABI
from a renderer callback. Question payloads are intended to avoid that reentry,
not to make asynchronous worker messaging synchronous.
