#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
clang++ -std=c++20 -fsanitize=address,undefined -Wall -Wextra \
  -Icpp/tests/transport -Initrogen/generated/shared/c++ -Icpp \
  cpp/tests/HybridEngineTests.cpp cpp/HybridNitroListEngine.cpp cpp/LayoutCore.cpp \
  -o /tmp/nitro-hybrid-engine-tests
/tmp/nitro-hybrid-engine-tests
