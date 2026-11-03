#include "browser.h"
#include "load/zip.hpp"
#include "browser_async_sound.hpp"
#include "engine/runtime.hpp"
#include "model/target.hpp"
#include "renderer_bridge.hpp"
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>
static std::vector<uint8_t> project() {
    std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"sound","inputs":{},"fields":{}},"sound":{"opcode":"sound_playuntildone","next":"set","inputs":{"SOUND_MENU":[1,[10,"beep"]]},"fields":{}},"set":{"opcode":"data_setvariableto","next":null,"inputs":{"VALUE":[1,[4,1]]},"fields":{"VARIABLE":["v","v"]}},"hat2":{"opcode":"event_whenflagclicked","topLevel":true,"next":"stop","inputs":{},"fields":{}},"stop":{"opcode":"sound_stopallsounds","next":null,"inputs":{},"fields":{}}},"costumes":[],"sounds":[{"name":"beep","assetId":"beep","dataFormat":"wav","md5ext":"beep.wav"}],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    xyo::ZipWriter z; z.addFile("project.json", {json.begin(), json.end()}); z.addFile("beep.wav", {1,2,3}); return z.finish();
}
static std::vector<uint8_t> stopAllProject(bool play) {
    const std::string first = play ? "sound" : "stop";
    std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":")" + first + R"(","inputs":{},"fields":{}},"sound":{"opcode":"sound_play","next":"stop","inputs":{"SOUND_MENU":[1,[10,"beep"]]},"fields":{}},"stop":{"opcode":"control_stop","next":null,"inputs":{},"fields":{"STOP_OPTION":["all",null]}}},"costumes":[],"sounds":[{"name":"beep","assetId":"beep","dataFormat":"wav","md5ext":"beep.wav"}],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    xyo::ZipWriter z; z.addFile("project.json", {json.begin(), json.end()}); z.addFile("beep.wav", {1,2,3}); return z.finish();
}
static std::vector<uint8_t> stopPlayingProject() {
    std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"sound","inputs":{},"fields":{}},"sound":{"opcode":"sound_play","next":null,"inputs":{"SOUND_MENU":[1,[10,"beep"]]},"fields":{}},"key":{"opcode":"event_whenkeypressed","topLevel":true,"next":"stop","inputs":{},"fields":{"KEY_OPTION":["space",null]}},"stop":{"opcode":"control_stop","next":null,"inputs":{},"fields":{"STOP_OPTION":["all",null]}}},"costumes":[],"sounds":[{"name":"beep","assetId":"beep","dataFormat":"wav","md5ext":"beep.wav"}],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    xyo::ZipWriter z; z.addFile("project.json", {json.begin(), json.end()}); z.addFile("beep.wav", {1,2,3}); return z.finish();
}
struct Id { uint32_t gen, lo, hi; };
static uint32_t setup(uint32_t timeout) {
    auto b = project(); auto h = xyo_browser_create(); assert(h);
    assert(xyo_browser_load_sb3(h, b.data(), b.size()));
    assert(xyo_browser_set_compiled(h, 1)); assert(xyo_browser_green_flag(h));
    assert(!xyo_browser_audio_session_generation(h));
    assert(xyo_browser_audio_open(h, timeout));
    assert(xyo_browser_audio_session_generation(h));
    assert(!xyo_browser_audio_kind(h));
    assert(xyo_browser_step(h)); return h;
}
static Id getStart(uint32_t h) {
    assert(xyo_browser_audio_kind(h) == 1);
    auto size = xyo_browser_audio_bytes_size(h); assert(size == 3);
    const auto* ptr = xyo_browser_audio_bytes(h);
    std::vector<uint8_t> copy(ptr, ptr + size); // copy before any subsequent ABI call
    assert((copy == std::vector<uint8_t>{1, 2, 3}));
    Id id{xyo_browser_audio_generation(h), xyo_browser_audio_id_lo(h), xyo_browser_audio_id_hi(h)};
    assert(id.gen == xyo_browser_audio_session_generation(h));
    assert(xyo_browser_audio_pop(h)); return id;
}
static void close(uint32_t h, uint32_t gen) {
    assert(!xyo_browser_destroy(h));
    assert(xyo_browser_audio_session_generation(h) == gen);
    assert(xyo_browser_audio_close(h));
    auto bytes = project();
    assert(!xyo_browser_destroy(h));
    assert(!xyo_browser_load_sb3(h, bytes.data(), bytes.size()));
    assert(!xyo_browser_green_flag(h));
    assert(!xyo_browser_audio_detach(h));
    assert(xyo_browser_audio_session_generation(h) == gen);
    assert(xyo_browser_audio_kind(h) == 3);
    assert(!xyo_browser_audio_close_ack(h, gen, 1));
    assert(xyo_browser_audio_pop(h));
    assert(!xyo_browser_audio_close_ack(h, gen+1, 1));
    assert(!xyo_browser_audio_detach(h));
    assert(!xyo_browser_audio_close_ack(h, gen, 0));
    assert(!xyo_browser_audio_detach(h));
    assert(xyo_browser_audio_failed(h) == 1);
    assert(xyo_browser_audio_close_ack(h, gen, 1));
    assert(xyo_browser_audio_detach(h)); assert(!xyo_browser_audio_session_generation(h)); assert(xyo_browser_destroy(h));
}
static uint32_t callbackHandle, otherHandle;
static int draws;
static xyo::wasm::RendererCallbacks renderer() {
    xyo::wasm::RendererCallbacks c;
    c.pick=[](void*,double,double){return -1;};
    c.draw=[](void*) {
        ++draws;
        assert(!xyo_browser_audio_close(callbackHandle));
        assert(!xyo_browser_audio_close_ack(callbackHandle, 1, 1));
        assert(!xyo_browser_audio_stop_ack(callbackHandle, 1, 1, 0, 1));
        assert(!xyo_browser_audio_detach(callbackHandle));
        assert(!xyo_browser_renderer_detach(callbackHandle));
        assert(!xyo_browser_destroy(otherHandle));
        assert(!xyo_browser_create());
        assert(!xyo_browser_audio_kind(callbackHandle));
        assert(!xyo_browser_audio_session_generation(callbackHandle));
        assert(!xyo_browser_answer_if_question(callbackHandle, reinterpret_cast<const uint8_t*>("1"), 1, nullptr, 0));
        assert(!xyo_browser_snapshot(callbackHandle));
    };
    c.drawableTouching=[](void*,int,double,double){return 0;};
    c.isTouchingDrawables=[](void*,int,const int*,size_t){return 0;};
    c.isTouchingColor=[](void*,int,uint32_t){return 0;};
    c.colorTouchingColor=[](void*,uint32_t,uint32_t,int){return 0;};
    c.getDrawableBounds=[](void*,int,double*){};
    c.hasDrawable=[](void*,int){return 0;};
    c.getFencedPosition=[](void*,int,double*,double*,int){};
    c.getCurrentSkinSize=[](void*,int,double*,double*){};
    c.setDrawableOrder=[](void*,int,double,const char*,int){return 0.;};
    c.destroyDrawable=[](void*,int){};
    c.emitVisualChange=[](void*,xyo::Target*){};
    c.drawableOrder=[](void*,size_t* n)->const int*{*n=0; return nullptr;};
    c.drawableOfTarget=[](void*,xyo::Target*){return -1;};
    c.createPenSkin=[](void*){return 0;};
    c.penLine=[](void*,int,const float*,double,double,double,double,double){};
    c.penPoint=[](void*,int,const float*,double,double,double){};
    c.penClear=[](void*,int){}; c.penStamp=[](void*,int,int){};
    c.getFenceRect=[](void*,int,double*){};
    return c;
}
int main() {
    // A real Scratch stop-all is normal completion, including when it discards
    // a Start queued earlier in the same step. It must not masquerade as a
    // transport failure before the owner can drain cancellation.
    for (int compiled = 0; compiled <= 1; ++compiled) for (int play = 0; play <= 1; ++play) for (int attached = 0; attached <= 1; ++attached) {
        auto bytes = stopAllProject(play != 0); auto h = xyo_browser_create(); assert(h);
        assert(xyo_browser_load_sb3(h, bytes.data(), bytes.size()));
        assert(xyo_browser_set_compiled(h, compiled)); assert(xyo_browser_green_flag(h));
        uint32_t gen = 0;
        if (attached) { assert(xyo_browser_audio_open(h, 10)); gen = xyo_browser_audio_session_generation(h); assert(gen); }
        assert(xyo_browser_step(h));
        if (attached) {
            assert(!xyo_browser_audio_failed(h));
            assert(!xyo_browser_step(h)); // closing blocks future execution, without fault
            assert(!xyo_browser_audio_failed(h));
            assert(xyo_browser_audio_kind(h) == 3);
            assert(xyo_browser_audio_generation(h) == gen);
            assert(!xyo_browser_destroy(h)); assert(!xyo_browser_audio_detach(h));
            assert(xyo_browser_audio_pop(h)); assert(xyo_browser_audio_close_ack(h, gen, 1));
            assert(xyo_browser_audio_detach(h));
        }
        assert(xyo_browser_destroy(h));
    }
    {
        auto bytes = stopPlayingProject(); auto h = xyo_browser_create(); assert(h);
        assert(xyo_browser_load_sb3(h, bytes.data(), bytes.size())); assert(xyo_browser_green_flag(h));
        assert(xyo_browser_audio_open(h, 10)); assert(xyo_browser_step(h));
        auto id = getStart(h); // host has received a Start and may be playing
        const uint8_t key[] = {' '}; assert(xyo_browser_key(h, key, 1, 1, 32));
        assert(xyo_browser_step(h)); assert(!xyo_browser_audio_failed(h));
        assert(xyo_browser_audio_kind(h) == 3); assert(xyo_browser_audio_generation(h) == id.gen);
        assert(!xyo_browser_destroy(h)); assert(xyo_browser_audio_pop(h));
        assert(xyo_browser_audio_close_ack(h, id.gen, 1)); assert(xyo_browser_audio_detach(h)); assert(xyo_browser_destroy(h));
    }
    {
        auto bytes = project(); callbackHandle = xyo_browser_create(); otherHandle = xyo_browser_create();
        assert(xyo_browser_load_sb3(callbackHandle, bytes.data(), bytes.size()));
        auto c = renderer(); assert(xyo_browser_renderer_attach(callbackHandle, &c, sizeof(c)));
        assert(xyo_browser_green_flag(callbackHandle));
        assert(xyo_browser_audio_open(callbackHandle, 10));
        assert(xyo_browser_step(callbackHandle)); assert(draws == 1);
        assert(xyo_browser_audio_kind(callbackHandle) == 1);
        auto id = getStart(callbackHandle);
        close(callbackHandle, id.gen); assert(xyo_browser_destroy(otherHandle));
    }
    {
        auto h = setup(10); auto id = getStart(h);
        assert(xyo_browser_audio_kind(h) == 2);
        assert(xyo_browser_audio_stop_ack(h, id.gen, id.lo, id.hi, 1)); // too early, ignored
        assert(xyo_browser_audio_complete(h, id.gen, id.lo, id.hi)); // stopping, ignored
        assert(xyo_browser_step(h));
        assert(std::string(xyo_browser_snapshot(h)).find("\"value\":0") != std::string::npos);
        assert(xyo_browser_audio_pop(h));
        assert(xyo_browser_audio_stop_ack(h, id.gen+1, id.lo, id.hi, 1));
        assert(xyo_browser_step(h));
        assert(std::string(xyo_browser_snapshot(h)).find("\"value\":0") != std::string::npos);
        assert(xyo_browser_audio_stop_ack(h, id.gen, id.lo, id.hi, 1));
        assert(xyo_browser_step(h));
        assert(std::string(xyo_browser_snapshot(h)).find("\"value\":1") != std::string::npos);
        close(h, id.gen);
    }
    {
        auto h = setup(2); auto id = getStart(h);
        assert(xyo_browser_audio_pop(h)); // stop
        assert(xyo_browser_step(h));
        assert(!xyo_browser_step(h)); // timed out => cancel generation
        assert(xyo_browser_audio_failed(h) == 1);
        assert(xyo_browser_audio_kind(h) == 3);
        assert(!xyo_browser_destroy(h));
        assert(xyo_browser_audio_pop(h));
        assert(xyo_browser_audio_close_ack(h, id.gen, 1));
        assert(xyo_browser_audio_detach(h)); assert(!xyo_browser_audio_session_generation(h)); assert(xyo_browser_destroy(h));
    }
    {
        auto h = setup(10); auto id = getStart(h);
        assert(xyo_browser_audio_pop(h));
        assert(xyo_browser_audio_stop_ack(h, id.gen, id.lo, id.hi, 0));
        assert(xyo_browser_audio_failed(h) == 1 && !xyo_browser_step(h));
        assert(xyo_browser_audio_kind(h) == 3);
        assert(xyo_browser_audio_pop(h)); assert(xyo_browser_audio_close_ack(h, id.gen, 1));
        assert(xyo_browser_audio_detach(h)); assert(!xyo_browser_audio_session_generation(h)); assert(xyo_browser_destroy(h));
    }
    {
        auto h = setup(10); auto old = getStart(h);
        assert(xyo_browser_stop(h)); // project stop cancels, never resolves old wait
        assert(xyo_browser_audio_kind(h) == 3); assert(xyo_browser_audio_pop(h));
        assert(xyo_browser_audio_close_ack(h, old.gen, 1)); assert(xyo_browser_audio_detach(h));
        assert(xyo_browser_green_flag(h)); assert(xyo_browser_audio_open(h, 10)); assert(xyo_browser_step(h));
        auto current = getStart(h); assert(current.gen != old.gen);
        assert(xyo_browser_audio_pop(h)); // current stop request
        assert(xyo_browser_audio_stop_ack(h, old.gen, old.lo, old.hi, 1));
        assert(xyo_browser_step(h));
        assert(std::string(xyo_browser_snapshot(h)).find("\"value\":0") != std::string::npos);
        close(h, current.gen);
    }
    {
        xyo::Runtime rt;
        auto sprite = std::make_unique<xyo::Sprite>(&rt); sprite->sounds.emplace_back();
        auto* original = sprite->createClone(); rt.ownedSprites.push_back(std::move(sprite)); rt.addTarget(original);
        xyo::web::BrowserAsyncSound audio(rt, 777, 10);
        auto* clone = original->makeClone(); assert(clone); rt.addTarget(clone);
        clone->sprite->soundBank->playSound(clone, 0);
        assert(audio.front() && audio.front()->kind == xyo::web::BrowserAsyncSound::Start);
        auto id = audio.front()->id; audio.pop();
        rt.disposeTarget(clone); // runtime onTargetRemoved invokes cancellation
        assert(audio.front() && audio.front()->kind == xyo::web::BrowserAsyncSound::Stop);
        audio.pop(); audio.stopAck(777, id, false);
        assert(audio.failed() && audio.front()->kind == xyo::web::BrowserAsyncSound::CancelGeneration);
        audio.pop(); assert(audio.closeAck(777, true));
    }
    {
        xyo::Runtime rt;
        auto sprite = std::make_unique<xyo::Sprite>(&rt); sprite->sounds.emplace_back();
        sprite->sounds[0].data.resize(8 * 1024 * 1024 + 1);
        auto* target = sprite->createClone(); rt.ownedSprites.push_back(std::move(sprite)); rt.addTarget(target);
        xyo::web::BrowserAsyncSound audio(rt, 778, 10);
        target->sprite->soundBank->playSound(target, 0);
        assert(!audio.afterStep() && audio.failed());
        assert(audio.front() && audio.front()->kind == xyo::web::BrowserAsyncSound::CancelGeneration);
        audio.pop(); assert(audio.closeAck(778, true));
    }
    {
        xyo::Runtime rt;
        auto sprite = std::make_unique<xyo::Sprite>(&rt); sprite->sounds.emplace_back();
        auto* target = sprite->createClone(); rt.ownedSprites.push_back(std::move(sprite)); rt.addTarget(target);
        xyo::web::BrowserAsyncSound audio(rt, 779, 10);
        for (int i = 0; i < 257; ++i) target->sprite->soundBank->playSound(target, 0);
        assert(!audio.afterStep() && audio.failed());
        assert(audio.front() && audio.front()->kind == xyo::web::BrowserAsyncSound::CancelGeneration);
        audio.pop(); assert(audio.closeAck(779, true));
    }
    {
        xyo::Runtime rt;
        auto sprite = std::make_unique<xyo::Sprite>(&rt); sprite->sounds.emplace_back();
        sprite->sounds[0].data.resize(8 * 1024 * 1024);
        auto* target = sprite->createClone(); rt.ownedSprites.push_back(std::move(sprite)); rt.addTarget(target);
        xyo::web::BrowserAsyncSound audio(rt, 781, 10);
        target->sprite->soundBank->playSound(target, 0);
        target->sprite->soundBank->playSound(target, 0);
        assert(audio.afterStep()); // exactly 16 MiB is accepted
        target->sprite->soundBank->playSound(target, 0);
        assert(!audio.afterStep() && audio.failed());
        assert(audio.front() && audio.front()->kind == xyo::web::BrowserAsyncSound::CancelGeneration);
        audio.pop(); assert(audio.closeAck(781, true));
    }
    {
        xyo::Runtime rt;
        auto sprite = std::make_unique<xyo::Sprite>(&rt); sprite->sounds.emplace_back();
        auto* target = sprite->createClone(); rt.ownedSprites.push_back(std::move(sprite)); rt.addTarget(target);
        xyo::web::BrowserAsyncSound audio(rt, 780, 2);
        target->sprite->soundBank->playSound(target, 0);
        assert(audio.tick()); assert(!audio.tick()); assert(audio.failed());
        assert(audio.front() && audio.front()->kind == xyo::web::BrowserAsyncSound::CancelGeneration);
        audio.pop(); assert(audio.closeAck(780, true));
    }
    {
        xyo::Runtime rt;
        auto sprite = std::make_unique<xyo::Sprite>(&rt); sprite->sounds.emplace_back();
        auto* original = sprite->createClone(); rt.ownedSprites.push_back(std::move(sprite)); rt.addTarget(original);
        xyo::web::BrowserAsyncSound audio(rt, 782, 10);
        auto* clone = original->makeClone(); rt.addTarget(clone);
        original->sprite->soundBank->playSound(original, 0);
        clone->sprite->soundBank->playSound(clone, 0);
        auto originalId = audio.front()->id; audio.pop(); auto cloneId = audio.front()->id; audio.pop();
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
    }
    std::puts("browser async sound ABI tests passed");
}
