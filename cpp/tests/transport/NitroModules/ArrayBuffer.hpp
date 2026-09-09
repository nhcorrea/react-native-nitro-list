#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>
namespace margelo::nitro {
class ArrayBuffer {
public:
  explicit ArrayBuffer(size_t bytes) : words_((bytes + 7) / 8), bytes_(bytes) {}
  size_t size() const { return bytes_; }
  uint8_t* data() { return reinterpret_cast<uint8_t*>(words_.data()); }
private:
  std::vector<double> words_;
  size_t bytes_;
};
}
