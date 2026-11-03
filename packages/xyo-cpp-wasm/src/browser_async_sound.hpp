#pragma once
#include "async_sound_bank.hpp"
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace xyo::web {
// Poll-only transport: no JS callbacks or reentry. One generation per session.
class BrowserAsyncSound {
public:
    enum Kind { Start = 1, Stop = 2, CancelGeneration = 3, Volume = 4, Effects = 5 };
    struct Command {
        Kind kind; uint32_t generation; uint64_t id;
        std::string target, format; std::vector<uint8_t> bytes; double volume = 100, pitch = 0, pan = 0;
        uint32_t queuedAt = 0;
    };
    BrowserAsyncSound(Runtime&, uint32_t generation, uint32_t timeoutTicks);
    ~BrowserAsyncSound();
    const Command* front() const;
    void pop();
    void complete(uint32_t generation, uint64_t id);
    void stopAck(uint32_t generation, uint64_t id, bool success);
    // Closing is irreversible. Owner must not destroy until closeAck succeeds.
    void close();
    bool closeAck(uint32_t generation, bool success);
    bool tick(); // false => closed/fault; never step runtime afterwards
    bool afterStep(); // handle deferred dispatch failure outside runtime callbacks
    bool mayStep() const;
    bool mayDestroy() const;
    bool failed() const { return failed_; }
    uint32_t generation() const { return generation_; }
private:
    Runtime& runtime_;
    uint32_t generation_, timeout_, ticks_ = 0, closeStarted_ = 0;
    static constexpr size_t MaxCommands = 256, MaxVoices = 256;
    static constexpr size_t MaxSoundBytes = 8 * 1024 * 1024, MaxQueuedBytes = 16 * 1024 * 1024;
    size_t queuedBytes_ = 0;
    bool closing_ = false, closed_ = false, failed_ = false, cancelDelivered_ = false, dispatchFault_ = false;
    std::unordered_set<uint64_t> outstanding_;
    std::deque<Command> commands_;
    std::unordered_map<uint64_t, std::pair<uint32_t, bool>> stopping_;
    std::unordered_set<uint64_t> started_;
    AsyncSoundBank bank_;
    void fail();
};
}
