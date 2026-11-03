#include "safe_lower.hpp"

#include "core/cast.hpp"
#include "core/sstr.hpp"
#include <cmath>
#include <map>
#include <set>
#include <utility>

namespace xyo::wasm {
namespace {
// Limits also bound malformed graphs, generated code size, and uninterrupted work.
constexpr unsigned kMaxNodes = 256;
constexpr unsigned kMaxDepth = 32;

struct Lower {
    Blocks& blocks;
    SafeScript result;
    unsigned visited = 0;
    std::set<const Block*> active;
    std::set<const Block*> expressionNodes;
    std::map<std::pair<std::string, std::u16string>, uint32_t> slots;

    const Block* input(const Block* b, const char* name) {
        const auto* in = b->inputs.find(name);
        // The interpreter evaluates only block, never shadow as a fallback.
        // An empty block therefore means an undefined input even if a shadow
        // exists; reject the script instead of compiling a different value.
        if (!in || in->block.empty()) return nullptr;
        return blocks.getBlock(in->block);
    }
    bool slot(const Block* b, uint32_t& out) {
        auto it = b->fields.find("VARIABLE");
        if (it == b->fields.end() || it->second.id.empty()) return false;
        const auto key = std::make_pair(it->second.id,
            std::u16string(cast::toString(it->second.value)->view()));
        auto found = slots.find(key);
        if (found != slots.end()) { out = found->second; return true; }
        out = static_cast<uint32_t>(result.bindings.size());
        slots.emplace(key, out);
        result.bindings.push_back({key.first, key.second});
        result.program.nSlots = static_cast<uint32_t>(result.bindings.size());
        return true;
    }
    bool expr(const Block* b, uint32_t& out, unsigned depth) {
        // Shared reporter nodes have one mutable parentKey in the interpreter's
        // execution cache. Reject them rather than assuming tree semantics.
        if (!b || depth > kMaxDepth || ++visited > kMaxNodes ||
            !expressionNodes.insert(b).second || !active.insert(b).second)
            return false;
        result.reporters.push_back(b->id);
        const bool ok = exprImpl(b, out, depth);
        active.erase(b);
        return ok;
    }
    static bool inputsAre(const Block* b, const char* a, const char* c = nullptr) {
        const size_t expected = c ? 2 : (a ? 1 : 0);
        return b->inputs.items.size() == expected &&
            (!a || b->inputs.find(a)) && (!c || b->inputs.find(c));
    }
    bool exprImpl(const Block* b, uint32_t& out, unsigned depth) {
        const auto& op = b->opcode;
        if (op == "math_number" || op == "math_integer" ||
            op == "math_whole_number" || op == "math_positive_number" ||
            op == "math_angle") {
            auto f = b->fields.find("NUM");
            if (!inputsAre(b, nullptr) || b->fields.size() != 1 || f == b->fields.end()) return false;
            out = result.program.exprNum(cast::toNumber(f->second.value));
            return true;
        }
        if (op == "data_variable") {
            if (!inputsAre(b, nullptr)) return false;
            uint32_t s;
            if (!slot(b, s)) return false;
            out = result.program.exprVar(s);
            return true;
        }
        if (op == "operator_round") {
            if (!inputsAre(b, "NUM")) return false;
            uint32_t a;
            if (!expr(input(b, "NUM"), a, depth + 1)) return false;
            out = result.program.exprUn(EK::Round, a);
            return true;
        }
        if (op == "operator_mathop") {
            auto f = b->fields.find("OPERATOR");
            if (!inputsAre(b, "NUM") || b->fields.size() != 1 || f == b->fields.end()) return false;
            const auto name = u16ToLower(cast::toString(f->second.value)->view());
            EK k;
            if (name == u"abs") k = EK::Abs;
            else if (name == u"floor") k = EK::Floor;
            else if (name == u"ceiling") k = EK::Ceil;
            else if (name == u"sqrt") k = EK::Sqrt;
            else return false;
            uint32_t a;
            if (!expr(input(b, "NUM"), a, depth + 1)) return false;
            out = result.program.exprUn(k, a);
            return true;
        }
        EK k;
        if (op == "operator_add") k = EK::Add;
        else if (op == "operator_subtract") k = EK::Sub;
        else if (op == "operator_multiply") k = EK::Mul;
        else if (op == "operator_divide") k = EK::Div;
        else return false;
        if (!inputsAre(b, "NUM1", "NUM2")) return false;
        uint32_t a, c;
        if (!expr(input(b, "NUM1"), a, depth + 1) ||
            !expr(input(b, "NUM2"), c, depth + 1)) return false;
        out = result.program.exprBin(k, a, c);
        return true;
    }
    // A string assignment is observable unless the immediately following
    // change converts that very same variable before any possible yield.
    bool immediatelyCoerced(const Block* set, const Block* value) {
        auto f = value->fields.find("NUM");
        if (f == value->fields.end() || !f->second.value.isString() ||
            !std::isfinite(cast::toNumberOrNaN(f->second.value))) return false;
        const Block* change = blocks.getBlock(set->next);
        if (!change || change->opcode != "data_changevariableby" ||
            !inputsAre(change, "VALUE")) return false;
        auto a = set->fields.find("VARIABLE"), b = change->fields.find("VARIABLE");
        if (a == set->fields.end() || b == change->fields.end() ||
            a->second.id.empty() || a->second.id != b->second.id ||
            cast::toString(a->second.value)->view() != cast::toString(b->second.value)->view()) return false;
        const Block* delta = input(change, "VALUE");
        if (!delta || (delta->opcode != "math_number" && delta->opcode != "math_integer" &&
            delta->opcode != "math_whole_number" && delta->opcode != "math_positive_number" &&
            delta->opcode != "math_angle") || !inputsAre(delta, nullptr) || delta->fields.size() != 1)
            return false;
        auto n = delta->fields.find("NUM");
        return n != delta->fields.end() && std::isfinite(cast::toNumber(n->second.value));
    }
    bool runFrom(std::string id, bool prefix = false) {
        if (id.empty()) return false;
        std::set<std::string> chain;
        while (!id.empty()) {
            if (!chain.insert(id).second || ++visited > kMaxNodes) return false;
            const Block* b = blocks.getBlock(id);
            if (!b) return false;
            // One isolated move only. Its four private slots are x, y, cos,
            // sin; unlike variable slots they never alias project state.
            if (b->opcode == "motion_movesteps" && result.program.main.empty()) {
                if (!inputsAre(b, "STEPS") || !b->fields.empty()) return false;
                const Block* value = input(b, "STEPS");
                if (!value || (value->opcode != "math_number" && value->opcode != "math_integer" &&
                    value->opcode != "math_whole_number" && value->opcode != "math_positive_number" &&
                    value->opcode != "math_angle")) return false;
                uint32_t e;
                if (!expr(value, e, 0)) return false;
                const double steps = result.program.exprs[e].num;
                if (!std::isfinite(steps)) return false;
                result.motion = true;
                result.motionSteps = steps;
                result.program.nSlots = 4;
                for (uint32_t axis = 0; axis < 2; ++axis) {
                    Stmt st;
                    st.k = SK::SetVar;
                    st.var = axis;
                    auto product = result.program.exprBin(EK::Mul, e, result.program.exprVar(axis + 2));
                    st.expr = result.program.exprBin(EK::Add, result.program.exprVar(axis), product);
                    result.program.main.push_back(result.program.stmt(std::move(st)));
                }
                result.lastBlock = id;
                result.statements.push_back(id);
                if (prefix) {
                    if (b->next.empty()) return false;
                    result.nextBlock = b->next;
                } else if (!b->next.empty()) return false;
                return true;
            }
            // Exactly one axis operation, with private x/y slots. Do not fuse
            // multiple calls to setXY or absorb variable/loop statements.
            const bool cx = b->opcode == "motion_changexby";
            const bool sx = b->opcode == "motion_setx";
            const bool cy = b->opcode == "motion_changeyby";
            const bool sy = b->opcode == "motion_sety";
            if ((cx || sx || cy || sy) && result.program.main.empty()) {
                const char* name = cx ? "DX" : sx ? "X" : cy ? "DY" : "Y";
                if (!inputsAre(b, name) || !b->fields.empty()) return false;
                const Block* value = input(b, name);
                if (!value || (value->opcode != "math_number" && value->opcode != "math_integer" &&
                    value->opcode != "math_whole_number" && value->opcode != "math_positive_number" &&
                    value->opcode != "math_angle")) return false;
                uint32_t e;
                if (!expr(value, e, 0) || !std::isfinite(result.program.exprs[e].num)) return false;
                result.motion = true;
                result.program.nSlots = 4; // same motion staging ABI as movesteps
                Stmt st;
                st.k = SK::SetVar;
                st.var = (cx || sx) ? 0 : 1;
                st.expr = (cx || cy) ? result.program.exprBin(EK::Add, result.program.exprVar(st.var), e) : e;
                result.program.main.push_back(result.program.stmt(std::move(st)));
                result.lastBlock = id;
                result.statements.push_back(id);
                if (prefix) {
                    if (b->next.empty()) return false;
                    result.nextBlock = b->next;
                } else if (!b->next.empty()) return false;
                return true;
            }
            SK k;
            if (b->opcode == "data_setvariableto") k = SK::SetVar;
            else if (b->opcode == "data_changevariableby") k = SK::ChangeVar;
            else {
                if (!prefix || result.program.main.empty()) return false;
                result.nextBlock = id;
                return true;
            }
            if (!inputsAre(b, "VALUE")) return false;
            const Block* value = input(b, "VALUE");
            // Set normally preserves the raw Value, unlike numeric coercion in
            // expr(). A finite numeric string is safe only when the immediately
            // following literal change coerces the same variable without yield.
            // VarGet is guarded at execution time to finite numbers.
            if (k == SK::SetVar) {
                if (!value) return false;
                const auto& op = value->opcode;
                if (op == "math_number" || op == "math_integer" ||
                    op == "math_whole_number" || op == "math_positive_number" ||
                    op == "math_angle") {
                    auto f = value->fields.find("NUM");
                    if (f == value->fields.end()) return false;
                    if (f->second.value.isNumber()) {
                        if (!std::isfinite(f->second.value.asNumberUnchecked())) return false;
                    } else if (!immediatelyCoerced(b, value)) return false;
                } else if (op != "data_variable" && op != "operator_add" &&
                           op != "operator_subtract" && op != "operator_multiply" &&
                           op != "operator_divide" && op != "operator_round" &&
                           op != "operator_mathop") return false;
            }
            uint32_t e, s;
            if (!expr(value, e, 0) || !slot(b, s)) return false;
            Stmt st;
            st.k = k; st.var = s; st.expr = e;
            result.program.main.push_back(result.program.stmt(std::move(st)));
            result.lastBlock = id;
            result.statements.push_back(id);
            id = b->next;
        }
        return !prefix;
    }
    bool run(const Block* top, bool prefix = false) {
        return top && top->opcode == "event_whenflagclicked" && runFrom(top->next, prefix);
    }
};
} // namespace

#ifdef XYO_SAFE_WASM_LOOP_EXPERIMENT
bool lowerFirstLoopBody(Blocks& blocks, const Block* top, SafeScript& out,
                        std::string& loopId) {
    if (!top || top->opcode != "event_whenflagclicked") return false;
    const Block* loop = blocks.getBlock(top->next);
    if (!loop || loop->opcode != "control_repeat" || !loop->next.empty()) return false;
    const auto* sub = loop->inputs.find("SUBSTACK");
    if (!sub || sub->block.empty()) return false;
    const Block* body = blocks.getBlock(sub->block);
    if (!body || body->opcode != "data_changevariableby" || !body->next.empty() ||
        body->fields.size() != 1 || !body->fields.count("VARIABLE")) return false;
    const auto* input = body->inputs.find("VALUE");
    const Block* value = input ? blocks.getBlock(input->block) : nullptr;
    if (!value || value->opcode != "math_number") return false;
    Lower l{blocks};
    if (!l.runFrom(body->id) || l.result.statements.size() != 1 ||
        l.result.reporters.size() != 1 || l.result.bindings.size() != 1 ||
        l.result.program.exprs.size() != 1 ||
        l.result.program.exprs[0].k != EK::ConstNum ||
        !std::isfinite(l.result.program.exprs[0].num)) return false;
    loopId = loop->id;
    out = std::move(l.result);
    return true;
}
#endif

bool lowerSafePrefix(Blocks& blocks, const Block* top, SafeScript& out) {
    Lower l{blocks};
    if (!l.run(top, true)) return false;
    out = std::move(l.result);
    return true;
}

bool lowerSafeAfterFlag(Blocks& blocks, const Block* top, SafeScript& out, std::string& start) {
    if (!top || top->opcode != "event_whenflagclicked") return false;
    // Reject next-edge cycles even when a candidate chunk ends at an
    // unsupported block; otherwise a malformed graph could revisit it.
    std::set<std::string> chain;
    for (std::string n = top->next; !n.empty();) {
        if (chain.size() >= kMaxNodes || !chain.insert(n).second) return false;
        const Block* b = blocks.getBlock(n);
        if (!b) return false;
        n = b->next;
    }
    std::set<std::string> seen;
    std::string id = top->next;
    bool skipped = false;
    while (!id.empty() && seen.size() < kMaxNodes && seen.insert(id).second) {
        const Block* b = blocks.getBlock(id);
        if (!b) return false;
        if (skipped) {
            Lower whole{blocks};
            if (whole.runFrom(id)) { start = id; out = std::move(whole.result); return true; }
            Lower prefix{blocks};
            if (prefix.runFrom(id, true)) { start = id; out = std::move(prefix.result); return true; }
        }
        // Only opcodes with straight-line statement semantics.  A yield in
        // these opcodes is fine: the pending chunk is discarded at step exit.
        static const std::set<std::string> straight = {
            "data_setvariableto", "data_changevariableby",
            "looks_say", "looks_sayforsecs", "looks_think", "looks_thinkforsecs",
            "looks_show", "looks_hide", "looks_switchcostumeto", "looks_nextcostume",
            "looks_switchbackdropto", "looks_switchbackdroptoandwait", "looks_nextbackdrop",
            "looks_changeeffectby", "looks_seteffectto", "looks_cleargraphiceffects",
            "looks_changesizeby", "looks_setsizeto", "looks_gotofrontback",
            "looks_goforwardbackwardlayers", "motion_movesteps", "motion_gotoxy",
            "motion_goto", "motion_turnright", "motion_turnleft", "motion_pointindirection",
            "motion_pointtowards", "motion_glidesecstoxy", "motion_glideto",
            "motion_ifonedgebounce", "motion_setrotationstyle", "motion_changexby",
            "motion_setx", "motion_changeyby", "motion_sety"
        };
        if (!straight.count(b->opcode)) return false;
        skipped = true;
        id = b->next;
    }
    return false;
}

bool lowerSafeFlag(Blocks& blocks, const Block* top, SafeScript& out) {
    Lower l{blocks};
    if (!l.run(top)) return false;
    out = std::move(l.result);
    return true;
}
} // namespace xyo::wasm
