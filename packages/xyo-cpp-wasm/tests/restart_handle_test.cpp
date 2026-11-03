// Regression: a restarted green-flag Thread must not retain its old module.
#include "safe_runtime.hpp"
#include "engine/runtime.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include <string>
#include <cassert>
#include <cstdio>
using namespace xyo;
int main() {
    const char* project = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"inc","inputs":{},"fields":{}},"inc":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"1"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    bool ok = true;
    {
    Runtime rt;
    assert(loadSb3(rt, project, nullptr).ok);
    xyo_safe_jit_enable(1);
    assert(xyo_safe_jit_live_modules() == 0);
    assert(rt.startHats("event_whenflagclicked", nullptr, nullptr).size() == 1);
    assert(xyo_safe_jit_live_modules() == 1);
    for (int i = 0; i < 100; ++i)
        assert(rt.startHats("event_whenflagclicked", nullptr, nullptr).size() == 1);
    unsigned afterRestart = xyo_safe_jit_live_modules();
    rt.stopAll();
    unsigned afterStop = xyo_safe_jit_live_modules();
    std::printf("live modules after restart=%u after stop=%u (expected 1,0)\n", afterRestart, afterStop);
    ok = afterRestart == 1 && afterStop == 0;
    }
    assert(xyo_safe_jit_live_modules() == 0); // destructor clears even abandoned threads
    {
        // The second sprite is not restarted. Its pending module must survive.
        std::string two = project;
        const auto pos = two.find(R"(}],"monitors")");
        assert(pos != std::string::npos);
        const std::string sprite = R"(,{"isStage":false,"name":"Sprite","variables":{},"lists":{},"broadcasts":{},"blocks":{"hat2":{"opcode":"event_whenflagclicked","topLevel":true,"next":"inc2","inputs":{},"fields":{}},"inc2":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"2"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0})";
        two.insert(pos + 1, sprite);
        Runtime rt;
        assert(loadSb3(rt, two, nullptr).ok);
        Target *stage = rt.getTargetForStage(), *other = nullptr;
        for (Target* t : rt.targets) if (!t->isStage) other = t;
        assert(other);
        assert(rt.startHats("event_whenflagclicked", nullptr, stage).size() == 1);
        assert(rt.startHats("event_whenflagclicked", nullptr, other).size() == 1);
        assert(xyo_safe_jit_live_modules() == 2);
        for (int i = 0; i < 100; ++i)
            assert(rt.startHats("event_whenflagclicked", nullptr, stage).size() == 1);
        const unsigned afterRestart = xyo_safe_jit_live_modules();
        rt.stopForTarget(stage, nullptr);
        const unsigned afterTargetStop = xyo_safe_jit_live_modules();
        rt.stopAll();
        const unsigned afterStop = xyo_safe_jit_live_modules();
        std::printf("peer: restart=%u target-stop=%u stop=%u (expected 2,1,0)\n", afterRestart, afterTargetStop, afterStop);
        ok &= afterRestart == 2 && afterTargetStop == 1 && afterStop == 0;
    }
    assert(xyo_safe_jit_live_modules() == 0);
    return ok ? 0 : 1;
}
