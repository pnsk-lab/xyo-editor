// Interpreter-only oracle for the proposed non-warp loop boundary. This does
// not enable or test a loop compiler. Link against xyo built without native JIT.
#include "safe_runtime.hpp"
#include "engine/runtime.hpp"
#include "engine/sequencer.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include <cassert>
#include <cstdio>

using namespace xyo;
int main() {
    const char* project = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"loop","inputs":{},"fields":{}},"loop":{"opcode":"control_repeat","next":"after","inputs":{"TIMES":[1,[4,"2"]],"SUBSTACK":[2,"inc"]},"fields":{}},"inc":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"1"]]},"fields":{"VARIABLE":["v","v"]}},"after":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"10"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    xyo_safe_jit_enable(0);
    Runtime rt;
    assert(loadSb3(rt, project, nullptr).ok);
    rt.greenFlag();
    assert(rt.threads.size() == 1);
    Thread& t = *rt.threads[0];
    auto* var = rt.getTargetForStage()->lookupVariableById("v");
    for (int i = 1; i <= 2; ++i) {
        rt.sequencer->stepThread(t);
        assert(t.status == STATUS_RUNNING && t.stack.size() == 1 && t.peekStack() == "loop");
        auto* frame = t.peekStackFrame();
        assert(frame && frame->isLoop && !frame->warpMode && frame->executionContext);
        assert(frame->executionContext->hasLoopCounter && frame->executionContext->loopCounter == 2 - i);
        assert(t.blockGlowInFrame == "inc");
        assert(var->value.asNumberUnchecked() == i);
    }
    rt.sequencer->stepThread(t);
    assert(t.status == STATUS_DONE && t.stack.empty());
    assert(t.blockGlowInFrame == "after");
    assert(var->value.asNumberUnchecked() == 12);
    std::puts("interpreter loop checkpoint: PASS");
}
