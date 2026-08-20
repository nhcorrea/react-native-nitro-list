// Host-only unit tests for the shared LayoutCore. Not part of the app build.
//
// Run:
//   cd cpp
//   clang++ -std=c++20 -O1 -fsanitize=address,undefined -I. tests/LayoutCoreTests.cpp LayoutCore.cpp -o /tmp/layout_core_tests && /tmp/layout_core_tests
//
// Covers behavior parity with the (now replaced) Swift/Kotlin LayoutManagers:
// octave rounding, estimate fill, epsilon gate, lazy prefix sums,
// layoutVersion semantics, engaged-range walk + boundary-window cache,
// resetItemSizes, shrink/regrow — plus a randomized differential test
// against a naive O(N) reference model.

#include "../LayoutCore.hpp"

#include <cmath>
#include <cstdio>
#include <random>
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

// -----------------------------------------------------------------------------
// Naive reference model: recomputes everything from scratch on every read.
// Any divergence from LayoutCore is a bug in LayoutCore's caching layers.
// -----------------------------------------------------------------------------
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

  float offsetOf(int32_t index) const {
    float off = 0.0f;
    for (int32_t i = 0; i < index && i < static_cast<int32_t>(sizes.size()); i++) off += sizes[i];
    return off;
  }

  float totalSize() const { return offsetOf(static_cast<int32_t>(sizes.size())); }

  // Mirrors the documented range contract, computed from scratch.
  void engagedRange(float scroll, float viewportH, float draw, int32_t& outStart, int32_t& outEnd) const {
    const auto count = static_cast<int32_t>(sizes.size());
    if (count == 0 || viewportH <= 0.0f) {
      outStart = 0;
      outEnd = -1;
      return;
    }
    const float top = std::max(0.0f, scroll - draw);
    const float bottom = std::min(totalSize(), scroll + viewportH + draw);
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

// -----------------------------------------------------------------------------

static void testOctaveRounding() {
  LayoutCore core;
  core.setItemCount(1);
  core.setItemSize(0, 100.06f); // 100.06 * 8 = 800.48 → 800 → 100.0
  CHECK_EQ_F(core.getSize(0), 100.0f);
  core.setItemSize(0, 100.07f); // 100.07 * 8 = 800.56 → 801 → 100.125
  CHECK_EQ_F(core.getSize(0), 100.125f);
}

static void testEstimateFillAndTotal() {
  LayoutCore core;
  core.setEstimate(50.0f);
  core.setItemCount(10);
  CHECK_EQ_F(core.getTotalSize(), 500.0f);
  CHECK_EQ_F(core.getOffset(4), 200.0f);
  // Estimate change only rewrites unmeasured items.
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
  // 1/4 delta: above the octave quantum, below epsilon → ignored.
  CHECK(!core.setItemSize(0, 100.25f));
  CHECK_EQ_F(core.getSize(0), 100.0f);
  CHECK(core.getLayoutVersion() == v1);
  // Above epsilon → applied.
  CHECK(core.setItemSize(0, 100.5f));
  CHECK_EQ_F(core.getSize(0), 100.5f);
  // First measurement never gated, even when equal to the estimate.
  core.setEstimate(100.0f);
  CHECK(core.setItemSize(1, 100.0f) == false || true); // documented below
  // (setItemSize(1, 100.0) with size already == estimate is a no-op *store*
  // but must still mark the index measured; the boolean only reports a
  // stored-size change. Verify the flag via estimate immunity:)
  core.setItemSize(1, 100.0f);
  core.setEstimate(70.0f);
  CHECK_EQ_F(core.getSize(1), 100.0f); // measured — estimate change can't touch it
}

static void testLayoutVersionSemantics() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(5);
  const int32_t v0 = core.getLayoutVersion();
  // Re-reporting the estimate as the real size: stored value unchanged →
  // offsets don't move → version must NOT bump.
  core.setItemSize(2, 100.0f);
  CHECK(core.getLayoutVersion() == v0);
  // A real change bumps exactly once per clean pass.
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
  // viewport 500, draw 200 at scroll 1000 → window [800, 1700).
  auto r = core.getEngagedRange(1000.0f, 500.0f, 200.0f);
  CHECK(r.start == 8);
  CHECK(r.end == 16);
  // Empty / degenerate cases.
  auto rEmpty = core.getEngagedRange(0.0f, 0.0f, 200.0f);
  CHECK(rEmpty.start == 0 && rEmpty.end == -1);
  LayoutCore empty;
  auto rNone = empty.getEngagedRange(0.0f, 500.0f, 200.0f);
  CHECK(rNone.start == 0 && rNone.end == -1);
  // Past-the-end scroll clamps to the last item.
  auto rPast = core.getEngagedRange(50000.0f, 500.0f, 200.0f);
  CHECK(rPast.start == 99 && rPast.end == 99);
}

static void testBoundaryWindowStaysCorrect() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(50);
  // Prime the window, then take tiny steps around the same position — the
  // fast path must return the identical range the slow path would.
  auto r0 = core.getEngagedRange(1000.0f, 500.0f, 200.0f);
  for (float s = 1000.0f; s < 1099.0f; s += 7.0f) {
    auto r = core.getEngagedRange(s, 500.0f, 200.0f);
    // Reference: window [s-200, s+700); with 100-unit items start = floor((s-200)/100).
    const auto expectedStart = static_cast<int32_t>(std::floor((s - 200.0f) / 100.0f));
    CHECK(r.start == expectedStart);
    (void)r0;
  }
  // A mutation invalidates the window even when the scroll doesn't move.
  auto before = core.getEngagedRange(1000.0f, 500.0f, 200.0f);
  core.setItemSize(0, 500.0f); // pushes everything below down by 400
  auto after = core.getEngagedRange(1000.0f, 500.0f, 200.0f);
  CHECK(after.version != before.version);
  CHECK(after.start < before.start); // items shifted down → earlier indices visible
  // Viewport change also invalidates.
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
  // All measured flags cleared → estimate changes apply everywhere again.
  core.setEstimate(80.0f);
  CHECK_EQ_F(core.getTotalSize(), 800.0f);
  // Nothing to reset → false.
  core.resetItemSizes();
  CHECK(!core.resetItemSizes());
}

static void testRemapItemSizes() {
  // Prepend: grow first (JS order — the itemCount prop commits before the
  // remap effect runs), then shift every survivor down by the insert count.
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(6);
  for (int32_t i = 0; i < 6; i++) {
    core.setItemSize(i, 50.0f + 10.0f * static_cast<float>(i));
  }
  core.setItemCount(8);
  const double prepend[] = {0, 2, 1, 3, 2, 4, 3, 5, 4, 6, 5, 7};
  CHECK(core.remapItemSizes(prepend, 6));
  CHECK_EQ_F(core.getSize(0), 100.0f); // new content → estimate
  CHECK_EQ_F(core.getSize(1), 100.0f);
  CHECK_EQ_F(core.getSize(2), 50.0f); // old 0
  CHECK_EQ_F(core.getSize(7), 100.0f); // old 5
  CHECK_EQ_F(core.getOffset(2), 200.0f);
  CHECK_EQ_F(core.getTotalSize(), 200.0f + (50 + 60 + 70 + 80 + 90 + 100));
  // Moved measurements stay measured: a later estimate change skips them.
  core.setEstimate(30.0f);
  CHECK_EQ_F(core.getSize(2), 50.0f);
  CHECK_EQ_F(core.getSize(0), 30.0f);

  // Removal at the front: survivors shift up. The old tail slot was cleared
  // by the shrink BEFORE the remap ran (JS prop order), so the survivor that
  // came from it degrades to the estimate — the documented shrink limitation.
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

  // Reorder (swap) must be order-independent — sources read pre-remap.
  LayoutCore swap;
  swap.setEstimate(100.0f);
  swap.setItemCount(2);
  swap.setItemSize(0, 111.0f);
  swap.setItemSize(1, 222.0f);
  const double swapped[] = {0, 1, 1, 0};
  CHECK(swap.remapItemSizes(swapped, 2));
  CHECK_EQ_F(swap.getSize(0), 222.0f);
  CHECK_EQ_F(swap.getSize(1), 111.0f);

  // A previously-measured index left out of the map reverts to unmeasured:
  // its type mean owns it again.
  LayoutCore typed;
  typed.setTypeAverages(true);
  typed.setEstimate(100.0f);
  typed.setItemCount(4);
  const uint16_t types[4] = {1, 1, 1, 1};
  typed.setItemTypes(types, 4);
  typed.setItemSize(0, 60.0f);
  typed.setItemSize(3, 500.0f); // mean → 280
  const double keepZeroOnly[] = {0, 0};
  CHECK(typed.remapItemSizes(keepZeroOnly, 1));
  CHECK_EQ_F(typed.getSize(0), 60.0f);
  CHECK_EQ_F(typed.getSize(3), 280.0f); // dropped measurement → type mean

  // Garbage pairs are skipped without reading out of bounds; since the map
  // is the complete survivor set, an all-garbage map degrades to a full
  // reset (no survivors) rather than corrupting anything.
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

  // Sources cleared by a shrink are unmeasured — a stale old index from the
  // pre-shrink world contributes nothing.
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
  // Everything gone: count, sizes, total, version, heap storage.
  CHECK_EQ_F(core.getTotalSize(), 0.0f);
  CHECK(core.getLayoutVersion() == 0);
  CHECK(core.getMemoryFootprint() == 0);
  const LayoutCore::EngagedRange empty = core.getEngagedRange(0.0f, 600.0f, 250.0f);
  CHECK(empty.end < empty.start);
  // The recycled instance must behave exactly like a fresh one — including
  // type means NOT leaking from the previous list into the next.
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
  core.setItemCount(50); // shrink clears the tail
  CHECK_EQ_F(core.getTotalSize(), 5000.0f);
  core.setItemCount(90); // regrow within the old allocation
  // The regrown tail must carry the estimate — not stale zeros (old
  // Swift/Kotlin bug) and not the pre-shrink measurement of index 80.
  CHECK_EQ_F(core.getSize(70), 100.0f);
  CHECK_EQ_F(core.getSize(80), 100.0f);
  CHECK_EQ_F(core.getTotalSize(), 9000.0f);
}

static void testBatchWithScale() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(4);
  const double pairs[] = {0.0, 50.0, 2.0, 75.5, 99.0, 10.0}; // idx 99 out of range → skipped
  CHECK(core.setItemSizes(pairs, 3, 2.0f)); // scale 2 (Android density)
  CHECK_EQ_F(core.getSize(0), 100.0f);
  CHECK_EQ_F(core.getSize(2), 151.0f);
  CHECK_EQ_F(core.getSize(3), 100.0f);
  CHECK(!core.setItemSizes(pairs, 3, 2.0f)); // identical batch → no change
}

static void testAnchoredBatch() {
  LayoutCore core;
  core.setEstimate(100.0f);
  core.setItemCount(100);
  // Growth above the anchor shifts it by exactly the delta.
  const double above[] = {2.0, 200.0};
  const float diff = core.setItemSizesAnchored(above, 1, 1.0f, 10);
  CHECK_EQ_F(diff, 100.0f);
  CHECK_EQ_F(core.getOffset(10), 1100.0f);
  // Changes at/below the anchor don't move it.
  const double below[] = {10.0, 300.0, 50.0, 40.0};
  CHECK_EQ_F(core.setItemSizesAnchored(below, 2, 1.0f, 10), 0.0f);
  // Mixed above+below: only the above-part contributes.
  const double mixed[] = {0.0, 150.0, 60.0, 10.0};
  CHECK_EQ_F(core.setItemSizesAnchored(mixed, 2, 1.0f, 10), 50.0f);
  // No-op batch (identical sizes) → 0, invalid anchor → 0 but batch applies.
  CHECK_EQ_F(core.setItemSizesAnchored(mixed, 2, 1.0f, 10), 0.0f);
  const double tail[] = {1.0, 500.0};
  CHECK_EQ_F(core.setItemSizesAnchored(tail, 1, 1.0f, -1), 0.0f);
  CHECK_EQ_F(core.getSize(1), 500.0f);
  // With type averages on, the sweep of unmeasured items above the anchor is
  // part of the diff too — the whole consequence of the batch is measured.
  LayoutCore typed;
  typed.setTypeAverages(true);
  typed.setEstimate(100.0f);
  typed.setItemCount(10);
  const double first[] = {0.0, 150.0};
  // idx 0 measures 150 → all-untyped mean 150 sweeps idx 1..9 too.
  // Anchor 5: before = 500; after = 150 + 4×150 = 750 → diff 250.
  CHECK_EQ_F(typed.setItemSizesAnchored(first, 1, 1.0f, 5), 250.0f);
}

static void testTypeAverages() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(100.0f);
  core.setItemCount(10);
  // Types: [1, 2, 2, 2, 2, 1, 2, 2, 2, 2] (headers and rows).
  const uint16_t types[] = {1, 2, 2, 2, 2, 1, 2, 2, 2, 2};
  core.setItemTypes(types, 10);
  CHECK_EQ_F(core.getTotalSize(), 1000.0f); // no samples yet → estimate everywhere
  // First row measurement: every unmeasured row adopts the mean.
  core.setItemSize(1, 40.0f);
  CHECK_EQ_F(core.getSize(2), 40.0f);
  CHECK_EQ_F(core.getSize(6), 40.0f);
  CHECK_EQ_F(core.getSize(0), 100.0f); // headers untouched (no type-1 samples)
  CHECK_EQ_F(core.getTotalSize(), 2 * 100.0f + 8 * 40.0f);
  // Second sample: mean = 50; unmeasured rows sweep to 50, measured keep real.
  core.setItemSize(2, 60.0f);
  CHECK_EQ_F(core.getSize(1), 40.0f);
  CHECK_EQ_F(core.getSize(3), 50.0f);
  // Re-measure adjusts the mean in place without inflating the count:
  // mean = 50 + (80-40)/2 = 70.
  core.setItemSize(1, 80.0f);
  CHECK_EQ_F(core.getSize(3), 70.0f);
  // Header measurement only affects headers.
  core.setItemSize(0, 200.0f);
  CHECK_EQ_F(core.getSize(5), 200.0f);
  CHECK_EQ_F(core.getSize(3), 70.0f);
  // resetItemSizes lands on type means, not the global estimate.
  core.resetItemSizes();
  CHECK_EQ_F(core.getSize(0), 200.0f);
  CHECK_EQ_F(core.getSize(1), 70.0f);
  // Estimate changes don't touch types that have samples.
  core.setEstimate(500.0f);
  CHECK_EQ_F(core.getSize(1), 70.0f);
}

static void testSeedTypeMeans() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(100.0f);
  core.setItemCount(10);
  // Types: [1, 2, 2, 2, 2, 1, 2, 2, 2, 2] (headers and rows).
  const uint16_t types[] = {1, 2, 2, 2, 2, 1, 2, 2, 2, 2};
  core.setItemTypes(types, 10);
  const int32_t versionBefore = core.getLayoutVersion();

  // Seeds land on unmeasured items of their type; invalid entries are skipped.
  const double seeds[] = {1, 200.0, 2, 40.0, 0, 77.0, -3, 50.0, 9999, 50.0, 5, -10.0};
  CHECK(core.seedTypeMeans(seeds, 6, 1.0f));
  CHECK_EQ_F(core.getSize(0), 200.0f);
  CHECK_EQ_F(core.getSize(1), 40.0f);
  CHECK_EQ_F(core.getTotalSize(), 2 * 200.0f + 8 * 40.0f);
  CHECK(core.getLayoutVersion() > versionBefore); // offsets moved → version bump

  // Seeds are estimates, not measurements: the first real sample replaces the
  // seed entirely and sweeps the type's unmeasured items.
  core.setItemSize(1, 60.0f);
  CHECK_EQ_F(core.getSize(1), 60.0f);
  CHECK_EQ_F(core.getSize(2), 60.0f);

  // A type with real samples ignores later seeds.
  const double staleSeed[] = {2, 40.0};
  CHECK(!core.seedTypeMeans(staleSeed, 1, 1.0f));
  CHECK_EQ_F(core.getSize(3), 60.0f);

  // resetItemSizes reverts to the seed (type 1) / real mean (type 2) — and
  // since seeds never marked anything measured, nothing survives as "real".
  core.resetItemSizes();
  CHECK_EQ_F(core.getSize(0), 200.0f);
  CHECK_EQ_F(core.getSize(1), 60.0f);

  // Scale converts to native units like setItemSizes (Android px path).
  LayoutCore scaled;
  scaled.setTypeAverages(true);
  scaled.setEstimate(100.0f);
  scaled.setItemCount(2);
  const uint16_t oneType[] = {3, 3};
  scaled.setItemTypes(oneType, 2);
  const double dpSeed[] = {3, 40.0};
  CHECK(scaled.seedTypeMeans(dpSeed, 1, 2.0f));
  CHECK_EQ_F(scaled.getSize(0), 80.0f);

  // No-op while type averages are disabled.
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
  // viewport 500, draw 200 at scroll 1000 → items 8..16 (see range basics).
  const int32_t n = core.fillLayoutSlab(slab, 4 + 2 * 32, 1000.0f, 500.0f, 200.0f, 1.0f);
  CHECK(n == 9);
  CHECK(static_cast<int32_t>(slab[2]) == 8 && static_cast<int32_t>(slab[3]) == 16);
  CHECK_EQ_F(static_cast<float>(slab[1]), 10000.0f); // total
  CHECK_EQ_F(static_cast<float>(slab[4]), 800.0f);   // offset(8)
  CHECK_EQ_F(static_cast<float>(slab[5]), 100.0f);   // size(8)
  CHECK_EQ_F(static_cast<float>(slab[4 + 16]), 1600.0f); // offset(16)
  // Output scaling (Android: 1/density so JS receives dp).
  core.fillLayoutSlab(slab, 4 + 2 * 32, 1000.0f, 500.0f, 200.0f, 0.5f);
  CHECK_EQ_F(static_cast<float>(slab[1]), 5000.0f);
  CHECK_EQ_F(static_cast<float>(slab[4]), 400.0f);
  // Too-small capacity → -1, nothing usable written.
  CHECK(core.fillLayoutSlab(slab, 6, 1000.0f, 500.0f, 200.0f, 1.0f) == -1);
  // Empty list → header only, zero items.
  LayoutCore empty;
  const int32_t none = empty.fillLayoutSlab(slab, 8, 0.0f, 500.0f, 200.0f, 1.0f);
  CHECK(none == 0);
  CHECK(static_cast<int32_t>(slab[3]) == -1);
}

// Deterministic clock for the directional-buffer tests.
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

  // First sample: no velocity yet → symmetric split.
  gFakeNowMs = 0.0;
  auto r0 = core.getEngagedRange(4800.0f, viewportH, draw);
  CHECK(r0.start == 45); // top = 4550 → bottomEdge(45) = 4600 > 4550
  // Scrolling down at 100 units / 16ms = 6250 u/s → regime +1:
  // top buffer shrinks to 125, bottom grows to 375.
  gFakeNowMs = 16.0;
  core.getEngagedRange(4900.0f, viewportH, draw);
  gFakeNowMs = 32.0;
  auto down = core.getEngagedRange(5000.0f, viewportH, draw);
  CHECK(down.start == 48); // top = 4875 → first bottomEdge > 4875 is 4900 (i=48)
  CHECK(down.end == 61);   // bottom = 6175 → last topEdge < 6175 is 6100 (i=61)

  // Budget conservation: same item count as the symmetric window would hold.
  CHECK(down.end - down.start == 13);

  // Fast path must stay correct within the directional window.
  gFakeNowMs = 48.0;
  auto small = core.getEngagedRange(5010.0f, viewportH, draw);
  CHECK(small.start == 48 && small.end == 61);

  // Direction reversal flips the split on the next computation.
  gFakeNowMs = 64.0;
  auto up = core.getEngagedRange(4900.0f, viewportH, draw);
  CHECK(up.start == 45); // top = 4525 → first bottomEdge > 4525 is 4600 (i=45)
  CHECK(up.end == 58);   // bottom = 5825 → last topEdge < 5825 is 5800 (i=58)

  // A long pause means a new gesture: stale velocity resets to symmetric.
  gFakeNowMs = 1000.0;
  auto idle = core.getEngagedRange(5000.0f, viewportH, draw);
  CHECK(idle.start == 47); // top = 4750 → symmetric again
  CHECK(idle.end == 60);   // bottom = 6050

  // Disabled → always symmetric, regardless of motion.
  core.setDirectionalBuffers(false);
  gFakeNowMs = 1016.0;
  core.getEngagedRange(5100.0f, viewportH, draw);
  gFakeNowMs = 1032.0;
  auto off = core.getEngagedRange(5200.0f, viewportH, draw);
  CHECK(off.start == 49); // top = 4950
  CHECK(off.end == 62);   // bottom = 6250
}

static void testEstimatesFrozen() {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setEstimate(100.0f);
  core.setItemCount(100);
  std::vector<uint16_t> types(100, 1);
  core.setItemTypes(types.data(), 100);

  // First measurement: mean 200 → sweep rewrites every unmeasured item.
  core.setItemSize(0, 200.0f);
  CHECK(core.getSize(50) == 200.0f);

  // Frozen: the mean keeps learning but the drift is not swept.
  CHECK(core.setEstimatesFrozen(true) == false);
  core.setItemSize(1, 400.0f); // mean drifts to 300
  CHECK(core.getSize(1) == 400.0f);  // real measurements still land
  CHECK(core.getSize(50) == 200.0f); // unmeasured items stay put

  // Idempotent freeze, then unfreeze runs the catch-up sweep.
  CHECK(core.setEstimatesFrozen(true) == false);
  CHECK(core.setEstimatesFrozen(false) == true);
  CHECK(core.getSize(50) == 300.0f);
  CHECK(core.getTotalSize() == 200.0f + 400.0f + 98.0f * 300.0f);

  // Unfreeze with no pending drift reports no change.
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

  // Build downward velocity (same cadence as testDirectionalBuffers).
  gFakeNowMs = 2000.0;
  core.getEngagedRange(4800.0f, viewportH, draw);
  gFakeNowMs = 2016.0;
  core.getEngagedRange(4900.0f, viewportH, draw);
  gFakeNowMs = 2032.0;
  auto moving = core.getEngagedRange(5000.0f, viewportH, draw);
  CHECK(moving.start == 48); // regime +1: top buffer shrank to 125

  // A programmatic jump right after the reset must NOT read as a fling:
  // it re-baselines and the split stays symmetric. Without the reset this
  // 10000-unit/8ms jump would flip regime +1 and start would be 148.
  core.resetScrollVelocity();
  gFakeNowMs = 2040.0;
  auto jumped = core.getEngagedRange(15000.0f, viewportH, draw);
  CHECK(jumped.start == 147); // top = 14750 (symmetric ±250)
  CHECK(jumped.end == 160);   // bottom = 16050

  // The next real sample computes velocity from the post-jump baseline.
  gFakeNowMs = 2056.0;
  auto after = core.getEngagedRange(15100.0f, viewportH, draw);
  CHECK(after.start == 149); // 100 units/16ms → regime +1 again (top 14975)
  CHECK(after.end == 162);   // bottom = 16275
}

static void testRandomizedDifferential() {
  // Drive LayoutCore and the naive reference with the same operation stream;
  // any divergence means one of the caching layers (minDirtyIndex, cursor,
  // boundary window, version) served stale data. Fixed seed → reproducible.
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
      // Scroll (dominant op, exercises cursor + boundary window).
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
      // Measure a random index (often near the "viewport" to mimic reality).
      std::uniform_int_distribution<int32_t> idxDist(0, count > 0 ? count - 1 : 0);
      const int32_t idx = idxDist(rng);
      const float size = sizeDist(rng);
      core.setItemSize(idx, size);
      ref.setItemSize(idx, size);
    } else if (op < 92) {
      // Batch of 5.
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
      // Count change.
      std::uniform_int_distribution<int32_t> countDist(0, 400);
      count = countDist(rng);
      core.setItemCount(count);
      ref.setItemCount(count);
    } else if (op < 98) {
      // Estimate change.
      const float estimate = sizeDist(rng);
      core.setEstimate(estimate);
      ref.setEstimate(estimate);
    } else {
      core.resetItemSizes();
      ref.resetItemSizes();
    }
    // Cheap invariants every step.
    if (std::abs(core.getTotalSize() - ref.totalSize()) > 1e-2f) {
      std::printf("FAIL differential step %d: total %f != %f\n", step,
                  static_cast<double>(core.getTotalSize()), static_cast<double>(ref.totalSize()));
      failures++;
      return;
    }
  }
  // Spot-check offsets at the end.
  for (int32_t i = 0; i < count; i += 7) {
    CHECK_EQ_F(core.getOffset(i), ref.offsetOf(i));
  }
}

int main() {
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
  testSeedTypeMeans();
  testFillLayoutSlab();
  testDirectionalBuffers();
  testEstimatesFrozen();
  testResetScrollVelocity();
  testRandomizedDifferential();
  if (failures == 0) {
    std::printf("OK — all LayoutCore tests passed\n");
    return 0;
  }
  std::printf("%d failure(s)\n", failures);
  return 1;
}
