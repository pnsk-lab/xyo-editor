#include "safe_runtime.hpp"
#include "engine/runtime.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>
#include <string>

using namespace xyo;

// A normal flag script assigning the rounded value of another variable.
// Compare exact Value bits, not just numeric equality (notably -0 and NaN).
static uint64_t run(bool enabled, double input, bool expectRun) {
    const std::string project = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7],"w":["w",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"set","inputs":{},"fields":{}},"set":{"opcode":"data_setvariableto","next":null,"inputs":{"VALUE":[2,"round"]},"fields":{"VARIABLE":["v","v"]}},"round":{"opcode":"operator_round","next":null,"inputs":{"NUM":[1,[12,"w","w"]]},"fields":{}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime rt;
    assert(loadSb3(rt, project, nullptr).ok);
    auto* stage = rt.getTargetForStage();
    stage->lookupVariableById("w")->value = Value::num(input);
    xyo_safe_jit_enable(enabled);
    auto c = xyo_safe_jit_compilations(), e = xyo_safe_jit_executions();
    rt.greenFlag();
    assert(xyo_safe_jit_compilations() == c + (enabled ? 1u : 0u));
    rt.runUntilDone(20);
    assert(xyo_safe_jit_executions() == e + (enabled && expectRun ? 1u : 0u));
    assert(xyo_safe_jit_live_modules() == 0);
    return stage->lookupVariableById("v")->value.bits;
}
static Value overriddenRound(const ArgValues&, BlockUtility&) { return Value::num(42); }

static uint64_t runOverride(bool enabled, int mode) {
    const std::string project = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7],"w":["w",3]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"set","inputs":{},"fields":{}},"set":{"opcode":"data_setvariableto","next":null,"inputs":{"VALUE":[2,"round"]},"fields":{"VARIABLE":["v","v"]}},"round":{"opcode":"operator_round","next":null,"inputs":{"NUM":[1,[12,"w","w"]]},"fields":{}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime rt;
    assert(loadSb3(rt, project, nullptr).ok);
    auto* stage = rt.getTargetForStage();
    auto original = rt.getOpcodeFunction("operator_round");
    if (mode == 0 || mode == 2) rt.registerPrimitive("operator_round", overriddenRound);
    if (mode == 2) {
        assert(stage->blocks->getCachedExecute("set"));
        rt.registerPrimitive("operator_round", original);
    }
    xyo_safe_jit_enable(enabled);
    auto executions = xyo_safe_jit_executions();
    rt.greenFlag();
    if (mode == 1) rt.registerPrimitive("operator_round", overriddenRound);
    rt.runUntilDone(20);
    assert(xyo_safe_jit_executions() == executions);
    assert(xyo_safe_jit_live_modules() == 0);
    return stage->lookupVariableById("v")->value.bits;
}

// Execute flag-generated modules in the actual Emscripten runtime; the disabled
// path is the same WASM interpreter, not a native ORC or JS approximation.
extern "C" void xyo_safe_jit_fail_after_invoke(int);
static uint64_t runMath(bool enabled, const char* op, double input, bool expectRun, int mode = 0) {
    std::string project = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7],"w":["w",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"set","inputs":{},"fields":{}},"set":{"opcode":"data_setvariableto","next":null,"inputs":{"VALUE":[2,"math"]},"fields":{"VARIABLE":["v","v"]}},"math":{"opcode":"operator_mathop","next":null,"inputs":{"NUM":[1,[12,"w","w"]]},"fields":{"OPERATOR":[")";
    project += op;
    project += R"(",null]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime rt;
    assert(loadSb3(rt, project, nullptr).ok);
    auto* stage = rt.getTargetForStage();
    stage->lookupVariableById("w")->value = Value::num(input);
    auto original = rt.getOpcodeFunction("operator_mathop");
    if (mode == 1 || mode == 3) rt.registerPrimitive("operator_mathop", overriddenRound);
    if (mode == 3) {
        assert(stage->blocks->getCachedExecute("set"));
        rt.registerPrimitive("operator_mathop", original);
    }
    xyo_safe_jit_enable(enabled);
    auto c = xyo_safe_jit_compilations(), e = xyo_safe_jit_executions();
    rt.greenFlag();
    if (mode == 2) rt.registerPrimitive("operator_mathop", overriddenRound);
    xyo_safe_jit_fail_after_invoke(mode == 4);
    assert(xyo_safe_jit_compilations() == c + (enabled ? 1u : 0u));
    rt.runUntilDone(20);
    xyo_safe_jit_fail_after_invoke(0);
    assert(xyo_safe_jit_executions() == e + (enabled && expectRun ? 1u : 0u));
    assert(xyo_safe_jit_live_modules() == 0);
    return stage->lookupVariableById("v")->value.bits;
}

int main() {
    for (const char* op : {"abs", "FLOOR", "ceiling", "sqrt"}) {
        for (double n : {0.0, -0.0, 0.5, -0.5, 1.5, -1.5,
                         std::numeric_limits<double>::denorm_min(),
                         std::numeric_limits<double>::max(), 4503599627370495.5}) {
            bool accepted = !(std::string(op) == "sqrt" && n < 0);
            assert(runMath(false, op, n, accepted) == runMath(true, op, n, accepted));
        }
        for (double n : {std::numeric_limits<double>::infinity(),
                         -std::numeric_limits<double>::infinity(),
                         std::numeric_limits<double>::quiet_NaN()})
            assert(runMath(false, op, n, false) == runMath(true, op, n, false));
    }
    for (int mode = 1; mode <= 4; ++mode)
        assert(runMath(false, "abs", -3, false, mode) ==
               runMath(true, "abs", -3, false, mode));
    for (double n : {0.0, -0.0, 0.49999999999999994, 0.5, -0.5,
                     -0.5000000000000001, 1.5, -1.5, 4503599627370496.0})
        assert(run(false, n, true) == run(true, n, true));
    for (double n : {std::numeric_limits<double>::infinity(),
                     std::numeric_limits<double>::quiet_NaN()})
        assert(run(false, n, false) == run(true, n, false));
    for (int mode = 0; mode != 3; ++mode) {
        auto expected = runOverride(false, mode);
        assert(expected == Value::num(42).bits);
        assert(runOverride(true, mode) == expected);
    }
    std::puts("round and mathop: real WASM matches interpreter, including registry, cache and rollback fallbacks");
}
