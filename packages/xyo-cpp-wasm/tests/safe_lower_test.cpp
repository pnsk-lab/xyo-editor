#include "safe_lower.hpp"
#include "core/sstr.hpp"
#include <cassert>
#include <cstdio>
#include <limits>
#include <utility>

using namespace xyo;
using namespace xyo::wasm;

int main() {
    Blocks b(nullptr);
    auto add = [&](const char* id, const char* op) {
        Block x; x.id = id; x.opcode = op; b.createBlock(std::move(x));
    };
    add("hat", "event_whenflagclicked"); add("set", "data_setvariableto");
    add("sum", "operator_add"); add("var", "data_variable"); add("n", "math_number");
    b.getBlock("hat")->next = "set";
    b.getBlock("set")->fields["VARIABLE"].id = "v";
    b.getBlock("set")->inputs.set("VALUE", {"sum", ""});
    b.getBlock("sum")->inputs.set("NUM1", {"var", ""});
    b.getBlock("sum")->inputs.set("NUM2", {"n", "n"});
    b.getBlock("var")->fields["VARIABLE"].id = "v";
    b.getBlock("n")->fields["NUM"].value = Value::num(3);
    SafeScript s;
    assert(lowerSafeFlag(b, b.getBlock("hat"), s));
    assert(s.bindings.size() == 1 && s.program.main.size() == 1);
    auto bytes = compileProgram(s.program);
    assert(!bytes.empty());
    for (auto byte : bytes) std::printf("%02x", byte);
    std::puts("");
    // Only the four precisely defined math operations are lowered.
    add("math", "operator_mathop");
    b.getBlock("set")->inputs.set("VALUE", {"math", ""});
    b.getBlock("math")->inputs.set("NUM", {"var", ""});
    for (const auto* name : {u"abs", u"FLOOR", u"ceiling", u"sqrt"}) {
        b.getBlock("math")->fields["OPERATOR"].value = Value::string(SStr::create(name));
        assert(lowerSafeFlag(b, b.getBlock("hat"), s));
    }
    add("inner", "operator_mathop");
    b.getBlock("inner")->fields["OPERATOR"].value = Value::string(SStr::create(u"ABS"));
    b.getBlock("inner")->inputs.set("NUM", {"var", ""});
    b.getBlock("math")->inputs.set("NUM", {"inner", ""});
    assert(lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("math")->inputs.set("EXTRA", {"n", ""});
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("math")->inputs.items.pop_back();
    b.getBlock("math")->fields["OPERATOR"].value = Value::string(SStr::create(u"sin"));
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("set")->inputs.set("VALUE", {"sum", ""});
    // A shadow without an active block is undefined to the interpreter.
    b.getBlock("sum")->inputs.set("NUM2", {"", "n"});
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    assert(s.program.main.size() == 1);
    b.getBlock("sum")->inputs.set("NUM2", {"missing", "n"});
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    // Reusing one reporter as two inputs is not a tree: the interpreter's
    // cached parentKey is shared, so reject it conservatively.
    b.getBlock("sum")->inputs.set("NUM2", {"var", ""});
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("sum")->inputs.set("NUM2", {"n", "n"});
    // Numeric fields and variable reads preserve finite numeric Value bits.
    b.getBlock("set")->inputs.set("VALUE", {"n", ""});
    assert(lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("set")->inputs.set("VALUE", {"var", ""});
    assert(lowerSafeFlag(b, b.getBlock("hat"), s));
    // A numeric-looking string field is still a string on assignment.
    b.getBlock("n")->fields["NUM"].value = Value::emptyStr();
    b.getBlock("set")->inputs.set("VALUE", {"n", ""});
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    assert(s.program.main.size() == 1); // failure is atomic
    add("change", "data_changevariableby"); add("delta", "math_number");
    b.getBlock("n")->fields["NUM"].value = Value::string(SStr::create(u"3.5"));
    b.getBlock("set")->next = "change";
    b.getBlock("change")->fields["VARIABLE"].id = "v";
    b.getBlock("change")->inputs.set("VALUE", {"delta", "delta"});
    b.getBlock("delta")->fields["NUM"].value = Value::num(2);
    assert(lowerSafeFlag(b, b.getBlock("hat"), s));
    assert(s.program.main.size() == 2);
    b.getBlock("change")->fields["VARIABLE"].id = "other";
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("change")->fields["VARIABLE"].id = "v";
    b.getBlock("change")->inputs.set("VALUE", {"var", ""});
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("change")->inputs.set("VALUE", {"delta", "delta"});
    b.getBlock("n")->fields["NUM"].value = Value::string(SStr::create(u"not numeric"));
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("set")->next.clear();
    b.getBlock("n")->fields["NUM"].value = Value::num(std::numeric_limits<double>::quiet_NaN());
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("n")->fields["NUM"].value = Value::num(3);
    b.getBlock("set")->inputs.set("VALUE", {"sum", ""});
    b.getBlock("set")->next = "set";
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("set")->next.clear();
    b.getBlock("sum")->inputs.set("NUM1", {"sum", ""});
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("sum")->inputs.set("NUM1", {"var", ""});
    b.getBlock("set")->opcode = "control_repeat";
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    b.getBlock("set")->opcode = "looks_say";
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
    // A plain interpreted block may precede a separate numeric chunk, but a
    // control-flow edge and a next-edge cycle must never be crossed.
    add("say", "looks_say");
    b.getBlock("hat")->next = "say";
    b.getBlock("say")->next = "set";
    b.getBlock("set")->opcode = "data_changevariableby";
    std::string start;
    assert(lowerSafeAfterFlag(b, b.getBlock("hat"), s, start) && start == "set");
    b.getBlock("say")->opcode = "control_if";
    assert(!lowerSafeAfterFlag(b, b.getBlock("hat"), s, start));
    b.getBlock("say")->opcode = "looks_say";
    b.getBlock("set")->next = "say";
    assert(!lowerSafeAfterFlag(b, b.getBlock("hat"), s, start));
    b.getBlock("set")->next.clear();
    b.getBlock("hat")->opcode = "event_whenkeypressed";
    assert(!lowerSafeFlag(b, b.getBlock("hat"), s));
}
