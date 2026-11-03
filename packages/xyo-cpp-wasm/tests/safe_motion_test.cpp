#include "safe_runtime.hpp"
#include "engine/runtime.hpp"
#include "engine/sequencer.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include "model/blocks.hpp"
#include <cassert>
#include <bit>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <limits>
#include <vector>

using namespace xyo;
extern "C" void xyo_safe_jit_fail_after_invoke(int);
extern "C" void xyo_safe_jit_reject_compile(int);
extern "C" void xyo_safe_jit_trap_modules();
static unsigned moved;
static void onMoved(Target*, double, double, bool) { ++moved; }
struct Fence : RendererAPI {
    mutable unsigned calls = 0;
    void getFencedPosition(int, double& x, double& y, bool) const override {
        ++calls; x = 17; y = -13;
    }
};
static Target* sprite(Runtime& rt) {
    for (auto* t : rt.targets) if (!t->isStage) return t;
    assert(false); return nullptr;
}
static uint64_t bits(double x) { return std::bit_cast<uint64_t>(x); }
static void run(const std::vector<uint8_t>& fixture, int mode, double direction, double x, double y, bool zeroSteps = false) {
    Runtime ref, opt;
    assert(loadSb3File(ref, fixture.data(), fixture.size()).ok);
    assert(loadSb3File(opt, fixture.data(), fixture.size()).ok);
    Target* a = sprite(ref); Target* b = sprite(opt);
    if (zeroSteps) for (auto* t : {a, b}) {
        auto* in = t->blocks->getBlock("mv")->inputs.find("STEPS");
        assert(in && !in->block.empty());
        auto* literal = t->blocks->getBlock(in->block);
        assert(literal); literal->fields["NUM"].value = Value::num(-0.0);
    }
    a->direction = b->direction = direction; a->x = b->x = x; a->y = b->y = y;
    xyo_safe_jit_enable(0); ref.greenFlag();
    xyo_safe_jit_enable(1); const auto beforeCompile = xyo_safe_jit_compilations();
    const auto beforeRun = xyo_safe_jit_executions();
    if (mode == 4) xyo_safe_jit_reject_compile(1);
    opt.greenFlag();
    xyo_safe_jit_reject_compile(0);
    assert(xyo_safe_jit_compilations() == beforeCompile + (mode == 4 ? 0u : 1u));
    assert(ref.threads.size() == 1 && opt.threads.size() == 1);
    Fence fa, fb;
    if (mode == 1) { ref.renderer = &fa; opt.renderer = &fb; }
    if (mode == 2) { a->onTargetMoved = onMoved; b->onTargetMoved = onMoved; moved = 0; }
    if (mode == 3) xyo_safe_jit_fail_after_invoke(1);
    if (mode == 8) xyo_safe_jit_trap_modules();
    if (mode == 5) a->dragging = b->dragging = true;
    if (mode == 6) a->isStage = b->isStage = true;
    Thread* t = ref.threads[0]; Thread* u = opt.threads[0];
    // Compare after the same scheduler step; say and move are in this step.
    xyo_safe_jit_enable(0); ref.sequencer->stepThread(*t);
    xyo_safe_jit_enable(1); opt.sequencer->stepThread(*u);
    xyo_safe_jit_fail_after_invoke(0);
    const bool runExpected = mode == 0;
    assert(xyo_safe_jit_executions() == beforeRun + (runExpected ? 1u : 0u));
    assert(bits(a->x) == bits(b->x) && bits(a->y) == bits(b->y));
    assert(a->bubbleText == b->bubbleText);
    assert(ref.refreshTargets == opt.refreshTargets);
    assert(t->stack == u->stack && t->status == u->status);
    assert(t->blockGlowInFrame == u->blockGlowInFrame);
    assert(t->requestScriptGlowInFrame == u->requestScriptGlowInFrame);
    assert(fa.calls == fb.calls);
    if (mode == 1) assert(fa.calls == 1);
    if (mode == 2) assert(moved == 2);
    ref.renderer = nullptr; opt.renderer = nullptr;
    if (mode == 0) {
        const auto runs = xyo_safe_jit_executions();
        xyo_safe_jit_enable(0); ref.greenFlag();
        xyo_safe_jit_enable(1); opt.greenFlag();
        assert(ref.threads.size() == 1 && opt.threads.size() == 1);
        xyo_safe_jit_enable(0); ref.sequencer->stepThread(*ref.threads[0]);
        xyo_safe_jit_enable(1); opt.sequencer->stepThread(*opt.threads[0]);
        assert(xyo_safe_jit_executions() == runs); // pre-existing cache => fallback
        assert(bits(a->x) == bits(b->x) && bits(a->y) == bits(b->y));
    }
}
int main() {
    std::ifstream f("/basic.sb3", std::ios::binary);
    std::vector<uint8_t> fixture((std::istreambuf_iterator<char>(f)), {});
    assert(!fixture.empty());
    for (double direction : {0., 90., -45., 12.345, 180., -179.})
        run(fixture, 0, direction, -0., 42.25);
    run(fixture, 0, 90., -0., -0., true);
    run(fixture, 0, -90., -0., 0., true);
    for (int mode = 1; mode <= 6; ++mode) run(fixture, mode, 33., 2., -3.);
    run(fixture, 7, std::numeric_limits<double>::infinity(), 2., -3.);
    run(fixture, 7, 33., std::numeric_limits<double>::infinity(), -3.);
    run(fixture, 8, 33., 2., -3.); // actual WebAssembly unreachable trap
    std::puts("basic.sb3: safe motion and guard fallbacks match interpreter");
}
