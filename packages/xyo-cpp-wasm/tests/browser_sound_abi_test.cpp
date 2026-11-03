#include "browser.h"
#include "browser_sound_bridge.hpp"
#include "load/zip.hpp"
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

static uint32_t handle, generation, lo, hi;
static int starts, stops;
static bool failStart;
static int start(uint32_t, uint32_t gen, uint32_t l, uint32_t h,
                 const char*, size_t, const uint8_t*, size_t, const char*, size_t, double) {
    assert(xyo_browser_destroy(handle) == 0);
    assert(xyo_browser_create() == 0);
    ++starts; generation = gen; lo = l; hi = h;
    return !failStart;
}
static void stop(uint32_t, uint32_t, uint32_t, uint32_t) {
    assert(xyo_browser_destroy(handle) == 0);
    ++stops;
}
static std::vector<uint8_t> project() {
    std::string json = R"({"targets":[{"isStage":true,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"blocks":{"hat":{"opcode":"event_whenflagclicked","topLevel":true,"next":"sound","inputs":{},"fields":{}},"sound":{"opcode":"sound_playuntildone","next":"set","inputs":{"SOUND_MENU":[1,[10,"beep"]]},"fields":{}},"set":{"opcode":"data_setvariableto","next":null,"inputs":{"VALUE":[1,[4,1]]},"fields":{"VARIABLE":["v","v"]}}},"costumes":[],"sounds":[{"name":"beep","assetId":"beep","dataFormat":"wav","md5ext":"beep.wav"}],"currentCostume":0}],"monitors":[],"extensions":[],"meta":{}})";
    xyo::ZipWriter z; z.addFile("project.json", {json.begin(), json.end()});
    z.addFile("beep.wav", {1,2,3}); return z.finish();
}
static void flagStep() { assert(xyo_browser_green_flag(handle)); assert(xyo_browser_step(handle)); }
int main() {
    auto bytes = project();
    handle = xyo_browser_create(); assert(handle);
    xyo::web::BrowserSoundCallbacks table{0, start, stop};
    assert(xyo_browser_sound_attach(handle, &table, sizeof(table)));
    assert(xyo_browser_load_sb3(handle, bytes.data(), bytes.size()));
    assert(xyo_browser_set_compiled(handle, 1));
    flagStep(); assert(starts == 1);
    auto oldGen = generation, oldLo = lo, oldHi = hi;
    assert(!xyo_browser_sound_detach(handle));
    assert(xyo_browser_sound_complete(handle, generation, lo, hi));
    assert(xyo_browser_step(handle)); assert(xyo_browser_step(handle));
    assert(std::string(xyo_browser_snapshot(handle)).find("\"value\":1") != std::string::npos);
    flagStep(); assert(starts == 2);
    assert(xyo_browser_stop(handle)); assert(stops == 1);
    assert(xyo_browser_sound_complete(handle, generation, lo, hi));
    flagStep(); assert(starts == 3);
    assert(xyo_browser_sound_complete(handle, oldGen, oldLo, oldHi));
    assert(xyo_browser_step(handle));
    assert(std::string(xyo_browser_snapshot(handle)).find("\"threadCount\":1") != std::string::npos);
    const uint8_t invalid[] = {1, 2, 3};
    assert(!xyo_browser_load_sb3(handle, invalid, sizeof(invalid)));
    assert(stops == 1); // failed replacement preserves the running voice
    auto genBeforeLoad = generation;
    assert(xyo_browser_load_sb3(handle, bytes.data(), bytes.size()));
    assert(stops == 2);
    assert(!xyo_browser_sound_complete(handle, genBeforeLoad, lo, hi));
    flagStep(); assert(starts == 4 && generation != genBeforeLoad);
    assert(!xyo_browser_sound_complete(handle, oldGen, oldLo, oldHi));
    assert(xyo_browser_destroy(handle)); assert(stops == 3);
    assert(!xyo_browser_sound_complete(handle, generation, lo, hi));
    handle = xyo_browser_create();
    failStart = true;
    assert(xyo_browser_sound_attach(handle, &table, sizeof(table)));
    assert(xyo_browser_load_sb3(handle, bytes.data(), bytes.size()));
    flagStep(); assert(xyo_browser_step(handle));
    assert(std::string(xyo_browser_snapshot(handle)).find("\"value\":1") != std::string::npos);
    assert(xyo_browser_destroy(handle));
    std::puts("browser sound ABI tests passed");
}
