#include "HybridNitroListEngine.hpp"
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <thread>
using namespace margelo::nitro;
using namespace margelo::nitro::nitrolist;
void HybridNitroListEngineSpec::loadHybridMethods() {}
std::shared_ptr<ArrayBuffer> doubles(std::initializer_list<double> values) {
  auto out = std::make_shared<ArrayBuffer>(values.size() * sizeof(double));
  std::memcpy(out->data(), values.begin(), out->size());
  return out;
}
static std::shared_ptr<ArrayBuffer> config(double count, double revision, double reset) {
  return doubles({1, count, 100, 0, 0, 1, 0, reset, revision, -1, -1, 0, 0, 0, 0, 0, 0});
}

static void testLazyTypeMeansConfig() {
  HybridNitroListEngine eager, lazy;
  auto empty = std::make_shared<ArrayBuffer>(0);
  eager.updateData(doubles({1,1000,100,0,0,1,0,1,1,-1,-1,0,0,0,0,0,0,0}), empty, empty, empty, empty);
  lazy.updateData(doubles({1,1000,100,0,0,1,0,1,1,-1,-1,0,0,0,0,0,0,1}), empty, empty, empty, empty);
  for (int i = 0; i < 50; ++i) {
    eager.setItemSize(i, 130 + i); lazy.setItemSize(i, 130 + i);
    assert(eager.getItemSize(999) == lazy.getItemSize(999));
    assert(eager.getTotalSize() == lazy.getTotalSize());
    assert(eager.getItemOffset(999) == lazy.getItemOffset(999));
  }
  lazy.updateData(doubles({1,1000,100,0,0,1,0,0,2,-1,-1,0,0,0,0,0,0,0}), empty, empty, empty, empty);
  eager.setItemSize(60, 200); lazy.setItemSize(60, 200);
  assert(eager.getTotalSize() == lazy.getTotalSize());
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

static void testScrollDirectionBiasesBuffers() {
  HybridNitroListEngine engine;
  auto empty = std::make_shared<ArrayBuffer>(0);
  engine.updateData(doubles({1, 10000, 100, 400, 0, 1, 0, 1, 1, -1, -1, 0, 0, 0, 0, 0, 0}), empty, empty, empty, empty);
  engine.setViewport(400, 600);
  double start = -1, end = -1;
  engine.setOnRangeChange([&](double s, double e, double, double) {
    start = s;
    end = e;
  });
  for (int k = 1; k <= 6; k++) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    engine.setScrollOffset(20000 + k * 100);
  }
  const double top = 20600 / 100.0, bottom = (20600 + 600) / 100.0;
  assert(start >= 0 && end > start);
  assert(end - bottom > top - start);
}

static std::shared_ptr<ArrayBuffer> feedConfig(double estimate, double drawDistance) {
  return doubles({1, 10000, estimate, drawDistance, 0, 1, 0, 1, 1, -1, -1, 0, 0, 0, 0, 0, 0});
}

static void testNonFiniteScrollAndViewportAreIgnored() {
  HybridNitroListEngine engine;
  auto empty = std::make_shared<ArrayBuffer>(0);
  engine.updateData(feedConfig(100, 250), empty, empty, empty, empty);
  engine.setViewport(400, 600);
  engine.setScrollOffset(50000);
  auto slab = std::make_shared<ArrayBuffer>(64 * sizeof(double));
  auto* h = reinterpret_cast<double*>(slab->data());
  assert(engine.fillLayoutSlab(slab) == 12 && h[2] == 497 && h[3] == 508);
  const size_t memory = engine.getExternalMemorySize();
  const double nan = std::nan(""), inf = INFINITY;
  for (double bad : {nan, inf, -inf}) {
    engine.setScrollOffset(bad);
    assert(engine.setScrollOffsetAndFill(bad, slab) == -2);
    engine.setViewport(400, bad);
    engine.setViewport(bad, 600);
    assert(engine.fillLayoutSlab(slab) == 12 && h[2] == 497 && h[3] == 508 && h[8] == 50000);
  }
  assert(engine.getExternalMemorySize() == memory);
}

static double rangeStart(HybridNitroListEngine& engine, double* end) {
  auto slab = std::make_shared<ArrayBuffer>(256 * sizeof(double));
  auto* h = reinterpret_cast<double*>(slab->data());
  assert(engine.fillLayoutSlab(slab) > 0);
  *end = h[3];
  return h[2];
}

static void testDataConfigClampsNegativeEstimateAndDraw() {
  auto empty = std::make_shared<ArrayBuffer>(0);
  HybridNitroListEngine negativeEstimate;
  negativeEstimate.updateData(feedConfig(-50, 0), empty, empty, empty, empty);
  assert(negativeEstimate.getTotalSize() >= 0);
  assert(negativeEstimate.getItemOffset(1) >= negativeEstimate.getItemOffset(0));
  HybridNitroListEngine zeroDraw, negativeDraw;
  zeroDraw.updateData(feedConfig(100, 0), empty, empty, empty, empty);
  negativeDraw.updateData(feedConfig(100, -1000), empty, empty, empty, empty);
  for (HybridNitroListEngine* engine : {&zeroDraw, &negativeDraw}) {
    engine->setViewport(400, 600);
    engine->setScrollOffset(50000);
  }
  double zeroEnd = 0, negativeEnd = 0;
  const double zeroStart = rangeStart(zeroDraw, &zeroEnd);
  const double negativeStart = rangeStart(negativeDraw, &negativeEnd);
  assert(zeroStart == negativeStart && zeroEnd == negativeEnd);
  HybridNitroListEngine configured;
  configured.configure(10, 100, 0, false, 1, 0);
  configured.configure(20, std::nan(""), std::nan(""), false, 1, 0);
  assert(configured.getTotalSize() == 1000);
  configured.configure(20, -50, -10, false, 1, 0);
  assert(std::isfinite(configured.getTotalSize()) && configured.getTotalSize() >= 0);
}

static void testNonFiniteIndicesDoNotAliasItemZero() {
  HybridNitroListEngine engine;
  auto empty = std::make_shared<ArrayBuffer>(0);
  engine.updateData(doubles({1, 10, 100, 0, 0, 1, 0, 1, 1, -1, -1, 0, 0, 0, 0, 0, 0}), empty, empty, empty, empty);
  engine.setItemSize(0, 333);
  const double nan = std::nan(""), inf = INFINITY;
  engine.setItemSize(nan, 777);
  engine.setItemSize(inf, 777);
  engine.setItemSize(-inf, 777);
  assert(engine.getItemSize(0) == 333);
  assert(engine.getItemSize(nan) == 0 && engine.getItemSize(inf) == 0 && engine.getItemSize(-inf) == 0);
  assert(engine.countUnmeasured(0, inf) == 9);
  auto before = std::make_shared<ArrayBuffer>(64 * sizeof(double));
  auto after = std::make_shared<ArrayBuffer>(64 * sizeof(double));
  std::memset(before->data(), 0, before->size());
  std::memset(after->data(), 0, after->size());
  engine.fillTypeStats(before);
  auto types = std::make_shared<ArrayBuffer>(4 * sizeof(uint16_t));
  auto* t = reinterpret_cast<uint16_t*>(types->data());
  for (int k = 0; k < 4; k++) t[k] = 7;
  engine.setItemTypesRange(nan, types);
  engine.fillTypeStats(after);
  assert(std::memcmp(before->data(), after->data(), before->size()) == 0);
}

static void testSlotPoolAndEngineRegistryNativeFlow() {
  HybridNitroListEngine engine;
  const int64_t id = static_cast<int64_t>(engine.getEngineId());
  assert(id > 0);
  auto state = EngineRegistry::instance().find(id);
  assert(state != nullptr);

  auto empty = std::make_shared<ArrayBuffer>(0);
  engine.updateData(doubles({1, 200, 100, 200, 0, 1, 0, 1, 1, -1, -1, 0, 0, 0, 0, 0, 0}),
                    empty, empty, empty, empty);
  engine.setViewport(400, 500);
  engine.configureSlots(6, 0, 0);

  // Set sticky headers at indices 0, 5, 10
  auto stickyBuf = std::make_shared<ArrayBuffer>(3 * sizeof(int32_t));
  auto* stickyPtr = reinterpret_cast<int32_t*>(stickyBuf->data());
  stickyPtr[0] = 0; stickyPtr[1] = 5; stickyPtr[2] = 10;
  engine.setStickyConfig(stickyBuf, 0, 50);

  // 1. Initial scroll at offset 0 -> unusedTop (200) shifts to bottomBuffer (400), covering [0..8] (9 items)
  std::vector<SlotDelta> deltas;
  auto step1 = state->onNativeScroll(0.0, 0.0, 0, true, deltas);
  assert(step1.changed);
  assert(step1.rangeStart == 0 && step1.rangeEnd == 8);
  assert(step1.deltaCount == 9);
  assert(step1.slotCount == 9);
  assert(step1.stickyIndex == 0 && std::abs(step1.stickyTranslateYDp) < 1e-6);

  // Simulate native mount committing those 9 generations.
  for (const auto& d : deltas) {
    state->markSlotCommitted(d.slotId, d.generation);
  }

  // 2. Scroll 10dp (same engaged range) -> ZERO slot deltas!
  auto step2 = state->onNativeScroll(10.0, 100.0, 0, true, deltas);
  assert(step2.deltaCount == 0);
  assert(step2.slotCount == 9);

  // 3. Scroll down to offset 460dp -> sticky 0 is pushed upward by sticky 5 (at 500dp)!
  // pushTop = 500 - 460 - 50 = -10dp
  auto step3 = state->onNativeScroll(460.0, 0.0, 0, true, deltas);
  assert(step3.stickyIndex == 0 && std::abs(step3.stickyTranslateYDp - (-10.0)) < 1e-6);

  // 4. Scroll to offset 520dp -> active sticky switches to index 5!
  auto step4 = state->onNativeScroll(520.0, 0.0, 0, true, deltas);
  assert(step4.stickyIndex == 5 && std::abs(step4.stickyTranslateYDp) < 1e-6);

  // 5. Commit new generations, then test stale-generation measurement race guard!
  for (const auto& d : deltas) {
    if ((d.flags & SlotDelta::kFlagActive) != 0) {
      state->markSlotCommitted(d.slotId, d.generation);
    }
  }
  // Scroll far down (offset 5000) with frame budget = 3 slots!
  auto stepBudget = state->onNativeScroll(5000.0, 6000.0, 3, false, deltas);
  assert(stepBudget.hasMorePending);
  int activeAssigned = 0;
  int32_t testedSlotId = -1;
  uint32_t expectedGen = 0;
  for (const auto& d : deltas) {
    if ((d.flags & SlotDelta::kFlagActive) != 0) {
      ++activeAssigned;
      testedSlotId = d.slotId;
      expectedGen = d.generation;
    }
  }
  assert(activeAssigned == 3);
  assert(testedSlotId >= 0);

  // Stale generation (expectedGen - 1) MUST be ignored by onNativeSlotSizes!
  const int32_t sIds[1] = {testedSlotId};
  const double badSizes[1] = {333.0};
  const uint32_t staleGens[1] = {expectedGen > 1 ? expectedGen - 1 : 0};
  auto staleRes = state->onNativeSlotSizes(sIds, badSizes, staleGens, 1, false);
  assert(!staleRes.changed);

  // Matching generation MUST be applied!
  const double goodSizes[1] = {150.0};
  const uint32_t goodGens[1] = {expectedGen};
  auto goodRes = state->onNativeSlotSizes(sIds, goodSizes, goodGens, 1, false);
  assert(goodRes.changed);

  // 6. Test MVCP anchor delta on native size change above anchor!
  auto stepAll = state->onNativeScroll(5000.0, 0.0, 0, false, deltas);
  for (const auto& d : deltas) {
    if ((d.flags & SlotDelta::kFlagActive) != 0) state->markSlotCommitted(d.slotId, d.generation);
  }
  engine.setMvcpConfig(true, stepAll.rangeEnd);
  // Find slot for rangeStart (< anchor)
  int32_t startSlot = -1;
  uint32_t startGen = 0;
  const auto& slots = state->slotPool.slots();
  for (int32_t s = 0; s < static_cast<int32_t>(slots.size()); ++s) {
    if (slots[static_cast<size_t>(s)].active && slots[static_cast<size_t>(s)].itemIndex == stepAll.rangeStart) {
      startSlot = s;
      startGen = slots[static_cast<size_t>(s)].generation;
      break;
    }
  }
  assert(startSlot >= 0);
  const int32_t mvcpIds[1] = {startSlot};
  const double mvcpSizes[1] = {250.0};
  const uint32_t mvcpGens[1] = {startGen};
  auto mvcpRes = state->onNativeSlotSizes(mvcpIds, mvcpSizes, mvcpGens, 1, true);
  assert(mvcpRes.changed);
  assert(mvcpRes.mvcpDeltaDp > 50.0);

  // 7. Test readSlotTransforms + atomic pendingExternalMvcpShiftDp on prepend remap & unfreeze
  double offsetsOut[64];
  int32_t metaOut[64 * 3];
  double totalOut = 0.0;
  int32_t stickyOut = -1;
  double stickyTransOut = 0.0;
  double pendingShiftOut = 0.0;
  int32_t nTrans = state->readSlotTransforms(
      offsetsOut, metaOut, 64, totalOut, stickyOut, stickyTransOut, &pendingShiftOut);
  assert(nTrans == state->slotPool.slotCount() && totalOut > 0.0 && pendingShiftOut == 0.0);

  // Prepend 5 items via remap while MVCP is enabled: C++ must atomically queue exact anchor offset shift!
  const int32_t prevAnchor = stepAll.rangeEnd;
  const double anchorOffsetBefore = engine.getItemOffset(prevAnchor);
  const int32_t oldCount = state->itemCount;
  auto remapBuf = std::make_shared<ArrayBuffer>(static_cast<size_t>(oldCount) * 2 * sizeof(double));
  auto* remapPtr = reinterpret_cast<double*>(remapBuf->data());
  for (int32_t i = 0; i < oldCount; ++i) {
    remapPtr[i * 2] = static_cast<double>(i);
    remapPtr[i * 2 + 1] = static_cast<double>(i + 5);
  }
  engine.updateData(
      doubles({1, static_cast<double>(oldCount + 5), 100, 200, 0, 1, 0, 0, 2, -1, -1, 0, 0,
               static_cast<double>(oldCount), 0, 0, 0}),
      empty, empty, empty, remapBuf);
  const double expectedShift = engine.getItemOffset(prevAnchor + 5) - anchorOffsetBefore;
  nTrans = state->readSlotTransforms(
      offsetsOut, metaOut, 64, totalOut, stickyOut, stickyTransOut, &pendingShiftOut);
  assert(expectedShift > 200.0 && std::abs(pendingShiftOut - expectedShift) < 0.01);
  // Second read must see pendingShift drained to 0!
  nTrans = state->readSlotTransforms(
      offsetsOut, metaOut, 64, totalOut, stickyOut, stickyTransOut, &pendingShiftOut);
  assert(pendingShiftOut == 0.0);

  // Adaptive jsLatencyMs: slow JS (80ms) must widen lookahead & refill instead of lazy-skipping.
  auto slowRes = state->onNativeScroll(1500.0, 5000.0, 0, false, deltas, 80.0);
  assert(slowRes.rangeEnd > slowRes.rangeStart);

  auto outDeltas = std::make_shared<ArrayBuffer>(128 * sizeof(int32_t));
  double recCount = engine.reconcileSlots(empty, 0, outDeltas);
  assert(recCount >= 0);
  assert(!state->isJsPrewarmActive());

  // Prewarm reconcile with pinned target index must mark jsPrewarmActive, suppress MVCP shift on
  // setEstimatesFrozen(false), and reuse committed window cleanly when onNativeScroll lands there!
  engine.setEstimatesFrozen(true);
  const double targetOff = engine.getItemOffset(150);
  engine.setScrollOffset(targetOff);
  auto extraBuf = std::make_shared<ArrayBuffer>(sizeof(int32_t));
  *reinterpret_cast<int32_t*>(extraBuf->data()) = 150;
  double prewarmCount = engine.reconcileSlots(extraBuf, 0, outDeltas);
  assert(prewarmCount >= 0 && state->isJsPrewarmActive());
  engine.setEstimatesFrozen(false);
  nTrans = state->readSlotTransforms(
      offsetsOut, metaOut, 64, totalOut, stickyOut, stickyTransOut, &pendingShiftOut);
  assert(pendingShiftOut == 0.0);
  auto landedRes = state->onNativeScroll(targetOff, 0.0, 0, false, deltas, 0.0);
  assert(!state->isJsPrewarmActive() && landedRes.deltaCount == 0);

  // 8. Dispose unregisters from EngineRegistry cleanly and zeroes external memory
  engine.dispose();
  assert(EngineRegistry::instance().find(id) == nullptr);
  assert(engine.getExternalMemorySize() == 0);
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
  assert(engine.getTotalSize() == 500);
  notifications = 0;
  auto small = std::make_shared<ArrayBuffer>(12 * sizeof(double));
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
  assert(engine.readSnapshot(sequence, full) == 2);
  assert(engine.getTotalSize() == 550);
  assert(engine.setItemSizesAndFill(batch, 1, 1, 1, full) == -2);
  assert(engine.setItemSizesAndFill(batch, 1, 1, 2, full) == 2);
  assert(reinterpret_cast<double*>(full->data())[9] == 0);
  engine.setScrollOffsetAndFill(100, full);
  assert(engine.readSnapshot(sequence, full) == -2);
  engine.setOnRangeChange(std::nullopt);
  engine.updateData(doubles({1,0,100,0,0,1,0,0,3,-1,-1,0,0,0,0,0,0}), empty, empty, empty, empty);
  assert(engine.fillLayoutSlab(full) == 0);
  assert(reinterpret_cast<double*>(full->data())[10] == 2);
  testLazyTypeMeansConfig();
  testDisposeReleasesMemory();
  testPendingSnapshotReleasedByNextPublication();
  testScrollDirectionBiasesBuffers();
  testNonFiniteScrollAndViewportAreIgnored();
  testDataConfigClampsNegativeEstimateAndDraw();
  testNonFiniteIndicesDoNotAliasItemZero();
  testSlotPoolAndEngineRegistryNativeFlow();
  std::cout << "Hybrid engine tests passed\n";
}
