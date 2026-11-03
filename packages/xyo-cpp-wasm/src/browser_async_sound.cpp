#include "browser_async_sound.hpp"
#include "engine/runtime.hpp"
#include "model/target.hpp"
#include <limits>
#include <cmath>

namespace xyo::web {
static bool validEffects(double pitch, double pan) {
    return std::isfinite(pitch) && pitch >= -360 && pitch <= 360 && std::isfinite(pan) && pan >= -100 && pan <= 100;
}
BrowserAsyncSound::BrowserAsyncSound(Runtime& rt, uint32_t gen, uint32_t timeoutTicks)
    : runtime_(rt), generation_(gen), timeout_(timeoutTicks),
      bank_(rt, gen, {
        [this](uint32_t g, uint64_t id, Target* target, const Sound& sound) {
            if (closing_ || dispatchFault_) return false;
            const double pitch = AsyncSoundBank::effect(target, "pitch"), pan = AsyncSoundBank::effect(target, "pan");
            if (!validEffects(pitch, pan)) { dispatchFault_ = true; return false; }
            if (commands_.size() >= MaxCommands || outstanding_.size() >= MaxVoices ||
                sound.data.size() > MaxSoundBytes || sound.data.size() > MaxQueuedBytes - queuedBytes_ ||
                target->id.size() > 4096 || sound.dataFormat.size() > 256 || !std::isfinite(target->volume)) {
                dispatchFault_ = true; return false;
            }
            Command c{Start, g, id}; c.target = target->id; c.format = sound.dataFormat;
            c.bytes = sound.data; c.volume = target->volume; c.pitch = pitch; c.pan = pan; c.queuedAt = ticks_;
            queuedBytes_ += c.bytes.size(); outstanding_.insert(id);
            commands_.push_back(std::move(c)); return true;
        },
        [this](uint32_t g, uint64_t id) {
            if (closing_ || dispatchFault_) return false;
            if (commands_.size() >= MaxCommands) { dispatchFault_ = true; return false; }
            stopping_[id] = {ticks_, false};
            Command c{Stop, g, id}; c.queuedAt = ticks_;
            commands_.push_back(std::move(c)); return true;
        },
        [this]() { return dispatchFault_; },
        [this](uint32_t g, uint64_t id, double volume) {
            if (closing_ || dispatchFault_) return false;
            if (!std::isfinite(volume)) { dispatchFault_ = true; return false; }
            // A queued update can be replaced only until a later command for
            // the same voice, preserving start/stop ordering and timeout age.
            for (auto it = commands_.rbegin(); it != commands_.rend(); ++it) {
                if (it->id != id) continue;
                if (it->kind == Volume) { it->volume = volume; return true; }
                break;
            }
            if (commands_.size() >= MaxCommands) { dispatchFault_ = true; return false; }
            Command c{Volume, g, id}; c.volume = volume; c.queuedAt = ticks_;
            commands_.push_back(std::move(c)); return true;
        },
        [this](uint32_t g, uint64_t id, double pitch, double pan) {
            if (closing_ || dispatchFault_) return false;
            if (!validEffects(pitch, pan)) { dispatchFault_ = true; return false; }
            for (auto it = commands_.rbegin(); it != commands_.rend(); ++it) {
                if (it->id != id) continue;
                if (it->kind == Effects) { it->pitch = pitch; it->pan = pan; return true; }
                break;
            }
            if (commands_.size() >= MaxCommands) { dispatchFault_ = true; return false; }
            Command c{Effects, g, id}; c.pitch = pitch; c.pan = pan; c.queuedAt = ticks_;
            commands_.push_back(std::move(c)); return true;
        }
      }) {
    if (!gen || !timeout_) failed_ = true;
    for (auto& s : rt.ownedSprites) s->soundBank = &bank_;
    rt.onTargetRemoved = [this](Target* target) { bank_.forgetTarget(target); };
    rt.onProjectStopped = [this] { close(); };
}
BrowserAsyncSound::~BrowserAsyncSound() {
    bank_.invalidate();
    runtime_.onProjectStopped = nullptr; runtime_.onTargetRemoved = nullptr;
    for (auto& s : runtime_.ownedSprites) if (s->soundBank == &bank_) s->soundBank = nullptr;
}
const BrowserAsyncSound::Command* BrowserAsyncSound::front() const {
    return commands_.empty() ? nullptr : &commands_.front();
}
void BrowserAsyncSound::pop() {
    if (commands_.empty()) return;
    if (commands_.front().kind == CancelGeneration) cancelDelivered_ = true;
    if (commands_.front().kind == Start) started_.insert(commands_.front().id);
    if (commands_.front().kind == Stop) {
        auto it = stopping_.find(commands_.front().id);
        if (it != stopping_.end()) it->second.second = true;
    }
    queuedBytes_ -= commands_.front().bytes.size();
    commands_.pop_front();
}
void BrowserAsyncSound::complete(uint32_t gen, uint64_t id) {
    if (!closing_ && gen == generation_ && started_.count(id)) {
        bank_.complete(gen, id);
        if (!stopping_.count(id)) { started_.erase(id); outstanding_.erase(id); }
    }
}
void BrowserAsyncSound::stopAck(uint32_t gen, uint64_t id, bool success) {
    auto it = stopping_.find(id);
    if (closing_ || gen != generation_ || it == stopping_.end() || !it->second.second) return;
    stopping_.erase(it); started_.erase(id); outstanding_.erase(id); bank_.stopAck(gen, id, success);
    if (bank_.failed()) fail();
}
void BrowserAsyncSound::close() {
    if (closing_) return;
    closing_ = true; closeStarted_ = ticks_;
    bank_.invalidate(); stopping_.clear(); started_.clear(); outstanding_.clear(); commands_.clear(); queuedBytes_ = 0;
    commands_.push_back(Command{CancelGeneration, generation_, 0});
}
void BrowserAsyncSound::fail() {
    if (failed_) return;
    failed_ = true;
    close();
    runtime_.stopAll();
}
bool BrowserAsyncSound::closeAck(uint32_t gen, bool success) {
    if (!closing_ || !cancelDelivered_ || gen != generation_ || closed_) return false;
    if (!success) { failed_ = true; return false; }
    closed_ = true; return true;
}
bool BrowserAsyncSound::tick() {
    if (ticks_ == std::numeric_limits<uint32_t>::max()) { fail(); return false; }
    ++ticks_;
    if (closing_) {
        if (!closed_ && ticks_ - closeStarted_ >= timeout_) failed_ = true;
        return false;
    }
    if (failed_ || dispatchFault_ || bank_.failed()) { fail(); return false; }
    if (!commands_.empty() && ticks_ - commands_.front().queuedAt >= timeout_) { fail(); return false; }
    for (const auto& [id, state] : stopping_) {
        (void)id;
        if (ticks_ - state.first >= timeout_) { fail(); return false; }
    }
    if (!bank_.pump()) { fail(); return false; }
    return true;
}
bool BrowserAsyncSound::afterStep() {
    if (dispatchFault_ || bank_.failed() || (!closing_ && !bank_.syncVolumes())) { fail(); return false; }
    // A script can normally stop the project during this step. Its close
    // queues CancelGeneration; let the owner drain it after a successful step.
    // Subsequent ticks/steps remain blocked while closing.
    return !failed_;
}
bool BrowserAsyncSound::mayStep() const { return !closing_ && !failed_ && !dispatchFault_; }
bool BrowserAsyncSound::mayDestroy() const { return closed_; }
}
