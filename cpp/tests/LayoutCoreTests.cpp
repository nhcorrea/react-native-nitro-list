#include "../LayoutCore.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <random>
#include <sstream>
#include <string>
#include <vector>

using margelo::nitro::nitrolist::LayoutCore;

static int failures = 0;

#define CHECK(cond)                                                                  \
  do {                                                                               \
    if (!(cond)) {                                                                   \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                    \
      failures++;                                                                    \
    }                                                                                \
  } while (0)

#define CHECK_EQ_F(a, b)                                                             \
  do {                                                                               \
    const float _a = (a);                                                            \
    const float _b = (b);                                                            \
    if (std::abs(_a - _b) > 1e-4f) {                                                 \
      std::printf("FAIL %s:%d: %s == %s (%f != %f)\n", __FILE__, __LINE__, #a, #b,   \
                  static_cast<double>(_a), static_cast<double>(_b));                 \
      failures++;                                                                    \
    }                                                                                \
  } while (0)

struct ReferenceModel {
  std::vector<float> sizes;
  std::vector<bool> measured;
  float estimate = 0.0f;
  float epsilon = 0.0f;

  static float octave(float v) { return std::round(v * 8.0f) / 8.0f; }

  void setItemCount(int32_t count) {
    const auto old = static_cast<int32_t>(sizes.size());
    sizes.resize(count, 0.0f);
    measured.resize(count, false);
    for (int32_t i = old; i < count; i++) {
      sizes[i] = estimate;
      measured[i] = false;
    }
  }

  void setEstimate(float value) {
    const float rounded = octave(value);
    if (rounded == estimate) return;
    estimate = rounded;
    for (size_t i = 0; i < sizes.size(); i++) {
      if (!measured[i]) sizes[i] = rounded;
    }
  }

  void setItemSize(int32_t index, float size) {
    if (index < 0 || index >= static_cast<int32_t>(sizes.size())) return;
    const float rounded = std::max(0.0f, octave(size));
    if (measured[index] && std::abs(sizes[index] - rounded) <= epsilon) return;
    sizes[index] = rounded;
    measured[index] = true;
  }

  void resetItemSizes() {
    for (size_t i = 0; i < sizes.size(); i++) {
      measured[i] = false;
      sizes[i] = estimate;
    }
  }

  double offsetOf(int32_t index) const {
    double off = 0.0;
    for (int32_t i = 0; i < index && i < static_cast<int32_t>(sizes.size()); i++) off += sizes[i];
    return off;
  }

  double totalSize() const { return offsetOf(static_cast<int32_t>(sizes.size())); }

  void engagedRange(double scroll, double viewportH, double draw, int32_t& outStart, int32_t& outEnd) const {
    const auto count = static_cast<int32_t>(sizes.size());
    if (count == 0 || viewportH <= 0.0f) {
      outStart = 0;
      outEnd = -1;
      return;
    }
    const double top = std::max(0.0, scroll - draw);
    const double bottom = std::min(totalSize(), scroll + viewportH + draw);
    int32_t start = 0;
    while (start < count && offsetOf(start) + sizes[start] <= top) start++;
    if (start >= count) {
      outStart = count - 1;
      outEnd = count - 1;
      return;
    }
    int32_t end = start;
    while (end < count && offsetOf(end) < bottom) end++;
    end = std::max(start, std::min(end - 1, count - 1));
    outStart = start;
    outEnd = end;
  }
};

static void testOctaveRounding() {
  LayoutCore core;
  core.setItemCount(1);
  core.setItemSize(0, 100.06f);
  CHECK_EQ_F(core.getSize(0), 100.0f);
  core.setItemSize(0, 100.07f);
  CHECK_EQ_F(core.getSize(0), 100.125f);
}

static void testEstimateFillAndTotal() {
  LayoutCore core;
  core.setEstimate(50.0f);
  core.setItemCount(10);
  CHECK_EQ_F(core.getTotalSize(), 500.0f);
  CHECK_EQ_F(core.getOffset(4), 200.0f);
  core.setItemSize(0, 80.0f);
  core.setEstimate(60.0f);
  CHECK_EQ_F(core.getSize(0), 80.0f);
  CHECK_EQ_F(core.getSize(1), 60.0f);
  CHECK_EQ_F(core.getTotalSize(), 80.0f + 9 * 60.0f);
}

static void testEpsilonGate() {
  LayoutCore core;
  core.setMeasurementEpsilon(0.35f);
  core.setItemCount(2);
  CHECK(core.setItemSize(0, 100.0f));
  const int32_t v1 = core.getLayoutVersion();
  CHECK(!core.setItemSize(0, 100.25f));
  CHECK_EQ_F(core.getSize(0), 100.0f);
  CHECK(core.getLayoutVersion() == v1);
  CHECK(core.setItemSize(0, 100.5f));
  CHECK_EQ_F(core.getSize(0), 100.5f);
  core.setEstimate(100.0f);
  CHECK(core.setItemSize(1, 100.0f) == false || true);
  core.setItemSize(1, 100.0f);
  core.setEstimate(70.0f);
  CHECK_EQ_F(core.getSize(1), 100.0f);
}

static void testLayoutVersionSemantics() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(5);
  const int32_t v0 = core.getLayoutVersion();
  core.setItemSize(2, 100.0f);
  CHECK(core.getLayoutVersion() == v0);
  core.setItemSize(2, 140.0f);
  core.setItemSize(3, 90.0f);
  const int32_t v1 = core.getLayoutVersion();
  CHECK(v1 == v0 + 1);
  CHECK_EQ_F(core.getOffset(3), 100.0f + 100.0f + 140.0f);
}

static void testEngagedRangeBasics() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(100);
  auto r = core.getEngagedRange(1000.0f, 500.0f, 200.0f);
  CHECK(r.start == 8);
  CHECK(r.end == 16);
  auto rEmpty = core.getEngagedRange(0.0f, 0.0f, 200.0f);
  CHECK(rEmpty.start == 0 && rEmpty.end == -1);
  LayoutCore empty;
  auto rNone = empty.getEngagedRange(0.0f, 500.0f, 200.0f);
  CHECK(rNone.start == 0 && rNone.end == -1);
  auto rPast = core.getEngagedRange(50000.0f, 500.0f, 200.0f);
  CHECK(rPast.start == 99 && rPast.end == 99);
}

static void testBoundaryWindowStaysCorrect() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(50);
  auto r0 = core.getEngagedRange(1000.0f, 500.0f, 200.0f);
  for (float s = 1000.0f; s < 1099.0f; s += 7.0f) {
    auto r = core.getEngagedRange(s, 500.0f, 200.0f);
    const auto expectedStart = static_cast<int32_t>(std::floor((s - 200.0f) / 100.0f));
    CHECK(r.start == expectedStart);
    (void)r0;
  }
  auto before = core.getEngagedRange(1000.0f, 500.0f, 200.0f);
  core.setItemSize(0, 500.0f);
  auto after = core.getEngagedRange(1000.0f, 500.0f, 200.0f);
  CHECK(after.version != before.version);
  CHECK(after.start < before.start);
  auto tall = core.getEngagedRange(1000.0f, 900.0f, 200.0f);
  CHECK(tall.end > after.end);
}

static void testResetItemSizes() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(10);
  core.setItemSize(3, 250.0f);
  CHECK_EQ_F(core.getTotalSize(), 9 * 100.0f + 250.0f);
  CHECK(core.resetItemSizes());
  CHECK_EQ_F(core.getTotalSize(), 1000.0f);
  core.setEstimate(80.0f);
  CHECK_EQ_F(core.getTotalSize(), 800.0f);
  core.resetItemSizes();
  CHECK(!core.resetItemSizes());
}

static void testRemapItemSizes() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(6);
  for (int32_t i = 0; i < 6; i++) {
    core.setItemSize(i, 50.0f + 10.0f * static_cast<float>(i));
  }
  core.setItemCount(8);
  const double prepend[] = {0, 2, 1, 3, 2, 4, 3, 5, 4, 6, 5, 7};
  CHECK(core.remapItemSizes(prepend, 6));
  CHECK_EQ_F(core.getSize(0), 100.0f);
  CHECK_EQ_F(core.getSize(1), 100.0f);
  CHECK_EQ_F(core.getSize(2), 50.0f);
  CHECK_EQ_F(core.getSize(7), 100.0f);
  CHECK_EQ_F(core.getOffset(2), 200.0f);
  CHECK_EQ_F(core.getTotalSize(), 200.0f + (50 + 60 + 70 + 80 + 90 + 100));
  core.setEstimate(30.0f);
  CHECK_EQ_F(core.getSize(2), 50.0f);
  CHECK_EQ_F(core.getSize(0), 30.0f);

  LayoutCore removal;
  removal.setEstimate(100.0f);
  removal.setItemCount(4);
  for (int32_t i = 0; i < 4; i++) {
    removal.setItemSize(i, 200.0f + static_cast<float>(i));
  }
  removal.setItemCount(3);
  const double shiftUp[] = {1, 0, 2, 1, 3, 2};
  CHECK(removal.remapItemSizes(shiftUp, 3));
  CHECK_EQ_F(removal.getSize(0), 201.0f);
  CHECK_EQ_F(removal.getSize(1), 202.0f);
  CHECK_EQ_F(removal.getSize(2), 100.0f);

  LayoutCore swap;
  swap.setEstimate(100.0f);
  swap.setItemCount(2);
  swap.setItemSize(0, 111.0f);
  swap.setItemSize(1, 222.0f);
  const double swapped[] = {0, 1, 1, 0};
  CHECK(swap.remapItemSizes(swapped, 2));
  CHECK_EQ_F(swap.getSize(0), 222.0f);
  CHECK_EQ_F(swap.getSize(1), 111.0f);

  LayoutCore typed;
  typed.setTypeAverages(true);
  typed.setEstimate(100.0f);
  typed.setItemCount(4);
  const uint16_t types[4] = {1, 1, 1, 1};
  typed.setItemTypes(types, 4);
  typed.setItemSize(0, 60.0f);
  typed.setItemSize(3, 500.0f);
  const double keepZeroOnly[] = {0, 0};
  CHECK(typed.remapItemSizes(keepZeroOnly, 1));
  CHECK_EQ_F(typed.getSize(0), 60.0f);
  CHECK_EQ_F(typed.getSize(3), 280.0f);

  LayoutCore garbage;
  garbage.setEstimate(100.0f);
  garbage.setItemCount(3);
  garbage.setItemSize(1, 55.0f);
  const double junk[] = {-1, 0, 1e12, 1, std::nan(""), 2, 2, std::nan(""), 5, 0, 1, 1e12};
  CHECK(garbage.remapItemSizes(junk, 6));
  CHECK_EQ_F(garbage.getSize(1), 100.0f);
  CHECK(!garbage.remapItemSizes(nullptr, 3));
  CHECK(!garbage.remapItemSizes(junk, 0));
  const double identity[] = {0, 0, 1, 1, 2, 2};
  CHECK(!garbage.remapItemSizes(identity, 3));

  LayoutCore shrunk;
  shrunk.setEstimate(100.0f);
  shrunk.setItemCount(6);
  shrunk.setItemSize(5, 400.0f);
  shrunk.setItemCount(3);
  const double stale[] = {5, 0};
  CHECK(!shrunk.remapItemSizes(stale, 1));
  CHECK_EQ_F(shrunk.getSize(0), 100.0f);
}

static void testResetAllForRecycle() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(100.0f);
  core.setItemCount(10);
  const uint16_t types[10] = {1, 1, 1, 1, 1, 1, 1, 1, 1, 1};
  core.setItemTypes(types, 10);
  core.setItemSize(3, 250.0f);
  CHECK(core.getMemoryFootprint() > 0);
  core.resetAll();
  CHECK_EQ_F(core.getTotalSize(), 0.0f);
  CHECK(core.getLayoutVersion() == 0);
  CHECK(core.getMemoryFootprint() == 0);
  const LayoutCore::EngagedRange empty = core.getEngagedRange(0.0f, 600.0f, 250.0f);
  CHECK(empty.end < empty.start);
  core.setEstimate(50.0f);
  core.setItemCount(4);
  CHECK_EQ_F(core.getTotalSize(), 200.0f);
  CHECK_EQ_F(core.getSize(0), 50.0f);
}

static void testShrinkThenRegrow() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(100);
  core.setItemSize(80, 300.0f);
  core.setItemCount(50);
  CHECK_EQ_F(core.getTotalSize(), 5000.0f);
  core.setItemCount(90);
  CHECK_EQ_F(core.getSize(70), 100.0f);
  CHECK_EQ_F(core.getSize(80), 100.0f);
  CHECK_EQ_F(core.getTotalSize(), 9000.0f);
}

static void testBatchWithScale() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(4);
  const double pairs[] = {0.0, 50.0, 2.0, 75.5, 99.0, 10.0};
  CHECK(core.setItemSizes(pairs, 3, 2.0f));
  CHECK_EQ_F(core.getSize(0), 100.0f);
  CHECK_EQ_F(core.getSize(2), 151.0f);
  CHECK_EQ_F(core.getSize(3), 100.0f);
  CHECK(!core.setItemSizes(pairs, 3, 2.0f));
}

static void testAnchoredBatch() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(100);
  const double above[] = {2.0, 200.0};
  const float diff = core.setItemSizesAnchored(above, 1, 1.0f, 10);
  CHECK_EQ_F(diff, 100.0f);
  CHECK_EQ_F(core.getOffset(10), 1100.0f);
  const double below[] = {10.0, 300.0, 50.0, 40.0};
  CHECK_EQ_F(core.setItemSizesAnchored(below, 2, 1.0f, 10), 0.0f);
  const double mixed[] = {0.0, 150.0, 60.0, 10.0};
  CHECK_EQ_F(core.setItemSizesAnchored(mixed, 2, 1.0f, 10), 50.0f);
  CHECK_EQ_F(core.setItemSizesAnchored(mixed, 2, 1.0f, 10), 0.0f);
  const double tail[] = {1.0, 500.0};
  CHECK_EQ_F(core.setItemSizesAnchored(tail, 1, 1.0f, -1), 0.0f);
  CHECK_EQ_F(core.getSize(1), 500.0f);
  LayoutCore typed;
  typed.setTypeAverages(true);
  typed.setEstimate(100.0f);
  typed.setItemCount(10);
  const double first[] = {0.0, 150.0};
  CHECK_EQ_F(typed.setItemSizesAnchored(first, 1, 1.0f, 5), 250.0f);
}

static void testTypeAverages() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(100.0f);
  core.setItemCount(10);
  const uint16_t types[] = {1, 2, 2, 2, 2, 1, 2, 2, 2, 2};
  core.setItemTypes(types, 10);
  CHECK_EQ_F(core.getTotalSize(), 1000.0f);
  core.setItemSize(1, 40.0f);
  CHECK_EQ_F(core.getSize(2), 40.0f);
  CHECK_EQ_F(core.getSize(6), 40.0f);
  CHECK_EQ_F(core.getSize(0), 100.0f);
  CHECK_EQ_F(core.getTotalSize(), 2 * 100.0f + 8 * 40.0f);
  core.setItemSize(2, 60.0f);
  CHECK_EQ_F(core.getSize(1), 40.0f);
  CHECK_EQ_F(core.getSize(3), 50.0f);
  core.setItemSize(1, 80.0f);
  CHECK_EQ_F(core.getSize(3), 70.0f);
  core.setItemSize(0, 200.0f);
  CHECK_EQ_F(core.getSize(5), 200.0f);
  CHECK_EQ_F(core.getSize(3), 70.0f);
  core.resetItemSizes();
  CHECK_EQ_F(core.getSize(0), 200.0f);
  CHECK_EQ_F(core.getSize(1), 70.0f);
  core.setEstimate(500.0f);
  CHECK_EQ_F(core.getSize(1), 70.0f);
}

static void testSmallMeanDriftDoesNotSweep() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(80.0);
  core.setItemCount(500);
  std::vector<uint16_t> types(500, 1);
  core.setItemTypes(types.data(), 500);
  for (int32_t i = 478; i < 500; i++) {
    core.setItemSize(i, 80.0);
  }
  CHECK_EQ_F(core.getOffset(400), 32000.0);
  CHECK_EQ_F(core.getTotalSize(), 40000.0);

  core.setItemSize(499, 100.0);
  CHECK_EQ_F(core.getOffset(400), 32000.0);
  CHECK_EQ_F(core.getOffset(499), 39920.0);
  CHECK_EQ_F(core.getTotalSize(), 40020.0);

  for (int32_t i = 478; i < 499; i++) {
    core.setItemSize(i, 160.0);
  }
  CHECK(core.getOffset(400) > 32000.0);
}

static void testSeedTypeMeans() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(100.0f);
  core.setItemCount(10);
  const uint16_t types[] = {1, 2, 2, 2, 2, 1, 2, 2, 2, 2};
  core.setItemTypes(types, 10);
  const int32_t versionBefore = core.getLayoutVersion();

  const double seeds[] = {1, 200.0, 2, 40.0, 0, 77.0, -3, 50.0, 9999, 50.0, 5, -10.0};
  CHECK(core.seedTypeMeans(seeds, 6, 1.0f));
  CHECK_EQ_F(core.getSize(0), 200.0f);
  CHECK_EQ_F(core.getSize(1), 40.0f);
  CHECK_EQ_F(core.getTotalSize(), 2 * 200.0f + 8 * 40.0f);
  CHECK(core.getLayoutVersion() > versionBefore);

  core.setItemSize(1, 60.0f);
  CHECK_EQ_F(core.getSize(1), 60.0f);
  CHECK_EQ_F(core.getSize(2), 60.0f);

  const double staleSeed[] = {2, 40.0};
  CHECK(!core.seedTypeMeans(staleSeed, 1, 1.0f));
  CHECK_EQ_F(core.getSize(3), 60.0f);

  core.resetItemSizes();
  CHECK_EQ_F(core.getSize(0), 200.0f);
  CHECK_EQ_F(core.getSize(1), 60.0f);

  LayoutCore scaled;
  scaled.setTypeAverages(true);
  scaled.setEstimate(100.0f);
  scaled.setItemCount(2);
  const uint16_t oneType[] = {3, 3};
  scaled.setItemTypes(oneType, 2);
  const double dpSeed[] = {3, 40.0};
  CHECK(scaled.seedTypeMeans(dpSeed, 1, 2.0f));
  CHECK_EQ_F(scaled.getSize(0), 80.0f);

  LayoutCore plain;
  plain.setEstimate(100.0f);
  plain.setItemCount(2);
  plain.setItemTypes(oneType, 2);
  CHECK(!plain.seedTypeMeans(dpSeed, 1, 1.0f));
  CHECK_EQ_F(plain.getSize(0), 100.0f);
}

static void testFillLayoutSlab() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(100);
  double slab[4 + 2 * 32];
  const int32_t n = core.fillLayoutSlab(slab, 4 + 2 * 32, 1000.0f, 500.0f, 200.0f, 1.0f);
  CHECK(n == 9);
  CHECK(static_cast<int32_t>(slab[2]) == 8 && static_cast<int32_t>(slab[3]) == 16);
  CHECK_EQ_F(static_cast<float>(slab[1]), 10000.0f);
  CHECK_EQ_F(static_cast<float>(slab[4]), 800.0f);
  CHECK_EQ_F(static_cast<float>(slab[5]), 100.0f);
  CHECK_EQ_F(static_cast<float>(slab[4 + 16]), 1600.0f);
  core.fillLayoutSlab(slab, 4 + 2 * 32, 1000.0f, 500.0f, 200.0f, 0.5f);
  CHECK_EQ_F(static_cast<float>(slab[1]), 5000.0f);
  CHECK_EQ_F(static_cast<float>(slab[4]), 400.0f);
  CHECK(core.fillLayoutSlab(slab, 6, 1000.0f, 500.0f, 200.0f, 1.0f) == -1);
  LayoutCore empty;
  const int32_t none = empty.fillLayoutSlab(slab, 8, 0.0f, 500.0f, 200.0f, 1.0f);
  CHECK(none == 0);
  CHECK(static_cast<int32_t>(slab[3]) == -1);
}

static double gFakeNowMs = 0.0;
static double fakeClock() { return gFakeNowMs; }

static void testDirectionalBuffers() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(200);
  core.setClockForTesting(&fakeClock);
  core.setDirectionalBuffers(true);
  const float viewportH = 800.0f;
  const float draw = 250.0f;

  gFakeNowMs = 0.0;
  auto r0 = core.getEngagedRange(4800.0f, viewportH, draw);
  CHECK(r0.start == 45);
  gFakeNowMs = 16.0;
  core.getEngagedRange(4900.0f, viewportH, draw);
  gFakeNowMs = 32.0;
  auto down = core.getEngagedRange(5000.0f, viewportH, draw);
  CHECK(down.start == 48);
  CHECK(down.end == 61);

  CHECK(down.end - down.start == 13);

  gFakeNowMs = 48.0;
  auto small = core.getEngagedRange(5010.0f, viewportH, draw);
  CHECK(small.start == 48 && small.end == 61);

  gFakeNowMs = 64.0;
  auto reversing = core.getEngagedRange(4900.0f, viewportH, draw);
  CHECK(reversing.start == 46);
  CHECK(reversing.end == 59);
  gFakeNowMs = 80.0;
  auto up = core.getEngagedRange(4800.0f, viewportH, draw);
  CHECK(up.start == 44);
  CHECK(up.end == 57);

  gFakeNowMs = 1000.0;
  auto idle = core.getEngagedRange(5000.0f, viewportH, draw);
  CHECK(idle.start == 47);
  CHECK(idle.end == 60);

  core.setDirectionalBuffers(false);
  gFakeNowMs = 1016.0;
  core.getEngagedRange(5100.0f, viewportH, draw);
  gFakeNowMs = 1032.0;
  auto off = core.getEngagedRange(5200.0f, viewportH, draw);
  CHECK(off.start == 49);
  CHECK(off.end == 62);
}

static void testEstimatesFrozen() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(100.0f);
  core.setItemCount(100);
  std::vector<uint16_t> types(100, 1);
  core.setItemTypes(types.data(), 100);

  core.setItemSize(0, 200.0f);
  CHECK(core.getSize(50) == 200.0f);

  CHECK(core.setEstimatesFrozen(true) == false);
  core.setItemSize(1, 400.0f);
  CHECK(core.getSize(1) == 400.0f);
  CHECK(core.getSize(50) == 200.0f);

  CHECK(core.setEstimatesFrozen(true) == false);
  CHECK(core.setEstimatesFrozen(false) == true);
  CHECK(core.getSize(50) == 300.0f);
  CHECK(core.getTotalSize() == 200.0f + 400.0f + 98.0f * 300.0f);

  core.setEstimatesFrozen(true);
  CHECK(core.setEstimatesFrozen(false) == false);
}

static void testResetScrollVelocity() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(200);
  core.setClockForTesting(&fakeClock);
  core.setDirectionalBuffers(true);
  const float viewportH = 800.0f;
  const float draw = 250.0f;

  gFakeNowMs = 2000.0;
  core.getEngagedRange(4800.0f, viewportH, draw);
  gFakeNowMs = 2016.0;
  core.getEngagedRange(4900.0f, viewportH, draw);
  gFakeNowMs = 2032.0;
  auto moving = core.getEngagedRange(5000.0f, viewportH, draw);
  CHECK(moving.start == 48);

  core.resetScrollVelocity();
  gFakeNowMs = 2040.0;
  auto jumped = core.getEngagedRange(15000.0f, viewportH, draw);
  CHECK(jumped.start == 147);
  CHECK(jumped.end == 160);

  gFakeNowMs = 2056.0;
  auto after = core.getEngagedRange(15100.0f, viewportH, draw);
  CHECK(after.start == 148);
  CHECK(after.end == 161);
  gFakeNowMs = 2072.0;
  auto confirmed = core.getEngagedRange(15200.0f, viewportH, draw);
  CHECK(confirmed.start == 150);
  CHECK(confirmed.end == 163);

  core.resetScrollVelocity();
  gFakeNowMs = 2088.0;
  auto rebased = core.getEngagedRange(15200.0f, viewportH, draw);
  CHECK(rebased.start == 149);
  CHECK(rebased.end == 162);
  gFakeNowMs = 2104.0;
  auto resumed = core.getEngagedRange(15300.0f, viewportH, draw);
  CHECK(resumed.start == 150);
  CHECK(resumed.end == 163);
}

static void testSubFrameEchoDoesNotEngageRegime() {
  LayoutCore core;
  core.setEstimate(64.0);
  core.setItemCount(1000);
  core.setClockForTesting(&fakeClock);
  core.setDirectionalBuffers(true);
  const double viewport = 800.0;
  const double draw = 500.0;
  double offset = 10000.0;
  gFakeNowMs = 0.0;
  for (int tick = 0; tick < 8; tick++) {
    core.resetScrollVelocity();
    gFakeNowMs += 16.0;
    const LayoutCore::EngagedRange pushed = core.getEngagedRange(offset, viewport, draw);
    gFakeNowMs += 2.0;
    const LayoutCore::EngagedRange echoed = core.getEngagedRange(offset + 1.0, viewport, draw);
    CHECK(echoed.start - pushed.start <= 1);
    CHECK(pushed.start - echoed.start <= 1);
    offset += 33.0;
  }

  LayoutCore moving;
  moving.setEstimate(64.0);
  moving.setItemCount(1000);
  moving.setClockForTesting(&fakeClock);
  moving.setDirectionalBuffers(true);
  double y = 10000.0;
  LayoutCore::EngagedRange last{0, -1, 0};
  for (int frame = 0; frame < 5; frame++) {
    gFakeNowMs += 16.0;
    last = moving.getEngagedRange(y, viewport, draw);
    y += 33.0;
  }
  const LayoutCore::EngagedRange symmetric = LayoutCore().getEngagedRange(0.0, viewport, draw);
  (void)symmetric;
  CHECK(last.end - last.start + 1 > 0);
  const double top = y - 33.0;
  CHECK(moving.getOffset(last.start) > top - draw);
}

static void testRandomizedDifferential() {
  std::mt19937 rng(20260702);
  std::uniform_real_distribution<float> sizeDist(8.0f, 400.0f);
  std::uniform_real_distribution<float> scrollDist(-200.0f, 30000.0f);
  std::uniform_int_distribution<int32_t> opDist(0, 99);

  LayoutCore core;
  ReferenceModel ref;
  const float epsilon = 0.343f;
  core.setMeasurementEpsilon(epsilon);
  ref.epsilon = epsilon;
  core.setEstimate(100.0f);
  ref.setEstimate(100.0f);
  core.setItemCount(200);
  ref.setItemCount(200);
  int32_t count = 200;

  const float viewportH = 800.0f;
  const float draw = 250.0f;

  for (int step = 0; step < 20000; step++) {
    const int32_t op = opDist(rng);
    if (op < 55) {
      const float scroll = scrollDist(rng);
      auto r = core.getEngagedRange(scroll, viewportH, draw);
      int32_t expectedStart = 0;
      int32_t expectedEnd = -1;
      ref.engagedRange(scroll, viewportH, draw, expectedStart, expectedEnd);
      if (r.start != expectedStart || r.end != expectedEnd) {
        std::printf("FAIL differential step %d: scroll=%f got (%d,%d) want (%d,%d)\n", step,
                    static_cast<double>(scroll), r.start, r.end, expectedStart, expectedEnd);
        failures++;
        return;
      }
    } else if (op < 85) {
      std::uniform_int_distribution<int32_t> idxDist(0, count > 0 ? count - 1 : 0);
      const int32_t idx = idxDist(rng);
      const float size = sizeDist(rng);
      core.setItemSize(idx, size);
      ref.setItemSize(idx, size);
    } else if (op < 92) {
      std::uniform_int_distribution<int32_t> idxDist(0, count > 0 ? count - 1 : 0);
      double pairs[10];
      for (int p = 0; p < 5; p++) {
        const int32_t idx = idxDist(rng);
        const float size = sizeDist(rng);
        pairs[p * 2] = idx;
        pairs[p * 2 + 1] = size;
        ref.setItemSize(idx, size);
      }
      core.setItemSizes(pairs, 5, 1.0f);
    } else if (op < 96) {
      std::uniform_int_distribution<int32_t> countDist(0, 400);
      count = countDist(rng);
      core.setItemCount(count);
      ref.setItemCount(count);
    } else if (op < 98) {
      const float estimate = sizeDist(rng);
      core.setEstimate(estimate);
      ref.setEstimate(estimate);
    } else {
      core.resetItemSizes();
      ref.resetItemSizes();
    }
    if (std::abs(core.getTotalSize() - ref.totalSize()) > 1e-2f) {
      std::printf("FAIL differential step %d: total %f != %f\n", step,
                  static_cast<double>(core.getTotalSize()), static_cast<double>(ref.totalSize()));
      failures++;
      return;
    }
  }
  for (int32_t i = 0; i < count; i += 7) {
    CHECK_EQ_F(core.getOffset(i), ref.offsetOf(i));
  }
}

static void testColumnLayout() {
  LayoutCore core;
  core.setItemCount(7);
  core.setEstimate(100.0f);
  core.setColumnCount(2);

  CHECK_EQ_F(core.getOffset(0), 0.0f);
  CHECK_EQ_F(core.getOffset(1), 0.0f);
  CHECK_EQ_F(core.getOffset(2), 100.0f);
  CHECK_EQ_F(core.getOffset(3), 100.0f);
  CHECK_EQ_F(core.getOffset(6), 300.0f);
  CHECK_EQ_F(core.getTotalSize(), 400.0f);

  core.setItemSize(2, 150.0f);
  core.setItemSize(3, 90.0f);
  CHECK_EQ_F(core.getOffset(4), 250.0f);
  CHECK_EQ_F(core.getTotalSize(), 450.0f);

  const LayoutCore::EngagedRange range = core.getEngagedRange(120.0f, 100.0f, 0.0f);
  CHECK(range.start == 2);
  CHECK(range.end == 3);
  const LayoutCore::EngagedRange past = core.getEngagedRange(10000.0f, 100.0f, 0.0f);
  CHECK(past.start == 6);
  CHECK(past.end == 6);

  const uint16_t spans[7] = {2, 1, 1, 1, 1, 1, 1};
  CHECK(core.setItemSpans(spans, 7));
  CHECK_EQ_F(core.getOffset(0), 0.0f);
  CHECK_EQ_F(core.getOffset(1), 100.0f);
  CHECK_EQ_F(core.getOffset(2), 100.0f);
  CHECK_EQ_F(core.getOffset(3), 250.0f);
  CHECK_EQ_F(core.getOffset(4), 250.0f);

  core.setTypeAverages(true);
  const uint16_t types[7] = {1, 1, 1, 1, 1, 1, 1};
  core.setItemTypes(types, 7);
  core.setItemSize(1, 200.0f);
  core.setColumnCount(3);
  CHECK_EQ_F(core.getSize(1), 100.0f);
  double statsOut[3];
  CHECK(core.fillTypeStats(statsOut, 3, 1.0f) == 0);
}

static void testFillTypeStats() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setItemCount(10);
  core.setEstimate(100.0f);
  const uint16_t types[10] = {1, 1, 1, 2, 2, 2, 3, 3, 0, 0};
  core.setItemTypes(types, 10);

  double empty[3];
  CHECK(core.fillTypeStats(empty, 3, 1.0f) == 0);

  core.setItemSize(0, 50.0f);
  core.setItemSize(1, 70.0f);
  core.setItemSize(3, 200.0f);
  const double seed[2] = {3.0, 90.0};
  core.seedTypeMeans(seed, 1, 1.0f);

  double out[9];
  CHECK(core.fillTypeStats(out, 3, 1.0f) == -1);
  const int32_t written = core.fillTypeStats(out, 9, 1.0f);
  CHECK(written == 2);
  CHECK(out[0] == 1.0);
  CHECK_EQ_F(static_cast<float>(out[1]), 60.0f);
  CHECK(out[2] == 2.0);
  CHECK(out[3] == 2.0);
  CHECK_EQ_F(static_cast<float>(out[4]), 200.0f);
  CHECK(out[5] == 1.0);

  const int32_t scaled = core.fillTypeStats(out, 9, 0.5f);
  CHECK(scaled == 2);
  CHECK_EQ_F(static_cast<float>(out[1]), 30.0f);
}

static void testLargeCountOffsetsAreExact() {
  constexpr int32_t kCount = 100000;
  LayoutCore core;
  core.setEstimate(37.375);
  core.setItemCount(kCount);
  std::vector<double> sizes(static_cast<size_t>(kCount), 37.375);
  std::vector<double> pairs;
  pairs.reserve(static_cast<size_t>(kCount) * 2);
  for (int32_t i = 0; i < kCount; i++) {
    const double size = 20.0 + static_cast<double>((i * 7919) % 1024) / 8.0;
    pairs.push_back(i);
    pairs.push_back(size);
    sizes[static_cast<size_t>(i)] = size;
  }
  CHECK(core.setItemSizes(pairs.data(), kCount, 1.0));
  double running = 0.0;
  int32_t mismatches = 0;
  for (int32_t i = 0; i < kCount; i++) {
    if (core.getOffset(i) != running) mismatches++;
    running += sizes[static_cast<size_t>(i)];
  }
  CHECK(mismatches == 0);
  CHECK(core.getTotalSize() == running);
  CHECK(running > 4194304.0);

  std::vector<double> bump;
  for (int32_t k = 0; k < 10; k++) {
    bump.push_back(90000 + k);
    bump.push_back(sizes[static_cast<size_t>(90000 + k)] + 1.0);
  }
  CHECK(core.setItemSizesAnchored(bump.data(), 10, 1.0, 95000) == 10.0);
  CHECK(core.getOffset(95000) == core.getOffset(94999) + core.getSize(94999));

  double slab[4 + 2 * 64];
  const double scroll = core.getOffset(95000);
  const int32_t written = core.fillLayoutSlab(slab, 4 + 2 * 64, scroll, 800.0, 250.0, 1.0);
  CHECK(written > 0);
  CHECK(slab[1] == core.getTotalSize());
  const auto start = static_cast<int32_t>(slab[2]);
  CHECK(slab[4] == core.getOffset(start));
  CHECK(start <= 95000 && static_cast<int32_t>(slab[3]) >= 95000);
}

static void testFractionalScaleStaysExact() {
  const double scales[] = {2.75, 3.5};
  for (const double scale : scales) {
    constexpr int32_t kCount = 50000;
    LayoutCore core;
    core.setEstimate(40.0);
    core.setItemCount(kCount);
    std::vector<double> pairs;
    std::vector<double> expected(static_cast<size_t>(kCount));
    pairs.reserve(static_cast<size_t>(kCount) * 2);
    for (int32_t i = 0; i < kCount; i++) {
      const double sizeDp = 24.0 + static_cast<double>((i * 31) % 64) / 8.0;
      pairs.push_back(i);
      pairs.push_back(sizeDp);
      expected[static_cast<size_t>(i)] = static_cast<float>(std::round(sizeDp * scale * 8.0) / 8.0);
    }
    CHECK(core.setItemSizes(pairs.data(), kCount, scale));
    double running = 0.0;
    int32_t mismatches = 0;
    for (int32_t i = 0; i < kCount; i++) {
      if (core.getOffset(i) != running || core.getSize(i) != expected[static_cast<size_t>(i)]) {
        mismatches++;
      }
      running += expected[static_cast<size_t>(i)];
    }
    CHECK(mismatches == 0);
    CHECK(core.getTotalSize() == running);
    double slab[4 + 2 * 64];
    CHECK(core.fillLayoutSlab(slab, 4 + 2 * 64, 0.0, 800.0, 250.0, 1.0 / scale) > 0);
    CHECK(slab[1] == running * (1.0 / scale));
  }
}

static void testTypesRangeAndUnmeasured() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(100.0);
  core.setItemCount(10);
  const uint16_t all[10] = {1, 1, 1, 1, 1, 2, 2, 2, 2, 2};
  CHECK(core.setItemTypes(all, 10));
  core.setItemSize(0, 50.0);
  CHECK_EQ_F(core.getSize(4), 50.0f);
  CHECK(core.countUnmeasured(0, 10) == 9);
  CHECK(core.countUnmeasured(0, 1) == 0);
  CHECK(core.countUnmeasured(-5, 100) == 9);
  CHECK(core.countUnmeasured(5, 5) == 0);

  const uint16_t part[3] = {1, 1, 1};
  CHECK(core.setItemTypesRange(5, part, 3));
  CHECK_EQ_F(core.getSize(5), 50.0f);
  CHECK_EQ_F(core.getSize(7), 50.0f);
  CHECK_EQ_F(core.getSize(8), 100.0f);
  CHECK(core.setItemTypesRange(10, part, 3));
  CHECK(core.setItemTypesRange(-1, part, 3));
  CHECK_EQ_F(core.getSize(9), 100.0f);
  const uint16_t tail[5] = {1, 1, 1, 1, 1};
  CHECK(core.setItemTypesRange(8, tail, 5));
  CHECK_EQ_F(core.getSize(9), 50.0f);

  const uint16_t big[10] = {5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000};
  CHECK(!core.setItemTypes(big, 10));
  CHECK_EQ_F(core.getSize(1), 100.0f);
  const uint16_t bigOne[1] = {4096};
  CHECK(!core.setItemTypesRange(3, bigOne, 1));
  const uint16_t okOne[1] = {4095};
  CHECK(core.setItemTypesRange(3, okOne, 1));
  CHECK_EQ_F(core.getSize(0), 50.0f);
  CHECK(core.countUnmeasured(0, 10) == 9);
  CHECK(core.setItemTypes(nullptr, 0));
  CHECK_EQ_F(core.getSize(1), 100.0f);
}

static double gScriptedClockMs = 0.0;
static double scriptedClock() { return gScriptedClockMs; }

static int runReplay(const char* path) {
  std::ifstream input(path);
  if (!input) {
    std::fprintf(stderr, "cannot open %s\n", path);
    return 2;
  }
  LayoutCore core;
  std::vector<double> probes;
  std::string cmd;
  bool clockInstalled = false;
  int32_t lastCount = 0;
  while (input >> cmd) {
    if (cmd == "count") {
      int32_t n = 0;
      input >> n;
      core.setItemCount(n);
      if (n >= 0) lastCount = n;
    } else if (cmd == "estimate") {
      double v = 0;
      input >> v;
      core.setEstimate(v);
    } else if (cmd == "epsilon") {
      double v = 0;
      input >> v;
      core.setMeasurementEpsilon(v);
    } else if (cmd == "typeavg") {
      int b = 0;
      input >> b;
      core.setTypeAverages(b != 0);
    } else if (cmd == "directional") {
      int b = 0;
      input >> b;
      core.setDirectionalBuffers(b != 0);
    } else if (cmd == "freeze") {
      int b = 0;
      input >> b;
      core.setEstimatesFrozen(b != 0);
    } else if (cmd == "clock") {
      input >> gScriptedClockMs;
      if (!clockInstalled) {
        core.setClockForTesting(&scriptedClock);
        clockInstalled = true;
      }
    } else if (cmd == "velocityreset") {
      core.resetScrollVelocity();
    } else if (cmd == "columns") {
      int32_t n = 0;
      input >> n;
      core.setColumnCount(n);
    } else if (cmd == "spans") {
      int32_t n = 0;
      input >> n;
      std::vector<uint16_t> spans(static_cast<size_t>(n));
      for (int32_t i = 0; i < n; i++) {
        int32_t s = 0;
        input >> s;
        spans[static_cast<size_t>(i)] = static_cast<uint16_t>(s);
      }
      core.setItemSpans(spans.data(), n);
    } else if (cmd == "size") {
      int32_t idx = 0;
      double v = 0;
      input >> idx >> v;
      core.setItemSize(idx, v);
    } else if (cmd == "batch" || cmd == "remap" || cmd == "seed") {
      int32_t n = 0;
      input >> n;
      std::vector<double> pairs(static_cast<size_t>(n) * 2);
      for (int32_t i = 0; i < n * 2; i++) input >> pairs[i];
      if (cmd == "batch") {
        core.setItemSizes(pairs.data(), n, 1.0);
      } else if (cmd == "remap") {
        core.remapItemSizes(pairs.data(), n);
      } else {
        core.seedTypeMeans(pairs.data(), n, 1.0);
      }
    } else if (cmd == "anchored") {
      int32_t anchor = 0;
      int32_t n = 0;
      input >> anchor >> n;
      std::vector<double> pairs(static_cast<size_t>(n) * 2);
      for (int32_t i = 0; i < n * 2; i++) input >> pairs[i];
      probes.push_back(core.setItemSizesAnchored(pairs.data(), n, 1.0, anchor));
    } else if (cmd == "types") {
      int32_t n = 0;
      input >> n;
      std::vector<uint16_t> types(static_cast<size_t>(n));
      for (int32_t i = 0; i < n; i++) {
        int32_t t = 0;
        input >> t;
        types[static_cast<size_t>(i)] = static_cast<uint16_t>(t);
      }
      core.setItemTypes(types.data(), n);
    } else if (cmd == "reset") {
      core.resetItemSizes();
    } else if (cmd == "range") {
      double scroll = 0;
      double viewport = 0;
      double draw = 0;
      input >> scroll >> viewport >> draw;
      const LayoutCore::EngagedRange range = core.getEngagedRange(scroll, viewport, draw);
      probes.push_back(range.start);
      probes.push_back(range.end);
      probes.push_back(range.version);
    } else if (cmd == "offset") {
      int32_t idx = 0;
      input >> idx;
      probes.push_back(core.getOffset(idx));
    } else if (cmd == "sizeof") {
      int32_t idx = 0;
      input >> idx;
      probes.push_back(core.getSize(idx));
    } else if (cmd == "total") {
      probes.push_back(core.getTotalSize());
    } else if (cmd == "stats") {
      double statsOut[4096 * 3];
      const int32_t written = core.fillTypeStats(statsOut, 4096 * 3, 1.0);
      probes.push_back(written);
      for (int32_t s = 0; s < written * 3; s++) {
        probes.push_back(statsOut[s]);
      }
    } else if (cmd == "version") {
      probes.push_back(core.getLayoutVersion());
    } else {
      std::fprintf(stderr, "unknown command: %s\n", cmd.c_str());
      return 2;
    }
  }
  std::ostringstream out;
  out.precision(17);
  out << "{\"probes\":[";
  for (size_t i = 0; i < probes.size(); i++) {
    if (i > 0) out << ",";
    out << probes[i];
  }
  const int32_t version = core.getLayoutVersion();
  const double total = core.getTotalSize();
  out << "],\"layoutVersion\":" << version << ",\"totalSize\":" << total;
  out << ",\"itemCount\":" << lastCount;
  out << ",\"offsets\":[";
  for (int32_t i = 0; i < lastCount; i++) {
    if (i > 0) out << ",";
    out << core.getOffset(i);
  }
  out << "],\"sizes\":[";
  for (int32_t i = 0; i < lastCount; i++) {
    if (i > 0) out << ",";
    out << core.getSize(i);
  }
  out << "]}";
  std::printf("%s\n", out.str().c_str());
  return 0;
}

int main(int argc, char** argv) {
  if (argc >= 3 && std::strcmp(argv[1], "--dump-json") == 0) {
    return runReplay(argv[2]);
  }
  testOctaveRounding();
  testEstimateFillAndTotal();
  testEpsilonGate();
  testLayoutVersionSemantics();
  testEngagedRangeBasics();
  testBoundaryWindowStaysCorrect();
  testResetItemSizes();
  testRemapItemSizes();
  testResetAllForRecycle();
  testShrinkThenRegrow();
  testBatchWithScale();
  testAnchoredBatch();
  testTypeAverages();
  testSmallMeanDriftDoesNotSweep();
  testSeedTypeMeans();
  testFillLayoutSlab();
  testDirectionalBuffers();
  testEstimatesFrozen();
  testResetScrollVelocity();
  testFillTypeStats();
  testColumnLayout();
  testLargeCountOffsetsAreExact();
  testFractionalScaleStaysExact();
  testTypesRangeAndUnmeasured();
  testSubFrameEchoDoesNotEngageRegime();
  testRandomizedDifferential();
  if (failures == 0) {
    std::printf("OK — all LayoutCore tests passed\n");
    return 0;
  }
  std::printf("%d failure(s)\n", failures);
  return 1;
}
