#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace xyo::web {

// Private, nonblocking staging buffer. The owning runtime must discard the whole
// operation on failure and must never expose entries while failed. No target or
// WASM-memory pointers survive the call that creates an event.
class PenEventQueue {
public:
    enum class Kind : uint8_t { point = 1, line = 2, clear = 3 };
    enum class Failure : uint8_t { none, overflow, invalid, unsupported };
    struct Event {
        Kind kind{};
        std::array<float, 4> rgba{};
        double diameter = 0, x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    };
    static constexpr size_t capacity = 4096;

    void point(const float* rgba, double diameter, double x, double y) noexcept {
        append(Kind::point, rgba, diameter, x, y, x, y);
    }
    void line(const float* rgba, double diameter, double x0, double y0, double x1, double y1) noexcept {
        append(Kind::line, rgba, diameter, x0, y0, x1, y1);
    }
    void clear() noexcept {
        if (failure_ != Failure::none) return;
        if (size_ == capacity) { fail(Failure::overflow); return; }
        events_[size_++] = Event{Kind::clear};
    }
    void unsupported() noexcept { fail(Failure::unsupported); }
    Failure failure() const noexcept { return failure_; }
    // Never reveal a prefix of an invalid batch.
    size_t size() const noexcept { return failure_ == Failure::none ? size_ : 0; }
    const Event* at(size_t index) const noexcept {
        return failure_ == Failure::none && index < size_ ? &events_[index] : nullptr;
    }
    // Call only after the entire valid batch has been copied by the owner.
    void consume() noexcept { if (failure_ == Failure::none) size_ = 0; }
private:
    void fail(Failure failure) noexcept {
        if (failure_ == Failure::none) failure_ = failure;
        size_ = 0;
    }
    void append(Kind kind, const float* rgba, double diameter, double x0, double y0, double x1, double y1) noexcept {
        if (failure_ != Failure::none) return;
        if (!rgba || !std::isfinite(diameter) || diameter < 0 ||
            !std::isfinite(x0) || !std::isfinite(y0) || !std::isfinite(x1) || !std::isfinite(y1)) {
            fail(Failure::invalid); return;
        }
        for (size_t i = 0; i < 4; ++i) {
            if (!std::isfinite(rgba[i]) || rgba[i] < 0 || rgba[i] > 1) { fail(Failure::invalid); return; }
        }
        if (size_ == capacity) { fail(Failure::overflow); return; }
        Event event;
        event.kind = kind;
        for (size_t i = 0; i < 4; ++i) event.rgba[i] = rgba[i];
        event.diameter = diameter; event.x0 = x0; event.y0 = y0; event.x1 = x1; event.y1 = y1;
        events_[size_++] = event;
    }
    std::array<Event, capacity> events_{};
    size_t size_ = 0;
    Failure failure_ = Failure::none;
};

} // namespace xyo::web
