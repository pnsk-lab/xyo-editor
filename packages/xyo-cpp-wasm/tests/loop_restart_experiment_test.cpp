// Isolated testing-only loop experiment: restart handle lifecycle and stale cache.
#include "safe_runtime.hpp"
#include "engine/runtime.hpp"
#include "engine/sequencer.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include <cassert>
#include <cstdio>
extern "C" void xyo_safe_jit_loop_experiment(int);
using namespace xyo;
int main() {
    const char* project = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"loop","inputs":{},"fields":{}},"loop":{"opcode":"control_repeat","next":null,"inputs":{"TIMES":[1,[4,"2"]],"SUBSTACK":[2,"inc"]},"fields":{}},"inc":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"1"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    xyo_safe_jit_enable(1); xyo_safe_jit_loop_experiment(1);
    {
        Runtime rt; assert(loadSb3(rt, project, nullptr).ok);
        for (int i = 0; i < 100; ++i) {
            assert(rt.startHats("event_whenflagclicked", nullptr, nullptr).size() == 1);
            assert(xyo_safe_jit_live_modules() == 1);
        }
        for (int i = 0; i < 100; ++i) {
            rt.greenFlag(); assert(xyo_safe_jit_live_modules() == 1);
        }
        auto before = xyo_safe_jit_executions();
        assert(rt.threads.size() == 1);
        rt.sequencer->stepThread(*rt.threads[0]);
        assert(xyo_safe_jit_executions() == before + 1);
        assert(xyo_safe_jit_live_modules() == 0);
        rt.greenFlag();
        assert(xyo_safe_jit_live_modules() == 1);
        rt.sequencer->stepThread(*rt.threads[0]);
        assert(xyo_safe_jit_executions() == before + 1); // existing body cache: interpreter
        rt.stopAll(); assert(xyo_safe_jit_live_modules() == 0);
    }
    assert(xyo_safe_jit_live_modules() == 0);
    xyo_safe_jit_loop_experiment(0); xyo_safe_jit_enable(0);
    std::puts("loop reflag/restart lifecycle: PASS");
}
