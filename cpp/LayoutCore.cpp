#include "LayoutCore.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace margelo::nitro::nitrolist {

namespace {

constexpr double kBufferAheadRatio = 1.5;
constexpr double kBufferBehindRatio = 0.5;
constexpr double kDirectionalMinVelocity = 300.0;
constexpr double kDirectionalHoldVelocity = 150.0;
constexpr int32_t kRegimeExitSamples = 3;
constexpr double kVelocityStaleMs = 200.0;
constexpr double kVelocityMinSampleMs = 4.0;
constexpr int32_t kRegimeConfirmSamples = 2;

constexpr double kTypeMeanSweepThreshold = 0.5;
constexpr double kTypeMeanSweepRelative = 0.02;

inline double typeMeanSweepBar(double appliedMean) {
  const double relative = std::abs(appliedMean) * kTypeMeanSweepRelative;
  return relative > kTypeMeanSweepThreshold ? relative : kTypeMeanSweepThreshold;
}
constexpr int32_t kMaxTypeStats = 4096;
constexpr int32_t kCapacityFloorItems = 4096;
constexpr uint8_t kMeasuredOnce = 1;
constexpr uint8_t kMeasuredResized = 2;
constexpr uint8_t kMeasuredUnstable = 3;
constexpr int32_t kBlockShift = 7;
constexpr int32_t kBlockSize = 1 << kBlockShift;

inline int32_t blockCountFor(int32_t items) {
  return items <= 0 ? 0 : ((items - 1) >> kBlockShift) + 1;
}

template <typename T>
void truncateCapacity(std::vector<T>& values, size_t keep) {
  std::vector<T>(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(std::min(keep, values.size())))
      .swap(values);
}

double defaultClockMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

}

bool LayoutCore::setItemCount(int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (count == itemCount_ || count < 0) {
    return false;
  }
  int32_t dirtyStart = std::min(itemCount_, count);
  if (columnCount_ > 1 && itemCount_ > 0 && count > 0) {
    const int32_t lastOld = std::min(itemCount_, count) - 1;
    dirtyStart = lastOld < static_cast<int32_t>(rowStart_.size()) ? rowStart_[lastOld] : 0;
  }
  const auto capacity = static_cast<int32_t>(sizes_.size());
  if (count > capacity) {
    sizes_.resize(count, 0.0f);
    offsets_.resize(count, 0.0);
    measured_.resize(count, 0);
    types_.resize(count, 0);
  }
  if (static_cast<int32_t>(spans_.size()) < count) {
    spans_.resize(count, 1);
  }
  if (count > itemCount_) {
    std::fill(spans_.begin() + itemCount_, spans_.begin() + count, 1);
  }
  if (count > itemCount_) {
    std::fill(sizes_.begin() + itemCount_, sizes_.begin() + count, estimate_);
    std::fill(measured_.begin() + itemCount_, measured_.begin() + count, 0);
    std::fill(types_.begin() + itemCount_, types_.begin() + count, 0);
  } else {
    std::fill(sizes_.begin() + count, sizes_.begin() + itemCount_, 0.0f);
    std::fill(measured_.begin() + count, measured_.begin() + itemCount_, 0);
  }
  geometryChanged_ = true;
  const bool shrank = count < itemCount_;
  itemCount_ = count;
  if (shrank) {
    releaseCapacityLocked();
    pruneFrozenLocked();
    rebuildTypeObservationsLocked();
    applyTypeMeansLocked();
  }
  const auto blocks = static_cast<size_t>(blockCountFor(count));
  if (blockBase_.size() < blocks) {
    blockBase_.resize(blocks, 0.0);
    blockSum_.resize(blocks, 0.0);
    blockDirty_.resize(blocks, 0);
  }
  markWideDirtyLocked(dirtyStart);
  hasRangeWindow_ = false;
  return true;
}

void LayoutCore::setDirectionalBuffers(bool enabled) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (directionalBuffers_ == enabled) {
    return;
  }
  directionalBuffers_ = enabled;
  velocity_ = 0.0;
  lastSampleTimeMs_ = -1.0;
  regime_ = 0;
  pendingRegime_ = 0;
  pendingRegimeCount_ = 0;
  slowSamples_ = 0;
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
  return applyTypeMeansLocked();
}

void LayoutCore::resetScrollVelocity() {
  std::lock_guard<std::mutex> guard(mutex_);
  velocity_ = 0.0;
  lastSampleTimeMs_ = -1.0;
  lastSampleOffset_ = 0.0;
  regime_ = 0;
  pendingRegime_ = 0;
  pendingRegimeCount_ = 0;
  slowSamples_ = 0;
}

void LayoutCore::setClockForTesting(ClockFn clock) {
  std::lock_guard<std::mutex> guard(mutex_);
  clock_ = clock;
  velocity_ = 0.0;
  lastSampleTimeMs_ = -1.0;
  regime_ = 0;
  pendingRegime_ = 0;
  pendingRegimeCount_ = 0;
  slowSamples_ = 0;
  hasRangeWindow_ = false;
}

bool LayoutCore::setEstimate(double value) {
  std::lock_guard<std::mutex> guard(mutex_);
  const float rounded = roundToOctave(value);
  if (rounded == estimate_) {
    return false;
  }
  estimate_ = rounded;
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] == 0 && estimateForTypeLocked(types_[i]) == rounded && sizes_[i] != rounded) {
      geometryChanged_ = geometryChanged_ || sizes_[i] != rounded;
      sizes_[i] = rounded;
      anyChanged = true;
      markItemDirtyLocked(i);
    }
  }
  return anyChanged;
}

void LayoutCore::setMeasurementEpsilon(double value) {
  std::lock_guard<std::mutex> guard(mutex_);
  measurementEpsilon_ = std::max(0.0, value);
}

bool LayoutCore::setItemSize(int32_t index, double size) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (index < 0 || index >= itemCount_) {
    return false;
  }
  const float rounded = std::max(0.0f, roundToOctave(size));
  if (measured_[index] != 0 && std::abs(sizes_[index] - rounded) <= measurementEpsilon_) {
    return false;
  }
  recordMeasurementLocked(index, rounded);
  geometryChanged_ = geometryChanged_ || sizes_[index] != rounded;
  sizes_[index] = rounded;
  markItemDirtyLocked(index);
  applyTypeMeansLocked();
  return true;
}

bool LayoutCore::setItemSizes(const double* pairs, int32_t pairCount, double scale) {
  std::lock_guard<std::mutex> guard(mutex_);
  return applyItemSizesLocked(pairs, pairCount, scale);
}

double LayoutCore::setItemSizesAnchored(const double* pairs, int32_t pairCount, double scale,
                                        int32_t anchorIndex) {
  std::lock_guard<std::mutex> guard(mutex_);
  const bool anchorValid = anchorIndex >= 0 && anchorIndex < itemCount_;
  double before = 0.0;
  if (anchorValid) {
    ensureClean();
    before = offsetAtLocked(anchorIndex);
  }
  const bool anyChanged = applyItemSizesLocked(pairs, pairCount, scale);
  if (!anchorValid || !anyChanged) {
    return 0.0;
  }
  ensureClean();
  return offsetAtLocked(anchorIndex) - before;
}

bool LayoutCore::applyItemSizesLocked(const double* pairs, int32_t pairCount, double scale) {
  if (pairs == nullptr || pairCount <= 0) {
    return false;
  }
  bool anyChanged = false;
  for (int32_t i = 0; i < pairCount; i++) {
    const double rawIndex = pairs[i * 2], rawSize = pairs[i * 2 + 1] * scale;
    if (!std::isfinite(rawIndex) || rawIndex < 0 || rawIndex >= itemCount_ ||
        rawIndex != std::floor(rawIndex) || !std::isfinite(rawSize) || rawSize < 0) continue;
    const auto idx = static_cast<int32_t>(rawIndex);
    if (idx < 0 || idx >= itemCount_) {
      continue;
    }
    const float rounded = std::max(0.0f, roundToOctave(pairs[i * 2 + 1] * scale));
    if (measured_[idx] != 0 && std::abs(sizes_[idx] - rounded) <= measurementEpsilon_) {
      continue;
    }
    recordMeasurementLocked(idx, rounded);
    geometryChanged_ = geometryChanged_ || sizes_[idx] != rounded;
    sizes_[idx] = rounded;
    markItemDirtyLocked(idx);
    anyChanged = true;
  }
  if (anyChanged) {
    applyTypeMeansLocked();
  }
  return anyChanged;
}

bool LayoutCore::resetItemSizes() {
  std::lock_guard<std::mutex> guard(mutex_);
  // Keep the previous mean only as an estimate, never as current observations.
  resetTypeObservationsLocked();
  frozen_.clear();
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] != 0) {
      measured_[i] = 0;
      anyChanged = true;
    }
    const float target = estimateForTypeLocked(types_[i]);
    if (sizes_[i] != target) {
      geometryChanged_ = geometryChanged_ || sizes_[i] != target;
      sizes_[i] = target;
      anyChanged = true;
    }
  }
  if (anyChanged) {
    markWideDirtyLocked(0);
    hasRangeWindow_ = false;
  }
  return anyChanged;
}

void LayoutCore::invalidateItemSizesFrom(int32_t start, bool clearPriors, const double* keptPairs,
                                         int32_t keptCount) {
  std::lock_guard<std::mutex> guard(mutex_);
  start = std::clamp(start, 0, itemCount_);
  if (clearPriors) typeStats_.clear();
  std::vector<bool> kept;
  if (!clearPriors && keptPairs != nullptr && keptCount > 0 && start < itemCount_) {
    kept.assign(static_cast<size_t>(itemCount_ - start), false);
    for (int32_t p = 0; p < keptCount; ++p) {
      const double raw = keptPairs[p * 2];
      if (!std::isfinite(raw) || raw < start || raw >= itemCount_ || raw != std::floor(raw)) continue;
      kept[static_cast<size_t>(raw) - start] = true;
    }
  }
  bool removedObservation = false;
  for (int32_t i = start; i < itemCount_; ++i) {
    if (!kept.empty() && kept[i - start] && measured_[i] != 0) continue;
    removedObservation = removedObservation || measured_[i] != 0;
    measured_[i] = 0;
    geometryChanged_ = geometryChanged_ || sizes_[i] != estimateForTypeLocked(types_[i]);
    sizes_[i] = estimateForTypeLocked(types_[i]);
  }
  pruneFrozenLocked();
  if (removedObservation || clearPriors) rebuildTypeObservationsLocked();
  markWideDirtyLocked(start);
  hasRangeWindow_ = false;
}

bool LayoutCore::remapItemSizes(const double* pairs, int32_t pairCount) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (pairs == nullptr || pairCount <= 0 || itemCount_ == 0) {
    return false;
  }
  const auto sourceLimit = static_cast<int32_t>(sizes_.size());
  // JS has already validated keys/content. Specialize only a complete run of
  // index pairs; no assumptions about index-dependent user callbacks are needed.
  int32_t oldStart = 0, newStart = 0;
  bool contiguous = pairCount <= sourceLimit && pairCount <= itemCount_ &&
      pairs[0] >= 0.0 && pairs[0] <= sourceLimit - pairCount &&
      pairs[1] >= 0.0 && pairs[1] <= itemCount_ - pairCount &&
      pairs[0] == std::floor(pairs[0]) && pairs[1] == std::floor(pairs[1]);
  if (contiguous) {
    oldStart = static_cast<int32_t>(pairs[0]);
    newStart = static_cast<int32_t>(pairs[1]);
    for (int32_t p = 0; p < pairCount; ++p) {
      if (pairs[p * 2] != oldStart + p || pairs[p * 2 + 1] != newStart + p) {
        contiguous = false;
        break;
      }
    }
  }
  bool anyChanged = false;
  const auto assign = [&](int32_t i, float size, uint8_t measured) {
    if (measured_[i] != measured) {
      measured_[i] = measured;
      anyChanged = true;
    }
    if (sizes_[i] != size) {
      geometryChanged_ = true;
      sizes_[i] = size;
      anyChanged = true;
      markItemDirtyLocked(i);
    }
  };
  if (contiguous) {
    const auto move = [&](int32_t i) {
      const bool mapped = i >= newStart && i - newStart < pairCount;
      const int32_t source = mapped ? oldStart + (i - newStart) : 0;
      const uint8_t measured = mapped ? measured_[source] : 0;
      assign(i, measured != 0 ? sizes_[source] : estimateForTypeLocked(types_[i]), measured);
    };
    // Traverse in the direction that reads overlapping sources before overwriting
    // them, including when resetting destinations outside the surviving run.
    if (newStart > oldStart) {
      for (int32_t i = itemCount_; i-- > 0;) move(i);
    } else {
      for (int32_t i = 0; i < itemCount_; ++i) move(i);
    }
  } else {
    if (static_cast<int32_t>(remapSizes_.size()) < itemCount_) remapSizes_.resize(itemCount_);
    remapMeasured_.assign(static_cast<size_t>(itemCount_), 0);
    auto& newSizes = remapSizes_;
    auto& newMeasured = remapMeasured_;
    for (int32_t i = 0; i < itemCount_; i++) {
      newSizes[i] = estimateForTypeLocked(types_[i]);
    }
    for (int32_t p = 0; p < pairCount; p++) {
      const double oldRaw = pairs[p * 2];
      const double newRaw = pairs[p * 2 + 1];
      if (!(oldRaw >= 0.0) || !(newRaw >= 0.0) || oldRaw > 2000000000.0 || newRaw > 2000000000.0) {
        continue;
      }
      const auto oldIdx = static_cast<int32_t>(oldRaw);
      const auto newIdx = static_cast<int32_t>(newRaw);
      if (oldIdx >= sourceLimit || newIdx >= itemCount_ || measured_[oldIdx] == 0) {
        continue;
      }
      newSizes[newIdx] = sizes_[oldIdx];
      newMeasured[newIdx] = measured_[oldIdx];
    }
    for (int32_t i = 0; i < itemCount_; i++) {
      assign(i, newSizes[i], newMeasured[i]);
    }
  }
  if (anyChanged) {
    hasRangeWindow_ = false;
  }
  remapFrozenLocked(pairs, pairCount);
  pruneFrozenLocked();
  rebuildTypeObservationsLocked();
  return applyTypeMeansLocked() || anyChanged;
}

void LayoutCore::releaseCapacityLocked() {
  const auto capacity = static_cast<int32_t>(sizes_.size());
  if (capacity <= kCapacityFloorItems || itemCount_ >= capacity / 4) return;
  const auto keep = static_cast<size_t>(itemCount_);
  truncateCapacity(sizes_, keep);
  truncateCapacity(offsets_, keep);
  truncateCapacity(measured_, keep);
  truncateCapacity(types_, keep);
  truncateCapacity(spans_, keep);
  truncateCapacity(rowStart_, keep);
  const auto blocks = static_cast<size_t>(blockCountFor(itemCount_));
  truncateCapacity(blockBase_, blocks);
  truncateCapacity(blockSum_, blocks);
  truncateCapacity(blockDirty_, blocks);
  std::vector<float>().swap(remapSizes_);
  std::vector<uint8_t>().swap(remapMeasured_);
}

void LayoutCore::resetAll() {
  std::lock_guard<std::mutex> guard(mutex_);
  std::vector<float>().swap(remapSizes_);
  std::vector<uint8_t>().swap(remapMeasured_);
  std::vector<float>().swap(sizes_);
  std::vector<double>().swap(offsets_);
  std::vector<uint8_t>().swap(measured_);
  std::vector<uint16_t>().swap(types_);
  std::vector<uint16_t>().swap(spans_);
  std::vector<int32_t>().swap(rowStart_);
  std::vector<TypeStats>().swap(typeStats_);
  columnCount_ = 1;
  itemCount_ = 0;
  estimate_ = 0.0f;
  totalSize_ = 0.0;
  estimatesFrozen_ = false;
  minDirtyIndex_ = INT32_MAX;
  wideDirtyIndex_ = INT32_MAX;
  std::vector<double>().swap(blockBase_);
  std::vector<double>().swap(blockSum_);
  std::vector<uint8_t>().swap(blockDirty_);
  std::vector<int32_t>().swap(dirtyBlocks_);
  layoutVersion_ = 0;
  geometryChanged_ = false;
  hasRangeWindow_ = false;
  rangeWindowMin_ = 0.0;
  rangeWindowMax_ = 0.0;
  rangeWindowViewport_ = -1.0;
  rangeWindowDraw_ = -1.0;
  cachedStart_ = 0;
  cachedEnd_ = -1;
  cachedVersion_ = -1;
  cachedRegime_ = 0;
  lastSampleTimeMs_ = -1.0;
  lastSampleOffset_ = 0.0;
  velocity_ = 0.0;
  regime_ = 0;
  pendingRegime_ = 0;
  pendingRegimeCount_ = 0;
  slowSamples_ = 0;
}

size_t LayoutCore::getMemoryFootprint() {
  std::lock_guard<std::mutex> guard(mutex_);
  return sizes_.capacity() * sizeof(float) + offsets_.capacity() * sizeof(double) +
         measured_.capacity() * sizeof(uint8_t) + types_.capacity() * sizeof(uint16_t) +
         spans_.capacity() * sizeof(uint16_t) + rowStart_.capacity() * sizeof(int32_t) +
         typeStats_.capacity() * sizeof(TypeStats) + remapSizes_.capacity() * sizeof(float) +
         remapMeasured_.capacity() * sizeof(uint8_t) + blockBase_.capacity() * sizeof(double) +
         blockSum_.capacity() * sizeof(double) + blockDirty_.capacity() * sizeof(uint8_t) +
         dirtyBlocks_.capacity() * sizeof(int32_t);
}

bool LayoutCore::setItemTypes(const uint16_t* types, int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  return assignTypesLocked(0, types, count, true);
}

bool LayoutCore::setItemTypesRange(int32_t start, const uint16_t* types, int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (start < 0 || start >= itemCount_) {
    return true;
  }
  return assignTypesLocked(start, types, std::min(count, itemCount_ - start), false);
}

bool LayoutCore::assignTypesLocked(int32_t start, const uint16_t* types, int32_t count, bool replaceAll) {
  if (static_cast<int32_t>(types_.size()) < itemCount_) {
    types_.resize(itemCount_, 0);
  }
  const int32_t end = replaceAll ? itemCount_ : start + std::min(itemCount_ - start, std::max(0, count));
  bool allTracked = true;
  bool measuredTypeChanged = false;
  for (int32_t i = start; i < end; i++) {
    const int32_t k = i - start;
    const uint16_t type = (types != nullptr && k < count) ? types[k] : 0;
    if (type >= kMaxTypeStats) {
      allTracked = false;
    }
    measuredTypeChanged = measuredTypeChanged || (types_[i] != type && measured_[i] != 0);
    types_[i] = type;
  }
  if (measuredTypeChanged) rebuildTypeObservationsLocked();
  for (int32_t i = start; i < end; i++) {
    if (measured_[i] != 0) {
      continue;
    }
    const float target = estimateForTypeLocked(types_[i]);
    if (sizes_[i] != target) {
      geometryChanged_ = geometryChanged_ || sizes_[i] != target;
      sizes_[i] = target;
      markItemDirtyLocked(i);
    }
  }
  if (measuredTypeChanged) applyTypeMeansLocked();
  return allTracked;
}

int32_t LayoutCore::countUnmeasured(int32_t from, int32_t to) {
  std::lock_guard<std::mutex> guard(mutex_);
  const int32_t lo = std::max(0, from);
  const int32_t hi = std::min(itemCount_, to);
  int32_t unmeasured = 0;
  for (int32_t i = lo; i < hi; i++) {
    if (measured_[i] == 0) {
      unmeasured++;
    }
  }
  return unmeasured;
}

bool LayoutCore::seedTypeMeans(const double* pairs, int32_t pairCount, double scale) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (!typeAverages_ || pairs == nullptr || pairCount <= 0) {
    return false;
  }
  bool anySeeded = false;
  for (int32_t p = 0; p < pairCount; p++) {
    const auto type = static_cast<int32_t>(pairs[2 * p]);
    const float mean = roundToOctave(pairs[2 * p + 1] * scale);
    if (type <= 0 || type >= kMaxTypeStats || !(mean > 0.0f)) {
      continue;
    }
    if (static_cast<int32_t>(typeStats_.size()) <= type) {
      typeStats_.resize(type + 1);
    }
    TypeStats& stats = typeStats_[type];
    if (stats.num > 0) {
      continue;
    }
    stats.mean = mean;
    stats.appliedMean = mean;
    stats.seeded = true;
    anySeeded = true;
  }
  if (!anySeeded) {
    return false;
  }
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] != 0) {
      continue;
    }
    const float target = estimateForTypeLocked(types_[i]);
    if (sizes_[i] != target) {
      geometryChanged_ = geometryChanged_ || sizes_[i] != target;
      sizes_[i] = target;
      anyChanged = true;
      markItemDirtyLocked(i);
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
  if (enabled) rebuildTypeObservationsLocked();
}

int32_t LayoutCore::fillTypeStats(double* out, int32_t capacityDoubles, double outputScale) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (out == nullptr) {
    return -1;
  }
  int32_t count = 0;
  for (const TypeStats& stats : typeStats_) {
    if (stats.num > 0) {
      count++;
    }
  }
  if (capacityDoubles < count * 3) {
    return -1;
  }
  double* cursor = out;
  for (size_t type = 0; type < typeStats_.size(); type++) {
    const TypeStats& stats = typeStats_[type];
    if (stats.num == 0) {
      continue;
    }
    *cursor++ = static_cast<double>(type);
    *cursor++ = stats.mean * outputScale;
    *cursor++ = static_cast<double>(stats.num);
  }
  return count;
}

double LayoutCore::getTotalSize() {
  std::lock_guard<std::mutex> guard(mutex_);
  ensureClean();
  return totalSize_;
}

double LayoutCore::getOffset(int32_t index) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (index < 0 || index >= itemCount_) {
    return 0.0;
  }
  ensureClean();
  return offsetAtLocked(index);
}

double LayoutCore::getSize(int32_t index) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (index < 0 || index >= itemCount_) {
    return 0.0;
  }
  return sizes_[index];
}

int32_t LayoutCore::getLayoutVersion() {
  std::lock_guard<std::mutex> guard(mutex_);
  ensureClean();
  return layoutVersion_;
}

int32_t LayoutCore::readLayout(int32_t start, int32_t count, double* out, int32_t capacityDoubles) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (out == nullptr || capacityDoubles < 4) {
    return -1;
  }
  ensureClean();
  const bool inside = start >= 0 && start < itemCount_;
  const int32_t first = inside ? start : 0;
  const int32_t available = inside ? std::min(std::max(0, count), itemCount_ - first) : 0;
  out[0] = layoutVersion_;
  out[1] = totalSize_;
  out[2] = first;
  out[3] = available;
  if (capacityDoubles < 4 + static_cast<int64_t>(available) * 2) {
    return -1;
  }
  double* cursor = out + 4;
  for (int32_t i = first; i < first + available; i++) {
    *cursor++ = offsetAtLocked(i);
    *cursor++ = static_cast<double>(sizes_[i]);
  }
  return available;
}

LayoutCore::EngagedRange LayoutCore::getEngagedRange(double scrollOffset,
                                                     double viewportHeight,
                                                     double drawDistance) {
  std::lock_guard<std::mutex> guard(mutex_);
  return computeEngagedRangeLocked(scrollOffset, viewportHeight, drawDistance);
}

int32_t LayoutCore::fillLayoutSlab(double* out, int32_t capacityDoubles, double scrollOffset,
                                   double viewportHeight, double drawDistance,
                                   double outputScale) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (out == nullptr || capacityDoubles < 4) {
    return -1;
  }
  const EngagedRange range = computeEngagedRangeLocked(scrollOffset, viewportHeight, drawDistance);
  const int32_t count = range.end >= range.start ? range.end - range.start + 1 : 0;
  if (capacityDoubles < 4 + count * 2) {
    return -1;
  }
  out[0] = range.version;
  out[1] = totalSize_ * outputScale;
  out[2] = range.start;
  out[3] = range.end;
  double* cursor = out + 4;
  for (int32_t i = range.start; i < range.start + count; i++) {
    *cursor++ = offsetAtLocked(i) * outputScale;
    *cursor++ = static_cast<double>(sizes_[i]) * outputScale;
  }
  return count;
}

LayoutCore::EngagedRange LayoutCore::computeEngagedRangeLocked(double scrollOffset,
                                                               double viewportHeight,
                                                               double drawDistance) {
  if (directionalBuffers_ && scrollOffset != lastSampleOffset_) {
    const double now = clock_ != nullptr ? clock_() : defaultClockMs();
    bool advanceBaseline = true;
    bool sampled = false;
    bool stale = false;
    if (lastSampleTimeMs_ >= 0.0) {
      const double dt = now - lastSampleTimeMs_;
      if (dt > kVelocityStaleMs) {
        velocity_ = 0.0;
        sampled = true;
        stale = true;
      } else if (dt >= kVelocityMinSampleMs) {
        velocity_ = (scrollOffset - lastSampleOffset_) / dt * 1000.0;
        sampled = true;
      } else {
        advanceBaseline = false;
      }
    }
    if (advanceBaseline) {
      lastSampleTimeMs_ = now;
      lastSampleOffset_ = scrollOffset;
    }
    if (sampled) {
      int32_t candidate = 0;
      if (std::abs(velocity_) >= kDirectionalMinVelocity) {
        candidate = velocity_ > 0.0 ? 1 : -1;
      } else if (regime_ != 0 && velocity_ * regime_ >= kDirectionalHoldVelocity) {
        candidate = regime_;
      }
      const bool slowInRegime =
          candidate == 0 && regime_ != 0 && !stale && velocity_ * regime_ >= 0.0;
      slowSamples_ = slowInRegime ? slowSamples_ + 1 : 0;
      if (candidate == regime_) {
        pendingRegime_ = 0;
        pendingRegimeCount_ = 0;
      } else if (slowInRegime && slowSamples_ < kRegimeExitSamples) {
        pendingRegime_ = 0;
        pendingRegimeCount_ = 0;
      } else if (candidate == 0 || regime_ != 0) {
        regime_ = 0;
        pendingRegime_ = candidate;
        pendingRegimeCount_ = candidate == 0 ? 0 : 1;
      } else if (candidate == pendingRegime_) {
        if (++pendingRegimeCount_ >= kRegimeConfirmSamples) {
          regime_ = candidate;
          pendingRegime_ = 0;
          pendingRegimeCount_ = 0;
        }
      } else {
        pendingRegime_ = candidate;
        pendingRegimeCount_ = 1;
      }
    }
  }
  const int32_t regime = directionalBuffers_ ? regime_ : 0;
  double topBuffer = regime == 0    ? drawDistance
                     : regime > 0   ? drawDistance * kBufferBehindRatio
                                    : drawDistance * kBufferAheadRatio;
  double bottomBuffer = regime == 0  ? drawDistance
                        : regime > 0 ? drawDistance * kBufferAheadRatio
                                     : drawDistance * kBufferBehindRatio;
  ensureClean();
  const bool inside = scrollOffset < totalSize_;
  const double unusedTop = inside ? std::max(0.0, topBuffer - scrollOffset) : 0.0;
  const double unusedBottom =
      inside ? std::max(0.0, scrollOffset + viewportHeight + bottomBuffer - totalSize_) : 0.0;
  const bool atEdge = unusedTop > 0.0 || unusedBottom > 0.0;
  topBuffer += unusedBottom;
  bottomBuffer += unusedTop;
  if (!atEdge && hasRangeWindow_ && minDirtyIndex_ == INT32_MAX && cachedVersion_ == layoutVersion_ &&
      viewportHeight == rangeWindowViewport_ && drawDistance == rangeWindowDraw_ &&
      regime == cachedRegime_ && scrollOffset > rangeWindowMin_ &&
      scrollOffset < rangeWindowMax_) {
    return EngagedRange{cachedStart_, cachedEnd_, cachedVersion_};
  }
  ensureClean();
  if (itemCount_ == 0 || viewportHeight <= 0.0) {
    hasRangeWindow_ = false;
    return EngagedRange{0, -1, layoutVersion_};
  }
  const double top = std::max(0.0, scrollOffset - topBuffer);
  const double bottom = std::min(totalSize_, scrollOffset + viewportHeight + bottomBuffer);
  if (totalSize_ <= top) {
    hasRangeWindow_ = false;
    const int32_t lastStart =
        columnCount_ > 1 && !rowStart_.empty() ? rowStart_[itemCount_ - 1] : itemCount_ - 1;
    return EngagedRange{lastStart, itemCount_ - 1, layoutVersion_};
  }
  auto start = lastIndexAtOrBelowLocked(top);
  int32_t end = lastIndexBelowLocked(bottom, start);
  end = std::clamp(end, start, itemCount_ - 1);
  if (columnCount_ > 1) {
    start = rowStart_[start];
    const int32_t endRow = rowStart_[end];
    while (end + 1 < itemCount_ && rowStart_[end + 1] == endRow) {
      end++;
    }
    hasRangeWindow_ = false;
    return EngagedRange{start, end, layoutVersion_};
  }
  double lower = offsetAtLocked(end) - viewportHeight - bottomBuffer;
  if (start > 0) {
    lower = std::max(lower, offsetAtLocked(start - 1) + sizes_[start - 1] + topBuffer);
  }
  double upper = offsetAtLocked(start) + sizes_[start] + topBuffer;
  if (end < itemCount_ - 1) {
    upper = std::min(upper, offsetAtLocked(end + 1) - viewportHeight - bottomBuffer);
  }
  cachedStart_ = start;
  cachedEnd_ = end;
  cachedVersion_ = layoutVersion_;
  cachedRegime_ = regime;
  rangeWindowMin_ = lower;
  rangeWindowMax_ = upper;
  rangeWindowViewport_ = viewportHeight;
  rangeWindowDraw_ = drawDistance;
  hasRangeWindow_ = !atEdge && upper > lower;
  return EngagedRange{start, end, layoutVersion_};
}

void LayoutCore::setColumnCount(int32_t columns) {
  std::lock_guard<std::mutex> guard(mutex_);
  const int32_t clamped = std::max(1, columns);
  if (clamped == columnCount_) {
    return;
  }
  columnCount_ = clamped;
  typeStats_.clear();
  frozen_.clear();
  for (int32_t i = 0; i < itemCount_; i++) {
    measured_[i] = 0;
    geometryChanged_ = geometryChanged_ || sizes_[i] != estimate_;
    sizes_[i] = estimate_;
  }
  markWideDirtyLocked(0);
  hasRangeWindow_ = false;
}

bool LayoutCore::setItemSpans(const uint16_t* spans, int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (static_cast<int32_t>(spans_.size()) < itemCount_) {
    spans_.resize(itemCount_, 1);
  }
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
    const uint16_t raw = (spans != nullptr && i < count) ? spans[i] : 1;
    const uint16_t next = raw < 1 ? 1 : raw;
    if (spans_[i] != next) {
      spans_[i] = next;
      anyChanged = true;
      markWideDirtyLocked(std::max(0, i - 1));
    }
  }
  if (anyChanged) {
    hasRangeWindow_ = false;
  }
  return anyChanged;
}

bool LayoutCore::setItemSpansRange(int32_t start, const uint16_t* spans, int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (spans == nullptr || start < 0 || start >= itemCount_ || count <= 0) return false;
  const int32_t end = start + std::min(count, itemCount_ - start);
  bool changed = false;
  for (int32_t i = start; i < end; ++i) {
    const uint16_t next = std::max<uint16_t>(1, spans[i - start]);
    if (spans_[i] == next) continue;
    spans_[i] = next;
    markWideDirtyLocked(std::max(0, i - 1));
    changed = true;
  }
  if (changed) hasRangeWindow_ = false;
  return changed;
}

int32_t LayoutCore::spanAtLocked(int32_t index) const {
  if (index >= static_cast<int32_t>(spans_.size())) {
    return 1;
  }
  const int32_t span = spans_[index] < 1 ? 1 : spans_[index];
  return std::min(span, columnCount_);
}

void LayoutCore::markItemDirtyLocked(int32_t index) {
  minDirtyIndex_ = std::min(minDirtyIndex_, index);
  if (columnCount_ > 1 || index < 0) return;
  const int32_t block = index >> kBlockShift;
  if (block >= static_cast<int32_t>(blockDirty_.size()) || blockDirty_[block] != 0) return;
  blockDirty_[block] = 1;
  dirtyBlocks_.push_back(block);
}

void LayoutCore::markWideDirtyLocked(int32_t index) {
  minDirtyIndex_ = std::min(minDirtyIndex_, index);
  wideDirtyIndex_ = std::min(wideDirtyIndex_, index);
}

void LayoutCore::rebuildBlockLocked(int32_t block, bool& anyChanged) {
  const int32_t first = block << kBlockShift;
  const int32_t last = std::min(itemCount_, first + kBlockSize);
  double local = 0.0;
  for (int32_t i = first; i < last; i++) {
    if (offsets_[i] != local) {
      offsets_[i] = local;
      anyChanged = true;
    }
    local += sizes_[i];
  }
  blockSum_[block] = local;
}

void LayoutCore::ensureCleanBlocksLocked(bool& anyChanged) {
  const int32_t blocks = blockCountFor(itemCount_);
  int32_t rebase = INT32_MAX;
  int32_t wideFrom = INT32_MAX;
  if (wideDirtyIndex_ != INT32_MAX) {
    wideFrom = std::min(wideDirtyIndex_, std::max(0, itemCount_ - 1)) >> kBlockShift;
    for (int32_t block = wideFrom; block < blocks; block++) rebuildBlockLocked(block, anyChanged);
    rebase = wideFrom;
  }
  for (const int32_t block : dirtyBlocks_) {
    if (block >= static_cast<int32_t>(blockDirty_.size())) continue;
    blockDirty_[block] = 0;
    if (block >= blocks || block >= wideFrom) continue;
    rebuildBlockLocked(block, anyChanged);
    rebase = std::min(rebase, block);
  }
  dirtyBlocks_.clear();
  if (rebase == INT32_MAX) rebase = blocks;
  double base = rebase == 0 || blocks == 0 ? 0.0 : blockBase_[rebase - 1] + blockSum_[rebase - 1];
  for (int32_t block = rebase; block < blocks; block++) {
    if (blockBase_[block] != base) {
      blockBase_[block] = base;
      anyChanged = true;
    }
    base += blockSum_[block];
  }
  const double total = blocks == 0 ? 0.0 : blockBase_[blocks - 1] + blockSum_[blocks - 1];
  if (totalSize_ != total) {
    totalSize_ = total;
    anyChanged = true;
  }
}

double LayoutCore::offsetAtLocked(int32_t index) const {
  if (columnCount_ > 1) return offsets_[index];
  return blockBase_[index >> kBlockShift] + offsets_[index];
}

int32_t LayoutCore::lastIndexAtOrBelowLocked(double value) const {
  if (itemCount_ <= 0) return 0;
  if (columnCount_ > 1) {
    const auto it = std::upper_bound(offsets_.begin() + 1, offsets_.begin() + itemCount_, value);
    return static_cast<int32_t>(it - offsets_.begin()) - 1;
  }
  const int32_t blocks = blockCountFor(itemCount_);
  const auto blockIt = std::upper_bound(blockBase_.begin() + 1, blockBase_.begin() + blocks, value);
  const int32_t block = static_cast<int32_t>(blockIt - blockBase_.begin()) - 1;
  const int32_t first = block << kBlockShift;
  const int32_t last = std::min(itemCount_, first + kBlockSize);
  const auto it = std::upper_bound(offsets_.begin() + first + 1, offsets_.begin() + last, value - blockBase_[block]);
  return static_cast<int32_t>(it - offsets_.begin()) - 1;
}

int32_t LayoutCore::lastIndexBelowLocked(double value, int32_t from) const {
  if (columnCount_ > 1) {
    const auto it = std::lower_bound(offsets_.begin() + from, offsets_.begin() + itemCount_, value);
    return static_cast<int32_t>(it - offsets_.begin()) - 1;
  }
  const int32_t blocks = blockCountFor(itemCount_);
  const int32_t fromBlock = from >> kBlockShift;
  const auto blockIt = std::lower_bound(blockBase_.begin() + fromBlock, blockBase_.begin() + blocks, value);
  int32_t block = static_cast<int32_t>(blockIt - blockBase_.begin()) - 1;
  if (block < fromBlock) return from - 1;
  const int32_t first = std::max(from, block << kBlockShift);
  const int32_t last = std::min(itemCount_, (block << kBlockShift) + kBlockSize);
  const auto it = std::lower_bound(offsets_.begin() + first, offsets_.begin() + last, value - blockBase_[block]);
  return static_cast<int32_t>(it - offsets_.begin()) - 1;
}

void LayoutCore::ensureClean() {
  if (minDirtyIndex_ == INT32_MAX) {
    return;
  }
  bool anyChanged = geometryChanged_;
  geometryChanged_ = false;
  if (columnCount_ <= 1) {
    ensureCleanBlocksLocked(anyChanged);
  } else {
    if (static_cast<int32_t>(rowStart_.size()) < itemCount_) {
      rowStart_.resize(itemCount_, 0);
    }
    int32_t start = itemCount_ > 0 ? std::min(minDirtyIndex_, itemCount_ - 1) : 0;
    if (start > 0) {
      start = rowStart_[start];
    }
    double off = 0.0;
    if (start > 0) {
      const int32_t prevRow = rowStart_[start - 1];
      double prevRowMax = 0.0;
      for (int32_t j = prevRow; j < start; j++) {
        prevRowMax = std::max(prevRowMax, static_cast<double>(sizes_[j]));
      }
      off = offsets_[prevRow] + prevRowMax;
    }
    int32_t i = start;
    while (i < itemCount_) {
      const int32_t rowBegin = i;
      int32_t used = 0;
      double rowMax = 0.0;
      while (i < itemCount_) {
        const int32_t span = spanAtLocked(i);
        if (used > 0 && used + span > columnCount_) {
          break;
        }
        if (offsets_[i] != off) {
          offsets_[i] = off;
          anyChanged = true;
        }
        rowStart_[i] = rowBegin;
        rowMax = std::max(rowMax, static_cast<double>(sizes_[i]));
        used += span;
        i++;
        if (used >= columnCount_) {
          break;
        }
      }
      off += rowMax;
    }
    if (totalSize_ != off) {
      totalSize_ = off;
      anyChanged = true;
    }
  }
  minDirtyIndex_ = INT32_MAX;
  wideDirtyIndex_ = INT32_MAX;
  for (const int32_t block : dirtyBlocks_) {
    if (block < static_cast<int32_t>(blockDirty_.size())) blockDirty_[block] = 0;
  }
  dirtyBlocks_.clear();
  if (anyChanged) {
    layoutVersion_++;
  }
}

void LayoutCore::recordMeasurementLocked(int32_t index, float size) {
  const uint8_t state = measured_[index];
  if (state == kMeasuredUnstable) {
    return;
  }
  if (state == kMeasuredResized && size > 0.0f && sizes_[index] > 0.0f) {
    if (typeAverages_) frozen_[index] = sizes_[index];
    measured_[index] = kMeasuredUnstable;
    return;
  }
  updateTypeMeanLocked(index, state != 0, sizes_[index], size);
  measured_[index] = state == 0 ? kMeasuredOnce : kMeasuredResized;
}

void LayoutCore::pruneFrozenLocked() {
  for (auto it = frozen_.begin(); it != frozen_.end();) {
    if (it->first >= itemCount_ || measured_[it->first] != kMeasuredUnstable) {
      it = frozen_.erase(it);
    } else {
      ++it;
    }
  }
}

void LayoutCore::remapFrozenLocked(const double* pairs, int32_t pairCount) {
  if (frozen_.empty()) return;
  std::unordered_map<int32_t, float> moved;
  for (int32_t p = 0; p < pairCount; ++p) {
    const double oldRaw = pairs[p * 2];
    const double newRaw = pairs[p * 2 + 1];
    if (!(oldRaw >= 0.0) || !(newRaw >= 0.0) || oldRaw > 2000000000.0 || newRaw > 2000000000.0) continue;
    const auto found = frozen_.find(static_cast<int32_t>(oldRaw));
    if (found != frozen_.end()) moved[static_cast<int32_t>(newRaw)] = found->second;
  }
  frozen_.swap(moved);
}

float LayoutCore::roundToOctave(double value) {
  return static_cast<float>(std::round(value * 8.0) / 8.0);
}

void LayoutCore::updateTypeMeanLocked(int32_t index, bool wasMeasured, float prevSize,
                                      float newSize) {
  if (!typeAverages_) {
    return;
  }
  const uint16_t type = index < static_cast<int32_t>(types_.size()) ? types_[index] : 0;
  if (type >= kMaxTypeStats) {
    return;
  }
  if (static_cast<int32_t>(typeStats_.size()) <= type) {
    typeStats_.resize(type + 1);
  }
  TypeStats& stats = typeStats_[type];
  if (wasMeasured && prevSize > 0.0f) {
    if (newSize <= 0.0f) {
      if (stats.num > 1) {
        stats.mean = (stats.mean * stats.num - prevSize) / (stats.num - 1);
      }
      if (stats.num > 0) stats.num--;
      // A last observation may remain a prior, but is not a measured item.
      if (stats.num == 0) stats.seeded = stats.mean > 0.0;
    } else if (stats.num > 0) {
      stats.mean += (static_cast<double>(newSize) - static_cast<double>(prevSize)) /
                    static_cast<double>(stats.num);
    }
  } else if (newSize > 0.0f) {
    stats.mean = (stats.mean * static_cast<double>(stats.num) + static_cast<double>(newSize)) /
                 static_cast<double>(stats.num + 1);
    stats.num++;
  }
}

void LayoutCore::resetTypeObservationsLocked(bool resetApplied) {
  for (TypeStats& stats : typeStats_) {
    stats.seeded = stats.mean > 0.0;
    stats.num = 0;
    if (resetApplied) stats.appliedMean = stats.mean;
  }
}

void LayoutCore::rebuildTypeObservationsLocked() {
  if (!typeAverages_) return;
  resetTypeObservationsLocked(false);
  for (int32_t i = 0; i < itemCount_; i++) {
    if (measured_[i] == 0) continue;
    if (measured_[i] != kMeasuredUnstable) {
      updateTypeMeanLocked(i, false, 0.0f, sizes_[i]);
      continue;
    }
    const auto frozen = frozen_.find(i);
    if (frozen != frozen_.end()) updateTypeMeanLocked(i, false, 0.0f, frozen->second);
  }
}

bool LayoutCore::applyTypeMeansLocked() {
  if (!typeAverages_ || typeStats_.empty() || estimatesFrozen_) {
    return false;
  }
  bool anyDrifted = false;
  for (TypeStats& stats : typeStats_) {
    if (stats.num > 0 &&
        std::abs(stats.mean - stats.appliedMean) > typeMeanSweepBar(stats.appliedMean)) {
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
    if (std::abs(stats.mean - stats.appliedMean) <= typeMeanSweepBar(stats.appliedMean)) {
      continue;
    }
    const float rounded = roundToOctave(stats.mean);
    if (sizes_[i] != rounded) {
      geometryChanged_ = geometryChanged_ || sizes_[i] != rounded;
      sizes_[i] = rounded;
      anyChanged = true;
      markItemDirtyLocked(i);
    }
  }
  for (TypeStats& stats : typeStats_) {
    if (stats.num > 0 &&
        std::abs(stats.mean - stats.appliedMean) > typeMeanSweepBar(stats.appliedMean)) {
      stats.appliedMean = stats.mean;
    }
  }
  return anyChanged;
}

float LayoutCore::estimateForTypeLocked(uint16_t type) const {
  if (typeAverages_ && type < typeStats_.size() &&
      (typeStats_[type].num > 0 || typeStats_[type].seeded)) {
    // Data transactions must use the same estimate already published to layout.
    // The observed mean may have drifted below the sweep threshold; applying it
    // during remap/type assignment would move every unmeasured item at once.
    const double published = typeStats_[type].appliedMean;
    return published > 0.0 ? roundToOctave(published) : estimate_;
  }
  return estimate_;
}

}
