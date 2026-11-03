#ifndef XYO_BROWSER_H
#define XYO_BROWSER_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Handles are nonzero and local to a module instance. Invalid/stale handles fail.
 * All functions are synchronous and must be called on the owning JS thread.
 * Input pointers must address valid WASM memory. Returned pointers are borrowed
 * until the next browser ABI call, including other handles. Synchronous callback
 * reentry into any browser ABI is rejected module-wide. */
uint32_t xyo_browser_create(void);
int xyo_browser_destroy(uint32_t handle);
/* Loading is transactional: failure leaves the previous project untouched. */
int xyo_browser_load_sb3(uint32_t handle, const uint8_t *bytes, size_t size);
int xyo_browser_green_flag(uint32_t handle);
int xyo_browser_stop(uint32_t handle);
int xyo_browser_step(uint32_t handle);
/* UTF-8 byte strings are length-delimited (no terminator required); NULL is
 * permitted only for an empty answer. key is a DOM KeyboardEvent.key and
 * key_code is its nonnegative keyCode, or -1 when unavailable. */
int xyo_browser_key(uint32_t handle, const uint8_t *key, size_t size, int is_down, int key_code);
/* Coordinates are canvas-local CSS pixels, not Scratch coordinates. Width and
 * height must be positive. button is a DOM button number. Each mouse event
 * updates both position and button state. Without a renderer, picking selects the stage. */
int xyo_browser_mouse(uint32_t handle, double x, double y, double width, double height, int is_down, int button, int was_dragged);
int xyo_browser_wheel(uint32_t handle, double delta_x, double delta_y);
int xyo_browser_answer(uint32_t handle, const uint8_t *answer, size_t size);
/* question_id is the exact decimal UTF-8 snapshot io.questionId. Returns 1
 * if applied, -1 if stale/no question (no answer side effects), 0 on error.
 * IDs are never reused during this handle's lifetime, including reload/stop. */
int xyo_browser_answer_if_question(uint32_t handle, const uint8_t *question_id, size_t id_size, const uint8_t *answer, size_t size);
/* Install a copied wasm32 RendererCallbacks table (renderer_bridge.hpp).
 * size must equal sizeof(RendererCallbacks); table must be aligned and point to
 * valid memory. All callbacks are mandatory and synchronous. The host owns ctx,
 * callback functions and their referenced resources until detach, replacement,
 * or destruction returns. Callbacks must not reenter this runtime's C ABI.
 * Attach is transactional; load preserves the attachment, including on failure.
 * This bridge does not create/sync drawable identities, costumes or assets:
 * the host must supply those; this is not a complete renderer integration.
 * Detach is idempotent. Null/missing callbacks are rejected, but nonzero function
 * table indices and signatures must be valid and kept alive by the caller. */
int xyo_browser_renderer_attach(uint32_t handle, const void *table, size_t size);
int xyo_browser_renderer_detach(uint32_t handle);
/* Isolated opt-in prototype: exported only in XYO_EXPERIMENTAL_PEN_SINK builds.
 * enable is permitted before project load, is mutually exclusive with the graphics
 * renderer, and cannot be reset after failure. count is -1 on error. Read a full
 * batch before consume; no prefix is available after overflow or unsupported stamp.
 * kind: 1 point, 2 line, 3 clear. Fields 0..3 RGBA, 4 diameter, 5..8 coordinates.
 * All numbers are copied through scalar returns; never retain native pointers. */
int xyo_browser_pen_enable(uint32_t handle);
int xyo_browser_pen_count(uint32_t handle);
int xyo_browser_pen_kind(uint32_t handle, uint32_t index);
double xyo_browser_pen_value(uint32_t handle, uint32_t index, uint32_t field);
int xyo_browser_pen_consume(uint32_t handle);
/* Experimental nonblocking sound command queue. Open after green_flag and
 * before step; close, drain cancel-generation, ACK, then detach before reload,
 * green_flag or destroy. Command pointers expire at the next browser ABI call.
 * Read lengths first, then copy each pointer immediately. Host must
 * tombstone cancelled generations and ACK only after stopping their voices.
 * Continue ticking while not stepping and enforce an independent wall-clock
 * watchdog. On failure, worker loss or ambiguous transport delivery, stop
 * stepping and cancel all voices for the external worker/module epoch; never
 * rely on this module to cancel after worker loss. Failed or missing cancel ACK
 * forbids detach and destruction until a later successful ACK. A normal
 * script stop-all returns success for that step and queues cancellation;
 * subsequent tick/step calls return 0 while closing. Check audio_failed to
 * distinguish normal closing from fault; drain cancellation in either case. */
int xyo_browser_audio_open(uint32_t, uint32_t);
/* Nonzero from open through detach; 0 when no session is attached. */
uint32_t xyo_browser_audio_session_generation(uint32_t);
int xyo_browser_audio_close(uint32_t);
int xyo_browser_audio_detach(uint32_t);
int xyo_browser_audio_tick(uint32_t);
int xyo_browser_audio_failed(uint32_t);
uint32_t xyo_browser_audio_kind(uint32_t);
uint32_t xyo_browser_audio_generation(uint32_t);
uint32_t xyo_browser_audio_id_lo(uint32_t);
uint32_t xyo_browser_audio_id_hi(uint32_t);
const uint8_t *xyo_browser_audio_bytes(uint32_t);
size_t xyo_browser_audio_bytes_size(uint32_t);
const char *xyo_browser_audio_format(uint32_t);
const char *xyo_browser_audio_target(uint32_t);
double xyo_browser_audio_volume(uint32_t);
double xyo_browser_audio_pitch(uint32_t);
double xyo_browser_audio_pan(uint32_t);
int xyo_browser_audio_pop(uint32_t);
int xyo_browser_audio_complete(uint32_t, uint32_t, uint32_t, uint32_t);
int xyo_browser_audio_stop_ack(uint32_t, uint32_t, uint32_t, uint32_t, int);
int xyo_browser_audio_close_ack(uint32_t, uint32_t, int);
/* UTF-8 JSON, or NULL for an invalid handle. Snapshot is headless state only. */
const char *xyo_browser_snapshot(uint32_t handle);
const char *xyo_browser_error(uint32_t handle);
/* Bit 0: interpreter; bit 1: restricted green-flag WASM compiler available.
 * Unsupported scripts, CSP rejection and unsafe values fall back to interpreter.
 * Enable is per handle and defaults to false; counters are cumulative across
 * all handles within this module instance, not per runtime. */
uint32_t xyo_browser_capabilities(void);
int xyo_browser_set_compiled(uint32_t handle, int enabled);
/* 0 or 1; -1 for an invalid handle. */
int xyo_browser_compiled_enabled(uint32_t handle);
uint32_t xyo_browser_compile_attempts(void);
uint32_t xyo_browser_compile_successes(void);
uint32_t xyo_browser_compiled_executions(void);
uint32_t xyo_browser_compile_fallbacks(void);
uint32_t xyo_browser_compiled_live_modules(void);
#ifdef __cplusplus
}
#endif
#endif
