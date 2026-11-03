#include "browser_sound_bridge.hpp"
#include "engine/runtime.hpp"
#include "model/target.hpp"

namespace xyo::web {
namespace {
bool inCallback = false;
struct CallbackGuard {
    CallbackGuard() { inCallback = true; }
    ~CallbackGuard() { inCallback = false; }
};
}
bool inSoundHostCallback() { return inCallback; }
BrowserSoundBridge::BrowserSoundBridge(Runtime& rt, uint32_t generation, BrowserSoundCallbacks callbacks)
    : runtime_(rt), generation_(generation), callbacks_(callbacks),
      bank_(rt, {
        [this](auto id, Target* t, const Sound& sound) {
            CallbackGuard guard;
            return callbacks_.start(callbacks_.context, generation_, uint32_t(id), uint32_t(id >> 32),
                t->id.data(), t->id.size(), sound.data.data(), sound.data.size(),
                sound.dataFormat.data(), sound.dataFormat.size(), t->volume) != 0;
        },
        [this](auto id) {
            CallbackGuard guard;
            callbacks_.stop(callbacks_.context, generation_, uint32_t(id), uint32_t(id >> 32));
        }, {}
      }) {
    for (auto& sprite : rt.ownedSprites) sprite->soundBank = &bank_;
    // These hook slots are exclusively owned by this adapter while attached.
    rt.onProjectStopped = [this] { bank_.reset(); };
    rt.onTargetRemoved = [this](Target* target) { bank_.forgetTarget(target); };
}
BrowserSoundBridge::~BrowserSoundBridge() {
    bank_.shutdown();
    runtime_.onProjectStopped = nullptr;
    runtime_.onTargetRemoved = nullptr;
    for (auto& sprite : runtime_.ownedSprites)
        if (sprite->soundBank == &bank_) sprite->soundBank = nullptr;
}
void BrowserSoundBridge::complete(uint32_t generation, uint32_t lo, uint32_t hi) {
    if (generation == generation_) bank_.complete((uint64_t(hi) << 32) | lo);
}
void BrowserSoundBridge::pump() { bank_.pump(); }
}
