// Production-code path: build with XYO_SAFE_WASM_LOOP_EXPERIMENT but WITHOUT
// XYO_SAFE_JIT_TESTING. /loop.sb3 is an actual embedded SB3 ZIP fixture.
#include "safe_runtime.hpp"
#include "engine/runtime.hpp"
#include "engine/sequencer.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include <cassert>
#include <bit>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <limits>
#include <string>
#include <vector>
using namespace xyo;
extern "C" void xyo_safe_jit_loop_experiment(int);
static void compare(Thread& a, Thread& b, Variable& x, Variable& y) {
    assert(x.value.bits == y.value.bits && a.stack == b.stack && a.status == b.status);
    assert(a.blockGlowInFrame == b.blockGlowInFrame && a.requestScriptGlowInFrame == b.requestScriptGlowInFrame);
    auto* af = a.peekStackFrame(); auto* bf = b.peekStackFrame();
    assert(bool(af) == bool(bf));
    if (af) {
        assert(af->isLoop == bf->isLoop && af->warpMode == bf->warpMode);
        auto* ac = af->executionContext.get(); auto* bc = bf->executionContext.get();
        assert(bool(ac) == bool(bc));
        if (ac) assert(ac->hasLoopCounter == bc->hasLoopCounter && ac->loopCounter == bc->loopCounter);
    }
}
static void run(const std::vector<uint8_t>& sb3, bool allow, int mode) {
    Runtime ref, opt;
    assert(loadSb3File(ref, sb3.data(), sb3.size()).ok);
    assert(loadSb3File(opt, sb3.data(), sb3.size()).ok);
    auto* ar = ref.getTargetForStage(); auto* br = opt.getTargetForStage();
    auto* av = ar->lookupVariableById("v"); auto* bv = br->lookupVariableById("v");
    for (auto* target : {ar, br}) {
        if (mode == 1) target->lookupVariableById("v")->value = Value::num(-2.5);
        if (mode == 2) {
            target->lookupVariableById("v")->value = Value::num(-0.0);
            auto* body = target->blocks->getBlock("inc");
            auto* literal = target->blocks->getBlock(body->inputs.find("VALUE")->block);
            literal->fields["NUM"].value = Value::num(std::numeric_limits<double>::denorm_min());
        }
    }
    xyo_safe_jit_loop_experiment(0); xyo_safe_jit_enable(0); ref.greenFlag();
    xyo_safe_jit_enable(1); xyo_safe_jit_loop_experiment(1);
    const auto beforeCompile = xyo_safe_jit_compilations();
    const auto beforeRun = xyo_safe_jit_executions();
    opt.greenFlag();
    assert(xyo_safe_jit_compilations() == beforeCompile + (allow ? 1u : 0u));
    assert(ref.threads.size() == 1 && opt.threads.size() == 1);
    Thread& a = *ref.threads[0]; Thread& b = *opt.threads[0];
    // Execute another real interpreter Thread between prepare and first step.
    if (mode == 3) {
        Thread peerA("peer"), peerB("peer");
        peerA.target = ar; peerA.blockContainer = ar->blocks; peerA.pushStack("peer");
        peerB.target = br; peerB.blockContainer = br->blocks; peerB.pushStack("peer");
        xyo_safe_jit_enable(0); ref.sequencer->stepThread(peerA);
        opt.sequencer->stepThread(peerB);
        xyo_safe_jit_enable(1);
        assert(av->value.bits == Value::num(7).bits && bv->value.bits == av->value.bits);
    }
    if (mode == 4) {
        assert(ar->blocks->getCachedExecute("inc"));
        assert(br->blocks->getCachedExecute("inc"));
    }
    if (mode == 5) for (auto* target : {ar, br}) {
        auto* body = target->blocks->getBlock("inc");
        auto* literal = target->blocks->getBlock(body->inputs.find("VALUE")->block);
        literal->fields["NUM"].value = Value::num(3);
    }
    const unsigned expected = allow && mode != 4 && mode != 5 ? 1u : 0u;
    for (int i = 0; i < 3; ++i) {
        xyo_safe_jit_enable(0); ref.sequencer->stepThread(a);
        xyo_safe_jit_enable(1); opt.sequencer->stepThread(b);
        compare(a, b, *av, *bv);
        assert(xyo_safe_jit_executions() == beforeRun + expected);
    }
    assert(a.status == STATUS_DONE && xyo_safe_jit_live_modules() == 0);
    for (int i = 0; i < 10; ++i) {
        opt.startHats("event_whenflagclicked", nullptr, nullptr);
        assert(xyo_safe_jit_live_modules() == (allow ? 1u : 0u));
    }
    for (int i = 0; i < 10; ++i) {
        opt.greenFlag(); assert(xyo_safe_jit_live_modules() == (allow ? 1u : 0u));
    }
    opt.stopAll(); assert(xyo_safe_jit_live_modules() == 0);
}
int main(int argc, char** argv) {
    bool allow = argc < 2 || std::string(argv[1]) != "deny";
    std::ifstream f("/loop.sb3", std::ios::binary);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), {}); assert(!bytes.empty());
    // The optional feature must start disabled even if compiled in.
    { Runtime r; assert(loadSb3File(r, bytes.data(), bytes.size()).ok);
      xyo_safe_jit_enable(1); const auto before = xyo_safe_jit_compilations();
      r.greenFlag(); assert(xyo_safe_jit_compilations() == before); r.stopAll(); }
    for (int mode = 0; mode < 6; ++mode) run(bytes, allow, mode);
    xyo_safe_jit_loop_experiment(0); xyo_safe_jit_enable(0);
    std::printf("nontest SB3 differential: %s PASS\n", allow ? "allow" : "deny");
}
