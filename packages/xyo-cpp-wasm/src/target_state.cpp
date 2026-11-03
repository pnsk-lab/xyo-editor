#include "target_state.h"
#include "model/target.hpp"

extern "C" int xyo_target_emit_state(const void* ptr, xyo_target_state_callback callback, void* ctx) {
    if (!ptr || !callback) return 0;
    const auto& t = *static_cast<const xyo::Target*>(ptr);
    xyo_target_state s{};
    s.target = ptr;
    s.id = t.id.c_str();
    s.drawable_id = t.drawableID;
    s.is_stage = t.isStage;
    s.is_original = t.isOriginal;
    s.visible = t.visible;
    s.x = t.x; s.y = t.y; s.direction = t.direction; s.size = t.size;
    s.current_costume = t.currentCostume; s.layer_order = t.layerOrder;
    s.rotation_style = t.rotationStyle.c_str();
    const char* names[] = {"color", "fisheye", "whirl", "pixelate", "mosaic", "brightness", "ghost"};
    for (size_t i = 0; i < 7; ++i) {
        const auto it = t.effects.find(names[i]);
        if (it != t.effects.end()) s.effects[i] = it->second;
    }
    if (const auto* c = t.getCurrentCostume()) {
        s.asset_id = c->assetId.c_str(); s.md5ext = c->md5.c_str();
        s.data_format = c->dataFormat.c_str();
        s.asset_data = c->data.empty() ? nullptr : c->data.data();
        s.asset_size = c->data.size();
        s.bitmap_resolution = c->bitmapResolution;
        s.rotation_center_x = c->rotationCenterX; s.rotation_center_y = c->rotationCenterY;
    }
    callback(ctx, &s);
    return 1;
}
