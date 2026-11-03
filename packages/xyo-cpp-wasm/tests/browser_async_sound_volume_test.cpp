#include "browser_async_sound.hpp"
#include "engine/runtime.hpp"
#include "model/target.hpp"
#include <cassert>
#include <cstdio>

int main() {
    xyo::Runtime rt;
    auto sprite = std::make_unique<xyo::Sprite>(&rt); sprite->sounds.emplace_back();
    auto* original = sprite->createClone(); rt.ownedSprites.push_back(std::move(sprite)); rt.addTarget(original);
    xyo::web::BrowserAsyncSound audio(rt, 782, 10);
    auto* clone = original->makeClone(); rt.addTarget(clone);
    original->soundEffects["pitch"] = 120;
    original->soundEffects["pan"] = -100;
    // Clone inherits at creation; subsequent state changes are isolated.
    clone->soundEffects["pitch"] = -120;
    original->sprite->soundBank->playSound(original, 0);
    clone->sprite->soundBank->playSound(clone, 0);
    assert(audio.front()->pitch == 120 && audio.front()->pan == -100);
    auto originalId = audio.front()->id; audio.pop();
    assert(audio.front()->pitch == -120 && audio.front()->pan == 0);
    auto cloneId = audio.front()->id; audio.pop();
    clone->soundEffects["pitch"] = 360; clone->soundEffects["pan"] = 100;
    assert(audio.afterStep());
    assert(audio.front()->kind == xyo::web::BrowserAsyncSound::Effects && audio.front()->id == cloneId);
    assert(audio.front()->pitch == 360 && audio.front()->pan == 100); audio.pop();
    assert(!audio.front());
    clone->volume = 40; assert(audio.afterStep());
    assert(audio.front()->kind == xyo::web::BrowserAsyncSound::Volume && audio.front()->id == cloneId);
    clone->volume = 25; assert(audio.afterStep()); assert(audio.front()->volume == 25); audio.pop();
    assert(!audio.front());
    rt.disposeTarget(clone); assert(audio.front()->kind == xyo::web::BrowserAsyncSound::Stop);
    assert(audio.afterStep()); audio.pop(); audio.complete(782, cloneId); audio.stopAck(782, cloneId, true);
    original->volume = 60; assert(audio.afterStep());
    assert(audio.front()->kind == xyo::web::BrowserAsyncSound::Volume && audio.front()->id == originalId);
    audio.pop(); audio.complete(782, originalId); original->volume = 70; assert(audio.afterStep()); assert(!audio.front());
    audio.close(); audio.pop(); assert(audio.closeAck(782, true));
    std::puts("browser async volume tests passed");
}
