#ifndef XYO_WASM_TARGET_STATE_H
#define XYO_WASM_TARGET_STATE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Experimental callback payload, not a runtime/renderer attachment API.
 * Every pointer is borrowed and valid only during the callback. Do not reenter
 * any WASM runtime ABI from the callback. The opaque target pointer is identity
 * only and must not be dereferenced or retained beyond the target lifetime. */
typedef struct xyo_target_state {
    const void *target;
    const char *id;
    int32_t drawable_id, is_stage, is_original, visible;
    double x, y, direction, size;
    int32_t current_costume, layer_order;
    const char *rotation_style;
    /* color, fisheye, whirl, pixelate, mosaic, brightness, ghost */
    double effects[7];
    /* Null/zero when the target has no costume. */
    const char *asset_id, *md5ext, *data_format;
    const uint8_t *asset_data;
    size_t asset_size;
    double bitmap_resolution, rotation_center_x, rotation_center_y;
} xyo_target_state;
typedef void (*xyo_target_state_callback)(void *ctx, const xyo_target_state *state);
/* Called by a C++ integration hook with a live xyo::Target pointer. This does
 * not register hooks, allocate drawables, or manage the Target's lifetime. */
int xyo_target_emit_state(const void *target, xyo_target_state_callback callback, void *ctx);
#ifdef __cplusplus
}
#endif
#endif
