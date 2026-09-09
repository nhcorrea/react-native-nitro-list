#pragma once
#include <cstddef>
#include <memory>
namespace margelo::nitro {
// Host-test transport only. Production engine and generated abstract spec are compiled unchanged.
class HybridObject {
public:
  explicit HybridObject(const char*) {}
  virtual ~HybridObject() = default;
  virtual size_t getExternalMemorySize() noexcept { return 0; }
protected:
  virtual void loadHybridMethods() {}
};
}
