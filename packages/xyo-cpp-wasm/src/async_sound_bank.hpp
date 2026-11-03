#pragma once
#include "model/variable.hpp"
#include <cstdint>
#include <functional>
#include <unordered_map>

namespace xyo { struct Runtime; }
namespace xyo::web {
// Experimental worker-safe protocol. All calls are on the Runtime thread;
// the transport must never call back synchronously into this object.
class AsyncSoundBank final : public SoundBankAPI {
public:
    using Id = uint64_t;
    struct Host {
        std::function<bool(uint32_t, Id, Target*, const Sound&)> start;
        // Queue request, not an acknowledgement. false is transport failure.
        std::function<bool(uint32_t, Id)> requestStop;
        // Optional: distinguish a start rejection from fatal transport failure.
        // Called immediately after start returns false, without reentering the bank.
        std::function<bool()> transportFailed;
        // Queue a per-voice update; never synchronously reenter this bank.
        std::function<bool(uint32_t, Id, double)> setVolume;
        std::function<bool(uint32_t, Id, double, double)> setEffects;
    };
    // Owner supplies a nonzero generation never reused within the transport.
    AsyncSoundBank(Runtime&, uint32_t generation, Host);
    void playSound(Target*, int) override;
    void playSoundAndWait(Target*, int, Thread*) override;
    void stopAllSounds(Target*) override;
    void stop(Target*, int) override;
    // completion during stopping cannot substitute for an explicit stop ACK.
    void complete(uint32_t generation, Id);
    void stopAck(uint32_t generation, Id, bool success);
    // Resolve only acknowledged/completed voices. On failure, returns false;
    // owner MUST invalidate generation and terminate Runtime before stepping it.
    bool pump();
    // Sample only live targets, on the runtime thread after a step.
    bool syncVolumes();
    static double effect(const Target*, const char* name);
    bool failed() const { return failed_; }
    // Owner first invalidates generation and stops all host voices independently.
    // Never resolves any waits; async callbacks after this are ignored.
    void invalidate();
    // Invoke before clone destruction, after the host invalidates its voices.
    void forgetTarget(Target*);
private:
    enum class State { playing, stopping, done };
    struct Voice { Target* target; int sound; Thread* thread; uint64_t wait; State state; double volume; double pitch; double pan; };
    Runtime* runtime_;
    uint32_t generation_;
    Host host_;
    Id next_ = 1;
    bool failed_ = false;
    std::unordered_map<Id, Voice> voices_;
    std::unordered_map<Thread*, Id> waits_;
    void play(Target*, int, Thread*);
    void stopMatching(Target*, int, bool);
};
}
