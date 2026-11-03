// Differential acceptance test for the proposed FIRST ITERATION ONLY loop
// experiment. Build with XYO_SAFE_WASM_TESTING and actual Emscripten; do not
// integrate into the ordinary suite until the opt-in feature exists.
// Define LOOP_ORACLE_ONLY to run the interpreter oracle without the feature.
#include "safe_runtime.hpp"
#include "engine/runtime.hpp"
#include "engine/sequencer.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>
#include <emscripten.h>

// Replace only the generated-module constructor, after the host runtime is
// already running. A genuine WebAssembly.RuntimeError is raised on invoke.
EM_JS(void, loop_test_trap, (int enabled), {
    if (enabled) {
        Module['loopTestOriginalInstance'] = WebAssembly.Instance;
        WebAssembly.Instance = function(module, imports) {
            var instance = new Module['loopTestOriginalInstance'](module, imports);
            var bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,
                3,2,1,0,7,5,1,1,102,0,0,10,5,1,3,0,0,11]);
            var trap = new Module['loopTestOriginalInstance'](new WebAssembly.Module(bytes));
            return {exports: {f: function() { Module['loopTestTraps'] = (Module['loopTestTraps'] || 0) + 1; return trap.exports.f(); }}};
        };
    } else if (Module['loopTestOriginalInstance']) {
        WebAssembly.Instance = Module['loopTestOriginalInstance'];
        delete Module['loopTestOriginalInstance'];
    }
});
EM_JS(unsigned, loop_test_traps, (), { return Module['loopTestTraps'] || 0; });

extern "C" void xyo_safe_jit_fail_after_invoke(int);
extern "C" void xyo_safe_jit_reject_compile(int);
#ifndef LOOP_ORACLE_ONLY
extern "C" void xyo_safe_jit_loop_experiment(int);
#endif
using namespace xyo;

enum class Case { Normal, Cached, Edit, Override, ParentOverride, ParentCached, Shared,
                  MinusZero, NaN, PositiveInf, NegativeInf, Overflow,
                  FailAfterInvoke, Trap, RejectCompile, Stop };
static Value overrideChange(const ArgValues&, BlockUtility&) { return Value::undefined(); }
struct Frame {
    std::string id, glow, frameOp, cacheOpcode;
    int status;
    bool request, isLoop, warp, counterPresent, reported, waiting;
    bool bodyCached, bodyInputsCached, literalCached, literalInputsCached, literalParentIsBody;
    size_t bodyOpCount;
    uint64_t value, justReported;
    std::vector<std::string> stack;
    size_t frames, trash;
    double counter;
};
static bool operator==(const Frame& a, const Frame& b) {
    return a.id == b.id && a.glow == b.glow && a.frameOp == b.frameOp &&
        a.cacheOpcode == b.cacheOpcode && a.status == b.status &&
        a.bodyCached == b.bodyCached && a.bodyInputsCached == b.bodyInputsCached &&
        a.literalCached == b.literalCached && a.literalInputsCached == b.literalInputsCached &&
        a.literalParentIsBody == b.literalParentIsBody && a.bodyOpCount == b.bodyOpCount &&
        a.request == b.request && a.isLoop == b.isLoop && a.warp == b.warp &&
        a.counterPresent == b.counterPresent && a.reported == b.reported &&
        a.waiting == b.waiting && a.value == b.value && a.justReported == b.justReported &&
        a.stack == b.stack && a.frames == b.frames && a.trash == b.trash &&
        a.counter == b.counter;
}
static Frame snapshot(Thread& t, Variable& v) {
    auto* f = t.peekStackFrame();
    auto* c = f ? f->executionContext.get() : nullptr;
    auto& blocks = *t.blockContainer;
    auto& cache = blocks.cache();
    const Block* body = blocks.getBlock("inc");
    const std::string literal = body->inputs.find("VALUE")->block;
    auto bodyIt = cache.executeCached.find("inc"), litIt = cache.executeCached.find(literal);
    const BlockCached* bc = bodyIt == cache.executeCached.end() ? nullptr : bodyIt->second.get();
    const BlockCached* lc = litIt == cache.executeCached.end() ? nullptr : litIt->second.get();
    return {t.peekStack(), t.blockGlowInFrame, f && f->op ? f->op->id : "",
            bc ? bc->opcode : "", t.status,
            t.requestScriptGlowInFrame, f && f->isLoop, f && f->warpMode,
            c && c->hasLoopCounter, f && f->hasReported, f && f->waitingReporter,
            bc != nullptr, cache.inputs.count("inc") != 0, lc != nullptr,
            cache.inputs.count(literal) != 0, bc && lc && lc->parentValues == &bc->argValues,
            bc ? bc->ops.size() : 0, v.value.bits, t.justReported.bits, t.stack,
            t.stackFrames.size(), t.trashFrames.size(), c && c->hasLoopCounter ? c->loopCounter : 0};
}
struct Result { std::vector<Frame> trace; std::vector<unsigned> steps; unsigned executions; };
static Result run(bool enable, int count, bool noGlow, bool peer, Case mode) {
    std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"loop","inputs":{},"fields":{}},"loop":{"opcode":"control_repeat","next":null,"inputs":{"TIMES":[1,[4,")" + std::to_string(count) + R"("]],"SUBSTACK":[2,"inc"]},"fields":{}},"inc":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"1"]]},"fields":{"VARIABLE":["v","v"]}})";
    if (peer) json += R"(,"hat2":{"opcode":"event_whenflagclicked","topLevel":true,"next":"peer","inputs":{},"fields":{}},"peer":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"10"]]},"fields":{"VARIABLE":["v","v"]}})";
    json += R"(},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime rt;
    assert(loadSb3(rt, json, nullptr).ok);
    auto* target = rt.getTargetForStage();
    target->blocks->forceNoGlow = noGlow;
    auto* v = target->lookupVariableById("v");
    auto* body = target->blocks->getBlock("inc");
    auto* literal = target->blocks->getBlock(body->inputs.find("VALUE")->block);
    if (mode == Case::MinusZero) { v->value = Value::num(-0.0); literal->fields["NUM"].value = Value::num(-0.0); }
    if (mode == Case::NaN) v->value = Value::num(std::numeric_limits<double>::quiet_NaN());
    if (mode == Case::PositiveInf) v->value = Value::num(std::numeric_limits<double>::infinity());
    if (mode == Case::NegativeInf) v->value = Value::num(-std::numeric_limits<double>::infinity());
    if (mode == Case::Overflow) { v->value = Value::num(1e308); literal->fields["NUM"].value = Value::num(1e308); }
    xyo_safe_jit_enable(enable);
#ifndef LOOP_ORACLE_ONLY
    xyo_safe_jit_loop_experiment(enable);
#endif
    xyo_safe_jit_fail_after_invoke(mode == Case::FailAfterInvoke);
    xyo_safe_jit_reject_compile(mode == Case::RejectCompile);
    loop_test_trap(mode == Case::Trap);
    const unsigned before = xyo_safe_jit_executions();
    const unsigned trapsBefore = loop_test_traps();
    rt.greenFlag();
    Thread *loop = nullptr, *other = nullptr;
    for (Thread* t : rt.threads) {
        if (t->topBlock == "hat") loop = t;
        if (t->topBlock == "hat2") other = t;
    }
    assert(loop && (!peer || other));
    if (mode == Case::Cached) assert(target->blocks->getCachedExecute("inc"));
    if (mode == Case::Edit) {
        auto* body = target->blocks->getBlock("inc");
        auto* literal = target->blocks->getBlock(body->inputs.find("VALUE")->block);
        literal->fields["NUM"].value = Value::num(2);
    }
    if (mode == Case::Override) rt.registerPrimitive("data_changevariableby", overrideChange);
    if (mode == Case::ParentCached) assert(target->blocks->getCachedExecute("loop"));
    if (mode == Case::ParentOverride || mode == Case::ParentCached)
        rt.registerPrimitive("control_repeat", overrideChange);
    if (mode == Case::Shared) target->blocks->getBlock("loop")->inputs.set("EXTRA", *body->inputs.find("VALUE"));
    Result result;
    if (mode == Case::Stop) {
        rt.stopAll();
        assert(xyo_safe_jit_live_modules() == 0);
    } else {
        for (int n = 0; n < count + 1; ++n) {
            rt.sequencer->stepThread(*loop);
            result.trace.push_back(snapshot(*loop, *v));
            result.steps.push_back(xyo_safe_jit_executions() - before);
            if (peer && n == 0) {
                // The peer must use the interpreter, so it cannot contaminate
                // the loop-execution counter. It still mutates the shared slot.
                xyo_safe_jit_enable(0);
                rt.sequencer->stepThread(*other);
                xyo_safe_jit_enable(enable);
                result.trace.push_back(snapshot(*loop, *v));
                result.steps.push_back(xyo_safe_jit_executions() - before);
            }
            if (loop->status == STATUS_DONE) break;
        }
        assert(loop->status == STATUS_DONE);
        assert(xyo_safe_jit_live_modules() == 0);
    }
    result.executions = xyo_safe_jit_executions() - before;
#ifndef LOOP_ORACLE_ONLY
    if (enable && count > 0 && mode == Case::Trap)
        assert(loop_test_traps() == trapsBefore + 1);
#endif
    xyo_safe_jit_fail_after_invoke(0);
    xyo_safe_jit_reject_compile(0);
    loop_test_trap(0);
#ifndef LOOP_ORACLE_ONLY
    xyo_safe_jit_loop_experiment(0);
#endif
    xyo_safe_jit_enable(0);
    return result;
}
int main() {
    for (int count : {0, 2}) for (bool noGlow : {false, true})
    for (bool peer : {false, true})
    for (Case mode : {Case::Normal, Case::Cached, Case::Edit, Case::Override,
                      Case::ParentOverride, Case::ParentCached, Case::Shared,
                      Case::MinusZero, Case::NaN, Case::PositiveInf, Case::NegativeInf, Case::Overflow,
                      Case::FailAfterInvoke, Case::Trap, Case::RejectCompile, Case::Stop}) {
        const Result oracle = run(false, count, noGlow, peer, mode);
#ifdef LOOP_ORACLE_ONLY
        const Result candidate = run(false, count, noGlow, peer, mode);
        const unsigned expected = 0;
#else
        const Result candidate = run(true, count, noGlow, peer, mode);
        const unsigned expected = count > 0 && (mode == Case::Normal || mode == Case::ParentCached || mode == Case::MinusZero) ? 1 : 0;
#endif
        assert(candidate.trace == oracle.trace);
        if (count == 2 && !noGlow && !peer && mode >= Case::MinusZero && mode <= Case::Overflow)
            std::printf("numeric case %d: bits=%016llx wasm executions=%u\n", int(mode),
                (unsigned long long)candidate.trace.back().value, candidate.executions);
        assert(candidate.executions == expected);
        for (unsigned n : candidate.steps) assert(n == expected);
        for (unsigned n : oracle.steps) assert(n == 0);
        assert(oracle.executions == 0);
    }
    std::puts("loop first-iteration differential: PASS");
}
