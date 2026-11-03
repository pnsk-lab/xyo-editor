#include "engine/runtime.hpp"
#include "engine/thread.hpp"
#include "model/target.hpp"
#include <cassert>
#include <memory>

// Run against a native xyo library built from the pinned upstream with only
// wait-bubble-target-lifetime.patch applied (and assertions enabled).
static void testDeletion(bool stopAll) {
    xyo::Runtime runtime;
    auto sprite = std::make_unique<xyo::Sprite>(&runtime);
    auto* original = sprite->createClone();
    runtime.ownedSprites.push_back(std::move(sprite));
    runtime.addTarget(original);
    auto* clone = original->makeClone();
    assert(clone && !clone->isOriginal);
    runtime.addTarget(clone);

    xyo::Thread removedWait(""), otherWait("");
    removedWait.status = otherWait.status = xyo::STATUS_PROMISE_WAIT;
    xyo::Runtime::WaitEntry removed;
    removed.thread = &removedWait;
    removed.deadlineMs = 100;
    removed.bubbleTarget = clone;
    removed.bubbleType = "say";
    removed.bubbleUsageId = 12;
    xyo::Runtime::WaitEntry other;
    other.thread = &otherWait;
    other.deadlineMs = 200;
    other.bubbleTarget = original;
    other.bubbleType = "think";
    other.bubbleUsageId = 19;
    original->bubbleUsageId = 19;
    original->bubbleText = u"still waiting";
    runtime.waitQueue.push_back(removed);
    runtime.waitQueue.push_back(other);

    if (stopAll) runtime.stopAll();
    else runtime.disposeTarget(clone);

    assert(runtime.waitQueue.size() == 2);
    assert(runtime.waitQueue[0].bubbleTarget == nullptr);
    assert(runtime.waitQueue[0].thread == &removedWait);
    assert(runtime.waitQueue[0].deadlineMs == 100);
    assert(runtime.waitQueue[0].bubbleUsageId == 12);
    assert(runtime.waitQueue[1].bubbleTarget == original);
    assert(runtime.waitQueue[1].thread == &otherWait);
    assert(runtime.waitQueue[1].deadlineMs == 200);
    assert(runtime.waitQueue[1].bubbleUsageId == 19);

    runtime.currentMSecs = 99;
    runtime.processWaitQueue();
    assert(runtime.waitQueue.size() == 2);
    assert(removedWait.status == xyo::STATUS_PROMISE_WAIT);
    runtime.currentMSecs = 100;
    runtime.processWaitQueue();
    assert(runtime.waitQueue.size() == 1);
    assert(removedWait.status == xyo::STATUS_RUNNING);
    assert(otherWait.status == xyo::STATUS_PROMISE_WAIT);
    assert(runtime.waitQueue[0].bubbleTarget == original);
    assert(original->bubbleText == u"still waiting");
    runtime.currentMSecs = 200;
    runtime.processWaitQueue();
    assert(runtime.waitQueue.empty());
    assert(otherWait.status == xyo::STATUS_RUNNING);
    assert(original->bubbleText.empty());
}

int main() {
    testDeletion(false);
    testDeletion(true);
}
