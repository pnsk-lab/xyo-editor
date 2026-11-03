#pragma once
namespace xyo { class Thread; }
namespace xyo::wasm {
// Generate and instantiate a fresh per-thread module during greenFlag; do not run it.
void prepareSafeFlag(Thread& thread);
void releaseSafeFlag(Thread& thread);
// True only after successful generated-code execution and atomic commit.
bool tryRunSafeFlag(Thread& thread);
#ifdef XYO_SAFE_WASM_LOOP_EXPERIMENT
bool tryRunFirstLoopBody(Thread& thread);
#endif
}
#ifdef XYO_SAFE_WASM_LOOP_EXPERIMENT
// Separately compiled feature; disabled until explicitly opted in.
extern "C" void xyo_safe_jit_loop_experiment(int enabled);
#endif
extern "C" void xyo_safe_jit_enable(int enabled);
extern "C" unsigned xyo_safe_jit_executions();
extern "C" unsigned xyo_safe_jit_compilations();
extern "C" unsigned xyo_safe_jit_attempts();
extern "C" unsigned xyo_safe_jit_fallbacks();
extern "C" unsigned xyo_safe_jit_live_modules();
