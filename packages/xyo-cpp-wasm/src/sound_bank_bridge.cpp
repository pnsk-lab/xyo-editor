#include "sound_bank_bridge.hpp"
#include "engine/runtime.hpp"
#include "engine/thread.hpp"
#include "model/target.hpp"
#include <algorithm>
#include <limits>
#include <utility>
#include <vector>

#ifndef XYO_WAIT_GENERATIONS
#error "SoundBankBridge requires wait-generation.patch and XYO_WAIT_GENERATIONS"
#endif

namespace xyo::web {
SoundBankBridge::SoundBankBridge(Runtime& rt, Host host)
    : runtime_(&rt), host_(std::move(host)) {}

void SoundBankBridge::playSound(Target* target, int sound) { play(target, sound, nullptr); }
void SoundBankBridge::playSoundAndWait(Target* target, int sound, Thread* thread) {
    play(target, sound, thread);
}
void SoundBankBridge::play(Target* target, int sound, Thread* thread) {
    if (!runtime_) return;
    if (thread) forgetThread(thread);
    // IDs never wrap or get reused, even when starts fail.
    if (!next_) return;
    Id id = next_++;
    uint64_t generation = 0;
#ifdef XYO_WAIT_GENERATIONS
    if (thread) generation = thread->waitGeneration;
#endif
    voices_.emplace(id, Voice{target, sound, thread, false, generation});
    if (thread) waits_[thread] = id;
    const Sound* asset = nullptr;
    if (target && target->sprite && sound >= 0 &&
        static_cast<size_t>(sound) < target->sprite->sounds.size())
        asset = &target->sprite->sounds[sound];
    bool started = asset && host_.start && host_.start(id, target, *asset);
    if (!started) complete(id);
}
void SoundBankBridge::complete(Id id) {
    auto it = voices_.find(id);
    if (it != voices_.end()) it->second.done = true;
}
void SoundBankBridge::pump() {
    if (!runtime_) return;
    std::vector<Id> done;
    for (const auto& [id, voice] : voices_) if (voice.done) done.push_back(id);
    for (Id id : done) {
        auto it = voices_.find(id);
        if (it == voices_.end()) continue;
        Voice voice = it->second;
        voices_.erase(it);
        if (!voice.thread) continue;
        auto wait = waits_.find(voice.thread);
        if (wait == waits_.end() || wait->second != id) continue;
        waits_.erase(wait);
        // ownedThreads retain pointer identities until Runtime destruction. Do not
        // dereference a target: clone deletion can leave thread->target dangling.
        auto& threads = runtime_->threads;
        if (std::find(threads.begin(), threads.end(), voice.thread) != threads.end() &&
            !voice.thread->isKilled && voice.thread->status == STATUS_PROMISE_WAIT
#ifdef XYO_WAIT_GENERATIONS
            && voice.thread->waitGeneration == voice.waitGeneration
#endif
            )
            resolveWait(*runtime_->sequencer, *voice.thread, Value::undefined());
    }
}
void SoundBankBridge::stopMatching(Target* target, int sound, bool all) {
    std::vector<Id> ids;
    for (const auto& [id, voice] : voices_)
        if (!voice.done && (all || (voice.target == target && voice.sound == sound)))
            ids.push_back(id);
    for (Id id : ids) {
        complete(id); // retire before host callback can reenter
        if (host_.stop) host_.stop(id);
    }
}
void SoundBankBridge::stopAllSounds(Target*) { stopMatching(nullptr, 0, true); }
void SoundBankBridge::stop(Target* target, int sound) { stopMatching(target, sound, false); }
void SoundBankBridge::setEffects(Target* target) { if (runtime_ && host_.effects) host_.effects(target); }
void SoundBankBridge::forgetThread(Thread* thread) {
    auto it = waits_.find(thread);
    if (it == waits_.end()) return;
    auto voice = voices_.find(it->second);
    if (voice != voices_.end()) voice->second.thread = nullptr;
    waits_.erase(it);
}
void SoundBankBridge::forgetTarget(Target* target) {
    std::vector<Id> ids;
    for (const auto& [id, voice] : voices_) if (voice.target == target) ids.push_back(id);
    for (Id id : ids) {
        auto it = voices_.find(id);
        if (it == voices_.end()) continue;
        if (it->second.thread) forgetThread(it->second.thread);
        bool playing = !it->second.done;
        voices_.erase(it);
        if (playing && host_.stop) host_.stop(id);
    }
}
void SoundBankBridge::reset() {
    if (!runtime_) return;
    std::vector<Id> ids;
    for (const auto& [id, voice] : voices_) if (!voice.done) ids.push_back(id);
    voices_.clear(); waits_.clear();
    for (Id id : ids) if (host_.stop) host_.stop(id);
}
void SoundBankBridge::shutdown() {
    if (!runtime_) return;
    reset();
    runtime_ = nullptr;
}
}
