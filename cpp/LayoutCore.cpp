#include "LayoutCore.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace margelo::nitro::nitrolist {

namespace {

// Directional draw-distance split: same 2× total budget as the symmetric
// ±1× split, redistributed toward where the user is heading (LegendList v3's
// numbers — its JS engine runs the same 0.5×/1.5× split; what it shipped
// disabled was velocity *position look-ahead*, a different mechanism).
constexpr float kBufferAheadRatio = 1.5f;
constexpr float kBufferBehindRatio = 0.5f;
// Below this speed the split stays symmetric — idle lists and sub-scroll
// jitter must not flap the regime.
constexpr float kDirectionalMinVelocity = 300.0f; // units/second
// A gap longer than this between scroll samples means a new gesture; the
// old velocity says nothing about it.
constexpr double kVelocityStaleMs = 200.0;

// A type mean must drift at least this far from its last swept value before
// unmeasured items are rewritten — sweeps happen a handful of times while
// the mean converges, then stop.
constexpr float kTypeMeanSweepThreshold = 0.5f;
// Sanity cap on distinct type ids (JS interning starts at 1 and stays tiny).
constexpr int32_t kMaxTypeStats = 4096;

double defaultClockMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

} // namespace

bool LayoutCore::setItemCount(int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (count == itemCount_ || count < 0) {
    return false;
  }
  const auto capacity = static_cast<int32_t>(sizes_.size());
  if (count > capacity) {
    sizes_.resize(count, 0.0f);
    offsets_.resize(count, 0.0f);
    measured_.resize(count, 0);
    types_.resize(count, 0);
  }
  if (count > itemCount_) {
    // Fill every newly-exposed slot with the estimate. Unlike the previous
    // Swift/Kotlin managers, this also covers re-growing within an old
    // allocation, where a prior shrink had zeroed the tail — zero-size items
    // would otherwise stack at one offset and blow up the engaged range
    // until each cell measured. Types reset to untyped; JS re-sends them
    // right after any length change.
    std::fill(sizes_.begin() + itemCount_, sizes_.begin() + count, estimate_);
    std::fill(measured_.begin() + itemCount_, measured_.begin() + count, 0);
    std::fill(types_.begin() + itemCount_, types_.begin() + count, 0);
  } else {
    // Shrink by clearing tail measured flags so re-grow uses the estimate.
    std::fill(sizes_.begin() + count, sizes_.begin() + itemCount_, 0.0f);
    std::fill(measured_.begin() + count, measured_.begin() + itemCount_, 0);
  }
  itemCount_ = count;
  minDirtyIndex_ = 0;
  // A count change can shrink the list without moving any surviving offset
  // (no layoutVersion bump), so the version check alone wouldn't catch a
  // cached range whose indices are now out of bounds.
  hasRangeWindow_ = false;
  return true;
}

void LayoutCore::setDirectionalBuffers(bool enabled) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (directionalBuffers_ == enabled) {
    return;
  }
  directionalBuffers_ = enabled;
  velocity_ = 0.0f;
  lastSampleTimeMs_ = -1.0;
  hasRangeWindow_ = false;
}

bool LayoutCore::setEstimatesFrozen(bool frozen) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (estimatesFrozen_ == frozen) {
    return false;
  }
  estimatesFrozen_ = frozen;
  if (frozen) {
    return false;
  }
  // Unfreeze: sweep the drift accumulated while frozen in one pass.
  return applyTypeMeansLocked();
}

void LayoutCore::resetScrollVelocity() {
  std::lock_guard<std::mutex> guard(mutex_);
  velocity_ = 0.0f;
  // -1 marks "no baseline": the next offset change records time/offset only,
  // so the synthetic jump itself can never become a velocity sample. The
  // cached range window survives — a regime change is caught by the fast
  // path's regime comparison.
  lastSampleTimeMs_ = -1.0;
}

void LayoutCore::setClockForTesting(ClockFn clock) {
  std::lock_guard<std::mutex> guard(mutex_);
  clock_ = clock;
  velocity_ = 0.0f;
  lastSampleTimeMs_ = -1.0;
  hasRangeWindow_ = false;
}

bool LayoutCore::setEstimate(float value) {
  std::lock_guard<std::mutex> guard(mutex_);
  const float rounded = roundToOctave(value);
  if (rounded == estimate_) {
    return false;
  }
  estimate_ = rounded;
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    // Items whose type already has measured samples are owned by the type
    // mean, not the global estimate.
    if (measured_[i] == 0 && estimateForTypeLocked(types_[i]) == rounded && sizes_[i] != rounded) {
      sizes_[i] = rounded;
      anyChanged = true;
      minDirtyIndex_ = std::min(minDirtyIndex_, i);
    }
  }
  return anyChanged;
}

void LayoutCore::setMeasurementEpsilon(float value) {
  std::lock_guard<std::mutex> guard(mutex_);
  measurementEpsilon_ = std::max(0.0f, value);
}

bool LayoutCore::setItemSize(int32_t index, float size) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (index < 0 || index >= itemCount_) {
    return false;
  }
  const float rounded = std::max(0.0f, roundToOctave(size));
  if (measured_[index] != 0 && std::abs(sizes_[index] - rounded) <= measurementEpsilon_) {
    return false;
  }
  updateTypeMeanLocked(index, measured_[index] != 0, sizes_[index], rounded);
  sizes_[index] = rounded;
  measured_[index] = 1;
  minDirtyIndex_ = std::min(minDirtyIndex_, index);
  applyTypeMeansLocked();
  return true;
}

bool LayoutCore::setItemSizes(const double* pairs, int32_t pairCount, float scale) {
  std::lock_guard<std::mutex> guard(mutex_);
  return applyItemSizesLocked(pairs, pairCount, scale);
}

float LayoutCore::setItemSizesAnchored(const double* pairs, int32_t pairCount, float scale,
                                       int32_t anchorIndex) {
  std::lock_guard<std::mutex> guard(mutex_);
  const bool anchorValid = anchorIndex >= 0 && anchorIndex < itemCount_;
  float before = 0.0f;
  if (anchorValid) {
    ensureClean();
    before = offsets_[anchorIndex];
  }
  const bool anyChanged = applyItemSizesLocked(pairs, pairCount, scale);
  if (!anchorValid || !anyChanged) {
    return 0.0f;
  }
  ensureClean();
  return offsets_[anchorIndex] - before;
}

bool LayoutCore::applyItemSizesLocked(const double* pairs, int32_t pairCount, float scale) {
  if (pairs == nullptr || pairCount <= 0) {
    return false;
  }
  bool anyChanged = false;
  for (int32_t i = 0; i < pairCount; i++) {
    const auto idx = static_cast<int32_t>(pairs[i * 2]);
    if (idx < 0 || idx >= itemCount_) {
      continue;
    }
    const float rounded = std::max(0.0f, roundToOctave(static_cast<float>(pairs[i * 2 + 1]) * scale));
    if (measured_[idx] != 0 && std::abs(sizes_[idx] - rounded) <= measurementEpsilon_) {
      continue;
    }
    updateTypeMeanLocked(idx, measured_[idx] != 0, sizes_[idx], rounded);
    sizes_[idx] = rounded;
    measured_[idx] = 1;
    minDirtyIndex_ = std::min(minDirtyIndex_, idx);
    anyChanged = true;
  }
  if (anyChanged) {
    applyTypeMeansLocked();
  }
  return anyChanged;
}

bool LayoutCore::resetItemSizes() {
  std::lock_guard<std::mutex> guard(mutex_);
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] != 0) {
      measured_[i] = 0;
      anyChanged = true;
    }
    // Type means survive the reset (the render templates didn't change, only
    // which item sits at which index) — items land on a much better guess
    // than the global estimate.
    const float target = estimateForTypeLocked(types_[i]);
    if (sizes_[i] != target) {
      sizes_[i] = target;
      anyChanged = true;
    }
  }
  if (anyChanged) {
    minDirtyIndex_ = 0;
    hasRangeWindow_ = false;
  }
  return anyChanged;
}

bool LayoutCore::remapItemSizes(const double* pairs, int32_t pairCount) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (pairs == nullptr || pairCount <= 0 || itemCount_ == 0) {
    return false;
  }
  // Build the post-remap state in scratch vectors: targets not named by any
  // pair resolve like resetItemSizes (type mean / estimate), and reading
  // sources from the untouched live arrays makes overlapping moves (prepend
  // shifts, swaps) order-independent.
  std::vector<float> newSizes(itemCount_);
  std::vector<uint8_t> newMeasured(itemCount_, 0);
  for (int32_t i = 0; i < itemCount_; i++) {
    newSizes[i] = estimateForTypeLocked(types_[i]);
  }
  const auto sourceLimit = static_cast<int32_t>(sizes_.size());
  for (int32_t p = 0; p < pairCount; p++) {
    const double oldRaw = pairs[p * 2];
    const double newRaw = pairs[p * 2 + 1];
    // NaN-safe bounds gate; the upper bound also keeps the int32 cast defined.
    if (!(oldRaw >= 0.0) || !(newRaw >= 0.0) || oldRaw > 2000000000.0 || newRaw > 2000000000.0) {
      continue;
    }
    const auto oldIdx = static_cast<int32_t>(oldRaw);
    const auto newIdx = static_cast<int32_t>(newRaw);
    if (oldIdx >= sourceLimit || newIdx >= itemCount_) {
      continue;
    }
    if (measured_[oldIdx] == 0) {
      continue;
    }
    newSizes[newIdx] = sizes_[oldIdx];
    newMeasured[newIdx] = 1;
  }
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] != newMeasured[i]) {
      measured_[i] = newMeasured[i];
      anyChanged = true;
    }
    if (sizes_[i] != newSizes[i]) {
      sizes_[i] = newSizes[i];
      anyChanged = true;
      minDirtyIndex_ = std::min(minDirtyIndex_, i);
    }
  }
  if (anyChanged) {
    hasRangeWindow_ = false;
  }
  return anyChanged;
}

void LayoutCore::resetAll() {
  std::lock_guard<std::mutex> guard(mutex_);
  // shrink_to_fit via swap-with-empty: the recycled view may serve a much
  // smaller list next; keeping a 10k-item allocation alive would defeat the
  // memory point of recycling.
  std::vector<float>().swap(sizes_);
  std::vector<float>().swap(offsets_);
  std::vector<uint8_t>().swap(measured_);
  std::vector<uint16_t>().swap(types_);
  std::vector<TypeStats>().swap(typeStats_);
  itemCount_ = 0;
  estimate_ = 0.0f;
  totalSize_ = 0.0f;
  estimatesFrozen_ = false;
  minDirtyIndex_ = INT32_MAX;
  layoutVersion_ = 0;
  hasRangeWindow_ = false;
  rangeWindowMin_ = 0.0f;
  rangeWindowMax_ = 0.0f;
  rangeWindowViewport_ = -1.0f;
  rangeWindowDraw_ = -1.0f;
  cachedStart_ = 0;
  cachedEnd_ = -1;
  cachedVersion_ = -1;
  cachedRegime_ = 0;
  lastSampleTimeMs_ = -1.0;
  lastSampleOffset_ = 0.0f;
  velocity_ = 0.0f;
}

size_t LayoutCore::getMemoryFootprint() {
  std::lock_guard<std::mutex> guard(mutex_);
  return sizes_.capacity() * sizeof(float) + offsets_.capacity() * sizeof(float) +
         measured_.capacity() * sizeof(uint8_t) + types_.capacity() * sizeof(uint16_t) +
         typeStats_.capacity() * sizeof(TypeStats);
}

void LayoutCore::setItemTypes(const uint16_t* types, int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (static_cast<int32_t>(types_.size()) < itemCount_) {
    types_.resize(itemCount_, 0);
  }
  for (int32_t i = 0; i < itemCount_; i++) {
    types_[i] = (types != nullptr && i < count) ? types[i] : 0;
  }
  // Re-resolve every unmeasured size against its (possibly new) type — this
  // also reverts items whose new type has no samples back to the estimate.
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] != 0) {
      continue;
    }
    const float target = estimateForTypeLocked(types_[i]);
    if (sizes_[i] != target) {
      sizes_[i] = target;
      minDirtyIndex_ = std::min(minDirtyIndex_, i);
    }
  }
}

bool LayoutCore::seedTypeMeans(const double* pairs, int32_t pairCount, float scale) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (!typeAverages_ || pairs == nullptr || pairCount <= 0) {
    return false;
  }
  bool anySeeded = false;
  for (int32_t p = 0; p < pairCount; p++) {
    const auto type = static_cast<int32_t>(pairs[2 * p]);
    const float mean = roundToOctave(static_cast<float>(pairs[2 * p + 1]) * scale);
    // Type 0 is "untyped" — never seeded; invalid ids and non-positive/NaN
    // means are cache garbage, not samples.
    if (type <= 0 || type >= kMaxTypeStats || !(mean > 0.0f)) {
      continue;
    }
    if (static_cast<int32_t>(typeStats_.size()) <= type) {
      typeStats_.resize(type + 1);
    }
    TypeStats& stats = typeStats_[type];
    if (stats.num > 0) {
      continue; // real samples own this type
    }
    stats.mean = mean;
    // appliedMean too: the re-resolve below IS the sweep for this seed; the
    // next real sweep should trigger only on drift from real samples.
    stats.appliedMean = mean;
    stats.seeded = true;
    anySeeded = true;
  }
  if (!anySeeded) {
    return false;
  }
  // Re-resolve every unmeasured size against its (possibly seeded) type —
  // same pass shape as setItemTypes.
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] != 0) {
      continue;
    }
    const float target = estimateForTypeLocked(types_[i]);
    if (sizes_[i] != target) {
      sizes_[i] = target;
      anyChanged = true;
      minDirtyIndex_ = std::min(minDirtyIndex_, i);
    }
  }
  return anyChanged;
}

void LayoutCore::setTypeAverages(bool enabled) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (typeAverages_ == enabled) {
    return;
  }
  typeAverages_ = enabled;
  typeStats_.clear();
}

float LayoutCore::getTotalSize() {
  std::lock_guard<std::mutex> guard(mutex_);
  ensureClean();
  return totalSize_;
}

float LayoutCore::getOffset(int32_t index) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (index < 0 || index >= itemCount_) {
    return 0.0f;
  }
  ensureClean();
  return offsets_[index];
}

float LayoutCore::getSize(int32_t index) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (index < 0 || index >= itemCount_) {
    return 0.0f;
  }
  return sizes_[index];
}

int32_t LayoutCore::getLayoutVersion() {
  std::lock_guard<std::mutex> guard(mutex_);
  ensureClean();
  return layoutVersion_;
}

LayoutCore::EngagedRange LayoutCore::getEngagedRange(float scrollOffset,
                                                     float viewportHeight,
                                                     float drawDistance) {
  std::lock_guard<std::mutex> guard(mutex_);
  return computeEngagedRangeLocked(scrollOffset, viewportHeight, drawDistance);
}

int32_t LayoutCore::fillLayoutSlab(double* out, int32_t capacityDoubles, float scrollOffset,
                                   float viewportHeight, float drawDistance, float outputScale) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (out == nullptr || capacityDoubles < 4) {
    return -1;
  }
  const EngagedRange range = computeEngagedRangeLocked(scrollOffset, viewportHeight, drawDistance);
  const int32_t count = range.end >= range.start ? range.end - range.start + 1 : 0;
  if (capacityDoubles < 4 + count * 2) {
    return -1;
  }
  // Offsets/totalSize are clean here: the fast path only serves when nothing
  // is dirty, and the slow path ran ensureClean.
  out[0] = range.version;
  out[1] = static_cast<double>(totalSize_) * outputScale;
  out[2] = range.start;
  out[3] = range.end;
  double* cursor = out + 4;
  for (int32_t i = range.start; i < range.start + count; i++) {
    *cursor++ = static_cast<double>(offsets_[i]) * outputScale;
    *cursor++ = static_cast<double>(sizes_[i]) * outputScale;
  }
  return count;
}

LayoutCore::EngagedRange LayoutCore::computeEngagedRangeLocked(float scrollOffset,
                                                               float viewportHeight,
                                                               float drawDistance) {
  // Velocity sampling — must happen before the fast path so the regime is
  // current even while cached ranges are being served. Only real offset
  // changes are samples; mutation-triggered re-queries repeat the offset.
  if (directionalBuffers_ && scrollOffset != lastSampleOffset_) {
    const double now = clock_ != nullptr ? clock_() : defaultClockMs();
    if (lastSampleTimeMs_ >= 0.0) {
      const double dt = now - lastSampleTimeMs_;
      if (dt > kVelocityStaleMs) {
        velocity_ = 0.0f; // new gesture — old velocity says nothing
      } else if (dt >= 1.0) {
        velocity_ = static_cast<float>((scrollOffset - lastSampleOffset_) / dt * 1000.0);
      }
      // dt < 1ms: burst of calls within the same tick — keep prior velocity.
    }
    lastSampleTimeMs_ = now;
    lastSampleOffset_ = scrollOffset;
  }
  int32_t regime = 0;
  if (directionalBuffers_ && std::abs(velocity_) >= kDirectionalMinVelocity) {
    regime = velocity_ > 0.0f ? 1 : -1;
  }
  // Split the draw budget by direction: `topBuffer` extends above the
  // viewport, `bottomBuffer` below. Same 2×drawDistance total in every
  // regime — only the placement moves.
  const float topBuffer = regime == 0    ? drawDistance
                          : regime > 0   ? drawDistance * kBufferBehindRatio
                                         : drawDistance * kBufferAheadRatio;
  const float bottomBuffer = regime == 0  ? drawDistance
                             : regime > 0 ? drawDistance * kBufferAheadRatio
                                          : drawDistance * kBufferBehindRatio;
  // Fast path: while the scroll stays strictly inside the cached window and
  // nothing was mutated (clean + same version + same viewport/draw/regime),
  // the range cannot have changed — skip ensureClean and the search. Most
  // scroll events during continuous scrolling land here.
  if (hasRangeWindow_ && minDirtyIndex_ == INT32_MAX && cachedVersion_ == layoutVersion_ &&
      viewportHeight == rangeWindowViewport_ && drawDistance == rangeWindowDraw_ &&
      regime == cachedRegime_ && scrollOffset > rangeWindowMin_ &&
      scrollOffset < rangeWindowMax_) {
    return EngagedRange{cachedStart_, cachedEnd_, cachedVersion_};
  }
  ensureClean();
  if (itemCount_ == 0 || viewportHeight <= 0.0f) {
    hasRangeWindow_ = false;
    return EngagedRange{0, -1, layoutVersion_};
  }
  const float top = std::max(0.0f, scrollOffset - topBuffer);
  const float bottom = std::min(totalSize_, scrollOffset + viewportHeight + bottomBuffer);
  if (totalSize_ <= top) {
    // Scrolled past the end — clamp to the last item.
    hasRangeWindow_ = false;
    return EngagedRange{itemCount_ - 1, itemCount_ - 1, layoutVersion_};
  }
  // Offsets are contiguous prefix sums (offsets[i] + sizes[i] == offsets[i+1],
  // with totalSize as the virtual last edge), so both bounds binary-search:
  //   start = smallest i whose bottom edge is  > top
  //   end   = largest  i whose top    edge is  < bottom
  // O(log n) regardless of jump size — scrubbing and scrollToIndex cost the
  // same as a 1-item step (which the boundary window mostly absorbs anyway).
  const auto beginIt = offsets_.begin() + 1;
  const auto endIt = offsets_.begin() + itemCount_;
  const auto startIt = std::upper_bound(beginIt, endIt, top);
  const auto start = static_cast<int32_t>(startIt - offsets_.begin()) - 1;
  const auto endSearchIt = std::lower_bound(offsets_.begin() + start, endIt, bottom);
  int32_t end = static_cast<int32_t>(endSearchIt - offsets_.begin()) - 1;
  end = std::clamp(end, start, itemCount_ - 1);
  // Cache the scroll window in which this exact range stays valid:
  //   start holds while  bottomEdge(start-1) ≤ scroll-topBuffer < bottomEdge(start)
  //   end   holds while  offsets(end) < scroll+viewport+bottomBuffer ≤ offsets(end+1)
  // Solved for scroll (strict on both sides; the boundary itself recomputes).
  float lower = offsets_[end] - viewportHeight - bottomBuffer;
  if (start > 0) {
    lower = std::max(lower, offsets_[start - 1] + sizes_[start - 1] + topBuffer);
  }
  float upper = offsets_[start] + sizes_[start] + topBuffer;
  if (end < itemCount_ - 1) {
    upper = std::min(upper, offsets_[end + 1] - viewportHeight - bottomBuffer);
  }
  cachedStart_ = start;
  cachedEnd_ = end;
  cachedVersion_ = layoutVersion_;
  cachedRegime_ = regime;
  rangeWindowMin_ = lower;
  rangeWindowMax_ = upper;
  rangeWindowViewport_ = viewportHeight;
  rangeWindowDraw_ = drawDistance;
  hasRangeWindow_ = upper > lower;
  return EngagedRange{start, end, layoutVersion_};
}

void LayoutCore::ensureClean() {
  // INT32_MAX means "nothing pending". Note this is deliberately NOT the old
  // `minDirtyIndex_ >= itemCount_` guard the Swift/Kotlin managers used: that
  // form skipped the pass when the list shrank to 0 items (0 >= 0), leaving
  // totalSize_ stale — an emptied list kept its old scrollable extent.
  if (minDirtyIndex_ == INT32_MAX) {
    return;
  }
  float off = minDirtyIndex_ == 0 ? 0.0f : offsets_[minDirtyIndex_ - 1] + sizes_[minDirtyIndex_ - 1];
  bool anyChanged = false;
  for (int32_t i = minDirtyIndex_; i < itemCount_; i++) {
    if (offsets_[i] != off) {
      offsets_[i] = off;
      anyChanged = true;
    }
    off += sizes_[i];
  }
  if (totalSize_ != off) {
    totalSize_ = off;
    anyChanged = true;
  }
  minDirtyIndex_ = INT32_MAX;
  // Only bump the version when offsets actually moved. A duplicate
  // setItemSize would otherwise force JS to invalidate its layout cache and
  // re-run sticky/viewability work for nothing.
  if (anyChanged) {
    layoutVersion_++;
  }
}

float LayoutCore::roundToOctave(float value) {
  return std::round(value * 8.0f) / 8.0f;
}

void LayoutCore::updateTypeMeanLocked(int32_t index, bool wasMeasured, float prevSize,
                                      float newSize) {
  if (!typeAverages_ || newSize <= 0.0f) {
    return; // zero sizes are conditional-rendering artifacts, not samples
  }
  const uint16_t type = index < static_cast<int32_t>(types_.size()) ? types_[index] : 0;
  if (type >= kMaxTypeStats) {
    return;
  }
  if (static_cast<int32_t>(typeStats_.size()) <= type) {
    typeStats_.resize(type + 1);
  }
  TypeStats& stats = typeStats_[type];
  if (wasMeasured) {
    // Re-measure of an already-counted item: adjust the mean in place
    // without inflating the sample count (LegendList's trick).
    if (stats.num > 0) {
      stats.mean += (newSize - prevSize) / static_cast<float>(stats.num);
    }
  } else {
    stats.mean = (stats.mean * static_cast<float>(stats.num) + newSize) /
                 static_cast<float>(stats.num + 1);
    stats.num++;
  }
}

bool LayoutCore::applyTypeMeansLocked() {
  // While frozen, drift stays pending (appliedMean untouched) — the unfreeze
  // runs this again and catches up in one sweep.
  if (!typeAverages_ || typeStats_.empty() || estimatesFrozen_) {
    return false;
  }
  // Collect the types whose mean drifted since their last sweep; one shared
  // O(N) pass rewrites the unmeasured items of all of them at once.
  bool anyDrifted = false;
  for (TypeStats& stats : typeStats_) {
    if (stats.num > 0 && std::abs(stats.mean - stats.appliedMean) > kTypeMeanSweepThreshold) {
      anyDrifted = true;
    }
  }
  if (!anyDrifted) {
    return false;
  }
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] != 0) {
      continue;
    }
    const uint16_t type = i < static_cast<int32_t>(types_.size()) ? types_[i] : 0;
    if (type >= typeStats_.size() || typeStats_[type].num == 0) {
      continue;
    }
    const TypeStats& stats = typeStats_[type];
    if (std::abs(stats.mean - stats.appliedMean) <= kTypeMeanSweepThreshold) {
      continue;
    }
    const float rounded = roundToOctave(stats.mean);
    if (sizes_[i] != rounded) {
      sizes_[i] = rounded;
      anyChanged = true;
      minDirtyIndex_ = std::min(minDirtyIndex_, i);
    }
  }
  for (TypeStats& stats : typeStats_) {
    if (stats.num > 0) {
      stats.appliedMean = stats.mean;
    }
  }
  return anyChanged;
}

float LayoutCore::estimateForTypeLocked(uint16_t type) const {
  if (typeAverages_ && type < typeStats_.size() &&
      (typeStats_[type].num > 0 || typeStats_[type].seeded)) {
    return roundToOctave(typeStats_[type].mean);
  }
  return estimate_;
}

} // namespace margelo::nitro::nitrolist
