#include "browser.h"
#include "engine/runtime.hpp"
#include "load/sb3.hpp"
#include "core/cast.hpp"
#include "core/json.hpp"
#include "core/sstr.hpp"
#include "model/target.hpp"
#include "renderer_bridge.hpp"
#include "browser_async_sound.hpp"
#ifdef XYO_EXPERIMENTAL_PEN_SINK
#include "pen_sink.hpp"
#endif
#ifdef XYO_SAFE_WASM_RUNTIME
#include "safe_runtime.hpp"
#endif
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <unordered_map>

namespace {
#ifdef __wasm32__
static_assert(sizeof(xyo::wasm::RendererCallbacks) == 22 * sizeof(uint32_t), "renderer table ABI changed");
#endif
struct Instance {
    // Runtime is destroyed first: its non-owning renderer pointer stays valid.
    std::unique_ptr<xyo::wasm::RendererBridge> renderer;
#ifdef XYO_EXPERIMENTAL_PEN_SINK
    // Declared before Runtime so its non-owning sink pointer stays valid.
    std::unique_ptr<xyo::web::BrowserPenSink> pen;
#endif
    std::unique_ptr<xyo::Runtime> runtime = std::make_unique<xyo::Runtime>();
    std::unique_ptr<xyo::web::BrowserAsyncSound> audio;
    ~Instance() { audio.reset(); }
    bool loaded = false;
    bool compiled = false;
    std::string error, snapshot;
};
std::unordered_map<uint32_t, std::unique_ptr<Instance>> instances;
bool browserActive = false;
struct BrowserCallGuard {
    bool entered;
    BrowserCallGuard() : entered(!browserActive) { if (entered) browserActive = true; }
    ~BrowserCallGuard() { if (entered) browserActive = false; }
};
uint32_t nextHandle = 1;
uint32_t nextAudioGeneration = 1;
Instance* get(uint32_t h) {
    auto it = instances.find(h);
    return it == instances.end() ? nullptr : it->second.get();
}
int penHealthy(Instance* i) {
#ifdef XYO_EXPERIMENTAL_PEN_SINK
    if (i->pen) {
        using Failure = xyo::web::PenEventQueue::Failure;
        switch (i->pen->queue.failure()) {
        case Failure::overflow: i->error = "Pen event queue overflow"; return 0;
        case Failure::invalid: i->error = "Invalid pen event"; return 0;
        case Failure::unsupported: i->error = "Pen stamp is unsupported"; return 0;
        case Failure::none: break;
        }
    }
#else
    (void)i;
#endif
    return 1;
}
int ready(Instance* i) {
    if (!i) return 0;
    i->snapshot.clear();
    i->error.clear();
    if (!i->loaded) { i->error = "No project loaded"; return 0; }
    return penHealthy(i);
}
xyo::JsonValue number(double v) { return std::isfinite(v) ? xyo::JsonValue(v) : xyo::JsonValue(nullptr); }
xyo::JsonValue value(xyo::Value v) {
    if (v.isNumber() && std::isfinite(v.asNumberUnchecked())) return xyo::JsonValue(v.asNumberUnchecked());
    if (v.isBool()) return xyo::JsonValue(v.asBool());
    auto* s = xyo::cast::toString(v);
    return xyo::JsonValue(s ? xyo::SStr::toUtf8(s->view()) : std::string());
}
}
extern "C" {
uint32_t xyo_browser_create() { BrowserCallGuard call; if (!call.entered) return 0;
    if (nextHandle == 0) return 0; // never reuse stale handles
    uint32_t h = nextHandle++;
    instances.emplace(h, std::make_unique<Instance>());
    return h;
}
int xyo_browser_destroy(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* i = get(h); if (!i || i->audio) return 0; return instances.erase(h) ? 1 : 0; }
int xyo_browser_load_sb3(uint32_t h, const uint8_t* bytes, size_t size) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i) return 0;
    i->snapshot.clear(); i->error.clear();
    if (i->audio) { i->error = "Close audio before loading"; return 0; }
#ifdef XYO_EXPERIMENTAL_PEN_SINK
    if (!penHealthy(i)) return 0;
    if (i->pen && i->pen->queue.size()) { i->error = "Drain pen events before loading"; return 0; }
#endif
    if (!bytes || !size) { i->error = "Empty SB3 input"; return 0; }
    auto candidate = std::make_unique<xyo::Runtime>();
    auto result = xyo::loadSb3File(*candidate, bytes, size);
    if (!result.ok) { i->error = result.error; return 0; }
    candidate->renderer = i->renderer.get();
#ifdef XYO_EXPERIMENTAL_PEN_SINK
    candidate->penSink = i->pen.get();
#endif
    // Loading replaces Runtime but must not make old question IDs valid again.
    candidate->nextQuestionId = i->runtime->nextQuestionId;
    i->runtime = std::move(candidate); i->loaded = true;
    return 1;
}
int xyo_browser_green_flag(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* i = get(h); if (!ready(i) || i->audio) return 0;
#ifdef XYO_SAFE_WASM_RUNTIME
    xyo_safe_jit_enable(i->compiled);
#endif
    i->runtime->greenFlag(); return penHealthy(i); }
int xyo_browser_stop(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* i = get(h); if (!ready(i)) return 0; i->runtime->stopAll(); return 1; }
int xyo_browser_step(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* i = get(h); if (!ready(i)) return 0;
#ifdef XYO_SAFE_WASM_RUNTIME
    xyo_safe_jit_enable(i->compiled);
#endif
    if (i->audio && !i->audio->tick()) return 0;
    i->runtime->step();
    const bool soundOk = !i->audio || i->audio->afterStep();
    return soundOk && penHealthy(i) ? 1 : 0; }
int xyo_browser_set_compiled(uint32_t h, int enabled) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i) return 0;
    i->snapshot.clear(); i->error.clear();
    if (enabled != 0 && enabled != 1) { i->error = "Invalid compiled mode"; return 0; }
#ifndef XYO_SAFE_WASM_RUNTIME
    if (enabled) { i->error = "Compiled mode unavailable"; return 0; }
#endif
    i->compiled = enabled != 0; return 1;
}
int xyo_browser_compiled_enabled(uint32_t h) { BrowserCallGuard call; if (!call.entered) return -1; auto* i = get(h); return i ? int(i->compiled) : -1; }
int xyo_browser_audio_open(uint32_t h, uint32_t timeoutTicks) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!ready(i) || i->audio || !timeoutTicks || !nextAudioGeneration) return 0;
    i->audio = std::make_unique<xyo::web::BrowserAsyncSound>(*i->runtime, nextAudioGeneration++, timeoutTicks);
    return 1;
}
uint32_t xyo_browser_audio_session_generation(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); return i && i->audio ? i->audio->generation() : 0;
}
int xyo_browser_audio_close(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i || !i->audio) return 0;
    i->audio->close(); i->runtime->stopAll(); return 1;
}
int xyo_browser_audio_detach(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i || !i->audio || !i->audio->mayDestroy()) return 0;
    i->audio.reset(); return 1;
}
int xyo_browser_audio_tick(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i || !i->audio) return 0;
    return i->audio->tick() ? 1 : 0;
}
int xyo_browser_audio_failed(uint32_t h) { BrowserCallGuard call; if (!call.entered) return -1;
    auto* i = get(h); return i && i->audio ? int(i->audio->failed()) : -1;
}
static const xyo::web::BrowserAsyncSound::Command* audioCommand(uint32_t h) {
    auto* i = get(h); return i && i->audio ? i->audio->front() : nullptr;
}
uint32_t xyo_browser_audio_kind(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* c = audioCommand(h); return c ? c->kind : 0; }
uint32_t xyo_browser_audio_generation(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* c = audioCommand(h); return c ? c->generation : 0; }
uint32_t xyo_browser_audio_id_lo(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* c = audioCommand(h); return c ? uint32_t(c->id) : 0; }
uint32_t xyo_browser_audio_id_hi(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* c = audioCommand(h); return c ? uint32_t(c->id >> 32) : 0; }
const uint8_t* xyo_browser_audio_bytes(uint32_t h) { BrowserCallGuard call; if (!call.entered) return nullptr; auto* c = audioCommand(h); return c && !c->bytes.empty() ? c->bytes.data() : nullptr; }
size_t xyo_browser_audio_bytes_size(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* c = audioCommand(h); return c ? c->bytes.size() : 0; }
const char* xyo_browser_audio_format(uint32_t h) { BrowserCallGuard call; if (!call.entered) return nullptr; auto* c = audioCommand(h); return c ? c->format.c_str() : nullptr; }
const char* xyo_browser_audio_target(uint32_t h) { BrowserCallGuard call; if (!call.entered) return nullptr; auto* c = audioCommand(h); return c ? c->target.c_str() : nullptr; }
double xyo_browser_audio_volume(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* c = audioCommand(h); return c ? c->volume : 0; }
double xyo_browser_audio_pitch(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* c = audioCommand(h); return c ? c->pitch : 0; }
double xyo_browser_audio_pan(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* c = audioCommand(h); return c ? c->pan : 0; }
int xyo_browser_audio_pop(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0; auto* i = get(h); if (!i || !i->audio || !i->audio->front()) return 0; i->audio->pop(); return 1; }
int xyo_browser_audio_complete(uint32_t h, uint32_t g, uint32_t lo, uint32_t hi) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i || !i->audio) return 0; i->audio->complete(g, (uint64_t(hi) << 32) | lo); return 1;
}
int xyo_browser_audio_stop_ack(uint32_t h, uint32_t g, uint32_t lo, uint32_t hi, int ok) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i || !i->audio || (ok != 0 && ok != 1)) return 0;
    i->audio->stopAck(g, (uint64_t(hi) << 32) | lo, ok != 0); return 1;
}
int xyo_browser_audio_close_ack(uint32_t h, uint32_t g, int ok) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i || !i->audio || (ok != 0 && ok != 1)) return 0;
    return i->audio->closeAck(g, ok != 0) ? 1 : 0;
}
#ifdef XYO_EXPERIMENTAL_PEN_SINK
int xyo_browser_pen_enable(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i) return 0;
    i->error.clear();
    if (i->loaded || i->pen || i->renderer) { i->error = "Pen sink requires a fresh headless runtime"; return 0; }
    i->pen = std::make_unique<xyo::web::BrowserPenSink>();
    i->runtime->penSink = i->pen.get();
    return 1;
}
int xyo_browser_pen_count(uint32_t h) { BrowserCallGuard call; if (!call.entered) return -1;
    auto* i = get(h); if (!i || !i->pen || !penHealthy(i)) return -1;
    return static_cast<int>(i->pen->queue.size());
}
int xyo_browser_pen_kind(uint32_t h, uint32_t index) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i || !i->pen) return 0;
    const auto* event = i->pen->queue.at(index);
    return event ? static_cast<int>(event->kind) : 0;
}
double xyo_browser_pen_value(uint32_t h, uint32_t index, uint32_t field) { BrowserCallGuard call; if (!call.entered) return std::numeric_limits<double>::quiet_NaN();
    auto* i = get(h); if (!i || !i->pen) return std::numeric_limits<double>::quiet_NaN();
    const auto* event = i->pen->queue.at(index);
    if (!event) return std::numeric_limits<double>::quiet_NaN();
    if (field < 4) return event->rgba[field];
    switch (field) {
    case 4: return event->diameter;
    case 5: return event->x0;
    case 6: return event->y0;
    case 7: return event->x1;
    case 8: return event->y1;
    default: return std::numeric_limits<double>::quiet_NaN();
    }
}
int xyo_browser_pen_consume(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i || !i->pen || !penHealthy(i)) return 0;
    i->pen->queue.consume(); return 1;
}
#endif
int xyo_browser_renderer_attach(uint32_t h, const void* table, size_t size) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i) return 0;
    i->snapshot.clear(); i->error.clear();
#ifdef XYO_EXPERIMENTAL_PEN_SINK
    if (i->pen) { i->error = "Pen sink and renderer are mutually exclusive"; return 0; }
#endif
    if (!table || size != sizeof(xyo::wasm::RendererCallbacks) ||
        reinterpret_cast<uintptr_t>(table) % alignof(xyo::wasm::RendererCallbacks)) {
        i->error = "Invalid renderer callback table"; return 0;
    }
    xyo::wasm::RendererCallbacks callbacks;
    std::memcpy(&callbacks, table, sizeof(callbacks));
    auto bridge = xyo::wasm::RendererBridge::create(callbacks);
    if (!bridge) { i->error = "Incomplete renderer callback table"; return 0; }
    i->runtime->renderer = bridge.get();
    i->runtime->penSkinId = -1;
    i->renderer = std::move(bridge);
    return 1;
}
int xyo_browser_renderer_detach(uint32_t h) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!i) return 0;
    i->snapshot.clear(); i->error.clear();
    i->runtime->renderer = nullptr;
    i->runtime->penSkinId = -1;
    i->renderer.reset(); return 1;
}
int xyo_browser_key(uint32_t h, const uint8_t* key, size_t size, int down, int code) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!ready(i)) return 0;
    if (!key || !size || size > 1024 || (down != 0 && down != 1) || code < -1) {
        i->error = "Invalid keyboard input"; return 0;
    }
    i->runtime->ioDevices.keyboard.postData(xyo::utf8ToU16(std::string_view(reinterpret_cast<const char*>(key), size)), down != 0, code);
    return 1;
}
int xyo_browser_mouse(uint32_t h, double x, double y, double width, double height, int down, int button, int dragged) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!ready(i)) return 0;
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height) ||
        width <= 0 || height <= 0 || (down != 0 && down != 1) || button < 0 || button > 4 || (dragged != 0 && dragged != 1)) {
        i->error = "Invalid mouse input"; return 0;
    }
    xyo::Mouse::PostData data;
    data.x = x; data.y = y; data.canvasWidth = width; data.canvasHeight = height;
    data.hasXY = true; data.hasIsDown = true; data.isDown = down != 0; data.button = button; data.wasDragged = dragged != 0;
    i->runtime->ioDevices.mouse.postData(data);
    return 1;
}
int xyo_browser_wheel(uint32_t h, double dx, double dy) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!ready(i)) return 0;
    if (!std::isfinite(dx) || !std::isfinite(dy) || !std::isfinite(i->runtime->ioDevices.mouseWheel.getScrollX() - dx) ||
        !std::isfinite(i->runtime->ioDevices.mouseWheel.getScrollY() - dy)) { i->error = "Invalid wheel input"; return 0; }
    i->runtime->ioDevices.mouseWheel.postData(dx, dy); return 1;
}
int xyo_browser_answer(uint32_t h, const uint8_t* answer, size_t size) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!ready(i)) return 0;
    if ((!answer && size) || size > 1048576) { i->error = "Invalid answer input"; return 0; }
    const char* text = answer ? reinterpret_cast<const char*>(answer) : "";
    i->runtime->emitAnswer(xyo::utf8ToU16(std::string_view(text, size))); return 1;
}
int xyo_browser_answer_if_question(uint32_t h, const uint8_t* id, size_t idSize, const uint8_t* answer, size_t size) { BrowserCallGuard call; if (!call.entered) return 0;
    auto* i = get(h); if (!ready(i)) return 0;
    if (!id || !idSize || idSize > 20 || (!answer && size) || size > 1048576) {
        i->error = "Invalid answer input"; return 0;
    }
    // Compare canonical decimal strings: no wasm32 i64 calling convention or
    // JSON/JS integer precision loss, and no overflow while parsing.
    const auto& questions = i->runtime->questionList;
    if (questions.empty() || std::to_string(questions.front().id) !=
            std::string_view(reinterpret_cast<const char*>(id), idSize)) return -1;
    const char* text = answer ? reinterpret_cast<const char*>(answer) : "";
    i->runtime->emitAnswer(xyo::utf8ToU16(std::string_view(text, size))); return 1;
}
const char* xyo_browser_error(uint32_t h) { BrowserCallGuard call; if (!call.entered) return nullptr; auto* i = get(h); return i ? i->error.c_str() : nullptr; }
#ifdef XYO_SAFE_WASM_RUNTIME
uint32_t xyo_browser_capabilities() { BrowserCallGuard call; if (!call.entered) return 0; return 3; }
uint32_t xyo_browser_compile_attempts() { BrowserCallGuard call; if (!call.entered) return 0; return xyo_safe_jit_attempts(); }
uint32_t xyo_browser_compile_successes() { BrowserCallGuard call; if (!call.entered) return 0; return xyo_safe_jit_compilations(); }
uint32_t xyo_browser_compiled_executions() { BrowserCallGuard call; if (!call.entered) return 0; return xyo_safe_jit_executions(); }
uint32_t xyo_browser_compile_fallbacks() { BrowserCallGuard call; if (!call.entered) return 0; return xyo_safe_jit_fallbacks(); }
uint32_t xyo_browser_compiled_live_modules() { BrowserCallGuard call; if (!call.entered) return 0; return xyo_safe_jit_live_modules(); }
#else
uint32_t xyo_browser_capabilities() { BrowserCallGuard call; if (!call.entered) return 0; return 1; }
uint32_t xyo_browser_compile_attempts() { BrowserCallGuard call; if (!call.entered) return 0; return 0; }
uint32_t xyo_browser_compile_successes() { BrowserCallGuard call; if (!call.entered) return 0; return 0; }
uint32_t xyo_browser_compiled_executions() { BrowserCallGuard call; if (!call.entered) return 0; return 0; }
uint32_t xyo_browser_compile_fallbacks() { BrowserCallGuard call; if (!call.entered) return 0; return 0; }
uint32_t xyo_browser_compiled_live_modules() { BrowserCallGuard call; if (!call.entered) return 0; return 0; }
#endif
static const char* buildSnapshot(Instance* i) {
    if (!ready(i)) return nullptr;
    auto& rt = *i->runtime;
    xyo::JsonArray targets;
    for (auto* t : rt.targets) {
        xyo::JsonObject variables;
        for (auto& [id, v] : t->variables) {
            xyo::JsonObject var;
            var["name"] = xyo::JsonValue(xyo::SStr::toUtf8(v.name));
            var["type"] = xyo::JsonValue(v.type);
            if (v.type == xyo::Variable::kListType) {
                xyo::JsonArray list;
                if (v.list) for (uint32_t n = 0; n < v.list->len; ++n) list.push_back(value(v.list->items[n]));
                var["value"] = xyo::JsonValue(std::move(list));
            } else var["value"] = value(v.value);
            variables[id] = xyo::JsonValue(std::move(var));
        }
        xyo::JsonObject obj;
        obj["id"] = xyo::JsonValue(t->id); obj["name"] = xyo::JsonValue(xyo::SStr::toUtf8(t->getName()));
        obj["isStage"] = xyo::JsonValue(t->isStage); obj["isOriginal"] = xyo::JsonValue(t->isOriginal);
        obj["x"] = number(t->x); obj["y"] = number(t->y); obj["direction"] = number(t->direction);
        obj["size"] = number(t->size); obj["volume"] = number(t->volume); obj["visible"] = xyo::JsonValue(t->visible);
        obj["currentCostume"] = xyo::JsonValue(t->currentCostume); obj["layerOrder"] = xyo::JsonValue(t->layerOrder);
        obj["bubbleText"] = xyo::JsonValue(xyo::SStr::toUtf8(t->bubbleText)); obj["bubbleType"] = xyo::JsonValue(t->bubbleType);
        obj["variables"] = xyo::JsonValue(std::move(variables));
        targets.emplace_back(std::move(obj));
    }
    xyo::JsonObject root;
    root["targets"] = xyo::JsonValue(std::move(targets));
    xyo::JsonObject io;
    io["lastKey"] = xyo::JsonValue(xyo::SStr::toUtf8(rt.ioDevices.keyboard.getLastKeyPressed()));
    io["mouseX"] = number(rt.ioDevices.mouse.getScratchX()); io["mouseY"] = number(rt.ioDevices.mouse.getScratchY());
    io["mouseDown"] = xyo::JsonValue(rt.ioDevices.mouse.getIsDown());
    io["scrollX"] = number(rt.ioDevices.mouseWheel.getScrollX()); io["scrollY"] = number(rt.ioDevices.mouseWheel.getScrollY());
    io["answer"] = xyo::JsonValue(xyo::SStr::toUtf8(rt.answer));
    io["question"] = rt.questionList.empty() ? xyo::JsonValue(nullptr) : xyo::JsonValue(xyo::SStr::toUtf8(rt.questionList.front().question));
    io["questionId"] = rt.questionList.empty() ? xyo::JsonValue(nullptr) : xyo::JsonValue(std::to_string(rt.questionList.front().id));
    root["io"] = xyo::JsonValue(std::move(io));
    root["threadCount"] = xyo::JsonValue(double(rt.threads.size()));
    root["stepSerial"] = xyo::JsonValue(double(rt.stepSerial));
    i->snapshot = xyo::jsonStringify(xyo::JsonValue(std::move(root)));
    return i->snapshot.c_str();
}
const char* xyo_browser_snapshot(uint32_t h) { BrowserCallGuard call; if (!call.entered) return nullptr;
    auto* i = get(h); return buildSnapshot(i);
}
}

#ifdef XYO_LLVM_HOST
// Internal bridge for the unified LLVM host (llvm_host_abi.cpp in the same
// module). These are not part of the public browser ABI: they expose the live
// Runtime and share this file's reentrancy guard so an LLVM entry point can
// participate in the exact same browserActive discipline without nesting.
extern "C" int xyo_browser_internal_enter(void) {
    if (browserActive) return 0;
    browserActive = true;
    return 1;
}
extern "C" void xyo_browser_internal_leave(void) { browserActive = false; }
extern "C" xyo::Runtime* xyo_browser_internal_runtime(uint32_t h) {
    auto* i = get(h);
    return i && i->loaded ? i->runtime.get() : nullptr;
}
extern "C" void xyo_browser_internal_error(uint32_t h, const char* message) {
    auto* i = get(h);
    if (i) i->error = message ? message : "";
}
// Renderer bridge support: the host needs stable native Target identities to map
// drawables, and cannot dereference Target* itself.
// Renderer callbacks run inside another ABI call, so this variant must not take
// the reentrancy guard: it is only reachable from our own callback table.
extern "C" const char* xyo_browser_internal_snapshot(uint32_t h) {
    auto* i = get(h);
    return i ? buildSnapshot(i) : nullptr;
}
extern "C" uint32_t xyo_browser_target_count(uint32_t h) {
    auto* i = get(h);
    return i && i->loaded ? uint32_t(i->runtime->targets.size()) : 0;
}
// The runtime stores the renderer's drawable id on Target (it starts at -1) and
// passes it to collision callbacks, but only the SDL renderer ever sets it. A
// host renderer must write it back or every query sees -1.
// Segment compilation: the host registers compiled functions for straight-line
// runs of blocks. The interpreter calls one when a thread reaches the run head
// and then skips the blocks the function consumed. Registration is additive and
// cleared on every load, so a stale entry can never target a new project.
extern "C" int xyo_browser_register_segment(uint32_t h, const char* blockId, void* entry, uint32_t blocks) {
    auto* i = get(h);
    if (!i || !i->loaded || !blockId || !*blockId || !entry || blocks == 0) return 0;
    auto& segments = i->runtime->segments;
    if (segments.count(blockId)) return 0;
    segments[blockId] = xyo::Runtime::CompiledSegment{entry, blocks, 0};
    return 1;
}
extern "C" void xyo_browser_clear_segments(uint32_t h) {
    auto* i = get(h);
    if (i && i->runtime) i->runtime->segments.clear();
}
extern "C" uint64_t xyo_browser_segment_hits(uint32_t h) {
    auto* i = get(h);
    if (!i || !i->runtime) return 0;
    uint64_t total = 0;
    for (const auto& entry : i->runtime->segments) total += entry.second.hits;
    return total;
}
extern "C" int xyo_browser_set_target_drawable(uint32_t h, void* target, int drawable) {
    auto* i = get(h);
    if (!i || !i->loaded || !target || drawable < 0) return 0;
    for (auto* t : i->runtime->targets) {
        if (t != target) continue;
        t->drawableID = drawable;
        return 1;
    }
    return 0;
}
extern "C" void* xyo_browser_target_at(uint32_t h, uint32_t index) {
    auto* i = get(h);
    if (!i || !i->loaded || index >= i->runtime->targets.size()) return nullptr;
    return i->runtime->targets[index];
}
extern "C" void xyo_browser_internal_clear(uint32_t h) {
    auto* i = get(h);
    if (i) { i->error.clear(); i->snapshot.clear(); }
}
#endif
