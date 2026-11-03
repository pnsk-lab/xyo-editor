#include "browser.h"
#include "load/zip.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

static std::vector<uint8_t> project(bool stamp = false) {
    const std::string last = stamp ? "stamp" : "clear";
    const std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{},"lists":{},"broadcasts":{},"blocks":{},"costumes":[],"sounds":[],"currentCostume":0},{"isStage":false,"name":"Sprite1","variables":{},"lists":{},"broadcasts":{},"x":0,"y":0,"direction":90,"size":100,"visible":true,"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"down","inputs":{},"fields":{}},"down":{"opcode":"pen_penDown","next":"move","inputs":{},"fields":{}},"move":{"opcode":"motion_movesteps","next":"up","inputs":{"STEPS":[1,[4,"20"]]},"fields":{}},"up":{"opcode":"pen_penUp","next":")" + last + R"(","inputs":{},"fields":{}},"clear":{"opcode":"pen_clear","next":null,"inputs":{},"fields":{}},"stamp":{"opcode":"pen_stamp","next":null,"inputs":{},"fields":{}}},"costumes":[],"sounds":[],"currentCostume":0}],"monitors":[],"extensions":["pen"],"meta":{}})";
    xyo::ZipWriter z; z.addFile("project.json", {json.begin(), json.end()}); return z.finish();
}
static std::vector<uint8_t> cloneProject() {
    const std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{},"lists":{},"broadcasts":{},"blocks":{},"costumes":[],"sounds":[]},{"isStage":false,"name":"Sprite1","variables":{},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"down","inputs":{},"fields":{}},"down":{"opcode":"pen_penDown","next":"clone","inputs":{},"fields":{}},"clone":{"opcode":"control_create_clone_of","next":"up","inputs":{"CLONE_OPTION":[1,[10,"_myself_"]]},"fields":{}},"up":{"opcode":"pen_penUp","next":null,"inputs":{},"fields":{}},"clonehat":{"opcode":"control_start_as_clone","topLevel":true,"next":"move","inputs":{},"fields":{}},"move":{"opcode":"motion_movesteps","next":"delete","inputs":{"STEPS":[1,[4,"20"]]},"fields":{}},"delete":{"opcode":"control_delete_this_clone","next":null,"inputs":{},"fields":{}}},"costumes":[],"sounds":[],"x":0,"y":0,"direction":90,"size":100,"visible":true}],"monitors":[],"extensions":["pen"],"meta":{}})";
    xyo::ZipWriter z; z.addFile("project.json", {json.begin(), json.end()}); return z.finish();
}
static std::vector<uint8_t> overflowProject() {
    std::string blocks = R"({"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"p0","inputs":{},"fields":{}})";
    for (int i = 0; i < 4097; ++i) {
        blocks += ",\"p" + std::to_string(i) + "\":{\"opcode\":\"pen_penDown\",\"next\":";
        blocks += i == 4096 ? "null" : "\"p" + std::to_string(i + 1) + "\"";
        blocks += ",\"inputs\":{},\"fields\":{}}";
    }
    blocks += "}";
    const std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{},"lists":{},"broadcasts":{},"blocks":{},"costumes":[],"sounds":[]},{"isStage":false,"name":"Sprite1","variables":{},"lists":{},"broadcasts":{},"blocks":)" + blocks + R"(,"costumes":[],"sounds":[],"x":0,"y":0,"direction":90,"size":100,"visible":true}],"monitors":[],"extensions":["pen"],"meta":{}})";
    xyo::ZipWriter z; z.addFile("project.json", {json.begin(), json.end()}); return z.finish();
}
int main() {
    auto bytes = project();
    const auto h = xyo_browser_create(); assert(h);
    assert(xyo_browser_pen_enable(h));
    assert(!xyo_browser_pen_enable(h));
    assert(xyo_browser_load_sb3(h, bytes.data(), bytes.size()));
    assert(xyo_browser_green_flag(h));
    assert(xyo_browser_step(h));
    assert(xyo_browser_pen_count(h) == 3);
    assert(xyo_browser_pen_kind(h, 0) == 1);
    assert(xyo_browser_pen_kind(h, 1) == 2);
    assert(xyo_browser_pen_kind(h, 2) == 3);
    assert(xyo_browser_pen_value(h, 1, 5) == 0);
    assert(std::abs(xyo_browser_pen_value(h, 1, 7) - 20) < 1e-8);
    assert(!xyo_browser_load_sb3(h, bytes.data(), bytes.size()));
    assert(xyo_browser_pen_consume(h));
    assert(xyo_browser_pen_count(h) == 0);
    assert(xyo_browser_stop(h));
    assert(xyo_browser_destroy(h));
    bytes = project(true);
    const auto bad = xyo_browser_create(); assert(bad && xyo_browser_pen_enable(bad));
    assert(xyo_browser_load_sb3(bad, bytes.data(), bytes.size()));
    assert(xyo_browser_green_flag(bad));
    assert(!xyo_browser_step(bad));
    assert(xyo_browser_pen_count(bad) == -1);
    assert(std::string(xyo_browser_error(bad)).find("stamp") != std::string::npos);
    assert(!xyo_browser_pen_consume(bad));
    assert(xyo_browser_destroy(bad));
    bytes = cloneProject();
    const auto cloned = xyo_browser_create(); assert(cloned && xyo_browser_pen_enable(cloned));
    assert(xyo_browser_load_sb3(cloned, bytes.data(), bytes.size()));
    assert(xyo_browser_green_flag(cloned));
    for (int i = 0; i < 5 && xyo_browser_pen_count(cloned) < 2; ++i) assert(xyo_browser_step(cloned));
    assert(xyo_browser_pen_count(cloned) == 2);
    assert(xyo_browser_pen_kind(cloned, 0) == 1 && xyo_browser_pen_kind(cloned, 1) == 2);
    assert(std::abs(xyo_browser_pen_value(cloned, 1, 7) - 20) < 1e-8);
    assert(std::string(xyo_browser_snapshot(cloned)).find("\"isOriginal\":false") == std::string::npos);
    assert(xyo_browser_pen_consume(cloned));
    assert(xyo_browser_destroy(cloned));
    bytes = overflowProject();
    const auto full = xyo_browser_create(); assert(full && xyo_browser_pen_enable(full));
    assert(xyo_browser_load_sb3(full, bytes.data(), bytes.size()));
    assert(xyo_browser_green_flag(full));
    assert(!xyo_browser_step(full));
    assert(xyo_browser_pen_count(full) == -1);
    assert(std::string(xyo_browser_error(full)).find("overflow") != std::string::npos);
    assert(!xyo_browser_pen_kind(full, 0) && !xyo_browser_pen_consume(full));
    assert(xyo_browser_destroy(full));
    std::puts("pen ABI ok");
}
