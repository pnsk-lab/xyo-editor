#pragma once

#include "model/variable.hpp"
#include <cstdint>
#include <functional>
#include <unordered_map>

namespace xyo { struct Runtime; }

namespace xyo::web {
// Single-threaded, runtime-scoped adapter. Host copies Sound data during start;
// completion is reported by opaque id, never by a target/thread pointer.
// See SOUND-BRIDGE-NOTES.md for mandatory lifecycle and wait invalidation hooks.
class SoundBankBridge final : public SoundBankAPI {
public:
    using Id = uint64_t;
    struct Host {
        std::function<bool(Id, Target*, const Sound&)> start;
        std::function<void(Id)> stop;
        std::function<void(Target*)> effects;
    };
    explicit SoundBankBridge(Runtime& runtime, Host host);
    ~SoundBankBridge() override = default;
    SoundBankBridge(const SoundBankBridge&) = delete;
    SoundBankBridge& operator=(const SoundBankBridge&) = delete;

    void playSound(Target*, int) override;
    void playSoundAndWait(Target*, int, Thread*) override;
    void stopAllSounds(Target*) override;
    void stop(Target*, int) override;
    void setEffects(Target*) override;

    // May be called synchronously by start/stop, but pump only after Runtime::step.
    void complete(Id id);
    void pump();
    // Must precede deleting a clone, stopping/replacing a runtime, or initiating
    // any non-sound wait on an externally resolved/reused Thread.
    void forgetTarget(Target*);
    void forgetThread(Thread*);
    void reset(); // cancel all without waking threads; retain monotonic IDs
    void shutdown();
private:
    struct Voice { Target* target; int sound; Thread* thread; bool done; uint64_t waitGeneration; };
    Runtime* runtime_;
    Host host_;
    Id next_ = 1;
    std::unordered_map<Id, Voice> voices_;
    std::unordered_map<Thread*, Id> waits_;
    void play(Target*, int, Thread*);
    void stopMatching(Target*, int, bool);
};
}
