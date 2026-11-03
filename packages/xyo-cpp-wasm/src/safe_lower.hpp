#pragma once

#include "wasm/wasm_compile.hpp"
#include "model/blocks.hpp"

namespace xyo::wasm {

// Slots are in this exact order. Resolve each pair using the interpreter's
// variable lookup rules. Reject aliases (two slots resolving to one Variable).
struct SafeBinding {
    std::string id;
    std::u16string name;
};
struct SafeScript {
    Program program;
    bool motion = false;
    double motionSteps = 0;
    std::vector<SafeBinding> bindings;
    std::string lastBlock;
    std::string nextBlock;
    std::vector<std::string> statements;
    std::vector<std::string> reporters;
};

#ifdef XYO_SAFE_WASM_LOOP_EXPERIMENT
bool lowerFirstLoopBody(Blocks& blocks, const Block* top, SafeScript& out,
                        std::string& loopId);
#endif

// Restricted to a green-flag hat and a bounded, straight-line chain. On failure
// out is unchanged. Before invocation, copy *all* variable Values to temporary
// slots and require each to be numeric. Only commit after successful execution;
// on instantiation, trap, or bail discard slots and run the interpreter.
bool lowerSafeFlag(Blocks& blocks, const Block* top, SafeScript& out);
// A nonempty supported prefix ending immediately before an unsupported opcode.
bool lowerSafePrefix(Blocks& blocks, const Block* top, SafeScript& out);
// Find a straight-line numeric chunk after interpreted blocks; control flow is
// never crossed. `start` identifies the exact entry block to wait for.
bool lowerSafeAfterFlag(Blocks& blocks, const Block* top, SafeScript& out, std::string& start);

} // namespace xyo::wasm
