#pragma once
#include <cstddef>
#include <memory>
namespace margelo::nitro {
class HybridObject {
public:
  explicit HybridObject(const char*) {}
  virtual ~HybridObject() = default;
  virtual size_t getExternalMemorySize() noexcept { return 0; }
  virtual void dispose() {}
protected:
  virtual void loadHybridMethods() {}
};
}
