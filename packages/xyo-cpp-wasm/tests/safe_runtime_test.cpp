#include "safe_runtime.hpp"
#include "safe_lower.hpp"
#include "engine/runtime.hpp"
#include "engine/sequencer.hpp"
#include "engine/thread.hpp"
#include "load/sb3.hpp"
#include "load/zip.hpp"
#include "model/target.hpp"
#include "core/cast.hpp"
#include "core/sstr.hpp"
#include <cassert>
#include <limits>
#include <cstdio>
#include <string>

extern "C" void xyo_safe_jit_fail_after_invoke(int);
extern "C" void xyo_safe_jit_reject_compile(int);
using namespace xyo;

static uint64_t run(bool enabled, bool forceFailure, const char* initial,
                    bool unsupported, unsigned expectedRuns, bool edit = false, bool reject = false) {
    std::string first = unsupported ? "say" : "a";
    std::string blocks = R"("hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":")" + first + R"(","inputs":{},"fields":{}},)";
    if (unsupported) blocks += R"("say":{"opcode":"looks_say","next":"a","inputs":{"MESSAGE":[1,[10,"hello"]]},"fields":{}},)";
    blocks += R"("a":{"opcode":"data_changevariableby","next":"b","inputs":{"VALUE":[1,[4,"3"]]},"fields":{"VARIABLE":["v","v"]}},"b":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"2"]]},"fields":{"VARIABLE":["v","v"]}})";
    std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",)";
    json += initial;
    json += R"(]},"lists":{},"broadcasts":{},"blocks":{)" + blocks + R"(},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime rt;
    auto loaded = loadSb3(rt, json, nullptr);
    assert(loaded.ok);
    auto before = xyo_safe_jit_executions();
    auto beforeCompile = xyo_safe_jit_compilations();
    auto beforeAttempts = xyo_safe_jit_attempts();
    auto beforeFallbacks = xyo_safe_jit_fallbacks();
    assert(xyo_safe_jit_live_modules() == 0);
    auto initialBits = rt.getTargetForStage()->lookupVariableById("v")->value.bits;
    xyo_safe_jit_enable(enabled);
    xyo_safe_jit_fail_after_invoke(forceFailure);
    xyo_safe_jit_reject_compile(reject);
    rt.greenFlag();
    assert(xyo_safe_jit_attempts() == beforeAttempts + (enabled ? 1u : 0u));
    assert(xyo_safe_jit_compilations() == beforeCompile + (enabled && !reject ? 1u : 0u));
    assert(xyo_safe_jit_live_modules() == (enabled && !reject ? 1u : 0u));
    assert(xyo_safe_jit_executions() == before);
    assert(rt.getTargetForStage()->lookupVariableById("v")->value.bits == initialBits);
    if (enabled && !forceFailure && !unsupported && !edit && !reject && expectedRuns == 1) {
        rt.greenFlag(); // abandon the first prepared instance before stepping
        assert(xyo_safe_jit_live_modules() == 1);
        assert(xyo_safe_jit_executions() == before);
    }
    if (edit) {
        auto* blocks = rt.getTargetForStage()->blocks;
        const auto* input = blocks->getBlock("a")->inputs.find("VALUE");
        auto* literal = blocks->getBlock(input->block.empty() ? input->shadow : input->block);
        assert(literal);
        literal->fields["NUM"].value = Value::num(10);
        blocks->resetCache();
    }
    rt.runUntilDone(20);
    xyo_safe_jit_fail_after_invoke(0);
    xyo_safe_jit_reject_compile(0);
    assert(xyo_safe_jit_live_modules() == 0);
    assert(xyo_safe_jit_fallbacks() == beforeFallbacks + (enabled && !expectedRuns ? 1u : 0u));
    assert(rt.threads.empty());
    std::printf("enabled=%d fail=%d initial=%s unsupported=%d count=%u expected=%u\n", enabled, forceFailure, initial, unsupported, xyo_safe_jit_executions() - before, expectedRuns);
    assert(xyo_safe_jit_executions() == before + expectedRuns);
    auto* v = rt.getTargetForStage()->lookupVariableById("v");
    assert(v && v->value.isNumber());
    const auto result = v->value.bits;
    if (enabled && !forceFailure && !unsupported && !edit && expectedRuns == 1) {
        const auto oldCompiles = xyo_safe_jit_compilations();
        const auto oldRuns = xyo_safe_jit_executions();
        rt.greenFlag();
        assert(xyo_safe_jit_compilations() == oldCompiles + 1);
        assert(xyo_safe_jit_executions() == oldRuns);
        rt.runUntilDone(20);
        // The first run populated interpreter caches; until their snapshots are
        // verified, a later flag execution conservatively falls back.
        assert(xyo_safe_jit_executions() == oldRuns);
        assert(v->value.bits == Value::num(17).bits);
    }
    return result;
}
static uint64_t runNonfinite(bool enabled, bool nested, int mode = 0) {
    const std::string outer = nested ? R"(,"outer":{"opcode":"operator_add","next":null,"inputs":{"NUM1":[2,"div"],"NUM2":[1,[4,"1"]]},"fields":{}})" : "";
    const std::string expr = nested ? "outer" : "div";
    std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"change","inputs":{},"fields":{}},"change":{"opcode":"data_changevariableby","next":"set","inputs":{"VALUE":[1,[4,"3"]]},"fields":{"VARIABLE":["v","v"]}},"set":{"opcode":"data_setvariableto","next":null,"inputs":{"VALUE":[2,")" + expr + R"("]},"fields":{"VARIABLE":["v","v"]}},"div":{"opcode":"operator_divide","next":null,"inputs":{"NUM1":[1,[4,"0"]],"NUM2":[1,[4,"0"]]},"fields":{}})" + outer + R"(},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    if (mode == 1) {
        const auto pos = json.find(R"("NUM1":[1,[4,"0"]])");
        assert(pos != std::string::npos);
        json.replace(pos, std::string(R"("NUM1":[1,[4,"0"]])").size(), R"("NUM1":[1,[4,"1"]])");
    } else if (mode == 2) {
        const auto op = json.find("operator_divide");
        assert(op != std::string::npos);
        json.replace(op, std::string("operator_divide").size(), "operator_multiply");
        for (const char* key : {"NUM1", "NUM2"}) {
            const std::string old = std::string("\"") + key + R"(":[1,[4,"0"]])";
            const std::string replacement = std::string("\"") + key + R"(":[1,[4,"1e308"]])";
            const auto pos = json.find(old);
            assert(pos != std::string::npos);
            json.replace(pos, old.size(), replacement);
        }
    }
    Runtime rt;
    assert(loadSb3(rt, json, nullptr).ok);
    xyo_safe_jit_enable(enabled);
    auto compileCount = xyo_safe_jit_compilations();
    auto executionCount = xyo_safe_jit_executions();
    auto fallbackCount = xyo_safe_jit_fallbacks();
    rt.greenFlag();
    assert(xyo_safe_jit_compilations() == compileCount + (enabled ? 1u : 0u));
    rt.runUntilDone(20);
    assert(xyo_safe_jit_executions() == executionCount);
    assert(xyo_safe_jit_fallbacks() == fallbackCount + (enabled ? 1u : 0u));
    assert(xyo_safe_jit_live_modules() == 0);
    return rt.getTargetForStage()->lookupVariableById("v")->value.bits;
}
struct ObservedValue {
    bool number;
    uint64_t bits;
    std::u16string text;
};
static ObservedValue runSet(bool enabled, const char* input, const char* source,
                            bool nanSource, bool expectCompiled, bool expectRun) {
    std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",0],"w":["w",)";
    json += source;
    json += R"(]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"set","inputs":{},"fields":{}},"set":{"opcode":"data_setvariableto","next":null,"inputs":{"VALUE":)";
    json += input;
    json += R"(},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime rt;
    assert(loadSb3(rt, json, nullptr).ok);
    auto* stage = rt.getTargetForStage();
    if (nanSource) stage->lookupVariableById("w")->value = Value::num(std::numeric_limits<double>::quiet_NaN());
    xyo_safe_jit_enable(enabled);
    const auto compiles = xyo_safe_jit_compilations();
    const auto runs = xyo_safe_jit_executions();
    rt.greenFlag();
    assert(xyo_safe_jit_compilations() == compiles + (enabled && expectCompiled ? 1u : 0u));
    rt.runUntilDone(20);
    assert(xyo_safe_jit_executions() == runs + (enabled && expectRun ? 1u : 0u));
    assert(xyo_safe_jit_live_modules() == 0);
    Value v = stage->lookupVariableById("v")->value;
    return {v.isNumber(), v.bits, std::u16string(cast::toString(v)->view())};
}
static void compareSet(const char* input, const char* source, bool nanSource,
                       bool expectCompiled, bool expectRun) {
    auto a = runSet(false, input, source, nanSource, expectCompiled, expectRun);
    auto b = runSet(true, input, source, nanSource, expectCompiled, expectRun);
    assert(a.number == b.number && a.text == b.text);
    if (a.number) assert(a.bits == b.bits);
}
struct Completion {
    size_t stackSize;
    int status;
    bool glow;
    std::string blockGlow;
    uint64_t value;
};
static Completion completion(bool enabled, bool noGlow) {
    const char* json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"a","inputs":{},"fields":{}},"a":{"opcode":"data_changevariableby","next":"b","inputs":{"VALUE":[1,[4,"3"]]},"fields":{"VARIABLE":["v","v"]}},"b":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"2"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime rt;
    assert(loadSb3(rt, json, nullptr).ok);
    auto* stage = rt.getTargetForStage();
    stage->blocks->forceNoGlow = noGlow;
    xyo_safe_jit_enable(enabled);
    const auto before = xyo_safe_jit_executions();
    rt.greenFlag();
    assert(rt.threads.size() == 1);
    Thread* t = rt.threads[0];
    rt.sequencer->stepThread(*t);
    assert(xyo_safe_jit_executions() == before + (enabled ? 1u : 0u));
    return {t->stack.size(), int(t->status), t->requestScriptGlowInFrame,
            t->blockGlowInFrame, stage->lookupVariableById("v")->value.bits};
}
static void compareCompletion(bool noGlow) {
    const auto a = completion(false, noGlow), b = completion(true, noGlow);
    assert(a.stackSize == 0 && b.stackSize == a.stackSize);
    assert(a.status == STATUS_DONE && b.status == a.status);
    assert(a.glow == !noGlow && b.glow == a.glow);
    assert(a.blockGlow == "b" && b.blockGlow == a.blockGlow);
    assert(a.value == b.value);
}
static void mixedSb3() {
    const std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"a","inputs":{},"fields":{}},"a":{"opcode":"data_changevariableby","next":"c","inputs":{"VALUE":[1,[4,"3"]]},"fields":{"VARIABLE":["v","v"]}},"c":{"opcode":"data_changevariableby","next":"say","inputs":{"VALUE":[1,[4,"2"]]},"fields":{"VARIABLE":["v","v"]}},"say":{"opcode":"looks_say","next":"wait","inputs":{"MESSAGE":[1,[10,"hello"]]},"fields":{}},"wait":{"opcode":"control_wait","next":"b","inputs":{"DURATION":[1,[4,"0"]]},"fields":{}},"b":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"2"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    ZipWriter writer;
    writer.addFile("project.json", std::vector<uint8_t>(json.begin(), json.end()));
    const auto sb3 = writer.finish();
    Runtime interp, compiled;
    assert(loadSb3File(interp, sb3.data(), sb3.size()).ok);
    assert(loadSb3File(compiled, sb3.data(), sb3.size()).ok);
    xyo_safe_jit_enable(false);
    interp.greenFlag();
    xyo_safe_jit_enable(true);
    const auto beforeCompile = xyo_safe_jit_compilations();
    const auto beforeRun = xyo_safe_jit_executions();
    compiled.greenFlag();
    assert(xyo_safe_jit_compilations() == beforeCompile + 1);
    assert(interp.threads.size() == 1 && compiled.threads.size() == 1);
    Thread* a = interp.threads[0];
    Thread* b = compiled.threads[0];
    // Disable for the baseline's step, then enable only for the compiled one.
    for (int frame = 0; frame < 5; ++frame) {
        xyo_safe_jit_enable(false); interp.step();
        xyo_safe_jit_enable(true); compiled.step();
        assert(a->stack == b->stack && a->status == b->status);
        assert(a->requestScriptGlowInFrame == b->requestScriptGlowInFrame);
        assert(a->blockGlowInFrame == b->blockGlowInFrame);
        assert(interp.getTargetForStage()->lookupVariableById("v")->value.bits ==
               compiled.getTargetForStage()->lookupVariableById("v")->value.bits);
        assert(interp.getTargetForStage()->bubbleText == compiled.getTargetForStage()->bubbleText);
    }
    assert(xyo_safe_jit_executions() == beforeRun + 1);
    assert(compiled.getTargetForStage()->lookupVariableById("v")->value.bits == Value::num(14).bits);

    // Cache stale while the live graph matches the compiled plan; edit with
    // cache reset; injected invocation failure; globally shared reporter.
    for (int mode = 0; mode < 9; ++mode) {
        auto archive = sb3;
        if (mode == 4) {
            std::string alias = json;
            const auto c = alias.find(R"("c":{"opcode")");
            const auto field = alias.find(R"("VARIABLE":["v","v"])", c);
            assert(c != std::string::npos && field != std::string::npos);
            alias.replace(field, std::string(R"("VARIABLE":["v","v"])").size(),
                          R"("VARIABLE":["v","missing"])");
            ZipWriter aliasWriter;
            aliasWriter.addFile("project.json", std::vector<uint8_t>(alias.begin(), alias.end()));
            archive = aliasWriter.finish();
        }
        Runtime ref, opt;
        assert(loadSb3File(ref, archive.data(), archive.size()).ok);
        assert(loadSb3File(opt, archive.data(), archive.size()).ok);
        xyo_safe_jit_enable(false); ref.greenFlag();
        xyo_safe_jit_enable(true); opt.greenFlag();
        assert(ref.threads.size() == 1 && opt.threads.size() == 1);
        Thread* r = ref.threads[0]; Thread* o = opt.threads[0];
        for (Runtime* rt : {&ref, &opt}) {
            auto* blocks = rt->getTargetForStage()->blocks;
            auto* input = blocks->getBlock("a")->inputs.find("VALUE");
            assert(input && !input->block.empty());
            const std::string literalId = input->block;
            auto* literal = blocks->getBlock(literalId);
            assert(literal);
            if (mode == 0) {
                Value original = literal->fields["NUM"].value;
                literal->fields["NUM"].value = Value::num(10);
                assert(blocks->getCachedExecute("a"));
                literal->fields["NUM"].value = original; // deliberately no reset
            } else if (mode == 1) {
                literal->fields["NUM"].value = Value::num(10);
                blocks->resetCache();
            } else if (mode == 3) {
                Block shared; shared.id = "external"; shared.opcode = "operator_round";
                shared.inputs.set("NUM", {literalId, ""});
                blocks->createBlock(std::move(shared));
            } else if (mode == 5 || mode == 6) {
                const size_t target = mode == 5 ? 4096 : 4097;
                while (blocks->size() < target) {
                    Block extra; extra.id = "unused_" + std::to_string(blocks->size());
                    extra.opcode = "unused";
                    blocks->createBlock(std::move(extra));
                }
            } else if (mode >= 7) {
                size_t count = 0;
                for (const auto& entry : blocks->allBlocks()) count += entry.second.inputs.size();
                const size_t target = mode == 7 ? 16384 : 16385;
                Block extra; extra.id = "many_inputs"; extra.opcode = "unused";
                while (count++ < target) extra.inputs.items.emplace_back("unused", BlockInput{});
                blocks->createBlock(std::move(extra));
            }
        }
        const auto executions = xyo_safe_jit_executions();
        const auto fallbacks = xyo_safe_jit_fallbacks();
        xyo_safe_jit_fail_after_invoke(mode == 2);
        for (int frame = 0; frame < 5; ++frame) {
            xyo_safe_jit_enable(false); ref.step();
            xyo_safe_jit_enable(true); opt.step();
            assert(r->stack == o->stack && r->status == o->status);
            assert(r->requestScriptGlowInFrame == o->requestScriptGlowInFrame);
            assert(r->blockGlowInFrame == o->blockGlowInFrame);
            assert(ref.getTargetForStage()->lookupVariableById("v")->value.bits ==
                   opt.getTargetForStage()->lookupVariableById("v")->value.bits);
            assert(ref.getTargetForStage()->bubbleText == opt.getTargetForStage()->bubbleText);
        }
        xyo_safe_jit_fail_after_invoke(0);
        const bool withinLimit = mode == 5 || mode == 7;
        assert(xyo_safe_jit_executions() == executions + (withinLimit ? 1u : 0u));
        assert(xyo_safe_jit_fallbacks() == fallbacks + (withinLimit ? 0u : 1u));
        assert(xyo_safe_jit_live_modules() == 0);
    }
}
// A genuine zipped SB3: common string-valued numeric shadow in a set, then
// an interpreted looks block, followed by a generated arithmetic chunk.
static void deferredChunkSb3() {
    const std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"init","inputs":{},"fields":{}},"init":{"opcode":"data_setvariableto","next":"say","inputs":{"VALUE":[1,[4,"0"]]},"fields":{"VARIABLE":["v","v"]}},"say":{"opcode":"looks_say","next":"a","inputs":{"MESSAGE":[1,[10,"hello"]]},"fields":{}},"a":{"opcode":"data_changevariableby","next":"b","inputs":{"VALUE":[1,[4,"3"]]},"fields":{"VARIABLE":["v","v"]}},"b":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"2"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    ZipWriter writer;
    writer.addFile("project.json", std::vector<uint8_t>(json.begin(), json.end()));
    const auto sb3 = writer.finish();
    for (int mode = 0; mode < 5; ++mode) {
        Runtime ref, opt;
        assert(loadSb3File(ref, sb3.data(), sb3.size()).ok);
        assert(loadSb3File(opt, sb3.data(), sb3.size()).ok);
        xyo_safe_jit_enable(false); ref.greenFlag();
        xyo_safe_jit_enable(true);
        const auto compiles = xyo_safe_jit_compilations(), runs = xyo_safe_jit_executions();
        opt.greenFlag();
        assert(xyo_safe_jit_compilations() == compiles + 1);
        assert(xyo_safe_jit_executions() == runs);
        Thread* r = ref.threads[0]; Thread* o = opt.threads[0];
        for (Runtime* rt : {&ref, &opt}) {
            auto* blocks = rt->getTargetForStage()->blocks;
            if (mode == 1) {
                auto* a = blocks->getBlock("a");
                const auto literal = a->inputs.find("VALUE")->block;
                blocks->getBlock(literal)->fields["NUM"].value = Value::num(10);
                blocks->resetCache();
            } else if (mode == 2) {
                assert(blocks->getCachedExecute("a"));
            } else if (mode == 3) {
                const auto literal = blocks->getBlock("a")->inputs.find("VALUE")->block;
                Block shared; shared.id = "external"; shared.opcode = "operator_round";
                shared.inputs.set("NUM", {literal, ""});
                blocks->createBlock(std::move(shared));
            }
        }
        xyo_safe_jit_fail_after_invoke(mode == 4);
        for (int frame = 0; frame < 3; ++frame) {
            xyo_safe_jit_enable(false); ref.step();
            xyo_safe_jit_enable(true); opt.step();
            assert(r->stack == o->stack && r->status == o->status);
            assert(r->blockGlowInFrame == o->blockGlowInFrame);
            assert(r->requestScriptGlowInFrame == o->requestScriptGlowInFrame);
            assert(ref.getTargetForStage()->bubbleText == opt.getTargetForStage()->bubbleText);
            assert(ref.getTargetForStage()->lookupVariableById("v")->value.bits ==
                   opt.getTargetForStage()->lookupVariableById("v")->value.bits);
        }
        xyo_safe_jit_fail_after_invoke(0);
        assert(xyo_safe_jit_executions() == runs + (mode == 0 ? 1u : 0u));
        assert(xyo_safe_jit_live_modules() == 0);
    }
    // A yield in the interpreted prelude must cancel the prepared module,
    // rather than execute it when a later frame resumes.
    std::string yielding = json;
    auto pos = yielding.find("looks_say\"");
    assert(pos != std::string::npos);
    yielding.replace(pos, std::string("looks_say").size(), "looks_sayforsecs");
    pos = yielding.find(R"("MESSAGE":[1,[10,"hello"]])");
    assert(pos != std::string::npos);
    yielding.replace(pos, std::string(R"("MESSAGE":[1,[10,"hello"]])").size(),
                     R"("MESSAGE":[1,[10,"hello"]],"SECS":[1,[4,"10"]])");
    Runtime ref, opt;
    assert(loadSb3(ref, yielding, nullptr).ok && loadSb3(opt, yielding, nullptr).ok);
    xyo_safe_jit_enable(false); ref.greenFlag();
    xyo_safe_jit_enable(true);
    const auto compiles = xyo_safe_jit_compilations(), runs = xyo_safe_jit_executions();
    opt.greenFlag();
    assert(xyo_safe_jit_compilations() == compiles + 1);
    Thread* r = ref.threads[0]; Thread* o = opt.threads[0];
    xyo_safe_jit_enable(false); ref.step();
    xyo_safe_jit_enable(true); opt.step();
    assert(r->stack == o->stack && r->status == o->status);
    assert(r->blockGlowInFrame == o->blockGlowInFrame);
    const auto rv = ref.getTargetForStage()->lookupVariableById("v")->value;
    const auto ov = opt.getTargetForStage()->lookupVariableById("v")->value;
    assert(rv.isString() && ov.isString());
    assert(cast::toString(rv)->view() == cast::toString(ov)->view());
    assert(xyo_safe_jit_executions() == runs && xyo_safe_jit_live_modules() == 0);
}
static void fullCacheGuards() {
    const char* json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"a","inputs":{},"fields":{}},"a":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"3"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    for (int mode = 0; mode != 2; ++mode) {
        Runtime ref, opt;
        assert(loadSb3(ref, json, nullptr).ok && loadSb3(opt, json, nullptr).ok);
        xyo_safe_jit_enable(false); ref.greenFlag();
        xyo_safe_jit_enable(true); opt.greenFlag();
        for (Runtime* rt : {&ref, &opt}) {
            auto* blocks = rt->getTargetForStage()->blocks;
            const std::string id = blocks->getBlock("a")->inputs.find("VALUE")->block;
            auto* literal = blocks->getBlock(id);
            if (mode == 0) {
                const Value original = literal->fields["NUM"].value;
                literal->fields["NUM"].value = Value::num(10);
                assert(blocks->getCachedExecute("a"));
                literal->fields["NUM"].value = original;
            } else {
                Block shared; shared.id = "external"; shared.opcode = "operator_round";
                shared.inputs.set("NUM", {id, ""});
                blocks->createBlock(std::move(shared));
            }
        }
        const auto runs = xyo_safe_jit_executions(), falls = xyo_safe_jit_fallbacks();
        Thread* a = ref.threads[0]; Thread* b = opt.threads[0];
        xyo_safe_jit_enable(false); ref.step();
        xyo_safe_jit_enable(true); opt.step();
        assert(xyo_safe_jit_executions() == runs && xyo_safe_jit_fallbacks() == falls + 1);
        assert(a->stack == b->stack && a->status == b->status);
        assert(a->requestScriptGlowInFrame == b->requestScriptGlowInFrame);
        assert(a->blockGlowInFrame == b->blockGlowInFrame);
        assert(ref.getTargetForStage()->lookupVariableById("v")->value.bits ==
               opt.getTargetForStage()->lookupVariableById("v")->value.bits);
    }
}
// Until loop cache and resume-state validation are proven, preserve the
// interpreter path and exercise each non-warp repeat scheduling boundary.
static void nonWarpLoopFallback() {
    const std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"repeat","inputs":{},"fields":{}},"repeat":{"opcode":"control_repeat","next":null,"inputs":{"TIMES":[1,[4,"3"]],"SUBSTACK":[2,"body"]},"fields":{}},"body":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"1"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    ZipWriter writer;
    writer.addFile("project.json", std::vector<uint8_t>(json.begin(), json.end()));
    const auto sb3 = writer.finish();
    Runtime ref, opt;
    assert(loadSb3File(ref, sb3.data(), sb3.size()).ok);
    assert(loadSb3File(opt, sb3.data(), sb3.size()).ok);
    xyo_safe_jit_enable(false); ref.greenFlag();
    xyo_safe_jit_enable(true);
    const auto compiles = xyo_safe_jit_compilations();
    const auto executions = xyo_safe_jit_executions();
    opt.greenFlag();
    assert(xyo_safe_jit_compilations() == compiles);
    assert(ref.threads.size() == 1 && opt.threads.size() == 1);
    Thread* r = ref.threads[0]; Thread* o = opt.threads[0];
    for (int i = 0; i < 4; ++i) {
        xyo_safe_jit_enable(false); ref.sequencer->stepThread(*r);
        xyo_safe_jit_enable(true); opt.sequencer->stepThread(*o);
        assert(r->stack == o->stack && r->status == o->status);
        assert(r->blockGlowInFrame == o->blockGlowInFrame);
        assert(r->requestScriptGlowInFrame == o->requestScriptGlowInFrame);
        const auto rv = ref.getTargetForStage()->lookupVariableById("v")->value.bits;
        const auto ov = opt.getTargetForStage()->lookupVariableById("v")->value.bits;
        assert(rv == ov);
        assert(rv == Value::num(i < 3 ? i + 1 : 3).bits);
    }
    assert(r->status == STATUS_DONE && o->status == STATUS_DONE);
    assert(xyo_safe_jit_executions() == executions);
}
static void stringSetThenChange() {
    const char* json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"set","inputs":{},"fields":{}},"set":{"opcode":"data_setvariableto","next":"change","inputs":{"VALUE":[1,[4,"3.5"]]},"fields":{"VARIABLE":["v","v"]}},"change":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,"2"]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime ref, opt;
    assert(loadSb3(ref, json, nullptr).ok && loadSb3(opt, json, nullptr).ok);
    xyo_safe_jit_enable(false); ref.greenFlag();
    xyo_safe_jit_enable(true); const auto runs = xyo_safe_jit_executions(); opt.greenFlag();
    assert(ref.threads.size() == 1 && opt.threads.size() == 1);
    Thread* a = ref.threads[0]; Thread* b = opt.threads[0];
    ref.sequencer->stepThread(*a); opt.sequencer->stepThread(*b);
    assert(xyo_safe_jit_executions() == runs + 1);
    assert(a->status == b->status && a->stack == b->stack);
    assert(a->blockGlowInFrame == b->blockGlowInFrame);
    assert(a->requestScriptGlowInFrame == b->requestScriptGlowInFrame);
    assert(ref.getTargetForStage()->lookupVariableById("v")->value.bits ==
           opt.getTargetForStage()->lookupVariableById("v")->value.bits);
    assert(opt.getTargetForStage()->lookupVariableById("v")->value.bits == Value::num(5.5).bits);
    // A second flag encounters populated mutable execute caches and must fall back.
    const auto afterFirst = xyo_safe_jit_executions();
    opt.greenFlag();
    assert(opt.threads.size() == 1);
    opt.sequencer->stepThread(*opt.threads[0]);
    assert(xyo_safe_jit_executions() == afterFirst);
    assert(opt.getTargetForStage()->lookupVariableById("v")->value.bits == Value::num(5.5).bits);
    // Failure after the generated code ran must not commit its staged writes.
    Runtime rollback;
    assert(loadSb3(rollback, json, nullptr).ok);
    xyo_safe_jit_fail_after_invoke(1);
    rollback.greenFlag();
    assert(rollback.threads.size() == 1);
    rollback.sequencer->stepThread(*rollback.threads[0]);
    xyo_safe_jit_fail_after_invoke(0);
    assert(xyo_safe_jit_executions() == afterFirst);
    assert(rollback.getTargetForStage()->lookupVariableById("v")->value.bits == Value::num(5.5).bits);
}
static void stringSetEdge(const char* set, const char* delta, bool accepted) {
    const std::string json = std::string(R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",7]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"set","inputs":{},"fields":{}},"set":{"opcode":"data_setvariableto","next":"change","inputs":{"VALUE":[1,[4,")") + set + R"("]]},"fields":{"VARIABLE":["v","v"]}},"change":{"opcode":"data_changevariableby","next":null,"inputs":{"VALUE":[1,[4,")" + delta + R"("]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    Runtime ref, opt;
    assert(loadSb3(ref, json, nullptr).ok && loadSb3(opt, json, nullptr).ok);
    auto* blocks = opt.getTargetForStage()->blocks;
    wasm::SafeScript script;
    assert(wasm::lowerSafeFlag(*blocks, blocks->getBlock("hat"), script) == accepted);
    xyo_safe_jit_enable(false); ref.greenFlag();
    xyo_safe_jit_enable(true); const auto runs = xyo_safe_jit_executions(); opt.greenFlag();
    assert(ref.threads.size() == 1 && opt.threads.size() == 1);
    Thread* a = ref.threads[0]; Thread* b = opt.threads[0];
    ref.sequencer->stepThread(*a); opt.sequencer->stepThread(*b);
    if (accepted) assert(xyo_safe_jit_executions() == runs + 1);
    assert(a->status == b->status && a->stack == b->stack);
    assert(a->blockGlowInFrame == b->blockGlowInFrame);
    assert(a->requestScriptGlowInFrame == b->requestScriptGlowInFrame);
    assert(ref.getTargetForStage()->lookupVariableById("v")->value.bits ==
           opt.getTargetForStage()->lookupVariableById("v")->value.bits);
}
int main() {
    stringSetEdge("-0", "-0", true);
    stringSetEdge("   ", "abc", true);
    stringSetEdge("abc", "1", false);
    stringSetEdge("NaN", "1", false);
    stringSetEdge("Infinity", "1", false);
    stringSetEdge("-Infinity", "1", false);
    stringSetThenChange();
    deferredChunkSb3();
    nonWarpLoopFallback();
    fullCacheGuards();
    mixedSb3();
    compareCompletion(false);
    compareCompletion(true);
    compareSet(R"([1,[4,3]])", "0", false, true, true);
    compareSet(R"([1,[4,-0.0]])", "0", false, true, true);
    compareSet(R"([1,[4,"3"]])", "0", false, false, false);
    compareSet(R"([1,[12,"w","w"]])", "-17", false, true, true);
    compareSet(R"([1,[12,"w","w"]])", "\"7\"", false, true, false);
    compareSet(R"([1,[12,"w","w"]])", "0", true, true, false);
    assert(runNonfinite(false, false) == runNonfinite(true, false));
    assert(runNonfinite(false, true) == runNonfinite(true, true));
    assert(runNonfinite(false, false, 1) == runNonfinite(true, false, 1));
    assert(runNonfinite(false, false, 2) == runNonfinite(true, false, 2));
    auto baseline = run(false, false, "7", false, 0);
    auto compiled = run(true, false, "7", false, 1);
    auto rolledBack = run(true, true, "7", false, 0);
    auto nonNumeric = run(true, false, "\"7\"", false, 0);
    auto unsupported = run(true, false, "7", true, 1);
    auto edited = run(true, false, "7", false, 0, true);
    auto rejected = run(true, false, "7", false, 0, false, true);
    assert(rejected == baseline);
    assert(edited == Value::num(19).bits);
    assert(baseline == Value::num(12).bits);
    assert(compiled == baseline && rolledBack == baseline && nonNumeric == baseline && unsupported == baseline);
    std::puts("greenFlag: real WASM execution matches interpreter; rollback and fallbacks match");
}
