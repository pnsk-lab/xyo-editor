#include "sound_bank_bridge.hpp"
#include "engine/runtime.hpp"
#include "engine/thread.hpp"
#include "model/target.hpp"
#include <cassert>
#include <memory>
#include <vector>

int main() {
    using namespace xyo;
    Runtime rt;
    auto sprite = std::make_unique<Sprite>(&rt);
    sprite->sounds.emplace_back();
    Target* target = sprite->createClone();
    rt.ownedSprites.push_back(std::move(sprite));
    rt.addTarget(target);
    auto thread = std::make_unique<Thread>("test");
    Thread* th = thread.get();
    th->target = target;
    rt.ownedThreads.push_back(std::move(thread));
    rt.threads.push_back(th);
    std::vector<uint64_t> starts, stops;
    bool succeeds = true;
    web::SoundBankBridge bridge(rt, {
        [&](auto id, Target*, const Sound&) { starts.push_back(id); return succeeds; },
        [&](auto id) { stops.push_back(id); }, {}
    });
    th->status = STATUS_PROMISE_WAIT;
    bridge.playSoundAndWait(target, 0, th);
    auto first = starts.back();
    bridge.complete(first); bridge.pump();
    assert(th->status == STATUS_RUNNING);
    th->status = STATUS_PROMISE_WAIT;
    bridge.playSoundAndWait(target, 0, th);
    auto second = starts.back();
    bridge.complete(first); bridge.pump();
    assert(th->status == STATUS_PROMISE_WAIT);
    bridge.stop(target, 0); bridge.pump();
    assert(stops.back() == second && th->status == STATUS_RUNNING);
    th->status = STATUS_PROMISE_WAIT;
    succeeds = false;
    bridge.playSoundAndWait(target, 0, th);
    bridge.pump(); assert(th->status == STATUS_RUNNING);
    succeeds = true;
    th->status = STATUS_PROMISE_WAIT;
    bridge.playSoundAndWait(target, 0, th);
    auto old = starts.back();
    bridge.forgetThread(th); // host observes external resolution/new wait
    th->status = STATUS_PROMISE_WAIT;
    bridge.complete(old); bridge.pump();
    assert(th->status == STATUS_PROMISE_WAIT);
    auto* clone = target->makeClone();
    rt.addTarget(clone);
    bridge.playSound(clone, 0);
    auto cloneVoice = starts.back();
    bridge.forgetTarget(clone);
    rt.disposeTarget(clone);
    bridge.complete(cloneVoice); bridge.pump();
    assert(stops.back() == cloneVoice);
#ifdef XYO_WAIT_GENERATIONS
    th->beginPromiseWait();
    bridge.playSoundAndWait(target, 0, th);
    auto stale = starts.back();
    th->status = STATUS_RUNNING; // externally resolved
    th->beginPromiseWait();     // another kind of wait
    bridge.complete(stale); bridge.pump();
    assert(th->status == STATUS_PROMISE_WAIT);
#endif
    bridge.shutdown();
    bridge.complete(cloneVoice); bridge.pump();
}
