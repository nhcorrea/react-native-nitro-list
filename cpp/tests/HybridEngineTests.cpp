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
static std::shared_ptr<ArrayBuffer> config(double count, double revision, double reset) {
  return doubles({1, count, 100, 0, 0, 1, 0, reset, revision, -1, -1, 0, 0, 0, 0, 0, 0});
}

static void testDisposeReleasesMemory() {
  HybridNitroListEngine engine;
  auto empty = std::make_shared<ArrayBuffer>(0);
  engine.updateData(config(100000, 1, 1), empty, empty, empty, empty);
  engine.setViewport(400, 600);
  int notifications = 0;
  engine.setOnRangeChange([&](double, double, double, double) { ++notifications; });
  assert(engine.getExternalMemorySize() >= 100000 * (sizeof(float) + sizeof(double)));
  engine.dispose();
  assert(engine.getExternalMemorySize() == 0);
  assert(!engine.getOnRangeChange().has_value());
  notifications = 0;
  engine.setScrollOffset(5000);
  assert(notifications == 0);
  auto slab = std::make_shared<ArrayBuffer>(64 * sizeof(double));
  assert(engine.fillLayoutSlab(slab) == 0);
  assert(engine.getTotalSize() == 0);
}

static void testPendingSnapshotReleasedByNextPublication() {
  HybridNitroListEngine engine;
  auto empty = std::make_shared<ArrayBuffer>(0);
  engine.updateData(config(1000, 1, 1), empty, empty, empty, empty);
  engine.setViewport(400, 20000);
  const size_t base = engine.getExternalMemorySize();
  auto small = std::make_shared<ArrayBuffer>(12 * sizeof(double));
  assert(engine.fillLayoutSlab(small) == -1);
  const double required = reinterpret_cast<double*>(small->data())[11];
  assert(engine.getExternalMemorySize() >= base + static_cast<size_t>(required) * sizeof(double));
  auto full = std::make_shared<ArrayBuffer>(static_cast<size_t>(required) * sizeof(double));
  const double sequence = reinterpret_cast<double*>(small->data())[7];
  assert(engine.readSnapshot(sequence, full) > 0);
  assert(engine.readSnapshot(sequence, full) > 0);
  assert(engine.fillLayoutSlab(full) > 0);
  assert(engine.getExternalMemorySize() == base);
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
  engine.updateData(doubles({1,2,100,0,0,1,0,0,2,-1,-1,0,0,2,0,0,0}), empty, empty,
                    empty, doubles({1,0,0,1,0,0,0,1}));
  assert(engine.getItemSize(0) == 300 && engine.getItemSize(1) == 200);
  engine.updateData(doubles({1,2,100,0,0,1,0,0,2,-1,-1,0,0,2,0,0,0}), empty, empty,
                    empty, doubles({1,0,0,1,1,1,1,1}));
  assert(engine.getItemSize(0) == 200 && engine.getItemSize(1) == 300);
  engine.updateData(doubles({1,2,100,0,0,1,0,0,2,-1,-1,0,0,0,0,0,0}), empty, empty,
                    empty, doubles({1,0,0,1}));
  assert(engine.getItemSize(0) == 200 && engine.getItemSize(1) == 300);
  engine.updateData(doubles({1,2,100,0,0,1,0,0,2,-1,-1,0,0,3,0,0,0}), empty, empty,
                    empty, doubles({1,0,0,1}));
  assert(engine.getItemSize(0) == 200 && engine.getItemSize(1) == 300);
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
  auto layout = std::make_shared<ArrayBuffer>(12 * sizeof(double));
  assert(engine.readLayout(0, 2, layout) == 2);
  auto* read = reinterpret_cast<double*>(layout->data());
  assert(read[0] == 1 && read[1] == 8 && read[2] == 2 && read[3] == 12);
  assert(read[5] == 550 && read[6] == 0 && read[7] == 2);
  assert(read[8] == 0 && read[9] == 250 && read[10] == 250 && read[11] == 300);
  auto tiny = std::make_shared<ArrayBuffer>(9 * sizeof(double));
  assert(engine.readLayout(0, 2, tiny) == -1 && reinterpret_cast<double*>(tiny->data())[3] == 12);
  assert(engine.readLayout(0.5, 1, layout) == -2 && engine.readLayout(0, -1, layout) == -2);
  assert(engine.readLayout(0, 1, std::make_shared<ArrayBuffer>(7 * sizeof(double))) == -2);
  assert(engine.readLayout(5, 1, layout) == 0 && read[7] == 0);
  assert(notifications == 0);
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
  testDisposeReleasesMemory();
  testPendingSnapshotReleasedByNextPublication();
  std::cout << "Hybrid engine tests passed\n";
}
