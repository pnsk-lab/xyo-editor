#include "sound_bank_bridge.hpp"
#include "engine/runtime.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include <cassert>
#include <cstdio>
#include <vector>

using namespace xyo;
using Bridge = xyo::web::SoundBankBridge;

static const char* project = R"JSON({"targets":[{"isStage":true,"name":"Stage","variables":{},"lists":{},"broadcasts":{},"blocks":{
"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"sound","inputs":{},"fields":{}},
"sound":{"opcode":"sound_playuntildone","next":"ask","inputs":{"SOUND_MENU":[1,[10,"beep"]]},"fields":{}},
"ask":{"opcode":"sensing_askandwait","next":null,"inputs":{"QUESTION":[1,[10,"hello"]]},"fields":{}}
},"costumes":[],"sounds":[{"name":"beep","assetId":"beep","dataFormat":"wav","md5ext":"beep.wav","rate":44100,"sampleCount":10}],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})JSON";

struct Fixture {
    Runtime rt;
    std::vector<Bridge::Id> started, stopped;
    bool succeeds = true;
    Bridge bridge;
    Target* target;
    Fixture() : bridge(rt, {
        [this](auto id, Target*, const Sound&) { started.push_back(id); return succeeds; },
        [this](auto id) { stopped.push_back(id); }, {}}) {
        assert(loadSb3(rt, project, nullptr).ok);
        target = rt.getTargetForStage();
        assert(target && target->sprite && target->sprite->sounds.size() == 1);
        target->sprite->soundBank = &bridge;
    }
    ~Fixture() { bridge.shutdown(); target->sprite->soundBank = nullptr; }
    Thread* start() {
        rt.greenFlag(); rt.step();
        assert(started.size() == 1 && rt.threads.size() == 1);
        auto* thread = rt.threads.front();
        assert(thread->status == STATUS_PROMISE_WAIT);
        assert(thread->waitGeneration == 1);
        return thread;
    }
};

int main() {
    {
        Fixture f;
        Thread* t = f.start();
        auto id = f.started[0];
        // Simulate an independent external resolver leaving the sound voice live.
        resolveWait(*f.rt.sequencer, *t, Value::undefined());
        f.rt.step(); // actual sensing_askandwait block, not a direct status write
        assert(t->status == STATUS_PROMISE_WAIT && t->waitGeneration == 2);
        f.bridge.complete(id); f.bridge.pump();
        assert(t->status == STATUS_PROMISE_WAIT && t->waitGeneration == 2);
        f.bridge.complete(id); f.bridge.pump();
        assert(t->status == STATUS_PROMISE_WAIT);
    }
    {
        Fixture f;
        Thread* t = f.start();
        f.bridge.stop(f.target, 0);
        // Host stop is synchronous; resolution is deferred to pump.
        assert(f.stopped.size() == 1 && t->status == STATUS_PROMISE_WAIT);
        f.bridge.pump();
        assert(t->status == STATUS_RUNNING);
        f.rt.step();
        assert(t->status == STATUS_PROMISE_WAIT && t->waitGeneration == 2);
        f.bridge.complete(f.started[0]); f.bridge.pump();
        assert(t->status == STATUS_PROMISE_WAIT);
    }
    {
        Fixture f;
        f.succeeds = false;
        Thread* t = f.start();
        f.bridge.pump();
        assert(t->status == STATUS_RUNNING);
        f.rt.step();
        assert(t->status == STATUS_PROMISE_WAIT && t->waitGeneration == 2);
    }
    {
        Fixture f;
        auto sprite = std::make_unique<Sprite>(&f.rt);
        sprite->sounds.emplace_back();
        auto* original = sprite->createClone();
        f.rt.ownedSprites.push_back(std::move(sprite));
        f.rt.addTarget(original);
        auto* clone = original->makeClone();
        assert(clone); f.rt.addTarget(clone);
        f.bridge.playSound(clone, 0);
        auto id = f.started.back();
        f.bridge.forgetTarget(clone);
        f.rt.disposeTarget(clone);
        f.bridge.complete(id); f.bridge.pump();
        assert(f.stopped.size() == 1 && f.stopped[0] == id);
    }
    std::puts("sound runtime block tests passed");
}
