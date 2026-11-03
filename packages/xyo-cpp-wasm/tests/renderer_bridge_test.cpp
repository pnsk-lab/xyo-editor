#include "renderer_bridge.hpp"
#include <cassert>
#include <cstring>
#include <iostream>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(int, js_pick_callback, (), {
    return addFunction((ctx, x, y) => {
        if (x !== 11 || y !== 12) throw new Error('bad JS arguments');
        return 123;
    }, 'iidd');
});
#endif
using namespace xyo;
using namespace xyo::wasm;
struct State { int calls = 0; int order[3] = {7, 3, 9}; };
int main(int argc, char** argv) {
    State s;
    RendererCallbacks c;
    c.ctx=&s;
    c.pick=[](void* p,double x,double y) { ++static_cast<State*>(p)->calls; assert(x==1 && y==2); return 42; };
    c.draw=[](void* p) { ++static_cast<State*>(p)->calls; };
    c.drawableTouching=[](void*,int id,double x,double y) { assert(id==5 && x==1 && y==2); return 1; };
    c.isTouchingDrawables=[](void*,int id,const int* a,size_t n) { assert(id==5 && n==2 && a[0]==3 && a[1]==4); return 0; };
    c.isTouchingColor=[](void*,int id,uint32_t color) { assert(id==5 && color==0xfedcba98u); return 1; };
    c.colorTouchingColor=[](void*,uint32_t a,uint32_t b,int id) { assert(a==0x112233 && b==0x445566 && id==5); return 1; };
    c.getDrawableBounds=[](void*,int id,double* b) { assert(id==5); b[0]=1;b[1]=2;b[2]=3;b[3]=4; };
    c.hasDrawable=[](void*,int id) { return id==5 ? 1 : 0; };
    c.getFencedPosition=[](void*,int id,double* x,double* y,int f) { assert(id==5 && *x==10 && *y==20 && f==1); *x=11;*y=21; };
    c.getCurrentSkinSize=[](void*,int id,double* w,double* h) { assert(id==5); *w=31;*h=32; };
    c.setDrawableOrder=[](void*,int id,double o,const char* g,int r) { assert(id==5 && o==2 && !std::strcmp(g,"sprite") && r==1); return 8.5; };
    c.destroyDrawable=[](void* p,int id) { assert(id==5); ++static_cast<State*>(p)->calls; };
    c.emitVisualChange=[](void* p,Target* t) { assert(t==nullptr); ++static_cast<State*>(p)->calls; };
    c.drawableOrder=[](void* p,size_t* n) -> const int* { *n=3; return static_cast<State*>(p)->order; };
    c.drawableOfTarget=[](void*,Target* t) { assert(!t); return 77; };
    c.createPenSkin=[](void*) { return -7; };
    c.penLine=[](void*,int s,const float* a,double d,double x0,double y0,double x1,double y1) { assert(s==6 && a[0]==.5f && a[3]==1 && d==2 && x0==3 && y0==4 && x1==5 && y1==6); };
    c.penPoint=[](void*,int s,const float* a,double d,double x,double y) { assert(s==6 && a[0]==.5f && d==2 && x==3 && y==4); };
    c.penClear=[](void* p,int s) { assert(s==6); ++static_cast<State*>(p)->calls; };
    c.penStamp=[](void* p,int s,int id) { assert(s==6 && id==5); ++static_cast<State*>(p)->calls; };
    c.getFenceRect=[](void*,int id,double* a) { assert(id==5); a[0]=-1;a[1]=2;a[2]=-3;a[3]=4; };
#define MISSING(field) do { auto bad=c; bad.field=nullptr; assert(!RendererBridge::create(bad)); } while (0)
    MISSING(pick); MISSING(draw); MISSING(drawableTouching); MISSING(isTouchingDrawables);
    MISSING(isTouchingColor); MISSING(colorTouchingColor); MISSING(getDrawableBounds); MISSING(hasDrawable);
    MISSING(getFencedPosition); MISSING(getCurrentSkinSize); MISSING(setDrawableOrder); MISSING(destroyDrawable);
    MISSING(emitVisualChange); MISSING(drawableOrder); MISSING(drawableOfTarget); MISSING(createPenSkin);
    MISSING(penLine); MISSING(penPoint); MISSING(penClear); MISSING(penStamp); MISSING(getFenceRect);
#undef MISSING
    if (argc > 1 && std::strcmp(argv[1], "invalid-order") == 0) {
        c.drawableOrder=[](void*,size_t* n) -> const int* { *n=1; return nullptr; };
        auto invalid=RendererBridge::create(c);
        invalid->drawableOrder(); // Must abort; returning an empty vector is not success.
        return 0;
    }
    auto empty=c;
    empty.drawableOrder=[](void*,size_t* n) -> const int* { *n=0; return nullptr; };
    assert(RendererBridge::create(empty)->drawableOrder().empty());
    auto bridge=RendererBridge::create(c); assert(bridge); RendererAPI& r=*bridge;
    assert(r.pick(1,2)==42); r.draw(); assert(r.drawableTouching(5,1,2));
    int ids[]={3,4}; assert(!r.isTouchingDrawables(5,ids,2)); assert(r.isTouchingColor(5,0xfedcba98u));
    assert(r.colorTouchingColor(0x112233,0x445566,5)); double b[4]; r.getDrawableBounds(5,b); assert(b[0]==1 && b[3]==4);
    assert(r.hasDrawable(5) && !r.hasDrawable(4)); double x=10,y=20; r.getFencedPosition(5,x,y,true); assert(x==11 && y==21);
    r.getCurrentSkinSize(5,x,y); assert(x==31 && y==32); assert(r.setDrawableOrder(5,2,"sprite",true)==8.5);
    r.destroyDrawable(5); r.emitVisualChange(nullptr); auto order=r.drawableOrder(); s.order[0]=100; assert(order.size()==3 && order[0]==7 && order[2]==9);
    assert(r.drawableOfTarget(nullptr)==77 && r.createPenSkin()==-7); float rgba[]={.5f,0,0,1};
    r.penLine(6,rgba,2,3,4,5,6); r.penPoint(6,rgba,2,3,4); r.penClear(6); r.penStamp(6,5);
    r.getFenceRect(5,b); assert(b[0]==-1 && b[1]==2 && b[2]==-3 && b[3]==4); assert(s.calls==6);
#ifdef __EMSCRIPTEN__
    auto js = c;
    js.pick = reinterpret_cast<decltype(js.pick)>(js_pick_callback());
    auto jsBridge = RendererBridge::create(js);
    assert(jsBridge && jsBridge->pick(11,12)==123);
#endif
    std::cout << "renderer bridge OK\n";
}
