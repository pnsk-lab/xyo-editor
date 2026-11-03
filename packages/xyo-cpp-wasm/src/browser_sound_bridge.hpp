#pragma once
#include "sound_bank_bridge.hpp"
#include <cstddef>
#include <cstdint>
#include <memory>

namespace xyo::web {
// WASM32 callbacks are borrowed function-table entries; every buffer is valid
// only during the callback. stop must remove the voice synchronously.
struct BrowserSoundCallbacks {
    uint32_t context;
    int (*start)(uint32_t, uint32_t, uint32_t, uint32_t, const char*, size_t,
                 const uint8_t*, size_t, const char*, size_t, double);
    void (*stop)(uint32_t, uint32_t, uint32_t, uint32_t);
};
bool inSoundHostCallback();
class BrowserSoundBridge {
public:
    BrowserSoundBridge(Runtime&, uint32_t generation, BrowserSoundCallbacks);
    ~BrowserSoundBridge();
    BrowserSoundBridge(const BrowserSoundBridge&) = delete;
    BrowserSoundBridge& operator=(const BrowserSoundBridge&) = delete;
    void complete(uint32_t generation, uint32_t lo, uint32_t hi);
    void pump();
    uint32_t generation() const { return generation_; }
private:
    Runtime& runtime_;
    uint32_t generation_;
    BrowserSoundCallbacks callbacks_;
    SoundBankBridge bank_;
};
}
