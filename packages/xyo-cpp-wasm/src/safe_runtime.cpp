#include "safe_runtime.hpp"
#include "safe_lower.hpp"
#include "engine/thread.hpp"
#include "engine/runtime.hpp"
#include "model/target.hpp"
#include "core/jsnum.hpp"
#include "core/cast.hpp"
#include "core/v8math.hpp"
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <set>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// Each live Thread owns one handle. All exit/stop/destruction paths release it.
// Exceptions (including CSP rejection and traps) mean interpreter fallback.
EM_JS(int, xyo_safe_create, (const uint8_t* bytes, int length), {
    try {
        var memory = typeof wasmMemory !== 'undefined' ? wasmMemory : Module['wasmMemory'];
        if (!memory) return -1;
        var code = new Uint8Array(memory.buffer).slice(bytes, bytes + length);
        var instance = new WebAssembly.Instance(new WebAssembly.Module(code), {env: {memory}});
        var modules = Module['xyoSafeModules'] || (Module['xyoSafeModules'] = new Map());
        var id = (Module['xyoSafeNextId'] || 0) + 1;
        if (id > 2147483647) return -1;
        Module['xyoSafeNextId'] = id;
        modules.set(id, instance);
        return id;
    } catch (_) { return -1; }
});
EM_JS(int, xyo_safe_invoke, (int handle, uint64_t* slots), {
    try {
        var modules = Module['xyoSafeModules'];
        var instance = modules && modules.get(handle);
        return instance && instance.exports.f(slots) === 0 ? 0 : -1;
    } catch (_) { return -1; }
});
EM_JS(void, xyo_safe_release, (int handle), {
    var modules = Module['xyoSafeModules'];
    if (modules) modules.delete(handle);
});
EM_JS(unsigned, xyo_safe_live, (), {
    var modules = Module['xyoSafeModules'];
    return modules ? modules.size : 0;
});
#ifdef XYO_SAFE_JIT_TESTING
// Replace test instances with an actual trapping WASM function; production
// never exposes this hook. Invocation must discard staging and interpret.
EM_JS(void, xyo_safe_test_trap_modules, (), {
    var bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,
        3,2,1,0,7,5,1,1,102,0,0,10,5,1,3,0,0,11]);
    var trap = new WebAssembly.Instance(new WebAssembly.Module(bytes));
    var modules = Module['xyoSafeModules'];
    if (modules) for (var id of modules.keys()) modules.set(id, trap);
});
EM_JS(void, xyo_safe_test_reject, (int v), {
    if (v && !Module['xyoSafeOriginalModule']) {
        Module['xyoSafeOriginalModule'] = WebAssembly.Module;
        WebAssembly.Module = function() { throw new WebAssembly.CompileError('simulated CSP'); };
    } else if (!v && Module['xyoSafeOriginalModule']) {
        WebAssembly.Module = Module['xyoSafeOriginalModule'];
        delete Module['xyoSafeOriginalModule'];
    }
});
#endif
#endif

namespace {
bool enabled = true;
unsigned executions = 0;
unsigned compilations = 0;
unsigned attempts = 0;
unsigned fallbacks = 0;
#ifdef XYO_SAFE_JIT_TESTING
bool failAfterInvoke = false;
#endif
#ifdef XYO_SAFE_WASM_LOOP_EXPERIMENT
bool loopExperimentEnabled = false;
#endif
}
extern "C" void xyo_safe_jit_enable(int v) { enabled = v != 0; }
extern "C" unsigned xyo_safe_jit_executions() { return executions; }
extern "C" unsigned xyo_safe_jit_compilations() { return compilations; }
extern "C" unsigned xyo_safe_jit_attempts() { return attempts; }
extern "C" unsigned xyo_safe_jit_fallbacks() { return fallbacks; }
extern "C" unsigned xyo_safe_jit_live_modules() {
#ifdef __EMSCRIPTEN__
    return xyo_safe_live();
#else
    return 0;
#endif
}
#ifdef XYO_SAFE_WASM_LOOP_EXPERIMENT
extern "C" void xyo_safe_jit_loop_experiment(int v) { loopExperimentEnabled = v != 0; }
#endif
#ifdef XYO_SAFE_JIT_TESTING
extern "C" void xyo_safe_jit_fail_after_invoke(int v) { failAfterInvoke = v != 0; }
#ifdef __EMSCRIPTEN__
extern "C" void xyo_safe_jit_reject_compile(int v) { xyo_safe_test_reject(v); }
extern "C" void xyo_safe_jit_trap_modules() { xyo_safe_test_trap_modules(); }
#endif
#endif

namespace xyo {
// Defined next to the core primitives, not inferred from a mutable registry.
PrimFn safeCanonicalPrimitive(const std::string& opcode);
}

namespace xyo::wasm {
namespace {
// The emitter canonicalizes NaN on store while the interpreter may preserve
// the raw Value::num result. Reject *every* nonfinite intermediate before
// executing or committing anything, including overflow and division by zero.
bool finiteExpr(const Program& p, uint32_t i, const std::vector<double>& vars, double& out) {
    if (i >= p.exprs.size()) return false;
    const auto& e = p.exprs[i];
    double a, b;
    switch (e.k) {
    case EK::ConstNum: out = e.num; break;
    case EK::VarGet:
        if (e.var >= vars.size()) return false;
        out = vars[e.var]; break;
    case EK::Round:
        if (!finiteExpr(p, e.a, vars, a)) return false;
        out = jsnum::jsRound(a);
        break;
    case EK::Abs: case EK::Floor: case EK::Ceil: case EK::Sqrt:
        if (!finiteExpr(p, e.a, vars, a)) return false;
        if (e.k == EK::Abs) out = std::fabs(a);
        else if (e.k == EK::Floor) out = std::floor(a);
        else if (e.k == EK::Ceil) out = std::ceil(a);
        else out = std::sqrt(a);
        break;
    case EK::Add: case EK::Sub: case EK::Mul: case EK::Div:
        if (!finiteExpr(p, e.a, vars, a) || !finiteExpr(p, e.b, vars, b)) return false;
        if (e.k == EK::Add) out = a + b;
        else if (e.k == EK::Sub) out = a - b;
        else if (e.k == EK::Mul) out = a * b;
        else out = a / b;
        break;
    default: return false;
    }
    return std::isfinite(out);
}
bool finiteProgram(const Program& p, std::vector<double> vars) {
    for (double n : vars) if (!std::isfinite(n)) return false;
    for (auto id : p.main) {
        if (id >= p.stmts.size()) return false;
        const auto& s = p.stmts[id];
        if (s.var >= vars.size()) return false;
        double n;
        if (!finiteExpr(p, s.expr, vars, n)) return false;
        if (s.k == SK::SetVar) vars[s.var] = n;
        else if (s.k == SK::ChangeVar) vars[s.var] += n;
        else return false;
        if (!std::isfinite(vars[s.var])) return false;
    }
    return true;
}
} // namespace
void releaseSafeFlag(Thread& thread) {
#ifdef __EMSCRIPTEN__
    if (thread.safeWasmHandle >= 0) xyo_safe_release(thread.safeWasmHandle);
    thread.safeWasmHandle = -1;
    thread.safeWasmCode.clear();
    thread.safeWasmBindings.clear();
    thread.safeWasmPrefix = false;
    thread.safeWasmLoop = false;
    thread.safeWasmNext.clear();
    thread.safeWasmStart.clear();
    thread.safeWasmAfter = false;
    thread.safeWasmStatements.clear();
    thread.safeWasmReporters.clear();
    thread.safeWasmPending = false;
#else
    (void)thread;
#endif
}
void prepareSafeFlag(Thread& thread) {
#ifdef __EMSCRIPTEN__
    releaseSafeFlag(thread);
    if (!enabled || !thread.blockContainer || thread.stackClick || thread.updateMonitor) return;
    thread.safeWasmPending = true;
    ++attempts;
    const Block* top = thread.blockContainer->getBlock(thread.topBlock);
    SafeScript script;
    if (top) thread.safeWasmStart = top->next;
#ifdef XYO_SAFE_WASM_LOOP_EXPERIMENT
    std::string loopId;
    if (loopExperimentEnabled && lowerFirstLoopBody(*thread.blockContainer, top, script, loopId)) {
        thread.safeWasmLoop = true;
        thread.safeWasmStart = loopId;
    } else
#endif
    if (!lowerSafeFlag(*thread.blockContainer, top, script)) {
        if (lowerSafePrefix(*thread.blockContainer, top, script)) {
            thread.safeWasmPrefix = true;
        } else {
            std::string start;
            if (!lowerSafeAfterFlag(*thread.blockContainer, top, script, start)) return;
            thread.safeWasmAfter = true;
            thread.safeWasmStart = start;
            thread.safeWasmPrefix = !script.nextBlock.empty();
        }
    }
    thread.safeWasmNext = script.nextBlock;
    thread.safeWasmStatements = script.statements;
    thread.safeWasmReporters = script.reporters;
    auto code = compileProgram(script.program);
    if (code.empty() || code.size() > size_t(std::numeric_limits<int>::max())) return;
    int handle = xyo_safe_create(code.data(), int(code.size()));
    if (handle < 0) return;
    for (const auto& binding : script.bindings)
        thread.safeWasmBindings.emplace_back(binding.id, binding.name);
    thread.safeWasmHandle = handle;
    thread.safeWasmCode = std::move(code);
    ++compilations;
#else
    (void)thread;
#endif
}
static bool runSafeFlag(Thread& thread) {
#ifndef __EMSCRIPTEN__
    (void)thread;
    return false;
#else
    if (!enabled || thread.isCompiled || thread.stackClick || thread.updateMonitor ||
        thread.status != STATUS_RUNNING || !thread.target || !thread.blockContainer ||
        thread.blockContainer != thread.target->blocks || thread.stack.size() != 1 ||
        !thread.peekStackFrame() || thread.peekStackFrame()->hasReported ||
        thread.peekStackFrame()->waitingReporter) return false;
    const Block* top = thread.blockContainer->getBlock(thread.topBlock);
    // Runtime::startHats executes the hat immediately and advances the stack
    // to its first body block before Sequencer::stepThread is called.
    if (!top || thread.safeWasmStart.empty() || thread.stack[0] != thread.safeWasmStart) return false;
    if (thread.safeWasmCode.empty()) return false;
    // Revalidate current graph immediately before execution: editor mutations
    // between greenFlag and this step must not execute stale code or bindings.
    SafeScript script;
    std::string start;
    const bool lowered = thread.safeWasmAfter
        ? lowerSafeAfterFlag(*thread.blockContainer, top, script, start)
        : (thread.safeWasmPrefix ? lowerSafePrefix(*thread.blockContainer, top, script)
                                 : lowerSafeFlag(*thread.blockContainer, top, script));
    if (!lowered || (thread.safeWasmAfter && start != thread.safeWasmStart) ||
        compileProgram(script.program) != thread.safeWasmCode ||
        script.nextBlock != thread.safeWasmNext ||
        script.statements != thread.safeWasmStatements ||
        script.reporters != thread.safeWasmReporters ||
        script.bindings.size() != thread.safeWasmBindings.size()) return false;
    for (size_t i = 0; i < script.bindings.size(); ++i)
        if (script.bindings[i].id != thread.safeWasmBindings[i].first ||
            script.bindings[i].name != thread.safeWasmBindings[i].second) return false;

    {
        // Cached execute/input snapshots can differ from live edited blocks.
        // Shared nodes also carry mutable reporter-parent links. Reject both.
        auto& blocks = *thread.blockContainer;
        auto& cache = blocks.cache();
        std::set<std::string> statements(script.statements.begin(), script.statements.end());
        std::set<std::string> reporters(script.reporters.begin(), script.reporters.end());
        if (statements.size() != script.statements.size() ||
            reporters.size() != script.reporters.size()) return false;
        for (const auto& id : statements) if (reporters.count(id)) return false;
        auto trusted = [&](const std::string& id) {
            const Block* b = blocks.getBlock(id);
            if (!b || !blocks.runtime) return false;
            const auto flow = blocks.runtime->getFlowing(b->opcode);
            // Numeric shadows intentionally have no primitive. A registration
            // for one changes interpreter semantics just as for real operators.
            const bool shadow = b->opcode == "math_number" || b->opcode == "math_integer" ||
                b->opcode == "math_whole_number" || b->opcode == "math_positive_number" ||
                b->opcode == "math_angle";
            PrimFn expected = safeCanonicalPrimitive(b->opcode);
            if ((!shadow && !expected) || (shadow && expected) ||
                blocks.runtime->getOpcodeFunction(b->opcode) != expected ||
                blocks.runtime->getIsHat(b->opcode) || flow.conditional || flow.loop)
                return false;
            return !cache.executeCached.count(id) && !cache.inputs.count(id);
        };
        for (const auto& id : script.statements) if (!trusted(id)) return false;
        for (const auto& id : script.reporters) if (!trusted(id)) return false;
        // Bound the whole-container alias scan independently of the lowered
        // graph limit. Large projects fall back rather than monopolize a tick.
        constexpr size_t kMaxScanBlocks = 4096;
        constexpr size_t kMaxScanInputs = 16384;
        if (blocks.size() > kMaxScanBlocks) return false;
        size_t inputsScanned = 0;
        std::map<std::string, unsigned> references;
        for (const auto& entry : blocks.allBlocks()) {
            for (const auto& input : entry.second.inputs.items) {
                if (++inputsScanned > kMaxScanInputs) return false;
                if (!input.second.block.empty()) ++references[input.second.block];
                if (!input.second.shadow.empty() && input.second.shadow != input.second.block)
                    ++references[input.second.shadow];
            }
        }
        for (const auto& id : statements) if (references[id] != 0) return false;
        for (const auto& id : reporters) if (references[id] != 1) return false;
        // Match execute()'s lazy cache creation, including reporter links.
        for (const auto& id : script.statements)
            if (!blocks.getCachedExecute(id)) return false;
    }

    // Mirror lookupOrCreateVariable's lookup order without its creation side
    // effect. Missing variables must be left to the interpreter.
    std::vector<Variable*> vars;
    std::vector<uint64_t> staged;
    std::vector<double> numbers;
    std::set<Variable*> unique;
    for (const auto& binding : script.bindings) {
        Variable* v = thread.target->lookupVariableById(binding.id);
        if (!v) v = thread.target->lookupVariableByNameAndType(binding.name, Variable::kScalarType);
        if (!v || !unique.insert(v).second) return false;
        Value value = v->value;
        if (!value.isNumber()) {
            // Only the destination of the first change may be coerced: change
            // converts it before writing, and all its accepted reporters are
            // pure numeric expressions. Other raw-value reads must stay exact.
            const size_t slot = staged.size();
            if (!thread.safeWasmAfter || script.program.main.empty()) return false;
            const auto& first = script.program.stmts[script.program.main[0]];
            if (first.k != SK::ChangeVar || first.var != slot) return false;
            value = Value::num(cast::toNumber(value));
        }
        vars.push_back(v);
        staged.push_back(value.bits);
        numbers.push_back(value.asNumberUnchecked());
    }
    if (script.motion) {
        auto* t = thread.target;
        if (!script.bindings.empty() || !t->runtime || t->runtime->renderer ||
            t->onTargetMoved || t->isStage || t->dragging ||
            !std::isfinite(t->x) || !std::isfinite(t->y) ||
            !std::isfinite(t->direction)) return false;
        const double radians = (M_PI * (90.0 - t->direction)) / 180.0;
        if (!std::isfinite(radians)) return false;
        numbers = {t->x, t->y, v8math::cos(radians), v8math::sin(radians)};
        for (double n : numbers) staged.push_back(Value::num(n).bits);
    }
    if (!finiteProgram(script.program, numbers)) return false;
    if (xyo_safe_invoke(thread.safeWasmHandle, staged.data()) != 0) return false;
#ifdef XYO_SAFE_JIT_TESTING
    if (failAfterInvoke) return false;
#endif
    for (size_t i = 0; i < vars.size(); ++i) vars[i]->value.bits = staged[i];
    if (script.motion) {
        Value x, y;
        x.bits = staged[0]; y.bits = staged[1];
        thread.target->setXY(x.asNumberUnchecked(), y.asNumberUnchecked());
    }
    // Match stepThreadBound's ordinary completion, not retireThread: normal
    // completion preserves the glow request and identifies the last executed
    // stack block. Reuse/reset and pop the frame just as goToNextBlock does.
    if (!thread.blockContainer->forceNoGlow) thread.requestScriptGlowInFrame = true;
    thread.blockGlowInFrame = script.lastBlock;
    thread.justReported = Value::undefined();
    thread.trashFrames.clear();
    thread.reuseStackForNextBlock(script.lastBlock);
    thread.goToNextBlock();
    if (!thread.safeWasmPrefix) {
        thread.popStack();
        thread.status = STATUS_DONE;
    }
    ++executions;
    return true;
#endif
}
#ifdef XYO_SAFE_WASM_LOOP_EXPERIMENT
bool tryRunFirstLoopBody(Thread& thread) {
#ifndef __EMSCRIPTEN__
    (void)thread;
    return false;
#else
    if (!enabled || !loopExperimentEnabled || !thread.safeWasmPending || !thread.safeWasmLoop ||
        thread.safeWasmHandle < 0 || thread.isCompiled || thread.stackClick ||
        thread.updateMonitor || thread.status != STATUS_RUNNING || !thread.target ||
        !thread.blockContainer || thread.blockContainer != thread.target->blocks ||
        thread.stack.size() != 2 || thread.stackFrames.size() != 2 ||
        thread.stack[0] != thread.safeWasmStart) return false;
    auto* parent = thread.peekParentStackFrame();
    auto* frame = thread.peekStackFrame();
    if (!parent || !frame || !parent->isLoop || parent->warpMode || frame->warpMode ||
        frame->hasReported || frame->waitingReporter || frame->isLoop ||
        frame->executionContext || frame->hasParams) return false;
    auto& blocks = *thread.blockContainer;
    const Block* top = blocks.getBlock(thread.topBlock);
    SafeScript script;
    std::string loopId;
    if (!lowerFirstLoopBody(blocks, top, script, loopId) || loopId != thread.safeWasmStart ||
        thread.peekStack() != script.lastBlock ||
        script.statements != thread.safeWasmStatements ||
        script.reporters != thread.safeWasmReporters ||
        script.bindings.size() != 1 || thread.safeWasmBindings.size() != 1 ||
        script.bindings[0].id != thread.safeWasmBindings[0].first ||
        script.bindings[0].name != thread.safeWasmBindings[0].second ||
        compileProgram(script.program) != thread.safeWasmCode || !blocks.runtime) return false;
    auto& cache = blocks.cache();
    for (const auto& id : {script.statements[0], script.reporters[0]}) {
        const Block* b = blocks.getBlock(id);
        if (!b || cache.executeCached.count(id) || cache.inputs.count(id)) return false;
        const auto flow = blocks.runtime->getFlowing(b->opcode);
        const PrimFn expected = safeCanonicalPrimitive(b->opcode);
        if ((id == script.statements[0] && !expected) ||
            (id == script.reporters[0] && expected) ||
            blocks.runtime->getOpcodeFunction(b->opcode) != expected ||
            blocks.runtime->getIsHat(b->opcode) || flow.conditional || flow.loop) return false;
    }
    if (blocks.size() > 4096) return false;
    size_t scanned = 0, bodyRefs = 0, literalRefs = 0;
    for (const auto& entry : blocks.allBlocks()) for (const auto& input : entry.second.inputs.items) {
        if (++scanned > 16384) return false;
        for (const auto& id : {input.second.block, input.second.shadow == input.second.block
                    ? std::string{} : input.second.shadow}) {
            if (id == script.statements[0]) ++bodyRefs;
            if (id == script.reporters[0]) ++literalRefs;
        }
    }
    if (bodyRefs != 1 || literalRefs != 1) return false;
    const auto& binding = script.bindings[0];
    Variable* var = thread.target->lookupVariableById(binding.id);
    if (!var) var = thread.target->lookupVariableByNameAndType(binding.name, Variable::kScalarType);
    if (!var || !var->value.isNumber()) return false;
    const double number = var->value.asNumberUnchecked();
    if (!finiteProgram(script.program, {number})) return false;
    uint64_t staged = var->value.bits;
    if (xyo_safe_invoke(thread.safeWasmHandle, &staged) != 0) return false;
#ifdef XYO_SAFE_JIT_TESTING
    if (failAfterInvoke) return false;
#endif
    // The exact two-node graph and primitive identities have been checked;
    // materialize the same lazy cache as execute before committing the slot.
    BlockCached* cached = blocks.getCachedExecute(script.lastBlock);
    if (!cached) return false;
    var->value.bits = staged;
    frame->op = cached;
    if (!blocks.forceNoGlow) thread.requestScriptGlowInFrame = true;
    thread.justReported = Value::undefined();
    thread.trashFrames.clear();
    ++executions;
    return true;
#endif
}
#endif

bool tryRunSafeFlag(Thread& thread) {
#ifdef __EMSCRIPTEN__
    if (!thread.safeWasmPending || thread.safeWasmLoop) return false;
    if (thread.safeWasmAfter && (thread.stack.size() != 1 ||
        thread.peekStack() != thread.safeWasmStart)) return false;
    const bool ok = runSafeFlag(thread);
    if (!ok) ++fallbacks;
    releaseSafeFlag(thread);
    return ok;
#else
    (void)thread;
    return false;
#endif
}
} // namespace xyo::wasm
