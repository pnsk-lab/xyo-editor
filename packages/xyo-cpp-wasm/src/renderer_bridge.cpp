#include "renderer_bridge.hpp"
#include <cstdio>
#include <cstdlib>

namespace xyo::wasm {
std::unique_ptr<RendererBridge> RendererBridge::create(const RendererCallbacks& c) {
    if (!c.pick || !c.draw || !c.drawableTouching || !c.isTouchingDrawables ||
        !c.isTouchingColor || !c.colorTouchingColor || !c.getDrawableBounds ||
        !c.hasDrawable || !c.getFencedPosition || !c.getCurrentSkinSize ||
        !c.setDrawableOrder || !c.destroyDrawable || !c.emitVisualChange ||
        !c.drawableOrder || !c.drawableOfTarget || !c.createPenSkin ||
        !c.penLine || !c.penPoint || !c.penClear || !c.penStamp || !c.getFenceRect)
        return nullptr;
    return std::unique_ptr<RendererBridge>(new RendererBridge(c));
}
int RendererBridge::pick(double x, double y) { return c_.pick(c_.ctx,x,y); }
void RendererBridge::draw() { c_.draw(c_.ctx); }
bool RendererBridge::drawableTouching(int id,double x,double y) { return c_.drawableTouching(c_.ctx,id,x,y) != 0; }
bool RendererBridge::isTouchingDrawables(int id,const int* ids,size_t n) { return c_.isTouchingDrawables(c_.ctx,id,ids,n) != 0; }
bool RendererBridge::isTouchingColor(int id,uint32_t color) { return c_.isTouchingColor(c_.ctx,id,color) != 0; }
bool RendererBridge::colorTouchingColor(uint32_t a,uint32_t b,int id) { return c_.colorTouchingColor(c_.ctx,a,b,id) != 0; }
void RendererBridge::getDrawableBounds(int id,double* b) const { c_.getDrawableBounds(c_.ctx,id,b); }
bool RendererBridge::hasDrawable(int id) const { return c_.hasDrawable(c_.ctx,id) != 0; }
void RendererBridge::getFencedPosition(int id,double& x,double& y,bool f) const { c_.getFencedPosition(c_.ctx,id,&x,&y,f); }
void RendererBridge::getCurrentSkinSize(int id,double& w,double& h) const { c_.getCurrentSkinSize(c_.ctx,id,&w,&h); }
double RendererBridge::setDrawableOrder(int id,double order,const char* group,bool relative) { return c_.setDrawableOrder(c_.ctx,id,order,group,relative); }
void RendererBridge::destroyDrawable(int id) { c_.destroyDrawable(c_.ctx,id); }
void RendererBridge::emitVisualChange(Target* target) { c_.emitVisualChange(c_.ctx,target); }
std::vector<int> RendererBridge::drawableOrder() const {
    size_t n = 0;
    const int* p = c_.drawableOrder(c_.ctx,&n);
    if (!n) return {};
    if (!p) {
        std::fputs("renderer drawableOrder returned null with nonzero size\n", stderr);
        std::abort();
    }
    return {p,p+n};
}
int RendererBridge::drawableOfTarget(Target* target) const { return c_.drawableOfTarget(c_.ctx,target); }
int RendererBridge::createPenSkin() { return c_.createPenSkin(c_.ctx); }
void RendererBridge::penLine(int s,const float rgba[4],double d,double x0,double y0,double x1,double y1) { c_.penLine(c_.ctx,s,rgba,d,x0,y0,x1,y1); }
void RendererBridge::penPoint(int s,const float rgba[4],double d,double x,double y) { c_.penPoint(c_.ctx,s,rgba,d,x,y); }
void RendererBridge::penClear(int s) { c_.penClear(c_.ctx,s); }
void RendererBridge::penStamp(int s,int id) { c_.penStamp(c_.ctx,s,id); }
void RendererBridge::getFenceRect(int id,double out[4]) const { c_.getFenceRect(c_.ctx,id,out); }
}
