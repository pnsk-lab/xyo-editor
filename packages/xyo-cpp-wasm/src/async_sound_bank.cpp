#include "async_sound_bank.hpp"
#include "engine/runtime.hpp"
#include "engine/thread.hpp"
#include "model/target.hpp"
#include <algorithm>
#include <utility>
#include <vector>
#ifndef XYO_WAIT_GENERATIONS
#error "AsyncSoundBank requires wait-generation.patch"
#endif
namespace xyo::web {
AsyncSoundBank::AsyncSoundBank(Runtime& rt, uint32_t generation, Host host)
    : runtime_(&rt), generation_(generation), host_(std::move(host)), failed_(!generation) {}
void AsyncSoundBank::playSound(Target* t, int s) { play(t, s, nullptr); }
void AsyncSoundBank::playSoundAndWait(Target* t, int s, Thread* th) { play(t, s, th); }
void AsyncSoundBank::play(Target* t, int s, Thread* th) {
    if (!runtime_ || failed_) return;
    if (!next_) { failed_ = true; return; }
    if (th) {
        auto it = waits_.find(th);
        if (it != waits_.end()) {
            auto old = voices_.find(it->second);
            if (old != voices_.end()) old->second.thread = nullptr;
            waits_.erase(it);
        }
    }
    Id id = next_++;
    voices_.emplace(id, Voice{t, s, th, th ? th->waitGeneration : 0, State::playing, t ? t->volume : 100, effect(t, "pitch"), effect(t, "pan")});
    if (th) waits_[th] = id;
    const Sound* sound = nullptr;
    if (t && t->sprite && s >= 0 && size_t(s) < t->sprite->sounds.size())
        sound = &t->sprite->sounds[s];
    if (!sound || !host_.start) { complete(generation_, id); return; }
    if (!host_.start(generation_, id, t, *sound)) {
        if (host_.transportFailed && host_.transportFailed()) failed_ = true;
        else complete(generation_, id);
    }
}
void AsyncSoundBank::complete(uint32_t generation, Id id) {
    if (!runtime_ || failed_ || generation != generation_) return;
    auto it = voices_.find(id);
    if (it != voices_.end() && it->second.state == State::playing) it->second.state = State::done;
}
void AsyncSoundBank::stopAck(uint32_t generation, Id id, bool success) {
    if (!runtime_ || failed_ || generation != generation_) return;
    auto it = voices_.find(id);
    if (it == voices_.end() || it->second.state != State::stopping) return;
    if (!success) { failed_ = true; return; }
    it->second.state = State::done;
}
void AsyncSoundBank::stopMatching(Target* t, int s, bool all) {
    if (!runtime_ || failed_) return;
    std::vector<Id> ids;
    for (auto& [id, v] : voices_)
        if (v.state == State::playing && (all || (v.target == t && v.sound == s))) {
            v.state = State::stopping; ids.push_back(id);
        }
    for (Id id : ids)
        if (!host_.requestStop || !host_.requestStop(generation_, id)) { failed_ = true; break; }
}
void AsyncSoundBank::stop(Target* t, int s) { stopMatching(t, s, false); }
void AsyncSoundBank::stopAllSounds(Target*) { stopMatching(nullptr, 0, true); }
bool AsyncSoundBank::pump() {
    if (!runtime_ || failed_) return false;
    std::vector<Id> ids;
    for (auto& [id, v] : voices_) if (v.state == State::done) ids.push_back(id);
    for (Id id : ids) {
        auto it = voices_.find(id); if (it == voices_.end()) continue;
        Voice v = it->second; voices_.erase(it);
        if (!v.thread) continue;
        auto wait = waits_.find(v.thread);
        if (wait == waits_.end() || wait->second != id) continue;
        waits_.erase(wait);
        auto& threads = runtime_->threads;
        if (std::find(threads.begin(), threads.end(), v.thread) != threads.end() &&
            !v.thread->isKilled && v.thread->status == STATUS_PROMISE_WAIT &&
            v.thread->waitGeneration == v.wait)
            resolveWait(*runtime_->sequencer, *v.thread, Value::undefined());
    }
    return true;
}
double AsyncSoundBank::effect(const Target* target, const char* name) {
    if (!target) return 0;
    const auto it = target->soundEffects.find(name);
    return it == target->soundEffects.end() ? 0 : it->second;
}
bool AsyncSoundBank::syncVolumes() {
    if (!runtime_ || failed_) return false;
    for (auto& [id, voice] : voices_) {
        if (voice.state != State::playing || !voice.target) continue;
        const double volume = voice.target->volume;
        if (volume != voice.volume) {
            if (!host_.setVolume || !host_.setVolume(generation_, id, volume)) { failed_ = true; return false; }
            voice.volume = volume;
        }
        const double pitch = effect(voice.target, "pitch"), pan = effect(voice.target, "pan");
        if (pitch != voice.pitch || pan != voice.pan) {
            if (!host_.setEffects || !host_.setEffects(generation_, id, pitch, pan)) { failed_ = true; return false; }
            voice.pitch = pitch; voice.pan = pan;
        }
    }
    return true;
}
void AsyncSoundBank::invalidate() {
    runtime_ = nullptr; voices_.clear(); waits_.clear();
}
void AsyncSoundBank::forgetTarget(Target* t) {
    if (!runtime_ || failed_) return;
    std::vector<Id> ids;
    for (auto& [id, v] : voices_) if (v.target == t) ids.push_back(id);
    for (Id id : ids) {
        auto it = voices_.find(id); if (it == voices_.end()) continue;
        auto v = it->second;
        if (v.thread) {
            auto w = waits_.find(v.thread);
            if (w != waits_.end() && w->second == id) waits_.erase(w);
        }
        if (v.state == State::done) {
            voices_.erase(it);
            continue;
        }
        // Do not retain the target or waiter, but retain the stop operation so
        // a failed ACK still fails the generation after clone destruction.
        it->second.target = nullptr;
        it->second.thread = nullptr;
        if (v.state == State::playing) {
            it->second.state = State::stopping;
            if (!host_.requestStop || !host_.requestStop(generation_, id)) failed_ = true;
        }
    }
}
}
