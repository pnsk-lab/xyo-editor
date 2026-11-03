#include "safe_runtime.hpp"
#include "engine/runtime.hpp"
#include "engine/sequencer.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include "model/blocks.hpp"
#include <bit>
#include <cassert>
#include <cmath>
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
static bool same(double x, double y) { return (std::isnan(x) && std::isnan(y)) || bits(x) == bits(y); }
static void setup(Target* t, const char* op, const char* key, double literal, bool trailing) {
    Block* mv = t->blocks->getBlock("mv"); assert(mv);
    auto old = *mv->inputs.find("STEPS");
    auto* val = t->blocks->getBlock(old.block); assert(val);
    val->fields["NUM"].value = Value::num(literal);
    mv->opcode = op; mv->inputs.erase("STEPS"); mv->inputs.set(key, old);
    Block* hat = nullptr;
    for (const auto& id : t->blocks->getScripts()) {
        auto* b = t->blocks->getBlock(id);
        if (b->opcode == "event_whenflagclicked") hat = b;
    }
    assert(hat); auto previous = hat->next; hat->next = "mv";
    if (trailing) { mv->next = previous; auto* b = t->blocks->getBlock(previous); assert(b); b->next.clear(); }
    else mv->next.clear();
}
// mode: normal, renderer, callback, fail, reject, dragging, stage, nonfinite,
// trap, mutate literal after flag, overflow, trailing, mutate graph after flag.
static void run(const std::vector<uint8_t>& fixture, const char* op, const char* key,
                double literal, double x, double y, int mode) {
    Runtime ref, opt;
    assert(loadSb3File(ref, fixture.data(), fixture.size()).ok);
    assert(loadSb3File(opt, fixture.data(), fixture.size()).ok);
    Target* a = sprite(ref); Target* b = sprite(opt);
    setup(a, op, key, literal, mode == 11); setup(b, op, key, literal, mode == 11);
    if (mode >= 13 && mode <= 16) {
        const char* shadows[] = {"math_integer", "math_whole_number", "math_positive_number", "math_angle"};
        for (auto* target : {a, b}) {
            auto* in = target->blocks->getBlock("mv")->inputs.find(key);
            target->blocks->getBlock(in->block)->opcode = shadows[mode - 13];
        }
    }
    a->x = b->x = x; a->y = b->y = y;
    xyo_safe_jit_enable(0); ref.greenFlag();
    xyo_safe_jit_enable(1); auto beforeCompile = xyo_safe_jit_compilations();
    auto beforeRun = xyo_safe_jit_executions();
    if (mode == 4) xyo_safe_jit_reject_compile(1);
    opt.greenFlag(); xyo_safe_jit_reject_compile(0);
    const bool shouldCompile = mode != 4 && std::isfinite(literal);
    assert(xyo_safe_jit_compilations() == beforeCompile + (shouldCompile ? 1u : 0u));
    assert(ref.threads.size() == 1 && opt.threads.size() == 1);
    Fence fa, fb;
    if (mode == 1) { ref.renderer = &fa; opt.renderer = &fb; }
    if (mode == 2) { a->onTargetMoved = onMoved; b->onTargetMoved = onMoved; moved = 0; }
    if (mode == 3) xyo_safe_jit_fail_after_invoke(1);
    if (mode == 5) a->dragging = b->dragging = true;
    if (mode == 6) a->isStage = b->isStage = true;
    if (mode == 17) a->direction = b->direction = std::numeric_limits<double>::infinity();
    if (mode == 8) xyo_safe_jit_trap_modules();
    if (mode == 9) for (auto* t : {a,b}) {
        auto* in = t->blocks->getBlock("mv")->inputs.find(key);
        t->blocks->getBlock(in->block)->fields["NUM"].value = Value::num(8.25);
    }
    if (mode == 12) for (auto* t : {a,b}) {
        auto* mv = t->blocks->getBlock("mv");
        mv->opcode = "motion_movesteps";
        auto in = *mv->inputs.find(key); mv->inputs.erase(key); mv->inputs.set("STEPS", in);
    }
    Thread* t = ref.threads[0]; Thread* u = opt.threads[0];
    xyo_safe_jit_enable(0); ref.sequencer->stepThread(*t);
    xyo_safe_jit_enable(1); opt.sequencer->stepThread(*u);
    xyo_safe_jit_fail_after_invoke(0);
    const bool expected = mode == 0 || mode == 11 || (mode >= 13 && mode <= 16);
    assert(xyo_safe_jit_executions() == beforeRun + (expected ? 1u : 0u));
    assert(same(a->x,b->x) && same(a->y,b->y));
    assert(a->bubbleText == b->bubbleText && ref.refreshTargets == opt.refreshTargets);
    assert(ref.redrawRequested == opt.redrawRequested);
    assert(t->stack == u->stack && t->status == u->status);
    assert(t->blockGlowInFrame == u->blockGlowInFrame);
    assert(t->requestScriptGlowInFrame == u->requestScriptGlowInFrame);
    assert(fa.calls == fb.calls); if (mode == 1) assert(fa.calls == 1);
    if (mode == 2) assert(moved == 2);
    ref.renderer = nullptr; opt.renderer = nullptr;
}
int main() {
    std::ifstream f("/basic.sb3", std::ios::binary);
    std::vector<uint8_t> fixture((std::istreambuf_iterator<char>(f)), {}); assert(!fixture.empty());
    const char* ops[] = {"motion_changexby", "motion_setx", "motion_changeyby", "motion_sety"};
    const char* keys[] = {"DX", "X", "DY", "Y"};
    const double inf = std::numeric_limits<double>::infinity();
    const double max = std::numeric_limits<double>::max();
    for (int i=0; i<4; ++i) {
        for (double n : {-0.0, 0.0, -3.5, 12.25})
            for (double v : {-0.0, 0.0}) run(fixture, ops[i], keys[i], n, v, v, 0);
        run(fixture, ops[i], keys[i], -0., -0., 0., 0);
        run(fixture, ops[i], keys[i], 0., 0., -0., 0);
        for (int mode : {1,2,3,4,5,6,8,9,11,12,13,14,15,16,17}) run(fixture, ops[i], keys[i], 2.5, -0., 7., mode);
        run(fixture, ops[i], keys[i], 2.5, inf, 0., 7);
        run(fixture, ops[i], keys[i], 2.5, 0., -inf, 7);
        run(fixture, ops[i], keys[i], inf, 1., 0., 7);
        if (i == 0 || i == 2) run(fixture, ops[i], keys[i], max, max, max, 10);
    }
    std::puts("axis motion: actual WASM, interpreter and guard cases match");
}
