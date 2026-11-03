#include "pen_event_queue.hpp"
#include <cassert>
#include <limits>
#include <memory>

int main() {
    using Q = xyo::web::PenEventQueue;
    auto q = std::make_unique<Q>();
    float rgba[] = {0.25f, 0.5f, 0.75f, 1};
    q->point(rgba, 3, 1, 2);
    q->line(rgba, 4, 1, 2, 5, 6);
    q->clear();
    rgba[0] = 1;
    assert(q->size() == 3);
    assert(q->at(0)->kind == Q::Kind::point && q->at(0)->rgba[0] == 0.25f);
    assert(q->at(1)->kind == Q::Kind::line && q->at(1)->x1 == 5);
    assert(q->at(2)->kind == Q::Kind::clear && !q->at(3));
    q->consume();
    assert(q->size() == 0);
    q->clear();
    q->line(rgba, 1, 0, 0, 1, 1);
    assert(q->at(0)->kind == Q::Kind::clear && q->at(1)->kind == Q::Kind::line);
    q->consume();
    for (size_t i = 0; i < Q::capacity; ++i) q->clear();
    assert(q->size() == Q::capacity);
    q->clear();
    assert(q->failure() == Q::Failure::overflow && q->size() == 0 && !q->at(0));
    q->consume(); q->clear();
    assert(q->failure() == Q::Failure::overflow && q->size() == 0);
    auto invalid = std::make_unique<Q>();
    invalid->clear();
    invalid->point(rgba, 1, std::numeric_limits<double>::infinity(), 0);
    assert(invalid->failure() == Q::Failure::invalid && invalid->size() == 0);
    auto unsupported = std::make_unique<Q>();
    unsupported->clear(); unsupported->unsupported();
    assert(unsupported->failure() == Q::Failure::unsupported && unsupported->size() == 0);
    return 0;
}
