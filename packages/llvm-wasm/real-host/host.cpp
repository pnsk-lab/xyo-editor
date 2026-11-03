// Isolated adapter around upstream types; this is not a scheduler or a linker.
#include "core/gc.hpp"
#include "core/sstr.hpp"
#include "core/value.hpp"
#include "engine/runtime.hpp"
#include "engine/thread.hpp"
#include "jit/jit.hpp"
#include "load/sb3.hpp"
#include "model/target.hpp"
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <deque>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

struct RealHost {
    xyo::Runtime runtime;
    std::unique_ptr<xyo::Thread> thread;
    xyo::JitCtx ctx{};
    xyo::Target* target = nullptr;
    std::deque<std::string> strings;
    std::vector<void**> slots;
    size_t expectedSlots = 0;
    bool sealed = false;
    std::string error;
    RealHost() { xyo::Gc::get().addRootProvider(this, [this](xyo::Gc& gc) {
        for (auto p : slots) gc.markPtr(*p);
    }); liveHosts().insert(this); }
    ~RealHost() {
        liveHosts().erase(this);
        // The caller must keep the side module's memory alive until destruction.
        for (auto p : slots) { slotOwners().erase(p); *p = nullptr; }
        // Handles outlive no owner: a recycled handle value must never resolve
        // to this destroyed host.
        for (auto it = handleOwners().begin(); it != handleOwners().end();) {
            if (it->second == this) it = handleOwners().erase(it);
            else ++it;
        }
        xyo::Gc::get().removeRootProvider(this);
    }
    // Slot storage addresses owned by live hosts. A second host (or the same
    // host after release) must not alias them; invoke requires the seal below.
    static std::map<void**, RealHost*>& slotOwners() {
        static std::map<void**, RealHost*> owners;
        return owners;
    }
    // Handles opened through rh_dlopen_for, with their owning host. Unloading
    // while the owner is alive is refused; the owner must be destroyed first.
    static std::map<void*, RealHost*>& handleOwners() {
        static std::map<void*, RealHost*> owners;
        return owners;
    }
    static std::set<RealHost*>& liveHosts() {
        static std::set<RealHost*> live;
        return live;
    }
};
namespace {
// Mirror of the metadata compiler preflight: ZipReader::extract resizes to the
// untrusted central-directory uncompressedSize before validating, so bound it
// here first. Stored/deflate only, no allocation, any deviation rejects.
bool preflightZip(const uint8_t* data, size_t size, std::string& error) {
    auto fail = [&](const char* msg) { error = msg; return false; };
    if (!data || size < 22) return fail("zip too small");
    auto rd16 = [](const uint8_t* p) -> uint32_t {
        return uint32_t(p[0]) | (uint32_t(p[1]) << 8);
    };
    auto rd32 = [](const uint8_t* p) -> uint32_t {
        return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
               (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
    };
    size_t scanStart = size > 22 + 0xFFFF ? size - 22 - 0xFFFF : 0;
    size_t pos = size;
    for (size_t i = size - 22 + 1; i-- > scanStart;) {
        if (data[i] == 0x50 && data[i + 1] == 0x4B &&
            data[i + 2] == 0x05 && data[i + 3] == 0x06) {
            pos = i;
            break;
        }
    }
    if (pos == size) return fail("zip EOCD not found");
    uint32_t cdCount = rd16(data + pos + 10);
    uint32_t cdOffset = rd32(data + pos + 16);
    if (cdCount == 0 || cdCount > 4096) return fail("bad zip entry count");
    if (cdOffset > size) return fail("bad zip central offset");
    const uint8_t* p = data + cdOffset;
    const uint8_t* end = data + size;
    uint64_t totalUncompressed = 0;
    bool sawProjectJson = false;
    std::vector<std::string> names;
    names.reserve(cdCount);
    for (uint32_t i = 0; i < cdCount; ++i) {
        size_t remaining = size_t(end - p);
        if (remaining < 46 || rd32(p) != 0x02014B50) return fail("bad zip entry");
        uint32_t method = rd16(p + 10);
        if (method != 0 && method != 8) return fail("unsupported zip method");
        uint32_t compSize = rd32(p + 20);
        uint32_t uncompSize = rd32(p + 24);
        uint32_t nameLen = rd16(p + 28);
        uint32_t extraLen = rd16(p + 30);
        uint32_t commentLen = rd16(p + 32);
        uint32_t localOff = rd32(p + 42);
        if (nameLen == 0 || nameLen > 1024) return fail("bad zip name length");
        size_t tail = 46ull + nameLen + extraLen + commentLen;
        if (tail > remaining) return fail("zip entry overruns input");
        std::string name(reinterpret_cast<const char*>(p + 46), nameLen);
        for (const auto& seen : names) {
            if (seen == name) return fail("duplicate zip entry");
        }
        names.push_back(name);
        if (localOff + 30 < localOff || localOff + 30 > size) return fail("bad zip local offset");
        if (compSize > size) return fail("bad zip compressed size");
        if (uncompSize > 16u * 1024u * 1024u) return fail("zip entry too large");
        totalUncompressed += uncompSize;
        if (totalUncompressed > 64u * 1024u * 1024u) return fail("zip total too large");
        if (method == 0 && compSize != uncompSize) return fail("stored size mismatch");
        if (name == "project.json") sawProjectJson = true;
        p += tail;
    }
    if (!sawProjectJson) return fail("project.json not found");
    return true;
}
} // namespace
extern "C" {
RealHost* rh_create(const uint8_t* bytes, size_t size) {
    auto h = std::make_unique<RealHost>();
    if (!bytes || !size || size > 16u*1024u*1024u) { h->error = "invalid input"; return h.release(); }
    std::string zipError;
    if (!preflightZip(bytes, size, zipError)) { h->error = "zip preflight rejected: " + zipError; return h.release(); }
    auto r = xyo::loadSb3File(h->runtime, bytes, size);
    if (!r.ok) { h->error = "load: " + r.error; return h.release(); }
    std::string top;
    size_t scripts = 0;
    for (auto* t : h->runtime.targets) if (t && t->isOriginal && t->blocks) {
        for (const auto& id : t->blocks->getScripts()) {
            ++scripts; auto* b = t->blocks->getBlock(id);
            if (b && b->opcode == "event_whenflagclicked") { h->target = t; top = id; }
        }
    }
    if (scripts != 1 || !h->target) { h->target = nullptr; h->error = "expected exactly one green flag script"; return h.release(); }
    auto* hat = h->target->blocks->getBlock(top);
    // Keep admission identical to the metadata compiler: a short straight-line
    // chain of set/change blocks with numeric shadows (capped length also
    // bounds cyclic chains). Error strings match the compiler gates.
    {
        auto* chain = h->target->blocks->getBlock(hat->next);
        size_t blocks = 0;
        std::string why;
        for (; chain && why.empty(); chain = h->target->blocks->getBlock(chain->next)) {
            if (++blocks > 8) { why = "script chain too long"; break; }
            if (chain->opcode != "data_setvariableto" && chain->opcode != "data_changevariableby") {
                why = "expected only variable set/change blocks";
                break;
            }
            if (chain->mutation || chain->inputs.size() != 1 || !chain->fields.count("VARIABLE")) {
                why = "malformed set/change block";
                break;
            }
            const auto& varField = chain->fields.find("VARIABLE")->second;
            if (varField.id.empty() || varField.id.find('\0') != std::string::npos) {
                why = "VARIABLE id must be non-empty without NUL";
                break;
            }
            if (varField.value.isString() && varField.value.bits != xyo::val::kEmptyStr) {
                const xyo::SStr* name = varField.value.asStrPtr();
                if (name && name->view().find(u'\0') != std::u16string_view::npos) {
                    why = "VARIABLE name must not contain NUL";
                    break;
                }
            }
            auto* input = chain->inputs.find("VALUE");
            if (!input) { why = "missing VALUE"; break; }
            auto* literal = h->target->blocks->getBlock(input->block.empty() ? input->shadow : input->block);
            if (!literal || !literal->shadow || literal->opcode != "math_number" || !literal->next.empty() ||
                !literal->inputs.empty() || literal->mutation || !literal->fields.count("NUM")) {
                why = "VALUE must be a numeric shadow";
                break;
            }
            if (chain->next.empty()) break;
        }
        if (blocks == 0) why = "expected a variable set/change chain";
        if (!why.empty()) { h->target = nullptr; h->error = why; return h.release(); }
    }
    h->thread = std::make_unique<xyo::Thread>(top);
    h->thread->target = h->target;
    h->ctx.thread = h->thread.get(); h->ctx.target = h->target;
    h->ctx.runtime = &h->runtime; h->ctx.sequencer = h->runtime.sequencer.get();
    return h.release();
}
void rh_destroy(RealHost* h) { delete h; }
const char* rh_error(RealHost* h) { return h ? h->error.c_str() : "null host"; }
xyo::JitCtx* rh_context(RealHost* h) { return h && h->target ? &h->ctx : nullptr; }
xyo::Target* rh_target(RealHost* h) { return h ? h->target : nullptr; }
xyo::Variable* rh_variable(RealHost* h, const char* id) { return h && h->target && id ? h->target->lookupVariableById(id) : nullptr; }
uint64_t rh_variable_bits(xyo::Variable* v) { return v ? v->value.bits : 0; }
int32_t rh_variable_string_length(xyo::Variable* v) {
    if (!v || !v->value.isString()) return -1;
    auto* s = v->value.asStrPtr(); return s ? int32_t(s->len) : 0;
}
int32_t rh_variable_string_unit(xyo::Variable* v, uint32_t index) {
    if (!v || !v->value.isString()) return -1;
    auto* s = v->value.asStrPtr(); return s && index < s->len ? s->data()[index] : -1;
}
xyo::Variable* rh_var_slot(RealHost* h, uint32_t index) { return h && h->thread && index < h->thread->jitVarSlots.size() ? h->thread->jitVarSlots[index] : nullptr; }
void* rh_slot_value(void** slot) { return slot ? *slot : nullptr; }
// kind follows upstream AotSlotKind. key is bytes, not necessarily text.
// Register the address before allocating an SStr, as loadAot does.
int rh_bind_slot(RealHost* h, void** slot, int kind, const uint8_t* key, size_t n) {
    if (!h || !h->target || !slot || !key || *slot) return 0;
    for (auto p : h->slots) if (p == slot) return 0;
    if (kind != 0 && kind != 1 && kind != 2 && kind != 3) return 0;
    if ((kind == 0 || kind == 1) && n && std::memchr(key, 0, n)) return 0;
    if (kind == 3 && (n & 1)) return 0;
    void* value = nullptr;
    if (kind == 0 || kind == 1) {
        h->strings.emplace_back(reinterpret_cast<const char*>(key), n);
        value = const_cast<char*>(h->strings.back().c_str());
    } else if (kind == 2) {
        std::string s(reinterpret_cast<const char*>(key), n);
        auto sep = s.find('\1');
        size_t ti = 0; std::string id = s;
        if (sep != std::string::npos) {
            if (!sep) return 0;
            for (size_t i=0; i<sep; ++i) { if (s[i] < '0' || s[i] > '9' || ti > 1000000) return 0; ti = ti*10 + size_t(s[i]-'0'); }
            id = s.substr(sep+1);
        }
        if (ti >= h->runtime.targets.size() || !h->runtime.targets[ti] || !h->runtime.targets[ti]->blocks) return 0;
        auto* b = h->runtime.targets[ti]->blocks;
        if (!b->getBlock(id)) return 0;
        value = b->getCachedExecute(id);
        if (!value) return 0;
    }
    {
        auto it = RealHost::slotOwners().find(slot);
        if (it != RealHost::slotOwners().end() && it->second != h) return 0;
    }
    if (h->expectedSlots > 0 && h->slots.size() >= h->expectedSlots) return 0;
    h->slots.push_back(slot);
    if (kind == 3) {
        std::u16string u(n/2, u'\0');
        if (n) std::memcpy(u.data(), key, n);
        value = xyo::SStr::create(u);
    }
    *slot = value;
    RealHost::slotOwners()[slot] = h;
    if (h->expectedSlots > 0 && h->slots.size() == h->expectedSlots) h->sealed = true;
    return 1;
}
// Declare how many slots a verified binding needs before any bind. After
// exactly that many successful binds the host is sealed; invoke refuses
// unsealed hosts, so a module can no longer run against a foreign or partial
// binding (e.g. host B invoking entry with host A's globals).
int rh_expect_slots(RealHost* h, uint32_t n) {
    if (!h || !h->target || n == 0 || n > 64) return 0;
    if (h->expectedSlots != 0 || !h->slots.empty()) return 0;
    h->expectedSlots = n;
    return 1;
}
int rh_is_sealed(RealHost* h) { return (h && h->sealed) ? 1 : 0; }
void rh_collect() { xyo::Gc::get().collect(); }
// Caller must preflight the Wasm and destroy RealHost before closing the handle.
void* rh_dlopen(const char* path) { return path ? dlopen(path, RTLD_NOW | RTLD_LOCAL) : nullptr; }
// Tracked open: the handle is bound to a live host, and rh_dlclose refuses to
// unload it until that host is destroyed. Prefer this over rh_dlopen.
void* rh_dlopen_for(RealHost* h, const char* path) {
    if (!h || !h->target || !path) return nullptr;
    void* handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!handle) return nullptr;
    auto& owners = RealHost::handleOwners();
    if (!owners.count(handle)) owners[handle] = h;
    return handle;
}
void* rh_dlsym(void* handle, const char* name) { return handle && name ? dlsym(handle, name) : nullptr; }
int rh_dlclose(void* handle) {
    if (!handle) return -1;
    // Handle values are recycled by the loader across open/close generations,
    // so no per-value closed set is kept: a stale entry would poison a later
    // generation reusing the value. Unload is refused only while the recorded
    // owner is still alive; Emscripten itself reports double-close safely.
    auto it = RealHost::handleOwners().find(handle);
    if (it != RealHost::handleOwners().end() && RealHost::liveHosts().count(it->second)) return -1;
    RealHost::handleOwners().erase(handle);
    return dlclose(handle);
}
void rh_invoke(void* entry, RealHost* h) {
    // Silent refusal by design: entry/ownership checks stay in the caller and
    // rh_is_sealed. Never run unsealed or foreign bindings.
    if (!entry || !h || !h->target || !h->sealed) return;
    reinterpret_cast<xyo::ScriptFn>(entry)(&h->ctx);
}
// Diagnostic descriptor mirrors the compiler's *partial* ABI fingerprint.
// The target constants identify this proof's IR, not the C++ compiler itself.
const char* rh_abi_descriptor() {
    static const std::string descriptor = [] {
        std::string s = "xyo-browser-ir-abi-v1;llvm=19.1.7;triple=wasm32-unknown-emscripten;layout=e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-f128:64-n32:64-S128-ni:1:10:20";
        auto add = [&](const char* key, size_t value) { s += ';'; s += key; s += '='; s += std::to_string(value); };
        add("ptr_size", sizeof(void*)); add("ptr_align", alignof(void*));
        add("ctx_size", sizeof(xyo::JitCtx)); add("ctx_align", alignof(xyo::JitCtx));
        add("ctx_thread", offsetof(xyo::JitCtx, thread)); add("ctx_target", offsetof(xyo::JitCtx, target));
        add("ctx_runtime", offsetof(xyo::JitCtx, runtime)); add("ctx_var_slots", offsetof(xyo::JitCtx, varSlotData));
        add("variable_size", sizeof(xyo::Variable)); add("variable_align", alignof(xyo::Variable));
        add("variable_value", offsetof(xyo::Variable, value)); add("variable_list", offsetof(xyo::Variable, list));
        add("value_size", sizeof(xyo::Value)); add("value_align", alignof(xyo::Value));
        add("sstr_size", sizeof(xyo::SStr)); add("sstr_align", alignof(xyo::SStr));
        add("sstr_len", offsetof(xyo::SStr, len)); add("sstr_num_cache", offsetof(xyo::SStr, numCache));
        add("sstr_num_state", offsetof(xyo::SStr, numState));
        auto addHex = [&](const char* key, uint64_t value) {
            char buf[17];
            std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(value));
            s += ';'; s += key; s += '='; s += buf;
        };
        addHex("tag_base", xyo::val::kTagBase); addHex("tag_str", xyo::val::kTagStr);
        addHex("tag_color", xyo::val::kTagColor); addHex("tag_nan", xyo::val::kNan);
        addHex("tag_false", xyo::val::kFalse); addHex("tag_true", xyo::val::kTrue);
        addHex("tag_emptystr", xyo::val::kEmptyStr); addHex("tag_undefined", xyo::val::kUndefined);
        addHex("tag_ptrmask", xyo::val::kPtrMask);
        s += ";helper_xyo_varslot_init=void(ptr,i64,ptr,ptr,i32)";
        s += ";helper_xyo_to_num=double(i64)";
        return s;
    }();
    return descriptor.c_str();
}
// Fingerprint pieces for comparison with the exact compiler build/IR.
uint32_t rh_layout(uint32_t n) {
    switch (n) {
    case 0: return sizeof(void*); case 1: return sizeof(xyo::JitCtx);
    case 2: return offsetof(xyo::JitCtx, varSlotData);
    case 3: return offsetof(xyo::Variable, value);
    case 4: return sizeof(xyo::Value); case 5: return sizeof(xyo::SStr);
    case 6: return offsetof(xyo::JitCtx, thread); case 7: return offsetof(xyo::JitCtx, target);
    case 8: return offsetof(xyo::JitCtx, runtime); default: return UINT32_MAX;
    }
}
}
