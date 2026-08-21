#pragma once

#include <cstdint>
#include <mutex>
#include <vector>

namespace margelo::nitro::nitrolist {

/**
 * Shared C++ layout engine for NitroList — the single source of truth for
 * per-index sizes/offsets and the engaged-range computation, used by both
 * platforms (iOS via the `NitroListLayoutCore` ObjC++ bridge, Android via
 * the `LayoutManager` JNI bridge). Replaces the previously hand-mirrored
 * Swift/Kotlin `LayoutManager`s.
 *
 * Units are the platform's native layout unit (points on iOS, pixels on
 * Android) — the core never converts; callers do at their boundary.
 *
 * Thread-safety: every public method takes the internal mutex. Hybrid
 * methods called via JSI run on the JS thread; the platform view reads
 * totalSize on the main/UI thread. Both go through this lock.
 *
 * Storage is struct-of-arrays (parallel vectors) and float — offsets are
 * sums of 1/8-quantized sizes, so float stays exact up to ~2^21 units of
 * total content, matching the precision profile Android always had.
 */
class LayoutCore {
public:
  struct EngagedRange {
    int32_t start;
    int32_t end;
    int32_t version;
  };

  /** Returns true if the count actually changed (arrays grew/shrunk). */
  bool setItemCount(int32_t count);

  /**
   * Replaces the size of every unmeasured item. Returns true if any size
   * changed. Measured items are untouched.
   */
  bool setEstimate(float value);

  /**
   * Deltas ≤ epsilon are treated as measurement noise, not size changes.
   * Set once from the display scale (≈1 physical pixel).
   */
  void setMeasurementEpsilon(float value);

  /** Returns true if the size for `index` actually changed. */
  bool setItemSize(int32_t index, float size);

  /**
   * Batched `setItemSize`. `pairs` points at `pairCount` pairs laid out as
   * `[idx0, size0, idx1, size1, ...]` (doubles, straight from a JS
   * Float64Array). `scale` converts incoming sizes to native units (display
   * density on Android, 1 on iOS). Returns true if any stored size changed.
   */
  bool setItemSizes(const double* pairs, int32_t pairCount, float scale);

  /**
   * `setItemSizes` variant for maintainVisibleContentPosition: applies the
   * batch and returns how much `anchorIndex`'s top offset moved as a result
   * (native units) — mutation and both offset reads happen under one lock
   * acquisition, so no concurrent mutation can interleave and skew the diff.
   * Sizes at/below the anchor don't move it, so the return is 0 for them by
   * construction. Invalid anchor → batch applies normally, returns 0.
   */
  float setItemSizesAnchored(const double* pairs, int32_t pairCount, float scale,
                             int32_t anchorIndex);

  /**
   * Forgets every measured size and reverts all items to their best estimate
   * (per-type running mean when the type has samples, else the global
   * estimate — type statistics survive data changes on purpose: the render
   * templates didn't change, only which item sits at which index). Returns
   * true if anything changed.
   */
  bool resetItemSizes();

  /**
   * Structural-change alternative to resetItemSizes: moves surviving
   * measurements to their new indices instead of dropping them. `pairs`
   * holds `pairCount` pairs laid out as `[oldIdx0, newIdx0, oldIdx1,
   * newIdx1, ...]` (doubles, straight from a JS Float64Array) and must be
   * the COMPLETE survivor map — any index not named as a newIdx target is
   * treated as new content and falls back to its type mean / global
   * estimate, exactly like resetItemSizes would leave it. Only measured
   * sources move; unmeasured, out-of-range and non-finite pairs are
   * skipped. Type means are untouched: the moved sizes were already
   * counted, re-feeding them would double-count. Must be called after
   * setItemCount resized to the new length — slots cleared by a shrink are
   * gone by then, so a shrink loses the trimmed tail's measurements by
   * design. Returns true if any size or measured flag changed.
   */
  bool remapItemSizes(const double* pairs, int32_t pairCount);

  /**
   * Full reset for Fabric view recycling (`prepareForRecycle`): drops all item
   * state, caches, type statistics and velocity tracking, and releases the
   * heap storage. Configuration set once by the platform wrapper (measurement
   * epsilon, directional buffers, type averages) survives — the recycled view
   * keeps the same wrapper and the same display.
   */
  void resetAll();

  /**
   * Bytes of heap storage currently owned by the item arrays and type stats
   * (capacity-based). Feeds the Hybrid Object's `memorySize` so the JS GC
   * sees the native weight of large lists.
   */
  size_t getMemoryFootprint();

  /**
   * One type id per index (0 = untyped). Unmeasured items of a type with
   * measured samples use that type's running mean instead of the global
   * estimate. `count` may differ from itemCount — missing tail is untyped.
   */
  void setItemTypes(const uint16_t* types, int32_t count);

  /**
   * When enabled, every real measurement feeds an incremental per-type mean
   * (re-measures adjust in place: mean += (size − prev)/num; new samples:
   * mean = (mean·num + size)/(num+1)), and unmeasured items of that type are
   * swept to the mean whenever it drifts. Converges far-offset accuracy after
   * measuring only a screenful. Default off — platform wrappers enable it;
   * the differential test validates the cache layers with it off.
   */
  void setTypeAverages(bool enabled);

  /**
   * Seeds per-type mean estimates from a cross-mount cache (the JS side's
   * measurementCache.ts). `pairs` holds `pairCount` pairs laid
   * out as `[typeId0, mean0, typeId1, mean1, ...]` (doubles, straight from a
   * JS Float64Array); `scale` converts means to native units, like
   * `setItemSizes`. A seed only lands on a type with NO real samples — real
   * measurements always win — and it never marks anything measured: seeds are
   * estimates, so a wrong seed corrects itself through the normal measurement
   * path (the recycling-v1 lesson: synthetic sizes must never masquerade as
   * measurements). Unmeasured items of seeded types re-resolve immediately.
   * No-op while type averages are disabled. Returns true if any stored size
   * changed.
   */
  bool seedTypeMeans(const double* pairs, int32_t pairCount, float scale);

  /**
   * Atomically computes the engaged range and copies its layout into `out`
   * as doubles: `[layoutVersion, totalSize, start, end, offset(start),
   * size(start), …, offset(end), size(end)]`, all multiplied by
   * `outputScale` (1/density on Android so JS receives dp; 1 on iOS).
   * Returns the number of items written, or -1 when `capacityDoubles` is too
   * small (caller grows the buffer and retries). One lock, one JSI call —
   * replaces 2×range per-item getter round-trips.
   */
  int32_t fillLayoutSlab(double* out, int32_t capacityDoubles, float scrollOffset,
                         float viewportHeight, float drawDistance, float outputScale);

  /**
   * Grid mode: items are laid out in rows of `columns` span-units; items in
   * the same row share one offset and the row advances by its tallest item.
   * Values < 1 clamp to 1 (the classic 1-D list). Changing the column count
   * changes every cell's width, which invalidates every measured size AND
   * the per-type means — both are dropped here (sizes revert to the global
   * estimate) so stale heights can never leak into the new geometry.
   */
  void setColumnCount(int32_t columns);

  /**
   * Optional per-index span map (span-units of the row each item occupies,
   * clamped to [1, columnCount]). `count` may differ from itemCount —
   * missing tail defaults to 1, like setItemTypes. Spans only regroup rows;
   * sizes/measured flags are untouched. Returns true if any span changed.
   */
  bool setItemSpans(const uint16_t* spans, int32_t count);

  /**
   * Copies the per-type running means into `out` as triples
   * `[typeId, mean * outputScale, sampleCount]`, one per type that has real
   * measured samples (seeded-only types are estimates, not observations —
   * excluded on purpose). Returns the number of triples written, or -1 when
   * `capacityDoubles` is too small (caller grows the buffer and retries,
   * same contract as fillLayoutSlab). Feeds the public
   * `getAverageItemSizes()` DX surface for estimatedItemSize tuning.
   */
  int32_t fillTypeStats(double* out, int32_t capacityDoubles, float outputScale);

  float getTotalSize();
  /** Out-of-range indices return 0. */
  float getOffset(int32_t index);
  /** Out-of-range indices return 0. */
  float getSize(int32_t index);
  int32_t getLayoutVersion();

  /**
   * When enabled, `drawDistance` is redistributed by scroll direction:
   * 1.5× ahead of the movement, 0.5× behind (same total render budget as the
   * symmetric ±1× split, placed where the user is heading). Velocity is
   * estimated internally from successive scroll offsets. Default off —
   * platform wrappers turn it on; tests control it explicitly.
   */
  void setDirectionalBuffers(bool enabled);

  /**
   * While frozen, type-mean drift is NOT swept into unmeasured sizes — real
   * measurements still land and still feed the means; only the propagation
   * pauses. JS freezes around imperative scroll sessions: a drifting mean
   * moves every unmeasured offset, which moves the scroll target mid-flight
   * (the measure→mean→position→target feedback loop; LegendList freezes an
   * `averageSizeSnapshot` for the same reason). Unfreezing runs one catch-up
   * sweep; returns true if it changed any size. Cleared by resetAll.
   */
  bool setEstimatesFrozen(bool frozen);

  /**
   * Forgets the velocity estimate and its sample baseline. Platform wrappers
   * call it right before a programmatic offset change (imperative scrollTo,
   * MVCP correction): the jump is synthetic — sampling it would read as a
   * huge fling and flip the directional regime for the following frames. The
   * next offset change after the reset re-baselines without producing a
   * velocity (LegendList wipes its scroll history at the same boundaries).
   */
  void resetScrollVelocity();

  /**
   * Test hook: replaces the monotonic clock used for velocity estimation
   * (milliseconds as double). Pass nullptr to restore the default.
   */
  using ClockFn = double (*)();
  void setClockForTesting(ClockFn clock);

  /**
   * The slice of items intersecting
   * `[scrollOffset - bufferBehind, scrollOffset + viewportHeight + bufferAhead]`
   * (both buffers = `drawDistance` when symmetric — see
   * `setDirectionalBuffers`). Serves from the boundary-window cache (O(1))
   * while the scroll stays inside the window and nothing was mutated;
   * otherwise binary-searches the prefix sums (O(log n) — jump-friendly).
   * Empty list or zero viewport returns `{0, -1, version}`.
   */
  EngagedRange getEngagedRange(float scrollOffset, float viewportHeight, float drawDistance);

private:
  struct TypeStats {
    // Means live in double on purpose: float means made the running-mean
    // arithmetic sensitive to FMA contraction (clang fuses `mean*num + size`
    // into one rounding), which broke bit-parity with the TS test mirror the
    // moment a mean landed on a 1/8-quantization boundary. Doubles make the
    // chain exactly reproducible in JS number math, and the stats table is
    // tiny.
    double mean = 0.0;
    double appliedMean = 0.0; // last mean swept into unmeasured sizes
    int32_t num = 0;          // distinct measured items of this type
    bool seeded = false;      // mean pre-filled from a cross-mount cache (num == 0)
  };

  /** Recomputes offsets/totalSize from minDirtyIndex_. Lock must be held. */
  void ensureClean();

  /** Shared body of getEngagedRange/fillLayoutSlab. Lock must be held. */
  EngagedRange computeEngagedRangeLocked(float scrollOffset, float viewportHeight,
                                         float drawDistance);

  /** Shared batch-apply loop of setItemSizes/setItemSizesAnchored. Lock held. */
  bool applyItemSizesLocked(const double* pairs, int32_t pairCount, float scale);

  /** Feeds one real measurement into its type's running mean. Lock held. */
  void updateTypeMeanLocked(int32_t index, bool wasMeasured, float prevSize, float newSize);

  /**
   * Sweeps drifted type means into unmeasured sizes (single O(N) pass);
   * no-op while estimates are frozen. Returns true if any size changed.
   * Lock held.
   */
  bool applyTypeMeansLocked();

  /** Best size for an unmeasured item of `type` (mean or estimate), rounded. Lock held. */
  float estimateForTypeLocked(uint16_t type) const;

  /**
   * Sub-unit jitter → layout thrashing; align to 1/8. Round to nearest (not
   * floor): flooring systematically under-estimates every size and the error
   * accumulates up to N×⅛ on the total.
   */
  static float roundToOctave(float value);

  /** Double-precision variant for type means (result still a float size). */
  static float roundToOctaveFromDouble(double value);

  std::mutex mutex_;

  /** Effective span of `index` (clamped to the live column count). Lock held. */
  int32_t spanAtLocked(int32_t index) const;

  // Struct-of-arrays item storage.
  std::vector<float> sizes_;
  std::vector<float> offsets_;
  std::vector<uint8_t> measured_;
  std::vector<uint16_t> types_;
  std::vector<uint16_t> spans_;

  // Grid state: 1 = classic 1-D list. rowStart_[i] is the first index of
  // i's row, valid after ensureClean (used to restart partial layouts and
  // to widen engaged ranges to full rows).
  int32_t columnCount_ = 1;
  std::vector<int32_t> rowStart_;

  // Per-type running means, indexed by type id (grown on demand).
  bool typeAverages_ = false;
  bool estimatesFrozen_ = false;
  std::vector<TypeStats> typeStats_;

  int32_t itemCount_ = 0;
  float estimate_ = 0.0f;
  float totalSize_ = 0.0f;
  float measurementEpsilon_ = 0.0f;

  // Smallest index whose offset/totalSize may be stale; recomputed lazily.
  int32_t minDirtyIndex_ = INT32_MAX;

  // Bumped whenever offsets shift. Lets JS detect "same range, positions moved".
  int32_t layoutVersion_ = 0;

  // Boundary-window cache: the scroll interval (strictly) inside which the
  // last computed range is guaranteed unchanged.
  bool hasRangeWindow_ = false;
  float rangeWindowMin_ = 0.0f;
  float rangeWindowMax_ = 0.0f;
  float rangeWindowViewport_ = -1.0f;
  float rangeWindowDraw_ = -1.0f;
  int32_t cachedStart_ = 0;
  int32_t cachedEnd_ = -1;
  int32_t cachedVersion_ = -1;
  int32_t cachedRegime_ = 0;

  // Direction-aware draw-distance state (see setDirectionalBuffers).
  // regime ∈ {-1, 0, +1}: -1 scrolling up, +1 scrolling down, 0 idle/slow.
  bool directionalBuffers_ = false;
  ClockFn clock_ = nullptr; // nullptr → default steady_clock
  double lastSampleTimeMs_ = -1.0;
  float lastSampleOffset_ = 0.0f;
  float velocity_ = 0.0f; // units per second, signed
};

} // namespace margelo::nitro::nitrolist
