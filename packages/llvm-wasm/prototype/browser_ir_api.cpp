// Experimental standalone prototype, not connected to the product. IR inspection
// only: the syntactic subset, mayYield gate and slot allowlist are not proof that
// this IR is executable or that untrusted SB3 parsing is a security boundary.
#include "browser_ir_api.h"
#include "aot_emit.hpp"
#include "jit.hpp"
#include "llvm_compat.hpp"
#include "../engine/runtime.hpp"
#include "../load/sb3.hpp"
#include <llvm/IR/LLVMContext.h>
#include <llvm/IR/Module.h>
#include <llvm/IR/Verifier.h>
#include <llvm/MC/TargetRegistry.h>
#include <llvm/Support/TargetSelect.h>
#include <llvm/Support/raw_ostream.h>
#include <llvm/Target/TargetMachine.h>
#include <llvm/TargetParser/Triple.h>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace xyo {
bool jitEmitScript(llvm::Module&, llvm::LLVMContext&, Runtime&, Target*, Blocks*,
                   const std::string&, const std::string&, CompiledScript&,
                   JitPinned&, std::vector<std::string>&,
                   std::map<std::string, std::string>&, AotEmit*);
}
struct XyoBrowserIrResult { std::string ir, error; bool ok = false; };

extern "C" XyoBrowserIrResult* xyo_browser_ir_compile(const uint8_t* data, size_t size) {
    auto r = std::make_unique<XyoBrowserIrResult>();
    auto fail = [&](const std::string& msg) { r->error = msg; return r.release(); };
    if (!data || !size || size > 16u * 1024u * 1024u) return fail("invalid input size");
    xyo::Runtime rt;
    auto loaded = xyo::loadSb3File(rt, data, size);
    if (!loaded.ok) return fail("load failed: " + loaded.error);
    xyo::Target* target = nullptr;
    std::string top;
    uint32_t ti = 0, selected = 0;
    for (auto* t : rt.targets) {
        if (t && t->isOriginal && t->blocks) {
            for (const auto& id : t->blocks->getScripts()) {
                auto* b = t->blocks->getBlock(id);
                if (b && b->opcode == "event_whenflagclicked") {
                    if (target) return fail("more than one green flag script");
                    target = t; top = id; selected = ti;
                }
            }
        }
        ++ti;
    }
    if (!target) return fail("no green flag script");
    auto* hat = target->blocks->getBlock(top);
    // Deliberately minimal, closed subset: exactly one stack block, a set to a
    // numeric shadow. No procedures, branches, loops or arbitrary reporters.
    auto* set = target->blocks->getBlock(hat->next);
    if (!set || set->opcode != "data_setvariableto" || !set->next.empty() ||
        set->mutation || set->inputs.size() != 1 || !set->fields.count("VARIABLE"))
        return fail("expected one variable set with numeric shadow");
    auto* input = set->inputs.find("VALUE");
    if (!input) return fail("missing VALUE");
    const std::string& child = input->block.empty() ? input->shadow : input->block;
    auto* literal = target->blocks->getBlock(child);
    if (!literal || !literal->shadow || literal->opcode != "math_number" ||
        !literal->next.empty() || !literal->inputs.empty() || literal->mutation ||
        !literal->fields.count("NUM")) return fail("VALUE must be a numeric shadow");

    LLVMInitializeWebAssemblyTargetInfo();
    LLVMInitializeWebAssemblyTarget();
    LLVMInitializeWebAssemblyTargetMC();
    LLVMInitializeWebAssemblyAsmPrinter();
    llvm::Triple triple("wasm32-unknown-emscripten");
    std::string error;
    const auto* backend = llvm::TargetRegistry::lookupTarget(xyo::llvmc::tripleArg(triple), error);
    if (!backend) return fail("target lookup: " + error);
    llvm::TargetOptions options;
    std::unique_ptr<llvm::TargetMachine> tm(backend->createTargetMachine(
        xyo::llvmc::tripleArg(triple), "generic", "", options, llvm::Reloc::PIC_));
    if (!tm) return fail("cannot create wasm32 TargetMachine");
    llvm::LLVMContext context;
    llvm::Module module("xyo_browser_ir", context);
    module.setTargetTriple(xyo::llvmc::tripleArg(triple));
    module.setDataLayout(tm->createDataLayout());
    xyo::CompiledScript compiled;
    xyo::JitPinned pinned;
    xyo::AotEmit aot;
    aot.targetIndex = selected;
    std::vector<std::string> pending;
    std::map<std::string, std::string> procs;
    if (!xyo::jitEmitScript(module, context, rt, target, target->blocks, top,
                            "xyo_browser_script", compiled, pinned, pending, procs, &aot))
        return fail("jitEmitScript rejected script");
    // no-yield gate and strict slot allowlist; this still does not authorize execution.
    if (compiled.mayYield || !procs.empty()) return fail("yield/procedure rejected");
    for (const auto& slot : aot.slots) {
        if (slot.kind != xyo::AotSlotKind::VarId && slot.kind != xyo::AotSlotKind::StrLit)
            return fail("unexpected AOT slot kind");
    }
    std::string diagnostics;
    llvm::raw_string_ostream errors(diagnostics);
    if (llvm::verifyModule(module, &errors)) {
        errors.flush(); return fail("invalid LLVM module: " + diagnostics);
    }
    llvm::raw_string_ostream stream(r->ir);
    module.print(stream, nullptr);
    stream.flush();
    r->ok = true;
    return r.release();
}
extern "C" int xyo_browser_ir_ok(const XyoBrowserIrResult* r) { return r && r->ok; }
extern "C" const char* xyo_browser_ir_text(const XyoBrowserIrResult* r) { return r ? r->ir.c_str() : ""; }
extern "C" const char* xyo_browser_ir_error(const XyoBrowserIrResult* r) { return r ? r->error.c_str() : "null result"; }
extern "C" void xyo_browser_ir_destroy(XyoBrowserIrResult* r) { delete r; }
