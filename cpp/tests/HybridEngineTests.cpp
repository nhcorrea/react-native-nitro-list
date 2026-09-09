#include "HybridNitroListEngine.hpp"
#include <cassert>
#include <cstring>
#include <iostream>
using namespace margelo::nitro;
using namespace margelo::nitro::nitrolist;
// Registration is the sole JSI behavior replaced by this host test.
void HybridNitroListEngineSpec::loadHybridMethods() {}
std::shared_ptr<ArrayBuffer> doubles(std::initializer_list<double> values) {
  auto out = std::make_shared<ArrayBuffer>(values.size() * sizeof(double));
  std::memcpy(out->data(), values.begin(), out->size());
  return out;
}
int main() {
  HybridNitroListEngine engine;
  auto empty = std::make_shared<ArrayBuffer>(0);
  engine.updateData(doubles({1,3,100,0,0,1,0,1,1,-1,-1,0,3,0,0,0,0}), empty, empty,
                    doubles({0,100,1,200,2,300}), empty);
  engine.setViewport(400,600);
  int notifications = 0;
  engine.setOnRangeChange([&](double, double, double, double) {
    ++notifications;
    // Callback reentrancy must not deadlock and must observe the final transaction.
    assert(engine.getTotalSize() > 0);
  });
  notifications = 0;
  engine.updateData(doubles({1,2,100,0,0,1,0,0,2,0,-1,0,0,2,0,0,0}), empty, empty,
                    empty, doubles({1,0,2,1}));
  assert(engine.getItemSize(0) == 200);
  assert(engine.getItemSize(1) == 300);
  assert(engine.getTotalSize() == 500);
  assert(notifications == 1);
  engine.updateData(doubles({1,8,100,0,0,1,0,0,1,0,-1,0,0,0,0,0,0}), empty, empty, empty, empty);
  assert(engine.getTotalSize() == 500); // obsolete data revision rejected
  notifications = 0;
  auto small = std::make_shared<ArrayBuffer>(12 * sizeof(double));
  // Spare capacity in a reusable pairs buffer must never be applied.
  auto batch = doubles({0, 250, 1, 999});
  assert(engine.setItemSizesAndFill(batch, 1, 1, 2, small) == -1);
  auto* header = reinterpret_cast<double*>(small->data());
  assert(header[4] == 1 && header[5] == 12 && header[9] == 50 && header[10] == -1);
  const double sequence = header[7];
  auto full = std::make_shared<ArrayBuffer>(static_cast<size_t>(header[11]) * sizeof(double));
  assert(engine.readSnapshot(sequence, full) == 2);
  auto* snapshot = reinterpret_cast<double*>(full->data());
  assert(snapshot[9] == 50 && snapshot[1] == 550 && snapshot[13] == 250 && snapshot[15] == 300);
  assert(engine.getItemSize(1) == 300 && notifications == 0);
  assert(engine.readSnapshot(sequence, full) == 2); // read retry does not mutate
  assert(engine.getTotalSize() == 550);
  assert(engine.setItemSizesAndFill(batch, 1, 1, 1, full) == -2);
  assert(engine.setItemSizesAndFill(batch, 1, 1, 2, full) == 2);
  assert(reinterpret_cast<double*>(full->data())[9] == 0);
  engine.setScrollOffsetAndFill(100, full);
  assert(engine.readSnapshot(sequence, full) == -2); // newer publication wins
  engine.setOnRangeChange(std::nullopt);
  engine.updateData(doubles({1,0,100,0,0,1,0,0,3,-1,-1,0,0,0,0,0,0}), empty, empty, empty, empty);
  assert(engine.fillLayoutSlab(full) == 0);
  assert(reinterpret_cast<double*>(full->data())[10] == 2); // valid empty is distinct
  std::cout << "Hybrid engine tests passed\n";
}
