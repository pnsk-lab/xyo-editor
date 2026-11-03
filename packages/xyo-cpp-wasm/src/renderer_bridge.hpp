#pragma once
#include "engine/runtime.hpp"
#include <memory>

namespace xyo::wasm {
// All callbacks execute synchronously. ctx, arrays and strings are borrowed;
// callbacks must not retain transient pointers. Target* is an opaque identity:
// JS must not dereference or retain it, and it becomes invalid on destruction.
// Booleans use 0/1. drawableOrder returns a borrowed array valid until the next
// callback; the bridge copies it immediately. A zero count permits a null array.
// The host is responsible for keeping its renderer snapshot synchronized before
// invoking runtime operations; this bridge does not synthesize visual state.
struct RendererCallbacks {
    void* ctx = nullptr;
    int (*pick)(void*, double, double) = nullptr;
    void (*draw)(void*) = nullptr;
    int (*drawableTouching)(void*, int, double, double) = nullptr;
    int (*isTouchingDrawables)(void*, int, const int*, size_t) = nullptr;
    int (*isTouchingColor)(void*, int, uint32_t) = nullptr;
    int (*colorTouchingColor)(void*, uint32_t, uint32_t, int) = nullptr;
    void (*getDrawableBounds)(void*, int, double*) = nullptr; // left,right,top,bottom
    int (*hasDrawable)(void*, int) = nullptr;
    void (*getFencedPosition)(void*, int, double*, double*, int) = nullptr;
    void (*getCurrentSkinSize)(void*, int, double*, double*) = nullptr;
    double (*setDrawableOrder)(void*, int, double, const char*, int) = nullptr;
    void (*destroyDrawable)(void*, int) = nullptr;
    void (*emitVisualChange)(void*, Target*) = nullptr;
    const int* (*drawableOrder)(void*, size_t*) = nullptr;
    int (*drawableOfTarget)(void*, Target*) = nullptr;
    int (*createPenSkin)(void*) = nullptr;
    void (*penLine)(void*, int, const float*, double, double, double, double, double) = nullptr;
    void (*penPoint)(void*, int, const float*, double, double, double) = nullptr;
    void (*penClear)(void*, int) = nullptr;
    void (*penStamp)(void*, int, int) = nullptr;
    void (*getFenceRect)(void*, int, double*) = nullptr; // left,right,bottom,top
};

// Reject incomplete tables atomically; the copied table and ctx must outlive use.
// GPU execution is intentionally unsupported and inherits the false fallback.
class RendererBridge final : public RendererAPI {
public:
    static std::unique_ptr<RendererBridge> create(const RendererCallbacks& callbacks);
    int pick(double, double) override;
    void draw() override;
    bool drawableTouching(int, double, double) override;
    bool isTouchingDrawables(int, const int*, size_t) override;
    bool isTouchingColor(int, uint32_t) override;
    bool colorTouchingColor(uint32_t, uint32_t, int) override;
    void getDrawableBounds(int, double*) const override;
    bool hasDrawable(int) const override;
    void getFencedPosition(int, double&, double&, bool) const override;
    void getCurrentSkinSize(int, double&, double&) const override;
    double setDrawableOrder(int, double, const char*, bool) override;
    void destroyDrawable(int) override;
    void emitVisualChange(Target*) override;
    std::vector<int> drawableOrder() const override;
    int drawableOfTarget(Target*) const override;
    int createPenSkin() override;
    void penLine(int, const float[4], double, double, double, double, double) override;
    void penPoint(int, const float[4], double, double, double) override;
    void penClear(int) override;
    void penStamp(int, int) override;
    void getFenceRect(int, double[4]) const override;
private:
    explicit RendererBridge(const RendererCallbacks& callbacks) : c_(callbacks) {}
    RendererCallbacks c_;
};
}
