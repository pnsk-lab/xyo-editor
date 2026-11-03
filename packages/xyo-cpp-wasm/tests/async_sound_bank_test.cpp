#include "async_sound_bank.hpp"
#include "engine/runtime.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include <cassert>
#include <cstdio>
#include <vector>
using namespace xyo;
using Bank = xyo::web::AsyncSoundBank;
static const char* project = R"({"targets":[{"isStage":true,"name":"Stage","variables":{},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"sound","inputs":{},"fields":{}},"sound":{"opcode":"sound_playuntildone","next":"ask","inputs":{"SOUND_MENU":[1,[10,"beep"]]},"fields":{}},"ask":{"opcode":"sensing_askandwait","next":null,"inputs":{"QUESTION":[1,[10,"hello"]]},"fields":{}}},"costumes":[],"sounds":[{"name":"beep","assetId":"beep","dataFormat":"wav","md5ext":"beep.wav"}],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
struct Fixture {
    Runtime rt;
    std::vector<Bank::Id> starts, stops;
    std::vector<std::pair<Bank::Id, double>> volumes;
    bool allowStop = true;
    Bank bank;
    Target* target;
    Fixture() : bank(rt, 42, {
        [this](uint32_t gen, auto id, Target*, const Sound&) { assert(gen == 42); starts.push_back(id); return true; },
        [this](uint32_t gen, auto id) { assert(gen == 42); stops.push_back(id); return allowStop; },
        {}, [this](uint32_t gen, auto id, double volume) { assert(gen == 42); volumes.emplace_back(id, volume); return true; }}) {
        assert(loadSb3(rt, project, nullptr).ok);
        target = rt.getTargetForStage(); target->sprite->soundBank = &bank;
    }
    ~Fixture() { bank.invalidate(); target->sprite->soundBank = nullptr; }
    Thread* start() {
        rt.greenFlag(); rt.step();
        assert(starts.size() == 1 && rt.threads.size() == 1);
        Thread* th = rt.threads[0]; assert(th->status == STATUS_PROMISE_WAIT); return th;
    }
};
int main() {
    {
        Fixture f; Thread* th = f.start(); auto id = f.starts[0];
        f.bank.stop(f.target, 0); assert(f.stops.size() == 1);
        f.bank.complete(42, id); f.bank.stopAck(41, id, true);
        assert(f.bank.pump() && th->status == STATUS_PROMISE_WAIT);
        f.bank.stopAck(42, id, true); assert(f.bank.pump());
        assert(th->status == STATUS_RUNNING);
        f.rt.step(); assert(th->status == STATUS_PROMISE_WAIT && th->waitGeneration == 2);
        f.bank.stopAck(42, id, true); f.bank.complete(42, id); assert(f.bank.pump());
        assert(th->status == STATUS_PROMISE_WAIT);
    }
    {
        Fixture f; Thread* th = f.start(); auto id = f.starts[0];
        f.bank.stop(f.target, 0); f.bank.stopAck(42, id, false);
        assert(f.bank.failed() && !f.bank.pump() && th->status == STATUS_PROMISE_WAIT);
        f.bank.invalidate(); f.bank.stopAck(42, id, true);
        assert(!f.bank.pump() && th->status == STATUS_PROMISE_WAIT);
    }
    {
        Fixture f; Thread* th = f.start(); f.allowStop = false;
        f.bank.stop(f.target, 0);
        assert(f.bank.failed() && !f.bank.pump() && th->status == STATUS_PROMISE_WAIT);
    }
    {
        Fixture f; Thread* th = f.start(); auto id = f.starts[0];
        f.bank.complete(42, id); assert(f.bank.pump());
        assert(th->status == STATUS_RUNNING);
    }
    {
        Fixture f;
        auto sprite = std::make_unique<Sprite>(&f.rt);
        sprite->sounds.emplace_back();
        Target* original = sprite->createClone();
        f.rt.ownedSprites.push_back(std::move(sprite)); f.rt.addTarget(original);
        Target* clone = original->makeClone(); assert(clone); f.rt.addTarget(clone);
        f.bank.playSound(clone, 0); auto id = f.starts.back();
        f.bank.forgetTarget(clone); f.rt.disposeTarget(clone);
        assert(f.stops.size() == 1 && !f.bank.failed());
        f.bank.stopAck(42, id, false); // failure after target destruction is fatal
        assert(f.bank.failed() && !f.bank.pump());
    }
    {
        Runtime rt; assert(loadSb3(rt, project, nullptr).ok);
        auto* target = rt.getTargetForStage(); int starts = 0;
        Bank bank(rt, 43, {
            [&](uint32_t, auto, Target*, const Sound&) { ++starts; return false; },
            {}, [] { return false; }});
        bank.playSound(target, -1); // missing asset is not transport failure
        bank.playSound(target, 0); // ordinary certain-not-started rejection
        assert(starts == 1 && !bank.failed() && bank.pump());
        bank.playSound(target, 0); assert(starts == 2 && !bank.failed());
    }
    {
        Runtime rt; assert(loadSb3(rt, project, nullptr).ok);
        auto* target = rt.getTargetForStage(); int starts = 0;
        Bank bank(rt, 44, {
            [&](uint32_t, auto, Target*, const Sound&) { ++starts; return false; },
            {}, [] { return true; }});
        bank.playSound(target, -1); assert(!bank.failed() && starts == 0);
        bank.playSound(target, 0); assert(bank.failed() && starts == 1);
        for (int i = 0; i < 1000; ++i) bank.playSound(target, 0);
        assert(starts == 1 && !bank.pump());
    }
    {
        Fixture f; f.start(); const auto id = f.starts[0];
        f.target->volume = 23; assert(f.bank.syncVolumes());
        assert(f.volumes.size() == 1 && f.volumes[0].first == id && f.volumes[0].second == 23);
        assert(f.bank.syncVolumes() && f.volumes.size() == 1);
        f.bank.stop(f.target, 0); f.target->volume = 30;
        assert(f.bank.syncVolumes() && f.volumes.size() == 1);
        f.bank.complete(42, id); assert(f.bank.pump());
        f.bank.stopAck(42, id, true); assert(f.bank.pump());
    }
    std::puts("async sound ACK tests passed");
}
