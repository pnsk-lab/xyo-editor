#pragma once

// Requires patches/pen-sink.patch on the upstream runtime. The sink is not
// attached by default: integration must publish complete batches atomically.
#include "engine/runtime.hpp"
#include "pen_event_queue.hpp"

namespace xyo::web {
class BrowserPenSink final : public xyo::PenSink {
public:
    void point(const float rgba[4], double diameter, double x, double y) override {
        queue.point(rgba, diameter, x, y);
    }
    void line(const float rgba[4], double diameter, double x0, double y0, double x1, double y1) override {
        queue.line(rgba, diameter, x0, y0, x1, y1);
    }
    void clear() override { queue.clear(); }
    void stampUnsupported() override { queue.unsupported(); }
    PenEventQueue queue;
};
} // namespace xyo::web
