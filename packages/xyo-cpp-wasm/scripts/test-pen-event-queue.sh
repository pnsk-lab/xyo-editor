#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$root/.work/pen-validation"
"${CXX:-c++}" -std=c++20 -Wall -Wextra -Werror -I"$root/src" \
  "$root/tests/pen_event_queue_test.cpp" -o "$root/.work/pen-validation/pen_event_queue_test"
"$root/.work/pen-validation/pen_event_queue_test"
