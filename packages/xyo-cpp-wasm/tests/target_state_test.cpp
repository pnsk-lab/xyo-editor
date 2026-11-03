#include "target_state.h"
#include "model/target.hpp"
#include <cassert>
#include <cstring>

// Minimal construction stubs let this unit test the payload without a Runtime.
namespace xyo {
Sprite::Sprite(Runtime* rt) : runtime(rt) {}
Target::Target(Runtime* rt, Sprite* s) : runtime(rt), sprite(s), blocks(nullptr) {}
const Costume* Target::getCurrentCostume() const {
    if (!sprite || sprite->costumes.empty()) return nullptr;
    int i = currentCostume;
    if (i < 0) i = 0;
    if (i >= int(sprite->costumes.size())) i = int(sprite->costumes.size()) - 1;
    return &sprite->costumes[i];
}
}
static void check(void* ctx, const xyo_target_state* s) {
    ++*static_cast<int*>(ctx);
    assert(std::strcmp(s->id, "test") == 0);
    assert(s->drawable_id == 42 && !s->visible && s->x == 17 && s->size == 35);
    assert(s->effects[0] == 12 && s->effects[6] == 33);
    assert(s->asset_id == nullptr && s->asset_data == nullptr && s->asset_size == 0);
}
static void check_costume(void* ctx, const xyo_target_state* s) {
    ++*static_cast<int*>(ctx);
    assert(std::strcmp(s->asset_id, "asset") == 0);
    assert(std::strcmp(s->md5ext, "asset.svg") == 0);
    assert(std::strcmp(s->data_format, "svg") == 0);
    assert(s->asset_size == 2 && s->asset_data[0] == 3 && s->asset_data[1] == 7);
    assert(s->bitmap_resolution == 2 && s->rotation_center_x == 8 && s->rotation_center_y == 9);
}
int main() {
    xyo::Target target(nullptr);
    target.id = "test"; target.drawableID = 42; target.visible = false;
    target.x = 17; target.size = 35; target.effects["color"] = 12; target.effects["ghost"] = 33;
    int calls = 0;
    assert(!xyo_target_emit_state(nullptr, check, &calls));
    assert(!xyo_target_emit_state(&target, nullptr, &calls));
    assert(xyo_target_emit_state(&target, check, &calls) && calls == 1);
    xyo::Sprite sprite(nullptr);
    xyo::Costume costume;
    costume.assetId = "asset"; costume.md5 = "asset.svg"; costume.dataFormat = "svg";
    costume.data = {3, 7}; costume.bitmapResolution = 2;
    costume.rotationCenterX = 8; costume.rotationCenterY = 9;
    sprite.costumes.push_back(std::move(costume));
    target.sprite = &sprite;
    assert(xyo_target_emit_state(&target, check_costume, &calls) && calls == 2);
}
