#include "engine/runtime.hpp"
#include "model/target.hpp"
#include <cassert>
#include <memory>
#include <string>
#include <vector>

struct Event { int kind; std::string id; double x; bool original; };
static void observe(void* ctx, int kind, xyo::Target* t) {
    static_cast<std::vector<Event>*>(ctx)->push_back({kind, t->id, t->x, t->isOriginal});
}
struct Renderer : xyo::RendererAPI {
    std::vector<int> destroyed;
    void destroyDrawable(int id) override { destroyed.push_back(id); }
};
int main() {
    Renderer renderer;
    std::vector<Event> events;
    std::string originalId, firstId, secondId;
    {
        xyo::Runtime runtime;
        runtime.renderer = &renderer;
        runtime.targetLifecycleObserver = observe;
        runtime.targetLifecycleContext = &events;
        auto sprite = std::make_unique<xyo::Sprite>(&runtime);
        auto* original = sprite->createClone();
        original->x = 37;
        originalId = original->id;
        runtime.ownedSprites.push_back(std::move(sprite));
        runtime.addTarget(original);
        auto* first = original->makeClone();
        assert(first && !first->isOriginal);
        firstId = first->id;
        assert(events.size() == 1 && events[0].kind == 1 && events[0].id == firstId);
        assert(events[0].x == 37 && !events[0].original);
        first->drawableID = 10;
        runtime.addTarget(first);
        runtime.disposeTarget(first);
        assert(renderer.destroyed.size() == 1 && renderer.destroyed[0] == 10);
        assert(events.size() == 2 && events[1].kind == 2 && events[1].id == firstId);
        auto* second = original->makeClone();
        assert(second); secondId = second->id;
        second->drawableID = 11;
        runtime.addTarget(second);
        runtime.stopAll();
        assert(renderer.destroyed.size() == 2 && renderer.destroyed[1] == 11);
        assert(events.size() == 4 && events[2].kind == 1 && events[2].id == secondId);
        assert(events[3].kind == 2 && events[3].id == secondId);
    }
    assert(events.size() == 5 && events[4].kind == 2 && events[4].id == originalId);
}
